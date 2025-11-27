(function initP2PVideoSharing(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  function getP2PRelays() {
    if (Array.isArray(App.p2pRelayUrls) && App.p2pRelayUrls.length) {
      return App.p2pRelayUrls;
    }
    if (Array.isArray(App.relayUrls) && App.relayUrls.length) {
      return App.relayUrls;
    }
    return [];
  }

  // חלק P2P (p2p-video-sharing.js) – הגדרות
  const FILE_AVAILABILITY_KIND = 25070; // kind לפרסום זמינות קבצים
  const FILE_REQUEST_KIND = 25071; // kind לבקשת קובץ
  const FILE_RESPONSE_KIND = 25072; // kind לתשובה על בקשה
  const AVAILABILITY_EXPIRY = 60 * 60 * 1000; // שעה
  const AVAILABILITY_REPUBLISH_INTERVAL = 2 * 60 * 1000; // דקהיים קירור
  const PEER_DISCOVERY_TIMEOUT = window.NostrP2P_PEER_DISCOVERY_TIMEOUT || 15000;
  const PEER_DISCOVERY_LOOKBACK = 3 * 60 * 60; // שלוש שעות אחורה
  const CHUNK_SIZE = 16384; // 16KB chunks
  const MAX_DOWNLOAD_TIMEOUT = 30000; // 30 שניות
  const ANSWER_TIMEOUT = window.NostrP2P_ANSWER_TIMEOUT || 20000;

  // חלק P2P (p2p-video-sharing.js) – WebRTC config
  const RTC_CONFIG = Array.isArray(window.NostrRTC_ICE) && window.NostrRTC_ICE.length
    ? { iceServers: window.NostrRTC_ICE }
    : {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      };

  // חלק P2P (p2p-video-sharing.js) – מצב המערכת
  const state = {
    availableFiles: new Map(), // hash -> { blob, mimeType, size, timestamp }
    lastAvailabilityPublish: new Map(), // hash -> timestamp
    activePeers: new Map(), // hash -> Set(pubkeys)
    activeConnections: new Map(), // connectionId -> RTCPeerConnection
    pendingConnections: new Map(), // connectionId -> { pc, timeout }
    downloadQueue: new Map(), // hash -> Promise
  };

  // חלק P2P (p2p-video-sharing.js) – לוגים צבעוניים
  function log(type, message, data = null) {
    const timestamp = new Date().toLocaleTimeString('he-IL');
    const styles = {
      upload: 'background: #4CAF50; color: white; padding: 2px 6px; border-radius: 3px;',
      download: 'background: #2196F3; color: white; padding: 2px 6px; border-radius: 3px;',
      request: 'background: #FF9800; color: white; padding: 2px 6px; border-radius: 3px;',
      peer: 'background: #9C27B0; color: white; padding: 2px 6px; border-radius: 3px;',
      success: 'background: #8BC34A; color: white; padding: 2px 6px; border-radius: 3px;',
      error: 'background: #F44336; color: white; padding: 2px 6px; border-radius: 3px;',
      info: 'background: #607D8B; color: white; padding: 2px 6px; border-radius: 3px;',
    };

    console.log(
      `%c[P2P ${type.toUpperCase()}]%c ${timestamp} - ${message}`,
      styles[type] || styles.info,
      'color: inherit;'
    );

    if (data) {
      console.log('   📊 Data:', data);
    }
  }

  // חלק P2P (p2p-video-sharing.js) – רישום קובץ כזמין
  async function registerFileAvailability(hash, blob, mimeType) {
    try {
      log('upload', `📤 רישום קובץ כזמין`, {
        hash: hash.slice(0, 16) + '...',
        size: blob.size,
        mimeType
      });

      // שמירה מקומית
      state.availableFiles.set(hash, {
        blob,
        mimeType,
        size: blob.size,
        timestamp: Date.now(),
      });

      // פרסום לרשת
      if (!App.pool || !App.publicKey || !App.privateKey) {
        log('error', '❌ לא ניתן לפרסם - חסרים pool או keys');
        return false;
      }

      const now = Date.now();
      const lastPublish = state.lastAvailabilityPublish.get(hash) || 0;
      if (now - lastPublish < AVAILABILITY_REPUBLISH_INTERVAL) {
        const waitMs = AVAILABILITY_REPUBLISH_INTERVAL - (now - lastPublish);
        log('info', `⏳ דילוג על פרסום לריליי (קירור ${Math.ceil(waitMs / 1000)}ש׳׳)`, {
          hash: hash.slice(0, 16) + '...'
        });
        return true;
      }

      const event = {
        kind: FILE_AVAILABILITY_KIND,
        pubkey: App.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['x', hash],
          ['size', String(blob.size)],
          ['mime', mimeType],
          ['expires', String(Date.now() + AVAILABILITY_EXPIRY)],
        ],
        content: '',
      };

      const signed = App.finalizeEvent(event, App.privateKey);
      const relays = getP2PRelays();
      const publishResults = App.pool.publish(relays, signed);

      let successCount = 0;
      if (Array.isArray(publishResults)) {
        const results = await Promise.allSettled(publishResults);
        const failures = [];
        results.forEach((result, idx) => {
          if (result.status === 'fulfilled') {
            successCount++;
          } else {
            failures.push({
              relay: App.relayUrls?.[idx] || idx,
              error: result.reason?.message || String(result.reason || 'unknown')
            });
          }
        });

        if (successCount === 0) {
          log('error', '❌ כל הריליים דחו את פרסום הזמינות', {
            hash: hash.slice(0, 16) + '...',
            failures
          });
          return false;
        }

        if (failures.length) {
          log('info', '⚠️ חלק מהריליים דחו את הפרסום', { failures });
        }
      } else if (publishResults?.then) {
        await publishResults;
        successCount = 1;
      } else {
        successCount = 1;
      }

      log('success', `✅ קובץ נרשם בהצלחה ברשת`, {
        hash: hash.slice(0, 16) + '...',
        eventId: signed.id.slice(0, 8) + '...'
      });

      state.lastAvailabilityPublish.set(hash, Date.now());

      return true;
    } catch (err) {
      log('error', `❌ כשלון ברישום קובץ: ${err.message}`);
      return false;
    }
  }

  // חלק P2P (p2p-video-sharing.js) – חיפוש peers עם קובץ
  async function findPeersWithFile(hash) {
    return new Promise((resolve) => {
      log('download', `🔍 מחפש peers עם קובץ`, { hash: hash.slice(0, 16) + '...' });

      const peers = new Set();
      const filters = [{
        kinds: [FILE_AVAILABILITY_KIND],
        '#x': [hash],
        since: Math.floor(Date.now() / 1000) - PEER_DISCOVERY_LOOKBACK,
      }];

      let finished = false;
      let timeoutHandle = null;
      let sub;

      const finalize = (peerArray) => {
        if (finished) {
          return;
        }
        finished = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (sub && typeof sub.close === 'function') {
          try {
            sub.close();
          } catch (err) {
            console.warn('Failed closing subscription', err);
          }
        }
        resolve(peerArray);
      };

      try {
        const relays = getP2PRelays();
        sub = App.pool.subscribeMany(relays, filters, {
          onevent: (event) => {
            if (event.pubkey === App.publicKey) {
              return; // לא להוריד מעצמי
            }

            const expiresTag = event.tags.find(t => t[0] === 'expires');
            const expires = expiresTag ? parseInt(expiresTag[1]) : 0;

            if (expires && expires > Date.now()) {
              peers.add(event.pubkey);
              log('peer', `👤 נמצא peer זמין`, {
                pubkey: event.pubkey.slice(0, 16) + '...',
                expires: new Date(expires).toLocaleTimeString('he-IL')
              });
            }
          },
          oneose: () => {
            const peerArray = Array.from(peers);
            log('info', `📋 סיימתי חיפוש - נמצאו ${peerArray.length} peers`, {
              peers: peerArray.map(p => p.slice(0, 16) + '...')
            });
            finalize(peerArray);
          }
        });

        // timeout
        timeoutHandle = setTimeout(() => {
          const peerArray = Array.from(peers);
          log('info', `⏱️ timeout בחיפוש - נמצאו ${peerArray.length} peers עד כה`);
          finalize(peerArray);
        }, PEER_DISCOVERY_TIMEOUT);

      } catch (err) {
        log('error', `❌ כשלון בחיפוש peers: ${err.message}`);
        finalize([]);
      }
    });
  }

  // חלק P2P (p2p-video-sharing.js) – הורדת קובץ מ-peer
  async function downloadFromPeer(peerPubkey, hash) {
    const connectionId = `${peerPubkey}-${hash}-${Date.now()}`;
    
    log('download', `📥 מנסה להוריד מ-peer`, {
      peer: peerPubkey.slice(0, 16) + '...',
      hash: hash.slice(0, 16) + '...',
      connectionId
    });

    return new Promise(async (resolve, reject) => {
      const timeoutMs = typeof window.NostrP2P_DOWNLOAD_TIMEOUT === 'number'
        ? window.NostrP2P_DOWNLOAD_TIMEOUT
        : MAX_DOWNLOAD_TIMEOUT;
      const timeout = setTimeout(() => {
        log('error', `⏱️ timeout בהורדה מ-peer`, { peer: peerPubkey.slice(0, 16) + '...' });
        cleanup();
        reject(new Error('Download timeout'));
      }, timeoutMs);

      let pc = null;
      let channel = null;
      const chunks = [];
      let receivedSize = 0;
      let totalSize = 0;

      function cleanup() {
        clearTimeout(timeout);
        if (channel) {
          channel.close();
        }
        if (pc) {
          pc.close();
          state.activeConnections.delete(connectionId);
        }
        const pending = state.pendingConnections.get(connectionId);
        if (pending) {
          clearTimeout(pending.timeout);
          state.pendingConnections.delete(connectionId);
        }
      }

      try {
        // יצירת RTCPeerConnection
        pc = new RTCPeerConnection(RTC_CONFIG);
        state.activeConnections.set(connectionId, pc);

        log('peer', `🔗 יצירת RTCPeerConnection`, { connectionId });

        // יצירת data channel
        channel = pc.createDataChannel('file-transfer', {
          ordered: true,
        });

        log('peer', `📡 יצירת data channel`, { connectionId });

        channel.onopen = () => {
          log('success', `✅ data channel נפתח`, { connectionId });
          // שליחת בקשה לקובץ
          channel.send(JSON.stringify({ type: 'request', hash }));
          log('request', `📤 שלחתי בקשה לקובץ`, { hash: hash.slice(0, 16) + '...' });
        };

        channel.onmessage = (event) => {
          try {
            if (typeof event.data === 'string') {
              const msg = JSON.parse(event.data);
              
              if (msg.type === 'metadata') {
                totalSize = msg.size;
                log('info', `📊 קיבלתי metadata`, {
                  size: totalSize,
                  mimeType: msg.mimeType
                });
              } else if (msg.type === 'complete') {
                log('success', `✅ קיבלתי את כל הקובץ!`, {
                  chunks: chunks.length,
                  totalSize: receivedSize
                });

                // בניית הקובץ
                const blob = new Blob(chunks, { type: msg.mimeType });
                cleanup();
                resolve({ blob, mimeType: msg.mimeType });
              } else if (msg.type === 'error') {
                log('error', `❌ שגיאה מהשרת: ${msg.message}`);
                cleanup();
                reject(new Error(msg.message));
              }
            } else {
              // chunk של data
              chunks.push(event.data);
              receivedSize += event.data.byteLength || event.data.size;
              
              const progress = totalSize > 0 ? ((receivedSize / totalSize) * 100).toFixed(1) : '?';
              log('download', `📦 קיבלתי chunk ${chunks.length}`, {
                chunkSize: event.data.byteLength || event.data.size,
                progress: `${progress}%`,
                received: `${receivedSize} / ${totalSize}`
              });
            }
          } catch (err) {
            log('error', `❌ שגיאה בעיבוד הודעה: ${err.message}`);
          }
        };

        channel.onerror = (err) => {
          log('error', `❌ שגיאה ב-data channel: ${err}`);
          cleanup();
          reject(err);
        };

        channel.onclose = () => {
          log('info', `🔌 data channel נסגר`, { connectionId });
        };

        // ICE candidates
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            log('peer', `🧊 ICE candidate חדש`, {
              type: event.candidate.type,
              protocol: event.candidate.protocol
            });
            // שליחת candidate דרך Nostr
            sendSignal(peerPubkey, 'ice-candidate', {
              candidate: event.candidate,
              hash,
              connectionId
            });
          }
        };

        pc.oniceconnectionstatechange = () => {
          log('peer', `🔄 ICE connection state: ${pc.iceConnectionState}`, { connectionId });
          
          if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            log('error', `❌ חיבור נכשל`, { state: pc.iceConnectionState });
            cleanup();
            reject(new Error('Connection failed'));
          }
        };

        // יצירת offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        log('peer', `📤 שולח offer ל-peer`, { peer: peerPubkey.slice(0, 16) + '...' });

        // שליחת offer דרך Nostr
        await sendSignal(peerPubkey, 'file-request', {
          offer: offer,
          hash,
          connectionId
        });

        log('request', `✅ offer נשלח בהצלחה`, { connectionId });

        const answerTimeout = setTimeout(() => {
          log('error', '❌ לא התקבל answer בזמן', { connectionId });
          state.pendingConnections.delete(connectionId);
          cleanup();
          reject(new Error('Answer timeout'));
        }, ANSWER_TIMEOUT);

        state.pendingConnections.set(connectionId, { pc, timeout: answerTimeout });

      } catch (err) {
        log('error', `❌ כשלון ביצירת חיבור: ${err.message}`);
        cleanup();
        reject(err);
      }
    });
  }

  // חלק P2P (p2p-video-sharing.js) – שליחת signal דרך Nostr
  async function sendSignal(peerPubkey, type, data) {
    try {
      if (!App.pool || !App.publicKey || !App.privateKey) {
        throw new Error('Missing pool or keys');
      }

      const content = JSON.stringify({ type, data });
      
      // הצפנה אם יש פונקציה
      let encryptedContent = content;
      if (typeof App.encryptMessage === 'function') {
        encryptedContent = await App.encryptMessage(content, peerPubkey);
      }

      const kind = type === 'file-request' ? FILE_REQUEST_KIND : FILE_RESPONSE_KIND;

      const event = {
        kind,
        pubkey: App.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['p', peerPubkey],
        ],
        content: encryptedContent,
      };

      const signed = App.finalizeEvent(event, App.privateKey);
      await App.pool.publish(App.relayUrls, signed);

      log('peer', `📡 signal נשלח`, {
        type,
        to: peerPubkey.slice(0, 16) + '...',
        kind
      });

    } catch (err) {
      log('error', `❌ כשלון בשליחת signal: ${err.message}`);
      throw err;
    }
  }

  // חלק P2P (p2p-video-sharing.js) – האזנה לסיגנלים (בקשות, תשובות ו-ICE)
  function listenForP2PSignals() {
    if (!App.pool || !App.publicKey) {
      log('error', '❌ לא ניתן להאזין לסיגנלים - חסרים pool או publicKey');
      return;
    }

    log('info', '👂 מתחיל להאזין לסיגנלי P2P...');

    const filters = [
      {
        kinds: [FILE_REQUEST_KIND, FILE_RESPONSE_KIND],
        '#p': [App.publicKey],
        since: Math.floor(Date.now() / 1000),
      }
    ];

    try {
      const relays = getP2PRelays();
      const sub = App.pool.subscribeMany(relays, filters, {
        onevent: async (event) => {
          log('request', `📬 התקבל סיגנל`, {
            kind: event.kind,
            from: event.pubkey.slice(0, 16) + '...',
            eventId: event.id.slice(0, 8) + '...'
          });

          try {
            let content = event.content;

            if (typeof App.decryptMessage === 'function') {
              content = await App.decryptMessage(content, event.pubkey);
            }

            const message = JSON.parse(content);

            if (message.type === 'file-request') {
              await handleFileRequest(event.pubkey, message.data);
            } else if (message.type === 'file-response') {
              await handleFileResponse(event.pubkey, message.data);
            } else if (message.type === 'ice-candidate') {
              await handleIceCandidate(event.pubkey, message.data);
            }

          } catch (err) {
            log('error', `❌ כשלון בעיבוד סיגנל: ${err.message}`);
          }
        }
      });

      App._p2pSignalsSub = sub;
      log('success', '✅ מאזין לסיגנלי P2P');

    } catch (err) {
      log('error', `❌ כשלון בהאזנה לסיגנלים: ${err.message}`);
    }
  }

  async function handleFileResponse(peerPubkey, data) {
    try {
      const { answer, connectionId } = data || {};
      if (!connectionId || !answer) {
        log('error', '❌ תשובה חסרה connectionId או answer');
        return;
      }

      const pc = state.activeConnections.get(connectionId);
      if (!pc) {
        log('error', `❌ לא נמצא חיבור פעיל עבור ${connectionId}`);
        return;
      }

      const pending = state.pendingConnections.get(connectionId);
      if (pending) {
        clearTimeout(pending.timeout);
        state.pendingConnections.delete(connectionId);
      }

      log('peer', `📥 קיבלתי answer מ-peer`, {
        peer: peerPubkey.slice(0, 16) + '...',
        connectionId
      });

      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      log('success', '✅ answer נוסף בהצלחה');
    } catch (err) {
      log('error', `❌ כשלון בעיבוד answer: ${err.message}`);
    }
  }

  // חלק P2P (p2p-video-sharing.js) – טיפול בבקשת קובץ
  async function handleFileRequest(peerPubkey, data) {
    const { offer, hash, connectionId } = data;

    log('request', `🔧 מטפל בבקשת קובץ`, {
      peer: peerPubkey.slice(0, 16) + '...',
      hash: hash.slice(0, 16) + '...',
      connectionId
    });

    // בדיקה אם יש לנו את הקובץ
    const fileData = state.availableFiles.get(hash);
    if (!fileData) {
      log('error', `❌ אין לי את הקובץ הזה`, { hash: hash.slice(0, 16) + '...' });
      return;
    }

    log('success', `✅ יש לי את הקובץ! מתחיל שליחה`, {
      size: fileData.size,
      mimeType: fileData.mimeType
    });

    try {
      const pc = new RTCPeerConnection(RTC_CONFIG);
      state.activeConnections.set(connectionId, pc);

      log('peer', `🔗 יצרתי RTCPeerConnection לשליחה`, { connectionId });

      // קבלת data channel מה-peer
      pc.ondatachannel = (event) => {
        const channel = event.channel;
        
        log('peer', `📡 קיבלתי data channel`, { connectionId });

        channel.onopen = async () => {
          log('success', `✅ data channel נפתח - מתחיל שליחה!`);

          try {
            // שליחת metadata
            channel.send(JSON.stringify({
              type: 'metadata',
              size: fileData.size,
              mimeType: fileData.mimeType
            }));

            log('upload', `📊 שלחתי metadata`, {
              size: fileData.size,
              mimeType: fileData.mimeType
            });

            // שליחת הקובץ ב-chunks
            const blob = fileData.blob;
            let offset = 0;
            let chunkNum = 0;

            while (offset < blob.size) {
              const chunk = blob.slice(offset, offset + CHUNK_SIZE);
              const arrayBuffer = await chunk.arrayBuffer();
              
              // המתנה אם ה-buffer מלא
              while (channel.bufferedAmount > CHUNK_SIZE * 4) {
                await new Promise(resolve => setTimeout(resolve, 10));
              }

              channel.send(arrayBuffer);
              chunkNum++;
              offset += CHUNK_SIZE;

              const progress = ((offset / blob.size) * 100).toFixed(1);
              log('upload', `📤 שלחתי chunk ${chunkNum}`, {
                progress: `${progress}%`,
                sent: `${offset} / ${blob.size}`
              });
            }

            // שליחת הודעת סיום
            channel.send(JSON.stringify({
              type: 'complete',
              mimeType: fileData.mimeType
            }));

            log('success', `✅ סיימתי לשלוח את כל הקובץ!`, {
              chunks: chunkNum,
              totalSize: blob.size
            });

          } catch (err) {
            log('error', `❌ שגיאה בשליחת קובץ: ${err.message}`);
            channel.send(JSON.stringify({
              type: 'error',
              message: err.message
            }));
          }
        };

        channel.onerror = (err) => {
          log('error', `❌ שגיאה ב-data channel: ${err}`);
        };

        channel.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'request') {
              log('request', `📥 peer ביקש את הקובץ`, { hash: msg.hash.slice(0, 16) + '...' });
            }
          } catch (err) {
            // לא JSON, אולי binary data
          }
        };
      };

      // ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          log('peer', `🧊 ICE candidate חדש (שליחה)`, {
            type: event.candidate.type
          });
          sendSignal(peerPubkey, 'ice-candidate', {
            candidate: event.candidate,
            hash,
            connectionId
          });
        }
      };

      pc.oniceconnectionstatechange = () => {
        log('peer', `🔄 ICE connection state (שליחה): ${pc.iceConnectionState}`);
      };

      // קבלת ה-offer ויצירת answer
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      log('peer', `📤 שולח answer ל-peer`, { peer: peerPubkey.slice(0, 16) + '...' });

      // שליחת answer
      await sendSignal(peerPubkey, 'file-response', {
        answer: answer,
        hash,
        connectionId
      });

      log('success', `✅ answer נשלח בהצלחה`);

    } catch (err) {
      log('error', `❌ כשלון בטיפול בבקשה: ${err.message}`);
    }
  }

  // חלק P2P (p2p-video-sharing.js) – טיפול ב-ICE candidate
  async function handleIceCandidate(peerPubkey, data) {
    const { candidate, connectionId } = data;
    
    log('peer', `🧊 קיבלתי ICE candidate`, {
      peer: peerPubkey.slice(0, 16) + '...',
      connectionId
    });

    const pc = state.activeConnections.get(connectionId);
    if (pc && candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        log('success', `✅ ICE candidate נוסף בהצלחה`);
      } catch (err) {
        log('error', `❌ כשלון בהוספת ICE candidate: ${err.message}`);
      }
    }
  }

  // חלק P2P (p2p-video-sharing.js) – הורדת וידאו עם fallback
  async function downloadVideoWithP2P(url, hash, mimeType = 'video/webm') {
    log('download', `🎬 מתחיל הורדת וידאו`, {
      url: url.slice(0, 50) + '...',
      hash: hash ? hash.slice(0, 16) + '...' : 'אין hash'
    });

    // אם אין hash, הורדה רגילה
    if (!hash) {
      log('info', `ℹ️ אין hash - הורדה רגילה מהלינק`);
      try {
        const response = await fetch(url);
        const blob = await response.blob();
        log('success', `✅ הורדה מהלינק הצליחה`, { size: blob.size });
        return { blob, source: 'url' };
      } catch (err) {
        log('error', `❌ הורדה מהלינק נכשלה: ${err.message}`);
        throw err;
      }
    }

    // בדיקה אם יש ב-cache
    if (typeof App.getCachedMedia === 'function') {
      const cached = await App.getCachedMedia(hash);
      if (cached && cached.blob) {
        log('success', `✅ נמצא ב-cache מקומי!`, { size: cached.blob.size });
        const cachedMime = cached.mimeType || mimeType;
        await registerFileAvailability(hash, cached.blob, cachedMime);
        return { blob: cached.blob, source: 'cache' };
      }
    }

    // חיפוש peers
    const peers = await findPeersWithFile(hash);

    if (peers.length === 0) {
      log('info', `ℹ️ לא נמצאו peers - הורדה מהלינק`);
      try {
        const response = await fetch(url);
        const blob = await response.blob();
        log('success', `✅ הורדה מהלינק הצליחה`, { size: blob.size });
        
        // שמירה ב-cache
        if (typeof App.cacheMedia === 'function') {
          await App.cacheMedia(url, hash, blob, mimeType);
        }
        if (hash) {
          await registerFileAvailability(hash, blob, mimeType);
        }
        
        return { blob, source: 'url' };
      } catch (err) {
        log('error', `❌ הורדה מהלינק נכשלה: ${err.message}`);
        throw err;
      }
    }

    // ניסיון הורדה מכל peer
    for (const peer of peers) {
      try {
        log('download', `🔄 מנסה להוריד מ-peer ${peers.indexOf(peer) + 1}/${peers.length}`, {
          peer: peer.slice(0, 16) + '...'
        });

        const result = await downloadFromPeer(peer, hash);
        
        log('success', `🎉 הורדה מ-peer הצליחה!`, {
          peer: peer.slice(0, 16) + '...',
          size: result.blob.size
        });

        // שמירה ב-cache
        if (typeof App.cacheMedia === 'function') {
          await App.cacheMedia(url, hash, result.blob, result.mimeType);
        }

        // רישום שיש לנו את הקובץ
        await registerFileAvailability(hash, result.blob, result.mimeType);

        return { blob: result.blob, source: 'p2p', peer };

      } catch (err) {
        log('error', `❌ הורדה מ-peer נכשלה: ${err.message}`, {
          peer: peer.slice(0, 16) + '...'
        });
        continue; // נסה peer הבא
      }
    }

    // כל ה-peers נכשלו - fallback ללינק
    log('info', `ℹ️ כל ה-peers נכשלו - fallback ללינק`);
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      log('success', `✅ fallback ללינק הצליח`, { size: blob.size });
      
      // שמירה ב-cache
      if (typeof App.cacheMedia === 'function') {
        await App.cacheMedia(url, hash, blob, mimeType);
      }
      if (hash) {
        await registerFileAvailability(hash, blob, mimeType);
      }
      
      return { blob, source: 'url-fallback' };
    } catch (err) {
      log('error', `❌ גם fallback ללינק נכשל: ${err.message}`);
      throw err;
    }
  }

  // חשיפה ל-App
  Object.assign(App, {
    registerFileAvailability,
    findPeersWithFile,
    downloadVideoWithP2P,
    p2pGetAvailableFiles: () => state.availableFiles,
    p2pGetActiveConnections: () => state.activeConnections,
  });

  // אתחול
  function init() {
    log('info', '🚀 מערכת P2P Video Sharing מאותחלת...');
    
    // ניסיון אתחול מיידי
    function tryInit() {
      if (App.publicKey && App.pool) {
        listenForP2PSignals();
        log('success', '✅ מערכת P2P מוכנה!', {
          publicKey: App.publicKey.slice(0, 16) + '...',
          relays: getP2PRelays().length
        });
        return true;
      }
      return false;
    }
    
    // ניסיון ראשון
    if (tryInit()) return;
    
    // ניסיונות נוספים עם המתנה
    let attempts = 0;
    const maxAttempts = 10;
    const interval = setInterval(() => {
      attempts++;
      log('info', `🔄 ניסיון אתחול ${attempts}/${maxAttempts}...`);
      
      if (tryInit()) {
        clearInterval(interval);
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
        log('error', '❌ חסרים publicKey או pool - מערכת P2P לא פעילה');
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // חלק P2P (p2p-video-sharing.js) – חשיפת API ל-App
  Object.assign(App, {
    registerFileAvailability,
    searchForPeers: findPeersWithFile,
    downloadVideoWithP2P,
    availableFiles: state.availableFiles,
  });

})(window);
