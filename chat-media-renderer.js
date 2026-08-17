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

  // מקור חי מהבועה — לא URL שננעל ב־HTML בזמן רינדור (blob מת אחרי resolve) | HYPER CORE TECH
  function resolveLiveChatDownloadSrc(fromEl) {
    const root = fromEl?.closest?.('.chat-message') || fromEl?.closest?.('[data-message-id]') || null;
    const scope = root || fromEl?.parentElement || null;
    if (!scope) return '';
    const video = scope.querySelector(
      'video.chat-message__video, video.chat-media-upload__media, .chat-message__video-container video'
    );
    if (video) {
      const source = video.querySelector('source');
      const live =
        String((source && (source.src || source.getAttribute('src'))) || video.currentSrc || video.src || '').trim();
      if (live && !live.startsWith('magnet:')) return live;
      const fromContainer = video.closest('[data-media-src]')?.getAttribute('data-media-src');
      if (fromContainer) return String(fromContainer).trim();
    }
    const img = scope.querySelector(
      'img.chat-message__image, img.chat-media-upload__media, .chat-message__image-container img'
    );
    if (img) {
      const live = String(img.currentSrc || img.src || '').trim();
      if (live) return live;
      const fromContainer = img.closest('[data-media-src]')?.getAttribute('data-media-src');
      if (fromContainer) return String(fromContainer).trim();
    }
    const tagged = scope.querySelector('[data-media-src]');
    if (tagged) {
      const v = String(tagged.getAttribute('data-media-src') || '').trim();
      if (v) return v;
    }
    return '';
  }

  async function downloadChatMediaFromButton(btn) {
    if (!btn || typeof btn.getAttribute !== 'function') return false;
    if (btn.dataset.dlBusy === '1' || btn.disabled) return false;
    const name =
      String(btn.getAttribute('data-filename') || btn.getAttribute('aria-label') || 'sos-file')
        .replace(/^הורד\s+/u, '')
        .trim() || 'sos-file';
    const fallback = String(btn.getAttribute('data-download-url') || '').trim();
    const fileId = String(btn.getAttribute('data-file-id') || '').trim();
    const cacheKey = String(btn.getAttribute('data-cache-key') || '').trim();

    if (!setDownloadButtonBusy(btn, true)) return false;
    try {
      let src = resolveLiveChatDownloadSrc(btn);
      if (!src) src = fallback;
      if ((!src || src.startsWith('blob:')) && (fileId || cacheKey)) {
        try {
          const restored = await resolveChatMediaSrc({
            url: src || '',
            fileId: fileId || undefined,
            cacheKey: cacheKey || undefined,
            name,
          });
          if (restored) src = restored;
        } catch (_) {}
      }
      if (!src) {
        console.warn('[CHAT-MEDIA] download: no live src');
        return false;
      }
      return await downloadChatMedia(src, name);
    } finally {
      setDownloadButtonBusy(btn, false);
    }
  }

  // משוב מיידי + חסימת לחיצות כפולות בזמן הורדה | HYPER CORE TECH
  function setDownloadButtonBusy(btn, busy) {
    if (!btn) return false;
    if (busy) {
      if (btn.dataset.dlBusy === '1') return false;
      btn.dataset.dlBusy = '1';
      btn.disabled = true;
      btn.classList.add('is-downloading');
      btn.setAttribute('aria-busy', 'true');
      if (!btn.dataset.dlDefaultHtml) btn.dataset.dlDefaultHtml = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
      return true;
    }
    btn.dataset.dlBusy = '0';
    btn.disabled = false;
    btn.classList.remove('is-downloading');
    btn.removeAttribute('aria-busy');
    if (btn.dataset.dlDefaultHtml) {
      btn.innerHTML = btn.dataset.dlDefaultHtml;
    }
    return true;
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

    const nativeShell = window.SosNativeShell;
    const canNativeSave =
      !!(nativeShell && typeof nativeShell.saveToDownloads === 'function');
    const canNativeUrl =
      !!(nativeShell && typeof nativeShell.downloadUrlToDownloads === 'function');

    const blobToBase64 = (blob) =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('read-failed'));
        reader.readAsDataURL(blob);
      });

    const saveBlobViaNative = async (blob) => {
      const dataUrl = await blobToBase64(blob);
      const mime = blob.type || undefined;
      const result = nativeShell.saveToDownloads(dataUrl, name, mime || '');
      const ok = typeof result === 'string' && result.indexOf('ok:') === 0;
      if (!ok) throw new Error(String(result || 'native-save-failed'));
      return true;
    };

    try {
      // מעטפת APK: שמירה נייטיבית (a[download] לא עובד ב־WebView) | HYPER CORE TECH
      if (canNativeSave || canNativeUrl) {
        const release = suppressOutsideClose();
        try {
          if (
            canNativeUrl &&
            (src.startsWith('http://') || src.startsWith('https://'))
          ) {
            const result = nativeShell.downloadUrlToDownloads(src, name, '');
            if (typeof result === 'string' && result.indexOf('ok:') === 0) {
              return true;
            }
            // נפילה ל־fetch+base64 אם הורדת URL נכשלה | HYPER CORE TECH
          }
          if (src.startsWith('blob:') || src.startsWith('data:')) {
            const resp = await fetch(src);
            const blob = await resp.blob();
            await saveBlobViaNative(blob);
            return true;
          }
          if (canNativeSave) {
            try {
              const cached = await fetchAndCacheMedia(src);
              const fetchUrl = cached || src;
              const resp = await fetch(fetchUrl, { mode: 'cors', credentials: 'omit' });
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const blob = await resp.blob();
              await saveBlobViaNative(blob);
              return true;
            } catch (fetchErr) {
              if (canNativeUrl && (src.startsWith('http://') || src.startsWith('https://'))) {
                const result = nativeShell.downloadUrlToDownloads(src, name, '');
                if (typeof result === 'string' && result.indexOf('ok:') === 0) return true;
              }
              throw fetchErr;
            }
          }
        } finally {
          release();
        }
      }

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

  function buildMediaDownloadButton(src, name, className, meta = {}) {
    const fileId = meta.fileId || '';
    const cacheKey = meta.cacheKey || (fileId ? chatP2PCacheKey(fileId) : '') || '';
    if (!src && !fileId && !cacheKey) return '';
    const cls = className || 'chat-message__media-download';
    const safeName = escapeAttr(name || 'sos-file');
    const safeSrc = escapeAttr(src || '');
    const safeFileId = escapeAttr(fileId);
    const safeCacheKey = escapeAttr(cacheKey);
    // לחיצה פותרת מקור חי מהבועה — לא סומכת על blob ישן ב־onclick | HYPER CORE TECH
    return `<button type="button" class="${cls}" title="הורד" aria-label="הורד ${safeName}" data-filename="${safeName}" data-download-url="${safeSrc}" data-file-id="${safeFileId}" data-cache-key="${safeCacheKey}" onclick="event.preventDefault();event.stopPropagation();if(window.NostrApp&&typeof NostrApp.downloadChatMediaFromButton==='function')NostrApp.downloadChatMediaFromButton(this);"><i class="fa-solid fa-download" aria-hidden="true"></i></button>`;
  }

  function buildAttachmentDownloadHtml(attachment, className) {
    if (!attachment) return '';
    const name = attachment.name || 'קובץ';
    const magnetURI = attachment.magnetURI || '';
    const src = attachment.dataUrl || attachment.url || '';
    const cls = className || 'chat-file-bubble__download';
    const meta = {
      fileId: attachment.fileId || '',
      cacheKey: attachment.cacheKey || chatP2PCacheKey(attachment) || '',
    };
    // עדיפות לקובץ מקומי — כפתור כמו מדיה; magnet רק כשאין src | HYPER CORE TECH
    if (src && !src.startsWith('magnet:')) {
      return buildMediaDownloadButton(src, name, cls, meta);
    }
    if (magnetURI) {
      const blob = typeof App.getTorrentBlob === 'function' ? App.getTorrentBlob(magnetURI) : null;
      if (blob?.url) {
        return buildMediaDownloadButton(blob.url, blob.name || name, cls, meta);
      }
      const escapedMagnet = magnetURI.replace(/"/g, '&quot;');
      const escapedName = escapeAttr(name).replace(/'/g, "\\'");
      return `<button type="button" class="${cls} torrent-bubble__download-btn" data-magnet="${escapedMagnet}" data-filename="${escapedName}" title="הורד"><i class="fa-solid fa-download"></i></button>`;
    }
    return '';
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
      try {
        wrap.setAttribute('data-media-src', playable);
        wrap.dataset.mediaSrc = playable;
      } catch (_) {}
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
    if (typeof App.stickChatToBottomIfPinned === 'function') {
      App.stickChatToBottomIfPinned();
    }
    // אחרי חשיפת תמונה — מחזירים כרטיסי מסמך אם נעלמו במרוץ | HYPER CORE TECH
    try {
      const peer =
        (typeof App.getActiveChatPeer === 'function' && App.getActiveChatPeer()) || '';
      if (peer && typeof App.ensureUnifiedFileCardsVisible === 'function') {
        App.ensureUnifiedFileCardsVisible(peer);
        setTimeout(() => {
          try { App.ensureUnifiedFileCardsVisible(peer); } catch (_) {}
        }, 60);
      }
    } catch (_) {}
  }

  function failChatMessageBubble(mediaEl) {
    const msg = mediaEl?.closest?.('.chat-message');
    if (!msg) return;
    if (messageHasVisibleCaption(msg)) {
      // כשל מדיה עם כיתוב — לא חושפים בועה שבורה; משאירים מוסתר עד שיש מדיה מוכנה אחרת | HYPER CORE TECH
      const hasReady = msg.querySelector(
        '.chat-message__image-container.is-media-ready, .chat-message__video-container.is-media-ready, audio, .chat-audio, [data-audio]'
      );
      if (hasReady) {
        msg.classList.remove('chat-message--media-pending', 'chat-message--media-failed');
        msg.hidden = false;
        return;
      }
      msg.classList.add('chat-message--media-pending');
      msg.hidden = true;
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
  // עמודת ⋮ ליד המדיה (~32px + gap) — חייבים להחסיר כדי שלא ייחתך צד השולח ב-RTL | HYPER CORE TECH
  const CHAT_MEDIA_SIDE_ACTIONS_RESERVE = 44;

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
    const side = CHAT_MEDIA_SIDE_ACTIONS_RESERVE;
    // מובייל: כמו לפני תיקוני הדסקטופ — בלי ניכוי ⋮ שמצר/דוחף | HYPER CORE TECH
    if (narrow) {
      return Math.max(200, Math.min(Math.floor(viewW * 0.72), Math.floor(raw * 0.82) - 4));
    }
    // מחשב: מקום ל־⋮ + מרווח ממסגרת שמאל (RTL) | HYPER CORE TECH
    const desktopFrameGap = 20;
    return Math.max(200, Math.min(280, Math.floor(raw * 0.52) - 16 - side - desktopFrameGap));
  }

  function computeChatMediaBox(w, h, hostEl) {
    const portrait = h > w;
    const avail = getChatMediaAvailWidth(hostEl);
    const vh = window.innerHeight || document.documentElement?.clientHeight || 640;
    const viewW = window.innerWidth || 360;
    const narrow = viewW <= 768 || (window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
    const aspect = w / Math.max(1, h);
    const ultraWide = !portrait && aspect >= 1.9;

    // מסגרת קומפקטית (תמונה+וידאו זהים) — שומרים יחס מקורי בתוך תקרה | HYPER CORE TECH
    let maxW;
    let maxH;
    if (narrow) {
      maxW = portrait
        ? Math.min(avail, Math.floor(viewW * 0.68), 280)
        : Math.min(avail, Math.floor(viewW * (ultraWide ? 0.68 : 0.72)));
      maxH = portrait
        ? Math.min(Math.round(vh * 0.52), 420)
        : Math.min(Math.round(vh * (ultraWide ? 0.28 : 0.34)), ultraWide ? 180 : 220);
    } else {
      // מחשב בלבד: אופקי צר יותר כדי שלא ייחתך עם ⋮ בדפנות | HYPER CORE TECH
      maxW = portrait ? Math.min(290, avail) : Math.min(280, avail);
      maxH = portrait ? Math.min(Math.round(vh * 0.58), 500) : (ultraWide ? 220 : 280);
    }

    const hardMaxW = Math.max(
      160,
      viewW - (narrow ? 40 : 48) - (narrow ? 0 : CHAT_MEDIA_SIDE_ACTIONS_RESERVE + 20)
    );
    maxW = Math.min(maxW, avail, hardMaxW);

    // גובה לפי יחס המדיה; באנכי שומרים רוחב בועה (cover חותך מעט) — לא מצמצמים לצר | HYPER CORE TECH
    let dispW = maxW;
    let dispH = Math.round(dispW * (h / w));
    if (dispH > maxH) {
      dispH = maxH;
      if (portrait) {
        // כמו וואטסאפ: רוחב מלא של הבועה, חיתוך אנכי קל | HYPER CORE TECH
        dispW = maxW;
      } else {
        dispW = Math.round(dispH * (w / h));
        if (dispW > maxW) {
          dispW = maxW;
          dispH = Math.min(maxH, Math.round(dispW * (h / w)));
        }
      }
    }
    // אנכי כמעט־ריבוע: תוספת גובה עדינה בלבד | HYPER CORE TECH
    if (portrait && h / w < 1.35) {
      const minPortraitH = Math.min(maxH, Math.round(dispW * 1.2));
      if (dispH < minPortraitH) dispH = minPortraitH;
    } else if (!portrait) {
      const minLandH = Math.min(maxH, Math.round(dispW * 0.52));
      if (dispH < minLandH) dispH = minLandH;
      if (dispH > maxH) dispH = maxH;
    }

    // רצפת רוחב לאנכי — מונע בועה צרה מדי (מובייל ללא שינוי) | HYPER CORE TECH
    if (portrait) {
      const minW = narrow ? 220 : Math.min(260, maxW);
      if (dispW < minW && maxW >= minW) dispW = Math.min(maxW, minW);
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

    // לעולם לא חושפים את משטח ה־video בבועה — ב־Android WebView זה מציג דף פליי לבן | HYPER CORE TECH
    videoEl.style.opacity = '0';
    videoEl.style.visibility = 'hidden';
    videoEl.style.background = '#000';

    if (hasRealPoster || thumbVisible) {
      container.classList.add('has-video-thumb');
      if (thumb && hasRealPoster && isUsablePosterDataUrl(videoEl.poster)) {
        thumb.src = videoEl.poster;
        thumb.hidden = false;
      }
    } else {
      // בלי תקציר: רקע שחור + כפתור Play שלנו (בלי נגן מערכת) | HYPER CORE TECH
      container.classList.remove('has-video-thumb');
      if (thumb) {
        try {
          thumb.removeAttribute('src');
          thumb.hidden = true;
        } catch (_) {}
      }
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

      try {
        container.setAttribute('data-media-src', playable);
        container.dataset.mediaSrc = playable;
      } catch (_) {}

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
          // חושפים רק עם תקציר אמיתי; ב־force בלי poster — שחור+Play בלי משטח video | HYPER CORE TECH
          const hasPoster = el.dataset.posterCaptured === '1';
          const ok = revealChatVideoPreview(container, el, {
            allowWithoutPoster: hasPoster || force,
          });
          if (force && !ok && container.dataset.ready !== '1') {
            // עדיין מחכים ל־aspect; אם יש מידות — נחשוף שחור+Play בלי video גלוי | HYPER CORE TECH
            if (el.videoWidth && el.videoHeight) {
              revealChatVideoPreview(container, el, { allowWithoutPoster: true });
            } else if (force) {
              failChatVideoPreview(container);
            }
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

      setTimeout(() => { tryReady({ force: true }); }, 3500);
      setTimeout(() => {
        if (container.dataset.ready !== '1') tryReady({ force: true });
      }, 8000);
      setTimeout(() => {
        if (container.dataset.ready !== '1') failChatVideoPreview(container);
      }, 15000);
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
  
  // חלק פתיחה חיצונית (chat-media-renderer.js) – כמו וואטסאפ: דפדפן / אפליקציית YouTube | HYPER CORE TECH
  function openYouTubeExternal(videoId) {
    const id = String(videoId || '').trim();
    if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return;
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    App.__sosSuppressChatOutsideClose = true;
    try {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (_) {
      try { window.open(url, '_blank', 'noopener,noreferrer'); }
      catch (__) { window.location.href = url; }
    }
    setTimeout(() => { App.__sosSuppressChatOutsideClose = false; }, 800);
  }

  // חלק כרטיס YouTube (chat-media-renderer.js) – תמונה+כותרת בבועה; לחיצה פותחת YouTube חיצונית | HYPER CORE TECH
  function renderYouTubeCard(videoId) {
    if (!videoId) return '';
    const safeId = escapeAttr(videoId);
    const jsId = escapeJsString(videoId);
    const thumbHq = `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
    const thumbMq = `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;
    return `
      <button
        type="button"
        class="chat-message__youtube-card"
        data-youtube-id="${safeId}"
        data-youtube-title="יוטיוב"
        aria-label="פתח סרטון YouTube"
        onclick="event.stopPropagation();if(typeof App.openYouTubeExternal==='function')App.openYouTubeExternal('${jsId}')"
      >
        <span class="chat-message__youtube-thumb-wrap">
          <img
            class="chat-message__youtube-thumb"
            src="${thumbHq}"
            alt=""
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
            onerror="this.onerror=null;this.src='${thumbMq}'"
          >
          <span class="chat-message__youtube-play" aria-hidden="true"><i class="fa-solid fa-play"></i></span>
        </span>
        <span class="chat-message__youtube-meta">
          <span class="chat-message__youtube-title">סרטון YouTube</span>
          <span class="chat-message__youtube-author">YouTube</span>
        </span>
      </button>
    `;
  }

  // חלק מטא YouTube (chat-media-renderer.js) – כותרת/ערוץ מ-noembed לכרטיס | HYPER CORE TECH
  async function hydrateYouTubeCards(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const cards = scope.querySelectorAll?.('.chat-message__youtube-card[data-youtube-id]:not([data-youtube-hydrated="1"])');
    if (!cards || !cards.length) return;
    await Promise.all(Array.from(cards).map(async (card) => {
      const videoId = card.getAttribute('data-youtube-id');
      if (!videoId) return;
      card.setAttribute('data-youtube-hydrated', '1');
      const meta = await getYouTubeVideoDuration(videoId);
      if (!meta) return;
      const title = String(meta.title || '').trim();
      const author = String(meta.author_name || meta.author || '').trim();
      const thumb = String(meta.thumbnail_url || '').trim();
      if (title) {
        card.setAttribute('data-youtube-title', title);
        const titleEl = card.querySelector('.chat-message__youtube-title');
        if (titleEl) titleEl.textContent = title;
        card.setAttribute('aria-label', `פתח: ${title}`);
      }
      if (author) {
        const authorEl = card.querySelector('.chat-message__youtube-author');
        if (authorEl) authorEl.textContent = author;
      }
      if (thumb) {
        const img = card.querySelector('.chat-message__youtube-thumb');
        if (img) img.src = thumb;
      }
    }));
  }

  // חלק תאימות (chat-media-renderer.js) – API ישן לכרטיס במקום iframe | HYPER CORE TECH
  async function renderYouTubeEmbed(videoId) {
    return renderYouTubeCard(videoId);
  }

  // חלק זיהוי אוטומטי (chat-media-renderer.js) – סריקת טקסט הודעה ללינקי YouTube | HYPER CORE TECH
  async function detectAndRenderYouTube(messageText) {
    const videoId = extractYouTubeId(messageText);
    if (!videoId) return null;
    return renderYouTubeCard(videoId);
  }

  // חלק לינק כללי (chat-media-renderer.js) – כרטיס כמו וואטסאפ: oEmbed + OG ציבורי + פרוקסי תמונה | HYPER CORE TECH
  // אותו סוג תשתית כמו news-wave (corsproxy) + noembed של YouTube – בלי שרת חדש | HYPER CORE TECH
  const LINK_PREVIEW_CORS_PROXY = 'https://corsproxy.io/?';

  function openExternalChatLink(url) {
    const href = String(url || '').trim();
    if (!/^https?:\/\//i.test(href)) return;
    App.__sosSuppressChatOutsideClose = true;
    try {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (_) {
      try { window.open(href, '_blank', 'noopener,noreferrer'); }
      catch (__) { window.location.href = href; }
    }
    setTimeout(() => { App.__sosSuppressChatOutsideClose = false; }, 800);
  }

  function isDirectMediaFileUrl(url) {
    return /\.(jpe?g|png|gif|webp|heic|heif|bmp|svg|mp3|m4a|aac|ogg|oga|opus|wav|wave|webm|flac|wma|aiff|aif|caf|amr|3gp|3gpp|mp4|ogv|mov|avi|mkv|m4v|wmv|flv)(\?|#|$)/i.test(
      String(url || '')
    );
  }

  function getLinkHostLabel(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch (_) {
      return 'קישור';
    }
  }

  function getLinkBrandMeta(url) {
    const host = getLinkHostLabel(url).toLowerCase();
    if (/facebook\.com$|fb\.watch$|fb\.com$/.test(host)) {
      return { icon: 'fa-brands fa-facebook-f', label: 'Facebook', tone: 'facebook' };
    }
    if (/tiktok\.com$|vm\.tiktok\.com$/.test(host)) {
      return { icon: 'fa-brands fa-tiktok', label: 'TikTok', tone: 'tiktok' };
    }
    if (/instagram\.com$/.test(host)) {
      return { icon: 'fa-brands fa-instagram', label: 'Instagram', tone: 'instagram' };
    }
    if (/aliexpress\./.test(host)) {
      return { icon: 'fa-solid fa-cart-shopping', label: 'AliExpress', tone: 'shop' };
    }
    if (/amazon\./.test(host)) {
      return { icon: 'fa-brands fa-amazon', label: 'Amazon', tone: 'shop' };
    }
    if (/vimeo\.com$/.test(host)) {
      return { icon: 'fa-brands fa-vimeo-v', label: 'Vimeo', tone: 'default' };
    }
    if (/soundcloud\.com$/.test(host)) {
      return { icon: 'fa-brands fa-soundcloud', label: 'SoundCloud', tone: 'default' };
    }
    if (/spotify\.com$/.test(host)) {
      return { icon: 'fa-brands fa-spotify', label: 'Spotify', tone: 'default' };
    }
    if (/dailymotion\.com$|dai\.ly$/.test(host)) {
      return { icon: 'fa-brands fa-dailymotion', label: 'Dailymotion', tone: 'default' };
    }
    if (/twitter\.com$|x\.com$/.test(host)) {
      return { icon: 'fa-brands fa-x-twitter', label: 'X', tone: 'default' };
    }
    if (/reddit\.com$/.test(host)) {
      return { icon: 'fa-brands fa-reddit-alien', label: 'Reddit', tone: 'default' };
    }
    if (/linkedin\.com$/.test(host)) {
      return { icon: 'fa-brands fa-linkedin-in', label: 'LinkedIn', tone: 'default' };
    }
    if (/whatsapp\.com$|wa\.me$/.test(host)) {
      return { icon: 'fa-brands fa-whatsapp', label: 'WhatsApp', tone: 'default' };
    }
    return { icon: 'fa-solid fa-link', label: host, tone: 'default' };
  }

  function decodePreviewEntities(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const ta = document.createElement('textarea');
      ta.innerHTML = raw;
      return String(ta.value || raw).trim();
    } catch (_) {
      return raw.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
    }
  }

  // ניקוי לינק לתצוגה מקדימה (מסיר מעקב מיותר) | HYPER CORE TECH
  function canonicalizePreviewUrl(url) {
    try {
      const u = new URL(String(url || '').trim());
      if (/aliexpress\./i.test(u.hostname) && /\/item\//i.test(u.pathname)) {
        return `${u.origin}${u.pathname}`;
      }
      [
        'spm', 'algo_pvid', 'pdp_ext_f', 'utparam-url', 'gatewayAdapt',
        'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'utm_source', 'utm_medium',
        'utm_campaign', 'utm_term', 'utm_content', 'si', 'feature',
      ].forEach((k) => u.searchParams.delete(k));
      return u.toString();
    } catch (_) {
      return String(url || '').trim();
    }
  }

  // מחלץ URL לתצוגה מקדימה — מדלג על YouTube ועל קבצי מדיה ישירים | HYPER CORE TECH
  function extractPreviewableUrl(text) {
    if (!text || typeof text !== 'string') return null;
    const matches = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
    for (const raw of matches) {
      const url = raw.replace(/[.,;:!?)}\]]+$/, '');
      if (!/^https?:\/\//i.test(url)) continue;
      if (isDirectMediaFileUrl(url)) continue;
      if (extractYouTubeId(url)) continue;
      return canonicalizePreviewUrl(url);
    }
    return null;
  }

  // מסיר מהטקסט גם URL ארוך עם פרמטרי מעקב (אחרי canonicalize) | HYPER CORE TECH
  function stripPreviewUrlFromText(text, previewUrl) {
    const canon = canonicalizePreviewUrl(previewUrl);
    if (!text || !canon) return String(text || '').trim();
    return String(text)
      .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
        const cleaned = raw.replace(/[.,;:!?)}\]]+$/, '');
        try {
          if (canonicalizePreviewUrl(cleaned) === canon) return '';
        } catch (_) {}
        return raw;
      })
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function renderLinkPreviewCard(url) {
    const href = canonicalizePreviewUrl(String(url || '').trim());
    if (!/^https?:\/\//i.test(href) || extractYouTubeId(href) || isDirectMediaFileUrl(href)) return '';
    const brand = getLinkBrandMeta(href);
    const host = getLinkHostLabel(href);
    const safeUrl = escapeAttr(href);
    const jsUrl = escapeJsString(href);
    const esc = (s) => (App.escapeHtml ? App.escapeHtml(String(s || '')) : escapeAttr(s));
    return `
      <button
        type="button"
        class="chat-message__link-card chat-message__link-card--${escapeAttr(brand.tone)}"
        data-link-url="${safeUrl}"
        aria-label="פתח קישור"
        onclick="event.stopPropagation();if(typeof App.openExternalChatLink==='function')App.openExternalChatLink('${jsUrl}')"
      >
        <span class="chat-message__link-card-media" hidden>
          <img class="chat-message__link-card-image" alt="" loading="lazy" decoding="async">
        </span>
        <span class="chat-message__link-card-body">
          <span class="chat-message__link-card-icon" aria-hidden="true">
            <i class="${escapeAttr(brand.icon)}"></i>
          </span>
          <span class="chat-message__link-card-text">
            <span class="chat-message__link-card-title">${esc(brand.label)}</span>
            <span class="chat-message__link-card-desc" hidden></span>
            <span class="chat-message__link-card-host">${esc(host)}</span>
          </span>
        </span>
      </button>
    `;
  }

  const linkPreviewCache = new Map();

  function pickImageFromUnknown(value) {
    if (!value) return '';
    if (typeof value === 'string') return decodePreviewEntities(value);
    if (typeof value === 'object') {
      return decodePreviewEntities(value.url || value.src || value.href || '');
    }
    return '';
  }

  function normalizeOEmbedPayload(data, fallbackHost) {
    if (!data || typeof data !== 'object' || data.error) return null;
    const title = String(data.title || '').trim();
    let image = pickImageFromUnknown(data.thumbnail_url || data.thumbnail || '');
    if (!image && typeof data.html === 'string') {
      const m = data.html.match(/src=["']([^"']+\.(?:jpe?g|png|webp|gif)[^"']*)["']/i)
        || data.html.match(/src=["'](https?:\/\/[^"']+)["']/i);
      if (m) image = decodePreviewEntities(m[1]);
    }
    const author = String(data.author_name || '').trim();
    const provider = String(data.provider_name || '').trim();
    if (!title && !image) return null;
    if (/\.html?$/i.test(title) && !image) return null;
    return {
      title: title || provider || fallbackHost || 'קישור',
      description: author ? `מאת ${author}` : '',
      image,
      publisher: provider || author || fallbackHost || '',
    };
  }

  function isWeakLinkPreviewMeta(meta, pageUrl) {
    if (!meta) return true;
    const hasImage = !!String(meta.image || '').trim();
    // בלי תמונה ממשיכים לחפש (גם אם יש כותרת מ-oEmbed) | HYPER CORE TECH
    if (!hasImage) return true;
    const t = String(meta.title || '').trim();
    if (!t) return true;
    if (/\.html?$/i.test(t)) return true;
    if (/^\d+(\.html)?$/i.test(t)) return true;
    if (pageUrl) {
      const host = getLinkHostLabel(pageUrl);
      const brand = getLinkBrandMeta(pageUrl);
      if (t === brand.label || t.toLowerCase() === host.toLowerCase()) return true;
    }
    return false;
  }

  // ספקי oEmbed ציבוריים (CORS) – אותה גישה כמו YouTube | HYPER CORE TECH
  function getOEmbedEndpointForUrl(url) {
    const href = String(url || '');
    if (/vimeo\.com/i.test(href)) {
      return `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(href)}`;
    }
    if (/soundcloud\.com/i.test(href)) {
      return `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(href)}`;
    }
    if (/open\.spotify\.com|spotify\.com/i.test(href)) {
      return `https://open.spotify.com/oembed?url=${encodeURIComponent(href)}`;
    }
    if (/dailymotion\.com|dai\.ly/i.test(href)) {
      return `https://www.dailymotion.com/services/oembed?url=${encodeURIComponent(href)}`;
    }
    if (/tiktok\.com|vm\.tiktok\.com/i.test(href)) {
      return `https://www.tiktok.com/oembed?url=${encodeURIComponent(href)}`;
    }
    if (/reddit\.com/i.test(href)) {
      return `https://www.reddit.com/oembed?url=${encodeURIComponent(href)}`;
    }
    if (/(?:twitter|x)\.com/i.test(href)) {
      return `https://publish.twitter.com/oembed?url=${encodeURIComponent(href)}&omit_script=1`;
    }
    if (/facebook\.com|fb\.watch|fb\.com/i.test(href)) {
      const kind = /\/reel\/|\/videos?\/|\/watch|fb\.watch/i.test(href) ? 'oembed_video' : 'oembed_post';
      return `https://graph.facebook.com/v19.0/${kind}?url=${encodeURIComponent(href)}&omitscript=true`;
    }
    return null;
  }

  async function fetchJsonPreview(endpoint) {
    const response = await fetch(endpoint, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) return null;
    return response.json();
  }

  function readMetaTagContent(doc, keys) {
    for (const key of keys) {
      const el =
        doc.querySelector(`meta[property="${key}"]`) ||
        doc.querySelector(`meta[name="${key}"]`) ||
        doc.querySelector(`meta[property="${key.toLowerCase()}"]`) ||
        doc.querySelector(`meta[name="${key.toLowerCase()}"]`);
      const content = decodePreviewEntities(el?.getAttribute('content') || '');
      if (content) return content;
    }
    return '';
  }

  function parseOgFromHtml(html, fallbackHost) {
    if (!html || typeof html !== 'string') return null;
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const title =
        readMetaTagContent(doc, ['og:title', 'twitter:title']) ||
        String(doc.querySelector('title')?.textContent || '').trim();
      const description = readMetaTagContent(doc, ['og:description', 'twitter:description', 'description']);
      const image = readMetaTagContent(doc, ['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']);
      const publisher =
        readMetaTagContent(doc, ['og:site_name']) || fallbackHost || '';
      if (!title && !image) return null;
      if (/captcha/i.test(title) && !image) return null;
      if (/\.html?$/i.test(title) && !image) return null;
      return {
        title: title || publisher || fallbackHost || 'קישור',
        description: description.slice(0, 180),
        image,
        publisher,
      };
    } catch (_) {
      return null;
    }
  }

  function parseJinaMarkdownMeta(text, fallbackHost) {
    const raw = String(text || '');
    if (!raw) return null;
    const titleMatch = raw.match(/^Title:\s*(.+)$/m);
    const title = String(titleMatch?.[1] || '').trim();
    if (/captcha/i.test(title)) return null;
    const imgMatch = raw.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
    const image = decodePreviewEntities(imgMatch?.[1] || '');
    if (!title && !image) return null;
    return {
      title: title || fallbackHost || 'קישור',
      description: '',
      image,
      publisher: fallbackHost || '',
    };
  }

  async function fetchHtmlViaProxies(url) {
    const key = String(url || '').trim();
    if (!key) return '';

    // אותו דומיין כמו הדף – בלי פרוקסי | HYPER CORE TECH
    try {
      const target = new URL(key);
      if (typeof location !== 'undefined' && target.origin === location.origin) {
        const res = await fetch(key, { credentials: 'omit', cache: 'no-store' });
        if (res.ok) return await res.text();
      }
    } catch (_) {}

    // allorigins – CORS ציבורי יציב יחסית | HYPER CORE TECH
    try {
      const data = await fetchJsonPreview(
        `https://api.allorigins.win/get?url=${encodeURIComponent(key)}`
      );
      if (data && typeof data.contents === 'string' && data.contents.length > 200) {
        return data.contents;
      }
    } catch (_) {}

    // corsproxy – כבר בשימוש ב-news-wave.js | HYPER CORE TECH
    try {
      const res = await fetch(`${LINK_PREVIEW_CORS_PROXY}${encodeURIComponent(key)}`, {
        credentials: 'omit',
        cache: 'no-store',
      });
      if (res.ok) {
        const text = await res.text();
        if (text && text.length > 200 && !/CORSPROXY — Fix CORS/i.test(text)) {
          return text;
        }
      }
    } catch (_) {}

    return '';
  }

  async function fetchMicrolinkMeta(url, fallbackHost) {
    try {
      const data = await fetchJsonPreview(
        `https://api.microlink.io/?url=${encodeURIComponent(url)}&meta=true`
      );
      if (!data || data.status !== 'success' || !data.data) return null;
      const d = data.data;
      const title = String(d.title || '').trim();
      const description = String(d.description || '').trim();
      const image = pickImageFromUnknown(d.image || d.logo);
      const publisher = String(d.publisher || d.author || fallbackHost || '').trim();
      if (!title && !image) return null;
      if (/\.html?$/i.test(title) && !image) return null;
      return {
        title: title || publisher || fallbackHost || 'קישור',
        description: description.slice(0, 180),
        image,
        publisher: publisher || fallbackHost || '',
      };
    } catch (_) {
      return null;
    }
  }

  function mergePreviewMeta(base, next) {
    if (!next) return base;
    if (!base) return next;
    const nextTitle = String(next.title || '').trim();
    const baseTitle = String(base.title || '').trim();
    const preferNextTitle = nextTitle && (
      !baseTitle ||
      /\.html?$/i.test(baseTitle) ||
      nextTitle.length > baseTitle.length + 8
    );
    return {
      title: preferNextTitle ? nextTitle : (baseTitle || nextTitle),
      description: next.description || base.description || '',
      image: next.image || base.image || '',
      publisher: next.publisher || base.publisher || '',
    };
  }

  function buildPreviewImageCandidates(imageUrl) {
    const src = decodePreviewEntities(imageUrl);
    if (!/^https?:\/\//i.test(src)) return [];
    const bare = src.replace(/^https?:\/\//i, '');
    return [
      src,
      `https://wsrv.nl/?url=${encodeURIComponent(bare)}&w=640&output=jpg`,
      `${LINK_PREVIEW_CORS_PROXY}${encodeURIComponent(src)}`,
    ];
  }

  function applyLinkPreviewImage(card, mediaEl, img, imageUrl) {
    const candidates = buildPreviewImageCandidates(imageUrl);
    if (!candidates.length || !img || !mediaEl) return;
    let idx = 0;
    const show = () => {
      mediaEl.hidden = false;
      card.classList.add('has-image');
    };
    const hide = () => {
      mediaEl.hidden = true;
      card.classList.remove('has-image');
    };
    const tryNext = () => {
      if (idx >= candidates.length) {
        hide();
        return;
      }
      const next = candidates[idx++];
      img.onload = () => {
        if (img.naturalWidth > 1) show();
        else tryNext();
      };
      img.onerror = () => tryNext();
      img.src = next;
      if (img.complete) {
        if (img.naturalWidth > 1) show();
        else if (!img.naturalWidth) tryNext();
      }
    };
    tryNext();
  }

  async function fetchLinkPreviewMeta(url) {
    const key = canonicalizePreviewUrl(String(url || '').trim());
    if (!key) return null;
    if (linkPreviewCache.has(key)) return linkPreviewCache.get(key);

    const host = getLinkHostLabel(key);
    let meta = null;

    try {
      // 1) oEmbed ייעודי (TikTok/Vimeo וכו') | HYPER CORE TECH
      const specific = getOEmbedEndpointForUrl(key);
      if (specific) {
        const data = await fetchJsonPreview(specific);
        meta = normalizeOEmbedPayload(data, host);
      }

      // 2) noembed – כמו YouTube אצלנו | HYPER CORE TECH
      if (isWeakLinkPreviewMeta(meta, key)) {
        const data = await fetchJsonPreview(`https://noembed.com/embed?url=${encodeURIComponent(key)}`);
        meta = mergePreviewMeta(meta, normalizeOEmbedPayload(data, host));
      }

      // 3) microlink – מטא OG לרוב האתרים (ynet/sos וכו') | HYPER CORE TECH
      if (isWeakLinkPreviewMeta(meta, key)) {
        meta = mergePreviewMeta(meta, await fetchMicrolinkMeta(key, host));
      }

      // 4) HTML דרך פרוקסי קיימים / אותו דומיין | HYPER CORE TECH
      if (isWeakLinkPreviewMeta(meta, key)) {
        const html = await fetchHtmlViaProxies(key);
        meta = mergePreviewMeta(meta, parseOgFromHtml(html, host));
      }

      // 5) jina reader – כותרת+תמונה מתוך markdown | HYPER CORE TECH
      if (isWeakLinkPreviewMeta(meta, key)) {
        try {
          const res = await fetch(`https://r.jina.ai/${key}`, {
            credentials: 'omit',
            cache: 'no-store',
            headers: { Accept: 'text/plain' },
          });
          if (res.ok) {
            meta = mergePreviewMeta(meta, parseJinaMarkdownMeta(await res.text(), host));
          }
        } catch (_) {}
      }
    } catch (err) {
      console.warn('Failed to fetch link preview', err);
    }

    if (!meta) {
      const brand = getLinkBrandMeta(key);
      meta = {
        title: brand.label,
        description: '',
        image: '',
        publisher: host,
      };
    }

    linkPreviewCache.set(key, meta);
    return meta;
  }

  async function hydrateLinkPreviewCards(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const cards = scope.querySelectorAll?.(
      '.chat-message__link-card[data-link-url]:not([data-link-hydrated="1"])'
    );
    if (!cards || !cards.length) return;
    await Promise.all(Array.from(cards).map(async (card) => {
      const url = card.getAttribute('data-link-url');
      if (!url) return;
      card.setAttribute('data-link-hydrated', '1');
      const meta = await fetchLinkPreviewMeta(url);
      if (!meta) return;

      const titleEl = card.querySelector('.chat-message__link-card-title');
      const descEl = card.querySelector('.chat-message__link-card-desc');
      const hostEl = card.querySelector('.chat-message__link-card-host');
      const mediaEl = card.querySelector('.chat-message__link-card-media');
      const img = card.querySelector('.chat-message__link-card-image');

      if (meta.title && titleEl) {
        titleEl.textContent = meta.title;
        card.setAttribute('aria-label', `פתח: ${meta.title}`);
      }
      if (meta.description && descEl) {
        descEl.textContent = meta.description;
        descEl.hidden = false;
      }
      if (meta.publisher && hostEl) {
        hostEl.textContent = meta.publisher;
      } else if (hostEl) {
        hostEl.textContent = getLinkHostLabel(url);
      }
      if (meta.image) {
        applyLinkPreviewImage(card, mediaEl, img, meta.image);
      }
    }));
  }

  // תאימות לשמות ישנים — מפנים לכרטיס הלינק הכללי | HYPER CORE TECH
  function extractFacebookUrl(text) {
    const url = extractPreviewableUrl(text);
    if (!url) return null;
    return /facebook\.com|fb\.watch|fb\.com/i.test(url) ? url : null;
  }
  function renderFacebookCard(url) {
    return renderLinkPreviewCard(url);
  }
  async function hydrateFacebookCards(root) {
    return hydrateLinkPreviewCards(root);
  }
  function openFacebookExternal(url) {
    openExternalChatLink(url);
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
    let messageId = '';
    let peerPubkey = '';

    if (metaOrEl && typeof metaOrEl === 'object' && metaOrEl.nodeType === 1) {
      const msg = metaOrEl.closest?.('.chat-message') || null;
      isOutgoing = !!msg?.classList?.contains('chat-message--outgoing');
      fromKey = (msg?.getAttribute('data-chat-from') || '').toLowerCase();
      createdAt = Number(msg?.getAttribute('data-chat-created') || 0) || 0;
      messageId = String(msg?.getAttribute('data-message-id') || '').trim();
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
      messageId = String(metaOrEl.messageId || metaOrEl.id || '').trim();
      peerPubkey = String(metaOrEl.peerPubkey || metaOrEl.to || '').toLowerCase();
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

    if (!peerPubkey) {
      if (!isOutgoing && fromKey) peerPubkey = fromKey;
      else {
        peerPubkey = (
          document.querySelector('.chat-contact--active')?.getAttribute('data-chat-contact') ||
          ''
        ).toLowerCase();
      }
    }

    const timeLabel = timeFromDom || formatLightboxTimeLabel(createdAt) || '';

    return {
      isOutgoing,
      messageId,
      peerPubkey,
      senderName: esc(senderName),
      senderPicture: esc(senderPicture),
      senderInitials: esc(senderInitials),
      timeLabel: esc(timeLabel),
    };
  }

  function buildLightboxShellHtml({ kind, mediaHtml, meta, showNav = false }) {
    const resolved = resolveLightboxSenderMeta(meta);
    const initials = resolved.senderInitials || 'מ';
    // רק עיגול אחד: תמונה אם קיימת, אחרת ראשי תיבות (לא שניהם יחד)
    const avatarHtml = resolved.senderPicture
      ? `<img class="chat-lightbox__avatar" src="${resolved.senderPicture}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;chat-lightbox__avatar chat-lightbox__avatar--initials&quot;>${initials}</span>';">`
      : `<span class="chat-lightbox__avatar chat-lightbox__avatar--initials">${initials}</span>`;
    const isYouTube = kind === 'youtube';
    const actionLabel = isYouTube ? 'פתח ביוטיוב' : 'הורד';
    const actionIcon = isYouTube ? 'fa-arrow-up-right-from-square' : 'fa-download';
    const canDelete = !!(resolved.isOutgoing && resolved.messageId && resolved.peerPubkey);
    const deleteHtml = canDelete
      ? `<button type="button" class="chat-lightbox__action chat-lightbox__delete" aria-label="מחק" title="מחק"><i class="fa-solid fa-trash-can"></i></button>`
      : '';
    const navHtml = showNav
      ? `<div class="chat-lightbox__nav-arrows" role="group" aria-label="ניווט מדיה">
          <button type="button" class="chat-lightbox__nav-arrow chat-lightbox__nav-arrow--up" aria-label="מדיה קודמת" title="מדיה קודמת">
            <i class="fa-solid fa-chevron-up"></i>
          </button>
          <button type="button" class="chat-lightbox__nav-arrow chat-lightbox__nav-arrow--down" aria-label="מדיה הבאה" title="מדיה הבאה">
            <i class="fa-solid fa-chevron-down"></i>
          </button>
        </div>`
      : '';
    return `
      <div class="chat-lightbox__backdrop"></div>
      <div class="chat-lightbox__frame">
        <header class="chat-lightbox__header">
          <div class="chat-lightbox__identity">
            <button type="button" class="chat-lightbox__back chat-lightbox__close" aria-label="חזרה" title="חזרה">
              <i class="fa-solid fa-arrow-right"></i>
            </button>
            ${avatarHtml}
            <div class="chat-lightbox__meta">
              <span class="chat-lightbox__sender-name">${resolved.senderName || ''}</span>
              <span class="chat-lightbox__time">${resolved.timeLabel || ''}</span>
            </div>
          </div>
          <div class="chat-lightbox__actions">
            <button type="button" class="chat-lightbox__action chat-lightbox__download" aria-label="${actionLabel}" title="${actionLabel}">
              <i class="fa-solid ${actionIcon}"></i>
            </button>
            ${deleteHtml}
            <button type="button" class="chat-lightbox__action chat-lightbox__share" aria-label="שתף" title="שתף">
              <i class="fa-solid fa-share-nodes"></i>
            </button>
          </div>
        </header>
        <div class="chat-lightbox__stage${isYouTube ? ' chat-lightbox__stage--youtube' : ''}">
          ${mediaHtml}
        </div>
        ${navHtml}
      </div>
    `;
  }

  function normalizeLightboxSrc(src) {
    return String(src || '').trim().split('#')[0];
  }

  function isTinyPlaceholderSrc(src) {
    const s = String(src || '');
    return s.startsWith('data:image/') && s.length < 400;
  }

  function collectChatMediaPlaylist(anchorEl) {
    const root =
      document.getElementById('chatMessages') ||
      anchorEl?.closest?.('#chatMessages, .chat-conversation__messages') ||
      null;
    const items = [];
    if (!root) return items;

    root.querySelectorAll('.chat-message').forEach((msg) => {
      msg.querySelectorAll('img.chat-message__image').forEach((img) => {
        const wrap = img.closest('.chat-message__image-container');
        if (wrap?.classList?.contains('is-media-pending') && wrap.dataset.ready !== '1') return;
        const src = normalizeLightboxSrc(img.currentSrc || img.src);
        if (!src || isTinyPlaceholderSrc(src)) return;
        const name = img.getAttribute('alt') || 'תמונה';
        items.push({ kind: 'image', src, name, metaEl: wrap || img });
      });

      msg.querySelectorAll('.chat-message__video-container').forEach((container) => {
        if (container.classList.contains('is-media-pending') && container.dataset.ready !== '1') return;
        const video = container.querySelector('video');
        if (!video) return;
        const sourceEl = video.querySelector('source');
        const src = normalizeLightboxSrc((sourceEl && sourceEl.src) || video.currentSrc || video.src);
        if (!src || isTinyPlaceholderSrc(src)) return;
        const name = video.getAttribute('aria-label') || 'וידאו';
        const type = (sourceEl && sourceEl.getAttribute('type')) || 'video/mp4';
        items.push({ kind: 'video', src, name, type, metaEl: container });
      });

      msg.querySelectorAll('.chat-media-upload').forEach((wrap) => {
        if (wrap.dataset.mediaReady === '0') return;
        const img = wrap.querySelector('img.chat-media-upload__media');
        const video = wrap.querySelector('video.chat-media-upload__media');
        if (img) {
          const src = normalizeLightboxSrc(img.currentSrc || img.src);
          if (!src || isTinyPlaceholderSrc(src)) return;
          items.push({ kind: 'image', src, name: img.getAttribute('alt') || 'תמונה', metaEl: wrap });
          return;
        }
        if (video) {
          const sourceEl = video.querySelector('source');
          const src = normalizeLightboxSrc((sourceEl && sourceEl.src) || video.currentSrc || video.src);
          if (!src || isTinyPlaceholderSrc(src)) return;
          const type = (sourceEl && sourceEl.getAttribute('type')) || video.getAttribute('type') || 'video/mp4';
          items.push({
            kind: 'video',
            src,
            name: video.getAttribute('aria-label') || 'וידאו',
            type,
            metaEl: wrap,
          });
        }
      });
    });

    return items;
  }

  function findChatMediaPlaylistIndex(playlist, kind, src, metaEl) {
    if (!Array.isArray(playlist) || !playlist.length) return -1;
    if (metaEl && metaEl.nodeType === 1) {
      const byEl = playlist.findIndex((item) => {
        const el = item.metaEl;
        if (!el) return false;
        return el === metaEl || el.contains?.(metaEl) || metaEl.contains?.(el);
      });
      if (byEl >= 0) return byEl;
    }
    const target = normalizeLightboxSrc(src);
    return playlist.findIndex((item) => item.kind === kind && normalizeLightboxSrc(item.src) === target);
  }

  function removeOpenChatLightboxes() {
    ['chatMediaLightbox', 'chatImageLightbox', 'chatVideoLightbox', 'chatYouTubeLightbox'].forEach((id) => {
      document.getElementById(id)?.remove();
    });
    document.querySelectorAll('.chat-lightbox').forEach((el) => {
      try { el.remove(); } catch (_) {}
    });
    document.getElementById('chatLightboxDeleteDialog')?.remove();
    document.body.classList.remove('chat-lightbox-open');
    try {
      App.__sosSuppressChatOutsideClose = false;
    } catch (_) {}
  }

  /** סגירת לייטבוקס לצורך כפתור Back מערכתי | HYPER CORE TECH */
  function closeChatLightbox() {
    const open =
      document.body.classList.contains('chat-lightbox-open') ||
      !!document.querySelector('.chat-lightbox');
    if (!open) return false;
    try {
      const btn = document.querySelector(
        '.chat-lightbox .chat-lightbox__back, .chat-lightbox .chat-lightbox__close'
      );
      if (btn) {
        btn.click();
        return true;
      }
    } catch (_) {}
    try {
      document.querySelectorAll('.chat-lightbox video').forEach((v) => {
        try {
          v.pause();
          v.removeAttribute('src');
          v.load();
        } catch (_) {}
      });
    } catch (_) {}
    removeOpenChatLightboxes();
    return true;
  }

  function buildLightboxMediaHtml(item) {
    if (item.kind === 'video') {
      const safeName = App.escapeHtml ? App.escapeHtml(item.name || 'וידאו') : String(item.name || 'וידאו');
      const mime = item.type || 'video/mp4';
      return `
        <video class="chat-lightbox__video" controls playsinline webkit-playsinline autoplay>
          <source src="${String(item.src).replace(/"/g, '&quot;')}" type="${String(mime).replace(/"/g, '&quot;')}">
        </video>
      `;
    }
    const safeName = App.escapeHtml ? App.escapeHtml(item.name || 'תמונה') : String(item.name || 'תמונה');
    return `<img src="${String(item.src).replace(/"/g, '&quot;')}" alt="${safeName}" class="chat-lightbox__image">`;
  }

  function attachLightboxGalleryControls(lightbox, { playlist, index, onNavigate }) {
    const total = Array.isArray(playlist) ? playlist.length : 0;
    const canNav = total > 1 && typeof onNavigate === 'function';
    const upBtn = lightbox.querySelector('.chat-lightbox__nav-arrow--up');
    const downBtn = lightbox.querySelector('.chat-lightbox__nav-arrow--down');
    if (upBtn) upBtn.disabled = !canNav || index <= 0;
    if (downBtn) downBtn.disabled = !canNav || index >= total - 1;
    if (!canNav) return () => {};

    const goPrev = (event) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (index <= 0) return;
      onNavigate(index - 1);
    };
    const goNext = (event) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (index >= total - 1) return;
      onNavigate(index + 1);
    };

    upBtn?.addEventListener('click', goPrev);
    downBtn?.addEventListener('click', goNext);

    const onKey = (e) => {
      if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault();
        goPrev(e);
      } else if (e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault();
        goNext(e);
      }
    };
    document.addEventListener('keydown', onKey);

    const stage = lightbox.querySelector('.chat-lightbox__stage');
    let startX = 0;
    let startY = 0;
    let tracking = false;
    const onTouchStart = (e) => {
      if (!e.changedTouches?.length) return;
      if (e.target.closest?.('input, button, .chat-lightbox__header, .chat-lightbox__nav-arrows')) return;
      const t = e.changedTouches[0];
      startX = t.clientX;
      startY = t.clientY;
      tracking = true;
    };
    const onTouchEnd = (e) => {
      if (!tracking || !e.changedTouches?.length) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dy) < 56 || Math.abs(dy) < Math.abs(dx) * 1.15) return;
      if (dy < 0) goNext();
      else goPrev();
    };
    stage?.addEventListener('touchstart', onTouchStart, { passive: true });
    stage?.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('keydown', onKey);
      stage?.removeEventListener('touchstart', onTouchStart);
      stage?.removeEventListener('touchend', onTouchEnd);
    };
  }

  function confirmLightboxDelete(messageId, peerPubkey, onDone) {
    const existing = document.getElementById('chatLightboxDeleteDialog');
    if (existing) existing.remove();
    const dialog = document.createElement('div');
    dialog.id = 'chatLightboxDeleteDialog';
    dialog.className = 'chat-dialog chat-lightbox-delete-dialog';
    dialog.innerHTML = `
      <div class="chat-dialog__backdrop"></div>
      <div class="chat-dialog__content" role="dialog" aria-modal="true">
        <h3 class="chat-dialog__title">מחיקת הודעה</h3>
        <p class="chat-dialog__message">למחוק את ההודעה עבור שני הצדדים? פעולה זו תשלח מחיקה לרשת.</p>
        <div class="chat-dialog__actions">
          <button type="button" class="chat-dialog__btn chat-dialog__btn--cancel">ביטול</button>
          <button type="button" class="chat-dialog__btn chat-dialog__btn--confirm">מחק</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
    const close = () => dialog.remove();
    dialog.querySelector('.chat-dialog__backdrop')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    });
    dialog.querySelector('.chat-dialog__content')?.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    dialog.querySelector('.chat-dialog__btn--cancel')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    });
    dialog.querySelector('.chat-dialog__btn--confirm')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
      if (typeof App.deleteChatMessage === 'function') {
        Promise.resolve(App.deleteChatMessage(peerPubkey, messageId))
          .catch((err) => {
            console.warn('[CHAT-MEDIA] lightbox delete failed', err);
          })
          .finally(() => {
            if (typeof onDone === 'function') onDone();
          });
      } else if (typeof onDone === 'function') {
        onDone();
      }
    });
  }

  async function shareLightboxMedia({ src, name, kind, watchUrl }) {
    const title = name || (kind === 'video' ? 'וידאו' : kind === 'youtube' ? 'יוטיוב' : 'תמונה');
    const url = watchUrl || src || '';
    try {
      if (navigator.share) {
        if (src && kind !== 'youtube') {
          try {
            const res = await fetch(src);
            const blob = await res.blob();
            const fileName = name || (kind === 'video' ? 'video.mp4' : 'image.jpg');
            const file = new File([blob], fileName, {
              type: blob.type || (kind === 'video' ? 'video/mp4' : 'image/jpeg'),
            });
            if (navigator.canShare?.({ files: [file] })) {
              await navigator.share({ files: [file], title });
              return;
            }
          } catch (_) {}
        }
        await navigator.share({ title, url: url || undefined, text: title });
        return;
      }
    } catch (_) {}
    if (url && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        if (typeof App.showToast === 'function') App.showToast('הקישור הועתק');
      } catch (_) {}
    }
  }

  function wireLightboxShell(lightbox, { close, onPrimaryAction, onShare, onDelete }) {
    const backBtn = lightbox.querySelector('.chat-lightbox__back') || lightbox.querySelector('.chat-lightbox__close');
    backBtn?.addEventListener('click', close);
    lightbox.querySelector('.chat-lightbox__backdrop')?.addEventListener('click', close);
    lightbox.querySelector('.chat-lightbox__download')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const btn = event.currentTarget;
      if (!btn || btn.dataset.dlBusy === '1' || btn.disabled) return;
      if (!setDownloadButtonBusy(btn, true)) return;
      Promise.resolve(typeof onPrimaryAction === 'function' ? onPrimaryAction(event) : null)
        .catch(() => {})
        .finally(() => {
          setDownloadButtonBusy(btn, false);
        });
    });
    lightbox.querySelector('.chat-lightbox__share')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (typeof onShare === 'function') onShare(event);
    });
    lightbox.querySelector('.chat-lightbox__delete')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (typeof onDelete === 'function') onDelete(event);
    });
    lightbox.querySelector('.chat-lightbox__frame')?.addEventListener('click', (event) => event.stopPropagation());
    const onEsc = (e) => {
      if (e.key === 'Escape') {
        close(e);
      }
    };
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('keydown', onEsc);
    };
  }

  // חלק lightbox YouTube (chat-media-renderer.js) – מסך מלא עם אותו shell של תמונה/וידאו | HYPER CORE TECH
  function openYouTubeLightbox(videoId, title, meta) {
    const existing = document.getElementById('chatYouTubeLightbox');
    if (existing) existing.remove();
    const id = String(videoId || '').trim();
    if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return;

    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    const embedUrl = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&playsinline=1`;
    const headerTitle = String(title || 'יוטיוב').trim() || 'יוטיוב';
    const lightbox = document.createElement('div');
    lightbox.id = 'chatYouTubeLightbox';
    lightbox.className = 'chat-lightbox chat-lightbox--youtube';
    const mediaHtml = `
      <iframe
        class="chat-lightbox__youtube"
        src="${embedUrl}"
        title="${escapeAttr(headerTitle)}"
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowfullscreen
        referrerpolicy="strict-origin-when-cross-origin"
      ></iframe>
    `;
    const resolved = resolveLightboxSenderMeta(meta || null);
    lightbox.innerHTML = buildLightboxShellHtml({
      kind: 'youtube',
      mediaHtml,
      meta: meta || null,
    });

    document.body.appendChild(lightbox);
    document.body.classList.add('chat-lightbox-open');
    App.__sosSuppressChatOutsideClose = true;

    const close = (event) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      try { detachShell(); } catch (_) {}
      lightbox.classList.add('chat-lightbox--closing');
      document.body.classList.remove('chat-lightbox-open');
      setTimeout(() => {
        lightbox.remove();
        document.getElementById('chatLightboxDeleteDialog')?.remove();
        setTimeout(() => { App.__sosSuppressChatOutsideClose = false; }, 100);
      }, 200);
    };

    const detachShell = wireLightboxShell(lightbox, {
      close,
      onPrimaryAction: () => {
        App.__sosSuppressChatOutsideClose = true;
        try {
          window.open(watchUrl, '_blank', 'noopener,noreferrer');
        } catch (_) {
          window.location.href = watchUrl;
        }
        setTimeout(() => { App.__sosSuppressChatOutsideClose = false; }, 800);
      },
      onShare: () => {
        App.__sosSuppressChatOutsideClose = true;
        Promise.resolve(shareLightboxMedia({
          src: watchUrl,
          name: headerTitle,
          kind: 'youtube',
          watchUrl,
        })).finally(() => {
          setTimeout(() => { App.__sosSuppressChatOutsideClose = false; }, 800);
        });
      },
      onDelete: () => {
        if (!resolved.messageId || !resolved.peerPubkey) return;
        confirmLightboxDelete(resolved.messageId, resolved.peerPubkey, close);
      },
    }) || (() => {});

    requestAnimationFrame(() => lightbox.classList.add('chat-lightbox--visible'));
  }

  // חלק lightbox (chat-media-renderer.js) – גלריית מדיה בשיחה עם חצים בדסקטופ והחלקה במובייל | HYPER CORE TECH
  function openLightboxGallery(playlist, index, { instant = false } = {}) {
    const items = Array.isArray(playlist) ? playlist.filter(Boolean) : [];
    if (!items.length) return;
    const safeIndex = Math.max(0, Math.min(items.length - 1, Number(index) || 0));
    const item = items[safeIndex];
    if (!item?.src) return;

    removeOpenChatLightboxes();

    const lightbox = document.createElement('div');
    lightbox.id = 'chatMediaLightbox';
    lightbox.className = `chat-lightbox${item.kind === 'video' ? ' chat-lightbox--video' : ''}`;
    const mediaHtml = buildLightboxMediaHtml(item);
    const resolved = resolveLightboxSenderMeta(item.metaEl || null);
    lightbox.innerHTML = buildLightboxShellHtml({
      kind: item.kind,
      mediaHtml,
      meta: item.metaEl || null,
      showNav: items.length > 1,
    });

    document.body.appendChild(lightbox);
    document.body.classList.add('chat-lightbox-open');
    App.__sosSuppressChatOutsideClose = true;

    const videoEl = lightbox.querySelector('.chat-lightbox__video');
    let detachShell = () => {};
    let detachGallery = () => {};

    const cleanupListeners = () => {
      try { detachGallery(); } catch (_) {}
      try { detachShell(); } catch (_) {}
      detachGallery = () => {};
      detachShell = () => {};
    };

    const close = (event) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      cleanupListeners();
      try {
        if (videoEl) {
          videoEl.pause();
          videoEl.removeAttribute('src');
          videoEl.querySelectorAll('source').forEach((s) => s.removeAttribute('src'));
          videoEl.load();
        }
      } catch (_) {}
      lightbox.classList.add('chat-lightbox--closing');
      document.body.classList.remove('chat-lightbox-open');
      setTimeout(() => {
        lightbox.remove();
        document.getElementById('chatLightboxDeleteDialog')?.remove();
        setTimeout(() => { App.__sosSuppressChatOutsideClose = false; }, 100);
      }, instant ? 0 : 200);
    };

    const navigateTo = (nextIndex) => {
      cleanupListeners();
      try {
        if (videoEl) {
          videoEl.pause();
          videoEl.removeAttribute('src');
          videoEl.querySelectorAll('source').forEach((s) => s.removeAttribute('src'));
          videoEl.load();
        }
      } catch (_) {}
      openLightboxGallery(items, nextIndex, { instant: true });
    };

    detachShell = wireLightboxShell(lightbox, {
      close,
      onPrimaryAction: () => {
        App.__sosSuppressChatOutsideClose = true;
        const fileName = item.name || (item.kind === 'video' ? 'video.mp4' : 'image.jpg');
        return Promise.resolve(downloadChatMedia(item.src, fileName)).finally(() => {
          setTimeout(() => { App.__sosSuppressChatOutsideClose = false; }, 800);
        });
      },
      onShare: () => {
        App.__sosSuppressChatOutsideClose = true;
        Promise.resolve(shareLightboxMedia({
          src: item.src,
          name: item.name || (item.kind === 'video' ? 'video.mp4' : 'image.jpg'),
          kind: item.kind,
        })).finally(() => {
          setTimeout(() => { App.__sosSuppressChatOutsideClose = false; }, 800);
        });
      },
      onDelete: () => {
        if (!resolved.messageId || !resolved.peerPubkey) return;
        confirmLightboxDelete(resolved.messageId, resolved.peerPubkey, close);
      },
    }) || (() => {});

    detachGallery = attachLightboxGalleryControls(lightbox, {
      playlist: items,
      index: safeIndex,
      onNavigate: navigateTo,
    }) || (() => {});

    const reveal = () => {
      lightbox.classList.add('chat-lightbox--visible');
      if (item.kind === 'video') {
        try {
          const p = videoEl?.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) {}
      }
    };
    if (instant) reveal();
    else requestAnimationFrame(reveal);
  }

  function openImageLightbox(src, name, meta) {
    if (!src) return;
    const metaEl = meta && meta.nodeType === 1 ? meta : null;
    const fallback = {
      kind: 'image',
      src: normalizeLightboxSrc(src),
      name: name || 'תמונה',
      metaEl,
    };
    const playlist = collectChatMediaPlaylist(metaEl);
    let index = findChatMediaPlaylistIndex(playlist, 'image', fallback.src, metaEl);
    if (index < 0) {
      playlist.push(fallback);
      index = playlist.length - 1;
    }
    openLightboxGallery(playlist, index);
  }

  function openVideoLightbox(src, name, type, meta) {
    const playSrc = normalizeLightboxSrc(src);
    if (!playSrc) return;
    const metaEl = meta && meta.nodeType === 1 ? meta : null;
    const fallback = {
      kind: 'video',
      src: playSrc,
      name: name || 'וידאו',
      type: type || 'video/mp4',
      metaEl,
    };
    const playlist = collectChatMediaPlaylist(metaEl);
    let index = findChatMediaPlaylistIndex(playlist, 'video', playSrc, metaEl);
    if (index < 0) {
      playlist.push(fallback);
      index = playlist.length - 1;
    }
    openLightboxGallery(playlist, index);
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
            ${buildChatFileNameHtml(name, { className: 'chat-pdf-bubble__name' })}
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
            ${buildChatFileNameHtml(name, { className: 'chat-pdf-bubble__name' })}
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
    if (attachment.isVoice === true) return false;
    if (isImageAttachment(attachment) || isVideoAttachment(attachment)) return false;
    const mime = (attachment.type || '').toLowerCase();
    if (mime.startsWith('audio/') || mime === 'application/ogg') return false;
    const name = (attachment.name || '').toLowerCase();
    if (name.includes('voice') || name.includes('ptt') || name.includes('voicemessage')) return false;
    if (typeof attachment.duration === 'number' && attachment.duration > 0) return false;
    if (/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|amr|caf)(\?|$)/i.test(name)) return false;
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

  // חלק שם קובץ לתצוגה (chat-media-renderer.js) – קיצור קבוע כדי לא להרחיב את הצ'אט במובייל | HYPER CORE TECH
  function formatChatFileDisplayName(name) {
    const full = String(name || '').trim() || 'קובץ';
    let maxChars = 40;
    try {
      if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
        maxChars = 24;
      }
    } catch (_) {}
    if (full.length <= maxChars) {
      return { full, display: full, truncated: false };
    }
    const lastDot = full.lastIndexOf('.');
    const extLen = lastDot > 0 ? full.length - lastDot : 0;
    const hasExt = lastDot > 0 && extLen >= 2 && extLen <= 8 && !/\s/.test(full.slice(lastDot + 1));
    const ext = hasExt ? full.slice(lastDot) : '';
    const headBudget = Math.max(6, maxChars - (ext ? ext.length + 1 : 1));
    return { full, display: `${full.slice(0, headBudget)}…${ext}`, truncated: true };
  }

  function escapeChatFileNameHtml(value) {
    if (App.escapeHtml) return App.escapeHtml(value);
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildChatFileNameHtml(name, { className = 'chat-file-bubble__name', tag = 'div' } = {}) {
    const { full, display } = formatChatFileDisplayName(name);
    const safeFull = escapeChatFileNameHtml(full);
    const safeDisplay = escapeChatFileNameHtml(display);
    return `<${tag} class="${className}" title="${safeFull}" data-full-name="${safeFull}">${safeDisplay}</${tag}>`;
  }

  function readChatFileDisplayName(el) {
    if (!el) return '';
    return String(el.getAttribute('data-full-name') || el.getAttribute('title') || el.textContent || '').trim();
  }

  // חלק רנדור קובץ כללי (chat-media-renderer.js) – בועת קובץ בסגנון WhatsApp עם אייקון, שם, גודל וכפתור הורדה | HYPER CORE TECH
  function renderGenericFileAttachment(attachment) {
    const name = attachment.name || 'קובץ';
    const size = formatSize(attachment.size);
    const iconClass = getFileIcon(attachment);
    const downloadHtml = buildAttachmentDownloadHtml(attachment, 'chat-file-bubble__download');

    return `
      <div class="chat-file-bubble">
        <div class="chat-file-bubble__icon"><i class="fa-solid ${iconClass}"></i></div>
        <div class="chat-file-bubble__info">
          ${buildChatFileNameHtml(name)}
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
    renderYouTubeCard,
    hydrateYouTubeCards,
    openYouTubeExternal,
    openYouTubeLightbox,
    extractPreviewableUrl,
    stripPreviewUrlFromText,
    renderLinkPreviewCard,
    hydrateLinkPreviewCards,
    extractFacebookUrl,
    renderFacebookCard,
    hydrateFacebookCards,
    openFacebookExternal,
    openExternalChatLink,
    openImageLightbox,
    openVideoLightbox,
    closeChatLightbox,
    applyChatMediaBoxSize,
    computeChatMediaBox,
    reflowLockedChatMedia,
    downloadChatMedia,
    downloadChatMediaFromButton,
    resolveLiveChatDownloadSrc,
    getFileIcon,
    buildAttachmentDownloadHtml,
    buildMediaDownloadButton,
    formatChatFileDisplayName,
    buildChatFileNameHtml,
    readChatFileDisplayName,
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
