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

  function inspectIncomingChatAttachment(raw) {
    if (raw == null) return { ok: true };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
    }
    if (Object.keys(raw).length > 24) {
      return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
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
        const inspected = inspectIncomingChatAttachment(parsed.a);
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
  function buildChatDraft(peerPubkey, content) {
    const now = Math.floor(Date.now() / 1000);
    const normalizedPeer = peerPubkey.toLowerCase();
    const tags = [
      ['p', normalizedPeer],
      ['t', CHAT_TAG],
    ];
    if (App.NETWORK_TAG) {
      tags.push(['t', App.NETWORK_TAG]);
    }
    const draft = {
      kind: CHAT_KIND,
      pubkey: App.publicKey,
      created_at: now,
      tags,
      content,
    };
    return draft;
  }

  function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
  }

  async function publishChatMessage(peerPubkey, plainText, options = {}) {
    const clientTempId = typeof options?.clientTempId === 'string' ? options.clientTempId : null;
    // חלק צ'אט (chat-service.js) – בודק אם מצורף קובץ לפני סינון טקסט ריק כדי לאפשר שליחת קבצים בלבד
    const attachmentReady = typeof App.hasChatFileAttachment === 'function' && App.hasChatFileAttachment(peerPubkey);
    if ((!plainText || !plainText.trim()) && !attachmentReady) {
      return { ok: false, error: 'empty-message' };
    }
    const pool = ensurePoolReady();
    if (!pool) {
      return { ok: false, error: 'pool-unavailable' };
    }
    if (typeof App.finalizeEvent !== 'function') {
      console.warn('finalizeEvent missing on App – cannot publish chat message');
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
    if (!forceRelay && App.dataChannel && typeof App.dataChannel.isConnected === 'function' && App.dataChannel.isConnected(peerPubkey)) {
      const p2pId = 'p2p-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const p2pTs = Math.floor(Date.now() / 1000);
      const p2pMsg = { id: p2pId, content: serialization.displayText || '', attachment: serialization.attachment || null, createdAt: p2pTs };
      const sent = App.dataChannel.send(peerPubkey, p2pMsg);
      if (sent) {
        const p2pOutgoing = { id: p2pId, from: App.publicKey, to: peerPubkey, content: p2pMsg.content, attachment: p2pMsg.attachment, createdAt: p2pTs, direction: 'outgoing', status: 'sent', p2p: true };
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
            App.triggerOutgoingMessagePush(peerPubkey, serialization?.rawContent, attachmentReady, p2pId);
          } catch (_pushErr) {}
        }
        console.log('[DC] ✅ Message sent P2P, relay skipped');
        return { ok: true, messageId: p2pId, p2p: true };
      }
    }
    // fallback: שליחה רגילה דרך relay

    const draft = buildChatDraft(peerPubkey, serialization.rawContent || '');
    const event = App.finalizeEvent(draft, App.privateKey);

    const outgoingMessage = {
      id: event.id,
      from: App.publicKey,
      to: peerPubkey,
      content: serialization.displayText || '',
      attachment: serialization.attachment || null,
      createdAt: event.created_at,
      direction: 'outgoing',
      // חלק סטטוס הודעות (chat-service.js) – סטטוס שליחה: sending -> sent | HYPER CORE TECH
      status: 'sending',
    };

    // חלק סטטוס הודעות (chat-service.js) – מוסיף/מחליף הודעה במצב "שולח" לפני הפרסום | HYPER CORE TECH
    if (clientTempId && typeof App.replaceOutgoingTempMessage === 'function') {
      App.replaceOutgoingTempMessage(clientTempId, outgoingMessage);
    } else {
      App.appendChatMessage(outgoingMessage);
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
      App.markChatConversationRead(peerPubkey);
      // חלק Push (chat-service.js) – שליחת Push לנמען כשההודעה נשלחה בהצלחה | HYPER CORE TECH
      if (typeof App.triggerOutgoingMessagePush === 'function') {
        App.triggerOutgoingMessagePush(peerPubkey, serialization?.rawContent, attachmentReady);
      }
      if (typeof App.afterChatMessagePublished === 'function') {
        App.afterChatMessagePublished(peerPubkey, outgoingMessage);
      }
      return { ok: true, messageId: event.id };
    } catch (err) {
      // חלק timeout (chat-service.js) – אם נגמר הזמן, נחשיב כהצלחה כי ההודעה כבר נשלחה ברקע | HYPER CORE TECH
      if (err?.message === 'publish-timeout') {
        console.warn('Chat publish timeout - assuming success');
        if (typeof App.updateChatMessageStatus === 'function') {
          App.updateChatMessageStatus(event.id, 'sent');
        }
        // שליחת Push גם במקרה של timeout
        if (typeof App.triggerOutgoingMessagePush === 'function') {
          App.triggerOutgoingMessagePush(peerPubkey, serialization?.rawContent, attachmentReady);
        }
        return { ok: true, messageId: event.id };
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
    if (typeof App.finalizeEvent !== 'function') {
      console.warn('finalizeEvent missing on App – cannot delete chat message');
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
    if (App.NETWORK_TAG) {
      draft.tags.push(['t', App.NETWORK_TAG]);
    }
    const event = App.finalizeEvent(draft, App.privateKey);
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
    const ttl = PROFILE_TTL_SECONDS;

    // חלק קאש פרופילים (chat-service.js) – מנסה להשתמש בפרופיל שמור עם TTL לפני פנייה לריליי | HYPER CORE TECH
    const existing = App.chatState?.contacts?.get?.(normalized);
    if (existing?.profileFetchedAt && (nowSec - existing.profileFetchedAt) < ttl) {
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

  async function handleIncomingChatEvent(event) {
    if (!event || !event.pubkey) {
      return;
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
    if (!verifyIncomingChatRelayPayload(event.content, { eventId: event.id })) {
      return;
    }
    // חלק שמירה 90 יום (chat-service.js) – מתעלמים מהודעות ישנות מהריליי | HYPER CORE TECH
    if (eventTs < getChatRetentionFloorTs(nowSec)) {
      return;
    }
    const sender = event.pubkey.toLowerCase();
    const currentUser = (App.publicKey || '').toLowerCase();
    const isSelfMessage = sender === currentUser;
    const peerTag = event.tags?.find?.((tag) => Array.isArray(tag) && tag[0] === 'p');
    const recipient = peerTag?.[1]?.toLowerCase?.() || '';
    if (!isSelfMessage && recipient && recipient !== currentUser) {
      // לא נועד עבור המשתמש הנוכחי
      return;
    }

    const peerPubkey = isSelfMessage ? recipient : sender;
    if (!peerPubkey) {
      return;
    }

    const conversationTarget = isSelfMessage ? recipient : currentUser;
    if (!conversationTarget) {
      return;
    }

    const profile = normalizeProfileData(await resolveProfile(peerPubkey), peerPubkey);
    // חלק תיקון cache (chat-service.js) — profileFetchedAt = זמן נוכחי (לא eventTs!) כדי שה-TTL cache יעבוד | HYPER CORE TECH
    App.ensureChatContact(peerPubkey, { ...profile, profileFetchedAt: Math.floor(Date.now() / 1000) });

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

    const parsedPayload =
      typeof App.deserializeChatMessageContent === 'function'
        ? App.deserializeChatMessageContent(event.content)
        : {
            displayText: event.content,
            attachment: null,
            hasAttachment: false,
          };

    if (parsedPayload.attachment) {
      const inspected = inspectIncomingChatAttachment(parsedPayload.attachment);
      if (!inspected.ok) {
        logAttachmentRejected(parsedPayload.attachment, inspected.reasonCode, event.id);
        parsedPayload.attachment = null;
        parsedPayload.hasAttachment = false;
      } else if (parsedPayload.attachment.name) {
        parsedPayload.attachment.name = sanitizeIncomingChatFileName(parsedPayload.attachment.name);
      }
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
      from: sender,
      to: conversationTarget,
      content: parsedPayload.displayText || event.content,
      attachment: parsedPayload.attachment || null,
      createdAt: eventTs,
      direction: isSelfMessage ? 'outgoing' : 'incoming',
    };

    App.appendChatMessage(normalizedMessage);

    // חלק P2P auto-connect (chat-service.js) – כשמגיעה הודעה חדשה דרך relay מ-peer שאין איתו DC,
    // מתחיל חיבור DataChannel ברקע כדי שההודעה הבאה תעבור P2P ישירות | HYPER CORE TECH
    if (!isSelfMessage && messageAgeSec < 120 && App.dataChannel && typeof App.dataChannel.connect === 'function') {
      const dcConnected = typeof App.dataChannel.isConnected === 'function' && App.dataChannel.isConnected(peerPubkey);
      if (!dcConnected) {
        try {
          App.dataChannel.init?.();
          App.dataChannel.connect(peerPubkey);
          console.log('[CHAT/P2P-AUTO] ⚡ auto-connect DC for', peerPubkey.slice(0, 8), '(relay msg received)');
        } catch (_e) { /* שקט — לא קריטי */ }
      }
    }
    
    // חלק Push (chat-service.js) – שליחת התראת Push רק להודעות חדשות (לא ישנות מריליי) | HYPER CORE TECH
    // בדיקה: הודעה נחשבת "חדשה" אם נוצרה בדקה האחרונה מעכשיו
    const isRecentMessage = messageAgeSec < 60; // הודעה מהדקה האחרונה
    
    if (!isSelfMessage && isRecentMessage && typeof App.triggerChatMessagePush === 'function') {
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
        targets.push(tag[1]);
      }
      if (tag[0] === 'p' && typeof tag[1] === 'string') {
        pTagPubkey = tag[1].toLowerCase();
      }
    });
    if (!targets.length) {
      return;
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

  // חלק אבטחה (chat-service.js) – אימות חתימת Nostr מקומי באירועי ריליי לפני כל handler | HYPER CORE TECH
  function verifyIncomingChatRelayEvent(event) {
    let kindLabel = '';
    let idLabel = '';
    try {
      kindLabel = event && event.kind != null ? event.kind : '';
      idLabel = event && event.id ? String(event.id).slice(0, 8) : '';
      if (!event || typeof event !== 'object') {
        console.warn('[SO-CALL SECURITY] rejected invalid signed event kind=' + kindLabel + ' id=' + idLabel);
        return false;
      }
      const tools = window.NostrTools;
      if (!tools || typeof tools.verifyEvent !== 'function') {
        console.warn('[SO-CALL SECURITY] rejected invalid signed event kind=' + kindLabel + ' id=' + idLabel);
        return false;
      }
      if (tools.verifyEvent(event) !== true) {
        console.warn('[SO-CALL SECURITY] rejected invalid signed event kind=' + kindLabel + ' id=' + idLabel);
        return false;
      }
      return true;
    } catch (_err) {
      console.warn('[SO-CALL SECURITY] rejected invalid signed event kind=' + kindLabel + ' id=' + idLabel);
      return false;
    }
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
      if (!self || !sender) {
        console.warn('[SO-CALL SECURITY] rejected event for wrong recipient kind=' + kindLabel + ' id=' + idLabel);
        return false;
      }
      if (sender === self) {
        return true;
      }
      const recipient = getIncomingChatRelayRecipient(event);
      if (!recipient || recipient !== self) {
        console.warn('[SO-CALL SECURITY] rejected event for wrong recipient kind=' + kindLabel + ' id=' + idLabel);
        return false;
      }
      return true;
    } catch (_err) {
      console.warn('[SO-CALL SECURITY] rejected event for wrong recipient kind=' + kindLabel + ' id=' + idLabel);
      return false;
    }
  }

  function subscribeToChatEvents() {
    if (activeSubscription || !ensurePoolReady()) {
      return;
    }
    const normalizedSelf = App.publicKey?.toLowerCase?.() || '';
    if (!normalizedSelf) {
      return;
    }

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
      baseFilter([CHAT_KIND], { '#p': [normalizedSelf], '#t': [CHAT_TAG] }),
      baseFilter([CHAT_KIND], { authors: [normalizedSelf], '#t': [CHAT_TAG] }),
      baseFilter([5], { authors: [normalizedSelf], '#t': [CHAT_TAG] }),
      baseFilter([5], { '#p': [normalizedSelf], '#t': [CHAT_TAG] }),
      // חלק אישורי קריאה (chat-service.js) – האזנה לאישורי קריאה נכנסים | HYPER CORE TECH
      baseFilter([READ_RECEIPT_KIND], { '#p': [normalizedSelf], '#t': [CHAT_TAG] }),
    ];

    if (App.NETWORK_TAG) {
      filters.push(
        baseFilter([CHAT_KIND], { '#t': [App.NETWORK_TAG], authors: [normalizedSelf] }),
        baseFilter([CHAT_KIND], { '#t': [App.NETWORK_TAG], '#p': [normalizedSelf] }),
        baseFilter([5], { '#t': [App.NETWORK_TAG], authors: [normalizedSelf] }),
        baseFilter([5], { '#t': [App.NETWORK_TAG], '#p': [normalizedSelf] }),
        baseFilter([READ_RECEIPT_KIND], { '#t': [App.NETWORK_TAG], '#p': [normalizedSelf] }),
      );
    }

    activeSubscription = App.pool.subscribeMany(App.relayUrls, filters, {
      onevent: (event) => {
        if (!verifyIncomingChatRelayEvent(event)) {
          return;
        }
        if (!verifyIncomingChatRelayRecipient(event)) {
          return;
        }
        chatLastSignalAt = Date.now();
        // חלק אישורי קריאה (chat-service.js) – טיפול באישורי קריאה נכנסים | HYPER CORE TECH
        if (event.kind === READ_RECEIPT_KIND) {
          handleIncomingReadReceipt(event);
          return;
        }
        handleIncomingChatEvent(event);
      },
      oneose: () => {
        chatLastSignalAt = Date.now();
      },
    });
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
        if (last && (now - last) > 90000) {
          forceResubscribeChat('keepalive');
        }
      } catch (err) {
        console.warn('Chat keepalive error', err);
      }
    }, 30000);
  }

  async function bootstrapContactsFromFeed() {
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
  const lastAppliedReadAt = new Map();
  const inFlightReceiptIds = new Set();

  function buildReadReceipt(peerPubkey, lastReadTs, lastReadMessageId) {
    const self = String(App.publicKey || '').toLowerCase();
    const to = String(peerPubkey || '').toLowerCase();
    const lastReadAt = lastReadTs || Math.floor(Date.now() / 1000);
    return {
      type: 'chat_read_receipt',
      receiptId: 'rr-' + self.slice(0, 12) + '-' + to.slice(0, 12) + '-' + lastReadAt,
      from: self,
      to,
      lastReadAt,
      lastReadMessageId: lastReadMessageId || '',
    };
  }

  function canUseNostrPool() {
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    } catch (_) {}
    const pool = ensurePoolReady();
    return !!(pool && App.privateKey && typeof App.finalizeEvent === 'function');
  }

  function sendReceiptOverDc(receipt) {
    if (!receipt || !App.dataChannel) return false;
    if (typeof App.dataChannel.isConnected === 'function' && !App.dataChannel.isConnected(receipt.to)) return false;
    if (typeof App.dataChannel.sendJson === 'function') {
      return !!App.dataChannel.sendJson(receipt.to, receipt);
    }
    if (typeof App.dataChannel.send === 'function') {
      return !!App.dataChannel.send(receipt.to, receipt);
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
    if (typeof App.finalizeEvent !== 'function' || !App.privateKey) return false;
    const tags = [
      ['p', receipt.to],
      ['t', CHAT_TAG],
    ];
    if (App.NETWORK_TAG) tags.push(['t', App.NETWORK_TAG]);
    try {
      const signed = App.finalizeEvent({
        kind: READ_RECEIPT_KIND,
        pubkey: App.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: JSON.stringify({
          type: 'chat_read_receipt',
          receiptId: receipt.receiptId,
          lastReadAt: receipt.lastReadAt,
          lastReadMessageId: receipt.lastReadMessageId || '',
        }),
      }, App.privateKey);
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
  function handleIncomingReadReceipt(event) {
    if (!event) return;
    const self = App.publicKey?.toLowerCase?.() || '';
    let sender = '';
    let recipient = '';
    let lastReadAt = 0;
    let receiptId = '';
    if (event.type === 'chat_read_receipt' || (!event.kind && event.lastReadAt)) {
      sender = String(event.from || '').toLowerCase();
      recipient = String(event.to || '').toLowerCase();
      lastReadAt = Number(event.lastReadAt) || 0;
      receiptId = String(event.receiptId || '');
    } else if (event.kind === READ_RECEIPT_KIND) {
      sender = event.pubkey?.toLowerCase?.() || '';
      const pTag = event.tags?.find?.(t => Array.isArray(t) && t[0] === 'p');
      recipient = pTag?.[1]?.toLowerCase?.() || '';
      try {
        const data = JSON.parse(event.content || '{}');
        lastReadAt = Number(data.lastReadAt) || 0;
        receiptId = String(data.receiptId || '');
      } catch {}
    } else {
      return;
    }
    if (!sender || sender === self) return;
    if (recipient && recipient !== self) return;
    if (!lastReadAt) return;
    const prevApplied = lastAppliedReadAt.get(sender) || 0;
    if (lastReadAt < prevApplied) return;
    lastAppliedReadAt.set(sender, lastReadAt);
    
    const messages = typeof App.getChatMessages === 'function' ? App.getChatMessages(sender) : [];
    messages.forEach(msg => {
      if (msg.direction === 'outgoing' && msg.createdAt <= lastReadAt && msg.status !== 'read') {
        if (typeof App.updateChatMessageStatus === 'function') {
          App.updateChatMessageStatus(msg.id, 'read');
        }
      }
    });
    
    // חלק הגבלת לוג (chat-service.js) — מדפיס רק 5 RR ראשונים ואח"כ כל 20 למניעת שטפון | HYPER CORE TECH
    if (!handleIncomingReadReceipt._count) handleIncomingReadReceipt._count = 0;
    handleIncomingReadReceipt._count++;
    if (handleIncomingReadReceipt._count <= 5 || handleIncomingReadReceipt._count % 20 === 0) {
      console.log('[CHAT] Read receipt received from', sender.slice(0, 8), 'up to', lastReadAt,
        receiptId ? ('id=' + receiptId) : '',
        handleIncomingReadReceipt._count > 5 ? `(total: ${handleIncomingReadReceipt._count})` : '');
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

  Object.assign(App, {
    publishChatMessage,
    deleteChatMessage,
    subscribeToChatEvents,
    bootstrapChatContacts: bootstrapContactsFromFeed,
    addChatContact,
    searchProfilesByName,
    syncChatHistory,
    sendReadReceipt,
    handleIncomingReadReceipt,
    drainPendingReadReceipts,
    verifyIncomingChatRelayPayload,
    verifyIncomingChatAttachment,
    inspectIncomingChatAttachment,
    sanitizeIncomingChatFileName,
    isSafeIncomingChatResource,
    isValidIncomingMagnetURI,
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
