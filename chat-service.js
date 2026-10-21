/* __F2B_AWAIT_WRAPPED__ */
  // חלק קאש תמונות (chat-service.js) – שמירת תמונות פרופיל ב-localStorage כ-DataURL כדי להימנע ממשיכות חוזרות | HYPER CORE TECH
  function avatarCacheKey(url) {
    return url ? `avatar_cache_${btoa(url)}` : null;
  }

  async function fetchAvatarAsDataUrl(url) {
    if (!url) return '';
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) return '';
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result || '');
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (err) {
      console.warn('avatar fetch failed', err);
      return '';
    }
  }

  async function getCachedAvatar(url) {
    const key = avatarCacheKey(url);
    if (!key) return '';
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return '';
      const parsed = JSON.parse(raw);
      const nowSec = Math.floor(Date.now() / 1000);
      if (!parsed?.dataUrl || !parsed?.ts || (nowSec - parsed.ts) > AVATAR_CACHE_TTL_SECONDS) {
        return '';
      }
      return parsed.dataUrl;
    } catch (_e) {
      return '';
    }
  }

  // חלק ניקוי קאש (chat-service.js) – מנקה ערכי קאש אווטר ישנים כשנגמר המקום | HYPER CORE TECH
  function cleanupOldAvatarCache() {
    try {
      const keysToRemove = [];
      const nowSec = Math.floor(Date.now() / 1000);
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('avatar_cache_')) {
          try {
            const raw = localStorage.getItem(key);
            const parsed = raw ? JSON.parse(raw) : null;
            // מסיר קאש ישן מ-24 שעות או פריטים פגומים
            if (!parsed?.ts || (nowSec - parsed.ts) > 86400) {
              keysToRemove.push(key);
            }
          } catch {
            keysToRemove.push(key);
          }
        }
      }
      keysToRemove.forEach(k => { try { localStorage.removeItem(k); } catch {} });
      return keysToRemove.length;
    } catch { return 0; }
  }

  async function cacheAvatar(url) {
    const key = avatarCacheKey(url);
    if (!key) return '';
    const cached = await getCachedAvatar(url);
    if (cached) return cached;
    const dataUrl = await fetchAvatarAsDataUrl(url);
    if (dataUrl) {
      try {
        window.localStorage.setItem(key, JSON.stringify({ dataUrl, ts: Math.floor(Date.now() / 1000) }));
      } catch (err) {
        // חלק טיפול בשגיאות (chat-service.js) – ניקוי קאש ישן כשנגמר המקום | HYPER CORE TECH
        if (err.name === 'QuotaExceededError') {
          const cleaned = cleanupOldAvatarCache();
          console.log('Avatar cache cleanup removed', cleaned, 'old entries');
          // נסיון נוסף אחרי הניקוי
          try {
            window.localStorage.setItem(key, JSON.stringify({ dataUrl, ts: Math.floor(Date.now() / 1000) }));
          } catch {
            // אם עדיין נכשל, פשוט נחזיר את ה-URL המקורי
          }
        }
      }
    }
    return dataUrl || url;
  }

(function initChatService(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  try { console.log('[CHAT/PERSIST] MODULE chat-service.js v=20260905p1'); } catch (_) {}

  // חלק צ'אט (chat-service.js) – קבועים לזיהוי אירועי שיחה
  const CHAT_KIND = 1050;
  const CHAT_TAG = 'yalachat';
  const CONTACT_FETCH_LIMIT = 20;
  const PROFILE_TTL_SECONDS = 86400; // חלק צ'אט (chat-service.js) – TTL לפרופילים/תמונות כדי לצמצם פניות לריליי | HYPER CORE TECH
  const AVATAR_CACHE_TTL_SECONDS = 86400; // חלק צ'אט (chat-service.js) – TTL לקאש תמונות פרופיל | HYPER CORE TECH
  const TORRENT_AUTOSTART_MAX_AGE_SECONDS = 90; // חלק טורנט (chat-service.js) – auto-start רק להודעות חדשות מאוד, לא להיסטוריה ישנה | HYPER CORE TECH
  const CHAT_RETENTION_SECONDS = 90 * 24 * 60 * 60; // חלק צ'אט (chat-service.js) – לא מושכים/מקבלים היסטוריה מעל 90 יום | HYPER CORE TECH
  const DC_PREFER_WAIT_MS = 2600; // חלק P2P (chat-service.js) – חלון להעדפת DataChannel לפני relay; 1.2s היו קצרים מדי כש-ICE/סיגנלינג עדיין נסגרים
  const MAX_CHAT_EVENT_CONTENT_CHARS = 512 * 1024;
  const MAX_CHAT_TEXT_CHARS = 16000;
  const MAX_CHAT_JSON_DEPTH = 8;
  const MAX_CHAT_JSON_KEYS = 48;
  const MAX_CHAT_JSON_ARRAY = 64;
  const MAX_ATTACH_NAME_CHARS = 1024;
  const MAX_ATTACH_URL_CHARS = 4096;
  const MAX_ATTACH_DATAURL_CHARS = 400 * 1024;
  const MAX_ATTACH_MAGNET_CHARS = 4096;
  const MAX_ATTACH_MIME_CHARS = 200;
  const MAX_ATTACH_ID_CHARS = 256;
  const MAX_ATTACH_DURATION_SEC = 172800;
  const MAX_ATTACH_FILE_SIZE = 50 * 1024 * 1024 * 1024;
  const MAX_DELETE_E_TAGS = 64;
  const CHAT_INGRESS_WINDOW_MS = 10000;
  const CHAT_INGRESS_MAX_PER_PEER = 120;
  const RECEIPT_INGRESS_WINDOW_MS = 10000;
  const RECEIPT_INGRESS_MAX_PER_PEER = 40;
  const INGRESS_PEER_BUCKET_CAP = 400;
  const chatIngressBuckets = new Map();
  const receiptIngressBuckets = new Map();

  function allowIngressBucket(map, peer, windowMs, maxCount) {
    const k = String(peer || '').toLowerCase() || '_';
    const now = Date.now();
    let row = map.get(k);
    if (!row || now - row.start >= windowMs) {
      row = { start: now, count: 0 };
      map.set(k, row);
    }
    row.count += 1;
    if (map.size > INGRESS_PEER_BUCKET_CAP) {
      const keys = [...map.keys()];
      for (let i = 0; i < Math.floor(keys.length / 2); i += 1) map.delete(keys[i]);
    }
    return row.count <= maxCount;
  }

  function getChatRetentionFloorTs(nowSec = Math.floor(Date.now() / 1000)) {
    if (typeof App.getChatRetentionCutoffTs === 'function') {
      return App.getChatRetentionCutoffTs(nowSec);
    }
    return nowSec - CHAT_RETENTION_SECONDS;
  }

  function incomingJsonWithinLimits(value, depth) {
    if (depth > MAX_CHAT_JSON_DEPTH) return false;
    if (value == null) return true;
    const valueType = typeof value;
    if (valueType === 'string') return value.length <= MAX_CHAT_EVENT_CONTENT_CHARS;
    if (valueType === 'number' || valueType === 'boolean') return true;
    if (valueType !== 'object') return false;
    if (Array.isArray(value)) {
      if (value.length > MAX_CHAT_JSON_ARRAY) return false;
      for (let i = 0; i < value.length; i++) {
        if (!incomingJsonWithinLimits(value[i], depth + 1)) return false;
      }
      return true;
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_CHAT_JSON_KEYS) return false;
    for (let i = 0; i < keys.length; i++) {
      if (!incomingJsonWithinLimits(value[keys[i]], depth + 1)) return false;
    }
    return true;
  }

  function sanitizeIncomingChatFileName(name) {
    let value = String(name == null ? '' : name);
    value = value.replace(/[\u0000-\u001f\u007f]/g, '');
    value = value.replace(/\\/g, '/');
    const parts = value.split('/').filter((part) => part && part !== '.' && part !== '..');
    value = parts.length ? parts[parts.length - 1] : 'file';
    if (!value || value === '.' || value === '..') value = 'file';
    if (value.length > 180) {
      const lastDot = value.lastIndexOf('.');
      const ext = lastDot > 0 && (value.length - lastDot) <= 8 ? value.slice(lastDot) : '';
      value = value.slice(0, Math.max(8, 180 - ext.length)) + ext;
    }
    return value;
  }

  function isValidIncomingMagnetURI(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_ATTACH_MAGNET_CHARS) return false;
    const trimmed = value.trim();
    if (!/^magnet:\?/i.test(trimmed)) return false;
    return /[?&]xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})(?:&|$)/i.test(trimmed);
  }

  // p2p v1 = the same sos-media-e2ee v2 ciphertext as resource, seeded over WebTorrent. Exact shape only.
  function isValidIncomingEncryptedP2pMarker(p2p) {
    if (!p2p || typeof p2p !== 'object' || Array.isArray(p2p)) return false;
    const keys = Object.keys(p2p);
    if (keys.length !== 4) return false;
    return (
      p2p.v === 1 &&
      p2p.transport === 'webtorrent' &&
      p2p.content === 'sos-media-e2ee-v2-ciphertext' &&
      isValidIncomingMagnetURI(p2p.magnetURI)
    );
  }

  function isSafeIncomingChatResource(value) {
    if (value == null || value === '') return true;
    if (typeof value !== 'string' || value.length > MAX_ATTACH_DATAURL_CHARS) return false;
    const trimmed = value.trim();
    const lower = trimmed.toLowerCase();
    if (/^(javascript|vbscript|file|about):/i.test(lower) || /[\u0000-\u001f]/.test(trimmed.slice(0, 32))) {
      return false;
    }
    if (lower.startsWith('magnet:')) return isValidIncomingMagnetURI(trimmed);
    if (lower.startsWith('https:') || lower.startsWith('http:') || lower.startsWith('blob:')) {
      if (trimmed.length > MAX_ATTACH_URL_CHARS) return false;
      try {
        const parsed = new URL(trimmed);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'blob:';
      } catch (_err) {
        return false;
      }
    }
    if (lower.startsWith('data:')) {
      if (/data:.*(?:javascript|vbscript|text\/html|image\/svg)/i.test(lower)) return false;
      return /^data:(image\/(?!svg)[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|application\/(pdf|octet-stream|ogg))(;|,)/i.test(trimmed);
    }
    return false;
  }

  function canonicalChatMimeType(type) {
    if (typeof type !== 'string' || !type) return '';
    return type.split(';')[0].trim();
  }

  function inferAudioMimeFromFileName(name) {
    const n = String(name || '').toLowerCase();
    if (n.endsWith('.ogg') || n.endsWith('.opus') || n.endsWith('.oga')) return 'audio/ogg';
    if (n.endsWith('.m4a') || n.endsWith('.mp4') || n.endsWith('.m4b')) return 'audio/mp4';
    if (n.endsWith('.mp3') || n.endsWith('.mpeg')) return 'audio/mpeg';
    return 'audio/webm';
  }

  function looksLikeLegacyVoiceDescriptor(raw) {
    const name = String(raw && raw.name || '').toLowerCase();
    if (name.includes('voice') || name.includes('ptt') || name.includes('voicemessage')) return true;
    return /\.(webm|ogg|oga|opus|m4a|mp3|aac)$/i.test(name);
  }

  function logAttachmentRejected(raw, reasonCode, eventId) {
    const keys = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw).slice(0, 24) : [];
    const mime = raw && typeof raw.type === 'string' ? String(raw.type).slice(0, 80) : '';
    console.warn(
      '[SO-CALL SECURITY] ATTACHMENT_REJECTED' +
        ' eventId=' + (eventId ? String(eventId).slice(0, 64) : '') +
        ' attachmentType=' + canonicalChatMimeType(mime) +
        ' mime=' + mime +
        ' descriptorKeys=' + keys.join(',') +
        ' reasonCode=' + String(reasonCode || 'INVALID_DESCRIPTOR'),
    );
  }

  // Wire MIME is essence-only. MediaRecorder `audio/webm; codecs=opus` is normalized, not rejected. | HYPER CORE TECH
  function normalizeIncomingChatAttachmentSchema(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    if (typeof raw.type === 'string' && raw.type) {
      const essence = canonicalChatMimeType(raw.type);
      if (essence && essence !== raw.type) raw.type = essence;
      const token = String(raw.type || '').toLowerCase();
      if ((token === 'file' || token === 'application/octet-stream') && looksLikeLegacyVoiceDescriptor(raw)) {
        raw.type = inferAudioMimeFromFileName(raw.name);
      }
    }
  }

  function inspectIncomingChatAttachment(raw, options) {
    if (raw == null) return { ok: true };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
    }
    if (Object.keys(raw).length > 24) {
      return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
    }
    // M4: encrypted Blossom v2 — accept via media validator; do not treat type as MIME.
    if (
      raw.type === 'encrypted-media' ||
      (typeof App.isEncryptedBlossomDescriptor === 'function' && App.isEncryptedBlossomDescriptor(raw))
    ) {
      try {
        if (typeof App.validateEncryptedMediaDescriptor === 'function') {
          App.validateEncryptedMediaDescriptor(raw);
        } else if (typeof App.isEncryptedBlossomDescriptor === 'function' && !App.isEncryptedBlossomDescriptor(raw)) {
          return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
        }
        if (raw.duration != null && (typeof raw.duration !== 'number' || !Number.isFinite(raw.duration) || raw.duration < 0 || raw.duration > MAX_ATTACH_DURATION_SEC)) {
          return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
        }
        if (raw.p2p != null && !isValidIncomingEncryptedP2pMarker(raw.p2p)) {
          return { ok: false, reasonCode: 'VOICE_P2P_BAD_METADATA' };
        }
        if (options && options.network === true) {
          // Local-only cache/state fields are never taken from a received descriptor.
          Object.keys(raw).forEach((k) => {
            if (k === 'cacheKey' || k === 'fileId' || k.charAt(0) === '_') delete raw[k];
          });
        }
        return { ok: true, encryptedBlossom: true };
      } catch (_valErr) {
        return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
      }
    }
    normalizeIncomingChatAttachmentSchema(raw);
    if (raw.name != null && (typeof raw.name !== 'string' || raw.name.length > MAX_ATTACH_NAME_CHARS)) {
      return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
    }
    if (raw.type != null && raw.type !== '') {
      if (typeof raw.type !== 'string' || raw.type.length > MAX_ATTACH_MIME_CHARS) {
        return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
      }
      const essence = canonicalChatMimeType(raw.type);
      if (!essence) {
        return { ok: false, reasonCode: 'MISSING_MIME' };
      }
      if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(essence)) {
        const token = essence.toLowerCase();
        if (token === 'file' || token === 'application/octet-stream') {
          return { ok: false, reasonCode: 'LEGACY_SCHEMA' };
        }
        return { ok: false, reasonCode: 'UNSUPPORTED_TYPE' };
      }
      if (essence !== raw.type) raw.type = essence;
    }
    if (raw.url != null && raw.url !== '' && (typeof raw.url !== 'string' || raw.url.length > MAX_ATTACH_URL_CHARS)) {
      return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
    }
    if (raw.dataUrl != null && raw.dataUrl !== '' && (typeof raw.dataUrl !== 'string' || raw.dataUrl.length > MAX_ATTACH_DATAURL_CHARS)) {
      return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
    }
    if (raw.magnetURI != null && raw.magnetURI !== '' && (typeof raw.magnetURI !== 'string' || raw.magnetURI.length > MAX_ATTACH_MAGNET_CHARS)) {
      return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
    }
    if (raw.infoHash != null && raw.infoHash !== '' && (typeof raw.infoHash !== 'string' || raw.infoHash.length > 64)) {
      return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
    }
    if (raw.fileId != null && raw.fileId !== '' && (typeof raw.fileId !== 'string' || raw.fileId.length > MAX_ATTACH_ID_CHARS)) {
      return { ok: false, reasonCode: 'MISSING_FILE_ID' };
    }
    if (raw.id != null && raw.id !== '' && (typeof raw.id !== 'string' || raw.id.length > MAX_ATTACH_ID_CHARS)) {
      return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
    }
    if (raw.isTorrent != null && typeof raw.isTorrent !== 'boolean') {
      return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
    }
    if (raw.size != null && (typeof raw.size !== 'number' || !Number.isFinite(raw.size) || raw.size < 0 || raw.size > MAX_ATTACH_FILE_SIZE)) {
      return { ok: false, reasonCode: 'INVALID_SIZE' };
    }
    if (raw.duration != null && (typeof raw.duration !== 'number' || !Number.isFinite(raw.duration) || raw.duration < 0 || raw.duration > MAX_ATTACH_DURATION_SEC)) {
      return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
    }
    if (raw.url && !isSafeIncomingChatResource(raw.url)) {
      return { ok: false, reasonCode: 'MISSING_URL' };
    }
    if (raw.dataUrl && !isSafeIncomingChatResource(raw.dataUrl)) {
      return { ok: false, reasonCode: 'MISSING_URL' };
    }
    if (raw.magnetURI && !isValidIncomingMagnetURI(raw.magnetURI)) {
      return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
    }
    if (raw.infoHash && !/^(?:[a-fA-F0-9]{40}|[a-zA-Z2-7]{32})$/.test(raw.infoHash)) {
      return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
    }
    if (raw.isTorrent === true && !(raw.magnetURI || raw.infoHash)) {
      return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
    }
    return { ok: true };
  }

  function verifyIncomingChatAttachment(raw) {
    return inspectIncomingChatAttachment(raw).ok;
  }

  function verifyIncomingChatRelayPayload(rawContent, meta) {
    try {
      if (rawContent == null || rawContent === '') return true;
      if (typeof rawContent !== 'string') return false;
      if (rawContent.length > MAX_CHAT_EVENT_CONTENT_CHARS) {
        console.warn('[SO-CALL SECURITY] rejected oversized chat payload');
        return false;
      }
      const trimmed = rawContent.trim();
      if (!trimmed) return true;
      if (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[') {
        return true;
      }
      let parsed;
      try {
        parsed = JSON.parse(rawContent);
      } catch (_err) {
        console.warn('[SO-CALL SECURITY] rejected malformed chat JSON');
        return false;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn('[SO-CALL SECURITY] rejected malformed chat JSON');
        return false;
      }
      if (!incomingJsonWithinLimits(parsed, 0)) {
        console.warn('[SO-CALL SECURITY] rejected oversized chat payload');
        return false;
      }
      if (parsed.t != null && typeof parsed.t !== 'string') {
        console.warn('[SO-CALL SECURITY] rejected malformed chat JSON');
        return false;
      }
      if (parsed.t && parsed.t.length > MAX_CHAT_TEXT_CHARS && parsed.t.indexOf('torrent-transfer-request') < 0) {
        console.warn('[SO-CALL SECURITY] rejected oversized chat payload');
        return false;
      }
      if (parsed.a != null && (typeof parsed.a !== 'object' || Array.isArray(parsed.a))) {
        logAttachmentRejected(parsed.a, 'INVALID_DESCRIPTOR', meta && meta.eventId);
        return false;
      }
      if (parsed.a != null) {
        const inspected = inspectIncomingChatAttachment(parsed.a, { network: true });
        if (!inspected.ok) {
          logAttachmentRejected(parsed.a, inspected.reasonCode, meta && meta.eventId);
          return false;
        }
      }
      if (typeof parsed.magnetURI === 'string' && parsed.magnetURI && !isValidIncomingMagnetURI(parsed.magnetURI)) {
        console.warn('[SO-CALL SECURITY] rejected malformed torrent magnet');
        return false;
      }
      if (typeof parsed.t === 'string' && parsed.t.indexOf('torrent-transfer-request') >= 0) {
        try {
          const inner = JSON.parse(parsed.t);
          if (inner && typeof inner.magnetURI === 'string' && inner.magnetURI && !isValidIncomingMagnetURI(inner.magnetURI)) {
            console.warn('[SO-CALL SECURITY] rejected malformed torrent magnet');
            return false;
          }
        } catch (_err) {}
      }
      return true;
    } catch (_err) {
      console.warn('[SO-CALL SECURITY] rejected malformed chat JSON');
      return false;
    }
  }

  let poolReadyWarningShown = false;
  let isServiceReady = false;

  if (!App.chatState) {
    console.warn('Chat state module missing – chat-service aborted');
    return;
  }

  let activeSubscription = null;
  let chatSignalKeepaliveTimer = null;
  let chatLastSignalAt = 0;
  function ensurePoolReady() {
    if (isServiceReady) {
      return App.pool;
    }
    if (!App.pool) {
      if (!poolReadyWarningShown) {
        console.warn('Chat service waiting for Nostr pool to be ready');
        poolReadyWarningShown = true;
      }
      return null;
    }
    isServiceReady = true;
    return App.pool;
  }
  function buildChatDraft(peerPubkey, content, extraTags) {
    const now = Math.floor(Date.now() / 1000);
    const normalizedPeer = peerPubkey.toLowerCase();
    const tags = [
      ['p', normalizedPeer],
      ['t', CHAT_TAG],
    ];
    if (Array.isArray(extraTags)) {
      extraTags.forEach(function (tag) {
        if (Array.isArray(tag) && tag.length) tags.push(tag);
      });
    }
    // C0: private DM is GLOBAL SO-CALL — do not bind new messages to active Community.
    const draft = {
      kind: CHAT_KIND,
      pubkey: App.publicKey,
      created_at: now,
      tags,
      content,
    };
    return draft;
  }

  async function publishAuthorizedDeviceCopies(accountP, logicalId, text, attachment, createdAt, mirrorPeer, mode) {
    const account = String(accountP || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(account) || !logicalId) return { ok: false, n: 0, code: 'BAD_TARGET' };
    if (!App.SosCryptoSigner || typeof App.SosCryptoSigner.nip44ChatEncrypt !== 'function' || typeof App.SosCryptoSigner.signChatEvent !== 'function' || !App.SosCryptoSigner.hasIdentityKey()) {
      return { ok: false, n: 0, code: 'NOT_PRIMARY' };
    }
    const Session = window.SosAccountSession;
    if (!Session || typeof Session.listAuthorizedDevices !== 'function') return { ok: false, n: 0, code: 'NO_DIRECTORY' };
    const inbound = mode === 'inbound';
    const outgoingMirror = !inbound && /^[0-9a-f]{64}$/.test(String(mirrorPeer || ''));
    let devices = [];
    try { devices = await Session.listAuthorizedDevices(account, 'DEVICE_CHAT'); } catch (_e) { devices = []; }
    if (!Array.isArray(devices) || !devices.length) {
      try { console.log('[MD] no authorized device copies for ' + account.slice(0, 8)); } catch (_log) {}
      return { ok: true, n: 0, code: 'NO_DEVICES' };
    }
    const inboundPeer = inbound && /^[0-9a-f]{64}$/.test(String(mirrorPeer || ''));
    const pool = ensurePoolReady();
    if (!pool) return { ok: false, n: 0, code: 'NO_POOL' };
    let n = 0;
    for (let i = 0; i < devices.length; i += 1) {
      const signPub = String(devices[i] && devices[i].deviceSignPub || '').toLowerCase();
      const encPub = String(devices[i] && devices[i].deviceEncPub || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(signPub) || signPub === account || signPub === String(App.publicKey || '').toLowerCase()) continue;
      if (encPub && encPub === signPub) {
        try { console.warn('[MD] D_ENC_NOT_CHAT_RECIPIENT'); } catch (_enc) {}
        continue;
      }
      const devicePub = signPub;
      let envelope;
      try {
        envelope = await Promise.resolve(App.SosCryptoSigner.nip44ChatEncrypt({
          senderPubkey: App.publicKey,
          recipientPubkey: devicePub,
          payload: {
            messageId: logicalId,
            sender: App.publicKey,
            recipient: devicePub,
            createdAt: createdAt || Math.floor(Date.now() / 1000),
            text: typeof text === 'string' ? text : '',
            attachment: attachment || null,
          },
        }));
      } catch (_enc) { continue; }
      if (!envelope || envelope.family !== 'sos-e2ee' || typeof envelope.ct !== 'string') continue;
      const wire = JSON.stringify(envelope);
      if (text && String(text).length >= 8 && wire.indexOf(text) !== -1) continue;
      const extraTags = [['t', 'sos-device-copy'], ['e', String(logicalId).slice(0, 80)]];
      if (outgoingMirror) {
        let mirror = String(mirrorPeer).toLowerCase();
        if (Session && typeof Session.noteOwnedDevices === 'function') {
          try { await Session.noteOwnedDevices(account); } catch (_note) {}
        }
        if (Session && typeof Session.verifiedAccountOf === 'function') {
          const owner = Session.verifiedAccountOf(mirror);
          if (owner) mirror = owner;
        }
        if (mirror === devicePub) mirror = account;
        extraTags.push(['t', 'sos-own-sync']);
        extraTags.push(['sync-peer', mirror]);
      } else if (inboundPeer) {
        extraTags.push(['t', 'sos-inbound-sync']);
        extraTags.push(['sync-peer', String(mirrorPeer).toLowerCase()]);
      }
      const draft = buildChatDraft(devicePub, wire, extraTags);
      let event;
      try { event = await Promise.resolve(App.SosCryptoSigner.signChatEvent(draft)); } catch (_sign) { continue; }
      if (!event || !event.id) continue;
      try {
        const accepted = await awaitRelayAccepted(pool, App.relayUrls, event);
        if (accepted && accepted.ok) n += 1;
      } catch (_pub) {}
    }
    try { console.log('[MD] device copies published ' + n + ' account=' + account.slice(0, 8)); } catch (_done) {}
    return { ok: true, n: n };
  }

  function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
  }

  async function awaitRelayAccepted(pool, relays, event) {
    const id8 = event && event.id ? String(event.id).slice(0, 8) : '';
    try { console.log('[CHAT/SEND] SIGNED id=' + id8); } catch (_s) {}
    let issued = pool.publish(relays, event);
    if (issued && typeof issued.then === 'function') issued = await issued;
    const pending = Array.isArray(issued) ? issued : (issued ? [issued] : []);
    try { console.log('[CHAT/SEND] PUBLISH_STARTED id=' + id8 + ' relays=' + pending.length); } catch (_p) {}
    if (!pending.length) {
      try { console.warn('[CHAT/SEND] RELAY_REJECTED id=' + id8 + ' reason=no-promises'); } catch (_r) {}
      return { ok: false, code: 'RELAY_REJECTED' };
    }
    const settled = await Promise.all(pending.map((p) => {
      const timeout = new Promise((resolve) => setTimeout(() => resolve({ status: 'rejected', reason: 'timeout' }), 8000));
      return Promise.race([
        Promise.resolve(p).then(() => ({ status: 'fulfilled' })).catch(() => ({ status: 'rejected' })),
        timeout,
      ]);
    }));
    const ok = settled.filter((r) => r.status === 'fulfilled').length;
    if (ok < 1) {
      try { console.warn('[CHAT/SEND] RELAY_REJECTED id=' + id8); } catch (_r2) {}
      return { ok: false, code: 'RELAY_REJECTED' };
    }
    try { console.log('[CHAT/SEND] RELAY_ACCEPTED id=' + id8 + ' ok=' + ok); } catch (_a) {}
    return { ok: true, n: ok };
  }

  function chatDeviceSignPub(device) {
    const signPub = String(device && device.deviceSignPub || '').toLowerCase();
    const encPub = String(device && device.deviceEncPub || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(signPub)) return '';
    if (encPub && encPub === signPub) return '';
    return signPub;
  }

  async function publishDelegatedDeviceCopies(peerAccount, text, logicalId, attachment) {
    const Session = window.SosAccountSession;
    const session = typeof App.getAccountSession === 'function' ? App.getAccountSession() : null;
    if (!session || session.role !== 'LINKED_DEVICE' || session.verified !== true) return { ok: false, n: 0, code: 'NOT_LINKED' };
    if (!Session || typeof Session.listAuthorizedDevices !== 'function' || typeof Session.delegatedChatEncrypt !== 'function') {
      return { ok: false, n: 0, code: 'NO_DIRECTORY' };
    }
    const selfDevice = String(session.deviceSignPub || '').toLowerCase();
    const account = String(session.accountP || App.publicKey || '').toLowerCase();
    const peer = String(peerAccount || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(account) || !/^[0-9a-f]{64}$/.test(peer) || !logicalId) return { ok: false, n: 0, code: 'BAD_TARGET' };
    let recipients = [];
    let mine = [];
    try { recipients = await Session.listAuthorizedDevices(peer, 'DEVICE_CHAT'); } catch (_list) { recipients = []; }
    try { mine = await Session.listAuthorizedDevices(account, 'DEVICE_CHAT'); } catch (_mine) { mine = []; }
    const pool = ensurePoolReady();
    if (!pool) return { ok: false, n: 0, code: 'NO_POOL' };
    const sent = new Set();
    let n = 0;
    async function sendOne(device, mirror) {
      const devicePub = chatDeviceSignPub(device);
      if (!devicePub || devicePub === selfDevice || devicePub === account || sent.has(devicePub)) return;
      sent.add(devicePub);
      const signed = await Session.delegatedChatEncrypt(peer, typeof text === 'string' ? text : '', logicalId, {
        deviceCopy: true,
        devicePub: devicePub,
        deviceEncPub: device && device.deviceEncPub,
        mirror: mirror,
        attachment: attachment || null,
      });
      if (!signed || signed.ok !== true || !signed.event) return;
      const accepted = await awaitRelayAccepted(pool, App.relayUrls, signed.event);
      if (accepted && accepted.ok) n += 1;
    }
    if (peer !== account) {
      const list = Array.isArray(recipients) ? recipients : [];
      for (let i = 0; i < list.length; i += 1) await sendOne(list[i], '');
    }
    const own = Array.isArray(mine) ? mine : [];
    for (let i = 0; i < own.length; i += 1) await sendOne(own[i], 'outgoing');
    try { console.log('[MD] delegated device copies ' + n + ' peer=' + peer.slice(0, 8)); } catch (_done) {}
    return { ok: true, n: n };
  }

  function selfEncryptedFallbackOptIn() {
    try { return window.localStorage && window.localStorage.getItem('sos-self-encrypted-fallback') === '1'; } catch (_opt) { return false; }
  }

  async function selfWireAttachment(self, messageId) {
    const att = typeof App.getChatFileAttachment === 'function' ? App.getChatFileAttachment(self) : null;
    if (!att) return { ok: true, wire: null, local: null };
    if (att.type === 'encrypted-media') {
      const wire = typeof App.buildEncryptedAttachmentWireDescriptor === 'function'
        ? App.buildEncryptedAttachmentWireDescriptor(att)
        : att;
      return { ok: !!(wire && wire.type === 'encrypted-media'), wire: wire || null, local: att, code: wire ? '' : 'BAD_DESCRIPTOR' };
    }
    let file = att.file || att.blob || null;
    if (!file && typeof att.dataUrl === 'string' && att.dataUrl.indexOf('base64,') !== -1) {
      try {
        const bin = atob(att.dataUrl.split('base64,')[1] || '');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        file = new File([bytes], att.name || 'self.bin', { type: att.type || 'application/octet-stream' });
      } catch (_file) { file = null; }
    }
    if (!selfEncryptedFallbackOptIn()) return { ok: false, code: 'LOCAL_QUEUED', wire: null, local: att };
    if (!file || typeof App.uploadMediaForServerFallback !== 'function') return { ok: false, code: 'ATTACHMENT_NOT_READY', wire: null, local: att };
    let descriptor = null;
    try {
      descriptor = await App.uploadMediaForServerFallback(file, {
        messageId: messageId,
        sender: self,
        recipient: self,
        mimeType: file.type || att.type || 'application/octet-stream',
        fileName: file.name || att.name || 'file',
        requireEncryption: true,
      });
    } catch (_up) { descriptor = null; }
    if (!descriptor || descriptor.type !== 'encrypted-media') return { ok: false, code: 'ATTACHMENT_NOT_READY', wire: null, local: att };
    const wire = typeof App.buildEncryptedAttachmentWireDescriptor === 'function'
      ? App.buildEncryptedAttachmentWireDescriptor(descriptor)
      : descriptor;
    return { ok: true, wire: wire, local: descriptor };
  }

  async function publishSelfChatMessage(plainText, options = {}) {
    const self = String(App.publicKey || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(self)) return { ok: false, error: 'no-account' };
    const text = typeof plainText === 'string' ? plainText.trim() : '';
    const messageId = (typeof options.clientTempId === 'string' && options.clientTempId) || ('self-' + Date.now());
    const createdAt = Math.floor(Date.now() / 1000);
    const outgoing = {
      id: messageId,
      from: self,
      to: self,
      content: text,
      createdAt: createdAt,
      direction: 'outgoing',
      status: 'sending',
      source: 'SELF',
      transport: 'LOCAL',
      logicalMessageId: messageId,
    };
    const clientTempId = typeof options.clientTempId === 'string' ? options.clientTempId : '';
    if (clientTempId && typeof App.replaceOutgoingTempMessage === 'function') App.replaceOutgoingTempMessage(clientTempId, outgoing);
    else if (typeof App.appendChatMessage === 'function') App.appendChatMessage(outgoing);
    const linked = typeof App.getAccountSession === 'function' ? App.getAccountSession() : null;
    const pool = ensurePoolReady();
    const packed = await selfWireAttachment(self, messageId);
    if (packed && packed.code === 'LOCAL_QUEUED') {
      if (typeof App.updateChatMessageStatus === 'function') App.updateChatMessageStatus(messageId, 'pending');
      try { console.log('[CHAT/SELF] transport=LOCAL_QUEUED id=' + String(messageId).slice(0, 12)); } catch (_q) {}
      return { ok: false, error: 'LOCAL_QUEUED', messageId: messageId, selfChat: true, SELF_SYNC_COMPLETE: false, deviceCopies: 0, stage: 'LOCAL_QUEUED', transport: 'LOCAL_QUEUED' };
    }
    if (!text && (!packed || !packed.wire)) {
      if (typeof App.updateChatMessageStatus === 'function') App.updateChatMessageStatus(messageId, 'failed');
      return { ok: false, error: (packed && packed.code) || 'EMPTY_PAYLOAD', messageId: messageId, SELF_SYNC_COMPLETE: false, deviceCopies: 0 };
    }
    if (packed && packed.local) outgoing.attachment = packed.local;
    let deviceCopies = 0;
    let delivered = false;
    if (linked && linked.role === 'LINKED_DEVICE' && linked.verified === true) {
      const Session = window.SosAccountSession;
      if (!Session || typeof Session.delegatedChatEncrypt !== 'function' || !pool) {
        if (typeof App.updateChatMessageStatus === 'function') App.updateChatMessageStatus(messageId, 'failed');
        return { ok: false, error: 'delegation-missing', messageId: messageId, SELF_SYNC_COMPLETE: false, deviceCopies: 0 };
      }
      const signed = await Session.delegatedChatEncrypt(self, text, messageId, { sibling: true, attachment: packed && packed.wire });
      if (!signed || signed.ok !== true || !signed.event) {
        if (typeof App.updateChatMessageStatus === 'function') App.updateChatMessageStatus(messageId, 'failed');
        return { ok: false, error: (signed && signed.code) || 'delegation-sign-failed', messageId: messageId, SELF_SYNC_COMPLETE: false, deviceCopies: 0 };
      }
      const accepted = await awaitRelayAccepted(pool, App.relayUrls, signed.event);
      delivered = !!(accepted && accepted.ok);
      if (delivered) {
        try {
          const fan = await publishDelegatedDeviceCopies(self, text, messageId, packed && packed.wire);
          deviceCopies = fan && fan.n ? fan.n : 0;
        } catch (_selfFan) { deviceCopies = 0; }
      }
    } else if (App.SosCryptoSigner && typeof App.SosCryptoSigner.hasIdentityKey === 'function' && App.SosCryptoSigner.hasIdentityKey()) {
      const own = await publishAuthorizedDeviceCopies(self, messageId, text, packed && packed.wire, createdAt, self);
      deviceCopies = own && own.n ? own.n : 0;
      delivered = deviceCopies > 0 || (own && own.code === 'NO_DEVICES');
      try { console.log('[CHAT/SELF] deviceCopies=' + String(deviceCopies)); } catch (_own) {}
    }
    if (!delivered) {
      if (typeof App.updateChatMessageStatus === 'function') App.updateChatMessageStatus(messageId, 'pending');
      try { console.log('[CHAT/SELF] SELF_SYNC_COMPLETE=false id=' + String(messageId).slice(0, 12) + ' deviceCopies=' + deviceCopies); } catch (_p) {}
      return { ok: false, error: 'NO_DEVICE_ACK', messageId: messageId, selfChat: true, SELF_SYNC_COMPLETE: false, deviceCopies: deviceCopies, stage: 'PENDING' };
    }
    if (typeof App.updateChatMessageStatus === 'function') App.updateChatMessageStatus(messageId, 'sent');
    try { console.log('[CHAT/SELF] SELF_CHAT_COMMITTED id=' + String(messageId).slice(0, 12) + ' deviceCopies=' + deviceCopies); } catch (_s) {}
    return { ok: true, id: messageId, messageId: messageId, selfChat: true, SELF_SYNC_COMPLETE: true, deviceCopies: deviceCopies, stage: 'RELAY_ACCEPTED', transport: 'ENCRYPTED_DEVICE_COPY' };
  }

  async function publishDelegatedChatMessage(peerPubkey, plainText, options = {}) {
    const peerNorm = String(peerPubkey || '').toLowerCase();
    const text = typeof plainText === 'string' ? plainText.trim() : '';
    const att = typeof App.getChatFileAttachment === 'function' ? App.getChatFileAttachment(peerNorm) : null;
    if (!text && !att) return { ok: false, error: 'empty-message' };
    const pool = ensurePoolReady();
    if (!pool) return { ok: false, error: 'pool-unavailable' };
    const Session = window.SosAccountSession;
    if (!Session || typeof Session.delegatedChatEncrypt !== 'function') return { ok: false, error: 'delegation-missing' };
    const boundId = att && (att.clientMessageId || att.logicalMessageId);
    const messageId = (typeof options?.clientTempId === 'string' && options.clientTempId) || (typeof boundId === 'string' && boundId) || ('ld-' + Date.now());
    const wireAtt = att && typeof App.buildEncryptedAttachmentWireDescriptor === 'function'
      ? App.buildEncryptedAttachmentWireDescriptor(att)
      : att;
    const signed = await Session.delegatedChatEncrypt(peerNorm, text, messageId, { attachment: wireAtt || null });
    if (!signed || signed.ok !== true || !signed.event) return { ok: false, error: (signed && signed.code) || 'delegation-sign-failed' };
    const event = signed.event;
    const outgoingMessage = {
      id: event.id,
      from: App.publicKey,
      to: peerNorm,
      content: text,
      attachment: att || null,
      createdAt: event.created_at,
      direction: 'outgoing',
      status: 'sending',
      e2ee: true,
      source: 'DELEGATED_DEVICE',
      transport: 'NOSTR',
      logicalMessageId: messageId,
    };
    const clientTempId = typeof options.clientTempId === 'string' ? options.clientTempId : '';
    if (clientTempId && typeof App.replaceOutgoingTempMessage === 'function') {
      App.replaceOutgoingTempMessage(clientTempId, outgoingMessage);
    } else if (typeof App.appendChatMessage === 'function') {
      App.appendChatMessage(outgoingMessage);
    }
    let accepted = { ok: false, code: 'RELAY_REJECTED' };
    for (let attempt = 0; attempt < 3 && !accepted.ok; attempt += 1) {
      accepted = await awaitRelayAccepted(pool, App.relayUrls, event);
    }
    if (!accepted.ok) {
      if (typeof App.updateChatMessageStatus === 'function') App.updateChatMessageStatus(event.id, 'failed');
      return { ok: false, error: 'RELAY_REJECTED', id: event.id, messageId: event.id, stage: 'RELAY_REJECTED' };
    }
    outgoingMessage.status = 'sent';
    if (typeof App.updateChatMessageStatus === 'function') App.updateChatMessageStatus(event.id, 'sent');
    let deviceCopies = 0;
    try {
      const sibling = await Session.delegatedChatEncrypt(peerNorm, text, messageId, { sibling: true, attachment: wireAtt || null });
      if (sibling && sibling.ok === true && sibling.event) {
        await awaitRelayAccepted(pool, App.relayUrls, sibling.event);
      }
    } catch (_sib) {}
    try {
      const fan = await publishDelegatedDeviceCopies(peerNorm, text, messageId, wireAtt || null);
      deviceCopies = fan && fan.n ? fan.n : 0;
    } catch (_fan) { deviceCopies = 0; }
    if (att && typeof App.clearChatFileAttachment === 'function') {
      try { App.clearChatFileAttachment(peerNorm); } catch (_clr) {}
    }
    return { ok: true, id: event.id, messageId: event.id, delegated: true, ROOT_K_PRESENT: false, deviceCopies: deviceCopies, stage: 'RELAY_ACCEPTED' };
  }

  async function publishChatMessage(peerPubkey, plainText, options = {}) {
    const selfAccount = String(App.publicKey || '').toLowerCase();
    if (selfAccount && String(peerPubkey || '').toLowerCase() === selfAccount) {
      return publishSelfChatMessage(plainText, options);
    }
    // חלק אבטחה (chat-service.js) – שער epoch חוסם שליחה פרטית לפני publish/Push | HYPER CORE TECH
    if (typeof App.ensureSecureChatEpochReady === 'function') {
      const stateNow = typeof App.getSecureChatGateState === 'function' ? App.getSecureChatGateState() : '';
      if (stateNow === 'CHECKING' || (typeof App.isSecureChatReady === 'function' && !App.isSecureChatReady() && !stateNow)) {
        try { await App.ensureSecureChatEpochReady({ skipAutoReload: true }); } catch (_e) { /* ignore */ }
      }
    }
    if (typeof App.isSecureChatReady === 'function' && !App.isSecureChatReady()) {
      try {
        console.log('[E2EE/EPOCH] send blocked state=' + (App.getSecureChatGateState?.() || 'unknown'));
      } catch (_err) { /* ignore */ }
      if (typeof App.ensureSecureChatEpochReady === 'function') {
        try { App.ensureSecureChatEpochReady({ skipAutoReload: true }); } catch (_e) { /* ignore */ }
      }
      return { ok: false, error: 'secure-update-required' };
    }
    const linkedSession = typeof App.getAccountSession === 'function' ? App.getAccountSession() : null;
    if (linkedSession && linkedSession.role === 'LINKED_DEVICE' && linkedSession.verified === true) {
      return publishDelegatedChatMessage(peerPubkey, plainText, options);
    }
    const clientTempId = typeof options?.clientTempId === 'string' ? options.clientTempId : null;
    const pendingAtt = typeof App.getChatFileAttachment === 'function' ? App.getChatFileAttachment(String(peerPubkey || '').toLowerCase()) : null;
    const pendingBound = pendingAtt && (pendingAtt.clientMessageId || pendingAtt.logicalMessageId);
    const sharedLogicalId = clientTempId || (typeof pendingBound === 'string' && pendingBound ? pendingBound : ('cmsg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10)));
    let deliveredOnDataChannel = false;
    let deviceCopyText = '';
    let deviceCopyAttachment = null;
    // חלק צ'אט (chat-service.js) – בודק אם מצורף קובץ לפני סינון טקסט ריק כדי לאפשר שליחת קבצים בלבד
    const attachmentReady = typeof App.hasChatFileAttachment === 'function' && App.hasChatFileAttachment(peerPubkey);
    if ((!plainText || !plainText.trim()) && !attachmentReady) {
      return { ok: false, error: 'empty-message' };
    }
    const pool = ensurePoolReady();
    if (!pool) {
      return { ok: false, error: 'pool-unavailable' };
    }
    if (!App.SosCryptoSigner || typeof App.SosCryptoSigner.signChatEvent !== 'function') {
      console.warn('SosCryptoSigner missing on App – cannot publish chat message');
      return { ok: false, error: 'finalize-missing' };
    }

    const baseText = typeof plainText === 'string' ? plainText.trim() : '';
    const serialization =
      typeof App.serializeChatMessageContent === 'function'
        ? App.serializeChatMessageContent(peerPubkey, baseText)
        : {
            rawContent: baseText,
            displayText: baseText,
            attachment: null,
            hasAttachment: false,
          };
    if (!serialization || (!serialization.rawContent && !serialization.hasAttachment)) {
      // חלק שגיאות קובץ (chat-service.js) – אם יש attachment אבל סריאליזציה נכשלה, מחזירים שגיאה ייעודית במקום empty-message | HYPER CORE TECH
      if (attachmentReady) {
        App.notifyChatFileTransferError?.({
          peer: peerPubkey,
          code: 'attachment-serialize-failed',
          message: 'לא ניתן לשלוח את הקובץ במסלול הנוכחי. נסה שוב בעוד רגע.',
        });
        return { ok: false, error: 'attachment-serialize-failed' };
      }
      return { ok: false, error: 'empty-message' };
    }

    // חלק בדיקות אוטומטיות (chat-service.js) – אפשרות לכפות Relay כדי לבדוק תרחישי fallback ללא DC | HYPER CORE TECH
    const forceRelay = (() => {
      try {
        return App.forceRelay === true || window.localStorage.getItem('sos_force_relay') === '1';
      } catch (_) {
        return App.forceRelay === true;
      }
    })();
    // חלק P2P (chat-service.js) – ניסיון חיבור מהיר ל-DC לפני שליחה כדי למזער שימוש בריליי
    if (!forceRelay && App.dataChannel && typeof App.dataChannel.isConnected === 'function') {
      const connectedNow = App.dataChannel.isConnected(peerPubkey);
      if (!connectedNow && typeof App.dataChannel.connect === 'function') {
        try {
          App.dataChannel.init?.();
          App.dataChannel.connect(peerPubkey);
          const started = Date.now();
          while ((Date.now() - started) < DC_PREFER_WAIT_MS) {
            if (App.dataChannel.isConnected(peerPubkey)) {
              break;
            }
            await waitMs(120);
          }
        } catch (_err) {
          // לא חוסמים שליחה אם חיבור DC נכשל; ממשיכים ל-relay fallback
        }
      }
    }
    // חלק P2P DataChannel (chat-service.js) – ניסיון שליחה ישירה דרך DataChannel לפני relay | HYPER CORE TECH
    // P2P_DC_TRANSPORT_SECURITY: WebRTC DTLS. E3B does not redesign DC schema; plaintext here
    // is NOT relay plaintext. Kind 1050 relay content is encrypted when e2eeSendRequired.
    if (!forceRelay && App.dataChannel && typeof App.dataChannel.isConnected === 'function' && App.dataChannel.isConnected(peerPubkey)) {
      if (App.P2pSecureV2 && typeof App.P2pSecureV2.waitForPeerCapability === 'function') {
        try {
          await App.P2pSecureV2.waitForPeerCapability(peerPubkey, 1500);
        } catch (_capWait) {}
      }
      const p2pId = sharedLogicalId;
      const p2pTs = Math.floor(Date.now() / 1000);
      const p2pMsg = { id: p2pId, logicalMessageId: sharedLogicalId, content: serialization.displayText || '', attachment: serialization.attachment || null, createdAt: p2pTs };
      let sent = false;
      if (typeof App.dataChannel.send === 'function') {
        try {
          sent = !!(await App.dataChannel.send(peerPubkey, p2pMsg));
        } catch (_sendErr) {
          sent = false;
        }
      }
      if (sent) {
        const p2pOutgoing = { id: p2pId, from: App.publicKey, to: peerPubkey, content: p2pMsg.content, attachment: p2pMsg.attachment, createdAt: p2pTs, direction: 'outgoing', status: 'sent', p2p: true, transport: 'DC', logicalMessageId: sharedLogicalId };
        // חלק מניעת כפילות (chat-service.js) – מחליף temp optimistic במקום append נוסף | HYPER CORE TECH
        if (clientTempId && typeof App.replaceOutgoingTempMessage === 'function') {
          App.replaceOutgoingTempMessage(clientTempId, p2pOutgoing);
        } else {
          App.appendChatMessage(p2pOutgoing);
        }
        App.markChatConversationRead(peerPubkey);
        if (typeof App.afterChatMessagePublished === 'function') App.afterChatMessagePublished(peerPubkey, p2pMsg);
        // P2P בלבד לא מגיע ל-RelayWatcher – Push/FCM להתראה כשהמקבל ב-APK ברקע | HYPER CORE TECH
        if (typeof App.triggerOutgoingMessagePush === 'function') {
          try {
            App.triggerOutgoingMessagePush(peerPubkey, { eventId: p2pId, hasAttachment: !!attachmentReady });
          } catch (_pushErr) {}
        }
        console.log('[DC] ✅ Message sent P2P, relay copies follow');
        deliveredOnDataChannel = true;
      }
    }
    // fallback: שליחה רגילה דרך relay

    const peerNorm = String(peerPubkey || '').trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(peerNorm)) {
      return { ok: false, error: 'invalid-recipient' };
    }

    // E3B cutover safety: authoritative policy refresh BEFORE every kind 1050 Relay publish.
    // READY tabs must not rely on a stale in-memory false after remote activation.
    // Unknown/fetch-failure without prior true → block (no plaintext relay). No Push on block.
    let e2eeSendRequired = false;
    if (typeof App.resolveRelayE2eeSendDecision === 'function') {
      let decision;
      try {
        decision = await App.resolveRelayE2eeSendDecision();
      } catch (_polErr) {
        decision = { ok: false, error: 'e2ee-policy-unavailable' };
      }
      if (!decision || decision.ok !== true) {
        try {
          console.warn(
            '[E2EE/SEND] blocked reason=' +
              String((decision && decision.error) || 'e2ee-policy-unavailable'),
          );
        } catch (_e) {}
        if (deliveredOnDataChannel) return { ok: true, messageId: sharedLogicalId, p2p: true, deviceCopies: 0, relay: false };
        return { ok: false, error: (decision && decision.error) || 'e2ee-policy-unavailable' };
      }
      e2eeSendRequired = decision.encrypt === true;
    } else {
      // Pre-hotfix clients only; cutover-ready builds always expose resolveRelayE2eeSendDecision.
      e2eeSendRequired =
        typeof App.isE2eeSendRequired === 'function' ? App.isE2eeSendRequired() === true : false;
    }

    // E3B: when required, kind 1050 relay content MUST be sos-e2ee envelope.
    // Fail closed — never plaintext fallback. No Push / no publish on encrypt failure.
    let wireContent = serialization.rawContent || '';
    let relayLogicalMessageId = '';
    if (e2eeSendRequired) {
      if (!App.SosCryptoSigner?.hasIdentityKey() || !App.publicKey) {
        try { console.warn('[E2EE/SEND] blocked reason=e2ee-key-unavailable'); } catch (_e) {}
        if (deliveredOnDataChannel) return { ok: true, messageId: sharedLogicalId, p2p: true, deviceCopies: 0, relay: false };
        return { ok: false, error: 'e2ee-key-unavailable' };
      }
      if (typeof App.SosCryptoSigner.nip44ChatEncrypt !== 'function') {
        try { console.warn('[E2EE/SEND] blocked reason=e2ee-unavailable'); } catch (_e) {}
        if (deliveredOnDataChannel) return { ok: true, messageId: sharedLogicalId, p2p: true, deviceCopies: 0, relay: false };
        return { ok: false, error: 'e2ee-unavailable' };
      }
      let packedText = baseText;
      let packedAttachment = null;
      try {
        const packed = JSON.parse(serialization.rawContent);
        if (packed && typeof packed === 'object' && !Array.isArray(packed)) {
          packedText = typeof packed.t === 'string' ? packed.t : baseText;
          packedAttachment = packed.a != null ? packed.a : null;
        }
      } catch (_parseErr) {
        packedText = baseText;
        packedAttachment = serialization.attachment || null;
      }
      const activeAtt =
        typeof App.getChatFileAttachment === 'function'
          ? App.getChatFileAttachment(peerNorm)
          : serialization.attachment;
      const innerMessageId = sharedLogicalId;
      relayLogicalMessageId = innerMessageId;
      deviceCopyText = packedText;
      deviceCopyAttachment = packedAttachment;
      const innerCreatedAt = Math.floor(Date.now() / 1000);
      // M4: encrypted Blossom descriptor must fit NIP-44 before Relay publish.
      if (
        packedAttachment &&
        packedAttachment.type === 'encrypted-media' &&
        typeof App.assertEncryptedBlossomFitsE3b === 'async function'
      ) {
        try {
          App.assertEncryptedBlossomFitsE3b({
            messageId: innerMessageId,
            sender: App.publicKey,
            recipient: peerNorm,
            createdAt: innerCreatedAt,
            text: packedText,
            attachment: packedAttachment,
          });
        } catch (sizeErr) {
          try {
            console.warn(
              '[E2EE/SEND] blocked reason=' +
                String((sizeErr && sizeErr.code) || 'MEDIA_E2EE_DESCRIPTOR_TOO_LARGE'),
            );
          } catch (_e) {}
          if (deliveredOnDataChannel) return { ok: true, messageId: sharedLogicalId, p2p: true, deviceCopies: 0, relay: false };
          return {
            ok: false,
            error: (sizeErr && sizeErr.code) || 'MEDIA_E2EE_DESCRIPTOR_TOO_LARGE',
          };
        }
      }
      let envelope;
      try {
        envelope = await Promise.resolve(App.SosCryptoSigner.nip44ChatEncrypt({
          senderPubkey: App.publicKey,
          recipientPubkey: peerNorm,
          payload: {
            messageId: innerMessageId,
            sender: App.publicKey,
            recipient: peerNorm,
            createdAt: innerCreatedAt,
            text: packedText,
            attachment: packedAttachment,
          },
        }));
      } catch (encErr) {
        try {
          console.warn(
            '[E2EE/SEND] blocked reason=' +
              String((encErr && encErr.code) || 'ENCRYPT_FAILURE'),
          );
        } catch (_e) {}
        if (deliveredOnDataChannel) return { ok: true, messageId: sharedLogicalId, p2p: true, deviceCopies: 0, relay: false };
        return { ok: false, error: 'e2ee-encrypt-failed' };
      }
      if (!envelope || envelope.family !== 'sos-e2ee' || typeof envelope.ct !== 'string' || !envelope.ct) {
        try { console.warn('[E2EE/SEND] blocked reason=invalid-envelope'); } catch (_e) {}
        if (deliveredOnDataChannel) return { ok: true, messageId: sharedLogicalId, p2p: true, deviceCopies: 0, relay: false };
        return { ok: false, error: 'e2ee-encrypt-failed' };
      }
      try {
        wireContent = JSON.stringify(envelope);
      } catch (_serErr) {
        try { console.warn('[E2EE/SEND] blocked reason=envelope-serialize-failed'); } catch (_e) {}
        if (deliveredOnDataChannel) return { ok: true, messageId: sharedLogicalId, p2p: true, deviceCopies: 0, relay: false };
        return { ok: false, error: 'e2ee-encrypt-failed' };
      }
      // Hard guard: never publish if inner plaintext leaked into outer content string.
      if (
        (packedText && wireContent.indexOf(packedText) !== -1 && packedText.length >= 8) ||
        (packedAttachment &&
          packedAttachment.name &&
          String(packedAttachment.name).length >= 4 &&
          wireContent.indexOf(String(packedAttachment.name)) !== -1)
      ) {
        try { console.warn('[E2EE/SEND] blocked reason=plaintext-leak-guard'); } catch (_e) {}
        if (deliveredOnDataChannel) return { ok: true, messageId: sharedLogicalId, p2p: true, deviceCopies: 0, relay: false };
        return { ok: false, error: 'e2ee-encrypt-failed' };
      }
    }

    const draft = buildChatDraft(peerNorm, wireContent);
    const event = await Promise.resolve(App.SosCryptoSigner.signChatEvent(draft));

    const outgoingMessage = {
      id: event.id,
      from: App.publicKey,
      to: peerNorm,
      content: serialization.displayText || '',
      attachment: serialization.attachment || null,
      createdAt: event.created_at,
      direction: 'outgoing',
      // חלק סטטוס הודעות (chat-service.js) – סטטוס שליחה: sending -> sent | HYPER CORE TECH
      status: 'sending',
      e2ee: e2eeSendRequired === true,
      source: 'NOSTR',
      transport: 'NOSTR',
    };
    if (relayLogicalMessageId) {
      outgoingMessage.logicalMessageId = relayLogicalMessageId;
      if (outgoingMessage.attachment && typeof outgoingMessage.attachment === 'object') {
        if (!outgoingMessage.attachment.logicalMessageId) outgoingMessage.attachment.logicalMessageId = relayLogicalMessageId;
        if (!outgoingMessage.attachment.clientMessageId) outgoingMessage.attachment.clientMessageId = relayLogicalMessageId;
      }
    }

    // A DataChannel copy is already on screen. The relay event is an additional device copy, not a second bubble.
    if (!deliveredOnDataChannel) {
      if (clientTempId && typeof App.replaceOutgoingTempMessage === 'function') {
        App.replaceOutgoingTempMessage(clientTempId, outgoingMessage);
      } else {
        App.appendChatMessage(outgoingMessage);
      }
    }

    // חלק timeout (chat-service.js) – פרסום עם timeout של 5 שניות למניעת תקיעה | HYPER CORE TECH
    const PUBLISH_TIMEOUT_MS = 5000;
    try {
      const publishPromise = pool.publish(App.relayUrls, event);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('publish-timeout')), PUBLISH_TIMEOUT_MS)
      );
      await Promise.race([publishPromise, timeoutPromise]);
      // חלק סטטוס הודעות (chat-service.js) – עדכון סטטוס ל"נשלח" אחרי הצלחה | HYPER CORE TECH
      if (typeof App.updateChatMessageStatus === 'function') {
        App.updateChatMessageStatus(event.id, 'sent');
      }
      App.markChatConversationRead(peerNorm);
      // חלק Push (chat-service.js) – שליחת Push לנמען כשההודעה נשלחה בהצלחה | HYPER CORE TECH
      if (typeof App.triggerOutgoingMessagePush === 'function') {
        App.triggerOutgoingMessagePush(peerNorm, { eventId: event.id, hasAttachment: !!attachmentReady });
      }
      if (typeof App.afterChatMessagePublished === 'function') {
        App.afterChatMessagePublished(peerNorm, outgoingMessage);
      }
      let deviceCopies = 0;
      if (e2eeSendRequired === true && relayLogicalMessageId) {
        try {
          const fan = await publishAuthorizedDeviceCopies(peerNorm, relayLogicalMessageId, deviceCopyText, deviceCopyAttachment, event.created_at);
          const own = await publishAuthorizedDeviceCopies(App.publicKey, relayLogicalMessageId, deviceCopyText, deviceCopyAttachment, event.created_at, peerNorm);
          deviceCopies = (fan && fan.n ? fan.n : 0) + (own && own.n ? own.n : 0);
        } catch (_fan) { deviceCopies = 0; }
      }
      return { ok: true, messageId: event.id, e2ee: e2eeSendRequired === true, p2p: deliveredOnDataChannel, deviceCopies: deviceCopies };
    } catch (err) {
      // חלק timeout (chat-service.js) – אם נגמר הזמן, נחשיב כהצלחה כי ההודעה כבר נשלחה ברקע | HYPER CORE TECH
      // Timeout still uses the same (possibly encrypted) event — never plaintext retry.
      if (err?.message === 'publish-timeout') {
        console.warn('Chat publish timeout - assuming success');
        if (typeof App.updateChatMessageStatus === 'function') {
          App.updateChatMessageStatus(event.id, 'sent');
        }
        // שליחת Push גם במקרה של timeout
        if (typeof App.triggerOutgoingMessagePush === 'function') {
          App.triggerOutgoingMessagePush(peerNorm, { eventId: event.id, hasAttachment: !!attachmentReady });
        }
        let deviceCopies = 0;
        if (e2eeSendRequired === true && relayLogicalMessageId) {
          try {
            const fan = await publishAuthorizedDeviceCopies(peerNorm, relayLogicalMessageId, deviceCopyText, deviceCopyAttachment, event.created_at);
            const own = await publishAuthorizedDeviceCopies(App.publicKey, relayLogicalMessageId, deviceCopyText, deviceCopyAttachment, event.created_at, peerNorm);
            deviceCopies = (fan && fan.n ? fan.n : 0) + (own && own.n ? own.n : 0);
          } catch (_fan) { deviceCopies = 0; }
        }
        return { ok: true, messageId: event.id, e2ee: e2eeSendRequired === true, p2p: deliveredOnDataChannel, deviceCopies: deviceCopies };
      }
      console.error('Chat publish failed', err);
      // חלק סטטוס הודעות (chat-service.js) – עדכון סטטוס ל"נכשל" אם השליחה נכשלה | HYPER CORE TECH
      if (typeof App.updateChatMessageStatus === 'function') {
        App.updateChatMessageStatus(event.id, 'failed');
      }
      return { ok: false, error: err?.message || 'publish-failed' };
    }
  }

  async function deleteChatMessage(peerPubkey, messageId) {
    // חלק צ'אט (chat-service.js) – שולח אירוע מחיקה kind 5 לכל הריליים ומסיר מקומית את ההודעה שנבחרה
    if (!peerPubkey || !messageId) {
      return { ok: false, error: 'missing-params' };
    }
    const pool = ensurePoolReady();
    if (!pool) {
      return { ok: false, error: 'pool-unavailable' };
    }
    if (!App.SosCryptoSigner || typeof App.SosCryptoSigner.signDelete !== 'function') {
      console.warn('SosCryptoSigner missing on App – cannot delete chat message');
      return { ok: false, error: 'finalize-missing' };
    }
    const normalizedPeer = peerPubkey.toLowerCase();
    const draft = {
      kind: 5,
      pubkey: App.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['e', messageId],
        ['p', normalizedPeer],
        ['t', CHAT_TAG],
      ],
      content: '',
    };
    // C0: deletes for DMs remain global (CHAT_TAG), not Community-bound.
    const event = await Promise.resolve(App.SosCryptoSigner.signDelete(draft));
    try {
      await pool.publish(App.relayUrls, event);
      App.removeChatMessage(normalizedPeer, messageId);
      return { ok: true };
    } catch (err) {
      console.error('Chat delete failed', err);
      return { ok: false, error: err?.message || 'delete-failed' };
    }
  }

  function normalizeProfileData(profile = {}, pubkey = '') {
    const rawName = String(profile.name || '').trim();
    // בלי שם מהרשת – לא ממציאים "משתמש xxxx" (כדי לא לדרוס שם שמור) | HYPER CORE TECH
    const safeName = rawName;
    const initials = profile.initials
      || (safeName && typeof App.getInitials === 'function' ? App.getInitials(safeName) : '')
      || 'מש';
    return {
      name: safeName,
      picture: profile.picture || '',
      initials,
    };
  }

  // חלק dedup פרופילים (chat-service.js) — מפה של בקשות פרופיל פעילות למניעת כפילויות במקביל | HYPER CORE TECH
  const _profileInflight = new Map();

  async function resolveProfile(pubkey) {
    const normalized = pubkey?.toLowerCase?.() || '';
    const nowSec = Math.floor(Date.now() / 1000);
    const owned = window.SosAccountSession && typeof window.SosAccountSession.verifiedAccountOf === 'function'
      ? window.SosAccountSession.verifiedAccountOf(normalized)
      : '';
    if (owned) return { name: '', picture: '', initials: '', profileFetchedAt: nowSec };
    const ttl = Math.min(PROFILE_TTL_SECONDS, 3600);

    // חלק קאש פרופילים (chat-service.js) – מנסה להשתמש בפרופיל שמור עם TTL לפני פנייה לריליי | HYPER CORE TECH
    const existing = App.chatState?.contacts?.get?.(normalized);
    const existingIsStub = !existing?.picture &&
      (!existing?.name || /^משתמש( [0-9a-f]{8})?$/i.test(String(existing.name).trim()));
    if (existing?.profileFetchedAt && (nowSec - existing.profileFetchedAt) < (existingIsStub ? 120 : ttl)) {
      return { name: existing.name, picture: existing.picture, initials: existing.initials, profileFetchedAt: existing.profileFetchedAt };
    }

    // חלק dedup (chat-service.js) — אם כבר יש בקשה פעילה לאותו pubkey, נחזיר את אותה Promise | HYPER CORE TECH
    if (_profileInflight.has(normalized)) {
      return _profileInflight.get(normalized);
    }

    const promise = _resolveProfileInner(pubkey, normalized, nowSec, existing);
    _profileInflight.set(normalized, promise);
    try { return await promise; } finally { _profileInflight.delete(normalized); }
  }

  async function _resolveProfileInner(pubkey, normalized, nowSec, existing) {
    if (typeof App.fetchProfile === 'function') {
      try {
        const profile = await App.fetchProfile(pubkey);
        if (profile) {
          profile.profileFetchedAt = nowSec;
          if (profile.picture) {
            const cachedAvatar = await cacheAvatar(profile.picture);
            if (cachedAvatar) {
              profile.picture = cachedAvatar;
            }
          }
        }
        return profile;
      } catch (err) {
        console.warn('Chat profile fetch failed', err);
      }
    }
    if (existing?.picture) {
      const cachedAvatar = await cacheAvatar(existing.picture);
      if (cachedAvatar) {
        return { ...existing, picture: cachedAvatar };
      }
    }
    return existing || null;
  }

  const pendingE2eeEvents = new Map();
  const MAX_PENDING_E2EE_EVENTS = 64;
  // NIP-44 v2 max ciphertext string length (see nostr-tools nip44 decodePayload).
  const MAX_E2EE_CIPHERTEXT_CHARS =
    typeof App.MAX_E2EE_CIPHERTEXT_CHARS === 'number' ? App.MAX_E2EE_CIPHERTEXT_CHARS : 87472;

  function logE2eeReject(reasonCode, event) {
    console.warn(
      '[SECURITY/E2EE_REJECT] reason=' +
        String(reasonCode || 'E2EE_REJECT') +
        ' event=' +
        (event && event.id ? String(event.id).slice(0, 8) : ''),
    );
  }

  function looksLikeIncomingE2eeContent(rawContent) {
    if (typeof App.looksLikeSosE2eeEnvelope === 'function') {
      return App.looksLikeSosE2eeEnvelope(rawContent);
    }
    if (typeof rawContent !== 'string') return false;
    const trimmed = rawContent.trim();
    if (!trimmed || trimmed.charAt(0) !== '{') return false;
    try {
      const parsed = JSON.parse(trimmed);
      return !!(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.family === 'sos-e2ee');
    } catch (_err) {
      return false;
    }
  }

  function queuePendingE2eeEvent(event) {
    if (!event || !event.id) return;
    if (pendingE2eeEvents.size >= MAX_PENDING_E2EE_EVENTS) {
      const oldest = pendingE2eeEvents.keys().next().value;
      if (oldest != null) pendingE2eeEvents.delete(oldest);
    }
    pendingE2eeEvents.set(event.id, event);
  }

  function flushPendingE2eeEvents() {
    if (!App.SosCryptoSigner?.hasIdentityKey() || !App.publicKey || !pendingE2eeEvents.size) return;
    if (flushPendingE2eeEvents._busy) return;
    flushPendingE2eeEvents._busy = true;
    try {
      const queued = Array.from(pendingE2eeEvents.values());
      pendingE2eeEvents.clear();
      for (let i = 0; i < queued.length; i += 1) {
        try {
          handleIncomingChatEvent(queued[i]);
        } catch (_err) {
          /* keep going */
        }
      }
    } finally {
      flushPendingE2eeEvents._busy = false;
    }
  }

  /**
   * Private kind 1050 recipient: deterministic single distinct valid `p` hex-64 tag.
   * Multiple conflicting p values → fail closed (CONFLICTING_P_TAGS).
   */
  function extractValidatedChatRecipientPTag(event) {
    const tags = Array.isArray(event && event.tags) ? event.tags : [];
    const values = [];
    for (let i = 0; i < tags.length; i += 1) {
      const tag = tags[i];
      if (!Array.isArray(tag) || tag[0] !== 'p') continue;
      const raw = tag[1];
      const hex =
        typeof App.normalizeHexPubkey === 'function'
          ? App.normalizeHexPubkey(raw)
          : (typeof raw === 'string' && /^[0-9a-fA-F]{64}$/.test(raw.trim())
            ? raw.trim().toLowerCase()
            : null);
      if (!hex) {
        return { ok: false, reason: 'BAD_P_TAG' };
      }
      values.push(hex);
    }
    if (!values.length) {
      return { ok: false, reason: 'MISSING_P_TAG' };
    }
    const unique = [];
    for (let i = 0; i < values.length; i += 1) {
      if (unique.indexOf(values[i]) === -1) unique.push(values[i]);
    }
    if (unique.length > 1) {
      return { ok: false, reason: 'CONFLICTING_P_TAGS' };
    }
    return { ok: true, recipient: unique[0] };
  }

  /**
   * E2 dual-read: decrypt recognized sos-e2ee envelopes after signature/recipient.
   * transportEventId = outer event.id (dedupe/delete)
   * logicalMessageId = inner messageId (metadata only; does not replace event.id)
   * Self-authored Relay echo/history: crypto peer = validated p-tag recipient (not event.pubkey).
   */
  async function resolveIncomingE2eeChatPayload(event) {
    const linkedNow = typeof App.getAccountSession === 'function' ? App.getAccountSession() : null;
    const devicePub = linkedNow && linkedNow.role === 'LINKED_DEVICE' && linkedNow.verified ? String(linkedNow.deviceSignPub || '') : '';
    const authorEarly =
      typeof App.normalizeHexPubkey === 'function'
        ? App.normalizeHexPubkey(event && event.pubkey)
        : String((event && event.pubkey) || '').trim().toLowerCase();
    const pEarly = extractValidatedChatRecipientPTag(event);
    const recipientEarly = pEarly && pEarly.ok ? pEarly.recipient : '';
    const onDevice = !!(devicePub && (authorEarly === devicePub || recipientEarly === devicePub));
    if (!onDevice && typeof App.SosCryptoSigner?.nip44ChatDecrypt !== 'function') {
      logE2eeReject('E2EE_MODULE_UNAVAILABLE', event);
      return { ok: false, retryable: true, reason: 'E2EE_MODULE_UNAVAILABLE' };
    }
    if (onDevice && !(window.SosAccountSession && typeof window.SosAccountSession.decryptForLinkedDevice === 'function')) {
      logE2eeReject('E2EE_DECRYPT_UNAVAILABLE', event);
      return { ok: false, retryable: true, reason: 'E2EE_DECRYPT_UNAVAILABLE' };
    }
    if (!onDevice && (!App.SosCryptoSigner?.hasIdentityKey() || !App.publicKey)) {
      logE2eeReject('E2EE_DECRYPT_UNAVAILABLE', event);
      return { ok: false, retryable: true, reason: 'E2EE_DECRYPT_UNAVAILABLE' };
    }
    let envelope;
    try {
      envelope = typeof event.content === 'string' ? JSON.parse(event.content) : event.content;
    } catch (_err) {
      logE2eeReject('BAD_ENVELOPE', event);
      return { ok: false, retryable: false, reason: 'BAD_ENVELOPE' };
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      logE2eeReject('BAD_ENVELOPE', event);
      return { ok: false, retryable: false, reason: 'BAD_ENVELOPE' };
    }
    if (envelope.family !== 'sos-e2ee') {
      logE2eeReject('UNKNOWN_FAMILY', event);
      return { ok: false, retryable: false, reason: 'UNKNOWN_FAMILY' };
    }
    const version = envelope.v != null ? envelope.v : envelope.version;
    if (version !== 1) {
      logE2eeReject('UNKNOWN_VERSION', event);
      return { ok: false, retryable: false, reason: 'UNKNOWN_VERSION' };
    }
    const algorithm = envelope.alg != null ? envelope.alg : envelope.algorithm;
    if (algorithm !== 'nip44') {
      logE2eeReject('UNSUPPORTED_ALGORITHM', event);
      return { ok: false, retryable: false, reason: 'UNSUPPORTED_ALGORITHM' };
    }
    const ciphertext = envelope.ct != null ? envelope.ct : envelope.ciphertext;
    if (typeof ciphertext !== 'string' || !ciphertext) {
      logE2eeReject('BAD_CIPHERTEXT', event);
      return { ok: false, retryable: false, reason: 'BAD_CIPHERTEXT' };
    }
    if (ciphertext.length > MAX_E2EE_CIPHERTEXT_CHARS) {
      logE2eeReject('OVERSIZED_CIPHERTEXT', event);
      return { ok: false, retryable: false, reason: 'OVERSIZED_CIPHERTEXT' };
    }

    const author = authorEarly;
    const accountLocal =
      typeof App.normalizeHexPubkey === 'function'
        ? App.normalizeHexPubkey(App.publicKey)
        : String(App.publicKey || '').trim().toLowerCase();
    const local = onDevice ? devicePub : accountLocal;
    if (!author || !local) {
      logE2eeReject('BAD_PUBKEY', event);
      return { ok: false, retryable: false, reason: 'BAD_PUBKEY' };
    }
    const selfAuthored = author === local;
    let intendedRecipient = null;
    if (selfAuthored) {
      const pRes = extractValidatedChatRecipientPTag(event);
      if (!pRes.ok) {
        logE2eeReject(pRes.reason || 'BAD_P_TAG', event);
        return { ok: false, retryable: false, reason: pRes.reason || 'BAD_P_TAG' };
      }
      if (pRes.recipient === local) {
        logE2eeReject('SELF_RECIPIENT', event);
        return { ok: false, retryable: false, reason: 'SELF_RECIPIENT' };
      }
      intendedRecipient = pRes.recipient;
    }

    try {
      let payload;
      if (onDevice && window.SosAccountSession && typeof window.SosAccountSession.decryptForLinkedDevice === 'function') {
        const opened = await window.SosAccountSession.decryptForLinkedDevice(event, envelope, selfAuthored, intendedRecipient);
        if (!opened || opened.ok !== true) {
          logE2eeReject((opened && opened.code) || 'DECRYPT_FAILED', event);
          return { ok: false, retryable: false, reason: (opened && opened.code) || 'DECRYPT_FAILED' };
        }
        payload = opened.payload;
      } else {
        payload = await Promise.resolve(App.SosCryptoSigner.nip44ChatDecrypt({
          localPubkey: App.publicKey,
          eventAuthorPubkey: event.pubkey,
          encryptedEnvelope: envelope,
          selfAuthored,
          intendedRecipientPubkey: intendedRecipient,
        }));
      }
      try {
        if (selfAuthored) {
          console.log(
            '[CHAT/E2EE] accepted-self peer=' +
              String(intendedRecipient || '').slice(0, 8) +
              ' event=' +
              String(event.id || '').slice(0, 8),
          );
        } else {
          console.log(
            '[CHAT/E2EE] accepted peer=' +
              String(event.pubkey || '').slice(0, 8) +
              ' event=' +
              String(event.id || '').slice(0, 8),
          );
        }
      } catch (_logErr) {}
      return {
        ok: true,
        payload,
        selfAuthored,
        conversationPeer: selfAuthored ? intendedRecipient : author,
      };
    } catch (err) {
      logE2eeReject((err && err.code) || 'DECRYPT_FAILED', event);
      return { ok: false, retryable: false, reason: (err && err.code) || 'DECRYPT_FAILED' };
    }
  }

  function classifyChatDelivery(input) {
    const hex = (value) => /^[0-9a-f]{64}$/.test(String(value || ''));
    const account = String(input.accountUser || '').toLowerCase();
    const sender = String(input.sender || '').toLowerCase();
    const senderAccount = String(input.senderAccount || sender || '').toLowerCase();
    const recipientAccount = String(input.recipientAccount || input.recipient || '').toLowerCase();
    const syncPeerAccount = String(input.syncPeerAccount || '').toLowerCase();
    const logicalSender = hex(senderAccount) ? senderAccount : '';
    const selfAuthored = input.selfAuthored === true;
    const syncTrusted = input.syncVerified === true && hex(syncPeerAccount);
    if (!hex(account) || !logicalSender) return null;
    if (input.inboundSync === true && syncTrusted && input.onDevice === true && sender === account) {
      return {
        kind: 'INCOMING_ACCOUNT_DEVICE_SYNC',
        direction: 'incoming',
        from: syncPeerAccount,
        to: account,
        peer: syncPeerAccount,
      };
    }
    if (input.ownSync === true && syncTrusted && logicalSender === account) {
      if (syncPeerAccount === account) {
        return { kind: 'SELF_CONVERSATION', direction: 'outgoing', from: account, to: account, peer: account };
      }
      return {
        kind: 'OUTGOING_SIBLING_SYNC',
        direction: 'outgoing',
        from: account,
        to: syncPeerAccount,
        peer: syncPeerAccount,
      };
    }
    if (selfAuthored && logicalSender === account && recipientAccount === account) {
      return { kind: 'SELF_CONVERSATION', direction: 'outgoing', from: account, to: account, peer: account };
    }
    if (selfAuthored && hex(recipientAccount) && recipientAccount !== account) {
      return {
        kind: 'OUTGOING_TO_EXTERNAL_ACCOUNT',
        direction: 'outgoing',
        from: account,
        to: recipientAccount,
        peer: recipientAccount,
      };
    }
    if (input.deviceCopy === true && logicalSender !== account) {
      return {
        kind: 'INCOMING_DEVICE_COPY',
        direction: 'incoming',
        from: logicalSender,
        to: account,
        peer: logicalSender,
      };
    }
    if (logicalSender !== account) {
      return {
        kind: 'INCOMING_FROM_EXTERNAL_ACCOUNT',
        direction: 'incoming',
        from: logicalSender,
        to: account,
        peer: logicalSender,
      };
    }
    return null;
  }

  async function handleIncomingChatEvent(event) {
    if (!event || !event.pubkey) {
      return;
    }
    if (Array.isArray(event.tags) && event.tags.some((t) => Array.isArray(t) && t[0] === 't' && t[1] === 'sos-hist-v1')) {
      if (window.SosAccountSession && typeof window.SosAccountSession.acceptHistoryEvent === 'function') {
        try { await window.SosAccountSession.acceptHistoryEvent(event); } catch (_hist) {}
      }
      return;
    }
    if (Array.isArray(event.tags) && event.tags.some((t) => Array.isArray(t) && t[0] === 't' && t[1] === 'sos-hist-req')) {
      if (window.SosAccountSession && typeof window.SosAccountSession.acceptHistoryRequest === 'function') {
        try { await window.SosAccountSession.acceptHistoryRequest(event); } catch (_req) {}
      }
      return;
    }
    if (Array.isArray(event.tags) && event.tags.some((t) => Array.isArray(t) && t[0] === 't' && t[1] === 'sos-hist-ack')) {
      if (window.SosAccountSession && typeof window.SosAccountSession.confirmHistoryAck === 'function') {
        try { await window.SosAccountSession.confirmHistoryAck(event); } catch (_ack) {}
      }
      return;
    }
    let delegatedAccountP = '';
    if (event.kind === CHAT_KIND && Array.isArray(event.tags) && event.tags.some((t) => Array.isArray(t) && t[0] === 'sos-md3')) {
      if (!window.SosAccountSession || typeof window.SosAccountSession.verifyDelegatedEvent !== 'function') return;
      const delegated = await window.SosAccountSession.verifyDelegatedEvent(event, 'DEVICE_CHAT');
      if (!delegated || delegated.ok !== true) {
        try {
          console.warn('[MD3] rejected code=' + String((delegated && delegated.code) || 'DELEGATION_REJECTED') + ' detail=' + String((delegated && delegated.detail) || '') + ' event=' + String(event.id || '').slice(0, 8));
        } catch (_md) {}
        return;
      }
      delegatedAccountP = String(delegated.accountP || '').toLowerCase();
      try { console.log('[MD3] MD3_VERIFIED event=' + String(event.id || '').slice(0, 8) + ' account=' + String(delegatedAccountP || '').slice(0, 8)); } catch (_okm) {}
      try { event.__sosDelegatedAccount = delegatedAccountP; } catch (_frozen) {}
    }
    // Retry E2EE events that arrived before local key was ready.
    if (App.SosCryptoSigner?.hasIdentityKey() && App.publicKey && pendingE2eeEvents.size) {
      flushPendingE2eeEvents();
    }
    const eventTs = typeof event.created_at === 'number' ? event.created_at : Math.floor(Date.now() / 1000);
    const nowSec = Math.floor(Date.now() / 1000);
    const messageAgeSec = Math.max(0, nowSec - eventTs);
    // חלק טורנט בזמן אמת (chat-service.js) – הורדה אוטומטית רק להודעות חדשות כדי למנוע ניסיונות חוזרים מהיסטוריה | HYPER CORE TECH
    const isRecentAutoStartEvent = messageAgeSec < TORRENT_AUTOSTART_MAX_AGE_SECONDS;
    if (event.kind === 5) {
      handleIncomingDeletion(event);
      return;
    }
    if (event.kind !== CHAT_KIND || !event.content) {
      return;
    }

    const isE2eeContent = looksLikeIncomingE2eeContent(event.content);
    if (!isE2eeContent) {
      if (!verifyIncomingChatRelayPayload(event.content, { eventId: event.id })) {
        return;
      }
    } else if (typeof event.content === 'string' && event.content.length > MAX_CHAT_EVENT_CONTENT_CHARS) {
      console.warn('[SO-CALL SECURITY] rejected oversized chat payload');
      return;
    }

    // חלק שמירה 90 יום (chat-service.js) – מתעלמים מהודעות ישנות מהריליי | HYPER CORE TECH
    if (eventTs < getChatRetentionFloorTs(nowSec)) {
      return;
    }
    const sender = event.pubkey.toLowerCase();
    const accountUser = (App.publicKey || '').toLowerCase();
    let recipient = '';
    if (isE2eeContent) {
      const pRes = extractValidatedChatRecipientPTag(event);
      if (!pRes.ok) {
        logE2eeReject(pRes.reason || 'BAD_P_TAG', event);
        return;
      }
      recipient = pRes.recipient;
    } else {
      const peerTag = event.tags?.find?.((tag) => Array.isArray(tag) && tag[0] === 'p');
      recipient = peerTag?.[1]?.toLowerCase?.() || '';
    }
    const linkedNow = typeof App.getAccountSession === 'function' ? App.getAccountSession() : null;
    const devicePub = linkedNow && linkedNow.role === 'LINKED_DEVICE' && linkedNow.verified ? String(linkedNow.deviceSignPub || '') : '';
    const onDevice = !!(devicePub && (sender === devicePub || recipient === devicePub));
    const currentUser = onDevice ? devicePub : accountUser;
    const isSelfMessage = sender === currentUser;
    if (!isSelfMessage && recipient && recipient !== currentUser) {
      // לא נועד עבור המשתמש הנוכחי
      return;
    }
    if (isSelfMessage && isE2eeContent && (!recipient || recipient === currentUser)) {
      logE2eeReject(recipient === currentUser ? 'SELF_RECIPIENT' : 'MISSING_P_TAG', event);
      return;
    }

    const peerPubkey = isSelfMessage ? recipient : sender;
    if (!peerPubkey) {
      return;
    }
    const deviceCopyEcho = Array.isArray(event.tags) && event.tags.some((t) => Array.isArray(t) && t[0] === 't' && t[1] === 'sos-device-copy');
    const ownSyncEarly = Array.isArray(event.tags) && event.tags.some((t) => Array.isArray(t) && t[0] === 't' && (t[1] === 'sos-sibling-sync' || t[1] === 'sos-own-sync'));
    const inboundSyncEarly = Array.isArray(event.tags) && event.tags.some((t) => Array.isArray(t) && t[0] === 't' && t[1] === 'sos-inbound-sync');
    const syncEarly = Array.isArray(event.tags) ? event.tags.find((t) => Array.isArray(t) && t[0] === 'sync-peer' && typeof t[1] === 'string') : null;
    const syncPeerEarly = syncEarly ? String(syncEarly[1]).toLowerCase() : '';
    if (inboundSyncEarly && !(onDevice && sender === accountUser && /^[0-9a-f]{64}$/.test(syncPeerEarly))) {
      try { console.log('[MD] INBOUND_SYNC_REJECT event=' + String(event.id || '').slice(0, 8)); } catch (_inb) {}
      return;
    }
    if (isSelfMessage && deviceCopyEcho && !ownSyncEarly) {
      try { console.log('[MD] DEVICE_COPY_ECHO_IGNORED event=' + String(event.id || '').slice(0, 8)); } catch (_echo) {}
      return;
    }
    const Session = window.SosAccountSession;
    const mapAccount = async (pk) => {
      const raw = String(pk || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(raw) || !Session || typeof Session.canonicalPeer !== 'function') return raw;
      try {
        const mapped = await Session.canonicalPeer(raw);
        return /^[0-9a-f]{64}$/.test(String(mapped || '')) ? String(mapped).toLowerCase() : raw;
      } catch (_map) {
        return raw;
      }
    };
    let senderAccount = sender;
    if (/^[0-9a-f]{64}$/.test(delegatedAccountP)) {
      senderAccount = delegatedAccountP;
    } else if (event.__sosDelegatedAccount && /^[0-9a-f]{64}$/.test(String(event.__sosDelegatedAccount))) {
      senderAccount = String(event.__sosDelegatedAccount).toLowerCase();
    } else {
      senderAccount = await mapAccount(sender);
    }
    let contactPubkey = isSelfMessage ? await mapAccount(recipient) : senderAccount;
    if (inboundSyncEarly && /^[0-9a-f]{64}$/.test(syncPeerEarly)) contactPubkey = await mapAccount(syncPeerEarly);
    else if (ownSyncEarly && /^[0-9a-f]{64}$/.test(syncPeerEarly)) contactPubkey = await mapAccount(syncPeerEarly);
    contactPubkey = await accountForOwnedDevice(contactPubkey);
    // Stage 13 — per-peer ingress throttle after auth/recipient (normal chat stays far below) | HYPER CORE TECH
    if (!allowIngressBucket(chatIngressBuckets, sender, CHAT_INGRESS_WINDOW_MS, CHAT_INGRESS_MAX_PER_PEER)) {
      console.warn('[SECURITY/RATE_DROP] type=1050 peer=' + sender.slice(0, 8) + ' reason=chat_burst');
      return;
    }

    const conversationTarget = isSelfMessage ? recipient : currentUser;
    if (!conversationTarget) {
      return;
    }

    const profile = normalizeProfileData(await resolveProfile(contactPubkey), contactPubkey);
    // חלק תיקון cache (chat-service.js) — profileFetchedAt = זמן נוכחי (לא eventTs!) כדי שה-TTL cache יעבוד | HYPER CORE TECH
    App.ensureChatContact(contactPubkey, { ...profile, profileFetchedAt: Math.floor(Date.now() / 1000) });

    let parsedPayload;
    let logicalMessageId = null;
    let e2eePayload = null;

    if (isE2eeContent) {
      // Recognized sos-e2ee → never legacy-fallback on failure.
      const resolved = await resolveIncomingE2eeChatPayload(event);
      if (!resolved.ok) {
        if (resolved.retryable) {
          queuePendingE2eeEvent(event);
        }
        return;
      }
      logicalMessageId = resolved.payload.messageId || null;
      e2eePayload = resolved.payload;
      parsedPayload = {
        displayText: resolved.payload.text || '',
        attachment: resolved.payload.attachment || null,
        hasAttachment: Boolean(resolved.payload.attachment),
      };
    } else {
      // חלק WebTorrent (chat-service.js) – זיהוי בקשות העברת קבצים גדולים | HYPER CORE TECH
      // ההודעה יכולה להגיע בשני פורמטים:
      // 1. ישירות כ-JSON: {"type":"torrent-transfer-request",...}
      // 2. עטופה בפורמט צ'אט: {"t":"{\"type\":\"torrent-transfer-request\",...}","a":null}

      if (event.content?.includes('torrent-transfer-request') && event.content?.includes('magnetURI')) {
        console.log('[CHAT/TORRENT] 🔍 Detected torrent keywords, parsing...');

        try {
          let torrentData = null;
          const parsed = JSON.parse(event.content);

          // בדיקה אם זה עטוף בפורמט {"t":"..."}
          if (parsed?.t && typeof parsed.t === 'string' && parsed.t.includes('torrent-transfer-request')) {
            console.log('[CHAT/TORRENT] 📦 Found wrapped format {t:...}, extracting inner JSON');
            torrentData = JSON.parse(parsed.t);
          } else if (parsed?.type === 'torrent-transfer-request') {
            // פורמט ישיר
            torrentData = parsed;
          }

          if (torrentData?.type === 'torrent-transfer-request' && torrentData?.magnetURI) {
            if (typeof App.isValidIncomingMagnetURI === 'function' && !App.isValidIncomingMagnetURI(torrentData.magnetURI)) {
              console.warn('[SO-CALL SECURITY] rejected malformed torrent magnet');
              torrentData = null;
            }
          }
          if (torrentData?.type === 'torrent-transfer-request' && torrentData?.magnetURI) {
            console.log('[CHAT/TORRENT] ✅ Valid WebTorrent request from:', sender.slice(0, 8));
            console.log('[CHAT/TORRENT] 📊 Size:', torrentData.fileSize, 'bytes');
            console.log('[CHAT/TORRENT] 🧲 Magnet:', typeof App.diagSafeMagnet === 'function' ? App.diagSafeMagnet(torrentData.magnetURI) : { magnetLength: String(torrentData.magnetURI || '').length });

            // שמירת ההודעה בצ'אט כפי שהיא (וואטסאפ סטייל) – ההודעה תירנדר ע"י chat-ui.js | HYPER CORE TECH
            const normalizedTorrentPayload = {
              type: 'torrent-transfer-request',
              transferId: torrentData.transferId,
              magnetURI: torrentData.magnetURI,
              infoHash: torrentData.infoHash,
              fileName: torrentData.fileName,
              fileSize: torrentData.fileSize,
              fromPeer: sender,
              timestamp: torrentData.timestamp || event.created_at || Date.now()
            };
            event.content = JSON.stringify(normalizedTorrentPayload);
            event.torrentPayload = normalizedTorrentPayload;

            if (typeof App.torrentTransfer?.handleIncomingRequest === 'function') {
              if (!isRecentAutoStartEvent) {
                console.log('[CHAT/TORRENT] ⏭️ Skipping auto-start for historical message', { ageSec: messageAgeSec, size: torrentData.fileSize });
              } else {
                if (!App._autoStartedTorrentMagnets) {
                  App._autoStartedTorrentMagnets = new Set();
                }
                if (torrentData.magnetURI) {
                  App._autoStartedTorrentMagnets.add(torrentData.magnetURI);
                }
                console.log('[CHAT/TORRENT] 📞 Calling handleIncomingRequest...');
                App.torrentTransfer.handleIncomingRequest(sender, torrentData);
                console.log('[CHAT/TORRENT] ✅ Request forwarded - download should auto-start');
              }
            } else {
              console.warn('[CHAT/TORRENT] ⚠️ WebTorrent module not loaded');
            }
            // לא מחזירים – נותנים להודעה להמשיך ב-renderMessages כדי שתוצג לשני הצדדים
          }
        } catch (e) {
          console.error('[CHAT/TORRENT] ❌ Parse error:', e.message);
        }
      }

      parsedPayload =
        typeof App.deserializeChatMessageContent === 'function'
          ? App.deserializeChatMessageContent(event.content)
          : {
              displayText: event.content,
              attachment: null,
              hasAttachment: false,
            };
    }

    if (parsedPayload.attachment) {
      const inspected = inspectIncomingChatAttachment(parsedPayload.attachment, { network: true });
      if (!inspected.ok) {
        logAttachmentRejected(parsedPayload.attachment, inspected.reasonCode, event.id);
        parsedPayload.attachment = null;
        parsedPayload.hasAttachment = false;
      } else if (parsedPayload.attachment.name) {
        parsedPayload.attachment.name = sanitizeIncomingChatFileName(parsedPayload.attachment.name);
      }
    }

    const ownSync = ownSyncEarly;
    const inboundSync = inboundSyncEarly;
    const syncPeer = syncPeerEarly;
    const recipientAccount = await mapAccount(recipient);
    let syncPeerAccount = /^[0-9a-f]{64}$/.test(syncPeer) ? await mapAccount(syncPeer) : '';
    if (syncPeerAccount) syncPeerAccount = await accountForOwnedDevice(syncPeerAccount);
    const syncVerified = !!(/^[0-9a-f]{64}$/.test(delegatedAccountP) || event.__sosDelegatedAccount || sender === accountUser);
    if ((ownSync || inboundSync) && !syncVerified) {
      try { console.log('[MD] SYNC_TAG_UNVERIFIED event=' + String(event.id || '').slice(0, 8)); } catch (_sync) {}
      return;
    }
    const route = classifyChatDelivery({
      accountUser: accountUser,
      devicePub: devicePub,
      onDevice: onDevice,
      sender: sender,
      senderAccount: senderAccount,
      recipient: recipient,
      recipientAccount: recipientAccount,
      syncPeerAccount: syncPeerAccount,
      ownSync: ownSync,
      inboundSync: inboundSync,
      deviceCopy: deviceCopyEcho,
      selfAuthored: isSelfMessage,
      syncVerified: syncVerified,
    });
    if (!route || !route.peer || !route.from || !route.to) {
      try { console.log('[CHAT/ROUTE] DROPPED event=' + String(event.id || '').slice(0, 8)); } catch (_drop) {}
      return;
    }
    const bubbleFrom = route.from;
    const bubbleTo = route.to;
    const bubbleDirection = route.direction;
    const bubblePeer = route.peer;
    if (bubblePeer !== contactPubkey && typeof App.ensureChatContact === 'function') {
      try {
        const lateProfile = normalizeProfileData(await resolveProfile(bubblePeer), bubblePeer);
        App.ensureChatContact(bubblePeer, { ...lateProfile, profileFetchedAt: Math.floor(Date.now() / 1000) });
      } catch (_late) {}
    }

    // M4: hydrate encrypted Blossom attachments for local render (does not change transport routing).
    if (
      parsedPayload.attachment &&
      parsedPayload.attachment.type === 'encrypted-media' &&
      typeof App.resolveServerMediaAttachment === 'function'
    ) {
      const encAtt = parsedPayload.attachment;
      if (encAtt.media && typeof encAtt.media.filename === 'string' && !encAtt.name) {
        encAtt.name = sanitizeIncomingChatFileName(encAtt.media.filename);
      }
      const authCtx = typeof App.mediaAuthContext === 'function'
        ? App.mediaAuthContext(encAtt, { logicalMessageId: logicalMessageId, from: bubbleFrom, to: bubbleTo })
        : null;
      const aadMessageId = (authCtx && authCtx.messageId) || encAtt.clientMessageId || encAtt.logicalMessageId || logicalMessageId || null;
      const aadSender = (authCtx && authCtx.sender) || bubbleFrom;
      const aadRecipient = (authCtx && authCtx.recipient) || bubbleTo;
      const hydratePeer = bubblePeer;
      try {
        console.log('MEDIA_FALLBACK_TRACE stage=RECIPIENT_EVENT_RECEIVED attachmentId=' + String(encAtt.attachmentId || '').replace(/[^0-9a-f]/g, '').slice(0, 8));
      } catch (_) {}
      Promise.resolve()
        .then(() =>
          App.resolveServerMediaAttachment(encAtt, {
            messageId: aadMessageId,
            sender: aadSender,
            recipient: aadRecipient,
          }),
        )
        .then(async (resolved) => {
          try {
            const sha = encAtt.cipher && encAtt.cipher.sha256 ? String(encAtt.cipher.sha256) : '';
            if (sha) console.log('[MEDIA/SYNC] MEDIA_SYNC_COMPLETE sha256=' + sha.slice(0, 16) + ' peer=' + String(hydratePeer || '').slice(0, 8));
            console.log('MEDIA_FALLBACK_TRACE stage=RECIPIENT_MEDIA_VERIFIED attachmentId=' + String(encAtt.attachmentId || '').replace(/[^0-9a-f]/g, '').slice(0, 8) + ' sha=' + sha.slice(0, 8) + ' bytes=' + ((resolved && resolved.blob && resolved.blob.size) || 0));
            const plainMime = String((resolved && resolved.blob && resolved.blob.type) || encAtt._plainMime || (encAtt.media && encAtt.media.mime) || '');
            if (/^image\//i.test(plainMime)) {
              console.log('IMAGE_EVENT_RECEIVED');
              console.log('IMAGE_DESCRIPTOR_VERIFIED');
              console.log('IMAGE_CIPHERTEXT_AVAILABLE');
              console.log('IMAGE_DECRYPTED');
              let plainSha = '';
              if (resolved && resolved.blob && typeof App.hashMediaCiphertext === 'function') {
                plainSha = await App.hashMediaCiphertext(new Uint8Array(await resolved.blob.arrayBuffer()));
              }
              console.log('IMAGE_HASH_VERIFIED sha256=' + String(plainSha || '').slice(0, 16));
              if (resolved && resolved.blob && typeof App.persistChatP2PMedia === 'function') {
                const cacheKey = typeof App.encryptedMediaCacheKey === 'function' ? await App.encryptedMediaCacheKey(encAtt) : '';
                if (cacheKey) await App.persistChatP2PMedia(cacheKey, resolved.blob, { name: encAtt.name || 'image', type: plainMime });
              }
              console.log('IMAGE_VISIBLE');
              console.log('IMAGE_PERSISTED');
            }
          } catch (_sha) {}
          try {
            if (typeof App.renderMessages === 'function') {
              App.renderMessages(hydratePeer, { force: true });
            }
          } catch (_re) {}
        })
        .catch((hydrateErr) => {
          try {
            console.warn(
              '[MEDIA/SERVER-E2EE] resolve failed code=' +
                String((hydrateErr && hydrateErr.code) || 'RESOLVE_FAILED'),
            );
          } catch (_e) {}
        });
    }

    // חלק Auto-download טורנט (chat-service.js) – גם הודעת attachment עם magnetURI מפעילה הורדה אוטומטית ללא לחיצה | HYPER CORE TECH
    if (!isSelfMessage && isRecentAutoStartEvent && parsedPayload?.attachment?.isTorrent && parsedPayload?.attachment?.magnetURI && typeof App.torrentTransfer?.handleIncomingRequest === 'function') {
      try {
        const att = parsedPayload.attachment;
        // חלק dedup הורדה אוטומטית (chat-service.js) – סימון magnet שכבר טופל אוטומטית כדי למנוע הורדה כפולה ב-UI | HYPER CORE TECH
        if (!App._autoStartedTorrentMagnets) {
          App._autoStartedTorrentMagnets = new Set();
        }
        if (App._autoStartedTorrentMagnets.has(att.magnetURI)) {
          console.log('[CHAT/TORRENT] ⏭️ Magnet already auto-started in service, skipping duplicate start');
        } else {
          App._autoStartedTorrentMagnets.add(att.magnetURI);
          const autoTorrentRequest = {
            type: 'torrent-transfer-request',
            transferId: att.id || event.id,
            magnetURI: att.magnetURI,
            infoHash: att.infoHash || '',
            fileName: att.name || 'file',
            fileSize: typeof att.size === 'number' ? att.size : 0,
            timestamp: event.created_at || Date.now(),
          };
          console.log('[CHAT/TORRENT] ⚡ Auto-start from attachment magnetURI', {
            from: sender.slice(0, 8),
            size: autoTorrentRequest.fileSize,
          });
          App.torrentTransfer.handleIncomingRequest(sender, autoTorrentRequest);
        }
      } catch (attErr) {
        console.warn('[CHAT/TORRENT] attachment auto-download failed:', attErr);
      }
    }

    const normalizedMessage = {
      id: event.id,
      from: bubbleFrom,
      to: bubbleTo,
      content: parsedPayload.displayText || (isE2eeContent ? '' : event.content),
      attachment: parsedPayload.attachment || null,
      createdAt: eventTs,
      direction: bubbleDirection,
      source: 'NOSTR',
      transport: 'NOSTR',
      signer: sender,
    };
    if (logicalMessageId) {
      normalizedMessage.logicalMessageId = logicalMessageId;
    }
    normalizedMessage.routeKind = route.kind;

    let selfEchoDeduped = false;
    if (event.id && typeof App.getChatMessages === 'function') {
      try {
        const existing = App.getChatMessages(bubblePeer) || [];
        selfEchoDeduped = existing.some((m) => m && (
          m.id === event.id ||
          (logicalMessageId && (m.logicalMessageId === logicalMessageId || m.id === logicalMessageId))
        ));
      } catch (_e) { /* ignore */ }
    }
    if (selfEchoDeduped) {
      try {
        console.log(
          '[CHAT/E2EE] self-echo deduped peer=' +
            String(bubblePeer || '').slice(0, 8) +
            ' event=' +
            String(event.id || '').slice(0, 8),
        );
      } catch (_logErr) {}
      return;
    }

    try { console.log('[CHAT/ROUTE] kind=' + route.kind + ' peer=' + String(bubblePeer || '').slice(0, 8) + ' event=' + String(event.id || '').slice(0, 8)); } catch (_route) {}
    try { console.log('[CHAT/SEND] RECIPIENT_UI_COMMITTED event=' + String(event.id || '').slice(0, 8) + ' peer=' + String(bubblePeer || '').slice(0, 8)); } catch (_ui) {}
    App.appendChatMessage(normalizedMessage);
    if (
      bubbleDirection === 'incoming' &&
      !inboundSync &&
      !onDevice &&
      route.kind !== 'SELF_CONVERSATION' &&
      ((parsedPayload.displayText && String(parsedPayload.displayText).length) || parsedPayload.attachment) &&
      App.SosCryptoSigner &&
      typeof App.SosCryptoSigner.hasIdentityKey === 'function' &&
      App.SosCryptoSigner.hasIdentityKey()
    ) {
      // FANOUT_ALL_LOGICAL — text, voice, images and documents share one device copy.
      const inboundWire = parsedPayload.attachment && typeof App.buildEncryptedAttachmentWireDescriptor === 'function'
        ? App.buildEncryptedAttachmentWireDescriptor(parsedPayload.attachment)
        : (parsedPayload.attachment || null);
      publishAuthorizedDeviceCopies(
        accountUser,
        logicalMessageId || normalizedMessage.id,
        parsedPayload.displayText || '',
        inboundWire,
        eventTs,
        bubbleFrom,
        'inbound',
      ).catch(() => {});
    }

    // חלק P2P auto-connect (chat-service.js) – כשמגיעה הודעה חדשה דרך relay מ-peer שאין איתו DC,
    // מתחיל חיבור DataChannel ברקע כדי שההודעה הבאה תעבור P2P ישירות | HYPER CORE TECH
    if (bubbleDirection === 'incoming' && messageAgeSec < 120 && App.dataChannel && typeof App.dataChannel.connect === 'function') {
      const owners = (typeof window !== 'undefined' && window.__sosVerifiedDeviceOwners) || {};
      const p2pPeer = owners && typeof owners[String(bubblePeer || '').toLowerCase()] === 'string'
        ? String(owners[String(bubblePeer).toLowerCase()]).toLowerCase()
        : bubblePeer;
      if (p2pPeer && p2pPeer !== String(bubblePeer || '').toLowerCase()) {
        try { console.log('[CHAT/P2P-AUTO] skip device endpoint ' + String(bubblePeer).slice(0, 8)); } catch (_skip) {}
      }
      const dcConnected = typeof App.dataChannel.isConnected === 'function' && App.dataChannel.isConnected(p2pPeer);
      if (!dcConnected && p2pPeer) {
        try {
          App.dataChannel.init?.();
          App.dataChannel.connect(p2pPeer);
          console.log('[CHAT/P2P-AUTO] ⚡ auto-connect DC for', p2pPeer.slice(0, 8), '(relay msg received)');
        } catch (_e) { /* שקט — לא קריטי */ }
      }
    }
    
    // חלק Push (chat-service.js) – שליחת התראת Push רק להודעות חדשות (לא ישנות מריליי) | HYPER CORE TECH
    // בדיקה: הודעה נחשבת "חדשה" אם נוצרה בדקה האחרונה מעכשיו
    const isRecentMessage = messageAgeSec < 60; // הודעה מהדקה האחרונה
    
    if (bubbleDirection === 'incoming' && route.kind !== 'SELF_CONVERSATION' && isRecentMessage && typeof App.triggerChatMessagePush === 'function') {
      App.triggerChatMessagePush(normalizedMessage);
    }
    
    if (typeof App.setChatLastSyncTs === 'function') {
      const currentSync = App.getChatLastSyncTs?.() || 0;
      if (eventTs > currentSync) {
        App.setChatLastSyncTs(eventTs);
      }
    }
  }

  // חלק מחיקה דו-צדדית (chat-service.js) – טיפול באירוע מחיקה kind 5 מכל צד | HYPER CORE TECH
  function handleIncomingDeletion(event) {
    if (!Array.isArray(event?.tags)) {
      return;
    }
    const actor = event.pubkey?.toLowerCase?.();
    const self = App.publicKey?.toLowerCase?.() || '';
    const isSelf = actor === self;
    const targets = [];
    let pTagPubkey = null;
    event.tags.forEach((tag) => {
      if (!Array.isArray(tag)) {
        return;
      }
      if (tag[0] === 'e' && typeof tag[1] === 'string') {
        if (targets.length >= MAX_DELETE_E_TAGS) {
          return;
        }
        if (tag[1].length > 128) {
          return;
        }
        targets.push(tag[1]);
      }
      if (tag[0] === 'p' && typeof tag[1] === 'string') {
        pTagPubkey = tag[1].toLowerCase();
      }
    });
    if (!targets.length) {
      return;
    }
    if (Array.isArray(event.tags) && event.tags.filter((t) => Array.isArray(t) && t[0] === 'e').length > MAX_DELETE_E_TAGS) {
      console.warn('[SECURITY/PARSE_REJECT] kind=5 reason=too_many_e_tags');
    }
    
    // חלק מחיקה דו-צדדית (chat-service.js) – קביעת הפיר הנכון לפי מי שלח את אירוע המחיקה | HYPER CORE TECH
    // אם אני מחקתי - הפיר הוא מי שב-p tag
    // אם מישהו אחר מחק - הפיר הוא מי ששלח את אירוע המחיקה (actor)
    const conversationPeer = isSelf ? pTagPubkey : actor;
    
    targets.forEach((messageId) => {
      // מנסים למחוק מהשיחה עם הפיר הנכון (כולל התאמת p2p-send/p2p-recv לפי fileId) | HYPER CORE TECH
      App.removeChatMessage(conversationPeer, messageId);
    });
    
    const eventTs = typeof event.created_at === 'number' ? event.created_at : Math.floor(Date.now() / 1000);
    if (typeof App.setChatLastSyncTs === 'function') {
      const currentSync = App.getChatLastSyncTs?.() || 0;
      if (eventTs > currentSync) {
        App.setChatLastSyncTs(eventTs);
      }
    }
    
    // חלק הגבלת לוג (chat-service.js) — מדפיס רק 5 מחיקות ראשונות ואח"כ כל 20 למניעת שטפון | HYPER CORE TECH
    if (!handleIncomingDeletion._count) handleIncomingDeletion._count = 0;
    handleIncomingDeletion._count++;
    if (handleIncomingDeletion._count <= 5 || handleIncomingDeletion._count % 20 === 0) {
      console.log('[CHAT] Deletion processed:', targets.length, 'messages from', conversationPeer?.slice(0, 8),
        handleIncomingDeletion._count > 5 ? `(total: ${handleIncomingDeletion._count})` : '');
    }
  }

  // חלק אבטחה (chat-service.js) – strict hash+sig לפני כל handler | HYPER CORE TECH
  function verifyIncomingChatRelayEvent(event) {
    let kindLabel = '';
    let idLabel = '';
    try {
      kindLabel = event && event.kind != null ? event.kind : '';
      idLabel = event && event.id ? String(event.id).slice(0, 8) : '';
      const strict = (typeof App.strictVerifyNostrEvent === 'function')
        ? App.strictVerifyNostrEvent
        : (window.NostrEventIntegrity && window.NostrEventIntegrity.strictVerifyNostrEvent);
      if (typeof strict !== 'function' || strict(event) !== true) {
        console.warn('[SO-CALL SECURITY] rejected invalid signed event kind=' + kindLabel + ' id=' + idLabel);
        return false;
      }
      return true;
    } catch (_err) {
      console.warn('[SO-CALL SECURITY] rejected invalid signed event kind=' + kindLabel + ' id=' + idLabel);
      return false;
    }
  }

  function applyVerifiedIncomingChatRelayEvent(event) {
    if (!event) return;
    if (!verifyIncomingChatRelayRecipient(event)) {
      return;
    }
    chatLastSignalAt = Date.now();
    if (event.kind === READ_RECEIPT_KIND) {
      Promise.resolve(handleIncomingReadReceipt(event)).catch(() => {});
      return;
    }
    if (event.kind === PRESENCE_KIND) {
      try {
        if (typeof App.handleIncomingPresenceEvent === 'function') {
          App.handleIncomingPresenceEvent(event);
        }
      } catch (_) {}
      return;
    }
    return handleIncomingChatEvent(event);
  }

  function ingestIncomingChatRelayEvent(event) {
    const Integrity = window.NostrEventIntegrity;
    if (Integrity && typeof Integrity.enqueueStrictVerify === 'function') {
      return Integrity.enqueueStrictVerify(event, { priority: 'high' }).then((result) => {
        if (!result || result.ok !== true || !result.snapshot) return null;
        return applyVerifiedIncomingChatRelayEvent(result.snapshot);
      }).catch(() => null);
    }
    if (!verifyIncomingChatRelayEvent(event)) return null;
    return applyVerifiedIncomingChatRelayEvent(event);
  }

  // חלק אבטחה (chat-service.js) – אימות נמען מקומי לאירועי ריליי שאינם של המשתמש הנוכחי | HYPER CORE TECH
  function getIncomingChatRelayRecipient(event) {
    const tags = event && Array.isArray(event.tags) ? event.tags : [];
    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i];
      if (Array.isArray(tag) && tag[0] === 'p') {
        return typeof tag[1] === 'string' ? tag[1].toLowerCase() : '';
      }
    }
    return '';
  }

  function verifyIncomingChatRelayRecipient(event) {
    let kindLabel = '';
    let idLabel = '';
    try {
      kindLabel = event && event.kind != null ? event.kind : '';
      idLabel = event && event.id ? String(event.id).slice(0, 8) : '';
      const self = App.publicKey?.toLowerCase?.() || '';
      const sender = event && typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : '';
      const linked = typeof App.getAccountSession === 'function' ? App.getAccountSession() : null;
      const device = linked && linked.role === 'LINKED_DEVICE' && linked.verified ? String(linked.deviceSignPub || '') : '';
      const selves = [self];
      if (device && device !== self) selves.push(device);
      if (!self || !sender) {
        console.warn('[SO-CALL SECURITY] rejected event for wrong recipient kind=' + kindLabel + ' id=' + idLabel);
        return false;
      }
      if (selves.indexOf(sender) !== -1) {
        return true;
      }
      const recipient = getIncomingChatRelayRecipient(event);
      if (!recipient || selves.indexOf(recipient) === -1) {
        console.warn('[SO-CALL SECURITY] rejected event for wrong recipient kind=' + kindLabel + ' id=' + idLabel);
        return false;
      }
      return true;
    } catch (_err) {
      console.warn('[SO-CALL SECURITY] rejected event for wrong recipient kind=' + kindLabel + ' id=' + idLabel);
      return false;
    }
  }

  function stopPrivateChatSubscription(reason) {
    if (activeSubscription && typeof activeSubscription.close === 'function') {
      try { activeSubscription.close(); } catch (_err) { /* ignore */ }
    }
    activeSubscription = null;
    try {
      if (reason) console.log('[E2EE/EPOCH] private chat subscription stopped', reason);
    } catch (_err) { /* ignore */ }
  }

  function resumePrivateChatAfterSecureEpoch() {
    if (typeof App.isSecureChatReady === 'function' && !App.isSecureChatReady()) {
      return;
    }
    ensureChatKeepaliveStarted();
    subscribeToChatEvents();
  }

  let lastAccountChatPullAt = 0;
  let accountPullCursor = 0;
  const accountPullSeen = new Set();
  async function pullRecentAccountChat() {
    const now = Date.now();
    if (now - lastAccountChatPullAt < 4000) return { ok: false, code: 'DEBOUNCED' };
    if (typeof App.isSecureChatReady === 'function' && !App.isSecureChatReady()) return { ok: false, code: 'EPOCH' };
    const pool = App.pool;
    const relays = Array.isArray(App.relayUrls) ? App.relayUrls : [];
    if (!pool || !relays.length || typeof pool.querySync !== 'function') return { ok: false, code: 'NO_POOL' };
    const self = String(App.publicKey || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(self)) return { ok: false, code: 'NO_ACCOUNT' };
    const linked = typeof App.getAccountSession === 'function' ? App.getAccountSession() : null;
    const device = linked && linked.role === 'LINKED_DEVICE' && linked.verified ? String(linked.deviceSignPub || '').toLowerCase() : '';
    const pubs = device && device !== self ? [device] : [self];
    lastAccountChatPullAt = now;
    let events = [];
    try {
      const since = Math.max(getChatRetentionFloorTs(), accountPullCursor > 0 ? accountPullCursor - 5 : 0);
      const result = await pool.querySync(relays, {
        kinds: [CHAT_KIND],
        '#p': pubs,
        '#t': [CHAT_TAG],
        limit: 40,
        since: since,
      });
      events = Array.isArray(result && result.events) ? result.events : (Array.isArray(result) ? result : []);
    } catch (_e) {
      lastAccountChatPullAt = 0;
      return { ok: false, code: 'QUERY_FAILED' };
    }
    let fresh = 0;
    for (let i = 0; i < events.length; i += 1) {
      const ev = events[i];
      const id = ev && ev.id ? String(ev.id) : '';
      if (id && accountPullSeen.has(id)) continue;
      if (id) accountPullSeen.add(id);
      const created = Number(ev && ev.created_at) || 0;
      if (created > accountPullCursor) accountPullCursor = created;
      fresh += 1;
      try { await ingestIncomingChatRelayEvent(ev); } catch (_in) {}
    }
    if (accountPullSeen.size > 500) {
      const keep = Array.from(accountPullSeen).slice(-300);
      accountPullSeen.clear();
      keep.forEach((id) => accountPullSeen.add(id));
    }
    try { console.log('[CHAT/SYNC] ACCOUNT_CHAT_PULL n=' + fresh); } catch (_log) {}
    return { ok: true, n: fresh };
  }

  function subscribeToChatEvents() {
    // חלק אבטחה (chat-service.js) – לא נרשמים לצ'אט פרטי לפני שער epoch מוכן | HYPER CORE TECH
    if (typeof App.isSecureChatReady === 'function' && !App.isSecureChatReady()) {
      try {
        console.log('[E2EE/EPOCH] subscribe blocked state=' + (App.getSecureChatGateState?.() || 'unknown'));
      } catch (_err) { /* ignore */ }
      return;
    }
    try { pullRecentAccountChat(); } catch (_pull) {}
    if (activeSubscription || !ensurePoolReady()) {
      return;
    }
    const normalizedSelf = App.publicKey?.toLowerCase?.() || '';
    if (!normalizedSelf) {
      return;
    }
    const linkedNow = typeof App.getAccountSession === 'function' ? App.getAccountSession() : null;
    const devicePub = linkedNow && linkedNow.role === 'LINKED_DEVICE' && linkedNow.verified ? String(linkedNow.deviceSignPub || '') : '';
    const listenPubs = (devicePub && devicePub !== normalizedSelf) ? [devicePub] : [normalizedSelf];

    const lastSyncTs = typeof App.getChatLastSyncTs === 'function' ? App.getChatLastSyncTs() : 0;
    const retentionFloor = getChatRetentionFloorTs();
    // חלק שמירה 90 יום (chat-service.js) – since לא יורד מתחת ל-90 יום גם במכשיר חדש / רענון | HYPER CORE TECH
    const sinceTs = Math.max(
      Number.isFinite(lastSyncTs) ? lastSyncTs : 0,
      retentionFloor
    );
    const baseFilter = (kinds, extra = {}) => {
      const f = { kinds, limit: 80, since: sinceTs, ...extra };
      return f;
    };

    const filters = [
      baseFilter([CHAT_KIND], { '#p': listenPubs, '#t': [CHAT_TAG] }),
      baseFilter([CHAT_KIND], { authors: listenPubs, '#t': [CHAT_TAG] }),
      baseFilter([5], { authors: listenPubs, '#t': [CHAT_TAG] }),
      baseFilter([5], { '#p': listenPubs, '#t': [CHAT_TAG] }),
      baseFilter([READ_RECEIPT_KIND], { '#p': listenPubs, '#t': [CHAT_TAG] }),
      baseFilter([PRESENCE_KIND], { '#p': listenPubs, '#t': [CHAT_TAG] }),
    ];
    if (devicePub) {
      filters.push(baseFilter([1050], { '#p': [devicePub], '#t': ['sos-hist-v1'] }));
    } else {
      filters.push(baseFilter([1050], { '#p': [normalizedSelf], '#t': ['sos-hist-req'] }));
      filters.push(baseFilter([1050], { '#p': [normalizedSelf], '#t': ['sos-hist-ack'] }));
    }

    if (App.NETWORK_TAG && !devicePub) {
      filters.push(
        baseFilter([CHAT_KIND], { '#t': [App.NETWORK_TAG], authors: [normalizedSelf] }),
        baseFilter([CHAT_KIND], { '#t': [App.NETWORK_TAG], '#p': [normalizedSelf] }),
        baseFilter([5], { '#t': [App.NETWORK_TAG], authors: [normalizedSelf] }),
        baseFilter([5], { '#t': [App.NETWORK_TAG], '#p': [normalizedSelf] }),
        baseFilter([READ_RECEIPT_KIND], { '#t': [App.NETWORK_TAG], '#p': [normalizedSelf] }),
        baseFilter([PRESENCE_KIND], { '#t': [App.NETWORK_TAG], '#p': [normalizedSelf] }),
      );
    }

    activeSubscription = App.pool.subscribeMany(App.relayUrls, filters, {
      onevent: (event) => {
        ingestIncomingChatRelayEvent(event);
      },
      oneose: () => {
        chatLastSignalAt = Date.now();
      },
    });
    setTimeout(() => { reconcileDeviceConversations().catch(() => {}); }, 1500);
  }

  async function accountForOwnedDevice(pk) {
    const raw = String(pk || '').toLowerCase();
    const Session = window.SosAccountSession;
    if (!/^[0-9a-f]{64}$/.test(raw) || !Session || typeof Session.noteOwnedDevices !== 'function' || typeof Session.verifiedAccountOf !== 'function') return raw;
    try { await Session.noteOwnedDevices(); } catch (_e) { return raw; }
    const owner = Session.verifiedAccountOf(raw);
    if (!owner || owner === raw) return raw;
    try { console.log('[MD] PHANTOM_DEVICE_ROUTED peer=' + raw.slice(0, 8) + ' account=' + String(owner).slice(0, 8)); } catch (_log) {}
    return owner;
  }

  // חלק צ'אט (chat-service.js) – רענון חיבור לאחר חזרה מפוקוס/רשת או idle | HYPER CORE TECH
  // חלק debounce (chat-service.js) – מונע re-subscribe אגרסיבי (שלב 3: 12 שנ׳) | HYPER CORE TECH
  let _lastResubAt = 0;
  const RESUB_DEBOUNCE_MS = 12000;
  function forceResubscribeChat(reason) {
    if (!ensurePoolReady()) return;
    try { if (typeof navigator !== 'undefined' && navigator.onLine === false) return; } catch {}
    const now = Date.now();
    if (now - _lastResubAt < RESUB_DEBOUNCE_MS) return;

    // שלב 3: בחזרה לטאב — לא סוגרים מנוי בריא | HYPER CORE TECH
    if (reason === 'visibilitychange' && activeSubscription) {
      const last = chatLastSignalAt || 0;
      if (last && (now - last) < 60000) return;
    }

    _lastResubAt = now;
    if (activeSubscription && typeof activeSubscription.close === 'function') {
      try { activeSubscription.close(); } catch {}
    }
    activeSubscription = null;
    chatLastSignalAt = now;
    subscribeToChatEvents();
    console.log('Chat: resubscribed', reason || '');
  }

  function ensureChatKeepaliveStarted() {
    if (chatSignalKeepaliveTimer) return;
    // חלק keepalive (chat-service.js) – visibilitychange מספיק, focus/pageshow מיותרים ויוצרים כפילויות | HYPER CORE TECH
    try { document.addEventListener('visibilitychange', () => { if (!document.hidden) forceResubscribeChat('visibilitychange'); }); } catch {}
    try { window.addEventListener('online', () => forceResubscribeChat('online')); } catch {}

    chatSignalKeepaliveTimer = setInterval(() => {
      try {
        if (!ensurePoolReady()) return;
        try { if (typeof navigator !== 'undefined' && navigator.onLine === false) return; } catch {}
        if (document.hidden) return;
        const now = Date.now();
        const last = chatLastSignalAt || 0;
        if (!activeSubscription) {
          subscribeToChatEvents();
          return;
        }
        try { pullRecentAccountChat(); } catch (_pull) {}
        if (last && (now - last) > 90000) {
          forceResubscribeChat('keepalive');
        }
      } catch (err) {
        console.warn('Chat keepalive error', err);
      }
    }, 30000);
  }

  function refreshStubChatContacts() {
    const contacts = App.chatState?.contacts;
    if (!(contacts instanceof Map)) return;
    Array.from(contacts.entries())
      .filter(([pk, c]) => /^[0-9a-f]{64}$/.test(pk) && !c?.picture &&
        (!c?.name || /^משתמש( [0-9a-f]{8})?$/i.test(String(c.name).trim())))
      .slice(0, CONTACT_FETCH_LIMIT)
      .forEach(([pk]) => {
        resolveProfile(pk).then((raw) => {
          const profile = normalizeProfileData(raw, pk);
          App.ensureChatContact(pk, { ...profile, profileFetchedAt: Math.floor(Date.now() / 1000) });
        }).catch(() => {});
      });
  }

  async function bootstrapContactsFromFeed() {
    refreshStubChatContacts();
    if (!Array.isArray(App.notifications)) {
      return;
    }
    const recentActors = new Set();
    App.notifications.slice(0, CONTACT_FETCH_LIMIT).forEach((notification) => {
      if (notification?.actorPubkey) {
        recentActors.add(notification.actorPubkey.toLowerCase());
      }
    });
    if (App.eventAuthorById instanceof Map) {
      Array.from(App.eventAuthorById.values())
        .slice(0, CONTACT_FETCH_LIMIT)
        .forEach((pubkey) => {
          if (typeof pubkey === 'string') {
            recentActors.add(pubkey.toLowerCase());
          }
        });
    }
    const selfKey = (App.publicKey || '').toLowerCase();
    recentActors.delete(selfKey);

    const promises = Array.from(recentActors).map(async (pubkey) => {
      const profile = normalizeProfileData(await resolveProfile(pubkey), pubkey);
      App.ensureChatContact(pubkey, profile);
    });

    try {
      await Promise.all(promises);
    } catch (err) {
      console.warn('Bootstrap contacts failed', err);
    }
  }

  function addChatContact(pubkey) {
    if (!pubkey) {
      return null;
    }
    const normalized = pubkey.toLowerCase();
    if (!normalized || normalized.length !== 64) {
      console.warn('Invalid pubkey for chat contact');
      return null;
    }
    const existing = App.chatState.contacts.get(normalized);
    if (existing) {
      return existing;
    }
    const profile = normalizeProfileData(App.profileCache?.get?.(normalized) || {}, normalized);
    const contact = App.ensureChatContact(normalized, profile);
    return contact;
  }

  // חלק חיפוש משתמשים (chat-service.js) – חיפוש לפי שם בפרופילים ברשת (בלי UI חדש) | HYPER CORE TECH
  function parseKind0ToProfile(event) {
    if (!event?.pubkey || typeof event.content !== 'string') return null;
    let meta = {};
    try {
      meta = JSON.parse(event.content || '{}') || {};
    } catch (_) {
      meta = {};
    }
    const pubkey = String(event.pubkey).toLowerCase();
    const name = String(meta.display_name || meta.name || meta.username || '').trim();
    if (!name) return null;
    const picture = typeof meta.picture === 'string' ? meta.picture : '';
    const initials = typeof App.getInitials === 'function' ? App.getInitials(name) : name.slice(0, 2);
    if (App.profileCache instanceof Map) {
      const prev = App.profileCache.get(pubkey) || {};
      App.profileCache.set(pubkey, { ...prev, name, picture, initials, pubkey });
    }
    return { pubkey, name, picture, initials };
  }

  function profileMatchesQuery(profile, query) {
    if (!profile || !query) return false;
    const name = String(profile.name || '').toLowerCase();
    const pubkey = String(profile.pubkey || '').toLowerCase();
    return name.includes(query) || (query.length >= 8 && pubkey.startsWith(query));
  }

  async function listMetadataEvents(filters, timeoutMs = 4500) {
    const pool = App.pool;
    const relays = Array.isArray(App.relayUrls) ? App.relayUrls : [];
    if (!pool || !relays.length) return [];
    try {
      if (typeof pool.list === 'function') {
        return await pool.list(relays, filters);
      }
      if (typeof pool.listMany === 'function') {
        return await pool.listMany(relays, filters);
      }
      if (typeof pool.querySync === 'function') {
        const result = await pool.querySync(relays, filters[0] || {});
        return Array.isArray(result?.events) ? result.events : (Array.isArray(result) ? result : []);
      }
      if (typeof pool.subscribeMany === 'function') {
        return await new Promise((resolve) => {
          const collected = [];
          const sub = pool.subscribeMany(relays, filters, {
            onevent(event) {
              if (event) collected.push(event);
            },
            oneose() {
              try { sub?.close?.(); } catch (_) {}
              resolve(collected);
            },
          });
          setTimeout(() => {
            try { sub?.close?.(); } catch (_) {}
            resolve(collected);
          }, timeoutMs);
        });
      }
    } catch (err) {
      console.warn('[CHAT] listMetadataEvents failed', err);
    }
    return [];
  }

  async function searchProfilesByName(query, options = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (q.length < 2) return [];
    const limit = Math.max(5, Math.min(30, Number(options.limit) || 20));
    const selfKey = String(App.publicKey || '').toLowerCase();
    const byPubkey = new Map();

    const pushProfile = (profile) => {
      if (!profile?.pubkey || profile.pubkey === selfKey) return;
      if (!profileMatchesQuery(profile, q)) return;
      if (byPubkey.has(profile.pubkey)) return;
      byPubkey.set(profile.pubkey, {
        pubkey: profile.pubkey,
        name: profile.name,
        picture: profile.picture || '',
        initials: profile.initials || (typeof App.getInitials === 'function' ? App.getInitials(profile.name) : 'מש'),
        lastMessage: 'התחל שיחה חדשה',
        unreadCount: 0,
        isNetworkResult: true,
      });
    };

    // 1) קאש מקומי – מהיר (כולל מחברי פוסטים שכבר נטענו)
    if (App.profileCache instanceof Map) {
      App.profileCache.forEach((profile, key) => {
        const pubkey = String(profile?.pubkey || key || '').toLowerCase();
        pushProfile({
          pubkey,
          name: profile?.name || profile?.display_name || '',
          picture: profile?.picture || '',
          initials: profile?.initials || '',
        });
      });
    }

    // 2) NIP-50 search אם הריליי תומך
    try {
      const searchFilter = { kinds: [0], search: q, limit: 40 };
      if (App.NETWORK_TAG) searchFilter['#t'] = [App.NETWORK_TAG];
      const searchEvents = await listMetadataEvents([searchFilter], 3500);
      (searchEvents || []).forEach((event) => pushProfile(parseKind0ToProfile(event)));
    } catch (err) {
      console.warn('[CHAT] NIP-50 profile search failed', err);
    }

    // 3) גיבוי: סריקת מטא־דאטה אחרונה וסינון לפי שם
    if (byPubkey.size < 5) {
      try {
        const recentFilter = { kinds: [0], limit: 400 };
        if (App.NETWORK_TAG) recentFilter['#t'] = [App.NETWORK_TAG];
        let events = await listMetadataEvents([recentFilter], 5000);
        if ((!events || !events.length) && App.NETWORK_TAG) {
          // חלק חיפוש (chat-service.js) – גיבוי בלי תג רשת לפרופילים ישנים | HYPER CORE TECH
          events = await listMetadataEvents([{ kinds: [0], limit: 400 }], 5000);
        }
        (events || [])
          .filter((evt) => evt && typeof evt.created_at === 'number')
          .sort((a, b) => b.created_at - a.created_at)
          .forEach((event) => pushProfile(parseKind0ToProfile(event)));
      } catch (err) {
        console.warn('[CHAT] fallback profile scan failed', err);
      }
    }

    return Array.from(byPubkey.values()).slice(0, limit);
  }

  // חלק המתנה לקאש (chat-service.js) – ממתין לטעינת lastSyncTs לפני סנכרון | HYPER CORE TECH
  async function handlePoolReady() {
    const pool = ensurePoolReady();
    if (!pool) {
      return;
    }
    
    // המתנה לטעינת הקאש מ-IndexedDB לפני שמתחילים לסנכרן
    // זה מונע איפוס של lastSyncTs ל-0 וטעינה מחדש של כל ההיסטוריה
    if (App.chatStateReady && typeof App.chatStateReady.then === 'function') {
      try {
        await App.chatStateReady;
        console.log('[CHAT/SERVICE] State restored, lastSyncTs:', App.getChatLastSyncTs?.() || 0);
      } catch (err) {
        console.warn('[CHAT/SERVICE] Failed to wait for state restore', err);
      }
    }

    // חלק אבטחה (chat-service.js) – שער epoch לפני subscribe/history | HYPER CORE TECH
    if (typeof App.ensureSecureChatEpochReady === 'function') {
      let epochReady = false;
      try {
        epochReady = await App.ensureSecureChatEpochReady();
      } catch (err) {
        console.warn('[E2EE/EPOCH] gate evaluation failed', err);
        epochReady = typeof App.isSecureChatReady === 'function' ? App.isSecureChatReady() : false;
      }
      if (!epochReady) {
        console.log('[E2EE/EPOCH] chat bootstrap deferred state=' + (App.getSecureChatGateState?.() || 'unknown'));
        return;
      }
    }
    
    ensureChatKeepaliveStarted();
    subscribeToChatEvents();
    bootstrapContactsFromFeed();
    try { drainPendingReadReceipts(); } catch (_) {}

    // חלק P2P pre-connect (chat-service.js) – 10 שניות אחרי אתחול, מחבר DC ל-5 אנשי קשר אחרונים | HYPER CORE TECH
    setTimeout(() => {
      try {
        if (!App.dataChannel || typeof App.dataChannel.connect !== 'function') return;
        if (App.guestMode) return;
        const contacts = typeof App.getChatContacts === 'function' ? App.getChatContacts() : [];
        const DC_PRECONNECT_COUNT = 5;
        let connected = 0;
        for (let i = 0; i < contacts.length && connected < DC_PRECONNECT_COUNT; i++) {
          const pk = contacts[i]?.pubkey;
          if (!pk || pk.length !== 64) continue;
          const alreadyConnected = typeof App.dataChannel.isConnected === 'function' && App.dataChannel.isConnected(pk);
          if (alreadyConnected) continue;
          App.dataChannel.init?.();
          App.dataChannel.connect(pk);
          connected++;
        }
        if (connected > 0) {
          console.log('[CHAT/P2P-AUTO] 🔗 pre-connected DC for', connected, 'top contacts');
        }
      } catch (_e) { /* שקט — לא קריטי */ }
    }, 10000);
  }

  const previousNotifyPoolReady = App.notifyPoolReady;
  App.notifyPoolReady = function notifyPoolReadyBridge(pool) {
    if (typeof previousNotifyPoolReady === 'function') {
      try {
        previousNotifyPoolReady(pool);
      } catch (err) {
        console.warn('Previous notifyPoolReady handler failed', err);
      }
    }
    if (pool) {
      App.pool = pool;
    }
    handlePoolReady();
  };

  // חלק אישורי קריאה (chat-service.js) – שליחת אישור קריאה לצד השני כשפותחים שיחה | HYPER CORE TECH
  const READ_RECEIPT_KIND = 1051; // kind מיוחד לאישורי קריאה
  const PRESENCE_KIND = typeof App.PRESENCE_KIND === 'number' ? App.PRESENCE_KIND : 1054;
  const inFlightReceiptIds = new Set();

  function buildReadReceipt(peerPubkey, lastReadTs, lastReadMessageId) {
    const self = String(App.publicKey || '').toLowerCase();
    const to = String(peerPubkey || '').toLowerCase();
    const lastReadAt = lastReadTs || Math.floor(Date.now() / 1000);
    const boundaryId = typeof App.normalizeReceiptBoundaryId === 'function'
      ? App.normalizeReceiptBoundaryId(lastReadMessageId || '')
      : String(lastReadMessageId || '');
    const receiptId = typeof App.buildChatReadReceiptId === 'function'
      ? App.buildChatReadReceiptId(self, to, boundaryId, lastReadAt)
      : ('rr-' + self.slice(0, 16) + '-' + to.slice(0, 16) + '-' + (boundaryId || ('ts-' + lastReadAt)));
    return {
      type: 'chat_read_receipt',
      receiptId,
      from: self,
      to,
      lastReadAt,
      lastReadMessageId: boundaryId || '',
    };
  }

  function canUseNostrPool() {
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    } catch (_) {}
    const pool = ensurePoolReady();
    return !!(pool && App.SosCryptoSigner?.hasIdentityKey() && typeof App.SosCryptoSigner.signReadReceipt === 'function');
  }

  // Secure P2P v2: DC receipt identity is the authenticated session peer, not payload.from.
  // Wire omits free-form `from` so receivers never treat it as authority.
  function buildDcReadReceiptWire(receipt) {
    if (!receipt) return null;
    return {
      type: 'chat_read_receipt',
      receiptId: receipt.receiptId,
      to: receipt.to,
      lastReadAt: receipt.lastReadAt,
      lastReadMessageId: receipt.lastReadMessageId || '',
    };
  }

  function resolveP2pDcReceiptSender(event, authenticatedPeerPubkey) {
    const auth = String(authenticatedPeerPubkey || '').toLowerCase();
    if (!auth || auth.length < 16) {
      return { ok: false, reason: 'unknown_peer' };
    }
    const claimed = String((event && event.from) || '').toLowerCase();
    if (claimed && claimed !== auth) {
      return { ok: false, reason: 'from_mismatch' };
    }
    return { ok: true, sender: auth };
  }

  function sendReceiptOverDc(receipt) {
    if (!receipt || !App.dataChannel) return false;
    if (typeof App.dataChannel.isConnected === 'function' && !App.dataChannel.isConnected(receipt.to)) return false;
    const wire = buildDcReadReceiptWire(receipt) || receipt;
    if (typeof App.dataChannel.sendJson === 'function') {
      return !!App.dataChannel.sendJson(receipt.to, wire);
    }
    if (typeof App.dataChannel.send === 'function') {
      return !!App.dataChannel.send(receipt.to, wire);
    }
    return false;
  }

  function sendReceiptOverMesh(receipt) {
    try {
      if (window.SOSEmergency && typeof window.SOSEmergency.sendMeshReadReceipt === 'function') {
        return !!window.SOSEmergency.sendMeshReadReceipt(receipt);
      }
    } catch (_) {}
    return false;
  }

  async function sendReceiptOverNostr(receipt) {
    const pool = ensurePoolReady();
    if (!pool || !receipt || App.guestMode) return false;
    if (!App.SosCryptoSigner?.hasIdentityKey() || typeof App.SosCryptoSigner.signReadReceipt !== 'function') return false;
    const tags = [
      ['p', receipt.to],
      ['t', CHAT_TAG],
    ];
    // C0: read receipts for DMs are global identity-to-identity.
    const receiptBody = {
      type: 'chat_read_receipt',
      receiptId: receipt.receiptId,
      lastReadAt: receipt.lastReadAt,
      lastReadMessageId: receipt.lastReadMessageId || '',
    };
    let content = JSON.stringify(receiptBody);
    const mustEncrypt = typeof App.isE2eeSendRequired === 'function' && App.isE2eeSendRequired() === true;
    if (mustEncrypt) {
      if (!App.SosCryptoSigner?.hasIdentityKey() || !App.publicKey || typeof App.SosCryptoSigner.nip44ChatEncrypt !== 'function') return false;
      try {
        const envelope = await Promise.resolve(App.SosCryptoSigner.nip44ChatEncrypt({
          senderPubkey: App.publicKey,
          recipientPubkey: receipt.to,
          payload: {
            messageId: receipt.receiptId,
            sender: App.publicKey,
            recipient: receipt.to,
            createdAt: Math.floor(Date.now() / 1000),
            text: content,
            attachment: null,
          },
        }));
        content = JSON.stringify(envelope);
      } catch (_encErr) {
        return false;
      }
    }
    try {
      const signed = await Promise.resolve(App.SosCryptoSigner.signReadReceipt({
        kind: READ_RECEIPT_KIND,
        pubkey: App.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content,
      }));
      const results = pool.publish(App.relayUrls, signed);
      await Promise.allSettled(results);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function transmitReadReceipt(receipt) {
    if (!receipt || !receipt.to) return false;
    if (sendReceiptOverDc(receipt)) return true;
    if (sendReceiptOverMesh(receipt)) return true;
    if (canUseNostrPool() && await sendReceiptOverNostr(receipt)) return true;
    return false;
  }

  async function sendReadReceipt(peerPubkey, lastReadTs, lastReadMessageId) {
    if (!peerPubkey || App.guestMode) return;
    const receipt = buildReadReceipt(peerPubkey, lastReadTs, lastReadMessageId);
    if (inFlightReceiptIds.has(receipt.receiptId)) return;
    inFlightReceiptIds.add(receipt.receiptId);
    try {
      const sent = await transmitReadReceipt(receipt);
      if (!sent && typeof App.queuePendingReadReceipt === 'function') {
        App.queuePendingReadReceipt(receipt.to, receipt);
      }
    } finally {
      inFlightReceiptIds.delete(receipt.receiptId);
    }
  }

  async function drainPendingReadReceipts(peerPubkey) {
    const rows = typeof App.getPendingReadReceipts === 'function' ? App.getPendingReadReceipts() : [];
    const target = peerPubkey ? String(peerPubkey).toLowerCase() : '';
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || (target && row.peer !== target)) continue;
      const receipt = buildReadReceipt(row.peer, row.lastReadAt, row.lastReadMessageId);
      receipt.receiptId = row.receiptId || receipt.receiptId;
      const sent = await transmitReadReceipt(receipt);
      if (sent && typeof App.takePendingReadReceipt === 'function') {
        App.takePendingReadReceipt(row.peer);
      }
    }
  }
  
  // חלק אישורי קריאה (chat-service.js) – טיפול באישור קריאה נכנס - מעדכן סטטוס הודעות ל"נקרא" | HYPER CORE TECH
  async function readReceiptFromRelayEvent(event) {
    const raw = String(event.content || '');
    const encrypted = typeof App.looksLikeSosE2eeEnvelope === 'function' && App.looksLikeSosE2eeEnvelope(raw);
    if (encrypted) {
      if (typeof App.SosCryptoSigner?.nip44ChatDecrypt !== 'function' || !App.SosCryptoSigner?.hasIdentityKey() || !App.publicKey) return null;
      try {
        const inner = await Promise.resolve(App.SosCryptoSigner.nip44ChatDecrypt({
          localPubkey: App.publicKey,
          eventAuthorPubkey: event.pubkey,
          encryptedEnvelope: raw,
        }));
        return JSON.parse(String(inner && inner.text ? inner.text : '{}'));
      } catch (_err) {
        console.warn('[SECURITY/PARSE_REJECT] kind=1051 reason=decrypt-failed');
        return null;
      }
    }
    const mustEncrypt = typeof App.isE2eeSendRequired === 'function' && App.isE2eeSendRequired() === true;
    if (mustEncrypt) {
      console.warn('[SECURITY/PARSE_REJECT] kind=1051 reason=plaintext-receipt');
      return null;
    }
    try {
      return JSON.parse(raw || '{}');
    } catch (_err) {
      return null;
    }
  }

  async function handleIncomingReadReceipt(event, bindOpts) {
    if (!event) return;
    const self = App.publicKey?.toLowerCase?.() || '';
    const bind = bindOpts && typeof bindOpts === 'object' ? bindOpts : null;
    const authPeer = bind
      ? String(bind.authenticatedPeerPubkey || bind.dcPeer || '').toLowerCase()
      : '';
    const isP2pDc = !!(bind && (bind.transport === 'p2p-dc' || bind.requireAuthenticatedPeer === true || authPeer));
    let sender = '';
    let recipient = '';
    let lastReadAt = 0;
    let lastReadMessageId = '';
    let receiptId = '';
    if (event.type === 'chat_read_receipt' || (!event.kind && (event.lastReadAt || event.lastReadMessageId))) {
      recipient = String(event.to || '').toLowerCase();
      lastReadAt = Number(event.lastReadAt) || 0;
      lastReadMessageId = String(event.lastReadMessageId || '');
      receiptId = String(event.receiptId || '');
      if (isP2pDc) {
        // Control-plane only: O(1) bind to authenticated DC peer. Never trust payload.from.
        const resolved = resolveP2pDcReceiptSender(event, authPeer);
        if (!resolved.ok) {
          console.warn('[SECURITY/PARSE_REJECT] kind=dc type=chat_read_receipt reason=' + resolved.reason);
          return;
        }
        sender = resolved.sender;
      } else {
        // Non-DC transports (e.g. emergency mesh) keep prior payload.from binding.
        sender = String(event.from || '').toLowerCase();
      }
    } else if (event.kind === READ_RECEIPT_KIND) {
      sender = event.pubkey?.toLowerCase?.() || '';
      const pTag = event.tags?.find?.(t => Array.isArray(t) && t[0] === 'p');
      recipient = pTag?.[1]?.toLowerCase?.() || '';
      const data = await readReceiptFromRelayEvent(event);
      if (!data) return;
      lastReadAt = Number(data.lastReadAt) || 0;
      lastReadMessageId = String(data.lastReadMessageId || '');
      receiptId = String(data.receiptId || '');
    } else {
      return;
    }
    if (!sender || sender === self) return;
    if (recipient && recipient !== self) return;
    if (!lastReadAt && !lastReadMessageId) return;
    if (lastReadAt && (!Number.isFinite(lastReadAt) || lastReadAt <= 0 || lastReadAt > Math.floor(Date.now() / 1000) + 86400)) {
      console.warn('[SECURITY/PARSE_REJECT] kind=1051 reason=bad_lastReadAt');
      return;
    }
    if (receiptId && receiptId.length > 256) {
      console.warn('[SECURITY/PARSE_REJECT] kind=1051 reason=bad_receiptId');
      return;
    }
    if (lastReadMessageId && lastReadMessageId.length > 256) {
      console.warn('[SECURITY/PARSE_REJECT] kind=1051 reason=bad_message_id');
      return;
    }
    if (!allowIngressBucket(receiptIngressBuckets, sender, RECEIPT_INGRESS_WINDOW_MS, RECEIPT_INGRESS_MAX_PER_PEER)) {
      console.warn('[SECURITY/RATE_DROP] type=1051 peer=' + sender.slice(0, 8) + ' reason=receipt_burst');
      return;
    }
    if (typeof App.applyIncomingReadReceipt === 'function') {
      const applied = App.applyIncomingReadReceipt({
        from: sender,
        to: recipient || self,
        lastReadAt,
        lastReadMessageId,
        receiptId,
      });
      if (!handleIncomingReadReceipt._count) handleIncomingReadReceipt._count = 0;
      handleIncomingReadReceipt._count++;
      if (handleIncomingReadReceipt._count <= 5 || handleIncomingReadReceipt._count % 20 === 0) {
        let token = 'READ_RECEIPT_APPLIED';
        if (applied && applied.duplicate) token = 'READ_RECEIPT_DUPLICATE_IGNORED';
        else if (applied && applied.sameBoundary) token = 'READ_RECEIPT_SAME_BOUNDARY_APPLIED';
        else if (applied && applied.pending) token = 'READ_RECEIPT_PENDING_BOUNDARY';
        else if (applied && applied.ignored && applied.reason === 'regress') token = 'READ_RECEIPT_TRUE_REGRESS_IGNORED';
        else if (applied && applied.applied) token = 'READ_RECEIPT_APPLIED';
        const canon = typeof App.normalizeReceiptBoundaryId === 'function'
          ? App.normalizeReceiptBoundaryId(lastReadMessageId)
          : String(lastReadMessageId || '');
        const prefix = (value) => {
          const text = String(value || '');
          return text ? text.slice(0, 16) : 'none';
        };
        let extra = lastReadMessageId ? 'id-boundary' : 'ts-boundary';
        if (token === 'READ_RECEIPT_PENDING_BOUNDARY') {
          extra = 'boundary=' + (canon ? canon.slice(0, 32) : 'none') + ' local boundary-found=false';
        } else if (token === 'READ_RECEIPT_TRUE_REGRESS_IGNORED') {
          extra = 'currentBoundaryPrefix=' + prefix(applied && applied.currentBoundary)
            + ' currentIdx=' + String(applied && applied.currentIdx)
            + ' currentAt=' + String(applied && applied.currentAt || 0)
            + ' nextBoundaryPrefix=' + prefix(applied && applied.nextBoundary)
            + ' nextIdx=' + String(applied && applied.nextIdx)
            + ' nextAt=' + String(applied && applied.nextAt || 0)
            + ' boundaryFound=' + (applied && applied.boundaryFound ? 'true' : 'false');
        }
        console.log('[CHAT]', token, 'from', sender.slice(0, 8),
          extra,
          receiptId ? ('id=' + receiptId.slice(0, 24)) : '',
          handleIncomingReadReceipt._count > 5 ? `(total: ${handleIncomingReadReceipt._count})` : '');
      }
    }
  }

  // חלק רענון שיחות (chat-service.js) – פונקציה לסנכרון מחדש של כל היסטוריית הצ'אט | HYPER CORE TECH
  async function syncChatHistory() {
    // איפוס חותמת הזמן כדי לטעון את כל ההיסטוריה
    if (typeof App.setChatLastSyncTs === 'function') {
      App.setChatLastSyncTs(0);
    }
    
    // סגירת ההרשמה הקיימת
    if (activeSubscription && typeof activeSubscription.close === 'function') {
      try { activeSubscription.close(); } catch {}
    }
    activeSubscription = null;
    
    // המתנה קצרה לפני התחברות מחדש
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // הרשמה מחדש לאירועי צ'אט - יטען את כל ההיסטוריה
    subscribeToChatEvents();
    
    // טעינת אנשי קשר מהפיד
    bootstrapContactsFromFeed();
    
    console.log('[CHAT/SERVICE] Full chat history sync initiated');
  }

  async function reconcileDeviceConversations() {
    const Session = window.SosAccountSession;
    if (!Session || typeof Session.noteOwnedDevices !== 'function' || typeof App.mergeDeviceConversationIntoAccount !== 'function') {
      return { ok: false, n: 0 };
    }
    try { await Session.noteOwnedDevices(); } catch (_e) { return { ok: false, n: 0 }; }
    const contacts = typeof App.getChatContacts === 'function' ? App.getChatContacts() : [];
    const self = String(App.publicKey || '').toLowerCase();
    let n = 0;
    for (let i = 0; i < contacts.length; i += 1) {
      const pk = String(contacts[i] && contacts[i].pubkey || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(pk) || pk === self) continue;
      const owner = typeof Session.verifiedAccountOf === 'function' ? Session.verifiedAccountOf(pk) : '';
      if (!owner || owner === pk) continue;
      const merged = App.mergeDeviceConversationIntoAccount(pk, owner);
      if (merged && merged.ok) {
        n += 1;
        try { console.log('[MD] PHANTOM_CONTACT_MERGED peer=' + pk.slice(0, 8) + ' account=' + owner.slice(0, 8) + ' moved=' + merged.moved); } catch (_log) {}
      }
    }
    return { ok: true, n: n };
  }

  async function syncOwnedMediaToLinkedDevices(peer, file, logicalId) {
    const peerNorm = String(peer || '').toLowerCase();
    if (!file || typeof App.uploadMediaForServerFallback !== 'function') return { ok: false, code: 'NO_UPLOAD' };
    const linked = typeof App.getAccountSession === 'function' ? App.getAccountSession() : null;
    const onDevice = !!(linked && linked.role === 'LINKED_DEVICE' && linked.verified === true);
    const primary = !!(App.SosCryptoSigner && typeof App.SosCryptoSigner.hasIdentityKey === 'function' && App.SosCryptoSigner.hasIdentityKey());
    if (!primary && !onDevice) return { ok: false, code: 'NOT_PRIMARY' };
    const id = logicalId || ('file-' + Date.now());
    let descriptor;
    try {
      descriptor = await App.uploadMediaForServerFallback(file, {
        messageId: id,
        sender: App.publicKey,
        recipient: peerNorm,
        mimeType: file.type || 'application/octet-stream',
        fileName: file.name || 'file',
        requireEncryption: true,
      });
    } catch (err) {
      try { console.warn('[MEDIA/SYNC] upload failed code=' + String((err && err.code) || 'UPLOAD_FAILED')); } catch (_e) {}
      return { ok: false, code: (err && err.code) || 'UPLOAD_FAILED' };
    }
    if (!descriptor || descriptor.type !== 'encrypted-media') return { ok: false, code: 'NO_DESCRIPTOR' };
    const wire = typeof App.buildEncryptedAttachmentWireDescriptor === 'function'
      ? App.buildEncryptedAttachmentWireDescriptor(descriptor)
      : descriptor;
    if (onDevice && !primary) {
      const Session = window.SosAccountSession;
      let siblingOk = false;
      if (Session && typeof Session.delegatedChatEncrypt === 'function') {
        try {
          const sibling = await Session.delegatedChatEncrypt(peerNorm, '', id, { sibling: true, attachment: wire });
          if (sibling && sibling.ok === true && sibling.event) {
            const accepted = await awaitRelayAccepted(ensurePoolReady(), App.relayUrls, sibling.event);
            siblingOk = !!(accepted && accepted.ok);
          }
        } catch (_sib) { siblingOk = false; }
      }
      const fan = await publishDelegatedDeviceCopies(peerNorm, '', id, wire);
      const n = fan && fan.n ? fan.n : 0;
      try { console.log('[MEDIA/SYNC] delegated own-device copies=' + n + ' sibling=' + siblingOk); } catch (_l) {}
      return { ok: siblingOk || n > 0, n: n, logicalMessageId: id };
    }
    const own = await publishAuthorizedDeviceCopies(App.publicKey, id, '', wire || descriptor, Math.floor(Date.now() / 1000), peerNorm);
    const sha = descriptor.cipher && descriptor.cipher.sha256 ? String(descriptor.cipher.sha256) : '';
    try { console.log('[MEDIA/SYNC] own-device copies=' + String(own && own.n) + ' sha256=' + sha.slice(0, 12)); } catch (_l) {}
    return { ok: !!(own && own.n > 0), n: own && own.n, sha256: sha, logicalMessageId: id };
  }

  async function mirrorInboundP2pFileToLinkedDevices(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (!App.SosCryptoSigner || typeof App.SosCryptoSigner.hasIdentityKey !== 'function' || !App.SosCryptoSigner.hasIdentityKey()) {
      return { ok: false, code: 'NOT_PRIMARY' };
    }
    const peer = String(o.peerPubkey || '').toLowerCase();
    const self = String(App.publicKey || '').toLowerCase();
    const logicalId = String(o.logicalMessageId || '');
    if (!/^[0-9a-f]{64}$/.test(peer) || !logicalId || !o.blob || typeof App.uploadMediaForServerFallback !== 'function') {
      return { ok: false, code: 'BAD_INPUT' };
    }
    let descriptor;
    try {
      descriptor = await App.uploadMediaForServerFallback(o.blob, {
        messageId: logicalId,
        sender: peer,
        recipient: self,
        mimeType: o.mimeType || (o.blob && o.blob.type) || 'application/octet-stream',
        fileName: o.name || 'file',
        requireEncryption: true,
      });
    } catch (err) {
      try { console.warn('[MEDIA/SYNC] inbound mirror failed code=' + String((err && err.code) || 'UPLOAD_FAILED')); } catch (_e) {}
      return { ok: false, code: (err && err.code) || 'UPLOAD_FAILED' };
    }
    if (!descriptor || descriptor.type !== 'encrypted-media') return { ok: false, code: 'NO_DESCRIPTOR' };
    try { delete descriptor._prepared; } catch (_prep) {}
    const wire = typeof App.buildEncryptedAttachmentWireDescriptor === 'function'
      ? App.buildEncryptedAttachmentWireDescriptor(descriptor)
      : descriptor;
    const copied = await publishAuthorizedDeviceCopies(self, logicalId, '', wire || descriptor, o.createdAt || Math.floor(Date.now() / 1000), peer, 'inbound');
    const n = copied && copied.n ? copied.n : 0;
    if (/^image\//i.test(String(o.mimeType || ''))) {
      try { console.log('IMAGE_DEVICE_FANOUT n=' + n + ' id=' + logicalId.slice(0, 24)); } catch (_img) {}
    }
    return { ok: n > 0, n: n, logicalMessageId: logicalId };
  }

  Object.assign(App, {
    publishChatMessage,
    reconcileDeviceConversations,
    syncOwnedMediaToLinkedDevices,
    mirrorInboundP2pFileToLinkedDevices,
    deleteChatMessage,
    subscribeToChatEvents,
    stopPrivateChatSubscription,
    resumePrivateChatAfterSecureEpoch,
    bootstrapChatContacts: bootstrapContactsFromFeed,
    addChatContact,
    searchProfilesByName,
    syncChatHistory,
    sendReadReceipt,
    handleIncomingReadReceipt,
    resolveP2pDcReceiptSender,
    buildDcReadReceiptWire,
    drainPendingReadReceipts,
    verifyIncomingChatRelayPayload,
    verifyIncomingChatAttachment,
    inspectIncomingChatAttachment,
    sanitizeIncomingChatFileName,
    isSafeIncomingChatResource,
    isValidIncomingMagnetURI,
    isValidIncomingEncryptedP2pMarker,
    flushPendingE2eeEvents,
    handleIncomingChatEvent,
    classifyChatDelivery,
    pullRecentAccountChat,
    extractValidatedChatRecipientPTag,
    resolveIncomingE2eeChatPayload,
  });

  if (!App._chatServiceBootstrapped) {
    App._chatServiceBootstrapped = true;
    const scheduleBootstrap = () => {
      setTimeout(handlePoolReady, 600);
    };
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      scheduleBootstrap();
    } else {
      document.addEventListener('DOMContentLoaded', scheduleBootstrap);
    }
  }
})(window);
