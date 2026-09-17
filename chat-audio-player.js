// חלק נגן אודיו (chat-audio-player.js) – נגן אודיו משודרג לצ'אט עם waveform, seek, buffering, נגישות | HYPER CORE TECH
(function initChatAudioPlayer(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  // חלק דיבאג אודיו (chat-audio-player.js) – לוגים לפי localStorage sos_debug_media | HYPER CORE TECH
  if (typeof App.mediaDebugLog !== 'function') {
    App.mediaDebugLog = (...args) => {
      try {
        if (localStorage.getItem('sos_debug_media') === '1') {
          console.log('[MEDIA-DEBUG]', ...args);
        }
      } catch (_) {}
    };
  }
  const mediaDebugLog = App.mediaDebugLog;

  // חלק escape (chat-audio-player.js) – מניעת שבירת HTML ע"י & ב-magnet/?query | HYPER CORE TECH
  function escapeAttr(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  
  // חלק עיצוב (chat-audio-player.js) – HTML משודרג לנגן אודיו בסגנון וואטסאפ | HYPER CORE TECH
  function resolveVoiceCacheKey(attachment) {
    if (!attachment) return '';
    if (typeof App.chatP2PCacheKey === 'function') {
      try { return String(App.chatP2PCacheKey(attachment) || ''); } catch (_) {}
    }
    if (attachment.cacheKey) return String(attachment.cacheKey);
    if (attachment.fileId) return `p2p-file-${attachment.fileId}`;
    if (attachment.attachmentId) return `p2p-file-${attachment.attachmentId}`;
    const msgId = attachment.logicalMessageId || attachment.messageId || attachment.clientMessageId || attachment.id;
    if (msgId) return `p2p-msg-${String(msgId)}`;
    return '';
  }

  function isLivePlayableSrc(src) {
    const s = String(src || '').trim();
    if (!s) return false;
    if (s.startsWith('data:')) return true;
    if (s.startsWith('http://') || s.startsWith('https://')) return true;
    if (s.startsWith('blob:')) return true; // may be dead — verified async
    return false;
  }

  function createEnhancedAudioPlayer(attachment) {
    const srcRaw = attachment.url || attachment.dataUrl || '';
    // Never trust dead blob: as durable initial src — leave empty for hydrate.
    let src = (typeof App.isSafeIncomingChatResource === 'function' && srcRaw && !App.isSafeIncomingChatResource(srcRaw)) ? '' : srcRaw;
    if (src.startsWith('blob:')) src = '';
    const dur = typeof attachment.duration === 'number' && attachment.duration > 0 ? attachment.duration : null;
    const mm = dur !== null ? Math.floor(dur / 60) : null;
    const ss = dur !== null ? String(dur % 60).padStart(2, '0') : null;
    const durationLabel = dur !== null ? `${mm}:${ss}` : '0:00';
    
    // חלק MIME מקיף (chat-audio-player.js) – זיהוי MIME לכל פורמטי האודיו PC/Android/iPhone/Apple | HYPER CORE TECH
    let mimeType = attachment.type || 'audio/mpeg';
    const srcLower = (src || srcRaw).toLowerCase();
    const nameLower = (attachment.name || '').toLowerCase();
    const checkStr = srcLower + '|' + nameLower;
    
    // מיפוי סיומות ל-MIME types
    if (checkStr.includes('.mp3')) mimeType = 'audio/mpeg';
    else if (checkStr.includes('.m4a') || checkStr.includes('.m4b') || checkStr.includes('.m4p') || checkStr.includes('.m4r')) mimeType = 'audio/mp4';
    else if (checkStr.includes('.aac')) mimeType = 'audio/aac';
    else if (checkStr.includes('.ogg') || checkStr.includes('.oga') || checkStr.includes('.opus')) mimeType = 'audio/ogg';
    else if (checkStr.includes('.wav') || checkStr.includes('.wave')) mimeType = 'audio/wav';
    else if (checkStr.includes('.webm')) mimeType = 'audio/webm';
    else if (checkStr.includes('.flac')) mimeType = 'audio/flac';
    else if (checkStr.includes('.wma')) mimeType = 'audio/x-ms-wma';
    else if (checkStr.includes('.aiff') || checkStr.includes('.aif')) mimeType = 'audio/aiff';
    else if (checkStr.includes('.caf')) mimeType = 'audio/x-caf';
    else if (checkStr.includes('.amr')) mimeType = 'audio/amr';
    else if (checkStr.includes('.3gp') || checkStr.includes('.3gpp')) mimeType = 'audio/3gpp';
    else if (checkStr.includes('.alac')) mimeType = 'audio/mp4';
    
    // חלק נגן (chat-audio-player.js) – תמיכה בריבוי sources לתאימות מקסימלית | HYPER CORE TECH
    // חלק שעה וסטטוס (chat-audio-player.js) – מקום לשעה וסטטוס בתוך הנגן | HYPER CORE TECH
    // חלק תמונת פרופיל (chat-audio-player.js) – מקום לתמונת פרופיל בתוך הנגן | HYPER CORE TECH
    // חלק P2P קול (chat-audio-player.js) – שמירת magnetURI כ-data attribute לטעינת P2P | HYPER CORE TECH
    const magnetUriRaw = attachment.magnetURI || '';
    const magnetUri = (magnetUriRaw && typeof App.isValidIncomingMagnetURI === 'function' && !App.isValidIncomingMagnetURI(magnetUriRaw)) ? '' : magnetUriRaw;
    const fallbackSrc = src;
    const cacheKey = resolveVoiceCacheKey(attachment);
    const fileId = attachment.fileId || attachment.attachmentId || '';
    const safeSrc = escapeAttr(src);
    const safeMagnet = escapeAttr(magnetUri);
    const safeFallback = escapeAttr(fallbackSrc);
    const safeMime = escapeAttr(mimeType);
    const safeCacheKey = escapeAttr(cacheKey);
    const safeFileId = escapeAttr(fileId);
    // חלק דיבאג אודיו (chat-audio-player.js) – יצירת נגן והגדרת מקורות | HYPER CORE TECH
    mediaDebugLog('audio-player-create', {
      name: attachment.name || '',
      mime: attachment.type || mimeType,
      hasSrc: !!src,
      hasMagnet: !!magnetUri,
      cacheKey: cacheKey || ''
    });
    return `
      <div class="chat-message__audio chat-audio-enhanced" data-audio data-src="${safeSrc}"
           ${cacheKey ? `data-cache-key="${safeCacheKey}"` : ''}
           ${fileId ? `data-file-id="${safeFileId}"` : ''}
           ${magnetUri ? `data-magnet-uri="${safeMagnet}"` : ''}
           ${fallbackSrc ? `data-fallback-src="${safeFallback}"` : ''}>
        <audio preload="auto" class="chat-message__audio-el"${src ? ` src="${safeSrc}"` : ''}>
          ${src ? `<source src="${safeSrc}" type="${safeMime}">
          <source src="${safeSrc}" type="audio/mpeg">
          <source src="${safeSrc}" type="audio/ogg">
          <source src="${safeSrc}" type="audio/webm">` : '<!-- audio source pending / durable hydrate / P2P -->'}
        </audio>
        <div class="chat-audio-whatsapp">
          <button type="button" class="chat-audio-whatsapp__play" aria-label="נגן הודעה קולית">
            <i class="fa-solid fa-play"></i>
          </button>
          <div class="chat-audio-whatsapp__content">
            <div class="chat-audio-whatsapp__eq" aria-hidden="true">
              <span></span><span></span><span></span><span></span><span></span>
              <span></span><span></span><span></span><span></span><span></span>
              <span></span><span></span><span></span><span></span><span></span>
              <span></span><span></span><span></span><span></span><span></span>
            </div>
            <div class="chat-audio-whatsapp__track">
              <div class="chat-audio-whatsapp__progress" style="width:0%"></div>
              <div class="chat-audio-whatsapp__seeker" style="left:0%"></div>
            </div>
            <div class="chat-audio-whatsapp__footer">
              <span class="chat-audio-whatsapp__time">${durationLabel}</span>
              <span class="chat-audio-whatsapp__meta-slot"></span>
            </div>
          </div>
          <span class="chat-audio-whatsapp__avatar-slot"></span>
        </div>
      </div>
    `;
  }
  
  // חלק waveform (chat-audio-player.js) – ציור גלי קול פשוט | HYPER CORE TECH
  function drawWaveform(canvas, audio) {
    if (!canvas || !audio) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const width = canvas.width;
    const height = canvas.height;
    const bars = 40;
    const barWidth = width / bars;
    const gap = 1;
    
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    
    // Generate pseudo-random waveform based on duration
    const seed = audio.duration || 30;
    for (let i = 0; i < bars; i++) {
      const random = Math.sin(i * seed * 0.1) * 0.5 + 0.5;
      const barHeight = Math.max(4, random * height * 0.8);
      const x = i * barWidth;
      const y = (height - barHeight) / 2;
      
      ctx.fillRect(x, y, barWidth - gap, barHeight);
    }
  }
  
  // חלק אינטראקציה (chat-audio-player.js) – חיבור אירועים לנגן בסגנון וואטסאפ | HYPER CORE TECH
  function wireAudioPlayer(container) {
    if (!container) return;
    if (container.dataset.wired === 'true') return; // מניעת חיווט כפול
    container.dataset.wired = 'true';
    
    // מניעת propagation על כל הקונטיינר | HYPER CORE TECH
    container.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    
    const audio = container.querySelector('.chat-message__audio-el');
    // תמיכה בשני סוגי נגנים - ישן וחדש
    const btn = container.querySelector('.chat-audio-whatsapp__play') || container.querySelector('.chat-audio__play');
    const progressBar = container.querySelector('.chat-audio-whatsapp__progress');
    const seeker = container.querySelector('.chat-audio-whatsapp__seeker');
    const timeEl = container.querySelector('.chat-audio-whatsapp__time');
    const track = container.querySelector('.chat-audio-whatsapp__track');
    const shell = container.querySelector('.chat-audio-whatsapp');
    let isPlaying = false;
    let loadAttempted = false;

    const setPlayingUi = (playing) => {
      isPlaying = !!playing;
      if (shell) shell.classList.toggle('is-playing', !!playing);
      if (container) container.classList.toggle('is-playing', !!playing);
    };
    
    if (!audio || !btn) {
      console.warn('[AUDIO] Missing audio element or button in container');
      return;
    }
    
    // חלק P2P קול (chat-audio-player.js) – ניסיון טעינת אודיו מטורנט P2P לפני Blossom | HYPER CORE TECH
    const magnetUri = container.dataset.magnetUri;
    const srcFromData = container.dataset.src;
    const fallbackSrc = container.dataset.fallbackSrc || srcFromData || '';
    const cacheKey = container.dataset.cacheKey || '';
    const fileId = container.dataset.fileId || '';
    // חלק דיבאג אודיו (chat-audio-player.js) – חיווט נגן ומקורות זמינים | HYPER CORE TECH
    mediaDebugLog('audio-player-wire', {
      hasMagnet: !!magnetUri,
      hasFallback: !!fallbackSrc,
      srcFromData: !!srcFromData,
      cacheKey: cacheKey || ''
    });

    let hydratePromise = null;

    async function hydrateDurableAudioSource() {
      const current = String(audio.getAttribute('src') || audio.src || '').trim();
      // Prefer durable local cache BEFORE network / P2P.
      const att = {
        url: current.startsWith('blob:') ? '' : (current || fallbackSrc || ''),
        dataUrl: '',
        cacheKey: cacheKey || undefined,
        fileId: fileId || undefined,
        magnetURI: magnetUri || undefined,
      };
      let resolved = '';
      try {
        if (typeof App.resolveChatMediaSrc === 'function') {
          resolved = await App.resolveChatMediaSrc(att);
        } else if (cacheKey && typeof App.loadChatP2PMediaBlob === 'function') {
          const blob = await App.loadChatP2PMediaBlob(cacheKey);
          if (blob) resolved = URL.createObjectURL(blob);
        }
      } catch (_) {}
      if (resolved) {
        applyAudioSource(audio, btn, resolved, { markPlay: true });
        container.dataset.src = resolved;
        container.dataset.durableHydrated = 'true';
        mediaDebugLog('audio-durable-hydrate', { cacheKey, hasSrc: true });
        if (container.dataset.autoplayPending === 'true') {
          audio.play().catch(() => {});
        }
        return resolved;
      }
      // Live http/data fallback if present and not a dead blob.
      if (fallbackSrc && !String(fallbackSrc).startsWith('blob:')) {
        if (!audio.getAttribute('src') && !audio.src) {
          applyAudioSource(audio, btn, fallbackSrc, { markPlay: true });
        }
        return fallbackSrc;
      }
      return '';
    }

    hydratePromise = hydrateDurableAudioSource().then((src) => {
      // After durable miss — start P2P if magnet present.
      if (magnetUri && (!src || container.dataset.durableHydrated !== 'true')) {
        mediaDebugLog('audio-p2p-start', { magnetPreview: magnetUri.slice(0, 60), hasFallback: !!fallbackSrc });
        tryLoadAudioFromTorrent(container, audio, btn, magnetUri, fallbackSrc);
      }
      return src;
    }).catch(() => {
      if (magnetUri) tryLoadAudioFromTorrent(container, audio, btn, magnetUri, fallbackSrc);
      return '';
    });
    
    const format = (sec) => {
      const s = Math.max(0, Math.round(sec || 0));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    
    // חלק טעינה (chat-audio-player.js) – עדכון זמן בטעינת מטאדאטה | HYPER CORE TECH
    audio.addEventListener('loadedmetadata', () => {
      console.log('[AUDIO] Metadata loaded, duration:', audio.duration);
      if (timeEl && audio.duration && isFinite(audio.duration)) {
        timeEl.textContent = format(audio.duration);
      }
    });
    
    // חלק שגיאות (chat-audio-player.js) – טיפול בשגיאות טעינה | HYPER CORE TECH
    audio.addEventListener('error', (e) => {
      console.error('[AUDIO] Load error:', e, audio.error);
      if (btn) btn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i>';
    });
    
    // חלק canplay (chat-audio-player.js) – מוכן לניגון | HYPER CORE TECH
    audio.addEventListener('canplay', () => {
      console.log('[AUDIO] Can play');
    });

    // חלק מצב נגן (chat-audio-player.js) – סנכרון כפתור גם בהפעלה אוטומטית | HYPER CORE TECH
    audio.addEventListener('play', () => {
      if (btn) btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
      setPlayingUi(true);
      if (container?.dataset?.autoplayPending) {
        delete container.dataset.autoplayPending;
      }
    });
    audio.addEventListener('pause', () => {
      if (audio.ended) return;
      if (btn) btn.innerHTML = '<i class="fa-solid fa-play"></i>';
      setPlayingUi(false);
    });
    
    // חלק ניגון (chat-audio-player.js) – toggle play/pause | HYPER CORE TECH
    const toggle = async () => {
      // טעינה ראשונית אם לא נטען
      if (!loadAttempted) {
        loadAttempted = true;
        audio.load();
      }
      
      if (audio.paused) {
        // חלק autoplay (chat-audio-player.js) – סימון בקשת ניגון כדי להפעיל אחרי טעינה | HYPER CORE TECH
        if (container?.dataset) {
          container.dataset.autoplayPending = 'true';
        }
        let playSrc = audio.getAttribute('src') || audio.src || '';
        if (!playSrc || String(playSrc).startsWith('blob:')) {
          try {
            if (hydratePromise) await hydratePromise;
            else await hydrateDurableAudioSource();
          } catch (_) {}
          playSrc = audio.getAttribute('src') || audio.src || '';
        }
        if (playSrc && (!audio.getAttribute('src') || audio.error)) {
          audio.src = playSrc;
          audio.load();
          mediaDebugLog('audio-fallback-set', { src: playSrc, reason: 'toggle-play' });
        }
        if (!audio.getAttribute('src') && !audio.src) {
          console.error('[AUDIO] Play blocked: no audio source');
          mediaDebugLog('audio-play-failed', { error: 'no-src' });
          if (btn) btn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i>';
          return;
        }
        mediaDebugLog('audio-play-request', { hasSrc: !!(audio.getAttribute('src') || audio.src) });
        const playPromise = audio.play();
        if (playPromise) {
          playPromise.then(() => {
            btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
            setPlayingUi(true);
          }).catch((err) => {
            console.error('[AUDIO] Play failed:', err);
            mediaDebugLog('audio-play-failed', { error: err?.message || String(err) });
            // ניסיון נוסף אחרי טעינה
            audio.load();
            setTimeout(() => {
              audio.play().catch(e => console.error('[AUDIO] Retry play failed:', e));
            }, 100);
          });
        }
      } else {
        if (container?.dataset?.autoplayPending) {
          delete container.dataset.autoplayPending;
        }
        audio.pause();
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        setPlayingUi(false);
        mediaDebugLog('audio-pause', { currentTime: audio.currentTime || 0 });
      }
    };
    
    // חלק לחיצה (chat-audio-player.js) – מניעת propagation | HYPER CORE TECH
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggle();
    });
    
    // חלק התקדמות (chat-audio-player.js) – עדכון פס התקדמות והזמן | HYPER CORE TECH
    audio.addEventListener('timeupdate', () => {
      const d = Math.max(1, audio.duration || 1);
      const p = Math.min(100, (audio.currentTime / d) * 100);
      
      if (progressBar) {
        progressBar.style.width = p + '%';
      }
      if (seeker) {
        seeker.style.left = p + '%';
      }
      if (timeEl && isPlaying) {
        timeEl.textContent = format(audio.currentTime);
      }
    });
    
    // חלק סיום (chat-audio-player.js) – איפוס כפתור בסיום | HYPER CORE TECH
    audio.addEventListener('ended', () => {
      btn.innerHTML = '<i class="fa-solid fa-play"></i>';
      setPlayingUi(false);
      if (progressBar) {
        progressBar.style.width = '0%';
      }
      if (seeker) {
        seeker.style.left = '0%';
      }
      if (timeEl) {
        timeEl.textContent = format(audio.duration || 0);
      }
      // חלק P2P קול (chat-audio-player.js) – אם נטען מקור P2P במהלך ניגון, מעדכנים לפעם הבאה | HYPER CORE TECH
      const preferredSrc = container?.dataset?.src || '';
      if (container?.dataset?.p2pLoaded === 'true' && preferredSrc && audio.src !== preferredSrc) {
        audio.src = preferredSrc;
        audio.load();
      }
    });
    
    // חלק seek (chat-audio-player.js) – קפיצה בפס התקדמות בלחיצה | HYPER CORE TECH
    if (track) {
      track.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = track.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        audio.currentTime = ratio * (audio.duration || 0);
      });
    }
  }
  
  // חלק P2P קול (chat-audio-player.js) – טעינת אודיו מטורנט P2P עם fallback ל-URL רגיל | HYPER CORE TECH
  const P2P_AUDIO_TIMEOUT_MS = 15000; // 15 שניות timeout לטעינת P2P
  // חלק cache P2P (chat-audio-player.js) – מונע טעינה חוזרת + מעדכן גם נגנים חדשים אחרי re-render | HYPER CORE TECH
  const _p2pCache = new Map(); // magnetUri → { status:'loading'|'done'|'failed', blobUrl?, waiters:Set }

  function applyAudioSource(audioEl, playBtn, src, { markPlay = true } = {}) {
    if (!audioEl || !src) return;
    if (audioEl.src !== src) {
      audioEl.src = src;
      audioEl.load();
    }
    if (markPlay && playBtn) playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
  }

  function notifyP2pWaiters(magnetUri, entry) {
    const waiters = entry?.waiters;
    if (!waiters || !waiters.size) return;
    waiters.forEach((waiter) => {
      try {
        if (entry.status === 'done' && entry.blobUrl) {
          const canSwap = waiter.audioEl?.paused && (waiter.audioEl.currentTime || 0) === 0;
          if (canSwap) {
            applyAudioSource(waiter.audioEl, waiter.playBtn, entry.blobUrl, { markPlay: true });
          }
          if (waiter.container) {
            waiter.container.dataset.src = entry.blobUrl;
            waiter.container.dataset.p2pLoaded = 'true';
            if (canSwap && waiter.container.dataset.autoplayPending === 'true') {
              waiter.audioEl.play().catch(() => {});
            }
          }
        } else if (entry.status === 'failed' && waiter.fallbackSrc) {
          applyAudioSource(waiter.audioEl, waiter.playBtn, waiter.fallbackSrc, { markPlay: true });
        }
      } catch (_) {}
    });
    waiters.clear();
  }

  function tryLoadAudioFromTorrent(container, audioEl, playBtn, magnetUri, fallbackSrc) {
    if (!magnetUri) {
      if (fallbackSrc) applyAudioSource(audioEl, playBtn, fallbackSrc);
      return;
    }

    if (!App.torrentTransfer || typeof App.torrentTransfer.init !== 'function') {
      if (fallbackSrc) applyAudioSource(audioEl, playBtn, fallbackSrc);
      mediaDebugLog('audio-p2p-unavailable', { fallbackSet: !!fallbackSrc });
      return;
    }

    const cached = _p2pCache.get(magnetUri);
    if (cached) {
      mediaDebugLog('audio-p2p-cache', { status: cached.status, hasBlob: !!cached.blobUrl });
      if (cached.status === 'done' && cached.blobUrl) {
        applyAudioSource(audioEl, playBtn, cached.blobUrl);
        container.dataset.src = cached.blobUrl;
        container.dataset.p2pLoaded = 'true';
        return;
      }
      if (cached.status === 'failed') {
        if (fallbackSrc) applyAudioSource(audioEl, playBtn, fallbackSrc);
        return;
      }
      if (cached.status === 'loading') {
        if (!cached.waiters) cached.waiters = new Set();
        cached.waiters.add({ audioEl, playBtn, container, fallbackSrc });
        // ניגון מיידי מ-fallback בזמן ההמתנה | HYPER CORE TECH
        if (fallbackSrc) applyAudioSource(audioEl, playBtn, fallbackSrc, { markPlay: true });
        return;
      }
    }

    const wt = App.torrentTransfer.init();
    if (!wt) {
      if (fallbackSrc) applyAudioSource(audioEl, playBtn, fallbackSrc);
      mediaDebugLog('audio-p2p-init-failed', { fallbackSet: !!fallbackSrc });
      return;
    }

    const entry = { status: 'loading', waiters: new Set([{ audioEl, playBtn, container, fallbackSrc }]) };
    _p2pCache.set(magnetUri, entry);
    console.log('[AUDIO/P2P] 🔄 מנסה טעינת אודיו מטורנט P2P', typeof App.diagSafeMagnet === 'function' ? App.diagSafeMagnet(magnetUri) : { magnetLength: String(magnetUri || '').length });
    // לא מחליפים ל-spinner אם יש fallback – המשתמש יכול לנגן מיד | HYPER CORE TECH
    if (fallbackSrc) {
      applyAudioSource(audioEl, playBtn, fallbackSrc, { markPlay: true });
      mediaDebugLog('audio-fallback-set', { src: fallbackSrc, reason: 'p2p-loading' });
    } else if (playBtn) {
      playBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }

    let resolved = false;

    const finish = (status, blobUrl) => {
      if (resolved) return;
      resolved = true;
      entry.status = status;
      if (blobUrl) entry.blobUrl = blobUrl;
      notifyP2pWaiters(magnetUri, entry);
      if (status === 'failed' && playBtn && !fallbackSrc) {
        playBtn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i>';
      }
    };

    const timer = setTimeout(() => {
      console.log('[AUDIO/P2P] ⏱️ Timeout, fallback ל-URL רגיל');
      mediaDebugLog('audio-p2p-timeout', { fallbackSet: !!fallbackSrc });
      finish('failed');
    }, P2P_AUDIO_TIMEOUT_MS);

    try {
      wt.add(magnetUri, {
        announce: ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev']
      }, (torrent) => {
        console.log('[AUDIO/P2P] 🔗 מחובר לטורנט! קבצים:', torrent.files.length, 'גודל:', torrent.length, 'bytes');
        let lastLogPct = 0;
        torrent.on('download', () => {
          const pct = Math.round(torrent.progress * 100);
          if (pct >= lastLogPct + 20) {
            lastLogPct = pct;
            console.log(`[AUDIO/P2P] 📥 מוריד הודעה קולית P2P: ${pct}%`);
          }
        });
        torrent.on('wire', (wire) => {
          console.log('[AUDIO/P2P] 🔗 Peer (שולח) מחובר:', wire.remoteAddress || 'WebRTC');
        });
        const file = torrent.files[0];
        if (!file) {
          clearTimeout(timer);
          finish('failed');
          return;
        }

        file.getBlobURL((err, blobUrl) => {
          clearTimeout(timer);
          if (err) {
            console.warn('[AUDIO/P2P] שגיאה בהמרת blob:', err);
            mediaDebugLog('audio-p2p-blob-failed', { error: err?.message || String(err), fallbackSet: !!fallbackSrc });
            finish('failed');
            return;
          }
          console.log('[AUDIO/P2P] ✅✅ הודעה קולית נטענה בהצלחה דרך P2P!');
          mediaDebugLog('audio-p2p-success', { hasBlob: !!blobUrl });

          // Persist durable Blob so reload/WebView restart can restore without network.
          (async () => {
            try {
              const key = container?.dataset?.cacheKey
                || (container?.dataset?.fileId ? `p2p-file-${container.dataset.fileId}` : '');
              if (key && blobUrl && typeof App.persistChatP2PMedia === 'function') {
                const resp = await fetch(blobUrl);
                const blob = await resp.blob();
                if (blob && blob.size > 0) {
                  const persistedKey = await App.persistChatP2PMedia(key, blob, {
                    name: 'voice',
                    type: blob.type || 'audio/webm',
                  });
                  if (persistedKey && container) container.dataset.cacheKey = persistedKey;
                  mediaDebugLog('audio-p2p-persisted', { cacheKey: persistedKey || key, size: blob.size });
                }
              }
            } catch (persistErr) {
              mediaDebugLog('audio-p2p-persist-failed', { error: persistErr?.message || String(persistErr) });
            }
          })();

          // לא מחליפים מקור באמצע ניגון – waiters מקבלים blob לנגנים שלא מנגנים | HYPER CORE TECH
          const canSwapNow = audioEl.paused && audioEl.currentTime === 0;
          if (canSwapNow) {
            applyAudioSource(audioEl, playBtn, blobUrl, { markPlay: true });
            container.dataset.src = blobUrl;
            container.dataset.p2pLoaded = 'true';
            if (container.dataset.autoplayPending === 'true') {
              audioEl.play().catch((playErr) => console.warn('[AUDIO/P2P] autoplay P2P failed:', playErr));
            }
          } else {
            container.dataset.src = blobUrl;
            container.dataset.p2pLoaded = 'true';
          }
          finish('done', blobUrl);
        });
      });
    } catch (err) {
      clearTimeout(timer);
      console.warn('[AUDIO/P2P] שגיאה בטעינה:', err);
      mediaDebugLog('audio-p2p-error', { error: err?.message || String(err), fallbackSet: !!fallbackSrc });
      finish('failed');
    }
  }

  // חלק API ציבורי (chat-audio-player.js) – חשיפת פונקציות ליצירת נגן | HYPER CORE TECH
  Object.assign(App, {
    createEnhancedAudioPlayer,
    wireEnhancedAudioPlayer: wireAudioPlayer
  });
})(window);
