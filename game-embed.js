// חלק משחק בפיד (game-embed.js) – זיהוי, פרילוד, מסך מלא והטמעת HTML5 | HYPER CORE TECH
(function initGameEmbed(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const GAME_HOST_RE = /(github\.io|itch\.io|gamh5\.com|krunker\.io|famobi\.com|poki\.com|crazygames\.com|gamedistribution\.com|html5games|newgrounds\.com)/i;
  const GAME_PATH_RE = /\/(game|games|play|mobile|mobileapp|arcade|html5|full)(\/|$)/i;
  const MEDIA_EXT_RE = /\.(mp4|webm|ogg|mov|m4v|m3u8|jpg|jpeg|png|gif|webp|svg|pdf)(\?|#|$)/i;

  function isPlayableGameUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!/^https:\/\//i.test(trimmed)) return false;
    if (MEDIA_EXT_RE.test(trimmed)) return false;
    if (typeof App.isHlsLiveUrl === 'function' && App.isHlsLiveUrl(trimmed)) return false;
    if (/youtube\.com|youtu\.be/i.test(trimmed)) return false;
    if (/blossom|void\.cat|nostr\.build|satellite\.earth/i.test(trimmed)) return false;
    if (GAME_HOST_RE.test(trimmed)) return true;
    if (GAME_PATH_RE.test(trimmed)) return true;
    return false;
  }

  function extractGameUrlFromText(text) {
    if (!text) return '';
    const match = String(text).match(/https:\/\/[^\s]+/gi);
    if (!match) return '';
    for (let i = 0; i < match.length; i += 1) {
      const clean = String(match[i] || '').replace(/[),.;]+$/g, '');
      if (isPlayableGameUrl(clean)) return clean;
    }
    return '';
  }

  function ensureGameBadge(mediaDiv) {
    if (!mediaDiv) return null;
    let badge = mediaDiv.querySelector('.videos-game-badge');
    if (badge) return badge;
    badge = document.createElement('div');
    badge.className = 'videos-game-badge';
    badge.setAttribute('aria-label', 'HTML5 game');
    badge.innerHTML = '<i class="fa-solid fa-gamepad" aria-hidden="true"></i><span class="videos-game-badge__text">PLAY GAME</span>';
    mediaDiv.appendChild(badge);
    return badge;
  }

  function setGamePlaceholder(mediaDiv, text) {
    let placeholder = mediaDiv.querySelector('.videos-feed__game-placeholder');
    if (!placeholder) {
      placeholder = document.createElement('div');
      placeholder.className = 'videos-feed__game-placeholder';
      placeholder.setAttribute('data-game-tap-zone', '');
      mediaDiv.appendChild(placeholder);
    }
    placeholder.innerHTML = '<i class="fa-solid fa-gamepad"></i><span></span>';
    const span = placeholder.querySelector('span');
    if (span) span.textContent = text || 'טוען משחק...';
    placeholder.hidden = false;
    return placeholder;
  }

  function ensureGameFrame(mediaDiv, url, options = {}) {
    if (!mediaDiv || !url) return null;
    ensureGameBadge(mediaDiv);
    ensureGameFullscreenControls(mediaDiv);

    let iframe = mediaDiv.querySelector('iframe.videos-feed__game-iframe');
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.className = 'videos-feed__game-iframe';
      iframe.setAttribute('title', 'Embedded game');
      iframe.setAttribute('allowfullscreen', 'true');
      iframe.setAttribute(
        'allow',
        'fullscreen; gamepad; accelerometer; gyroscope; autoplay; clipboard-write'
      );
      iframe.setAttribute(
        'sandbox',
        'allow-scripts allow-same-origin allow-pointer-lock allow-popups allow-forms allow-modals'
      );
      iframe.referrerPolicy = 'no-referrer-when-downgrade';
      mediaDiv.insertBefore(iframe, mediaDiv.firstChild);
      iframe.addEventListener('load', () => {
        if (iframe.dataset.loadedUrl) {
          mediaDiv.dataset.gamePrepared = '1';
          const ph = mediaDiv.querySelector('.videos-feed__game-placeholder');
          if (ph && mediaDiv.classList.contains('is-game-active')) ph.hidden = true;
        }
      });
    }

    if (options.load && iframe.dataset.loadedUrl !== url) {
      setGamePlaceholder(mediaDiv, options.loadingLabel || 'טוען משחק...');
      iframe.src = url;
      iframe.dataset.loadedUrl = url;
    }
    return iframe;
  }

  function unloadGameFrame(mediaDiv) {
    if (!mediaDiv) return;
    if (mediaDiv.classList.contains('is-game-fullscreen')) {
      exitGameFullscreen(mediaDiv);
    }
    const iframe = mediaDiv.querySelector('iframe.videos-feed__game-iframe');
    if (!iframe) return;
    try {
      iframe.src = 'about:blank';
    } catch (_) {}
    delete iframe.dataset.loadedUrl;
    mediaDiv.dataset.gamePrepared = '0';
  }

  // חימום מראש – כמו ערוץ חי | HYPER CORE TECH
  function prepareGameMedia(mediaDiv, options = {}) {
    if (!mediaDiv) return;
    const url = mediaDiv.dataset.gameUrl || '';
    if (!url) return;
    if (mediaDiv.dataset.gamePrepared === '1' && mediaDiv.querySelector('iframe.videos-feed__game-iframe')) {
      return;
    }
    ensureGameFrame(mediaDiv, url, {
      load: true,
      loadingLabel: options.loadingLabel || 'טוען משחק...',
    });
  }

  function activateGameMedia(mediaDiv) {
    if (!mediaDiv) return;
    const url = mediaDiv.dataset.gameUrl || '';
    if (!url) return;
    mediaDiv.classList.add('is-game-active');
    prepareGameMedia(mediaDiv, { loadingLabel: 'טוען משחק...' });
    const iframe = mediaDiv.querySelector('iframe.videos-feed__game-iframe');
    const placeholder = mediaDiv.querySelector('.videos-feed__game-placeholder');
    if (iframe && mediaDiv.dataset.gamePrepared === '1') {
      if (placeholder) placeholder.hidden = true;
    } else if (placeholder) {
      placeholder.hidden = false;
      const span = placeholder.querySelector('span');
      if (span) span.textContent = 'טוען משחק...';
    }
    const overlay = mediaDiv.querySelector('[data-play-toggle]');
    if (overlay) overlay.style.display = 'none';
    ensureGameFullscreenControls(mediaDiv);
  }

  // עצירה רכה – שומרת iframe חם כמו ערוץ חי | HYPER CORE TECH
  function softDeactivateGameMedia(mediaDiv) {
    if (!mediaDiv) return;
    if (mediaDiv.classList.contains('is-game-fullscreen')) {
      exitGameFullscreen(mediaDiv);
    }
    mediaDiv.classList.remove('is-game-active');
    const overlay = mediaDiv.querySelector('[data-play-toggle]');
    if (overlay) overlay.style.display = 'none';
  }

  function deactivateGameMedia(mediaDiv) {
    if (!mediaDiv) return;
    softDeactivateGameMedia(mediaDiv);
    unloadGameFrame(mediaDiv);
    setGamePlaceholder(mediaDiv, 'טוען משחק...');
  }

  function clearFsChromeTimer(mediaDiv) {
    if (!mediaDiv || !mediaDiv._gameFsChromeTimer) return;
    clearTimeout(mediaDiv._gameFsChromeTimer);
    mediaDiv._gameFsChromeTimer = null;
  }

  function showGameFsChrome(mediaDiv) {
    if (!mediaDiv || !mediaDiv.classList.contains('is-game-fullscreen')) return;
    const closeBtn = mediaDiv.querySelector('.videos-game-fs-close');
    if (!closeBtn) return;
    closeBtn.hidden = false;
    closeBtn.classList.remove('is-fs-chrome-hidden');
    mediaDiv.classList.add('is-fs-chrome-visible');
    clearFsChromeTimer(mediaDiv);
    mediaDiv._gameFsChromeTimer = setTimeout(() => {
      hideGameFsChrome(mediaDiv);
    }, 5000);
  }

  function hideGameFsChrome(mediaDiv) {
    if (!mediaDiv) return;
    clearFsChromeTimer(mediaDiv);
    const closeBtn = mediaDiv.querySelector('.videos-game-fs-close');
    if (closeBtn) closeBtn.classList.add('is-fs-chrome-hidden');
    mediaDiv.classList.remove('is-fs-chrome-visible');
  }

  function ensureGameFullscreenControls(mediaDiv) {
    if (!mediaDiv) return;
    if (mediaDiv.querySelector('.videos-game-fs-btn')) return;

    const fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.className = 'videos-game-fs-btn';
    fsBtn.setAttribute('aria-label', 'מסך מלא');
    fsBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
    fsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      enterGameFullscreen(mediaDiv);
    });
    mediaDiv.appendChild(fsBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'videos-game-fs-close';
    closeBtn.setAttribute('aria-label', 'סגור מסך מלא');
    closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    closeBtn.hidden = true;
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      exitGameFullscreen(mediaDiv);
    });
    mediaDiv.appendChild(closeBtn);

    // רצועת מגע עליונה – iframe חוצה-מקור לא מעביר קליקים להורה | HYPER CORE TECH
    let edge = mediaDiv.querySelector('.videos-game-fs-edge');
    if (!edge) {
      edge = document.createElement('div');
      edge.className = 'videos-game-fs-edge';
      edge.setAttribute('aria-hidden', 'true');
      mediaDiv.appendChild(edge);
    }
    const revealFromEdge = (e) => {
      if (!mediaDiv.classList.contains('is-game-fullscreen')) return;
      e.preventDefault();
      e.stopPropagation();
      showGameFsChrome(mediaDiv);
    };
    edge.addEventListener('click', revealFromEdge);
    edge.addEventListener('touchend', revealFromEdge, { passive: false });
  }

  function enterGameFullscreen(mediaDiv) {
    if (!mediaDiv) return;
    const existing = document.querySelector('.videos-feed__media.is-game-fullscreen');
    if (existing && existing !== mediaDiv) exitGameFullscreen(existing);
    // גם לצאת ממסך מלא של ערוץ חי אם פתוח
    if (typeof App.exitLiveFullscreen === 'function') {
      const liveFs = document.querySelector('.videos-feed__media.is-live-fullscreen');
      if (liveFs) App.exitLiveFullscreen(liveFs);
    }

    activateGameMedia(mediaDiv);
    mediaDiv.classList.add('is-game-fullscreen');
    document.body.classList.add('game-embed-fullscreen');
    const fsBtn = mediaDiv.querySelector('.videos-game-fs-btn');
    if (fsBtn) fsBtn.hidden = true;
    showGameFsChrome(mediaDiv);

    try {
      if (mediaDiv.requestFullscreen) mediaDiv.requestFullscreen().catch(() => {});
      else if (mediaDiv.webkitRequestFullscreen) mediaDiv.webkitRequestFullscreen();
    } catch (_) {}
  }

  function exitGameFullscreen(mediaDiv) {
    if (!mediaDiv) {
      document.body.classList.remove('game-embed-fullscreen');
      return;
    }
    clearFsChromeTimer(mediaDiv);
    mediaDiv.classList.remove('is-game-fullscreen', 'is-fs-chrome-visible');
    document.body.classList.remove('game-embed-fullscreen');
    const closeBtn = mediaDiv.querySelector('.videos-game-fs-close');
    const fsBtn = mediaDiv.querySelector('.videos-game-fs-btn');
    if (closeBtn) {
      closeBtn.hidden = true;
      closeBtn.classList.remove('is-fs-chrome-hidden');
    }
    if (fsBtn) fsBtn.hidden = false;

    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    } catch (_) {}
  }

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      document.querySelectorAll('.videos-feed__media.is-game-fullscreen').forEach((el) => {
        clearFsChromeTimer(el);
        el.classList.remove('is-game-fullscreen', 'is-fs-chrome-visible');
        const closeBtn = el.querySelector('.videos-game-fs-close');
        const fsBtn = el.querySelector('.videos-game-fs-btn');
        if (closeBtn) {
          closeBtn.hidden = true;
          closeBtn.classList.remove('is-fs-chrome-hidden');
        }
        if (fsBtn) fsBtn.hidden = false;
      });
      document.body.classList.remove('game-embed-fullscreen');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = document.querySelector('.videos-feed__media.is-game-fullscreen');
      if (open) exitGameFullscreen(open);
    }
  });

  function buildComposeGamePreview(url) {
    const wrap = document.createElement('div');
    wrap.className = 'compose-game-preview';
    wrap.innerHTML = [
      '<div class="compose-game-preview__badge"><i class="fa-solid fa-gamepad"></i> PLAY GAME</div>',
      '<div class="compose-game-preview__title">משחק HTML5 מזוהה</div>',
      '<div class="compose-game-preview__url"></div>',
      '<div class="compose-game-preview__hint">יפורסם כפוסט שניתן לשחק מתוך הפיד</div>',
    ].join('');
    const urlEl = wrap.querySelector('.compose-game-preview__url');
    if (urlEl) urlEl.textContent = url;
    return wrap;
  }

  Object.assign(App, {
    isPlayableGameUrl,
    extractGameUrlFromText,
    ensureGameBadge,
    ensureGameFrame,
    prepareGameMedia,
    unloadGameFrame,
    activateGameMedia,
    softDeactivateGameMedia,
    deactivateGameMedia,
    ensureGameFullscreenControls,
    enterGameFullscreen,
    exitGameFullscreen,
    buildComposeGamePreview,
  });

  window.SosGameEmbed = {
    isPlayableGameUrl,
    extractGameUrlFromText,
    prepareGameMedia,
    activateGameMedia,
    softDeactivateGameMedia,
    deactivateGameMedia,
    enterGameFullscreen,
    exitGameFullscreen,
    buildComposeGamePreview,
  };
})(window);
