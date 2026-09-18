/**
 * Minimal secure call verifier runtime (APK-bundled).
 * NO feed / home / chat UI / media cache.
 */
(function initSecureCallVerifier(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  App.__sosSecureVerifierOnly = true;

  const DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.snort.social',
  ];

  let booted = false;
  let lastOfferPeer = '';
  let lastOfferMedia = 'voice';
  let lastOfferSessionId = '';
  let declineSent = false;

  function log(msg) {
    try { console.log(String(msg)); } catch (_e) {}
  }

  function loadSessionFromNative() {
    try {
      const bridge = window.SosNativeShell;
      if (!bridge || typeof bridge.getVerifierSessionJson !== 'function') return false;
      const raw = bridge.getVerifierSessionJson();
      const obj = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
      const pub = String(obj.pubkey || '').trim().toLowerCase();
      const priv = String(obj.privkey || '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(pub) || !/^[0-9a-f]{64}$/.test(priv)) return false;
      App.publicKey = pub;
      App.privateKey = priv;
      return true;
    } catch (_e) {
      return false;
    }
  }

  function ensurePool() {
    if (App.pool && typeof App.pool.publish === 'function') return true;
    const NT = window.NostrTools;
    if (!NT || typeof NT.SimplePool !== 'function') return false;
    try {
      App.pool = new NT.SimplePool();
      App.relayUrls = DEFAULT_RELAYS.slice();
      return true;
    } catch (_e) {
      return false;
    }
  }

  function parseQueue(raw) {
    const out = [];
    if (!raw) return out;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        for (let i = 0; i < parsed.length; i += 1) out.push(parsed[i]);
        return out;
      }
      if (parsed && parsed.event) {
        out.push(parsed);
        return out;
      }
      if (parsed && parsed.kind === 1059) {
        out.push(parsed);
        return out;
      }
    } catch (_e) {}
    return out;
  }

  async function processPendingWraps() {
    const api = App.CallSignalE2ee;
    if (!api || typeof api.drainPendingSecureWrapsFromNative !== 'function') {
      log('SECURE_VERIFIER_NO_VALID_OFFER');
      return false;
    }
    if (!App.privateKey || !App.publicKey) {
      log('SECURE_VERIFIER_NO_VALID_OFFER');
      return false;
    }

    let items = [];
    try {
      const bridge = window.SosNativeShell;
      log('SECURE_VERIFIER_WRAP_PEEK');
      if (bridge && typeof bridge.peekPendingSecureWraps === 'function') {
        items = parseQueue(bridge.peekPendingSecureWraps());
      }
    } catch (_e) {}

    if (!items.length) {
      log('SECURE_VERIFIER_NO_VALID_OFFER');
      return false;
    }

    const results = await api.drainPendingSecureWrapsFromNative(items);
    let anyOffer = false;
    for (let i = 0; i < (results || []).length; i += 1) {
      const r = results[i];
      if (!r) continue;
      if (r.status === 'dispatched' && r.action === 'offer') anyOffer = true;
      if (r.status === 'pending_candidate') {
        log('SECURE_VERIFIER_CANDIDATE_PENDING');
      }
      if (r.action === 'disconnect') {
        log('SECURE_VERIFIER_DISCONNECT');
      }
    }

    // Capture last authenticated offer metadata from cache for decline.
    try {
      const stats = api.getDispatchStats && api.getDispatchStats();
      if (stats && stats.nativeRingAuth > 0) {
        anyOffer = true;
        log('SECURE_VERIFIER_RING_AUTH');
      }
    } catch (_e) {}

    try {
      const bridge = window.SosNativeShell;
      // Prefer Native-bound peer after notifySecureCallOfferVerified.
      if (bridge && typeof bridge.getIncomingCallRawEvent === 'function') {
        const metaRaw = bridge.getIncomingCallRawEvent();
        if (metaRaw) {
          const meta = JSON.parse(metaRaw);
          if (meta && meta.peer) lastOfferPeer = String(meta.peer).toLowerCase();
          if (meta && meta.callType) lastOfferMedia = meta.callType === 'video' ? 'video' : 'voice';
        }
      }
    } catch (_e) {}

    if (!anyOffer) {
      log('SECURE_VERIFIER_NO_VALID_OFFER');
    }
    return anyOffer;
  }

  async function sendDeclineDisconnect(peer, media) {
    if (declineSent) return;
    const pk = String(peer || lastOfferPeer || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pk)) return;
    if (!ensurePool() || !App.privateKey || !App.publicKey) return;
    const api = App.CallSignalE2ee;
    if (!api || typeof api.publishCallSignal !== 'function') return;
    declineSent = true;
    try {
      await api.publishCallSignal({
        media: media === 'video' ? 'video' : 'voice',
        peerPubkey: pk,
        type: media === 'video' ? 'v-disconnect' : 'disconnect',
        data: null,
        sessionId: lastOfferSessionId || (api.createSessionId && api.createSessionId()),
        pool: App.pool,
        relays: App.relayUrls,
        senderPubkey: App.publicKey,
        senderPrivateKey: App.privateKey,
      });
      log('CALL_DISCONNECT_ONCE');
    } catch (_e) {
      declineSent = false;
    }
  }

  window.sosSecureVerifierBoot = async function sosSecureVerifierBoot() {
    if (booted) return;
    booted = true;
    App.__sosSecureVerifierOnly = true;
    log('SECURE_VERIFIER_READY');
    if (!loadSessionFromNative()) {
      log('SECURE_VERIFIER_NO_VALID_OFFER');
      try {
        const bridge = window.SosNativeShell;
        if (bridge && typeof bridge.requestVerifyOnlyIdleShutdown === 'function') {
          bridge.requestVerifyOnlyIdleShutdown();
        }
      } catch (_e) {}
      return;
    }
    ensurePool();
    try {
      await processPendingWraps();
    } catch (_e) {
      log('SECURE_VERIFIER_NO_VALID_OFFER');
    }
    // Re-peek shortly for wraps that arrived during boot.
    setTimeout(function () {
      processPendingWraps().catch(function () {});
    }, 800);
  };

  window.sosSecureVerifierDecline = async function sosSecureVerifierDecline(peer, media) {
    App.__sosSecureVerifierOnly = true;
    await sendDeclineDisconnect(peer, media);
    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.markIncomingCallDeclined === 'function') {
        bridge.markIncomingCallDeclined(peer || lastOfferPeer);
      }
    } catch (_e) {}
  };

  window.sosSecureVerifierShutdown = function sosSecureVerifierShutdown() {
    log('SECURE_VERIFIER_SHUTDOWN');
    try {
      if (App.pool && typeof App.pool.close === 'function') App.pool.close(App.relayUrls || []);
    } catch (_e) {}
  };
})(window);
