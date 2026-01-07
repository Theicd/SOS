// חלק מדיה (media-cache.js) – מערכת cache מקומית לשמירת וידאו/תמונות ב-IndexedDB
// שייך: SOS2 מדיה, משתמש ב-IndexedDB לשמירה מקומית של קבצי מדיה
(function initMediaCache(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק cache (media-cache.js) – הגדרות
  const DB_NAME = 'SOS2MediaCache';
  const DB_VERSION = 1;
  const STORE_NAME = 'media';
  const MAX_CACHE_SIZE = 300 * 1024 * 1024; // 300MB
  const MAX_CACHE_AGE = 7 * 24 * 60 * 60 * 1000; // 7 ימים
  const PIN_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // פינים פגים אחרי 30 יום

  let db = null;
  let dbDisabled = false; // חלק cache (media-cache.js) – דגל משותק כש-IndexedDB אינו זמין | HYPER CORE TECH

  // חלק cache (media-cache.js) – פתיחת/יצירת database
  async function openDB() {
    if (dbDisabled) {
      return null;
    }

    if (db) return db;

    if (typeof indexedDB === 'undefined') {
      console.warn('IndexedDB is not available in this environment – media cache disabled');
      dbDisabled = true;
      return null;
    }

    return new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('Failed to open IndexedDB', request.error);
        dbDisabled = true;
        resolve(null);
      };

      request.onsuccess = () => {
        db = request.result;
        console.log('Media cache DB opened successfully');
        resolve(db);
      };

      request.onupgradeneeded = (event) => {
        const database = event.target.result;
        
        // יצירת object store אם לא קיים
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, { keyPath: 'hash' });
          store.createIndex('url', 'url', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('size', 'size', { unique: false });
          console.log('Media cache store created');
        }
      };
    });
  }

  // חלק cache (media-cache.js) – שמירת מדיה ב-cache
  async function cacheMedia(url, hash, blob, mimeType, options = {}) {
    try {
      const database = await openDB();
      if (!database) {
        return false;
      }
      const transaction = database.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      const entry = {
        hash,
        url,
        blob,
        mimeType: mimeType || blob.type,
        size: blob.size,
        timestamp: Date.now(),
        pinned: Boolean(options.pinned),
        lastPinnedAt: options.pinned ? Date.now() : 0,
      };

      await new Promise((resolve, reject) => {
        const request = store.put(entry);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      console.log('Media cached:', { hash: hash.slice(0, 16), size: blob.size });
      
      // ניקוי cache ישן אם צריך
      await cleanupOldCache();
      
      return true;
    } catch (err) {
      console.error('Failed to cache media', err);
      return false;
    }
  }

  async function pinCachedMedia(hash, pinned = true) {
    try {
      const database = await openDB();
      if (!database) {
        return false;
      }
      const transaction = database.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      const entry = await new Promise((resolve, reject) => {
        const request = store.get(hash);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      if (!entry) {
        return false;
      }

      entry.pinned = Boolean(pinned);
      entry.lastPinnedAt = entry.pinned ? Date.now() : (entry.lastPinnedAt || 0);

      await new Promise((resolve, reject) => {
        const request = store.put(entry);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      return true;
    } catch (err) {
      console.error('Failed to pin media', err);
      return false;
    }
  }

  // חלק cache (media-cache.js) – קריאת מדיה מ-cache
  async function getCachedMedia(hash) {
    try {
      const database = await openDB();
      if (!database) {
        return null;
      }
      const transaction = database.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);

      const entry = await new Promise((resolve, reject) => {
        const request = store.get(hash);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      if (!entry) {
        return null;
      }

      // בדיקת תוקף
      const age = Date.now() - entry.timestamp;
      if (age > MAX_CACHE_AGE) {
        console.log('Cache entry expired:', hash.slice(0, 16));
        await deleteCachedMedia(hash);
        return null;
      }

      console.log('Media loaded from cache:', hash.slice(0, 16));
      return {
        blob: entry.blob,
        url: entry.url,
        mimeType: entry.mimeType,
      };
    } catch (err) {
      console.error('Failed to get cached media', err);
      return null;
    }
  }

  // חלק cache (media-cache.js) – מחיקת מדיה מ-cache
  async function deleteCachedMedia(hash) {
    try {
      const database = await openDB();
      if (!database) {
        return false;
      }
      const transaction = database.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      await new Promise((resolve, reject) => {
        const request = store.delete(hash);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      console.log('Media deleted from cache:', hash.slice(0, 16));
      return true;
    } catch (err) {
      console.error('Failed to delete cached media', err);
      return false;
    }
  }

  // חלק cache (media-cache.js) – ניקוי cache ישן
  async function cleanupOldCache() {
    try {
      const database = await openDB();
      if (!database) {
        return;
      }
      const transaction = database.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index('timestamp');

      // קבלת כל הרשומות
      const entries = await new Promise((resolve, reject) => {
        const request = index.openCursor();
        const results = [];
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            results.push({
              hash: cursor.value.hash,
              timestamp: cursor.value.timestamp,
              size: cursor.value.size,
              pinned: Boolean(cursor.value.pinned),
              lastPinnedAt: cursor.value.lastPinnedAt || cursor.value.timestamp,
            });
            cursor.continue();
          } else {
            resolve(results);
          }
        };
        request.onerror = () => reject(request.error);
      });

      // מחיקת רשומות ישנות
      const now = Date.now();
      let totalSize = 0;
      const toDelete = [];

      // מיון לפי timestamp (ישן לחדש)
      entries.sort((a, b) => a.timestamp - b.timestamp);

      for (const entry of entries) {
        const age = now - entry.timestamp;
        const isPinned = Boolean(entry.pinned);

        if (isPinned) {
          const pinAge = now - (entry.lastPinnedAt || entry.timestamp);
          if (pinAge > PIN_MAX_AGE) {
            toDelete.push(entry.hash);
            continue;
          }
          // פריטים ממודדים לא נמחקים גם אם עוברים את המכסה
          totalSize += entry.size;
          continue;
        }

        // מחיקת רשומות ישנות מדי
        if (age > MAX_CACHE_AGE) {
          toDelete.push(entry.hash);
          continue;
        }

        totalSize += entry.size;

        // מחיקת רשומות אם חרגנו מהמכסה
        if (totalSize > MAX_CACHE_SIZE) {
          toDelete.push(entry.hash);
        }
      }

      // מחיקה
      for (const hash of toDelete) {
        await deleteCachedMedia(hash);
      }

      if (toDelete.length > 0) {
        console.log(`Cleaned up ${toDelete.length} old cache entries`);
      }
    } catch (err) {
      console.error('Cache cleanup failed', err);
    }
  }

  // חלק cache (media-cache.js) – קבלת סטטיסטיקות cache
  async function getCacheStats() {
    try {
      const database = await openDB();
      if (!database) {
        return null;
      }
      const transaction = database.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);

      const entries = await new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
      const count = entries.length;
      const pinnedCount = entries.filter((entry) => entry.pinned).length;
      const pinnedSize = entries.filter((entry) => entry.pinned).reduce((sum, entry) => sum + entry.size, 0);

      return {
        count,
        totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
        maxSizeMB: (MAX_CACHE_SIZE / (1024 * 1024)).toFixed(0),
        usage: ((totalSize / MAX_CACHE_SIZE) * 100).toFixed(1),
        pinnedCount,
        pinnedSize,
      };
    } catch (err) {
      console.error('Failed to get cache stats', err);
      return null;
    }
  }

  // חלק cache (media-cache.js) – ניקוי כל ה-cache
  async function clearAllCache() {
    try {
      const database = await openDB();
      if (!database) {
        return false;
      }
      const transaction = database.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      await new Promise((resolve, reject) => {
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      console.log('All cache cleared');
      return true;
    } catch (err) {
      console.error('Failed to clear cache', err);
      return false;
    }
  }

  // חלק cache (media-cache.js) – אתחול אוטומטי
  async function init() {
    try {
      const database = await openDB();
      if (!database) {
        console.warn('Media cache disabled – skipping initialization');
        return;
      }
      await cleanupOldCache();
      const stats = await getCacheStats();
      if (stats) {
        console.log('Media cache initialized:', stats);
      }
    } catch (err) {
      console.error('Media cache initialization failed', err);
    }
  }

  // חשיפה ל-App
  Object.assign(App, {
    cacheMedia,
    getCachedMedia,
    deleteCachedMedia,
    getCacheStats,
    pinCachedMedia,
    clearMediaCache: clearAllCache,
  });

  // אתחול
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  console.log('Media cache module initialized');
})(window);
