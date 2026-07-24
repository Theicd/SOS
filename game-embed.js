// חלק משחק בפיד (game-embed.js) – זיהוי, סקייל למסגרת, מסך מלא | HYPER CORE TECH
(function initGameEmbed(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const GAME_HOST_RE = /(github\.io|itch\.io|gamh5\.com|krunker\.io|famobi\.com|poki\.com|crazygames\.com|gamedistribution\.com|html5games|newgrounds\.com)/i;
  const GAME_PATH_RE = /\/(game|games|play|mobile|mobileapp|arcade|html5|full)(\/|$)/i;
  const MEDIA_EXT_RE = /\.(mp4|webm|ogg|mov|m4v|m3u8|jpg|jpeg|png|gif|webp|svg|pdf)(\?|#|$)/i;
  const DEFAULT_GAME_W = 960;
  const DEFAULT_GAME_H = 540;

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

  // מסיר באדג' ישן אם קיים – לא מציגים PLAY GAME בפיד | HYPER CORE TECH
  function removeGameBadge(mediaDiv) {
    if (!mediaDiv) return;
    mediaDiv.querySelectorAll('.videos-game-badge').forEach((el) => el.remove());
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

  function detectNativeGameSize(iframe) {
    let w = DEFAULT_GAME_W;
    let h = DEFAULT_GAME_H;
    try {
      const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
      if (doc) {
        const canvas = doc.querySelector('canvas');
        if (canvas) {
          const cw = canvas.width || canvas.clientWidth || 0;
          const ch = canvas.height || canvas.clientHeight || 0;
          if (cw > 80 && ch > 80) {
            w = cw;
            h = ch;
          }
        } else {
          const root = doc.documentElement;
          const body = doc.body;
          const iw = Math.max(root?.clientWidth || 0, body?.clientWidth || 0, iframe.contentWindow?.innerWidth || 0);
          const ih = Math.max(root?.clientHeight || 0, body?.clientHeight || 0, iframe.contentWindow?.innerHeight || 0);
          if (iw > 80 && ih > 80) {
            w = iw;
            h = ih;
          }
        }
      }
    } catch (_) {
      // cross-origin – נשארים עם ברירת מחדל landscape
    }
    return { w, h };
  }

  function fitGameStage(mediaDiv) {
    if (!mediaDiv) return;
    const stage = mediaDiv.querySelector('.videos-feed__game-stage');
    const scaler = mediaDiv.querySelector('.videos-feed__game-scaler');
    const iframe = mediaDiv.querySelector('iframe.videos-feed__game-iframe');
    if (!stage || !scaler || !iframe) return;

    const cw = stage.clientWidth || mediaDiv.clientWidth || 1;
    const ch = stage.clientHeight || mediaDiv.clientHeight || 1;
    const gw = Number(scaler.dataset.gameW) || DEFAULT_GAME_W;
    const gh = Number(scaler.dataset.gameH) || DEFAULT_GAME_H;
    if (gw < 1 || gh < 1 || cw < 1 || ch < 1) return;

    const scale = Math.min(cw / gw, ch / gh);
    scaler.style.width = `${gw}px`;
    scaler.style.height = `${gh}px`;
    scaler.style.transform = `scale(${scale})`;
  }

  function bindStageResize(mediaDiv, stage) {
    if (!mediaDiv || !stage) return;
    if (mediaDiv._gameResizeObserver) {
      try {
        mediaDiv._gameResizeObserver.disconnect();
      } catch (_) {}
    }
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => fitGameStage(mediaDiv));
      ro.observe(stage);
      mediaDiv._gameResizeObserver = ro;
    }
  }

  function ensureGameStage(mediaDiv) {
    let stage = mediaDiv.querySelector('.videos-feed__game-stage');
    if (!stage) {
      stage = document.createElement('div');
      stage.className = 'videos-feed__game-stage';
      mediaDiv.insertBefore(stage, mediaDiv.firstChild);
    }
    let scaler = stage.querySelector('.videos-feed__game-scaler');
    if (!scaler) {
      scaler = document.createElement('div');
      scaler.className = 'videos-feed__game-scaler';
      scaler.dataset.gameW = String(DEFAULT_GAME_W);
      scaler.dataset.gameH = String(DEFAULT_GAME_H);
      stage.appendChild(scaler);
    }
    bindStageResize(mediaDiv, stage);
    return { stage, scaler };
  }

  function ensureGameFrame(mediaDiv, url, options = {}) {
    if (!mediaDiv || !url) return null;
    removeGameBadge(mediaDiv);
    ensureGameFullscreenControls(mediaDiv);

    const { scaler } = ensureGameStage(mediaDiv);
    let iframe = scaler.querySelector('iframe.videos-feed__game-iframe');
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
      scaler.appendChild(iframe);
      iframe.addEventListener('load', () => {
        if (!iframe.dataset.loadedUrl) return;
        mediaDiv.dataset.gamePrepared = '1';
        const size = detectNativeGameSize(iframe);
        scaler.dataset.gameW = String(size.w);
        scaler.dataset.gameH = String(size.h);
        fitGameStage(mediaDiv);
        // ניסיון שני אחרי שהמשחק מסיים init | HYPER CORE TECH
        setTimeout(() => {
          const again = detectNativeGameSize(iframe);
          scaler.dataset.gameW = String(again.w);
          scaler.dataset.gameH = String(again.h);
          fitGameStage(mediaDiv);
        }, 400);
        const ph = mediaDiv.querySelector('.videos-feed__game-placeholder');
        if (ph && mediaDiv.classList.contains('is-game-active')) ph.hidden = true;
      });
    }

    if (options.load && iframe.dataset.loadedUrl !== url) {
      setGamePlaceholder(mediaDiv, options.loadingLabel || 'טוען משחק...');
      iframe.src = url;
      iframe.dataset.loadedUrl = url;
    }

    requestAnimationFrame(() => fitGameStage(mediaDiv));
    return iframe;
  }

  function unloadGameFrame(mediaDiv) {
    if (!mediaDiv) return;
    if (mediaDiv.classList.contains('is-game-fullscreen')) {
      exitGameFullscreen(mediaDiv);
    }
    if (mediaDiv._gameResizeObserver) {
      try {
        mediaDiv._gameResizeObserver.disconnect();
      } catch (_) {}
      mediaDiv._gameResizeObserver = null;
    }
    const iframe = mediaDiv.querySelector('iframe.videos-feed__game-iframe');
    if (iframe) {
      try {
        iframe.src = 'about:blank';
      } catch (_) {}
      delete iframe.dataset.loadedUrl;
    }
    const stage = mediaDiv.querySelector('.videos-feed__game-stage');
    if (stage) stage.remove();
    mediaDiv.dataset.gamePrepared = '0';
  }

  function prepareGameMedia(mediaDiv, options = {}) {
    if (!mediaDiv) return;
    const url = mediaDiv.dataset.gameUrl || '';
    if (!url) return;
    if (mediaDiv.dataset.gamePrepared === '1' && mediaDiv.querySelector('iframe.videos-feed__game-iframe')) {
      fitGameStage(mediaDiv);
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
    requestAnimationFrame(() => fitGameStage(mediaDiv));
  }

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

    const afterLayout = () => {
      fitGameStage(mediaDiv);
      requestAnimationFrame(() => fitGameStage(mediaDiv));
    };

    try {
      const req = mediaDiv.requestFullscreen
        ? mediaDiv.requestFullscreen()
        : (mediaDiv.webkitRequestFullscreen ? Promise.resolve(mediaDiv.webkitRequestFullscreen()) : null);
      if (req && typeof req.then === 'function') {
        req.then(afterLayout).catch(afterLayout);
      } else {
        afterLayout();
      }
    } catch (_) {
      afterLayout();
    }
    setTimeout(afterLayout, 50);
    setTimeout(afterLayout, 250);
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

    requestAnimationFrame(() => fitGameStage(mediaDiv));
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
        requestAnimationFrame(() => fitGameStage(el));
      });
      document.body.classList.remove('game-embed-fullscreen');
    } else if (document.fullscreenElement.classList?.contains('videos-feed__media--game')
      || document.fullscreenElement.classList?.contains('is-game-fullscreen')) {
      fitGameStage(document.fullscreenElement);
    }
  });

  window.addEventListener('resize', () => {
    document.querySelectorAll('.videos-feed__media--game').forEach((el) => fitGameStage(el));
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
      '<div class="compose-game-preview__badge"><i class="fa-solid fa-gamepad"></i> משחק</div>',
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
    removeGameBadge,
    ensureGameFrame,
    fitGameStage,
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
    fitGameStage,
    prepareGameMedia,
    activateGameMedia,
    softDeactivateGameMedia,
    deactivateGameMedia,
    enterGameFullscreen,
    exitGameFullscreen,
    buildComposeGamePreview,
  };
})(window);
