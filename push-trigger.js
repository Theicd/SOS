// חלק Push Trigger (push-trigger.js) – שליחת התראות Push כשמגיעות הודעות/שיחות | HYPER CORE TECH
// קובץ זה מחבר את מערכת הצ'אט והשיחות לשרת ה-Push
(function initPushTrigger(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק הגדרות (push-trigger.js) – כתובת שרת Push (מסונכרן עם push-client.js) | HYPER CORE TECH
  const getPushServerUrl = () => {
    // קודם מנסה מ-localStorage (מסונכרן עם push-client.js)
    const savedUrl = localStorage.getItem('push_server_url');
    if (savedUrl) return savedUrl;
    // fallback לברירת מחדל
    return 'https://sos-push-server.vercel.app';
  };
  const DEFAULT_ICON = './icons/so-call010.png';

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

  // חלק שליחת Push (push-trigger.js) – שליחה לשרת Push עם rate limiting | HYPER CORE TECH
  let pushServerAvailable = true;
  let pushServerCheckTime = 0;
  const PUSH_SERVER_CHECK_INTERVAL = 60000; // בדוק שוב אחרי דקה
  const pushSentRecently = new Map(); // מניעת שליחות כפולות
  const PUSH_DEDUP_TTL = 5000; // 5 שניות
  
  async function sendPushToServer(targetPubkey, payload) {
    if (!targetPubkey || !payload) {
      console.warn('[PUSH-TRIGGER] חסר pubkey או payload');
      return;
    }
    
    // אם השרת לא זמין - דלג
    if (!pushServerAvailable && Date.now() - pushServerCheckTime < PUSH_SERVER_CHECK_INTERVAL) {
      console.log('[PUSH-TRIGGER] שרת לא זמין - דילוג');
      return;
    }
    
    // מניעת שליחות כפולות
    const dedupKey = `${targetPubkey}_${payload.type || 'msg'}_${payload.body?.slice(0, 20) || ''}`;
    if (pushSentRecently.has(dedupKey)) {
      console.log('[PUSH-TRIGGER] דילוג על שליחה כפולה');
      return;
    }
    pushSentRecently.set(dedupKey, Date.now());
    setTimeout(() => pushSentRecently.delete(dedupKey), PUSH_DEDUP_TTL);
    
    console.log('[PUSH-TRIGGER] שולח Push לשרת:', targetPubkey.slice(0, 8), payload.type);
    
    try {
      const response = await fetch(`${getPushServerUrl()}/api/push/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: targetPubkey, payload }),
      });
      
      const data = await response.json();
      console.log('[PUSH-TRIGGER] תגובת שרת:', data);
      
      if (!response.ok) {
        pushServerAvailable = false;
        pushServerCheckTime = Date.now();
        return;
      }
      
      if (data.ok && data.sent > 0) {
        console.log('[PUSH-TRIGGER] ✅ Push נשלח בהצלחה ל:', targetPubkey.slice(0, 8), 'sent:', data.sent);
      } else if (data.message?.includes('No subscriptions')) {
        console.warn('[PUSH-TRIGGER] ⚠️ אין מנוי רשום עבור:', targetPubkey.slice(0, 8));
      }
      pushServerAvailable = true;
    } catch (err) {
      console.error('[PUSH-TRIGGER] ❌ שגיאה בשליחה:', err);
      pushServerAvailable = false;
      pushServerCheckTime = Date.now();
    }
  }

  // חלק Push יוצא (push-trigger.js) – שליחת Push לנמען כשאני שולח הודעה | HYPER CORE TECH
  async function triggerOutgoingMessagePush(peerPubkey, messageContent, attachment) {
    if (!peerPubkey) return;
    
    // קבלת שם ותמונת השולח (אני)
    const myName = App.profile?.name || App.chatState?.myProfile?.name || 'משתמש';
    const myPicture = App.profile?.picture || App.chatState?.myProfile?.picture || DEFAULT_ICON;
    
    // בניית תוכן ההודעה
    let body = 'הודעה חדשה';
    let messageType = 'text';
    
    if (attachment) {
      if (attachment.type === 'audio' || attachment.mimeType?.startsWith('audio/')) {
        body = '🎤 הודעה קולית';
        messageType = 'voice-message';
      } else if (attachment.type === 'image' || attachment.mimeType?.startsWith('image/')) {
        body = '📷 תמונה';
        messageType = 'image';
      } else if (attachment.type === 'video' || attachment.mimeType?.startsWith('video/')) {
        body = '🎬 וידאו';
        messageType = 'video';
      } else {
        body = '📎 קובץ מצורף';
        messageType = 'file';
      }
    } else if (messageContent) {
      body = messageContent.length > 100 ? messageContent.slice(0, 100) + '...' : messageContent;
    }
    
    // שליחת Push לנמען (לא לעצמי!)
    await sendPushToServer(peerPubkey, {
      title: `הודעה מ-${myName}`,
      body,
      icon: myPicture,
      badge: DEFAULT_ICON,
      tag: `chat-${App.publicKey}`,
      type: 'chat-message',
      messageType,
      peerPubkey: App.publicKey, // ה-pubkey שלי - כדי שהנמען יוכל לפתוח צ'אט איתי
      url: `./videos.html?chat=${App.publicKey}`,
    });
    
    console.log('[PUSH] Sent to recipient:', peerPubkey.slice(0, 8));
  }

  // חלק הודעת צ'אט (push-trigger.js) – שליחת Push כשמתקבלת הודעת צ'אט/קולית (לגיבוי) | HYPER CORE TECH
  async function triggerChatMessagePush(message) {
    // לא שולחים Push אם המשתמש פעיל וצופה בצ'אט
    if (isUserActive() && isChatOpenWith(message.from)) {
      return;
    }
    
    // לא שולחים Push להודעות יוצאות (שלי)
    if (message.direction === 'outgoing') {
      return;
    }
    
    // חלק מניעת התרעות ישנות (push-trigger.js) – לא שולחים Push להודעות ישנות מריליי | HYPER CORE TECH
    const nowSec = Math.floor(Date.now() / 1000);
    const messageTs = message.createdAt || 0;
    const messageAgeSec = nowSec - messageTs;
    if (messageAgeSec > 60) {
      console.log('[PUSH-TRIGGER] דילוג על הודעה ישנה:', messageAgeSec, 'שניות');
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

  // חלק P2P Sync (push-trigger.js) – שליחת Push שקט לסנכרון P2P כשיש פוסטים חדשים | HYPER CORE TECH
  async function triggerP2PSyncPush(targetPubkeys, syncData) {
    if (!Array.isArray(targetPubkeys) || targetPubkeys.length === 0) return;
    
    const payload = {
      type: 'p2p-sync',
      silent: true, // לא מציגים notification
      data: {
        syncType: syncData?.type || 'posts',
        count: syncData?.count || 0,
        timestamp: Date.now(),
        ...syncData
      }
    };
    
    // שליחה לכל הנמענים (בד"כ עוקבים או peers פעילים)
    for (const pubkey of targetPubkeys.slice(0, 50)) { // מקסימום 50 לפעם
      await sendPushToServer(pubkey, payload);
    }
    
    console.log('[PUSH-TRIGGER] P2P Sync sent to', Math.min(targetPubkeys.length, 50), 'peers');
  }

  // חלק Wake-up (push-trigger.js) – שליחת Push להערת המכשיר שלי | HYPER CORE TECH
  async function triggerSelfWakeupPush(reason) {
    const myPubkey = App.publicKey;
    if (!myPubkey) return;
    
    await sendPushToServer(myPubkey, {
      type: 'p2p-wakeup',
      silent: true,
      data: {
        reason: reason || 'sync',
        timestamp: Date.now()
      }
    });
    
    console.log('[PUSH-TRIGGER] Self wakeup sent:', reason);
  }

  // חלק עדכון גרסה (push-trigger.js) – שליחת Push על עדכון אפליקציה | HYPER CORE TECH
  async function triggerAppUpdatePush(targetPubkeys, version) {
    if (!Array.isArray(targetPubkeys) || targetPubkeys.length === 0) return;
    
    const payload = {
      type: 'app-update',
      title: 'עדכון זמין ל-SOS',
      body: `גרסה ${version || 'חדשה'} זמינה! לחץ לעדכון`,
      version: version || 'new',
      tag: 'app-update'
    };
    
    for (const pubkey of targetPubkeys.slice(0, 100)) {
      await sendPushToServer(pubkey, payload);
    }
    
    console.log('[PUSH-TRIGGER] App Update sent to', Math.min(targetPubkeys.length, 100), 'users');
  }

  // חשיפת API
  Object.assign(App, {
    triggerOutgoingMessagePush, // שליחת Push לנמען כשאני שולח הודעה
    triggerChatMessagePush,
    triggerIncomingCallPush,
    triggerMissedCallPush,
    getCachedContactInfo,
    triggerP2PSyncPush,      // שליחת Push לסנכרון P2P
    triggerSelfWakeupPush,   // שליחת Push להערת המכשיר שלי
    triggerAppUpdatePush,    // שליחת Push על עדכון גרסה
  });

  console.log('[PUSH-TRIGGER] מודול Push Trigger נטען');
})(window);
