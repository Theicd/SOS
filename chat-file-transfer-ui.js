(function initChatFileTransferUI(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק צ'אט (chat-file-transfer-ui.js) – שליטה ברכיבי UI עבור בחירת קבצים בצ'אט
  if (App.initializeChatFileTransferUI) {
    return;
  }

  const MAX_INLINE_SIZE_BYTES = 90 * 1024; // 90KB inline בהודעה
  const MAX_P2P_SIZE_BYTES = 100 * 1024 * 1024; // 100MB דרך P2P

  let uiRefs = {
    fileButton: null,
    fileInput: null,
    filePreview: null,
    fileNameLabel: null,
    fileRemove: null,
    getActivePeer: () => null,
    getMessageDraft: () => '',
  };

  let currentAttachment = null;

  function setUIRefs(config) {
    uiRefs = {
      fileButton: config.fileButton || null,
      fileInput: config.fileInput || null,
      filePreview: config.filePreview || null,
      fileNameLabel: config.fileNameLabel || null,
      fileRemove: config.fileRemove || null,
      getActivePeer: typeof config.getActivePeer === 'function' ? config.getActivePeer : () => null,
      getMessageDraft: typeof config.getMessageDraft === 'function' ? config.getMessageDraft : () => '',
    };
  }

  function log(...args) {
    try {
      console.log('[CHAT/FILE-UI]', ...args);
    } catch (_) {}
  }

  function renderPreview(attachment) {
    currentAttachment = attachment;
    if (!uiRefs.filePreview || !uiRefs.fileNameLabel) {
      return;
    }
    if (!attachment) {
      uiRefs.filePreview.setAttribute('hidden', '');
      uiRefs.fileNameLabel.textContent = '';
      return;
    }
    uiRefs.filePreview.removeAttribute('hidden');
    const sizeStr = attachment.size > 1024 * 1024 
      ? `${(attachment.size / (1024 * 1024)).toFixed(1)}MB`
      : `${(attachment.size / 1024).toFixed(0)}KB`;
    uiRefs.fileNameLabel.textContent = `${attachment.name || 'קובץ מצורף'} (${sizeStr})`;
  }

  function ensurePeer() {
    const peer = uiRefs.getActivePeer();
    if (!peer) {
      App.notifyChatFileTransferError?.({
        code: 'missing-peer',
        message: 'לא נבחר נמען לשיתוף הקובץ.',
      });
      return null;
    }
    return peer;
  }

  function validateFile(file) {
    if (!file) {
      return false;
    }
    if (file.size > MAX_P2P_SIZE_BYTES) {
      App.notifyChatFileTransferError?.({
        code: 'file-too-large',
        message: `הקובץ גדול מדי (מעל ${MAX_P2P_SIZE_BYTES / (1024 * 1024)}MB).`,
      });
      return false;
    }
    return true;
  }

  async function handleFileSelection(file) {
    const peer = ensurePeer();
    if (!peer || !validateFile(file)) {
      return;
    }
    log('בחר קובץ', { name: file.name, size: file.size, type: file.type });
    
    // חלק קבצים גדולים (chat-file-transfer-ui.js) – שימוש ב-P2P לקבצים מעל 90KB | HYPER CORE TECH
    if (file.size > MAX_INLINE_SIZE_BYTES) {
      if (typeof App.sendP2PFile === 'function') {
        const previewUrl = URL.createObjectURL(file);
        const fileId = await App.sendP2PFile(peer, file, App.handleP2PProgressUpdate || undefined);
        log('שולח P2P', { peer, fileId, name: file.name, size: file.size });
        // חלק P2P (chat-file-transfer-ui.js) – לא מציג preview תחתון לקבצי P2P כי ההעברה כבר מתחילה | HYPER CORE TECH
        // ה-progress bubble מוצג ב-messages container, אין צורך ב-preview נוסף
        // נשמור את ה-attachment ב-state אבל לא נציג preview כפול
        const attachment = {
          id: `${peer}-${Date.now()}`,
          name: file.name,
          size: file.size,
          type: file.type,
          isP2P: true,
          file: file,
          fileId,
          previewUrl,
          caption: uiRefs.getMessageDraft() || '',
          transferStarted: true, // סימון שההעברה כבר התחילה
        };
        App.setChatFileAttachment?.(peer, attachment);
        // לא קוראים ל-renderPreview עבור P2P - ה-transfer bubble כבר מוצג
        return;
      } else {
        App.notifyChatFileTransferError?.({
          code: 'p2p-unavailable',
          message: 'מערכת P2P לא זמינה. נסה קובץ קטן יותר.',
        });
        return;
      }
    }
    
    // חלק קבצים קטנים (chat-file-transfer-ui.js) – inline DataURL לקבצים עד 90KB | HYPER CORE TECH
    const reader = new FileReader();
    reader.onload = () => {
      const attachment = {
        id: `${peer}-${Date.now()}`,
        name: file.name,
        size: file.size,
        type: file.type,
        dataUrl: typeof reader.result === 'string' ? reader.result : '',
        caption: uiRefs.getMessageDraft() || '',
      };
      App.setChatFileAttachment?.(peer, attachment);
      renderPreview(attachment);
    };
    reader.onerror = () => {
      App.notifyChatFileTransferError?.({
        peer,
        code: 'read-error',
        message: 'אירעה שגיאה בקריאת הקובץ שבחרת.',
      });
    };
    reader.readAsDataURL(file);
  }

  function clearAttachmentForPeer(peer) {
    App.clearChatFileAttachment?.(peer);
    renderPreview(null);
  }

  function onFileButtonClick(event) {
    event.preventDefault();
    if (!uiRefs.fileInput) {
      return;
    }
    uiRefs.fileInput.value = '';
    uiRefs.fileInput.click();
  }

  function onFileInputChange(event) {
    const files = event.target?.files;
    if (!files || !files.length) {
      return;
    }
    handleFileSelection(files[0]);
  }

  function onFileRemove(event) {
    event.preventDefault();
    const peer = ensurePeer();
    if (!peer) {
      return;
    }
    clearAttachmentForPeer(peer);
  }

  function setActivePeer(peerPubkey) {
    const normalized = typeof peerPubkey === 'string' ? peerPubkey.toLowerCase() : '';
    if (!normalized) {
      renderPreview(null);
      return;
    }
    const attachment = App.getChatFileAttachment?.(normalized) || null;
    // חלק P2P (chat-file-transfer-ui.js) – לא מציג preview עבור קבצי P2P שההעברה כבר התחילה | HYPER CORE TECH
    if (attachment?.isP2P && attachment?.transferStarted) {
      renderPreview(null); // מסתיר preview כי ה-transfer bubble מוצג
      return;
    }
    renderPreview(attachment);
  }

  function clearUI() {
    renderPreview(null);
  }

  function bindDomEvents() {
    if (uiRefs.fileButton) {
      uiRefs.fileButton.addEventListener('click', onFileButtonClick);
    }
    if (uiRefs.fileInput) {
      uiRefs.fileInput.addEventListener('change', onFileInputChange);
    }
    if (uiRefs.fileRemove) {
      uiRefs.fileRemove.addEventListener('click', onFileRemove);
    }
  }

  function subscribeState() {
    App.subscribeChatFileTransfer?.('change', ({ peer, attachment }) => {
      const activePeer = uiRefs.getActivePeer();
      if (peer !== activePeer) {
        return;
      }
      // חלק P2P (chat-file-transfer-ui.js) – לא מציג preview עבור קבצי P2P שההעברה כבר התחילה | HYPER CORE TECH
      if (attachment?.isP2P && attachment?.transferStarted) {
        return; // ה-transfer bubble מוצג במקום
      }
      renderPreview(attachment);
    });
    App.subscribeChatFileTransfer?.('error', (details) => {
      console.warn('Chat file transfer error', details);
      if (details?.peer && details.peer === uiRefs.getActivePeer()) {
        clearAttachmentForPeer(details.peer);
      }
    });
  }

  function initializeChatFileTransferUI(config) {
    setUIRefs(config || {});
    bindDomEvents();
    subscribeState();
    renderPreview(null);
  }

  Object.assign(App, {
    initializeChatFileTransferUI,
    setChatFileTransferActivePeer: setActivePeer,
    clearChatFileTransferUI: clearUI,
  });
})(window);
