/**
 * SOS-main Android Bridge
 * קובץ זה מחבר את SOS-main ל-SOS-Relay-Android
 * 
 * כאשר האפליקציה רצה בתוך WebView של Android,
 * הקובץ הזה מחליף את הריליים החיצוניים בתקשורת מקומית
 * 
 * גרסה: 2.0.0 - תמיכה ברשת חירום (Emergency Relay Network)
 * תאריך: דצמבר 2025
 */

(function initAndroidBridge(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  
  // בדיקה אם אנחנו בתוך Android WebView
  const isAndroidWebView = typeof AndroidBridge !== 'undefined';
  
  if (!isAndroidWebView) {
    console.log('🌐 Not in Android WebView - using normal relays');
    return;
  }
  
  console.log('📱 Android WebView detected - initializing local relay mode');
  
  // === הגדרות ===
  const LOCAL_RELAY_PORT = 9000;
  const BRIDGE_VERSION = '2.0.0';
  const PEER_UPDATE_INTERVAL = 5000; // עדכון peers כל 5 שניות
  
  // === State ===
  const state = {
    isOffline: true,
    isEmergencyMode: false,  // מצב חירום - רשת ממסרים פעילה
    localIP: null,
    parentIP: null,           // הורה ברשת הממסרים
    peers: [],                // peers מהממסרים
    relayPeers: [],           // peers עם מידע מלא מהממסרים
    pendingEvents: [],
    eventHandlers: new Map(), // kind -> [handlers]
    peerUpdateInterval: null,
  };
  
  // === אתחול ===
  function init() {
    state.localIP = AndroidBridge.getLocalIpAddress();
    state.isOffline = AndroidBridge.isOfflineMode();
    
    // בדיקת מצב רשת חירום
    checkEmergencyNetwork();
    
    console.log(`📱 Android Bridge v${BRIDGE_VERSION}`);
    console.log(`📍 Local IP: ${state.localIP}`);
    console.log(`🔌 Offline mode: ${state.isOffline}`);
    console.log(`🚨 Emergency mode: ${state.isEmergencyMode}`);
    
    // הפעל relay מקומי
    if (AndroidBridge.startLocalRelay()) {
      console.log('✅ Local relay started');
    }
    
    // רישום callbacks
    setupCallbacks();
    
    // החלפת פונקציות Nostr
    overrideNostrFunctions();
    
    // התחל עדכון peers מחזורי
    startPeerUpdates();
  }
  
  // === בדיקת רשת חירום ===
  function checkEmergencyNetwork() {
    try {
      if (typeof AndroidBridge.isRelayNetworkActive === 'function') {
        state.isEmergencyMode = AndroidBridge.isRelayNetworkActive();
      }
      
      if (typeof AndroidBridge.getEmergencyNetworkStatus === 'function') {
        const statusJson = AndroidBridge.getEmergencyNetworkStatus();
        const status = JSON.parse(statusJson);
        state.isEmergencyMode = status.isActive;
        state.parentIP = status.parentIp || null;
        state.peers = status.peers || [];
        console.log('🚨 Emergency network status:', status);
      }
    } catch (e) {
      console.warn('Failed to check emergency network:', e);
    }
  }
  
  // === עדכון peers מחזורי ===
  function startPeerUpdates() {
    if (state.peerUpdateInterval) {
      clearInterval(state.peerUpdateInterval);
    }
    
    state.peerUpdateInterval = setInterval(() => {
      updatePeersFromRelay();
    }, PEER_UPDATE_INTERVAL);
    
    // עדכון ראשוני
    updatePeersFromRelay();
  }
  
  // === קבלת peers מהממסרים ===
  function updatePeersFromRelay() {
    try {
      if (typeof AndroidBridge.getRelayPeers !== 'function') return;
      
      const peersJson = AndroidBridge.getRelayPeers();
      const peers = JSON.parse(peersJson);
      
      if (!Array.isArray(peers)) return;
      
      // עדכון state
      state.relayPeers = peers;
      state.peers = peers.map(p => p.ip || p);
      
      // עדכון מערכת PeerExchange
      if (App.PeerExchange && App.PeerExchange.registerPeer) {
        peers.forEach(peer => {
          const ip = peer.ip || peer;
          App.PeerExchange.registerPeer(ip, [], Date.now());
        });
      }
      
      if (peers.length > 0) {
        console.log(`📡 Updated ${peers.length} peers from relay network`);
      }
    } catch (e) {
      // שקט - לא כל גרסה תומכת
    }
  }
  
  // === Callbacks מ-Android ===
  function setupCallbacks() {
    window.SOSBridge = window.SOSBridge || {};
    
    // קבלת Nostr event
    window.SOSBridge.onNostrEvent = function(event) {
      console.log('📥 Received Nostr event:', event.kind);
      handleIncomingEvent(event);
    };
    
    // קבלת WebRTC signal
    window.SOSBridge.onWebRTCSignal = function(fromIp, signal) {
      console.log('📡 Received WebRTC signal from:', fromIp);
      handleWebRTCSignal(fromIp, signal);
    };
    
    // קבלת הודעת צ'אט
    window.SOSBridge.onChatMessage = function(fromIp, message) {
      console.log('💬 Received chat from:', fromIp);
      handleChatMessage(fromIp, message);
    };
    
    // peer חדש התחבר
    window.SOSBridge.onPeerConnected = function(ip) {
      console.log('🤝 Peer connected:', ip);
      if (!state.peers.includes(ip)) {
        state.peers.push(ip);
      }
      // עדכן את מערכת ה-P2P
      if (App.PeerExchange && App.PeerExchange.registerPeer) {
        App.PeerExchange.registerPeer(ip, [], Date.now());
      }
    };
    
    // peer התנתק
    window.SOSBridge.onPeerDisconnected = function(ip) {
      console.log('👋 Peer disconnected:', ip);
      state.peers = state.peers.filter(p => p !== ip);
    };
    
    // === חדש: עדכון רשת חירום ===
    window.SOSBridge.onNetworkUpdate = function(status) {
      console.log('🚨 Emergency network update:', status);
      
      // עדכון state
      state.isEmergencyMode = status.isActive;
      state.parentIP = status.parentIp || null;
      
      // עדכון peers
      if (Array.isArray(status.peers)) {
        const oldCount = state.peers.length;
        state.peers = status.peers;
        
        // רשום peers חדשים במערכת PeerExchange
        if (App.PeerExchange && App.PeerExchange.registerPeer) {
          status.peers.forEach(ip => {
            App.PeerExchange.registerPeer(ip, [], Date.now());
          });
        }
        
        if (status.peers.length !== oldCount) {
          console.log(`📡 Peers updated: ${oldCount} -> ${status.peers.length}`);
        }
      }
      
      // עדכן UI אם צריך
      if (App.updateNetworkStatus) {
        App.updateNetworkStatus(status);
      }
    };
    
    // קבלת הודעה כללית
    window.SOSBridge.onMessage = function(fromIp, message) {
      console.log('📨 Message from:', fromIp, message);
      handleP2PMessage(fromIp, message);
    };
    
    // הודעה גולמית
    window.SOSBridge.onRawMessage = function(fromIp, text) {
      console.log('📝 Raw message from:', fromIp, text);
    };
  }
  
  // === טיפול בהודעות P2P ===
  function handleP2PMessage(fromIp, message) {
    if (!message) return;
    
    const type = message.type || '';
    
    switch (type) {
      case 'post':
        // פוסט חדש מהרשת המקומית
        if (App.feed && App.feed.addLocalPost) {
          App.feed.addLocalPost(message);
        }
        break;
        
      case 'chat':
        handleChatMessage(fromIp, message);
        break;
        
      case 'nostr_event':
        if (message.event) {
          handleIncomingEvent(message.event);
        }
        break;
        
      case 'webrtc_signal':
        if (message.signal) {
          handleWebRTCSignal(fromIp, message.signal);
        }
        break;
        
      default:
        // הודעה לא מוכרת - נסה להעביר ל-handlers
        handleIncomingEvent(message);
    }
  }
  
  // === החלפת פונקציות Nostr ===
  function overrideNostrFunctions() {
    // שמירת הפונקציות המקוריות
    const originalPool = App.pool;
    
    // יצירת pool מקומי
    App.localPool = {
      publish: async function(relays, event) {
        console.log('📤 Publishing event locally:', event.kind);
        AndroidBridge.publishNostrEvent(JSON.stringify(event));
        return [{ ok: true }];
      },
      
      subscribeMany: function(relays, filters, callbacks) {
        console.log('📋 Subscribing to events:', filters);
        
        // רישום handlers
        filters.forEach(filter => {
          if (filter.kinds) {
            filter.kinds.forEach(kind => {
              if (!state.eventHandlers.has(kind)) {
                state.eventHandlers.set(kind, []);
              }
              state.eventHandlers.get(kind).push(callbacks);
            });
          }
        });
        
        // החזר subscription object
        return {
          close: () => {
            console.log('🔒 Subscription closed');
          }
        };
      },
      
      close: function() {
        console.log('🔌 Pool closed');
      }
    };
    
    // במצב offline, השתמש ב-pool המקומי
    if (state.isOffline) {
      App.pool = App.localPool;
      console.log('✅ Using local pool for offline mode');
    }
  }
  
  // === טיפול באירועים נכנסים ===
  function handleIncomingEvent(event) {
    const handlers = state.eventHandlers.get(event.kind) || [];
    handlers.forEach(callbacks => {
      if (callbacks.onevent) {
        callbacks.onevent(event);
      }
    });
  }
  
  // === טיפול ב-WebRTC signals ===
  function handleWebRTCSignal(fromIp, signal) {
    // העבר ל-P2P module
    if (App.P2PVideoSharing && App.P2PVideoSharing.handleSignal) {
      App.P2PVideoSharing.handleSignal(fromIp, signal);
    }
  }
  
  // === טיפול בהודעות צ'אט ===
  function handleChatMessage(fromIp, message) {
    // העבר ל-Chat module
    if (App.chatState && App.chatState.handleIncomingMessage) {
      App.chatState.handleIncomingMessage(message);
    }
  }
  
  // === API ציבורי ===
  App.AndroidBridge = {
    isAvailable: () => isAndroidWebView,
    isOffline: () => state.isOffline,
    isEmergencyMode: () => state.isEmergencyMode,
    getLocalIP: () => state.localIP,
    getParentIP: () => state.parentIP,
    getPeers: () => [...state.peers],
    getRelayPeers: () => [...state.relayPeers],
    
    // בדיקה האם להשתמש ברשת חירום
    shouldUseEmergencyNetwork: function() {
      return isAndroidWebView && state.isEmergencyMode && state.peers.length > 0;
    },
    
    // שליחת הודעה לכל ה-peers
    broadcast: function(message) {
      if (!isAndroidWebView) return false;
      
      try {
        const msgJson = typeof message === 'string' ? message : JSON.stringify(message);
        
        // נסה קודם את ה-API החדש
        if (typeof AndroidBridge.sendP2PMessage === 'function') {
          return AndroidBridge.sendP2PMessage(msgJson);
        }
        
        // fallback ל-API הישן
        if (typeof AndroidBridge.broadcastMessage === 'function') {
          AndroidBridge.broadcastMessage(msgJson);
          return true;
        }
      } catch (e) {
        console.error('Broadcast failed:', e);
      }
      return false;
    },
    
    // שליחת הודעה ל-peer ספציפי
    sendToPeer: function(ip, message) {
      if (!isAndroidWebView) return false;
      
      try {
        const msgJson = typeof message === 'string' ? message : JSON.stringify(message);
        AndroidBridge.sendToPeer(ip, msgJson);
        return true;
      } catch (e) {
        console.error('SendToPeer failed:', e);
        return false;
      }
    },
    
    // שליחת WebRTC signal
    sendSignal: function(target, signal) {
      if (!isAndroidWebView) return false;
      
      try {
        const signalJson = typeof signal === 'string' ? signal : JSON.stringify(signal);
        AndroidBridge.sendWebRTCSignal(target, signalJson);
        return true;
      } catch (e) {
        console.error('SendSignal failed:', e);
        return false;
      }
    },
    
    // קבלת מידע על הרשת
    getNetworkInfo: function() {
      if (!isAndroidWebView) return null;
      
      try {
        // נסה קודם את ה-API החדש
        if (typeof AndroidBridge.getEmergencyNetworkStatus === 'function') {
          return JSON.parse(AndroidBridge.getEmergencyNetworkStatus());
        }
        
        // fallback
        if (typeof AndroidBridge.getNetworkInfo === 'function') {
          return JSON.parse(AndroidBridge.getNetworkInfo());
        }
      } catch (e) {
        console.error('GetNetworkInfo failed:', e);
      }
      return null;
    },
    
    // פרסום אירוע Nostr לרשת המקומית
    publishNostrEvent: function(event) {
      if (!isAndroidWebView) return false;
      
      try {
        const eventJson = typeof event === 'string' ? event : JSON.stringify(event);
        return AndroidBridge.publishNostrEvent(eventJson);
      } catch (e) {
        console.error('PublishNostrEvent failed:', e);
        return false;
      }
    },
    
    // בקשת עדכון peers
    requestPeerUpdate: function() {
      if (isAndroidWebView && typeof AndroidBridge.requestPeerUpdate === 'function') {
        AndroidBridge.requestPeerUpdate();
      }
    },
    
    // פתיחת הגדרות חירום
    openEmergencySettings: function() {
      if (isAndroidWebView && typeof AndroidBridge.openEmergencySettings === 'function') {
        AndroidBridge.openEmergencySettings();
      }
    }
  };
  
  // === אתחול ===
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
  // === חיבור ל-OfflineStorage ===
  function hookOfflineStorage() {
    if (!App.OfflineStorage) {
      setTimeout(hookOfflineStorage, 500);
      return;
    }
    
    console.log('📦 Connecting Android Bridge to Offline Storage');
    
    // שמור כל אירוע שמגיע
    const originalOnevent = state.eventHandlers;
    window.SOSBridge.onNostrEvent = function(event) {
      // שמור ב-IndexedDB
      if (App.OfflineStorage && App.OfflineStorage.saveEvent) {
        App.OfflineStorage.saveEvent(event);
      }
      // העבר ל-handlers
      handleIncomingEvent(event);
    };
    
    // במצב offline, טען נתונים מקומיים
    if (state.isOffline && App.OfflineStorage.loadOfflineData) {
      App.OfflineStorage.loadOfflineData().then(function(data) {
        console.log('📴 Loaded offline data:', data.events?.length || 0, 'events');
      });
    }
  }
  
  // הפעל חיבור ל-OfflineStorage אחרי אתחול
  setTimeout(hookOfflineStorage, 1000);
  
})(window);
