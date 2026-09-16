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

  // חלק preview (chat-file-transfer-ui.js) – שורת שם-קובץ בתחתית הקומפוזר רק לבחירה ידנית; לא לקול/מדיה/P2P/שליחה אוטומטית | HYPER CORE TECH
  function shouldShowComposerPreview(attachment) {
    if (!attachment) return false;
    if (attachment.hidePreview || attachment.transferStarted) return false;
    if (attachment.isP2P || attachment.isTorrent || attachment.isVoice) return false;
    if (/^(image|audio|video)\//i.test(attachment.type || '')) return false;
    if (/\.(jpe?g|png|gif|webp|bmp|heic|mp4|m4v|mov|webm|mkv|avi|3gp)$/i.test(attachment.name || '')) return false;
    return true;
  }

  function registerTransferPreview(fileId, file, previewUrl) {
    if (!fileId || typeof App.registerChatTransferPreview !== 'function') return;
    App.registerChatTransferPreview(fileId, {
      url: previewUrl || '',
      mime: file?.type || '',
      name: file?.name || '',
      size: file?.size || 0,
    });
    // תקציר מוקדם מהקובץ המקומי — זמין כשההודעה הסופית מרונדרת | HYPER CORE TECH
    if (looksLikeVideoFile(file) && typeof App.capturePosterFromBlob === 'function') {
      App.capturePosterFromBlob(file, file?.type || '').then((posterDataUrl) => {
        if (!posterDataUrl) return;
        App.registerChatTransferPreview(fileId, {
          url: previewUrl || '',
          mime: file?.type || '',
          name: file?.name || '',
          size: file?.size || 0,
          posterDataUrl,
        });
      }).catch(() => {});
    }
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

  // חלק צ'אט (chat-file-transfer-ui.js) – וידאו פרטי נשלח כקובץ מקור; דחיסה נשארת רק לפיד/קומפוזר | HYPER CORE TECH
  async function maybeCompressVideoForChat(peer, file) {
    if (!looksLikeVideoFile(file)) {
      return { file, compressId: null };
    }
    log('וידאו בצ׳אט נשלח כמקור — ללא דחיסה', {
      name: file && file.name,
      size: file && file.size,
      type: file && file.type,
    });
    return { file, compressId: null };
  }

  async function handleFileSelection(file) {
    const peer = ensurePeer();
    if (!peer || !validateFile(file)) {
      return;
    }
    // כיתוב מהטיוטה — הודעה אחת עם הקובץ (כמו וואטסאפ) | HYPER CORE TECH
    const caption = String(uiRefs.getMessageDraft?.() || '').trim();
    if (caption && typeof uiRefs.clearMessageDraft === 'function') {
      uiRefs.clearMessageDraft();
    } else if (caption) {
      try {
        const input = document.getElementById('chatMessageInput');
        if (input) {
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } catch (_) {}
    }
    log('בחר קובץ', { name: file.name, size: file.size, type: file.type, hasCaption: !!caption });

    // חלק תצוגה מקומית (chat-file-transfer-ui.js) – blob URL מיידי לתמונה/וידאו (לפני שליחה) | HYPER CORE TECH
    const isVisualMedia =
      /^image\//i.test(file.type || '') ||
      looksLikeVideoFile(file);
    const isAudioFile = /^audio\//i.test(file.type || '');
    const localPreviewUrl = isVisualMedia ? URL.createObjectURL(file) : '';
    // מסתירים מיד שורת שם-קובץ בקומפוזר — גם לפני async | HYPER CORE TECH
    renderPreview(null);

    // מסמך/TXT/LOG וכו' — בועת קובץ מיידית אצל השולח (לפני P2P/inline) | HYPER CORE TECH
    let optimisticFileId = null;
    if (!isVisualMedia && !isAudioFile) {
      optimisticFileId = `local-file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      App.ensureOutgoingFileCardTransferBubble?.({
        fileId: optimisticFileId,
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        peerPubkey: peer,
        status: 'starting',
        progress: 0,
        caption: caption || undefined,
      });
    }

    // תמונה — בועת מדיה מיידית כמו וידאו (מונע renderMessages שמוחק כרטיסי מסמך) | HYPER CORE TECH
    let pipelineImageId = null;
    if (isVisualMedia && !looksLikeVideoFile(file)) {
      pipelineImageId = `local-image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      registerTransferPreview(pipelineImageId, file, localPreviewUrl);
      if (caption) App.setChatTransferCaption?.(pipelineImageId, caption);
      App.handleP2PProgressUpdate?.({
        fileId: pipelineImageId,
        progress: 0.02,
        status: 'starting',
        direction: 'send',
        name: file.name || 'image',
        size: file.size || 0,
        mimeType: file.type || 'image/jpeg',
        previewUrl: localPreviewUrl || undefined,
        peerPubkey: peer,
        caption: caption || undefined,
        isFileCard: false,
      });
    }

    // לכידת תקציר מהקובץ המקומי — לא דחיסה | HYPER CORE TECH
    let earlyPosterPromise = Promise.resolve('');
    if (looksLikeVideoFile(file) && typeof App.capturePosterFromBlob === 'function') {
      earlyPosterPromise = App.capturePosterFromBlob(file, file.type || 'video/mp4').catch(() => '');
    }

    let pipelineVideoId = null;
    if (looksLikeVideoFile(file)) {
      pipelineVideoId = `local-video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      registerTransferPreview(pipelineVideoId, file, localPreviewUrl);
      if (caption) App.setChatTransferCaption?.(pipelineVideoId, caption);
      App.handleP2PProgressUpdate?.({
        fileId: pipelineVideoId,
        progress: 0.02,
        status: 'starting',
        direction: 'send',
        name: file.name || 'video',
        size: file.size || 0,
        mimeType: file.type || 'video/mp4',
        previewUrl: localPreviewUrl || undefined,
        peerPubkey: peer,
        caption: caption || undefined,
        isFileCard: false,
      });
    }

    const originalFile = file;
    const compressResult = await maybeCompressVideoForChat(peer, file, localPreviewUrl, caption);
    file = compressResult?.file || file;
    if (file !== originalFile) {
      log('וידאו בצ׳אט הוחלף בניגוד למדיניות — מחזירים מקור');
      file = originalFile;
    }

    const attachPosterToFileId = async (fileId, previewUrl) => {
      if (!fileId) return '';
      let posterDataUrl = '';
      try { posterDataUrl = await earlyPosterPromise; } catch (_) {}
      if (!posterDataUrl && typeof App.getChatTransferPreviewPoster === 'function') {
        posterDataUrl = App.getChatTransferPreviewPoster(fileId) || '';
      }
      App.registerChatTransferPreview?.(fileId, {
        url: previewUrl || '',
        mime: file?.type || '',
        name: file?.name || '',
        size: file?.size || 0,
        posterDataUrl: posterDataUrl || undefined,
      });
      return posterDataUrl || '';
    };

    const adoptOutgoingBubble = (realFileId) => {
      if (!realFileId) return;
      if (caption) App.setChatTransferCaption?.(realFileId, caption);
      if (pipelineVideoId && pipelineVideoId !== realFileId) {
        App.adoptChatTransferBubble?.(pipelineVideoId, realFileId);
        pipelineVideoId = null;
      }
      if (pipelineImageId && pipelineImageId !== realFileId) {
        App.adoptChatTransferBubble?.(pipelineImageId, realFileId);
        pipelineImageId = null;
      }
      if (optimisticFileId && optimisticFileId !== realFileId) {
        App.adoptChatTransferBubble?.(optimisticFileId, realFileId);
        optimisticFileId = null;
      }
      App.cleanupOrphanCompressTransferBubbles?.();
    };
    
    // חלק ניתוב קבצים (chat-file-transfer-ui.js) – מעל 90KB מעדיפים P2P, ואם נכשל עוברים ל-inline עד 256KB
    // אם DC כבר מחובר — גם קבצים קטנים עוברים P2P כדי לא לעמיס על relay | HYPER CORE TECH
    const dcConnectedNow = App.dataChannel && typeof App.dataChannel.isConnected === 'function' && App.dataChannel.isConnected(peer);
    const shouldPreferP2P = file.size > P2P_PREFERRED_FROM_BYTES || dcConnectedNow;
    if (shouldPreferP2P && typeof App.sendP2PFile === 'function') {
      try {
        const previewUrl = localPreviewUrl || (isVisualMedia ? URL.createObjectURL(file) : '');
        // שומרים כיתוב ל-P2P / Blossom / Torrent עד פרסום ההודעה | HYPER CORE TECH
        if (caption) {
          App.setChatFileAttachment?.(peer, {
            id: `pending-caption-${Date.now()}`,
            name: file.name,
            size: file.size,
            type: file.type,
            caption,
            hidePreview: true,
          });
        }
        const onProgress = (evt) => {
          if (evt?.fileId) adoptOutgoingBubble(evt.fileId);
          const enriched = {
            ...(evt || {}),
            previewUrl: evt?.previewUrl || previewUrl || undefined,
            mimeType: evt?.mimeType || file.type || undefined,
            name: evt?.name || file.name,
            size: evt?.size || file.size,
            caption: caption || evt?.caption || undefined,
            peerPubkey: evt?.peerPubkey || peer,
            isFileCard: !isVisualMedia && !isAudioFile ? true : evt?.isFileCard,
          };
          if (enriched.fileId) {
            if (caption) App.setChatTransferCaption?.(enriched.fileId, caption);
            registerTransferPreview(enriched.fileId, file, previewUrl);
            attachPosterToFileId(enriched.fileId, previewUrl);
          }
          App.handleP2PProgressUpdate?.(enriched);
        };
        // מאמצים בועת דחיסה לפני progress ראשון של השליחה (subscribe עלול לרוץ לפני onProgress) | HYPER CORE TECH
        const fileId = await App.sendP2PFile(peer, file, onProgress);
        if (!fileId) {
          throw new Error('p2p-send-returned-empty-id');
        }
        adoptOutgoingBubble(fileId);
        const posterDataUrl = await attachPosterToFileId(fileId, previewUrl);
        log('שולח P2P', { peer, fileId, name: file.name, size: file.size, hasPoster: !!posterDataUrl, hasCaption: !!caption });
        // לא מוחקים כיתוב כאן — sendP2PFile / Blossom קוראים אותו בפרסום | HYPER CORE TECH
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
          App.cleanupOrphanCompressTransferBubbles?.();
          if (caption) {
            App.setChatFileAttachment?.(peer, {
              id: `pending-caption-${Date.now()}`,
              name: file.name,
              size: file.size,
              type: file.type,
              caption,
              hidePreview: true,
            });
          }
          if (localPreviewUrl) {
            // יישום מוקדם של preview לפני שהטורנט מקבל transferId | HYPER CORE TECH
            App.registerChatTransferPreview?.(`pending-torrent-${Date.now()}`, {
              url: localPreviewUrl,
              mime: file.type || '',
              name: file.name || '',
              size: file.size || 0,
            });
          }
          const torrentResult = await App.torrentTransfer.requestTransfer(peer, file);
          if (torrentResult?.success) {
            const tid = torrentResult.transferId || '';
            if (optimisticFileId && tid && optimisticFileId !== tid) {
              App.adoptChatTransferBubble?.(optimisticFileId, tid);
              optimisticFileId = null;
            }
            if (pipelineVideoId && tid && pipelineVideoId !== tid) {
              App.adoptChatTransferBubble?.(pipelineVideoId, tid);
              pipelineVideoId = null;
            }
            log('torrent fallback ok', { name: file.name, transferId: tid || null });
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
    // E3B hotfix: legacy ≤256KiB may still exceed NIP-44 after dataURL wrap — preflight exact candidate.
    const isMediaFile = /^(image|audio|video)\//i.test(file.type || '');
    const reader = new FileReader();
    reader.onload = async () => {
      const inlinePreview = localPreviewUrl || (typeof reader.result === 'string' ? reader.result : '');
      // תמונה: שומרים את id של בועת המדיה המוקדמת כדי ש-settle לא ייכשל | HYPER CORE TECH
      const attachmentId = optimisticFileId || pipelineImageId || pipelineVideoId || `${peer}-${Date.now()}`;
      if (pipelineImageId && pipelineImageId !== attachmentId) {
        App.adoptChatTransferBubble?.(pipelineImageId, attachmentId);
        pipelineImageId = null;
      }
      if (pipelineVideoId && pipelineVideoId !== attachmentId) {
        App.adoptChatTransferBubble?.(pipelineVideoId, attachmentId);
        pipelineVideoId = null;
      }
      if (optimisticFileId) {
        App.ensureOutgoingFileCardTransferBubble?.({
          fileId: optimisticFileId,
          name: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          peerPubkey: peer,
          status: 'sending',
          progress: 0.5,
          caption: caption || undefined,
        });
      }
      if (pipelineImageId || pipelineVideoId || /^image\//i.test(file.type || '') || looksLikeVideoFile(file)) {
        App.handleP2PProgressUpdate?.({
          fileId: attachmentId,
          progress: 0.85,
          status: 'sending',
          direction: 'send',
          name: file.name || 'image',
          size: file.size || 0,
          mimeType: file.type || 'image/jpeg',
          previewUrl: inlinePreview || undefined,
          peerPubkey: peer,
          caption: caption || undefined,
          isFileCard: false,
        });
      }
      let attachment = {
        id: attachmentId,
        fileId: attachmentId,
        name: file.name,
        size: file.size,
        type: file.type,
        dataUrl: typeof reader.result === 'string' ? reader.result : '',
        previewUrl: inlinePreview,
        caption,
        hidePreview: true, // שליחה מיידית — לא מציגים שורת שם-קובץ מתחת לקומפוזר
      };
      const displayText = caption || (isMediaFile ? '' : `📎 ${file.name}`);

      // Exact E3B/NIP-44 preflight before any Relay encrypt attempt.
      if (typeof App.resolveInlineAttachmentForE2ee === 'function') {
        try {
          const resolved = await App.resolveInlineAttachmentForE2ee({
            attachment,
            blob: file,
            file,
            recipient: peer,
            sender: App.publicKey,
            text: displayText,
            mimeType: file.type,
            fileName: file.name,
          });
          if (resolved?.route === 'GENERIC_ALTERNATE_REQUIRED') {
            log('inline E3B-unsafe generic → existing torrent alternate', {
              name: file.name,
              size: file.size,
              utf8Bytes: resolved.classification?.utf8Bytes,
            });
            if (typeof App.torrentTransfer?.requestTransfer === 'function') {
              try {
                if (caption) {
                  App.setChatFileAttachment?.(peer, {
                    id: `pending-caption-${Date.now()}`,
                    name: file.name,
                    size: file.size,
                    type: file.type,
                    caption,
                    hidePreview: true,
                  });
                }
                const torrentResult = await App.torrentTransfer.requestTransfer(peer, file);
                if (torrentResult?.success) {
                  const tid = torrentResult.transferId || '';
                  if (optimisticFileId && tid && optimisticFileId !== tid) {
                    App.adoptChatTransferBubble?.(optimisticFileId, tid);
                    optimisticFileId = null;
                  }
                  log('generic E3B-overflow torrent ok', { name: file.name, transferId: tid || null });
                  return;
                }
              } catch (torrentErr) {
                log('generic E3B-overflow torrent failed', torrentErr?.message || torrentErr);
              }
            }
            App.notifyChatFileTransferError?.({
              peer,
              code: 'e2ee-inline-overflow',
              message: 'הקובץ גדול מדי לשליחה מוצפנת במסלול הנוכחי. נסה שוב דרך מסלול ישיר.',
            });
            return;
          }
          if (resolved?.attachment) {
            attachment = resolved.attachment;
            log('E3B inline preflight', {
              route: resolved.route,
              utf8Bytes: resolved.classification?.utf8Bytes,
              size: file.size,
              secureUpload: resolved.secureUploadCalls || 0,
            });
          }
        } catch (preErr) {
          const code = preErr?.code || preErr?.message || 'e2ee-inline-preflight-failed';
          log('E3B inline preflight failed', code);
          App.notifyChatFileTransferError?.({
            peer,
            code: String(code),
            message: 'שליחת הקובץ נכשלה במסלול המוצפן. נסה שוב בעוד רגע.',
          });
          return;
        }
      }

      App.setChatFileAttachment?.(peer, attachment);
      renderPreview(null);

      // חלק שליחה אוטומטית (chat-file-transfer-ui.js) – תמונה/וידאו/קובץ נשלחים מיד אחרי בחירה | HYPER CORE TECH
      if (typeof App.publishChatMessage === 'function') {
        log('שליחה אוטומטית של קובץ', { name: file.name, size: file.size, media: isMediaFile, hasCaption: !!caption });
        try {
          const result = await App.publishChatMessage(peer, displayText);
          if (result?.ok) {
            log('✅ קובץ נשלח אוטומטית', file.name);
            if (optimisticFileId) {
              App.ensureOutgoingFileCardTransferBubble?.({
                fileId: optimisticFileId,
                name: file.name,
                size: file.size,
                mimeType: file.type || 'application/octet-stream',
                peerPubkey: peer,
                status: 'complete',
                progress: 1,
                caption: caption || undefined,
                blobUrl: attachment.dataUrl || attachment.previewUrl || undefined,
              });
            }
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
    if (typeof App.isChatSendPreviewOpen === 'function' && App.isChatSendPreviewOpen()) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof App.closeChatSendPreview === 'function') App.closeChatSendPreview();
      return;
    }
    // חלק מובייל (chat-file-transfer-ui.js) – ה-input עצמו מכסה את האטב; לא קליק פרוגרמטי | HYPER CORE TECH
    if (event?.target?.closest?.('input[type="file"]')) {
      // מאפשרים בחירה חוזרת של אותו קובץ | HYPER CORE TECH
      try { event.target.value = ''; } catch (_) {}
      event.stopPropagation();
      return;
    }
    if (event?.currentTarget?.tagName === 'LABEL' || event?.currentTarget?.querySelector?.('input[type="file"]')) {
      const nested = event.currentTarget.querySelector?.('input[type="file"]');
      if (nested) {
        try { nested.value = ''; } catch (_) {}
      }
      event.stopPropagation();
      return;
    }
    event.stopPropagation();
    openFilePicker();
  }

  function offerFileToUser(file) {
    if (!file) return Promise.resolve();
    // שכבת טעינה גם בבחירת קובץ רגילה (ווב) עד לתצוגה מקדימה | HYPER CORE TECH
    try { App.showChatFilePickLoading?.('טוען...'); } catch (_) {}
    try {
      if (typeof App.openChatSendPreview === 'function') {
        App.openChatSendPreview(file);
        return Promise.resolve();
      }
      return handleFileSelection(file).finally(() => {
        try { App.hideChatFilePickLoading?.(); } catch (_) {}
      });
    } catch (err) {
      try { App.hideChatFilePickLoading?.(); } catch (_) {}
      return Promise.reject(err);
    }
  }

  function onFileInputChange(event) {
    const files = event.target?.files;
    if (!files || !files.length) {
      return;
    }
    offerFileToUser(files[0]).catch((err) => {
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
      // קול / מדיה / P2P / שליחה אוטומטית — מסתירים תמיד את שורת ה-preview התחתונה
      if (!shouldShowComposerPreview(attachment)) {
        renderPreview(null);
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

  // חלק API ציבורי (chat-file-transfer-ui.js) – חשיפת handleFileSelection גם כ-handleChatFileSelection | HYPER CORE TECH
  // נדרש ע"י chat-composer-enhanced.js ו-chat-drag-drop.js
  Object.assign(App, {
    initializeChatFileTransferUI,
    setChatFileTransferActivePeer: setActivePeer,
    clearChatFileTransferUI: clearUI,
    handleChatFileSelection: offerFileToUser,
    sendChatSelectedFile: handleFileSelection,
  });
})(window);
