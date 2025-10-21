(function initChatFileTransferState(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק צ'אט (chat-file-transfer-state.js) – ניהול מצבי קובץ מצורף לכל שיחה עבור פונקציית שיתוף הקבצים
  if (App.chatFileTransferState) {
    return;
  }

  const attachments = new Map();
  const listeners = {
    change: new Set(),
    error: new Set(),
  };

  function normalizePeer(peerPubkey) {
    return typeof peerPubkey === 'string' ? peerPubkey.toLowerCase() : '';
  }

  function cloneAttachment(attachment) {
    if (!attachment) {
      return null;
    }
    return {
      id: attachment.id,
      name: attachment.name,
      size: attachment.size,
      type: attachment.type,
      dataUrl: attachment.dataUrl,
      addedAt: attachment.addedAt,
      caption: attachment.caption || '',
    };
  }

  function notify(type, payload) {
    const bucket = listeners[type];
    if (!bucket) {
      return;
    }
    bucket.forEach((callback) => {
      try {
        callback(payload);
      } catch (err) {
        console.warn('Chat file transfer listener failed', err);
      }
    });
  }

  function setAttachment(peerPubkey, attachment) {
    const normalized = normalizePeer(peerPubkey);
    if (!normalized || !attachment) {
      return;
    }
    attachments.set(normalized, {
      ...attachment,
      addedAt: attachment.addedAt || Date.now(),
    });
    notify('change', { peer: normalized, attachment: cloneAttachment(attachments.get(normalized)) });
  }

  function clearAttachment(peerPubkey) {
    const normalized = normalizePeer(peerPubkey);
    if (!normalized) {
      return;
    }
    const hadAttachment = attachments.delete(normalized);
    if (hadAttachment) {
      notify('change', { peer: normalized, attachment: null });
    }
  }

  function getAttachment(peerPubkey) {
    return cloneAttachment(attachments.get(normalizePeer(peerPubkey)));
  }

  function hasAttachment(peerPubkey) {
    return attachments.has(normalizePeer(peerPubkey));
  }

  function subscribe(topic, callback) {
    if (!listeners[topic]) {
      listeners[topic] = new Set();
    }
    listeners[topic].add(callback);
    return () => listeners[topic].delete(callback);
  }

  function reportError(details) {
    notify('error', details);
  }

  App.chatFileTransferState = {
    attachments,
    listeners,
  };

  Object.assign(App, {
    setChatFileAttachment: setAttachment,
    clearChatFileAttachment: clearAttachment,
    getChatFileAttachment: getAttachment,
    hasChatFileAttachment: hasAttachment,
    subscribeChatFileTransfer: subscribe,
    notifyChatFileTransferError: reportError,
  });
})(window);
