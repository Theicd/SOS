/**
 * F6C — WebView client for native typed crypto bridge.
 * Never requests/stores raw K from native. Fail closed — no raw-K fallback.
 * HYPER CORE TECH
 */
(function initNativeTypedCryptoBridge(root) {
  const App = root.NostrApp || (root.NostrApp = {});
  const PROTOCOL_VERSION = 1;
  const ALLOWED = {
    SIGN_CHAT_EVENT: true,
    SIGN_CALL_SEAL: true,
    SIGN_CALL_GIFTWRAP: true,
    SIGN_PRESENCE_EVENT: true,
    SIGN_READ_RECEIPT_EVENT: true,
  };

  let seq = 0;
  let capsCache = null;

  function bridge() {
    try {
      const b = root.SosNativeShell;
      if (!b || typeof b.isNativeShell !== 'function' || b.isNativeShell() !== true) return null;
      return b;
    } catch (_e) {
      return null;
    }
  }

  function parseJson(raw) {
    if (raw && typeof raw === 'object') return raw;
    try {
      return JSON.parse(String(raw || '{}'));
    } catch (_e) {
      return null;
    }
  }

  function getCapabilities() {
    if (capsCache) return capsCache;
    const b = bridge();
    if (!b || typeof b.getNativeTypedCryptoCapabilitiesJson !== 'function') {
      capsCache = { ok: false, nativeTypedCrypto: false };
      return capsCache;
    }
    const parsed = parseJson(b.getNativeTypedCryptoCapabilitiesJson());
    if (!parsed || parsed.nativeTypedCrypto !== true || Number(parsed.nativeTypedCryptoVersion || parsed.protocolVersion) < 1) {
      capsCache = { ok: false, nativeTypedCrypto: false };
      return capsCache;
    }
    if (parsed.returnsPrivateKey === true) {
      // Refuse capability if native incorrectly advertises raw-K return.
      capsCache = { ok: false, nativeTypedCrypto: false, refused: 'RETURNS_PRIVATE_KEY' };
      return capsCache;
    }
    capsCache = parsed;
    return capsCache;
  }

  function isAvailable() {
    const c = getCapabilities();
    return !!(c && c.ok !== false && c.nativeTypedCrypto === true);
  }

  function nextRequestId() {
    seq += 1;
    return 'f6c-' + Date.now().toString(36) + '-' + seq;
  }

  /**
   * Typed request. Never falls back to getPrivkey / verifier privkey.
   */
  function request(op, params, sessionCtx) {
    const name = String(op || '').toUpperCase();
    if (!ALLOWED[name]) {
      const err = new Error('UNSUPPORTED_OPERATION');
      err.code = 'UNSUPPORTED_OPERATION';
      throw err;
    }
    if (!isAvailable()) {
      const err = new Error('NOT_AVAILABLE');
      err.code = 'NOT_AVAILABLE';
      throw err;
    }
    const b = bridge();
    if (!b || typeof b.nativeTypedCryptoRequest !== 'function') {
      const err = new Error('NOT_AVAILABLE');
      err.code = 'NOT_AVAILABLE';
      throw err;
    }
    const body = {
      v: PROTOCOL_VERSION,
      op: name,
      requestId: nextRequestId(),
      sessionGeneration: sessionCtx && typeof sessionCtx.sessionGeneration === 'number'
        ? sessionCtx.sessionGeneration
        : 0,
      accountPubkey: sessionCtx && sessionCtx.accountPubkey ? String(sessionCtx.accountPubkey) : '',
      params: params && typeof params === 'object' ? params : {},
    };
    const raw = b.nativeTypedCryptoRequest(JSON.stringify(body));
    const parsed = parseJson(raw);
    if (!parsed || parsed.ok !== true || !parsed.result) {
      const code = (parsed && parsed.errorCode) || 'NATIVE_CRYPTO_FAILED';
      const err = new Error(code);
      err.code = code;
      throw err;
    }
    // Defensive: reject any secret-bearing response
    if (parsed.result.privkey || parsed.result.privateKey || parsed.result.nsec || parsed.result.k) {
      const err = new Error('SECRET_IN_RESPONSE');
      err.code = 'SECRET_IN_RESPONSE';
      throw err;
    }
    return parsed.result;
  }

  function sessionContext() {
    const SA = App.SessionAuthority || root.SosSessionAuthority;
    let gen = 0;
    try {
      if (SA && typeof SA.getSessionGeneration === 'function') {
        gen = Number(SA.getSessionGeneration()) || 0;
      }
    } catch (_e) {}
    const pub = typeof App.publicKey === 'string' ? App.publicKey.trim().toLowerCase() : '';
    return { sessionGeneration: gen, accountPubkey: pub };
  }

  function signChatEvent(fields) {
    return request('SIGN_CHAT_EVENT', {
      content: String(fields && fields.content != null ? fields.content : ''),
      recipientPubkey: String(fields && (fields.recipientPubkey || fields.recipient) || ''),
      createdAt: fields && typeof fields.createdAt === 'number' ? fields.createdAt : undefined,
    }, sessionContext());
  }

  function signPresenceEvent(fields) {
    return request('SIGN_PRESENCE_EVENT', {
      content: String(fields && fields.content != null ? fields.content : ''),
      recipientPubkey: String(fields && (fields.recipientPubkey || fields.recipient) || ''),
      createdAt: fields && typeof fields.createdAt === 'number' ? fields.createdAt : undefined,
    }, sessionContext());
  }

  function signReadReceiptEvent(fields) {
    return request('SIGN_READ_RECEIPT_EVENT', {
      content: String(fields && fields.content != null ? fields.content : ''),
      recipientPubkey: String(fields && (fields.recipientPubkey || fields.recipient) || ''),
      createdAt: fields && typeof fields.createdAt === 'number' ? fields.createdAt : undefined,
      eventIdTag: fields && fields.eventIdTag ? String(fields.eventIdTag) : undefined,
    }, sessionContext());
  }

  function signCallSealEvent(fields) {
    return request('SIGN_CALL_SEAL', {
      content: String(fields && fields.content != null ? fields.content : ''),
      createdAt: fields && typeof fields.createdAt === 'number' ? fields.createdAt : undefined,
    }, sessionContext());
  }

  function signCallGiftwrapEvent(fields) {
    return request('SIGN_CALL_GIFTWRAP', {
      content: String(fields && fields.content != null ? fields.content : ''),
      recipientPubkey: String(fields && (fields.recipientPubkey || fields.recipient) || ''),
      createdAt: fields && typeof fields.createdAt === 'number' ? fields.createdAt : undefined,
    }, sessionContext());
  }

  const api = {
    PROTOCOL_VERSION,
    isAvailable,
    getCapabilities,
    request,
    signChatEvent,
    signPresenceEvent,
    signReadReceiptEvent,
    signCallSealEvent,
    signCallGiftwrapEvent,
    // Explicit: never raw-K
    getPrivkey: undefined,
    NATIVE_PROVIDER_REQUIRES_RAW_K_FROM_BRIDGE: false,
    NATIVE_TYPED_BRIDGE_FAILURE_CAUSES_RAW_K_FALLBACK: false,
  };

  App.NativeTypedCryptoBridge = api;
  root.SosNativeTypedCryptoBridge = api;
})(typeof window !== 'undefined' ? window : globalThis);
