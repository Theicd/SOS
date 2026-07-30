(function initChatFileTransferUI(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק צ'אט (chat-file-transfer-ui.js) – שליטה ברכיבי UI עבור בחירת קבצים בצ'אט
  if (App.initializeChatFileTransferUI) {
    return;
  }

  const P2P_PREFERRED_FROM_BYTES = 90 * 1024; // מעל 90KB מעדיפים P2P
  const MAX_INLINE_SIZE_BYTES = 256 * 1024; // עד 256KB מאפשרים inline fallback אמין
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
  // חלק אטב אחיד (chat-file-transfer-ui.js) – כפתור אטב אחד לכל סוגי הקבצים, ללא פיצול קטן/גדול | HYPER CORE TECH

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

  // חלק preview (chat-file-transfer-ui.js) – שורת שם-קובץ בתחתית הקומפוזר רק לבחירה ידנית; לא לקול/P2P/שליחה אוטומטית | HYPER CORE TECH
  function shouldShowComposerPreview(attachment) {
    if (!attachment) return false;
    if (attachment.hidePreview || attachment.transferStarted) return false;
    if (attachment.isP2P || attachment.isTorrent || attachment.isVoice) return false;
    if (/^audio\//i.test(attachment.type || '')) return false;
    return true;
  }

  function renderPreview(attachment) {
    currentAttachment = attachment;
    if (!uiRefs.filePreview || !uiRefs.fileNameLabel) {
      return;
    }
    if (!shouldShowComposerPreview(attachment)) {
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

  function looksLikeVideoFile(file) {
    if (!file) return false;
    if (/^video\//i.test(file.type || '')) return true;
    return /\.(mp4|m4v|mov|webm|mkv|avi|3gp)$/i.test(file.name || '');
  }

  function reportCompressProgress(peer, compressId, file, stage, percent) {
    const pct = typeof percent === 'number' ? percent : 0;
    App.handleP2PProgressUpdate?.({
      fileId: compressId,
      progress: Math.max(0, Math.min(1, pct / 100)),
      status: stage === 'complete' ? 'complete' : stage === 'failed' ? 'failed' : 'compressing',
      direction: 'send',
      name: file?.name || 'video',
      size: file?.size || 0,
      peerPubkey: peer,
      compressStage: stage,
      error: stage === 'failed' ? 'דחיסה נכשלה — שולח מקור' : undefined,
    });
  }

  // חלק דחיסה (chat-file-transfer-ui.js) – וידאו בצ'אט עובר compressVideo לפני P2P/Torrent עם בועת התקדמות | HYPER CORE TECH
  async function maybeCompressVideoForChat(peer, file) {
    if (!looksLikeVideoFile(file)) return file;
    if (typeof App.compressVideo !== 'function') {
      log('compressVideo לא זמין — שולח מקור');
      return file;
    }

    const compressId = `compress-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    reportCompressProgress(peer, compressId, file, 'compressing', 2);
    log('מתחיל דחיסת וידאו לצ׳אט', {
      name: file.name,
      sizeMB: (file.size / (1024 * 1024)).toFixed(2),
      type: file.type,
    });

    try {
      const result = await App.compressVideo(file, (progress) => {
        reportCompressProgress(
          peer,
          compressId,
          file,
          progress?.stage === 'finalizing' ? 'compressing' : (progress?.stage || 'compressing'),
          progress?.percent || 0
        );
      });

      reportCompressProgress(peer, compressId, file, 'complete', 100);

      if (!result?.blob) {
        log('דחיסה ללא blob — שולח מקור');
        return file;
      }

      const ext = /webm/i.test(result.type || '') ? '.webm' : '.mp4';
      const base = String(file.name || 'video').replace(/\.[^.]+$/, '');
      const compressedFile = new File([result.blob], `${base}${ext}`, {
        type: result.type || 'video/mp4',
        lastModified: Date.now(),
      });

      log('דחיסת וידאו לצ׳אט הסתיימה', {
        method: result.method || 'unknown',
        reason: result.reason || null,
        originalMB: (file.size / (1024 * 1024)).toFixed(2),
        compressedMB: (compressedFile.size / (1024 * 1024)).toFixed(2),
        ratio: result.compressionRatio,
      });
      return compressedFile;
    } catch (err) {
      log('דחיסת וידאו נכשלה — ממשיכים עם מקור', err?.message || err);
      reportCompressProgress(peer, compressId, file, 'failed', 0);
      return file;
    }
  }

  async function handleFileSelection(file) {
    const peer = ensurePeer();
    if (!peer || !validateFile(file)) {
      return;
    }
    log('בחר קובץ', { name: file.name, size: file.size, type: file.type });

    // דחיסת וידאו לפני כל מסלול שליחה (P2P / Torrent / inline)
    file = await maybeCompressVideoForChat(peer, file);
    
    // חלק ניתוב קבצים (chat-file-transfer-ui.js) – מעל 90KB מעדיפים P2P, ואם נכשל עוברים ל-inline עד 256KB
    // אם DC כבר מחובר — גם קבצים קטנים עוברים P2P כדי לא לעמיס על relay | HYPER CORE TECH
    const dcConnectedNow = App.dataChannel && typeof App.dataChannel.isConnected === 'function' && App.dataChannel.isConnected(peer);
    const shouldPreferP2P = file.size > P2P_PREFERRED_FROM_BYTES || dcConnectedNow;
    if (shouldPreferP2P && typeof App.sendP2PFile === 'function') {
      try {
        const previewUrl = URL.createObjectURL(file);
        const fileId = await App.sendP2PFile(peer, file, App.handleP2PProgressUpdate || undefined);
        if (!fileId) {
          throw new Error('p2p-send-returned-empty-id');
        }
        log('שולח P2P', { peer, fileId, name: file.name, size: file.size });
        // חלק P2P (chat-file-transfer-ui.js) – לא מציג preview תחתון לקבצי P2P כי ההעברה כבר מתחילה | HYPER CORE TECH
        const attachment = {
          id: `${peer}-${Date.now()}`,
          name: file.name,
          size: file.size,
          type: file.type,
          isP2P: true,
          file,
          fileId,
          previewUrl,
          caption: uiRefs.getMessageDraft() || '',
          transferStarted: true, // סימון שההעברה כבר התחילה
          hidePreview: true,
        };
        App.setChatFileAttachment?.(peer, attachment);
        renderPreview(null); // אין שורת preview תחתונה בזמן העברת P2P
        return;
      } catch (err) {
        const reason = err?.message || 'unknown-error';
        console.warn('[CHAT/FILE-UI] P2P send failed, trying fallback', reason);
        App.notifyChatFileTransferError?.({
          peer,
          code: 'p2p-send-failed',
          message: `שליחת הקובץ נכשלה במסלול הישיר (${reason}). מנסה מסלול חלופי...`,
        });
        // ממשיכים ל-inline fallback אם הקובץ בטווח 256KB
      }
    }

    // חלק חסם Inline (chat-file-transfer-ui.js) – אם P2P לא זמין/נכשל לקובץ גדול מ-256KB מנסים WebTorrent אוטומטית | HYPER CORE TECH
    if (file.size > MAX_INLINE_SIZE_BYTES) {
      if (typeof App.torrentTransfer?.requestTransfer === 'function') {
        try {
          log('P2P לא זמין לקובץ גדול, עובר ל-WebTorrent', { name: file.name, size: file.size });
          const torrentResult = await App.torrentTransfer.requestTransfer(peer, file);
          if (torrentResult?.success) {
            log('torrent fallback ok', { name: file.name });
            return;
          }
          const reason = torrentResult?.error || 'torrent-request-failed';
          App.notifyChatFileTransferError?.({
            peer,
            code: 'torrent-fallback-failed',
            message: `שליחת הקובץ נכשלה במסלול החלופי (${reason}). נסה שוב בעוד רגע.`,
          });
          return;
        } catch (torrentErr) {
          const reason = torrentErr?.message || 'torrent-exception';
          App.notifyChatFileTransferError?.({
            peer,
            code: 'torrent-fallback-error',
            message: `שליחת הקובץ נכשלה במסלול החלופי (${reason}). נסה שוב בעוד רגע.`,
          });
          return;
        }
      }

      App.notifyChatFileTransferError?.({
        peer,
        code: 'p2p-required-for-large-file',
        message: 'הקובץ גדול מ-256KB ודורש מסלול העברה מהיר פעיל. נסה שוב בעוד רגע.',
      });
      return;
    }

    if (shouldPreferP2P && typeof App.sendP2PFile !== 'function') {
      App.notifyChatFileTransferError?.({
        peer,
        code: 'p2p-unavailable-inline-fallback',
        message: 'מסלול ההעברה המהיר לא זמין כרגע. עובר לשליחה רגילה.',
      });
    }
    
    // חלק קבצים קטנים/בינוניים (chat-file-transfer-ui.js) – inline DataURL לקבצים עד 256KB | HYPER CORE TECH
    // כל הקבצים (מדיה ולא-מדיה) נשלחים אוטומטית — בלי שורת preview תחתונה שמחכה ללחיצת שלח
    const isMediaFile = /^(image|audio|video)\//i.test(file.type || '');
    const reader = new FileReader();
    reader.onload = async () => {
      const caption = uiRefs.getMessageDraft() || '';
      const attachment = {
        id: `${peer}-${Date.now()}`,
        name: file.name,
        size: file.size,
        type: file.type,
        dataUrl: typeof reader.result === 'string' ? reader.result : '',
        caption,
        hidePreview: true, // שליחה מיידית — לא מציגים שורת שם-קובץ מתחת לקומפוזר
      };
      App.setChatFileAttachment?.(peer, attachment);
      renderPreview(null);

      // חלק שליחה אוטומטית (chat-file-transfer-ui.js) – תמונה/וידאו/קובץ נשלחים מיד אחרי בחירה | HYPER CORE TECH
      if (typeof App.publishChatMessage === 'function') {
        log('שליחה אוטומטית של קובץ', { name: file.name, size: file.size, media: isMediaFile });
        const displayText = caption || (isMediaFile ? '' : `📎 ${file.name}`);
        try {
          const result = await App.publishChatMessage(peer, displayText);
          if (result?.ok) {
            log('✅ קובץ נשלח אוטומטית', file.name);
          } else {
            log('⚠️ שליחה אוטומטית נכשלה:', result?.error);
          }
        } catch (err) {
          log('❌ שגיאה בשליחה אוטומטית:', err);
        }
        if (typeof App.clearChatFileAttachment === 'function') {
          App.clearChatFileAttachment(peer);
        }
        renderPreview(null);
      }
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

  // חלק כפתור אטב אחיד (chat-file-transfer-ui.js) – כל קובץ עובר דרך handleFileSelection → sendP2PFile | HYPER CORE TECH
  // DC ישיר קודם → Torrent ל-non-media → Blossom רק למדיה נתמכת (קול/וידאו/תמונות)
  function openFilePicker() {
    const input = uiRefs.fileInput;
    if (!input) return;
    try {
      input.value = '';
    } catch (_) {}
    // חלק מובייל (chat-file-transfer-ui.js) – קליק סינכרוני בתוך מחוות משתמש; בלי preventDefault שמפר את ה-gesture | HYPER CORE TECH
    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
      } else {
        input.click();
      }
    } catch (err) {
      try {
        input.click();
      } catch (err2) {
        console.warn('[CHAT/FILE-UI] openFilePicker failed', err2 || err);
      }
    }
  }

  function onFileButtonClick(event) {
    // חלק מובייל (chat-file-transfer-ui.js) – ה-input עצמו מכסה את האטב; לא קליק פרוגרמטי | HYPER CORE TECH
    if (event?.target?.closest?.('input[type="file"]')) {
      event.stopPropagation();
      return;
    }
    if (event?.currentTarget?.tagName === 'LABEL' || event?.currentTarget?.querySelector?.('input[type="file"]')) {
      event.stopPropagation();
      return;
    }
    event.stopPropagation();
    openFilePicker();
  }

  function onFileInputChange(event) {
    const files = event.target?.files;
    if (!files || !files.length) {
      return;
    }
    handleFileSelection(files[0]).catch((err) => {
      const reason = err?.message || 'unknown-error';
      console.error('[CHAT/FILE-UI] handleFileSelection failed:', reason, err);
      App.notifyChatFileTransferError?.({
        code: 'file-selection-failed',
        message: `שליחת הקובץ נכשלה (${reason}). נסה שוב.`,
      });
    });
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
    renderPreview(shouldShowComposerPreview(attachment) ? attachment : null);
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
      // קול / P2P / שליחה אוטומטית — מסתירים תמיד את שורת ה-preview התחתונה
      renderPreview(shouldShowComposerPreview(attachment) ? attachment : null);
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

  // חלק API ציבורי (chat-file-transfer-ui.js) – חשיפת handleFileSelection גם כ-handleChatFileSelection | HYPER CORE TECH
  // נדרש ע"י chat-composer-enhanced.js ו-chat-drag-drop.js
  Object.assign(App, {
    initializeChatFileTransferUI,
    setChatFileTransferActivePeer: setActivePeer,
    clearChatFileTransferUI: clearUI,
    handleChatFileSelection: handleFileSelection,
  });
})(window);
