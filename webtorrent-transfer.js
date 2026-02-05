// חלק WebTorrent (webtorrent-transfer.js) – מערכת העברת קבצים גדולים P2P בין מחשבים | HYPER CORE TECH
(function initWebTorrentTransfer(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק הגדרות (webtorrent-transfer.js) – קונפיגורציה של WebTorrent | HYPER CORE TECH
  const CONFIG = {
    // רשימת trackers מעודכנת - רק openwebtorrent עובד טוב בדפדפן
    trackers: [
      'wss://tracker.openwebtorrent.com',
      'wss://tracker.webtorrent.dev'
    ],
    maxConnections: 50,
    uploadRateLimitKB: 0, // 0 = unlimited
    downloadRateLimitKB: 0
  };

  // חלק מצב (webtorrent-transfer.js) – ניהול מצב העברות | HYPER CORE TECH
  let client = null;
  const activeTransfers = new Map(); // transferId -> { torrent, type, peer, status, progress }
  const pendingRequests = new Map(); // transferId -> { magnetURI, fileName, fileSize, fromPeer }
  const progressListeners = new Set();
  
  // שמירת בקשות שטופלו ב-localStorage למניעת קפיצות חוזרות
  const PROCESSED_STORAGE_KEY = 'torrent_processed_requests';
  function getProcessedRequests() {
    try {
      const stored = localStorage.getItem(PROCESSED_STORAGE_KEY);
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  }
  function saveProcessedRequest(key) {
    try {
      const processed = getProcessedRequests();
      processed.add(key);
      // שמירה רק של 1000 הבקשות האחרונות
      const arr = Array.from(processed).slice(-1000);
      localStorage.setItem(PROCESSED_STORAGE_KEY, JSON.stringify(arr));
    } catch {}
  }
  function isRequestProcessed(key) {
    return getProcessedRequests().has(key);
  }

  // חלק אתחול (webtorrent-transfer.js) – יצירת WebTorrent client | HYPER CORE TECH
  function initClient() {
    if (client) return client;
    
    if (typeof WebTorrent === 'undefined') {
      console.error('[TORRENT] WebTorrent library not loaded');
      return null;
    }

    try {
      client = new WebTorrent({
        maxConns: CONFIG.maxConnections,
        tracker: {
          rtcConfig: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' }
            ]
          }
        }
      });

      client.on('error', (err) => {
        console.error('[TORRENT] ❌ Client error:', err);
      });

      client.on('warning', (err) => {
        console.warn('[TORRENT] ⚠️ Client warning:', err);
      });

      console.log('[TORRENT] ✅ WebTorrent client initialized, peerId:', client.peerId);
      return client;
    } catch (err) {
      console.error('[TORRENT] Failed to init client:', err);
      return null;
    }
  }

  // חלק פורמט גודל (webtorrent-transfer.js) – המרת bytes לפורמט קריא | HYPER CORE TECH
  function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // חלק פורמט זמן (webtorrent-transfer.js) – המרת שניות לפורמט קריא | HYPER CORE TECH
  function formatTime(seconds) {
    if (!seconds || seconds === Infinity) return '--:--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // חלק התקדמות (webtorrent-transfer.js) – עדכון מאזינים על התקדמות | HYPER CORE TECH
  function notifyProgress(transferId, data) {
    const payload = { transferId, ...data };
    progressListeners.forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        console.warn('[TORRENT] Progress listener error:', err);
      }
    });
  }

  // חלק שליחה (webtorrent-transfer.js) – יצירת טורנט משליחת קובץ | HYPER CORE TECH
  async function seedFile(file, peerPubkey) {
    const wt = initClient();
    if (!wt) {
      return { success: false, error: 'WebTorrent not available' };
    }

    return new Promise((resolve) => {
      const transferId = `send_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      console.log('[TORRENT] 📤 Starting to seed file:', file.name, 'size:', formatFileSize(file.size));
      console.log('[TORRENT] 🔗 Using trackers:', CONFIG.trackers);

      try {
        wt.seed(file, {
          name: file.name,
          announce: CONFIG.trackers
        }, (torrent) => {
          console.log('[TORRENT] ✅ Torrent created!');
          console.log('[TORRENT] 🧲 Magnet URI:', torrent.magnetURI);
          console.log('[TORRENT] 🔑 InfoHash:', torrent.infoHash);

          // לוגים על trackers
          torrent.on('warning', (err) => {
            console.warn('[TORRENT] ⚠️ Torrent warning:', err.message || err);
          });

          torrent.on('wire', (wire) => {
            console.log('[TORRENT] 🔌 New peer connected:', wire.peerId);
          });

          torrent.on('upload', (bytes) => {
            console.log('[TORRENT] ⬆️ Uploaded', formatFileSize(bytes), '- Total:', formatFileSize(torrent.uploaded), '- Peers:', torrent.numPeers);
          });

          // שמירת מצב העברה
          activeTransfers.set(transferId, {
            torrent,
            type: 'send',
            peer: peerPubkey,
            status: 'seeding',
            fileName: file.name,
            fileSize: file.size,
            progress: 0,
            uploadSpeed: 0,
            downloadSpeed: 0,
            peers: 0
          });

          // מעקב התקדמות
          const progressInterval = setInterval(() => {
            const transfer = activeTransfers.get(transferId);
            if (!transfer || transfer.status === 'completed' || transfer.status === 'cancelled') {
              clearInterval(progressInterval);
              return;
            }

            const uploaded = torrent.uploaded || 0;
            const progress = file.size > 0 ? Math.min(100, (uploaded / file.size) * 100) : 0;

            transfer.progress = progress;
            transfer.uploadSpeed = torrent.uploadSpeed || 0;
            transfer.peers = torrent.numPeers || 0;

            notifyProgress(transferId, {
              type: 'send',
              status: 'seeding',
              fileName: file.name,
              fileSize: file.size,
              uploaded,
              progress,
              uploadSpeed: torrent.uploadSpeed,
              peers: torrent.numPeers,
              magnetURI: torrent.magnetURI
            });

            // אם הועלה לפחות פעם אחת - סיום
            if (uploaded >= file.size) {
              transfer.status = 'completed';
              clearInterval(progressInterval);
              notifyProgress(transferId, {
                type: 'send',
                status: 'completed',
                fileName: file.name,
                fileSize: file.size
              });
            }
          }, 1000);

          torrent.on('error', (err) => {
            console.error('[TORRENT] ❌ Seed error:', err);
            const transfer = activeTransfers.get(transferId);
            if (transfer) transfer.status = 'error';
            notifyProgress(transferId, { type: 'send', status: 'error', error: err.message });
          });

          resolve({
            success: true,
            transferId,
            magnetURI: torrent.magnetURI,
            infoHash: torrent.infoHash,
            fileName: file.name,
            fileSize: file.size
          });
        });
      } catch (err) {
        console.error('[TORRENT] Seed failed:', err);
        resolve({ success: false, error: err.message });
      }
    });
  }

  // חלק בקשת העברה (webtorrent-transfer.js) – שליחת בקשת העברה לצד השני | HYPER CORE TECH
  async function requestFileTransfer(peerPubkey, file) {
    console.log('[TORRENT] 📨 requestFileTransfer called for peer:', peerPubkey?.slice(0, 8));
    
    // קודם יוצרים את הטורנט
    const seedResult = await seedFile(file, peerPubkey);
    if (!seedResult.success) {
      console.error('[TORRENT] ❌ Seed failed:', seedResult.error);
      return seedResult;
    }

    console.log('[TORRENT] ✅ Seed successful, preparing transfer request...');
    
    // הצגת בועת התקדמות בצד השולח מיד אחרי יצירת הטורנט
    showTransferProgressUI(seedResult.transferId);

    // שליחת הודעת בקשה לצד השני דרך הצ'אט
    const transferRequest = {
      type: 'torrent-transfer-request',
      transferId: seedResult.transferId,
      magnetURI: seedResult.magnetURI,
      infoHash: seedResult.infoHash,
      fileName: seedResult.fileName,
      fileSize: seedResult.fileSize,
      timestamp: Date.now()
    };

    console.log('[TORRENT] 📦 Transfer request object:', transferRequest);

    // שליחה דרך מערכת הצ'אט הקיימת
    console.log('[TORRENT] 📬 Checking messaging function availability...');
    console.log('[TORRENT] publishChatMessage exists:', typeof App.publishChatMessage === 'function');
    
    let messageSent = false;
    
    // שליחה דרך publishChatMessage (הפונקציה הנכונה במערכת)
    if (typeof App.publishChatMessage === 'function') {
      try {
        console.log('[TORRENT] 📤 Sending via publishChatMessage to peer:', peerPubkey?.slice(0, 8));
        const result = await App.publishChatMessage(peerPubkey, JSON.stringify(transferRequest));
        if (result?.ok) {
          console.log('[TORRENT] ✅ Transfer request sent successfully!');
          messageSent = true;
        } else {
          console.warn('[TORRENT] ⚠️ publishChatMessage returned error:', result?.error);
        }
      } catch (err) {
        console.warn('[TORRENT] ⚠️ publishChatMessage failed:', err);
      }
    }
    
    if (!messageSent) {
      console.error('[TORRENT] ❌ Could not send transfer request - publishChatMessage not available or failed');
    }

    return seedResult;
  }

  // חלק קבלת בקשה (webtorrent-transfer.js) – טיפול בבקשת העברה נכנסת | HYPER CORE TECH
  function handleIncomingTransferRequest(fromPeer, request) {
    console.log('[TORRENT] 📥 handleIncomingTransferRequest called');
    console.log('[TORRENT] From peer:', fromPeer?.slice(0, 8));
    
    if (!request || request.type !== 'torrent-transfer-request') {
      console.log('[TORRENT] Not a torrent request, ignoring');
      return false;
    }
    
    // בדיקה אם זה השולח עצמו - לא מציגים דיאלוג אישור לעצמו
    const myPubkey = App.chatState?.myPubkey || App.pubkey || App.publicKey || window.nostr?.getPublicKey?.() || '';
    if (fromPeer && myPubkey && fromPeer.toLowerCase() === myPubkey.toLowerCase()) {
      console.log('[TORRENT] ⏭️ Skipping - this is my own transfer request');
      return false;
    }

    // אם כבר קיימת העברת שליחה עם אותו transferId (השולח), אין צורך ליצור הורדה בצד הזה
    if (request.transferId && activeTransfers.has(request.transferId)) {
      const transfer = activeTransfers.get(request.transferId);
      if (transfer?.type === 'send') {
        console.log('[TORRENT] ⏭️ Ignoring mirrored download bubble for outgoing transfer:', request.transferId);
        return true;
      }
    }

    // בדיקת כפילויות - אם כבר טיפלנו בבקשה הזו, לא מתחילים הורדה חדשה
    // אבל ההודעה עדיין תוצג ב-renderMessages כי היא נשמרת בהיסטוריית ההודעות
    const requestKey = `${request.infoHash}_${fromPeer}`;
    const alreadyProcessed = isRequestProcessed(requestKey);
    
    if (alreadyProcessed) {
      console.log('[TORRENT] ⏭️ Request already processed, skipping download (message will still show in chat):', request.infoHash?.slice(0, 12));
      return true; // מחזירים true כי ההודעה תקינה, רק לא מתחילים הורדה חדשה
    }
    
    // סימון הבקשה כמטופלת ושמירה ב-localStorage
    saveProcessedRequest(requestKey);
    console.log('[TORRENT] ✅ New transfer request received!');
    console.log('[TORRENT] 📁 File:', request.fileName, '- Size:', formatFileSize(request.fileSize));
    console.log('[TORRENT] 🧲 Magnet:', request.magnetURI?.slice(0, 60) + '...');

    const transferId = `recv_${request.infoHash}_${Date.now()}`;
    
    pendingRequests.set(transferId, {
      magnetURI: request.magnetURI,
      infoHash: request.infoHash,
      fileName: request.fileName,
      fileSize: request.fileSize,
      fromPeer,
      timestamp: request.timestamp,
      originalTransferId: request.transferId
    });

    // הודעה ל-UI על התחלת הורדה אוטומטית (כמו וואטסאפ)
    notifyProgress(transferId, {
      type: 'receive',
      status: 'downloading',
      fileName: request.fileName,
      fileSize: request.fileSize,
      fromPeer,
      needsApproval: false
    });

    // התחלת הורדה אוטומטית ללא אישור (כמו וואטסאפ)
    console.log('[TORRENT] 🚀 Starting automatic download (WhatsApp style)...');
    
    const chatPanel = document.getElementById('chatPanel');
    
    // פתיחת השיחה ורענון ההודעות
    if (chatPanel && !chatPanel.classList.contains('chat-panel--open')) {
      chatPanel.classList.add('chat-panel--open');
    }
    
    // פותחים את השיחה כדי להציג את ההודעה
    if (fromPeer && typeof App.showChatConversation === 'function') {
      App.showChatConversation(fromPeer);
      console.log('[TORRENT] 💬 Opened conversation with sender:', fromPeer?.slice(0, 8));
    }
    
    // התחלת הורדה אוטומטית אחרי שהשיחה נפתחה
    setTimeout(() => {
      console.log('[TORRENT] 🔄 Starting download for transfer:', transferId);
      approveTransfer(transferId);
      // הצגת בועת התקדמות
      setTimeout(() => {
        showTransferProgressUI(transferId);
      }, 200);
    }, 800);
    
    return true;
  }
  
  // חלק הודעת צ'אט (webtorrent-transfer.js) – הזרקת בועת הודעה לאישור העברה | HYPER CORE TECH
  function injectTransferRequestMessage(transferId, fileName, fileSize, fromPeer) {
    // מציאת קונטיינר ההודעות - נסיון מספר סלקטורים
    const chatList = document.getElementById('chatMessages') || 
                     document.querySelector('.chat-conversation__messages') || 
                     document.querySelector('.chat-conversation__list') || 
                     document.getElementById('chatConversationList');
    
    console.log('[TORRENT] 🔍 Looking for chat container...');
    console.log('[TORRENT] chatMessages:', document.getElementById('chatMessages'));
    console.log('[TORRENT] chatList found:', chatList);
    
    // תמיד מציגים דיאלוג צף כגיבוי אמין
    if (!chatList) {
      console.warn('[TORRENT] ⚠️ Chat list not found, showing floating dialog');
      showTransferApprovalDialog(transferId, fileName, fileSize, fromPeer);
      return;
    }
    
    // יצירת אלמנט הודעה
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-message chat-message--incoming chat-message--torrent-request';
    msgDiv.dataset.transferId = transferId;
    
    msgDiv.innerHTML = `
      <div class="chat-message__content" style="background: linear-gradient(145deg, #1e2a38, #151d27); border: 1px solid rgba(37, 211, 102, 0.3); max-width: 300px;">
        <div class="chat-message__torrent-header" style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px;">
          <i class="fa-solid fa-cloud-arrow-down" style="color: #25D366;"></i>
          <span style="font-weight: bold; color: #fff;">בקשת העברת קובץ</span>
        </div>
        
        <div class="chat-message__torrent-info" style="margin-bottom: 12px;">
          <div style="color: #fff; font-weight: 500; margin-bottom: 4px; word-break: break-all;">${fileName}</div>
          <div style="color: #b0b8c1; font-size: 12px;">${formatFileSize(fileSize)} • P2P</div>
        </div>
        
        <div class="chat-message__torrent-actions" style="display: flex; gap: 8px;">
          <button type="button" class="btn-approve" style="flex: 1; background: #25D366; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 13px;">
            <i class="fa-solid fa-download"></i> הורד
          </button>
          <button type="button" class="btn-reject" style="flex: 1; background: rgba(255,255,255,0.1); color: #fff; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 13px;">
            דחה
          </button>
        </div>
        
        <div class="chat-message__time" style="margin-top: 6px; text-align: right; font-size: 11px; color: rgba(255,255,255,0.5);">
          ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    `;
    
    // הוספה לצ'אט
    chatList.appendChild(msgDiv);
    chatList.scrollTop = chatList.scrollHeight;
    
    // אירועים
    const approveBtn = msgDiv.querySelector('.btn-approve');
    const rejectBtn = msgDiv.querySelector('.btn-reject');
    
    approveBtn.addEventListener('click', () => {
      msgDiv.style.opacity = '0.5';
      msgDiv.style.pointerEvents = 'none';
      approveTransfer(transferId);
      // מחיקת ההודעה אחרי אישור כדי למנוע לחיצות כפולות או החלפתה בסטטוס
      msgDiv.querySelector('.chat-message__torrent-actions').innerHTML = '<div style="color: #25D366; text-align: center;"><i class="fa-solid fa-check"></i> ההורדה החלה</div>';
      showTransferProgressUI(transferId);
    });
    
    rejectBtn.addEventListener('click', () => {
      msgDiv.style.opacity = '0.5';
      rejectTransfer(transferId);
      msgDiv.remove();
    });
    
    console.log('[TORRENT] 💬 Chat message injected successfully');
  }

  // חלק אישור (webtorrent-transfer.js) – אישור והתחלת הורדה | HYPER CORE TECH
  function approveTransfer(transferId) {
    console.log('[TORRENT] 👍 approveTransfer called for:', transferId);
    
    const pending = pendingRequests.get(transferId);
    if (!pending) {
      console.warn('[TORRENT] ❌ Transfer not found:', transferId);
      return false;
    }

    console.log('[TORRENT] 📋 Pending transfer details:');
    console.log('[TORRENT]   - File:', pending.fileName);
    console.log('[TORRENT]   - Size:', formatFileSize(pending.fileSize));
    console.log('[TORRENT]   - From:', pending.fromPeer?.slice(0, 8));
    console.log('[TORRENT]   - Magnet:', pending.magnetURI?.slice(0, 60) + '...');

    const wt = initClient();
    if (!wt) {
      console.error('[TORRENT] ❌ WebTorrent client not available');
      notifyProgress(transferId, { type: 'receive', status: 'error', error: 'WebTorrent not available' });
      return false;
    }

    console.log('[TORRENT] 🔗 Adding torrent with trackers:', CONFIG.trackers);

    try {
      wt.add(pending.magnetURI, {
        announce: CONFIG.trackers
      }, (torrent) => {
        console.log('[TORRENT] ✅ Torrent added successfully!');
        console.log('[TORRENT] 📥 Starting download:', pending.fileName);
        console.log('[TORRENT] 🔑 InfoHash:', torrent.infoHash);

        // לוגים על trackers וחיבורים
        torrent.on('warning', (err) => {
          console.warn('[TORRENT] ⚠️ Download warning:', err.message || err);
        });

        torrent.on('wire', (wire) => {
          console.log('[TORRENT] 🔌 Connected to peer:', wire.peerId);
        });

        activeTransfers.set(transferId, {
          torrent,
          type: 'receive',
          peer: pending.fromPeer,
          status: 'downloading',
          fileName: pending.fileName,
          fileSize: pending.fileSize,
          progress: 0,
          downloadSpeed: 0,
          peers: 0
        });

        pendingRequests.delete(transferId);

        // מעקב התקדמות
        torrent.on('download', (bytes) => {
          const progress = Math.round(torrent.progress * 100);
          const transfer = activeTransfers.get(transferId);
          if (transfer) {
            transfer.progress = progress;
            transfer.downloadSpeed = torrent.downloadSpeed;
            transfer.peers = torrent.numPeers;
          }

          console.log('[TORRENT] ⬇️ Downloaded', formatFileSize(bytes), '- Progress:', progress + '%', '- Peers:', torrent.numPeers);

          notifyProgress(transferId, {
            type: 'receive',
            status: 'downloading',
            fileName: pending.fileName,
            fileSize: pending.fileSize,
            downloaded: torrent.downloaded,
            progress,
            downloadSpeed: torrent.downloadSpeed,
            timeRemaining: torrent.timeRemaining,
            peers: torrent.numPeers
          });
        });

        torrent.on('done', () => {
          console.log('[TORRENT] 🎉 Download complete:', pending.fileName);
          const transfer = activeTransfers.get(transferId);
          if (transfer) transfer.status = 'completed';

          notifyProgress(transferId, {
            type: 'receive',
            status: 'completed',
            fileName: pending.fileName,
            fileSize: pending.fileSize
          });

          // שמירת הקובץ
          torrent.files.forEach((file) => {
            file.getBlobURL((err, url) => {
              if (err) {
                console.error('[TORRENT] Failed to get blob URL:', err);
                return;
              }
              downloadFile(url, file.name);
            });
          });
        });

        torrent.on('error', (err) => {
          console.error('[TORRENT] Download error:', err);
          const transfer = activeTransfers.get(transferId);
          if (transfer) transfer.status = 'error';
          notifyProgress(transferId, { type: 'receive', status: 'error', error: err.message });
        });
      });

      return true;
    } catch (err) {
      console.error('[TORRENT] Add torrent failed:', err);
      notifyProgress(transferId, { type: 'receive', status: 'error', error: err.message });
      return false;
    }
  }

  // חלק דחייה (webtorrent-transfer.js) – דחיית בקשת העברה | HYPER CORE TECH
  function rejectTransfer(transferId) {
    const pending = pendingRequests.get(transferId);
    if (pending) {
      pendingRequests.delete(transferId);
      notifyProgress(transferId, {
        type: 'receive',
        status: 'rejected',
        fileName: pending.fileName
      });
    }
    return true;
  }

  // חלק ביטול (webtorrent-transfer.js) – ביטול העברה פעילה | HYPER CORE TECH
  function cancelTransfer(transferId) {
    const transfer = activeTransfers.get(transferId);
    if (!transfer) return false;

    try {
      if (transfer.torrent) {
        transfer.torrent.destroy();
      }
      transfer.status = 'cancelled';
      activeTransfers.delete(transferId);

      notifyProgress(transferId, {
        type: transfer.type,
        status: 'cancelled',
        fileName: transfer.fileName
      });

      return true;
    } catch (err) {
      console.error('[TORRENT] Cancel failed:', err);
      return false;
    }
  }

  // חלק הורדה (webtorrent-transfer.js) – שמירת קובץ למחשב | HYPER CORE TECH
  function downloadFile(url, fileName) {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // חלק דיאלוג אישור (webtorrent-transfer.js) – הצגת חלון אישור להעברה נכנסת | HYPER CORE TECH
  function showTransferApprovalDialog(transferId, fileName, fileSize, fromPeer) {
    console.log('[TORRENT] 🔔 showTransferApprovalDialog called!');
    console.log('[TORRENT]   - transferId:', transferId);
    console.log('[TORRENT]   - fileName:', fileName);
    console.log('[TORRENT]   - fileSize:', formatFileSize(fileSize));
    console.log('[TORRENT]   - fromPeer:', fromPeer?.slice(0, 8));
    
    // הסרת דיאלוג קיים
    const existing = document.getElementById('torrentApprovalDialog');
    if (existing) existing.remove();

    // קבלת שם השולח
    let senderName = 'משתמש';
    if (App.chatState?.contacts) {
      const contact = App.chatState.contacts.get(fromPeer?.toLowerCase());
      if (contact?.name) senderName = contact.name;
    }

    const dialog = document.createElement('div');
    dialog.id = 'torrentApprovalDialog';
    dialog.className = 'torrent-dialog torrent-dialog--approval';
    dialog.innerHTML = `
      <div class="torrent-dialog__backdrop"></div>
      <div class="torrent-dialog__content">
        <div class="torrent-dialog__header">
          <i class="fa-solid fa-download"></i>
          <h3>בקשת העברת קובץ</h3>
        </div>
        <div class="torrent-dialog__body">
          <p class="torrent-dialog__sender"><strong>${senderName}</strong> רוצה לשלוח לך קובץ:</p>
          <div class="torrent-dialog__file-info">
            <i class="fa-solid fa-file"></i>
            <div>
              <div class="torrent-dialog__file-name">${fileName}</div>
              <div class="torrent-dialog__file-size">${formatFileSize(fileSize)}</div>
            </div>
          </div>
          <p class="torrent-dialog__warning">
            <i class="fa-solid fa-shield-halved"></i>
            הקובץ יועבר ישירות ממחשב למחשב (P2P) ללא שרת ביניים
          </p>
        </div>
        <div class="torrent-dialog__actions">
          <button type="button" class="torrent-dialog__btn torrent-dialog__btn--reject" data-action="reject">
            <i class="fa-solid fa-xmark"></i> דחה
          </button>
          <button type="button" class="torrent-dialog__btn torrent-dialog__btn--approve" data-action="approve">
            <i class="fa-solid fa-check"></i> אשר והורד
          </button>
        </div>
      </div>
    `;

    // פתיחת השיחה עם השולח והוספת הדיאלוג לתוכה
    const chatPanel = document.getElementById('chatPanel');
    
    // פתיחת הצ'אט אם סגור
    if (chatPanel && !chatPanel.classList.contains('chat-panel--open')) {
      chatPanel.classList.add('chat-panel--open');
    }
    
    // פתיחת השיחה עם השולח
    if (fromPeer && typeof App.showChatConversation === 'function') {
      App.showChatConversation(fromPeer);
      console.log('[TORRENT] 💬 Opened conversation with sender:', fromPeer?.slice(0, 8));
    }
    
    // המתנה קצרה לפתיחת השיחה ואז הוספת הדיאלוג
    setTimeout(() => {
      const panel = document.getElementById('chatPanel');
      if (panel) {
        panel.appendChild(dialog);
        console.log('[TORRENT] 📌 Dialog appended to chatPanel');
      } else {
        document.body.appendChild(dialog);
        console.log('[TORRENT] 📌 Dialog appended to body (chatPanel not found)');
      }
    }, 100);
    console.log('[TORRENT] Dialog element:', document.getElementById('torrentApprovalDialog'));
    
    // מניעת סגירת הצ'אט בלחיצה על הדיאלוג
    dialog.addEventListener('click', (e) => e.stopPropagation());

    // אירועים
    const approveBtn = dialog.querySelector('[data-action="approve"]');
    const rejectBtn = dialog.querySelector('[data-action="reject"]');
    const backdrop = dialog.querySelector('.torrent-dialog__backdrop');

    approveBtn?.addEventListener('click', () => {
      dialog.remove();
      approveTransfer(transferId);
      showTransferProgressUI(transferId);
    });

    rejectBtn?.addEventListener('click', () => {
      dialog.remove();
      rejectTransfer(transferId);
    });

    backdrop?.addEventListener('click', () => {
      dialog.remove();
      rejectTransfer(transferId);
    });
  }

  // חלק UI התקדמות (webtorrent-transfer.js) – הצגת בועת הודעה עם התקדמות בשיחה (כמו וואטסאפ) | HYPER CORE TECH
  function showTransferProgressUI(transferId) {
    const transfer = activeTransfers.get(transferId);
    if (!transfer) {
      console.warn('[TORRENT] ⚠️ Transfer not found for UI:', transferId);
      return;
    }

    console.log('[TORRENT] 🎨 showTransferProgressUI called for:', transferId, 'type:', transfer.type);

    // מציאת קונטיינר ההודעות בשיחה
    const messagesContainer = document.getElementById('chatMessages') || 
                              document.querySelector('.chat-conversation__messages') || 
                              document.querySelector('.chat-conversation__list') || 
                              document.getElementById('chatConversationList');
    
    if (!messagesContainer) {
      console.warn('[TORRENT] ⚠️ Messages container not found, will retry...');
      // ניסיון נוסף אחרי השהייה
      setTimeout(() => showTransferProgressUI(transferId), 500);
      return;
    }

    // האם זו העלאה (שליחה) או הורדה (קבלה)
    const isOutgoing = transfer.type === 'send';
    const directionClass = isOutgoing ? 'chat-message--outgoing' : 'chat-message--incoming';
    const actionIcon = isOutgoing ? 'fa-cloud-arrow-up' : 'fa-cloud-arrow-down';
    const actionText = isOutgoing ? 'מעלה...' : 'מוריד...';
    
    // זיהוי סוג קובץ לאייקון מתאים
    const fileName = transfer.fileName || 'קובץ';
    const fileExt = fileName.split('.').pop()?.toLowerCase() || '';
    let fileIcon = 'fa-file';
    if (['mp4', 'webm', 'avi', 'mov', 'mkv'].includes(fileExt)) fileIcon = 'fa-file-video';
    else if (['mp3', 'm4a', 'wav', 'ogg', 'flac'].includes(fileExt)) fileIcon = 'fa-file-audio';
    else if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(fileExt)) fileIcon = 'fa-file-image';
    else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(fileExt)) fileIcon = 'fa-file-zipper';
    else if (['pdf'].includes(fileExt)) fileIcon = 'fa-file-pdf';

    // בודקים אם כבר קיימת בועה רלוונטית (למשל מהודעת הצ'אט עצמה)
    let bubble = messagesContainer.querySelector(`[data-torrent-transfer="${transferId}"]`);
    let createdBubble = false;

    const ensureProgressSection = (container) => {
      if (!container.querySelector('.torrent-bubble__progress')) {
        const progress = document.createElement('div');
        progress.className = 'torrent-bubble__progress';
        progress.innerHTML = `
          <div class="torrent-bubble__bar">
            <div class="torrent-bubble__bar-inner" style="width: 0%"></div>
          </div>
          <div class="torrent-bubble__stats">
            <span class="torrent-bubble__percent">0%</span>
            <span class="torrent-bubble__speed">ממתין לחיבור...</span>
          </div>
        `;
        container.appendChild(progress);
      }
    };

    if (bubble) {
      console.log('[TORRENT] 🧷 Attaching progress to existing message bubble:', transferId);
      if (!bubble.classList.contains('chat-message')) {
        bubble = bubble.closest('.chat-message') || bubble;
      }
      bubble.classList.add('chat-message--torrent-transfer', directionClass, 'chat-message--torrent-active');
      bubble.classList.remove('chat-message--torrent-completed', 'chat-message--torrent-error');
      const torrentBubble = bubble.querySelector('.torrent-bubble');
      if (torrentBubble) {
        torrentBubble.querySelector('.torrent-bubble__header i')?.classList?.remove('fa-cloud-arrow-up', 'fa-cloud-arrow-down');
        torrentBubble.querySelector('.torrent-bubble__header i')?.classList?.add(actionIcon);
        const actionSpanEl = torrentBubble.querySelector('.torrent-bubble__action');
        if (actionSpanEl) actionSpanEl.textContent = actionText;
        const fileIconEl = torrentBubble.querySelector('.torrent-bubble__file > i');
        if (fileIconEl) fileIconEl.className = `fa-solid ${fileIcon}`;
        ensureProgressSection(torrentBubble);
        if (isOutgoing && !torrentBubble.querySelector('.torrent-bubble__cancel')) {
          const cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'torrent-bubble__cancel';
          cancelBtn.title = 'בטל';
          cancelBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
          cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            cancelTransfer(transferId);
            bubble.remove();
          });
          torrentBubble.appendChild(cancelBtn);
        }
      }
    } else {
      // אין הודעה קיימת – יוצרים אחת עצמאית (מצב השולח)
      bubble = document.createElement('div');
      createdBubble = true;
      bubble.className = `chat-message ${directionClass} chat-message--torrent-transfer chat-message--torrent-active`;
      bubble.innerHTML = `
        <div class="chat-message__content chat-message__content--torrent">
          <div class="torrent-bubble">
            <div class="torrent-bubble__header">
              <i class="fa-solid ${actionIcon}"></i>
              <span class="torrent-bubble__action">${actionText}</span>
            </div>
            <div class="torrent-bubble__file">
              <i class="fa-solid ${fileIcon}"></i>
              <div class="torrent-bubble__file-info">
                <span class="torrent-bubble__file-name">${fileName}</span>
                <span class="torrent-bubble__file-size">${formatFileSize(transfer.fileSize || 0)}</span>
              </div>
            </div>
            <div class="torrent-bubble__progress">
              <div class="torrent-bubble__bar">
                <div class="torrent-bubble__bar-inner" style="width: 0%"></div>
              </div>
              <div class="torrent-bubble__stats">
                <span class="torrent-bubble__percent">0%</span>
                <span class="torrent-bubble__speed">ממתין לחיבור...</span>
              </div>
            </div>
            ${isOutgoing ? '<button type="button" class="torrent-bubble__cancel" title="בטל"><i class="fa-solid fa-xmark"></i></button>' : ''}
          </div>
          <div class="chat-message__time">${new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
      `;

      messagesContainer.appendChild(bubble);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      console.log('[TORRENT] ✅ Transfer bubble created:', transferId, 'isOutgoing:', isOutgoing);

      if (isOutgoing) {
        bubble.querySelector('.torrent-bubble__cancel')?.addEventListener('click', (e) => {
          e.stopPropagation();
          cancelTransfer(transferId);
          bubble.remove();
        });
      }
    }

    // עדכון התקדמות בבועה
    const updateBubble = (data) => {
      if (data.transferId !== transferId) return;
      
      // בדיקה שהבועה עדיין קיימת ב-DOM
      if (!document.body.contains(bubble)) {
        progressListeners.delete(updateBubble);
        console.log('[TORRENT] ♻️ Bubble removed during rerender, recreating:', transferId);
        // מייצרים מחדש את הבועה וממשיכים לקבל עדכונים
        setTimeout(() => showTransferProgressUI(transferId), 50);
        return;
      }

      const barInner = bubble.querySelector('.torrent-bubble__bar-inner');
      const percent = bubble.querySelector('.torrent-bubble__percent');
      const speed = bubble.querySelector('.torrent-bubble__speed');
      const actionSpan = bubble.querySelector('.torrent-bubble__action');

      // עדכון אחוזים ופס התקדמות
      const progressVal = data.progress || 0;
      if (barInner) barInner.style.width = `${progressVal}%`;
      if (percent) percent.textContent = `${Math.round(progressVal)}%`;
      
      // עדכון מהירות
      if (speed) {
        const speedVal = data.type === 'send' ? data.uploadSpeed : data.downloadSpeed;
        if (speedVal && speedVal > 0) {
          speed.textContent = `${formatFileSize(speedVal)}/s`;
          speed.style.color = '';
          speed.style.fontStyle = '';
          // הסרת מצב "ממתין" כשיש התקדמות
          bubble.classList.remove('chat-message--torrent-active');
        } else if (data.peers > 0) {
          speed.textContent = `${data.peers} עמיתים`;
        }
      }
      
      // עדכון טקסט הפעולה
      if (actionSpan) {
        if (data.status === 'downloading') {
          actionSpan.textContent = 'מוריד...';
        } else if (data.status === 'seeding' || data.status === 'uploading') {
          actionSpan.textContent = 'מעלה...';
        }
      }

      // סיום מוצלח
      if (data.status === 'completed') {
        bubble.classList.remove('chat-message--torrent-active');
        bubble.classList.add('chat-message--torrent-completed');
        if (actionSpan) actionSpan.textContent = isOutgoing ? 'נשלח ✓' : 'הושלם ✓';
        
        // הסתרת פס ההתקדמות וכפתור הביטול
        const progressDiv = bubble.querySelector('.torrent-bubble__progress');
        const cancelBtn = bubble.querySelector('.torrent-bubble__cancel');
        if (progressDiv) progressDiv.style.display = 'none';
        if (cancelBtn) cancelBtn.style.display = 'none';

        // הוספת כפתור שמירה אם זו הורדה
        if (!isOutgoing) {
          const fileDiv = bubble.querySelector('.torrent-bubble__file');
          const existingBtn = fileDiv?.querySelector('.torrent-bubble__download-btn');
          if (fileDiv && !existingBtn) {
            const magnetURI = transfer.magnetURI || activeTransfers.get(transferId)?.torrent?.magnetURI || '';
            if (magnetURI) {
              const downloadBtn = document.createElement('button');
              downloadBtn.type = 'button';
              downloadBtn.className = 'torrent-bubble__download-btn';
              downloadBtn.setAttribute('data-magnet', magnetURI);
              downloadBtn.setAttribute('data-filename', transfer.fileName || 'file');
              downloadBtn.innerHTML = '<i class="fa-solid fa-download"></i> שמור';
              fileDiv.appendChild(downloadBtn);
            }
          }
        }

        // הסרת הליסנר אחרי השלמה
        progressListeners.delete(updateBubble);
      }

      // שגיאה
      if (data.status === 'error') {
        bubble.classList.remove('chat-message--torrent-active');
        bubble.classList.add('chat-message--torrent-error');
        if (actionSpan) actionSpan.textContent = 'שגיאה ❌';
        if (speed) speed.textContent = data.error || 'שגיאה בהעברה';
        progressListeners.delete(updateBubble);
      }
    };

    progressListeners.add(updateBubble);
    console.log('[TORRENT] 📊 Progress listener added for:', transferId);
  }

  // חלק UI שליחה (webtorrent-transfer.js) – דיאלוג בחירת קובץ לשליחה | HYPER CORE TECH
  function showSendFileDialog(peerPubkey) {
    const existing = document.getElementById('torrentSendDialog');
    if (existing) existing.remove();

    // קבלת שם הנמען
    let recipientName = 'המשתמש';
    if (App.chatState?.contacts) {
      const contact = App.chatState.contacts.get(peerPubkey?.toLowerCase());
      if (contact?.name) recipientName = contact.name;
    }

    const dialog = document.createElement('div');
    dialog.id = 'torrentSendDialog';
    dialog.className = 'torrent-dialog torrent-dialog--send';
    dialog.innerHTML = `
      <div class="torrent-dialog__backdrop"></div>
      <div class="torrent-dialog__content">
        <div class="torrent-dialog__header">
          <i class="fa-solid fa-upload"></i>
          <h3>שליחת קובץ גדול</h3>
        </div>
        <div class="torrent-dialog__body">
          <p>שלח קובץ ישירות אל <strong>${recipientName}</strong></p>
          <div class="torrent-dialog__dropzone" id="torrentDropzone">
            <i class="fa-solid fa-cloud-arrow-up"></i>
            <p>גרור קובץ לכאן או לחץ לבחירה</p>
            <p class="torrent-dialog__dropzone-hint">תומך בקבצים בכל גודל (עד 100GB+)</p>
            <input type="file" id="torrentFileInput" hidden>
          </div>
          <div class="torrent-dialog__selected-file" id="torrentSelectedFile" hidden>
            <i class="fa-solid fa-file"></i>
            <div class="torrent-dialog__selected-info">
              <span class="torrent-dialog__selected-name"></span>
              <span class="torrent-dialog__selected-size"></span>
            </div>
            <button type="button" class="torrent-dialog__selected-remove">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
        </div>
        <div class="torrent-dialog__actions">
          <button type="button" class="torrent-dialog__btn torrent-dialog__btn--cancel" data-action="cancel">
            ביטול
          </button>
          <button type="button" class="torrent-dialog__btn torrent-dialog__btn--send" data-action="send" disabled>
            <i class="fa-solid fa-paper-plane"></i> שלח
          </button>
        </div>
      </div>
    `;

    // הוספה לתוך chatPanel כדי לשמור על הצ'אט פתוח
    const chatPanel = document.getElementById('chatPanel');
    if (chatPanel) {
      chatPanel.appendChild(dialog);
    } else {
      document.body.appendChild(dialog);
    }
    
    // מניעת סגירת הצ'אט בלחיצה על הדיאלוג
    dialog.addEventListener('click', (e) => e.stopPropagation());

    const dropzone = dialog.querySelector('#torrentDropzone');
    const fileInput = dialog.querySelector('#torrentFileInput');
    const selectedFileDiv = dialog.querySelector('#torrentSelectedFile');
    const sendBtn = dialog.querySelector('[data-action="send"]');
    const cancelBtn = dialog.querySelector('[data-action="cancel"]');
    const backdrop = dialog.querySelector('.torrent-dialog__backdrop');
    const removeBtn = dialog.querySelector('.torrent-dialog__selected-remove');

    let selectedFile = null;

    // בחירת קובץ
    dropzone?.addEventListener('click', () => fileInput?.click());
    
    fileInput?.addEventListener('change', (e) => {
      if (e.target.files?.[0]) {
        selectFile(e.target.files[0]);
      }
    });

    // גרירה
    dropzone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('torrent-dialog__dropzone--dragover');
    });

    dropzone?.addEventListener('dragleave', () => {
      dropzone.classList.remove('torrent-dialog__dropzone--dragover');
    });

    dropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('torrent-dialog__dropzone--dragover');
      if (e.dataTransfer?.files?.[0]) {
        selectFile(e.dataTransfer.files[0]);
      }
    });

    function selectFile(file) {
      selectedFile = file;
      dropzone.hidden = true;
      selectedFileDiv.hidden = false;
      selectedFileDiv.querySelector('.torrent-dialog__selected-name').textContent = file.name;
      selectedFileDiv.querySelector('.torrent-dialog__selected-size').textContent = formatFileSize(file.size);
      sendBtn.disabled = false;
    }

    removeBtn?.addEventListener('click', () => {
      selectedFile = null;
      dropzone.hidden = false;
      selectedFileDiv.hidden = true;
      sendBtn.disabled = true;
      fileInput.value = '';
    });

    // שליחה
    sendBtn?.addEventListener('click', async () => {
      if (!selectedFile) return;
      
      dialog.remove();
      
      const result = await requestFileTransfer(peerPubkey, selectedFile);
      if (result.success) {
        showTransferProgressUI(result.transferId);
      } else {
        alert('שגיאה בשליחת הקובץ: ' + (result.error || 'Unknown error'));
      }
    });

    // ביטול
    cancelBtn?.addEventListener('click', () => dialog.remove());
    backdrop?.addEventListener('click', () => dialog.remove());
  }

  // חלק הרשמה (webtorrent-transfer.js) – הרשמה לעדכוני התקדמות | HYPER CORE TECH
  function subscribeProgress(callback) {
    progressListeners.add(callback);
    return () => progressListeners.delete(callback);
  }

  // חלק מצב (webtorrent-transfer.js) – קבלת מצב העברות | HYPER CORE TECH
  function getActiveTransfers() {
    return Array.from(activeTransfers.entries()).map(([id, t]) => ({
      transferId: id,
      type: t.type,
      status: t.status,
      fileName: t.fileName,
      fileSize: t.fileSize,
      progress: t.progress,
      peer: t.peer
    }));
  }

  function getPendingRequests() {
    return Array.from(pendingRequests.entries()).map(([id, r]) => ({
      transferId: id,
      fileName: r.fileName,
      fileSize: r.fileSize,
      fromPeer: r.fromPeer
    }));
  }

  // חלק ניקוי (webtorrent-transfer.js) – ניקוי משאבים | HYPER CORE TECH
  function cleanup() {
    activeTransfers.forEach((transfer) => {
      if (transfer.torrent) {
        try {
          transfer.torrent.destroy();
        } catch {}
      }
    });
    activeTransfers.clear();
    pendingRequests.clear();
    
    if (client) {
      try {
        client.destroy();
      } catch {}
      client = null;
    }
  }

  // חלק זיהוי הודעות (webtorrent-transfer.js) – זיהוי הודעות העברה בצ'אט | HYPER CORE TECH
  function parseTransferMessage(content, fromPeer) {
    try {
      const data = JSON.parse(content);
      if (data?.type === 'torrent-transfer-request') {
        return handleIncomingTransferRequest(fromPeer, data);
      }
    } catch {
      // Not a transfer message
    }
    return false;
  }

  // חלק הורדת קובץ מטורנט (webtorrent-transfer.js) – הורדת קובץ מ-magnet URI | HYPER CORE TECH
  function downloadTorrentFile(magnetURI, fileName) {
    if (!magnetURI) {
      console.error('[TORRENT] No magnet URI provided');
      return;
    }
    
    initClient();
    if (!client) {
      console.error('[TORRENT] Failed to init WebTorrent client');
      return;
    }
    
    console.log('[TORRENT] 📥 Starting download from magnet:', magnetURI.slice(0, 60) + '...');
    
    const transferId = 'download_' + Date.now();
    
    // הוספת הטורנט
    client.add(magnetURI, { 
      announce: CONFIG.trackers,
      maxWebConns: CONFIG.maxConnections
    }, (torrent) => {
      console.log('[TORRENT] ✅ Torrent added, files:', torrent.files.length);
      
      activeTransfers.set(transferId, {
        torrent,
        type: 'receive',
        fileName: fileName || torrent.files[0]?.name || 'file',
        fileSize: torrent.length,
        status: 'downloading'
      });
      
      // הצגת התקדמות בבועת הודעה
      showTransferProgressUI(transferId);
      
      // עדכון התקדמות
      torrent.on('download', () => {
        const progress = Math.round(torrent.progress * 100);
        notifyProgress(transferId, {
          type: 'receive',
          status: 'downloading',
          progress,
          downloadSpeed: torrent.downloadSpeed,
          peers: torrent.numPeers,
          timeRemaining: torrent.timeRemaining,
          downloaded: torrent.downloaded,
          total: torrent.length
        });
      });
      
      // סיום הורדה
      torrent.on('done', () => {
        console.log('[TORRENT] ✅ Download complete!');
        
        // שמירת הקובץ
        const file = torrent.files[0];
        if (file) {
          file.getBlobURL((err, url) => {
            if (err) {
              console.error('[TORRENT] Failed to get blob URL:', err);
              return;
            }
            
            // יצירת לינק להורדה
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName || file.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            
            // ניקוי URL
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          });
        }
        
        notifyProgress(transferId, {
          type: 'receive',
          status: 'completed',
          progress: 100
        });
        
        // ניקוי
        setTimeout(() => {
          activeTransfers.delete(transferId);
          torrent.destroy();
        }, 5000);
      });
      
      torrent.on('error', (err) => {
        console.error('[TORRENT] Download error:', err);
        notifyProgress(transferId, {
          type: 'receive',
          status: 'error',
          error: err.message
        });
      });
    });
  }
  
  // חשיפה גלובלית לשימוש מ-chat-ui.js
  App.downloadTorrentFile = downloadTorrentFile;

  // חלק ייצוא (webtorrent-transfer.js) – ייצוא API | HYPER CORE TECH
  App.torrentTransfer = {
    init: initClient,
    sendFile: showSendFileDialog,
    requestTransfer: requestFileTransfer,
    approveTransfer,
    rejectTransfer,
    cancelTransfer,
    subscribeProgress,
    getActiveTransfers,
    getPendingRequests,
    parseTransferMessage,
    handleIncomingRequest: handleIncomingTransferRequest,
    cleanup,
    formatFileSize,
    formatTime
  };

  // אתחול בטעינת הדף
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initClient);
  } else {
    initClient();
  }

  console.log('[TORRENT] WebTorrent transfer module loaded');
})(window);
