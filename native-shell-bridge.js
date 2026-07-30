// חלק מעטפת Native (native-shell-bridge.js) – חיבור WebView Android להתראות רקע + FCM | HYPER CORE TECH
(function initNativeShellBridge(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const FCM_API_DEFAULT = localStorage.getItem('fcm_push_url') || 'https://sos-fcm-push.vercel.app';

  function getBridge() {
    try {
      return window.SosNativeShell || null;
    } catch (_) {
      return null;
    }
  }

  function isNativeShell() {
    const bridge = getBridge();
    if (!bridge) return !!(window.SOS_NATIVE_SHELL);
    try {
      return bridge.isNativeShell() === true || bridge.isNativeShell() === 'true';
    } catch (_) {
      return !!window.SOS_NATIVE_SHELL;
    }
  }

  function nativeShowNotification(title, body, openUrl, tag) {
    const bridge = getBridge();
    if (!bridge || typeof bridge.showNotification !== 'function') return false;
    try {
      bridge.showNotification(
        String(title || 'SOS'),
        String(body || 'יש לך עדכון חדש'),
        openUrl ? String(openUrl) : 'https://sos010.com/videos.html',
        tag ? String(tag) : 'sos'
      );
      return true;
    } catch (err) {
      console.warn('[NATIVE-SHELL] showNotification failed', err);
      return false;
    }
  }

  function getFcmToken() {
    const bridge = getBridge();
    if (!bridge || typeof bridge.getFcmToken !== 'function') return '';
    try {
      return bridge.getFcmToken() || '';
    } catch (_) {
      return '';
    }
  }

  async function registerFcmToken(pubkey) {
    if (!isNativeShell()) return { ok: false, reason: 'not_native' };
    const bridge = getBridge();
    try {
      if (bridge && typeof bridge.refreshFcmToken === 'function') bridge.refreshFcmToken();
      if (bridge && typeof bridge.keepAlive === 'function') bridge.keepAlive();
    } catch (_) {}

    const token = getFcmToken();
    if (!token) return { ok: false, reason: 'no_token_yet' };

    const key = pubkey || App.publicKey || localStorage.getItem('sos_pubkey') || localStorage.getItem('nostr_pubkey');
    if (!key) return { ok: false, reason: 'no_pubkey' };

    try {
      localStorage.setItem('sos_fcm_token', token);
      const res = await fetch(`${FCM_API_DEFAULT.replace(/\/$/, '')}/api/fcm/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'register', pubkey: key, token }),
      });
      const data = await res.json().catch(() => ({}));
      console.log('[NATIVE-SHELL] FCM register:', data);
      return { ok: !!data.ok, data };
    } catch (err) {
      console.warn('[NATIVE-SHELL] FCM register failed', err);
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  async function sendFcmToPubkey(pubkey, payload) {
    if (!pubkey) return;
    try {
      await fetch(`${FCM_API_DEFAULT.replace(/\/$/, '')}/api/fcm/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey,
          title: payload.title || 'SOS',
          body: payload.body || 'יש לך עדכון חדש',
          url: payload.url || 'https://sos010.com/videos.html',
          tag: payload.tag || payload.type || 'sos',
          data: payload.data || {},
        }),
      });
    } catch (err) {
      console.warn('[NATIVE-SHELL] FCM send failed', err);
    }
  }

  function patchLocalNotifications() {
    const original = App.showLocalNotification;
    if (typeof original !== 'function' || original.__sosNativePatched) return;

    App.showLocalNotification = async function patchedShowLocalNotification(title, options = {}) {
      const url = (options && options.data && options.data.url) || options.url || 'https://sos010.com/videos.html';
      const tag = options.tag || options.type || 'sos';
      if (isNativeShell()) {
        nativeShowNotification(title, options.body || '', url, tag);
      }
      try {
        return await original.call(App, title, options);
      } catch (err) {
        if (isNativeShell()) return true;
        throw err;
      }
    };
    App.showLocalNotification.__sosNativePatched = true;
  }

  function syncPubkeyToNative() {
    if (!isNativeShell()) return;
    const bridge = getBridge();
    const pubkey = (App.publicKey || localStorage.getItem('sos_pubkey') || localStorage.getItem('nostr_pubkey') || '').trim();
    if (!pubkey || pubkey.length !== 64) return;
    try {
      if (bridge && typeof bridge.setUserPubkey === 'function') {
        bridge.setUserPubkey(pubkey);
        console.log('[NATIVE-SHELL] pubkey synced to background watcher');
      }
      if (bridge && typeof bridge.keepAlive === 'function') bridge.keepAlive();
    } catch (err) {
      console.warn('[NATIVE-SHELL] setUserPubkey failed', err);
    }
  }

  function boot() {
    if (!isNativeShell()) {
      console.log('[NATIVE-SHELL] browser mode');
      return;
    }
    console.log('[NATIVE-SHELL] active');
    patchLocalNotifications();
    syncPubkeyToNative();
    try {
      const bridge = getBridge();
      if (bridge && typeof bridge.keepAlive === 'function') bridge.keepAlive();
    } catch (_) {}

    // רישום FCM כשיש מפתח משתמש
    const tryRegister = () => {
      syncPubkeyToNative();
      const pubkey = App.publicKey || localStorage.getItem('sos_pubkey') || localStorage.getItem('nostr_pubkey');
      if (pubkey) registerFcmToken(pubkey);
    };
    tryRegister();
    setTimeout(tryRegister, 1500);
    setTimeout(tryRegister, 4000);
    setTimeout(tryRegister, 10000);
    // כל 20 שניות – אם התחברו אחרי שהאפליקציה כבר רצה
    setInterval(syncPubkeyToNative, 20000);

    window.addEventListener('sos-fcm-token', () => tryRegister());
    window.addEventListener('sos-native-ready', () => {
      patchLocalNotifications();
      tryRegister();
    });
    window.addEventListener('sos-native-resume', () => tryRegister());
    window.addEventListener('storage', () => syncPubkeyToNative());
  }

  Object.assign(App, {
    isNativeShell,
    registerFcmToken,
    sendFcmToPubkey,
    nativeShowNotification,
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  // push-client נטען defer – ננסה שוב אחרי טעינה מלאה
  window.addEventListener('load', () => setTimeout(boot, 500));
})(window);
