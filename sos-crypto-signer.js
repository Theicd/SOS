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
    SIGN_FOLLOW: { kinds: [40010] },
    SIGN_INVITE: { kinds: [37378, 37379] },
    SIGN_BLOSSOM_AUTH: { kinds: [24242] },
    SIGN_DATING: { kinds: [40001] },
    SIGN_GAME: { kinds: [33051, 33052] },
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
    return !!sessionKeyHex();
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

  function signTyped(op, draft) {
    validateDraft(op, draft);
    const copy = {
      kind: draft.kind,
      created_at: draft.created_at,
      tags: draft.tags,
      content: draft.content,
    };
    if (draft.pubkey) copy.pubkey = draft.pubkey;
    else if (App.publicKey) copy.pubkey = App.publicKey;
    if (isWorkerAuthoritative()) {
      // DOUBLE_CRYPTO_EXECUTION=false — worker only
      return workerRpc(op, { draft: copy });
    }
    const signed = finalizeWithSession(copy);
    maybeShadowSign(op, copy, signed);
    return signed;
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

  function nip44ChatEncrypt(args) {
    if (isWorkerAuthoritative()) {
      return workerRpc('NIP44_CHAT_ENCRYPT', args || {});
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
    if (isWorkerAuthoritative()) {
      return workerRpc('NIP44_P2P_ENCRYPT', { plaintext, recipientPubkey });
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
    if (typeof keyMaterial !== 'string' || !keyMaterial) fail('BAD_KEY_MATERIAL', 'key material required');
    if (isWorkerAuthoritative()) {
      return workerRpc('FILE_KEY_WRAP', { keyMaterial, recipientPubkey });
    }
    return nip44P2pEncrypt(keyMaterial, recipientPubkey);
  }

  function fileKeyUnwrap(ciphertext, senderPubkey) {
    if (isWorkerAuthoritative()) {
      // Protocol may return file AES material to page chunk crypto — not identity K.
      return workerRpc('FILE_KEY_UNWRAP', { ciphertext, senderPubkey });
    }
    return nip44P2pDecrypt(ciphertext, senderPubkey);
  }

  async function nip04Encrypt(peerPubkey, plaintext) {
    if (isWorkerAuthoritative()) {
      return workerRpc('NIP04_ENCRYPT', { peerPubkey, plaintext });
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
    signFollowEvent: (d) => signTyped('SIGN_FOLLOW', d),
    signInviteEvent: (d) => signTyped('SIGN_INVITE', d),
    signBlossomAuth: (d) => signTyped('SIGN_BLOSSOM_AUTH', d),
    signDatingEvent: (d) => signTyped('SIGN_DATING', d),
    signGameEvent: (d) => signTyped('SIGN_GAME', d),
    signLiveEvent: (d) => signTyped('SIGN_LIVE', d),
    signLiveTvEvent: (d) => signTyped('SIGN_LIVE_TV', d),
    signLoginMetric: (d) => signTyped('SIGN_LOGIN_METRIC', d),
    signMediaRecheck: (d) => signTyped('SIGN_MEDIA_RECHECK', d),
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

  App.SosCryptoSigner = api;
  root.SosCryptoSigner = api;

  try {
    console.log('[SOS-CRYPTO-SIGNER] F1/F2B facade loaded');
  } catch (_e) {}
})(typeof window !== 'undefined' ? window : globalThis);
