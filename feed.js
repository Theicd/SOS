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
  App.commentLastSyncTs = typeof App.commentLastSyncTs === 'number' ? App.commentLastSyncTs : 0; // חלק תגובות (feed.js) – חותמת סנכרון אחרונה לדלתא | HYPER CORE TECH
  if (typeof App.notificationsRestored !== 'boolean') {
    App.notificationsRestored = false; // חלק התרעות (feed.js) – מבטיח שנשחזר התרעות פעם אחת לאחר התחברות
  }
  // חלק שמירת state (feed.js) – שמירה על state של הפיד בין עמודים
  if (typeof App._homeFeedFirstBatchShown !== 'boolean') {
    App._homeFeedFirstBatchShown = false;
  }

  // חלק פרופילי מגיבים (feed.js) – TTL לאווטארים ופרופילים למניעת פניות חוזרות לריליי | HYPER CORE TECH
  const AVATAR_CACHE_TTL_SECONDS = 86400;
  function profileCacheKey(url) {
    return url ? `avatar_cache_${btoa(url)}` : null;
  }
  function getCachedAvatar(url) {
    const key = profileCacheKey(url);
    if (!key) return '';
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return '';
      const parsed = JSON.parse(raw);
      const nowSec = Math.floor(Date.now() / 1000);
      if (!parsed?.dataUrl || !parsed?.ts || (nowSec - parsed.ts) > AVATAR_CACHE_TTL_SECONDS) {
        return '';
      }
      return parsed.dataUrl;
    } catch (_e) {
      return '';
    }
  }
  async function cacheAvatar(url) {
    const key = profileCacheKey(url);
    if (!key) return '';
    const cached = getCachedAvatar(url);
    if (cached) return cached;
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) return '';
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result || '');
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      if (dataUrl) {
        window.localStorage.setItem(key, JSON.stringify({ dataUrl, ts: Math.floor(Date.now() / 1000) }));
      }
      return dataUrl;
    } catch (_e) {
      return '';
    }
  }
  async function fetchProfileWithAvatarCache(pubkey) {
    const profile = await fetchProfile(pubkey);
    if (profile?.picture) {
      const cached = await cacheAvatar(profile.picture);
      if (cached) {
        profile.picture = cached;
      }
    }
    return profile;
  }

  // חלק תגובות (feed.js) – קאש תגובות + lastSyncTs ב-localStorage | HYPER CORE TECH
  function getCommentStorageKey() {
    const pk = typeof App.publicKey === 'string' ? App.publicKey.toLowerCase() : '';
    return pk ? `nostr_comments_${pk}` : null;
  }
  function restoreCommentsFromStorage() {
    const key = getCommentStorageKey();
    if (!key) return;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const byParent = parsed?.commentsByParent || {};
      const syncTs = parsed?.lastSyncTs || 0;
      Object.keys(byParent).forEach((parentId) => {
        const arr = Array.isArray(byParent[parentId]) ? byParent[parentId] : [];
        const map = new Map();
        arr.forEach((c) => {
          if (c?.id) {
            map.set(c.id, c);
            if (typeof c.created_at === 'number' && c.created_at > App.commentLastSyncTs) {
              App.commentLastSyncTs = c.created_at;
            }
          }
        });
        App.commentsByParent.set(parentId, map);
      });
      if (typeof syncTs === 'number' && syncTs > App.commentLastSyncTs) {
        App.commentLastSyncTs = syncTs;
      }
    } catch (err) {
      console.warn('Restore comments cache failed', err);
    }
  }
  function saveCommentsToStorage() {
    const key = getCommentStorageKey();
    if (!key) return;
    const payload = { commentsByParent: {}, lastSyncTs: App.commentLastSyncTs || 0 };
    App.commentsByParent.forEach((map, parentId) => {
      if (!parentId || !(map instanceof Map)) return;
      const arr = Array.from(map.values())
        .sort((a, b) => (a.created_at || 0) - (b.created_at || 0)); // חלק תגובות – אין חיתוך היסטוריה, שומרים הכול לפי זמן
      payload.commentsByParent[parentId] = arr;
    });
    try {
      window.localStorage.setItem(key, JSON.stringify(payload));
    } catch (err) {
      console.warn('Persist comments cache failed', err);
    }
  }

  // חלק התרעות (feed.js) – גשר ל-notifications-state.js כדי להשתמש בקאש + lastSyncTs | HYPER CORE TECH
  function syncNotificationsFromState(snapshot) {
    const records = Array.isArray(snapshot) ? snapshot.slice() : [];
    const map = new Map();
    let unread = 0;
    records.forEach((item) => {
      if (!item?.id) return;
      map.set(item.id, item);
      if (!item.read) unread += 1;
    });
    App.notifications = records;
    App.notificationsById = map;
    App.unreadNotificationCount = unread;
    refreshNotificationIndicators();
  }

  (function initNotificationsStateBridge() {
    if (typeof App.getNotificationsSnapshot !== 'function' || typeof App.subscribeNotifications !== 'function') {
      return;
    }
    try {
      const snap = App.getNotificationsSnapshot();
      syncNotificationsFromState(snap);
    } catch (err) {
      console.warn('Notifications bridge init failed (snapshot)', err);
    }
    try {
      App._notificationsStateUnsub = App.subscribeNotifications((snapshot) => {
        syncNotificationsFromState(snapshot);
        renderNotificationList();
      });
    } catch (err) {
      console.warn('Notifications bridge subscribe failed', err);
    }
  })();

  // חלק מובייל (feed.js) – התאמות פריסת כפתורי פעולה ותגובות בסגנון פייסבוק
  function applyMobilePostUiStyles() {
    try {
      const isMobile = (window.innerWidth || document.documentElement.clientWidth) <= 768;
      const actionBars = document.querySelectorAll('.feed-post__actions');
      actionBars.forEach((bar) => {
        if (isMobile) {
          bar.style.display = 'grid';
          bar.style.gridTemplateColumns = '1fr 1fr 1fr';
          bar.style.alignItems = 'center';
          bar.style.gap = '0px';
          bar.style.borderTop = '1px solid rgba(255,255,255,0.06)';
          bar.style.borderBottom = '1px solid rgba(255,255,255,0.06)';
          bar.style.padding = '4px 0';
          Array.from(bar.children).forEach((btn) => {
            if (!(btn instanceof HTMLElement)) return;
            btn.style.justifyContent = 'center';
            btn.style.width = '100%';
            btn.style.borderRadius = '0';
            btn.style.padding = '10px 0';
            const icon = btn.querySelector('i');
            if (icon) { icon.style.fontSize = '1.05rem'; }
            const count = btn.querySelector('.feed-post__like-count, .feed-post__comment-count');
            if (count) { count.style.marginInlineStart = '6px'; count.style.opacity = '0.9'; }
          });
        } else {
          // ניקוי סגנונות אינליין בדסקטופ
          bar.removeAttribute('style');
          Array.from(bar.children).forEach((btn) => {
            if (!(btn instanceof HTMLElement)) return;
            btn.removeAttribute('style');
            const icon = btn.querySelector('i');
            if (icon) { icon.style.fontSize = ''; }
            const count = btn.querySelector('.feed-post__like-count, .feed-post__comment-count');
            if (count) { count.style.marginInlineStart = ''; count.style.opacity = ''; }
          });
        }
      });

      const commentItems = document.querySelectorAll('.feed-comment');
      commentItems.forEach((item) => {
        const body = item.querySelector('.feed-comment__body');
        if (!body) return;
        if (isMobile) {
          body.style.background = 'rgba(255,255,255,0.06)';
          body.style.borderRadius = '16px';
          body.style.padding = '10px 12px';
        } else {
          body.style.background = '';
          body.style.borderRadius = '';
          body.style.padding = '';
        }
        const avatar = item.querySelector('.feed-comment__avatar');
        if (avatar && isMobile) {
          avatar.style.width = '32px';
          avatar.style.height = '32px';
          avatar.style.borderRadius = '999px';
          avatar.style.overflow = 'hidden';
        } else if (avatar) {
          avatar.removeAttribute('style');
        }
      });
    } catch (_) {}
  }

  window.addEventListener('resize', () => {
    // Throttle קל
    clearTimeout(window._applyMobileUiTO);
    window._applyMobileUiTO = setTimeout(applyMobilePostUiStyles, 100);
  });

  // חלק תמונות (feed.js) – Lightbox להצגת תמונות בגודל מלא במסך
  function openImageLightbox(src, alt = '') {
    try {
      const existing = document.querySelector('.image-lightbox');
      if (existing) existing.remove();
      const overlay = document.createElement('div');
      overlay.className = 'image-lightbox';
      overlay.innerHTML = `<img class="image-lightbox__img" src="${src}" alt="${(alt || '').replace(/"/g, '&quot;')}">`;
      const close = () => {
        try { document.removeEventListener('keydown', onKey); } catch (_) {}
        if (overlay && overlay.parentElement) overlay.parentElement.removeChild(overlay);
      };
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      overlay.addEventListener('click', close);
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
    } catch (_) {}
  }

  function initImageLightbox() {
    if (window._imageLightboxBound) return;
    window._imageLightboxBound = true;
    // האצלת אירועים: לחיצה על כל תמונה בתוך feed-media תפתח לייטבוקס
    const handler = (e) => {
      const img = e.target && e.target.tagName === 'IMG' ? e.target : null;
      if (!img) return;
      const wrapper = img.closest('.feed-media');
      if (!wrapper) return; // רק לתמונות בתוך הפיד
      // מניעת פתיחת קישורים חיצוניים (feed-media--link)
      if (wrapper.classList.contains('feed-media--link')) return;
      // לא נוגעים בווידאו/YouTube
      if (wrapper.closest('[data-video-container]') || wrapper.closest('.feed-media--youtube')) return;
      e.preventDefault();
      e.stopPropagation();
      const src = img.getAttribute('src');
      const alt = img.getAttribute('alt') || '';
      if (src) openImageLightbox(src, alt);
    };
    // מאזין רגיל + capture כדי לעקוף מאזינים שעוצרים bubbling בדסקטופ
    document.addEventListener('click', handler);
    document.addEventListener('click', handler, true);
    // תמיכה ב-double click בדסקטופ
    document.addEventListener('dblclick', handler, true);

    // Coachmark פר-תמונה: מראה רמז קצר כשנכנסת לפריים, פעם אחת לסשן
    setupImageCoachmarks();
  }

  // חלק תיאטרון דסקטופ (feed.js) – טעינת נכסים ורישום פתיחה בלחיצה | HYPER CORE TECH
  function ensureTheaterAssetsLoaded() {
    try {
      if (window._ptvAssetsLoaded) return Promise.resolve(true);
      return new Promise((resolve) => {
        let pending = 2; // css + js
        const done = () => { if (--pending === 0) { window._ptvAssetsLoaded = true; resolve(true); } };

        // CSS
        if (!document.querySelector('link[data-ptv-css]')) {
          const l = document.createElement('link');
          l.rel = 'stylesheet';
          l.href = 'post-theater/theater-viewer.css';
          l.setAttribute('data-ptv-css', '');
          l.onload = done; l.onerror = done;
          document.head.appendChild(l);
        } else { done(); }

        // JS
        if (!window.PostTheaterViewer && !document.querySelector('script[data-ptv-js]')) {
          const s = document.createElement('script');
          s.src = 'post-theater/theater-viewer.js';
          s.defer = true;
          s.setAttribute('data-ptv-js', '');
          s.onload = done; s.onerror = done;
          document.head.appendChild(s);
        } else { done(); }
      });
    } catch (_) { return Promise.resolve(false); }
  }

  // בניית אובייקט פוסט בסיסי מתוך כרטיס קיים לפורמט הצופה
  // משתמש בנתונים שמור בdata-attributes של הכרטיס (profileData, created_at)
  function buildTheaterPostDataFromCard(card) {
    try {
      const article = card.querySelector('.feed-post');
      const id = article?.getAttribute('data-post-id') || card.getAttribute('data-feed-card') || '';

      // שם ואווטאר – מנתונים שמור בdata-attributes של הכרטיס
      const name = card.getAttribute('data-author-name') || (article?.querySelector('.feed-post__name')?.textContent || '').trim();
      const avatarUrl = card.getAttribute('data-author-picture') || '';

      // טקסט – מהאלמנט התוכן הספציפי לפוסט
      let text = '';
      const contentEl = id ? article?.querySelector(`[data-post-content="${id}"]`) : null;
      if (contentEl) {
        text = contentEl.textContent || '';
      }

      // זמן יצירה – מנתונים שמור בdata-attribute של הכרטיס (created_at בשניות)
      let timestamp = Date.now();
      const createdAtStr = card.getAttribute('data-created-at');
      if (createdAtStr && !Number.isNaN(Number(createdAtStr))) {
        const n = Number(createdAtStr);
        timestamp = n > 1e12 ? n : n * 1000; // תמיכה בשניות/מילישניות
      }

      // מדיה ראשית – יוטיוב/וידאו/תמונה אם קיימים
      let media = [];
      const yt = article?.querySelector('.feed-media--youtube, [data-youtube-id]');
      const vid = article?.querySelector('[data-video-container] video, video');
      const img = article?.querySelector('.feed-media img, img[data-feed-image]');
      if (yt) {
        const yid = yt.getAttribute('data-youtube-id') || '';
        const embed = yid ? `https://www.youtube.com/embed/${yid}?autoplay=0&rel=0` : '';
        media = [{ type: 'youtube', id: yid, src: embed }];
      } else if (vid) {
        media = [{ type: 'video', src: vid.currentSrc || vid.src || vid.getAttribute('data-src') || '', poster: vid.getAttribute('poster') || '' }];
      } else if (img) {
        media = [{ type: 'image', src: img.currentSrc || img.src || '' }];
      }

      // פונקציית עזר להוצאת מספר מתוך טקסט
      const extractNum = (str) => {
        const m = String(str||'').replace(/[,\s]/g,'').match(/\d+/);
        return m ? Number(m[0]) : 0;
      };

      // מוני לייקים/תגובות/שיתופים – נתונים חיים מה-App עם פולבאקים לdata/DOM
      let likes = 0, comments = 0, shares = 0;
      const likesStr = card.getAttribute('data-likes-count');
      const commentsStr = card.getAttribute('data-comments-count');
      const sharesStr = card.getAttribute('data-shares-count');

      try {
        if (window.App?.likesByEventId?.get && id) {
          const likeSet = window.App.likesByEventId.get(id);
          if (likeSet) likes = likeSet.size || 0;
        }
        if (window.App?.commentsByParent?.get && id) {
          const commentMap = window.App.commentsByParent.get(id);
          if (commentMap) comments = commentMap.size || 0;
        }
      } catch (_) {}

      if (!likes && likesStr && !Number.isNaN(Number(likesStr))) likes = Number(likesStr);
      if (!comments && commentsStr && !Number.isNaN(Number(commentsStr))) comments = Number(commentsStr);
      if (sharesStr && !Number.isNaN(Number(sharesStr))) shares = Number(sharesStr);

      if (!likes && article) {
        const likeAttr = article.querySelector('.feed-post__like-counter,[data-like-count]');
        if (likeAttr) {
          const val = likeAttr.getAttribute('data-like-count') || likeAttr.textContent;
          likes = extractNum(val);
        } else {
          const likeBtn = article.querySelector('[data-like-button], button[title*="אהב"], .feed-post__action:nth-child(2)');
          if (likeBtn) likes = extractNum(likeBtn.textContent);
        }
      }

      // תגובות – דוגם הראשונות אם קיימות
      const commentsEls = Array.from(article?.querySelectorAll('.feed-comments .feed-comment') || []).slice(0, 10);
      const mapped = commentsEls.map((el, i) => ({
        id: el.getAttribute('data-comment-id') || `${id}-c${i}`,
        authorName: (el.querySelector('.feed-comment__author, [data-author-name]')?.textContent || '').trim(),
        avatarUrl: el.querySelector('.feed-comment__avatar img, .feed-comment__avatar')?.getAttribute?.('src') || '',
        text: el.querySelector('.feed-comment__body, [data-comment-text]')?.textContent || '',
        timestamp: (()=>{
          const t = el.querySelector('[data-timestamp], time[datetime]');
          if (!t) return Date.now();
          const ds = t.getAttribute('data-timestamp');
          if (ds && !Number.isNaN(Number(ds))) {
            const n = Number(ds); return n > 1e12 ? n : n*1000;
          }
          const dt = t.getAttribute('datetime');
          const ms = Date.parse(dt||'');
          return Number.isNaN(ms) ? Date.now() : ms;
        })()
      }));

      return {
        id,
        author: { name, avatarUrl },
        timestamp,
        text,
        media,
        counts: { likes, comments, shares },
        comments: mapped,
      };
    } catch (_) {
      return { id: '', author: { name: '', avatarUrl: '' }, timestamp: Date.now(), text: '', media: [], counts: { likes:0, comments:0, shares:0 }, comments: [] };
    }
  }

  // חלק תיאטרון (feed.js) – חשיפת בניית נתוני פוסט לצופה החיצוני
  App.buildTheaterSnapshot = function buildTheaterSnapshot(card) {
    return buildTheaterPostDataFromCard(card);
  };

  // רישום קליק לפתיחת התיאטרון בדסקטופ ובמובייל כאחד (capture כדי לא להתנגש במאזינים אחרים)
  function bindTheaterOpen() {
    if (window._ptvOpenBound) return;
    window._ptvOpenBound = true;
    document.addEventListener('click', async (event) => {
      try {
        // כפתור שמאלי בלבד וללא מקשי עזר (גם בנגיעה במובייל מתקבל button=0)
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const card = event.target.closest('.home-feed__card');
        if (!card) return;
        const article = card.querySelector('.feed-post');
        if (!article) return;
        // אל תפתח על לחיצה על פעולות/תגובות/וידאו/תמונה עם לייטבוקס/קישורים/תפריט/עקוב (כפתור תגובות מטופל בנפרד)
        if (event.target.closest('.feed-post__actions') || event.target.closest('.feed-comments') || event.target.closest('[data-video-container]') || event.target.closest('a') || event.target.closest('.feed-post__menu-wrap') || event.target.closest('[data-post-menu]') || event.target.closest('.feed-post__follow-button')) return;
        if (event.target.closest('.feed-media')) {
          // תמונות כבר מנוהלות בלייטבוקס – לא נפתח תיאטרון כדי לא להתנגש
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (article) {
          try {
            const playing = article.querySelector('video');
            if (playing && !playing.paused) {
              playing.pause();
              try { playing.currentTime = 0; } catch (_) {}
            }
          } catch (_) {}
        }
        await ensureTheaterAssetsLoaded();
        if (window.PostTheaterViewer) {
          const data = buildTheaterPostDataFromCard(card);
          window.PostTheaterViewer.open(data);
        }
      } catch (_) {}
    }, true);
  }

  // חלק Coachmark לתמונות (feed.js) – רמז "לחצו לתצוגה מלאה" עם אייקון זום מהבהב | HYPER CORE TECH
  function setupImageCoachmarks() {
    if (window._imageCoachmarkSetup) return;
    window._imageCoachmarkSetup = true;
    window._imageCoachmarkShownEls = window._imageCoachmarkShownEls || new WeakSet();

    const hasShown = (img) => {
      if (!img) return true;
      if (window._imageCoachmarkShownEls.has(img)) return true;
      try {
        const key = 'imageCoachmarkShown:' + (img.currentSrc || img.src || '');
        return sessionStorage.getItem(key) === '1';
      } catch (_) { return false; }
    };

    const markShown = (img) => {
      if (!img) return;
      window._imageCoachmarkShownEls.add(img);
      try {
        const key = 'imageCoachmarkShown:' + (img.currentSrc || img.src || '');
        sessionStorage.setItem(key, '1');
      } catch (_) {}
    };

    const showFor = (img) => {
      if (!img || hasShown(img)) return;
      const wrapper = img.closest('.feed-media');
      if (!wrapper) return;
      if (wrapper.closest('[data-video-container]') || wrapper.closest('.feed-media--youtube')) return;
      if (wrapper.classList.contains('feed-media--link')) return;

      if (getComputedStyle(wrapper).position === 'static') {
        wrapper.style.position = 'relative';
      }

      const host = document.createElement('div');
      host.setAttribute('data-image-coachmark', '');
      Object.assign(host.style, {
        position: 'absolute',
        insetInline: '0',
        bottom: '10px',
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: '3'
      });

      const bubble = document.createElement('div');
      Object.assign(bubble.style, {
        background: 'rgba(20,20,20,0.85)',
        color: '#fff',
        fontSize: '12px',
        lineHeight: '1',
        padding: '10px 12px',
        borderRadius: '999px',
        boxShadow: '0 6px 20px rgba(0,0,0,0.25), 0 2px 6px rgba(0,0,0,0.2)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        pointerEvents: 'auto',
        transform: 'scale(0.8)',
        opacity: '0'
      });

      const icon = document.createElement('span');
      icon.textContent = '🔎';
      Object.assign(icon.style, {
        width: '14px', height: '14px', display: 'inline-block', opacity: '0.95'
      });

      const label = document.createElement('span');
      label.textContent = 'לחצו לתצוגה מלאה';

      bubble.appendChild(icon);
      bubble.appendChild(label);
      host.appendChild(bubble);
      wrapper.appendChild(host);

      try {
        bubble.animate([
          { transform: 'scale(0.8)', opacity: 0 },
          { transform: 'scale(1.06)', opacity: 1, offset: 0.6 },
          { transform: 'scale(1)', opacity: 1 }
        ], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' }).finished.then(() => {
          // פולס עדין לאייקון
          icon.animate([
            { transform: 'scale(1)', filter: 'drop-shadow(0 0 0 rgba(255,255,255,0))' },
            { transform: 'scale(1.12)', filter: 'drop-shadow(0 0 6px rgba(255,255,255,0.35))' },
            { transform: 'scale(1)', filter: 'drop-shadow(0 0 0 rgba(255,255,255,0))' }
          ], { duration: 1400, iterations: 3, easing: 'ease-in-out' });
        });
      } catch (_) {}

      const dismiss = () => {
        markShown(img);
        if (!host.isConnected) return;
        try {
          host.style.transition = 'opacity 180ms ease, transform 180ms ease, filter 180ms ease';
          host.style.opacity = '0';
          host.style.transform = 'scale(0.96)';
          host.style.filter = 'blur(1px)';
          setTimeout(() => { host.remove(); }, 200);
        } catch (_) { host.remove(); }
      };

      bubble.addEventListener('click', () => dismiss());
      img.addEventListener('click', () => dismiss(), { once: true, capture: true });
      window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') dismiss(); }, { once: true });
    };

    // צופה בכניסה לפריים לכל תמונה בפיד
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) showFor(entry.target);
      });
    }, { root: document.querySelector('.home-feed__viewport') || null, threshold: 0.6 });

    const scan = () => {
      document.querySelectorAll('.feed-media img').forEach((img) => io.observe(img));
    };
    scan();

    // התעדכנות כשפוסטים/מדיה נוספים נטענים
    const vp = document.querySelector('.home-feed__viewport') || document.body;
    const mo = new MutationObserver(() => scan());
    try { mo.observe(vp, { childList: true, subtree: true }); } catch (_) {}
    window._imageCoachmarkObserver = mo;
  }

  // חלק תפריט עליון (feed.js) – חיבור כפתור 3 נקודות לפתיחה/סגירה של תפריט אפשרויות לעריכה/מחיקה
  function wirePostMenu(articleEl, postId) {
    if (!articleEl || !postId) return;
    const toggle = articleEl.querySelector(`[data-post-menu-toggle="${postId}"]`);
    const menu = articleEl.querySelector(`[data-post-menu="${postId}"]`);
    if (!toggle || !menu) return;

    const close = () => {
      if (!menu.hasAttribute('hidden')) {
        menu.setAttribute('hidden', '');
        toggle.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', onOutside, true);
        document.removeEventListener('keydown', onKey);
      }
    };
    const onOutside = (ev) => {
      if (!menu.contains(ev.target) && !toggle.contains(ev.target)) {
        close();
      }
    };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };

    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const hidden = menu.hasAttribute('hidden');
      if (hidden) {
        menu.removeAttribute('hidden');
        toggle.setAttribute('aria-expanded', 'true');
        document.addEventListener('click', onOutside, true);
        document.addEventListener('keydown', onKey);
      } else {
        close();
      }
    });
  }

  // חלק לייקים (feed.js) – מנוי דינמי ללייקים לפי מזהי פוסטים (#e) כדי לכלול גם לייקים ללא תג רשת
  function subscribeLikesForPosts(postIds = []) {
    try {
      if (!Array.isArray(postIds) || postIds.length === 0 || !App.pool || !Array.isArray(App.relayUrls)) {
        return;
      }
      if (!(App._likesSubscribedForIds instanceof Set)) {
        App._likesSubscribedForIds = new Set();
      }
      const toSubscribe = postIds.filter((id) => typeof id === 'string' && id && !App._likesSubscribedForIds.has(id));
      if (toSubscribe.length === 0) return;

      // שמירה למניעת כפילות מנויים בעתיד
      toSubscribe.forEach((id) => App._likesSubscribedForIds.add(id));

      // חלק תגובות (feed.js) – מפעיל גם מנוי תגובות דלתא לאותם פוסטים | HYPER CORE TECH
      try { subscribeCommentsForPosts(toSubscribe); } catch (err) { console.warn('subscribeCommentsForPosts hook failed', err); }

      // חלק לייקים (feed.js) – שאיבה מיידית של לייקים קיימים כדי להציג מונים גם לפני אינטראקציה | HYPER CORE TECH
      (async () => {
        const chunkSize = 50;
        for (let i = 0; i < toSubscribe.length; i += chunkSize) {
          const chunk = toSubscribe.slice(i, i + chunkSize);
          const filters = [{ kinds: [7], '#e': chunk, limit: 800 }];
          try {
            let events = [];
            if (typeof App.pool.list === 'function') {
              events = await App.pool.list(App.relayUrls, filters);
            } else if (typeof App.pool.listMany === 'function') {
              events = await App.pool.listMany(App.relayUrls, filters);
            }
            if (Array.isArray(events)) {
              events.forEach((ev) => { if (ev?.kind === 7) registerLike(ev); });
            }
          } catch (err) {
            console.warn('prefetch likes chunk failed', err);
          }
        }
      })();

      // נפרוס למנות של עד 50 מזהים כדי להימנע מפילטרים כבדים מדי
      const chunkSize = 50;
      for (let i = 0; i < toSubscribe.length; i += chunkSize) {
        const chunk = toSubscribe.slice(i, i + chunkSize);
        const filters = [{ kinds: [7], '#e': chunk, limit: 1000 }];
        try {
          const sub = App.pool.subscribeMany(App.relayUrls, filters, {
            onevent: (ev) => {
              if (ev && ev.kind === 7) {
                registerLike(ev);
              }
            },
            oneose: () => {
              try { sub?.close?.(); } catch (_) {}
            },
          });
          // פייל-סייף סגירה אחרי זמן קצר
          setTimeout(() => { try { sub?.close?.(); } catch (_) {} }, 7000);
        } catch (err) {
          console.warn('subscribeLikesForPosts failed', err);
        }
      }
    } catch (err) {
      console.warn('subscribeLikesForPosts outer failed', err);
    }
  }

  // חלק תגובות (feed.js) – מנוי דלתא לתגובות לפי since=commentLastSyncTs | HYPER CORE TECH
  function subscribeCommentsForPosts(postIds = []) {
    try {
      if (!Array.isArray(postIds) || postIds.length === 0 || !App.pool || !Array.isArray(App.relayUrls)) {
        return;
      }
      if (!(App._commentsSubscribedForIds instanceof Set)) {
        App._commentsSubscribedForIds = new Set();
      }
      const toSubscribe = postIds.filter((id) => typeof id === 'string' && id && !App._commentsSubscribedForIds.has(id));
      if (toSubscribe.length === 0) return;
      toSubscribe.forEach((id) => App._commentsSubscribedForIds.add(id));

      const sinceTs = typeof App.commentLastSyncTs === 'number' && App.commentLastSyncTs > 0 ? App.commentLastSyncTs : undefined;
      const chunkSize = 50;
      for (let i = 0; i < toSubscribe.length; i += chunkSize) {
        const chunk = toSubscribe.slice(i, i + chunkSize);
        const filter = { kinds: [1], '#e': chunk, limit: 500 };
        if (sinceTs) filter.since = sinceTs;
        try {
          const sub = App.pool.subscribeMany(App.relayUrls, [filter], {
            onevent: (ev) => {
              if (ev && ev.kind === 1) {
                const parent = extractParentId(ev);
                if (parent && chunk.includes(parent)) {
                  registerComment(ev, parent);
                }
              }
            },
            oneose: () => {
              try { sub?.close?.(); } catch (_) {}
            },
          });
          setTimeout(() => { try { sub?.close?.(); } catch (_) {} }, 8000);
        } catch (err) {
          console.warn('subscribeCommentsForPosts chunk failed', err);
        }
      }
    } catch (err) {
      console.warn('subscribeCommentsForPosts outer failed', err);
    }
  }

  // חלק טעינה (feed.js) – להמתין שהמדיה הראשונה בפוסט הראשון מוכנה (img/video)
  function awaitFirstPostMediaReady({ timeout = 2500 } = {}) {
    return new Promise((resolve) => {
      try {
        const card = document.querySelector('.home-feed__card[data-feed-card]');
        if (!card) { resolve(false); return; }
        const img = card.querySelector('img');
        const video = card.querySelector('video');
        let finished = false;
        const done = () => { if (finished) return; finished = true; resolve(true); };
        const to = setTimeout(done, timeout);
        if (img) {
          if (img.complete && img.naturalWidth > 0) { clearTimeout(to); done(); return; }
          img.addEventListener('load', () => { clearTimeout(to); done(); }, { once: true });
          img.addEventListener('error', () => { /* מתעלמים ושומרים timeout כפייל-סייף */ }, { once: true });
        }
        if (video) {
          if (video.readyState >= 2) { clearTimeout(to); done(); return; }
          const onReady = () => { clearTimeout(to); done(); };
          video.addEventListener('canplay', onReady, { once: true });
          video.addEventListener('canplaythrough', onReady, { once: true });
          video.addEventListener('loadeddata', onReady, { once: true });
          video.addEventListener('error', () => { /* timeout יכריע */ }, { once: true });
        }
        if (!img && !video) { clearTimeout(to); done(); }
      } catch (_) { resolve(false); }
    });
  }

  // חלק טעינה – סיום מרוכז המגן מכפילויות
  function finishWelcomeIfReady() {
    if (App._homeFeedFirstBatchShown) return;
    setWelcomeLoading(95);
    endWelcomeLoading();
    App._homeFeedFirstBatchShown = true;
    App._homeFeedLoadingInProgress = false;
  }

  function scheduleWelcomeFallback() {
    if (_welcomeFallbackTimer) {
      clearTimeout(_welcomeFallbackTimer);
    }
    _welcomeFallbackTimer = setTimeout(() => {
      if (!App._homeFeedFirstBatchShown) {
        console.warn('[HOME FEED] Welcome fallback triggered – releasing UI.');
        finishWelcomeIfReady();
      }
    }, 3500);
  }

  // חלק טעינה (feed.js) – להמתין לצביעה בפועל של הכרטיס הראשון לפני סיום טעינה
  function waitForFirstPostPaint({ timeout = 4000 } = {}) {
    return new Promise((resolve) => {
      const start = Date.now();
      const viewport = document.querySelector('.home-feed__viewport') || window;

      const isPainted = () => {
        const el = document.querySelector('.home-feed__card[data-feed-card]');
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const vh = (viewport === window) ? window.innerHeight : viewport.clientHeight;
        return rect.height > 0 && rect.top < vh && rect.bottom > 0;
      };

      const tick = () => {
        if (isPainted()) {
          resolve(true);
          return;
        }
        if (Date.now() - start > timeout) {
          resolve(false);
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  // חלק infinite scroll (feed.js) – טעינת עוד כשמתקרבים לסוף הסט
  function setupInfiniteScroll() {
    const viewport = document.querySelector('.home-feed__viewport');
    if (!viewport) return;
    const statusEl = document.getElementById('homeFeedStatus');

    async function maybeLoadMore() {
      if (isLoadingMore) return;
      // אם אין עוד מה להציג ברשימה המלאה – אל תעשה כלום
      if (displayedPostsCount >= allFeedEvents.length) return;
      
      // חלק infinite scroll (feed.js) – טעינה מראש כשמגיעים לפוסט 7-8 מתוך 10
      // חישוב מיקום הפוסט הנוכחי בתוך הבאץ' הנוכחי (1-10)
      const positionInBatch = ((displayedPostsCount - 1) % POSTS_PER_LOAD) + 1;
      
      // טען עוד אם המשתמש הגיע לפוסט 7-8 מתוך 10 בבאץ' הנוכחי
      if (positionInBatch >= 7 && displayedPostsCount < allFeedEvents.length) {
        console.log(`[INFINITE SCROLL] Pre-loading more posts: displayed=${displayedPostsCount}, total=${allFeedEvents.length}, positionInBatch=${positionInBatch}`);
        isLoadingMore = true;
        // חלק infinite scroll (feed.js) – הצגת אנימציית טעינה בתחתית הפיד
        const loadingIndicator = document.getElementById('homeFeedLoadingIndicator');
        if (loadingIndicator) {
          loadingIndicator.removeAttribute('hidden');
        }
        try {
          await displayPosts(allFeedEvents, true);
        } finally {
          isLoadingMore = false;
          // חלק infinite scroll (feed.js) – הסתרת אנימציית הטעינה לאחר סיום
          if (loadingIndicator) {
            loadingIndicator.setAttribute('hidden', '');
          }
        }
      }
    }

    let rafId = 0;
    function onScroll() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(maybeLoadMore);
    }
    viewport.addEventListener('scroll', onScroll, { passive: true });
  }

  // חלק טעינה (feed.js) – ניהול מד טעינה בכרטיס הברכה עם אחוזים
  let _welcomeProgressTimer = null;
  let _welcomeProgressValue = 0;
  let _welcomeFallbackTimer = null; // חלק טעינה (feed.js) – טיימר גיבוי לשחרור הכרטיס אם הרינדור נתקע
  function setWelcomeStatus(message) {
    try {
      const labelWrap = document.querySelector('.welcome-progress__label');
      if (!labelWrap) return;
      let statusEl = labelWrap.querySelector('.welcome-progress__status');
      if (!statusEl) {
        statusEl = document.createElement('span');
        statusEl.className = 'welcome-progress__status';
        statusEl.style.marginInlineStart = '8px';
        statusEl.style.opacity = '0.9';
        labelWrap.appendChild(statusEl);
      }
      statusEl.textContent = String(message || '').trim();
    } catch (_) {}
  }
  function setWelcomeLoading(percent) {
    try {
      const bar = document.getElementById('welcomeProgressBar');
      const label = document.getElementById('welcomeProgressPercent');
      // אם הסט הראשון כבר הופיע – ננעל על 100 ולא נוריד חזרה
      if (App._homeFeedFirstBatchShown) {
        _welcomeProgressValue = 100;
        if (bar) bar.style.width = '100%';
        if (label) label.textContent = '100%';
        return;
      }
      const val = Math.max(0, Math.min(100, Math.floor(percent || 0)));
      const next = Math.max(_welcomeProgressValue || 0, val); // לא לרדת אחורה
      _welcomeProgressValue = next;
      if (bar) bar.style.width = next + '%';
      if (label) label.textContent = next + '%';
    } catch (_) {}
  }

  let _loadingGuardsBound = false;
  function bindLoadingGuards() {
    if (_loadingGuardsBound) return;
    _loadingGuardsBound = true;
    const block = (e) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    };
    const blockKey = (e) => {
      const target = e.target;
      const tag = target?.tagName ? target.tagName.toLowerCase() : '';
      const isTextInput = tag === 'textarea' || tag === 'input' || tag === 'select' || target?.isContentEditable;
      if (isTextInput) {
        return;
      }
      const keys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'];
      if (keys.includes(e.key)) block(e);
    };
    window.addEventListener('wheel', block, { passive: false });
    window.addEventListener('touchmove', block, { passive: false });
    window.addEventListener('keydown', blockKey, { passive: false });
    window._hfBlockScroll = block;
    window._hfBlockKey = blockKey;
  }

  function unbindLoadingGuards() {
    if (!window._hfBlockScroll) return;
    const block = window._hfBlockScroll;
    window.removeEventListener('wheel', block, { passive: false });
    window.removeEventListener('touchmove', block, { passive: false });
    if (window._hfBlockKey) {
      window.removeEventListener('keydown', window._hfBlockKey, { passive: false });
      delete window._hfBlockKey;
    }
    delete window._hfBlockScroll;
    _loadingGuardsBound = false;
  }

  function endWelcomeLoading() {
    document.body.classList.remove('home-feed--loading');
    document.documentElement.classList.remove('home-feed--loading');
    setWelcomeLoading(95);
    console.log('[HOME FEED] Welcome loading ended – releasing UI at 95%.');
    if (_welcomeProgressTimer) {
      clearInterval(_welcomeProgressTimer);
      _welcomeProgressTimer = null;
    }
    if (_welcomeFallbackTimer) {
      clearTimeout(_welcomeFallbackTimer);
      _welcomeFallbackTimer = null;
    }
    unbindLoadingGuards();
  }

  function setupHomeFeedObserver() {
    if (App._homeFeedObserver) {
      App._homeFeedObserver.disconnect();
    }

    const cards = Array.from(document.querySelectorAll('.home-feed__card'));
    if (cards.length === 0) {
      App._homeFeedObserver = null;
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        let bestEntry = null;
        entries.forEach((entry) => {
          if (!entry.target) return;
          if (!bestEntry || entry.intersectionRatio > (bestEntry?.intersectionRatio || 0)) {
            bestEntry = entry;
          }
        });

        entries.forEach((entry) => {
          const card = entry.target;
          if (!card) return;
          
          // חלק ברכה (feed.js) – הברכה תמיד נראית
          if (card.id === 'welcomeCard') {
            card.classList.add('in-view');
            return;
          }
          
          const article = card.querySelector('.feed-post');
          if (!article) return;

          const mediaContainer = article.querySelector('[data-video-container], video, iframe');

          if (entry === bestEntry && entry.isIntersecting && entry.intersectionRatio > 0.35) {
            card.classList.add('in-view');
            const currentIndex = cards.indexOf(card);
            if (currentIndex !== -1) {
              const previousIndex = typeof App._homeFeedLastIndex === 'number' ? App._homeFeedLastIndex : currentIndex;
              if (previousIndex - currentIndex >= 2) {
                revealHomeFeedMenus();
              }
              App._homeFeedLastIndex = currentIndex;
            }
            focusFeedMedia(mediaContainer, true);
          } else {
            card.classList.remove('in-view');
            focusFeedMedia(mediaContainer, false);
          }
        });
      },
      {
        root: null,
        threshold: [0, 0.25, 0.5, 0.75, 1],
        rootMargin: '-15% 0px -15% 0px',
      }
    );

    cards.forEach((card) => observer.observe(card));

    App._homeFeedObserver = observer;
  }

  function focusFeedMedia(mediaTarget, play) {
    if (!mediaTarget) return;

    const container = mediaTarget.closest('[data-video-container]');
    if (container) {
      const video = container.querySelector('video');
      if (video) {
        if (play) {
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      }
      return;
    }

    if (mediaTarget.tagName === 'VIDEO') {
      if (play) {
        mediaTarget.play().catch(() => {});
      } else {
        mediaTarget.pause();
      }
      return;
    }

    if (mediaTarget.tagName === 'IFRAME' && mediaTarget.src?.includes('youtube.com')) {
      try {
        mediaTarget.contentWindow?.postMessage(
          play
            ? '{"event":"command","func":"playVideo","args":[]}'
            : '{"event":"command","func":"pauseVideo","args":[]}',
          '*'
        );
      } catch (_) {}
    }
  }

  function revealHomeFeedMenus() {
    const setter = window.NostrApp && typeof window.NostrApp.setHomeFeedMenusHidden === 'function'
      ? window.NostrApp.setHomeFeedMenusHidden
      : null;
    if (setter) {
      setter(false, { reason: 'auto' });
      return;
    }

    const primaryNav = document.querySelector('.primary-nav');
    if (primaryNav) {
      primaryNav.classList.remove('primary-nav--hidden');
      primaryNav.classList.remove('primary-nav--compact');
    }
    const topBar = document.querySelector('.top-bar');
    if (topBar) {
      topBar.classList.remove('top-bar--hidden');
    }
    const composerCard = document.querySelector('.composer-card');
    if (composerCard) {
      composerCard.classList.remove('composer-card--hidden');
    }
    document.body.classList.remove('home-feed--menus-hidden');
    const toggleButton = document.getElementById('homeFeedToggleButton');
    if (toggleButton) {
      toggleButton.classList.remove('home-feed__toggle--pulse');
      toggleButton.classList.remove('home-feed__toggle--visible');
      const toggleText = toggleButton.querySelector('.home-feed__toggle-text');
      if (toggleText) {
        toggleText.textContent = 'החבא תפריטים';
      }
    }
  }

  function wireHomeFeedInteractions() {
    const viewport = document.querySelector('.home-feed__viewport');
    if (!viewport) return;

    document.body.classList.add('home-feed-active');

    const toggleButton = document.getElementById('homeFeedToggleButton');
    const toggleText = toggleButton ? toggleButton.querySelector('.home-feed__toggle-text') : null;
    const welcomeCard = document.getElementById('welcomeCard');
    const composerCard = document.querySelector('.composer-card');

    let menusHidden = false;
    let scrollTimeout = null;
    let autoHideCooldown = Date.now() + 600;
    let hasShownTogglePulse = false;
    let lastScrollY = 0; // חלק גלילה (feed.js) – עקיבה אחרי כיוון הגלילה להתנהגות בסגנון אינסטגרם

    let welcomeHeight = 0;
    if (welcomeCard && typeof welcomeCard.offsetHeight === 'number') {
      welcomeHeight = welcomeCard.offsetHeight;
    }
    const hideThreshold = Math.max(welcomeHeight - 60, 220);

    function setMenusHidden(hidden, { reason = 'auto' } = {}) {
      if (hidden === menusHidden) {
        return;
      }

      const topBar = document.querySelector('.top-bar');
      const primaryNav = document.querySelector('.primary-nav');

      menusHidden = hidden;

      if (hidden) {
        // חלק גלילה (feed.js) – הסתרת הפס העליון בלבד; התפריט התחתון נשאר תמיד גלוי
        if (topBar) {
          topBar.classList.add('top-bar--hidden');
        }
        // עדכון ריווח עליון של ה-viewport – אין רווח כשמסתירים את הפס העליון
        try { document.documentElement.style.setProperty('--home-feed-offset', '0px'); } catch (e) {}
        // אין שימוש בכפתור התפריטים – הוסר מה-HTML
      } else {
        // חלק גלילה (feed.js) – הצגת הפס העליון בחזרה בגלילה כלפי מעלה
        if (topBar) {
          topBar.classList.remove('top-bar--hidden');
        }
        // החזרת ריווח עליון ברירת מחדל כך שהתוכן לא ייתקע תחת הפס העליון
        try { document.documentElement.style.setProperty('--home-feed-offset', '56px'); } catch (e) {}
        // התפריט התחתון לא משתנה כלל
        autoHideCooldown = Date.now() + (reason === 'manual' ? 1500 : 600);
      }
    }

    App.setHomeFeedMenusHidden = setMenusHidden;

    function handleMainScroll() {
      const currentY = viewport.scrollTop;
      const scrollDirection = currentY > lastScrollY ? 'down' : 'up'; // חלק גלילה (feed.js) – זיהוי כיוון הגלילה
      lastScrollY = currentY;

      if (!menusHidden && currentY > hideThreshold && scrollDirection === 'down' && Date.now() > autoHideCooldown) {
        setMenusHidden(true, { reason: 'scroll' });
        return;
      }

      if (menusHidden && scrollDirection === 'up' && Date.now() > autoHideCooldown) {
        setMenusHidden(false, { reason: 'scroll' });
        return;
      }

      // אין כפתור תפריטים – אין מה להציג
    }

    viewport.addEventListener('scroll', () => {
      if (scrollTimeout) {
        window.cancelAnimationFrame(scrollTimeout);
      }
      scrollTimeout = window.requestAnimationFrame(handleMainScroll);
    }, { passive: true });

    // אין כפתור תפריטים – מאזין הוסר

    window.addEventListener('beforeunload', () => {
      document.body.classList.remove('home-feed-active', 'home-feed--menus-hidden');
    });

    if (viewport.scrollTop > hideThreshold) {
      setMenusHidden(true, { reason: 'auto' });
    }

    handleMainScroll();
  }

  // חלק לחיצה על כרטיס (feed.js) – מפעיל/משהה וידאו בלחיצה על הכרטיס
  document.addEventListener('click', (event) => {
    const card = event.target.closest('.home-feed__card');
    if (!card) return;
    const article = card.querySelector('.feed-post');
    if (!article) return;
    if (event.target.closest('.feed-post__actions') || event.target.closest('.feed-comments')) {
      return;
    }
    // אל תבצע טוגל נוסף אם הקליק היה על מכולת הווידאו – זה מנוהל ע"י מאזין ייעודי
    if (event.target.closest('[data-video-container]')) {
      return;
    }
    const mediaContainer = article.querySelector('[data-video-container]');
    if (mediaContainer) {
      const video = mediaContainer.querySelector('video');
      if (video) {
        if (video.paused) {
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      }
    }
  });

  App.postsById = App.postsById instanceof Map ? App.postsById : new Map(); // חלק התרעות (feed.js) – שומר את אירועי הפיד לפי מזהה להצלבת התרעות
  App.pendingNotificationQueue = Array.isArray(App.pendingNotificationQueue) ? App.pendingNotificationQueue : []; // חלק התרעות (feed.js) – משמר אירועי התרעה מושהים עד שהפוסט נטען
  App.pendingNotificationSet = App.pendingNotificationSet instanceof Set ? App.pendingNotificationSet : new Set(); // חלק התרעות (feed.js) – מונע כפילויות בתור ההתרעות המושהה
  const DATING_LIKE_KIND = 40001; // חלק התרעות הכרויות (feed.js) – מזהה kind ייעודי ללייקים בדף ההכרויות
  const FOLLOW_KIND = (typeof App.FOLLOW_KIND === 'number' ? App.FOLLOW_KIND : 40010);
  App.profileFetchPromises = App.profileFetchPromises instanceof Map ? App.profileFetchPromises : new Map();
  // חלק פרופילים – תור מאגד לשאילת מטא-דאטה kind 0 בבאטץ' כדי לצמצם עומס
  App._profileBatchQueue = App._profileBatchQueue instanceof Set ? App._profileBatchQueue : new Set();
  App._profileBatchResolvers = App._profileBatchResolvers instanceof Map ? App._profileBatchResolvers : new Map();
  App._profileBatchTimer = App._profileBatchTimer || null;

  async function listMetadataBatch(authors) {
    // חלק פרופילים (feed.js) – עטיפה גמישה לקריאת Kind 0 עבור מערך מחברים, תומך בגרסאות שונות של SimplePool
    if (!Array.isArray(authors) || authors.length === 0) {
      return [];
    }
    if (!App.pool || !Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      return [];
    }
    const filters = [{ kinds: [0], authors }];
    try {
      if (typeof App.pool.list === 'function') {
        return await App.pool.list(App.relayUrls, filters);
      }
      if (typeof App.pool.listMany === 'function') {
        return await App.pool.listMany(App.relayUrls, filters);
      }
      if (typeof App.pool.querySync === 'function') {
        const result = await App.pool.querySync(App.relayUrls, filters[0]);
        if (!result) return [];
        if (Array.isArray(result)) return result;
        if (Array.isArray(result.events)) return result.events;
        return [];
      }
      if (typeof App.pool.subscribeMany === 'function') {
        return await new Promise((resolve) => {
          const collected = [];
          let sub;
          try {
            sub = App.pool.subscribeMany(App.relayUrls, filters, {
              onevent: (ev) => {
                if (ev && ev.kind === 0) {
                  collected.push(ev);
                }
              },
              oneose: () => {
                try { sub?.close?.(); } catch (e) {}
                resolve(collected);
              },
            });
          } catch (err) {
            resolve([]);
            return;
          }
          setTimeout(() => {
            try { sub?.close?.(); } catch (e) {}
            resolve(collected);
          }, 2500);
        });
      }
    } catch (err) {
      console.warn('listMetadataBatch failed', err);
    }
    return [];
  }

  function ensureProfileLinkNavigation() {
    // חלק ניווט פרופיל ציבורי (feed.js) – מאזין קליק פעם אחת לכל אלמנט עם data-profile-link
    if (App._profileLinkHandlerAttached) {
      return;
    }
    const handler = (event) => {
      // חיפוש אלמנט בעל data-profile-link גם אם היעד הוא טקסט/אייקון
      let el = event.target;
      // עבור צמתי טקסט/אייקון – עולים להורה עד למצוא אלמנט
      while (el && el.nodeType !== 1 /* ELEMENT_NODE */) {
        el = el.parentNode;
      }
      while (el && el !== document && !(el.matches && el.matches('[data-profile-link]'))) {
        el = el.parentElement;
      }
      const target = el && el.matches ? el : null;
      if (!target) {
        return;
      }
      const pubkey = target.getAttribute('data-profile-link');
      if (!pubkey) {
        return;
      }
      event.preventDefault();
      try { event.stopImmediatePropagation(); } catch (e) {}
      if (typeof window.openProfileByPubkey === 'function') {
        window.openProfileByPubkey(pubkey);
      }
    };
    // capture=true כדי שהמאזין יעבוד גם אם מאזינים אחרים עצרו bubbling
    document.addEventListener('click', handler, true);
    // מאזין נוסף ב-window capture למקרה שמאזיני capture אחרים במסמך עוצרים את האירוע לפני document
    window.addEventListener('click', handler, true);
    App._profileLinkHandlerAttached = true;
  }

  async function flushProfileBatch() {
    // חלק פרופילים (feed.js) – מנקה את התור, שולח list יחיד, מעדכן מטמונים ופותר הבטחות
    const authors = Array.from(App._profileBatchQueue.values());
    App._profileBatchQueue.clear();
    App._profileBatchTimer = null;
    if (!authors.length || !App.pool || !Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      authors.forEach((key) => {
        const resolvers = App._profileBatchResolvers.get(key) || [];
        resolvers.forEach(({ resolve, fallback }) => resolve(fallback));
        App._profileBatchResolvers.delete(key);
        App.profileFetchPromises.delete(key);
      });
      return;
    }
    let events = [];
    try {
      events = await listMetadataBatch(authors);
    } catch (err) {
      console.warn('flushProfileBatch list failed', err);
    }
    const found = new Set();
    if (Array.isArray(events)) {
      events.forEach((ev) => {
        const author = typeof ev?.pubkey === 'string' ? ev.pubkey.toLowerCase() : '';
        if (!author || !ev?.content) return;
        try {
          const parsed = JSON.parse(ev.content);
          const nameField = typeof parsed.display_name === 'string' ? parsed.display_name.trim() : '';
          const name = nameField || (typeof parsed.name === 'string' ? parsed.name.trim() : '') || `משתמש ${author.slice(0, 8)}`;
          const bio = typeof parsed.about === 'string' ? parsed.about.trim() : '';
          const picture = typeof parsed.picture === 'string' ? parsed.picture.trim() : '';
          const initials = typeof App.getInitials === 'function' ? App.getInitials(name || author) : 'AN';
          const profile = { name, bio, picture, initials };
          // עדכון מטמונים
          if (App.profileCache instanceof Map) App.profileCache.set(author, profile);
          if (App.feedAuthorProfiles instanceof Map) App.feedAuthorProfiles.set(author, profile);
          if (App.authorProfiles instanceof Map) App.authorProfiles.set(author, profile);
          updateRenderedAuthorProfile(author, profile);
          const resolvers = App._profileBatchResolvers.get(author) || [];
          resolvers.forEach(({ resolve }) => resolve(profile));
          App._profileBatchResolvers.delete(author);
          App.profileFetchPromises.delete(author);
          found.add(author);
        } catch (e) {
          // נתוני מטא פגומים – מתעלמים
        }
      });
    }
    // פתרון עבור מי שלא נמצא – החזר fallback
    authors.forEach((author) => {
      if (found.has(author)) return;
      const resolvers = App._profileBatchResolvers.get(author) || [];
      resolvers.forEach(({ resolve, fallback }) => resolve(fallback));
      App._profileBatchResolvers.delete(author);
      App.profileFetchPromises.delete(author);
    });
  }

  function enqueueProfileFetch(normalized, fallbackProfile) {
    // חלק פרופילים (feed.js) – מכניס לתור המאגד ומחזיר הבטחה שתיפתר לאחר flush
    return new Promise((resolve) => {
      const list = App._profileBatchResolvers.get(normalized) || [];
      list.push({ resolve, fallback: fallbackProfile });
      App._profileBatchResolvers.set(normalized, list);
      App._profileBatchQueue.add(normalized);
      if (!App._profileBatchTimer) {
        App._profileBatchTimer = setTimeout(flushProfileBatch, 80);
      }
    });
  }

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
      if (node.classList.contains('feed-post__name') || node.classList.contains('feed-comment__author')) {
        node.textContent = displayName;
      }
      if (node.classList.contains('feed-post__avatar') || node.classList.contains('feed-comment__avatar')) {
        if (profile?.picture) {
          const safePicture = profile.picture.replace(/"/g, '&quot;');
          node.innerHTML = `<img src="${safePicture}" alt="${escapedName}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.display='none'; var p=this.parentElement; if(p){ p.textContent='${escapedInitials}'; }">`;
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

    // חלק פרופילים (feed.js) – בדיקת cache אבל תמיד ננסה לעדכן מה-relays
    const cachedProfile =
      (App.profileCache instanceof Map ? App.profileCache.get(normalized) || App.profileCache.get(pubkey) : null) ||
      (App.feedAuthorProfiles instanceof Map ? App.feedAuthorProfiles.get(normalized) : null) ||
      (App.authorProfiles instanceof Map ? App.authorProfiles.get(normalized) : null);

    const fallback = storeProfile({
      name: `משתמש ${pubkey.slice(0, 8)}`,
      bio: '',
      picture: '',
      initials: typeof App.getInitials === 'function' ? App.getInitials(pubkey) : 'AN',
    });

    // אין Pool זמין – מחזירים fallback
    if (!App.pool || !Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      return fallback;
    }

    // שימוש במאגד – הבטחה יחידה לכל pubkey, פתרון לאחר flush
    if (!App.profileFetchPromises.has(normalized)) {
      const p = enqueueProfileFetch(normalized, fallback);
      App.profileFetchPromises.set(normalized, p);
    }
    try {
      await App.profileFetchPromises.get(normalized);
      const enriched =
        (App.profileCache instanceof Map ? App.profileCache.get(normalized) || App.profileCache.get(pubkey) : null) ||
        (App.feedAuthorProfiles instanceof Map ? App.feedAuthorProfiles.get(normalized) : null) ||
        (App.authorProfiles instanceof Map ? App.authorProfiles.get(normalized) : null);
      return enriched ? storeProfile(enriched) : fallback;
    } catch (err) {
      return fallback;
    }
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
    const stream = document.getElementById('homeFeedStream') || document.getElementById('feed');
    if (!stream) {
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
            : item.type === 'follow'
            ? 'follow'
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
    const safeInitials = App.escapeHtml(initials);
    const avatar = profile.picture
      ? `<img src="${profile.picture}" alt="${actorName}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentElement && (this.parentElement.innerHTML='<span>${safeInitials}</span>');">`
      : `<span>${safeInitials}</span>`;
    let actionText;
    let safeSnippet = '';
    if (notification.type === 'comment') {
      actionText = 'הגיב לפוסט שלך';
      if (notification.content) {
        safeSnippet = `<span class="notifications-item__snippet">${App.escapeHtml(notification.content)}</span>`;
      }
    } else if (notification.type === 'dating-like') {
      actionText = 'הראה עניין בך בדף ההכרויות';
    } else if (notification.type === 'follow') {
      actionText = 'התחיל/ה לעקוב אחריך';
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
    sortNotificationsByCreatedAt();
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

  // חלק התרעות (feed.js) – מיון רשימת ההתרעות כך שהחדשות יוצגו בראש | HYPER CORE TECH
  function sortNotificationsByCreatedAt() {
    if (!Array.isArray(App.notifications) || App.notifications.length < 2) {
      return;
    }
    App.notifications.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
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
    sortNotificationsByCreatedAt();
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

  function handleNotificationForFollow(event) {
    // חלק התרעות עוקב חדש (feed.js) – יוצר התרעה כאשר משתמש אחר מתחיל לעקוב אחרינו
    if (!event || event.kind !== FOLLOW_KIND) {
      return;
    }
    // פרשנות תוכן – אם האירוע הוא unfollow אין טעם להתריע
    try {
      const trimmed = typeof event.content === 'string' ? event.content.trim() : '';
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed.type === 'string' && parsed.type.toLowerCase() === 'unfollow') {
            return;
          }
        } catch (e) {
          const low = trimmed.toLowerCase();
          if (low === 'unfollow' || low === 'remove') {
            return;
          }
        }
      }
    } catch (e) {
      // לא קריטי – אם נכשל פרשנות נמשיך כאילו זה follow
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
    enqueueNotification(event, '', 'follow', '');
  }

  function markAllNotificationsRead(force = false) {
    // חלק התרעות (feed.js) – מפנה ל-notifications-state אם קיים, אחרת לוגיקה מקומית | HYPER CORE TECH
    if (typeof App.markAllNotificationsRead === 'function' && App.markAllNotificationsRead !== markAllNotificationsRead) {
      App.markAllNotificationsRead(force);
      return;
    }
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
    // חלק התרעות (feed.js) – מפנה ל-notifications-state אם קיים, אחרת לוגיקה מקומית | HYPER CORE TECH
    if (typeof App.markNotificationRead === 'function' && App.markNotificationRead !== markNotificationRead) {
      App.markNotificationRead(notificationId);
      return;
    }
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
      const panelHeight = panel.offsetHeight || 360;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const horizontalCenter = toggleRect.left + toggleRect.width / 2 - panelWidth / 2;
      const constrainedLeft = Math.max(8, Math.min(horizontalCenter, viewportWidth - panelWidth - 8));
      let top = toggleRect.bottom + 8;
      if (top + panelHeight > viewportHeight - 8) {
        top = toggleRect.top - panelHeight - 8;
        if (top < 8) {
          top = Math.max(8, viewportHeight - panelHeight - 8);
        }
      }
      panel.style.left = `${constrainedLeft}px`;
      panel.style.top = `${top}px`;
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
    // חלק התראות (feed.js) – מאזין לכפתור ההתראות מפנה ל-chat-ui.js שמטפל בפאנל המשולב | HYPER CORE TECH
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      // סגירת פאנל פרופיל אם פתוח | HYPER CORE TECH
      if (typeof App.closeProfilePanel === 'function') {
        App.closeProfilePanel();
      }
      // לוגיקה הגיונית: פתוח בהתראות→סגור, פתוח בשיחות→עבור להתראות, סגור→פתח התראות
      if (typeof App.openNotificationsPanel === 'function') {
        const chatState = App.chatState || {};
        if (chatState.isOpen) {
          if (chatState.footerMode === 'notifications') {
            // כבר בטאב התראות - סגור
            if (typeof App.closeNotificationsPanel === 'function') {
              App.closeNotificationsPanel();
            }
          } else {
            // בטאב אחר (שיחות) - עבור להתראות
            App.openNotificationsPanel();
          }
        } else {
          // הפאנל סגור - פתח בטאב התראות
          App.openNotificationsPanel();
        }
        return;
      }
      // fallback - פתיחת הפאנל העצמאי אם chat-ui.js לא זמין
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

  if (typeof App.getNotificationsSnapshot !== 'function') {
    App.getNotificationsSnapshot = getNotificationSnapshot;
  }
  if (typeof App.subscribeNotifications !== 'function') {
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
  }
  if (typeof App.markAllNotificationsRead !== 'function') {
    App.markAllNotificationsRead = markAllNotificationsRead;
  }
  if (typeof App.markNotificationRead !== 'function') {
    App.markNotificationRead = markNotificationRead;
  }
  App.setupNotificationUI = setupNotificationUI;
  App.restoreNotificationsFromStorage = restoreNotificationsFromStorage;

  function removePostElement(eventId) {
    if (!eventId) return;
    const element = document.querySelector(`[data-post-id="${eventId}"]`) ||
      document.querySelector(`.videos-feed__card[data-event-id="${eventId}"]`);
    if (element?.parentElement) {
      element.parentElement.removeChild(element);
    }
  }

  function logDeletionDebug(msg, extra = {}) {
    try {
      console.log('%c[DELETE_DEBUG] ' + msg, 'color: #FF5722; font-weight: bold', extra);
    } catch (err) {}
  }

  function registerDeletion(event) {
    if (!event || !Array.isArray(event.tags)) {
      logDeletionDebug('skip deletion event: missing tags', { event });
      return;
    }
    const adminKeys = App.adminPublicKeys || new Set();
    const eventPubkey = typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : '';
    const isAdmin = eventPubkey && adminKeys.has(eventPubkey);
    logDeletionDebug('incoming deletion event', {
      id: event.id,
      from: eventPubkey,
      isAdmin,
      tags: event.tags,
    });
    event.tags.forEach((tag) => {
      if (!Array.isArray(tag)) return;
      const [type, value] = tag;
      if ((type === 'e' || type === 'a') && value) {
        const author = App.eventAuthorById?.get(value)?.toLowerCase?.();
        // חלק פיד (feed.js) – מאפשר מחיקה אם:
        // 1. המוחק הוא אדמין, או
        // 2. המוחק הוא המחבר המקורי, או
        // 3. לא מכירים את המחבר (הפוסט לא נטען עדיין - נסמוך על הרילי)
        if (!isAdmin && author && author !== eventPubkey) {
          logDeletionDebug('rejected deletion (not admin/not author)', {
            eventId: value,
            eventPubkey,
            author,
          });
          return;
        }
        App.deletedEventIds.add(value);
        logDeletionDebug('accepted deletion', {
          eventId: value,
          byAdmin: isAdmin,
          author: author || '(unknown)',
          reason: isAdmin ? 'admin' : (author ? 'author' : 'unknown-trust'),
        });
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
    const statsCounter = document.querySelector(`.feed-post__like-counter[data-like-counter="${eventId}"]`);
    const postEl = document.querySelector(`.feed-post[data-post-id="${eventId}"]`);

    const likeSet = App.likesByEventId.get(eventId);
    const count = likeSet ? likeSet.size : 0;

    // עדכון מונה בכפתור הפעולה
    if (button) {
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

    if (postEl) {
      if (count > 0) {
        postEl.classList.add('feed-post--liked');
      } else {
        postEl.classList.remove('feed-post--liked');
      }
    }

    // עדכון מונה בשורת הסטטיסטיקות
    if (statsCounter) {
      if (count > 0) {
        statsCounter.textContent = String(count);
        statsCounter.style.display = '';
      } else {
        statsCounter.textContent = '';
        statsCounter.style.display = 'none';
      }
    }

    // חלק תיאטרון (feed.js) – עדכון data-likes-count בכרטיס כדי שמצב תיאטרון יקבל ערך עדכני
    const card = document.querySelector(`.home-feed__card[data-feed-card="${eventId}"]`);
    if (card) {
      card.setAttribute('data-likes-count', String(count));
    }
    if (window.PostTheaterViewer?.isOpen?.()) {
      try { window.PostTheaterViewer.refreshFromFeedCard?.(eventId); } catch (_) {}
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
        // חלק עריכה (feed.js) – מתעלמים מתגיות 'replaces' כדי שפוסט ערוך לא ייחשב תגובה
        if (marker === 'replaces') {
          continue;
        }
        if (marker === 'root') {
          return tag[1];
        }
        // נעדיף רק reply/ללא-סימון לפולבאק
        if (!fallback && (!marker || marker === 'reply')) {
          fallback = tag[1];
        }
      }
    }
    return fallback;
  }

  // חלק mirror (פיד) – טיפול בעדכון mirror לפוסט קיים
  function handleMirrorUpdate(event, parentId) {
    if (!event || !parentId) return;

    try {
      // חילוץ תגיות mirror מהאירוע
      const mirrorTags = [];
      if (Array.isArray(event.tags)) {
        event.tags.forEach(tag => {
          if (Array.isArray(tag) && tag[0] === 'mirror' && tag[1]) {
            mirrorTags.push({
              url: tag[1],
              hash: tag[2] || '',
            });
          }
        });
      }

      if (mirrorTags.length === 0) return;

      console.log(`עדכון mirrors לפוסט ${parentId.slice(0, 8)}:`, mirrorTags);

      // עדכון ה-DOM - חיפוש כל הוידאוים בפוסט
      const postElement = document.querySelector(`[data-post-id="${parentId}"]`);
      if (!postElement) return;

      const videoContainers = postElement.querySelectorAll('[data-video-url]');
      videoContainers.forEach(container => {
        const hash = container.dataset.videoHash || '';
        
        // חיפוש mirrors שמתאימים ל-hash
        const relevantMirrors = mirrorTags
          .filter(m => !m.hash || m.hash === hash)
          .map(m => m.url);
        
        if (relevantMirrors.length > 0) {
          // עדכון data-video-mirrors
          const existingMirrors = container.dataset.videoMirrors 
            ? container.dataset.videoMirrors.split(',').filter(Boolean)
            : [];
          
          const allMirrors = [...new Set([...existingMirrors, ...relevantMirrors])];
          container.dataset.videoMirrors = allMirrors.join(',');
          
          console.log(`✓ עודכנו ${relevantMirrors.length} mirrors לווידאו`);
          
          // עדכון במערכת recheck
          const url = container.dataset.videoUrl;
          const eventId = container.closest('[data-post-id]')?.dataset?.postId || null;
          if (url && typeof App.registerMediaUrl === 'function') {
            App.registerMediaUrl(url, hash, eventId, allMirrors);
          }
        }
      });
    } catch (err) {
      console.error('handleMirrorUpdate failed:', err);
    }
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
    if (typeof event.created_at === 'number' && event.created_at > App.commentLastSyncTs) {
      App.commentLastSyncTs = event.created_at;
    }
    saveCommentsToStorage();
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
    const theaterShouldRefresh = Boolean(window.PostTheaterViewer?.isOpen?.());

    if (counterEl) {
      if (comments.length > 0) {
        counterEl.textContent = String(comments.length);
        counterEl.style.display = '';
      } else {
        counterEl.textContent = '';
        counterEl.style.display = 'none';
      }
    }

    // חלק תיאטרון (feed.js) – עדכון data-comments-count בכרטיס כדי שמצב תיאטרון יקבל ערך עדכני
    const card = document.querySelector(`.home-feed__card[data-feed-card="${parentId}"]`);
    if (card) {
      card.setAttribute('data-comments-count', String(comments.length));
    }

    if (!comments.length) {
      listEl.innerHTML = '<p class="feed-comments__empty">אין תגובות עדיין. היה הראשון להגיב!</p>';
    } else {
      const fragments = [];
      for (const comment of comments) {
        // eslint-disable-next-line no-await-in-loop
        const commenterProfile = await fetchProfileWithAvatarCache(comment.pubkey);
        const normalizedCommenter = typeof comment.pubkey === 'string' ? comment.pubkey.toLowerCase() : '';
        const commenterName = App.escapeHtml(commenterProfile.name || 'משתמש');
        const attrName = (commenterProfile.name || '').replace(/"/g, '&quot;');
        const attrBio = (commenterProfile.bio || '').replace(/"/g, '&quot;');
        const attrPicture = (commenterProfile.picture || '').replace(/"/g, '&quot;');
        const profileDataset = normalizedCommenter
          ? `data-profile-link="${normalizedCommenter}" data-profile-name="${attrName}" data-profile-bio="${attrBio}" data-profile-picture="${attrPicture}"`
          : '';
        const commenterAvatarHtml = commenterProfile.picture
          ? `<div class="feed-comment__avatar" ${profileDataset}><img src="${commenterProfile.picture}" alt="${commenterName}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.display='none'; var p=this.parentElement; if(p){ p.textContent='${commenterProfile.initials}'; }"></div>`
          : `<div class="feed-comment__avatar" ${profileDataset}>${commenterProfile.initials}</div>`;
        const safeContent = App.escapeHtml(comment.content || '').replace(/\n/g, '<br>');
        const timestamp = comment.created_at ? formatTimestamp(comment.created_at) : '';
        fragments.push(`
          <article class="feed-comment">
            ${commenterAvatarHtml}
            <div class="feed-comment__body">
              <header class="feed-comment__header">
                <button class="feed-comment__author" type="button" ${profileDataset}>${commenterName}</button>
                ${timestamp ? `<time class="feed-comment__time">${timestamp}</time>` : ''}
              </header>
              <div class="feed-comment__text">${safeContent}</div>
            </div>
          </article>
        `);
      }
      listEl.innerHTML = fragments.join('');
    }

    // חלק תיאטרון (feed.js) – רענון שכבת התיאטרון רק אחרי שה-DOM מעודכן בפועל
    if (theaterShouldRefresh) {
      try { window.PostTheaterViewer.refreshFromFeedCard?.(parentId); } catch (_) {}
    }
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
    // חלק זמנים (feed.js) – פורמט בסגנון פייסבוק: 1m / 1h / 1d / Nov 1[, 2024]
    if (!seconds) return '';
    const now = Date.now();
    const ts = Math.floor(seconds * 1000);
    const diffMs = Math.max(0, now - ts);
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffMin < 1) return '1m';
    if (diffHr < 1) return `${diffMin}m`;
    if (diffDay < 1) return `${diffHr}h`;
    if (diffDay < 7) return `${diffDay}d`;

    const d = new Date(ts);
    const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    const day = d.getDate();
    const y = d.getFullYear();
    const currentYear = new Date().getFullYear();
    return y === currentYear ? `${month} ${day}` : `${month} ${day}, ${y}`;
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

  function createMediaHtml(links = [], hashMap = new Map(), mirrorsMap = new Map()) {
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
          return `<div class="feed-media"><img src="${link}" alt="תמונה מצורפת" onerror="this.parentElement.innerHTML='<div style=\\'padding:20px;text-align:center;color:#666;\\'>התמונה נחסמה על ידי ad blocker</div>'"></div>`;
        }

        if (link.startsWith('data:video') || /\.(mp4|webm|ogg)$/i.test(link)) {
          return `<div class="feed-media feed-media--video" data-video-container>
            <video src="${link}" playsinline preload="metadata"></video>
            <div class="feed-media__play-overlay" data-play-overlay>
              <i class="fa-solid fa-play"></i>
            </div>
          </div>`;
        }

        if (/^https?:\/\//i.test(link)) {
          if (link.match(/\.(mp4|webm|ogg)$/i)) {
            // חלק mirror (פיד) – וידאו עם תמיכה ב-cache, mirrors ו-fallback
            const hash = hashMap.get(link) || '';
            const mirrors = mirrorsMap.get(link) || [];
            const hashAttr = hash ? ` data-video-hash="${hash}"` : '';
            const mirrorsAttr = mirrors.length > 0 ? ` data-video-mirrors="${mirrors.join(',')}"` : '';
            return `<div class="feed-media feed-media--video" data-video-container data-video-url="${link}"${hashAttr}${mirrorsAttr}>
              <video playsinline preload="metadata"></video>
              <div class="feed-media__play-overlay" data-play-overlay>
                <i class="fa-solid fa-play"></i>
              </div>
            </div>`;
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

  // חלק infinite scroll (feed.js) – משתנים גלובליים לניהול טעינה הדרגתית
  let allFeedEvents = [];
  let displayedPostsCount = 0;
  const POSTS_PER_LOAD = 10;
  let isLoadingMore = false;

  async function displayPosts(events, append = false) {
    const stream = document.getElementById('homeFeedStream');
    if (!stream) return;

    const { container: emptyState, messageEl: emptyMessage } = getFeedEmptyState();
    const statusEl = document.getElementById('homeFeedStatus');

    if (!append && statusEl) {
      statusEl.textContent = 'טוען פוסטים...';
      statusEl.classList.add('is-visible');
    }

    if (!append) {
      // חלק ברכה (feed.js) – שמירה על כרטיס הברכה בעת ניקוי הפיד
      const welcomeCard = document.getElementById('welcomeCard');
      stream.innerHTML = '';
      if (welcomeCard) {
        stream.appendChild(welcomeCard);
      }
      allFeedEvents = events;
      displayedPostsCount = 0;
      // חלק infinite scroll (feed.js) – סידור פוסטים בפעם הראשונה בלבד
      allFeedEvents.sort((a, b) => b.created_at - a.created_at);
    }
    
    // חלק infinite scroll (feed.js) – בעת append, אנחנו משתמשים ב-allFeedEvents שכבר מסודר
    const eventsToUse = append ? allFeedEvents : events;

    const deletions = App.deletedEventIds || new Set();
    // חלק infinite scroll (feed.js) – סינון מחיקות מהרשימה הנכונה (allFeedEvents בעת append, events בפעם הראשונה)
    const visibleEvents = eventsToUse.filter((event) => !deletions.has(event.id));

    if (!visibleEvents.length) {
      // חלק ברכה (feed.js) – אם אין פוסטים, רק מסתירים את הסטטוס, הברכה כבר קיימת
      if (statusEl) {
        statusEl.classList.remove('is-visible');
      }
      return;
    }

    if (emptyState) {
      emptyState.classList.remove('feed-empty--loading');
    }

    if (statusEl) {
      statusEl.classList.remove('is-visible');
    }

    const isAdminUser =
      App.adminPublicKeys instanceof Set && typeof App.publicKey === 'string'
        ? App.adminPublicKeys.has(App.publicKey.toLowerCase())
        : false;

    // ניסיון מקדים להביא מטאדאטה של פרופילים בבאטץ' כדי לצמצם עומס ובקשות כושלות
    const uniqueAuthors = Array.from(
      new Set(
        visibleEvents
          .map((e) => (typeof e.pubkey === 'string' ? e.pubkey.toLowerCase() : ''))
          .filter(Boolean)
      )
    );
    if (
      uniqueAuthors.length > 0 &&
      App.pool &&
      Array.isArray(App.relayUrls) &&
      App.relayUrls.length > 0
    ) {
      try {
        const metas = await listMetadataBatch(uniqueAuthors);
        if (Array.isArray(metas)) {
          metas.forEach((ev) => {
            const author = typeof ev?.pubkey === 'string' ? ev.pubkey.toLowerCase() : '';
            if (!author || !ev?.content) return;
            try {
              const parsed = JSON.parse(ev.content);
              const nameField = typeof parsed.display_name === 'string' ? parsed.display_name.trim() : '';
              const name = nameField || (typeof parsed.name === 'string' ? parsed.name.trim() : '') || `משתמש ${author.slice(0, 8)}`;
              const bio = typeof parsed.about === 'string' ? parsed.about.trim() : '';
              const picture = typeof parsed.picture === 'string' ? parsed.picture.trim() : '';
              const initials = typeof App.getInitials === 'function' ? App.getInitials(name || author) : 'AN';
              const normalizedProfile = { name, bio, picture, initials };
              if (App.profileCache instanceof Map) {
                App.profileCache.set(author, normalizedProfile);
              }
              if (App.feedAuthorProfiles instanceof Map) {
                App.feedAuthorProfiles.set(author, normalizedProfile);
              }
              if (App.authorProfiles instanceof Map) {
                App.authorProfiles.set(author, normalizedProfile);
              }
              updateRenderedAuthorProfile(author, normalizedProfile);
            } catch (e) {
              // ignore malformed content
            }
          });
        }
      } catch (err) {
        console.warn('Batch metadata list failed', err);
      }
    }

    // חלק infinite scroll (feed.js) – טעינת רק מספר מוגבל של פוסטים
    const postsToDisplay = append 
      ? visibleEvents.slice(displayedPostsCount, displayedPostsCount + POSTS_PER_LOAD)
      : visibleEvents.slice(0, POSTS_PER_LOAD);
    
    console.log(`[DISPLAY POSTS] append=${append}, displayedPostsCount=${displayedPostsCount}, postsToDisplay.length=${postsToDisplay.length}, visibleEvents.length=${visibleEvents.length}`);
    displayedPostsCount = append ? displayedPostsCount + postsToDisplay.length : postsToDisplay.length;

    const profileList = await Promise.all(postsToDisplay.map((event) => fetchProfile(event.pubkey)));

    const renderedIds = [];
    postsToDisplay.forEach((event, index) => {
      const normalizedPubkey = typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : '';
      const profileData = profileList[index] || {
        name: `משתמש ${normalizedPubkey.slice(0, 8)}`,
        bio: '',
        picture: '',
        initials: typeof App.getInitials === 'function' ? App.getInitials(normalizedPubkey) : 'AN',
      };
      if (event?.id && normalizedPubkey) {
        App.eventAuthorById.set(event.id, normalizedPubkey);
        // חלק פיד (feed.js) – עדכון תמידי של פרופילים כדי להציג שינויים חדשים
        App.feedAuthorProfiles.set(normalizedPubkey, {
          name: profileData.name,
          picture: profileData.picture,
          bio: profileData.bio,
          initials: profileData.initials,
        });
      }
      App.postsById.set(event.id, event); // חלק התרעות (feed.js) – שומר את אירוע הפוסט במפה לשימוש בהתרעות
      processPendingNotifications(event.id); // חלק התרעות (feed.js) – מנסה לשחרר התרעות מושהות עבור הפוסט הזה
      const safeName = App.escapeHtml(profileData.name || '');
      const safeBio = profileData.bio ? App.escapeHtml(profileData.bio) : '';
      const article = document.createElement('article');
      article.className = 'feed-post';
      // חלק אפקטים (feed.js) – אם לפוסט יש תג fx נוסיף מאפייני DOM להפעלת CSS ממוקד
      try {
        const fxTag = Array.isArray(event.tags) ? event.tags.find((t) => Array.isArray(t) && t[0] === 'fx' && t[1]) : null;
        if (fxTag && fxTag[1]) {
          article.dataset.fx = String(fxTag[1]);
          article.classList.add('feed-post--fx');
        }
      } catch (_) {}
      article.dataset.postId = event.id;
      const lines = event.content.split('\n');
      const mediaLinks = [];
      const textLines = [];

      // חלק וידאו (feed.js) – זיהוי תגיות media ו-mirror מהאירוע
      const mediaUrlsFromTags = new Set();
      const mediaHashMap = new Map(); // מפה בין URL ל-hash
      const mediaMirrorsMap = new Map(); // מפה בין URL ל-mirrors
      try {
        if (Array.isArray(event.tags)) {
          // איסוף media tags
          event.tags.forEach(tag => {
            if (Array.isArray(tag) && tag[0] === 'media' && tag[2]) {
              // tag format: ['media', 'video/webm', url, hash]
              const url = tag[2];
              const hash = tag[3] || '';
              mediaLinks.push(url);
              mediaUrlsFromTags.add(url);
              if (hash) {
                mediaHashMap.set(url, hash);
              }
              // אתחול רשימת mirrors ריקה
              mediaMirrorsMap.set(url, []);
            }
          });
          
          // איסוף mirror tags
          event.tags.forEach(tag => {
            if (Array.isArray(tag) && tag[0] === 'mirror' && tag[1]) {
              // tag format: ['mirror', mirror_url, hash]
              const mirrorUrl = tag[1];
              const hash = tag[2] || '';
              
              // חיפוש ה-media המתאים לפי hash
              for (const [mediaUrl, mediaHash] of mediaHashMap.entries()) {
                if (hash && hash === mediaHash) {
                  const mirrors = mediaMirrorsMap.get(mediaUrl) || [];
                  mirrors.push(mirrorUrl);
                  mediaMirrorsMap.set(mediaUrl, mirrors);
                  break;
                }
              }
            }
          });
        }
      } catch (_) {}

      lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:image') || trimmed.startsWith('data:video')) {
          // מניעת כפילות - לא להוסיף אם כבר הוסף מתגיות
          if (!mediaUrlsFromTags.has(trimmed)) {
            mediaLinks.push(trimmed);
          }
        } else {
          textLines.push(trimmed);
        }
      });

      const rawTextContent = textLines.join('\n');
      // חלק אפקטים (feed.js) – אם אין תג fx אך יש media data:image, נפעיל zoomin כברירת מחדל
      try {
        const hasFx = article.classList.contains('feed-post--fx');
        const hasInlineImage = mediaLinks.some((l) => typeof l === 'string' && l.startsWith('data:image'));
        if (!hasFx && hasInlineImage) {
          article.dataset.fx = 'zoomin';
          article.classList.add('feed-post--fx');
        }
      } catch (_) {}
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
      const mediaHtml = createMediaHtml(mediaLinks, mediaHashMap, mediaMirrorsMap);
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
      const targetPubkey = normalizedPubkey || (typeof event.pubkey === 'string' ? event.pubkey : '');
      const profileDataset = `data-profile-link="${targetPubkey}" data-profile-name="${attrName}" data-profile-bio="${attrBio}" data-profile-picture="${attrPicture}"`;
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
      const canEdit = ownPost;
      const editButtonHtml = canEdit
        ? `
          <button class="feed-post__action feed-post__action--edit" type="button" onclick="NostrApp.openEditPost('${event.id}')">
            <i class="fa-solid fa-pen-to-square"></i>
            <span>ערוך</span>
          </button>
        `
        : '';
      const deleteButtonHtml = canDelete
        ? `
          <button class="feed-post__action feed-post__action--delete" type="button" onclick="NostrApp.deletePost('${event.id}')">
            <i class="fa-solid fa-trash"></i>
            <span>מחק</span>
          </button>
        `
        : '';

      // חלק כפתור עליון – אם זה פוסט של המשתמש, נציג כפתור 3 נקודות במקום כפתור עקוב
      const headerActionHtml = ownPost
        ? `
          <div class="feed-post__menu-wrap" style="position:relative;">
            <button class="feed-post__menu-toggle" type="button" aria-haspopup="true" aria-expanded="false" data-post-menu-toggle="${event.id}" title="אפשרויות">
              <i class="fa-solid fa-ellipsis"></i>
            </button>
            <div class="feed-post__menu" data-post-menu="${event.id}" hidden style="position:absolute; top:36px; inset-inline-end:0; min-width: 140px; background: var(--card); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.35); z-index:5;">
              ${editButtonHtml}
              ${deleteButtonHtml}
            </div>
          </div>
        `
        : followButtonHtml;
      if (!App.commentsByParent.has(event.id)) {
        App.commentsByParent.set(event.id, new Map());
      }
      const commentCount = App.commentsByParent.get(event.id)?.size || 0;
      const viewerProfile = App.profile || {};
      const viewerName = viewerProfile.name || 'אני';
      const viewerInitials = typeof App.getInitials === 'function' ? App.getInitials(viewerName) : viewerName.slice(0, 2).toUpperCase();
      const viewerAvatar = viewerProfile.picture
        ? `<img src="${viewerProfile.picture}" alt="${App.escapeHtml(viewerName)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.display='none'; var p=this.parentElement; if(p){ p.innerHTML='<span>${App.escapeHtml(viewerInitials)}</span>'; }">`
        : `<span>${App.escapeHtml(viewerInitials)}</span>`;

      const clickOpen = `onclick="if(window.openProfileByPubkey){ window.openProfileByPubkey('${targetPubkey}'); }"`;
      const avatar = profileData.picture
        ? `<button class="feed-post__avatar" type="button" ${profileDataset} ${clickOpen}><img src="${profileData.picture}" alt="${safeName}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.display='none'; var p=this.parentElement; if(p){ p.textContent='${profileData.initials}'; }"></button>`
        : `<button class="feed-post__avatar" type="button" ${profileDataset} ${clickOpen}>${profileData.initials}</button>`;

      article.innerHTML = `
        <header class="feed-post__header">
          ${avatar}
          <div class="feed-post__info">
            <button class="feed-post__name" type="button" ${profileDataset} ${clickOpen}>${safeName}</button>
            ${metaHtml ? `<span class="feed-post__meta">${metaHtml}</span>` : ''}
          </div>
          ${headerActionHtml}
        </header>
        ${safeContent ? `<div class="${contentClass}" data-post-content="${event.id}">${safeContent}</div>` : ''}
        ${showMoreHtml}
        ${mediaHtml ? `<div class="feed-post__media">${mediaHtml}</div>` : ''}
        <div class="feed-post__actions">
          <button class="feed-post__action" type="button" data-comments-toggle="${event.id}">
            <i class="fa-regular fa-message"></i>
            <span>תגובות</span>
            <span class="feed-post__comment-count" data-comment-count="${event.id}" ${commentCount ? '' : 'style=\"display:none;\"'}>${commentCount || ''}</span>
          </button>
          <button class="feed-post__action" type="button" data-like-button data-event-id="${event.id}" onclick="NostrApp.likePost('${event.id}')">
            <i class="fa-regular fa-thumbs-up"></i>
            <span>אהבתי</span>
            <span class="feed-post__like-count" ${likeCount ? '' : 'style=\"display:none;\"'}>${likeCount || ''}</span>
          </button>
          <button class="feed-post__action" type="button" onclick="NostrApp.sharePost('${event.id}')">
            <i class="fa-solid fa-share"></i>
            <span>שתף</span>
          </button>
          ${ownPost ? '' : `${deleteButtonHtml}`}
        </div>
        <section class="feed-comments" data-comments-section="${event.id}">
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
      if (likeCount > 0) {
        article.classList.add('feed-post--liked'); // חלק הדגשה (feed.js) – סימון מראש לפוסטים שכבר קיבלו לייקים
      }

      const cardWrapper = document.createElement('div');
      cardWrapper.className = 'home-feed__card';
      cardWrapper.setAttribute('data-feed-card', event.id);
      // חלק תיאטרון (feed.js) – שמירת נתוני פוסט בdata-attributes לשימוש במצב תיאטרון
      cardWrapper.setAttribute('data-author-name', profileData.name || '');
      cardWrapper.setAttribute('data-author-picture', profileData.picture || '');
      cardWrapper.setAttribute('data-created-at', String(event.created_at || 0));
      cardWrapper.setAttribute('data-likes-count', String(likeCount || 0));
      cardWrapper.setAttribute('data-comments-count', String(commentCount || 0));
      cardWrapper.setAttribute('data-shares-count', '0');
      cardWrapper.appendChild(article);

      stream.appendChild(cardWrapper);
      renderedIds.push(event.id);
      // חלק טעינה – עדכון אחוזים תוך כדי רינדור הסט הראשון בלבד
      if (!append) {
        try {
          const total = Math.max(1, Math.min(POSTS_PER_LOAD, visibleEvents.length));
          const progressBase = 55; // אחרי ליסטינג מהריליי
          const progressSpan = 30; // עד 85%
          const ratio = Math.min(1, (index + 1) / total);
          setWelcomeLoading(Math.floor(progressBase + ratio * progressSpan));
        } catch (_) {}
      }
      updateLikeIndicator(event.id);
      wireCommentForm(article, event.id);
      wirePostMenu(article, event.id);
      hydrateCommentsSection(article, event.id);
      wireShowMore(article, event.id);
      if (typeof App.refreshFollowButtons === 'function') {
        App.refreshFollowButtons(article);
      }
    });

    // מנוי לייקים לפי מזהה פוסט (#e) עבור הסט שזה עתה רונדר – כדי להציג ספירות מלאות
    subscribeLikesForPosts(renderedIds);

    // חלק cache (פיד) – אתחול טעינת וידאו לכל הפוסטים
    initVideoLoading();
    setTimeout(() => setupHomeFeedObserver(), 50);
    wireHomeFeedInteractions();
    // התאמות UI מובייל לפעולות ותגובות
    applyMobilePostUiStyles();

    // סימון סיום רינדור סט ראשון
    if (!append) {
      App._firstBatchRenderComplete = true;
    }

    // סיום הטעינה רק לאחר הופעה/נראות בפועל של הכרטיס הראשון והמדיה בו
    if (!App._homeFeedFirstBatchShown) {
      setWelcomeLoading(95);
      setWelcomeStatus('מסיים רינדור...');
      scheduleWelcomeFallback();
      // חלק טעינה (feed.js) – המתנה לצביעה של הפוסט הראשון ולהכנת המדיה
      Promise.race([
        waitForFirstPostPaint({ timeout: 5000 })
      ]).then(() => {
        awaitFirstPostMediaReady({ timeout: 2500 })
          .then(() => finishWelcomeIfReady())
          .catch(() => finishWelcomeIfReady());
      }).catch(() => finishWelcomeIfReady());
    }

    // חלק פרופילים (feed.js) – עדכון פרופילים מה-relays אחרי יצירת הפוסטים
    if (uniqueAuthors.length > 0 && App.pool && Array.isArray(App.relayUrls) && App.relayUrls.length > 0) {
      try {
        const freshMetas = await listMetadataBatch(uniqueAuthors);
        if (Array.isArray(freshMetas)) {
          freshMetas.forEach((ev) => {
            const author = typeof ev?.pubkey === 'string' ? ev.pubkey.toLowerCase() : '';
            if (!author || !ev?.content) return;
            try {
              const parsed = JSON.parse(ev.content);
              const nameField = typeof parsed.display_name === 'string' ? parsed.display_name.trim() : '';
              const name = nameField || (typeof parsed.name === 'string' ? parsed.name.trim() : '') || `משתמש ${author.slice(0, 8)}`;
              const bio = typeof parsed.about === 'string' ? parsed.about.trim() : '';
              const picture = typeof parsed.picture === 'string' ? parsed.picture.trim() : '';
              const initials = typeof App.getInitials === 'function' ? App.getInitials(name || author) : 'AN';
              const normalizedProfile = { name, bio, picture, initials };
              if (App.profileCache instanceof Map) {
                App.profileCache.set(author, normalizedProfile);
              }
              if (App.feedAuthorProfiles instanceof Map) {
                App.feedAuthorProfiles.set(author, normalizedProfile);
              }
              if (App.authorProfiles instanceof Map) {
                App.authorProfiles.set(author, normalizedProfile);
              }
              // עדכון הפוסטים הקיימים ב-DOM
              updateRenderedAuthorProfile(author, normalizedProfile);
            } catch (e) {
              // ignore malformed content
            }
          });
        }
      } catch (err) {
        console.warn('Post-render metadata update failed', err);
      }
    }
    
    // חלק שמירת state (feed.js) – שמירת state לחזרה בין עמודים
    window._allFeedEvents = allFeedEvents;
    window._displayedPostsCount = displayedPostsCount;
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
    // לחיצה על כפתור תגובות תפתח את מצב התיאטרון עם פוקוס על שדה התגובה
    toggle.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        const card = articleEl.closest('.home-feed__card');
        if (card) {
          // עצירת וידאו מתנגן בפוסט המקורי
          try {
            const playing = articleEl.querySelector('video');
            if (playing && !playing.paused) {
              playing.pause();
              try { playing.currentTime = 0; } catch (_) {}
            }
          } catch (_) {}
          // פתיחת התיאטרון עם סימון לפוקוס על תגובה
          await ensureTheaterAssetsLoaded();
          if (window.PostTheaterViewer) {
            const data = buildTheaterPostDataFromCard(card);
            data.focusComment = true; // סימון לפוקוס על שדה התגובה
            window.PostTheaterViewer.open(data);
          }
        }
      } catch (_) {}
    });
    // פתיחה וטעינה ראשונית
    section.removeAttribute('hidden');
    updateCommentsForParent(parentId);
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

  // חלק פיד (feed.js) – בניית פילטרים מרכזיים לפיד ולהתרעות | HYPER CORE TECH
function buildCoreFeedFilters(sinceTimestamp = 0) {
  const baseFilter = { kinds: [1], '#t': [App.NETWORK_TAG], limit: 200 };
  if (sinceTimestamp > 0) baseFilter.since = sinceTimestamp;
  const filters = [baseFilter];
  const viewerKey = typeof App.publicKey === 'string' ? App.publicKey : '';
  if (viewerKey) {
    filters.push({ kinds: [1], authors: [viewerKey], limit: 50 });
  }
  const deletionAuthors = new Set();
  if (viewerKey) {
    deletionAuthors.add(viewerKey.toLowerCase());
  }
  if (App.adminPublicKeys instanceof Set) {
    App.adminPublicKeys.forEach((key) => {
      if (typeof key === 'string' && key) {
        deletionAuthors.add(key.toLowerCase());
      }
    });
  }
  // תמיד מביאים מחיקות לפי תגית רשת כדי לקבל מחיקות מכל המשתמשים
  filters.push({ kinds: [5], '#t': [App.NETWORK_TAG], limit: 200 });
  // בנוסף, מביאים מחיקות ספציפיות מאדמינים (גם אם אין להם תגית רשת)
  if (deletionAuthors.size > 0) {
    filters.push({ kinds: [5], authors: Array.from(deletionAuthors), limit: 100 });
  }
  filters.push({ kinds: [7], '#t': [App.NETWORK_TAG], limit: 500 });
  if (viewerKey) {
    const datingFilter = { kinds: [DATING_LIKE_KIND], '#p': [viewerKey], limit: 200 };
    if (App.NETWORK_TAG) {
      datingFilter['#t'] = [App.NETWORK_TAG];
    }
    filters.push(datingFilter);
    const followFilter = { kinds: [FOLLOW_KIND], '#p': [viewerKey], limit: 200 };
    filters.push(followFilter);
  }
  return filters;
}

async function loadFeed() {
    // מניעת כפל טעינה
    if (App._homeFeedLoadingInProgress) {
      return;
    }
    App._homeFeedLoadingInProgress = true;
    
    // חלק שמירת state (feed.js) – בדיקה אם הפיד כבר טוען וחוזרים אליו מעמוד אחר
    const isReturningToFeed = App._homeFeedFirstBatchShown === true && allFeedEvents && allFeedEvents.length > 0;
    
    console.log(`[FEED STATE] isReturningToFeed=${isReturningToFeed}, _homeFeedFirstBatchShown=${App._homeFeedFirstBatchShown}, allFeedEvents.length=${allFeedEvents?.length || 0}`);
    
    if (!isReturningToFeed) {
      App._homeFeedFirstBatchShown = false;
    }
    
    App._homeFeedRetryCount = typeof App._homeFeedRetryCount === 'number' ? App._homeFeedRetryCount : 0;
    // מצב טעינה: נעל גלילה ב-viewport והצג מד טעינה בברכה
    if (!isReturningToFeed) {
      document.body.classList.add('home-feed--loading');
      document.documentElement.classList.add('home-feed--loading');
      setWelcomeLoading(1);
      setWelcomeStatus('מתחבר לריליים...');
      bindLoadingGuards();
    }
    try {
      const vp = document.querySelector('.home-feed__viewport');
      if (vp && !isReturningToFeed) vp.scrollTop = 0;
    } catch (_) {}
    // טיימר התקדמות מדומה עד שנקבל נתונים מהריליים (מגביל ל-85%)
    if (!isReturningToFeed) {
      if (_welcomeProgressTimer) {
        clearInterval(_welcomeProgressTimer);
      }
      _welcomeProgressTimer = setInterval(() => {
        const cap = App._homeFeedFirstBatchShown ? 100 : 95;
        const target = Math.min(cap, (_welcomeProgressValue || 0) + 1);
        setWelcomeLoading(target);
        if (!App._homeFeedFirstBatchShown && target >= 95) {
          clearInterval(_welcomeProgressTimer);
          _welcomeProgressTimer = null;
        }
      }, 180);
    }
    // ודא שהניווט לפרופיל ציבורי פעיל תמיד, גם אם ה-Pool טרם מאותחל
    ensureProfileLinkNavigation();
    if (!App.pool) {
      // אם ה-Pool עדיין לא מאותחל – ננסה שוב בקרוב ונציג התקדמות ראשונית
      if (!isReturningToFeed) {
        setWelcomeLoading(10);
        setWelcomeStatus('מאתחל חיבור...');
      }
      setTimeout(() => {
        if (!App._homeFeedLoadingInProgress && typeof App.loadFeed === 'function') {
          App.loadFeed();
        }
      }, 250);
      App._homeFeedLoadingInProgress = false;
      return;
    }

    const feed = document.getElementById('feed');
    const { container: emptyState, messageEl: emptyMessage } = getFeedEmptyState();
    if (feed && emptyState && !isReturningToFeed) {
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
      statusEl.style.display = 'none';
    }
    // חלק שמירת state (feed.js) – אל תאפס את הנתונים אם חוזרים לפיד
    if (!isReturningToFeed) {
      App.deletedEventIds = new Set();
      App.likesByEventId = new Map();
      App.commentsByParent = new Map();
    }

    // חלק חזרה לפיד (feed.js) – אם יש state שמור, רנדר מיד את הפוסטים ושחרר את מסך הברכה
    if (isReturningToFeed && Array.isArray(window._allFeedEvents) && window._allFeedEvents.length > 0) {
      try {
        // ודא שהברכה לא חוסמת
        App._homeFeedFirstBatchShown = true;
        endWelcomeLoading();
        setWelcomeLoading(100);

        // רנדר מחדש את הסטים השמורים
        const savedCount = typeof window._displayedPostsCount === 'number' ? window._displayedPostsCount : POSTS_PER_LOAD;
        // רענן DOM עם הסט הראשון
        await displayPosts(window._allFeedEvents, false);
        // הוסף עוד סטים עד שמגיעים למספר שנשמר
        while (typeof displayedPostsCount === 'number' && displayedPostsCount < savedCount) {
          await displayPosts(window._allFeedEvents, true);
        }
        // הפעל אינסוף גלילה וחזור
        setupInfiniteScroll();
        App._homeFeedLoadingInProgress = false;
        return;
      } catch (e) {
        console.warn('Failed to restore feed state, falling back to fresh load', e);
      }
    }
    
    // חלק First Paint (feed.js) – טעינה מהירה מ-EventSync cache לפני פנייה לריליי | HYPER CORE TECH
    let cachedFirstPaint = false;
    if (!App._homeFeedFirstBatchShown && App.EventSync?.loadCachedEvents) {
      try {
        const cachedPosts = await App.EventSync.loadCachedEvents({ kinds: [1], limit: 30 });
        const validPosts = cachedPosts.filter(e => !extractParentId(e));
        if (validPosts.length >= 5) {
          console.log('[FEED CACHE] First paint from cache:', validPosts.length, 'posts');
          setWelcomeLoading(50);
          setWelcomeStatus('טוען מהמטמון...');
          await displayPosts(validPosts);
          cachedFirstPaint = true;
          // טעינת לייקים/תגובות מהקאש ברקע
          const postIds = validPosts.map(p => p.id);
          App.EventSync.loadEngagementForPosts(postIds).then(({ likes, comments }) => {
            likes.forEach(like => registerLike(like));
            comments.forEach(comment => {
              const parentId = extractParentId(comment);
              if (parentId) registerComment(comment, parentId);
            });
            validPosts.forEach(p => {
              if (typeof App.updateLikeIndicator === 'function') App.updateLikeIndicator(p.id);
              if (typeof App.updateCommentsForParent === 'function') App.updateCommentsForParent(p.id);
            });
          }).catch(() => {});
        }
      } catch (cacheErr) {
        console.warn('[FEED CACHE] Failed to load from cache', cacheErr);
      }
    }
    
    // חלק פיד (feed.js) – מסננים: פוסטים עיקריים לפי תג רשת, ובנוסף פוסטים של המשתמש הנוכחי גם אם חסר תג
    // אם יש כבר פוסטים מהקאש, נבקש רק חדשים (delta sync)
    const sinceTime = cachedFirstPaint && allFeedEvents?.length > 0 
      ? Math.max(...allFeedEvents.map(e => e.created_at || 0)) - 60 
      : 0;
    const filters = buildCoreFeedFilters(sinceTime);
    const events = [];
    const seenEventIds = new Set();
    // אם יש כבר פוסטים מהקאש, נוסיף אותם ל-seen כדי לא לכפול
    if (cachedFirstPaint && allFeedEvents) {
      allFeedEvents.forEach(e => seenEventIds.add(e.id));
    }
    try {
      console.log('%c[DELETE_DEBUG] feed filters', 'color: #FF5722; font-weight: bold', filters);
    } catch (_) {}

    if (typeof App.pool.list === 'function') {
      try {
        setWelcomeLoading(25);
        setWelcomeStatus('מקבל אירועים...');
        const initialEvents = await App.pool.list(App.relayUrls, filters);
        if (Array.isArray(initialEvents)) {
          setWelcomeLoading(45);
          initialEvents.forEach((event) => {
            if (!event || seenEventIds.has(event.id)) {
              return;
            }
            seenEventIds.add(event.id);
            // חלק cache (feed.js) – שמירת אירועים ב-EventSync לשימוש חוזר | HYPER CORE TECH
            if (App.EventSync?.ingestEvent) {
              App.EventSync.ingestEvent(event, { source: 'feed-initial' });
            }
            if (event.kind === 1) {
              const parentId = extractParentId(event);
              if (parentId) {
                // בדיקה אם זה mirror update
                const hasMirrorTag = Array.isArray(event.tags) && event.tags.some(tag => 
                  Array.isArray(tag) && tag[0] === 'mirror'
                );
                
                if (hasMirrorTag) {
                  // זה mirror update - נעדכן את ה-mirrors בפוסט המקורי
                  handleMirrorUpdate(event, parentId);
                } else {
                  // תגובה רגילה
                  registerComment(event, parentId);
                }
              } else {
                events.push(event);
              }
              return;
            }
            if (event.kind === 5) {
              logDeletionDebug('initial load deletion event', {
                id: event.id,
                pubkey: event.pubkey,
                tags: event.tags
              });
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
            if (event.kind === FOLLOW_KIND) {
              handleNotificationForFollow(event);
              return;
            }
            events.push(event);
          });
          if (events.length > 0 && !App._homeFeedFirstBatchShown) {
            setWelcomeLoading(65);
            setWelcomeStatus('מרנדר פוסטים...');
            await displayPosts(events);
            // חלק הידרציה (feed.js) – טעינת לייקים ותגובות מיד אחרי רינדור | HYPER CORE TECH
            if (typeof App.hydrateEngagementForPosts === 'function') {
              App.hydrateEngagementForPosts(events, extractParentId).then(() => {
                events.forEach(e => {
                  if (e?.id) {
                    updateLikeIndicator(e.id);
                    if (typeof App.updateCommentsForParent === 'function') {
                      App.updateCommentsForParent(e.id);
                    }
                  }
                });
              }).catch(() => {});
            }
            // חלק Follow (feed.js) – רענון כפתורי Follow מיד אחרי רינדור | HYPER CORE TECH
            if (typeof App.refreshFollowButtons === 'function') {
              App.refreshFollowButtons();
            }
            if (emptyState && emptyMessage?.dataset?.defaultText) {
              emptyMessage.textContent = emptyMessage.dataset.defaultText;
              emptyState.classList.remove('feed-empty--loading');
            }
          }
        }
      } catch (err) {
        console.warn('Initial feed list failed', err);
        App._homeFeedLoadingInProgress = false;
      }
    }

    const sub = App.pool.subscribeMany(App.relayUrls, filters, {
      onevent: async (event) => {
        if (!event || seenEventIds.has(event.id)) {
          if (event?.kind === 1) {
            const parentId = extractParentId(event);
            if (parentId) {
              registerComment(event, parentId);
            }
          }
          return;
        }
        seenEventIds.add(event.id);
        // חלק cache (feed.js) – שמירת אירועים מ-subscription ב-EventSync | HYPER CORE TECH
        if (App.EventSync?.ingestEvent) {
          App.EventSync.ingestEvent(event, { source: 'feed-subscription' });
        }
        if (event.kind === 1) {
          const parentId = extractParentId(event);
          if (parentId) {
            registerComment(event, parentId);
          } else {
            events.push(event);
            // חלק שמירת state (feed.js) – הוספת פוסט חדש בזמן אמת ללא רענון
            if (App._homeFeedFirstBatchShown && allFeedEvents) {
              allFeedEvents.unshift(event);
              // הצגת הפוסט החדש בתחילת הפיד
              const stream = document.getElementById('homeFeedStream');
              if (stream && stream.children.length > 1) {
                // יש כבר פוסטים מוצגים, הוסף את החדש בתחילה (אחרי כרטיס הברכה)
                const welcomeCard = document.getElementById('welcomeCard');
                const insertAfter = welcomeCard || stream.children[0];
                const newPostElement = await renderNewPost(event);
                if (newPostElement && insertAfter) {
                  insertAfter.parentNode.insertBefore(newPostElement, insertAfter.nextSibling);
                }
              }
            }
          }
          return;
        }
        if (event.kind === 5) {
          logDeletionDebug('realtime deletion received via subscription', {
            id: event.id,
            pubkey: event.pubkey,
            tags: event.tags,
            created_at: event.created_at
          });
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
        if (event.kind === FOLLOW_KIND) {
          handleNotificationForFollow(event);
          return;
        }
        events.push(event);
        if (emptyState && emptyMessage) {
          emptyMessage.textContent = `מעדכן פוסטים... התקבלו ${events.length} פוסטים`;
        }
      },
      oneose: async () => {
        // אם טרם הצגנו – הצג כעת את הסט הראשון ושחרר טעינה
        if (!App._homeFeedFirstBatchShown && events && events.length > 0) {
          setWelcomeLoading(85);
          setWelcomeStatus('מסיים רינדור...');
          await displayPosts(events);
        } else {
          // אין פוסטים – נשארים במצב טעינה וננסה שוב עם backoff
          try {
            const statusEl = document.getElementById('homeFeedStatus');
            if (statusEl) {
              statusEl.textContent = 'טוען פוסטים...';
              statusEl.classList.add('is-visible');
            }
          } catch (_) {}
          setWelcomeStatus('מנסה שוב להביא פוסטים...');
          App._homeFeedLoadingInProgress = false;
          const backoff = Math.min(3000, 500 + (App._homeFeedRetryCount || 0) * 250);
          App._homeFeedRetryCount = (App._homeFeedRetryCount || 0) + 1;
          setTimeout(() => {
            if (!App._homeFeedFirstBatchShown && typeof App.loadFeed === 'function') {
              App.loadFeed();
            }
          }, backoff);
        }
        if (emptyState && emptyMessage?.dataset?.defaultText) {
          emptyMessage.textContent = emptyMessage.dataset.defaultText;
          emptyState.classList.remove('feed-empty--loading');
        }
        // חלק infinite scroll (feed.js) – הוספת מאזין גלילה
        setupInfiniteScroll();
      },
    });

    setTimeout(() => sub.close(), 5000);
  }

  

  // חלק שמירת state (feed.js) – פונקציה להצגת פוסט חדש בזמן אמת
  async function renderNewPost(event) {
    try {
      const profileData = await fetchProfile(event.pubkey);
      const normalizedPubkey = typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : '';
      const safeName = profileData?.name || `משתמש ${normalizedPubkey.slice(0, 8)}`;
      const profileDataset = `data-profile-pubkey="${normalizedPubkey}"`;
      const clickOpen = `onclick="if(window.openProfileByPubkey){ window.openProfileByPubkey('${normalizedPubkey}'); }"`;
      const avatar = profileData?.picture
        ? `<button class="feed-post__avatar" type="button" ${profileDataset} ${clickOpen}><img src="${profileData.picture}" alt="${safeName}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.display='none'; var p=this.parentElement; if(p){ p.textContent='${profileData.initials}'; }"></button>`
        : `<button class="feed-post__avatar" type="button" ${profileDataset} ${clickOpen}>${profileData.initials}</button>`;
      
      const cardWrapper = document.createElement('div');
      cardWrapper.className = 'home-feed__card in-view';
      
      const article = document.createElement('article');
      article.className = 'feed-post feed-post--fx';
      article.dataset.eventId = event.id;
      
      const safeContent = App.escapeHtml(event.content || '');
      const metaHtml = formatTimestamp(event.created_at);
      
      article.innerHTML = `
        <header class="feed-post__header">
          ${avatar}
          <div class="feed-post__info">
            <button class="feed-post__name" type="button" ${profileDataset} ${clickOpen}>${safeName}</button>
            ${metaHtml ? `<span class="feed-post__meta">${metaHtml}</span>` : ''}
          </div>
        </header>
        ${safeContent ? `<div class="feed-post__content" data-post-content="${event.id}">${safeContent}</div>` : ''}
        <div class="feed-post__actions">
          <button class="feed-post__action" type="button" data-comments-toggle="${event.id}">
            <i class="fa-regular fa-message"></i>
            <span>תגובות</span>
            <span class="feed-post__comment-count" data-comment-count="${event.id}" style="display:none;">0</span>
          </button>
          <button class="feed-post__action" type="button" data-like-button data-event-id="${event.id}" onclick="NostrApp.likePost('${event.id}')">
            <i class="fa-regular fa-thumbs-up"></i>
            <span>אהבתי</span>
            <span class="feed-post__like-count" style="display:none;">0</span>
          </button>
          <button class="feed-post__action" type="button" onclick="NostrApp.sharePost('${event.id}')">
            <i class="fa-solid fa-share"></i>
            <span>שתף</span>
          </button>
        </div>
        <section class="feed-comments" data-comments-section="${event.id}">
          <div class="feed-comments__list" data-comments-list="${event.id}"></div>
        </section>
      `;
      
      cardWrapper.appendChild(article);
      updateLikeIndicator(event.id);
      wireCommentForm(article, event.id);
      wirePostMenu(article, event.id);
      hydrateCommentsSection(article, event.id);
      wireShowMore(article, event.id);
      if (typeof App.refreshFollowButtons === 'function') {
        App.refreshFollowButtons(article);
      }
      
      return cardWrapper;
    } catch (err) {
      console.warn('Failed to render new post:', err);
      return null;
    }
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

    // חלק פרסום (feed.js) – מבטיחים שתמיד יצורף תג רשת תקין לפוסט
    const networkTag = typeof App.NETWORK_TAG === 'string' && App.NETWORK_TAG ? App.NETWORK_TAG : 'israel-network';
    // ודאות: אם יש dataUrl במדיה והוא לא נכלל ב-content, נוסיף אותו בתחילת התוכן
    try {
      const mediaUrl = App.composeState?.media?.dataUrl;
      if (typeof mediaUrl === 'string' && mediaUrl.startsWith('data:')) {
        const alreadyHas = typeof payload.content === 'string' && payload.content.includes(mediaUrl);
        if (!alreadyHas) {
          payload.content = mediaUrl + (payload.text ? `\n${payload.text}` : '');
        }
      }
    } catch (_) {}

    const draft = {
      kind: 1,
      pubkey: App.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', networkTag]],
      content: payload.content,
    };
    if (App.composeState && App.composeState.fx) {
      draft.tags.push(['fx', String(App.composeState.fx)]);
    }
    // חלק וידאו (feed.js) – הוספת תגיות media לוידאו
    if (Array.isArray(payload.mediaTags) && payload.mediaTags.length > 0) {
      payload.mediaTags.forEach(tag => draft.tags.push(tag));
    }
    // חלק עריכה (feed.js) – אם מדובר בעריכה, מוסיפים תג שמקשר לפוסט המקורי לצורך עקיבות
    if (payload.originalId) {
      draft.tags.push(['e', payload.originalId, '', 'replaces']);
    }
    const event = App.finalizeEvent(draft, App.privateKey);

    try {
      await App.pool.publish(App.relayUrls, event);
      console.log('Published event');
      document.getElementById('connection-status').textContent = 'הפוסט פורסם!';
      App.setComposeStatus?.('הפוסט פורסם בהצלחה.');
      // עצירת אנימציית העיבוד
      try { if (typeof window.stopProcessingAnimation === 'function') window.stopProcessingAnimation(); } catch (_) {}
    } catch (e) {
      console.error('Publish error', e);
      document.getElementById('connection-status').textContent = 'הפרסום נכשל. נסה שוב.';
      App.setComposeStatus?.('שגיאה בפרסום. נסה שוב מאוחר יותר.', 'error');
      // עצירת אנימציית העיבוד גם במקרה של שגיאה
      try { if (typeof window.stopProcessingAnimation === 'function') window.stopProcessingAnimation(); } catch (_) {}
      return;
    }

    // חלק עריכה (feed.js) – לאחר פרסום מוצלח, אם זה עריכה, מוחקים בשקט את המקור ומרעננים
    if (payload.originalId) {
      try {
        await deletePostQuiet(payload.originalId);
      } catch (err) {
        console.warn('Quiet delete failed after edit', err);
      }
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

  function logDeletionPublish(msg, extra = {}) {
    try {
      console.log('%c[DELETE_PUBLISH] ' + msg, 'color: #E91E63; font-weight: bold', extra);
    } catch (err) {}
  }

  async function deletePostQuiet(eventId) {
    // חלק מחיקה שקטה (feed.js) – מוחק פוסט בלי אישור/הודעות UI לשמירה על יציבות
    if (!eventId) {
      return;
    }
    if (!App.pool || typeof App.finalizeEvent !== 'function') {
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
      logDeletionPublish('publishing delete (quiet)', { eventId, relays: App.relayUrls });
      await App.pool.publish(App.relayUrls, event);
      App.deletedEventIds.add(eventId);
      removePostElement(eventId);
      logDeletionPublish('delete published (quiet)', { eventId });
    } catch (e) {
      // מחיקה שקטה – לא מפוצצים UI
      console.warn('Quiet delete publish error', e);
    }
  }

  function openEditPost(eventId) {
    // חלק עריכה (feed.js) – פותח קומפוזר עם תוכן ומדיה קיימים ומסמן מזהה מקורי
    try {
      if (!eventId || typeof App.setComposeDraft !== 'function') {
        return;
      }
      const ev = App.postsById?.get?.(eventId);
      if (!ev || typeof ev.content !== 'string') {
        return;
      }
      const lines = ev.content.split('\n');
      let media = null;
      for (const line of lines) {
        if (typeof line === 'string' && (line.startsWith('data:image/') || line.startsWith('data:video/'))) {
          media = line;
          break;
        }
      }
      const text = lines.filter((l) => l && l !== media).join('\n');
      App.setComposeDraft(text, media, eventId);
    } catch (err) {
      console.warn('openEditPost failed', err);
    }
  }

  // חלק mirror (פיד) – טעינת וידאו עם cache, mirrors ו-fallback + P2P
  // חלק Network Tiers (פיד) – מונה גלובלי לאינדקס פוסטים בטעינה | HYPER CORE TECH
  let globalVideoLoadIndex = 0;

  async function loadVideoWithCache(videoElement, url, hash, mirrors = []) {
    // חלק Network Tiers (פיד) – קבלת אינדקס פוסט נוכחי | HYPER CORE TECH
    const currentPostIndex = globalVideoLoadIndex++;
    
    try {
      // חלק P2P (פיד) – ניסיון הורדה דרך P2P
      if (hash && typeof App.downloadVideoWithP2P === 'function') {
        try {
          const p2pResult = await App.downloadVideoWithP2P(url, hash, 'video/webm', { postIndex: currentPostIndex });
          
          if (p2pResult && p2pResult.blob) {
            // אם זה URL ישיר (עקיפת CORS), נשתמש בו ישירות
            if (p2pResult.blob._directUrl) {
              videoElement.src = p2pResult.blob._directUrl;
            } else {
              const objectUrl = URL.createObjectURL(p2pResult.blob);
              videoElement.src = objectUrl;
            }
            // מחזיר אובייקט עם source כדי שהקורא ידע אם נטען מ-cache
            return { success: true, source: p2pResult.source || 'network' };
          }
        } catch (p2pErr) {
          // fallback יטופל למטה
        }
      }
      
      // שימוש במערכת ה-fallback המלאה
      if (typeof App.loadMediaWithFallback === 'function') {
        const result = await App.loadMediaWithFallback(url, mirrors, hash);
        
        if (result.success && result.blob) {
          const objectUrl = URL.createObjectURL(result.blob);
          videoElement.src = objectUrl;
          
          console.log(`וידאו נטען מ-${result.source}:`, result.url || url);
          return { success: true, source: result.source || 'network' };
        }
        
        console.error('כל ה-URLs נכשלו');
        return { success: false, source: 'none' };
      }

      // Fallback לשיטה הישנה אם המודול לא זמין
      if (hash && typeof App.getCachedMedia === 'function') {
        const cached = await App.getCachedMedia(hash);
        if (cached && cached.blob) {
          const objectUrl = URL.createObjectURL(cached.blob);
          videoElement.src = objectUrl;
          console.log('וידאו נטען מ-cache:', hash.slice(0, 16));
          return { success: true, source: 'cache' };
        }
      }

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      videoElement.src = objectUrl;

      if (hash && typeof App.cacheMedia === 'function') {
        App.cacheMedia(url, hash, blob, blob.type).catch(err => {
          console.warn('Failed to cache video', err);
        });
      }

      console.log('וידאו נטען מהרשת:', url);
      return { success: true, source: 'network' };
    } catch (err) {
      console.error('נכשלה טעינת וידאו:', err);
      return { success: false, source: 'none' };
    }
  }

  // חלק recheck (פיד) – אתחול טעינת וידאו עם mirrors ורישום ל-recheck
  // חלק Network Tiers (פיד) – תור טעינה סדרתית במצב BOOTSTRAP | HYPER CORE TECH
  let videoLoadQueue = [];
  let isLoadingSequentially = false;

  // חלק Network Tiers (פיד) – השהייה בין טעינות במצב BOOTSTRAP | HYPER CORE TECH
  const BOOTSTRAP_LOAD_DELAY = 2000; // 2 שניות בין טעינות

  // גרסת קוד לזיהוי עדכונים
  const FEED_CODE_VERSION = '2.2.9-fast-hybrid';
  console.log(`%c🔧 Feed.js גרסה: ${FEED_CODE_VERSION}`, 'color: #FF5722; font-weight: bold; font-size: 14px');

  async function processVideoLoadQueue() {
    if (isLoadingSequentially || videoLoadQueue.length === 0) return;
    
    isLoadingSequentially = true;
    const totalVideos = videoLoadQueue.length;
    let loadedCount = 0;
    
    console.log(`%c╔════════════════════════════════════════╗`, 'color: #4CAF50; font-weight: bold');
    console.log(`%c║  🎬 התחלת טעינה סדרתית - ${totalVideos} וידאו      ║`, 'color: #4CAF50; font-weight: bold');
    console.log(`%c╚════════════════════════════════════════╝`, 'color: #4CAF50; font-weight: bold');
    
    while (videoLoadQueue.length > 0) {
      const { video, url, hash, mirrors } = videoLoadQueue.shift();
      loadedCount++;
      
      console.log(`%c┌─ וידאו ${loadedCount}/${totalVideos} ─────────────────────────┐`, 'color: #2196F3');
      
      try {
        await loadVideoWithCache(video, url, hash, mirrors);
        console.log(`%c└─ ✅ הושלם ──────────────────────────────┘`, 'color: #4CAF50');
      } catch (err) {
        console.log(`%c└─ ❌ נכשל: ${err.message} ─────────────────┘`, 'color: #f44336');
      }
      
      // השהייה של 2 שניות לפני הוידאו הבא (אם יש עוד)
      if (videoLoadQueue.length > 0) {
        console.log(`%c   ⏳ ממתין 2 שניות...`, 'color: #9E9E9E; font-style: italic');
        await new Promise(resolve => setTimeout(resolve, BOOTSTRAP_LOAD_DELAY));
      }
    }
    
    console.log(`%c╔════════════════════════════════════════╗`, 'color: #4CAF50; font-weight: bold');
    console.log(`%c║  ✅ טעינה סדרתית הושלמה - ${loadedCount} וידאו    ║`, 'color: #4CAF50; font-weight: bold');
    console.log(`%c╚════════════════════════════════════════╝`, 'color: #4CAF50; font-weight: bold');
    
    // הדפסת סיכום סטטיסטיקות P2P
    if (typeof App.printP2PStats === 'function') {
      App.printP2PStats();
    }
    
    isLoadingSequentially = false;
  }

  function initVideoLoading() {
    // חלק Network Tiers (פיד) – איפוס מונה פוסטים בכל טעינה מחדש | HYPER CORE TECH
    globalVideoLoadIndex = 0;
    videoLoadQueue = [];
    isLoadingSequentially = false;
    
    const videoContainers = document.querySelectorAll('[data-video-url]');
    
    // חלק Network Tiers (פיד) – בדיקת מצב רשת לקביעת אסטרטגיית טעינה | HYPER CORE TECH
    const checkTierAndLoad = async () => {
      let currentTier = 'UNKNOWN';
      
      // בדיקת מצב רשת אם הפונקציה זמינה
      if (typeof App.getNetworkTier === 'function') {
        try {
          const peerCount = typeof App.countActivePeers === 'function' 
            ? await App.countActivePeers() 
            : 0;
          currentTier = App.getNetworkTier(peerCount);
        } catch (err) {
          console.warn('שגיאה בבדיקת מצב רשת:', err);
        }
      }
      
      console.log(`%c🌐 מצב רשת לטעינה: ${currentTier}`, 'color: #9C27B0; font-weight: bold');
      
      // במצב BOOTSTRAP - טעינה סדרתית (אחד אחרי השני)
      const useSequentialLoading = currentTier === 'BOOTSTRAP' || currentTier === 'UNKNOWN';
      
      // חלק Network Tiers (פיד) – במצב BOOTSTRAP, טוענים את כל הוידאו לתור מראש | HYPER CORE TECH
      if (useSequentialLoading) {
        const videosToLoad = [];
        videoContainers.forEach(container => {
          const video = container.querySelector('video');
          const url = container.dataset.videoUrl;
          const hash = container.dataset.videoHash || '';
          const mirrorsStr = container.dataset.videoMirrors || '';
          const mirrors = mirrorsStr ? mirrorsStr.split(',').filter(Boolean) : [];
          
          if (video && url && !video.src) {
            const eventId = container.closest('[data-post-id]')?.dataset?.postId || null;
            if (typeof App.registerMediaUrl === 'function') {
              App.registerMediaUrl(url, hash, eventId, mirrors);
            }
            videosToLoad.push({ video, url, hash, mirrors });
          }
        });
        
        // הוספת כל הוידאו לתור והתחלת עיבוד סדרתי
        videoLoadQueue = videosToLoad;
        if (videosToLoad.length > 0) {
          console.log(`%c📋 נוספו ${videosToLoad.length} וידאו לתור טעינה סדרתית`, 'color: #2196F3');
          processVideoLoadQueue();
        }
        return;
      }
      
      // מצב HYBRID/P2P_FULL - טעינה מקבילית עם IntersectionObserver
      videoContainers.forEach(container => {
        const video = container.querySelector('video');
        const url = container.dataset.videoUrl;
        const hash = container.dataset.videoHash || '';
        const mirrorsStr = container.dataset.videoMirrors || '';
        const mirrors = mirrorsStr ? mirrorsStr.split(',').filter(Boolean) : [];
        
        if (video && url && !video.src) {
          const eventId = container.closest('[data-post-id]')?.dataset?.postId || null;
          if (typeof App.registerMediaUrl === 'function') {
            App.registerMediaUrl(url, hash, eventId, mirrors);
          }
          
          const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
              if (entry.isIntersecting) {
                loadVideoWithCache(video, url, hash, mirrors);
                observer.unobserve(entry.target);
              }
            });
          }, { rootMargin: '100px' });
          
          observer.observe(container);
        }
      });
    };
    
    checkTierAndLoad();
  }

  // חלק Network Tiers (פיד) – איפוס מונה פוסטים (לשימוש חיצוני) | HYPER CORE TECH
  function resetVideoLoadIndex() {
    globalVideoLoadIndex = 0;
  }

  // חלק וידאו (feed.js) – טיפול בלחיצה על וידאו להפעלה/עצירה
  function initVideoPlayHandlers() {
    document.addEventListener('click', (e) => {
      const container = e.target.closest('[data-video-container]');
      if (!container) return;

      const video = container.querySelector('video');
      const overlay = container.querySelector('[data-play-overlay]');
      if (!video) return;

      e.preventDefault();
      e.stopPropagation();

      if (video.paused) {
        video.play();
        if (overlay) overlay.style.opacity = '0';
      } else {
        video.pause();
        if (overlay) overlay.style.opacity = '1';
      }
    });

    // הסתרת overlay בהפעלה, הצגה בעצירה
    document.addEventListener('play', (e) => {
      if (e.target.tagName === 'VIDEO') {
        const container = e.target.closest('[data-video-container]');
        const overlay = container?.querySelector('[data-play-overlay]');
        if (overlay) overlay.style.opacity = '0';
      }
    }, true);

    document.addEventListener('pause', (e) => {
      if (e.target.tagName === 'VIDEO') {
        const container = e.target.closest('[data-video-container]');
        const overlay = container?.querySelector('[data-play-overlay]');
        if (overlay) overlay.style.opacity = '1';
      }
    }, true);
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
      logDeletionPublish('publishing delete', { 
        eventId, 
        relays: App.relayUrls,
        fullEvent: event,
        tags: event.tags,
        pubkey: event.pubkey
      });
      await App.pool.publish(App.relayUrls, event);
      console.log('Deleted event published to relays:', App.relayUrls);
      App.deletedEventIds.add(eventId);
      removePostElement(eventId);
      logDeletionPublish('delete published successfully', { eventId, deletionEventId: event.id });
    } catch (e) {
      console.error('Delete publish error', e);
      logDeletionPublish('delete publish FAILED', { eventId, error: e.message });
    }
  }

  // חלק עדכון בזמן אמת (feed.js) – פונקציה להוספת פוסט חדש לפיד מיד אחרי פרסום | HYPER CORE TECH
  function onPostPublished(signedEvent) {
    if (!signedEvent || !signedEvent.id) {
      console.warn('[feed] onPostPublished: invalid event');
      return;
    }
    
    console.log('[feed] onPostPublished: adding new post to feed', { id: signedEvent.id });
    
    // הוספת הפוסט ל-postsById
    if (!(App.postsById instanceof Map)) {
      App.postsById = new Map();
    }
    App.postsById.set(signedEvent.id, signedEvent);
    
    // הוספת מיפוי מחבר
    if (!(App.eventAuthorById instanceof Map)) {
      App.eventAuthorById = new Map();
    }
    const authorKey = typeof signedEvent.pubkey === 'string' ? signedEvent.pubkey.toLowerCase() : '';
    if (authorKey) {
      App.eventAuthorById.set(signedEvent.id, authorKey);
    }
    
    // רינדור הפוסט החדש בראש הפיד
    const feedContainer = document.getElementById('feedPosts') || document.querySelector('.feed-posts');
    if (feedContainer && typeof displayPosts === 'function') {
      // רינדור רק הפוסט החדש בראש הרשימה
      const tempContainer = document.createElement('div');
      displayPosts([signedEvent], tempContainer, { prepend: false });
      
      // הוספת הפוסט בראש הפיד
      if (tempContainer.firstChild) {
        feedContainer.insertBefore(tempContainer.firstChild, feedContainer.firstChild);
      }
    }
    
    // עדכון המטמון
    try {
      if (typeof App.saveFeedCache === 'function') {
        App.saveFeedCache();
      }
    } catch (err) {
      console.warn('[feed] Failed to save cache after publish', err);
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
    postComment,
    openEditPost,
    deletePost,
    deletePostQuiet,
    parseYouTube,
    createMediaHtml,
    buildTheaterSnapshot: App.buildTheaterSnapshot,
    handleNotificationForFollow,
    handleNotificationForDatingLike,
    handleNotificationForComment,
    handleNotificationForLike,

    registerDeletion,
    registerLike,
    updateLikeIndicator,
    removePostElement,
    loadVideoWithCache,
    resetVideoLoadIndex, // חלק Network Tiers (פיד) – איפוס מונה פוסטים | HYPER CORE TECH
    onPostPublished, // חלק עדכון בזמן אמת (feed.js) – הוספת פוסט חדש לפיד מיד | HYPER CORE TECH
  });

  // חלק וידאו/תמונות (feed.js) – אתחול טיפול בוידאו ו-Lightbox לתמונות
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initVideoPlayHandlers();
      initImageLightbox();
      bindTheaterOpen();
    });
  } else {
    initVideoPlayHandlers();
    initImageLightbox();
    bindTheaterOpen();
  }
})(window);
