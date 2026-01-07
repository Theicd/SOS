  // חלק קאש תמונות (chat-service.js) – שמירת תמונות פרופיל ב-localStorage כ-DataURL כדי להימנע ממשיכות חוזרות | HYPER CORE TECH
  function avatarCacheKey(url) {
    return url ? `avatar_cache_${btoa(url)}` : null;
  }

  async function fetchAvatarAsDataUrl(url) {
    if (!url) return '';
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) return '';
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result || '');
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (err) {
      console.warn('avatar fetch failed', err);
      return '';
    }
  }

  async function getCachedAvatar(url) {
    const key = avatarCacheKey(url);
    if (!key) return '';
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return '';
      const parsed = JSON.parse(raw);
      const nowSec = Math.floor(Date.now() / 1000);
      if (!parsed?.dataUrl || !parsed?.ts || (nowSec - parsed.ts) > AVATAR_CACHE_TTL_SECONDS) {
        return '';
      }
      return parsed.dataUrl;
    } catch (_e) {
      return '';
    }
  }

  // חלק ניקוי קאש (chat-service.js) – מנקה ערכי קאש אווטר ישנים כשנגמר המקום | HYPER CORE TECH
  function cleanupOldAvatarCache() {
    try {
      const keysToRemove = [];
      const nowSec = Math.floor(Date.now() / 1000);
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('avatar_cache_')) {
          try {
            const raw = localStorage.getItem(key);
            const parsed = raw ? JSON.parse(raw) : null;
            // מסיר קאש ישן מ-24 שעות או פריטים פגומים
            if (!parsed?.ts || (nowSec - parsed.ts) > 86400) {
              keysToRemove.push(key);
            }
          } catch {
            keysToRemove.push(key);
          }
        }
      }
      keysToRemove.forEach(k => { try { localStorage.removeItem(k); } catch {} });
      return keysToRemove.length;
    } catch { return 0; }
  }

  async function cacheAvatar(url) {
    const key = avatarCacheKey(url);
    if (!key) return '';
    const cached = await getCachedAvatar(url);
    if (cached) return cached;
    const dataUrl = await fetchAvatarAsDataUrl(url);
    if (dataUrl) {
      try {
        window.localStorage.setItem(key, JSON.stringify({ dataUrl, ts: Math.floor(Date.now() / 1000) }));
      } catch (err) {
        // חלק טיפול בשגיאות (chat-service.js) – ניקוי קאש ישן כשנגמר המקום | HYPER CORE TECH
        if (err.name === 'QuotaExceededError') {
          const cleaned = cleanupOldAvatarCache();
          console.log('Avatar cache cleanup removed', cleaned, 'old entries');
          // נסיון נוסף אחרי הניקוי
          try {
            window.localStorage.setItem(key, JSON.stringify({ dataUrl, ts: Math.floor(Date.now() / 1000) }));
          } catch {
            // אם עדיין נכשל, פשוט נחזיר את ה-URL המקורי
          }
        }
      }
    }
    return dataUrl || url;
  }

(function initChatService(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק צ'אט (chat-service.js) – קבועים לזיהוי אירועי שיחה
  const CHAT_KIND = 1050;
  const CHAT_TAG = 'yalachat';
  const CONTACT_FETCH_LIMIT = 20;
  const PROFILE_TTL_SECONDS = 86400; // חלק צ'אט (chat-service.js) – TTL לפרופילים/תמונות כדי לצמצם פניות לריליי | HYPER CORE TECH
  const AVATAR_CACHE_TTL_SECONDS = 86400; // חלק צ'אט (chat-service.js) – TTL לקאש תמונות פרופיל | HYPER CORE TECH

  let poolReadyWarningShown = false;
  let isServiceReady = false;

  if (!App.chatState) {
    console.warn('Chat state module missing – chat-service aborted');
    return;
  }

  let activeSubscription = null;
  let chatSignalKeepaliveTimer = null;
  let chatLastSignalAt = 0;
  function ensurePoolReady() {
    if (isServiceReady) {
      return App.pool;
    }
    if (!App.pool) {
      if (!poolReadyWarningShown) {
        console.warn('Chat service waiting for Nostr pool to be ready');
        poolReadyWarningShown = true;
      }
      return null;
    }
    isServiceReady = true;
    return App.pool;
  }
  function buildChatDraft(peerPubkey, content) {
    const now = Math.floor(Date.now() / 1000);
    const normalizedPeer = peerPubkey.toLowerCase();
    const tags = [
      ['p', normalizedPeer],
      ['t', CHAT_TAG],
    ];
    if (App.NETWORK_TAG) {
      tags.push(['t', App.NETWORK_TAG]);
    }
    const draft = {
      kind: CHAT_KIND,
      pubkey: App.publicKey,
      created_at: now,
      tags,
      content,
    };
    return draft;
  }

  async function publishChatMessage(peerPubkey, plainText) {
    // חלק צ'אט (chat-service.js) – בודק אם מצורף קובץ לפני סינון טקסט ריק כדי לאפשר שליחת קבצים בלבד
    const attachmentReady = typeof App.hasChatFileAttachment === 'function' && App.hasChatFileAttachment(peerPubkey);
    if ((!plainText || !plainText.trim()) && !attachmentReady) {
      return { ok: false, error: 'empty-message' };
    }
    const pool = ensurePoolReady();
    if (!pool) {
      return { ok: false, error: 'pool-unavailable' };
    }
    if (typeof App.finalizeEvent !== 'function') {
      console.warn('finalizeEvent missing on App – cannot publish chat message');
      return { ok: false, error: 'finalize-missing' };
    }

    const baseText = typeof plainText === 'string' ? plainText.trim() : '';
    const serialization =
      typeof App.serializeChatMessageContent === 'function'
        ? App.serializeChatMessageContent(peerPubkey, baseText)
        : {
            rawContent: baseText,
            displayText: baseText,
            attachment: null,
            hasAttachment: false,
          };
    if (!serialization || (!serialization.rawContent && !serialization.hasAttachment)) {
      return { ok: false, error: 'empty-message' };
    }

    const draft = buildChatDraft(peerPubkey, serialization.rawContent || '');
    const event = App.finalizeEvent(draft, App.privateKey);

    const outgoingMessage = {
      id: event.id,
      from: App.publicKey,
      to: peerPubkey,
      content: serialization.displayText || '',
      attachment: serialization.attachment || null,
      createdAt: event.created_at,
      direction: 'outgoing',
      // חלק סטטוס הודעות (chat-service.js) – סטטוס שליחה: sending -> sent | HYPER CORE TECH
      status: 'sending',
    };

    // חלק סטטוס הודעות (chat-service.js) – מוסיף הודעה במצב "שולח" לפני הפרסום | HYPER CORE TECH
    App.appendChatMessage(outgoingMessage);

    // חלק timeout (chat-service.js) – פרסום עם timeout של 5 שניות למניעת תקיעה | HYPER CORE TECH
    const PUBLISH_TIMEOUT_MS = 5000;
    try {
      const publishPromise = pool.publish(App.relayUrls, event);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('publish-timeout')), PUBLISH_TIMEOUT_MS)
      );
      await Promise.race([publishPromise, timeoutPromise]);
      // חלק סטטוס הודעות (chat-service.js) – עדכון סטטוס ל"נשלח" אחרי הצלחה | HYPER CORE TECH
      if (typeof App.updateChatMessageStatus === 'function') {
        App.updateChatMessageStatus(event.id, 'sent');
      }
      App.markChatConversationRead(peerPubkey);
      // חלק Push (chat-service.js) – שליחת Push לנמען כשההודעה נשלחה בהצלחה | HYPER CORE TECH
      if (typeof App.triggerOutgoingMessagePush === 'function') {
        App.triggerOutgoingMessagePush(peerPubkey, serialization?.rawContent, attachmentReady);
      }
      if (typeof App.afterChatMessagePublished === 'function') {
        App.afterChatMessagePublished(peerPubkey, outgoingMessage);
      }
      return { ok: true, messageId: event.id };
    } catch (err) {
      // חלק timeout (chat-service.js) – אם נגמר הזמן, נחשיב כהצלחה כי ההודעה כבר נשלחה ברקע | HYPER CORE TECH
      if (err?.message === 'publish-timeout') {
        console.warn('Chat publish timeout - assuming success');
        if (typeof App.updateChatMessageStatus === 'function') {
          App.updateChatMessageStatus(event.id, 'sent');
        }
        // שליחת Push גם במקרה של timeout
        if (typeof App.triggerOutgoingMessagePush === 'function') {
          App.triggerOutgoingMessagePush(peerPubkey, serialization?.rawContent, attachmentReady);
        }
        return { ok: true, messageId: event.id };
      }
      console.error('Chat publish failed', err);
      // חלק סטטוס הודעות (chat-service.js) – עדכון סטטוס ל"נכשל" אם השליחה נכשלה | HYPER CORE TECH
      if (typeof App.updateChatMessageStatus === 'function') {
        App.updateChatMessageStatus(event.id, 'failed');
      }
      return { ok: false, error: err?.message || 'publish-failed' };
    }
  }

  async function deleteChatMessage(peerPubkey, messageId) {
    // חלק צ'אט (chat-service.js) – שולח אירוע מחיקה kind 5 לכל הריליים ומסיר מקומית את ההודעה שנבחרה
    if (!peerPubkey || !messageId) {
      return { ok: false, error: 'missing-params' };
    }
    const pool = ensurePoolReady();
    if (!pool) {
      return { ok: false, error: 'pool-unavailable' };
    }
    if (typeof App.finalizeEvent !== 'function') {
      console.warn('finalizeEvent missing on App – cannot delete chat message');
      return { ok: false, error: 'finalize-missing' };
    }
    const normalizedPeer = peerPubkey.toLowerCase();
    const draft = {
      kind: 5,
      pubkey: App.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['e', messageId],
        ['p', normalizedPeer],
        ['t', CHAT_TAG],
      ],
      content: '',
    };
    if (App.NETWORK_TAG) {
      draft.tags.push(['t', App.NETWORK_TAG]);
    }
    const event = App.finalizeEvent(draft, App.privateKey);
    try {
      await pool.publish(App.relayUrls, event);
      App.removeChatMessage(normalizedPeer, messageId);
      return { ok: true };
    } catch (err) {
      console.error('Chat delete failed', err);
      return { ok: false, error: err?.message || 'delete-failed' };
    }
  }

  function normalizeProfileData(profile = {}, pubkey = '') {
    const safeName = profile.name || `משתמש ${pubkey.slice(0, 8)}`;
    const initials = profile.initials || (typeof App.getInitials === 'function' ? App.getInitials(safeName) : 'מש');
    return {
      name: safeName,
      picture: profile.picture || '',
      initials,
    };
  }

  async function resolveProfile(pubkey) {
    const normalized = pubkey?.toLowerCase?.() || '';
    const nowSec = Math.floor(Date.now() / 1000);
    const ttl = PROFILE_TTL_SECONDS;

    // חלק קאש פרופילים (chat-service.js) – מנסה להשתמש בפרופיל שמור עם TTL לפני פנייה לריליי | HYPER CORE TECH
    const existing = App.chatState?.contacts?.get?.(normalized);
    if (existing?.profileFetchedAt && (nowSec - existing.profileFetchedAt) < ttl) {
      return { name: existing.name, picture: existing.picture, initials: existing.initials, profileFetchedAt: existing.profileFetchedAt };
    }

    if (typeof App.fetchProfile === 'function') {
      try {
        const profile = await App.fetchProfile(pubkey);
        if (profile) {
          profile.profileFetchedAt = nowSec;
          if (profile.picture) {
            const cachedAvatar = await cacheAvatar(profile.picture);
            if (cachedAvatar) {
              profile.picture = cachedAvatar;
            }
          }
        }
        return profile;
      } catch (err) {
        console.warn('Chat profile fetch failed', err);
      }
    }
    if (existing?.picture) {
      const cachedAvatar = await cacheAvatar(existing.picture);
      if (cachedAvatar) {
        return { ...existing, picture: cachedAvatar };
      }
    }
    return existing || null;
  }

  async function handleIncomingChatEvent(event) {
    if (!event || !event.pubkey) {
      return;
    }
    const eventTs = typeof event.created_at === 'number' ? event.created_at : Math.floor(Date.now() / 1000);
    if (event.kind === 5) {
      handleIncomingDeletion(event);
      return;
    }
    if (event.kind !== CHAT_KIND || !event.content) {
      return;
    }
    const sender = event.pubkey.toLowerCase();
    const currentUser = (App.publicKey || '').toLowerCase();
    const isSelfMessage = sender === currentUser;
    const peerTag = event.tags?.find?.((tag) => Array.isArray(tag) && tag[0] === 'p');
    const recipient = peerTag?.[1]?.toLowerCase?.() || '';
    if (!isSelfMessage && recipient && recipient !== currentUser) {
      // לא נועד עבור המשתמש הנוכחי
      return;
    }

    const peerPubkey = isSelfMessage ? recipient : sender;
    if (!peerPubkey) {
      return;
    }

    const conversationTarget = isSelfMessage ? recipient : currentUser;
    if (!conversationTarget) {
      return;
    }

    const profile = normalizeProfileData(await resolveProfile(peerPubkey), peerPubkey);
    App.ensureChatContact(peerPubkey, { ...profile, profileFetchedAt: eventTs });

    const parsedPayload =
      typeof App.deserializeChatMessageContent === 'function'
        ? App.deserializeChatMessageContent(event.content)
        : {
            displayText: event.content,
            attachment: null,
            hasAttachment: false,
          };

    const normalizedMessage = {
      id: event.id,
      from: sender,
      to: conversationTarget,
      content: parsedPayload.displayText || event.content,
      attachment: parsedPayload.attachment || null,
      createdAt: eventTs,
      direction: isSelfMessage ? 'outgoing' : 'incoming',
    };

    App.appendChatMessage(normalizedMessage);
    
    // חלק Push (chat-service.js) – שליחת התראת Push כשמגיעה הודעה נכנסת | HYPER CORE TECH
    if (!isSelfMessage && typeof App.triggerChatMessagePush === 'function') {
      App.triggerChatMessagePush(normalizedMessage);
    }
    
    if (typeof App.setChatLastSyncTs === 'function') {
      const currentSync = App.getChatLastSyncTs?.() || 0;
      if (eventTs > currentSync) {
        App.setChatLastSyncTs(eventTs);
      }
    }
  }

  // חלק מחיקה דו-צדדית (chat-service.js) – טיפול באירוע מחיקה kind 5 מכל צד | HYPER CORE TECH
  function handleIncomingDeletion(event) {
    if (!Array.isArray(event?.tags)) {
      return;
    }
    const actor = event.pubkey?.toLowerCase?.();
    const self = App.publicKey?.toLowerCase?.() || '';
    const isSelf = actor === self;
    const targets = [];
    let pTagPubkey = null;
    event.tags.forEach((tag) => {
      if (!Array.isArray(tag)) {
        return;
      }
      if (tag[0] === 'e' && typeof tag[1] === 'string') {
        targets.push(tag[1]);
      }
      if (tag[0] === 'p' && typeof tag[1] === 'string') {
        pTagPubkey = tag[1].toLowerCase();
      }
    });
    if (!targets.length) {
      return;
    }
    
    // חלק מחיקה דו-צדדית (chat-service.js) – קביעת הפיר הנכון לפי מי שלח את אירוע המחיקה | HYPER CORE TECH
    // אם אני מחקתי - הפיר הוא מי שב-p tag
    // אם מישהו אחר מחק - הפיר הוא מי ששלח את אירוע המחיקה (actor)
    const conversationPeer = isSelf ? pTagPubkey : actor;
    
    targets.forEach((messageId) => {
      // מנסים למחוק מהשיחה עם הפיר הנכון
      App.removeChatMessage(conversationPeer, messageId);
      // גם מוסיפים לרשימת המחוקים כדי לא להציג שוב
      App.deletedChatMessageIds?.add?.(messageId);
    });
    
    const eventTs = typeof event.created_at === 'number' ? event.created_at : Math.floor(Date.now() / 1000);
    if (typeof App.setChatLastSyncTs === 'function') {
      const currentSync = App.getChatLastSyncTs?.() || 0;
      if (eventTs > currentSync) {
        App.setChatLastSyncTs(eventTs);
      }
    }
    
    console.log('[CHAT] Deletion processed:', targets.length, 'messages from', conversationPeer?.slice(0, 8));
  }

  function subscribeToChatEvents() {
    if (activeSubscription || !ensurePoolReady()) {
      return;
    }
    const normalizedSelf = App.publicKey?.toLowerCase?.() || '';
    if (!normalizedSelf) {
      return;
    }

    const sinceTs = typeof App.getChatLastSyncTs === 'function' ? App.getChatLastSyncTs() : 0;
    const baseFilter = (kinds, extra = {}) => {
      const f = { kinds, limit: 200, ...extra };
      if (sinceTs && Number.isFinite(sinceTs)) {
        f.since = sinceTs;
      }
      return f;
    };

    const filters = [
      baseFilter([CHAT_KIND], { '#p': [normalizedSelf], '#t': [CHAT_TAG] }),
      baseFilter([CHAT_KIND], { authors: [normalizedSelf], '#t': [CHAT_TAG] }),
      baseFilter([5], { authors: [normalizedSelf], '#t': [CHAT_TAG] }),
      baseFilter([5], { '#p': [normalizedSelf], '#t': [CHAT_TAG] }),
      // חלק אישורי קריאה (chat-service.js) – האזנה לאישורי קריאה נכנסים | HYPER CORE TECH
      baseFilter([READ_RECEIPT_KIND], { '#p': [normalizedSelf], '#t': [CHAT_TAG] }),
    ];

    if (App.NETWORK_TAG) {
      filters.push(
        baseFilter([CHAT_KIND], { '#t': [App.NETWORK_TAG], authors: [normalizedSelf] }),
        baseFilter([CHAT_KIND], { '#t': [App.NETWORK_TAG], '#p': [normalizedSelf] }),
        baseFilter([5], { '#t': [App.NETWORK_TAG], authors: [normalizedSelf] }),
        baseFilter([5], { '#t': [App.NETWORK_TAG], '#p': [normalizedSelf] }),
        baseFilter([READ_RECEIPT_KIND], { '#t': [App.NETWORK_TAG], '#p': [normalizedSelf] }),
      );
    }

    activeSubscription = App.pool.subscribeMany(App.relayUrls, filters, {
      onevent: (event) => {
        chatLastSignalAt = Date.now();
        // חלק אישורי קריאה (chat-service.js) – טיפול באישורי קריאה נכנסים | HYPER CORE TECH
        if (event.kind === READ_RECEIPT_KIND) {
          handleIncomingReadReceipt(event);
          return;
        }
        handleIncomingChatEvent(event);
      },
      oneose: () => {
        chatLastSignalAt = Date.now();
      },
    });
  }

  // חלק צ'אט (chat-service.js) – רענון חיבור לאחר חזרה מפוקוס/רשת או idle | HYPER CORE TECH
  function forceResubscribeChat(reason) {
    if (!ensurePoolReady()) return;
    try { if (typeof navigator !== 'undefined' && navigator.onLine === false) return; } catch {}
    if (activeSubscription && typeof activeSubscription.close === 'function') {
      try { activeSubscription.close(); } catch {}
    }
    activeSubscription = null;
    chatLastSignalAt = Date.now();
    subscribeToChatEvents();
    console.log('Chat: resubscribed', reason || '');
  }

  function ensureChatKeepaliveStarted() {
    if (chatSignalKeepaliveTimer) return;
    try { document.addEventListener('visibilitychange', () => { if (!document.hidden) forceResubscribeChat('visibilitychange'); }); } catch {}
    try { window.addEventListener('online', () => forceResubscribeChat('online')); } catch {}
    try { window.addEventListener('focus', () => forceResubscribeChat('focus')); } catch {}
    try { window.addEventListener('pageshow', () => forceResubscribeChat('pageshow')); } catch {}

    chatSignalKeepaliveTimer = setInterval(() => {
      try {
        if (!ensurePoolReady()) return;
        try { if (typeof navigator !== 'undefined' && navigator.onLine === false) return; } catch {}
        if (document.hidden) return;
        const now = Date.now();
        const last = chatLastSignalAt || 0;
        if (!activeSubscription) {
          subscribeToChatEvents();
          return;
        }
        if (last && (now - last) > 90000) {
          forceResubscribeChat('keepalive');
        }
      } catch (err) {
        console.warn('Chat keepalive error', err);
      }
    }, 30000);
  }

  async function bootstrapContactsFromFeed() {
    if (!Array.isArray(App.notifications)) {
      return;
    }
    const recentActors = new Set();
    App.notifications.slice(0, CONTACT_FETCH_LIMIT).forEach((notification) => {
      if (notification?.actorPubkey) {
        recentActors.add(notification.actorPubkey.toLowerCase());
      }
    });
    if (App.eventAuthorById instanceof Map) {
      Array.from(App.eventAuthorById.values())
        .slice(0, CONTACT_FETCH_LIMIT)
        .forEach((pubkey) => {
          if (typeof pubkey === 'string') {
            recentActors.add(pubkey.toLowerCase());
          }
        });
    }
    const selfKey = (App.publicKey || '').toLowerCase();
    recentActors.delete(selfKey);

    const promises = Array.from(recentActors).map(async (pubkey) => {
      const profile = normalizeProfileData(await resolveProfile(pubkey), pubkey);
      App.ensureChatContact(pubkey, profile);
    });

    try {
      await Promise.all(promises);
    } catch (err) {
      console.warn('Bootstrap contacts failed', err);
    }
  }

  function addChatContact(pubkey) {
    if (!pubkey) {
      return null;
    }
    const normalized = pubkey.toLowerCase();
    if (!normalized || normalized.length !== 64) {
      console.warn('Invalid pubkey for chat contact');
      return null;
    }
    const existing = App.chatState.contacts.get(normalized);
    if (existing) {
      return existing;
    }
    const profile = normalizeProfileData(App.profileCache?.get?.(normalized) || {}, normalized);
    const contact = App.ensureChatContact(normalized, profile);
    return contact;
  }

  function handlePoolReady() {
    const pool = ensurePoolReady();
    if (!pool) {
      return;
    }
    ensureChatKeepaliveStarted();
    subscribeToChatEvents();
    bootstrapContactsFromFeed();
  }

  const previousNotifyPoolReady = App.notifyPoolReady;
  App.notifyPoolReady = function notifyPoolReadyBridge(pool) {
    if (typeof previousNotifyPoolReady === 'function') {
      try {
        previousNotifyPoolReady(pool);
      } catch (err) {
        console.warn('Previous notifyPoolReady handler failed', err);
      }
    }
    if (pool) {
      App.pool = pool;
    }
    handlePoolReady();
  };

  // חלק אישורי קריאה (chat-service.js) – שליחת אישור קריאה לצד השני כשפותחים שיחה | HYPER CORE TECH
  const READ_RECEIPT_KIND = 1051; // kind מיוחד לאישורי קריאה
  
  async function sendReadReceipt(peerPubkey, lastReadTs) {
    const pool = ensurePoolReady();
    if (!pool || !peerPubkey || App.guestMode) return;
    if (typeof App.finalizeEvent !== 'function' || !App.privateKey) return;
    
    const normalizedPeer = peerPubkey.toLowerCase();
    const content = JSON.stringify({ lastReadAt: lastReadTs || Math.floor(Date.now() / 1000) });
    
    const tags = [
      ['p', normalizedPeer],
      ['t', CHAT_TAG],
    ];
    if (App.NETWORK_TAG) {
      tags.push(['t', App.NETWORK_TAG]);
    }
    
    const event = {
      kind: READ_RECEIPT_KIND,
      pubkey: App.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    };
    
    try {
      const signed = App.finalizeEvent(event, App.privateKey);
      await pool.publish(App.relayUrls, signed);
      console.log('[CHAT] Read receipt sent to', normalizedPeer.slice(0, 8));
    } catch (err) {
      console.warn('[CHAT] Failed to send read receipt', err);
    }
  }
  
  // חלק אישורי קריאה (chat-service.js) – טיפול באישור קריאה נכנס - מעדכן סטטוס הודעות ל"נקרא" | HYPER CORE TECH
  function handleIncomingReadReceipt(event) {
    if (!event || event.kind !== READ_RECEIPT_KIND) return;
    
    const sender = event.pubkey?.toLowerCase?.();
    const self = App.publicKey?.toLowerCase?.() || '';
    if (sender === self) return; // התעלם מאישורים שלנו
    
    // בדוק שהאישור מיועד אלינו
    const pTag = event.tags?.find?.(t => Array.isArray(t) && t[0] === 'p');
    const recipient = pTag?.[1]?.toLowerCase?.();
    if (recipient !== self) return;
    
    let lastReadAt = 0;
    try {
      const data = JSON.parse(event.content || '{}');
      lastReadAt = data.lastReadAt || 0;
    } catch {}
    
    if (!lastReadAt) return;
    
    // עדכן כל ההודעות היוצאות לאותו peer עם createdAt <= lastReadAt לסטטוס "read"
    const messages = typeof App.getChatMessages === 'function' ? App.getChatMessages(sender) : [];
    messages.forEach(msg => {
      if (msg.direction === 'outgoing' && msg.createdAt <= lastReadAt && msg.status !== 'read') {
        if (typeof App.updateChatMessageStatus === 'function') {
          App.updateChatMessageStatus(msg.id, 'read');
        }
      }
    });
    
    console.log('[CHAT] Read receipt received from', sender.slice(0, 8), 'up to', lastReadAt);
  }

  // חלק רענון שיחות (chat-service.js) – פונקציה לסנכרון מחדש של כל היסטוריית הצ'אט | HYPER CORE TECH
  async function syncChatHistory() {
    // איפוס חותמת הזמן כדי לטעון את כל ההיסטוריה
    if (typeof App.setChatLastSyncTs === 'function') {
      App.setChatLastSyncTs(0);
    }
    
    // סגירת ההרשמה הקיימת
    if (activeSubscription && typeof activeSubscription.close === 'function') {
      try { activeSubscription.close(); } catch {}
    }
    activeSubscription = null;
    
    // המתנה קצרה לפני התחברות מחדש
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // הרשמה מחדש לאירועי צ'אט - יטען את כל ההיסטוריה
    subscribeToChatEvents();
    
    // טעינת אנשי קשר מהפיד
    bootstrapContactsFromFeed();
    
    console.log('[CHAT/SERVICE] Full chat history sync initiated');
  }

  Object.assign(App, {
    publishChatMessage,
    deleteChatMessage,
    subscribeToChatEvents,
    bootstrapChatContacts: bootstrapContactsFromFeed,
    addChatContact,
    syncChatHistory,
    sendReadReceipt,
  });

  if (!App._chatServiceBootstrapped) {
    App._chatServiceBootstrapped = true;
    const scheduleBootstrap = () => {
      setTimeout(handlePoolReady, 600);
    };
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      scheduleBootstrap();
    } else {
      document.addEventListener('DOMContentLoaded', scheduleBootstrap);
    }
  }
})(window);
