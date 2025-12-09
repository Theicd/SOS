/**
 * SOS-main Android Bridge
 * קובץ זה מחבר את SOS-main ל-SOS-Relay-Android
 * 
 * כאשר האפליקציה רצה בתוך WebView של Android,
 * הקובץ הזה מחליף את הריליים החיצוניים בתקשורת מקומית
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
  const BRIDGE_VERSION = '1.0.0';
  
  // === State ===
  const state = {
    isOffline: true,
    localIP: null,
    peers: [],
    pendingEvents: [],
    eventHandlers: new Map(), // kind -> [handlers]
  };
  
  // === אתחול ===
  function init() {
    state.localIP = AndroidBridge.getLocalIpAddress();
    state.isOffline = AndroidBridge.isOfflineMode();
    
    console.log(`📱 Android Bridge v${BRIDGE_VERSION}`);
    console.log(`📍 Local IP: ${state.localIP}`);
    console.log(`🔌 Offline mode: ${state.isOffline}`);
    
    // הפעל relay מקומי
    if (AndroidBridge.startLocalRelay()) {
      console.log('✅ Local relay started');
    }
    
    // רישום callbacks
    setupCallbacks();
    
    // החלפת פונקציות Nostr
    overrideNostrFunctions();
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
    getLocalIP: () => state.localIP,
    getPeers: () => [...state.peers],
    
    // שליחת הודעה לכל ה-peers
    broadcast: function(message) {
      if (isAndroidWebView) {
        AndroidBridge.broadcastMessage(JSON.stringify(message));
      }
    },
    
    // שליחת הודעה ל-peer ספציפי
    sendToPeer: function(ip, message) {
      if (isAndroidWebView) {
        AndroidBridge.sendToPeer(ip, JSON.stringify(message));
      }
    },
    
    // שליחת WebRTC signal
    sendSignal: function(target, signal) {
      if (isAndroidWebView) {
        AndroidBridge.sendWebRTCSignal(target, JSON.stringify(signal));
      }
    },
    
    // קבלת מידע על הרשת
    getNetworkInfo: function() {
      if (isAndroidWebView) {
        return JSON.parse(AndroidBridge.getNetworkInfo());
      }
      return null;
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
