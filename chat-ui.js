(function initChatUI(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;
  // חלק דיבאג מדיה (chat-ui.js) – לוגים לפי localStorage sos_debug_media | HYPER CORE TECH
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
  // חלק אימות גרסה (chat-ui.js) – לוג לוידוא שהקוד החדש נטען | HYPER CORE TECH
  console.log('%c[CHAT-UI] VERSION: WA-FILE-STABLE-v2 (2026-07-30)', 'color: lime; font-size: 14px; font-weight: bold;');
  // חלק צ'אט (chat-ui.js) – צליל והתרעות להודעות נכנסות | HYPER CORE TECH
  const CHAT_MESSAGE_SOUND_URL = 'https://npub1jqzsts0fz6ufkgxdhna99rqwnn0ptrg9tvmy62m7ytffy4w0ncnsm7rac0.blossom.band/f0a73d1b6550d6a140a63fa91ec906f89dcbc2fdece317dbaa81e5093a319629.mp3';
  let chatMessageAudio = null;
  let chatNotificationPermissionLastRequestedAt = 0;

  // חלק צ'אט (chat-ui.js) – מוודא שקיימת סביבת צ'אט
  if (!App.chatState) {
    console.warn('Chat state not initialized – chat UI skipped');
    return;
  }

  function escapeHtmlAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  /** אותה גישה כמו בועות/שיחה – בלי לחתוך data:image מהמטמון | HYPER CORE TECH */
  function safeConversationAvatarSrc(url) {
    if (!url || typeof url !== 'string') return '';
    const u = url.trim();
    if (!u || /^javascript:/i.test(u) || /^vbscript:/i.test(u) || /^data:text\/html/i.test(u)) return '';
    // cacheAvatar שומר data:image מלא (עשרות KB) – חיתוך ל-2048 שובר את התמונה | HYPER CORE TECH
    if (/^data:image\//i.test(u)) return u;
    if (/^blob:/i.test(u)) return u;
    return u.slice(0, 4096);
  }

  function setConversationAvatarElement(pictureUrl, name, initials) {
    if (!elements.conversationAvatar) return;
    const safeInitials = String(initials || 'מש').replace(/[<>]/g, '');
    elements.conversationAvatar.innerHTML = '';
    elements.conversationAvatar.textContent = '';
    const pic = safeConversationAvatarSrc(pictureUrl);
    if (!pic) {
      elements.conversationAvatar.textContent = safeInitials;
      return;
    }
    // כמו contact list / audio avatar – src מלא + no-referrer | HYPER CORE TECH
    const img = doc.createElement('img');
    img.alt = name || 'משתמש';
    img.decoding = 'async';
    img.loading = 'eager';
    img.referrerPolicy = 'no-referrer';
    img.src = pic;
    img.addEventListener('error', () => {
      if (!elements.conversationAvatar) return;
      // אם data URL נכשל – נסה URL מקורי מהפרופיל אם שונה | HYPER CORE TECH
      elements.conversationAvatar.textContent = safeInitials;
    }, { once: true });
    elements.conversationAvatar.appendChild(img);
  }

  function updateActiveConversationHeader(peerPubkey) {
    const peer = String(peerPubkey || state.activeContact || '').toLowerCase();
    if (!peer || peer !== String(state.activeContact || '').toLowerCase()) return;
    const contact = App.chatState?.contacts?.get?.(peer) || null;
    const name = contact?.name || `משתמש ${peer.slice(0, 8)}`;
    const initials = contact?.initials || (typeof App.getInitials === 'function' ? App.getInitials(name) : 'מש');
    if (elements.conversationName) {
      elements.conversationName.textContent = name;
    }
    const picture =
      contact?.picture ||
      contact?.image ||
      contact?.avatar ||
      '';
    setConversationAvatarElement(picture, name, initials);
  }

  // חלק אייקון קובץ (chat-ui.js) – אייקון לפי סיומת בסגנון בועת העברה | HYPER CORE TECH
  function getTransferFileIcon(fileName) {
    const fileExt = String(fileName || '').split('.').pop()?.toLowerCase() || '';
    if (['mp4', 'webm', 'avi', 'mov', 'mkv'].includes(fileExt)) return 'fa-file-video';
    if (['mp3', 'm4a', 'wav', 'ogg', 'flac'].includes(fileExt)) return 'fa-file-audio';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(fileExt)) return 'fa-file-image';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(fileExt)) return 'fa-file-zipper';
    if (fileExt === 'pdf') return 'fa-file-pdf';
    if (['doc', 'docx'].includes(fileExt)) return 'fa-file-word';
    if (['xls', 'xlsx'].includes(fileExt)) return 'fa-file-excel';
    return 'fa-file';
  }

  function formatTransferSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (typeof App.formatFileSize === 'function') return App.formatFileSize(bytes);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // חלק פעולות צד (chat-ui.js) – פח + הורדה בעמודה ליד המדיה (שולח); הורדה במקום הפח (מקבל) | HYPER CORE TECH
  function buildChatMediaSideDownloadHtml(attachment, fallbackUrl, fallbackName) {
    const sideClass = 'chat-message__action-btn chat-message__action-btn--download chat-message__media-download chat-message__media-download--side';
    if (attachment && typeof App.buildAttachmentDownloadHtml === 'function') {
      const html = App.buildAttachmentDownloadHtml(attachment, sideClass);
      if (html && !html.includes('torrent-bubble__download-btn')) return html;
    }
    const src = String(fallbackUrl || attachment?.url || attachment?.dataUrl || '').trim();
    if (!src || src.startsWith('magnet:')) return '';
    if (typeof App.buildMediaDownloadButton === 'function') {
      return App.buildMediaDownloadButton(src, fallbackName || attachment?.name || 'sos-file', sideClass);
    }
    const safeSrc = src.replace(/'/g, "\\'");
    const safeName = String(fallbackName || attachment?.name || 'sos-file').replace(/'/g, "\\'");
    return `<button type="button" class="${sideClass}" title="הורד" aria-label="הורד" onclick="event.preventDefault();event.stopPropagation();if(window.NostrApp&&typeof NostrApp.downloadChatMedia==='function')NostrApp.downloadChatMedia('${safeSrc}','${safeName}');"><i class="fa-solid fa-download" aria-hidden="true"></i></button>`;
  }

  function buildChatFileSideDownloadHtml({ attachment, magnetURI, blobUrl, fileName } = {}) {
    const name = fileName || attachment?.name || 'קובץ';
    const magnet = String(magnetURI || attachment?.magnetURI || '').trim();
    const url =
      String(blobUrl || attachment?.url || attachment?.dataUrl || '').trim() ||
      (magnet && typeof App.getTorrentBlob === 'function' ? App.getTorrentBlob(magnet)?.url || '' : '');
    if (url && !url.startsWith('magnet:')) {
      return buildChatMediaSideDownloadHtml(attachment, url, name);
    }
    if (!magnet) return '';
    const safeMagnet = App.escapeHtml ? App.escapeHtml(magnet) : magnet.replace(/"/g, '&quot;');
    const safeName = App.escapeHtml ? App.escapeHtml(name) : String(name).replace(/"/g, '&quot;');
    return `<button type="button" class="chat-message__action-btn chat-message__action-btn--download chat-message__media-download chat-message__media-download--side torrent-bubble__download-btn" data-magnet="${safeMagnet}" data-filename="${safeName}" title="הורד" aria-label="הורד"><i class="fa-solid fa-download" aria-hidden="true"></i></button>`;
  }

  function buildChatDeleteHtml(messageId) {
    if (!messageId) return '';
    return `<button type="button" class="chat-message__action-btn chat-message__action-btn--danger chat-message__delete" data-chat-delete="${messageId}" title="מחק" aria-label="מחק הודעה"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>`;
  }

  function buildChatLinkCopyHtml(url) {
    const href = String(url || '').trim();
    if (!/^https?:\/\//i.test(href)) return '';
    const safeUrl = App.escapeHtml ? App.escapeHtml(href) : href.replace(/"/g, '&quot;');
    return `<button type="button" class="chat-message__action-btn chat-message__copy-link" data-chat-copy-url="${safeUrl}" title="העתק קישור" aria-label="העתק קישור"><i class="fa-solid fa-link" aria-hidden="true"></i></button>`;
  }

  function buildChatMoreMenuHtml({ aboveHtml = '', belowHtml = '' } = {}) {
    const above = String(aboveHtml || '').trim();
    const below = String(belowHtml || '').trim();
    if (!above && !below) return '';
    return `
      <div class="chat-message__more-wrap">
        <div class="chat-message__more-menu chat-message__more-menu--above" hidden role="menu" data-more-slot="above">
          ${above}
        </div>
        <button type="button" class="chat-message__more" data-chat-more="1" aria-label="פעולות הודעה" aria-expanded="false" title="פעולות">
          <i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i>
        </button>
        <div class="chat-message__more-menu chat-message__more-menu--below" hidden role="menu" data-more-slot="below">
          ${below}
        </div>
      </div>
    `;
  }

  function getChatMessagesScroller() {
    return (
      elements.messagesContainer ||
      doc.getElementById('chatMessages') ||
      doc.querySelector('.chat-conversation__messages') ||
      null
    );
  }

  function clearChatMessageMoreOpenLayout(msg) {
    if (!msg) return;
    const scroller = getChatMessagesScroller();
    const hadPad = msg.classList.contains('chat-message--more-open');
    if (hadPad && scroller) {
      // מסירים מרווח בלי לקפוץ את ההודעה על המסך | HYPER CORE TECH
      const beforeTop = msg.getBoundingClientRect().top;
      msg.style.marginTop = '';
      msg.style.marginBottom = '';
      const afterTop = msg.getBoundingClientRect().top;
      scroller.scrollTop += afterTop - beforeTop;
    } else {
      msg.style.marginTop = '';
      msg.style.marginBottom = '';
    }
    msg.classList.remove('chat-message--more-open');
    delete msg.dataset.morePadAbove;
    delete msg.dataset.morePadBelow;
    const content = msg.querySelector('.chat-message__content');
    if (content) content.style.marginTop = '';
  }

  function closeAllChatMessageMenus(exceptWrap) {
    doc.querySelectorAll('.chat-message__more-wrap.is-open').forEach((wrap) => {
      if (exceptWrap && wrap === exceptWrap) return;
      wrap.classList.remove('is-open');
      const btn = wrap.querySelector('[data-chat-more]');
      if (btn) btn.setAttribute('aria-expanded', 'false');
      wrap.querySelectorAll('.chat-message__more-menu').forEach((menu) => {
        menu.hidden = true;
      });
      clearChatMessageMoreOpenLayout(wrap.closest('.chat-message'));
    });
  }

  function setChatMoreMenusOpen(wrap, open) {
    if (!wrap) return;
    const msg = wrap.closest('.chat-message');
    wrap.classList.toggle('is-open', open);
    const btn = wrap.querySelector('[data-chat-more]');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    wrap.querySelectorAll('.chat-message__more-menu').forEach((menu) => {
      const hasItems = !!menu.querySelector('button, a');
      menu.hidden = !(open && hasItems);
    });

    if (open && msg) {
      // אייקונים absolute; מרווח דוחף שכנים; גלילה מפצה כדי שההודעה+⋮ יישארו במקום על המסך | HYPER CORE TECH
      msg.classList.add('chat-message--more-open');
      requestAnimationFrame(() => {
        const scroller = getChatMessagesScroller();
        const above = wrap.querySelector('.chat-message__more-menu--above');
        const below = wrap.querySelector('.chat-message__more-menu--below');
        const gap = 8;
        const aboveH =
          above && !above.hidden && above.querySelector('button, a')
            ? Math.ceil(above.getBoundingClientRect().height) + gap
            : 0;
        const belowH =
          below && !below.hidden && below.querySelector('button, a')
            ? Math.ceil(below.getBoundingClientRect().height) + gap
            : 0;

        const anchorTop = msg.getBoundingClientRect().top;
        msg.dataset.morePadAbove = String(aboveH);
        msg.dataset.morePadBelow = String(belowH);
        msg.style.marginTop = aboveH ? `${aboveH}px` : '';
        msg.style.marginBottom = belowH ? `${belowH}px` : '';

        if (scroller) {
          const newTop = msg.getBoundingClientRect().top;
          scroller.scrollTop += newTop - anchorTop;
        }
      });
    } else {
      clearChatMessageMoreOpenLayout(msg);
    }
  }

  function buildChatSideActionsHtml({ isOutgoing, messageId, downloadHtml, copyHtml }) {
    const deleteHtml = isOutgoing && messageId ? buildChatDeleteHtml(messageId) : '';
    const copy = copyHtml || '';
    const download = downloadHtml || '';
    // שני כפתורים: אחד מעל ⋮ (העתק/מחק) ואחד מתחת (הורדה) — כמו ZIP | HYPER CORE TECH
    let aboveHtml = `${copy}${deleteHtml}`;
    let belowHtml = download;
    // אם אין הורדה אבל יש שני פריטים למעלה — מפצלים: ראשון מעל, שני מתחת | HYPER CORE TECH
    if (!belowHtml && copy && deleteHtml) {
      aboveHtml = copy;
      belowHtml = deleteHtml;
    }
    const menuHtml = buildChatMoreMenuHtml({
      aboveHtml,
      belowHtml,
    });
    if (!menuHtml) return '';
    return `<div class="chat-message__side-actions">${menuHtml}</div>`;
  }

  function ensureChatSideActions(bubble, { isOutgoing, messageId, downloadHtml, copyHtml }) {
    if (!bubble) return null;
    let side = bubble.querySelector('.chat-message__side-actions');
    const content = bubble.querySelector('.chat-message__content');
    if (!side) {
      side = doc.createElement('div');
      side.className = 'chat-message__side-actions';
      if (content) {
        if (isOutgoing) bubble.insertBefore(side, content);
        else content.insertAdjacentElement('afterend', side);
      } else {
        bubble.appendChild(side);
      }
    } else if (content) {
      if (isOutgoing && side.nextElementSibling !== content) {
        bubble.insertBefore(side, content);
      } else if (!isOutgoing && content.nextElementSibling !== side) {
        content.insertAdjacentElement('afterend', side);
      }
    }

    let moreWrap = side.querySelector('.chat-message__more-wrap');
    let menuAbove = moreWrap?.querySelector('.chat-message__more-menu--above') || null;
    let menuBelow = moreWrap?.querySelector('.chat-message__more-menu--below') || null;
    const deleteHtml = isOutgoing && messageId ? buildChatDeleteHtml(messageId) : '';
    const copy = copyHtml || '';
    const download = downloadHtml || '';
    let aboveHtml = `${copy}${deleteHtml}`;
    let belowHtml = download;
    if (!belowHtml && copy && deleteHtml) {
      aboveHtml = copy;
      belowHtml = deleteHtml;
    }
    const needMenu = !!(aboveHtml.trim() || belowHtml.trim());
    if (needMenu && !moreWrap) {
      const initialMenu = buildChatMoreMenuHtml({
        aboveHtml,
        belowHtml,
      });
      if (initialMenu) side.insertAdjacentHTML('afterbegin', initialMenu);
      moreWrap = side.querySelector('.chat-message__more-wrap');
      menuAbove = moreWrap?.querySelector('.chat-message__more-menu--above') || null;
      menuBelow = moreWrap?.querySelector('.chat-message__more-menu--below') || null;
    }
    // תפריט ישן בלי above/below — משדרגים | HYPER CORE TECH
    if (moreWrap && (!menuAbove || !menuBelow)) {
      const legacy = moreWrap.querySelector('.chat-message__more-menu:not([data-more-slot])');
      const legacyItems = legacy ? legacy.innerHTML : '';
      moreWrap.outerHTML = buildChatMoreMenuHtml({
        aboveHtml: aboveHtml.trim() || legacyItems,
        belowHtml,
      });
      moreWrap = side.querySelector('.chat-message__more-wrap');
      menuAbove = moreWrap?.querySelector('.chat-message__more-menu--above') || null;
      menuBelow = moreWrap?.querySelector('.chat-message__more-menu--below') || null;
    }
    if (menuAbove) {
      if (copy && !menuAbove.querySelector('.chat-message__copy-link') && aboveHtml.includes('copy-link')) {
        menuAbove.insertAdjacentHTML('afterbegin', copy);
      }
      if (deleteHtml && !menuAbove.querySelector('.chat-message__delete') && aboveHtml.includes('chat-message__delete')) {
        menuAbove.insertAdjacentHTML('beforeend', deleteHtml);
      }
      if (deleteHtml && belowHtml.includes('chat-message__delete') && menuBelow && !menuBelow.querySelector('.chat-message__delete') && !menuAbove.querySelector('.chat-message__delete')) {
        menuBelow.insertAdjacentHTML('beforeend', deleteHtml);
      }
      bubble.querySelectorAll(':scope > .chat-message__delete, .chat-message__side-actions > .chat-message__delete').forEach((del) => {
        if (menuAbove.contains(del) || menuBelow?.contains(del)) return;
        if (aboveHtml.includes('chat-message__delete')) menuAbove.appendChild(del);
        else if (menuBelow) menuBelow.appendChild(del);
        else menuAbove.appendChild(del);
      });
    }
    if (menuBelow) {
      bubble.querySelectorAll(
        '.chat-message__image-container .chat-message__media-download, .chat-message__video-container .chat-message__media-download, .chat-media-upload .chat-message__media-download, .chat-message__side-actions > .chat-message__media-download, .chat-file-bubble .chat-message__media-download--side'
      ).forEach((btn) => {
        btn.classList.add('chat-message__media-download--side');
        if (!menuBelow.contains(btn)) menuBelow.appendChild(btn);
      });
      if (download && !menuBelow.querySelector('.chat-message__media-download, .torrent-bubble__download-btn, [data-download-url]')) {
        menuBelow.insertAdjacentHTML('beforeend', download);
      }
    }
    if (!side.querySelector('.chat-message__more-wrap') && !side.childElementCount) {
      side.remove();
      return null;
    }
    return side;
  }

  // חלק תצוגת העלאת מדיה (chat-ui.js) – מפת blob/URL מקומי לפי fileId לתצוגה כמו וואטסאפ | HYPER CORE TECH
  const transferMediaPreviews = new Map();

  function registerChatTransferPreview(fileId, info) {
    if (!fileId || !info) return;
    const prev = transferMediaPreviews.get(fileId);
    transferMediaPreviews.set(fileId, {
      url: info.url || prev?.url || '',
      mime: info.mime || prev?.mime || '',
      name: info.name || prev?.name || '',
      size: info.size || prev?.size || 0,
      posterDataUrl: info.posterDataUrl || prev?.posterDataUrl || '',
    });
  }
  App.registerChatTransferPreview = registerChatTransferPreview;
  App.getChatTransferPreviewPoster = function getChatTransferPreviewPoster(fileId) {
    if (!fileId) return '';
    return transferMediaPreviews.get(fileId)?.posterDataUrl || '';
  };

  function resolveTransferPreview(progress) {
    if (!progress) return { url: '', mime: '', name: '', isVideo: false, isImage: false };
    const cached = transferMediaPreviews.get(progress.fileId) || {};
    const att = state.activeContact ? App.getChatFileAttachment?.(state.activeContact) : null;
    const attMatch = att && (!att.fileId || att.fileId === progress.fileId);
    const url =
      progress.previewUrl ||
      cached.url ||
      (attMatch && (att.previewUrl || att.dataUrl || att.url)) ||
      '';
    const mime = progress.mimeType || progress.type || cached.mime || (attMatch && att.type) || '';
    const name = progress.name || cached.name || (attMatch && att.name) || '';
    const isVideo =
      /^video\//i.test(mime) ||
      /\.(mp4|m4v|mov|webm|mkv|avi|3gp)$/i.test(name);
    const isImage =
      !isVideo &&
      (/^image\//i.test(mime) ||
        /\.(jpe?g|png|gif|webp|bmp|heic)$/i.test(name));
    return { url, mime, name, isVideo, isImage };
  }

  function isOutgoingMediaTransfer(progress) {
    if (!progress || progress.direction === 'receive') return false;
    const preview = resolveTransferPreview(progress);
    return preview.isVideo || preview.isImage;
  }

  // קבצי ZIP/PDF וכו' — כרטיס סופי + מד עגול (שולח ומקבל), בלי torrent-bubble קופץ | HYPER CORE TECH
  function isFileCardTransfer(progress) {
    if (!progress) return false;
    if (progress.isFileCard === true) return true;
    if (progress.isFileCard === false) return false;
    const preview = resolveTransferPreview(progress);
    if (preview.isVideo || preview.isImage) return false;
    const mime = String(progress.mimeType || '').toLowerCase();
    if (mime.startsWith('image/') || mime.startsWith('video/')) return false;
    const name = String(progress.name || '');
    if (/\.(jpe?g|png|gif|webp|bmp|heic|mp4|m4v|mov|webm|mkv|avi|3gp)$/i.test(name)) return false;
    return true;
  }

  function findExistingFileMessageBubble(progress) {
    if (!elements.messagesContainer || !progress) return null;
    const magnet = String(progress.magnetURI || '').trim();
    if (magnet) {
      const nodes = elements.messagesContainer.querySelectorAll('[data-magnet-uri]');
      for (let i = 0; i < nodes.length; i += 1) {
        if (nodes[i].getAttribute('data-magnet-uri') === magnet) return nodes[i];
      }
    }
    const tid = progress.torrentTransferId || progress.fileId;
    if (tid) {
      const byTid = elements.messagesContainer.querySelector(`[data-torrent-transfer="${tid}"]`);
      if (byTid && !byTid.querySelector('.chat-media-upload')) return byTid;
    }
    return null;
  }

  // poster שחור — רק ב־Android WebView (מונע פליי לבן); בווב מציגים את הפריים מיד | HYPER CORE TECH
  const MEDIA_UPLOAD_BLACK_POSTER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  function needsAndroidVideoPlaceholder() {
    try {
      if (window.SosNativeShell) return true;
      const ua = navigator.userAgent || '';
      if (/SOSNativeShell\//i.test(ua)) return true;
      if (/Android/i.test(ua)) return true;
    } catch (_) {}
    return false;
  }

  function bindMediaUploadVideoReveal(bubble) {
    const wrap = bubble?.querySelector?.('.chat-media-upload');
    const mediaEl = bubble?.querySelector?.('video.chat-media-upload__media');
    if (!wrap || !mediaEl || mediaEl.dataset.revealBound === '1') return;
    mediaEl.dataset.revealBound = '1';
    const androidPlaceholder = needsAndroidVideoPlaceholder();
    mediaEl.style.background = '#000';

    if (androidPlaceholder) {
      if (!mediaEl.getAttribute('poster')) mediaEl.setAttribute('poster', MEDIA_UPLOAD_BLACK_POSTER);
      wrap.classList.add('chat-media-upload--pending');
      mediaEl.style.opacity = '0';
      mediaEl.style.visibility = 'hidden';
    } else {
      // ווב: מציגים את הווידאו מיד — בלי מסך שחור על כל ההעלאה | HYPER CORE TECH
      wrap.classList.remove('chat-media-upload--pending');
      mediaEl.removeAttribute('poster');
      mediaEl.style.opacity = '1';
      mediaEl.style.visibility = 'visible';
      mediaEl.preload = 'auto';
    }

    const capturePosterFromVisibleVideo = () => {
      try {
        if (mediaEl.dataset.posterCaptured === '1') return;
        const w = mediaEl.videoWidth;
        const h = mediaEl.videoHeight;
        if (!w || !h || mediaEl.readyState < 2) return;
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 640 / w);
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(mediaEl, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        if (dataUrl && dataUrl.startsWith('data:image') && dataUrl.length > 200) {
          mediaEl.poster = dataUrl;
          mediaEl.dataset.posterCaptured = '1';
          const fileId = bubble.getAttribute('data-transfer-id');
          if (fileId) registerChatTransferPreview(fileId, { posterDataUrl: dataUrl });
        }
      } catch (_) {}
    };

    const reveal = () => {
      const w = mediaEl.videoWidth;
      const h = mediaEl.videoHeight;
      if (!w || !h) return;
      sizeMediaUploadWrap(wrap, w, h);
      wrap.dataset.mediaReady = '1';
      wrap.classList.remove('chat-media-upload--pending');
      mediaEl.classList.add('is-ready');
      mediaEl.style.opacity = '1';
      mediaEl.style.visibility = 'visible';
      capturePosterFromVisibleVideo();
    };

    mediaEl.addEventListener('loadedmetadata', reveal);
    mediaEl.addEventListener('loadeddata', () => {
      reveal();
      capturePosterFromVisibleVideo();
    });
    mediaEl.addEventListener('canplay', () => {
      reveal();
      capturePosterFromVisibleVideo();
    });
    setTimeout(() => {
      if (mediaEl.videoWidth && mediaEl.videoHeight) reveal();
      else if (androidPlaceholder) {
        wrap.classList.remove('chat-media-upload--pending');
        wrap.style.aspectRatio = wrap.style.aspectRatio || '3 / 4';
      }
    }, 4000);
    if (mediaEl.readyState >= 1) reveal();

    // ווב: אם יש כבר תקציר מוכן מראש — שמים אותו מיד | HYPER CORE TECH
    const fileId = bubble.getAttribute('data-transfer-id');
    const readyPoster = fileId ? App.getChatTransferPreviewPoster?.(fileId) : '';
    if (readyPoster && readyPoster.length > 200) {
      mediaEl.poster = readyPoster;
      mediaEl.dataset.posterCaptured = '1';
      if (!androidPlaceholder) {
        wrap.classList.remove('chat-media-upload--pending');
        mediaEl.style.opacity = '1';
        mediaEl.style.visibility = 'visible';
      }
    }
  }

  function buildMediaUploadRingHtml(pct) {
    // טבעת גדולה יותר (~22px) — ברורה יותר למשתמש בזמן העלאה | HYPER CORE TECH
    const r = 9.5;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
    // stroke כ־attribute — WebView לפעמים מתעלם מ־CSS stroke על SVG | HYPER CORE TECH
    return `
      <svg class="chat-media-upload__ring" viewBox="0 0 24 24" aria-hidden="true">
        <circle class="chat-media-upload__ring-bg" cx="12" cy="12" r="${r}" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="2.6"></circle>
        <circle class="chat-media-upload__ring-fg" cx="12" cy="12" r="${r}" fill="none" stroke="#ff2d55" stroke-width="3" stroke-linecap="round"
          stroke-dasharray="${c.toFixed(2)}"
          stroke-dashoffset="${offset.toFixed(2)}"></circle>
      </svg>
    `;
  }

  // מילוי אדום על הספינר המרכזי — בלי לגעת בספינר הלבן עצמו | HYPER CORE TECH
  function mediaUploadSpinnerFillMetrics(pct) {
    const r = 24.5;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
    return { r, c, offset };
  }

  function buildMediaUploadSpinnerFillHtml(pct) {
    const { r, c, offset } = mediaUploadSpinnerFillMetrics(pct);
    return `
      <svg class="chat-media-upload__spinner-fill" viewBox="0 0 52 52" aria-hidden="true">
        <circle class="chat-media-upload__spinner-fill-fg" cx="26" cy="26" r="${r}" fill="none" stroke="#ff2d55" stroke-width="3.2" stroke-linecap="round"
          stroke-dasharray="${c.toFixed(2)}"
          stroke-dashoffset="${offset.toFixed(2)}"></circle>
      </svg>
    `;
  }

  function updateMediaUploadSpinnerFill(host, pct) {
    if (!host) return;
    let fillFg = host.querySelector('.chat-media-upload__spinner-fill-fg');
    if (!fillFg) {
      host.insertAdjacentHTML('beforeend', buildMediaUploadSpinnerFillHtml(pct));
      return;
    }
    const { c, offset } = mediaUploadSpinnerFillMetrics(pct);
    fillFg.setAttribute('stroke-dasharray', c.toFixed(2));
    fillFg.setAttribute('stroke-dashoffset', offset.toFixed(2));
    fillFg.setAttribute('stroke', '#ff2d55');
  }

  function formatMediaUploadPct(pct) {
    return String(Math.max(0, Math.min(100, Math.round(Number(pct) || 0))));
  }

  function buildMediaUploadPctHtml(pct) {
    const n = formatMediaUploadPct(pct);
    const triple = n.length >= 3 ? ' chat-media-upload__pct--triple' : '';
    return `<span class="chat-media-upload__pct${triple}"><span class="chat-media-upload__pct-num">${n}</span><span class="chat-media-upload__pct-sign">%</span></span>`;
  }

  function updateMediaUploadCenterProgress(host, pct) {
    if (!host) return;
    updateMediaUploadSpinnerFill(host, pct);
    const n = formatMediaUploadPct(pct);
    let label = host.querySelector('.chat-media-upload__pct');
    if (!label) {
      host.insertAdjacentHTML('beforeend', buildMediaUploadPctHtml(pct));
      label = host.querySelector('.chat-media-upload__pct');
    }
    if (!label) return;
    const num = label.querySelector('.chat-media-upload__pct-num');
    if (num && num.textContent !== n) {
      num.textContent = n;
      label.classList.remove('chat-media-upload__pct--tick');
      // reflow כדי להפעיל מחדש אנימציית tick | HYPER CORE TECH
      void label.offsetWidth;
      label.classList.add('chat-media-upload__pct--tick');
    }
    label.classList.toggle('chat-media-upload__pct--triple', n.length >= 3);
  }

  // בועות מדיה שהומרו להודעה סופית — לא מוחקים ולא מרנדרים מחדש | HYPER CORE TECH
  const settledMediaTransferIds = new Set();

  function sizeMediaUploadWrap(wrap, w, h) {
    if (!wrap || !w || !h) return;
    if (typeof App.applyChatMediaBoxSize === 'function') {
      const box = App.applyChatMediaBoxSize(wrap, w, h, { force: true });
      if (box) {
        wrap.dataset.mediaReady = '1';
        wrap.classList.toggle('chat-media-upload--portrait', !!box.portrait);
        wrap.classList.toggle('chat-media-upload--landscape', !box.portrait);
      }
      return;
    }
    // fallback אם המודול עדיין לא נטען | HYPER CORE TECH
    const col = wrap.closest?.('.chat-conversation__messages') || document.getElementById('chatMessages');
    const raw = col?.clientWidth || window.innerWidth || 360;
    const narrow = raw < 480;
    const avail = Math.max(200, Math.floor(raw * (narrow ? 0.92 : 0.72)) - (narrow ? 8 : 24));
    const portrait = h > w;
    const maxW = Math.min(avail, portrait ? (narrow ? avail : 300) : (narrow ? avail : 380));
    const maxH = portrait
      ? Math.min(Math.round((window.innerHeight || 640) * (narrow ? 0.72 : 0.7)), narrow ? 640 : 520)
      : Math.min(Math.round((window.innerHeight || 640) * (narrow ? 0.45 : 0.35)), narrow ? 340 : 280);
    let dispW = maxW;
    let dispH = dispW * (h / w);
    if (dispH > maxH) {
      dispH = maxH;
      dispW = dispH * (w / h);
    }
    wrap.style.width = `${Math.round(dispW)}px`;
    wrap.style.height = `${Math.round(dispH)}px`;
    wrap.style.maxWidth = `${Math.round(dispW)}px`;
    wrap.style.maxHeight = `${Math.round(dispH)}px`;
    wrap.style.minWidth = '0';
    wrap.style.minHeight = '0';
    wrap.style.aspectRatio = `${w} / ${h}`;
    wrap.classList.toggle('chat-media-upload--portrait', portrait);
    wrap.classList.toggle('chat-media-upload--landscape', !portrait);
  }

  function settleOutgoingMediaTransfer(message) {
    const fileId = message?.attachment?.fileId;
    if (!fileId || !elements.messagesContainer) return false;
    if (message.direction === 'incoming') return false;
    const a = message.attachment;
    const isVid =
      a?.isVideo === true ||
      (typeof App.isVideoAttachment === 'function' && App.isVideoAttachment(a)) ||
      /^video\//i.test(a?.type || '') ||
      /\.(mp4|m4v|mov|webm|mkv|avi|3gp)$/i.test(a?.name || '');
    const isImg =
      !isVid &&
      ((typeof App.isImageAttachment === 'function' && App.isImageAttachment(a)) ||
        /^image\//i.test(a?.type || '') ||
        /\.(jpe?g|png|gif|webp|bmp|heic)$/i.test(a?.name || ''));
    if (!isVid && !isImg) return false;

    if (settledMediaTransferIds.has(fileId)) {
      return !!elements.messagesContainer.querySelector(`[data-message-id="${message.id}"], [data-p2p-file-id="${fileId}"]`);
    }

    const bubble = elements.messagesContainer.querySelector(`[data-transfer-id="${fileId}"]`);
    if (!bubble?.querySelector?.('.chat-media-upload')) {
      return !!elements.messagesContainer.querySelector(`[data-message-id="${message.id}"]`);
    }

    const wrap = bubble.querySelector('.chat-media-upload');
    const mediaEl = bubble.querySelector('.chat-media-upload__media');
    const messageTimestamp = message.createdAt || Math.floor(Date.now() / 1000);
    const timeLabel = formatMessageTime(messageTimestamp);
    const statusHtml =
      '<span class="chat-message__status chat-message__status--sent" title="נשלח"><i class="fa-solid fa-check-double"></i></span>';

    bubble.className = `chat-message chat-message--outgoing chat-message--media-settled`;
    bubble.setAttribute('data-message-id', message.id);
    bubble.setAttribute('data-p2p-file-id', fileId);
    bubble.setAttribute('data-chat-created', String(messageTimestamp));
    bubble.setAttribute('data-chat-from', String(message.from || App.publicKey || '').toLowerCase());
    bubble.removeAttribute('data-torrent-transfer');

    wrap?.querySelector?.('.chat-media-upload__overlay')?.remove();
    wrap?.querySelector?.('[data-cancel-transfer]')?.remove();
    wrap?.querySelector?.('.chat-media-upload__status')?.remove();
    const footer = wrap?.querySelector?.('.chat-media-upload__footer');
    if (footer) {
      footer.innerHTML = `
        <span class="chat-media-upload__time">${timeLabel}</span>
        <span class="chat-media-upload__ring-slot">${statusHtml}</span>
      `;
    }

    const dl = buildChatMediaSideDownloadHtml(a, a?.url || a?.dataUrl || '', a?.name || '');
    ensureChatSideActions(bubble, {
      isOutgoing: true,
      messageId: message.id,
      downloadHtml: dl,
    });

    const content = bubble.querySelector('.chat-message__content');
    if (content) {
      content.setAttribute('data-chat-message', message.id);
      content.classList.add('chat-message__content--media-upload');
    }

    if (isVid && mediaEl && wrap && wrap.dataset.settleBound !== '1') {
      wrap.dataset.settleBound = '1';
      const src = a.url || mediaEl.currentSrc || mediaEl.src || '';
      const name = a.name || 'video';
      const type = a.type || 'video/mp4';
      const open = (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (typeof App.openVideoLightbox === 'function' && src) {
          App.openVideoLightbox(src, name, type, wrap);
        }
      };
      wrap.style.cursor = 'pointer';
      wrap.addEventListener('click', open);
      mediaEl.style.pointerEvents = 'none';
    } else if (isImg && mediaEl && wrap && wrap.dataset.settleBound !== '1') {
      wrap.dataset.settleBound = '1';
      const name = a.name || 'תמונה';
      wrap.style.cursor = 'pointer';
      wrap.addEventListener('click', (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const src = mediaEl.currentSrc || mediaEl.src || a.url || '';
        if (typeof App.openImageLightbox === 'function' && src) {
          App.openImageLightbox(src, name, wrap);
        }
      });
    }

    if (isVid && mediaEl?.videoWidth && mediaEl?.videoHeight) {
      sizeMediaUploadWrap(wrap, mediaEl.videoWidth, mediaEl.videoHeight);
    } else if (isImg && mediaEl?.naturalWidth && mediaEl?.naturalHeight) {
      sizeMediaUploadWrap(wrap, mediaEl.naturalWidth, mediaEl.naturalHeight);
    }

    settledMediaTransferIds.add(fileId);
    state.transferProgress.delete(fileId);
    return true;
  }

  // חלק settle קובץ ZIP (chat-ui.js) – ממיר בועת העברה לכרטיס הודעה אחד בלי כרטיס שני | HYPER CORE TECH
  function extractMessageMagnet(message) {
    const fromAtt = message?.attachment?.magnetURI || '';
    if (fromAtt) return String(fromAtt).trim();
    const raw = typeof message?.content === 'string' ? message.content.trim() : '';
    if (!raw || raw[0] !== '{') return '';
    try {
      const data = JSON.parse(raw);
      return String(data?.magnetURI || '').trim();
    } catch (_) {
      return '';
    }
  }

  function extractMessageTorrentTransferId(message) {
    const fromAtt = message?.attachment?.fileId || message?.attachment?.id || '';
    if (fromAtt) return String(fromAtt);
    const raw = typeof message?.content === 'string' ? message.content.trim() : '';
    if (!raw || raw[0] !== '{') return '';
    try {
      const data = JSON.parse(raw);
      return String(data?.transferId || '').trim();
    } catch (_) {
      return '';
    }
  }

  function findFileCardTransferBubble({ fileId, magnetURI, transferId } = {}) {
    if (!elements.messagesContainer) return null;
    if (fileId) {
      const byFile = elements.messagesContainer.querySelector(`[data-transfer-id="${fileId}"]`);
      if (byFile?.querySelector?.('.chat-file-upload, .chat-file-bubble')) return byFile;
    }
    if (transferId) {
      const byTid = elements.messagesContainer.querySelector(`[data-torrent-transfer="${transferId}"]`);
      if (byTid?.querySelector?.('.chat-file-upload, .chat-file-bubble')) return byTid;
    }
    const magnet = String(magnetURI || '').trim();
    if (magnet) {
      const nodes = elements.messagesContainer.querySelectorAll('.chat-message--file-card-transfer[data-magnet-uri], [data-magnet-uri]');
      for (let i = 0; i < nodes.length; i += 1) {
        if (nodes[i].getAttribute('data-magnet-uri') === magnet) return nodes[i];
      }
    }
    return null;
  }

  function settleFileCardBubble(bubble, message) {
    if (!bubble || !message) return false;
    const isOutgoing =
      message.direction === 'outgoing' || message.from?.toLowerCase?.() === App.publicKey?.toLowerCase?.();
    const directionClass = isOutgoing ? 'chat-message--outgoing' : 'chat-message--incoming';
    const messageTimestamp = message.createdAt || Math.floor(Date.now() / 1000);
    const timeLabel = formatMessageTime(messageTimestamp);
    const magnet = extractMessageMagnet(message);
    const transferId = extractMessageTorrentTransferId(message);
    const fileId = message?.attachment?.fileId || transferId || bubble.getAttribute('data-transfer-id') || '';
    const a = message.attachment || null;
    const statusHtml = isOutgoing
      ? '<span class="chat-message__status chat-message__status--sent" title="נשלח"><i class="fa-solid fa-check-double"></i></span>'
      : '';

    bubble.className = `chat-message ${directionClass} chat-message--file-card-transfer chat-message--file-card-settled`;
    bubble.setAttribute('data-message-id', message.id);
    if (fileId) {
      bubble.setAttribute('data-transfer-id', fileId);
      bubble.setAttribute('data-p2p-file-id', fileId);
    }
    if (transferId) bubble.setAttribute('data-torrent-transfer', transferId);
    if (magnet) bubble.setAttribute('data-magnet-uri', magnet);
    bubble.setAttribute('data-chat-created', String(messageTimestamp));
    bubble.setAttribute('data-chat-from', String(message.from || App.publicKey || '').toLowerCase());

    const wrap = bubble.querySelector('.chat-file-upload');
    wrap?.querySelector?.('.chat-media-upload__overlay')?.setAttribute('hidden', '');
    wrap?.querySelector?.('[data-cancel-transfer]')?.remove();
    const timeEl = bubble.querySelector('.chat-message__time, .chat-media-upload__time');
    if (timeEl) timeEl.textContent = timeLabel;
    const statusHost = bubble.querySelector('.chat-message__status-slot, .chat-media-upload__ring-slot');
    if (statusHost) statusHost.innerHTML = statusHtml;

    // כפתור הורדה מקומי אם יש blob | HYPER CORE TECH
    const blobUrl =
      (magnet && typeof App.getTorrentBlob === 'function' ? App.getTorrentBlob(magnet)?.url : '') ||
      a?.url ||
      a?.dataUrl ||
      '';
    const dlBtn = bubble.querySelector('.chat-file-bubble__download, .chat-file-bubble__download--busy, .torrent-bubble__download-btn');
    if (dlBtn && (blobUrl || magnet)) {
      const name = a?.name || bubble.querySelector('.chat-file-bubble__name')?.textContent || 'קובץ';
      if (blobUrl) {
        dlBtn.setAttribute('data-download-url', blobUrl);
        dlBtn.removeAttribute('data-magnet');
        dlBtn.className = 'chat-file-bubble__download';
        dlBtn.disabled = false;
        dlBtn.innerHTML = '<i class="fa-solid fa-download" aria-hidden="true"></i>';
        dlBtn.title = 'הורד';
      } else if (magnet && !isOutgoing) {
        dlBtn.setAttribute('data-magnet', magnet);
        dlBtn.setAttribute('data-filename', name);
        dlBtn.className = 'chat-file-bubble__download torrent-bubble__download-btn';
        dlBtn.disabled = false;
        dlBtn.innerHTML = '<i class="fa-solid fa-download" aria-hidden="true"></i>';
      }
    }

    const content = bubble.querySelector('.chat-message__content');
    if (content) {
      content.setAttribute('data-chat-message', message.id);
      content.classList.remove('chat-message__content--file-upload');
    }

    // צד: ⋮ + מחיקה מעל / הורדה מתחת | HYPER CORE TECH
    ensureChatSideActions(bubble, {
      isOutgoing,
      messageId: message.id,
      downloadHtml: buildChatFileSideDownloadHtml({
        attachment: a,
        magnetURI: magnet,
        blobUrl,
        fileName: a?.name || bubble.querySelector('.chat-file-bubble__name')?.textContent || 'קובץ',
      }),
    });

    if (fileId) settledMediaTransferIds.add(fileId);
    if (magnet) settledMediaTransferIds.add(`mag:${magnet}`);
    state.transferProgress.delete(fileId);
    return true;
  }

  function settleOutgoingFileTransfer(message) {
    if (!message || !elements.messagesContainer) return false;
    const magnet = extractMessageMagnet(message);
    const transferId = extractMessageTorrentTransferId(message);
    const fileId = message?.attachment?.fileId || transferId;
    const isFile =
      !!magnet ||
      (message.attachment &&
        typeof App.isGenericFileAttachment === 'function' &&
        App.isGenericFileAttachment(message.attachment)) ||
      /\.(zip|rar|7z|tar|gz|pdf|docx?|xlsx?|txt)$/i.test(message?.attachment?.name || '');
    if (!isFile) return false;

    const settleKey = fileId || (magnet ? `mag:${magnet}` : '');
    const bubble = findFileCardTransferBubble({ fileId, magnetURI: magnet, transferId });
    if (!bubble) return false;

    if (settleKey && settledMediaTransferIds.has(settleKey) && bubble.getAttribute('data-message-id') === String(message.id)) {
      return true;
    }
    return settleFileCardBubble(bubble, message);
  }

  function adoptChatTransferBubble(oldFileId, newFileId) {
    if (!oldFileId || !newFileId || oldFileId === newFileId || !elements.messagesContainer) return false;
    const bubble = elements.messagesContainer.querySelector(`[data-transfer-id="${oldFileId}"]`);
    if (!bubble || bubble.getAttribute('data-message-id')) return false;

    bubble.setAttribute('data-transfer-id', newFileId);
    bubble.querySelectorAll('[data-cancel-transfer]').forEach((btn) => {
      btn.setAttribute('data-cancel-transfer', newFileId);
    });

    const prevProgress = state.transferProgress.get(oldFileId);
    if (prevProgress) {
      state.transferProgress.delete(oldFileId);
      state.transferProgress.set(newFileId, { ...prevProgress, fileId: newFileId });
    }
    const prevPreview = transferMediaPreviews.get(oldFileId);
    if (prevPreview) {
      transferMediaPreviews.delete(oldFileId);
      const existingPreview = transferMediaPreviews.get(newFileId);
      transferMediaPreviews.set(newFileId, {
        url: existingPreview?.url || prevPreview.url || '',
        mime: existingPreview?.mime || prevPreview.mime || '',
        name: existingPreview?.name || prevPreview.name || '',
        size: existingPreview?.size || prevPreview.size || 0,
        posterDataUrl: existingPreview?.posterDataUrl || prevPreview.posterDataUrl || '',
      });
    }
    return true;
  }

  function cleanupOrphanCompressTransferBubbles(keepFileId = null) {
    if (!elements.messagesContainer) return;
    elements.messagesContainer.querySelectorAll('[data-transfer-id^="compress-"]').forEach((el) => {
      const id = el.getAttribute('data-transfer-id');
      if (keepFileId && id === keepFileId) return;
      if (el.getAttribute('data-message-id') || el.getAttribute('data-p2p-file-id')) return;
      el.remove();
      if (id) {
        state.transferProgress.delete(id);
        transferMediaPreviews.delete(id);
      }
    });
  }

  function findOrClaimTransferBubble(fileId) {
    if (!fileId || !elements.messagesContainer) return null;
    const existing = elements.messagesContainer.querySelector(`[data-transfer-id="${fileId}"]`);
    if (existing) return existing;

    // מאמצים בועת דחיסה פתוחה במקום ליצור בועה שנייה לאותו וידאו | HYPER CORE TECH
    const compressBubbles = elements.messagesContainer.querySelectorAll('[data-transfer-id^="compress-"]');
    for (const el of compressBubbles) {
      if (el.getAttribute('data-message-id') || el.getAttribute('data-p2p-file-id')) continue;
      if (!el.querySelector('.chat-media-upload')) continue;
      const oldId = el.getAttribute('data-transfer-id');
      if (adoptChatTransferBubble(oldId, fileId)) {
        cleanupOrphanCompressTransferBubbles(fileId);
        return el;
      }
    }
    return null;
  }

  App.adoptChatTransferBubble = adoptChatTransferBubble;
  App.cleanupOrphanCompressTransferBubbles = cleanupOrphanCompressTransferBubbles;

  function scheduleTransferBubbleCleanup(bubble, progress, ui) {
    // מדיה/קובץ יוצאים או כרטיס קובץ — נשארים כהודעה (settle), בלי מחיקה שגורמת לקפיצה | HYPER CORE TECH
    if (ui.isTerminalOk && (isOutgoingMediaTransfer(progress) || isFileCardTransfer(progress))) {
      state.transferProgress.delete(progress.fileId);
      return;
    }
    if (ui.isTerminalOk) {
      setTimeout(() => {
        if (bubble.isConnected && !bubble.getAttribute('data-message-id')) bubble.remove();
        state.transferProgress.delete(progress.fileId);
        transferMediaPreviews.delete(progress.fileId);
      }, 900);
    } else if (ui.st === 'cancelled') {
      setTimeout(() => {
        if (bubble.isConnected) bubble.remove();
        state.transferProgress.delete(progress.fileId);
        transferMediaPreviews.delete(progress.fileId);
        settledMediaTransferIds.delete(progress.fileId);
      }, 700);
    } else if (ui.st === 'failed') {
      setTimeout(() => {
        state.transferProgress.delete(progress.fileId);
      }, 8000);
    }
  }

  function buildFileCardDownloadButtonHtml(progress, ui) {
    const name = progress.name || 'קובץ';
    const safeName = App.escapeHtml ? App.escapeHtml(name) : name;
    const magnet = String(progress.magnetURI || '').trim();
    const blobUrl =
      progress.blobUrl ||
      (magnet && typeof App.getTorrentBlob === 'function' ? App.getTorrentBlob(magnet)?.url : '') ||
      '';
    if (ui.isTerminalOk && blobUrl) {
      const safeUrl = App.escapeHtml ? App.escapeHtml(blobUrl) : blobUrl.replace(/"/g, '&quot;');
      return `<button type="button" class="chat-file-bubble__download" data-download-url="${safeUrl}" data-filename="${safeName}" title="הורד" aria-label="הורד"><i class="fa-solid fa-download" aria-hidden="true"></i></button>`;
    }
    if (ui.isTerminalOk && magnet) {
      const safeMagnet = App.escapeHtml ? App.escapeHtml(magnet) : magnet.replace(/"/g, '&quot;');
      return `<button type="button" class="chat-file-bubble__download torrent-bubble__download-btn" data-magnet="${safeMagnet}" data-filename="${safeName}" title="הורד" aria-label="הורד"><i class="fa-solid fa-download" aria-hidden="true"></i></button>`;
    }
    // בזמן העברה — מד עגול ברור במקום כפתור הורדה (סגנון וואטסאפ) | HYPER CORE TECH
    return buildFileCardProgressSlotHtml(ui.pct);
  }

  // מד התקדמות בצד הכרטיס — שם הקובץ נשאר קריא | HYPER CORE TECH
  function buildFileCardProgressSlotHtml(pct) {
    const safePct = Math.max(0, Math.min(100, Math.round(pct || 0)));
    return `
      <div class="chat-file-bubble__progress" aria-label="התקדמות ${safePct}%">
        <div class="chat-media-upload__center chat-file-bubble__progress-center" aria-hidden="true">
          <div class="chat-media-upload__spinner"></div>
          ${buildMediaUploadSpinnerFillHtml(safePct)}
          ${buildMediaUploadPctHtml(safePct)}
        </div>
      </div>
    `;
  }

  // אייקון קובץ — בזמן שליחה: X עדין מעל האייקון לביטול | HYPER CORE TECH
  function buildFileCardIconHtml({ fileIcon, iconClass, showCancel, fileId }) {
    const cls = iconClass || `fa-solid ${fileIcon || 'fa-file'}`;
    if (showCancel && fileId) {
      return `
        <button type="button" class="chat-file-bubble__icon chat-file-bubble__icon--cancel" data-cancel-transfer="${fileId}" title="בטל שליחה" aria-label="בטל שליחה">
          <i class="${cls}" aria-hidden="true"></i>
          <span class="chat-file-bubble__icon-x" aria-hidden="true"><i class="fa-solid fa-xmark"></i></span>
        </button>
      `;
    }
    return `<div class="chat-file-bubble__icon"><i class="${cls}" aria-hidden="true"></i></div>`;
  }

  function buildFileCardMetaRowHtml({ nowLabel, statusHtml }) {
    return `
      <div class="chat-message__meta-row chat-file-card__meta">
        <span class="chat-message__time">${nowLabel}</span>
        ${statusHtml ? `<span class="chat-message__status-slot">${statusHtml}</span>` : ''}
      </div>
    `;
  }

  function renderFileCardTransferProgress(progress, existing) {
    const settleKey = progress.fileId || (progress.magnetURI ? `mag:${progress.magnetURI}` : '');
    if (settleKey && settledMediaTransferIds.has(settleKey)) return;

    const ui = resolveTransferAction(progress);
    const isReceive = progress.direction === 'receive';
    const directionClass = isReceive ? 'chat-message--incoming' : 'chat-message--outgoing';
    const label = progress.name || 'קובץ מצורף';
    const safeLabel = App.escapeHtml ? App.escapeHtml(label) : label;
    const sizeLabel = formatTransferSize(progress.size);
    const fileIcon = getTransferFileIcon(label);
    const done = ui.isTerminalOk;
    const failed = ui.st === 'failed' || ui.st === 'cancelled';
    const nowLabel = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    // בלי מד קטן ליד השעה בזמן העברה — רק V בסיום | HYPER CORE TECH
    const statusHtml = done
      ? (isReceive
        ? ''
        : '<span class="chat-message__status chat-message__status--sent" title="נשלח"><i class="fa-solid fa-check-double"></i></span>')
      : (failed
        ? '<i class="fa-solid fa-exclamation-circle chat-media-upload__fail"></i>'
        : '');

    let bubble =
      existing ||
      findFileCardTransferBubble({
        fileId: progress.fileId,
        magnetURI: progress.magnetURI,
        transferId: progress.torrentTransferId,
      }) ||
      findOrClaimTransferBubble(progress.fileId) ||
      findExistingFileMessageBubble(progress);
    bubble = bubble || doc.createElement('div');

    const iconHtml = buildFileCardIconHtml({
      fileIcon,
      showCancel: ui.showCancel,
      fileId: progress.fileId,
    });

    if (
      bubble.isConnected &&
      bubble.getAttribute('data-message-id') &&
      !bubble.querySelector('.chat-file-upload') &&
      bubble.querySelector('.chat-file-bubble, .torrent-bubble')
    ) {
      const content = bubble.querySelector('.chat-message__content') || bubble;
      const name = bubble.querySelector('.chat-file-bubble__name, .torrent-bubble__file-name')?.textContent || label;
      const size = bubble.querySelector('.chat-file-bubble__size, .torrent-bubble__file-size')?.textContent || sizeLabel;
      const iconClass = bubble.querySelector('.chat-file-bubble__icon i:not(.fa-xmark), .torrent-bubble__file-row > i')?.className || `fa-solid ${fileIcon}`;
      content.innerHTML = `
        <div class="chat-file-upload" data-chat-file-upload="1">
          <div class="chat-file-bubble">
            ${buildFileCardIconHtml({ fileIcon, iconClass, showCancel: ui.showCancel, fileId: progress.fileId })}
            <div class="chat-file-bubble__info">
              <div class="chat-file-bubble__name" title="${App.escapeHtml ? App.escapeHtml(name) : name}">${App.escapeHtml ? App.escapeHtml(name) : name}</div>
              <div class="chat-file-bubble__size">${App.escapeHtml ? App.escapeHtml(size || '') : (size || '')}</div>
            </div>
            ${buildFileCardDownloadButtonHtml(progress, ui)}
          </div>
        </div>
        ${buildFileCardMetaRowHtml({ nowLabel, statusHtml })}
      `;
      bubble.classList.add('chat-message--file-card-transfer');
      if (progress.fileId) bubble.setAttribute('data-transfer-id', progress.fileId);
      if (progress.magnetURI) bubble.setAttribute('data-magnet-uri', progress.magnetURI);
    }

    if (bubble.isConnected && bubble.querySelector('.chat-file-upload')) {
      bubble.className = `chat-message ${directionClass} chat-message--file-card-transfer${done ? ' chat-message--file-card-transfer-done' : ''}${failed ? ' chat-message--file-card-transfer-failed' : ''}${bubble.getAttribute('data-message-id') ? ' chat-message--file-card-settled' : ''}`;
      if (progress.fileId) bubble.setAttribute('data-transfer-id', progress.fileId);
      if (progress.torrentTransferId) bubble.setAttribute('data-torrent-transfer', progress.torrentTransferId);
      if (progress.magnetURI) bubble.setAttribute('data-magnet-uri', progress.magnetURI);

      const hasLegacyOverlay = !!bubble.querySelector('.chat-file-upload > .chat-media-upload__overlay');
      const hasSideProgress = !!bubble.querySelector('.chat-file-bubble__progress');
      const hasIconCancel = !!bubble.querySelector('.chat-file-bubble__icon--cancel');
      const hasMetaCancel = !!bubble.querySelector('.chat-file-card__cancel, .chat-message__meta-row [data-cancel-transfer]');
      const hasTinyRing = !!bubble.querySelector('.chat-message__status-slot .chat-media-upload__ring');
      const needsMigrate =
        hasLegacyOverlay ||
        (!done && !failed && !hasSideProgress) ||
        (ui.showCancel && !hasIconCancel) ||
        hasMetaCancel ||
        (hasTinyRing && !done && !failed);
      if (needsMigrate) {
        const content = bubble.querySelector('.chat-message__content') || bubble;
        const nameEl = bubble.querySelector('.chat-file-bubble__name');
        const sizeEl = bubble.querySelector('.chat-file-bubble__size');
        const iconEl = bubble.querySelector('.chat-file-bubble__icon i:not(.fa-xmark)');
        const name = nameEl?.textContent || label;
        const size = sizeEl?.textContent || sizeLabel;
        const iconClass = iconEl?.className || `fa-solid ${fileIcon}`;
        const safeName = App.escapeHtml ? App.escapeHtml(name) : name;
        content.innerHTML = `
          <div class="chat-file-upload" data-chat-file-upload="1">
            <div class="chat-file-bubble">
              ${buildFileCardIconHtml({ fileIcon, iconClass, showCancel: ui.showCancel, fileId: progress.fileId })}
              <div class="chat-file-bubble__info">
                <div class="chat-file-bubble__name" title="${safeName}">${safeName}</div>
                <div class="chat-file-bubble__size">${App.escapeHtml ? App.escapeHtml(size || '') : (size || '')}</div>
              </div>
              ${buildFileCardDownloadButtonHtml(progress, ui)}
            </div>
          </div>
          ${buildFileCardMetaRowHtml({ nowLabel, statusHtml })}
        `;
        scheduleTransferBubbleCleanup(bubble, progress, ui);
        return;
      }

      const statusHost = bubble.querySelector('.chat-message__status-slot');
      const progressCenter = bubble.querySelector('.chat-file-bubble__progress-center');
      const actionHost = bubble.querySelector(
        '.chat-file-bubble__progress, .chat-file-bubble__download, .chat-file-bubble__download--busy, .torrent-bubble__download-btn'
      );
      if (statusHost) {
        if (statusHtml) statusHost.innerHTML = statusHtml;
        else statusHost.remove();
      }
      if (progressCenter && !done && !failed) {
        updateMediaUploadCenterProgress(progressCenter, ui.pct);
      } else if (actionHost) {
        const html = buildFileCardDownloadButtonHtml(progress, ui);
        const wrapEl = doc.createElement('div');
        wrapEl.innerHTML = html.trim();
        const next = wrapEl.firstElementChild;
        if (next) actionHost.replaceWith(next);
      }
      const iconHost = bubble.querySelector('.chat-file-bubble__icon');
      if (iconHost) {
        const iconEl = iconHost.querySelector('i:not(.fa-xmark)');
        const iconClass = iconEl?.className || `fa-solid ${fileIcon}`;
        const wrapEl = doc.createElement('div');
        wrapEl.innerHTML = buildFileCardIconHtml({
          fileIcon,
          iconClass,
          showCancel: ui.showCancel,
          fileId: progress.fileId,
        }).trim();
        const next = wrapEl.firstElementChild;
        if (next) iconHost.replaceWith(next);
      }
      bubble.querySelector('.chat-file-card__cancel')?.remove();
      bubble.querySelector('.chat-file-upload > .chat-media-upload__overlay')?.remove();
      bubble.querySelector('.chat-file-upload > .chat-media-upload__cancel')?.remove();
      scheduleTransferBubbleCleanup(bubble, progress, ui);
      return;
    }

    const downloadHtml = buildFileCardDownloadButtonHtml(progress, ui);
    bubble.className = `chat-message ${directionClass} chat-message--file-card-transfer`;
    bubble.setAttribute('data-transfer-id', progress.fileId);
    if (progress.torrentTransferId) bubble.setAttribute('data-torrent-transfer', progress.torrentTransferId);
    if (progress.magnetURI) bubble.setAttribute('data-magnet-uri', progress.magnetURI);

    bubble.innerHTML = `
      <div class="chat-message__content">
        <div class="chat-file-upload" data-chat-file-upload="1">
          <div class="chat-file-bubble">
            ${iconHtml}
            <div class="chat-file-bubble__info">
              <div class="chat-file-bubble__name" title="${safeLabel}">${safeLabel}</div>
              <div class="chat-file-bubble__size">${sizeLabel || ''}</div>
            </div>
            ${downloadHtml}
          </div>
        </div>
        ${buildFileCardMetaRowHtml({ nowLabel, statusHtml })}
      </div>
    `;

    if (!bubble.isConnected) {
      elements.messagesContainer.appendChild(bubble);
      elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
    }
    scheduleTransferBubbleCleanup(bubble, progress, ui);
  }

  function renderMediaTransferProgress(progress, existing) {
    if (settledMediaTransferIds.has(progress.fileId)) return;
    if (existing?.getAttribute?.('data-message-id') || existing?.getAttribute?.('data-p2p-file-id')) {
      return;
    }
    const ui = resolveTransferAction(progress);
    const preview = resolveTransferPreview(progress);
    if (progress.previewUrl || preview.url) {
      registerChatTransferPreview(progress.fileId, {
        url: progress.previewUrl || preview.url,
        mime: progress.mimeType || preview.mime,
        name: progress.name || preview.name,
        size: progress.size || 0,
      });
    }
    const mediaSrc = (transferMediaPreviews.get(progress.fileId)?.url) || preview.url;
    const isVideo = preview.isVideo;
    const directionClass = 'chat-message--outgoing';
    const bubble = existing || doc.createElement('div');
    const nowLabel = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    const done = ui.isTerminalOk;
    const failed = ui.st === 'failed' || ui.st === 'cancelled';
    const safeSrc = App.escapeHtml ? App.escapeHtml(mediaSrc) : String(mediaSrc || '');

    // עדכון במקום אם כבר יש בועת מדיה | HYPER CORE TECH
    if (existing && existing.querySelector('.chat-media-upload')) {
      bubble.className = `chat-message ${directionClass} chat-message--file-transfer chat-message--media-transfer${done ? ' chat-message--media-transfer-done' : ''}${failed ? ' chat-message--media-transfer-failed' : ''}`;
      const overlay = bubble.querySelector('.chat-media-upload__overlay');
      const ringHost = bubble.querySelector('.chat-media-upload__ring-slot');
      const statusEl = bubble.querySelector('.chat-media-upload__status');
      const mediaEl = bubble.querySelector('.chat-media-upload__media');
      if (mediaEl && mediaSrc && !mediaEl.getAttribute('src') && !mediaEl.querySelector('source')) {
        if (isVideo) {
          mediaEl.innerHTML = `<source src="${safeSrc}">`;
          try { mediaEl.load(); } catch (_) {}
        } else {
          mediaEl.setAttribute('src', mediaSrc);
        }
      }
      if (isVideo) bindMediaUploadVideoReveal(bubble);
      else if (mediaEl && mediaEl.tagName === 'IMG') bindMediaUploadImageReveal(bubble);
      if (overlay) {
        overlay.hidden = done || failed;
        overlay.setAttribute('aria-hidden', done || failed ? 'true' : 'false');
        // עדכון מילוי אדום בלבד — הספינר הלבן נשאר וממשיך להסתובב | HYPER CORE TECH
        let center = overlay.querySelector('.chat-media-upload__center');
        if (!center) {
          const oldSpinner = overlay.querySelector('.chat-media-upload__spinner');
          center = doc.createElement('div');
          center.className = 'chat-media-upload__center';
          center.setAttribute('aria-hidden', 'true');
          if (oldSpinner) center.appendChild(oldSpinner);
          else {
            const spinner = doc.createElement('div');
            spinner.className = 'chat-media-upload__spinner';
            spinner.setAttribute('aria-hidden', 'true');
            center.appendChild(spinner);
          }
          overlay.appendChild(center);
        }
        if (!done && !failed) updateMediaUploadCenterProgress(center, ui.pct);
      }
      if (ringHost) {
        ringHost.innerHTML = done
          ? '<i class="fa-solid fa-check-double chat-media-upload__checks"></i>'
          : (failed ? '<i class="fa-solid fa-exclamation-circle chat-media-upload__fail"></i>' : buildMediaUploadRingHtml(ui.pct));
      }
      if (statusEl) {
        statusEl.textContent = done ? '' : (failed ? (ui.actionText || '') : '');
        statusEl.hidden = !failed;
      }
      let cancelBtn = bubble.querySelector('[data-cancel-transfer]');
      if (!ui.showCancel && cancelBtn) cancelBtn.remove();
      else if (ui.showCancel && !cancelBtn) {
        cancelBtn = doc.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'chat-media-upload__cancel';
        cancelBtn.setAttribute('data-cancel-transfer', progress.fileId);
        cancelBtn.title = 'בטל';
        cancelBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        bubble.querySelector('.chat-media-upload')?.appendChild(cancelBtn);
      }
      scheduleTransferBubbleCleanup(bubble, progress, ui);
      return;
    }

    const androidPlaceholder = needsAndroidVideoPlaceholder();
    const readyPoster = progress.fileId ? (App.getChatTransferPreviewPoster?.(progress.fileId) || '') : '';
    const mediaHtml = isVideo
      ? (androidPlaceholder
        ? `<video class="chat-media-upload__media" preload="auto" muted playsinline webkit-playsinline poster="${MEDIA_UPLOAD_BLACK_POSTER}" style="opacity:0;visibility:hidden;background:#000"${mediaSrc ? ` src="${safeSrc}"` : ''}></video>`
        : `<video class="chat-media-upload__media" preload="auto" muted playsinline webkit-playsinline${readyPoster ? ` poster="${readyPoster}"` : ''} style="opacity:1;visibility:visible;background:#000"${mediaSrc ? ` src="${safeSrc}"` : ''}></video>`)
      : `<img class="chat-media-upload__media" alt=""${mediaSrc ? ` src="${safeSrc}"` : ''} decoding="async">`;

    bubble.className = `chat-message ${directionClass} chat-message--file-transfer chat-message--media-transfer`;
    bubble.setAttribute('data-transfer-id', progress.fileId);
    if (progress.torrentTransferId) {
      bubble.setAttribute('data-torrent-transfer', progress.torrentTransferId);
    }
    bubble.innerHTML = `
      <div class="chat-message__content chat-message__content--media-upload">
        <div class="chat-media-upload${isVideo && androidPlaceholder ? ' chat-media-upload--pending' : ''}" data-chat-media-upload="1">
          ${mediaHtml}
          <div class="chat-media-upload__overlay"${done || failed ? ' hidden' : ''}>
            <div class="chat-media-upload__center" aria-hidden="true">
              <div class="chat-media-upload__spinner"></div>
              ${buildMediaUploadSpinnerFillHtml(ui.pct)}
              ${buildMediaUploadPctHtml(ui.pct)}
            </div>
          </div>
          ${ui.showCancel ? `<button type="button" class="chat-media-upload__cancel" data-cancel-transfer="${progress.fileId}" title="בטל"><i class="fa-solid fa-xmark"></i></button>` : ''}
          <div class="chat-media-upload__footer">
            <span class="chat-media-upload__time">${nowLabel}</span>
            <span class="chat-media-upload__ring-slot">
              ${done
                ? '<i class="fa-solid fa-check-double chat-media-upload__checks"></i>'
                : (failed ? '<i class="fa-solid fa-exclamation-circle chat-media-upload__fail"></i>' : buildMediaUploadRingHtml(ui.pct))}
            </span>
          </div>
          <span class="chat-media-upload__status" ${failed ? '' : 'hidden'}>${failed ? (ui.actionText || '') : ''}</span>
        </div>
      </div>
    `;

    if (!existing) {
      elements.messagesContainer.appendChild(bubble);
      elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
    }
    if (isVideo) bindMediaUploadVideoReveal(bubble);
    else if (!isVideo && preview.isImage) bindMediaUploadImageReveal(bubble);
    scheduleTransferBubbleCleanup(bubble, progress, ui);
  }

  function bindMediaUploadImageReveal(bubble) {
    const wrap = bubble?.querySelector?.('.chat-media-upload');
    const mediaEl = bubble?.querySelector?.('img.chat-media-upload__media');
    if (!wrap || !mediaEl || mediaEl.dataset.revealBound === '1') return;
    mediaEl.dataset.revealBound = '1';
    const reveal = () => {
      const w = mediaEl.naturalWidth;
      const h = mediaEl.naturalHeight;
      if (!w || !h) return;
      sizeMediaUploadWrap(wrap, w, h);
      wrap.dataset.mediaReady = '1';
      wrap.classList.remove('chat-media-upload--pending');
    };
    mediaEl.addEventListener('load', reveal);
    if (mediaEl.complete && mediaEl.naturalWidth) reveal();
  }

  // חלק בועת התקדמות העברה (chat-ui.js) – בועת הודעה בסגנון וואטסאפ עם פס התקדמות + ביטול | HYPER CORE TECH
  function resolveTransferAction(progress) {
    const isReceive = progress.direction === 'receive';
    const pct = Math.max(0, Math.min(100, Math.round((progress.progress || 0) * 100)));
    const st = progress.status;
    const isTerminalFail = st === 'failed' || st === 'cancelled';
    const isTerminalOk = st === 'complete' || st === 'complete-blossom' || st === 'complete-torrent' || st === 'verified';

    let actionText = isReceive ? 'מוריד...' : 'מעלה...';
    let actionIcon = isReceive ? 'fa-cloud-arrow-down' : 'fa-cloud-arrow-up';
    let speedText = `${pct}%`;
    let showProgress = true;
    let showCancel = !isReceive && !isTerminalOk && !isTerminalFail;

    if (st === 'complete' || st === 'complete-blossom' || st === 'verified') {
      actionText = isReceive ? 'התקבל ✓' : 'נשלח ✓';
      actionIcon = 'fa-check';
      showProgress = false;
      showCancel = false;
    } else if (st === 'complete-torrent') {
      actionText = progress.messageSent ? 'נשלח ✓' : 'נשלח';
      actionIcon = 'fa-check';
      showProgress = false;
      showCancel = false;
    } else if (st === 'sent-no-confirm') {
      actionText = 'נשלח';
      actionIcon = 'fa-check';
      showProgress = false;
      showCancel = false;
    } else if (st === 'waiting' || st === 'waiting-peer') {
      actionText = isReceive ? 'מוריד...' : 'ממתין לצד השני...';
      actionIcon = isReceive ? 'fa-cloud-arrow-down' : 'fa-hourglass-half';
      speedText = 'ממתין לחיבור...';
    } else if (st === 'reconnecting') {
      actionText = isReceive ? 'מוריד...' : 'מתחבר מחדש...';
      actionIcon = 'fa-rotate';
      speedText = 'ממתין לחיבור...';
    } else if (st === 'starting') {
      actionText = isReceive ? 'מתחיל הורדה...' : 'מתחיל שליחה...';
      actionIcon = 'fa-spinner fa-spin';
      speedText = 'מכין...';
    } else if (st === 'compressing') {
      actionText = 'דוחס וידאו...';
      actionIcon = 'fa-film';
      speedText = `${pct}%`;
      showCancel = false;
    } else if (st === 'seeding-torrent') {
      const attempt = progress.attempt || 1;
      const max = progress.maxRetries || 3;
      actionText = max > 1 ? `מנסה שוב (${attempt}/${max})` : 'מתחיל שליחה...';
      actionIcon = 'fa-share-nodes';
      speedText = 'ממתין לצד השני...';
    } else if (st === 'retrying-torrent') {
      const attempt = progress.attempt || 1;
      const max = progress.maxRetries || 3;
      actionText = `מנסה שוב (${Math.min(attempt + 1, max)}/${max})`;
      actionIcon = 'fa-rotate-right';
      speedText = 'ממתין...';
    } else if (st === 'uploading-blossom') {
      actionText = 'מעלה...';
      speedText = `${pct}%`;
    } else if (st === 'receiving' || st === 'requesting-resend' || st === 'stalled-requesting-resend') {
      // סטטוס יציב — בלי להחליף ל"ממתין להמשך" שגורם לקפיצות
      actionText = 'מוריד...';
      actionIcon = 'fa-cloud-arrow-down';
      speedText = (st === 'receiving') ? `${pct}%` : (pct > 0 ? `${pct}% · ממתין...` : 'ממתין...');
    } else if (st === 'resending') {
      actionText = 'מנסה שוב...';
      speedText = `${pct}%`;
    } else if (st === 'cancelled') {
      actionText = 'בוטל';
      actionIcon = 'fa-xmark';
      showProgress = false;
      showCancel = false;
    } else if (st === 'failed') {
      const softWait = /offline|peer|connect|timeout|not ready|dc|webtorrent|magnet/i.test(String(progress.error || ''));
      actionText = softWait ? 'ממתין לצד השני...' : (isReceive ? 'ההורדה נכשלה' : 'השליחה נכשלה');
      actionIcon = softWait ? 'fa-hourglass-half' : 'fa-triangle-exclamation';
      speedText = softWait ? 'ניתן לנסות שוב' : (progress.error ? String(progress.error).slice(0, 40) : '');
      showProgress = false;
      showCancel = false;
    } else if (isReceive) {
      actionText = 'מוריד...';
      actionIcon = 'fa-cloud-arrow-down';
      speedText = `${pct}%`;
    } else {
      actionText = pct <= 0 ? 'מתחיל שליחה...' : 'מעלה...';
      speedText = `${pct}%`;
    }

    return { actionText, actionIcon, speedText, showProgress, showCancel, pct, isTerminalOk, isTerminalFail, st };
  }

  function removeIncomingTransferProgressBubble(progress) {
    if (!elements.messagesContainer || !progress) return;
    const ids = [progress.fileId, progress.torrentTransferId].filter(Boolean);
    ids.forEach((id) => {
      elements.messagesContainer.querySelectorAll(`[data-transfer-id="${id}"], [data-torrent-transfer="${id}"]`).forEach((el) => {
        if (el.getAttribute('data-message-id')) return;
        if (!el.classList.contains('chat-message--incoming')) return;
        el.remove();
      });
    });
  }

  function refreshChatAfterIncomingTransferReady(progress) {
    const peer = progress?.peerPubkey || state.activeContact;
    if (!peer) return;
    try {
      renderMessages(peer, { force: true });
    } catch (_) {}
  }

  // מקבל: אין בועת "מוריד..." — ההודעה צצה רק כשהקובץ מוכן, לפי createdAt המקורי | HYPER CORE TECH
  function isIncomingTransferPending(message) {
    if (!message) return false;
    const isOutgoing =
      message.direction === 'outgoing' ||
      message.from?.toLowerCase?.() === App.publicKey?.toLowerCase?.();
    if (isOutgoing) return false;

    const magnet = extractMessageMagnet(message);
    const att = message.attachment || null;
    const src = String(att?.url || att?.dataUrl || '').trim();
    if (src && !src.startsWith('magnet:')) return false;

    if (magnet) {
      const blob = typeof App.getTorrentBlob === 'function' ? App.getTorrentBlob(magnet) : null;
      return !(blob && blob.url);
    }

    if (att?.isTorrent && !src) return true;
    return false;
  }

  function renderTransferProgress(progress) {
    if (!elements.messagesContainer || !progress?.fileId) return;

    // צד מקבל: לא מציגים התקדמות בחלון השיחה (כמו וואטסאפ) | HYPER CORE TECH
    if (progress.direction === 'receive') {
      removeIncomingTransferProgressBubble(progress);
      const done =
        progress.status === 'complete' ||
        progress.status === 'complete-torrent' ||
        progress.status === 'complete-blossom' ||
        progress.status === 'verified';
      if (done) refreshChatAfterIncomingTransferReady(progress);
      return;
    }

    // תמונה/וידאו יוצאים – בועת מדיה כמו וואטסאפ (בלי שם קובץ ופס אחוזים) | HYPER CORE TECH
    if (isOutgoingMediaTransfer(progress)) {
      const existingMedia = findOrClaimTransferBubble(progress.fileId);
      renderMediaTransferProgress(progress, existingMedia);
      return;
    }

    // ZIP/קבצים – כרטיס סופי + מד עגול (שולח ומקבל) | HYPER CORE TECH
    if (isFileCardTransfer(progress)) {
      const existingFile = findOrClaimTransferBubble(progress.fileId);
      renderFileCardTransferProgress(progress, existingFile);
      return;
    }

    const isReceive = progress.direction === 'receive';
    const directionClass = isReceive ? 'chat-message--incoming' : 'chat-message--outgoing';
    const existing = findOrClaimTransferBubble(progress.fileId) ||
      elements.messagesContainer.querySelector(`[data-transfer-id="${progress.fileId}"]`);
    // אם הייתה בועת מדיה והקובץ לא מזוהה יותר כמדיה – ממשיכים להחליף לבועת קובץ
    if (existing?.querySelector('.chat-media-upload') && !isOutgoingMediaTransfer(progress)) {
      existing.remove();
    }
    const bubble = elements.messagesContainer.querySelector(`[data-transfer-id="${progress.fileId}"]`) || doc.createElement('div');
    const label = progress.name || 'קובץ מצורף';
    const safeLabel = App.escapeHtml ? App.escapeHtml(label) : label;
    const sizeLabel = formatTransferSize(progress.size);
    const fileIcon = getTransferFileIcon(label);
    const ui = resolveTransferAction(progress);
    const isWaiting =
      progress.status === 'waiting' ||
      progress.status === 'waiting-peer' ||
      progress.status === 'reconnecting' ||
      progress.status === 'starting' ||
      progress.status === 'compressing' ||
      progress.status === 'seeding-torrent' ||
      (progress.status === 'sending' && ui.pct === 0) ||
      progress.status === 'requesting-resend' ||
      progress.status === 'stalled-requesting-resend';

    // חלק עדכון במקום (chat-ui.js) – מונע קפיצות DOM ע״י עדכון שדות קיימים במקום innerHTML מלא | HYPER CORE TECH
    if (bubble.isConnected && bubble.querySelector('.torrent-bubble')) {
      bubble.className = `chat-message ${directionClass} chat-message--file-transfer chat-message--torrent-transfer${isWaiting ? ' chat-message--torrent-active' : ''}${ui.isTerminalOk ? ' chat-message--torrent-completed' : ''}${ui.st === 'failed' ? ' chat-message--torrent-error' : ''}${ui.st === 'cancelled' ? ' chat-message--torrent-cancelled' : ''}`;
      if (progress.torrentTransferId) bubble.setAttribute('data-torrent-transfer', progress.torrentTransferId);

      const actionEl = bubble.querySelector('.torrent-bubble__action');
      const actionIconEl = bubble.querySelector('.torrent-bubble__header > i');
      const barInner = bubble.querySelector('.torrent-bubble__bar-inner');
      const percentEl = bubble.querySelector('.torrent-bubble__percent');
      const speedEl = bubble.querySelector('.torrent-bubble__speed');
      const progressWrap = bubble.querySelector('.torrent-bubble__progress');
      let cancelBtn = bubble.querySelector('.torrent-bubble__cancel');

      if (actionEl) actionEl.textContent = ui.actionText;
      if (actionIconEl) actionIconEl.className = `fa-solid ${ui.actionIcon}`;
      if (barInner) barInner.style.width = `${ui.pct}%`;
      if (percentEl) percentEl.textContent = `${ui.pct}%`;
      if (speedEl) speedEl.textContent = ui.speedText;

      if (progressWrap) {
        progressWrap.style.display = ui.showProgress ? '' : 'none';
      }
      if (!ui.showCancel && cancelBtn) {
        cancelBtn.remove();
      } else if (ui.showCancel && !cancelBtn) {
        cancelBtn = doc.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'torrent-bubble__cancel';
        cancelBtn.setAttribute('data-cancel-transfer', progress.fileId);
        cancelBtn.title = 'בטל';
        cancelBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        bubble.querySelector('.torrent-bubble')?.appendChild(cancelBtn);
      }

      scheduleTransferBubbleCleanup(bubble, progress, ui);
      return;
    }

    bubble.className = `chat-message ${directionClass} chat-message--file-transfer chat-message--torrent-transfer${isWaiting ? ' chat-message--torrent-active' : ''}${ui.isTerminalOk ? ' chat-message--torrent-completed' : ''}${ui.st === 'failed' ? ' chat-message--torrent-error' : ''}${ui.st === 'cancelled' ? ' chat-message--torrent-cancelled' : ''}`;
    bubble.setAttribute('data-transfer-id', progress.fileId);
    if (progress.torrentTransferId) {
      bubble.setAttribute('data-torrent-transfer', progress.torrentTransferId);
    }

    const nowLabel = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    bubble.innerHTML = `
      <div class="chat-message__content chat-message__content--torrent">
        <div class="torrent-bubble">
          <div class="torrent-bubble__header">
            <i class="fa-solid ${ui.actionIcon}"></i>
            <span class="torrent-bubble__action">${ui.actionText}</span>
          </div>
          <div class="torrent-bubble__file">
            <div class="torrent-bubble__file-row">
              <i class="fa-solid ${fileIcon}"></i>
              <div class="torrent-bubble__file-info">
                <span class="torrent-bubble__file-name">${safeLabel}</span>
                <span class="torrent-bubble__file-size">${sizeLabel}</span>
              </div>
            </div>
          </div>
          <div class="torrent-bubble__progress" style="${ui.showProgress ? '' : 'display:none'}">
            <div class="torrent-bubble__bar">
              <div class="torrent-bubble__bar-inner" style="width:${ui.pct}%"></div>
            </div>
            <div class="torrent-bubble__stats">
              <span class="torrent-bubble__percent">${ui.pct}%</span>
              <span class="torrent-bubble__speed">${ui.speedText}</span>
            </div>
          </div>
          ${ui.showCancel ? `<button type="button" class="torrent-bubble__cancel" data-cancel-transfer="${progress.fileId}" title="בטל"><i class="fa-solid fa-xmark"></i></button>` : ''}
        </div>
        <div class="chat-message__time">${nowLabel}</div>
      </div>
    `;

    if (!bubble.isConnected) {
      elements.messagesContainer.appendChild(bubble);
      elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
    }

    scheduleTransferBubbleCleanup(bubble, progress, ui);
  }

  function subscribeTransferProgress() {
    if (typeof App.subscribeP2PFileProgress === 'function') {
      App.subscribeP2PFileProgress((evt) => {
        const activePeer = (state.activeContact || '').toLowerCase();
        if (evt?.peerPubkey && activePeer && evt.peerPubkey.toLowerCase() !== activePeer) return;
        if (evt?.previewUrl || evt?.mimeType) {
          registerChatTransferPreview(evt.fileId, {
            url: evt.previewUrl || '',
            mime: evt.mimeType || '',
            name: evt.name || '',
            size: evt.size || 0,
          });
        }
        state.transferProgress.set(evt.fileId, evt);
        renderTransferProgress(evt);
      });
    }
    // פונקציית callback לשימוש ב-chat-file-transfer-ui בעת שליחה | HYPER CORE TECH
    App.handleP2PProgressUpdate = (evt) => {
      const activePeer = (state.activeContact || '').toLowerCase();
      if (evt?.peerPubkey && activePeer && evt.peerPubkey.toLowerCase() !== activePeer) return;
      if (evt?.previewUrl || evt?.mimeType) {
        registerChatTransferPreview(evt.fileId, {
          url: evt.previewUrl || '',
          mime: evt.mimeType || '',
          name: evt.name || '',
          size: evt.size || 0,
        });
      }
      state.transferProgress.set(evt.fileId, evt);
      renderTransferProgress(evt);
    };
    App.registerChatTransferPreview = registerChatTransferPreview;
  }

  function handleMessageActions(event) {
    // סגירת תפריט ⋮ בלחיצה מחוץ אליו | HYPER CORE TECH
    if (!event.target.closest('.chat-message__more-wrap')) {
      closeAllChatMessageMenus();
    }

    // חלק ביטול העברה (chat-ui.js) – X בתוך בועת הקובץ כמו בוואטסאפ | HYPER CORE TECH
    const cancelBtn = event.target.closest('.torrent-bubble__cancel, [data-cancel-transfer]');
    if (cancelBtn) {
      event.preventDefault();
      event.stopPropagation();
      const transferBubble = cancelBtn.closest('[data-transfer-id], [data-torrent-transfer]');
      const p2pId = cancelBtn.getAttribute('data-cancel-transfer') || transferBubble?.getAttribute('data-transfer-id');
      const torrentId = transferBubble?.getAttribute('data-torrent-transfer');
      let cancelled = false;
      if (p2pId && typeof App.cancelP2PFile === 'function') {
        cancelled = !!App.cancelP2PFile(p2pId) || cancelled;
      }
      if (torrentId && App.torrentTransfer && typeof App.torrentTransfer.cancelTransfer === 'function') {
        cancelled = !!App.torrentTransfer.cancelTransfer(torrentId) || cancelled;
      }
      if (!cancelled && p2pId && App.torrentTransfer && typeof App.torrentTransfer.cancelTransfer === 'function') {
        App.torrentTransfer.cancelTransfer(p2pId);
      }
      if (transferBubble) {
        const action = transferBubble.querySelector('.torrent-bubble__action');
        if (action) action.textContent = 'בוטל';
        transferBubble.classList.remove('chat-message--torrent-active');
        transferBubble.classList.add('chat-message--torrent-cancelled');
        transferBubble.querySelector('.torrent-bubble__progress')?.remove();
        cancelBtn.remove();
        setTimeout(() => transferBubble.remove(), 800);
      }
      return;
    }

    // חלק הורדת קובץ/מדיה (chat-ui.js) – עדיפות ל-blob מקומי; magnet רק אם אין קובץ אצלך | HYPER CORE TECH
    const fileDownloadBtn = event.target.closest(
      '.torrent-bubble__download-btn, .chat-file-bubble__download[data-download-url], .chat-file-bubble__download[data-magnet], .chat-message__media-download--side[data-magnet], .chat-message__media-download--side[data-download-url]'
    );
    if (fileDownloadBtn) {
      event.preventDefault();
      event.stopPropagation();
      const fileName = fileDownloadBtn.getAttribute('data-filename') || 'file';
      const localUrl =
        fileDownloadBtn.getAttribute('data-download-url') ||
        '';
      const magnetURI = fileDownloadBtn.getAttribute('data-magnet') || '';
      const blobFromMagnet =
        !localUrl && magnetURI && typeof App.getTorrentBlob === 'function'
          ? App.getTorrentBlob(magnetURI)?.url
          : '';
      const saveUrl = localUrl || blobFromMagnet;
      if (saveUrl && typeof App.downloadChatMedia === 'function') {
        App.downloadChatMedia(saveUrl, fileName);
        return;
      }
      if (magnetURI && typeof App.downloadTorrentFile === 'function') {
        if (!fileDownloadBtn.dataset.defaultHtml) {
          fileDownloadBtn.dataset.defaultHtml = fileDownloadBtn.innerHTML;
        }
        fileDownloadBtn.disabled = true;
        fileDownloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        App.downloadTorrentFile(magnetURI, fileName);
      } else if (magnetURI) {
        window.open(magnetURI, '_blank');
      }
      return;
    }

    // חלק ניסיון שוב (chat-ui.js) – טיפול בלחיצה על כפתור retry בבועת כשלון הורדה | HYPER CORE TECH
    const retryBtn = event.target.closest('.torrent-bubble__retry-btn');
    if (retryBtn) {
      event.preventDefault();
      event.stopPropagation();
      const magnetURI = retryBtn.getAttribute('data-retry-magnet');
      const fileName = retryBtn.getAttribute('data-retry-filename') || 'file';
      if (magnetURI && typeof App.downloadTorrentFile === 'function') {
        // הסרת בועת הכשלון והתחלת הורדה מחדש
        const failedBubble = retryBtn.closest('.chat-message--torrent-failed');
        if (failedBubble) failedBubble.remove();
        App.downloadTorrentFile(magnetURI, fileName);
      }
      return;
    }
    
    const moreTarget = event.target.closest('[data-chat-more]');
    if (moreTarget) {
      event.preventDefault();
      event.stopPropagation();
      const wrap = moreTarget.closest('.chat-message__more-wrap');
      if (!wrap) return;
      const willOpen = !wrap.classList.contains('is-open');
      closeAllChatMessageMenus(willOpen ? wrap : null);
      setChatMoreMenusOpen(wrap, willOpen);
      return;
    }

    const copyTarget = event.target.closest('[data-chat-copy-url]');
    if (copyTarget) {
      event.preventDefault();
      event.stopPropagation();
      const url = copyTarget.getAttribute('data-chat-copy-url');
      if (url && typeof App.copyChatLinkToClipboard === 'function') {
        App.copyChatLinkToClipboard(url);
      }
      closeAllChatMessageMenus();
      return;
    }

    const deleteTarget = event.target.closest('[data-chat-delete]');
    if (!deleteTarget || !state.activeContact) {
      if (!event.target.closest('.chat-message__more-menu')) {
        closeAllChatMessageMenus();
      }
      return;
    }
    closeAllChatMessageMenus();
    event.preventDefault();
    const messageId = deleteTarget.getAttribute('data-chat-delete');
    if (!messageId) {
      return;
    }
    showDeleteConfirmDialog(messageId, state.activeContact);
  }

  function isOutgoingChatMessage(message) {
    if (!message) return false;
    if (message.isSystem || message.direction === 'system' || message.systemKind) return false;
    if (message.direction === 'outgoing') return true;
    if (message.direction === 'incoming') return false;
    const self = (App.publicKey || '').toLowerCase();
    return !!(message.from && self && String(message.from).toLowerCase() === self);
  }

  function setConversationClearBusy(busy) {
    const header = elements.conversationHeader;
    if (!header) return;
    header.classList.toggle('is-clearing-chat', !!busy);
    let spin = header.querySelector('.chat-conversation__clear-spinner');
    if (busy) {
      if (!spin) {
        spin = doc.createElement('span');
        spin.className = 'chat-conversation__clear-spinner';
        spin.setAttribute('aria-label', 'מנקה שיחה');
        spin.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
        const identity = header.querySelector('.chat-conversation__identity');
        const meta = identity?.querySelector('.chat-conversation__meta');
        if (meta) meta.insertAdjacentElement('afterend', spin);
        else if (identity) identity.appendChild(spin);
        else header.appendChild(spin);
      }
    } else if (spin) {
      spin.remove();
    }
    const menuBtn = doc.getElementById('chatConversationMenuBtn');
    if (menuBtn) menuBtn.disabled = !!busy;
  }

  function waitMs(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  let clearChatInProgress = false;

  async function clearActiveConversationChat() {
    const peerPubkey = state.activeContact;
    if (!peerPubkey || clearChatInProgress) return;
    clearChatInProgress = true;
    setConversationClearBusy(true);
    try {
      const messages = (typeof App.getChatMessages === 'function' ? App.getChatMessages(peerPubkey) : []) || [];
      const snapshot = Array.isArray(messages) ? messages.slice() : [];
      const outgoing = [];
      const incoming = [];
      snapshot.forEach((message) => {
        if (!message?.id) return;
        if (isOutgoingChatMessage(message)) outgoing.push(message);
        else incoming.push(message);
      });

      // הודעות נכנסות – מחיקה מקומית בלבד (בלי קריאה לריליי) | HYPER CORE TECH
      incoming.forEach((message) => {
        try { App.removeChatMessage?.(peerPubkey, message.id); } catch (_) {}
      });

      // הודעות יוצאות – kind 5 אחת־אחת בקצב יציב (כולל מדיה P2P) | HYPER CORE TECH
      for (let i = 0; i < outgoing.length; i += 1) {
        const message = outgoing[i];
        try {
          if (typeof App.deleteChatMessage === 'function') {
            await App.deleteChatMessage(peerPubkey, message.id);
          } else {
            App.removeChatMessage?.(peerPubkey, message.id);
          }
        } catch (err) {
          console.warn('[CHAT/UI] clear-chat outgoing delete failed', message.id, err);
          try { App.removeChatMessage?.(peerPubkey, message.id); } catch (_) {}
        }
        if (i < outgoing.length - 1) {
          await waitMs(450);
        }
      }

      if (state.activeContact && state.activeContact.toLowerCase() === peerPubkey.toLowerCase()) {
        try { App.ensureDisappearingIntroNotice?.(peerPubkey); } catch (_) {}
        renderMessages(peerPubkey, { force: true });
      }
      renderContacts(true);
    } finally {
      clearChatInProgress = false;
      setConversationClearBusy(false);
    }
  }

  function showClearChatConfirmDialog(peerPubkey) {
    if (!peerPubkey || clearChatInProgress) return;
    const existing = doc.getElementById('chatClearDialog');
    if (existing) existing.remove();
    const dialog = doc.createElement('div');
    dialog.id = 'chatClearDialog';
    dialog.className = 'chat-dialog';
    dialog.innerHTML = `
      <div class="chat-dialog__backdrop"></div>
      <div class="chat-dialog__content" role="dialog" aria-modal="true">
        <h3 class="chat-dialog__title">ניקוי הצ'ט</h3>
        <p class="chat-dialog__message">לנקות את כל ההודעות בשיחה? הודעות יוצאות יימחקו גם אצל הצד השני. הודעות נכנסות יימחקו רק מהמכשיר שלך.</p>
        <div class="chat-dialog__actions">
          <button type="button" class="chat-dialog__btn chat-dialog__btn--cancel">ביטול</button>
          <button type="button" class="chat-dialog__btn chat-dialog__btn--confirm">נקה צ'ט</button>
        </div>
      </div>
    `;
    elements.panel.appendChild(dialog);
    const backdrop = dialog.querySelector('.chat-dialog__backdrop');
    const cancel = dialog.querySelector('.chat-dialog__btn--cancel');
    const confirm = dialog.querySelector('.chat-dialog__btn--confirm');
    const close = () => dialog.remove();
    backdrop?.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    cancel?.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    confirm?.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
      clearActiveConversationChat();
    });
  }

  function formatDisappearingTimerLabel(seconds) {
    if (typeof App.formatDisappearingTimerLabel === 'function') {
      return App.formatDisappearingTimerLabel(seconds);
    }
    const sec = Number(seconds) || 0;
    if (sec <= 0) return 'כבוי';
    if (sec <= 24 * 60 * 60) return '24 שעות';
    if (sec <= 7 * 24 * 60 * 60) return '7 ימים';
    if (sec <= 90 * 24 * 60 * 60) return '90 ימים';
    return `${Math.round(sec / 86400)} ימים`;
  }

  function isSystemChatMessage(message) {
    if (typeof App.isSystemChatMessage === 'function') return App.isSystemChatMessage(message);
    return !!(message && (message.isSystem || message.direction === 'system' || message.systemKind));
  }

  function buildDisappearingSystemMessageEl(message, peerPubkey) {
    const peer = (peerPubkey || state.activeContact || '').toLowerCase();
    const el = doc.createElement('div');
    el.className = 'chat-system-message chat-system-message--disappearing';
    el.setAttribute('role', 'status');
    if (message?.id) el.setAttribute('data-message-id', message.id);
    const raw = typeof message?.content === 'string' ? message.content : '';
    const safe = App.escapeHtml ? App.escapeHtml(raw) : raw;
    const withLink = safe.replace(
      /לחץ כאן\.?$/,
      '<button type="button" class="chat-system-message__link" data-disappearing-settings>לחץ כאן</button>.'
    );
    el.innerHTML = `<i class="fa-regular fa-clock" aria-hidden="true"></i><span>${withLink}</span>`;
    el.querySelector('[data-disappearing-settings]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openDisappearingSettings(peer);
    });
    return el;
  }

  function openDisappearingSettings(peerPubkey) {
    const peer = (peerPubkey || state.activeContact || '').toLowerCase();
    if (!peer) return;
    const existing = doc.getElementById('chatDisappearingSheet');
    if (existing) existing.remove();
    const current = typeof App.getDisappearingTimerSec === 'function'
      ? App.getDisappearingTimerSec(peer)
      : (App.DISAPPEARING_DEFAULT_SEC || 7 * 24 * 60 * 60);
    const options = [
      { value: 24 * 60 * 60, label: '24 שעות' },
      { value: 7 * 24 * 60 * 60, label: '7 ימים' },
      { value: 90 * 24 * 60 * 60, label: '90 ימים' },
      { value: 0, label: 'כבוי' },
    ];
    const sheet = doc.createElement('div');
    sheet.id = 'chatDisappearingSheet';
    sheet.className = 'chat-disappearing-sheet';
    sheet.setAttribute('role', 'presentation');
    sheet.innerHTML = `
      <div class="chat-disappearing-sheet__backdrop"></div>
      <div class="chat-disappearing-sheet__panel" role="document" aria-labelledby="chatDisappearingTitle">
        <div class="chat-disappearing-sheet__header">
          <button type="button" class="chat-disappearing-sheet__close" aria-label="סגור"><i class="fa-solid fa-xmark"></i></button>
          <h3 id="chatDisappearingTitle" class="chat-disappearing-sheet__title">הודעות נעלמות</h3>
        </div>
        <p class="chat-disappearing-sheet__hint">בחר כמה זמן הודעות חדשות יישארו בצ'אט הזה לפני שיימחקו מהמכשיר.</p>
        <div class="chat-disappearing-sheet__options" role="radiogroup" aria-label="טיימר הודעות נעלמות">
          ${options.map((opt) => {
            const isOn = current === opt.value;
            return `<label class="chat-disappearing-sheet__option${isOn ? ' is-selected' : ''}">
              <span>${opt.label}</span>
              <input type="radio" name="disappearingTimer" value="${opt.value}" ${isOn ? 'checked' : ''}>
              <span class="chat-disappearing-sheet__radio" aria-hidden="true"></span>
            </label>`;
          }).join('')}
        </div>
      </div>
    `;
    const host = elements.panel || doc.body;
    host.appendChild(sheet);
    const close = () => sheet.remove();
    sheet.querySelector('.chat-disappearing-sheet__backdrop')?.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
    });
    sheet.querySelector('.chat-disappearing-sheet__close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
    });
    sheet.querySelectorAll('input[name="disappearingTimer"]').forEach((input) => {
      input.addEventListener('change', () => {
        const sec = Math.max(0, Number(input.value) || 0);
        try {
          App.setDisappearingTimerSec?.(peer, sec);
        } catch (_) {}
        close();
        try {
          App.showToast?.(sec > 0 ? `הודעות נעלמות: ${formatDisappearingTimerLabel(sec)}` : 'הודעות נעלמות כבויות');
        } catch (_) {}
      });
    });
  }

  function showAutoCleanDialog() {
    openDisappearingSettings(state.activeContact);
  }

  function showDeleteConfirmDialog(messageId, peerPubkey) {
    const existing = doc.getElementById('chatDeleteDialog');
    if (existing) existing.remove();
    const dialog = doc.createElement('div');
    dialog.id = 'chatDeleteDialog';
    dialog.className = 'chat-dialog';
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
    elements.panel.appendChild(dialog);
    const backdrop = dialog.querySelector('.chat-dialog__backdrop');
    const cancel = dialog.querySelector('.chat-dialog__btn--cancel');
    const confirm = dialog.querySelector('.chat-dialog__btn--confirm');
    const close = () => dialog.remove();
    // חלק מניעת סגירה (chat-ui.js) – stopPropagation מונע סגירת הצ'אט פאנל בלחיצה על הדיאלוג | HYPER CORE TECH
    backdrop?.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    cancel?.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    confirm?.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
      if (typeof App.deleteChatMessage === 'function') {
        App.deleteChatMessage(peerPubkey, messageId).then(() => {
          renderMessages(peerPubkey);
        });
      } else if (typeof App.removeChatMessage === 'function') {
        App.removeChatMessage(peerPubkey, messageId);
        renderMessages(peerPubkey);
      }
    });
  }

  const homeNavButton = doc.querySelector('[data-nav="home"]');

  const elements = {
    launcher: doc.getElementById('chatLauncher'),
    launcherButton: doc.getElementById('chatLauncherButton'),
    launcherBadge: doc.getElementById('chatBadge'),
    panel: doc.getElementById('chatPanel'),
    navButton: doc.getElementById('messagesToggle'),
    badge: doc.getElementById('messagesBadge'),
    closeButton: doc.getElementById('chatCloseButton'),
    contactsList: doc.getElementById('chatContactsList'),
    refreshContacts: doc.getElementById('chatRefreshContacts'),
    searchInput: doc.getElementById('chatSearchInput'),
    backButton: doc.getElementById('chatConversationBack'),
    emptyState: doc.getElementById('chatEmptyState'),
    conversationHeader: doc.getElementById('chatConversationHeader'),
    conversationAvatar: doc.getElementById('chatConversationAvatar'),
    conversationName: doc.getElementById('chatConversationName'),
    conversationStatus: doc.getElementById('chatConversationStatus'),
    messagesContainer: doc.getElementById('chatMessages'),
    composer: doc.getElementById('chatComposer'),
    messageInput: doc.getElementById('chatMessageInput'),
    footer: doc.getElementById('chatPanelFooter'),
    footerItems: doc.querySelectorAll('#chatPanelFooter .chat-footer__item'),
    footerNotificationsBadge: doc.getElementById('chatFooterNotificationsBadge'),
    notificationsSection: doc.getElementById('chatNotifications'),
    notificationsList: doc.getElementById('chatNotificationsList'),
    notificationsEmpty: doc.getElementById('chatNotificationsEmpty'),
    notificationsMarkRead: doc.getElementById('chatNotificationsMarkRead'),
    notificationsToggle: doc.getElementById('notificationsToggle'),
    navSidebarItems: doc.querySelectorAll('.chat-nav-item, .chat-nav-profile'),
    navProfileImg: doc.getElementById('chatNavProfileImg'),
    torrentSendButton: doc.getElementById('chatTorrentSendButton'),
  };

  if ((!elements.navButton && !elements.launcherButton) || !elements.panel) {
    console.warn('Chat UI elements missing');
    return;
  }

  const state = {
    isOpen: false,
    activeContact: null,
    filterText: '',
    footerMode: 'contacts',
    panelMode: 'list',
    notifications: [],
    // חלק צ'אט (chat-ui.js) – עוקב אחרי שאילתות פרופיל ממתינות כדי לא לבצע בקשות כפולות
    pendingProfileFetches: new Set(),
    // חלק צ'אט (chat-ui.js) – ניטור העברות P2P לצורך רינדור בועת התקדמות | HYPER CORE TECH
    transferProgress: new Map(),
    // חלק חיפוש רשת (chat-ui.js) – תוצאות kind:0 מתיבת החיפוש הקיימת | HYPER CORE TECH
    networkSearchResults: [],
    networkSearchToken: 0,
    networkSearchPending: false,
    networkSearchQuery: '',
  };

  let unsubscribeNotifications = null; // חלק צ'אט (chat-ui.js) – מחזיק ביטול הרשמה לעדכוני התרעות עבור ניקוי משאבים
  let notificationSubscribeTimer = null; // חלק צ'אט (chat-ui.js) – טיימר לגיבוי כאשר feed.js נטען מאוחר יותר
  let isRefreshing = false; // חלק רענון (chat-ui.js) – מונע רענון כפול | HYPER CORE TECH

  // חלק סנכרון כפתורי טורנט (chat-ui.js) – מאחד מצב כפתורים לפי סט auto-start והעברות פעילות כדי למנוע מצב תקוע | HYPER CORE TECH
  function syncTorrentDownloadButtons() {
    if (!elements.messagesContainer) return;

    const incomingBtns = elements.messagesContainer.querySelectorAll('.chat-message--incoming .torrent-bubble__download-btn, .chat-message--incoming .chat-file-bubble__download.torrent-bubble__download-btn');
    if (!incomingBtns.length) return;

    const activeMagnets = new Set();
    if (App._autoStartedTorrentMagnets instanceof Set) {
      App._autoStartedTorrentMagnets.forEach((magnetURI) => {
        if (magnetURI) activeMagnets.add(magnetURI);
      });
    }

    if (typeof App.torrentTransfer?.getActiveTransfers === 'function') {
      try {
        const transfers = App.torrentTransfer.getActiveTransfers() || [];
        transfers.forEach((transfer) => {
          const magnetURI = transfer?.magnetURI || '';
          if (!magnetURI) return;
          if (transfer?.type && transfer.type !== 'receive') return;
          const status = String(transfer?.status || '').toLowerCase();
          if (status === 'completed' || status === 'error' || status === 'cancelled' || status === 'rejected') return;
          activeMagnets.add(magnetURI);
        });
      } catch (err) {
        console.warn('[CHAT/UI] syncTorrentDownloadButtons failed to read active transfers', err);
      }
    }

    incomingBtns.forEach((btn) => {
      if (!btn.dataset.defaultHtml) {
        btn.dataset.defaultHtml = btn.innerHTML;
      }

      const magnetURI = btn.getAttribute('data-magnet');
      const localUrl =
        btn.getAttribute('data-download-url') ||
        (magnetURI && typeof App.getTorrentBlob === 'function' ? App.getTorrentBlob(magnetURI)?.url : '');
      // יש קובץ מקומי — כפתור שמירה רגיל, לא מצב "מוריד..." | HYPER CORE TECH
      if (localUrl) {
        btn.setAttribute('data-download-url', localUrl);
        btn.disabled = false;
        if (btn.dataset.defaultHtml) btn.innerHTML = btn.dataset.defaultHtml;
        return;
      }

      const shouldDisable = Boolean(magnetURI && activeMagnets.has(magnetURI));

      if (shouldDisable) {
        btn.disabled = true;
        const hasTextLabel = (btn.dataset.defaultHtml || '').includes('הורד');
        btn.innerHTML = hasTextLabel
          ? '<i class="fa-solid fa-spinner fa-spin"></i> מוריד...'
          : '<i class="fa-solid fa-spinner fa-spin"></i>';
        return;
      }

      btn.disabled = false;
      if (btn.dataset.defaultHtml && btn.innerHTML !== btn.dataset.defaultHtml) {
        btn.innerHTML = btn.dataset.defaultHtml;
      }
    });
  }

  // חלק חשיפה (chat-ui.js) – API גלובלי לסנכרון כפתורי הורדה ממודולים אחרים (למשל WebTorrent) | HYPER CORE TECH
  App.syncTorrentDownloadButtons = syncTorrentDownloadButtons;

  // חלק אופטימיזציה (chat-ui.js) – debounce ו-throttle למניעת עומס ביצועים | HYPER CORE TECH
  function debounce(fn, delay) {
    let timer = null;
    return function(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }
  
  function throttle(fn, limit) {
    let lastCall = 0;
    let pending = null;
    return function(...args) {
      const now = Date.now();
      if (now - lastCall >= limit) {
        lastCall = now;
        fn.apply(this, args);
      } else if (!pending) {
        pending = setTimeout(() => {
          lastCall = Date.now();
          pending = null;
          fn.apply(this, args);
        }, limit - (now - lastCall));
      }
    };
  }
  
  // גרסאות מאופטמות של פונקציות רינדור - throttle למניעת רינדור כפול | HYPER CORE TECH
  let _lastRenderContactsTime = 0;
  const RENDER_CONTACTS_THROTTLE = 300; // מינימום 300ms בין רינדורים

  // חלק רענון שיחות (chat-ui.js) – פונקציה לרענון כל השיחות וההודעות מחדש | HYPER CORE TECH
  async function handleRefreshAllConversations() {
    if (isRefreshing) return;
    isRefreshing = true;
    
    // הצגת אינדיקטור טעינה על כפתור הרענון
    const refreshBtn = elements.refreshContacts;
    if (refreshBtn) {
      refreshBtn.classList.add('is-loading');
      const icon = refreshBtn.querySelector('i');
      if (icon) icon.classList.add('fa-spin');
    }
    
    try {
      // איפוס סנכרון לרצפת 90 יום (לא 0) – מונע משיכת היסטוריה ישנה מהריליי | HYPER CORE TECH
      if (typeof App.setChatLastSyncTs === 'function') {
        const floor = typeof App.getChatRetentionCutoffTs === 'function'
          ? App.getChatRetentionCutoffTs()
          : Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60);
        App.setChatLastSyncTs(floor);
      }
      try { App.pruneExpiredChatHistory?.(); } catch (_) {}
      
      // קריאה לפונקציית הסנכרון מחדש
      if (typeof App.syncChatHistory === 'function') {
        await App.syncChatHistory();
      } else if (typeof App.ensureChatEnabled === 'function') {
        App.ensureChatEnabled();
      }
      
      // רענון רשימת אנשי הקשר
      renderContacts();
      
      // אם יש שיחה פעילה, רענן גם אותה
      if (state.activeContact) {
        renderMessages(state.activeContact);
      }
      
      console.log('[CHAT/UI] Refreshed all conversations');
    } catch (err) {
      console.warn('[CHAT/UI] Failed to refresh conversations', err);
    } finally {
      isRefreshing = false;
      if (refreshBtn) {
        refreshBtn.classList.remove('is-loading');
        const icon = refreshBtn.querySelector('i');
        if (icon) icon.classList.remove('fa-spin');
      }
    }
  }

  const PANEL_MODES = {
    LIST: 'list',
    CONVERSATION: 'conversation',
    NOTIFICATIONS: 'notifications',
  };

  function updatePanelMode(mode) {
    const safeMode = Object.values(PANEL_MODES).includes(mode) ? mode : PANEL_MODES.LIST;
    state.panelMode = safeMode;
    if (!elements.panel) {
      return;
    }
    elements.panel.classList.remove('chat-panel--list-only', 'chat-panel--conversation', 'chat-panel--notifications');
    if (safeMode === PANEL_MODES.CONVERSATION) {
      elements.panel.classList.add('chat-panel--conversation');
    } else if (safeMode === PANEL_MODES.NOTIFICATIONS) {
      elements.panel.classList.add('chat-panel--notifications');
    } else {
      elements.panel.classList.add('chat-panel--list-only');
    }
  }

  // חלק צ'אט (chat-ui.js) – שליטה בסטטוס התפריט התחתון והצדדי בסגנון וואטסאפ
  function setFooterMode(mode) {
    state.footerMode = mode;
    
    // עדכון סרגל תחתון (מובייל)
    if (elements.footerItems?.length) {
      elements.footerItems.forEach((item) => {
        if (item.dataset.chatNav === mode) {
          item.classList.add('is-active');
        } else {
          item.classList.remove('is-active');
        }
      });
    }

    // עדכון סרגל צדדי (דסקטופ)
    if (elements.navSidebarItems?.length) {
      elements.navSidebarItems.forEach((item) => {
        // התעלמות מכפתורי פעולה שאינם טאבים (כמו home או settings אם הם לא מצב)
        if (item.id === 'chatNavHome') return; 
        
        if (item.dataset.chatNav === mode) {
          item.classList.add('is-active');
        } else {
          item.classList.remove('is-active');
        }
      });
    }
  }

  function handleFooterNav(item) {
    const nav = item?.dataset?.chatNav;
    if (!nav) {
      return;
    }
    switch (nav) {
      case 'contacts':
        setFooterMode('contacts');
        state.activeContact = null;
        resetConversationView();
        renderContacts();
        if (!state.isOpen) {
          togglePanel(true);
        }
        break;
      case 'notifications':
        setFooterMode('notifications');
        if (!state.isOpen) {
          togglePanel(true);
        }
        showNotificationsView();
        break;
      case 'home':
        // סגירת שיחות + חזרה לאותו פוסט — בלי ללחוץ בית (שמרענן את הפיד) | HYPER CORE TECH
        setFooterMode('home');
        togglePanel(false);
        if (typeof App.handleHomeButtonAction === 'function') {
          // לא קוראים handleHome אם רק סוגרים צ'אט — רק resume | HYPER CORE TECH
          if (typeof App.resumeCenteredFeedVideo === 'function') App.resumeCenteredFeedVideo();
          else if (typeof window.resumeCenteredFeedVideo === 'function') window.resumeCenteredFeedVideo();
        } else if (typeof App.resumeCenteredFeedVideo === 'function') {
          App.resumeCenteredFeedVideo();
        } else if (typeof window.resumeCenteredFeedVideo === 'function') {
          window.resumeCenteredFeedVideo();
        }
        break;
      case 'profile':
        // חלק פרופיל (chat-ui.js) – פתיחת פרופיל כ־overlay, בלי ניווט מלא | HYPER CORE TECH
        console.log('[CHAT] Profile clicked - opening profile overlay');
        togglePanel(false);
        {
          const profileBtn = doc.querySelector('.primary-nav [data-nav="profile"]');
          if (profileBtn && typeof profileBtn.click === 'function') {
            profileBtn.click();
          } else {
            const profilePanel = doc.getElementById('profilePanel');
            const profileFrame = doc.getElementById('profilePanelFrame');
            if (profilePanel && profileFrame) {
              if (typeof App.pauseAllFeedVideos === 'function') App.pauseAllFeedVideos();
              profileFrame.src = './profile.html?embedded=1';
              profilePanel.hidden = false;
            } else {
              window.location.href = 'profile.html';
            }
          }
        }
        break;
      case 'games':
        // חלק משחקים (chat-ui.js) – פתיחת דף המשחקים | HYPER CORE TECH
        console.log('[CHAT] Games clicked - navigating to games.html');
        window.location.href = 'games.html';
        break;
      default:
        break;
    }
  }

  function formatTimestamp(ts) {
    if (!ts) return '';
    const date = new Date(ts * 1000);
    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    const timePart = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (sameDay) {
      return timePart;
    }
    const datePart = date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
    return `${datePart} ${timePart}`;
  }

  // חלק צ'אט (chat-ui.js) – פורמט זמן להצגה בתוך בועת הודעה (רק שעה:דקה כמו וואטסאפ)
  function formatMessageTime(ts) {
    if (!ts) return '';
    const date = new Date(ts * 1000);
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  // חלק צ'אט (chat-ui.js) – מפתח יום (YYYY-MM-DD) לקיבוץ הודעות והצגת כותרות תאריך דביקות
  function getMessageDayKey(ts) {
    if (!ts) return '';
    const date = new Date(ts * 1000);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // חלק צ'אט (chat-ui.js) – כותרת יום בסגנון וואטסאפ: היום/אתמול/יום בשבוע/תאריך מלא
  function formatMessageDayHeader(ts) {
    if (!ts) return '';
    const date = new Date(ts * 1000);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.round((startOfToday - startOfDate) / 86400000);
    if (diffDays === 0) return 'היום';
    if (diffDays === 1) return 'אתמול';
    if (diffDays >= 2 && diffDays <= 6) {
      return date.toLocaleDateString('he-IL', { weekday: 'long' });
    }
    return date.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  // חלק צ'אט (chat-ui.js) – פורמט זמן לרשימת אנשי קשר בסגנון WhatsApp: היום=שעה, אחרת=אתמול/יום/תאריך
  function formatContactListTimestamp(ts) {
    if (!ts) return '';
    const dayHeader = formatMessageDayHeader(ts);
    if (dayHeader === 'היום') {
      return formatMessageTime(ts);
    }
    return dayHeader;
  }

  // חלק צ'אט (chat-ui.js) – צליל התרעה להודעות נכנסות
  let chatSoundSuppressedUntil = 0;
  function suppressChatSoundsBriefly(ms = 3000) {
    chatSoundSuppressedUntil = Date.now() + Math.max(0, ms);
  }
  try {
    window.addEventListener('sos-native-resume', () => suppressChatSoundsBriefly(3000));
  } catch (_) {}

  function ensureChatMessageAudio() {
    if (chatMessageAudio) return;
    try {
      chatMessageAudio = new window.Audio(CHAT_MESSAGE_SOUND_URL);
      chatMessageAudio.preload = 'auto';
      chatMessageAudio.playsInline = true;
      chatMessageAudio.setAttribute('playsinline', '');
    } catch (err) {
      console.warn('Failed to init chat message audio', err);
    }
  }

  function playChatMessageSound() {
    if (Date.now() < chatSoundSuppressedUntil) return;
    // באפליקציית APK: צליל בממשק רק כשהחלון גלוי; ברקע הצליל מגיע מ-SosRelayWatcher בלבד | HYPER CORE TECH
    if (typeof App.isNativeShell === 'function' && App.isNativeShell()) {
      if (doc.hidden || doc.visibilityState === 'hidden') return;
    }
    ensureChatMessageAudio();
    if (!chatMessageAudio) return;
    try {
      chatMessageAudio.currentTime = 0;
      const p = chatMessageAudio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

  // חלק צ'אט (chat-ui.js) – בקשת הרשאת התרעות (חסכון בבקשות) | HYPER CORE TECH
  function requestChatNotificationPermissionIfNeeded() {
    if (!('Notification' in window)) return;
    try {
      if (window.Notification.permission !== 'default') return;
      const now = Date.now();
      if (chatNotificationPermissionLastRequestedAt && (now - chatNotificationPermissionLastRequestedAt) < 60000) return;
      chatNotificationPermissionLastRequestedAt = now;
      const p = window.Notification.requestPermission();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

  // חלק צ'אט (chat-ui.js) – רישום SW לקבלת התראות במצב ברקע | HYPER CORE TECH
  function registerChatServiceWorkerIfSupported() {
    if (!('serviceWorker' in navigator)) return;
    if (!window.isSecureContext) return;
    try {
      const p = navigator.serviceWorker.register('./service-worker.js', { scope: './' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

  function getChatServiceWorkerRegistration() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    if (!window.isSecureContext) return Promise.resolve(null);
    try {
      return navigator.serviceWorker.getRegistration().catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  // חלק פורמט מדיה להתראות (chat-ui.js) – פורמט הודעות מדיה בעברית להתראות | HYPER CORE TECH
  function formatMessageForNotification(message) {
    const AUDIO_EXTS = /\.(webm|mp3|m4a|ogg|wav|aac)(\?|$)/i;
    const VIDEO_EXTS = /\.(mp4|ogv|mov|avi|mkv|m4v)(\?|$)/i;
    const IMAGE_EXTS = /\.(jpe?g|png|gif|webp|heic|heif|bmp|svg)(\?|$)/i;
    
    const content = typeof message === 'string' ? message : (message?.content || '');
    const attachment = typeof message === 'object' ? message?.attachment : null;
    
    // בדיקת attachment
    if (attachment) {
      const mime = String(attachment.type || '').toLowerCase();
      const name = String(attachment.name || '').toLowerCase();
      const url = String(attachment.url || attachment.dataUrl || '').toLowerCase();
      
      // הודעה קולית
      if (mime.startsWith('audio/') || AUDIO_EXTS.test(name) || AUDIO_EXTS.test(url) || 
          name.includes('voice') || url.includes('voice')) {
        const dur = typeof attachment.duration === 'number' && attachment.duration > 0 ? attachment.duration : null;
        const durationText = dur !== null 
          ? ` (${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')})`
          : '';
        return `🎤 הודעה קולית${durationText}`;
      }
      // וידאו
      if (mime.startsWith('video/') || VIDEO_EXTS.test(name) || VIDEO_EXTS.test(url)) {
        return content ? `📹 ${content}` : '📹 וידאו';
      }
      // תמונה
      if (mime.startsWith('image/') || IMAGE_EXTS.test(name) || IMAGE_EXTS.test(url)) {
        return content ? `📷 ${content}` : '📷 תמונה';
      }
      // קובץ רגיל
      return `📎 ${attachment.name || 'קובץ מצורף'}`;
    }
    
    // בדיקת URL בתוכן
    if (content) {
      const urlMatch = content.match(/(https?:\/\/[^\s]+)/i);
      if (urlMatch) {
        const url = urlMatch[0];
        const remainingText = content.replace(url, '').trim();
        
        if (AUDIO_EXTS.test(url)) return '🎤 הודעה קולית';
        if (VIDEO_EXTS.test(url)) return remainingText ? `📹 ${remainingText}` : '📹 וידאו';
        if (IMAGE_EXTS.test(url)) return remainingText ? `📷 ${remainingText}` : '📷 תמונה';
      }
    }
    
    return content || 'הודעה חדשה';
  }

  // חלק דה-דופליקציה (chat-ui.js) – מניעת התראות כפולות על אותה הודעה | HYPER CORE TECH
  const NOTIFIED_MSG_KEY = 'nostr_notified_chat_messages';
  const MAX_NOTIFIED_IDS = 200;
  // חלק קיבוץ התראות (chat-ui.js) – מנהל מצטבר להתראה אחת עם ספירת הודעות/משתמשים | HYPER CORE TECH
  const aggregateNotificationState = {
    totalMessages: 0,
    peers: new Set(),
    lastPeer: null,
    lastSnippet: '',
    lastName: ''
  };

  function resetAggregateNotificationState() {
    aggregateNotificationState.totalMessages = 0;
    aggregateNotificationState.peers.clear();
    aggregateNotificationState.lastPeer = null;
    aggregateNotificationState.lastSnippet = '';
    aggregateNotificationState.lastName = '';
  }

  function buildAggregateNotificationBody() {
    const usersCount = aggregateNotificationState.peers.size;
    const header = `${aggregateNotificationState.totalMessages} הודעות מ-${usersCount} משתמשים`;
    const tail = aggregateNotificationState.lastSnippet
      ? `\n${aggregateNotificationState.lastName || 'משתמש'}: ${aggregateNotificationState.lastSnippet}`
      : '';
    return `${header}${tail}`;
  }
  
  function getNotifiedMessageIds() {
    try {
      const raw = sessionStorage.getItem(NOTIFIED_MSG_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  
  function markMessageNotified(messageId) {
    if (!messageId) return;
    try {
      const ids = getNotifiedMessageIds();
      if (!ids.includes(messageId)) {
        ids.push(messageId);
        while (ids.length > MAX_NOTIFIED_IDS) ids.shift();
        sessionStorage.setItem(NOTIFIED_MSG_KEY, JSON.stringify(ids));
      }
    } catch {}
  }
  
  function wasMessageNotified(messageId) {
    return messageId && getNotifiedMessageIds().includes(messageId);
  }

  // חלק צ'אט (chat-ui.js) – התראת מערכת על הודעה נכנסת כאשר החלון ברקע/לא בשיחה הפעילה | HYPER CORE TECH
  function showIncomingChatNotification(peerPubkey, message, messageId) {
    try {
      if (!peerPubkey || !message) return;
      
      // חלק דה-דופליקציה (chat-ui.js) – מניעת התראה כפולה על אותה הודעה | HYPER CORE TECH
      if (messageId && wasMessageNotified(messageId)) {
        return;
      }

      const isHidden = !!doc.hidden || doc.visibilityState === 'hidden';
      const hasFocus = typeof doc.hasFocus === 'function' ? doc.hasFocus() : true;
      const activePeer = state.activeContact ? state.activeContact.toLowerCase() : null;
      const normalizedPeer = peerPubkey.toLowerCase();
      const isActivePeer = activePeer && activePeer === normalizedPeer && state.isOpen && hasFocus && !isHidden;
      if (isActivePeer) return;
      
      // סימון ההודעה כ"הותרעה" כדי שלא תופיע שוב
      if (messageId) markMessageNotified(messageId);

      const contact = App.chatState?.contacts?.get(normalizedPeer);
      const name = contact?.name || `משתמש ${peerPubkey.slice(0, 8)}`;
      const picture = contact?.picture || '';
      // חלק התראות מדיה (chat-ui.js) – שימוש בפורמט מדיה בעברית להתראות | HYPER CORE TECH
      const safeSnippet = formatMessageForNotification(message).slice(0, 120);

      // חלק קיבוץ התראות (chat-ui.js) – צבירת ספירה ואיחוד להתראה אחת | HYPER CORE TECH
      aggregateNotificationState.totalMessages += 1;
      aggregateNotificationState.peers.add(normalizedPeer);
      aggregateNotificationState.lastPeer = normalizedPeer;
      aggregateNotificationState.lastSnippet = safeSnippet;
      aggregateNotificationState.lastName = name;

      const openUrl = `${window.location.origin}${window.location.pathname}?chat=${normalizedPeer}`;

      // APK: לא שולחים התראת מערכת מה-Web כלל.
      // ברקע → SosRelayWatcher/FCM; בממשק גלוי → רק צליל מקומי (playChatMessageSound) | HYPER CORE TECH
      if (typeof App.isNativeShell === 'function' && App.isNativeShell()) {
        return;
      }

      if (!('Notification' in window)) return;
      if (window.Notification.permission !== 'granted') return;

      registerChatServiceWorkerIfSupported();

      const baseOptions = {
        body: buildAggregateNotificationBody(),
        tag: 'chat-aggregate',
        renotify: true
      };
      if (picture) baseOptions.icon = picture;
      try { baseOptions.requireInteraction = true; } catch {}

      const swOptions = Object.assign({}, baseOptions, {
        actions: [{ action: 'open', title: "פתח צ'אט" }],
        data: {
          type: 'chat-message-aggregate',
          peerPubkey: normalizedPeer,
          eventId: messageId || '',
          url: openUrl
        }
      });

      getChatServiceWorkerRegistration().then((reg) => {
        if (reg && typeof reg.showNotification === 'function') {
          try {
            const p = reg.showNotification(name, swOptions);
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch {}
          return;
        }
        const n = new window.Notification(name, baseOptions);
        n.onclick = () => {
          try { window.focus(); } catch {}
          openConversationFromNotification(normalizedPeer);
        };
      }).catch(() => {
        try {
          const n = new window.Notification(name, baseOptions);
          n.onclick = () => {
            try { window.focus(); } catch {}
            openConversationFromNotification(normalizedPeer);
          };
        } catch {}
      });
    } catch (err) {
      console.warn('Failed to show chat message notification', err);
    }
  }

  // חלק צ'אט (chat-ui.js) – פתיחת שיחה מתוך הודעת SW | HYPER CORE TECH
  function openConversationFromNotification(peerPubkey) {
    if (!peerPubkey) return;
    const normalized = String(peerPubkey).toLowerCase();
    try {
      if (typeof App.ensureChatContact === 'function') App.ensureChatContact(normalized);
    } catch (_) {}
    if (typeof App.showChatConversation === 'function') {
      App.showChatConversation(normalized);
      return;
    }
    state.activeContact = normalized;
    togglePanel(true);
    renderContacts();
    renderMessages(normalized, { resetLimit: true, force: true });
    updatePanelMode(PANEL_MODES.CONVERSATION);
    App.markChatConversationRead(normalized);
  }

  // חלק צ'אט (chat-ui.js) – טיפול בהודעות מה-SW עבור התראות צ'אט | HYPER CORE TECH
  function handleChatServiceWorkerMessage(event) {
    const data = event && event.data ? event.data : null;
    if (!data) return;
    const type = data.type;
    if (
      type !== 'chat-message-notification-action'
      && type !== 'sos-deeplink'
      && type !== 'missed-call-notification-action'
    ) return;
    // sos-deeplink עם שיחה נכנסת מטופל ב־chat-deeplink / call UI | HYPER CORE TECH
    if (type === 'sos-deeplink' && data.incomingCall) return;
    const peerPubkey = data.peerPubkey || data.chat || null;
    if (!peerPubkey) return;
    try { window.focus(); } catch {}
    openConversationFromNotification(peerPubkey);
  }

  function initChatServiceWorkerMessageHandling() {
    if (!('serviceWorker' in navigator)) return;
    try {
      navigator.serviceWorker.addEventListener('message', handleChatServiceWorkerMessage);
    } catch {}
  }

  // חלק צ'אט (chat-ui.js) – שולף את ההודעה האחרונה האמיתית לצורך תצוגה מקדימה ברשימת אנשי קשר
  function resolveContactLastMessageInfo(contact) {
    const fallbackText = typeof contact?.lastMessage === 'string' ? contact.lastMessage : '';
    const fallbackTs = Number(contact?.lastTimestamp) || 0;
    const pubkey = contact?.pubkey;
    if (!pubkey || typeof App.getChatMessages !== 'function') {
      return { text: fallbackText, ts: fallbackTs };
    }
    const messages = App.getChatMessages(pubkey) || [];
    if (!Array.isArray(messages) || !messages.length) {
      return { text: fallbackText, ts: fallbackTs };
    }
    let last = null;
    let lastTs = -1;
    messages.forEach((m) => {
      const ts = Number(m?.createdAt) || 0;
      if (ts >= lastTs) {
        lastTs = ts;
        last = m;
      }
    });
    if (!last) {
      return { text: fallbackText, ts: fallbackTs };
    }
    
    // חלק זיהוי מדיה (chat-ui.js) – זיהוי סוגי מדיה לתצוגה בסגנון וואטסאפ | HYPER CORE TECH
    const AUDIO_EXTS = /\.(webm|mp3|m4a|ogg|wav|aac)(\?|$)/i;
    const VIDEO_EXTS = /\.(mp4|ogv|mov|avi|mkv|m4v)(\?|$)/i;
    const IMAGE_EXTS = /\.(jpe?g|png|gif|webp|heic|heif|bmp|svg)(\?|$)/i;
    
    // חלק זיהוי מדיה משופר (chat-ui.js) – תומך ב-Blossom URLs שלא מכילים סיומת | HYPER CORE TECH
    function detectMediaType(mime, name, url, attachment) {
      mime = String(mime || '').toLowerCase();
      name = String(name || '').toLowerCase();
      url = String(url || '').toLowerCase();
      
      // אודיו/הודעה קולית - עדיפות: MIME > שם > duration > URL
      const hasDuration = attachment && typeof attachment.duration === 'number' && attachment.duration > 0;
      if (mime.startsWith('audio/') || AUDIO_EXTS.test(name) || name.includes('voice') || hasDuration || AUDIO_EXTS.test(url)) {
        return 'audio';
      }
      // וידאו
      if (mime.startsWith('video/') || VIDEO_EXTS.test(name) || VIDEO_EXTS.test(url)) {
        return 'video';
      }
      // תמונה
      if (mime.startsWith('image/') || IMAGE_EXTS.test(name) || IMAGE_EXTS.test(url)) {
        return 'image';
      }
      return 'file';
    }
    
    // פונקציית עזר לזיהוי מדיה מ-URL בטקסט
    function detectMediaFromUrl(url) {
      if (AUDIO_EXTS.test(url)) return 'audio';
      if (VIDEO_EXTS.test(url)) return 'video';
      if (IMAGE_EXTS.test(url)) return 'image';
      return null;
    }
    
    let text = '';
    let mediaIcon = '';
    const content = typeof last.content === 'string' ? last.content.trim() : '';
    
    // בדיקת attachment
    if (last.attachment) {
      const a = last.attachment;
      const mediaType = detectMediaType(a.type, a.name, a.url || a.dataUrl, a);
      
      if (mediaType === 'audio') {
        // הודעה קולית: 🎤 הודעה קולית (0:15)
        const dur = typeof a.duration === 'number' && a.duration > 0 ? a.duration : null;
        const durationText = dur !== null 
          ? ` (${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')})`
          : '';
        text = `🎤 הודעה קולית${durationText}`;
      } else if (mediaType === 'video') {
        // וידאו: 📹 וידאו או 📹 + טקסט
        mediaIcon = '📹 ';
        text = content ? mediaIcon + content : mediaIcon + 'וידאו';
      } else if (mediaType === 'image') {
        // תמונה: 📷 תמונה או 📷 + טקסט
        mediaIcon = '📷 ';
        text = content ? mediaIcon + content : mediaIcon + 'תמונה';
      } else {
        // קובץ רגיל: 📎 + שם קובץ
        const fileName = typeof a.name === 'string' && a.name ? a.name : 'קובץ מצורף';
        text = '📎 ' + fileName;
      }
    } else if (content) {
      // בדיקה אם יש URL של מדיה בטקסט
      const urlMatch = content.match(/(https?:\/\/[^\s]+)/i);
      if (urlMatch) {
        const mediaType = detectMediaFromUrl(urlMatch[0]);
        const remainingText = content.replace(urlMatch[0], '').trim();
        
        if (mediaType === 'audio') {
          text = '🎤 הודעה קולית';
        } else if (mediaType === 'video') {
          text = remainingText ? '📹 ' + remainingText : '📹 וידאו';
        } else if (mediaType === 'image') {
          text = remainingText ? '📷 ' + remainingText : '📷 תמונה';
        } else {
          text = content;
        }
      } else {
        text = content;
      }
    }
    
    // חלק סטטוס קריאה (chat-ui.js) – מחזיר גם אם ההודעה יוצאת ומה הסטטוס שלה | HYPER CORE TECH
    const isOutgoing = last?.direction === 'outgoing' || last?.from?.toLowerCase?.() === App.publicKey?.toLowerCase?.();
    const status = last?.status || 'sent';
    
    return { text: text || fallbackText, ts: lastTs || fallbackTs, isOutgoing, status };
  }

  let chatEnableRetryHandle = null;
  function ensureChatEnabled() {
    if (!App.pool) {
      if (!chatEnableRetryHandle) {
        chatEnableRetryHandle = setTimeout(() => {
          chatEnableRetryHandle = null;
          ensureChatEnabled();
        }, 600);
      }
      return;
    }
    if (chatEnableRetryHandle) {
      clearTimeout(chatEnableRetryHandle);
      chatEnableRetryHandle = null;
    }
    if (typeof App.restoreChatState === 'function') {
      App.restoreChatState();
    }
    if (typeof App.subscribeToChatEvents === 'function') {
      App.subscribeToChatEvents();
    }
    if (typeof App.bootstrapChatContacts === 'function') {
      App.bootstrapChatContacts();
    }
  }

  // חלק צ'אט (chat-ui.js) – מיקום הפאנל - בדסקטופ נשלט על ידי CSS בלבד | HYPER CORE TECH
  let _viewportRaf = 0;
  let _lastKeyboardInset = 0;

  function computeChatKeyboardInset() {
    const vv = window.visualViewport;
    if (!vv) return 0;
    // פאנל fixed על layout viewport: מודדים רק ירידת גובה.
    // לא מחסרים offsetTop – בזמן פתיחת מקלדת הוא מגיע באיחור ויוצר קפיצה מעל המקלדת ואז חזרה | HYPER CORE TECH
    return Math.max(0, Math.round(window.innerHeight - vv.height));
  }

  function suppressChatKeyboardScrollJump() {
    try {
      if (window.scrollY) window.scrollTo(0, 0);
      if (doc.documentElement) doc.documentElement.scrollTop = 0;
      if (doc.body) doc.body.scrollTop = 0;
    } catch (_) {}
  }

  function positionPanel() {
    if (!elements.panel) {
      return;
    }
    // בדסקטופ (מעל 768px) - ה-CSS קובע את המיקום (כמו פרופיל), לא צריך JavaScript
    if (window.innerWidth > 768) {
      // איפוס כל הסגנונות האינליין כדי שה-CSS יעבוד
      elements.panel.style.left = '';
      elements.panel.style.right = '';
      elements.panel.style.top = '';
      elements.panel.style.bottom = '';
      elements.panel.style.width = '';
      elements.panel.style.maxWidth = '';
      elements.panel.style.height = '';
      elements.panel.style.maxHeight = '';
      elements.panel.style.removeProperty('--chat-keyboard-inset');
      _lastKeyboardInset = 0;
      return;
    }
    // במובייל – פאנל full-screen קבוע; המקלדת מזיזה רק padding דרך CSS var (בלי thrashing של height/top) | HYPER CORE TECH
    elements.panel.style.left = '0px';
    elements.panel.style.right = '0px';
    elements.panel.style.top = '0px';
    elements.panel.style.bottom = '0px';
    elements.panel.style.width = '100%';
    elements.panel.style.maxWidth = '100%';
    elements.panel.style.height = '100%';
    elements.panel.style.maxHeight = '100%';
    const keyboardInset = computeChatKeyboardInset();
    if (keyboardInset !== _lastKeyboardInset) {
      _lastKeyboardInset = keyboardInset;
      elements.panel.style.setProperty('--chat-keyboard-inset', `${keyboardInset}px`);
    }
    if (keyboardInset > 0) {
      suppressChatKeyboardScrollJump();
    }
  }

  function schedulePositionPanel() {
    if (_viewportRaf) return;
    _viewportRaf = requestAnimationFrame(() => {
      _viewportRaf = 0;
      if (state.isOpen) positionPanel();
    });
  }

  function onChatComposerFocusIn(event) {
    if (!state.isOpen || window.innerWidth > 768) return;
    const target = event?.target;
    if (!target) return;
    if (target !== elements.messageInput && !elements.composer?.contains(target)) return;
    // מיד אחרי focus – מסנכרנים inset ומבטלים גלילת דפדפן שמקפיצה את ה-composer | HYPER CORE TECH
    suppressChatKeyboardScrollJump();
    positionPanel();
    schedulePositionPanel();
    window.setTimeout(() => {
      if (!state.isOpen) return;
      suppressChatKeyboardScrollJump();
      positionPanel();
    }, 50);
    window.setTimeout(() => {
      if (!state.isOpen) return;
      suppressChatKeyboardScrollJump();
      positionPanel();
    }, 180);
  }

  function togglePanel(forceOpen) {
    const targetState = typeof forceOpen === 'boolean' ? forceOpen : !state.isOpen;
    // מונע סגירה בטעות בזמן הורדת קובץ (a.click סינתטי) | HYPER CORE TECH
    if (targetState === false && App.__sosSuppressChatOutsideClose) {
      return;
    }
    state.isOpen = targetState;
    if (state.isOpen) {
      // עצירת וידאו בפתיחת פאנל הודעות | HYPER CORE TECH
      if (typeof App.pauseAllFeedVideos === 'function') {
        App.pauseAllFeedVideos();
      }
      elements.panel.removeAttribute('hidden');
      elements.navButton?.setAttribute('aria-pressed', 'true');
      elements.launcherButton?.setAttribute('aria-expanded', 'true');
      positionPanel();
      if (window.innerWidth <= 768) {
        doc.body.classList.add('chat-overlay-open');
      } else {
        doc.body.classList.remove('chat-overlay-open');
      }
      if (state.activeContact) {
        App.markChatConversationRead(state.activeContact);
        renderMessages(state.activeContact);
        updatePanelMode(PANEL_MODES.CONVERSATION);
      } else {
        updatePanelMode(PANEL_MODES.LIST);
        ensureChatEnabled();
        renderContacts(true); // force render בפתיחה ראשונה
      }
    } else {
      if (state.activeContact) {
        App.markChatConversationRead(state.activeContact);
        renderContacts(true);
      }
      elements.panel.setAttribute('hidden', '');
      elements.navButton?.setAttribute('aria-pressed', 'false');
      elements.launcherButton?.setAttribute('aria-expanded', 'false');
      resetConversationView();
      doc.body.classList.remove('chat-overlay-open');
      try {
        if (typeof App.clearSosDeepLinkFlags === 'function') App.clearSosDeepLinkFlags();
      } catch (_) {}
    }
  }

  // חלק מקלדת מובייל (chat-ui.js) – מאזין לשינויי viewport עם rAF (בלי thrashing) | HYPER CORE TECH
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (state.isOpen) schedulePositionPanel();
    });
    window.visualViewport.addEventListener('scroll', () => {
      if (state.isOpen) {
        suppressChatKeyboardScrollJump();
        schedulePositionPanel();
      }
    });
  }
  doc.addEventListener('focusin', onChatComposerFocusIn, true);

  function renderChatBadge(unreadTotal) {
    const badges = [elements.badge, elements.launcherBadge].filter(Boolean);
    if (!badges.length) {
      return;
    }
    const count = Number(unreadTotal) || 0;
    badges.forEach((badge) => {
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.removeAttribute('hidden');
      } else {
        badge.setAttribute('hidden', '');
      }
    });
  }

  function updateFooterNotificationsBadge(notifications) {
    if (!elements.footerNotificationsBadge) {
      return;
    }
    const unreadCount = Array.isArray(notifications)
      ? notifications.reduce((total, entry) => (!entry?.read ? total + 1 : total), 0)
      : 0;
    if (unreadCount > 0) {
      elements.footerNotificationsBadge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      elements.footerNotificationsBadge.removeAttribute('hidden');
    } else {
      elements.footerNotificationsBadge.setAttribute('hidden', '');
    }
  }

  function handleNotificationItemClick(notification) {
    if (!notification) {
      return;
    }
    if (notification.postId) {
      const target = doc.querySelector(`[data-post-id="${notification.postId}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('feed-post--highlight');
        window.setTimeout(() => target.classList.remove('feed-post--highlight'), 2000);
      }
    }
    if (notification.id && typeof App.markNotificationRead === 'function') {
      App.markNotificationRead(notification.id);
    }
  }

  function createNotificationElement(notification) {
    const item = doc.createElement('li');
    item.className = 'chat-notifications__item';
    if (!notification?.read) {
      item.classList.add('chat-notifications__item--unread');
    }
    if (notification?.id) {
      item.dataset.notificationId = notification.id;
    }
    if (notification?.postId) {
      item.dataset.postId = notification.postId;
    }
    const profile = notification?.actorProfile || {};
    const actorNameRaw = profile.name || notification?.actorPubkey?.slice?.(0, 8) || 'משתמש';
    const actorName = App.escapeHtml ? App.escapeHtml(actorNameRaw) : actorNameRaw;
    const initialsValue = profile.initials || (typeof App.getInitials === 'function' ? App.getInitials(actorNameRaw) : 'מש');
    const initials = App.escapeHtml ? App.escapeHtml(initialsValue) : initialsValue;
    const avatarHtml = profile.picture
      ? `<img src="${profile.picture}" alt="${actorName}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentElement && (this.parentElement.innerHTML='<span>${initials}</span>');">`
      : `<span>${initials}</span>`;
    const actionText = notification?.type === 'comment' ? 'הגיב לפוסט שלך' : 'אהב את הפוסט שלך';
    const safeAction = App.escapeHtml ? App.escapeHtml(actionText) : actionText;
    const snippetSource = notification?.type === 'comment' && notification?.content ? notification.content : '';
    const safeSnippet = snippetSource && App.escapeHtml ? App.escapeHtml(snippetSource) : snippetSource;
    const snippetHtml = safeSnippet ? `<p class="chat-notifications__snippet">${safeSnippet.replace(/\n/g, '<br>')}</p>` : '';
    const timeLabel = notification?.createdAt ? formatTimestamp(notification.createdAt) : '';
    const timeHtml = timeLabel ? `<time class="chat-notifications__time">${timeLabel}</time>` : '';
    item.innerHTML = `
      <div class="chat-notifications__avatar">${avatarHtml}</div>
      <div class="chat-notifications__content">
        <span class="chat-notifications__actor">${actorName}</span>
        <span class="chat-notifications__action">${safeAction}</span>
        ${snippetHtml}
        ${timeHtml}
      </div>
    `;
    item.addEventListener('click', () => handleNotificationItemClick(notification));
    return item;
  }

  function renderNotificationsList(notifications) {
    if (!elements.notificationsList || !elements.notificationsEmpty) {
      return;
    }
    const records = Array.isArray(notifications) ? notifications : [];
    if (!records.length) {
      elements.notificationsEmpty.removeAttribute('hidden');
      elements.notificationsList.innerHTML = '';
      return;
    }
    elements.notificationsEmpty.setAttribute('hidden', '');
    const fragment = doc.createDocumentFragment();
    records.forEach((notification) => {
      fragment.appendChild(createNotificationElement(notification));
    });
    elements.notificationsList.innerHTML = '';
    elements.notificationsList.appendChild(fragment);
  }

  function showNotificationsView() {
    state.activeContact = null;
    if (typeof App.getNotificationsSnapshot === 'function') {
      state.notifications = App.getNotificationsSnapshot();
    }
    elements.notificationsSection?.removeAttribute('hidden');
    elements.emptyState?.setAttribute('hidden', '');
    elements.conversationHeader?.setAttribute('hidden', '');
    elements.composer?.setAttribute('hidden', '');
    elements.messagesContainer?.setAttribute('hidden', '');
    updatePanelMode(PANEL_MODES.NOTIFICATIONS);
    renderNotificationsList(state.notifications);
    if (typeof App.markAllNotificationsRead === 'function') {
      App.markAllNotificationsRead();
    }
  }

  function ensureNotificationSubscription() {
    if (unsubscribeNotifications) {
      return;
    }
    if (typeof App.subscribeNotifications !== 'function') {
      if (!notificationSubscribeTimer) {
        notificationSubscribeTimer = setTimeout(() => {
          notificationSubscribeTimer = null;
          ensureNotificationSubscription();
        }, 400);
      }
      return;
    }
    try {
      unsubscribeNotifications = App.subscribeNotifications((snapshot) => {
        state.notifications = Array.isArray(snapshot) ? snapshot : [];
        updateFooterNotificationsBadge(state.notifications);
        if (state.panelMode === PANEL_MODES.NOTIFICATIONS) {
          renderNotificationsList(state.notifications);
        }
      });
    } catch (err) {
      console.warn('Chat notifications subscription failed', err);
    }
    if (typeof App.getNotificationsSnapshot === 'function') {
      state.notifications = App.getNotificationsSnapshot();
      updateFooterNotificationsBadge(state.notifications);
    }
  }

  function maybeFetchContactProfile(pubkey, contact) {
    if (!pubkey || typeof App.fetchProfile !== 'function') {
      return;
    }
    const normalized = pubkey.toLowerCase();
    const alreadyFetching = state.pendingProfileFetches.has(normalized);
    const hasPicture = Boolean(contact?.picture);
    const name = contact?.name || '';
    const isFallbackName = !name || name.startsWith('משתמש ');
    
    // תמיד לנסות לטעון פרופיל אם השם הוא fallback
    if (alreadyFetching) {
      return;
    }
    // אם יש תמונה ושם אמיתי - לא צריך לטעון
    if (hasPicture && !isFallbackName) {
      return;
    }
    state.pendingProfileFetches.add(normalized);
    Promise.resolve()
      .then(() => App.fetchProfile(normalized))
      .then((profile) => {
        if (!profile) {
          return;
        }
        const normalizedProfile = {
          name: profile.name || `משתמש ${normalized.slice(0, 8)}`,
          picture: profile.picture || '',
          initials:
            profile.initials ||
            (typeof App.getInitials === 'function' ? App.getInitials(profile.name || '') : 'מש'),
          lastReadTimestamp: contact?.lastReadTimestamp || 0,
        };
        App.ensureChatContact(normalized, normalizedProfile);
        // רינדור מחדש של רשימת אנשי הקשר אחרי עדכון הפרופיל | HYPER CORE TECH
        renderContacts(true);
      })
      .catch((err) => {
        console.warn('Chat profile fetch failed', err);
      })
      .finally(() => {
        state.pendingProfileFetches.delete(normalized);
      });
  }

  function buildContactHtml(contact) {
    // חלק צ'אט (chat-ui.js) – בונה פריט רשימת אנשי קשר עם אווטרים, שם ותצוגה מקדימה
    const rawName = contact.name || `משתמש ${contact.pubkey.slice(0, 8)}`;
    const safeName = App.escapeHtml ? App.escapeHtml(rawName) : rawName;
    const initialsValue = contact.initials || (typeof App.getInitials === 'function' ? App.getInitials(rawName) : 'מש');
    const safeInitials = App.escapeHtml ? App.escapeHtml(initialsValue) : initialsValue;
    const lastInfo = resolveContactLastMessageInfo(contact);
    const previewSource = lastInfo.text
      ? lastInfo.text.replace(/\s+/g, ' ').trim().slice(0, 60)
      : 'אין הודעות עדיין';
    const safePreview = App.escapeHtml ? App.escapeHtml(previewSource) : previewSource;
    // חלק צ'אט (chat-ui.js) – תצוגת זמן הודעה אחרונה ברשימת אנשי קשר בסגנון WhatsApp | HYPER CORE TECH
    const timeLabel = lastInfo.ts ? formatContactListTimestamp(lastInfo.ts) : '';
    const timeHtml = timeLabel ? `<span class="chat-contact__time">${timeLabel}</span>` : '';
    const badgeHtml = contact.unreadCount
      ? `<span class="chat-contact__badge">${contact.unreadCount > 99 ? '99+' : contact.unreadCount}</span>`
      : '';
    const activeClass = state.activeContact === contact.pubkey ? ' chat-contact--active' : '';
    const avatarHtml = contact.picture
      ? `<span class="chat-contact__avatar" title="${safeName}"><img src="${contact.picture}" alt="${safeName}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('chat-contact__avatar--initials'); this.parentElement.textContent='${safeInitials}'; this.remove();"></span>`
      : `<span class="chat-contact__avatar chat-contact__avatar--initials" title="${safeName}">${safeInitials}</span>`;

    // חלק סטטוס קריאה (chat-ui.js) – הוספת וי לרשימת אנשי קשר כמו וואטסאפ (אייקוני FontAwesome זהים לשיחה) | HYPER CORE TECH
    let statusCheckHtml = '';
    if (lastInfo.isOutgoing) {
      const status = lastInfo.status || 'sent';
      if (status === 'read') {
        // וי כפול ירוק - נקרא (אייקון FontAwesome כמו בשיחה)
        statusCheckHtml = '<span class="chat-contact__status chat-contact__status--read"><i class="fa-solid fa-check-double"></i></span>';
      } else if (status === 'sent') {
        // וי כפול אפור - נשלח (אייקון FontAwesome כמו בשיחה)
        statusCheckHtml = '<span class="chat-contact__status chat-contact__status--sent"><i class="fa-solid fa-check-double"></i></span>';
      } else if (status === 'sending') {
        // שעון - בשליחה (אייקון FontAwesome כמו בשיחה)
        statusCheckHtml = '<span class="chat-contact__status chat-contact__status--sending"><i class="fa-solid fa-clock"></i></span>';
      }
    }

    return `
      <article class="chat-contact${activeClass}" data-chat-contact="${contact.pubkey}">
        ${avatarHtml}
        <div class="chat-contact__body">
          <div class="chat-contact__row">
            <span class="chat-contact__name">${safeName}</span>
            ${timeHtml}
          </div>
          <div class="chat-contact__row chat-contact__row--sub">
            <span class="chat-contact__last-message">${statusCheckHtml}${safePreview}</span>
            ${badgeHtml}
          </div>
        </div>
      </article>
    `;
  }

  function updateSearchLoadingUI() {
    const searchWrap = elements.searchInput?.closest?.('.chat-contacts__search');
    if (!searchWrap) return;
    const searching = Boolean(state.networkSearchPending) && state.filterText.trim().length >= 2;
    searchWrap.classList.toggle('is-searching', searching);
  }

  function buildNetworkSearchLoadingHtml() {
    return `
      <div class="chat-contacts__search-loading" role="status" aria-live="polite">
        <span class="chat-contacts__search-spinner" aria-hidden="true"></span>
        <span>מחפש משתמשים ברשת…</span>
      </div>
    `;
  }

  function renderContacts(force = false) {
    if (!elements.contactsList) return;
    
    // חלק אופטימיזציה (chat-ui.js) – מניעת רינדור כפול עם throttle | HYPER CORE TECH
    const now = Date.now();
    if (!force && now - _lastRenderContactsTime < RENDER_CONTACTS_THROTTLE) {
      return;
    }
    _lastRenderContactsTime = now;
    updateSearchLoadingUI();
    
    const contacts = typeof App.getChatContacts === 'function' ? App.getChatContacts() : [];
    const unreadTotal = contacts.reduce((sum, item) => sum + (item?.unreadCount || 0), 0);
    renderChatBadge(unreadTotal);
    const normalizedFilter = state.filterText.trim().toLowerCase();
    const filteredContacts = normalizedFilter
      ? contacts.filter((contact) => {
          const label = (contact.name || contact.pubkey || '').toLowerCase();
          const preview = (contact.lastMessage || '').toLowerCase();
          return label.includes(normalizedFilter) || preview.includes(normalizedFilter);
        })
      : contacts;

    // חלק חיפוש רשת (chat-ui.js) – ממזג אנשי קשר מקומיים עם תוצאות שם מהרשת | HYPER CORE TECH
    const localKeys = new Set(
      filteredContacts.map((c) => String(c?.pubkey || '').toLowerCase()).filter(Boolean)
    );
    const networkHits = normalizedFilter.length >= 2
      ? (state.networkSearchResults || []).filter((hit) => {
          const pk = String(hit?.pubkey || '').toLowerCase();
          return pk && !localKeys.has(pk);
        })
      : [];
    const displayList = filteredContacts.concat(networkHits);
    const isNetworkSearching = state.networkSearchPending && normalizedFilter.length >= 2;

    if (!displayList.length) {
      if (normalizedFilter && isNetworkSearching) {
        elements.contactsList.innerHTML = `
          <div class="chat-contacts__empty chat-contacts__empty--searching" role="status" aria-live="polite">
            <span class="chat-contacts__search-spinner" aria-hidden="true"></span>
            <span>מחפש משתמשים ברשת…</span>
          </div>
        `;
        return;
      }
      let message = 'עוד אין שיחות. שלח הודעה ראשונה.';
      if (normalizedFilter) {
        message = 'לא נמצאו תוצאות התואמות לחיפוש.';
      } else if (contacts.length) {
        message = 'לא נמצאו תוצאות התואמות לחיפוש.';
      }
      elements.contactsList.innerHTML = `<p class="chat-contacts__empty">${message}</p>`;
      return;
    }
    const fragment = doc.createDocumentFragment();
    displayList.forEach((contact) => {
      maybeFetchContactProfile(contact.pubkey, contact);
      const wrapper = doc.createElement('div');
      wrapper.innerHTML = buildContactHtml(contact);
      fragment.appendChild(wrapper.firstElementChild);
    });
    elements.contactsList.innerHTML = '';
    elements.contactsList.appendChild(fragment);
    if (isNetworkSearching) {
      const loadingWrap = doc.createElement('div');
      loadingWrap.innerHTML = buildNetworkSearchLoadingHtml();
      if (loadingWrap.firstElementChild) {
        elements.contactsList.appendChild(loadingWrap.firstElementChild);
      }
    }
  }

  // חלק חיפוש רשת (chat-ui.js) – שאילתת שם בריליים דרך תיבת החיפוש הקיימת | HYPER CORE TECH
  async function runNetworkContactSearch(query) {
    const token = ++state.networkSearchToken;
    const q = String(query || '').trim();
    if (q.length < 2) {
      state.networkSearchResults = [];
      state.networkSearchPending = false;
      state.networkSearchQuery = '';
      updateSearchLoadingUI();
      renderContacts(true);
      return;
    }
    if (typeof App.searchProfilesByName !== 'function') {
      state.networkSearchResults = [];
      state.networkSearchPending = false;
      updateSearchLoadingUI();
      renderContacts(true);
      return;
    }
    state.networkSearchPending = true;
    state.networkSearchQuery = q;
    updateSearchLoadingUI();
    renderContacts(true);
    try {
      const results = await App.searchProfilesByName(q, { limit: 20 });
      if (token !== state.networkSearchToken) return;
      state.networkSearchResults = Array.isArray(results) ? results : [];
    } catch (err) {
      console.warn('[CHAT/UI] network name search failed', err);
      if (token !== state.networkSearchToken) return;
      state.networkSearchResults = [];
    } finally {
      if (token === state.networkSearchToken) {
        state.networkSearchPending = false;
        updateSearchLoadingUI();
        renderContacts(true);
      }
    }
  }

  // חלק throttle (chat-ui.js) – מניעת renderMessages חוזר מהיר (500ms מינימום) | HYPER CORE TECH
  let _lastRenderMsgTime = 0;
  let _pendingRenderMsg = null;
  const RENDER_MSG_THROTTLE = 180;
  const INITIAL_VISIBLE_MESSAGES = 100;
  let _visibleMessageLimit = INITIAL_VISIBLE_MESSAGES;
  let _renderMessagesPeer = '';

  // חלק בקרה UI טורנט (chat-ui.js) – ה-UI לא מתחיל הורדות היסטוריות בעצמו, רק מציג מצב לפי מנוע ההעברה | HYPER CORE TECH

  function isSimpleChatMessage(message) {
    if (!message) return false;
    if (message.attachment) return false;
    const raw = typeof message.content === 'string' ? message.content.trim() : '';
    if (!raw) return true;
    if (raw.startsWith('{') && (raw.includes('torrent-transfer-request') || raw.includes('magnetURI') || raw.includes('infoHash'))) {
      return false;
    }
    if (raw.includes('data:audio') || raw.includes('"type":"voice"') || raw.includes('"kind":"voice"')) {
      return false;
    }
    return true;
  }

  function renderMessages(peerPubkey, options = {}) {
    if (!elements.messagesContainer) return;
    const normalizedPeer = (peerPubkey || '').toLowerCase();
    if (normalizedPeer && normalizedPeer !== _renderMessagesPeer) {
      _renderMessagesPeer = normalizedPeer;
      _visibleMessageLimit = INITIAL_VISIBLE_MESSAGES;
    }
    if (options.loadOlder) {
      _visibleMessageLimit += INITIAL_VISIBLE_MESSAGES;
    }
    if (options.resetLimit) {
      _visibleMessageLimit = INITIAL_VISIBLE_MESSAGES;
    }
    const now = Date.now();
    if (!options.force && !options.loadOlder && now - _lastRenderMsgTime < RENDER_MSG_THROTTLE) {
      if (_pendingRenderMsg) clearTimeout(_pendingRenderMsg);
      _pendingRenderMsg = setTimeout(() => { _pendingRenderMsg = null; renderMessages(peerPubkey, options); }, RENDER_MSG_THROTTLE);
      return;
    }
    _lastRenderMsgTime = now;
    try {
      App.ensureDisappearingIntroNotice?.(peerPubkey);
    } catch (_) {}
    const allMessages = typeof App.getChatMessages === 'function' ? App.getChatMessages(peerPubkey) : [];

    // שומרים בועות מדיה שכבר הומרו מהעלאה — מונע קפיצה ברינדור מלא | HYPER CORE TECH
    const preservedSettled = new Map();
    if (elements.messagesContainer) {
      settledMediaTransferIds.forEach((fileId) => {
        const el = elements.messagesContainer.querySelector(`[data-p2p-file-id="${fileId}"]`);
        const mid = el?.getAttribute?.('data-message-id');
        if (el && mid) {
          preservedSettled.set(mid, el);
          el.remove();
        }
      });
      // בועות ZIP/קובץ פעילות או settled — לא ליצור כרטיס שני ברינדור | HYPER CORE TECH
      elements.messagesContainer.querySelectorAll('.chat-message--file-card-transfer').forEach((el) => {
        const mid = el.getAttribute('data-message-id');
        const magnet = el.getAttribute('data-magnet-uri') || '';
        const tid = el.getAttribute('data-transfer-id') || el.getAttribute('data-torrent-transfer') || '';
        if (mid && !preservedSettled.has(mid)) preservedSettled.set(mid, el);
        if (magnet) preservedSettled.set(`mag:${magnet}`, el);
        if (tid) preservedSettled.set(`tid:${tid}`, el);
        el.remove();
      });
    }

    elements.messagesContainer.innerHTML = '';
    const fragment = doc.createDocumentFragment();
    if (!allMessages.length) {
      const empty = doc.createElement('p');
      empty.className = 'chat-conversation__empty';
      empty.textContent = 'אין הודעות עדיין. כתוב משהו!';
      fragment.appendChild(empty);
      elements.messagesContainer.appendChild(fragment);
      return;
    }
    const startIndex = Math.max(0, allMessages.length - _visibleMessageLimit);
    const messages = allMessages.slice(startIndex);
    if (startIndex > 0) {
      const loadOlder = doc.createElement('button');
      loadOlder.type = 'button';
      loadOlder.className = 'chat-load-older';
      loadOlder.textContent = `טען הודעות ישנות יותר (${startIndex})`;
      loadOlder.addEventListener('click', () => {
        const prevHeight = elements.messagesContainer.scrollHeight;
        renderMessages(peerPubkey, { loadOlder: true, force: true });
        requestAnimationFrame(() => {
          if (!elements.messagesContainer) return;
          elements.messagesContainer.scrollTop = Math.max(0, elements.messagesContainer.scrollHeight - prevHeight);
        });
      });
      fragment.appendChild(loadOlder);
    }
    // חלק צ'אט (chat-ui.js) – קיבוץ הודעות לפי יום והוספת כותרות תאריך דביקות בסגנון וואטסאפ
    let lastDayKey = '';
    messages.forEach((message) => {
      // מקבל: מסתירים מדיה/קובץ טורנט עד שיש blob מוכן — ואז מופיעים לפי createdAt | HYPER CORE TECH
      if (isIncomingTransferPending(message)) return;

      if (isSystemChatMessage(message)) {
        const messageTimestamp = message.createdAt || Math.floor(Date.now() / 1000);
        const dayKey = getMessageDayKey(messageTimestamp);
        if (dayKey && dayKey !== lastDayKey) {
          lastDayKey = dayKey;
          const header = doc.createElement('div');
          header.className = 'chat-date-header';
          header.setAttribute('data-day-key', dayKey);
          header.textContent = formatMessageDayHeader(messageTimestamp);
          fragment.appendChild(header);
        }
        fragment.appendChild(buildDisappearingSystemMessageEl(message, peerPubkey));
        return;
      }

      const messageTimestamp = message.createdAt || Math.floor(Date.now() / 1000);
      const dayKey = getMessageDayKey(messageTimestamp);
      if (dayKey && dayKey !== lastDayKey) {
        lastDayKey = dayKey;
        const header = doc.createElement('div');
        header.className = 'chat-date-header';
        header.setAttribute('data-day-key', dayKey);
        header.textContent = formatMessageDayHeader(messageTimestamp);
        fragment.appendChild(header);
      }

      // בועת העלאה שכבר הומרה — משאירים אותה במקום בלי לבנות מחדש | HYPER CORE TECH
      const preserved = message?.id ? preservedSettled.get(message.id) : null;
      if (preserved) {
        preservedSettled.delete(message.id);
        if (preserved.classList.contains('chat-message--file-card-transfer') || preserved.querySelector('.chat-file-upload')) {
          settleFileCardBubble(preserved, message);
        }
        fragment.appendChild(preserved);
        return;
      }
      const magnetKey = extractMessageMagnet(message);
      const tidKey = extractMessageTorrentTransferId(message);
      const preservedByMagnet = magnetKey ? preservedSettled.get(`mag:${magnetKey}`) : null;
      const preservedByTid = tidKey ? preservedSettled.get(`tid:${tidKey}`) : null;
      const preservedFile = preservedByMagnet || preservedByTid;
      if (preservedFile) {
        if (magnetKey) preservedSettled.delete(`mag:${magnetKey}`);
        if (tidKey) preservedSettled.delete(`tid:${tidKey}`);
        settleFileCardBubble(preservedFile, message);
        fragment.appendChild(preservedFile);
        return;
      }

      const item = doc.createElement('div');
      const isOutgoing =
        message.direction === 'outgoing' || message.from?.toLowerCase?.() === App.publicKey?.toLowerCase?.();
      const directionClass = isOutgoing ? 'chat-message--outgoing' : 'chat-message--incoming';
      const safeContent = App.escapeHtml ? App.escapeHtml(message.content) : message.content;
      const rawMessageContent = typeof message.content === 'string' ? message.content.trim() : '';
      
      // חלק זיהוי טורנט (chat-ui.js) – זיהוי הודעות העברת קבצים גדולים והצגתן כבועות מיוחדות | HYPER CORE TECH
      let isTorrentMessage = false;
      let torrentData = null;
      try {
        if (rawMessageContent.includes('torrent-transfer-request') || rawMessageContent.includes('magnetURI') || rawMessageContent.includes('infoHash')) {
          torrentData = JSON.parse(rawMessageContent);
          if (torrentData?.type === 'torrent-transfer-request' || (torrentData?.magnetURI && torrentData?.infoHash)) {
            isTorrentMessage = true;
            console.log('[CHAT/UI] 🧲 Detected torrent message:', torrentData.fileName, 'isOutgoing:', isOutgoing);
          }
        }
      } catch (e) { /* not JSON */ }
      
      // אם זו הודעת טורנט - כרטיס קובץ אחיד (כמו ההעברה) | HYPER CORE TECH
      if (isTorrentMessage && torrentData) {
        const torrentFileName = torrentData.fileName || 'קובץ';
        const torrentFileSize = torrentData.fileSize || 0;
        const torrentTransferId = torrentData.transferId || message.id;
        const magnetURI = torrentData.magnetURI || '';
        const infoHash = torrentData.infoHash || '';
        const fileSizeFormatted = typeof App.formatFileSize === 'function' ? App.formatFileSize(torrentFileSize) : `${(torrentFileSize / (1024 * 1024)).toFixed(2)} MB`;
        const fileExt = torrentFileName.split('.').pop()?.toLowerCase() || '';
        const blobUrl = magnetURI && typeof App.getTorrentBlob === 'function' ? App.getTorrentBlob(magnetURI)?.url : '';
        const looksImage = /\.(jpe?g|png|gif|webp|bmp|heic)$/i.test(torrentFileName);
        const looksVideo = /\.(mp4|m4v|mov|webm|mkv|avi|3gp)$/i.test(torrentFileName);

        // מקבל: תמונה/וידאו מוכנים — מציגים מדיה (לא כרטיס קובץ) | HYPER CORE TECH
        if (!isOutgoing && blobUrl && (looksImage || looksVideo)) {
          const mediaAtt = {
            name: torrentFileName,
            size: torrentFileSize,
            type: looksVideo ? 'video/mp4' : 'image/jpeg',
            url: blobUrl,
            magnetURI,
            isTorrent: true,
            isVideo: looksVideo || undefined,
          };
          let avatarHtmlTorrent = '';
          const normalizedFrom = message.from?.toLowerCase?.();
          const contact = normalizedFrom && App.chatState?.contacts?.get?.(normalizedFrom);
          const fallbackName = contact?.name || (normalizedFrom ? `משתמש ${normalizedFrom.slice(0, 8)}` : 'משתמש');
          const safeName = App.escapeHtml ? App.escapeHtml(fallbackName) : fallbackName;
          const initialsValue =
            contact?.initials || (typeof App.getInitials === 'function' ? App.getInitials(fallbackName) : 'מש');
          const safeInitials = App.escapeHtml ? App.escapeHtml(initialsValue) : initialsValue;
          avatarHtmlTorrent = contact?.picture
            ? `<span class="chat-message__avatar" title="${safeName}"><img src="${contact.picture}" alt="${safeName}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('chat-message__avatar--initials'); this.parentElement.textContent='${safeInitials}'; this.remove();"></span>`
            : `<span class="chat-message__avatar chat-message__avatar--initials" title="${safeName}">${safeInitials}</span>`;
          const mediaHtml = looksVideo
            ? (typeof App.renderVideoAttachment === 'function' ? App.renderVideoAttachment(mediaAtt) : '')
            : (typeof App.renderImageAttachment === 'function' ? App.renderImageAttachment(mediaAtt) : '');
          const sideDownloadHtml = buildChatFileSideDownloadHtml({
            attachment: mediaAtt,
            magnetURI,
            blobUrl,
            fileName: torrentFileName,
          });
          const sideActionsHtml = buildChatSideActionsHtml({
            isOutgoing: false,
            messageId: message.id,
            downloadHtml: sideDownloadHtml,
            copyHtml: '',
          });
          item.className = `chat-message ${directionClass} chat-message--media`;
          item.setAttribute('data-message-id', message.id);
          item.setAttribute('data-torrent-transfer', torrentTransferId);
          if (magnetURI) item.setAttribute('data-magnet-uri', magnetURI);
          item.innerHTML = `
            ${avatarHtmlTorrent}
            <div class="chat-message__content chat-message__content--has-attachment" data-chat-message="${message.id}">
              ${mediaHtml}
              <div class="chat-message__meta-row">
                <span class="chat-message__time">${formatMessageTime(message.createdAt || Math.floor(Date.now() / 1000))}</span>
              </div>
            </div>
            ${sideActionsHtml}
          `;
          fragment.appendChild(item);
          return;
        }

        let fileIcon = 'fa-file';
        if (['zip', 'rar', '7z', 'tar', 'gz'].includes(fileExt)) fileIcon = 'fa-file-zipper';
        else if (['pdf'].includes(fileExt)) fileIcon = 'fa-file-pdf';
        else if (['doc', 'docx'].includes(fileExt)) fileIcon = 'fa-file-word';
        else if (['xls', 'xlsx'].includes(fileExt)) fileIcon = 'fa-file-excel';

        let downloadButtonHtml = '';
        if (!isOutgoing && (blobUrl || magnetURI)) {
          if (blobUrl) {
            const safeUrl = App.escapeHtml ? App.escapeHtml(blobUrl) : blobUrl.replace(/"/g, '&quot;');
            const safeName = App.escapeHtml ? App.escapeHtml(torrentFileName) : torrentFileName;
            downloadButtonHtml = `<button type="button" class="chat-file-bubble__download" data-download-url="${safeUrl}" data-filename="${safeName}" title="הורד" aria-label="הורד"><i class="fa-solid fa-download" aria-hidden="true"></i></button>`;
          } else {
            downloadButtonHtml = `<button type="button" class="chat-file-bubble__download torrent-bubble__download-btn" data-magnet="${App.escapeHtml ? App.escapeHtml(magnetURI) : magnetURI}" data-filename="${App.escapeHtml ? App.escapeHtml(torrentFileName) : torrentFileName}" title="הורד" aria-label="הורד"><i class="fa-solid fa-download" aria-hidden="true"></i></button>`;
          }
        }

        item.className = `chat-message ${directionClass} chat-message--file-card-transfer chat-message--file-card-settled`;
        item.setAttribute('data-message-id', message.id);
        item.setAttribute('data-torrent-transfer', torrentTransferId);
        if (magnetURI) item.setAttribute('data-magnet-uri', magnetURI);
        if (infoHash) item.setAttribute('data-info-hash', infoHash);

        const sideDownloadHtml = buildChatFileSideDownloadHtml({
          attachment: null,
          magnetURI,
          blobUrl,
          fileName: torrentFileName,
        });
        const sideActionsHtml = buildChatSideActionsHtml({
          isOutgoing,
          messageId: message.id,
          downloadHtml: sideDownloadHtml,
          copyHtml: '',
        });

        item.innerHTML = `
          ${isOutgoing ? sideActionsHtml : ''}
          <div class="chat-message__content" data-chat-message="${message.id}">
            <div class="chat-file-upload" data-chat-file-upload="1">
              <div class="chat-file-bubble">
                <div class="chat-file-bubble__icon"><i class="fa-solid ${fileIcon}"></i></div>
                <div class="chat-file-bubble__info">
                  <div class="chat-file-bubble__name">${App.escapeHtml ? App.escapeHtml(torrentFileName) : torrentFileName}</div>
                  <div class="chat-file-bubble__size">${fileSizeFormatted}</div>
                </div>
                ${downloadButtonHtml}
              </div>
            </div>
            <div class="chat-message__meta-row">
              <span class="chat-message__time">${formatMessageTime(message.createdAt || Math.floor(Date.now() / 1000))}</span>
              <span class="chat-message__status-slot">${isOutgoing ? '<span class="chat-message__status chat-message__status--sent" title="נשלח"><i class="fa-solid fa-check-double"></i></span>' : ''}</span>
            </div>
          </div>
          ${!isOutgoing ? sideActionsHtml : ''}
        `;

        fragment.appendChild(item);
        return;
      }

      // חלק צ'אט (chat-ui.js) – משחזר אוואטר לשיחות נכנסות על בסיס נתוני איש הקשר
      // חלק אוואטר יוצא (chat-ui.js) – הוספת תמיכה באוואטר גם להודעות יוצאות (אודיו) | HYPER CORE TECH
      let avatarHtml = '';
      if (!isOutgoing) {
        const normalizedFrom = message.from?.toLowerCase?.();
        const contact = normalizedFrom && App.chatState?.contacts?.get?.(normalizedFrom);
        const fallbackName = contact?.name || (normalizedFrom ? `משתמש ${normalizedFrom.slice(0, 8)}` : 'משתמש');
        const safeName = App.escapeHtml ? App.escapeHtml(fallbackName) : fallbackName;
        const initialsValue =
          contact?.initials || (typeof App.getInitials === 'function' ? App.getInitials(fallbackName) : 'מש');
        const safeInitials = App.escapeHtml ? App.escapeHtml(initialsValue) : initialsValue;
        avatarHtml = contact?.picture
          ? `<span class="chat-message__avatar" title="${safeName}"><img src="${contact.picture}" alt="${safeName}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('chat-message__avatar--initials'); this.parentElement.textContent='${safeInitials}'; this.remove();"></span>`
          : `<span class="chat-message__avatar chat-message__avatar--initials" title="${safeName}">${safeInitials}</span>`;
      }
      // חלק זיהוי אודיו מקיף (chat-ui.js) – תמיכה בכל פורמטי האודיו הנפוצים PC/Android/iPhone/Apple | HYPER CORE TECH
      let attachmentHtml = '';
      let isAudioAttachment = false;
      let isImageAttachment = false;
      let isVideoAttachment = false;
      let a = message.attachment || null;
      // אחרי הורדת טורנט — מחברים blob מקומי כדי שהמדיה תוצג מיד | HYPER CORE TECH
      if (a?.magnetURI && !(a.url || a.dataUrl) && typeof App.getTorrentBlob === 'function') {
        const torrentBlob = App.getTorrentBlob(a.magnetURI);
        if (torrentBlob?.url) {
          a = { ...a, url: torrentBlob.url };
        }
      }
      if (a) {
        const src = a.url || a.dataUrl || '';
        // תיקון: וודא שה-type מועבר נכון, אחרת נסה לזהות מהשם
        let mime = (a.type || '').toLowerCase();
        const fileName = (a.name || '').toLowerCase();
        // אם אין MIME type, נסה לזהות מהשם
        if (!mime && fileName.includes('.webm')) mime = 'audio/webm';
        if (!mime && fileName.includes('.ogg')) mime = 'audio/ogg';
        if (!mime && fileName.includes('.mp3')) mime = 'audio/mpeg';
        const srcLower = src.toLowerCase();
        
        // רשימת כל סיומות האודיו הנפוצות - PC, Android, iPhone, Apple | HYPER CORE TECH
        const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|ogg|oga|opus|wav|wave|webm|flac|wma|aiff|aif|caf|amr|3gp|3gpp|mp4a|m4b|m4p|m4r|alac)$/i;
        const AUDIO_EXTENSIONS_URL = /\.(mp3|m4a|aac|ogg|oga|opus|wav|wave|webm|flac|wma|aiff|aif|caf|amr|3gp|3gpp|mp4a|m4b|m4p|m4r|alac)(\?|#|$)/i;
        
        // בדיקת MIME type - הכי אמין!
        const isAudioMime = mime.startsWith('audio/') || mime === 'application/ogg';
        // בדיקת data URL
        const fromDataUrl = /^data:audio\//i.test(src);
        // בדיקת סיומת בשם הקובץ (חשוב! Blossom URLs לא מכילים סיומת)
        const audioExtInName = AUDIO_EXTENSIONS.test(fileName);
        // בדיקת סיומת ב-URL
        const audioExtInUrl = AUDIO_EXTENSIONS_URL.test(srcLower);
        // בדיקת שם קובץ מכיל "voice" או "audio" או "sound"
        const isVoiceByName = fileName.includes('voice') || fileName.includes('audio') || fileName.includes('sound');
        // בדיקה נוספת: שם קובץ מסתיים ב-.webm (הודעה קולית נפוצה)
        const isWebmFile = fileName.endsWith('.webm') || srcLower.includes('.webm');
        // בדיקת duration - אם יש duration זה הודעה קולית
        const hasDuration = typeof a.duration === 'number' && a.duration > 0;
        // בדיקת URL מכיל blossom.band (שרת מדיה) - כל קובץ עם שם voice הוא אודיו
        const isBlossomAudio = srcLower.includes('blossom.band') && (audioExtInName || isVoiceByName || isWebmFile);
        // בדיקה נוספת: שם הקובץ מכיל "voice-message" - זה תמיד הודעה קולית!
        const isVoiceMessage = fileName.includes('voice-message') || fileName.includes('voicemessage');
        
        // חלק P2P קול (chat-ui.js) – הודעות P2P-only עם magnetURI בלבד גם נחשבות אודיו | HYPER CORE TECH
        const hasMagnetURI = !!(a.magnetURI);

        // חלק תיקון וידאו (chat-ui.js) – אם מסומן מפורשות כוידאו, מדלגים על זיהוי אודיו לחלוטין | HYPER CORE TECH
        if (a.isVideo === true) {
          isVideoAttachment = typeof App.isVideoAttachment === 'function' ? App.isVideoAttachment(a) : !!src;
        } else {
        // זיהוי אודיו: מספיק שאחד מהתנאים מתקיים (src או magnetURI) + תכונת אודיו אמיתית
        // שים לב: hasMagnetURI לבד אינו מספיק — חייבת להיות גם תכונת אודיו (mime/שם/סיומת/duration)
        // כדי שקבצי ZIP/PDF עם magnetURI לא יסווגו בטעות כהודעות קוליות!
        isAudioAttachment = !!((src || hasMagnetURI) && (
          isAudioMime ||           // type: audio/*
          fromDataUrl ||           // data:audio/*
          audioExtInName ||        // song.mp3, voice.m4a, etc.
          isVoiceByName ||         // שם מכיל "voice"/"audio"/"sound"
          isVoiceMessage ||        // שם מכיל "voice-message" - הכי חשוב!
          isWebmFile ||            // קובץ .webm (הודעה קולית)
          hasDuration ||           // יש duration
          audioExtInUrl ||         // URL מסתיים בסיומת אודיו
          isBlossomAudio           // Blossom URL עם שם קובץ אודיו
        ));
        
        // חלק מדיה (chat-ui.js) – זיהוי תמונות ווידאו | HYPER CORE TECH
        if (!isAudioAttachment && typeof App.isImageAttachment === 'function') {
          isImageAttachment = App.isImageAttachment(a);
        }
        if (!isAudioAttachment && !isImageAttachment && typeof App.isVideoAttachment === 'function') {
          isVideoAttachment = App.isVideoAttachment(a);
        }
        } // סוף בלוק isVideo===true
        // חלק דיבאג מדיה (chat-ui.js) – רישום זיהוי מצורף וסוג מדיה | HYPER CORE TECH
        mediaDebugLog('attachment-detect', {
          messageId: message.id,
          hasAttachment: !!a,
          name: a?.name || '',
          mime: a?.type || '',
          url: a?.url || a?.dataUrl || '',
          audio: isAudioAttachment,
          image: isImageAttachment,
          video: isVideoAttachment
        });
        
        if (isAudioAttachment) {
          // חלק נגן אודיו (chat-ui.js) – שימוש בנגן משודרג מ-chat-audio-player.js | HYPER CORE TECH
          // חלק דיבאג מדיה (chat-ui.js) – רינדור אודיו מצורף | HYPER CORE TECH
          mediaDebugLog('attachment-render', { messageId: message.id, kind: 'audio', name: a?.name || '', mime: a?.type || '', src });
          attachmentHtml = typeof App.createEnhancedAudioPlayer === 'function'
            ? App.createEnhancedAudioPlayer(a)
            : `<div class="chat-message__audio" data-audio><audio preload="metadata" class="chat-message__audio-el" src="${src}" type="${a.type || 'audio/webm'}"></audio></div>`;
        } else if (isImageAttachment) {
          // חלק תמונות (chat-ui.js) – הצגת תמונה inline | HYPER CORE TECH
          // חלק דיבאג מדיה (chat-ui.js) – רינדור תמונה מצורפת | HYPER CORE TECH
          mediaDebugLog('attachment-render', { messageId: message.id, kind: 'image', name: a?.name || '', mime: a?.type || '', src });
          attachmentHtml = typeof App.renderImageAttachment === 'function'
            ? App.renderImageAttachment(a)
            : `<img src="${src}" alt="${a.name || 'תמונה'}" class="chat-message__image" loading="lazy">`;
        } else if (isVideoAttachment) {
          // חלק וידאו (chat-ui.js) – נגן וידאו מוטמע | HYPER CORE TECH
          // חלק דיבאג מדיה (chat-ui.js) – רינדור וידאו מצורף | HYPER CORE TECH
          mediaDebugLog('attachment-render', { messageId: message.id, kind: 'video', name: a?.name || '', mime: a?.type || '', src });
          attachmentHtml = typeof App.renderVideoAttachment === 'function'
            ? App.renderVideoAttachment(a)
            : `<video src="${src}" controls class="chat-message__video"></video>`;
        } else if (typeof App.isPdfAttachment === 'function' && App.isPdfAttachment(a)) {
          // חלק PDF (chat-ui.js) – תצוגה מקדימה של PDF עם רנדור עמוד ראשון בסגנון WhatsApp | HYPER CORE TECH
          // חלק דיבאג מדיה (chat-ui.js) – רינדור PDF מצורף | HYPER CORE TECH
          mediaDebugLog('attachment-render', { messageId: message.id, kind: 'pdf', name: a?.name || '', mime: a?.type || '', src });
          attachmentHtml = typeof App.renderPdfAttachment === 'function'
            ? App.renderPdfAttachment(a)
            : `<div class="chat-file-bubble"><i class="fa-solid fa-file-pdf"></i> ${App.escapeHtml ? App.escapeHtml(a.name || 'PDF') : (a.name || 'PDF')}</div>`;
        } else if (typeof App.isHtmlAttachment === 'function' && App.isHtmlAttachment(a)) {
          // חלק HTML (chat-ui.js) – תצוגה מקדימה של דף HTML ב-iframe sandbox בסגנון PDF | HYPER CORE TECH
          // חלק דיבאג מדיה (chat-ui.js) – רינדור HTML מצורף | HYPER CORE TECH
          mediaDebugLog('attachment-render', { messageId: message.id, kind: 'html', name: a?.name || '', mime: a?.type || '', src });
          attachmentHtml = typeof App.renderHtmlAttachment === 'function'
            ? App.renderHtmlAttachment(a)
            : `<div class="chat-file-bubble"><i class="fa-solid fa-code"></i> ${App.escapeHtml ? App.escapeHtml(a.name || 'HTML') : (a.name || 'HTML')}</div>`;
        } else if (typeof App.isGenericFileAttachment === 'function' && App.isGenericFileAttachment(a)) {
          // חלק קובץ כללי (chat-ui.js) – רנדור בועת קובץ מעוצבת לקבצי ZIP/TXT/טורנט | HYPER CORE TECH
          // חלק דיבאג מדיה (chat-ui.js) – רינדור קובץ כללי מצורף | HYPER CORE TECH
          mediaDebugLog('attachment-render', { messageId: message.id, kind: 'file', name: a?.name || '', mime: a?.type || '', src });
          attachmentHtml = typeof App.renderGenericFileAttachment === 'function'
            ? App.renderGenericFileAttachment(a)
            : `<div class="chat-file-bubble"><i class="fa-solid fa-file"></i> ${App.escapeHtml ? App.escapeHtml(a.name || 'קובץ') : (a.name || 'קובץ')}</div>`;
        } else if (src) {
          const fileName = a.name || 'קובץ מצורף';
          const safeFileName = App.escapeHtml ? App.escapeHtml(fileName) : fileName;
          const extraAttrs = a.url ? 'target="_blank" rel="noopener noreferrer"' : '';
          // חלק דיבאג מדיה (chat-ui.js) – fallback ללינק מצורף | HYPER CORE TECH
          mediaDebugLog('attachment-render', { messageId: message.id, kind: 'link', name: fileName, mime: a?.type || '', src });
          attachmentHtml = `
            <a class="chat-message__attachment" href="${src}" ${extraAttrs} download="${fileName}">
              <i class="fa-solid fa-paperclip"></i>
              <span>${safeFileName}</span>
            </a>
          `;
        }
      }
      
      // חלק YouTube (chat-ui.js) – כרטיס תמונה+כותרת; לחיצה פותחת חיצונית (בלי URL גולמי) | HYPER CORE TECH
      let youtubeHtml = '';
      let youtubeRemainingText = '';
      let youtubeCopyUrl = '';
      if (!a && rawMessageContent && typeof App.extractYouTubeId === 'function') {
        const videoId = App.extractYouTubeId(rawMessageContent);
        if (videoId) {
          mediaDebugLog('message-youtube-detect', { messageId: message.id, videoId });
          youtubeHtml = typeof App.renderYouTubeCard === 'function'
            ? App.renderYouTubeCard(videoId)
            : '';
          youtubeCopyUrl = `https://www.youtube.com/watch?v=${videoId}`;
          youtubeRemainingText = String(rawMessageContent)
            .replace(/https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/[^\s<>"']+|youtu\.be\/[^\s<>"']+)/gi, '')
            .trim();
        }
      }

      // חלק לינק כללי (chat-ui.js) – כרטיס OG קומפקטי (לא YouTube) | HYPER CORE TECH
      let linkPreviewHtml = '';
      let linkPreviewRemainingText = '';
      let linkCopyUrl = '';
      if (!a && !youtubeHtml && rawMessageContent && typeof App.extractPreviewableUrl === 'function') {
        const previewUrl = App.extractPreviewableUrl(rawMessageContent);
        if (previewUrl && typeof App.renderLinkPreviewCard === 'function') {
          mediaDebugLog('message-link-preview-detect', { messageId: message.id, url: previewUrl });
          linkPreviewHtml = App.renderLinkPreviewCard(previewUrl);
          linkCopyUrl = previewUrl;
          linkPreviewRemainingText = typeof App.stripPreviewUrlFromText === 'function'
            ? App.stripPreviewUrlFromText(rawMessageContent, previewUrl)
            : String(rawMessageContent)
              .replace(previewUrl, '')
              .replace(/\s{2,}/g, ' ')
              .trim();
        }
      }
      
      // חלק זיהוי מדיה מ-URL (chat-ui.js) – זיהוי לינקי תמונה/וידאו/אודיו בטקסט ההודעה | HYPER CORE TECH
      let mediaUrlHtml = '';
      let isMediaUrl = false;
      let remainingText = rawMessageContent;
      // חלק זיהוי URL (chat-ui.js) – גם אם יש attachment, נבדוק URLs בטקסט | HYPER CORE TECH
      if (!youtubeHtml && !linkPreviewHtml && rawMessageContent) {
        const IMAGE_EXTS = /\.(jpe?g|png|gif|webp|heic|heif|bmp|svg)(\?|#|$)/i;
        // חלק זיהוי אודיו מקיף (chat-ui.js) – כל פורמטי האודיו PC/Android/iPhone/Apple | HYPER CORE TECH
        const AUDIO_EXTS = /\.(mp3|m4a|aac|ogg|oga|opus|wav|wave|webm|flac|wma|aiff|aif|caf|amr|3gp|3gpp|mp4a|m4b|m4p|m4r|alac)(\?|#|$)/i;
        const VIDEO_EXTS = /\.(mp4|ogv|mov|avi|mkv|m4v|wmv|flv|3gp)(\?|#|$)/i;
        
        // חיפוש כל ה-URLs בהודעה - משופר לתמוך ב-URLs עם תווים מיוחדים
        const urlRegex = /(https?:\/\/[^\s<>"']+)/gi;
        const urls = rawMessageContent.match(urlRegex) || [];
        const mediaItems = [];
        
        urls.forEach(originalUrl => {
          // ניקוי URL מתווי סיום לא רצויים
          const url = originalUrl.replace(/[.,;:!?)}\]]+$/, '');
          
          // חלק זיהוי אודיו (chat-ui.js) – בדיקה אם זה קובץ אודיו | HYPER CORE TECH
          const isAudioUrl = AUDIO_EXTS.test(url);
          
          if (IMAGE_EXTS.test(url) && !a) {
            // תמונה — הורדה בעמודת הצד (לא על המדיה) | HYPER CORE TECH
            mediaItems.push(`
              <div class="chat-message__image-container">
                <img 
                  src="${url}" 
                  alt="תמונה" 
                  class="chat-message__image"
                  loading="lazy"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  onclick="if(typeof App.openImageLightbox==='function')App.openImageLightbox('${url.replace(/'/g, "\\'")}','תמונה',this)"
                />
              </div>
            `);
            remainingText = remainingText.replace(originalUrl, '').trim();
            isMediaUrl = true;
          } else if (isAudioUrl) {
            // חלק נגן אודיו מקיף (chat-ui.js) – יוצר נגן לכל פורמטי האודיו PC/Android/iPhone/Apple | HYPER CORE TECH
            const ext = (url.match(/\.(\w+)(?:\?|#|$)/i) || [])[1]?.toLowerCase() || 'mp3';
            const mimeMap = {
              mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
              m4a: 'audio/mp4', m4b: 'audio/mp4', m4p: 'audio/mp4', m4r: 'audio/mp4', mp4a: 'audio/mp4', alac: 'audio/mp4',
              aac: 'audio/aac', webm: 'audio/webm', flac: 'audio/flac', wma: 'audio/x-ms-wma',
              aiff: 'audio/aiff', aif: 'audio/aiff', caf: 'audio/x-caf', amr: 'audio/amr', '3gp': 'audio/3gpp', '3gpp': 'audio/3gpp'
            };
            const mimeType = mimeMap[ext] || 'audio/mpeg';
            const fileName = decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'קובץ שמע');
            const fakeAttachment = { url: url, type: mimeType, name: fileName };
            console.log('[AUDIO] Creating player for URL:', { url, ext, mimeType, fileName });
            mediaItems.push(typeof App.createEnhancedAudioPlayer === 'function'
              ? App.createEnhancedAudioPlayer(fakeAttachment)
              : `<div class="chat-message__audio" data-audio data-src="${url}"><audio preload="auto" class="chat-message__audio-el" src="${url}" type="${mimeType}"></audio></div>`);
            remainingText = remainingText.replace(originalUrl, '').trim();
            isMediaUrl = true;
          } else if (VIDEO_EXTS.test(url) && !a) {
            // וידאו בסגנון וואטסאפ – תקציר + Play למסך מלא | HYPER CORE TECH
            const fileName = decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'video.mp4');
            mediaItems.push(
              typeof App.renderVideoAttachment === 'function'
                ? App.renderVideoAttachment({ url, type: 'video/mp4', name: fileName })
                : `<div class="chat-message__video-container" data-chat-video-preview="1"><video class="chat-message__video" preload="metadata" playsinline muted src="${url}"></video></div>`
            );
            remainingText = remainingText.replace(originalUrl, '').trim();
            isMediaUrl = true;
          }
        });
        
        mediaUrlHtml = mediaItems.join('');
        // חלק דיבאג מדיה (chat-ui.js) – רינדור מדיה מתוך URLs | HYPER CORE TECH
        if (mediaItems.length) {
          mediaDebugLog('message-media-urls', { messageId: message.id, count: mediaItems.length });
        }
      }

      item.className = `chat-message ${directionClass}`;
      item.setAttribute('data-message-id', message.id);
      item.setAttribute('data-chat-created', String(messageTimestamp));
      item.setAttribute('data-chat-from', String(message.from || '').toLowerCase());
      // הורדה ליד הפח (שולח) / במקום הפח (מקבל) לתמונה ווידאו | HYPER CORE TECH
      let sideDownloadHtml = '';
      if (isImageAttachment || isVideoAttachment) {
        sideDownloadHtml = buildChatMediaSideDownloadHtml(a, a?.url || a?.dataUrl || '', a?.name || '');
      } else if (a && (typeof App.isGenericFileAttachment === 'function' ? App.isGenericFileAttachment(a) : true) && (a.magnetURI || a.url || a.dataUrl)) {
        sideDownloadHtml = buildChatFileSideDownloadHtml({
          attachment: a,
          magnetURI: a.magnetURI || '',
          fileName: a.name || 'קובץ',
        });
      } else if (isMediaUrl && /chat-message__image-container|chat-message__video-container/.test(mediaUrlHtml || '')) {
        const urlMatch = (rawMessageContent || '').match(/https?:\/\/[^\s<>"']+/i);
        const mediaUrl = urlMatch ? urlMatch[0].replace(/[.,;:!?)}\]]+$/, '') : '';
        if (mediaUrl) {
          const isImgUrl = /\.(jpe?g|png|gif|webp|heic|heif|bmp|svg)(\?|#|$)/i.test(mediaUrl);
          sideDownloadHtml = buildChatMediaSideDownloadHtml(null, mediaUrl, isImgUrl ? 'תמונה.jpg' : 'video.mp4');
        }
      }
      const sideCopyHtml = buildChatLinkCopyHtml(youtubeCopyUrl || linkCopyUrl);
      const sideActionsHtml = buildChatSideActionsHtml({
        isOutgoing,
        messageId: message.id,
        downloadHtml: sideDownloadHtml,
        copyHtml: sideCopyHtml,
      });
      // חלק צ'אט (chat-ui.js) – כאשר מצורף קובץ בלבד, לא מציגים שוב את הטקסט "📎 filename" כי הלינק מציג את השם
      const fileOnlyLabel = a && !isAudioAttachment ? `📎 ${a.name || 'קובץ מצורף'}` : '';
      const hideTextForFileOnly = !isAudioAttachment && !!attachmentHtml && rawMessageContent === fileOnlyLabel;
      // חלק מדיה URL / כרטיסי לינק (chat-ui.js) – מסתיר URL גולמי כשיש כרטיס/מדיה | HYPER CORE TECH
      const textToShow = youtubeHtml
        ? youtubeRemainingText
        : (linkPreviewHtml
          ? linkPreviewRemainingText
          : (isMediaUrl ? remainingText : rawMessageContent));
      const safeTextToShow = App.escapeHtml ? App.escapeHtml(textToShow) : textToShow;
      const hideTextForMediaUrl =
        (isMediaUrl && !remainingText) ||
        (!!youtubeHtml && !youtubeRemainingText) ||
        (!!linkPreviewHtml && !linkPreviewRemainingText);
      
      // חלק "המשך קריאה" (chat-ui.js) – קיצור הודעות ארוכות ל-10 שורות עם כפתור הרחבה | HYPER CORE TECH
      let textHtml = '';
      if (safeTextToShow && !isAudioAttachment && !hideTextForFileOnly && !hideTextForMediaUrl) {
        const lines = safeTextToShow.split('\n');
        const MAX_LINES = 10;
        const isLongText = lines.length > MAX_LINES;
        const truncatedContent = isLongText ? lines.slice(0, MAX_LINES).join('\n') : safeTextToShow;
        const fullContentEscaped = safeTextToShow.replace(/'/g, "\\'").replace(/\n/g, '\\n');
        
        if (isLongText) {
          textHtml = `
            <span class="chat-message__text chat-message__text--truncated" data-full-text="${fullContentEscaped}" onclick="App.copyMessageToClipboard && App.copyMessageToClipboard(this)">
              ${truncatedContent.replace(/\n/g, '<br>')}
              <span class="chat-message__read-more" onclick="event.stopPropagation(); App.expandMessageText && App.expandMessageText(this.parentElement)">להמשך קריאה...</span>
            </span>
          `;
        } else {
          textHtml = `<span class="chat-message__text" onclick="App.copyMessageToClipboard && App.copyMessageToClipboard(this)">${safeTextToShow.replace(/\n/g, '<br>')}</span>`;
        }
      }

      // חלק צ'אט (chat-ui.js) – מצב קומפקטי בסגנון WhatsApp: הודעות קצרות עם שעה+פח על אותה שורה | HYPER CORE TECH
      const shouldCompactMeta =
        !a &&
        rawMessageContent &&
        rawMessageContent.length <= 60 &&
        !rawMessageContent.includes('\n') &&
        Boolean(textHtml);
      const youtubeOnly = !!youtubeHtml && !textHtml && !attachmentHtml && !mediaUrlHtml && !linkPreviewHtml;
      const linkPreviewOnly = !!linkPreviewHtml && !textHtml && !attachmentHtml && !mediaUrlHtml && !youtubeHtml;
      const contentClassName = `chat-message__content${a ? ' chat-message__content--has-attachment' : ''}${
        shouldCompactMeta ? ' chat-message__content--compact-meta' : ''
      }${youtubeOnly ? ' chat-message__content--youtube-only' : ''}${
        linkPreviewOnly ? ' chat-message__content--link-preview-only' : ''
      }`;
      
      // חלק סטטוס הודעות ואטסאפ (chat-ui.js) – וי כפול כמו ואטסאפ | HYPER CORE TECH
      let statusHtml = '';
      if (isOutgoing) {
        const status = message.status || 'sent';
        if (status === 'sending') {
          statusHtml = '<span class="chat-message__status chat-message__status--sending" title="שולח..."><i class="fa-solid fa-clock"></i></span>';
        } else if (status === 'sent') {
          statusHtml = '<span class="chat-message__status chat-message__status--sent" title="נשלח"><i class="fa-solid fa-check-double"></i></span>';
        } else if (status === 'read') {
          statusHtml = '<span class="chat-message__status chat-message__status--read" title="נקרא"><i class="fa-solid fa-check-double"></i></span>';
        } else if (status === 'failed') {
          statusHtml = '<span class="chat-message__status chat-message__status--failed" title="שליחה נכשלה"><i class="fa-solid fa-exclamation-circle"></i></span>';
        }
      }
      
      // חלק meta בתוך נגן (chat-ui.js) – הסתרת meta-row לאודיו/וידאו/תמונה והזרקה לתוך המדיה | HYPER CORE TECH
      const hideMetaForAudio = isAudioAttachment && !textHtml && !youtubeHtml && !linkPreviewHtml && !mediaUrlHtml;
      const hideMetaForVideo =
        (isVideoAttachment || (isMediaUrl && /chat-message__video-container/.test(mediaUrlHtml || ''))) &&
        !textHtml &&
        !youtubeHtml &&
        !linkPreviewHtml &&
        !attachmentHtml?.includes('chat-audio');
      const hideMetaForImage =
        (isImageAttachment || (isMediaUrl && /chat-message__image-container/.test((attachmentHtml || '') + (mediaUrlHtml || '')))) &&
        !textHtml &&
        !youtubeHtml &&
        !linkPreviewHtml;
      const hideMetaForMedia = hideMetaForAudio || hideMetaForVideo || hideMetaForImage;
      const metaRowHtml = hideMetaForMedia ? '' : `
          <div class="chat-message__meta-row">
            <span class="chat-message__meta">${formatMessageTime(messageTimestamp)}</span>
            ${statusHtml}
          </div>
      `;

      // הודעת מדיה בלבד — מסתירים את כל הבועה עד שהמדיה מוכנה (בלי פסים) | HYPER CORE TECH
      const pendingVisualMediaOnly =
        !textHtml &&
        !youtubeHtml &&
        !linkPreviewHtml &&
        !isAudioAttachment &&
        (
          isImageAttachment ||
          isVideoAttachment ||
          /is-media-pending|chat-message__image-container|chat-message__video-container/.test(
            `${attachmentHtml || ''}${mediaUrlHtml || ''}`
          )
        );
      if (pendingVisualMediaOnly) {
        item.classList.add('chat-message--media-pending');
      }
      
      item.innerHTML = `
        ${avatarHtml}
        ${isOutgoing ? sideActionsHtml : ''}
        <div class="${contentClassName}" data-chat-message="${message.id}">
          ${textHtml}
          ${attachmentHtml}
          ${youtubeHtml}
          ${linkPreviewHtml}
          ${mediaUrlHtml}
          ${metaRowHtml}
        </div>
        ${!isOutgoing ? sideActionsHtml : ''}
      `;
      // העברת שאריות כפתור הורדה/העתקה לעמודת הצד | HYPER CORE TECH
      if (sideDownloadHtml || sideCopyHtml || isImageAttachment || isVideoAttachment || isMediaUrl) {
        ensureChatSideActions(item, {
          isOutgoing,
          messageId: message.id,
          downloadHtml: sideDownloadHtml,
          copyHtml: sideCopyHtml,
        });
      }
      // חלק חיבור נגנים (chat-ui.js) – חיבור כל נגני האודיו (attachment + URL) | HYPER CORE TECH
      const contentEl = item.querySelector('[data-chat-message]');
      if (contentEl && typeof App.wireEnhancedAudioPlayer === 'function') {
        // חיבור כל נגני האודיו בהודעה
        const audioWraps = contentEl.querySelectorAll('[data-audio]');
        audioWraps.forEach(wrap => {
          App.wireEnhancedAudioPlayer(wrap);
        });
      }
      // חלק כרטיסי לינק (chat-ui.js) – השלמת כותרת/תמונה אחרי רינדור | HYPER CORE TECH
      if (youtubeHtml && contentEl && typeof App.hydrateYouTubeCards === 'function') {
        App.hydrateYouTubeCards(contentEl);
      }
      if (linkPreviewHtml && contentEl && typeof App.hydrateLinkPreviewCards === 'function') {
        App.hydrateLinkPreviewCards(contentEl);
      }
      // חלק הזרקת meta לנגן (chat-ui.js) – הזרקת שעה וסטטוס לתוך נגן האודיו | HYPER CORE TECH
      if (hideMetaForAudio && contentEl) {
        const metaSlot = contentEl.querySelector('.chat-audio-whatsapp__meta-slot');
        if (metaSlot) {
          metaSlot.innerHTML = `<span class="chat-audio-whatsapp__msg-time">${formatMessageTime(messageTimestamp)}</span>${statusHtml}`;
        }
        // חלק הזרקת תמונת פרופיל לנגן (chat-ui.js) – הזרקת avatar לתוך נגן האודיו | HYPER CORE TECH
        const avatarSlot = contentEl.querySelector('.chat-audio-whatsapp__avatar-slot');
        if (avatarSlot) {
          let playerAvatarHtml = '';
          if (isOutgoing) {
            // תמונת פרופיל של המשתמש הנוכחי - חיפוש במקומות שונים
            const myPubkey = App.publicKey?.toLowerCase?.();
            const myContact = myPubkey && App.chatState?.contacts?.get?.(myPubkey);
            const myName = App.userName || App.userDisplayName || App.profile?.name || myContact?.name || 'אני';
            const safeName = App.escapeHtml ? App.escapeHtml(myName) : myName;
            const myInitials = typeof App.getInitials === 'function' ? App.getInitials(myName) : myName.slice(0, 2);
            const safeInitials = App.escapeHtml ? App.escapeHtml(myInitials) : myInitials;
            // חיפוש תמונת פרופיל במקומות שונים
            const myPicture = App.userPicture || App.userAvatar || App.profile?.picture || App.profile?.image || myContact?.picture || null;
            playerAvatarHtml = myPicture
              ? `<img src="${myPicture}" alt="${safeName}" class="chat-audio-whatsapp__avatar" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.classList.add('chat-audio-whatsapp__avatar--initials'); this.outerHTML='<span class=\\'chat-audio-whatsapp__avatar chat-audio-whatsapp__avatar--initials\\'>${safeInitials}</span>';">`
              : `<span class="chat-audio-whatsapp__avatar chat-audio-whatsapp__avatar--initials">${safeInitials}</span>`;
          } else {
            // תמונת פרופיל של איש הקשר
            const normalizedFrom = message.from?.toLowerCase?.();
            const contact = normalizedFrom && App.chatState?.contacts?.get?.(normalizedFrom);
            const fallbackName = contact?.name || (normalizedFrom ? `משתמש ${normalizedFrom.slice(0, 8)}` : 'משתמש');
            const safeName = App.escapeHtml ? App.escapeHtml(fallbackName) : fallbackName;
            const initialsValue = contact?.initials || (typeof App.getInitials === 'function' ? App.getInitials(fallbackName) : 'מש');
            const safeInitials = App.escapeHtml ? App.escapeHtml(initialsValue) : initialsValue;
            playerAvatarHtml = contact?.picture
              ? `<img src="${contact.picture}" alt="${safeName}" class="chat-audio-whatsapp__avatar" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.classList.add('chat-audio-whatsapp__avatar--initials'); this.outerHTML='<span class=\\'chat-audio-whatsapp__avatar chat-audio-whatsapp__avatar--initials\\'>${safeInitials}</span>';">`
              : `<span class="chat-audio-whatsapp__avatar chat-audio-whatsapp__avatar--initials">${safeInitials}</span>`;
          }
          avatarSlot.innerHTML = playerAvatarHtml;
        }
      }
      // חלק וידאו וואטסאפ (chat-ui.js) – שעת הודעה מרחפת על הווידאו למטה־שמאל | HYPER CORE TECH
      if (hideMetaForVideo && contentEl) {
        contentEl.querySelectorAll('[data-video-time-slot]').forEach((slot) => {
          slot.innerHTML = `<span class="chat-message__video-msg-time-text">${formatMessageTime(messageTimestamp)}</span>${statusHtml || ''}`;
        });
        contentEl.classList.add('chat-message__content--video-only');
      }
      // תמונה בלבד — שעה על המדיה כשתחשף (בלי meta-row שיוצר פס) | HYPER CORE TECH
      if (hideMetaForImage && contentEl) {
        contentEl.classList.add('chat-message__content--image-only');
        contentEl.querySelectorAll('.chat-message__image-container').forEach((imgWrap) => {
          if (imgWrap.querySelector('[data-image-time-slot]')) return;
          const slot = document.createElement('span');
          slot.className = 'chat-message__image-msg-time';
          slot.setAttribute('data-image-time-slot', '');
          slot.innerHTML = `<span class="chat-message__image-msg-time-text">${formatMessageTime(messageTimestamp)}</span>${statusHtml || ''}`;
          imgWrap.appendChild(slot);
        });
      }
      fragment.appendChild(item);
    });
    elements.messagesContainer.appendChild(fragment);

    // חלק סנכרון כפתור טורנט (chat-ui.js) – מניעת הורדות חוזרות מהיסטוריה אחרי אתחול שיחה | HYPER CORE TECH
    syncTorrentDownloadButtons();

    // חלק גלילה לתחתית (chat-ui.js) – גלילה מושהית כדי לוודא שהדפדפן סיים לרנדר את כל ההודעות | HYPER CORE TECH
    if (!options.loadOlder) {
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (elements.messagesContainer) {
            elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
          }
        }, 50);
      });
    }

    // חלק צ'אט (chat-ui.js) – הבטחת איפוס מונה לא נקראים כשצופים בשיחה בפועל | HYPER CORE TECH
    const activeNormalized = (state.activeContact || '').toLowerCase();
    const normalized = (peerPubkey || '').toLowerCase();
    if (activeNormalized && normalized && activeNormalized === normalized && typeof App.markChatConversationRead === 'function') {
      App.markChatConversationRead(normalized);
    }
  }

  // חלק הוספת הודעה בודדת (chat-ui.js) – מוסיף הודעה ל-UI ללא רינדור מחדש של הכל | HYPER CORE TECH
  function appendSingleMessage(message) {
    if (!elements.messagesContainer || !message?.id) return;
    if (elements.messagesContainer.querySelector(`[data-message-id="${message.id}"]`)) return;

    // הסר הודעת "אין הודעות" אם קיימת
    const emptyMsg = elements.messagesContainer.querySelector('.chat-conversation__empty');
    if (emptyMsg) emptyMsg.remove();

    if (isSystemChatMessage(message)) {
      const messageTimestamp = message.createdAt || Math.floor(Date.now() / 1000);
      const dayKey = getMessageDayKey(messageTimestamp);
      const headers = elements.messagesContainer.querySelectorAll('.chat-date-header');
      const lastHeader = headers.length ? headers[headers.length - 1] : null;
      const lastDayKey = lastHeader?.getAttribute('data-day-key') || '';
      if (dayKey && dayKey !== lastDayKey) {
        const header = doc.createElement('div');
        header.className = 'chat-date-header';
        header.setAttribute('data-day-key', dayKey);
        header.textContent = formatMessageDayHeader(messageTimestamp);
        elements.messagesContainer.appendChild(header);
      }
      elements.messagesContainer.appendChild(
        buildDisappearingSystemMessageEl(message, message.to || message.from || state.activeContact)
      );
      elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
      return;
    }

    const messageTimestamp = message.createdAt || Math.floor(Date.now() / 1000);
    const dayKey = getMessageDayKey(messageTimestamp);
    const headers = elements.messagesContainer.querySelectorAll('.chat-date-header');
    const lastHeader = headers.length ? headers[headers.length - 1] : null;
    const lastDayKey = lastHeader?.getAttribute('data-day-key') || '';
    if (dayKey && dayKey !== lastDayKey) {
      const header = doc.createElement('div');
      header.className = 'chat-date-header';
      header.setAttribute('data-day-key', dayKey);
      header.textContent = formatMessageDayHeader(messageTimestamp);
      elements.messagesContainer.appendChild(header);
    }

    const item = doc.createElement('div');
    const isOutgoing = message.direction === 'outgoing' || message.from?.toLowerCase?.() === App.publicKey?.toLowerCase?.();
    const directionClass = isOutgoing ? 'chat-message--outgoing' : 'chat-message--incoming';
    const rawContent = typeof message.content === 'string' ? message.content : '';

    // חלק כרטיסי לינק (chat-ui.js) – גם ב-append מיידי אחרי שליחה מציגים כרטיס | HYPER CORE TECH
    let youtubeHtml = '';
    let linkPreviewHtml = '';
    let linkCopyUrl = '';
    let textToShow = rawContent;
    if (!message.attachment && rawContent && typeof App.extractYouTubeId === 'function') {
      const videoId = App.extractYouTubeId(rawContent);
      if (videoId && typeof App.renderYouTubeCard === 'function') {
        youtubeHtml = App.renderYouTubeCard(videoId);
        linkCopyUrl = `https://www.youtube.com/watch?v=${videoId}`;
        textToShow = rawContent
          .replace(/https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/[^\s<>"']+|youtu\.be\/[^\s<>"']+)/gi, '')
          .trim();
      }
    }
    if (!message.attachment && !youtubeHtml && rawContent && typeof App.extractPreviewableUrl === 'function') {
      const previewUrl = App.extractPreviewableUrl(rawContent);
      if (previewUrl && typeof App.renderLinkPreviewCard === 'function') {
        linkPreviewHtml = App.renderLinkPreviewCard(previewUrl);
        linkCopyUrl = previewUrl;
        textToShow = typeof App.stripPreviewUrlFromText === 'function'
          ? App.stripPreviewUrlFromText(rawContent, previewUrl)
          : rawContent
            .replace(previewUrl, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
      }
    }
    const safeContent = App.escapeHtml ? App.escapeHtml(textToShow) : textToShow;
    
    // סטטוס הודעה בסגנון ואטסאפ
    let statusHtml = '';
    if (isOutgoing) {
      const status = message.status || 'sent';
      if (status === 'sending') {
        statusHtml = '<span class="chat-message__status chat-message__status--sending" title="שולח..."><i class="fa-solid fa-clock"></i></span>';
      } else if (status === 'sent') {
        statusHtml = '<span class="chat-message__status chat-message__status--sent" title="נשלח"><i class="fa-solid fa-check-double"></i></span>';
      } else if (status === 'failed') {
        statusHtml = '<span class="chat-message__status chat-message__status--failed" title="שליחה נכשלה"><i class="fa-solid fa-exclamation-circle"></i></span>';
      }
    }

    const sideCopyHtml = buildChatLinkCopyHtml(linkCopyUrl);
    const sideActionsHtml = buildChatSideActionsHtml({
      isOutgoing,
      messageId: message.id,
      downloadHtml: '',
      copyHtml: sideCopyHtml,
    });
    
    item.className = `chat-message ${directionClass}`;
    item.setAttribute('data-message-id', message.id);
    item.setAttribute('data-chat-created', String(messageTimestamp));
    item.setAttribute('data-chat-from', String(message.from || '').toLowerCase());
    
    const textHtml = safeContent
      ? `<span class="chat-message__text">${safeContent.replace(/\n/g, '<br>')}</span>`
      : '';
    const youtubeOnly = !!youtubeHtml && !textHtml && !linkPreviewHtml;
    const linkPreviewOnly = !!linkPreviewHtml && !textHtml && !youtubeHtml;
    let contentClass = 'chat-message__content';
    if (youtubeOnly) contentClass += ' chat-message__content--youtube-only';
    else if (linkPreviewOnly) contentClass += ' chat-message__content--link-preview-only';
    else if (!youtubeHtml && !linkPreviewHtml && safeContent.length <= 60 && !safeContent.includes('\n')) {
      contentClass += ' chat-message__content--compact-meta';
    }
    
    item.innerHTML = `
      ${isOutgoing ? sideActionsHtml : ''}
      <div class="${contentClass}" data-chat-message="${message.id}">
        ${textHtml}
        ${youtubeHtml}
        ${linkPreviewHtml}
        <div class="chat-message__meta-row">
          <span class="chat-message__meta">${formatMessageTime(messageTimestamp)}</span>
          ${statusHtml}
        </div>
      </div>
      ${!isOutgoing ? sideActionsHtml : ''}
    `;
    
    elements.messagesContainer.appendChild(item);
    if (youtubeHtml && typeof App.hydrateYouTubeCards === 'function') {
      App.hydrateYouTubeCards(item);
    }
    if (linkPreviewHtml && typeof App.hydrateLinkPreviewCards === 'function') {
      App.hydrateLinkPreviewCards(item);
    }
    elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
  }

  // חלק עדכון סטטוס הודעה (chat-ui.js) – מעדכן סטטוס הודעה קיימת ללא רינדור מחדש | HYPER CORE TECH
  function updateMessageStatus(tempId, newStatus, realId) {
    if (!elements.messagesContainer) return;
    
    const messageEl = elements.messagesContainer.querySelector(`[data-message-id="${tempId}"]`);
    if (!messageEl) return;
    
    // עדכן ID אם קיבלנו ID אמיתי
    if (realId) {
      messageEl.setAttribute('data-message-id', realId);
      const contentEl = messageEl.querySelector('[data-chat-message]');
      if (contentEl) contentEl.setAttribute('data-chat-message', realId);
    }
    
    // עדכן אייקון סטטוס בסגנון ואטסאפ
    const statusEl = messageEl.querySelector('.chat-message__status');
    if (statusEl) {
      statusEl.className = `chat-message__status chat-message__status--${newStatus}`;
      if (newStatus === 'sent') {
        statusEl.innerHTML = '<i class="fa-solid fa-check-double"></i>';
        statusEl.title = 'נשלח';
      } else if (newStatus === 'failed') {
        statusEl.innerHTML = '<i class="fa-solid fa-exclamation-circle"></i>';
        statusEl.title = 'שליחה נכשלה';
      }
    }
  }

  function showConversation(peerPubkey, contact) {
    state.activeContact = peerPubkey;
    elements.panel.classList.add('chat-panel--conversation');
    updatePanelMode(PANEL_MODES.CONVERSATION);
    setFooterMode('contacts');
    elements.notificationsSection?.setAttribute('hidden', '');
    if (elements.emptyState) {
      elements.emptyState.setAttribute('hidden', '');
    }
    elements.conversationHeader?.removeAttribute('hidden');
    elements.composer?.removeAttribute('hidden');
    elements.messagesContainer?.removeAttribute('hidden');
    if (elements.messageInput) {
      elements.messageInput.value = '';
      elements.messageInput.style.height = '';
      // חלק צ'אט (chat-ui.js) – לא מפעיל focus אוטומטי כדי שהמקלדת לא תיפתח ללא לחיצה יזומה
    }
    // אתחול מחדש של כפתור מיקרופון במובייל כשהשיחה נפתחת
    if (typeof App.initializeChatVoiceUI === 'function') {
      setTimeout(() => {
        App.initializeChatVoiceUI({
          getActivePeer: () => state.activeContact,
          getMessageDraft: () => elements.messageInput?.value || '',
          composerElement: elements.composer,
        });
      }, 100);
    }
    updateActiveConversationHeader(peerPubkey);
    // חלק סטטוס P2P (chat-ui.js) – מציג מצב חיבור DC בכותרת שיחה כדי שהמשתמש ידע אם ההודעות עוברות P2P | HYPER CORE TECH
    if (elements.conversationStatus) {
      updateConversationDCStatus(peerPubkey);
    }
    renderMessages(peerPubkey, { resetLimit: true, force: true });
    App.markChatConversationRead(peerPubkey);
    if (typeof App.setChatFileTransferActivePeer === 'function') {
      App.setChatFileTransferActivePeer(peerPubkey);
    }
    // חלק P2P DataChannel (chat-ui.js) – חיבור DataChannel כשפותחים שיחה | HYPER CORE TECH
    if (App.dataChannel && typeof App.dataChannel.connect === 'function') {
      App.dataChannel.connect(peerPubkey);
    }
  }

  // חלק סטטוס P2P (chat-ui.js) – עדכון תצוגת מצב DC בכותרת שיחה + רענון כל 3 שניות | HYPER CORE TECH
  let _dcStatusTimer = null;
  function updateConversationDCStatus(peerPubkey) {
    if (_dcStatusTimer) { clearInterval(_dcStatusTimer); _dcStatusTimer = null; }
    const el = elements.conversationStatus;
    if (!el) return;
    const update = () => {
      const pk = peerPubkey || state.activeContact;
      if (!pk) { el.textContent = 'פעיל ברשת'; return; }
      const dcOn = App.dataChannel && typeof App.dataChannel.isConnected === 'function' && App.dataChannel.isConnected(pk);
      el.innerHTML = dcOn
        ? '<span style="color:#25D366" title="חיבור ישיר P2P פעיל — הודעות עוברות ישירות">⚡ P2P ישיר</span>'
        : '<span title="הודעות עוברות דרך שרת relay">☁️ דרך שרת</span>';
    };
    update();
    _dcStatusTimer = setInterval(() => {
      if (state.activeContact) update(); else { clearInterval(_dcStatusTimer); _dcStatusTimer = null; }
    }, 3000);
  }

  function resetConversationView() {
    state.activeContact = null;
    elements.panel.classList.remove('chat-panel--conversation');
    setFooterMode('contacts');
    elements.conversationHeader?.setAttribute('hidden', '');
    elements.composer?.setAttribute('hidden', '');
    if (elements.emptyState) {
      elements.emptyState.removeAttribute('hidden');
    }
    if (elements.messagesContainer) {
      elements.messagesContainer.innerHTML = '';
      elements.messagesContainer.setAttribute('hidden', '');
    }
    elements.notificationsSection?.setAttribute('hidden', '');
    if (typeof App.clearChatFileTransferUI === 'function') {
      App.clearChatFileTransferUI();
    }
    updatePanelMode(PANEL_MODES.LIST);
    // חזרה לרשימת שיחות אחרי deep-link – מחזירים את התפריט התחתון | HYPER CORE TECH
    try {
      if (typeof App.clearSosDeepLinkFlags === 'function') App.clearSosDeepLinkFlags();
      else {
        document.documentElement.removeAttribute('data-sos-deeplink');
        document.body.classList.remove('sos-deeplink-chat');
      }
    } catch (_) {}
  }

  function handleContactClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const target = event.target.closest('[data-chat-contact]');
    if (!target) return;
    const peerPubkey = target.getAttribute('data-chat-contact');
    if (!peerPubkey) return;
    const normalized = peerPubkey.toLowerCase();
    let contact = App.chatState?.contacts?.get?.(normalized) || null;
    // חלק חיפוש רשת (chat-ui.js) – לחיצה על תוצאת רשת מוסיפה איש קשר ופותחת שיחה | HYPER CORE TECH
    if (!contact) {
      const net = (state.networkSearchResults || []).find(
        (item) => String(item?.pubkey || '').toLowerCase() === normalized
      );
      if (net && typeof App.ensureChatContact === 'function') {
        contact = App.ensureChatContact(normalized, {
          name: net.name,
          picture: net.picture || '',
          initials: net.initials || '',
        });
      } else if (typeof App.addChatContact === 'function') {
        contact = App.addChatContact(normalized);
      }
    }
    showConversation(peerPubkey, contact);
    renderContacts(true);
  }

  // חלק שליחה אופטימיסטית (chat-ui.js) – שליחה מיידית ללא המתנה לרשת | HYPER CORE TECH
  function handleSendMessage(event) {
    event.preventDefault();
    if (!state.activeContact) {
      return;
    }
    const value = elements.messageInput?.value || '';
    const hasAttachment =
      typeof App.hasChatFileAttachment === 'function' && App.hasChatFileAttachment(state.activeContact);
    if (!value.trim() && !hasAttachment) {
      return;
    }
    
    // 1. נקה input מיד - תגובה מיידית למשתמש
    const messageText = value;
    elements.messageInput.value = '';
    // חלק גובה קלט (chat-ui.js) – value='' לא מפעיל input, מאפסים גובה שתפח בזמן הקלדה | HYPER CORE TECH
    elements.messageInput.style.height = '';
    elements.messageInput.disabled = false;
    // חלק שמירת מקלדת (chat-ui.js) – שמירה על פוקוס ב-input אחרי שליחה כדי שהמקלדת תישאר פתוחה במובייל | HYPER CORE TECH
    elements.messageInput.focus();
    
    // 2. הודעה זמנית ב-state (מפעיל UI פעם אחת דרך subscribe) | HYPER CORE TECH
    const tempId = 'temp-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    const tempMessage = {
      id: tempId,
      from: App.publicKey,
      to: state.activeContact,
      content: messageText,
      createdAt: Math.floor(Date.now() / 1000),
      direction: 'outgoing',
      status: 'sending'
    };
    if (typeof App.appendChatMessage === 'function') {
      App.appendChatMessage(tempMessage);
    } else {
      appendSingleMessage(tempMessage);
    }
    
    // 3. שלח ברקע – מחליף את ה-temp במקום ליצור הודעה שנייה | HYPER CORE TECH
    App.publishChatMessage(state.activeContact, messageText, { clientTempId: tempId })
      .then((result) => {
        if (!result?.ok) {
          console.warn('Failed to send chat message', result?.error);
          updateMessageStatus(tempId, 'failed');
          if (typeof App.updateChatMessageStatus === 'function') {
            App.updateChatMessageStatus(tempId, 'failed');
          }
        } else {
          // אם ההחלפה כבר עדכנה את ה-DOM ל-ID אמיתי – מעדכנים סטטוס על ה-ID החדש | HYPER CORE TECH
          const statusTargetId = result.messageId || tempId;
          updateMessageStatus(statusTargetId, 'sent', result.messageId);
          if (result.messageId && result.messageId !== tempId) {
            const tempEl = elements.messagesContainer?.querySelector(`[data-message-id="${tempId}"]`);
            if (tempEl) tempEl.remove();
          }
        }
      })
      .catch((err) => {
        console.error('Chat send error', err);
        updateMessageStatus(tempId, 'failed');
        if (typeof App.updateChatMessageStatus === 'function') {
          App.updateChatMessageStatus(tempId, 'failed');
        }
      });
  }

  function handleAddContact(event) {
    event.preventDefault();
    const value = elements.addContactInput?.value?.trim?.();
    if (!value) {
      return;
    }
    const contact = App.addChatContact?.(value);
    if (contact) {
      renderContacts();
      showConversation(contact.pubkey, contact);
      elements.addContactInput.value = '';
      togglePanel(true);
    }
  }

  function subscribeToEvents() {
    if (elements.navButton) {
      elements.navButton.addEventListener('click', () => {
        // בדיקת מצב אורח - חסימת הודעות למשתמשים לא מחוברים | HYPER CORE TECH
        if (App && typeof App.requireAuth === 'function') {
          if (!App.requireAuth('כדי לשלוח הודעות צריך להתחבר או להירשם.')) {
            return;
          }
        }
        // סגירת פאנל פרופיל אם פתוח | HYPER CORE TECH
        if (typeof App.closeProfilePanel === 'function') {
          App.closeProfilePanel();
        }
        
        // לוגיקה הגיונית: פתוח בשיחות→סגור, פתוח בהתראות→עבור לשיחות, סגור→פתח שיחות
        if (state.isOpen) {
          if (state.footerMode === 'contacts' || state.footerMode === 'home') {
            // כבר בטאב שיחות - סגור
            togglePanel(false);
          } else {
            // בטאב אחר (התראות) - עבור לשיחות
            setFooterMode('contacts');
            state.activeContact = null;
            resetConversationView();
            renderContacts();
            updatePanelMode(PANEL_MODES.LIST);
            // עדכון כפתור התראות
            if (elements.notificationsToggle) {
              elements.notificationsToggle.classList.remove('is-active');
            }
          }
        } else {
          // הפאנל סגור - פתח בטאב שיחות
          setFooterMode('contacts');
          togglePanel(true);
        }
      });
    }

    // חלק התראות (chat-ui.js) – המאזין לכפתור ההתראות מטופל על ידי feed.js שמפנה ל-openNotificationsPanel | HYPER CORE TECH
    // המאזין הוסר כדי למנוע כפילות - feed.js מטפל בלחיצה ומפנה לכאן דרך App.openNotificationsPanel

    if (elements.launcherButton) {
      elements.launcherButton.addEventListener('click', () => togglePanel());
    }
    if (elements.closeButton) {
      elements.closeButton.addEventListener('click', () => togglePanel(false));
    }
    // האזנה לכפתור סגירה החדש בסיידבר (דסקטופ) | HYPER CORE TECH
    const sidebarCloseBtn = doc.getElementById('chatSidebarCloseBtn');
    if (sidebarCloseBtn) {
      sidebarCloseBtn.addEventListener('click', () => togglePanel(false));
    }
    doc.addEventListener('click', (event) => {
      if (!state.isOpen) return;
      // הורדה יוצרת a.click() סינתטי מחוץ לפאנל – לא לסגור את הצ'אט | HYPER CORE TECH
      if (App.__sosSuppressChatOutsideClose) return;
      // חלק שיחות קול (chat-ui.js) – התעלמות מלחיצות על דיאלוג שיחת קול/וידיאו כדי לא לסגור את הצ'אט | HYPER CORE TECH
      const voiceCallDialog = doc.getElementById('voiceCallDialog');
      const videoCallDialog = doc.getElementById('videoCallDialog');
      if (voiceCallDialog && voiceCallDialog.contains(event.target)) return;
      if (videoCallDialog && videoCallDialog.contains(event.target)) return;
      // lightbox / כפתורי הורדה / לינק הורדה זמני | HYPER CORE TECH
      if (event.target.closest?.('#chatImageLightbox, .chat-lightbox, .chat-media-modal, .chat-message__media-download, .chat-lightbox__download, .chat-file-bubble__download, .chat-pdf-bubble__download, a[download], [data-sos-download-link]')) return;
      if (
        elements.panel.contains(event.target) ||
        (elements.navButton && elements.navButton.contains(event.target)) ||
        (elements.launcherButton && elements.launcherButton.contains(event.target))
      ) {
        return;
      }
      togglePanel(false);
    });
    window.addEventListener('resize', () => {
      schedulePositionPanel();
    });
    // לא מאזינים ל-scroll של החלון – גורם לגרירת מקלדת איטית | HYPER CORE TECH
    if (elements.contactsList) {
      elements.contactsList.addEventListener('click', handleContactClick);
    }
    if (elements.refreshContacts) {
      elements.refreshContacts.addEventListener('click', () => {
        // חלק רענון שיחות (chat-ui.js) – איפוס חותמת זמן וטעינה מחדש של כל השיחות | HYPER CORE TECH
        handleRefreshAllConversations();
      });
    }
    if (elements.searchInput) {
      // חלק חיפוש רשת (chat-ui.js) – מד טעינה מיידי + debounce רק לשאילתת הריליי | HYPER CORE TECH
      const debouncedNetworkSearch = debounce((value) => {
        runNetworkContactSearch(value);
      }, 350);
      elements.searchInput.addEventListener('input', (event) => {
        const value = event.target?.value || '';
        const trimmed = value.trim();
        state.filterText = value;
        if (trimmed.length >= 2) {
          state.networkSearchPending = true;
          const prevQ = String(state.networkSearchQuery || '').toLowerCase();
          const nextQ = trimmed.toLowerCase();
          if (prevQ && prevQ !== nextQ && !nextQ.startsWith(prevQ) && !prevQ.startsWith(nextQ)) {
            state.networkSearchResults = [];
          }
          state.networkSearchQuery = trimmed;
        } else {
          state.networkSearchPending = false;
          state.networkSearchResults = [];
          state.networkSearchQuery = '';
        }
        updateSearchLoadingUI();
        renderContacts(true);
        debouncedNetworkSearch(value);
      });
    }
    if (elements.composer) {
      elements.composer.addEventListener('submit', handleSendMessage);
    }
    if (elements.messagesContainer) {
      elements.messagesContainer.addEventListener('click', handleMessageActions);
    }
    if (elements.backButton) {
      elements.backButton.addEventListener('click', () => {
        resetConversationView();
      });
    }
    const headerBackButton = doc.getElementById('chatConversationActionsBack');
    if (headerBackButton) {
      headerBackButton.addEventListener('click', () => {
        resetConversationView();
      });
    }
    // תפריט ⋮ בכותרת שיחה (במקום חזרה בשמאל) | HYPER CORE TECH
    const headerMenuBtn = doc.getElementById('chatConversationMenuBtn');
    const headerMenu = doc.getElementById('chatConversationMenu');
    const closeHeaderMenu = () => {
      if (!headerMenu || headerMenu.hidden) return;
      headerMenu.hidden = true;
      if (headerMenuBtn) headerMenuBtn.setAttribute('aria-expanded', 'false');
      headerMenu.style.top = '';
      headerMenu.style.left = '';
      headerMenu.style.right = '';
      headerMenu.style.transform = '';
    };
    if (headerMenuBtn && headerMenu) {
      const positionHeaderMenu = () => {
        if (!headerMenu || headerMenu.hidden) return;
        const pad = 8;
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        if (isMobile) {
          const btnRect = headerMenuBtn.getBoundingClientRect();
          headerMenu.style.position = 'fixed';
          headerMenu.style.top = `${Math.round(btnRect.bottom + 8)}px`;
          headerMenu.style.left = `${Math.round(btnRect.left)}px`;
          headerMenu.style.right = 'auto';
          headerMenu.style.transform = 'none';
          const rect = headerMenu.getBoundingClientRect();
          if (rect.left < pad) {
            headerMenu.style.left = `${pad}px`;
          } else if (rect.right > window.innerWidth - pad) {
            headerMenu.style.left = `${Math.max(pad, Math.floor(window.innerWidth - pad - rect.width))}px`;
          }
          return;
        }
        headerMenu.style.position = '';
        headerMenu.style.top = '';
        headerMenu.style.left = '0px';
        headerMenu.style.right = 'auto';
        headerMenu.style.transform = 'none';
        const rect = headerMenu.getBoundingClientRect();
        if (rect.left < pad) {
          headerMenu.style.transform = `translateX(${Math.ceil(pad - rect.left)}px)`;
        } else if (rect.right > window.innerWidth - pad) {
          headerMenu.style.transform = `translateX(${Math.floor((window.innerWidth - pad) - rect.right)}px)`;
        }
      };
      headerMenuBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const open = headerMenu.hidden;
        headerMenu.hidden = !open;
        headerMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
          requestAnimationFrame(positionHeaderMenu);
        } else {
          headerMenu.style.transform = 'none';
        }
      });
      headerMenu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-action]');
        if (!item) return;
        e.preventDefault();
        closeHeaderMenu();
        const action = item.getAttribute('data-action');
        if (action === 'clear-chat') {
          if (state.activeContact) showClearChatConfirmDialog(state.activeContact);
          return;
        }
        if (action === 'auto-clean') {
          showAutoCleanDialog();
        }
      });
      doc.addEventListener('click', (e) => {
        if (!headerMenu.hidden && !headerMenu.contains(e.target) && e.target !== headerMenuBtn && !headerMenuBtn.contains(e.target)) {
          closeHeaderMenu();
          headerMenu.style.transform = 'none';
        }
      });
      window.addEventListener('resize', () => {
        if (!headerMenu.hidden) positionHeaderMenu();
      }, { passive: true });
    }
    if (elements.notificationsMarkRead) {
      elements.notificationsMarkRead.addEventListener('click', () => {
        if (typeof App.markAllNotificationsRead === 'function') {
          App.markAllNotificationsRead(true);
        }
      });
    }
    if (elements.footerItems?.length) {
      elements.footerItems.forEach((item) => {
        item.addEventListener('click', () => handleFooterNav(item));
      });
    }
    
    // האזנה לכפתורי סרגל הצד החדש | HYPER CORE TECH
    if (elements.navSidebarItems?.length) {
      elements.navSidebarItems.forEach((item) => {
        item.addEventListener('click', () => handleFooterNav(item));
      });
    }
    
    // עדכון תמונת פרופיל בסרגל הצד אם זמינה
    if (elements.navProfileImg && (App.userPicture || App.userAvatar)) {
      elements.navProfileImg.src = App.userPicture || App.userAvatar;
    }
    
    // חלק אטב אחיד (chat-ui.js) – כפתור טורנט נפרד הוסר — הכל עובר דרך כפתור אטב | HYPER CORE TECH
    if (elements.torrentSendButton) {
      elements.torrentSendButton.style.display = 'none';
    }
  }

  function initSubscriptions() {
    App.subscribeChat?.('contacts', () => {
      renderContacts();
      // כשתמונת פרופיל מגיעה אחרי פתיחת השיחה – מרעננים את ההדר | HYPER CORE TECH
      if (state.activeContact) updateActiveConversationHeader(state.activeContact);
    });
    App.subscribeChat?.('message', (payload = {}) => {
      const { peer, message, statusUpdate, replacedTempId, removedMessageId } = payload;
      if (!peer) return;
      const normalizedPeer = peer.toLowerCase();
      if (payload.disappearingTimerUpdated || payload.disappearingPruned || payload.disappearingSystemNotice) {
        if (normalizedPeer === (state.activeContact || '').toLowerCase()) {
          if (payload.disappearingSystemNotice && message && !payload.disappearingPruned) {
            appendSingleMessage(message);
          } else {
            renderMessages(state.activeContact, { force: true });
          }
        }
        renderContacts(true);
        if (!removedMessageId && !statusUpdate && !replacedTempId) {
          if (payload.disappearingSystemNotice || payload.disappearingTimerUpdated || payload.disappearingPruned) return;
        }
      }
      const isIncoming = message?.direction === 'incoming'
        || (message?.from && typeof App.publicKey === 'string' && message.from.toLowerCase() !== App.publicKey.toLowerCase());
      const isActivePeer = normalizedPeer === (state.activeContact || '').toLowerCase();
      const messageId = message?.id || null;

      // חלק מניעת כפילות (chat-ui.js) – עדכון/החלפת temp בלי append נוסף | HYPER CORE TECH
      if (removedMessageId && elements.messagesContainer) {
        const removedIds = Array.isArray(payload.removedMessageIds)
          ? payload.removedMessageIds.filter(Boolean)
          : [removedMessageId];
        if (!removedIds.includes(removedMessageId)) removedIds.push(removedMessageId);
        removedIds.forEach((id) => {
          elements.messagesContainer.querySelector(`[data-message-id="${id}"]`)?.remove();
        });
        const removedFileId = payload.removedFileId
          || (typeof removedMessageId === 'string' && removedMessageId.startsWith('p2p-send-')
            ? removedMessageId.slice('p2p-send-'.length)
            : '')
          || (typeof removedMessageId === 'string' && removedMessageId.startsWith('p2p-recv-')
            ? removedMessageId.slice('p2p-recv-'.length)
            : '');
        if (removedFileId) {
          elements.messagesContainer.querySelector(`[data-p2p-file-id="${removedFileId}"]`)?.remove();
          elements.messagesContainer.querySelector(`[data-transfer-id="${removedFileId}"]`)?.remove();
        }
      }
      if (replacedTempId && message?.id) {
        const realEl = elements.messagesContainer?.querySelector(`[data-message-id="${message.id}"]`);
        const tempEl = elements.messagesContainer?.querySelector(`[data-message-id="${replacedTempId}"]`);
        if (realEl && tempEl && realEl !== tempEl) {
          tempEl.remove();
          updateMessageStatus(message.id, message.status || 'sent');
        } else if (tempEl) {
          updateMessageStatus(replacedTempId, message.status || 'sent', message.id);
        } else if (!realEl) {
          appendSingleMessage(message);
        } else {
          updateMessageStatus(message.id, message.status || 'sent');
        }
        if (isActivePeer) App.markChatConversationRead(peer);
        return;
      }
      if (statusUpdate && message?.id) {
        updateMessageStatus(message.id, message.status || 'sent');
        if (isActivePeer) App.markChatConversationRead(peer);
        return;
      }

      // התרעה + צליל רק אם זה נכנס ולא בשיחה הפעילה/פוקוס
      // חלק דה-דופליקציה (chat-ui.js) – בודק גם אם ההודעה כבר הותרעה | HYPER CORE TECH
      // חלק סינון הודעות ישנות (chat-ui.js) – התראה רק על הודעות מ-60 שניות אחרונות | HYPER CORE TECH
      const messageCreatedAt = message?.createdAt || message?.created_at || 0;
      const messageAgeSec = Math.floor(Date.now() / 1000) - messageCreatedAt;
      const isRecentMessage = messageAgeSec >= 0 && messageAgeSec < 60; // פחות מ-60 שניות
      
      if (isIncoming && !wasMessageNotified(messageId) && isRecentMessage) {
        if (!isActivePeer || !state.isOpen) {
          playChatMessageSound();
          const snippetSource = (message?.content && message.content.trim()) ||
            (message?.attachment?.name ? `📎 ${message.attachment.name}` :
              (message?.attachment
                ? (String(message.attachment.type || '').toLowerCase().startsWith('audio/') ? 'הודעת קול' : 'קובץ מצורף')
                : 'הודעה חדשה'));
          showIncomingChatNotification(normalizedPeer, snippetSource, messageId);
        }
      }

      if (isActivePeer) {
        // מדיה יוצאת אחרי P2P — ממירים את בועת ההעלאה במקום בלי רינדור מלא/קפיצה | HYPER CORE TECH
        if (message && settleOutgoingMediaTransfer(message)) {
          App.markChatConversationRead(peer);
          return;
        }
        // ZIP/קובץ (שולח+מקבל) — ממירים את בועת ההעברה במקום בלי כרטיס שני | HYPER CORE TECH
        if (message && settleOutgoingFileTransfer(message)) {
          App.markChatConversationRead(peer);
          return;
        }
        // הודעות טקסט פשוטות – append בלי רינדור מלא של ההיסטוריה | HYPER CORE TECH
        if (message && isSimpleChatMessage(message)) {
          appendSingleMessage(message);
        } else if (message) {
          renderMessages(peer);
        }
        App.markChatConversationRead(peer);
      } else {
        renderContacts();
      }
      
      // חלק סטטוס הודעות (chat-ui.js) – עדכון DOM ישיר כשמשתנה סטטוס הודעה | HYPER CORE TECH
      // מונע רינדור מלא רק לעדכון סטטוס
    });
    App.subscribeChat?.('unread', (total) => {
      renderChatBadge(total);
    });
    ensureNotificationSubscription();
  }

  function initializeUI() {
    renderContacts(true); // force render בטעינה ראשונה
    renderChatBadge(App.chatState?.unreadTotal || 0);
    elements.messagesContainer?.setAttribute('hidden', '');
    elements.notificationsSection?.setAttribute('hidden', '');
    subscribeToEvents();
    initSubscriptions();
    ensureNotificationSubscription();
    if (typeof App.initializeChatFileTransferUI === 'function') {
      App.initializeChatFileTransferUI({
        fileButton: doc.getElementById('chatComposerFileButton'),
        fileInput: doc.getElementById('chatComposerFileInput'),
        filePreview: doc.getElementById('chatComposerFilePreview'),
        fileNameLabel: doc.getElementById('chatComposerFileName'),
        fileRemove: doc.getElementById('chatComposerFileRemove'),
        getActivePeer: () => state.activeContact,
        getMessageDraft: () => elements.messageInput?.value || '',
      });
    }
    // אתחול UI להודעות קוליות – מוסיף כפתור מיקרופון, הקלטה והצמדה כשמצרפים קול
    if (typeof App.initializeChatVoiceUI === 'function') {
      App.initializeChatVoiceUI({
        getActivePeer: () => state.activeContact,
        getMessageDraft: () => elements.messageInput?.value || '',
        composerElement: elements.composer,
      });
    }
    // מנוי פרוגרס להעברות P2P כדי לרנדר בועות התקדמות בתוך השיחה | HYPER CORE TECH
    subscribeTransferProgress();
    // רישום SW והאזנה להודעות ממנו (בקשת הרשאות רק בלחיצה על פאנל הצ'אט)
    registerChatServiceWorkerIfSupported();
    initChatServiceWorkerMessageHandling();
    updatePanelMode(PANEL_MODES.LIST);
  }

  // חלק צ'אט (chat-ui.js) – מאפשר למודולים חיצוניים (למשל התרעות) לסגור את חלון הצ'אט במעבר בין פאנלים
  App.closeChatPanel = function closeChatPanel() {
    togglePanel(false);
  };

  App.toggleChatPanel = togglePanel;

  // חלק התראות (chat-ui.js) – חשיפת פונקציות שליטה בפאנל ההתראות | HYPER CORE TECH
  App.openNotificationsPanel = function openNotificationsPanel() {
    // וידוא שהפאנל פתוח
    if (!state.isOpen) {
      togglePanel(true);
    }
    // מעבר למצב התראות
    setFooterMode('notifications');
    // הצגת התצוגה
    showNotificationsView();
    // עדכון כפתור הניווט הראשי
    if (elements.notificationsToggle) {
      elements.notificationsToggle.setAttribute('aria-pressed', 'true');
      elements.notificationsToggle.classList.add('is-active');
    }
  };

  App.closeNotificationsPanel = function closeNotificationsPanel() {
    if (elements.notificationsToggle) {
      elements.notificationsToggle.setAttribute('aria-pressed', 'false');
      elements.notificationsToggle.classList.remove('is-active');
    }
    // אם אנחנו במצב התראות, סגור את הפאנל
    if (state.isOpen && state.footerMode === 'notifications') {
      togglePanel(false);
    }
  };

  // חלק צ'אט (chat-ui.js) – חשיפת פונקציה לקבלת המשתמש הפעיל בשיחה
  App.getActiveChatContact = function getActiveChatContact() {
    return state.activeContact;
  };
  // חלק P2P DataChannel (chat-ui.js) – alias עבור מודול DataChannel reconnect | HYPER CORE TECH
  App.getActiveChatPeer = App.getActiveChatContact;

  // חלק צ'אט (chat-ui.js) – חשיפת פונקציה לפתיחת שיחה ספציפית (התרעות / deep link / סיום שיחה) | HYPER CORE TECH
  App.showChatConversation = function showChatConversationExternal(peerPubkey) {
    if (!peerPubkey) return;
    const normalized = String(peerPubkey).toLowerCase();
    try {
      if (typeof App.ensureChatContact === 'function') {
        App.ensureChatContact(normalized);
      }
    } catch (_) {}
    const contact = App.chatState?.contacts?.get(normalized);
    togglePanel(true);
    showConversation(normalized, contact);
  };

  // חלק העתקה ללוח (chat-ui.js) – העתקת טקסט הודעה ללוח בלחיצה | HYPER CORE TECH
  App.copyMessageToClipboard = function copyMessageToClipboard(element) {
    if (!element) return;
    const fullText = element.getAttribute('data-full-text');
    const textToCopy = fullText 
      ? fullText.replace(/\\n/g, '\n').replace(/\\'/g, "'")
      : element.innerText.replace('להמשך קריאה...', '').trim();
    
    if (!textToCopy) return;
    
    navigator.clipboard.writeText(textToCopy).then(() => {
      // הצגת הודעה למשתמש
      const toast = doc.createElement('div');
      toast.className = 'chat-toast';
      toast.textContent = 'הועתק ללוח!';
      toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:8px 16px;border-radius:20px;font-size:14px;z-index:10000;animation:fadeInOut 2s forwards;';
      doc.body.appendChild(toast);
      setTimeout(() => toast.remove(), 2000);
    }).catch(() => {});
  };

  // חלק העתקת לינק (chat-ui.js) – העתקת URL מכרטיס לינק/YouTube בלי לפתוח דפדפן | HYPER CORE TECH
  App.copyChatLinkToClipboard = function copyChatLinkToClipboard(url) {
    const href = String(url || '').trim();
    if (!href) return;
    const showToast = () => {
      const toast = doc.createElement('div');
      toast.className = 'chat-toast';
      toast.textContent = 'הקישור הועתק!';
      toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:8px 16px;border-radius:20px;font-size:14px;z-index:10000;animation:fadeInOut 2s forwards;';
      doc.body.appendChild(toast);
      setTimeout(() => toast.remove(), 2000);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(href).then(showToast).catch(() => {});
      return;
    }
    try {
      const ta = doc.createElement('textarea');
      ta.value = href;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      doc.body.appendChild(ta);
      ta.select();
      doc.execCommand('copy');
      ta.remove();
      showToast();
    } catch (_) {}
  };

  // חלק הרחבת טקסט (chat-ui.js) – הרחבת הודעה ארוכה שנחתכה | HYPER CORE TECH
  App.expandMessageText = function expandMessageText(element) {
    if (!element) return;
    const fullText = element.getAttribute('data-full-text');
    if (!fullText) return;
    
    const expandedText = fullText.replace(/\\n/g, '<br>').replace(/\\'/g, "'");
    element.innerHTML = expandedText;
    element.classList.remove('chat-message__text--truncated');
    element.onclick = function() { App.copyMessageToClipboard(this); };
  };

  // חלק אינדיקטור שליחה (chat-ui.js) – הצגת סימן טעינה בזמן שליחת הודעה קולית | HYPER CORE TECH
  const voiceSendingIndicators = new Map();
  
  App.showVoiceSendingIndicator = function showVoiceSendingIndicator(peer, loadingId) {
    if (!elements.messagesContainer || !peer) return;
    
    const indicator = doc.createElement('div');
    indicator.className = 'chat-message chat-message--outgoing chat-message--sending';
    indicator.id = loadingId;
    indicator.innerHTML = `
      <div class="chat-message__content">
        <div class="chat-message__sending-indicator">
          <i class="fa-solid fa-spinner fa-spin"></i>
          <span>שולח הודעה קולית...</span>
        </div>
        <div class="chat-message__meta-row">
          <span class="chat-message__meta">
            <i class="fa-solid fa-clock"></i>
          </span>
        </div>
      </div>
    `;
    elements.messagesContainer.appendChild(indicator);
    elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
    voiceSendingIndicators.set(loadingId, indicator);
  };
  
  App.hideVoiceSendingIndicator = function hideVoiceSendingIndicator(loadingId) {
    const indicator = voiceSendingIndicators.get(loadingId);
    if (indicator && indicator.parentElement) {
      indicator.remove();
    }
    voiceSendingIndicators.delete(loadingId);
  };

  // חלק אטב אחיד (chat-ui.js) – openTorrentSendDialog הוסר — הכל עובר דרך כפתור אטב אחיד | HYPER CORE TECH
  App.openTorrentSendDialog = function openTorrentSendDialog() {
    console.log('[CHAT] openTorrentSendDialog הוסר — השתמש בכפתור אטב');
  };

  // חלק WebTorrent (chat-ui.js) – זיהוי הודעות WebTorrent נכנסות | HYPER CORE TECH
  App.handleIncomingChatMessage = function handleIncomingChatMessage(fromPeer, content) {
    // בדיקה אם זו הודעת בקשת העברה
    if (typeof App.torrentTransfer?.parseTransferMessage === 'function') {
      const handled = App.torrentTransfer.parseTransferMessage(content, fromPeer);
      if (handled) return true; // ההודעה טופלה כבקשת העברה
    }
    return false;
  };

  // חשיפת מצב הפאנל ל-feed.js עבור לוגיקת התראות | HYPER CORE TECH
  Object.defineProperty(App.chatState, 'isOpen', {
    get: () => state.isOpen,
    enumerable: true
  });
  Object.defineProperty(App.chatState, 'footerMode', {
    get: () => state.footerMode,
    enumerable: true
  });

  initializeUI();
  togglePanel(false);
  ensureChatEnabled();
})(window);
