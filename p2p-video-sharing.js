(function initP2PVideoSharing(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  function getP2PRelays() {
    if (Array.isArray(App.p2pRelayUrls) && App.p2pRelayUrls.length) {
      return App.p2pRelayUrls;
    }
    if (Array.isArray(App.relayUrls) && App.relayUrls.length) {
      return App.relayUrls;
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
  const PEER_DISCOVERY_TIMEOUT = window.NostrP2P_PEER_DISCOVERY_TIMEOUT || 15000;
  const PEER_DISCOVERY_LOOKBACK = 24 * 60 * 60; // 24 שעות אחורה - כדי למצוא peers גם אם פרסמו מוקדם יותר
  const CHUNK_SIZE = 16384; // 16KB chunks
  const MAX_DOWNLOAD_TIMEOUT = window.NostrP2P_DOWNLOAD_TIMEOUT || 45000; // 45 שניות
  const ANSWER_TIMEOUT = window.NostrP2P_ANSWER_TIMEOUT || 30000;
  const ANSWER_RETRY_LIMIT = window.NostrP2P_ANSWER_RETRY_LIMIT || 3;
  const ANSWER_RETRY_DELAY = window.NostrP2P_ANSWER_RETRY_DELAY || 2000;

  // חלק P2P (p2p-video-sharing.js) – WebRTC config
  const RTC_CONFIG = Array.isArray(window.NostrRTC_ICE) && window.NostrRTC_ICE.length
    ? { iceServers: window.NostrRTC_ICE }
    : {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
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
  };

  const logState = {
    throttle: new Map(),
    downloadProgress: new Map(),
  };

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

      const peers = new Set();
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
              peers.add(event.pubkey);
              log('peer', `👤 נמצא peer זמין!`, {
                pubkey: event.pubkey.slice(0, 16) + '...',
                expires: new Date(expires).toLocaleTimeString('he-IL')
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
            const peerArray = Array.from(peers);
            log('info', `📋 סיימתי חיפוש (EOSE)`, {
              totalEventsReceived: eventCount,
              validPeers: peerArray.length,
              peers: peerArray.map(p => p.slice(0, 16) + '...'),
              allEventsReceived: allEvents
            });
            finalize(peerArray);
          }
        });

        // timeout
        timeoutHandle = setTimeout(() => {
          const peerArray = Array.from(peers);
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
      log('download', `🎬 מתחיל הורדת וידאו`, {
        url: url.slice(0, 50) + '...',
        hash: hash ? hash.slice(0, 16) + '...' : 'אין hash'
      });

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

      for (const peer of peers) {
        try {
          log('download', `🔄 מנסה להוריד מ-peer ${peers.indexOf(peer) + 1}/${peers.length}`, {
            peer: peer.slice(0, 16) + '...'
          });

          const result = await downloadFromPeer(peer, hash);

          log('success', `🎉 הורדה מ-peer הצליחה!`, {
            peer: peer.slice(0, 16) + '...',
            size: result.blob.size
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
  });

  // אתחול
  function init() {
    log('info', '🚀 מערכת P2P Video Sharing מאותחלת...');
    
    // ניסיון אתחול מיידי
    function tryInit() {
      if (App.publicKey && App.pool) {
        listenForP2PSignals();
        log('success', '✅ מערכת P2P מוכנה!', {
          publicKey: App.publicKey.slice(0, 16) + '...',
          relays: getP2PRelays().length
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
