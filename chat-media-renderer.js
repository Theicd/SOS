// חלק מדיה (chat-media-renderer.js) – תצוגת תמונות/וידאו/YouTube inline בצ'אט כמו וואטסאפ | HYPER CORE TECH
(function initChatMediaRenderer(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  
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
        return URL.createObjectURL(cached);
      }
      // הורד מהרשת
      const response = await fetch(url, { credentials: 'omit' });
      if (!response.ok) return url;
      const blob = await response.blob();
      // שמור למטמון
      await cacheChatMedia(url, blob);
      return URL.createObjectURL(blob);
    } catch (e) {
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
  
  // חלק רינדור תמונה (chat-media-renderer.js) – הצגת תמונה עם מטמון מקומי | HYPER CORE TECH
  function renderImageAttachment(attachment) {
    const src = attachment.url || attachment.dataUrl || '';
    const name = attachment.name || 'תמונה';
    const safeName = App.escapeHtml ? App.escapeHtml(name) : name;
    const uid = 'img-' + Math.random().toString(36).substr(2, 9);
    
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
      </div>
    `;
  }
  
  // חלק רינדור וידאו (chat-media-renderer.js) – נגן וידאו בסגנון ואטסאפ עם כפתור play | HYPER CORE TECH
  function renderVideoAttachment(attachment) {
    const src = attachment.url || attachment.dataUrl || '';
    const type = attachment.type || 'video/mp4';
    const name = attachment.name || 'וידאו';
    const safeName = App.escapeHtml ? App.escapeHtml(name) : name;
    const uid = 'vid-' + Math.random().toString(36).substr(2, 9);
    const containerId = 'vc-' + Math.random().toString(36).substr(2, 9);
    
    // טעינה אסינכרונית מהמטמון + הוספת event listeners
    setTimeout(async () => {
      const container = document.getElementById(containerId);
      const el = document.getElementById(uid);
      if (!el || !container) return;
      
      // טעינה מהמטמון
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
      
      // הצגת אורך סרטון
      el.addEventListener('loadedmetadata', () => {
        const duration = el.duration;
        if (duration && isFinite(duration)) {
          const mins = Math.floor(duration / 60);
          const secs = Math.floor(duration % 60).toString().padStart(2, '0');
          const durationEl = container.querySelector('.chat-message__video-duration');
          if (durationEl) durationEl.textContent = `${mins}:${secs}`;
        }
      });
      
      // הסתרת כפתור play כשמתנגן
      el.addEventListener('play', () => container.classList.add('playing'));
      el.addEventListener('pause', () => container.classList.remove('playing'));
      el.addEventListener('ended', () => container.classList.remove('playing'));
    }, 0);
    
    return `
      <div id="${containerId}" class="chat-message__video-container">
        <span class="chat-message__video-duration">0:00</span>
        <video 
          id="${uid}"
          class="chat-message__video"
          controls
          preload="metadata"
          playsinline
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
    lightbox.innerHTML = `
      <div class="chat-lightbox__backdrop"></div>
      <div class="chat-lightbox__content">
        <button type="button" class="chat-lightbox__close" aria-label="סגור">
          <i class="fa-solid fa-times"></i>
        </button>
        <img src="${src}" alt="${name}" class="chat-lightbox__image">
        <div class="chat-lightbox__name">${name}</div>
      </div>
    `;
    
    document.body.appendChild(lightbox);
    
    const close = () => {
      lightbox.classList.add('chat-lightbox--closing');
      setTimeout(() => lightbox.remove(), 200);
    };
    
    lightbox.querySelector('.chat-lightbox__close').addEventListener('click', close);
    lightbox.querySelector('.chat-lightbox__backdrop').addEventListener('click', close);
    
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', onEsc);
      }
    });
    
    requestAnimationFrame(() => lightbox.classList.add('chat-lightbox--visible'));
  }
  
  // חלק API ציבורי (chat-media-renderer.js) – חשיפת פונקציות לרינדור מדיה | HYPER CORE TECH
  Object.assign(App, {
    isImageAttachment,
    isVideoAttachment,
    renderImageAttachment,
    renderVideoAttachment,
    detectAndRenderYouTube,
    extractYouTubeId,
    openImageLightbox,
    // מטמון מדיה צ'אט | HYPER CORE TECH
    fetchAndCacheChatMedia: fetchAndCacheMedia,
    getChatMediaFromCache
  });
  
  // אתחול מטמון צ'אט | HYPER CORE TECH
  openChatMediaDB().then(() => console.log('[CHAT-MEDIA] Cache initialized'));
})(window);
