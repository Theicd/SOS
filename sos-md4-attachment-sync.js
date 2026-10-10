/**
 * MD4 S5 — encrypted historical attachment sync for linked desktop.
 * Reuses media-file-e2ee / Blossom / P2P hybrid + S4 hist-session AEAD bindings.
 * No root K/nsec. No new crypto hierarchy. No plaintext network transfer.
 */
(function initSosMd4AttachmentSync(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});
  const PROTOCOL = 'sos-history-attach-v1';
  const ATTACH_AAD_DOMAIN = 'SOS|hist|attach|aad|v1';
  const COLLECTION_ID = 'hist-attach-v1';
  const DB_NAME = 'SosMd4AttachCkptDB';
  const STORE = 'attachments';
  const MAX_CONCURRENT = 2;
  const MAX_RETRIES = 3;
  const MAX_CIPHER_BYTES = 100 * 1024 * 1024; // align with private-chat UI cap
  const MAX_FILENAME = 1024;
  const MAX_MIME = 200;

  const STATES = Object.freeze({
    PENDING: 'PENDING',
    TRANSFERRING: 'TRANSFERRING',
    VERIFIED: 'VERIFIED',
    COMPLETE: 'COMPLETE',
    MISSING: 'MISSING',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
    TOMBSTONED: 'TOMBSTONED',
  });

  function normHex(v) {
    return String(v || '')
      .toLowerCase()
      .replace(/^0x/, '')
      .trim();
  }
  function isHex64(v) {
    return /^[0-9a-f]{64}$/.test(normHex(v));
  }
  function isHex32(v) {
    return /^[0-9a-f]{32}$/.test(normHex(v));
  }
  async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  }
  function hexFromBuf(buf) {
    return Array.from(buf, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  function b64(buf) {
    let s = '';
    const a = new Uint8Array(buf);
    for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s);
  }
  function b64dec(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function jobKey(accountP, deviceId, attachmentId) {
    return normHex(accountP) + ':' + normHex(deviceId) + ':' + normHex(attachmentId);
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function sanitizeFilename(name) {
    const s = String(name || 'file').slice(0, MAX_FILENAME);
    if (/[\\/\0<>:"|?*]/.test(s) || s.includes('..')) return null;
    return s;
  }

  function sanitizeMime(mime) {
    const s = String(mime || '').toLowerCase().slice(0, MAX_MIME);
    if (!/^[a-z0-9][a-z0-9!#$&\-\^_.+]*\/[a-z0-9][a-z0-9!#$&\-\^_.+]*$/.test(s)) return null;
    return s;
  }

  function assertSafeUrl(url) {
    if (typeof url !== 'string' || !url) return { ok: false, code: 'BAD_URL' };
    let u;
    try {
      u = new URL(url);
    } catch (_e) {
      return { ok: false, code: 'BAD_URL' };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, code: 'BAD_URL_SCHEME' };
    // Block obvious SSRF targets.
    const host = (u.hostname || '').toLowerCase();
    // Allow desktop/emulator local test hosts; block cloud metadata + RFC1918/link-local.
    const allowLocalTest = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '10.0.2.2';
    if (!allowLocalTest) {
      if (
        host === '0.0.0.0' ||
        host.endsWith('.local') ||
        host === 'metadata.google.internal' ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
        /^169\.254\./.test(host)
      ) {
        return { ok: false, code: 'URL_SSRF_BLOCKED' };
      }
    }
    return { ok: true, url: u.toString() };
  }

  /** Domain-separated AAD for attachment control / cipher chunks (distinct from SYNC_ACK AAD). */
  async function attachAad(bind, sessionId, accountP, deviceId, authorizationId, authEpoch, attachmentId) {
    const enc = new TextEncoder();
    const parts = [
      enc.encode(ATTACH_AAD_DOMAIN),
      bind,
      enc.encode(normHex(sessionId)),
      enc.encode(normHex(accountP)),
      enc.encode(normHex(deviceId)),
      enc.encode(normHex(authorizationId)),
      enc.encode(String(authEpoch)),
      enc.encode(normHex(attachmentId || '')),
    ];
    let total = 0;
    parts.forEach((p) => {
      total += p.length;
    });
    const all = new Uint8Array(total);
    let o = 0;
    parts.forEach((p) => {
      all.set(p, o);
      o += p.length;
    });
    return sha256(all);
  }

  function isEncryptedMedia(att) {
    return !!(att && att.v === 2 && att.type === 'encrypted-media' && att.attachmentId && att.enc && att.cipher);
  }

  function tombstoned(eventId) {
    const id = normHex(eventId);
    return !!(App.deletedChatMessageIds && App.deletedChatMessageIds.has(id));
  }

  /**
   * Build a versioned attachment-sync job from an imported chat message + auth binding.
   * Descriptor keys stay in-memory on the message; durable job never stores media keys.
   */
  function buildJob({
    accountP,
    deviceId,
    authorizationId,
    authEpoch,
    sessionId,
    exportSessionId,
    peerP,
    eventId,
    messageId,
    sender,
    recipient,
    attachment,
    sourceHint,
  }) {
    if (!isHex64(accountP) || !isHex64(deviceId) || !isHex64(authorizationId)) {
      return { ok: false, code: 'BAD_AUTH_BIND' };
    }
    if (!isHex64(eventId) || !isHex64(peerP)) return { ok: false, code: 'BAD_EVENT_BIND' };
    if (tombstoned(eventId)) return { ok: false, code: 'TOMBSTONED' };
    if (!isEncryptedMedia(attachment)) return { ok: false, code: 'NOT_ENCRYPTED_MEDIA' };
    if (!isHex32(attachment.attachmentId)) return { ok: false, code: 'BAD_ATTACHMENT_ID' };

    const mime = sanitizeMime((attachment.media && attachment.media.mime) || attachment._plainMime || 'application/octet-stream');
    const filename = sanitizeFilename((attachment.media && attachment.media.filename) || attachment.name || 'file');
    if (!mime || !filename) return { ok: false, code: 'BAD_MEDIA_META' };

    const size = Number(attachment.cipher && attachment.cipher.size);
    if (!Number.isFinite(size) || size < 0 || size > MAX_CIPHER_BYTES) {
      return { ok: false, code: 'OVERSIZED_CIPHER' };
    }
    const sha = String((attachment.cipher && attachment.cipher.sha256) || '');
    if (!/^[0-9a-f]{64}$/.test(sha)) return { ok: false, code: 'BAD_CIPHER_HASH' };

    let availability = 'MISSING';
    let resourceUrl = '';
    if (sourceHint === 'LOCAL' || attachment.localOnly === true) {
      availability = 'LOCAL';
    } else if (attachment.resource && attachment.resource.transport === 'blossom' && attachment.resource.url) {
      const safe = assertSafeUrl(attachment.resource.url);
      if (!safe.ok) return { ok: false, code: safe.code };
      resourceUrl = safe.url;
      availability = 'BLOSSOM';
    } else if (attachment.p2p && attachment.p2p.magnetURI) {
      availability = 'P2P';
    }

    // Public durable record — never persist enc.key / conversation keys.
    const job = {
      v: 1,
      protocol: PROTOCOL,
      id: jobKey(accountP, deviceId, attachment.attachmentId),
      collectionId: COLLECTION_ID,
      accountP: normHex(accountP),
      deviceId: normHex(deviceId),
      authorizationId: normHex(authorizationId),
      authEpoch: Number(authEpoch),
      sessionId: normHex(sessionId || ''),
      exportSessionId: normHex(exportSessionId || ''),
      peerP: normHex(peerP),
      eventId: normHex(eventId),
      messageId: String(messageId || eventId),
      sender: normHex(sender),
      recipient: normHex(recipient),
      attachmentId: normHex(attachment.attachmentId),
      cipherSize: size,
      cipherSha256: sha,
      mime,
      filename,
      availability,
      resourceUrl,
      hasP2p: !!(attachment.p2p && attachment.p2p.magnetURI),
      state: STATES.PENDING,
      bytesReceived: 0,
      retries: 0,
      updatedAtMs: Date.now(),
      errorCode: '',
    };
    return { ok: true, job, attachment };
  }

  function validateJobBind(job, auth) {
    if (!job || job.v !== 1) return { ok: false, code: 'JOB_CORRUPT' };
    if (!auth) return { ok: false, code: 'NO_AUTH' };
    if (normHex(job.accountP) !== normHex(auth.accountP)) return { ok: false, code: 'WRONG_ACCOUNT' };
    if (normHex(job.deviceId) !== normHex(auth.deviceId)) return { ok: false, code: 'WRONG_DEVICE' };
    if (normHex(job.authorizationId) !== normHex(auth.authorizationId)) {
      return { ok: false, code: 'WRONG_AUTHORIZATION' };
    }
    if (Number(job.authEpoch) !== Number(auth.authEpoch)) return { ok: false, code: 'WRONG_AUTH_EPOCH' };
    const leak = JSON.stringify(job);
    if (leak.includes('conversationKey') || leak.includes('"nsec"') || /"enc"\s*:\s*\{[^}]*"key"/.test(leak)) {
      return { ok: false, code: 'JOB_LEAK' };
    }
    return { ok: true };
  }

  async function saveJob(job) {
    const db = await openDb();
    job.updatedAtMs = Date.now();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(job);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { ok: true, job };
  }

  async function loadJob(accountP, deviceId, attachmentId) {
    const db = await openDb();
    const id = jobKey(accountP, deviceId, attachmentId);
    const row = await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    db.close();
    if (!row) return { ok: false, code: 'NOT_FOUND' };
    return { ok: true, job: row };
  }

  async function listJobs(accountP, deviceId) {
    const db = await openDb();
    const prefix = normHex(accountP) + ':' + normHex(deviceId) + ':';
    const all = await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
    db.close();
    return all.filter((j) => j && String(j.id || '').startsWith(prefix));
  }

  function findMessageByEventId(eventId) {
    const nid = normHex(eventId);
    if (!App.chatState || !App.chatState.conversations) return null;
    let found = null;
    App.chatState.conversations.forEach((entry) => {
      if (found || !entry || !Array.isArray(entry.messages)) return;
      const hit = entry.messages.find((m) => m && normHex(m.id) === nid);
      if (hit) found = hit;
    });
    return found;
  }

  /**
   * Restore attachment onto message via existing media stack.
   * Completes only after AES-GCM decrypt + integrity (inside resolveServerMediaAttachment).
   */
  async function hydrateJob(job, liveAttachment) {
    if (tombstoned(job.eventId)) {
      job.state = STATES.TOMBSTONED;
      await saveJob(job);
      return { ok: false, code: 'TOMBSTONED' };
    }
    const msg = findMessageByEventId(job.eventId);
    if (!msg) {
      job.state = STATES.FAILED;
      job.errorCode = 'MESSAGE_MISSING';
      await saveJob(job);
      return { ok: false, code: 'MESSAGE_MISSING' };
    }
    const att = liveAttachment || msg.attachment;
    if (!isEncryptedMedia(att)) {
      job.state = STATES.FAILED;
      job.errorCode = 'DESCRIPTOR_MISSING';
      await saveJob(job);
      return { ok: false, code: 'DESCRIPTOR_MISSING' };
    }
    if (typeof App.resolveServerMediaAttachment !== 'function') {
      job.state = STATES.FAILED;
      job.errorCode = 'HYDRATE_UNAVAILABLE';
      await saveJob(job);
      return { ok: false, code: 'HYDRATE_UNAVAILABLE' };
    }

    job.state = STATES.TRANSFERRING;
    await saveJob(job);

    try {
      if (typeof App.inspectIncomingChatAttachment === 'function') {
        const insp = App.inspectIncomingChatAttachment(att, { network: true });
        if (!insp || !insp.ok) {
          job.state = STATES.FAILED;
          job.errorCode = (insp && insp.reasonCode) || 'INVALID_DESCRIPTOR';
          await saveJob(job);
          return { ok: false, code: job.errorCode };
        }
      }
      const resolved = await App.resolveServerMediaAttachment(att, {
        messageId: job.messageId,
        sender: job.sender,
        recipient: job.recipient,
      });
      if (!resolved || !resolved.blob || !resolved.objectUrl) {
        job.state = STATES.MISSING;
        job.errorCode = 'MISSING_CIPHERTEXT';
        await saveJob(job);
        msg.mediaSyncState = STATES.MISSING;
        return { ok: false, code: 'MISSING_CIPHERTEXT' };
      }
      // Authenticated decrypt already happened inside resolve path.
      job.state = STATES.COMPLETE;
      job.bytesReceived = job.cipherSize;
      job.errorCode = '';
      await saveJob(job);
      msg.attachment = att;
      msg.mediaSyncState = STATES.COMPLETE;
      msg.mediaSource = resolved.descriptor && resolved.descriptor._resolvedSource;
      if (typeof App.renderMessages === 'function') {
        try {
          App.renderMessages(job.peerP);
        } catch (_e) {}
      }
      return { ok: true, job, source: msg.mediaSource || 'blossom' };
    } catch (e) {
      const code = (e && e.code) || 'HYDRATE_FAIL';
      if (code === 'BLOSSOM_DOWNLOAD_FAILED' || code === 'MEDIA_SERVER_E2EE_DOWNLOAD_UNAVAILABLE') {
        job.state = STATES.MISSING;
      } else if (code === 'MEDIA_E2EE_AUTH_FAILED' || code === 'MEDIA_E2EE_HASH_MISMATCH') {
        job.state = STATES.FAILED;
      } else {
        job.state = STATES.FAILED;
      }
      job.errorCode = code;
      job.retries = (job.retries || 0) + 1;
      await saveJob(job);
      msg.mediaSyncState = job.state;
      return { ok: false, code };
    }
  }

  /**
   * Accept phone-pushed ciphertext for LOCAL availability (hist-session AEAD already opened).
   * Does not treat partial buffers as authenticated content.
   */
  async function acceptLocalCiphertext(job, cipherBytes, liveAttachment) {
    if (!job || !liveAttachment) return { ok: false, code: 'BAD_ARGS' };
    if (tombstoned(job.eventId)) {
      job.state = STATES.TOMBSTONED;
      await saveJob(job);
      return { ok: false, code: 'TOMBSTONED' };
    }
    if (!(cipherBytes instanceof Uint8Array) || cipherBytes.length !== job.cipherSize) {
      return { ok: false, code: 'SIZE_MISMATCH' };
    }
    if (typeof App.hashMediaCiphertext !== 'function' || typeof App.decryptMediaBlob !== 'function') {
      return { ok: false, code: 'MEDIA_API_MISSING' };
    }
    job.state = STATES.TRANSFERRING;
    job.bytesReceived = cipherBytes.length;
    await saveJob(job);

    const hash = await App.hashMediaCiphertext(cipherBytes);
    if (hash !== job.cipherSha256) {
      job.state = STATES.FAILED;
      job.errorCode = 'MEDIA_E2EE_HASH_MISMATCH';
      await saveJob(job);
      return { ok: false, code: 'MEDIA_E2EE_HASH_MISMATCH' };
    }
    try {
      const dec = await App.decryptMediaBlob(cipherBytes, liveAttachment, {
        messageId: job.messageId,
        sender: job.sender,
        recipient: job.recipient,
        attachmentId: job.attachmentId,
      });
      const mime = (dec.media && dec.media.mime) || job.mime;
      const blob = new Blob([dec.plaintext], { type: mime });
      const objectUrl = URL.createObjectURL(blob);
      liveAttachment._resolvedBlob = blob;
      liveAttachment._localObjectUrl = objectUrl;
      liveAttachment.url = objectUrl;
      liveAttachment._resolvedSource = 'local-hist';
      liveAttachment._plainMime = mime;
      const msg = findMessageByEventId(job.eventId);
      if (msg) {
        msg.attachment = liveAttachment;
        msg.mediaSyncState = STATES.COMPLETE;
        msg.mediaSource = 'local-hist';
      }
      job.state = STATES.COMPLETE;
      job.errorCode = '';
      await saveJob(job);
      return { ok: true, job, source: 'local-hist' };
    } catch (e) {
      job.state = STATES.FAILED;
      job.errorCode = (e && e.code) || 'DECRYPT_FAIL';
      await saveJob(job);
      return { ok: false, code: job.errorCode };
    }
  }

  /** Process pending jobs with bounded concurrency. Message OK + attachment MISSING is allowed. */
  async function processPending(auth, opts) {
    const o = opts || {};
    const jobs = await listJobs(auth.accountP, auth.deviceId);
    const pending = jobs.filter(
      (j) =>
        j &&
        (j.state === STATES.PENDING || j.state === STATES.FAILED) &&
        (j.retries || 0) < MAX_RETRIES &&
        j.state !== STATES.TOMBSTONED,
    );
    const limit = Math.min(o.maxConcurrent || MAX_CONCURRENT, MAX_CONCURRENT);
    let i = 0;
    const results = [];
    async function worker() {
      while (i < pending.length) {
        const idx = i++;
        const job = pending[idx];
        const bind = validateJobBind(job, auth);
        if (!bind.ok) {
          results.push({ attachmentId: job.attachmentId, ok: false, code: bind.code });
          continue;
        }
        if (tombstoned(job.eventId)) {
          job.state = STATES.TOMBSTONED;
          await saveJob(job);
          results.push({ attachmentId: job.attachmentId, ok: false, code: 'TOMBSTONED' });
          continue;
        }
        const msg = findMessageByEventId(job.eventId);
        const att = msg && msg.attachment;
        if (job.availability === 'LOCAL' && !(att && att._localCipherB64)) {
          // Wait for phone local transfer.
          results.push({ attachmentId: job.attachmentId, ok: false, code: 'AWAIT_LOCAL' });
          continue;
        }
        if (att && att._localCipherB64) {
          const bytes = b64dec(att._localCipherB64);
          delete att._localCipherB64;
          results.push(Object.assign({ attachmentId: job.attachmentId }, await acceptLocalCiphertext(job, bytes, att)));
          continue;
        }
        results.push(Object.assign({ attachmentId: job.attachmentId }, await hydrateJob(job, att)));
      }
    }
    const workers = [];
    for (let w = 0; w < limit; w++) workers.push(worker());
    await Promise.all(workers);
    return {
      ok: true,
      processed: results.length,
      complete: results.filter((r) => r.ok).length,
      missing: results.filter((r) => r.code === 'MISSING_CIPHERTEXT' || r.code === 'AWAIT_LOCAL').length,
      failed: results.filter((r) => !r.ok && r.code !== 'MISSING_CIPHERTEXT' && r.code !== 'AWAIT_LOCAL').length,
      results,
    };
  }

  async function enqueueFromImport(ctx) {
    const built = buildJob(ctx);
    if (!built.ok) return built;
    const existing = await loadJob(ctx.accountP, ctx.deviceId, built.job.attachmentId);
    if (existing.ok && existing.job.state === STATES.COMPLETE) {
      return { ok: true, job: existing.job, duplicate: true };
    }
    await saveJob(built.job);
    const msg = findMessageByEventId(built.job.eventId);
    if (msg) {
      msg.attachment = built.attachment;
      msg.logicalMessageId = built.job.messageId;
      msg.mediaSyncState = STATES.PENDING;
    }
    return { ok: true, job: built.job, attachment: built.attachment };
  }

  const api = Object.freeze({
    PROTOCOL,
    ATTACH_AAD_DOMAIN,
    COLLECTION_ID,
    STATES,
    MAX_CONCURRENT,
    MAX_CIPHER_BYTES,
    attachAad,
    buildJob,
    validateJobBind,
    assertSafeUrl,
    sanitizeFilename,
    sanitizeMime,
    saveJob,
    loadJob,
    listJobs,
    hydrateJob,
    acceptLocalCiphertext,
    processPending,
    enqueueFromImport,
    isEncryptedMedia,
    jobKey,
  });
  App.Md4AttachmentSync = api;
  window.SosMd4AttachmentSync = api;
})(window);
