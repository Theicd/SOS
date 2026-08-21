(function initP2PEventSync(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const DB_NAME = 'SOS2P2PEventSync';
  const DB_VERSION = 1;
  const STORE_NAME = 'events';

  const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 יום — פוסטים צבורים חייבים להישאר לשיתוף | HYPER CORE TECH
  const INV_LIMIT = 600;
  const MAX_IDS_PER_REQ = 250;
  const MAX_EVENTS_PER_RES = 40;
  const MIN_INV_INTERVAL_MS = 2500;

  let db = null;
  let dbDisabled = false;

  const state = {
    channels: new Map(),
    lastInvSentAt: new Map(),
    stats: {
      ingested: 0,
      invalid: 0,
      stored: 0,
      invSent: 0,
      invRecv: 0,
      reqSent: 0,
      reqRecv: 0,
      resSent: 0,
      resRecv: 0,
    },
  };

  function log(level, message, data) {
    const color = level === 'error' ? '#F44336' : level === 'warn' ? '#FF9800' : '#607D8B';
    if (data !== undefined) {
      console.log('%c[P2PEventSync] ' + message, 'color:' + color + ';font-weight:bold', data);
      return;
    }
    console.log('%c[P2PEventSync] ' + message, 'color:' + color + ';font-weight:bold');
  }

  function reqP(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function openDB() {
    if (dbDisabled) return null;
    if (db) return db;
    if (typeof indexedDB === 'undefined') {
      dbDisabled = true;
      return null;
    }

    return new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        dbDisabled = true;
        resolve(null);
      };

      request.onsuccess = () => {
        db = request.result;
        resolve(db);
      };

      request.onupgradeneeded = (event) => {
        const database = event.target.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('created_at', 'created_at', { unique: false });
          store.createIndex('expiresAt', 'expiresAt', { unique: false });
        }
      };
    });
  }

  function isEventLike(value) {
    return !!(
      value &&
      typeof value === 'object' &&
      typeof value.id === 'string' &&
      typeof value.pubkey === 'string' &&
      typeof value.sig === 'string' &&
      typeof value.content === 'string' &&
      typeof value.kind === 'number' &&
      typeof value.created_at === 'number' &&
      Array.isArray(value.tags)
    );
  }

  function verifyEventSafe(event) {
    try {
      const tools = window.NostrTools;
      if (tools && typeof tools.verifyEvent === 'function') {
        return tools.verifyEvent(event);
      }
    } catch (err) {
      return false;
    }
    return true;
  }

  async function putEvent(event, source) {
    const database = await openDB();
    if (!database) return false;

    const record = {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
      receivedAt: Date.now(),
      expiresAt: Date.now() + TTL_MS,
      source: source || '',
    };

    try {
      const tx = database.transaction([STORE_NAME], 'readwrite');
      await reqP(tx.objectStore(STORE_NAME).put(record));
      state.stats.stored++;
      return true;
    } catch (err) {
      log('warn', 'IDB put failed', err?.message || String(err));
      return false;
    }
  }

  async function ingestEvent(event, meta = {}) {
    if (!isEventLike(event)) return false;
    if (event.kind === 30078) return false;

    state.stats.ingested++;

    if (!verifyEventSafe(event)) {
      state.stats.invalid++;
      log('warn', '❌ invalid event signature', { id: event.id?.slice?.(0, 12), kind: event.kind });
      return false;
    }

    return putEvent(event, meta.source || 'unknown');
  }

  async function cleanupExpired(limit = 500) {
    if (typeof IDBKeyRange === 'undefined') return 0;

    const database = await openDB();
    if (!database) return 0;

    const tx = database.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('expiresAt');
    const range = IDBKeyRange.upperBound(Date.now());

    return new Promise((resolve) => {
      let deleted = 0;
      const request = index.openCursor(range);
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor || deleted >= limit) {
          resolve(deleted);
          return;
        }
        cursor.delete();
        deleted++;
        cursor.continue();
      };
      request.onerror = () => resolve(deleted);
    });
  }

  function isRootFeedPost(ev) {
    if (!ev || ev.kind !== 1 || !ev.id) return false;
    return !(Array.isArray(ev.tags) && ev.tags.some((t) => Array.isArray(t) && t[0] === 'e'));
  }

  function eventFromPostsById(id) {
    try {
      const ev = App.postsById instanceof Map ? App.postsById.get(id) : null;
      return isEventLike(ev) ? ev : null;
    } catch (_) {
      return null;
    }
  }

  function localFeedIdSet() {
    try {
      if (typeof App.getLocalFeedPostIds === 'function') {
        return new Set(App.getLocalFeedPostIds() || []);
      }
    } catch (_) {}
    return new Set();
  }

  async function listRecentIds(limit = INV_LIMIT) {
    // רק פוסטי פיד (kind:1 root) — לא לייקים/תגובות. זה הבסיס לשיתוף בין משתמשים | HYPER CORE TECH
    const seen = new Set();
    const postIds = [];

    const pushId = (id) => {
      if (!id || seen.has(id) || postIds.length >= limit) return;
      seen.add(id);
      postIds.push(id);
    };

    try {
      if (App.postsById instanceof Map) {
        const mem = Array.from(App.postsById.values())
          .filter(isRootFeedPost)
          .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        mem.forEach((ev) => pushId(ev.id));
      }
    } catch (_) {}

    if (postIds.length >= limit) return postIds.slice(0, limit);

    const database = await openDB();
    if (!database) return postIds;

    return new Promise((resolve) => {
      const tx = database.transaction([STORE_NAME], 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('created_at');
      const request = index.openCursor(null, 'prev');
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor || postIds.length >= limit) {
          resolve(postIds.slice(0, limit));
          return;
        }
        const rec = cursor.value;
        if (rec && isRootFeedPost(rec)) pushId(rec.id);
        cursor.continue();
      };
      request.onerror = () => resolve(postIds.slice(0, limit));
    });
  }

  async function missingIds(database, ids) {
    const unique = Array.from(new Set(ids)).slice(0, MAX_IDS_PER_REQ);
    const haveFeed = localFeedIdSet();
    const store = database
      ? database.transaction([STORE_NAME], 'readonly').objectStore(STORE_NAME)
      : null;

    const checks = unique.map(
      (id) =>
        new Promise((resolve) => {
          if (haveFeed.has(id) || eventFromPostsById(id)) {
            resolve(null);
            return;
          }
          if (!store) {
            resolve(id);
            return;
          }
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result ? null : id);
          req.onerror = () => resolve(id);
        })
    );

    const results = await Promise.all(checks);
    return results.filter(Boolean);
  }

  async function loadRecords(database, ids) {
    const unique = Array.from(new Set(ids)).slice(0, MAX_IDS_PER_REQ);
    const out = [];
    const needIdb = [];

    unique.forEach((id) => {
      const mem = eventFromPostsById(id);
      if (mem) out.push(mem);
      else needIdb.push(id);
    });

    if (!database || !needIdb.length) return out;

    const store = database.transaction([STORE_NAME], 'readonly').objectStore(STORE_NAME);
    const fetches = needIdb.map(
      (id) =>
        new Promise((resolve) => {
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        })
    );
    const results = await Promise.all(fetches);
    results.filter(Boolean).forEach((r) => out.push(r));
    return out;
  }

  function sendJson(channel, payload) {
    if (!channel || channel.readyState !== 'open') return false;
    try {
      channel.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      return false;
    }
  }

  async function sendInventory(peerPubkey, channel) {
    if (!peerPubkey || !channel || channel.readyState !== 'open') return false;

    const now = Date.now();
    const last = state.lastInvSentAt.get(peerPubkey) || 0;
    if (now - last < MIN_INV_INTERVAL_MS) return false;
    state.lastInvSentAt.set(peerPubkey, now);

    const ids = await listRecentIds();
    if (!ids.length) {
      log('warn', 'INV skipped — no local feed posts to share');
      return false;
    }

    const ok = sendJson(channel, { type: 'p2p-event-inv', ids, ts: now, feedOnly: true });
    if (ok) {
      state.stats.invSent++;
      log('info', '📤 INV sent (feed posts)', { to: peerPubkey.slice(0, 8), ids: ids.length });
    }
    return ok;
  }

  async function handleInv(msg, senderPubkey, channel) {
    state.stats.invRecv++;
    if (!Array.isArray(msg.ids) || msg.ids.length === 0) return true;

    const database = await openDB();
    // כל ה־ids החסרים — נבקש במנות | HYPER CORE TECH
    const allMissing = [];
    const chunkSize = MAX_IDS_PER_REQ;
    for (let i = 0; i < msg.ids.length; i += chunkSize) {
      const slice = msg.ids.slice(i, i + chunkSize);
      const miss = await missingIds(database, slice);
      allMissing.push(...miss);
    }
    if (!allMissing.length) {
      log('info', 'INV — nothing missing', { from: senderPubkey.slice(0, 8), offered: msg.ids.length });
      return true;
    }

    for (let i = 0; i < allMissing.length; i += MAX_IDS_PER_REQ) {
      const reqIds = allMissing.slice(i, i + MAX_IDS_PER_REQ);
      const ok = sendJson(channel, { type: 'p2p-event-req', ids: reqIds, ts: Date.now() });
      if (ok) {
        state.stats.reqSent++;
        log('info', '📤 REQ sent', { to: senderPubkey.slice(0, 8), ids: reqIds.length, batch: i / MAX_IDS_PER_REQ + 1 });
      }
    }

    return true;
  }

  async function handleReq(msg, senderPubkey, channel) {
    state.stats.reqRecv++;
    if (!Array.isArray(msg.ids) || msg.ids.length === 0) return true;

    const database = await openDB();
    const records = await loadRecords(database, msg.ids);
    if (!records.length) {
      log('warn', 'REQ — no events to serve', { to: senderPubkey.slice(0, 8), asked: msg.ids.length });
      return true;
    }

    for (let i = 0; i < records.length; i += MAX_EVENTS_PER_RES) {
      const batch = records.slice(i, i + MAX_EVENTS_PER_RES).map((r) => ({
        id: r.id,
        pubkey: r.pubkey,
        created_at: r.created_at,
        kind: r.kind,
        tags: r.tags,
        content: r.content,
        sig: r.sig,
      }));
      const ok = sendJson(channel, { type: 'p2p-event-res', events: batch, ts: Date.now() });
      if (ok) {
        state.stats.resSent++;
      }
    }

    log('info', '📤 RES sent', { to: senderPubkey.slice(0, 8), events: records.length, asked: msg.ids.length });
    return true;
  }

  async function handleRes(msg, senderPubkey) {
    state.stats.resRecv++;
    if (!Array.isArray(msg.events) || msg.events.length === 0) return true;

    let stored = 0;
    const newPosts = [];
    const newLikes = [];
    const newComments = [];

    for (const ev of msg.events) {
      if (!isEventLike(ev) || !verifyEventSafe(ev)) continue;
      const ok = await ingestEvent(ev, { source: 'p2p:' + senderPubkey.slice(0, 8) });
      if (ok) stored++;
      try {
        if (!(App.postsById instanceof Map)) App.postsById = new Map();
        App.postsById.set(ev.id, ev);
      } catch (_) {}

      if (ev.kind === 1) {
        const hasETag = Array.isArray(ev.tags) && ev.tags.some((t) => t[0] === 'e');
        if (hasETag) newComments.push(ev);
        else newPosts.push(ev);
      } else if (ev.kind === 7) {
        newLikes.push(ev);
      }
    }

    if (newLikes.length > 0 && typeof App.registerLike === 'function') {
      newLikes.forEach((like) => App.registerLike(like));
    }
    if (newComments.length > 0 && typeof App.registerComment === 'function') {
      newComments.forEach((comment) => {
        const eTag = Array.isArray(comment.tags) && comment.tags.find((t) => t[0] === 'e');
        if (eTag && eTag[1]) App.registerComment(comment, eTag[1]);
      });
    }

    log('info', '📥 RES received', {
      from: senderPubkey.slice(0, 8),
      events: msg.events.length,
      stored,
      newPosts: newPosts.length,
      newLikes: newLikes.length,
    });

    if (newPosts.length > 0) {
      try {
        if (typeof App.onP2PFeedEvents === 'function') {
          const added = App.onP2PFeedEvents(newPosts);
          log('info', '📥 merged into video feed', { added: added || 0, posts: newPosts.length });
        }
      } catch (err) {
        log('warn', 'onP2PFeedEvents failed', err?.message || String(err));
      }
    }
    return true;
  }

  async function handleIncomingMessage(msg, senderPubkey, channel) {
    if (!msg || msg.type === undefined) return false;

    if (msg.type === 'p2p-event-inv') {
      return handleInv(msg, senderPubkey, channel);
    }
    if (msg.type === 'p2p-event-req') {
      return handleReq(msg, senderPubkey, channel);
    }
    if (msg.type === 'p2p-event-res') {
      return handleRes(msg, senderPubkey);
    }

    return false;
  }

  function attachChannel(peerPubkey, channel) {
    if (!peerPubkey || !channel) return;
    state.channels.set(peerPubkey, channel);
    // כל חיבור חדש — שיתוף רשימת פוסטים מיד (בלי throttle מהחיבור הקודם) | HYPER CORE TECH
    state.lastInvSentAt.delete(peerPubkey);
    sendInventory(peerPubkey, channel);
    setTimeout(() => {
      try {
        state.lastInvSentAt.delete(peerPubkey);
        sendInventory(peerPubkey, channel);
      } catch (_) {}
    }, 3500);
  }

  function detachChannel(peerPubkey) {
    if (!peerPubkey) return;
    state.channels.delete(peerPubkey);
    state.lastInvSentAt.delete(peerPubkey);
  }

  function getConnectedPeers() {
    return Array.from(state.channels.keys());
  }

  function getStats() {
    return Object.assign({ channels: state.channels.size, dbDisabled }, state.stats);
  }

  // חלק cache (p2p-event-sync.js) – טעינת פוסטים מה-DB לפי kind | HYPER CORE TECH
  async function loadCachedEvents(options = {}) {
    const database = await openDB();
    if (!database) return [];

    const { kinds = [1], limit = 100, since = 0, until = Number.MAX_SAFE_INTEGER } = options;
    const kindsSet = new Set(kinds);
    const untilTs = Number.isFinite(Number(until)) ? Number(until) : Number.MAX_SAFE_INTEGER;

    return new Promise((resolve) => {
      const results = [];
      const tx = database.transaction([STORE_NAME], 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('created_at');

      const request = index.openCursor(null, 'prev');
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor || results.length >= limit) {
          resolve(results);
          return;
        }
        const rec = cursor.value;
        if (
          rec &&
          kindsSet.has(rec.kind) &&
          rec.created_at >= since &&
          rec.created_at < untilTs
        ) {
          results.push({
            id: rec.id,
            pubkey: rec.pubkey,
            created_at: rec.created_at,
            kind: rec.kind,
            tags: rec.tags,
            content: rec.content,
            sig: rec.sig,
          });
        }
        cursor.continue();
      };
      request.onerror = () => resolve(results);
    });
  }

  // חלק cache (p2p-event-sync.js) – טעינת לייקים/תגובות לפוסטים ספציפיים | HYPER CORE TECH
  async function loadEngagementForPosts(postIds = []) {
    if (!postIds.length) return { likes: [], comments: [] };
    const database = await openDB();
    if (!database) return { likes: [], comments: [] };

    const postIdSet = new Set(postIds);
    const likes = [];
    const comments = [];

    return new Promise((resolve) => {
      const tx = database.transaction([STORE_NAME], 'readonly');
      const store = tx.objectStore(STORE_NAME);

      const request = store.openCursor();
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) {
          resolve({ likes, comments });
          return;
        }
        const rec = cursor.value;
        if (rec) {
          if (rec.kind === 7 && Array.isArray(rec.tags)) {
            const eTag = rec.tags.find(t => t[0] === 'e');
            if (eTag && postIdSet.has(eTag[1])) {
              likes.push(rec);
            }
          } else if (rec.kind === 1 && Array.isArray(rec.tags)) {
            const eTag = rec.tags.find(t => t[0] === 'e');
            if (eTag && postIdSet.has(eTag[1])) {
              comments.push(rec);
            }
          }
        }
        cursor.continue();
      };
      request.onerror = () => resolve({ likes, comments });
    });
  }

  App.EventSync = App.EventSync || {};
  Object.assign(App.EventSync, {
    ingestEvent,
    handleIncomingMessage,
    attachChannel,
    detachChannel,
    sendInventory: async (peerPubkey) => {
      const ch = state.channels.get(peerPubkey);
      if (!ch) return false;
      state.lastInvSentAt.delete(peerPubkey);
      return sendInventory(peerPubkey, ch);
    },
    getStats,
    getConnectedPeers,
    loadCachedEvents,
    loadEngagementForPosts,
    listFeedPostIds: listRecentIds,
  });

  if (!App._p2pEventSyncBootstrapped) {
    App._p2pEventSyncBootstrapped = true;
    setInterval(() => {
      cleanupExpired().catch(() => {});
    }, 60000);
  }
})(window);
