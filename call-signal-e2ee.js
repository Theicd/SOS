// call-signal-e2ee.js – NIP-59 Gift Wrap (kind 1059) + NIP-44 for private call signaling | HYPER CORE TECH
// Browser runtime may lack NostrTools.nip59 (CDN 2.7.x); implement with nip44 + finalizeEvent only.
(function initCallSignalE2ee(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const CALL_SIGNAL_FAMILY = 'sos-call-signal';
  const CALL_SIGNAL_VERSION = 1;
  const SEAL_KIND = 13;
  const GIFT_WRAP_KIND = 1059;
  const RUMOR_KIND = 25050;
  const TWO_DAYS_SEC = 2 * 24 * 60 * 60;
  const MAX_SIGNAL_SDP_CHARS = 64 * 1024;
  const MAX_SEEN_SIGNAL_IDS = 400;
  const MAX_SEEN_WRAP_IDS = 400;

  const FRESHNESS_SEC = {
    offer: 60,
    answer: 60,
    candidate: 120,
    candidates: 120,
    disconnect: 120,
  };

  const seenSignalIds = new Map(); // signalId -> tsMs
  const seenWrapIds = new Map(); // outer wrap event id -> tsMs
  const secureOfferCache = new Map(); // peer -> { offer, media, sessionId, wrapId, at }
  const dispatchStats = {
    unwrapCount: 0,
    voiceDispatch: 0,
    videoDispatch: 0,
    replayReject: 0,
    duplicateWrap: 0,
    invalidOffer: 0,
    nativeRingAuth: 0,
  };

  let secureSub = null;
  let secureDispatchChain = Promise.resolve();
  const nativeRingAuthOnce = new Set(); // signalId authorized for Native ring

  function callSignalFail(code, detail) {    const err = new Error(detail ? String(code) + ': ' + String(detail) : String(code));
    err.code = code || 'CALL_SIGNAL_E2EE_ENCRYPT_FAILED';
    err.name = 'CallSignalE2eeError';
    throw err;
  }

  function getNip44() {
    const NT = window.NostrTools;
    const nip44 = NT && NT.nip44;
    if (!nip44 || !nip44.v2 || typeof nip44.v2.encrypt !== 'function' || typeof nip44.v2.decrypt !== 'function') {
      callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'NIP44 unavailable');
    }
    const getConversationKey =
      (nip44.v2.utils && nip44.v2.utils.getConversationKey) || nip44.getConversationKey;
    if (typeof getConversationKey !== 'function') {
      callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'getConversationKey missing');
    }
    return {
      encrypt: nip44.v2.encrypt.bind(nip44.v2),
      decrypt: nip44.v2.decrypt.bind(nip44.v2),
      getConversationKey,
    };
  }

  function hexToBytes(hex) {
    const clean = String(hex || '').trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(clean)) {
      callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'bad hex key');
    }
    const NT = window.NostrTools;
    if (NT && NT.utils && typeof NT.utils.hexToBytes === 'function') {
      return NT.utils.hexToBytes(clean);
    }
    if (typeof App.hexToBytes === 'function') return App.hexToBytes(clean);
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function requireHexPubkey(pk, code) {
    if (typeof pk !== 'string' || !/^[0-9a-fA-F]{64}$/.test(pk.trim())) {
      callSignalFail(code || 'CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'bad pubkey');
    }
    return pk.trim().toLowerCase();
  }

  function requirePrivBytes(hexOrBytes) {
    if (hexOrBytes instanceof Uint8Array && hexOrBytes.length === 32) return hexOrBytes;
    if (typeof hexOrBytes !== 'string' || !hexOrBytes.trim()) {
      callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'empty private key');
    }
    const bytes = hexToBytes(hexOrBytes);
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
      callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'bad private key length');
    }
    return bytes;
  }

  function getFinalizeEvent() {
    if (typeof App.finalizeEvent === 'function') return App.finalizeEvent.bind(App);
    if (window.NostrTools && typeof window.NostrTools.finalizeEvent === 'function') {
      return window.NostrTools.finalizeEvent;
    }
    callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'finalizeEvent unavailable');
  }

  function getEventHash(evt) {
    // Clone into host realm — nostr-tools validateEvent uses realm-sensitive instanceof.
    const host = JSON.parse(JSON.stringify(evt));
    if (window.NostrTools && typeof window.NostrTools.getEventHash === 'function') {
      return window.NostrTools.getEventHash(host);
    }
    callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'getEventHash unavailable');
  }

  function verifyEventSig(event) {
    try {
      if (window.NostrTools && typeof window.NostrTools.verifyEvent === 'function') {
        const host = JSON.parse(JSON.stringify(event));
        return !!window.NostrTools.verifyEvent(host);
      }
    } catch (_e) {}
    return false;
  }

  function getPublicKeyFromSk(skBytes) {
    if (window.NostrTools && typeof window.NostrTools.getPublicKey === 'function') {
      return window.NostrTools.getPublicKey(skBytes);
    }
    callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'getPublicKey unavailable');
  }

  function generateEphemeralSecretKey() {
    const NT = window.NostrTools;
    if (NT && typeof NT.generateSecretKey === 'function') {
      const sk = NT.generateSecretKey();
      if (!(sk instanceof Uint8Array) || sk.length !== 32) {
        callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'bad generated secret');
      }
      return sk;
    }
    // CSPRNG fallback — secp256k1 secret must be 32 random bytes
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const sk = new Uint8Array(32);
      crypto.getRandomValues(sk);
      return sk;
    }
    callSignalFail('BLOCKED_CRYPTO_API', 'secure key generation unavailable');
  }

  /** CSPRNG timestamp in the past (NIP-59 style), not Math.random */
  function randomizedPastCreatedAt() {
    const nowSec = Math.floor(Date.now() / 1000);
    const buf = new Uint8Array(4);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(buf);
    } else {
      callSignalFail('BLOCKED_CRYPTO_API', 'CSPRNG unavailable for timestamp');
    }
    const rnd = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
    const offset = rnd % TWO_DAYS_SEC;
    return Math.max(0, nowSec - offset);
  }

  function randomHexId(bytesLen) {
    const n = Math.max(16, bytesLen | 0); // >= 128 bits
    const buf = new Uint8Array(n);
    if (!(typeof crypto !== 'undefined' && crypto.getRandomValues)) {
      callSignalFail('BLOCKED_CRYPTO_API', 'CSPRNG unavailable for id');
    }
    crypto.getRandomValues(buf);
    let hex = '';
    for (let i = 0; i < buf.length; i += 1) hex += buf[i].toString(16).padStart(2, '0');
    return hex;
  }

  function createSessionId() {
    return randomHexId(16);
  }

  function createSignalId() {
    return randomHexId(16);
  }

  function nip44EncryptJson(obj, senderSkBytes, recipientPubkey) {
    const nip44 = getNip44();
    const recipient = requireHexPubkey(recipientPubkey);
    const conversationKey = nip44.getConversationKey(senderSkBytes, recipient);
    const ct = nip44.encrypt(JSON.stringify(obj), conversationKey);
    if (typeof ct !== 'string' || !ct) {
      callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'empty ciphertext');
    }
    return ct;
  }

  function nip44DecryptJson(eventLike, recipientSkBytes) {
    const nip44 = getNip44();
    if (!eventLike || typeof eventLike.content !== 'string' || !eventLike.pubkey) {
      callSignalFail('CALL_SIGNAL_E2EE_DECRYPT_FAILED', 'bad decrypt target');
    }
    const sender = requireHexPubkey(eventLike.pubkey, 'CALL_SIGNAL_E2EE_DECRYPT_FAILED');
    const conversationKey = nip44.getConversationKey(recipientSkBytes, sender);
    let plain;
    try {
      plain = nip44.decrypt(eventLike.content, conversationKey);
    } catch (err) {
      callSignalFail('CALL_SIGNAL_E2EE_DECRYPT_FAILED', err && err.message ? err.message : 'decrypt failed');
    }
    try {
      return JSON.parse(plain);
    } catch (_e) {
      callSignalFail('CALL_SIGNAL_E2EE_DECRYPT_FAILED', 'JSON invalid');
    }
  }

  function getPTag(event) {
    const tags = event && Array.isArray(event.tags) ? event.tags : [];
    for (let i = 0; i < tags.length; i += 1) {
      const t = tags[i];
      if (Array.isArray(t) && t[0] === 'p' && typeof t[1] === 'string') return t[1].toLowerCase();
    }
    return '';
  }

  function rememberSignalId(signalId) {
    if (!signalId || typeof signalId !== 'string') return false;
    const now = Date.now();
    if (seenSignalIds.has(signalId)) return true;
    seenSignalIds.set(signalId, now);
    if (seenSignalIds.size > MAX_SEEN_SIGNAL_IDS) {
      const drop = seenSignalIds.size - MAX_SEEN_SIGNAL_IDS;
      let i = 0;
      for (const k of seenSignalIds.keys()) {
        seenSignalIds.delete(k);
        i += 1;
        if (i >= drop) break;
      }
    }
    return false;
  }

  function rememberWrapId(wrapId) {
    if (!wrapId || typeof wrapId !== 'string') return false;
    const now = Date.now();
    if (seenWrapIds.has(wrapId)) return true;
    seenWrapIds.set(wrapId, now);
    if (seenWrapIds.size > MAX_SEEN_WRAP_IDS) {
      const drop = seenWrapIds.size - MAX_SEEN_WRAP_IDS;
      let i = 0;
      for (const k of seenWrapIds.keys()) {
        seenWrapIds.delete(k);
        i += 1;
        if (i >= drop) break;
      }
    }
    return false;
  }

  function normalizeSessionDescription(raw) {
    if (!raw) return null;
    let o = raw;
    if (typeof o === 'string') {
      try { o = JSON.parse(o); } catch (_err) { return null; }
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    if (o.offer && typeof o.offer === 'object' && !o.type && !o.sdp) o = o.offer;
    if (o.answer && typeof o.answer === 'object' && !o.type && !o.sdp) o = o.answer;
    const type = o.type;
    const sdp = typeof o.sdp === 'string' ? o.sdp : '';
    if (typeof type !== 'string' || !type || !sdp) return null;
    if (sdp.length > MAX_SIGNAL_SDP_CHARS) return null;
    return { type, sdp };
  }

  function cacheSecureOffer(unwrapped, offer) {
    if (!unwrapped || !offer) return;
    const peer = String(unwrapped.sender || '').toLowerCase();
    if (!peer) return;
    secureOfferCache.set(peer, {
      offer,
      media: unwrapped.media,
      sessionId: unwrapped.sessionId,
      wrapId: unwrapped.wrapId,
      at: Date.now(),
    });
    if (secureOfferCache.size > 32) {
      const first = secureOfferCache.keys().next().value;
      secureOfferCache.delete(first);
    }
  }

  function getCachedSecureOffer(peerPubkey) {
    const peer = String(peerPubkey || '').toLowerCase();
    if (!peer) return null;
    const hit = secureOfferCache.get(peer);
    if (!hit) return null;
    if (Date.now() - (hit.at || 0) > 120000) {
      secureOfferCache.delete(peer);
      return null;
    }
    return hit;
  }

  function authorizeNativeSecureOfferRing(unwrapped, offer) {
    if (!unwrapped || unwrapped.action !== 'offer' || !offer) return false;
    if (nativeRingAuthOnce.has(unwrapped.signalId)) return false;
    nativeRingAuthOnce.add(unwrapped.signalId);
    if (nativeRingAuthOnce.size > 200) {
      const first = nativeRingAuthOnce.values().next().value;
      nativeRingAuthOnce.delete(first);
    }
    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.notifySecureCallOfferVerified === 'function') {
        bridge.notifySecureCallOfferVerified(unwrapped.sender, unwrapped.media, unwrapped.sessionId || '');
      }
      if (bridge && typeof bridge.cacheIncomingCallOffer === 'function') {
        bridge.cacheIncomingCallOffer(unwrapped.sender, unwrapped.media, JSON.stringify(offer));
      }
    } catch (_e) {}
    dispatchStats.nativeRingAuth += 1;
    return true;
  }

  function routeSecureSignal(unwrapped) {
    const logical = {
      sender: unwrapped.sender,
      recipient: unwrapped.recipient,
      media: unwrapped.media,
      action: unwrapped.action,
      wireType: unwrapped.wireType,
      sessionId: unwrapped.sessionId,
      signalId: unwrapped.signalId,
      sentAt: unwrapped.sentAt,
      data: unwrapped.data,
      wrapId: unwrapped.wrapId,
    };
    if (unwrapped.media === 'voice') {
      dispatchStats.voiceDispatch += 1;
      const vc = App.voiceCall;
      if (vc && typeof vc.handleSecureSignal === 'function') {
        return Promise.resolve(vc.handleSecureSignal(logical));
      }
      return Promise.resolve(false);
    }
    if (unwrapped.media === 'video') {
      dispatchStats.videoDispatch += 1;
      const vc = App.videoCall;
      if (vc && typeof vc.handleSecureSignal === 'function') {
        return Promise.resolve(vc.handleSecureSignal(logical));
      }
      return Promise.resolve(false);
    }
    return Promise.resolve(false);
  }

  /**
   * Authoritative single-consume secure 1059 path.
   * Unwrap once → claim replay → validate offer SDP before Native ring → route by media.
   */
  async function dispatchGiftWrappedCallSignal(wrapEvent, _opts) {
    try {
      if (!wrapEvent || wrapEvent.kind !== GIFT_WRAP_KIND) {
        return { status: 'reject', reason: 'not_wrap' };
      }
      const wrapId = typeof wrapEvent.id === 'string' ? wrapEvent.id : '';
      if (wrapId && rememberWrapId(wrapId)) {
        dispatchStats.duplicateWrap += 1;
        return { status: 'duplicate', reason: 'wrap_id' };
      }
      if (!App.privateKey || !App.publicKey) {
        if (wrapId) seenWrapIds.delete(wrapId);
        return { status: 'reject', reason: 'no_keys' };
      }
      dispatchStats.unwrapCount += 1;
      const unwrapped = await unwrapGiftWrappedCallSignal(wrapEvent, App.privateKey, App.publicKey);
      if (!unwrapped) {
        // unwrap already claimed signalId on success; failure may be replay
        dispatchStats.replayReject += 1;
        return { status: 'reject', reason: 'unwrap' };
      }

      if (unwrapped.action === 'disconnect') {
        try {
          const bridge = window.SosNativeShell;
          if (bridge && typeof bridge.notifySecureCallDismissed === 'function') {
            bridge.notifySecureCallDismissed(unwrapped.sender);
          }
        } catch (_e) {}
        await routeSecureSignal(unwrapped);
        return { status: 'dispatched', media: unwrapped.media, action: unwrapped.action };
      }

      if (unwrapped.action === 'offer') {
        const offer = normalizeSessionDescription(unwrapped.data);
        if (!offer) {
          dispatchStats.invalidOffer += 1;
          // signalId already claimed — do NOT ring
          return { status: 'invalid_offer', media: unwrapped.media };
        }
        unwrapped.data = offer;
        cacheSecureOffer(unwrapped, offer);
        authorizeNativeSecureOfferRing(unwrapped, offer);
      }

      await routeSecureSignal(unwrapped);
      return { status: 'dispatched', media: unwrapped.media, action: unwrapped.action, signalId: unwrapped.signalId };
    } catch (_err) {
      return { status: 'reject', reason: 'exception' };
    }
  }

  function enqueueSecureDispatch(wrapEvent) {
    secureDispatchChain = secureDispatchChain
      .then(() => dispatchGiftWrappedCallSignal(wrapEvent))
      .catch(() => ({ status: 'reject', reason: 'chain' }));
    return secureDispatchChain;
  }

  function ensureSecureCallSubscription(options) {
    options = options || {};
    if (App.guestMode) return null;
    if (secureSub && !options.force) return secureSub;
    if (!App.pool || !App.publicKey) return null;
    if (options.force && secureSub) {
      try {
        if (typeof secureSub.close === 'function') secureSub.close();
        else if (typeof secureSub.unsub === 'function') secureSub.unsub();
      } catch (_e) {}
      secureSub = null;
    }
    const filters = [
      {
        kinds: [GIFT_WRAP_KIND],
        '#p': [App.publicKey],
        since: Math.floor(Date.now() / 1000) - TWO_DAYS_SEC - 120,
      },
    ];
    try {
      console.log('CALL_SECURE_SUBSCRIBE kind=1059');
      secureSub = App.pool.subscribeMany(App.relayUrls, filters, {
        onevent: (ev) => {
          if (!ev || ev.kind !== GIFT_WRAP_KIND) return;
          if (!verifyEventSig(ev)) return;
          if (getPTag(ev) !== String(App.publicKey || '').toLowerCase()) return;
          enqueueSecureDispatch(ev);
        },
        oneose: () => {
          console.log('CALL_SECURE_SUBSCRIBE_READY');
        },
      });
      return secureSub;
    } catch (_err) {
      console.warn('CALL_SECURE_SUBSCRIBE_FAILED');
      return null;
    }
  }

  /** Drain Native pending queue into the same authoritative dispatcher. */
  async function drainPendingSecureWrapsFromNative(pendingList) {
    const items = Array.isArray(pendingList) ? pendingList : [];
    const results = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      let ev = null;
      try {
        if (item && item.event) {
          ev = typeof item.event === 'string' ? JSON.parse(item.event) : item.event;
        } else if (item && item.kind === GIFT_WRAP_KIND) {
          ev = item;
        }
      } catch (_e) {
        continue;
      }
      if (!ev) continue;
      results.push(await dispatchGiftWrappedCallSignal(ev));
    }
    return results;
  }

  function getDispatchStats() {
    return { ...dispatchStats };
  }

  function resetDispatchStatsForQa() {
    dispatchStats.unwrapCount = 0;
    dispatchStats.voiceDispatch = 0;
    dispatchStats.videoDispatch = 0;
    dispatchStats.replayReject = 0;
    dispatchStats.duplicateWrap = 0;
    dispatchStats.invalidOffer = 0;
    dispatchStats.nativeRingAuth = 0;
  }

  function normalizeAction(media, type) {
    const t = String(type || '');
    if (media === 'video') {
      if (t === 'v-offer' || t === 'offer') return 'offer';
      if (t === 'v-answer' || t === 'answer') return 'answer';
      if (t === 'v-candidates' || t === 'candidates') return 'candidates';
      if (t === 'v-candidate' || t === 'candidate') return 'candidate';
      if (t === 'v-disconnect' || t === 'disconnect') return 'disconnect';
    }
    return t;
  }

  function toWireType(media, action) {
    if (media === 'video') {
      if (action === 'offer') return 'v-offer';
      if (action === 'answer') return 'v-answer';
      if (action === 'candidates') return 'v-candidates';
      if (action === 'candidate') return 'v-candidate';
      if (action === 'disconnect') return 'v-disconnect';
    }
    return action;
  }

  function validatePayload(payload, localPubkey) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (payload.family !== CALL_SIGNAL_FAMILY || payload.v !== CALL_SIGNAL_VERSION) return null;
    if (payload.media !== 'voice' && payload.media !== 'video') return null;
    const action = String(payload.action || '');
    if (!FRESHNESS_SEC[action]) return null;
    if (typeof payload.sessionId !== 'string' || payload.sessionId.length < 32) return null;
    if (typeof payload.signalId !== 'string' || payload.signalId.length < 32) return null;
    if (typeof payload.sender !== 'string' || !/^[0-9a-fA-F]{64}$/.test(payload.sender.trim())) return null;
    if (typeof payload.recipient !== 'string' || !/^[0-9a-fA-F]{64}$/.test(payload.recipient.trim())) return null;
    if (typeof localPubkey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(localPubkey.trim())) return null;
    const sender = payload.sender.trim().toLowerCase();
    const recipient = payload.recipient.trim().toLowerCase();
    const self = localPubkey.trim().toLowerCase();
    if (recipient !== self) return null;
    const sentAt = Number(payload.sentAt) || 0;
    if (!sentAt) return null;
    const age = Math.floor(Date.now() / 1000) - sentAt;
    const maxAge = FRESHNESS_SEC[action];
    if (age > maxAge || age < -30) return null;
    return { ...payload, sender, recipient, action, sentAt };
  }

  /**
   * Build + publish one gift-wrapped call signal.
   * Returns published outer event. Throws CALL_SIGNAL_E2EE_ENCRYPT_FAILED on any failure (publish ZERO).
   */
  async function publishGiftWrappedCallSignal(opts) {
    const media = opts && opts.media;
    const peerPubkey = opts && opts.peerPubkey;
    const type = opts && opts.type;
    const data = opts && opts.data;
    const sessionId = opts && opts.sessionId;
    const pool = opts && opts.pool;
    const relays = opts && opts.relays;
    const senderPubkey = opts && opts.senderPubkey;
    const senderPrivateKey = opts && opts.senderPrivateKey;

    if (media !== 'voice' && media !== 'video') {
      callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'bad media');
    }
    if (!pool || typeof pool.publish !== 'function') {
      callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'pool unavailable');
    }
    const recipient = requireHexPubkey(peerPubkey);
    const sender = requireHexPubkey(senderPubkey);
    const senderSk = requirePrivBytes(senderPrivateKey);
    const action = normalizeAction(media, type);
    if (!FRESHNESS_SEC[action]) {
      callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'bad action');
    }
    const sid = typeof sessionId === 'string' && sessionId.length >= 32 ? sessionId : createSessionId();
    const signalId = createSignalId();
    const sentAt = Math.floor(Date.now() / 1000);

    const payload = {
      family: CALL_SIGNAL_FAMILY,
      v: CALL_SIGNAL_VERSION,
      media,
      action,
      sessionId: sid,
      signalId,
      sender,
      recipient,
      sentAt,
      data: data == null ? null : data,
    };

    let wrap;
    try {
      const finalizeEvent = getFinalizeEvent();
      const rumorUnsigned = {
        kind: RUMOR_KIND,
        pubkey: sender,
        created_at: sentAt,
        tags: [],
        content: JSON.stringify(payload),
      };
      const rumor = { ...rumorUnsigned, id: getEventHash(rumorUnsigned) };

      const sealDraft = {
        kind: SEAL_KIND,
        created_at: randomizedPastCreatedAt(),
        tags: [],
        content: nip44EncryptJson(rumor, senderSk, recipient),
      };
      const seal = finalizeEvent(sealDraft, senderSk);
      if (!verifyEventSig(seal)) {
        callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'seal signature invalid');
      }

      const wrapSk = generateEphemeralSecretKey();
      const wrapPk = getPublicKeyFromSk(wrapSk);
      if (wrapPk.toLowerCase() === sender) {
        callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'wrapper equals identity');
      }
      const wrapDraft = {
        kind: GIFT_WRAP_KIND,
        created_at: randomizedPastCreatedAt(),
        tags: [['p', recipient]],
        content: nip44EncryptJson(seal, wrapSk, recipient),
      };
      wrap = finalizeEvent(wrapDraft, wrapSk);
      if (!verifyEventSig(wrap)) {
        callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'wrap signature invalid');
      }
      if (wrap.pubkey.toLowerCase() === sender) {
        callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', 'outer pubkey is identity');
      }
    } catch (err) {
      if (err && (err.code === 'CALL_SIGNAL_E2EE_ENCRYPT_FAILED' || err.code === 'BLOCKED_CRYPTO_API')) throw err;
      callSignalFail('CALL_SIGNAL_E2EE_ENCRYPT_FAILED', err && err.message ? err.message : 'wrap failed');
    }

    await pool.publish(Array.isArray(relays) ? relays : [], wrap);
    try {
      console.log('CALL_SIGNAL_SENT action=' + action + ' encrypted=true');
    } catch (_e) {}
    return { event: wrap, sessionId: sid, signalId, action, sentAt };
  }

  /**
   * Unwrap kind 1059 → validated logical call signal.
   * Returns { media, action, wireType, data, sender, sessionId, signalId, sentAt, rumor, seal }
   * or null on reject.
   */
  async function unwrapGiftWrappedCallSignal(wrapEvent, recipientPrivateKey, localPubkey) {
    try {
      if (!wrapEvent || wrapEvent.kind !== GIFT_WRAP_KIND) return null;
      if (!verifyEventSig(wrapEvent)) return null;
      const self = requireHexPubkey(localPubkey, 'CALL_SIGNAL_E2EE_DECRYPT_FAILED');
      if (getPTag(wrapEvent) !== self) return null;
      const recipSk = requirePrivBytes(recipientPrivateKey);

      let seal;
      try {
        seal = nip44DecryptJson(wrapEvent, recipSk);
      } catch (_e) {
        return null;
      }
      if (!seal || seal.kind !== SEAL_KIND) return null;
      if (!verifyEventSig(seal)) return null;

      let rumor;
      try {
        rumor = nip44DecryptJson(seal, recipSk);
      } catch (_e) {
        return null;
      }
      if (!rumor || rumor.kind !== RUMOR_KIND) return null;
      if (String(rumor.pubkey || '').toLowerCase() !== String(seal.pubkey || '').toLowerCase()) return null;

      let payload;
      try {
        payload = typeof rumor.content === 'string' ? JSON.parse(rumor.content) : rumor.content;
      } catch (_e) {
        return null;
      }
      const valid = validatePayload(payload, self);
      if (!valid) return null;
      if (valid.sender !== String(seal.pubkey || '').toLowerCase()) return null;
      if (rememberSignalId(valid.signalId)) return null; // replay

      return {
        media: valid.media,
        action: valid.action,
        wireType: toWireType(valid.media, valid.action),
        data: valid.data,
        sender: valid.sender,
        recipient: valid.recipient,
        sessionId: valid.sessionId,
        signalId: valid.signalId,
        sentAt: valid.sentAt,
        rumor,
        seal,
        wrapId: wrapEvent.id,
      };
    } catch (_err) {
      return null;
    }
  }

  function looksLikeLegacyDirectCallSignal(event) {
    return !!(event && event.kind === 25050 && Array.isArray(event.tags) && event.tags.some((t) => t && t[0] === 'type'));
  }

  Object.assign(App, {
    CallSignalE2ee: {
      FAMILY: CALL_SIGNAL_FAMILY,
      VERSION: CALL_SIGNAL_VERSION,
      SEAL_KIND,
      GIFT_WRAP_KIND,
      RUMOR_KIND,
      FRESHNESS_SEC,
      MAX_SIGNAL_SDP_CHARS,
      createSessionId,
      createSignalId,
      publishGiftWrappedCallSignal,
      unwrapGiftWrappedCallSignal,
      dispatchGiftWrappedCallSignal,
      enqueueSecureDispatch,
      ensureSecureCallSubscription,
      drainPendingSecureWrapsFromNative,
      normalizeSessionDescription,
      getCachedSecureOffer,
      getDispatchStats,
      resetDispatchStatsForQa,
      looksLikeLegacyDirectCallSignal,
      normalizeAction,
      toWireType,
      randomizedPastCreatedAt,
      generateEphemeralSecretKey,
      rememberSignalId,
      rememberWrapId,
      _seenSignalIds: seenSignalIds,
      _seenWrapIds: seenWrapIds,
    },
  });

  // Shared secure 1059 subscription — one unwrap for voice+video.
  if (typeof App.notifyPoolReady === 'function') {
    const prevNotify = App.notifyPoolReady;
    App.notifyPoolReady = function(pool) {
      prevNotify(pool);
      try { ensureSecureCallSubscription(); } catch (_e) {}
    };
  } else {
    App.notifyPoolReady = function(_pool) {
      try { ensureSecureCallSubscription(); } catch (_e) {}
    };
  }
  try {
    if (App.pool && App.publicKey) ensureSecureCallSubscription();
  } catch (_e) {}
})(window);
