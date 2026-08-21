/**
 * חלק Peer Exchange (p2p-peer-exchange.js) – פרוטוקול שיתוף peers | HYPER CORE TECH
 * 
 * מודול זה מרחיב את מערכת ה-P2P עם יכולת שיתוף מידע על peers
 * בין משתמשים, מה שמפחית את העומס על ה-Relays ומאפשר סקייל למיליון משתמשים.
 * 
 * תכונות:
 * - Peer Exchange Protocol: שיתוף רשימות peers וקבצים בין משתמשים
 * - Signal Relay: העברת WebRTC signals דרך peers מתווכים (Mesh Network)
 * - Persistent Connections: שימוש חוזר בחיבורים קיימים
 * 
 * גרסה: 2.1.0-auto-exchange
 * תאריך: 8 בדצמבר 2025
 */

(function initPeerExchange(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  
  // ממתינים שמערכת ה-P2P הראשית תיטען
  if (!App.p2pReady) {
    App.p2pReady = new Promise(resolve => {
      App.notifyP2PReady = resolve;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // הגדרות
  // ═══════════════════════════════════════════════════════════════════════════
  
  const CONFIG = {
    MAX_KNOWN_PEERS: 50,           // מקסימום peers לשמור בזיכרון
    PEER_TTL: 5 * 60 * 1000,       // 5 דקות - אחרי זה peer נחשב לא פעיל
    EXCHANGE_INTERVAL: 30 * 1000,  // כל 30 שניות לבקש עדכון מ-peers מחוברים
    MAX_FILES_TO_SHARE: 100,       // מקסימום קבצים לשתף ברשימה
    MAX_PEERS_TO_SHARE: 20,        // מקסימום peers לשתף ברשימה
    CLEANUP_INTERVAL: 60 * 1000,   // ניקוי כל דקה
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // סוגי הודעות
  // ═══════════════════════════════════════════════════════════════════════════
  
  const MESSAGE_TYPES = {
    PEER_EXCHANGE_REQUEST: 'peer-exchange-request',
    PEER_EXCHANGE_RESPONSE: 'peer-exchange-response',
    // חלק Signal Relay (p2p-peer-exchange.js) – הודעות להעברת signals דרך peers | HYPER CORE TECH
    RELAY_SIGNAL: 'relay-signal',
    RELAY_SIGNAL_FORWARD: 'relay-signal-forward',
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════════════════════════
  
  const state = {
    // peers שאנחנו מכירים ומה יש להם
    // pubkey -> { files: Set<hash>, lastSeen: timestamp, isConnected: boolean }
    knownPeers: new Map(),
    
    // קבצים ואיפה הם נמצאים (מעבר למה שיש ב-Relay)
    // hash -> Set<pubkey>
    fileLocations: new Map(),
    
    // חיבורים פעילים (DataChannels)
    // pubkey -> RTCDataChannel
    activeChannels: new Map(),
    
    // חלק Signal Relay (p2p-peer-exchange.js) – בקשות signal שממתינות להעברה | HYPER CORE TECH
    // targetPubkey -> [{ signal, originalSender, timestamp, hops }]
    pendingRelaySignals: new Map(),
    
    // סטטיסטיקות
    stats: {
      exchangesSent: 0,
      exchangesReceived: 0,
      peersLearned: 0,
      filesLearned: 0,
      signalsRelayed: 0,
      signalsForwarded: 0,
    },
    
    // intervals
    cleanupInterval: null,
    exchangeInterval: null,
  };
  
  // חלק Signal Relay (p2p-peer-exchange.js) – הגדרות Mesh Network | HYPER CORE TECH
  const RELAY_CONFIG = {
    MAX_RELAY_HOPS: 2,           // מקסימום 2 קפיצות בין peers
    SIGNAL_TTL: 30 * 1000,       // 30 שניות - אחרי זה signal פג תוקף
    MAX_PENDING_SIGNALS: 50,     // מקסימום signals בהמתנה
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // לוגים
  // ═══════════════════════════════════════════════════════════════════════════
  
  function log(type, message, data = null) {
    const timestamp = new Date().toLocaleTimeString('he-IL');
    const colors = {
      info: '#607D8B',
      success: '#4CAF50',
      error: '#F44336',
      exchange: '#9C27B0',
    };
    const color = colors[type] || '#607D8B';
    
    let logLine = `🔄 [PeerExchange] ${message}`;
    if (data) {
      const shortData = Object.entries(data)
        .map(([k, v]) => `${k}:${v}`)
        .join(' | ');
      logLine += ` [${shortData}]`;
    }
    
    console.log(`%c${timestamp} ${logLine}`, `color: ${color}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ניהול Peers
  // ═══════════════════════════════════════════════════════════════════════════
  
  /**
   * רישום peer חדש או עדכון קיים
   */
  function registerPeer(pubkey, files = [], lastSeen = Date.now()) {
    if (!pubkey) return;
    
    const existing = state.knownPeers.get(pubkey) || {
      files: new Set(),
      lastSeen: 0,
      isConnected: false,
    };
    
    // עדכון קבצים
    if (Array.isArray(files)) {
      files.forEach(hash => {
        existing.files.add(hash);
        
        // עדכון fileLocations
        if (!state.fileLocations.has(hash)) {
          state.fileLocations.set(hash, new Set());
        }
        state.fileLocations.get(hash).add(pubkey);
      });
    }
    
    // עדכון זמן
    if (lastSeen > existing.lastSeen) {
      existing.lastSeen = lastSeen;
    }
    
    state.knownPeers.set(pubkey, existing);
    
    // ניקוי אם יש יותר מדי peers
    if (state.knownPeers.size > CONFIG.MAX_KNOWN_PEERS) {
      cleanupOldPeers();
    }
  }

  /**
   * סימון peer כמחובר
   */
  function markPeerConnected(pubkey, channel) {
    if (!pubkey) return;
    
    const peer = state.knownPeers.get(pubkey);
    if (peer) {
      peer.isConnected = true;
      peer.lastSeen = Date.now();
    } else {
      registerPeer(pubkey);
      state.knownPeers.get(pubkey).isConnected = true;
    }
    
    if (channel) {
      state.activeChannels.set(pubkey, channel);
      
      // חלק Signal Relay (p2p-peer-exchange.js) – שליחת signals שהמתינו | HYPER CORE TECH
      flushPendingSignals(pubkey, channel);
    }
    
    log('info', 'Peer מחובר', { peer: pubkey.slice(0, 8) });
  }

  /**
   * סימון peer כמנותק
   */
  function markPeerDisconnected(pubkey) {
    if (!pubkey) return;
    
    const peer = state.knownPeers.get(pubkey);
    if (peer) {
      peer.isConnected = false;
    }
    
    state.activeChannels.delete(pubkey);
    
    log('info', 'Peer מנותק', { peer: pubkey.slice(0, 8) });
  }

  /**
   * ניקוי peers ישנים
   */
  function cleanupOldPeers() {
    const now = Date.now();
    const toDelete = [];
    
    state.knownPeers.forEach((data, pubkey) => {
      // לא מוחקים peers מחוברים
      if (data.isConnected) return;
      
      // מוחקים אם ישנים מדי
      if (now - data.lastSeen > CONFIG.PEER_TTL) {
        toDelete.push(pubkey);
      }
    });
    
    // מחיקה
    toDelete.forEach(pubkey => {
      state.knownPeers.delete(pubkey);
      
      // ניקוי מ-fileLocations
      state.fileLocations.forEach((peers, hash) => {
        peers.delete(pubkey);
        if (peers.size === 0) {
          state.fileLocations.delete(hash);
        }
      });
    });
    
    // אם עדיין יותר מדי - מוחקים את הישנים ביותר
    if (state.knownPeers.size > CONFIG.MAX_KNOWN_PEERS) {
      const sorted = [...state.knownPeers.entries()]
        .filter(([_, d]) => !d.isConnected)
        .sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      
      const toRemove = sorted.slice(0, state.knownPeers.size - CONFIG.MAX_KNOWN_PEERS);
      toRemove.forEach(([pubkey]) => {
        state.knownPeers.delete(pubkey);
      });
    }
    
    if (toDelete.length > 0) {
      log('info', 'ניקוי peers ישנים', { removed: toDelete.length, remaining: state.knownPeers.size });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Peer Exchange Protocol
  // ═══════════════════════════════════════════════════════════════════════════
  
  /**
   * שליחת בקשת Peer Exchange
   */
  function sendPeerExchangeRequest(channel) {
    if (!channel || channel.readyState !== 'open') return;
    
    try {
      channel.send(JSON.stringify({
        type: MESSAGE_TYPES.PEER_EXCHANGE_REQUEST,
        timestamp: Date.now(),
      }));
      
      state.stats.exchangesSent++;
      log('exchange', 'שלחתי בקשת Exchange');
    } catch (err) {
      log('error', 'שגיאה בשליחת Exchange request', { error: err.message });
    }
  }

  /**
   * טיפול בבקשת Peer Exchange - שליחת תשובה
   */
  function handlePeerExchangeRequest(channel, senderPubkey) {
    if (!channel || channel.readyState !== 'open') return;
    
    // אוסף את הקבצים שיש לנו
    const myFiles = [];
    if (App.getAvailableFiles) {
      const files = App.getAvailableFiles();
      if (files && typeof files.keys === 'function') {
        myFiles.push(...Array.from(files.keys()).slice(0, CONFIG.MAX_FILES_TO_SHARE));
      }
    }
    
    // אוסף peers שאנחנו מכירים (לא כולל השולח)
    const myPeers = [];
    state.knownPeers.forEach((data, pubkey) => {
      if (pubkey === senderPubkey) return;
      if (Date.now() - data.lastSeen > CONFIG.PEER_TTL) return;
      
      if (myPeers.length < CONFIG.MAX_PEERS_TO_SHARE) {
        myPeers.push({
          pubkey,
          lastSeen: data.lastSeen,
          fileCount: data.files.size,
        });
      }
    });
    
    try {
      channel.send(JSON.stringify({
        type: MESSAGE_TYPES.PEER_EXCHANGE_RESPONSE,
        files: myFiles,
        knownPeers: myPeers,
        timestamp: Date.now(),
      }));
      
      log('exchange', 'שלחתי תשובת Exchange', { 
        files: myFiles.length, 
        peers: myPeers.length 
      });
    } catch (err) {
      log('error', 'שגיאה בשליחת Exchange response', { error: err.message });
    }
  }

  /**
   * עיבוד תשובת Peer Exchange
   */
  function handlePeerExchangeResponse(msg, senderPubkey) {
    const { files, knownPeers, timestamp } = msg;
    
    state.stats.exchangesReceived++;
    
    // עדכון קבצים של ה-peer השולח
    if (Array.isArray(files) && files.length > 0) {
      registerPeer(senderPubkey, files, timestamp);
      state.stats.filesLearned += files.length;
    }
    
    // עדכון peers שלמדנו עליהם
    if (Array.isArray(knownPeers)) {
      const myPubkey = App.publicKey || App.getEffectiveKeys?.()?.publicKey;
      
      knownPeers.forEach(({ pubkey, lastSeen, fileCount }) => {
        if (!pubkey) return;
        if (pubkey === myPubkey) return; // לא את עצמנו
        
        const existing = state.knownPeers.get(pubkey);
        if (!existing || existing.lastSeen < lastSeen) {
          registerPeer(pubkey, [], lastSeen);
          state.stats.peersLearned++;
        }
      });
    }
    
    log('exchange', 'עיבדתי תשובת Exchange', {
      filesLearned: files?.length || 0,
      peersLearned: knownPeers?.length || 0,
      totalKnownPeers: state.knownPeers.size,
      totalFileLocations: state.fileLocations.size,
    });
  }

  /**
   * טיפול בהודעה נכנסת - נקרא מ-p2p-video-sharing.js
   */
  function handleIncomingMessage(msg, senderPubkey, channel) {
    if (!msg || !msg.type) return false;
    
    switch (msg.type) {
      case MESSAGE_TYPES.PEER_EXCHANGE_REQUEST:
        handlePeerExchangeRequest(channel, senderPubkey);
        return true;
        
      case MESSAGE_TYPES.PEER_EXCHANGE_RESPONSE:
        handlePeerExchangeResponse(msg, senderPubkey);
        return true;
      
      // חלק Signal Relay (p2p-peer-exchange.js) – טיפול בהודעות relay | HYPER CORE TECH
      case MESSAGE_TYPES.RELAY_SIGNAL:
        handleRelaySignal(msg, senderPubkey, channel);
        return true;
        
      case MESSAGE_TYPES.RELAY_SIGNAL_FORWARD:
        handleRelaySignalForward(msg, senderPubkey);
        return true;
        
      default:
        return false; // לא טיפלנו - תן ל-handler אחר
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // Signal Relay - העברת signals דרך peers (Mesh Network)
  // ═══════════════════════════════════════════════════════════════════════════
  
  /**
   * שליחת signal דרך peer מתווך
   * A רוצה להתחבר ל-C אבל לא מחובר אליו → שולח דרך B
   */
  function sendRelaySignal(targetPubkey, signal, viaPubkey) {
    const channel = state.activeChannels.get(viaPubkey);
    if (!channel || channel.readyState !== 'open') {
      log('error', 'לא ניתן לשלוח relay signal - אין חיבור למתווך', { via: viaPubkey?.slice(0, 8) });
      return false;
    }
    
    const myPubkey = App.publicKey || App.getEffectiveKeys?.()?.publicKey;
    
    try {
      channel.send(JSON.stringify({
        type: MESSAGE_TYPES.RELAY_SIGNAL,
        targetPubkey,
        signal,
        originalSender: myPubkey,
        timestamp: Date.now(),
        hops: 1,
      }));
      
      state.stats.signalsRelayed++;
      log('info', '📡 שלחתי Relay Signal', { 
        target: targetPubkey.slice(0, 8), 
        via: viaPubkey.slice(0, 8) 
      });
      return true;
    } catch (err) {
      log('error', 'שגיאה בשליחת Relay Signal', { error: err.message });
      return false;
    }
  }
  
  /**
   * טיפול ב-Relay Signal שהתקבל - העברה ליעד או שמירה
   */
  function handleRelaySignal(msg, senderPubkey, senderChannel) {
    const { targetPubkey, signal, originalSender, timestamp, hops } = msg;
    
    // בדיקת תוקף
    if (Date.now() - timestamp > RELAY_CONFIG.SIGNAL_TTL) {
      log('info', 'Relay Signal פג תוקף', { age: Date.now() - timestamp });
      return;
    }
    
    // בדיקת מקסימום hops
    if (hops >= RELAY_CONFIG.MAX_RELAY_HOPS) {
      log('info', 'Relay Signal הגיע למקסימום hops', { hops });
      return;
    }
    
    const myPubkey = App.publicKey || App.getEffectiveKeys?.()?.publicKey;
    
    // האם ה-signal מיועד לי?
    if (targetPubkey === myPubkey) {
      log('success', '📬 קיבלתי Relay Signal שמיועד לי', { from: originalSender.slice(0, 8) });
      // מעביר ל-handler הראשי של P2P
      if (App.handleRelayedSignal) {
        App.handleRelayedSignal(signal, originalSender, senderChannel);
      }
      return;
    }
    
    // האם אני מחובר ליעד?
    const targetChannel = state.activeChannels.get(targetPubkey);
    if (targetChannel && targetChannel.readyState === 'open') {
      // מעביר את ה-signal ליעד
      try {
        targetChannel.send(JSON.stringify({
          type: MESSAGE_TYPES.RELAY_SIGNAL,
          targetPubkey,
          signal,
          originalSender,
          timestamp,
          hops: hops + 1,
        }));
        
        state.stats.signalsForwarded++;
        log('info', '🔀 העברתי Relay Signal', { 
          from: originalSender.slice(0, 8), 
          to: targetPubkey.slice(0, 8),
          hops: hops + 1
        });
      } catch (err) {
        log('error', 'שגיאה בהעברת Relay Signal', { error: err.message });
      }
      return;
    }
    
    // לא מחובר ליעד - שומר בהמתנה
    if (!state.pendingRelaySignals.has(targetPubkey)) {
      state.pendingRelaySignals.set(targetPubkey, []);
    }
    
    const pending = state.pendingRelaySignals.get(targetPubkey);
    if (pending.length < RELAY_CONFIG.MAX_PENDING_SIGNALS) {
      pending.push({ signal, originalSender, timestamp, hops, senderPubkey });
      log('info', '💾 שמרתי Relay Signal בהמתנה', { 
        target: targetPubkey.slice(0, 8),
        pending: pending.length
      });
    }
  }
  
  /**
   * טיפול בתשובה שהגיעה דרך relay
   */
  function handleRelaySignalForward(msg, senderPubkey) {
    const { signal, originalTarget, timestamp } = msg;
    
    // בדיקת תוקף
    if (Date.now() - timestamp > RELAY_CONFIG.SIGNAL_TTL) {
      return;
    }
    
    log('success', '📨 קיבלתי תשובת Relay', { from: originalTarget?.slice(0, 8) });
    
    // מעביר ל-handler הראשי
    if (App.handleRelayedSignal) {
      App.handleRelayedSignal(signal, originalTarget, null);
    }
  }
  
  /**
   * כשמתחברים ל-peer חדש - בודקים אם יש signals בהמתנה עבורו
   */
  function flushPendingSignals(pubkey, channel) {
    const pending = state.pendingRelaySignals.get(pubkey);
    if (!pending || pending.length === 0) return;
    
    log('info', '📤 שולח signals שהמתינו', { target: pubkey.slice(0, 8), count: pending.length });
    
    pending.forEach(({ signal, originalSender, timestamp, hops }) => {
      if (Date.now() - timestamp > RELAY_CONFIG.SIGNAL_TTL) return;
      
      try {
        channel.send(JSON.stringify({
          type: MESSAGE_TYPES.RELAY_SIGNAL,
          targetPubkey: pubkey,
          signal,
          originalSender,
          timestamp,
          hops: hops + 1,
        }));
        state.stats.signalsForwarded++;
      } catch (err) {
        log('error', 'שגיאה בשליחת signal ממתין', { error: err.message });
      }
    });
    
    state.pendingRelaySignals.delete(pubkey);
  }
  
  /**
   * מציאת peer מתווך להגעה ליעד
   */
  function findRelayPeer(targetPubkey) {
    // מחפש peer מחובר שמכיר את היעד
    for (const [pubkey, channel] of state.activeChannels) {
      if (channel.readyState !== 'open') continue;
      
      const peerData = state.knownPeers.get(pubkey);
      if (!peerData) continue;
      
      // בודק אם ה-peer הזה מכיר את היעד (דרך peer exchange)
      // לעת עתה - מחזיר את ה-peer הראשון המחובר
      return pubkey;
    }
    
    return null;
  }
  
  /**
   * ניקוי signals ישנים
   */
  function cleanupPendingSignals() {
    const now = Date.now();
    
    state.pendingRelaySignals.forEach((signals, targetPubkey) => {
      const valid = signals.filter(s => now - s.timestamp < RELAY_CONFIG.SIGNAL_TTL);
      if (valid.length === 0) {
        state.pendingRelaySignals.delete(targetPubkey);
      } else if (valid.length < signals.length) {
        state.pendingRelaySignals.set(targetPubkey, valid);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // חיפוש קבצים
  // ═══════════════════════════════════════════════════════════════════════════
  
  /**
   * חיפוש peers שיש להם קובץ מסוים (ללא פנייה ל-Relay)
   */
  function findPeersWithFileLocally(hash) {
    if (!hash) return [];
    
    const locations = state.fileLocations.get(hash);
    if (!locations || locations.size === 0) return [];
    
    // מחזיר רק peers פעילים, ממוינים לפי lastSeen
    const now = Date.now();
    const activePeers = Array.from(locations)
      .map(pubkey => {
        const data = state.knownPeers.get(pubkey);
        return { pubkey, data };
      })
      .filter(p => p.data && (now - p.data.lastSeen < CONFIG.PEER_TTL))
      .sort((a, b) => {
        // מחוברים קודם
        if (a.data.isConnected && !b.data.isConnected) return -1;
        if (!a.data.isConnected && b.data.isConnected) return 1;
        // אחרי זה לפי lastSeen
        return b.data.lastSeen - a.data.lastSeen;
      })
      .map(p => p.pubkey);
    
    return activePeers;
  }

  /**
   * בדיקה אם יש לנו מידע על קובץ
   */
  function hasFileInfo(hash) {
    return state.fileLocations.has(hash) && state.fileLocations.get(hash).size > 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Exchange אוטומטי
  // ═══════════════════════════════════════════════════════════════════════════
  
  /**
   * שליחת Exchange request לכל ה-peers המחוברים
   */
  function broadcastExchangeRequest() {
    let sent = 0;
    
    state.activeChannels.forEach((channel, pubkey) => {
      if (channel.readyState === 'open') {
        sendPeerExchangeRequest(channel);
        sent++;
      }
    });
    
    if (sent > 0) {
      log('info', 'Broadcast Exchange request', { sentTo: sent });
    }
  }

  /**
   * התחלת Exchange אוטומטי
   */
  function startAutoExchange() {
    if (state.exchangeInterval) return;
    
    state.exchangeInterval = setInterval(() => {
      broadcastExchangeRequest();
    }, CONFIG.EXCHANGE_INTERVAL);
    
    log('info', 'התחלתי Auto Exchange', { interval: CONFIG.EXCHANGE_INTERVAL / 1000 + 's' });
  }

  /**
   * עצירת Exchange אוטומטי
   */
  function stopAutoExchange() {
    if (state.exchangeInterval) {
      clearInterval(state.exchangeInterval);
      state.exchangeInterval = null;
    }
  }

  /**
   * התחלת ניקוי אוטומטי
   */
  function startAutoCleanup() {
    if (state.cleanupInterval) return;
    
    state.cleanupInterval = setInterval(() => {
      cleanupOldPeers();
      // חלק Signal Relay (p2p-peer-exchange.js) – ניקוי signals ישנים | HYPER CORE TECH
      cleanupPendingSignals();
    }, CONFIG.CLEANUP_INTERVAL);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // סטטיסטיקות
  // ═══════════════════════════════════════════════════════════════════════════
  
  function getStats() {
    return {
      knownPeers: state.knownPeers.size,
      connectedPeers: state.activeChannels.size,
      fileLocations: state.fileLocations.size,
      ...state.stats,
    };
  }

  function printStats() {
    const stats = getStats();
    console.log('%c┌──────────────────────────────────────────────────┐', 'color: #9C27B0; font-weight: bold');
    console.log('%c│        📊 Peer Exchange Statistics               │', 'color: #9C27B0; font-weight: bold');
    console.log('%c├──────────────────────────────────────────────────┤', 'color: #9C27B0');
    console.log(`%c│ 👥 Known Peers: ${stats.knownPeers}`, 'color: #2196F3');
    console.log(`%c│ 🔗 Connected: ${stats.connectedPeers}`, 'color: #4CAF50');
    console.log(`%c│ 📁 File Locations: ${stats.fileLocations}`, 'color: #FF9800');
    console.log(`%c│ 📤 Exchanges Sent: ${stats.exchangesSent}`, 'color: #607D8B');
    console.log(`%c│ 📥 Exchanges Received: ${stats.exchangesReceived}`, 'color: #607D8B');
    console.log(`%c│ 🎓 Peers Learned: ${stats.peersLearned}`, 'color: #607D8B');
    console.log(`%c│ 📚 Files Learned: ${stats.filesLearned}`, 'color: #607D8B');
    console.log('%c├──────────────────────────────────────────────────┤', 'color: #9C27B0');
    console.log(`%c│ 📡 Signals Relayed: ${stats.signalsRelayed}`, 'color: #E91E63');
    console.log(`%c│ 🔀 Signals Forwarded: ${stats.signalsForwarded}`, 'color: #E91E63');
    console.log(`%c│ 💾 Pending Signals: ${state.pendingRelaySignals.size}`, 'color: #E91E63');
    console.log('%c└──────────────────────────────────────────────────┘', 'color: #9C27B0; font-weight: bold');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // אתחול
  // ═══════════════════════════════════════════════════════════════════════════
  
  function init() {
    log('info', 'מאתחל Peer Exchange מודול...');
    
    startAutoCleanup();
    startAutoExchange();
    
    log('success', 'Peer Exchange מודול מוכן!');
  }

  // אתחול כשהדף נטען
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // API ציבורי
  // ═══════════════════════════════════════════════════════════════════════════
  
  App.PeerExchange = {
    // ניהול peers
    registerPeer,
    markPeerConnected,
    markPeerDisconnected,
    
    // Peer Exchange
    sendPeerExchangeRequest,
    handleIncomingMessage,
    broadcastExchangeRequest,
    
    // חלק Signal Relay (p2p-peer-exchange.js) – API להעברת signals | HYPER CORE TECH
    sendRelaySignal,
    findRelayPeer,
    flushPendingSignals,
    
    // חיפוש
    findPeersWithFileLocally,
    hasFileInfo,
    
    // סטטיסטיקות
    getStats,
    printStats,
    
    // קונפיגורציה
    CONFIG,
    MESSAGE_TYPES,
    RELAY_CONFIG,
  };

  // פקודות קונסול
  window.peerExchange = {
    stats: printStats,
    peers: () => console.table([...state.knownPeers.entries()].map(([k, v]) => ({
      peer: k.slice(0, 12),
      files: v.files.size,
      lastSeen: new Date(v.lastSeen).toLocaleTimeString(),
      connected: v.isConnected,
    }))),
    files: () => console.table([...state.fileLocations.entries()].map(([hash, peers]) => ({
      hash: hash.slice(0, 16),
      peerCount: peers.size,
    }))),
    broadcast: broadcastExchangeRequest,
  };

  console.log('%c🔄 Peer Exchange מודול נטען - הקלד peerExchange.stats() לסטטיסטיקות', 'color: #9C27B0; font-weight: bold');

})(window);
