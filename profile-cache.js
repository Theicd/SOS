(function initProfileCache(window) {
  // חלק מערכת קאש (profile-cache.js) – ניהול יעיל של נתוני פרופיל מקומיים | HYPER CORE TECH
  const App = window.NostrApp || (window.NostrApp = {});

  // מפתחות שמירה ב-localStorage
  const CACHE_KEYS = {
    posts: 'sos_profile_posts',
    likes: 'sos_profile_likes',
    followers: 'sos_profile_followers',
    following: 'sos_profile_following',
    engagement: 'sos_profile_engagement',
    lastSync: 'sos_profile_last_sync'
  };

  // TTL לכל סוג נתון (במילישניות)
  const TTL = {
    posts: 5 * 60 * 1000,      // 5 דקות
    likes: 2 * 60 * 1000,      // 2 דקות
    followers: 10 * 60 * 1000, // 10 דקות
    following: 10 * 60 * 1000, // 10 דקות
    engagement: 3 * 60 * 1000, // 3 דקות
  };

  // הגנה על השרתים - cooldown בין סנכרונים
  const SYNC_COOLDOWN = 30 * 1000; // 30 שניות
  let lastSyncTime = 0;

  // מצב טעינה
  const loadState = {
    postsLoaded: 0,
    postsTotal: 0,
    isLoading: false
  };

  // כמות פוסטים לטעינה בכל פעם
  const POSTS_PER_PAGE = 6;

  // חלק שמירה (profile-cache.js) – שומר נתונים ל-localStorage
  function saveToCache(type, data, lastEventTime = 0) {
    try {
      const key = CACHE_KEYS[type];
      if (!key) return false;

      const cacheData = {
        data: Array.isArray(data) ? data.slice(0, 200) : data, // מגביל גודל
        timestamp: Date.now(),
        lastEventTime: lastEventTime || (Array.isArray(data) && data[0]?.created_at) || 0,
        count: Array.isArray(data) ? data.length : 1
      };

      window.localStorage.setItem(key, JSON.stringify(cacheData));
      return true;
    } catch (err) {
      console.warn('ProfileCache: failed to save', type, err);
      return false;
    }
  }

  // חלק קריאה (profile-cache.js) – קורא נתונים מהקאש
  function getFromCache(type) {
    try {
      const key = CACHE_KEYS[type];
      if (!key) return null;

      const stored = window.localStorage.getItem(key);
      if (!stored) return null;

      const parsed = JSON.parse(stored);
      const ttl = TTL[type] || TTL.posts;

      // בדיקת תוקף
      if (Date.now() - parsed.timestamp > ttl) {
        return { ...parsed, isStale: true };
      }

      return { ...parsed, isStale: false };
    } catch (err) {
      console.warn('ProfileCache: failed to read', type, err);
      return null;
    }
  }

  // חלק בדיקת תוקף (profile-cache.js) – בודק אם הקאש עדיין תקף
  function isCacheValid(type) {
    const cached = getFromCache(type);
    return cached && !cached.isStale;
  }

  // חלק ניקוי (profile-cache.js) – מנקה קאש ספציפי או הכל
  function clearCache(type = null) {
    try {
      if (type && CACHE_KEYS[type]) {
        window.localStorage.removeItem(CACHE_KEYS[type]);
      } else {
        Object.values(CACHE_KEYS).forEach(key => {
          window.localStorage.removeItem(key);
        });
      }
      return true;
    } catch (err) {
      console.warn('ProfileCache: failed to clear', err);
      return false;
    }
  }

  // חלק סנכרון דלתא (profile-cache.js) – טוען רק עדכונים חדשים
  async function syncDelta(type, fetchFn) {
    const now = Date.now();

    // הגנה מפני סנכרון תכוף מדי
    if (now - lastSyncTime < SYNC_COOLDOWN) {
      console.log('ProfileCache: sync cooldown active');
      const cached = getFromCache(type);
      return { hasUpdates: false, data: cached?.data || [], fromCache: true };
    }

    lastSyncTime = now;
    const cached = getFromCache(type);
    const since = cached?.lastEventTime || 0;

    try {
      // טוען רק אירועים חדשים
      const newEvents = await fetchFn(since);

      if (!newEvents || newEvents.length === 0) {
        return { hasUpdates: false, data: cached?.data || [], fromCache: true };
      }

      // מזג עם הקיים
      const existingData = cached?.data || [];
      const existingIds = new Set(existingData.map(e => e.id));
      const uniqueNew = newEvents.filter(e => !existingIds.has(e.id));

      if (uniqueNew.length === 0) {
        return { hasUpdates: false, data: existingData, fromCache: true };
      }

      const merged = [...uniqueNew, ...existingData]
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
        .slice(0, 200);

      saveToCache(type, merged);

      return { hasUpdates: true, data: merged, newCount: uniqueNew.length };
    } catch (err) {
      console.error('ProfileCache: syncDelta failed', type, err);
      return { hasUpdates: false, data: cached?.data || [], error: err };
    }
  }

  // חלק טעינה חכמה (profile-cache.js) – מחליט אם לטעון מקאש או מרשת
  async function smartLoad(type, fetchFn, options = {}) {
    const { forceRefresh = false, showStale = true } = options;

    // אם יש קאש תקף ולא מבקשים רענון
    if (!forceRefresh && isCacheValid(type)) {
      const cached = getFromCache(type);
      return { data: cached.data, fromCache: true, count: cached.count };
    }

    // אם יש קאש ישן, מציג אותו תוך כדי טעינה
    const staleCache = getFromCache(type);
    if (showStale && staleCache?.data) {
      // מחזיר את הישן ומתחיל לטעון ברקע
      syncDelta(type, fetchFn).then(result => {
        if (result.hasUpdates && typeof options.onUpdate === 'function') {
          options.onUpdate(result.data, result.newCount);
        }
      });
      return { data: staleCache.data, fromCache: true, isStale: true, count: staleCache.count };
    }

    // אין קאש - טוען הכל מהרשת
    try {
      const freshData = await fetchFn(0);
      if (freshData && freshData.length > 0) {
        saveToCache(type, freshData);
      }
      return { data: freshData || [], fromCache: false, count: freshData?.length || 0 };
    } catch (err) {
      console.error('ProfileCache: smartLoad failed', type, err);
      return { data: [], error: err, count: 0 };
    }
  }

  // חלק lazy loading (profile-cache.js) – ניהול טעינה הדרגתית של פוסטים
  function initLazyLoading(allPosts, renderFn, containerSelector) {
    console.log('initLazyLoading called', { totalPosts: allPosts.length });
    
    loadState.postsTotal = allPosts.length;
    loadState.postsLoaded = 0;
    loadState.isLoading = false;

    // מוצא את רשימת הפוסטים ישירות
    const list = document.getElementById('profileTimeline');
    if (!list) {
      console.warn('ProfileCache: profileTimeline not found');
      return;
    }

    // רינדור הפוסטים הראשונים
    const firstBatch = allPosts.slice(0, POSTS_PER_PAGE);
    renderFn(firstBatch, false);
    loadState.postsLoaded = firstBatch.length;
    
    console.log('First batch rendered', { loaded: loadState.postsLoaded, total: loadState.postsTotal });

    // אם אין עוד פוסטים, לא צריך lazy loading
    if (loadState.postsLoaded >= loadState.postsTotal) {
      console.log('No more posts to load');
      return;
    }

    // יצירת אלמנט טעינה גלוי
    let loadingEl = list.querySelector('.profile-posts-loading');
    if (!loadingEl) {
      loadingEl = document.createElement('li');
      loadingEl.className = 'profile-posts-loading';
      loadingEl.innerHTML = '<div class="profile-posts-loading__spinner"></div><span>גלול לעוד</span>';
      list.appendChild(loadingEl);
    }
    loadingEl.style.display = 'flex';

    // שמירת הפוסטים והפונקציה לשימוש מאוחר יותר
    App.allPostsForLazyLoad = allPosts;
    App.renderFnForLazyLoad = renderFn;
    App.lazyLoadList = list;
    App.lazyLoadingEl = loadingEl;

    // גלילה - טעינה אוטומטית כשמגיעים לסוף
    if (App.postsObserver) {
      App.postsObserver.disconnect();
    }

    // שימוש ב-scroll event במקום IntersectionObserver
    const scrollHandler = () => {
      if (loadState.isLoading || loadState.postsLoaded >= loadState.postsTotal) return;
      
      const rect = loadingEl.getBoundingClientRect();
      const isVisible = rect.top < window.innerHeight + 200;
      
      if (isVisible) {
        console.log('Loading more posts via scroll');
        loadMorePosts(App.allPostsForLazyLoad, App.renderFnForLazyLoad, App.lazyLoadList, App.lazyLoadingEl);
      }
    };

    window.addEventListener('scroll', scrollHandler, { passive: true });
    App.scrollHandler = scrollHandler;
    App.postsLoadingEl = loadingEl;
    
    // בדיקה ראשונית
    setTimeout(scrollHandler, 500);
    
    console.log('Scroll handler attached');

    return null;
  }

  // חלק טעינת עוד (profile-cache.js) – טוען את הקבוצה הבאה של פוסטים
  function loadMorePosts(allPosts, renderFn, list, loadingEl) {
    console.log('loadMorePosts called', { loaded: loadState.postsLoaded, total: loadState.postsTotal, isLoading: loadState.isLoading });
    
    if (loadState.isLoading || loadState.postsLoaded >= loadState.postsTotal) {
      if (loadingEl && loadState.postsLoaded >= loadState.postsTotal) {
        loadingEl.style.display = 'none';
      }
      return;
    }

    loadState.isLoading = true;
    if (loadingEl) {
      loadingEl.style.display = 'flex';
      const span = loadingEl.querySelector('span');
      if (span) span.textContent = 'טוען...';
    }

    setTimeout(() => {
      const start = loadState.postsLoaded;
      const end = Math.min(start + POSTS_PER_PAGE, loadState.postsTotal);
      const nextBatch = allPosts.slice(start, end);

      console.log('Loading batch', { start, end, batchSize: nextBatch.length });

      if (nextBatch.length > 0) {
        renderFn(nextBatch, true);
        loadState.postsLoaded = end;
      }

      loadState.isLoading = false;

      // מזיז את אלמנט הטעינה לסוף
      if (loadingEl && list) {
        list.appendChild(loadingEl);
        if (loadState.postsLoaded >= loadState.postsTotal) {
          loadingEl.style.display = 'none';
        }
      }
    }, 100);
  }

  // חלק סטטוס (profile-cache.js) – מעדכן את הודעת הסטטוס
  function updateLoadingStatus(message = null) {
    const statusEl = document.getElementById('profileTimelineStatus');
    if (!statusEl) return;

    if (message) {
      statusEl.textContent = message;
      statusEl.style.display = '';
      return;
    }

    // מסתיר את הסטטוס כשהכל נטען - עיצוב טיקטוקי נקי
    if (loadState.postsTotal === 0) {
      statusEl.textContent = '';
      statusEl.style.display = 'none';
    } else {
      statusEl.textContent = '';
      statusEl.style.display = 'none';
    }
  }

  // חלק batch fetch (profile-cache.js) – פניה אחת במקום הרבה
  async function batchFetch(pubkey, relays) {
    if (!App.pool || !pubkey || !relays?.length) {
      return { posts: [], likes: [], followers: [] };
    }

    const filters = [
      { kinds: [1], authors: [pubkey], limit: 120 },
      { kinds: [7], '#p': [pubkey], limit: 200 },
      { kinds: [3], '#p': [pubkey], limit: 100 }
    ];

    try {
      let allEvents = [];

      if (typeof App.pool.list === 'function') {
        allEvents = await App.pool.list(relays, filters);
      } else if (typeof App.pool.subscribeMany === 'function') {
        allEvents = await new Promise((resolve) => {
          const collected = [];
          const sub = App.pool.subscribeMany(relays, filters, {
            onevent(event) { collected.push(event); },
            oneose() { sub?.close?.(); resolve(collected); }
          });
          setTimeout(() => { sub?.close?.(); resolve(collected); }, 8000);
        });
      }

      // מפריד לפי סוג
      const posts = allEvents.filter(e => e.kind === 1).sort((a, b) => b.created_at - a.created_at);
      const likes = allEvents.filter(e => e.kind === 7);
      const followers = allEvents.filter(e => e.kind === 3);

      // שומר לקאש
      if (posts.length) saveToCache('posts', posts);
      if (likes.length) saveToCache('likes', likes);
      if (followers.length) saveToCache('followers', followers);

      return { posts, likes, followers };
    } catch (err) {
      console.error('ProfileCache: batchFetch failed', err);
      return { posts: [], likes: [], followers: [] };
    }
  }

  // חלק סטטיסטיקות קאש (profile-cache.js) – מידע על מצב הקאש
  function getCacheStats() {
    const stats = {};
    Object.entries(CACHE_KEYS).forEach(([type, key]) => {
      try {
        const stored = window.localStorage.getItem(key);
        if (stored) {
          const parsed = JSON.parse(stored);
          stats[type] = {
            count: parsed.count || 0,
            age: Math.round((Date.now() - parsed.timestamp) / 1000),
            isValid: !getFromCache(type)?.isStale
          };
        } else {
          stats[type] = { count: 0, age: null, isValid: false };
        }
      } catch {
        stats[type] = { count: 0, age: null, isValid: false };
      }
    });
    return stats;
  }

  // חשיפת API
  App.ProfileCache = {
    save: saveToCache,
    get: getFromCache,
    isValid: isCacheValid,
    clear: clearCache,
    syncDelta,
    smartLoad,
    batchFetch,
    initLazyLoading,
    updateStatus: updateLoadingStatus,
    getStats: getCacheStats,
    POSTS_PER_PAGE,
    loadState
  };

})(window);
