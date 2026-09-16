;(function initMediaFileE2ee(root) {
  /**
   * M2 — Encrypted media blob core (AES-256-GCM).
   * Local crypto only. No network. No Blossom/P2P/WebTorrent/E3B routing activation.
   *
   * AAD correction vs M1 audit:
   * Ciphertext hash is NOT part of pre-encryption AAD (would be circular).
   * AAD binds protocol/version/messageId/sender/recipient/attachmentId/mode/chunkIndex/chunkCount.
   * Ciphertext SHA-256 is computed AFTER encryption and validated independently.
   */
  const App = root.NostrApp || (root.NostrApp = {});

  const MEDIA_E2EE_PROTOCOL = 'sos-media-e2ee';
  const MEDIA_E2EE_VERSION = 2;
  const MEDIA_E2EE_ALG = 'aes-256-gcm';
  const MEDIA_E2EE_TYPE = 'encrypted-media';
  const KEY_BYTES = 32;
  const NONCE_BYTES = 12;
  const ATTACHMENT_ID_BYTES = 16;
  const CHUNK_PLAINTEXT_SIZE = 64 * 1024; // reuse existing P2P 64 KiB pattern
  const MAX_MESSAGE_ID_CHARS = 256;
  const MAX_FILENAME_CHARS = 1024;
  const MAX_MIME_CHARS = 200;
  /** Verified against nostr-tools NIP-44 v2 (experimental boundary). */
  const NIP44_V2_MAX_PLAINTEXT_BYTES = 65535;
  /** Absolute reject ceiling for a single media encrypt job (memory safety). */
  const MAX_MEDIA_E2EE_BYTES = 2 * 1024 * 1024 * 1024;
  const MAX_CHUNKS = 40000;

  function mediaFail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    err.name = 'MediaFileE2eeError';
    throw err;
  }

  function getSubtle() {
    const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || (typeof root !== 'undefined' && root.crypto);
    if (!c || !c.subtle) mediaFail('MEDIA_E2EE_ENCRYPT_FAILED', 'WebCrypto subtle unavailable');
    return c.subtle;
  }

  function getRandomValues(out) {
    const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || (typeof root !== 'undefined' && root.crypto);
    if (!c || typeof c.getRandomValues !== 'function') {
      mediaFail('MEDIA_E2EE_ENCRYPT_FAILED', 'crypto.getRandomValues unavailable');
    }
    return c.getRandomValues(out);
  }

  function utf8Encode(str) {
    return new TextEncoder().encode(String(str));
  }

  function normalizeHexPubkey(value) {
    if (typeof value !== 'string') return null;
    const hex = value.trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(hex)) return null;
    return hex;
  }

  function requireHexPubkey(value, code) {
    const hex = normalizeHexPubkey(value);
    if (!hex) mediaFail(code || 'MEDIA_E2EE_BAD_CONTEXT', 'invalid hex-64 pubkey');
    return hex;
  }

  function assertMessageId(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_MESSAGE_ID_CHARS) {
      mediaFail('MEDIA_E2EE_BAD_CONTEXT', 'messageId must be non-empty bounded string');
    }
    // Allow SOS client ids (cmsg-...), event hex ids, and similar safe tokens.
    if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
      mediaFail('MEDIA_E2EE_BAD_CONTEXT', 'messageId has invalid characters');
    }
  }

  function assertAttachmentId(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) {
      mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'attachmentId must be 32 lowercase hex chars');
    }
  }

  function bytesToBase64Url(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let bin = '';
    for (let i = 0; i < u8.length; i += 1) bin += String.fromCharCode(u8[i]);
    const b64 =
      typeof btoa === 'function'
        ? btoa(bin)
        : Buffer.from(u8).toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlToBytes(value, expectedLen, code) {
    if (typeof value !== 'string' || !value) {
      mediaFail(code || 'MEDIA_E2EE_BAD_DESCRIPTOR', 'missing base64url');
    }
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      mediaFail(code || 'MEDIA_E2EE_BAD_DESCRIPTOR', 'invalid base64url alphabet');
    }
    const padLen = (4 - (value.length % 4)) % 4;
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
    let bin;
    try {
      bin =
        typeof atob === 'function'
          ? atob(b64)
          : Buffer.from(b64, 'base64').toString('binary');
    } catch (_err) {
      mediaFail(code || 'MEDIA_E2EE_BAD_DESCRIPTOR', 'malformed base64url');
    }
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    if (typeof expectedLen === 'number' && out.length !== expectedLen) {
      mediaFail(code || 'MEDIA_E2EE_BAD_DESCRIPTOR', 'decoded length mismatch');
    }
    return out;
  }

  function bytesToHex(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let out = '';
    for (let i = 0; i < u8.length; i += 1) {
      out += (u8[i] & 0xff).toString(16).padStart(2, '0');
    }
    return out;
  }

  function timingSafeEqualHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  async function sha256Hex(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const digest = await getSubtle().digest('SHA-256', u8);
    return bytesToHex(digest);
  }

  function generateMediaEncryptionKeyBytes() {
    const key = new Uint8Array(KEY_BYTES);
    getRandomValues(key);
    return key;
  }

  function generateNonceBytes() {
    const nonce = new Uint8Array(NONCE_BYTES);
    getRandomValues(nonce);
    return nonce;
  }

  function generateAttachmentId() {
    const id = new Uint8Array(ATTACHMENT_ID_BYTES);
    getRandomValues(id);
    return bytesToHex(id);
  }

  async function importAesGcmKey(rawKeyBytes, usages) {
    if (!(rawKeyBytes instanceof Uint8Array) || rawKeyBytes.length !== KEY_BYTES) {
      mediaFail('MEDIA_E2EE_BAD_KEY', 'key must be 32 bytes');
    }
    return getSubtle().importKey('raw', rawKeyBytes, { name: 'AES-GCM' }, false, usages);
  }

  /**
   * Canonical AAD (deterministic). Does NOT include ciphertext hash.
   * Same inputs → byte-for-byte identical UTF-8 AAD.
   */
  function buildMediaAad({
    messageId,
    sender,
    recipient,
    attachmentId,
    mode,
    chunkIndex,
    chunkCount,
  }) {
    assertMessageId(messageId);
    const senderHex = requireHexPubkey(sender, 'MEDIA_E2EE_BAD_CONTEXT');
    const recipientHex = requireHexPubkey(recipient, 'MEDIA_E2EE_BAD_CONTEXT');
    assertAttachmentId(attachmentId);
    if (mode !== 'single' && mode !== 'chunked') {
      mediaFail('MEDIA_E2EE_BAD_CONTEXT', 'mode must be single|chunked');
    }
    if (!Number.isInteger(chunkIndex) || chunkIndex < -1) {
      mediaFail('MEDIA_E2EE_BAD_CONTEXT', 'bad chunkIndex');
    }
    if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > MAX_CHUNKS) {
      mediaFail('MEDIA_E2EE_BAD_CONTEXT', 'bad chunkCount');
    }
    if (mode === 'single') {
      if (chunkIndex !== 0 || chunkCount !== 1) {
        mediaFail('MEDIA_E2EE_BAD_CONTEXT', 'single mode requires chunkIndex=0 chunkCount=1');
      }
    } else if (chunkIndex < 0 || chunkIndex >= chunkCount) {
      mediaFail('MEDIA_E2EE_BAD_CONTEXT', 'chunkIndex out of range');
    }
    // Fixed field order — never rely on object key iteration order.
    const lines = [
      MEDIA_E2EE_PROTOCOL + '-v' + MEDIA_E2EE_VERSION,
      'messageId=' + messageId,
      'sender=' + senderHex,
      'recipient=' + recipientHex,
      'attachmentId=' + attachmentId,
      'mode=' + mode,
      'chunkIndex=' + String(chunkIndex),
      'chunkCount=' + String(chunkCount),
    ];
    return utf8Encode(lines.join('\n'));
  }

  function sanitizeMediaMeta(media) {
    const out = {
      mime: '',
      filename: '',
      originalSize: 0,
    };
    if (!media || typeof media !== 'object' || Array.isArray(media)) return out;
    if (typeof media.mime === 'string') {
      const mime = media.mime.indexOf(';') >= 0 ? media.mime.split(';')[0].trim() : media.mime.trim();
      if (mime.length > MAX_MIME_CHARS) mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'mime too long');
      if (mime && !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime)) {
        mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'invalid mime');
      }
      out.mime = mime;
    }
    if (typeof media.filename === 'string') {
      if (media.filename.length > MAX_FILENAME_CHARS) {
        mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'filename too long');
      }
      // Strip path separators only; keep Unicode names inside private descriptor.
      out.filename = media.filename.replace(/[\\/]/g, '_');
    }
    if (media.originalSize != null) {
      if (
        typeof media.originalSize !== 'number' ||
        !Number.isFinite(media.originalSize) ||
        !Number.isInteger(media.originalSize) ||
        media.originalSize < 0
      ) {
        mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'bad originalSize');
      }
      out.originalSize = media.originalSize;
    }
    return out;
  }

  async function toUint8Array(input) {
    if (input == null) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
      const buf = await input.arrayBuffer();
      return new Uint8Array(buf);
    }
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    mediaFail('MEDIA_E2EE_ENCRYPT_FAILED', 'unsupported plaintext input type');
  }

  function checkAbort(signal) {
    if (signal && signal.aborted) mediaFail('MEDIA_E2EE_ABORTED', 'aborted');
  }

  function reportProgress(onProgress, processed, total) {
    if (typeof onProgress !== 'function') return;
    const safeTotal = typeof total === 'number' && total > 0 ? total : 0;
    const pct = safeTotal ? Math.min(100, Math.floor((processed / safeTotal) * 100)) : 0;
    try {
      onProgress({ bytesProcessed: processed, totalBytes: safeTotal, percent: pct });
    } catch (_err) {
      /* ignore progress callback errors */
    }
  }

  async function aesGcmEncrypt(rawKey, nonce, plaintext, aad) {
    if (!(nonce instanceof Uint8Array) || nonce.length !== NONCE_BYTES) {
      mediaFail('MEDIA_E2EE_BAD_NONCE', 'nonce must be 12 bytes');
    }
    const key = await importAesGcmKey(rawKey, ['encrypt']);
    try {
      const ct = await getSubtle().encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad },
        key,
        plaintext,
      );
      return new Uint8Array(ct);
    } catch (_err) {
      mediaFail('MEDIA_E2EE_ENCRYPT_FAILED', 'aes-gcm encrypt failed');
    }
  }

  async function aesGcmDecrypt(rawKey, nonce, ciphertext, aad) {
    if (!(nonce instanceof Uint8Array) || nonce.length !== NONCE_BYTES) {
      mediaFail('MEDIA_E2EE_BAD_NONCE', 'nonce must be 12 bytes');
    }
    if (!(ciphertext instanceof Uint8Array) || ciphertext.length < 16) {
      mediaFail('MEDIA_E2EE_DECRYPT_FAILED', 'ciphertext too short');
    }
    const key = await importAesGcmKey(rawKey, ['decrypt']);
    try {
      const pt = await getSubtle().decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad },
        key,
        ciphertext,
      );
      return new Uint8Array(pt);
    } catch (_err) {
      mediaFail('MEDIA_E2EE_AUTH_FAILED', 'aes-gcm decrypt/auth failed');
    }
  }

  function validateEncryptedMediaDescriptor(descriptor, options = {}) {
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
      mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'descriptor must be object');
    }
    if (descriptor.v !== MEDIA_E2EE_VERSION) {
      mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'unsupported descriptor version');
    }
    if (descriptor.type !== MEDIA_E2EE_TYPE) {
      mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'unsupported descriptor type');
    }
    assertAttachmentId(descriptor.attachmentId);
    const enc = descriptor.enc;
    if (!enc || typeof enc !== 'object' || Array.isArray(enc)) {
      mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'missing enc');
    }
    if (enc.alg !== MEDIA_E2EE_ALG) {
      mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'unsupported algorithm');
    }
    if (enc.mode !== 'single' && enc.mode !== 'chunked') {
      mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'unsupported mode');
    }
    const keyBytes = base64UrlToBytes(enc.key, KEY_BYTES, 'MEDIA_E2EE_BAD_KEY');
    const cipher = descriptor.cipher;
    if (!cipher || typeof cipher !== 'object' || Array.isArray(cipher)) {
      mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'missing cipher');
    }
    if (
      typeof cipher.size !== 'number' ||
      !Number.isFinite(cipher.size) ||
      !Number.isInteger(cipher.size) ||
      cipher.size < 0 ||
      cipher.size > MAX_MEDIA_E2EE_BYTES
    ) {
      mediaFail('MEDIA_E2EE_SIZE_MISMATCH', 'bad cipher.size');
    }
    if (typeof cipher.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(cipher.sha256)) {
      mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'bad cipher.sha256');
    }
    sanitizeMediaMeta(descriptor.media);

    if (enc.mode === 'single') {
      base64UrlToBytes(enc.nonce, NONCE_BYTES, 'MEDIA_E2EE_BAD_NONCE');
      if (descriptor.chunks != null) {
        mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'single mode must not include chunks');
      }
    } else {
      if (!Array.isArray(descriptor.chunks) || descriptor.chunks.length < 1) {
        mediaFail('MEDIA_E2EE_CHUNK_MISSING', 'chunked mode requires chunks');
      }
      if (descriptor.chunks.length > MAX_CHUNKS) {
        mediaFail('MEDIA_E2EE_TOO_LARGE', 'too many chunks');
      }
      if (
        typeof descriptor.chunkCount !== 'number' ||
        descriptor.chunkCount !== descriptor.chunks.length
      ) {
        mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'chunkCount mismatch');
      }
      const seen = new Set();
      for (let i = 0; i < descriptor.chunks.length; i += 1) {
        const ch = descriptor.chunks[i];
        if (!ch || typeof ch !== 'object') mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'bad chunk entry');
        if (!Number.isInteger(ch.index) || ch.index < 0 || ch.index >= descriptor.chunkCount) {
          mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'bad chunk index');
        }
        if (seen.has(ch.index)) mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'duplicate chunk index');
        seen.add(ch.index);
        base64UrlToBytes(ch.nonce, NONCE_BYTES, 'MEDIA_E2EE_BAD_NONCE');
        if (
          typeof ch.size !== 'number' ||
          !Number.isInteger(ch.size) ||
          ch.size < 16 ||
          ch.size > CHUNK_PLAINTEXT_SIZE + 32
        ) {
          mediaFail('MEDIA_E2EE_SIZE_MISMATCH', 'bad chunk size');
        }
        if (ch.sha256 != null && (typeof ch.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ch.sha256))) {
          mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'bad chunk sha256');
        }
      }
      for (let i = 0; i < descriptor.chunkCount; i += 1) {
        if (!seen.has(i)) mediaFail('MEDIA_E2EE_CHUNK_MISSING', 'missing chunk index');
      }
    }

    if (options.requireContext) {
      assertMessageId(options.messageId);
      requireHexPubkey(options.sender, 'MEDIA_E2EE_BAD_CONTEXT');
      requireHexPubkey(options.recipient, 'MEDIA_E2EE_BAD_CONTEXT');
    }

    return {
      ok: true,
      keyBytes,
      mode: enc.mode,
      attachmentId: descriptor.attachmentId,
    };
  }

  async function encryptMediaBlob(input, context = {}) {
    checkAbort(context.signal);
    const plaintext = await toUint8Array(input);
    if (plaintext.byteLength > MAX_MEDIA_E2EE_BYTES) {
      mediaFail('MEDIA_E2EE_TOO_LARGE', 'plaintext exceeds absolute limit');
    }
    assertMessageId(context.messageId);
    const sender = requireHexPubkey(context.sender, 'MEDIA_E2EE_BAD_CONTEXT');
    const recipient = requireHexPubkey(context.recipient, 'MEDIA_E2EE_BAD_CONTEXT');
    const attachmentId =
      typeof context.attachmentId === 'string' ? context.attachmentId : generateAttachmentId();
    assertAttachmentId(attachmentId);
    const media = sanitizeMediaMeta({
      mime: context.mime,
      filename: context.filename,
      originalSize: context.originalSize != null ? context.originalSize : plaintext.byteLength,
    });
    if (media.originalSize !== plaintext.byteLength) {
      // Keep caller-provided size only if it matches bytes being encrypted.
      media.originalSize = plaintext.byteLength;
    }

    const preferChunked =
      context.mode === 'chunked' ||
      (context.mode !== 'single' && plaintext.byteLength > CHUNK_PLAINTEXT_SIZE);

    const rawKey =
      context._testKeyBytes instanceof Uint8Array
        ? context._testKeyBytes
        : generateMediaEncryptionKeyBytes();
    if (rawKey.length !== KEY_BYTES) mediaFail('MEDIA_E2EE_BAD_KEY', 'injected key length');

    if (!preferChunked) {
      const nonce =
        context._testNonceBytes instanceof Uint8Array
          ? context._testNonceBytes
          : generateNonceBytes();
      const aad = buildMediaAad({
        messageId: context.messageId,
        sender,
        recipient,
        attachmentId,
        mode: 'single',
        chunkIndex: 0,
        chunkCount: 1,
      });
      const ciphertext = await aesGcmEncrypt(rawKey, nonce, plaintext, aad);
      const sha256 = await sha256Hex(ciphertext);
      reportProgress(context.onProgress, plaintext.byteLength, plaintext.byteLength);
      const descriptor = {
        v: MEDIA_E2EE_VERSION,
        type: MEDIA_E2EE_TYPE,
        attachmentId,
        enc: {
          alg: MEDIA_E2EE_ALG,
          mode: 'single',
          key: bytesToBase64Url(rawKey),
          nonce: bytesToBase64Url(nonce),
        },
        cipher: {
          size: ciphertext.byteLength,
          sha256,
        },
        media,
      };
      validateEncryptedMediaDescriptor(descriptor);
      return { ciphertext, descriptor, mode: 'single' };
    }

    // Chunked mode: one file key, unique random nonce per chunk.
    const chunkCount = Math.max(1, Math.ceil(plaintext.byteLength / CHUNK_PLAINTEXT_SIZE) || 1);
    if (chunkCount > MAX_CHUNKS) mediaFail('MEDIA_E2EE_TOO_LARGE', 'too many chunks');
    const chunkEntries = [];
    const cipherParts = [];
    let totalCipher = 0;
    for (let i = 0; i < chunkCount; i += 1) {
      checkAbort(context.signal);
      const start = i * CHUNK_PLAINTEXT_SIZE;
      const end = Math.min(plaintext.byteLength, start + CHUNK_PLAINTEXT_SIZE);
      const slice = plaintext.subarray(start, end);
      const nonce =
        Array.isArray(context._testChunkNonces) && context._testChunkNonces[i] instanceof Uint8Array
          ? context._testChunkNonces[i]
          : generateNonceBytes();
      const aad = buildMediaAad({
        messageId: context.messageId,
        sender,
        recipient,
        attachmentId,
        mode: 'chunked',
        chunkIndex: i,
        chunkCount,
      });
      const ct = await aesGcmEncrypt(rawKey, nonce, slice, aad);
      const chHash = await sha256Hex(ct);
      chunkEntries.push({
        index: i,
        nonce: bytesToBase64Url(nonce),
        size: ct.byteLength,
        sha256: chHash,
      });
      cipherParts.push(ct);
      totalCipher += ct.byteLength;
      reportProgress(context.onProgress, end, plaintext.byteLength);
    }
    const assembled = new Uint8Array(totalCipher);
    let offset = 0;
    for (let i = 0; i < cipherParts.length; i += 1) {
      assembled.set(cipherParts[i], offset);
      offset += cipherParts[i].byteLength;
    }
    const sha256 = await sha256Hex(assembled);
    const descriptor = {
      v: MEDIA_E2EE_VERSION,
      type: MEDIA_E2EE_TYPE,
      attachmentId,
      enc: {
        alg: MEDIA_E2EE_ALG,
        mode: 'chunked',
        key: bytesToBase64Url(rawKey),
      },
      cipher: {
        size: assembled.byteLength,
        sha256,
      },
      media,
      chunkPlaintextSize: CHUNK_PLAINTEXT_SIZE,
      chunkCount,
      chunks: chunkEntries,
    };
    validateEncryptedMediaDescriptor(descriptor);
    return {
      ciphertext: assembled,
      chunks: cipherParts.map((ct, index) => ({ index, ciphertext: ct })),
      descriptor,
      mode: 'chunked',
    };
  }

  async function decryptMediaBlob(ciphertextInput, descriptor, context = {}) {
    checkAbort(context.signal);
    const validated = validateEncryptedMediaDescriptor(descriptor, {
      requireContext: true,
      messageId: context.messageId,
      sender: context.sender,
      recipient: context.recipient,
    });
    if (descriptor.attachmentId !== context.attachmentId && context.attachmentId != null) {
      // If caller supplies attachmentId, it must match descriptor.
      if (typeof context.attachmentId === 'string' && context.attachmentId !== descriptor.attachmentId) {
        mediaFail('MEDIA_E2EE_BAD_CONTEXT', 'attachmentId mismatch');
      }
    }
    assertMessageId(context.messageId);
    const sender = requireHexPubkey(context.sender, 'MEDIA_E2EE_BAD_CONTEXT');
    const recipient = requireHexPubkey(context.recipient, 'MEDIA_E2EE_BAD_CONTEXT');
    const rawKey = validated.keyBytes;

    if (validated.mode === 'single') {
      const ciphertext = await toUint8Array(ciphertextInput);
      if (ciphertext.byteLength !== descriptor.cipher.size) {
        mediaFail('MEDIA_E2EE_SIZE_MISMATCH', 'ciphertext size mismatch');
      }
      const hash = await sha256Hex(ciphertext);
      if (!timingSafeEqualHex(hash, descriptor.cipher.sha256)) {
        mediaFail('MEDIA_E2EE_HASH_MISMATCH', 'ciphertext hash mismatch');
      }
      const nonce = base64UrlToBytes(descriptor.enc.nonce, NONCE_BYTES, 'MEDIA_E2EE_BAD_NONCE');
      const aad = buildMediaAad({
        messageId: context.messageId,
        sender,
        recipient,
        attachmentId: descriptor.attachmentId,
        mode: 'single',
        chunkIndex: 0,
        chunkCount: 1,
      });
      const plaintext = await aesGcmDecrypt(rawKey, nonce, ciphertext, aad);
      if (
        descriptor.media &&
        typeof descriptor.media.originalSize === 'number' &&
        descriptor.media.originalSize !== plaintext.byteLength
      ) {
        mediaFail('MEDIA_E2EE_SIZE_MISMATCH', 'plaintext size mismatch');
      }
      reportProgress(context.onProgress, plaintext.byteLength, plaintext.byteLength);
      return { plaintext, media: sanitizeMediaMeta(descriptor.media) };
    }

    // Chunked: accept assembled ciphertext OR explicit chunks array.
    let parts;
    if (Array.isArray(ciphertextInput)) {
      parts = ciphertextInput;
    } else if (ciphertextInput && Array.isArray(ciphertextInput.chunks)) {
      parts = ciphertextInput.chunks;
    } else {
      const assembled = await toUint8Array(ciphertextInput);
      if (assembled.byteLength !== descriptor.cipher.size) {
        mediaFail('MEDIA_E2EE_SIZE_MISMATCH', 'assembled ciphertext size mismatch');
      }
      const hash = await sha256Hex(assembled);
      if (!timingSafeEqualHex(hash, descriptor.cipher.sha256)) {
        mediaFail('MEDIA_E2EE_HASH_MISMATCH', 'ciphertext hash mismatch');
      }
      // Split by descriptor chunk sizes in index order.
      const ordered = descriptor.chunks.slice().sort((a, b) => a.index - b.index);
      parts = [];
      let off = 0;
      for (let i = 0; i < ordered.length; i += 1) {
        if (ordered[i].index !== i) mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'chunks not contiguous');
        const size = ordered[i].size;
        if (off + size > assembled.byteLength) mediaFail('MEDIA_E2EE_CHUNK_MISSING', 'truncated assembled');
        parts.push({ index: i, ciphertext: assembled.subarray(off, off + size) });
        off += size;
      }
      if (off !== assembled.byteLength) mediaFail('MEDIA_E2EE_SIZE_MISMATCH', 'assembled leftover bytes');
    }

    if (parts.length !== descriptor.chunkCount) {
      mediaFail('MEDIA_E2EE_CHUNK_MISSING', 'chunk count mismatch');
    }

    const byIndex = new Map();
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i];
      const idx = typeof p.index === 'number' ? p.index : i;
      if (byIndex.has(idx)) mediaFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'duplicate chunk');
      const ct = await toUint8Array(p.ciphertext != null ? p.ciphertext : p);
      byIndex.set(idx, ct);
    }

    const plainParts = [];
    let totalPlain = 0;
    for (let i = 0; i < descriptor.chunkCount; i += 1) {
      checkAbort(context.signal);
      if (!byIndex.has(i)) mediaFail('MEDIA_E2EE_CHUNK_MISSING', 'missing chunk');
      const meta = descriptor.chunks.find((c) => c.index === i);
      if (!meta) mediaFail('MEDIA_E2EE_CHUNK_MISSING', 'missing chunk meta');
      const ct = byIndex.get(i);
      if (ct.byteLength !== meta.size) mediaFail('MEDIA_E2EE_SIZE_MISMATCH', 'chunk size mismatch');
      if (meta.sha256) {
        const chHash = await sha256Hex(ct);
        if (!timingSafeEqualHex(chHash, meta.sha256)) {
          mediaFail('MEDIA_E2EE_HASH_MISMATCH', 'chunk hash mismatch');
        }
      }
      const nonce = base64UrlToBytes(meta.nonce, NONCE_BYTES, 'MEDIA_E2EE_BAD_NONCE');
      const aad = buildMediaAad({
        messageId: context.messageId,
        sender,
        recipient,
        attachmentId: descriptor.attachmentId,
        mode: 'chunked',
        chunkIndex: i,
        chunkCount: descriptor.chunkCount,
      });
      const pt = await aesGcmDecrypt(rawKey, nonce, ct, aad);
      plainParts.push(pt);
      totalPlain += pt.byteLength;
      reportProgress(context.onProgress, totalPlain, descriptor.media?.originalSize || totalPlain);
    }

    const plaintext = new Uint8Array(totalPlain);
    let o = 0;
    for (let i = 0; i < plainParts.length; i += 1) {
      plaintext.set(plainParts[i], o);
      o += plainParts[i].byteLength;
    }
    if (
      descriptor.media &&
      typeof descriptor.media.originalSize === 'number' &&
      descriptor.media.originalSize !== plaintext.byteLength
    ) {
      mediaFail('MEDIA_E2EE_SIZE_MISMATCH', 'plaintext size mismatch');
    }
    return { plaintext, media: sanitizeMediaMeta(descriptor.media) };
  }

  /**
   * Build the exact E3B inner payload JSON string shape used by chat-e2ee
   * (canonical field order) and measure UTF-8 byte length for NIP-44 preflight.
   * Does NOT call nip44.encrypt. Does NOT change live routing.
   */
  function buildCandidateE2eeInnerPlaintext({
    messageId,
    sender,
    recipient,
    createdAt,
    text,
    attachment,
  }) {
    assertMessageId(messageId);
    const senderHex = requireHexPubkey(sender, 'MEDIA_E2EE_BAD_CONTEXT');
    const recipientHex = requireHexPubkey(recipient, 'MEDIA_E2EE_BAD_CONTEXT');
    const payload = {
      v: 1,
      type: 'private-chat',
      messageId,
      sender: senderHex,
      recipient: recipientHex,
      createdAt: typeof createdAt === 'number' ? createdAt : Math.floor(Date.now() / 1000),
      text: text == null ? '' : String(text),
      attachment: attachment == null ? null : attachment,
    };
    return JSON.stringify(payload);
  }

  function utf8ByteLength(str) {
    return utf8Encode(str).byteLength;
  }

  /**
   * Classify whether a candidate E3B inner payload fits NIP-44 v2.
   * Returns INLINE_E2EE_SAFE | SECURE_BLOB_REQUIRED | REJECT_TOO_LARGE.
   * Never recommends plaintext Blossom/WebTorrent.
   */
  function classifyAttachmentForE2eeRoute(candidate) {
    const plaintext = buildCandidateE2eeInnerPlaintext(candidate || {});
    const bytes = utf8ByteLength(plaintext);
    const hasAttachment = candidate && candidate.attachment != null;
    let attachmentBytes = 0;
    if (hasAttachment && typeof candidate.attachment.size === 'number') {
      attachmentBytes = candidate.attachment.size;
    } else if (hasAttachment && typeof candidate.attachment.dataUrl === 'string') {
      // Rough estimate only for diagnostics — decision uses exact UTF-8 of full payload.
      attachmentBytes = Math.floor((candidate.attachment.dataUrl.length * 3) / 4);
    }

    if (attachmentBytes > MAX_MEDIA_E2EE_BYTES || bytes > MAX_MEDIA_E2EE_BYTES) {
      return {
        route: 'REJECT_TOO_LARGE',
        reason: 'MEDIA_E2EE_TOO_LARGE',
        utf8Bytes: bytes,
        nip44MaxPlaintextBytes: NIP44_V2_MAX_PLAINTEXT_BYTES,
      };
    }

    if (bytes <= NIP44_V2_MAX_PLAINTEXT_BYTES) {
      return {
        route: 'INLINE_E2EE_SAFE',
        reason: 'fits-nip44-v2',
        utf8Bytes: bytes,
        nip44MaxPlaintextBytes: NIP44_V2_MAX_PLAINTEXT_BYTES,
      };
    }

    return {
      route: 'SECURE_BLOB_REQUIRED',
      reason: 'exceeds-nip44-v2-plaintext',
      utf8Bytes: bytes,
      nip44MaxPlaintextBytes: NIP44_V2_MAX_PLAINTEXT_BYTES,
    };
  }

  function generateMediaEncryptionKeyExport() {
    const raw = generateMediaEncryptionKeyBytes();
    return { raw, base64url: bytesToBase64Url(raw) };
  }

  const api = {
    MEDIA_E2EE_PROTOCOL,
    MEDIA_E2EE_VERSION,
    MEDIA_E2EE_ALG,
    MEDIA_E2EE_TYPE,
    KEY_BYTES,
    NONCE_BYTES,
    CHUNK_PLAINTEXT_SIZE,
    NIP44_V2_MAX_PLAINTEXT_BYTES,
    MAX_MEDIA_E2EE_BYTES,
    generateMediaEncryptionKey: generateMediaEncryptionKeyExport,
    generateNonceBytes,
    generateAttachmentId,
    bytesToBase64Url,
    base64UrlToBytes,
    bytesToHex,
    sha256Hex,
    hashCiphertext: sha256Hex,
    buildMediaAad,
    encryptMediaBlob,
    decryptMediaBlob,
    validateEncryptedMediaDescriptor,
    buildCandidateE2eeInnerPlaintext,
    utf8ByteLength,
    classifyAttachmentForE2eeRoute,
  };

  Object.assign(App, {
    MediaFileE2ee: api,
    generateMediaEncryptionKey: api.generateMediaEncryptionKey,
    buildMediaAad: api.buildMediaAad,
    encryptMediaBlob: api.encryptMediaBlob,
    decryptMediaBlob: api.decryptMediaBlob,
    validateEncryptedMediaDescriptor: api.validateEncryptedMediaDescriptor,
    hashMediaCiphertext: api.hashCiphertext,
    classifyAttachmentForE2eeRoute: api.classifyAttachmentForE2eeRoute,
    MEDIA_E2EE_VERSION,
    NIP44_V2_MAX_PLAINTEXT_BYTES,
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.SosMediaFileE2ee = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
