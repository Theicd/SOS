;(function initChatE2ee(root) {
  // חלק E2EE (chat-e2ee.js) – מעטפת NIP-44; receive=dual-read; send=E3B כש-e2eeSendRequired | HYPER CORE TECH
  const App = root.NostrApp || (root.NostrApp = {});
  const NT = root.NostrTools;

  const E2EE_FAMILY = 'sos-e2ee';
  const E2EE_VERSION = 1;
  const E2EE_ALGORITHM = 'nip44';
  const E2EE_PAYLOAD_TYPE = 'private-chat';
  const MAX_MESSAGE_ID_CHARS = 256;
  const MAX_CHAT_TEXT_CHARS = 16000;
  // Structural timestamp bounds only (freshness is a future receive-path concern).
  const MIN_CREATED_AT = 1_000_000_000; // ~2001-09-09
  const MAX_FUTURE_SKEW_SEC = 172800; // 48h ahead of local clock

  /*
   * SOS_SECURE_CHAT_EPOCH (E3A3):
   * Local immutable integer = what THIS loaded JS can safely receive.
   * epoch 1 = understands sos-e2ee v1 dual-read (legacy plaintext + encrypted envelope).
   * Not derived from app-version.json string; not peer-claimed.
   * Remote minSecureChatEpoch (optional) may later require this epoch before chat.
   */
  const SOS_SECURE_CHAT_EPOCH = 1;

  // Future capability token — not published in E1.
  const E2EE_CAPABILITY_V1 = Object.freeze({
    supportsE2EEChatV1: true,
    family: E2EE_FAMILY,
    version: E2EE_VERSION,
    algorithm: E2EE_ALGORITHM,
  });

  /*
   * messageId strategy (E1):
   * CLIENT_MESSAGE_ID != OUTER_NOSTR_EVENT_ID
   * Outer event id is derived from signed content after encryption, so binding
   * messageId to event.id would be circular. Client generates an independent id.
   * Outer/inner binding in E1 helpers: sender + recipient only.
   *
   * Forward secrecy: NIP-44 v2 is static ECDH conversation-key encryption
   * (ChaCha20 + HMAC). It does NOT provide Signal-style ratcheting / PFS.
   * Compromise of the long-term Nostr private key allows decrypting past
   * conversation ciphertext for that identity on all devices that share it.
   */

  function e2eeFail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    err.name = 'ChatE2eeError';
    throw err;
  }

  function getHexToBytes() {
    if (typeof App.hexToBytes === 'function') return App.hexToBytes;
    const fromUtils = NT && NT.utils && typeof NT.utils.hexToBytes === 'function' ? NT.utils.hexToBytes : null;
    if (fromUtils) return fromUtils;
    return function fallbackHexToBytes(hex) {
      const clean = String(hex || '').startsWith('0x') ? String(hex).slice(2) : String(hex || '');
      if (clean.length % 2 !== 0) e2eeFail('BAD_PRIVATE_KEY', 'invalid hex length');
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < clean.length; i += 2) {
        const n = parseInt(clean.slice(i, i + 2), 16);
        if (!Number.isFinite(n)) e2eeFail('BAD_PRIVATE_KEY', 'non-hex private key');
        out[i / 2] = n;
      }
      return out;
    };
  }

  function normalizeHexPubkey(value) {
    if (typeof value !== 'string') return null;
    const hex = value.trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(hex)) return null;
    return hex;
  }

  function requireHexPubkey(value, code) {
    const hex = normalizeHexPubkey(value);
    if (!hex) e2eeFail(code || 'BAD_PUBKEY', 'invalid hex-64 pubkey');
    return hex;
  }

  function requirePrivateKeyBytes(hexKey) {
    if (typeof hexKey !== 'string' || !hexKey.trim()) {
      e2eeFail('BAD_PRIVATE_KEY', 'empty private key');
    }
    const clean = hexKey.trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(clean)) {
      e2eeFail('BAD_PRIVATE_KEY', 'private key must be 64 hex chars');
    }
    try {
      const bytes = getHexToBytes()(clean);
      const len = bytes && typeof bytes.length === 'number' ? bytes.length : 0;
      if (!bytes || len !== 32 || typeof bytes[0] !== 'number') {
        e2eeFail('BAD_PRIVATE_KEY', 'private key bytes invalid');
      }
      // Copy into a same-realm Uint8Array for noble/nip44 compatibility.
      const out = new Uint8Array(32);
      for (let i = 0; i < 32; i += 1) out[i] = bytes[i] & 0xff;
      return out;
    } catch (err) {
      if (err && err.code === 'BAD_PRIVATE_KEY') throw err;
      e2eeFail('BAD_PRIVATE_KEY', 'private key conversion failed');
    }
  }

  function getNip44() {
    const nip44 = NT && NT.nip44;
    if (!nip44 || !nip44.v2 || typeof nip44.v2.encrypt !== 'function' || typeof nip44.v2.decrypt !== 'function') {
      e2eeFail('NIP44_UNAVAILABLE', 'NostrTools.nip44.v2 missing');
    }
    const getConversationKey =
      (nip44.v2.utils && nip44.v2.utils.getConversationKey) || nip44.getConversationKey;
    if (typeof getConversationKey !== 'function') {
      e2eeFail('NIP44_UNAVAILABLE', 'getConversationKey missing');
    }
    return { encrypt: nip44.v2.encrypt.bind(nip44.v2), decrypt: nip44.v2.decrypt.bind(nip44.v2), getConversationKey };
  }

  function inspectAttachment(raw) {
    if (raw == null) return { ok: true };
    if (typeof App.inspectIncomingChatAttachment === 'function') {
      return App.inspectIncomingChatAttachment(raw);
    }
    if (typeof App.verifyIncomingChatAttachment === 'function') {
      return App.verifyIncomingChatAttachment(raw)
        ? { ok: true }
        : { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
    }
    e2eeFail('ATTACHMENT_VALIDATOR_UNAVAILABLE', 'inspectIncomingChatAttachment required');
  }

  function assertCreatedAt(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      e2eeFail('BAD_CREATED_AT', 'createdAt must be finite integer');
    }
    if (value < MIN_CREATED_AT) e2eeFail('BAD_CREATED_AT', 'createdAt too small');
    const nowSec = Math.floor(Date.now() / 1000);
    if (value > nowSec + MAX_FUTURE_SKEW_SEC) e2eeFail('BAD_CREATED_AT', 'createdAt too far in future');
  }

  function assertMessageId(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_MESSAGE_ID_CHARS) {
      e2eeFail('BAD_MESSAGE_ID', 'messageId must be non-empty bounded string');
    }
  }

  function assertText(value, attachment) {
    if (typeof value !== 'string') e2eeFail('BAD_TEXT', 'text must be string');
    if (value.length > MAX_CHAT_TEXT_CHARS) e2eeFail('OVERSIZED_TEXT', 'text exceeds limit');
    if (!value && attachment == null) {
      // Empty text without attachment is rejected (no content).
      e2eeFail('EMPTY_PAYLOAD', 'text empty and attachment null');
    }
  }

  function buildCanonicalPayloadV1(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      e2eeFail('BAD_PAYLOAD', 'payload must be plain object');
    }
    const sender = requireHexPubkey(input.sender, 'BAD_SENDER');
    const recipient = requireHexPubkey(input.recipient, 'BAD_RECIPIENT');
    assertMessageId(input.messageId);
    assertCreatedAt(input.createdAt);
    const attachment = input.attachment == null ? null : input.attachment;
    if (attachment != null) {
      const attCheck = inspectAttachment(attachment);
      if (!attCheck || !attCheck.ok) {
        e2eeFail('BAD_ATTACHMENT', (attCheck && attCheck.reasonCode) || 'INVALID_DESCRIPTOR');
      }
    }
    const text = input.text == null ? '' : input.text;
    assertText(text, attachment);
    const version = input.v != null ? input.v : input.version != null ? input.version : E2EE_VERSION;
    if (version !== E2EE_VERSION) e2eeFail('BAD_VERSION', 'unsupported inner version');
    const type = input.type != null ? input.type : E2EE_PAYLOAD_TYPE;
    if (type !== E2EE_PAYLOAD_TYPE) e2eeFail('BAD_TYPE', 'unsupported payload type');

    // Canonical field order for stable serialization.
    return {
      v: E2EE_VERSION,
      type: E2EE_PAYLOAD_TYPE,
      messageId: input.messageId,
      sender,
      recipient,
      createdAt: input.createdAt,
      text,
      attachment,
    };
  }

  function parseE2eeChatPayloadV1(raw) {
    let parsed;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch (_err) {
        e2eeFail('BAD_JSON', 'malformed decrypted JSON');
      }
    } else {
      parsed = raw;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      e2eeFail('BAD_SCHEMA', 'root must be plain object');
    }
    if (Object.prototype.hasOwnProperty.call(parsed, '__proto__') || Object.prototype.hasOwnProperty.call(parsed, 'constructor')) {
      // Reject prototype-pollution shaped keys if present as own props after parse (JSON.parse normally won't).
      e2eeFail('BAD_SCHEMA', 'dangerous keys');
    }
    const version = parsed.v != null ? parsed.v : parsed.version;
    if (version !== E2EE_VERSION) e2eeFail('UNKNOWN_VERSION', 'unsupported inner version');
    if (parsed.type !== E2EE_PAYLOAD_TYPE) e2eeFail('BAD_TYPE', 'unsupported payload type');
    const sender = requireHexPubkey(parsed.sender, 'BAD_SENDER');
    const recipient = requireHexPubkey(parsed.recipient, 'BAD_RECIPIENT');
    assertMessageId(parsed.messageId);
    assertCreatedAt(parsed.createdAt);
    if (typeof parsed.text !== 'string') e2eeFail('BAD_TEXT', 'text must be string');
    if (parsed.text.length > MAX_CHAT_TEXT_CHARS) e2eeFail('OVERSIZED_TEXT', 'text exceeds limit');
    let attachment = null;
    if (parsed.attachment != null) {
      if (typeof parsed.attachment !== 'object' || Array.isArray(parsed.attachment)) {
        e2eeFail('BAD_ATTACHMENT', 'attachment must be object or null');
      }
      const attCheck = inspectAttachment(parsed.attachment);
      if (!attCheck || !attCheck.ok) {
        e2eeFail('BAD_ATTACHMENT', (attCheck && attCheck.reasonCode) || 'INVALID_DESCRIPTOR');
      }
      attachment = parsed.attachment;
    }
    if (!parsed.text && attachment == null) e2eeFail('EMPTY_PAYLOAD', 'text empty and attachment null');
    return {
      v: E2EE_VERSION,
      type: E2EE_PAYLOAD_TYPE,
      messageId: parsed.messageId,
      sender,
      recipient,
      createdAt: parsed.createdAt,
      text: parsed.text,
      attachment,
    };
  }

  function parseEncryptedEnvelope(encryptedEnvelope) {
    let env = encryptedEnvelope;
    if (typeof env === 'string') {
      try {
        env = JSON.parse(env);
      } catch (_err) {
        e2eeFail('BAD_ENVELOPE', 'envelope must be object or JSON object string');
      }
    }
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
      e2eeFail('BAD_ENVELOPE', 'envelope must be plain object');
    }
    if (env.family !== E2EE_FAMILY) e2eeFail('UNKNOWN_FAMILY', 'unsupported envelope family');
    const version = env.v != null ? env.v : env.version;
    if (version !== E2EE_VERSION) e2eeFail('UNKNOWN_VERSION', 'unsupported envelope version');
    const algorithm = env.alg != null ? env.alg : env.algorithm;
    if (algorithm !== E2EE_ALGORITHM) e2eeFail('UNSUPPORTED_ALGORITHM', 'unsupported algorithm');
    const ciphertext = env.ct != null ? env.ct : env.ciphertext;
    if (typeof ciphertext !== 'string' || !ciphertext) {
      e2eeFail('BAD_CIPHERTEXT', 'ciphertext missing or wrong type');
    }
    return { family: E2EE_FAMILY, version: E2EE_VERSION, algorithm: E2EE_ALGORITHM, ciphertext };
  }

  function bindOuterInnerIdentities({ inner, eventAuthorPubkey, localPubkey }) {
    const sender = requireHexPubkey(inner && inner.sender, 'BAD_SENDER');
    const recipient = requireHexPubkey(inner && inner.recipient, 'BAD_RECIPIENT');
    const author = requireHexPubkey(eventAuthorPubkey, 'BAD_AUTHOR');
    const local = requireHexPubkey(localPubkey, 'BAD_LOCAL');
    if (sender !== author) e2eeFail('SENDER_MISMATCH', 'inner.sender must match outer event.pubkey');
    if (recipient !== local) e2eeFail('RECIPIENT_MISMATCH', 'inner.recipient must match local pubkey');
    return { sender, recipient, author, local };
  }

  function encryptPrivateChatPayload({
    senderPrivateKeyHex,
    senderPubkey,
    recipientPubkey,
    payload,
  }) {
    const sender = requireHexPubkey(senderPubkey, 'BAD_SENDER');
    const recipient = requireHexPubkey(recipientPubkey, 'BAD_RECIPIENT');
    const privBytes = requirePrivateKeyBytes(senderPrivateKeyHex);
    const canonical = buildCanonicalPayloadV1({
      ...payload,
      sender: payload && payload.sender != null ? payload.sender : sender,
      recipient: payload && payload.recipient != null ? payload.recipient : recipient,
    });
    if (canonical.sender !== sender) e2eeFail('SENDER_MISMATCH', 'payload.sender must match senderPubkey');
    if (canonical.recipient !== recipient) e2eeFail('RECIPIENT_MISMATCH', 'payload.recipient must match recipientPubkey');

    const plaintext = JSON.stringify(canonical);
    if (!plaintext || plaintext.length < 2) {
      e2eeFail('EMPTY_PLAINTEXT', 'serialized payload empty');
    }

    let ciphertext;
    try {
      const nip44 = getNip44();
      const conversationKey = nip44.getConversationKey(privBytes, recipient);
      ciphertext = nip44.encrypt(plaintext, conversationKey);
    } catch (err) {
      if (err && err.name === 'ChatE2eeError') throw err;
      e2eeFail('ENCRYPT_FAILURE', 'nip44 encrypt failed');
    }
    if (typeof ciphertext !== 'string' || !ciphertext) {
      e2eeFail('ENCRYPT_FAILURE', 'encrypt returned empty ciphertext');
    }
    // Never return plaintext fields on success envelope.
    return {
      family: E2EE_FAMILY,
      v: E2EE_VERSION,
      alg: E2EE_ALGORITHM,
      ct: ciphertext,
    };
  }

  function decryptPrivateChatPayload({
    localPrivateKeyHex,
    localPubkey,
    eventAuthorPubkey,
    encryptedEnvelope,
  }) {
    const local = requireHexPubkey(localPubkey, 'BAD_LOCAL');
    const author = requireHexPubkey(eventAuthorPubkey, 'BAD_AUTHOR');
    const privBytes = requirePrivateKeyBytes(localPrivateKeyHex);
    const env = parseEncryptedEnvelope(encryptedEnvelope);

    let decrypted;
    try {
      const nip44 = getNip44();
      const conversationKey = nip44.getConversationKey(privBytes, author);
      decrypted = nip44.decrypt(env.ciphertext, conversationKey);
    } catch (err) {
      if (err && err.name === 'ChatE2eeError') throw err;
      e2eeFail('DECRYPT_FAILURE', 'nip44 decrypt failed');
    }
    if (typeof decrypted !== 'string') {
      e2eeFail('DECRYPT_FAILURE', 'decrypt returned non-string');
    }

    const inner = parseE2eeChatPayloadV1(decrypted);
    bindOuterInnerIdentities({
      inner,
      eventAuthorPubkey: author,
      localPubkey: local,
    });
    return inner;
  }

  // NIP-44 v2 decodePayload rejects payload strings outside [132, 87472].
  const MAX_E2EE_CIPHERTEXT_CHARS = 87472;

  // Recognized family marker (may still be malformed). Fail closed — never legacy-fallback.
  function looksLikeSosE2eeEnvelope(value) {
    let obj = value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed || trimmed.charAt(0) !== '{') return false;
      try {
        obj = JSON.parse(trimmed);
      } catch (_err) {
        return false;
      }
    }
    return !!(obj && typeof obj === 'object' && !Array.isArray(obj) && obj.family === E2EE_FAMILY);
  }

  function isE2eeEnvelope(value) {
    try {
      parseEncryptedEnvelope(value);
      return true;
    } catch (_err) {
      return false;
    }
  }

  const api = {
    E2EE_FAMILY,
    E2EE_VERSION,
    E2EE_ALGORITHM,
    E2EE_PAYLOAD_TYPE,
    E2EE_CAPABILITY_V1,
    SOS_SECURE_CHAT_EPOCH,
    MAX_CHAT_TEXT_CHARS,
    MAX_MESSAGE_ID_CHARS,
    MAX_E2EE_CIPHERTEXT_CHARS,
    encryptPrivateChatPayload,
    decryptPrivateChatPayload,
    parseE2eeChatPayloadV1,
    parseEncryptedEnvelope,
    bindOuterInnerIdentities,
    buildCanonicalPayloadV1,
    isE2eeEnvelope,
    looksLikeSosE2eeEnvelope,
    normalizeHexPubkey,
  };

  Object.assign(App, {
    encryptPrivateChatPayload,
    decryptPrivateChatPayload,
    parseE2eeChatPayloadV1,
    parseEncryptedEnvelope,
    bindOuterInnerIdentities,
    isE2eeEnvelope,
    looksLikeSosE2eeEnvelope,
    E2EE_FAMILY,
    E2EE_VERSION,
    E2EE_ALGORITHM,
    E2EE_PAYLOAD_TYPE,
    E2EE_CAPABILITY_V1,
    SOS_SECURE_CHAT_EPOCH,
    MAX_E2EE_CIPHERTEXT_CHARS,
  });

  root.SosChatE2ee = api;
  return api;
})(typeof window !== 'undefined' ? window : globalThis);
