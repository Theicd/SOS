// חלק Push Trigger (push-trigger.js) – שליחת התראות Push כשמגיעות הודעות/שיחות | HYPER CORE TECH
// קובץ זה מחבר את מערכת הצ'אט והשיחות לשרת ה-Push
// Push Privacy: private chat notifications are generic wake-ups only (no message/attachment content).
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
  const GENERIC_CHAT_TITLE = 'SOS';
  const GENERIC_CHAT_BODY = 'הודעה חדשה';

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

  function isChatMessagePushType(type) {
    const t = String(type || '');
    return t === 'chat-message' || t === 'chat';
  }

  /**
   * Fail-closed sanitizer for private-chat notification payloads.
   * Drops any accidental private-content fields; forces generic title/body.
   */
  function sanitizePrivateChatPushPayload(payload, defaults) {
    const src = payload && typeof payload === 'object' ? payload : {};
    const peer = String(src.peerPubkey || defaults?.peerPubkey || '').toLowerCase();
    const eventId = src.eventId != null ? String(src.eventId) : (defaults?.eventId != null ? String(defaults.eventId) : '');
    const openUrl = defaults?.url || (peer ? `https://sos010.com/videos.html?chat=${peer}` : 'https://sos010.com/videos.html');
    const relativeUrl = defaults?.relativeUrl || (peer ? `./videos.html?chat=${peer}` : './videos.html');
    const tag = src.tag || defaults?.tag || (peer ? `chat-${peer}` : 'chat');

    // Intentionally ignore: body, title, messageContent, rawContent, preview, caption,
    // attachment, name, url content fields, icon/picture from caller for chat type.
    return {
      title: GENERIC_CHAT_TITLE,
      body: GENERIC_CHAT_BODY,
      badge: DEFAULT_ICON,
      icon: DEFAULT_ICON,
      tag,
      type: 'chat-message',
      peerPubkey: peer || undefined,
      eventId: eventId || undefined,
      url: relativeUrl,
      data: {
        type: 'chat-message',
        peerPubkey: peer || undefined,
        eventId: eventId || undefined,
        url: openUrl,
      },
    };
  }

  function parseOutgoingPushArgs(arg2, arg3, arg4) {
    // New contract: triggerOutgoingMessagePush(peerPubkey, { eventId, hasAttachment })
    if (arg2 && typeof arg2 === 'object' && !Array.isArray(arg2) && (
      Object.prototype.hasOwnProperty.call(arg2, 'eventId') ||
      Object.prototype.hasOwnProperty.call(arg2, 'messageId') ||
      Object.prototype.hasOwnProperty.call(arg2, 'hasAttachment') ||
      arg2.type === 'chat-message'
    )) {
      return {
        eventId: arg2.eventId != null ? String(arg2.eventId) : (arg2.messageId != null ? String(arg2.messageId) : ''),
        // hasAttachment accepted only as boolean routing hint; never reads content fields.
        hasAttachment: arg2.hasAttachment === true,
      };
    }
    // Legacy positional: (peer, messageContent, attachment, messageId) — content IGNORED.
    const eventId = arg4 != null ? String(arg4) : '';
    const hasAttachment = arg3 === true || (arg3 && typeof arg3 === 'object');
    return { eventId, hasAttachment };
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

    let safePayload = payload;
    if (isChatMessagePushType(payload.type)) {
      safePayload = sanitizePrivateChatPushPayload(payload, {
        peerPubkey: payload.peerPubkey,
        eventId: payload.eventId,
        tag: payload.tag,
        url: payload.data?.url,
        relativeUrl: payload.url,
      });
    }
    
    // אם השרת לא זמין - דלג
    if (!pushServerAvailable && Date.now() - pushServerCheckTime < PUSH_SERVER_CHECK_INTERVAL) {
      console.log('[PUSH-TRIGGER] שרת לא זמין - דילוג');
      return;
    }
    
    // מניעת שליחות כפולות (ללא שימוש בתוכן הודעה)
    const dedupKey = `${targetPubkey}_${safePayload.type || 'msg'}_${safePayload.eventId || safePayload.tag || ''}`;
    if (pushSentRecently.has(dedupKey)) {
      console.log('[PUSH-TRIGGER] דילוג על שליחה כפולה');
      return;
    }
    pushSentRecently.set(dedupKey, Date.now());
    setTimeout(() => pushSentRecently.delete(dedupKey), PUSH_DEDUP_TTL);
    
    console.log('[PUSH-TRIGGER] שולח Push לשרת:', targetPubkey.slice(0, 8), safePayload.type);
    
    // FCM למעטפת Android (מסך כבוי / אפליקציה סגורה) – בנוסף ל-Web Push | HYPER CORE TECH
    try {
      if (typeof App.sendFcmToPubkey === 'function') {
        App.sendFcmToPubkey(targetPubkey, {
          title: safePayload.title || 'SOS',
          body: safePayload.body || GENERIC_CHAT_BODY,
          url: safePayload.url || safePayload.data?.url || 'https://sos010.com/videos.html',
          tag: safePayload.tag || safePayload.type || 'sos',
          data: Object.assign({}, safePayload.data || { type: safePayload.type || 'general' }, {
            eventId: safePayload.eventId || safePayload.data?.eventId || '',
            peer: safePayload.peerPubkey || safePayload.data?.peerPubkey || '',
            peerPubkey: safePayload.peerPubkey || safePayload.data?.peerPubkey || '',
          }),
        });
      }
    } catch (fcmErr) {
      console.warn('[PUSH-TRIGGER] FCM side-send failed', fcmErr);
    }

    try {
      const response = await fetch(`${getPushServerUrl()}/api/push/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: targetPubkey, payload: safePayload }),
      });
      
      const data = await response.json();
      console.log('[PUSH-TRIGGER] תגובת שרת:', { ok: !!data.ok, sent: data.sent || 0, status: response.status });
      
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

  // חלק Push יוצא (push-trigger.js) – שליחת Push גנרי לנמען (ללא תוכן הודעה) | HYPER CORE TECH
  async function triggerOutgoingMessagePush(peerPubkey, arg2, arg3, arg4) {
    if (!peerPubkey) return;
    const parsed = parseOutgoingPushArgs(arg2, arg3, arg4);
    const self = String(App.publicKey || '').toLowerCase();
    const payload = sanitizePrivateChatPushPayload({
      type: 'chat-message',
      peerPubkey: self,
      eventId: parsed.eventId,
      tag: self ? `chat-${self}` : 'chat',
    }, {
      peerPubkey: self,
      eventId: parsed.eventId,
      tag: self ? `chat-${self}` : 'chat',
      url: self ? `https://sos010.com/videos.html?chat=${self}` : undefined,
      relativeUrl: self ? `./videos.html?chat=${self}` : undefined,
    });
    // hasAttachment intentionally unused for body text (generic only).
    await sendPushToServer(peerPubkey, payload);
    console.log('[PUSH] Sent to recipient:', peerPubkey.slice(0, 8));
  }

  // חלק הודעת צ'אט (push-trigger.js) – התראה מקומית + Push גנרי כשמתקבלת הודעה | HYPER CORE TECH
  async function triggerChatMessagePush(message) {
    // לא שולחים אם המשתמש פעיל וצופה בצ'אט עם השולח
    if (isUserActive() && isChatOpenWith(message.from)) {
      return;
    }
    
    // לא שולחים להודעות יוצאות (שלי)
    if (message.direction === 'outgoing') {
      return;
    }
    
    // חלק מניעת התרעות ישנות (push-trigger.js) – לא שולחים להודעות ישנות מריליי | HYPER CORE TECH
    const nowSec = Math.floor(Date.now() / 1000);
    const messageTs = message.createdAt || 0;
    const messageAgeSec = nowSec - messageTs;
    if (messageAgeSec > 60) {
      console.log('[PUSH-TRIGGER] דילוג על הודעה ישנה:', messageAgeSec, 'שניות');
      return;
    }

    const from = String(message.from || '').toLowerCase();
    const openUrl = `https://sos010.com/videos.html?chat=${from}`;
    const tag = `chat-${from}`;
    const eventId = message.id || message.eventId || '';
    const title = GENERIC_CHAT_TITLE;
    const body = GENERIC_CHAT_BODY;

    // באפליקציית APK: chat-ui + SosRelayWatcher כבר מתריעים – בלי כפילות מקומית | HYPER CORE TECH
    const isNative = typeof App.isNativeShell === 'function' && App.isNativeShell();
    if (!isNative) {
      try {
        if (typeof App.showLocalNotification === 'function') {
          await App.showLocalNotification(title, {
            body,
            tag,
            type: 'chat-message',
            eventId,
            data: {
              type: 'chat-message',
              peerPubkey: from,
              eventId,
              url: openUrl,
            },
          });
        } else if (typeof App.showChatNotification === 'function') {
          App.showChatNotification(title, body, from);
        }
      } catch (localErr) {
        console.warn('[PUSH-TRIGGER] local notify failed', localErr);
      }
    }
    
    // Push לשרת – למכשירים אחרים / FCM כשה-WebView מת | HYPER CORE TECH
    const myPubkey = App.publicKey;
    if (!myPubkey) return;
    
    await sendPushToServer(myPubkey, sanitizePrivateChatPushPayload({
      type: 'chat-message',
      peerPubkey: from,
      eventId,
      tag,
    }, {
      peerPubkey: from,
      eventId,
      tag,
      url: openUrl,
      relativeUrl: `./videos.html?chat=${from}`,
    }));
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
    sanitizePrivateChatPushPayload,
    triggerP2PSyncPush,      // שליחת Push לסנכרון P2P
    triggerSelfWakeupPush,   // שליחת Push להערת המכשיר שלי
    triggerAppUpdatePush,    // שליחת Push על עדכון גרסה
    PUSH_GENERIC_CHAT_TITLE: GENERIC_CHAT_TITLE,
    PUSH_GENERIC_CHAT_BODY: GENERIC_CHAT_BODY,
  });

  console.log('[PUSH-TRIGGER] מודול Push Trigger נטען');
})(window);
