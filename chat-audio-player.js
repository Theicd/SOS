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
  
  // חלק עיצוב (chat-audio-player.js) – HTML משודרג לנגן אודיו בסגנון וואטסאפ | HYPER CORE TECH
  function createEnhancedAudioPlayer(attachment) {
    const src = attachment.url || attachment.dataUrl || '';
    const dur = typeof attachment.duration === 'number' && attachment.duration > 0 ? attachment.duration : null;
    const mm = dur !== null ? Math.floor(dur / 60) : null;
    const ss = dur !== null ? String(dur % 60).padStart(2, '0') : null;
    const durationLabel = dur !== null ? `${mm}:${ss}` : '0:00';
    
    // חלק MIME מקיף (chat-audio-player.js) – זיהוי MIME לכל פורמטי האודיו PC/Android/iPhone/Apple | HYPER CORE TECH
    let mimeType = attachment.type || 'audio/mpeg';
    const srcLower = src.toLowerCase();
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
    const magnetUri = attachment.magnetURI || '';
    const fallbackSrc = src;
    // חלק דיבאג אודיו (chat-audio-player.js) – יצירת נגן והגדרת מקורות | HYPER CORE TECH
    mediaDebugLog('audio-player-create', {
      name: attachment.name || '',
      mime: attachment.type || mimeType,
      hasSrc: !!src,
      hasMagnet: !!magnetUri
    });
    return `
      <div class="chat-message__audio chat-audio-enhanced" data-audio data-src="${src}"
           ${magnetUri ? `data-magnet-uri="${magnetUri}"` : ''}
           ${fallbackSrc ? `data-fallback-src="${fallbackSrc}"` : ''}>
        <audio preload="auto" class="chat-message__audio-el"${src ? ` src="${src}"` : ''}>
          ${src ? `<source src="${src}" type="${mimeType}">
          <source src="${src}" type="audio/mpeg">
          <source src="${src}" type="audio/ogg">
          <source src="${src}" type="audio/webm">` : '<!-- P2P-only: audio source will be set by tryLoadAudioFromTorrent -->'}
        </audio>
        <div class="chat-audio-whatsapp">
          <button type="button" class="chat-audio-whatsapp__play" aria-label="נגן הודעה קולית">
            <i class="fa-solid fa-play"></i>
          </button>
          <div class="chat-audio-whatsapp__content">
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
    
    if (!audio || !btn) {
      console.warn('[AUDIO] Missing audio element or button in container');
      return;
    }
    
    // חלק P2P קול (chat-audio-player.js) – ניסיון טעינת אודיו מטורנט P2P לפני Blossom | HYPER CORE TECH
    const magnetUri = container.dataset.magnetUri;
    const srcFromData = container.dataset.src;
    const fallbackSrc = container.dataset.fallbackSrc || srcFromData || '';
    // חלק דיבאג אודיו (chat-audio-player.js) – חיווט נגן ומקורות זמינים | HYPER CORE TECH
    mediaDebugLog('audio-player-wire', {
      hasMagnet: !!magnetUri,
      hasFallback: !!fallbackSrc,
      srcFromData: !!srcFromData
    });

    if (magnetUri) {
      mediaDebugLog('audio-p2p-start', { magnetPreview: magnetUri.slice(0, 60), hasFallback: !!fallbackSrc });
      tryLoadAudioFromTorrent(container, audio, btn, magnetUri, fallbackSrc);
    } else if (fallbackSrc && !audio.src) {
      audio.src = fallbackSrc;
      audio.load();
      mediaDebugLog('audio-fallback-set', { src: fallbackSrc });
    }
    
    const format = (sec) => {
      const s = Math.max(0, Math.round(sec || 0));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    
    let isPlaying = false;
    let loadAttempted = false;
    
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
      isPlaying = true;
      if (container?.dataset?.autoplayPending) {
        delete container.dataset.autoplayPending;
      }
    });
    audio.addEventListener('pause', () => {
      if (audio.ended) return;
      if (btn) btn.innerHTML = '<i class="fa-solid fa-play"></i>';
      isPlaying = false;
    });
    
    // חלק ניגון (chat-audio-player.js) – toggle play/pause | HYPER CORE TECH
    const toggle = () => {
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
        if (!audio.src && fallbackSrc) {
          audio.src = fallbackSrc;
          audio.load();
          mediaDebugLog('audio-fallback-set', { src: fallbackSrc, reason: 'toggle-play' });
        }
        mediaDebugLog('audio-play-request', { hasSrc: !!audio.src });
        const playPromise = audio.play();
        if (playPromise) {
          playPromise.then(() => {
            btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
            isPlaying = true;
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
        isPlaying = false;
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
      isPlaying = false;
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
  // חלק cache P2P (chat-audio-player.js) – מונע טעינה חוזרת של אותו magnetURI בכל renderMessages | HYPER CORE TECH
  const _p2pCache = new Map(); // magnetUri → { status:'loading'|'done'|'failed', blobUrl? }

  function tryLoadAudioFromTorrent(container, audioEl, playBtn, magnetUri, fallbackSrc) {
    if (!App.torrentTransfer || typeof App.torrentTransfer.init !== 'function') {
      if (fallbackSrc) audioEl.src = fallbackSrc;
      mediaDebugLog('audio-p2p-unavailable', { fallbackSet: !!fallbackSrc });
      return;
    }

    // חלק cache P2P (chat-audio-player.js) – בדיקת cache לפני ניסיון טעינה מחדש | HYPER CORE TECH
    const cached = _p2pCache.get(magnetUri);
    if (cached) {
      mediaDebugLog('audio-p2p-cache', { status: cached.status, hasBlob: !!cached.blobUrl });
      if (cached.status === 'done' && cached.blobUrl) { audioEl.src = cached.blobUrl; return; }
      if (cached.status === 'failed') { if (fallbackSrc) audioEl.src = fallbackSrc; return; }
      if (cached.status === 'loading') { if (fallbackSrc) audioEl.src = fallbackSrc; return; }
    }

    const wt = App.torrentTransfer.init();
    if (!wt) {
      if (fallbackSrc) audioEl.src = fallbackSrc;
      mediaDebugLog('audio-p2p-init-failed', { fallbackSet: !!fallbackSrc });
      return;
    }

    _p2pCache.set(magnetUri, { status: 'loading' });
    console.log('[AUDIO/P2P] 🔄 מנסה טעינת אודיו מטורנט P2P... magnetURI:', magnetUri.slice(0, 50));
    if (playBtn) playBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    // חלק fallback מיידי (chat-audio-player.js) – מאפשר ניגון מהיר בזמן טעינת P2P | HYPER CORE TECH
    if (fallbackSrc && !audioEl.src) {
      audioEl.src = fallbackSrc;
      audioEl.load();
      if (container?.dataset?.autoplayPending === 'true') {
        audioEl.play().catch((err) => console.warn('[AUDIO/P2P] autoplay fallback failed:', err));
      }
      mediaDebugLog('audio-fallback-set', { src: fallbackSrc, reason: 'p2p-loading' });
    }

    let resolved = false;

    // timeout – אם לא הצליח, fallback ל-URL רגיל
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      console.log('[AUDIO/P2P] ⏱️ Timeout, fallback ל-URL רגיל');
      if (fallbackSrc) audioEl.src = fallbackSrc;
      if (playBtn) playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
      _p2pCache.set(magnetUri, { status: 'failed' });
      mediaDebugLog('audio-p2p-timeout', { fallbackSet: !!fallbackSrc });
    }, P2P_AUDIO_TIMEOUT_MS);

    try {
      wt.add(magnetUri, {
        announce: ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev']
      }, (torrent) => {
        console.log('[AUDIO/P2P] 🔗 מחובר לטורנט! קבצים:', torrent.files.length, 'גודל:', torrent.length, 'bytes');
        // חלק P2P קול (chat-audio-player.js) – לוג התקדמות הורדה בצד המקבל | HYPER CORE TECH
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
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            if (fallbackSrc) audioEl.src = fallbackSrc;
            if (playBtn) playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
          }
          return;
        }

        file.getBlobURL((err, blobUrl) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);

          if (err) {
            console.warn('[AUDIO/P2P] שגיאה בהמרת blob:', err);
            if (fallbackSrc) audioEl.src = fallbackSrc;
            mediaDebugLog('audio-p2p-blob-failed', { error: err?.message || String(err), fallbackSet: !!fallbackSrc });
          } else {
            console.log('[AUDIO/P2P] ✅✅ הודעה קולית נטענה בהצלחה דרך P2P! (ללא Blossom)');
            const canSwapNow = audioEl.paused && audioEl.currentTime === 0;
            if (canSwapNow) {
              audioEl.src = blobUrl;
              audioEl.load();
            }
            container.dataset.src = blobUrl;
            container.dataset.p2pLoaded = 'true';
            _p2pCache.set(magnetUri, { status: 'done', blobUrl });
            mediaDebugLog('audio-p2p-success', { canSwapNow, hasBlob: !!blobUrl });
            // חלק autoplay P2P (chat-audio-player.js) – אם המשתמש ביקש ניגון, ננסה להפעיל על המקור החדש | HYPER CORE TECH
            if (canSwapNow && container?.dataset?.autoplayPending === 'true') {
              audioEl.play().catch((err) => console.warn('[AUDIO/P2P] autoplay P2P failed:', err));
            }
          }
          if (playBtn) playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        });
      });
    } catch (err) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        console.warn('[AUDIO/P2P] שגיאה בטעינה:', err);
        _p2pCache.set(magnetUri, { status: 'failed' });
        if (fallbackSrc) audioEl.src = fallbackSrc;
        if (playBtn) playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        mediaDebugLog('audio-p2p-error', { error: err?.message || String(err), fallbackSet: !!fallbackSrc });
      }
    }
  }

  // חלק API ציבורי (chat-audio-player.js) – חשיפת פונקציות ליצירת נגן | HYPER CORE TECH
  Object.assign(App, {
    createEnhancedAudioPlayer,
    wireEnhancedAudioPlayer: wireAudioPlayer
  });
})(window);
