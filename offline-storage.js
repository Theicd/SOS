/**
 * חלק אחסון מקומי (offline-storage.js) – שמירת כל הנתונים למצב חירום
 * 
 * מודול זה שומר את כל האירועים, הפרופילים, הלייקים והתגובות
 * ב-IndexedDB כדי שהרשת החברתית תעבוד גם ללא אינטרנט.
 * 
 * גרסה: 1.0.0
 * תאריך: 10 בדצמבר 2025
 */

;(function initOfflineStorage(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // ═══════════════════════════════════════════════════════════════════════════
  // הגדרות
  // ═══════════════════════════════════════════════════════════════════════════
  
  const DB_NAME = 'SOS_OfflineData';
  const DB_VERSION = 1;
  const MAX_EVENTS = 10000;        // מקסימום אירועים לשמור
  const MAX_PROFILES = 5000;       // מקסימום פרופילים
  const MAX_STORAGE_MB = 500;      // מקסימום 500MB
  
  // Object Stores
  const STORES = {
    EVENTS: 'events',              // פוסטים (kind 1)
    PROFILES: 'profiles',          // פרופילים (kind 0)
    LIKES: 'likes',                // לייקים (kind 7)
    COMMENTS: 'comments',          // תגובות (kind 1 עם reply)
    NOTIFICATIONS: 'notifications', // התראות
    FOLLOWS: 'follows',            // עוקבים (kind 3)
    MEDIA: 'media',                // תמונות פרופיל ומדיה
    MESSAGES: 'messages',          // הודעות פרטיות (kind 4)
  };

  let db = null;
  let isReady = false;

  // ═══════════════════════════════════════════════════════════════════════════
  // אתחול Database
  // ═══════════════════════════════════════════════════════════════════════════
  
  async function initDB() {
    if (db) return db;
    
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onerror = () => {
        console.error('❌ Failed to open offline DB:', request.error);
        reject(request.error);
      };
      
      request.onsuccess = () => {
        db = request.result;
        isReady = true;
        console.log('✅ Offline storage ready');
        resolve(db);
      };
      
      request.onupgradeneeded = (event) => {
        const database = event.target.result;
        
        // Events store - פוסטים
        if (!database.objectStoreNames.contains(STORES.EVENTS)) {
          const eventsStore = database.createObjectStore(STORES.EVENTS, { keyPath: 'id' });
          eventsStore.createIndex('pubkey', 'pubkey', { unique: false });
          eventsStore.createIndex('created_at', 'created_at', { unique: false });
          eventsStore.createIndex('kind', 'kind', { unique: false });
        }
        
        // Profiles store - פרופילים
        if (!database.objectStoreNames.contains(STORES.PROFILES)) {
          const profilesStore = database.createObjectStore(STORES.PROFILES, { keyPath: 'pubkey' });
          profilesStore.createIndex('name', 'name', { unique: false });
          profilesStore.createIndex('updated_at', 'updated_at', { unique: false });
        }
        
        // Likes store - לייקים
        if (!database.objectStoreNames.contains(STORES.LIKES)) {
          const likesStore = database.createObjectStore(STORES.LIKES, { keyPath: 'id' });
          likesStore.createIndex('event_id', 'event_id', { unique: false });
          likesStore.createIndex('pubkey', 'pubkey', { unique: false });
        }
        
        // Comments store - תגובות
        if (!database.objectStoreNames.contains(STORES.COMMENTS)) {
          const commentsStore = database.createObjectStore(STORES.COMMENTS, { keyPath: 'id' });
          commentsStore.createIndex('parent_id', 'parent_id', { unique: false });
          commentsStore.createIndex('pubkey', 'pubkey', { unique: false });
        }
        
        // Notifications store - התראות
        if (!database.objectStoreNames.contains(STORES.NOTIFICATIONS)) {
          const notifStore = database.createObjectStore(STORES.NOTIFICATIONS, { keyPath: 'id' });
          notifStore.createIndex('created_at', 'created_at', { unique: false });
          notifStore.createIndex('read', 'read', { unique: false });
        }
        
        // Follows store - עוקבים
        if (!database.objectStoreNames.contains(STORES.FOLLOWS)) {
          const followsStore = database.createObjectStore(STORES.FOLLOWS, { keyPath: 'pubkey' });
          followsStore.createIndex('updated_at', 'updated_at', { unique: false });
        }
        
        // Media store - מדיה (תמונות פרופיל)
        if (!database.objectStoreNames.contains(STORES.MEDIA)) {
          const mediaStore = database.createObjectStore(STORES.MEDIA, { keyPath: 'url' });
          mediaStore.createIndex('type', 'type', { unique: false });
          mediaStore.createIndex('cached_at', 'cached_at', { unique: false });
        }
        
        // Messages store - הודעות פרטיות
        if (!database.objectStoreNames.contains(STORES.MESSAGES)) {
          const messagesStore = database.createObjectStore(STORES.MESSAGES, { keyPath: 'id' });
          messagesStore.createIndex('conversation', 'conversation', { unique: false });
          messagesStore.createIndex('created_at', 'created_at', { unique: false });
        }
        
        console.log('📦 Offline storage schema created');
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // שמירת אירועים
  // ═══════════════════════════════════════════════════════════════════════════
  
  async function saveEvent(event) {
    if (!event || !event.id) return false;
    
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.EVENTS], 'readwrite');
      const store = tx.objectStore(STORES.EVENTS);
      
      // הוסף timestamp לשמירה
      event._saved_at = Date.now();
      
      store.put(event);
      return true;
    } catch (e) {
      console.error('Failed to save event:', e);
      return false;
    }
  }
  
  async function saveEvents(events) {
    if (!Array.isArray(events) || events.length === 0) return 0;
    
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.EVENTS], 'readwrite');
      const store = tx.objectStore(STORES.EVENTS);
      
      let saved = 0;
      for (const event of events) {
        if (event && event.id) {
          event._saved_at = Date.now();
          store.put(event);
          saved++;
        }
      }
      
      return saved;
    } catch (e) {
      console.error('Failed to save events:', e);
      return 0;
    }
  }
  
  async function getEvent(id) {
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.EVENTS], 'readonly');
      const store = tx.objectStore(STORES.EVENTS);
      
      return new Promise((resolve) => {
        const request = store.get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }
  
  async function getEventsByPubkey(pubkey, limit = 50) {
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.EVENTS], 'readonly');
      const store = tx.objectStore(STORES.EVENTS);
      const index = store.index('pubkey');
      
      return new Promise((resolve) => {
        const events = [];
        const request = index.openCursor(IDBKeyRange.only(pubkey));
        
        request.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor && events.length < limit) {
            events.push(cursor.value);
            cursor.continue();
          } else {
            // מיין לפי תאריך יורד
            events.sort((a, b) => b.created_at - a.created_at);
            resolve(events);
          }
        };
        
        request.onerror = () => resolve([]);
      });
    } catch (e) {
      return [];
    }
  }
  
  async function getRecentEvents(limit = 100) {
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.EVENTS], 'readonly');
      const store = tx.objectStore(STORES.EVENTS);
      const index = store.index('created_at');
      
      return new Promise((resolve) => {
        const events = [];
        const request = index.openCursor(null, 'prev'); // מהחדש לישן
        
        request.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor && events.length < limit) {
            events.push(cursor.value);
            cursor.continue();
          } else {
            resolve(events);
          }
        };
        
        request.onerror = () => resolve([]);
      });
    } catch (e) {
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // שמירת פרופילים
  // ═══════════════════════════════════════════════════════════════════════════
  
  async function saveProfile(profile) {
    if (!profile || !profile.pubkey) return false;
    
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.PROFILES], 'readwrite');
      const store = tx.objectStore(STORES.PROFILES);
      
      profile.updated_at = Date.now();
      store.put(profile);
      return true;
    } catch (e) {
      console.error('Failed to save profile:', e);
      return false;
    }
  }
  
  async function getProfile(pubkey) {
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.PROFILES], 'readonly');
      const store = tx.objectStore(STORES.PROFILES);
      
      return new Promise((resolve) => {
        const request = store.get(pubkey);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }
  
  async function getAllProfiles() {
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.PROFILES], 'readonly');
      const store = tx.objectStore(STORES.PROFILES);
      
      return new Promise((resolve) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => resolve([]);
      });
    } catch (e) {
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // שמירת לייקים ותגובות
  // ═══════════════════════════════════════════════════════════════════════════
  
  async function saveLike(like) {
    if (!like || !like.id) return false;
    
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.LIKES], 'readwrite');
      const store = tx.objectStore(STORES.LIKES);
      store.put(like);
      return true;
    } catch (e) {
      return false;
    }
  }
  
  async function getLikesForEvent(eventId) {
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.LIKES], 'readonly');
      const store = tx.objectStore(STORES.LIKES);
      const index = store.index('event_id');
      
      return new Promise((resolve) => {
        const request = index.getAll(eventId);
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => resolve([]);
      });
    } catch (e) {
      return [];
    }
  }
  
  async function saveComment(comment) {
    if (!comment || !comment.id) return false;
    
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.COMMENTS], 'readwrite');
      const store = tx.objectStore(STORES.COMMENTS);
      store.put(comment);
      return true;
    } catch (e) {
      return false;
    }
  }
  
  async function getCommentsForEvent(parentId) {
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.COMMENTS], 'readonly');
      const store = tx.objectStore(STORES.COMMENTS);
      const index = store.index('parent_id');
      
      return new Promise((resolve) => {
        const request = index.getAll(parentId);
        request.onsuccess = () => {
          const comments = request.result || [];
          comments.sort((a, b) => a.created_at - b.created_at);
          resolve(comments);
        };
        request.onerror = () => resolve([]);
      });
    } catch (e) {
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // שמירת התראות
  // ═══════════════════════════════════════════════════════════════════════════
  
  async function saveNotification(notification) {
    if (!notification || !notification.id) return false;
    
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.NOTIFICATIONS], 'readwrite');
      const store = tx.objectStore(STORES.NOTIFICATIONS);
      store.put(notification);
      return true;
    } catch (e) {
      return false;
    }
  }
  
  async function getNotifications(limit = 50) {
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.NOTIFICATIONS], 'readonly');
      const store = tx.objectStore(STORES.NOTIFICATIONS);
      const index = store.index('created_at');
      
      return new Promise((resolve) => {
        const notifications = [];
        const request = index.openCursor(null, 'prev');
        
        request.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor && notifications.length < limit) {
            notifications.push(cursor.value);
            cursor.continue();
          } else {
            resolve(notifications);
          }
        };
        
        request.onerror = () => resolve([]);
      });
    } catch (e) {
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // שמירת מדיה (תמונות פרופיל)
  // ═══════════════════════════════════════════════════════════════════════════
  
  async function cacheProfileImage(url, blob) {
    if (!url || !blob) return false;
    
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.MEDIA], 'readwrite');
      const store = tx.objectStore(STORES.MEDIA);
      
      store.put({
        url,
        blob,
        type: 'profile',
        cached_at: Date.now(),
      });
      return true;
    } catch (e) {
      return false;
    }
  }
  
  async function getProfileImage(url) {
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.MEDIA], 'readonly');
      const store = tx.objectStore(STORES.MEDIA);
      
      return new Promise((resolve) => {
        const request = store.get(url);
        request.onsuccess = () => {
          const result = request.result;
          if (result && result.blob) {
            resolve(URL.createObjectURL(result.blob));
          } else {
            resolve(null);
          }
        };
        request.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // סטטיסטיקות ותחזוקה
  // ═══════════════════════════════════════════════════════════════════════════
  
  async function getStats() {
    try {
      const database = await initDB();
      const stats = {};
      
      for (const storeName of Object.values(STORES)) {
        const tx = database.transaction([storeName], 'readonly');
        const store = tx.objectStore(storeName);
        
        await new Promise((resolve) => {
          const request = store.count();
          request.onsuccess = () => {
            stats[storeName] = request.result;
            resolve();
          };
          request.onerror = () => {
            stats[storeName] = 0;
            resolve();
          };
        });
      }
      
      return stats;
    } catch (e) {
      return {};
    }
  }
  
  async function cleanup(maxAge = 30 * 24 * 60 * 60 * 1000) {
    // מחק אירועים ישנים מ-30 יום
    const cutoff = Date.now() - maxAge;
    
    try {
      const database = await initDB();
      const tx = database.transaction([STORES.EVENTS], 'readwrite');
      const store = tx.objectStore(STORES.EVENTS);
      const index = store.index('created_at');
      
      const request = index.openCursor(IDBKeyRange.upperBound(cutoff / 1000));
      let deleted = 0;
      
      request.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          deleted++;
          cursor.continue();
        }
      };
      
      console.log(`🧹 Cleaned up ${deleted} old events`);
      return deleted;
    } catch (e) {
      return 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Hook לשמירה אוטומטית של אירועים
  // ═══════════════════════════════════════════════════════════════════════════
  
  function hookIntoNostrEvents() {
    // שמור כל אירוע שמגיע מה-relays
    const originalOnevent = App.pool?.subscribeMany;
    
    // Hook לשמירת פרופילים
    if (App.profileCache && App.profileCache.set) {
      const originalSet = App.profileCache.set.bind(App.profileCache);
      App.profileCache.set = function(pubkey, profile) {
        originalSet(pubkey, profile);
        saveProfile({ pubkey, ...profile });
      };
    }
    
    console.log('🔗 Hooked into Nostr events for offline storage');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // מצב חירום - טעינה מקומית
  // ═══════════════════════════════════════════════════════════════════════════
  
  async function loadOfflineData() {
    console.log('📴 Loading offline data...');
    
    // טען פרופילים ל-cache
    const profiles = await getAllProfiles();
    profiles.forEach(profile => {
      if (App.profileCache) {
        App.profileCache.set(profile.pubkey, profile);
      }
    });
    console.log(`  ✓ Loaded ${profiles.length} profiles`);
    
    // טען אירועים אחרונים
    const events = await getRecentEvents(100);
    console.log(`  ✓ Loaded ${events.length} recent events`);
    
    // טען התראות
    const notifications = await getNotifications(50);
    if (App.notifications) {
      App.notifications.push(...notifications);
    }
    console.log(`  ✓ Loaded ${notifications.length} notifications`);
    
    return { profiles, events, notifications };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ייצוא API
  // ═══════════════════════════════════════════════════════════════════════════
  
  App.OfflineStorage = {
    // אתחול
    init: initDB,
    isReady: () => isReady,
    
    // אירועים
    saveEvent,
    saveEvents,
    getEvent,
    getEventsByPubkey,
    getRecentEvents,
    
    // פרופילים
    saveProfile,
    getProfile,
    getAllProfiles,
    
    // לייקים ותגובות
    saveLike,
    getLikesForEvent,
    saveComment,
    getCommentsForEvent,
    
    // התראות
    saveNotification,
    getNotifications,
    
    // מדיה
    cacheProfileImage,
    getProfileImage,
    
    // תחזוקה
    getStats,
    cleanup,
    
    // מצב חירום
    loadOfflineData,
    hookIntoNostrEvents,
  };

  // אתחול אוטומטי
  initDB().then(() => {
    hookIntoNostrEvents();
    console.log('📦 Offline storage module ready');
  });

})(window);
