;(function initFollowService(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  // חלק ניהול עוקבים (follow-service.js) – הגדרת kind ייעודי ושמירתו ב-App לשימוש מודולים אחרים
  const FOLLOW_KIND = 40010;
  App.FOLLOW_KIND = FOLLOW_KIND;
  // חלק מצב פנימי (follow-service.js) – שומר מבני נתונים לרשימות עוקבים והקשרים בין מאזינים
  const followState = {
    followersByTarget: new Map(),
    callbacksByTarget: new Map(),
    followerSubscriptions: new Map(),
    pendingTargets: new Set(),
    followingSet: new Set(),
    followingLoaded: false,
  };
  const STORAGE_PREFIX = 'nostr_following_';

  // חלק IndexedDB Cache (follow-service.js) – שמירת follow state ב-IndexedDB למניעת פניות מיותרות לריליי | HYPER CORE TECH
  const FOLLOW_DB_NAME = 'SOS2FollowCache';
  const FOLLOW_DB_VERSION = 1;
  const FOLLOW_STORE_NAME = 'followState';
  let followDB = null;

  async function openFollowDB() {
    if (followDB) return followDB;
    return new Promise((resolve) => {
      try {
        const request = indexedDB.open(FOLLOW_DB_NAME, FOLLOW_DB_VERSION);
        request.onerror = () => resolve(null);
        request.onsuccess = () => {
          followDB = request.result;
          resolve(followDB);
        };
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(FOLLOW_STORE_NAME)) {
            db.createObjectStore(FOLLOW_STORE_NAME, { keyPath: 'pubkey' });
          }
        };
      } catch (err) {
        console.warn('Follow service: failed to open IndexedDB', err);
        resolve(null);
      }
    });
  }

  async function persistFollowingToIndexedDB() {
    const db = await openFollowDB();
    if (!db) return;
    const pubkey = normalizePubkey(App.publicKey);
    if (!pubkey) return;
    try {
      const tx = db.transaction([FOLLOW_STORE_NAME], 'readwrite');
      const store = tx.objectStore(FOLLOW_STORE_NAME);
      const data = {
        pubkey,
        following: Array.from(followState.followingSet.values()),
        updatedAt: Date.now(),
      };
      store.put(data);
    } catch (err) {
      console.warn('Follow service: failed to persist to IndexedDB', err);
    }
  }

  async function restoreFollowingFromIndexedDB() {
    const db = await openFollowDB();
    if (!db) return false;
    const pubkey = normalizePubkey(App.publicKey);
    if (!pubkey) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction([FOLLOW_STORE_NAME], 'readonly');
        const store = tx.objectStore(FOLLOW_STORE_NAME);
        const request = store.get(pubkey);
        request.onsuccess = () => {
          const data = request.result;
          if (data && Array.isArray(data.following)) {
            data.following.forEach((item) => {
              const normalized = normalizePubkey(item);
              if (normalized) followState.followingSet.add(normalized);
            });
            console.log('[Follow] Restored from IndexedDB:', data.following.length, 'following');
            resolve(true);
          } else {
            resolve(false);
          }
        };
        request.onerror = () => resolve(false);
      } catch (err) {
        console.warn('Follow service: failed to restore from IndexedDB', err);
        resolve(false);
      }
    });
  }

  // חלק מטא-דאטה (follow-service.js) – מספק פונקציית גיבוי לשליפת פרופילים עבור דפי פרופיל ו-Follow
  async function fetchProfileFallback(pubkey) {
    const normalized = normalizePubkey(pubkey);
    if (!normalized) {
      return {
        name: 'משתמש אנונימי',
        bio: '',
        picture: '',
        initials: 'AN',
      };
    }
    if (!(App.profileCache instanceof Map)) {
      App.profileCache = new Map();
    }
    if (App.profileCache.has(normalized)) {
      return App.profileCache.get(normalized);
    }
    const fallback = {
      name: `משתמש ${normalized.slice(0, 8)}`,
      bio: '',
      picture: '',
      initials: typeof App.getInitials === 'function' ? App.getInitials(normalized) : normalized.slice(0, 2).toUpperCase(),
    };
    App.profileCache.set(normalized, fallback);
    if (!App.pool || !Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      return fallback;
    }
    try {
      const filter = { kinds: [0], authors: [normalized], limit: 1 };
      const metadataEvent = typeof App.pool.get === 'function'
        ? await App.pool.get(App.relayUrls, filter)
        : Array.isArray(App.relayUrls) && typeof App.pool.list === 'function'
        ? (await App.pool.list(App.relayUrls, [filter]))?.[0]
        : null;
      if (metadataEvent?.content) {
        const parsed = JSON.parse(metadataEvent.content);
        const name = parsed.name ? parsed.name.toString().trim() : fallback.name;
        const bio = parsed.about ? parsed.about.toString().trim() : '';
        const picture = parsed.picture ? parsed.picture.toString().trim() : '';
        const enriched = {
          name: name || fallback.name,
          bio,
          picture,
          initials: typeof App.getInitials === 'function' ? App.getInitials(name || normalized) : fallback.initials,
        };
        App.profileCache.set(normalized, enriched);
        return enriched;
      }
    } catch (err) {
      console.warn('Follow service: failed fetching profile metadata fallback', err);
    }
    return fallback;
  }

  if (typeof App.fetchProfile !== 'function') {
    App.fetchProfile = fetchProfileFallback;
  }

  function normalizePubkey(pubkey) {
    return typeof pubkey === 'string' ? pubkey.trim().toLowerCase() : '';
  }
  function getFollowingStorageKey() {
    const current = normalizePubkey(App.publicKey);
    return current ? `${STORAGE_PREFIX}${current}` : null;
  }
  function persistFollowingToStorage() {
    const key = getFollowingStorageKey();
    if (!key) return;
    try {
      const list = Array.from(followState.followingSet.values());
      window.localStorage.setItem(key, JSON.stringify(list));
      // חלק IndexedDB (follow-service.js) – שמירה גם ב-IndexedDB | HYPER CORE TECH
      persistFollowingToIndexedDB();
    } catch (err) {
      console.warn('Follow service: failed storing following list', err);
    }
  }
  async function restoreFollowingFromStorage() {
    // חלק IndexedDB (follow-service.js) – ניסיון שחזור מ-IndexedDB קודם | HYPER CORE TECH
    const restoredFromDB = await restoreFollowingFromIndexedDB();
    if (restoredFromDB) {
      refreshFollowButtons();
      return;
    }
    // Fallback ל-localStorage
    const key = getFollowingStorageKey();
    if (!key) {
      return;
    }
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((item) => {
          const normalized = normalizePubkey(item);
          if (normalized) followState.followingSet.add(normalized);
        });
      }
    } catch (err) {
      console.warn('Follow service: failed restoring following list', err);
    }
  }
  function parseFollowAction(content) {
    if (typeof content === 'string') {
      const trimmed = content.trim();
      if (!trimmed) {
        return 'follow';
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.type === 'string') {
          return parsed.type === 'unfollow' ? 'unfollow' : 'follow';
        }
      } catch (err) {
        const lowered = trimmed.toLowerCase();
        if (lowered === 'unfollow' || lowered === 'remove') {
          return 'unfollow';
        }
      }
      const lowered = trimmed.toLowerCase();
      if (lowered === 'unfollow' || lowered === 'remove') {
        return 'unfollow';
      }
    } else if (content && typeof content === 'object') {
      const type = content.type ? String(content.type).toLowerCase() : '';
      if (type === 'unfollow') {
        return 'unfollow';
      }
    }
    return 'follow';
  }
  function extractTarget(tags) {
    if (!Array.isArray(tags)) return '';
    for (const tag of tags) {
      if (!Array.isArray(tag)) continue;
      if (tag[0] === 'p' && typeof tag[1] === 'string' && tag[1]) return normalizePubkey(tag[1]);
    }
    return '';
  }
  function getFollowersMap(target) {
    const normalized = normalizePubkey(target);
    if (!normalized) return null;
    if (!followState.followersByTarget.has(normalized)) followState.followersByTarget.set(normalized, new Map());
    return followState.followersByTarget.get(normalized);
  }
  function getFollowersSnapshot(target) {
    const map = getFollowersMap(target);
    if (!map) return [];
    return Array.from(map.values())
      .filter((entry) => entry.action === 'follow')
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      .map((entry) => ({
        pubkey: entry.pubkey,
        created_at: entry.created_at,
        name: entry.name || '',
        picture: entry.picture || '',
      }));
  }
  function notifyFollowers(target) {
    const normalized = normalizePubkey(target);
    if (!normalized) return;
    const callbacks = followState.callbacksByTarget.get(normalized);
    if (!Array.isArray(callbacks) || callbacks.length === 0) return;
    const snapshot = getFollowersSnapshot(normalized);
    callbacks.forEach((callback) => {
      try {
        callback(snapshot);
      } catch (err) {
        console.warn('Follow service: follower callback failed', err);
      }
    });
  }
  function refreshFollowButtons(root) {
    const scope = root instanceof Element ? root : document;
    const buttons = scope.querySelectorAll('[data-follow-button]');
    buttons.forEach((button) => {
      const target = normalizePubkey(button.getAttribute('data-follow-button'));
      if (!target) {
        button.disabled = true;
        return;
      }
      const isSelf = target && target === normalizePubkey(App.publicKey);
      const isFollowing = followState.followingSet.has(target);
      const isPending = followState.pendingTargets.has(target);
      button.disabled = isSelf || isPending || !App.publicKey || !App.privateKey;
      button.classList.toggle('is-following', isFollowing);
      button.setAttribute('aria-pressed', isFollowing ? 'true' : 'false');
      const icon = button.querySelector('i');
      // לא לשנות אייקון לכפתור videos-follow-button - הוא תמיד פלוס בלבד
      if (icon && !button.classList.contains('videos-follow-button')) {
        icon.classList.toggle('fa-user-minus', isFollowing);
        icon.classList.toggle('fa-user-plus', !isFollowing);
      }
      // עדכון אייקון וי/פלוס לכפתור וידאו
      const videoIcon = button.querySelector('.videos-follow-icon');
      if (videoIcon) {
        videoIcon.textContent = isFollowing ? '✓' : '+';
      }
      const label = button.querySelector('span[data-follow-label]') || button.querySelector('span');
      if (label) {
        label.textContent = isFollowing ? 'עוקב/ת' : 'עקוב';
      }
    });
  }
  function applyFollowEvent(event) {
    if (!event || event.kind !== FOLLOW_KIND) return false;
    const target = extractTarget(event.tags);
    if (!target) return false;
    const actor = normalizePubkey(event.pubkey);
    if (!actor) return false;
    const action = parseFollowAction(event.content);
    let payloadName = '';
    let payloadPicture = '';
    try {
      const parsed = typeof event.content === 'string' && event.content.trim() ? JSON.parse(event.content) : null;
      if (parsed && typeof parsed === 'object') {
        if (parsed.name && typeof parsed.name === 'string') {
          payloadName = parsed.name.trim();
        }
        if (parsed.picture && typeof parsed.picture === 'string') {
          payloadPicture = parsed.picture.trim();
        }
      }
    } catch (err) {
      // המידע אינו חובה ולכן נתעלם משגיאת ניתוח
    }
    const createdAt = typeof event.created_at === 'number' ? event.created_at : Math.floor(Date.now() / 1000);
    const followersMap = getFollowersMap(target);
    if (!followersMap) {
      return false;
    }
    const existing = followersMap.get(actor);
    if (existing && (existing.created_at || 0) >= createdAt) {
      return false;
    }
    if (action === 'unfollow') {
      followersMap.delete(actor);
    } else {
      const enriched = { pubkey: actor, created_at: createdAt, action, raw: event };
      if (payloadName) {
        enriched.name = payloadName;
      }
      if (payloadPicture) {
        enriched.picture = payloadPicture;
      }
      followersMap.set(actor, enriched);
    }
    if (actor === normalizePubkey(App.publicKey)) {
      if (action === 'unfollow') {
        followState.followingSet.delete(target);
      } else {
        followState.followingSet.add(target);
      }
      persistFollowingToStorage();
      refreshFollowButtons();
    }
    notifyFollowers(target);
    return true;
  }
  async function loadFollowingFromRelays() {
    if (followState.followingLoaded) return;
    const current = normalizePubkey(App.publicKey);
    if (!current || !App.pool) return;
    followState.followingLoaded = true;
    const filter = { kinds: [FOLLOW_KIND], authors: [App.publicKey], limit: 400 };
    if (App.NETWORK_TAG) {
      filter['#t'] = [App.NETWORK_TAG];
    }
    let events = [];
    try {
      if (typeof App.pool.list === 'function') {
        events = await App.pool.list(App.relayUrls, [filter]);
      } else if (typeof App.pool.listMany === 'function') {
        events = await App.pool.listMany(App.relayUrls, [filter]);
      }
    } catch (err) {
      console.warn('Follow service: failed loading following from relays', err);
    }
    if (Array.isArray(events) && events.length) {
      events.forEach((event) => {
        const changed = applyFollowEvent(event);
        // חלק התרעות עוקב (follow-service.js) – יצירת התרעה גם בטעינה ההתחלתית של עוקבים
        if (changed && typeof App.handleNotificationForFollow === 'function') {
          App.handleNotificationForFollow(event);
        }
      });
      refreshFollowButtons();
    }
  }
  function subscribeFollowers(targetPubkey, callback) {
    const target = normalizePubkey(targetPubkey);
    if (!target || typeof callback !== 'function') return () => {};
    if (!followState.callbacksByTarget.has(target)) followState.callbacksByTarget.set(target, []);
    const list = followState.callbacksByTarget.get(target);
    list.push(callback);
    callback(getFollowersSnapshot(target));

    if (!followState.followerSubscriptions.has(target) && App.pool && Array.isArray(App.relayUrls)) {
      const filter = { kinds: [FOLLOW_KIND], '#p': [target], limit: 400 };
      if (App.NETWORK_TAG) {
        filter['#t'] = [App.NETWORK_TAG];
      }
      const sub = App.pool.subscribeMany(App.relayUrls, [filter], {
        onevent(event) {
          const changed = applyFollowEvent(event);
          if (!changed) return;
          // חלק התרעות עוקב (follow-service.js) – יצירת התרעה כאשר משתמש חדש מתחיל לעקוב אחרינו
          if (typeof App.handleNotificationForFollow === 'function') {
            App.handleNotificationForFollow(event);
          }
        },
      });
      followState.followerSubscriptions.set(target, sub);
    }

    return () => {
      const callbacks = followState.callbacksByTarget.get(target);
      if (Array.isArray(callbacks)) {
        const index = callbacks.indexOf(callback);
        if (index >= 0) {
          callbacks.splice(index, 1);
        }
      }
      if (callbacks && callbacks.length === 0) {
        followState.callbacksByTarget.delete(target);
        const sub = followState.followerSubscriptions.get(target);
        if (sub && typeof sub.close === 'function') {
          try {
            sub.close();
          } catch (err) {
            console.warn('Follow service: failed closing follower subscription', err);
          }
        }
        followState.followerSubscriptions.delete(target);
      }
    };
  }

  async function toggleFollow(targetPubkey, meta = {}) {
    const target = normalizePubkey(targetPubkey);
    const current = normalizePubkey(App.publicKey);
    if (!target || !App.pool || !App.privateKey || typeof App.finalizeEvent !== 'function') {
      console.warn('Follow service: missing prerequisites for toggle');
      return;
    }
    if (target === current) return;
    const following = followState.followingSet.has(target);
    let optimisticChanged = false;
    followState.pendingTargets.add(target);
    if (!following) {
      followState.followingSet.add(target);
      optimisticChanged = true;
    } else {
      followState.followingSet.delete(target);
      optimisticChanged = true;
    }
    refreshFollowButtons();
    try {
      const now = Math.floor(Date.now() / 1000);
      const normalizedMetaName = typeof meta.name === 'string' ? meta.name.trim() : '';
      const normalizedMetaPicture = typeof meta.picture === 'string' ? meta.picture.trim() : '';
      let fallbackName = '';
      let fallbackPicture = '';
      if (App.profile && typeof App.profile === 'object') {
        fallbackName = typeof App.profile.name === 'string' ? App.profile.name.trim() : fallbackName;
        fallbackPicture = typeof App.profile.picture === 'string' ? App.profile.picture.trim() : fallbackPicture;
      }
      if ((!fallbackName || !fallbackPicture) && App.profileCache instanceof Map) {
        const selfCached = App.profileCache.get(current) || App.profileCache.get(App.publicKey) || null;
        if (selfCached) {
          if (!fallbackName && typeof selfCached.name === 'string') {
            fallbackName = selfCached.name.trim();
          }
          if (!fallbackPicture && typeof selfCached.picture === 'string') {
            fallbackPicture = selfCached.picture.trim();
          }
        }
      }
      const payload = {
        type: following ? 'unfollow' : 'follow',
        ts: now,
        name: normalizedMetaName || fallbackName || `משתמש ${current.slice(0, 8)}`,
        picture: normalizedMetaPicture || fallbackPicture || '',
      };
      const tags = [['p', target]];
      if (App.NETWORK_TAG) {
        tags.push(['t', App.NETWORK_TAG]);
      }
      const draft = {
        kind: FOLLOW_KIND,
        pubkey: App.publicKey,
        created_at: now,
        tags,
        content: JSON.stringify(payload),
      };
      const event = App.finalizeEvent(draft, App.privateKey);
      await App.pool.publish(App.relayUrls, event);
      applyFollowEvent(event);
    } catch (err) {
      console.error('Follow service: failed toggling follow state', err);
      if (!following) {
        notifyFollowers(target);
      }
      if (optimisticChanged) {
        if (following) {
          followState.followingSet.add(target);
        } else {
          followState.followingSet.delete(target);
        }
      }
    } finally {
      followState.pendingTargets.delete(target);
      refreshFollowButtons();
    }
  }
  function initializeFollowService() {
    if (followState.initialized) return;
    followState.initialized = true;
    restoreFollowingFromStorage();
    loadFollowingFromRelays();
    refreshFollowButtons();
  }
  const previousNotifyPoolReady = App.notifyPoolReady;
  App.notifyPoolReady = function followNotifyBridge(pool) {
    if (typeof previousNotifyPoolReady === 'function') {
      try {
        previousNotifyPoolReady(pool);
      } catch (err) {
        console.warn('Follow service: previous notifyPoolReady failed', err);
      }
    }
    if (pool) {
      initializeFollowService();
    }
  };
  if (App.pool) {
    initializeFollowService();
  }
  // חלק אתחול מוקדם (follow-service.js) – טעינת סטייט Follow מ-localStorage מיד | HYPER CORE TECH
  restoreFollowingFromStorage();
  App.toggleFollow = toggleFollow;
  App.isFollowing = function isFollowing(targetPubkey) {
    return followState.followingSet.has(normalizePubkey(targetPubkey));
  };
  App.subscribeFollowers = subscribeFollowers;
  App.getFollowersSnapshot = getFollowersSnapshot;
  App.refreshFollowButtons = refreshFollowButtons;
  if (!window.__sosFollowDelegationAttached) {
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-follow-button]');
      if (!button || button.disabled) {
        return;
      }
      const targetPubkey = normalizePubkey(button.getAttribute('data-follow-button'));
      if (!targetPubkey || typeof App.toggleFollow !== 'function') {
        return;
      }
      event.preventDefault();
      const normalizedSelf = normalizePubkey(App.publicKey);
      const cachedSelf = normalizedSelf && App.profileCache instanceof Map ? App.profileCache.get(normalizedSelf) : null;
      const meta = {
        name:
          (App.profile && typeof App.profile.name === 'string' && App.profile.name.trim())
            ? App.profile.name.trim()
            : (cachedSelf && typeof cachedSelf.name === 'string' ? cachedSelf.name.trim() : ''),
        picture:
          (App.profile && typeof App.profile.picture === 'string' && App.profile.picture.trim())
            ? App.profile.picture.trim()
            : (cachedSelf && typeof cachedSelf.picture === 'string' ? cachedSelf.picture.trim() : ''),
      };
      try {
        button.blur();
      } catch (err) {
        console.debug('Follow button blur failed', err);
      }
      App.toggleFollow(targetPubkey, meta);
    });
    window.__sosFollowDelegationAttached = true;
  }
})(window);
