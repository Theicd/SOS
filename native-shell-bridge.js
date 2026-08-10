// חלק מעטפת Native (native-shell-bridge.js) – חיבור WebView Android להתראות רקע + FCM + שיחות | HYPER CORE TECH
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

  function nativeShowNotification(title, body, openUrl, tag, eventId, peerKey) {
    const bridge = getBridge();
    if (!bridge) return false;
    try {
      if (typeof bridge.showChatNotification === 'function') {
        bridge.showChatNotification(
          String(title || 'SOS'),
          String(body || 'יש לך עדכון חדש'),
          openUrl ? String(openUrl) : 'https://sos010.com/videos.html',
          tag ? String(tag) : 'sos',
          eventId ? String(eventId) : '',
          peerKey ? String(peerKey) : ''
        );
        return true;
      }
      if (typeof bridge.showNotification !== 'function') return false;
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

  function nativeCacheIncomingCallOffer(peer, callType, offer) {
    if (!isNativeShell()) return false;
    try {
      const bridge = getBridge();
      if (!bridge || typeof bridge.cacheIncomingCallOffer !== 'function') return false;
      const offerJson = typeof offer === 'string' ? offer : JSON.stringify(offer || {});
      bridge.cacheIncomingCallOffer(String(peer || ''), String(callType || 'voice'), offerJson);
      return true;
    } catch (_) {
      return false;
    }
  }

  function nativeGetIncomingCallOffer() {
    if (!isNativeShell()) return null;
    try {
      const bridge = getBridge();
      if (!bridge || typeof bridge.getIncomingCallOffer !== 'function') return null;
      const raw = bridge.getIncomingCallOffer();
      if (!raw) return null;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {
      return null;
    }
  }

  function nativeGetIncomingCallRawEvent() {
    if (!isNativeShell()) return null;
    try {
      const bridge = getBridge();
      if (!bridge || typeof bridge.getIncomingCallRawEvent !== 'function') return null;
      const raw = bridge.getIncomingCallRawEvent();
      if (!raw) return null;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {
      return null;
    }
  }

  function nativeClearIncomingCallOffer() {
    try {
      const bridge = getBridge();
      if (bridge && typeof bridge.clearIncomingCallOffer === 'function') bridge.clearIncomingCallOffer();
    } catch (_) {}
  }

  function nativeStartCallRingtone() {
    if (!isNativeShell()) return false;
    try {
      const bridge = getBridge();
      if (bridge && typeof bridge.startCallRingtone === 'function') {
        bridge.startCallRingtone();
        return true;
      }
    } catch (_) {}
    return false;
  }

  function nativeStopCallRingtone() {
    try {
      const bridge = getBridge();
      if (bridge && typeof bridge.stopCallRingtone === 'function') bridge.stopCallRingtone();
      if (bridge && typeof bridge.stopCallSounds === 'function') bridge.stopCallSounds();
    } catch (_) {}
  }

  function nativeStartCallDialtone() {
    if (!isNativeShell()) return false;
    try {
      const bridge = getBridge();
      if (bridge && typeof bridge.startCallDialtone === 'function') {
        bridge.startCallDialtone();
        return true;
      }
    } catch (_) {}
    return false;
  }

  function nativeStopCallDialtone() {
    try {
      const bridge = getBridge();
      if (bridge && typeof bridge.stopCallDialtone === 'function') bridge.stopCallDialtone();
    } catch (_) {}
  }

  function nativeRequestMediaPermissions(needCamera) {
    if (!isNativeShell()) return false;
    try {
      const bridge = getBridge();
      if (bridge && typeof bridge.requestMediaPermissions === 'function') {
        bridge.requestMediaPermissions(!!needCamera);
        return true;
      }
    } catch (_) {}
    return false;
  }

  function nativeHasMicPermission() {
    try {
      const bridge = getBridge();
      if (bridge && typeof bridge.hasMicPermission === 'function') {
        return bridge.hasMicPermission() === true || bridge.hasMicPermission() === 'true';
      }
    } catch (_) {}
    return false;
  }

  function nativeHasCameraPermission() {
    try {
      const bridge = getBridge();
      if (bridge && typeof bridge.hasCameraPermission === 'function') {
        return bridge.hasCameraPermission() === true || bridge.hasCameraPermission() === 'true';
      }
    } catch (_) {}
    return false;
  }

  async function ensureNativeMediaPermissions(needCamera) {
    if (!isNativeShell()) return true;
    const needCam = !!needCamera;
    if (nativeHasMicPermission() && (!needCam || nativeHasCameraPermission())) return true;
    nativeRequestMediaPermissions(needCam);
    // ממתין לדיאלוג אישור של אנדרואיד
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener('sos-native-permissions', onPerm);
        resolve();
      };
      const onPerm = () => finish();
      window.addEventListener('sos-native-permissions', onPerm);
      setTimeout(finish, 12000);
    });
    if (!nativeHasMicPermission()) return false;
    if (needCam && !nativeHasCameraPermission()) return false;
    return true;
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
      const eventId = (options && options.data && (options.data.eventId || options.data.id)) || options.eventId || '';
      const peerKey = (options && options.data && (options.data.peerPubkey || options.data.pubkey)) || options.peerKey || '';
      // באפליקציית APK – רק התראת Native מקובצת, בלי כפילות Web | HYPER CORE TECH
      if (isNativeShell() && nativeShowNotification(title, options.body || '', url, tag, eventId, peerKey)) {
        return true;
      }
      try {
        return await original.call(App, title, options);
      } catch (err) {
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
      if (bridge && typeof bridge.setP2pStandbyEnabled === 'function') {
        bridge.setP2pStandbyEnabled(true);
      }
      if (bridge && typeof bridge.keepAlive === 'function') bridge.keepAlive();
    } catch (err) {
      console.warn('[NATIVE-SHELL] setUserPubkey failed', err);
    }
    syncContactsToNative();
    syncP2pPeersToNative();
  }

  // חלק קאש אנשי קשר (native-shell-bridge.js) – שם+תמונה להתראות רקע | HYPER CORE TECH
  function syncContactsToNative() {
    if (!isNativeShell()) return;
    const bridge = getBridge();
    if (!bridge || typeof bridge.cacheContact !== 'function') return;
    try {
      const contacts = typeof App.getChatContacts === 'function' ? App.getChatContacts() : [];
      (contacts || []).slice(0, 100).forEach((c) => {
        const pk = String(c?.pubkey || '').toLowerCase();
        if (pk.length !== 64) return;
        const name = String(c?.name || '').trim();
        const picture = String(c?.picture || '').trim();
        if (!name && !picture) return;
        if (name.startsWith('משתמש ') && !picture) return;
        bridge.cacheContact(pk, name, picture);
      });
      if (App.profileCache instanceof Map) {
        let n = 0;
        App.profileCache.forEach((profile, key) => {
          if (n >= 120) return;
          const pk = String(profile?.pubkey || key || '').toLowerCase();
          if (pk.length !== 64) return;
          const name = String(profile?.name || profile?.display_name || '').trim();
          const picture = String(profile?.picture || '').trim();
          if (!name && !picture) return;
          if (name.startsWith('משתמש ') && !picture) return;
          bridge.cacheContact(pk, name, picture);
          n += 1;
        });
      }
    } catch (err) {
      console.warn('[NATIVE-SHELL] cacheContact sync failed', err);
    }
    syncP2pPeersToNative();
  }

  /** סנכרון peers לחימום P2P ברקע ב-APK | HYPER CORE TECH */
  function syncP2pPeersToNative() {
    if (!isNativeShell()) return;
    const bridge = getBridge();
    if (!bridge || typeof bridge.syncP2pPeers !== 'function') return;
    try {
      const connected = [];
      const rest = [];
      const seen = new Set();
      try {
        const dcPeers = App.dataChannel && App.dataChannel._peers;
        if (dcPeers && typeof dcPeers.forEach === 'function') {
          dcPeers.forEach((st, pk) => {
            const k = String(pk || '').toLowerCase();
            if (k.length !== 64 || seen.has(k)) return;
            seen.add(k);
            if (st && (st.status === 'connected' || (st.dc && st.dc.readyState === 'open'))) connected.push(k);
            else rest.push(k);
          });
        }
      } catch (_) {}
      const contacts = typeof App.getChatContacts === 'function' ? App.getChatContacts() : [];
      (contacts || []).forEach((c) => {
        const pk = String(c?.pubkey || '').toLowerCase();
        if (pk.length === 64 && !seen.has(pk)) {
          seen.add(pk);
          rest.push(pk);
        }
      });
      const csv = connected.concat(rest).slice(0, 24).join(',');
      bridge.syncP2pPeers(csv);
    } catch (err) {
      console.warn('[NATIVE-SHELL] syncP2pPeers failed', err);
    }
  }

  // חלק בחירת קובץ (native-shell-bridge.js) – DocumentsUI דרך SosNativeShell, לא דרך input HTML | HYPER CORE TECH
  let nativePickInFlight = false;

  function nativePickFiles(accept) {
    return new Promise((resolve) => {
      if (!isNativeShell()) {
        resolve(null);
        return;
      }
      if (nativePickInFlight) {
        resolve(null);
        return;
      }
      const bridge = getBridge();
      if (!bridge || typeof bridge.openFilePicker !== 'function') {
        resolve(null);
        return;
      }
      nativePickInFlight = true;
      const requestId = `fp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      let settled = false;
      const finish = (files) => {
        if (settled) return;
        settled = true;
        nativePickInFlight = false;
        window.removeEventListener('sos-native-file-pick', onResult);
        resolve(files);
      };
      const onResult = async (event) => {
        const detail = event && event.detail;
        if (!detail || detail.requestId !== requestId) return;
        const metas = Array.isArray(detail.files) ? detail.files : [];
        if (!metas.length) {
          finish([]);
          return;
        }
        const files = [];
        for (let i = 0; i < metas.length; i += 1) {
          const meta = metas[i] || {};
          const url = meta.url || (meta.id ? `https://sos-native.app/file/${meta.id}` : '');
          if (!url) continue;
          try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`native file fetch ${res.status}`);
            const blob = await res.blob();
            files.push(new File(
              [blob],
              meta.name || `file-${i + 1}`,
              { type: meta.type || blob.type || 'application/octet-stream' }
            ));
          } catch (err) {
            console.warn('[NATIVE-SHELL] failed to load picked file', err);
          }
        }
        finish(files);
      };
      window.addEventListener('sos-native-file-pick', onResult);
      try {
        bridge.openFilePicker(requestId, String(accept || '*/*'));
      } catch (err) {
        console.warn('[NATIVE-SHELL] openFilePicker failed', err);
        finish(null);
        return;
      }
      setTimeout(() => finish(null), 180000);
    });
  }

  async function handleNativeChatAttach(event) {
    if (!isNativeShell()) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    const accept = document.getElementById('chatComposerFileInput')?.getAttribute('accept') || '*/*';
    const files = await nativePickFiles(accept);
    if (!files || !files.length) return;
    if (typeof App.handleChatFileSelection === 'function') {
      App.handleChatFileSelection(files[0]);
    }
  }

  function base64ToFile(b64, name, type) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], name || 'file', { type: type || 'application/octet-stream' });
  }

  async function metaToNativeFile(meta) {
    if (!meta) throw new Error('empty-meta');
    if (meta.base64) {
      return base64ToFile(meta.base64, meta.name, meta.type);
    }
    const url = meta.url || (meta.id ? `https://sos-native.app/file/${meta.id}` : '');
    if (!url) throw new Error('missing-url');
    const res = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error(`native file fetch ${res.status}`);
    const blob = await res.blob();
    return new File([blob], meta.name || 'file', {
      type: meta.type || blob.type || 'application/octet-stream'
    });
  }

  // GIF מהמקלדת מטופל רק ב-sos-native-file-pick.js (מוזרק ב-APK) – בלי מאזין כפול כאן | HYPER CORE TECH

  async function handleNativeComposeUpload(event) {
    if (!isNativeShell()) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    const accept = document.getElementById('composeMediaInput')?.getAttribute('accept') || 'image/*,video/*';
    const files = await nativePickFiles(accept);
    if (!files || !files.length) return;
    if (typeof App.handleComposeMediaFile === 'function') {
      App.handleComposeMediaFile(files[0]);
    } else if (typeof window.handleComposeMediaFile === 'function') {
      window.handleComposeMediaFile(files[0]);
    } else if (typeof window.handleMediaInput === 'function') {
      window.handleMediaInput({ target: { files, value: '' } });
    }
  }

  function wireNativeFilePickers() {
    if (!isNativeShell()) return;
    if (document.documentElement.dataset.sosNativeFilePickWired === '1') return;
    document.documentElement.dataset.sosNativeFilePickWired = '1';

    const bind = (el, handler) => {
      if (!el || el.dataset.sosNativePickBound === '1') return;
      el.dataset.sosNativePickBound = '1';
      el.addEventListener('click', handler, true);
    };

    const watch = () => {
      bind(document.getElementById('chatComposerFileButton'), handleNativeChatAttach);
      bind(document.getElementById('chatComposerFileInput'), handleNativeChatAttach);
      bind(document.getElementById('composeUploadChoice'), handleNativeComposeUpload);
      bind(document.getElementById('composeMediaInput'), handleNativeComposeUpload);
    };
    watch();
    setTimeout(watch, 800);
    setTimeout(watch, 2500);
    console.log('[NATIVE-SHELL] file picker bridge wired');
  }

  function boot() {
    if (!isNativeShell()) {
      console.log('[NATIVE-SHELL] browser mode');
      return;
    }
    console.log('[NATIVE-SHELL] active');
    patchLocalNotifications();
    syncPubkeyToNative();
    wireNativeFilePickers();
    try {
      const bridge = getBridge();
      if (bridge && typeof bridge.keepAlive === 'function') bridge.keepAlive();
    } catch (_) {}

    const tryRegister = () => {
      syncPubkeyToNative();
      const pubkey = App.publicKey || localStorage.getItem('sos_pubkey') || localStorage.getItem('nostr_pubkey');
      if (pubkey) registerFcmToken(pubkey);
    };
    tryRegister();
    setTimeout(tryRegister, 1500);
    setTimeout(tryRegister, 4000);
    setTimeout(tryRegister, 10000);
    setInterval(syncPubkeyToNative, 20000);

    window.addEventListener('sos-fcm-token', () => tryRegister());
    window.addEventListener('sos-native-ready', () => {
      patchLocalNotifications();
      wireNativeFilePickers();
      tryRegister();
    });
    window.addEventListener('sos-native-resume', () => {
      tryRegister();
      wireNativeFilePickers();
      syncContactsToNative();
      syncP2pPeersToNative();
      // לא עוצרים צלצול שיחה נכנסת ב־resume – רק אחרי ענה/דחייה | HYPER CORE TECH
      try {
        const params = new URLSearchParams(window.location.search || '');
        const incoming = params.get('incomingCall') || window.__sosIncomingCallActive;
        if (incoming) return;
        const bridge = getBridge();
        if (bridge && typeof bridge.stopCallSounds === 'function') bridge.stopCallSounds();
      } catch (_) {}
    });
    window.addEventListener('storage', () => syncPubkeyToNative());

    // סנכרון שמות/תמונות כשמתעדכנת רשימת השיחות | HYPER CORE TECH
    try {
      if (typeof App.subscribeChat === 'function') {
        App.subscribeChat('contacts', () => syncContactsToNative());
      }
    } catch (_) {}
    setTimeout(syncContactsToNative, 2500);
    setTimeout(syncContactsToNative, 8000);
    setTimeout(syncP2pPeersToNative, 3000);
    setTimeout(syncP2pPeersToNative, 12000);
  }

  Object.assign(App, {
    isNativeShell,
    registerFcmToken,
    sendFcmToPubkey,
    nativeShowNotification,
    nativeStartCallRingtone,
    nativeStopCallRingtone,
    nativeStartCallDialtone,
    nativeStopCallDialtone,
    nativeCacheIncomingCallOffer,
    nativeGetIncomingCallOffer,
    nativeGetIncomingCallRawEvent,
    nativeClearIncomingCallOffer,
    nativeRequestMediaPermissions,
    ensureNativeMediaPermissions,
    nativeHasMicPermission,
    nativeHasCameraPermission,
    nativePickFiles,
    syncContactsToNative,
    syncP2pPeersToNative,
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  window.addEventListener('load', () => setTimeout(boot, 500));
})(window);
