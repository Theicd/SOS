// חלק העברת קבצים P2P (chat-p2p-file.js) – העברת קבצים גדולים דרך WebRTC DataChannel עם הצפנה, resume, fallback | HYPER CORE TECH
(function initChatP2PFile(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  // חלק דיבאג מדיה (chat-p2p-file.js) – לוגים לפי localStorage sos_debug_media | HYPER CORE TECH
  if (typeof App.mediaDebugLog !== 'function') {
    App.mediaDebugLog = (...args) => {
      try {
        if (localStorage.getItem('sos_debug_media') === '1') {
          const safe = args.map((a) => (typeof App.diagRedactForLog === 'function' ? App.diagRedactForLog(a) : a));
          console.log('[MEDIA-DEBUG]', ...safe);
        }
      } catch (_) {}
    };
  }
  const mediaDebugLog = App.mediaDebugLog;
  
  const CHUNK_SIZE = 64 * 1024; // 64KB — בטוח ל-WebRTC במובייל (256KB נחסם/נופל ב-SCTP)
  const MAX_BUFFERED_AMOUNT = 512 * 1024; // 512KB buffer limit
  const MAX_IN_FLIGHT = 4; // חלון רשת: עד 4 צ'אנקים שנשלחו ולא אושרו
  const MAX_PREPARE_CONCURRENCY = 4; // כמה FileReader+AES במקביל
  const PREFETCH_TARGET = 8; // מקסימום preparing+prepared (לא כולל inFlight)
  const PROGRESS_UI_MIN_MS = 250; // throttle ל-UI בלבד, לא לפרוטוקול
  const ACK_INTERVAL = 10; // Send ACK every 10 chunks
  const TRANSFER_TIMEOUT = 30000; // 30s timeout for stalled transfers
  // לא אותו דבר כמו "זמן חיבור WebRTC" — אלה חלונות לזיהוי תקיעה לפני resend (מפחית false-positive על רשת איטית / סיגנלינג איטי)
  const INITIAL_CHUNK_WAIT_SEC = 12; // מובייל + הצפנת chunk ראשון יכולים לקחת יותר מ-6s
  const CHUNK_STALL_WAIT_SEC = 12; // בין chunks: stop-and-wait + עומס DC; היה אגרסיבי מדי ב-5s
  const POST_RESEND_FAIL_WAIT_SEC = 15; // אחרי בקשת resend — זמן חסד נוסף לפני כישלון מוצהר
  const RESEND_COOLDOWN_MS = 15000; // לא לשלוח בקשות resend חוזרות שגורמות לקפיצות UI
  const FILE_RETAIN_MS = 3 * 60 * 1000; // שומר קובץ 3 דקות אחרי סיום לצורך resend
  const MAX_RESEND_ATTEMPTS = 2; // מקסימום ניסיונות resend
  const MAX_INBOUND_RECEIVES_GLOBAL = 8;
  const MAX_INBOUND_RECEIVES_PER_PEER = 3;
  const MAX_PENDING_CHUNKS_PER_PEER = 64;
  const MAX_CLAIMED_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB claim ceiling for DC offers
  const MAX_TOTAL_CHUNKS = 40000; // ~2.5GB at 64KB
  const resendAttemptCounts = new Map();

  function countInboundReceives(peerKey) {
    let globalN = 0;
    let peerN = 0;
    for (const t of activeTransfers.values()) {
      if (!t || t.direction !== 'receive' || t.completed) continue;
      globalN += 1;
      if (peerKey && t.peerPubkey === peerKey) peerN += 1;
    }
    return { globalN, peerN };
  }

  function safeBlobContentType(raw) {
    const essence = String(raw || '').split(';')[0].trim().toLowerCase();
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(essence)) return 'application/octet-stream';
    if (essence === 'text/html' || essence === 'image/svg+xml' || /javascript|ecmascript/.test(essence)) {
      return 'application/octet-stream';
    }
    if (/^(image|audio|video)\//.test(essence)) return essence;
    if (
      essence === 'application/pdf' ||
      essence === 'text/plain' ||
      essence === 'application/octet-stream' ||
      essence === 'application/msword' ||
      essence.startsWith('application/vnd.') ||
      essence === 'application/zip' ||
      essence === 'application/x-zip-compressed'
    ) {
      return essence;
    }
    return 'application/octet-stream';
  }

  function sanitizeOfferFileName(name) {
    if (typeof App.sanitizeIncomingChatFileName === 'function') {
      return App.sanitizeIncomingChatFileName(name || 'file');
    }
    return String(name || 'file').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'file';
  }

  // חלק Toast שקט (chat-p2p-file.js) – סטטוס העברה רק בבועה, בלי התראות בראש המסך | HYPER CORE TECH
  function logFileTransport(peer, transport) {
    try { console.log('[P2P-FILE] peer=' + String(peer || '').slice(0, 8) + ' transport=' + transport); } catch (_) {}
  }

  function quietTransferLog(...args) {
    try { console.log('[CHAT/P2P]', ...args); } catch (_) {}
  }
  
  // חלק מצב העברות (chat-p2p-file.js) – מעקב אחר העברות פעילות | HYPER CORE TECH
  const activeTransfers = new Map(); // fileId -> transfer state
  const progressListeners = new Set(); // UI listeners for progress
  // חלק שמירת קבצים (chat-p2p-file.js) – שומר קובץ 3 דקות אחרי סיום לצורך resend אם המקבל איחר | HYPER CORE TECH
  const recentCompletedFiles = new Map(); // fileId -> { file, keyStr, peerPubkey, completedAt }
  const recentIncomingFileOffers = new Map(); // peerKey -> ts

  function isReceivingChatFile(peerPubkey) {
    const peerKey = peerPubkey ? String(peerPubkey).toLowerCase() : '';
    for (const t of activeTransfers.values()) {
      if (t.direction !== 'receive') continue;
      if (!peerKey) return true;
      if (String(t.peerPubkey || '').toLowerCase() === peerKey) return true;
    }
    if (!peerKey) return false;
    const ts = recentIncomingFileOffers.get(peerKey);
    return !!(ts && (Date.now() - ts < 30000));
  }

  function hasActiveChatFileTransfer(peerPubkey) {
    if (!(activeTransfers instanceof Map) || activeTransfers.size === 0) return false;
    if (!peerPubkey) return true;
    const peerKey = String(peerPubkey).toLowerCase();
    for (const t of activeTransfers.values()) {
      if (String(t.peerPubkey || '').toLowerCase() === peerKey) return true;
    }
    return false;
  }

  function notifyProgress(payload) {
    try {
      const st = payload && payload.status;
      if (typeof App.setP2pTransferActiveNative === 'function') {
        if (st === 'starting' || st === 'sending' || st === 'receiving' || st === 'waiting-peer' || st === 'resending' || st === 'requesting-resend' || st === 'stalled-requesting-resend') {
          App.setP2pTransferActiveNative(true);
        } else if (st === 'complete' || st === 'failed' || st === 'cancelled' || st === 'complete-blossom' || st === 'verified') {
          App.setP2pTransferActiveNative(false);
          try {
            if (activeTransfers.size === 0 && typeof App.maybeResumeFeedAfterChat === 'function') {
              App.maybeResumeFeedAfterChat();
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    progressListeners.forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        console.warn('P2P progress listener failed', err);
      }
    });
  }

  function emitTransferProgress(transfer, onProgress, payload) {
    const st = payload && payload.status;
    const terminal = st === 'complete' || st === 'failed' || st === 'cancelled' || st === 'verified' || st === 'complete-blossom';
    const now = Date.now();
    if (!terminal && transfer && (st === 'sending' || st === 'receiving')) {
      if (transfer._lastProgressUiAt && (now - transfer._lastProgressUiAt) < PROGRESS_UI_MIN_MS) {
        transfer._pendingProgressUi = { onProgress, payload };
        if (!transfer._progressUiTimer) {
          transfer._progressUiTimer = setTimeout(() => {
            transfer._progressUiTimer = null;
            const pending = transfer._pendingProgressUi;
            transfer._pendingProgressUi = null;
            if (!pending || !transfer || transfer.completed || transfer.paused) return;
            emitTransferProgress(transfer, pending.onProgress, pending.payload);
          }, PROGRESS_UI_MIN_MS);
        }
        return;
      }
    }
    if (transfer) {
      transfer._lastProgressUiAt = now;
      transfer._pendingProgressUi = null;
    }
    if (typeof onProgress === 'function') onProgress(payload);
    notifyProgress(payload);
  }
  const dataChannels = new Map(); // peerPubkey -> RTCDataChannel
  // חלק buffer chunks (chat-p2p-file.js) – שמירת chunks שמגיעים לפני ה-file-offer (race condition fix) | HYPER CORE TECH
  const pendingChunks = new Map(); // peerPubkey -> [Uint8Array]
  // חלק העברה דו-כיוונית (chat-p2p-file.js) – קובץ receive פעיל לפי peer מ-chunk-meta | HYPER CORE TECH
  const peerPreferredReceiveFileId = new Map(); // peerPubkey -> fileId

  // חלק נרמול peer key (chat-p2p-file.js) – מפתח אחיד lowercase לכל מפות החיבור/צ'אנקים | HYPER CORE TECH
  function toPeerKey(peerPubkey) {
    return (peerPubkey || '').toLowerCase();
  }

  // חלק יציבות (chat-p2p-file.js) — מזהה file-offer ישן מסיגנלים חוזרים בריליי | HYPER CORE TECH
  function fileOfferAgeMs(fileId) {
    if (!fileId || typeof fileId !== 'string') return Infinity;
    const prefix = fileId.split('-')[0];
    const ts = parseInt(prefix, 10);
    if (!Number.isFinite(ts)) return Infinity;
    return Date.now() - ts;
  }

  function preferDataChannel(peerKey, ch) {
    if (ch && ch.readyState === 'open') {
      dataChannels.set(peerKey, ch);
      return ch;
    }
    return dataChannels.get(peerKey);
  }

  function replyChannel(peerKey, sourceChannel) {
    const s = preferDataChannel(peerKey, sourceChannel);
    return s && s.readyState === 'open' ? s : null;
  }

  // חלק QA hooks (chat-p2p-file.js) – נקודות עצירה/ספירה לבדיקות דטרמיניסטיות בלי לשנות פרוטוקול | HYPER CORE TECH
  function qaHold(phase, detail) {
    try {
      if (typeof App._p2pFileQaHold === 'function') {
        return App._p2pFileQaHold(phase, detail);
      }
    } catch (_) {}
    return undefined;
  }

  function qaNote(event, detail) {
    try {
      if (typeof App._p2pFileQaNote === 'function') {
        App._p2pFileQaNote(event, detail);
      }
    } catch (_) {}
  }

  function isChatDataChannel(channel) {
    return !!channel && String(channel.label || '') === 'sos-chat';
  }

  // חלק מאזין קבצים יחיד (chat-p2p-file.js) – onmessage XOR addEventListener; sos-chat כבר מנותב מ-chat-p2p-datachannel | HYPER CORE TECH
  function attachCanonicalFileHandler(peerPubkey, channel) {
    const peerKey = toPeerKey(peerPubkey);
    if (!channel) return false;
    if (channel._p2pFileHandler) {
      qaNote('handler-skip-already-attached', { peerKey, label: channel.label || '' });
      return false;
    }
    if (isChatDataChannel(channel)) {
      channel._p2pFileHandler = 'chat-dc-bridged';
      qaNote('handler-bridged-chat-dc', { peerKey });
      return false;
    }
    if (typeof channel.onmessage === 'function') {
      channel._p2pFileHandler = 'onmessage-bridged';
      qaNote('handler-bridged-onmessage', { peerKey, label: channel.label || '' });
      return false;
    }
    const handler = (event) => {
      handleIncomingMessage(peerKey, event.data, event.currentTarget);
    };
    channel._p2pFileHandler = handler;
    channel.addEventListener('message', handler);
    qaNote('handler-attached', { peerKey, label: channel.label || '' });
    return true;
  }

  function readSliceAsArrayBuffer(file, start, end) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.readAsArrayBuffer(file.slice(start, end));
    });
  }

  const sendCompletedFileIds = new Set();

  function ensureSendWindowState(transfer) {
    if (!transfer) return;
    if (!(transfer.ackedChunks instanceof Set)) transfer.ackedChunks = new Set();
    if (!(transfer.inFlightChunks instanceof Set)) transfer.inFlightChunks = new Set();
    if (!(transfer.preparingChunks instanceof Map)) transfer.preparingChunks = new Map();
    if (!(transfer.preparedChunks instanceof Map)) transfer.preparedChunks = new Map();
    if (typeof transfer.nextChunkToSend !== 'number') {
      transfer.nextChunkToSend = typeof transfer.currentChunk === 'number' ? transfer.currentChunk : 0;
    }
    if (typeof transfer.nextChunkToPrepare !== 'number') {
      transfer.nextChunkToPrepare = transfer.nextChunkToSend;
    }
    if (typeof transfer.sendGeneration !== 'number') transfer.sendGeneration = 0;
    if (typeof transfer.maxInFlightSeen !== 'number') transfer.maxInFlightSeen = 0;
    if (typeof transfer.maxPreparingSeen !== 'number') transfer.maxPreparingSeen = 0;
    if (typeof transfer.maxPreparedSeen !== 'number') transfer.maxPreparedSeen = 0;
    if (typeof transfer.inFlightSampleSum !== 'number') transfer.inFlightSampleSum = 0;
    if (typeof transfer.inFlightSampleCount !== 'number') transfer.inFlightSampleCount = 0;
    if (typeof transfer.totalReadMs !== 'number') transfer.totalReadMs = 0;
    if (typeof transfer.totalAesMs !== 'number') transfer.totalAesMs = 0;
    if (typeof transfer.totalPrepareMs !== 'number') transfer.totalPrepareMs = 0;
    transfer.currentChunk = transfer.nextChunkToSend;
  }

  function inFlightCount(transfer) {
    return transfer && transfer.inFlightChunks ? transfer.inFlightChunks.size : 0;
  }

  function prepOccupancy(transfer) {
    return (transfer.preparingChunks ? transfer.preparingChunks.size : 0)
      + (transfer.preparedChunks ? transfer.preparedChunks.size : 0);
  }

  function allSendChunksAcked(transfer) {
    if (!transfer || !transfer.ackedChunks) return false;
    return transfer.ackedChunks.size >= transfer.totalChunks
      && transfer.nextChunkToSend >= transfer.totalChunks
      && inFlightCount(transfer) === 0;
  }

  function noteMaxInFlight(transfer) {
    const n = inFlightCount(transfer);
    if (n > (transfer.maxInFlightSeen || 0)) transfer.maxInFlightSeen = n;
    qaNote('in-flight', { fileId: transfer.fileId, count: n, max: transfer.maxInFlightSeen });
  }

  function sampleInFlight(transfer) {
    const n = inFlightCount(transfer);
    transfer.inFlightSampleSum = (transfer.inFlightSampleSum || 0) + n;
    transfer.inFlightSampleCount = (transfer.inFlightSampleCount || 0) + 1;
    noteMaxInFlight(transfer);
  }

  function notePrepStats(transfer) {
    const preparing = transfer.preparingChunks ? transfer.preparingChunks.size : 0;
    const prepared = transfer.preparedChunks ? transfer.preparedChunks.size : 0;
    if (preparing > (transfer.maxPreparingSeen || 0)) transfer.maxPreparingSeen = preparing;
    if (prepared > (transfer.maxPreparedSeen || 0)) transfer.maxPreparedSeen = prepared;
    qaNote('prepare-stats', {
      fileId: transfer.fileId,
      preparing,
      prepared,
      occupancy: preparing + prepared,
      maxPreparing: transfer.maxPreparingSeen,
      maxPrepared: transfer.maxPreparedSeen,
    });
  }

  function releasePreparingSlot(transfer, chunkIndex, generation) {
    if (!transfer || !transfer.preparingChunks) return;
    if (transfer.preparingChunks.get(chunkIndex) === generation) {
      transfer.preparingChunks.delete(chunkIndex);
    }
  }

  function isPrepStale(transfer, chunkIndex, generation) {
    if (!transfer || transfer.completed || transfer.paused) return true;
    if (transfer.sendGeneration !== generation) return true;
    if (!transfer.preparingChunks || !transfer.preparingChunks.has(chunkIndex)) return true;
    if (transfer.preparingChunks.get(chunkIndex) !== generation) return true;
    if (transfer.ackedChunks.has(chunkIndex) || transfer.inFlightChunks.has(chunkIndex)) return true;
    return false;
  }

  function discardPrepFrom(transfer, fromChunk) {
    const from = Math.max(0, fromChunk);
    if (transfer.preparingChunks) {
      for (const idx of [...transfer.preparingChunks.keys()]) {
        if (idx >= from) transfer.preparingChunks.delete(idx);
      }
    }
    if (transfer.preparedChunks) {
      for (const idx of [...transfer.preparedChunks.keys()]) {
        if (idx >= from) transfer.preparedChunks.delete(idx);
      }
    }
  }

  function clearAllPrep(transfer) {
    if (!transfer) return;
    if (transfer.preparingChunks) transfer.preparingChunks.clear();
    if (transfer.preparedChunks) transfer.preparedChunks.clear();
  }

  function logSendTelemetry(transfer) {
    if (!transfer) return;
    const durationMs = Math.max(0, Date.now() - (transfer.startTime || Date.now()));
    const size = transfer.file?.size || transfer.size || 0;
    const avgInFlight = transfer.inFlightSampleCount
      ? transfer.inFlightSampleSum / transfer.inFlightSampleCount
      : 0;
    const mbps = durationMs > 0 ? (size * 8) / durationMs / 1000 : 0;
    const stats = {
      fileId: transfer.fileId,
      chunks: transfer.totalChunks,
      durationMs,
      maxInFlight: transfer.maxInFlightSeen || 0,
      avgInFlight: Math.round(avgInFlight * 100) / 100,
      maxPreparing: transfer.maxPreparingSeen || 0,
      maxPrepared: transfer.maxPreparedSeen || 0,
      readMs: transfer.totalReadMs || 0,
      aesMs: transfer.totalAesMs || 0,
      prepareMs: transfer.totalPrepareMs || 0,
      mbps: Math.round(mbps * 100) / 100,
    };
    qaNote('send-stats', stats);
    console.log('[CHAT/P2P] send-stats', stats);
  }

  function applySendRewind(transfer, fromChunk) {
    const from = Math.max(0, fromChunk);
    transfer.sendGeneration = (transfer.sendGeneration || 0) + 1;
    transfer.nextChunkToSend = from;
    transfer.nextChunkToPrepare = from;
    transfer.currentChunk = from;
    transfer.lastAckedChunk = from - 1;
    if (transfer.inFlightChunks) transfer.inFlightChunks.clear();
    if (transfer.ackedChunks) {
      for (const idx of [...transfer.ackedChunks]) {
        if (idx >= from) transfer.ackedChunks.delete(idx);
      }
      for (let i = 0; i < from; i++) transfer.ackedChunks.add(i);
    }
    discardPrepFrom(transfer, from);
    if (transfer._ackTimeout) {
      clearTimeout(transfer._ackTimeout);
      transfer._ackTimeout = null;
    }
    qaNote('send-generation', { fileId: transfer.fileId, generation: transfer.sendGeneration, fromChunk: from });
  }

  function takePrepareIndex(transfer) {
    ensureSendWindowState(transfer);
    const total = transfer.totalChunks || 0;
    while (transfer.nextChunkToPrepare < total) {
      if (transfer.preparingChunks.size >= MAX_PREPARE_CONCURRENCY) return -1;
      if (prepOccupancy(transfer) >= PREFETCH_TARGET) return -1;
      const idx = transfer.nextChunkToPrepare;
      transfer.nextChunkToPrepare = idx + 1;
      if (transfer.ackedChunks.has(idx) || transfer.inFlightChunks.has(idx)) continue;
      if (transfer.preparingChunks.has(idx) || transfer.preparedChunks.has(idx)) continue;
      transfer.preparingChunks.set(idx, transfer.sendGeneration);
      notePrepStats(transfer);
      return idx;
    }
    return -1;
  }

  function pumpPrepare(fileId) {
    const transfer = activeTransfers.get(fileId);
    if (!transfer || transfer.direction !== 'send' || transfer.completed || transfer.paused) return;
    ensureSendWindowState(transfer);
    while (true) {
      const idx = takePrepareIndex(transfer);
      if (idx < 0) break;
      const gen = transfer.sendGeneration;
      qaNote('prepare-start', {
        fileId,
        chunkIndex: idx,
        generation: gen,
        preparing: transfer.preparingChunks.size,
      });
      prepareChunk(fileId, idx, gen);
    }
  }

  async function prepareChunk(fileId, chunkIndex, generation) {
    const transfer = activeTransfers.get(fileId);
    if (!transfer || isPrepStale(transfer, chunkIndex, generation)) {
      releasePreparingSlot(transfer, chunkIndex, generation);
      qaNote('prepare-abandoned', { fileId, chunkIndex, generation, reason: 'stale-start' });
      return;
    }
    const { file, key } = transfer;
    const t0 = Date.now();
    try {
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const holdRead = qaHold('before-read', { fileId, chunkIndex, generation });
      if (holdRead && typeof holdRead.then === 'function') await holdRead;
      if (isPrepStale(transfer, chunkIndex, generation)) {
        releasePreparingSlot(transfer, chunkIndex, generation);
        qaNote('prepare-stale', { fileId, chunkIndex, generation, phase: 'before-read' });
        return;
      }
      const readStart = Date.now();
      const raw = await readSliceAsArrayBuffer(file, start, end);
      transfer.totalReadMs = (transfer.totalReadMs || 0) + (Date.now() - readStart);
      const holdEnc = qaHold('before-encrypt', { fileId, chunkIndex, generation });
      if (holdEnc && typeof holdEnc.then === 'function') await holdEnc;
      if (isPrepStale(transfer, chunkIndex, generation)) {
        releasePreparingSlot(transfer, chunkIndex, generation);
        qaNote('prepare-stale', { fileId, chunkIndex, generation, phase: 'before-encrypt' });
        return;
      }
      const aesStart = Date.now();
      const encrypted = await encryptChunk(new Uint8Array(raw), key);
      transfer.totalAesMs = (transfer.totalAesMs || 0) + (Date.now() - aesStart);
      if (!encrypted) {
        releasePreparingSlot(transfer, chunkIndex, generation);
        console.error('[CHAT/P2P] Encryption failed for chunk', chunkIndex);
        return;
      }
      if (isPrepStale(transfer, chunkIndex, generation)) {
        releasePreparingSlot(transfer, chunkIndex, generation);
        qaNote('prepare-stale', { fileId, chunkIndex, generation, phase: 'after-encrypt' });
        return;
      }
      releasePreparingSlot(transfer, chunkIndex, generation);
      if (transfer.ackedChunks.has(chunkIndex) || transfer.inFlightChunks.has(chunkIndex) || transfer.preparedChunks.has(chunkIndex)) {
        qaNote('prepare-discard-dup', { fileId, chunkIndex, generation });
        return;
      }
      transfer.preparedChunks.set(chunkIndex, { payload: encrypted, generation });
      transfer.totalPrepareMs = (transfer.totalPrepareMs || 0) + (Date.now() - t0);
      notePrepStats(transfer);
      qaNote('prepare-ready', {
        fileId,
        chunkIndex,
        generation,
        prepared: transfer.preparedChunks.size,
        preparing: transfer.preparingChunks.size,
      });
      pumpSend(fileId, transfer._onProgress);
      pumpPrepare(fileId);
    } catch (err) {
      releasePreparingSlot(transfer, chunkIndex, generation);
      console.warn('[CHAT/P2P] prepareChunk failed', chunkIndex, err);
    }
  }

  function armAckTimeout(fileId, transfer, peerKey) {
    if (transfer._ackTimeout) {
      clearTimeout(transfer._ackTimeout);
      transfer._ackTimeout = null;
    }
    if (transfer.completed || inFlightCount(transfer) === 0) return;
    transfer._ackTimeout = setTimeout(() => {
      const t = activeTransfers.get(fileId);
      if (!t || t.direction !== 'send' || t.completed) return;
      if (!t.inFlightChunks || t.inFlightChunks.size === 0) return;
      const oldest = Math.min(...t.inFlightChunks);
      console.warn(`[CHAT/P2P] ⏱️ chunk-ack timeout (chunk ${oldest}), שולח שוב...`);
      applySendRewind(t, oldest);
      notifyProgress({
        fileId,
        progress: Math.max(0, t.nextChunkToSend / t.totalChunks),
        status: 'resending',
        direction: 'send',
        name: t.file?.name,
        size: t.file?.size,
        mimeType: t.file?.type,
        peerPubkey: peerKey
      });
      sendNextChunk(fileId, t._onProgress);
    }, Math.max(15000, CHUNK_STALL_WAIT_SEC * 1000 + 4000));
  }

  // חלק MIME קבצים (chat-p2p-file.js) – השלמת MIME לפי שם קובץ כדי שתצוגת מדיה ב-P2P תעבוד כמו Blossom | HYPER CORE TECH
  function resolveMimeType(mimeType, fileName) {
    const existing = (mimeType || '').toLowerCase();
    if (existing) return existing;
    const name = (fileName || '').toLowerCase();
    if (!name) return '';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.gif')) return 'image/gif';
    if (name.endsWith('.webp')) return 'image/webp';
    if (name.endsWith('.bmp')) return 'image/bmp';
    if (name.endsWith('.heic')) return 'image/heic';
    if (name.endsWith('.heif')) return 'image/heif';
    if (name.endsWith('.mp4')) return 'video/mp4';
    if (name.endsWith('.mov')) return 'video/quicktime';
    if (name.endsWith('.mkv')) return 'video/x-matroska';
    if (name.endsWith('.webm')) return 'video/webm';
    return '';
  }

  // חלק סימון וידאו (chat-p2p-file.js) – כל סוגי וידאו נדרשים לסימון isVideo כדי שממשק הצ'אט יציג נגן | HYPER CORE TECH
  function shouldForceVideoFlag(mimeType, fileName) {
    const resolved = resolveMimeType(mimeType, fileName);
    return resolved.startsWith('video/');
  }

  // חלק הודעת שגיאה למשתמש (chat-p2p-file.js) – דיווח אחיד וברור במקרי כשל העברה | HYPER CORE TECH
  function notifyTransferError(peerPubkey, message, code = 'p2p-transfer-failed') {
    const peerKey = toPeerKey(peerPubkey);
    App.notifyChatFileTransferError?.({
      peer: peerKey,
      code,
      message,
    });
    // בלי Toast בראש המסך — הסטטוס מוצג בבועת ההעברה בלבד | HYPER CORE TECH
    quietTransferLog('transfer-error', code, message);
  }
  
  // חלק הצפנה (chat-p2p-file.js) – הצפנת/פענוח צ'אנק עם AES-GCM | HYPER CORE TECH
  async function encryptChunk(data, key) {
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        data
      );
      // Concatenate IV + ciphertext
      const result = new Uint8Array(iv.length + encrypted.byteLength);
      result.set(iv, 0);
      result.set(new Uint8Array(encrypted), iv.length);
      return result;
    } catch (err) {
      console.error('encryptChunk failed', err);
      return null;
    }
  }
  
  async function decryptChunk(data, key) {
    try {
      const iv = data.slice(0, 12);
      const ciphertext = data.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
      );
      return new Uint8Array(decrypted);
    } catch (err) {
      console.error('decryptChunk failed', err);
      return null;
    }
  }
  
  // חלק מפתח סימטרי (chat-p2p-file.js) – יצירת מפתח AES-GCM לקובץ | HYPER CORE TECH
  async function generateFileKey() {
    return await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }
  
  async function exportFileKey(key) {
    const exported = await crypto.subtle.exportKey('raw', key);
    return btoa(String.fromCharCode(...new Uint8Array(exported)));
  }
  
  async function importFileKey(keyStr) {
    const keyData = Uint8Array.from(atob(keyStr), c => c.charCodeAt(0));
    return await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'AES-GCM' },
      true,
      ['encrypt', 'decrypt']
    );
  }
  
  // חלק DataChannel (chat-p2p-file.js) – פתיחת ערוץ נתונים לקובץ | HYPER CORE TECH
  function getOrCreateDataChannel(peerPubkey, pc) {
    const peerKey = toPeerKey(peerPubkey);
    if (dataChannels.has(peerKey)) {
      return dataChannels.get(peerKey);
    }
    
    if (!pc) {
      console.warn('No PeerConnection available for', peerKey);
      return null;
    }
    
    try {
      const channel = pc.createDataChannel('file-transfer', {
        ordered: true
        // ללא maxRetransmits — ערוץ אמין מלא (אחרת צ'אנקים גדולים נעלמים במובייל)
      });
      
      channel.binaryType = 'arraybuffer';
      dataChannels.set(peerKey, channel);
      
      channel.onopen = () => {
        console.log('File transfer DataChannel opened for', peerKey.slice(0, 8));
      };
      
      channel.onclose = () => {
        console.log('File transfer DataChannel closed for', peerKey.slice(0, 8));
        dataChannels.delete(peerKey);
      };
      
      channel.onerror = (err) => {
        console.error('DataChannel error', err);
      };

      attachCanonicalFileHandler(peerKey, channel);
      
      return channel;
    } catch (err) {
      console.error('Failed to create DataChannel', err);
      return null;
    }
  }
  
  // חלק שליחה (chat-p2p-file.js) – שליחת קובץ בצ'אנקים מוצפנים | HYPER CORE TECH
  async function sendFile(peerPubkey, file, onProgress) {
    const peerKey = toPeerKey(peerPubkey);
    console.log('[CHAT/P2P] 📤 sendFile start', {
      peer: peerPubkey?.slice?.(0, 8),
      attachmentType: file?.type || 'unknown',
      size: file?.size
    });
    
    logFileTransport(peerKey, 'seed-local');
    try {
      if (typeof App.setFeedWarmupPaused === 'function') App.setFeedWarmupPaused(true);
      if (typeof App.pauseFeedMediaForChat === 'function') App.pauseFeedMediaForChat('chat-file');
    } catch (_) {}
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = await generateFileKey();
    const keyStr = await exportFileKey(key);
    
    // חלק חיבור DC (chat-p2p-file.js) – וידוא DataChannel פתוח לפני שליחה, מנסה לחבר אם צריך | HYPER CORE TECH
    const conn = typeof App.getPersistentConnection === 'function' 
      ? App.getPersistentConnection(peerKey) 
      : null;
    const hasConnection = conn && conn.channel && conn.channel.readyState === 'open';
    const chatDCConnected = App.dataChannel?.isConnected?.(peerKey) || false;
    
    console.log('[CHAT/P2P] 🔍 בדיקת חיבור', {
      hasPersistentConnection: hasConnection,
      channelState: conn?.channel?.readyState || 'none',
      chatDC: chatDCConnected ? 'connected' : 'not connected'
    });

    // אם אין שום DataChannel פתוח, מנסה לחבר בכוח (גם כ-responder) ומחכה עד 5 שניות
    if (!hasConnection && !chatDCConnected && App.dataChannel) {
      console.log('[CHAT/P2P] ⚡ מנסה לחבר chat DataChannel לפני שליחה (forceConnect)...');
      try {
        App.dataChannel.init?.();
        // initiator שולח offer; responder רק מבקש offer — בלי לשבור תפקידים
        if (typeof App.dataChannel.forceConnect === 'function') {
          await App.dataChannel.forceConnect(peerKey);
        } else {
          App.dataChannel.connect(peerKey);
        }
        for (let i = 0; i < 25; i++) {
          await new Promise(r => setTimeout(r, 200));
          if (App.dataChannel.isConnected(peerKey)) {
            console.log('[CHAT/P2P] ⚡ chat DataChannel מחובר! העברה תהיה מהירה');
            break;
          }
        }
        if (!App.dataChannel.isConnected(peerKey)) {
          console.log('[CHAT/P2P] ⏱️ chat DC לא התחבר תוך 5 שניות, ממשיך עם fallback');
        }
      } catch (e) {
        console.warn('[CHAT/P2P] ⚠️ שגיאה בחיבור chat DC:', e.message);
      }
    }
    
    // Send metadata first via encrypted relay message
    const pendingCaption = (() => {
      try {
        const att = typeof App.getChatFileAttachment === 'function' ? App.getChatFileAttachment(peerKey) : null;
        return String(att?.caption || '').trim();
      } catch (_) {
        return '';
      }
    })();
    const metadata = {
      type: 'file-offer',
      fileId,
      name: file.name,
      size: file.size,
      mimeType: file.type,
      keyStr,
      totalChunks: Math.ceil(file.size / CHUNK_SIZE),
      createdAt: Math.floor(Date.now() / 1000),
      caption: pendingCaption || undefined,
    };
    
    // שליחת metadata דרך signaling
    if (typeof App.sendP2PSignal === 'function') {
      console.log('[CHAT/P2P] 📡 שולח file-offer metadata', {
        fileId,
        attachmentType: metadata.mimeType || file?.type || 'unknown',
        size: file?.size,
        totalChunks: metadata.totalChunks
      });
      await App.sendP2PSignal(peerKey, metadata);
    } else {
      console.warn('[CHAT/P2P] ⚠️ App.sendP2PSignal לא זמין!');
    }
    
    const transfer = {
      fileId,
      file,
      key,
      keyStr,
      peerPubkey: peerKey,
      direction: 'send',
      currentChunk: 0,
      totalChunks: metadata.totalChunks,
      ackReceived: 0,
      paused: false,
      startTime: Date.now(),
      caption: pendingCaption || '',
      // חלק המתנה ל-DC (chat-p2p-file.js) – מונע fallback מוקדם ל-Blossom כש-DC נפתח באיחור קל | HYPER CORE TECH
      dcWaitAttempts: 0,
      // חלק יציבות DC (chat-p2p-file.js) – Channel קבוע להעברה ספציפית כדי לא לפתוח ערוצים חדשים בכל צ׳אנק | HYPER CORE TECH
      channel: null,
      lastAckedChunk: -1,
      completed: false,
      _sendInFlight: false,
      _sendQueued: false,
      _dcOfferSent: false,
      nextChunkToSend: 0,
      nextChunkToPrepare: 0,
      inFlightChunks: new Set(),
      ackedChunks: new Set(),
      preparingChunks: new Map(),
      preparedChunks: new Map(),
      sendGeneration: 0,
      maxInFlightSeen: 0,
      maxPreparingSeen: 0,
      maxPreparedSeen: 0,
      inFlightSampleSum: 0,
      inFlightSampleCount: 0,
      totalReadMs: 0,
      totalAesMs: 0,
      totalPrepareMs: 0,
    };
    
    activeTransfers.set(fileId, transfer);
    
    // עדכון UI על התחלת שליחה
    notifyProgress({
      fileId,
      progress: 0,
      status: 'starting',
      direction: 'send',
      name: file.name,
      size: file.size,
      mimeType: file.type,
      peerPubkey: peerKey
    });
    
    // Start sending chunks
    await sendNextChunk(fileId, onProgress);
    
    return fileId;
  }
  
  async function completeSendOnce(fileId, transfer, onProgress) {
    if (!transfer) return;
    if (transfer.completed || sendCompletedFileIds.has(fileId)) {
      transfer.completed = true;
      if (transfer._ackTimeout) { clearTimeout(transfer._ackTimeout); transfer._ackTimeout = null; }
      activeTransfers.delete(fileId);
      qaNote('complete-skipped', { fileId, reason: 'already-completed' });
      return;
    }
    transfer.completed = true;
    sendCompletedFileIds.add(fileId);
    transfer.sendGeneration = (transfer.sendGeneration || 0) + 1;
    clearAllPrep(transfer);
    if (transfer._ackTimeout) { clearTimeout(transfer._ackTimeout); transfer._ackTimeout = null; }
    if (transfer._progressUiTimer) {
      clearTimeout(transfer._progressUiTimer);
      transfer._progressUiTimer = null;
    }
    logSendTelemetry(transfer);

    const file = transfer.file;
    const peerKey = toPeerKey(transfer.peerPubkey);
    qaNote('complete', { fileId });
    console.log('[CHAT/P2P] ✅ שליחת קובץ הושלמה', fileId);

    recentCompletedFiles.set(fileId, { file, keyStr: transfer.keyStr, peerPubkey: peerKey, completedAt: Date.now() });
    setTimeout(() => {
      recentCompletedFiles.delete(fileId);
      sendCompletedFileIds.delete(fileId);
    }, FILE_RETAIN_MS);
    qaNote('resend-cache', { fileId });
    console.log('[CHAT/P2P] 💾 קובץ נשמר ל-resend cache למשך 3 דקות:', fileId);

    try {
      if (typeof App.appendChatMessage === 'function') {
        const localUrl = URL.createObjectURL(file);
        const resolvedMime = resolveMimeType(file?.type, file?.name);
        const isVideoFlag = shouldForceVideoFlag(file?.type, file?.name);
        const createdAt = Math.floor(Date.now() / 1000);
        const cacheKey = `p2p-file-${fileId}`;
        if (typeof App.persistChatP2PMedia === 'function') {
          await App.persistChatP2PMedia(fileId, file, {
            name: file?.name,
            type: resolvedMime || file?.type,
          });
          qaNote('cache-write', { fileId });
        }
        let posterDataUrl = '';
        if (typeof App.getChatTransferPreviewPoster === 'function') {
          posterDataUrl = App.getChatTransferPreviewPoster(fileId) || '';
        }
        if (!posterDataUrl && typeof document !== 'undefined') {
          try {
            const bubbleVid = document.querySelector(`[data-transfer-id="${fileId}"] video.chat-media-upload__media`);
            if (bubbleVid && bubbleVid.dataset.posterCaptured === '1' && bubbleVid.poster && bubbleVid.poster.length > 200) {
              posterDataUrl = bubbleVid.poster;
            } else if (bubbleVid && bubbleVid.videoWidth && bubbleVid.readyState >= 2) {
              const canvas = document.createElement('canvas');
              const scale = Math.min(1, 640 / bubbleVid.videoWidth);
              canvas.width = Math.max(1, Math.round(bubbleVid.videoWidth * scale));
              canvas.height = Math.max(1, Math.round(bubbleVid.videoHeight * scale));
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.drawImage(bubbleVid, 0, 0, canvas.width, canvas.height);
                const shot = canvas.toDataURL('image/jpeg', 0.82);
                if (shot && shot.length > 200) posterDataUrl = shot;
              }
            }
          } catch (_) {}
        }
        if (!posterDataUrl && isVideoFlag && typeof App.capturePosterFromBlob === 'function') {
          try {
            posterDataUrl = await App.capturePosterFromBlob(file, resolvedMime || file?.type || 'video/mp4');
          } catch (posterErr) {
            console.warn('[CHAT/P2P] poster capture (send) failed:', posterErr);
          }
        }
        if (posterDataUrl && typeof App.persistChatP2PPoster === 'function') {
          App.persistChatP2PPoster(fileId, posterDataUrl).catch(() => {});
        }
        if (posterDataUrl && typeof App.registerChatTransferPreview === 'function') {
          App.registerChatTransferPreview(fileId, { posterDataUrl });
        }
        const captionText = String(transfer.caption || '').trim()
          || String((typeof App.getChatFileAttachment === 'function' && App.getChatFileAttachment(peerKey)?.caption) || '').trim();
        const isVisualMedia = /^image\//i.test(resolvedMime || file?.type || '') || !!isVideoFlag;
        const messageContent = captionText || (isVisualMedia ? '' : `📎 ${file.name}`);
        App.appendChatMessage({
          id: `p2p-send-${fileId}`,
          from: App.publicKey,
          to: peerKey,
          content: messageContent,
          attachment: {
            name: file.name,
            size: file.size,
            type: resolvedMime || file.type,
            url: localUrl,
            fileId,
            cacheKey,
            isVideo: isVideoFlag || undefined,
            posterDataUrl: posterDataUrl || undefined,
            caption: captionText || undefined,
          },
          createdAt,
          direction: 'outgoing',
          status: 'sent',
          p2p: true,
          transport: 'DC',
        });
        qaNote('chat-append', { fileId });
        if (typeof App.markChatConversationRead === 'function') {
          App.markChatConversationRead(peerKey);
        }
        console.log('[CHAT/P2P] 💬 הודעת קובץ מקומית נוספה בצד השולח (עם cacheKey)', { hasPoster: !!posterDataUrl, hasCaption: !!captionText });
      }
    } catch (msgErr) { console.warn('[CHAT/P2P] append local p2p message failed:', msgErr); }
    if (typeof App.clearChatFileAttachment === 'function') {
      App.clearChatFileAttachment(peerKey);
    }
    activeTransfers.delete(fileId);
    const completePayload = { fileId, progress: 1, status: 'complete', direction: 'send', name: file.name, size: file.size, peerPubkey: peerKey };
    if (onProgress) onProgress(completePayload);
    notifyProgress(completePayload);
    logFileTransport(peerKey, 'p2p-transfer-complete');
    qaNote('transfer-complete-event', { fileId });
  }

  async function sendNextChunk(fileId, onProgress) {
    const transfer = activeTransfers.get(fileId);
    if (!transfer || transfer.paused || transfer.completed) return;
    if (onProgress) transfer._onProgress = onProgress;
    ensureSendWindowState(transfer);
    pumpPrepare(fileId);
    await pumpSend(fileId, transfer._onProgress);
  }

  async function pumpSend(fileId, onProgress) {
    const transfer = activeTransfers.get(fileId);
    if (!transfer || transfer.paused || transfer.completed) return;

    const { file, peerPubkey, totalChunks } = transfer;
    const peerKey = toPeerKey(peerPubkey);
    if (onProgress) transfer._onProgress = onProgress;
    ensureSendWindowState(transfer);

    if (allSendChunksAcked(transfer)) {
      await completeSendOnce(fileId, transfer, onProgress);
      return;
    }

    // מנעול סשדולר בלבד — לא עוטף FileReader/AES | HYPER CORE TECH
    if (transfer._sendInFlight) {
      transfer._sendQueued = true;
      qaNote('send-busy', { fileId, currentChunk: transfer.nextChunkToSend, inFlight: inFlightCount(transfer) });
      return;
    }

    transfer._sendInFlight = true;
    let scheduledRetry = false;
    try {
      if (transfer.nextChunkToSend === 0 && inFlightCount(transfer) === 0) {
        logFileTransport(peerKey, 'p2p-transfer-start');
      }
      let channel = transfer.channel && transfer.channel.readyState === 'open'
        ? transfer.channel
        : dataChannels.get(peerKey);
      if (transfer.channel && transfer.channel.readyState !== 'open') {
        transfer.channel = null;
      }

      if (!channel || channel.readyState !== 'open') {
        const conn = typeof App.getPersistentConnection === 'function'
          ? App.getPersistentConnection(peerKey)
          : null;

        if (conn && conn.channel && conn.channel.readyState === 'open') {
          console.log('[CHAT/P2P] 🔗 משתמש ב-persistent DataChannel לשליחה');
          channel = conn.channel;
          channel.binaryType = 'arraybuffer';
          dataChannels.set(peerKey, channel);
          transfer.channel = channel;
          attachCanonicalFileHandler(peerKey, channel);
        }
      }

      if (!channel || channel.readyState !== 'open') {
        const chatPC = App.dataChannel?.getChatPC?.(peerKey);
        if (chatPC && chatPC.connectionState === 'connected') {
          try {
            console.log('[CHAT/P2P] ⚡ יוצר file-transfer DC על chat PeerConnection');
            channel = chatPC.createDataChannel('file-transfer', { ordered: true });
            channel.binaryType = 'arraybuffer';
            attachCanonicalFileHandler(peerKey, channel);
            channel.addEventListener('close', () => {
              if (dataChannels.get(peerKey) === channel) {
                dataChannels.delete(peerKey);
              }
              if (transfer.channel === channel) {
                transfer.channel = null;
              }
            });
            dataChannels.set(peerKey, channel);
            transfer.channel = channel;
            if (channel.readyState !== 'open') {
              await new Promise((resolve, reject) => {
                const t = setTimeout(() => { reject(new Error('file DC open timeout')); }, 5000);
                channel.onopen = () => { clearTimeout(t); console.log('[CHAT/P2P] ⚡ file DC opened!'); resolve(); };
                channel.onerror = (e) => { clearTimeout(t); reject(e); };
              });
            }
          } catch (e) {
            console.warn('[CHAT/P2P] ⚠️ file DC on chat PC failed:', e.message);
            channel = null;
          }
        }
      }

      if (!channel || channel.readyState !== 'open') {
        if (transfer.dcWaitAttempts < 5) {
          transfer.dcWaitAttempts += 1;
          const chunkInfo = transfer.nextChunkToSend > 0 ? ` (chunk ${transfer.nextChunkToSend}/${totalChunks})` : '';
          console.log(`[CHAT/P2P] ⏳ DC לא פתוח${chunkInfo}, ניסיון ${transfer.dcWaitAttempts}/5...`);
          if (transfer.nextChunkToSend > 0 && transfer.dcWaitAttempts === 1) {
            transfer.channel = null;
            try {
              const chatPC = App.dataChannel?.getChatPC?.(peerKey);
              if (chatPC && chatPC.connectionState === 'connected') {
                console.log('[CHAT/P2P] ⚡ מנסה ליצור file-transfer DC חדש (reconnect)');
                const newCh = chatPC.createDataChannel('file-transfer', { ordered: true });
                newCh.binaryType = 'arraybuffer';
                attachCanonicalFileHandler(peerKey, newCh);
                newCh.addEventListener('close', () => { if (dataChannels.get(peerKey) === newCh) dataChannels.delete(peerKey); if (transfer.channel === newCh) transfer.channel = null; });
                dataChannels.set(peerKey, newCh);
                transfer.channel = newCh;
              }
            } catch (e) { console.warn('[CHAT/P2P] reconnect DC failed:', e.message); }
          }
          notifyProgress({
            fileId,
            progress: transfer.ackedChunks.size / totalChunks,
            status: 'waiting-peer',
            direction: 'send',
            name: file?.name,
            size: file?.size,
            mimeType: file?.type,
            peerPubkey: peerKey
          });
          scheduledRetry = true;
          setTimeout(() => sendNextChunk(fileId, onProgress), 500);
          return;
        }
        console.warn('[CHAT/P2P] ⚠️ DataChannel not ready after 5 retries, fallback to Blossom');
        logFileTransport(peerKey, 'url-fallback');
        if (typeof App.triggerOutgoingMessagePush === 'function') {
          App.triggerOutgoingMessagePush(peerKey, {
            eventId: transfer?.fileId || transfer?.id || '',
            hasAttachment: true,
          });
          console.log('[CHAT/P2P] 📲 Push נשלח לפיר לא מחובר:', peerKey?.slice(0,8));
        }
        quietTransferLog('ממתין לצד השני — עובר למסלול חלופי');
        await fallbackToBlossom(transfer, onProgress);
        return;
      }

      if (transfer.nextChunkToSend === 0 && !transfer._dcOfferSent) {
        try {
          const offerPlain = {
            type: 'file-offer',
            fileId,
            name: file.name,
            size: file.size,
            mimeType: file.type,
            keyStr: transfer.keyStr,
            totalChunks,
            createdAt: Math.floor((transfer.startTime || Date.now()) / 1000),
            caption: transfer.caption || undefined,
          };
          if (
            App.P2pSecureV2 &&
            App.P2pSecureV2.isLocalSecureP2pV2() &&
            App.P2pSecureV2.isPeerSecureP2pV2(peerKey) &&
            typeof App.P2pSecureV2.encryptFileOfferForDc === 'function'
          ) {
            App.P2pSecureV2.encryptFileOfferForDc(peerKey, offerPlain).then((wire) => {
              try {
                if (transfer.completed) return;
                const ch = transfer.channel || channel;
                if (!ch || ch.readyState !== 'open') return;
                ch.send(JSON.stringify(wire));
                transfer._dcOfferSent = true;
                console.log('[CHAT/P2P] secure file-offer sent via DC (fast path)');
              } catch (e) {
                console.warn('[CHAT/P2P] secure file-offer via DC failed:', e.message);
              }
            }).catch((e) => {
              console.warn('[CHAT/P2P] secure file-offer encrypt failed:', e && e.message ? e.message : e);
            });
          } else if (!App.P2pSecureV2 || !App.P2pSecureV2.isPeerSecureP2pV2(peerKey)) {
            // Key delivery: encrypted Nostr 30078 only (no LEGACY_DTLS_KEY_EXCHANGE).
            transfer._dcOfferSent = true;
          }
        } catch (e) { console.warn('[CHAT/P2P] file-offer via DC failed:', e.message); }
      }

      while (
        !transfer.completed &&
        !transfer.paused &&
        transfer.nextChunkToSend < totalChunks &&
        inFlightCount(transfer) < MAX_IN_FLIGHT
      ) {
        if (channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
          qaNote('buffer-pause', { fileId, bufferedAmount: channel.bufferedAmount, inFlight: inFlightCount(transfer), prepared: transfer.preparedChunks.size, preparing: transfer.preparingChunks.size });
          scheduledRetry = true;
          setTimeout(() => sendNextChunk(fileId, onProgress), 100);
          break;
        }

        const chunkIndex = transfer.nextChunkToSend;
        if (transfer.ackedChunks.has(chunkIndex) || transfer.inFlightChunks.has(chunkIndex)) {
          transfer.nextChunkToSend = chunkIndex + 1;
          transfer.currentChunk = transfer.nextChunkToSend;
          continue;
        }

        const prepared = transfer.preparedChunks.get(chunkIndex);
        if (!prepared) break;
        if (prepared.generation !== transfer.sendGeneration) {
          transfer.preparedChunks.delete(chunkIndex);
          qaNote('prepare-stale', { fileId, chunkIndex, generation: prepared.generation, phase: 'send' });
          continue;
        }

        try {
          channel.send(JSON.stringify({ type: 'chunk-meta', fileId, index: chunkIndex }));
          channel.send(prepared.payload);
          transfer.preparedChunks.delete(chunkIndex);
          transfer.inFlightChunks.add(chunkIndex);
          transfer.nextChunkToSend = chunkIndex + 1;
          transfer.currentChunk = transfer.nextChunkToSend;
          transfer.dcWaitAttempts = 0;
          sampleInFlight(transfer);
          qaNote('chunk-sent', { fileId, chunkIndex, inFlight: inFlightCount(transfer) });

          emitTransferProgress(transfer, onProgress, {
            fileId,
            progress: transfer.ackedChunks.size / totalChunks,
            status: 'sending',
            direction: 'send',
            name: transfer.file?.name,
            size: transfer.file?.size,
            mimeType: transfer.file?.type,
            peerPubkey: peerKey
          });
        } catch (err) {
          console.warn('[CHAT/P2P] ⚠️ channel.send נכשל, מאפס channel ומנסה שוב:', err.message);
          transfer.channel = null;
          if (dataChannels.get(peerKey) === channel) dataChannels.delete(peerKey);
          scheduledRetry = true;
          setTimeout(() => sendNextChunk(fileId, onProgress), 100);
          break;
        }
      }

      pumpPrepare(fileId);

      if (allSendChunksAcked(transfer)) {
        await completeSendOnce(fileId, transfer, onProgress);
      } else {
        armAckTimeout(fileId, transfer, peerKey);
      }
    } catch (err) {
      console.warn('[CHAT/P2P] pumpSend failed', err);
    } finally {
      transfer._sendInFlight = false;
      const queued = transfer._sendQueued;
      transfer._sendQueued = false;
      if (queued && !scheduledRetry && !transfer.completed && !transfer.paused) {
        pumpSend(fileId, transfer._onProgress);
      }
    }
  }

  // חלק קבלה (chat-p2p-file.js) – קבלת צ'אנקים והרכבת קובץ | HYPER CORE TECH
  function handleIncomingMessage(peerPubkey, data, sourceChannel) {
    const peerKey = toPeerKey(peerPubkey);
    qaNote('incoming-message', {
      peer: peerKey,
      kind: typeof data === 'string' ? 'json' : 'binary',
    });
    try {
      if (typeof data === 'string') {
        preferDataChannel(peerKey, sourceChannel);
        const msg = JSON.parse(data);
        if (msg.type === 'p2p-secure-file-offer') {
          if (!App.P2pSecureV2 || typeof App.P2pSecureV2.decryptFileOfferFromDc !== 'function') {
            console.warn('[SECURITY/PARSE_REJECT] kind=dc type=p2p-secure-file-offer reason=no_module');
            return;
          }
          App.P2pSecureV2.decryptFileOfferFromDc(peerKey, msg).then((offer) => {
            console.log('[CHAT/P2P] secure file-offer received via DC', offer.fileId, offer.mimeType || 'unknown', offer.size || 0);
            handleP2PFileOffer(peerKey, offer);
          }).catch((e) => {
            console.warn('[SECURITY/PARSE_REJECT] kind=dc type=p2p-secure-file-offer reason=' + (e && e.code ? e.code : 'decrypt_failed'));
          });
        } else if (msg.type === 'file-offer') {
          if (msg.keyStr) {
            console.warn('[SECURITY/PARSE_REJECT] kind=dc type=file-offer reason=legacy_plaintext_key_rejected');
            return;
          }
          console.log('[CHAT/P2P] file-offer via DC (no keyStr)', msg.fileId);
          handleP2PFileOffer(peerKey, msg);
        } else if (msg.type === 'chunk-meta') {
        } else if (msg.type === 'chunk-meta') {
          const transfer = activeTransfers.get(msg.fileId);
          if (transfer) {
            transfer.expectedChunk = msg.index;
            if (transfer.direction === 'receive') {
              peerPreferredReceiveFileId.set(peerKey, msg.fileId);
            }
          }
        } else if (msg.type === 'file-complete-ack') {
          // חלק ACK סיום (chat-p2p-file.js) — הצד השני אישר שהקובץ הורד בהצלחה e2e | HYPER CORE TECH
          console.log('[CHAT/P2P] ✅✅ אישור קבלה מלאה מהצד השני!', msg.fileId, msg.size || 0);
          notifyProgress({
            fileId: msg.fileId, progress: 1, status: 'verified', direction: 'send',
            name: msg.name, size: msg.size, peerPubkey: peerKey
          });
        } else if (msg.type === 'chunk-ack') {
          const transfer = activeTransfers.get(msg.fileId);
          if (transfer && transfer.direction === 'send') {
            if (transfer.completed) {
              qaNote('chunk-ack-ignored', { fileId: msg.fileId, index: msg.index, reason: 'completed' });
              return;
            }
            ensureSendWindowState(transfer);
            const ackIndex = typeof msg.index === 'number' ? msg.index : parseInt(msg.index, 10);
            if (!Number.isFinite(ackIndex)) {
              qaNote('chunk-ack-ignored', { fileId: msg.fileId, index: msg.index, reason: 'invalid' });
              return;
            }
            if (transfer.ackedChunks.has(ackIndex)) {
              qaNote('chunk-ack-ignored', { fileId: msg.fileId, index: ackIndex, reason: 'duplicate-or-stale' });
              return;
            }
            if (!transfer.inFlightChunks.has(ackIndex)) {
              qaNote('chunk-ack-ignored', { fileId: msg.fileId, index: ackIndex, reason: 'not-in-flight' });
              mediaDebugLog('chunk-ack stale/ignore', { fileId: msg.fileId, got: ackIndex, inFlight: [...transfer.inFlightChunks], next: transfer.nextChunkToSend });
              return;
            }
            transfer.inFlightChunks.delete(ackIndex);
            transfer.ackedChunks.add(ackIndex);
            while (transfer.ackedChunks.has(transfer.lastAckedChunk + 1)) {
              transfer.lastAckedChunk += 1;
            }
            preferDataChannel(peerKey, sourceChannel);
            sampleInFlight(transfer);
            qaNote('chunk-ack-accepted', { fileId: msg.fileId, index: ackIndex, inFlight: inFlightCount(transfer), acked: transfer.ackedChunks.size });
            if (ackIndex === 0 || ackIndex + 1 === transfer.totalChunks || ackIndex % 10 === 0) {
              console.log(`[CHAT/P2P] ✅ chunk-ack ${ackIndex} → inFlight ${inFlightCount(transfer)}/${MAX_IN_FLIGHT} acked ${transfer.ackedChunks.size}/${transfer.totalChunks}`);
            }
            if (allSendChunksAcked(transfer)) {
              completeSendOnce(msg.fileId, transfer, transfer._onProgress);
              return;
            }
            armAckTimeout(msg.fileId, transfer, peerKey);
            pumpPrepare(msg.fileId);
            pumpSend(msg.fileId, transfer._onProgress);
          }
        } else if (msg.type === 'ack') {
          const transfer = activeTransfers.get(msg.fileId);
          if (transfer) {
            transfer.ackReceived = msg.index;
          }
        } else if (msg.type === 'resume') {
          const transfer = activeTransfers.get(msg.fileId);
          if (transfer) {
            transfer.currentChunk = msg.fromChunk;
            transfer.paused = false;
          }
        } else if (msg.type === 'file-resend-request') {
          // חלק resend via DC (chat-p2p-file.js) — המקבל ביקש שליחה מחדש דרך DC | HYPER CORE TECH
          console.log('[CHAT/P2P] 🔄 file-resend-request התקבל דרך DC:', msg.fileId);
          handleFileResendRequest(peerKey, msg);
        } else if (msg.type === 'file-ready') {
          // חלק file-ready (chat-p2p-file.js) — המקבל מוכן לקבל chunks, בודקים אם צריך resend | HYPER CORE TECH
          console.log('[CHAT/P2P] 📥 file-ready התקבל:', msg.fileId);
          handleFileResendRequest(peerKey, msg);
        }
      } else if (data instanceof ArrayBuffer) {
        // Chunk data received — binary ישיר
        handleChunkData(peerKey, new Uint8Array(data), sourceChannel);
      } else if (data instanceof Blob) {
        // חלק Blob fallback (chat-p2p-file.js) — persistent channel עלול לשלוח Blob אם binaryType לא הוגדר | HYPER CORE TECH
        console.log('[CHAT/P2P] 🔄 Blob→ArrayBuffer conversion (binaryType fallback)', data.size, 'bytes');
        data.arrayBuffer().then(ab => {
          handleChunkData(peerKey, new Uint8Array(ab), sourceChannel);
        }).catch(e => console.error('[CHAT/P2P] Blob conversion failed:', e));
      }
    } catch (err) {
      console.error('handleIncomingMessage failed', err);
    }
  }

  async function handleChunkData(peerPubkey, encryptedData, sourceChannel) {
    const peerKey = toPeerKey(peerPubkey);
    preferDataChannel(peerKey, sourceChannel);
    // חלק סינון (chat-p2p-file.js) — בינארי קצר מדי אינו צ'אנק AES-GCM שלנו (מונע רעש מפרוטוקולים אחרים על אותו DC) | HYPER CORE TECH
    if (!encryptedData || encryptedData.byteLength < 32) {
      mediaDebugLog('skip binary (too short for encrypted chunk)', peerKey.slice(0, 8), encryptedData?.byteLength);
      return;
    }
    // חלק בחירת receive (chat-p2p-file.js) – בעת העברה דו-כיוונית מעדיפים fileId מ-chunk-meta | HYPER CORE TECH
    const preferredId = peerPreferredReceiveFileId.get(peerKey);
    const receiveEntries = [];
    for (const [fid, t] of activeTransfers.entries()) {
      if (t.peerPubkey === peerKey && t.direction === 'receive' && t.key && !t._initPending && !t.completed) {
        if (fid === preferredId) receiveEntries.unshift([fid, t]);
        else receiveEntries.push([fid, t]);
      }
    }
    for (const [fileId, transfer] of receiveEntries) {
      {
        // חלק index-based chunks (chat-p2p-file.js) — שומר chunk לפי index ולא push עיוור, מונע blob שבור | HYPER CORE TECH
        const chunkIndex = (typeof transfer.expectedChunk === 'number') ? transfer.expectedChunk : transfer.receivedChunks;
        if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= transfer.totalChunks) {
          console.warn('[SECURITY/PARSE_REJECT] kind=dc type=chunk reason=bad_index fileId=' + String(fileId).slice(0, 12));
          return;
        }
        // הגנה נגד chunk כפול — עדיין שולח chunk-ack כדי שהשולח יוכל להמשיך
        if (transfer.chunks[chunkIndex]) {
          console.log('[CHAT/P2P] ⚠️ chunk כפול נדחה:', chunkIndex, 'fileId:', fileId);
          const dupAckCh = replyChannel(peerKey, sourceChannel);
          if (dupAckCh) {
            try { dupAckCh.send(JSON.stringify({ type: 'chunk-ack', fileId, index: chunkIndex })); } catch (_e) {}
          } else if (typeof App.sendP2PSignal === 'function') {
            try { await App.sendP2PSignal(peerKey, { type: 'chunk-ack', fileId, index: chunkIndex }); } catch (_e) {}
          }
          return;
        }
        const decrypted = await decryptChunk(encryptedData, transfer.key);
        if (!decrypted) {
          console.error('[CHAT/P2P] Decryption failed for chunk', chunkIndex, 'fileId:', fileId);
          // העברה דו-כיוונית: מפתח של קובץ אחר — מנסים מועמד הבא במקום לעצור
          continue;
        }
        
        transfer.chunks[chunkIndex] = decrypted;
        transfer.receivedChunks++;
        peerPreferredReceiveFileId.set(peerKey, fileId);

        // חלק stall detection (chat-p2p-file.js) — מאפס timer על כל chunk, אם נתקע באמצע מבקש resend | HYPER CORE TECH
        if (transfer._resendTimer) { clearTimeout(transfer._resendTimer); transfer._resendTimer = null; }
        if (transfer._resendTimer2) { clearTimeout(transfer._resendTimer2); transfer._resendTimer2 = null; }
        transfer._lastChunkAt = Date.now();
        // אם עדיין לא סיימנו — מפעיל stall timer
        if (transfer.receivedChunks < transfer.totalChunks) {
          transfer._resendTimer = setTimeout(async () => {
            const t = activeTransfers.get(fileId);
            if (!t || t.direction !== 'receive') return;
            if (t.receivedChunks >= t.totalChunks) return; // כבר הושלם
            const secSinceLastChunk = ((Date.now() - (t._lastChunkAt || 0)) / 1000).toFixed(1);
            console.warn(`[CHAT/P2P] ⏱️ stall detected! ${t.receivedChunks}/${t.totalChunks} chunks, ${secSinceLastChunk}s since last chunk:`, fileId);
            const now = Date.now();
            if (t._lastResendRequestAt && (now - t._lastResendRequestAt) < RESEND_COOLDOWN_MS) {
              // לא מציפים בבקשות — מתזמן מחדש אחרי cooldown כדי לא לאבד את זיהוי ה-stall
              const retryIn = RESEND_COOLDOWN_MS - (now - t._lastResendRequestAt) + 500;
              t._resendTimer = setTimeout(() => {
                const t3 = activeTransfers.get(fileId);
                if (!t3 || t3.direction !== 'receive' || t3.receivedChunks >= t3.totalChunks) return;
                t3._lastChunkAt = t3._lastChunkAt || 0;
                // מפעיל מחדש את אותו לוגיקת stall ע״י הזזה אחורה של lastChunk
                if ((Date.now() - t3._lastChunkAt) >= CHUNK_STALL_WAIT_SEC * 1000) {
                  t3._resendTimer = null;
                  // ידני: קוראים ללוגיקה ע״י סימולציית timeout — מבקשים resend אם עדיין תקוע
                  const n2 = Date.now();
                  if (t3._lastResendRequestAt && (n2 - t3._lastResendRequestAt) < RESEND_COOLDOWN_MS) return;
                  t3._lastResendRequestAt = n2;
                  notifyProgress({ fileId, progress: t3.receivedChunks / t3.totalChunks, status: 'stalled-requesting-resend', direction: 'receive', name: t3.name, size: t3.size, peerPubkey: peerKey });
                  const dc2 = dataChannels.get(peerKey);
                  if (dc2 && dc2.readyState === 'open') {
                    try { dc2.send(JSON.stringify({ type: 'file-resend-request', fileId, fromChunk: t3.receivedChunks })); } catch (_e) {}
                  }
                }
              }, retryIn);
              return;
            }
            t._lastResendRequestAt = now;
            notifyProgress({ fileId, progress: t.receivedChunks / t.totalChunks, status: 'stalled-requesting-resend', direction: 'receive', name: t.name, size: t.size, peerPubkey: peerKey });
            // בקשת resend דרך DC
            const dc = dataChannels.get(peerKey);
            if (dc && dc.readyState === 'open') {
              try { dc.send(JSON.stringify({ type: 'file-resend-request', fileId, fromChunk: t.receivedChunks })); console.log('[CHAT/P2P] 🔄 stall resend-request דרך DC, fromChunk:', t.receivedChunks); } catch (_e) {}
            }
            // בקשת resend דרך Nostr signal
            if (typeof App.sendP2PSignal === 'function') {
              try { await App.sendP2PSignal(peerKey, { type: 'file-resend-request', fileId, fromChunk: t.receivedChunks }); } catch (_e) {}
            }
            // timeout אחרון — אם עדיין תקוע, fail
            t._resendTimer2 = setTimeout(() => {
              const t2 = activeTransfers.get(fileId);
              if (!t2 || t2.direction !== 'receive' || t2.receivedChunks >= t2.totalChunks) return;
              if (t2._lastChunkAt && (Date.now() - t2._lastChunkAt) < CHUNK_STALL_WAIT_SEC * 1000) return; // chunks חזרו!
              console.error('[CHAT/P2P] ❌ stall לא טופל — transfer נכשל:', fileId);
              notifyProgress({ fileId, progress: t2.receivedChunks / t2.totalChunks, status: 'failed', direction: 'receive', name: t2.name, size: t2.size, peerPubkey: peerKey, error: 'stalled mid-transfer' });
              activeTransfers.delete(fileId);
            }, POST_RESEND_FAIL_WAIT_SEC * 1000);
          }, CHUNK_STALL_WAIT_SEC * 1000);
        }

        // התקדמות לקבלה
        emitTransferProgress(transfer, null, {
          fileId,
          progress: transfer.receivedChunks / transfer.totalChunks,
          status: 'receiving',
          direction: 'receive',
          name: transfer.name,
          size: transfer.size,
          mimeType: transfer.mimeType,
          peerPubkey: peerKey
        });
        
        // חלק chunk-ack (chat-p2p-file.js) — עדיפות: אותו DC של ה-binary; גיבוי: סיגנל Nostr אם אין ערוץ פתוח | HYPER CORE TECH
        {
          const ackCh = replyChannel(peerKey, sourceChannel);
          if (ackCh) {
            try {
              ackCh.send(JSON.stringify({ type: 'chunk-ack', fileId, index: chunkIndex }));
            } catch (_e) {}
          } else if (typeof App.sendP2PSignal === 'function') {
            try {
              await App.sendP2PSignal(peerKey, { type: 'chunk-ack', fileId, index: chunkIndex });
            } catch (_e) {}
          }
        }
        
        // Save to IndexedDB periodically
        if (transfer.receivedChunks % 20 === 0) {
          await saveTransferState(fileId, transfer);
        }
        
        if (transfer.receivedChunks >= transfer.totalChunks) {
          peerPreferredReceiveFileId.delete(peerKey);
          await finalizeReceive(fileId, transfer);
        }
        
        return; // מצאנו transfer מתאים — יציאה
      }
    }
    // חלק buffer chunks (chat-p2p-file.js) – רק אם באמת מחכים לקובץ שיחה, לא בינארי של פיד | HYPER CORE TECH
    if (!isReceivingChatFile(peerKey)) {
      mediaDebugLog('drop binary (not a chat file receive)', peerKey.slice(0, 8), encryptedData?.byteLength);
      return;
    }
    if (!pendingChunks.has(peerKey)) pendingChunks.set(peerKey, []);
    const buf = pendingChunks.get(peerKey);
    if (buf.length >= MAX_PENDING_CHUNKS_PER_PEER) {
      console.warn('[SECURITY/RATE_DROP] type=file-chunk peer=' + peerKey.slice(0, 8) + ' reason=pending_overflow');
      return;
    }
    buf.push(encryptedData);
    console.log('[CHAT/P2P] 📦 Chunk buffered (ממתין ל-file-offer)', peerKey.slice(0,8), 'buffered:', buf.length);
  }

  // חלק resend handler (chat-p2p-file.js) — שולח קובץ מחדש מ-cache כשהמקבל מבקש | HYPER CORE TECH
  async function handleFileResendRequest(requesterPubkey, msg) {
    const fileId = msg.fileId;
    // בדיקה ראשונה: שליחה פעילה — rewind אם המקבל מאחורי ה-cursor (לא מתעלמים עיוורית)
    if (activeTransfers.has(fileId)) {
      const t = activeTransfers.get(fileId);
      if (t.direction === 'send') {
        if (t.completed) {
          qaNote('resend-ignored-completed', { fileId });
          return;
        }
        ensureSendWindowState(t);
        const hasFrom = msg.fromChunk !== undefined && msg.fromChunk !== null && msg.type === 'file-resend-request';
        const fromChunk = hasFrom ? Math.max(0, parseInt(msg.fromChunk, 10) || 0) : null;
        if (hasFrom && fromChunk !== null && fromChunk < t.nextChunkToSend) {
          const attempts = (resendAttemptCounts.get(fileId) || 0) + 1;
          resendAttemptCounts.set(fileId, attempts);
          if (attempts > MAX_RESEND_ATTEMPTS) {
            console.warn('[SECURITY/RATE_DROP] type=file-resend peer=' + String(requesterPubkey || '').slice(0, 8) + ' reason=max_resend');
            qaNote('resend-ignored-max-attempts', { fileId, attempts });
            return;
          }
          applySendRewind(t, fromChunk);
          t.dcWaitAttempts = 0;
          qaNote('resend-rewind', { fileId, fromChunk, generation: t.sendGeneration });
          console.log('[CHAT/P2P] 🔄 resend באמצע שליחה — חוזרים ל-chunk', fromChunk, fileId);
          sendNextChunk(fileId, t._onProgress);
          return;
        }
        if (msg.type === 'file-ready') {
          return;
        }
        mediaDebugLog('resend ignored (send in progress)', fileId, t.currentChunk, msg);
        return;
      }
    }
    const cached = recentCompletedFiles.get(fileId);
    if (!cached) {
      const age = fileOfferAgeMs(fileId);
      if (age < 15 * 60 * 1000) {
        console.warn('[CHAT/P2P] ⚠️ resend request עבור fileId שלא ב-cache:', fileId);
      } else {
        mediaDebugLog('stale resend / no cache', fileId);
      }
      // שולח הודעת כשלון למקבל דרך DC
      const ch = dataChannels.get(toPeerKey(requesterPubkey));
      if (ch && ch.readyState === 'open') {
        try { ch.send(JSON.stringify({ type: 'file-resend-failed', fileId, reason: 'file-expired' })); } catch (_e) {}
      }
      return;
    }
    const fromChunk = Math.max(0, parseInt(msg.fromChunk, 10) || 0);
    if (!Number.isFinite(fromChunk) || fromChunk < 0) {
      console.warn('[SECURITY/PARSE_REJECT] kind=dc type=file-resend-request reason=bad_fromChunk');
      return;
    }
    const attempts = (resendAttemptCounts.get(fileId) || 0) + 1;
    resendAttemptCounts.set(fileId, attempts);
    if (attempts > MAX_RESEND_ATTEMPTS) {
      console.warn('[SECURITY/RATE_DROP] type=file-resend peer=' + String(requesterPubkey || '').slice(0, 8) + ' reason=max_resend');
      return;
    }
    console.log('[CHAT/P2P] 🔄 מתחיל resend עבור:', fileId, 'fromChunk:', fromChunk);
    quietTransferLog('resend-start', fileId, 'fromChunk', fromChunk);
    // שליחה מחדש — שימוש חוזר באותו fileId ומפתח הצפנה, מתחיל מ-fromChunk
    const peerKey = toPeerKey(requesterPubkey);
    const file = cached.file;
    const key = await importFileKey(cached.keyStr);
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    // אם כבר יש שליחת resend פעילה לאותו fileId — לא יוצרים כפילות שגורמת לקפיצות
    const existingSend = activeTransfers.get(fileId);
    if (existingSend && existingSend.direction === 'send' && existingSend.isResend) {
      quietTransferLog('resend already in progress', fileId);
      return;
    }
    const transfer = {
      fileId, file, key, keyStr: cached.keyStr, peerPubkey: peerKey,
      direction: 'send', currentChunk: fromChunk, totalChunks,
      ackReceived: 0, paused: false, startTime: Date.now(),
      dcWaitAttempts: 0, channel: null, isResend: true,
      lastAckedChunk: fromChunk - 1,
      completed: false,
      _sendInFlight: false,
      _sendQueued: false,
      _dcOfferSent: fromChunk > 0,
      nextChunkToSend: fromChunk,
      nextChunkToPrepare: fromChunk,
      inFlightChunks: new Set(),
      ackedChunks: new Set(Array.from({ length: fromChunk }, (_, i) => i)),
      preparingChunks: new Map(),
      preparedChunks: new Map(),
      sendGeneration: 1,
      maxInFlightSeen: 0,
      maxPreparingSeen: 0,
      maxPreparedSeen: 0,
      inFlightSampleSum: 0,
      inFlightSampleCount: 0,
      totalReadMs: 0,
      totalAesMs: 0,
      totalPrepareMs: 0,
    };
    activeTransfers.set(fileId, transfer);
    notifyProgress({ fileId, progress: fromChunk / totalChunks, status: 'resending', direction: 'send', name: file.name, size: file.size, mimeType: file.type, peerPubkey: peerKey });
    await sendNextChunk(fileId, null);
  }

  // חלק קבלת file-offer (chat-p2p-file.js) – טיפול בהצעת קובץ נכנסת מ-peer | HYPER CORE TECH
  async function handleP2PFileOffer(senderPubkey, offerData) {
    const senderKey = toPeerKey(senderPubkey);
    try {
      const { fileId, name, size, mimeType, keyStr, totalChunks, createdAt: offerCreatedAt, caption: offerCaption } = offerData || {};
      
      console.log('[CHAT/P2P] 📥 handleP2PFileOffer', {
        from: senderKey?.slice?.(0, 8),
        fileId,
        attachmentType: mimeType || 'unknown',
        size,
        totalChunks
      });
      recentIncomingFileOffers.set(senderKey, Date.now());
      try {
        if (typeof App.setFeedWarmupPaused === 'function') App.setFeedWarmupPaused(true);
        if (typeof App.pauseFeedMediaForChat === 'function') App.pauseFeedMediaForChat('chat-file-recv');
      } catch (_) {}
      
      if (!fileId || !keyStr) {
        console.warn('[CHAT/P2P] ⚠️ file-offer חסר fileId או keyStr');
        return;
      }
      if (typeof fileId !== 'string' || fileId.length > 256 || typeof keyStr !== 'string' || keyStr.length > 512) {
        console.warn('[SECURITY/PARSE_REJECT] kind=dc type=file-offer reason=bad_ids');
        return;
      }
      const sizeNum = Number(size);
      const chunksNum = Number(totalChunks);
      if (!Number.isFinite(sizeNum) || sizeNum < 0 || sizeNum > MAX_CLAIMED_FILE_SIZE) {
        console.warn('[SECURITY/PARSE_REJECT] kind=dc type=file-offer reason=bad_size');
        return;
      }
      if (totalChunks != null && (!Number.isFinite(chunksNum) || chunksNum < 1 || chunksNum > MAX_TOTAL_CHUNKS || !Number.isInteger(chunksNum))) {
        console.warn('[SECURITY/PARSE_REJECT] kind=dc type=file-offer reason=bad_totalChunks');
        return;
      }
      const { globalN, peerN } = countInboundReceives(senderKey);
      if (globalN >= MAX_INBOUND_RECEIVES_GLOBAL || peerN >= MAX_INBOUND_RECEIVES_PER_PEER) {
        console.warn('[SECURITY/RATE_DROP] type=file-offer peer=' + senderKey.slice(0, 8) + ' reason=inbound_cap');
        return;
      }

      const safeName = sanitizeOfferFileName(name);
      const safeMime = safeBlobContentType(mimeType);
      if (mimeType != null && mimeType !== '' && typeof mimeType === 'string' && mimeType.length > 200) {
        console.warn('[SECURITY/PARSE_REJECT] kind=dc type=file-offer reason=bad_mime');
        return;
      }

      if (activeTransfers.has(fileId)) {
        console.log('[CHAT/P2P] העברה כבר קיימת עבור fileId:', fileId);
        qaNote('offer-ignored-existing', { fileId });
        return;
      }

      const transfer = {
        fileId,
        name: safeName,
        size: sizeNum,
        mimeType: safeMime,
        key: null,
        keyStr,
        peerPubkey: senderKey,
        direction: 'receive',
        totalChunks: Number.isFinite(chunksNum) && chunksNum > 0 ? chunksNum : Math.ceil(sizeNum / CHUNK_SIZE) || 1,
        receivedChunks: 0,
        chunks: [],
        startTime: Date.now(),
        caption: String(offerCaption || '').trim().slice(0, 2000),
        offerCreatedAt: typeof offerCreatedAt === 'number' && offerCreatedAt > 0
          ? offerCreatedAt
          : Math.floor(Date.now() / 1000),
        _initPending: true,
        completed: false,
      };
      activeTransfers.set(fileId, transfer);
      qaNote('offer-reserved', { fileId });

      try {
        const hold = qaHold('before-import-key', { fileId });
        if (hold && typeof hold.then === 'function') await hold;
        const key = await importFileKey(keyStr);
        if (activeTransfers.get(fileId) !== transfer) {
          qaNote('offer-abandoned', { fileId, reason: 'replaced' });
          return;
        }
        transfer.key = key;
        transfer._initPending = false;
      } catch (importErr) {
        if (activeTransfers.get(fileId) === transfer) {
          activeTransfers.delete(fileId);
        }
        console.error('[CHAT/P2P] ❌ ייבוא מפתח נכשל:', importErr);
        qaNote('offer-import-failed', { fileId });
        return;
      }
      
      console.log('[CHAT/P2P] ✅ transfer state נוצר לקבלה', {
        fileId,
        attachmentType: mimeType || 'unknown',
        size,
        totalChunks: transfer.totalChunks
      });
      
      // עדכון UI על התחלת קבלה
      notifyProgress({
        fileId,
        progress: 0,
        status: 'waiting',
        direction: 'receive',
        name,
        size,
        mimeType,
        peerPubkey: senderKey
      });
      
      // ניסיון להשיג DataChannel מ-p2p-video-sharing.js
      const conn = typeof App.getPersistentConnection === 'function' 
        ? App.getPersistentConnection(senderKey) 
        : null;
      
      if (conn && conn.channel && conn.channel.readyState === 'open') {
        console.log('[CHAT/P2P] 🔗 משתמש ב-persistent DataChannel לקבלת צ\'אנקים');
        conn.channel.binaryType = 'arraybuffer'; // חובה — בלי זה binary מגיע כ-Blob ונזרק
        // שמירת ה-channel המקושר
        dataChannels.set(senderKey, conn.channel);
        attachCanonicalFileHandler(senderKey, conn.channel);
      } else {
        // חלק DC fallback + חיבור אקטיבי (chat-p2p-file.js) – מנסה לחבר DC אם אין, ושולח file-ready | HYPER CORE TECH
        const existingDC = dataChannels.get(senderKey);
        if (existingDC && existingDC.readyState === 'open') {
          console.log('[CHAT/P2P] 🔗 משתמש ב-file DC קיים');
        } else {
          console.log('[CHAT/P2P] ⚠️ אין DC פתוח עדיין, מנסה לחבר...');
          // ניסיון אקטיבי לחבר DC
          if (App.dataChannel && !App.dataChannel.isConnected(senderKey)) {
            try {
              App.dataChannel.init?.();
              if (typeof App.dataChannel.forceConnect === 'function') {
                await App.dataChannel.forceConnect(senderKey);
              } else {
                App.dataChannel.connect(senderKey);
              }
              // ממתין עד 5 שניות ל-DC
              for (let i = 0; i < 25; i++) {
                await new Promise(r => setTimeout(r, 200));
                if (App.dataChannel.isConnected(senderKey)) {
                  console.log('[CHAT/P2P] ⚡ DC מחובר! שולח file-ready לשולח');
                  break;
                }
              }
            } catch (e) {
              console.warn('[CHAT/P2P] ⚠️ שגיאה בחיבור DC:', e.message);
            }
          }
        }
      }

      // חלק file-ready (chat-p2p-file.js) — שולח הודעת מוכנות לשולח כשה-DC פתוח | HYPER CORE TECH
      const readyDC = dataChannels.get(senderKey);
      const chatDC = App.dataChannel?.isConnected?.(senderKey);
      if (readyDC && readyDC.readyState === 'open') {
        try {
          readyDC.send(JSON.stringify({ type: 'file-ready', fileId }));
          console.log('[CHAT/P2P] 📤 file-ready נשלח דרך file DC');
        } catch (_e) {}
      } else if (chatDC) {
        // שולח דרך chat DC
        const chatPC = App.dataChannel?.getChatPC?.(senderKey);
        if (chatPC && chatPC.connectionState === 'connected') {
          try {
            const tmpCh = chatPC.createDataChannel('file-transfer', { ordered: true });
            tmpCh.binaryType = 'arraybuffer';
            attachCanonicalFileHandler(senderKey, tmpCh);
            tmpCh.addEventListener('close', () => { if (dataChannels.get(senderKey) === tmpCh) dataChannels.delete(senderKey); });
            dataChannels.set(senderKey, tmpCh);
            if (tmpCh.readyState !== 'open') {
              await new Promise((resolve) => {
                const t = setTimeout(resolve, 5000);
                tmpCh.onopen = () => { clearTimeout(t); resolve(); };
              });
            }
            if (tmpCh.readyState === 'open') {
              tmpCh.send(JSON.stringify({ type: 'file-ready', fileId }));
              console.log('[CHAT/P2P] 📤 file-ready נשלח דרך chat DC חדש');
            }
          } catch (e) { console.warn('[CHAT/P2P] file-ready via chat DC failed:', e.message); }
        }
      }

      // חלק replay buffer (chat-p2p-file.js) – השמעת chunks שהגיעו לפני ה-file-offer (race condition fix) | HYPER CORE TECH
      const buffered = pendingChunks.get(senderKey);
      if (buffered && buffered.length > 0) {
        console.log('[CHAT/P2P] 📦 Replaying', buffered.length, 'buffered chunks for', fileId);
        const chunksToReplay = [...buffered];
        pendingChunks.delete(senderKey);
        for (const chunkData of chunksToReplay) {
          await handleChunkData(senderKey, chunkData);
        }
      }

      // חלק timeout resend (chat-p2p-file.js) — אם לא הגיע chunk ראשון, מבקש resend ברקע בלי Toast | HYPER CORE TECH
      const initialWaitMs = Math.max(INITIAL_CHUNK_WAIT_SEC * 1000, Math.min(25000, Math.ceil((size || 0) / (64 * 1024)) * 400));
      transfer._resendTimer = setTimeout(async () => {
        const t = activeTransfers.get(fileId);
        if (!t || t.direction !== 'receive') return;
        if (t.receivedChunks > 0) return; // chunks הגיעו — הכל תקין
        console.warn('[CHAT/P2P] ⏱️ לא הגיעו chunks תוך', initialWaitMs, 'ms עבור:', fileId);
        const now = Date.now();
        if (t._lastResendRequestAt && (now - t._lastResendRequestAt) < RESEND_COOLDOWN_MS) return;
        t._lastResendRequestAt = now;
        notifyProgress({ fileId, progress: 0, status: 'requesting-resend', direction: 'receive', name, size, mimeType, peerPubkey: senderKey });
        // ניסיון 1: בקשת resend דרך DC (עם fromChunk)
        const dc = dataChannels.get(senderKey);
        if (dc && dc.readyState === 'open') {
          try { dc.send(JSON.stringify({ type: 'file-resend-request', fileId, fromChunk: 0 })); console.log('[CHAT/P2P] 🔄 file-resend-request נשלח דרך DC (fromChunk:0)'); } catch (_e) {}
        }
        // ניסיון 2: בקשת resend דרך Nostr signal
        if (typeof App.sendP2PSignal === 'function') {
          try {
            await App.sendP2PSignal(senderKey, { type: 'file-resend-request', fileId, fromChunk: 0 });
            console.log('[CHAT/P2P] 🔄 file-resend-request נשלח דרך Nostr signal (fromChunk:0)');
          } catch (_e) {}
        }
        // timeout שני — אם עדיין לא הגיעו chunks, fallback
        transfer._resendTimer2 = setTimeout(() => {
          const t2 = activeTransfers.get(fileId);
          if (!t2 || t2.direction !== 'receive' || t2.receivedChunks > 0) return;
          console.error('[CHAT/P2P] ❌ resend נכשל — הקובץ לא הגיע אחרי 2 ניסיונות');
          notifyProgress({ fileId, progress: 0, status: 'failed', direction: 'receive', name, size, peerPubkey: senderKey, error: 'no chunks received after resend' });
          activeTransfers.delete(fileId);
        }, POST_RESEND_FAIL_WAIT_SEC * 1000);
      }, initialWaitMs);

    } catch (err) {
      console.error('[CHAT/P2P] ❌ כשלון ב-handleP2PFileOffer:', err);
      const pending = fileId ? activeTransfers.get(fileId) : null;
      if (pending && pending._initPending) {
        activeTransfers.delete(fileId);
        qaNote('offer-reservation-released', { fileId });
      }
    }
  }

  // חלק שמירת מצב (chat-p2p-file.js) – שמירת מצב העברה ל-IndexedDB לצורך resume | HYPER CORE TECH
  async function saveTransferState(fileId, transfer) {
    try {
      // בדיקה אם יש SOS2MediaCache זמין
      if (typeof App.SOS2MediaCache === 'undefined' || !App.SOS2MediaCache) {
        if (!transfer._idbSkipLogged) {
          transfer._idbSkipLogged = true;
          console.log('[CHAT/P2P] IndexedDB cache לא זמין, דילוג על שמירה');
        }
        return;
      }
      
      const stateToSave = {
        fileId,
        name: transfer.name,
        size: transfer.size,
        mimeType: transfer.mimeType,
        keyStr: transfer.keyStr,
        peerPubkey: transfer.peerPubkey,
        direction: transfer.direction,
        totalChunks: transfer.totalChunks,
        receivedChunks: transfer.receivedChunks,
        startTime: transfer.startTime,
        lastUpdate: Date.now()
      };
      
      console.log('[CHAT/P2P] 💾 שומר מצב העברה', { fileId, receivedChunks: transfer.receivedChunks });
      
      // שמירה ל-IndexedDB דרך media-cache אם זמין
      if (typeof App.SOS2MediaCache.saveTransferState === 'function') {
        await App.SOS2MediaCache.saveTransferState(fileId, stateToSave);
      }
    } catch (err) {
      console.warn('[CHAT/P2P] ⚠️ כשלון בשמירת מצב העברה:', err);
    }
  }

  // חלק סיום קבלה (chat-p2p-file.js) – הרכבת הקובץ ושמירה ל-cache | HYPER CORE TECH
  async function finalizeReceive(fileId, transfer) {
    if (!transfer || transfer.completed) {
      qaNote('receive-complete-skipped', { fileId });
      return;
    }
    // completion gate — missing/extra chunks must not assemble | HYPER CORE TECH
    if (
      !Number.isFinite(transfer.totalChunks) ||
      transfer.totalChunks < 1 ||
      transfer.receivedChunks < transfer.totalChunks
    ) {
      console.warn('[SECURITY/PARSE_REJECT] kind=dc type=complete reason=incomplete_chunks');
      return;
    }
    let filled = 0;
    for (let i = 0; i < transfer.totalChunks; i += 1) {
      if (transfer.chunks[i]) filled += 1;
    }
    if (filled < transfer.totalChunks) {
      console.warn('[SECURITY/PARSE_REJECT] kind=dc type=complete reason=sparse_chunks');
      return;
    }
    transfer.completed = true;
    try {
      console.log('[CHAT/P2P] 🎉 מסיים קבלת קובץ', {
        fileId,
        attachmentType: transfer.mimeType || 'unknown',
        chunks: transfer.chunks.length,
        totalSize: transfer.size
      });
      // חלק דיבאג קבלה (chat-p2p-file.js) – רישום מטא אחרי הרכבת קובץ | HYPER CORE TECH
      mediaDebugLog('receive-finalize', { fileId, name: transfer.name, size: transfer.size, mimeType: transfer.mimeType });
      
      // הרכבת כל הצ'אנקים ל-Blob — MIME clamped (never text/html) | HYPER CORE TECH
      const safeType = safeBlobContentType(transfer.mimeType);
      transfer.mimeType = safeType;
      transfer.name = sanitizeOfferFileName(transfer.name);
      const blob = new Blob(transfer.chunks.slice(0, transfer.totalChunks), { type: safeType });
      if (Number.isFinite(transfer.size) && transfer.size > 0 && blob.size !== transfer.size) {
        console.warn('[SECURITY/PARSE_REJECT] kind=dc type=complete reason=size_mismatch');
        transfer.completed = false;
        activeTransfers.delete(fileId);
        notifyProgress({
          fileId,
          progress: 0,
          status: 'failed',
          direction: 'receive',
          name: transfer.name,
          size: transfer.size,
          peerPubkey: transfer.peerPubkey,
          error: 'size_mismatch',
        });
        return;
      }
      
      // שמירה ל-cache יציב לפי fileId (שורד restart) | HYPER CORE TECH
      const cacheKey = `p2p-file-${fileId}`;
      try {
        if (typeof App.persistChatP2PMedia === 'function') {
          await App.persistChatP2PMedia(fileId, blob, {
            name: transfer.name,
            type: transfer.mimeType,
          });
          console.log('[CHAT/P2P] 💾 קובץ נשמר בקאש צ\'אט יציב', { cacheKey });
        } else if (typeof App.cacheMedia === 'function') {
          await App.cacheMedia(cacheKey, cacheKey, blob, transfer.mimeType || blob.type, { pinned: true });
          console.log('[CHAT/P2P] 💾 קובץ נשמר ב-media-cache', { cacheKey });
        }
      } catch (cacheErr) {
        console.warn('[CHAT/P2P] ⚠️ כשלון בשמירה ל-cache:', cacheErr);
      }

      // תאימות לאחור ל־SOS2MediaCache אם קיים | HYPER CORE TECH
      if (typeof App.SOS2MediaCache !== 'undefined' && App.SOS2MediaCache) {
        try {
          if (typeof App.SOS2MediaCache.put === 'function') {
            await App.SOS2MediaCache.put(cacheKey, blob, {
              name: transfer.name,
              size: transfer.size,
              mimeType: transfer.mimeType,
              fileId,
              peerPubkey: transfer.peerPubkey,
              receivedAt: Date.now()
            });
          }
          if (typeof App.SOS2MediaCache.deleteTransferState === 'function') {
            await App.SOS2MediaCache.deleteTransferState(fileId);
          }
        } catch (cacheErr) {
          console.warn('[CHAT/P2P] ⚠️ כשלון ב-SOS2MediaCache:', cacheErr);
        }
      }
      
      // הסרת ההעברה מהרשימה הפעילה
      activeTransfers.delete(fileId);
      
      console.log('[CHAT/P2P] ✅ קבלת קובץ הושלמה בהצלחה!', { fileId, attachmentType: transfer.mimeType || 'unknown', size: transfer.size });

      // חלק הודעת צ'אט למקבל (chat-p2p-file.js) — blob לsession + cacheKey לשחזור אחרי restart | HYPER CORE TECH
      try {
        const blobUrl = URL.createObjectURL(blob);
        if (typeof App.appendChatMessage === 'function') {
          // זמן מקורי מה-offer — לא "עכשיו" אחרי סיום ההורדה | HYPER CORE TECH
          const createdAt =
            (typeof transfer.offerCreatedAt === 'number' && transfer.offerCreatedAt > 0
              ? transfer.offerCreatedAt
              : Math.floor((transfer.startTime || Date.now()) / 1000));
          const resolvedMime = resolveMimeType(transfer.mimeType, transfer.name);
          const isVideoFlag = shouldForceVideoFlag(transfer.mimeType, transfer.name);
          // תקציר מיידי מה־blob שהתקבל — לפני append | HYPER CORE TECH
          let posterDataUrl = '';
          if (isVideoFlag && typeof App.capturePosterFromBlob === 'function') {
            try {
              posterDataUrl = await App.capturePosterFromBlob(blob, resolvedMime || transfer.mimeType);
              if (posterDataUrl && typeof App.persistChatP2PPoster === 'function') {
                App.persistChatP2PPoster(fileId, posterDataUrl).catch(() => {});
              }
            } catch (posterErr) {
              console.warn('[CHAT/P2P] poster capture (recv) failed:', posterErr);
            }
          }
          App.appendChatMessage({
            id: `p2p-recv-${fileId}`,
            direction: 'incoming',
            from: transfer.peerPubkey,
            to: App.publicKey,
            content: (() => {
              const captionText = String(transfer.caption || '').trim();
              const isVisualMedia = /^image\//i.test(resolvedMime || transfer.mimeType || '') || !!isVideoFlag;
              return captionText || (isVisualMedia ? '' : `📎 ${transfer.name}`);
            })(),
            attachment: {
              name: transfer.name,
              size: transfer.size,
              type: resolvedMime || transfer.mimeType,
              url: blobUrl,
              fileId,
              cacheKey,
              isVideo: isVideoFlag || undefined,
              posterDataUrl: posterDataUrl || undefined,
              caption: String(transfer.caption || '').trim() || undefined,
            },
            p2p: true,
            transport: 'DC',
            createdAt,
          });
          console.log('[CHAT/P2P] 💬 הודעת צ\'אט נוצרה למקבל עם cacheKey יציב', { hasPoster: !!posterDataUrl, hasCaption: !!transfer.caption });
        }
      } catch (msgErr) { console.warn('[CHAT/P2P] appendChatMessage failed:', msgErr); }

      // עדכון UI אחרי שההודעה כבר במאגר — בלי בועת התקדמות | HYPER CORE TECH
      notifyProgress({
        fileId,
        progress: 1,
        status: 'complete',
        direction: 'receive',
        name: transfer.name,
        size: transfer.size,
        mimeType: transfer.mimeType,
        peerPubkey: transfer.peerPubkey,
        blob
      });

      // חלק ACK סיום (chat-p2p-file.js) — שליחת אישור קבלה מלאה חזרה לשולח | HYPER CORE TECH
      try {
        const ackChannel = dataChannels.get(transfer.peerPubkey);
        if (ackChannel && ackChannel.readyState === 'open') {
          ackChannel.send(JSON.stringify({ type: 'file-complete-ack', fileId, name: transfer.name, size: transfer.size }));
          console.log('[CHAT/P2P] 📨 ACK קבלה מלאה נשלח לשולח', fileId);
        }
      } catch (ackErr) { console.warn('[CHAT/P2P] ACK send failed:', ackErr); }
      
    } catch (err) {
      console.error('[CHAT/P2P] ❌ כשלון בסיום קבלה:', err);
      transfer.completed = false;
      notifyProgress({
        fileId,
        progress: 0,
        status: 'failed',
        direction: 'receive',
        error: err.message
      });
    }
  }

  // חלק זיהוי סוג קובץ (chat-p2p-file.js) – בודק אם קובץ נתמך ע"י Blossom (מדיה בלבד) | HYPER CORE TECH
  function isBlossomSupported(mimeType, fileName) {
    if (typeof App.isPrivateChatServerFileSupported === 'function') {
      return App.isPrivateChatServerFileSupported(mimeType, fileName);
    }
    if (!mimeType) return false;
    const m = String(mimeType).toLowerCase();
    return m.startsWith('image/') || m.startsWith('video/') || m.startsWith('audio/');
  }

  // חלק fallback חכם (chat-p2p-file.js) – מדיה → Blossom, שאר קבצים → WebTorrent P2P | HYPER CORE TECH
  async function fallbackToBlossom(transfer, onProgress) {
    try {
      const mime = transfer.file?.type || '';
      const fileName = transfer.file?.name || 'קובץ';
      const fileSize = transfer.file?.size || 0;
      // חלק דיבאג fallback (chat-p2p-file.js) – רישום מסלול נבחר ומאפייני הקובץ | HYPER CORE TECH
      mediaDebugLog('fallback-check', { fileId: transfer.fileId, name: fileName, size: fileSize, mime, blossomSupported: isBlossomSupported(mime, fileName) });

      if (!isBlossomSupported(mime, fileName)) {
        mediaDebugLog('fallback-to-torrent', { fileId: transfer.fileId, name: fileName, size: fileSize, mime });
        console.log('[CHAT/P2P] 🧲 קובץ לא-נתמך Blossom, מעביר דרך WebTorrent P2P', { attachmentType: mime, size: fileSize });
        logFileTransport(transfer.peerPubkey, 'relay-fallback');
        await fallbackToTorrent(transfer, onProgress);
        return;
      }

      console.log('[CHAT/P2P] 🔄 Fallback to Blossom upload', {
        fileId: transfer.fileId,
        attachmentType: mime,
        size: fileSize
      });

      // חלק fallback (chat-p2p-file.js) – עדכון progress לפני התחלת העלאה | HYPER CORE TECH
      const uploadingPayload = {
        fileId: transfer.fileId,
        progress: 0.1,
        status: 'uploading-blossom',
        direction: 'send',
        name: fileName,
        size: fileSize,
        mimeType: mime,
        peerPubkey: transfer.peerPubkey
      };
      if (onProgress) onProgress(uploadingPayload);
      notifyProgress(uploadingPayload);
      
      // העלאה ל-Blossom - הפונקציה מחזירה URL ישירות (לא object)
      // Hotfix: await authoritative mediaServerE2ee policy BEFORE any private Blossom bytes.
      // Sync isMediaServerE2eeRequired() alone can be false on fresh clients → plaintext bypass.
      // Transport selection / fallback order UNCHANGED — only encryption of chosen Blossom path.
      console.log('[CHAT/P2P] 📤 מתחיל העלאה ל-Blossom...');
      let blossomUploadResult;
      try {
        let mustSecure = false;
        let allowLegacyPlaintext = false;
        let policyDecision = null;
        if (typeof App.resolveMediaServerE2eeDecision === 'function') {
          policyDecision = await App.resolveMediaServerE2eeDecision();
          const interpreted =
            typeof App.interpretPrivateChatBlossomPolicy === 'function'
              ? App.interpretPrivateChatBlossomPolicy(policyDecision)
              : null;
          if (interpreted) {
            mustSecure = interpreted.mode === 'SECURE';
            allowLegacyPlaintext = interpreted.mode === 'LEGACY';
          } else {
            mustSecure = !!(policyDecision.required === true || policyDecision.encrypt === true);
            const pol = policyDecision.policy || {};
            allowLegacyPlaintext =
              !mustSecure &&
              pol.fetchOk === true &&
              pol.remoteValue === false &&
              policyDecision.state === 'NOT_REQUIRED';
          }
          try {
            console.log('[CHAT/P2P] server-E2EE policy before Blossom', {
              required: mustSecure,
              state: policyDecision && policyDecision.state,
              fetchOk: policyDecision && policyDecision.policy && policyDecision.policy.fetchOk,
              remote:
                policyDecision && policyDecision.policy
                  ? policyDecision.policy.remoteValue === null
                    ? 'absent'
                    : policyDecision.policy.remoteValue
                  : null,
              allowLegacy: allowLegacyPlaintext,
              mode: interpreted && interpreted.mode,
            });
          } catch (_logErr) {}
        } else if (
          typeof App.isMediaServerE2eeRequired === 'function' &&
          App.isMediaServerE2eeRequired()
        ) {
          // Resolver missing but sticky/QA already REQUIRED — still encrypt.
          mustSecure = true;
        } else {
          // No authoritative resolver and not sticky-required → fail closed (no plaintext).
          mustSecure = false;
          allowLegacyPlaintext = false;
        }

        if (mustSecure) {
          if (typeof App.uploadMediaForServerFallback !== 'function') {
            const err = new Error('MEDIA_SERVER_E2EE_FALLBACK_UNAVAILABLE');
            err.code = 'MEDIA_SERVER_E2EE_FALLBACK_UNAVAILABLE';
            throw err;
          }
          const messageId =
            typeof App.ensureLogicalMessageIdForMedia === 'function'
              ? App.ensureLogicalMessageIdForMedia()
              : ('cmsg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
          blossomUploadResult = await App.uploadMediaForServerFallback(transfer.file, {
            messageId,
            sender: App.publicKey,
            recipient: transfer.peerPubkey,
            mimeType: mime,
            fileName,
          });
        } else if (allowLegacyPlaintext) {
          if (typeof App.uploadToBlossom !== 'function') {
            console.warn('[CHAT/P2P] ⚠️ App.uploadToBlossom לא זמין, מנסה WebTorrent');
            await fallbackToTorrent(transfer, onProgress);
            return;
          }
          blossomUploadResult = await App.uploadToBlossom(transfer.file);
        } else {
          const err = new Error('MEDIA_SERVER_E2EE_POLICY_BLOCKED');
          err.code = 'MEDIA_SERVER_E2EE_POLICY_BLOCKED';
          throw err;
        }
        console.log(
          '[CHAT/P2P] 📤 תוצאת העלאה:',
          blossomUploadResult && typeof blossomUploadResult === 'object'
            ? 'encrypted-media'
            : typeof App.diagSafeUrl === 'function'
              ? App.diagSafeUrl(blossomUploadResult)
              : '[url]',
        );
      } catch (uploadErr) {
        // Secure Blossom failure: never publish incomplete/malformed attachment.
        // No plaintext Blossom retry — clear temp state, then existing WebTorrent fallback once.
        const reason = uploadErr?.message || 'שגיאה לא ידועה';
        console.warn('[CHAT/P2P] ⚠️ Blossom נכשל, מנסה WebTorrent...', reason);
        quietTransferLog('blossom-failed → torrent', transfer.fileId, reason);
        if (typeof App.clearChatFileAttachment === 'function') {
          App.clearChatFileAttachment(transfer.peerPubkey);
        }
        await fallbackToTorrent(transfer, onProgress);
        return;
      }

      const isEncryptedDescriptor =
        blossomUploadResult &&
        typeof blossomUploadResult === 'object' &&
        blossomUploadResult.type === 'encrypted-media';
      const resultUrl = typeof blossomUploadResult === 'string' ? blossomUploadResult : null;

      if (isEncryptedDescriptor) {
        try {
          if (typeof App.validateEncryptedMediaDescriptor === 'function') {
            App.validateEncryptedMediaDescriptor(blossomUploadResult);
          }
          if (
            typeof App.isEncryptedBlossomDescriptor === 'function' &&
            !App.isEncryptedBlossomDescriptor(blossomUploadResult)
          ) {
            throw new Error('MEDIA_E2EE_BAD_DESCRIPTOR');
          }
          if (
            !blossomUploadResult.resource ||
            blossomUploadResult.resource.transport !== 'blossom' ||
            typeof blossomUploadResult.resource.url !== 'string' ||
            !blossomUploadResult.resource.url
          ) {
            throw new Error('MEDIA_E2EE_BAD_DESCRIPTOR');
          }
        } catch (descErr) {
          console.warn(
            '[CHAT/P2P] ⚠️ encrypted Blossom descriptor invalid after upload — no publish',
            descErr && descErr.message,
          );
          if (typeof App.clearChatFileAttachment === 'function') {
            App.clearChatFileAttachment(transfer.peerPubkey);
          }
          await fallbackToTorrent(transfer, onProgress);
          return;
        }
      }

      if (isEncryptedDescriptor || resultUrl) {
        console.log('[CHAT/P2P] ✅ Blossom upload הצליח', {
          encrypted: !!isEncryptedDescriptor,
          url: resultUrl
            ? typeof App.diagSafeUrl === 'function'
              ? App.diagSafeUrl(resultUrl)
              : '[url]'
            : undefined,
        });
        if (isEncryptedDescriptor && !/^(image|audio|video)\//i.test(String(mime || ''))) {
          console.log('DOCUMENT_BLOSSOM_UPLOAD_OK');
        }
        mediaDebugLog('blossom-upload-success', {
          fileId: transfer.fileId,
          name: fileName,
          size: fileSize,
          mime,
          encrypted: !!isEncryptedDescriptor,
          url: resultUrl || undefined,
        });

        let publishOk = false;
        try {
          if (typeof App.publishChatMessage === 'function') {
            const resolvedMime = resolveMimeType(mime, fileName);
            const isVideoFlag = shouldForceVideoFlag(mime, fileName);
            mediaDebugLog('blossom-attachment', {
              fileId: transfer.fileId,
              name: fileName,
              size: fileSize,
              mime: resolvedMime || mime,
              isVideo: isVideoFlag || false,
              encrypted: !!isEncryptedDescriptor,
              url: resultUrl || undefined,
            });
            let attachment;
            if (isEncryptedDescriptor) {
              attachment = blossomUploadResult;
              attachment.id = attachment.attachmentId || `blossom-${Date.now()}`;
              attachment.name =
                (attachment.media && attachment.media.filename) || fileName;
              attachment.size =
                (attachment.media && typeof attachment.media.originalSize === 'number'
                  ? attachment.media.originalSize
                  : fileSize);
              attachment.fileId = transfer.fileId;
              attachment.isVideo = isVideoFlag || undefined;
              attachment.hidePreview = true;
              attachment.caption =
                String(
                  transfer.caption ||
                    (typeof App.getChatFileAttachment === 'function' &&
                      App.getChatFileAttachment(transfer.peerPubkey)?.caption) ||
                    '',
                ).trim() || undefined;
            } else {
              attachment = {
                id: `blossom-${Date.now()}`,
                name: fileName,
                size: fileSize,
                type: resolvedMime || mime || 'application/octet-stream',
                url: resultUrl,
                dataUrl: '',
                fileId: transfer.fileId,
                isVideo: isVideoFlag || undefined,
                hidePreview: true,
                caption: String(transfer.caption || (typeof App.getChatFileAttachment === 'function' && App.getChatFileAttachment(transfer.peerPubkey)?.caption) || '').trim() || undefined,
              };
            }
            if (typeof App.setChatFileAttachment === 'function') {
              App.setChatFileAttachment(transfer.peerPubkey, attachment);
            }
            const captionText = String(attachment.caption || '').trim();
            const isVisualMedia = /^image\//i.test(resolvedMime || mime || '') || !!isVideoFlag;
            const messageText = captionText || (isVisualMedia ? '' : `📎 ${fileName}`);
            const publishResult = await App.publishChatMessage(transfer.peerPubkey, messageText);
            if (publishResult?.ok) {
              publishOk = true;
              console.log('[CHAT/P2P] 📨 הודעת צ\'אט עם attachment נשלחה', { peer: transfer.peerPubkey?.slice(0, 8), url: typeof App.diagSafeUrl === 'function' ? App.diagSafeUrl(resultUrl) : '[url]' });
              mediaDebugLog('blossom-message-sent', { fileId: transfer.fileId, peer: transfer.peerPubkey, messageId: publishResult.messageId || null });
            } else {
              console.warn('[CHAT/P2P] ⚠️ שליחת הודעה נכשלה:', publishResult?.error);
              mediaDebugLog('blossom-message-failed', { fileId: transfer.fileId, error: publishResult?.error || 'unknown' });
              if (typeof App.clearChatFileAttachment === 'function') {
                App.clearChatFileAttachment(transfer.peerPubkey);
              }
            }
          } else {
            console.warn('[CHAT/P2P] ⚠️ App.publishChatMessage לא זמין');
            if (typeof App.clearChatFileAttachment === 'function') {
              App.clearChatFileAttachment(transfer.peerPubkey);
            }
          }
        } catch (msgErr) {
          console.error('[CHAT/P2P] ❌ כשלון בשליחת הודעת צ\'אט:', msgErr);
          if (typeof App.clearChatFileAttachment === 'function') {
            App.clearChatFileAttachment(transfer.peerPubkey);
          }
        }

        // complete-blossom ONLY after ciphertext upload + valid descriptor + E3B publish success.
        if (publishOk) {
          const completePayload = {
            fileId: transfer.fileId,
            progress: 1,
            status: 'complete-blossom',
            direction: 'send',
            name: transfer.file?.name,
            size: transfer.file?.size,
            mimeType: transfer.file?.type,
            peerPubkey: transfer.peerPubkey,
            blossomUrl: resultUrl
          };
          if (onProgress) onProgress(completePayload);
          notifyProgress(completePayload);
          if (typeof App.clearChatFileAttachment === 'function') {
            App.clearChatFileAttachment(transfer.peerPubkey);
            console.log('[CHAT/P2P] 🧹 Attachment נוקה מה-state');
          }
          activeTransfers.delete(transfer.fileId);
          return;
        }

        // Upload appeared ok but publish failed — do not leave broken attachment; use existing torrent fallback.
        if (typeof App.clearChatFileAttachment === 'function') {
          App.clearChatFileAttachment(transfer.peerPubkey);
        }
        await fallbackToTorrent(transfer, onProgress);
        return;
      }

      // No usable Blossom result — clear and use existing higher-level torrent fallback once.
      if (typeof App.clearChatFileAttachment === 'function') {
        App.clearChatFileAttachment(transfer.peerPubkey);
      }
      await fallbackToTorrent(transfer, onProgress);
      
    } catch (err) {
      console.error('[CHAT/P2P] ❌ Blossom fallback failed:', err);
      if (typeof App.clearChatFileAttachment === 'function') {
        App.clearChatFileAttachment(transfer.peerPubkey);
      }
      notifyProgress({
        fileId: transfer.fileId,
        progress: 0,
        status: 'failed',
        direction: 'send',
        error: err.message
      });
      notifyTransferError(transfer.peerPubkey, `שליחת הקובץ נכשלה במסלול fallback (${err?.message || 'unknown'}).`, 'fallback-failed');
      activeTransfers.delete(transfer.fileId);
    }
  }

  // חלק fallback טורנט (chat-p2p-file.js) – העברת קבצים לא-נתמכים דרך WebTorrent P2P עם retry | HYPER CORE TECH
  const TORRENT_MAX_RETRIES = 3;        // מספר ניסיונות מקסימלי לשליחת קובץ טורנט
  const TORRENT_RETRY_DELAY_MS = 2000;  // השהייה בין ניסיונות (ms)

  async function fallbackToTorrent(transfer, onProgress) {
    const fileName = transfer.file?.name || 'קובץ';
    const fileSize = transfer.file?.size || 0;
    const mime = transfer.file?.type || 'application/octet-stream';

    // חלק בדיקת זמינות (chat-p2p-file.js) – וידוא שמערכת WebTorrent זמינה לפני ניסיון | HYPER CORE TECH
    // משתמשים ב-seedOnly (seedFile) כדי לעשות seed בלבד — ללא UI כפול וללא הודעת transfer request מיותרת
    if (!App.torrentTransfer || typeof App.torrentTransfer.seedOnly !== 'function') {
      console.error('[CHAT/P2P] ❌ WebTorrent לא זמין');
      notifyProgress({ fileId: transfer.fileId, progress: 0, status: 'failed', direction: 'send', error: 'WebTorrent not available', name: fileName, size: fileSize, peerPubkey: transfer.peerPubkey });
      activeTransfers.delete(transfer.fileId);
      return;
    }

    // חלק retry loop (chat-p2p-file.js) – לולאת ניסיונות חוזרים עם עדכוני progress לשולח | HYPER CORE TECH
    let lastError = '';
    for (let attempt = 1; attempt <= TORRENT_MAX_RETRIES; attempt++) {
      try {
        // עדכון progress — מציג ניסיון נוכחי
        const attemptLabel = TORRENT_MAX_RETRIES > 1 ? ` (ניסיון ${attempt}/${TORRENT_MAX_RETRIES})` : '';
        const seedingPayload = { fileId: transfer.fileId, progress: 0.05 * attempt, status: 'seeding-torrent', direction: 'send', name: fileName, size: fileSize, mimeType: mime, peerPubkey: transfer.peerPubkey, attempt, maxRetries: TORRENT_MAX_RETRIES };
        if (onProgress) onProgress(seedingPayload);
        notifyProgress(seedingPayload);

        console.log(`[CHAT/P2P] 🧲 Seeding${attemptLabel}...`, { attachmentType: mime, size: fileSize });
        const seedResult = await App.torrentTransfer.seedOnly(transfer.file, transfer.peerPubkey);

        if (!seedResult || !seedResult.success || !seedResult.magnetURI) {
          lastError = seedResult?.error || 'Torrent seed failed';
          console.warn(`[CHAT/P2P] ⚠️ Seed נכשל${attemptLabel}:`, lastError);
          mediaDebugLog('torrent-seed-failed', { fileId: transfer.fileId, attempt, error: lastError });
          if (attempt < TORRENT_MAX_RETRIES) {
            // עדכון progress — ממתין לניסיון חוזר
            notifyProgress({ fileId: transfer.fileId, progress: 0, status: 'retrying-torrent', direction: 'send', name: fileName, size: fileSize, peerPubkey: transfer.peerPubkey, attempt, maxRetries: TORRENT_MAX_RETRIES, error: lastError });
            await new Promise(r => setTimeout(r, TORRENT_RETRY_DELAY_MS));
            continue;
          }
          // כל הניסיונות נכשלו — שולחים הודעת כשלון לצד המקבל עם אפשרות retry
          console.error('[CHAT/P2P] ❌ כל הניסיונות נכשלו');
          notifyProgress({ fileId: transfer.fileId, progress: 0, status: 'failed', direction: 'send', name: fileName, size: fileSize, peerPubkey: transfer.peerPubkey, error: lastError });
          notifyTransferError(transfer.peerPubkey, `שליחת טורנט נכשלה: ${lastError || 'unknown'}`, 'torrent-failed');
          activeTransfers.delete(transfer.fileId);
          return;
        }

        // חלק הצלחת seeding (chat-p2p-file.js) – Seed הצליח, שולחים הודעת צ'אט עם magnetURI | HYPER CORE TECH
        console.log('[CHAT/P2P] ✅ Seed הצליח', typeof App.diagSafeMagnet === 'function' ? App.diagSafeMagnet(seedResult.magnetURI) : { magnetLength: String(seedResult.magnetURI || '').length });
        mediaDebugLog('torrent-seed-success', { fileId: transfer.fileId, infoHash: seedResult.infoHash || null, magnetPreview: seedResult.magnetURI.slice(0, 60) });

        transfer.torrentTransferId = seedResult.transferId;
        // חלק המתנה לעמית (chat-p2p-file.js) – אחרי seed מציגים המתנה לצד השני במקום כשלון מוקדם | HYPER CORE TECH
        const waitingPayload = {
          fileId: transfer.fileId,
          progress: 0.55,
          status: 'waiting-peer',
          direction: 'send',
          name: fileName,
          size: fileSize,
          mimeType: mime,
          peerPubkey: transfer.peerPubkey,
          torrentTransferId: seedResult.transferId,
          magnetURI: seedResult.magnetURI
        };
        if (onProgress) onProgress(waitingPayload);
        notifyProgress(waitingPayload);

        let messageSent = false;
        if (typeof App.setChatFileAttachment === 'function' && typeof App.publishChatMessage === 'function') {
          const captionText = String(transfer.caption || (typeof App.getChatFileAttachment === 'function' && App.getChatFileAttachment(transfer.peerPubkey)?.caption) || '').trim();
          const torrentAttachment = {
            id: transfer.fileId,
            name: fileName,
            size: fileSize,
            type: mime,
            magnetURI: seedResult.magnetURI,
            infoHash: seedResult.infoHash,
            isTorrent: true,
            hidePreview: true, // אין שורת preview תחתונה בזמן פרסום טורנט
            caption: captionText || undefined,
          };
          App.setChatFileAttachment(transfer.peerPubkey, torrentAttachment);
          const isVisualMedia = /^image\//i.test(mime || '') || shouldForceVideoFlag(mime, fileName);
          const displayText = captionText || (isVisualMedia ? '' : `📎 ${fileName}`);
          const result = await App.publishChatMessage(transfer.peerPubkey, displayText);
          if (result?.ok) {
            messageSent = true;
            console.log('[CHAT/P2P] 📨 הודעת טורנט נשלחה בהצלחה', { peer: transfer.peerPubkey?.slice(0, 8), attachmentType: mime, size: fileSize });
          } else {
            console.warn('[CHAT/P2P] ⚠️ שליחת הודעת טורנט נכשלה:', result?.error);
          }
        }

        // חלק אישור שליחה (chat-p2p-file.js) – עדכון סטטוס סופי לשולח: נשלח/ממתין | HYPER CORE TECH
        const finalStatus = messageSent ? 'complete-torrent' : 'waiting-peer';
        const completePayload = {
          fileId: transfer.fileId,
          progress: messageSent ? 1 : 0.7,
          status: finalStatus,
          direction: 'send',
          name: fileName,
          size: fileSize,
          mimeType: mime,
          peerPubkey: transfer.peerPubkey,
          magnetURI: seedResult.magnetURI,
          torrentTransferId: seedResult.transferId,
          messageSent
        };
        if (onProgress) onProgress(completePayload);
        notifyProgress(completePayload);

        // ניקוי attachment מה-state (הטורנט עצמו ממשיך לעשות seed ברקע!)
        if (typeof App.clearChatFileAttachment === 'function') {
          App.clearChatFileAttachment(transfer.peerPubkey);
        }
        activeTransfers.delete(transfer.fileId);
        return; // הצלחה — יציאה מהלולאה

      } catch (err) {
        lastError = err.message || 'Unknown error';
        console.warn(`[CHAT/P2P] ⚠️ ניסיון ${attempt} נכשל:`, lastError);
        if (attempt < TORRENT_MAX_RETRIES) {
          notifyProgress({ fileId: transfer.fileId, progress: 0, status: 'retrying-torrent', direction: 'send', name: fileName, size: fileSize, peerPubkey: transfer.peerPubkey, attempt, maxRetries: TORRENT_MAX_RETRIES, error: lastError });
          await new Promise(r => setTimeout(r, TORRENT_RETRY_DELAY_MS));
        }
      }
    }

    // חלק כשלון סופי (chat-p2p-file.js) – כל הניסיונות נכשלו | HYPER CORE TECH
    console.error('[CHAT/P2P] ❌ WebTorrent fallback נכשל אחרי', TORRENT_MAX_RETRIES, 'ניסיונות');
    notifyProgress({ fileId: transfer.fileId, progress: 0, status: 'failed', direction: 'send', name: fileName, size: fileSize, peerPubkey: transfer.peerPubkey, error: lastError });
    notifyTransferError(transfer.peerPubkey, `שליחת הקובץ נכשלה אחרי ${TORRENT_MAX_RETRIES} ניסיונות.`, 'torrent-retries-exhausted');
    activeTransfers.delete(transfer.fileId);
  }

  // חלק קבלת ערוץ קבצים (chat-p2p-file.js) – handler לערוץ file-transfer שנפתח ע"י הצד השני | HYPER CORE TECH
  function onFileDataChannel(peerPubkey, channel) {
    const key = toPeerKey(peerPubkey);
    console.log('[CHAT/P2P] ⚡ קיבלתי file-transfer DC מ-', key.slice(0, 8));
    channel.binaryType = 'arraybuffer';
    dataChannels.set(key, channel);
    attachCanonicalFileHandler(key, channel);
    channel.addEventListener('close', () => {
      console.log('[CHAT/P2P] file DC closed for', key.slice(0, 8));
      if (dataChannels.get(key) === channel) dataChannels.delete(key);
    });
  }

  // חלק API ציבורי (chat-p2p-file.js) – חשיפת פונקציות להעברת קבצים | HYPER CORE TECH
  // handleP2PFileMessage — נקודת כניסה אחידה מ-p2p-video-sharing.js לכל הודעות file-transfer (JSON + binary)
  function handleP2PFileMessage(peerPubkey, data, sourceChannel) {
    handleIncomingMessage(peerPubkey, data, sourceChannel);
  }

  // חלק דיאגנוסטיקה (chat-p2p-file.js) — בדיקת מצב חיבורים, DC, persistent, transfers | HYPER CORE TECH
  function diagnoseP2PFile(peerPubkey) {
    const peerKey = peerPubkey ? toPeerKey(peerPubkey) : null;
    console.group('🔍 [P2P-FILE DIAGNOSTICS]');
    // 1. persistent connection
    const peers = peerKey ? [peerKey] : [...dataChannels.keys()];
    if (peers.length === 0) {
      console.log('⚠️ אין peers ידועים ב-dataChannels map');
    }
    peers.forEach(pk => {
      const dc = dataChannels.get(pk);
      const conn = typeof App.getPersistentConnection === 'function' ? App.getPersistentConnection(pk) : null;
      const chatDC = App.dataChannel?.isConnected?.(pk);
      const chatPC = App.dataChannel?.getChatPC?.(pk);
      console.log(`📡 Peer ${pk.slice(0,8)}:`, {
        fileDataChannel: dc ? { readyState: dc.readyState, label: dc.label, binaryType: dc.binaryType, hasFileHandler: !!dc._p2pFileHandler } : 'NONE',
        persistentConnection: conn ? { channelState: conn.channel?.readyState, binaryType: conn.channel?.binaryType, busy: conn.busy } : 'NULL',
        chatDC: chatDC ? 'connected' : 'not connected',
        chatPC: chatPC ? { state: chatPC.connectionState, iceState: chatPC.iceConnectionState } : 'NONE'
      });
    });
    // 2. active transfers
    console.log(`📦 Active transfers: ${activeTransfers.size}`);
    for (const [fid, t] of activeTransfers) {
      console.log(`  ${t.direction} ${fid.slice(0,20)} type=${t.mimeType || t.file?.type || 'unknown'} size=${t.size || t.file?.size || 0} — chunk ${t.direction === 'send' ? (t.ackedChunks ? t.ackedChunks.size : t.currentChunk) : t.receivedChunks}/${t.totalChunks} inFlight=${t.inFlightChunks ? t.inFlightChunks.size : 0} preparing=${t.preparingChunks ? t.preparingChunks.size : 0} prepared=${t.preparedChunks ? t.preparedChunks.size : 0}, channel: ${t.channel?.readyState || 'null'}`);
    }
    // 3. recent completed
    console.log(`💾 Recent completed files (resend cache): ${recentCompletedFiles.size}`);
    console.groupEnd();
    return { dataChannels: dataChannels.size, activeTransfers: activeTransfers.size, recentCompleted: recentCompletedFiles.size };
  }

  // חלק ביטול העברה (chat-p2p-file.js) – ביטול שליחה/קבלה פעילה עם עדכון UI | HYPER CORE TECH
  function cancelP2PFile(fileId) {
    if (!fileId) return false;
    const transfer = activeTransfers.get(fileId);
    if (!transfer) return false;

    try {
      transfer.paused = true;
      transfer.sendGeneration = (transfer.sendGeneration || 0) + 1;
      clearAllPrep(transfer);
      if (transfer._ackTimeout) {
        clearTimeout(transfer._ackTimeout);
        transfer._ackTimeout = null;
      }
      if (transfer._resendTimer) {
        clearTimeout(transfer._resendTimer);
        transfer._resendTimer = null;
      }
      if (transfer._progressUiTimer) {
        clearTimeout(transfer._progressUiTimer);
        transfer._progressUiTimer = null;
      }
      const name = transfer.name || transfer.file?.name || 'קובץ';
      const size = transfer.size || transfer.file?.size || 0;
      const direction = transfer.direction || 'send';
      const peerPubkey = transfer.peerPubkey;
      const torrentId = transfer.torrentTransferId;
      activeTransfers.delete(fileId);

      if (torrentId && App.torrentTransfer && typeof App.torrentTransfer.cancelTransfer === 'function') {
        try { App.torrentTransfer.cancelTransfer(torrentId); } catch (_) {}
      }

      notifyProgress({
        fileId,
        progress: 0,
        status: 'cancelled',
        direction,
        name,
        size,
        peerPubkey,
        torrentTransferId: torrentId || undefined
      });
      console.log('[CHAT/P2P] 🛑 העברה בוטלה:', fileId);
      return true;
    } catch (err) {
      console.warn('[CHAT/P2P] cancel failed:', err);
      return false;
    }
  }

  Object.assign(App, {
    sendP2PFile: sendFile,
    cancelP2PFile,
    P2P_FILE_CHUNK_SIZE: CHUNK_SIZE,
    P2P_FILE_MAX_IN_FLIGHT: MAX_IN_FLIGHT,
    P2P_FILE_MAX_PREPARE_CONCURRENCY: MAX_PREPARE_CONCURRENCY,
    P2P_FILE_PREFETCH_TARGET: PREFETCH_TARGET,
    getOrCreateFileDataChannel: getOrCreateDataChannel,
    onFileDataChannel,
    activeP2PTransfers: activeTransfers,
    handleP2PFileOffer: handleP2PFileOffer,
    handleFileResendRequest: handleFileResendRequest,
    handleP2PFileMessage: handleP2PFileMessage,
    diagnoseP2PFile: diagnoseP2PFile,
    recentCompletedFiles: recentCompletedFiles,
    hasActiveChatFileTransfer,
    isReceivingChatFile,
    _p2pFileQa: {
      sendNextChunk,
      pumpSend,
      pumpPrepare,
      handleIncomingMessage,
      attachCanonicalFileHandler,
      completeSendOnce,
      MAX_IN_FLIGHT,
      MAX_PREPARE_CONCURRENCY,
      PREFETCH_TARGET,
    },
    subscribeP2PFileProgress: (cb) => {
      if (typeof cb === 'function') {
        progressListeners.add(cb);
        return () => progressListeners.delete(cb);
      }
      return () => {};
    }
  });
})(window);
