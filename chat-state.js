(function initChatState(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק צ'אט (chat-state.js) – מבנה נתונים מרכזי לצ'אט
  App.deletedChatMessageIds = App.deletedChatMessageIds || new Set();

  const chatState = {
    contacts: new Map(),
    conversations: new Map(),
    unreadTotal: 0,
    listeners: {
      contacts: new Set(),
      message: new Set(),
      unread: new Set(),
    },
    messageIndex: new Map(), // חלק צ'אט (chat-state.js) – שומר מפה מהירה מהודעה לשיחה לצורך מחיקה וניקוי כפילויות
    lastSyncTs: 0, // חלק צ'אט (chat-state.js) – חותמת סנכרון אחרונה כדי לצמצם משיכה מריליי | HYPER CORE TECH
  };

  const MAX_MESSAGES_PER_THREAD = null; // חלק צ'אט (chat-state.js) – מבטל קיצוץ הודעות (שומרים היסטוריה מלאה) | HYPER CORE TECH
  
  // חלק IndexedDB (chat-state.js) – אחסון ללא הגבלה עם IndexedDB | HYPER CORE TECH
  const DB_NAME = 'NostrChatDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'chatState';
  let dbInstance = null;
  let dbReady = false;
  let pendingPersist = false;
  
  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (dbInstance && dbReady) {
        resolve(dbInstance);
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => {
        console.warn('IndexedDB open failed, falling back to localStorage');
        reject(request.error);
      };
      request.onsuccess = () => {
        dbInstance = request.result;
        dbReady = true;
        resolve(dbInstance);
      };
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
    });
  }

  function getConversationKey(a, b) {
    if (!a || !b) return null;
    const left = a.toLowerCase();
    const right = b.toLowerCase();
    return left < right ? `${left}:${right}` : `${right}:${left}`;
  }

  function getStorageKey() {
    const pubkey = typeof App.publicKey === 'string' ? App.publicKey.toLowerCase() : '';
    if (!pubkey) return null;
    return `nostr_chat_${pubkey}`;
  }

  function notify(type, payload) {
    const bucket = chatState.listeners[type];
    if (!bucket) return;
    bucket.forEach((listener) => {
      try {
        listener(payload);
      } catch (err) {
        console.warn('Chat listener callback failed', err);
      }
    });
  }

  // חלק אופטימיזציה (chat-state.js) – debounce ל-notify contacts למניעת ספאם | HYPER CORE TECH
  let _notifyContactsTimeout = null;
  function debouncedNotifyContacts() {
    if (_notifyContactsTimeout) return;
    _notifyContactsTimeout = setTimeout(() => {
      _notifyContactsTimeout = null;
      notify('contacts', getContactsSnapshot());
    }, 300);
  }

  // חלק שמירה IndexedDB (chat-state.js) – שמירה ל-IndexedDB עם fallback ל-localStorage | HYPER CORE TECH
  async function persistStateToIndexedDB() {
    const storageKey = getStorageKey();
    if (!storageKey) return;
    
    const contactsArray = [];
    chatState.contacts.forEach((contact) => {
      contactsArray.push({
        pubkey: contact.pubkey,
        name: contact.name,
        picture: contact.picture,
        initials: contact.initials,
        lastMessage: contact.lastMessage,
        lastTimestamp: contact.lastTimestamp,
        unreadCount: contact.unreadCount,
        lastReadTimestamp: contact.lastReadTimestamp || 0,
        profileFetchedAt: contact.profileFetchedAt || 0,
      });
    });
    const conversationsArray = [];
    chatState.conversations.forEach((info, key) => {
      conversationsArray.push({
        key,
        peer: info.peer,
        messages: Array.isArray(info.messages) ? info.messages : [],
      });
    });
    const payload = {
      id: storageKey,
      contacts: contactsArray,
      conversations: conversationsArray,
      deletedIds: Array.from(App.deletedChatMessageIds || []),
      lastSyncTs: chatState.lastSyncTs || 0,
    };
    
    try {
      const db = await openDatabase();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(payload);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      // Fallback to localStorage if IndexedDB fails
      try {
        const smallPayload = JSON.stringify(payload);
        window.localStorage.setItem(storageKey, smallPayload);
      } catch (lsErr) {
        console.warn('Failed to persist chat state to both IndexedDB and localStorage', lsErr);
      }
    }
  }
  
  // חלק debounce (chat-state.js) – מונע שמירות רבות מדי בזמן קצר | HYPER CORE TECH
  let persistTimeout = null;
  function persistState() {
    if (persistTimeout) return;
    persistTimeout = setTimeout(() => {
      persistTimeout = null;
      persistStateToIndexedDB();
    }, 500);
  }

  // חלק שחזור IndexedDB (chat-state.js) – שחזור מ-IndexedDB עם fallback ל-localStorage | HYPER CORE TECH
  async function restoreStateFromIndexedDB() {
    const storageKey = getStorageKey();
    if (!storageKey) return null;
    
    try {
      const db = await openDatabase();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(storageKey);
      return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
      });
    } catch (err) {
      return null;
    }
  }

  async function restoreState() {
    const storageKey = getStorageKey();
    if (!storageKey) return;
    try {
      // נסה קודם IndexedDB
      let parsed = await restoreStateFromIndexedDB();
      
      // אם אין ב-IndexedDB, נסה localStorage
      if (!parsed) {
        const raw = window.localStorage.getItem(storageKey);
        if (raw) {
          parsed = JSON.parse(raw);
          // מיגרציה: מעביר נתונים מ-localStorage ל-IndexedDB
          if (parsed) {
            setTimeout(() => {
              persistStateToIndexedDB();
              // מנקה את localStorage אחרי מיגרציה מוצלחת
              try { window.localStorage.removeItem(storageKey); } catch {}
            }, 1000);
          }
        }
      }
      
      if (!parsed || typeof parsed !== 'object') return;
      if (Array.isArray(parsed.contacts)) {
        parsed.contacts.forEach((contact) => {
          if (!contact || !contact.pubkey) {
            return;
          }
          const key = contact.pubkey.toLowerCase();
          const restoredContact = {
            pubkey: key,
            name: contact.name || 'משתמש',
            picture: contact.picture || '',
            initials:
              contact.initials || (typeof App.getInitials === 'function' ? App.getInitials(contact.name || '') : 'מש'),
            lastMessage: contact.lastMessage || '',
            lastTimestamp: typeof contact.lastTimestamp === 'number' ? contact.lastTimestamp : 0,
            unreadCount: 0, // חלק אופטימיזציה (chat-state.js) – אתחול unread ל-0 בשחזור | HYPER CORE TECH
            lastReadTimestamp: typeof contact.lastReadTimestamp === 'number' ? contact.lastReadTimestamp : 0,
            profileFetchedAt: typeof contact.profileFetchedAt === 'number' ? contact.profileFetchedAt : 0,
          };
          chatState.contacts.set(key, restoredContact);
        });
      }
      if (Array.isArray(parsed.conversations)) {
        parsed.conversations.forEach((entry) => {
          if (!entry || !entry.key || !entry.peer) {
            return;
          }
          const messages = Array.isArray(entry.messages)
            ? MAX_MESSAGES_PER_THREAD
              ? entry.messages.slice(-MAX_MESSAGES_PER_THREAD)
              : entry.messages
            : [];
          chatState.conversations.set(entry.key, {
            peer: entry.peer.toLowerCase(),
            messages,
          });
          messages.forEach((message) => {
            if (!message?.id) {
              return;
            }
            chatState.messageIndex.set(message.id, {
              peer: entry.peer.toLowerCase(),
              key: entry.key,
            });
          });
        });
      }
      if (Array.isArray(parsed.deletedIds)) {
        App.deletedChatMessageIds = new Set(parsed.deletedIds.filter((id) => typeof id === 'string'));
      }
      if (typeof parsed.lastSyncTs === 'number') {
        chatState.lastSyncTs = parsed.lastSyncTs;
      }
    } catch (err) {
      console.warn('Failed to restore chat state', err);
    }
    recomputeUnreadCounts();
    recalculateUnreadTotal();
    notify('contacts', getContactsSnapshot());
    notify('unread', chatState.unreadTotal);
  }

  // חלק צ'אט (chat-state.js) – מחשב מחדש את מספור ההודעות הלא נקראות לפי הזמן האחרון שהשיחה נקראה
  function recomputeUnreadCounts() {
    const self = (App.publicKey || '').toLowerCase();
    chatState.contacts.forEach((contact) => {
      const conversationKey = getConversationKey(contact.pubkey, self);
      const conversation = conversationKey ? chatState.conversations.get(conversationKey) : null;
      if (!conversation) {
        contact.unreadCount = 0;
        return;
      }
      const lastRead = contact.lastReadTimestamp || 0;
      const unread = conversation.messages.reduce((total, message) => {
        const direction = message.direction || (message.from?.toLowerCase?.() === contact.pubkey ? 'incoming' : 'outgoing');
        const createdAt = typeof message.createdAt === 'number' ? message.createdAt : typeof message.created_at === 'number' ? message.created_at : 0;
        if (direction === 'incoming' && createdAt > lastRead) {
          return total + 1;
        }
        return total;
      }, 0);
      contact.unreadCount = unread;
    });
  }

  // חלק אופטימיזציה (chat-state.js) – מונע notify מיותר אם אין שינוי אמיתי | HYPER CORE TECH
  function ensureContact(pubkey, profile = {}) {
    if (!pubkey) return null;
    const normalized = pubkey.toLowerCase();
    const existing = chatState.contacts.get(normalized);
    if (existing) {
      // בדוק אם יש שינוי אמיתי לפני notify
      let hasChange = false;
      if (profile.name && profile.name !== existing.name) { existing.name = profile.name; hasChange = true; }
      if (profile.picture && profile.picture !== existing.picture) { existing.picture = profile.picture; hasChange = true; }
      if (profile.initials && profile.initials !== existing.initials) { existing.initials = profile.initials; hasChange = true; }
      if (profile.profileFetchedAt) existing.profileFetchedAt = profile.profileFetchedAt;
      // רק אם יש שינוי - עדכן UI
      if (hasChange) {
        debouncedNotifyContacts();
        persistState();
      }
      return existing;
    }
    const fallbackName = profile.name || 'משתמש';
    const initials = profile.initials || (typeof App.getInitials === 'function' ? App.getInitials(fallbackName) : 'מש');
    const contact = {
      pubkey: normalized,
      name: fallbackName,
      picture: profile.picture || '',
      initials,
      lastMessage: '',
      lastTimestamp: 0,
      unreadCount: 0,
      lastReadTimestamp: profile.lastReadTimestamp || 0,
      profileFetchedAt: profile.profileFetchedAt || Math.floor(Date.now() / 1000),
    };
    chatState.contacts.set(normalized, contact);
    debouncedNotifyContacts();
    persistState();
    return contact;
  }

  // חלק אופטימיזציה (chat-state.js) – עדכון מטא רק אם יש שינוי | HYPER CORE TECH
  function updateContactMeta(pubkey, { lastMessage, timestamp, incrementUnread, forceTimestamp }) {
    const contact = ensureContact(pubkey);
    if (!contact) return;
    let hasChange = false;
    if (lastMessage !== undefined && lastMessage !== contact.lastMessage) {
      contact.lastMessage = lastMessage;
      hasChange = true;
    }
    // חלק צ'אט (chat-state.js) – מאפשר עדכון lastTimestamp גם לאחור (forceTimestamp) למשל אחרי מחיקה | HYPER CORE TECH
    if (typeof timestamp === 'number' && (forceTimestamp || timestamp > (contact.lastTimestamp || 0))) {
      contact.lastTimestamp = timestamp;
      hasChange = true;
    }
    if (incrementUnread && (!contact.lastReadTimestamp || (typeof timestamp === 'number' && timestamp > contact.lastReadTimestamp))) {
      contact.unreadCount = (contact.unreadCount || 0) + 1;
      hasChange = true;
    }
    if (!incrementUnread && typeof timestamp === 'number' && timestamp > (contact.lastReadTimestamp || 0)) {
      contact.lastReadTimestamp = timestamp;
    }
    if (hasChange) {
      debouncedNotifyContacts();
      persistState();
    }
  }

  function recalculateUnreadTotal() {
    chatState.unreadTotal = Array.from(chatState.contacts.values()).reduce((sum, contact) => sum + (contact.unreadCount || 0), 0);
    notify('unread', chatState.unreadTotal);
  }

  function appendMessageToConversation(message) {
    const { from, to, content, createdAt } = message;
    if (!from || !to || !content) return;
    const key = getConversationKey(from, to);
    if (!key) return;
    let entry = chatState.conversations.get(key);
    if (!entry) {
      const peer = from.toLowerCase() === (App.publicKey || '').toLowerCase() ? to.toLowerCase() : from.toLowerCase();
      entry = {
        peer,
        messages: [],
      };
      chatState.conversations.set(key, entry);
    }
    const existingIndex = entry.messages.findIndex((item) => item.id === message.id);
    if (existingIndex !== -1) {
      return;
    }
    if (message?.id && App.deletedChatMessageIds?.has?.(message.id)) {
      return;
    }
    entry.messages.push(message);
    entry.messages.sort((a, b) => a.createdAt - b.createdAt);
    if (message?.id) {
      chatState.messageIndex.set(message.id, {
        peer: entry.peer,
        key,
      });
    }
    const attachmentPreview = message?.attachment?.name ? `📎 ${message.attachment.name}` : '';
    const messagePreview = content || attachmentPreview;
    updateContactMeta(entry.peer, {
      lastMessage: messagePreview,
      timestamp: createdAt,
      incrementUnread: message.direction === 'incoming',
    });
    recalculateUnreadTotal();
    persistState();
    notify('message', { peer: entry.peer, message });
  }

  function removeMessageFromConversation(peerPubkey, messageId) {
    // חלק צ'אט (chat-state.js) – מסיר הודעה מהמצב המקומי ומעדכן מטא-דאטה כך שתיעלם מכל המכשירים לאחר רענון
    if (!messageId) {
      return;
    }
    const self = (App.publicKey || '').toLowerCase();
    let normalizedPeer = peerPubkey ? peerPubkey.toLowerCase() : null;
    let key = null;
    if (normalizedPeer) {
      key = getConversationKey(normalizedPeer, self);
    } else if (chatState.messageIndex.has(messageId)) {
      const indexEntry = chatState.messageIndex.get(messageId);
      normalizedPeer = indexEntry?.peer || null;
      key = indexEntry?.key || null;
    }
    if (!normalizedPeer || !key) {
      return;
    }
    const entry = chatState.conversations.get(key);
    if (!entry || !Array.isArray(entry.messages) || !entry.messages.length) {
      return;
    }
    const index = entry.messages.findIndex((item) => item.id === messageId);
    if (index === -1) {
      return;
    }
    entry.messages.splice(index, 1);
    chatState.messageIndex.delete(messageId);
    App.deletedChatMessageIds?.add?.(messageId);
    const lastMessage = entry.messages[entry.messages.length - 1];
    const attachmentPreview = lastMessage?.attachment?.name ? `📎 ${lastMessage.attachment.name}` : '';
    const messagePreview = (lastMessage?.content || '') || attachmentPreview;
    // חלק צ'אט (chat-state.js) – אחרי מחיקה נעדכן lastTimestamp גם אם ירד כדי שהשעה/מיון יהיו נכונים | HYPER CORE TECH
    updateContactMeta(normalizedPeer, {
      lastMessage: messagePreview,
      timestamp: lastMessage?.createdAt || lastMessage?.created_at || 0,
      forceTimestamp: true,
    });
    recalculateUnreadTotal();
    persistState();
    notify('message', { peer: normalizedPeer, removedMessageId: messageId });
  }

  function markConversationRead(peerPubkey) {
    const normalized = peerPubkey?.toLowerCase?.();
    if (!normalized) return;
    const contact = chatState.contacts.get(normalized);
    if (!contact) return;
    const conversationKey = getConversationKey(normalized, App.publicKey || '');
    const conversation = conversationKey ? chatState.conversations.get(conversationKey) : null;
    const latestMessage = conversation?.messages?.length
      ? conversation.messages[conversation.messages.length - 1]
      : null;
    const lastReadTs = latestMessage?.createdAt || Math.floor(Date.now() / 1000);
    if (!contact.lastReadTimestamp || lastReadTs > contact.lastReadTimestamp) {
      contact.lastReadTimestamp = lastReadTs;
      // חלק אישורי קריאה (chat-state.js) – שליחת אישור קריאה לצד השני | HYPER CORE TECH
      if (typeof App.sendReadReceipt === 'function') {
        App.sendReadReceipt(normalized, lastReadTs);
      }
    }
    const hadUnread = contact.unreadCount || 0;
    if (hadUnread) {
      contact.unreadCount = 0;
      recalculateUnreadTotal();
    }
    debouncedNotifyContacts();
    persistState();
  }

  function getContactsSnapshot() {
    return Array.from(chatState.contacts.values())
      .sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
  }

  function getConversationMessages(peerPubkey) {
    const normalized = peerPubkey?.toLowerCase?.();
    if (!normalized) return [];
    const key = getConversationKey(normalized, App.publicKey || '');
    if (!key) return [];
    const entry = chatState.conversations.get(key);
    return entry ? entry.messages.slice() : [];
  }

  function subscribe(topic, callback) {
    if (!chatState.listeners[topic]) {
      chatState.listeners[topic] = new Set();
    }
    chatState.listeners[topic].add(callback);
    return () => chatState.listeners[topic].delete(callback);
  }

  function restoreChatModuleState() {
    restoreState();
  }

  function setLastSyncTs(ts) {
    if (typeof ts !== 'number') return;
    chatState.lastSyncTs = ts;
    persistState();
  }

  function getLastSyncTs() {
    return chatState.lastSyncTs || 0;
  }

  // חלק סטטוס הודעות (chat-state.js) – עדכון סטטוס הודעה (sending, sent, read, failed) | HYPER CORE TECH
  function updateMessageStatus(messageId, newStatus) {
    if (!messageId || !newStatus) return false;
    const indexEntry = chatState.messageIndex.get(messageId);
    if (!indexEntry) return false;
    const entry = chatState.conversations.get(indexEntry.key);
    if (!entry || !Array.isArray(entry.messages)) return false;
    const message = entry.messages.find(m => m.id === messageId);
    if (!message) return false;
    message.status = newStatus;
    persistState();
    notify('message', { peer: indexEntry.peer, message, statusUpdate: true });
    return true;
  }

  Object.assign(App, {
    chatState,
    getConversationKey,
    restoreChatState: restoreChatModuleState,
    persistChatState: persistState,
    ensureChatContact: ensureContact,
    appendChatMessage: appendMessageToConversation,
    removeChatMessage: removeMessageFromConversation,
    markChatConversationRead: markConversationRead,
    getChatContacts: getContactsSnapshot,
    getChatMessages: getConversationMessages,
    subscribeChat: subscribe,
    chatStorageKey: getStorageKey,
    setChatLastSyncTs: setLastSyncTs,
    getChatLastSyncTs: getLastSyncTs,
    updateChatMessageStatus: updateMessageStatus,
  });

  // חלק המתנה ל-restore (chat-state.js) – Promise שמאפשר ל-chat-service להמתין לטעינת הקאש | HYPER CORE TECH
  let _restoreStateResolve = null;
  App.chatStateReady = new Promise((resolve) => {
    _restoreStateResolve = resolve;
  });

  async function doRestoreAndSignal() {
    await restoreState();
    if (_restoreStateResolve) {
      _restoreStateResolve();
      _restoreStateResolve = null;
    }
  }

  if (!App._chatStateBootstrapped) {
    App._chatStateBootstrapped = true;
    if (typeof App.publicKey === 'string' && App.publicKey) {
      doRestoreAndSignal();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(doRestoreAndSignal, 500);
      });
    }
  }
})(window);
