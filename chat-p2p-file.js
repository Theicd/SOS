// חלק העברת קבצים P2P (chat-p2p-file.js) – העברת קבצים גדולים דרך WebRTC DataChannel עם הצפנה, resume, fallback | HYPER CORE TECH
(function initChatP2PFile(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  
  const CHUNK_SIZE = 256 * 1024; // 256KB per chunk
  const MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1MB buffer limit
  const ACK_INTERVAL = 10; // Send ACK every 10 chunks
  const TRANSFER_TIMEOUT = 30000; // 30s timeout for stalled transfers
  
  // חלק מצב העברות (chat-p2p-file.js) – מעקב אחר העברות פעילות | HYPER CORE TECH
  const activeTransfers = new Map(); // fileId -> transfer state
  const progressListeners = new Set(); // UI listeners for progress

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
    if (dataChannels.has(peerPubkey)) {
      return dataChannels.get(peerPubkey);
    }
    
    if (!pc) {
      console.warn('No PeerConnection available for', peerPubkey);
      return null;
    }
    
    try {
      const channel = pc.createDataChannel('file-transfer', {
        ordered: true,
        maxRetransmits: 3
      });
      
      channel.binaryType = 'arraybuffer';
      dataChannels.set(peerPubkey, channel);
      
      channel.onopen = () => {
        console.log('File transfer DataChannel opened for', peerPubkey.slice(0, 8));
      };
      
      channel.onclose = () => {
        console.log('File transfer DataChannel closed for', peerPubkey.slice(0, 8));
        dataChannels.delete(peerPubkey);
      };
      
      channel.onerror = (err) => {
        console.error('DataChannel error', err);
      };
      
      channel.onmessage = (event) => {
        handleIncomingMessage(peerPubkey, event.data);
      };
      
      return channel;
    } catch (err) {
      console.error('Failed to create DataChannel', err);
      return null;
    }
  }
  
  // חלק שליחה (chat-p2p-file.js) – שליחת קובץ בצ'אנקים מוצפנים | HYPER CORE TECH
  async function sendFile(peerPubkey, file, onProgress) {
    console.log('[CHAT/P2P] 📤 sendFile start', {
      peer: peerPubkey?.slice?.(0, 12) + '...',
      name: file?.name,
      size: file?.size,
      type: file?.type
    });
    
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = await generateFileKey();
    const keyStr = await exportFileKey(key);
    
    // בדיקת זמינות DataChannel לפני שליחה
    const conn = typeof App.getPersistentConnection === 'function' 
      ? App.getPersistentConnection(peerPubkey) 
      : null;
    const hasConnection = conn && conn.channel && conn.channel.readyState === 'open';
    
    console.log('[CHAT/P2P] 🔍 בדיקת חיבור', {
      hasPersistentConnection: hasConnection,
      channelState: conn?.channel?.readyState || 'none'
    });
    
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
      await App.sendP2PSignal(peerPubkey, metadata);
    } else {
      console.warn('[CHAT/P2P] ⚠️ App.sendP2PSignal לא זמין!');
    }
    
    const transfer = {
      fileId,
      file,
      key,
      keyStr,
      peerPubkey,
      direction: 'send',
      currentChunk: 0,
      totalChunks: metadata.totalChunks,
      ackReceived: 0,
      paused: false,
      startTime: Date.now()
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
      peerPubkey
    });
    
    // Start sending chunks
    await sendNextChunk(fileId, onProgress);
    
    return fileId;
  }
  
  async function sendNextChunk(fileId, onProgress) {
    const transfer = activeTransfers.get(fileId);
    if (!transfer || transfer.paused) return;
    
    const { file, key, peerPubkey, currentChunk, totalChunks } = transfer;
    
    if (currentChunk >= totalChunks) {
      // Transfer complete
      console.log('[CHAT/P2P] ✅ שליחת קובץ הושלמה', fileId);
      activeTransfers.delete(fileId);
      if (onProgress) onProgress({ fileId, progress: 1, status: 'complete' });
      notifyProgress({ fileId, progress: 1, status: 'complete', direction: 'send' });
      return;
    }
    
    // חלק DataChannel (chat-p2p-file.js) – ניסיון להשתמש ב-persistent connection מ-p2p-video-sharing.js | HYPER CORE TECH
    let channel = dataChannels.get(peerPubkey);
    
    // אם אין channel מקומי, ננסה לקבל מ-persistent connections
    if (!channel || channel.readyState !== 'open') {
      const conn = typeof App.getPersistentConnection === 'function' 
        ? App.getPersistentConnection(peerPubkey) 
        : null;
      
      if (conn && conn.channel && conn.channel.readyState === 'open') {
        console.log('[CHAT/P2P] 🔗 משתמש ב-persistent DataChannel לשליחה');
        channel = conn.channel;
        dataChannels.set(peerPubkey, channel);
        
        // הוספת handler להודעות נכנסות אם אין
        if (!channel._p2pFileHandler) {
          channel._p2pFileHandler = true;
          channel.addEventListener('message', (event) => {
            handleIncomingMessage(peerPubkey, event.data);
          });
        }
      }
    }
    
    if (!channel || channel.readyState !== 'open') {
      console.warn('[CHAT/P2P] ⚠️ DataChannel not ready, fallback to Blossom');
      await fallbackToBlossom(transfer, onProgress);
      return;
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
      
      const message = {
        type: 'chunk',
        fileId,
        index: currentChunk,
        data: encrypted
      };
      
      try {
        channel.send(JSON.stringify({ type: 'chunk-meta', fileId, index: currentChunk }));
        channel.send(encrypted);
        
        transfer.currentChunk++;
        
        const progressPayload = {
          fileId,
          progress: transfer.currentChunk / totalChunks,
          status: 'sending',
          direction: 'send',
          name: transfer.file?.name,
          size: transfer.file?.size,
          mimeType: transfer.file?.type,
          peerPubkey
        };
        if (onProgress) {
          onProgress(progressPayload);
        }
        notifyProgress(progressPayload);
      } catch (err) {
        console.error('[CHAT/P2P] Failed to send chunk', err);
        await fallbackToBlossom(transfer, onProgress);
      }
    };
    
    reader.readAsArrayBuffer(chunk);
  }

  // חלק קבלה (chat-p2p-file.js) – קבלת צ'אנקים והרכבת קובץ | HYPER CORE TECH

  // חלק קבלה (chat-p2p-file.js) – קבלת צ'אנקים והרכבת קובץ | HYPER CORE TECH
  function handleIncomingMessage(peerPubkey, data) {
    try {
      if (typeof data === 'string') {
        const msg = JSON.parse(data);
        if (msg.type === 'chunk-meta') {
          // Prepare to receive chunk data
          const transfer = activeTransfers.get(msg.fileId);
          if (transfer) {
            transfer.expectedChunk = msg.index;
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
        }
      } else if (data instanceof ArrayBuffer) {
        // Chunk data received
        handleChunkData(peerPubkey, new Uint8Array(data));
      }
    } catch (err) {
      console.error('handleIncomingMessage failed', err);
    }
  }

  async function handleChunkData(peerPubkey, encryptedData) {
    // Find active receive transfer
    for (const [fileId, transfer] of activeTransfers.entries()) {
      if (transfer.peerPubkey === peerPubkey && transfer.direction === 'receive') {
        const decrypted = await decryptChunk(encryptedData, transfer.key);
        if (!decrypted) {
          console.error('[CHAT/P2P] Decryption failed for chunk');
          return;
        }
        
        transfer.chunks.push(decrypted);
        transfer.receivedChunks++;

        // התקדמות לקבלה
        notifyProgress({
          fileId,
          progress: transfer.receivedChunks / transfer.totalChunks,
          status: 'receiving',
          direction: 'receive',
          name: transfer.name,
          size: transfer.size,
          mimeType: transfer.mimeType,
          peerPubkey
        });
        
        // Send ACK every N chunks
        if (transfer.receivedChunks % ACK_INTERVAL === 0) {
          const channel = dataChannels.get(peerPubkey);
          if (channel && channel.readyState === 'open') {
            channel.send(JSON.stringify({
              type: 'ack',
              fileId,
              index: transfer.receivedChunks
            }));
          }
        }
        
        // Save to IndexedDB periodically
        if (transfer.receivedChunks % 20 === 0) {
          await saveTransferState(fileId, transfer);
        }
        
        if (transfer.receivedChunks >= transfer.totalChunks) {
          await finalizeReceive(fileId, transfer);
        }
        
        break;
      }
    }
  }

  // חלק קבלת file-offer (chat-p2p-file.js) – טיפול בהצעת קובץ נכנסת מ-peer | HYPER CORE TECH
  async function handleP2PFileOffer(senderPubkey, offerData) {
    try {
      const { fileId, name, size, mimeType, keyStr, totalChunks } = offerData || {};
      
      console.log('[CHAT/P2P] 📥 handleP2PFileOffer', {
        from: senderPubkey?.slice?.(0, 12) + '...',
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
        peerPubkey: senderPubkey,
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
        peerPubkey: senderPubkey
      });
      
      // ניסיון להשיג DataChannel מ-p2p-video-sharing.js
      const conn = typeof App.getPersistentConnection === 'function' 
        ? App.getPersistentConnection(senderPubkey) 
        : null;
      
      if (conn && conn.channel && conn.channel.readyState === 'open') {
        console.log('[CHAT/P2P] 🔗 משתמש ב-persistent DataChannel לקבלת צ\'אנקים');
        // שמירת ה-channel המקושר
        dataChannels.set(senderPubkey, conn.channel);
        
        // הוספת handler להודעות נכנסות אם אין
        if (!conn.channel._p2pFileHandler) {
          conn.channel._p2pFileHandler = true;
          conn.channel.addEventListener('message', (event) => {
            handleIncomingMessage(senderPubkey, event.data);
          });
        }
      } else {
        console.log('[CHAT/P2P] ⚠️ אין persistent connection, מחכה לחיבור DataChannel');
      }
      
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

  // חלק fallback (chat-p2p-file.js) – העלאה ל-Blossom כאשר P2P לא זמין | HYPER CORE TECH
  async function fallbackToBlossom(transfer, onProgress) {
    try {
      console.log('[CHAT/P2P] 🔄 Fallback to Blossom upload', {
        fileId: transfer.fileId,
        name: transfer.file?.name,
        size: transfer.file?.size
      });
      
      // בדיקה אם יש פונקציית העלאה ל-Blossom
      if (typeof App.uploadToBlossom !== 'function') {
        console.warn('[CHAT/P2P] ⚠️ App.uploadToBlossom לא זמין');
        notifyProgress({
          fileId: transfer.fileId,
          progress: 0,
          status: 'failed',
          direction: 'send',
          error: 'Blossom upload not available'
        });
        return;
      }
      
      // העלאה ל-Blossom
      const result = await App.uploadToBlossom(transfer.file, (progress) => {
        const progressPayload = {
          fileId: transfer.fileId,
          progress: progress,
          status: 'uploading-blossom',
          direction: 'send',
          name: transfer.file?.name,
          size: transfer.file?.size,
          mimeType: transfer.file?.type,
          peerPubkey: transfer.peerPubkey
        };
        if (onProgress) onProgress(progressPayload);
        notifyProgress(progressPayload);
      });
      
      if (result && result.url) {
        console.log('[CHAT/P2P] ✅ Blossom upload הצליח', { url: result.url });
        
        // חלק fallback (chat-p2p-file.js) – שליחת הודעת צ'אט עם קישור Blossom | HYPER CORE TECH
        // שולחים את ה-URL כהודעת צ'אט לצד השני
        try {
          if (typeof App.publishChatMessage === 'function') {
            // בניית הודעה עם קישור למדיה - פורמט שה-chat-media-renderer יודע לזהות
            const mediaType = transfer.file?.type?.startsWith('video/') ? 'video' 
              : transfer.file?.type?.startsWith('audio/') ? 'audio'
              : transfer.file?.type?.startsWith('image/') ? 'image' 
              : 'file';
            
            // שולחים את ה-URL כטקסט פשוט - ה-renderer יזהה אותו אוטומטית
            const messageText = result.url;
            
            const publishResult = await App.publishChatMessage(transfer.peerPubkey, messageText);
            if (publishResult?.ok) {
              console.log('[CHAT/P2P] 📨 הודעת צ\'אט עם URL נשלחה', { peer: transfer.peerPubkey?.slice(0, 8), url: result.url });
            } else {
              console.warn('[CHAT/P2P] ⚠️ שליחת הודעה נכשלה:', publishResult?.error);
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
          blossomUrl: result.url
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
      activeTransfers.delete(transfer.fileId);
    }
  }

  // חלק API ציבורי (chat-p2p-file.js) – חשיפת פונקציות להעברת קבצים | HYPER CORE TECH
  Object.assign(App, {
    sendP2PFile: sendFile,
    getOrCreateFileDataChannel: getOrCreateDataChannel,
    activeP2PTransfers: activeTransfers,
    handleP2PFileOffer: handleP2PFileOffer,
    subscribeP2PFileProgress: (cb) => {
      if (typeof cb === 'function') {
        progressListeners.add(cb);
        return () => progressListeners.delete(cb);
      }
      return () => {};
    }
  });
})(window);
