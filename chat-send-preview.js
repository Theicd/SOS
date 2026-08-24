;(function initChatSendPreview(window) {
  // חלק תצוגה מקדימה (chat-send-preview.js) – מסך מלא בין הדר השיחה לשורת הקלט לפני שליחת קובץ | HYPER CORE TECH
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;

  const FILE_BTN_ID = 'chatComposerFileButton';
  const TRASH_BTN_ID = 'chatComposerTrashButton';
  const HINT_MS = 5000;

  let previewEl = null;
  let objectUrl = null;
  let pendingFile = null;
  let bound = false;
  let savedPlaceholder = '';
  let attachTrash = false;
  let savedFileBtnHtml = '';
  let savedFileBtnLabel = '';
  let hintTimer = 0;

  function $(id) {
    return doc.getElementById(id);
  }

  function conversationRoot() {
    const messages = $('chatMessages');
    return messages && messages.parentElement ? messages.parentElement : null;
  }

  function composerForm() {
    return $('chatComposer');
  }

  function messageInput() {
    return $('chatMessageInput');
  }

  function extOf(name) {
    const parts = String(name || '').split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
  }

  function fileKind(file) {
    const type = String(file && file.type || '').toLowerCase();
    const ext = extOf(file && file.name);
    if (type.startsWith('image/') || /^(jpe?g|png|gif|webp|bmp|heic|heif|svg)$/.test(ext)) return 'image';
    if (type.startsWith('video/') || /^(mp4|m4v|mov|webm|mkv|avi|3gp)$/.test(ext)) return 'video';
    if (type.startsWith('audio/') || /^(mp3|wav|ogg|m4a|flac|aac|opus)$/.test(ext)) return 'audio';
    return 'file';
  }

  function fileIcon(file) {
    const ext = extOf(file && file.name);
    if (ext === 'pdf') return { icon: 'fa-file-pdf', color: '#e74c3c', label: 'PDF' };
    if (/^(zip|rar|7z|tar|gz|bz2)$/.test(ext)) return { icon: 'fa-file-zipper', color: '#f39c12', label: 'קובץ מכווץ' };
    if (/^(doc|docx|odt|rtf)$/.test(ext)) return { icon: 'fa-file-word', color: '#2b7cd0', label: 'מסמך' };
    if (/^(xls|xlsx|csv|ods)$/.test(ext)) return { icon: 'fa-file-excel', color: '#27ae60', label: 'גיליון' };
    if (/^(ppt|pptx|odp)$/.test(ext)) return { icon: 'fa-file-powerpoint', color: '#e67e22', label: 'מצגת' };
    if (/^(txt|log|md)$/.test(ext)) return { icon: 'fa-file-lines', color: '#95a5a6', label: 'טקסט' };
    if (/^(js|py|html|css|json|xml|ts)$/.test(ext)) return { icon: 'fa-file-code', color: '#9b59b6', label: 'קוד' };
    if (/^(apk|exe|msi|dmg)$/.test(ext)) return { icon: 'fa-file-circle-exclamation', color: '#e67e22', label: 'קובץ התקנה' };
    const kind = fileKind(file);
    if (kind === 'audio') return { icon: 'fa-file-audio', color: '#1abc9c', label: 'אודיו' };
    if (kind === 'image') return { icon: 'fa-file-image', color: '#3498db', label: 'תמונה' };
    if (kind === 'video') return { icon: 'fa-file-video', color: '#9b59b6', label: 'וידאו' };
    return { icon: 'fa-file', color: '#00a884', label: 'קובץ' };
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function revokePreviewUrl() {
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch (_) {}
      objectUrl = null;
    }
  }

  function ensurePreviewEl() {
    if (previewEl && previewEl.isConnected) return previewEl;
    const root = conversationRoot();
    if (!root) return null;
    previewEl = doc.createElement('div');
    previewEl.className = 'chat-send-preview';
    previewEl.id = 'chatSendPreview';
    previewEl.hidden = true;
    previewEl.setAttribute('aria-hidden', 'true');
    previewEl.innerHTML =
      '<div class="chat-send-preview__stage" id="chatSendPreviewStage"></div>' +
      '<div class="chat-send-preview__meta" id="chatSendPreviewMeta"></div>' +
      '<button type="button" class="chat-send-preview__hint" id="chatSendPreviewHint" hidden>' +
        '<i class="fa-solid fa-circle-info" aria-hidden="true"></i>' +
        '<span>אפשר להוסיף טקסט, לשלוח, או לבטל בפח</span>' +
      '</button>';
    const messages = $('chatMessages');
    if (messages && messages.parentElement === root) {
      root.insertBefore(previewEl, messages);
    } else {
      root.appendChild(previewEl);
    }
    return previewEl;
  }

  function renderStage(file) {
    const stage = $('chatSendPreviewStage');
    const meta = $('chatSendPreviewMeta');
    if (!stage || !meta) return;
    stage.innerHTML = '';
    revokePreviewUrl();

    const kind = fileKind(file);
    const info = fileIcon(file);
    meta.textContent = (file.name || info.label) + ' · ' + formatSize(file.size);

    if (kind === 'image') {
      objectUrl = URL.createObjectURL(file);
      const img = doc.createElement('img');
      img.className = 'chat-send-preview__media';
      img.alt = file.name || 'תמונה';
      img.src = objectUrl;
      img.addEventListener('error', function () {
        stage.innerHTML = buildFileCardHtml(file, info);
      }, { once: true });
      stage.appendChild(img);
      return;
    }

    if (kind === 'video') {
      objectUrl = URL.createObjectURL(file);
      const video = doc.createElement('video');
      video.className = 'chat-send-preview__media';
      video.src = objectUrl;
      video.controls = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.preload = 'metadata';
      // poster שחור אטום — הישן היה ירוק שקוף ולכן הבזיק ירוק/אפור | HYPER CORE TECH
      video.poster = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGD4DwABBAEAgLvRWwAAAABJRU5ErkJggg==';
      video.style.background = '#000';
      video.style.opacity = '0';
      const showFrame = () => { try { video.style.opacity = '1'; } catch (_) {} };
      video.addEventListener('loadeddata', showFrame, { once: true });
      video.addEventListener('loadedmetadata', () => {
        try {
          if (video.videoWidth > 0) {
            video.currentTime = Math.min(0.05, (video.duration || 1) * 0.01);
          }
        } catch (_) {}
      }, { once: true });
      video.addEventListener('seeked', showFrame, { once: true });
      setTimeout(showFrame, 1800);
      stage.appendChild(video);
      return;
    }

    if (kind === 'audio') {
      objectUrl = URL.createObjectURL(file);
      const wrap = doc.createElement('div');
      wrap.className = 'chat-send-preview__file';
      wrap.innerHTML =
        '<div class="chat-send-preview__file-icon" style="--csp-icon:' + info.color + '">' +
        '<i class="fa-solid ' + info.icon + '"></i></div>' +
        '<div class="chat-send-preview__file-name"></div>' +
        '<div class="chat-send-preview__file-type"></div>';
      wrap.querySelector('.chat-send-preview__file-name').textContent = file.name || info.label;
      wrap.querySelector('.chat-send-preview__file-type').textContent = info.label + ' · ' + formatSize(file.size);
      const audio = doc.createElement('audio');
      audio.className = 'chat-send-preview__audio';
      audio.src = objectUrl;
      audio.controls = true;
      wrap.appendChild(audio);
      stage.appendChild(wrap);
      return;
    }

    stage.innerHTML = buildFileCardHtml(file, info);
  }

  function buildFileCardHtml(file, info) {
    const name = App.escapeHtml ? App.escapeHtml(file.name || info.label) : String(file.name || info.label);
    const type = App.escapeHtml ? App.escapeHtml(info.label) : info.label;
    const size = formatSize(file.size);
    return (
      '<div class="chat-send-preview__file">' +
        '<div class="chat-send-preview__file-icon" style="--csp-icon:' + info.color + '">' +
          '<i class="fa-solid ' + info.icon + '"></i>' +
        '</div>' +
        '<div class="chat-send-preview__file-name">' + name + '</div>' +
        '<div class="chat-send-preview__file-type">' + type + ' · ' + size + '</div>' +
      '</div>'
    );
  }

  function isOpen() {
    return !!(previewEl && !previewEl.hidden && pendingFile);
  }

  function fileButton() {
    return $(FILE_BTN_ID) || $(TRASH_BTN_ID);
  }

  function setTrashMode() {
    const btn = fileButton();
    if (!btn || attachTrash) return;
    attachTrash = true;
    savedFileBtnLabel = btn.getAttribute('aria-label') || '';
    // לא מוחקים innerHTML — ב־desktop ה-input נמצא בתוך ה-label; מחיקה שוברת את בחירת הקובץ | HYPER CORE TECH
    const icon = btn.querySelector('i');
    if (icon) {
      savedFileBtnHtml = icon.className || 'fa-solid fa-paperclip';
      icon.className = 'fa-solid fa-trash';
    } else {
      savedFileBtnHtml = 'fa-solid fa-paperclip';
      const i = doc.createElement('i');
      i.className = 'fa-solid fa-trash';
      btn.insertBefore(i, btn.firstChild);
    }
    btn.classList.add('chat-composer__icon--trash');
    btn.setAttribute('aria-label', 'בטל');
    btn.setAttribute('title', 'בטל');
    const fileInput = btn.querySelector('#chatComposerFileInput') || $('chatComposerFileInput');
    if (fileInput) {
      try { fileInput.value = ''; } catch (_) {}
      fileInput.disabled = true;
    }
  }

  function restoreAttachButton() {
    const btn = fileButton();
    if (!attachTrash) return;
    attachTrash = false;
    if (btn) {
      btn.id = FILE_BTN_ID;
      btn.classList.remove('chat-composer__icon--trash');
      const icon = btn.querySelector('i');
      if (icon) {
        icon.className = savedFileBtnHtml || 'fa-solid fa-paperclip';
      } else {
        btn.insertAdjacentHTML('afterbegin', '<i class="fa-solid fa-paperclip"></i>');
      }
      btn.setAttribute('aria-label', savedFileBtnLabel || 'צרף קובץ');
      btn.removeAttribute('title');
    }
    const fileInput = (btn && btn.querySelector('#chatComposerFileInput')) || $('chatComposerFileInput');
    if (fileInput) fileInput.disabled = false;
    savedFileBtnHtml = '';
    savedFileBtnLabel = '';
  }

  function hideHint() {
    if (hintTimer) {
      clearTimeout(hintTimer);
      hintTimer = 0;
    }
    const hint = $('chatSendPreviewHint');
    if (hint) {
      hint.hidden = true;
      hint.classList.remove('is-visible');
    }
  }

  function showHint() {
    const hint = $('chatSendPreviewHint');
    if (!hint) return;
    hideHint();
    hint.hidden = false;
    hint.classList.add('is-visible');
    hintTimer = window.setTimeout(hideHint, HINT_MS);
  }

  function closePreview() {
    hideHint();
    restoreAttachButton();
    const root = conversationRoot();
    if (root) root.classList.remove('chat-send-preview-open');
    if (previewEl) {
      previewEl.hidden = true;
      previewEl.setAttribute('aria-hidden', 'true');
      const stage = $('chatSendPreviewStage');
      if (stage) stage.innerHTML = '';
    }
    revokePreviewUrl();
    pendingFile = null;
    const input = messageInput();
    if (input && savedPlaceholder) {
      input.setAttribute('placeholder', savedPlaceholder);
    }
    savedPlaceholder = '';
    if (typeof App.updateChatSendIcon === 'function') {
      try { App.updateChatSendIcon(); } catch (_) {}
    }
  }

  function openPreview(file) {
    if (!file) return;
    hideFilePickLoading();
    const el = ensurePreviewEl();
    const root = conversationRoot();
    if (!el || !root) {
      if (typeof App.sendChatSelectedFile === 'function') {
        App.sendChatSelectedFile(file);
      }
      return;
    }
    pendingFile = file;
    renderStage(file);
    root.classList.add('chat-send-preview-open');
    el.hidden = false;
    el.setAttribute('aria-hidden', 'false');
    const input = messageInput();
    if (input) {
      savedPlaceholder = input.getAttribute('placeholder') || 'כתוב הודעה...';
      input.setAttribute('placeholder', 'הוסף כיתוב...');
    }
    forceSendIcon();
    setTrashMode();
    showHint();
    bindOnce();
  }

  function forceSendIcon() {
    const btn = composerForm()?.querySelector('.chat-composer__send, [type="submit"], [type="button"].chat-composer__send');
    if (!btn) return;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
    btn.classList.remove('is-mic', 'is-mic-recording');
    btn.classList.add('chat-composer__send--active');
    btn.type = 'submit';
  }

  function sendPending() {
    const file = pendingFile;
    if (!file) return;
    const input = messageInput();
    const caption = (input && input.value || '').trim();
    // כיתוב נשאר בטיוטה עד שליחת הקובץ — הודעה אחת (מדיה+טקסט), בלי שליחה כפולה | HYPER CORE TECH
    if (input) input.value = caption;
    closePreview();
    const clearDraft = function () {
      if (!input) return;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    if (typeof App.sendChatSelectedFile === 'function') {
      Promise.resolve(App.sendChatSelectedFile(file))
        .catch(function (err) {
          console.error('[CHAT-SEND-PREVIEW] send failed', err);
        })
        .finally(clearDraft);
    } else {
      console.error('[CHAT-SEND-PREVIEW] sendChatSelectedFile missing');
      clearDraft();
    }
  }

  function onSendClick(event) {
    if (!isOpen()) return;
    const send = event.target && event.target.closest
      ? event.target.closest('.chat-composer__send, button[type="submit"]')
      : null;
    if (!send) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    sendPending();
  }

  function onComposerSubmit(event) {
    if (!isOpen()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    sendPending();
  }

  function isAttachControl(target) {
    if (!target || !target.closest) return false;
    return !!(
      target.closest('#' + FILE_BTN_ID) ||
      target.closest('#' + TRASH_BTN_ID) ||
      target.closest('#chatComposerFileInput') ||
      target.closest('.chat-composer__icon--trash')
    );
  }

  function onAttachClick(event) {
    if (!isOpen()) return;
    if (!isAttachControl(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    closePreview();
  }

  function onBackClick(event) {
    if (!isOpen()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closePreview();
  }

  function onKeydown(event) {
    if (!isOpen()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closePreview();
    }
  }

  function bindOnce() {
    if (bound) return;
    bound = true;
    const form = composerForm();
    if (form) {
      form.addEventListener('submit', onComposerSubmit, true);
      form.addEventListener('click', onSendClick, true);
    }
    const input = messageInput();
    if (input) {
      input.addEventListener('input', function () {
        if (isOpen()) forceSendIcon();
      });
    }
    const backBtn = $('chatConversationBack');
    if (backBtn) backBtn.addEventListener('click', onBackClick, true);
    const actionsBack = $('chatConversationActionsBack');
    if (actionsBack) actionsBack.addEventListener('click', onBackClick, true);
    doc.addEventListener('click', onAttachClick, true);
    doc.addEventListener('keydown', onKeydown);
  }

  App.openChatSendPreview = openPreview;
  App.closeChatSendPreview = closePreview;
  App.isChatSendPreviewOpen = isOpen;

  // חלק תצוגה מקדימה – שכבת טעינה במרכז עד שהקובץ מוכן לתצוגה מקדימה | HYPER CORE TECH
  function showFilePickLoading(label) {
    let el = $('chatFilePickLoading');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'chatFilePickLoading';
      el.className = 'chat-file-pick-loading';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.innerHTML =
        '<div class="chat-file-pick-loading__card">' +
          '<i class="fa-solid fa-spinner fa-spin chat-file-pick-loading__icon" aria-hidden="true"></i>' +
          '<span class="chat-file-pick-loading__text"></span>' +
        '</div>';
      doc.body.appendChild(el);
    }
    const textEl = el.querySelector('.chat-file-pick-loading__text');
    if (textEl) textEl.textContent = (label && String(label).trim()) || 'טוען...';
    el.hidden = false;
    el.classList.add('is-visible');
    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.showFilePickLoading === 'function') {
        bridge.showFilePickLoading((label && String(label).trim()) || 'טוען...');
      }
    } catch (_) {}
  }

  function hideFilePickLoading() {
    const el = $('chatFilePickLoading');
    if (el) {
      el.classList.remove('is-visible');
      el.hidden = true;
    }
    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.hideFilePickLoading === 'function') {
        bridge.hideFilePickLoading();
      }
    } catch (_) {}
  }

  App.showChatFilePickLoading = showFilePickLoading;
  App.hideChatFilePickLoading = hideFilePickLoading;
})(window);
