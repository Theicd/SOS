(function initChatService(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק צ'אט (chat-service.js) – קבועים לזיהוי אירועי שיחה
  const CHAT_KIND = 1050;
  const CHAT_TAG = 'yalachat';
  const CONTACT_FETCH_LIMIT = 20;

  let poolReadyWarningShown = false;
  let isServiceReady = false;

  if (!App.chatState) {
    console.warn('Chat state module missing – chat-service aborted');
    return;
  }

  let activeSubscription = null;
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
    };

    try {
      await pool.publish(App.relayUrls, event);
      App.appendChatMessage(outgoingMessage);
      App.markChatConversationRead(peerPubkey);
      if (typeof App.afterChatMessagePublished === 'function') {
        App.afterChatMessagePublished(peerPubkey, outgoingMessage);
      }
      return { ok: true };
    } catch (err) {
      console.error('Chat publish failed', err);
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
    if (typeof App.fetchProfile === 'function') {
      try {
        return await App.fetchProfile(pubkey);
      } catch (err) {
        console.warn('Chat profile fetch failed', err);
      }
    }
    return null;
  }

  async function handleIncomingChatEvent(event) {
    if (!event || !event.pubkey) {
      return;
    }
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
    App.ensureChatContact(peerPubkey, profile);

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
      createdAt: event.created_at || Math.floor(Date.now() / 1000),
      direction: isSelfMessage ? 'outgoing' : 'incoming',
    };

    App.appendChatMessage(normalizedMessage);
  }

  function handleIncomingDeletion(event) {
    if (!Array.isArray(event?.tags)) {
      return;
    }
    const actor = event.pubkey?.toLowerCase?.();
    const self = App.publicKey?.toLowerCase?.() || '';
    const isSelf = actor === self;
    const targets = [];
    let peerPubkey = null;
    event.tags.forEach((tag) => {
      if (!Array.isArray(tag)) {
        return;
      }
      if (tag[0] === 'e' && typeof tag[1] === 'string') {
        targets.push(tag[1]);
      }
      if (tag[0] === 'p' && typeof tag[1] === 'string') {
        peerPubkey = tag[1].toLowerCase();
      }
    });
    if (!targets.length) {
      return;
    }
    targets.forEach((messageId) => {
      App.removeChatMessage(peerPubkey, messageId);
    });
    if (!isSelf && peerPubkey && actor) {
      App.deletedChatMessageIds?.forEach?.((id) => id);
    }
  }

  function subscribeToChatEvents() {
    if (activeSubscription || !ensurePoolReady()) {
      return;
    }
    const normalizedSelf = App.publicKey?.toLowerCase?.() || '';
    if (!normalizedSelf) {
      return;
    }

    const filters = [
      {
        kinds: [CHAT_KIND],
        '#p': [normalizedSelf],
        '#t': [CHAT_TAG],
        limit: 200,
      },
      {
        kinds: [CHAT_KIND],
        authors: [normalizedSelf],
        '#t': [CHAT_TAG],
        limit: 200,
      },
      {
        kinds: [5],
        authors: [normalizedSelf],
        '#t': [CHAT_TAG],
        limit: 200,
      },
      {
        kinds: [5],
        '#p': [normalizedSelf],
        '#t': [CHAT_TAG],
        limit: 200,
      },
    ];

    if (App.NETWORK_TAG) {
      filters.push(
        { kinds: [CHAT_KIND], '#t': [App.NETWORK_TAG], authors: [normalizedSelf], limit: 200 },
        { kinds: [CHAT_KIND], '#t': [App.NETWORK_TAG], '#p': [normalizedSelf], limit: 200 },
        { kinds: [5], '#t': [App.NETWORK_TAG], authors: [normalizedSelf], limit: 200 },
        { kinds: [5], '#t': [App.NETWORK_TAG], '#p': [normalizedSelf], limit: 200 },
      );
    }

    activeSubscription = App.pool.subscribeMany(App.relayUrls, filters, {
      onevent: (event) => {
        handleIncomingChatEvent(event);
      },
      oneose: () => {
        // אין פעולת EOSE מיוחדת כרגע
      },
    });
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

  Object.assign(App, {
    publishChatMessage,
    deleteChatMessage,
    subscribeToChatEvents,
    bootstrapChatContacts: bootstrapContactsFromFeed,
    addChatContact,
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
