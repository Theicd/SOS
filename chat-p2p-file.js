// חלק העברת קבצים P2P (chat-p2p-file.js) – העברת קבצים גדולים דרך WebRTC DataChannel עם הצפנה, resume, fallback | HYPER CORE TECH
(function initChatP2PFile(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  // חלק דיבאג מדיה (chat-p2p-file.js) – לוגים לפי localStorage sos_debug_media | HYPER CORE TECH
  if (typeof App.mediaDebugLog !== 'function') {
    App.mediaDebugLog = (...args) => {
      try {
        if (localStorage.getItem('sos_debug_media') === '1') {
          console.log('[MEDIA-DEBUG]', ...args);
        }
      } catch (_) {}
    };
  }
  const mediaDebugLog = App.mediaDebugLog;
  
  const CHUNK_SIZE = 256 * 1024; // 256KB per chunk
  const MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1MB buffer limit
  const ACK_INTERVAL = 10; // Send ACK every 10 chunks
  const TRANSFER_TIMEOUT = 30000; // 30s timeout for stalled transfers
  const RESEND_WAIT_SEC = 3; // זמן המתנה ל-chunks לפני בקשת resend (מהיר — recovery תוך 3 שניות)
  const FILE_RETAIN_MS = 3 * 60 * 1000; // שומר קובץ 3 דקות אחרי סיום לצורך resend
  const MAX_RESEND_ATTEMPTS = 2; // מקסימום ניסיונות resend
  
  // חלק מצב העברות (chat-p2p-file.js) – מעקב אחר העברות פעילות | HYPER CORE TECH
  const activeTransfers = new Map(); // fileId -> transfer state
  const progressListeners = new Set(); // UI listeners for progress
  // חלק שמירת קבצים (chat-p2p-file.js) – שומר קובץ 3 דקות אחרי סיום לצורך resend אם המקבל איחר | HYPER CORE TECH
  const recentCompletedFiles = new Map(); // fileId -> { file, keyStr, peerPubkey, completedAt }

  function notifyProgress(payload) {
    progressListeners.forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        console.warn('P2P progress listener failed', err);
      }
    });
  }
  const dataChannels = new Map(); // peerPubkey -> RTCDataChannel
  // חלק buffer chunks (chat-p2p-file.js) – שמירת chunks שמגיעים לפני ה-file-offer (race condition fix) | HYPER CORE TECH
  const pendingChunks = new Map(); // peerPubkey -> [Uint8Array]

  // חלק נרמול peer key (chat-p2p-file.js) – מפתח אחיד lowercase לכל מפות החיבור/צ'אנקים | HYPER CORE TECH
  function toPeerKey(peerPubkey) {
    return (peerPubkey || '').toLowerCase();
  }

  // חלק MIME קבצים (chat-p2p-file.js) – השלמת MIME לפי שם קובץ כדי שתצוגת מדיה ב-P2P תעבוד כמו Blossom | HYPER CORE TECH
  function resolveMimeType(mimeType, fileName) {
    const existing = (mimeType || '').toLowerCase();
    if (existing) return existing;
    const name = (fileName || '').toLowerCase();
    if (!name) return '';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.gif')) return 'image/gif';
    if (name.endsWith('.webp')) return 'image/webp';
    if (name.endsWith('.bmp')) return 'image/bmp';
    if (name.endsWith('.heic')) return 'image/heic';
    if (name.endsWith('.heif')) return 'image/heif';
    if (name.endsWith('.mp4')) return 'video/mp4';
    if (name.endsWith('.mov')) return 'video/quicktime';
    if (name.endsWith('.mkv')) return 'video/x-matroska';
    if (name.endsWith('.webm')) return 'video/webm';
    return '';
  }

  // חלק סימון וידאו (chat-p2p-file.js) – כל סוגי וידאו נדרשים לסימון isVideo כדי שממשק הצ'אט יציג נגן | HYPER CORE TECH
  function shouldForceVideoFlag(mimeType, fileName) {
    const resolved = resolveMimeType(mimeType, fileName);
    return resolved.startsWith('video/');
  }

  // חלק הודעת שגיאה למשתמש (chat-p2p-file.js) – דיווח אחיד וברור במקרי כשל העברה | HYPER CORE TECH
  function notifyTransferError(peerPubkey, message, code = 'p2p-transfer-failed') {
    const peerKey = toPeerKey(peerPubkey);
    App.notifyChatFileTransferError?.({
      peer: peerKey,
      code,
      message,
    });
    if (typeof App.showToast === 'function') {
      App.showToast(message, 'error');
    }
  }
  
  // חלק הצפנה (chat-p2p-file.js) – הצפנת/פענוח צ'אנק עם AES-GCM | HYPER CORE TECH
  async function encryptChunk(data, key) {
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        data
      );
      // Concatenate IV + ciphertext
      const result = new Uint8Array(iv.length + encrypted.byteLength);
      result.set(iv, 0);
      result.set(new Uint8Array(encrypted), iv.length);
      return result;
    } catch (err) {
      console.error('encryptChunk failed', err);
      return null;
    }
  }
  
  async function decryptChunk(data, key) {
    try {
      const iv = data.slice(0, 12);
      const ciphertext = data.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
      );
      return new Uint8Array(decrypted);
    } catch (err) {
      console.error('decryptChunk failed', err);
      return null;
    }
  }
  
  // חלק מפתח סימטרי (chat-p2p-file.js) – יצירת מפתח AES-GCM לקובץ | HYPER CORE TECH
  async function generateFileKey() {
    return await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }
  
  async function exportFileKey(key) {
    const exported = await crypto.subtle.exportKey('raw', key);
    return btoa(String.fromCharCode(...new Uint8Array(exported)));
  }
  
  async function importFileKey(keyStr) {
    const keyData = Uint8Array.from(atob(keyStr), c => c.charCodeAt(0));
    return await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'AES-GCM' },
      true,
      ['encrypt', 'decrypt']
    );
  }
  
  // חלק DataChannel (chat-p2p-file.js) – פתיחת ערוץ נתונים לקובץ | HYPER CORE TECH
  function getOrCreateDataChannel(peerPubkey, pc) {
    const peerKey = toPeerKey(peerPubkey);
    if (dataChannels.has(peerKey)) {
      return dataChannels.get(peerKey);
    }
    
    if (!pc) {
      console.warn('No PeerConnection available for', peerKey);
      return null;
    }
    
    try {
      const channel = pc.createDataChannel('file-transfer', {
        ordered: true,
        maxRetransmits: 3
      });
      
      channel.binaryType = 'arraybuffer';
      dataChannels.set(peerKey, channel);
      
      channel.onopen = () => {
        console.log('File transfer DataChannel opened for', peerKey.slice(0, 8));
      };
      
      channel.onclose = () => {
        console.log('File transfer DataChannel closed for', peerKey.slice(0, 8));
        dataChannels.delete(peerKey);
      };
      
      channel.onerror = (err) => {
        console.error('DataChannel error', err);
      };
      
      channel.onmessage = (event) => {
        handleIncomingMessage(peerKey, event.data);
      };
      
      return channel;
    } catch (err) {
      console.error('Failed to create DataChannel', err);
      return null;
    }
  }
  
  // חלק שליחה (chat-p2p-file.js) – שליחת קובץ בצ'אנקים מוצפנים | HYPER CORE TECH
  async function sendFile(peerPubkey, file, onProgress) {
    const peerKey = toPeerKey(peerPubkey);
    console.log('[CHAT/P2P] 📤 sendFile start', {
      peer: peerPubkey?.slice?.(0, 12) + '...',
      name: file?.name,
      size: file?.size,
      type: file?.type
    });
    
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = await generateFileKey();
    const keyStr = await exportFileKey(key);
    
    // חלק חיבור DC (chat-p2p-file.js) – וידוא DataChannel פתוח לפני שליחה, מנסה לחבר אם צריך | HYPER CORE TECH
    const conn = typeof App.getPersistentConnection === 'function' 
      ? App.getPersistentConnection(peerKey) 
      : null;
    const hasConnection = conn && conn.channel && conn.channel.readyState === 'open';
    const chatDCConnected = App.dataChannel?.isConnected?.(peerKey) || false;
    
    console.log('[CHAT/P2P] 🔍 בדיקת חיבור', {
      hasPersistentConnection: hasConnection,
      channelState: conn?.channel?.readyState || 'none',
      chatDC: chatDCConnected ? 'connected' : 'not connected'
    });

    // אם אין שום DataChannel פתוח, מנסה לחבר בכוח (גם כ-responder) ומחכה עד 5 שניות
    if (!hasConnection && !chatDCConnected && App.dataChannel) {
      console.log('[CHAT/P2P] ⚡ מנסה לחבר chat DataChannel לפני שליחה (forceConnect)...');
      try {
        App.dataChannel.init?.();
        // forceConnect עוקף את הלוגיקת initiator/responder — שולח offer בכוח
        if (typeof App.dataChannel.forceConnect === 'function') {
          await App.dataChannel.forceConnect(peerKey);
        } else {
          App.dataChannel.connect(peerKey);
        }
        for (let i = 0; i < 25; i++) {
          await new Promise(r => setTimeout(r, 200));
          if (App.dataChannel.isConnected(peerKey)) {
            console.log('[CHAT/P2P] ⚡ chat DataChannel מחובר! העברה תהיה מהירה');
            break;
          }
        }
        if (!App.dataChannel.isConnected(peerKey)) {
          console.log('[CHAT/P2P] ⏱️ chat DC לא התחבר תוך 5 שניות, ממשיך עם fallback');
        }
      } catch (e) {
        console.warn('[CHAT/P2P] ⚠️ שגיאה בחיבור chat DC:', e.message);
      }
    }
    
    // Send metadata first via encrypted relay message
    const metadata = {
      type: 'file-offer',
      fileId,
      name: file.name,
      size: file.size,
      mimeType: file.type,
      keyStr,
      totalChunks: Math.ceil(file.size / CHUNK_SIZE)
    };
    
    // שליחת metadata דרך signaling
    if (typeof App.sendP2PSignal === 'function') {
      console.log('[CHAT/P2P] 📡 שולח file-offer metadata', {
        fileId,
        name: metadata.name,
        totalChunks: metadata.totalChunks
      });
      await App.sendP2PSignal(peerKey, metadata);
    } else {
      console.warn('[CHAT/P2P] ⚠️ App.sendP2PSignal לא זמין!');
    }
    
    const transfer = {
      fileId,
      file,
      key,
      keyStr,
      peerPubkey: peerKey,
      direction: 'send',
      currentChunk: 0,
      totalChunks: metadata.totalChunks,
      ackReceived: 0,
      paused: false,
      startTime: Date.now(),
      // חלק המתנה ל-DC (chat-p2p-file.js) – מונע fallback מוקדם ל-Blossom כש-DC נפתח באיחור קל | HYPER CORE TECH
      dcWaitAttempts: 0,
      // חלק יציבות DC (chat-p2p-file.js) – Channel קבוע להעברה ספציפית כדי לא לפתוח ערוצים חדשים בכל צ׳אנק | HYPER CORE TECH
      channel: null,
    };
    
    activeTransfers.set(fileId, transfer);
    
    // עדכון UI על התחלת שליחה
    notifyProgress({
      fileId,
      progress: 0,
      status: 'starting',
      direction: 'send',
      name: file.name,
      size: file.size,
      mimeType: file.type,
      peerPubkey: peerKey
    });
    
    // Start sending chunks
    await sendNextChunk(fileId, onProgress);
    
    return fileId;
  }
  
  async function sendNextChunk(fileId, onProgress) {
    const transfer = activeTransfers.get(fileId);
    if (!transfer || transfer.paused) return;
    
    const { file, key, peerPubkey, currentChunk, totalChunks } = transfer;
    const peerKey = toPeerKey(peerPubkey);
    // חלק שמירת callback (chat-p2p-file.js) — שומר onProgress ב-transfer כדי שנוכל לקרוא ל-sendNextChunk מ-chunk-ack | HYPER CORE TECH
    if (onProgress) transfer._onProgress = onProgress;
    
    if (currentChunk >= totalChunks) {
      // Transfer complete — ניקוי timeout
      if (transfer._ackTimeout) { clearTimeout(transfer._ackTimeout); transfer._ackTimeout = null; }
      console.log('[CHAT/P2P] ✅ שליחת קובץ הושלמה', fileId);
      // חלק הודעת צ'אט לשולח (chat-p2p-file.js) — שומר הודעת קובץ מקומית בלבד כדי למנוע שליחת blob URL לא חוקי לצד השני | HYPER CORE TECH
      try {
        if (typeof App.appendChatMessage === 'function') {
          const localUrl = URL.createObjectURL(file);
          const resolvedMime = resolveMimeType(file?.type, file?.name);
          const isVideoFlag = shouldForceVideoFlag(file?.type, file?.name);
          const createdAt = Math.floor(Date.now() / 1000);
          App.appendChatMessage({
            id: `p2p-send-${fileId}`,
            from: App.publicKey,
            to: peerKey,
            content: `📎 ${file.name}`,
            attachment: { name: file.name, size: file.size, type: resolvedMime || file.type, url: localUrl, fileId, isVideo: isVideoFlag || undefined },
            createdAt,
            direction: 'outgoing',
            status: 'sent',
            p2p: true,
          });
          if (typeof App.markChatConversationRead === 'function') {
            App.markChatConversationRead(peerKey);
          }
          console.log('[CHAT/P2P] 💬 הודעת קובץ מקומית נוספה בצד השולח');
        }
      } catch (msgErr) { console.warn('[CHAT/P2P] append local p2p message failed:', msgErr); }
      // חלק שמירת קובץ לאחר סיום (chat-p2p-file.js) — שומר קובץ 3 דקות לצורך resend אם המקבל איחר | HYPER CORE TECH
      recentCompletedFiles.set(fileId, { file, keyStr: transfer.keyStr, peerPubkey: peerKey, completedAt: Date.now() });
      setTimeout(() => { recentCompletedFiles.delete(fileId); }, FILE_RETAIN_MS);
      console.log('[CHAT/P2P] 💾 קובץ נשמר ל-resend cache למשך 3 דקות:', fileId);
      activeTransfers.delete(fileId);
      if (onProgress) onProgress({ fileId, progress: 1, status: 'complete', direction: 'send', name: file.name, size: file.size, peerPubkey: peerKey });
      notifyProgress({ fileId, progress: 1, status: 'complete', direction: 'send', name: file.name, size: file.size, peerPubkey: peerKey });
      return;
    }
    
    // חלק DataChannel (chat-p2p-file.js) – חיפוש ערוץ פתוח: קודם transfer.channel, ואז cache כללי | HYPER CORE TECH
    let channel = transfer.channel && transfer.channel.readyState === 'open'
      ? transfer.channel
      : dataChannels.get(peerKey);
    if (transfer.channel && transfer.channel.readyState !== 'open') {
      transfer.channel = null;
    }
    
    // בדיקה 1: persistent connection (p2p-video-sharing)
    if (!channel || channel.readyState !== 'open') {
      const conn = typeof App.getPersistentConnection === 'function' 
        ? App.getPersistentConnection(peerKey) 
        : null;
      
      if (conn && conn.channel && conn.channel.readyState === 'open') {
        console.log('[CHAT/P2P] 🔗 משתמש ב-persistent DataChannel לשליחה');
        channel = conn.channel;
        channel.binaryType = 'arraybuffer'; // חובה — בלי זה binary מגיע כ-Blob ונזרק
        dataChannels.set(peerKey, channel);
        transfer.channel = channel;
        if (!channel._p2pFileHandler) {
          channel._p2pFileHandler = true;
          channel.addEventListener('message', (event) => {
            handleIncomingMessage(peerKey, event.data);
          });
        }
      }
    }

    // בדיקה 2: יצירת ערוץ file-transfer על PeerConnection של הצ'אט — מהיר ביותר!
    if (!channel || channel.readyState !== 'open') {
      const chatPC = App.dataChannel?.getChatPC?.(peerKey);
      if (chatPC && chatPC.connectionState === 'connected') {
        try {
          console.log('[CHAT/P2P] ⚡ יוצר file-transfer DC על chat PeerConnection');
          channel = chatPC.createDataChannel('file-transfer', { ordered: true });
          channel.binaryType = 'arraybuffer';
          channel._p2pFileHandler = true;
          channel.addEventListener('message', (event) => {
            handleIncomingMessage(peerKey, event.data);
          });
          channel.addEventListener('close', () => {
            if (dataChannels.get(peerKey) === channel) {
              dataChannels.delete(peerKey);
            }
            if (transfer.channel === channel) {
              transfer.channel = null;
            }
          });
          dataChannels.set(peerKey, channel);
          transfer.channel = channel;
          // ממתין לפתיחת הערוץ (בד"כ מיידי על PC מחובר)
          if (channel.readyState !== 'open') {
            await new Promise((resolve, reject) => {
              const t = setTimeout(() => { reject(new Error('file DC open timeout')); }, 3000);
              channel.onopen = () => { clearTimeout(t); console.log('[CHAT/P2P] ⚡ file DC opened!'); resolve(); };
              channel.onerror = (e) => { clearTimeout(t); reject(e); };
            });
          }
        } catch (e) {
          console.warn('[CHAT/P2P] ⚠️ file DC on chat PC failed:', e.message);
          channel = null;
        }
      }
    }
    
    if (!channel || channel.readyState !== 'open') {
      // חלק reconnect (chat-p2p-file.js) – DC נסגר, מנסה לחבר מחדש לפני fallback — גם באמצע שליחה | HYPER CORE TECH
      if (transfer.dcWaitAttempts < 5) {
        transfer.dcWaitAttempts += 1;
        const chunkInfo = transfer.currentChunk > 0 ? ` (chunk ${transfer.currentChunk}/${totalChunks})` : '';
        console.log(`[CHAT/P2P] ⏳ DC לא פתוח${chunkInfo}, ניסיון ${transfer.dcWaitAttempts}/5...`);
        // ניסיון אקטיבי לחבר DC מחדש כשנפל באמצע
        if (transfer.currentChunk > 0 && transfer.dcWaitAttempts === 1) {
          transfer.channel = null; // מאפס channel שבור
          try {
            const chatPC = App.dataChannel?.getChatPC?.(peerKey);
            if (chatPC && chatPC.connectionState === 'connected') {
              console.log('[CHAT/P2P] ⚡ מנסה ליצור file-transfer DC חדש (reconnect)');
              const newCh = chatPC.createDataChannel('file-transfer', { ordered: true });
              newCh.binaryType = 'arraybuffer';
              newCh._p2pFileHandler = true;
              newCh.addEventListener('message', (event) => handleIncomingMessage(peerKey, event.data));
              newCh.addEventListener('close', () => { if (dataChannels.get(peerKey) === newCh) dataChannels.delete(peerKey); if (transfer.channel === newCh) transfer.channel = null; });
              dataChannels.set(peerKey, newCh);
              transfer.channel = newCh;
            }
          } catch (e) { console.warn('[CHAT/P2P] reconnect DC failed:', e.message); }
        }
        notifyProgress({
          fileId,
          progress: transfer.currentChunk / totalChunks,
          status: 'reconnecting',
          direction: 'send',
          name: file?.name,
          size: file?.size,
          mimeType: file?.type,
          peerPubkey: peerKey
        });
        setTimeout(() => sendNextChunk(fileId, onProgress), 500);
        return;
      }
      console.warn('[CHAT/P2P] ⚠️ DataChannel not ready after 5 retries, fallback to Blossom');
      // חלק התראה (chat-p2p-file.js) – Push לפיר לא מחובר + Toast לשולח | HYPER CORE TECH
      if (typeof App.triggerOutgoingMessagePush === 'function') {
        App.triggerOutgoingMessagePush(peerKey, null, { type: 'file', name: transfer.file?.name, size: transfer.file?.size });
        console.log('[CHAT/P2P] 📲 Push נשלח לפיר לא מחובר:', peerKey?.slice(0,8));
      }
      if (typeof App.showToast === 'function') {
        App.showToast('הקובץ נשלח במסלול חלופי.', 'warning');
      }
      await fallbackToBlossom(transfer, onProgress);
      return;
    }
    
    // חלק file-offer via DC (chat-p2p-file.js) – שליחת metadata דרך DC לפני chunk ראשון (תיקון race condition) | HYPER CORE TECH
    if (currentChunk === 0) {
      try {
        const dcOffer = JSON.stringify({ type: 'file-offer', fileId, name: file.name, size: file.size, mimeType: file.type, keyStr: transfer.keyStr, totalChunks });
        channel.send(dcOffer);
        console.log('[CHAT/P2P] ⚡ file-offer נשלח דרך DC (fast path, לפני chunks)');
      } catch (e) { console.warn('[CHAT/P2P] file-offer via DC failed:', e.message); }
    }

    // Check bufferedAmount for backpressure
    if (channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      setTimeout(() => sendNextChunk(fileId, onProgress), 100);
      return;
    }
    
    const start = currentChunk * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);
    
    const reader = new FileReader();
    reader.onload = async (e) => {
      const encrypted = await encryptChunk(new Uint8Array(e.target.result), key);
      if (!encrypted) {
        console.error('[CHAT/P2P] Encryption failed for chunk', currentChunk);
        return;
      }
      
      try {
        channel.send(JSON.stringify({ type: 'chunk-meta', fileId, index: currentChunk }));
        channel.send(encrypted);
        
        transfer.currentChunk++;
        transfer.dcWaitAttempts = 0; // איפוס — DC עבד, אפשר לנסות שוב אם ייפול
        
        const progressPayload = {
          fileId,
          progress: transfer.currentChunk / totalChunks,
          status: 'sending',
          direction: 'send',
          name: transfer.file?.name,
          size: transfer.file?.size,
          mimeType: transfer.file?.type,
          peerPubkey: peerKey
        };
        if (onProgress) {
          onProgress(progressPayload);
        }
        notifyProgress(progressPayload);
        // חלק stop-and-wait (chat-p2p-file.js) — מחכה ל-chunk-ack מהמקבל לפני שליחת chunk הבא | HYPER CORE TECH
        if (transfer.currentChunk >= totalChunks) {
          // chunk אחרון — עובר ל-completion handler
          sendNextChunk(fileId, onProgress);
        } else {
          // ממתין ל-chunk-ack, timeout 5 שניות — אם לא הגיע, שולח שוב
          transfer._ackTimeout = setTimeout(() => {
            const t = activeTransfers.get(fileId);
            if (!t || t.direction !== 'send') return;
            if (t.currentChunk >= t.totalChunks) return;
            console.warn(`[CHAT/P2P] ⏱️ chunk-ack timeout (chunk ${t.currentChunk - 1}), שולח שוב...`);
            t.currentChunk--;
            sendNextChunk(fileId, t._onProgress);
          }, 5000);
        }
      } catch (err) {
        // חלק retry on send fail (chat-p2p-file.js) — איפוס channel וניסיון חוזר במקום Blossom ישר | HYPER CORE TECH
        console.warn('[CHAT/P2P] ⚠️ channel.send נכשל, מאפס channel ומנסה שוב:', err.message);
        transfer.channel = null;
        if (dataChannels.get(peerKey) === channel) dataChannels.delete(peerKey);
        setTimeout(() => sendNextChunk(fileId, onProgress), 100);
      }
    };
    
    reader.readAsArrayBuffer(chunk);
  }

  // חלק קבלה (chat-p2p-file.js) – קבלת צ'אנקים והרכבת קובץ | HYPER CORE TECH
  function handleIncomingMessage(peerPubkey, data) {
    const peerKey = toPeerKey(peerPubkey);
    try {
      if (typeof data === 'string') {
        const msg = JSON.parse(data);
        if (msg.type === 'file-offer') {
          // חלק file-offer via DC (chat-p2p-file.js) – קבלת metadata דרך DC (fast path, לפני chunks) | HYPER CORE TECH
          console.log('[CHAT/P2P] ⚡ file-offer התקבל דרך DC!', msg.fileId, msg.name);
          handleP2PFileOffer(peerKey, msg);
        } else if (msg.type === 'chunk-meta') {
          const transfer = activeTransfers.get(msg.fileId);
          if (transfer) {
            transfer.expectedChunk = msg.index;
          }
        } else if (msg.type === 'file-complete-ack') {
          // חלק ACK סיום (chat-p2p-file.js) — הצד השני אישר שהקובץ הורד בהצלחה e2e | HYPER CORE TECH
          console.log('[CHAT/P2P] ✅✅ אישור קבלה מלאה מהצד השני!', msg.fileId, msg.name);
          notifyProgress({
            fileId: msg.fileId, progress: 1, status: 'verified', direction: 'send',
            name: msg.name, size: msg.size, peerPubkey: peerKey
          });
        } else if (msg.type === 'chunk-ack') {
          // חלק chunk-ack handler (chat-p2p-file.js) — אישור chunk מהמקבל, ממשיך ל-chunk הבא (stop-and-wait) | HYPER CORE TECH
          const transfer = activeTransfers.get(msg.fileId);
          if (transfer && transfer.direction === 'send') {
            if (transfer._ackTimeout) { clearTimeout(transfer._ackTimeout); transfer._ackTimeout = null; }
            console.log(`[CHAT/P2P] ✅ chunk-ack ${msg.index} → שולח chunk ${transfer.currentChunk}/${transfer.totalChunks}`);
            sendNextChunk(msg.fileId, transfer._onProgress);
          }
        } else if (msg.type === 'ack') {
          const transfer = activeTransfers.get(msg.fileId);
          if (transfer) {
            transfer.ackReceived = msg.index;
          }
        } else if (msg.type === 'resume') {
          const transfer = activeTransfers.get(msg.fileId);
          if (transfer) {
            transfer.currentChunk = msg.fromChunk;
            transfer.paused = false;
          }
        } else if (msg.type === 'file-resend-request') {
          // חלק resend via DC (chat-p2p-file.js) — המקבל ביקש שליחה מחדש דרך DC | HYPER CORE TECH
          console.log('[CHAT/P2P] 🔄 file-resend-request התקבל דרך DC:', msg.fileId);
          handleFileResendRequest(peerKey, msg);
        } else if (msg.type === 'file-ready') {
          // חלק file-ready (chat-p2p-file.js) — המקבל מוכן לקבל chunks, בודקים אם צריך resend | HYPER CORE TECH
          console.log('[CHAT/P2P] 📥 file-ready התקבל:', msg.fileId);
          handleFileResendRequest(peerKey, msg);
        }
      } else if (data instanceof ArrayBuffer) {
        // Chunk data received — binary ישיר
        handleChunkData(peerKey, new Uint8Array(data));
      } else if (data instanceof Blob) {
        // חלק Blob fallback (chat-p2p-file.js) — persistent channel עלול לשלוח Blob אם binaryType לא הוגדר | HYPER CORE TECH
        console.log('[CHAT/P2P] 🔄 Blob→ArrayBuffer conversion (binaryType fallback)', data.size, 'bytes');
        data.arrayBuffer().then(ab => {
          handleChunkData(peerKey, new Uint8Array(ab));
        }).catch(e => console.error('[CHAT/P2P] Blob conversion failed:', e));
      }
    } catch (err) {
      console.error('handleIncomingMessage failed', err);
    }
  }

  async function handleChunkData(peerPubkey, encryptedData) {
    const peerKey = toPeerKey(peerPubkey);
    // Find active receive transfer
    for (const [fileId, transfer] of activeTransfers.entries()) {
      if (transfer.peerPubkey === peerKey && transfer.direction === 'receive') {
        // חלק index-based chunks (chat-p2p-file.js) — שומר chunk לפי index ולא push עיוור, מונע blob שבור | HYPER CORE TECH
        const chunkIndex = (typeof transfer.expectedChunk === 'number') ? transfer.expectedChunk : transfer.receivedChunks;
        // הגנה נגד chunk כפול — עדיין שולח chunk-ack כדי שהשולח יוכל להמשיך
        if (transfer.chunks[chunkIndex]) {
          console.log('[CHAT/P2P] ⚠️ chunk כפול נדחה:', chunkIndex, 'fileId:', fileId);
          const dupAckCh = dataChannels.get(peerKey);
          if (dupAckCh && dupAckCh.readyState === 'open') {
            try { dupAckCh.send(JSON.stringify({ type: 'chunk-ack', fileId, index: chunkIndex })); } catch (_e) {}
          }
          return;
        }
        const decrypted = await decryptChunk(encryptedData, transfer.key);
        if (!decrypted) {
          console.error('[CHAT/P2P] Decryption failed for chunk', chunkIndex);
          return;
        }
        
        transfer.chunks[chunkIndex] = decrypted;
        transfer.receivedChunks++;

        // חלק stall detection (chat-p2p-file.js) — מאפס timer על כל chunk, אם נתקע באמצע מבקש resend | HYPER CORE TECH
        if (transfer._resendTimer) { clearTimeout(transfer._resendTimer); transfer._resendTimer = null; }
        if (transfer._resendTimer2) { clearTimeout(transfer._resendTimer2); transfer._resendTimer2 = null; }
        transfer._lastChunkAt = Date.now();
        // אם עדיין לא סיימנו — מפעיל stall timer
        if (transfer.receivedChunks < transfer.totalChunks) {
          transfer._resendTimer = setTimeout(async () => {
            const t = activeTransfers.get(fileId);
            if (!t || t.direction !== 'receive') return;
            if (t.receivedChunks >= t.totalChunks) return; // כבר הושלם
            const secSinceLastChunk = ((Date.now() - (t._lastChunkAt || 0)) / 1000).toFixed(1);
            console.warn(`[CHAT/P2P] ⏱️ stall detected! ${t.receivedChunks}/${t.totalChunks} chunks, ${secSinceLastChunk}s since last chunk:`, fileId);
            if (typeof App.showToast === 'function') {
              App.showToast(`⏱️ העברת "${t.name || 'קובץ'}" נתקעה (${Math.round(t.receivedChunks/t.totalChunks*100)}%) — מבקש שליחה מחדש...`, 'warning');
            }
            notifyProgress({ fileId, progress: t.receivedChunks / t.totalChunks, status: 'stalled-requesting-resend', direction: 'receive', name: t.name, size: t.size, peerPubkey: peerKey });
            // בקשת resend דרך DC
            const dc = dataChannels.get(peerKey);
            if (dc && dc.readyState === 'open') {
              try { dc.send(JSON.stringify({ type: 'file-resend-request', fileId, fromChunk: t.receivedChunks })); console.log('[CHAT/P2P] 🔄 stall resend-request דרך DC, fromChunk:', t.receivedChunks); } catch (_e) {}
            }
            // בקשת resend דרך Nostr signal
            if (typeof App.sendP2PSignal === 'function') {
              try { await App.sendP2PSignal(peerKey, { type: 'file-resend-request', fileId, fromChunk: t.receivedChunks }); } catch (_e) {}
            }
            // timeout אחרון — אם עדיין תקוע, fail
            t._resendTimer2 = setTimeout(() => {
              const t2 = activeTransfers.get(fileId);
              if (!t2 || t2.direction !== 'receive' || t2.receivedChunks >= t2.totalChunks) return;
              if (t2._lastChunkAt && (Date.now() - t2._lastChunkAt) < RESEND_WAIT_SEC * 1000) return; // chunks חזרו!
              console.error('[CHAT/P2P] ❌ stall לא טופל — transfer נכשל:', fileId);
              notifyProgress({ fileId, progress: t2.receivedChunks / t2.totalChunks, status: 'failed', direction: 'receive', name: t2.name, size: t2.size, peerPubkey: peerKey, error: 'stalled mid-transfer' });
              if (typeof App.showToast === 'function') {
                App.showToast(`❌ "${t2.name || 'קובץ'}" נכשל (${Math.round(t2.receivedChunks/t2.totalChunks*100)}%) — בקש שליחה מחדש`, 'error');
              }
              activeTransfers.delete(fileId);
            }, RESEND_WAIT_SEC * 1000);
          }, RESEND_WAIT_SEC * 1000);
        }

        // התקדמות לקבלה
        notifyProgress({
          fileId,
          progress: transfer.receivedChunks / transfer.totalChunks,
          status: 'receiving',
          direction: 'receive',
          name: transfer.name,
          size: transfer.size,
          mimeType: transfer.mimeType,
          peerPubkey: peerKey
        });
        
        // חלק chunk-ack (chat-p2p-file.js) — שולח אישור אחרי כל chunk (stop-and-wait protocol) | HYPER CORE TECH
        {
          const ackChannel = dataChannels.get(peerKey);
          if (ackChannel && ackChannel.readyState === 'open') {
            try {
              ackChannel.send(JSON.stringify({ type: 'chunk-ack', fileId, index: chunkIndex }));
            } catch (_e) {}
          }
        }
        
        // Save to IndexedDB periodically
        if (transfer.receivedChunks % 20 === 0) {
          await saveTransferState(fileId, transfer);
        }
        
        if (transfer.receivedChunks >= transfer.totalChunks) {
          await finalizeReceive(fileId, transfer);
        }
        
        return; // מצאנו transfer מתאים — יציאה
      }
    }
    // חלק buffer chunks (chat-p2p-file.js) – אם אין transfer מתאים, שומרים chunk ב-buffer (race condition fix) | HYPER CORE TECH
    if (!pendingChunks.has(peerKey)) pendingChunks.set(peerKey, []);
    pendingChunks.get(peerKey).push(encryptedData);
    console.log('[CHAT/P2P] 📦 Chunk buffered (ממתין ל-file-offer)', peerKey.slice(0,8), 'buffered:', pendingChunks.get(peerKey).length);
  }

  // חלק resend handler (chat-p2p-file.js) — שולח קובץ מחדש מ-cache כשהמקבל מבקש | HYPER CORE TECH
  async function handleFileResendRequest(requesterPubkey, msg) {
    const fileId = msg.fileId;
    // בדיקה ראשונה: האם הקובץ עדיין בשליחה פעילה? אם כן — מתעלם (לא צריך resend)
    if (activeTransfers.has(fileId)) {
      const t = activeTransfers.get(fileId);
      if (t.direction === 'send') {
        console.log('[CHAT/P2P] 🔄 file-ready/resend התקבל אבל שליחה פעילה — מתעלם:', fileId, `(chunk ${t.currentChunk}/${t.totalChunks})`);
        return;
      }
    }
    const cached = recentCompletedFiles.get(fileId);
    if (!cached) {
      console.warn('[CHAT/P2P] ⚠️ resend request עבור fileId שלא ב-cache:', fileId);
      // שולח הודעת כשלון למקבל דרך DC
      const ch = dataChannels.get(toPeerKey(requesterPubkey));
      if (ch && ch.readyState === 'open') {
        try { ch.send(JSON.stringify({ type: 'file-resend-failed', fileId, reason: 'file-expired' })); } catch (_e) {}
      }
      return;
    }
    const fromChunk = Math.max(0, parseInt(msg.fromChunk) || 0);
    console.log('[CHAT/P2P] 🔄 מתחיל resend עבור:', fileId, cached.file?.name, 'fromChunk:', fromChunk);
    if (typeof App.showToast === 'function') {
      App.showToast(`🔄 שולח מחדש: ${cached.file?.name || 'קובץ'} (מ-chunk ${fromChunk})`, 'info');
    }
    // שליחה מחדש — שימוש חוזר באותו fileId ומפתח הצפנה, מתחיל מ-fromChunk
    const peerKey = toPeerKey(requesterPubkey);
    const file = cached.file;
    const key = await importFileKey(cached.keyStr);
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const transfer = {
      fileId, file, key, keyStr: cached.keyStr, peerPubkey: peerKey,
      direction: 'send', currentChunk: fromChunk, totalChunks,
      ackReceived: 0, paused: false, startTime: Date.now(),
      dcWaitAttempts: 0, channel: null, isResend: true
    };
    activeTransfers.set(fileId, transfer);
    notifyProgress({ fileId, progress: fromChunk / totalChunks, status: 'resending', direction: 'send', name: file.name, size: file.size, mimeType: file.type, peerPubkey: peerKey });
    await sendNextChunk(fileId, null);
  }

  // חלק קבלת file-offer (chat-p2p-file.js) – טיפול בהצעת קובץ נכנסת מ-peer | HYPER CORE TECH
  async function handleP2PFileOffer(senderPubkey, offerData) {
    const senderKey = toPeerKey(senderPubkey);
    try {
      const { fileId, name, size, mimeType, keyStr, totalChunks } = offerData || {};
      
      console.log('[CHAT/P2P] 📥 handleP2PFileOffer', {
        from: senderKey?.slice?.(0, 12) + '...',
        fileId,
        name,
        size,
        totalChunks
      });
      
      if (!fileId || !keyStr) {
        console.warn('[CHAT/P2P] ⚠️ file-offer חסר fileId או keyStr');
        return;
      }
      
      // בדיקה אם כבר יש העברה פעילה עבור fileId זה
      if (activeTransfers.has(fileId)) {
        console.log('[CHAT/P2P] העברה כבר קיימת עבור fileId:', fileId);
        return;
      }
      
      // ייבוא מפתח ההצפנה
      const key = await importFileKey(keyStr);
      
      // יצירת transfer state לקבלה
      const transfer = {
        fileId,
        name,
        size,
        mimeType,
        key,
        keyStr,
        peerPubkey: senderKey,
        direction: 'receive',
        totalChunks: totalChunks || Math.ceil(size / CHUNK_SIZE),
        receivedChunks: 0,
        chunks: [],
        startTime: Date.now()
      };
      
      activeTransfers.set(fileId, transfer);
      
      console.log('[CHAT/P2P] ✅ transfer state נוצר לקבלה', {
        fileId,
        name,
        totalChunks: transfer.totalChunks
      });
      
      // עדכון UI על התחלת קבלה
      notifyProgress({
        fileId,
        progress: 0,
        status: 'waiting',
        direction: 'receive',
        name,
        size,
        mimeType,
        peerPubkey: senderKey
      });
      
      // ניסיון להשיג DataChannel מ-p2p-video-sharing.js
      const conn = typeof App.getPersistentConnection === 'function' 
        ? App.getPersistentConnection(senderKey) 
        : null;
      
      if (conn && conn.channel && conn.channel.readyState === 'open') {
        console.log('[CHAT/P2P] 🔗 משתמש ב-persistent DataChannel לקבלת צ\'אנקים');
        conn.channel.binaryType = 'arraybuffer'; // חובה — בלי זה binary מגיע כ-Blob ונזרק
        // שמירת ה-channel המקושר
        dataChannels.set(senderKey, conn.channel);
        
        // הוספת handler להודעות נכנסות אם אין
        if (!conn.channel._p2pFileHandler) {
          conn.channel._p2pFileHandler = true;
          conn.channel.addEventListener('message', (event) => {
            handleIncomingMessage(senderKey, event.data);
          });
        }
      } else {
        // חלק DC fallback + חיבור אקטיבי (chat-p2p-file.js) – מנסה לחבר DC אם אין, ושולח file-ready | HYPER CORE TECH
        const existingDC = dataChannels.get(senderKey);
        if (existingDC && existingDC.readyState === 'open') {
          console.log('[CHAT/P2P] 🔗 משתמש ב-file DC קיים');
        } else {
          console.log('[CHAT/P2P] ⚠️ אין DC פתוח עדיין, מנסה לחבר...');
          // ניסיון אקטיבי לחבר DC
          if (App.dataChannel && !App.dataChannel.isConnected(senderKey)) {
            try {
              App.dataChannel.init?.();
              if (typeof App.dataChannel.forceConnect === 'function') {
                await App.dataChannel.forceConnect(senderKey);
              } else {
                App.dataChannel.connect(senderKey);
              }
              // ממתין עד 5 שניות ל-DC
              for (let i = 0; i < 25; i++) {
                await new Promise(r => setTimeout(r, 200));
                if (App.dataChannel.isConnected(senderKey)) {
                  console.log('[CHAT/P2P] ⚡ DC מחובר! שולח file-ready לשולח');
                  break;
                }
              }
            } catch (e) {
              console.warn('[CHAT/P2P] ⚠️ שגיאה בחיבור DC:', e.message);
            }
          }
        }
      }

      // חלק file-ready (chat-p2p-file.js) — שולח הודעת מוכנות לשולח כשה-DC פתוח | HYPER CORE TECH
      const readyDC = dataChannels.get(senderKey);
      const chatDC = App.dataChannel?.isConnected?.(senderKey);
      if (readyDC && readyDC.readyState === 'open') {
        try {
          readyDC.send(JSON.stringify({ type: 'file-ready', fileId }));
          console.log('[CHAT/P2P] 📤 file-ready נשלח דרך file DC');
        } catch (_e) {}
      } else if (chatDC) {
        // שולח דרך chat DC
        const chatPC = App.dataChannel?.getChatPC?.(senderKey);
        if (chatPC && chatPC.connectionState === 'connected') {
          try {
            const tmpCh = chatPC.createDataChannel('file-transfer', { ordered: true });
            tmpCh.binaryType = 'arraybuffer';
            tmpCh._p2pFileHandler = true;
            tmpCh.addEventListener('message', (event) => handleIncomingMessage(senderKey, event.data));
            tmpCh.addEventListener('close', () => { if (dataChannels.get(senderKey) === tmpCh) dataChannels.delete(senderKey); });
            dataChannels.set(senderKey, tmpCh);
            if (tmpCh.readyState !== 'open') {
              await new Promise((resolve) => {
                const t = setTimeout(resolve, 3000);
                tmpCh.onopen = () => { clearTimeout(t); resolve(); };
              });
            }
            if (tmpCh.readyState === 'open') {
              tmpCh.send(JSON.stringify({ type: 'file-ready', fileId }));
              console.log('[CHAT/P2P] 📤 file-ready נשלח דרך chat DC חדש');
            }
          } catch (e) { console.warn('[CHAT/P2P] file-ready via chat DC failed:', e.message); }
        }
      }

      // חלק replay buffer (chat-p2p-file.js) – השמעת chunks שהגיעו לפני ה-file-offer (race condition fix) | HYPER CORE TECH
      const buffered = pendingChunks.get(senderKey);
      if (buffered && buffered.length > 0) {
        console.log('[CHAT/P2P] 📦 Replaying', buffered.length, 'buffered chunks for', fileId);
        const chunksToReplay = [...buffered];
        pendingChunks.delete(senderKey);
        for (const chunkData of chunksToReplay) {
          await handleChunkData(senderKey, chunkData);
        }
      }

      // חלק timeout resend (chat-p2p-file.js) — אם לא הגיעו chunks תוך RESEND_WAIT_SEC שניות, מבקש resend | HYPER CORE TECH
      transfer._resendTimer = setTimeout(async () => {
        const t = activeTransfers.get(fileId);
        if (!t || t.direction !== 'receive') return;
        if (t.receivedChunks > 0) return; // chunks הגיעו — הכל תקין
        console.warn('[CHAT/P2P] ⏱️ לא הגיעו chunks תוך', RESEND_WAIT_SEC, 'שניות עבור:', fileId, name);
        if (typeof App.showToast === 'function') {
          App.showToast(`⏱️ ממתין לקובץ "${name || 'קובץ'}" — מבקש שליחה מחדש...`, 'warning');
        }
        notifyProgress({ fileId, progress: 0, status: 'requesting-resend', direction: 'receive', name, size, mimeType, peerPubkey: senderKey });
        // ניסיון 1: בקשת resend דרך DC (עם fromChunk)
        const dc = dataChannels.get(senderKey);
        if (dc && dc.readyState === 'open') {
          try { dc.send(JSON.stringify({ type: 'file-resend-request', fileId, fromChunk: 0 })); console.log('[CHAT/P2P] 🔄 file-resend-request נשלח דרך DC (fromChunk:0)'); } catch (_e) {}
        }
        // ניסיון 2: בקשת resend דרך Nostr signal
        if (typeof App.sendP2PSignal === 'function') {
          try {
            await App.sendP2PSignal(senderKey, { type: 'file-resend-request', fileId, fromChunk: 0 });
            console.log('[CHAT/P2P] 🔄 file-resend-request נשלח דרך Nostr signal (fromChunk:0)');
          } catch (_e) {}
        }
        // timeout שני — אם עדיין לא הגיעו chunks, fallback
        transfer._resendTimer2 = setTimeout(() => {
          const t2 = activeTransfers.get(fileId);
          if (!t2 || t2.direction !== 'receive' || t2.receivedChunks > 0) return;
          console.error('[CHAT/P2P] ❌ resend נכשל — הקובץ לא הגיע אחרי 2 ניסיונות');
          notifyProgress({ fileId, progress: 0, status: 'failed', direction: 'receive', name, size, peerPubkey: senderKey, error: 'no chunks received after resend' });
          if (typeof App.showToast === 'function') {
            App.showToast(`❌ הקובץ "${name || 'קובץ'}" לא התקבל — בקש מהשולח לשלוח שוב`, 'error');
          }
          activeTransfers.delete(fileId);
        }, RESEND_WAIT_SEC * 1000);
      }, RESEND_WAIT_SEC * 1000);

    } catch (err) {
      console.error('[CHAT/P2P] ❌ כשלון ב-handleP2PFileOffer:', err);
    }
  }

  // חלק שמירת מצב (chat-p2p-file.js) – שמירת מצב העברה ל-IndexedDB לצורך resume | HYPER CORE TECH
  async function saveTransferState(fileId, transfer) {
    try {
      // בדיקה אם יש SOS2MediaCache זמין
      if (typeof App.SOS2MediaCache === 'undefined' || !App.SOS2MediaCache) {
        console.log('[CHAT/P2P] IndexedDB cache לא זמין, דילוג על שמירה');
        return;
      }
      
      const stateToSave = {
        fileId,
        name: transfer.name,
        size: transfer.size,
        mimeType: transfer.mimeType,
        keyStr: transfer.keyStr,
        peerPubkey: transfer.peerPubkey,
        direction: transfer.direction,
        totalChunks: transfer.totalChunks,
        receivedChunks: transfer.receivedChunks,
        startTime: transfer.startTime,
        lastUpdate: Date.now()
      };
      
      console.log('[CHAT/P2P] 💾 שומר מצב העברה', { fileId, receivedChunks: transfer.receivedChunks });
      
      // שמירה ל-IndexedDB דרך media-cache אם זמין
      if (typeof App.SOS2MediaCache.saveTransferState === 'function') {
        await App.SOS2MediaCache.saveTransferState(fileId, stateToSave);
      }
    } catch (err) {
      console.warn('[CHAT/P2P] ⚠️ כשלון בשמירת מצב העברה:', err);
    }
  }

  // חלק סיום קבלה (chat-p2p-file.js) – הרכבת הקובץ ושמירה ל-cache | HYPER CORE TECH
  async function finalizeReceive(fileId, transfer) {
    try {
      console.log('[CHAT/P2P] 🎉 מסיים קבלת קובץ', {
        fileId,
        name: transfer.name,
        chunks: transfer.chunks.length,
        totalSize: transfer.size
      });
      // חלק דיבאג קבלה (chat-p2p-file.js) – רישום מטא אחרי הרכבת קובץ | HYPER CORE TECH
      mediaDebugLog('receive-finalize', { fileId, name: transfer.name, size: transfer.size, mimeType: transfer.mimeType });
      
      // הרכבת כל הצ'אנקים ל-Blob
      const blob = new Blob(transfer.chunks, { type: transfer.mimeType || 'application/octet-stream' });
      
      // שמירה ל-cache אם זמין
      if (typeof App.SOS2MediaCache !== 'undefined' && App.SOS2MediaCache) {
        try {
          const url = URL.createObjectURL(blob);
          const cacheKey = `p2p-file-${fileId}`;
          
          if (typeof App.SOS2MediaCache.put === 'function') {
            await App.SOS2MediaCache.put(cacheKey, blob, {
              name: transfer.name,
              size: transfer.size,
              mimeType: transfer.mimeType,
              fileId,
              peerPubkey: transfer.peerPubkey,
              receivedAt: Date.now()
            });
            console.log('[CHAT/P2P] 💾 קובץ נשמר ב-cache', { cacheKey });
          }
          
          // ניקוי transfer state מה-cache
          if (typeof App.SOS2MediaCache.deleteTransferState === 'function') {
            await App.SOS2MediaCache.deleteTransferState(fileId);
          }
        } catch (cacheErr) {
          console.warn('[CHAT/P2P] ⚠️ כשלון בשמירה ל-cache:', cacheErr);
        }
      }
      
      // הסרת ההעברה מהרשימה הפעילה
      activeTransfers.delete(fileId);
      
      // עדכון UI על סיום
      notifyProgress({
        fileId,
        progress: 1,
        status: 'complete',
        direction: 'receive',
        name: transfer.name,
        size: transfer.size,
        mimeType: transfer.mimeType,
        peerPubkey: transfer.peerPubkey,
        blob
      });
      
      console.log('[CHAT/P2P] ✅ קבלת קובץ הושלמה בהצלחה!', { fileId, name: transfer.name });

      // חלק הודעת צ'אט למקבל (chat-p2p-file.js) — הצגת הקובץ בצ'אט עם blob URL להורדה ישירה | HYPER CORE TECH
      try {
        const blobUrl = URL.createObjectURL(blob);
        if (typeof App.appendChatMessage === 'function') {
          const createdAt = Math.floor(Date.now() / 1000);
          const resolvedMime = resolveMimeType(transfer.mimeType, transfer.name);
          const isVideoFlag = shouldForceVideoFlag(transfer.mimeType, transfer.name);
          App.appendChatMessage({
            id: `p2p-recv-${fileId}`,
            direction: 'incoming',
            from: transfer.peerPubkey,
            to: App.publicKey,
            content: `📎 ${transfer.name}`,
            attachment: { name: transfer.name, size: transfer.size, type: resolvedMime || transfer.mimeType, url: blobUrl, fileId, isVideo: isVideoFlag || undefined },
            p2p: true,
            createdAt,
          });
          console.log('[CHAT/P2P] 💬 הודעת צ\'אט נוצרה למקבל עם blob URL להורדה ישירה');
        }
      } catch (msgErr) { console.warn('[CHAT/P2P] appendChatMessage failed:', msgErr); }

      // חלק ACK סיום (chat-p2p-file.js) — שליחת אישור קבלה מלאה חזרה לשולח | HYPER CORE TECH
      try {
        const ackChannel = dataChannels.get(transfer.peerPubkey);
        if (ackChannel && ackChannel.readyState === 'open') {
          ackChannel.send(JSON.stringify({ type: 'file-complete-ack', fileId, name: transfer.name, size: transfer.size }));
          console.log('[CHAT/P2P] 📨 ACK קבלה מלאה נשלח לשולח', fileId);
        }
      } catch (ackErr) { console.warn('[CHAT/P2P] ACK send failed:', ackErr); }
      
    } catch (err) {
      console.error('[CHAT/P2P] ❌ כשלון בסיום קבלה:', err);
      notifyProgress({
        fileId,
        progress: 0,
        status: 'failed',
        direction: 'receive',
        error: err.message
      });
    }
  }

  // חלק זיהוי סוג קובץ (chat-p2p-file.js) – בודק אם קובץ נתמך ע"י Blossom (מדיה בלבד) | HYPER CORE TECH
  function isBlossomSupported(mimeType) {
    if (!mimeType) return false;
    const m = mimeType.toLowerCase();
    return m.startsWith('image/') || m.startsWith('video/') || m.startsWith('audio/');
  }

  // חלק fallback חכם (chat-p2p-file.js) – מדיה → Blossom, שאר קבצים → WebTorrent P2P | HYPER CORE TECH
  async function fallbackToBlossom(transfer, onProgress) {
    try {
      const mime = transfer.file?.type || '';
      const fileName = transfer.file?.name || 'קובץ';
      const fileSize = transfer.file?.size || 0;
      // חלק דיבאג fallback (chat-p2p-file.js) – רישום מסלול נבחר ומאפייני הקובץ | HYPER CORE TECH
      mediaDebugLog('fallback-check', { fileId: transfer.fileId, name: fileName, size: fileSize, mime, blossomSupported: isBlossomSupported(mime) });

      // חלק ניתוב ל-WebTorrent (chat-p2p-file.js) – קבצים שלא נתמכים ע"י Blossom מועברים דרך WebTorrent | HYPER CORE TECH
      if (!isBlossomSupported(mime)) {
        mediaDebugLog('fallback-to-torrent', { fileId: transfer.fileId, name: fileName, size: fileSize, mime });
        console.log('[CHAT/P2P] 🧲 קובץ לא-נתמך Blossom, מעביר דרך WebTorrent P2P', { name: fileName, type: mime });
        await fallbackToTorrent(transfer, onProgress);
        return;
      }

      console.log('[CHAT/P2P] 🔄 Fallback to Blossom upload', {
        fileId: transfer.fileId,
        name: fileName,
        size: fileSize
      });
      
      // בדיקה אם יש פונקציית העלאה ל-Blossom
      if (typeof App.uploadToBlossom !== 'function') {
        console.warn('[CHAT/P2P] ⚠️ App.uploadToBlossom לא זמין, מנסה WebTorrent');
        await fallbackToTorrent(transfer, onProgress);
        return;
      }
      
      // חלק fallback (chat-p2p-file.js) – עדכון progress לפני התחלת העלאה | HYPER CORE TECH
      const uploadingPayload = {
        fileId: transfer.fileId,
        progress: 0.1,
        status: 'uploading-blossom',
        direction: 'send',
        name: fileName,
        size: fileSize,
        mimeType: mime,
        peerPubkey: transfer.peerPubkey
      };
      if (onProgress) onProgress(uploadingPayload);
      notifyProgress(uploadingPayload);
      
      // העלאה ל-Blossom - הפונקציה מחזירה URL ישירות (לא object)
      console.log('[CHAT/P2P] 📤 מתחיל העלאה ל-Blossom...');
      let resultUrl;
      try {
        resultUrl = await App.uploadToBlossom(transfer.file);
        console.log('[CHAT/P2P] 📤 תוצאת העלאה:', resultUrl);
      } catch (uploadErr) {
        // חלק שגיאות Blossom (chat-p2p-file.js) – הודעה מפורטת למשתמש עם סיבת כשל ושם קובץ | HYPER CORE TECH
        const reason = uploadErr?.message || 'שגיאה לא ידועה';
        console.warn('[CHAT/P2P] ⚠️ Blossom נכשל, מנסה WebTorrent...', reason);
        if (typeof App.showToast === 'function') {
          App.showToast(`העלאת "${fileName}" ל-Blossom נכשלה (${reason}). עובר למסלול חלופי...`, 'warning');
        }
        await fallbackToTorrent(transfer, onProgress);
        return;
      }
      
      if (resultUrl && typeof resultUrl === 'string') {
        console.log('[CHAT/P2P] ✅ Blossom upload הצליח', { url: resultUrl });
        mediaDebugLog('blossom-upload-success', { fileId: transfer.fileId, name: fileName, size: fileSize, mime, url: resultUrl });
        
        // חלק fallback (chat-p2p-file.js) – שליחת הודעת צ'אט עם קישור Blossom | HYPER CORE TECH
        // שולחים את ה-URL כהודעת צ'אט לצד השני
        try {
          if (typeof App.publishChatMessage === 'function') {
            // חלק Blossom UI (chat-p2p-file.js) – שליחת attachment עם URL כדי להציג preview ולא רק לינק | HYPER CORE TECH
            const resolvedMime = resolveMimeType(mime, fileName);
            const isVideoFlag = shouldForceVideoFlag(mime, fileName);
            // חלק דיבאג attachment (chat-p2p-file.js) – לוג מטא של מצורף Blossom | HYPER CORE TECH
            mediaDebugLog('blossom-attachment', { fileId: transfer.fileId, name: fileName, size: fileSize, mime: resolvedMime || mime, isVideo: isVideoFlag || false, url: resultUrl });
            const attachment = {
              id: `blossom-${Date.now()}`,
              name: fileName,
              size: fileSize,
              type: resolvedMime || mime || 'application/octet-stream',
              url: resultUrl,
              dataUrl: '',
              fileId: transfer.fileId,
              isVideo: isVideoFlag || undefined,
            };
            if (typeof App.setChatFileAttachment === 'function') {
              App.setChatFileAttachment(transfer.peerPubkey, attachment);
            }
            const messageText = `📎 ${fileName}`;
            const publishResult = await App.publishChatMessage(transfer.peerPubkey, messageText);
            if (publishResult?.ok) {
              console.log('[CHAT/P2P] 📨 הודעת צ\'אט עם attachment נשלחה', { peer: transfer.peerPubkey?.slice(0, 8), url: resultUrl });
              mediaDebugLog('blossom-message-sent', { fileId: transfer.fileId, peer: transfer.peerPubkey, messageId: publishResult.messageId || null });
            } else {
              console.warn('[CHAT/P2P] ⚠️ שליחת הודעה נכשלה:', publishResult?.error);
              mediaDebugLog('blossom-message-failed', { fileId: transfer.fileId, error: publishResult?.error || 'unknown' });
              if (typeof App.clearChatFileAttachment === 'function') {
                App.clearChatFileAttachment(transfer.peerPubkey);
              }
            }
          } else {
            console.warn('[CHAT/P2P] ⚠️ App.publishChatMessage לא זמין');
          }
        } catch (msgErr) {
          console.error('[CHAT/P2P] ❌ כשלון בשליחת הודעת צ\'אט:', msgErr);
        }
        
        // עדכון סטטוס סיום
        const completePayload = {
          fileId: transfer.fileId,
          progress: 1,
          status: 'complete-blossom',
          direction: 'send',
          name: transfer.file?.name,
          size: transfer.file?.size,
          mimeType: transfer.file?.type,
          peerPubkey: transfer.peerPubkey,
          blossomUrl: resultUrl
        };
        if (onProgress) onProgress(completePayload);
        notifyProgress(completePayload);
        
        // חלק fallback (chat-p2p-file.js) – ניקוי ה-attachment מה-state לאחר העלאה מוצלחת | HYPER CORE TECH
        if (typeof App.clearChatFileAttachment === 'function') {
          App.clearChatFileAttachment(transfer.peerPubkey);
          console.log('[CHAT/P2P] 🧹 Attachment נוקה מה-state');
        }
      }
      
      // הסרת ההעברה מהרשימה
      activeTransfers.delete(transfer.fileId);
      
    } catch (err) {
      console.error('[CHAT/P2P] ❌ Blossom fallback failed:', err);
      notifyProgress({
        fileId: transfer.fileId,
        progress: 0,
        status: 'failed',
        direction: 'send',
        error: err.message
      });
      notifyTransferError(transfer.peerPubkey, `שליחת הקובץ נכשלה במסלול fallback (${err?.message || 'unknown'}).`, 'fallback-failed');
      activeTransfers.delete(transfer.fileId);
    }
  }

  // חלק fallback טורנט (chat-p2p-file.js) – העברת קבצים לא-נתמכים דרך WebTorrent P2P עם retry | HYPER CORE TECH
  const TORRENT_MAX_RETRIES = 3;        // מספר ניסיונות מקסימלי לשליחת קובץ טורנט
  const TORRENT_RETRY_DELAY_MS = 2000;  // השהייה בין ניסיונות (ms)

  async function fallbackToTorrent(transfer, onProgress) {
    const fileName = transfer.file?.name || 'קובץ';
    const fileSize = transfer.file?.size || 0;
    const mime = transfer.file?.type || 'application/octet-stream';

    // חלק בדיקת זמינות (chat-p2p-file.js) – וידוא שמערכת WebTorrent זמינה לפני ניסיון | HYPER CORE TECH
    // משתמשים ב-seedOnly (seedFile) כדי לעשות seed בלבד — ללא UI כפול וללא הודעת transfer request מיותרת
    if (!App.torrentTransfer || typeof App.torrentTransfer.seedOnly !== 'function') {
      console.error('[CHAT/P2P] ❌ WebTorrent לא זמין');
      notifyProgress({ fileId: transfer.fileId, progress: 0, status: 'failed', direction: 'send', error: 'WebTorrent not available', name: fileName, size: fileSize, peerPubkey: transfer.peerPubkey });
      activeTransfers.delete(transfer.fileId);
      return;
    }

    // חלק retry loop (chat-p2p-file.js) – לולאת ניסיונות חוזרים עם עדכוני progress לשולח | HYPER CORE TECH
    let lastError = '';
    for (let attempt = 1; attempt <= TORRENT_MAX_RETRIES; attempt++) {
      try {
        // עדכון progress — מציג ניסיון נוכחי
        const attemptLabel = TORRENT_MAX_RETRIES > 1 ? ` (ניסיון ${attempt}/${TORRENT_MAX_RETRIES})` : '';
        const seedingPayload = { fileId: transfer.fileId, progress: 0.05 * attempt, status: 'seeding-torrent', direction: 'send', name: fileName, size: fileSize, mimeType: mime, peerPubkey: transfer.peerPubkey, attempt, maxRetries: TORRENT_MAX_RETRIES };
        if (onProgress) onProgress(seedingPayload);
        notifyProgress(seedingPayload);

        console.log(`[CHAT/P2P] 🧲 Seeding${attemptLabel}...`, { name: fileName, size: fileSize });
        const seedResult = await App.torrentTransfer.seedOnly(transfer.file, transfer.peerPubkey);

        if (!seedResult || !seedResult.success || !seedResult.magnetURI) {
          lastError = seedResult?.error || 'Torrent seed failed';
          console.warn(`[CHAT/P2P] ⚠️ Seed נכשל${attemptLabel}:`, lastError);
          mediaDebugLog('torrent-seed-failed', { fileId: transfer.fileId, attempt, error: lastError });
          if (attempt < TORRENT_MAX_RETRIES) {
            // עדכון progress — ממתין לניסיון חוזר
            notifyProgress({ fileId: transfer.fileId, progress: 0, status: 'retrying-torrent', direction: 'send', name: fileName, size: fileSize, peerPubkey: transfer.peerPubkey, attempt, maxRetries: TORRENT_MAX_RETRIES, error: lastError });
            await new Promise(r => setTimeout(r, TORRENT_RETRY_DELAY_MS));
            continue;
          }
          // כל הניסיונות נכשלו — שולחים הודעת כשלון לצד המקבל עם אפשרות retry
          console.error('[CHAT/P2P] ❌ כל הניסיונות נכשלו');
          notifyProgress({ fileId: transfer.fileId, progress: 0, status: 'failed', direction: 'send', name: fileName, size: fileSize, peerPubkey: transfer.peerPubkey, error: lastError });
          notifyTransferError(transfer.peerPubkey, `שליחת טורנט נכשלה: ${lastError || 'unknown'}`, 'torrent-failed');
          activeTransfers.delete(transfer.fileId);
          return;
        }

        // חלק הצלחת seeding (chat-p2p-file.js) – Seed הצליח, שולחים הודעת צ'אט עם magnetURI | HYPER CORE TECH
        console.log('[CHAT/P2P] ✅ Seed הצליח, magnetURI:', seedResult.magnetURI.slice(0, 60) + '...');
        mediaDebugLog('torrent-seed-success', { fileId: transfer.fileId, infoHash: seedResult.infoHash || null, magnetPreview: seedResult.magnetURI.slice(0, 60) });

        let messageSent = false;
        if (typeof App.setChatFileAttachment === 'function' && typeof App.publishChatMessage === 'function') {
          const torrentAttachment = {
            id: transfer.fileId,
            name: fileName,
            size: fileSize,
            type: mime,
            magnetURI: seedResult.magnetURI,
            infoHash: seedResult.infoHash,
            isTorrent: true,
          };
          App.setChatFileAttachment(transfer.peerPubkey, torrentAttachment);
          const displayText = `📎 ${fileName}`;
          const result = await App.publishChatMessage(transfer.peerPubkey, displayText);
          if (result?.ok) {
            messageSent = true;
            console.log('[CHAT/P2P] 📨 הודעת טורנט נשלחה בהצלחה', { peer: transfer.peerPubkey?.slice(0, 8), name: fileName });
          } else {
            console.warn('[CHAT/P2P] ⚠️ שליחת הודעת טורנט נכשלה:', result?.error);
          }
        }

        // חלק אישור שליחה (chat-p2p-file.js) – עדכון סטטוס סופי לשולח: נשלח/נכשל | HYPER CORE TECH
        const finalStatus = messageSent ? 'complete-torrent' : 'sent-no-confirm';
        const completePayload = { fileId: transfer.fileId, progress: 1, status: finalStatus, direction: 'send', name: fileName, size: fileSize, mimeType: mime, peerPubkey: transfer.peerPubkey, magnetURI: seedResult.magnetURI, messageSent };
        if (onProgress) onProgress(completePayload);
        notifyProgress(completePayload);

        // ניקוי attachment מה-state (הטורנט עצמו ממשיך לעשות seed ברקע!)
        if (typeof App.clearChatFileAttachment === 'function') {
          App.clearChatFileAttachment(transfer.peerPubkey);
        }
        activeTransfers.delete(transfer.fileId);
        return; // הצלחה — יציאה מהלולאה

      } catch (err) {
        lastError = err.message || 'Unknown error';
        console.warn(`[CHAT/P2P] ⚠️ ניסיון ${attempt} נכשל:`, lastError);
        if (attempt < TORRENT_MAX_RETRIES) {
          notifyProgress({ fileId: transfer.fileId, progress: 0, status: 'retrying-torrent', direction: 'send', name: fileName, size: fileSize, peerPubkey: transfer.peerPubkey, attempt, maxRetries: TORRENT_MAX_RETRIES, error: lastError });
          await new Promise(r => setTimeout(r, TORRENT_RETRY_DELAY_MS));
        }
      }
    }

    // חלק כשלון סופי (chat-p2p-file.js) – כל הניסיונות נכשלו | HYPER CORE TECH
    console.error('[CHAT/P2P] ❌ WebTorrent fallback נכשל אחרי', TORRENT_MAX_RETRIES, 'ניסיונות');
    notifyProgress({ fileId: transfer.fileId, progress: 0, status: 'failed', direction: 'send', name: fileName, size: fileSize, peerPubkey: transfer.peerPubkey, error: lastError });
    notifyTransferError(transfer.peerPubkey, `שליחת הקובץ נכשלה אחרי ${TORRENT_MAX_RETRIES} ניסיונות.`, 'torrent-retries-exhausted');
    activeTransfers.delete(transfer.fileId);
  }

  // חלק קבלת ערוץ קבצים (chat-p2p-file.js) – handler לערוץ file-transfer שנפתח ע"י הצד השני | HYPER CORE TECH
  function onFileDataChannel(peerPubkey, channel) {
    const key = toPeerKey(peerPubkey);
    console.log('[CHAT/P2P] ⚡ קיבלתי file-transfer DC מ-', key.slice(0, 8));
    channel.binaryType = 'arraybuffer';
    dataChannels.set(key, channel);
    if (!channel._p2pFileHandler) {
      channel._p2pFileHandler = true;
      channel.addEventListener('message', (event) => {
        handleIncomingMessage(key, event.data);
      });
    }
    channel.addEventListener('close', () => {
      console.log('[CHAT/P2P] file DC closed for', key.slice(0, 8));
      if (dataChannels.get(key) === channel) dataChannels.delete(key);
    });
  }

  // חלק API ציבורי (chat-p2p-file.js) – חשיפת פונקציות להעברת קבצים | HYPER CORE TECH
  // handleP2PFileMessage — נקודת כניסה אחידה מ-p2p-video-sharing.js לכל הודעות file-transfer (JSON + binary)
  function handleP2PFileMessage(peerPubkey, data) {
    handleIncomingMessage(peerPubkey, data);
  }

  // חלק דיאגנוסטיקה (chat-p2p-file.js) — בדיקת מצב חיבורים, DC, persistent, transfers | HYPER CORE TECH
  function diagnoseP2PFile(peerPubkey) {
    const peerKey = peerPubkey ? toPeerKey(peerPubkey) : null;
    console.group('🔍 [P2P-FILE DIAGNOSTICS]');
    // 1. persistent connection
    const peers = peerKey ? [peerKey] : [...dataChannels.keys()];
    if (peers.length === 0) {
      console.log('⚠️ אין peers ידועים ב-dataChannels map');
    }
    peers.forEach(pk => {
      const dc = dataChannels.get(pk);
      const conn = typeof App.getPersistentConnection === 'function' ? App.getPersistentConnection(pk) : null;
      const chatDC = App.dataChannel?.isConnected?.(pk);
      const chatPC = App.dataChannel?.getChatPC?.(pk);
      console.log(`📡 Peer ${pk.slice(0,8)}:`, {
        fileDataChannel: dc ? { readyState: dc.readyState, label: dc.label, binaryType: dc.binaryType, hasFileHandler: !!dc._p2pFileHandler } : 'NONE',
        persistentConnection: conn ? { channelState: conn.channel?.readyState, binaryType: conn.channel?.binaryType, busy: conn.busy } : 'NULL',
        chatDC: chatDC ? 'connected' : 'not connected',
        chatPC: chatPC ? { state: chatPC.connectionState, iceState: chatPC.iceConnectionState } : 'NONE'
      });
    });
    // 2. active transfers
    console.log(`📦 Active transfers: ${activeTransfers.size}`);
    for (const [fid, t] of activeTransfers) {
      console.log(`  ${t.direction} ${fid.slice(0,20)} "${t.name}" — chunk ${t.direction === 'send' ? t.currentChunk : t.receivedChunks}/${t.totalChunks}, channel: ${t.channel?.readyState || 'null'}`);
    }
    // 3. recent completed
    console.log(`💾 Recent completed files (resend cache): ${recentCompletedFiles.size}`);
    console.groupEnd();
    return { dataChannels: dataChannels.size, activeTransfers: activeTransfers.size, recentCompleted: recentCompletedFiles.size };
  }

  Object.assign(App, {
    sendP2PFile: sendFile,
    getOrCreateFileDataChannel: getOrCreateDataChannel,
    onFileDataChannel,
    activeP2PTransfers: activeTransfers,
    handleP2PFileOffer: handleP2PFileOffer,
    handleFileResendRequest: handleFileResendRequest,
    handleP2PFileMessage: handleP2PFileMessage,
    diagnoseP2PFile: diagnoseP2PFile,
    recentCompletedFiles: recentCompletedFiles,
    subscribeP2PFileProgress: (cb) => {
      if (typeof cb === 'function') {
        progressListeners.add(cb);
        return () => progressListeners.delete(cb);
      }
      return () => {};
    }
  });
})(window);
