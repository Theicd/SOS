(function initChatFileTransferService(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק צ'אט (chat-file-transfer-service.js) – לוגיקת העברת קבצים בצ'אט באמצעות נוטר + בסיס נתונים מקומי
  if (App.serializeChatMessageContent) {
    return;
  }

  // חלק תיקון קול ארוך (chat-file-transfer-service.js) – הגדלת סף inline ל-256KB לתמיכה בהודעות קוליות ארוכות | HYPER CORE TECH
  const MAX_INLINE_SIZE = 256 * 1024;

  function getActiveAttachment(peerPubkey) {
    if (typeof App.getChatFileAttachment !== 'function') {
      return null;
    }
    return App.getChatFileAttachment(peerPubkey);
  }

  function resetAttachment(peerPubkey) {
    if (typeof App.clearChatFileAttachment === 'function') {
      App.clearChatFileAttachment(peerPubkey);
    }
  }

  function serializeAttachment(attachment) {
    if (!attachment) {
      return null;
    }
    const serialized = {
      name: attachment.name,
      size: attachment.size,
      type: attachment.type,
      dataUrl: attachment.dataUrl || '',
      url: attachment.url || '',
      duration: typeof attachment.duration === 'number' ? attachment.duration : undefined,
    };
    // חלק P2P קול (chat-file-transfer-service.js) – הוספת magnetURI לסריאליזציה כדי לאפשר הורדת אודיו מטורנט | HYPER CORE TECH
    if (attachment.magnetURI) {
      serialized.magnetURI = attachment.magnetURI;
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
      if (payload.a && payload.a.dataUrl && payload.a.dataUrl.length > MAX_INLINE_SIZE) {
        App.notifyChatFileTransferError?.({
          peer: peerPubkey,
          code: 'attachment-too-large',
          message: 'גודל הקובץ המצורף חורג מהמגבלה לשליחה דרך ההודעה.',
        });
        return null;
      }
      rawContent = packed;
    } catch (err) {
      console.error('Failed to serialize chat payload', err);
      return null;
    }
    const isAudio = attachment && typeof attachment.type === 'string' && attachment.type.indexOf('audio/') === 0;
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
      const attachment = payload.a || null;
      // חלק תיקון קול (chat-file-transfer-service.js) – זיהוי הודעות קוליות בדסריאליזציה והצגת טקסט מתאים | HYPER CORE TECH
      let displayText = payload.t || '';
      if (!displayText && attachment) {
        const aMime = (attachment.type || '').toLowerCase();
        const aName = (attachment.name || '').toLowerCase();
        const isAudioAtt = aMime.startsWith('audio/') || aName.includes('voice') || aName.endsWith('.webm') || aName.endsWith('.ogg') || aName.endsWith('.mp3');
        if (isAudioAtt) {
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
