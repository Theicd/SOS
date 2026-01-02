// חלק Push Trigger (push-trigger.js) – שליחת התראות Push כשמגיעות הודעות/שיחות | HYPER CORE TECH
// קובץ זה מחבר את מערכת הצ'אט והשיחות לשרת ה-Push
(function initPushTrigger(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק הגדרות (push-trigger.js) – כתובת שרת Push | HYPER CORE TECH
  const PUSH_SERVER_URL = 'https://sos-push-server.vercel.app';
  const DEFAULT_ICON = './icons/sos-logo.jpg';

  // חלק קאש אנשי קשר (push-trigger.js) – קבלת מידע על איש קשר מקאש | HYPER CORE TECH
  function getCachedContactInfo(pubkey) {
    if (!pubkey) return { name: 'משתמש', picture: DEFAULT_ICON };
    
    const normalizedPubkey = pubkey.toLowerCase();
    let name = 'משתמש';
    let picture = DEFAULT_ICON;
    
    try {
      // ניסיון 1: מ-chatState.contacts (מקור ראשי)
      const contact = App.chatState?.contacts?.get?.(normalizedPubkey);
      if (contact) {
        if (contact.name) name = contact.name;
        if (contact.picture) picture = contact.picture;
      }
      
      // ניסיון 2: מ-localStorage קאש פרופילים (fallback)
      if (name === 'משתמש' || picture === DEFAULT_ICON) {
        const profileKey = `nostr_profile_${normalizedPubkey}`;
        const cached = localStorage.getItem(profileKey);
        if (cached) {
          try {
            const profile = JSON.parse(cached);
            if (profile.name && name === 'משתמש') name = profile.name;
            if (profile.picture && picture === DEFAULT_ICON) picture = profile.picture;
          } catch {}
        }
      }
      
      // ניסיון 3: קאש אווטר DataURL (לתמונה מקומית)
      if (picture && picture !== DEFAULT_ICON) {
        const avatarKey = `avatar_cache_${btoa(picture)}`;
        try {
          const avatarCache = localStorage.getItem(avatarKey);
          if (avatarCache) {
            const parsed = JSON.parse(avatarCache);
            if (parsed?.dataUrl) {
              picture = parsed.dataUrl; // תמונה ב-base64 - עובדת גם offline
            }
          }
        } catch {}
      }
    } catch (err) {
      console.warn('[PUSH-TRIGGER] שגיאה בקבלת מידע איש קשר:', err);
    }
    
    return { name, picture };
  }

  // חלק בדיקת פוקוס (push-trigger.js) – בודק אם המשתמש צופה בדף | HYPER CORE TECH
  function isUserActive() {
    // אם הדף נסתר או לא בפוקוס - המשתמש לא פעיל
    if (document.hidden) return false;
    if (!document.hasFocus()) return false;
    return true;
  }

  // חלק בדיקת צ'אט פתוח (push-trigger.js) – בודק אם הצ'אט עם המשתמש הספציפי פתוח | HYPER CORE TECH
  function isChatOpenWith(peerPubkey) {
    try {
      // בדיקה אם יש צ'אט פתוח עם הפיר הזה
      const activeChatPeer = App.chatState?.activePeer || App.activeChatPeer;
      if (activeChatPeer && activeChatPeer.toLowerCase() === peerPubkey.toLowerCase()) {
        return true;
      }
      // בדיקה דרך URL
      const url = new URL(window.location.href);
      const chatParam = url.searchParams.get('chat');
      if (chatParam && chatParam.toLowerCase() === peerPubkey.toLowerCase()) {
        return true;
      }
    } catch {}
    return false;
  }

  // חלק שליחת Push (push-trigger.js) – שליחה לשרת Push | HYPER CORE TECH
  async function sendPushToServer(targetPubkey, payload) {
    if (!targetPubkey || !payload) return;
    
    try {
      const response = await fetch(`${PUSH_SERVER_URL}/api/push/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey: targetPubkey,
          payload,
        }),
      });
      
      const data = await response.json();
      if (data.ok) {
        console.log('[PUSH-TRIGGER] נשלחה התראה ל:', targetPubkey.slice(0, 8), 'sent:', data.sent);
      } else {
        console.log('[PUSH-TRIGGER] לא נשלחה התראה:', data.error || 'no subscriptions');
      }
    } catch (err) {
      console.error('[PUSH-TRIGGER] שגיאה בשליחת Push:', err);
    }
  }

  // חלק הודעת צ'אט (push-trigger.js) – שליחת Push כשמתקבלת הודעת צ'אט/קולית | HYPER CORE TECH
  async function triggerChatMessagePush(message) {
    // לא שולחים Push אם המשתמש פעיל וצופה בצ'אט
    if (isUserActive() && isChatOpenWith(message.from)) {
      console.log('[PUSH-TRIGGER] המשתמש צופה בצ\'אט - לא שולחים Push');
      return;
    }
    
    // לא שולחים Push להודעות יוצאות (שלי)
    if (message.direction === 'outgoing') {
      return;
    }
    
    // קבלת שם ותמונת השולח מקאש
    const contactInfo = getCachedContactInfo(message.from);
    
    // זיהוי סוג ההודעה (טקסט/קובץ/הודעה קולית)
    let body = 'הודעה חדשה';
    let messageType = 'text';
    
    if (message.attachment) {
      const att = message.attachment;
      if (att.type === 'audio' || att.mimeType?.startsWith('audio/')) {
        body = '🎤 הודעה קולית';
        messageType = 'voice-message';
      } else if (att.type === 'image' || att.mimeType?.startsWith('image/')) {
        body = '📷 תמונה';
        messageType = 'image';
      } else if (att.type === 'video' || att.mimeType?.startsWith('video/')) {
        body = '🎬 וידאו';
        messageType = 'video';
      } else {
        body = '📎 קובץ מצורף';
        messageType = 'file';
      }
    } else if (message.content) {
      body = message.content.length > 100 ? message.content.slice(0, 100) + '...' : message.content;
    }
    
    // שליחת Push לעצמי (לכל המכשירים שלי)
    const myPubkey = App.publicKey;
    if (!myPubkey) return;
    
    await sendPushToServer(myPubkey, {
      title: `הודעה מ-${contactInfo.name}`,
      body,
      icon: contactInfo.picture, // תמונת איש הקשר מקאש
      badge: DEFAULT_ICON,
      tag: `chat-${message.from}`,
      type: 'chat-message',
      messageType, // סוג ההודעה (text/voice-message/image/video/file)
      peerPubkey: message.from,
      url: `./videos.html?chat=${message.from}`,
    });
  }

  // חלק שיחה נכנסת (push-trigger.js) – שליחת Push כשמתקבלת שיחה קולית/וידאו | HYPER CORE TECH
  async function triggerIncomingCallPush(peerPubkey, callType = 'voice') {
    // לא שולחים Push אם המשתמש פעיל
    if (isUserActive()) {
      console.log('[PUSH-TRIGGER] המשתמש פעיל - לא שולחים Push לשיחה');
      return;
    }
    
    // קבלת שם ותמונת המתקשר מקאש
    const contactInfo = getCachedContactInfo(peerPubkey);
    
    const isVideo = callType === 'video';
    const myPubkey = App.publicKey;
    if (!myPubkey) return;
    
    await sendPushToServer(myPubkey, {
      title: `שיחה ${isVideo ? 'וידאו' : 'קולית'} נכנסת`,
      body: `${contactInfo.name} מתקשר אליך`,
      icon: contactInfo.picture, // תמונת המתקשר מקאש
      badge: DEFAULT_ICON,
      tag: `call-${peerPubkey}`,
      type: isVideo ? 'video-call-incoming' : 'voice-call-incoming',
      peerPubkey,
      url: './',
      requireInteraction: true,
    });
  }

  // חלק שיחה שלא נענתה (push-trigger.js) – שליחת Push על שיחה קולית/וידאו שהוחמצה | HYPER CORE TECH
  async function triggerMissedCallPush(peerPubkey, callType = 'voice') {
    // קבלת שם ותמונת המתקשר מקאש
    const contactInfo = getCachedContactInfo(peerPubkey);
    
    const isVideo = callType === 'video';
    const myPubkey = App.publicKey;
    if (!myPubkey) return;
    
    await sendPushToServer(myPubkey, {
      title: `שיחה ${isVideo ? 'וידאו' : 'קולית'} שלא נענתה`,
      body: `החמצת שיחה מ-${contactInfo.name}`,
      icon: contactInfo.picture, // תמונת המתקשר מקאש
      badge: DEFAULT_ICON,
      tag: `missed-${peerPubkey}`,
      type: 'missed-call',
      peerPubkey,
      url: './',
    });
  }

  // חשיפת API
  Object.assign(App, {
    triggerChatMessagePush,
    triggerIncomingCallPush,
    triggerMissedCallPush,
    getCachedContactInfo, // חשיפה לשימוש במקומות אחרים
  });

  console.log('[PUSH-TRIGGER] מודול Push Trigger נטען');
})(window);
