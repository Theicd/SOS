(function initP2PEventSync(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const DB_NAME = 'SOS2P2PEventSync';
  const DB_VERSION = 1;
  const STORE_NAME = 'events';

  const TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const INV_LIMIT = 300;
  const MAX_IDS_PER_REQ = 200;
  const MAX_EVENTS_PER_RES = 50;
  const MIN_INV_INTERVAL_MS = 5000;

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

  async function listRecentIds(limit = INV_LIMIT) {
    const database = await openDB();
    if (!database) return [];

    const tx = database.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('created_at');

    return new Promise((resolve) => {
      const ids = [];
      const request = index.openCursor(null, 'prev');
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor || ids.length >= limit) {
          resolve(ids);
          return;
        }
        if (cursor.value?.id) ids.push(cursor.value.id);
        cursor.continue();
      };
      request.onerror = () => resolve(ids);
    });
  }

  async function missingIds(database, ids) {
    const unique = Array.from(new Set(ids)).slice(0, MAX_IDS_PER_REQ);
    const store = database.transaction([STORE_NAME], 'readonly').objectStore(STORE_NAME);

    const checks = unique.map(
      (id) =>
        new Promise((resolve) => {
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
    const store = database.transaction([STORE_NAME], 'readonly').objectStore(STORE_NAME);

    const fetches = unique.map(
      (id) =>
        new Promise((resolve) => {
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        })
    );

    const results = await Promise.all(fetches);
    return results.filter(Boolean);
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
    if (!ids.length) return false;

    const ok = sendJson(channel, { type: 'p2p-event-inv', ids, ts: now });
    if (ok) {
      state.stats.invSent++;
      log('info', '📤 INV sent', { to: peerPubkey.slice(0, 8), ids: ids.length });
    }
    return ok;
  }

  async function handleInv(msg, senderPubkey, channel) {
    state.stats.invRecv++;
    if (!Array.isArray(msg.ids) || msg.ids.length === 0) return true;

    const database = await openDB();
    if (!database) return true;

    const missing = await missingIds(database, msg.ids);
    if (!missing.length) return true;

    const reqIds = missing.slice(0, MAX_IDS_PER_REQ);
    const ok = sendJson(channel, { type: 'p2p-event-req', ids: reqIds, ts: Date.now() });
    if (ok) {
      state.stats.reqSent++;
      log('info', '📤 REQ sent', { to: senderPubkey.slice(0, 8), ids: reqIds.length });
    }

    return true;
  }

  async function handleReq(msg, senderPubkey, channel) {
    state.stats.reqRecv++;
    if (!Array.isArray(msg.ids) || msg.ids.length === 0) return true;

    const database = await openDB();
    if (!database) return true;

    const records = await loadRecords(database, msg.ids);
    if (!records.length) return true;

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

    log('info', '📤 RES sent', { to: senderPubkey.slice(0, 8), events: records.length });
    return true;
  }

  async function handleRes(msg, senderPubkey) {
    state.stats.resRecv++;
    if (!Array.isArray(msg.events) || msg.events.length === 0) return true;

    let stored = 0;
    for (const ev of msg.events) {
      if (await ingestEvent(ev, { source: 'p2p:' + senderPubkey.slice(0, 8) })) {
        stored++;
      }
    }

    log('info', '📥 RES received', { from: senderPubkey.slice(0, 8), events: msg.events.length, stored });
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
    sendInventory(peerPubkey, channel);
  }

  function detachChannel(peerPubkey) {
    if (!peerPubkey) return;
    state.channels.delete(peerPubkey);
    state.lastInvSentAt.delete(peerPubkey);
  }

  function getStats() {
    return Object.assign({ channels: state.channels.size, dbDisabled }, state.stats);
  }

  // חלק קריאה מהירה (p2p-event-sync.js) – טעינת פוסטים מה-DB לתצוגה מיידית | HYPER CORE TECH
  async function loadCachedPosts(options = {}) {
    const { kinds = [1], limit = 50, networkTag = null } = options;
    const database = await openDB();
    if (!database) return [];

    const tx = database.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('created_at');

    return new Promise((resolve) => {
      const results = [];
      const request = index.openCursor(null, 'prev');
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor || results.length >= limit) {
          resolve(results);
          return;
        }
        const record = cursor.value;
        // סינון לפי kind
        if (kinds.includes(record.kind)) {
          // סינון לפי תג רשת אם נדרש
          if (networkTag) {
            const hasTag = Array.isArray(record.tags) && 
              record.tags.some(t => t[0] === 't' && t[1] === networkTag);
            if (hasTag) results.push(record);
          } else {
            results.push(record);
          }
        }
        cursor.continue();
      };
      request.onerror = () => resolve(results);
    });
  }

  // חלק קריאת לייקים (p2p-event-sync.js) – טעינת לייקים מה-DB | HYPER CORE TECH
  async function loadCachedLikes(eventIds = []) {
    if (!eventIds.length) return [];
    const database = await openDB();
    if (!database) return [];

    const tx = database.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);

    const results = [];
    for (const id of eventIds.slice(0, 200)) {
      try {
        const allRecords = await new Promise((resolve) => {
          const req = store.openCursor();
          const matches = [];
          req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) { resolve(matches); return; }
            const r = cursor.value;
            if (r.kind === 7 && Array.isArray(r.tags) && r.tags.some(t => t[0] === 'e' && t[1] === id)) {
              matches.push(r);
            }
            cursor.continue();
          };
          req.onerror = () => resolve(matches);
        });
        results.push(...allRecords);
      } catch (_) {}
    }
    return results;
  }

  // חלק timestamp אחרון (p2p-event-sync.js) – החזרת הזמן האחרון לצורך delta sync | HYPER CORE TECH
  async function getLastEventTimestamp() {
    const database = await openDB();
    if (!database) return 0;

    const tx = database.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('created_at');

    return new Promise((resolve) => {
      const request = index.openCursor(null, 'prev');
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        resolve(cursor?.value?.created_at || 0);
      };
      request.onerror = () => resolve(0);
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
      return sendInventory(peerPubkey, ch);
    },
    getStats,
    loadCachedPosts,
    loadCachedLikes,
    getLastEventTimestamp,
  });

  if (!App._p2pEventSyncBootstrapped) {
    App._p2pEventSyncBootstrapped = true;
    setInterval(() => {
      cleanupExpired().catch(() => {});
    }, 60000);
  }
})(window);
