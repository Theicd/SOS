// חלק מדיה (chat-media-renderer.js) – תצוגת תמונות/וידאו/YouTube inline בצ'אט כמו וואטסאפ | HYPER CORE TECH
(function initChatMediaRenderer(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  
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
  
  function isVideoAttachment(attachment) {
    if (!attachment) return false;
    const mime = (attachment.type || '').toLowerCase();
    const name = attachment.name || '';
    const url = attachment.url || attachment.dataUrl || '';
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
  
  // חלק רינדור תמונה (chat-media-renderer.js) – הצגת תמונה inline עם lightbox | HYPER CORE TECH
  function renderImageAttachment(attachment) {
    const src = attachment.url || attachment.dataUrl || '';
    const name = attachment.name || 'תמונה';
    const safeName = App.escapeHtml ? App.escapeHtml(name) : name;
    
    return `
      <div class="chat-message__image-container">
        <img 
          src="${src}" 
          alt="${safeName}" 
          class="chat-message__image"
          loading="lazy"
          decoding="async"
          referrerpolicy="no-referrer"
          onclick="if(typeof App.openImageLightbox==='function')App.openImageLightbox('${src.replace(/'/g, "\\'")}','${safeName.replace(/'/g, "\\'")}')"
        />
      </div>
    `;
  }
  
  // חלק רינדור וידאו (chat-media-renderer.js) – נגן וידאו מוטמע עם controls | HYPER CORE TECH
  function renderVideoAttachment(attachment) {
    const src = attachment.url || attachment.dataUrl || '';
    const type = attachment.type || 'video/mp4';
    const name = attachment.name || 'וידאו';
    const safeName = App.escapeHtml ? App.escapeHtml(name) : name;
    
    return `
      <div class="chat-message__video-container">
        <video 
          class="chat-message__video"
          controls
          preload="metadata"
          playsinline
          poster=""
          aria-label="${safeName}"
        >
          <source src="${src}" type="${type}">
          הדפדפן שלך לא תומך בהצגת וידאו.
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
    openImageLightbox
  });
})(window);
