(function initBlossomClient(window){
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק העלאות (blossom.js) – לקוח Blossom קל משקל עם נפילות חן ורב-שרתים, נכתב עבור פרויקט SOS2
  // מבוסס רעיונית על yakbak/src/lib/blossom.ts אך מותאם JS פשוט וללא תלות חיצונית

  // חלק העלאות (blossom.js) – שרתי Blossom עם תמיכה ב-CORS
  // files.sovbit.host ירד לסוף — ERR_CERT_DATE_INVALID שובר אורחים | HYPER CORE TECH
  const DEFAULT_SERVERS = [
    { url: 'https://blossom.band', pubkey: 'npub1blossomserver' },
    { url: 'https://blossom.nostr.build', pubkey: 'npub1nostrbuild' },
    { url: 'https://nostr.build', pubkey: 'npub1nostrbuild' },
    { url: 'https://blossom.primal.net', pubkey: 'npub1primal' },
    { url: 'https://files.sovbit.host' }, // SSL שבור כרגע — רק fallback אחרון
  ];

  function fixUrl(u){
    return typeof u === 'string' && u.includes('/net/') ? u.replace('/net/', '.net/') : u;
  }

  function isSafeBlossomResultUrl(u){
    if (typeof u !== 'string' || !u.trim()) return false;
    try {
      const parsed = new URL(fixUrl(u.trim()));
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  }

  function isValidUrl(u){
    return isSafeBlossomResultUrl(u);
  }

  async function sha256Hex(blob){
    const buf = await blob.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');
  }

  // חלק העלאות (blossom.js) – יצירת ארוע הרשאה בסיסי (NIP-24242) באמצעות חותם קיים על האפליקציה
  async function createAuthEvent(verb, content, sha256){
    if(!App.publicKey || typeof App.finalizeEvent !== 'function'){
      throw new Error('missing-signer');
    }
    const now = Math.floor(Date.now()/1000);
    const tags = [['t', verb], ['expiration', String(now + 24*3600)]];
    if(sha256 && (verb === 'upload' || verb === 'delete')) tags.push(['x', sha256]);
    const draft = { kind: 24242, content, tags, created_at: now, pubkey: App.publicKey };
    return App.finalizeEvent(draft, App.privateKey);
  }

  async function getServers(){
    const fromApp = Array.isArray(App.blossomServers) ? App.blossomServers : [];
    const list = (fromApp.length ? fromApp : DEFAULT_SERVERS).map(s=>({ url: fixUrl(s.url), pubkey: s.pubkey||'' }))
      .filter(s=>isValidUrl(s.url));
    return list.length ? list : DEFAULT_SERVERS;
  }

  function diagUrl(u) {
    try {
      if (typeof App.diagSafeUrl === 'function') return App.diagSafeUrl(u);
      const parsed = new URL(String(u || ''));
      const last = (parsed.pathname.split('/').filter(Boolean).pop() || '').slice(0, 12);
      return parsed.hostname + (last ? '/' + last : '');
    } catch (_) {
      return '[url]';
    }
  }

  // חלק העלאות (blossom.js) – ניסיון העלאה לכמה שרתים עד הצלחה
  async function uploadToBlossom(blob){
    console.log('[BLOSSOM] uploadToBlossom called:', {
      blobType: blob?.type,
      blobSize: blob?.size,
      isBlob: blob instanceof Blob,
      isFile: blob instanceof File
    });
    
    // בדיקת תנאים מוקדמת
    if (!App.publicKey) {
      console.error('[BLOSSOM] ❌ חסר publicKey');
      throw new Error('missing-publicKey');
    }
    if (!App.privateKey) {
      console.error('[BLOSSOM] missing signer');
      throw new Error('missing-privateKey');
    }
    if (typeof App.finalizeEvent !== 'function') {
      console.error('[BLOSSOM] ❌ חסר finalizeEvent');
      throw new Error('missing-finalizeEvent');
    }
    
    const servers = await getServers();
    console.log('[BLOSSOM] servers:', servers.map(s => s.url));
    
    let hash;
    try {
      hash = await sha256Hex(blob);
      console.log('[BLOSSOM] hash:', hash.slice(0, 16) + '...');
    } catch (hashErr) {
      console.error('[BLOSSOM] ❌ שגיאה בחישוב hash:', hashErr);
      throw hashErr;
    }
    
    let auth;
    try {
      auth = await createAuthEvent('upload', 'Upload media file', hash);
      console.log('[BLOSSOM] auth event created');
    } catch (authErr) {
      console.error('[BLOSSOM] ❌ שגיאה ביצירת auth event:', authErr);
      throw authErr;
    }
    
    const header = 'Nostr ' + btoa(JSON.stringify(auth));
    const errors = [];
    
    console.log('[BLOSSOM] Starting upload:', {
      size: (blob.size / 1024 / 1024).toFixed(2) + 'MB',
      type: blob.type,
      hash: hash.slice(0, 16) + '...',
      servers: servers.length
    });

    for(const s of servers){
      // נסה נתיבי העלאה שונים לפי סוג השרת
      const uploadPaths = ['/upload', '/api/v1/upload', '/api/upload', '/media'];
      
      for(const path of uploadPaths){
        try{
          const url = new URL(path, s.url).toString();
          console.log('[BLOSSOM] Trying:', diagUrl(url));
          
          // ניסיון עם PUT ואז POST
          for (const method of ['PUT', 'POST']) {
            try {
              const res = await fetch(url, {
                method,
                body: blob,
                headers: {
                  'Content-Type': blob.type || 'application/octet-stream',
                  'Accept': 'application/json',
                  'Authorization': header,
                },
                mode: 'cors',
                credentials: 'omit',
              });
              
              if(!res.ok){
                await res.text().catch(() => '');
                console.log('[BLOSSOM] Failed:', method, res.status);
                continue;
              }
              
              const data = await res.json();
              console.log('[BLOSSOM] Response:', { ok: true, hasUrl: !!(data?.url || data?.data?.url) });
              
              // תמיכה בפורמטים שונים של תשובה
              const resultUrl = data?.url || data?.data?.url || data?.nip94_event?.tags?.find(t => t[0] === 'url')?.[1];
              if(resultUrl){
                if (!isSafeBlossomResultUrl(resultUrl)) {
                  console.warn('[SECURITY/PARSE_REJECT] kind=blossom reason=bad_result_url');
                  continue;
                }
                console.log('[BLOSSOM] Success! URL:', diagUrl(resultUrl));
                return fixUrl(resultUrl);
              }
            } catch(fetchErr) {
              errors.push(`${s.url}${path} ${method}: ${fetchErr.message}`);
            }
          }
        }catch(e){
          errors.push(`${s.url}: ${e.message}`);
        }
      }
    }
    
    console.error('[BLOSSOM] All servers failed:', errors);
    throw new Error('blossom-upload-failed');
  }

  // ---------------------------------------------------------------------------
  // M3 — Encrypted Blossom transport (ciphertext only). Legacy uploadToBlossom
  // above remains plaintext-capable and is intentionally UNCHANGED.
  // Secure APIs require media-file-e2ee.js (M2) to be loaded.
  // ---------------------------------------------------------------------------

  const SECURE_UPLOAD_CONTENT_TYPE = 'application/octet-stream';
  const MAX_SECURE_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

  function blossomSecureFail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    err.name = 'BlossomSecureError';
    throw err;
  }

  function requireMediaE2eeApi() {
    if (
      typeof App.encryptMediaBlob !== 'function' ||
      typeof App.decryptMediaBlob !== 'function' ||
      typeof App.validateEncryptedMediaDescriptor !== 'function' ||
      typeof App.hashMediaCiphertext !== 'function'
    ) {
      blossomSecureFail('MEDIA_E2EE_MODULE_UNAVAILABLE', 'media-file-e2ee.js required');
    }
  }

  function getFetch(fetchImpl) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (typeof f !== 'function') blossomSecureFail('BLOSSOM_FETCH_UNAVAILABLE', 'fetch unavailable');
    return f;
  }

  function reportSecureProgress(onProgress, phase, bytesProcessed, totalBytes) {
    if (typeof onProgress !== 'function') return;
    const total = typeof totalBytes === 'number' && totalBytes > 0 ? totalBytes : 0;
    const processed = typeof bytesProcessed === 'number' ? bytesProcessed : 0;
    const percent = total ? Math.min(100, Math.floor((processed / total) * 100)) : 0;
    try {
      onProgress({ phase: String(phase || ''), bytesProcessed: processed, totalBytes: total, percent });
    } catch (_err) { /* ignore */ }
  }

  function isEncryptedBlossomDescriptor(descriptor) {
    return !!(
      descriptor &&
      typeof descriptor === 'object' &&
      descriptor.v === 2 &&
      descriptor.type === 'encrypted-media' &&
      descriptor.resource &&
      descriptor.resource.transport === 'blossom' &&
      typeof descriptor.resource.url === 'string' &&
      descriptor.resource.url
    );
  }

  function classifyBlossomAttachment(attachment) {
    if (isEncryptedBlossomDescriptor(attachment)) return 'ENCRYPTED_BLOSSOM_V2';
    if (attachment && typeof attachment === 'object' && typeof attachment.url === 'string' && attachment.url) {
      return 'LEGACY_BLOSSOM';
    }
    return 'UNKNOWN';
  }

  function assertSafeSecureBlossomUrl(u) {
    if (!isSafeBlossomResultUrl(u)) {
      blossomSecureFail('BLOSSOM_BAD_URL', 'unsafe blossom url');
    }
    let parsed;
    try {
      parsed = new URL(fixUrl(String(u).trim()));
    } catch (_err) {
      blossomSecureFail('BLOSSOM_BAD_URL', 'malformed blossom url');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      blossomSecureFail('BLOSSOM_BAD_URL', 'non-http(s) blossom url');
    }
    // Reject obvious unsafe schemes that URL parser might normalize oddly.
    const lower = String(u).trim().toLowerCase();
    if (
      lower.startsWith('javascript:') ||
      lower.startsWith('data:') ||
      lower.startsWith('file:') ||
      lower.startsWith('blob:')
    ) {
      blossomSecureFail('BLOSSOM_BAD_URL', 'disallowed url scheme');
    }
    return fixUrl(parsed.toString());
  }

  function checkAbort(signal) {
    if (signal && signal.aborted) blossomSecureFail('MEDIA_E2EE_ABORTED', 'aborted');
  }

  /**
   * Prepare encrypted media locally (no network).
   * Returns ciphertext Blob + private descriptor draft WITHOUT resource URL.
   * Retry-safe: caller reuses this object for upload retries.
   */
  async function prepareEncryptedMediaForBlossom(options = {}) {
    requireMediaE2eeApi();
    checkAbort(options.signal);
    const blob = options.blob;
    if (!blob || (typeof Blob !== 'undefined' && !(blob instanceof Blob) && !(blob instanceof Uint8Array) && !(blob instanceof ArrayBuffer))) {
      // Allow Blob / File / Uint8Array / ArrayBuffer
      if (!(blob instanceof Uint8Array) && !(blob instanceof ArrayBuffer) && !(typeof Blob !== 'undefined' && blob instanceof Blob)) {
        blossomSecureFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'missing media blob');
      }
    }
    const messageId = options.messageId;
    const senderPubkey = options.senderPubkey || options.sender;
    const recipientPubkey = options.recipientPubkey || options.recipient;
    const filename = typeof options.filename === 'string' ? options.filename : '';
    const mime =
      typeof options.mime === 'string'
        ? options.mime
        : (blob && typeof blob.type === 'string' ? blob.type : '');

    reportSecureProgress(options.onProgress, 'encrypting', 0, blob && blob.size ? blob.size : 0);
    const enc = await App.encryptMediaBlob(blob, {
      messageId,
      sender: senderPubkey,
      recipient: recipientPubkey,
      filename,
      mime,
      mode: options.mode,
      attachmentId: options.attachmentId,
      // Optional: private-chat secure server-blob may pass 1 MiB; default remains 64 KiB.
      chunkPlaintextSize: options.chunkPlaintextSize,
      signal: options.signal,
      onProgress: (p) => reportSecureProgress(options.onProgress, 'encrypting', p.bytesProcessed, p.totalBytes),
    });

    const ciphertextBytes = enc.ciphertext;
    const encryptedBlob = new Blob([ciphertextBytes], { type: SECURE_UPLOAD_CONTENT_TYPE });
    // Opaque local name only — never original filename.
    try {
      if (typeof File !== 'undefined') {
        // Prefer File with opaque name when available (not sent as multipart filename by our PUT body).
      }
    } catch (_e) { /* ignore */ }

    const draft = Object.assign({}, enc.descriptor, {
      // resource filled after upload
    });
    delete draft.resource;

    reportSecureProgress(options.onProgress, 'encrypting', encryptedBlob.size, encryptedBlob.size);
    try {
      console.log(
        '[MEDIA/E2EE] encrypted size=' +
          encryptedBlob.size +
          ' mode=' +
          String(enc.mode || '') +
          ' hashPrefix=' +
          String(draft.cipher && draft.cipher.sha256 ? draft.cipher.sha256.slice(0, 8) : ''),
      );
    } catch (_logErr) { /* ignore */ }

    return {
      encryptedBlob,
      ciphertextBytes,
      privateDescriptorDraft: draft,
      ciphertextSha256: draft.cipher.sha256,
      cipherSize: draft.cipher.size,
      mode: enc.mode,
    };
  }

  /**
   * Upload already-prepared ciphertext. Auth x-tag = ciphertext SHA-256.
   * Content-Type forced to application/octet-stream.
   * Does NOT re-encrypt (retry-safe).
   */
  async function uploadPreparedEncryptedMediaToBlossom(options = {}) {
    requireMediaE2eeApi();
    checkAbort(options.signal);
    const draft = options.privateDescriptorDraft;
    const encryptedBlob = options.encryptedBlob;
    if (!draft || !encryptedBlob) {
      blossomSecureFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'missing prepared ciphertext');
    }
    App.validateEncryptedMediaDescriptor(draft);
    const cipherSha256 = String(draft.cipher && draft.cipher.sha256 || '');
    if (!/^[0-9a-f]{64}$/.test(cipherSha256)) {
      blossomSecureFail('MEDIA_E2EE_HASH_MISMATCH', 'missing ciphertext sha256');
    }
    if (typeof encryptedBlob.size === 'number' && encryptedBlob.size !== draft.cipher.size) {
      blossomSecureFail('MEDIA_E2EE_SIZE_MISMATCH', 'prepared blob size mismatch');
    }

    if (!App.publicKey || !App.privateKey || typeof App.finalizeEvent !== 'function') {
      blossomSecureFail('BLOSSOM_AUTH_UNAVAILABLE', 'missing signer');
    }

    const fetchFn = getFetch(options.fetchImpl);
    const servers = await getServers();
    // Auth MUST bind ciphertext hash (not plaintext).
    const auth = await createAuthEvent('upload', 'Upload encrypted media', cipherSha256);
    const header = 'Nostr ' + btoa(JSON.stringify(auth));
    const errors = [];

    try {
      console.log(
        '[MEDIA/BLOSSOM] upload ciphertext start size=' +
          encryptedBlob.size +
          ' hashPrefix=' +
          cipherSha256.slice(0, 8),
      );
    } catch (_e) { /* ignore */ }

    reportSecureProgress(options.onProgress, 'uploading', 0, encryptedBlob.size);

    for (const s of servers) {
      checkAbort(options.signal);
      const uploadPaths = ['/upload', '/api/v1/upload', '/api/upload', '/media'];
      for (const path of uploadPaths) {
        checkAbort(options.signal);
        try {
          const url = new URL(path, s.url).toString();
          for (const method of ['PUT', 'POST']) {
            checkAbort(options.signal);
            try {
              const res = await fetchFn(url, {
                method,
                body: encryptedBlob,
                headers: {
                  'Content-Type': SECURE_UPLOAD_CONTENT_TYPE,
                  Accept: 'application/json',
                  Authorization: header,
                },
                mode: 'cors',
                credentials: 'omit',
                signal: options.signal,
                redirect: 'error',
              });
              if (!res.ok) {
                await res.text().catch(() => '');
                errors.push(method + ' ' + path + ' status=' + res.status);
                continue;
              }
              let data;
              try {
                data = await res.json();
              } catch (_jsonErr) {
                errors.push(method + ' ' + path + ' bad-json');
                continue;
              }
              const resultUrl =
                data?.url ||
                data?.data?.url ||
                data?.nip94_event?.tags?.find((t) => Array.isArray(t) && t[0] === 'url')?.[1];
              if (!resultUrl) {
                errors.push(method + ' ' + path + ' missing-url');
                continue;
              }
              const safeUrl = assertSafeSecureBlossomUrl(resultUrl);
              reportSecureProgress(options.onProgress, 'uploading', encryptedBlob.size, encryptedBlob.size);

              let host = '';
              try {
                host = new URL(safeUrl).hostname;
              } catch (_h) { /* ignore */ }

              const finalDescriptor = Object.assign({}, draft, {
                resource: {
                  transport: 'blossom',
                  url: safeUrl,
                  host: host || undefined,
                },
              });
              App.validateEncryptedMediaDescriptor(finalDescriptor);

              try {
                console.log(
                  '[MEDIA/BLOSSOM] upload success hashPrefix=' +
                    cipherSha256.slice(0, 8) +
                    ' host=' +
                    (host || ''),
                );
              } catch (_logErr) { /* ignore */ }

              return {
                descriptor: finalDescriptor,
                url: safeUrl,
                ciphertextSha256: cipherSha256,
                authEvent: auth,
              };
            } catch (fetchErr) {
              if (fetchErr && fetchErr.code) throw fetchErr;
              if (options.signal && options.signal.aborted) {
                blossomSecureFail('MEDIA_E2EE_ABORTED', 'aborted');
              }
              errors.push(String((fetchErr && fetchErr.message) || fetchErr || 'fetch-failed'));
            }
          }
        } catch (e) {
          if (e && e.code) throw e;
          errors.push(String((e && e.message) || e || 'server-failed'));
        }
      }
    }

    blossomSecureFail('BLOSSOM_UPLOAD_FAILED', 'encrypted blossom upload failed');
  }

  /**
   * Encrypt then upload (convenience). For retries prefer prepare + uploadPrepared.
   */
  async function uploadEncryptedMediaToBlossom(options = {}) {
    const prepared = await prepareEncryptedMediaForBlossom(options);
    const uploaded = await uploadPreparedEncryptedMediaToBlossom({
      encryptedBlob: prepared.encryptedBlob,
      privateDescriptorDraft: prepared.privateDescriptorDraft,
      signal: options.signal,
      onProgress: options.onProgress,
      fetchImpl: options.fetchImpl,
    });
    return {
      descriptor: uploaded.descriptor,
      url: uploaded.url,
      ciphertextSha256: uploaded.ciphertextSha256,
      prepared,
      authEvent: uploaded.authEvent,
    };
  }

  async function downloadEncryptedMediaFromBlossom(options = {}) {
    requireMediaE2eeApi();
    checkAbort(options.signal);
    const descriptor = options.descriptor;
    if (!isEncryptedBlossomDescriptor(descriptor)) {
      blossomSecureFail('MEDIA_E2EE_BAD_DESCRIPTOR', 'not encrypted blossom v2 descriptor');
    }
    App.validateEncryptedMediaDescriptor(descriptor, {
      requireContext: true,
      messageId: options.messageId,
      sender: options.senderPubkey || options.sender,
      recipient: options.recipientPubkey || options.recipient,
    });

    const expectedSize = descriptor.cipher.size;
    const expectedHash = descriptor.cipher.sha256;
    if (
      typeof expectedSize !== 'number' ||
      !Number.isInteger(expectedSize) ||
      expectedSize < 0 ||
      expectedSize > MAX_SECURE_DOWNLOAD_BYTES
    ) {
      blossomSecureFail('MEDIA_E2EE_TOO_LARGE', 'unsafe cipher size claim');
    }

    const safeUrl = assertSafeSecureBlossomUrl(descriptor.resource.url);
    const fetchFn = getFetch(options.fetchImpl);
    reportSecureProgress(options.onProgress, 'downloading', 0, expectedSize);

    let res;
    try {
      res = await fetchFn(safeUrl, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        signal: options.signal,
        redirect: 'error',
        headers: { Accept: 'application/octet-stream,*/*' },
      });
    } catch (fetchErr) {
      if (options.signal && options.signal.aborted) blossomSecureFail('MEDIA_E2EE_ABORTED', 'aborted');
      blossomSecureFail('BLOSSOM_DOWNLOAD_FAILED', 'fetch failed');
    }
    if (!res || !res.ok) {
      blossomSecureFail('BLOSSOM_DOWNLOAD_FAILED', 'http status ' + String(res && res.status));
    }

    const contentLength = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
    if (contentLength != null && contentLength !== '') {
      const cl = Number(contentLength);
      if (Number.isFinite(cl) && (cl !== expectedSize || cl > MAX_SECURE_DOWNLOAD_BYTES)) {
        blossomSecureFail('MEDIA_E2EE_SIZE_MISMATCH', 'content-length mismatch');
      }
    }

    let buf;
    try {
      buf = await res.arrayBuffer();
    } catch (_err) {
      blossomSecureFail('BLOSSOM_DOWNLOAD_FAILED', 'body read failed');
    }
    const ciphertext = new Uint8Array(buf);
    if (ciphertext.byteLength !== expectedSize) {
      blossomSecureFail('MEDIA_E2EE_SIZE_MISMATCH', 'downloaded size mismatch');
    }
    reportSecureProgress(options.onProgress, 'downloading', ciphertext.byteLength, expectedSize);

    const hash = await App.hashMediaCiphertext(ciphertext);
    if (hash !== expectedHash) {
      blossomSecureFail('MEDIA_E2EE_HASH_MISMATCH', 'ciphertext hash mismatch');
    }

    reportSecureProgress(options.onProgress, 'decrypting', 0, descriptor.media?.originalSize || 0);
    const dec = await App.decryptMediaBlob(ciphertext, descriptor, {
      messageId: options.messageId,
      sender: options.senderPubkey || options.sender,
      recipient: options.recipientPubkey || options.recipient,
      attachmentId: descriptor.attachmentId,
      signal: options.signal,
      onProgress: (p) => reportSecureProgress(options.onProgress, 'decrypting', p.bytesProcessed, p.totalBytes),
    });

    const outMime =
      (dec.media && dec.media.mime) ||
      (descriptor.media && descriptor.media.mime) ||
      'application/octet-stream';
    const plaintextBlob = new Blob([dec.plaintext], { type: outMime });
    reportSecureProgress(
      options.onProgress,
      'decrypting',
      dec.plaintext.byteLength,
      dec.plaintext.byteLength,
    );
    return {
      blob: plaintextBlob,
      plaintext: dec.plaintext,
      media: dec.media,
      descriptor,
    };
  }

  /**
   * Best-effort delete of ciphertext object by SHA-256.
   * Not wired to chat delete. Failure does not compromise confidentiality.
   */
  async function deleteEncryptedMediaFromBlossom(options = {}) {
    checkAbort(options.signal);
    let cipherSha256 = '';
    if (options.descriptor && options.descriptor.cipher && options.descriptor.cipher.sha256) {
      cipherSha256 = String(options.descriptor.cipher.sha256);
    } else if (typeof options.ciphertextSha256 === 'string') {
      cipherSha256 = options.ciphertextSha256;
    }
    if (!/^[0-9a-f]{64}$/.test(cipherSha256)) {
      blossomSecureFail('MEDIA_E2EE_HASH_MISMATCH', 'missing ciphertext sha256 for delete');
    }
    if (!App.publicKey || !App.privateKey || typeof App.finalizeEvent !== 'function') {
      blossomSecureFail('BLOSSOM_AUTH_UNAVAILABLE', 'missing signer');
    }
    const fetchFn = getFetch(options.fetchImpl);
    const auth = await createAuthEvent('delete', 'Delete encrypted media', cipherSha256);
    const header = 'Nostr ' + btoa(JSON.stringify(auth));
    const servers = await getServers();
    const errors = [];

    for (const s of servers) {
      checkAbort(options.signal);
      const paths = ['/' + cipherSha256, '/media/' + cipherSha256, '/upload/' + cipherSha256];
      for (const path of paths) {
        try {
          const url = new URL(path, s.url).toString();
          const res = await fetchFn(url, {
            method: 'DELETE',
            headers: { Authorization: header, Accept: 'application/json' },
            mode: 'cors',
            credentials: 'omit',
            signal: options.signal,
            redirect: 'error',
          });
          if (res.ok || res.status === 404) {
            try {
              console.log('[MEDIA/BLOSSOM] delete ok hashPrefix=' + cipherSha256.slice(0, 8));
            } catch (_e) { /* ignore */ }
            return { ok: true, ciphertextSha256: cipherSha256, status: res.status };
          }
          errors.push(path + ' status=' + res.status);
        } catch (e) {
          if (options.signal && options.signal.aborted) blossomSecureFail('MEDIA_E2EE_ABORTED', 'aborted');
          errors.push(String((e && e.message) || e));
        }
      }
    }
    try {
      console.warn('[MEDIA/BLOSSOM] delete failed hashPrefix=' + cipherSha256.slice(0, 8));
    } catch (_e) { /* ignore */ }
    return { ok: false, ciphertextSha256: cipherSha256, errors };
  }

  Object.assign(App, {
    uploadToBlossom,
    getBlossomServers: getServers,
    prepareEncryptedMediaForBlossom,
    uploadPreparedEncryptedMediaToBlossom,
    uploadEncryptedMediaToBlossom,
    downloadEncryptedMediaFromBlossom,
    deleteEncryptedMediaFromBlossom,
    isEncryptedBlossomDescriptor,
    classifyBlossomAttachment,
  });
})(window);
