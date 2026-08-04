// חלק מדיה (chat-media-renderer.js) – תצוגת תמונות/וידאו/YouTube inline בצ'אט כמו וואטסאפ | HYPER CORE TECH
(function initChatMediaRenderer(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  // חלק דיבאג מדיה (chat-media-renderer.js) – לוגים לפי localStorage sos_debug_media | HYPER CORE TECH
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
  
  // חלק מטמון צ'אט (chat-media-renderer.js) – IndexedDB למדיה בשיחות | HYPER CORE TECH
  const CHAT_MEDIA_DB = 'SOSChatMediaCache';
  const CHAT_MEDIA_STORE = 'chatMedia';
  let chatMediaDb = null;
  
  async function openChatMediaDB() {
    if (chatMediaDb) return chatMediaDb;
    return new Promise((resolve) => {
      const request = indexedDB.open(CHAT_MEDIA_DB, 1);
      request.onerror = () => resolve(null);
      request.onsuccess = () => { chatMediaDb = request.result; resolve(chatMediaDb); };
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(CHAT_MEDIA_STORE)) {
          db.createObjectStore(CHAT_MEDIA_STORE, { keyPath: 'url' });
        }
      };
    });
  }
  
  // חלק שמירה (chat-media-renderer.js) – שמירת מדיה למטמון מקומי | HYPER CORE TECH
  async function cacheChatMedia(url, blob) {
    try {
      const db = await openChatMediaDB();
      if (!db) return;
      const tx = db.transaction([CHAT_MEDIA_STORE], 'readwrite');
      const store = tx.objectStore(CHAT_MEDIA_STORE);
      store.put({ url, blob, timestamp: Date.now() });
    } catch (e) { /* ignore */ }
  }
  
  // חלק קריאה (chat-media-renderer.js) – טעינת מדיה מהמטמון | HYPER CORE TECH
  async function getChatMediaFromCache(url) {
    try {
      const db = await openChatMediaDB();
      if (!db) return null;
      const tx = db.transaction([CHAT_MEDIA_STORE], 'readonly');
      const store = tx.objectStore(CHAT_MEDIA_STORE);
      return new Promise((resolve) => {
        const req = store.get(url);
        req.onsuccess = () => resolve(req.result?.blob || null);
        req.onerror = () => resolve(null);
      });
    } catch (e) { return null; }
  }
  
  // חלק הורדה (chat-media-renderer.js) – הורדה ושמירה למטמון | HYPER CORE TECH
  async function fetchAndCacheMedia(url) {
    try {
      // בדוק מטמון קודם
      const cached = await getChatMediaFromCache(url);
      if (cached) {
        // חלק דיבאג מטמון (chat-media-renderer.js) – זוהה cache hit | HYPER CORE TECH
        mediaDebugLog('cache-hit', { url });
        return URL.createObjectURL(cached);
      }
      // חלק דיבאג מטמון (chat-media-renderer.js) – cache miss לפני הורדה | HYPER CORE TECH
      mediaDebugLog('cache-miss', { url });
      // הורד מהרשת
      const response = await fetch(url, { credentials: 'omit' });
      if (!response.ok) return url;
      const blob = await response.blob();
      // שמור למטמון
      await cacheChatMedia(url, blob);
      // חלק דיבאג מטמון (chat-media-renderer.js) – שמירה למטמון הצליחה | HYPER CORE TECH
      mediaDebugLog('cache-store', { url, size: blob.size });
      return URL.createObjectURL(blob);
    } catch (e) {
      // חלק דיבאג מטמון (chat-media-renderer.js) – כשלון הורדה/שמירה | HYPER CORE TECH
      mediaDebugLog('cache-failed', { url, error: e?.message || String(e) });
      return url; // fallback לURL מקורי
    }
  }
  
  // חלק זיהוי (chat-media-renderer.js) – זיהוי סוג קובץ לפי MIME/extension | HYPER CORE TECH
  const IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/bmp', 'image/svg+xml'];
  const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska'];
  const IMAGE_EXTS = /\.(jpe?g|png|gif|webp|heic|heif|bmp|svg)(\?|$)/i;
  const VIDEO_EXTS = /\.(mp4|webm|ogv|mov|avi|mkv|m4v)(\?|$)/i;
  
  function isImageAttachment(attachment) {
    if (!attachment) return false;
    const mime = (attachment.type || '').toLowerCase();
    const name = attachment.name || '';
    const url = attachment.url || attachment.dataUrl || '';
    return IMAGE_TYPES.includes(mime) || IMAGE_EXTS.test(name) || IMAGE_EXTS.test(url);
  }
  
  // חלק זיהוי וידאו (chat-media-renderer.js) – משופר לא לזהות הודעות קוליות כווידאו | HYPER CORE TECH
  function isVideoAttachment(attachment) {
    if (!attachment) return false;
    const mime = (attachment.type || '').toLowerCase();
    const name = (attachment.name || '').toLowerCase();
    const url = (attachment.url || attachment.dataUrl || '').toLowerCase();
    
    // חלק הדרה (chat-media-renderer.js) – הודעות קוליות לא נחשבות וידאו! | HYPER CORE TECH
    // אם יש duration או שם/mime מצביעים על אודיו - זה לא וידאו
    const hasDuration = typeof attachment.duration === 'number' && attachment.duration > 0;
    const isAudioMime = mime.startsWith('audio/');
    const isVoiceByName = name.includes('voice') || url.includes('voice');
    const hasAudioDataUrl = url.startsWith('data:audio/');
    
    // אם זה אודיו - לא נחשיב כווידאו
    if (isAudioMime || isVoiceByName || hasDuration || hasAudioDataUrl) {
      return false;
    }
    
    // webm בצ'אט הוא בד"כ הודעה קולית - נחשיב כווידאו רק אם מסומן מפורשות
    const isWebm = /\.webm(\?|$)/i.test(name) || /\.webm(\?|$)/i.test(url) || mime === 'video/webm';
    if (isWebm && attachment.isVideo !== true) {
      return false;
    }
    
    return VIDEO_TYPES.includes(mime) || VIDEO_EXTS.test(name) || VIDEO_EXTS.test(url);
  }
  
  // חלק YouTube (chat-media-renderer.js) – זיהוי לינק YouTube והפקת video ID | HYPER CORE TECH
  function extractYouTubeId(text) {
    if (!text || typeof text !== 'string') return null;
    
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    
    return null;
  }
  
  async function getYouTubeVideoDuration(videoId) {
    // חלק YouTube API (chat-media-renderer.js) – בדיקת אורך וידאו דרך oEmbed או noembed | HYPER CORE TECH
    try {
      const response = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
      if (!response.ok) return null;
      
      const data = await response.json();
      // noembed לא מחזיר duration, אז נשתמש בהערכה או נדלג על בדיקה
      // אפשר להשתמש ב-YouTube Data API אם יש API key
      return data; // מחזיר metadata כללי
    } catch (err) {
      console.warn('Failed to fetch YouTube metadata', err);
      return null;
    }
  }
  
  // חלק הורדה (chat-media-renderer.js) – הורדת מדיה/קובץ (blob/data/http) | HYPER CORE TECH
  function escapeAttr(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeJsString(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  async function downloadChatMedia(url, filename) {
    const src = String(url || '').trim();
    const name = String(filename || 'sos-file').trim() || 'sos-file';
    if (!src) return false;

    const suppressOutsideClose = () => {
      App.__sosSuppressChatOutsideClose = true;
      const release = () => {
        setTimeout(() => {
          App.__sosSuppressChatOutsideClose = false;
        }, 800);
      };
      return release;
    };

    const triggerAnchorDownload = (href, opts = {}) => {
      const release = suppressOutsideClose();
      const a = document.createElement('a');
      a.href = href;
      a.download = name;
      a.rel = 'noopener';
      a.setAttribute('data-sos-download-link', '1');
      if (opts.targetBlank) a.target = '_blank';
      // חוסם את מאזין ה-click הגלובלי שסוגר את פאנל הצ'אט | HYPER CORE TECH
      a.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      document.body.appendChild(a);
      try {
        a.click();
      } finally {
        a.remove();
        release();
      }
    };

    try {
      if (src.startsWith('blob:') || src.startsWith('data:')) {
        triggerAnchorDownload(src);
        return true;
      }
      try {
        const cached = await fetchAndCacheMedia(src);
        const fetchUrl = cached || src;
        const resp = await fetch(fetchUrl, { mode: 'cors', credentials: 'omit' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        triggerAnchorDownload(blobUrl);
        setTimeout(() => {
          try { URL.revokeObjectURL(blobUrl); } catch (_) {}
        }, 2000);
        return true;
      } catch (err) {
        console.warn('[CHAT-MEDIA] download via fetch failed, fallback open', err);
        triggerAnchorDownload(src, { targetBlank: true });
        return true;
      }
    } catch (err) {
      console.warn('[CHAT-MEDIA] download failed', err);
      App.__sosSuppressChatOutsideClose = false;
      return false;
    }
  }

  function buildMediaDownloadButton(src, name, className) {
    if (!src) return '';
    const cls = className || 'chat-message__media-download';
    const safeName = escapeAttr(name || 'sos-file');
    const jsSrc = escapeJsString(src);
    const jsName = escapeJsString(name || 'sos-file');
    return `<button type="button" class="${cls}" title="הורד" aria-label="הורד ${safeName}" onclick="event.preventDefault();event.stopPropagation();if(window.NostrApp&&typeof NostrApp.downloadChatMedia==='function')NostrApp.downloadChatMedia('${jsSrc}','${jsName}');"><i class="fa-solid fa-download" aria-hidden="true"></i></button>`;
  }

  function buildAttachmentDownloadHtml(attachment, className) {
    if (!attachment) return '';
    const name = attachment.name || 'קובץ';
    const magnetURI = attachment.magnetURI || '';
    const src = attachment.dataUrl || attachment.url || '';
    const cls = className || 'chat-file-bubble__download';
    if (magnetURI) {
      const escapedMagnet = magnetURI.replace(/"/g, '&quot;');
      const escapedName = escapeAttr(name).replace(/'/g, "\\'");
      return `<button type="button" class="${cls} torrent-bubble__download-btn" data-magnet="${escapedMagnet}" data-filename="${escapedName}" title="הורד"><i class="fa-solid fa-download"></i></button>`;
    }
    if (!src) return '';
    return buildMediaDownloadButton(src, name, cls);
  }

  // חלק רינדור תמונה (chat-media-renderer.js) – הצגת תמונה עם מטמון מקומי | HYPER CORE TECH
  function renderImageAttachment(attachment) {
    const src = attachment.url || attachment.dataUrl || '';
    const name = attachment.name || 'תמונה';
    const safeName = App.escapeHtml ? App.escapeHtml(name) : name;
    const uid = 'img-' + Math.random().toString(36).substr(2, 9);
    // חלק דיבאג מדיה (chat-media-renderer.js) – רינדור תמונה | HYPER CORE TECH
    mediaDebugLog('render-image', {
      name,
      mime: attachment.type || '',
      hasSrc: !!src,
      isDataUrl: src.startsWith('data:'),
      isBlob: src.startsWith('blob:')
    });
    
    // טעינה אסינכרונית מהמטמון ברקע
    if (src && !src.startsWith('data:')) {
      setTimeout(async () => {
        const el = document.getElementById(uid);
        if (!el) return;
        const cachedUrl = await fetchAndCacheMedia(src);
        if (cachedUrl && el.src !== cachedUrl) {
          el.src = cachedUrl;
        }
      }, 0);
    }

    const downloadHtml = buildAttachmentDownloadHtml(attachment, 'chat-message__media-download');
    
    return `
      <div class="chat-message__image-container">
        <img 
          id="${uid}"
          src="${src}" 
          alt="${safeName}" 
          class="chat-message__image"
          loading="eager"
          decoding="async"
          referrerpolicy="no-referrer"
          onclick="if(typeof App.openImageLightbox==='function')App.openImageLightbox(this.src,'${safeName.replace(/'/g, "\\'")}')"
        />
        ${downloadHtml}
      </div>
    `;
  }
  
  // חלק רינדור וידאו (chat-media-renderer.js) – נגן בסגנון וואטסאפ: poster + play אחד (בלי פליי ענק של WebView) | HYPER CORE TECH
  function captureChatVideoPoster(videoEl) {
    if (!videoEl || videoEl.dataset.posterCaptured === '1') return;
    if (!videoEl.videoWidth || !videoEl.videoHeight) return;
    try {
      const maxW = 640;
      const scale = Math.min(1, maxW / videoEl.videoWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(videoEl.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(videoEl.videoHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
      if (dataUrl && dataUrl.startsWith('data:image')) {
        videoEl.poster = dataUrl;
        videoEl.dataset.posterCaptured = '1';
        videoEl.classList.add('has-poster');
      }
    } catch (_) {
      // cross-origin / tainted – מתעלמים
    }
  }

  async function ensureChatVideoPosterFrame(videoEl) {
    if (!videoEl || videoEl.dataset.posterCaptured === '1') return;
    if (videoEl.readyState < 1) return;
    let wasMuted = true;
    try {
      wasMuted = videoEl.muted;
      videoEl.muted = true;
      const p = videoEl.play();
      if (p && typeof p.then === 'function') await p.catch(() => {});
      videoEl.pause();
      try { videoEl.currentTime = Math.min(0.05, (videoEl.duration || 1) * 0.01); } catch (_) {}
      await new Promise((r) => setTimeout(r, 60));
      captureChatVideoPoster(videoEl);
    } catch (_) {
    } finally {
      try { videoEl.muted = wasMuted; } catch (_) {}
    }
  }

  function renderVideoAttachment(attachment) {
    const src = attachment.url || attachment.dataUrl || '';
    const type = attachment.type || 'video/mp4';
    const name = attachment.name || 'וידאו';
    const safeName = App.escapeHtml ? App.escapeHtml(name) : name;
    const uid = 'vid-' + Math.random().toString(36).substr(2, 9);
    const containerId = 'vc-' + Math.random().toString(36).substr(2, 9);
    const isLocal = src.startsWith('blob:') || src.startsWith('data:');
    mediaDebugLog('render-video', {
      name,
      mime: type,
      hasSrc: !!src,
      isDataUrl: src.startsWith('data:'),
      isBlob: src.startsWith('blob:')
    });

    setTimeout(async () => {
      const container = document.getElementById(containerId);
      const el = document.getElementById(uid);
      const playBtn = container?.querySelector('.chat-message__video-play');
      if (!el || !container) return;

      if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
        const cachedUrl = await fetchAndCacheMedia(src);
        if (cachedUrl) {
          const source = el.querySelector('source');
          if (source && source.src !== cachedUrl) {
            source.src = cachedUrl;
            el.load();
          }
        }
      }

      const updateDuration = () => {
        const duration = el.duration;
        if (duration && isFinite(duration)) {
          const mins = Math.floor(duration / 60);
          const secs = Math.floor(duration % 60).toString().padStart(2, '0');
          const durationEl = container.querySelector('.chat-message__video-duration');
          if (durationEl) durationEl.textContent = `${mins}:${secs}`;
        }
      };

      el.addEventListener('loadedmetadata', () => {
        updateDuration();
        ensureChatVideoPosterFrame(el);
      });
      el.addEventListener('loadeddata', () => {
        captureChatVideoPoster(el);
        if (!el.dataset.posterCaptured) ensureChatVideoPosterFrame(el);
      });
      el.addEventListener('seeked', () => captureChatVideoPoster(el));

      const startPlayback = (event) => {
        if (event) {
          event.preventDefault();
          event.stopPropagation();
        }
        el.setAttribute('controls', '');
        container.classList.add('playing');
        const playPromise = el.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch((err) => {
            console.warn('[CHAT/MEDIA] video play failed', err);
            container.classList.remove('playing');
          });
        }
      };

      if (playBtn) {
        playBtn.addEventListener('click', startPlayback);
      }
      // לחיצה על התמונה/poster לפני שיש controls
      el.addEventListener('click', (event) => {
        if (container.classList.contains('playing') || el.hasAttribute('controls')) return;
        startPlayback(event);
      });

      el.addEventListener('play', () => {
        container.classList.add('playing');
        el.setAttribute('controls', '');
      });
      el.addEventListener('pause', () => {
        container.classList.remove('playing');
      });
      el.addEventListener('ended', () => {
        container.classList.remove('playing');
        try { el.currentTime = 0; } catch (_) {}
      });
    }, 0);

    return `
      <div id="${containerId}" class="chat-message__video-container">
        <button type="button" class="chat-message__video-play" aria-label="נגן וידאו">
          <span class="chat-message__video-play-icon" aria-hidden="true"></span>
        </button>
        <span class="chat-message__video-duration">0:00</span>
        ${buildAttachmentDownloadHtml(attachment, 'chat-message__media-download')}
        <video
          id="${uid}"
          class="chat-message__video"
          preload="${isLocal ? 'auto' : 'metadata'}"
          playsinline
          webkit-playsinline
          aria-label="${safeName}"
        >
          <source src="${src}" type="${type}">
        </video>
      </div>
    `;
  }
  
  // חלק רינדור YouTube (chat-media-renderer.js) – iframe מוטמע עם בדיקת אורך | HYPER CORE TECH
  async function renderYouTubeEmbed(videoId, messageText) {
    // בדיקת אורך וידאו (אופציונלי - דורש API key או שירות חיצוני)
    const metadata = await getYouTubeVideoDuration(videoId);
    
    // כרגע מציגים את כל הסרטונים; אפשר להוסיף תנאי אורך
    // if (metadata && metadata.duration > MAX_DURATION) return null;
    
    return `
      <div class="chat-message__youtube-container">
        <iframe
          class="chat-message__youtube-iframe"
          src="https://www.youtube.com/embed/${videoId}"
          frameborder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen
          loading="lazy"
          title="YouTube video"
        ></iframe>
      </div>
    `;
  }
  
  // חלק זיהוי אוטומטי (chat-media-renderer.js) – סריקת טקסט הודעה ללינקי YouTube | HYPER CORE TECH
  async function detectAndRenderYouTube(messageText) {
    const videoId = extractYouTubeId(messageText);
    if (!videoId) return null;
    
    return await renderYouTubeEmbed(videoId, messageText);
  }
  
  // חלק lightbox (chat-media-renderer.js) – פתיחת תמונה במסך מלא | HYPER CORE TECH
  function openImageLightbox(src, name) {
    const existing = document.getElementById('chatImageLightbox');
    if (existing) existing.remove();
    
    const lightbox = document.createElement('div');
    lightbox.id = 'chatImageLightbox';
    lightbox.className = 'chat-lightbox';
    const safeName = App.escapeHtml ? App.escapeHtml(name || 'תמונה') : String(name || 'תמונה');
    lightbox.innerHTML = `
      <div class="chat-lightbox__backdrop"></div>
      <div class="chat-lightbox__content">
        <div class="chat-lightbox__actions">
          <button type="button" class="chat-lightbox__download" aria-label="הורד" title="הורד">
            <i class="fa-solid fa-download"></i>
          </button>
          <button type="button" class="chat-lightbox__close" aria-label="סגור" title="סגור">
            <i class="fa-solid fa-times"></i>
          </button>
        </div>
        <img src="${src}" alt="${safeName}" class="chat-lightbox__image">
        <div class="chat-lightbox__name">${safeName}</div>
      </div>
    `;
    
    document.body.appendChild(lightbox);
    
    const close = (event) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      lightbox.classList.add('chat-lightbox--closing');
      setTimeout(() => lightbox.remove(), 200);
    };
    
    lightbox.querySelector('.chat-lightbox__close').addEventListener('click', close);
    lightbox.querySelector('.chat-lightbox__backdrop').addEventListener('click', close);
    lightbox.querySelector('.chat-lightbox__download')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      App.__sosSuppressChatOutsideClose = true;
      Promise.resolve(downloadChatMedia(src, name || 'image.jpg')).finally(() => {
        setTimeout(() => { App.__sosSuppressChatOutsideClose = false; }, 800);
      });
    });
    lightbox.addEventListener('click', (event) => event.stopPropagation());
    
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') {
        close(e);
        document.removeEventListener('keydown', onEsc);
      }
    });
    
    requestAnimationFrame(() => lightbox.classList.add('chat-lightbox--visible'));
  }
  
  // חלק זיהוי PDF (chat-media-renderer.js) – בדיקה אם attachment הוא קובץ PDF | HYPER CORE TECH
  function isPdfAttachment(attachment) {
    if (!attachment) return false;
    const mime = (attachment.type || '').toLowerCase();
    const name = (attachment.name || '').toLowerCase();
    return mime === 'application/pdf' || name.endsWith('.pdf');
  }

  // חלק רנדור PDF (chat-media-renderer.js) – תצוגה מקדימה של עמוד ראשון בסגנון WhatsApp | HYPER CORE TECH
  function renderPdfAttachment(attachment) {
    const name = attachment.name || 'קובץ PDF';
    const safeName = App.escapeHtml ? App.escapeHtml(name) : name;
    const size = formatSize(attachment.size);
    const magnetURI = attachment.magnetURI || '';
    const dataUrl = attachment.dataUrl || attachment.url || '';
    const uid = 'pdf-' + Math.random().toString(36).substr(2, 9);
    // חלק דיבאג מדיה (chat-media-renderer.js) – רינדור PDF | HYPER CORE TECH
    mediaDebugLog('render-pdf', { name, mime: attachment.type || '', hasDataUrl: !!dataUrl, hasMagnet: !!magnetURI });

    // כפתור הורדה — לקבצי טורנט / URL / DataURL
    const downloadHtml = buildAttachmentDownloadHtml(attachment, 'chat-pdf-bubble__download');

    // רנדור אסינכרוני של העמוד הראשון באמצעות PDF.js
    setTimeout(async () => {
      const canvasEl = document.getElementById(uid);
      if (!canvasEl) return;
      const pagesEl = document.getElementById(uid + '-pages');
      try {
        if (!window.pdfjsLib) {
          console.warn('[PDF-PREVIEW] pdf.js לא נטען');
          return;
        }
        let pdfSource = null;
        if (dataUrl && dataUrl.startsWith('data:')) {
          // המרת data URL ל-Uint8Array
          const base64 = dataUrl.split(',')[1];
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          pdfSource = { data: bytes };
        } else if (dataUrl) {
          pdfSource = { url: dataUrl };
        } else {
          // אין מקור זמין (קובץ טורנט שעדיין לא הורד)
          return;
        }
        const pdf = await window.pdfjsLib.getDocument(pdfSource).promise;
        // הצגת מספר עמודים
        if (pagesEl) pagesEl.textContent = pdf.numPages + ' עמודים';
        // רנדור עמוד ראשון
        const page = await pdf.getPage(1);
        const scale = 300 / page.getViewport({ scale: 1 }).width;
        const viewport = page.getViewport({ scale });
        canvasEl.width = viewport.width;
        canvasEl.height = viewport.height;
        const ctx = canvasEl.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        canvasEl.classList.add('chat-pdf-bubble__canvas--loaded');
        console.log('[PDF-PREVIEW] ✅ רנדור הצליח:', name);
        // חלק דיבאג מדיה (chat-media-renderer.js) – PDF נטען בהצלחה | HYPER CORE TECH
        mediaDebugLog('render-pdf-success', { name, pages: pdf.numPages || null });
      } catch (err) {
        console.warn('[PDF-PREVIEW] ❌ שגיאה ברנדור PDF:', err);
        // חלק דיבאג מדיה (chat-media-renderer.js) – שגיאת רנדור PDF | HYPER CORE TECH
        mediaDebugLog('render-pdf-failed', { name, error: err?.message || String(err) });
      }
    }, 50);

    return `
      <div class="chat-pdf-bubble" id="${uid}-wrap">
        <div class="chat-pdf-bubble__preview">
          <canvas id="${uid}" class="chat-pdf-bubble__canvas"></canvas>
          <div class="chat-pdf-bubble__overlay">
            <i class="fa-solid fa-file-pdf chat-pdf-bubble__icon"></i>
          </div>
        </div>
        <div class="chat-pdf-bubble__footer">
          <div class="chat-pdf-bubble__info">
            <div class="chat-pdf-bubble__name">${safeName}</div>
            <div class="chat-pdf-bubble__meta"><span class="chat-pdf-bubble__size">${size}</span><span id="${uid}-pages" class="chat-pdf-bubble__pages"></span></div>
          </div>
          ${downloadHtml}
        </div>
      </div>
    `;
  }

  // חלק זיהוי HTML (chat-media-renderer.js) – בדיקה אם attachment הוא קובץ HTML | HYPER CORE TECH
  function isHtmlAttachment(att) {
    if (!att) return false;
    const m = (att.type || '').toLowerCase(), n = (att.name || '').toLowerCase();
    return m === 'text/html' || n.endsWith('.html') || n.endsWith('.htm');
  }

  // חלק רנדור HTML (chat-media-renderer.js) – תצוגה מקדימה ב-iframe sandbox בסגנון PDF | HYPER CORE TECH
  function renderHtmlAttachment(att) {
    const name = att.name || 'דף HTML';
    const safeName = App.escapeHtml ? App.escapeHtml(name) : name;
    const size = formatSize(att.size);
    const dataUrl = att.dataUrl || att.url || '';
    const magnetURI = att.magnetURI || '';
    const uid = 'html-' + Math.random().toString(36).substr(2, 9);
    // חלק דיבאג מדיה (chat-media-renderer.js) – רינדור HTML | HYPER CORE TECH
    mediaDebugLog('render-html', { name, mime: att.type || '', hasDataUrl: !!dataUrl, hasMagnet: !!magnetURI });
    const dlHtml = buildAttachmentDownloadHtml(att, 'chat-pdf-bubble__download');
    setTimeout(() => {
      const fr = document.getElementById(uid);
      if (!fr) return;
      try {
        if (!dataUrl || !dataUrl.startsWith('data:')) return;
        const parts = dataUrl.split(',');
        let raw = '';
        if (parts[0].includes('base64')) {
          // פענוח base64 ל-UTF-8 תקין (תמיכה בעברית ותווים מיוחדים)
          const bin = atob(parts[1]);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          raw = new TextDecoder('utf-8').decode(bytes);
        } else {
          raw = decodeURIComponent(parts[1]);
        }
        // הוספת CSS צמצום בלבד — שומר את כל הסגנונות המקוריים של הדף
        const scaleStyle = '<style>html,body{transform:scale(0.45);transform-origin:0 0;width:222%;overflow:hidden;pointer-events:none;}</style>';
        const injected = raw.replace(/<head([^>]*)>/i, '<head$1><meta charset="utf-8">' + scaleStyle);
        fr.srcdoc = injected;
        fr.onload = () => fr.classList.add('chat-html-bubble__frame--loaded');
      } catch(e) { console.warn('[HTML-PREVIEW]', e); }
    }, 50);
    return `
      <div class="chat-pdf-bubble" id="${uid}-wrap">
        <div class="chat-html-bubble__preview">
          <iframe id="${uid}" class="chat-html-bubble__frame" sandbox="allow-same-origin" scrolling="no" frameborder="0"></iframe>
          <div class="chat-pdf-bubble__overlay"><i class="fa-solid fa-code chat-pdf-bubble__icon" style="color:#e67e22"></i></div>
        </div>
        <div class="chat-pdf-bubble__footer">
          <div class="chat-pdf-bubble__info">
            <div class="chat-pdf-bubble__name">${safeName}</div>
            <div class="chat-pdf-bubble__meta"><span class="chat-pdf-bubble__size">${size}</span><span>HTML</span></div>
          </div>
          ${dlHtml}
        </div>
      </div>`;
  }

  // חלק קובץ כללי (chat-media-renderer.js) – זיהוי קובץ טורנט/כללי שאינו תמונה/וידאו/אודיו | HYPER CORE TECH
  function isTorrentFileAttachment(attachment) {
    if (!attachment) return false;
    return !!(attachment.isTorrent && attachment.magnetURI);
  }

  function isGenericFileAttachment(attachment) {
    if (!attachment) return false;
    if (isImageAttachment(attachment) || isVideoAttachment(attachment)) return false;
    const mime = (attachment.type || '').toLowerCase();
    if (mime.startsWith('audio/')) return false;
    // קובץ כללי: PDF, ZIP, TXT, DOC וכו'
    return !!(attachment.name || attachment.magnetURI || attachment.url || attachment.dataUrl);
  }

  // חלק אייקון קובץ (chat-media-renderer.js) – בחירת אייקון FontAwesome לפי סיומת/MIME | HYPER CORE TECH
  function getFileIcon(attachment) {
    const name = (attachment.name || '').toLowerCase();
    const mime = (attachment.type || '').toLowerCase();
    if (name.endsWith('.pdf') || mime === 'application/pdf') return 'fa-file-pdf';
    if (name.endsWith('.doc') || name.endsWith('.docx') || mime.includes('word')) return 'fa-file-word';
    if (name.endsWith('.xls') || name.endsWith('.xlsx') || mime.includes('spreadsheet') || mime.includes('excel')) return 'fa-file-excel';
    if (name.endsWith('.ppt') || name.endsWith('.pptx') || mime.includes('presentation')) return 'fa-file-powerpoint';
    if (name.endsWith('.zip') || name.endsWith('.rar') || name.endsWith('.7z') || name.endsWith('.tar') || name.endsWith('.gz') || mime.includes('zip') || mime.includes('compressed') || mime.includes('archive')) return 'fa-file-zipper';
    if (name.endsWith('.txt') || name.endsWith('.csv') || name.endsWith('.log') || mime.startsWith('text/')) return 'fa-file-lines';
    if (name.endsWith('.json') || name.endsWith('.xml') || name.endsWith('.html') || name.endsWith('.css') || name.endsWith('.js') || name.endsWith('.py')) return 'fa-file-code';
    if (name.endsWith('.apk')) return 'fa-robot';
    if (name.endsWith('.exe') || name.endsWith('.msi')) return 'fa-desktop';
    return 'fa-file';
  }

  // חלק פורמט גודל (chat-media-renderer.js) – המרת bytes לפורמט קריא | HYPER CORE TECH
  function formatSize(bytes) {
    if (!bytes || bytes === 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // חלק רנדור קובץ כללי (chat-media-renderer.js) – בועת קובץ בסגנון WhatsApp עם אייקון, שם, גודל וכפתור הורדה | HYPER CORE TECH
  function renderGenericFileAttachment(attachment) {
    const name = attachment.name || 'קובץ';
    const safeName = App.escapeHtml ? App.escapeHtml(name) : name;
    const size = formatSize(attachment.size);
    const iconClass = getFileIcon(attachment);
    const downloadHtml = buildAttachmentDownloadHtml(attachment, 'chat-file-bubble__download');

    return `
      <div class="chat-file-bubble">
        <div class="chat-file-bubble__icon"><i class="fa-solid ${iconClass}"></i></div>
        <div class="chat-file-bubble__info">
          <div class="chat-file-bubble__name">${safeName}</div>
          <div class="chat-file-bubble__size">${size}</div>
        </div>
        ${downloadHtml}
      </div>
    `;
  }

  // חלק API ציבורי (chat-media-renderer.js) – חשיפת פונקציות לרינדור מדיה וקבצים כלליים | HYPER CORE TECH
  Object.assign(App, {
    isImageAttachment,
    isVideoAttachment,
    isPdfAttachment,
    isHtmlAttachment,
    isTorrentFileAttachment,
    isGenericFileAttachment,
    renderImageAttachment,
    renderVideoAttachment,
    renderPdfAttachment,
    renderHtmlAttachment,
    renderGenericFileAttachment,
    detectAndRenderYouTube,
    extractYouTubeId,
    openImageLightbox,
    downloadChatMedia,
    getFileIcon,
    // מטמון מדיה צ'אט | HYPER CORE TECH
    fetchAndCacheChatMedia: fetchAndCacheMedia,
    getChatMediaFromCache
  });
  
  // אתחול מטמון צ'אט | HYPER CORE TECH
  openChatMediaDB().then(() => console.log('[CHAT-MEDIA] Cache initialized'));
})(window);
