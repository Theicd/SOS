/**
 * F6C/F6D — WebView client for native typed crypto bridge.
 * Never requests/stores raw K from native. Fail closed — no raw-K fallback.
 * Holds opaque session capability in memory only after successful bind.
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
    CHAT_ENCRYPT: true,
    CHAT_DECRYPT: true,
    P2P_SIGNAL_ENCRYPT: true,
    P2P_SIGNAL_DECRYPT: true,
    CALL_SIGNAL_ENCRYPT: true,
    CALL_SIGNAL_DECRYPT: true,
    CALL_GIFTWRAP_UNWRAP: true,
    FILE_KEY_WRAP: true,
    FILE_KEY_UNWRAP: true,
  };

  let seq = 0;
  let capsCache = null;
  /** Opaque capability from bindNativeSessionAuthority — never logged. */
  let sessionCapability = '';

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

  function clearCapability() {
    sessionCapability = '';
  }

  /**
   * Bind native session after web SessionAuthority.bindCurrentSession.
   * Capability returned once — no fetch-current API.
   */
  function bindNativeSession(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const b = bridge();
    if (!b || typeof b.bindNativeSessionAuthority !== 'function') {
      return { ok: false, errorCode: 'NOT_AVAILABLE' };
    }
    const body = {
      v: 1,
      generation: Number(opts.generation),
      accountPubkey: String(opts.accountPubkey || opts.account || ''),
      previousCapability: sessionCapability || '',
    };
    const parsed = parseJson(b.bindNativeSessionAuthority(JSON.stringify(body)));
    if (!parsed || parsed.ok !== true || !parsed.sessionCapability) {
      clearCapability();
      return { ok: false, errorCode: (parsed && parsed.errorCode) || 'SESSION_REQUIRED' };
    }
    if (parsed.privkey || parsed.privateKey || parsed.nsec || parsed.k) {
      clearCapability();
      return { ok: false, errorCode: 'SECRET_IN_RESPONSE' };
    }
    sessionCapability = String(parsed.sessionCapability);
    return {
      ok: true,
      generation: parsed.generation,
      accountPubkey: parsed.accountPubkey,
    };
  }

  function revokeNativeSession(reason) {
    clearCapability();
    const b = bridge();
    if (!b || typeof b.revokeNativeSessionAuthority !== 'function') {
      return { ok: false, errorCode: 'NOT_AVAILABLE' };
    }
    try {
      const parsed = parseJson(b.revokeNativeSessionAuthority(JSON.stringify({ reason: String(reason || 'revoke') })));
      return { ok: !!(parsed && parsed.ok), revoked: true };
    } catch (_e) {
      return { ok: false, errorCode: 'NATIVE_CRYPTO_FAILED' };
    }
  }

  function revalidateNativeSession() {
    const b = bridge();
    if (!b || typeof b.revalidateNativeSessionAuthority !== 'function') {
      return { ok: false, active: false };
    }
    const parsed = parseJson(b.revalidateNativeSessionAuthority());
    if (!parsed || parsed.active !== true) {
      clearCapability();
    }
    if (parsed && (parsed.sessionCapability || parsed.capability)) {
      clearCapability();
      return { ok: false, active: false, errorCode: 'CAPABILITY_LEAK' };
    }
    return parsed || { ok: false, active: false };
  }

  function sessionContext() {
    const SA = App.SessionAuthority || root.SosSessionAuthority;
    let gen = 0;
    try {
      if (SA && typeof SA.getBoundGeneration === 'function') {
        const g = SA.getBoundGeneration();
        if (g != null) gen = Number(g) || 0;
      }
    } catch (_e) {}
    const pub = typeof App.publicKey === 'string' ? App.publicKey.trim().toLowerCase() : '';
    return { sessionGeneration: gen, accountPubkey: pub, sessionCapability: sessionCapability };
  }

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
    const ctx = sessionCtx || sessionContext();
    if (!ctx.sessionCapability) {
      const err = new Error('SESSION_REQUIRED');
      err.code = 'SESSION_REQUIRED';
      throw err;
    }
    const body = {
      v: PROTOCOL_VERSION,
      op: name,
      requestId: nextRequestId(),
      sessionGeneration: typeof ctx.sessionGeneration === 'number' ? ctx.sessionGeneration : 0,
      accountPubkey: ctx.accountPubkey ? String(ctx.accountPubkey) : '',
      sessionCapability: String(ctx.sessionCapability),
      params: params && typeof params === 'object' ? params : {},
    };
    const raw = b.nativeTypedCryptoRequest(JSON.stringify(body));
    const parsed = parseJson(raw);
    if (!parsed || parsed.ok !== true || !parsed.result) {
      const code = (parsed && parsed.errorCode) || 'NATIVE_CRYPTO_FAILED';
      if (code === 'SESSION_REVOKED' || code === 'SESSION_REQUIRED') {
        clearCapability();
      }
      const err = new Error(code);
      err.code = code;
      throw err;
    }
    if (parsed.result.privkey || parsed.result.privateKey || parsed.result.nsec || parsed.result.k ||
        parsed.result.conversationKey || parsed.result.sharedSecret || parsed.result.ecdh) {
      const err = new Error('SECRET_IN_RESPONSE');
      err.code = 'SECRET_IN_RESPONSE';
      throw err;
    }
    return parsed.result;
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

  function chatEncrypt(fields) {
    return request('CHAT_ENCRYPT', {
      plaintext: String(fields && fields.plaintext != null ? fields.plaintext : ''),
      recipientPubkey: String(fields && (fields.recipientPubkey || fields.recipient) || ''),
    }, sessionContext());
  }

  function chatDecrypt(fields) {
    return request('CHAT_DECRYPT', {
      ciphertext: String(fields && fields.ciphertext != null ? fields.ciphertext : ''),
      peerPubkey: String(fields && (fields.peerPubkey || fields.senderPubkey) || ''),
    }, sessionContext());
  }

  function p2pSignalEncrypt(fields) {
    return request('P2P_SIGNAL_ENCRYPT', {
      plaintext: String(fields && fields.plaintext != null ? fields.plaintext : ''),
      recipientPubkey: String(fields && (fields.recipientPubkey || fields.recipient) || ''),
    }, sessionContext());
  }

  function p2pSignalDecrypt(fields) {
    return request('P2P_SIGNAL_DECRYPT', {
      ciphertext: String(fields && fields.ciphertext != null ? fields.ciphertext : ''),
      senderPubkey: String(fields && (fields.senderPubkey || fields.peerPubkey) || ''),
    }, sessionContext());
  }

  function callSignalEncrypt(fields) {
    return request('CALL_SIGNAL_ENCRYPT', {
      plaintext: String(fields && fields.plaintext != null ? fields.plaintext : ''),
      recipientPubkey: String(fields && (fields.recipientPubkey || fields.recipient) || ''),
    }, sessionContext());
  }

  function callSignalDecrypt(fields) {
    return request('CALL_SIGNAL_DECRYPT', {
      ciphertext: String(fields && fields.ciphertext != null ? fields.ciphertext : ''),
      senderPubkey: String(fields && (fields.senderPubkey || fields.peerPubkey) || ''),
    }, sessionContext());
  }

  function fileKeyWrap(fields) {
    return request('FILE_KEY_WRAP', {
      keyMaterial: String(fields && fields.keyMaterial != null ? fields.keyMaterial : ''),
      recipientPubkey: String(fields && (fields.recipientPubkey || fields.recipient) || ''),
    }, sessionContext());
  }

  function fileKeyUnwrap(fields) {
    return request('FILE_KEY_UNWRAP', {
      ciphertext: String(fields && fields.ciphertext != null ? fields.ciphertext : ''),
      senderPubkey: String(fields && (fields.senderPubkey || fields.peerPubkey) || ''),
    }, sessionContext());
  }

  function callGiftwrapUnwrap(fields) {
    return request('CALL_GIFTWRAP_UNWRAP', {
      wrapEvent: fields && fields.wrapEvent ? fields.wrapEvent : {},
    }, sessionContext());
  }

  const api = {
    PROTOCOL_VERSION,
    isAvailable,
    getCapabilities,
    request,
    bindNativeSession,
    revokeNativeSession,
    revalidateNativeSession,
    clearCapability,
    signChatEvent,
    signPresenceEvent,
    signReadReceiptEvent,
    signCallSealEvent,
    signCallGiftwrapEvent,
    chatEncrypt,
    chatDecrypt,
    p2pSignalEncrypt,
    p2pSignalDecrypt,
    callSignalEncrypt,
    callSignalDecrypt,
    fileKeyWrap,
    fileKeyUnwrap,
    callGiftwrapUnwrap,
    getPrivkey: undefined,
    NATIVE_PROVIDER_REQUIRES_RAW_K_FROM_BRIDGE: false,
    NATIVE_TYPED_BRIDGE_FAILURE_CAUSES_RAW_K_FALLBACK: false,
    hasSessionCapability: function () { return !!sessionCapability; },
  };

  App.NativeTypedCryptoBridge = api;
  root.SosNativeTypedCryptoBridge = api;
})(typeof window !== 'undefined' ? window : globalThis);
