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

  const MAX_MESSAGES_PER_THREAD = 500; // חלק צ'אט (chat-state.js) – מגביל היסטוריה בזיכרון/שמירה לביצועים | HYPER CORE TECH
  const CHAT_RETENTION_SECONDS = 90 * 24 * 60 * 60; // חלק צ'אט (chat-state.js) – תקרת שמירה גלובלית 90 יום | HYPER CORE TECH
  const DISAPPEARING_DEFAULT_SEC = 7 * 24 * 60 * 60; // חלק ניקוי אוטומטי – ברירת מחדל 7 ימים | HYPER CORE TECH

  // peerPubkey -> seconds (תמיד בין 24 שעות ל-90 יום; אין «כבוי») | HYPER CORE TECH
  chatState.disappearingTimers = new Map();
  chatState.defaultDisappearingSec = DISAPPEARING_DEFAULT_SEC;

  function getChatRetentionCutoffTs(nowSec = Math.floor(Date.now() / 1000)) {
    return nowSec - CHAT_RETENTION_SECONDS;
  }

  function getMessageCreatedAt(message) {
    const ts = Number(message?.createdAt || message?.created_at || 0);
    return Number.isFinite(ts) ? ts : 0;
  }

  function normalizeDisappearingTimerSec(seconds) {
    const sec = Number(seconds);
    if (!Number.isFinite(sec) || sec <= 0) {
      // מיגרציה מ«כבוי» ישן → תקרת 90 יום | HYPER CORE TECH
      return CHAT_RETENTION_SECONDS;
    }
    return Math.min(sec, CHAT_RETENTION_SECONDS);
  }

  function getDisappearingTimerSec(peerPubkey) {
    const key = typeof peerPubkey === 'string' ? peerPubkey.toLowerCase() : '';
    if (!key) return chatState.defaultDisappearingSec;
    if (chatState.disappearingTimers.has(key)) {
      return normalizeDisappearingTimerSec(chatState.disappearingTimers.get(key));
    }
    return chatState.defaultDisappearingSec;
  }

  function formatDisappearingTimerLabel(seconds) {
    const sec = normalizeDisappearingTimerSec(seconds);
    const day = 24 * 60 * 60;
    if (sec <= day) return '24 שעות';
    if (sec <= 3 * day) return '72 שעות';
    if (sec <= 7 * day) return '7 ימים';
    if (sec <= 14 * day) return '14 יום';
    if (sec <= 30 * day) return '30 יום';
    if (sec <= 60 * day) return '60 יום';
    if (sec <= 90 * day) return '90 ימים';
    return `${Math.round(sec / day)} ימים`;
  }

  function isSystemChatMessage(message) {
    return !!(message && (message.isSystem || message.direction === 'system' || message.systemKind));
  }

  function buildDisappearingNoticeContent(sec, kind = 'intro') {
    const label = formatDisappearingTimerLabel(sec);
    if (kind === 'change') {
      return `ניקוי אוטומטי של הודעות השיחה עודכן. הודעות חדשות יימחקו מהצ׳אט אחרי ${label}. לשינוי הטיימר לחץ כאן.`;
    }
    return `ניקוי אוטומטי של הודעות השיחה מופעל. הודעות חדשות יימחקו מהצ׳אט אחרי ${label}. לשינוי הטיימר לחץ כאן.`;
  }

  function isOutdatedDisappearingNoticeContent(content) {
    const text = String(content || '');
    return (
      text.includes('הודעות נעלמות')
      || text.includes('בחרת להשתמש')
      || text.includes('ייעלמו מהצ')
      || text.includes('כיבית הודעות')
    );
  }

  function refreshDisappearingSystemNotices() {
    let changed = 0;
    chatState.conversations.forEach((entry) => {
      if (!entry?.peer || !Array.isArray(entry.messages)) return;
      entry.messages.forEach((message) => {
        const isDisappearNotice =
          message?.systemKind === 'disappearing-intro'
          || message?.systemKind === 'disappearing-change'
          || isOutdatedDisappearingNoticeContent(message?.content);
        if (!isDisappearNotice) return;
        const kind = message.systemKind === 'disappearing-change' ? 'change' : 'intro';
        const sec = normalizeDisappearingTimerSec(
          message.disappearingTimerSec || getDisappearingTimerSec(entry.peer)
        );
        const next = buildDisappearingNoticeContent(sec, kind);
        if (message.content === next && message.isSystem && message.direction === 'system') return;
        message.content = next;
        message.disappearingTimerSec = sec;
        message.isSystem = true;
        message.direction = 'system';
        if (!message.systemKind) {
          message.systemKind = kind === 'change' ? 'disappearing-change' : 'disappearing-intro';
        }
        changed += 1;
      });
    });
    if (changed > 0) persistState();
    return changed;
  }

  function ensureConversationEntry(peerPubkey) {
    const peer = typeof peerPubkey === 'string' ? peerPubkey.toLowerCase() : '';
    const self = (App.publicKey || '').toLowerCase();
    if (!peer || !self) return null;
    const key = getConversationKey(peer, self);
    if (!key) return null;
    let entry = chatState.conversations.get(key);
    if (!entry) {
      entry = { peer, messages: [] };
      chatState.conversations.set(key, entry);
      ensureContact(peer);
    }
    return { key, entry, peer };
  }

  function appendDisappearingSystemNotice(peerPubkey, { kind = 'intro', silent = false } = {}) {
    const bucket = ensureConversationEntry(peerPubkey);
    if (!bucket) return null;
    const { key, entry, peer } = bucket;
    const sec = getDisappearingTimerSec(peer);
    const now = Math.floor(Date.now() / 1000);
    let createdAt = now;
    if (kind === 'intro') {
      const firstRegular = entry.messages.find((message) => !isSystemChatMessage(message));
      const firstTs = firstRegular ? getMessageCreatedAt(firstRegular) : 0;
      createdAt = firstTs > 0 ? Math.max(1, firstTs - 1) : now;
    }
    const noticeKind = kind === 'change' ? 'change' : 'intro';
    const message = {
      id: `sys-disappear-${noticeKind}-${peer.slice(0, 12)}-${now}-${Math.random().toString(36).slice(2, 8)}`,
      from: (App.publicKey || '').toLowerCase(),
      to: peer,
      content: buildDisappearingNoticeContent(sec, noticeKind),
      createdAt,
      direction: 'system',
      isSystem: true,
      systemKind: noticeKind === 'change' ? 'disappearing-change' : 'disappearing-intro',
      disappearingTimerSec: sec,
    };
    if (kind === 'intro') {
      entry.messages.unshift(message);
    } else {
      entry.messages.push(message);
    }
    entry.messages.sort((a, b) => getMessageCreatedAt(a) - getMessageCreatedAt(b));
    chatState.messageIndex.set(message.id, { peer, key });
    updateContactMeta(peer, {
      lastMessage: '⏱ ניקוי אוטומטי',
      timestamp: createdAt,
      incrementUnread: false,
    });
    persistState();
    if (!silent) {
      notify('message', {
        peer,
        message,
        disappearingSystemNotice: true,
        disappearingTimerUpdated: kind === 'change',
        disappearingTimerSec: sec,
      });
    }
    return message;
  }

  function ensureDisappearingIntroNotice(peerPubkey) {
    try { refreshDisappearingSystemNotices(); } catch (_) {}
    const bucket = ensureConversationEntry(peerPubkey);
    if (!bucket) return null;
    const { entry, peer } = bucket;
    const hasRegular = entry.messages.some((message) => !isSystemChatMessage(message));
    if (hasRegular) return null;
    const hasDisappearingNotice = entry.messages.some((message) =>
      message?.systemKind === 'disappearing-intro' || message?.systemKind === 'disappearing-change'
    );
    if (hasDisappearingNotice) return null;
    return appendDisappearingSystemNotice(peer, { kind: 'intro', silent: true });
  }

  function getCutoffForPeer(peerPubkey, nowSec = Math.floor(Date.now() / 1000)) {
    return nowSec - getDisappearingTimerSec(peerPubkey);
  }

  function pruneConversationEntry(entry, cutoffTs) {
    if (!entry || !Array.isArray(entry.messages) || !entry.messages.length) return 0;
    const before = entry.messages.length;
    entry.messages = entry.messages.filter((message) => {
      const ts = getMessageCreatedAt(message);
      if (ts && ts < cutoffTs) {
        if (message?.id) chatState.messageIndex.delete(message.id);
        return false;
      }
      return true;
    });
    return before - entry.messages.length;
  }

  function prunePeerDisappearingMessages(peerPubkey) {
    const self = (App.publicKey || '').toLowerCase();
    const peer = typeof peerPubkey === 'string' ? peerPubkey.toLowerCase() : '';
    if (!peer || !self) return 0;
    const key = getConversationKey(peer, self);
    const entry = key ? chatState.conversations.get(key) : null;
    if (!entry) return 0;
    const removed = pruneConversationEntry(entry, getCutoffForPeer(peer));
    if (removed > 0) {
      persistState();
      notify('message', { peer, disappearingPruned: true });
    }
    return removed;
  }

  function setDisappearingTimerSec(peerPubkey, seconds) {
    const peer = typeof peerPubkey === 'string' ? peerPubkey.toLowerCase() : '';
    if (!peer) return false;
    const sec = normalizeDisappearingTimerSec(seconds);
    chatState.disappearingTimers.set(peer, sec);
    persistState();
    prunePeerDisappearingMessages(peer);
    appendDisappearingSystemNotice(peer, { kind: 'change' });
    return true;
  }

  function pruneExpiredChatHistory() {
    let removed = 0;
    chatState.conversations.forEach((entry) => {
      if (!entry?.peer) return;
      removed += pruneConversationEntry(entry, getCutoffForPeer(entry.peer));
    });
    if (removed > 0) {
      persistState();
      console.log('[CHAT/STATE] Pruned disappearing/expired messages:', removed);
    }
    return removed;
  }
  
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
    const disappearingTimers = [];
    chatState.disappearingTimers.forEach((seconds, peer) => {
      disappearingTimers.push({ peer, seconds: Number(seconds) || 0 });
    });
    const payload = {
      id: storageKey,
      contacts: contactsArray,
      conversations: conversationsArray,
      deletedIds: Array.from(App.deletedChatMessageIds || []),
      lastSyncTs: chatState.lastSyncTs || 0,
      disappearingTimers,
      defaultDisappearingSec: chatState.defaultDisappearingSec,
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
      if (Array.isArray(parsed.disappearingTimers)) {
        chatState.disappearingTimers.clear();
        parsed.disappearingTimers.forEach((row) => {
          const peer = typeof row?.peer === 'string' ? row.peer.toLowerCase() : '';
          if (!peer) return;
          chatState.disappearingTimers.set(peer, normalizeDisappearingTimerSec(row.seconds));
        });
      }
      if (typeof parsed.defaultDisappearingSec === 'number' && parsed.defaultDisappearingSec > 0) {
        chatState.defaultDisappearingSec = normalizeDisappearingTimerSec(parsed.defaultDisappearingSec);
      }
      if (Array.isArray(parsed.conversations)) {
        parsed.conversations.forEach((entry) => {
          if (!entry || !entry.key || !entry.peer) {
            return;
          }
          const peer = entry.peer.toLowerCase();
          const cutoffTs = getCutoffForPeer(peer);
          const filtered = (Array.isArray(entry.messages) ? entry.messages : []).filter((message) => {
            const ts = getMessageCreatedAt(message);
            return !ts || ts >= cutoffTs;
          });
          const messages = MAX_MESSAGES_PER_THREAD ? filtered.slice(-MAX_MESSAGES_PER_THREAD) : filtered;
          chatState.conversations.set(entry.key, {
            peer,
            messages,
          });
          messages.forEach((message) => {
            if (!message?.id) {
              return;
            }
            chatState.messageIndex.set(message.id, {
              peer,
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
        if (isSystemChatMessage(message)) return total;
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
    if (isChatMessageMarkedDeleted(message)) {
      return;
    }
    // חלק ניקוי אוטומטי (chat-state.js) – לא מקבלים הודעות שעברו את טיימר השיחה / תקרת 90 יום | HYPER CORE TECH
    const createdAtTs = getMessageCreatedAt(message) || createdAt || 0;
    if (createdAtTs && createdAtTs < getCutoffForPeer(entry.peer)) {
      return;
    }
    entry.messages.push(message);
    entry.messages.sort((a, b) => a.createdAt - b.createdAt);
    if (MAX_MESSAGES_PER_THREAD && entry.messages.length > MAX_MESSAGES_PER_THREAD) {
      const removed = entry.messages.splice(0, entry.messages.length - MAX_MESSAGES_PER_THREAD);
      removed.forEach((old) => {
        if (old?.id) chatState.messageIndex.delete(old.id);
      });
    }
    if (message?.id) {
      chatState.messageIndex.set(message.id, {
        peer: entry.peer,
        key,
      });
    }
    // חלק תיקון קול (chat-state.js) – preview מתאים להודעות קוליות: 🎤 במקום 📎 | HYPER CORE TECH
    let attachmentPreview = '';
    if (message?.attachment) {
      const attMime = (message.attachment.type || '').toLowerCase();
      const attName = (message.attachment.name || '').toLowerCase();
      const isAudioAtt = attMime.startsWith('audio/') || attName.includes('voice') || attName.endsWith('.webm');
      if (isAudioAtt) {
        const d = typeof message.attachment.duration === 'number' && message.attachment.duration > 0 ? message.attachment.duration : 0;
        attachmentPreview = d > 0 ? `🎤 הודעה קולית (${Math.floor(d / 60)}:${String(Math.floor(d % 60)).padStart(2, '0')})` : '🎤 הודעה קולית';
      } else if (message.attachment.name) {
        attachmentPreview = `📎 ${message.attachment.name}`;
      }
    }
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

  // חלק מחיקת מדיה P2P (chat-state.js) – שולח שומר p2p-send-{fileId}, מקבל שומר p2p-recv-{fileId} | HYPER CORE TECH
  function extractP2PFileIdFromMessageId(messageId) {
    if (typeof messageId !== 'string' || !messageId) return '';
    if (messageId.startsWith('p2p-send-')) return messageId.slice('p2p-send-'.length);
    if (messageId.startsWith('p2p-recv-')) return messageId.slice('p2p-recv-'.length);
    return '';
  }

  function buildP2PDeletionAliases(messageId, fileId) {
    const aliases = new Set();
    if (messageId) aliases.add(String(messageId));
    const fromId = extractP2PFileIdFromMessageId(messageId);
    const fid = (fileId && String(fileId)) || fromId;
    if (fid) {
      aliases.add(fid);
      aliases.add(`p2p-send-${fid}`);
      aliases.add(`p2p-recv-${fid}`);
    }
    return Array.from(aliases);
  }

  function messageMatchesDeletionTarget(item, targetId) {
    if (!item || !targetId) return false;
    if (item.id === targetId) return true;
    const targetFileId = extractP2PFileIdFromMessageId(targetId) || targetId;
    const itemFileId = item.attachment?.fileId || extractP2PFileIdFromMessageId(item.id);
    if (itemFileId && targetFileId && itemFileId === targetFileId) return true;
    if (itemFileId && (targetId === `p2p-send-${itemFileId}` || targetId === `p2p-recv-${itemFileId}`)) return true;
    return false;
  }

  function isChatMessageMarkedDeleted(message) {
    if (!message?.id || !App.deletedChatMessageIds?.has) return false;
    if (App.deletedChatMessageIds.has(message.id)) return true;
    const aliases = buildP2PDeletionAliases(message.id, message.attachment?.fileId);
    return aliases.some((id) => App.deletedChatMessageIds.has(id));
  }

  function markDeletedMessageAliases(messageId, fileId) {
    buildP2PDeletionAliases(messageId, fileId).forEach((id) => {
      App.deletedChatMessageIds?.add?.(id);
    });
  }

  function findMessageIndexEntryForDeletion(messageId) {
    if (!messageId) return null;
    if (chatState.messageIndex.has(messageId)) {
      return chatState.messageIndex.get(messageId);
    }
    const aliases = buildP2PDeletionAliases(messageId);
    for (let i = 0; i < aliases.length; i += 1) {
      const alias = aliases[i];
      if (alias !== messageId && chatState.messageIndex.has(alias)) {
        return chatState.messageIndex.get(alias);
      }
    }
    // סריקה לפי fileId כשאין אינדקס (למשל p2p-send מול p2p-recv) | HYPER CORE TECH
    const fileId = extractP2PFileIdFromMessageId(messageId) || messageId;
    if (!fileId) return null;
    for (const [key, entry] of chatState.conversations.entries()) {
      const hit = (entry?.messages || []).find((item) => messageMatchesDeletionTarget(item, messageId));
      if (hit) {
        return { peer: entry.peer, key, message: hit };
      }
    }
    return null;
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
    } else {
      const indexEntry = findMessageIndexEntryForDeletion(messageId);
      normalizedPeer = indexEntry?.peer || null;
      key = indexEntry?.key || null;
    }
    if (!normalizedPeer || !key) {
      // גם בלי שיחה מקומית – מסמנים aliases כדי שלא תחזור הודעת מדיה | HYPER CORE TECH
      markDeletedMessageAliases(messageId, extractP2PFileIdFromMessageId(messageId));
      return;
    }
    const entry = chatState.conversations.get(key);
    if (!entry || !Array.isArray(entry.messages) || !entry.messages.length) {
      markDeletedMessageAliases(messageId, extractP2PFileIdFromMessageId(messageId));
      return;
    }
    const index = entry.messages.findIndex((item) => messageMatchesDeletionTarget(item, messageId));
    if (index === -1) {
      markDeletedMessageAliases(messageId, extractP2PFileIdFromMessageId(messageId));
      return;
    }
    const removed = entry.messages.splice(index, 1)[0];
    const removedId = removed?.id || messageId;
    const removedFileId = removed?.attachment?.fileId || extractP2PFileIdFromMessageId(removedId) || extractP2PFileIdFromMessageId(messageId);
    if (removed?.id) chatState.messageIndex.delete(removed.id);
    chatState.messageIndex.delete(messageId);
    buildP2PDeletionAliases(removedId, removedFileId).forEach((alias) => {
      chatState.messageIndex.delete(alias);
    });
    markDeletedMessageAliases(removedId, removedFileId);
    markDeletedMessageAliases(messageId, removedFileId);
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
    notify('message', {
      peer: normalizedPeer,
      removedMessageId: removedId,
      removedMessageIds: buildP2PDeletionAliases(removedId, removedFileId).concat(
        messageId && messageId !== removedId ? [messageId] : []
      ),
      removedFileId: removedFileId || null,
    });
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

  // חלק החלפת temp (chat-state.js) – מחליף הודעת optimistic ב-ID אמיתי בלי כפילות ב-UI | HYPER CORE TECH
  function replaceOutgoingTempMessage(tempId, realMessage) {
    if (!tempId || !realMessage?.id) return false;
    const self = (App.publicKey || '').toLowerCase();
    const peer = (realMessage.to || '').toLowerCase() || (realMessage.from || '').toLowerCase();
    const key = getConversationKey(self, peer);
    if (!key) {
      appendMessageToConversation(realMessage);
      return false;
    }
    let entry = chatState.conversations.get(key);
    if (!entry) {
      appendMessageToConversation(realMessage);
      return false;
    }
    // אם ההודעה האמיתית כבר קיימת – רק מוחקים את ה-temp | HYPER CORE TECH
    const realIdx = entry.messages.findIndex((item) => item.id === realMessage.id);
    const tempIdx = entry.messages.findIndex((item) => item.id === tempId);
    if (realIdx !== -1) {
      if (tempIdx !== -1) {
        entry.messages.splice(tempIdx, 1);
        chatState.messageIndex.delete(tempId);
        persistState();
        notify('message', { peer: entry.peer, removedMessageId: tempId, replacedTempId: tempId, message: entry.messages[Math.min(realIdx, entry.messages.length - 1)] });
      }
      return true;
    }
    if (tempIdx === -1) {
      appendMessageToConversation(realMessage);
      return false;
    }
    entry.messages[tempIdx] = realMessage;
    chatState.messageIndex.delete(tempId);
    chatState.messageIndex.set(realMessage.id, { peer: entry.peer, key });
    entry.messages.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    persistState();
    notify('message', { peer: entry.peer, message: realMessage, replacedTempId: tempId });
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
    getChatRetentionCutoffTs,
    pruneExpiredChatHistory,
    CHAT_RETENTION_SECONDS,
    DISAPPEARING_DEFAULT_SEC,
    getDisappearingTimerSec,
    setDisappearingTimerSec,
    prunePeerDisappearingMessages,
    ensureDisappearingIntroNotice,
    appendDisappearingSystemNotice,
    refreshDisappearingSystemNotices,
    buildDisappearingNoticeContent,
    isSystemChatMessage,
    formatDisappearingTimerLabel,
    updateChatMessageStatus: updateMessageStatus,
    replaceOutgoingTempMessage,
  });

  // חלק המתנה ל-restore (chat-state.js) – Promise שמאפשר ל-chat-service להמתין לטעינת הקאש | HYPER CORE TECH
  let _restoreStateResolve = null;
  App.chatStateReady = new Promise((resolve) => {
    _restoreStateResolve = resolve;
  });

  async function doRestoreAndSignal() {
    await restoreState();
    try { refreshDisappearingSystemNotices(); } catch (_) {}
    try { pruneExpiredChatHistory(); } catch (_) {}
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
