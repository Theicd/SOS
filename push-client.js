// חלק Push (push-client.js) – מערכת הרשמה והתראות Push בצד הלקוח | HYPER CORE TECH
(function initPushClient(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק הגדרות (push-client.js) – קונפיגורציה של התראות Push | HYPER CORE TECH
  const PUSH_CONFIG = {
    // כתובת שרת Push - Vercel | HYPER CORE TECH
    serverUrl: localStorage.getItem('push_server_url') || 'https://sos-push-server.vercel.app',
    // מפתח VAPID ציבורי - נטען דינמית מהשרת
    vapidPublicKey: null,
    notificationDefaults: {
      icon: './icons/sos-logo.jpg',
      badge: './icons/sos-logo.jpg',
      vibrate: [200, 100, 200],
      requireInteraction: false,
    },
  };

  // חלק קבלת הגדרות מהשרת (push-client.js) – קבלת VAPID key מהשרת | HYPER CORE TECH
  async function fetchPushConfig() {
    if (!PUSH_CONFIG.serverUrl) {
      console.warn('[PUSH] לא הוגדר שרת Push - serverUrl ריק');
      return null;
    }
    
    try {
      const response = await fetch(`${PUSH_CONFIG.serverUrl}/api/push/config`);
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      
      const data = await response.json();
      if (data.ok && data.publicKey) {
        PUSH_CONFIG.vapidPublicKey = data.publicKey;
        console.log('[PUSH] התקבל מפתח VAPID מהשרת');
        return data.publicKey;
      }
      
      console.warn('[PUSH] השרת לא מוגדר כראוי:', data);
      return null;
    } catch (err) {
      console.error('[PUSH] שגיאה בקבלת הגדרות מהשרת:', err);
      return null;
    }
  }

  // חלק הגדרת שרת (push-client.js) – הגדרת כתובת שרת Push | HYPER CORE TECH
  function setPushServerUrl(url) {
    if (!url) return;
    PUSH_CONFIG.serverUrl = url.replace(/\/$/, ''); // הסרת / בסוף
    localStorage.setItem('push_server_url', PUSH_CONFIG.serverUrl);
    console.log('[PUSH] כתובת שרת נשמרה:', PUSH_CONFIG.serverUrl);
  }

  // חלק בדיקת תמיכה (push-client.js) – בודק תמיכה בהתראות Push | HYPER CORE TECH
  function isPushSupported() {
    return 'serviceWorker' in navigator && 
           'PushManager' in window && 
           'Notification' in window;
  }

  // חלק בדיקת iOS (push-client.js) – בדיקת תמיכה ב-iOS | HYPER CORE TECH
  function isIOSPwaRequired() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (!isIOS) return false;
    
    // ב-iOS, Push נתמך רק במצב standalone (PWA מותקנת)
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || 
                         navigator.standalone === true;
    return !isStandalone;
  }

  // חלק הרשאות (push-client.js) – בקשת הרשאת התראות | HYPER CORE TECH
  async function requestNotificationPermission() {
    // בדיקת תמיכה
    if (!('Notification' in window)) {
      console.warn('[PUSH] התראות לא נתמכות בדפדפן זה');
      return 'unsupported';
    }
    
    // בדיקת iOS
    if (isIOSPwaRequired()) {
      console.warn('[PUSH] iOS דורש התקנה כ-PWA לפני הפעלת התראות');
      return 'ios_install_required';
    }
    
    // בדיקת הרשאה קיימת
    if (Notification.permission === 'granted') {
      return 'granted';
    }
    
    if (Notification.permission === 'denied') {
      console.warn('[PUSH] המשתמש חסם התראות');
      return 'denied';
    }
    
    // בקשת הרשאה
    try {
      const permission = await Notification.requestPermission();
      console.log('[PUSH] תוצאת בקשת הרשאה:', permission);
      return permission;
    } catch (err) {
      console.error('[PUSH] שגיאה בבקשת הרשאה:', err);
      return 'error';
    }
  }

  // חלק המרת מפתח (push-client.js) – המרת מפתח VAPID לפורמט נכון | HYPER CORE TECH
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  // חלק רישום Push (push-client.js) – רישום למנוי Push | HYPER CORE TECH
  async function subscribeToPush(vapidPublicKey) {
    // בדיקת תמיכה
    if (!isPushSupported()) {
      console.warn('[PUSH] Push לא נתמך בדפדפן זה');
      return { success: false, error: 'unsupported' };
    }
    
    // בקשת הרשאות
    const permission = await requestNotificationPermission();
    if (permission !== 'granted') {
      return { success: false, error: permission };
    }
    
    try {
      // קבלת רישום Service Worker
      const registration = await navigator.serviceWorker.ready;
      
      // בדיקת מנוי קיים
      let subscription = await registration.pushManager.getSubscription();
      
      if (subscription) {
        console.log('[PUSH] כבר רשום למנוי Push');
        return { success: true, subscription, existing: true };
      }
      
      // יצירת מנוי חדש
      const publicKey = vapidPublicKey || PUSH_CONFIG.vapidPublicKey;
      if (!publicKey) {
        console.error('[PUSH] חסר מפתח VAPID ציבורי');
        return { success: false, error: 'missing_vapid_key' };
      }
      
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      
      console.log('[PUSH] נרשם למנוי Push בהצלחה');
      
      // שמירת המנוי בשרת (אם יש API)
      await saveSubscriptionToServer(subscription);
      
      return { success: true, subscription, existing: false };
    } catch (err) {
      console.error('[PUSH] שגיאה ברישום Push:', err);
      return { success: false, error: err.message };
    }
  }

  // חלק שמירה בשרת (push-client.js) – שמירת המנוי בשרת | HYPER CORE TECH
  async function saveSubscriptionToServer(subscription, forcePubkey) {
    // שמירה לוקלית תמיד
    try {
      const subscriptionData = JSON.stringify(subscription);
      localStorage.setItem('push_subscription', subscriptionData);
      console.log('[PUSH] מנוי נשמר לוקלית');
    } catch (err) {
      console.warn('[PUSH] שגיאה בשמירה לוקלית:', err);
    }
    
    // שליחה לשרת Push (אם מוגדר)
    if (!PUSH_CONFIG.serverUrl) {
      console.log('[PUSH] אין שרת Push - מנוי נשמר רק לוקלית');
      return;
    }
    
    try {
      // קבלת pubkey של המשתמש (Nostr) - עם fallbacks מרובים | HYPER CORE TECH
      const pubkey = forcePubkey || 
                     App.publicKey || 
                     localStorage.getItem('nostr_pubkey') || 
                     localStorage.getItem('sos_pubkey') ||
                     null;
      
      // שמירת ה-pubkey ל-localStorage אם קיים
      if (pubkey) {
        localStorage.setItem('sos_pubkey', pubkey);
      }
      
      const response = await fetch(`${PUSH_CONFIG.serverUrl}/api/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: subscription.toJSON ? subscription.toJSON() : subscription,
          pubkey,
        }),
      });
      
      const data = await response.json();
      if (data.ok) {
        console.log('[PUSH] מנוי נשמר בשרת, ID:', data.subscriptionId, 'pubkey:', pubkey?.slice(0, 8));
        // שמירת מזהה המנוי
        if (data.subscriptionId) {
          localStorage.setItem('push_subscription_id', data.subscriptionId);
        }
      } else {
        console.warn('[PUSH] שגיאה בשמירה בשרת:', data.error);
      }
    } catch (err) {
      console.error('[PUSH] שגיאה בשליחה לשרת:', err);
    }
  }
  
  // חלק עדכון מנוי (push-client.js) – עדכון המנוי בשרת כשהמשתמש מתחבר | HYPER CORE TECH
  async function updateSubscriptionWithPubkey(pubkey) {
    if (!pubkey || !PUSH_CONFIG.serverUrl) return;
    
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      
      if (subscription) {
        console.log('[PUSH] מעדכן מנוי עם pubkey:', pubkey.slice(0, 8));
        await saveSubscriptionToServer(subscription, pubkey);
      }
    } catch (err) {
      console.warn('[PUSH] שגיאה בעדכון מנוי:', err);
    }
  }

  // חלק הסרה מהשרת (push-client.js) – הסרת מנוי מהשרת | HYPER CORE TECH
  async function removeSubscriptionFromServer(endpoint) {
    if (!PUSH_CONFIG.serverUrl || !endpoint) return;
    
    try {
      const response = await fetch(`${PUSH_CONFIG.serverUrl}/api/push/subscribe`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      });
      
      const data = await response.json();
      console.log('[PUSH] מנוי הוסר מהשרת:', data.ok);
    } catch (err) {
      console.error('[PUSH] שגיאה בהסרה מהשרת:', err);
    }
  }

  // חלק בדיקת מנוי (push-client.js) – בדיקה אם יש מנוי פעיל | HYPER CORE TECH
  async function hasActiveSubscription() {
    if (!isPushSupported()) return false;
    
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      return !!subscription;
    } catch (err) {
      return false;
    }
  }

  // חלק ביטול מנוי (push-client.js) – ביטול מנוי Push | HYPER CORE TECH
  async function unsubscribeFromPush() {
    if (!isPushSupported()) return { success: false, error: 'unsupported' };
    
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      
      if (!subscription) {
        return { success: true, message: 'לא היה מנוי פעיל' };
      }
      
      // הסרה מהשרת
      await removeSubscriptionFromServer(subscription.endpoint);
      
      await subscription.unsubscribe();
      localStorage.removeItem('push_subscription');
      
      console.log('[PUSH] מנוי Push בוטל');
      return { success: true };
    } catch (err) {
      console.error('[PUSH] שגיאה בביטול מנוי:', err);
      return { success: false, error: err.message };
    }
  }

  // חלק הצגת התראה (push-client.js) – הצגת התראה לוקלית | HYPER CORE TECH
  async function showLocalNotification(title, options = {}) {
    const permission = await requestNotificationPermission();
    if (permission !== 'granted') {
      console.warn('[PUSH] אין הרשאה להציג התראות');
      return false;
    }
    
    try {
      const registration = await navigator.serviceWorker.ready;
      
      const notificationOptions = {
        ...PUSH_CONFIG.notificationDefaults,
        ...options,
        data: {
          url: options.url || './',
          type: options.type || 'general',
          ...options.data,
        },
      };
      
      await registration.showNotification(title, notificationOptions);
      console.log('[PUSH] התראה הוצגה:', title);
      return true;
    } catch (err) {
      console.error('[PUSH] שגיאה בהצגת התראה:', err);
      return false;
    }
  }

  // חלק התראות צ'אט (push-client.js) – התראה על הודעה חדשה בצ'אט | HYPER CORE TECH
  function showChatNotification(senderName, messagePreview, peerPubkey) {
    return showLocalNotification(`הודעה מ-${senderName}`, {
      body: messagePreview || 'הודעה חדשה',
      tag: `chat-${peerPubkey}`,
      renotify: true,
      type: 'chat-message',
      data: {
        type: 'chat-message',
        peerPubkey,
        url: `./videos.html?chat=${peerPubkey}`,
      },
    });
  }

  // חלק התראות שיחה (push-client.js) – התראה על שיחה נכנסת | HYPER CORE TECH
  function showCallNotification(callerName, callType, peerPubkey) {
    const isVideo = callType === 'video';
    return showLocalNotification(`שיחה ${isVideo ? 'וידאו' : 'קולית'} נכנסת`, {
      body: `${callerName} מתקשר אליך`,
      tag: `call-${peerPubkey}`,
      requireInteraction: true,
      type: isVideo ? 'video-call-incoming' : 'voice-call-incoming',
      data: {
        type: isVideo ? 'video-call-incoming' : 'voice-call-incoming',
        peerPubkey,
        url: './',
      },
    });
  }

  // חלק מודאל הרשמה (push-client.js) – מודאל משופר לבקשת הרשאה להתראות | HYPER CORE TECH
  // בהשראת VIPO – עם steps, הודעות iOS ברורות, ועיצוב מודרני
  function showPushPermissionModal(vapidPublicKey) {
    if (document.getElementById('push-permission-modal')) return;
    
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    
    const modal = document.createElement('div');
    modal.id = 'push-permission-modal';
    modal.innerHTML = `
      <div class="ppm-overlay"></div>
      <div class="ppm-content">
        <div class="ppm-step ppm-step--ask">
          <div class="ppm-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
            </svg>
          </div>
          <h3>התראות חכמות ל-SOS</h3>
          <p class="ppm-lead">קבל עדכונים חשובים ישירות למכשיר</p>
          <ul class="ppm-bullets">
            <li>🔔 הודעות צ'אט חדשות</li>
            <li>📞 שיחות נכנסות</li>
            <li>📰 פוסטים חדשים מאנשים שאתה עוקב</li>
          </ul>
          <div class="ppm-actions">
            <button type="button" class="ppm-btn ppm-btn--later">לא עכשיו</button>
            <button type="button" class="ppm-btn ppm-btn--enable">הפעל</button>
          </div>
        </div>
        <div class="ppm-step ppm-step--success" style="display:none">
          <div class="ppm-icon ppm-icon--success">✓</div>
          <p>מעולה! תקבל התראות לנייד</p>
        </div>
        <div class="ppm-step ppm-step--error" style="display:none">
          <div class="ppm-icon ppm-icon--error">⚠</div>
          <p class="ppm-error-msg"></p>
        </div>
      </div>
    `;
    
    // סגנונות inline - עיצוב מותאם לממשק הכהה של האפליקציה | HYPER CORE TECH
    const style = document.createElement('style');
    style.textContent = `
      #push-permission-modal{position:fixed;inset:0;z-index:100000;display:flex;align-items:flex-end;justify-content:center;padding:16px;padding-bottom:calc(16px + env(safe-area-inset-bottom,0px))}
      .ppm-overlay{position:absolute;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
      .ppm-content{position:relative;background:linear-gradient(135deg,#0a0a1a 0%,#1a1a2e 50%,#16213e 100%);border-radius:20px;padding:24px;max-width:380px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,0.5);direction:rtl;text-align:center;border:1px solid rgba(0,212,255,0.15)}
      .ppm-icon{width:64px;height:64px;margin:0 auto 16px;border-radius:16px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#00d4ff 0%,#00a8cc 100%);color:#000}
      .ppm-icon--success{background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;font-size:32px}
      .ppm-icon--error{background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;font-size:28px}
      .ppm-content h3{margin:0 0 8px;font-size:20px;font-weight:700;color:#fff}
      .ppm-lead{color:rgba(255,255,255,0.7);font-size:14px;margin:0 0 20px}
      .ppm-bullets{list-style:none;padding:0;margin:0 0 24px;text-align:right}
      .ppm-bullets li{padding:8px 0;font-size:14px;color:rgba(255,255,255,0.85);border-bottom:1px solid rgba(255,255,255,0.08)}
      .ppm-bullets li:last-child{border-bottom:none}
      .ppm-actions{display:flex;gap:12px}
      .ppm-btn{flex:1;padding:14px;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;border:none;transition:all 0.2s}
      .ppm-btn:active{transform:scale(0.97)}
      .ppm-btn--later{background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.8);border:1px solid rgba(255,255,255,0.2)}
      .ppm-btn--later:hover{background:rgba(255,255,255,0.15)}
      .ppm-btn--enable{background:linear-gradient(135deg,#00d4ff 0%,#00a8cc 100%);color:#000;font-weight:700;box-shadow:0 4px 16px rgba(0,212,255,0.3)}
      .ppm-btn--enable:hover{box-shadow:0 6px 20px rgba(0,212,255,0.4)}
      .ppm-step p{font-size:15px;color:#fff}
      .ppm-error-msg{color:#f87171}
    `;
    document.head.appendChild(style);
    
    const closeModal = () => modal.remove();
    
    modal.querySelector('.ppm-overlay').onclick = closeModal;
    modal.querySelector('.ppm-btn--later').onclick = () => {
      localStorage.setItem('push_modal_dismissed', Date.now().toString());
      closeModal();
    };
    
    modal.querySelector('.ppm-btn--enable').onclick = async () => {
      const askStep = modal.querySelector('.ppm-step--ask');
      const successStep = modal.querySelector('.ppm-step--success');
      const errorStep = modal.querySelector('.ppm-step--error');
      const errorMsg = modal.querySelector('.ppm-error-msg');
      
      // בדיקת iOS ללא התקנה
      if (isIOS && !isStandalone) {
        askStep.style.display = 'none';
        errorStep.style.display = 'block';
        errorMsg.textContent = 'ב-iPhone יש להוסיף את האתר למסך הבית תחילה (לחץ על כפתור השיתוף ← "הוסף למסך הבית")';
        setTimeout(closeModal, 5000);
        return;
      }
      
      const btn = modal.querySelector('.ppm-btn--enable');
      btn.textContent = '...';
      btn.disabled = true;
      
      const result = await subscribeToPush(vapidPublicKey);
      
      if (result.success) {
        askStep.style.display = 'none';
        successStep.style.display = 'block';
        localStorage.setItem('push_subscribed', 'true');
        localStorage.removeItem('push_modal_dismissed');
        window.dispatchEvent(new CustomEvent('push-subscription-changed', { detail: { subscribed: true } }));
        setTimeout(closeModal, 1500);
      } else {
        askStep.style.display = 'none';
        errorStep.style.display = 'block';
        
        // הודעות שגיאה מפורטות יותר | HYPER CORE TECH
        if (result.error === 'denied') {
          errorMsg.textContent = 'ההרשאה נדחתה. ניתן לשנות בהגדרות הדפדפן';
        } else if (result.error === 'unsupported') {
          errorMsg.textContent = 'התראות לא נתמכות במכשיר זה';
        } else if (result.error === 'missing_vapid_key') {
          errorMsg.textContent = 'שגיאת הגדרות שרת. נסה שוב מאוחר יותר';
        } else if (result.error && result.error.includes('ServiceWorker')) {
          errorMsg.textContent = 'שגיאת Service Worker. נסה לרענן את הדף';
        } else if (result.error && result.error.includes('network')) {
          errorMsg.textContent = 'שגיאת רשת. בדוק את החיבור לאינטרנט';
        } else {
          errorMsg.textContent = 'שגיאה בהפעלת התראות. נסה שוב מאוחר יותר';
          console.error('[PUSH] שגיאה לא מזוהה:', result.error);
        }
        
        localStorage.setItem('push_modal_dismissed', Date.now().toString());
        setTimeout(closeModal, 4000);
      }
    };
    
    document.body.appendChild(modal);
  }

  // חלק אתחול (push-client.js) – אתחול מערכת ההתראות | HYPER CORE TECH
  async function initPushNotifications(serverUrl) {
    if (!isPushSupported()) {
      console.log('[PUSH] Push לא נתמך');
      return;
    }
    
    // הגדרת שרת Push (אם סופק)
    if (serverUrl) {
      setPushServerUrl(serverUrl);
    }
    
    // קבלת מפתח VAPID מהשרת
    if (PUSH_CONFIG.serverUrl && !PUSH_CONFIG.vapidPublicKey) {
      await fetchPushConfig();
    }
    
    // בדיקה 1: אם כבר יש מנוי פעיל - לא מציגים מודאל
    const hasSubscription = await hasActiveSubscription();
    if (hasSubscription) {
      console.log('[PUSH] מנוי פעיל קיים');
      localStorage.setItem('push_subscribed', 'true');
      return;
    }
    
    // בדיקה 2: אם המשתמש כבר נתן הרשאה - ננסה להירשם אוטומטית בשקט
    if (Notification.permission === 'granted') {
      console.log('[PUSH] הרשאה כבר ניתנה - מנסה להירשם אוטומטית');
      const result = await subscribeToPush();
      if (result.success) {
        localStorage.setItem('push_subscribed', 'true');
      }
      return;
    }
    
    // בדיקה 3: אם המשתמש חסם התראות - לא מציגים מודאל
    if (Notification.permission === 'denied') {
      console.log('[PUSH] המשתמש חסם התראות - לא מציגים מודאל');
      return;
    }
    
    // בדיקה 4: אם המשתמש כבר נרשם בהצלחה בעבר - לא מציגים מודאל
    if (localStorage.getItem('push_subscribed') === 'true') {
      console.log('[PUSH] המשתמש כבר נרשם בעבר');
      return;
    }
    
    // בדיקה 5: אם המשתמש דחה את המודאל לאחרונה (7 ימים)
    const dismissed = localStorage.getItem('push_modal_dismissed');
    if (dismissed) {
      const daysSinceDismissed = (Date.now() - parseInt(dismissed, 10)) / (1000 * 60 * 60 * 24);
      if (daysSinceDismissed < 7) {
        console.log('[PUSH] המשתמש דחה את המודאל לאחרונה');
        return;
      }
    }
    
    // הצגת מודאל בקשת הרשאה (אחרי השהייה) | HYPER CORE TECH
    setTimeout(() => {
      // בדיקה נוספת - וודא שלא נרשמו בינתיים
      if (localStorage.getItem('push_subscribed') === 'true') {
        console.log('[PUSH] כבר רשום - לא מציג מודאל');
        return;
      }
      if (Notification.permission !== 'default') {
        console.log('[PUSH] הרשאה כבר נקבעה:', Notification.permission);
        return;
      }
      
      // הצגת המודאל גם למשתמשים לא מחוברים (אורחים) | HYPER CORE TECH
      console.log('[PUSH] מציג מודאל הרשאות');
      showPushPermissionModal();
    }, 8000); // 8 שניות אחרי טעינת הדף
  }

  // חשיפת API ציבורי
  Object.assign(App, {
    isPushSupported,
    requestNotificationPermission,
    subscribeToPush,
    unsubscribeFromPush,
    hasActiveSubscription,
    showLocalNotification,
    showChatNotification,
    showCallNotification,
    showPushPermissionModal,
    initPushNotifications,
    setPushServerUrl,
    fetchPushConfig,
    updateSubscriptionWithPubkey, // עדכון מנוי כשהמשתמש מתחבר | HYPER CORE TECH
    PUSH_CONFIG, // חשיפת הקונפיג לצורך בדיקה/עדכון
  });

  // אתחול כשהדף מוכן
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      // אתחול אוטומטי אחרי 5 שניות
      setTimeout(initPushNotifications, 5000);
    });
  } else {
    setTimeout(initPushNotifications, 5000);
  }
})(window);
