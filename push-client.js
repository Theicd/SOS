// חלק Push (push-client.js) – מערכת הרשמה והתראות Push בצד הלקוח | HYPER CORE TECH
(function initPushClient(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק הגדרות (push-client.js) – קונפיגורציה של התראות Push | HYPER CORE TECH
  const PUSH_CONFIG = {
    // מפתח VAPID ציבורי - יש להחליף במפתח אמיתי מהשרת
    // ניתן לייצר עם: npx web-push generate-vapid-keys
    vapidPublicKey: null, // יוגדר דינמית מהשרת או מ-config
    notificationDefaults: {
      icon: './icons/sos-logo.jpg',
      badge: './icons/sos-logo.jpg',
      vibrate: [200, 100, 200],
      requireInteraction: false,
    },
  };

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
  async function saveSubscriptionToServer(subscription) {
    // כרגע אין שרת Push - שומרים לוקלית
    // בעתיד: לשלוח לשרת לשמירה במסד נתונים
    try {
      const subscriptionData = JSON.stringify(subscription);
      localStorage.setItem('push_subscription', subscriptionData);
      console.log('[PUSH] מנוי נשמר לוקלית');
      
      // אם יש פונקציית שליחה לשרת
      if (typeof App.sendPushSubscriptionToServer === 'function') {
        await App.sendPushSubscriptionToServer(subscription);
      }
    } catch (err) {
      console.warn('[PUSH] שגיאה בשמירת מנוי:', err);
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

  // חלק מודאל הרשמה (push-client.js) – מודאל לבקשת הרשאה להתראות | HYPER CORE TECH
  function showPushPermissionModal(vapidPublicKey) {
    const existingModal = document.getElementById('push-permission-modal');
    if (existingModal) {
      existingModal.showModal?.() || (existingModal.style.display = 'flex');
      return;
    }
    
    const modal = document.createElement('dialog');
    modal.id = 'push-permission-modal';
    modal.className = 'push-permission-modal';
    modal.innerHTML = `
      <div class="push-permission-modal__content">
        <div class="push-permission-modal__icon">🔔</div>
        <h2>קבל התראות על הודעות חדשות</h2>
        <p>הפעל התראות כדי לדעת מיד כשמישהו שולח לך הודעה, גם כשהאפליקציה סגורה.</p>
        <div class="push-permission-modal__actions">
          <button type="button" class="push-permission-modal__later">אולי אחר כך</button>
          <button type="button" class="push-permission-modal__enable">הפעל התראות</button>
        </div>
      </div>
    `;
    
    modal.querySelector('.push-permission-modal__later').addEventListener('click', () => {
      modal.close?.() || (modal.style.display = 'none');
      localStorage.setItem('push_modal_dismissed', Date.now().toString());
    });
    
    modal.querySelector('.push-permission-modal__enable').addEventListener('click', async () => {
      const result = await subscribeToPush(vapidPublicKey);
      modal.close?.() || (modal.style.display = 'none');
      
      if (result.success) {
        if (typeof App.showToast === 'function') {
          App.showToast('התראות הופעלו בהצלחה! 🔔');
        }
      } else if (result.error === 'denied') {
        if (typeof App.showToast === 'function') {
          App.showToast('ההתראות נחסמו. ניתן לשנות בהגדרות הדפדפן.');
        }
      }
    });
    
    document.body.appendChild(modal);
    modal.showModal?.() || (modal.style.display = 'flex');
  }

  // חלק אתחול (push-client.js) – אתחול מערכת ההתראות | HYPER CORE TECH
  async function initPushNotifications() {
    if (!isPushSupported()) {
      console.log('[PUSH] Push לא נתמך');
      return;
    }
    
    // בדיקה אם כבר יש מנוי פעיל
    const hasSubscription = await hasActiveSubscription();
    if (hasSubscription) {
      console.log('[PUSH] מנוי פעיל קיים');
      return;
    }
    
    // בדיקה אם המשתמש דחה את המודאל לאחרונה
    const dismissed = localStorage.getItem('push_modal_dismissed');
    if (dismissed) {
      const daysSinceDismissed = (Date.now() - parseInt(dismissed, 10)) / (1000 * 60 * 60 * 24);
      if (daysSinceDismissed < 7) {
        console.log('[PUSH] המשתמש דחה את המודאל לאחרונה');
        return;
      }
    }
    
    // הצגת מודאל בקשת הרשאה (אחרי השהייה)
    setTimeout(() => {
      // רק אם המשתמש מחובר
      if (App.publicKey || App.isLoggedIn) {
        showPushPermissionModal();
      }
    }, 10000); // 10 שניות אחרי טעינת הדף
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
