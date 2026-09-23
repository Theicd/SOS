/**
 * Strict Nostr event integrity — canonical hash must equal event.id, then sig verify.
 * Never trust Symbol(verified) cache alone.
 * Host: optional dedicated verify Worker + bounded queue (verify-only; no private keys).
 * HYPER CORE TECH — Stage 5E / off-main-thread verify
 */
(function initNostrEventIntegrity(root) {
  const App = root.NostrApp || (root.NostrApp = {});
  const NT = root.NostrTools;

  const HEX64 = /^[0-9a-f]{64}$/i;
  const HEX128 = /^[0-9a-f]{128}$/i;
  const MAX_CONTENT_CHARS = 256 * 1024;
  const MAX_TAGS = 512;
  const MAX_TAG_ITEMS = 32;
  const MAX_TAG_ITEM_LEN = 4096;

  // Queue / backpressure (host only)
  const VERIFY_QUEUE_MAX = 2048;
  const VERIFY_BATCH_SIZE = 24;
  const WORKER_TIMEOUT_MS = 8000;
  const HIGH_PRIORITY_KINDS = new Set([
    1050, 1051, 1054, 1059, 5, 13,
    25050, 25055, 30078,
    37378, 37379, 37380, 39002,
  ]);

  function reasonLog(kind, pubkey, code) {
    try {
      const k = kind != null ? String(kind) : '';
      const fp = typeof pubkey === 'string' ? pubkey.slice(0, 8) : '';
      console.warn('[SO-CALL SECURITY] rejected event reason=' + code + ' kind=' + k + ' pubkey=' + fp);
    } catch (_e) {}
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /** Build a clean host-realm event without Symbol(verified) or prototype junk. */
  function canonicalizeEvent(event) {
    if (!isPlainObject(event)) return null;
    if (Object.prototype.toString.call(event) !== '[object Object]' && !(event instanceof Object)) {
      // Still allow plain objects from JSON / structured clone
    }
    if (typeof event.id !== 'string' || !HEX64.test(event.id)) return null;
    if (typeof event.pubkey !== 'string' || !HEX64.test(event.pubkey)) return null;
    if (typeof event.sig !== 'string' || !HEX128.test(event.sig)) return null;
    if (typeof event.kind !== 'number' || !Number.isFinite(event.kind) || !Number.isInteger(event.kind)) {
      return null;
    }
    if (typeof event.created_at !== 'number' || !Number.isFinite(event.created_at) || !Number.isInteger(event.created_at)) {
      return null;
    }
    if (typeof event.content !== 'string') return null;
    if (event.content.length > MAX_CONTENT_CHARS) return null;
    if (!Array.isArray(event.tags)) return null;
    if (event.tags.length > MAX_TAGS) return null;
    let tags;
    try {
      tags = JSON.parse(JSON.stringify(event.tags));
    } catch (_e) {
      return null;
    }
    if (!Array.isArray(tags) || tags.length > MAX_TAGS) return null;
    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i];
      if (!Array.isArray(tag) || tag.length > MAX_TAG_ITEMS) return null;
      for (let j = 0; j < tag.length; j++) {
        if (typeof tag[j] !== 'string') return null;
        if (tag[j].length > MAX_TAG_ITEM_LEN) return null;
      }
    }
    return {
      id: event.id.toLowerCase(),
      pubkey: event.pubkey.toLowerCase(),
      created_at: event.created_at,
      kind: event.kind,
      tags,
      content: event.content,
      sig: event.sig.toLowerCase(),
    };
  }

  function freezeSnapshot(clean) {
    if (!clean) return null;
    const snap = {
      id: clean.id,
      pubkey: clean.pubkey,
      created_at: clean.created_at,
      kind: clean.kind,
      tags: clean.tags,
      content: clean.content,
      sig: clean.sig,
    };
    try {
      Object.freeze(snap.tags);
      for (let i = 0; i < snap.tags.length; i++) {
        try { Object.freeze(snap.tags[i]); } catch (_e) {}
      }
      Object.freeze(snap);
    } catch (_e2) {}
    return snap;
  }

  /**
   * Core strict verify against a tools object { getEventHash, verifyEvent }.
   * Returns { ok, reason, snapshot }.
   */
  function strictVerifyWithTools(event, tools) {
    if (!tools || typeof tools.getEventHash !== 'function' || typeof tools.verifyEvent !== 'function') {
      return { ok: false, reason: 'MALFORMED_EVENT', snapshot: null };
    }
    const clean = canonicalizeEvent(event);
    if (!clean) {
      return { ok: false, reason: 'MALFORMED_EVENT', snapshot: null };
    }
    let computedId;
    try {
      computedId = tools.getEventHash(clean);
    } catch (_e) {
      return { ok: false, reason: 'MALFORMED_EVENT', snapshot: null };
    }
    if (typeof computedId !== 'string' || !HEX64.test(computedId)) {
      return { ok: false, reason: 'MALFORMED_EVENT', snapshot: null };
    }
    if (computedId.toLowerCase() !== clean.id) {
      return { ok: false, reason: 'HASH_MISMATCH', snapshot: null };
    }
    let sigOk = false;
    try {
      // Fresh object: no Symbol(verified) from a prior verify-then-mutate attack.
      sigOk = tools.verifyEvent({
        id: clean.id,
        pubkey: clean.pubkey,
        created_at: clean.created_at,
        kind: clean.kind,
        tags: clean.tags,
        content: clean.content,
        sig: clean.sig,
      }) === true;
    } catch (_e2) {
      sigOk = false;
    }
    if (!sigOk) {
      return { ok: false, reason: 'INVALID_SIGNATURE', snapshot: null };
    }
    return { ok: true, reason: 'OK', snapshot: freezeSnapshot(clean) };
  }

  function getTools() {
    return root.NostrTools || NT;
  }

  /**
   * strictVerifyNostrEvent(event) → boolean
   * Sync strict path (same crypto). Used by security-critical sync callers and
   * as the ONLY worker-failure fallback. Never weakens to cache-only verify.
   */
  function strictVerifyNostrEvent(event) {
    const result = strictVerifyWithTools(event, getTools());
    if (!result.ok) {
      reasonLog(event && event.kind, event && event.pubkey, result.reason);
      return false;
    }
    return true;
  }

  function strictVerifyNostrEventDetailed(event) {
    const result = strictVerifyWithTools(event, getTools());
    if (!result.ok) {
      reasonLog(event && event.kind, event && event.pubkey, result.reason);
    }
    return result;
  }

  // Alias for AC modules that historically looked for verifyEventStrict
  function verifyEventStrict(event) {
    return strictVerifyNostrEvent(event);
  }

  // ---------- Worker mode (dedicated verify Worker; no private keys) ----------
  const isWorkerContext =
    typeof WorkerGlobalScope !== 'undefined' &&
    typeof root.importScripts === 'function' &&
    typeof root.document === 'undefined';

  if (isWorkerContext || root.NOSTR_INTEGRITY_WORKER_MODE === true) {
    root.onmessage = function onVerifyWorkerMessage(ev) {
      const msg = ev && ev.data;
      if (!msg || typeof msg !== 'object') return;
      const id = msg.id;
      const type = msg.type;
      try {
        if (type === 'ping') {
          root.postMessage({ id, type: 'pong', ok: true });
          return;
        }
        if (type === 'verify') {
          const result = strictVerifyWithTools(msg.event, getTools());
          root.postMessage({
            id,
            type: 'verifyResult',
            ok: result.ok === true,
            reason: result.reason || '',
            snapshot: result.ok ? result.snapshot : null,
          });
          return;
        }
        if (type === 'verifyBatch') {
          const events = Array.isArray(msg.events) ? msg.events : [];
          const results = [];
          for (let i = 0; i < events.length; i++) {
            const r = strictVerifyWithTools(events[i], getTools());
            results.push({
              ok: r.ok === true,
              reason: r.reason || '',
              snapshot: r.ok ? r.snapshot : null,
            });
          }
          root.postMessage({ id, type: 'verifyBatchResult', results });
          return;
        }
        root.postMessage({ id, type: 'error', ok: false, reason: 'UNKNOWN_TYPE' });
      } catch (err) {
        root.postMessage({
          id,
          type: 'error',
          ok: false,
          reason: 'WORKER_EXCEPTION',
        });
      }
    };
    try {
      root.postMessage({ type: 'ready', ok: true });
    } catch (_e) {}
    return;
  }

  // ---------- Host: Worker + bounded queue ----------
  let worker = null;
  let workerReady = false;
  let workerBroken = false;
  let nextReqId = 1;
  const pending = new Map();
  const highQueue = [];
  const normalQueue = [];
  let drainScheduled = false;
  let inFlight = 0;
  const MAX_IN_FLIGHT = 2;
  const stats = {
    enqueued: 0,
    dropped: 0,
    workerOk: 0,
    fallbackMain: 0,
    rejected: 0,
  };

  function queueDepth() {
    return highQueue.length + normalQueue.length;
  }

  function resolvePending(reqId, payload) {
    const entry = pending.get(reqId);
    if (!entry) return;
    pending.delete(reqId);
    try { clearTimeout(entry.timer); } catch (_e) {}
    try { entry.resolve(payload); } catch (_e2) {}
  }

  function rejectPending(reqId, reason) {
    resolvePending(reqId, { ok: false, reason: reason || 'REJECTED', snapshot: null, via: 'reject' });
  }

  function killWorker(reason) {
    workerBroken = true;
    workerReady = false;
    try {
      if (worker) worker.terminate();
    } catch (_e) {}
    worker = null;
    const ids = Array.from(pending.keys());
    for (let i = 0; i < ids.length; i++) {
      rejectPending(ids[i], reason || 'WORKER_DEAD');
    }
  }

  function ensureWorker() {
    if (workerBroken) return null;
    if (worker) return worker;
    if (typeof Worker === 'undefined') {
      workerBroken = true;
      return null;
    }
    try {
      worker = new Worker('./nostr-verify-worker.js');
      worker.onmessage = function (ev) {
        const msg = ev && ev.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') {
          workerReady = true;
          scheduleDrain();
          return;
        }
        if (msg.type === 'pong') {
          workerReady = true;
          return;
        }
        if (msg.type === 'verifyResult') {
          inFlight = Math.max(0, inFlight - 1);
          if (msg.ok === true && msg.snapshot) {
            stats.workerOk += 1;
            resolvePending(msg.id, {
              ok: true,
              reason: 'OK',
              snapshot: freezeSnapshot(msg.snapshot),
              via: 'worker',
            });
          } else {
            stats.rejected += 1;
            resolvePending(msg.id, {
              ok: false,
              reason: msg.reason || 'INVALID',
              snapshot: null,
              via: 'worker',
            });
          }
          scheduleDrain();
          return;
        }
        if (msg.type === 'verifyBatchResult') {
          inFlight = Math.max(0, inFlight - 1);
          const entry = pending.get(msg.id);
          if (!entry) {
            scheduleDrain();
            return;
          }
          pending.delete(msg.id);
          try { clearTimeout(entry.timer); } catch (_e) {}
          const results = Array.isArray(msg.results) ? msg.results : [];
          const jobs = entry.jobs || [];
          for (let i = 0; i < jobs.length; i++) {
            const r = results[i] || { ok: false, reason: 'MISSING_RESULT', snapshot: null };
            if (r.ok === true && r.snapshot) {
              stats.workerOk += 1;
              jobs[i].resolve({
                ok: true,
                reason: 'OK',
                snapshot: freezeSnapshot(r.snapshot),
                via: 'worker',
              });
            } else {
              stats.rejected += 1;
              jobs[i].resolve({
                ok: false,
                reason: r.reason || 'INVALID',
                snapshot: null,
                via: 'worker',
              });
            }
          }
          scheduleDrain();
          return;
        }
        if (msg.type === 'error') {
          inFlight = Math.max(0, inFlight - 1);
          rejectPending(msg.id, msg.reason || 'WORKER_ERROR');
          scheduleDrain();
        }
      };
      worker.onerror = function () {
        killWorker('WORKER_ERROR');
      };
      worker.onmessageerror = function () {
        killWorker('WORKER_MESSAGE_ERROR');
      };
      return worker;
    } catch (_e) {
      workerBroken = true;
      worker = null;
      return null;
    }
  }

  function verifyOnMainThreadStrict(event) {
    stats.fallbackMain += 1;
    return strictVerifyNostrEventDetailed(event);
  }

  function scheduleDrain() {
    if (drainScheduled) return;
    drainScheduled = true;
    const run = function () {
      drainScheduled = false;
      drainQueue();
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(run);
    else setTimeout(run, 0);
  }

  function drainQueue() {
    const w = ensureWorker();
    if (!w || !workerReady || workerBroken) {
      // Strict main-thread fallback only — never weaker verification.
      while (highQueue.length || normalQueue.length) {
        const job = highQueue.length ? highQueue.shift() : normalQueue.shift();
        if (!job) break;
        const result = verifyOnMainThreadStrict(job.event);
        job.resolve({
          ok: result.ok === true,
          reason: result.reason,
          snapshot: result.snapshot,
          via: 'main-fallback',
        });
      }
      return;
    }
    while (inFlight < MAX_IN_FLIGHT && (highQueue.length || normalQueue.length)) {
      const batch = [];
      while (batch.length < VERIFY_BATCH_SIZE && (highQueue.length || normalQueue.length)) {
        batch.push(highQueue.length ? highQueue.shift() : normalQueue.shift());
      }
      if (!batch.length) break;
      const reqId = nextReqId++;
      inFlight += 1;
      const timer = setTimeout(function () {
        // Timeout: do not accept; fall back strictly on main for these jobs only.
        if (!pending.has(reqId)) return;
        pending.delete(reqId);
        inFlight = Math.max(0, inFlight - 1);
        for (let i = 0; i < batch.length; i++) {
          const result = verifyOnMainThreadStrict(batch[i].event);
          batch[i].resolve({
            ok: result.ok === true,
            reason: result.reason,
            snapshot: result.snapshot,
            via: 'main-fallback-timeout',
          });
        }
        scheduleDrain();
      }, WORKER_TIMEOUT_MS);
      pending.set(reqId, { timer, jobs: batch, resolve: null });
      try {
        w.postMessage({
          id: reqId,
          type: 'verifyBatch',
          events: batch.map(function (j) { return j.event; }),
        });
      } catch (_postErr) {
        clearTimeout(timer);
        pending.delete(reqId);
        inFlight = Math.max(0, inFlight - 1);
        killWorker('WORKER_POST_FAILED');
        for (let i = 0; i < batch.length; i++) {
          const result = verifyOnMainThreadStrict(batch[i].event);
          batch[i].resolve({
            ok: result.ok === true,
            reason: result.reason,
            snapshot: result.snapshot,
            via: 'main-fallback',
          });
        }
        return;
      }
    }
  }

  function isHighPriority(event, opts) {
    if (opts && opts.priority === 'high') return true;
    if (opts && opts.priority === 'normal') return false;
    const kind = event && typeof event.kind === 'number' ? event.kind : -1;
    return HIGH_PRIORITY_KINDS.has(kind);
  }

  /**
   * Bounded async verify. Returns { ok, reason, snapshot, via }.
   * Application MUST apply snapshot only (TOCTOU-safe), never the raw input object.
   */
  function enqueueStrictVerify(event, opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    return new Promise(function (resolve) {
      const clean = canonicalizeEvent(event);
      if (!clean) {
        stats.rejected += 1;
        reasonLog(event && event.kind, event && event.pubkey, 'MALFORMED_EVENT');
        resolve({ ok: false, reason: 'MALFORMED_EVENT', snapshot: null, via: 'precheck' });
        return;
      }
      // Enqueue only plain data (structured-clone friendly).
      const wireEvent = {
        id: clean.id,
        pubkey: clean.pubkey,
        created_at: clean.created_at,
        kind: clean.kind,
        tags: clean.tags,
        content: clean.content,
        sig: clean.sig,
      };
      if (queueDepth() >= VERIFY_QUEUE_MAX) {
        stats.dropped += 1;
        reasonLog(clean.kind, clean.pubkey, 'VERIFY_QUEUE_FULL');
        resolve({ ok: false, reason: 'VERIFY_QUEUE_FULL', snapshot: null, via: 'backpressure' });
        return;
      }
      stats.enqueued += 1;
      const job = { event: wireEvent, resolve: resolve };
      if (isHighPriority(wireEvent, opts)) highQueue.push(job);
      else normalQueue.push(job);
      ensureWorker();
      scheduleDrain();
    });
  }

  function enqueueStrictVerifyBatch(events, opts) {
    const list = Array.isArray(events) ? events : [];
    return Promise.all(list.map(function (ev) {
      return enqueueStrictVerify(ev, opts);
    }));
  }

  function getVerifyQueueStats() {
    return {
      depth: queueDepth(),
      high: highQueue.length,
      normal: normalQueue.length,
      inFlight: inFlight,
      max: VERIFY_QUEUE_MAX,
      batchSize: VERIFY_BATCH_SIZE,
      workerReady: workerReady,
      workerBroken: workerBroken,
      stats: Object.assign({}, stats),
    };
  }

  // Warm worker early (non-blocking)
  try {
    if (typeof Worker !== 'undefined') {
      setTimeout(function () { ensureWorker(); }, 0);
    }
  } catch (_warm) {}

  App.strictVerifyNostrEvent = strictVerifyNostrEvent;
  App.verifyEventStrict = verifyEventStrict;
  App.strictVerifyNostrEventDetailed = strictVerifyNostrEventDetailed;
  App.enqueueStrictVerify = enqueueStrictVerify;
  App.enqueueStrictVerifyBatch = enqueueStrictVerifyBatch;

  root.NostrEventIntegrity = {
    strictVerifyNostrEvent: strictVerifyNostrEvent,
    verifyEventStrict: verifyEventStrict,
    strictVerifyNostrEventDetailed: strictVerifyNostrEventDetailed,
    canonicalizeEvent: canonicalizeEvent,
    enqueueStrictVerify: enqueueStrictVerify,
    enqueueStrictVerifyBatch: enqueueStrictVerifyBatch,
    getVerifyQueueStats: getVerifyQueueStats,
    VERIFY_QUEUE_MAX: VERIFY_QUEUE_MAX,
    VERIFY_BATCH_SIZE: VERIFY_BATCH_SIZE,
  };

  try {
    console.log('[NOSTR-INTEGRITY] strict verifier loaded (worker-capable)');
  } catch (_e) {}
})(typeof self !== 'undefined' ? self : globalThis);
