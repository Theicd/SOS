(function initP2PVideoSharing(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק P2P (p2p-video-sharing.js) – סינון ריליים בעייתיים כדי למנוע דרישות POW עודפות | HYPER CORE TECH
  function filterBlockedRelays(relays) {
    if (!Array.isArray(relays)) {
      return [];
    }
    const filtered = relays.filter((relayUrl) => relayUrl && !BLOCKED_RELAY_URLS.has(relayUrl));
    return filtered.length > 0 ? filtered : relays;
  }

  function getP2PRelays() {
    if (Array.isArray(App.p2pRelayUrls) && App.p2pRelayUrls.length) {
      return filterBlockedRelays(App.p2pRelayUrls);
    }
    if (Array.isArray(App.relayUrls) && App.relayUrls.length) {
      return filterBlockedRelays(App.relayUrls);
    }
    return [];
  }

  // חלק P2P (p2p-video-sharing.js) – הגדרות
  // משתמשים ב-Kind 30078 (NIP-78: Application-specific data) כי רוב הריליים תומכים בו
  // ה-d tag מזהה את סוג ההודעה: p2p-file, p2p-req, p2p-res
  const FILE_AVAILABILITY_KIND = 30078; // kind לפרסום זמינות קבצים (NIP-78)
  const FILE_REQUEST_KIND = 30078; // kind לבקשת קובץ (NIP-78)
  const FILE_RESPONSE_KIND = 30078; // kind לתשובה על בקשה (NIP-78)
  const P2P_APP_TAG = 'sos-p2p'; // תג לזיהוי האפליקציה
  const AVAILABILITY_EXPIRY = 24 * 60 * 60 * 1000; // 24 שעות - כדי שהקובץ יהיה זמין לאורך זמן
  const AVAILABILITY_REPUBLISH_INTERVAL = 2 * 60 * 1000; // דקהיים קירור
  const AVAILABILITY_MANIFEST_KEY = 'p2pAvailabilityManifest';
  const AVAILABILITY_MANIFEST_TTL = 6 * 60 * 60 * 1000; // לא לפרסם מחדש את אותו hash במשך 6 שעות כברירת מחדל
  const AVAILABILITY_RATE_WINDOW_MS = 5000;
  const MAX_AVAILABILITY_EVENTS_PER_WINDOW = 5;
  const SIGNAL_RATE_WINDOW_MS = 1000;
  const MAX_SIGNALS_PER_WINDOW = 3;
  const PEER_DISCOVERY_TIMEOUT = window.NostrP2P_PEER_DISCOVERY_TIMEOUT || 10000; // 10 שניות לחיפוש peers
  const PEER_DISCOVERY_LOOKBACK = 24 * 60 * 60; // 24 שעות אחורה - כדי למצוא peers גם אם פרסמו מוקדם יותר
  const CHUNK_SIZE = 16384; // 16KB chunks
  const BLOCKED_RELAY_URLS = new Set((window.NostrP2P_BLOCKED_RELAYS || ['wss://nos.lol']));
  const MAX_CONCURRENT_P2P_TRANSFERS =
    typeof window.NostrP2P_MAX_CONCURRENT_TRANSFERS === 'number'
      ? window.NostrP2P_MAX_CONCURRENT_TRANSFERS
      : 3;
  const MAX_PEER_ATTEMPTS_PER_FILE =
    typeof window.NostrP2P_MAX_PEER_ATTEMPTS === 'number'
      ? window.NostrP2P_MAX_PEER_ATTEMPTS
      : 3;
  const MAX_DOWNLOAD_TIMEOUT = window.NostrP2P_DOWNLOAD_TIMEOUT || 45000; // 45 שניות ברירת מחדל כדי לא לחסום את חוויית המשתמש | HYPER CORE TECH
  const ANSWER_TIMEOUT = window.NostrP2P_ANSWER_TIMEOUT || 8000; // 8 שניות לתשובה כדי לעבור לפולבאק מהר יותר | HYPER CORE TECH
  const ANSWER_RETRY_LIMIT = window.NostrP2P_ANSWER_RETRY_LIMIT || 2; // 2 ניסיונות לכל peer
  const ANSWER_RETRY_DELAY = window.NostrP2P_ANSWER_RETRY_DELAY || 2000; // 2 שניות בין ניסיונות
  const DEFAULT_PIECE_SIZE = window.NostrP2P_PIECE_SIZE || 256 * 1024; // 256KB עבור חלוקת חלקים | HYPER CORE TECH
  const MAX_PARALLEL_PEER_CHANNELS = window.NostrP2P_MAX_PARALLEL_PEERS || 4; // עד 4 חיבורים בו-זמנית | HYPER CORE TECH
  const MAX_PIECE_RETRIES = window.NostrP2P_MAX_PIECE_RETRIES || 3; // כמה פעמים מבקשים piece לפני מעבר ל-peer אחר | HYPER CORE TECH

  // חלק P2P (p2p-video-sharing.js) – WebRTC config
  const RTC_CONFIG = Array.isArray(window.NostrRTC_ICE) && window.NostrRTC_ICE.length
    ? { iceServers: window.NostrRTC_ICE }
    : {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:stun3.l.google.com:19302' },
          // TURN servers חינמיים לשיפור חיבוריות (במיוחד למובייל)
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          },
          {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          }
        ],
        iceCandidatePoolSize: 10
      };

  // חלק P2P (p2p-video-sharing.js) – מצב המערכת
  const state = {
    availableFiles: new Map(), // hash -> { blob, mimeType, size, timestamp }
    lastAvailabilityPublish: new Map(), // hash -> timestamp
    activePeers: new Map(), // hash -> Set(pubkeys)
    activeConnections: new Map(), // connectionId -> RTCPeerConnection
    pendingConnections: new Map(), // connectionId -> { pc, timeout }
    downloadQueue: new Map(), // hash -> Promise
    availabilityManifest: loadAvailabilityManifest(),
    availabilityRateTimestamps: [],
    signalTimestamps: [],
    activeTransferSlots: 0,
    pendingTransferResolvers: [],
    pieceManifests: new Map(), // hash -> { pieceSize, pieceHashes, pieceCount, totalSize, mimeType }
    peerCatalog: new Map(), // pubkey -> { lastSeen, files: Set(hash) }
  };

  const logState = {
    throttle: new Map(),
    downloadProgress: new Map(),
  };

  // חלק טורנט (p2p-video-sharing.js) – חישוב והשכרת מניפסט חלקים ושימור קטלוג peers | HYPER CORE TECH
  const HEX_TABLE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

  function bufferToHex(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let hex = '';
    for (let i = 0; i < bytes.length; i += 1) {
      hex += HEX_TABLE[bytes[i]];
    }
    return hex;
  }

  async function digestArrayBuffer(buffer) {
    if (!window.crypto?.subtle?.digest) {
      return null;
    }
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', buffer);
    return bufferToHex(hashBuffer);
  }

  async function ensurePieceManifest(hash, blob, mimeType, pieceSize = DEFAULT_PIECE_SIZE) {
    if (state.pieceManifests.has(hash)) {
      return state.pieceManifests.get(hash);
    }

    if (!blob) {
      return null;
    }

    const safePieceSize = Math.max(CHUNK_SIZE, pieceSize || DEFAULT_PIECE_SIZE);
    const pieceHashes = [];
    for (let offset = 0; offset < blob.size; offset += safePieceSize) {
      const slice = blob.slice(offset, Math.min(offset + safePieceSize, blob.size));
      const buffer = await slice.arrayBuffer();
      const digestHex = await digestArrayBuffer(buffer);
      pieceHashes.push(digestHex || `chunk-${pieceHashes.length}`);
    }

    const manifest = {
      pieceSize: safePieceSize,
      pieceHashes,
      pieceCount: pieceHashes.length,
      totalSize: blob.size,
      mimeType,
    };

    state.pieceManifests.set(hash, manifest);
    return manifest;
  }

  function rememberPeerCatalog(pubkey, files = []) {
    if (!pubkey) return;
    const normalized = pubkey.slice(0, 64);
    const entry = state.peerCatalog.get(normalized) || { lastSeen: 0, files: new Set() };
    entry.lastSeen = Date.now();
    files.forEach((fileHash) => {
      if (typeof fileHash === 'string' && fileHash.length >= 16) {
        entry.files.add(fileHash);
      }
    });
    state.peerCatalog.set(normalized, entry);
  }

  function getPeerCatalogSample(limit = 24) {
    const hashes = Array.from(state.availableFiles.keys());
    return hashes.slice(0, limit);
  }

  function calculatePieceSize(totalSize, defaultSize = DEFAULT_PIECE_SIZE) {
    if (!totalSize || totalSize <= 0) {
      return defaultSize;
    }
    if (totalSize < defaultSize) {
      return Math.max(CHUNK_SIZE, Math.floor(totalSize / 2) || defaultSize);
    }
    return defaultSize;
  }

  function concatArrayBuffers(buffers, totalSize) {
    if (!buffers || buffers.length === 0) {
      return new ArrayBuffer(0);
    }
    const size = typeof totalSize === 'number' && totalSize > 0
      ? totalSize
      : buffers.reduce((sum, chunk) => sum + (chunk.byteLength || chunk.size || 0), 0);
    const tmp = new Uint8Array(size);
    let offset = 0;
    for (const chunk of buffers) {
      const array = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      tmp.set(array, offset);
      offset += array.length;
    }
    return tmp.buffer;
  }

  function createPieceScheduler(hash, mimeType) {
    const scheduler = {
      hash,
      mimeType,
      manifest: null,
      pieceStatus: [],
      pendingPieces: new Set(),
      inflightPieces: new Map(), // connectionId -> pieceIndex
      pieceBuffers: new Map(), // connectionId -> { index, buffers, expectedSize, received }
      connections: new Map(),
      resolve: null,
      reject: null,
      resolved: false,
      resultBuffers: [],
      successPeers: new Set(),
      metadataWaiters: [],
      closed: false,
      pieceRetries: new Map(),
    };

    scheduler.promise = new Promise((resolve, reject) => {
      scheduler.resolve = resolve;
      scheduler.reject = reject;
    });

    scheduler.ensureManifest = (manifest) => {
      if (!manifest || scheduler.manifest) {
        return scheduler.manifest;
      }
      scheduler.manifest = {
        pieceSize: manifest.pieceSize || calculatePieceSize(manifest.totalSize || 0),
        pieceHashes: manifest.pieceHashes || [],
        pieceCount: manifest.pieceCount || (manifest.totalSize ? Math.ceil(manifest.totalSize / (manifest.pieceSize || DEFAULT_PIECE_SIZE)) : 0),
        totalSize: manifest.totalSize || 0,
        mimeType: manifest.mimeType || mimeType,
      };
      const count = scheduler.manifest.pieceCount;
      scheduler.resultBuffers = new Array(count);
      scheduler.pieceStatus = new Array(count).fill('pending');
      scheduler.pendingPieces = new Set(Array.from({ length: count }, (_, i) => i));
      scheduler.metadataWaiters.forEach((ctx) => scheduler.assignNextPiece(ctx));
      scheduler.metadataWaiters = [];
      return scheduler.manifest;
    };

    scheduler.completedBytes = () => {
      if (!scheduler.manifest) {
        return 0;
      }
      return scheduler.resultBuffers.reduce((sum, buf, index) => {
        if (!buf) return sum;
        return sum + scheduler.getPieceSize(index);
      }, 0);
    };

    scheduler.assignNextPiece = (ctx) => {
      if (!scheduler.manifest) {
        scheduler.metadataWaiters.push(ctx);
        return false;
      }
      for (const index of scheduler.pendingPieces) {
        scheduler.pendingPieces.delete(index);
        scheduler.inflightPieces.set(ctx.connectionId, index);
        if (!scheduler.pieceRetries.has(index)) {
          scheduler.pieceRetries.set(index, 0);
        }
        scheduler.pieceBuffers.set(ctx.connectionId, {
          index,
          buffers: [],
          expectedSize: scheduler.getPieceSize(index),
          received: 0,
        });
        ctx.channel.send(JSON.stringify({ type: 'piece-request', index, hash: scheduler.hash }));
        log('download', '📥 ביקשתי חלק מ-peer', {
          connectionId: ctx.connectionId,
          peer: ctx.peerPubkey.slice(0, 16) + '...',
          pieceIndex: index,
        });
        return true;
      }
      return false;
    };

    scheduler.getPieceSize = (index) => {
      if (!scheduler.manifest) return DEFAULT_PIECE_SIZE;
      const start = index * scheduler.manifest.pieceSize;
      return Math.min(scheduler.manifest.totalSize - start, scheduler.manifest.pieceSize);
    };

    scheduler.handleMetadata = (payload, ctx) => {
      scheduler.ensureManifest(payload);
      scheduler.assignNextPiece(ctx);
    };

    scheduler.handlePeerCatalog = (payload, ctx) => {
      const files = Array.isArray(payload?.files) ? payload.files : [];
      rememberPeerCatalog(ctx.peerPubkey, files);
    };

    scheduler.handlePieceBegin = (payload, ctx) => {
      const buffersState = scheduler.pieceBuffers.get(ctx.connectionId);
      if (buffersState && buffersState.index === payload.index) {
        buffersState.expectedSize = payload.size || scheduler.getPieceSize(payload.index);
        buffersState.buffers = [];
        buffersState.received = 0;
      }
    };

    scheduler.handleBinary = (data, ctx) => {
      const buffersState = scheduler.pieceBuffers.get(ctx.connectionId);
      if (!buffersState) {
        return;
      }
      buffersState.buffers.push(data);
      buffersState.received += data.byteLength || data.size || 0;
      if (scheduler.manifest) {
        const totalBytes = scheduler.completedBytes() + buffersState.received;
        updateDownloadProgress(ctx.connectionId, totalBytes, scheduler.manifest.totalSize, {
          piece: buffersState.index,
          received: `${buffersState.received} / ${buffersState.expectedSize}`,
        });
      }
    };

    scheduler.handlePieceComplete = (payload, ctx) => {
      const buffersState = scheduler.pieceBuffers.get(ctx.connectionId);
      if (!buffersState || buffersState.index !== payload.index) {
        return;
      }
      const arrayBuffer = concatArrayBuffers(buffersState.buffers, buffersState.received);
      scheduler.resultBuffers[buffersState.index] = arrayBuffer;
      scheduler.pieceStatus[buffersState.index] = 'done';
      scheduler.pieceBuffers.delete(ctx.connectionId);
      scheduler.inflightPieces.delete(ctx.connectionId);
      scheduler.successPeers.add(ctx.peerPubkey);
      ctx.currentPiece = null;
      if (scheduler.manifest) {
        updateDownloadProgress(ctx.connectionId, scheduler.completedBytes(), scheduler.manifest.totalSize, {
          piece: buffersState.index,
          chunks: buffersState.buffers.length,
        });
      }
      if (!scheduler.assignNextPiece(ctx)) {
        if (scheduler.isComplete()) {
          ctx.resolve();
        }
      }
      scheduler.tryFinalize();
    };

    scheduler.handleError = (ctx, message) => {
      log('error', `❌ שגיאה מה-peer: ${message}`, {
        peer: ctx.peerPubkey.slice(0, 16) + '...'
      });
      const inflightIndex = scheduler.inflightPieces.get(ctx.connectionId);
      if (typeof inflightIndex === 'number') {
        const nextRetry = (scheduler.pieceRetries.get(inflightIndex) || 0) + 1;
        scheduler.pieceRetries.set(inflightIndex, nextRetry);
        if (MAX_PIECE_RETRIES > 0 && nextRetry >= MAX_PIECE_RETRIES) {
          scheduler.fail(new Error(`חריגה ממספר ניסיונות לחלק ${inflightIndex}`));
          return;
        }
        scheduler.pendingPieces.add(inflightIndex);
        scheduler.inflightPieces.delete(ctx.connectionId);
      }
      scheduler.pieceBuffers.delete(ctx.connectionId);
      scheduler.assignNextPiece(ctx);
    };

    scheduler.handlePeerClose = (ctx) => {
      const inflightIndex = scheduler.inflightPieces.get(ctx.connectionId);
      if (typeof inflightIndex === 'number') {
        const nextRetry = (scheduler.pieceRetries.get(inflightIndex) || 0) + 1;
        scheduler.pieceRetries.set(inflightIndex, nextRetry);
        if (MAX_PIECE_RETRIES > 0 && nextRetry >= MAX_PIECE_RETRIES) {
          scheduler.fail(new Error(`חריגה ממספר ניסיונות לחלק ${inflightIndex}`));
          return;
        }
        scheduler.pendingPieces.add(inflightIndex);
        scheduler.inflightPieces.delete(ctx.connectionId);
      }
      scheduler.pieceBuffers.delete(ctx.connectionId);
      scheduler.connections.delete(ctx.connectionId);
      if (!scheduler.resolved && scheduler.connections.size === 0) {
        scheduler.tryFinalize();
      }
    };

    scheduler.closeAllConnections = () => {
      if (scheduler.closed) {
        return;
      }
      scheduler.closed = true;
      scheduler.connections.forEach((ctx) => {
        try {
          ctx.channel?.close();
        } catch (err) {
          console.warn('channel close', err);
        }
        try {
          ctx.resolve();
        } catch (err) {
          console.warn('ctx resolve err', err);
        }
      });
      scheduler.connections.clear();
    };

    scheduler.tryFinalize = () => {
      if (scheduler.resolved) {
        return;
      }
      if (!scheduler.manifest) {
        return;
      }
      if (scheduler.resultBuffers.every(Boolean)) {
        scheduler.resolved = true;
        const blob = new Blob(scheduler.resultBuffers.map((buf) => new Uint8Array(buf)), {
          type: scheduler.manifest.mimeType || mimeType,
        });
        scheduler.resolve({
          blob,
          mimeType: scheduler.manifest.mimeType || mimeType,
          peers: Array.from(scheduler.successPeers),
          pieceCount: scheduler.manifest.pieceCount,
        });
        scheduler.closeAllConnections();
      } else if (scheduler.connections.size === 0 && scheduler.pendingPieces.size === 0) {
        scheduler.resolved = true;
        scheduler.reject(new Error('לא הושלמו כל החלקים'));
        scheduler.closeAllConnections();
      }
    };

    scheduler.isComplete = () => scheduler.manifest && scheduler.resultBuffers.length && scheduler.resultBuffers.every(Boolean);

    scheduler.fail = (err) => {
      if (!scheduler.resolved) {
        scheduler.resolved = true;
        scheduler.reject(err instanceof Error ? err : new Error(String(err)));
        scheduler.closeAllConnections();
      }
    };

    scheduler.registerConnection = (ctx) => {
      scheduler.connections.set(ctx.connectionId, ctx);
      ctx.currentPiece = null;
    };

    scheduler.requestMetadata = (ctx) => {
      const files = getPeerCatalogSample(24);
      ctx.channel.send(JSON.stringify({
        type: 'metadata-request',
        hash: scheduler.hash,
        knownFiles: files,
      }));
      ctx.channel.send(JSON.stringify({
        type: 'peer-map',
        files,
      }));
    };

    scheduler.handleMessage = (messageStr, ctx) => {
      let msg;
      try {
        msg = JSON.parse(messageStr);
      } catch (err) {
        log('error', `❌ הודעת JSON לא תקינה: ${err.message}`);
        return;
      }
      switch (msg.type) {
        case 'metadata':
          scheduler.handleMetadata(msg, ctx);
          break;
        case 'peer-map':
          scheduler.handlePeerCatalog(msg, ctx);
          break;
        case 'piece-begin':
          scheduler.handlePieceBegin(msg, ctx);
          break;
        case 'piece-complete':
          scheduler.handlePieceComplete(msg, ctx);
          break;
        case 'error':
          scheduler.handleError(ctx, msg.message);
          break;
        default:
          log('info', `ℹ️ התקבלה הודעה לא מזוהה (${msg.type || 'unknown'})`);
      }
    };

    return scheduler;
  }

  // חלק טורנט (p2p-video-sharing.js) – יצירת חיבור WebRTC גנרי עבור כל שימוש | HYPER CORE TECH
  async function connectToPeer(peerPubkey, hash, options = {}) {
    const retryLimit = options.retryLimit || ANSWER_RETRY_LIMIT;
    let lastError = null;
    for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
      try {
        return await createPeerConnectionOnce(peerPubkey, hash, attempt, options);
      } catch (err) {
        lastError = err;
        const isAnswerTimeout = err && err.message === 'Answer timeout';
        if (isAnswerTimeout && attempt < retryLimit) {
          log('info', `🔁 Answer timeout – מנסה שוב (${attempt + 1}/${retryLimit})`, {
            peer: peerPubkey.slice(0, 16) + '...',
            hash: hash.slice(0, 16) + '...',
            purpose: options.purpose || 'generic'
          });
          await sleep(ANSWER_RETRY_DELAY);
          continue;
        }
        break;
      }
    }
    throw lastError || new Error('Peer connection failed');
  }

  function createPeerConnectionOnce(peerPubkey, hash, attemptNumber, options = {}) {
    const label = options.label || 'file-transfer';
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : MAX_DOWNLOAD_TIMEOUT;
    const purpose = options.purpose || 'generic';

    return new Promise(async (resolve, reject) => {
      const connectionId = `${peerPubkey}-${hash}-${Date.now()}-${purpose}-a${attemptNumber}`;
      log('peer', `🔗 יצירת RTCPeerConnection (${purpose})`, {
        connectionId,
        peer: peerPubkey.slice(0, 16) + '...'
      });

      const timeout = setTimeout(() => {
        log('error', `⏱️ timeout (${purpose}) בהורדה מ-peer`, {
          peer: peerPubkey.slice(0, 16) + '...'
        });
        handlerContext.reject(new Error('Download timeout'));
      }, timeoutMs);

      let pc = null;
      let channel = null;

      function cleanup() {
        clearTimeout(timeout);
        if (channel) {
          try {
            channel.onmessage = null;
            channel.onopen = null;
            channel.onerror = null;
            channel.onclose = null;
            channel.close();
          } catch (closeErr) {
            console.warn('channel close err', closeErr);
          }
        }
        if (pc) {
          try {
            pc.onicecandidate = null;
            pc.oniceconnectionstatechange = null;
            pc.close();
          } catch (closeErr) {
            console.warn('pc close err', closeErr);
          }
          state.activeConnections.delete(connectionId);
        }
        const pending = state.pendingConnections.get(connectionId);
        if (pending) {
          clearTimeout(pending.timeout);
          state.pendingConnections.delete(connectionId);
        }
      }

      try {
        pc = new RTCPeerConnection(RTC_CONFIG);
        state.activeConnections.set(connectionId, pc);

        channel = pc.createDataChannel(label, {
          ordered: true,
        });
        channel.binaryType = 'arraybuffer';

        const handlerContext = {
          connectionId,
          peerPubkey,
          hash,
          channel,
          purpose,
          settled: false,
          cleanup: () => cleanup(),
        };

        handlerContext.resolve = (value) => {
          if (handlerContext.settled) {
            return;
          }
          handlerContext.settled = true;
          cleanup();
          resolve(value);
        };

        handlerContext.reject = (err) => {
          if (handlerContext.settled) {
            return;
          }
          handlerContext.settled = true;
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        };

        channel.onopen = () => {
          log('success', `✅ data channel נפתח (${purpose})`, { connectionId });
          if (typeof options.onChannelOpen === 'function') {
            try {
              options.onChannelOpen(channel, handlerContext);
            } catch (err) {
              handlerContext.reject(err);
            }
          }
        };

        channel.onmessage = (event) => {
          try {
            if (typeof event.data === 'string') {
              if (typeof options.onMessage === 'function') {
                options.onMessage(event.data, handlerContext);
              }
            } else if (options.onBinary) {
              options.onBinary(event.data, handlerContext);
            }
          } catch (err) {
            handlerContext.reject(err);
          }
        };

        channel.onerror = (err) => {
          log('error', `❌ שגיאה ב-data channel (${purpose}): ${err}`);
          handlerContext.reject(err);
        };

        channel.onclose = () => {
          log('info', `🔌 data channel נסגר (${purpose})`, { connectionId });
          if (typeof options.onChannelClose === 'function') {
            try {
              options.onChannelClose(handlerContext);
            } catch (err) {
              console.warn('channel close handler err', err);
            }
          }
          handlerContext.resolve();
        };

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            log('peer', `🧊 ICE candidate חדש (${purpose})`, {
              type: event.candidate.type,
              protocol: event.candidate.protocol
            });
            sendSignal(peerPubkey, 'ice-candidate', {
              candidate: event.candidate,
              hash,
              connectionId
            }).catch((err) => {
              log('error', `❌ כשלון בשליחת ICE candidate: ${err.message}`);
            });
          }
        };

        pc.oniceconnectionstatechange = () => {
          log('peer', `🔄 ICE connection state (${purpose}): ${pc.iceConnectionState}`, { connectionId });
          if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            handlerContext.reject(new Error('Connection failed'));
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        log('peer', `📤 שולח offer ל-peer (${purpose})`, { peer: peerPubkey.slice(0, 16) + '...' });

        await sendSignal(peerPubkey, 'file-request', {
          offer,
          hash,
          connectionId,
          purpose,
        });

        log('request', `✅ offer נשלח בהצלחה (${purpose})`, { connectionId });

        const answerTimeout = setTimeout(() => {
          log('error', '❌ לא התקבל answer בזמן', { connectionId }, {
            throttleKey: `answer-timeout-${hash}-${purpose}`,
            throttleMs: 5000,
          });
          state.pendingConnections.delete(connectionId);
          handlerContext.reject(new Error('Answer timeout'));
        }, ANSWER_TIMEOUT);

        state.pendingConnections.set(connectionId, { pc, timeout: answerTimeout });

      } catch (err) {
        handlerContext.reject(err);
      }
    });
  }

  function runExclusiveDownload(key, factory) {
    if (!key) {
      return factory();
    }
    if (state.downloadQueue.has(key)) {
      log('info', '♻️ מצטרף להורדה קיימת', { key }, {
        throttleKey: `join-${key}`,
        throttleMs: 5000,
      });
      return state.downloadQueue.get(key);
    }
    const wrapped = (async () => {
      try {
        return await factory();
      } finally {
        state.downloadQueue.delete(key);
      }
    })();
    state.downloadQueue.set(key, wrapped);
    return wrapped;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // חלק איזון עומסים (p2p-video-sharing.js) – הקצאת משבצות הורדה כדי למנוע עומס מיידי על הרשת | HYPER CORE TECH
  async function acquireDownloadSlot(label) {
    if (MAX_CONCURRENT_P2P_TRANSFERS <= 0) {
      return null;
    }
    return new Promise((resolve) => {
      const tryStart = () => {
        if (state.activeTransferSlots < MAX_CONCURRENT_P2P_TRANSFERS) {
          state.activeTransferSlots += 1;
          log('info', '🎯 הוקצתה משבצת הורדת P2P', {
            label: label?.slice?.(0, 16) || 'unknown',
            activeTransfers: state.activeTransferSlots,
          });
          resolve(() => releaseDownloadSlot(label));
          return true;
        }
        return false;
      };

      if (!tryStart()) {
        log('info', '⌛ עומס הורדות – נכנס לתור', {
          label: label?.slice?.(0, 16) || 'unknown',
          queueLength: state.pendingTransferResolvers.length + 1,
        });
        state.pendingTransferResolvers.push(() => {
          tryStart();
        });
      }
    });
  }

  function releaseDownloadSlot(label) {
    if (MAX_CONCURRENT_P2P_TRANSFERS <= 0) {
      return;
    }
    if (state.activeTransferSlots > 0) {
      state.activeTransferSlots -= 1;
    }
    log('info', '⬅️ משבצת הורדה שוחררה', {
      label: label?.slice?.(0, 16) || 'unknown',
      activeTransfers: state.activeTransferSlots,
    });
    const nextResolver = state.pendingTransferResolvers.shift();
    if (typeof nextResolver === 'function') {
      nextResolver();
    }
  }

  async function throttleSignals() {
    while (true) {
      const now = Date.now();
      state.signalTimestamps = state.signalTimestamps.filter((ts) => now - ts < SIGNAL_RATE_WINDOW_MS);
      if (state.signalTimestamps.length < MAX_SIGNALS_PER_WINDOW) {
        state.signalTimestamps.push(now);
        return;
      }
      const waitMs = Math.max(50, SIGNAL_RATE_WINDOW_MS - (now - state.signalTimestamps[0]));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  function loadAvailabilityManifest() {
    try {
      const raw = window.localStorage?.getItem(AVAILABILITY_MANIFEST_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      const now = Date.now();
      const filtered = {};
      Object.keys(parsed).forEach((hash) => {
        const entry = parsed[hash];
        if (entry && typeof entry.lastPublished === 'number' && now - entry.lastPublished < AVAILABILITY_MANIFEST_TTL * 4) {
          filtered[hash] = entry;
        }
      });
      return filtered;
    } catch (err) {
      console.warn('P2P manifest load failed', err);
      return {};
    }
  }

  function saveAvailabilityManifest() {
    try {
      const manifest = state.availabilityManifest || {};
      const entries = Object.entries(manifest)
        .sort((a, b) => (b[1]?.lastPublished || 0) - (a[1]?.lastPublished || 0))
        .slice(0, 400); // הגבלת גודל למניעת התנפחות
      const compacted = Object.fromEntries(entries);
      state.availabilityManifest = compacted;
      window.localStorage?.setItem(AVAILABILITY_MANIFEST_KEY, JSON.stringify(compacted));
    } catch (err) {
      console.warn('P2P manifest save failed', err);
    }
  }

  // חלק P2P (p2p-video-sharing.js) – לוגים צבעוניים
  function log(type, message, data = null, options = {}) {
    const timestamp = new Date().toLocaleTimeString('he-IL');
    const styles = {
      upload: 'background: #4CAF50; color: white; padding: 2px 6px; border-radius: 3px;',
      download: 'background: #2196F3; color: white; padding: 2px 6px; border-radius: 3px;',
      request: 'background: #FF9800; color: white; padding: 2px 6px; border-radius: 3px;',
      peer: 'background: #9C27B0; color: white; padding: 2px 6px; border-radius: 3px;',
      success: 'background: #8BC34A; color: white; padding: 2px 6px; border-radius: 3px;',
      error: 'background: #F44336; color: white; padding: 2px 6px; border-radius: 3px;',
      info: 'background: #607D8B; color: white; padding: 2px 6px; border-radius: 3px;',
    };

    const { throttleKey, throttleMs = 3000 } = options;
    if (throttleKey) {
      const entry = logState.throttle.get(throttleKey) || {
        lastLoggedAt: 0,
        suppressed: 0,
      };
      const now = Date.now();
      if (entry.lastLoggedAt && now - entry.lastLoggedAt < throttleMs) {
        entry.suppressed += 1;
        logState.throttle.set(throttleKey, entry);
        return;
      }
      if (entry.suppressed > 0) {
        data = Object.assign({}, data, { suppressed: entry.suppressed });
        entry.suppressed = 0;
      }
      entry.lastLoggedAt = now;
      logState.throttle.set(throttleKey, entry);
    }

    console.log(
      `%c[P2P ${type.toUpperCase()}]%c ${timestamp} - ${message}`,
      styles[type] || styles.info,
      'color: inherit;'
    );

    if (data) {
      console.log('   📊 Data:', data);
    }
  }

  function updateDownloadProgress(connectionId, receivedSize, totalSize, extra = {}) {
    if (!connectionId || typeof totalSize !== 'number' || totalSize <= 0) {
      return;
    }
    const percent = Math.min(100, Math.floor((receivedSize / totalSize) * 100));
    const prev = logState.downloadProgress.get(connectionId);
    if (prev && percent <= prev.percent) {
      return;
    }
    logState.downloadProgress.set(connectionId, { percent, receivedSize, totalSize });
    log('download', '📦 התקדמות הורדה', {
      connectionId,
      progress: `${percent}%`,
      received: `${receivedSize} / ${totalSize}`,
      ...extra,
    });

    if (percent >= 100) {
      logState.downloadProgress.delete(connectionId);
    }
  }

  async function ensureAvailabilityRateCapacity() {
    while (true) {
      const now = Date.now();
      state.availabilityRateTimestamps = state.availabilityRateTimestamps.filter((ts) => now - ts < AVAILABILITY_RATE_WINDOW_MS);
      if (state.availabilityRateTimestamps.length < MAX_AVAILABILITY_EVENTS_PER_WINDOW) {
        state.availabilityRateTimestamps.push(now);
        return;
      }
      const waitMs = Math.max(100, AVAILABILITY_RATE_WINDOW_MS - (now - state.availabilityRateTimestamps[0]));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  // חלק P2P (p2p-video-sharing.js) – רישום קובץ כזמין
  async function registerFileAvailability(hash, blob, mimeType) {
    try {
      log('upload', `📤 רישום קובץ כזמין`, {
        hash: hash.slice(0, 16) + '...',
        size: blob.size,
        mimeType
      });

      // שמירה מקומית
      state.availableFiles.set(hash, {
        blob,
        mimeType,
        size: blob.size,
        timestamp: Date.now(),
      });

      const manifest = await ensurePieceManifest(hash, blob, mimeType);
      const pieceSize = manifest?.pieceSize || DEFAULT_PIECE_SIZE;
      const pieceCount = manifest?.pieceCount || Math.ceil(blob.size / pieceSize);

      if (typeof App.pinCachedMedia === 'function') {
        try {
          await App.pinCachedMedia(hash, true);
          log('info', '📌 קובץ סומן כ-pinned ב-cache', { hash: hash.slice(0, 16) + '...' });
        } catch (pinErr) {
          console.warn('Failed to pin cached media', pinErr);
        }
      }

      // פרסום לרשת
      if (!App.pool || !App.publicKey || !App.privateKey) {
        log('error', '❌ לא ניתן לפרסם - חסרים pool או keys');
        return false;
      }

      const now = Date.now();
      const manifestEntry = state.availabilityManifest?.[hash];
      if (manifestEntry && typeof manifestEntry.lastPublished === 'number') {
        if (now - manifestEntry.lastPublished < AVAILABILITY_MANIFEST_TTL) {
          log('info', '⏳ דילוג על פרסום – כבר פורסם לאחרונה לפי manifest', {
            hash: hash.slice(0, 16) + '...',
            lastPublishedAgoSec: Math.round((now - manifestEntry.lastPublished) / 1000),
          });
          state.lastAvailabilityPublish.set(hash, now);
          return true;
        }
      }

      const lastPublish = state.lastAvailabilityPublish.get(hash) || 0;
      if (now - lastPublish < AVAILABILITY_REPUBLISH_INTERVAL) {
        const waitMs = AVAILABILITY_REPUBLISH_INTERVAL - (now - lastPublish);
        log('info', `⏳ דילוג על פרסום לריליי (קירור ${Math.ceil(waitMs / 1000)}ש׳׳)`, {
          hash: hash.slice(0, 16) + '...'
        });
        return true;
      }

      await ensureAvailabilityRateCapacity();

      const expiresAt = Date.now() + AVAILABILITY_EXPIRY;
      const createdAt = Math.floor(Date.now() / 1000);
      
      const event = {
        kind: FILE_AVAILABILITY_KIND,
        pubkey: App.publicKey,
        created_at: createdAt,
        tags: [
          ['d', `${P2P_APP_TAG}:file:${hash}`], // NIP-78: מזהה ייחודי לאפליקציה
          ['x', hash],
          ['t', 'p2p-file'], // סוג ההודעה
          ['size', String(blob.size)],
          ['mime', mimeType],
          ['expires', String(expiresAt)],
          ['piece_size', String(pieceSize)],
          ['piece_count', String(pieceCount)],
        ],
        content: '',
      };

      log('info', `📝 יוצר event לרישום:`, {
        kind: FILE_AVAILABILITY_KIND,
        pubkey: App.publicKey?.slice(0, 16) + '...',
        fullPubkey: App.publicKey,
        created_at: new Date(createdAt * 1000).toLocaleString('he-IL'),
        hash: hash,
        size: blob.size,
        mimeType: mimeType,
        expires: expiresAt,
        expiresDate: new Date(expiresAt).toLocaleString('he-IL'),
        tags: event.tags
      });

      const signed = App.finalizeEvent(event, App.privateKey);
      const relays = getP2PRelays();
      
      log('info', `📤 שולח לריליים:`, {
        relays: relays,
        eventId: signed.id,
        eventIdShort: signed.id?.slice(0, 16) + '...'
      });
      
      const publishResults = App.pool.publish(relays, signed);

      let successCount = 0;
      const successes = [];
      if (Array.isArray(publishResults)) {
        const results = await Promise.allSettled(publishResults);
        const failures = [];
        results.forEach((result, idx) => {
          const relayUrl = relays[idx] || `relay-${idx}`;
          if (result.status === 'fulfilled') {
            successCount++;
            successes.push(relayUrl);
            log('success', `✅ פרסום הצליח לריליי: ${relayUrl}`);
          } else {
            failures.push({
              relay: relayUrl,
              error: result.reason?.message || String(result.reason || 'unknown')
            });
            log('error', `❌ פרסום נכשל לריליי: ${relayUrl}`, {
              error: result.reason?.message || String(result.reason || 'unknown')
            });
          }
        });

        log('info', `📊 סיכום פרסום:`, {
          total: relays.length,
          success: successCount,
          failed: failures.length,
          successRelays: successes,
          failedRelays: failures
        });

        if (successCount === 0) {
          log('error', '❌ כל הריליים דחו את פרסום הזמינות', {
            hash: hash.slice(0, 16) + '...',
            failures
          });
          return false;
        }

        if (failures.length) {
          log('info', '⚠️ חלק מהריליים דחו את הפרסום', { failures });
        }
      } else if (publishResults?.then) {
        await publishResults;
        successCount = 1;
        log('success', `✅ פרסום הצליח (promise)`);
      } else {
        successCount = 1;
        log('info', `ℹ️ פרסום הושלם (לא promise)`);
      }

      log('success', `✅ קובץ נרשם בהצלחה ברשת`, {
        hash: hash.slice(0, 16) + '...',
        fullHash: hash,
        eventId: signed.id,
        eventIdShort: signed.id.slice(0, 8) + '...',
        successfulRelays: successes
      });

      state.lastAvailabilityPublish.set(hash, Date.now());
      state.availabilityManifest[hash] = {
        lastPublished: Date.now(),
        size: blob.size,
        mimeType,
      };
      saveAvailabilityManifest();

      return true;
    } catch (err) {
      log('error', `❌ כשלון ברישום קובץ: ${err.message}`);
      return false;
    }
  }

  // חלק P2P (p2p-video-sharing.js) – חיפוש peers עם קובץ
  async function findPeersWithFile(hash) {
    return new Promise((resolve) => {
      const relays = getP2PRelays();
      const sinceTimestamp = Math.floor(Date.now() / 1000) - PEER_DISCOVERY_LOOKBACK;
      const sinceDate = new Date(sinceTimestamp * 1000).toLocaleString('he-IL');
      
      log('download', `🔍 מחפש peers עם קובץ`, { 
        hash: hash.slice(0, 16) + '...',
        fullHash: hash,
        relays: relays,
        kind: FILE_AVAILABILITY_KIND,
        since: sinceDate,
        sinceTimestamp: sinceTimestamp,
        myPubkey: App.publicKey?.slice(0, 16) + '...'
      });

      const peers = new Map();
      const allEvents = []; // שמירת כל האירועים לדיבוג
      const filters = [{
        kinds: [FILE_AVAILABILITY_KIND],
        '#t': ['p2p-file'], // רק events של רישום קבצים
        '#x': [hash],
        since: sinceTimestamp,
      }];

      log('info', `📡 פילטר חיפוש:`, { filters: JSON.stringify(filters) });

      let finished = false;
      let timeoutHandle = null;
      let sub;
      let eventCount = 0;

      const finalize = (peerArray) => {
        if (finished) {
          return;
        }
        finished = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (sub && typeof sub.close === 'function') {
          try {
            sub.close();
          } catch (err) {
            console.warn('Failed closing subscription', err);
          }
        }
        resolve(peerArray);
      };

      try {
        log('info', `🔌 מתחבר לריליים: ${relays.join(', ')}`);
        
        sub = App.pool.subscribeMany(relays, filters, {
          onevent: (event) => {
            eventCount++;
            const eventInfo = {
              eventId: event.id?.slice(0, 16) + '...',
              pubkey: event.pubkey?.slice(0, 16) + '...',
              fullPubkey: event.pubkey,
              created_at: new Date(event.created_at * 1000).toLocaleString('he-IL'),
              tags: event.tags,
              kind: event.kind
            };
            
            log('info', `📨 קיבלתי event #${eventCount}`, eventInfo);
            allEvents.push(eventInfo);

            if (event.pubkey === App.publicKey) {
              log('info', `⏭️ דילוג - זה אני (${event.pubkey.slice(0, 16)}...)`);
              return;
            }

            const expiresTag = event.tags.find(t => t[0] === 'expires');
            const expires = expiresTag ? parseInt(expiresTag[1]) : 0;
            const now = Date.now();

            log('info', `⏰ בדיקת תוקף:`, {
              expires: expires,
              expiresDate: expires ? new Date(expires).toLocaleString('he-IL') : 'N/A',
              now: now,
              nowDate: new Date(now).toLocaleString('he-IL'),
              isValid: expires && expires > now
            });

            if (expires && expires > now) {
              const pieceSizeTag = event.tags.find(t => t[0] === 'piece_size');
              const pieceCountTag = event.tags.find(t => t[0] === 'piece_count');
              const mimeTag = event.tags.find(t => t[0] === 'mime');
              const sizeTag = event.tags.find(t => t[0] === 'size');
              const peerInfo = {
                pubkey: event.pubkey,
                expires,
                pieceSize: pieceSizeTag ? Number(pieceSizeTag[1]) : null,
                pieceCount: pieceCountTag ? Number(pieceCountTag[1]) : null,
                totalSize: sizeTag ? Number(sizeTag[1]) : null,
                mimeType: mimeTag ? mimeTag[1] : null,
              };
              peers.set(event.pubkey, peerInfo);
              rememberPeerCatalog(event.pubkey, [hash]);
              log('peer', `👤 נמצא peer זמין!`, {
                pubkey: event.pubkey.slice(0, 16) + '...',
                expires: new Date(expires).toLocaleTimeString('he-IL'),
                pieceSize: peerInfo.pieceSize,
                pieceCount: peerInfo.pieceCount,
              });
            } else {
              log('info', `❌ peer פג תוקף או חסר expires`, {
                pubkey: event.pubkey.slice(0, 16) + '...',
                expires: expires,
                reason: !expires ? 'חסר expires tag' : 'פג תוקף'
              });
            }
          },
          oneose: () => {
            const peerArray = Array.from(peers.values());
            log('info', `📋 סיימתי חיפוש (EOSE)`, {
              totalEventsReceived: eventCount,
              validPeers: peerArray.length,
              peers: peerArray.map(p => p.pubkey.slice(0, 16) + '...'),
              allEventsReceived: allEvents
            });
            finalize(peerArray);
          }
        });

        // timeout
        timeoutHandle = setTimeout(() => {
          const peerArray = Array.from(peers.values());
          log('info', `⏱️ timeout בחיפוש (${PEER_DISCOVERY_TIMEOUT}ms)`, {
            eventsReceivedSoFar: eventCount,
            peersFound: peerArray.length
          });
          finalize(peerArray);
        }, PEER_DISCOVERY_TIMEOUT);

      } catch (err) {
        log('error', `❌ כשלון בחיפוש peers: ${err.message}`, { 
          error: err.toString(),
          stack: err.stack 
        });
        finalize([]);
      }
    });
  }

  // חלק P2P (p2p-video-sharing.js) – הורדת קובץ מ-peer
  async function downloadFromPeer(peerPubkey, hash) {
    for (let attempt = 1; attempt <= ANSWER_RETRY_LIMIT; attempt++) {
      try {
        return await attemptPeerDownload(peerPubkey, hash, attempt);
      } catch (err) {
        const isAnswerTimeout = err && err.message === 'Answer timeout';
        if (isAnswerTimeout && attempt < ANSWER_RETRY_LIMIT) {
          log('info', `🔁 Answer timeout – מנסה שוב (${attempt + 1}/${ANSWER_RETRY_LIMIT})`, {
            peer: peerPubkey.slice(0, 16) + '...',
            hash: hash.slice(0, 16) + '...'
          });
          await sleep(ANSWER_RETRY_DELAY);
          continue;
        }
        throw err;
      }
    }
  }

  function attemptPeerDownload(peerPubkey, hash, attemptNumber) {
    const connectionId = `${peerPubkey}-${hash}-${Date.now()}-a${attemptNumber}`;

    log('download', `📥 מנסה להוריד מ-peer (ניסיון ${attemptNumber}/${ANSWER_RETRY_LIMIT})`, {
      peer: peerPubkey.slice(0, 16) + '...',
      hash: hash.slice(0, 16) + '...',
      connectionId
    });

    return new Promise(async (resolve, reject) => {
      const timeoutMs = typeof window.NostrP2P_DOWNLOAD_TIMEOUT === 'number'
        ? window.NostrP2P_DOWNLOAD_TIMEOUT
        : MAX_DOWNLOAD_TIMEOUT;
      const timeout = setTimeout(() => {
        log('error', `⏱️ timeout בהורדה מ-peer`, { peer: peerPubkey.slice(0, 16) + '...' });
        cleanup();
        reject(new Error('Download timeout'));
      }, timeoutMs);

      let pc = null;
      let channel = null;
      const chunks = [];
      let receivedSize = 0;
      let totalSize = 0;

      function cleanup() {
        clearTimeout(timeout);
        if (channel) {
          channel.close();
        }
        if (pc) {
          pc.close();
          state.activeConnections.delete(connectionId);
        }
        const pending = state.pendingConnections.get(connectionId);
        if (pending) {
          clearTimeout(pending.timeout);
          state.pendingConnections.delete(connectionId);
        }
      }

      try {
        pc = new RTCPeerConnection(RTC_CONFIG);
        state.activeConnections.set(connectionId, pc);

        log('peer', `🔗 יצירת RTCPeerConnection`, { connectionId });

        channel = pc.createDataChannel('file-transfer', {
          ordered: true,
        });

        log('peer', `📡 יצירת data channel`, { connectionId });

        channel.onopen = () => {
          log('success', `✅ data channel נפתח`, { connectionId });
          channel.send(JSON.stringify({ type: 'request', hash }));
          log('request', `📤 שלחתי בקשה לקובץ`, { hash: hash.slice(0, 16) + '...' });
        };

        channel.onmessage = (event) => {
          try {
            if (typeof event.data === 'string') {
              const msg = JSON.parse(event.data);

              if (msg.type === 'metadata') {
                totalSize = msg.size;
                log('info', `📊 קיבלתי metadata`, {
                  size: totalSize,
                  mimeType: msg.mimeType
                });
              } else if (msg.type === 'complete') {
                log('success', `✅ קיבלתי את כל הקובץ!`, {
                  chunks: chunks.length,
                  totalSize: receivedSize
                });

                const blob = new Blob(chunks, { type: msg.mimeType });
                cleanup();
                resolve({ blob, mimeType: msg.mimeType });
              } else if (msg.type === 'error') {
                log('error', `❌ שגיאה מהשרת: ${msg.message}`);
                cleanup();
                reject(new Error(msg.message));
              }
            } else {
              const chunkSize = event.data.byteLength || event.data.size;
              chunks.push(event.data);
              receivedSize += chunkSize;
              updateDownloadProgress(connectionId, receivedSize, totalSize, {
                chunkSize,
                chunks: chunks.length,
              });
            }
          } catch (err) {
            log('error', `❌ שגיאה בעיבוד הודעה: ${err.message}`);
          }
        };

        channel.onerror = (err) => {
          log('error', `❌ שגיאה ב-data channel: ${err}`);
          cleanup();
          reject(err);
        };

        channel.onclose = () => {
          log('info', `🔌 data channel נסגר`, { connectionId });
        };

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            log('peer', `🧊 ICE candidate חדש`, {
              type: event.candidate.type,
              protocol: event.candidate.protocol
            });
            sendSignal(peerPubkey, 'ice-candidate', {
              candidate: event.candidate,
              hash,
              connectionId
            });
          }
        };

        pc.oniceconnectionstatechange = () => {
          log('peer', `🔄 ICE connection state: ${pc.iceConnectionState}`, { connectionId });

          if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            log('error', `❌ חיבור נכשל`, { state: pc.iceConnectionState });
            cleanup();
            reject(new Error('Connection failed'));
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        log('peer', `📤 שולח offer ל-peer`, { peer: peerPubkey.slice(0, 16) + '...' });

        await sendSignal(peerPubkey, 'file-request', {
          offer,
          hash,
          connectionId
        });

        log('request', `✅ offer נשלח בהצלחה`, { connectionId });

        const answerTimeout = setTimeout(() => {
          log('error', '❌ לא התקבל answer בזמן', { connectionId }, {
            throttleKey: `answer-timeout-${hash}`,
            throttleMs: 5000,
          });
          state.pendingConnections.delete(connectionId);
          cleanup();
          reject(new Error('Answer timeout'));
        }, ANSWER_TIMEOUT);

        state.pendingConnections.set(connectionId, { pc, timeout: answerTimeout });

      } catch (err) {
        log('error', `❌ כשלון ביצירת חיבור: ${err.message}`);
        cleanup();
        reject(err);
      }
    });
  }

  // חלק P2P (p2p-video-sharing.js) – שליחת signal דרך Nostr
  async function sendSignal(peerPubkey, type, data) {
    try {
      if (!App.pool || !App.publicKey || !App.privateKey) {
        throw new Error('Missing pool or keys');
      }

      await throttleSignals();

      const content = JSON.stringify({ type, data });
      
      // הצפנה אם יש פונקציה
      let encryptedContent = content;
      if (typeof App.encryptMessage === 'function') {
        encryptedContent = await App.encryptMessage(content, peerPubkey);
      }

      const kind = FILE_REQUEST_KIND; // כל הסיגנלים משתמשים ב-30078
      const signalType = type === 'file-request' ? 'req' : (type === 'file-response' ? 'res' : 'ice');

      const event = {
        kind,
        pubkey: App.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', `${P2P_APP_TAG}:signal:${Date.now()}`], // NIP-78: מזהה ייחודי
          ['p', peerPubkey],
          ['t', `p2p-${signalType}`], // סוג הסיגנל
        ],
        content: encryptedContent,
      };

      const signed = App.finalizeEvent(event, App.privateKey);
      const relays = getP2PRelays(); // שימוש בריליי P2P במקום הריליים הרגילים
      await App.pool.publish(relays, signed);

      log('peer', `📡 signal נשלח`, {
        type,
        to: peerPubkey.slice(0, 16) + '...',
        kind,
        relays: relays
      });

    } catch (err) {
      log('error', `❌ כשלון בשליחת signal: ${err.message}`);
      throw err;
    }
  }

  // חלק P2P (p2p-video-sharing.js) – האזנה לסיגנלים (בקשות, תשובות ו-ICE)
  function listenForP2PSignals() {
    if (!App.pool || !App.publicKey) {
      log('error', '❌ לא ניתן להאזין לסיגנלים - חסרים pool או publicKey');
      return;
    }

    log('info', '👂 מתחיל להאזין לסיגנלי P2P...');

    const filters = [
      {
        kinds: [FILE_REQUEST_KIND], // 30078 - כל הסיגנלים
        '#p': [App.publicKey],
        since: Math.floor(Date.now() / 1000),
      }
    ];

    try {
      const relays = getP2PRelays();
      const sub = App.pool.subscribeMany(relays, filters, {
        onevent: async (event) => {
          log('request', `📬 התקבל סיגנל`, {
            kind: event.kind,
            from: event.pubkey.slice(0, 16) + '...',
            eventId: event.id.slice(0, 8) + '...'
          });

          try {
            let content = event.content;

            if (typeof App.decryptMessage === 'function') {
              content = await App.decryptMessage(content, event.pubkey);
            }

            const message = JSON.parse(content);

            if (message.type === 'file-request') {
              await handleFileRequest(event.pubkey, message.data);
            } else if (message.type === 'file-response') {
              await handleFileResponse(event.pubkey, message.data);
            } else if (message.type === 'ice-candidate') {
              await handleIceCandidate(event.pubkey, message.data);
            }

          } catch (err) {
            log('error', `❌ כשלון בעיבוד סיגנל: ${err.message}`);
          }
        }
      });

      App._p2pSignalsSub = sub;
      log('success', '✅ מאזין לסיגנלי P2P');

    } catch (err) {
      log('error', `❌ כשלון בהאזנה לסיגנלים: ${err.message}`);
    }
  }

  async function handleFileResponse(peerPubkey, data) {
    try {
      const { answer, connectionId } = data || {};
      if (!connectionId || !answer) {
        log('error', '❌ תשובה חסרה connectionId או answer');
        return;
      }

      const pc = state.activeConnections.get(connectionId);
      if (!pc) {
        log('error', `❌ לא נמצא חיבור פעיל עבור ${connectionId}`);
        return;
      }

      const pending = state.pendingConnections.get(connectionId);
      if (pending) {
        clearTimeout(pending.timeout);
        state.pendingConnections.delete(connectionId);
      }

      log('peer', `📥 קיבלתי answer מ-peer`, {
        peer: peerPubkey.slice(0, 16) + '...',
        connectionId
      });

      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      log('success', '✅ answer נוסף בהצלחה');
    } catch (err) {
      log('error', `❌ כשלון בעיבוד answer: ${err.message}`);
    }
  }

  // חלק P2P (p2p-video-sharing.js) – טיפול בבקשת קובץ
  async function handleFileRequest(peerPubkey, data) {
    const { offer, hash, connectionId } = data;

    log('request', `🔧 מטפל בבקשת קובץ`, {
      peer: peerPubkey.slice(0, 16) + '...',
      hash: hash.slice(0, 16) + '...',
      connectionId
    });

    // בדיקה אם יש לנו את הקובץ
    const fileData = state.availableFiles.get(hash);
    if (!fileData) {
      log('error', `❌ אין לי את הקובץ הזה`, { hash: hash.slice(0, 16) + '...' });
      return;
    }

    log('success', `✅ יש לי את הקובץ! מתחיל שליחה`, {
      size: fileData.size,
      mimeType: fileData.mimeType
    });

    try {
      const pc = new RTCPeerConnection(RTC_CONFIG);
      state.activeConnections.set(connectionId, pc);

      log('peer', `🔗 יצרתי RTCPeerConnection לשליחה`, { connectionId });

      // קבלת data channel מה-peer
      pc.ondatachannel = (event) => {
        const channel = event.channel;
        
        log('peer', `📡 קיבלתי data channel`, { connectionId });

        channel.onopen = async () => {
          log('success', `✅ data channel נפתח - מתחיל שליחה!`);

          try {
            // שליחת metadata
            channel.send(JSON.stringify({
              type: 'metadata',
              size: fileData.size,
              mimeType: fileData.mimeType
            }));

            log('upload', `📊 שלחתי metadata`, {
              size: fileData.size,
              mimeType: fileData.mimeType
            });

            // שליחת הקובץ ב-chunks
            const blob = fileData.blob;
            let offset = 0;
            let chunkNum = 0;

            while (offset < blob.size) {
              const chunk = blob.slice(offset, offset + CHUNK_SIZE);
              const arrayBuffer = await chunk.arrayBuffer();
              
              // המתנה אם ה-buffer מלא
              while (channel.bufferedAmount > CHUNK_SIZE * 4) {
                await new Promise(resolve => setTimeout(resolve, 10));
              }

              channel.send(arrayBuffer);
              chunkNum++;
              offset += CHUNK_SIZE;

              const progress = ((offset / blob.size) * 100).toFixed(1);
              log('upload', `📤 שלחתי chunk ${chunkNum}`, {
                progress: `${progress}%`,
                sent: `${offset} / ${blob.size}`
              });
            }

            // שליחת הודעת סיום
            channel.send(JSON.stringify({
              type: 'complete',
              mimeType: fileData.mimeType
            }));

            log('success', `✅ סיימתי לשלוח את כל הקובץ!`, {
              chunks: chunkNum,
              totalSize: blob.size
            });

          } catch (err) {
            log('error', `❌ שגיאה בשליחת קובץ: ${err.message}`);
            channel.send(JSON.stringify({
              type: 'error',
              message: err.message
            }));
          }
        };

        channel.onerror = (err) => {
          log('error', `❌ שגיאה ב-data channel: ${err}`);
        };

        channel.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'request') {
              log('request', `📥 peer ביקש את הקובץ`, { hash: msg.hash.slice(0, 16) + '...' });
            }
          } catch (err) {
            // לא JSON, אולי binary data
          }
        };
      };

      // ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          log('peer', `🧊 ICE candidate חדש (שליחה)`, {
            type: event.candidate.type
          });
          sendSignal(peerPubkey, 'ice-candidate', {
            candidate: event.candidate,
            hash,
            connectionId
          });
        }
      };

      pc.oniceconnectionstatechange = () => {
        log('peer', `🔄 ICE connection state (שליחה): ${pc.iceConnectionState}`);
      };

      // קבלת ה-offer ויצירת answer
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      log('peer', `📤 שולח answer ל-peer`, { peer: peerPubkey.slice(0, 16) + '...' });

      // שליחת answer
      await sendSignal(peerPubkey, 'file-response', {
        answer: answer,
        hash,
        connectionId
      });

      log('success', `✅ answer נשלח בהצלחה`);

    } catch (err) {
      log('error', `❌ כשלון בטיפול בבקשה: ${err.message}`);
    }
  }

  // חלק P2P (p2p-video-sharing.js) – טיפול ב-ICE candidate
  async function handleIceCandidate(peerPubkey, data) {
    const { candidate, connectionId } = data;
    
    log('peer', `🧊 קיבלתי ICE candidate`, {
      peer: peerPubkey.slice(0, 16) + '...',
      connectionId
    });

    const pc = state.activeConnections.get(connectionId);
    if (pc && candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        log('success', `✅ ICE candidate נוסף בהצלחה`);
      } catch (err) {
        log('error', `❌ כשלון בהוספת ICE candidate: ${err.message}`);
      }
    }
  }

  // חלק P2P (p2p-video-sharing.js) – הורדת וידאו עם fallback
  async function downloadVideoWithP2P(url, hash, mimeType = 'video/webm') {
    const queueKey = hash || url;
    return runExclusiveDownload(queueKey, async () => {
      const releaseSlot = await acquireDownloadSlot(hash || url);
      log('download', `🎬 מתחיל הורדת וידאו`, {
        url: url.slice(0, 50) + '...',
        hash: hash ? hash.slice(0, 16) + '...' : 'אין hash'
      });

      try {
        if (!hash) {
          log('info', `ℹ️ אין hash - הורדה רגילה מהלינק`);
          try {
            const response = await fetch(url);
            const blob = await response.blob();
            log('success', `✅ הורדה מהלינק הצליחה`, { size: blob.size });
            return { blob, source: 'url' };
          } catch (err) {
            log('error', `❌ הורדה מהלינק נכשלה: ${err.message}`);
            throw err;
          }
        }

        if (typeof App.getCachedMedia === 'function') {
          const cached = await App.getCachedMedia(hash);
          if (cached && cached.blob) {
            log('success', `✅ נמצא ב-cache מקומי!`, { size: cached.blob.size });
            const cachedMime = cached.mimeType || mimeType;
            await registerFileAvailability(hash, cached.blob, cachedMime);
            return { blob: cached.blob, source: 'cache' };
          }
        }

        const peers = await findPeersWithFile(hash);

        if (peers.length === 0) {
          log('info', `ℹ️ לא נמצאו peers - הורדה מהלינק`);
          try {
            const response = await fetch(url);
            const blob = await response.blob();
            log('success', `✅ הורדה מהלינק הצליחה`, { size: blob.size });
            if (typeof App.cacheMedia === 'function') {
              await App.cacheMedia(url, hash, blob, mimeType, { pinned: true });
            }
            await registerFileAvailability(hash, blob, mimeType);
            return { blob, source: 'url' };
          } catch (err) {
            log('error', `❌ הורדה מהלינק נכשלה: ${err.message}`);
            throw err;
          }
        }

        let attemptCount = 0;
        for (const peer of peers) {
          if (MAX_PEER_ATTEMPTS_PER_FILE > 0 && attemptCount >= MAX_PEER_ATTEMPTS_PER_FILE) {
            log('info', '🛑 הושגה מגבלת ניסיונות peer – עובר לפולבאק', {
              hash: hash.slice(0, 16) + '...',
              attempts: attemptCount,
            });
            break;
          }
          attemptCount += 1;
          try {
            log('download', `🔄 מנסה להוריד מ-peer ${attemptCount}/${MAX_PEER_ATTEMPTS_PER_FILE > 0 ? Math.min(peers.length, MAX_PEER_ATTEMPTS_PER_FILE) : peers.length}`, {
              peer: peer.slice(0, 16) + '...'
            });

            const result = await downloadFromPeer(peer, hash);

            log('success', `🎉 הורדה מ-peer הצליחה!`, {
              peer: peer.slice(0, 16) + '...'
            });

            if (typeof App.cacheMedia === 'function') {
              await App.cacheMedia(url, hash, result.blob, result.mimeType, { pinned: true });
            }

            await registerFileAvailability(hash, result.blob, result.mimeType);

            return { blob: result.blob, source: 'p2p', peer };

          } catch (err) {
            log('error', `❌ הורדה מ-peer נכשלה: ${err.message}`, {
              peer: peer.slice(0, 16) + '...'
            });
            continue;
          }
        }

        log('info', `ℹ️ כל ה-peers נכשלו - fallback ללינק`);
        try {
          const response = await fetch(url);
          const blob = await response.blob();
          log('success', `✅ fallback ללינק הצליח`, { size: blob.size });
          if (typeof App.cacheMedia === 'function') {
            await App.cacheMedia(url, hash, blob, mimeType, { pinned: true });
          }
          await registerFileAvailability(hash, blob, mimeType);
          return { blob, source: 'url-fallback' };
        } catch (err) {
          log('error', `❌ גם fallback ללינק נכשל: ${err.message}`);
          throw err;
        }
      } finally {
        if (typeof releaseSlot === 'function') {
          releaseSlot();
        }
      }
    });
  }

  // פונקציית דיבוג - בדיקה אם הריליי שומר events מסוג 30078 (NIP-78)
  async function debugCheckRelayEvents() {
    const relays = getP2PRelays();
    log('info', `🔬 בדיקת דיבוג - מחפש כל events מסוג ${FILE_AVAILABILITY_KIND} בריליים`, { relays });
    
    return new Promise((resolve) => {
      const allEvents = [];
      const sinceTimestamp = Math.floor(Date.now() / 1000) - PEER_DISCOVERY_LOOKBACK;
      
      const filters = [{
        kinds: [FILE_AVAILABILITY_KIND],
        '#t': ['p2p-file'], // רק events של רישום קבצים
        since: sinceTimestamp,
        limit: 50
      }];
      
      log('info', `🔬 פילטר דיבוג (בלי hash):`, { filters: JSON.stringify(filters) });
      
      let finished = false;
      const timeout = setTimeout(() => {
        if (!finished) {
          finished = true;
          log('info', `🔬 timeout דיבוג - נמצאו ${allEvents.length} events`, { 
            events: allEvents.map(e => ({
              id: e.id?.slice(0, 16),
              pubkey: e.pubkey?.slice(0, 16),
              hash: e.tags?.find(t => t[0] === 'x')?.[1]?.slice(0, 16),
              created: new Date(e.created_at * 1000).toLocaleString('he-IL')
            }))
          });
          resolve(allEvents);
        }
      }, 10000);
      
      try {
        const sub = App.pool.subscribeMany(relays, filters, {
          onevent: (event) => {
            allEvents.push(event);
            const hashTag = event.tags?.find(t => t[0] === 'x');
            log('info', `🔬 נמצא event:`, {
              id: event.id?.slice(0, 16),
              pubkey: event.pubkey?.slice(0, 16),
              hash: hashTag?.[1]?.slice(0, 16),
              created: new Date(event.created_at * 1000).toLocaleString('he-IL'),
              isMe: event.pubkey === App.publicKey
            });
          },
          oneose: () => {
            if (!finished) {
              finished = true;
              clearTimeout(timeout);
              log('info', `🔬 סיום דיבוג (EOSE) - נמצאו ${allEvents.length} events כולל`, {
                total: allEvents.length,
                myEvents: allEvents.filter(e => e.pubkey === App.publicKey).length,
                otherEvents: allEvents.filter(e => e.pubkey !== App.publicKey).length,
                uniquePubkeys: [...new Set(allEvents.map(e => e.pubkey))].map(p => p?.slice(0, 16))
              });
              if (sub && typeof sub.close === 'function') {
                sub.close();
              }
              resolve(allEvents);
            }
          }
        });
      } catch (err) {
        log('error', `🔬 שגיאת דיבוג: ${err.message}`);
        resolve([]);
      }
    });
  }

  // פונקציה לפרסום מחדש של כל הקבצים הזמינים (לדיבוג)
  async function republishAllFiles() {
    const files = state.availableFiles;
    log('info', `🔄 מפרסם מחדש ${files.size} קבצים...`);
    
    // איפוס cooldown
    state.lastAvailabilityPublish.clear();
    
    for (const [hash, fileData] of files) {
      await registerFileAvailability(hash, fileData.blob, fileData.mimeType);
      await new Promise(r => setTimeout(r, 500)); // המתנה קצרה בין פרסומים
    }
    
    log('success', `✅ פורסמו מחדש ${files.size} קבצים`);
    return files.size;
  }

  // חלק P2P (p2p-video-sharing.js) – טעינת קבצים זמינים מ-IndexedDB בעת אתחול
  async function loadAvailableFilesFromCache() {
    try {
      const DB_NAME = 'SOS2MediaCache';
      const STORE_NAME = 'media';

      return new Promise((resolve) => {
        const request = indexedDB.open(DB_NAME, 1);
        
        request.onerror = () => {
          log('error', '❌ לא ניתן לפתוח IndexedDB לטעינת קבצים');
          resolve(0);
        };

        request.onsuccess = () => {
          const db = request.result;
          
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            log('info', 'ℹ️ אין store של מדיה ב-IndexedDB');
            resolve(0);
            return;
          }

          const transaction = db.transaction([STORE_NAME], 'readonly');
          const store = transaction.objectStore(STORE_NAME);
          const getAllRequest = store.getAll();

          getAllRequest.onsuccess = () => {
            const entries = getAllRequest.result || [];
            let loadedCount = 0;

            entries.forEach((entry) => {
              if (entry.hash && entry.blob && entry.pinned) {
                state.availableFiles.set(entry.hash, {
                  blob: entry.blob,
                  mimeType: entry.mimeType || entry.blob.type,
                  size: entry.size || entry.blob.size,
                  timestamp: entry.timestamp || Date.now(),
                });
                loadedCount++;
              }
            });

            log('success', `✅ נטענו ${loadedCount} קבצים זמינים מ-cache`, {
              total: entries.length,
              pinned: loadedCount
            });
            resolve(loadedCount);
          };

          getAllRequest.onerror = () => {
            log('error', '❌ שגיאה בטעינת קבצים מ-IndexedDB');
            resolve(0);
          };
        };
      });
    } catch (err) {
      log('error', `❌ שגיאה בטעינת קבצים זמינים: ${err.message}`);
      return 0;
    }
  }

  // חשיפה ל-App
  Object.assign(App, {
    registerFileAvailability,
    findPeersWithFile,
    downloadFromPeer, // חשיפה לדיבוג
    downloadVideoWithP2P,
    republishAllFiles, // פרסום מחדש של כל הקבצים
    p2pGetAvailableFiles: () => state.availableFiles,
    p2pGetActiveConnections: () => state.activeConnections,
    p2pDebugCheckRelay: debugCheckRelayEvents,
    p2pReloadAvailableFiles: loadAvailableFilesFromCache, // טעינה מחדש של קבצים זמינים
  });

  // אתחול
  async function init() {
    log('info', '🚀 מערכת P2P Video Sharing מאותחלת...');
    
    // טעינת קבצים זמינים מ-cache
    await loadAvailableFilesFromCache();
    
    // ניסיון אתחול מיידי
    function tryInit() {
      if (App.publicKey && App.pool) {
        listenForP2PSignals();
        log('success', '✅ מערכת P2P מוכנה!', {
          publicKey: App.publicKey.slice(0, 16) + '...',
          relays: getP2PRelays().length,
          availableFiles: state.availableFiles.size
        });
        return true;
      }
      return false;
    }
    
    // ניסיון ראשון
    if (tryInit()) return;
    
    // ניסיונות נוספים עם המתנה
    let attempts = 0;
    const maxAttempts = 10;
    const interval = setInterval(() => {
      attempts++;
      log('info', `🔄 ניסיון אתחול ${attempts}/${maxAttempts}...`);
      
      if (tryInit()) {
        clearInterval(interval);
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
        log('error', '❌ חסרים publicKey או pool - מערכת P2P לא פעילה');
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // חלק P2P (p2p-video-sharing.js) – חשיפת API נוספת ל-App
  Object.assign(App, {
    searchForPeers: findPeersWithFile,
    setChatFileTransferActivePeer: (peer) => { state.activeChatPeer = peer; },
    _p2pSignalsSub: null, // יאותחל ב-listenForP2PSignals
  });

})(window);
