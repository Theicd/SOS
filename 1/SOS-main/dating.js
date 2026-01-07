(function initDatingPage(window) {
  // חלק הכרויות (dating.js) – אתחול בסיסי, מבנים וטבלת השמות
  const App = window.NostrApp || (window.NostrApp = {});
  const tools = window.NostrTools || {};
  const DATE_LIKE_KIND = 40001;
  const STORAGE_PREFIX = 'nostr_dating_state_';
  const state = {
    queue: [],
    index: 0,
    current: null,
    likesOut: new Set(),
    likesIn: new Set(),
    matches: new Set(),
    localKey: null,
    viewerGender: '',
  };
  const refs = {
    card: document.getElementById('datingCard'),
    image: document.getElementById('datingCardImage'),
    name: document.getElementById('datingCardName'),
    bio: document.getElementById('datingCardBio'),
    meta: document.getElementById('datingCardMeta'),
    tags: document.getElementById('datingCardTags'),
    empty: document.getElementById('datingEmpty'),
    toast: document.getElementById('datingToast'),
    toastText: document.getElementById('datingToastText'),
    likeButton: document.getElementById('datingLikeButton'),
    passButton: document.getElementById('datingPassButton'),
    refreshButton: document.getElementById('datingRefreshButton'),
    backButton: document.getElementById('datingBackButton'),
    placeholder: document.getElementById('datingCardPlaceholder'),
    introOverlay: document.getElementById('datingIntroOverlay'),
    introStart: document.getElementById('datingIntroStartButton'),
  };
  const showPlaceholder = () => {
    if (refs.placeholder) {
      refs.placeholder.hidden = false;
    }
    if (refs.image) {
      refs.image.classList.add('is-loading');
    }
  };
  const hidePlaceholder = () => {
    if (refs.placeholder) {
      refs.placeholder.hidden = true;
    }
    if (refs.image) {
      refs.image.classList.remove('is-loading');
    }
  };
  const closeIntroOverlay = () => {
    if (refs.introOverlay) {
      refs.introOverlay.hidden = true;
    }
  };
  refs.image?.addEventListener('load', () => {
    if (!refs.image) {
      return;
    }
    hidePlaceholder();
  });
  refs.image?.addEventListener('error', () => {
    showPlaceholder();
  });

  // חלק הכרויות (dating.js) – פונקציות עזר כללי למפתחות, אחסון וטוסט
  const normalizePubkey = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
  const escapeHtml = (value) => {
    const safe = String(value ?? '');
    if (typeof App.escapeHtml === 'function') {
      return App.escapeHtml(safe);
    }
    return safe.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  };
  const normalizeGender = (value) => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return normalized === 'male' || normalized === 'female' ? normalized : '';
  };
  const showToast = (message) => {
    if (!refs.toast || !refs.toastText) {
      return;
    }
    refs.toastText.textContent = message;
    refs.toast.classList.add('is-visible');
    window.setTimeout(() => refs.toast.classList.remove('is-visible'), 4200);
  };
  const persistLocalState = () => {
    if (!state.localKey) {
      return;
    }
    try {
      window.localStorage.setItem(
        state.localKey,
        JSON.stringify({
          likes: Array.from(state.likesOut),
          matches: Array.from(state.matches),
        }),
      );
    } catch (err) {
      console.warn('Dating: failed to persist local state', err);
    }
  };
  const restoreLocalState = () => {
    if (!state.localKey) {
      return;
    }
    try {
      const raw = window.localStorage.getItem(state.localKey);
      if (!raw) {
        return;
      }
      const payload = JSON.parse(raw);
      if (Array.isArray(payload.likes)) {
        state.likesOut = new Set(payload.likes.map(normalizePubkey));
      }
      if (Array.isArray(payload.matches)) {
        state.matches = new Set(payload.matches.map(normalizePubkey));
      }
    } catch (err) {
      console.warn('Dating: failed restoring local state', err);
    }
  };

  // חלק הכרויות (dating.js) – אתחול תשתיות (Pool, Relay, פרופיל)
  function bootstrap() {
    if (!App.profile || typeof App.profile !== 'object') {
      try {
        const storedProfile = window.localStorage.getItem('nostr_profile');
        if (storedProfile) {
          App.profile = JSON.parse(storedProfile);
        }
      } catch (err) {
        console.warn('Dating: failed restoring profile for gender detection', err);
      }
      if (!App.profile || typeof App.profile !== 'object') {
        App.profile = {};
      }
    }
    if (typeof App.ensureKeys === 'function') {
      App.ensureKeys();
    }
    if (!App.privateKey) {
      App.privateKey = window.localStorage.getItem('nostr_private_key') || '';
    }
    if (!App.publicKey && App.privateKey && typeof tools.getPublicKey === 'function') {
      try {
        App.publicKey = tools.getPublicKey(App.privateKey);
      } catch (err) {
        console.warn('Dating: failed deriving public key', err);
      }
    }
    if (!App.getInitials) {
      App.getInitials = (text = '') => text.trim().slice(0, 2).toUpperCase() || 'AN';
    }
    if (!App.profileCache) {
      App.profileCache = new Map();
    }
    if (!Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      App.relayUrls = ['wss://relay.damus.io', 'wss://relay.snort.social', 'wss://nos.lol'];
    }
    if (!App.pool && typeof tools.SimplePool === 'function') {
      App.pool = new tools.SimplePool();
    }
    if (typeof App.NETWORK_TAG !== 'string' || !App.NETWORK_TAG) {
      App.NETWORK_TAG = 'sos-network';
    }
    if (!App.datingMatches) {
      App.datingMatches = new Set();
    }
    if (typeof App.registerDatingMatchNotification !== 'function') {
      App.registerDatingMatchNotification = function noop() {};
    }
    state.localKey = App.publicKey ? `${STORAGE_PREFIX}${App.publicKey.toLowerCase()}` : null;
    state.viewerGender = normalizeGender(App.profile?.dating?.gender);
    if (!state.viewerGender) {
      try {
        const storedProfile = window.localStorage.getItem('nostr_profile');
        if (storedProfile) {
          const parsed = JSON.parse(storedProfile);
          state.viewerGender = normalizeGender(parsed?.dating?.gender);
        }
      } catch (err) {
        console.warn('Dating: failed reading gender from local storage', err);
      }
    }
    window.addEventListener('dating:viewer-gender-changed', handleViewerGenderChanged);
    window.addEventListener('storage', handleStorageGenderSync);
  }

  // חלק הכרויות (dating.js) – בניית פרופיל מועמד מתוך מטא-דאטה Kind 0
  function buildProfileFromMetadata(event) {
    if (!event?.pubkey || !event.content) {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(event.content);
    } catch (err) {
      return null;
    }
    if (!parsed.dating_opt_in) {
      return null;
    }
    const pubkey = normalizePubkey(event.pubkey);
    if (!pubkey || (App.publicKey && pubkey === normalizePubkey(App.publicKey))) {
      return null;
    }
    const candidateGender = normalizeGender(parsed.dating_gender);
    if (state.viewerGender) {
      const desiredGender = state.viewerGender === 'male' ? 'female' : state.viewerGender === 'female' ? 'male' : '';
      if (desiredGender && candidateGender !== desiredGender) {
        return null;
      }
      if (desiredGender && !candidateGender) {
        return null;
      }
    }
    const gallery = Array.isArray(parsed.gallery)
      ? parsed.gallery.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
    const picture = typeof parsed.picture === 'string' ? parsed.picture.trim() : '';
    const interests = Array.isArray(parsed.dating_interests)
      ? parsed.dating_interests.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
    const profile = {
      pubkey,
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : `משתמש ${pubkey.slice(0, 8)}`,
      bio: typeof parsed.about === 'string' ? parsed.about.trim() : '',
      datingBio: typeof parsed.dating_bio === 'string' ? parsed.dating_bio.trim() : '',
      datingAge: typeof parsed.dating_age === 'string' ? parsed.dating_age.trim() : '',
      datingLocation: typeof parsed.dating_location === 'string' ? parsed.dating_location.trim() : '',
      datingInterests: interests,
      gender: candidateGender,
      picture: picture || gallery[0] || '',
      gallery,
      updatedAt: event.created_at || 0,
    };
    App.profileCache.set(pubkey, profile);
    return profile;
  }

  // חלק הכרויות (dating.js) – טעינת רשימת מועמדים מן הריליים
  async function loadCandidates() {
    if (!App.pool || !Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      console.warn('Dating: missing pool or relays for candidate load');
      return;
    }
    const filter = { kinds: [0], limit: 300 };
    if (App.NETWORK_TAG) {
      filter['#t'] = [App.NETWORK_TAG];
    }
    let events = [];
    try {
      if (typeof App.pool.list === 'function') {
        events = await App.pool.list(App.relayUrls, [filter]);
      } else if (typeof App.pool.listMany === 'function') {
        events = await App.pool.listMany(App.relayUrls, [filter]);
      } else if (typeof App.pool.querySync === 'function') {
        const result = await App.pool.querySync(App.relayUrls, filter);
        events = Array.isArray(result?.events) ? result.events : Array.isArray(result) ? result : [];
      }
    } catch (err) {
      console.error('Dating: failed listing metadata events', err);
    }
    const seen = new Set();
    state.queue = [];
    events
      .filter((evt) => evt && typeof evt.created_at === 'number')
      .sort((a, b) => b.created_at - a.created_at)
      .forEach((evt) => {
        const profile = buildProfileFromMetadata(evt);
        if (!profile || seen.has(profile.pubkey)) {
          return;
        }
        seen.add(profile.pubkey);
        state.queue.push(profile);
      });
    state.index = 0;
  }

  // חלק הכרויות (dating.js) – הבטחת מידע מגדרי של הצופה לפני סינון
  async function ensureViewerGender() {
    if (state.viewerGender === 'male' || state.viewerGender === 'female') {
      return;
    }
    const current = normalizeGender(App.profile?.dating?.gender);
    if (current) {
      state.viewerGender = current;
      return;
    }
    try {
      const storedProfile = window.localStorage.getItem('nostr_profile');
      if (storedProfile) {
        const parsed = JSON.parse(storedProfile);
        const storedGender = normalizeGender(parsed?.dating?.gender);
        if (storedGender) {
          state.viewerGender = storedGender;
          return;
        }
      }
    } catch (err) {
      console.warn('Dating: ensure gender local lookup failed', err);
    }
    if (!App.pool || !App.publicKey) {
      return;
    }
    try {
      const event = await App.pool.get(App.relayUrls, { kinds: [0], authors: [App.publicKey], limit: 1 });
      if (event?.content) {
        const parsed = JSON.parse(event.content);
        const relayGender = normalizeGender(parsed?.dating_gender);
        if (relayGender) {
          state.viewerGender = relayGender;
        }
      }
    } catch (err) {
      console.warn('Dating: ensure gender relay lookup failed', err);
    }
  }

  // חלק הכרויות (dating.js) – טעינת לייקים נכנסים ויוצאים (Kind 40001)
  async function fetchLikeEvents({ incoming }) {
    if (!App.pool || !App.publicKey) {
      return;
    }
    const filter = incoming
      ? { kinds: [DATE_LIKE_KIND], '#p': [App.publicKey], limit: 300 }
      : { kinds: [DATE_LIKE_KIND], authors: [App.publicKey], limit: 300 };
    if (App.NETWORK_TAG) {
      filter['#t'] = [App.NETWORK_TAG];
    }
    try {
      const events = await App.pool.list(App.relayUrls, [filter]);
      events.forEach((evt) => {
        const normalized = incoming ? normalizePubkey(evt?.pubkey) : extractLikeTarget(evt);
        if (!normalized || normalized === normalizePubkey(App.publicKey)) {
          return;
        }
        if (incoming) {
          state.likesIn.add(normalized);
        } else {
          state.likesOut.add(normalized);
        }
      });
    } catch (err) {
      console.warn('Dating: failed fetching like events', err);
    }
  }
  const extractLikeTarget = (event) => {
    if (!event || !Array.isArray(event.tags)) {
      return '';
    }
    for (const tag of event.tags) {
      if (Array.isArray(tag) && tag[0] === 'p' && tag[1]) {
        return normalizePubkey(tag[1]);
      }
    }
    return '';
  };

  // חלק הכרויות (dating.js) – איחוד נתוני לייקים למציאת התאמות קיימות
  function reconcileMatches() {
    if (state.likesOut.size === 0 || state.likesIn.size === 0) {
      return;
    }
    state.likesOut.forEach((pubkey) => {
      if (!state.likesIn.has(pubkey) || state.matches.has(pubkey)) {
        return;
      }
      const candidate =
        state.queue.find((item) => item.pubkey === pubkey) ||
        App.profileCache.get(pubkey) ||
        {
          pubkey,
          name: `משתמש ${pubkey.slice(0, 8)}`,
          picture: '',
          gallery: [],
          datingBio: '',
          datingLocation: '',
          datingAge: '',
          datingInterests: [],
        };
      registerMatch(candidate);
    });
  }

  // חלק הכרויות (dating.js) – ניהול כרטיס נוכחי (רנדר, דילוג, לייק)
  function getNextCandidate() {
    while (state.index < state.queue.length) {
      const candidate = state.queue[state.index++];
      const key = candidate.pubkey;
      if (state.matches.has(key) || state.likesOut.has(key)) {
        continue;
      }
      state.current = candidate;
      return candidate;
    }
    state.current = null;
    return null;
  }
  function renderCurrentCandidate() {
    const candidate = getNextCandidate();
    if (!candidate) {
      refs.card?.setAttribute('hidden', '');
      if (refs.empty) {
        refs.empty.hidden = false;
      }
      return;
    }
    refs.empty && (refs.empty.hidden = true);
    if (!refs.card) {
      return;
    }
    refs.card.removeAttribute('hidden');
    refs.card.dataset.currentPubkey = candidate.pubkey;
    refs.name.textContent = candidate.datingAge ? `${candidate.name} · ${candidate.datingAge}` : candidate.name;
    refs.bio.textContent = candidate.datingBio || candidate.bio || 'עוד אין תיאור אישי.';
    if (refs.meta) {
      const parts = [];
      if (candidate.datingLocation) {
        parts.push(`<i class="fa-solid fa-location-dot"></i> ${escapeHtml(candidate.datingLocation)}`);
      }
      parts.push(`<i class="fa-solid fa-user"></i> ${escapeHtml(candidate.pubkey.slice(0, 10))}`);
      refs.meta.innerHTML = parts.join(' · ');
    }
    if (refs.tags) {
      refs.tags.innerHTML = '';
      candidate.datingInterests.slice(0, 10).forEach((interest) => {
        const chip = document.createElement('span');
        chip.className = 'dating-card__tag';
        chip.textContent = interest;
        refs.tags.appendChild(chip);
      });
    }
    if (refs.image) {
      const imageSrc = candidate.picture || candidate.gallery[0] || '';
      if (imageSrc) {
        showPlaceholder();
        refs.image.src = imageSrc;
        refs.image.alt = candidate.name;
      } else {
        refs.image.removeAttribute('src');
        refs.image.alt = 'אין תמונה זמינה';
        showPlaceholder();
      }
    }
  }
  const handlePass = () => {
    if (!state.current) {
      return;
    }
    const skipped = state.current;
    state.current = null;
    state.queue.push(skipped);
    renderCurrentCandidate();
  };
  async function handleLike() {
    if (!state.current || !App.publicKey || !App.privateKey || !App.pool) {
      return;
    }
    state.likesOut.add(state.current.pubkey);
    persistLocalState();
    const candidate = state.current;
    renderCurrentCandidate();
    try {
      await publishLikeEvent(candidate.pubkey);
    } catch (err) {
      console.warn('Dating: failed publishing like event', err);
    }
    if (state.likesIn.has(candidate.pubkey)) {
      registerMatch(candidate);
    }
  }

  // חלק הכרויות (dating.js) – פרסום לייק (Kind 40001) ורישום התאמה
  async function publishLikeEvent(targetPubkey) {
    const now = Math.floor(Date.now() / 1000);
    const draft = {
      kind: DATE_LIKE_KIND,
      pubkey: App.publicKey,
      created_at: now,
      tags: [
        ['p', targetPubkey],
        ['t', App.NETWORK_TAG],
        ['d', 'dating-like'],
      ],
      content: JSON.stringify({ message: 'like', ts: now }),
    };
    const event = App.finalizeEvent(draft, App.privateKey);
    await App.pool.publish(App.relayUrls, event);
  }
  function registerMatch(candidate) {
    const key = candidate.pubkey;
    if (state.matches.has(key)) {
      return;
    }
    state.matches.add(key);
    App.datingMatches.add(key);
    persistLocalState();
    showToast(`יש התאמה! ${candidate.name} מחכה לך.`);
    if (typeof App.registerDatingMatchNotification === 'function') {
      App.registerDatingMatchNotification({
        pubkey: candidate.pubkey,
        name: candidate.name,
        picture: candidate.picture,
      });
    }
  }

  // חלק הכרויות (dating.js) – האזנה ללייקים נכנסים חיים
  function subscribeIncomingLikes() {
    if (!App.pool || !App.publicKey || typeof App.pool.subscribeMany !== 'function') {
      return;
    }
    const filter = { kinds: [DATE_LIKE_KIND], '#p': [App.publicKey] };
    if (App.NETWORK_TAG) {
      filter['#t'] = [App.NETWORK_TAG];
    }
    const sub = App.pool.subscribeMany(App.relayUrls, [filter], {
      onevent: (event) => {
        const liker = normalizePubkey(event?.pubkey);
        if (!liker || liker === normalizePubkey(App.publicKey)) {
          return;
        }
        state.likesIn.add(liker);
        if (state.likesOut.has(liker) && !state.matches.has(liker)) {
          const candidate =
            state.queue.find((item) => item.pubkey === liker) ||
            App.profileCache.get(liker) ||
            {
              pubkey: liker,
              name: `משתמש ${liker.slice(0, 8)}`,
              picture: '',
              gallery: [],
              datingBio: '',
              datingLocation: '',
              datingAge: '',
              datingInterests: [],
            };
          registerMatch(candidate);
        }
      },
    });
    window.addEventListener('beforeunload', () => {
      try {
        sub.close?.();
      } catch (err) {
        console.debug('Dating: failed closing subscription', err);
      }
    });
  }

  // חלק הכרויות (dating.js) – חיבור כפתורים וריענון רשימה
  const reloadQueue = async () => {
    state.queue = [];
    state.index = 0;
    state.current = null;
    refs.card?.setAttribute('hidden', '');
    if (refs.empty) {
      refs.empty.hidden = false;
      const paragraph = refs.empty.querySelector('p');
      if (paragraph) {
        paragraph.textContent = 'טוען מועמדים חדשים...';
      }
    }
    await loadCandidates();
    renderCurrentCandidate();
    if (refs.empty) {
      const paragraph = refs.empty.querySelector('p');
      if (paragraph) {
        paragraph.textContent = 'לא נמצאו כרגע מועמדים חדשים. נסה לרענן בעוד מספר דקות.';
      }
    }
  };
  function bindActions() {
    refs.passButton?.addEventListener('click', handlePass);
    refs.likeButton?.addEventListener('click', handleLike);
    refs.refreshButton?.addEventListener('click', reloadQueue);
    refs.backButton?.addEventListener('click', () => {
      window.location.href = './index.html';
    });
    const introHandler = () => closeIntroOverlay();
    refs.introStart?.addEventListener('click', introHandler);
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeIntroOverlay();
      }
    });
  }

  // חלק הכרויות (dating.js) – תהליך אתחול כולל טעינת נתונים ופתיחת מנויים
  async function init() {
    bootstrap();
    restoreLocalState();
    // הצג מיד את שכבת ה-placeholder כדי שמד הטעינה יופיע עד שהתמונה הראשונה נטענת
    if (refs.placeholder) {
      refs.placeholder.hidden = false;
    }
    if (refs.image) {
      refs.image.classList.add('is-loading');
    }
    bindActions();
    await Promise.all([fetchLikeEvents({ incoming: true }), fetchLikeEvents({ incoming: false })]);
    reconcileMatches();
    await ensureViewerGender();
    await loadCandidates();
    renderCurrentCandidate();
    subscribeIncomingLikes();
  }

  // חלק הכרויות (dating.js) – טיפול באירועים חיצוניים שמשנים את מגדר הצופה
  function handleViewerGenderChanged(event) {
    const incoming = normalizeGender(event?.detail?.gender);
    if (!incoming || incoming === state.viewerGender) {
      return;
    }
    state.viewerGender = incoming;
    reloadQueue();
  }
  function handleStorageGenderSync(event) {
    if (event.key !== 'nostr_profile' || typeof event.newValue !== 'string') {
      return;
    }
    try {
      const parsed = JSON.parse(event.newValue);
      const nextGender = normalizeGender(parsed?.dating?.gender);
      if (nextGender && nextGender !== state.viewerGender) {
        state.viewerGender = nextGender;
        reloadQueue();
      }
    } catch (err) {
      console.warn('Dating: storage gender sync failed', err);
    }
  }

  init();
})(window);
