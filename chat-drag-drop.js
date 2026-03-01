// =====================================================================================
// חלק Drag & Drop (chat-drag-drop.js) – גרירת קבצים לחלון השיחה בסגנון WhatsApp | HYPER CORE TECH
// קובץ ייעודי: overlay, תצוגה מקדימה, שדה כיתוב, כפתור שליחה — דסקטופ בלבד
// =====================================================================================
(function initChatDragDrop(window) {
  'use strict';
  var App = window.NostrApp || (window.NostrApp = {});
  var doc = window.document;

  // ── משתני מצב (chat-drag-drop.js) | HYPER CORE TECH ──
  var dragCounter   = 0;
  var dropOverlayEl = null;
  var dropPreviewEl = null;
  var droppedFile   = null;

  function isDesktop() { return window.innerWidth > 768; }

  // ── אייקון קובץ (chat-drag-drop.js) – Font Awesome לפי סיומת | HYPER CORE TECH ──
  function _fileIcon(n) {
    var e = (n || '').split('.').pop().toLowerCase();
    if ('jpg jpeg png gif webp svg bmp heic'.split(' ').indexOf(e) !== -1) return 'fa-file-image';
    if ('mp4 webm avi mov mkv flv'.split(' ').indexOf(e) !== -1) return 'fa-file-video';
    if ('mp3 wav ogg m4a flac aac'.split(' ').indexOf(e) !== -1) return 'fa-file-audio';
    if (e === 'pdf') return 'fa-file-pdf';
    if ('zip rar 7z tar gz bz2'.split(' ').indexOf(e) !== -1) return 'fa-file-zipper';
    if ('doc docx odt rtf'.split(' ').indexOf(e) !== -1) return 'fa-file-word';
    if ('xls xlsx csv ods'.split(' ').indexOf(e) !== -1) return 'fa-file-excel';
    if ('ppt pptx odp'.split(' ').indexOf(e) !== -1) return 'fa-file-powerpoint';
    if ('txt log md'.split(' ').indexOf(e) !== -1) return 'fa-file-lines';
    if ('js py html css json xml ts'.split(' ').indexOf(e) !== -1) return 'fa-file-code';
    if ('exe apk msi dmg'.split(' ').indexOf(e) !== -1) return 'fa-file-circle-exclamation';
    return 'fa-file';
  }

  // ── צבע אייקון (chat-drag-drop.js) – צבע לפי סוג קובץ | HYPER CORE TECH ──
  function _iconColor(n) {
    var e = (n || '').split('.').pop().toLowerCase();
    if (e === 'pdf') return '#e74c3c';
    if ('doc docx odt rtf'.split(' ').indexOf(e) !== -1) return '#2b7cd0';
    if ('xls xlsx csv ods'.split(' ').indexOf(e) !== -1) return '#27ae60';
    if ('ppt pptx odp'.split(' ').indexOf(e) !== -1) return '#e67e22';
    if ('zip rar 7z tar gz bz2'.split(' ').indexOf(e) !== -1) return '#f39c12';
    return '#00a884';
  }

  // ── גודל קובץ (chat-drag-drop.js) – פורמט קריא | HYPER CORE TECH ──
  function _fmtSize(b) {
    if (!b) return '';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  // =====================================================================================
  // חלק Overlay (chat-drag-drop.js) – שכבת "שחרר כאן כדי לשלוח" | HYPER CORE TECH
  // =====================================================================================
  function _ensureOverlay(panel) {
    if (dropOverlayEl) return dropOverlayEl;
    dropOverlayEl = doc.createElement('div');
    dropOverlayEl.className = 'chat-drop-overlay';
    dropOverlayEl.innerHTML =
      '<div class="chat-drop-overlay__content">' +
      '<i class="fa-solid fa-cloud-arrow-up chat-drop-overlay__icon"></i>' +
      '<span class="chat-drop-overlay__text">\u05E9\u05D7\u05E8\u05E8 \u05DB\u05D0\u05DF \u05DB\u05D3\u05D9 \u05DC\u05E9\u05DC\u05D5\u05D7</span>' +
      '</div>';
    panel.appendChild(dropOverlayEl);
    return dropOverlayEl;
  }
  function _showOverlay(p) { _ensureOverlay(p).classList.add('is-visible'); }
  function _hideOverlay()  { if (dropOverlayEl) dropOverlayEl.classList.remove('is-visible'); }

  // =====================================================================================
  // חלק ניקוי תצוגה (chat-drag-drop.js) – הסרת דיאלוג + שחרור Object URLs | HYPER CORE TECH
  // =====================================================================================
  function _removePreview() {
    if (!dropPreviewEl) return;
    var img = dropPreviewEl.querySelector('.cdd-preview-img');
    var vid = dropPreviewEl.querySelector('.cdd-preview-vid');
    if (img && img.src) URL.revokeObjectURL(img.src);
    if (vid && vid.src) URL.revokeObjectURL(vid.src);
    dropPreviewEl.remove();
    dropPreviewEl = null;
  }
  function _closePreview() { _removePreview(); droppedFile = null; }

  // =====================================================================================
  // חלק תצוגה מקדימה (chat-drag-drop.js) – מסך מלא בסגנון WhatsApp | HYPER CORE TECH
  // תמונה: תצוגת תמונה מלאה | וידאו: נגן וידאו | PDF: embed מלא | אחר: אייקון גדול
  // =====================================================================================
  function _showPreview(file, chatPanel) {
    _removePreview();
    droppedFile = file;

    var isImg = file.type && file.type.startsWith('image/');
    var isVid = file.type && file.type.startsWith('video/');
    var isPdf = file.type === 'application/pdf' || (file.name || '').toLowerCase().endsWith('.pdf');
    var icon  = _fileIcon(file.name);
    var clr   = _iconColor(file.name);

    dropPreviewEl = doc.createElement('div');
    dropPreviewEl.className = 'chat-drop-preview';

    // ── backdrop (chat-drag-drop.js) | HYPER CORE TECH ──
    var backdrop = doc.createElement('div');
    backdrop.className = 'chat-drop-preview__backdrop';
    dropPreviewEl.appendChild(backdrop);

    // ── container (chat-drag-drop.js) | HYPER CORE TECH ──
    var container = doc.createElement('div');
    container.className = 'chat-drop-preview__container';
    dropPreviewEl.appendChild(container);

    // ── header: כפתור סגירה (chat-drag-drop.js) | HYPER CORE TECH ──
    var header = doc.createElement('div');
    header.className = 'chat-drop-preview__header';
    header.innerHTML = '<button type="button" class="chat-drop-preview__close" aria-label="close"><i class="fa-solid fa-xmark"></i></button>';
    container.appendChild(header);

    // ── אזור תצוגה (chat-drag-drop.js) – חלק מרכזי עם התצוגה המקדימה | HYPER CORE TECH ──
    var viewArea = doc.createElement('div');
    viewArea.className = 'chat-drop-preview__view';
    container.appendChild(viewArea);

    if (isImg) {
      var imgEl = doc.createElement('img');
      imgEl.className = 'cdd-preview-img';
      imgEl.alt = file.name;
      imgEl.src = URL.createObjectURL(file);
      viewArea.appendChild(imgEl);
    } else if (isVid) {
      var vidEl = doc.createElement('video');
      vidEl.className = 'cdd-preview-vid';
      vidEl.controls = true;
      vidEl.playsInline = true;
      vidEl.muted = true;
      vidEl.src = URL.createObjectURL(file);
      viewArea.appendChild(vidEl);
    } else if (isPdf) {
      var pdfObj = doc.createElement('embed');
      pdfObj.className = 'cdd-preview-pdf';
      pdfObj.type = 'application/pdf';
      pdfObj.src = URL.createObjectURL(file);
      viewArea.appendChild(pdfObj);
    } else {
      // קובץ כללי – אייקון גדול + שם + גודל (chat-drag-drop.js) | HYPER CORE TECH
      var generic = doc.createElement('div');
      generic.className = 'cdd-preview-generic';
      generic.innerHTML =
        '<i class="fa-solid ' + icon + ' cdd-preview-generic__icon" style="color:' + clr + '"></i>' +
        '<span class="cdd-preview-generic__name">' + file.name + '</span>' +
        '<span class="cdd-preview-generic__size">' + _fmtSize(file.size) + '</span>';
      viewArea.appendChild(generic);
    }

    // ── שורת פרטי קובץ (chat-drag-drop.js) – מתחת לתצוגה | HYPER CORE TECH ──
    var fileBar = doc.createElement('div');
    fileBar.className = 'chat-drop-preview__file-bar';
    fileBar.innerHTML =
      '<i class="fa-solid ' + icon + '" style="color:' + clr + ';font-size:1.2rem"></i>' +
      '<span class="chat-drop-preview__file-bar-name">' + file.name + '</span>' +
      '<span class="chat-drop-preview__file-bar-size">' + _fmtSize(file.size) + '</span>';
    container.appendChild(fileBar);

    // ── שדה כיתוב + כפתור שליחה (chat-drag-drop.js) – תחתית בסגנון WhatsApp | HYPER CORE TECH ──
    var footer = doc.createElement('div');
    footer.className = 'chat-drop-preview__footer';
    footer.innerHTML =
      '<input type="text" class="chat-drop-preview__caption" placeholder="\u05D4\u05D5\u05E1\u05E4\u05EA \u05DB\u05D9\u05EA\u05D5\u05D1..." maxlength="500" dir="rtl">' +
      '<button type="button" class="chat-drop-preview__send" aria-label="send"><i class="fa-solid fa-paper-plane"></i></button>';
    container.appendChild(footer);

    chatPanel.appendChild(dropPreviewEl);

    // ── מניעת סגירת הצ'אט (chat-drag-drop.js) | HYPER CORE TECH ──
    dropPreviewEl.addEventListener('click', function(e) { e.stopPropagation(); });

    // ── אירועי סגירה (chat-drag-drop.js) | HYPER CORE TECH ──
    var closeBtn = header.querySelector('.chat-drop-preview__close');
    closeBtn.addEventListener('click', _closePreview);
    backdrop.addEventListener('click', _closePreview);

    // ── אירוע Escape (chat-drag-drop.js) | HYPER CORE TECH ──
    function onKey(e) {
      if (e.key === 'Escape') { _closePreview(); doc.removeEventListener('keydown', onKey); }
    }
    doc.addEventListener('keydown', onKey);

    // ── אירוע שליחה (chat-drag-drop.js) – שולח קובץ דרך handleChatFileSelection | HYPER CORE TECH ──
    var sendBtn = footer.querySelector('.chat-drop-preview__send');
    var captionInput = footer.querySelector('.chat-drop-preview__caption');

    sendBtn.addEventListener('click', function() {
      if (!droppedFile) return;
      var caption = captionInput.value.trim();
      // הזנת כיתוב לתיבת ההודעה הראשית (chat-drag-drop.js) | HYPER CORE TECH
      if (caption) {
        var ta = doc.querySelector('.chat-composer textarea');
        if (ta) {
          ta.value = caption;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      if (typeof App.handleChatFileSelection === 'function') {
        App.handleChatFileSelection(droppedFile);
      }
      _closePreview();
      doc.removeEventListener('keydown', onKey);
    });

    // ── Enter שולח (chat-drag-drop.js) | HYPER CORE TECH ──
    captionInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
    });

    setTimeout(function() { captionInput.focus(); }, 120);
  }

  // =====================================================================================
  // חלק אתחול (chat-drag-drop.js) – חיבור אירועי drag ל-chatPanel | HYPER CORE TECH
  // =====================================================================================
  function setupChatDragDrop() {
    var chatPanel = doc.getElementById('chatPanel');
    if (!chatPanel) { console.warn('[DRAG-DROP] chatPanel not found'); return; }

    chatPanel.addEventListener('dragenter', function(e) {
      if (!isDesktop()) return;
      e.preventDefault(); e.stopPropagation();
      dragCounter++;
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') !== -1) {
        _showOverlay(chatPanel);
      }
    });

    chatPanel.addEventListener('dragover', function(e) {
      if (!isDesktop()) return;
      e.preventDefault(); e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });

    chatPanel.addEventListener('dragleave', function(e) {
      if (!isDesktop()) return;
      e.preventDefault(); e.stopPropagation();
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; _hideOverlay(); }
    });

    chatPanel.addEventListener('drop', function(e) {
      if (!isDesktop()) return;
      e.preventDefault(); e.stopPropagation();
      dragCounter = 0;
      _hideOverlay();
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      var peer = App.chatState && App.chatState.activeContact;
      if (!peer) { console.warn('[DRAG-DROP] no active chat'); return; }
      _showPreview(file, chatPanel);
    });

    console.log('[DRAG-DROP] initialized on chatPanel');
  }

  // ── אתחול (chat-drag-drop.js) | HYPER CORE TECH ──
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', setupChatDragDrop);
  } else {
    setTimeout(setupChatDragDrop, 200);
  }

  // ── API ציבורי (chat-drag-drop.js) | HYPER CORE TECH ──
  App.setupChatDragDrop = setupChatDragDrop;

  console.log('[DRAG-DROP] module loaded');
})(window);
