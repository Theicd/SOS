(function initP2PVideoSharing(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק Guest P2P (p2p-video-sharing.js) – יצירת מפתח זמני לאורחים | HYPER CORE TECH
  const GUEST_KEY_STORAGE = 'p2p_guest_keys';
  let guestKeys = null;
  
  function getOrCreateGuestKeys() {
    if (guestKeys) return guestKeys;
    
    // ניסיון לטעון מפתח קיים מ-localStorage
    try {
      const stored = localStorage.getItem(GUEST_KEY_STORAGE);
      if (stored) {
        const parsed = JSON.parse(stored);
        // בדיקה שהמפתח לא פג תוקף (7 ימים)
        if (parsed.created && Date.now() - parsed.created < 7 * 24 * 60 * 60 * 1000) {
          guestKeys = parsed;
          return guestKeys;
        }
      }
    } catch (e) {}
    
    // יצירת מפתח חדש
    try {
      // שימוש ב-nostr-tools אם זמין
      if (window.NostrTools && window.NostrTools.generateSecretKey) {
        const sk = window.NostrTools.generateSecretKey();
        const pk = window.NostrTools.getPublicKey(sk);
        guestKeys = {
          privateKey: Array.from(sk).map(b => b.toString(16).padStart(2, '0')).join(''),
          publicKey: pk,
          created: Date.now(),
          isGuest: true
        };
      } else {
        // Fallback - יצירת מפתח פשוט
        const randomBytes = new Uint8Array(32);
        crypto.getRandomValues(randomBytes);
        guestKeys = {
          privateKey: Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join(''),
          publicKey: 'guest_' + Array.from(randomBytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(''),
          created: Date.now(),
          isGuest: true
        };
      }
      
      // שמירה ב-localStorage
      localStorage.setItem(GUEST_KEY_STORAGE, JSON.stringify(guestKeys));
      console.log('%c🔑 P2P: נוצר מפתח אורח זמני', 'color: #FF9800');
      return guestKeys;
    } catch (e) {
      console.warn('P2P: לא ניתן ליצור מפתח אורח', e);
      return null;
    }
  }
  
  function isGuestMode() {
    return !App.publicKey || !App.privateKey;
  }
  
  function getEffectiveKeys() {
    if (App.publicKey && App.privateKey) {
      return { publicKey: App.publicKey, privateKey: App.privateKey, isGuest: false };
    }
    const guest = getOrCreateGuestKeys();
    return guest || { publicKey: null, privateKey: null, isGuest: true };
  }

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
  const P2P_VERSION = '2.14.0-persistent-priority'; // תג לזיהוי האפליקציה
  const P2P_APP_TAG = 'sos-p2p-video'; // תג לזיהוי אירועי P2P של האפליקציה
  const SIGNAL_ENCRYPTION_ENABLED = window.NostrP2P_SIGNAL_ENCRYPTION === true; // חלק סיגנלים (p2p-video-sharing.js) – קונפיגורציה להצפנת סיגנלים | HYPER CORE TECH
  const AVAILABILITY_EXPIRY = 24 * 60 * 60 * 1000; // 24 שעות - כדי שהקובץ יהיה זמין לאורך זמן
  const AVAILABILITY_REPUBLISH_INTERVAL = 2 * 60 * 1000; // דקהיים קירור
  const AVAILABILITY_MANIFEST_KEY = 'p2pAvailabilityManifest';
  const AVAILABILITY_MANIFEST_TTL = 7 * 24 * 60 * 60 * 1000; // לא לפרסם מחדש את אותו hash במשך 7 ימים
  const AVAILABILITY_RATE_WINDOW_MS = 5000;
  const MAX_AVAILABILITY_EVENTS_PER_WINDOW = 5;
  const SIGNAL_RATE_WINDOW_MS = 1000;
  const MAX_SIGNALS_PER_WINDOW = 3;
  const PEER_DISCOVERY_TIMEOUT = window.NostrP2P_PEER_DISCOVERY_TIMEOUT || 10000; // 10 שניות לחיפוש peers
  const PEER_DISCOVERY_LOOKBACK = 24 * 60 * 60; // 24 שעות אחורה - כדי למצוא peers גם אם פרסמו מוקדם יותר
  const CHUNK_SIZE = 16384; // 16KB chunks
  const BLOCKED_RELAY_URLS = new Set((window.NostrP2P_BLOCKED_RELAYS || ['wss://nos.lol', 'wss://nostr-02.uid.ovh']));
  // זיהוי מובייל להתאמת משאבים
  const IS_MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  
  const MAX_CONCURRENT_P2P_TRANSFERS =
    typeof window.NostrP2P_MAX_CONCURRENT_TRANSFERS === 'number'
      ? window.NostrP2P_MAX_CONCURRENT_TRANSFERS
      : (IS_MOBILE ? 2 : 3); // מובייל: 2, דסקטופ: 3
  const MAX_PEER_ATTEMPTS_PER_FILE =
    typeof window.NostrP2P_MAX_PEER_ATTEMPTS === 'number'
      ? window.NostrP2P_MAX_PEER_ATTEMPTS
      : 5; // ננסה עד 5 peers לפני fallback
  const MAX_DOWNLOAD_TIMEOUT = window.NostrP2P_DOWNLOAD_TIMEOUT || 15000; // 15 שניות - מהיר יותר לעבור ל-fallback | HYPER CORE TECH
  const ANSWER_TIMEOUT = window.NostrP2P_ANSWER_TIMEOUT || 4000; // 4 שניות לתשובה - מהיר יותר | HYPER CORE TECH
  const ANSWER_RETRY_LIMIT = window.NostrP2P_ANSWER_RETRY_LIMIT || 1; // ניסיון אחד בלבד - עוברים ל-peer הבא מהר
  const ANSWER_RETRY_DELAY = window.NostrP2P_ANSWER_RETRY_DELAY || 500; // חצי שנייה בין ניסיונות

  // חלק Network Tiers (p2p-video-sharing.js) – אסטרטגיית טעינה מותאמת לפי כמות משתמשים | HYPER CORE TECH
  const NETWORK_TIER_BOOTSTRAP_MAX = 1;   // משתמשים 1: כל הפוסטים מ-Blossom, משתמש 2+ (שרואה peer אחד) מנסה P2P
  const NETWORK_TIER_HYBRID_MAX = 10;     // משתמשים 4-10: 3 אחרונים מ-Blossom, שאר P2P
  const HYBRID_BLOSSOM_POSTS = 5;         // כמות פוסטים לטעון מ-Blossom במצב Hybrid
  const INITIAL_LOAD_TIMEOUT = 5000;      // 5 שניות timeout לטעינה ראשונית
  const AVAILABILITY_PUBLISH_DELAY = 2000; // 2 שניות המתנה בין פרסומי זמינות
  const PEER_COUNT_CACHE_TTL = 30000;     // 30 שניות cache לספירת peers
  const CONSECUTIVE_FAILURES_THRESHOLD = 5; // כמות כשלונות ברצף לפני fallback - מאפשר לנסות יותר peers
  // חלק Adaptive Heartbeat (p2p-video-sharing.js) – תדירות דינמית לפי גודל רשת | HYPER CORE TECH
  const HEARTBEAT_INTERVALS = {
    BOOTSTRAP: 30000,   // רשת קטנה (1-3 peers): כל 30 שניות - צריך גילוי מהיר
    HYBRID: 60000,      // רשת בינונית (4-10 peers): כל דקה
    P2P_FULL: 120000    // רשת גדולה (10+ peers): כל 2 דקות - פחות עומס
  };
  let HEARTBEAT_INTERVAL = 60000;         // ברירת מחדל - יתעדכן דינמית
  const HEARTBEAT_LOOKBACK = 180;         // חיפוש heartbeats מ-3 דקות אחורה (מותאם ל-P2P_FULL)
  
  // חלק Guest P2P (p2p-video-sharing.js) – הגדרות אופטימיזציה לאורחים | HYPER CORE TECH
  const GUEST_BLOSSOM_FIRST_POSTS = 10;   // אורחים: 10 פוסטים ראשונים תמיד מ-Blossom (חוויה מהירה)
  const GUEST_P2P_TIMEOUT = 8000;         // timeout ל-P2P לאורחים (8 שניות - מספיק ל-WebRTC handshake)
  const GUEST_MAX_PEER_SEARCH_TIME = 5000; // זמן מקסימלי לחיפוש peers לאורחים (5 שניות)
  const GUEST_MAX_PEERS_TO_TRY = 2;       // אורחים ינסו רק 2 peers לפני fallback

  // חלק P2P (p2p-video-sharing.js) – WebRTC config עם תמיכה מלאה ב-Safari/iOS | HYPER CORE TECH
  const RTC_CONFIG = Array.isArray(window.NostrRTC_ICE) && window.NostrRTC_ICE.length
    ? { iceServers: window.NostrRTC_ICE, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' }
    : {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:stun3.l.google.com:19302' },
          // TURN servers חינמיים לשיפור חיבוריות (במיוחד למובייל ו-Safari)
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          },
          {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          },
          // TURN עם TCP עבור רשתות מוגבלות (Safari/iOS)
          {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          }
        ],
        iceCandidatePoolSize: 10,
        bundlePolicy: 'max-bundle', // חלק תאימות Safari – מאחד את כל ה-streams לחיבור אחד | HYPER CORE TECH
        rtcpMuxPolicy: 'require'    // חלק תאימות Safari – דורש RTCP multiplexing | HYPER CORE TECH
      };

  // חלק P2P (p2p-video-sharing.js) – מצב המערכת
  const state = {
    availableFiles: new Map(), // hash -> { blob, mimeType, size, timestamp }
    lastAvailabilityPublish: new Map(), // hash -> timestamp
    activePeers: new Map(), // hash -> Set(pubkeys)
    activeConnections: new Map(), // connectionId -> RTCPeerConnection
    pendingConnections: new Map(), // connectionId -> { pc, timeout }
    // חלק Persistent Connections (p2p-video-sharing.js) – שמירת חיבורים פעילים לשימוש חוזר | HYPER CORE TECH
    persistentPeers: new Map(), // peerPubkey -> { pc, channel, lastUsed, filesTransferred }
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
    // מעקב מהירויות בזמן אמת
    activeDownload: null,             // { hash, peers, startTime, bytesReceived, speed }
    activeUpload: null,               // { hash, startTime, bytesSent, speed }
    activeUploadCount: 0,             // כמה העלאות פעילות כרגע
    // מעקב העלאות ממתינות לאישור - מנורה מהבהבת עד שמישהו הוריד
    pendingUploads: new Map(),        // hash -> { timestamp, confirmed: false }
    uploadListeners: new Set(),       // callbacks לעדכון UI כשהעלאה אושרה
    // חלק Leader Election (p2p-video-sharing.js) – מניעת כפילויות בין לשוניות | HYPER CORE TECH
    isLeader: false,                  // האם הלשונית הזו היא המנהיגה
    tabId: Math.random().toString(36).substr(2, 9), // מזהה ייחודי ללשונית
  };
  
  // חלק Leader Election (p2p-video-sharing.js) – BroadcastChannel לתקשורת בין לשוניות | HYPER CORE TECH
  const LEADER_CHANNEL_NAME = 'sos-p2p-leader';
  const LEADER_HEARTBEAT_INTERVAL = 2000; // 2 שניות
  const LEADER_TIMEOUT = 5000; // 5 שניות בלי heartbeat = המנהיג מת
  let leaderChannel = null;
  let lastLeaderHeartbeat = 0;
  let leaderHeartbeatTimer = null;
  let leaderCheckTimer = null;
  
  function setupLeaderElection() {
    try {
      leaderChannel = new BroadcastChannel(LEADER_CHANNEL_NAME);
      
      leaderChannel.onmessage = (event) => {
        const { type, tabId, timestamp } = event.data;
        
        if (type === 'leader-heartbeat' && tabId !== state.tabId) {
          // יש מנהיג אחר - אנחנו לא המנהיג
          lastLeaderHeartbeat = timestamp;
          if (state.isLeader) {
            // היינו מנהיגים אבל מישהו אחר לקח - נוותר
            state.isLeader = false;
            log('info', '👑➡️ ויתרנו על מנהיגות ללשונית אחרת');
            stopLeaderDuties();
          }
        } else if (type === 'leader-claim' && tabId !== state.tabId) {
          // מישהו מנסה להיות מנהיג
          if (state.isLeader) {
            // אנחנו כבר מנהיגים - נשלח heartbeat מיידי
            sendLeaderHeartbeat();
          }
        } else if (type === 'leader-resign' && tabId !== state.tabId) {
          // המנהיג התפטר - ננסה לקחת
          setTimeout(() => tryBecomeLeader(), Math.random() * 500);
        }
      };
      
      // ניסיון ראשון להיות מנהיג
      setTimeout(() => tryBecomeLeader(), Math.random() * 1000);
      
      // בדיקה תקופתית אם המנהיג עדיין חי
      leaderCheckTimer = setInterval(() => {
        if (!state.isLeader && Date.now() - lastLeaderHeartbeat > LEADER_TIMEOUT) {
          // המנהיג מת - ננסה לקחת
          log('info', '💀 המנהיג לא מגיב - מנסה לקחת מנהיגות');
          tryBecomeLeader();
        }
      }, LEADER_TIMEOUT / 2);
      
      // כשהלשונית נסגרת - נתפטר
      window.addEventListener('beforeunload', () => {
        if (state.isLeader && leaderChannel) {
          leaderChannel.postMessage({ type: 'leader-resign', tabId: state.tabId, timestamp: Date.now() });
        }
      });
      
      log('info', '📡 Leader Election מופעל', { tabId: state.tabId });
    } catch (err) {
      // BroadcastChannel לא נתמך - נהיה מנהיג אוטומטית
      log('warn', '⚠️ BroadcastChannel לא נתמך - מפעיל P2P ללא תיאום');
      state.isLeader = true;
    }
  }
  
  function tryBecomeLeader() {
    if (state.isLeader) return;
    
    // שולחים הודעת claim
    if (leaderChannel) {
      leaderChannel.postMessage({ type: 'leader-claim', tabId: state.tabId, timestamp: Date.now() });
    }
    
    // ממתינים קצת לראות אם מישהו מתנגד
    setTimeout(() => {
      if (!state.isLeader && Date.now() - lastLeaderHeartbeat > LEADER_TIMEOUT) {
        // אף אחד לא מנהיג - אנחנו לוקחים
        state.isLeader = true;
        log('success', '👑 הלשונית הזו היא המנהיגה!', { tabId: state.tabId });
        startLeaderDuties();
      }
    }, 500);
  }
  
  function sendLeaderHeartbeat() {
    if (!state.isLeader || !leaderChannel) return;
    leaderChannel.postMessage({ type: 'leader-heartbeat', tabId: state.tabId, timestamp: Date.now() });
  }
  
  function startLeaderDuties() {
    // שליחת heartbeat תקופתי
    sendLeaderHeartbeat();
    leaderHeartbeatTimer = setInterval(sendLeaderHeartbeat, LEADER_HEARTBEAT_INTERVAL);
  }
  
  function stopLeaderDuties() {
    if (leaderHeartbeatTimer) {
      clearInterval(leaderHeartbeatTimer);
      leaderHeartbeatTimer = null;
    }
  }
  
  // בדיקה אם מותר לבצע פעולות P2P (רק למנהיג)
  function isP2PAllowed() {
    return state.isLeader;
  }

  const logState = {
    throttle: new Map(),
    downloadProgress: new Map(),
  };

  // חלק Background (p2p-video-sharing.js) – מנגנון לשמירה על פעילות ברקע | HYPER CORE TECH
  // כשהדף ברקע, הדפדפן מאט את setInterval. נשתמש ב-Web Worker לשמירה על heartbeat
  let backgroundWorker = null;
  let isPageVisible = true;
  
  // יצירת Web Worker inline לשמירה על פעילות ברקע
  function createBackgroundWorker() {
    const workerCode = `
      let heartbeatInterval = null;
      
      self.onmessage = function(e) {
        if (e.data.type === 'start') {
          if (heartbeatInterval) clearInterval(heartbeatInterval);
          heartbeatInterval = setInterval(() => {
            self.postMessage({ type: 'heartbeat' });
          }, e.data.interval || 60000);
        } else if (e.data.type === 'stop') {
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
          }
        }
      };
    `;
    
    try {
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const worker = new Worker(URL.createObjectURL(blob));
      
      worker.onmessage = function(e) {
        if (e.data.type === 'heartbeat' && !isPageVisible) {
          // שליחת heartbeat כשהדף ברקע
          sendHeartbeat();
        }
      };
      
      return worker;
    } catch (err) {
      console.warn('P2P: לא ניתן ליצור Web Worker לרקע', err);
      return null;
    }
  }
  
  // מעקב אחרי מצב הדף (visible/hidden)
  function setupVisibilityTracking() {
    document.addEventListener('visibilitychange', () => {
      isPageVisible = document.visibilityState === 'visible';
      
      if (isPageVisible) {
        // הדף חזר לפוקוס - נשלח heartbeat מיידי ונעצור את ה-worker
        log('info', '👁️ הדף חזר לפוקוס - שולח heartbeat');
        sendHeartbeat();
        if (backgroundWorker) {
          backgroundWorker.postMessage({ type: 'stop' });
        }
      } else {
        // הדף עבר לרקע - נפעיל את ה-worker
        log('info', '🌙 הדף ברקע - מפעיל heartbeat ברקע');
        if (!backgroundWorker) {
          backgroundWorker = createBackgroundWorker();
        }
        if (backgroundWorker) {
          backgroundWorker.postMessage({ type: 'start', interval: HEARTBEAT_INTERVAL });
        }
      }
    });
    
    // ניסיון להשתמש ב-Page Lifecycle API אם זמין
    if ('onfreeze' in document) {
      document.addEventListener('freeze', () => {
        log('info', '❄️ הדף הוקפא - שולח heartbeat אחרון');
        sendHeartbeat();
      });
      
      document.addEventListener('resume', () => {
        log('info', '🔥 הדף התעורר - שולח heartbeat');
        sendHeartbeat();
      });
    }
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
        // הגבלת גודל התור - מותאם למכשיר
        const MAX_PENDING_TRANSFERS = IS_MOBILE ? 10 : 30;
        if (state.pendingTransferResolvers.length >= MAX_PENDING_TRANSFERS) {
          log('warn', '⚠️ תור הורדות מלא - דוחה בקשה', {
            label: label?.slice?.(0, 16) || 'unknown',
            queueLength: state.pendingTransferResolvers.length,
          });
          resolve(null); // מחזיר null במקום פונקציית שחרור
          return;
        }
        
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

  // חלק Service Worker Coordinator (p2p-video-sharing.js) – תיאום heartbeat דרך SW | HYPER CORE TECH
  let swCoordinatorEnabled = false;
  
  async function requestHeartbeatFromSW() {
    if (!navigator.serviceWorker?.controller) return { shouldSend: true };
    
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ shouldSend: true }), 2000);
      
      const handler = (event) => {
        if (event.data?.type === 'p2p-heartbeat-approved') {
          clearTimeout(timeout);
          navigator.serviceWorker.removeEventListener('message', handler);
          resolve(event.data);
        }
      };
      
      navigator.serviceWorker.addEventListener('message', handler);
      navigator.serviceWorker.controller.postMessage({
        type: 'p2p-heartbeat-request',
        networkTier: state.networkTier,
        heartbeatInterval: HEARTBEAT_INTERVAL,
        peerCount: state.lastPeerCount
      });
    });
  }

  function notifyHeartbeatDone(success, peerCount) {
    if (!navigator.serviceWorker?.controller) return;
    try {
      navigator.serviceWorker.controller.postMessage({
        type: 'p2p-heartbeat-done',
        success,
        peerCount
      });
    } catch {}
  }

  // חלק Network Tiers (p2p-video-sharing.js) – שליחת heartbeat להודעה על נוכחות ברשת | HYPER CORE TECH
  async function sendHeartbeat() {
    // רק המנהיג שולח heartbeats לרשת
    if (!isP2PAllowed()) {
      return;
    }
    
    // חלק SW Coordinator – בדיקה מול Service Worker אם צריך לשלוח | HYPER CORE TECH
    if (swCoordinatorEnabled && navigator.serviceWorker?.controller) {
      const approval = await requestHeartbeatFromSW();
      if (!approval.shouldSend) {
        log('info', '💓 Heartbeat דולג (SW coordinator)', { waitMs: approval.waitMs });
        return;
      }
    }
    
    const relays = getP2PRelays();
    const keys = getEffectiveKeys();
    
    if (!relays.length || !App.pool || !keys.publicKey || !keys.privateKey) {
      return;
    }

    try {
      const event = {
        kind: FILE_AVAILABILITY_KIND,
        pubkey: keys.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'p2p-heartbeat'],
          ['t', 'p2p-heartbeat'],
          ['app', P2P_APP_TAG],
          ['expires', String(Date.now() + HEARTBEAT_INTERVAL * 3)], // תוקף ל-3 דקות
          keys.isGuest ? ['guest', 'true'] : null // סימון אורח
        ].filter(Boolean),
        content: JSON.stringify({ online: true, files: state.availableFiles.size, isGuest: keys.isGuest })
      };

      // שימוש ב-App.finalizeEvent או חתימה ידנית לאורחים
      let signedEvent;
      if (App.finalizeEvent) {
        signedEvent = App.finalizeEvent(event, keys.privateKey);
      } else if (window.NostrTools && window.NostrTools.finalizeEvent) {
        signedEvent = window.NostrTools.finalizeEvent(event, keys.privateKey);
      }
      
      if (signedEvent) {
        const results = await Promise.allSettled(relays.map(relay => 
          App.pool.publish([relay], signedEvent)
        ));
        const success = results.filter(r => r.status === 'fulfilled').length;
        log('info', '💓 Heartbeat נשלח', { success, total: relays.length, files: state.availableFiles.size, isGuest: keys.isGuest });
        // חלק SW Coordinator – עדכון ה-SW שהשליחה הושלמה | HYPER CORE TECH
        notifyHeartbeatDone(true, state.lastPeerCount);
      } else {
        log('warn', '⚠️ Heartbeat: חתימה נכשלה');
        notifyHeartbeatDone(false, state.lastPeerCount);
      }
    } catch (err) {
      log('warn', '⚠️ Heartbeat נכשל', { error: err.message });
      notifyHeartbeatDone(false, state.lastPeerCount);
    }
  }

  // חלק Network Tiers (p2p-video-sharing.js) – ספירת peers פעילים ברשת | HYPER CORE TECH
  // חלק Peer Sampling – דגימה חכמה במקום ספירה מלאה לחיסכון בעומס | HYPER CORE TECH
  const PEER_SAMPLE_SIZE = 30; // דגימה של עד 30 peers - מספיק להערכה
  const PEER_COUNT_ESTIMATION_THRESHOLD = 25; // אם יש יותר מ-25 - נעריך במקום לספור
  
  async function countActivePeers() {
    // בדיקת cache
    const now = Date.now();
    if (state.lastPeerCountTime && (now - state.lastPeerCountTime) < PEER_COUNT_CACHE_TTL) {
      return state.lastPeerCount;
    }

    const relays = getP2PRelays();
    if (!relays.length || !App.pool) {
      return 0;
    }

    const sinceTimestamp = Math.floor(Date.now() / 1000) - HEARTBEAT_LOOKBACK;

    return new Promise((resolve) => {
      const uniquePeers = new Set();
      let finished = false;
      let totalEventsReceived = 0;

      // חלק Peer Sampling – הגבלת limit לדגימה | HYPER CORE TECH
      const filters = [
        {
          kinds: [FILE_AVAILABILITY_KIND],
          '#t': ['p2p-heartbeat'],
          since: sinceTimestamp,
          limit: PEER_SAMPLE_SIZE
        },
        {
          kinds: [FILE_AVAILABILITY_KIND],
          '#t': ['p2p-file'],
          since: sinceTimestamp,
          limit: PEER_SAMPLE_SIZE
        }
      ];

      const timeout = setTimeout(() => {
        if (!finished) {
          finished = true;
          finalize();
        }
      }, 2500); // timeout קצר יותר

      const finalize = () => {
        let count = uniquePeers.size;
        
        // חלק Peer Estimation – אם קיבלנו הרבה אירועים, נעריך שיש יותר peers | HYPER CORE TECH
        if (count >= PEER_COUNT_ESTIMATION_THRESHOLD && totalEventsReceived >= PEER_SAMPLE_SIZE * 1.5) {
          // אקסטרפולציה: אם בדגימה של 30 מצאנו 25 ייחודיים, כנראה יש יותר
          const estimatedMultiplier = Math.min(2, totalEventsReceived / PEER_SAMPLE_SIZE);
          count = Math.round(count * estimatedMultiplier);
          log('info', '📊 הערכת peers (sampling)', { sampled: uniquePeers.size, estimated: count, events: totalEventsReceived });
        } else {
          log('info', '📊 ספירת peers', { count, events: totalEventsReceived });
        }
        
        state.lastPeerCount = count;
        state.lastPeerCountTime = Date.now();
        resolve(count);
      };

      try {
        const keys = getEffectiveKeys();
        const myPubkey = keys.publicKey;
        
        const sub = App.pool.subscribeMany(relays, filters, {
          onevent: (event) => {
            totalEventsReceived++;
            if (event.pubkey && event.pubkey !== myPubkey) {
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
      // חלק Adaptive Heartbeat – עדכון תדירות heartbeat לפי הטייר | HYPER CORE TECH
      const newInterval = HEARTBEAT_INTERVALS[tier] || 60000;
      if (HEARTBEAT_INTERVAL !== newInterval) {
        HEARTBEAT_INTERVAL = newInterval;
        log('info', `💓 תדירות heartbeat עודכנה: ${newInterval / 1000} שניות`, { tier });
        // עדכון ה-background worker אם פעיל
        if (backgroundWorker && !isPageVisible) {
          backgroundWorker.postMessage({ type: 'start', interval: HEARTBEAT_INTERVAL });
        }
      }
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
    
    // ספירה ראשונה אחרי 3 שניות - נותן לריליים זמן להתחבר
    setTimeout(async () => {
      state.lastPeerCountTime = 0;
      const { tier, peerCount } = await updateNetworkTier();
      log('info', '🔄 ספירת peers ראשונה', { count: peerCount, tier });
    }, 3000);
    
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
        // משתמש 1 בלבד: כל הפוסטים מ-Blossom
        return true;
      case 'HYBRID':
        // משתמשים 3-10: 5 פוסטים ראשונים מ-Blossom לחוויה חלקה, השאר P2P
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
    const now = Date.now();
    
    // חישוב מהירות
    let speed = 0;
    if (prev && prev.timestamp) {
      const timeDiff = (now - prev.timestamp) / 1000;
      const bytesDiff = receivedSize - prev.receivedSize;
      if (timeDiff > 0) {
        speed = bytesDiff / timeDiff;
      }
    }
    
    // עדכון state להצגה בטולטיפ
    state.activeDownload = {
      hash: extra.hash || connectionId,
      peers: extra.peers || 1,
      startTime: prev?.startTime || now,
      bytesReceived: receivedSize,
      totalSize,
      speed,
      percent,
    };
    
    // הדפסה רק כל 10% או בסיום
    const shouldLog = !prev || (percent >= 100) || (Math.floor(percent / 10) > Math.floor(prev.percent / 10));
    
    if (prev && percent <= prev.percent) {
      return;
    }
    logState.downloadProgress.set(connectionId, { percent, receivedSize, totalSize, timestamp: now, startTime: prev?.startTime || now });
    
    if (shouldLog) {
      const filled = Math.round(percent / 5);
      const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
      const sizeMB = (totalSize / 1024 / 1024).toFixed(1);
      console.log(`%c📥 [${bar}] ${percent}% (${sizeMB}MB)`, 'color: #FF9800');
    }

    if (percent >= 100) {
      logState.downloadProgress.delete(connectionId);
      state.activeDownload = null;
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
        resolve(result.success);
        
        // השהייה רק אם באמת פורסם ל-relay (לא אם דולג)
        if (result.published && shareQueue.length > 0) {
          await new Promise(r => setTimeout(r, SHARE_DELAY));
        }
      } catch (err) {
        reject(err);
      }
    }
    
    isProcessingShares = false;
  }

  async function registerFileAvailability(hash, blob, mimeType) {
    // רק המנהיג מפרסם קבצים לרשת
    if (!isP2PAllowed()) {
      // שמירה מקומית בלבד - בלי פרסום לרשת
      state.availableFiles.set(hash, {
        blob, mimeType, size: blob.size, timestamp: Date.now(),
      });
      return true;
    }
    
    // הגבלת גודל תור השיתופים - מותאם למכשיר
    const MAX_SHARE_QUEUE = IS_MOBILE ? 20 : 50;
    if (shareQueue.length >= MAX_SHARE_QUEUE) {
      log('warn', '⚠️ תור שיתופים מלא - דוחה בקשה', { hash: hash.slice(0, 12) });
      return false;
    }
    
    // הוספה לתור במקום ביצוע מיידי
    return new Promise((resolve, reject) => {
      shareQueue.push({ hash, blob, mimeType, resolve, reject });
      processShareQueue();
    });
  }

  async function doRegisterFileAvailability(hash, blob, mimeType) {
    p2pStats.shares.total++;
    const keys = getEffectiveKeys();
    
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

      // פרסום לרשת - תומך גם באורחים
      if (!App.pool || !keys.publicKey || !keys.privateKey) {
        p2pStats.shares.failed++;
        return { success: false, published: false };
      }

      const now = Date.now();
      const manifestEntry = state.availabilityManifest?.[hash];
      if (manifestEntry && typeof manifestEntry.lastPublished === 'number') {
        if (now - manifestEntry.lastPublished < AVAILABILITY_MANIFEST_TTL) {
          state.lastAvailabilityPublish.set(hash, now);
          p2pStats.shares.success++;
          // לוג רק פעם ראשונה בסשן לכל hash
          if (!state.skippedSharesLogged) state.skippedSharesLogged = new Set();
          if (!state.skippedSharesLogged.has(hash)) {
            state.skippedSharesLogged.add(hash);
            log('info', '⏭️ קובץ כבר שותף', { hash: hash.slice(0,12), daysAgo: Math.round((now - manifestEntry.lastPublished) / (24*60*60*1000) * 10) / 10 });
          }
          return { success: true, published: false }; // דולג - בלי השהייה
        }
      }

      const lastPublish = state.lastAvailabilityPublish.get(hash) || 0;
      if (now - lastPublish < AVAILABILITY_REPUBLISH_INTERVAL) {
        p2pStats.shares.success++;
        return { success: true, published: false }; // דולג - בלי השהייה
      }

      await ensureAvailabilityRateCapacity();

      const expiresAt = Date.now() + AVAILABILITY_EXPIRY;
      const createdAt = Math.floor(Date.now() / 1000);
      
      const event = {
        kind: FILE_AVAILABILITY_KIND,
        pubkey: keys.publicKey,
        created_at: createdAt,
        tags: [
          ['d', `${P2P_APP_TAG}:file:${hash}`],
          ['x', hash],
          ['t', 'p2p-file'],
          ['size', String(blob.size)],
          ['mime', mimeType],
          ['expires', String(expiresAt)],
          keys.isGuest ? ['guest', 'true'] : null // סימון אורח
        ].filter(Boolean),
        content: '',
      };

      // תמיכה בחתימה גם לאורחים
      let signed;
      if (App.finalizeEvent) {
        signed = App.finalizeEvent(event, keys.privateKey);
      } else if (window.NostrTools && window.NostrTools.finalizeEvent) {
        signed = window.NostrTools.finalizeEvent(event, keys.privateKey);
      }
      
      if (!signed) {
        log('warn', '⚠️ שיתוף קובץ: חתימה נכשלה', { hash: hash.slice(0,12) });
        p2pStats.shares.failed++;
        return { success: false, published: false };
      }
      
      const relays = getP2PRelays();
      
      // שליחה לכל relay בנפרד (כמו ב-heartbeat) - יותר אמין
      const results = await Promise.allSettled(relays.map(relay => 
        App.pool.publish([relay], signed)
      ));
      const successCount = results.filter(r => r.status === 'fulfilled').length;
      
      // לוג מקוצר - שורה אחת לשיתוף
      log('upload', `שיתוף קובץ`, { 
        hash: hash.slice(0,12), 
        relays: `${successCount}/${relays.length}` 
      });

      if (successCount === 0) {
        p2pStats.shares.failed++;
        return { success: false, published: true }; // ניסינו לפרסם אבל נכשל
      }

      state.lastAvailabilityPublish.set(hash, Date.now());
      state.availabilityManifest[hash] = {
        lastPublished: Date.now(),
        size: blob.size,
        mimeType,
      };
      saveAvailabilityManifest();
      p2pStats.shares.success++;
      
      // סימון ההעלאה כממתינה - מנורה מהבהבת עד שמישהו יוריד
      markUploadPending(hash);

      return { success: true, published: true }; // פורסם בהצלחה - צריך השהייה
    } catch (err) {
      p2pStats.shares.failed++;
      log('error', `שיתוף נכשל`, { hash: hash.slice(0,12), error: err.message });
      return { success: false, published: false };
    }
  }

  // חלק P2P (p2p-video-sharing.js) – חיפוש peers עם קובץ (עם סינון לפי heartbeat) | HYPER CORE TECH
  async function findPeersWithFile(hash) {
    // חלק Persistent Connections – בדיקה אם יש חיבור קיים לפני חיפוש ב-Relay | HYPER CORE TECH
    const connectedPeers = getConnectedPeersWithFile(hash);
    if (connectedPeers.length > 0) {
      log('info', `🔗 נמצאו peers מחוברים עם הקובץ`, { count: connectedPeers.length, hash: hash.slice(0, 12) });
      return connectedPeers;
    }
    
    // חלק Peer Exchange – בדיקה ב-cache מקומי קודם | HYPER CORE TECH
    if (App.PeerExchange && typeof App.PeerExchange.findPeersWithFileLocally === 'function') {
      const localPeers = App.PeerExchange.findPeersWithFileLocally(hash);
      if (localPeers && localPeers.length > 0) {
        log('info', `📋 נמצאו peers ב-cache מקומי`, { count: localPeers.length, hash: hash.slice(0, 12) });
        // העדפת peers מחוברים בראש הרשימה
        return prioritizeConnectedPeers(localPeers);
      }
    }
    
    return new Promise((resolve) => {
      const relays = getP2PRelays();
      const sinceTimestamp = Math.floor(Date.now() / 1000) - PEER_DISCOVERY_LOOKBACK;
      const heartbeatSince = Math.floor(Date.now() / 1000) - HEARTBEAT_LOOKBACK; // 2 דקות אחורה

      const peersWithFile = new Set(); // peers שיש להם את הקובץ
      const activePeers = new Set();   // peers עם heartbeat אחרון (אונליין)
      
      // חיפוש מקבילי: קבצים + heartbeats
      const filters = [
        {
          kinds: [FILE_AVAILABILITY_KIND],
          '#t': ['p2p-file'],
          '#x': [hash],
          since: sinceTimestamp,
        },
        {
          kinds: [FILE_AVAILABILITY_KIND],
          '#t': ['p2p-heartbeat'],
          since: heartbeatSince,
          limit: 50
        }
      ];

      let finished = false;
      let timeoutHandle = null;
      let sub;
      let eventCount = 0;

      const finalize = () => {
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
        
        // סינון: רק peers שיש להם את הקובץ וגם שלחו heartbeat לאחרונה
        let filteredPeers = Array.from(peersWithFile).filter(p => activePeers.has(p));
        
        // אם אין peers אקטיביים עם הקובץ, ננסה את כל מי שיש לו את הקובץ (fallback)
        if (filteredPeers.length === 0 && peersWithFile.size > 0) {
          log('warn', `⚠️ אין peers אקטיביים עם הקובץ, מנסה את כולם`, { 
            withFile: peersWithFile.size, 
            active: activePeers.size 
          });
          filteredPeers = Array.from(peersWithFile);
        }
        
        // מיון: peers אקטיביים קודם
        filteredPeers.sort((a, b) => {
          const aActive = activePeers.has(a) ? 0 : 1;
          const bActive = activePeers.has(b) ? 0 : 1;
          return aActive - bActive;
        });
        
        log('info', `📋 חיפוש peers הושלם`, { 
          events: eventCount, 
          withFile: peersWithFile.size,
          active: activePeers.size,
          filtered: filteredPeers.length
        });
        resolve(filteredPeers);
      };

      try {
        log('info', `🔌 מתחבר לריליים: ${relays.join(', ')}`);
        
        sub = App.pool.subscribeMany(relays, filters, {
          onevent: (event) => {
            eventCount++;
            
            // דילוג על events שלי
            if (event.pubkey === App.publicKey) {
              return;
            }

            const tTag = event.tags.find(t => t[0] === 't');
            const tagType = tTag ? tTag[1] : '';
            
            if (tagType === 'p2p-heartbeat') {
              // heartbeat - peer אקטיבי
              activePeers.add(event.pubkey);
            } else if (tagType === 'p2p-file') {
              // זמינות קובץ - בדיקת expires
              const expiresTag = event.tags.find(t => t[0] === 'expires');
              const expires = expiresTag ? parseInt(expiresTag[1]) : 0;
              const now = Date.now();

              if (expires && expires > now) {
                const isNew = !peersWithFile.has(event.pubkey);
                peersWithFile.add(event.pubkey);
                if (isNew) {
                  log('peer', `👤 peer #${peersWithFile.size}`, { pubkey: event.pubkey.slice(0, 8) });
                }
              }
            }
          },
          oneose: () => {
            finalize();
          }
        });

        // timeout
        timeoutHandle = setTimeout(() => {
          log('info', `⏱️ timeout בחיפוש (${PEER_DISCOVERY_TIMEOUT}ms)`, {
            eventsReceivedSoFar: eventCount,
            peersWithFile: peersWithFile.size,
            activePeers: activePeers.size
          });
          finalize();
        }, PEER_DISCOVERY_TIMEOUT);

      } catch (err) {
        log('error', `❌ כשלון בחיפוש peers: ${err.message}`, { 
          error: err.toString(),
          stack: err.stack 
        });
        resolve([]);
      }
    });
  }

  // חלק Persistent Connections (p2p-video-sharing.js) – בדיקה אם יש חיבור פעיל לשימוש חוזר | HYPER CORE TECH
  function getPersistentConnection(peerPubkey) {
    const conn = state.persistentPeers.get(peerPubkey);
    if (!conn) return null;
    
    // בדיקה שהחיבור עדיין פעיל
    if (conn.pc.connectionState === 'connected' && 
        conn.channel && conn.channel.readyState === 'open') {
      conn.lastUsed = Date.now();
      log('info', `🔄 משתמש בחיבור קיים`, { 
        peer: peerPubkey.slice(0, 8), 
        filesTransferred: conn.filesTransferred 
      });
      return conn;
    }
    
    // החיבור לא פעיל - מנקים אותו
    log('info', `🧹 מנקה חיבור לא פעיל`, { peer: peerPubkey.slice(0, 8) });
    try { conn.channel?.close(); } catch (e) {}
    try { conn.pc?.close(); } catch (e) {}
    state.persistentPeers.delete(peerPubkey);
    try { App.EventSync?.detachChannel?.(peerPubkey); } catch (e) {}
    return null;
  }
  
  // חלק Persistent Connections (p2p-video-sharing.js) – שמירת חיבור לשימוש חוזר | HYPER CORE TECH
  function savePersistentConnection(peerPubkey, pc, channel) {
    state.persistentPeers.set(peerPubkey, {
      pc,
      channel,
      lastUsed: Date.now(),
      filesTransferred: 1,
      busy: false
    });
    log('success', `💾 חיבור נשמר לשימוש חוזר`, { 
      peer: peerPubkey.slice(0, 8),
      totalPersistent: state.persistentPeers.size
    });
    
    // חלק Peer Exchange – שליחת Exchange מיד אחרי חיבור מוצלח | HYPER CORE TECH
    if (App.PeerExchange && typeof App.PeerExchange.sendPeerExchangeRequest === 'function') {
      try {
        App.PeerExchange.markPeerConnected(peerPubkey, channel);
        App.PeerExchange.sendPeerExchangeRequest(channel);
        log('info', `🔄 שלחתי Exchange request ל-peer חדש`, { peer: peerPubkey.slice(0, 8) });
      } catch (e) {
        // לא קריטי
      }
    }

    try { App.EventSync?.attachChannel?.(peerPubkey, channel); } catch (e) {}
  }
  
  // חלק Persistent Connections (p2p-video-sharing.js) – ניקוי חיבורים ישנים | HYPER CORE TECH
  const PERSISTENT_CONNECTION_TTL = 5 * 60 * 1000; // 5 דקות
  function cleanupPersistentConnections() {
    const now = Date.now();
    let cleaned = 0;
    for (const [pubkey, conn] of state.persistentPeers) {
      const age = now - conn.lastUsed;
      const isStale = age > PERSISTENT_CONNECTION_TTL;
      const isDisconnected = conn.pc.connectionState !== 'connected' || 
                             !conn.channel || conn.channel.readyState !== 'open';
      
      if (isStale || isDisconnected) {
        try { conn.channel?.close(); } catch (e) {}
        try { conn.pc?.close(); } catch (e) {}
        state.persistentPeers.delete(pubkey);
        try { App.EventSync?.detachChannel?.(pubkey); } catch (e) {}
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log('info', `🧹 נוקו ${cleaned} חיבורים ישנים`, { remaining: state.persistentPeers.size });
    }
  }
  
  // ניקוי כל דקה
  setInterval(cleanupPersistentConnections, 60000);

  // חלק Persistent Connections (p2p-video-sharing.js) – מציאת peers מחוברים שיש להם קובץ | HYPER CORE TECH
  function getConnectedPeersWithFile(hash) {
    const connectedPeers = [];
    
    // בדיקה ב-PeerExchange אם יש מידע על הקובץ
    if (App.PeerExchange && typeof App.PeerExchange.findPeersWithFileLocally === 'function') {
      const peersWithFile = App.PeerExchange.findPeersWithFileLocally(hash);
      
      for (const pubkey of peersWithFile) {
        const conn = state.persistentPeers.get(pubkey);
        if (conn && conn.pc.connectionState === 'connected' && 
            conn.channel && conn.channel.readyState === 'open') {
          connectedPeers.push(pubkey);
        }
      }
    }
    
    return connectedPeers;
  }
  
  // חלק Persistent Connections (p2p-video-sharing.js) – העדפת peers מחוברים בראש הרשימה | HYPER CORE TECH
  function prioritizeConnectedPeers(peers) {
    if (!Array.isArray(peers) || peers.length === 0) return peers;
    
    const connected = [];
    const notConnected = [];
    
    for (const pubkey of peers) {
      const conn = state.persistentPeers.get(pubkey);
      if (conn && conn.pc.connectionState === 'connected' && 
          conn.channel && conn.channel.readyState === 'open') {
        connected.push(pubkey);
      } else {
        notConnected.push(pubkey);
      }
    }
    
    if (connected.length > 0) {
      log('info', `🔗 העדפת ${connected.length} peers מחוברים`, { total: peers.length });
    }
    
    return [...connected, ...notConnected];
  }

  // חלק P2P (p2p-video-sharing.js) – הורדת קובץ מ-peer
  async function downloadFromPeer(peerPubkey, hash) {
    // חלק Persistent Connections – בדיקה אם יש חיבור קיים | HYPER CORE TECH
    const existingConn = getPersistentConnection(peerPubkey);
    if (existingConn && !existingConn.busy) {
      existingConn.busy = true;
      try {
        const result = await downloadViaPersistentConnection(existingConn, hash, peerPubkey);
        existingConn.filesTransferred++;
        return result;
      } catch (err) {
        log('info', `⚠️ חיבור קיים נכשל, יוצר חדש`, { error: err.message });
        state.persistentPeers.delete(peerPubkey);
      } finally {
        existingConn.busy = false;
      }
    }
    
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
  
  // חלק Persistent Connections (p2p-video-sharing.js) – הורדה דרך חיבור קיים | HYPER CORE TECH
  function downloadViaPersistentConnection(conn, hash, peerPubkey) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let receivedSize = 0;
      let totalSize = 0;
      
      const originalOnMessage = conn.channel.onmessage;

      const timeout = setTimeout(() => {
        try { conn.channel.onmessage = originalOnMessage; } catch (e) {}
        reject(new Error('Persistent download timeout'));
      }, MAX_DOWNLOAD_TIMEOUT);
      
      conn.channel.onmessage = async (event) => {
        try {
          if (typeof event.data === 'string') {
            const msg = JSON.parse(event.data);
            if (msg.type === 'metadata') {
              totalSize = msg.size;
              log('info', `📊 [Persistent] קיבלתי metadata`, { size: totalSize });
            } else if (msg.type === 'complete') {
              clearTimeout(timeout);
              conn.channel.onmessage = originalOnMessage;
              const blob = new Blob(chunks, { type: msg.mimeType });
              log('success', `✅ [Persistent] הורדה הושלמה`, { size: receivedSize });
              resolve({ blob, mimeType: msg.mimeType });
            } else if (msg.type === 'error') {
              clearTimeout(timeout);
              conn.channel.onmessage = originalOnMessage;
              reject(new Error(msg.message));
            } else {
              if (App.EventSync && typeof App.EventSync.handleIncomingMessage === 'function') {
                const handled = await App.EventSync.handleIncomingMessage(msg, peerPubkey, conn.channel);
                if (handled) return;
              }
              if (App.PeerExchange && typeof App.PeerExchange.handleIncomingMessage === 'function') {
                App.PeerExchange.handleIncomingMessage(msg, peerPubkey, conn.channel);
              }
            }
          } else {
            chunks.push(event.data);
            receivedSize += event.data.byteLength || event.data.size;
          }
        } catch (err) {
          clearTimeout(timeout);
          conn.channel.onmessage = originalOnMessage;
          reject(err);
        }
      };
      
      // שליחת בקשה לקובץ
      try {
        if (!conn.channel || conn.channel.readyState !== 'open') throw new Error('Persistent channel not open');
        conn.channel.send(JSON.stringify({ type: 'request', hash }));
      } catch (err) {
        clearTimeout(timeout);
        try { conn.channel.onmessage = originalOnMessage; } catch (_) {}
        reject(err);
        return;
      }
      log('request', `📤 [Persistent] שלחתי בקשה לקובץ`, { hash: hash.slice(0, 12) });
    });
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

        channel.onmessage = async (event) => {
          try {
            if (typeof event.data === 'string') {
              const msg = JSON.parse(event.data);

              if (msg.type === 'metadata') {
                totalSize = msg.size;
                
                // חלק P2P Metadata – עיבוד metadata מורחב | HYPER CORE TECH
                if (App.MetadataTransfer && typeof App.MetadataTransfer.processReceivedMetadata === 'function') {
                  App.MetadataTransfer.processReceivedMetadata(msg, hash);
                }
                
                log('info', `📊 קיבלתי metadata`, {
                  size: totalSize,
                  mimeType: msg.mimeType,
                  extended: !!msg.postMetadata
                });
              } else if (msg.type === 'complete') {
                log('success', `✅ קיבלתי את כל הקובץ!`, {
                  chunks: chunks.length,
                  totalSize: receivedSize
                });

                const blob = new Blob(chunks, { type: msg.mimeType });
                
                // חלק Persistent Connections – שמירת חיבור לשימוש חוזר במקום סגירה | HYPER CORE TECH
                clearTimeout(timeout);
                state.pendingConnections.delete(connectionId);
                state.pendingIceCandidates.delete(connectionId);
                
                // שמירת החיבור לשימוש חוזר אם הוא עדיין פעיל
                if (pc && pc.connectionState === 'connected' && channel && channel.readyState === 'open') {
                  savePersistentConnection(peerPubkey, pc, channel);
                } else {
                  cleanup();
                }
                
                resolve({ blob, mimeType: msg.mimeType });
              } else if (msg.type === 'error') {
                log('error', `❌ שגיאה מהשרת: ${msg.message}`);
                cleanup();
                reject(new Error(msg.message));
              } else {
                if (App.EventSync && typeof App.EventSync.handleIncomingMessage === 'function') {
                  const handled = await App.EventSync.handleIncomingMessage(msg, peerPubkey, channel);
                  if (handled) return;
                }

                // חלק Peer Exchange – טיפול בהודעות נוספות | HYPER CORE TECH
                if (App.PeerExchange && typeof App.PeerExchange.handleIncomingMessage === 'function') {
                  App.PeerExchange.handleIncomingMessage(msg, peerPubkey, channel);
                }
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
      const keys = getEffectiveKeys();
      const tryRelay = () => {
        if (!App.PeerExchange || typeof App.PeerExchange.sendRelaySignal !== 'function') return false;
        const via = typeof App.PeerExchange.findRelayPeer === 'function' ? App.PeerExchange.findRelayPeer(peerPubkey) : null;
        if (!via) return false;
        const ok = App.PeerExchange.sendRelaySignal(peerPubkey, { type, data }, via);
        if (ok) {
          log('peer', `📡 signal נשלח דרך Relay Peer`, {
            type,
            to: peerPubkey.slice(0, 16) + '...',
            via: via.slice(0, 16) + '...'
          });
        }
        return ok;
      };

      if (!App.pool || !keys.publicKey || !keys.privateKey) {
        if (tryRelay()) return;
        throw new Error('Missing pool or keys');
      }

      await throttleSignals();

      const content = JSON.stringify({ type, data });

      const { content: wireContent, encrypted } = await prepareSignalContent(content, peerPubkey);

      const kind = FILE_REQUEST_KIND; // כל הסיגנלים משתמשים ב-30078
      const signalType = type === 'file-request' ? 'req' : (type === 'file-response' ? 'res' : 'ice');

      const event = {
        kind,
        pubkey: keys.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', `${P2P_APP_TAG}:signal:${Date.now()}`], // NIP-78: מזהה ייחודי
          ['p', peerPubkey],
          ['t', `p2p-${signalType}`], // סוג הסיגנל
          keys.isGuest ? ['guest', 'true'] : null
        ].filter(Boolean),
        content: wireContent,
      };

      if (encrypted) {
        event.tags.push(['enc', 'nip04']);
      }

      let signed;
      if (App.finalizeEvent) {
        signed = App.finalizeEvent(event, keys.privateKey);
      } else if (window.NostrTools && window.NostrTools.finalizeEvent) {
        signed = window.NostrTools.finalizeEvent(event, keys.privateKey);
      }
      
      const relays = getP2PRelays();
      
      // לוג מפורט לדיבוג שליחת signal
      log('info', `📤 [DEBUG] שולח signal`, {
        type,
        to: peerPubkey.slice(0, 16) + '...',
        from: keys.publicKey.slice(0, 16) + '...',
        isGuest: keys.isGuest,
        encrypted,
        relays: relays.join(', ')
      });
      
      try {
        await App.pool.publish(relays, signed);
      } catch (publishErr) {
        if (tryRelay()) return;
        throw publishErr;
      }

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

  async function handleRelayedSignal(signal, senderPubkey) {
    try {
      const msg = typeof signal === 'string' ? JSON.parse(signal) : signal;
      if (!msg || !msg.type) return;

      log('request', `📬 התקבל Relay Signal`, {
        type: msg.type,
        from: senderPubkey?.slice?.(0, 16) + '...'
      });

      if (msg.type === 'file-request') {
        await handleFileRequest(senderPubkey, msg.data);
      } else if (msg.type === 'file-response') {
        await handleFileResponse(senderPubkey, msg.data);
      } else if (msg.type === 'ice-candidate') {
        await handleIceCandidate(senderPubkey, msg.data);
      } else if (msg.type === 'file-offer') {
        // חלק P2P File Transfer (p2p-video-sharing.js) – ניתוב file-offer ל-chat-p2p-file.js | HYPER CORE TECH
        log('info', `[P2P-FILE] 📥 התקבל file-offer מ-Relay`, {
          from: senderPubkey?.slice?.(0, 12) + '...',
          fileId: msg.data?.fileId || msg.fileId,
          name: msg.data?.name || msg.name
        });
        if (typeof App.handleP2PFileOffer === 'function') {
          await App.handleP2PFileOffer(senderPubkey, msg.data || msg);
        } else {
          log('warn', '[P2P-FILE] ⚠️ App.handleP2PFileOffer לא זמין');
        }
      }
    } catch (err) {
      log('error', `❌ כשלון בעיבוד Relay Signal: ${err.message}`);
    }
  }

  App.handleRelayedSignal = handleRelayedSignal;

  // חלק P2P File Transfer (p2p-video-sharing.js) – עטיפה מאוחדת ל-sendP2PSignal שתומכת בשתי חתימות | HYPER CORE TECH
  // חתימה 1: sendP2PSignal(peerPubkey, payload) – payload הוא אובייקט עם type בפנים
  // חתימה 2: sendP2PSignal(peerPubkey, type, data) – type ו-data נפרדים
  async function sendP2PSignal(peerPubkey, typeOrPayload, data) {
    let type, payload;
    if (typeof typeOrPayload === 'object' && typeOrPayload !== null) {
      // חתימה 1: (peer, payload)
      payload = typeOrPayload;
      type = payload.type;
      data = payload;
    } else {
      // חתימה 2: (peer, type, data)
      type = typeOrPayload;
      payload = { type, ...data };
    }
    
    log('info', `[P2P-FILE] 📤 sendP2PSignal`, {
      to: peerPubkey?.slice?.(0, 12) + '...',
      type,
      hasData: !!data
    });
    
    return sendSignal(peerPubkey, type, data);
  }
  
  App.sendP2PSignal = sendP2PSignal;

  // חלק P2P (p2p-video-sharing.js) – האזנה לסיגנלים (בקשות, תשובות ו-ICE)
  function listenForP2PSignals() {
    const keys = getEffectiveKeys();
    if (!App.pool || !keys.publicKey) {
      log('error', '❌ לא ניתן להאזין לסיגנלים - חסרים pool או publicKey');
      return;
    }

    log('info', '👂 מתחיל להאזין לסיגנלי P2P...', { isGuest: keys.isGuest });

    const filters = [
      {
        kinds: [FILE_REQUEST_KIND], // 30078 - כל הסיגנלים
        '#p': [keys.publicKey],
        since: Math.floor(Date.now() / 1000) - 120, // 120 שניות אחורה (הוגדל מ-60)
      }
    ];
    
    // לוג מפורט לדיבוג
    const relays = getP2PRelays();
    log('info', '🔍 [DEBUG] פרטי האזנה לסיגנלים', {
      myPubkey: keys.publicKey.slice(0, 16) + '...',
      relays: relays.join(', '),
      filterKind: FILE_REQUEST_KIND,
      since: filters[0].since,
      isGuest: keys.isGuest
    });

    try {
      const sub = App.pool.subscribeMany(relays, filters, {
        onevent: async (event) => {
          log('request', `📬 התקבל סיגנל`, {
            kind: event.kind,
            from: event.pubkey.slice(0, 16) + '...',
            eventId: event.id.slice(0, 8) + '...',
            createdAt: new Date(event.created_at * 1000).toLocaleTimeString()
          });

          try {
            const decodedContent = await extractSignalContent(event.content, event.pubkey);
            const message = JSON.parse(decodedContent);
            
            log('info', `📨 [DEBUG] סוג סיגנל: ${message.type}`, {
              from: event.pubkey.slice(0, 8),
              hasData: !!message.data
            });

            if (message.type === 'file-request') {
              await handleFileRequest(event.pubkey, message.data);
            } else if (message.type === 'file-response') {
              await handleFileResponse(event.pubkey, message.data);
            } else if (message.type === 'ice-candidate') {
              await handleIceCandidate(event.pubkey, message.data);
            } else if (message.type === 'file-offer') {
              // חלק P2P File Transfer (p2p-video-sharing.js) – ניתוב file-offer ל-chat-p2p-file.js | HYPER CORE TECH
              log('info', `[P2P-FILE] 📥 התקבל file-offer מ-Nostr subscribe`, {
                from: event.pubkey?.slice?.(0, 12) + '...',
                fileId: message.data?.fileId || message.fileId,
                name: message.data?.name || message.name
              });
              if (typeof App.handleP2PFileOffer === 'function') {
                await App.handleP2PFileOffer(event.pubkey, message.data || message);
              } else {
                log('warn', '[P2P-FILE] ⚠️ App.handleP2PFileOffer לא זמין');
              }
            }

          } catch (err) {
            log('error', `❌ כשלון בעיבוד סיגנל: ${err.message}`, { stack: err.stack?.slice(0, 200) });
          }
        },
        oneose: () => {
          log('info', '📭 [DEBUG] סיום קבלת events ישנים (EOSE)');
        }
      });

      App._p2pSignalsSub = sub;
      log('success', '✅ מאזין לסיגנלי P2P', { relays: relays.length });

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

        let isSending = false;
        const sendFileToChannel = async (requestedHash) => {
          if (!requestedHash || isSending) return;
          const hash = requestedHash;
          const fileData = state.availableFiles.get(hash);
          if (!fileData) {
            if (channel && channel.readyState === 'open') {
              try {
                channel.send(JSON.stringify({ type: 'error', message: 'File not available' }));
              } catch (e) {}
            }
            return;
          }

          isSending = true;
          try {
            // שליחת metadata - עם הרחבה אם המודול זמין
            let metadataMsg = {
              type: 'metadata',
              size: fileData.size,
              mimeType: fileData.mimeType
            };
            
            // חלק P2P Metadata – הרחבת הודעה עם מידע נוסף | HYPER CORE TECH
            if (App.MetadataTransfer && typeof App.MetadataTransfer.extendMetadataMessage === 'function') {
              metadataMsg = App.MetadataTransfer.extendMetadataMessage(metadataMsg, hash, fileData.eventId);
            }
            
            channel.send(JSON.stringify(metadataMsg));

            log('upload', `📊 שלחתי metadata`, {
              size: fileData.size,
              mimeType: fileData.mimeType,
              extended: !!metadataMsg.postMetadata
            });

            // שליחת הקובץ ב-chunks
            const blob = fileData.blob;
            let offset = 0;
            let chunkNum = 0;
            const totalChunks = Math.ceil(blob.size / CHUNK_SIZE);

            const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
            let lastLoggedPercent = -1;
            let uploadStartTime = Date.now();
            let lastSpeedCheck = uploadStartTime;
            let lastBytesSent = 0;
            
            // עדכון state להעלאה פעילה
            state.activeUploadCount++;
            state.activeUpload = {
              hash: hash,
              startTime: uploadStartTime,
              bytesSent: 0,
              totalSize: blob.size,
              speed: 0,
            };
            
            console.log(`%c📤 שליחת קובץ: ${sizeMB}MB`, 'color: #4CAF50; font-weight: bold');

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

              // עדכון מהירות כל 500ms
              const now = Date.now();
              if (now - lastSpeedCheck > 500) {
                const timeDiff = (now - lastSpeedCheck) / 1000;
                const bytesDiff = offset - lastBytesSent;
                state.activeUpload = {
                  ...state.activeUpload,
                  bytesSent: offset,
                  speed: bytesDiff / timeDiff,
                };
                lastSpeedCheck = now;
                lastBytesSent = offset;
              }

              // מד התקדמות - רק כל 10%
              const percent = Math.round((offset / blob.size) * 100);
              if (percent % 10 === 0 && percent !== lastLoggedPercent) {
                lastLoggedPercent = percent;
                const filled = Math.round(percent / 5);
                const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
                console.log(`%c📤 [${bar}] ${percent}%`, 'color: #2196F3');
              }
            }

            // המתנה שה-buffer יתרוקן לפני שליחת הודעת סיום
            while (channel.bufferedAmount > 0) {
              await new Promise(resolve => setTimeout(resolve, 50));
            }

            // שליחת הודעת סיום
            channel.send(JSON.stringify({
              type: 'complete',
              mimeType: fileData.mimeType
            }));

            // המתנה נוספת לוודא שהודעת הסיום נשלחה
            await new Promise(resolve => setTimeout(resolve, 500));

            log('success', `✅ סיימתי לשלוח את כל הקובץ!`, {
              chunks: chunkNum,
              totalSize: blob.size
            });
            
            // עדכון סטטיסטיקות העלאות
            p2pStats.shares.total++;
            p2pStats.shares.success++;
            
            // אישור שהקובץ הועבר למשתמש אחר - מכבה את המנורה המהבהבת
            confirmUpload(hash);
            
            // ניקוי state העלאה
            state.activeUploadCount = Math.max(0, state.activeUploadCount - 1);
            if (state.activeUploadCount === 0) state.activeUpload = null;

          } catch (err) {
            log('error', `❌ שגיאה בשליחת קובץ: ${err.message}`);
            p2pStats.shares.total++;
            p2pStats.shares.failed++;
            state.activeUploadCount = Math.max(0, state.activeUploadCount - 1);
            if (state.activeUploadCount === 0) state.activeUpload = null;
            if (channel && channel.readyState === 'open') {
              try {
                channel.send(JSON.stringify({
                  type: 'error',
                  message: err.message
                }));
              } catch (e) {}
            }
          } finally {
            isSending = false;
          }
        };

        channel.onopen = async () => {
          log('success', `✅ data channel נפתח - מתחיל שליחה!`);
          await sendFileToChannel(hash);
        };

        channel.onerror = (err) => {
          // שגיאה זו נורמלית כשה-peer סוגר את החיבור אחרי קבלת הקובץ
          // לא מדפיסים כשגיאה כי זה מבלבל
        };

        channel.onmessage = async (event) => {
          try {
            const msg = JSON.parse(event.data);

            if (msg.type === 'request' && msg.hash) {
              log('request', `📥 peer ביקש את הקובץ`, { hash: msg.hash.slice(0, 16) + '...' });
              await sendFileToChannel(msg.hash);
              return;
            }

            if (App.EventSync && typeof App.EventSync.handleIncomingMessage === 'function') {
              const handled = await App.EventSync.handleIncomingMessage(msg, peerPubkey, channel);
              if (handled) return;
            }

            if (App.PeerExchange && typeof App.PeerExchange.handleIncomingMessage === 'function') {
              const handled = App.PeerExchange.handleIncomingMessage(msg, peerPubkey, channel);
              if (handled) return;
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
      const keys = getEffectiveKeys();
      const isGuest = keys.isGuest;
      
      // אורחים: 10 פוסטים ראשונים תמיד מ-Blossom לחוויה מהירה
      const guestForceBlossom = isGuest && postIndex < GUEST_BLOSSOM_FIRST_POSTS;
      const forceBlossom = guestForceBlossom || shouldUseBlossom(postIndex, tier);

      log('download', `🎬 מתחיל הורדת וידאו`, {
        url: url.slice(0, 50) + '...',
        hash: hash ? hash.slice(0, 16) + '...' : 'אין hash',
        tier,
        postIndex,
        forceBlossom,
        isGuest
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
          } catch (blossomErr) {
            // Blossom נכשל - ננסה P2P כ-fallback
            log('info', `Blossom נכשל, מנסה P2P`, { error: blossomErr.message });
            
            const fallbackPeers = await findPeersWithFile(hash);
            if (fallbackPeers && fallbackPeers.length > 0) {
              for (const peer of fallbackPeers.slice(0, MAX_PEER_ATTEMPTS_PER_FILE)) {
                try {
                  const result = await Promise.race([
                    downloadFromPeer(peer, hash),
                    sleep(INITIAL_LOAD_TIMEOUT).then(() => { throw new Error('timeout'); })
                  ]);
                  
                  p2pStats.downloads.fromP2P++;
                  log('success', `מ-P2P (fallback מ-Blossom)`, { peer: peer.slice(0,8), size: Math.round(result.blob.size/1024)+'KB' });
                  
                  if (typeof App.cacheMedia === 'function') {
                    await App.cacheMedia(url, hash, result.blob, result.mimeType, { pinned: true });
                  }
                  await registerFileAvailability(hash, result.blob, result.mimeType);
                  resetConsecutiveFailures();
                  return { blob: result.blob, source: 'p2p-fallback', peer, tier };
                } catch (peerErr) {
                  continue;
                }
              }
            }
            
            // גם P2P נכשל
            p2pStats.downloads.failed++;
            log('error', `Blossom ו-P2P נכשלו`, { error: blossomErr.message });
            throw blossomErr;
          }
        }

        // P2P_FULL או HYBRID - עם אופטימיזציות לאורחים
        const peerSearchTimeout = isGuest ? GUEST_MAX_PEER_SEARCH_TIME : 4000;
        const maxPeersToTry = isGuest ? GUEST_MAX_PEERS_TO_TRY : MAX_PEER_ATTEMPTS_PER_FILE;
        const p2pTimeout = isGuest ? GUEST_P2P_TIMEOUT : INITIAL_LOAD_TIMEOUT;
        
        // חיפוש peers עם timeout
        let rawPeers = [];
        try {
          rawPeers = await Promise.race([
            findPeersWithFile(hash),
            sleep(peerSearchTimeout).then(() => [])
          ]);
        } catch (e) {
          rawPeers = [];
        }
        const peers = Array.isArray(rawPeers) ? [...rawPeers] : [];
        
        // עדכון מספר מקורות זמינים
        state.activeDownload = {
          hash,
          peers: peers.length,
          startTime: Date.now(),
          bytesReceived: 0,
          totalSize: 0,
          speed: 0,
          percent: 0,
        };

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

        // חלק Persistent Connections – ניסיון ראשון עם peers מחוברים | HYPER CORE TECH
        // מיון: peers מחוברים קודם
        const sortedPeers = prioritizeConnectedPeers(peers);
        
        // ניסיון P2P - עם הגבלות לאורחים
        let attemptCount = 0;
        for (const peer of sortedPeers) {
          if (maxPeersToTry > 0 && attemptCount >= maxPeersToTry) break;
          attemptCount++;
          
          // timeout קצר יותר ל-peers מחוברים (כבר יש חיבור)
          const isConnected = state.persistentPeers.has(peer);
          const effectiveTimeout = isConnected ? Math.min(p2pTimeout, 5000) : p2pTimeout;
          
          try {
            const downloadPromise = downloadFromPeer(peer, hash);
            const timeoutPromise = sleep(effectiveTimeout).then(() => {
              throw new Error('timeout');
            });
            const result = await Promise.race([downloadPromise, timeoutPromise]);

            p2pStats.downloads.fromP2P++;
            log('success', `מ-P2P`, { peer: peer.slice(0,8), size: Math.round(result.blob.size/1024)+'KB', isGuest });

            if (typeof App.cacheMedia === 'function') {
              await App.cacheMedia(url, hash, result.blob, result.mimeType, { pinned: true });
            }
            await registerFileAvailability(hash, result.blob, result.mimeType);
            resetConsecutiveFailures();
            return { blob: result.blob, source: 'p2p', peer, tier };

          } catch (err) {
            // ממשיכים לנסות peers נוספים - לא יוצאים מהלולאה
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
        // ניקוי state הורדה
        state.activeDownload = null;
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

  // חלק העלאות ממתינות (p2p-video-sharing.js) – מנורה מהבהבת עד שמישהו הוריד | HYPER CORE TECH
  function markUploadPending(hash) {
    state.pendingUploads.set(hash, { timestamp: Date.now(), confirmed: false });
    notifyUploadListeners();
  }
  
  function confirmUpload(hash) {
    const pending = state.pendingUploads.get(hash);
    if (pending && !pending.confirmed) {
      pending.confirmed = true;
      log('success', `🎉 הקובץ הועבר למשתמש אחר!`, { hash: hash.slice(0, 12) });
      notifyUploadListeners();
      // הסרה אחרי 3 שניות
      setTimeout(() => {
        state.pendingUploads.delete(hash);
        notifyUploadListeners();
      }, 3000);
    }
  }
  
  function notifyUploadListeners() {
    state.uploadListeners.forEach(callback => {
      try { callback(getPendingUploadsStatus()); } catch (e) {}
    });
  }
  
  function getPendingUploadsStatus() {
    const pending = [];
    const confirmed = [];
    state.pendingUploads.forEach((data, hash) => {
      if (data.confirmed) {
        confirmed.push(hash);
      } else {
        pending.push(hash);
      }
    });
    return { pending, confirmed, hasPending: pending.length > 0 };
  }
  
  function onUploadStatusChange(callback) {
    state.uploadListeners.add(callback);
    return () => state.uploadListeners.delete(callback);
  }

  // חלק סטטיסטיקות (p2p-video-sharing.js) – API לקבלת סטטיסטיקות P2P לממשק | HYPER CORE TECH
  function getP2PStats() {
    return {
      downloads: { ...p2pStats.downloads },
      shares: { ...p2pStats.shares },
      peerCount: state.lastPeerCount,
      tier: state.networkTier,
      activeTransfers: state.activeUploadCount,
      activeDownload: state.activeDownload ? { ...state.activeDownload } : null,
      activeUpload: state.activeUpload ? { ...state.activeUpload } : null,
      shareQueueLength: state.pendingTransferResolvers.length,
      availableFiles: state.availableFiles.size,
      isLeader: state.isLeader,
      isGuest: isGuestMode(),
    };
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
    // חלק העלאות ממתינות – API למעקב אחרי העלאות | HYPER CORE TECH
    markUploadPending,                   // סימון העלאה כממתינה
    confirmUpload,                       // אישור שהקובץ הועבר
    getPendingUploadsStatus,             // קבלת סטטוס העלאות
    onUploadStatusChange,                // הרשמה לעדכונים
    // חלק Leader Election – API לבדיקת מצב מנהיגות | HYPER CORE TECH
    isP2PLeader: () => state.isLeader,   // האם הלשונית הזו מנהיגה
    getTabId: () => state.tabId,         // מזהה הלשונית
    // חלק Guest P2P – API לבדיקת מצב אורח | HYPER CORE TECH
    isGuestP2P: isGuestMode,             // האם במצב אורח
    getGuestKeys: () => state.guestKeys, // קבלת מפתחות אורח
    // חלק סטטיסטיקות – API לקבלת סטטיסטיקות P2P | HYPER CORE TECH
    getP2PStats,                         // קבלת כל הסטטיסטיקות לממשק
  });

  // אתחול
  async function init() {
    console.log(`%c🔧 P2P.js גרסה: ${P2P_VERSION}`, 'color: #9C27B0; font-weight: bold');
    log('info', '🚀 מערכת P2P Video Sharing מאותחלת...');
    
    // הפעלת Leader Election למניעת כפילויות בין לשוניות
    setupLeaderElection();
    
    // חלק SW Coordinator (p2p-video-sharing.js) – הפעלת תיאום heartbeat דרך Service Worker | HYPER CORE TECH
    if (navigator.serviceWorker?.controller) {
      swCoordinatorEnabled = true;
      log('info', '📡 SW Coordinator מופעל - תיאום heartbeat בין טאבים');
    }
    
    // טעינת קבצים זמינים מ-cache
    await loadAvailableFilesFromCache();
    
    // ניסיון אתחול מיידי
    function tryInit() {
      const keys = getEffectiveKeys();
      const hasPool = App.pool;
      const hasKeys = keys.publicKey && keys.privateKey;
      
      if (hasPool && hasKeys) {
        // אם אורח - נשתמש במפתחות הזמניים
        if (keys.isGuest) {
          log('info', '👤 מצב אורח - משתמש במפתח זמני לשיתוף P2P');
          // שמירת המפתחות הזמניים ב-App לשימוש בפונקציות אחרות
          state.guestKeys = keys;
        }
        
        listenForP2PSignals();
        
        // שליחת heartbeat ראשון והפעלת interval (רק אם מנהיג)
        sendHeartbeat();
        setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
        
        // הפעלת polling לבדיקת peers חדשים
        startPeerPolling();
        
        // הפעלת מעקב visibility לעבודה ברקע
        setupVisibilityTracking();
        
        const displayKey = keys.isGuest ? 'guest_' + keys.publicKey.slice(0, 8) : App.publicKey.slice(0, 16);
        log('success', '✅ מערכת P2P מוכנה!', {
          publicKey: displayKey + '...',
          relays: getP2PRelays().length,
          availableFiles: state.availableFiles.size,
          isLeader: state.isLeader,
          tabId: state.tabId,
          isGuest: keys.isGuest
        });
        return true;
      }
      
      // אם אין pool אבל יש מפתחות אורח - ננסה ליצור pool בסיסי
      if (!hasPool && hasKeys && keys.isGuest) {
        return tryInitGuestPool();
      }
      
      return false;
    }
    
    // ניסיון ליצור pool בסיסי לאורחים
    function tryInitGuestPool() {
      if (!window.NostrTools || !window.NostrTools.SimplePool) {
        return false;
      }
      
      try {
        // יצירת pool בסיסי לאורחים
        if (!App.pool) {
          App.pool = new window.NostrTools.SimplePool();
        }
        
        // הגדרת ריליים בסיסיים אם אין
        if (!App.relayUrls || App.relayUrls.length === 0) {
          App.relayUrls = [
            'wss://relay.snort.social',
            'wss://relay.damus.io',
            'wss://nos.lol'
          ];
        }
        
        log('info', '🌐 נוצר pool בסיסי לאורח');
        return tryInit();
      } catch (e) {
        log('warn', '⚠️ לא ניתן ליצור pool לאורח', { error: e.message });
        return false;
      }
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
        // ניסיון אחרון - אתחול כאורח
        const keys = getEffectiveKeys();
        if (keys.isGuest && keys.publicKey) {
          log('info', '👤 מנסה אתחול במצב אורח מוגבל...');
          tryInitGuestPool();
        } else {
          log('error', '❌ חסרים publicKey או pool - מערכת P2P לא פעילה');
        }
      }
    }, 1000);
  }

  // חלק SW Wake-up (p2p-video-sharing.js) – האזנה להודעות מ-Service Worker | HYPER CORE TECH
  function setupSWWakeupListener() {
    if (!navigator.serviceWorker) return;
    
    navigator.serviceWorker.addEventListener('message', (event) => {
      const { type, reason, data } = event.data || {};
      
      // התעוררות מ-Push
      if (type === 'sw-wakeup') {
        log('info', '🔔 התעוררות מ-SW Push', { reason });
        
        // הפעלת P2P מחדש אם צריך
        if (!state.isLeader) {
          tryBecomeLeader();
        }
        
        // שליחת heartbeat מיידי
        if (isP2PAllowed()) {
          sendHeartbeat();
        }
        
        // עדכון מצב רשת
        updateNetworkTier();
        
        // אם יש נתוני sync, נעביר לפיד
        if (data && (reason === 'p2p-sync' || reason === 'chat-message')) {
          if (typeof App.onP2PSyncReceived === 'function') {
            App.onP2PSyncReceived(data);
          }
        }
      }
      
      // Keep-alive מה-SW
      if (type === 'sw-keepalive') {
        // שליחת heartbeat אם עבר זמן
        const now = Date.now();
        if (isP2PAllowed() && now - (state.lastHeartbeatSent || 0) > HEARTBEAT_INTERVAL * 0.8) {
          state.lastHeartbeatSent = now;
          sendHeartbeat();
        }
      }
    });
    
    log('info', '📡 SW Wake-up listener מופעל');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      init();
      setupSWWakeupListener();
    });
  } else {
    init();
    setupSWWakeupListener();
  }

  // חלק P2P (p2p-video-sharing.js) – חשיפת API נוספת ל-App
  Object.assign(App, {
    searchForPeers: findPeersWithFile,
    setChatFileTransferActivePeer: (peer) => { state.activeChatPeer = peer; },
    _p2pSignalsSub: null,
    // חלק Peer Exchange – חשיפת קבצים זמינים | HYPER CORE TECH
    getAvailableFiles: () => state.availableFiles,
    // חלק P2P File Transfer – חשיפת persistent connections לשימוש ב-chat-p2p-file.js | HYPER CORE TECH
    getPersistentConnection: getPersistentConnection,
    savePersistentConnection: savePersistentConnection,
    // חלק Network Tiers - API לסטטיסטיקות | HYPER CORE TECH
    getP2PStats: () => ({ 
      ...p2pStats,
      shareQueueLength: shareQueue.length,
      peerCount: state.lastPeerCount,
      networkTier: state.networkTier,
      availableFiles: state.availableFiles.size,
      activeTransfers: state.activeTransferSlots,
      activeUploadCount: state.activeUploadCount,
      activeDownload: state.activeDownload ? { ...state.activeDownload } : null,
      activeUpload: state.activeUpload ? { ...state.activeUpload } : null,
      // חלק Peer Exchange – סטטיסטיקות נוספות | HYPER CORE TECH
      peerExchange: App.PeerExchange ? App.PeerExchange.getStats() : null,
      metadataTransfer: App.MetadataTransfer ? App.MetadataTransfer.getStats() : null,
    }),
    printP2PStats,
  });

})(window);
