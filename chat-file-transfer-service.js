(function initChatFileTransferService(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק צ'אט (chat-file-transfer-service.js) – לוגיקת העברת קבצים בצ'אט באמצעות נוטר + בסיס נתונים מקומי
  if (App.serializeChatMessageContent) {
    return;
  }

  // חלק תיקון קול ארוך (chat-file-transfer-service.js) – הגדלת סף inline ל-256KB לתמיכה בהודעות קוליות ארוכות | HYPER CORE TECH
  const MAX_INLINE_SIZE = 256 * 1024;

  // חלק חישוב גודל (chat-file-transfer-service.js) – הערכת גודל dataUrl בבתים במקום length גולמי | HYPER CORE TECH
  function estimateDataUrlBytes(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return 0;
    const commaIndex = dataUrl.indexOf(',');
    if (commaIndex === -1) return 0;
    const base64 = dataUrl.slice(commaIndex + 1);
    const pad = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor((base64.length * 3) / 4) - pad);
  }

  function getActiveAttachment(peerPubkey) {
    if (typeof App.getChatFileAttachment !== 'function') {
      return null;
    }
    const attachment = App.getChatFileAttachment(peerPubkey);
    // P2P שכבר נשלח — לא לצרף את אותו קובץ להודעת טקסט הבאה | HYPER CORE TECH
    if (attachment?.isP2P && attachment?.transferStarted) {
      return null;
    }
    return attachment;
  }

  function resetAttachment(peerPubkey) {
    if (typeof App.clearChatFileAttachment === 'function') {
      App.clearChatFileAttachment(peerPubkey);
    }
  }

  function isEncryptedVoiceAttachment(attachment) {
    if (!attachment || typeof attachment !== 'object') return false;
    if (attachment.isVoice === true) return true;
    const mediaMime =
      attachment.media && typeof attachment.media.mime === 'string'
        ? attachment.media.mime.toLowerCase()
        : '';
    if (mediaMime.startsWith('audio/') || mediaMime === 'application/ogg') return true;
    const mediaName =
      attachment.media && typeof attachment.media.filename === 'string'
        ? attachment.media.filename.toLowerCase()
        : '';
    if (mediaName.includes('voice') || mediaName.includes('ptt') || mediaName.includes('voicemessage')) {
      return true;
    }
    return false;
  }

  function isAudioLikeAttachment(attachment) {
    if (!attachment || typeof attachment !== 'object') return false;
    if (isEncryptedVoiceAttachment(attachment)) return true;
    if (typeof attachment.type === 'string' && attachment.type.indexOf('audio/') === 0) return true;
    if (attachment.type === 'application/ogg') return true;
    const name = String(attachment.name || '').toLowerCase();
    if (name.includes('voice') || name.endsWith('.webm') || name.endsWith('.ogg') || name.endsWith('.mp3')) {
      return true;
    }
    return typeof attachment.duration === 'number' && attachment.duration > 0;
  }

  function serializeAttachment(attachment) {
    if (!attachment) {
      return null;
    }
    // M4: encrypted Blossom v2 descriptor — passthrough private fields (inside E3B only).
    if (
      attachment.type === 'encrypted-media' ||
      (typeof App.isEncryptedBlossomDescriptor === 'function' && App.isEncryptedBlossomDescriptor(attachment))
    ) {
      if (typeof App.buildEncryptedAttachmentWireDescriptor === 'function') {
        return App.buildEncryptedAttachmentWireDescriptor(attachment);
      }
      const wire = {
        v: attachment.v,
        type: attachment.type,
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
      if (typeof attachment.duration === 'number') wire.duration = attachment.duration;
      if (attachment.isVoice === true) wire.isVoice = true;
      if (attachment.magnetURI) wire.magnetURI = attachment.magnetURI;
      if (attachment.infoHash) wire.infoHash = attachment.infoHash;
      if (attachment.isTorrent === true) wire.isTorrent = true;
      return wire;
    }
    const wireType = typeof attachment.type === 'string' && attachment.type.indexOf(';') >= 0
      ? attachment.type.split(';')[0].trim()
      : attachment.type;
    const serialized = {
      name: attachment.name,
      size: attachment.size,
      type: wireType,
      dataUrl: attachment.dataUrl || '',
      url: attachment.url || '',
      duration: typeof attachment.duration === 'number' ? attachment.duration : undefined,
      fileId: attachment.fileId || attachment.id || undefined,
      id: attachment.id || attachment.fileId || undefined,
    };
    // חלק P2P קול+קבצים (chat-file-transfer-service.js) – הוספת magnetURI ו-isTorrent לסריאליזציה לתמיכה באודיו וקבצים כלליים דרך טורנט | HYPER CORE TECH
    if (attachment.magnetURI) {
      serialized.magnetURI = attachment.magnetURI;
    }
    // חלק טורנט (chat-file-transfer-service.js) – שומרים infoHash כדי לאפשר זיהוי בקשה והורדה אוטומטית בצד המקבל | HYPER CORE TECH
    if (attachment.infoHash) {
      serialized.infoHash = attachment.infoHash;
    }
    if (attachment.isTorrent) {
      serialized.isTorrent = true;
    }
    if (attachment.isVoice === true) {
      serialized.isVoice = true;
    }
    return serialized;
  }

  function serializeChatMessageContent(peerPubkey, text) {
    const attachment = getActiveAttachment(peerPubkey);
    const hasAttachment = Boolean(attachment);
    let rawContent = text;
    const payload = {
      t: text || '',
      a: hasAttachment ? serializeAttachment(attachment) : null,
    };
    try {
      const packed = JSON.stringify(payload);
      const attachmentSize = typeof payload?.a?.size === 'number' ? payload.a.size : 0;
      const dataUrlSize = payload?.a?.dataUrl ? estimateDataUrlBytes(payload.a.dataUrl) : 0;
      const inlineSizeBytes = Math.max(attachmentSize, dataUrlSize);
      if (payload.a && payload.a.dataUrl && inlineSizeBytes > MAX_INLINE_SIZE) {
        const sizeKb = Math.ceil(inlineSizeBytes / 1024);
        const limitKb = Math.ceil(MAX_INLINE_SIZE / 1024);
        App.notifyChatFileTransferError?.({
          peer: peerPubkey,
          code: 'attachment-too-large',
          message: `גודל הקובץ (${sizeKb}KB) חורג ממגבלת inline (${limitKb}KB). נסה שוב בעוד רגע.`,
        });
        return null;
      }
      rawContent = packed;
    } catch (err) {
      console.error('Failed to serialize chat payload', err);
      return null;
    }
    const isAudio = isAudioLikeAttachment(attachment);
    // חלק תיקון קול (chat-file-transfer-service.js) – displayText לא ריק להודעות קוליות, אחרת appendMessageToConversation דוחה | HYPER CORE TECH
    let audioDisplayText = '🎤 הודעה קולית';
    if (isAudio && typeof attachment.duration === 'number' && attachment.duration > 0) {
      const d = attachment.duration;
      audioDisplayText = `🎤 הודעה קולית (${Math.floor(d / 60)}:${String(Math.floor(d % 60)).padStart(2, '0')})`;
    }
    const displayText = text || (attachment ? (isAudio ? audioDisplayText : `📎 ${attachment.name}`) : '');
    return {
      rawContent,
      displayText,
      attachment,
      hasAttachment,
    };
  }

  function deserializeChatMessageContent(rawContent) {
    if (!rawContent) {
      return {
        displayText: '',
        attachment: null,
        hasAttachment: false,
      };
    }
    try {
      const payload = JSON.parse(rawContent);
      if (!payload || typeof payload !== 'object') {
        return {
          displayText: rawContent,
          attachment: null,
          hasAttachment: false,
        };
      }
      const attachment = payload.a && typeof payload.a === 'object' && !Array.isArray(payload.a) ? payload.a : null;
      if (attachment && typeof App.verifyIncomingChatAttachment === 'function' && !App.verifyIncomingChatAttachment(attachment)) {
        return {
          displayText: payload.t || '',
          attachment: null,
          hasAttachment: false,
        };
      }
      if (attachment && typeof App.sanitizeIncomingChatFileName === 'function' && attachment.name) {
        attachment.name = App.sanitizeIncomingChatFileName(attachment.name);
      }
      // חלק תיקון קול (chat-file-transfer-service.js) – זיהוי הודעות קוליות בדסריאליזציה והצגת טקסט מתאים | HYPER CORE TECH
      let displayText = payload.t || '';
      if (!displayText && attachment) {
        if (isAudioLikeAttachment(attachment)) {
          const d = typeof attachment.duration === 'number' && attachment.duration > 0 ? attachment.duration : 0;
          displayText = d > 0 ? `🎤 הודעה קולית (${Math.floor(d / 60)}:${String(Math.floor(d % 60)).padStart(2, '0')})` : '🎤 הודעה קולית';
        } else {
          displayText = attachment.name ? `📎 ${attachment.name}` : '';
        }
      }
      return {
        displayText,
        attachment,
        hasAttachment: Boolean(attachment),
      };
    } catch (err) {
      return {
        displayText: rawContent,
        attachment: null,
        hasAttachment: false,
      };
    }
  }

  function afterChatMessagePublished(peerPubkey) {
    resetAttachment(peerPubkey);
  }

  Object.assign(App, {
    serializeChatMessageContent,
    deserializeChatMessageContent,
    afterChatMessagePublished,
  });
})(window);
