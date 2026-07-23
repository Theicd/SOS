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
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.className = 'videos-live-tuning';
    overlay.hidden = true;
    overlay.innerHTML = [
      '<div class="videos-live-tuning__snow" aria-hidden="true"></div>',
      '<div class="videos-live-tuning__scanline" aria-hidden="true"></div>',
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

  function startTuningFx(overlay) {
    if (!overlay) return;
    stopTuningFx(overlay);
    const fill = overlay.querySelector('[data-live-meter]');
    const pctEl = overlay.querySelector('[data-live-pct]');
    let progress = 8;
    if (fill) fill.style.width = progress + '%';
    if (pctEl) pctEl.textContent = String(progress);

    overlay._freqTimer = setInterval(() => {
      // מד סריקה שמתמלא בהדרגה עם רעש קל | HYPER CORE TECH
      const bump = 2 + Math.random() * 7;
      progress = Math.min(92, progress + bump);
      if (fill) fill.style.width = progress.toFixed(0) + '%';
      if (pctEl) pctEl.textContent = String(Math.round(progress));
    }, 180);
  }

  function stopTuningFx(overlay) {
    if (!overlay || !overlay._freqTimer) return;
    clearInterval(overlay._freqTimer);
    overlay._freqTimer = null;
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
  }

  function enterLiveFullscreen(mediaDiv) {
    if (!mediaDiv) return;
    exitLiveFullscreen(document.querySelector('.videos-feed__media.is-live-fullscreen'));
    mediaDiv.classList.add('is-live-fullscreen');
    document.body.classList.add('live-channel-fullscreen');
    const closeBtn = mediaDiv.querySelector('.videos-live-fs-close');
    const fsBtn = mediaDiv.querySelector('.videos-live-fs-btn');
    if (closeBtn) closeBtn.hidden = false;
    if (fsBtn) fsBtn.hidden = true;

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
    mediaDiv.classList.remove('is-live-fullscreen');
    document.body.classList.remove('live-channel-fullscreen');
    const closeBtn = mediaDiv.querySelector('.videos-live-fs-close');
    const fsBtn = mediaDiv.querySelector('.videos-live-fs-btn');
    if (closeBtn) closeBtn.hidden = true;
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
        el.classList.remove('is-live-fullscreen');
        const closeBtn = el.querySelector('.videos-live-fs-close');
        const fsBtn = el.querySelector('.videos-live-fs-btn');
        if (closeBtn) closeBtn.hidden = true;
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
