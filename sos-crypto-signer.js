/**
 * SosCryptoSigner — typed crypto/signing facade (F1 + F2B).
 * Default backend: MAIN_THREAD (App.privateKey).
 * When SOS_CRYPTO_WORKER_AUTHORITATIVE + vault ready: WORKER_VAULT (async RPC).
 * No public raw-key getter. HYPER CORE TECH
 */
(function initSosCryptoSigner(root) {
  const App = root.NostrApp || (root.NostrApp = {});
  const NT = root.NostrTools;

  const MAX_CONTENT_CHARS = 256 * 1024;
  const MAX_CREATED_AT_SKEW_SEC = 172800;
  const MIN_CREATED_AT = 1_000_000_000;

  const OP_SPECS = {
    SIGN_CHAT_EVENT: { kinds: [1050], requireRecipientP: true },
    SIGN_PROFILE_EVENT: { kinds: [0] },
    SIGN_P2P_SIGNAL: { kinds: [25055], requireRecipientP: true },
    SIGN_P2P_FILE: { kinds: [30078] },
    SIGN_CALL_SEAL: { kinds: [13] },
    SIGN_CALL_GIFTWRAP: { kinds: [1059], requireRecipientP: true },
    SIGN_CALL_RUMOR_LEGACY: { kinds: [25050] },
    SIGN_READ_RECEIPT: { kinds: [1051], requireRecipientP: true },
    SIGN_PRESENCE: { kinds: [1054], requireRecipientP: true },
    SIGN_DELETE: { kinds: [5] },
    SIGN_FEED: { kinds: [1] },
    SIGN_REACTION: { kinds: [7] },
    SIGN_FOLLOW: { kinds: [40010] },
    SIGN_INVITE: { kinds: [37378, 37379] },
    SIGN_INVITE_REVOKE: { kinds: [37380] },
    SIGN_MODERATION_ACTION: { kinds: [39002] },
    // AC9: SIGN_MEMBERSHIP_STATE / SIGN_GROUP_CONTROL removed from public surface
    SIGN_EMAIL_REGISTRY: { kinds: [37377] },
    SIGN_BLOSSOM_AUTH: { kinds: [24242] },
    SIGN_DATING: { kinds: [40001] },
    SIGN_GAME: { kinds: [33051, 33052, 33201, 33202, 33203, 33211] },
    SIGN_LIVE: { kinds: [25051, 25056] },
    SIGN_LIVE_TV: { kinds: [30078] },
    SIGN_LOGIN_METRIC: { kinds: [1050] },
    SIGN_MEDIA_RECHECK: { kinds: [1] },
  };

  let forcedBackend = null; // 'MAIN_THREAD' | 'WORKER_VAULT' | null(auto)

  function fail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    err.name = 'SosCryptoSignerError';
    throw err;
  }

  function vault() {
    return App.SosCryptoWorkerVault || root.SosCryptoWorkerVault;
  }

  /** Multi-tab session gate — as close as practical to typed authority boundary. */
  function requireValidSession(opName) {
    const SA = App.SessionAuthority || root.SosSessionAuthority;
    if (!SA || typeof SA.assertSessionForSensitiveOp !== 'function') {
      // Unit/QA harness without session-authority.js: do not block legacy gates.
      // Production videos.html always loads SessionAuthority before signer use.
      return;
    }
    try {
      SA.assertSessionForSensitiveOp(opName || 'sign');
    } catch (err) {
      const code = (err && err.code) || 'SESSION_REVOKED';
      fail(code, (err && err.message) || 'session revoked');
    }
  }

  function isWorkerAuthoritative() {
    if (forcedBackend === 'MAIN_THREAD') return false;
    if (forcedBackend === 'WORKER_VAULT') return true;
    const v = vault();
    return !!(v && typeof v.isAuthoritative === 'function' && v.isAuthoritative());
  }

  function getBackend() {
    return isWorkerAuthoritative() ? 'WORKER_VAULT' : 'MAIN_THREAD';
  }

  function setBackend(name) {
    if (name === 'MAIN_THREAD' || name === 'WORKER_VAULT' || name == null) {
      forcedBackend = name;
    }
  }

  function sessionKeyHex() {
    if (isWorkerAuthoritative()) return '';
    const raw = App.privateKey;
    if (typeof raw !== 'string') return '';
    const hex = raw.trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(hex)) return '';
    return hex;
  }

  function requireSessionKeyHex() {
    if (isWorkerAuthoritative()) {
      fail('WORKER_AUTH_NO_PAGE_K', 'page K unavailable in worker-authoritative mode');
    }
    const hex = sessionKeyHex();
    if (!hex) fail('NO_SESSION_KEY', 'identity key unavailable');
    return hex;
  }

  function hexToBytes(hex) {
    if (typeof App.hexToBytes === 'function') return App.hexToBytes(hex);
    const fromUtils = NT && NT.utils && typeof NT.utils.hexToBytes === 'function' ? NT.utils.hexToBytes : null;
    if (fromUtils) return fromUtils(hex);
    const clean = String(hex || '');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
      out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
    }
    return out;
  }

  function hasIdentityKey() {
    if (isWorkerAuthoritative()) {
      const v = vault();
      return !!(v && v.isReady() && currentPubkey());
    }
    const NTC = App.NativeTypedCryptoBridge || root.SosNativeTypedCryptoBridge;
    if (NTC && typeof NTC.isAvailable === 'function' && NTC.isAvailable() && currentPubkey()) {
      return true;
    }
    return !!sessionKeyHex();
  }

  function findETag(tags) {
    if (!Array.isArray(tags)) return '';
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      if (Array.isArray(t) && t[0] === 'e' && typeof t[1] === 'string') return t[1].toLowerCase();
    }
    return '';
  }

  const NATIVE_TYPED_OPS = {
    SIGN_CHAT_EVENT: 'SIGN_CHAT_EVENT',
    SIGN_CALL_SEAL: 'SIGN_CALL_SEAL',
    SIGN_CALL_GIFTWRAP: 'SIGN_CALL_GIFTWRAP',
    SIGN_PRESENCE: 'SIGN_PRESENCE_EVENT',
    SIGN_READ_RECEIPT: 'SIGN_READ_RECEIPT_EVENT',
  };

  function tryNativeTypedSign(op, draft) {
    const mapped = NATIVE_TYPED_OPS[op];
    if (!mapped) return null;
    const NTC = App.NativeTypedCryptoBridge || root.SosNativeTypedCryptoBridge;
    if (!NTC || typeof NTC.isAvailable !== 'function' || !NTC.isAvailable()) return null;
    const recipient = findPTag(draft.tags);
    const fields = {
      content: draft.content,
      recipientPubkey: recipient,
      createdAt: draft.created_at,
      eventIdTag: findETag(draft.tags) || undefined,
    };
    if (mapped === 'SIGN_CHAT_EVENT') return NTC.signChatEvent(fields);
    if (mapped === 'SIGN_PRESENCE_EVENT') return NTC.signPresenceEvent(fields);
    if (mapped === 'SIGN_READ_RECEIPT_EVENT') return NTC.signReadReceiptEvent(fields);
    if (mapped === 'SIGN_CALL_SEAL') return NTC.signCallSealEvent(fields);
    if (mapped === 'SIGN_CALL_GIFTWRAP') return NTC.signCallGiftwrapEvent(fields);
    return null;
  }

  function signTyped(op, draft) {
    requireValidSession(op);
    validateDraft(op, draft);
    const copy = {
      kind: draft.kind,
      created_at: draft.created_at,
      tags: draft.tags,
      content: draft.content,
    };
    if (draft.pubkey) copy.pubkey = draft.pubkey;
    else if (App.publicKey) copy.pubkey = App.publicKey;
    // Re-check immediately before authority use (TOCTOU hardening)
    requireValidSession(op);
    if (isWorkerAuthoritative()) {
      // DOUBLE_CRYPTO_EXECUTION=false — worker only
      return workerRpc(op, { draft: copy });
    }
    // F6C: prefer native typed bridge for allowlisted ops. Never fall back to native raw-K retrieval.
    try {
      const nativeSigned = tryNativeTypedSign(op, copy);
      if (nativeSigned) return nativeSigned;
    } catch (nativeErr) {
      // If page has no local K (native custody), fail closed — do not fetch K from bridge.
      if (!sessionKeyHex()) {
        throw nativeErr;
      }
      // Browser-custodied identity may continue on main thread.
    }
    const signed = finalizeWithSession(copy);
    maybeShadowSign(op, copy, signed);
    return signed;
  }

  function currentPubkey() {
    return typeof App.publicKey === 'string' ? App.publicKey.trim().toLowerCase() : '';
  }

  function findPTag(tags) {
    if (!Array.isArray(tags)) return '';
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      if (Array.isArray(t) && t[0] === 'p' && typeof t[1] === 'string') return t[1].toLowerCase();
    }
    return '';
  }

  function validateDraft(op, draft) {
    const spec = OP_SPECS[op];
    if (!spec) fail('UNKNOWN_OP', 'unsupported operation: ' + op);
    if (!draft || typeof draft !== 'object') fail('MALFORMED_DRAFT', 'draft required');
    if (typeof draft.kind !== 'number' || !Number.isInteger(draft.kind)) {
      fail('BAD_KIND', 'draft.kind must be integer');
    }
    if (spec.kinds.indexOf(draft.kind) === -1) {
      fail('KIND_NOT_ALLOWED', 'kind ' + draft.kind + ' not allowed for ' + op);
    }
    if (typeof draft.content !== 'string') fail('BAD_CONTENT', 'content must be string');
    if (draft.content.length > MAX_CONTENT_CHARS) fail('CONTENT_TOO_LARGE', 'content exceeds limit');
    if (!Array.isArray(draft.tags)) fail('BAD_TAGS', 'tags must be array');
    const now = Math.floor(Date.now() / 1000);
    if (typeof draft.created_at !== 'number' || !Number.isInteger(draft.created_at)) {
      fail('BAD_CREATED_AT', 'created_at must be integer');
    }
    if (draft.created_at < MIN_CREATED_AT || draft.created_at > now + MAX_CREATED_AT_SKEW_SEC) {
      fail('BAD_CREATED_AT_WINDOW', 'created_at out of allowed window');
    }
    const self = currentPubkey();
    if (draft.pubkey != null && self && String(draft.pubkey).toLowerCase() !== self) {
      fail('SENDER_MISMATCH', 'draft.pubkey must match session identity');
    }
    if (spec.requireRecipientP) {
      const p = findPTag(draft.tags);
      if (!p || !/^[0-9a-f]{64}$/i.test(p)) fail('MISSING_RECIPIENT', 'p tag required');
    }
    return spec;
  }

  function finalizeWithSession(draft) {
    const key = requireSessionKeyHex();
    if (typeof App.finalizeEvent !== 'function') {
      if (NT && typeof NT.finalizeEvent === 'function') {
        return NT.finalizeEvent(draft, key);
      }
      fail('FINALIZE_UNAVAILABLE', 'finalizeEvent missing');
    }
    return App.finalizeEvent(draft, key);
  }

  function maybeShadowSign(op, draft, mainEvent) {
    try {
      if (!root.__SOS_F2A_SHADOW__ || isWorkerAuthoritative()) return;
      const v = vault();
      if (!v || typeof v.shadowCompareSign !== 'function' || !v.isReady()) return;
      Promise.resolve(v.shadowCompareSign(op, draft, mainEvent)).catch(function () {});
    } catch (_e) {}
  }

  function workerRpc(op, params) {
    const v = vault();
    if (!v || typeof v.authoritativeRpc !== 'function') fail('WORKER_VAULT_UNAVAILABLE', 'vault bridge missing');
    return v.authoritativeRpc(op, params);
  }

  function policy() {
    return App.AdminSigningPolicy || root.SosAdminSigningPolicy || null;
  }

  function strictVerifyEvent(event) {
    try {
      if (typeof App.strictVerifyNostrEvent === 'function') {
        return App.strictVerifyNostrEvent(event) === true;
      }
    } catch (_e) {}
    try {
      if (NT && typeof NT.verifyEvent === 'function') return NT.verifyEvent(event) === true;
    } catch (_e2) {}
    return false;
  }

  /**
   * AC9 — narrow typed admin signing. Caller supplies operation + narrow params + signed base.
   * Actor pubkey always from signing key. Kind/epoch/tags constructed by policy.
   */
  function signTypedAdminOperation(request) {
    requireValidSession('SIGN_ADMIN_TYPED');
    const P = policy();
    if (!P) fail('ADMIN_POLICY_MISSING', 'AdminSigningPolicy required');
    // Final session check at admin authority boundary (TOCTOU)
    requireValidSession('SIGN_ADMIN_TYPED');
    if (isWorkerAuthoritative()) {
      return workerRpc('SIGN_ADMIN_TYPED', { request: request || {} });
    }
    const op = P.validateRequestEnvelope(request || {});
    const actor = currentPubkey() || '';
    if (!actor || !/^[0-9a-f]{64}$/.test(actor)) {
      // derive from session key when publicKey mirror missing
      const hex = requireSessionKeyHex();
      const pub = NT.getPublicKey(hexToBytes(hex));
      return signTypedAdminOperationMain(P, op, request, String(pub).toLowerCase());
    }
    return signTypedAdminOperationMain(P, op, request, actor);
  }

  function signTypedAdminOperationMain(P, op, request, actor) {
    let draft;
    if (P.isControlOp(op)) {
      let baseRecord = null;
      if (op !== P.ADMIN_OP.BOOTSTRAP_GROUP_CONTROL) {
        const baseEvent = request.baseEvent;
        if (!baseEvent || !strictVerifyEvent(baseEvent)) fail('BASE_VERIFY_FAILED');
        baseRecord = P.parseControlRecordFromEvent(baseEvent);
      }
      const groupId = P.resolveNetworkTag(request && request.groupId, baseRecord);
      if (baseRecord && baseRecord.groupId !== groupId) fail('CROSS_GROUP');
      const next = P.applyControlOperation(op, baseRecord, actor, Object.assign({}, request, { groupId }));
      draft = P.buildControlDraft(next, actor);
    } else if (P.isMemberOp(op)) {
      const baseEvent = request.baseEvent;
      if (!baseEvent || !strictVerifyEvent(baseEvent)) fail('BASE_VERIFY_FAILED');
      const baseControl = P.parseControlRecordFromEvent(baseEvent);
      const groupId = P.resolveNetworkTag(request && request.groupId, baseControl);
      if (baseControl.groupId !== groupId) fail('CROSS_GROUP');
      let tipBody = null;
      if (request.memberTipEvent) {
        if (!strictVerifyEvent(request.memberTipEvent)) fail('MEMBER_TIP_VERIFY_FAILED');
        try {
          tipBody = JSON.parse(request.memberTipEvent.content);
        } catch (_e) {
          fail('BAD_MEMBER_TIP');
        }
      }
      const body = P.applyMembershipOperation(
        op,
        baseControl,
        tipBody,
        actor,
        Object.assign({}, request, { groupId })
      );
      draft = P.buildMembershipDraft(body);
    } else {
      fail('UNKNOWN_OP');
    }
    // Sign constructed draft via finalize — kind already fixed by policy
    const copy = {
      kind: draft.kind,
      created_at: draft.created_at,
      tags: draft.tags,
      content: draft.content,
      pubkey: actor,
    };
    return finalizeWithSession(copy);
  }

  function broadAdminSignRemoved() {
    fail('BROAD_ADMIN_SIGN_REMOVED', 'Use signTypedAdminOperation (AC9)');
  }

  function getNip44() {
    const nip44 = NT && NT.nip44;
    if (!nip44 || !nip44.v2 || typeof nip44.v2.encrypt !== 'function' || typeof nip44.v2.decrypt !== 'function') {
      fail('NIP44_UNAVAILABLE', 'NostrTools.nip44.v2 missing');
    }
    const getConversationKey =
      (nip44.v2.utils && nip44.v2.utils.getConversationKey) || nip44.getConversationKey;
    if (typeof getConversationKey !== 'function') fail('NIP44_UNAVAILABLE', 'getConversationKey missing');
    return {
      encrypt: nip44.v2.encrypt.bind(nip44.v2),
      decrypt: nip44.v2.decrypt.bind(nip44.v2),
      getConversationKey,
    };
  }

  function tryNativeTypedCrypto(op, params) {
    const NTC = App.NativeTypedCryptoBridge || root.SosNativeTypedCryptoBridge;
    if (!NTC || typeof NTC.isAvailable !== 'function' || !NTC.isAvailable()) return null;
    if (!NTC.hasSessionCapability || !NTC.hasSessionCapability()) return null;
    try {
      if (op === 'CHAT_ENCRYPT' && typeof NTC.chatEncrypt === 'function') return NTC.chatEncrypt(params);
      if (op === 'CHAT_DECRYPT' && typeof NTC.chatDecrypt === 'function') return NTC.chatDecrypt(params);
      if (op === 'P2P_SIGNAL_ENCRYPT' && typeof NTC.p2pSignalEncrypt === 'function') return NTC.p2pSignalEncrypt(params);
      if (op === 'P2P_SIGNAL_DECRYPT' && typeof NTC.p2pSignalDecrypt === 'function') return NTC.p2pSignalDecrypt(params);
      if (op === 'CALL_SIGNAL_ENCRYPT' && typeof NTC.callSignalEncrypt === 'function') return NTC.callSignalEncrypt(params);
      if (op === 'CALL_SIGNAL_DECRYPT' && typeof NTC.callSignalDecrypt === 'function') return NTC.callSignalDecrypt(params);
      if (op === 'FILE_KEY_WRAP' && typeof NTC.fileKeyWrap === 'function') return NTC.fileKeyWrap(params);
      if (op === 'FILE_KEY_UNWRAP' && typeof NTC.fileKeyUnwrap === 'function') return NTC.fileKeyUnwrap(params);
      if (op === 'CALL_GIFTWRAP_UNWRAP' && typeof NTC.callGiftwrapUnwrap === 'function') {
        return NTC.callGiftwrapUnwrap(params);
      }
    } catch (err) {
      // Native custody: never fall back to raw K export.
      if (!sessionKeyHex()) throw err;
      return null;
    }
    return null;
  }

  function isNativeCustodyWithoutPageK() {
    const NTC = App.NativeTypedCryptoBridge || root.SosNativeTypedCryptoBridge;
    return !!(NTC && typeof NTC.isAvailable === 'function' && NTC.isAvailable() && !sessionKeyHex());
  }

  function nip44ChatEncrypt(args) {
    requireValidSession('NIP44_CHAT_ENCRYPT');
    if (isWorkerAuthoritative()) {
      return workerRpc('NIP44_CHAT_ENCRYPT', args || {});
    }
    // F6F: native-custodied identity — typed bridge only (no page K).
    if (isNativeCustodyWithoutPageK()) {
      const payload = args && args.payload;
      const recipient = String((args && args.recipientPubkey) || '').toLowerCase();
      const sender = String((args && args.senderPubkey) || currentPubkey() || '').toLowerCase();
      let plaintext;
      if (args && typeof args.plaintext === 'string') {
        plaintext = args.plaintext;
      } else if (payload && typeof payload === 'object') {
        const body = Object.assign({}, payload);
        if (body.sender == null) body.sender = sender;
        if (body.recipient == null) body.recipient = recipient;
        plaintext = JSON.stringify(body);
      } else {
        fail('BAD_PLAINTEXT', 'plaintext or payload required');
      }
      const native = tryNativeTypedCrypto('CHAT_ENCRYPT', { plaintext: plaintext, recipientPubkey: recipient });
      if (!native || !native.ct) fail('NATIVE_CRYPTO_FAILED', 'CHAT_ENCRYPT failed');
      return native;
    }
    if (typeof App.encryptPrivateChatPayload !== 'function') {
      fail('CHAT_E2EE_UNAVAILABLE', 'encryptPrivateChatPayload missing');
    }
    return App.encryptPrivateChatPayload({
      senderPrivateKeyHex: requireSessionKeyHex(),
      senderPubkey: args && args.senderPubkey,
      recipientPubkey: args && args.recipientPubkey,
      payload: args && args.payload,
    });
  }

  function nip44ChatDecrypt(args) {
    if (isWorkerAuthoritative()) {
      return workerRpc('NIP44_CHAT_DECRYPT', args || {});
    }
    if (isNativeCustodyWithoutPageK()) {
      const env = args && args.encryptedEnvelope;
      let ct = '';
      if (typeof env === 'string') {
        try {
          const parsed = JSON.parse(env);
          ct = parsed && parsed.ct ? String(parsed.ct) : '';
        } catch (_e) {
          ct = '';
        }
      } else if (env && typeof env === 'object') {
        ct = String(env.ct || '');
      }
      const selfAuthored = !!(args && args.selfAuthored);
      let peer = String((args && args.eventAuthorPubkey) || '').toLowerCase();
      if (selfAuthored) {
        peer = String((args && args.intendedRecipientPubkey) || '').toLowerCase();
      }
      const native = tryNativeTypedCrypto('CHAT_DECRYPT', { ciphertext: ct, peerPubkey: peer });
      if (!native || typeof native.plaintext !== 'string') fail('NATIVE_CRYPTO_FAILED', 'CHAT_DECRYPT failed');
      try {
        return JSON.parse(native.plaintext);
      } catch (_e) {
        fail('DECRYPT_FAILED', 'invalid plaintext json');
      }
    }
    if (typeof App.decryptPrivateChatPayload !== 'function') {
      fail('CHAT_E2EE_UNAVAILABLE', 'decryptPrivateChatPayload missing');
    }
    return App.decryptPrivateChatPayload({
      localPrivateKeyHex: requireSessionKeyHex(),
      localPubkey: args && args.localPubkey,
      eventAuthorPubkey: args && args.eventAuthorPubkey,
      encryptedEnvelope: args && args.encryptedEnvelope,
      selfAuthored: args && args.selfAuthored,
      intendedRecipientPubkey: args && args.intendedRecipientPubkey,
    });
  }

  function nip44P2pEncrypt(plaintext, recipientPubkey) {
    requireValidSession('NIP44_P2P_ENCRYPT');
    if (isWorkerAuthoritative()) {
      return workerRpc('NIP44_P2P_ENCRYPT', { plaintext, recipientPubkey });
    }
    if (isNativeCustodyWithoutPageK()) {
      // Web P2P signaling over NIP44 for browser path; native shell P2P uses NIP04 in-process.
      const native = tryNativeTypedCrypto('CALL_SIGNAL_ENCRYPT', {
        plaintext: String(plaintext),
        recipientPubkey: String(recipientPubkey || ''),
      });
      if (!native || !native.ciphertext) fail('NATIVE_CRYPTO_FAILED', 'encrypt failed');
      return native.ciphertext;
    }
    const recipient = String(recipientPubkey || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(recipient)) fail('BAD_RECIPIENT', 'invalid recipient');
    if (typeof plaintext !== 'string') fail('BAD_PLAINTEXT', 'plaintext must be string');
    const nip44 = getNip44();
    const privBytes = hexToBytes(requireSessionKeyHex());
    return nip44.encrypt(plaintext, nip44.getConversationKey(privBytes, recipient));
  }

  function nip44P2pDecrypt(ciphertext, senderPubkey) {
    if (isWorkerAuthoritative()) {
      return workerRpc('NIP44_P2P_DECRYPT', { ciphertext, senderPubkey });
    }
    if (isNativeCustodyWithoutPageK()) {
      const native = tryNativeTypedCrypto('CALL_SIGNAL_DECRYPT', {
        ciphertext: String(ciphertext),
        senderPubkey: String(senderPubkey || ''),
      });
      if (!native || typeof native.plaintext !== 'string') fail('NATIVE_CRYPTO_FAILED', 'decrypt failed');
      return native.plaintext;
    }
    const sender = String(senderPubkey || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sender)) fail('BAD_SENDER', 'invalid sender');
    if (typeof ciphertext !== 'string' || !ciphertext) fail('BAD_CIPHERTEXT', 'ciphertext required');
    const nip44 = getNip44();
    const privBytes = hexToBytes(requireSessionKeyHex());
    return nip44.decrypt(ciphertext, nip44.getConversationKey(privBytes, sender));
  }

  function nip44CallEncryptJson(obj, recipientPubkey) {
    if (isWorkerAuthoritative()) {
      return workerRpc('NIP44_CALL_ENCRYPT', { obj, recipientPubkey });
    }
    return nip44P2pEncrypt(JSON.stringify(obj), recipientPubkey);
  }

  function nip44CallDecryptToString(ciphertext, senderPubkey) {
    if (isWorkerAuthoritative()) {
      return workerRpc('NIP44_CALL_DECRYPT', { ciphertext, senderPubkey });
    }
    return nip44P2pDecrypt(ciphertext, senderPubkey);
  }

  function fileKeyWrap(keyMaterial, recipientPubkey) {
    requireValidSession('FILE_KEY_WRAP');
    if (typeof keyMaterial !== 'string' || !keyMaterial) fail('BAD_KEY_MATERIAL', 'key material required');
    if (isWorkerAuthoritative()) {
      return workerRpc('FILE_KEY_WRAP', { keyMaterial, recipientPubkey });
    }
    if (isNativeCustodyWithoutPageK()) {
      const native = tryNativeTypedCrypto('FILE_KEY_WRAP', {
        keyMaterial: String(keyMaterial),
        recipientPubkey: String(recipientPubkey || ''),
      });
      if (!native || !native.ciphertext) fail('NATIVE_CRYPTO_FAILED', 'FILE_KEY_WRAP failed');
      return native.ciphertext;
    }
    return nip44P2pEncrypt(keyMaterial, recipientPubkey);
  }

  function fileKeyUnwrap(ciphertext, senderPubkey) {
    if (isWorkerAuthoritative()) {
      // Protocol may return file AES material to page chunk crypto — not identity K.
      return workerRpc('FILE_KEY_UNWRAP', { ciphertext, senderPubkey });
    }
    if (isNativeCustodyWithoutPageK()) {
      const native = tryNativeTypedCrypto('FILE_KEY_UNWRAP', {
        ciphertext: String(ciphertext),
        senderPubkey: String(senderPubkey || ''),
      });
      if (!native || typeof native.keyMaterial !== 'string') fail('NATIVE_CRYPTO_FAILED', 'FILE_KEY_UNWRAP failed');
      return native.keyMaterial;
    }
    return nip44P2pDecrypt(ciphertext, senderPubkey);
  }

  async function nip04Encrypt(peerPubkey, plaintext) {
    if (isWorkerAuthoritative()) {
      return workerRpc('NIP04_ENCRYPT', { peerPubkey, plaintext });
    }
    if (isNativeCustodyWithoutPageK()) {
      const native = tryNativeTypedCrypto('P2P_SIGNAL_ENCRYPT', {
        plaintext: String(plaintext),
        recipientPubkey: String(peerPubkey || ''),
      });
      if (!native || !native.ciphertext) fail('NATIVE_CRYPTO_FAILED', 'NIP04 encrypt failed');
      return native.ciphertext;
    }
    if (!NT || !NT.nip04 || typeof NT.nip04.encrypt !== 'function') {
      fail('NIP04_UNAVAILABLE', 'nip04.encrypt missing');
    }
    return NT.nip04.encrypt(requireSessionKeyHex(), peerPubkey, plaintext);
  }

  async function nip04Decrypt(peerPubkey, ciphertext) {
    if (isWorkerAuthoritative()) {
      return workerRpc('NIP04_DECRYPT', { peerPubkey, ciphertext });
    }
    if (isNativeCustodyWithoutPageK()) {
      const native = tryNativeTypedCrypto('P2P_SIGNAL_DECRYPT', {
        ciphertext: String(ciphertext),
        senderPubkey: String(peerPubkey || ''),
      });
      if (!native || typeof native.plaintext !== 'string') fail('NATIVE_CRYPTO_FAILED', 'NIP04 decrypt failed');
      return native.plaintext;
    }
    if (!NT || !NT.nip04 || typeof NT.nip04.decrypt !== 'function') {
      fail('NIP04_UNAVAILABLE', 'nip04.decrypt missing');
    }
    return NT.nip04.decrypt(requireSessionKeyHex(), peerPubkey, ciphertext);
  }

  function unwrapCallGiftwrap(wrapEvent, localPubkey) {
    if (isWorkerAuthoritative()) {
      return workerRpc('CALL_UNWRAP_GIFTWRAP', {
        wrapEvent,
        localPubkey: localPubkey || currentPubkey(),
      });
    }
    if (isNativeCustodyWithoutPageK()) {
      const native = tryNativeTypedCrypto('CALL_GIFTWRAP_UNWRAP', { wrapEvent: wrapEvent });
      if (!native) fail('NATIVE_CRYPTO_FAILED', 'giftwrap unwrap failed');
      return native;
    }
    fail('CALL_UNWRAP_MAIN_UNSUPPORTED', 'use call-signal-e2ee unwrap on main thread');
  }

  /**
   * Infra bridge — blocked when Worker authoritative (must not expose K to page).
   */
  function f1CryptoModuleSessionKeyHex() {
    if (isWorkerAuthoritative()) {
      fail('WORKER_AUTH_NO_PAGE_K', 'f1 session key blocked in worker-authoritative mode');
    }
    return requireSessionKeyHex();
  }

  const api = {
    hasIdentityKey,
    currentPubkey,
    getBackend,
    setBackend,
    isWorkerAuthoritative,
    // Typed signing (Promise when WORKER_VAULT)
    signChatEvent: (d) => signTyped('SIGN_CHAT_EVENT', d),
    signProfileEvent: (d) => signTyped('SIGN_PROFILE_EVENT', d),
    signP2pSignal: (d) => signTyped('SIGN_P2P_SIGNAL', d),
    signP2pFile: (d) => signTyped('SIGN_P2P_FILE', d),
    signCallSeal: (d) => signTyped('SIGN_CALL_SEAL', d),
    signCallGiftwrap: (d) => signTyped('SIGN_CALL_GIFTWRAP', d),
    signCallRumorLegacy: (d) => signTyped('SIGN_CALL_RUMOR_LEGACY', d),
    signReadReceipt: (d) => signTyped('SIGN_READ_RECEIPT', d),
    signPresence: (d) => signTyped('SIGN_PRESENCE', d),
    signDelete: (d) => signTyped('SIGN_DELETE', d),
    signFeedEvent: (d) => signTyped('SIGN_FEED', d),
    signReactionEvent: (d) => signTyped('SIGN_REACTION', d),
    signFollowEvent: (d) => signTyped('SIGN_FOLLOW', d),
    signInviteEvent: (d) => signTyped('SIGN_INVITE', d),
    signInviteRevokeEvent: (d) => signTyped('SIGN_INVITE_REVOKE', d),
    signModerationAction: (d) => signTyped('SIGN_MODERATION_ACTION', d),
    /** @deprecated AC9 — removed broad membership sign */
    signMembershipState: function () {
      return broadAdminSignRemoved();
    },
    signEmailRegistry: (d) => signTyped('SIGN_EMAIL_REGISTRY', d),
    signBlossomAuth: (d) => signTyped('SIGN_BLOSSOM_AUTH', d),
    signDatingEvent: (d) => signTyped('SIGN_DATING', d),
    signGameEvent: (d) => signTyped('SIGN_GAME', d),
    signLiveEvent: (d) => signTyped('SIGN_LIVE', d),
    signLiveTvEvent: (d) => signTyped('SIGN_LIVE_TV', d),
    signLoginMetric: (d) => signTyped('SIGN_LOGIN_METRIC', d),
    signMediaRecheck: (d) => signTyped('SIGN_MEDIA_RECHECK', d),
    /** @deprecated AC9 — removed broad group-control sign */
    signGroupControlEvent: function () {
      return broadAdminSignRemoved();
    },
    signTypedAdminOperation,
    nip44ChatEncrypt,
    nip44ChatDecrypt,
    nip44P2pEncrypt,
    nip44P2pDecrypt,
    nip44CallEncryptJson,
    nip44CallDecryptToString,
    fileKeyWrap,
    fileKeyUnwrap,
    nip04Encrypt,
    nip04Decrypt,
    unwrapCallGiftwrap,
    f1CryptoModuleSessionKeyHex,
    OP_SPECS,
  };

  /** Child-window / game bridge — typed only; never exposes raw K */
  async function signEventForOpener(draft) {
    if (!draft || typeof draft !== 'object') fail('MALFORMED_DRAFT', 'draft required');
    const kind = draft.kind;
    if (kind === 33201 || kind === 33202 || kind === 33203 || kind === 33211 || kind === 33051 || kind === 33052) {
      return signTyped('SIGN_GAME', draft);
    }
    fail('KIND_NOT_ALLOWED', 'opener signEvent kind not allowed');
  }
  api.signEvent = signEventForOpener;

  App.SosCryptoSigner = api;
  root.SosCryptoSigner = api;
  // Convenience for game popups: opener.NostrApp.signEvent
  if (typeof App.signEvent !== 'function') {
    App.signEvent = function (draft) {
      return signEventForOpener(draft);
    };
  }

  try {
    console.log('[SOS-CRYPTO-SIGNER] F1/F2B facade loaded');
  } catch (_e) {}
})(typeof window !== 'undefined' ? window : globalThis);
