// חלק דף וידאו (videos.js) – מנגנון משיכת וידאו והצגת פיד בסגנון טיקטוק | HYPER CORE TECH

// גרסת קוד לזיהוי עדכונים
// גרסת קוד לזיהוי עדכונים
const VIDEOS_CODE_VERSION = '2.6.15-desktop-video-ar';
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

// חלק דסקטופ (videos.js) – יחס גובה־רוחב אמיתי לכרטיס (CSS משתמש ב־--video-ar רק ב־min-width 769) | HYPER CORE TECH
function applyDesktopVideoAspect(mediaEl, widthOrVideoEl, heightMaybe) {
  if (!mediaEl) return;
  let w = 0;
  let h = 0;
  if (widthOrVideoEl && typeof widthOrVideoEl === 'object' && 'videoWidth' in widthOrVideoEl) {
    w = Number(widthOrVideoEl.videoWidth) || 0;
    h = Number(widthOrVideoEl.videoHeight) || 0;
  } else {
    w = Number(widthOrVideoEl) || 0;
    h = Number(heightMaybe) || 0;
  }
  if (w < 2 || h < 2) return;
  const ar = w / h;
  if (!Number.isFinite(ar) || ar <= 0) return;
  const kind = ar > 1.05 ? 'landscape' : (ar < 0.95 ? 'portrait' : 'square');
  try {
    mediaEl.style.setProperty('--video-ar', String(ar));
    mediaEl.dataset.videoAr = kind;
    const card = mediaEl.closest?.('.videos-feed__card');
    if (card) {
      card.style.setProperty('--video-ar', String(ar));
      card.dataset.videoAr = kind;
    }
  } catch (_) {}
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
window.syncP2PStatsUI = () => {
  try {
    p2pStatsUI.sync();
    p2pStatsUI.updateTooltip();
  } catch (_) {}
};

// תור טעינה סדרתית לוידאו
let videoDownloadQueue = [];
let isProcessingVideoQueue = false;
let feedDownloadsPaused = false; // השהיית הורדות פיד בזמן העלאת פוסט | HYPER CORE TECH
let feedWarmupPaused = false; // השהיית תור וידאו בלבד כששיחות פתוחות | HYPER CORE TECH
const BOOTSTRAP_VIDEO_DELAY = 100; // 100ms בין שיגורים | HYPER CORE TECH
const FEED_VIDEO_MAX_PARALLEL = 2; // עד 2 קבצים במקביל; איטי → pipeline | HYPER CORE TECH
// חלק מניעת כפילויות (videos.js) – מעקב אחרי וידאו שכבר בתור או הורדו | HYPER CORE TECH
const videoDownloadedOrQueued = new Set();

function isFeedHeavyWorkPaused() {
  return feedDownloadsPaused || feedWarmupPaused;
}

function tryResumeFeedHeavyWork(reason = 'resume') {
  if (isFeedHeavyWorkPaused()) return;
  console.log('[videos] feed video queue RESUMED', reason);
  processVideoDownloadQueue().catch((err) => {
    console.warn('[videos] resume download queue failed', err);
  });
}

function setFeedDownloadsPaused(paused) {
  feedDownloadsPaused = !!paused;
  console.log('[videos] feed downloads', feedDownloadsPaused ? 'PAUSED (upload in progress)' : 'RESUMED');
  if (!feedDownloadsPaused) {
    tryResumeFeedHeavyWork('upload-done');
  }
}

// חלק שיחות (videos.js) – האם פאנל שיחות באמת פתוח (לא רק דגל ישן) | HYPER CORE TECH
function isChatFeedWarmupActive() {
  try {
    const app = window.NostrApp || {};
    if (app.chatState && typeof app.chatState.isOpen === 'boolean') {
      return !!app.chatState.isOpen;
    }
  } catch (_) {}
  try {
    const panel = document.getElementById('chatPanel');
    if (panel && !panel.hasAttribute('hidden')) return true;
  } catch (_) {}
  return false;
}

// חלק עומס מכשיר (videos.js) – מוחק pause תקוע כשלא בשיחות; לא מבטל עצירה בשיחות | HYPER CORE TECH
function syncFeedWarmupPauseWithChat(reason = 'sync') {
  if (feedWarmupPaused && !isChatFeedWarmupActive()) {
    console.log('[videos] clearing stale feedWarmupPaused — chat not open', { reason });
    setFeedWarmupPaused(false);
  }
}

// חלק עומס מכשיר (videos.js) – השהיית תור פיד/קאש בשיחות; מיזוג פוסטים ממשיך | HYPER CORE TECH
function setFeedWarmupPaused(paused) {
  const next = !!paused;
  if (feedWarmupPaused === next) return;
  feedWarmupPaused = next;
  console.log('[videos] feed video queue', feedWarmupPaused ? 'PAUSED (chat open)' : 'RESUMED (chat closed)');
  if (!feedWarmupPaused) {
    tryResumeFeedHeavyWork('chat-closed');
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

// חלק קאש מקומי (videos.js) – הצמדה מיידית מ-IndexedDB בלי רשת | HYPER CORE TECH
async function tryAttachVideoFromLocalCache(videoEl, hash) {
  if (!videoEl || !hash || typeof App.getCachedMedia !== 'function') return false;
  try {
    const cached = await App.getCachedMedia(hash);
    if (!cached || !cached.blob) return false;
    videoEl.src = URL.createObjectURL(cached.blob);
    try { videoEl.load(); } catch (_) {}
    try {
      if (typeof App.recordP2PDownload === 'function') {
        App.recordP2PDownload('cache');
      } else if (typeof window.updateP2PStatsUI === 'function') {
        window.updateP2PStatsUI('cache');
      }
    } catch (_) {}
    return true;
  } catch (err) {
    console.warn('[videos] local cache attach failed', err);
    return false;
  }
}

// עיבוד תור — עד 2 במקביל; כשאיטי פותחים קובץ נוסף (pipeline) | HYPER CORE TECH
async function processVideoDownloadQueue() {
  if (isProcessingVideoQueue || videoDownloadQueue.length === 0) return;
  // בית בלי שיחות — לא נשארים תקועים על pause ישן | HYPER CORE TECH
  syncFeedWarmupPauseWithChat('download-queue');
  if (isFeedHeavyWorkPaused()) {
    console.log('[videos] download queue waiting —', feedWarmupPaused ? 'chat open' : 'upload in progress');
    return;
  }

  isProcessingVideoQueue = true;

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

  const totalInQueue = videoDownloadQueue.length;
  let processedCount = 0;
  console.log(`%c╔════════════════════════════════════════╗`, 'color: #4CAF50; font-weight: bold');
  console.log(`%c║  🎬 תור וידאו (${FEED_VIDEO_MAX_PARALLEL} במקביל) tier=${currentTier} ║`, 'color: #4CAF50; font-weight: bold');
  console.log(`%c╚════════════════════════════════════════╝`, 'color: #4CAF50; font-weight: bold');

  const runOne = async (item) => {
    const { videoEl, url, hash, mirrors, fallbackFn } = item;
    let loadedFromCache = await tryAttachVideoFromLocalCache(videoEl, hash);
    if (!loadedFromCache) {
      try {
        if (typeof App.loadVideoWithCache === 'function') {
          const result = await App.loadVideoWithCache(videoEl, url, hash, mirrors);
          loadedFromCache = result?.source === 'cache';
        } else if (typeof fallbackFn === 'function') {
          fallbackFn();
        }
      } catch (err) {
        console.warn('Failed to load video with P2P/cache:', err);
        if (typeof fallbackFn === 'function') fallbackFn();
      }
    }
    return loadedFromCache;
  };

  const inFlight = new Set();
  while ((videoDownloadQueue.length > 0 || inFlight.size > 0) && !isFeedHeavyWorkPaused()) {
    while (
      videoDownloadQueue.length > 0 &&
      inFlight.size < FEED_VIDEO_MAX_PARALLEL &&
      !isFeedHeavyWorkPaused()
    ) {
      const item = videoDownloadQueue.shift();
      processedCount += 1;
      const p = runOne(item).finally(() => inFlight.delete(p));
      inFlight.add(p);
      if (videoDownloadQueue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, BOOTSTRAP_VIDEO_DELAY));
      }
      // אם ההורדה איטית — ממשיכים לפתוח את הבא עד המקסימום | HYPER CORE TECH
      if (
        inFlight.size >= 1 &&
        typeof App.shouldPipelineNextFeedDownload === 'function' &&
        App.shouldPipelineNextFeedDownload()
      ) {
        continue;
      }
    }
    if (inFlight.size === 0) break;
    await Promise.race([...inFlight]);
  }

  console.log(`%c╔════════════════════════════════════════╗`, 'color: #4CAF50; font-weight: bold');
  console.log(`%c║  ✅ תור וידאו הושלם - ${processedCount}/${totalInQueue}    ║`, 'color: #4CAF50; font-weight: bold');
  console.log(`%c╚════════════════════════════════════════╝`, 'color: #4CAF50; font-weight: bold');

  isProcessingVideoQueue = false;
  if (!isFeedHeavyWorkPaused() && videoDownloadQueue.length > 0) {
    processVideoDownloadQueue().catch(() => {});
  }
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
  if (bootGate.active && !bootGate.released) return;
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

function getCenteredFeedCard() {
  const viewport = document.querySelector('.videos-feed__viewport');
  const stream = selectors.stream || document.getElementById('videosStream');
  if (!stream) return null;
  const cards = Array.from(stream.querySelectorAll('.videos-feed__card[data-event-id]'));
  if (!cards.length) return null;
  if (!viewport) return cards[0];
  const mid = viewport.scrollTop + viewport.clientHeight / 2;
  return cards.find((card) => {
    const top = card.offsetTop;
    const bottom = top + card.offsetHeight;
    return mid >= top && mid <= bottom;
  }) || cards[0];
}

// חלק זיהוי פיד (videos.js) – אחרי replaceState ה־pathname הוא "/" ולכן לא סומכים עליו | HYPER CORE TECH
function isOnVideosFeedPage() {
  try {
    if (document.body && document.body.classList.contains('videos-page')) return true;
  } catch (_) {}
  if (document.getElementById('videosStream')) return true;
  if (document.querySelector('.videos-feed')) return true;
  const path = String(window.location.pathname || '');
  if (path.includes('videos.html') || path.endsWith('/videos')) return true;
  return false;
}

// חלק חזרה מ־overlay (videos.js) – ממשיכים את הפוסט שבמרכז המסך, בלי רענון | HYPER CORE TECH
function resumeCenteredFeedVideo() {
  // LoadNug שנשאר ב-DOM אחרי שיחה מ־APK מסתיר את כל הכרטיסים (:has) | HYPER CORE TECH
  try {
    const stuckNug = document.getElementById('sosLoadNugOverlay');
    if (stuckNug) {
      try { stuckNug.remove(); } catch (_) {}
      try { document.body.classList.remove('videos-boot-loading'); } catch (_) {}
      bootGate.active = false;
      bootGate.released = true;
      bootGate.releasePromise = null;
    }
  } catch (_) {}
  if (bootGate.active && !bootGate.released) return;
  globalAutoplayEnabled = true;
  updateGlobalStopClass();
  const active = getCenteredFeedCard();
  if (!active) return;
  const mediaDiv = active.querySelector('.videos-feed__media');
  if (mediaDiv) {
    playMedia(mediaDiv, { manual: false, priority: true });
    console.log('[videos] resumed centered feed video', { id: active.getAttribute('data-event-id') });
  }
}

/**
 * אחרי שיחה נכנסת מ־APK האתחול נקטע – מנקים LoadNug/דגלים ומכינים את הפיד מחדש | HYPER CORE TECH
 */
function recoverFeedUiAfterCall(reason = 'after-call') {
  console.log('[videos] recoverFeedUiAfterCall', reason);
  try {
    document.body.classList.remove('sos-call-active', 'sos-deeplink-chat', 'videos-boot-loading');
    document.documentElement.removeAttribute('data-sos-deeplink');
  } catch (_) {}
  try {
    if (typeof App.clearSosDeepLinkFlags === 'function') App.clearSosDeepLinkFlags();
  } catch (_) {}
  try {
    bootGate.active = false;
    bootGate.released = true;
    bootGate.releasePromise = null;
    bootGate.holdUntil = 0;
  } catch (_) {}
  try {
    const ov = document.getElementById('sosLoadNugOverlay');
    if (ov) ov.remove();
  } catch (_) {}
  try {
    if (window.SOSLoadNug && typeof window.SOSLoadNug.signalReady === 'function') {
      window.SOSLoadNug.signalReady();
    }
  } catch (_) {}
  try {
    hideLoadingAnimation({ force: true });
    hideSoftFeedLoading();
  } catch (_) {}

  globalAutoplayEnabled = true;
  updateGlobalStopClass();

  try {
    document.querySelectorAll('.videos-feed__media[data-media-pending="1"]').forEach((mediaDiv) => {
      const videoEl = mediaDiv.querySelector('video');
      if (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        revealVideoSurface(mediaDiv, videoEl);
      }
    });
  } catch (_) {}

  // אם דף שיחות פתוח – רק מכינים; ה־play יקרה בלחיצת בית | HYPER CORE TECH
  let chatOpen = false;
  try {
    chatOpen = document.body.classList.contains('chat-overlay-open')
      || !!(document.getElementById('chatPanel') && !document.getElementById('chatPanel').hasAttribute('hidden'));
  } catch (_) {}
  if (!chatOpen) {
    try { resumeCenteredFeedVideo(); } catch (_) {}
  }
}

// חלק בית (videos.js) – לחיצה 1: סגירת overlay / רמז; לחיצה 2: רענון חם בלבד | HYPER CORE TECH
const HOME_REFRESH_ARM_MS = 4500;
const HOME_ACTION_DEBOUNCE_MS = 450; // WebView לעיתים יורה 2 clicks מאותו מגע | HYPER CORE TECH
const HOME_ARM_GUARD_MS = 500; // אחרי לחיצה 1 לא מאפשרים refresh מיידי מ־double-fire | HYPER CORE TECH
let homeRefreshArmedUntil = 0;
let homeRefreshArmedAt = 0;
let homeRefreshHintTimer = null;
let lastHomeActionInvokeAt = 0;

function clearHomeRefreshArm() {
  homeRefreshArmedUntil = 0;
  homeRefreshArmedAt = 0;
  if (homeRefreshHintTimer) {
    clearTimeout(homeRefreshHintTimer);
    homeRefreshHintTimer = null;
  }
  document.querySelectorAll('.videos-home-refresh-hint').forEach((el) => {
    try { el.remove(); } catch (_) {}
  });
}

function showHomeRefreshHint() {
  document.querySelectorAll('.videos-home-refresh-hint').forEach((el) => {
    try { el.remove(); } catch (_) {}
  });
  if (homeRefreshHintTimer) {
    clearTimeout(homeRefreshHintTimer);
    homeRefreshHintTimer = null;
  }
  const card = getCenteredFeedCard();
  const host = card || document.querySelector('.videos-feed__viewport') || document.body;
  const hint = document.createElement('div');
  hint.className = 'videos-home-refresh-hint';
  hint.setAttribute('role', 'status');
  hint.setAttribute('aria-live', 'polite');
  hint.innerHTML = '<span>לחיצה נוספת על דף הבית תרענן את הפיד</span>';
  host.appendChild(hint);
  requestAnimationFrame(() => {
    try { hint.classList.add('is-visible'); } catch (_) {}
  });
  const now = Date.now();
  homeRefreshArmedAt = now;
  homeRefreshArmedUntil = now + HOME_REFRESH_ARM_MS;
  homeRefreshHintTimer = setTimeout(() => {
    clearHomeRefreshArm();
  }, HOME_REFRESH_ARM_MS);
}

function markHomeNavActive() {
  try {
    document.querySelectorAll('.primary-nav [data-nav]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-nav') === 'videos');
    });
  } catch (_) {}
}

/**
 * התנהגות אחידה ללחיצת בית — לעולם בלי location.href / LoadNug בלחיצה 1:
 * - פרופיל / שיחות / התראות פתוחים → סוגר בלבד + ממשיך את אותו פוסט
 * - IPTV / משחקים / פוסטים שלי → יציאה לפיד הראשי בלבד (בלי רמז רענון)
 * - על הפיד הראשי בלבד: לחיצה ראשונה = רמז; לחיצה שנייה = soft-refresh חם
 */
function handleHomeButtonAction() {
  const now = Date.now();
  if (now - lastHomeActionInvokeAt < HOME_ACTION_DEBOUNCE_MS) {
    console.log('[videos] Home debounced', { ms: now - lastHomeActionInvokeAt });
    return 'debounced';
  }
  lastHomeActionInvokeAt = now;

  try { document.body.classList.add('videos-page'); } catch (_) {}

  const App = window.NostrApp || {};
  markHomeNavActive();

  const hadOverlay = areFeedOverlaysOpen();
  if (hadOverlay) {
    clearHomeRefreshArm();
    try {
      if (typeof App.closeAllOverlays === 'function') App.closeAllOverlays();
    } catch (_) {}
    resumeCenteredFeedVideo();
    console.log('[videos] Home closed overlay — no refresh');
    return 'closed-overlay';
  }

  // IPTV / משחקים / פוסטים שלי — לחיצה אחת מחזירה לבית, בלי הודעת רענון | HYPER CORE TECH
  const mode = state && state.feedMode;
  if (mode === 'live-tv' || mode === 'games' || mode === 'own-posts') {
    clearHomeRefreshArm();
    try {
      if (mode === 'live-tv' && typeof App.exitLiveTvFeedMode === 'function') {
        App.exitLiveTvFeedMode();
      } else if (mode === 'games' && typeof App.exitGamesFeedMode === 'function') {
        App.exitGamesFeedMode();
      } else if (mode === 'own-posts' && typeof App.exitOwnPostsFeedMode === 'function') {
        App.exitOwnPostsFeedMode({ reopenProfile: false });
      }
    } catch (_) {}
    try { resumeCenteredFeedVideo(); } catch (_) {}
    console.log('[videos] Home exited special feed mode — no refresh hint', { mode });
    return 'closed-feed-mode';
  }

  // לחיצה שנייה אחרי הרמז — רק בדף הבית (feedMode all) | HYPER CORE TECH
  if (homeRefreshArmedUntil > 0 && now < homeRefreshArmedUntil) {
    if (now - homeRefreshArmedAt < HOME_ARM_GUARD_MS) {
      console.log('[videos] Home second-tap ignored (arm guard)');
      return 'arm-guard';
    }
    clearHomeRefreshArm();
    // תמיד warm אם יש תוכן על המסך — לא LoadNug | HYPER CORE TECH
    const refreshFn = App.softRefreshVideosFeed || window.softRefreshVideosFeed || softRefreshVideosFeed;
    if (typeof refreshFn === 'function') {
      console.log('[videos] Home second tap — soft refresh (prefer warm)');
      refreshFn({ preferWarm: true, fromHome: true });
      return 'refresh';
    }
    return 'refresh-missing';
  }

  showHomeRefreshHint();
  console.log('[videos] Home first tap on main feed — armed refresh hint', { version: VIDEOS_CODE_VERSION });
  return 'armed';
}

function areFeedOverlaysOpen() {
  // לא לקרוא ל-App.areFeedOverlaysOpen אם זה אנחנו — מונע רקורסיה אחרי overwrite | HYPER CORE TECH
  if (document.body.classList.contains('chat-overlay-open')) return true;
  try {
    const App = window.NostrApp || {};
    if (App.chatState && App.chatState.isOpen) return true;
    const navCheck = App.areFeedOverlaysOpen;
    if (typeof navCheck === 'function' && navCheck !== areFeedOverlaysOpen) {
      return !!navCheck();
    }
  } catch (_) {}
  const ids = ['profilePanel', 'publicProfilePanel', 'gamesPanel', 'chatPanel', 'notificationsPanel'];
  if (document.body.classList.contains('videos-comments-open')) return true;
  if (document.querySelector('.videos-comments-overlay')) return true;
  return ids.some((id) => {
    const el = document.getElementById(id);
    if (!el || el.hidden || el.hasAttribute('hidden')) return false;
    try {
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    } catch (_) {}
    return true;
  });
}

// חלק בית (videos.js) – מאזין capture מוקדם (לפני navigation.js bubble) | HYPER CORE TECH
let homeCaptureBound = false;
function bindHomeNavCaptureOnce() {
  if (homeCaptureBound) return;
  homeCaptureBound = true;
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const homeNav = target.closest('.primary-nav [data-nav="videos"]');
    if (!homeNav) return;
    if (!isOnVideosFeedPage()) return;

    event.preventDefault();
    event.stopPropagation();
    try { event.stopImmediatePropagation(); } catch (_) {}
    handleHomeButtonAction();
  }, true);
}
try {
  bindHomeNavCaptureOnce();
} catch (_) {}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    try {
      document.body.classList.add('videos-page');
      bindHomeNavCaptureOnce();
    } catch (_) {}
  });
} else {
  try { document.body.classList.add('videos-page'); } catch (_) {}
}

// חלק יאללה וידאו (videos.js) – איפוס התחלה בגלילה (כמו טיקטוק) — מונע seek כבד בחזרה לפוסט | HYPER CORE TECH
function resetFeedVideoToStart(videoEl) {
  if (!videoEl) return;
  try {
    if (!(isFinite(videoEl.currentTime) && videoEl.currentTime > 0.05)) return;
    if (typeof videoEl.fastSeek === 'function') {
      try { videoEl.fastSeek(0); } catch (_) { videoEl.currentTime = 0; }
    } else {
      videoEl.currentTime = 0;
    }
  } catch (_) {}
}

// חלק יאללה וידאו (videos.js) – הפעלת מדיה עבור כרטיס נתון
function playMedia(mediaDiv, { manual = false, priority = false } = {}) {
  if (!mediaDiv) return;

  // בזמן דף טעינה – לא מנגנים מאחורי המסך; נתחיל מיד אחרי הסגירה | HYPER CORE TECH
  if (bootGate.active && !bootGate.released && !manual) {
    return;
  }
  
  // אם זו לחיצה ידנית - מפעילים מצב PLAY גלובלי
  if (manual) {
    globalAutoplayEnabled = true;
    updateGlobalStopClass();
  }

  // פיד LIVE TV תמיד מנגן (כמו משחקים) – לא נתקעים ב־STOP מהפיד הכללי | HYPER CORE TECH
  const forceLivePlay = (mediaDiv.dataset.mediaType === 'hls-live'
      && (state.feedMode === 'live-tv' || mediaDiv.classList.contains('is-live-fullscreen') || priority))
    || mediaDiv.dataset.mediaType === 'p2p-live';
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
    // בגלילה תמיד מההתחלה; Pause/Play ידני ממשיך מאותה נקודה | HYPER CORE TECH
    if (!manual) {
      resetFeedVideoToStart(videoEl);
    }
    
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
  } else if (mediaType === 'p2p-live') {
    playP2pLiveMedia(mediaDiv);
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
  // לא עוצרים רק את הערוץ שבמסך מלא עצמו (סיבוב/IO) – ערוצים אחרים כן נעצרים | HYPER CORE TECH
  if (!manual && mediaDiv.classList.contains('is-live-fullscreen')) {
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

  if (mediaType === 'file' || mediaType === 'hls-live' || mediaType === 'p2p-live') {
    const videoEl = mediaDiv.querySelector('video');
    if (videoEl) {
      videoEl.pause();
      // בגלילה: מאפסים מיד כדי שבחזרה לפוסט לא יהיה seek כבד | HYPER CORE TECH
      if (!manual && mediaType === 'file') {
        resetFeedVideoToStart(videoEl);
      }
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
    if (mediaType === 'p2p-live') {
      try {
        const LiveApp = window.NostrApp || {};
        if (LiveApp._p2pLiveActiveMedia === mediaDiv) LiveApp._p2pLiveActiveMedia = null;
      } catch (_) {}
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
  if (options.disableAutoplay === false) {
    console.log('[VIDEOS] Pausing feed videos (rerender/hydrate)');
  } else {
    console.log('[VIDEOS] Pausing all feed videos for call');
  }
  
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

// חלק שידור חי P2P (videos.js) – ניגון כרטיס LIVE מהמשתמשים בפיד | HYPER CORE TECH
function playP2pLiveMedia(mediaDiv) {
  if (!mediaDiv) return;
  const App = window.NostrApp || {};
  const videoEl = mediaDiv.querySelector('video');
  if (!videoEl) return;

  App._p2pLiveActiveMedia = mediaDiv;
  mediaDiv.classList.add('videos-feed__media--ready');
  mediaDiv.classList.remove('is-paused');
  mediaDiv.dataset.state = 'playing';
  activeMediaDiv = mediaDiv;

  if (videoEl.srcObject) {
    videoEl.muted = false;
    videoEl.play().catch(() => {
      videoEl.muted = true;
      videoEl.play().catch(() => {});
    });
    const hint = mediaDiv.querySelector('.videos-p2p-live-hint');
    if (hint) hint.hidden = true;
    // הקשה על הכרטיס מנסה להפעיל סאונד (מדיניות autoplay) | HYPER CORE TECH
    if (!mediaDiv.dataset.p2pAudioBound) {
      mediaDiv.dataset.p2pAudioBound = '1';
      mediaDiv.addEventListener('pointerdown', () => {
        try {
          videoEl.muted = false;
          videoEl.play().catch(() => {});
        } catch (_) {}
      }, { passive: true });
    }
    return;
  }

  const owner = mediaDiv.dataset.liveOwner;
  const slug = mediaDiv.dataset.liveSlug || 'live';
  if (!owner || typeof App.live?.watch !== 'function') return;

  if (mediaDiv.dataset.p2pLiveJoined !== '1') {
    mediaDiv.dataset.p2pLiveJoined = '1';
    Promise.resolve(App.live.watch(owner, slug)).catch((err) => {
      console.warn('[videos] p2p live watch failed', err);
      const hint = mediaDiv.querySelector('.videos-p2p-live-hint');
      if (hint) {
        hint.hidden = false;
        hint.textContent = 'לא ניתן להתחבר לשידור';
      }
    });
  }
}

// חלק ערוץ חי (videos.js) – הפעלת HLS עם מסך טעינה כמו משחקים | HYPER CORE TECH
async function playHlsLiveMedia(mediaDiv) {
  if (!mediaDiv) return;
  const App = window.NostrApp || {};
  const videoEl = mediaDiv.querySelector('video');
  if (!videoEl) return;

  if (activeMediaDiv && activeMediaDiv !== mediaDiv) {
    // תמיד עוצרים את הקודם – גם במסך מלא (מונע סאונד כפול בין ערוצים) | HYPER CORE TECH
    const prev = activeMediaDiv;
    const prevVideo = prev.querySelector('video');
    if (prevVideo) {
      try { prevVideo.pause(); } catch (_) {}
      try { prevVideo.muted = true; } catch (_) {}
    }
    prev.classList.remove('is-live-playing');
    prev.classList.add('is-paused');
    prev.dataset.state = 'paused';
    if (!prev.classList.contains('is-live-fullscreen')) {
      pauseMedia(prev, { resetThumb: false });
    }
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
App.playHlsLiveMedia = playHlsLiveMedia;
App.setFeedDownloadsPaused = setFeedDownloadsPaused;
App.setFeedWarmupPaused = setFeedWarmupPaused;
App.syncFeedWarmupPauseWithChat = syncFeedWarmupPauseWithChat;
App.hideLoadingAnimation = hideLoadingAnimation;
App.showLoadingAnimation = showLoadingAnimation;

try {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncFeedWarmupPauseWithChat('visibility');
    }
  });
  window.addEventListener('pageshow', () => {
    syncFeedWarmupPauseWithChat('pageshow');
  });
} catch (_) {}

const state = {
  videos: [],
  currentIndex: 0,
  incrementalRender: null,
  firstCardRendered: false,
  pendingOldCards: null,
  downloadedBytes: 0, // מעקב אחרי כמות הנתונים שהורדו
  feedMode: 'all', // 'all' | 'games' | 'live-tv' | 'own-posts' | HYPER CORE TECH
  liveTvVideos: [],
  ownPostsVideos: [],
  ownPostsStartId: null,
  ownPostsReturnSource: 'personal', // 'personal' | 'public'
  ownPostsReturnPubkey: null,
};

// חלק טעינה (videos.js) – סף מינימלי להורדה לפני סגירת מסך הטעינה | HYPER CORE TECH
const MIN_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20MB מינימום
// כמה פוסטים ראשונים חייבים להיות מוכנים לצפייה לפני סגירת LoadNug | HYPER CORE TECH
const BOOT_READY_POST_COUNT = 2;
const BOOT_MEDIA_TIMEOUT_MS = 20000;
const BOOT_SAFETY_TIMEOUT_MS = 45000;

const bootGate = {
  active: true,
  released: false,
  releasePromise: null,
  holdUntil: 0,
};

// פוסטים חדשים שירדו ברקע — מוצגים בראש רק בלחיצת בית (בלי קפיצה באמצע צפייה) | HYPER CORE TECH
const pendingNewVideoIds = new Set();

const selectors = {
  stream: null,
  status: null,
};

let activeMediaDiv = null;
let intersectionObserver = null;

const FEED_CACHE_KEY = 'videos_feed_cache_v3';
// מגבלת פוסטים במטא־קאש — חובה מוגדרת (בלי זה truncate זורק ושובר שמירה) | HYPER CORE TECH
const FEED_CACHE_LIMIT = 400;
const FEED_CACHE_MAX_BYTES = 4 * 1024 * 1024; // ~4MB — מציאותי ל-localStorage | HYPER CORE TECH
const FEED_CACHE_CLEANUP_BATCH = 40; // כמה פוסטים למחוק בכל ניסיון | HYPER CORE TECH
const FEED_CACHE_MIN_KEEP = 40; // מינימום לשמור גם אחרי quota | HYPER CORE TECH
try { window.FEED_CACHE_LIMIT = FEED_CACHE_LIMIT; } catch (_) {}

// פוסטים עם מדיה מתה (404/Blossom) — לא מציגים שוב כרטיסיה ריקה | HYPER CORE TECH
const FAILED_MEDIA_CACHE_KEY = 'videos_failed_media_v1';
const FAILED_MEDIA_MAX = 800;
const failedMediaIds = new Set();
const failedMediaHashes = new Set();

function loadFailedMediaBlacklist() {
  try {
    const raw = window.localStorage.getItem(FAILED_MEDIA_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed?.ids) ? parsed.ids : (Array.isArray(parsed) ? parsed : []);
    const hashes = Array.isArray(parsed?.hashes) ? parsed.hashes : [];
    ids.forEach((id) => { if (id) failedMediaIds.add(String(id)); });
    hashes.forEach((h) => { if (h) failedMediaHashes.add(String(h)); });
    console.log('[videos] failed-media blacklist loaded', {
      ids: failedMediaIds.size,
      hashes: failedMediaHashes.size,
    });
  } catch (err) {
    console.warn('[videos] failed-media blacklist load failed', err);
  }
}

function saveFailedMediaBlacklist() {
  try {
    const ids = Array.from(failedMediaIds).slice(-FAILED_MEDIA_MAX);
    const hashes = Array.from(failedMediaHashes).slice(-FAILED_MEDIA_MAX);
    window.localStorage.setItem(
      FAILED_MEDIA_CACHE_KEY,
      JSON.stringify({ ids, hashes, updatedAt: Date.now() })
    );
  } catch (err) {
    console.warn('[videos] failed-media blacklist save failed', err);
  }
}

function isMediaUnavailable(videoOrId) {
  if (!videoOrId) return false;
  if (typeof videoOrId === 'string') {
    return failedMediaIds.has(videoOrId);
  }
  if (videoOrId.id && failedMediaIds.has(videoOrId.id)) return true;
  if (videoOrId.hash && failedMediaHashes.has(videoOrId.hash)) return true;
  return false;
}

function markMediaUnavailable(videoId, hash = null) {
  let changed = false;
  if (videoId && !failedMediaIds.has(videoId)) {
    failedMediaIds.add(String(videoId));
    changed = true;
  }
  if (hash && !failedMediaHashes.has(hash)) {
    failedMediaHashes.add(String(hash));
    changed = true;
  }
  if (changed) saveFailedMediaBlacklist();
}

try { loadFailedMediaBlacklist(); } catch (_) {}

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

// דירוג לפיד: שיתוף אחרון מעלה פוסט לראש כמו טיקטוק | HYPER CORE TECH
function getVideoRankAt(video) {
  const created = getVideoCreatedAt(video) || 0;
  const id = video?.id;
  let boosted = Number(video?.boostedAt) || 0;
  try {
    const app = window.NostrApp;
    if (id && app?.latestShareAtByEventId instanceof Map) {
      const fromShares = Number(app.latestShareAtByEventId.get(id)) || 0;
      if (fromShares > boosted) boosted = fromShares;
    }
  } catch (_) {}
  return Math.max(created, boosted);
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
  // כרטיסי P2P LIVE לא נשמרים במטמון — בלי MediaStream הם ריקים ותוקעים את הפיד | HYPER CORE TECH
  if (video.p2pLive || String(video.id || '').startsWith('p2plive-')) {
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

function writeFeedCachePayload(videos) {
  const payload = {
    timestamp: Date.now(),
    videos: Array.isArray(videos) ? videos : [],
  };
  window.localStorage.setItem(FEED_CACHE_KEY, JSON.stringify(payload));
  return payload.videos.length;
}

function saveFeedCache(videos) {
  try {
    let trimmed = sortVideosByCreatedAtDesc(
      (videos || [])
        .map((video) => sanitizeCachedVideo(video))
        .filter(Boolean)
    );
    // תמיד חותכים למגבלה — מונע פיצוץ localStorage אחרי אלפי פוסטים | HYPER CORE TECH
    if (trimmed.length > FEED_CACHE_LIMIT) {
      console.log('[videos] feed cache trim to limit', {
        before: trimmed.length,
        after: FEED_CACHE_LIMIT,
      });
      trimmed = trimmed.slice(0, FEED_CACHE_LIMIT);
    }

    // הקטנה עד שנכנס בגודל סביר ל-localStorage | HYPER CORE TECH
    while (trimmed.length > FEED_CACHE_MIN_KEEP) {
      const sizeBytes = new Blob([JSON.stringify({ timestamp: Date.now(), videos: trimmed })]).size;
      if (sizeBytes <= FEED_CACHE_MAX_BYTES) break;
      const nextLen = Math.max(FEED_CACHE_MIN_KEEP, trimmed.length - FEED_CACHE_CLEANUP_BATCH);
      console.log('[videos] feed cache shrink for size', {
        sizeMB: Math.round(sizeBytes / 1024 / 1024 * 10) / 10,
        before: trimmed.length,
        after: nextLen,
      });
      trimmed = trimmed.slice(0, nextLen);
    }

    try {
      const kept = writeFeedCachePayload(trimmed);
      console.log('[videos] feed cache saved', { count: kept });
      return;
    } catch (err) {
      if (err?.name !== 'QuotaExceededError') throw err;
      console.warn('[videos] storage quota exceeded — shrinking feed cache');
    }

    // Quota: מצמצמים בהדרגה — בלי למחוק את כל הקאש | HYPER CORE TECH
    let keep = trimmed;
    while (keep.length > FEED_CACHE_MIN_KEEP) {
      keep = keep.slice(0, Math.max(FEED_CACHE_MIN_KEEP, Math.floor(keep.length * 0.6)));
      try {
        const kept = writeFeedCachePayload(keep);
        console.log('[videos] feed cache saved after quota shrink', { count: kept });
        return;
      } catch (err2) {
        if (err2?.name !== 'QuotaExceededError') throw err2;
      }
    }

    try {
      writeFeedCachePayload(keep.slice(0, FEED_CACHE_MIN_KEEP));
      console.log('[videos] feed cache saved minimal set', { count: Math.min(keep.length, FEED_CACHE_MIN_KEEP) });
    } catch (err3) {
      console.warn('[videos] feed cache save failed even minimal — keeping previous cache', err3);
      // לא מוחקים localStorage — עדיף ישן מאשר כלום | HYPER CORE TECH
    }
  } catch (err) {
    console.warn('[videos] failed saving feed cache', err);
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
    // סינון פוסטים מחוקים + מדיה מתה מהמטמון
    const app = window.NostrApp;
    const deletedIds = app?.deletedEventIds || new Set();
    const filtered = sortVideosByCreatedAtDesc(
      cached.filter((video) => video?.id
        && !deletedIds.has(video.id)
        && !isMediaUnavailable(video))
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
    // סנכרון דיסק אחרי סינון מחיקות — מונע skip של IDs "בקאש" שלא מוצגים | HYPER CORE TECH
    if (filtered.length !== cached.length) {
      try {
        saveFeedCache(filtered);
        console.log('[videos] feed cache synced after hydrate filter', {
          before: cached.length,
          after: filtered.length,
        });
      } catch (_) {}
    }
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
        // עדכון כפתורי לייק ותגובה אחרי שהנתונים נטענו | HYPER CORE TECH
        eventIds.forEach((id) => {
          updateVideoLikeButton(id);
          updateVideoCommentButton(id);
        });
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
  if (Array.isArray(state.ownPostsVideos)) {
    state.ownPostsVideos = state.ownPostsVideos.filter((video) => video && video.id !== eventId);
  }
  if (Array.isArray(state.liveTvVideos)) {
    state.liveTvVideos = state.liveTvVideos.filter((video) => video && video.id !== eventId);
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

// חלק מדיה מתה (videos.js) – הסרת כרטיסיה לגמרי כשהקובץ לא זמין (404) | HYPER CORE TECH
function handleCardMediaFailure(card, videoId, error) {
  const mediaDiv = card?.querySelector?.('.videos-feed__media') || null;
  const mediaType = mediaDiv?.dataset?.mediaType || '';
  const video = (Array.isArray(state.videos) && videoId)
    ? state.videos.find((v) => v.id === videoId)
    : null;
  const isFileMedia = mediaType === 'file'
    || !!(video?.videoUrl && !video?.youtubeId && !video?.liveUrl && !video?.gameUrl);

  console.warn('[videos] media failed — dropping card', {
    videoId,
    mediaType,
    isFileMedia,
    error: error?.message || error,
  });

  // רק קבצי וידאו מתים נכנסים ל־blacklist (לא יוטיוב/LIVE זמני) | HYPER CORE TECH
  if (isFileMedia && videoId) {
    markMediaUnavailable(videoId, video?.hash || null);
  }

  try {
    if (activeMediaDiv && mediaDiv && activeMediaDiv === mediaDiv) {
      activeMediaDiv = null;
    }
  } catch (_) {}

  if (card) {
    try { card.remove(); } catch (_) {}
  }
  if (videoId) {
    removeVideoCard(videoId);
    removeVideoFromState(videoId);
  }

  // ממשיכים לכרטיס הבא אם נפל הכרטיס שבמרכז | HYPER CORE TECH
  try {
    if (globalAutoplayEnabled && typeof autoPlayFirstVideo === 'function') {
      const viewport = document.querySelector('.videos-feed__viewport');
      const mid = viewport
        ? (viewport.scrollTop + viewport.clientHeight / 2)
        : 0;
      const cards = selectors.stream
        ? Array.from(selectors.stream.querySelectorAll('.videos-feed__card[data-event-id]'))
        : [];
      let best = null;
      let bestDist = Infinity;
      cards.forEach((c) => {
        const center = c.offsetTop + c.offsetHeight / 2;
        const dist = Math.abs(center - mid);
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      });
      const nextMedia = best?.querySelector('.videos-feed__media');
      if (nextMedia) {
        playMedia(nextMedia, { manual: false });
      }
    }
  } catch (_) {}
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
  if (video?.fromDeepLink || (video?.id && video.id === pendingPostDeepLinkId)) {
    try { enrichVideoMediaSources(video); } catch (_) {}
  }
  const existing = selectors.stream.querySelector(`.videos-feed__card[data-event-id="${video.id}"]`);
  if (existing) {
    existing.remove();
  }
  const { card, mediaReadyPromise } = renderVideoCard(video);

  // תמיד מציגים רק אחרי שהמדיה מוכנה — גם פוסט עצמי (בלי כרטיסיה ריקה) | HYPER CORE TECH
  mediaReadyPromise
    .then(() => {
      mountCard(card, { prepend: true });
      markCardMediaReady(card);
      if (forceShow) {
        try {
          const viewport = document.querySelector('.videos-feed__viewport');
          if (viewport) viewport.scrollTop = 0;
        } catch (_) {}
        requestAnimationFrame(() => {
          try { autoPlayFirstVideo(); } catch (__) {}
        });
      }
    })
    .catch((err) => {
      // מדיה מתה — לא מרכיבים כרטיסיה ריקה | HYPER CORE TECH
      handleCardMediaFailure(card, video.id, err);
    });
}

// חימום מדיה ברקע לפוסטים חדשים — בלי להציג כרטיסיה עד לחיצת בית | HYPER CORE TECH
const pendingWarmCards = new Map();

function queueNewPostForHomeReveal(video) {
  if (!video?.id) return;
  if (selectors.stream?.querySelector(`.videos-feed__card[data-event-id="${video.id}"]`)) {
    return;
  }
  pendingNewVideoIds.add(video.id);
  if (pendingWarmCards.has(video.id)) return;
  try {
    const { card, mediaReadyPromise } = renderVideoCard(video);
    pendingWarmCards.set(video.id, { card, mediaReadyPromise, video });
    mediaReadyPromise.catch((err) => {
      pendingWarmCards.delete(video.id);
      pendingNewVideoIds.delete(video.id);
      try { handleCardMediaFailure(card, video.id, err); } catch (_) {}
    });
    console.log('[videos] queued new post for Home reveal', { id: video.id });
  } catch (err) {
    console.warn('[videos] queueNewPostForHomeReveal failed', err);
  }
}

/**
 * הכנסת פוסט חדש לראש הפיד רק כשהמדיה מוכנה (בלי כרטיסיה ריקה).
 * משמר את מיקום הצפייה הנוכחי אם המשתמש לא בראש. | HYPER CORE TECH
 */
function prependNewFeedCardQuietly(video, options = {}) {
  if (!selectors.stream || !video?.id) return false;
  if (selectors.stream.querySelector(`.videos-feed__card[data-event-id="${video.id}"]`)) {
    return false;
  }

  const viewport = document.querySelector('.videos-feed__viewport');
  const anchorCard =
    getCenteredFeedCard() ||
    (activeMediaDiv && typeof activeMediaDiv.closest === 'function'
      ? activeMediaDiv.closest('.videos-feed__card[data-event-id]')
      : null);
  const anchorId = anchorCard?.getAttribute('data-event-id') || null;
  const userAtTop = !!(viewport && viewport.scrollTop < 24);
  const jumpToTop = !!options.forceShow;

  const warm = pendingWarmCards.get(video.id);
  pendingWarmCards.delete(video.id);
  const { card, mediaReadyPromise } = warm || renderVideoCard(video);

  mediaReadyPromise
    .then(() => {
      if (!selectors.stream) return;
      if (selectors.stream.querySelector(`.videos-feed__card[data-event-id="${video.id}"]`)) {
        return;
      }
      mountCard(card, { prepend: true });
      markCardMediaReady(card);

      if (jumpToTop) {
        try {
          if (viewport) viewport.scrollTop = 0;
        } catch (_) {}
        return;
      }

      // שומרים את הפוסט שהמשתמש צופה בו במרכז — החדשים מחכים מעליו | HYPER CORE TECH
      if (!userAtTop && anchorId) {
        const restoreAnchor = () => {
          if (!selectors.stream || !viewport) return;
          const anchor = selectors.stream.querySelector(`.videos-feed__card[data-event-id="${anchorId}"]`);
          if (!anchor) return;
          try {
            anchor.scrollIntoView({ block: 'start', behavior: 'auto' });
          } catch (_) {
            try { viewport.scrollTop = anchor.offsetTop; } catch (__) {}
          }
        };
        restoreAnchor();
        requestAnimationFrame(restoreAnchor);
        setTimeout(restoreAnchor, 50);
      }
    })
    .catch((err) => handleCardMediaFailure(card, video.id, err));

  console.log('[videos] quiet-prepend scheduled (wait media)', { id: video.id, anchorId, userAtTop });
  return true;
}

function upsertVideoInState(video, options = {}) {
  if (!video || !video.id) return;
  if (isMediaUnavailable(video)) {
    console.log('[videos] skip unavailable media post', { id: video.id });
    return;
  }
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
  else if (state.feedMode === 'live-tv' || state.feedMode === 'own-posts') showNow = false;
  else showNow = isGeneralFeedVideo(video);
  if (!showNow) return;

  // פוסט עצמי / immediate — מיד בראש (+ קפיצה אחרי מדיה מוכנה); אחרת חימום ברקע עד בית | HYPER CORE TECH
  if (options.forceShow || options.immediate) {
    prependVideoCard(video, options);
    return;
  }
  if (bootGate.released && state.firstCardRendered) {
    queueNewPostForHomeReveal(video);
    return;
  }
  prependVideoCard(video, options);
}

function hasWarmFeedContent() {
  if (Array.isArray(state.videos) && state.videos.length > 0) return true;
  try {
    return !!(selectors.stream && selectors.stream.querySelector('.videos-feed__card[data-event-id]'));
  } catch (_) {
    return false;
  }
}

// גיבוי: אם נשארו IDs ב־pending — מכניסים לראש רק כשהמדיה מוכנה | HYPER CORE TECH
async function applyPendingNewPostsToDom() {
  if (!selectors.stream) return 0;
  const ids = Array.from(pendingNewVideoIds);
  pendingNewVideoIds.clear();
  if (!ids.length) return 0;

  const videos = ids
    .map((id) => (Array.isArray(state.videos) ? state.videos.find((v) => v.id === id) : null))
    .filter((v) => v && isGeneralFeedVideo(v));
  const sorted = sortVideosByCreatedAtDesc(videos);
  let added = 0;
  // מהישן לחדש כדי שהחדש יישאר בראש אחרי prepend | HYPER CORE TECH
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const video = sorted[i];
    if (!video?.id) continue;
    if (selectors.stream.querySelector(`.videos-feed__card[data-event-id="${video.id}"]`)) {
      pendingWarmCards.delete(video.id);
      continue;
    }
    const warm = pendingWarmCards.get(video.id);
    pendingWarmCards.delete(video.id);
    try {
      const { card, mediaReadyPromise } = warm || renderVideoCard(video);
      await Promise.race([
        mediaReadyPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('pending-media-timeout')), 45000)),
      ]);
      if (!selectors.stream.querySelector(`.videos-feed__card[data-event-id="${video.id}"]`)) {
        mountCard(card, { prepend: true });
        markCardMediaReady(card);
        added += 1;
      }
    } catch (err) {
      console.warn('[videos] pending post skipped (media not ready)', { id: video.id, err: err?.message || err });
      if (warm?.card) {
        try { handleCardMediaFailure(warm.card, video.id, err); } catch (_) {}
      }
    }
  }
  if (added) {
    console.log('[videos] applied pending posts at top (media-ready)', { added });
  }
  return added;
}

// חלק עדכון בזמן אמת (videos.js) – המרת אירוע Nostr לפריט פיד וידאו | HYPER CORE TECH
function parseEventToVideoItem(event, currentApp) {
  if (!event || event.kind !== 1) return null;
  if (currentApp?.deletedEventIds?.has(event.id)) return null;
  if (isMediaUnavailable(event.id)) return null;

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

// חלק יאללה וידאו (videos.js) – טעינת מחיקות עם קאש לזיכרון (v2 = רק מחיקות מאושרות) | HYPER CORE TECH
const DELETIONS_CACHE_KEY = 'videos_deletions_cache_v2';
const DELETIONS_CACHE_TTL = 5 * 60 * 1000; // 5 דקות
let deletionsLoadedOnce = false;
try { window.localStorage.removeItem('videos_deletions_cache_v1'); } catch (_) {}

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

// חלק מחיקות (videos.js) – ממלא eventAuthorById מהקאש לפני סינון מחיקות | HYPER CORE TECH
function seedEventAuthorsFromFeedCache() {
  try {
    const app = window.NostrApp;
    if (!app) return;
    if (!(app.eventAuthorById instanceof Map)) app.eventAuthorById = new Map();
    const cached = loadFeedCache();
    if (!Array.isArray(cached) || !cached.length) return;
    let seeded = 0;
    cached.forEach((video) => {
      if (!video?.id || !video?.pubkey) return;
      const key = String(video.pubkey).toLowerCase();
      if (!app.eventAuthorById.has(video.id)) {
        app.eventAuthorById.set(video.id, key);
        seeded += 1;
      }
    });
    if (seeded) console.log('[videos] seeded event authors from feed cache', { seeded });
  } catch (err) {
    console.warn('[videos] seedEventAuthorsFromFeedCache failed', err);
  }
}

async function loadDeletionsFirst() {
  const app = window.NostrApp;
  
  // אם כבר נטענו מחיקות בסשן הזה - דלג
  if (deletionsLoadedOnce && app?.deletedEventIds?.size > 0) {
    console.log('[videos] deletions already loaded, skipping');
    return;
  }

  seedEventAuthorsFromFeedCache(); 
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
      deletionEvents.forEach((event) => {
        if (event && event.kind === 5 && typeof app.registerDeletion === 'function') {
          app.registerDeletion(event);
        }
      });
      // רק IDs ש־registerDeletion באמת קיבל (לא כל תגי e גולמיים) | HYPER CORE TECH
      const acceptedIds = app.deletedEventIds instanceof Set
        ? Array.from(app.deletedEventIds)
        : [];
      saveDeletionsToCache(acceptedIds);
      deletionsLoadedOnce = true;
      console.log('[videos] deletions loaded from network:', acceptedIds.length, {
        events: deletionEvents.length,
      });
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
  // כשצ'אט פתוח / deep-link – לא מציגים מסך טעינה מעל השיחה | HYPER CORE TECH
  try {
    const chatOpen = document.getElementById('chatPanel') && !document.getElementById('chatPanel').hasAttribute('hidden');
    const deeplink = document.documentElement.getAttribute('data-sos-deeplink') === '1'
      || document.body.classList.contains('sos-deeplink-chat');
    if (chatOpen || deeplink) {
      hideLoadingAnimation({ force: true });
      return;
    }
  } catch (_) {}
  const overlay = document.getElementById('videosLoadingOverlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.removeAttribute('hidden');
    overlay.setAttribute('aria-busy', 'true');
    overlay.setAttribute('aria-hidden', 'false');
    overlay.style.display = 'flex';
    // חייב על body – viewport עם contain שובר fixed | HYPER CORE TECH
    if (overlay.parentElement !== document.body) {
      document.body.appendChild(overlay);
    }
  }
  try { document.body.classList.add('videos-boot-loading'); } catch (_) {}
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
    overlay.setAttribute('aria-busy', 'false');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.display = 'none';
  }
  // סגירת LOADNUG כשהפיד מוכן | HYPER CORE TECH
  try {
    if (window.SOSLoadNug && typeof window.SOSLoadNug.signalReady === 'function') {
      window.SOSLoadNug.signalReady();
    }
  } catch (_) {}
}

function showSoftFeedLoading() {
  let el = document.getElementById('videosSoftLoading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'videosSoftLoading';
    el.className = 'videos-soft-loading';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', 'טוען');
    el.innerHTML = '<img class="videos-soft-loading__logo" src="./icons/sos-logo-mobile.png?v=20260731j" alt="SOS">';
    document.body.appendChild(el);
  } else if (el.parentElement !== document.body) {
    // viewport עם contain שובר position:fixed — חייב body | HYPER CORE TECH
    document.body.appendChild(el);
  }
  el.hidden = false;
  el.removeAttribute('hidden');
  el.setAttribute('aria-hidden', 'false');
  el.style.cssText = 'display:flex!important;position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:calc(56px + var(--safe-bottom, 0px))!important;z-index:2940!important;background:#000!important;align-items:center;justify-content:center;pointer-events:auto;';
}

function hideSoftFeedLoading() {
  const el = document.getElementById('videosSoftLoading');
  if (!el) return;
  el.hidden = true;
  el.setAttribute('hidden', '');
  el.setAttribute('aria-hidden', 'true');
  el.style.display = 'none';
}

function rearmBootGate(reason = 'rearm', { showSoft = false, holdMs = 0 } = {}) {
  bootGate.active = true;
  bootGate.released = false;
  bootGate.releasePromise = null;
  bootGate.holdUntil = holdMs > 0 ? (Date.now() + holdMs) : 0;
  console.log('[videos] boot gate rearmed:', reason, { showSoft, holdMs });
  try { document.body.classList.add('videos-boot-loading'); } catch (_) {}
  // חשוב לפני LoadNug.replay — אחרת MutationObserver סוגר מיד | HYPER CORE TECH
  showLoadingAnimation();
  if (showSoft) showSoftFeedLoading();
  else hideSoftFeedLoading();
  setLoadingStatus('מרענן...');
  setLoadingProgress(25);
  // עוצרים כל ניגון ברקע בזמן המסך | HYPER CORE TECH
  try {
    document.querySelectorAll('.videos-feed__media video').forEach((v) => {
      try { v.pause(); } catch (_) {}
    });
  } catch (_) {}
}

async function releaseBootLoading(reason = 'ready') {
  if (bootGate.released) return;
  // בלי השהיית hold מלאכותית — סוגרים כש־2 פוסטים מוכנים | HYPER CORE TECH
  bootGate.holdUntil = 0;
  bootGate.released = true;
  bootGate.active = false;
  console.log('[videos] boot loading released:', reason);
  setLoadingProgress(100);
  setLoadingStatus('הכל מוכן!');
  hideSoftFeedLoading();
  hideLoadingAnimation({ force: true });
  // מסירים videos-boot-loading רק אחרי fade של LoadNug — מונע הבזק נגן מתחת | HYPER CORE TECH
  const revealFeed = () => {
    try { document.body.classList.remove('videos-boot-loading'); } catch (_) {}
  };
  const skipLoadNugWait = reason === 'deeplink' || reason === 'url-deeplink' || hasCommunicationDeepLink();
  if (document.getElementById('sosLoadNugOverlay') && !skipLoadNugWait) {
    setTimeout(revealFeed, 800);
  } else {
    revealFeed();
  }
  if (selectors.status) {
    selectors.status.style.display = 'none';
  }
  try {
    const viewport = document.querySelector('.videos-feed__viewport');
    if (viewport) viewport.scrollTop = 0;
  } catch (_) {}
  // לא pause/seek לכל הווידאו — זה גורם למשטח ירוק ב־Android | HYPER CORE TECH
  // רק מאפסים את הכרטיס הראשון אם צריך, ואז play | HYPER CORE TECH
  try {
    const firstCard = selectors.stream?.querySelector('.videos-feed__card[data-event-id]');
    const firstVideo = firstCard?.querySelector('.videos-feed__media[data-media-type="file"] video');
    if (firstVideo && firstVideo.currentTime > 0.35) {
      try {
        if (typeof firstVideo.fastSeek === 'function') firstVideo.fastSeek(0);
        else firstVideo.currentTime = 0;
      } catch (_) {}
    }
  } catch (_) {}
  requestAnimationFrame(() => {
    autoPlayFirstVideo();
  });
}

// חלק Deep Link (videos.js) – משחרר מסך טעינה מיד כשפותחים שיחה מהתרעה | HYPER CORE TECH
function hasCommunicationDeepLink() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const chat = String(params.get('chat') || '').trim();
    const call = String(params.get('incomingCall') || '').trim();
    return (chat.length === 64) || !!call || document.documentElement.getAttribute('data-sos-deeplink') === '1';
  } catch (_) {
    return false;
  }
}

App.releaseBootForDeepLink = function releaseBootForDeepLink(reason = 'deeplink') {
  try {
    document.documentElement.setAttribute('data-sos-deeplink', '1');
    document.body.classList.add('sos-deeplink-chat');
  } catch (_) {}
  try {
    hideLoadingAnimation({ force: true });
  } catch (_) {}
  releaseBootLoading(reason || 'deeplink');
};

if (hasCommunicationDeepLink()) {
  try {
    document.documentElement.setAttribute('data-sos-deeplink', '1');
  } catch (_) {}
  setTimeout(() => {
    try { App.releaseBootForDeepLink('url-deeplink'); } catch (_) {}
  }, 50);
}

function restartOriginalLoadingScreen() {
  // מסך הטעינה המקורי (LoadNug) כמו בפתיחת הממשק | HYPER CORE TECH
  try {
    showLoadingAnimation();
    if (window.SOSLoadNug && typeof window.SOSLoadNug.replay === 'function') {
      window.SOSLoadNug.replay();
      console.log('[videos] LoadNug replay started');
      try {
        const viewport = document.querySelector('.videos-feed__viewport');
        if (viewport) viewport.scrollTop = 0;
      } catch (_) {}
      return true;
    }
  } catch (err) {
    console.warn('[videos] LoadNug replay failed', err);
  }
  return false;
}

let lastHomeSoftRefreshAt = 0;

// חלק רענון בית (videos.js) – חם: מיידי מהמטמון; קר: דף טעינה רק בלי תוכן | HYPER CORE TECH
async function softRefreshVideosFeed(options = {}) {
  clearHomeRefreshArm();
  const now = Date.now();
  if (now - lastHomeSoftRefreshAt < 700) {
    console.log('[videos] softRefresh debounced');
    return;
  }
  lastHomeSoftRefreshAt = now;
  const preferWarm = !!(options && (options.preferWarm || options.fromHome));
  console.log('[videos] softRefreshVideosFeed start', { preferWarm, version: VIDEOS_CODE_VERSION });
  try {
    if (typeof pauseAllFeedVideos === 'function') {
      pauseAllFeedVideos({ disableAutoplay: false });
    }
  } catch (_) {}

  const hasContent = hasWarmFeedContent() || !!(document.querySelector('.videos-feed__card[data-event-id]'));
  const warm = hasContent && (bootGate.released || state.firstCardRendered || preferWarm);

  if (warm || (preferWarm && hasContent)) {
    // הפעלה חמה: חדשים כבר בראש הפיד מהרקע — רק קפיצה למעלה + play | HYPER CORE TECH
    console.log('[videos] warm Home refresh (scroll-to-top)', {
      videos: state.videos.length,
      pendingLeftover: pendingNewVideoIds.size,
      preferWarm,
    });
    try {
      document.body.classList.remove('videos-boot-loading');
    } catch (_) {}
    hideSoftFeedLoading();
    hideLoadingAnimation({ force: true });
    bootGate.active = false;
    bootGate.released = true;
    bootGate.releasePromise = null;

    // גיבוי נדיר אם נשארו pending ישנים — רק כרטיסים עם מדיה מוכנה | HYPER CORE TECH
    try {
      await applyPendingNewPostsToDom();
    } catch (_) {}

    try {
      const viewport = document.querySelector('.videos-feed__viewport');
      if (viewport) viewport.scrollTop = 0;
    } catch (_) {}

    requestAnimationFrame(() => {
      autoPlayFirstVideo();
    });

    // חיפוש עדכונים ברקע — בלי לחסום / לקפוץ באמצע צפייה | HYPER CORE TECH
    loadVideos().catch((err) => console.warn('[videos] warm Home loadVideos failed', err));
    return;
  }

  // הפעלה קרה (אין פיד במכשיר) — דף טעינה עד הפוסט הראשון | HYPER CORE TECH
  // מבית עם תוכן — לא מגיעים לכאן | HYPER CORE TECH
  if (preferWarm) {
    console.warn('[videos] Home refresh skipped cold LoadNug — no content yet');
    return;
  }

  rearmBootGate('home-cold-refresh', { showSoft: false, holdMs: 0 });
  showLoadingAnimation();
  setLoadingStatus('טוען את הפיד...');
  setLoadingProgress(30);

  try {
    const viewport = document.querySelector('.videos-feed__viewport');
    if (viewport) viewport.scrollTop = 0;
  } catch (_) {}

  state.videos = sortVideosByCreatedAtDesc(Array.isArray(state.videos) ? state.videos : []);
  restartOriginalLoadingScreen();

  if (typeof forceFullFeedRerender === 'function') {
    forceFullFeedRerender();
  } else {
    renderVideos();
  }

  showLoadingAnimation();
  try {
    const viewport = document.querySelector('.videos-feed__viewport');
    if (viewport) viewport.scrollTop = 0;
  } catch (_) {}

  await ensureBootFeedReady();
  if (!bootGate.released) {
    await releaseBootLoading('soft-refresh-fallback');
  }

  loadVideos().catch((err) => console.warn('[videos] soft refresh loadVideos failed', err));
}

// חלק יאללה וידאו (videos.js) – עדכון מד טעינה והודעות סטטוס | HYPER CORE TECH
function setLoadingProgress(percent) {
  const clamped = Math.min(100, Math.max(0, Number(percent) || 0));
  const fill = document.getElementById('videosLoadingBarFill');
  if (fill) {
    fill.style.width = `${clamped}%`;
  }
  const pctEl = document.getElementById('videosLoadingPct');
  if (pctEl) {
    pctEl.textContent = `${Math.round(clamped)}%`;
  }
  // סנכרון ל־LoadNug (המד הויזואלי האמיתי) | HYPER CORE TECH
  try {
    const bar = document.querySelector('#sosLoadNugOverlay .sos-loadnug__bar');
    const pct = document.querySelector('#sosLoadNugOverlay .sos-loadnug__pct');
    const progress = document.querySelector('#sosLoadNugOverlay .sos-loadnug__progress');
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
    // פריים ראשון מספיק להצגה — לא מחכים להורדה מלאה / canplaythrough | HYPER CORE TECH
    if (videoEl.readyState >= 2 || (videoEl.videoWidth > 0 && videoEl.readyState >= 1)) {
      return true;
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        videoEl.removeEventListener('loadeddata', onOk);
        videoEl.removeEventListener('canplay', onOk);
        videoEl.removeEventListener('loadedmetadata', onOk);
        videoEl.removeEventListener('error', onErr);
        resolve(!!ok);
      };
      const onOk = () => done(true);
      const onErr = () => done(false);
      const poll = setInterval(() => {
        if (videoEl.readyState >= 2 || (videoEl.videoWidth > 0 && videoEl.readyState >= 1)) {
          done(true);
        }
      }, 100);
      const timer = setTimeout(() => done(false), BOOT_MEDIA_TIMEOUT_MS);
      videoEl.addEventListener('loadeddata', onOk, { once: true });
      videoEl.addEventListener('canplay', onOk, { once: true });
      videoEl.addEventListener('loadedmetadata', onOk, { once: true });
      videoEl.addEventListener('error', onErr, { once: true });
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

function removeVideoElFromDownloadQueue(videoEl) {
  if (!videoEl || !videoDownloadQueue.length) return;
  videoDownloadQueue = videoDownloadQueue.filter((item) => item.videoEl !== videoEl);
}

function revealVideoSurface(mediaDiv, videoEl) {
  if (!videoEl) return;
  try {
    if (mediaDiv) {
      mediaDiv.dataset.mediaPending = '0';
      applyDesktopVideoAspect(mediaDiv, videoEl);
    }
    videoEl.style.visibility = 'visible';
    videoEl.style.opacity = '1';
    videoEl.style.background = '#000';
  } catch (_) {}
}

function revealBootVideoFrame(video) {
  if (!video?.id || !selectors.stream) return;
  try {
    const card = selectors.stream.querySelector(`.videos-feed__card[data-event-id="${video.id}"]`);
    const mediaDiv = card?.querySelector('.videos-feed__media');
    const videoEl = mediaDiv?.querySelector('video');
    if (!videoEl) return;
    // ב־Android לא לחשוף משטח ירוק לפני playing | HYPER CORE TECH
    if (videoEl.readyState >= 2 && !videoEl.paused && videoEl.videoWidth > 0) {
      revealVideoSurface(mediaDiv, videoEl);
      return;
    }
    const onPlaying = () => revealVideoSurface(mediaDiv, videoEl);
    videoEl.addEventListener('playing', onPlaying, { once: true });
    // גיבוי אם כבר יש פריים בלי playing | HYPER CORE TECH
    if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
      revealVideoSurface(mediaDiv, videoEl);
    }
  } catch (_) {}
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
  const commentCount = getVisibleCommentCount(video.id);
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
      tasks.push(app.fetchProfile(pubkey).catch(() => null));
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

/**
 * טעינה מהירה לבוט: קודם IndexedDB בלבד (בלי P2P/tiers), במקביל ל־2 הפוסטים הראשונים | HYPER CORE TECH
 */
async function attachBootVideoFromCache(video) {
  if (!video?.id) return false;
  const App = window.NostrApp || {};
  const card = await waitForFeedCard(video.id, 12000);
  if (!card) return false;
  const mediaDiv = card.querySelector('.videos-feed__media');
  if (!mediaDiv) return false;
  const type = mediaDiv.dataset.mediaType || '';

  if (type !== 'file') {
    return waitForPostMediaPlayable(video);
  }

  const videoEl = mediaDiv.querySelector('video');
  if (!videoEl) return false;
  removeVideoElFromDownloadQueue(videoEl);

  // deep-link לאורח: URL/Blossom לפני קאש ריק | HYPER CORE TECH
  const isDeep = !!(video.fromDeepLink || (pendingPostDeepLinkId && video.id === pendingPostDeepLinkId));
  if (isDeep) {
    const okDeep = await prioritizeDeepLinkMedia(video);
    if (okDeep) return true;
  }

  let attached = false;
  if (video.hash && typeof App.getCachedMedia === 'function') {
    try {
      attached = await tryAttachVideoFromLocalCache(videoEl, video.hash);
      if (attached) {
        console.log('[videos] boot fast-cache hit', { id: video.id });
      }
    } catch (err) {
      console.warn('[videos] boot getCachedMedia failed', err);
    }
  }

  if (!attached && typeof App.loadVideoWithCache === 'function') {
    try {
      const result = await App.loadVideoWithCache(
        videoEl,
        video.videoUrl,
        video.hash || '',
        video.mirrors || []
      );
      attached = !!(result && result.success !== false && (videoEl.src || videoEl.currentSrc));
    } catch (err) {
      console.warn('[videos] boot loadVideoWithCache failed', err);
    }
  }

  if (!attached && video.videoUrl) {
    try {
      videoEl.src = video.videoUrl;
      videoEl.load();
      attached = true;
    } catch (_) {}
  }

  const ok = await waitForPostMediaPlayable(video);
  if (ok) revealBootVideoFrame(video);
  return ok;
}

// חלק טעינה (videos.js) – סגירת LoadNug רק אחרי ש־2 פוסטים מוכנים לצפייה | HYPER CORE TECH
async function ensureBootFeedReady() {
  // בית בלי שיחות — לא מדלגים על attach מקאש בגלל pause תקוע | HYPER CORE TECH
  syncFeedWarmupPauseWithChat('boot');
  if (bootGate.released) return;
  if (bootGate.releasePromise) return bootGate.releasePromise;

  bootGate.releasePromise = (async () => {
    showLoadingAnimation();
    setLoadingStatus('מכין את הפוסטים הראשונים...');
    setLoadingProgress(50);

    const posts = getDisplayVideos().slice(0, BOOT_READY_POST_COUNT);
    if (!posts.length) {
      console.log('[videos] boot gate: no posts yet');
      bootGate.releasePromise = null;
      return;
    }

    await Promise.all(posts.map((p) => waitForFeedCard(p.id, 15000)));
    await sleepMs(30);

    // עוצרים את התור הסדרתי בזמן טעינת 2 הראשונים מהקאש | HYPER CORE TECH
    const prevPaused = feedDownloadsPaused;
    feedDownloadsPaused = true;
    posts.forEach((p) => {
      try {
        const card = selectors.stream?.querySelector(`.videos-feed__card[data-event-id="${p.id}"]`);
        const el = card?.querySelector('video');
        if (el) removeVideoElFromDownloadQueue(el);
      } catch (_) {}
    });

    setLoadingStatus(`טוען ${posts.length} פוסטים ראשונים מהקאש...`);
    setLoadingProgress(60);

    // בשיחות — עוצרים attach מהקאש לגמרי (עומס מכשיר); loadVideos ממשיך ברקע | HYPER CORE TECH
    try {
      if (typeof App.retryMediaCacheOpen === 'function' && !feedWarmupPaused) {
        await App.retryMediaCacheOpen();
      }
    } catch (_) {}

    const mediaResults = [];
    for (let index = 0; index < posts.length; index++) {
      const video = posts[index];
      if (feedWarmupPaused) {
        console.log('[videos] boot media deferred (chat open)', { id: video.id });
        mediaResults.push(false);
        setLoadingProgress(60 + ((index + 1) / posts.length) * 30);
        continue;
      }
      if (bootGate.released) {
        console.log('[videos] boot media skipped — already released / deeplink');
        break;
      }
      const ok = await attachBootVideoFromCache(video);
      mediaResults.push(ok);
      setLoadingProgress(60 + ((index + 1) / posts.length) * 30);
      console.log('[videos] boot media', {
        id: video.id,
        ok,
        type: video.youtubeId ? 'youtube' : (video.videoUrl ? 'file' : 'other'),
      });
    }

    feedDownloadsPaused = prevPaused;
    try {
      if (!isFeedHeavyWorkPaused()) processVideoDownloadQueue();
    } catch (_) {}

    if (bootGate.released) {
      bootGate.releasePromise = null;
      return;
    }

    const readyCount = mediaResults.filter(Boolean).length;
    const need = Math.min(BOOT_READY_POST_COUNT, posts.length);
    // לא משחררים על פוסט אחד — רק כשיש 2 מוכנים (או כל מה שיש אם פחות מ־2) | HYPER CORE TECH
    if (readyCount >= need) {
      await releaseBootLoading(`boot-ready media=${readyCount}/${need}`);
    } else {
      console.warn('[videos] boot: waiting longer for 2 ready posts', { readyCount, need });
      const deadline = Date.now() + 12000;
      let finalReady = readyCount;
      while (Date.now() < deadline && finalReady < need) {
        if (bootGate.released) break;
        // בזמן שיחות לא מעמיסים attach — ממתינים לסגירה או ל־timeout | HYPER CORE TECH
        if (feedWarmupPaused) {
          await sleepMs(400);
          continue;
        }
        await sleepMs(400);
        const recheck = await Promise.all(posts.map((p) => waitForPostMediaPlayable(p)));
        finalReady = recheck.filter(Boolean).length;
        if (finalReady >= need) break;
      }
      if (finalReady >= need) {
        posts.forEach((p) => revealBootVideoFrame(p));
        await releaseBootLoading(`boot-ready-retry media=${finalReady}/${need}`);
      } else {
        console.warn('[videos] boot: still short — safety release', { finalReady, need });
        posts.forEach((p) => revealBootVideoFrame(p));
        await releaseBootLoading(`boot-safety media=${finalReady}/${need}`);
      }
    }

    loadBootMetaForPosts(posts).catch((err) => {
      console.warn('[videos] boot meta after release failed', err);
    });
  })().catch(async (err) => {
    console.warn('[videos] ensureBootFeedReady failed', err);
    try { feedDownloadsPaused = false; } catch (_) {}
    await releaseBootLoading('boot-error-fallback');
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

    // LIVE בדסקטופ — ברירת מחדל 16:9; מתעדכן כשיש metadata | HYPER CORE TECH
    try { applyDesktopVideoAspect(mediaDiv, 16, 9); } catch (_) {}
    videoEl.addEventListener('loadedmetadata', () => {
      try { applyDesktopVideoAspect(mediaDiv, videoEl); } catch (_) {}
    });

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
  } else if (video.p2pLive) {
    // שידור חי P2P מהמשתמשים – כרטיס רגיל בפיד עם אותן פעולות צד | HYPER CORE TECH
    mediaDiv.dataset.mediaType = 'p2p-live';
    mediaDiv.dataset.liveOwner = video.p2pLiveOwner || video.pubkey || '';
    mediaDiv.dataset.liveSlug = video.p2pLiveSlug || 'live';
    mediaDiv.dataset.liveRoomId = video.p2pLiveRoomId || video.id || '';
    if (video.content) mediaDiv.dataset.liveTitle = String(video.content);

    const videoEl = document.createElement('video');
    videoEl.controls = false;
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.autoplay = false;
    videoEl.setAttribute('playsinline', 'true');
    videoEl.setAttribute('webkit-playsinline', 'true');
    videoEl.className = 'videos-feed__media-video';
    mediaDiv.appendChild(videoEl);

    // מצמידים סטרים מאומת מראש — בלי כרטיס ריק | HYPER CORE TECH
    try {
      const pendingMap = (window.NostrApp && window.NostrApp._p2pLivePendingStreams) || null;
      const pendingStream = pendingMap && pendingMap.get(video.id);
      if (pendingStream) {
        videoEl.srcObject = pendingStream;
        videoEl.muted = false;
        mediaDiv.dataset.p2pLiveJoined = '1';
        mediaDiv.classList.add('videos-feed__media--ready');
        try { videoEl.play().catch(() => {}); } catch (_) {}
      }
    } catch (_) {}

    try { applyDesktopVideoAspect(mediaDiv, 9, 16); } catch (_) {}

    const badge = document.createElement('div');
    badge.className = 'videos-p2p-live-badge';
    badge.innerHTML = '<span class="videos-p2p-live-badge__dot" aria-hidden="true"></span><span>LIVE</span>';
    mediaDiv.appendChild(badge);

    const hint = document.createElement('div');
    hint.className = 'videos-p2p-live-hint';
    hint.textContent = 'מתחבר לשידור חי…';
    if (videoEl.srcObject) hint.hidden = true;
    mediaDiv.appendChild(hint);

    const playOverlay = document.createElement('button');
    playOverlay.type = 'button';
    playOverlay.className = 'videos-feed__play-overlay';
    playOverlay.setAttribute('aria-label', 'Play live');
    playOverlay.setAttribute('data-play-toggle', '');
    playOverlay.innerHTML = '<i class="fa-solid fa-play"></i>';
    playOverlay.hidden = true;
    playOverlay.style.display = 'none';
    centerPlayOverlayButton(playOverlay);
    mediaDiv.appendChild(playOverlay);

    queueMicrotask(markReady);
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

    // YouTube בדסקטופ — בדרך כלל 16:9 (מובייל לא מושפע מ־--video-ar) | HYPER CORE TECH
    try { applyDesktopVideoAspect(mediaDiv, 16, 9); } catch (_) {}
    queueMicrotask(markReady);
  } else if (video.videoUrl || video.hash || video.fromDeepLink) {
    if (video.fromDeepLink || (typeof pendingPostDeepLinkId === 'string' && video.id === pendingPostDeepLinkId)) {
      try { enrichVideoMediaSources(video); } catch (_) {}
    }
    if (!video.videoUrl && video.hash) {
      try { enrichVideoMediaSources(video); } catch (_) {}
    }
    if (!video.videoUrl) {
      // אין מקור מדיה — נכשל מיד | HYPER CORE TECH
      queueMicrotask(() => failReady(new Error('no-media-url')));
      mediaDiv.dataset.mediaType = 'file';
    } else {
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
    // מוסתר עד playing — מונע משטח ירוק של MediaCodec ב־Android | HYPER CORE TECH
    mediaDiv.dataset.mediaPending = '1';
    videoEl.style.opacity = '0';
    videoEl.style.visibility = 'hidden';
    videoEl.style.background = '#000';
    // poster שחור בלבד בזמן טעינה — תמונה/ירוק לא יוצגו לפני פריים | HYPER CORE TECH
    videoEl.poster = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGD4DwABBAEAgLvRWwAAAABJRU5ErkJggg==';
    if (typeof video.imageUrl === 'string' && video.imageUrl) {
      videoEl.dataset.posterUrl = video.imageUrl;
    }
    mediaDiv.appendChild(videoEl);

    const cleanup = () => {
      videoEl.removeEventListener('loadeddata', onLoadedData);
      videoEl.removeEventListener('loadedmetadata', onLoadedMeta);
      videoEl.removeEventListener('error', onError);
    };

    let readySettled = false;
    const settleReady = () => {
      if (readySettled) return;
      readySettled = true;
      markReady();
    };

    const onLoadedMeta = () => {
      try { applyDesktopVideoAspect(mediaDiv, videoEl); } catch (_) {}
    };

    const onLoadedData = () => {
      cleanup();
      settleReady();
      try { applyDesktopVideoAspect(mediaDiv, videoEl); } catch (_) {}
      // לא חושפים משטח ירוק ב־loadeddata — רק ב־playing / פריים אמיתי | HYPER CORE TECH
      const bootActive = document.body.classList.contains('videos-boot-loading')
        || (bootGate.active && !bootGate.released);
      if (!bootActive && videoEl.readyState >= 2 && videoEl.videoWidth > 0 && !videoEl.paused) {
        revealVideoSurface(mediaDiv, videoEl);
      } else {
        const onPlaying = () => revealVideoSurface(mediaDiv, videoEl);
        videoEl.addEventListener('playing', onPlaying, { once: true });
        // במצב STOP עם פריים מוכן — אפשר לחשוף בזהירות | HYPER CORE TECH
        if (!globalAutoplayEnabled && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
          revealVideoSurface(mediaDiv, videoEl);
        }
      }
      try {
        const ov = mediaDiv.querySelector('.videos-feed__play-overlay');
        if (ov && !document.body.classList.contains('videos-boot-loading')) {
          ov.hidden = false;
          ov.style.removeProperty('display');
          ov.style.removeProperty('opacity');
        }
      } catch (_) {}
      if (!globalAutoplayEnabled) {
        ensurePausedPreviewFrame(videoEl);
      }
    };

    const deepLinkMode = !!(video.fromDeepLink || (typeof pendingPostDeepLinkId === 'string' && video.id === pendingPostDeepLinkId));
    const mediaCandidates = deepLinkMode
      ? getVideoMediaCandidates(video)
      : [];
    let candidateIndex = 0;

    const onError = (event) => {
      // deep-link: מנסים mirror הבא לפני כשל סופי | HYPER CORE TECH
      if (deepLinkMode && candidateIndex < mediaCandidates.length - 1) {
        candidateIndex += 1;
        const nextUrl = mediaCandidates[candidateIndex];
        console.warn('[videos] deep-link mirror failed — trying next', {
          id: video.id,
          index: candidateIndex,
          host: (() => { try { return new URL(nextUrl).host; } catch (_) { return ''; } })(),
        });
        try {
          video.videoUrl = nextUrl;
          mediaDiv.dataset.videoUrl = nextUrl;
          videoEl.src = nextUrl;
          videoEl.load();
          videoEl.addEventListener('error', onError, { once: true });
        } catch (_) {
          cleanup();
          if (!readySettled) {
            failReady(event?.error || new Error('video load error'));
            readySettled = true;
          }
        }
        return;
      }
      cleanup();
      if (!readySettled) {
        failReady(event?.error || new Error('video load error'));
        readySettled = true;
      } else {
        handleCardMediaFailure(article, video.id, event?.error || new Error('video load error'));
      }
    };

    videoEl.addEventListener('loadedmetadata', onLoadedMeta);
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

    if (deepLinkMode && mediaCandidates.length) {
      // טעינה מיידית על אלמנט מנותק — בלי לחכות ל־mount / תור | HYPER CORE TECH
      console.log('[videos] deep-link direct candidates', {
        id: video.id,
        count: mediaCandidates.length,
        first: mediaCandidates[0],
      });
      video.videoUrl = mediaCandidates[0];
      mediaDiv.dataset.videoUrl = mediaCandidates[0];
      videoEl.src = mediaCandidates[0];
      videoEl.load();
    } else {
      // הוספה לתור הסדרתי במקום טעינה ישירה
      addToVideoDownloadQueue(videoEl, video.videoUrl, video.hash || '', video.mirrors || [], applyFallbackSrc);
    }

    // מוכן רק אחרי loadeddata — לא מציגים כרטיסיה ריקה לפני שהווידאו ירד | HYPER CORE TECH
    // (בעבר היה settleReady מיידי כדי לשמור סדר מול יוטיוב; עכשיו mount ממתין ל־mediaReady בסדר הרשימה)

    // רקע שחור בזמן טעינה — בלי כפתור פליי ענק על אפור | HYPER CORE TECH
    mediaDiv.style.background = '#000';
    videoEl.style.background = '#000';

    const playOverlay = document.createElement('button');
    playOverlay.type = 'button';
    playOverlay.className = 'videos-feed__play-overlay';
    playOverlay.setAttribute('aria-label', 'Play video');
    playOverlay.setAttribute('data-play-toggle', '');
    playOverlay.innerHTML = '<i class="fa-solid fa-play"></i>';
    playOverlay.hidden = true;
    playOverlay.style.display = 'none';
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
    } // end else has videoUrl
    
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
  const commentCount = getVisibleCommentCount(video.id);
  const shareCount = currentApp.sharesByEventId?.get(video.id)?.size || 0;

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
      <span class="videos-feed__action-count feed-post__share-count" data-share-count="${video.id}" style="${shareCount > 0 ? '' : 'display:none'}">${shareCount > 0 ? shareCount : ''}</span>
    </button>
  `);

  // תגובות + לייקים לשידור חי P2P — מגיעים לסטודיו של המשדר | HYPER CORE TECH
  if (video.p2pLive && video.p2pLiveRoomId) {
    const commentBtn = actionsDiv.querySelector('[data-comment-button]');
    if (commentBtn) {
      commentBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const LiveApp = window.NostrApp || {};
        if (typeof LiveApp.requireAuth === 'function' && !LiveApp.requireAuth('כדי לכתוב בשידור חי צריך להתחבר.')) {
          return;
        }
        const text = window.prompt('כתוב תגובה לשידור החי:');
        if (!text || !String(text).trim()) return;
        if (typeof LiveApp.publishLiveChat === 'function') {
          LiveApp.publishLiveChat(video.p2pLiveRoomId, text);
        }
      }, true);
    }
    const likeBtn = actionsDiv.querySelector('[data-like-button]');
    if (likeBtn) {
      likeBtn.addEventListener('click', () => {
        const LiveApp = window.NostrApp || {};
        if (typeof LiveApp.publishLiveLike === 'function') {
          LiveApp.publishLiveLike(video.p2pLiveRoomId);
        }
      }, true);
    }
  }

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
    // LoadNug הוא דף מלא על body — לא מוחקים/מעבירים אותו ל־stream | HYPER CORE TECH
    selectors.stream.innerHTML = '';
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
        : (state.feedMode === 'live-tv'
          ? 'אין ערוצים להצגה'
          : (state.feedMode === 'own-posts' ? 'אין פוסטים להצגה' : 'אין סרטונים להצגה'))
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
      : (state.feedMode === 'live-tv'
        ? 'טוען ערוצים...'
        : (state.feedMode === 'own-posts' ? 'טוען את הפוסטים שלך...' : 'טוען סרטונים...'));
    selectors.status.style.display = 'block';
  }

  setupIntersectionObserver();
  setupLoadMoreObserver();
  setupLikeUpdateListener();
  setupShareUpdateListener();
  setupCommentsChangedListener();
  setupCommentsAutoClose();

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

// חלק יאללה וידאו (videos.js) – הוספת קלף לפיד רק כשהמדיה מוכנה, ובסדר הרשימה | HYPER CORE TECH
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
  controller.nextIndex += 1;

  if (!video?.id || isMediaUnavailable(video)) {
    if (controller.nextIndex >= videos.length) {
      finalizeIncrementalRender();
      return;
    }
    controller.timer = setTimeout(appendNextVideoCard, 0);
    return;
  }

  const { card, mediaReadyPromise } = renderVideoCard(video);
  const MEDIA_WAIT_MS = 60000;
  const waitPromise = Promise.race([
    mediaReadyPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('media-ready-timeout')), MEDIA_WAIT_MS);
    }),
  ]);

  const continueNext = () => {
    if (controller.cancelled) return;
    preloadNextMedia(videos[controller.nextIndex]);
    if (controller.nextIndex >= videos.length) {
      finalizeIncrementalRender();
      return;
    }
    controller.timer = setTimeout(appendNextVideoCard, 0);
  };

  // רק אחרי שהווידאו באמת מוכן — מרכיבים ל־DOM (בלי כרטיסיות ריקות) | HYPER CORE TECH
  waitPromise
    .then(() => {
      if (controller.cancelled) return;
      mountCard(card);
      markCardMediaReady(card);
      continueNext();
    })
    .catch((err) => {
      handleCardMediaFailure(card, video.id, err);
      continueNext();
    });
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

  // במצב משחקים / LIVE TV / פוסטים שלי – הפעלה מיידית של הכרטיס הנראה | HYPER CORE TECH
  if (state.feedMode === 'games' || state.feedMode === 'live-tv' || state.feedMode === 'own-posts') {
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
      } else if (state.feedMode === 'live-tv') {
        globalAutoplayEnabled = true;
        updateGlobalStopClass();
        const mediaDiv = active?.querySelector('.videos-feed__media[data-media-type="hls-live"]');
        if (mediaDiv) playHlsLiveMedia(mediaDiv);
        if (active) prefetchNeighborLiveChannels(active);
      } else if (active) {
        globalAutoplayEnabled = true;
        updateGlobalStopClass();
        const gameDiv = active.querySelector('.videos-feed__media[data-media-type="game-embed"]');
        const liveDiv = active.querySelector('.videos-feed__media[data-media-type="hls-live"]');
        if (gameDiv) playGameEmbedMedia(gameDiv);
        else if (liveDiv) playHlsLiveMedia(liveDiv);
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

function getVisibleCommentCount(eventId) {
  if (!eventId) return 0;
  const app = window.NostrApp;
  if (typeof app?.listVisibleComments === 'function') {
    return (app.listVisibleComments(eventId) || []).length;
  }
  const commentMap = app?.commentsByParent?.get(eventId);
  if (!(commentMap instanceof Map)) return 0;
  const deleted = app?.deletedEventIds instanceof Set ? app.deletedEventIds : null;
  let count = 0;
  commentMap.forEach((_, id) => {
    if (deleted && deleted.has(id)) return;
    count += 1;
  });
  return count;
}

// חלק יאללה וידאו (videos.js) – עדכון כפתור תגובות בדף הווידאו
function updateVideoCommentButton(eventId) {
  if (!eventId) return;
  const button = document.querySelector(`button[data-comment-button][data-event-id="${eventId}"]`);
  if (!button) return;

  const count = getVisibleCommentCount(eventId);
  const counterEl = button.querySelector('.feed-post__comment-count') ||
    button.querySelector('.videos-feed__action-count');
  
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

function updateVideoShareButton(eventId) {
  if (!eventId) return;
  const button = document.querySelector(`button[data-share-button][data-event-id="${eventId}"]`);
  if (!button) return;
  const app = window.NostrApp;
  const shareSet = app?.sharesByEventId?.get(eventId);
  const count = shareSet ? shareSet.size : 0;
  const counterEl = button.querySelector('.feed-post__share-count')
    || button.querySelector('[data-share-count]')
    || button.querySelector('.videos-feed__action-count');
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

function bumpSharedVideoToTop(eventId, shareEvent = null) {
  const id = String(eventId || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/i.test(id)) return false;
  const app = window.NostrApp || {};
  const shareAt = Number(shareEvent?.created_at) || Math.floor(Date.now() / 1000);
  try {
    if (!(app.latestShareAtByEventId instanceof Map)) app.latestShareAtByEventId = new Map();
    const prev = Number(app.latestShareAtByEventId.get(id)) || 0;
    if (shareAt > prev) app.latestShareAtByEventId.set(id, shareAt);
  } catch (_) {}

  let video = Array.isArray(state.videos) ? state.videos.find((v) => v && v.id === id) : null;
  if (!video && app.postsById instanceof Map) {
    const ev = app.postsById.get(id);
    if (ev) video = parseEventToVideoItem(ev, app);
  }
  if (!video) return false;
  video.boostedAt = Math.max(Number(video.boostedAt) || 0, shareAt);
  upsertVideoInState(video, { forceShow: true, immediate: true });
  updateVideoShareButton(id);
  try {
    state.videos = sortVideosByCreatedAtDesc(state.videos);
    syncFeedDomOrder(getDisplayVideos());
  } catch (_) {}
  const tryScroll = () => {
    const card = selectors.stream?.querySelector(`.videos-feed__card[data-event-id="${id}"]`);
    if (!card) return false;
    try { card.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) {}
    return true;
  };
  if (!tryScroll()) {
    setTimeout(tryScroll, 300);
    setTimeout(tryScroll, 900);
  }
  return true;
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

function setupShareUpdateListener() {
  const app = window.NostrApp || {};
  if (typeof app.registerShare === 'function' && !app._videosShareHooked) {
    app._videosShareHooked = true;
    const original = app.registerShare;
    app.registerShare = function(event) {
      const result = original.call(this, event);
      if (event && Array.isArray(event.tags)) {
        event.tags.forEach((tag) => {
          if (Array.isArray(tag) && tag[0] === 'e' && tag[1]) {
            setTimeout(() => updateVideoShareButton(tag[1]), 40);
          }
        });
      }
      return result;
    };
  }
  app.onFeedPostShared = function onFeedPostShared(eventId, event) {
    bumpSharedVideoToTop(eventId, event);
    updateVideoShareButton(eventId);
  };
  if (!window.__sosShareBumpBound) {
    window.__sosShareBumpBound = true;
    window.addEventListener('sos-feed-post-shared', (ev) => {
      const eventId = ev?.detail?.eventId;
      if (eventId) bumpSharedVideoToTop(eventId, ev.detail?.event || null);
    });
  }
}

// חלק תגובות (videos.js) – רענון פאנל/מונה כשמחיקה או עדכון מגיעים מ-feed.js | HYPER CORE TECH
function setupCommentsChangedListener() {
  if (window.__sosCommentsChangedWired) return;
  window.__sosCommentsChangedWired = true;
  window.addEventListener('sos:comments-changed', (evt) => {
    const parentId = evt?.detail?.parentId;
    if (!parentId) return;
    try {
      updateVideoCommentButton(parentId);
    } catch (_) {}
    const overlay = document.querySelector('.videos-comments-overlay');
    if (!overlay) return;
    const openId = overlay.dataset?.eventId || document.getElementById('videoCommentsList')?.dataset?.parentId;
    if (openId && openId === parentId) {
      loadCommentsForPost(parentId).catch(() => {});
    }
  });
}

// חלק יאללה וידאו (videos.js) – פתיחת פאנל תגובות בסגנון טיקטוק
function isCommentsPanelOpen() {
  try {
    if (document.body.classList.contains('videos-comments-open')) return true;
  } catch (_) {}
  return !!document.querySelector('.videos-comments-overlay');
}

function getOpenCommentsEventId() {
  try {
    return document.querySelector('.videos-comments-overlay')?.dataset?.eventId || null;
  } catch (_) {
    return null;
  }
}

function clearDesktopCommentsVideoLayout() {
  try {
    document.querySelectorAll('.videos-feed__media[data-comments-sized="1"]').forEach((media) => {
      media.style.removeProperty('width');
      media.style.removeProperty('height');
      media.style.removeProperty('max-width');
      media.style.removeProperty('max-height');
      media.style.removeProperty('min-width');
      media.style.removeProperty('align-self');
      media.style.removeProperty('transform');
      media.style.removeProperty('margin-top');
      delete media.dataset.commentsSized;
    });
    document.querySelectorAll('.videos-feed__card[data-comments-sized="1"]').forEach((card) => {
      card.style.removeProperty('align-items');
      card.style.removeProperty('padding-bottom');
      delete card.dataset.commentsSized;
    });
    document.querySelectorAll('.videos-feed__actions[data-comments-sized="1"]').forEach((actions) => {
      actions.style.removeProperty('align-self');
      actions.style.removeProperty('transform');
      actions.style.removeProperty('padding-top');
      actions.style.removeProperty('padding-bottom');
      actions.style.removeProperty('justify-content');
      actions.style.removeProperty('height');
      actions.style.removeProperty('margin-top');
      delete actions.dataset.commentsSized;
    });
    const feed = document.querySelector('.videos-feed');
    feed?.style?.removeProperty('--videos-desktop-feed-shift');
  } catch (_) {}
}

/** דסקטופ: כופים גודל וידאו למסגרת הפנויה בין תגובות לתפריט + מרכוז אנכי | HYPER CORE TECH */
function syncDesktopCommentsVideoLayout() {
  try {
    if (typeof window.matchMedia === 'function' && !window.matchMedia('(min-width: 769px)').matches) {
      clearDesktopCommentsVideoLayout();
      return;
    }
    if (!document.body.classList.contains('videos-comments-open')) {
      clearDesktopCommentsVideoLayout();
      return;
    }

    const card = getCenteredFeedCard();
    const media = card?.querySelector?.('.videos-feed__media');
    if (!media || !card) return;

    const panel = document.querySelector('.videos-comments-panel');
    const nav = document.querySelector('body:has(.videos-feed) .primary-nav, .primary-nav');
    const panelRight = panel ? Math.ceil(panel.getBoundingClientRect().right) : 424;
    const navLeft = nav ? Math.floor(nav.getBoundingClientRect().left) : (window.innerWidth - 220);
    const actions = card.querySelector('.videos-feed__actions');
    // רוחב עמודת פעולות קבוע בדסקטופ (גם אם translateY משנה את ה-rect) | HYPER CORE TECH
    const actionsW = 76;
    const gap = 24;

    const maxW = Math.max(260, Math.floor(navLeft - panelRight - actionsW - gap));
    const maxH = Math.max(220, Math.floor(window.innerHeight - 32));

    let ar = parseFloat(card.style.getPropertyValue('--video-ar'))
      || parseFloat(media.style.getPropertyValue('--video-ar'))
      || 0;
    if (!Number.isFinite(ar) || ar <= 0) {
      const v = media.querySelector('video');
      if (v && v.videoWidth > 1 && v.videoHeight > 1) ar = v.videoWidth / v.videoHeight;
      else ar = 16 / 9;
    }

    let w = maxW;
    let h = w / ar;
    if (h > maxH) {
      h = maxH;
      w = h * ar;
    }
    w = Math.max(200, Math.round(w));
    h = Math.max(160, Math.round(h));

    // כפיית מרכוז אנכי בכרטיס (flex-end ברירת מחדל דוחף למטה בווידאו רחב) | HYPER CORE TECH
    card.style.setProperty('align-items', 'center', 'important');
    card.style.setProperty('padding-bottom', '0px', 'important');
    card.dataset.commentsSized = '1';

    media.style.setProperty('width', `${w}px`, 'important');
    media.style.setProperty('height', `${h}px`, 'important');
    media.style.setProperty('max-width', `${w}px`, 'important');
    media.style.setProperty('max-height', `${h}px`, 'important');
    media.style.setProperty('min-width', '0px', 'important');
    media.style.setProperty('align-self', 'center', 'important');
    media.style.removeProperty('transform');
    media.dataset.commentsSized = '1';

    if (actions) {
      actions.style.setProperty('align-self', 'center', 'important');
      actions.style.setProperty('transform', 'none', 'important');
      actions.style.setProperty('padding-top', '0px', 'important');
      actions.style.setProperty('padding-bottom', '0px', 'important');
      actions.style.setProperty('justify-content', 'center', 'important');
      actions.style.setProperty('height', 'auto', 'important');
      actions.dataset.commentsSized = '1';
    }

    // מרכוז אופקי במרחב הפנוי בין פאנל התגובות לתפריט | HYPER CORE TECH
    const freeCenter = (panelRight + navLeft) / 2;
    const viewportCenter = window.innerWidth / 2;
    const shift = Math.round(freeCenter - viewportCenter);
    const feed = document.querySelector('.videos-feed');
    feed?.style?.setProperty('--videos-desktop-feed-shift', `${shift}px`);

    // תיקון אנכי מדויק מול חלון התצוגה (16:9 וכו') | HYPER CORE TECH
    requestAnimationFrame(() => {
      try {
        if (!document.body.classList.contains('videos-comments-open')) return;
        if (!media.isConnected) return;
        const rect = media.getBoundingClientRect();
        const idealTop = (window.innerHeight - rect.height) / 2;
        const dy = Math.round(idealTop - rect.top);
        if (Math.abs(dy) > 3) {
          media.style.setProperty('transform', `translateY(${dy}px)`, 'important');
          if (actions) {
            actions.style.setProperty('transform', `translateY(${dy}px)`, 'important');
          }
        }
      } catch (_) {}
    });
  } catch (_) {}
}

function closeCommentsPanel(overlay) {
  try {
    document.body.classList.remove('videos-comments-open');
  } catch (_) {}
  clearDesktopCommentsVideoLayout();
  try {
    if (overlay && overlay.isConnected) overlay.remove();
    else document.querySelector('.videos-comments-overlay')?.remove();
  } catch (_) {}
}

function getCenteredFeedCard(viewport) {
  const vp = viewport || document.querySelector('.videos-feed__viewport');
  if (!vp) return null;
  const cards = vp.querySelectorAll('.videos-feed__card');
  if (!cards.length) return null;
  const viewportRect = vp.getBoundingClientRect();
  const viewportCenter = viewportRect.top + viewportRect.height / 2;
  let best = null;
  let bestDist = Infinity;
  cards.forEach((card) => {
    const cardRect = card.getBoundingClientRect();
    const cardCenter = cardRect.top + cardRect.height / 2;
    const dist = Math.abs(cardCenter - viewportCenter);
    if (dist < bestDist) {
      bestDist = dist;
      best = card;
    }
  });
  return best;
}

function closeCommentsPanelIfLeftActivePost() {
  if (Date.now() < (window.__sosCommentsOpenGuardUntil || 0)) return;
  if (!isCommentsPanelOpen()) return;
  const openId = getOpenCommentsEventId();
  if (!openId) {
    closeCommentsPanel();
    return;
  }
  const active = getCenteredFeedCard();
  const activeId = active?.getAttribute?.('data-event-id') || null;
  if (activeId && activeId !== openId) {
    closeCommentsPanel();
  }
}

// חלק תגובות (videos.js) – סגירה אוטומטית בגלילה / ניווט / overlays | HYPER CORE TECH
function setupCommentsAutoClose() {
  if (window.__sosCommentsAutoCloseWired) return;
  window.__sosCommentsAutoCloseWired = true;

  const bindViewportScroll = () => {
    const viewport = document.querySelector('.videos-feed__viewport');
    if (!viewport || viewport.dataset.commentsAutoCloseBound === '1') return;
    viewport.dataset.commentsAutoCloseBound = '1';
    let timer = null;
    viewport.addEventListener('scroll', () => {
      if (!isCommentsPanelOpen()) return;
      if (Date.now() < (window.__sosCommentsOpenGuardUntil || 0)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        closeCommentsPanelIfLeftActivePost();
      }, 60);
    }, { passive: true });
  };

  document.addEventListener('click', (event) => {
    if (!isCommentsPanelOpen()) return;
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    // אינטראקציה בתוך פאנל התגובות — לא סוגרים | HYPER CORE TECH
    if (target.closest('.videos-comments-overlay')) return;
    // כפתור התגובות של אותו פוסט — openCommentsPanel יטפל | HYPER CORE TECH
    if (target.closest('[data-comment-button]')) return;

    if (
      target.closest('.primary-nav [data-nav]') ||
      target.closest('#topBarProfileButton') ||
      target.closest('.videos-nav-arrow-btn') ||
      target.closest('[data-nav]')
    ) {
      closeCommentsPanel();
    }
  }, true);

  bindViewportScroll();
  try {
    const obs = new MutationObserver(() => bindViewportScroll());
    obs.observe(document.body, { childList: true, subtree: true });
  } catch (_) {}

  if (!window.__sosCommentsLayoutResizeWired) {
    window.__sosCommentsLayoutResizeWired = true;
    window.addEventListener('resize', () => {
      if (!document.body.classList.contains('videos-comments-open')) return;
      syncDesktopCommentsVideoLayout();
    }, { passive: true });
  }
}

try {
  const AppRef = window.NostrApp || (window.NostrApp = {});
  AppRef.closeCommentsPanel = closeCommentsPanel;
  AppRef.isCommentsPanelOpen = isCommentsPanelOpen;
} catch (_) {}
try {
  window.closeCommentsPanel = closeCommentsPanel;
} catch (_) {}

function openCommentsPanel(eventId) {
  if (!eventId) return;

  // סגירת פאנל קודם אם פתוח | HYPER CORE TECH
  closeCommentsPanel();
  
  const app = window.NostrApp;
  // לא דורשים שהפוסט יהיה ב-postsById, רק שיהיה eventId תקין
  // הפוסט יכול להיות רק בדף הווידאו ולא בפיד הראשי

  // יצירת overlay
  const overlay = document.createElement('div');
  overlay.className = 'videos-comments-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'תגובות');
  overlay.innerHTML = `
    <div class="videos-comments-panel">
      <div class="videos-comments-header">
        <h3>תגובות</h3>
        <button type="button" class="videos-comments-close" aria-label="סגור">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="videos-comments-list" id="videoCommentsList">
        <div class="videos-comments-loading" role="status" aria-live="polite">טוען תגובות...</div>
      </div>
      <div class="videos-comments-input">
        <input type="text" placeholder="הוסף תגובה..." id="videoCommentInput" />
        <button type="button" id="videoCommentSend" aria-label="שלח תגובה">
          <i class="fa-solid fa-paper-plane"></i>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  try {
    overlay.dataset.eventId = eventId;
  } catch (_) {}
  // מונע סגירה מיידית בגלל scroll/layout אחרי פתיחה | HYPER CORE TECH
  try { window.__sosCommentsOpenGuardUntil = Date.now() + 450; } catch (_) {}
  try { document.body.classList.add('videos-comments-open'); } catch (_) {}
  try { setupCommentsAutoClose(); } catch (_) {}
  try {
    requestAnimationFrame(() => {
      syncDesktopCommentsVideoLayout();
      requestAnimationFrame(() => syncDesktopCommentsVideoLayout());
    });
  } catch (_) {
    try { syncDesktopCommentsVideoLayout(); } catch (__) {}
  }

  // סגירה: מובייל = לחיצה על רקע כהה; דסקטופ = רק X (רקע שקוף עם pointer-events:none) | HYPER CORE TECH
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.videos-comments-close')) {
      closeCommentsPanel(overlay);
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

  // פוקוס לשדה בדסקטופ | HYPER CORE TECH
  try {
    if (window.matchMedia('(min-width: 769px)').matches) {
      setTimeout(() => input?.focus(), 50);
    }
  } catch (_) {}
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

// חלק יאללה וידאו (videos.js) – האם פרופיל בקאש הוא רק stub בלי שם/תמונה אמיתיים | HYPER CORE TECH
function isStubCommentProfile(profile, pubkey) {
  if (!profile || typeof profile !== 'object') return true;
  const key = String(pubkey || '').toLowerCase();
  const name = typeof profile.name === 'string' ? profile.name.trim() : '';
  const picture = typeof profile.picture === 'string' ? profile.picture.trim() : '';
  if (picture) return false;
  if (!name) return true;
  if (key && name === `משתמש ${key.slice(0, 8)}`) return true;
  if (/^משתמש [0-9a-f]{6,16}$/i.test(name)) return true;
  return false;
}

async function resolveCommentAuthorProfile(pubkey) {
  const app = window.NostrApp || {};
  const key = typeof pubkey === 'string' ? pubkey.trim().toLowerCase() : '';
  if (!key) {
    return { name: 'משתמש', bio: '', picture: '', initials: '?' };
  }

  const readCached = () =>
    (app.profileCache instanceof Map
      ? app.profileCache.get(key) || app.profileCache.get(pubkey)
      : null) || null;

  const cached = readCached();
  // יש פרופיל מועשר בקאש — משתמשים בו | HYPER CORE TECH
  if (cached && !isStubCommentProfile(cached, key)) {
    return cached;
  }

  // אם כבר רצה fetch — מחכים לו בלי לקרוא שוב ל־fetchProfile (שדורס stub) | HYPER CORE TECH
  if (app.profileFetchPromises instanceof Map && app.profileFetchPromises.has(key)) {
    try {
      await app.profileFetchPromises.get(key);
    } catch (_) {}
    const afterWait = readCached();
    if (afterWait) return afterWait;
  }

  // אין הבטחה פתוחה — מריצים fetch מלא | HYPER CORE TECH
  try {
    if (typeof app.fetchProfile === 'function') {
      const profile = await app.fetchProfile(key);
      if (profile) return profile;
    }
  } catch (err) {
    console.warn('[videos] comment profile fetch failed', { key: key.slice(0, 8), err });
  }

  return readCached() || {
    name: `משתמש ${key.slice(0, 8)}`,
    bio: '',
    picture: '',
    initials: key.slice(0, 2).toUpperCase() || '?',
  };
}

// חלק יאללה וידאו (videos.js) – טעינת תגובות לפוסט
async function loadCommentsForPost(eventId) {
  const app = window.NostrApp;
  const commentsList = document.getElementById('videoCommentsList');
  if (!commentsList) {
    return;
  }

  // הודעת טעינה מיד (מובייל/דסקטופ) עד שהרשימה מוכנה | HYPER CORE TECH
  commentsList.innerHTML = '<div class="videos-comments-loading" role="status" aria-live="polite">טוען תגובות...</div>';
  try {
    commentsList.dataset.parentId = eventId;
  } catch (_) {}

  let comments = [];
  if (typeof app?.listVisibleComments === 'function') {
    comments = app.listVisibleComments(eventId) || [];
  } else {
    const commentMap = app?.commentsByParent?.get(eventId);
    const deleted = app?.deletedEventIds instanceof Set ? app.deletedEventIds : null;
    comments = commentMap
      ? Array.from(commentMap.values()).filter((c) => c?.id && !(deleted && deleted.has(c.id)))
      : [];
    comments.sort((a, b) => (a?.created_at || 0) - (b?.created_at || 0));
  }

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

  // נשארים עם "טוען תגובות..." בזמן שליפת פרופילים (שם/אווטאר) | HYPER CORE TECH
  const uniqueKeys = [...new Set(
    comments
      .map((c) => (typeof c?.pubkey === 'string' ? c.pubkey.trim().toLowerCase() : ''))
      .filter(Boolean)
  )];
  const profileByKey = new Map();
  await Promise.all(
    uniqueKeys.map(async (key) => {
      const profile = await resolveCommentAuthorProfile(key);
      profileByKey.set(key, profile || null);
    })
  );

  // אם הפאנל נסגר בזמן הטעינה — לא מעדכנים DOM ישן | HYPER CORE TECH
  if (!commentsList.isConnected || commentsList.dataset.parentId !== eventId) {
    return;
  }

  const fragment = document.createDocumentFragment();

  comments.forEach((comment) => {
    const authorKey = typeof comment.pubkey === 'string' ? comment.pubkey.trim().toLowerCase() : '';
    const profile = profileByKey.get(authorKey) || {};
    const displayName = profile.name || (authorKey ? `משתמש ${authorKey.slice(0, 8)}` : 'משתמש');
    const initials = profile.initials || getInitials(displayName);
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
      const img = document.createElement('img');
      img.src = picture;
      img.alt = displayName;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        try {
          img.remove();
          avatarDiv.textContent = initials;
        } catch (_) {}
      }, { once: true });
      avatarDiv.appendChild(img);
    } else {
      avatarDiv.textContent = initials;
    }
    avatarDiv.addEventListener('click', () => {
      const appRef = window.NostrApp;
      // בדיקת מצב אורח - חסימת פרופיל בתגובות למשתמשים לא מחוברים | HYPER CORE TECH
      if (appRef && typeof appRef.requireAuth === 'function') {
        if (!appRef.requireAuth('כדי לצפות בפרופיל משתמש צריך להתחבר או להירשם.')) {
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
      const appRef = window.NostrApp;
      // בדיקת מצב אורח - חסימת פרופיל בתגובות למשתמשים לא מחוברים | HYPER CORE TECH
      if (appRef && typeof appRef.requireAuth === 'function') {
        if (!appRef.requireAuth('כדי לצפות בפרופיל משתמש צריך להתחבר או להירשם.')) {
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

    const headerRow = document.createElement('div');
    headerRow.className = 'videos-comment-header';
    headerRow.appendChild(nameButton);

    const viewerPk = typeof app?.publicKey === 'string' ? app.publicKey.toLowerCase() : '';
    const isAdmin = viewerPk && app?.adminPublicKeys instanceof Set && app.adminPublicKeys.has(viewerPk);
    const isOwn = viewerPk && authorKey && authorKey === viewerPk;
    if ((isOwn || isAdmin) && comment?.id) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'videos-comment-delete';
      deleteBtn.setAttribute('aria-label', 'מחק תגובה');
      deleteBtn.title = 'מחק תגובה';
      deleteBtn.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
      deleteBtn.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (typeof app?.requireAuth === 'function') {
          if (!app.requireAuth('כדי למחוק תגובה צריך להתחבר או להירשם.')) {
            return;
          }
        }
        if (typeof app?.deleteComment === 'function') {
          app.deleteComment(comment.id, eventId);
        }
      });
      headerRow.appendChild(deleteBtn);
    }

    contentWrap.appendChild(headerRow);
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

// חלק שיתוף פיד (videos.js) – כרטיסיית שיתוף מלמטה + לינק ?post= (+url/h/pk לאורח) | HYPER CORE TECH
const POST_ID_HEX = /^[0-9a-f]{64}$/i;
let videosShareToastTimer = null;
let pendingPostDeepLinkId = '';
let postDeepLinkHandled = false;
const pendingPostDeepLinkExtras = { url: '', hash: '', pk: '', mirrors: [] };

function mediaUrlRank(url) {
  const u = String(url || '');
  if (/files\.sovbit\.host/i.test(u)) return 0;
  if (/blossom\.band/i.test(u)) return 1;
  if (/nostr\.build/i.test(u)) return 2;
  if (/primal\.net/i.test(u)) return 9;
  return 5;
}

function expandHashMediaUrls(hash, tipUrl = '') {
  const h = String(hash || '').trim().toLowerCase();
  const tip = String(tipUrl || '').trim();
  const urls = [];
  const push = (u) => {
    if (typeof u === 'string' && /^https?:\/\//i.test(u) && !urls.includes(u)) urls.push(u);
  };
  const tipIsPrimal = /primal\.net/i.test(tip);
  if (tip && !tipIsPrimal) push(tip);
  if (/^[0-9a-f]{64}$/.test(h)) {
    let ext = 'mp4';
    try {
      const m = tip.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
      if (m && m[1]) ext = m[1].toLowerCase();
    } catch (_) {}
    push(`https://files.sovbit.host/${h}.${ext}`);
    if (ext !== 'mp4') push(`https://files.sovbit.host/${h}.mp4`);
    if (ext !== 'webm') push(`https://files.sovbit.host/${h}.webm`);
    push(`https://blossom.band/${h}.${ext}`);
    push(`https://blossom.nostr.build/${h}.${ext}`);
  }
  if (tip && tipIsPrimal) push(tip);
  return urls;
}

function getVideoMediaCandidates(video) {
  if (!video) return [];
  const list = [];
  const add = (u) => {
    if (typeof u === 'string' && /^https?:\/\//i.test(u) && !list.includes(u)) list.push(u);
  };
  (Array.isArray(video.mirrors) ? video.mirrors : []).forEach(add);
  (Array.isArray(pendingPostDeepLinkExtras.mirrors) ? pendingPostDeepLinkExtras.mirrors : []).forEach(add);
  expandHashMediaUrls(video.hash || pendingPostDeepLinkExtras.hash || '', video.videoUrl || pendingPostDeepLinkExtras.url || '').forEach(add);
  add(video.videoUrl);
  add(pendingPostDeepLinkExtras.url);
  return list.slice().sort((a, b) => mediaUrlRank(a) - mediaUrlRank(b));
}

function enrichVideoMediaSources(video) {
  if (!video || typeof video !== 'object') return video;
  const candidates = getVideoMediaCandidates(video);
  if (candidates.length) {
    video.mirrors = candidates;
    video.videoUrl = candidates[0];
  }
  return video;
}

function capturePostDeepLinkFromLocation() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const id = String(params.get('post') || '').trim().toLowerCase();
    const url = String(params.get('url') || params.get('media') || '').trim();
    const hash = String(params.get('h') || params.get('hash') || '').trim().toLowerCase();
    const pk = String(params.get('pk') || params.get('author') || '').trim().toLowerCase();
    const mirrorsRaw = String(params.get('m') || '').trim();
    if (url && /^https?:\/\//i.test(url)) pendingPostDeepLinkExtras.url = url;
    if (hash && /^[0-9a-f]{64}$/i.test(hash)) pendingPostDeepLinkExtras.hash = hash;
    if (pk && POST_ID_HEX.test(pk)) pendingPostDeepLinkExtras.pk = pk;
    if (mirrorsRaw) {
      pendingPostDeepLinkExtras.mirrors = mirrorsRaw
        .split(',')
        .map((s) => String(s || '').trim())
        .filter((s) => /^https?:\/\//i.test(s))
        .slice(0, 4);
    }
    if (POST_ID_HEX.test(id)) {
      pendingPostDeepLinkId = id;
      return id;
    }
  } catch (_) {}
  return pendingPostDeepLinkId || '';
}

// קליטה מוקדמת — לפני hydrate/loadVideos | HYPER CORE TECH
try { capturePostDeepLinkFromLocation(); } catch (_) {}

function findVideoForShare(eventId) {
  const id = String(eventId || '').trim().toLowerCase();
  if (!id) return null;
  if (Array.isArray(state.videos)) {
    const hit = state.videos.find((v) => v && v.id === id);
    if (hit) return hit;
  }
  try {
    const app = window.NostrApp || {};
    if (app.postsById instanceof Map && app.postsById.has(id)) {
      return parseEventToVideoItem(app.postsById.get(id), app);
    }
  } catch (_) {}
  return null;
}

function buildPostShareUrl(eventId) {
  const id = String(eventId || '').trim().toLowerCase();
  const origin = (typeof window !== 'undefined' && window.location && window.location.origin)
    ? window.location.origin
    : 'https://sos010.com';
  const url = new URL(`${origin}/videos.html`);
  url.searchParams.set('post', id);
  const video = findVideoForShare(id);
  if (video) {
    enrichVideoMediaSources(video);
    const candidates = getVideoMediaCandidates(video);
    const best = candidates[0] || String(video.videoUrl || '').trim();
    const hash = String(video.hash || '').trim().toLowerCase();
    const pk = String(video.pubkey || '').trim().toLowerCase();
    if (best && /^https?:\/\//i.test(best)) url.searchParams.set('url', best);
    if (hash && /^[0-9a-f]{64}$/i.test(hash)) url.searchParams.set('h', hash);
    if (pk && POST_ID_HEX.test(pk)) url.searchParams.set('pk', pk);
    // עד 2 מראות נוספות (לא primal) לגיבוי בלינק | HYPER CORE TECH
    const extras = candidates
      .filter((u) => u !== best && !/primal\.net/i.test(u))
      .slice(0, 2);
    if (extras.length) url.searchParams.set('m', extras.join(','));
  }
  return url.toString();
}

function buildVideoStubFromDeepLink(postId) {
  const url = pendingPostDeepLinkExtras.url || '';
  const hash = pendingPostDeepLinkExtras.hash || '';
  const pk = pendingPostDeepLinkExtras.pk || '';
  if (!url && !hash) return null;
  const stub = {
    id: postId,
    pubkey: pk || '',
    createdAt: Math.floor(Date.now() / 1000),
    content: '',
    videoUrl: url || '',
    hash: hash || '',
    mirrors: [
      ...(url ? [url] : []),
      ...(Array.isArray(pendingPostDeepLinkExtras.mirrors) ? pendingPostDeepLinkExtras.mirrors : []),
    ],
    youtubeId: null,
    liveUrl: null,
    gameUrl: null,
    imageUrl: null,
    authorName: 'SOS',
    authorPicture: '',
    authorInitials: 'SO',
    fromDeepLink: true,
  };
  return enrichVideoMediaSources(stub);
}

function mergeDeepLinkExtrasIntoVideo(video) {
  if (!video || typeof video !== 'object') return video;
  if (pendingPostDeepLinkExtras.url && !video.videoUrl) {
    video.videoUrl = pendingPostDeepLinkExtras.url;
  }
  if (pendingPostDeepLinkExtras.hash && !video.hash) {
    video.hash = pendingPostDeepLinkExtras.hash;
  }
  if (pendingPostDeepLinkExtras.pk && !video.pubkey) {
    video.pubkey = pendingPostDeepLinkExtras.pk;
  }
  const mirrors = Array.isArray(video.mirrors) ? video.mirrors.slice() : [];
  if (pendingPostDeepLinkExtras.url && !mirrors.includes(pendingPostDeepLinkExtras.url)) {
    mirrors.unshift(pendingPostDeepLinkExtras.url);
  }
  (pendingPostDeepLinkExtras.mirrors || []).forEach((u) => {
    if (u && !mirrors.includes(u)) mirrors.push(u);
  });
  video.mirrors = mirrors;
  video.fromDeepLink = true;
  return enrichVideoMediaSources(video);
}

async function prioritizeDeepLinkMedia(video) {
  if (!video?.id) return false;
  enrichVideoMediaSources(video);
  const candidates = getVideoMediaCandidates(video);
  console.log('[videos] deep-link media priority', {
    id: video.id,
    candidates: candidates.length,
    first: candidates[0] || '',
  });
  // הטעינה האמיתית רצה ב־renderVideoCard על אלמנט מנותק (לפני mount) | HYPER CORE TECH
  // כאן רק מנסים שוב אם הכרטיס כבר ב־DOM אחרי כשל זמני
  const card = selectors.stream?.querySelector(`.videos-feed__card[data-event-id="${video.id}"]`);
  const videoEl = card?.querySelector('video');
  if (!videoEl || !candidates.length) return false;
  removeVideoElFromDownloadQueue(videoEl);
  for (let i = 0; i < candidates.length; i += 1) {
    const url = candidates[i];
    try {
      videoEl.src = url;
      videoEl.load();
      const ok = await waitForPostMediaPlayable(video);
      if (ok) {
        revealBootVideoFrame(video);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

function showVideosShareToast(message) {
  let toast = document.getElementById('videosShareToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'videosShareToast';
    toast.className = 'videos-share-sheet__toast';
    toast.setAttribute('role', 'status');
    document.body.appendChild(toast);
  }
  toast.textContent = String(message || '');
  toast.classList.add('is-visible');
  if (videosShareToastTimer) clearTimeout(videosShareToastTimer);
  videosShareToastTimer = setTimeout(() => {
    toast.classList.remove('is-visible');
  }, 2200);
}

function closeVideosShareSheet() {
  const sheet = document.getElementById('videosShareSheet');
  if (!sheet) return;
  sheet.classList.remove('is-open');
  document.body.classList.remove('videos-share-sheet-open');
  setTimeout(() => {
    try { sheet.remove(); } catch (_) {}
  }, 280);
}

function getShareSheetContacts(limit = 18) {
  const app = window.NostrApp || {};
  try {
    const list = typeof app.getChatContacts === 'function' ? app.getChatContacts() : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((c) => c && typeof c.pubkey === 'string' && POST_ID_HEX.test(c.pubkey))
      .slice(0, limit);
  } catch (_) {
    return [];
  }
}

async function sharePostToFeed(eventId) {
  const app = window.NostrApp || {};
  if (typeof app.requireAuth === 'function') {
    if (!app.requireAuth('כדי לשתף בפיד צריך להתחבר או להירשם.')) return false;
  }
  if (typeof app.sharePost !== 'function') {
    showVideosShareToast('שיתוף בפיד לא זמין כרגע');
    return false;
  }
  try {
    const shared = await app.sharePost(eventId);
    if (!shared) {
      showVideosShareToast('שיתוף בפיד נכשל');
      return false;
    }
    // registerShare/onFeedPostShared כבר מעלים לראש; גיבוי מקומי | HYPER CORE TECH
    bumpSharedVideoToTop(eventId, shared);
    updateVideoShareButton(eventId);
    showVideosShareToast('שותף בפיד');
    return true;
  } catch (err) {
    console.warn('[videos] share to feed failed', err);
    showVideosShareToast('שיתוף בפיד נכשל');
    return false;
  }
}

async function sharePostToContact(eventId, peerPubkey) {
  const app = window.NostrApp || {};
  if (typeof app.requireAuth === 'function') {
    if (!app.requireAuth('כדי לשלוח לחבר בצ׳אט צריך להתחבר או להירשם.')) return false;
  }
  const peer = String(peerPubkey || '').toLowerCase();
  if (!POST_ID_HEX.test(peer)) return false;
  const link = buildPostShareUrl(eventId);
  const text = `סרטון ב-SOS:\n${link}`;
  try {
    if (typeof app.ensureChatContact === 'function') app.ensureChatContact(peer);
  } catch (_) {}
  try {
    if (typeof app.publishChatMessage === 'function') {
      await app.publishChatMessage(peer, text);
    }
  } catch (err) {
    console.warn('[videos] share to contact message failed', err);
  }
  try {
    if (typeof app.showChatConversation === 'function') {
      app.showChatConversation(peer);
    } else if (typeof app.openChatConversation === 'function') {
      app.openChatConversation(peer);
    }
  } catch (_) {}
  showVideosShareToast('נשלח בצ׳אט');
  return true;
}

async function copyPostShareLink(eventId) {
  const link = buildPostShareUrl(eventId);
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(link);
    } else {
      const ta = document.createElement('textarea');
      ta.value = link;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    showVideosShareToast('הקישור הועתק');
    return true;
  } catch (err) {
    console.warn('[videos] copy link failed', err);
    showVideosShareToast('העתקה נכשלה');
    return false;
  }
}

function openExternalShare(eventId, network) {
  const link = buildPostShareUrl(eventId);
  const text = `סרטון ב-SOS: ${link}`;
  let target = '';
  if (network === 'whatsapp') {
    target = `https://wa.me/?text=${encodeURIComponent(text)}`;
  } else if (network === 'telegram') {
    target = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('סרטון ב-SOS')}`;
  }
  if (!target) return;
  try {
    window.open(target, '_blank', 'noopener,noreferrer');
  } catch (_) {
    window.location.href = target;
  }
}

async function openSystemShare(eventId) {
  const link = buildPostShareUrl(eventId);
  if (!navigator.share) {
    await copyPostShareLink(eventId);
    return;
  }
  try {
    await navigator.share({
      title: 'SOS',
      text: 'סרטון ב-SOS',
      url: link,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    await copyPostShareLink(eventId);
  }
}

function openVideosShareSheet(eventId) {
  const id = String(eventId || '').trim().toLowerCase();
  if (!POST_ID_HEX.test(id)) return;

  closeVideosShareSheet();

  const contacts = getShareSheetContacts();
  const sheet = document.createElement('div');
  sheet.id = 'videosShareSheet';
  sheet.className = 'videos-share-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'videosShareSheetTitle');

  const contactsHtml = contacts.length
    ? contacts.map((c) => {
      const name = String(c.name || 'משתמש').trim() || 'משתמש';
      const initials = String(c.initials || name.slice(0, 2) || 'מ').slice(0, 2);
      const pic = typeof c.picture === 'string' && c.picture ? c.picture : '';
      const avatarInner = pic
        ? `<img src="${pic.replace(/"/g, '')}" alt="">`
        : `<span class="videos-share-sheet__avatar-fallback">${initials}</span>`;
      return `<button type="button" class="videos-share-sheet__person" data-share-to-peer="${c.pubkey}">
        <span class="videos-share-sheet__avatar">${avatarInner}</span>
        <span class="videos-share-sheet__label">${name.replace(/</g, '&lt;')}</span>
      </button>`;
    }).join('')
    : '<div class="videos-share-sheet__empty">אין אנשי קשר עדיין — אפשר לשתף בקישור למטה</div>';

  sheet.innerHTML = `
    <div class="videos-share-sheet__backdrop" data-share-close></div>
    <div class="videos-share-sheet__panel" role="document">
      <div class="videos-share-sheet__handle" aria-hidden="true"></div>
      <header class="videos-share-sheet__header">
        <button type="button" class="videos-share-sheet__icon-btn" data-share-close aria-label="סגור">
          <i class="fa-solid fa-xmark"></i>
        </button>
        <h3 id="videosShareSheetTitle" class="videos-share-sheet__title">שלח אל</h3>
        <span aria-hidden="true"></span>
      </header>
      <div class="videos-share-sheet__body">
        <div class="videos-share-sheet__row" aria-label="אנשי קשר">${contactsHtml}</div>
        <div class="videos-share-sheet__divider"></div>
        <div class="videos-share-sheet__row" aria-label="שיתוף">
          <button type="button" class="videos-share-sheet__action" data-share-action="feed">
            <span class="videos-share-sheet__action-icon videos-share-sheet__action-icon--feed"><i class="fa-solid fa-retweet"></i></span>
            <span class="videos-share-sheet__label">שתף בפיד</span>
          </button>
          <button type="button" class="videos-share-sheet__action" data-share-action="whatsapp">
            <span class="videos-share-sheet__action-icon videos-share-sheet__action-icon--whatsapp"><i class="fa-brands fa-whatsapp"></i></span>
            <span class="videos-share-sheet__label">וואטסאפ</span>
          </button>
          <button type="button" class="videos-share-sheet__action" data-share-action="telegram">
            <span class="videos-share-sheet__action-icon videos-share-sheet__action-icon--telegram"><i class="fa-brands fa-telegram"></i></span>
            <span class="videos-share-sheet__label">טלגרם</span>
          </button>
          <button type="button" class="videos-share-sheet__action" data-share-action="copy">
            <span class="videos-share-sheet__action-icon videos-share-sheet__action-icon--copy"><i class="fa-solid fa-link"></i></span>
            <span class="videos-share-sheet__label">העתק קישור</span>
          </button>
          <button type="button" class="videos-share-sheet__action" data-share-action="more">
            <span class="videos-share-sheet__action-icon videos-share-sheet__action-icon--more"><i class="fa-solid fa-ellipsis"></i></span>
            <span class="videos-share-sheet__label">עוד</span>
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(sheet);
  document.body.classList.add('videos-share-sheet-open');
  requestAnimationFrame(() => sheet.classList.add('is-open'));

  sheet.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    if (t.closest('[data-share-close]')) {
      closeVideosShareSheet();
      return;
    }
    const peerBtn = t.closest('[data-share-to-peer]');
    if (peerBtn) {
      const peer = peerBtn.getAttribute('data-share-to-peer');
      await sharePostToContact(id, peer);
      closeVideosShareSheet();
      return;
    }
    const actionBtn = t.closest('[data-share-action]');
    if (!actionBtn) return;
    const action = actionBtn.getAttribute('data-share-action');
    if (action === 'feed') {
      const ok = await sharePostToFeed(id);
      if (ok) closeVideosShareSheet();
      return;
    }
    if (action === 'whatsapp') {
      openExternalShare(id, 'whatsapp');
      closeVideosShareSheet();
      return;
    }
    if (action === 'telegram') {
      openExternalShare(id, 'telegram');
      closeVideosShareSheet();
      return;
    }
    if (action === 'copy') {
      await copyPostShareLink(id);
      closeVideosShareSheet();
      return;
    }
    if (action === 'more') {
      await openSystemShare(id);
      closeVideosShareSheet();
    }
  });
}

async function fetchNoteById(eventId) {
  const app = window.NostrApp || {};
  if (app.postsById instanceof Map && app.postsById.has(eventId)) {
    return app.postsById.get(eventId);
  }
  if (!app.pool || !Array.isArray(app.relayUrls) || !app.relayUrls.length) return null;
  const filters = [{ ids: [eventId], limit: 1 }];
  try {
    if (typeof app.pool.list === 'function') {
      const listed = await app.pool.list(app.relayUrls, filters);
      if (Array.isArray(listed) && listed[0]) return listed[0];
    }
    if (typeof app.pool.querySync === 'function') {
      const res = await app.pool.querySync(app.relayUrls, filters[0]);
      const events = Array.isArray(res) ? res : (Array.isArray(res?.events) ? res.events : []);
      if (events[0]) return events[0];
    }
    // fallback קצר עם subscribeMany | HYPER CORE TECH
    if (typeof app.pool.subscribeMany === 'function') {
      return await new Promise((resolve) => {
        let done = false;
        const finish = (ev) => {
          if (done) return;
          done = true;
          try { sub.close(); } catch (_) {}
          resolve(ev || null);
        };
        const sub = app.pool.subscribeMany(app.relayUrls, filters, {
          onevent: (ev) => finish(ev),
          oneose: () => finish(null),
        });
        setTimeout(() => finish(null), 3500);
      });
    }
  } catch (err) {
    console.warn('[videos] fetchNoteById failed', err);
  }
  return null;
}

function stripPostParamFromUrl() {
  try {
    if (typeof history.replaceState !== 'function') return;
    const url = new URL(window.location.href);
    let changed = false;
    ['post', 'url', 'media', 'h', 'hash', 'pk', 'author', 'm'].forEach((key) => {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    });
    if (!changed) return;
    const next = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '') + url.hash;
    history.replaceState({}, '', next);
  } catch (_) {}
}

async function handlePostDeepLink(options = {}) {
  const { force = false } = options;
  const postId = capturePostDeepLinkFromLocation() || pendingPostDeepLinkId;
  if (!POST_ID_HEX.test(postId)) return false;
  if (postDeepLinkHandled && !force) return true;

  console.log('[videos] post deep link', {
    id: postId,
    hasUrl: !!pendingPostDeepLinkExtras.url,
    hasHash: !!pendingPostDeepLinkExtras.hash,
    hasPk: !!pendingPostDeepLinkExtras.pk,
  });
  const app = window.NostrApp || {};

  let video = Array.isArray(state.videos) ? state.videos.find((v) => v && v.id === postId) : null;
  if (!video) {
    const event = await fetchNoteById(postId);
    if (event) {
      video = parseEventToVideoItem(event, app);
      if (video) {
        try {
          if (typeof app.registerVideoSourceEvent === 'function') app.registerVideoSourceEvent(event);
          else {
            if (!(app.postsById instanceof Map)) app.postsById = new Map();
            app.postsById.set(event.id, event);
          }
        } catch (_) {}
      }
    }
  }

  // אורח בלי קאש/ריליי: stub מ־url/h/pk בלינק | HYPER CORE TECH
  if (!video) {
    video = buildVideoStubFromDeepLink(postId);
  } else {
    mergeDeepLinkExtrasIntoVideo(video);
  }

  if (!video) {
    console.warn('[videos] post deep link — post not found yet', { id: postId });
    return false;
  }

  mergeDeepLinkExtrasIntoVideo(video);
  postDeepLinkHandled = true;
  pendingPostDeepLinkId = postId;
  video.boostedAt = Math.max(Number(video.boostedAt) || 0, Math.floor(Date.now() / 1000));
  upsertVideoInState(video, { forceShow: true, immediate: true });
  try {
    state.videos = sortVideosByCreatedAtDesc(state.videos);
    syncFeedDomOrder(getDisplayVideos());
  } catch (_) {}
  stripPostParamFromUrl();

  // טעינת מדיה מיד (Blossom/URL לפני קאש) — קריטי לאורח | HYPER CORE TECH
  prioritizeDeepLinkMedia(video).then((ok) => {
    console.log('[videos] deep-link media done', { id: postId, ok: !!ok });
    if (ok) {
      try { revealBootVideoFrame(video); } catch (_) {}
    }
  }).catch((err) => {
    console.warn('[videos] deep-link media failed', err);
  });

  const tryScroll = () => {
    const card = selectors.stream?.querySelector(`.videos-feed__card[data-event-id="${postId}"]`);
    if (!card) return false;
    try {
      card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (_) {
      try {
        const viewport = document.querySelector('.videos-feed__viewport');
        if (viewport) viewport.scrollTop = card.offsetTop;
      } catch (__) {}
    }
    return true;
  };
  if (!tryScroll()) {
    setTimeout(tryScroll, 400);
    setTimeout(tryScroll, 1200);
    setTimeout(tryScroll, 2500);
  }
  return true;
}

App.openVideosShareSheet = openVideosShareSheet;
App.buildPostShareUrl = buildPostShareUrl;
App.handlePostDeepLink = handlePostDeepLink;

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
      const eventId = button.getAttribute('data-event-id');
      if (eventId) openVideosShareSheet(eventId);
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

        // שידור חי P2P – ניגון כרטיס כמו LIVE TV | HYPER CORE TECH
        if (mediaDiv.dataset.mediaType === 'p2p-live') {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            playP2pLiveMedia(mediaDiv);
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
          // גלילה לפוסט אחר — סגירת פאנל תגובות של הפוסט הקודם | HYPER CORE TECH
          try {
            const openId = getOpenCommentsEventId();
            const cardId = card.getAttribute('data-event-id');
            if (openId && cardId && openId !== cardId) {
              closeCommentsPanel();
            }
          } catch (_) {}
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
  // upload pause בלבד — שיחות לא דוחות מיזוג/מטא־דאטה של פוסטים | HYPER CORE TECH
  if (feedDownloadsPaused) {
    console.log('[videos] loadMoreVideos deferred — upload in progress');
    return;
  }
  // במצב משחקים / LIVE TV / פוסטים שלי לא טוענים עוד וידאו כללי לתוך התצוגה | HYPER CORE TECH
  if (state.feedMode === 'games' || state.feedMode === 'live-tv' || state.feedMode === 'own-posts') return;
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
        await renderMoreVideos(toShow);
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
    if (isMediaUnavailable(event.id)) return;
    
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
    const mirrorsFn =
      (typeof extractMirrors === 'function' && extractMirrors) ||
      (typeof window !== 'undefined' && typeof window.NostrApp?.extractMirrorsFromEvent === 'function'
        && window.NostrApp.extractMirrorsFromEvent) ||
      null;
    
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
      mirrors: mirrorsFn ? (mirrorsFn(event) || []) : []
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

// load-more: כרטיסייה לפיד רק אחרי שהווידאו מוכן — בלי כרטיסיות ריקות | HYPER CORE TECH
async function renderMoreVideos(videos) {
  const stream = document.querySelector('.videos-feed__stream');
  if (!stream || !videos.length) return;

  const list = state.feedMode === 'games'
    ? videos.filter((v) => isGameFeedVideo(v))
    : state.feedMode === 'live-tv'
      ? []
      : state.feedMode === 'own-posts'
        ? []
        : videos.filter((v) => isGeneralFeedVideo(v));

  const MEDIA_WAIT_MS = 60000;
  for (const video of list) {
    if (!video?.id || isMediaUnavailable(video)) continue;
    if (stream.querySelector(`.videos-feed__card[data-event-id="${video.id}"]`)) continue;
    let card = null;
    try {
      const rendered = renderVideoCard(video);
      card = rendered?.card || null;
      const mediaReadyPromise = rendered?.mediaReadyPromise;
      if (!card || !mediaReadyPromise) continue;
      await Promise.race([
        mediaReadyPromise,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('media-ready-timeout')), MEDIA_WAIT_MS);
        }),
      ]);
      if (stream.querySelector(`.videos-feed__card[data-event-id="${video.id}"]`)) continue;
      mountCard(card);
      markCardMediaReady(card);
    } catch (err) {
      if (card) {
        try { handleCardMediaFailure(card, video.id, err); } catch (_) {}
      }
    }
  }

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
      // טעינת לייקים (kind 7) + שיתופים (kind 6) + תגובות | HYPER CORE TECH
      const likesFilter = { kinds: [7], '#e': batch, since };
      const sharesFilter = { kinds: [6], '#e': batch, since };
      const commentsFilter = { kinds: [1], '#e': batch, since };

      let allEvents = [];

      if (typeof app.pool.list === 'function') {
        const results = await app.pool.list(app.relayUrls, [likesFilter, sharesFilter, commentsFilter]);
        if (Array.isArray(results)) allEvents = results;
      } else if (typeof app.pool.querySync === 'function') {
        const likesRes = await app.pool.querySync(app.relayUrls, likesFilter);
        const sharesRes = await app.pool.querySync(app.relayUrls, sharesFilter);
        const commentsRes = await app.pool.querySync(app.relayUrls, commentsFilter);
        const likes = Array.isArray(likesRes) ? likesRes : (Array.isArray(likesRes?.events) ? likesRes.events : []);
        const shares = Array.isArray(sharesRes) ? sharesRes : (Array.isArray(sharesRes?.events) ? sharesRes.events : []);
        const comments = Array.isArray(commentsRes) ? commentsRes : (Array.isArray(commentsRes?.events) ? commentsRes.events : []);
        allEvents = [...likes, ...shares, ...comments];
      }

      totalLoaded += allEvents.length;

      // עיבוד לייקים/שיתופים/תגובות בהתאם ללוגיקת הפיד הראשי | HYPER CORE TECH
      allEvents.forEach((event) => {
        if (event.kind === 7 && typeof app.registerLike === 'function') {
          app.registerLike(event);
          return;
        }
        if (event.kind === 6 && typeof app.registerShare === 'function') {
          app.registerShare(event);
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
      batch.forEach((id) => {
        updateVideoLikeButton(id);
        updateVideoCommentButton(id);
        updateVideoShareButton(id);
      });

    } catch (err) {
      console.warn('[videos] Failed to load likes/comments batch:', err);
    }
  }

  console.log('[videos] Loaded likes/comments:', { count: totalLoaded });
  // אחרי שיתופים — סידור מחדש לפי דירוג (שיתוף מעלה לראש) | HYPER CORE TECH
  try {
    if (Array.isArray(state.videos) && state.videos.length) {
      state.videos = sortVideosByCreatedAtDesc(state.videos);
      if (bootGate.released && state.firstCardRendered) {
        syncFeedDomOrder(getDisplayVideos());
      }
    }
  } catch (_) {}
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

  if (app.deletedEventIds instanceof Set && event.id && app.deletedEventIds.has(event.id)) {
    return;
  }

  if (typeof app.registerComment === 'function') {
    try {
      app.registerComment(event, parentId);
      // registerComment מעדכן פיד בית בלבד — חובה לרענן בועת הווידאו | HYPER CORE TECH
      try {
        updateVideoCommentButton(parentId);
      } catch (err) {
        console.warn('[videos] updateVideoCommentButton failed', err);
      }
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
  // שיחות משהות רק תור וידאו — מיזוג פוסטים ממשיך ברקע | HYPER CORE TECH
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
  // מה שכבר מוצג בפיד — לא רק מה שנשמר בדיסק | HYPER CORE TECH
  const displayedIds = new Set((state.videos || []).map((v) => v?.id).filter(Boolean));
  let newestDisplayedTime = 0;
  (state.videos || []).forEach((v) => {
    const ts = getVideoCreatedAt(v) || 0;
    if (ts > newestDisplayedTime) newestDisplayedTime = ts;
  });
  // דילוג רק על מה שמוצג בפועל — לא על IDs "רפאים" בדיסק אחרי סינון | HYPER CORE TECH
  const skipIds = displayedIds;
  // פיד דל אחרי קיצוץ — מושכים מחדש בלי since כדי לשחזר | HYPER CORE TECH
  const FEED_RECOVER_MIN = 40;
  const sinceMergeTime = (displayedIds.size >= FEED_RECOVER_MIN)
    ? Math.max(newestCachedTime || 0, newestDisplayedTime || 0)
    : 0;
  
  setLoadingProgress(10);
  setLoadingStatus('בודק מטמון מקומי...');
  
  console.log('[videos] loadVideos: cache info', { 
    cachedCount: cachedIds.size,
    displayedCount: displayedIds.size,
    skipCount: skipIds.size,
    recoverMode: displayedIds.size < FEED_RECOVER_MIN,
    newestPostTime: newestCachedTime ? new Date(newestCachedTime * 1000).toLocaleString() : 'none',
    newestDisplayed: newestDisplayedTime ? new Date(newestDisplayedTime * 1000).toLocaleString() : 'none',
  });

  setLoadingProgress(20);
  setLoadingStatus('מתחבר לשרתים...');

  if (currentApp && currentApp.postsById && currentApp.postsById.size > 0) {
    const fromApp = Array.from(currentApp.postsById.values());
    // פוסטים שעדיין לא מוצגים בפיד (גם אם חסרים מקאש הדיסק אחרי So-Call) | HYPER CORE TECH
    const newFromApp = fromApp.filter((ev) => {
      if (!ev || !ev.id) return false;
      if (skipIds.has(ev.id)) return false;
      if (currentApp.deletedEventIds instanceof Set && currentApp.deletedEventIds.has(ev.id)) return false;
      return true;
    });
    const filtered = filterEventsByNetwork(newFromApp, networkTag);
    // מיון לפי תאריך (חדש ראשון) והגבלה למספר הפוסטים הראשוני
    filtered.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    sourceEvents = filtered.slice(0, INITIAL_LOAD_LIMIT);
    console.log('[videos] loadVideos: postsById', { total: fromApp.length, new: newFromApp.length, afterFilter: filtered.length, limited: sourceEvents.length });
    setLoadingProgress(40);
  } else {
    // Fallback: משיכת אירועים חדשים בלבד מהרילאים (since = הפוסט האחרון במטמון/תצוגה)
    setLoadingStatus('מוריד פוסטים מהרשת...');
    const sinceTime = sinceMergeTime > 0 ? sinceMergeTime : undefined;
    const fetched = await fetchRecentNotes(INITIAL_LOAD_LIMIT, sinceTime);
    setLoadingProgress(40);
    // סינון פוסטים שכבר יש בתצוגה והגבלה
    const newFetched = fetched.filter((ev) => ev && !skipIds.has(ev.id));
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
    const sinceTime = sinceMergeTime > 0 ? sinceMergeTime : undefined;
    const netNotes = await fetchNetworkNotes(authors.slice(0, 100), LOAD_MORE_BATCH, sinceTime);
    if (Array.isArray(netNotes) && netNotes.length) {
      // סינון פוסטים שכבר יש בתצוגה
      const newNetNotes = netNotes.filter((ev) => ev && !skipIds.has(ev.id));
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
        cachedIds.forEach((id) => {
          updateVideoLikeButton(id);
          updateVideoCommentButton(id);
        });
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
    if (isMediaUnavailable(event.id)) return;

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

  // חיתוך זיכרון+קאש לפני שמירה — מונע Quota וריקון ברענון | HYPER CORE TECH
  truncateFeedLength();
  
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

  // הפעלה חמה: מחממים חדשים ברקע — מוצגים בראש רק בלחיצת בית | HYPER CORE TECH
  const warmUi = bootGate.released && state.firstCardRendered;
  if (warmUi) {
    if (newVideos.length > 0) {
      const toQueue = sortVideosByCreatedAtDesc(
        newVideos.filter((v) => v?.id && isGeneralFeedVideo(v))
      );
      toQueue.forEach((v) => queueNewPostForHomeReveal(v));
      console.log('[videos] warm sync queued new posts for Home', { queued: toQueue.length });
    }
    setLoadingProgress(100);
    hideLoadingAnimation();
    return;
  }

  renderVideos();

  // אחרי רינדור מהרשת — מוודאים שהראשון מוכן לפני סגירת LoadNug | HYPER CORE TECH
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
    filters.push({ kinds: [6], '#e': eventIds, limit: 200 });
  }

  videoRealtimeSub = app.pool.subscribeMany(app.relayUrls, filters, {
    onevent: (event) => {
      if (!event || !event.kind) return;
      if (event.kind === 1) {
        registerVideoSourceEvent(event);
        registerVideoEngagementEvent(event);
      } else if (event.kind === 5) {
        // הסתרה בזמן אמת — רק אחרי registerDeletion מאושר | HYPER CORE TECH
        if (typeof app.registerDeletion === 'function') {
          app.registerDeletion(event);
        }
        const hideIds = [];
        if (Array.isArray(event.tags)) {
          event.tags.forEach((tag) => {
            if (Array.isArray(tag) && tag[0] === 'e' && tag[1]) hideIds.push(tag[1]);
          });
        }
        hideIds.forEach((deletedId) => {
          if (!(app.deletedEventIds instanceof Set) || !app.deletedEventIds.has(deletedId)) {
            return;
          }
          removeVideoFromState(deletedId);
          removeVideoCard(deletedId);
        });
      } else if (event.kind === 7) {
        registerVideoEngagementEvent(event);
      } else if (event.kind === 6) {
        if (typeof app.registerShare === 'function') app.registerShare(event);
        // שיתוף טרי מהרשת — הקפצה לראש (לא היסטוריה ישנה) | HYPER CORE TECH
        const ageSec = Math.floor(Date.now() / 1000) - (Number(event.created_at) || 0);
        if (ageSec >= 0 && ageSec <= 180) {
          const eTag = Array.isArray(event.tags)
            ? event.tags.find((t) => Array.isArray(t) && t[0] === 'e' && t[1])
            : null;
          if (eTag && eTag[1]) bumpSharedVideoToTop(eTag[1], event);
        }
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
    
    if (targetIndex !== currentIndex) {
      try { closeCommentsPanel(); } catch (_) {}
    }

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
  
  // הוספה לתפריט הצד – משחקים לפני חשבונות עוקבים | HYPER CORE TECH
  sidebar.appendChild(separator1);
  sidebar.appendChild(gamesTitle);
  sidebar.appendChild(gamesList);
  sidebar.appendChild(separator2); // קו בין משחקים לעוקבים
  sidebar.appendChild(title);
  sidebar.appendChild(followersList);
  sidebar.appendChild(gamesSeparatorAfter); // קו אחרי עוקבים / לפני פוטר
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

  // חלק כפתור בית (videos.js) – לחיצה 1 סוגרת overlay / רמז; לחיצה 2 מרעננת | HYPER CORE TECH
  const homeButton = document.getElementById('videosTopHomeButton');
  if (homeButton) {
    homeButton.addEventListener('click', (event) => {
      try {
        event.preventDefault();
        event.stopPropagation();
      } catch (_) {}
      handleHomeButtonAction();
    });
  }

  bindHomeNavCaptureOnce();
  try { document.body.classList.add('videos-page'); } catch (_) {}

  // גלילה מבטלת את מצב "לחיצה נוספת תרענן" | HYPER CORE TECH
  const feedViewport = document.querySelector('.videos-feed__viewport');
  if (feedViewport) {
    feedViewport.addEventListener('scroll', () => {
      if (homeRefreshArmedUntil > 0) clearHomeRefreshArm();
    }, { passive: true });
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

  // שחזור תגובות מקאש מקומי לפני רינדור/בועות | HYPER CORE TECH
  if (typeof app.restoreCommentsFromStorage === 'function' && !app.commentsRestored) {
    try {
      app.restoreCommentsFromStorage();
      app.commentsRestored = true;
    } catch (err) {
      console.warn('[videos] restoreCommentsFromStorage failed', err);
    }
  }

  // טעינת מחיקות לפני הצגת המטמון כדי לסנן פוסטים מחוקים
  await loadDeletionsFirst();
  // בית בלי שיחות — מוודאים ש־pause שיחות לא תקוע אחרי רענון | HYPER CORE TECH
  syncFeedWarmupPauseWithChat('boot-init');

  showLoadingAnimation();
  setLoadingStatus('טוען פוסטים...');
  setLoadingProgress(20);
  try { document.body.classList.add('videos-boot-loading'); } catch (_) {}
  bootGate.holdUntil = 0;

  // חלק מטמון (videos.js) – מטא־דאטה מהקאש מיד; מסך נסגר רק אחרי פריים וידאו ראשון | HYPER CORE TECH
  try {
    if (typeof App.retryMediaCacheOpen === 'function') {
      await App.retryMediaCacheOpen();
    }
  } catch (err) {
    console.warn('[videos] media cache retry before hydrate failed', err);
  }
  const hadCachedContent = hydrateFeedFromCache();
  if (hadCachedContent) {
    if (selectors.status) {
      selectors.status.style.display = 'none';
    }
    state.firstCardRendered = true;
    console.log('[videos] warm start from cache — waiting for first video frame');
    setLoadingStatus('טוען את הפוסט הראשון מהקאש...');
    setLoadingProgress(45);
    // רענון בועות תגובה מהקאש המקומי ששוחזר | HYPER CORE TECH
    try {
      (state.videos || []).forEach((v) => {
        if (v?.id) updateVideoCommentButton(v.id);
      });
    } catch (_) {}
    // לינק ישיר לפוסט — מנסים מיד מהקאש לפני boot | HYPER CORE TECH
    try { await handlePostDeepLink(); } catch (_) {}
    await ensureBootFeedReady();
    try { await handlePostDeepLink({ force: !postDeepLinkHandled }); } catch (_) {}
  } else {
    try { await handlePostDeepLink(); } catch (_) {}
  }

  // טעינת תוכן חדש ברקע (גם אם יש מטמון)
  loadVideos()
    .then(async () => {
      if (!bootGate.released) {
        await ensureBootFeedReady();
      }
      try {
        await handlePostDeepLink({ force: !postDeepLinkHandled });
        if (!postDeepLinkHandled && pendingPostDeepLinkId) {
          showVideosShareToast('הפוסט לא נמצא');
        }
      } catch (err) {
        console.warn('[videos] post deep link failed', err);
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
    .sort((a, b) => getVideoRankAt(b) - getVideoRankAt(a));
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
  // LoadNug נשאר על body כדף טעינה מלא — לא מחזירים ל־stream | HYPER CORE TECH
  if (loadnug && loadnug.parentElement !== document.body) {
    try { document.body.appendChild(loadnug); } catch (_) {}
  }
}

function getDisplayVideos() {
  // פיד כללי = בלי משחקים ובלי ערוצי LIVE; משחקים / LIVE TV / פוסטים שלי = מצבים נפרדים | HYPER CORE TECH
  if (state.feedMode === 'games') {
    return buildGamesFeedVideos();
  }
  if (state.feedMode === 'live-tv') {
    return Array.isArray(state.liveTvVideos) ? state.liveTvVideos : [];
  }
  if (state.feedMode === 'own-posts') {
    return Array.isArray(state.ownPostsVideos) ? state.ownPostsVideos : [];
  }
  const all = Array.isArray(state.videos) ? state.videos : [];
  return sortVideosByCreatedAtDesc(
    all.filter((v) => isGeneralFeedVideo(v) && !isMediaUnavailable(v))
  );
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
    if (state.feedMode === 'all') {
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

  // LoadNug על body — לא מעבירים ל־stream (שובר fullscreen) | HYPER CORE TECH
  selectors.stream.innerHTML = '';
  const loadnugCard = document.getElementById('sosLoadNugOverlay');
  if (loadnugCard && loadnugCard.parentElement !== document.body) {
    try { document.body.appendChild(loadnugCard); } catch (_) {}
  }

  state.firstCardRendered = false;
  const videos = getDisplayVideos();
  if (!videos.length) {
    hideLoadingAnimation();
    setStatus(
      state.feedMode === 'games'
        ? 'אין משחקים להצגה'
        : (state.feedMode === 'live-tv'
          ? 'אין ערוצים להצגה'
          : (state.feedMode === 'own-posts' ? 'אין פוסטים להצגה' : 'אין סרטונים להצגה'))
    );
    return;
  }

  if (selectors.status) {
    selectors.status.textContent = state.feedMode === 'games'
      ? 'טוען משחקים...'
      : (state.feedMode === 'live-tv'
        ? 'טוען ערוצים...'
        : (state.feedMode === 'own-posts' ? 'טוען את הפוסטים שלך...' : 'טוען סרטונים...'));
    selectors.status.style.display = 'block';
  }

  // LIVE / משחקים / פוסטים שלי – תמיד PLAY אחרי רינדור | HYPER CORE TECH
  if (state.feedMode === 'live-tv' || state.feedMode === 'games' || state.feedMode === 'own-posts') {
    globalAutoplayEnabled = true;
    updateGlobalStopClass();
  }

  setupIntersectionObserver();
  setupLoadMoreObserver();
  setupLikeUpdateListener();
  setupShareUpdateListener();
  setupCommentsChangedListener();
  setupCommentsAutoClose();

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

function closePersonalProfilePanelQuiet() {
  try {
    const profilePanel = document.getElementById('profilePanel');
    const profileFrame = document.getElementById('profilePanelFrame');
    if (profilePanel) profilePanel.hidden = true;
    if (profileFrame) profileFrame.src = '';
  } catch (_) {}
}

function reopenPersonalProfilePanel() {
  try {
    const profilePanel = document.getElementById('profilePanel');
    const profileFrame = document.getElementById('profilePanelFrame');
    if (!profilePanel || !profileFrame) return false;
    if (typeof pauseAllFeedVideos === 'function') {
      pauseAllFeedVideos();
    }
    profileFrame.src = './profile.html?embedded=1';
    profilePanel.hidden = false;
    return true;
  } catch (err) {
    console.warn('[VIDEOS] reopen profile failed', err);
    return false;
  }
}

function reopenPublicProfilePanel(pubkey) {
  try {
    const key = typeof pubkey === 'string' ? pubkey.trim() : '';
    if (!key) return false;
    if (typeof pauseAllFeedVideos === 'function') {
      pauseAllFeedVideos();
    }
    const App = window.NostrApp || {};
    if (typeof App.openProfileByPubkey === 'function') {
      App.openProfileByPubkey(key);
      return true;
    }
    if (typeof window.openProfileByPubkey === 'function') {
      window.openProfileByPubkey(key);
      return true;
    }
    const publicPanel = document.getElementById('publicProfilePanel');
    const publicFrame = document.getElementById('publicProfilePanelFrame');
    if (!publicPanel || !publicFrame) return false;
    const encoded = encodeURIComponent(key.toLowerCase());
    publicFrame.src = `./profile-viewer.html?pubkey=${encoded}&embedded=1&v=20260803d`;
    publicPanel.hidden = false;
    return true;
  } catch (err) {
    console.warn('[VIDEOS] reopen public profile failed', err);
    return false;
  }
}

function ensureOwnPostsBackButton() {
  let btn = document.getElementById('ownPostsFeedBack');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'ownPostsFeedBack';
    btn.type = 'button';
    btn.className = 'videos-own-posts-back';
    btn.setAttribute('aria-label', 'חזרה לפרופיל');
    btn.title = 'חזרה לפרופיל';
    btn.innerHTML = '<i class="fa-solid fa-arrow-right" aria-hidden="true"></i><span>חזרה</span>';
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      exitOwnPostsFeedMode({ reopenProfile: true });
    });
    document.body.appendChild(btn);
  }
  const visible = state.feedMode === 'own-posts';
  btn.hidden = !visible;
  btn.setAttribute('aria-hidden', visible ? 'false' : 'true');
  document.body.classList.toggle('videos-feed-mode-own-posts', visible);
  return btn;
}

function scrollOwnPostsFeedToStart(startEventId, attempt = 0) {
  if (!startEventId || !selectors.stream) return;
  const card = selectors.stream.querySelector(`.videos-feed__card[data-event-id="${startEventId}"]`);
  if (card) {
    try {
      card.scrollIntoView({ behavior: 'auto', block: 'start' });
    } catch (_) {
      const viewport = document.querySelector('.videos-feed__viewport');
      if (viewport) viewport.scrollTop = card.offsetTop || 0;
    }
    return;
  }
  if (attempt < 40) {
    setTimeout(() => scrollOwnPostsFeedToStart(startEventId, attempt + 1), 50);
  }
}

function buildOwnPostsVideosFromEvents(events) {
  const currentApp = window.NostrApp || {};
  const list = [];
  const seen = new Set();
  (Array.isArray(events) ? events : []).forEach((event) => {
    if (!event || !event.id || seen.has(event.id)) return;
    const video = parseEventToVideoItem(event, currentApp);
    if (!video) return;
    seen.add(video.id);
    list.push(video);
  });
  return sortVideosByCreatedAtDesc(list);
}

function enterOwnPostsFeedMode(events, startEventId = null, options = {}) {
  // יוצאים ממצבים אחרים לפני פיד הפוסטים האישי / ציבורי | HYPER CORE TECH
  if (state.feedMode === 'games') {
    document.body.classList.remove('videos-feed-mode-games');
  }
  if (state.feedMode === 'live-tv') {
    document.body.classList.remove('videos-feed-mode-live-tv');
  }

  const returnSource = options && options.source === 'public' ? 'public' : 'personal';
  const returnPubkey = typeof options?.pubkey === 'string' ? options.pubkey.trim() : '';

  closePersonalProfilePanelQuiet();
  closePublicProfilePanel();

  const videos = buildOwnPostsVideosFromEvents(events);
  let resolvedStartId = startEventId || null;
  if (resolvedStartId && !videos.some((v) => v.id === resolvedStartId)) {
    const clicked = (Array.isArray(events) ? events : []).find((e) => e && e.id === resolvedStartId);
    if (clicked && typeof clicked.created_at === 'number') {
      const nearest = videos.find((v) => getVideoCreatedAt(v) <= clicked.created_at);
      resolvedStartId = nearest ? nearest.id : (videos[0] && videos[0].id) || null;
    } else {
      resolvedStartId = (videos[0] && videos[0].id) || null;
    }
  }

  // מתחילים מהפוסט שנלחץ ואז ממשיכים לישנים יותר (ואז עוטפים לחדשים) | HYPER CORE TECH
  if (resolvedStartId && videos.length > 1) {
    const idx = videos.findIndex((v) => v.id === resolvedStartId);
    if (idx > 0) {
      state.ownPostsVideos = videos.slice(idx).concat(videos.slice(0, idx));
    } else {
      state.ownPostsVideos = videos;
    }
  } else {
    state.ownPostsVideos = videos;
  }
  state.ownPostsStartId = resolvedStartId;
  state.ownPostsReturnSource = returnSource;
  state.ownPostsReturnPubkey = returnSource === 'public' ? returnPubkey : null;
  state.feedMode = 'own-posts';
  document.body.classList.add('videos-feed-mode-own-posts');
  document.body.classList.remove('videos-feed-mode-games', 'videos-feed-mode-live-tv');
  ensureOwnPostsBackButton();

  globalAutoplayEnabled = true;
  updateGlobalStopClass();
  forceFullFeedRerender();
  globalAutoplayEnabled = true;
  updateGlobalStopClass();

  if (resolvedStartId) {
    requestAnimationFrame(() => scrollOwnPostsFeedToStart(state.ownPostsVideos[0]?.id || resolvedStartId));
  }

  console.log('[VIDEOS] Own posts feed mode ON', {
    count: state.ownPostsVideos.length,
    start: state.ownPostsStartId,
    returnSource: state.ownPostsReturnSource,
  });
  return true;
}

function exitOwnPostsFeedMode(options = {}) {
  if (state.feedMode !== 'own-posts') {
    ensureOwnPostsBackButton();
    return false;
  }
  const reopenProfile = !!options.reopenProfile;
  const returnSource = state.ownPostsReturnSource || 'personal';
  const returnPubkey = state.ownPostsReturnPubkey || '';
  state.feedMode = 'all';
  state.ownPostsVideos = [];
  state.ownPostsStartId = null;
  state.ownPostsReturnSource = 'personal';
  state.ownPostsReturnPubkey = null;
  document.body.classList.remove('videos-feed-mode-own-posts');
  ensureOwnPostsBackButton();
  forceFullFeedRerender();
  if (reopenProfile) {
    if (returnSource === 'public' && returnPubkey) {
      reopenPublicProfilePanel(returnPubkey);
    } else {
      reopenPersonalProfilePanel();
    }
  } else {
    resumeCenteredFeedVideo();
  }
  console.log('[VIDEOS] Own posts feed mode OFF', { reopenProfile, returnSource });
  return true;
}

function enterGamesFeedMode() {
  if (state.feedMode === 'own-posts') {
    state.ownPostsVideos = [];
    state.ownPostsStartId = null;
    state.ownPostsReturnSource = 'personal';
    state.ownPostsReturnPubkey = null;
    document.body.classList.remove('videos-feed-mode-own-posts');
  }
  state.feedMode = 'games';
  document.body.classList.add('videos-feed-mode-games');
  document.body.classList.remove('videos-feed-mode-live-tv', 'videos-feed-mode-own-posts');
  ensureOwnPostsBackButton();
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
    // רק אחרי מדיה מוכנה — בלי כרטיסיית LIVE ריקה | HYPER CORE TECH
    mediaReadyPromise.then(() => {
      if (state.feedMode !== 'live-tv') return;
      if (!card.isConnected) {
        mountCard(card);
        markCardMediaReady(card);
      }
    }).catch((err) => {
      try { handleCardMediaFailure(card, video.id, err); } catch (_) {}
    });
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
  if (enterLiveTvFeedMode._loading) return true;
  enterLiveTvFeedMode._loading = true;
  try {
    // יוצאים ממצב משחקים / פוסטים שלי אם פתוח – בלי לגעת בפיד הראשי (all) | HYPER CORE TECH
    if (state.feedMode === 'games') {
      document.body.classList.remove('videos-feed-mode-games');
    }
    if (state.feedMode === 'own-posts') {
      state.ownPostsVideos = [];
      state.ownPostsStartId = null;
      document.body.classList.remove('videos-feed-mode-own-posts');
      ensureOwnPostsBackButton();
    }

    // פיד LIVE תמיד מתחיל ב־PLAY | HYPER CORE TECH
    globalAutoplayEnabled = true;
    updateGlobalStopClass();

    // רק הודעת סטטוס – לא מוסיפים class LIVE ולא מוחקים את פיד הבית עד שהערוצים מוכנים | HYPER CORE TECH
    if (selectors.status) {
      selectors.status.textContent = 'טוען ערוצים...';
      selectors.status.style.display = 'block';
    }

    let loaded = [];
    const App = window.NostrApp || {};
    try {
      // רק ערוצים שעברו בדיקה מוצגים | HYPER CORE TECH
      if (typeof App.getReadyLiveTvFeedVideos === 'function') {
        loaded = await App.getReadyLiveTvFeedVideos(10);
      } else {
        if (typeof App.warmInitialLiveTvHealth === 'function') {
          await App.warmInitialLiveTvHealth(16);
        }
        if (typeof App.getLiveTvFeedVideos === 'function') {
          loaded = await App.getLiveTvFeedVideos();
        } else {
          loaded = [];
        }
      }
    } catch (err) {
      console.warn('[VIDEOS] LIVE TV catalog failed', err);
      loaded = [];
    }

    // מעבר ל־IPTV רק עכשיו – class + החלפת DOM ביחד | HYPER CORE TECH
    state.liveTvVideos = Array.isArray(loaded) ? loaded : [];
    state.feedMode = 'live-tv';
    document.body.classList.add('videos-feed-mode-live-tv');
    document.body.classList.remove('videos-feed-mode-own-posts', 'videos-feed-mode-games');
    ensureOwnPostsBackButton();

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
  } finally {
    enterLiveTvFeedMode._loading = false;
  }
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
  if (state.feedMode === 'own-posts') {
    exitOwnPostsFeedMode();
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
  if (exitOwnPostsFeedMode()) closed = true;
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

// חלק שידור חי P2P (videos.js) – הכנסת כרטיס LIVE לפיד רק אחרי וידאו מאומת | HYPER CORE TECH
function upsertP2pLiveFeedCard(room) {
  if (!room || !room.roomId || !room.owner) return;
  if (!room.streamReady) {
    console.log('[videos] skip LIVE card — stream not verified', room.roomId);
    return;
  }
  const safeId = room.cardId || `p2plive-${String(room.roomId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96)}`;
  const pending = (window.NostrApp && window.NostrApp._p2pLivePendingStreams)
    ? window.NostrApp._p2pLivePendingStreams.get(safeId)
    : null;
  if (!pending) {
    console.log('[videos] skip LIVE card — missing pending MediaStream', safeId);
    return;
  }
  const app = window.NostrApp || {};
  const profile = (app.profileCache instanceof Map)
    ? (app.profileCache.get(room.owner) || app.profileCache.get(String(room.owner).toLowerCase()) || {})
    : {};
  const authorName = String(room.name || profile.name || profile.display_name || '').trim() || String(room.owner).slice(0, 8);
  const authorPicture = String(room.picture || profile.picture || '').trim();
  const video = {
    id: safeId,
    pubkey: room.owner,
    content: room.title || 'שידור חי',
    authorName,
    authorInitials: authorName.slice(0, 2).toUpperCase() || 'LV',
    authorPicture,
    createdAt: Math.floor(Date.now() / 1000),
    p2pLive: true,
    p2pLiveOwner: room.owner,
    p2pLiveSlug: room.slug || 'live',
    p2pLiveRoomId: room.roomId,
    p2pLiveStreamReady: true,
  };
  upsertVideoInState(video, { forceShow: true, immediate: true });

    // עדכון אווטאר/שם בכרטיס קיים אחרי fetchProfile | HYPER CORE TECH
  try {
    const media = Array.from(document.querySelectorAll('.videos-feed__media[data-live-room-id]'))
      .find((m) => m.dataset.liveRoomId === room.roomId);
    const card = media && media.closest('.videos-feed__card');
    if (card && (authorPicture || authorName)) {
      const avBtn = card.querySelector('[data-author-button], .videos-feed__author');
      if (avBtn && authorPicture) {
        let img = avBtn.querySelector('img');
        if (!img) {
          img = document.createElement('img');
          avBtn.innerHTML = '';
          avBtn.appendChild(img);
        }
        img.src = authorPicture;
        img.alt = authorName;
      }
      const nameEl = card.querySelector('.videos-feed__author-name, [data-author-name]');
      if (nameEl && authorName) nameEl.textContent = authorName;
    }
  } catch (_) {}

  if (room._profileResolved) return;

  if (typeof app.fetchProfile === 'function') {
    app.fetchProfile(room.owner).then((p) => {
      if (!p) return;
      const nextName = String(p.name || p.display_name || room.name || '').trim();
      const nextPic = String(p.picture || room.picture || '').trim();
      if (nextName === authorName && nextPic === authorPicture) return;
      upsertP2pLiveFeedCard({
        ...room,
        name: nextName,
        picture: nextPic,
        streamReady: true,
        cardId: safeId,
        _profileResolved: true
      });
    }).catch(() => null);
  }
}

function markP2pLiveEnded(roomId, message) {
  const rid = String(roomId || '');
  if (!rid) return;
  const msg = String(message || 'השידור הסתיים');
  document.querySelectorAll('.videos-feed__media[data-media-type="p2p-live"]').forEach((media) => {
    if (media.dataset.liveRoomId !== rid) return;
    const videoEl = media.querySelector('video');
    if (videoEl) {
      try { videoEl.pause(); } catch (_) {}
      try { videoEl.removeAttribute('src'); videoEl.srcObject = null; videoEl.load(); } catch (_) {}
    }
    media.classList.add('videos-p2p-live--ended');
    media.dataset.state = 'ended';
    let overlay = media.querySelector('.videos-p2p-live-ended');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'videos-p2p-live-ended';
      overlay.innerHTML = `
        <div class="videos-p2p-live-ended__card">
          <i class="fa-solid fa-circle-stop" aria-hidden="true"></i>
          <strong>${msg}</strong>
          <span>המשדר סיים את השידור החי</span>
        </div>`;
      media.appendChild(overlay);
    }
    const hint = media.querySelector('.videos-p2p-live-hint');
    if (hint) hint.hidden = true;
    const badge = media.querySelector('.videos-p2p-live-badge');
    if (badge) badge.classList.add('is-off');
  });
  try {
    const app = window.NostrApp;
    if (app && app._p2pLivePendingStreams instanceof Map) {
      const safeId = `p2plive-${rid.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96)}`;
      app._p2pLivePendingStreams.delete(safeId);
    }
  } catch (_) {}
}

function showTransientFeedHint(message) {
  const text = String(message || '').trim();
  if (!text) return;
  let el = document.getElementById('videosTransientHint');
  if (!el) {
    el = document.createElement('div');
    el.id = 'videosTransientHint';
    el.style.cssText = 'position:fixed;left:50%;bottom:88px;transform:translateX(-50%);z-index:9500;max-width:min(92vw,420px);padding:10px 14px;border-radius:12px;background:rgba(0,0,0,.88);color:#fff;font-size:13px;font-weight:700;text-align:center;border:1px solid rgba(0,175,255,.35);pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(showTransientFeedHint._t);
  showTransientFeedHint._t = setTimeout(() => {
    try { el.hidden = true; } catch (_) {}
  }, 4200);
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
window.enterOwnPostsFeedMode = enterOwnPostsFeedMode;
window.exitOwnPostsFeedMode = exitOwnPostsFeedMode;
window.refreshLiveTvFeed = refreshLiveTvFeed;
window.getSharedGamePosts = getSharedGamePosts;
window.softRefreshVideosFeed = softRefreshVideosFeed;
window.resumeCenteredFeedVideo = resumeCenteredFeedVideo;
window.recoverFeedUiAfterCall = recoverFeedUiAfterCall;
window.handleHomeButtonAction = handleHomeButtonAction;
window.clearHomeRefreshArm = clearHomeRefreshArm;
window.isOnVideosFeedPage = isOnVideosFeedPage;
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
  AppRef.enterOwnPostsFeedMode = enterOwnPostsFeedMode;
  AppRef.exitOwnPostsFeedMode = exitOwnPostsFeedMode;
  AppRef.refreshLiveTvFeed = refreshLiveTvFeed;
  AppRef.getSharedGamePosts = getSharedGamePosts;
  AppRef.softRefreshVideosFeed = softRefreshVideosFeed;
  AppRef.resumeCenteredFeedVideo = resumeCenteredFeedVideo;
  AppRef.recoverFeedUiAfterCall = recoverFeedUiAfterCall;
  AppRef.areFeedOverlaysOpen = areFeedOverlaysOpen;
  AppRef.handleHomeButtonAction = handleHomeButtonAction;
  AppRef.clearHomeRefreshArm = clearHomeRefreshArm;
  AppRef.isOnVideosFeedPage = isOnVideosFeedPage;
  AppRef.upsertP2pLiveFeedCard = upsertP2pLiveFeedCard;
  AppRef.markP2pLiveEnded = markP2pLiveEnded;
  AppRef.showTransientFeedHint = showTransientFeedHint;
}

// חשיפה גלובלית לסגירת פאנל פרופיל ציבורי | HYPER CORE TECH
window.closePublicProfilePanel = closePublicProfilePanel;
if (window.NostrApp) {
  window.NostrApp.closePublicProfilePanel = closePublicProfilePanel;
}

// חלק מאזין הודעות (videos.js) – סגירת overlay בקבלת postMessage מ-iframe | HYPER CORE TECH
window.addEventListener('message', function handleOverlayMessage(event) {
  console.log('[VIDEOS] Received postMessage:', event.data);
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'closePublicProfile') {
    console.log('[VIDEOS] Closing public profile panel via postMessage');
    closePublicProfilePanel();
    resumeCenteredFeedVideo();
    return;
  }
  if (data.type === 'closeGames') {
    console.log('[VIDEOS] Closing games panel via postMessage');
    closeGamesPanel();
    resumeCenteredFeedVideo();
    return;
  }
  // בית מתוך iframe פרופיל/משחקים — סגירה + אותו פוסט, בלי רענון | HYPER CORE TECH
  if (data.type === 'closeProfileAndResumeFeed' || data.type === 'closeProfilePanel') {
    console.log('[VIDEOS] Closing profile/games via postMessage + resume feed');
    try {
      const App = window.NostrApp || {};
      if (typeof App.closeAllOverlays === 'function') App.closeAllOverlays();
      else {
        closePublicProfilePanel();
        const profilePanel = document.getElementById('profilePanel');
        const profileFrame = document.getElementById('profilePanelFrame');
        if (profilePanel) profilePanel.hidden = true;
        if (profileFrame) profileFrame.src = '';
        closeGamesPanel();
      }
    } catch (_) {}
    resumeCenteredFeedVideo();
    return;
  }
  // חלק פיד פוסטים (videos.js) – פתיחה מתוך גריד פרופיל אישי / ציבורי | HYPER CORE TECH
  if (data.type === 'openOwnPostsFeed') {
    const events = Array.isArray(data.events) ? data.events : [];
    const startEventId = typeof data.startEventId === 'string' ? data.startEventId : null;
    const source = data.source === 'public' ? 'public' : 'personal';
    const pubkey = typeof data.pubkey === 'string' ? data.pubkey : '';
    console.log('[VIDEOS] Opening own posts feed via postMessage', {
      count: events.length,
      startEventId,
      source,
    });
    enterOwnPostsFeedMode(events, startEventId, { source, pubkey });
    return;
  }
  if (data.type === 'openTriviaGame') {
    closeGamesPanel();
    if (typeof window.NostrApp?.openTriviaGame === 'function') {
      window.NostrApp.openTriviaGame();
    }
  }
  if (data.type === 'openDoomGame') {
    closeGamesPanel();
    window.open('./doom-multiplayer.html', 'doomGame', 'width=1200,height=800');
  }
});
