// שירות ליצירת רשת תקשורת מקומית באמצעות Hotspot ב-Android
(function initWifiDirectService(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // בדיקה אם אנחנו בסביבת Android
  const isAndroid = /Android/i.test(navigator.userAgent);
  
  if (!isAndroid) {
    console.warn('רשת Hotspot פועלת רק באנדרואיד');
    return;
  }

  // מצב רשת
  const NetworkState = {
    DISCONNECTED: 0,
    CONNECTING: 1,
    CONNECTED: 2,
    ERROR: 3
  };

  let currentState = NetworkState.DISCONNECTED;
  let peers = [];
  let isRelay = false;
  const hotspotName = 'SOS-EMERGENCY-NET';
  const hotspotPassword = 'sos12345';

  // הפיכת הטלפון לממסר תקשורת (פתיחת Hotspot)
  async function enableRelayMode() {
    if (currentState === NetworkState.CONNECTED) return true;
    
    try {
      currentState = NetworkState.CONNECTING;
      
      // הדמיית פתיחת Hotspot (בפועל דורש הרשאות מיוחדות)
      console.log(`הפיכת הטלפון לממסר תקשורת...\nשם רשת: ${hotspotName}\nסיסמה: ${hotspotPassword}`);
      
      // מצב ממסר פעיל
      isRelay = true;
      currentState = NetworkState.CONNECTED;
      
      // סריקת מכשירים מחוברים כל 10 שניות
      setInterval(scanConnectedDevices, 10000);
      
      return true;
    } catch (err) {
      currentState = NetworkState.ERROR;
      console.error('שגיאה בהפיכת הטלפון לממסר:', err);
      return false;
    }
  }

  // חיבור לרשת Hotspot קיימת
  async function connectToRelay(ssid, password) {
    if (currentState === NetworkState.CONNECTED) return true;
    
    try {
      currentState = NetworkState.CONNECTING;
      
      // הדמיית חיבור ל-Hotspot
      console.log(`מתחבר לרשת ממסר: ${ssid}`);
      
      // מצב לקוח (לא ממסר)
      isRelay = false;
      currentState = NetworkState.CONNECTED;
      
      // סריקת מכשירים ברשת
      scanConnectedDevices();
      
      return true;
    } catch (err) {
      currentState = NetworkState.ERROR;
      console.error('שגיאה בחיבור לרשת ממסר:', err);
      return false;
    }
  }

  // סריקת מכשירים מחוברים לרשת
  function scanConnectedDevices() {
    // בדיקה אם אנחנו ברשת
    if (currentState !== NetworkState.CONNECTED) return;
    
    // הדמיית גילוי מכשירים ברשת המקומית
    console.log('סורק מכשירים ברשת המקומית...');
    
    // יצירת רשימת מכשירים מדומה
    const newPeers = [
      { id: 'device1', name: 'מכשיר 1', ip: '192.168.1.2', lastSeen: Date.now() },
      { id: 'device2', name: 'מכשיר 2', ip: '192.168.1.3', lastSeen: Date.now() },
      { id: 'device3', name: 'מכשיר 3', ip: '192.168.1.4', lastSeen: Date.now() }
    ];
    
    peers = newPeers;
    return peers;
  }

  // שליחת הודעה למכשיר ספציפי ברשת
  async function sendMessageToDevice(deviceId, message) {
    const device = peers.find(d => d.id === deviceId);
    if (!device) {
      console.error('מכשיר לא נמצא ברשת');
      return false;
    }
    
    // הדמיית שליחת הודעה
    console.log(`שולח הודעה למכשיר ${device.name}: ${message}`);
    return true;
  }

  // שידור הודעה לכל המכשירים ברשת
  async function broadcastMessage(message) {
    if (peers.length === 0) {
      console.log('אין מכשירים מחוברים להעברת הודעה');
      return false;
    }
    
    // הדמיית שידור
    console.log(`משדר הודעה ל-${peers.length} מכשירים: ${message}`);
    return true;
  }

  // אקספורט הפונקציות לשימוש חיצוני
  App.WifiDirectService = {
    enableRelayMode,
    connectToRelay,
    scanConnectedDevices,
    sendMessageToDevice,
    broadcastMessage,
    getState: () => currentState,
    getPeers: () => peers,
    isRelay: () => isRelay,
    getNetworkName: () => hotspotName,
    getNetworkPassword: () => hotspotPassword
  };
})(window);
