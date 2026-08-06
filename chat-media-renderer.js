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

  // חלק מפתח P2P (chat-media-renderer.js) – מפתח יציב לקבצי צ'אט שנשמרו אחרי העברת P2P | HYPER CORE TECH
  function chatP2PCacheKey(fileIdOrAttachment) {
    if (!fileIdOrAttachment) return '';
    if (typeof fileIdOrAttachment === 'string') {
      return fileIdOrAttachment.startsWith('p2p-file-')
        ? fileIdOrAttachment
        : `p2p-file-${fileIdOrAttachment}`;
    }
    const att = fileIdOrAttachment;
    if (att.cacheKey) return String(att.cacheKey);
    if (att.fileId) return `p2p-file-${att.fileId}`;
    return '';
  }

  // חלק שמירת P2P (chat-media-renderer.js) – שמירת blob תחת מפתח יציב ששורד restart | HYPER CORE TECH
  async function persistChatP2PMedia(fileId, blob, meta = {}) {
    if (!fileId || !blob) return '';
    const cacheKey = chatP2PCacheKey(fileId);
    try {
      await cacheChatMedia(cacheKey, blob);
      if (typeof App.cacheMedia === 'function') {
        await App.cacheMedia(cacheKey, cacheKey, blob, meta.type || blob.type || 'application/octet-stream', {
          pinned: true,
        });
      }
      mediaDebugLog('p2p-persist', { cacheKey, size: blob.size, name: meta.name || '' });
      return cacheKey;
    } catch (err) {
      mediaDebugLog('p2p-persist-failed', { cacheKey, error: err?.message || String(err) });
      return cacheKey;
    }
  }

  async function loadChatP2PMediaBlob(cacheKey) {
    if (!cacheKey) return null;
    try {
      const fromChat = await getChatMediaFromCache(cacheKey);
      if (fromChat) return fromChat;
      if (typeof App.getCachedMedia === 'function') {
        const fromFeed = await App.getCachedMedia(cacheKey);
        if (fromFeed?.blob) {
          // סנכרון חזרה למטמון הצ'אט | HYPER CORE TECH
          await cacheChatMedia(cacheKey, fromFeed.blob);
          return fromFeed.blob;
        }
      }
    } catch (_) {}
    return null;
  }

  // חלק שחזור מקור (chat-media-renderer.js) – blob מת אחרי restart → טעינה לפי fileId/cacheKey | HYPER CORE TECH
  async function resolveChatMediaSrc(attachment) {
    if (!attachment) return '';
    const src = String(attachment.url || attachment.dataUrl || '').trim();
    const cacheKey = chatP2PCacheKey(attachment);

    const fromDurable = async () => {
      if (!cacheKey) return '';
      const blob = await loadChatP2PMediaBlob(cacheKey);
      if (!blob) return '';
      return URL.createObjectURL(blob);
    };

    if (src.startsWith('blob:')) {
      // אם ה־blob עדיין חי (אותו session) – שמירה אופורטוניסטית + שימוש בו | HYPER CORE TECH
      try {
        const resp = await fetch(src);
        if (resp.ok) {
          const liveBlob = await resp.blob();
          if (cacheKey && liveBlob?.size > 0) {
            persistChatP2PMedia(cacheKey.replace(/^p2p-file-/, ''), liveBlob, {
              name: attachment.name,
              type: attachment.type || liveBlob.type,
            }).catch(() => {});
          }
          return src;
        }
      } catch (_) {}
      // blob מת – שחזור מהקאש | HYPER CORE TECH
      const restored = await fromDurable();
      if (restored) {
        mediaDebugLog('p2p-restore-from-cache', { cacheKey });
        return restored;
      }
      return '';
    }

    if (cacheKey && (!src || src.startsWith('blob:'))) {
      const restored = await fromDurable();
      if (restored) return restored;
    }

    // גם כשיש http – ננסה קודם קאש יציב אם קיים (מהיר יותר) | HYPER CORE TECH
    if (cacheKey) {
      const restored = await fromDurable();
      if (restored) return restored;
    }

    if (src.startsWith('data:')) return src;
    if (src) return fetchAndCacheMedia(src);
    return '';
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

  // חלק רינדור תמונה (chat-media-renderer.js) – חשיפה רק אחרי טעינה מלאה (בלי שלד/שם קובץ) | HYPER CORE TECH
  function renderImageAttachment(attachment) {
    const src = attachment.url || attachment.dataUrl || '';
    const name = attachment.name || 'תמונה';
    const safeName = App.escapeHtml ? App.escapeHtml(name) : name;
    const uid = 'img-' + Math.random().toString(36).substr(2, 9);
    const wrapId = uid + '-wrap';
    const initialSrc = (src && !src.startsWith('blob:')) ? src : '';
    mediaDebugLog('render-image', {
      name,
      mime: attachment.type || '',
      hasSrc: !!src,
      isDataUrl: src.startsWith('data:'),
      isBlob: src.startsWith('blob:'),
      fileId: attachment.fileId || null,
      cacheKey: chatP2PCacheKey(attachment) || null,
    });

    setTimeout(async () => {
      const el = document.getElementById(uid);
      const wrap = document.getElementById(wrapId);
      if (!el || !wrap) return;

      const revealImage = () => {
        if (wrap.dataset.ready === '1') return;
        const nw = el.naturalWidth || 0;
        const nh = el.naturalHeight || 0;
        if (nw && nh && typeof applyChatMediaBoxSize === 'function') {
          const box = applyChatMediaBoxSize(wrap, nw, nh, { force: true });
          if (box) {
            wrap.classList.toggle('chat-message__image-container--portrait', !!box.portrait);
            wrap.classList.toggle('chat-message__image-container--landscape', !box.portrait);
          }
        }
        wrap.dataset.ready = '1';
        wrap.classList.remove('is-media-pending', 'is-media-failed');
        wrap.classList.add('is-media-ready');
        wrap.hidden = false;
        el.style.opacity = '1';
        revealChatMessageBubble(wrap);
      };

      const failImage = () => {
        wrap.dataset.ready = '0';
        wrap.classList.remove('is-media-pending', 'is-media-ready');
        wrap.classList.add('is-media-failed');
        wrap.hidden = true;
        try { el.removeAttribute('src'); } catch (_) {}
        failChatMessageBubble(wrap);
      };

      el.addEventListener('load', revealImage);
      el.addEventListener('error', failImage);

      let playable = initialSrc;
      try {
        const resolved = await resolveChatMediaSrc(attachment);
        if (resolved) playable = resolved;
      } catch (_) {}

      if (!playable) {
        failImage();
        return;
      }
      if (el.src !== playable) el.src = playable;
      if (el.complete && el.naturalWidth > 0) revealImage();
      // timeout — לא משאירים שלד לנצח | HYPER CORE TECH
      setTimeout(() => {
        if (wrap.dataset.ready !== '1') failImage();
      }, 12000);
    }, 0);

    return `
      <div id="${wrapId}" class="chat-message__image-container is-media-pending" hidden>
        <img
          id="${uid}"
          src="${initialSrc}"
          alt=""
          class="chat-message__image"
          loading="eager"
          decoding="async"
          referrerpolicy="no-referrer"
          onclick="if(typeof App.openImageLightbox==='function')App.openImageLightbox(this.src,'${safeName.replace(/'/g, "\\'")}',this)"
        />
      </div>
    `;
  }
  
  // חלק רינדור וידאו (chat-media-renderer.js) – נגן בסגנון וואטסאפ: poster + play אחד (בלי פליי ענק של WebView) | HYPER CORE TECH
  // poster שחור 1×1 — רק בזמן pending, מוסר בחשיפה אם אין פריים אמיתי | HYPER CORE TECH
  const CHAT_VIDEO_BLACK_POSTER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  function canvasLooksMostlyBlack(ctx, canvas) {
    try {
      const sw = Math.min(24, canvas.width);
      const sh = Math.min(24, canvas.height);
      const { data } = ctx.getImageData(0, 0, sw, sh);
      let lit = 0;
      const total = sw * sh;
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i] + data[i + 1] + data[i + 2]) > 40) lit += 1;
      }
      return lit < Math.max(2, total * 0.02);
    } catch (_) {
      return false;
    }
  }

  function isUsablePosterDataUrl(dataUrl) {
    return typeof dataUrl === 'string'
      && dataUrl.startsWith('data:image/')
      && dataUrl.length > 200
      && dataUrl !== CHAT_VIDEO_BLACK_POSTER;
  }

  function needsAndroidVideoPlaceholder() {
    try {
      if (window.SosNativeShell) return true;
      const ua = navigator.userAgent || '';
      if (/SOSNativeShell\//i.test(ua)) return true;
      if (/Android/i.test(ua)) return true;
    } catch (_) {}
    return false;
  }

  // לכידת תקציר מוידאו File/Blob — video מחוץ למסך לגמרי (בלי פליי לבן ברקע) | HYPER CORE TECH
  async function capturePosterFromBlob(blobOrFile, mimeHint = '') {
    if (!blobOrFile) return '';
    const mime = String(mimeHint || blobOrFile.type || '').toLowerCase();
    const name = String(blobOrFile.name || '').toLowerCase();
    const looksVideo = mime.startsWith('video/')
      || mimeHint.toLowerCase().startsWith('video/')
      || /\.(mp4|m4v|mov|webm|mkv|avi|3gp)$/i.test(name)
      || (!mime && blobOrFile.size > 1024);
    if (!looksVideo) return '';

    return new Promise((resolve) => {
      let settled = false;
      const objectUrl = URL.createObjectURL(blobOrFile);
      const host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      // מחוץ ל־viewport + מוסתר — המשתמש לא רואה פליי מערכת / קפיצות | HYPER CORE TECH
      host.style.cssText = [
        'position:fixed',
        'left:-10000px',
        'top:0',
        'width:320px',
        'height:320px',
        'opacity:0',
        'visibility:hidden',
        'pointer-events:none',
        'overflow:hidden',
        'clip:rect(0,0,0,0)',
        'clip-path:inset(50%)',
        'z-index:-1',
        'contain:strict',
      ].join(';');

      const video = document.createElement('video');
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.disablePictureInPicture = true;
      video.controls = false;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.setAttribute('controlslist', 'nodownload nofullscreen noremoteplayback');
      video.preload = 'auto';
      video.style.cssText = 'width:320px;height:320px;opacity:0;visibility:hidden;background:#000;';
      host.appendChild(video);
      document.body.appendChild(host);

      const cleanup = () => {
        try { URL.revokeObjectURL(objectUrl); } catch (_) {}
        try { video.pause(); } catch (_) {}
        try { video.removeAttribute('src'); video.load(); } catch (_) {}
        try { host.remove(); } catch (_) {}
      };

      const finish = (dataUrl) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(isUsablePosterDataUrl(dataUrl) ? dataUrl : '');
      };

      const grabFrame = () => {
        if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return '';
        try {
          const maxW = 640;
          const scale = Math.min(1, maxW / video.videoWidth);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) return '';
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          if (canvasLooksMostlyBlack(ctx, canvas)) return '';
          const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
          return isUsablePosterDataUrl(dataUrl) ? dataUrl : '';
        } catch (_) {
          return '';
        }
      };

      const tryCapture = async () => {
        try {
          const playP = video.play();
          if (playP && typeof playP.then === 'function') await playP.catch(() => {});
          await new Promise((r) => setTimeout(r, 120));
          try { video.pause(); } catch (_) {}
          const duration = isFinite(video.duration) ? video.duration : 0;
          const target = duration > 0.4 ? Math.min(0.25, duration * 0.04) : 0.08;
          try {
            if (typeof video.fastSeek === 'function') video.fastSeek(target);
            else video.currentTime = target;
          } catch (_) {}
          await new Promise((r) => {
            video.addEventListener('seeked', () => r(), { once: true });
            setTimeout(r, 350);
          });
          let shot = grabFrame();
          if (!shot) {
            try { video.currentTime = 0.001; } catch (_) {}
            await new Promise((r) => setTimeout(r, 180));
            shot = grabFrame();
          }
          if (shot) {
            finish(shot);
            return true;
          }
        } catch (_) {}
        return false;
      };

      video.addEventListener('loadeddata', () => { tryCapture(); }, { once: true });
      video.addEventListener('canplay', () => { tryCapture(); }, { once: true });
      video.addEventListener('error', () => finish(''), { once: true });
      setTimeout(() => { if (!settled) tryCapture().then((ok) => { if (!ok) finish(''); }); }, 2500);
      setTimeout(() => finish(''), 9000);
      video.src = objectUrl;
      try { video.load(); } catch (_) {}
    });
  }

  async function persistChatP2PPoster(fileId, posterDataUrl) {
    if (!fileId || !isUsablePosterDataUrl(posterDataUrl)) return;
    const cacheKey = `${chatP2PCacheKey(fileId)}-poster`;
    try {
      const resp = await fetch(posterDataUrl);
      const blob = await resp.blob();
      if (blob?.size > 0) await cacheChatMedia(cacheKey, blob);
    } catch (_) {}
  }

  async function loadChatP2PPosterDataUrl(fileIdOrAttachment) {
    const fileId = typeof fileIdOrAttachment === 'string'
      ? fileIdOrAttachment.replace(/^p2p-file-/, '').replace(/-poster$/, '')
      : (fileIdOrAttachment?.fileId || '');
    if (!fileId) return '';
    if (isUsablePosterDataUrl(fileIdOrAttachment?.posterDataUrl)) return fileIdOrAttachment.posterDataUrl;
    if (isUsablePosterDataUrl(fileIdOrAttachment?.poster)) return fileIdOrAttachment.poster;
    try {
      const blob = await loadChatP2PMediaBlob(`${chatP2PCacheKey(fileId)}-poster`);
      if (!blob) return '';
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(isUsablePosterDataUrl(reader.result) ? reader.result : '');
        reader.onerror = () => resolve('');
        reader.readAsDataURL(blob);
      });
    } catch (_) {
      return '';
    }
  }

  function applyChatVideoPoster(container, videoEl, posterDataUrl) {
    if (!container || !videoEl || !isUsablePosterDataUrl(posterDataUrl)) return false;
    videoEl.poster = posterDataUrl;
    videoEl.dataset.posterCaptured = '1';
    videoEl.classList.add('has-poster');
    const thumb = container.querySelector('.chat-message__video-thumb');
    if (thumb) {
      thumb.src = posterDataUrl;
      thumb.hidden = false;
    }
    // התקציר הוא מה שרואים — הווידאו נשאר מוסתר כדי שלא ירצד שחור מעליו | HYPER CORE TECH
    container.classList.add('has-video-thumb');
    videoEl.style.opacity = '0';
    videoEl.style.visibility = 'hidden';
    return true;
  }

  function captureChatVideoPoster(videoEl) {
    if (!videoEl || videoEl.dataset.posterCaptured === '1') return false;
    if (!videoEl.videoWidth || !videoEl.videoHeight) return false;
    if (videoEl.readyState < 2) return false;
    try {
      const maxW = 640;
      const scale = Math.min(1, maxW / videoEl.videoWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(videoEl.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(videoEl.videoHeight * scale));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      // לא נועלים פריים שחור כ־poster — זה מה שגרם לתצוגה שחורה קבועה | HYPER CORE TECH
      if (canvasLooksMostlyBlack(ctx, canvas)) return false;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      if (isUsablePosterDataUrl(dataUrl)) {
        const container = videoEl.closest('.chat-message__video-container');
        applyChatVideoPoster(container, videoEl, dataUrl);
        return true;
      }
    } catch (_) {
      // cross-origin / tainted – מתעלמים
    }
    return false;
  }

  function seekChatVideo(videoEl, time) {
    return new Promise((resolve) => {
      if (!videoEl) return resolve(false);
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        videoEl.removeEventListener('seeked', onSeeked);
        videoEl.removeEventListener('error', onErr);
        resolve(ok);
      };
      const onSeeked = () => finish(true);
      const onErr = () => finish(false);
      videoEl.addEventListener('seeked', onSeeked, { once: true });
      videoEl.addEventListener('error', onErr, { once: true });
      try {
        const t = Math.max(0, Number(time) || 0);
        if (typeof videoEl.fastSeek === 'function') videoEl.fastSeek(t);
        else videoEl.currentTime = t;
      } catch (_) {
        finish(false);
        return;
      }
      setTimeout(() => finish(videoEl.readyState >= 2), 400);
    });
  }

  async function ensureChatVideoPosterFrame(videoEl) {
    if (!videoEl || videoEl.dataset.posterCaptured === '1') return videoEl?.dataset?.posterCaptured === '1';
    if (videoEl.readyState < 1) return false;
    let wasMuted = true;
    try {
      wasMuted = videoEl.muted;
      videoEl.muted = true;
      // play קצר מצייר פריים ב־Android WebView (כמו בפיד) | HYPER CORE TECH
      const p = videoEl.play();
      if (p && typeof p.then === 'function') await p.catch(() => {});
      await new Promise((r) => setTimeout(r, 80));
      videoEl.pause();
      const duration = isFinite(videoEl.duration) ? videoEl.duration : 0;
      const target = duration > 0.3 ? Math.min(0.2, duration * 0.03) : 0.05;
      await seekChatVideo(videoEl, target);
      if (captureChatVideoPoster(videoEl)) return true;
      await seekChatVideo(videoEl, 0.001);
      if (captureChatVideoPoster(videoEl)) return true;
      // גם בלי canvas — לפחות יש פריים מצויר על ה־video עצמו | HYPER CORE TECH
      videoEl.dataset.previewFrame = '1';
      return false;
    } catch (_) {
      return false;
    } finally {
      try { videoEl.muted = wasMuted; } catch (_) {}
      try { videoEl.pause(); } catch (_) {}
    }
  }

  function messageHasVisibleCaption(msg) {
    const textEl = msg?.querySelector?.('.chat-message__text');
    const raw = (textEl?.textContent || '').trim();
    return !!(raw && !/^📎\s/.test(raw));
  }

  // חשיפת בועת ההודעה רק כשהמדיה מוכנה — מונע פסי בועה ריקים | HYPER CORE TECH
  function revealChatMessageBubble(mediaEl) {
    const msg = mediaEl?.closest?.('.chat-message');
    if (!msg) return;
    msg.classList.remove('chat-message--media-pending', 'chat-message--media-failed');
    msg.hidden = false;
  }

  function failChatMessageBubble(mediaEl) {
    const msg = mediaEl?.closest?.('.chat-message');
    if (!msg) return;
    if (messageHasVisibleCaption(msg)) {
      msg.classList.remove('chat-message--media-pending');
      return;
    }
    const hasReady = msg.querySelector(
      '.chat-message__image-container.is-media-ready, .chat-message__video-container.is-media-ready, audio, .chat-audio, [data-audio]'
    );
    if (hasReady) {
      msg.classList.remove('chat-message--media-pending', 'chat-message--media-failed');
      msg.hidden = false;
      return;
    }
    msg.classList.remove('chat-message--media-pending');
    msg.classList.add('chat-message--media-failed');
    msg.hidden = true;
  }

  // גודל מדיה כמו וואטסאפ — px מפורשים (לא % על fit-content שקורס למיניאטורה) | HYPER CORE TECH
  function getChatMediaAvailWidth(hostEl) {
    const col =
      hostEl?.closest?.('.chat-conversation__messages') ||
      document.getElementById('chatMessages') ||
      document.documentElement;
    const colW = Math.max(0, col?.clientWidth || 0);
    const viewW = Math.max(0, window.innerWidth || document.documentElement?.clientWidth || 360);
    // אם העמודה עדיין 0 (לפני layout) — נופלים ל־viewport | HYPER CORE TECH
    const raw = colW > 40 ? colW : viewW;
    const narrow = viewW <= 768 || (window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
    // מובייל: ~73% ממסך (הוקטן ב־15% מהמקסימום הקודם) | HYPER CORE TECH
    if (narrow) {
      return Math.max(200, Math.min(Math.floor(viewW * 0.73), Math.floor(raw * 0.8) - 4));
    }
    return Math.max(260, Math.min(380, Math.floor(raw * 0.72) - 16));
  }

  function computeChatMediaBox(w, h, hostEl) {
    const portrait = h > w;
    const avail = getChatMediaAvailWidth(hostEl);
    const vh = window.innerHeight || document.documentElement?.clientHeight || 640;
    const viewW = window.innerWidth || 360;
    const narrow = viewW <= 768 || (window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
    const aspect = w / Math.max(1, h);
    const ultraWide = !portrait && aspect >= 1.9;

    // מסגרת בועה קבועה לכיוון — המדיה ממלאת ב־cover (בלי פסי שוליים) | HYPER CORE TECH
    let maxW;
    let maxH;
    if (narrow) {
      maxW = portrait
        ? Math.min(avail, Math.floor(viewW * 0.70))
        : Math.min(avail, Math.floor(viewW * (ultraWide ? 0.68 : 0.72)));
      maxH = portrait
        ? Math.min(Math.round(vh * 0.60), 476)
        : Math.min(Math.round(vh * (ultraWide ? 0.28 : 0.34)), ultraWide ? 180 : 220);
    } else {
      maxW = portrait ? Math.min(300, avail) : Math.min(360, avail);
      maxH = portrait ? Math.min(Math.round(vh * 0.7), 520) : (ultraWide ? 220 : 280);
    }

    const hardMaxW = Math.max(160, viewW - (narrow ? 40 : 48));
    maxW = Math.min(maxW, avail, hardMaxW);

    // גובה המסגרת לפי יחס המדיה, אבל לא פחות ממינימום שממלא את הבועה יפה | HYPER CORE TECH
    let dispW = maxW;
    let dispH = Math.round(dispW * (h / w));
    if (dispH > maxH) {
      dispH = maxH;
      // שומרים רוחב מלא של הבועה — cover יחתוך קלות; אין פסי שוליים | HYPER CORE TECH
      dispW = maxW;
    }
    // אנכי: אם יצא נמוך מדי — ממלאים לגובה יעד הבועה | HYPER CORE TECH
    if (portrait) {
      const minPortraitH = Math.min(maxH, Math.round(dispW * 1.45));
      if (dispH < minPortraitH) dispH = minPortraitH;
    } else {
      const minLandH = Math.min(maxH, Math.round(dispW * 0.52));
      if (dispH < minLandH) dispH = minLandH;
      if (dispH > maxH) dispH = maxH;
    }

    return {
      portrait,
      ultraWide,
      dispW: Math.max(140, Math.round(dispW)),
      dispH: Math.max(120, Math.round(dispH)),
    };
  }

  function applyChatMediaBoxSize(el, w, h, { force = false } = {}) {
    if (!el || !w || !h) return false;
    if (
      !force &&
      el.dataset.aspectLocked === '1' &&
      el.dataset.mediaNw === String(w) &&
      el.dataset.mediaNh === String(h)
    ) {
      const probe = computeChatMediaBox(w, h, el);
      if (el.dataset.sizedW === String(probe.dispW) && el.dataset.sizedH === String(probe.dispH)) {
        return probe;
      }
    }
    const box = computeChatMediaBox(w, h, el);
    // מסגרת קבועה + cover על המדיה — בלי aspect-ratio טבעי שיוצר פסים | HYPER CORE TECH
    el.style.width = `${box.dispW}px`;
    el.style.height = `${box.dispH}px`;
    el.style.maxWidth = `${box.dispW}px`;
    el.style.maxHeight = `${box.dispH}px`;
    // לא מאפסים min-width — במובייל תמונה/וידאו לרוחב צריכים רצפת 220px כמו CSS | HYPER CORE TECH
    el.style.removeProperty('min-width');
    el.style.removeProperty('min-height');
    el.style.aspectRatio = `${box.dispW} / ${box.dispH}`;
    el.dataset.mediaNw = String(w);
    el.dataset.mediaNh = String(h);
    el.dataset.sizedW = String(box.dispW);
    el.dataset.sizedH = String(box.dispH);
    el.dataset.aspectLocked = '1';
    return box;
  }

  function lockChatVideoAspect(container, videoEl, { force = false } = {}) {
    if (!container || !videoEl) return false;
    const w = videoEl.videoWidth;
    const h = videoEl.videoHeight;
    if (!w || !h) return false;
    if (!force && container.dataset.ready === '1' && container.dataset.aspectLocked === '1') {
      const probe = computeChatMediaBox(w, h, container);
      if (container.dataset.sizedW === String(probe.dispW) && container.dataset.sizedH === String(probe.dispH)) {
        return true;
      }
    }
    const box = applyChatMediaBoxSize(container, w, h, { force: true });
    if (!box) return false;
    container.classList.toggle('chat-message__video-container--portrait', box.portrait);
    container.classList.toggle('chat-message__video-container--landscape', !box.portrait);
    return true;
  }

  function reflowLockedChatMedia() {
    try {
      document.querySelectorAll(
        '.chat-message__video-container[data-aspect-locked="1"], .chat-message__image-container[data-aspect-locked="1"], .chat-media-upload[data-aspect-locked="1"], .chat-media-upload[data-media-ready="1"]'
      ).forEach((el) => {
        const nw = Number(el.dataset.mediaNw || 0);
        const nh = Number(el.dataset.mediaNh || 0);
        if (nw && nh) {
          const box = applyChatMediaBoxSize(el, nw, nh, { force: true });
          if (box) {
            el.classList.toggle('chat-message__video-container--portrait', !!box.portrait);
            el.classList.toggle('chat-message__video-container--landscape', !box.portrait);
            el.classList.toggle('chat-message__image-container--portrait', !!box.portrait);
            el.classList.toggle('chat-message__image-container--landscape', !box.portrait);
            el.classList.toggle('chat-media-upload--portrait', !!box.portrait);
            el.classList.toggle('chat-media-upload--landscape', !box.portrait);
          }
          return;
        }
        const video = el.querySelector('video');
        if (video?.videoWidth && video?.videoHeight) {
          lockChatVideoAspect(el, video, { force: true });
          return;
        }
        const img = el.querySelector('img.chat-media-upload__media, img.chat-message__image');
        if (img?.naturalWidth && img?.naturalHeight) {
          const box = applyChatMediaBoxSize(el, img.naturalWidth, img.naturalHeight, { force: true });
          if (box) {
            el.classList.toggle('chat-media-upload--portrait', !!box.portrait);
            el.classList.toggle('chat-media-upload--landscape', !box.portrait);
            el.classList.toggle('chat-message__image-container--portrait', !!box.portrait);
            el.classList.toggle('chat-message__image-container--landscape', !box.portrait);
          }
        }
      });
    } catch (_) {}
  }

  let _mediaReflowTimer = null;
  function scheduleChatMediaReflow() {
    if (_mediaReflowTimer) clearTimeout(_mediaReflowTimer);
    _mediaReflowTimer = setTimeout(() => {
      _mediaReflowTimer = null;
      reflowLockedChatMedia();
    }, 120);
  }

  if (typeof window !== 'undefined' && !window.__sosChatMediaReflowBound) {
    window.__sosChatMediaReflowBound = true;
    window.addEventListener('resize', scheduleChatMediaReflow, { passive: true });
    window.addEventListener('orientationchange', scheduleChatMediaReflow, { passive: true });
  }

  function revealChatVideoPreview(container, videoEl, { allowWithoutPoster = false } = {}) {
    if (!container || !videoEl) return false;
    if (container.dataset.ready === '1') {
      revealChatMessageBubble(container);
      return true;
    }
    if (!lockChatVideoAspect(container, videoEl)) return false;
    const hasRealPoster = videoEl.dataset.posterCaptured === '1';
    const thumb = container.querySelector('.chat-message__video-thumb');
    const thumbVisible = !!(thumb && !thumb.hidden && thumb.getAttribute('src'));
    if (!hasRealPoster && !allowWithoutPoster && videoEl.dataset.previewFrame !== '1') return false;

    // קריטי: poster שחור 1×1 מסתיר את הפריים כשהווידאו ב־pause — מסירים אותו | HYPER CORE TECH
    if (!hasRealPoster) {
      try { videoEl.removeAttribute('poster'); } catch (_) {}
    }

    // נועלים יחס לפני חשיפה | HYPER CORE TECH
    if (videoEl.videoWidth && videoEl.videoHeight) {
      lockChatVideoAspect(container, videoEl);
    }

    container.dataset.ready = '1';
    container.removeAttribute('data-chat-video-pending');
    container.classList.remove('is-media-pending', 'is-media-failed');
    container.classList.add('is-media-ready');
    container.hidden = false;
    videoEl.classList.add('is-ready');

    if (hasRealPoster || thumbVisible) {
      container.classList.add('has-video-thumb');
      if (thumb && hasRealPoster && isUsablePosterDataUrl(videoEl.poster)) {
        thumb.src = videoEl.poster;
        thumb.hidden = false;
      }
      // נשארים על תקציר יציב — לא מציגים את משטח הווידאו (מונע ריצוד שחור) | HYPER CORE TECH
      videoEl.style.opacity = '0';
      videoEl.style.visibility = 'hidden';
    } else {
      container.classList.remove('has-video-thumb');
      videoEl.style.opacity = '1';
      videoEl.style.visibility = 'visible';
    }

    const playBtn = container.querySelector('.chat-message__video-play');
    const durationEl = container.querySelector('.chat-message__video-duration');
    if (playBtn) playBtn.hidden = false;
    if (durationEl) durationEl.hidden = false;
    revealChatMessageBubble(container);
    return true;
  }

  function failChatVideoPreview(container) {
    if (!container) return;
    container.classList.remove('is-media-pending', 'is-media-ready');
    container.classList.add('is-media-failed');
    container.hidden = true;
    failChatMessageBubble(container);
  }

  function renderVideoAttachment(attachment) {
    const src = attachment.url || attachment.dataUrl || '';
    const type = attachment.type || 'video/mp4';
    const name = attachment.name || 'וידאו';
    const safeName = App.escapeHtml ? App.escapeHtml(name) : name;
    const uid = 'vid-' + Math.random().toString(36).substr(2, 9);
    const containerId = 'vc-' + Math.random().toString(36).substr(2, 9);
    // blob מותר ב־HTML בהתחלה — זה ה־session URL של השולח/מקבל | HYPER CORE TECH
    const initialSrc = src || '';
    const knownPoster = (() => {
      if (isUsablePosterDataUrl(attachment.posterDataUrl)) return attachment.posterDataUrl;
      if (isUsablePosterDataUrl(attachment.poster)) return attachment.poster;
      if (attachment.fileId && typeof App.getChatTransferPreviewPoster === 'function') {
        const fromTransfer = App.getChatTransferPreviewPoster(attachment.fileId);
        if (isUsablePosterDataUrl(fromTransfer)) return fromTransfer;
      }
      return '';
    })();
    const androidPlaceholder = needsAndroidVideoPlaceholder();
    const usePendingBlack = androidPlaceholder && !knownPoster;
    // תמיד מוסתר עד ready+aspect — בלי פסים/קפיצות לעין | HYPER CORE TECH
    const pendingAttr = knownPoster ? '' : ' data-chat-video-pending="1"';
    const readyAttr = '';
    const mediaStateClass = knownPoster ? ' has-video-thumb is-media-pending' : ' is-media-pending';
    mediaDebugLog('render-video', {
      name,
      mime: type,
      hasSrc: !!src,
      isDataUrl: src.startsWith('data:'),
      isBlob: src.startsWith('blob:'),
      hasPoster: !!knownPoster,
      fileId: attachment.fileId || null,
      cacheKey: chatP2PCacheKey(attachment) || null,
    });

    setTimeout(async () => {
      const container = document.getElementById(containerId);
      const el = document.getElementById(uid);
      const playBtn = container?.querySelector('.chat-message__video-play');
      if (!el || !container) return;

      // תקציר מוכן — עדיין מחכים ל־metadata לנעילת יחס לפני חשיפה | HYPER CORE TECH
      if (knownPoster) {
        applyChatVideoPoster(container, el, knownPoster);
      }
      el.style.background = '#000';
      el.style.opacity = '0';
      el.style.visibility = 'hidden';

      // ניסיון טעינת תקציר שמור לפי fileId (אחרי restart) | HYPER CORE TECH
      if (!knownPoster && attachment.fileId) {
        loadChatP2PPosterDataUrl(attachment).then((cachedPoster) => {
          if (!cachedPoster || el.dataset.posterCaptured === '1') return;
          applyChatVideoPoster(container, el, cachedPoster);
          if (el.videoWidth) revealChatVideoPreview(container, el, { allowWithoutPoster: true });
        }).catch(() => {});
      }

      let playable = initialSrc;
      try {
        const resolved = await resolveChatMediaSrc(attachment);
        if (resolved) playable = resolved;
      } catch (_) {}

      if (!playable) {
        failChatVideoPreview(container);
        return;
      }

      const source = el.querySelector('source');
      if (source) {
        if (source.getAttribute('src') !== playable) {
          source.src = playable;
          el.load();
        }
      } else if (el.src !== playable) {
        el.src = playable;
        try { el.load(); } catch (_) {}
      }

      el.addEventListener('error', () => failChatVideoPreview(container), { once: true });

      // אם אין תקציר — לכידה off-screen (המשתמש לא רואה) | HYPER CORE TECH
      if (el.dataset.posterCaptured !== '1' && playable) {
        try {
          const blobResp = await fetch(playable);
          if (blobResp.ok) {
            const mediaBlob = await blobResp.blob();
            const offDomPoster = await capturePosterFromBlob(mediaBlob, type);
            if (offDomPoster) {
              applyChatVideoPoster(container, el, offDomPoster);
              if (attachment.fileId) {
                persistChatP2PPoster(attachment.fileId, offDomPoster).catch(() => {});
              }
              if (el.videoWidth) revealChatVideoPreview(container, el, { allowWithoutPoster: true });
            }
          }
        } catch (_) {}
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

      let warming = false;
      const tryReady = async ({ force = false } = {}) => {
        if (warming) return;
        if (el.dataset.posterCaptured === '1') {
          updateDuration();
          revealChatVideoPreview(container, el, { allowWithoutPoster: true });
          return;
        }
        warming = true;
        try {
          updateDuration();
          if (el.dataset.posterCaptured !== '1') {
            captureChatVideoPoster(el);
            if (el.dataset.posterCaptured !== '1') {
              await ensureChatVideoPosterFrame(el);
            }
            if (el.dataset.posterCaptured === '1') {
              applyChatVideoPoster(container, el, el.poster);
            }
          }
          const ok = revealChatVideoPreview(container, el, {
            allowWithoutPoster: force || el.dataset.previewFrame === '1' || el.dataset.posterCaptured === '1',
          });
          if (force && !ok && container.dataset.ready !== '1') {
            failChatVideoPreview(container);
          }
        } finally {
          warming = false;
        }
      };

      el.addEventListener('loadedmetadata', () => { tryReady(); });
      el.addEventListener('loadeddata', () => { tryReady(); });
      el.addEventListener('canplay', () => { tryReady(); });
      el.addEventListener('seeked', () => {
        captureChatVideoPoster(el);
        tryReady();
      });

      setTimeout(() => { tryReady({ force: true }); }, 2500);
      setTimeout(() => {
        if (container.dataset.ready !== '1') tryReady({ force: true });
      }, 6000);
      setTimeout(() => {
        if (container.dataset.ready !== '1') failChatVideoPreview(container);
      }, 12000);
      if (el.readyState >= 1 || knownPoster) tryReady({ force: !!knownPoster });

      const openFullscreen = (event) => {
        if (event) {
          event.preventDefault();
          event.stopPropagation();
        }
        if (container.dataset.ready !== '1' && el.dataset.posterCaptured !== '1') return;
        const sourceEl = el.querySelector('source');
        const playSrc = (sourceEl && sourceEl.src) || el.currentSrc || playable || src;
        if (typeof openVideoLightbox === 'function') {
          openVideoLightbox(playSrc, name, type, container);
        }
      };

      if (playBtn) {
        playBtn.addEventListener('click', openFullscreen);
      }
      el.addEventListener('click', openFullscreen);
      container.addEventListener('click', (event) => {
        if (event.target.closest('.chat-message__media-download')) return;
        openFullscreen(event);
      });
    }, 0);

    const posterAttr = knownPoster
      ? knownPoster
      : (usePendingBlack ? CHAT_VIDEO_BLACK_POSTER : '');
    const thumbHtml = knownPoster
      ? `<img class="chat-message__video-thumb" alt="" src="${knownPoster}" decoding="async">`
      : `<img class="chat-message__video-thumb" alt="" hidden decoding="async">`;

    return `
      <div id="${containerId}" class="chat-message__video-container${mediaStateClass}" data-chat-video-preview="1"${pendingAttr}${readyAttr} hidden>
        ${thumbHtml}
        <button type="button" class="chat-message__video-play" aria-label="נגן וידאו במסך מלא" hidden>
          <span class="chat-message__video-play-icon" aria-hidden="true"></span>
        </button>
        <span class="chat-message__video-duration" hidden>0:00</span>
        <span class="chat-message__video-msg-time" data-video-time-slot></span>
        <video
          id="${uid}"
          class="chat-message__video${knownPoster ? ' has-poster' : ''}"
          preload="auto"
          playsinline
          webkit-playsinline
          muted
          ${posterAttr ? `poster="${posterAttr}"` : ''}
          style="opacity:0;visibility:hidden;background:#000"
          aria-label="${safeName}"
        >
          <source src="${initialSrc}" type="${type}">
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
  
  // חלק lightbox (chat-media-renderer.js) – מטא שולח/זמן להדר תחתון | HYPER CORE TECH
  function formatLightboxTimeLabel(tsSec) {
    const ts = Number(tsSec);
    if (!ts) return '';
    const date = new Date(ts * 1000);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    const timePart = date.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return timePart;
    const datePart = date.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
    return `${datePart} · ${timePart}`;
  }

  function resolveLightboxSenderMeta(metaOrEl) {
    const esc = (s) => (App.escapeHtml ? App.escapeHtml(String(s || '')) : String(s || ''));
    let isOutgoing = false;
    let fromKey = '';
    let createdAt = 0;
    let override = null;
    let timeFromDom = '';

    if (metaOrEl && typeof metaOrEl === 'object' && metaOrEl.nodeType === 1) {
      const msg = metaOrEl.closest?.('.chat-message') || null;
      isOutgoing = !!msg?.classList?.contains('chat-message--outgoing');
      fromKey = (msg?.getAttribute('data-chat-from') || '').toLowerCase();
      createdAt = Number(msg?.getAttribute('data-chat-created') || 0) || 0;
      timeFromDom = (
        msg?.querySelector?.('.chat-message__image-msg-time-text, .chat-message__video-msg-time-text, .chat-message__meta')
          ?.textContent || ''
      ).trim();
    } else if (metaOrEl && typeof metaOrEl === 'object') {
      override = metaOrEl;
      isOutgoing = !!metaOrEl.isOutgoing;
      fromKey = String(metaOrEl.from || metaOrEl.fromKey || '').toLowerCase();
      createdAt = Number(metaOrEl.createdAt || 0) || 0;
      timeFromDom = String(metaOrEl.timeLabel || '').trim();
    }

    let senderName = override?.senderName || '';
    let senderPicture = override?.senderPicture || '';
    let senderInitials = override?.senderInitials || '';

    if (isOutgoing || (!fromKey && App.publicKey)) {
      const myPubkey = App.publicKey?.toLowerCase?.() || '';
      const myContact = myPubkey && App.chatState?.contacts?.get?.(myPubkey);
      senderName =
        senderName ||
        App.userName ||
        App.userDisplayName ||
        App.profile?.name ||
        myContact?.name ||
        'אני';
      senderPicture =
        senderPicture ||
        App.userPicture ||
        App.userAvatar ||
        App.profile?.picture ||
        App.profile?.image ||
        myContact?.picture ||
        '';
    } else if (fromKey) {
      const contact = App.chatState?.contacts?.get?.(fromKey);
      senderName = senderName || contact?.name || `משתמש ${fromKey.slice(0, 8)}`;
      senderPicture = senderPicture || contact?.picture || '';
      senderInitials =
        senderInitials ||
        contact?.initials ||
        (typeof App.getInitials === 'function' ? App.getInitials(senderName) : String(senderName).slice(0, 2));
    }

    if (!senderName) senderName = isOutgoing ? 'אני' : 'משתמש';
    if (!senderInitials) {
      senderInitials =
        typeof App.getInitials === 'function' ? App.getInitials(senderName) : String(senderName).slice(0, 2);
    }

    const timeLabel = timeFromDom || formatLightboxTimeLabel(createdAt) || '';

    return {
      isOutgoing,
      senderName: esc(senderName),
      senderPicture: esc(senderPicture),
      senderInitials: esc(senderInitials),
      timeLabel: esc(timeLabel),
    };
  }

  function buildLightboxShellHtml({ kind, mediaHtml, meta }) {
    const resolved = resolveLightboxSenderMeta(meta);
    const initials = resolved.senderInitials || 'מ';
    // רק עיגול אחד: תמונה אם קיימת, אחרת ראשי תיבות (לא שניהם יחד)
    const avatarHtml = resolved.senderPicture
      ? `<img class="chat-lightbox__avatar" src="${resolved.senderPicture}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;chat-lightbox__avatar chat-lightbox__avatar--initials&quot;>${initials}</span>';">`
      : `<span class="chat-lightbox__avatar chat-lightbox__avatar--initials">${initials}</span>`;
    const title = kind === 'video' ? 'וידאו' : 'תמונה';
    return `
      <div class="chat-lightbox__backdrop"></div>
      <div class="chat-lightbox__frame">
        <header class="chat-lightbox__header">
          <button type="button" class="chat-lightbox__close" aria-label="סגור" title="סגור">
            <i class="fa-solid fa-times"></i>
          </button>
          <span class="chat-lightbox__header-title">${title}</span>
          <button type="button" class="chat-lightbox__download" aria-label="הורד" title="הורד">
            <i class="fa-solid fa-download"></i>
          </button>
        </header>
        <div class="chat-lightbox__stage">
          ${mediaHtml}
        </div>
        <footer class="chat-lightbox__footer">
          <div class="chat-lightbox__sender">
            ${avatarHtml}
            <span class="chat-lightbox__sender-name">${resolved.senderName || ''}</span>
          </div>
          <span class="chat-lightbox__time">${resolved.timeLabel || ''}</span>
        </footer>
      </div>
    `;
  }

  // חלק lightbox (chat-media-renderer.js) – פתיחת תמונה במסך מלא עם הדר עליון/תחתון | HYPER CORE TECH
  function openImageLightbox(src, name, meta) {
    const existing = document.getElementById('chatImageLightbox');
    if (existing) existing.remove();
    if (!src) return;

    const lightbox = document.createElement('div');
    lightbox.id = 'chatImageLightbox';
    lightbox.className = 'chat-lightbox';
    const safeName = App.escapeHtml ? App.escapeHtml(name || 'תמונה') : String(name || 'תמונה');
    const mediaHtml = `<img src="${String(src).replace(/"/g, '&quot;')}" alt="${safeName}" class="chat-lightbox__image">`;
    lightbox.innerHTML = buildLightboxShellHtml({ kind: 'image', mediaHtml, meta: meta || null });

    document.body.appendChild(lightbox);
    document.body.classList.add('chat-lightbox-open');

    const close = (event) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      lightbox.classList.add('chat-lightbox--closing');
      document.body.classList.remove('chat-lightbox-open');
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
    lightbox.querySelector('.chat-lightbox__frame')?.addEventListener('click', (event) => event.stopPropagation());

    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') {
        close(e);
        document.removeEventListener('keydown', onEsc);
      }
    });

    requestAnimationFrame(() => lightbox.classList.add('chat-lightbox--visible'));
  }

  // חלק lightbox וידאו (chat-media-renderer.js) – מסך מלא עם הדר עליון/תחתון | HYPER CORE TECH
  function openVideoLightbox(src, name, type, meta) {
    const existing = document.getElementById('chatVideoLightbox');
    if (existing) existing.remove();
    const playSrc = String(src || '').trim();
    if (!playSrc) return;

    const lightbox = document.createElement('div');
    lightbox.id = 'chatVideoLightbox';
    lightbox.className = 'chat-lightbox chat-lightbox--video';
    const safeName = App.escapeHtml ? App.escapeHtml(name || 'וידאו') : String(name || 'וידאו');
    const mime = type || 'video/mp4';
    const mediaHtml = `
      <video class="chat-lightbox__video" controls playsinline webkit-playsinline autoplay>
        <source src="${playSrc.replace(/"/g, '&quot;')}" type="${String(mime).replace(/"/g, '&quot;')}">
      </video>
    `;
    lightbox.innerHTML = buildLightboxShellHtml({ kind: 'video', mediaHtml, meta: meta || null });

    document.body.appendChild(lightbox);
    document.body.classList.add('chat-lightbox-open');
    App.__sosSuppressChatOutsideClose = true;

    const videoEl = lightbox.querySelector('.chat-lightbox__video');
    const close = (event) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      try {
        if (videoEl) {
          videoEl.pause();
          videoEl.removeAttribute('src');
          videoEl.load();
        }
      } catch (_) {}
      lightbox.classList.add('chat-lightbox--closing');
      document.body.classList.remove('chat-lightbox-open');
      setTimeout(() => {
        lightbox.remove();
        setTimeout(() => { App.__sosSuppressChatOutsideClose = false; }, 100);
      }, 200);
    };

    lightbox.querySelector('.chat-lightbox__close').addEventListener('click', close);
    lightbox.querySelector('.chat-lightbox__backdrop').addEventListener('click', close);
    lightbox.querySelector('.chat-lightbox__download')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      App.__sosSuppressChatOutsideClose = true;
      Promise.resolve(downloadChatMedia(playSrc, name || 'video.mp4')).finally(() => {
        setTimeout(() => { App.__sosSuppressChatOutsideClose = true; }, 50);
      });
    });
    lightbox.querySelector('.chat-lightbox__frame')?.addEventListener('click', (event) => event.stopPropagation());

    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') {
        close(e);
        document.removeEventListener('keydown', onEsc);
      }
    });

    requestAnimationFrame(() => {
      lightbox.classList.add('chat-lightbox--visible');
      try {
        const p = videoEl?.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {}
    });
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
    openVideoLightbox,
    applyChatMediaBoxSize,
    computeChatMediaBox,
    reflowLockedChatMedia,
    downloadChatMedia,
    getFileIcon,
    buildAttachmentDownloadHtml,
    buildMediaDownloadButton,
    // מטמון מדיה צ'אט | HYPER CORE TECH
    fetchAndCacheChatMedia: fetchAndCacheMedia,
    getChatMediaFromCache,
    persistChatP2PMedia,
    persistChatP2PPoster,
    capturePosterFromBlob,
    loadChatP2PPosterDataUrl,
    resolveChatMediaSrc,
    chatP2PCacheKey,
  });
  
  // אתחול מטמון צ'אט | HYPER CORE TECH
  openChatMediaDB().then(() => console.log('[CHAT-MEDIA] Cache initialized'));
})(window);
