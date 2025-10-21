;(function initFeed(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  App.deletedEventIds = App.deletedEventIds || new Set(); // חלק פיד (feed.js) – שומר מזהים של פוסטים שנמחקו כדי שלא להציגם
  App.profileCache = App.profileCache || new Map(); // חלק פיד (feed.js) – מאחסן מטא-דאטה של פרופילים כדי לחסוך שאילתות
  App.eventAuthorById = App.eventAuthorById || new Map(); // חלק פיד (feed.js) – מאפשר לשייך אירועים למחבר שלהם למטרות הרשאות
  App.likesByEventId = App.likesByEventId || new Map(); // חלק פיד (feed.js) – סופר לייקים לכל פוסט לפי מזהה האירוע
  App.commentsByParent = App.commentsByParent || new Map(); // חלק פיד (feed.js) – מרכז את כל תגובות kind 1 לכל פוסט כדי שכל המשתמשים יראו אותן
  App.notifications = Array.isArray(App.notifications) ? App.notifications : []; // חלק התרעות (feed.js) – מאחסן את רשימת ההתרעות לפי סדר יורד
  App.notificationsById = App.notificationsById instanceof Map ? App.notificationsById : new Map(); // חלק התרעות (feed.js) – מאפשר למנוע כפילויות התרעה לפי מזהה האירוע
  App.unreadNotificationCount = typeof App.unreadNotificationCount === 'number' ? App.unreadNotificationCount : 0; // חלק התרעות (feed.js) – סופר כמה התרעות לא נקראו להדלקת הכפתור
  App.notificationListeners = App.notificationListeners instanceof Set ? App.notificationListeners : new Set(); // חלק התרעות (feed.js) – מאזין ברמת ה-App לשינויים עבור ממשקים אחרים (למשל הצ'אט)
  App.feedAuthorProfiles = App.feedAuthorProfiles instanceof Map ? App.feedAuthorProfiles : new Map(); // חלק פרופילים משותף (feed.js) – מטמון קליל לשימוש חוזר בדפי צפייה בפרופיל
  App.authorProfiles = App.authorProfiles instanceof Map ? App.authorProfiles : new Map();
  if (typeof App.notificationsRestored !== 'boolean') {
    App.notificationsRestored = false; // חלק התרעות (feed.js) – מבטיח שנשחזר התרעות פעם אחת לאחר התחברות
  }
  App.postsById = App.postsById instanceof Map ? App.postsById : new Map(); // חלק התרעות (feed.js) – שומר את אירועי הפיד לפי מזהה להצלבת התרעות
  App.pendingNotificationQueue = Array.isArray(App.pendingNotificationQueue) ? App.pendingNotificationQueue : []; // חלק התרעות (feed.js) – משמר אירועי התרעה מושהים עד שהפוסט נטען
  App.pendingNotificationSet = App.pendingNotificationSet instanceof Set ? App.pendingNotificationSet : new Set(); // חלק התרעות (feed.js) – מונע כפילויות בתור ההתרעות המושהה
  const DATING_LIKE_KIND = 40001; // חלק התרעות הכרויות (feed.js) – מזהה kind ייעודי ללייקים בדף ההכרויות
  App.profileFetchPromises = App.profileFetchPromises instanceof Map ? App.profileFetchPromises : new Map();

  function updateRenderedAuthorProfile(pubkey, profile) {
    // חלק פיד (feed.js) – מעדכן פוסטים קיימים כאשר נתוני הפרופיל מתעדכנים כדי לשמור על שם ותמונה עקביים
    if (typeof document === 'undefined') {
      return;
    }
    const normalized = typeof pubkey === 'string' ? pubkey.trim().toLowerCase() : '';
    if (!normalized) {
      return;
    }
    const displayName = profile?.name || `משתמש ${normalized.slice(0, 8)}`;
    const datasetName = (profile?.name || '').replace(/"/g, '&quot;');
    const datasetBio = (profile?.bio || '').replace(/"/g, '&quot;');
    const datasetPicture = (profile?.picture || '').replace(/"/g, '&quot;');
    const initials =
      profile?.initials ||
      (typeof App.getInitials === 'function' ? App.getInitials(profile?.name || normalized) : 'AN');
    const escapedName = typeof App.escapeHtml === 'function' ? App.escapeHtml(displayName) : displayName;
    const escapedInitials = typeof App.escapeHtml === 'function' ? App.escapeHtml(initials) : initials;
    const nodes = document.querySelectorAll(`[data-profile-link="${normalized}"]`);
    nodes.forEach((node) => {
      if (!(node instanceof HTMLElement)) {
        return;
      }
      node.setAttribute('data-profile-name', datasetName);
      node.setAttribute('data-profile-bio', datasetBio);
      node.setAttribute('data-profile-picture', datasetPicture);
      if (node.classList.contains('feed-post__name')) {
        node.textContent = displayName;
      }
      if (node.classList.contains('feed-post__avatar')) {
        if (profile?.picture) {
          const safePicture = profile.picture.replace(/"/g, '&quot;');
          node.innerHTML = `<img src="${safePicture}" alt="${escapedName}">`;
        } else {
          node.textContent = escapedInitials;
        }
      }
    });
  }
  async function fetchProfile(pubkey) {
    if (!pubkey || pubkey.trim() === '') {
      return {
        name: 'משתמש אנונימי',
        bio: '',
        picture: '',
        initials: 'AN',
      };
    }

    const normalized = pubkey.trim().toLowerCase();
    const storeProfile = (profile) => {
      const normalizedProfile = {
        name: profile?.name || `משתמש ${pubkey.slice(0, 8)}`,
        bio: profile?.bio || '',
        picture: profile?.picture || '',
        initials:
          profile?.initials ||
          (typeof App.getInitials === 'function' ? App.getInitials(profile?.name || pubkey) : 'AN'),
      };
      if (App.profileCache instanceof Map) {
        App.profileCache.set(normalized, normalizedProfile);
        App.profileCache.set(pubkey, normalizedProfile);
      }
      if (App.feedAuthorProfiles instanceof Map) {
        App.feedAuthorProfiles.set(normalized, normalizedProfile);
        App.feedAuthorProfiles.set(pubkey, normalizedProfile);
      }
      if (App.authorProfiles instanceof Map) {
        App.authorProfiles.set(normalized, normalizedProfile);
        App.authorProfiles.set(pubkey, normalizedProfile);
      }
      updateRenderedAuthorProfile(normalized, normalizedProfile);
      return normalizedProfile;
    };

    const cachedProfile =
      (App.profileCache instanceof Map ? App.profileCache.get(normalized) || App.profileCache.get(pubkey) : null) ||
      (App.feedAuthorProfiles instanceof Map ? App.feedAuthorProfiles.get(normalized) : null) ||
      (App.authorProfiles instanceof Map ? App.authorProfiles.get(normalized) : null);
    if (cachedProfile) {
      return storeProfile(cachedProfile);
    }

    const fallback = storeProfile({
      name: `משתמש ${pubkey.slice(0, 8)}`,
      bio: '',
      picture: '',
      initials: typeof App.getInitials === 'function' ? App.getInitials(pubkey) : 'AN',
    });

    if (!App.pool || !Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      return fallback;
    }

    if (!App.profileFetchPromises.has(normalized)) {
      const authorFilters = Array.from(new Set([pubkey, normalized].filter((value) => typeof value === 'string' && value)));
      const fetchPromise = (async () => {
        try {
          const metadataEvent = await App.pool.get(App.relayUrls, { kinds: [0], authors: authorFilters });
          if (metadataEvent?.content) {
            const parsed = JSON.parse(metadataEvent.content);
            const nameField = typeof parsed.display_name === 'string' ? parsed.display_name.trim() : '';
            const name = nameField || (typeof parsed.name === 'string' ? parsed.name.trim() : '') || fallback.name;
            const bio = typeof parsed.about === 'string' ? parsed.about.trim() : '';
            const picture = typeof parsed.picture === 'string' ? parsed.picture.trim() : '';
            storeProfile({
              name,
              bio,
              picture,
              initials:
                typeof App.getInitials === 'function' ? App.getInitials(name || pubkey) : fallback.initials,
            });
          }
        } catch (err) {
          console.warn('Failed to fetch profile metadata for', pubkey, err);
        }
      })();
      fetchPromise.finally(() => {
        App.profileFetchPromises.delete(normalized);
      });
      App.profileFetchPromises.set(normalized, fetchPromise);
    }

    return fallback;
  }

  function getNotificationSnapshot() {
    // חלק התרעות (feed.js) – יוצר צילום מצב בלתי תלוי להרשמות חיצוניות כגון תצוגת הצ'אט
    return Array.isArray(App.notifications)
      ? App.notifications.map((notification) => ({
          id: notification.id,
          type: notification.type,
          postId: notification.postId,
          actorPubkey: notification.actorPubkey,
          createdAt: notification.createdAt,
          content: notification.content,
          read: notification.read,
          actorProfile: notification.actorProfile
            ? {
                name: notification.actorProfile.name || '',
                picture: notification.actorProfile.picture || '',
                initials: notification.actorProfile.initials || '',
              }
            : null,
        }))
      : [];
  }

  function notifyNotificationObservers() {
    // חלק התרעות (feed.js) – מעדכן מנויים חיצוניים (כגון הצ'אט) על שינויי התרעות
    if (!(App.notificationListeners instanceof Set)) {
      return;
    }
    const snapshot = getNotificationSnapshot();
    App.notificationListeners.forEach((callback) => {
      try {
        callback(snapshot);
      } catch (err) {
        console.warn('Notification listener failed', err);
      }
    });
  }

  function getFeedEmptyState() {
    const feed = document.getElementById('feed');
    if (!feed) {
      return { container: null, messageEl: null };
    }
    let container = document.getElementById('empty-state');
    if (!container) {
      container = document.createElement('div');
      container.className = 'feed-empty';
      container.id = 'empty-state';
      container.innerHTML = `
        <i class="fa-regular fa-face-smile"></i>
        <p id="empty-state-message" data-default-text="אין פוסטים עדיין. שתף משהו ראשון!">אין פוסטים עדיין. שתף משהו ראשון!</p>
      `;
    }
    let messageEl = container.querySelector('#empty-state-message');
    if (!messageEl) {
      messageEl = document.createElement('p');
      messageEl.id = 'empty-state-message';
      messageEl.textContent = 'אין פוסטים עדיין. שתף משהו ראשון!';
      messageEl.dataset.defaultText = 'אין פוסטים עדיין. שתף משהו ראשון!';
      container.appendChild(messageEl);
    } else if (!messageEl.dataset.defaultText) {
      messageEl.dataset.defaultText = messageEl.textContent.trim();
    }
    return { container, messageEl };
  }

  function getNotificationStorageKey() {
    // חלק התרעות (feed.js) – מחזיר את מפתח האחסון לפי המפתח הציבורי של המשתמש הנוכחי
    const pubkey = typeof App.publicKey === 'string' ? App.publicKey.toLowerCase() : '';
    if (!pubkey) {
      return null;
    }
    return `nostr_notifications_${pubkey}`;
  }

  function restoreNotificationsFromStorage() {
    // חלק התרעות (feed.js) – משחזר התרעות מהדפדפן כדי לשמור רציפות בין סשנים
    try {
      const storageKey = getNotificationStorageKey();
      if (!storageKey) {
        App.notifications = [];
        App.notificationsById = new Map();
        App.unreadNotificationCount = 0;
        refreshNotificationIndicators();
        return;
      }
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        App.notifications = [];
        App.notificationsById = new Map();
        App.unreadNotificationCount = 0;
        refreshNotificationIndicators();
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        App.notifications = [];
        App.notificationsById = new Map();
        App.unreadNotificationCount = 0;
        refreshNotificationIndicators();
        return;
      }
      const list = [];
      const map = new Map();
      let unread = 0;
      parsed.forEach((item) => {
        if (!item || typeof item.id !== 'string') {
          return;
        }
        const typeValue =
          item.type === 'comment'
            ? 'comment'
            : item.type === 'dating-like'
            ? 'dating-like'
            : 'like';
        const record = {
          id: item.id,
          type: typeValue,
          postId: typeof item.postId === 'string' ? item.postId : '',
          actorPubkey: typeof item.actorPubkey === 'string' ? item.actorPubkey : '',
          createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
          content: typeof item.content === 'string' ? item.content : '',
          read: Boolean(item.read),
          actorProfile: item.actorProfile || null,
        };
        list.push(record);
        map.set(record.id, record);
        if (!record.read) {
          unread += 1;
        }
      });
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      App.notifications = list;
      App.notificationsById = map;
      App.unreadNotificationCount = unread;
    } catch (err) {
      console.warn('Failed to restore notifications', err);
      App.notifications = [];
      App.notificationsById = new Map();
      App.unreadNotificationCount = 0;
    }
    refreshNotificationIndicators();
    notifyNotificationObservers();
  }

  function saveNotificationsToStorage() {
    // חלק התרעות (feed.js) – שומר את מצב ההתרעות ל-localStorage עבור טעינה עתידית
    const storageKey = getNotificationStorageKey();
    if (!storageKey) {
      return;
    }
    try {
      const payload = App.notifications.slice(0, 100).map((notification) => ({
        id: notification.id,
        type: notification.type,
        postId: notification.postId,
        actorPubkey: notification.actorPubkey,
        createdAt: notification.createdAt,
        content: notification.content,
        read: notification.read,
        actorProfile: notification.actorProfile
          ? {
              name: notification.actorProfile.name || '',
              picture: notification.actorProfile.picture || '',
              initials: notification.actorProfile.initials || '',
            }
          : null,
      }));
      window.localStorage.setItem(storageKey, JSON.stringify(payload));
    } catch (err) {
      console.warn('Failed to persist notifications', err);
    }
    notifyNotificationObservers();
  }

  function refreshNotificationIndicators() {
    // חלק התרעות (feed.js) – מחשב מחדש את ספירת ההתרעות שלא נקראו ומרענן את חיווי הפעמון
    if (!Array.isArray(App.notifications)) {
      App.notifications = [];
    }
    App.unreadNotificationCount = App.notifications.reduce((total, notification) => {
      if (!notification || notification.read) {
        return total;
      }
      return total + 1;
    }, 0);
    renderNotificationBadge();
    notifyNotificationObservers();
  }

  function resolvePostOwner(postId) {
    // חלק התרעות (feed.js) – מנסה להשיג את מחבר הפוסט כדי לוודא שההתרעה שייכת למשתמש הנוכחי
    if (!postId) {
      return null;
    }
    const cached = App.eventAuthorById?.get(postId);
    if (typeof cached === 'string' && cached) {
      return cached.toLowerCase();
    }
    if (App.postsById instanceof Map) {
      const postEvent = App.postsById.get(postId);
      if (postEvent?.pubkey) {
        const owner = postEvent.pubkey.toLowerCase();
        App.eventAuthorById?.set?.(postId, owner);
        return owner;
      }
    }
    return null;
  }

  function queuePendingNotification(entry) {
    // חלק התרעות (feed.js) – תור מושהה לאירועים שטרם ברור למי הם שייכים
    if (!entry || !entry.event?.id || !entry.postId || !entry.type) {
      return;
    }
    const key = `${entry.type}:${entry.event.id}`;
    if (App.pendingNotificationSet?.has?.(key)) {
      return;
    }
    App.pendingNotificationSet?.add?.(key);
    App.pendingNotificationQueue?.push?.({ ...entry, key });
  }

  function processPendingNotifications(targetPostId) {
    // חלק התרעות (feed.js) – כשהמידע על פוסט התקבל מעבדים את ההתרעות שהמתינו לו
    if (!Array.isArray(App.pendingNotificationQueue) || App.pendingNotificationQueue.length === 0) {
      return;
    }
    const remaining = [];
    App.pendingNotificationQueue.forEach((entry) => {
      if (targetPostId && entry.postId !== targetPostId) {
        remaining.push(entry);
        return;
      }
      const owner = resolvePostOwner(entry.postId);
      if (!owner) {
        remaining.push(entry);
        return;
      }
      App.pendingNotificationSet?.delete?.(entry.key);
      attemptNotification(entry.event, entry.postId, entry.type, entry.snippet, entry.event?.pubkey, false);
    });
    App.pendingNotificationQueue = remaining;
  }

  function attemptNotification(event, postId, type, snippet, actorPubkey, allowQueue = true) {
    // חלק התרעות (feed.js) – מוודא שהאירוע שייך למשתמש ורק אז יוצר התרעה
    if (!event || !postId || !type) {
      return;
    }
    const current = typeof App.publicKey === 'string' ? App.publicKey.toLowerCase() : '';
    if (!current) {
      return;
    }
    const owner = resolvePostOwner(postId);
    if (!owner) {
      if (allowQueue) {
        queuePendingNotification({ event, postId, type, snippet });
      }
      return;
    }
    if (owner !== current) {
      return;
    }
    if (actorPubkey && actorPubkey.toLowerCase() === current) {
      return;
    }
    enqueueNotification(event, postId, type, snippet);
  }

  function renderNotificationBadge() {
    // חלק התרעות (feed.js) – מעדכן את תצוגת כפתור הפעמון והבאדג' של ספירת ההתרעות
    const toggle = document.getElementById('notificationsToggle');
    const badge = document.getElementById('notificationsBadge');
    const count = App.unreadNotificationCount || 0;
    if (!toggle || !badge) {
      return;
    }
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.removeAttribute('hidden');
      toggle.classList.add('has-unread');
    } else {
      badge.textContent = '';
      if (!badge.hasAttribute('hidden')) {
        badge.setAttribute('hidden', '');
      }
      toggle.classList.remove('has-unread');
    }
  }

  function buildNotificationHtml(notification) {
    // חלק התרעות (feed.js) – בונה HTML לשורה אחת ברשימת ההתרעות
    const profile = notification.actorProfile || {};
    const actorNameRaw = profile.name || notification.actorPubkey?.slice?.(0, 8) || 'משתמש';
    const actorName = App.escapeHtml(actorNameRaw);
    const initials = profile.initials || App.getInitials(actorNameRaw);
    const avatar = profile.picture
      ? `<img src="${profile.picture}" alt="${actorName}">`
      : `<span>${App.escapeHtml(initials)}</span>`;
    let actionText;
    let safeSnippet = '';
    if (notification.type === 'comment') {
      actionText = 'הגיב לפוסט שלך';
      if (notification.content) {
        safeSnippet = `<span class="notifications-item__snippet">${App.escapeHtml(notification.content)}</span>`;
      }
    } else if (notification.type === 'dating-like') {
      actionText = 'הראה עניין בך בדף ההכרויות';
    } else {
      actionText = 'אהב את הפוסט שלך';
    }
    const safeAction = App.escapeHtml(actionText);
    const timeLabel = notification.createdAt ? formatTimestamp(notification.createdAt) : '';
    const timeHtml = timeLabel ? `<time class="notifications-item__time">${timeLabel}</time>` : '';
    const unreadClass = notification.read ? '' : ' notifications-item--unread';
    const postIdAttr = notification.postId ? App.escapeHtml(notification.postId) : '';
    const notificationIdAttr = App.escapeHtml(notification.id);
    return `
      <li class="notifications-item${unreadClass}" data-post-id="${postIdAttr}" data-notification-id="${notificationIdAttr}">
        <div class="notifications-item__avatar">${avatar}</div>
        <div class="notifications-item__content">
          <span class="notifications-item__actor">${actorName}</span>
          <span class="notifications-item__action">${safeAction}</span>
          ${safeSnippet}
          ${timeHtml}
        </div>
      </li>
    `;
  }

  function isPlaceholderProfile(profile, pubkey) {
    if (!profile) {
      return true;
    }
    const name = typeof profile.name === 'string' ? profile.name.trim() : '';
    const picture = typeof profile.picture === 'string' ? profile.picture.trim() : '';
    if (picture) {
      return false;
    }
    if (!name || name === 'משתמש אנונימי') {
      return true;
    }
    const prefix = pubkey ? `משתמש ${pubkey.slice(0, 8)}` : '';
    if (prefix && name === prefix) {
      return true;
    }
    return false;
  }

  function ensureNotificationProfile(notification) {
    // חלק התרעות (feed.js) – מושך פרטי פרופיל לשורת התרעה אם טרם הושלמו
    if (!notification) {
      return;
    }
    const needsRefresh =
      !notification.actorProfile ||
      isPlaceholderProfile(notification.actorProfile, notification.actorPubkey);
    if (!needsRefresh || notification.actorProfileLoading) {
      return;
    }
    if (!notification.actorPubkey) {
      return;
    }
    notification.actorProfileAttempts = (notification.actorProfileAttempts || 0) + 1;
    if (notification.actorProfileAttempts > 3) {
      return;
    }
    notification.actorProfileLoading = true;
    Promise.resolve(
      fetchProfile(notification.actorPubkey).catch((err) => {
        console.warn('Notification profile fetch failed', err);
        return null;
      })
    ).then((profile) => {
      notification.actorProfileLoading = false;
      if (profile) {
        notification.actorProfile = profile;
        saveNotificationsToStorage();
        renderNotificationList();
      }
    });
  }

  function renderNotificationList() {
    // חלק התרעות (feed.js) – מרנדר את רשימת ההתרעות בחלון הנפתח
    const listEl = document.getElementById('notificationsList');
    const emptyEl = document.getElementById('notificationsEmpty');
    if (!listEl || !emptyEl) {
      return;
    }
    if (!Array.isArray(App.notifications) || App.notifications.length === 0) {
      emptyEl.removeAttribute('hidden');
      listEl.innerHTML = '';
      return;
    }
    emptyEl.setAttribute('hidden', '');
    const html = App.notifications.map((notification) => {
      ensureNotificationProfile(notification);
      return buildNotificationHtml(notification);
    });
    listEl.innerHTML = html.join('');
    notifyNotificationObservers();
    Array.from(listEl.querySelectorAll('li[data-post-id]')).forEach((item) => {
      item.addEventListener('click', () => {
        const postId = item.getAttribute('data-post-id');
        const notificationId = item.getAttribute('data-notification-id');
        if (postId) {
          const target = document.querySelector(`[data-post-id="${postId}"]`);
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.classList.add('feed-post--highlight');
            setTimeout(() => target.classList.remove('feed-post--highlight'), 2000);
          }
        }
        if (notificationId && App.notificationsById?.has(notificationId)) {
          const record = App.notificationsById.get(notificationId);
          if (record && !record.read) {
            record.read = true;
            refreshNotificationIndicators();
            saveNotificationsToStorage();
            renderNotificationList();
          }
        }
      });
    });
  }

  function registerNotificationRecord(record, options = {}) {
    // חלק התרעות (feed.js) – מוסיף התרעה חדשה למבנה הנתונים ומעדכן מונים
    if (!record || typeof record.id !== 'string') {
      return false;
    }
    if (App.notificationsById.has(record.id)) {
      return false;
    }
    App.notificationsById.set(record.id, record);
    App.notifications.unshift(record);
    if (App.notifications.length > 100) {
      const removed = App.notifications.pop();
      if (removed?.id) {
        App.notificationsById.delete(removed.id);
      }
    }
    refreshNotificationIndicators();
    if (!options.skipRender) {
      renderNotificationList();
    } else {
      notifyNotificationObservers();
    }
    saveNotificationsToStorage();
    return true;
  }

  function enqueueNotification(event, postId, type, snippet) {
    // חלק התרעות (feed.js) – מוסיף התרעה חדשה בצורה אסינכרונית כדי לא לחסום את ה-UI
    if (!event || !event.id || !type) {
      return;
    }
    Promise.resolve().then(async () => {
      const record = {
        id: event.id,
        type,
        postId,
        actorPubkey: event.pubkey || '',
        createdAt: event.created_at || Math.floor(Date.now() / 1000),
        content: snippet || '',
        read: false,
        actorProfile: null,
      };
      const inserted = registerNotificationRecord(record, { skipRender: true });
      if (!inserted) {
        return;
      }
      try {
        const profile = await fetchProfile(record.actorPubkey);
        if (profile) {
          record.actorProfile = profile;
        }
      } catch (err) {
        console.warn('Notification profile fetch failed', err);
      }
      refreshNotificationIndicators();
      saveNotificationsToStorage();
      renderNotificationList();
    });
  }

  function handleNotificationForLike(event, postId, liker, isUnlike) {
    // חלק התרעות (feed.js) – יוצר התרעה כאשר משתמש אחר עושה לייק לפוסט שלנו
    if (isUnlike) {
      return;
    }
    attemptNotification(event, postId, 'like', '', liker, true);
  }

  function handleNotificationForComment(event, parentId) {
    // חלק התרעות (feed.js) – יוצר התרעה כאשר משתמש אחר מגיב לפוסט שלנו
    const snippet = typeof event.content === 'string'
      ? event.content.replace(/\s+/g, ' ').trim().slice(0, 140)
      : '';
    attemptNotification(event, parentId, 'comment', snippet, event?.pubkey, true);
  }

  function handleNotificationForDatingLike(event) {
    // חלק התרעות הכרויות (feed.js) – יוצר התרעה כאשר משתמש אחר עושה לייק לפרופיל ההכרויות שלנו
    if (!event || event.kind !== DATING_LIKE_KIND) {
      return;
    }
    const current = typeof App.publicKey === 'string' ? App.publicKey.toLowerCase() : '';
    if (!current) {
      return;
    }
    const actor = typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : '';
    if (!actor || actor === current) {
      return;
    }
    if (!Array.isArray(event.tags)) {
      return;
    }
    const targeted = event.tags.some((tag) => Array.isArray(tag) && tag[0] === 'p' && typeof tag[1] === 'string' && tag[1].toLowerCase() === current);
    if (!targeted) {
      return;
    }
    enqueueNotification(event, '', 'dating-like', '');
  }

  function markAllNotificationsRead(force = false) {
    // חלק התרעות (feed.js) – מסמן את כל ההתרעות כנקראו ומעדכן את המונה והאחסון
    if (!Array.isArray(App.notifications) || App.notifications.length === 0) {
      App.unreadNotificationCount = 0;
      renderNotificationBadge();
      return;
    }
    let changed = false;
    App.notifications.forEach((notification) => {
      if (!notification.read) {
        notification.read = true;
        changed = true;
      }
    });
    if (changed || force) {
      refreshNotificationIndicators();
      saveNotificationsToStorage();
      renderNotificationList();
    }
    notifyNotificationObservers();
  }

  function markNotificationRead(notificationId) {
    // חלק התרעות (feed.js) – מסמן התרעה אחת כנקראה לצורך אינטראקציות נקודתיות (למשל מתוך הצ'אט)
    if (!notificationId || !App.notificationsById?.has(notificationId)) {
      return;
    }
    const record = App.notificationsById.get(notificationId);
    if (!record || record.read) {
      return;
    }
    record.read = true;
    refreshNotificationIndicators();
    saveNotificationsToStorage();
    renderNotificationList();
    notifyNotificationObservers();
  }

  function setupNotificationUI() {
    // חלק התרעות (feed.js) – מחבר אירועי UI לכפתור ההתראות ולחלון ההתרעות
    const toggle = document.getElementById('notificationsToggle');
    const panel = document.getElementById('notificationsPanel');
    const markReadButton = document.getElementById('notificationsMarkRead');
    if (!toggle || !panel) {
      return;
    }
    if (App.notificationsUIBound) {
      renderNotificationBadge();
      renderNotificationList();
      return;
    }
    const positionPanel = () => {
      if (panel.hasAttribute('hidden')) {
        return;
      }
      const toggleRect = toggle.getBoundingClientRect();
      const panelWidth = panel.offsetWidth || 320;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const horizontalCenter = toggleRect.left + toggleRect.width / 2 - panelWidth / 2;
      const constrainedLeft = Math.max(8, Math.min(horizontalCenter, viewportWidth - panelWidth - 8));
      panel.style.left = `${constrainedLeft}px`;
      panel.style.top = `${toggleRect.bottom + 8}px`;
    };

    const closePanel = () => {
      if (!panel.hasAttribute('hidden')) {
        panel.setAttribute('hidden', '');
        document.removeEventListener('click', outsideListener, true);
        window.removeEventListener('resize', positionPanel);
      }
    };
    const outsideListener = (event) => {
      if (!panel.contains(event.target) && !toggle.contains(event.target)) {
        closePanel();
      }
    };
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const isHidden = panel.hasAttribute('hidden');
      if (isHidden) {
        if (typeof App.closeChatPanel === 'function') {
          App.closeChatPanel();
        }
        renderNotificationList();
        panel.removeAttribute('hidden');
        positionPanel();
        window.addEventListener('resize', positionPanel);
        markAllNotificationsRead();
        document.addEventListener('click', outsideListener, true);
      } else {
        closePanel();
      }
    });
    if (markReadButton) {
      markReadButton.addEventListener('click', (event) => {
        event.preventDefault();
        markAllNotificationsRead(true);
      });
    }
    panel.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closePanel();
      }
    });
    App.notificationsUIBound = true;
    refreshNotificationIndicators();
    renderNotificationList();
  }

  App.getNotificationsSnapshot = getNotificationSnapshot;
  App.subscribeNotifications = function subscribeNotifications(callback) {
    if (typeof callback !== 'function') {
      return () => {};
    }
    App.notificationListeners.add(callback);
    try {
      callback(getNotificationSnapshot());
    } catch (err) {
      console.warn('Notification immediate dispatch failed', err);
    }
    return () => App.notificationListeners.delete(callback);
  };
  App.markAllNotificationsRead = markAllNotificationsRead;
  App.markNotificationRead = markNotificationRead;

  function removePostElement(eventId) {
    if (!eventId) return;
    const element = document.querySelector(`[data-post-id="${eventId}"]`);
    if (element?.parentElement) {
      element.parentElement.removeChild(element);
    }
  }

  function registerDeletion(event) {
    if (!event || !Array.isArray(event.tags)) {
      return;
    }
    const adminKeys = App.adminPublicKeys || new Set();
    const eventPubkey = typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : '';
    const isAdmin = eventPubkey && adminKeys.has(eventPubkey);
    event.tags.forEach((tag) => {
      if (!Array.isArray(tag)) return;
      const [type, value] = tag;
      if ((type === 'e' || type === 'a') && value) {
        const author = App.eventAuthorById?.get(value)?.toLowerCase?.();
        if (!isAdmin) {
          // חלק פיד (feed.js) – מאפשר מחיקה רק למפרסם המקורי או למנהל מורשה
          if (!author || author !== eventPubkey) {
            return;
          }
        }
        App.deletedEventIds.add(value);
        removePostElement(value);
      }
    });
  }

  function wireShowMore(articleEl, postId) {
    // חלק פיד (feed.js) – מוסיף קיפול טקסט לפוסטים ארוכים עם כפתור הצגה/הסתרה
    if (!articleEl || !postId) {
      return;
    }
    const button = articleEl.querySelector(`button[data-show-more="${postId}"]`);
    const contentEl = articleEl.querySelector(`[data-post-content="${postId}"]`);
    if (!button || !contentEl) {
      return;
    }
    button.addEventListener('click', () => {
      const expanded = contentEl.classList.toggle('feed-post__content--expanded');
      if (expanded) {
        contentEl.classList.remove('feed-post__content--collapsed');
        button.textContent = 'הצג פחות';
        button.setAttribute('aria-expanded', 'true');
      } else {
        contentEl.classList.add('feed-post__content--collapsed');
        button.textContent = 'הצג עוד';
        button.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function registerLike(event) {
    if (!event || event.kind !== 7 || !Array.isArray(event.tags)) {
      return;
    }

    const liker = typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : null;
    const isUnlike = typeof event.content === 'string' && event.content.trim() === '-';
    const targetIds = new Set();

    event.tags.forEach((tag) => {
      if (!Array.isArray(tag)) return;
      const [type, value] = tag;
      if ((type === 'e' || type === 'a') && value) {
        targetIds.add(value);
      }
    });

    if (!targetIds.size) {
      return;
    }

    targetIds.forEach((eventId) => {
      if (!App.likesByEventId.has(eventId)) {
        App.likesByEventId.set(eventId, new Set());
      }
      const likeSet = App.likesByEventId.get(eventId);
      if (liker) {
        if (isUnlike) {
          likeSet.delete(liker);
        } else {
          likeSet.add(liker);
        }
      }
      updateLikeIndicator(eventId);
      handleNotificationForLike(event, eventId, liker, isUnlike);
    });
  }

  function updateLikeIndicator(eventId) {
    if (!eventId) return;
    const button = document.querySelector(`button[data-like-button][data-event-id="${eventId}"]`);
    if (!button) return;

    const likeSet = App.likesByEventId.get(eventId);
    const count = likeSet ? likeSet.size : 0;
    const counterEl = button.querySelector('.feed-post__like-count');
    if (counterEl) {
      if (count > 0) {
        counterEl.textContent = String(count);
        counterEl.style.display = '';
      } else {
        counterEl.textContent = '';
        counterEl.style.display = 'none';
      }
    }

    const currentUser = typeof App.publicKey === 'string' ? App.publicKey.toLowerCase() : '';
    if (currentUser && likeSet && likeSet.has(currentUser)) {
      button.classList.add('feed-post__action--liked');
    } else {
      button.classList.remove('feed-post__action--liked');
    }
  }

  function extractParentId(event) {
    // חלק פיד (feed.js) – שולף מזהה פוסט הורה מתגיות אירוע kind 1 כדי לזהות תגובות
    if (!event || !Array.isArray(event.tags)) {
      return null;
    }
    let fallback = null;
    for (const tag of event.tags) {
      if (!Array.isArray(tag)) continue;
      if (tag[0] === 'e' && typeof tag[1] === 'string') {
        const marker = tag[3];
        if (marker === 'root') {
          return tag[1];
        }
        if (!fallback) {
          fallback = tag[1];
        }
      }
    }
    return fallback;
  }

  function registerComment(event, parentId) {
    // חלק פיד (feed.js) – מוסיף תגובה למאגר המקומי ומעדכן את ה-UI של הפוסט
    if (!event || !parentId) {
      return;
    }
    if (!App.commentsByParent.has(parentId)) {
      App.commentsByParent.set(parentId, new Map());
    }
    const commentMap = App.commentsByParent.get(parentId);
    if (!commentMap.has(event.id)) {
      commentMap.set(event.id, event);
    } else {
      commentMap.set(event.id, event);
    }
    if (event?.id && event?.pubkey) {
      App.eventAuthorById.set(event.id, event.pubkey.toLowerCase());
    }
    updateCommentsForParent(parentId);
    handleNotificationForComment(event, parentId);
  }

  async function updateCommentsForParent(parentId) {
    // חלק פיד (feed.js) – מרנדר מחדש את רשימת התגובות עבור פוסט מסוים
    if (!parentId) return;
    const listEl = document.querySelector(`.feed-comments__list[data-comments-list="${parentId}"]`);
    const counterEl = document.querySelector(`.feed-post__comment-count[data-comment-count="${parentId}"]`);
    if (!listEl) {
      return;
    }

    const commentMap = App.commentsByParent.get(parentId);
    const comments = commentMap ? Array.from(commentMap.values()) : [];
    comments.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

    if (counterEl) {
      if (comments.length > 0) {
        counterEl.textContent = String(comments.length);
        counterEl.style.display = '';
      } else {
        counterEl.textContent = '';
        counterEl.style.display = 'none';
      }
    }

    if (!comments.length) {
      listEl.innerHTML = '<p class="feed-comments__empty">אין תגובות עדיין. היה הראשון להגיב!</p>';
      return;
    }

    const fragments = [];
    for (const comment of comments) {
      // eslint-disable-next-line no-await-in-loop
      const commenterProfile = await fetchProfile(comment.pubkey);
      const commenterName = App.escapeHtml(commenterProfile.name || 'משתמש');
      const commenterAvatar = commenterProfile.picture
        ? `<img src="${commenterProfile.picture}" alt="${commenterName}">`
        : `<span>${commenterProfile.initials}</span>`;
      const safeContent = App.escapeHtml(comment.content || '').replace(/\n/g, '<br>');
      const timestamp = comment.created_at ? formatTimestamp(comment.created_at) : '';
      fragments.push(`
        <article class="feed-comment">
          <div class="feed-comment__avatar">${commenterAvatar}</div>
          <div class="feed-comment__body">
            <header class="feed-comment__header">
              <span class="feed-comment__author">${commenterName}</span>
              ${timestamp ? `<time class="feed-comment__time">${timestamp}</time>` : ''}
            </header>
            <div class="feed-comment__text">${safeContent}</div>
          </div>
        </article>
      `);
    }
    listEl.innerHTML = fragments.join('');
  }

  function wireCommentForm(articleEl, parentId) {
    // חלק פיד (feed.js) – מחבר את טופס התגובות לפונקציית הפרסום
    if (!articleEl || !parentId) {
      return;
    }
    const form = articleEl.querySelector(`form.feed-comments__form[data-comment-form="${parentId}"]`);
    if (!form) {
      return;
    }
    const textarea = form.querySelector('textarea');
    form.addEventListener('submit', async (evt) => {
      evt.preventDefault();
      if (!textarea) {
        return;
      }
      const content = textarea.value.trim();
      if (!content) {
        return;
      }
      textarea.disabled = true;
      try {
        await postComment(parentId, content);
        textarea.value = '';
      } catch (err) {
        console.error('Comment publish error', err);
      } finally {
        textarea.disabled = false;
        textarea.focus();
      }
    });
  }

  function renderDemoPosts(feed) {
    if (!feed) return;
    const demo = [
      {
        content: 'ברוכים הבאים לפיד המבוזר. זהו פוסט הדגמה בלבד.',
        name: 'משתמש הדגמה',
        created_at: Math.floor(Date.now() / 1000) - 3600,
      },
      {
        content: 'שלחו את הרשת הזו לשני מחשבים שונים ותראו את הקסם של Nostr.',
        name: 'קהילת Nostr',
        created_at: Math.floor(Date.now() / 1000) - 7200,
      },
    ];

    demo.forEach((item) => {
      const article = document.createElement('article');
      article.className = 'feed-post';
      article.innerHTML = `
        <header class="feed-post__header">
          <div class="feed-post__avatar">${App.getInitials(item.name)}</div>
          <div class="feed-post__info">
            <span class="feed-post__name">${App.escapeHtml(item.name)}</span>
            <span class="feed-post__meta">${formatTimestamp(item.created_at)}</span>
          </div>
        </header>
        <div class="feed-post__content">${App.escapeHtml(item.content)}</div>
        <div class="feed-post__actions">
          <button class="feed-post__action" type="button">
            <i class="fa-regular fa-thumbs-up"></i>
            <span>אהבתי</span>
          </button>
          <button class="feed-post__action" type="button">
            <i class="fa-solid fa-share"></i>
            <span>שתף</span>
          </button>
        </div>
      `;
      feed.appendChild(article);
    });
  }

  function formatTimestamp(seconds) {
    if (!seconds) return '';
    const date = new Date(seconds * 1000);
    try {
      return date.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
    } catch (err) {
      return date.toLocaleString();
    }
  }

  function parseYouTube(link) {
    if (!link) return null;
    const shortMatch = link.match(/^https?:\/\/youtu\.be\/([\w-]{11})(?:\?.*)?$/i);
    if (shortMatch) {
      return shortMatch[1];
    }
    const longMatch = link.match(/^https?:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})(?:&.*)?$/i);
    if (longMatch) {
      return longMatch[1];
    }
    const embedMatch = link.match(/^https?:\/\/www\.youtube\.com\/embed\/([\w-]{11})(?:\?.*)?$/i);
    if (embedMatch) {
      return embedMatch[1];
    }
    return null;
  }

  function createMediaHtml(links = []) {
    if (!Array.isArray(links) || links.length === 0) {
      return '';
    }

    return links
      .map((link) => {
        if (!link) return '';

        const youtubeId = parseYouTube(link);
        if (youtubeId) {
          const thumbUrl = `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
          return `
            <div class="feed-media feed-media--youtube" data-youtube-id="${youtubeId}">
              <img class="feed-media__thumb" src="${thumbUrl}" alt="תצוגה מקדימה של YouTube">
              <span class="feed-media__play"><i class="fa-solid fa-play"></i></span>
            </div>
          `;
        }

        if (link.startsWith('data:image') || /\.(png|jpe?g|gif|webp|avif)$/i.test(link.split('?')[0])) {
          return `<div class="feed-media"><img src="${link}" alt="תמונה מצורפת"></div>`;
        }

        if (link.startsWith('data:video') || /\.(mp4|webm|ogg)$/i.test(link)) {
          return `<div class="feed-media"><video src="${link}" controls playsinline></video></div>`;
        }

        if (/^https?:\/\//i.test(link)) {
          if (link.match(/\.(mp4|webm|ogg)$/i)) {
            return `<div class="feed-media"><video src="${link}" controls playsinline></video></div>`;
          }
          const pathWithoutQuery = link.split('?')[0];
          if (pathWithoutQuery.match(/\.(png|jpe?g|gif|webp|avif)$/i)) {
            return `<div class="feed-media"><img src="${link}" alt="תמונה מצורפת"></div>`;
          }
          // חלק פיד (feed.js) – קישורים חיצוניים ללא סיומת תמונה/וידאו מוצגים כקישור בלבד כדי למנוע שגיאות טעינה
          let displayLabel = link;
          try {
            const parsed = new URL(link);
            displayLabel = `${parsed.hostname}${parsed.pathname}` || link;
          } catch (err) {
            // חלק פיד (feed.js) – במקרה של קישור לא חוקי נשאיר את הכתובת המקורית בלי קריסה
            console.warn('External link formatting failed', err);
          }
          if (displayLabel.length > 60) {
            displayLabel = `${displayLabel.slice(0, 57)}...`;
          }
          const safeLabel = typeof App.escapeHtml === 'function' ? App.escapeHtml(displayLabel) : displayLabel;
          return `<div class="feed-media feed-media--link"><a href="${link}" target="_blank" rel="noopener noreferrer">${safeLabel}</a></div>`;
        }

        return '';
      })
      .filter(Boolean)
      .join('');
  }

  async function displayPosts(events) {
    const feed = document.getElementById('feed');
    if (!feed) return;

    const { container: emptyState, messageEl: emptyMessage } = getFeedEmptyState();

    feed.innerHTML = '';

    events.sort((a, b) => b.created_at - a.created_at);

    const deletions = App.deletedEventIds || new Set();
    const visibleEvents = events.filter((event) => !deletions.has(event.id));

    if (!visibleEvents.length) {
      if (emptyState) {
        if (emptyMessage?.dataset?.defaultText) {
          emptyMessage.textContent = emptyMessage.dataset.defaultText;
        }
        emptyState.classList.remove('feed-empty--loading');
        emptyState.removeAttribute('hidden');
        feed.appendChild(emptyState);
      } else {
        renderDemoPosts(feed);
      }
      return;
    }

    if (emptyState) {
      emptyState.classList.remove('feed-empty--loading');
    }

    const isAdminUser =
      App.adminPublicKeys instanceof Set && typeof App.publicKey === 'string'
        ? App.adminPublicKeys.has(App.publicKey.toLowerCase())
        : false;

    const profileList = await Promise.all(visibleEvents.map((event) => fetchProfile(event.pubkey)));

    visibleEvents.forEach((event, index) => {
      const normalizedPubkey = typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : '';
      const profileData = profileList[index] || {
        name: `משתמש ${normalizedPubkey.slice(0, 8)}`,
        bio: '',
        picture: '',
        initials: typeof App.getInitials === 'function' ? App.getInitials(normalizedPubkey) : 'AN',
      };
      if (event?.id && normalizedPubkey) {
        App.eventAuthorById.set(event.id, normalizedPubkey);
        if (!App.feedAuthorProfiles.has(normalizedPubkey)) {
          App.feedAuthorProfiles.set(normalizedPubkey, {
            name: profileData.name,
            picture: profileData.picture,
            bio: profileData.bio,
            initials: profileData.initials,
          });
        }
      }
      App.postsById.set(event.id, event); // חלק התרעות (feed.js) – שומר את אירוע הפוסט במפה לשימוש בהתרעות
      processPendingNotifications(event.id); // חלק התרעות (feed.js) – מנסה לשחרר התרעות מושהות עבור הפוסט הזה
      const safeName = App.escapeHtml(profileData.name || '');
      const safeBio = profileData.bio ? App.escapeHtml(profileData.bio) : '';
      const article = document.createElement('article');
      article.className = 'feed-post';
      article.dataset.postId = event.id;
      const lines = event.content.split('\n');
      const mediaLinks = [];
      const textLines = [];

      lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:image') || trimmed.startsWith('data:video')) {
          mediaLinks.push(trimmed);
        } else {
          textLines.push(trimmed);
        }
      });

      const rawTextContent = textLines.join('\n');
      const safeContent = App.escapeHtml(rawTextContent).replace(/\n/g, '<br>');
      const isLongPost = textLines.length > 6 || rawTextContent.length > 420;
      const contentClass = isLongPost
        ? 'feed-post__content feed-post__content--collapsed'
        : 'feed-post__content';
      const showMoreHtml = isLongPost
        ? `
          <button class="feed-post__show-more" type="button" data-show-more="${event.id}" aria-expanded="false">
            הצג עוד
          </button>
        `
        : '';
      const mediaHtml = createMediaHtml(mediaLinks);
      const metaParts = [];
      if (safeBio) {
        metaParts.push(safeBio);
      }
      if (event.created_at) {
        metaParts.push(formatTimestamp(event.created_at));
      }
      const metaHtml = metaParts.join(' • ');

      const attrName = (profileData.name || '').replace(/"/g, '&quot;');
      const attrBio = (profileData.bio || '').replace(/"/g, '&quot;');
      const attrPicture = (profileData.picture || '').replace(/"/g, '&quot;');
      const profileDataset = `data-profile-link="${normalizedPubkey || event.pubkey}" data-profile-name="${attrName}" data-profile-bio="${attrBio}" data-profile-picture="${attrPicture}"`;
      const viewerPubkeyLower = typeof App.publicKey === 'string' ? App.publicKey.toLowerCase() : '';
      // חלק עוקבים (feed.js) – יוצר כפתור עקוב בהאדר של פוסט עבור משתמשים אחרים בלבד
      const followButtonHtml = normalizedPubkey && normalizedPubkey !== viewerPubkeyLower
        ? `
          <button class="feed-post__follow-button" type="button" data-follow-button="${normalizedPubkey}" data-follow-name="${attrName}" data-follow-picture="${attrPicture}">
            <i class="fa-solid fa-user-plus"></i>
            <span data-follow-label>עקוב</span>
          </button>
        `
        : '';

      const likeCount = App.likesByEventId.get(event.id)?.size || 0;
      const ownPost = event.pubkey === App.publicKey;
      const canDelete = ownPost || isAdminUser;
      const deleteButtonHtml = canDelete
        ? `
          <button class="feed-post__action feed-post__action--delete" type="button" onclick="NostrApp.deletePost('${event.id}')">
            <i class="fa-solid fa-trash"></i>
            <span>מחק</span>
          </button>
        `
        : '';
      if (!App.commentsByParent.has(event.id)) {
        App.commentsByParent.set(event.id, new Map());
      }
      const commentCount = App.commentsByParent.get(event.id)?.size || 0;
      const viewerProfile = App.profile || {};
      const viewerName = viewerProfile.name || 'אני';
      const viewerInitials = typeof App.getInitials === 'function' ? App.getInitials(viewerName) : viewerName.slice(0, 2).toUpperCase();
      const viewerAvatar = viewerProfile.picture
        ? `<img src="${viewerProfile.picture}" alt="${App.escapeHtml(viewerName)}">`
        : `<span>${App.escapeHtml(viewerInitials)}</span>`;

      const avatar = profileData.picture
        ? `<button class="feed-post__avatar" type="button" ${profileDataset}><img src="${profileData.picture}" alt="${safeName}"></button>`
        : `<button class="feed-post__avatar" type="button" ${profileDataset}>${profileData.initials}</button>`;

      article.innerHTML = `
        <header class="feed-post__header">
          ${avatar}
          <div class="feed-post__info">
            <button class="feed-post__name" type="button" ${profileDataset}>${safeName}</button>
            ${metaHtml ? `<span class="feed-post__meta">${metaHtml}</span>` : ''}
          </div>
          ${followButtonHtml}
        </header>
        ${safeContent ? `<div class="${contentClass}" data-post-content="${event.id}">${safeContent}</div>` : ''}
        ${showMoreHtml}
        ${mediaHtml ? `<div class="feed-post__media">${mediaHtml}</div>` : ''}
        <footer class="feed-post__stats">
          <span class="feed-post__likes" data-like-total="${event.id}">
            <i class="fa-solid fa-thumbs-up"></i>
            <span class="feed-post__like-counter" data-like-counter="${event.id}">${likeCount || ''}</span>
          </span>
          <button class="feed-post__comments-toggle" type="button" data-comments-toggle="${event.id}">
            <i class="fa-regular fa-message"></i>
            <span>תגובות</span>
            <span class="feed-post__comment-count" data-comment-count="${event.id}" ${commentCount ? '' : 'style="display:none;"'}>${
              commentCount || ''
            }</span>
          </button>
        </footer>
        <div class="feed-post__actions">
          <button class="feed-post__action" type="button" data-like-button data-event-id="${event.id}" onclick="NostrApp.likePost('${event.id}')">
            <i class="fa-regular fa-thumbs-up"></i>
            <span>אהבתי</span>
            <span class="feed-post__like-count" ${likeCount ? '' : 'style="display:none;"'}>${likeCount || ''}</span>
          </button>
          <button class="feed-post__action" type="button" onclick="NostrApp.sharePost('${event.id}')">
            <i class="fa-solid fa-share"></i>
            <span>שתף</span>
          </button>
          ${deleteButtonHtml}
        </div>
        <section class="feed-comments" data-comments-section="${event.id}" hidden>
          <div class="feed-comments__list" data-comments-list="${event.id}"></div>
          <form class="feed-comments__form" data-comment-form="${event.id}">
            <div class="feed-comments__composer">
              <div class="feed-comments__avatar">${viewerAvatar}</div>
              <div class="feed-comments__input">
                <textarea rows="2" placeholder="כתוב תגובה..." required></textarea>
                <!-- חלק תגובות (feed.js) – כפתור שליחה בתוך קפסולה פנימית בסגנון פייסבוק -->
                <button class="feed-comments__submit" type="submit" aria-label="שלח תגובה">
                  <i class="fa-solid fa-paper-plane"></i>
                </button>
              </div>
            </div>
          </form>
        </section>
      `;

      feed.appendChild(article);
      updateLikeIndicator(event.id);
      wireCommentForm(article, event.id);
      hydrateCommentsSection(article, event.id);
      wireShowMore(article, event.id);
      if (typeof App.refreshFollowButtons === 'function') {
        App.refreshFollowButtons(article);
      }
    });
  }

  async function hydrateCommentsSection(articleEl, parentId) {
    // חלק פיד (feed.js) – מציג תגובות קיימות ומחבר כפתור הצגה/הסתרה
    if (!articleEl || !parentId) {
      return;
    }
    const toggle = articleEl.querySelector(`button[data-comments-toggle="${parentId}"]`);
    const section = articleEl.querySelector(`section[data-comments-section="${parentId}"]`);
    if (!toggle || !section) {
      return;
    }
    toggle.addEventListener('click', () => {
      const isHidden = section.hasAttribute('hidden');
      if (isHidden) {
        section.removeAttribute('hidden');
        updateCommentsForParent(parentId);
      } else {
        section.setAttribute('hidden', '');
      }
    });
    if (App.commentsByParent.get(parentId)?.size) {
      updateCommentsForParent(parentId);
      section.removeAttribute('hidden');
    }
  }

  async function postComment(parentId, content) {
    // חלק פיד (feed.js) – מפרסם תגובת kind 1 עם תגיות root/commit כדי שכל הרשת תראה אותה
    if (!parentId || !content || !App.publicKey || !App.privateKey || !App.pool) {
      throw new Error('Missing required context for posting comment');
    }

    const now = Math.floor(Date.now() / 1000);
    const draft = {
      kind: 1,
      pubkey: App.publicKey,
      created_at: now,
      tags: [
        ['e', parentId, App.relayUrls?.[0] || '', 'root'],
        ['e', parentId, App.relayUrls?.[0] || '', 'reply'],
        ['t', App.NETWORK_TAG],
      ],
      content,
    };
    const event = App.finalizeEvent(draft, App.privateKey);
    await App.pool.publish(App.relayUrls, event);
    registerComment(event, parentId);
  }

  async function loadFeed() {
    if (!App.pool) return;

    const feed = document.getElementById('feed');
    const { container: emptyState, messageEl: emptyMessage } = getFeedEmptyState();
    if (feed && emptyState) {
      feed.innerHTML = '';
      if (emptyMessage) {
        emptyMessage.textContent = 'מעדכן פוסטים אנא המתינו';
      }
      emptyState.classList.add('feed-empty--loading');
      emptyState.removeAttribute('hidden');
      feed.appendChild(emptyState);
    }

    if (!App.notificationsRestored && typeof App.publicKey === 'string' && App.publicKey) {
      restoreNotificationsFromStorage();
      App.notificationsRestored = true;
    }
    setupNotificationUI();
    const statusEl = document.getElementById('connection-status');
    if (statusEl) {
      statusEl.textContent = '';
      statusEl.style.opacity = '0';
    }
    App.deletedEventIds = new Set();
    App.likesByEventId = new Map();
    App.commentsByParent = new Map();
    const filters = [{ kinds: [1], '#t': [App.NETWORK_TAG], limit: 50 }];
    const deletionAuthors = new Set();
    if (typeof App.publicKey === 'string' && App.publicKey) {
      deletionAuthors.add(App.publicKey.toLowerCase());
    }
    if (App.adminPublicKeys instanceof Set) {
      App.adminPublicKeys.forEach((key) => {
        if (typeof key === 'string' && key) {
          deletionAuthors.add(key.toLowerCase());
        }
      });
    }
    if (deletionAuthors.size > 0) {
      filters.push({ kinds: [5], authors: Array.from(deletionAuthors), limit: 200 });
    } else {
      filters.push({ kinds: [5], '#t': [App.NETWORK_TAG], limit: 200 });
    }
    filters.push({ kinds: [7], '#t': [App.NETWORK_TAG], limit: 500 });
    if (typeof App.publicKey === 'string' && App.publicKey) {
      const datingFilter = { kinds: [DATING_LIKE_KIND], '#p': [App.publicKey], limit: 200 };
      if (App.NETWORK_TAG) {
        datingFilter['#t'] = [App.NETWORK_TAG];
      }
      filters.push(datingFilter);
    }
    const events = [];

    const sub = App.pool.subscribeMany(App.relayUrls, filters, {
      onevent: (event) => {
        if (event.kind === 1) {
          const parentId = extractParentId(event);
          if (parentId) {
            registerComment(event, parentId);
          } else {
            events.push(event);
          }
          return;
        }
        if (event.kind === 5) {
          registerDeletion(event);
          return;
        }
        if (event.kind === 7) {
          registerLike(event);
          return;
        }
        if (event.kind === DATING_LIKE_KIND) {
          handleNotificationForDatingLike(event);
          return;
        }
        events.push(event);
        console.log('Received event:', event);
        if (emptyState && emptyMessage) {
          emptyMessage.textContent = `מעדכן פוסטים... התקבלו ${events.length} פוסטים`;
        }
      },
      oneose: () => {
        displayPosts(events);
        if (emptyState && emptyMessage?.dataset?.defaultText) {
          emptyMessage.textContent = emptyMessage.dataset.defaultText;
          emptyState.classList.remove('feed-empty--loading');
        }
      },
    });

    setTimeout(() => sub.close(), 5000);
  }

  async function publishPost() {
    if (typeof App.getComposePayload !== 'function') {
      console.warn('Compose payload helper missing');
      return;
    }

    const payload = App.getComposePayload();
    if (!payload) {
      return;
    }

    document.getElementById('connection-status').textContent = 'מפרסם פוסט...';
    App.setComposeStatus?.('מפרסם את הפוסט...');

    const draft = {
      kind: 1,
      pubkey: App.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', App.NETWORK_TAG]],
      content: payload.content,
    };
    const event = App.finalizeEvent(draft, App.privateKey);

    try {
      await App.pool.publish(App.relayUrls, event);
      console.log('Published event');
      document.getElementById('connection-status').textContent = 'הפוסט פורסם!';
      App.setComposeStatus?.('הפוסט פורסם בהצלחה.');
    } catch (e) {
      console.error('Publish error', e);
      document.getElementById('connection-status').textContent = 'הפרסום נכשל. נסה שוב.';
      App.setComposeStatus?.('שגיאה בפרסום. נסה שוב מאוחר יותר.', 'error');
      return;
    }

    App.resetCompose?.();
    App.closeCompose?.();
    loadFeed();
  }

  async function likePost(eventId) {
    const draft = {
      kind: 7,
      pubkey: App.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['e', eventId], ['t', App.NETWORK_TAG]],
      content: '+',
    };
    const event = App.finalizeEvent(draft, App.privateKey);

    try {
      await App.pool.publish(App.relayUrls, event);
      console.log('Liked event');
      registerLike(event);
    } catch (e) {
      console.error('Like publish error', e);
    }
  }

  async function sharePost(eventId) {
    const draft = {
      kind: 6,
      pubkey: App.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['e', eventId], ['t', App.NETWORK_TAG]],
      content: '',
    };
    const event = App.finalizeEvent(draft, App.privateKey);

    try {
      await App.pool.publish(App.relayUrls, event);
      console.log('Shared event');
    } catch (e) {
      console.error('Share publish error', e);
    }
  }

  async function deletePost(eventId) {
    if (!eventId) {
      return;
    }
    if (!App.pool || typeof App.finalizeEvent !== 'function') {
      console.warn('Pool or finalizeEvent unavailable for deletion');
      return;
    }

    const confirmed = window.confirm('למחוק את הפוסט? פעולה זו אינה ניתנת לשחזור.');
    if (!confirmed) {
      return;
    }

    const draft = {
      kind: 5,
      pubkey: App.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['e', eventId],
        ['t', App.NETWORK_TAG],
      ],
      content: '',
    };
    const event = App.finalizeEvent(draft, App.privateKey);

    try {
      await App.pool.publish(App.relayUrls, event);
      console.log('Deleted event');
      App.deletedEventIds.add(eventId);
      removePostElement(eventId);
    } catch (e) {
      console.error('Delete publish error', e);
    }
  }

  window.NostrApp = Object.assign(App, {
    fetchProfile,
    renderDemoPosts,
    displayPosts,
    loadFeed,
    publishPost,
    likePost,
    sharePost,
    deletePost,
    parseYouTube,
    createMediaHtml,
    
    
    
    registerDeletion,
    registerLike,
    updateLikeIndicator,
    removePostElement,
  });
})(window);
