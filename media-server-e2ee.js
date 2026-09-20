/* ============================================================================
   media-server-e2ee.js — M4/M5 PRIVATE CHAT SERVER FALLBACK MEDIA E2EE
   HYPER CORE TECH / SOS

   CRITICAL:
   - Does NOT select transport (P2P / Torrent / inline unchanged).
   - Encrypts ONLY private-chat Blossom fallback via uploadMediaForServerFallback.
   - NEVER monkey-patches App.uploadToBlossom (public feed / mirror stay plaintext-capable).
   - Monotonic: once mediaServerE2eeRequired observed true, never plaintext chat Blossom again.
   ============================================================================ */

(function initMediaServerE2ee(global) {
  'use strict';

  const App = global.NostrApp || (global.NostrApp = {});
  const root = global;

  const SEEN_REQUIRED_KEY = 'sos_media_server_e2ee_required_seen';
  const QA_LOCAL_KEY = 'sos.mediaServerE2eeRequired';
  const APP_VERSION_URL = './app-version.json';

  const POLICY_STATES = Object.freeze({
    NOT_REQUIRED: 'NOT_REQUIRED',
    REQUIRED: 'REQUIRED',
    POLICY_UNAVAILABLE: 'POLICY_UNAVAILABLE',
  });

  let mediaServerE2eeRequiredKnown = false;

  function readSeenRequired() {
    if (mediaServerE2eeRequiredKnown) return true;
    try {
      const raw = root.localStorage && root.localStorage.getItem(SEEN_REQUIRED_KEY);
      if (raw === '1' || raw === 'true') {
        mediaServerE2eeRequiredKnown = true;
        return true;
      }
    } catch (_e) {}
    return false;
  }

  function writeSeenRequired(required) {
    if (!required) return readSeenRequired();
    mediaServerE2eeRequiredKnown = true;
    try {
      if (root.localStorage) root.localStorage.setItem(SEEN_REQUIRED_KEY, '1');
    } catch (_e) {}
    return true;
  }

  /** @returns {boolean|null} */
  function parseRemoteMediaServerE2eeRequired(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (!Object.prototype.hasOwnProperty.call(data, 'mediaServerE2eeRequired')) return null;
    const v = data.mediaServerE2eeRequired;
    if (v === true || v === 1 || v === '1' || v === 'true') return true;
    if (v === false || v === 0 || v === '0' || v === 'false') return false;
    return null;
  }

  function readQaOverride() {
    try {
      if (typeof App.__qaMediaServerE2eeRequiredOverride === 'boolean') {
        return App.__qaMediaServerE2eeRequiredOverride;
      }
    } catch (_e) {}
    try {
      if (root.__SOS_MEDIA_SERVER_E2EE_REQUIRED__ === true) return true;
      if (root.__SOS_MEDIA_SERVER_E2EE_REQUIRED__ === false) return false;
    } catch (_e2) {}
    try {
      if (typeof localStorage !== 'undefined') {
        const v = localStorage.getItem(QA_LOCAL_KEY);
        if (v === '1' || v === 'true') return true;
        if (v === '0' || v === 'false') return false;
      }
    } catch (_e3) {}
    return null;
  }

  /**
   * Sync view of sticky+QA gate (does not refresh remote).
   * Prefer resolveMediaServerE2eeDecision() before private-chat Blossom uploads.
   */
  function isMediaServerE2eeRequired() {
    if (readSeenRequired()) return true;
    const qa = readQaOverride();
    if (qa === true) return true;
    if (qa === false) return false;
    return false;
  }

  App.isMediaServerE2eeRequired = isMediaServerE2eeRequired;
  App.mediaServerE2eeRequired = isMediaServerE2eeRequired;

  /**
   * Production-ready monotonic policy for PRIVATE CHAT server fallback encryption only.
   * Does NOT force Blossom / disable P2P / change transport order.
   */
  async function refreshMediaServerE2eePolicy(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const seenBefore = readSeenRequired();

    // QA override wins for feature-branch tests (still sticky when true).
    const qa = readQaOverride();
    if (qa === true) {
      writeSeenRequired(true);
      return {
        state: POLICY_STATES.REQUIRED,
        required: true,
        fetchOk: true,
        remoteValue: true,
        source: 'qa-override',
      };
    }
    if (qa === false && !seenBefore) {
      return {
        state: POLICY_STATES.NOT_REQUIRED,
        required: false,
        fetchOk: true,
        remoteValue: false,
        source: 'qa-override',
      };
    }
    if (qa === false && seenBefore) {
      // Stale/false after true: stay REQUIRED (no plaintext downgrade).
      return {
        state: POLICY_STATES.REQUIRED,
        required: true,
        fetchOk: true,
        remoteValue: false,
        source: 'sticky-after-true',
      };
    }

    if (opts.skipFetch) {
      if (seenBefore) {
        return {
          state: POLICY_STATES.REQUIRED,
          required: true,
          fetchOk: false,
          remoteValue: null,
          source: 'sticky',
        };
      }
      return {
        state: POLICY_STATES.NOT_REQUIRED,
        required: false,
        fetchOk: false,
        remoteValue: null,
        source: 'default-off',
      };
    }

    let fetchOk = false;
    let remoteValue = null;
    try {
      const fetchFn =
        typeof opts.fetchImpl === 'function'
          ? opts.fetchImpl
          : typeof root.fetch === 'function'
            ? root.fetch.bind(root)
            : null;
      if (!fetchFn) throw new Error('no-fetch');
      const url = opts.url || APP_VERSION_URL;
      const res = await fetchFn(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        signal: opts.signal,
      });
      if (!res || !res.ok) throw new Error('http-' + String(res && res.status));
      const data = await res.json();
      fetchOk = true;
      remoteValue = parseRemoteMediaServerE2eeRequired(data);
      if (remoteValue === true) writeSeenRequired(true);
    } catch (_err) {
      fetchOk = false;
      remoteValue = null;
    }

    const required = readSeenRequired();
    if (required) {
      return {
        state: POLICY_STATES.REQUIRED,
        required: true,
        fetchOk,
        remoteValue,
        source: fetchOk && remoteValue === true ? 'remote' : 'sticky',
      };
    }
    if (fetchOk && remoteValue === false) {
      return {
        state: POLICY_STATES.NOT_REQUIRED,
        required: false,
        fetchOk: true,
        remoteValue: false,
        source: 'remote',
      };
    }
    if (fetchOk && remoteValue === null) {
      // Field absent: rollout-prep default OFF (not activated).
      return {
        state: POLICY_STATES.NOT_REQUIRED,
        required: false,
        fetchOk: true,
        remoteValue: null,
        source: 'absent',
      };
    }
    // Fetch failed, never seen true → preserve prep default (not required).
    return {
      state: POLICY_STATES.POLICY_UNAVAILABLE,
      required: false,
      fetchOk: false,
      remoteValue: null,
      source: 'unavailable-default-off',
    };
  }

  async function resolveMediaServerE2eeDecision(options) {
    const policy = await refreshMediaServerE2eePolicy(options);
    try {
      console.log(
        '[MEDIA/SERVER-E2EE] policy state=' +
          policy.state +
          ' required=' +
          String(!!policy.required) +
          ' fetchOk=' +
          String(!!policy.fetchOk) +
          ' remote=' +
          (policy.remoteValue === null ? 'absent' : String(policy.remoteValue)),
      );
    } catch (_e) {}
    return {
      ok: true,
      encrypt: policy.required === true,
      required: policy.required === true,
      state: policy.state,
      policy,
    };
  }

  App.refreshMediaServerE2eePolicy = refreshMediaServerE2eePolicy;
  App.resolveMediaServerE2eeDecision = resolveMediaServerE2eeDecision;
  App.MEDIA_SERVER_E2EE_POLICY_STATES = POLICY_STATES;

  /**
   * Interpret an already-resolved media-server E2EE decision for PRIVATE CHAT Blossom.
   * SECURE | LEGACY (explicit false only) | BLOCK (uncertainty — never plaintext).
   */
  function interpretPrivateChatBlossomPolicy(decision) {
    if (!decision || typeof decision !== 'object') {
      return { mode: 'BLOCK', reason: 'missing-decision', mustSecure: false, allowLegacyPlaintext: false };
    }
    const mustSecure = decision.required === true || decision.encrypt === true;
    if (mustSecure) {
      return {
        mode: 'SECURE',
        reason: 'required',
        mustSecure: true,
        allowLegacyPlaintext: false,
        decision,
      };
    }
    const pol = decision.policy || {};
    const allowLegacyPlaintext =
      decision.state === POLICY_STATES.NOT_REQUIRED &&
      pol.fetchOk === true &&
      pol.remoteValue === false;
    if (allowLegacyPlaintext) {
      return {
        mode: 'LEGACY',
        reason: 'authoritative-not-required',
        mustSecure: false,
        allowLegacyPlaintext: true,
        decision,
      };
    }
    return {
      mode: 'BLOCK',
      reason: 'policy-unavailable-or-uncertain',
      mustSecure: false,
      allowLegacyPlaintext: false,
      decision,
    };
  }

  App.interpretPrivateChatBlossomPolicy = interpretPrivateChatBlossomPolicy;

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
   * PRIVATE CHAT server fallback upload only.
   * Public feed / media-mirror MUST keep calling App.uploadToBlossom directly.
   */
  async function uploadMediaForServerFallback(blob, options) {
    const opts = options && typeof options === 'object' ? options : {};
    if (!blob) {
      const err = new Error('MEDIA_SERVER_E2EE_MISSING_BLOB');
      err.code = 'MEDIA_SERVER_E2EE_MISSING_BLOB';
      throw err;
    }

    // Always resolve before private-chat Blossom (stale-tab cutover safety).
    const decision = await resolveMediaServerE2eeDecision({
      signal: opts.signal,
      fetchImpl: opts.policyFetchImpl,
      url: opts.policyUrl,
      skipFetch: opts.skipPolicyFetch === true,
    });
    const mustEncrypt = decision.required === true;

    if (!mustEncrypt) {
      // Fail closed unless policy authoritatively says NOT required (explicit false).
      // POLICY_UNAVAILABLE / missing field / uncertainty → never plaintext private Blossom.
      const interpreted = interpretPrivateChatBlossomPolicy(decision);
      if (interpreted.mode !== 'LEGACY') {
        const err = new Error('MEDIA_SERVER_E2EE_POLICY_BLOCKED');
        err.code = 'MEDIA_SERVER_E2EE_POLICY_BLOCKED';
        err.details = {
          state: decision.state,
          mode: interpreted.mode,
          reason: interpreted.reason,
          fetchOk: decision.policy && decision.policy.fetchOk,
          remoteValue:
            decision.policy && Object.prototype.hasOwnProperty.call(decision.policy, 'remoteValue')
              ? decision.policy.remoteValue
              : null,
        };
        throw err;
      }
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

    const serverChunk =
      typeof App.SERVER_BLOB_CHUNK_PLAINTEXT_SIZE === 'number'
        ? App.SERVER_BLOB_CHUNK_PLAINTEXT_SIZE
        : 1 * 1024 * 1024;

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
      chunkPlaintextSize:
        opts.chunkPlaintextSize != null ? opts.chunkPlaintextSize : serverChunk,
      signal: opts.signal,
      onProgress: opts.onProgress,
      fetchImpl: opts.fetchImpl,
    };
    if (typeof opts.attachmentId === 'string' && /^[0-9a-f]{32}$/.test(opts.attachmentId)) {
      uploadOpts.attachmentId = opts.attachmentId;
    }
    if (opts.prepared) {
      if (typeof App.uploadPreparedEncryptedMediaToBlossom !== 'function') {
        const err = new Error('MEDIA_SERVER_E2EE_API_UNAVAILABLE');
        err.code = 'MEDIA_SERVER_E2EE_API_UNAVAILABLE';
        throw err;
      }
      const uploaded = await App.uploadPreparedEncryptedMediaToBlossom({
        encryptedBlob: opts.prepared.encryptedBlob,
        ciphertextBytes: opts.prepared.ciphertextBytes,
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

  function isPrivateChatMediaAttachmentType(mime, name) {
    const m = typeof mime === 'string' ? mime : '';
    if (/^(image|audio|video)\//i.test(m)) return true;
    return /\.(jpe?g|png|gif|webp|bmp|heic|mp4|m4v|mov|webm|mkv|avi|3gp|ogg|mp3|m4a|wav)$/i.test(
      String(name || ''),
    );
  }

  function isPrivateChatServerFileSupported(mime, name) {
    const m = String(mime || '').split(';')[0].trim().toLowerCase();
    const n = String(name || '').toLowerCase();
    if (m === 'text/html' || m === 'image/svg+xml' || /javascript|ecmascript/.test(m)) return false;
    if (isPrivateChatMediaAttachmentType(mime, name)) return true;
    if (
      m === 'text/plain' ||
      m === 'text/csv' ||
      m === 'text/rtf' ||
      m === 'text/log' ||
      m === 'application/rtf' ||
      m === 'application/pdf' ||
      m === 'application/msword' ||
      m === 'application/vnd.ms-excel' ||
      m === 'application/vnd.ms-powerpoint' ||
      m === 'application/zip' ||
      m === 'application/x-zip-compressed' ||
      m === 'application/x-rar-compressed' ||
      m === 'application/x-7z-compressed' ||
      m === 'application/octet-stream' ||
      m.startsWith('application/vnd.openxmlformats-officedocument.')
    ) {
      return true;
    }
    return /\.(txt|pdf|docx?|xlsx?|pptx?|csv|rtf|log|zip|rar|7z)$/i.test(n);
  }

  /**
   * Hotfix: legacy inline size may still exceed NIP-44 after dataURL/JSON/E3B wrapping.
   * Classify the exact candidate; never use ENCRYPT_FAILURE as flow control.
   * Media and allowed private-chat files → encrypted server fallback.
   * Disallowed types stay on the existing non-Blossom alternate.
   */
  async function resolveInlineAttachmentForE2ee(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const attachment =
      opts.attachment && typeof opts.attachment === 'object' ? { ...opts.attachment } : null;
    if (!attachment) {
      const err = new Error('MEDIA_E2EE_INLINE_MISSING_ATTACHMENT');
      err.code = 'MEDIA_E2EE_INLINE_MISSING_ATTACHMENT';
      throw err;
    }

    const messageId = ensureLogicalMessageId(
      opts.messageId || attachment.clientMessageId || attachment.logicalMessageId,
    );
    const sender =
      (typeof opts.sender === 'string' && opts.sender) ||
      (typeof App.publicKey === 'string' && App.publicKey) ||
      '';
    const recipient = (typeof opts.recipient === 'string' && opts.recipient) || '';
    const text = opts.text == null ? '' : String(opts.text);
    const createdAt =
      typeof opts.createdAt === 'number' ? opts.createdAt : Math.floor(Date.now() / 1000);

    attachment.clientMessageId = messageId;
    attachment.logicalMessageId = messageId;

    if (typeof App.classifyAttachmentForE2eeRoute !== 'function' || !sender || !recipient) {
      return {
        route: 'INLINE_E2EE_SAFE',
        reason: !sender || !recipient ? 'missing-parties' : 'classifier-unavailable',
        messageId,
        attachment,
        classification: null,
        secureUploadCalls: 0,
        plaintextBlossomCalls: 0,
      };
    }

    const candidate = {
      messageId,
      sender,
      recipient,
      createdAt,
      text,
      attachment,
    };
    const classification = App.classifyAttachmentForE2eeRoute(candidate);
    const route = classification && classification.route ? classification.route : 'INLINE_E2EE_SAFE';

    if (route === 'INLINE_E2EE_SAFE') {
      return {
        route,
        reason: (classification && classification.reason) || 'fits-nip44-v2',
        messageId,
        attachment,
        classification,
        secureUploadCalls: 0,
        plaintextBlossomCalls: 0,
      };
    }

    if (route === 'REJECT_TOO_LARGE') {
      const err = new Error('MEDIA_E2EE_TOO_LARGE');
      err.code = 'MEDIA_E2EE_TOO_LARGE';
      err.details = classification;
      throw err;
    }

    // SECURE_BLOB_REQUIRED
    const mime = attachment.type || opts.mimeType || opts.mime || '';
    const name = attachment.name || opts.fileName || opts.filename || '';
    const fileOk = isPrivateChatServerFileSupported(mime, name);
    if (!fileOk) {
      return {
        route: 'GENERIC_ALTERNATE_REQUIRED',
        reason: 'e2ee-inline-overflow-generic',
        messageId,
        attachment,
        classification,
        secureUploadCalls: 0,
        plaintextBlossomCalls: 0,
      };
    }

    if (typeof App.uploadMediaForServerFallback !== 'function') {
      const err = new Error('MEDIA_SERVER_E2EE_FALLBACK_UNAVAILABLE');
      err.code = 'MEDIA_SERVER_E2EE_FALLBACK_UNAVAILABLE';
      throw err;
    }

    const blob = opts.blob || opts.file || null;
    if (!blob) {
      const err = new Error('MEDIA_E2EE_INLINE_MISSING_BLOB');
      err.code = 'MEDIA_E2EE_INLINE_MISSING_BLOB';
      throw err;
    }

    // Never plaintext Blossom retry from this path — uploadMediaForServerFallback honors gate.
    const uploaded = await App.uploadMediaForServerFallback(blob, {
      messageId,
      sender,
      recipient,
      mimeType: mime,
      fileName: name,
      duration: typeof attachment.duration === 'number' ? attachment.duration : opts.duration,
      signal: opts.signal,
      skipPolicyFetch: opts.skipPolicyFetch === true,
      policyFetchImpl: opts.policyFetchImpl,
      fetchImpl: opts.fetchImpl,
    });

    if (uploaded && typeof uploaded === 'object' && uploaded.type === 'encrypted-media') {
      const descriptor = { ...uploaded };
      descriptor.id = descriptor.attachmentId || attachment.id || descriptor.id;
      descriptor.fileId = attachment.fileId || descriptor.id;
      descriptor.name =
        (descriptor.media && descriptor.media.filename) || name || descriptor.name;
      descriptor.size =
        descriptor.media && typeof descriptor.media.originalSize === 'number'
          ? descriptor.media.originalSize
          : attachment.size;
      if (attachment.caption != null) descriptor.caption = attachment.caption;
      if (attachment.hidePreview != null) descriptor.hidePreview = attachment.hidePreview;
      if (attachment.isVoice) descriptor.isVoice = true;
      if (attachment.isVideo) descriptor.isVideo = true;
      if (typeof attachment.duration === 'number') descriptor.duration = attachment.duration;
      if (attachment.previewUrl) descriptor.previewUrl = attachment.previewUrl;
      descriptor.clientMessageId = messageId;
      descriptor.logicalMessageId = messageId;
      // Drop inline plaintext payload — descriptor only on the wire.
      delete descriptor.dataUrl;
      return {
        route: 'SECURE_BLOB_REQUIRED',
        reason: (classification && classification.reason) || 'exceeds-nip44-v2-plaintext',
        messageId,
        attachment: descriptor,
        classification,
        secureUploadCalls: 1,
        plaintextBlossomCalls: 0,
      };
    }

    // Gate OFF may return a plain URL string. Callers must not treat that as success
    // under production mediaServerE2eeRequired=true; still never invent a second plaintext upload.
    if (typeof uploaded === 'string' && uploaded) {
      const urlAtt = {
        id: attachment.id || 'blossom-' + Date.now(),
        fileId: attachment.fileId || attachment.id,
        name,
        size: attachment.size,
        type: mime || 'application/octet-stream',
        url: uploaded,
        dataUrl: '',
        caption: attachment.caption,
        hidePreview: attachment.hidePreview !== false,
        clientMessageId: messageId,
        logicalMessageId: messageId,
      };
      if (typeof attachment.duration === 'number') urlAtt.duration = attachment.duration;
      return {
        route: 'SECURE_BLOB_REQUIRED',
        reason: 'server-fallback-gate-off-url',
        messageId,
        attachment: urlAtt,
        classification,
        secureUploadCalls: 1,
        plaintextBlossomCalls: 1,
      };
    }

    const err = new Error('MEDIA_SERVER_E2EE_FALLBACK_FAILED');
    err.code = 'MEDIA_SERVER_E2EE_FALLBACK_FAILED';
    throw err;
  }

  App.resolveInlineAttachmentForE2ee = resolveInlineAttachmentForE2ee;
  App.isPrivateChatMediaAttachmentType = isPrivateChatMediaAttachmentType;
  App.isPrivateChatServerFileSupported = isPrivateChatServerFileSupported;

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
