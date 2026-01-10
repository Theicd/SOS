// חלק Service Worker (service-worker.js) – PWA מלא עם cache, push, notifications ותמיכה ברקע | HYPER CORE TECH
(function initServiceWorker(self) {
  
  // חלק הגדרות Cache (service-worker.js) – שמות ורשימת קבצים לשמירה | HYPER CORE TECH
  const CACHE_NAME = 'sos-cache-v1';
  const PRECACHE_URLS = [
    './',
    './videos.html',
    './auth.html',
    './styles/facebook-theme.css',
    './styles/chat.css',
    './styles/chat-whatsapp-theme.css',
    './icons/sos-logo.jpg',
    './ICON.ico',
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
      await self.skipWaiting();
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
      console.log('[SW] Activated and claimed clients');
    })());
  });

  // חלק Fetch (service-worker.js) – טיפול בבקשות רשת עם fallback ל-cache | HYPER CORE TECH
  self.addEventListener('fetch', (event) => {
    // לא מטפלים בבקשות שאינן GET או בקשות חיצוניות
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    
    event.respondWith((async () => {
      try {
        // ניסיון לקבל מהרשת
        const networkResponse = await fetch(event.request);
        // שמירה ב-cache
        if (networkResponse.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, networkResponse.clone()).catch(() => {});
        }
        return networkResponse;
      } catch (err) {
        // Fallback ל-cache
        const cachedResponse = await caches.match(event.request);
        if (cachedResponse) return cachedResponse;
        // Fallback לדף הראשי
        if (event.request.mode === 'navigate') {
          return caches.match('./') || caches.match('./videos.html');
        }
        throw err;
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
    
    const title = payload.title || 'SOS';
    const options = {
      body: payload.body || 'יש לך עדכון חדש',
      icon: payload.icon || './icons/sos-logo.jpg',
      badge: payload.badge || './icons/sos-logo.jpg',
      tag: payload.tag || 'sos-notification',
      renotify: payload.renotify !== false,
      vibrate: payload.vibrate || [200, 100, 200],
      // חלק התרעות מתמידות (service-worker.js) – הגדרות לשמירת התרעה פעילה | HYPER CORE TECH
      requireInteraction: true,
      silent: false,
      data: {
        url: payload.url || payload.data?.url || './',
        type: payload.type || payload.data?.type || 'general',
        peerPubkey: payload.peerPubkey || payload.data?.peerPubkey || null,
        timestamp: Date.now(),
        ...payload.data,
      },
    };
    
    event.waitUntil(
      self.registration.showNotification(title, options)
    );
  });

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

  // חלק pushsubscriptionchange (service-worker.js) – חידוש מנוי Push | HYPER CORE TECH
  self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil((async () => {
      try {
        // ניסיון להירשם מחדש
        const subscription = await self.registration.pushManager.subscribe(event.oldSubscription.options);
        console.log('[SW] Push subscription renewed');
        // שליחה לשרת (אם יש)
        // await fetch('/api/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) });
      } catch (err) {
        console.error('[SW] Failed to renew push subscription:', err);
      }
    })());
  });

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
    return list[0];
  }

  async function focusOrOpenClient(url) {
    const client = await getFirstWindowClient();
    if (client) {
      try {
        await client.focus();
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

  self.addEventListener('notificationclick', (event) => {
    const notification = event.notification;
    const data = notification && notification.data ? notification.data : {};
    const type = data.type || '';
    const peerPubkey = data.peerPubkey || null;
    const url = data.url || './';

    try {
      notification.close();
    } catch {}

    // חלק Service Worker – תומך גם בשיחות קול (voice), וידאו (video) וגם הודעות טקסט | HYPER CORE TECH
    const isVoice = type === 'voice-call-incoming';
    const isVideo = type === 'video-call-incoming';
    const isChat = type === 'chat-message';
    if (!isVoice && !isVideo && !isChat) return;

    event.waitUntil((async () => {
      const message = {
        type: isVoice
          ? 'voice-call-notification-action'
          : isVideo
            ? 'video-call-notification-action'
            : 'chat-message-notification-action',
        action: 'open',
        peerPubkey
      };

      const client = await focusOrOpenClient(url);
      if (client) {
        try {
          client.postMessage(message);
        } catch {}
        return;
      }

      await postMessageToAllClients(message);
    })());
  });
})(self);
