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

  function isEncryptedMediaAttachment(attachment) {
    return !!(
      attachment &&
      typeof attachment === 'object' &&
      (attachment.type === 'encrypted-media' ||
        (typeof App.isEncryptedBlossomDescriptor === 'function' &&
          App.isEncryptedBlossomDescriptor(attachment)))
    );
  }

  /**
   * Network-safe encrypted-media allowlist (E3B inner payload / inspect).
   * Excludes local secrets (_prepared, blobs, object URLs).
   */
  function buildEncryptedAttachmentWireDescriptor(attachment) {
    if (!isEncryptedMediaAttachment(attachment)) return null;
    const wire = {
      v: attachment.v,
      type: 'encrypted-media',
      attachmentId: attachment.attachmentId,
      enc: attachment.enc,
      cipher: attachment.cipher,
      media: attachment.media,
      resource: attachment.resource,
    };
    if (Array.isArray(attachment.chunks)) wire.chunks = attachment.chunks;
    if (typeof attachment.chunkCount === 'number') wire.chunkCount = attachment.chunkCount;
    if (typeof attachment.chunkPlaintextSize === 'number') {
      wire.chunkPlaintextSize = attachment.chunkPlaintextSize;
    }
    if (typeof attachment.duration === 'number' && Number.isFinite(attachment.duration)) {
      wire.duration = attachment.duration;
    }
    if (attachment.isVoice === true) wire.isVoice = true;
    if (typeof attachment.magnetURI === 'string' && attachment.magnetURI) {
      wire.magnetURI = attachment.magnetURI;
    }
    if (typeof attachment.infoHash === 'string' && attachment.infoHash) {
      wire.infoHash = attachment.infoHash;
    }
    if (attachment.isTorrent === true) wire.isTorrent = true;
    return wire;
  }

  /**
   * State/UI clone for getChatFileAttachment.
   * Preserves full crypto descriptor + stable message ids + UI/P2P fields.
   * Never copies local-only heavy/secret fields.
   */
  function cloneAttachment(attachment) {
    if (!attachment) {
      return null;
    }
    if (isEncryptedMediaAttachment(attachment)) {
      const wire = buildEncryptedAttachmentWireDescriptor(attachment);
      if (!wire) return null;
      const out = Object.assign({}, wire);
      // Stable AES-GCM AAD context (local; not required on wire but needed for publish).
      if (typeof attachment.clientMessageId === 'string' && attachment.clientMessageId) {
        out.clientMessageId = attachment.clientMessageId;
      }
      if (typeof attachment.logicalMessageId === 'string' && attachment.logicalMessageId) {
        out.logicalMessageId = attachment.logicalMessageId;
      }
      // UI / composer / P2P adjuncts
      if (attachment.id != null) out.id = attachment.id;
      if (attachment.name != null) out.name = attachment.name;
      if (typeof attachment.size === 'number') out.size = attachment.size;
      if (attachment.caption) out.caption = attachment.caption;
      if (attachment.isVideo) out.isVideo = true;
      if (attachment.hidePreview === true) out.hidePreview = true;
      if (attachment.fileId) out.fileId = attachment.fileId;
      if (attachment.isP2P) out.isP2P = true;
      if (attachment.transferStarted) out.transferStarted = true;
      if (attachment.previewUrl) out.previewUrl = attachment.previewUrl;
      if (attachment.addedAt) out.addedAt = attachment.addedAt;
      // Explicitly omit: _prepared, _resolvedBlob, _localObjectUrl, raw blobs/files.
      return out;
    }
    // Legacy / UI attachment clone
    return {
      id: attachment.id,
      name: attachment.name,
      size: attachment.size,
      type: attachment.type,
      dataUrl: attachment.dataUrl,
      url: attachment.url,
      previewUrl: attachment.previewUrl || '',
      duration: attachment.duration,
      addedAt: attachment.addedAt,
      caption: attachment.caption || '',
      isP2P: attachment.isP2P || false,
      isVoice: attachment.isVoice || false,
      transferStarted: attachment.transferStarted || false,
      hidePreview: attachment.hidePreview === true,
      fileId: attachment.fileId || null,
      magnetURI: attachment.magnetURI || '',
      infoHash: attachment.infoHash || '',
      isTorrent: attachment.isTorrent || false,
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
    // חלק צ'אט (chat-file-transfer-state.js) – עדכון אייקון כפתור שליחה כשמצרפים קובץ | HYPER CORE TECH
    if (typeof App.updateChatSendIcon === 'function') {
      App.updateChatSendIcon();
    }
  }

  function clearAttachment(peerPubkey) {
    const normalized = normalizePeer(peerPubkey);
    if (!normalized) {
      return;
    }
    const hadAttachment = attachments.delete(normalized);
    if (hadAttachment) {
      notify('change', { peer: normalized, attachment: null });
      // חלק צ'אט (chat-file-transfer-state.js) – עדכון אייקון כפתור שליחה כשמסירים קובץ | HYPER CORE TECH
      if (typeof App.updateChatSendIcon === 'function') {
        App.updateChatSendIcon();
      }
    }
  }

  function getAttachment(peerPubkey) {
    return cloneAttachment(attachments.get(normalizePeer(peerPubkey)));
  }

  function hasAttachment(peerPubkey) {
    const attachment = attachments.get(normalizePeer(peerPubkey));
    // חלק חסימת שליחה כפולה (chat-file-transfer-state.js) – קובץ P2P שההעברה שלו כבר התחילה לא נחשב כמצורף ממתין | HYPER CORE TECH
    if (attachment?.isP2P && attachment?.transferStarted) {
      return false;
    }
    return Boolean(attachment);
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
    buildEncryptedAttachmentWireDescriptor,
    cloneChatFileAttachment: cloneAttachment,
  });
})(window);
