// חלק דף וידאו (videos.js) – מנגנון משיכת וידאו והצגת פיד בסגנון טיקטוק | HYPER CORE TECH

// גרסת קוד לזיהוי עדכונים
// גרסת קוד לזיהוי עדכונים
const VIDEOS_CODE_VERSION = '2.5.6-boot-gate-first-2';
console.log(`%c🔧 Videos.js גרסה: ${VIDEOS_CODE_VERSION}`, 'color: #FF5722; font-weight: bold; font-size: 14px');

// חלק מרכוז פליי (videos.js) – אינליין חזק; בלי inset shorthand שמאפס top/left | HYPER CORE TECH
function centerPlayOverlayButton(playOverlay) {
  if (!playOverlay) return playOverlay;
  playOverlay.style.removeProperty('inset');
  playOverlay.style.setProperty('position', 'absolute', 'important');
  playOverlay.style.setProperty('top', '50%', 'important');
  playOverlay.style.setProperty('left', '50%', 'important');
  playOverlay.style.setProperty('right', 'auto', 'important');
  playOverlay.style.setProperty('bottom', 'auto', 'important');
  playOverlay.style.setProperty('margin', '0', 'important');
  playOverlay.style.setProperty('transform', 'translate(-50%, -50%)', 'important');
  playOverlay.style.setProperty('z-index', '1250', 'important');
  return playOverlay;
}

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

/**
 * חלק STOP/WebView (videos.js) – צובע פריים ראשון + poster כדי שלא יופיע פליי ענק של Android WebView | HYPER CORE TECH
 */
function captureVideoPosterFromFrame(videoEl) {
  if (!videoEl || videoEl.dataset.posterCaptured === '1') return;
  if (!videoEl.videoWidth || !videoEl.videoHeight) return;
  try {
    const maxW = 720;
    const scale = Math.min(1, maxW / videoEl.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(videoEl.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(videoEl.videoHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
    if (dataUrl && dataUrl.startsWith('data:image')) {
      videoEl.poster = dataUrl;
      videoEl.dataset.posterCaptured = '1';
    }
  } catch (_) {
    // cross-origin / tainted canvas – מתעלמים
  }
}

async function ensurePausedPreviewFrame(videoEl) {
  if (!videoEl || videoEl.dataset.previewFrame === '1') return;
  if (videoEl.readyState < 2) return;
  let wasMuted = true;
  try {
    wasMuted = videoEl.muted;
    videoEl.muted = true;
    // play קצר + pause מצייר פריים ב-WebView; אחרת רואים פליי מערכת מתוח על כל הכרטיס
    const playPromise = videoEl.play();
    if (playPromise && typeof playPromise.then === 'function') {
      await playPromise.catch(() => {});
    }
    videoEl.pause();
    videoEl.muted = wasMuted;
    try {
      if (!(isFinite(videoEl.currentTime) && videoEl.currentTime > 0.05)) {
        if (typeof videoEl.fastSeek === 'function') {
          videoEl.fastSeek(0.001);
        } else {
          videoEl.currentTime = 0.001;
        }
      }
    } catch (_) {}
    captureVideoPosterFromFrame(videoEl);
    videoEl.dataset.previewFrame = '1';
    videoEl.classList.add('has-preview-frame');
  } catch (_) {
    try { videoEl.muted = wasMuted; } catch (_) {}
  }
}

function refreshVisiblePausedPreviews() {
  if (globalAutoplayEnabled) return;
  const videos = document.querySelectorAll('.videos-feed__media[data-media-type="file"] video');
  videos.forEach((videoEl) => {
    ensurePausedPreviewFrame(videoEl);
  });
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
  
  // יצירת טולטיפ מפורט – נפתח מחוץ לתפריט (fixed) כי העיגול יושב בתפריט הפרופיל | HYPER CORE TECH
  createTooltip() {
    const circle = document.getElementById('p2pStatsCircle');
    const menuItem = document.getElementById('topBarP2pStats');
    if (!circle || document.getElementById('p2pStatsTooltipPanel')) return;
    
    const closeP2PTooltip = () => {
      const tooltipEl = document.getElementById('p2pStatsTooltipPanel');
      if (tooltipEl) {
        tooltipEl.classList.remove('visible');
      }
      circle.setAttribute('aria-expanded', 'false');
      if (menuItem) menuItem.setAttribute('aria-expanded', 'false');
    };

    const tooltip = document.createElement('div');
    tooltip.id = 'p2pStatsTooltipPanel';
    tooltip.className = 'p2p-stats-tooltip p2p-stats-tooltip--fixed';
    tooltip.innerHTML = `
      <div class="p2p-stats-tooltip__header">
        <button type="button" class="p2p-stats-tooltip__close" id="p2pStatsTooltipClose" aria-label="סגור סטטיסטיקות">✕</button>
        <div class="p2p-stats-tooltip__title">📊 סטטיסטיקות SOS</div>
      </div>
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
    document.body.appendChild(tooltip);

    const closeBtn = tooltip.querySelector('#p2pStatsTooltipClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeP2PTooltip();
      });
    }
    
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

    const openOrToggleStats = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      closeProfileMenu();
      this.sync();
      this.updateTooltip();
      const willOpen = !tooltip.classList.contains('visible');
      if (willOpen && tooltip.parentElement !== document.body) {
        document.body.appendChild(tooltip);
      }
      tooltip.classList.toggle('visible', willOpen);
      circle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      if (menuItem) menuItem.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    };

    if (menuItem) {
      menuItem.addEventListener('click', openOrToggleStats);
    } else {
      circle.addEventListener('click', openOrToggleStats);
    }
    
    // סגירה בלחיצה מחוץ
    document.addEventListener('click', (e) => {
      if (tooltip.contains(e.target)) return;
      if (menuItem && menuItem.contains(e.target)) return;
      if (circle.contains(e.target)) return;
      closeP2PTooltip();
    });

    // חלק תפריט פרופיל (videos.js) – פתיחת תפריט פרופיל סוגרת טולטיפ P2P | HYPER CORE TECH
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
  // מניעת כפילויות רק אם אותו אלמנט עדיין מחובר — אחרת אחרי רינדור מחדש חייבים לטעון שוב | HYPER CORE TECH
  const key = hash || url;
  if (key && videoDownloadedOrQueued.has(key)) {
    const stillInDom = videoEl && videoEl.isConnected;
    if (stillInDom && videoEl.src) {
      return;
    }
    // אלמנט חדש אחרי refresh/rerender — מאפשרים טעינה מחדש
    videoDownloadedOrQueued.delete(key);
  }
  if (key) videoDownloadedOrQueued.add(key);
  
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

// חלק יאללה וידאו (videos.js) – הפעלה אוטומטית של הווידאו הראשון לפי סדר כרונולוגי | HYPER CORE TECH
function autoPlayFirstVideo() {
  if (!selectors.stream) return;
  const ordered = getDisplayVideos();
  const firstId = ordered[0]?.id;
  let firstCard = null;
  if (firstId) {
    firstCard = selectors.stream.querySelector(`.videos-feed__card[data-event-id="${firstId}"]`);
  }
  if (!firstCard) {
    // דילוג על LoadNug / כרטיסים בלי event-id
    firstCard = Array.from(selectors.stream.querySelectorAll('.videos-feed__card[data-event-id]'))[0] || null;
  }
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

  // פיד LIVE TV תמיד מנגן (כמו משחקים) – לא נתקעים ב־STOP מהפיד הכללי | HYPER CORE TECH
  const forceLivePlay = mediaDiv.dataset.mediaType === 'hls-live'
    && (state.feedMode === 'live-tv' || mediaDiv.classList.contains('is-live-fullscreen') || priority);
  if (forceLivePlay && !globalAutoplayEnabled) {
    globalAutoplayEnabled = true;
    updateGlobalStopClass();
  }
  
  // אם לא במצב PLAY גלובלי ולא לחיצה ידנית - לא מפעילים
  if (!globalAutoplayEnabled && !manual && !forceLivePlay) {
    return;
  }
  
  if (activeMediaDiv && activeMediaDiv !== mediaDiv) {
    // במסך מלא לא מחליפים ערוץ בגלל IO | HYPER CORE TECH
    if (document.body.classList.contains('live-channel-fullscreen')) {
      return;
    }
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
  // לא עוצרים את הערוץ הפתוח במסך מלא (סיבוב מסך / IO) | HYPER CORE TECH
  if (!manual && (mediaDiv.classList.contains('is-live-fullscreen') || document.body.classList.contains('live-channel-fullscreen'))) {
    return;
  }
  
  // אם זו עצירה ידנית - מכבים מצב PLAY גלובלי (חוזרים ל-STOP)
  if (manual) {
    globalAutoplayEnabled = false;
    updateGlobalStopClass();
    // אחרי מעבר ל-STOP – מציירים פריימים כדי שלא יופיע פליי-ענק בגלילה | HYPER CORE TECH
    queueMicrotask(refreshVisiblePausedPreviews);
  }
  
  const mediaType = mediaDiv.dataset.mediaType;
  if (!mediaType) return;

  if (mediaType === 'file' || mediaType === 'hls-live') {
    const videoEl = mediaDiv.querySelector('video');
    if (videoEl) {
      videoEl.pause();
    }
    if (mediaType === 'hls-live') {
      mediaDiv.classList.remove('is-live-playing');
      const playOverlay = mediaDiv.querySelector('.videos-feed__play-overlay');
      if (playOverlay && manual) {
        playOverlay.hidden = false;
        playOverlay.style.display = '';
        centerPlayOverlayButton(playOverlay);
      } else if (playOverlay && !manual) {
        playOverlay.hidden = true;
        playOverlay.style.display = 'none';
      }
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
function pauseAllFeedVideos(options = {}) {
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
  
  // כיבוי PLAY גלובלי רק כשצריך (שיחה וכו') – לא ברינדור מחדש של LIVE/משחקים | HYPER CORE TECH
  if (options.disableAutoplay !== false) {
    globalAutoplayEnabled = false;
    updateGlobalStopClass();
    queueMicrotask(refreshVisiblePausedPreviews);
  }
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

// חלק ערוץ חי (videos.js) – הפעלת HLS עם מסך טעינה כמו משחקים | HYPER CORE TECH
async function playHlsLiveMedia(mediaDiv) {
  if (!mediaDiv) return;
  const App = window.NostrApp || {};
  const videoEl = mediaDiv.querySelector('video');
  if (!videoEl) return;

  if (activeMediaDiv && activeMediaDiv !== mediaDiv && !document.body.classList.contains('live-channel-fullscreen')) {
    pauseMedia(activeMediaDiv, { resetThumb: false });
  }
  activeMediaDiv = mediaDiv;
  mediaDiv.dataset.state = 'playing';
  mediaDiv.classList.add('is-live-playing');
  mediaDiv.classList.remove('is-paused');
  updatePlayToggleIcon(mediaDiv, true);
  const playOverlay = mediaDiv.querySelector('.videos-feed__play-overlay');
  if (playOverlay) {
    playOverlay.hidden = true;
    playOverlay.style.display = 'none';
  }
  if (typeof App.ensureLiveBadge === 'function') {
    App.ensureLiveBadge(mediaDiv);
  }

  const showLoading = typeof App.setLiveLoadingVisible === 'function'
    ? (v, label) => App.setLiveLoadingVisible(mediaDiv, v, label)
    : (typeof App.setTuningVisible === 'function'
      ? (v, label) => App.setTuningVisible(mediaDiv, v, label)
      : () => {});

  const revealWhenReady = async () => {
    // מציגים וידאו רק כשיש פריים – מונע סאונד בלי תמונה | HYPER CORE TECH
    const waitFrame = () => new Promise((resolve) => {
      if (videoEl.readyState >= 2) {
        resolve();
        return;
      }
      const done = () => {
        videoEl.removeEventListener('loadeddata', done);
        videoEl.removeEventListener('playing', done);
        resolve();
      };
      videoEl.addEventListener('loadeddata', done, { once: true });
      videoEl.addEventListener('playing', done, { once: true });
      setTimeout(done, 2500);
    });
    videoEl.muted = true;
    try {
      await videoEl.play();
    } catch (_) {
      try { await videoEl.play(); } catch (__) {}
    }
    await waitFrame();
    showLoading(false);
    videoEl.muted = false;
    try { await videoEl.play(); } catch (_) {
      videoEl.muted = true;
      try { await videoEl.play(); } catch (__) {}
    }
  };

  try {
    if (mediaDiv.dataset.livePrepared === '1') {
      // כבר חם – בלי מסך טעינה מחדש | HYPER CORE TECH
      showLoading(false);
      await revealWhenReady();
      return;
    }

    showLoading(true, 'טוען ערוץ...');
    if (typeof App.prepareLiveMedia === 'function') {
      const result = await App.prepareLiveMedia(mediaDiv, {
        autoplay: false,
        showLoading: true,
        loadingLabel: 'טוען ערוץ...',
        muted: true,
      });
      if (result && result.ok) {
        await revealWhenReady();
      } else {
        // ערוץ שנכשל – לא מציגים ברשימה | HYPER CORE TECH
        const channelId = mediaDiv.dataset.liveChannelId || '';
        if (channelId && typeof App.markLiveTvChannelOffline === 'function') {
          App.markLiveTvChannelOffline(channelId);
        }
        removeLiveTvCardFromFeed(mediaDiv);
      }
    }
  } catch (err) {
    console.warn('[videos] HLS live play failed', err);
    showLoading(true, 'לא מצליח לתפוס ערוץ');
  }
}

// חלק משחק בפיד (videos.js) – טעינת iframe למשחק HTML5 | HYPER CORE TECH
function playGameEmbedMedia(mediaDiv) {
  if (!mediaDiv) return;
  // עוצרים מדיה קודמת (כולל סאונד משחק קודם) בלי תלות ב-autoplay גלובלי | HYPER CORE TECH
  if (activeMediaDiv && activeMediaDiv !== mediaDiv) {
    pauseMedia(activeMediaDiv, { resetThumb: false });
  }
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
  mediaDiv.dataset.state = 'playing';
  mediaDiv.classList.remove('is-paused');
  activeMediaDiv = mediaDiv;
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
  feedMode: 'all', // 'all' | 'games' | 'live-tv' | HYPER CORE TECH
  liveTvVideos: [],
};

// חלק טעינה (videos.js) – סף מינימלי להורדה לפני סגירת מסך הטעינה | HYPER CORE TECH
const MIN_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20MB מינימום
// כמה פוסטים ראשונים חייבים להיות מוכנים לצפייה לפני סגירת LoadNug | HYPER CORE TECH
const BOOT_READY_POST_COUNT = 2;
const BOOT_MEDIA_TIMEOUT_MS = 28000;
const BOOT_SAFETY_TIMEOUT_MS = 45000;

const bootGate = {
  active: true,
  released: false,
  releasePromise: null,
};

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

// חלק סדר פיד (videos.js) – נרמול createdAt גם מ־created_at / מחרוזת / ms | HYPER CORE TECH
function getVideoCreatedAt(video) {
  if (!video || typeof video !== 'object') return 0;
  let raw = video.createdAt ?? video.created_at ?? 0;
  if (typeof raw === 'string' && raw.trim()) {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 0) {
      raw = asNum;
    } else {
      const parsed = Date.parse(raw);
      raw = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
    }
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  // אם נשמר בטעות במילישניות
  if (raw > 1e12) return Math.floor(raw / 1000);
  return Math.floor(raw);
}

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
  // נרמול זמן — בלי זה פוסטי וידאו עם created_at / בלי camelCase נזרקים לסוף והיוטיוב עולה ראשון | HYPER CORE TECH
  clone.createdAt = getVideoCreatedAt(clone);
  // תאימות לאחור – לינק m3u8 שנשמר כ־videoUrl הופך לערוץ חי | HYPER CORE TECH
  if (!clone.liveUrl && clone.videoUrl && isHlsLiveLink(clone.videoUrl)) {
    clone.liveUrl = clone.videoUrl;
    clone.videoUrl = null;
  }
  if (!clone.gameUrl && clone.videoUrl && isPlayableGameLink(clone.videoUrl)) {
    clone.gameUrl = clone.videoUrl;
    clone.videoUrl = null;
  }
  // חסימת משחקים לא רצויים (למשל Subway Surfers) גם ממטמון ישן | HYPER CORE TECH
  if (clone.gameUrl && !isPlayableGameLink(clone.gameUrl)) {
    const AppGame = window.NostrApp || {};
    const canEmbed = typeof AppGame.canEmbedGameUrl === 'function' && AppGame.canEmbedGameUrl(clone.gameUrl);
    if (!(clone.gameForced && canEmbed)) {
      clone.gameUrl = null;
      clone.gameForced = false;
    }
  }
  return clone;
}

function saveFeedCache(videos) {
  try {
    const trimmed = sortVideosByCreatedAtDesc(
      (videos || [])
        .map((video) => sanitizeCachedVideo(video))
        .filter(Boolean)
    );
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
  const sorted = [...videos].sort((a, b) => getVideoCreatedAt(b) - getVideoCreatedAt(a));
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
    const sorted = [...parsed.videos].sort((a, b) => getVideoCreatedAt(b) - getVideoCreatedAt(a));
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
      const ts = getVideoCreatedAt(v);
      if (ts > newestPostTime) {
        newestPostTime = ts;
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
    const filtered = sortVideosByCreatedAtDesc(
      cached.filter(video => !deletedIds.has(video.id))
    );
    console.log('[videos] hydrate feed from cache', { 
      total: cached.length, 
      afterFilter: filtered.length,
      deletedCount: cached.length - filtered.length,
      firstId: filtered[0]?.id || null,
      firstCreatedAt: filtered[0] ? getVideoCreatedAt(filtered[0]) : 0,
      firstIsYouTube: !!(filtered[0]?.youtubeId && !filtered[0]?.videoUrl),
    });
    state.videos = filtered;
    // רינדור מלא מהמטמון — בלי DOM ישן / מרוץ מוכנות מדיה | HYPER CORE TECH
    if (typeof forceFullFeedRerender === 'function' && selectors.stream) {
      forceFullFeedRerender();
    } else {
      renderVideos();
    }
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
  if (card.isConnected) {
    wireActions(card);
    wireMediaControls(card);
    observeVideoCard(card);
    updateLoadMoreTrigger();
    return;
  }
  if (prepend) {
    selectors.stream.insertBefore(card, selectors.stream.firstChild || null);
  } else {
    selectors.stream.appendChild(card);
  }
  wireActions(card);
  wireMediaControls(card);
  observeVideoCard(card);
  // טריגר טעינת המשך חייב להתעדכן אחרי כל mount (אחרת נעצרים באמצע) | HYPER CORE TECH
  updateLoadMoreTrigger();
  if (!state.firstCardRendered) {
    // לא סוגרים LoadNug כאן — רק אחרי ensureBootFeedReady | HYPER CORE TECH
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
    }
    // autoplay רק אחרי שחרור שער הטעינה
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

  // משחקים רק בפיד משחקים; ערוצי LIVE רק בכפתור LIVE TV; שאר התוכן בפיד הכללי | HYPER CORE TECH
  let showNow = false;
  if (state.feedMode === 'games') showNow = isGameFeedVideo(video);
  else if (state.feedMode === 'live-tv') showNow = false;
  else showNow = isGeneralFeedVideo(video);
  if (showNow) {
    prependVideoCard(video, options);
  }
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
  let gameForced = false;
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
        } else if (mime.includes('text/html') || isPlayableGameLink(tagUrl)) {
          gameUrl = gameUrl || tagUrl;
          if (mime.includes('text/html') && !isPlayableGameLink(tagUrl) && canEmbedGameLink(tagUrl)) {
            gameForced = true;
          }
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
        // תג מפורש מהקומפוזר – מאפשר גם לינקים מחוץ לרשימת הזיהוי האוטומטי | HYPER CORE TECH
        if (!gameUrl) {
          const httpLink = mediaLinks.find((l) => canEmbedGameLink(l))
            || mediaLinks.find((l) => /^https:\/\//i.test(l) && canEmbedGameLink(l));
          if (httpLink) gameUrl = httpLink;
        }
        if (gameUrl) gameForced = true;
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
    gameForced: !!(gameUrl && gameForced),
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

function hideLoadingAnimation(options = {}) {
  const force = options === true || options?.force === true;
  // בזמן אתחול – לא סוגרים LoadNug עד ש־2 הפוסטים הראשונים מוכנים | HYPER CORE TECH
  if (bootGate.active && !bootGate.released && !force) {
    console.log('[videos] hideLoading blocked — waiting for first posts to be view-ready');
    return;
  }
  const overlay = document.getElementById('videosLoadingOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
  }
  // סגירת LOADNUG כשהפיד מוכן | HYPER CORE TECH
  try {
    if (window.SOSLoadNug && typeof window.SOSLoadNug.signalReady === 'function') {
      window.SOSLoadNug.signalReady();
    }
  } catch (_) {}
}

function releaseBootLoading(reason = 'ready') {
  if (bootGate.released) return;
  bootGate.released = true;
  bootGate.active = false;
  console.log('[videos] boot loading released:', reason);
  setLoadingProgress(100);
  setLoadingStatus('הכל מוכן!');
  hideLoadingAnimation({ force: true });
  if (selectors.status) {
    selectors.status.style.display = 'none';
  }
  try {
    const viewport = document.querySelector('.videos-feed__viewport');
    if (viewport) viewport.scrollTop = 0;
  } catch (_) {}
  requestAnimationFrame(() => {
    autoPlayFirstVideo();
  });
}

// חלק יאללה וידאו (videos.js) – עדכון מד טעינה והודעות סטטוס | HYPER CORE TECH
function setLoadingProgress(percent) {
  const fill = document.getElementById('videosLoadingBarFill');
  if (fill) {
    fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }
  // סנכרון ל־LoadNug (המד הויזואלי האמיתי) | HYPER CORE TECH
  try {
    const bar = document.querySelector('#sosLoadNugOverlay .sos-loadnug__bar');
    const pct = document.querySelector('#sosLoadNugOverlay .sos-loadnug__pct');
    const progress = document.querySelector('#sosLoadNugOverlay .sos-loadnug__progress');
    const clamped = Math.min(100, Math.max(0, Number(percent) || 0));
    if (bar) bar.style.width = `${clamped}%`;
    if (pct) pct.textContent = `${Math.round(clamped)}%`;
    if (progress) progress.setAttribute('aria-valuenow', String(Math.round(clamped)));
  } catch (_) {}
}

function setLoadingStatus(message) {
  const status = document.getElementById('videosLoadingStatus');
  if (status) {
    status.textContent = message;
  }
  try {
    const ln = document.querySelector('#sosLoadNugOverlay .sos-loadnug__status');
    if (ln && message) ln.textContent = message;
  } catch (_) {}
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFeedCard(eventId, timeoutMs = 12000) {
  if (!eventId) return null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const card = selectors.stream?.querySelector(`.videos-feed__card[data-event-id="${eventId}"]`);
    if (card) return card;
    await sleepMs(40);
  }
  return null;
}

function waitForMediaElementReady(el, { timeoutMs = BOOT_MEDIA_TIMEOUT_MS, events = ['loadeddata', 'canplay'] } = {}) {
  return new Promise((resolve) => {
    if (!el) {
      resolve(false);
      return;
    }
    if (el.tagName === 'VIDEO' && el.readyState >= 2) {
      resolve(true);
      return;
    }
    if (el.tagName === 'IMG' && el.complete && el.naturalWidth > 0) {
      resolve(true);
      return;
    }
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(!!ok);
    };
    const onOk = () => done(true);
    const onErr = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      events.forEach((name) => el.removeEventListener(name, onOk));
      el.removeEventListener('error', onErr);
    };
    events.forEach((name) => el.addEventListener(name, onOk, { once: true }));
    el.addEventListener('error', onErr, { once: true });
  });
}

async function waitForPostMediaPlayable(video) {
  if (!video?.id) return false;
  const card = await waitForFeedCard(video.id);
  if (!card) return false;
  const mediaDiv = card.querySelector('.videos-feed__media');
  if (!mediaDiv) return false;
  const type = mediaDiv.dataset.mediaType || '';

  if (type === 'youtube') {
    const thumb = mediaDiv.querySelector('img.videos-feed__media-thumb, img');
    if (!thumb) return true;
    return waitForMediaElementReady(thumb, { events: ['load'], timeoutMs: 12000 });
  }
  if (type === 'image') {
    const img = mediaDiv.querySelector('img');
    if (!img) return true;
    return waitForMediaElementReady(img, { events: ['load'], timeoutMs: 12000 });
  }
  if (type === 'file') {
    const videoEl = mediaDiv.querySelector('video');
    if (!videoEl) return false;
    // אם כבר יש src/blob מוכן
    if (videoEl.readyState >= 2) return true;
    return waitForMediaElementReady(videoEl, {
      events: ['loadeddata', 'canplay', 'canplaythrough'],
      timeoutMs: BOOT_MEDIA_TIMEOUT_MS,
    });
  }
  // live/game/other — לא חוסמים את ה-boot יותר מדי
  return true;
}

function prioritizeBootDownloads(posts) {
  if (!Array.isArray(posts) || !posts.length || !videoDownloadQueue.length) return;
  const keys = new Set();
  posts.forEach((p) => {
    if (p?.hash) keys.add(p.hash);
    if (p?.videoUrl) keys.add(p.videoUrl);
  });
  if (!keys.size) return;
  const priority = [];
  const rest = [];
  videoDownloadQueue.forEach((item) => {
    const key = item.hash || item.url;
    if (keys.has(key)) priority.push(item);
    else rest.push(item);
  });
  if (priority.length) {
    videoDownloadQueue = [...priority, ...rest];
    console.log('[videos] prioritized boot downloads', { count: priority.length });
  }
}

function updateCardAuthorUi(video) {
  if (!video?.id || !selectors.stream) return;
  const card = selectors.stream.querySelector(`.videos-feed__card[data-event-id="${video.id}"]`);
  if (!card) return;
  const btn = card.querySelector('.videos-feed__action--avatar');
  if (!btn) return;
  if (video.authorPicture) {
    let img = btn.querySelector('img');
    if (!img) {
      btn.textContent = '';
      img = document.createElement('img');
      img.alt = video.authorName || 'משתמש';
      btn.appendChild(img);
    }
    img.src = video.authorPicture;
    img.alt = video.authorName || 'משתמש';
  }
  if (video.authorName) {
    btn.setAttribute('aria-label', video.authorName);
  }
  updateVideoLikeButton(video.id);
  const commentCount = window.NostrApp?.commentsByParent?.get(video.id)?.length || 0;
  const commentEl = card.querySelector(`[data-comment-count="${video.id}"]`);
  if (commentEl) {
    if (commentCount > 0) {
      commentEl.textContent = String(commentCount);
      commentEl.style.display = '';
    } else {
      commentEl.textContent = '';
      commentEl.style.display = 'none';
    }
  }
}

async function loadBootMetaForPosts(posts) {
  const app = window.NostrApp || {};
  const ids = posts.map((p) => p.id).filter(Boolean);
  const authors = [...new Set(posts.map((p) => p.pubkey).filter(Boolean))];
  setLoadingStatus('טוען לייקים, תגובות ופרופילים...');
  setLoadingProgress(72);

  const tasks = [];
  if (ids.length) {
    tasks.push(loadLikesAndCommentsForVideos(ids).catch((err) => {
      console.warn('[videos] boot likes/comments failed', err);
    }));
  }
  if (authors.length && typeof app.fetchProfile === 'function') {
    authors.forEach((pubkey) => {
      tasks.push(
        app.fetchProfile(pubkey).catch(() => null)
      );
    });
  }
  await Promise.all(tasks);

  posts.forEach((video) => {
    const profile = app.profileCache?.get(video.pubkey) || {};
    if (profile.name) video.authorName = profile.name;
    if (profile.picture) video.authorPicture = profile.picture;
    if (profile.initials) video.authorInitials = profile.initials;
    updateCardAuthorUi(video);
  });
}

// חלק טעינה (videos.js) – סגירת LoadNug רק כש־N הפוסטים הראשונים מוכנים לצפייה מלאה | HYPER CORE TECH
async function ensureBootFeedReady() {
  if (bootGate.released) return;
  if (bootGate.releasePromise) return bootGate.releasePromise;

  bootGate.releasePromise = (async () => {
    showLoadingAnimation();
    setLoadingStatus('מכין את הפוסטים הראשונים...');
    setLoadingProgress(55);

    const posts = getDisplayVideos().slice(0, BOOT_READY_POST_COUNT);
    if (!posts.length) {
      // אין תוכן עדיין — לא משחררים; loadVideos ימשיך ואז ננסה שוב
      console.log('[videos] boot gate: no posts yet');
      bootGate.releasePromise = null;
      return;
    }

    // ממתינים שהכרטיסים ייכנסו ל-DOM ואז מריצים הורדות בעדיפות | HYPER CORE TECH
    await Promise.all(posts.map((p) => waitForFeedCard(p.id, 15000)));
    await sleepMs(80);
    prioritizeBootDownloads(posts);
    try {
      processVideoDownloadQueue();
    } catch (_) {}

    setLoadingStatus(
      posts.length >= 2
        ? 'טוען 2 פוסטים ראשונים לצפייה...'
        : 'טוען את הפוסט הראשון לצפייה...'
    );
    setLoadingProgress(62);

    const mediaResults = await Promise.all(
      posts.map(async (video, index) => {
        const ok = await waitForPostMediaPlayable(video);
        setLoadingProgress(62 + ((index + 1) / posts.length) * 10);
        console.log('[videos] boot media', { id: video.id, ok, type: video.youtubeId ? 'youtube' : (video.videoUrl ? 'file' : 'other') });
        return ok;
      })
    );

    await loadBootMetaForPosts(posts);
    setLoadingProgress(92);

    const readyCount = mediaResults.filter(Boolean).length;
    // אם לפחות פוסט אחד מוכן (או שכולם נכשלו אחרי timeout) — משחררים כדי לא לתקוע | HYPER CORE TECH
    if (readyCount > 0 || posts.length > 0) {
      releaseBootLoading(`first-${posts.length}-posts media=${readyCount}/${posts.length}`);
    }
  })().catch((err) => {
    console.warn('[videos] ensureBootFeedReady failed', err);
    releaseBootLoading('boot-error-fallback');
  });

  return bootGate.releasePromise;
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
  if (/subway[\s\-_.]*surfers?|subwaysurfers/i.test(link)) return false;
  if (/poki\.com|crazygames\.com|gamedistribution\.com/i.test(link)) return false;
  if (/\.(mp4|webm|m3u8|jpg|png)(\?|#|$)/i.test(link)) return false;
  return /\.github\.io\//i.test(link) || /gamh5\.com|krunker\.io|famobi\.com|itch\.io|marketjs\.com/i.test(link);
}

function canEmbedGameLink(link) {
  const App = window.NostrApp || {};
  if (typeof App.canEmbedGameUrl === 'function') return App.canEmbedGameUrl(link);
  if (isPlayableGameLink(link)) return true;
  if (!link || !/^https:\/\//i.test(link)) return false;
  if (/subway[\s\-_.]*surfers?|subwaysurfers/i.test(link)) return false;
  if (/poki\.com|crazygames\.com|gamedistribution\.com/i.test(link)) return false;
  if (/\.(mp4|webm|m3u8|jpe?g|png|gif|webp)(\?|#|$)/i.test(link)) return false;
  if (/youtube\.com|youtu\.be/i.test(link)) return false;
  return true;
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
    if (video.gameForced) mediaDiv.dataset.gameForced = '1';
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
    centerPlayOverlayButton(playOverlay);
    mediaDiv.appendChild(playOverlay);

    queueMicrotask(markReady);
  } else if (video.liveUrl) {
    mediaDiv.dataset.mediaType = 'hls-live';
    mediaDiv.dataset.liveUrl = video.liveUrl;
    mediaDiv.dataset.videoUrl = video.liveUrl;
    mediaDiv.dataset.liveCaption = video.content || '';
    if (video.liveTvgId) mediaDiv.dataset.liveTvgId = String(video.liveTvgId);
    if (video.liveChannelNumber) mediaDiv.dataset.liveChannelNumber = String(video.liveChannelNumber);
    if (video.liveChannelId) mediaDiv.dataset.liveChannelId = String(video.liveChannelId);
    if (video.liveCategory) mediaDiv.dataset.liveCategory = String(video.liveCategory);
    // שם ערוץ מהקטלוג/כיתוב נעול — לא יוחלף בזבל מ־URL/פלייליסט | HYPER CORE TECH
    if (video.liveCatalog || (video.content && String(video.content).trim())) {
      mediaDiv.dataset.liveChannelLocked = '1';
    }

    const videoEl = document.createElement('video');
    videoEl.controls = false;
    videoEl.muted = true;
    videoEl.loop = false;
    videoEl.playsInline = true;
    videoEl.autoplay = false;
    videoEl.setAttribute('playsinline', 'true');
    videoEl.setAttribute('webkit-playsinline', 'true');
    videoEl.preload = 'auto';
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
    if (typeof AppLive.ensureLiveMetaOverlay === 'function') {
      AppLive.ensureLiveMetaOverlay(mediaDiv);
    }
    if (typeof AppLive.setLiveMetaOverlay === 'function' && video.content) {
      AppLive.setLiveMetaOverlay(mediaDiv, { channelName: video.content });
    }
    // מסך טעינה כמו משחקים – בלי שלג/מד סריקה | HYPER CORE TECH
    if (typeof AppLive.setLiveLoadingVisible === 'function') {
      AppLive.setLiveLoadingVisible(mediaDiv, true, 'טוען ערוץ...');
    } else if (typeof AppLive.setTuningVisible === 'function') {
      AppLive.setTuningVisible(mediaDiv, true, 'טוען ערוץ...');
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
    playOverlay.hidden = true;
    playOverlay.style.display = 'none';
    centerPlayOverlayButton(playOverlay);
    mediaDiv.appendChild(playOverlay);

    // כרטיס מוצג מיד – מטא־דאטה + בריאות ברקע (בלי שלג) | HYPER CORE TECH
    queueMicrotask(() => {
      markReady();
      if (typeof AppLive.enrichLiveCardMeta === 'function') {
        AppLive.enrichLiveCardMeta(mediaDiv, {
          url: video.liveUrl,
          content: video.content || '',
          lockedName: video.liveCatalog ? (video.content || '') : '',
        }).catch(() => {});
      }
      if (typeof AppLive.checkHlsHealth === 'function') {
        AppLive.checkHlsHealth(video.liveUrl).then((health) => {
          if (health && health.playlistMeta && typeof AppLive.enrichLiveCardMeta === 'function') {
            AppLive.enrichLiveCardMeta(mediaDiv, {
              url: video.liveUrl,
              content: video.content || '',
              lockedName: video.liveCatalog ? (video.content || '') : '',
              playlistMeta: health.playlistMeta,
            }).catch(() => {});
          }
          // ערוץ קטלוג שנכשל – מסמנים offline ומסירים מהפיד | HYPER CORE TECH
          if (video.liveCatalog && health && health.ok === false && !health.unverified) {
            if (typeof AppLive.markLiveTvChannelOffline === 'function' && video.liveChannelId) {
              AppLive.markLiveTvChannelOffline(video.liveChannelId);
            }
            const card = mediaDiv.closest('.videos-feed__card');
            if (card) card.remove();
            if (Array.isArray(state.liveTvVideos)) {
              state.liveTvVideos = state.liveTvVideos.filter((v) => v && v.id !== video.id);
            }
          }
        }).catch(() => {});
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
    centerPlayOverlayButton(playOverlay);
    mediaDiv.appendChild(playOverlay);

    queueMicrotask(markReady);
  } else if (video.videoUrl) {
    mediaDiv.dataset.mediaType = 'file';
    mediaDiv.dataset.videoUrl = video.videoUrl;

    const videoEl = document.createElement('video');
    videoEl.controls = false;
    videoEl.controlsList = 'nodownload nofullscreen noremoteplayback';
    videoEl.disablePictureInPicture = true;
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
    videoEl.setAttribute('controlsList', 'nodownload nofullscreen noremoteplayback');
    
    // חלק תאימות iOS (videos.js) – preload=auto נדרש לספארי כדי ש-loadeddata יירה | HYPER CORE TECH
    videoEl.preload = 'auto';
    videoEl.className = 'videos-feed__media-video';
    // poster מתמונת הפוסט אם קיימת – מונע פליי-ענק של WebView במצב STOP | HYPER CORE TECH
    if (typeof video.imageUrl === 'string' && video.imageUrl) {
      videoEl.poster = video.imageUrl;
      videoEl.dataset.posterCaptured = '1';
    }
    mediaDiv.appendChild(videoEl);

    const cleanup = () => {
      videoEl.removeEventListener('loadeddata', onLoadedData);
      videoEl.removeEventListener('error', onError);
    };

    let readySettled = false;
    const settleReady = () => {
      if (readySettled) return;
      readySettled = true;
      markReady();
    };

    const onLoadedData = () => {
      cleanup();
      settleReady();
      // רק במצב STOP – מציירים פריים בלי לשבור autoplay | HYPER CORE TECH
      if (!globalAutoplayEnabled) {
        ensurePausedPreviewFrame(videoEl);
      } else if (!videoEl.poster) {
        // שומרים poster בשקט כשהסרטון עדיין מושהה לפני הפעלה
        try {
          if (videoEl.paused) captureVideoPosterFromFrame(videoEl);
        } catch (_) {}
      }
    };

    const onError = (event) => {
      cleanup();
      if (!readySettled) {
        failReady(event?.error || new Error('video load error'));
        readySettled = true;
      } else {
        handleCardMediaFailure(article, video.id, event?.error || new Error('video load error'));
      }
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

    // קריטי: כרטיס הקובץ נחשב "מוכן לסדר הפיד" מיד — בלי לחכות להורדה/קאש
    // אחרת יוטיוב (מוכן מיד) קופץ ויזואלית לפני וידאו שעדיין בתור | HYPER CORE TECH
    queueMicrotask(settleReady);

    const playOverlay = document.createElement('button');
    playOverlay.type = 'button';
    playOverlay.className = 'videos-feed__play-overlay';
    playOverlay.setAttribute('aria-label', 'Play video');
    playOverlay.setAttribute('data-play-toggle', '');
    playOverlay.innerHTML = '<i class="fa-solid fa-play"></i>';
    centerPlayOverlayButton(playOverlay);
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
    let knownDuration = 0;

    // Blob/WebM לעיתים בלי duration עד הלופ השני – fallback ל-seekable/buffered | HYPER CORE TECH
    const getMediaDuration = () => {
      const d = videoEl.duration;
      if (d && isFinite(d) && d > 0) {
        knownDuration = d;
        return d;
      }
      try {
        if (videoEl.seekable && videoEl.seekable.length > 0) {
          const end = videoEl.seekable.end(videoEl.seekable.length - 1);
          if (end && isFinite(end) && end > 0) {
            knownDuration = Math.max(knownDuration, end);
            return knownDuration;
          }
        }
      } catch (_) {}
      try {
        if (videoEl.buffered && videoEl.buffered.length > 0) {
          const end = videoEl.buffered.end(videoEl.buffered.length - 1);
          if (end && isFinite(end) && end > videoEl.currentTime) {
            knownDuration = Math.max(knownDuration, end);
            return knownDuration;
          }
        }
      } catch (_) {}
      return knownDuration > 0 ? knownDuration : 0;
    };
    
    const updateProgress = () => {
      const duration = getMediaDuration();
      const current = isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
      if (!duration) {
        // גם בלי duration – מציגים זמן ומד זמני לפי התקדמות יחסית | HYPER CORE TECH
        if (current > 0) {
          timeDisplay.textContent = formatTime(current);
          progressBar.classList.add('visible');
          // אומדן רך: גדל לאט עד שיש duration אמיתי
          const softPct = Math.min(92, current * 2);
          progressFill.style.width = `${softPct}%`;
          progressThumb.style.left = `${100 - softPct}%`;
        }
        return;
      }
      const pct = Math.max(0, Math.min(100, (current / duration) * 100));
      progressFill.style.width = `${pct}%`;
      // העיגול נע מימין לשמאל (פס RTL) | HYPER CORE TECH
      progressThumb.style.left = `${100 - pct}%`;
      timeDisplay.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
      
      // הצגת פס התקדמות בזמן ניגון | HYPER CORE TECH
      progressBar.classList.add('visible');
      clearTimeout(progressTimeout);
      if (!isDragging && videoEl.paused) {
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
      const duration = getMediaDuration();
      if (duration) {
        videoEl.currentTime = pct * duration;
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
    videoEl.addEventListener('durationchange', updateProgress);
    videoEl.addEventListener('loadeddata', updateProgress);
    videoEl.addEventListener('timeupdate', updateProgress);
    videoEl.addEventListener('seeking', updateProgress);
    videoEl.addEventListener('play', updateProgress);
    videoEl.addEventListener('pause', updateProgress);
    
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
  // קטלוג LIVE TV – רק מנהל יכול להסיר ערוץ | HYPER CORE TECH
  const canDelete = video.liveCatalog
    ? isAdminUser
    : (isSelf || isAdminUser);

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
    // חלק תפריט מנהל (videos.js) – מחיקת פוסט / הסרת ערוץ LIVE TV | HYPER CORE TECH
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'videos-feed__action feed-post__action feed-post__action--delete';
    deleteBtn.setAttribute('data-admin-delete', video.id);
    deleteBtn.title = video.liveCatalog ? 'הסר ערוץ (מנהל)' : 'מחק פוסט (מנהל)';
    deleteBtn.innerHTML = `
      <i class="fa-solid fa-trash"></i>
      <span>${video.liveCatalog ? 'הסר' : 'מחק'}</span>
    `;
    deleteBtn.addEventListener('click', async () => {
      if (video.liveCatalog && video.liveChannelId) {
        const AppLive = window.NostrApp || {};
        if (typeof AppLive.hideLiveTvChannel === 'function') {
          const ok = await AppLive.hideLiveTvChannel(video.liveChannelId);
          if (ok && typeof refreshLiveTvFeed === 'function') {
            refreshLiveTvFeed();
          }
        }
        return;
      }
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

  // בכרטיסי LIVE שם הערוץ מוצג ליד תג LIVE IPTV — לא חוזרים על אותו טקסט בתחתית | HYPER CORE TECH
  if (video.content && !video.liveUrl) {
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
    // שומרים את כרטיס LoadNug (יושב כמו פוסט) – innerHTML מוחק אותו | HYPER CORE TECH
    const loadnugCard = document.getElementById('sosLoadNugOverlay');
    selectors.stream.innerHTML = '';
    if (loadnugCard && state.feedMode !== 'games' && state.feedMode !== 'live-tv') {
      try { selectors.stream.insertBefore(loadnugCard, selectors.stream.firstChild || null); } catch (_) {}
    }
  }
  
  resetIncrementalRender();

  const sourceVideos = getDisplayVideos();
  // מסיר כרטיסי משחק שכבר הוזרקו ל-DOM (מטמון / load-more ישן) | HYPER CORE TECH
  if (!needsFullRender) {
    pruneFeedCardsNotInDisplay(sourceVideos);
  }

  if (!Array.isArray(sourceVideos) || sourceVideos.length === 0) {
    hideLoadingAnimation();
    setStatus(
      state.feedMode === 'games'
        ? 'אין משחקים להצגה'
        : (state.feedMode === 'live-tv' ? 'אין ערוצים להצגה' : 'אין סרטונים להצגה')
    );
    return;
  }

  // אחרי prune – מרעננים את רשימת הקיימים כדי לא לדלג על הוספות | HYPER CORE TECH
  const currentIds = new Set();
  selectors.stream.querySelectorAll('.videos-feed__card[data-event-id]').forEach((card) => {
    const id = card.getAttribute('data-event-id');
    if (id) currentIds.add(id);
  });

  // סינון רק פוסטים שעוד לא מוצגים
  const videosToRender = needsFullRender
    ? sourceVideos
    : sourceVideos.filter((v) => !currentIds.has(v.id));
  
  if (videosToRender.length === 0) {
    // כל הפוסטים כבר מוצגים — עדיין מסנכרנים סדר DOM (יוטיוב לא יישאר בראש בטעות) | HYPER CORE TECH
    syncFeedDomOrder(sourceVideos);
    hideLoadingAnimation();
    state.firstCardRendered = true;
    return;
  }

  if (!state.firstCardRendered && selectors.status) {
    selectors.status.textContent = state.feedMode === 'games'
      ? 'טוען משחקים...'
      : (state.feedMode === 'live-tv' ? 'טוען ערוצים...' : 'טוען סרטונים...');
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

// חלק יאללה וידאו (videos.js) – הוספת קלף חדש לפיד בסדר הכרונולוגי (לא לפי מי מוכן קודם) | HYPER CORE TECH
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

  // קריטי: mount לפי סדר הרשימה (createdAt), לא לפי mediaReady —
  // אחרת יוטיוב/תמונה (מוכנים מיד) קופצים לפני וידאו שעדיין נטען | HYPER CORE TECH
  mountCard(card);
  mediaReadyPromise
    .then(() => {
      markCardMediaReady(card);
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
  updateLoadMoreTrigger();

  // אחרי הוספת כרטיסים חדשים — מסדרים את כל ה-DOM לפי createdAt | HYPER CORE TECH
  try {
    syncFeedDomOrder(getDisplayVideos());
  } catch (_) {}

  // במצב משחקים / LIVE TV – הפעלה מיידית של הכרטיס הנראה | HYPER CORE TECH
  if (state.feedMode === 'games' || state.feedMode === 'live-tv') {
    requestAnimationFrame(() => {
      const viewport = document.querySelector('.videos-feed__viewport');
      const cards = selectors.stream
        ? Array.from(selectors.stream.querySelectorAll('.videos-feed__card'))
        : [];
      let active = cards[0] || null;
      if (viewport && cards.length) {
        const mid = viewport.scrollTop + viewport.clientHeight / 2;
        active = cards.find((card) => {
          const top = card.offsetTop;
          const bottom = top + card.offsetHeight;
          return mid >= top && mid <= bottom;
        }) || cards[0];
      }
      if (state.feedMode === 'games') {
        const mediaDiv = active?.querySelector('.videos-feed__media[data-media-type="game-embed"]');
        if (mediaDiv) playGameEmbedMedia(mediaDiv);
      } else {
        globalAutoplayEnabled = true;
        updateGlobalStopClass();
        const mediaDiv = active?.querySelector('.videos-feed__media[data-media-type="hls-live"]');
        if (mediaDiv) playHlsLiveMedia(mediaDiv);
        if (active) prefetchNeighborLiveChannels(active);
      }
    });
  }
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
        showLoading: false,
        silent: true,
        muted: true,
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

// חלק ערוץ חי + משחק (videos.js) – חימום 3 ערוצים קדימה לגלילה חלקה | HYPER CORE TECH
function prefetchNeighborLiveChannels(activeCard) {
  if (!activeCard || !activeCard.parentElement) return;
  const App = window.NostrApp || {};

  const cards = Array.from(activeCard.parentElement.querySelectorAll('.videos-feed__card'));
  const idx = cards.indexOf(activeCard);
  if (idx < 0) return;

  // חימום מלא של 3 הערוצים הבאים (בלי מסך טעינה / בלי סאונד) | HYPER CORE TECH
  [cards[idx + 1], cards[idx + 2], cards[idx + 3]].forEach((neighbor) => {
    if (!neighbor) return;
    const liveDiv = neighbor.querySelector('.videos-feed__media[data-media-type="hls-live"]');
    if (liveDiv && liveDiv.dataset.livePrepared !== '1' && typeof App.prepareLiveMedia === 'function') {
      App.prepareLiveMedia(liveDiv, {
        autoplay: false,
        showLoading: false,
        silent: true,
        muted: true,
        loadingLabel: 'טוען ערוץ...',
      }).then((result) => {
        if (result && result.ok === false) {
          const channelId = liveDiv.dataset.liveChannelId || '';
          if (channelId && typeof App.markLiveTvChannelOffline === 'function') {
            App.markLiveTvChannelOffline(channelId);
          }
          removeLiveTvCardFromFeed(liveDiv);
        }
      }).catch(() => {
        removeLiveTvCardFromFeed(liveDiv);
      });
    }
    const gameDiv = neighbor.querySelector('.videos-feed__media[data-media-type="game-embed"]');
    if (gameDiv && typeof App.prepareGameMedia === 'function') {
      App.prepareGameMedia(gameDiv, { loadingLabel: 'טוען משחק...', load: false });
    }
  });

  // שחרור ערוצים/משחקים רחוקים – שומרים רק ±3 | HYPER CORE TECH
  cards.forEach((card, i) => {
    if (Math.abs(i - idx) <= 3) return;
    const liveDiv = card.querySelector('.videos-feed__media[data-media-type="hls-live"]');
    if (liveDiv && liveDiv.dataset.livePrepared === '1' && typeof App.releaseLiveMedia === 'function') {
      if (!liveDiv.classList.contains('is-live-fullscreen') && liveDiv !== activeMediaDiv) {
        App.releaseLiveMedia(liveDiv);
      }
    }
    if (typeof App.deactivateGameMedia === 'function') {
      const gameDiv = card.querySelector('.videos-feed__media[data-media-type="game-embed"]');
      if (!gameDiv || gameDiv.dataset.gamePrepared !== '1') return;
      if (gameDiv.classList.contains('is-game-active') || gameDiv.classList.contains('is-game-fullscreen')) return;
      App.deactivateGameMedia(gameDiv);
    }
  });
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
      // במסך מלא של ערוץ – לא מחליפים/עוצרים בגלל סיבוב או IO | HYPER CORE TECH
      if (document.body.classList.contains('live-channel-fullscreen')) return;

      entries.forEach((entry) => {
        const card = entry.target;
        const mediaDiv = card.querySelector('.videos-feed__media');
        if (!mediaDiv) return;

        // משחקים: playGameEmbed ישירות (לא playMedia – בלי חסימת autoplay) | HYPER CORE TECH
        if (mediaDiv.dataset.mediaType === 'game-embed') {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            playGameEmbedMedia(mediaDiv);
            prefetchNeighborLiveChannels(card);
          } else if (!entry.isIntersecting) {
            pauseMedia(mediaDiv, { resetThumb: false });
          }
          return;
        }

        // LIVE TV: ניגון ישיר כמו משחקים | HYPER CORE TECH
        if (mediaDiv.dataset.mediaType === 'hls-live' && state.feedMode === 'live-tv') {
          if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
            playHlsLiveMedia(mediaDiv);
            prefetchNeighborLiveChannels(card);
          } else if (entry.isIntersecting && entry.intersectionRatio > 0) {
            const App = window.NostrApp || {};
            if (mediaDiv.dataset.livePrepared !== '1' && typeof App.prepareLiveMedia === 'function') {
              App.prepareLiveMedia(mediaDiv, {
                autoplay: false,
                showLoading: false,
                silent: true,
                muted: true,
              }).catch(() => {});
            }
          } else if (!entry.isIntersecting) {
            pauseMedia(mediaDiv, { resetThumb: false });
          }
          return;
        }
        
        // ניגון כשהפוסט מרכזי (50%+ גלוי)
        if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
          playMedia(mediaDiv, { manual: false });
          prefetchNeighborLiveChannels(card);
        } else if (entry.isIntersecting && entry.intersectionRatio > 0) {
          // מתקרבים לכרטיס — חימום HLS שקט ברקע | HYPER CORE TECH
          const App = window.NostrApp || {};
          if (mediaDiv.dataset.mediaType === 'hls-live' && mediaDiv.dataset.livePrepared !== '1') {
            if (typeof App.prepareLiveMedia === 'function') {
              App.prepareLiveMedia(mediaDiv, {
                autoplay: false,
                showLoading: false,
                silent: true,
                muted: true,
              }).catch(() => {});
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

  // גיבוי לגלילת משחקים – מפעיל את הכרטיס במרכז גם אם IO פספס | HYPER CORE TECH
  if (!viewport.dataset.gameScrollSyncBound) {
    viewport.dataset.gameScrollSyncBound = '1';
    let gameSyncTimer = null;
    viewport.addEventListener('scroll', () => {
      if (state.feedMode !== 'games') return;
      clearTimeout(gameSyncTimer);
      gameSyncTimer = setTimeout(() => {
        syncCenteredGameCard(viewport);
      }, 120);
    }, { passive: true });
  }

  return intersectionObserver;
}

// חלק משחקים (videos.js) – הפעלת הכרטיס הקרוב למרכז המסך | HYPER CORE TECH
function syncCenteredGameCard(viewport) {
  if (state.feedMode !== 'games' || !viewport || !selectors.stream) return;
  const cards = Array.from(selectors.stream.querySelectorAll('.videos-feed__card'));
  if (!cards.length) return;
  const mid = viewport.scrollTop + viewport.clientHeight / 2;
  let best = null;
  let bestDist = Infinity;
  cards.forEach((card) => {
    const center = card.offsetTop + card.offsetHeight / 2;
    const dist = Math.abs(center - mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = card;
    }
  });
  if (!best) return;
  // רק אם הכרטיס באמת קרוב למרכז (לא באמצע מעבר) | HYPER CORE TECH
  if (bestDist > viewport.clientHeight * 0.35) return;
  const mediaDiv = best.querySelector('.videos-feed__media[data-media-type="game-embed"]');
  if (!mediaDiv) return;
  if (!mediaDiv.classList.contains('is-game-active')) {
    playGameEmbedMedia(mediaDiv);
  }
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
      threshold: 0,
      rootMargin: '400px 0px'
    }
  );

  // גיבוי לפי גלילה – IO לבד לא תמיד יורה עם scroll-snap | HYPER CORE TECH
  if (!viewport.dataset.loadMoreScrollBound) {
    viewport.dataset.loadMoreScrollBound = '1';
    let scrollTicking = false;
    viewport.addEventListener('scroll', () => {
      if (scrollTicking || isLoadingMore) return;
      scrollTicking = true;
      requestAnimationFrame(() => {
        scrollTicking = false;
        const remaining = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
        if (remaining < viewport.clientHeight * 1.75) {
          loadMoreVideos();
        }
      });
    }, { passive: true });
  }
  
  updateLoadMoreTrigger();
}

function updateLoadMoreTrigger() {
  if (!loadMoreObserver || !selectors.stream) return;
  
  // הסר observer מקלפים קודמים
  loadMoreObserver.disconnect();

  // sentinel בסוף ה־DOM – אמין יותר מקלף לפני-אחרון | HYPER CORE TECH
  let sentinel = selectors.stream.querySelector('[data-load-more-sentinel]');
  if (!sentinel) {
    sentinel = document.createElement('div');
    sentinel.setAttribute('data-load-more-sentinel', '');
    sentinel.setAttribute('aria-hidden', 'true');
    sentinel.className = 'videos-feed__load-more-sentinel';
  }
  selectors.stream.appendChild(sentinel);
  loadMoreObserver.observe(sentinel);

  const cards = selectors.stream.querySelectorAll('.videos-feed__card');
  if (cards.length >= 2) {
    loadMoreObserver.observe(cards[cards.length - 2]);
  } else if (cards.length === 1) {
    loadMoreObserver.observe(cards[0]);
  }
}

async function loadMoreVideos() {
  if (isLoadingMore) return;
  // במצב משחקים / LIVE TV לא טוענים עוד וידאו כללי לתוך התצוגה | HYPER CORE TECH
  if (state.feedMode === 'games' || state.feedMode === 'live-tv') return;
  isLoadingMore = true;
  
  const currentApp = window.NostrApp;
  const networkTag = getNetworkTag();
  
  // מצא את הפוסט הישן ביותר שיש לנו
  const oldestVideo = state.videos.length > 0 
    ? state.videos.reduce((oldest, v) => (getVideoCreatedAt(v) < getVideoCreatedAt(oldest) ? v : oldest), state.videos[0])
    : null;
  
  if (!oldestVideo) {
    isLoadingMore = false;
    return;
  }
  
  let untilTime = getVideoCreatedAt(oldestVideo);
  console.log('[videos] loadMoreVideos: loading older than', new Date(untilTime * 1000).toLocaleString());
  
  try {
    const existingIds = new Set(state.videos.map(v => v.id));
    const collectedVideos = [];

    // כמה ניסיונות עם until – הרבה נוטס בלי מדיה | HYPER CORE TECH
    for (let attempt = 0; attempt < 4 && collectedVideos.length < 5; attempt++) {
      let moreEvents = [];

      // קודם until מהריליי – לא since (שזה רק החדשים ביותר) | HYPER CORE TECH
      const fetched = await fetchRecentNotes(LOAD_MORE_BATCH, undefined, untilTime);
      const olderFromRelay = fetched.filter(ev =>
        ev &&
        !existingIds.has(ev.id) &&
        (ev.created_at || 0) < untilTime
      );
      let filtered = filterEventsByNetwork(olderFromRelay, networkTag);
      filtered.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      moreEvents = filtered.slice(0, LOAD_MORE_BATCH);

      if (moreEvents.length === 0 && currentApp?.postsById?.size > 0) {
        const fromApp = Array.from(currentApp.postsById.values());
        const olderEvents = fromApp.filter(ev =>
          ev &&
          !existingIds.has(ev.id) &&
          (ev.created_at || 0) < untilTime
        );
        filtered = filterEventsByNetwork(olderEvents, networkTag);
        filtered.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        moreEvents = filtered.slice(0, LOAD_MORE_BATCH);
      }

      if (moreEvents.length === 0) {
        console.log('[videos] loadMoreVideos: no older events on attempt', attempt + 1);
        break;
      }

      moreEvents.forEach((ev) => {
        if (ev?.id) existingIds.add(ev.id);
      });
      const oldestFetched = moreEvents.reduce(
        (min, ev) => Math.min(min, ev.created_at || untilTime),
        untilTime
      );
      untilTime = oldestFetched < untilTime ? oldestFetched : untilTime - 1;

      const batchVideos = processEventsToVideos(moreEvents, currentApp);
      batchVideos.forEach((v) => {
        if (!collectedVideos.some((x) => x.id === v.id)) {
          collectedVideos.push(v);
        }
      });
    }

    if (collectedVideos.length > 0) {
      state.videos = [...state.videos, ...collectedVideos];
      console.log('[videos] loadMoreVideos: added', collectedVideos.length, 'videos, total:', state.videos.length);
      // בפיד הכללי לא מציגים משחקים/ערוצי LIVE גם בטעינת המשך | HYPER CORE TECH
      const toShow = collectedVideos.filter((v) => isGeneralFeedVideo(v));
      if (toShow.length) {
        renderMoreVideos(toShow);
      }
      saveFeedCache(state.videos);
    } else {
      console.log('[videos] loadMoreVideos: no more videos available');
    }
  } catch (err) {
    console.warn('[videos] loadMoreVideos failed', err);
  } finally {
    isLoadingMore = false;
    updateLoadMoreTrigger();
  }
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

  const list = state.feedMode === 'games'
    ? videos.filter((v) => isGameFeedVideo(v))
    : state.feedMode === 'live-tv'
      ? []
      : videos.filter((v) => isGeneralFeedVideo(v));

  list.forEach((video) => {
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
async function fetchRecentNotes(limit = 100, sinceOverride = undefined, untilOverride = undefined) {
  const app = window.NostrApp;
  if (!app || !app.pool || !Array.isArray(app.relayUrls) || app.relayUrls.length === 0) {
    console.warn('[videos] fetchRecentNotes: pool/relays not ready');
    return [];
  }
  const networkTag = getNetworkTag();
  const filters = [{ kinds: [1], limit, '#t': [networkTag] }];
  // until = פוסטים ישנים יותר (load-more); since = פוסטים חדשים יותר | HYPER CORE TECH
  if (untilOverride != null && Number.isFinite(Number(untilOverride))) {
    filters[0].until = Number(untilOverride);
  } else if (sinceOverride != null && Number.isFinite(Number(sinceOverride))) {
    filters[0].since = Number(sinceOverride);
  } else {
    filters[0].since = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30;
  }
  // עם until – לא ליפול ל"חדשים ביותר"; בלי until – fallback בלי since | HYPER CORE TECH
  const filtersFallback = untilOverride != null
    ? [{ kinds: [1], limit, until: Number(untilOverride), '#t': [networkTag] }]
    : [{ kinds: [1], limit, '#t': [networkTag] }];
  try {
    console.log('[videos] fetchRecentNotes: using list', {
      relays: app.relayUrls.length,
      limit,
      since: filters[0].since,
      until: filters[0].until,
      fromCache: sinceOverride != null || untilOverride != null
    });
    if (typeof app.pool.list === 'function') {
      const listed = await app.pool.list(app.relayUrls, filters);
      if (Array.isArray(listed) && listed.length > 0) {
        console.log('[videos] fetchRecentNotes: list returned', listed.length);
        return listed;
      }
      const listed2 = await app.pool.list(app.relayUrls, filtersFallback);
      if (Array.isArray(listed2) && listed2.length > 0) {
        console.log('[videos] fetchRecentNotes: list (fallback) returned', listed2.length);
        return listed2;
      }
    }
    if (typeof app.pool.listMany === 'function') {
      const listed = await app.pool.listMany(app.relayUrls, filters);
      if (Array.isArray(listed) && listed.length > 0) {
        console.log('[videos] fetchRecentNotes: listMany returned', listed.length);
        return listed;
      }
      const listed2 = await app.pool.listMany(app.relayUrls, filtersFallback);
      if (Array.isArray(listed2) && listed2.length > 0) {
        console.log('[videos] fetchRecentNotes: listMany (fallback) returned', listed2.length);
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
      const res2 = await app.pool.querySync(app.relayUrls, filtersFallback[0]);
      const events2 = Array.isArray(res2) ? res2 : (Array.isArray(res2?.events) ? res2.events : []);
      if (events2.length > 0) {
        console.log('[videos] fetchRecentNotes: querySync (fallback) returned', events2.length);
        return events2;
      }
    }
    // fallback: שימוש במנוי כדי למשוך אירועים חיים ומהירים
    if (typeof app.pool.sub === 'function' || typeof app.pool.subscribeMany === 'function') {
      console.log('[videos] fetchRecentNotes: fallback sub start');
      return await new Promise((resolve) => {
        const collected = [];
        const subFilters = untilOverride != null ? filters : filtersFallback;
        const sub = typeof app.pool.sub === 'function'
          ? app.pool.sub(app.relayUrls, subFilters)
          : app.pool.subscribeMany(app.relayUrls, subFilters);
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
    // לא סוגרים כאן אם שער ה-boot עדיין פעיל — ensureBootFeedReady יסגור | HYPER CORE TECH
    if (bootGate.released) {
      hideLoadingAnimation();
    } else {
      await ensureBootFeedReady();
    }
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
    let gameForced = false;
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
          } else if (mime.includes('text/html') || isPlayableGameLink(tagUrl)) {
            gameUrl = gameUrl || tagUrl;
            if (mime.includes('text/html') && !isPlayableGameLink(tagUrl) && canEmbedGameLink(tagUrl)) {
              gameForced = true;
            }
          } else if (tagUrl === videoUrl && tagHash) {
            mediaHash = tagHash;
          }
        }
        if (tag[0] === 't' && String(tag[1] || '').toLowerCase() === 'live-hls') {
          const httpLink = mediaLinks.find((l) => /^https?:\/\//i.test(l));
          if (httpLink) liveUrl = liveUrl || httpLink;
        }
        if (tag[0] === 't' && String(tag[1] || '').toLowerCase() === 'game-embed') {
          if (!gameUrl) {
            const httpLink = mediaLinks.find((l) => canEmbedGameLink(l));
            if (httpLink) gameUrl = httpLink;
          }
          if (gameUrl) gameForced = true;
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
        gameForced: !!(gameUrl && gameForced),
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

  videoEvents.sort((a, b) => getVideoCreatedAt(b) - getVideoCreatedAt(a));
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
    state.videos.sort((a, b) => getVideoCreatedAt(b) - getVideoCreatedAt(a));
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

  // אחרי רינדור מהרשת — מוודאים ש־2 הראשונים מוכנים לפני סגירת LoadNug | HYPER CORE TECH
  if (!bootGate.released) {
    await ensureBootFeedReady();
  } else {
    setLoadingProgress(100);
    hideLoadingAnimation();
  }
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

  // אחרי שיש stream – מעטפת הboot יכולה לרדת אם LoadNug כבר עלה / דולג | HYPER CORE TECH
  const bootShell = document.getElementById('feedBootShell');
  if (bootShell && document.getElementById('sosLoadNugOverlay')) {
    try { bootShell.remove(); } catch (_) {}
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
      if (typeof App.exitGamesFeedMode === 'function' && App.exitGamesFeedMode()) {
        console.log('[VIDEOS] Home button exited games feed mode');
        return;
      }
      if (typeof App.exitLiveTvFeedMode === 'function' && App.exitLiveTvFeedMode()) {
        console.log('[VIDEOS] Home button exited LIVE TV feed mode');
        return;
      }
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





  // הסתרת מסך טעינה כגיבוי בטיחותי בלבד — לא אחרי 8 שניות | HYPER CORE TECH
  setTimeout(() => {
    if (!bootGate.released) {
      console.warn('[videos] Boot safety timeout — releasing loading screen');
      releaseBootLoading('safety-timeout');
    }
  }, BOOT_SAFETY_TIMEOUT_MS);

  await waitForApp();
  const app = window.NostrApp || {};
  if (typeof app.buildCoreFeedFilters !== 'function') {
    app.buildCoreFeedFilters = buildVideoFeedFilters;
  }

  // טעינת מחיקות לפני הצגת המטמון כדי לסנן פוסטים מחוקים
  await loadDeletionsFirst();

  showLoadingAnimation();
  setLoadingStatus('טוען פוסטים...');
  setLoadingProgress(20);

  // חלק מטמון (videos.js) – הצגת פוסטים מהמטמון, בלי לסגור LoadNug עד מוכנות מלאה | HYPER CORE TECH
  const hadCachedContent = hydrateFeedFromCache();
  if (hadCachedContent) {
    if (selectors.status) {
      selectors.status.style.display = 'none';
    }
    state.firstCardRendered = true;
    console.log('[videos] displayed cached content, waiting for first posts to be view-ready');
    await ensureBootFeedReady();
  }

  // טעינת תוכן חדש ברקע (גם אם יש מטמון)
  loadVideos()
    .then(async () => {
      if (!bootGate.released) {
        await ensureBootFeedReady();
      }
    })
    .catch((err) => console.warn('[videos] loadVideos failed', err));
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

// חלק פאנל משחקים (videos.js) – פיד משחקים = אותו videos-feed (כפתורים/תפריט צד/דסקטופ) | HYPER CORE TECH
const GAMES_CATALOG_POSTS = [];

function getGamesCatalogPosts() {
  return GAMES_CATALOG_POSTS
    .filter((post) => post.gameUrl && isPlayableGameLink(post.gameUrl))
    .map((post) => ({ ...post }));
}

function buildGamesFeedVideos() {
  const seen = new Set();
  const list = [];
  const blockedParts = [
    'mahdif.github.io/taptaptap',
    'hexgl.bkcore.com',
    'gamh5.com/full/ninja-leap',
    'gamh5.com/full/meteorite-shooter',
    'gamh5.com/full/zoo-boom',
    'krunker.io',
    'cdn-factory.marketjs.com/en/3d-penalty-kick',
  ];
  const isBlocked = (url) => {
    const value = String(url || '').toLowerCase();
    return blockedParts.some((part) => value.includes(part));
  };
  const push = (video) => {
    if (!video || !video.gameUrl) return;
    if (isBlocked(video.gameUrl)) return;
    const ok = isPlayableGameLink(video.gameUrl)
      || (video.gameForced && canEmbedGameLink(video.gameUrl));
    if (!ok) return;
    const key = String(video.gameUrl).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push(video);
  };

  (state.videos || [])
    .filter((v) => v && v.gameUrl)
    .sort((a, b) => getVideoCreatedAt(b) - getVideoCreatedAt(a))
    .forEach(push);

  getGamesCatalogPosts().forEach(push);
  return list;
}

function isGameFeedVideo(video) {
  // פוסט משחק = יש gameUrl / סומן כמשחק לכפיית embed | HYPER CORE TECH
  return !!(video && (video.gameUrl || video.gameForced));
}

function isLiveFeedVideo(video) {
  // ערוץ טלוויזיה / IPTV – מוצג רק במצב LIVE TV | HYPER CORE TECH
  return !!(video && (video.liveUrl || video.liveCatalog));
}

function isGeneralFeedVideo(video) {
  return !!(video && !isGameFeedVideo(video) && !isLiveFeedVideo(video));
}

function sortVideosByCreatedAtDesc(videos) {
  if (!Array.isArray(videos)) return [];
  return videos
    .slice()
    .map((video) => {
      if (!video || typeof video !== 'object') return video;
      video.createdAt = getVideoCreatedAt(video);
      return video;
    })
    .sort((a, b) => getVideoCreatedAt(b) - getVideoCreatedAt(a));
}

// חלק סדר פיד (videos.js) – סנכרון DOM לסדר הכרונולוגי אחרי טעינה דיפרנציאלית / מטמון | HYPER CORE TECH
function syncFeedDomOrder(sourceVideos) {
  if (!selectors.stream || !Array.isArray(sourceVideos) || !sourceVideos.length) return;
  const byId = new Map();
  selectors.stream.querySelectorAll('.videos-feed__card[data-event-id]').forEach((card) => {
    const id = card.getAttribute('data-event-id');
    if (id) byId.set(id, card);
  });
  if (!byId.size) return;

  const loadnug = document.getElementById('sosLoadNugOverlay');
  sourceVideos.forEach((video) => {
    const card = video?.id ? byId.get(video.id) : null;
    if (card) {
      selectors.stream.appendChild(card);
    }
  });
  if (loadnug && selectors.stream.contains(loadnug) && state.feedMode !== 'games' && state.feedMode !== 'live-tv') {
    selectors.stream.insertBefore(loadnug, selectors.stream.firstChild);
  }
}

function getDisplayVideos() {
  // פיד כללי = בלי משחקים ובלי ערוצי LIVE; משחקים / LIVE TV = מצבים נפרדים | HYPER CORE TECH
  if (state.feedMode === 'games') {
    return buildGamesFeedVideos();
  }
  if (state.feedMode === 'live-tv') {
    return Array.isArray(state.liveTvVideos) ? state.liveTvVideos : [];
  }
  const all = Array.isArray(state.videos) ? state.videos : [];
  return sortVideosByCreatedAtDesc(all.filter((v) => isGeneralFeedVideo(v)));
}

function pruneFeedCardsNotInDisplay(sourceVideos) {
  if (!selectors.stream) return;
  const allowedIds = new Set((sourceVideos || []).map((v) => v && v.id).filter(Boolean));
  const cards = Array.from(selectors.stream.querySelectorAll('.videos-feed__card[data-event-id]'));
  cards.forEach((card) => {
    const id = card.getAttribute('data-event-id');
    if (!id) return;
    if (!allowedIds.has(id)) {
      card.remove();
      return;
    }
    // חגורת בטיחות: כרטיס משחק/LIVE בפיד הכללי תמיד מוסר | HYPER CORE TECH
    if (state.feedMode === 'all' || (state.feedMode !== 'games' && state.feedMode !== 'live-tv')) {
      const isGameCard = !!card.querySelector('.videos-feed__media[data-media-type="game-embed"]');
      const isLiveCard = !!card.querySelector('.videos-feed__media[data-media-type="hls-live"]');
      if (isGameCard || isLiveCard) card.remove();
    }
  });
}

function forceFullFeedRerender() {
  if (!selectors.stream) return;
  resetIncrementalRender();
  // לא מכבים PLAY גלובלי ברינדור מחדש (במיוחד LIVE TV / משחקים) | HYPER CORE TECH
  pauseAllFeedVideos({ disableAutoplay: false });

  // מאפשרים טעינת וידאו מחדש אחרי ניקוי DOM | HYPER CORE TECH
  try { videoDownloadedOrQueued.clear(); } catch (_) {}
  videoDownloadQueue = [];
  isProcessingVideoQueue = false;

  const loadnugCard = document.getElementById('sosLoadNugOverlay');
  selectors.stream.innerHTML = '';
  if (loadnugCard && state.feedMode !== 'games' && state.feedMode !== 'live-tv') {
    try { selectors.stream.appendChild(loadnugCard); } catch (_) {}
  }

  state.firstCardRendered = false;
  const videos = getDisplayVideos();
  if (!videos.length) {
    hideLoadingAnimation();
    setStatus(
      state.feedMode === 'games'
        ? 'אין משחקים להצגה'
        : (state.feedMode === 'live-tv' ? 'אין ערוצים להצגה' : 'אין סרטונים להצגה')
    );
    return;
  }

  if (selectors.status) {
    selectors.status.textContent = state.feedMode === 'games'
      ? 'טוען משחקים...'
      : (state.feedMode === 'live-tv' ? 'טוען ערוצים...' : 'טוען סרטונים...');
    selectors.status.style.display = 'block';
  }

  // LIVE / משחקים – תמיד PLAY אחרי רינדור | HYPER CORE TECH
  if (state.feedMode === 'live-tv' || state.feedMode === 'games') {
    globalAutoplayEnabled = true;
    updateGlobalStopClass();
  }

  setupIntersectionObserver();
  setupLoadMoreObserver();
  setupLikeUpdateListener();

  state.incrementalRender = {
    nextIndex: 0,
    cancelled: false,
    timer: null,
    videosToRender: videos,
  };
  appendNextVideoCard();

  const viewport = document.querySelector('.videos-feed__viewport');
  if (viewport) {
    try { viewport.scrollTo({ top: 0, behavior: 'auto' }); } catch (_) { viewport.scrollTop = 0; }
  }
}

function enterGamesFeedMode() {
  state.feedMode = 'games';
  document.body.classList.add('videos-feed-mode-games');
  document.body.classList.remove('videos-feed-mode-live-tv');
  forceFullFeedRerender();
  console.log('[VIDEOS] Games feed mode ON', { count: getDisplayVideos().length });
  return true;
}

function exitGamesFeedMode() {
  if (state.feedMode !== 'games') return false;
  state.feedMode = 'all';
  document.body.classList.remove('videos-feed-mode-games');
  forceFullFeedRerender();
  console.log('[VIDEOS] Games feed mode OFF');
  return true;
}

async function refreshLiveTvFeed() {
  const App = window.NostrApp || {};
  if (typeof App.getLiveTvFeedVideos === 'function') {
    state.liveTvVideos = await App.getLiveTvFeedVideos();
  } else {
    state.liveTvVideos = [];
  }
  if (state.feedMode === 'live-tv') {
    forceFullFeedRerender();
  }
}

function appendLiveTvChannelToFeed(video) {
  if (!video || !video.id || state.feedMode !== 'live-tv') return;
  if (!Array.isArray(state.liveTvVideos)) state.liveTvVideos = [];
  if (state.liveTvVideos.some((v) => v && v.id === video.id)) return;
  video.liveChannelNumber = state.liveTvVideos.length + 1;
  state.liveTvVideos.push(video);
  if (!selectors.stream) return;
  try {
    const { card, mediaReadyPromise } = renderVideoCard(video);
    mediaReadyPromise.then(() => {
      if (state.feedMode !== 'live-tv') return;
      if (!card.isConnected) {
        selectors.stream.appendChild(card);
        observeVideoCard(card);
      }
    }).catch(() => {});
    if (!card.isConnected) {
      selectors.stream.appendChild(card);
      observeVideoCard(card);
    }
  } catch (err) {
    console.warn('[VIDEOS] appendLiveTvChannelToFeed failed', err);
  }
}

window.appendLiveTvChannelToFeed = appendLiveTvChannelToFeed;

function removeLiveTvCardFromFeed(mediaDivOrId) {
  let id = '';
  let card = null;
  if (typeof mediaDivOrId === 'string') {
    id = mediaDivOrId;
    card = selectors.stream && selectors.stream.querySelector(`.videos-feed__card[data-event-id="${id}"]`);
  } else if (mediaDivOrId && mediaDivOrId.closest) {
    card = mediaDivOrId.closest('.videos-feed__card');
    id = (card && card.getAttribute('data-event-id')) || '';
  }
  if (id && Array.isArray(state.liveTvVideos)) {
    state.liveTvVideos = state.liveTvVideos.filter((v) => v && v.id !== id);
  }
  if (card) card.remove();
}

async function enterLiveTvFeedMode() {
  // יוצאים ממצב משחקים אם פתוח | HYPER CORE TECH
  if (state.feedMode === 'games') {
    document.body.classList.remove('videos-feed-mode-games');
  }
  // פיד LIVE תמיד מתחיל ב־PLAY – לפני כל await | HYPER CORE TECH
  globalAutoplayEnabled = true;
  updateGlobalStopClass();
  state.feedMode = 'live-tv';
  document.body.classList.add('videos-feed-mode-live-tv');
  if (selectors.status) {
    selectors.status.textContent = 'טוען ערוצים...';
    selectors.status.style.display = 'block';
  }
  const App = window.NostrApp || {};
  try {
    // רק ערוצים שעברו בדיקה מוצגים | HYPER CORE TECH
    if (typeof App.getReadyLiveTvFeedVideos === 'function') {
      state.liveTvVideos = await App.getReadyLiveTvFeedVideos(10);
    } else {
      if (typeof App.warmInitialLiveTvHealth === 'function') {
        await App.warmInitialLiveTvHealth(16);
      }
      if (typeof App.getLiveTvFeedVideos === 'function') {
        state.liveTvVideos = await App.getLiveTvFeedVideos();
      } else {
        state.liveTvVideos = [];
      }
    }
  } catch (err) {
    console.warn('[VIDEOS] LIVE TV catalog failed', err);
    state.liveTvVideos = [];
  }
  globalAutoplayEnabled = true;
  updateGlobalStopClass();
  forceFullFeedRerender();
  // אחרי רינדור – כופים PLAY שוב (pauseAllFeedVideos הישן שבר את זה) | HYPER CORE TECH
  globalAutoplayEnabled = true;
  updateGlobalStopClass();
  requestAnimationFrame(() => {
    globalAutoplayEnabled = true;
    updateGlobalStopClass();
    const first = selectors.stream && selectors.stream.querySelector('.videos-feed__media[data-media-type="hls-live"]');
    if (first) playHlsLiveMedia(first);
  });
  console.log('[VIDEOS] LIVE TV feed mode ON', { count: getDisplayVideos().length });
  return true;
}

function exitLiveTvFeedMode() {
  if (state.feedMode !== 'live-tv') return false;
  state.feedMode = 'all';
  document.body.classList.remove('videos-feed-mode-live-tv');
  forceFullFeedRerender();
  console.log('[VIDEOS] LIVE TV feed mode OFF');
  return true;
}

function openLiveTvFeed() {
  if (state.feedMode === 'live-tv') {
    refreshLiveTvFeed();
    return true;
  }
  enterLiveTvFeedMode();
  return true;
}

function closeLiveTvFeed() {
  return exitLiveTvFeedMode();
}

function resolveGamesPanelUrl(href) {
  const raw = String(href || './games.html').trim() || './games.html';
  try {
    const url = new URL(raw, window.location.href);
    url.searchParams.set('embedded', '1');
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (_) {
    if (raw.includes('embedded=1')) return raw;
    if (raw.includes('#')) {
      return raw.replace('#', '?embedded=1#');
    }
    return raw.includes('?') ? `${raw}&embedded=1` : `${raw}?embedded=1`;
  }
}

function openGamesPanel(href = './games.html') {
  const raw = String(href || './games.html');
  let hash = '';
  try {
    hash = new URL(raw, window.location.href).hash.replace(/^#/, '').toLowerCase();
  } catch (_) {
    hash = String(raw.split('#')[1] || '').toLowerCase();
  }

  if (hash === 'doom') {
    window.open('./doom-multiplayer.html', 'doomGame', 'width=1200,height=800');
    return true;
  }
  if (hash === 'trivia') {
    if (typeof window.NostrApp?.openTriviaGame === 'function') {
      window.NostrApp.openTriviaGame();
    }
    return true;
  }

  // סגירת iframe ישן אם נשאר פתוח | HYPER CORE TECH
  const gamesPanel = document.getElementById('gamesPanel');
  const gamesFrame = document.getElementById('gamesPanelFrame');
  if (gamesPanel && !gamesPanel.hidden) {
    gamesPanel.hidden = true;
    if (gamesFrame) gamesFrame.src = '';
  }

  // פיד משחקים בתוך אותו videos-feed – בדיוק כמו הפיד הכללי | HYPER CORE TECH
  if (state.feedMode === 'live-tv') {
    exitLiveTvFeedMode();
  }
  if (state.feedMode === 'games') {
    forceFullFeedRerender();
    return true;
  }
  return enterGamesFeedMode();
}

function closeGamesPanel() {
  let closed = false;
  const gamesPanel = document.getElementById('gamesPanel');
  const gamesFrame = document.getElementById('gamesPanelFrame');
  if (gamesPanel && !gamesPanel.hidden) {
    gamesPanel.hidden = true;
    if (gamesFrame) gamesFrame.src = '';
    closed = true;
    console.log('[VIDEOS] Games panel closed');
  }
  if (exitGamesFeedMode()) closed = true;
  if (exitLiveTvFeedMode()) closed = true;
  return closed;
}

function getSharedGamePosts() {
  return (Array.isArray(state.videos) ? state.videos : [])
    .filter((video) => video && video.gameUrl)
    .map((video) => ({
      id: video.id,
      gameUrl: video.gameUrl,
      content: video.content || '',
      authorName: video.authorName || 'משתמש',
      authorPicture: video.authorPicture || '',
      authorInitials: video.authorInitials || '',
      pubkey: video.pubkey || '',
      createdAt: video.createdAt || getVideoCreatedAt(video) || 0,
      source: 'feed',
    }));
}

// חשיפה גלובלית לפאנל משחקים + LIVE TV | HYPER CORE TECH
window.closeGamesPanel = closeGamesPanel;
window.openGamesPanel = openGamesPanel;
window.exitGamesFeedMode = exitGamesFeedMode;
window.enterGamesFeedMode = enterGamesFeedMode;
window.openLiveTvFeed = openLiveTvFeed;
window.closeLiveTvFeed = closeLiveTvFeed;
window.exitLiveTvFeedMode = exitLiveTvFeedMode;
window.enterLiveTvFeedMode = enterLiveTvFeedMode;
window.refreshLiveTvFeed = refreshLiveTvFeed;
window.getSharedGamePosts = getSharedGamePosts;
{
  const AppRef = window.NostrApp || (window.NostrApp = {});
  AppRef.closeGamesPanel = closeGamesPanel;
  AppRef.openGamesPanel = openGamesPanel;
  AppRef.exitGamesFeedMode = exitGamesFeedMode;
  AppRef.enterGamesFeedMode = enterGamesFeedMode;
  AppRef.openLiveTvFeed = openLiveTvFeed;
  AppRef.closeLiveTvFeed = closeLiveTvFeed;
  AppRef.exitLiveTvFeedMode = exitLiveTvFeedMode;
  AppRef.enterLiveTvFeedMode = enterLiveTvFeedMode;
  AppRef.refreshLiveTvFeed = refreshLiveTvFeed;
  AppRef.getSharedGamePosts = getSharedGamePosts;
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
  if (event.data && event.data.type === 'openTriviaGame') {
    closeGamesPanel();
    if (typeof window.NostrApp?.openTriviaGame === 'function') {
      window.NostrApp.openTriviaGame();
    }
  }
  if (event.data && event.data.type === 'openDoomGame') {
    closeGamesPanel();
    window.open('./doom-multiplayer.html', 'doomGame', 'width=1200,height=800');
  }
});
