(function initUtils(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  App.escapeHtml = function escapeHtml(value = '') {
    return value.replace(/[&<>"]'/g, (char) => {
      switch (char) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#039;';
        default:
          return char;
      }
    });
  };

  // חלק פרופיל ציבורי (utils.js) – פתיחת פרופיל משתמש אחר כ-overlay ללא רענון הפיד | HYPER CORE TECH
  App.openProfileByPubkey = function openProfileByPubkey(pubkey) {
    if (!pubkey || typeof pubkey !== 'string' || !pubkey.trim()) {
      return;
    }
    const normalized = pubkey.trim().toLowerCase();
    const encoded = encodeURIComponent(normalized);
    try {
      window.sessionStorage?.setItem('nostr_last_profile_view', normalized);
    } catch (err) {
      console.warn('Failed persisting last profile view', err);
    }
    try {
      window.localStorage?.setItem('nostr_last_profile_view', normalized);
    } catch (err) {
      console.warn('Failed persisting last profile view to localStorage', err);
    }
    // ניסיון לפתוח כ-overlay בתוך videos.html (אם קיים publicProfilePanel)
    const publicPanel = document.getElementById('publicProfilePanel');
    const publicFrame = document.getElementById('publicProfilePanelFrame');
    if (publicPanel && publicFrame) {
      publicFrame.src = `./profile-viewer.html?pubkey=${encoded}&embedded=1`;
      publicPanel.hidden = false;
      console.log('[UTILS] Public profile opened as overlay:', normalized.slice(0, 8));
      return;
    }
    // Fallback – ניווט לדף נפרד אם אין overlay זמין
    window.location.href = `./profile-viewer.html?pubkey=${encoded}`;
  };

  // חלק כלי ניווט (utils.js) – תאימות מאזינים שמצפים לפונקציה גלובלית על window
  // מודולים מסוימים (למשל profile-post.js / feed.js) בודקים window.openProfileByPubkey
  // לכן ניצור alias ל-App.openProfileByPubkey על ה-window כדי להבטיח תאימות לאחור.
  if (typeof window.openProfileByPubkey !== 'function') {
    window.openProfileByPubkey = App.openProfileByPubkey;
  }

  App.getInitials = function getInitials(source = '') {
    const words = source.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return 'AN';
    }
    return words
      .map((word) => word[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  };

  App.resizeImageToDataUrl = async function resizeImageToDataUrl(
    file,
    maxWidth = 256,
    maxHeight = 256,
    quality = 0.85
  ) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxWidth || height > maxHeight) {
            const widthRatio = maxWidth / width;
            const heightRatio = maxHeight / height;
            const ratio = Math.min(widthRatio, heightRatio);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          let dataUrl = canvas.toDataURL('image/jpeg', quality);
          if (dataUrl.length > window.NostrApp.MAX_INLINE_PICTURE_LENGTH && quality > 0.4) {
            resolve(App.resizeImageToDataUrl(file, maxWidth / 1.5, maxHeight / 1.5, quality - 0.1));
            return;
          }
          resolve(dataUrl);
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  if (typeof window.registerMyClickListener !== 'function') {
    window.registerMyClickListener = function registerMyClickListener(selector, handler, options = {}) {
      if (typeof handler !== 'function') {
        console.warn('registerMyClickListener requires a handler function');
        return () => {};
      }

      const root = options.root || document;
      const mode = options.mode || 'delegate';

      if (mode === 'direct') {
        const targets = typeof selector === 'string' ? root.querySelectorAll(selector) : selector;
        if (!targets || typeof targets.forEach !== 'function') {
          console.warn('registerMyClickListener: no targets found for direct mode');
          return () => {};
        }
        const listeners = [];
        targets.forEach((el) => {
          if (!el) return;
          const wrapped = (event) => handler(event, el);
          el.addEventListener('click', wrapped);
          listeners.push({ el, wrapped });
        });
        return () => listeners.forEach(({ el, wrapped }) => el.removeEventListener('click', wrapped));
      }

      const clickTarget = root;
      const wrapped = (event) => {
        const target = event.target?.closest?.(selector);
        if (target) {
          handler(event, target);
        }
      };
      clickTarget.addEventListener('click', wrapped);
      return () => clickTarget.removeEventListener('click', wrapped);
    };
  }

  const MEDIA_GUARD_BLOCK_MS = 10 * 60 * 1000; // 10 דקות חסימה
  const MEDIA_GUARD_THRESHOLD = 3;
  const RUNNING_VIA_CF_TUNNEL = typeof window.location?.hostname === 'string' && window.location.hostname.includes('trycloudflare.com');
  const DEFAULT_TUNNEL_BLOCKED_HOSTS = new Set(['r2a.primal.net', 'blossom.primal.net']);

  App._mediaHostFailures = App._mediaHostFailures || new Map();

  App.shouldAttemptMediaFetch = function shouldAttemptMediaFetch(url) {
    if (!url) {
      return true;
    }
    try {
      const host = new URL(url).host;
      if (RUNNING_VIA_CF_TUNNEL && DEFAULT_TUNNEL_BLOCKED_HOSTS.has(host)) {
        return false;
      }
      const entry = App._mediaHostFailures.get(host);
      if (!entry) {
        return true;
      }
      if (entry.blockedUntil && Date.now() < entry.blockedUntil) {
        return false;
      }
      if (entry.blockedUntil && Date.now() >= entry.blockedUntil) {
        App._mediaHostFailures.delete(host);
        return true;
      }
      return true;
    } catch (err) {
      console.warn('shouldAttemptMediaFetch: invalid URL', err);
      return true;
    }
  };

  App.registerMediaFetchFailure = function registerMediaFetchFailure(url, reason = '') {
    if (!url) {
      return;
    }
    try {
      const host = new URL(url).host;
      const entry = App._mediaHostFailures.get(host) || { fails: 0 };
      entry.fails += 1;
      entry.lastReason = reason;
      if (entry.fails >= MEDIA_GUARD_THRESHOLD) {
        entry.blockedUntil = Date.now() + MEDIA_GUARD_BLOCK_MS;
      }
      App._mediaHostFailures.set(host, entry);
    } catch (err) {
      console.warn('registerMediaFetchFailure: invalid URL', err);
    }
  };

  App.registerMediaFetchSuccess = function registerMediaFetchSuccess(url) {
    if (!url) {
      return;
    }
    try {
      const host = new URL(url).host;
      App._mediaHostFailures.delete(host);
    } catch (err) {
      console.warn('registerMediaFetchSuccess: invalid URL', err);
    }
  };
})(window);
