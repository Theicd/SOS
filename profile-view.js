  function bindHeaderShortcuts() {
    const homeButton = document.querySelector('[data-profile-tab="home"]');
    if (homeButton) {
      homeButton.addEventListener('click', () => {
        window.location.href = './index.html';
      });
    }
    const profileButton = document.querySelector('[data-profile-tab="profile"]');
    if (profileButton) {
      profileButton.addEventListener('click', () => {
        window.location.href = './profile.html';
      });
    }
  }

(function initProfilePage(window) {
  // חלק דף פרופיל (profile-view.js) – אתחול אובייקטי הבסיס והכלים הדרושים
  const App = window.NostrApp || (window.NostrApp = {});
  const tools = window.NostrTools || {};
  const getPublicKey = tools.getPublicKey || App.getPublicKey;

  // חלק אספקת רפרנסים (profile-view.js) – אוסף את כל האלמנטים המרכזיים לעבודה
  const refs = {
    connectionStatus: document.getElementById('connection-status'),
    avatar: document.getElementById('profilePageAvatar'),
    name: document.getElementById('profilePageName'),
    bio: document.getElementById('profilePageBio'),
    sidebarBio: document.getElementById('profileSidebarBio'),
    sidebarName: document.getElementById('profileSidebarName'),
    statsPosts: document.getElementById('profileStatsPosts'),
    statsRelays: document.getElementById('profileStatsRelays'),
    timelineStatus: document.getElementById('profileTimelineStatus'),
    timelineList: document.getElementById('profileTimeline'),
    timelineComments: document.getElementById('profileTimelineComments'),
    followersCard: document.getElementById('profileFollowersCard'),
    followersCount: document.getElementById('profileFollowersCountLabel'),
    followersSummaryCount: document.getElementById('profileFollowersCount'),
    followersList: document.getElementById('profileFollowersList'),
    followersStatus: document.getElementById('profileFollowersStatus'),
    topProfileButton: document.getElementById('profileTopAvatarButton'),
    topProfileMenu: document.getElementById('profileTopMenu'),
    topProfileWrapper: document.getElementById('profileTopProfile'),
    topMenuItems: document.querySelectorAll('[data-profile-action]'),
  };

  const followState = {
    snapshot: [],
    unsubscribe: null,
    profilePromises: new Map(),
  };

  function hideConnectionToast() {
    if (refs.connectionStatus) {
      refs.connectionStatus.hidden = true;
    }
  }

  // חלק אתחול ליבה (profile-view.js) – דואג שמפתחות ופרופיל יהיו זמינים לפני טעינה
  function ensureBootstrap() {
    if (typeof App.ensureKeys === 'function') {
      App.ensureKeys();
    }
    if (!App.privateKey) {
      App.privateKey = window.localStorage.getItem('nostr_private_key') || '';
    }
    if (!App.publicKey && App.privateKey && typeof getPublicKey === 'function') {
      try {
        App.publicKey = getPublicKey(App.privateKey);
      } catch (err) {
        console.warn('Failed deriving public key inside profile page', err);
      }
    }
    if (!App.profile) {
      App.profile = {
        name: 'משתמש אנונימי',
        bio: 'יצירת תוכן מבוזר, בלי שוטר באמצע',
        avatarInitials: 'AN',
        picture: '',
      };
    }
    if (!App.getInitials) {
      App.getInitials = (value = '') => value.trim().slice(0, 2).toUpperCase() || 'AN';
    }
    App.profile.avatarInitials = App.getInitials(App.profile.name || '');
    if (!App.profileCache) {
      App.profileCache = new Map();
    }
    App.profileCache.set(App.publicKey || 'self', {
      name: App.profile.name,
      bio: App.profile.bio,
      picture: App.profile.picture,
      initials: App.profile.avatarInitials,
    });
    if (!Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      App.relayUrls = [
        'wss://relay.damus.io',
        'wss://relay.snort.social',
        'wss://nos.lol',
      ];
    }
    if (!App.pool && typeof tools.SimplePool === 'function') {
      App.pool = new tools.SimplePool();
    }
    if (refs.connectionStatus && App.pool) {
      refs.connectionStatus.hidden = false;
      refs.connectionStatus.textContent = 'מתחבר לריליים...';
    }
  }

  // חלק תפריט פרופיל עליון (profile-view.js) – משחזר את התנהגות התפריט מהדף הראשי
  function syncTopAvatar() {
    const target = document.getElementById('profileTopAvatar');
    if (!target) {
      return;
    }
    target.innerHTML = '';
    const initials = App.profile?.avatarInitials || (typeof App.getInitials === 'function' ? App.getInitials(App.profile?.name || '') : 'AN');
    if (App.profile?.picture) {
      const img = document.createElement('img');
      img.src = App.profile.picture;
      img.alt = App.profile.name || 'הפרופיל שלי';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onerror = function onerr() {
        try { this.remove(); } catch (e) {}
        target.textContent = initials;
      };
      target.appendChild(img);
    } else {
      target.textContent = initials;
    }
  }

  function openTopMenu() {
    if (refs.topProfileMenu && refs.topProfileButton) {
      refs.topProfileMenu.hidden = false;
      refs.topProfileButton.setAttribute('aria-expanded', 'true');
    }
  }

  function closeTopMenu() {
    if (refs.topProfileMenu && refs.topProfileButton) {
      refs.topProfileMenu.hidden = true;
      refs.topProfileButton.setAttribute('aria-expanded', 'false');
    }
  }

  function handleTopMenuAction(action) {
    switch (action) {
      case 'view-profile':
        closeTopMenu();
        window.location.href = './profile.html';
        break;
      case 'logout':
        closeTopMenu();
        if (typeof window.logoutAndSwitchUser === 'function') {
          window.logoutAndSwitchUser();
        }
        break;
      default:
        break;
    }
  }

  function bindTopMenu() {
    if (!refs.topProfileWrapper || !refs.topProfileButton) {
      return;
    }

    const toggleMenu = (event) => {
      try {
        event.stopPropagation();
      } catch (err) {
        console.debug('toggleMenu event suppressed', err);
      }
      if (!refs.topProfileMenu) {
        return;
      }
      if (refs.topProfileMenu.hidden) {
        openTopMenu();
      } else {
        closeTopMenu();
      }
    };

    refs.topProfileButton.addEventListener('click', toggleMenu);
    window.addEventListener('click', (event) => {
      if (!refs.topProfileWrapper?.contains(event.target)) {
        closeTopMenu();
      }
    });

    refs.topMenuItems?.forEach((item) => {
      item.addEventListener('click', () => {
        handleTopMenuAction(item.getAttribute('data-profile-action'));
      });
    });

    syncTopAvatar();
  }

  // חלק יצירת מפתחות הצגה (profile-view.js) – אחראי לפורמט ידידותי למפתח הציבורי
  function getDisplayPublicKey() {
    if (!App.publicKey) {
      return 'מפתח ציבורי לא זמין';
    }
    if (typeof App.encodePublicKey === 'function') {
      return App.encodePublicKey(App.publicKey) || App.publicKey;
    }
    return App.publicKey;
  }

  // חלק ציור אווטר (profile-view.js) – מציג תמונה או ראשי תיבות של המשתמש
  function renderAvatar(target, profile) {
    if (!target) return;
    target.innerHTML = '';
    const initials = profile.avatarInitials || (typeof App.getInitials === 'function' ? App.getInitials(profile.name || '') : 'AN');
    if (profile.picture) {
      const img = document.createElement('img');
      img.src = profile.picture;
      img.alt = profile.name || 'משתמש';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onerror = function onerr() {
        try { this.remove(); } catch (e) {}
        target.textContent = initials;
      };
      target.appendChild(img);
      return;
    }
    target.textContent = initials;
  }

  // חלק סנכרון נתונים (profile-view.js) – מעדכן את פרטי המשתמש בכל האזורים בדף
  function syncProfileToPage() {
    const profile = App.profile || {};
    renderAvatar(refs.avatar, profile);
    if (refs.name) refs.name.textContent = profile.name || 'משתמש אנונימי';
    if (refs.bio) refs.bio.textContent = profile.bio || 'יצירת תוכן מבוזר, בלי שוטר באמצע';
    if (refs.sidebarBio) refs.sidebarBio.textContent = profile.bio || 'לא הוגדר עדיין תיאור קצר.';
    if (refs.sidebarName) refs.sidebarName.textContent = profile.name || 'משתמש אנונימי';
    if (refs.statsRelays) refs.statsRelays.textContent = Array.isArray(App.relayUrls) ? App.relayUrls.length.toString() : '0';
    renderFollowersSummary();
    renderFollowersList();
  }

  // חלק עוקבים (profile-view.js) – מציג את כמות העוקבים בפרופיל האישי
  function renderFollowersSummary() {
    const count = Array.isArray(followState.snapshot) ? followState.snapshot.length : 0;
    const label = `${count} עוקבים`;
    if (refs.followersCount) {
      refs.followersCount.textContent = label;
    }
    if (refs.followersSummaryCount) {
      refs.followersSummaryCount.textContent = label;
    }
  }

  // חלק עוקבים (profile-view.js) – מציג את רשימת העוקבים בתוך הכרטיס הצדדי
  function renderFollowersList() {
    if (!refs.followersList) {
      return;
    }
    const list = Array.isArray(followState.snapshot) ? followState.snapshot.slice(0, 20) : [];
    refs.followersList.innerHTML = '';
    if (list.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'profile-followers__empty';
      empty.textContent = 'עוד אין עוקבים להצגה.';
      refs.followersList.appendChild(empty);
      return;
    }
    const escapeHtml = typeof App.escapeHtml === 'function' ? App.escapeHtml : (value) => value;
    list.forEach((entry) => {
      const normalized = typeof entry.pubkey === 'string' ? entry.pubkey.toLowerCase() : '';
      const cached = App.profileCache instanceof Map ? App.profileCache.get(normalized) : null;
      const fallbackName = entry.pubkey ? `משתמש ${entry.pubkey.slice(0, 8)}` : 'משתמש אנונימי';
      const name = entry.name || cached?.name || fallbackName;
      const picture = entry.picture || cached?.picture || '';
      const initials = cached?.initials || (typeof App.getInitials === 'function' ? App.getInitials(name) : entry.pubkey?.slice?.(0, 2).toUpperCase());
      const safeName = escapeHtml(name);
      const safePicture = picture ? escapeHtml(picture) : '';
      const safeInitials = escapeHtml(initials || 'AN');
      const li = document.createElement('li');
      li.className = 'profile-followers__item';
      const attrName = safeName.replace(/"/g, '&quot;');
      const attrPicture = safePicture.replace(/"/g, '&quot;');
      li.innerHTML = `
        <button class="profile-followers__avatar" type="button" data-profile-link="${entry.pubkey}" data-profile-name="${attrName}" data-profile-picture="${attrPicture}">
          ${safePicture ? `<img src="${safePicture}" alt="${safeName}">` : `<span>${safeInitials}</span>`}
        </button>
        <span class="profile-followers__name">${safeName}</span>
      `;
      refs.followersList.appendChild(li);
    });
  }

  // חלק עוקבים (profile-view.js) – מוודא שמטא-דאטה של עוקבים נטען למטמון לימוש אחיד בין מסכים
  async function ensureFollowerProfiles(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }
    if (typeof App.fetchProfile !== 'function') {
      return;
    }
    if (!(App.profileCache instanceof Map)) {
      App.profileCache = new Map();
    }
    const jobs = [];
    entries.forEach((entry) => {
      const pubkey = typeof entry.pubkey === 'string' ? entry.pubkey.toLowerCase() : '';
      if (!pubkey) {
        return;
      }
      if (App.profileCache.has(pubkey) && (App.profileCache.get(pubkey)?.name || App.profileCache.get(pubkey)?.picture)) {
        return;
      }
      if (followState.profilePromises.has(pubkey)) {
        jobs.push(followState.profilePromises.get(pubkey));
        return;
      }
      const job = (async () => {
        try {
          const profile = await App.fetchProfile(pubkey);
          if (profile) {
            App.profileCache.set(pubkey, profile);
          }
        } catch (err) {
          console.warn('Profile view: failed fetching follower metadata', err);
        } finally {
          followState.profilePromises.delete(pubkey);
        }
      })();
      followState.profilePromises.set(pubkey, job);
      jobs.push(job);
    });
    if (jobs.length) {
      await Promise.allSettled(jobs);
    }
  }

  // חלק עוקבים (profile-view.js) – נרשם לעוקבים של המשתמש ומעדכן את הסיכום העליון
  function subscribeFollowers() {
    if (!App.publicKey || typeof App.subscribeFollowers !== 'function') {
      renderFollowersSummary();
      renderFollowersList();
      return;
    }
    if (typeof followState.unsubscribe === 'function') {
      followState.unsubscribe();
    }
    followState.unsubscribe = App.subscribeFollowers(App.publicKey, (entries) => {
      followState.snapshot = Array.isArray(entries) ? entries : [];
      renderFollowersSummary();
      renderFollowersList();
      ensureFollowerProfiles(followState.snapshot).catch((err) => {
        console.warn('Profile view: follower enrichment failed', err);
      });
    });
  }

  // חלק חיבור לדפדפן הקיים (profile-view.js) – עוטף את renderProfile הקודם ומעדכן דף זה
  function attachRenderHook() {
    const originalRender = App.renderProfile;
    App.renderProfile = function renderProfileWrapper() {
      if (typeof originalRender === 'function') {
        originalRender();
      }
      syncProfileToPage();
      syncTopAvatar();
    };
  }

  // חלק תצוגת זמנים (profile-view.js) – ממיר חותמות זמן לפורמט עברי קריא
  function formatTimestamp(seconds) {
    if (!seconds) {
      return 'לא ידוע';
    }
    try {
      const date = new Date(seconds * 1000);
      return date.toLocaleString('he-IL', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (err) {
      console.warn('Failed to format timestamp', err);
      return 'לא ידוע';
    }
  }

  // חלק בניית פריטי טיימליין (profile-view.js) – מחזיר אלמנט תצוגה לכל פוסט
  function buildTimelineItem(event) {
    const safeContent = typeof App.escapeHtml === 'function'
      ? App.escapeHtml(event.content || '')
      : (event.content || '');
    const createdLabel = formatTimestamp(event.created_at);
    const relayLabel = Array.isArray(event.seenOn) && event.seenOn.length > 0
      ? event.seenOn[0]
      : 'Relay';
    const li = document.createElement('li');
    li.className = 'profile-timeline__item';
    li.innerHTML = `
      <div class="profile-timeline__meta">
        <span>${createdLabel}</span>
        <span>${relayLabel}</span>
      </div>
      <div class="profile-timeline__content">${safeContent || 'תוכן ריק'}</div>
    `;
    return li;
  }

  // חלק רנדר טיימליין (profile-view.js) – מציב את הפוסטים ואת התגובות המצטברות
  function renderTimeline(posts, replies) {
    if (typeof App.renderProfilePosts === 'function') {
      const safePosts = Array.isArray(posts) ? posts : [];
      const safeReplies = Array.isArray(replies) ? replies : [];
      App.renderProfilePosts(safePosts, 'profileTimeline');
      App.renderProfilePosts(safeReplies, 'profileTimelineComments');
      if (typeof App.updateLikeIndicator === 'function') {
        safePosts.forEach((event) => {
          if (event?.id) {
            App.updateLikeIndicator(event.id);
          }
        });
      }
    } else if (refs.timelineList) {
      refs.timelineList.innerHTML = '';
      if (Array.isArray(posts) && posts.length) {
        posts.forEach((event) => refs.timelineList.appendChild(buildTimelineItem(event)));
      } else {
        const empty = document.createElement('li');
        empty.className = 'profile-timeline__item';
        empty.textContent = 'לא נמצאו פוסטים בפרופיל.';
        refs.timelineList.appendChild(empty);
      }
      if (refs.timelineComments) {
        refs.timelineComments.innerHTML = '';
        if (Array.isArray(replies) && replies.length) {
          replies.forEach((event) => refs.timelineComments.appendChild(buildTimelineItem(event)));
        } else {
          const emptyReply = document.createElement('li');
          emptyReply.className = 'profile-timeline__item';
          emptyReply.textContent = 'עוד לא הגבנו לפוסטים אחרים.';
          refs.timelineComments.appendChild(emptyReply);
        }
      }
    }
    if (refs.statsPosts) {
      const count = Array.isArray(posts) ? posts.length : 0;
      refs.statsPosts.textContent = count.toString();
    }
  }

  async function loadOwnPosts() {
    if (!refs.timelineStatus) {
      hideConnectionToast();
      return;
    }
    if (!App.publicKey) {
      refs.timelineStatus.textContent = 'אין מפתח ציבורי זמין לטעינת הפוסטים.';
      renderTimeline([]);
      hideConnectionToast();
      return;
    }
    if (!App.pool || !Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      refs.timelineStatus.textContent = 'Pool לא זמין כרגע. נסה לרענן מאוחר יותר.';
      renderTimeline([]);
      hideConnectionToast();
      return;
    }

    refs.timelineStatus.textContent = 'טוען את הפוסטים שלך מהריליים...';
    const collected = new Map();

    try {
      const filter = {
        kinds: [1],
        authors: [App.publicKey],
        limit: 120,
      };

      const extractParentId = (event) => {
        // חלק סיווג פוסטים/תגובות (profile-view.js) – בהתאם ל-NIP-10
        // תגובה מזוהה רק אם קיימת תגית 'e' עם marker 'reply'.
        // תמיכה ב-legacy: אם אין marker בכלל ויש 2+ תגיות 'e', האחרונה תיחשב reply; אחרת נשאיר כפוסט.
        if (!event || !Array.isArray(event.tags)) {
          return null;
        }
        const eTags = event.tags.filter((t) => Array.isArray(t) && t[0] === 'e');
        if (eTags.length === 0) {
          return null;
        }
        for (const tag of eTags) {
          if (tag[3] === 'reply') {
            return tag[1] || null;
          }
        }
        // אין marker 'reply' – אל תסווג כתגובה אלא אם legacy עם 2+ תווי e ללא marker
        const hasAnyMarker = eTags.some((t) => typeof t[3] === 'string' && t[3]);
        if (!hasAnyMarker && eTags.length >= 2) {
          const last = eTags[eTags.length - 1];
          return last?.[1] || null;
        }
        return null;
      };

      // חלק טעינת פוסטים (profile-view.js) – מבצע קריאה ל-list ומגבה לגרסת subscribeMany כאשר הפונקציה חסרה ב-SimplePool
      let events;
      if (typeof App.pool.list === 'function') {
        events = await App.pool.list(App.relayUrls, [filter]);
      } else if (typeof App.pool.subscribeMany === 'function') {
        events = await new Promise((resolve, reject) => {
          const collectedEvents = [];
          let subscription;
          try {
            subscription = App.pool.subscribeMany(App.relayUrls, [filter], {
              onevent(event) {
                if (event && typeof event.created_at === 'number') {
                  collectedEvents.push(event);
                }
              },
              oneose() {
                try {
                  subscription?.close?.();
                } catch (closeErr) {
                  console.warn('Profile view: fallback subscription close failed', closeErr);
                }
                resolve(collectedEvents);
              },
            });
          } catch (err) {
            reject(err);
            return;
          }
          setTimeout(() => {
            try {
              subscription?.close?.();
            } catch (timeoutErr) {
              console.warn('Profile view: fallback subscription timeout close failed', timeoutErr);
            }
            resolve(collectedEvents);
          }, 6000);
        });
      } else {
        throw new Error('Pool instance missing list compatibility');
      }
      events.forEach((event) => {
        if (!event || typeof event.created_at !== 'number') {
          return;
        }
        if (event.id) {
          collected.set(event.id, { event, parentId: extractParentId(event) });
        }
      });

      const posts = [];
      const replies = [];
      collected.forEach(({ event, parentId }) => {
        if (parentId) {
          replies.push(event);
        } else {
          posts.push(event);
        }
      });

      const sortedPosts = posts.sort((a, b) => b.created_at - a.created_at);
      const sortedReplies = replies.sort((a, b) => b.created_at - a.created_at);

      if (typeof App.hydrateEngagementForPosts === 'function') {
        try {
          await App.hydrateEngagementForPosts(sortedPosts, (evt) => extractParentId(evt));
        } catch (err) {
          console.warn('hydrateEngagementForPosts failed on profile page', err);
        }
      }

      renderTimeline(sortedPosts, sortedReplies);

      if (typeof App.updateCommentsForParent === 'function') {
        sortedPosts.forEach((event) => {
          if (event?.id) {
            App.updateCommentsForParent(event.id);
          }
        });
      }

      refs.timelineStatus.textContent = sortedPosts.length > 0
        ? `רשימת הפוסטים שלך נטענה (${sortedPosts.length}).`
        : 'אין פוסטים להצגה עדיין. שתף פוסט ראשון מהפיד.';
      hideConnectionToast();
    } catch (err) {
      console.error('Failed loading own posts', err);
      refs.timelineStatus.textContent = 'שגיאה בטעינת הפוסטים. בדוק את החיבור ונסה שוב.';
      renderTimeline([]);
      hideConnectionToast();
    }
  }

  App.loadOwnPosts = loadOwnPosts;

  // חלק שירות לוח (profile-view.js) – העתקה ללוח זיכרון בצורה בטוחה עם הודעות שגיאה
  // חלק קיצור איחודים (profile-view.js) – חבר כפתורים מרובים לפעולה אחת
  function attachClicks(ids, handler) {
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('click', handler);
      }
    });
  }

  // חלק קישורי כפתורים (profile-view.js) – יוצר את חוויית השימוש בדף
  function bindButtons() {
    attachClicks(['profileEditButton', 'profileTopEditButton'], () => {
      if (typeof window.openProfileSettings === 'function') {
        window.openProfileSettings();
      }
    });

    attachClicks(['profileHomeButton', 'profileTopHomeButton'], () => {
      window.location.href = 'index.html';
    });

    attachClicks(['profileRefreshPosts'], loadOwnPosts);
    attachClicks(['profileQuickCompose'], () => {
      window.location.href = 'index.html#compose';
    });
    bindTopMenu();
    bindHeaderShortcuts();
  }

  // חלק אתחול דף (profile-view.js) – מפעיל את השלבים הנדרשים בעת טעינת הפרופיל
  function initializeProfilePage() {
    ensureBootstrap();
    attachRenderHook();
    syncProfileToPage();
    if (typeof App.renderProfile === 'function') {
      App.renderProfile();
    }
    if (typeof App.loadOwnProfileMetadata === 'function') {
      App.loadOwnProfileMetadata().then(() => {
        syncProfileToPage();
      });
    }
    if (typeof App.subscribeOwnProfileMetadata === 'function') {
      App.subscribeOwnProfileMetadata();
    }
    subscribeFollowers();
    bindButtons();
    loadOwnPosts();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeProfilePage);
  } else {
    initializeProfilePage();
  }
})(window);
