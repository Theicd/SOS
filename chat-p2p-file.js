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
    console.log('[CHAT/P2P] sendFile start', peerPubkey?.slice?.(0,8), file?.name, file?.size);
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = await generateFileKey();
    const keyStr = await exportFileKey(key);
    
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
    
    // TODO: Send metadata via NIP-04 encrypted message to peer
    if (typeof App.sendP2PSignal === 'function') {
      console.log('[CHAT/P2P] send metadata', metadata);
      await App.sendP2PSignal(peerPubkey, metadata);
    }
    
    const transfer = {
      fileId,
      file,
      key,
      peerPubkey,
      direction: 'send',
      currentChunk: 0,
      totalChunks: metadata.totalChunks,
      ackReceived: 0,
      paused: false,
      startTime: Date.now()
    };
    
    activeTransfers.set(fileId, transfer);
    
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
      console.log('[CHAT/P2P] Finalizing receive', fileId);
      activeTransfers.delete(fileId);
      if (onProgress) onProgress({ fileId, progress: 1, status: 'complete' });
      notifyProgress({ fileId, progress: 1, status: 'complete', direction: 'send' });
      return;
    }
    
    const channel = dataChannels.get(peerPubkey);
    if (!channel || channel.readyState !== 'open') {
      console.warn('[CHAT/P2P] DataChannel not ready, fallback to Blossom');
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

  // חלק API ציבורי (chat-p2p-file.js) – חשיפת פונקציות להעברת קבצים | HYPER CORE TECH
  Object.assign(App, {
    sendP2PFile: sendFile,
    getOrCreateFileDataChannel: getOrCreateDataChannel,
    activeP2PTransfers: activeTransfers,
    subscribeP2PFileProgress: (cb) => {
      if (typeof cb === 'function') {
        progressListeners.add(cb);
        return () => progressListeners.delete(cb);
      }
      return () => {};
    }
  });
})(window);
