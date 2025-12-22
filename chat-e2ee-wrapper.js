;(function initChatE2EEWrapper(window) {
  // חלק צ'אט הצפנה (chat-e2ee-wrapper.js) – מעטפת הצפנה שקופה למסרונים/מצורפים, מינימום נגיעה בקבצים קיימים | HYPER CORE TECH
  const App = window.NostrApp || (window.NostrApp = {});
  const nip04 = window.NostrTools?.nip04;
  if (!nip04 || !App.privateKey) {
    console.warn('E2EE wrapper skipped: nip04/privateKey missing');
    return;
  }

  const MAX_INLINE_SIZE = 128 * 1024; // שמירה על מגבלה קיימת למסרים inline

  // חלק הצפנה – גזירת מפתח משותף דרך nip04.encrypt/decrypt | HYPER CORE TECH
  async function encryptForPeer(peerPubkey, plaintext) {
    if (!peerPubkey || !plaintext) return null;
    try {
      return await nip04.encrypt(App.privateKey, peerPubkey, plaintext);
    } catch (err) {
      console.warn('encryptForPeer failed', err);
      return null;
    }
  }

  async function decryptFromPeer(peerPubkey, ciphertext) {
    if (!peerPubkey || !ciphertext) return null;
    try {
      return await nip04.decrypt(App.privateKey, peerPubkey, ciphertext);
    } catch (err) {
      console.warn('decryptFromPeer failed', err);
      return null;
    }
  }

  // חלק עזר – העתקת אובייקט מצורף תוך שמירת שדות קריטיים | HYPER CORE TECH
  function serializeAttachment(attachment) {
    if (!attachment) return null;
    return {
      name: attachment.name,
      size: attachment.size,
      type: attachment.type,
      dataUrl: attachment.dataUrl || '',
      url: attachment.url || '',
      duration: typeof attachment.duration === 'number' ? attachment.duration : undefined,
    };
  }

  // חלק סיריאליזציה עם הצפנה – עטיפה חדשה במקום המימוש הקודם | HYPER CORE TECH
  App.serializeChatMessageContent = function secureSerialize(peerPubkey, text) {
    const attachment = typeof App.getChatFileAttachment === 'function' ? App.getChatFileAttachment(peerPubkey) : null;
    const hasAttachment = Boolean(attachment);
    const payload = {
      t: text || '',
      a: hasAttachment ? serializeAttachment(attachment) : null,
    };
    let rawContent = '';
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
    const displayText = text || (attachment ? (attachment.type?.startsWith('audio/') ? '' : `📎 ${attachment.name}`) : '');
    return {
      rawContent, // יוצפן בשלב האירוע
      displayText,
      attachment,
      hasAttachment,
    };
  };

  // חלק פיענוח – מנסה לפתוח ciphertext ואם נכשל חוזר למצב גולמי | HYPER CORE TECH
  App.deserializeChatMessageContent = function secureDeserialize(rawContent, peerPubkey) {
    if (!rawContent) {
      return { displayText: '', attachment: null, hasAttachment: false };
    }
    // מזהה עטיפת הצפנה {enc:'nip04', c:'...'}
    try {
      const maybe = JSON.parse(rawContent);
      if (maybe && typeof maybe === 'object' && maybe.enc === 'nip04' && maybe.c) {
        // פיענוח ואז המשך
        const decrypted = maybe.ciphertext || maybe.c || null;
        if (decrypted && peerPubkey) {
          return decryptFromPeer(peerPubkey, decrypted).then((plain) => {
            if (!plain) throw new Error('decrypt-failed');
            return App.deserializeChatMessageContent(plain, peerPubkey); // קריאה חוזרת ללא עטיפת enc
          }).catch(() => ({
            displayText: '(הודעה מוצפנת לא נפתחה)',
            attachment: null,
            hasAttachment: false,
          }));
        }
      }
    } catch (_) {
      // ממשיכים לפענוח גולמי
    }
    // פענוח גולמי (payload t/a)
    try {
      const payload = JSON.parse(rawContent);
      if (!payload || typeof payload !== 'object') {
        return { displayText: rawContent, attachment: null, hasAttachment: false };
      }
      const attachment = payload.a || null;
      const displayText = payload.t || (attachment?.name ? `📎 ${attachment.name}` : '');
      return { displayText, attachment, hasAttachment: Boolean(attachment) };
    } catch (err) {
      return { displayText: rawContent, attachment: null, hasAttachment: false };
    }
  };

  // חלק afterPublish – נשאר זהה: ניקוי מצורף אחרי שליחה | HYPER CORE TECH
  App.afterChatMessagePublished = function afterPublish(peerPubkey) {
    if (typeof App.clearChatFileAttachment === 'function') {
      App.clearChatFileAttachment(peerPubkey);
    }
  };

  // חלק הזרקה ל-finalizeEvent – החלפת rawContent ב-ciphertext עטוף | HYPER CORE TECH
  const originalFinalizeEvent = App.finalizeEvent;
  App.finalizeEvent = function finalizeWithEncrypt(draft, priv) {
    // מצפה ש-draft.content מחזיק rawContent מהסיריאליזציה המקורית
    // כאן נזהה peer מה-tags (p tag)
    try {
      const pTag = Array.isArray(draft.tags) ? draft.tags.find((t) => t[0] === 'p' && typeof t[1] === 'string') : null;
      const peerPubkey = pTag ? pTag[1] : null;
      if (peerPubkey && draft.content) {
        // עוטפים במבנה enc
        return encryptForPeer(peerPubkey, draft.content).then((cipher) => {
          if (cipher) {
            draft.content = JSON.stringify({ enc: 'nip04', ciphertext: cipher });
          }
          return originalFinalizeEvent ? originalFinalizeEvent(draft, priv) : draft;
        });
      }
    } catch (err) {
      console.warn('finalizeWithEncrypt wrapper failed', err);
    }
    return originalFinalizeEvent ? originalFinalizeEvent(draft, priv) : draft;
  };
})(window);
