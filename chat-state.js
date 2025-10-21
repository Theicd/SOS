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
  };

  const MAX_MESSAGES_PER_THREAD = 50;

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

  function persistState() {
    const storageKey = getStorageKey();
    if (!storageKey) return;
    try {
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
          // חלק צ'אט (chat-state.js) – שומר את חותמת הזמן של הקריאה האחרונה כדי למנוע ספירה מחדש של הודעות כלא נקראו
          lastReadTimestamp: contact.lastReadTimestamp || 0,
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
        contacts: contactsArray,
        conversations: conversationsArray,
        deletedIds: Array.from(App.deletedChatMessageIds || []),
      };
      window.localStorage.setItem(storageKey, JSON.stringify(payload));
    } catch (err) {
      console.warn('Failed to persist chat state', err);
    }
  }

  function restoreState() {
    const storageKey = getStorageKey();
    if (!storageKey) return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
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
            lastReadTimestamp: typeof contact.lastReadTimestamp === 'number' ? contact.lastReadTimestamp : 0,
          };
          chatState.contacts.set(key, restoredContact);
        });
      }
      if (Array.isArray(parsed.conversations)) {
        parsed.conversations.forEach((entry) => {
          if (!entry || !entry.key || !entry.peer) {
            return;
          }
          const messages = Array.isArray(entry.messages) ? entry.messages.slice(-MAX_MESSAGES_PER_THREAD) : [];
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

  function ensureContact(pubkey, profile = {}) {
    if (!pubkey) return null;
    const normalized = pubkey.toLowerCase();
    const existing = chatState.contacts.get(normalized);
    if (existing) {
      if (profile.name) existing.name = profile.name;
      if (profile.picture) existing.picture = profile.picture;
      if (profile.initials) existing.initials = profile.initials;
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
    };
    chatState.contacts.set(normalized, contact);
    notify('contacts', getContactsSnapshot());
    persistState();
    return contact;
  }

  function updateContactMeta(pubkey, { lastMessage, timestamp, incrementUnread }) {
    const contact = ensureContact(pubkey);
    if (!contact) return;
    if (lastMessage !== undefined) {
      contact.lastMessage = lastMessage;
    }
    if (typeof timestamp === 'number' && timestamp > (contact.lastTimestamp || 0)) {
      contact.lastTimestamp = timestamp;
    }
    if (incrementUnread && (!contact.lastReadTimestamp || (typeof timestamp === 'number' && timestamp > contact.lastReadTimestamp))) {
      contact.unreadCount = (contact.unreadCount || 0) + 1;
    }
    if (!incrementUnread && typeof timestamp === 'number' && timestamp > (contact.lastReadTimestamp || 0)) {
      contact.lastReadTimestamp = timestamp;
    }
    notify('contacts', getContactsSnapshot());
    persistState();
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
    if (entry.messages.length > MAX_MESSAGES_PER_THREAD) {
      entry.messages.splice(0, entry.messages.length - MAX_MESSAGES_PER_THREAD);
    }
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
    updateContactMeta(normalizedPeer, {
      lastMessage: lastMessage?.content || '',
      timestamp: lastMessage?.createdAt || lastMessage?.created_at || 0,
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
    }
    const hadUnread = contact.unreadCount || 0;
    if (hadUnread) {
      contact.unreadCount = 0;
      recalculateUnreadTotal();
    }
    notify('contacts', getContactsSnapshot());
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
  });

  if (!App._chatStateBootstrapped) {
    App._chatStateBootstrapped = true;
    if (typeof App.publicKey === 'string' && App.publicKey) {
      restoreState();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(restoreState, 500);
      });
    }
  }
})(window);
