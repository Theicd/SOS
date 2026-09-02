// חלק מדיה (media-cache.js) – מערכת cache מקומית לשמירת וידאו/תמונות ב-IndexedDB
// שייך: SOS2 מדיה, משתמש ב-IndexedDB לשמירה מקומית של קבצי מדיה
(function initMediaCache(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק cache (media-cache.js) – הגדרות
  const DB_NAME = 'SOS2MediaCache';
  const DB_VERSION = 1;
  const STORE_NAME = 'media';
  const MAX_CACHE_SIZE = 1024 * 1024 * 1024; // 1GB – סרטונים גדולים; 300MB מחק אחרי רענון | HYPER CORE TECH
  const MAX_CACHE_AGE = 7 * 24 * 60 * 60 * 1000; // 7 ימים
  const PIN_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // פינים פגים אחרי 30 יום
  let cleanupTimer = null;
  let mediaCacheReadyResolve;
  const mediaCacheReady = new Promise((resolve) => {
    mediaCacheReadyResolve = resolve;
    setTimeout(resolve, 6000);
  });

  function normalizeMediaHash(hash) {
    const raw = String(hash || '').trim();
    const lower = raw.toLowerCase();
    return /^[a-f0-9]{64}$/.test(lower) ? lower : raw;
  }

  let db = null;
  let dbSoftBlockedUntil = 0; // חסימה רכה עם ניסיון חוזר | HYPER CORE TECH
  let dbHardDisabled = false; // רק כשאין IndexedDB בכלל | HYPER CORE TECH
  let dbFailCount = 0;
  let openInFlight = null;

  function isMediaCacheAvailable() {
    return !dbHardDisabled && typeof indexedDB !== 'undefined';
  }

  // חלק cache (media-cache.js) – פתיחת/יצירת database עם retry | HYPER CORE TECH
  async function openDB() {
    if (dbHardDisabled) return null;
    if (db) return db;

    if (typeof indexedDB === 'undefined') {
      console.warn('IndexedDB is not available in this environment – media cache disabled');
      dbHardDisabled = true;
      return null;
    }

    if (Date.now() < dbSoftBlockedUntil) {
      return null;
    }

    if (openInFlight) return openInFlight;

    openInFlight = new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        openInFlight = null;
        resolve(value);
      };

      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onblocked = () => {
          dbFailCount += 1;
          dbSoftBlockedUntil = Date.now() + Math.min(30000, 1500 * Math.max(1, dbFailCount));
          console.warn('[media-cache] IndexedDB open blocked — will retry', {
            retryInMs: dbSoftBlockedUntil - Date.now(),
          });
          finish(null);
        };

        request.onerror = () => {
          const err = request.error;
          const errName = err && err.name ? String(err.name) : '';
          console.error('Failed to open IndexedDB', err);
          dbFailCount += 1;
          dbSoftBlockedUntil = Date.now() + Math.min(30000, 1500 * Math.max(1, dbFailCount));
          // SecurityError בסביבות מסוימות — לא מוותרים לצמיתות, רק מרחיקים ניסיון | HYPER CORE TECH
          if (errName === 'InvalidStateError' && typeof indexedDB === 'undefined') {
            dbHardDisabled = true;
          }
          finish(null);
        };

        request.onsuccess = () => {
          db = request.result;
          dbFailCount = 0;
          dbSoftBlockedUntil = 0;
          try {
            db.onclose = () => {
              db = null;
            };
            db.onversionchange = () => {
              try { db.close(); } catch (_) {}
              db = null;
            };
          } catch (_) {}
          console.log('Media cache DB opened successfully');
          finish(db);
        };

        request.onupgradeneeded = (event) => {
          const database = event.target.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            const store = database.createObjectStore(STORE_NAME, { keyPath: 'hash' });
            store.createIndex('url', 'url', { unique: false });
            store.createIndex('timestamp', 'timestamp', { unique: false });
            store.createIndex('size', 'size', { unique: false });
            console.log('Media cache store created');
          }
        };
      } catch (err) {
        console.error('[media-cache] IndexedDB open threw', err);
        dbFailCount += 1;
        dbSoftBlockedUntil = Date.now() + Math.min(30000, 1500 * Math.max(1, dbFailCount));
        finish(null);
      }
    });

    return openInFlight;
  }

  async function retryMediaCacheOpen() {
    dbSoftBlockedUntil = 0;
    dbFailCount = 0;
    // אם ה-DB כבר פתוח — לא סוגרים (close באמצע boot שובר getCachedMedia) | HYPER CORE TECH
    if (db) {
      console.log('[media-cache] retry open skipped — already open');
      return db;
    }
    openInFlight = null;
    const database = await openDB();
    console.log('[media-cache] retry open', { ok: !!database });
    return database;
  }

  async function refreshMediaCacheHashSet() {
    try {
      const database = await openDB();
      if (!database) return;
      const transaction = database.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const hashes = await new Promise((resolve, reject) => {
        const req = store.getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      App.mediaCacheHashSet = new Set((hashes || []).map((h) => normalizeMediaHash(h)));
      console.log('[media-cache] hash set ready', { count: App.mediaCacheHashSet.size });
    } catch (err) {
      console.warn('[media-cache] hash set failed', err);
      App.mediaCacheHashSet = App.mediaCacheHashSet || new Set();
    }
  }

  function rememberCachedHash(hash) {
    try {
      if (!hash) return;
      App.mediaCacheHashSet = App.mediaCacheHashSet || new Set();
      App.mediaCacheHashSet.add(String(hash));
    } catch (_) {}
  }

  function forgetCachedHash(hash) {
    try {
      if (!hash || !App.mediaCacheHashSet) return;
      App.mediaCacheHashSet.delete(String(hash));
      App.mediaCacheHashSet.delete(String(hash).toLowerCase());
    } catch (_) {}
  }

  function scheduleCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setTimeout(() => {
      cleanupTimer = null;
      cleanupOldCache().catch(() => {});
    }, 8000);
  }

  async function putCacheEntry(database, entry) {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    await new Promise((resolve, reject) => {
      const request = store.put(entry);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // חלק cache (media-cache.js) – שמירת מדיה ב-cache
  async function cacheMedia(url, hash, blob, mimeType, options = {}) {
    try {
      const key = normalizeMediaHash(hash);
      if (!key || !blob) return false;
      const database = await openDB();
      if (!database) {
        return false;
      }
      const mime = mimeType || blob.type || '';
      const isVideo = /^video\//i.test(mime) || /\.(mp4|webm|mov)(\?|#|$)/i.test(String(url || ''));
      const pinned = options.pinned != null ? Boolean(options.pinned) : isVideo;
      const entry = {
        hash: key,
        url,
        blob,
        mimeType: mime,
        size: blob.size,
        timestamp: Date.now(),
        pinned,
        lastPinnedAt: pinned ? Date.now() : 0,
      };

      try {
        await putCacheEntry(database, entry);
      } catch (putErr) {
        const name = putErr && putErr.name ? String(putErr.name) : '';
        if (name === 'QuotaExceededError') {
          await cleanupOldCache();
          await putCacheEntry(database, entry);
        } else {
          throw putErr;
        }
      }

      console.log('Media cached:', { hash: key.slice(0, 16), size: blob.size, pinned });
      rememberCachedHash(key);
      scheduleCleanup();
      return true;
    } catch (err) {
      console.error('Failed to cache media', err);
      return false;
    }
  }

  async function getByHashKey(database, key) {
    const transaction = database.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function pinCachedMedia(hash, pinned = true) {
    try {
      const key = normalizeMediaHash(hash);
      const database = await openDB();
      if (!database) {
        return false;
      }
      let entry = await getByHashKey(database, key);
      if (!entry && key !== hash) {
        entry = await getByHashKey(database, hash);
      }
      if (!entry) {
        return false;
      }

      entry.pinned = Boolean(pinned);
      entry.lastPinnedAt = entry.pinned ? Date.now() : (entry.lastPinnedAt || 0);
      if (entry.hash !== key) entry.hash = key;

      await putCacheEntry(database, entry);
      return true;
    } catch (err) {
      console.error('Failed to pin cached media', err);
      return false;
    }
  }

  // חלק cache (media-cache.js) – שליפת מדיה מה-cache
  async function getCachedMedia(hash) {
    if (!hash) return null;
    try {
      let database = await openDB();
      if (!database && Date.now() >= dbSoftBlockedUntil) {
        database = await retryMediaCacheOpen();
      }
      if (!database) {
        return null;
      }
      const key = normalizeMediaHash(hash);
      const keysToTry = [...new Set([key, String(hash).trim()].filter(Boolean))];
      for (let i = 0; i < keysToTry.length; i++) {
        const entry = await getByHashKey(database, keysToTry[i]);
        if (entry && entry.blob) return entry;
      }
      try {
        const cached = App.mediaCacheHashSet;
        if (cached && cached.size) {
          const want = key.toLowerCase();
          for (const existing of cached) {
            if (String(existing).toLowerCase() === want) {
              const entry = await getByHashKey(database, existing);
              if (entry && entry.blob) return entry;
            }
          }
        }
      } catch (_) {}
      return null;
    } catch (err) {
      console.error('Failed to get cached media', err);
      db = null;
      return null;
    }
  }

  async function deleteCachedMedia(hash) {
    try {
      const database = await openDB();
      if (!database) return false;
      const keys = [...new Set([normalizeMediaHash(hash), String(hash || '').trim()].filter(Boolean))];
      const transaction = database.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      for (let i = 0; i < keys.length; i++) {
        await new Promise((resolve, reject) => {
          const request = store.delete(keys[i]);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
        forgetCachedHash(keys[i]);
      }
      return true;
    } catch (err) {
      console.error('Failed to delete cached media', err);
      return false;
    }
  }

  async function cleanupOldCache() {
    try {
      const database = await openDB();
      if (!database) return;

      const transaction = database.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const entries = await new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });

      const now = Date.now();
      let totalSize = entries.reduce((sum, e) => sum + (e.size || 0), 0);

      for (const entry of entries) {
        const age = now - (entry.timestamp || 0);
        const pinned = Boolean(entry.pinned);
        const pinAge = now - (entry.lastPinnedAt || 0);
        const pinExpired = pinned && pinAge > PIN_MAX_AGE;
        const tooOld = !pinned && age > MAX_CACHE_AGE;

        if (tooOld || pinExpired) {
          await new Promise((resolve, reject) => {
            const request = store.delete(entry.hash);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });
          forgetCachedHash(entry.hash);
          totalSize -= entry.size || 0;
        }
      }

      if (totalSize > MAX_CACHE_SIZE) {
        const unpinned = entries
          .filter((e) => !e.pinned)
          .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        for (const entry of unpinned) {
          if (totalSize <= MAX_CACHE_SIZE * 0.85) break;
          await new Promise((resolve, reject) => {
            const request = store.delete(entry.hash);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });
          forgetCachedHash(entry.hash);
          totalSize -= entry.size || 0;
        }
      }
      if (totalSize > MAX_CACHE_SIZE) {
        const pinnedOldest = entries
          .filter((e) => e.pinned)
          .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        for (const entry of pinnedOldest) {
          if (totalSize <= MAX_CACHE_SIZE * 0.85) break;
          await new Promise((resolve, reject) => {
            const request = store.delete(entry.hash);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });
          forgetCachedHash(entry.hash);
          totalSize -= entry.size || 0;
        }
      }
    } catch (err) {
      console.error('Failed to cleanup cache', err);
    }
  }

  async function getCacheStats() {
    try {
      const database = await openDB();
      if (!database) {
        return {
          count: 0,
          totalSize: 0,
          totalSizeMB: '0.00',
          maxSizeMB: String(MAX_CACHE_SIZE / (1024 * 1024)),
          usage: '0.0',
          pinnedCount: 0,
          pinnedSize: 0,
          disabled: dbHardDisabled,
          softBlocked: Date.now() < dbSoftBlockedUntil,
        };
      }
      const transaction = database.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const entries = await new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });

      const count = entries.length;
      const totalSize = entries.reduce((sum, entry) => sum + (entry.size || 0), 0);
      const pinnedCount = entries.filter((entry) => entry.pinned).length;
      const pinnedSize = entries.filter((entry) => entry.pinned).reduce((sum, entry) => sum + (entry.size || 0), 0);

      return {
        count,
        totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
        maxSizeMB: (MAX_CACHE_SIZE / (1024 * 1024)).toFixed(0),
        usage: ((totalSize / MAX_CACHE_SIZE) * 100).toFixed(1),
        pinnedCount,
        pinnedSize,
        disabled: false,
        softBlocked: false,
      };
    } catch (err) {
      console.error('Failed to get cache stats', err);
      return null;
    }
  }

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

  async function listCachedMediaMeta() {
    try {
      const database = await openDB();
      if (!database) return [];
      const transaction = database.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const entries = await new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      return (entries || [])
        .filter((e) => e && e.hash)
        .map((e) => ({
          hash: normalizeMediaHash(e.hash),
          mimeType: e.mimeType || '',
          size: e.size || 0,
          timestamp: e.timestamp || 0,
          pinned: Boolean(e.pinned),
        }));
    } catch (err) {
      console.error('Failed to list cached media', err);
      return [];
    }
  }

  async function init() {
    try {
      const database = await openDB();
      if (!database) {
        console.warn('Media cache unavailable on init — will retry on demand', {
          hardDisabled: dbHardDisabled,
          retryAt: dbSoftBlockedUntil || null,
        });
        return;
      }
      await cleanupOldCache();
      const stats = await getCacheStats();
      if (stats) {
        console.log('Media cache initialized:', stats);
      }
      await refreshMediaCacheHashSet();
    } catch (err) {
      console.error('Media cache initialization failed', err);
    } finally {
      try { mediaCacheReadyResolve(); } catch (_) {}
    }
  }

  Object.assign(App, {
    cacheMedia,
    getCachedMedia,
    deleteCachedMedia,
    getCacheStats,
    pinCachedMedia,
    listCachedMediaMeta,
    clearMediaCache: clearAllCache,
    retryMediaCacheOpen,
    refreshMediaCacheHashSet,
    isMediaCacheAvailable,
    whenMediaCacheReady: () => mediaCacheReady,
    normalizeMediaHash,
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  console.log('Media cache module initialized');
})(window);
