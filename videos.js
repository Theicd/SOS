// חלק דף וידאו (videos.js) – מנגנון משיכת וידאו והצגת פיד בסגנון טיקטוק | HYPER CORE TECH

// גרסת קוד לזיהוי עדכונים
const VIDEOS_CODE_VERSION = '2.5.0-default-play';
console.log(`%c🔧 Videos.js גרסה: ${VIDEOS_CODE_VERSION}`, 'color: #FF5722; font-weight: bold; font-size: 14px');

// חלק מצב גלובלי (videos.js) – מצב STOP/PLAY גלובלי לשליטה בהפעלה אוטומטית | HYPER CORE TECH
// הממשק מתחיל במצב PLAY – גלילה מפעילה אוטומטית | HYPER CORE TECH
let globalAutoplayEnabled = true;

// עדכון מחלקה על הגוף לפי מצב STOP/PLAY
function updateGlobalStopClass() {
  if (globalAutoplayEnabled) {
    document.body.classList.remove('global-stop');
  } else {
    document.body.classList.add('global-stop');
  }
}

// הפעלה ראשונית - הממשק מתחיל במצב PLAY
document.addEventListener('DOMContentLoaded', () => {
  updateGlobalStopClass();
});

// חלק עיגול סטטיסטיקות (videos.js) – עדכון עיגול P2P/Blossom בזמן אמת | HYPER CORE TECH
const p2pStatsUI = {
  p2p: 0,
  blossom: 0,
  cache: 0,
  total: 0,
  
  // עדכון הסטטיסטיקות
  update(source) {
    if (source === 'p2p') this.p2p++;
    else if (source === 'blossom') this.blossom++;
    else if (source === 'cache') this.cache++;
    this.total = this.p2p + this.blossom + this.cache;
    this.render();
  },
  
  // עדכון מ-App.getP2PStats אם זמין
  sync() {
    const App = window.NostrApp || {};
    if (typeof App.getP2PStats === 'function') {
      const stats = App.getP2PStats();
      if (stats && stats.downloads) {
        this.p2p = stats.downloads.fromP2P || 0;
        this.blossom = stats.downloads.fromBlossom || 0;
        this.cache = stats.downloads.fromCache || 0;
        this.total = stats.downloads.total || (this.p2p + this.blossom + this.cache);
        this.render();
      }
    }
  },
  
  // רינדור העיגול
  render() {
    const circle = document.getElementById('p2pStatsCircle');
    const textEl = document.getElementById('p2pStatsText');
    if (!circle || !textEl) return;
    
    const p2pCircle = circle.querySelector('.p2p-stats-p2p');
    const blossomCircle = circle.querySelector('.p2p-stats-blossom');
    
    if (!p2pCircle || !blossomCircle) return;
    
    // חישוב אחוזים
    const total = this.total || 1;
    const p2pPercent = (this.p2p / total) * 100;
    const blossomPercent = (this.blossom / total) * 100;
    const cachePercent = (this.cache / total) * 100;
    
    // עדכון ה-SVG - עיגול עוגה
    // P2P מתחיל מ-0
    p2pCircle.setAttribute('stroke-dasharray', `${p2pPercent} ${100 - p2pPercent}`);
    p2pCircle.setAttribute('stroke-dashoffset', '0');
    
    // Blossom מתחיל אחרי P2P
    blossomCircle.setAttribute('stroke-dasharray', `${blossomPercent} ${100 - blossomPercent}`);
    blossomCircle.setAttribute('stroke-dashoffset', `-${p2pPercent}`);
    
    // עדכון הטקסט
    textEl.textContent = this.total;
    
    // עדכון title
    circle.title = `P2P: ${this.p2p} | Blossom: ${this.blossom} | Cache: ${this.cache}`;
  },
  
  // יצירת טולטיפ מפורט
  createTooltip() {
    const circle = document.getElementById('p2pStatsCircle');
    if (!circle || circle.querySelector('.p2p-stats-tooltip')) return;
    
    const closeP2PTooltip = () => {
      const tooltipEl = circle.querySelector('.p2p-stats-tooltip');
      if (tooltipEl) {
        tooltipEl.classList.remove('visible');
      }
      circle.setAttribute('aria-expanded', 'false');
    };

    const tooltip = document.createElement('div');
    tooltip.className = 'p2p-stats-tooltip';
    tooltip.innerHTML = `
      <div class="p2p-stats-tooltip__title">📊 סטטיסטיקות SOS</div>
      <div class="p2p-stats-tooltip__section">📥 הורדות</div>
      <div class="p2p-stats-tooltip__row">
        <span class="p2p-stats-tooltip__label">
          <span class="p2p-stats-tooltip__dot p2p-stats-tooltip__dot--p2p"></span>
          SOS (רשת)
        </span>
        <span class="p2p-stats-tooltip__value" id="tooltipP2P">0</span>
      </div>
      <div class="p2p-stats-tooltip__row">
        <span class="p2p-stats-tooltip__label">
          <span class="p2p-stats-tooltip__dot p2p-stats-tooltip__dot--blossom"></span>
          Public (שרת)
        </span>
        <span class="p2p-stats-tooltip__value" id="tooltipBlossom">0</span>
      </div>
      <div class="p2p-stats-tooltip__row">
        <span class="p2p-stats-tooltip__label">
          <span class="p2p-stats-tooltip__dot p2p-stats-tooltip__dot--cache"></span>
          Cache (מקומי)
        </span>
        <span class="p2p-stats-tooltip__value" id="tooltipCache">0</span>
      </div>
      <div class="p2p-stats-tooltip__section">⬇️ הורדה פעילה</div>
      <div class="p2p-stats-tooltip__row">
        <span class="p2p-stats-tooltip__label">מקורות זמינים</span>
        <span class="p2p-stats-tooltip__value" id="tooltipDownloadPeers">-</span>
      </div>
      <div class="p2p-stats-tooltip__row">
        <span class="p2p-stats-tooltip__label">התקדמות</span>
        <span class="p2p-stats-tooltip__value" id="tooltipDownloadProgress">-</span>
      </div>
      <div class="p2p-stats-tooltip__row">
        <span class="p2p-stats-tooltip__label">מהירות</span>
        <span class="p2p-stats-tooltip__value" id="tooltipDownloadSpeed">-</span>
      </div>
      <div class="p2p-stats-tooltip__section">⬆️ העלאה פעילה</div>
      <div class="p2p-stats-tooltip__row">
        <span class="p2p-stats-tooltip__label">קבצים</span>
        <span class="p2p-stats-tooltip__value" id="tooltipUploadFiles">0</span>
      </div>
      <div class="p2p-stats-tooltip__row">
        <span class="p2p-stats-tooltip__label">מהירות</span>
        <span class="p2p-stats-tooltip__value" id="tooltipUploadSpeed">-</span>
      </div>
      <div class="p2p-stats-tooltip__section">👥 רשת</div>
      <div class="p2p-stats-tooltip__row">
        <span class="p2p-stats-tooltip__label">עמיתים פעילים</span>
        <span class="p2p-stats-tooltip__value" id="tooltipPeers">0</span>
      </div>
      <div class="p2p-stats-tooltip__row">
        <span class="p2p-stats-tooltip__label">בתור</span>
        <span class="p2p-stats-tooltip__value" id="tooltipQueue">0</span>
      </div>
    `;
    circle.appendChild(tooltip);
    
    // לחיצה להצגת/הסתרת טולטיפ
    const closeProfileMenu = () => {
      const profileMenu = document.getElementById('topBarProfileMenu');
      const profileBtn = document.getElementById('topBarProfileButton');
      if (profileMenu && !profileMenu.hasAttribute('hidden')) {
        profileMenu.setAttribute('hidden', '');
      }
      if (profileBtn) {
        profileBtn.setAttribute('aria-expanded', 'false');
      }
    };

    circle.addEventListener('click', (e) => {
      e.stopPropagation();
      closeProfileMenu(); // סגירת תפריט פרופיל אם פתוח – חלוקה הדדית | HYPER CORE TECH
      this.sync(); // עדכון מהסטטיסטיקות האמיתיות
      this.updateTooltip();
      const willOpen = !tooltip.classList.contains('visible');
      tooltip.classList.toggle('visible');
      circle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
    
    // סגירה בלחיצה מחוץ
    document.addEventListener('click', () => {
      closeP2PTooltip();
    });

    // חלק תפריט פרופיל (videos.js) – הבטחת הדדיות: פתיחת תפריט פרופיל סוגרת טולטיפ P2P | HYPER CORE TECH
    const profileBtn = document.getElementById('topBarProfileButton');
    if (profileBtn) {
      profileBtn.addEventListener('click', () => {
        closeP2PTooltip();
      }, true);
    }
  },
  
  // עדכון הטולטיפ
  updateTooltip() {
    const p2pEl = document.getElementById('tooltipP2P');
    const blossomEl = document.getElementById('tooltipBlossom');
    const cacheEl = document.getElementById('tooltipCache');
    const queueEl = document.getElementById('tooltipQueue');
    const peersEl = document.getElementById('tooltipPeers');
    const downloadPeersEl = document.getElementById('tooltipDownloadPeers');
    const downloadSpeedEl = document.getElementById('tooltipDownloadSpeed');
    const uploadFilesEl = document.getElementById('tooltipUploadFiles');
    const uploadSpeedEl = document.getElementById('tooltipUploadSpeed');
    
    if (p2pEl) p2pEl.textContent = this.p2p;
    if (blossomEl) blossomEl.textContent = this.blossom;
    if (cacheEl) cacheEl.textContent = this.cache;
    
    // קבלת נתונים נוספים מ-App
    const App = window.NostrApp || {};
    if (typeof App.getP2PStats === 'function') {
      const stats = App.getP2PStats();
      if (stats) {
        if (queueEl) queueEl.textContent = stats.shareQueueLength || 0;
        if (peersEl) peersEl.textContent = stats.peerCount || 0;
        
        // הורדות פעילות
        const download = stats.activeDownload;
        if (downloadPeersEl) {
          downloadPeersEl.textContent = download?.peers || '-';
        }
        const downloadProgressEl = document.getElementById('tooltipDownloadProgress');
        if (downloadProgressEl) {
          downloadProgressEl.textContent = download?.percent ? `${download.percent}%` : '-';
        }
        if (downloadSpeedEl) {
          const speed = download?.speed;
          downloadSpeedEl.textContent = speed ? this.formatSpeed(speed) : '-';
        }
        
        // העלאות פעילות
        if (uploadFilesEl) {
          uploadFilesEl.textContent = stats.activeTransfers || 0;
        }
        if (uploadSpeedEl) {
          const speed = stats.activeUpload?.speed;
          uploadSpeedEl.textContent = speed ? this.formatSpeed(speed) : '-';
        }
      }
    }
  },
  
  // פורמט מהירות
  formatSpeed(bytesPerSec) {
    if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  },
  
  // אתחול
  init() {
    this.createTooltip();
    this.sync();
    this.updateTooltip();
    // עדכון כל שנייה לתצוגה חיה - גם העיגול וגם הטולטיפ
    setInterval(() => {
      this.sync();
      this.updateTooltip();
    }, 1000);
  }
};

// מנורת העלאה - בוטלה והועברה לעיגול P2P (פועלת דרך המחלקות is-active/is-pending על p2pStatsCircle)
const uploadIndicatorUI = {
  unsubscribe: null,
  
  init() {
    // אין אלמנט נפרד; משתמשים ב-p2pStatsCircle
    const App = window.NostrApp || {};
    if (typeof App.onUploadStatusChange === 'function') {
      this.unsubscribe = App.onUploadStatusChange((status) => {
        this.updatePendingStatus(status);
      });
    }
    setInterval(() => this.update(), 1000);
  },
  
  getCircle() {
    return document.getElementById('p2pStatsCircle');
  },
  
  update() {
    const circle = this.getCircle();
    if (!circle) return;
    const App = window.NostrApp || {};
    if (typeof App.getP2PStats !== 'function') return;
    
    const stats = App.getP2PStats();
    const activeUploads = stats?.activeUploadCount || 0;
    let pendingCount = 0;
    if (typeof App.getPendingUploadsStatus === 'function') {
      const pendingStatus = App.getPendingUploadsStatus();
      pendingCount = pendingStatus.pending?.length || 0;
    }
    
    circle.classList.remove('is-active', 'is-pending', 'is-confirmed');
    if (activeUploads > 0) {
      circle.classList.add('is-active');
      circle.title = `סטטוס P2P: העלאות פעילות (${activeUploads})`;
    } else if (pendingCount > 0) {
      circle.classList.add('is-pending');
      circle.title = `סטטוס P2P: ממתין לאישור (${pendingCount})`;
    }
  },
  
  updatePendingStatus(status) {
    const circle = this.getCircle();
    if (!circle || !status) return;
    circle.classList.remove('is-active', 'is-pending', 'is-confirmed');
    if (status.state === 'waiting') {
      circle.classList.add('is-pending');
    } else if (status.state === 'uploading') {
      circle.classList.add('is-active');
    } else if (status.state === 'complete') {
      circle.classList.add('is-confirmed');
      setTimeout(() => circle.classList.remove('is-confirmed'), 2000);
    }
  },
  
  destroy() {
    if (this.unsubscribe) {
      try { this.unsubscribe(); } catch (e) {}
      this.unsubscribe = null;
    }
  }
};

// אתחול עיגול הסטטיסטיקות כשהדף נטען
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    p2pStatsUI.init();
    uploadIndicatorUI.init();
  }, 1000);
});

// חשיפה גלובלית לעדכון מקבצים אחרים
window.updateP2PStatsUI = (source) => p2pStatsUI.update(source);

// תור טעינה סדרתית לוידאו
let videoDownloadQueue = [];
let isProcessingVideoQueue = false;
let feedDownloadsPaused = false; // השהיית הורדות פיד בזמן העלאת פוסט | HYPER CORE TECH
const BOOTSTRAP_VIDEO_DELAY = 100; // 100ms בין הורדות - מופחת מ-2000ms
// חלק מניעת כפילויות (videos.js) – מעקב אחרי וידאו שכבר בתור או הורדו | HYPER CORE TECH
const videoDownloadedOrQueued = new Set();

function setFeedDownloadsPaused(paused) {
  feedDownloadsPaused = !!paused;
  console.log('[videos] feed downloads', feedDownloadsPaused ? 'PAUSED (upload in progress)' : 'RESUMED');
  if (!feedDownloadsPaused) {
    processVideoDownloadQueue().catch((err) => {
      console.warn('[videos] resume download queue failed', err);
    });
  }
}

// הוספת וידאו לתור ההורדה הסדרתי
function addToVideoDownloadQueue(videoEl, url, hash, mirrors, fallbackFn) {
  // מניעת כפילויות - בדיקה לפי hash או url
  const key = hash || url;
  if (videoDownloadedOrQueued.has(key)) {
    return; // כבר בתור או הורד
  }
  videoDownloadedOrQueued.add(key);
  
  videoDownloadQueue.push({ videoEl, url, hash, mirrors, fallbackFn });
  processVideoDownloadQueue();
}

// עיבוד תור ההורדות הסדרתי
async function processVideoDownloadQueue() {
  if (isProcessingVideoQueue || videoDownloadQueue.length === 0) return;
  if (feedDownloadsPaused) {
    console.log('[videos] download queue waiting — upload in progress');
    return;
  }
  
  isProcessingVideoQueue = true;
  
  // בדיקת מצב רשת
  let currentTier = 'BOOTSTRAP';
  if (typeof App.getNetworkTier === 'function') {
    try {
      const peerCount = typeof App.countActivePeers === 'function' 
        ? await App.countActivePeers() 
        : 0;
      currentTier = App.getNetworkTier(peerCount);
    } catch (err) {
      // ברירת מחדל BOOTSTRAP
    }
  }
  
  const useDelay = currentTier === 'BOOTSTRAP' || currentTier === 'UNKNOWN';
  const totalInQueue = videoDownloadQueue.length;
  let processedCount = 0;
  
  if (useDelay) {
    console.log(`%c╔════════════════════════════════════════╗`, 'color: #4CAF50; font-weight: bold');
    console.log(`%c║  🎬 טעינה סדרתית - ${totalInQueue} וידאו בתור      ║`, 'color: #4CAF50; font-weight: bold');
    console.log(`%c╚════════════════════════════════════════╝`, 'color: #4CAF50; font-weight: bold');
  }
  
  while (videoDownloadQueue.length > 0) {
    if (feedDownloadsPaused) {
      console.log('[videos] download queue paused mid-run — upload takes priority');
      break;
    }

    const { videoEl, url, hash, mirrors, fallbackFn } = videoDownloadQueue.shift();
    processedCount++;
    
    let loadedFromCache = false;
    
    try {
      if (typeof App.loadVideoWithCache === 'function') {
        const result = await App.loadVideoWithCache(videoEl, url, hash, mirrors);
        // בדיקה אם נטען מ-cache
        loadedFromCache = result?.source === 'cache';
      } else {
        fallbackFn();
      }
    } catch (err) {
      console.warn('Failed to load video with P2P/cache:', err);
      fallbackFn();
    }
    
    // השהייה רק במצב BOOTSTRAP, רק אם לא נטען מ-cache, ואם יש עוד בתור
    if (useDelay && !loadedFromCache && videoDownloadQueue.length > 0 && !feedDownloadsPaused) {
      await new Promise(resolve => setTimeout(resolve, BOOTSTRAP_VIDEO_DELAY));
    }
  }
  
  if (useDelay && !feedDownloadsPaused) {
    console.log(`%c╔════════════════════════════════════════╗`, 'color: #4CAF50; font-weight: bold');
    console.log(`%c║  ✅ טעינה סדרתית הושלמה - ${processedCount} וידאו    ║`, 'color: #4CAF50; font-weight: bold');
    console.log(`%c╚════════════════════════════════════════╝`, 'color: #4CAF50; font-weight: bold');
  }
  
  isProcessingVideoQueue = false;
}

// המתנה לטעינת App והפיד
function waitForApp() {
  return new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 100;

    const checkApp = () => {
      attempts++;
      // ממתין ל-pool ול-relayUrls מוכנים; לא תלוי ב-postsById
      if (window.NostrApp && window.NostrApp.pool && Array.isArray(window.NostrApp.relayUrls)) {
        console.log('[videos] waitForApp: pool+relays ready', { relays: window.NostrApp.relayUrls?.length || 0 });
        resolve(window.NostrApp);
      } else if (attempts >= maxAttempts) {
        console.warn('[videos] waitForApp: App לא נטען אחרי', maxAttempts, 'ניסיונות');
        resolve(window.NostrApp || {});
      } else {
        setTimeout(checkApp, 200);
      }
    };

    checkApp();
  });
}

// חלק יאללה וידאו (videos.js) – חיבור בקרי מדיה (Play/Pause)
function wireMediaControls(root = document) {
  const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
  scope.querySelectorAll('.videos-feed__media').forEach((mediaDiv) => {
    if (mediaDiv.dataset.mediaControlsWired === 'true') return;
    mediaDiv.dataset.mediaControlsWired = 'true';

    const toggleBtn = mediaDiv.querySelector('[data-play-toggle]');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (mediaDiv.dataset.state === 'playing') {
          pauseMedia(mediaDiv, { resetThumb: false, manual: true });
        } else {
          playMedia(mediaDiv, { manual: true });
        }
      });
    }

    // לחיצה על אזור המדיה תחליף בין ניגון להפסקה ידנית (ללא כפתור)
    mediaDiv.addEventListener('click', (event) => {
      // אם לחצו על כפתור ייעודי או דילוג או זמן, לא להפעיל את הטוגל
      if (event.target.closest('[data-play-toggle]') || event.target.closest('.video-skip-btn') || event.target.closest('.video-time-display') || event.target.closest('.videos-live-fs-btn') || event.target.closest('.videos-live-fs-close') || event.target.closest('.videos-game-fs-btn') || event.target.closest('.videos-game-release-btn') || event.target.closest('.videos-game-fs-close') || event.target.closest('.videos-game-fs-edge') || event.target.closest('.videos-feed__game-scroll-shield') || event.target.closest('.videos-feed__game-scroll-lane') || event.target.closest('.videos-feed__game-stage') || event.target.closest('.videos-feed__game-iframe') || event.target.closest('[data-game-tap-zone]')) return;
      if (mediaDiv.dataset.state === 'playing') {
        pauseMedia(mediaDiv, { resetThumb: false, manual: true });
      } else {
        playMedia(mediaDiv, { manual: true });
      }
    });
  });
}

// חלק יאללה וידאו (videos.js) – הפעלה אוטומטית של הווידאו הראשון
function autoPlayFirstVideo() {
  if (!selectors.stream) return;
  const firstCard = selectors.stream.querySelector('.videos-feed__card');
  if (!firstCard) return;
  const mediaDiv = firstCard.querySelector('.videos-feed__media');
  if (mediaDiv) {
    playMedia(mediaDiv, { manual: false, priority: true });
  }
}

// חלק יאללה וידאו (videos.js) – הפעלת מדיה עבור כרטיס נתון
function playMedia(mediaDiv, { manual = false, priority = false } = {}) {
  if (!mediaDiv) return;
  
  // אם זו לחיצה ידנית - מפעילים מצב PLAY גלובלי
  if (manual) {
    globalAutoplayEnabled = true;
    updateGlobalStopClass();
  }
  
  // אם לא במצב PLAY גלובלי ולא לחיצה ידנית - לא מפעילים
  if (!globalAutoplayEnabled && !manual) {
    return;
  }
  
  if (activeMediaDiv && activeMediaDiv !== mediaDiv) {
    pauseMedia(activeMediaDiv, { resetThumb: false });
  }

  const mediaType = mediaDiv.dataset.mediaType;
  if (!mediaType) return;

  if (mediaType === 'file') {
    const videoEl = mediaDiv.querySelector('video');
    if (!videoEl) return;
    mediaDiv.classList.add('videos-feed__media--ready');
    
    // ניסיון להפעיל עם צליל
    videoEl.muted = false;
    videoEl.play().catch(() => {
      // אם autoplay עם צליל נכשל, ננסה עם mute
      videoEl.muted = true;
      videoEl.play().catch(() => {
        // גם עם mute נכשל – להחזיר מצב נייח
        videoEl.pause();
      });
    });
  } else if (mediaType === 'hls-live') {
    playHlsLiveMedia(mediaDiv);
  } else if (mediaType === 'game-embed') {
    playGameEmbedMedia(mediaDiv);
  } else if (mediaType === 'youtube') {
    ensureYouTubeIframe(mediaDiv, { autoplay: true });
  }

  mediaDiv.dataset.state = 'playing';
  updatePlayToggleIcon(mediaDiv, true);
  // הסרת חיווי עצירה ידנית
  mediaDiv.classList.remove('is-paused');
  activeMediaDiv = mediaDiv;
}

// חלק יאללה וידאו (videos.js) – עצירת מדיה עבור כרטיס נתון
function pauseMedia(mediaDiv, { resetThumb = false, manual = false } = {}) {
  if (!mediaDiv) return;
  
  // אם זו עצירה ידנית - מכבים מצב PLAY גלובלי (חוזרים ל-STOP)
  if (manual) {
    globalAutoplayEnabled = false;
    updateGlobalStopClass();
  }
  
  const mediaType = mediaDiv.dataset.mediaType;
  if (!mediaType) return;

  if (mediaType === 'file' || mediaType === 'hls-live') {
    const videoEl = mediaDiv.querySelector('video');
    if (videoEl) {
      videoEl.pause();
    }
  } else if (mediaType === 'game-embed') {
    const App = window.NostrApp || {};
    // עצירה רכה – שומרת פרילוד כמו ערוץ חי | HYPER CORE TECH
    if (typeof App.softDeactivateGameMedia === 'function') {
      App.softDeactivateGameMedia(mediaDiv);
    } else if (typeof App.deactivateGameMedia === 'function') {
      App.deactivateGameMedia(mediaDiv);
    }
  } else if (mediaType === 'youtube') {
    const iframe = mediaDiv.querySelector('iframe');
    if (iframe) {
      iframe.contentWindow?.postMessage('{"event":"command","func":"pauseVideo","args":[]}', '*');
      if (resetThumb) {
        iframe.remove();
        restoreYouTubeThumbnail(mediaDiv);
      }
    } else if (resetThumb) {
      restoreYouTubeThumbnail(mediaDiv);
    }
  }

  mediaDiv.dataset.state = 'paused';
  updatePlayToggleIcon(mediaDiv, false);
  // הוספת חיווי עצירה רק אם זו עצירה ידנית; עצירות אוטומטיות (גלילה/כרטיס אחר) לא יציגו את האייקון
  if (manual) {
    mediaDiv.classList.add('is-paused');
  } else {
    mediaDiv.classList.remove('is-paused');
  }
  if (activeMediaDiv === mediaDiv) {
    activeMediaDiv = null;
  }
}

function updatePlayToggleIcon(mediaDiv, isPlaying) {
  const toggleBtn = mediaDiv.querySelector('[data-play-toggle]');
  if (!toggleBtn) return;
  toggleBtn.innerHTML = isPlaying ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
  toggleBtn.setAttribute('aria-label', isPlaying ? 'Pause video' : 'Play video');
}

// חלק שיחות (videos.js) – עצירת כל הווידיאו בפיד כשמתחילה שיחת קול/וידיאו | HYPER CORE TECH
function pauseAllFeedVideos() {
  console.log('[VIDEOS] Pausing all feed videos for call');
  
  // עצירת הווידיאו הפעיל אם יש
  if (activeMediaDiv) {
    pauseMedia(activeMediaDiv, { manual: false });
  }
  
  // עצירת כל הווידיאו בפיד
  const allVideos = document.querySelectorAll('video');
  allVideos.forEach(video => {
    try {
      if (!video.paused) {
        video.pause();
      }
    } catch (e) {
      console.warn('[VIDEOS] Failed to pause video', e);
    }
  });
  
  // עצירת כל ה-YouTube iframes
  const allIframes = document.querySelectorAll('iframe[src*="youtube"]');
  allIframes.forEach(iframe => {
    try {
      iframe.contentWindow?.postMessage('{"event":"command","func":"pauseVideo","args":[]}', '*');
    } catch (e) {
      console.warn('[VIDEOS] Failed to pause YouTube iframe', e);
    }
  });
  
  // כיבוי מצב autoplay גלובלי
  globalAutoplayEnabled = false;
  updateGlobalStopClass();
}

function ensureYouTubeIframe(mediaDiv, { autoplay = false } = {}) {
  let iframe = mediaDiv.querySelector('iframe');
  if (!iframe) {
    const youtubeId = mediaDiv.dataset.youtubeId;
    if (!youtubeId) return;
    iframe = document.createElement('iframe');
    iframe.className = 'videos-feed__media-iframe';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.allowFullscreen = true;
    iframe.src = `https://www.youtube.com/embed/${youtubeId}?enablejsapi=1&autoplay=${autoplay ? 1 : 0}&rel=0`;
    // הסתרת תמונה ממוזערת אם קיימת
    const thumb = mediaDiv.querySelector('.videos-feed__media-thumb');
    if (thumb) thumb.style.opacity = '0';
    mediaDiv.insertBefore(iframe, mediaDiv.firstChild);
  } else if (autoplay) {
    iframe.contentWindow?.postMessage('{"event":"command","func":"playVideo","args":[]}', '*');
  }
}

function restoreYouTubeThumbnail(mediaDiv) {
  const youtubeId = mediaDiv.dataset.youtubeId;
  if (!youtubeId) return;
  if (!mediaDiv.querySelector('.videos-feed__media-thumb')) {
    const thumb = document.createElement('img');
    thumb.src = `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`;
    thumb.alt = 'YouTube Video';
    thumb.className = 'videos-feed__media-thumb';
    // fallback לתמונה קטנה יותר אם maxresdefault לא קיים
    thumb.onerror = () => {
      thumb.src = `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
      thumb.onerror = null;
    };
    mediaDiv.insertBefore(thumb, mediaDiv.firstChild);
  } else {
    mediaDiv.querySelector('.videos-feed__media-thumb').style.opacity = '1';
  }
}

// חלק ערוץ חי (videos.js) – הפעלת HLS עם מסך חיפוש תחנה | HYPER CORE TECH
async function playHlsLiveMedia(mediaDiv) {
  if (!mediaDiv) return;
  const App = window.NostrApp || {};
  const videoEl = mediaDiv.querySelector('video');
  if (!videoEl) return;

  if (typeof App.setTuningVisible === 'function') {
    App.setTuningVisible(mediaDiv, true, 'מחפש ערוץ...');
  }
  if (typeof App.ensureLiveBadge === 'function') {
    App.ensureLiveBadge(mediaDiv);
  }

  try {
    if (mediaDiv.dataset.livePrepared === '1') {
      videoEl.muted = false;
      await videoEl.play().catch(async () => {
        videoEl.muted = true;
        await videoEl.play().catch(() => {});
      });
      if (typeof App.setTuningVisible === 'function') {
        App.setTuningVisible(mediaDiv, false);
      }
      return;
    }

    if (typeof App.prepareLiveMedia === 'function') {
      const result = await App.prepareLiveMedia(mediaDiv, {
        autoplay: true,
        tuningLabel: 'מחפש ערוץ...',
      });
      if (result && result.ok) {
        videoEl.muted = false;
        await videoEl.play().catch(async () => {
          videoEl.muted = true;
          await videoEl.play().catch(() => {});
        });
      }
    }
  } catch (err) {
    console.warn('[videos] HLS live play failed', err);
    if (typeof App.setTuningVisible === 'function') {
      App.setTuningVisible(mediaDiv, true, 'לא מצליח לתפוס ערוץ');
    }
  }
}

// חלק משחק בפיד (videos.js) – טעינת iframe למשחק HTML5 | HYPER CORE TECH
function playGameEmbedMedia(mediaDiv) {
  if (!mediaDiv) return;
  const App = window.NostrApp || {};
  if (typeof App.activateGameMedia === 'function') {
    App.activateGameMedia(mediaDiv);
  } else {
    const url = mediaDiv.dataset.gameUrl;
    let iframe = mediaDiv.querySelector('iframe.videos-feed__game-iframe');
    if (!iframe && url) {
      iframe = document.createElement('iframe');
      iframe.className = 'videos-feed__game-iframe';
      iframe.src = url;
      mediaDiv.insertBefore(iframe, mediaDiv.firstChild);
    }
  }
  mediaDiv.classList.add('videos-feed__media--ready');
}

// חלק יאללה וידאו (videos.js) – שאילת פוסטים לפי רשת המשתמש (authors)
async function fetchNetworkNotes(authors = [], limit = 100, sinceOverride = undefined) {
  const app = window.NostrApp;
  if (!app || !app.pool || !Array.isArray(app.relayUrls) || app.relayUrls.length === 0) return [];
  if (!Array.isArray(authors) || authors.length === 0) return [];
  // אם יש sinceOverride (מהמטמון) - נשתמש בו, אחרת 30 יום
  const since = sinceOverride || Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30;
  const networkTag = getNetworkTag();
  const filters = [{ kinds: [1], authors, since, limit, '#t': [networkTag] }];
  try {
    if (typeof app.pool.list === 'function') {
      const r = await app.pool.list(app.relayUrls, filters);
      if (Array.isArray(r) && r.length) return r;
    }
    if (typeof app.pool.listMany === 'function') {
      const r = await app.pool.listMany(app.relayUrls, filters);
      if (Array.isArray(r) && r.length) return r;
    }
    if (typeof app.pool.querySync === 'function') {
      const res = await app.pool.querySync(app.relayUrls, filters[0]);
      const ev = Array.isArray(res) ? res : (Array.isArray(res?.events) ? res.events : []);
      if (ev.length) return ev;
    }
  } catch (_) {
    // ignore and fallback to empty
  }
  return [];
}

const App = window.NostrApp || (window.NostrApp = {});

// חלק שיחות (videos.js) – חשיפת פונקציה לעצירת וידיאו בפיד | HYPER CORE TECH
App.pauseAllFeedVideos = pauseAllFeedVideos;
App.setFeedDownloadsPaused = setFeedDownloadsPaused;

const state = {
  videos: [],
  currentIndex: 0,
  incrementalRender: null,
  firstCardRendered: false,
  pendingOldCards: null,
  downloadedBytes: 0, // מעקב אחרי כמות הנתונים שהורדו
};

// חלק טעינה (videos.js) – סף מינימלי להורדה לפני סגירת מסך הטעינה | HYPER CORE TECH
const MIN_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20MB מינימום

const selectors = {
  stream: null,
  status: null,
};

let activeMediaDiv = null;
let intersectionObserver = null;

const FEED_CACHE_KEY = 'videos_feed_cache_v3';
const FEED_CACHE_MAX_SIZE = 1024 * 1024 * 1024; // 1GB מקסימום
const FEED_CACHE_CLEANUP_BATCH = 20; // כמה פוסטים למחוק בכל פעם
const FEED_CACHE_CLEANUP_THRESHOLD = 0.9; // התחל ניקוי ב-90% מהנפח

// חלק הגבלת טעינה (videos.js) – מניעת טעינת יותר מדי פוסטים בהתחלה | HYPER CORE TECH
const INITIAL_LOAD_LIMIT = 50; // מספר פוסטים מקסימלי בטעינה ראשונית
const LOAD_MORE_BATCH = 20; // מספר פוסטים בכל טעינה נוספת
let isLoadingMore = false; // מונע טעינות כפולות
let loadMoreObserver = null; // observer לזיהוי סוף הפיד

function getNetworkTag() {
  const app = window.NostrApp;
  if (app && typeof app.NETWORK_TAG === 'string' && app.NETWORK_TAG.trim()) {
    return app.NETWORK_TAG.trim();
  }
  return 'israel-network';
}

function sanitizeCachedVideo(video) {
  if (!video || typeof video !== 'object') {
    return null;
  }
  const clone = { ...video };
  clone.mirrors = Array.isArray(video.mirrors) ? video.mirrors.slice(0, 10) : [];
  // תאימות לאחור – לינק m3u8 שנשמר כ־videoUrl הופך לערוץ חי | HYPER CORE TECH
  if (!clone.liveUrl && clone.videoUrl && isHlsLiveLink(clone.videoUrl)) {
    clone.liveUrl = clone.videoUrl;
    clone.videoUrl = null;
  }
  if (!clone.gameUrl && clone.videoUrl && isPlayableGameLink(clone.videoUrl)) {
    clone.gameUrl = clone.videoUrl;
    clone.videoUrl = null;
  }
  return clone;
}

function saveFeedCache(videos) {
  try {
    const trimmed = (videos || [])
      .map((video) => sanitizeCachedVideo(video))
      .filter(Boolean);
    const payload = {
      timestamp: Date.now(),
      videos: trimmed,
    };
    const jsonStr = JSON.stringify(payload);
    
    // בדיקת גודל לפני שמירה
    const sizeBytes = new Blob([jsonStr]).size;
    if (sizeBytes > FEED_CACHE_MAX_SIZE * FEED_CACHE_CLEANUP_THRESHOLD) {
      // ניקוי הדרגתי - מחיקת פוסטים ישנים
      console.log('[videos] cache approaching limit, cleaning old posts', { sizeMB: Math.round(sizeBytes / 1024 / 1024) });
      const cleaned = cleanupOldPosts(trimmed);
      payload.videos = cleaned;
      window.localStorage.setItem(FEED_CACHE_KEY, JSON.stringify(payload));
    } else {
      window.localStorage.setItem(FEED_CACHE_KEY, jsonStr);
    }
  } catch (err) {
    if (err.name === 'QuotaExceededError') {
      // אם נגמר המקום - נקה ונסה שוב
      console.warn('[videos] storage quota exceeded, forcing cleanup');
      forceCleanupCache();
    } else {
      console.warn('[videos] failed saving feed cache', err);
    }
  }
}

// חלק מטמון (videos.js) – ניקוי הדרגתי של פוסטים ישנים | HYPER CORE TECH
function cleanupOldPosts(videos) {
  if (!Array.isArray(videos) || videos.length <= FEED_CACHE_CLEANUP_BATCH) {
    return videos;
  }
  // מיון לפי תאריך יצירה (חדש לישן)
  const sorted = [...videos].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  // הסרת הפוסטים הישנים ביותר
  const cleaned = sorted.slice(0, sorted.length - FEED_CACHE_CLEANUP_BATCH);
  console.log('[videos] cleaned old posts', { before: videos.length, after: cleaned.length });
  return cleaned;
}

// חלק מטמון (videos.js) – ניקוי כפוי כשנגמר המקום | HYPER CORE TECH
function forceCleanupCache() {
  try {
    const raw = window.localStorage.getItem(FEED_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.videos)) return;
    
    // מחיקת 30% מהפוסטים הישנים
    const sorted = [...parsed.videos].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const keepCount = Math.floor(sorted.length * 0.7);
    const cleaned = sorted.slice(0, keepCount);
    
    const payload = { timestamp: Date.now(), videos: cleaned };
    window.localStorage.setItem(FEED_CACHE_KEY, JSON.stringify(payload));
    console.log('[videos] force cleanup done', { before: parsed.videos.length, after: cleaned.length });
  } catch (err) {
    // אם גם זה נכשל - מחק הכל ותתחיל מחדש
    console.warn('[videos] force cleanup failed, clearing cache', err);
    window.localStorage.removeItem(FEED_CACHE_KEY);
  }
}

function loadFeedCache() {
  try {
    const raw = window.localStorage.getItem(FEED_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.videos)) {
      return null;
    }
    // אין TTL - המטמון תקף לעולם (עד שנגמר המקום)
    return parsed.videos
      .map((video) => sanitizeCachedVideo(video))
      .filter(Boolean);
  } catch (err) {
    console.warn('[videos] failed loading feed cache', err);
    return null;
  }
}

// חלק מטמון (videos.js) – קבלת מידע על המטמון לצורך טעינה חכמה | HYPER CORE TECH
function getCacheInfo() {
  try {
    const raw = window.localStorage.getItem(FEED_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.videos)) return null;
    
    // מציאת ה-timestamp של הפוסט החדש ביותר במטמון
    let newestPostTime = 0;
    parsed.videos.forEach(v => {
      if (v && v.createdAt && v.createdAt > newestPostTime) {
        newestPostTime = v.createdAt;
      }
    });
    
    return {
      lastUpdate: parsed.timestamp || 0,
      videoCount: parsed.videos.length,
      newestPostTime: newestPostTime,
      cachedIds: new Set(parsed.videos.map(v => v?.id).filter(Boolean))
    };
  } catch (err) {
    return null;
  }
}

// חלק מטמון (videos.js) – בדיקה אם צריך לרענן מהרשת | HYPER CORE TECH
// תמיד נבדוק אם יש פוסטים חדשים, אבל נוריד רק את החדשים (since = הפוסט האחרון)
function shouldRefreshFromNetwork() {
  return true; // תמיד נבדוק - הסינון נעשה ב-loadVideos לפי newestPostTime
}

function hydrateFeedFromCache() {
  const cached = loadFeedCache();
  if (Array.isArray(cached) && cached.length) {
    // סינון פוסטים מחוקים מהמטמון
    const app = window.NostrApp;
    const deletedIds = app?.deletedEventIds || new Set();
    const filtered = cached.filter(video => !deletedIds.has(video.id));
    console.log('[videos] hydrate feed from cache', { 
      total: cached.length, 
      afterFilter: filtered.length,
      deletedCount: cached.length - filtered.length
    });
    state.videos = filtered;
    renderVideos();
    // חלק לייקים מהקאש (videos.js) – טעינת לייקים ותגובות ברקע לפוסטים מהמטמון | HYPER CORE TECH
    const eventIds = filtered.map(v => v.id);
    if (eventIds.length > 0) {
      loadLikesAndCommentsForVideos(eventIds).then(() => {
        // עדכון כפתורי הלייק אחרי שהנתונים נטענו
        eventIds.forEach(id => updateVideoLikeButton(id));
      }).catch(err => console.warn('[videos] Failed to load likes for cached videos', err));
    }
    return true;
  }
  return false;
}

function removeVideoFromState(eventId) {
  if (!eventId) return;
  const index = state.videos.findIndex((video) => video.id === eventId);
  if (index >= 0) {
    state.videos.splice(index, 1);
    saveFeedCache(state.videos);
  }
}

function removeVideoCard(eventId) {
  if (!eventId || !selectors.stream) return;
  const card = selectors.stream.querySelector(`.videos-feed__card[data-event-id="${eventId}"]`);
  if (card) {
    card.remove();
  }
}

function truncateFeedLength() {
  if (state.videos.length <= FEED_CACHE_LIMIT) {
    return;
  }
  const removed = state.videos.splice(FEED_CACHE_LIMIT);
  removed.forEach((video) => removeVideoCard(video.id));
}

function markCardMediaReady(card) {
  if (!card) return;
  card.dataset.mediaReady = 'ready';
  card.style.removeProperty('display');
}

function hideCardUntilMediaReady(card) {
  if (!card) return;
  card.dataset.mediaReady = 'pending';
  card.style.display = 'none';
}

// חלק תאימות מכשירים (videos.js) – הצגת placeholder במקום מחיקת כרטיסיה כשהמדיה נכשלת | HYPER CORE TECH
function handleCardMediaFailure(card, videoId, error) {
  if (error) {
    console.warn('[videos] media failed', { videoId, error: error?.message || error });
  }
  
  // במקום למחוק את הכרטיסיה, נציג placeholder עם אפשרות לנסות שוב
  if (card) {
    const mediaDiv = card.querySelector('.videos-feed__media');
    if (mediaDiv) {
      // הסרת אלמנט הווידאו הכושל
      const videoEl = mediaDiv.querySelector('video');
      if (videoEl) videoEl.remove();
      
      // הוספת placeholder
      const placeholder = document.createElement('div');
      placeholder.className = 'videos-feed__media-placeholder';
      placeholder.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,0.6);text-align:center;padding:20px;">
          <i class="fa-solid fa-video-slash" style="font-size:48px;margin-bottom:16px;opacity:0.5;"></i>
          <p style="margin:0 0 12px 0;font-size:14px;">לא ניתן לטעון את הסרטון</p>
          <button class="videos-feed__retry-btn" style="padding:8px 16px;border-radius:20px;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.2);color:#fff;cursor:pointer;font-size:13px;">
            <i class="fa-solid fa-rotate-right" style="margin-left:6px;"></i>
            נסה שוב
          </button>
        </div>
      `;
      mediaDiv.appendChild(placeholder);
      
      // כפתור נסה שוב - טעינה מחדש של הוידאו בלבד ללא רענון הדף | HYPER CORE TECH
      const retryBtn = placeholder.querySelector('.videos-feed__retry-btn');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          // הסרת ה-placeholder וניסיון טעינה מחדש של הוידאו
          placeholder.remove();
          const videoUrl = mediaDiv.dataset.videoUrl;
          if (videoUrl) {
            const newVideo = document.createElement('video');
            newVideo.controls = false;
            newVideo.muted = false;
            newVideo.loop = true;
            newVideo.playsInline = true;
            newVideo.autoplay = false;
            newVideo.setAttribute('playsinline', 'true');
            newVideo.setAttribute('webkit-playsinline', 'true');
            newVideo.preload = 'auto';
            newVideo.className = 'videos-feed__media-video';
            newVideo.src = videoUrl;
            newVideo.load();
            mediaDiv.insertBefore(newVideo, mediaDiv.firstChild);
            newVideo.addEventListener('error', () => {
              handleCardMediaFailure(card, videoId, new Error('retry failed'));
            }, { once: true });
            console.log('[videos] Retrying video load:', videoId);
          } else {
            // אין URL - טעינת פוסטים חדשים ברקע
            loadVideos().catch(err => console.warn('[videos] Retry loadVideos failed', err));
          }
        });
      }
      
      // סימון הכרטיסיה כמוכנה כדי שתוצג
      markCardMediaReady(card);
    }
  }
}

function mountCard(card, { prepend = false } = {}) {
  if (!selectors.stream || !card) return;
  if (prepend) {
    selectors.stream.insertBefore(card, selectors.stream.firstChild || null);
  } else {
    selectors.stream.appendChild(card);
  }
  wireActions(card);
  wireMediaControls(card);
  observeVideoCard(card);
  if (!state.firstCardRendered) {
    hideLoadingAnimation();
    if (selectors.status) {
      selectors.status.style.display = 'none';
    }
    state.firstCardRendered = true;
    
    // חלק שחזור מיקום (videos.js) – שחזור מיקום גלילה אחרי טעינת הפוסט הראשון | HYPER CORE TECH
    if (savedScrollPosition > 0) {
      const viewport = document.querySelector('.videos-feed__viewport');
      if (viewport) {
        // המתנה קצרה לאחר שהתוכן נטען
        setTimeout(() => {
          viewport.scrollTop = savedScrollPosition;
          savedScrollPosition = 0; // איפוס אחרי שחזור
        }, 50);
      }
    } else {
      autoPlayFirstVideo();
    }
  }
}

function prependVideoCard(video, { forceShow = false } = {}) {
  if (!selectors.stream) return;
  const existing = selectors.stream.querySelector(`.videos-feed__card[data-event-id="${video.id}"]`);
  if (existing) {
    existing.remove();
  }
  const { card, mediaReadyPromise } = renderVideoCard(video);

  // פוסט עצמי: מציגים מיד בראש הפיד, גם לפני שהמדיה מוכנה | HYPER CORE TECH
  if (forceShow) {
    mountCard(card, { prepend: true });
    markCardMediaReady(card);
    mediaReadyPromise.catch((err) => handleCardMediaFailure(card, video.id, err));
    return;
  }

  mediaReadyPromise
    .then(() => {
      mountCard(card, { prepend: true });
    })
    .catch((err) => {
      // בעבר כשל מדיה השאיר כרטיס מחוץ ל-DOM — עכשיו מציגים עם placeholder | HYPER CORE TECH
      handleCardMediaFailure(card, video.id, err);
      if (!card.isConnected) {
        mountCard(card, { prepend: true });
      }
    });
}

function upsertVideoInState(video, options = {}) {
  if (!video || !video.id) return;
  const existingIndex = state.videos.findIndex((v) => v.id === video.id);
  if (existingIndex > -1) {
    state.videos.splice(existingIndex, 1);
  }
  state.videos.unshift(video);
  truncateFeedLength();
  saveFeedCache(state.videos);
  prependVideoCard(video, options);
}

// חלק עדכון בזמן אמת (videos.js) – המרת אירוע Nostr לפריט פיד וידאו | HYPER CORE TECH
function parseEventToVideoItem(event, currentApp) {
  if (!event || event.kind !== 1) return null;
  if (currentApp?.deletedEventIds?.has(event.id)) return null;

  const lines = String(event.content || '').split('\n');
  const mediaLinks = [];
  const textLines = [];

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('http') || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
      mediaLinks.push(trimmed);
    } else {
      textLines.push(trimmed);
    }
  });

  let youtubeId = mediaLinks.map(parseYouTube).find(Boolean) || null;
  let liveUrl = mediaLinks.find(isHlsLiveLink) || null;
  let gameUrl = mediaLinks.find(isPlayableGameLink) || null;
  let videoUrl = mediaLinks.find(isVideoLink) || null;
  let imageUrl = mediaLinks.find(isImageLink) || null;
  let mediaHash = '';
  const mediaMirrors = [];

  if (Array.isArray(event.tags)) {
    event.tags.forEach((tag) => {
      if (!Array.isArray(tag)) return;
      if (tag[0] === 'media' && tag[2]) {
        const mime = String(tag[1] || '');
        const tagUrl = String(tag[2]);
        const tagHash = tag[3] || '';
        if (mime.includes('mpegurl') || isHlsLiveLink(tagUrl)) {
          liveUrl = liveUrl || tagUrl;
        } else if (mime === 'text/html' || mime.includes('html') || isPlayableGameLink(tagUrl)) {
          gameUrl = gameUrl || tagUrl;
        } else if (mime.startsWith('video/') || isVideoLink(tagUrl)) {
          videoUrl = videoUrl || tagUrl;
          if (tagHash) mediaHash = tagHash;
        } else if (mime.startsWith('image/') || isImageLink(tagUrl)) {
          imageUrl = imageUrl || tagUrl;
        } else if (!videoUrl && !imageUrl && !liveUrl && !gameUrl) {
          videoUrl = tagUrl;
          if (tagHash) mediaHash = tagHash;
        }
      }
      if (tag[0] === 't' && String(tag[1] || '').toLowerCase() === 'live-hls') {
        // סימון מפורש מערוץ חי – אם יש קישור כלשהו נשתמש בו
        if (!liveUrl) {
          const httpLink = mediaLinks.find((l) => /^https?:\/\//i.test(l));
          if (httpLink) liveUrl = httpLink;
        }
      }
      if (tag[0] === 't' && String(tag[1] || '').toLowerCase() === 'game-embed') {
        if (!gameUrl) {
          const httpLink = mediaLinks.find((l) => /^https?:\/\//i.test(l) && !isHlsLiveLink(l));
          if (httpLink) gameUrl = httpLink;
        }
      }
      if (tag[0] === 'mirror' && tag[1]) {
        mediaMirrors.push(tag[1]);
      }
    });
  }

  // קישור http בלי סיומת וללא תמונה — נחשב וידאו (Blossom)
  if (!videoUrl && !imageUrl && !youtubeId && !liveUrl && !gameUrl) {
    const httpLink = mediaLinks.find((l) => /^https?:\/\//i.test(l) && !isImageLink(l));
    if (httpLink) {
      if (isHlsLiveLink(httpLink)) liveUrl = httpLink;
      else if (isPlayableGameLink(httpLink)) gameUrl = httpLink;
      else videoUrl = httpLink;
    }
  }

  if (!videoUrl && !imageUrl && !youtubeId && !liveUrl && !gameUrl) return null;

  const profileData = currentApp?.profileCache?.get(event.pubkey) || {};
  return {
    id: event.id,
    pubkey: event.pubkey,
    content: textLines.join(' '),
    youtubeId,
    liveUrl,
    gameUrl,
    videoUrl: (liveUrl || gameUrl) ? null : videoUrl,
    imageUrl,
    hash: mediaHash || '',
    mirrors: mediaMirrors,
    fx: resolveFxValue(event, imageUrl),
    createdAt: event.created_at || 0,
    authorName: profileData.name || `משתמש ${String(event.pubkey || '').slice(0, 8)}`,
    authorPicture: profileData.picture || '',
    authorInitials: profileData.initials || 'AN',
    likes: 0,
    comments: 0,
  };
}

// חלק עדכון בזמן אמת (videos.js) – הוספת פוסט חדש לפיד מיד אחרי פרסום | HYPER CORE TECH
function onVideoPostPublished(signedEvent) {
  if (!signedEvent || !signedEvent.id) {
    console.warn('[videos] onVideoPostPublished: invalid event');
    return;
  }

  const app = window.NostrApp || {};
  if (!(app.postsById instanceof Map)) {
    app.postsById = new Map();
  }
  app.postsById.set(signedEvent.id, signedEvent);

  if (!(app.eventAuthorById instanceof Map)) {
    app.eventAuthorById = new Map();
  }
  const authorKey = typeof signedEvent.pubkey === 'string' ? signedEvent.pubkey.toLowerCase() : '';
  if (authorKey) {
    app.eventAuthorById.set(signedEvent.id, authorKey);
  }

  const video = parseEventToVideoItem(signedEvent, app);
  if (!video) {
    console.warn('[videos] onVideoPostPublished: no displayable media', { id: signedEvent.id });
    return;
  }

  try {
    registerVideoSourceEvent(signedEvent);
  } catch (_) {}

  upsertVideoInState(video, { forceShow: true });

  const viewport = document.querySelector('.videos-feed__viewport');
  if (viewport) {
    viewport.scrollTo({ top: 0, behavior: 'smooth' });
  }

  console.log('[videos] onVideoPostPublished: added to feed', { id: video.id });
}

App.onVideoPostPublished = onVideoPostPublished;

// חלק יאללה וידאו (videos.js) – פונקציית עזר להבאת תג הרשת העיקרי
function getNetworkTag() {
  const app = window.NostrApp;
  if (app && typeof app.NETWORK_TAG === 'string' && app.NETWORK_TAG.trim()) {
    return app.NETWORK_TAG.trim();
  }
  return 'israel-network';
}

// חלק יאללה וידאו (videos.js) – טעינת מחיקות עם קאש לזיכרון | HYPER CORE TECH
const DELETIONS_CACHE_KEY = 'videos_deletions_cache_v1';
const DELETIONS_CACHE_TTL = 5 * 60 * 1000; // 5 דקות
let deletionsLoadedOnce = false;

function loadDeletionsFromCache() {
  try {
    const cached = localStorage.getItem(DELETIONS_CACHE_KEY);
    if (!cached) return null;
    const { ids, timestamp } = JSON.parse(cached);
    if (Date.now() - timestamp > DELETIONS_CACHE_TTL) return null;
    return Array.isArray(ids) ? ids : null;
  } catch { return null; }
}

function saveDeletionsToCache(ids) {
  try {
    localStorage.setItem(DELETIONS_CACHE_KEY, JSON.stringify({ ids, timestamp: Date.now() }));
  } catch {}
}

async function loadDeletionsFirst() {
  const app = window.NostrApp;
  
  // אם כבר נטענו מחיקות בסשן הזה - דלג
  if (deletionsLoadedOnce && app?.deletedEventIds?.size > 0) {
    console.log('[videos] deletions already loaded, skipping');
    return;
  }
  
  // ניסיון לטעון מקאש מקומי קודם
  const cachedIds = loadDeletionsFromCache();
  if (cachedIds && cachedIds.length > 0) {
    if (!app.deletedEventIds) app.deletedEventIds = new Set();
    cachedIds.forEach(id => app.deletedEventIds.add(id));
    deletionsLoadedOnce = true;
    console.log('[videos] deletions loaded from cache:', cachedIds.length);
    return;
  }
  
  if (!app || !app.pool || !Array.isArray(app.relayUrls) || app.relayUrls.length === 0) {
    return;
  }

  const networkTag = getNetworkTag();
  const deletionFilters = [{ kinds: [5], '#t': [networkTag], limit: 300 }];
  
  if (app.adminPublicKeys instanceof Set && app.adminPublicKeys.size > 0) {
    deletionFilters.push({ kinds: [5], authors: Array.from(app.adminPublicKeys), limit: 200 });
  }

  try {
    let deletionEvents = [];
    if (typeof app.pool.list === 'function') {
      deletionEvents = await app.pool.list(app.relayUrls, deletionFilters);
    } else if (typeof app.pool.querySync === 'function') {
      const res = await app.pool.querySync(app.relayUrls, deletionFilters[0]);
      deletionEvents = Array.isArray(res) ? res : (Array.isArray(res?.events) ? res.events : []);
    }

    if (Array.isArray(deletionEvents) && deletionEvents.length > 0) {
      const deletedIds = [];
      deletionEvents.forEach(event => {
        if (event && event.kind === 5 && typeof app.registerDeletion === 'function') {
          app.registerDeletion(event);
          if (Array.isArray(event.tags)) {
            event.tags.forEach(tag => {
              if (tag[0] === 'e' && tag[1]) deletedIds.push(tag[1]);
            });
          }
        }
      });
      saveDeletionsToCache(deletedIds);
      deletionsLoadedOnce = true;
      console.log('[videos] deletions loaded from network:', deletedIds.length);
    }
  } catch (err) {
    console.warn('[videos] loadDeletionsFirst failed', err);
  }
}

// חלק יאללה וידאו (videos.js) – בניית פילטרים לשימוש משותף בין מודולים | HYPER CORE TECH
function buildVideoFeedFilters() {
  const app = window.NostrApp || {};

  if (typeof app.buildCoreFeedFilters === 'function' && app.buildCoreFeedFilters !== buildVideoFeedFilters) {
    try {
      return app.buildCoreFeedFilters();
    } catch (err) {
      console.warn('[videos] buildCoreFeedFilters failed, using local filters', err);
    }
  }

  const networkTag = getNetworkTag();
  const filters = [{ kinds: [1], '#t': [networkTag], limit: 200 }];
  const viewerKey = typeof app.publicKey === 'string' ? app.publicKey : '';

  if (viewerKey) {
    filters.push({ kinds: [1], authors: [viewerKey], limit: 50 });

    const deletionAuthors = new Set();
    deletionAuthors.add(viewerKey.toLowerCase());
    if (app.adminPublicKeys instanceof Set) {
      app.adminPublicKeys.forEach((key) => {
        if (typeof key === 'string' && key) {
          deletionAuthors.add(key.toLowerCase());
        }
      });
    }

    // תמיד מביאים מחיקות לפי תגית רשת כדי לקבל מחיקות מכל המשתמשים
    filters.push({ kinds: [5], '#t': [networkTag], limit: 200 });
    // בנוסף, מביאים מחיקות ספציפיות מאדמינים (גם אם אין להם תגית רשת)
    if (deletionAuthors.size > 0) {
      filters.push({ kinds: [5], authors: Array.from(deletionAuthors), limit: 100 });
    }
    // לוג לבדיקת פילטרי מחיקה
    console.log('%c[DELETE_DEBUG] videos deletion filter', 'color: #FF5722; font-weight: bold', {
      deletionAuthors: Array.from(deletionAuthors),
      adminKeys: app.adminPublicKeys instanceof Set ? Array.from(app.adminPublicKeys) : [],
      viewerKey,
    });

    filters.push({ kinds: [7], '#t': [networkTag], limit: 500 });

    const datingKind = typeof app.DATING_LIKE_KIND === 'number' ? app.DATING_LIKE_KIND : 9000;
    const datingFilter = { kinds: [datingKind], '#p': [viewerKey], limit: 200 };
    if (networkTag) {
      datingFilter['#t'] = [networkTag];
    }
    filters.push(datingFilter);

    const followKind = typeof app.FOLLOW_KIND === 'number' ? app.FOLLOW_KIND : 40010;
    filters.push({ kinds: [followKind], '#p': [viewerKey], limit: 200 });
  } else {
    filters.push({ kinds: [5], '#t': [networkTag], limit: 200 });
    filters.push({ kinds: [7], '#t': [networkTag], limit: 500 });
  }

  return filters;
}

// חלק יאללה וידאו (videos.js) – בדיקה האם אירוע שייך לרשת שלנו
function eventHasNetworkTag(event, networkTag) {
  if (!event || !Array.isArray(event.tags)) {
    return false;
  }
  return event.tags.some((tag) => Array.isArray(tag) && tag[0] === 't' && tag[1] === networkTag);
}

// חלק יאללה וידאו (videos.js) – מסנן מערכי אירועים לפי תג הרשת
function filterEventsByNetwork(events, networkTag) {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }
  return events.filter((event) => eventHasNetworkTag(event, networkTag));
}

// חלק יאללה וידאו (videos.js) – הצגת/הסתרת אנימציית טעינה
function showLoadingAnimation() {
  const overlay = document.getElementById('videosLoadingOverlay');
  if (overlay) {
    overlay.classList.remove('hidden');
  }
  // איפוס מד הטעינה
  setLoadingProgress(0);
  setLoadingStatus('מתחבר לרשת...');
}

function hideLoadingAnimation() {
  const overlay = document.getElementById('videosLoadingOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
  }
}

// חלק יאללה וידאו (videos.js) – עדכון מד טעינה והודעות סטטוס | HYPER CORE TECH
function setLoadingProgress(percent) {
  const fill = document.getElementById('videosLoadingBarFill');
  if (fill) {
    fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }
}

function setLoadingStatus(message) {
  const status = document.getElementById('videosLoadingStatus');
  if (status) {
    status.textContent = message;
  }
}

// חלק יאללה וידאו (videos.js) – יצירת הודעת סטטוס למשתמש
function setStatus(message) {
  if (!selectors.status) {
    return;
  }
  selectors.status.textContent = message;
  selectors.status.style.display = 'block';
}

// חלק יאללה וידאו (videos.js) – זיהוי אם קישור הוא YouTube
function parseYouTube(link) {
  if (!link) return null;
  const shortMatch = link.match(/^https?:\/\/youtu\.be\/([\w-]{11})(?:\?.*)?$/i);
  if (shortMatch) return shortMatch[1];
  const longMatch = link.match(/^https?:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})(?:&.*)?$/i);
  if (longMatch) return longMatch[1];
  const embedMatch = link.match(/^https?:\/\/www\.youtube\.com\/embed\/([\w-]{11})(?:\?.*)?$/i);
  if (embedMatch) return embedMatch[1];
  return null;
}

// חלק יאללה וידאו (videos.js) – זיהוי אם קישור הוא וידאו
function isHlsLiveLink(link) {
  const App = window.NostrApp || {};
  if (typeof App.isHlsLiveUrl === 'function') return App.isHlsLiveUrl(link);
  if (!link) return false;
  return /\.m3u8(\?|#|$)/i.test(link) || /(mediatailor|amagi\.tv|\/hls\/)/i.test(link);
}

function isPlayableGameLink(link) {
  const App = window.NostrApp || {};
  if (typeof App.isPlayableGameUrl === 'function') return App.isPlayableGameUrl(link);
  if (!link) return false;
  if (!/^https:\/\//i.test(link)) return false;
  if (/\.(mp4|webm|m3u8|jpg|png)(\?|#|$)/i.test(link)) return false;
  return /\.github\.io\//i.test(link) || /\/(game|games|play|mobile|mobileapp)(\/|$)/i.test(link);
}

function isVideoLink(link) {
  if (!link) return false;
  if (isHlsLiveLink(link)) return false;
  if (isPlayableGameLink(link)) return false;
  if (link.startsWith('data:video')) return true;
  if (link.startsWith('blob:')) return true;
  if (/\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i.test(link)) return true;
  // Blossom / CDN בלי סיומת קובץ — לא לזהות כתמונה
  if (/^https?:\/\//i.test(link) && !isImageLink(link) &&
      /blossom|void\.cat|nostr\.build|satellite\.earth|media\.|cdn\./i.test(link)) {
    return true;
  }
  return false;
}

// חלק יאללה וידאו (videos.js) – זיהוי אם קישור הוא תמונה | HYPER CORE TECH
function isImageLink(link) {
  if (!link) return false;
  if (link.startsWith('data:image')) return true;
  if (/\.(jpe?g|png|gif|webp)$/i.test(link)) return true;
  return false;
}

// חלק אפקטים (videos.js) – חילוץ תגית fx מהאירוע במידת הצורך | HYPER CORE TECH
function extractFxTag(event) {
  if (!event || !Array.isArray(event.tags)) return null;
  const fxTag = event.tags.find((tag) => Array.isArray(tag) && tag[0] === 'fx' && tag[1]);
  return fxTag ? String(fxTag[1]) : null;
}

// חלק אפקטים (videos.js) – קביעת ערך fx ברירת מחדל לפוסטים עם data:image | HYPER CORE TECH
function resolveFxValue(event, imageUrl) {
  const fxValue = extractFxTag(event);
  if (fxValue) return fxValue;
  if (typeof imageUrl === 'string' && imageUrl.startsWith('data:image')) {
    return 'zoomin';
  }
  return null;
}

// חלק יאללה וידאו (videos.js) – בניית קלף HTML לכל וידאו
function renderVideoCard(video) {
  const article = document.createElement('article');
  article.className = 'videos-feed__card';
  article.setAttribute('role', 'listitem');
  article.setAttribute('data-event-id', video.id);
  if (video.fx) {
    article.dataset.fx = video.fx;
    article.classList.add('videos-feed__card--fx');
  }

  let resolveReady;
  let rejectReady;
  const mediaReadyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const markReady = () => {
    markCardMediaReady(article);
    resolveReady();
  };

  const failReady = (error) => {
    rejectReady(error || new Error('media failed'));
  };

  const mediaDiv = document.createElement('div');
  mediaDiv.className = 'videos-feed__media';

  if (video.gameUrl) {
    mediaDiv.dataset.mediaType = 'game-embed';
    mediaDiv.dataset.gameUrl = video.gameUrl;
    mediaDiv.classList.add('videos-feed__media--game');

    const AppGame = window.NostrApp || {};
    if (typeof AppGame.removeGameBadge === 'function') {
      AppGame.removeGameBadge(mediaDiv);
    }

    // placeholder עד שהמשחק נטען אוטומטית (כמו ערוץ חי) | HYPER CORE TECH
    const placeholder = document.createElement('div');
    placeholder.className = 'videos-feed__game-placeholder';
    placeholder.setAttribute('data-game-tap-zone', '');
    placeholder.innerHTML = '<i class="fa-solid fa-gamepad"></i><span>טוען משחק...</span>';
    mediaDiv.appendChild(placeholder);

    if (typeof AppGame.ensureGameFullscreenControls === 'function') {
      AppGame.ensureGameFullscreenControls(mediaDiv);
    }
    if (typeof AppGame.ensureGameScrollShield === 'function') {
      AppGame.ensureGameScrollShield(mediaDiv);
    }

    const playOverlay = document.createElement('button');
    playOverlay.type = 'button';
    playOverlay.className = 'videos-feed__play-overlay';
    playOverlay.setAttribute('aria-label', 'Play game');
    playOverlay.setAttribute('data-play-toggle', '');
    playOverlay.innerHTML = '<i class="fa-solid fa-play"></i>';
    playOverlay.style.display = 'none';
    mediaDiv.appendChild(playOverlay);

    queueMicrotask(markReady);
  } else if (video.liveUrl) {
    mediaDiv.dataset.mediaType = 'hls-live';
    mediaDiv.dataset.liveUrl = video.liveUrl;
    mediaDiv.dataset.videoUrl = video.liveUrl;

    const videoEl = document.createElement('video');
    videoEl.controls = false;
    videoEl.muted = false;
    videoEl.loop = false;
    videoEl.playsInline = true;
    videoEl.autoplay = false;
    videoEl.setAttribute('playsinline', 'true');
    videoEl.setAttribute('webkit-playsinline', 'true');
    videoEl.preload = 'none';
    videoEl.className = 'videos-feed__media-video';
    mediaDiv.appendChild(videoEl);

    const AppLive = window.NostrApp || {};
    if (typeof AppLive.ensureLiveBadge === 'function') {
      AppLive.ensureLiveBadge(mediaDiv);
    } else {
      const badge = document.createElement('div');
      badge.className = 'videos-live-badge';
      badge.innerHTML = '<span class="videos-live-badge__dot"></span><span class="videos-live-badge__text">LIVE IPTV</span>';
      mediaDiv.appendChild(badge);
    }
    if (typeof AppLive.setTuningVisible === 'function') {
      AppLive.setTuningVisible(mediaDiv, true, 'מחפש ערוץ...');
    }
    if (typeof AppLive.ensureFullscreenControls === 'function') {
      AppLive.ensureFullscreenControls(mediaDiv);
    }

    const playOverlay = document.createElement('button');
    playOverlay.type = 'button';
    playOverlay.className = 'videos-feed__play-overlay';
    playOverlay.setAttribute('aria-label', 'Play live channel');
    playOverlay.setAttribute('data-play-toggle', '');
    playOverlay.innerHTML = '<i class="fa-solid fa-play"></i>';
    mediaDiv.appendChild(playOverlay);

    // כרטיס מוצג מיד עם שלג/LIVE — הטעינה ברקע | HYPER CORE TECH
    queueMicrotask(() => {
      markReady();
      if (typeof AppLive.checkHlsHealth === 'function') {
        AppLive.checkHlsHealth(video.liveUrl).catch(() => {});
      }
    });
  } else if (video.youtubeId && !video.videoUrl) {
    mediaDiv.dataset.mediaType = 'youtube';
    mediaDiv.dataset.youtubeId = video.youtubeId;

    const thumb = document.createElement('img');
    thumb.src = `https://i.ytimg.com/vi/${video.youtubeId}/maxresdefault.jpg`;
    thumb.alt = 'YouTube Video';
    thumb.className = 'videos-feed__media-thumb';
    thumb.loading = 'lazy'; // אופטימיזציה למכשירים חלשים
    thumb.decoding = 'async';
    thumb.onerror = () => {
      thumb.src = `https://i.ytimg.com/vi/${video.youtubeId}/hqdefault.jpg`;
      thumb.onerror = null;
    };
    mediaDiv.appendChild(thumb);

    const playOverlay = document.createElement('button');
    playOverlay.type = 'button';
    playOverlay.className = 'videos-feed__play-overlay';
    playOverlay.setAttribute('aria-label', 'Play video');
    playOverlay.setAttribute('data-play-toggle', '');
    playOverlay.innerHTML = '<i class="fa-solid fa-play"></i>';
    mediaDiv.appendChild(playOverlay);

    queueMicrotask(markReady);
  } else if (video.videoUrl) {
    mediaDiv.dataset.mediaType = 'file';
    mediaDiv.dataset.videoUrl = video.videoUrl;

    const videoEl = document.createElement('video');
    videoEl.controls = false;
    videoEl.muted = false; // וידאו מתחיל עם קול (ללא מיוט)
    videoEl.loop = true; // לופ כמו טיקטוק
    videoEl.playsInline = true;
    videoEl.autoplay = false; // חלק תאימות iOS (videos.js) – נשלט ידנית | HYPER CORE TECH
    
    // חלק תאימות iOS (videos.js) – תכונות HTML5 נדרשות לספארי | HYPER CORE TECH
    videoEl.setAttribute('playsinline', 'true');
    videoEl.setAttribute('webkit-playsinline', 'true');
    videoEl.setAttribute('x-webkit-airplay', 'deny');
    videoEl.setAttribute('disableRemotePlayback', '');
    videoEl.setAttribute('disablePictureInPicture', '');
    
    // חלק תאימות iOS (videos.js) – preload=auto נדרש לספארי כדי ש-loadeddata יירה | HYPER CORE TECH
    videoEl.preload = 'auto';
    videoEl.className = 'videos-feed__media-video';
    mediaDiv.appendChild(videoEl);

    const cleanup = () => {
      videoEl.removeEventListener('loadeddata', onLoadedData);
      videoEl.removeEventListener('error', onError);
    };

    const onLoadedData = () => {
      cleanup();
      markReady();
    };

    const onError = (event) => {
      cleanup();
      failReady(event?.error || new Error('video load error'));
    };

    videoEl.addEventListener('loadeddata', onLoadedData, { once: true });
    videoEl.addEventListener('error', onError, { once: true });

    const applyFallbackSrc = () => {
      // חלק תאימות iOS 17.4+ (videos.js) – שימוש ב-source element במקום src ישירות | HYPER CORE TECH
      // באג ידוע: Blob URLs לא עובדים עם src ישירות ב-iOS 17.4+
      // https://developer.apple.com/forums/thread/751063
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
      
      if (isIOS) {
        // הסרת source קיימים
        while (videoEl.firstChild) {
          videoEl.removeChild(videoEl.firstChild);
        }
        // יצירת source element
        const sourceEl = document.createElement('source');
        sourceEl.src = video.videoUrl;
        // ניחוש MIME type לפי סיומת
        const url = video.videoUrl.toLowerCase();
        if (url.includes('.webm')) {
          sourceEl.type = 'video/webm';
        } else if (url.includes('.mp4') || url.includes('.m4v')) {
          sourceEl.type = 'video/mp4';
        } else if (url.includes('.mov')) {
          sourceEl.type = 'video/quicktime';
        } else {
          sourceEl.type = 'video/mp4'; // ברירת מחדל
        }
        videoEl.appendChild(sourceEl);
      } else {
        videoEl.src = video.videoUrl;
      }
      // קריאה ל-load() הכרחית לספארי
      videoEl.load();
    };

    // הוספה לתור הסדרתי במקום טעינה ישירה
    addToVideoDownloadQueue(videoEl, video.videoUrl, video.hash || '', video.mirrors || [], applyFallbackSrc);

    const playOverlay = document.createElement('button');
    playOverlay.type = 'button';
    playOverlay.className = 'videos-feed__play-overlay';
    playOverlay.setAttribute('aria-label', 'Play video');
    playOverlay.setAttribute('data-play-toggle', '');
    playOverlay.innerHTML = '<i class="fa-solid fa-play"></i>';
    mediaDiv.appendChild(playOverlay);
    
    // אינדיקטור דילוג במרכז המסך
    const skipIndicator = document.createElement('div');
    skipIndicator.className = 'video-skip-indicator';
    mediaDiv.appendChild(skipIndicator);
    
    // פס התקדמות כמו טיקטוק
    const progressBar = document.createElement('div');
    progressBar.className = 'video-progress-bar';
    const progressFill = document.createElement('div');
    progressFill.className = 'video-progress-bar__fill';
    // עיגול גרירה (thumb) לפס ההתקדמות | HYPER CORE TECH
    const progressThumb = document.createElement('div');
    progressThumb.className = 'video-progress-bar__thumb';
    progressBar.appendChild(progressFill);
    progressBar.appendChild(progressThumb);
    mediaDiv.appendChild(progressBar);
    
    // פורמט זמן mm:ss
    const formatTime = (sec) => {
      if (!isFinite(sec) || sec < 0) return '0:00';
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    };
    
    // דילוג 5 שניות עם הודעה קופצת בסגנון נטפליקס | HYPER CORE TECH
    const doSkip = (seconds) => {
      console.log('[VIDEO] Skip:', seconds);
      const current = isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
      const duration = isFinite(videoEl.duration) ? videoEl.duration : null;
      const target = current + seconds;
      const newTime = duration ? Math.min(Math.max(0, target), duration) : Math.max(0, target);
      if (typeof videoEl.fastSeek === 'function') {
        try { videoEl.fastSeek(newTime); } catch (e) { videoEl.currentTime = newTime; }
      } else {
        videoEl.currentTime = newTime;
      }
      // אינדיקטור בסגנון נטפליקס - מספר שניות + זמן נוכחי | HYPER CORE TECH
      const secondsText = seconds > 0 ? `+${seconds}` : `${seconds}`;
      const timeText = formatTime(newTime);
      skipIndicator.innerHTML = `
        <span class="video-skip-indicator__seconds">${secondsText}</span>
        <span class="video-skip-indicator__time">${timeText}</span>
      `;
      skipIndicator.classList.remove('show');
      void skipIndicator.offsetWidth;
      skipIndicator.classList.add('show');
      updateProgress();
    };
    
    // כפתורי דילוג - נצמדים למדיה עצמה כדי להישאר מיושרים לגבולות הווידאו | HYPER CORE TECH
    const skipBackBtn = document.createElement('button');
    skipBackBtn.type = 'button';
    skipBackBtn.className = 'video-skip-btn video-skip-btn--left';
    skipBackBtn.innerHTML = '<i class="fa-solid fa-backward"></i>';
    skipBackBtn.setAttribute('aria-label', 'דילוג 5 שניות קדימה');
    // תמיכה בטאץ' ולחיצה במובייל | HYPER CORE TECH
    const handleSkipBack = (e) => { 
      e.preventDefault(); 
      e.stopPropagation();
      doSkip(5); 
    };
    skipBackBtn.addEventListener('click', handleSkipBack);
    skipBackBtn.addEventListener('touchend', handleSkipBack, { passive: false });
    
    // תצוגת זמן - מרכז תחתון
    const timeDisplay = document.createElement('div');
    timeDisplay.className = 'video-time-display';
    
    // כפתור קדימה
    const skipForwardBtn = document.createElement('button');
    skipForwardBtn.type = 'button';
    skipForwardBtn.className = 'video-skip-btn video-skip-btn--right';
    skipForwardBtn.innerHTML = '<i class="fa-solid fa-forward"></i>';
    skipForwardBtn.setAttribute('aria-label', 'דילוג 5 שניות אחורה');
    // תמיכה בטאץ' ולחיצה במובייל | HYPER CORE TECH
    const handleSkipForward = (e) => { 
      e.preventDefault(); 
      e.stopPropagation();
      doSkip(-5); 
    };
    skipForwardBtn.addEventListener('click', handleSkipForward);
    skipForwardBtn.addEventListener('touchend', handleSkipForward, { passive: false });
    
    // הוספה ל-mediaDiv כדי שמיקום הכפתורים יתיישר לגבולות הווידאו | HYPER CORE TECH
    mediaDiv.appendChild(skipBackBtn);
    mediaDiv.appendChild(timeDisplay);
    mediaDiv.appendChild(skipForwardBtn);
    
    // עדכון פס התקדמות וזמן
    let progressTimeout = null;
    let isDragging = false;
    
    const updateProgress = () => {
      if (!videoEl.duration || !isFinite(videoEl.duration)) return;
      const pct = (videoEl.currentTime / videoEl.duration) * 100;
      progressFill.style.width = `${pct}%`;
      // העיגול נע מימין לשמאל (פס RTL) | HYPER CORE TECH
      progressThumb.style.left = `${100 - pct}%`;
      timeDisplay.textContent = `${formatTime(videoEl.currentTime)} / ${formatTime(videoEl.duration)}`;
      
      // הצגת פס התקדמות זמנית
      progressBar.classList.add('visible');
      clearTimeout(progressTimeout);
      if (!isDragging) {
        progressTimeout = setTimeout(() => {
          progressBar.classList.remove('visible');
        }, 2000);
      }
    };
    
    // גרירת פס ההתקדמות - תמיכה במובייל ודסקטופ | HYPER CORE TECH
    const seekToPosition = (clientX) => {
      const rect = progressBar.getBoundingClientRect();
      const x = clientX - rect.left;
      // פס RTL: ימין = התחלה, שמאל = סוף | HYPER CORE TECH
      const pct = 1 - Math.max(0, Math.min(1, x / rect.width));
      if (videoEl.duration && isFinite(videoEl.duration)) {
        videoEl.currentTime = pct * videoEl.duration;
        updateProgress();
      }
    };
    
    const handleDragStart = (e) => {
      e.preventDefault();
      e.stopPropagation();
      isDragging = true;
      progressBar.classList.add('visible', 'dragging');
      const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
      seekToPosition(clientX);
    };
    
    const handleDragMove = (e) => {
      if (!isDragging) return;
      e.preventDefault();
      const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
      seekToPosition(clientX);
    };
    
    const handleDragEnd = (e) => {
      if (!isDragging) return;
      isDragging = false;
      progressBar.classList.remove('dragging');
      clearTimeout(progressTimeout);
      progressTimeout = setTimeout(() => {
        progressBar.classList.remove('visible');
      }, 2000);
    };
    
    // אירועי גרירה על פס ההתקדמות | HYPER CORE TECH
    progressBar.addEventListener('mousedown', handleDragStart);
    progressBar.addEventListener('touchstart', handleDragStart, { passive: false });
    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('touchmove', handleDragMove, { passive: false });
    document.addEventListener('mouseup', handleDragEnd);
    document.addEventListener('touchend', handleDragEnd);
    
    // לחיצה פשוטה על הפס לדילוג למיקום | HYPER CORE TECH
    progressBar.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      seekToPosition(e.clientX);
    });
    
    videoEl.addEventListener('loadedmetadata', updateProgress);
    videoEl.addEventListener('timeupdate', updateProgress);
    videoEl.addEventListener('seeking', updateProgress);
    videoEl.addEventListener('play', updateProgress);
    
  } else if (video.imageUrl) {
    mediaDiv.dataset.mediaType = 'image';

    const imgEl = document.createElement('img');
    imgEl.src = video.imageUrl;
    imgEl.alt = video.authorName || 'פוסט תמונה';
    imgEl.className = 'videos-feed__media-image';
    imgEl.loading = 'lazy';
    mediaDiv.appendChild(imgEl);

    queueMicrotask(markReady);
  } else {
    queueMicrotask(() => {
      failReady(new Error('missing media sources'));
    });
  }

  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'videos-feed__actions';

  // Wrapper לכפתור פרופיל + פלוס עוקב
  const avatarWrap = document.createElement('div');
  avatarWrap.className = 'videos-feed__avatar-wrap';

  const authorAction = document.createElement('button');
  authorAction.type = 'button';
  authorAction.className = 'videos-feed__action videos-feed__action--avatar';
  authorAction.setAttribute('aria-label', video.authorName || 'משתמש');
  if (video.authorPicture) {
    const img = document.createElement('img');
    img.src = video.authorPicture;
    img.alt = video.authorName || 'משתמש';
    img.loading = 'lazy'; // אופטימיזציה למכשירים חלשים
    img.decoding = 'async';
    authorAction.appendChild(img);
  } else {
    const initialsSpan = document.createElement('span');
    initialsSpan.textContent = video.authorInitials || 'AN';
    authorAction.appendChild(initialsSpan);
  }
  authorAction.addEventListener('click', () => {
    const app = window.NostrApp;
    // בדיקת מצב אורח - חסימת פרופיל למשתמשים לא מחוברים | HYPER CORE TECH
    if (app && typeof app.requireAuth === 'function') {
      if (!app.requireAuth('כדי לצפות בפרופיל משתמש צריך להתחבר או להירשם.')) {
        return;
      }
    }
    if (video.pubkey && typeof window.openProfileByPubkey === 'function') {
      window.openProfileByPubkey(video.pubkey);
    }
  });
  avatarWrap.appendChild(authorAction);
  actionsDiv.appendChild(avatarWrap);

  const currentApp = window.NostrApp || {};
  const likeCount = currentApp.likesByEventId?.get(video.id)?.size || 0;
  const isLiked = currentApp.likesByEventId?.get(video.id)?.has(currentApp.publicKey) || false;
  const commentCount = currentApp.commentsByParent?.get(video.id)?.length || 0;

  actionsDiv.insertAdjacentHTML('beforeend', `
    <button class="videos-feed__action ${isLiked ? 'videos-feed__action--liked' : ''}" data-like-button data-event-id="${video.id}">
      <i class="fa-solid fa-heart"></i>
      <span class="videos-feed__action-count feed-post__like-count" style="${likeCount > 0 ? '' : 'display:none'}">${likeCount > 0 ? likeCount : ''}</span>
    </button>
    <button class="videos-feed__action" data-comment-button data-event-id="${video.id}">
      <i class="fa-solid fa-comment"></i>
      <span class="videos-feed__action-count feed-post__comment-count" data-comment-count="${video.id}" style="${commentCount > 0 ? '' : 'display:none'}">${commentCount > 0 ? commentCount : ''}</span>
    </button>
    <button class="videos-feed__action" data-share-button data-event-id="${video.id}">
      <i class="fa-solid fa-share"></i>
    </button>
  `);

  const viewerPubkey = typeof currentApp.publicKey === 'string' ? currentApp.publicKey.toLowerCase() : '';
  const videoOwnerPubkey = typeof video.pubkey === 'string' ? video.pubkey.toLowerCase() : '';
  const isSelf = viewerPubkey && videoOwnerPubkey ? viewerPubkey === videoOwnerPubkey : video.pubkey === currentApp.publicKey;
  const isFollowing = currentApp.followingSet?.has(videoOwnerPubkey || video.pubkey) || false;
  const isAdminUser = currentApp.adminPublicKeys instanceof Set && viewerPubkey
    ? currentApp.adminPublicKeys.has(viewerPubkey)
    : false;

  const canEdit = isSelf;
  const canDelete = isSelf || isAdminUser;

  if (isSelf) {
    // חלק תפריט פיד ווידאו (videos.js) – הוספת כפתור שלוש נקודות כמו בפיד הראשי לעריכה/מחיקה של המשתמש | HYPER CORE TECH
    const menuWrap = document.createElement('div');
    menuWrap.className = 'feed-post__menu-wrap videos-feed__menu-wrap';
    menuWrap.setAttribute('data-video-menu-wrap', video.id);

    const menuToggle = document.createElement('button');
    menuToggle.type = 'button';
    menuToggle.className = 'videos-feed__action feed-post__menu-toggle';
    menuToggle.setAttribute('aria-haspopup', 'true');
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('data-post-menu-toggle', video.id);
    menuToggle.setAttribute('title', 'אפשרויות');
    menuToggle.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';

    const editButtonHtml = canEdit
      ? `
        <button class="feed-post__action feed-post__action--edit" type="button" onclick="NostrApp.openEditPost('${video.id}')">
          <i class="fa-solid fa-pen-to-square"></i>
          <span>ערוך</span>
        </button>
      `
      : '';
    const deleteButtonHtml = canDelete
      ? `
        <button class="feed-post__action feed-post__action--delete" type="button" onclick="NostrApp.deletePost('${video.id}')">
          <i class="fa-solid fa-trash"></i>
          <span>מחק</span>
        </button>
      `
      : '';

    const menu = document.createElement('div');
    menu.className = 'feed-post__menu videos-feed__menu';
    menu.setAttribute('data-post-menu', video.id);
    menu.setAttribute('hidden', '');
    menu.hidden = true;
    menu.innerHTML = `${editButtonHtml}${deleteButtonHtml}`;

    menuWrap.appendChild(menuToggle);
    menuWrap.appendChild(menu);
    actionsDiv.appendChild(menuWrap);

    const markToggleAsWired = () => {
      const card = menuWrap.closest('.videos-feed__card') || article;
      const toggle = menuWrap.querySelector(`[data-post-menu-toggle="${video.id}"]`);
      if (!card || !toggle || toggle.dataset.menuWired === '1') {
        return;
      }
      const appRef = window.NostrApp;
      toggle.dataset.menuWired = '1';
      toggle.setAttribute('aria-expanded', 'false');
      if (typeof appRef?.wirePostMenu === 'function') {
        appRef.wirePostMenu(card, video.id);
      } else {
        wireVideoPostMenu(card, video.id);
      }
    };

    setTimeout(markToggleAsWired, 0);
  } else {
    // כפתור עקוב מעודכן - ממוקם בשליש התחתון של כפתור הפרופיל | HYPER CORE TECH
    const followBtn = document.createElement('button');
    followBtn.type = 'button';
    followBtn.className = `videos-follow-button ${isFollowing ? 'is-following' : ''}`;
    // חלק עוקבים (videos.js) – שימוש ב-lowercase pubkey כמו בפיד הראשי לריענון עקב/בטל עקב | HYPER CORE TECH
    followBtn.setAttribute('data-follow-button', videoOwnerPubkey || video.pubkey);
    followBtn.innerHTML = `
      <span class="videos-follow-icon" aria-hidden="true">${isFollowing ? '✓' : '+'}</span>
      <span data-follow-label style="display:none;">${isFollowing ? 'עוקב/ת' : 'עקוב'}</span>
    `;
    avatarWrap.appendChild(followBtn);

    if (typeof currentApp.refreshFollowButtons === 'function') {
      currentApp.refreshFollowButtons(avatarWrap);
    }
  }

  if (!isSelf && canDelete) {
    // חלק תפריט מנהל (videos.js) – מאפשר לאדמין למחוק פוסט וידאו של משתמש אחר באמצעות הפונקציה הקיימת | HYPER CORE TECH
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'videos-feed__action feed-post__action feed-post__action--delete';
    deleteBtn.setAttribute('data-admin-delete', video.id);
    deleteBtn.innerHTML = `
      <i class="fa-solid fa-trash"></i>
      <span>מחק</span>
    `;
    deleteBtn.addEventListener('click', () => {
      if (typeof currentApp.deletePost === 'function') {
        currentApp.deletePost(video.id);
      }
    });
    actionsDiv.appendChild(deleteBtn);
  }

  const infoDiv = document.createElement('div');
  infoDiv.className = 'videos-feed__info';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'videos-feed__content';
  contentDiv.textContent = video.content || '';

  const openFullText = () => {
    openPostTextPanel({
      authorName: video.authorName || 'משתמש',
      authorPicture: video.authorPicture || '',
      content: video.content || ''
    });
  };

  contentDiv.addEventListener('click', openFullText);

  if (video.content) {
    infoDiv.appendChild(contentDiv);
    // בדיקת גלישת טקסט והוספת כפתור "עוד" לפתיחת חלונית טקסט מלאה | HYPER CORE TECH
    setTimeout(() => {
      try {
        if (contentDiv.scrollHeight > (contentDiv.clientHeight + 2)) {
          const moreBtn = document.createElement('button');
          moreBtn.type = 'button';
          moreBtn.className = 'videos-feed__more';
          moreBtn.textContent = 'עוד';
          moreBtn.addEventListener('click', (e) => {
            e.preventDefault();
            openFullText();
          });
          contentDiv.appendChild(moreBtn);

          // גם לחיצה על הטקסט עצמו תפתח את החלונית | HYPER CORE TECH
          contentDiv.style.cursor = 'pointer';
          contentDiv.addEventListener('click', openFullText, { once: false });
        }
      } catch (_) {}
    }, 0);
  }

  article.appendChild(mediaDiv);
  article.appendChild(actionsDiv);
  article.appendChild(infoDiv);

  return { card: article, mediaReadyPromise };
}

// חלק תפריט פיד ווידאו (videos.js) – חיבור fallback לפתיחה/סגירה של תפריט העריכה | HYPER CORE TECH
function wireVideoPostMenu(rootEl, postId) {
  if (!rootEl || !postId) {
    return;
  }
  const toggle = rootEl.querySelector(`[data-post-menu-toggle="${postId}"]`);
  const menu = rootEl.querySelector(`[data-post-menu="${postId}"]`);
  if (!toggle || !menu) {
    return;
  }

  const close = () => {
    if (!menu.hasAttribute('hidden')) {
      menu.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onOutside, true);
      document.removeEventListener('keydown', onKey);
    }
  };
  const onOutside = (event) => {
    if (!menu.contains(event.target) && !toggle.contains(event.target)) {
      close();
    }
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      close();
    }
  };

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    const hidden = menu.hasAttribute('hidden');
    if (hidden) {
      menu.removeAttribute('hidden');
      toggle.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', onOutside, true);
      document.addEventListener('keydown', onKey);
    } else {
      close();
    }
  });
}

// חלק שמירת מיקום (videos.js) – משתנה גלובלי לשמירת מיקום גלילה | HYPER CORE TECH
let savedScrollPosition = 0;

// חלק יאללה וידאו (videos.js) – רינדור אינקרמנטלי של הווידאו | HYPER CORE TECH
function renderVideos() {
  if (!selectors.stream) return;
  
  // שמירת מיקום גלילה לפני רינדור
  const viewport = document.querySelector('.videos-feed__viewport');
  if (viewport && selectors.stream.children.length > 0) {
    savedScrollPosition = viewport.scrollTop;
  }
  
  // חלק רינדור חכם (videos.js) – עדכון דיפרנציאלי במקום מחיקת הכל | HYPER CORE TECH
  const existingCards = selectors.stream.querySelectorAll('.videos-feed__card[data-event-id]');
  const existingIds = new Set();
  existingCards.forEach(card => {
    const id = card.getAttribute('data-event-id');
    if (id) existingIds.add(id);
  });
  
  // אם אין פוסטים קיימים - נקה והתחל מחדש
  const needsFullRender = existingIds.size === 0;
  if (needsFullRender) {
    selectors.stream.innerHTML = '';
  }
  
  resetIncrementalRender();
  
  if (!Array.isArray(state.videos) || state.videos.length === 0) {
    hideLoadingAnimation();
    setStatus('אין סרטונים להצגה');
    return;
  }

  // סינון רק פוסטים שעוד לא מוצגים
  const videosToRender = needsFullRender 
    ? state.videos 
    : state.videos.filter(v => !existingIds.has(v.id));
  
  if (videosToRender.length === 0) {
    // כל הפוסטים כבר מוצגים
    hideLoadingAnimation();
    state.firstCardRendered = true;
    return;
  }

  if (!state.firstCardRendered && selectors.status) {
    selectors.status.textContent = 'טוען סרטונים...';
    selectors.status.style.display = 'block';
  }

  setupIntersectionObserver();
  setupLoadMoreObserver();
  setupLikeUpdateListener();

  state.incrementalRender = {
    nextIndex: 0,
    cancelled: false,
    timer: null,
    videosToRender, // רק הפוסטים החדשים
  };

  appendNextVideoCard();
}

// חלק יאללה וידאו (videos.js) – איפוס מנגנון הרינדור ההדרגתי | HYPER CORE TECH
function resetIncrementalRender() {
  if (state.incrementalRender?.timer) {
    clearTimeout(state.incrementalRender.timer);
  }
  if (state.incrementalRender) {
    state.incrementalRender.cancelled = true;
  }
  state.incrementalRender = null;
}

// חלק יאללה וידאו (videos.js) – הוספת קלף חדש לפיד ומעבר לקלף הבא | HYPER CORE TECH
function appendNextVideoCard() {
  const controller = state.incrementalRender;
  if (!controller || controller.cancelled) {
    return;
  }

  // שימוש ב-videosToRender אם קיים, אחרת state.videos
  const videos = controller.videosToRender || state.videos;
  
  if (controller.nextIndex >= videos.length) {
    finalizeIncrementalRender();
    return;
  }

  const video = videos[controller.nextIndex];
  const { card, mediaReadyPromise } = renderVideoCard(video);

  mediaReadyPromise
    .then(() => {
      mountCard(card);
    })
    .catch((err) => handleCardMediaFailure(card, video.id, err));

  controller.nextIndex += 1;
  preloadNextMedia(videos[controller.nextIndex]);

  if (controller.nextIndex >= videos.length) {
    finalizeIncrementalRender();
    return;
  }

  controller.timer = setTimeout(appendNextVideoCard, 0); // רינדור מיידי
}

// חלק יאללה וידאו (videos.js) – סיום סדרת הרינדור ההדרגתית | HYPER CORE TECH
function finalizeIncrementalRender() {
  if (!state.incrementalRender) return;
  if (state.incrementalRender.timer) {
    clearTimeout(state.incrementalRender.timer);
  }
  state.incrementalRender.cancelled = true;
  state.incrementalRender = null;
}

// חלק יאללה וידאו (videos.js) – חיבור קלפים חדשים ל-IntersectionObserver | HYPER CORE TECH
function observeVideoCard(card) {
  if (!card) return;
  if (!intersectionObserver) {
    setupIntersectionObserver();
  }
  if (intersectionObserver) {
    intersectionObserver.observe(card);
  }
}

// חלק יאללה וידאו (videos.js) – פרילוד לווידאו/תמונה/ערוץ חי/משחק של הקלף הבא | HYPER CORE TECH
function preloadNextMedia(video) {
  if (!video) return;

  if (video.liveUrl) {
    const App = window.NostrApp || {};
    if (typeof App.prefetchLiveUrl === 'function') {
      App.prefetchLiveUrl(video.liveUrl).catch(() => {});
    }
    // חימום הכרטיס הבא אם כבר במסך
    const nextCard = document.querySelector(`.videos-feed__card[data-event-id="${video.id}"]`);
    const mediaDiv = nextCard && nextCard.querySelector('.videos-feed__media[data-media-type="hls-live"]');
    if (mediaDiv && mediaDiv.dataset.livePrepared !== '1' && typeof App.prepareLiveMedia === 'function') {
      App.prepareLiveMedia(mediaDiv, {
        autoplay: false,
        tuningLabel: 'מחפש ערוץ...',
      }).catch(() => {});
    }
    return;
  }

  if (video.gameUrl) {
    const App = window.NostrApp || {};
    const nextCard = document.querySelector(`.videos-feed__card[data-event-id="${video.id}"]`);
    const mediaDiv = nextCard && nextCard.querySelector('.videos-feed__media[data-media-type="game-embed"]');
    if (mediaDiv && typeof App.prepareGameMedia === 'function') {
      App.prepareGameMedia(mediaDiv, { loadingLabel: 'טוען משחק...' });
    }
    return;
  }

  if (video.videoUrl) {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = video.videoUrl;
    link.as = 'video';
    document.head.appendChild(link);
    setTimeout(() => link.remove(), 10000);
    return;
  }

  const previewUrl = video.imageUrl
    ? video.imageUrl
    : (video.youtubeId ? `https://i.ytimg.com/vi/${video.youtubeId}/hqdefault.jpg` : '');

  if (previewUrl) {
    const img = new Image();
    img.src = previewUrl;
  }
}

// חלק יאללה וידאו (videos.js) – עדכון כפתור לייק בדף הווידאו
function updateVideoLikeButton(eventId) {
  if (!eventId) return;
  const button = document.querySelector(`button[data-like-button][data-event-id="${eventId}"]`);
  if (!button) return;

  const app = window.NostrApp;
  const likeSet = app?.likesByEventId?.get(eventId);
  const count = likeSet ? likeSet.size : 0;
  const counterEl = button.querySelector('.videos-feed__action-count');
  
  if (counterEl) {
    if (count > 0) {
      counterEl.textContent = String(count);
      counterEl.style.display = '';
    } else {
      counterEl.textContent = '';
      counterEl.style.display = 'none';
    }
  }

  const currentUser = typeof app?.publicKey === 'string' ? app.publicKey.toLowerCase() : '';
  if (currentUser && likeSet && likeSet.has(currentUser)) {
    button.classList.add('videos-feed__action--liked');
  } else {
    button.classList.remove('videos-feed__action--liked');
  }
}

// חלק יאללה וידאו (videos.js) – עדכון כפתור תגובות בדף הווידאו
function updateVideoCommentButton(eventId) {
  if (!eventId) return;
  const button = document.querySelector(`button[data-comment-button][data-event-id="${eventId}"]`);
  if (!button) return;

  const app = window.NostrApp;
  const commentMap = app?.commentsByParent?.get(eventId);
  const comments = commentMap ? Array.from(commentMap.values()) : [];
  const count = comments.length;
  const counterEl = button.querySelector('.feed-post__comment-count');
  
  if (counterEl) {
    if (count > 0) {
      counterEl.textContent = String(count);
      counterEl.style.display = '';
    } else {
      counterEl.textContent = '';
      counterEl.style.display = 'none';
    }
  }
}

// חלק יאללה וידאו (videos.js) – מאזין לעדכוני לייקים גלובליים
function setupLikeUpdateListener() {
  const app = window.NostrApp;
  if (!app || typeof app.registerLike !== 'function') return;
  
  // שמירת הפונקציה המקורית
  const originalRegisterLike = app.registerLike;
  
  // עטיפה שמעדכנת גם את הכפתורים בדף הווידאו
  app.registerLike = function(event) {
    const result = originalRegisterLike.call(this, event);
    
    // עדכון כפתורי הלייק בדף הווידאו
    if (event && Array.isArray(event.tags)) {
      event.tags.forEach((tag) => {
        if (Array.isArray(tag) && (tag[0] === 'e' || tag[0] === 'a') && tag[1]) {
          const eventId = tag[1];
          setTimeout(() => updateVideoLikeButton(eventId), 50);
        }
      });
    }
    
    return result;
  };
}

// חלק יאללה וידאו (videos.js) – פתיחת פאנל תגובות בסגנון טיקטוק
function openCommentsPanel(eventId) {
  if (!eventId) return;
  
  const app = window.NostrApp;
  // לא דורשים שהפוסט יהיה ב-postsById, רק שיהיה eventId תקין
  // הפוסט יכול להיות רק בדף הווידאו ולא בפיד הראשי

  // יצירת overlay
  const overlay = document.createElement('div');
  overlay.className = 'videos-comments-overlay';
  overlay.innerHTML = `
    <div class="videos-comments-panel">
      <div class="videos-comments-header">
        <h3>תגובות</h3>
        <button class="videos-comments-close" aria-label="סגור">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="videos-comments-list" id="videoCommentsList"></div>
      <div class="videos-comments-input">
        <input type="text" placeholder="הוסף תגובה..." id="videoCommentInput" />
        <button id="videoCommentSend">
          <i class="fa-solid fa-paper-plane"></i>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // סגירה בלחיצה על overlay או כפתור סגירה
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.videos-comments-close')) {
      overlay.remove();
    }
  });

  // טעינת תגובות
  loadCommentsForPost(eventId);

  // שליחת תגובה
  const sendBtn = overlay.querySelector('#videoCommentSend');
  const input = overlay.querySelector('#videoCommentInput');
  
  // חלק תגובות (videos.js) – פרסום תגובה דרך postComment או publishPost כגיבוי | HYPER CORE TECH
  const sendComment = async () => {
    const text = input.value.trim();
    if (!text || !app) {
      return;
    }

    try {
      if (typeof app.postComment === 'function') {
        await app.postComment(eventId, text);
      } else if (typeof app.publishPost === 'function') {
        await app.publishPost({ content: text, replyTo: eventId });
      } else {
        return;
      }
      input.value = '';
      await loadCommentsForPost(eventId);
    } catch (err) {
      console.error('[videos] Failed to send comment:', err);
    }
  };

  sendBtn?.addEventListener('click', sendComment);
  input?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendComment();
  });
}

// חלק יאללה וידאו (videos.js) – פתיחת חלונית טקסט מלאה בסגנון משופר | HYPER CORE TECH
function openPostTextPanel({ authorName, authorPicture, content, pubkey }) {
  const overlay = document.createElement('div');
  overlay.className = 'videos-text-overlay';
  
  // עיבוד הטקסט לפורמט מסודר
  const formattedContent = formatPostContent(content || '');
  
  // יצירת אוואטר
  const avatarHtml = authorPicture 
    ? `<img src="${authorPicture}" alt="${authorName || ''}" class="videos-text-avatar-img" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" /><span class="videos-text-avatar-fallback" style="display:none;">${getInitials(authorName)}</span>`
    : `<span class="videos-text-avatar-fallback">${getInitials(authorName)}</span>`;
  
  overlay.innerHTML = `
    <div class="videos-text-panel">
      <div class="videos-text-header">
        <div class="videos-text-author">
          <div class="videos-text-avatar">
            ${avatarHtml}
          </div>
          <span class="videos-text-author-name">${authorName || 'אנונימי'}</span>
        </div>
        <button class="videos-text-close" aria-label="סגור">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="videos-text-rainbow-bar"></div>
      <div class="videos-text-content">
        ${formattedContent}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.videos-text-close')) {
      overlay.remove();
    }
  });
}

// חלק יאללה וידאו (videos.js) – עיבוד טקסט לפורמט מסודר עם כותרות וצבעים | HYPER CORE TECH
function formatPostContent(content) {
  if (!content) return '';
  
  // פיצול לשורות
  const lines = content.split('\n');
  let html = '';
  let inList = false;
  
  for (let i = 0; i < lines.length; i++) {
    let line = escapeHtml(lines[i].trim());
    
    if (!line) {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
      html += '<div class="videos-text-spacer"></div>';
      continue;
    }
    
    // זיהוי כותרות (שורה קצרה בתחילת פסקה או עם נקודתיים)
    const isTitle = (line.length < 60 && (line.endsWith(':') || line.endsWith('-') || /^[א-ת\s]+$/.test(line) && line.length < 30));
    
    // זיהוי פריטי רשימה
    const listMatch = line.match(/^[-•*]\s*(.+)$/);
    
    // זיהוי קישורים
    line = line.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" class="videos-text-link">$1</a>');
    
    // זיהוי האשטגים
    line = line.replace(/#([א-תa-zA-Z0-9_]+)/g, '<span class="videos-text-hashtag">#$1</span>');
    
    // זיהוי אימוג'י מודגש
    line = line.replace(/([\u{1F300}-\u{1F9FF}])/gu, '<span class="videos-text-emoji">$1</span>');
    
    if (isTitle) {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
      html += `<h4 class="videos-text-title">${line}</h4>`;
    } else if (listMatch) {
      if (!inList) {
        html += '<ul class="videos-text-list">';
        inList = true;
      }
      html += `<li>${listMatch[1]}</li>`;
    } else {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
      html += `<p class="videos-text-paragraph">${line}</p>`;
    }
  }
  
  if (inList) {
    html += '</ul>';
  }
  
  return html;
}

// חלק יאללה וידאו (videos.js) – קבלת ראשי תיבות משם | HYPER CORE TECH
function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

// חלק יאללה וידאו (videos.js) – פונקציית עזר לאסקפינג HTML בטוח
function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// חלק יאללה וידאו (videos.js) – טעינת תגובות לפוסט
async function loadCommentsForPost(eventId) {
  const app = window.NostrApp;
  const commentsList = document.getElementById('videoCommentsList');
  if (!commentsList) {
    return;
  }

  commentsList.innerHTML = '<div class="videos-comments-loading">טוען תגובות...</div>';

  const commentMap = app?.commentsByParent?.get(eventId);
  const comments = commentMap ? Array.from(commentMap.values()) : [];
  comments.sort((a, b) => (a?.created_at || 0) - (b?.created_at || 0));

  const commentButton = document.querySelector(`[data-comment-button][data-event-id="${eventId}"]`);
  const counterEl = commentButton?.querySelector('.videos-feed__action-count');

  if (!comments.length) {
    commentsList.innerHTML = '<div class="videos-comments-empty">אין תגובות עדיין</div>';
    if (counterEl) {
      counterEl.textContent = '';
      counterEl.style.display = 'none';
    }
    return;
  }

  const profiles = await Promise.all(
    comments.map(async (comment) => {
      const key = comment.pubkey?.toLowerCase?.() || comment.pubkey || '';
      if (app?.profileCache?.has(key)) {
        return app.profileCache.get(key);
      }
      if (typeof app?.fetchProfile === 'function') {
        try {
          return await app.fetchProfile(key);
        } catch (_) {
          return null;
        }
      }
      return null;
    })
  );

  const fragment = document.createDocumentFragment();

  comments.forEach((comment, index) => {
    const profile = profiles[index] || {};
    const authorKey = comment.pubkey?.toLowerCase?.() || '';
    const displayName = profile.name || (authorKey ? `משתמש ${authorKey.slice(0, 8)}` : 'משתמש');
    const initials = profile.initials || displayName.slice(0, 2).toUpperCase();
    const picture = profile.picture || '';
    const safeName = escapeHtml(displayName);
    const safeContent = escapeHtml(comment.content || '').replace(/\n/g, '<br>');

    const commentDiv = document.createElement('div');
    commentDiv.className = 'videos-comment-item';

    const avatarDiv = document.createElement('button');
    avatarDiv.type = 'button';
    avatarDiv.className = 'videos-comment-avatar';
    avatarDiv.setAttribute('aria-label', `פרופיל של ${displayName}`);
    if (picture) {
      avatarDiv.innerHTML = `<img src="${picture}" alt="${safeName}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
    } else {
      avatarDiv.textContent = initials;
    }
    avatarDiv.addEventListener('click', () => {
      const app = window.NostrApp;
      // בדיקת מצב אורח - חסימת פרופיל בתגובות למשתמשים לא מחוברים | HYPER CORE TECH
      if (app && typeof app.requireAuth === 'function') {
        if (!app.requireAuth('כדי לצפות בפרופיל משתמש צריך להתחבר או להירשם.')) {
          return;
        }
      }
      if (authorKey && typeof window.openProfileByPubkey === 'function') {
        window.openProfileByPubkey(authorKey);
      }
    });

    const contentWrap = document.createElement('div');
    contentWrap.className = 'videos-comment-content';

    const nameButton = document.createElement('button');
    nameButton.type = 'button';
    nameButton.className = 'videos-comment-author';
    nameButton.innerHTML = safeName;
    nameButton.addEventListener('click', () => {
      const app = window.NostrApp;
      // בדיקת מצב אורח - חסימת פרופיל בתגובות למשתמשים לא מחוברים | HYPER CORE TECH
      if (app && typeof app.requireAuth === 'function') {
        if (!app.requireAuth('כדי לצפות בפרופיל משתמש צריך להתחבר או להירשם.')) {
          return;
        }
      }
      if (authorKey && typeof window.openProfileByPubkey === 'function') {
        window.openProfileByPubkey(authorKey);
      }
    });

    const textDiv = document.createElement('div');
    textDiv.className = 'videos-comment-text';
    textDiv.innerHTML = safeContent;

    contentWrap.appendChild(nameButton);
    contentWrap.appendChild(textDiv);

    commentDiv.appendChild(avatarDiv);
    commentDiv.appendChild(contentWrap);

    fragment.appendChild(commentDiv);
  });

  commentsList.innerHTML = '';
  commentsList.appendChild(fragment);

  if (counterEl) {
    counterEl.textContent = String(comments.length);
    counterEl.style.display = '';
  }

  if (typeof app?.updateCommentsForParent === 'function') {
    try {
      app.updateCommentsForParent(eventId);
    } catch (err) {
      console.warn('[videos] failed syncing comment counter', err);
    }
  }

  // עדכון כפתור התגובות בדף הווידאו
  try {
    updateVideoCommentButton(eventId);
  } catch (err) {
    console.warn('[videos] failed updating video comment button', err);
  }
}

// חלק יאללה וידאו (videos.js) – חיבור כפתורי פעולה
function wireActions(root = selectors.stream) {
  const rootEl = root && typeof root.querySelectorAll === 'function' ? root : selectors.stream;
  if (!rootEl) return;

  rootEl.querySelectorAll('[data-like-button]').forEach((button) => {
    if (button.dataset.listenerAttached === 'true') return;
    button.dataset.listenerAttached = 'true';
    button.addEventListener('click', async () => {
      const app = window.NostrApp;
      // בדיקת מצב אורח - חסימת לייק למשתמשים לא מחוברים | HYPER CORE TECH
      if (app && typeof app.requireAuth === 'function') {
        if (!app.requireAuth('כדי לעשות לייק צריך להתחבר או להירשם.')) {
          return;
        }
      }
      const eventId = button.getAttribute('data-event-id');
      if (eventId && app && typeof app.likePost === 'function') {
        await app.likePost(eventId);
        // עדכון מיידי של הכפתור
        setTimeout(() => updateVideoLikeButton(eventId), 100);
      }
    });
  });

  rootEl.querySelectorAll('[data-comment-button]').forEach((button) => {
    if (button.dataset.listenerAttached === 'true') return;
    button.dataset.listenerAttached = 'true';
    button.addEventListener('click', () => {
      const app = window.NostrApp;
      // בדיקת מצב אורח - חסימת תגובה למשתמשים לא מחוברים | HYPER CORE TECH
      if (app && typeof app.requireAuth === 'function') {
        if (!app.requireAuth('כדי להגיב על פוסט צריך להתחבר או להירשם.')) {
          return;
        }
      }
      const eventId = button.getAttribute('data-event-id');
      if (eventId) {
        openCommentsPanel(eventId);
      }
    });
  });

  rootEl.querySelectorAll('[data-share-button]').forEach((button) => {
    if (button.dataset.listenerAttached === 'true') return;
    button.dataset.listenerAttached = 'true';
    button.addEventListener('click', () => {
      const app = window.NostrApp;
      // בדיקת מצב אורח - חסימת שיתוף למשתמשים לא מחוברים | HYPER CORE TECH
      if (app && typeof app.requireAuth === 'function') {
        if (!app.requireAuth('כדי לשתף פוסט צריך להתחבר או להירשם.')) {
          return;
        }
      }
      const eventId = button.getAttribute('data-event-id');
      if (eventId && app && typeof app.sharePost === 'function') {
        app.sharePost(eventId);
      }
    });
  });

  // כפתורי עקוב מטופלים על ידי המאזין הגלובלי ב-follow-service.js
  // לא צריך מאזין נוסף כאן - זה יגרום ל-toggleFollow להיקרא פעמיים
}

// חלק ערוץ חי + משחק (videos.js) – חימום השכן הבא/אחריו | HYPER CORE TECH
function prefetchNeighborLiveChannels(activeCard) {
  if (!activeCard || !activeCard.parentElement) return;
  const App = window.NostrApp || {};

  const cards = Array.from(activeCard.parentElement.querySelectorAll('.videos-feed__card'));
  const idx = cards.indexOf(activeCard);
  if (idx < 0) return;

  [cards[idx + 1], cards[idx + 2]].forEach((neighbor) => {
    if (!neighbor) return;
    const liveDiv = neighbor.querySelector('.videos-feed__media[data-media-type="hls-live"]');
    if (liveDiv && liveDiv.dataset.livePrepared !== '1' && typeof App.prepareLiveMedia === 'function') {
      App.prepareLiveMedia(liveDiv, {
        autoplay: false,
        tuningLabel: 'מחפש ערוץ...',
      }).catch(() => {});
    }
    const gameDiv = neighbor.querySelector('.videos-feed__media[data-media-type="game-embed"]');
    if (gameDiv && typeof App.prepareGameMedia === 'function') {
      App.prepareGameMedia(gameDiv, { loadingLabel: 'טוען משחק...' });
    }
  });

  // שחרור משחקים רחוקים – שומרים רק ±2 | HYPER CORE TECH
  if (typeof App.deactivateGameMedia === 'function') {
    cards.forEach((card, i) => {
      if (Math.abs(i - idx) <= 2) return;
      const gameDiv = card.querySelector('.videos-feed__media[data-media-type="game-embed"]');
      if (!gameDiv || gameDiv.dataset.gamePrepared !== '1') return;
      if (gameDiv.classList.contains('is-game-active') || gameDiv.classList.contains('is-game-fullscreen')) return;
      App.deactivateGameMedia(gameDiv);
    });
  }
}

// חלק יאללה וידאו (videos.js) – Intersection Observer פשוט לגלילה כמו טיקטוק
function setupIntersectionObserver() {
  const viewport = document.querySelector('.videos-feed__viewport');
  if (!viewport) return;

  if (intersectionObserver) {
    intersectionObserver.disconnect();
  }

  // גלילה פשוטה - רק ניגן/עצור וידאו + פרילוד ערוץ חי של השכן | HYPER CORE TECH
  intersectionObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const card = entry.target;
        const mediaDiv = card.querySelector('.videos-feed__media');
        if (!mediaDiv) return;
        
        // ניגון כשהפוסט מרכזי (50%+ גלוי)
        if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
          playMedia(mediaDiv, { manual: false });
          prefetchNeighborLiveChannels(card);
        } else if (entry.isIntersecting && entry.intersectionRatio > 0) {
          // מתקרבים לכרטיס — חימום HLS/משחק ברקע | HYPER CORE TECH
          const App = window.NostrApp || {};
          if (mediaDiv.dataset.mediaType === 'hls-live' && mediaDiv.dataset.livePrepared !== '1') {
            if (typeof App.prepareLiveMedia === 'function') {
              App.prepareLiveMedia(mediaDiv, {
                autoplay: false,
                tuningLabel: 'מחפש ערוץ...',
              }).catch(() => {});
            }
          } else if (mediaDiv.dataset.mediaType === 'game-embed') {
            if (typeof App.prepareGameMedia === 'function') {
              App.prepareGameMedia(mediaDiv, { loadingLabel: 'טוען משחק...' });
            }
          }
        } else {
          pauseMedia(mediaDiv, { resetThumb: false });
        }
      });
    },
    {
      root: viewport,
      threshold: [0, 0.15, 0.5],
      rootMargin: '-10% 0px'
    }
  );

  const cards = document.querySelectorAll('.videos-feed__card');
  cards.forEach((card) => intersectionObserver.observe(card));

  return intersectionObserver;
}

// חלק טעינת המשך (videos.js) – טעינת פוסטים נוספים כשמגיעים לסוף הפיד | HYPER CORE TECH
function setupLoadMoreObserver() {
  const viewport = document.querySelector('.videos-feed__viewport');
  if (!viewport) return;
  
  if (loadMoreObserver) {
    loadMoreObserver.disconnect();
  }
  
  loadMoreObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && !isLoadingMore) {
          // הגענו לקרבת סוף הפיד - טען עוד פוסטים
          console.log('[videos] Near end of feed, loading more...');
          loadMoreVideos();
        }
      });
    },
    {
      root: viewport,
      threshold: 0.1,
      rootMargin: '200px 0px'
    }
  );
  
  updateLoadMoreTrigger();
}

function updateLoadMoreTrigger() {
  if (!loadMoreObserver) return;
  
  // הסר observer מקלפים קודמים
  loadMoreObserver.disconnect();
  
  // חבר לקלף לפני האחרון כדי לטעון מראש
  const cards = document.querySelectorAll('.videos-feed__card');
  if (cards.length >= 3) {
    const triggerCard = cards[cards.length - 3];
    loadMoreObserver.observe(triggerCard);
  }
}

async function loadMoreVideos() {
  if (isLoadingMore) return;
  isLoadingMore = true;
  
  const currentApp = window.NostrApp;
  const networkTag = getNetworkTag();
  
  // מצא את הפוסט הישן ביותר שיש לנו
  const oldestVideo = state.videos.length > 0 
    ? state.videos.reduce((oldest, v) => (v.createdAt < oldest.createdAt ? v : oldest), state.videos[0])
    : null;
  
  if (!oldestVideo) {
    isLoadingMore = false;
    return;
  }
  
  const untilTime = oldestVideo.createdAt;
  console.log('[videos] loadMoreVideos: loading older than', new Date(untilTime * 1000).toLocaleString());
  
  try {
    let moreEvents = [];
    
    if (currentApp && currentApp.postsById && currentApp.postsById.size > 0) {
      // טען מהמטמון של האפליקציה
      const fromApp = Array.from(currentApp.postsById.values());
      const existingIds = new Set(state.videos.map(v => v.id));
      const olderEvents = fromApp.filter(ev => 
        ev && 
        !existingIds.has(ev.id) && 
        (ev.created_at || 0) < untilTime
      );
      const filtered = filterEventsByNetwork(olderEvents, networkTag);
      filtered.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      moreEvents = filtered.slice(0, LOAD_MORE_BATCH);
    }
    
    if (moreEvents.length === 0) {
      // Fallback: משיכה מהרילאים
      const fetched = await fetchRecentNotes(LOAD_MORE_BATCH);
      const existingIds = new Set(state.videos.map(v => v.id));
      const olderEvents = fetched.filter(ev => 
        ev && 
        !existingIds.has(ev.id) && 
        (ev.created_at || 0) < untilTime
      );
      const filtered = filterEventsByNetwork(olderEvents, networkTag);
      filtered.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      moreEvents = filtered.slice(0, LOAD_MORE_BATCH);
    }
    
    if (moreEvents.length > 0) {
      // עיבוד האירועים לפורמט וידאו
      const newVideos = processEventsToVideos(moreEvents, currentApp);
      
      if (newVideos.length > 0) {
        // הוספה לסוף הרשימה
        state.videos = [...state.videos, ...newVideos];
        console.log('[videos] loadMoreVideos: added', newVideos.length, 'videos, total:', state.videos.length);
        
        // רינדור הפוסטים החדשים
        renderMoreVideos(newVideos);
        saveFeedCache(state.videos);
      }
    } else {
      console.log('[videos] loadMoreVideos: no more videos available');
    }
  } catch (err) {
    console.warn('[videos] loadMoreVideos failed', err);
  }
  
  isLoadingMore = false;
}

function processEventsToVideos(events, currentApp) {
  const videoEvents = [];
  
  events.forEach((event) => {
    if (!event || event.kind !== 1) return;
    if (currentApp?.deletedEventIds?.has(event.id)) return;
    
    const lines = String(event.content || '').split('\n');
    const mediaLinks = [];
    const textLines = [];
    
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('http') || trimmed.startsWith('data:')) {
        mediaLinks.push(trimmed);
      } else {
        textLines.push(trimmed);
      }
    });
    
    const youtubeId = mediaLinks.map(parseYouTube).find(Boolean);
    const liveUrl = mediaLinks.find(isHlsLiveLink) || null;
    const gameUrl = mediaLinks.find(isPlayableGameLink) || null;
    const videoUrl = mediaLinks.find(isVideoLink);
    
    if (!videoUrl && !youtubeId && !liveUrl && !gameUrl) return;
    
    const profileData = currentApp?.profileCache?.get(event.pubkey) || {};
    
    videoEvents.push({
      id: event.id,
      pubkey: event.pubkey,
      createdAt: event.created_at || 0,
      liveUrl: liveUrl || null,
      gameUrl: gameUrl || null,
      videoUrl: (liveUrl || gameUrl) ? null : (videoUrl || null),
      youtubeId: youtubeId || null,
      text: textLines.join('\n'),
      likes: 0,
      comments: 0,
      authorName: profileData.name || `משתמש ${String(event.pubkey || '').slice(0, 8)}`,
      authorPicture: profileData.picture || '',
      authorInitials: profileData.initials || 'AN',
      mediaLinks,
      mirrors: extractMirrors(event)
    });
  });
  
  return videoEvents;
}

function createVideoCard(video) {
  const result = renderVideoCard(video);
  const card = result && result.card ? result.card : result;
  if (result && result.mediaReadyPromise) {
    result.mediaReadyPromise.catch(() => {});
  }
  return card;
}

function renderMoreVideos(videos) {
  const stream = document.querySelector('.videos-feed__stream');
  if (!stream || !videos.length) return;
  
  videos.forEach((video) => {
    const card = createVideoCard(video);
    if (card) {
      stream.appendChild(card);
      observeVideoCard(card);
    }
  });
  
  updateLoadMoreTrigger();
}

// חלק לופ אינסופי (videos.js) – לולאה אינסופית כמו טיקטוק
// הגלילה הטבעית של CSS snap עובדת, רק מוסיפים חזרה להתחלה בסוף
function setupInfiniteLoop() {
  const viewport = document.querySelector('.videos-feed__viewport');
  const stream = document.querySelector('.videos-feed__stream');
  if (!viewport || !stream) return;
  
  let currentIndex = 0;
  
  const getCards = () => document.querySelectorAll('.videos-feed__card:not(.clone)');
  const getCardCount = () => getCards().length;
  
  // מעקב אחרי גלילה לזיהוי הכרטיס הנוכחי ולולאה אינסופית
  let scrollTimeout = null;
  let lastScrollTop = 0;
  let isJumping = false;
  
  const jumpToEnd = () => {
    if (isJumping) return;
    isJumping = true;
    const cards = getCards();
    const maxScroll = viewport.scrollHeight - viewport.clientHeight;
    viewport.style.scrollBehavior = 'auto';
    viewport.scrollTop = maxScroll;
    viewport.style.scrollBehavior = '';
    currentIndex = cards.length - 1;
    lastScrollTop = maxScroll;
    setTimeout(() => { isJumping = false; }, 50); /* מהיר יותר - 50ms במקום 200ms | HYPER CORE TECH */
  };
  
  const jumpToStart = () => {
    if (isJumping) return;
    isJumping = true;
    viewport.style.scrollBehavior = 'auto';
    viewport.scrollTop = 0;
    viewport.style.scrollBehavior = '';
    currentIndex = 0;
    lastScrollTop = 0;
    setTimeout(() => { isJumping = false; }, 50); /* מהיר יותר - 50ms במקום 200ms | HYPER CORE TECH */
  };
  
  // זיהוי גלילה למעלה כשאנחנו בהתחלה (wheel)
  viewport.addEventListener('wheel', (e) => {
    if (viewport.scrollTop <= 5 && e.deltaY < 0) {
      // בהתחלה וגוללים למעלה - קופצים לסוף
      e.preventDefault();
      jumpToEnd();
    }
  }, { passive: false });
  
  // זיהוי swipe למעלה כשאנחנו בהתחלה (touch)
  let touchStartY = 0;
  viewport.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  
  viewport.addEventListener('touchend', (e) => {
    const touchEndY = e.changedTouches[0].clientY;
    const deltaY = touchStartY - touchEndY;
    
    // swipe למטה (אצבע למטה = רוצה לחזור אחורה) כשבהתחלה
    if (viewport.scrollTop <= 5 && deltaY < -30) {
      jumpToEnd();
    }
  }, { passive: true });
  
  viewport.addEventListener('scroll', () => {
    if (scrollTimeout) clearTimeout(scrollTimeout);
    if (isJumping) return;
    
    scrollTimeout = setTimeout(() => {
      const cards = getCards();
      const cardCount = cards.length;
      if (cardCount === 0) return;
      
      const viewportTop = viewport.scrollTop;
      const viewportHeight = viewport.clientHeight;
      const maxScroll = viewport.scrollHeight - viewportHeight;
      const scrollingDown = viewportTop > lastScrollTop;
      lastScrollTop = viewportTop;
      
      // מציאת הכרטיס הנוכחי לפי גובה הכרטיסייה | HYPER CORE TECH
      const cardHeight = cards[0]?.offsetHeight || viewport.clientHeight;
      currentIndex = Math.round(viewportTop / cardHeight);
      if (currentIndex < 0) currentIndex = 0;
      if (currentIndex >= cardCount) currentIndex = cardCount - 1;
      
      // לולאה אינסופית - כשמגיעים לסוף, חוזרים להתחלה
      if (scrollingDown && viewportTop >= maxScroll - 5) {
        setTimeout(jumpToStart, 30); /* מהיר יותר - 30ms במקום 150ms | HYPER CORE TECH */
      }
    }, 16); /* מהיר יותר - 16ms (~60fps) במקום 100ms | HYPER CORE TECH */
  }, { passive: true });
  
  // תמיכה במקשי חצים
  document.addEventListener('keydown', (e) => {
    if (!document.querySelector('.videos-feed')) return;
    
    const cards = getCards();
    const cardCount = cards.length;
    if (cardCount === 0) return;
    
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      currentIndex = (currentIndex + 1) % cardCount;
      cards[currentIndex]?.scrollIntoView({ behavior: 'auto', block: 'start' });
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      currentIndex = (currentIndex - 1 + cardCount) % cardCount;
      cards[currentIndex]?.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  });
  
  // חשיפה גלובלית
  window.videoFeedNav = { getCurrentIndex: () => currentIndex, getCardCount };
}

// חלק יאללה וידאו (videos.js) – שאילת פוסטים מהרילאים (fallback ללא הפיד הראשי)
async function fetchRecentNotes(limit = 100, sinceOverride = undefined) {
  const app = window.NostrApp;
  if (!app || !app.pool || !Array.isArray(app.relayUrls) || app.relayUrls.length === 0) {
    console.warn('[videos] fetchRecentNotes: pool/relays not ready');
    return [];
  }
  // אם יש sinceOverride (מהמטמון) - נשתמש בו, אחרת 30 יום
  const since = sinceOverride || Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30;
  const networkTag = getNetworkTag();
  const filters = [{ kinds: [1], limit, since, '#t': [networkTag] }];
  const filtersNoSince = [{ kinds: [1], limit, '#t': [networkTag] }];
  try {
    console.log('[videos] fetchRecentNotes: using list', { relays: app.relayUrls.length, limit, since, fromCache: !!sinceOverride });
    if (typeof app.pool.list === 'function') {
      const listed = await app.pool.list(app.relayUrls, filters);
      if (Array.isArray(listed) && listed.length > 0) {
        console.log('[videos] fetchRecentNotes: list returned', listed.length);
        return listed;
      }
      // ניסיון נוסף ללא since
      const listed2 = await app.pool.list(app.relayUrls, filtersNoSince);
      if (Array.isArray(listed2) && listed2.length > 0) {
        console.log('[videos] fetchRecentNotes: list (no since) returned', listed2.length);
        return listed2;
      }
    }
    if (typeof app.pool.listMany === 'function') {
      const listed = await app.pool.listMany(app.relayUrls, filters);
      if (Array.isArray(listed) && listed.length > 0) {
        console.log('[videos] fetchRecentNotes: listMany returned', listed.length);
        return listed;
      }
      const listed2 = await app.pool.listMany(app.relayUrls, filtersNoSince);
      if (Array.isArray(listed2) && listed2.length > 0) {
        console.log('[videos] fetchRecentNotes: listMany (no since) returned', listed2.length);
        return listed2;
      }
    }
    if (typeof app.pool.querySync === 'function') {
      console.log('[videos] fetchRecentNotes: trying querySync');
      const res = await app.pool.querySync(app.relayUrls, filters[0]);
      const events = Array.isArray(res) ? res : (Array.isArray(res?.events) ? res.events : []);
      if (events.length > 0) {
        console.log('[videos] fetchRecentNotes: querySync returned', events.length);
        return events;
      }
      const res2 = await app.pool.querySync(app.relayUrls, filtersNoSince[0]);
      const events2 = Array.isArray(res2) ? res2 : (Array.isArray(res2?.events) ? res2.events : []);
      if (events2.length > 0) {
        console.log('[videos] fetchRecentNotes: querySync (no since) returned', events2.length);
        return events2;
      }
    }
    // fallback: שימוש במנוי כדי למשוך אירועים חיים ומהירים
    if (typeof app.pool.sub === 'function' || typeof app.pool.subscribeMany === 'function') {
      console.log('[videos] fetchRecentNotes: fallback sub start');
      return await new Promise((resolve) => {
        const collected = [];
        const sub = typeof app.pool.sub === 'function'
          ? app.pool.sub(app.relayUrls, filtersNoSince)
          : app.pool.subscribeMany(app.relayUrls, filtersNoSince);
        const done = () => {
          try { sub.unsub(); } catch (_) {}
          const sorted = collected.sort((a,b) => (b.created_at||0)-(a.created_at||0));
          console.log('[videos] fetchRecentNotes: sub done', { count: sorted.length });
          resolve(sorted);
        };
        const timer = setTimeout(done, 3000);
        sub.on('event', (ev) => { collected.push(ev); });
        sub.on('eose', () => {
          clearTimeout(timer);
          done();
        });
      });
    }
  } catch (err) {
    console.warn('[videos] fetchRecentNotes failed', err);
  }
  return [];
}

// חלק יאללה וידאו (videos.js) – טעינת לייקים ותגובות לפוסטי וידאו
// חלק באצ'ים (videos.js) – פיצול שאילתות לבאצ'ים קטנים למניעת עומס על relays | HYPER CORE TECH
const ENGAGEMENT_BATCH_SIZE = 15; // גודל באצ' לשאילתות לייקים/תגובות

async function loadLikesAndCommentsForVideos(eventIds) {
  if (!Array.isArray(eventIds) || eventIds.length === 0) return;

  const app = window.NostrApp;
  if (!app || !app.pool || !Array.isArray(app.relayUrls) || app.relayUrls.length === 0) {
    console.warn('[videos] Cannot load likes/comments: pool not ready');
    return;
  }

  const since = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30; // 30 יום

  // חלק באצ'ים (videos.js) – פיצול ה-eventIds לבאצ'ים קטנים | HYPER CORE TECH
  const batches = [];
  for (let i = 0; i < eventIds.length; i += ENGAGEMENT_BATCH_SIZE) {
    batches.push(eventIds.slice(i, i + ENGAGEMENT_BATCH_SIZE));
  }

  console.log('[videos] Loading likes/comments in batches:', { total: eventIds.length, batches: batches.length });

  let totalLoaded = 0;

  for (const batch of batches) {
    try {
      // טעינת לייקים (kind 7)
      const likesFilter = { kinds: [7], '#e': batch, since };
      // טעינת תגובות (kind 1 עם תג e)
      const commentsFilter = { kinds: [1], '#e': batch, since };

      let allEvents = [];

      if (typeof app.pool.list === 'function') {
        const results = await app.pool.list(app.relayUrls, [likesFilter, commentsFilter]);
        if (Array.isArray(results)) allEvents = results;
      } else if (typeof app.pool.querySync === 'function') {
        const likesRes = await app.pool.querySync(app.relayUrls, likesFilter);
        const commentsRes = await app.pool.querySync(app.relayUrls, commentsFilter);
        const likes = Array.isArray(likesRes) ? likesRes : (Array.isArray(likesRes?.events) ? likesRes.events : []);
        const comments = Array.isArray(commentsRes) ? commentsRes : (Array.isArray(commentsRes?.events) ? commentsRes.events : []);
        allEvents = [...likes, ...comments];
      }

      totalLoaded += allEvents.length;

      // עיבוד לייקים ותגובות בהתאם ללוגיקת הפיד הראשי | HYPER CORE TECH
      allEvents.forEach((event) => {
        if (event.kind === 7 && typeof app.registerLike === 'function') {
          app.registerLike(event);
          return;
        }
        if (event.kind !== 1 || !Array.isArray(event.tags)) {
          return;
        }
        const parentTag = event.tags.find((tag) => Array.isArray(tag) && tag[0] === 'e' && tag[1]);
        if (!parentTag) {
          return;
        }
        const parentId = parentTag[1];
        registerVideoCommentRecord(app, event, parentId);
      });

      // עדכון UI אחרי כל באצ' | HYPER CORE TECH
      batch.forEach(id => updateVideoLikeButton(id));

    } catch (err) {
      console.warn('[videos] Failed to load likes/comments batch:', err);
    }
  }

  console.log('[videos] Loaded likes/comments:', { count: totalLoaded });
}

// חלק יאללה וידאו (videos.js) – רישום אירועים למפות המשותפות כדי לאפשר התרעות מלאות | HYPER CORE TECH
function registerVideoSourceEvent(event) {
  if (!event || !event.id) return;
  const app = window.NostrApp;
  if (!app) return;

  if (!(app.eventAuthorById instanceof Map)) {
    app.eventAuthorById = new Map();
  }
  if (!(app.postsById instanceof Map)) {
    app.postsById = new Map();
  }

  const normalizedPubkey = typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : '';
  if (normalizedPubkey) {
    app.eventAuthorById.set(event.id, normalizedPubkey);
  }
  app.postsById.set(event.id, event);

  if (typeof app.processPendingNotifications === 'function') {
    try {
      app.processPendingNotifications(event.id);
    } catch (err) {
      console.warn('[videos] processPendingNotifications failed', err);
    }
  }
}

// חלק יאללה וידאו (videos.js) – רישום לייקים/תגובות להשלמת ספירות UI | HYPER CORE TECH
function registerVideoEngagementEvent(event) {
  if (!event || !event.kind) return;
  const app = window.NostrApp;
  if (!app) return;

  if (event.kind === 7 && typeof app.registerLike === 'function') {
    app.registerLike(event);
    return;
  }

  if (event.kind !== 1) {
    return;
  }

  const parentTag = Array.isArray(event.tags) ? event.tags.find((tag) => Array.isArray(tag) && tag[0] === 'e' && tag[1]) : null;
  if (!parentTag) {
    return;
  }

  registerVideoCommentRecord(app, event, parentTag[1]);
}

// חלק יאללה וידאו (videos.js) – רישום תגובה למבני הנתונים המשותפים והפעלת ההתרעות | HYPER CORE TECH
function registerVideoCommentRecord(app, event, parentId) {
  if (!app || !event || !parentId) {
    return;
  }

  if (typeof app.registerComment === 'function') {
    try {
      app.registerComment(event, parentId);
      return;
    } catch (err) {
      console.warn('[videos] app.registerComment failed, falling back to local handler', err);
    }
  }

  if (!(app.commentsByParent instanceof Map)) {
    app.commentsByParent = new Map();
  }

  if (!app.commentsByParent.has(parentId)) {
    app.commentsByParent.set(parentId, new Map());
  } else if (Array.isArray(app.commentsByParent.get(parentId))) {
    const legacyList = app.commentsByParent.get(parentId);
    const normalizedMap = new Map();
    legacyList.forEach((legacyEvent) => {
      if (legacyEvent?.id) {
        normalizedMap.set(legacyEvent.id, legacyEvent);
      }
    });
    app.commentsByParent.set(parentId, normalizedMap);
  }

  const commentMap = app.commentsByParent.get(parentId);
  if (!(commentMap instanceof Map)) {
    return;
  }

  if (event.id) {
    commentMap.set(event.id, event);
  }

  if (!(app.eventAuthorById instanceof Map)) {
    app.eventAuthorById = new Map();
  }
  if (event?.id && typeof event?.pubkey === 'string') {
    app.eventAuthorById.set(event.id, event.pubkey.toLowerCase());
  }

  if (typeof app.updateCommentsForParent === 'function') {
    try {
      app.updateCommentsForParent(parentId);
    } catch (err) {
      console.warn('[videos] updateCommentsForParent failed', err);
    }
  }

  // עדכון כפתור התגובות בדף הווידאו
  try {
    updateVideoCommentButton(parentId);
  } catch (err) {
    console.warn('[videos] updateVideoCommentButton failed', err);
  }

  if (typeof app.handleNotificationForComment === 'function') {
    try {
      app.handleNotificationForComment(event, parentId);
    } catch (err) {
      console.warn('[videos] handleNotificationForComment failed', err);
    }
  }
}

// חלק יאללה וידאו (videos.js) – טעינת סרטונים מהפיד
async function loadVideos() {
  if (feedDownloadsPaused) {
    console.log('[videos] loadVideos deferred — upload in progress');
    return;
  }

  // הצגת אנימציית טעינה רק אם אין תוכן מהמטמון
  if (!state.firstCardRendered) {
    showLoadingAnimation();
  }
  
  const currentApp = window.NostrApp;
  let sourceEvents = [];
  const networkTag = getNetworkTag();
  
  // קבלת מידע על המטמון לסינון פוסטים קיימים והורדת רק החדשים
  const cacheInfo = getCacheInfo();
  const cachedIds = cacheInfo?.cachedIds || new Set();
  const newestCachedTime = cacheInfo?.newestPostTime || 0;
  
  setLoadingProgress(10);
  setLoadingStatus('בודק מטמון מקומי...');
  
  console.log('[videos] loadVideos: cache info', { 
    cachedCount: cachedIds.size, 
    newestPostTime: newestCachedTime ? new Date(newestCachedTime * 1000).toLocaleString() : 'none'
  });

  setLoadingProgress(20);
  setLoadingStatus('מתחבר לשרתים...');

  if (currentApp && currentApp.postsById && currentApp.postsById.size > 0) {
    const fromApp = Array.from(currentApp.postsById.values());
    // סינון פוסטים שכבר יש במטמון
    const newFromApp = fromApp.filter(ev => ev && !cachedIds.has(ev.id));
    const filtered = filterEventsByNetwork(newFromApp, networkTag);
    // מיון לפי תאריך (חדש ראשון) והגבלה למספר הפוסטים הראשוני
    filtered.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    sourceEvents = filtered.slice(0, INITIAL_LOAD_LIMIT);
    console.log('[videos] loadVideos: postsById', { total: fromApp.length, new: newFromApp.length, afterFilter: filtered.length, limited: sourceEvents.length });
    setLoadingProgress(40);
  } else {
    // Fallback: משיכת אירועים חדשים בלבד מהרילאים (since = הפוסט האחרון במטמון)
    setLoadingStatus('מוריד פוסטים מהרשת...');
    const sinceTime = newestCachedTime > 0 ? newestCachedTime : undefined;
    const fetched = await fetchRecentNotes(INITIAL_LOAD_LIMIT, sinceTime);
    setLoadingProgress(40);
    // סינון פוסטים שכבר יש במטמון והגבלה
    const newFetched = fetched.filter(ev => ev && !cachedIds.has(ev.id));
    const filtered = filterEventsByNetwork(newFetched, networkTag);
    filtered.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    sourceEvents = filtered.slice(0, INITIAL_LOAD_LIMIT);
    console.log('[videos] loadVideos: relays fallback', { fetched: fetched.length || 0, new: newFetched.length, afterFilter: sourceEvents.length, since: sinceTime });
  }

  setLoadingProgress(50);
  setLoadingStatus('בודק עדכונים מהרשת שלך...');

  // העשרת המקור עם רשת המשתמש - רק פוסטים חדשים
  const authors = [];
  if (currentApp?.followingSet && currentApp.followingSet.size) authors.push(...Array.from(currentApp.followingSet));
  if (currentApp?.publicKey) authors.push(currentApp.publicKey);
  if (authors.length) {
    const sinceTime = newestCachedTime > 0 ? newestCachedTime : undefined;
    const netNotes = await fetchNetworkNotes(authors.slice(0, 100), LOAD_MORE_BATCH, sinceTime);
    if (Array.isArray(netNotes) && netNotes.length) {
      // סינון פוסטים שכבר יש במטמון
      const newNetNotes = netNotes.filter(ev => ev && !cachedIds.has(ev.id));
      const filteredNet = filterEventsByNetwork(newNetNotes, networkTag);
      console.log('[videos] loadVideos: network authors', { fetched: netNotes.length, new: newNetNotes.length, afterFilter: filteredNet.length });
      sourceEvents = sourceEvents.concat(filteredNet);
    } else {
      console.log('[videos] loadVideos: network authors', { fetched: netNotes.length || 0, afterFilter: 0 });
    }
  }

  setLoadingProgress(60);
  setLoadingStatus('מסנן תוכן...');

  // הסרת כפילויות לפי id והגבלה סופית
  if (Array.isArray(sourceEvents) && sourceEvents.length) {
    const seen = new Set();
    sourceEvents = sourceEvents.filter(ev => { if (!ev || !ev.id) return false; if (seen.has(ev.id)) return false; seen.add(ev.id); return true; });
    // מיון לפי תאריך והגבלה למספר הפוסטים המקסימלי
    sourceEvents.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    sourceEvents = sourceEvents.slice(0, INITIAL_LOAD_LIMIT);
    console.log('[videos] loadVideos: final limited to', sourceEvents.length);
  }

  // אם אין פוסטים חדשים ויש כבר תוכן מהמטמון - סיים
  if ((!Array.isArray(sourceEvents) || sourceEvents.length === 0) && state.videos.length > 0) {
    console.log('[videos] loadVideos: no new events, keeping cached content');
    // חלק לייקים (videos.js) – טעינת לייקים גם כשאין פוסטים חדשים | HYPER CORE TECH
    const cachedIds = state.videos.map(v => v.id);
    if (cachedIds.length > 0) {
      loadLikesAndCommentsForVideos(cachedIds).then(() => {
        cachedIds.forEach(id => updateVideoLikeButton(id));
      }).catch(() => {});
    }
    setLoadingProgress(100);
    setLoadingStatus('הכל מעודכן!');
    hideLoadingAnimation();
    return;
  }

  if (!Array.isArray(sourceEvents) || sourceEvents.length === 0) {
    console.warn('[videos] loadVideos: no events after both sources');
    setLoadingStatus('מחפש תוכן...');
    setTimeout(loadVideos, 1000);
    return;
  }

  const videoEvents = [];
  sourceEvents.forEach((event) => {
    if (!event || event.kind !== 1) return;
    if (currentApp?.deletedEventIds?.has(event.id)) {
      try {
        console.log('%c[DELETE_DEBUG] videos skip deleted', 'color: #FF5722; font-weight: bold', { id: event.id });
      } catch (_) {}
      return;
    }

    const lines = String(event.content || '').split('\n');
    const mediaLinks = [];
    const textLines = [];

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('http') || trimmed.startsWith('data:')) {
        mediaLinks.push(trimmed);
      } else {
        textLines.push(trimmed);
      }
    });

    const youtubeId = mediaLinks.map(parseYouTube).find(Boolean);
    let liveUrl = mediaLinks.find(isHlsLiveLink) || null;
    let gameUrl = mediaLinks.find(isPlayableGameLink) || null;
    let videoUrl = mediaLinks.find(isVideoLink);
    const imageUrl = mediaLinks.find(isImageLink);

    // תגיות media / live-hls / game-embed
    let mediaHash = '';
    const mediaMirrors = [];
    if (Array.isArray(event.tags)) {
      event.tags.forEach(tag => {
        if (!Array.isArray(tag)) return;
        if (tag[0] === 'media' && tag[2]) {
          const mime = String(tag[1] || '');
          const tagUrl = String(tag[2]);
          const tagHash = tag[3] || '';
          if (mime.includes('mpegurl') || isHlsLiveLink(tagUrl)) {
            liveUrl = liveUrl || tagUrl;
          } else if (mime === 'text/html' || mime.includes('html') || isPlayableGameLink(tagUrl)) {
            gameUrl = gameUrl || tagUrl;
          } else if (tagUrl === videoUrl && tagHash) {
            mediaHash = tagHash;
          }
        }
        if (tag[0] === 't' && String(tag[1] || '').toLowerCase() === 'live-hls') {
          const httpLink = mediaLinks.find((l) => /^https?:\/\//i.test(l));
          if (httpLink) liveUrl = liveUrl || httpLink;
        }
        if (tag[0] === 't' && String(tag[1] || '').toLowerCase() === 'game-embed') {
          const httpLink = mediaLinks.find((l) => /^https?:\/\//i.test(l) && !isHlsLiveLink(l));
          if (httpLink) gameUrl = gameUrl || httpLink;
        }
        if (tag[0] === 'mirror' && tag[1]) {
          mediaMirrors.push(tag[1]);
        }
      });
    }

    if (liveUrl || gameUrl) videoUrl = null;
    const hasMedia = liveUrl || gameUrl || videoUrl || imageUrl || youtubeId;

    if (hasMedia) {
      registerVideoSourceEvent(event);
      
      videoEvents.push({
        id: event.id,
        pubkey: event.pubkey,
        content: textLines.join(' '),
        youtubeId: youtubeId || null,
        liveUrl: liveUrl || null,
        gameUrl: gameUrl || null,
        videoUrl: (liveUrl || gameUrl) ? null : (videoUrl || null),
        imageUrl: imageUrl || null,
        hash: mediaHash || '',
        mirrors: mediaMirrors,
        fx: resolveFxValue(event, imageUrl),
        createdAt: event.created_at || 0,
      });
    }
  });

  setLoadingProgress(70);
  setLoadingStatus('טוען פרופילים...');

  // משיכת פרופילים לכל המחברים
  const uniqueAuthors = [...new Set(videoEvents.map(v => v.pubkey))];
  if (uniqueAuthors.length > 0 && typeof currentApp?.fetchProfile === 'function') {
    await Promise.all(uniqueAuthors.map(pubkey => currentApp.fetchProfile(pubkey)));
  }

  setLoadingProgress(80);
  setLoadingStatus('טוען לייקים ותגובות...');

  // טעינת לייקים ותגובות לכל הפוסטים
  await loadLikesAndCommentsForVideos(videoEvents.map(v => v.id));

  // רישום נתוני מעורבות למפות המטא | HYPER CORE TECH
  if (Array.isArray(sourceEvents)) {
    sourceEvents.forEach(registerVideoEngagementEvent);
  }

  // התחלת מנוי חי כדי לקבל התרעות חדשות בזמן אמת
  setupVideoRealtimeSubscription(videoEvents.map(v => v.id));

  setLoadingProgress(90);
  setLoadingStatus('מכין תצוגה...');

  // עדכון נתוני המחברים
  videoEvents.forEach((video) => {
    const profileData = currentApp?.profileCache?.get(video.pubkey) || {};
    video.authorName = profileData.name || `משתמש ${String(video.pubkey || '').slice(0, 8)}`;
    video.authorPicture = profileData.picture || '';
    video.authorInitials = profileData.initials || 'AN';
  });

  videoEvents.sort((a, b) => b.createdAt - a.createdAt);
  console.log('[videos] loadVideos: video events found', { count: videoEvents.length });
  
  // חלק מיזוג מטמון (videos.js) – מיזוג פוסטים חדשים עם קיימים במקום החלפה מלאה | HYPER CORE TECH
  const existingIds = new Set(state.videos.map(v => v.id));
  const newVideos = videoEvents.filter(v => !existingIds.has(v.id));
  
  if (newVideos.length > 0) {
    // הוספת פוסטים חדשים בתחילת הרשימה
    state.videos = [...newVideos, ...state.videos];
    // הסרת כפילויות ומיון מחדש
    const seen = new Set();
    state.videos = state.videos.filter(v => {
      if (seen.has(v.id)) return false;
      seen.add(v.id);
      return true;
    });
    state.videos.sort((a, b) => b.createdAt - a.createdAt);
    console.log('[videos] merged new videos', { newCount: newVideos.length, totalCount: state.videos.length });
  } else if (state.videos.length === 0) {
    // אין פוסטים קיימים – השתמש בחדשים
    state.videos = videoEvents;
  }
  
  // חלק מד טעינה חכם (videos.js) – שחרור הפיד מוקדם כשיש לפחות 5 פוסטים | HYPER CORE TECH
  const MIN_POSTS_FOR_RELEASE = 5;
  const totalPosts = state.videos.length;
  
  if (totalPosts >= MIN_POSTS_FOR_RELEASE) {
    // יש מספיק פוסטים - שחרור מיידי של הפיד
    setLoadingProgress(100);
    setLoadingStatus(`נמצאו ${totalPosts} פוסטים!`);
    console.log('[videos] Early release: enough posts ready', { count: totalPosts });
  } else if (totalPosts > 0) {
    // יש פוסטים אבל פחות מ-5 - עדכון מד לפי כמות
    const progress = Math.min(95, 60 + (totalPosts / MIN_POSTS_FOR_RELEASE) * 35);
    setLoadingProgress(progress);
    setLoadingStatus(`נמצאו ${totalPosts} פוסטים, מחפש עוד...`);
  } else {
    setLoadingProgress(95);
    setLoadingStatus('מחפש תוכן...');
  }
  
  saveFeedCache(state.videos);
  renderVideos();
}

// חלק יאללה וידאו (videos.js) – מנוי נתונים חי לפיד הווידאו לצורך לייקים/תגובות/התראות | HYPER CORE TECH
let videoRealtimeSub = null;
function setupVideoRealtimeSubscription(eventIds = []) {
  const app = window.NostrApp;
  if (!app || !app.pool || typeof app.pool.subscribeMany !== 'function') {
    return;
  }
  if (videoRealtimeSub) {
    try { videoRealtimeSub.close(); } catch (_) {}
    videoRealtimeSub = null;
  }
  const viewerKey = typeof app.publicKey === 'string' ? app.publicKey : '';
  const filters = buildVideoFeedFilters();
  if (Array.isArray(eventIds) && eventIds.length > 0) {
    filters.push({ kinds: [1], '#e': eventIds, limit: 200 });
    filters.push({ kinds: [7], '#e': eventIds, limit: 200 });
  }

  videoRealtimeSub = app.pool.subscribeMany(app.relayUrls, filters, {
    onevent: (event) => {
      if (!event || !event.kind) return;
      if (event.kind === 1) {
        registerVideoSourceEvent(event);
        registerVideoEngagementEvent(event);
      } else if (event.kind === 5) {
        // טיפול במחיקות בזמן אמת
        console.log('%c[DELETE_DEBUG] videos realtime deletion received', 'color: #FF5722; font-weight: bold', {
          id: event.id,
          pubkey: event.pubkey,
          tags: event.tags
        });
        if (typeof app.registerDeletion === 'function') {
          app.registerDeletion(event);
        }
        // הסרת הפוסט מהפיד המקומי
        if (Array.isArray(event.tags)) {
          event.tags.forEach(tag => {
            if (Array.isArray(tag) && tag[0] === 'e' && tag[1]) {
              const deletedId = tag[1];
              removeVideoFromState(deletedId);
              removeVideoCard(deletedId);
              console.log('%c[DELETE_DEBUG] videos removed card', 'color: #FF5722; font-weight: bold', { deletedId });
            }
          });
        }
      } else if (event.kind === 7) {
        registerVideoEngagementEvent(event);
      } else if (event.kind === (app.FOLLOW_KIND || 40010)) {
        if (typeof app.handleNotificationForFollow === 'function') {
          app.handleNotificationForFollow(event);
        }
      } else if (event.kind === (app.DATING_LIKE_KIND || 9000)) {
        if (typeof app.handleNotificationForDatingLike === 'function') {
          app.handleNotificationForDatingLike(event);
        }
      }
    },
    oneose: () => {
      if (typeof app.refreshFollowButtons === 'function') {
        app.refreshFollowButtons(selectors.stream || document);
      }
    }
  });
}

// חלק כפתורי גלילה (videos.js) – יצירת כפתורי גלילה שמאליים למעלה/למטה בדסקטופ | HYPER CORE TECH
function createNavArrows() {
  // בדיקה אם כבר קיימים
  if (document.querySelector('.videos-nav-arrows')) return;
  
  const container = document.createElement('div');
  container.className = 'videos-nav-arrows';
  
  const upBtn = document.createElement('button');
  upBtn.type = 'button';
  upBtn.className = 'videos-nav-arrow-btn';
  upBtn.setAttribute('aria-label', 'סרטון קודם');
  upBtn.innerHTML = '<i class="fa-solid fa-chevron-up"></i>';
  
  const downBtn = document.createElement('button');
  downBtn.type = 'button';
  downBtn.className = 'videos-nav-arrow-btn';
  downBtn.setAttribute('aria-label', 'סרטון הבא');
  downBtn.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
  
  container.appendChild(upBtn);
  container.appendChild(downBtn);
  document.body.appendChild(container);
  
  // פונקציונליות גלילה
  const scrollToCard = (direction) => {
    const viewport = document.querySelector('.videos-feed__viewport');
    if (!viewport) return;
    
    const cards = viewport.querySelectorAll('.videos-feed__card');
    if (!cards.length) return;
    
    const viewportRect = viewport.getBoundingClientRect();
    const viewportCenter = viewportRect.top + viewportRect.height / 2;
    
    let currentIndex = -1;
    cards.forEach((card, index) => {
      const cardRect = card.getBoundingClientRect();
      const cardCenter = cardRect.top + cardRect.height / 2;
      if (Math.abs(cardCenter - viewportCenter) < cardRect.height / 2) {
        currentIndex = index;
      }
    });
    
    let targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    targetIndex = Math.max(0, Math.min(cards.length - 1, targetIndex));
    
    if (targetIndex >= 0 && targetIndex < cards.length) {
      cards[targetIndex].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    
    // עדכון מצב הכפתורים
    upBtn.disabled = targetIndex <= 0;
    downBtn.disabled = targetIndex >= cards.length - 1;
  };
  
  upBtn.addEventListener('click', () => scrollToCard('up'));
  downBtn.addEventListener('click', () => scrollToCard('down'));
  
  // עדכון מצב כפתורים בגלילה
  const viewport = document.querySelector('.videos-feed__viewport');
  if (viewport) {
    viewport.addEventListener('scroll', () => {
      const cards = viewport.querySelectorAll('.videos-feed__card');
      if (!cards.length) return;
      
      const viewportRect = viewport.getBoundingClientRect();
      const viewportCenter = viewportRect.top + viewportRect.height / 2;
      
      let currentIndex = 0;
      cards.forEach((card, index) => {
        const cardRect = card.getBoundingClientRect();
        const cardCenter = cardRect.top + cardRect.height / 2;
        if (Math.abs(cardCenter - viewportCenter) < cardRect.height / 2) {
          currentIndex = index;
        }
      });
      
      upBtn.disabled = currentIndex <= 0;
      downBtn.disabled = currentIndex >= cards.length - 1;
    });
  }
  
  console.log('[videos] Nav arrows created');
}

// חלק עוקבים בתפריט צד (videos.js) – יצירת מקטע עוקבים ופוטר בתפריט הצד בדסקטופ | HYPER CORE TECH
function createSidebarFollowersSection() {
  // רק בדסקטופ
  if (window.innerWidth < 769) return;
  
  // בדיקה אם כבר קיים
  if (document.querySelector('.sidebar-followers-separator')) return;
  
  const sidebar = document.querySelector('.primary-nav');
  if (!sidebar) {
    console.log('[videos] Sidebar not found, skipping followers section');
    return;
  }
  
  // יצירת קו הפרדה
  const separator1 = document.createElement('div');
  separator1.className = 'sidebar-followers-separator';
  
  // כותרת מקטע עוקבים
  const title = document.createElement('div');
  title.className = 'sidebar-followers-title';
  title.textContent = 'חשבונות עוקבים';
  
  // רשימת עוקבים
  const followersList = document.createElement('ul');
  followersList.className = 'sidebar-followers-list';
  followersList.id = 'sidebarFollowersList';
  
  // הודעה ראשונית
  const emptyMsg = document.createElement('li');
  emptyMsg.className = 'sidebar-followers-empty';
  emptyMsg.textContent = 'טוען עוקבים...';
  followersList.appendChild(emptyMsg);
  
  // קו הפרדה לפוטר
  const separator2 = document.createElement('div');
  separator2.className = 'sidebar-followers-separator';

  // כותרת משחקים
  const gamesTitle = document.createElement('div');
  gamesTitle.className = 'nav-section-title sidebar-games-title';
  gamesTitle.textContent = 'משחקים';

  // רשימת משחקים
  const gamesList = document.createElement('ul');
  gamesList.className = 'sidebar-games-list';

  const App = window.NostrApp || {};

  const makeGameItem = (label, iconClass, href) => {
    const li = document.createElement('li');
    li.className = 'sidebar-game-item';
    li.innerHTML = `
      <span class="sidebar-game-label">${label}</span>
      <i class="${iconClass}"></i>
    `;
    li.addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof App.openGamesPanel === 'function') {
        App.openGamesPanel(href);
      } else {
        window.location.href = href;
      }
    });
    return li;
  };

  gamesList.appendChild(makeGameItem('דף המשחקים', 'fa-solid fa-gamepad', 'games.html'));
  gamesList.appendChild(makeGameItem('משחק רשת דום', 'fa-solid fa-gun', 'games.html#doom'));
  gamesList.appendChild(makeGameItem('משחק רשת טריוויה', 'fa-solid fa-dice', 'games.html#trivia'));

  // קו הפרדה אחרי מקטע משחקים
  const gamesSeparatorAfter = document.createElement('div');
  gamesSeparatorAfter.className = 'nav-separator sidebar-games-separator';

  // פוטר עם קישורים
  const footer = document.createElement('div');
  footer.className = 'sidebar-footer';
  footer.innerHTML = `
    <div class="footer-links">
      <a href="terms.html">חברה</a> • 
      <a href="terms.html">אודות</a> • 
      <a href="news.html">חדר חדשות</a> • 
      <a href="terms.html">צור קשר</a>
    </div>
    <div class="footer-links">
      <a href="terms.html">הנחיות קהילה</a> • 
      <a href="terms.html">תנאי שימוש</a>
    </div>
    <div class="footer-copyright">© 2026 SOS</div>
  `;
  
  // הוספה לתפריט הצד
  sidebar.appendChild(separator1);
  sidebar.appendChild(title);
  sidebar.appendChild(followersList);
  sidebar.appendChild(separator2); // קו אחד בין עוקבים למשחקים
  sidebar.appendChild(gamesTitle);
  sidebar.appendChild(gamesList);
  sidebar.appendChild(gamesSeparatorAfter); // קו אחרי משחקים
  sidebar.appendChild(footer);
  
  console.log('[videos] Sidebar followers section created');
  
  // טעינת עוקבים מהרשת
  loadSidebarFollowers();
}

// חלק טעינת עוקבים (videos.js) – משיכת עוקבים מהרשת והצגתם בתפריט הצד | HYPER CORE TECH
async function loadSidebarFollowers() {
  const App = window.NostrApp || {};
  const followersList = document.getElementById('sidebarFollowersList');
  if (!followersList) return;
  
  // בדיקה אם המשתמש מחובר
  if (!App.publicKey) {
    followersList.innerHTML = '<li class="sidebar-followers-empty">התחבר לצפייה בעוקבים</li>';
    return;
  }
  
  // ניסיון להירשם לעוקבים אם קייםת הפונקציה
  if (typeof App.subscribeFollowers === 'function') {
    App.subscribeFollowers(App.publicKey, (followers) => {
      renderSidebarFollowers(followers);
    });
  } else {
    // Fallback - ניסיון לקחת מהרשת
    followersList.innerHTML = '<li class="sidebar-followers-empty">אין עוקבים להצגה</li>';
  }
}

// חלק רינדור עוקבים (videos.js) – הצגת רשימת העוקבים בתפריט הצד | HYPER CORE TECH
function renderSidebarFollowers(followers) {
  const followersList = document.getElementById('sidebarFollowersList');
  if (!followersList) return;
  
  const App = window.NostrApp || {};
  const escapeHtml = typeof App.escapeHtml === 'function' ? App.escapeHtml : (v) => v;
  
  // ניקוי הרשימה
  followersList.innerHTML = '';
  
  if (!Array.isArray(followers) || followers.length === 0) {
    const emptyMsg = document.createElement('li');
    emptyMsg.className = 'sidebar-followers-empty';
    emptyMsg.textContent = 'אין עוקבים להצגה כרגע';
    followersList.appendChild(emptyMsg);
    return;
  }
  
  // הצגת עד 5 עוקבים
  const displayFollowers = followers.slice(0, 5);
  
  displayFollowers.forEach((follower) => {
    const pubkey = follower.pubkey || '';
    const cached = App.profileCache instanceof Map ? App.profileCache.get(pubkey) : null;
    const fallbackName = pubkey ? `משתמש ${pubkey.slice(0, 8)}` : 'משתמש';
    const name = follower.name || cached?.name || fallbackName;
    const picture = follower.picture || cached?.picture || '';
    const initials = typeof App.getInitials === 'function' ? App.getInitials(name) : name.slice(0, 2).toUpperCase();
    const tag = pubkey ? pubkey.slice(0, 12) : '';
    
    const li = document.createElement('li');
    li.className = 'sidebar-follower-item';
    li.setAttribute('data-pubkey', pubkey);
    
    li.innerHTML = `
      <div class="sidebar-follower-img">
        ${picture ? `<img src="${escapeHtml(picture)}" alt="${escapeHtml(name)}" loading="lazy">` : `<span>${escapeHtml(initials)}</span>`}
      </div>
      <div class="sidebar-follower-info">
        <div class="sidebar-follower-name">${escapeHtml(name)}</div>
        <div class="sidebar-follower-tag">${escapeHtml(tag)}</div>
      </div>
    `;
    
    // לחיצה פותחת פרופיל
    li.addEventListener('click', () => {
      if (pubkey && typeof App.openPublicProfile === 'function') {
        App.openPublicProfile(pubkey);
      } else if (pubkey) {
        window.location.href = `profile-view.html?pubkey=${pubkey}`;
      }
    });
    
    followersList.appendChild(li);
    
    // טעינת פרופיל אם חסר
    if (!picture && !cached && typeof App.fetchProfile === 'function') {
      App.fetchProfile(pubkey).then((profile) => {
        if (profile) {
          const imgEl = li.querySelector('.sidebar-follower-img');
          const nameEl = li.querySelector('.sidebar-follower-name');
          if (imgEl && profile.picture) {
            imgEl.innerHTML = `<img src="${escapeHtml(profile.picture)}" alt="${escapeHtml(profile.name || name)}" loading="lazy">`;
          }
          if (nameEl && profile.name) {
            nameEl.textContent = profile.name;
          }
        }
      }).catch(() => {});
    }
  });
  
  console.log(`[videos] Rendered ${displayFollowers.length} followers in sidebar`);
}

// חלק יאללה וידאו (videos.js) – אתחול בעת טעינת הדף
async function init() {
  selectors.stream = document.getElementById('videosStream');
  selectors.status = document.getElementById('videosStatus');

  if (!selectors.stream || !selectors.status) {
    return;
  }

  // חלק כפתורי גלילה (videos.js) – יצירת כפתורי גלילה בדסקטופ | HYPER CORE TECH
  createNavArrows();
  
  // חלק עוקבים בתפריט צד (videos.js) – יצירת מקטע עוקבים ופוטר בדסקטופ | HYPER CORE TECH
  createSidebarFollowersSection();

  // חלק כפתור בית (videos.js) – סגירת overlays במקום ניווט כשהפיד כבר פתוח | HYPER CORE TECH
  const homeButton = document.getElementById('videosTopHomeButton');
  if (homeButton) {
    homeButton.addEventListener('click', () => {
      // ניסיון לסגור overlays פתוחים - אם נסגר משהו, לא לנווט
      const App = window.NostrApp || {};
      if (typeof App.closeAllOverlays === 'function' && App.closeAllOverlays()) {
        console.log('[VIDEOS] Home button closed overlay, staying on videos');
        return;
      }
      // אם אין overlay פתוח, גלול לראש הפיד
      const viewport = document.querySelector('.videos-feed__viewport');
      if (viewport && viewport.scrollTop > 50) {
        viewport.scrollTo({ top: 0, behavior: 'smooth' });
        console.log('[VIDEOS] Home button scrolled to top');
        return;
      }
      // אחרת - נשאר בדף, אין צורך לנווט לindex
      console.log('[VIDEOS] Already at top, no action needed');
    });
  }

  const refreshButton = document.getElementById('videosTopRefreshButton');
  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      setStatus('מרענן...');
      loadVideos();
    });
  }





  // הסתרת מסך טעינה אחרי 8 שניות גם אם יש שגיאה | HYPER CORE TECH
  setTimeout(() => {
    hideLoadingAnimation();
    console.log('[videos] Loading timeout - hiding overlay');
  }, 8000);

  await waitForApp();
  const app = window.NostrApp || {};
  if (typeof app.buildCoreFeedFilters !== 'function') {
    app.buildCoreFeedFilters = buildVideoFeedFilters;
  }

  // טעינת מחיקות לפני הצגת המטמון כדי לסנן פוסטים מחוקים
  await loadDeletionsFirst();

  // חלק מטמון (videos.js) – הצגת פוסטים מהמטמון מיד לפני טעינה מהרשת | HYPER CORE TECH
  const hadCachedContent = hydrateFeedFromCache();
  if (hadCachedContent) {
    // יש תוכן מהמטמון – הסתר אנימציית טעינה מיד
    hideLoadingAnimation();
    if (selectors.status) {
      selectors.status.style.display = 'none';
    }
    state.firstCardRendered = true;
    autoPlayFirstVideo();
    console.log('[videos] displayed cached content, loading fresh in background');
  }

  // טעינת תוכן חדש ברקע (גם אם יש מטמון)
  loadVideos();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// חלק טעינה חוזרת (videos.js) – רענון אוטומטי בחזרה לדף | HYPER CORE TECH
let lastVisibilityTime = Date.now();
const REFRESH_THRESHOLD_MS = 60000; // רענון אם עברו יותר מדקה

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const now = Date.now();
    const elapsed = now - lastVisibilityTime;
    
    // אם עברה יותר מדקה מאז שהדף היה מוסתר - בדוק פוסטים חדשים
    if (elapsed > REFRESH_THRESHOLD_MS) {
      console.log('[videos] Page became visible after', Math.round(elapsed / 1000), 'seconds, checking for new posts');
      // טעינת פוסטים חדשים ברקע ללא הצגת מסך טעינה
      loadVideos().catch(err => console.warn('[videos] Background refresh failed', err));
    }
    lastVisibilityTime = now;
  } else {
    lastVisibilityTime = Date.now();
  }
});

// חלק טעינה חוזרת (videos.js) – טיפול ב-pageshow עבור bfcache | HYPER CORE TECH
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    // הדף הוחזר מ-bfcache - רענן פוסטים
    console.log('[videos] Page restored from bfcache, refreshing');
    loadVideos().catch(err => console.warn('[videos] Bfcache refresh failed', err));
  }
});

// חלק רענון תקופתי (videos.js) – בדיקת פוסטים חדשים כל 2 דקות | HYPER CORE TECH
let periodicRefreshInterval = null;

function startPeriodicRefresh() {
  if (periodicRefreshInterval) return;
  periodicRefreshInterval = setInterval(() => {
    if (document.visibilityState === 'visible' && state.firstCardRendered) {
      console.log('[videos] Periodic refresh check');
      loadVideos().catch(err => console.warn('[videos] Periodic refresh failed', err));
    }
  }, 120000); // כל 2 דקות
}

// הפעלה אחרי שהפיד נטען
setTimeout(startPeriodicRefresh, 5000);

// חלק פאנל פרופיל ציבורי (videos.js) – סגירת overlay פרופיל ציבורי ללא רענון | HYPER CORE TECH
function closePublicProfilePanel() {
  const publicPanel = document.getElementById('publicProfilePanel');
  const publicFrame = document.getElementById('publicProfilePanelFrame');
  if (publicPanel && !publicPanel.hidden) {
    publicPanel.hidden = true;
    if (publicFrame) publicFrame.src = '';
    console.log('[VIDEOS] Public profile panel closed');
    return true;
  }
  return false;
}

// חלק סגירת פאנלים (videos.js) – כל הפאנלים נסגרים דרך postMessage מכפתורי החזרה המקוריים | HYPER CORE TECH

// חלק פאנל משחקים (videos.js) – סגירת overlay משחקים ללא רענון | HYPER CORE TECH
function closeGamesPanel() {
  const gamesPanel = document.getElementById('gamesPanel');
  const gamesFrame = document.getElementById('gamesPanelFrame');
  if (gamesPanel && !gamesPanel.hidden) {
    gamesPanel.hidden = true;
    if (gamesFrame) gamesFrame.src = '';
    console.log('[VIDEOS] Games panel closed');
    return true;
  }
  return false;
}

// חשיפה גלובלית לסגירת פאנל משחקים | HYPER CORE TECH
window.closeGamesPanel = closeGamesPanel;
if (window.NostrApp) {
  window.NostrApp.closeGamesPanel = closeGamesPanel;
}

// חשיפה גלובלית לסגירת פאנל פרופיל ציבורי | HYPER CORE TECH
window.closePublicProfilePanel = closePublicProfilePanel;
if (window.NostrApp) {
  window.NostrApp.closePublicProfilePanel = closePublicProfilePanel;
}

// חלק מאזין הודעות (videos.js) – סגירת overlay בקבלת postMessage מ-iframe | HYPER CORE TECH
window.addEventListener('message', function handleOverlayMessage(event) {
  console.log('[VIDEOS] Received postMessage:', event.data);
  if (event.data && event.data.type === 'closePublicProfile') {
    console.log('[VIDEOS] Closing public profile panel via postMessage');
    closePublicProfilePanel();
  }
  if (event.data && event.data.type === 'closeGames') {
    console.log('[VIDEOS] Closing games panel via postMessage');
    closeGamesPanel();
  }
});
