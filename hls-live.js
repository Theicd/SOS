// חלק ערוץ חי HLS (hls-live.js) – זיהוי, בדיקה, ניגון וטעינת רקע ללינקי m3u8 | HYPER CORE TECH
(function initHlsLive(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const healthCache = new Map(); // url -> { ok, checkedAt, reason }
  const HEALTH_TTL_MS = 5 * 60 * 1000;
  const hlsInstances = new WeakMap(); // videoEl -> Hls instance

  const HLS_URL_RE = /\.m3u8(\?|#|$)/i;
  const HLS_HINT_RE = /(mediatailor|amagi\.tv|\/hls\/|\/playlist\.m3u8|mpegurl|LINEAR-)/i;

  function isHlsLiveUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) return false;
    return HLS_URL_RE.test(trimmed) || HLS_HINT_RE.test(trimmed);
  }

  function extractHlsUrlFromText(text) {
    if (!text) return '';
    const lines = String(text).split(/\s+/);
    for (let i = 0; i < lines.length; i += 1) {
      const token = String(lines[i] || '').trim();
      if (isHlsLiveUrl(token)) return token;
    }
    const match = String(text).match(/https?:\/\/[^\s]+/gi);
    if (!match) return '';
    for (let j = 0; j < match.length; j += 1) {
      if (isHlsLiveUrl(match[j])) return match[j];
    }
    return '';
  }

  function canNativeHls(videoEl) {
    try {
      return !!(videoEl && videoEl.canPlayType && videoEl.canPlayType('application/vnd.apple.mpegurl'));
    } catch (_) {
      return false;
    }
  }

  function getCachedHealth(url) {
    const entry = healthCache.get(url);
    if (!entry) return null;
    if (Date.now() - entry.checkedAt > HEALTH_TTL_MS) {
      healthCache.delete(url);
      return null;
    }
    return entry;
  }

  async function checkHlsHealth(url, options = {}) {
    const force = !!options.force;
    if (!url) return { ok: false, reason: 'empty', checkedAt: Date.now() };
    if (!force) {
      const cached = getCachedHealth(url);
      if (cached) return cached;
    }

    let result = { ok: false, reason: 'unknown', checkedAt: Date.now() };
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => {
        try { controller.abort(); } catch (_) {}
      }, options.timeoutMs || 8000) : null;

      const res = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      });
      if (timer) clearTimeout(timer);

      if (!res.ok) {
        result = { ok: false, reason: 'http-' + res.status, checkedAt: Date.now() };
      } else {
        const text = await res.text();
        if (/#EXTM3U/i.test(text)) {
          result = { ok: true, reason: 'playlist', checkedAt: Date.now() };
        } else {
          result = { ok: false, reason: 'not-m3u8', checkedAt: Date.now() };
        }
      }
    } catch (err) {
      // CORS / network — ננסה לנגן בכל זאת (חלק מה־CDN מאפשרים ל־MSE)
      result = {
        ok: true,
        unverified: true,
        reason: (err && err.name === 'AbortError') ? 'timeout' : 'cors-or-network',
        checkedAt: Date.now(),
      };
    }

    healthCache.set(url, result);
    return result;
  }

  function destroyHls(videoEl) {
    if (!videoEl) return;
    const inst = hlsInstances.get(videoEl);
    if (inst) {
      try { inst.destroy(); } catch (_) {}
      hlsInstances.delete(videoEl);
    }
    try {
      videoEl.removeAttribute('src');
      videoEl.load();
    } catch (_) {}
  }

  function ensureLiveBadge(mediaDiv) {
    if (!mediaDiv) return null;
    let badge = mediaDiv.querySelector('.videos-live-badge');
    if (badge) return badge;
    badge = document.createElement('div');
    badge.className = 'videos-live-badge';
    badge.setAttribute('aria-label', 'שידור חי');
    badge.innerHTML = '<span class="videos-live-badge__dot" aria-hidden="true"></span><span class="videos-live-badge__text">LIVE</span>';
    mediaDiv.appendChild(badge);
    ensureFullscreenControls(mediaDiv);
    return badge;
  }

  function ensureTuningOverlay(mediaDiv) {
    if (!mediaDiv) return null;
    let overlay = mediaDiv.querySelector('.videos-live-tuning');
    // אם יש overlay ישן בלי canvas שלג – בונים מחדש | HYPER CORE TECH
    if (overlay && !overlay.querySelector('canvas.videos-live-tuning__snow')) {
      stopTuningFx(overlay);
      overlay.remove();
      overlay = null;
    }
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.className = 'videos-live-tuning';
    overlay.hidden = true;
    overlay.innerHTML = [
      '<canvas class="videos-live-tuning__snow" aria-hidden="true"></canvas>',
      '<div class="videos-live-tuning__vignette" aria-hidden="true"></div>',
      '<div class="videos-live-tuning__center">',
      '  <div class="videos-live-tuning__label">מחפש ערוץ...</div>',
      '  <div class="videos-live-tuning__meter" aria-hidden="true">',
      '    <div class="videos-live-tuning__meter-track">',
      '      <div class="videos-live-tuning__meter-fill" data-live-meter></div>',
      '    </div>',
      '  </div>',
      '  <div class="videos-live-tuning__pct"><span data-live-pct>0</span>%</div>',
      '</div>',
    ].join('');
    mediaDiv.appendChild(overlay);
    return overlay;
  }

  function setTuningVisible(mediaDiv, visible, label) {
    const overlay = ensureTuningOverlay(mediaDiv);
    if (!overlay) return;
    overlay.hidden = !visible;
    mediaDiv.classList.toggle('is-live-tuning', !!visible);
    if (label) {
      const labelEl = overlay.querySelector('.videos-live-tuning__label');
      if (labelEl) labelEl.textContent = label;
    }
    if (visible) {
      startTuningFx(overlay);
    } else {
      stopTuningFx(overlay);
      const fill = overlay.querySelector('[data-live-meter]');
      const pct = overlay.querySelector('[data-live-pct]');
      if (fill) fill.style.width = '100%';
      if (pct) pct.textContent = '100';
    }
  }

  // שלג TV אנלוגי – רעש אפור אקראי (לא נקודות CSS) | HYPER CORE TECH
  function drawTvStatic(canvas) {
    if (!canvas) return;
    const parent = canvas.parentElement;
    const w = Math.max(160, Math.floor((parent && parent.clientWidth) || window.innerWidth || 320));
    const h = Math.max(160, Math.floor((parent && parent.clientHeight) || window.innerHeight || 480));
    const cw = Math.min(220, Math.max(120, Math.floor(w / 3)));
    const ch = Math.min(400, Math.max(180, Math.floor(h / 3)));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    const imageData = ctx.createImageData(cw, ch);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = (Math.random() * 220) | 0;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
  }

  function startTuningFx(overlay) {
    if (!overlay) return;
    stopTuningFx(overlay);
    const fill = overlay.querySelector('[data-live-meter]');
    const pctEl = overlay.querySelector('[data-live-pct]');
    const snow = overlay.querySelector('.videos-live-tuning__snow');
    let progress = 8;
    if (fill) fill.style.width = progress + '%';
    if (pctEl) pctEl.textContent = String(progress);

    const paintSnow = () => {
      drawTvStatic(snow);
      overlay._snowTimer = setTimeout(paintSnow, 45);
    };
    paintSnow();

    overlay._freqTimer = setInterval(() => {
      const bump = 2 + Math.random() * 7;
      progress = Math.min(92, progress + bump);
      if (fill) fill.style.width = progress.toFixed(0) + '%';
      if (pctEl) pctEl.textContent = String(Math.round(progress));
    }, 180);
  }

  function stopTuningFx(overlay) {
    if (!overlay) return;
    if (overlay._freqTimer) {
      clearInterval(overlay._freqTimer);
      overlay._freqTimer = null;
    }
    if (overlay._snowTimer) {
      clearTimeout(overlay._snowTimer);
      overlay._snowTimer = null;
    }
  }

  function clearFsChromeTimer(mediaDiv) {
    if (!mediaDiv || !mediaDiv._fsChromeTimer) return;
    clearTimeout(mediaDiv._fsChromeTimer);
    mediaDiv._fsChromeTimer = null;
  }

  function showFsChrome(mediaDiv) {
    if (!mediaDiv || !mediaDiv.classList.contains('is-live-fullscreen')) return;
    const closeBtn = mediaDiv.querySelector('.videos-live-fs-close');
    if (!closeBtn) return;
    closeBtn.hidden = false;
    closeBtn.classList.remove('is-fs-chrome-hidden');
    mediaDiv.classList.add('is-fs-chrome-visible');
    clearFsChromeTimer(mediaDiv);
    mediaDiv._fsChromeTimer = setTimeout(() => {
      hideFsChrome(mediaDiv);
    }, 5000);
  }

  function hideFsChrome(mediaDiv) {
    if (!mediaDiv) return;
    clearFsChromeTimer(mediaDiv);
    const closeBtn = mediaDiv.querySelector('.videos-live-fs-close');
    if (closeBtn) {
      closeBtn.classList.add('is-fs-chrome-hidden');
    }
    mediaDiv.classList.remove('is-fs-chrome-visible');
  }

  function ensureFullscreenControls(mediaDiv) {
    if (!mediaDiv) return;
    if (mediaDiv.querySelector('.videos-live-fs-btn')) return;

    const fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.className = 'videos-live-fs-btn';
    fsBtn.setAttribute('aria-label', 'מסך מלא');
    fsBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
    fsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      enterLiveFullscreen(mediaDiv);
    });
    mediaDiv.appendChild(fsBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'videos-live-fs-close';
    closeBtn.setAttribute('aria-label', 'סגור מסך מלא');
    closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    closeBtn.hidden = true;
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      exitLiveFullscreen(mediaDiv);
    });
    mediaDiv.appendChild(closeBtn);

    // לחיצה על המסך במסך מלא מחזירה את כפתור הסגירה ל־5 שניות | HYPER CORE TECH
    const revealChrome = (e) => {
      if (!mediaDiv.classList.contains('is-live-fullscreen')) return;
      if (e.target && e.target.closest && e.target.closest('.videos-live-fs-close')) return;
      e.preventDefault();
      e.stopPropagation();
      showFsChrome(mediaDiv);
    };
    mediaDiv.addEventListener('click', revealChrome);
    mediaDiv.addEventListener('touchend', revealChrome, { passive: false });
  }

  function enterLiveFullscreen(mediaDiv) {
    if (!mediaDiv) return;
    const existing = document.querySelector('.videos-feed__media.is-live-fullscreen');
    if (existing && existing !== mediaDiv) exitLiveFullscreen(existing);
    mediaDiv.classList.add('is-live-fullscreen');
    document.body.classList.add('live-channel-fullscreen');
    const fsBtn = mediaDiv.querySelector('.videos-live-fs-btn');
    if (fsBtn) fsBtn.hidden = true;
    showFsChrome(mediaDiv);

    try {
      if (mediaDiv.requestFullscreen) mediaDiv.requestFullscreen().catch(() => {});
      else if (mediaDiv.webkitRequestFullscreen) mediaDiv.webkitRequestFullscreen();
    } catch (_) {}
  }

  function exitLiveFullscreen(mediaDiv) {
    if (!mediaDiv) {
      document.body.classList.remove('live-channel-fullscreen');
      return;
    }
    clearFsChromeTimer(mediaDiv);
    mediaDiv.classList.remove('is-live-fullscreen', 'is-fs-chrome-visible');
    document.body.classList.remove('live-channel-fullscreen');
    const closeBtn = mediaDiv.querySelector('.videos-live-fs-close');
    const fsBtn = mediaDiv.querySelector('.videos-live-fs-btn');
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
      document.querySelectorAll('.videos-feed__media.is-live-fullscreen').forEach((el) => {
        clearFsChromeTimer(el);
        el.classList.remove('is-live-fullscreen', 'is-fs-chrome-visible');
        const closeBtn = el.querySelector('.videos-live-fs-close');
        const fsBtn = el.querySelector('.videos-live-fs-btn');
        if (closeBtn) {
          closeBtn.hidden = true;
          closeBtn.classList.remove('is-fs-chrome-hidden');
        }
        if (fsBtn) fsBtn.hidden = false;
      });
      document.body.classList.remove('live-channel-fullscreen');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = document.querySelector('.videos-feed__media.is-live-fullscreen');
      if (open) exitLiveFullscreen(open);
    }
  });

  function attachHlsToVideo(videoEl, url, options = {}) {
    return new Promise((resolve, reject) => {
      if (!videoEl || !url) {
        reject(new Error('missing video/url'));
        return;
      }

      destroyHls(videoEl);
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(videoEl);
      };

      const onPlaying = () => done();
      const onError = () => done(new Error('hls play error'));

      videoEl.addEventListener('playing', onPlaying, { once: true });
      videoEl.addEventListener('loadeddata', onPlaying, { once: true });
      videoEl.addEventListener('error', onError, { once: true });

      const HlsCtor = window.Hls;
      if (HlsCtor && HlsCtor.isSupported && HlsCtor.isSupported()) {
        const hls = new HlsCtor({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 30,
          maxBufferLength: 20,
        });
        hlsInstances.set(videoEl, hls);
        hls.loadSource(url);
        hls.attachMedia(videoEl);
        hls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
          if (options.autoplay) {
            const p = videoEl.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          }
          done();
        });
        hls.on(HlsCtor.Events.ERROR, (_evt, data) => {
          if (data && data.fatal) {
            try { hls.destroy(); } catch (_) {}
            hlsInstances.delete(videoEl);
            done(new Error(data.type || 'hls fatal'));
          }
        });
        return;
      }

      if (canNativeHls(videoEl)) {
        videoEl.src = url;
        videoEl.load();
        if (options.autoplay) {
          const p = videoEl.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
        return;
      }

      done(new Error('hls unsupported'));
    });
  }

  async function prepareLiveMedia(mediaDiv, options = {}) {
    if (!mediaDiv) return { ok: false };
    const url = mediaDiv.dataset.liveUrl || mediaDiv.dataset.videoUrl || '';
    if (!url) return { ok: false, reason: 'no-url' };

    ensureLiveBadge(mediaDiv);
    setTuningVisible(mediaDiv, true, options.tuningLabel || 'מחפש ערוץ...');

    const health = await checkHlsHealth(url);
    if (health && health.ok === false && !health.unverified) {
      setTuningVisible(mediaDiv, true, 'ערוץ לא זמין');
      return { ok: false, health };
    }

    const videoEl = mediaDiv.querySelector('video');
    if (!videoEl) {
      setTuningVisible(mediaDiv, false);
      return { ok: false, reason: 'no-video' };
    }

    try {
      await attachHlsToVideo(videoEl, url, { autoplay: !!options.autoplay });
      setTuningVisible(mediaDiv, false);
      mediaDiv.classList.add('videos-feed__media--ready');
      mediaDiv.dataset.livePrepared = '1';
      return { ok: true, health };
    } catch (err) {
      setTuningVisible(mediaDiv, true, 'לא מצליח לתפוס ערוץ');
      return { ok: false, error: err, health };
    }
  }

  async function prefetchLiveUrl(url) {
    if (!url || !isHlsLiveUrl(url)) return;
    await checkHlsHealth(url);
    // חימום קל של playlist בלבד — הניגון עצמו על הכרטיס
  }

  function buildComposeLivePreview(url) {
    const wrap = document.createElement('div');
    wrap.className = 'compose-live-preview';
    wrap.innerHTML = [
      '<div class="compose-live-preview__badge"><span class="videos-live-badge__dot"></span>LIVE</div>',
      '<div class="compose-live-preview__title">ערוץ חי מזוהה</div>',
      '<div class="compose-live-preview__url"></div>',
      '<div class="compose-live-preview__hint">יפורסם כפוסט שידור חי בפיד</div>',
    ].join('');
    const urlEl = wrap.querySelector('.compose-live-preview__url');
    if (urlEl) urlEl.textContent = url;
    return wrap;
  }

  Object.assign(App, {
    isHlsLiveUrl,
    extractHlsUrlFromText,
    checkHlsHealth,
    prepareLiveMedia,
    prefetchLiveUrl,
    attachHlsToVideo,
    destroyHls,
    ensureLiveBadge,
    ensureTuningOverlay,
    ensureFullscreenControls,
    enterLiveFullscreen,
    exitLiveFullscreen,
    setTuningVisible,
    buildComposeLivePreview,
  });

  window.SosHlsLive = {
    isHlsLiveUrl,
    extractHlsUrlFromText,
    checkHlsHealth,
    prepareLiveMedia,
    prefetchLiveUrl,
    attachHlsToVideo,
    destroyHls,
    ensureLiveBadge,
    ensureFullscreenControls,
    enterLiveFullscreen,
    exitLiveFullscreen,
    setTuningVisible,
    buildComposeLivePreview,
  };
})(window);
