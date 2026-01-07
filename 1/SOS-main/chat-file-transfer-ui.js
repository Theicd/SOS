(function initChatFileTransferUI(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק צ'אט (chat-file-transfer-ui.js) – שליטה ברכיבי UI עבור בחירת קבצים בצ'אט
  if (App.initializeChatFileTransferUI) {
    return;
  }

  const MAX_FILE_SIZE_BYTES = 60 * 1024;

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
    uiRefs.fileNameLabel.textContent = attachment.name || 'קובץ מצורף';
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
    if (file.size > MAX_FILE_SIZE_BYTES) {
      App.notifyChatFileTransferError?.({
        code: 'file-too-large',
        message: 'הקובץ גדול מדי לשליחה בהודעה אחת (מעל ‎90KB‎).',
      });
      return false;
    }
    return true;
  }

  function handleFileSelection(file) {
    const peer = ensurePeer();
    if (!peer || !validateFile(file)) {
      return;
    }
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
