// חלק Service Worker (service-worker.js) – PWA מלא עם cache, push, notifications ותמיכה ברקע | HYPER CORE TECH
(function initServiceWorker(self) {
  
  // חלק הגדרות Cache (service-worker.js) – שמות ורשימת קבצים לשמירה | HYPER CORE TECH
  const CACHE_NAME = 'sos-cache-v460'; // bump - header icons match 59px header row
  const PRECACHE_URLS = [
    './',
    './videos.html',
    './games.html', // דף משחקים – פיד משותף כמו הפיד הראשי
    './games.js',   // לוגיקת פיד משחקים + game-embed
    './game-embed.js',
    './styles/games.css', // עיצוב פיד משחקים
    './styles/videos.css',
    './auth.html',
    './styles/facebook-theme.css',
    './styles/chat.css',
    './styles/chat-whatsapp-theme.css',
    './icons/so-call010.png',
    './icons/WAPICON.png',
    './icons/sos-app-icon-192.png',
    './icons/sos-app-icon-512.png',
    './icons/sos-logo-mobile.png',
    './live-tv/curatedFavorites.json',
    './live-tv/live-tv-catalog.js',
    './loadnug/loadnug-animation.css',
    './loadnug/loadnug-controller.js',
    './native-shell-bridge.js',
    './manifest.webmanifest',
  ];

  // חלק Install (service-worker.js) – התקנה ושמירת קבצים ב-cache | HYPER CORE TECH
  self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        // שמירה של קבצים בסיסיים, התעלמות משגיאות
        await Promise.allSettled(PRECACHE_URLS.map(url => cache.add(url)));
        console.log('[SW] Precache completed');
      } catch (err) {
        console.warn('[SW] Precache failed:', err);
      }
      // לא קוראים skipWaiting כאן – ממתינים ללחיצת «עדכן» בכרטיסיית העדכון | HYPER CORE TECH
    })());
  });

  // חלק Activate (service-worker.js) – הפעלה וניקוי cache ישן | HYPER CORE TECH
  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      // ניקוי cache ישן
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
      await self.clients.claim();
      
      // חלק הודעת עדכון (service-worker.js) – הקליינט מחליט אם להציג toast (hadController) | HYPER CORE TECH
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((client) => {
        client.postMessage({ type: 'NEW_VERSION_ACTIVATED' });
      });
      
      console.log('[SW] Activated and notified', clients.length, 'clients');
    })());
  });

  // חלק Fetch (service-worker.js) – טיפול בבקשות רשת עם fallback ל-cache | HYPER CORE TECH
  // חלק excludePaths (service-worker.js) – נתיבים שלא לשמור בקאש | HYPER CORE TECH
  const EXCLUDE_PATHS = ['/api', '/auth', '/login', '/register', '/admin'];
  
  self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    
    // APK / הורדות – תמיד מהרשת, בלי cache של SW | HYPER CORE TECH
    if (url.pathname.includes('/downloads/') || url.pathname.endsWith('.apk')) return;

    // קובץ גרסה – תמיד מהרשת כדי לזהות דיפלוי חדש | HYPER CORE TECH
    if (url.pathname.endsWith('/app-version.json') || url.pathname.endsWith('app-version.json')) return;
    if (url.pathname.endsWith('/apk-version.json') || url.pathname.endsWith('apk-version.json')) return;

    // לא לשמור בקאש נתיבים דינמיים
    if (EXCLUDE_PATHS.some(p => url.pathname.startsWith(p))) return;
    
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(event.request);
        if (networkResponse.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, networkResponse.clone()).catch(() => {});
        }
        return networkResponse;
      } catch (err) {
        const cachedResponse = await caches.match(event.request);
        if (cachedResponse) return cachedResponse;
        if (event.request.mode === 'navigate') {
          const home = await caches.match('./');
          if (home) return home;
          return caches.match('./videos.html');
        }
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      }
    })());
  });

  // חלק Push (service-worker.js) – קבלת התראות Push מהשרת | HYPER CORE TECH
  self.addEventListener('push', (event) => {
    let payload = {};
    
    try {
      if (event.data) {
        payload = event.data.json();
      }
    } catch (err) {
      try {
        payload = { title: 'SOS', body: event.data?.text() || 'יש לך עדכון חדש' };
      } catch (e) {
        payload = { title: 'SOS', body: 'יש לך עדכון חדש' };
      }
    }
    
    // חלק P2P Wake-up (service-worker.js) – הערת הממשק כשמגיע Push | HYPER CORE TECH
    const pushType = payload.type || payload.data?.type || 'general';
    
    // אם זה סנכרון P2P שקט - לא מציגים notification אבל מעירים את הקליינטים
    if (pushType === 'p2p-sync' || pushType === 'p2p-wakeup') {
      event.waitUntil(handleP2PSyncPush(payload));
      return;
    }
    
    // חלק עדכון גרסה (service-worker.js) – טיפול בהודעת עדכון אפליקציה | HYPER CORE TECH
    if (pushType === 'app-update') {
      event.waitUntil(handleAppUpdatePush(payload));
      return;
    }
    
    // חלק זיהוי iOS (service-worker.js) – התאמת options לפי פלטפורמה | HYPER CORE TECH
    let isIOS = false;
    try { isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent); } catch (e) {}
    
    const title = payload.title || 'SOS';
    let peerPubkey = payload.peerPubkey || payload.data?.peerPubkey || null;
    let incomingCall = payload.incomingCall || payload.data?.incomingCall || null;
    if (!incomingCall) {
      if (pushType === 'voice-call-incoming') incomingCall = 'voice';
      if (pushType === 'video-call-incoming') incomingCall = 'video';
    }
    let openUrl = payload.url || payload.data?.url || './videos.html';
    try {
      openUrl = buildDeepLinkUrl(openUrl, peerPubkey, incomingCall);
    } catch (_) {}

    const options = {
      body: payload.body || 'יש לך עדכון חדש',
      icon: payload.icon || './icons/so-call010.png',
      badge: payload.badge || './icons/so-call010.png',
      tag: payload.tag || 'sos-notification',
      renotify: true,
      silent: false,
      data: {
        url: openUrl,
        type: pushType,
        peerPubkey,
        incomingCall,
        timestamp: Date.now(),
        ...payload.data,
        url: openUrl,
        peerPubkey,
        incomingCall,
        type: pushType,
      },
    };
    
    // חלק תאימות iOS (service-worker.js) – iOS לא תומך ב-actions, vibrate, requireInteraction | HYPER CORE TECH
    if (!isIOS) {
      options.requireInteraction = true;
      options.vibrate = payload.vibrate || [200, 100, 200];
      options.actions = [
        { action: 'open', title: 'פתח', icon: './icons/so-call010.png' },
        { action: 'dismiss', title: 'סגור' }
      ];
    }
    
    // חלק P2P Wake-up – גם בהתרעות רגילות, מעירים את הקליינטים לסנכרון | HYPER CORE TECH
    event.waitUntil(
      Promise.all([
        self.registration.showNotification(title, options),
        wakeUpClientsForSync(pushType, payload)
      ])
    );
  });

  // חלק עדכון גרסה (service-worker.js) – טיפול בעדכון אפליקציה | HYPER CORE TECH
  async function handleAppUpdatePush(payload) {
    console.log('[SW] App Update Push received', payload);
    
    // הודעת הקליינטים על עדכון זמין
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    
    if (clients.length > 0) {
      clients.forEach(client => {
        client.postMessage({ type: 'app-update-available', version: payload.version || 'new' });
      });
    } else {
      // אם אין קליינטים פתוחים - הצגת notification
      await self.registration.showNotification('עדכון זמין ל-SOS', {
        body: payload.body || 'גרסה חדשה זמינה! לחץ לעדכון',
        icon: './icons/so-call010.png',
        badge: './icons/so-call010.png',
        tag: 'app-update',
        requireInteraction: true,
        data: { type: 'app-update', url: './' }
      });
    }
  }

  // חלק P2P Wake-up (service-worker.js) – טיפול בסנכרון P2P שקט | HYPER CORE TECH
  async function handleP2PSyncPush(payload) {
    console.log('[SW] P2P Sync Push received', payload);
    
    // עדכון timestamp של סנכרון אחרון
    p2pCoordinator.lastSyncTime = Date.now();
    
    // הערת כל הקליינטים הפתוחים
    await wakeUpClientsForSync('p2p-sync', payload);
    
    // אם אין קליינטים פתוחים, שמירת הנתונים ל-IndexedDB (אופציונלי)
    const clients = await self.clients.matchAll({ type: 'window' });
    if (clients.length === 0) {
      console.log('[SW] אין קליינטים פתוחים - שומר נתוני sync');
      // כאן אפשר לשמור ב-IndexedDB לטעינה מאוחרת
    }
  }

  // חלק P2P Wake-up (service-worker.js) – הערת קליינטים לסנכרון | HYPER CORE TECH
  async function wakeUpClientsForSync(type, payload) {
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      
      if (clients.length > 0) {
        const message = {
          type: 'sw-wakeup',
          reason: type,
          timestamp: Date.now(),
          data: payload?.data || payload || {}
        };
        
        clients.forEach(client => {
          try {
            client.postMessage(message);
          } catch {}
        });
        
        console.log('[SW] Woke up', clients.length, 'clients for', type);
      }
    } catch (err) {
      console.warn('[SW] Failed to wake up clients:', err);
    }
  }

  // חלק Keep-Alive (service-worker.js) – שמירה על SW פעיל למניעת הירדמות | HYPER CORE TECH
  // הערה: זה עובד רק כשהאפליקציה פתוחה ברקע, לא במסך כבוי לגמרי
  let keepAliveInterval = null;
  
  function startKeepAlive() {
    if (keepAliveInterval) return;
    keepAliveInterval = setInterval(() => {
      // ping קטן לשמור את ה-SW ער
      self.clients.matchAll({ type: 'window' }).then(clients => {
        if (clients.length > 0) {
          clients.forEach(client => {
            try { client.postMessage({ type: 'sw-keepalive' }); } catch {}
          });
        }
      });
    }, 20000); // כל 20 שניות
  }
  
  // הפעלה אוטומטית
  startKeepAlive();

  // חלק pushsubscriptionchange (service-worker.js) – חידוש מנוי Push אוטומטי | HYPER CORE TECH
  self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil((async () => {
      try {
        // קבלת VAPID key מהשרת
        const configRes = await fetch('https://sos-push-server.vercel.app/api/push/config', { cache: 'no-store' });
        const config = configRes.ok ? await configRes.json() : null;
        
        if (!config?.publicKey) {
          console.warn('[SW] No VAPID key available for re-subscription');
          return;
        }
        
        // רישום מחדש
        const newSubscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.publicKey)
        });
        
        // שליחה לשרת
        await fetch('https://sos-push-server.vercel.app/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: newSubscription.toJSON() })
        });
        
        console.log('[SW] Push subscription renewed and sent to server');
      } catch (err) {
        console.error('[SW] Failed to renew push subscription:', err);
      }
    })());
  });
  
  // חלק המרת Base64 (service-worker.js) – המרת VAPID key | HYPER CORE TECH
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  // חלק Message (service-worker.js) – קבלת הודעות מהלקוח | HYPER CORE TECH
  self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') {
      self.skipWaiting();
    }
    
    // חלק P2P Coordinator (service-worker.js) – תיאום heartbeat בין טאבים | HYPER CORE TECH
    if (event.data?.type === 'p2p-heartbeat-request') {
      handleHeartbeatRequest(event.source, event.data);
    }
    if (event.data?.type === 'p2p-heartbeat-done') {
      handleHeartbeatDone(event.data);
    }
    if (event.data?.type === 'p2p-get-coordinator-state') {
      sendCoordinatorState(event.source);
    }
  });

  // חלק P2P Coordinator (service-worker.js) – ניהול heartbeat מרכזי | HYPER CORE TECH
  const p2pCoordinator = {
    lastHeartbeatTime: 0,
    currentLeaderClientId: null,
    heartbeatInterval: 60000, // ברירת מחדל
    peerCount: 0,
    networkTier: 'BOOTSTRAP'
  };

  async function handleHeartbeatRequest(client, data) {
    const now = Date.now();
    const timeSinceLastHeartbeat = now - p2pCoordinator.lastHeartbeatTime;
    
    // עדכון מצב הרשת מהלקוח
    if (data.networkTier) {
      p2pCoordinator.networkTier = data.networkTier;
    }
    if (typeof data.heartbeatInterval === 'number') {
      p2pCoordinator.heartbeatInterval = data.heartbeatInterval;
    }
    if (typeof data.peerCount === 'number') {
      p2pCoordinator.peerCount = data.peerCount;
    }
    
    // אם עבר מספיק זמן - מאשרים heartbeat
    if (timeSinceLastHeartbeat >= p2pCoordinator.heartbeatInterval * 0.8) {
      p2pCoordinator.lastHeartbeatTime = now;
      p2pCoordinator.currentLeaderClientId = client?.id || null;
      
      try {
        client.postMessage({
          type: 'p2p-heartbeat-approved',
          shouldSend: true,
          lastHeartbeat: p2pCoordinator.lastHeartbeatTime
        });
      } catch {}
      
      console.log('[SW] P2P Heartbeat approved for client', client?.id?.slice?.(0, 8));
    } else {
      // יש heartbeat אחרון מספיק חדש - דוחים
      try {
        client.postMessage({
          type: 'p2p-heartbeat-approved',
          shouldSend: false,
          lastHeartbeat: p2pCoordinator.lastHeartbeatTime,
          waitMs: p2pCoordinator.heartbeatInterval - timeSinceLastHeartbeat
        });
      } catch {}
    }
  }

  function handleHeartbeatDone(data) {
    if (data.success) {
      p2pCoordinator.lastHeartbeatTime = Date.now();
    }
    if (typeof data.peerCount === 'number') {
      p2pCoordinator.peerCount = data.peerCount;
    }
  }

  async function sendCoordinatorState(client) {
    try {
      client.postMessage({
        type: 'p2p-coordinator-state',
        ...p2pCoordinator
      });
    } catch {}
  }

  // חלק עדכון אוטומטי (service-worker.js) – בדיקת עדכונים כל 30 שניות | HYPER CORE TECH
  setInterval(() => {
    self.registration.update().catch(() => {});
  }, 30000);

  async function getFirstWindowClient() {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!list || !list.length) return null;
    // מעדיפים לקוח גלוי אם יש | HYPER CORE TECH
    const visible = list.find((c) => c.visibilityState === 'visible');
    return visible || list[0];
  }

  function buildDeepLinkUrl(baseUrl, peerPubkey, incomingCall) {
    try {
      const origin = self.location && self.location.origin ? self.location.origin : self.registration.scope;
      const absolute = new URL(baseUrl || '/videos.html', origin);
      if (!String(absolute.pathname || '').includes('videos.html')) {
        absolute.pathname = '/videos.html';
      }
      if (peerPubkey) absolute.searchParams.set('chat', String(peerPubkey).toLowerCase());
      if (incomingCall) absolute.searchParams.set('incomingCall', String(incomingCall));
      return absolute.href;
    } catch (_) {
      const q = [];
      if (peerPubkey) q.push(`chat=${encodeURIComponent(String(peerPubkey).toLowerCase())}`);
      if (incomingCall) q.push(`incomingCall=${encodeURIComponent(String(incomingCall))}`);
      return `./videos.html${q.length ? `?${q.join('&')}` : ''}`;
    }
  }

  async function focusOrOpenClient(url) {
    const client = await getFirstWindowClient();
    if (client) {
      try {
        await client.focus();
      } catch {}
      // ניווט בתוך הלקוח הקיים אם נתמך – אחרת postMessage יטפל | HYPER CORE TECH
      try {
        if (url && typeof client.navigate === 'function') {
          // לא מנווטים מחדש אם כבר באותו origin – רק focus+message
        }
      } catch {}
      return client;
    }

    if (url) {
      try {
        return await self.clients.openWindow(url);
      } catch {}
    }

    return null;
  }

  async function postMessageToAllClients(message) {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    (list || []).forEach((client) => {
      try {
        client.postMessage(message);
      } catch {}
    });
  }

  async function deliverNotificationAction(message, url) {
    const client = await focusOrOpenClient(url);
    const send = async (target) => {
      if (!target) return false;
      try {
        target.postMessage(message);
        return true;
      } catch {
        return false;
      }
    };

    if (client) {
      const ok = await send(client);
      if (ok) return;
      // חלון חדש לפעמים לא מוכן – ניסיונות חוזרים | HYPER CORE TECH
      for (const delay of [300, 800, 1600]) {
        await new Promise((r) => setTimeout(r, delay));
        const again = await getFirstWindowClient();
        if (again && await send(again)) return;
      }
    }

    await postMessageToAllClients(message);
  }

  // חלק Notification Click (service-worker.js) – לחיצה על התראת דפדפן → שיחה / מסך ענה | HYPER CORE TECH
  self.addEventListener('notificationclick', (event) => {
    const notification = event.notification;
    const action = event.action || 'open';
    const data = notification && notification.data ? notification.data : {};
    const type = data.type || 'general';
    const peerPubkey = data.peerPubkey || null;
    let url = data.url || './videos.html';
    let incomingCall = data.incomingCall || null;

    try {
      notification.close();
    } catch {}

    if (action === 'dismiss') return;

    event.waitUntil((async () => {
      let messageType = 'notification-action';

      if (type === 'voice-call-incoming') {
        messageType = 'voice-call-notification-action';
        incomingCall = incomingCall || 'voice';
      } else if (type === 'video-call-incoming') {
        messageType = 'video-call-notification-action';
        incomingCall = incomingCall || 'video';
      } else if (type === 'chat-message' || type === 'chat-message-aggregate') {
        messageType = 'chat-message-notification-action';
      } else if (type === 'missed-call') {
        messageType = 'missed-call-notification-action';
      } else if (type === 'app-update') {
        messageType = 'app-update-notification-action';
      }

      // URL עם deep link מסודר – גם אם הלקוח נפתח מחדש | HYPER CORE TECH
      url = buildDeepLinkUrl(url, peerPubkey, incomingCall);

      const message = {
        type: messageType,
        action: 'open',
        peerPubkey,
        incomingCall: incomingCall || '',
        notificationType: type,
        url,
        // תואם ל־chat-deeplink.js | HYPER CORE TECH
        chat: peerPubkey || '',
      };

      // הודעת deeplink אחידה בנוסף לסוג הספציפי | HYPER CORE TECH
      const deeplinkMessage = {
        type: 'sos-deeplink',
        chat: peerPubkey || '',
        incomingCall: incomingCall || '',
        url,
      };

      await deliverNotificationAction(message, url);
      await postMessageToAllClients(deeplinkMessage);
    })());
  });
})(self);
