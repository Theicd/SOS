// ׳³ג€”׳³ֲ׳³ֲ§ Service Worker (service-worker.js) ׳’ג‚¬ג€ PWA ׳³ֲ׳³ֲ׳³ֲ ׳³ֲ¢׳³ֲ cache, push, notifications ׳³ג€¢׳³ֳ—׳³ֲ׳³ג„¢׳³ג€÷׳³ג€ ׳³ג€˜׳³ֲ¨׳³ֲ§׳³ֲ¢ | HYPER CORE TECH
(function initServiceWorker(self) {
  
  // ׳³ג€”׳³ֲ׳³ֲ§ ׳³ג€׳³ג€™׳³ג€׳³ֲ¨׳³ג€¢׳³ֳ— Cache (service-worker.js) ׳’ג‚¬ג€ ׳³ֲ©׳³ֲ׳³ג€¢׳³ֳ— ׳³ג€¢׳³ֲ¨׳³ֲ©׳³ג„¢׳³ֲ׳³ֳ— ׳³ֲ§׳³ג€˜׳³ֲ¦׳³ג„¢׳³ֲ ׳³ֲ׳³ֲ©׳³ֲ׳³ג„¢׳³ֲ¨׳³ג€ | HYPER CORE TECH
  const CACHE_NAME = 'sos-cache-v899s-qa-stage5-ux2-20261011'; // I2 pending package only. Delete flag stays false. Not deployed by packaging.
  const PRECACHE_URLS = [
    './',
    './videos.html',
    './videos.js',
    './feed.js',
    './app.js',
    './chat-ui.js',
    './chat-state.js',
    './chat-e2ee.js',
    './chat-secure-epoch.js',
    './realtime-perf.js',
    './relay-health.js',
    './p2p-connection-state.js',
    './call-signal-e2ee.js',
    './nostr-event-integrity.js',
    './nostr-verify-worker.js',
    './identity-lifecycle.js',
    './session-authority.js',
    './sos-crypto-signer.js',
    './sos-crypto-worker.js',
    './sos-crypto-worker-vault.js',
    './admin-signing-policy.js',
    './community-context.js',
    './guest-access-control.js',
    './guest-p2p-schema.js',
    './guest-p2p-key-vault.js',
    './p2p-video-sharing.js',
    './vendor/nostr.bundle.min.js',
    './call-cold-boot.js',
    './chat-service.js',
    './media-file-e2ee.js',
    './media-server-e2ee.js',
    './blossom.js',
    './android-bridge.js',
    './emergency-bridge.js',
    './emergency-wrapper.js',
    './games.html',
    './games.js',
    './game-embed.js',
    './nzp-multiplayer.html',
    './styles/nzp-panel.css',
    './icons/nzp-cover.png',
    './styles/games.css',
    './styles/videos.css',
    './styles/base.css',
    './styles/tokens.css',
    './guest-auth.css',
    './guest-auth.js',
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
    './icons/chat-desktop-cyber-bg.png',
    './native-shell-bridge.js',
    './manifest.webmanifest',
    './index.html',
    './storage.html',
    './profile.html',
    './profile-viewer.html',
    './dating.html',
    './p2p-standby.html',
    './doom-multiplayer.html',
    './hexgl-multiplayer.html',
    './key-storage.js?pkg=899',
    './identity-storage-bootstrap.js?pkg=899',
    './auth-guard.js?pkg=899',
    './config.js?pkg=899',
    './keys.js?pkg=899',
    './app.js?pkg=899',
    './identity-lifecycle.js?pkg=899i',
    './f5b6w-handoff-client.js?pkg=899i',
    './signer-outage-isolation.js',
    './isolated-signer-trusted-import.js',
    './account.js?pkg=899',
    './key-viewer.js?pkg=899i',
    './sw-register.js?pkg=899',
  ];

  async function networkFirstThenCache(request, isNavigate) {
    try {
      const networkResponse = await fetch(request);
      if (networkResponse && networkResponse.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, networkResponse.clone()).catch(() => {});
        try {
          const u = new URL(request.url);
          if (u.search) {
            cache.put(new Request(u.origin + u.pathname), networkResponse.clone()).catch(() => {});
          }
        } catch (_e) {}
      }
      return networkResponse;
    } catch (_err) {
      const cached = await caches.match(request)
        || await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      if (isNavigate) {
        const home = await caches.match('./') || await caches.match('./videos.html');
        if (home) return home;
      }
      return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
    }
  }

  // ׳³ג€”׳³ֲ׳³ֲ§ Install (service-worker.js) ׳’ג‚¬ג€ ׳³ג€׳³ֳ—׳³ֲ§׳³ֲ ׳³ג€ ׳³ג€¢׳³ֲ©׳³ֲ׳³ג„¢׳³ֲ¨׳³ֳ— ׳³ֲ§׳³ג€˜׳³ֲ¦׳³ג„¢׳³ֲ ׳³ג€˜-cache | HYPER CORE TECH
  self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        // ׳³ֲ©׳³ֲ׳³ג„¢׳³ֲ¨׳³ג€ ׳³ֲ©׳³ֲ ׳³ֲ§׳³ג€˜׳³ֲ¦׳³ג„¢׳³ֲ ׳³ג€˜׳³ֲ¡׳³ג„¢׳³ֲ¡׳³ג„¢׳³ג„¢׳³ֲ, ׳³ג€׳³ֳ—׳³ֲ¢׳³ֲ׳³ֲ׳³ג€¢׳³ֳ— ׳³ֲ׳³ֲ©׳³ג€™׳³ג„¢׳³ֲ׳³ג€¢׳³ֳ—
        await Promise.allSettled(PRECACHE_URLS.map(url => cache.add(url)));
        console.log('[SW] Precache completed');
      } catch (err) {
        console.warn('[SW] Precache failed:', err);
      }
      await self.skipWaiting();
    })());
  });

  // ׳³ג€”׳³ֲ׳³ֲ§ Activate (service-worker.js) ׳’ג‚¬ג€ ׳³ג€׳³ג‚×׳³ֲ¢׳³ֲ׳³ג€ ׳³ג€¢׳³ֲ ׳³ג„¢׳³ֲ§׳³ג€¢׳³ג„¢ cache ׳³ג„¢׳³ֲ©׳³ֲ | HYPER CORE TECH
  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      // ׳³ֲ ׳³ג„¢׳³ֲ§׳³ג€¢׳³ג„¢ cache ׳³ג„¢׳³ֲ©׳³ֲ
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
      await self.clients.claim();
      
      // ׳³ג€”׳³ֲ׳³ֲ§ ׳³ג€׳³ג€¢׳³ג€׳³ֲ¢׳³ֳ— ׳³ֲ¢׳³ג€׳³ג€÷׳³ג€¢׳³ֲ (service-worker.js) ׳’ג‚¬ג€ ׳³ג€׳³ֲ§׳³ֲ׳³ג„¢׳³ג„¢׳³ֲ ׳³ֻ ׳³ֲ׳³ג€”׳³ֲ׳³ג„¢׳³ֻ ׳³ֲ׳³ֲ ׳³ֲ׳³ג€׳³ֲ¦׳³ג„¢׳³ג€™ toast (hadController) | HYPER CORE TECH
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((client) => {
        client.postMessage({ type: 'NEW_VERSION_ACTIVATED' });
      });
      
      console.log('[SW] Activated and notified', clients.length, 'clients');
    })());
  });

  // ׳³ג€”׳³ֲ׳³ֲ§ Fetch (service-worker.js) ׳’ג‚¬ג€ ׳³ֻ׳³ג„¢׳³ג‚×׳³ג€¢׳³ֲ ׳³ג€˜׳³ג€˜׳³ֲ§׳³ֲ©׳³ג€¢׳³ֳ— ׳³ֲ¨׳³ֲ©׳³ֳ— ׳³ֲ¢׳³ֲ fallback ׳³ֲ-cache | HYPER CORE TECH
  // ׳³ג€”׳³ֲ׳³ֲ§ excludePaths (service-worker.js) ׳’ג‚¬ג€ ׳³ֲ ׳³ֳ—׳³ג„¢׳³ג€˜׳³ג„¢׳³ֲ ׳³ֲ©׳³ֲ׳³ֲ ׳³ֲ׳³ֲ©׳³ֲ׳³ג€¢׳³ֲ¨ ׳³ג€˜׳³ֲ§׳³ֲ׳³ֲ© | HYPER CORE TECH
  const EXCLUDE_PATHS = ['/api', '/auth', '/login', '/register', '/admin'];
  
  self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    
    // APK / ׳³ג€׳³ג€¢׳³ֲ¨׳³ג€׳³ג€¢׳³ֳ— ׳’ג‚¬ג€ ׳³ֳ—׳³ֲ׳³ג„¢׳³ג€ ׳³ֲ׳³ג€׳³ֲ¨׳³ֲ©׳³ֳ—, ׳³ג€˜׳³ֲ׳³ג„¢ cache ׳³ֲ©׳³ֲ SW | HYPER CORE TECH
    if (url.pathname.includes('/downloads/') || url.pathname.endsWith('.apk')) return;

    // ׳³ֲ§׳³ג€¢׳³ג€˜׳³ֲ¥ ׳³ג€™׳³ֲ¨׳³ֲ¡׳³ג€ ׳’ג‚¬ג€ ׳³ֳ—׳³ֲ׳³ג„¢׳³ג€ ׳³ֲ׳³ג€׳³ֲ¨׳³ֲ©׳³ֳ— ׳³ג€÷׳³ג€׳³ג„¢ ׳³ֲ׳³ג€“׳³ג€׳³ג€¢׳³ֳ— ׳³ג€׳³ג„¢׳³ג‚×׳³ֲ׳³ג€¢׳³ג„¢ ׳³ג€”׳³ג€׳³ֲ© | HYPER CORE TECH
    if (url.pathname.endsWith('/app-version.json') || url.pathname.endsWith('app-version.json')) return;
    if (url.pathname.endsWith('/apk-version.json') || url.pathname.endsWith('apk-version.json')) return;
    // ׳³ג€׳³ג€™׳³ֲ׳³ג„¢ ׳³ֲ¨׳³ג„¢׳³ֲ¦׳³ג€ ׳³ֲ§׳³ֲ ׳³ג€¢׳³ֲ ׳³ג„¢׳³ג„¢׳³ֲ ׳’ג‚¬ג€ ׳³ֳ—׳³ֲ׳³ג„¢׳³ג€ ׳³ֲ׳³ג€׳³ֲ¨׳³ֲ©׳³ֳ—, ׳³ֲ׳³ֲ¢׳³ג€¢׳³ֲ׳³ֲ ׳³ֲ׳³ֲ ׳³ֲ׳³ג€-cache (fail-closed ׳³ג€÷׳³ֲ©׳³ֲ׳³ג„¢׳³ֲ ׳³ֲ¨׳³ֲ©׳³ֳ—) | HYPER CORE TECH
    if (url.pathname.endsWith('/runtime-feature-flags.json')) return;

    // ׳³ֲ׳³ֲ ׳³ֲ׳³ֲ©׳³ֲ׳³ג€¢׳³ֲ¨ ׳³ג€˜׳³ֲ§׳³ֲ׳³ֲ© ׳³ֲ ׳³ֳ—׳³ג„¢׳³ג€˜׳³ג„¢׳³ֲ ׳³ג€׳³ג„¢׳³ֲ ׳³ֲ׳³ג„¢׳³ג„¢׳³ֲ
    if (EXCLUDE_PATHS.some(p => url.pathname.startsWith(p))) return;

    event.respondWith(
      networkFirstThenCache(event.request, event.request.mode === 'navigate')
    );
  });

  // ׳³ג€”׳³ֲ׳³ֲ§ Push (service-worker.js) ׳’ג‚¬ג€ ׳³ֲ§׳³ג€˜׳³ֲ׳³ֳ— ׳³ג€׳³ֳ—׳³ֲ¨׳³ֲ׳³ג€¢׳³ֳ— Push ׳³ֲ׳³ג€׳³ֲ©׳³ֲ¨׳³ֳ— | HYPER CORE TECH
  self.addEventListener('push', (event) => {
    let payload = {};
    
    try {
      if (event.data) {
        payload = event.data.json();
      }
    } catch (err) {
      try {
        payload = { title: 'SOS', body: event.data?.text() || '׳³ג„¢׳³ֲ© ׳³ֲ׳³ֲ ׳³ֲ¢׳³ג€׳³ג€÷׳³ג€¢׳³ֲ ׳³ג€”׳³ג€׳³ֲ©' };
      } catch (e) {
        payload = { title: 'SOS', body: '׳³ג„¢׳³ֲ© ׳³ֲ׳³ֲ ׳³ֲ¢׳³ג€׳³ג€÷׳³ג€¢׳³ֲ ׳³ג€”׳³ג€׳³ֲ©' };
      }
    }
    
    // ׳³ג€”׳³ֲ׳³ֲ§ P2P Wake-up (service-worker.js) ׳’ג‚¬ג€ ׳³ג€׳³ֲ¢׳³ֲ¨׳³ֳ— ׳³ג€׳³ֲ׳³ֲ׳³ֲ©׳³ֲ§ ׳³ג€÷׳³ֲ©׳³ֲ׳³ג€™׳³ג„¢׳³ֲ¢ Push | HYPER CORE TECH
    const pushType = payload.type || payload.data?.type || 'general';
    
    // ׳³ֲ׳³ֲ ׳³ג€“׳³ג€ ׳³ֲ¡׳³ֲ ׳³ג€÷׳³ֲ¨׳³ג€¢׳³ֲ P2P ׳³ֲ©׳³ֲ§׳³ֻ - ׳³ֲ׳³ֲ ׳³ֲ׳³ֲ¦׳³ג„¢׳³ג€™׳³ג„¢׳³ֲ notification ׳³ֲ׳³ג€˜׳³ֲ ׳³ֲ׳³ֲ¢׳³ג„¢׳³ֲ¨׳³ג„¢׳³ֲ ׳³ֲ׳³ֳ— ׳³ג€׳³ֲ§׳³ֲ׳³ג„¢׳³ג„¢׳³ֲ ׳³ֻ׳³ג„¢׳³ֲ
    if (pushType === 'p2p-sync' || pushType === 'p2p-wakeup') {
      event.waitUntil(handleP2PSyncPush(payload));
      return;
    }
    
    // ׳³ג€”׳³ֲ׳³ֲ§ ׳³ֲ¢׳³ג€׳³ג€÷׳³ג€¢׳³ֲ ׳³ג€™׳³ֲ¨׳³ֲ¡׳³ג€ (service-worker.js) ׳’ג‚¬ג€ ׳³ֻ׳³ג„¢׳³ג‚×׳³ג€¢׳³ֲ ׳³ג€˜׳³ג€׳³ג€¢׳³ג€׳³ֲ¢׳³ֳ— ׳³ֲ¢׳³ג€׳³ג€÷׳³ג€¢׳³ֲ ׳³ֲ׳³ג‚×׳³ֲ׳³ג„¢׳³ֲ§׳³ֲ¦׳³ג„¢׳³ג€ | HYPER CORE TECH
    if (pushType === 'app-update') {
      event.waitUntil(handleAppUpdatePush(payload));
      return;
    }
    
    // ׳³ג€”׳³ֲ׳³ֲ§ ׳³ג€“׳³ג„¢׳³ג€׳³ג€¢׳³ג„¢ iOS (service-worker.js) ׳’ג‚¬ג€ ׳³ג€׳³ֳ—׳³ֲ׳³ֲ׳³ֳ— options ׳³ֲ׳³ג‚×׳³ג„¢ ׳³ג‚×׳³ֲ׳³ֻ׳³ג‚×׳³ג€¢׳³ֲ¨׳³ֲ׳³ג€ | HYPER CORE TECH
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
      body: payload.body || '׳³ג„¢׳³ֲ© ׳³ֲ׳³ֲ ׳³ֲ¢׳³ג€׳³ג€÷׳³ג€¢׳³ֲ ׳³ג€”׳³ג€׳³ֲ©',
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
    
    // ׳³ג€”׳³ֲ׳³ֲ§ ׳³ֳ—׳³ֲ׳³ג„¢׳³ֲ׳³ג€¢׳³ֳ— iOS (service-worker.js) ׳’ג‚¬ג€ iOS ׳³ֲ׳³ֲ ׳³ֳ—׳³ג€¢׳³ֲ׳³ֲ ׳³ג€˜-actions, vibrate, requireInteraction | HYPER CORE TECH
    if (!isIOS) {
      options.requireInteraction = true;
      options.vibrate = payload.vibrate || [200, 100, 200];
      options.actions = [
        { action: 'open', title: '׳³ג‚×׳³ֳ—׳³ג€”', icon: './icons/so-call010.png' },
        { action: 'dismiss', title: '׳³ֲ¡׳³ג€™׳³ג€¢׳³ֲ¨' }
      ];
    }
    
    // ׳³ג€”׳³ֲ׳³ֲ§ P2P Wake-up ׳’ג‚¬ג€ ׳³ג€™׳³ֲ ׳³ג€˜׳³ג€׳³ֳ—׳³ֲ¨׳³ֲ¢׳³ג€¢׳³ֳ— ׳³ֲ¨׳³ג€™׳³ג„¢׳³ֲ׳³ג€¢׳³ֳ—, ׳³ֲ׳³ֲ¢׳³ג„¢׳³ֲ¨׳³ג„¢׳³ֲ ׳³ֲ׳³ֳ— ׳³ג€׳³ֲ§׳³ֲ׳³ג„¢׳³ג„¢׳³ֲ ׳³ֻ׳³ג„¢׳³ֲ ׳³ֲ׳³ֲ¡׳³ֲ ׳³ג€÷׳³ֲ¨׳³ג€¢׳³ֲ | HYPER CORE TECH
    event.waitUntil(
      Promise.all([
        self.registration.showNotification(title, options),
        wakeUpClientsForSync(pushType, payload)
      ])
    );
  });

  // ׳³ג€”׳³ֲ׳³ֲ§ ׳³ֲ¢׳³ג€׳³ג€÷׳³ג€¢׳³ֲ ׳³ג€™׳³ֲ¨׳³ֲ¡׳³ג€ (service-worker.js) ׳’ג‚¬ג€ ׳³ֻ׳³ג„¢׳³ג‚×׳³ג€¢׳³ֲ ׳³ג€˜׳³ֲ¢׳³ג€׳³ג€÷׳³ג€¢׳³ֲ ׳³ֲ׳³ג‚×׳³ֲ׳³ג„¢׳³ֲ§׳³ֲ¦׳³ג„¢׳³ג€ | HYPER CORE TECH
  async function handleAppUpdatePush(payload) {
    console.log('[SW] App Update Push received', {
      type: payload && payload.type,
      action: payload && payload.action,
      version: payload && payload.version,
      status: payload && payload.status
    });
    
    // ׳³ג€׳³ג€¢׳³ג€׳³ֲ¢׳³ֳ— ׳³ג€׳³ֲ§׳³ֲ׳³ג„¢׳³ג„¢׳³ֲ ׳³ֻ׳³ג„¢׳³ֲ ׳³ֲ¢׳³ֲ ׳³ֲ¢׳³ג€׳³ג€÷׳³ג€¢׳³ֲ ׳³ג€“׳³ֲ׳³ג„¢׳³ֲ
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    
    if (clients.length > 0) {
      clients.forEach(client => {
        client.postMessage({ type: 'app-update-available', version: payload.version || 'new' });
      });
    } else {
      // ׳³ֲ׳³ֲ ׳³ֲ׳³ג„¢׳³ֲ ׳³ֲ§׳³ֲ׳³ג„¢׳³ג„¢׳³ֲ ׳³ֻ׳³ג„¢׳³ֲ ׳³ג‚×׳³ֳ—׳³ג€¢׳³ג€”׳³ג„¢׳³ֲ - ׳³ג€׳³ֲ¦׳³ג€™׳³ֳ— notification
      await self.registration.showNotification('׳³ֲ¢׳³ג€׳³ג€÷׳³ג€¢׳³ֲ ׳³ג€“׳³ֲ׳³ג„¢׳³ֲ ׳³ֲ-SOS', {
        body: payload.body || '׳³ג€™׳³ֲ¨׳³ֲ¡׳³ג€ ׳³ג€”׳³ג€׳³ֲ©׳³ג€ ׳³ג€“׳³ֲ׳³ג„¢׳³ֲ ׳³ג€! ׳³ֲ׳³ג€”׳³ֲ¥ ׳³ֲ׳³ֲ¢׳³ג€׳³ג€÷׳³ג€¢׳³ֲ',
        icon: './icons/so-call010.png',
        badge: './icons/so-call010.png',
        tag: 'app-update',
        requireInteraction: true,
        data: { type: 'app-update', url: './' }
      });
    }
  }

  // ׳³ג€”׳³ֲ׳³ֲ§ P2P Wake-up (service-worker.js) ׳’ג‚¬ג€ ׳³ֻ׳³ג„¢׳³ג‚×׳³ג€¢׳³ֲ ׳³ג€˜׳³ֲ¡׳³ֲ ׳³ג€÷׳³ֲ¨׳³ג€¢׳³ֲ P2P ׳³ֲ©׳³ֲ§׳³ֻ | HYPER CORE TECH
  async function handleP2PSyncPush(payload) {
    console.log('[SW] P2P Sync Push received', {
      type: payload && payload.type,
      action: payload && payload.action,
      version: payload && payload.version,
      status: payload && payload.status
    });
    
    // ׳³ֲ¢׳³ג€׳³ג€÷׳³ג€¢׳³ֲ timestamp ׳³ֲ©׳³ֲ ׳³ֲ¡׳³ֲ ׳³ג€÷׳³ֲ¨׳³ג€¢׳³ֲ ׳³ֲ׳³ג€”׳³ֲ¨׳³ג€¢׳³ֲ
    p2pCoordinator.lastSyncTime = Date.now();
    
    // ׳³ג€׳³ֲ¢׳³ֲ¨׳³ֳ— ׳³ג€÷׳³ֲ ׳³ג€׳³ֲ§׳³ֲ׳³ג„¢׳³ג„¢׳³ֲ ׳³ֻ׳³ג„¢׳³ֲ ׳³ג€׳³ג‚×׳³ֳ—׳³ג€¢׳³ג€”׳³ג„¢׳³ֲ
    await wakeUpClientsForSync('p2p-sync', payload);
    
    // ׳³ֲ׳³ֲ ׳³ֲ׳³ג„¢׳³ֲ ׳³ֲ§׳³ֲ׳³ג„¢׳³ג„¢׳³ֲ ׳³ֻ׳³ג„¢׳³ֲ ׳³ג‚×׳³ֳ—׳³ג€¢׳³ג€”׳³ג„¢׳³ֲ, ׳³ֲ©׳³ֲ׳³ג„¢׳³ֲ¨׳³ֳ— ׳³ג€׳³ֲ ׳³ֳ—׳³ג€¢׳³ֲ ׳³ג„¢׳³ֲ ׳³ֲ-IndexedDB (׳³ֲ׳³ג€¢׳³ג‚×׳³ֲ¦׳³ג„¢׳³ג€¢׳³ֲ ׳³ֲ׳³ג„¢)
    const clients = await self.clients.matchAll({ type: 'window' });
    if (clients.length === 0) {
      console.log('[SW] ׳³ֲ׳³ג„¢׳³ֲ ׳³ֲ§׳³ֲ׳³ג„¢׳³ג„¢׳³ֲ ׳³ֻ׳³ג„¢׳³ֲ ׳³ג‚×׳³ֳ—׳³ג€¢׳³ג€”׳³ג„¢׳³ֲ - ׳³ֲ©׳³ג€¢׳³ֲ׳³ֲ¨ ׳³ֲ ׳³ֳ—׳³ג€¢׳³ֲ ׳³ג„¢ sync');
      // ׳³ג€÷׳³ֲ׳³ֲ ׳³ֲ׳³ג‚×׳³ֲ©׳³ֲ¨ ׳³ֲ׳³ֲ©׳³ֲ׳³ג€¢׳³ֲ¨ ׳³ג€˜-IndexedDB ׳³ֲ׳³ֻ׳³ֲ¢׳³ג„¢׳³ֲ ׳³ג€ ׳³ֲ׳³ֲ׳³ג€¢׳³ג€”׳³ֲ¨׳³ֳ—
    }
  }

  // ׳³ג€”׳³ֲ׳³ֲ§ P2P Wake-up (service-worker.js) ׳’ג‚¬ג€ ׳³ג€׳³ֲ¢׳³ֲ¨׳³ֳ— ׳³ֲ§׳³ֲ׳³ג„¢׳³ג„¢׳³ֲ ׳³ֻ׳³ג„¢׳³ֲ ׳³ֲ׳³ֲ¡׳³ֲ ׳³ג€÷׳³ֲ¨׳³ג€¢׳³ֲ | HYPER CORE TECH
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

  // ׳³ג€”׳³ֲ׳³ֲ§ Keep-Alive (service-worker.js) ׳’ג‚¬ג€ ׳³ֲ©׳³ֲ׳³ג„¢׳³ֲ¨׳³ג€ ׳³ֲ¢׳³ֲ SW ׳³ג‚×׳³ֲ¢׳³ג„¢׳³ֲ ׳³ֲ׳³ֲ׳³ֲ ׳³ג„¢׳³ֲ¢׳³ֳ— ׳³ג€׳³ג„¢׳³ֲ¨׳³ג€׳³ֲ׳³ג€¢׳³ֳ— | HYPER CORE TECH
  // ׳³ג€׳³ֲ¢׳³ֲ¨׳³ג€: ׳³ג€“׳³ג€ ׳³ֲ¢׳³ג€¢׳³ג€˜׳³ג€ ׳³ֲ¨׳³ֲ§ ׳³ג€÷׳³ֲ©׳³ג€׳³ֲ׳³ג‚×׳³ֲ׳³ג„¢׳³ֲ§׳³ֲ¦׳³ג„¢׳³ג€ ׳³ג‚×׳³ֳ—׳³ג€¢׳³ג€”׳³ג€ ׳³ג€˜׳³ֲ¨׳³ֲ§׳³ֲ¢, ׳³ֲ׳³ֲ ׳³ג€˜׳³ֲ׳³ֲ¡׳³ֲ ׳³ג€÷׳³ג€˜׳³ג€¢׳³ג„¢ ׳³ֲ׳³ג€™׳³ֲ׳³ֲ¨׳³ג„¢
  let keepAliveInterval = null;
  
  function startKeepAlive() {
    if (keepAliveInterval) return;
    keepAliveInterval = setInterval(() => {
      // ping ׳³ֲ§׳³ֻ׳³ֲ ׳³ֲ׳³ֲ©׳³ֲ׳³ג€¢׳³ֲ¨ ׳³ֲ׳³ֳ— ׳³ג€-SW ׳³ֲ¢׳³ֲ¨
      self.clients.matchAll({ type: 'window' }).then(clients => {
        if (clients.length > 0) {
          clients.forEach(client => {
            try { client.postMessage({ type: 'sw-keepalive' }); } catch {}
          });
        }
      });
    }, 20000); // ׳³ג€÷׳³ֲ 20 ׳³ֲ©׳³ֲ ׳³ג„¢׳³ג€¢׳³ֳ—
  }
  
  // ׳³ג€׳³ג‚×׳³ֲ¢׳³ֲ׳³ג€ ׳³ֲ׳³ג€¢׳³ֻ׳³ג€¢׳³ֲ׳³ֻ׳³ג„¢׳³ֳ—
  startKeepAlive();

  // ׳³ג€”׳³ֲ׳³ֲ§ pushsubscriptionchange (service-worker.js) ׳’ג‚¬ג€ ׳³ג€”׳³ג„¢׳³ג€׳³ג€¢׳³ֲ© ׳³ֲ׳³ֲ ׳³ג€¢׳³ג„¢ Push ׳³ֲ׳³ג€¢׳³ֻ׳³ג€¢׳³ֲ׳³ֻ׳³ג„¢ | HYPER CORE TECH
  self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil((async () => {
      try {
        // ׳³ֲ§׳³ג€˜׳³ֲ׳³ֳ— VAPID key ׳³ֲ׳³ג€׳³ֲ©׳³ֲ¨׳³ֳ—
        const configRes = await fetch('https://sos-push-server.vercel.app/api/push/config', { cache: 'no-store' });
        const config = configRes.ok ? await configRes.json() : null;
        
        if (!config?.publicKey) {
          console.warn('[SW] No VAPID key available for re-subscription');
          return;
        }
        
        // ׳³ֲ¨׳³ג„¢׳³ֲ©׳³ג€¢׳³ֲ ׳³ֲ׳³ג€”׳³ג€׳³ֲ©
        const newSubscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.publicKey)
        });
        
        // ׳³ֲ©׳³ֲ׳³ג„¢׳³ג€”׳³ג€ ׳³ֲ׳³ֲ©׳³ֲ¨׳³ֳ—
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
  
  // ׳³ג€”׳³ֲ׳³ֲ§ ׳³ג€׳³ֲ׳³ֲ¨׳³ֳ— Base64 (service-worker.js) ׳’ג‚¬ג€ ׳³ג€׳³ֲ׳³ֲ¨׳³ֳ— VAPID key | HYPER CORE TECH
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

  // ׳³ג€”׳³ֲ׳³ֲ§ Message (service-worker.js) ׳’ג‚¬ג€ ׳³ֲ§׳³ג€˜׳³ֲ׳³ֳ— ׳³ג€׳³ג€¢׳³ג€׳³ֲ¢׳³ג€¢׳³ֳ— ׳³ֲ׳³ג€׳³ֲ׳³ֲ§׳³ג€¢׳³ג€” | HYPER CORE TECH
  self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') {
      self.skipWaiting();
    }
    
    // ׳³ג€”׳³ֲ׳³ֲ§ P2P Coordinator (service-worker.js) ׳’ג‚¬ג€ ׳³ֳ—׳³ג„¢׳³ֲ׳³ג€¢׳³ֲ heartbeat ׳³ג€˜׳³ג„¢׳³ֲ ׳³ֻ׳³ֲ׳³ג€˜׳³ג„¢׳³ֲ | HYPER CORE TECH
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

  // ׳³ג€”׳³ֲ׳³ֲ§ P2P Coordinator (service-worker.js) ׳’ג‚¬ג€ ׳³ֲ ׳³ג„¢׳³ג€׳³ג€¢׳³ֲ heartbeat ׳³ֲ׳³ֲ¨׳³ג€÷׳³ג€“׳³ג„¢ | HYPER CORE TECH
  const p2pCoordinator = {
    lastHeartbeatTime: 0,
    currentLeaderClientId: null,
    heartbeatInterval: 60000, // ׳³ג€˜׳³ֲ¨׳³ג„¢׳³ֲ¨׳³ֳ— ׳³ֲ׳³ג€”׳³ג€׳³ֲ
    peerCount: 0,
    networkTier: 'BOOTSTRAP'
  };

  async function handleHeartbeatRequest(client, data) {
    const now = Date.now();
    const timeSinceLastHeartbeat = now - p2pCoordinator.lastHeartbeatTime;
    
    // ׳³ֲ¢׳³ג€׳³ג€÷׳³ג€¢׳³ֲ ׳³ֲ׳³ֲ¦׳³ג€˜ ׳³ג€׳³ֲ¨׳³ֲ©׳³ֳ— ׳³ֲ׳³ג€׳³ֲ׳³ֲ§׳³ג€¢׳³ג€”
    if (data.networkTier) {
      p2pCoordinator.networkTier = data.networkTier;
    }
    if (typeof data.heartbeatInterval === 'number') {
      p2pCoordinator.heartbeatInterval = data.heartbeatInterval;
    }
    if (typeof data.peerCount === 'number') {
      p2pCoordinator.peerCount = data.peerCount;
    }
    
    // ׳³ֲ׳³ֲ ׳³ֲ¢׳³ג€˜׳³ֲ¨ ׳³ֲ׳³ֲ¡׳³ג‚×׳³ג„¢׳³ֲ§ ׳³ג€“׳³ֲ׳³ֲ - ׳³ֲ׳³ֲ׳³ֲ©׳³ֲ¨׳³ג„¢׳³ֲ heartbeat
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
      // ׳³ג„¢׳³ֲ© heartbeat ׳³ֲ׳³ג€”׳³ֲ¨׳³ג€¢׳³ֲ ׳³ֲ׳³ֲ¡׳³ג‚×׳³ג„¢׳³ֲ§ ׳³ג€”׳³ג€׳³ֲ© - ׳³ג€׳³ג€¢׳³ג€”׳³ג„¢׳³ֲ
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

  // ׳³ג€”׳³ֲ׳³ֲ§ ׳³ֲ¢׳³ג€׳³ג€÷׳³ג€¢׳³ֲ ׳³ֲ׳³ג€¢׳³ֻ׳³ג€¢׳³ֲ׳³ֻ׳³ג„¢ (service-worker.js) ׳’ג‚¬ג€ ׳³ג€˜׳³ג€׳³ג„¢׳³ֲ§׳³ֳ— ׳³ֲ¢׳³ג€׳³ג€÷׳³ג€¢׳³ֲ ׳³ג„¢׳³ֲ ׳³ג€÷׳³ֲ 30 ׳³ֲ©׳³ֲ ׳³ג„¢׳³ג€¢׳³ֳ— | HYPER CORE TECH
  setInterval(() => {
    self.registration.update().catch(() => {});
  }, 30000);

  async function getFirstWindowClient() {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!list || !list.length) return null;
    // ׳³ֲ׳³ֲ¢׳³ג€׳³ג„¢׳³ג‚×׳³ג„¢׳³ֲ ׳³ֲ׳³ֲ§׳³ג€¢׳³ג€” ׳³ג€™׳³ֲ׳³ג€¢׳³ג„¢ ׳³ֲ׳³ֲ ׳³ג„¢׳³ֲ© | HYPER CORE TECH
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
      // ׳³ֲ ׳³ג„¢׳³ג€¢׳³ג€¢׳³ֻ ׳³ג€˜׳³ֳ—׳³ג€¢׳³ֲ ׳³ג€׳³ֲ׳³ֲ§׳³ג€¢׳³ג€” ׳³ג€׳³ֲ§׳³ג„¢׳³ג„¢׳³ֲ ׳³ֲ׳³ֲ ׳³ֲ ׳³ֳ—׳³ֲ׳³ֲ ׳’ג‚¬ג€ ׳³ֲ׳³ג€”׳³ֲ¨׳³ֳ— postMessage ׳³ג„¢׳³ֻ׳³ג‚×׳³ֲ | HYPER CORE TECH
      try {
        if (url && typeof client.navigate === 'function') {
          // ׳³ֲ׳³ֲ ׳³ֲ׳³ֲ ׳³ג€¢׳³ג€¢׳³ֻ׳³ג„¢׳³ֲ ׳³ֲ׳³ג€”׳³ג€׳³ֲ© ׳³ֲ׳³ֲ ׳³ג€÷׳³ג€˜׳³ֲ¨ ׳³ג€˜׳³ֲ׳³ג€¢׳³ֳ—׳³ג€¢ origin ׳’ג‚¬ג€ ׳³ֲ¨׳³ֲ§ focus+message
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
      // ׳³ג€”׳³ֲ׳³ג€¢׳³ֲ ׳³ג€”׳³ג€׳³ֲ© ׳³ֲ׳³ג‚×׳³ֲ¢׳³ֲ׳³ג„¢׳³ֲ ׳³ֲ׳³ֲ ׳³ֲ׳³ג€¢׳³ג€÷׳³ֲ ׳’ג‚¬ג€ ׳³ֲ ׳³ג„¢׳³ֲ¡׳³ג„¢׳³ג€¢׳³ֲ ׳³ג€¢׳³ֳ— ׳³ג€”׳³ג€¢׳³ג€“׳³ֲ¨׳³ג„¢׳³ֲ | HYPER CORE TECH
      for (const delay of [300, 800, 1600]) {
        await new Promise((r) => setTimeout(r, delay));
        const again = await getFirstWindowClient();
        if (again && await send(again)) return;
      }
    }

    await postMessageToAllClients(message);
  }

  // ׳³ג€”׳³ֲ׳³ֲ§ Notification Click (service-worker.js) ׳’ג‚¬ג€ ׳³ֲ׳³ג€”׳³ג„¢׳³ֲ¦׳³ג€ ׳³ֲ¢׳³ֲ ׳³ג€׳³ֳ—׳³ֲ¨׳³ֲ׳³ֳ— ׳³ג€׳³ג‚×׳³ג€׳³ג‚×׳³ֲ ׳’ג€ ג€™ ׳³ֲ©׳³ג„¢׳³ג€”׳³ג€ / ׳³ֲ׳³ֲ¡׳³ֲ ׳³ֲ¢׳³ֲ ׳³ג€ | HYPER CORE TECH
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

      // URL ׳³ֲ¢׳³ֲ deep link ׳³ֲ׳³ֲ¡׳³ג€¢׳³ג€׳³ֲ¨ ׳’ג‚¬ג€ ׳³ג€™׳³ֲ ׳³ֲ׳³ֲ ׳³ג€׳³ֲ׳³ֲ§׳³ג€¢׳³ג€” ׳³ֲ ׳³ג‚×׳³ֳ—׳³ג€” ׳³ֲ׳³ג€”׳³ג€׳³ֲ© | HYPER CORE TECH
      url = buildDeepLinkUrl(url, peerPubkey, incomingCall);

      const message = {
        type: messageType,
        action: 'open',
        peerPubkey,
        incomingCall: incomingCall || '',
        notificationType: type,
        url,
        // ׳³ֳ—׳³ג€¢׳³ֲ׳³ֲ ׳³ֲ׳²ֲ¾chat-deeplink.js | HYPER CORE TECH
        chat: peerPubkey || '',
      };

      // ׳³ג€׳³ג€¢׳³ג€׳³ֲ¢׳³ֳ— deeplink ׳³ֲ׳³ג€”׳³ג„¢׳³ג€׳³ג€ ׳³ג€˜׳³ֲ ׳³ג€¢׳³ֲ¡׳³ֲ£ ׳³ֲ׳³ֲ¡׳³ג€¢׳³ג€™ ׳³ג€׳³ֲ¡׳³ג‚×׳³ֲ¦׳³ג„¢׳³ג‚×׳³ג„¢ | HYPER CORE TECH
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
