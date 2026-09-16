/* ============================================================================
   media-server-e2ee.js — M4 SERVER FALLBACK MEDIA E2EE GATE
   HYPER CORE TECH / SOS

   CRITICAL: This module does NOT select transport.
   It only wraps Blossom/server storage when EXISTING routing already chose Blossom.

   Gate OFF (default): call sites use legacy uploadToBlossom unchanged.
   Gate ON: call sites that would upload to Blossom use encrypted Blossom APIs.
   No plaintext Blossom when gate ON. Failures propagate to existing fallback controllers.
   ============================================================================ */

(function initMediaServerE2ee(global) {
  'use strict';

  const App = global.NostrApp || (global.NostrApp = {});
  const root = global;

  /**
   * Server-storage encryption gate only.
   * MUST NOT control P2P / Torrent / WebTorrent / inline / routing order.
   * Default OFF / absent.
   */
  function isMediaServerE2eeRequired() {
    try {
      if (root.__SOS_MEDIA_SERVER_E2EE_REQUIRED__ === true) return true;
      if (root.__SOS_MEDIA_SERVER_E2EE_REQUIRED__ === false) return false;
    } catch (_e) {}
    try {
      if (typeof localStorage !== 'undefined') {
        const v = localStorage.getItem('sos.mediaServerE2eeRequired');
        if (v === '1' || v === 'true') return true;
        if (v === '0' || v === 'false') return false;
      }
    } catch (_e2) {}
    return false;
  }

  App.isMediaServerE2eeRequired = isMediaServerE2eeRequired;
  App.mediaServerE2eeRequired = isMediaServerE2eeRequired;

  function ensureLogicalMessageId(explicitId) {
    if (typeof explicitId === 'string' && explicitId.trim()) return explicitId.trim();
    return (
      'cmsg-' +
      Date.now() +
      '-' +
      Math.random().toString(36).slice(2, 10)
    );
  }

  App.ensureLogicalMessageIdForMedia = ensureLogicalMessageId;

  function isEncryptedMediaAttachment(attachment) {
    if (typeof App.isEncryptedBlossomDescriptor === 'function') {
      return App.isEncryptedBlossomDescriptor(attachment);
    }
    return !!(
      attachment &&
      typeof attachment === 'object' &&
      attachment.type === 'encrypted-media' &&
      attachment.resource &&
      attachment.resource.transport === 'blossom'
    );
  }

  App.isEncryptedMediaAttachment = isEncryptedMediaAttachment;

  /**
   * Upload media for EXISTING Blossom fallback only.
   * When gate OFF → legacy uploadToBlossom (plaintext bytes as today).
   * When gate ON → encrypted Blossom; never silent plaintext downgrade.
   *
   * @returns {Promise<string|object>}
   *   gate OFF: legacy URL string (same as uploadToBlossom)
   *   gate ON: encrypted-media v2 descriptor (+ duration/clientMessageId helpers)
   */
  async function uploadMediaForServerFallback(blob, options) {
    const opts = options && typeof options === 'object' ? options : {};
    if (!blob) {
      const err = new Error('MEDIA_SERVER_E2EE_MISSING_BLOB');
      err.code = 'MEDIA_SERVER_E2EE_MISSING_BLOB';
      throw err;
    }

    if (!isMediaServerE2eeRequired()) {
      if (typeof App.uploadToBlossom !== 'function') {
        throw new Error('uploadToBlossom unavailable');
      }
      return App.uploadToBlossom(blob, opts.fileName || opts.filename || undefined);
    }

    if (typeof App.uploadEncryptedMediaToBlossom !== 'function') {
      const err = new Error('MEDIA_SERVER_E2EE_API_UNAVAILABLE');
      err.code = 'MEDIA_SERVER_E2EE_API_UNAVAILABLE';
      throw err;
    }

    const messageId = ensureLogicalMessageId(opts.messageId);
    const sender =
      (typeof opts.sender === 'string' && opts.sender) ||
      (typeof App.publicKey === 'string' && App.publicKey) ||
      '';
    const recipient =
      (typeof opts.recipient === 'string' && opts.recipient) || '';

    if (!sender || !recipient) {
      const err = new Error('MEDIA_SERVER_E2EE_MISSING_PARTIES');
      err.code = 'MEDIA_SERVER_E2EE_MISSING_PARTIES';
      throw err;
    }

    const uploadOpts = {
      blob,
      messageId,
      sender,
      recipient,
      mime:
        opts.mime ||
        opts.mimeType ||
        (blob && blob.type) ||
        'application/octet-stream',
      filename: opts.fileName || opts.filename || undefined,
      signal: opts.signal,
      onProgress: opts.onProgress,
      fetchImpl: opts.fetchImpl,
    };
    if (typeof opts.attachmentId === 'string' && /^[0-9a-f]{32}$/.test(opts.attachmentId)) {
      uploadOpts.attachmentId = opts.attachmentId;
    }
    if (opts.prepared) {
      // Retry path: reuse prepared ciphertext (no re-encrypt).
      if (typeof App.uploadPreparedEncryptedMediaToBlossom !== 'function') {
        const err = new Error('MEDIA_SERVER_E2EE_API_UNAVAILABLE');
        err.code = 'MEDIA_SERVER_E2EE_API_UNAVAILABLE';
        throw err;
      }
      const uploaded = await App.uploadPreparedEncryptedMediaToBlossom({
        encryptedBlob: opts.prepared.encryptedBlob,
        privateDescriptorDraft: opts.prepared.privateDescriptorDraft,
        signal: opts.signal,
        onProgress: opts.onProgress,
        fetchImpl: opts.fetchImpl,
      });
      const descriptor = uploaded.descriptor;
      if (typeof opts.duration === 'number' && Number.isFinite(opts.duration)) {
        descriptor.duration = opts.duration;
      }
      descriptor.clientMessageId = messageId;
      descriptor.logicalMessageId = messageId;
      return descriptor;
    }

    const uploaded = await App.uploadEncryptedMediaToBlossom(uploadOpts);
    const descriptor = uploaded && uploaded.descriptor ? uploaded.descriptor : uploaded;
    if (!descriptor || descriptor.type !== 'encrypted-media') {
      const err = new Error('MEDIA_SERVER_E2EE_BAD_UPLOAD_RESULT');
      err.code = 'MEDIA_SERVER_E2EE_BAD_UPLOAD_RESULT';
      throw err;
    }
    if (typeof opts.duration === 'number' && Number.isFinite(opts.duration)) {
      descriptor.duration = opts.duration;
    }
    descriptor.clientMessageId = messageId;
    descriptor.logicalMessageId = messageId;
    if (uploaded.prepared) {
      descriptor._prepared = uploaded.prepared;
    }
    return descriptor;
  }

  App.uploadMediaForServerFallback = uploadMediaForServerFallback;

  /**
   * Resolve encrypted Blossom attachment to a local Blob / object URL for render.
   * Legacy plaintext Blossom attachments are left unchanged.
   */
  async function resolveServerMediaAttachment(attachment, context) {
    if (!attachment || typeof attachment !== 'object') return null;
    if (!isEncryptedMediaAttachment(attachment)) return null;
    if (attachment._localObjectUrl && attachment._resolvedBlob) {
      return {
        blob: attachment._resolvedBlob,
        objectUrl: attachment._localObjectUrl,
        descriptor: attachment,
      };
    }

    if (typeof App.downloadEncryptedMediaFromBlossom !== 'function') {
      const err = new Error('MEDIA_SERVER_E2EE_DOWNLOAD_UNAVAILABLE');
      err.code = 'MEDIA_SERVER_E2EE_DOWNLOAD_UNAVAILABLE';
      throw err;
    }

    const ctx = context && typeof context === 'object' ? context : {};
    const result = await App.downloadEncryptedMediaFromBlossom({
      descriptor: attachment,
      messageId: ctx.messageId || attachment.clientMessageId || attachment.logicalMessageId,
      sender: ctx.sender,
      recipient: ctx.recipient,
    });

    const objectUrl = URL.createObjectURL(result.blob);
    try {
      if (attachment._localObjectUrl) URL.revokeObjectURL(attachment._localObjectUrl);
    } catch (_e) {}
    attachment._resolvedBlob = result.blob;
    attachment._localObjectUrl = objectUrl;
    // Session render helpers (not persisted on wire as plaintext server URL).
    attachment.url = objectUrl;
    if (result.blob && result.blob.type) {
      attachment._plainMime = result.blob.type;
    } else if (attachment.media && attachment.media.mime) {
      attachment._plainMime = attachment.media.mime;
    }
    if (attachment.media && attachment.media.filename && !attachment.name) {
      attachment.name = attachment.media.filename;
    }
    if (attachment.media && typeof attachment.media.originalSize === 'number') {
      attachment.size = attachment.media.originalSize;
    }
    if (/^audio\//i.test((result.blob && result.blob.type) || attachment._plainMime || '')) {
      attachment.dataUrl = objectUrl;
    }

    return {
      blob: result.blob,
      objectUrl,
      descriptor: attachment,
      plaintextHash: result.plaintextHash,
    };
  }

  App.resolveServerMediaAttachment = resolveServerMediaAttachment;

  /**
   * NIP-44 preflight for final E3B payload carrying encrypted Blossom descriptor.
   * Does not change transport selection — only blocks oversized secure descriptors.
   */
  function assertEncryptedBlossomFitsE3b(candidate) {
    if (typeof App.classifyAttachmentForE2eeRoute !== 'function') {
      return { ok: true, skipped: true };
    }
    const classification = App.classifyAttachmentForE2eeRoute(candidate);
    if (classification && classification.route === 'INLINE_E2EE_SAFE') {
      return { ok: true, classification };
    }
    const e = new Error('MEDIA_E2EE_DESCRIPTOR_TOO_LARGE');
    e.code = 'MEDIA_E2EE_DESCRIPTOR_TOO_LARGE';
    e.details = classification || null;
    throw e;
  }

  App.assertEncryptedBlossomFitsE3b = assertEncryptedBlossomFitsE3b;

  /** Effective MIME for UI classification (encrypted v2 uses media.mime until hydrated). */
  function getAttachmentPlainMime(attachment) {
    if (!attachment || typeof attachment !== 'object') return '';
    if (typeof attachment._plainMime === 'string' && attachment._plainMime) {
      return attachment._plainMime.toLowerCase();
    }
    if (attachment.type === 'encrypted-media' && attachment.media && typeof attachment.media.mime === 'string') {
      return attachment.media.mime.toLowerCase();
    }
    return typeof attachment.type === 'string' ? attachment.type.toLowerCase() : '';
  }

  App.getAttachmentPlainMime = getAttachmentPlainMime;
})(typeof window !== 'undefined' ? window : globalThis);
