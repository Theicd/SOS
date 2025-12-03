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
  const P2P_VERSION = '2.1.2-fix-tag'; // תג לזיהוי האפליקציה
  const P2P_APP_TAG = 'sos-p2p-video'; // תג לזיהוי אירועי P2P של האפליקציה
  const SIGNAL_ENCRYPTION_ENABLED = window.NostrP2P_SIGNAL_ENCRYPTION === true; // חלק סיגנלים (p2p-video-sharing.js) – קונפיגורציה להצפנת סיגנלים | HYPER CORE TECH
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

  // חלק Network Tiers (p2p-video-sharing.js) – אסטרטגיית טעינה מותאמת לפי כמות משתמשים | HYPER CORE TECH
  const NETWORK_TIER_BOOTSTRAP_MAX = 3;   // משתמשים 1-3: כל הפוסטים מ-Blossom
  const NETWORK_TIER_HYBRID_MAX = 10;     // משתמשים 4-10: 3 אחרונים מ-Blossom, שאר P2P
  const HYBRID_BLOSSOM_POSTS = 3;         // כמות פוסטים לטעון מ-Blossom במצב Hybrid
  const INITIAL_LOAD_TIMEOUT = 5000;      // 5 שניות timeout לטעינה ראשונית
  const AVAILABILITY_PUBLISH_DELAY = 2000; // 2 שניות המתנה בין פרסומי זמינות
  const PEER_COUNT_CACHE_TTL = 30000;     // 30 שניות cache לספירת peers
  const CONSECUTIVE_FAILURES_THRESHOLD = 2; // כמות כשלונות ברצף לפני fallback
  const HEARTBEAT_INTERVAL = 60000;       // שליחת heartbeat כל דקה
  const HEARTBEAT_LOOKBACK = 120;         // חיפוש heartbeats מ-2 דקות אחורה

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
    // חלק WebRTC (p2p-video-sharing.js) – ניהול תור ל-ICE candidates עד שה-remote description מוכן | HYPER CORE TECH
    pendingIceCandidates: new Map(), // connectionId -> RTCIceCandidate[]
    downloadQueue: new Map(), // hash -> Promise
    availabilityManifest: loadAvailabilityManifest(),
    availabilityRateTimestamps: [],
    signalTimestamps: [],
    activeTransferSlots: 0,
    pendingTransferResolvers: [],
    // חלק Network Tiers (p2p-video-sharing.js) – מצב רשת ומטמון peers | HYPER CORE TECH
    networkTier: 'UNKNOWN',           // BOOTSTRAP | HYBRID | P2P_FULL | UNKNOWN
    lastPeerCount: 0,                 // ספירת peers אחרונה
    lastPeerCountTime: 0,             // זמן ספירה אחרונה
    consecutiveP2PFailures: 0,        // כשלונות P2P ברצף
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

  // פונקציה לטעינת וידאו דרך video element כדי לעקוף CORS
  // הדפדפן מאפשר ל-video element לטעון מכל מקור, גם בלי CORS headers
  function fetchViaVideoElement(url, mimeType) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous'; // ננסה עם anonymous קודם
      video.preload = 'auto';
      video.muted = true;
      
      const timeout = setTimeout(() => {
        video.src = '';
        reject(new Error('Video element load timeout'));
      }, 30000);
      
      video.onloadeddata = async () => {
        clearTimeout(timeout);
        try {
          // ננסה לצלם frame מהוידאו כדי לוודא שהוא נטען
          // אם זה עובד, נחזיר את ה-URL כ-blob
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth || 640;
          canvas.height = video.videoHeight || 360;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0);
          
          // הוידאו נטען בהצלחה - נחזיר blob ריק כסימן שהוידאו זמין
          // הוידאו יוצג ישירות מה-URL
          const blob = new Blob([], { type: mimeType || 'video/mp4' });
          blob._directUrl = url; // סימון שזה URL ישיר
          video.src = '';
          resolve(blob);
        } catch (err) {
          video.src = '';
          reject(err);
        }
      };
      
      video.onerror = () => {
        clearTimeout(timeout);
        video.src = '';
        reject(new Error('Video element failed to load'));
      };
      
      // ננסה בלי crossOrigin אם נכשל
      video.src = url;
    });
  }

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

  // חלק סיגנלים (p2p-video-sharing.js) – עטיפת הצפנה/פענוח עבור תאימות רחבה | HYPER CORE TECH
  async function prepareSignalContent(payload, peerPubkey) {
    if (!SIGNAL_ENCRYPTION_ENABLED || typeof App.encryptMessage !== 'function') {
      return { content: payload, encrypted: false };
    }

    try {
      const encrypted = await App.encryptMessage(payload, peerPubkey);
      return { content: encrypted, encrypted: true };
    } catch (err) {
      log('info', 'ℹ️ כשל בהצפנת signal – שולח כטקסט גלוי להבטחת תאימות', {
        peer: peerPubkey?.slice?.(0, 16) + '...',
        error: err?.message || String(err),
      }, {
        throttleKey: `signal-encrypt-${peerPubkey}`,
        throttleMs: 15000,
      });
      return { content: payload, encrypted: false };
    }
  }

  async function extractSignalContent(rawContent, senderPubkey) {
    if (!rawContent || typeof App.decryptMessage !== 'function') {
      return rawContent;
    }

    try {
      return await App.decryptMessage(rawContent, senderPubkey);
    } catch (err) {
      log('info', 'ℹ️ לא הצלחתי לפענח signal – משתמש בתוכן המקורי', {
        sender: senderPubkey?.slice?.(0, 16) + '...',
        error: err?.message || String(err),
      }, {
        throttleKey: `signal-decrypt-${senderPubkey}`,
        throttleMs: 15000,
      });
      return rawContent;
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

  // חלק אחסון זמינות (p2p-video-sharing.js) – דחיסת manifest למניעת חריגה מה-Quota | HYPER CORE TECH
  function pruneAvailabilityManifest(limit = 250) {
    const manifest = state.availabilityManifest || {};
    const entries = Object.entries(manifest)
      .sort((a, b) => (b[1]?.lastPublished || 0) - (a[1]?.lastPublished || 0))
      .slice(0, limit);
    const compacted = Object.fromEntries(entries);
    state.availabilityManifest = compacted;
    return compacted;
  }

  function saveAvailabilityManifest() {
    try {
      const compacted = pruneAvailabilityManifest();
      window.localStorage?.setItem(AVAILABILITY_MANIFEST_KEY, JSON.stringify(compacted));
    } catch (err) {
      console.warn('P2P manifest save failed', err);
    }
  }

  // חלק איזון עומסים (p2p-video-sharing.js) – רישום זמינות ברקע עבור קבצים שנשלפו מה-cache | HYPER CORE TECH
  function scheduleBackgroundRegistration(hash, blob, mimeType) {
    if (!hash || !blob) {
      return;
    }
    queueMicrotask(() => {
      registerFileAvailability(hash, blob, mimeType).catch((err) => {
        console.warn('Background registerFileAvailability failed', err);
      });
    });
  }

  // חלק Network Tiers (p2p-video-sharing.js) – שליחת heartbeat להודעה על נוכחות ברשת | HYPER CORE TECH
  async function sendHeartbeat() {
    const relays = getP2PRelays();
    if (!relays.length || !App.pool || !App.publicKey) {
      return;
    }

    try {
      const event = {
        kind: FILE_AVAILABILITY_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'p2p-heartbeat'],
          ['t', 'p2p-heartbeat'],
          ['app', P2P_APP_TAG],
          ['expires', String(Date.now() + HEARTBEAT_INTERVAL * 3)] // תוקף ל-3 דקות
        ],
        content: JSON.stringify({ online: true, files: state.availableFiles.size })
      };

      const signedEvent = await window.nostrSignEvent(event);
      if (signedEvent) {
        const results = await Promise.allSettled(relays.map(relay => 
          App.pool.publish([relay], signedEvent)
        ));
        const success = results.filter(r => r.status === 'fulfilled').length;
        log('info', '💓 Heartbeat נשלח', { success, total: relays.length, files: state.availableFiles.size });
      } else {
        log('warn', '⚠️ Heartbeat: חתימה נכשלה');
      }
    } catch (err) {
      log('warn', '⚠️ Heartbeat נכשל', { error: err.message });
    }
  }

  // חלק Network Tiers (p2p-video-sharing.js) – ספירת peers פעילים ברשת | HYPER CORE TECH
  async function countActivePeers() {
    // בדיקת cache
    const now = Date.now();
    if (state.lastPeerCountTime && (now - state.lastPeerCountTime) < PEER_COUNT_CACHE_TTL) {
      log('info', '📊 משתמש בספירת peers מ-cache', { count: state.lastPeerCount });
      return state.lastPeerCount;
    }

    const relays = getP2PRelays();
    if (!relays.length || !App.pool) {
      log('info', 'ℹ️ אין ריליים או pool - מחזיר 0 peers');
      return 0;
    }

    const sinceTimestamp = Math.floor(Date.now() / 1000) - HEARTBEAT_LOOKBACK; // 2 דקות אחורה

    return new Promise((resolve) => {
      const uniquePeers = new Set();
      let finished = false;

      // חיפוש גם heartbeats וגם שיתופי קבצים
      const filters = [
        {
          kinds: [FILE_AVAILABILITY_KIND],
          '#t': ['p2p-heartbeat'],
          since: sinceTimestamp,
          limit: 50
        },
        {
          kinds: [FILE_AVAILABILITY_KIND],
          '#t': ['p2p-file'],
          since: sinceTimestamp,
          limit: 50
        }
      ];

      const timeout = setTimeout(() => {
        if (!finished) {
          finished = true;
          finalize();
        }
      }, 3000);

      const finalize = () => {
        const count = uniquePeers.size;
        state.lastPeerCount = count;
        state.lastPeerCountTime = Date.now();
        log('info', '📊 ספירת peers הושלמה', { count, peers: [...uniquePeers].map(p => p.slice(0, 8)) });
        resolve(count);
      };

      try {
        const sub = App.pool.subscribeMany(relays, filters, {
          onevent: (event) => {
            if (event.pubkey && event.pubkey !== App.publicKey) {
              uniquePeers.add(event.pubkey);
            }
          },
          oneose: () => {
            if (!finished) {
              finished = true;
              clearTimeout(timeout);
              sub?.close?.();
              finalize();
            }
          }
        });
      } catch (err) {
        log('error', '❌ שגיאה בספירת peers', { error: err.message });
        if (!finished) {
          finished = true;
          clearTimeout(timeout);
          resolve(0);
        }
      }
    });
  }

  // חלק Network Tiers (p2p-video-sharing.js) – זיהוי מצב הרשת לפי כמות peers | HYPER CORE TECH
  function getNetworkTier(peerCount) {
    if (peerCount <= NETWORK_TIER_BOOTSTRAP_MAX) {
      return 'BOOTSTRAP';
    }
    if (peerCount <= NETWORK_TIER_HYBRID_MAX) {
      return 'HYBRID';
    }
    return 'P2P_FULL';
  }

  // חלק Network Tiers (p2p-video-sharing.js) – עדכון מצב הרשת | HYPER CORE TECH
  async function updateNetworkTier() {
    const peerCount = await countActivePeers();
    const tier = getNetworkTier(peerCount);
    const prevTier = state.networkTier;
    state.networkTier = tier;

    if (prevTier !== tier) {
      log('info', `🌐 מצב רשת השתנה: ${prevTier} → ${tier}`, { peers: peerCount });
    }

    return { tier, peerCount };
  }

  // חלק Network Tiers (p2p-video-sharing.js) – Polling לבדיקת peers חדשים | HYPER CORE TECH
  const PEER_POLLING_INTERVAL = 30000; // בדיקה כל 30 שניות
  let peerPollingActive = false;

  function startPeerPolling() {
    if (peerPollingActive) return;
    peerPollingActive = true;
    
    log('info', '🔄 מתחיל polling לבדיקת peers חדשים כל 30 שניות');
    
    setInterval(async () => {
      // אפס את ה-cache כדי לקבל ספירה חדשה
      state.lastPeerCountTime = 0;
      const { tier, peerCount } = await updateNetworkTier();
      log('info', '🔄 Polling peers', { count: peerCount, tier });
    }, PEER_POLLING_INTERVAL);
  }

  // חלק Network Tiers (p2p-video-sharing.js) – פרסום קבצים עם השהייה למניעת הצפה | HYPER CORE TECH
  async function registerFilesSequentially(files) {
    if (!Array.isArray(files) || files.length === 0) {
      return { registered: 0, failed: 0 };
    }

    log('info', `📤 מתחיל פרסום ${files.length} קבצים עם השהייה...`);
    let registered = 0;
    let failed = 0;

    for (const file of files) {
      if (!file.hash || !file.blob) {
        failed++;
        continue;
      }

      try {
        await registerFileAvailability(file.hash, file.blob, file.mimeType || 'video/webm');
        registered++;
        log('success', `✅ פורסם קובץ ${registered}/${files.length}`, { hash: file.hash.slice(0, 16) });

        // המתנה בין פרסומים
        if (registered < files.length) {
          await sleep(AVAILABILITY_PUBLISH_DELAY);
        }
      } catch (err) {
        failed++;
        log('error', `❌ כשלון בפרסום קובץ`, { hash: file.hash?.slice(0, 16), error: err.message });
      }
    }

    log('info', `📊 סיכום פרסום: ${registered} הצליחו, ${failed} נכשלו`);
    return { registered, failed };
  }

  // חלק Network Tiers (p2p-video-sharing.js) – בדיקה אם להשתמש ב-Blossom לפי מצב הרשת | HYPER CORE TECH
  function shouldUseBlossom(postIndex, tier) {
    switch (tier) {
      case 'BOOTSTRAP':
        // משתמשים 1-3: כל הפוסטים מ-Blossom
        return true;
      case 'HYBRID':
        // משתמשים 4-10: רק 3 פוסטים ראשונים מ-Blossom
        return postIndex < HYBRID_BLOSSOM_POSTS;
      case 'P2P_FULL':
        // משתמש 11+: P2P בלבד (עם fallback אוטומטי)
        return false;
      default:
        // לא ידוע - נשתמש ב-Blossom לבטיחות
        return true;
    }
  }

  // חלק Network Tiers (p2p-video-sharing.js) – איפוס מונה כשלונות | HYPER CORE TECH
  function resetConsecutiveFailures() {
    state.consecutiveP2PFailures = 0;
  }

  // חלק Network Tiers (p2p-video-sharing.js) – הגדלת מונה כשלונות ובדיקה אם צריך fallback | HYPER CORE TECH
  function incrementFailuresAndCheckFallback() {
    state.consecutiveP2PFailures++;
    return state.consecutiveP2PFailures >= CONSECUTIVE_FAILURES_THRESHOLD;
  }

  // חלק P2P (p2p-video-sharing.js) – לוגים צבעוניים ומסודרים | HYPER CORE TECH
  // סטטיסטיקות גלובליות לסיכום
  const p2pStats = {
    downloads: { total: 0, fromCache: 0, fromBlossom: 0, fromP2P: 0, failed: 0 },
    shares: { total: 0, success: 0, failed: 0 },
    lastSummaryTime: 0
  };

  function log(type, message, data = null, options = {}) {
    const timestamp = new Date().toLocaleTimeString('he-IL');
    const icons = {
      upload: '📤', download: '📥', request: '📡', 
      peer: '👥', success: '✅', error: '❌', info: 'ℹ️'
    };
    const colors = {
      upload: '#4CAF50', download: '#2196F3', request: '#FF9800',
      peer: '#9C27B0', success: '#8BC34A', error: '#F44336', info: '#607D8B'
    };

    const { throttleKey, throttleMs = 3000, silent = false } = options;
    
    // Throttling
    if (throttleKey) {
      const entry = logState.throttle.get(throttleKey) || { lastLoggedAt: 0, suppressed: 0 };
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

    if (silent) return;

    const icon = icons[type] || 'ℹ️';
    const color = colors[type] || '#607D8B';
    
    // פורמט מקוצר ומסודר
    let logLine = `${icon} ${message}`;
    if (data) {
      const shortData = Object.entries(data)
        .map(([k, v]) => `${k}:${typeof v === 'string' && v.length > 20 ? v.slice(0,16)+'...' : v}`)
        .join(' | ');
      logLine += ` [${shortData}]`;
    }
    
    console.log(`%c${timestamp} ${logLine}`, `color: ${color}`);
  }

  // חלק P2P (p2p-video-sharing.js) – הדפסת סיכום סטטיסטיקות | HYPER CORE TECH
  function printP2PStats() {
    const { downloads, shares } = p2pStats;
    console.log('%c┌──────────────────────────────────────────────────┐', 'color: #673AB7; font-weight: bold');
    console.log('%c│           📊 סיכום מערכת P2P                     │', 'color: #673AB7; font-weight: bold');
    console.log('%c├──────────────────────────────────────────────────┤', 'color: #673AB7');
    console.log(`%c│ 📥 הורדות: ${downloads.total} סה"כ                              │`, 'color: #2196F3');
    console.log(`%c│    └─ Cache: ${downloads.fromCache} | Blossom: ${downloads.fromBlossom} | P2P: ${downloads.fromP2P} | נכשל: ${downloads.failed}`, 'color: #2196F3');
    console.log(`%c│ 📤 שיתופים: ${shares.total} סה"כ (${shares.success} הצליחו)       │`, 'color: #4CAF50');
    console.log('%c└──────────────────────────────────────────────────┘', 'color: #673AB7; font-weight: bold');
    p2pStats.lastSummaryTime = Date.now();
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

  // חלק P2P (p2p-video-sharing.js) – רישום קובץ כזמין עם השהייה | HYPER CORE TECH
  // תור רישום שיתופים - למניעת הצפה
  let shareQueue = [];
  let isProcessingShares = false;
  const SHARE_DELAY = 2000; // 2 שניות בין שיתופים

  async function processShareQueue() {
    if (isProcessingShares || shareQueue.length === 0) return;
    
    isProcessingShares = true;
    
    while (shareQueue.length > 0) {
      const { hash, blob, mimeType, resolve, reject } = shareQueue.shift();
      try {
        const result = await doRegisterFileAvailability(hash, blob, mimeType);
        resolve(result);
      } catch (err) {
        reject(err);
      }
      
      // השהייה של 2 שניות לפני השיתוף הבא
      if (shareQueue.length > 0) {
        await new Promise(r => setTimeout(r, SHARE_DELAY));
      }
    }
    
    isProcessingShares = false;
  }

  async function registerFileAvailability(hash, blob, mimeType) {
    // הוספה לתור במקום ביצוע מיידי
    return new Promise((resolve, reject) => {
      shareQueue.push({ hash, blob, mimeType, resolve, reject });
      processShareQueue();
    });
  }

  async function doRegisterFileAvailability(hash, blob, mimeType) {
    p2pStats.shares.total++;
    
    try {
      // שמירה מקומית
      state.availableFiles.set(hash, {
        blob, mimeType, size: blob.size, timestamp: Date.now(),
      });

      if (typeof App.pinCachedMedia === 'function') {
        try {
          await App.pinCachedMedia(hash, true);
        } catch (pinErr) { /* ignore */ }
      }

      // פרסום לרשת
      if (!App.pool || !App.publicKey || !App.privateKey) {
        p2pStats.shares.failed++;
        return false;
      }

      const now = Date.now();
      const manifestEntry = state.availabilityManifest?.[hash];
      if (manifestEntry && typeof manifestEntry.lastPublished === 'number') {
        if (now - manifestEntry.lastPublished < AVAILABILITY_MANIFEST_TTL) {
          state.lastAvailabilityPublish.set(hash, now);
          p2pStats.shares.success++;
          return true;
        }
      }

      const lastPublish = state.lastAvailabilityPublish.get(hash) || 0;
      if (now - lastPublish < AVAILABILITY_REPUBLISH_INTERVAL) {
        p2pStats.shares.success++;
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
          ['d', `${P2P_APP_TAG}:file:${hash}`],
          ['x', hash],
          ['t', 'p2p-file'],
          ['size', String(blob.size)],
          ['mime', mimeType],
          ['expires', String(expiresAt)],
        ],
        content: '',
      };

      const signed = App.finalizeEvent(event, App.privateKey);
      const relays = getP2PRelays();
      const publishResults = App.pool.publish(relays, signed);

      let successCount = 0;
      if (Array.isArray(publishResults)) {
        const results = await Promise.allSettled(publishResults);
        successCount = results.filter(r => r.status === 'fulfilled').length;
        
        // לוג מקוצר - שורה אחת לשיתוף
        log('upload', `שיתוף קובץ`, { 
          hash: hash.slice(0,12), 
          relays: `${successCount}/${relays.length}` 
        });

        if (successCount === 0) {
          p2pStats.shares.failed++;
          return false;
        }
      } else if (publishResults?.then) {
        await publishResults;
        successCount = 1;
        log('upload', `שיתוף קובץ`, { hash: hash.slice(0,12), relays: '1/1' });
      } else {
        successCount = 1;
      }

      state.lastAvailabilityPublish.set(hash, Date.now());
      state.availabilityManifest[hash] = {
        lastPublished: Date.now(),
        size: blob.size,
        mimeType,
      };
      saveAvailabilityManifest();
      p2pStats.shares.success++;

      return true;
    } catch (err) {
      p2pStats.shares.failed++;
      log('error', `שיתוף נכשל`, { hash: hash.slice(0,12), error: err.message });
      return false;
    }
  }

  // חלק P2P (p2p-video-sharing.js) – חיפוש peers עם קובץ
  async function findPeersWithFile(hash) {
    return new Promise((resolve) => {
      const relays = getP2PRelays();
      const sinceTimestamp = Math.floor(Date.now() / 1000) - PEER_DISCOVERY_LOOKBACK;

      const peers = new Set();
      const filters = [{
        kinds: [FILE_AVAILABILITY_KIND],
        '#t': ['p2p-file'],
        '#x': [hash],
        since: sinceTimestamp,
      }];

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
        state.pendingIceCandidates.delete(connectionId);
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

      const { content: wireContent, encrypted } = await prepareSignalContent(content, peerPubkey);

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
        content: wireContent,
      };

      if (encrypted) {
        event.tags.push(['enc', 'nip04']);
      }

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
            const decodedContent = await extractSignalContent(event.content, event.pubkey);
            const message = JSON.parse(decodedContent);

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

      // חלק WebRTC (p2p-video-sharing.js) – הוספת ICE candidates שנשמרו עד לקבלת answer | HYPER CORE TECH
      const bufferedCandidates = state.pendingIceCandidates.get(connectionId);
      if (Array.isArray(bufferedCandidates) && bufferedCandidates.length) {
        for (const buffered of bufferedCandidates) {
          try {
            await pc.addIceCandidate(buffered);
            log('success', '✅ ICE candidate שנשמר נוסף לאחר קבלת answer');
          } catch (candidateErr) {
            log('error', `❌ כשלון בהוספת ICE candidate מה-buffer: ${candidateErr.message}`);
          }
        }
        state.pendingIceCandidates.delete(connectionId);
      }
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
    if (!pc || !candidate) {
      log('info', 'ℹ️ אין חיבור פעיל עבור ה-candidate – מתעלם');
      return;
    }

    if (pc.connectionState === 'closed' || pc.iceConnectionState === 'closed') {
      log('info', 'ℹ️ החיבור כבר נסגר – מתעלם מה-candidate', { connectionId });
      return;
    }

    const rtcCandidate = new RTCIceCandidate(candidate);

    if (!pc.currentRemoteDescription) {
      const queue = state.pendingIceCandidates.get(connectionId) || [];
      queue.push(rtcCandidate);
      state.pendingIceCandidates.set(connectionId, queue);
      log('info', '🧊 ICE candidate נשמר בהמתנה עד לקבלת answer', {
        bufferedCount: queue.length,
        connectionId
      });
      return;
    }

    try {
      await pc.addIceCandidate(rtcCandidate);
      log('success', `✅ ICE candidate נוסף בהצלחה`);
    } catch (err) {
      log('error', `❌ כשלון בהוספת ICE candidate: ${err.message}`);
    }
  }

  // חלק P2P (p2p-video-sharing.js) – הורדת וידאו עם fallback ואסטרטגיית Network Tiers | HYPER CORE TECH
  async function downloadVideoWithP2P(url, hash, mimeType = 'video/webm', options = {}) {
    const queueKey = hash || url;
    return runExclusiveDownload(queueKey, async () => {
      let releaseSlot;
      // חלק איזון עומסים (p2p-video-sharing.js) – הקצאת משבצת רק כשעוברים לרשת | HYPER CORE TECH
      const ensureSlot = async () => {
        if (!releaseSlot) {
          releaseSlot = await acquireDownloadSlot(hash || url);
        }
        return releaseSlot;
      };

      // חלק Network Tiers (p2p-video-sharing.js) – קבלת מצב רשת ואינדקס פוסט | HYPER CORE TECH
      const postIndex = typeof options.postIndex === 'number' ? options.postIndex : 0;
      const { tier } = await updateNetworkTier();
      const forceBlossom = shouldUseBlossom(postIndex, tier);

      log('download', `🎬 מתחיל הורדת וידאו`, {
        url: url.slice(0, 50) + '...',
        hash: hash ? hash.slice(0, 16) + '...' : 'אין hash',
        tier,
        postIndex,
        forceBlossom
      });

      try {
        // אם אין hash - הורדה רגילה
        if (!hash) {
          await ensureSlot();
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

        // בדיקת cache מקומי
        p2pStats.downloads.total++;
        if (typeof App.getCachedMedia === 'function') {
          const cached = await App.getCachedMedia(hash);
          if (cached && cached.blob) {
            p2pStats.downloads.fromCache++;
            log('success', `מ-Cache`, { hash: hash.slice(0,12), size: Math.round(cached.blob.size/1024)+'KB' });
            scheduleBackgroundRegistration(hash, cached.blob, cached.mimeType || mimeType);
            resetConsecutiveFailures();
            return { blob: cached.blob, source: 'cache' };
          }
        }

        await ensureSlot();

        // חלק Network Tiers - אסטרטגיית טעינה לפי מצב הרשת
        if (forceBlossom) {
          try {
            // ניסיון ראשון עם fetch רגיל
            let blob;
            try {
              const response = await fetch(url, { mode: 'cors' });
              blob = await response.blob();
            } catch (corsErr) {
              // CORS נכשל - ננסה לטעון דרך video element
              log('info', `CORS חסום, מנסה video element`, { url: url.substring(0, 30) + '...' });
              blob = await fetchViaVideoElement(url, mimeType);
            }
            p2pStats.downloads.fromBlossom++;
            log('success', `מ-Blossom [${tier}]`, { post: postIndex+1, size: Math.round(blob.size/1024)+'KB' });
            if (typeof App.cacheMedia === 'function') {
              await App.cacheMedia(url, hash, blob, mimeType, { pinned: true });
            }
            scheduleBackgroundRegistration(hash, blob, mimeType);
            resetConsecutiveFailures();
            return { blob, source: 'blossom', tier };
          } catch (err) {
            p2pStats.downloads.failed++;
            log('error', `Blossom נכשל`, { error: err.message });
            throw err;
          }
        }

        // P2P_FULL או HYBRID
        const rawPeers = await findPeersWithFile(hash);
        const peers = Array.isArray(rawPeers) ? [...rawPeers] : [];

        if (peers.length === 0) {
          try {
            const response = await fetch(url);
            const blob = await response.blob();
            p2pStats.downloads.fromBlossom++;
            log('success', `מ-URL (0 peers)`, { size: Math.round(blob.size/1024)+'KB' });
            if (typeof App.cacheMedia === 'function') {
              await App.cacheMedia(url, hash, blob, mimeType, { pinned: true });
            }
            await registerFileAvailability(hash, blob, mimeType);
            resetConsecutiveFailures();
            return { blob, source: 'url' };
          } catch (err) {
            p2pStats.downloads.failed++;
            throw err;
          }
        }

        // ניסיון P2P
        let attemptCount = 0;
        for (const peer of peers) {
          if (MAX_PEER_ATTEMPTS_PER_FILE > 0 && attemptCount >= MAX_PEER_ATTEMPTS_PER_FILE) break;
          attemptCount++;
          
          try {
            const downloadPromise = downloadFromPeer(peer, hash);
            const timeoutPromise = sleep(INITIAL_LOAD_TIMEOUT).then(() => {
              throw new Error('timeout');
            });
            const result = await Promise.race([downloadPromise, timeoutPromise]);

            p2pStats.downloads.fromP2P++;
            log('success', `מ-P2P`, { peer: peer.slice(0,8), size: Math.round(result.blob.size/1024)+'KB' });

            if (typeof App.cacheMedia === 'function') {
              await App.cacheMedia(url, hash, result.blob, result.mimeType, { pinned: true });
            }
            await registerFileAvailability(hash, result.blob, result.mimeType);
            resetConsecutiveFailures();
            return { blob: result.blob, source: 'p2p', peer, tier };

          } catch (err) {
            if (incrementFailuresAndCheckFallback()) break;
            continue;
          }
        }

        // Fallback ל-Blossom
        try {
          const response = await fetch(url);
          const blob = await response.blob();
          p2pStats.downloads.fromBlossom++;
          log('success', `Fallback Blossom`, { size: Math.round(blob.size/1024)+'KB' });
          if (typeof App.cacheMedia === 'function') {
            await App.cacheMedia(url, hash, blob, mimeType, { pinned: true });
          }
          await registerFileAvailability(hash, blob, mimeType);
          return { blob, source: 'blossom-fallback', tier };
        } catch (err) {
          p2pStats.downloads.failed++;
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
    // חלק Network Tiers (p2p-video-sharing.js) – API חדש לניהול מצב רשת | HYPER CORE TECH
    countActivePeers,                    // ספירת peers פעילים
    getNetworkTier,                      // קבלת tier לפי מספר peers
    updateNetworkTier,                   // עדכון מצב הרשת
    registerFilesSequentially,           // פרסום קבצים עם השהייה
    shouldUseBlossom,                    // בדיקה אם להשתמש ב-Blossom
    startPeerPolling,                    // הפעלת polling לבדיקת peers
    sendHeartbeat,                       // שליחת heartbeat ידנית
    p2pGetNetworkState: () => ({         // קבלת מצב רשת נוכחי
      tier: state.networkTier,
      peerCount: state.lastPeerCount,
      lastUpdate: state.lastPeerCountTime,
      consecutiveFailures: state.consecutiveP2PFailures,
    }),
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
        
        // שליחת heartbeat ראשון והפעלת interval
        sendHeartbeat();
        setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
        
        // הפעלת polling לבדיקת peers חדשים
        startPeerPolling();
        
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
    _p2pSignalsSub: null,
    // חלק Network Tiers - API לסטטיסטיקות | HYPER CORE TECH
    getP2PStats: () => ({ ...p2pStats }),
    printP2PStats,
  });

})(window);
