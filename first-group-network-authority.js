/**
 * Package 898 — First group (israel-network) network-backed authority.
 *
 * Signed kind-39001 control events and kind-39003 membership events are fetched from the configured
 * relay pool and fed through the canonical stores (GroupControlState / MembershipState), which re-verify
 * every event (id, signature, kind, group binding, schema, issuer authority, chain / revision order).
 * localStorage stays a cache of signed events; it is never trusted on its own.
 *
 * Privileged first-group actions call reconcile() first and fail closed when no relay confirms the
 * current state (EOSE), when control is not VERIFIED, or on control conflict.
 *
 * Join admission is not decided here: single-use invites are consumed only by the canonical first-group
 * admission service (first-group-admission-client.js), which atomically claims the invite and signs the
 * membership proof with its ROOT-delegated key. No client-side / relay-order approval fallback exists.
 */
(function initFirstGroupNetworkAuthority(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const GROUP_ID = 'israel-network';
  const KIND_CONTROL = 39001;
  const KIND_MEMBERSHIP = 39003;
  const KIND_ATTESTATION = 39004;
  const MAX_ATTESTATIONS = 4000;
  const QUERY_TIMEOUT_MS = 6000;
  const CONNECT_TIMEOUT_MS = 4000;
  const POLL_INTERVAL_MS = 15000;
  const LIVE_DEBOUNCE_MS = 150;

  const NETWORK_AUTHORITY_MODEL =
    'Relays are transport. Authority = deterministic reconstruction of every valid signed 39001/39003 event ' +
    'fetched from the relay pool (plus locally held signed events), re-verified by the canonical stores.';
  const DOUBLE_REDEEM_MODEL =
    'Single-use invite redemption is serialized by the canonical admission service: one Durable Object per ' +
    'invite performs an atomic UNUSED -> CLAIMED compare-and-set; relays and clients never pick a winner.';

  const state = {
    status: 'IDLE',
    everSynced: false,
    lastOkAt: 0,
    lastError: null,
    relaysOk: 0,
    relaysTotal: 0,
    lastCodes: [],
    lastLatencyMs: null,
    controlEvents: 0,
    membershipEvents: 0,
    fingerprint: '',
  };
  const networkEvents = new Map();
  const attestations = new Map();
  let inflight = null;
  let started = false;
  let pollTimer = null;
  let liveSub = null;
  let liveTimer = null;

  function isV2() {
    return window.SOS_ACCESS_CONTROL_V2 === true;
  }
  function GCS() {
    return App.GroupControlState || window.SosGroupControlState || null;
  }
  function MS() {
    return App.MembershipState || window.SosMembershipState || null;
  }
  function relayList() {
    const list = typeof App.getWritableRelays === 'function' ? App.getWritableRelays() : App.relayUrls;
    return Array.isArray(list) ? list.filter((u) => typeof u === 'string' && u) : [];
  }

  function notify(reason) {
    try {
      window.dispatchEvent(new CustomEvent('sos-first-group-state-changed', { detail: { reason } }));
    } catch (_e) {}
  }

  /** nostr-tools 2.7.2 keeps a relay whose first connect failed with a permanently rejected promise; evict it so a later attempt reconnects. */
  function dropDeadRelay(pool, url) {
    try {
      const map = pool.relays;
      if (!map || typeof map.forEach !== 'function') return;
      const base = String(url).replace(/\/+$/, '');
      map.forEach((r, key) => {
        if (String(key).replace(/\/+$/, '') === base && !(r && r.connected === true)) map.delete(key);
      });
    } catch (_e) {}
  }

  /** A relay whose query timed out or closed may hold a dead socket after a network drop; evict it so the next query reconnects. */
  function evictRelay(pool, url, relay) {
    try {
      if (relay && typeof relay.close === 'function') relay.close();
    } catch (_e) {}
    try {
      const base = String(url).replace(/\/+$/, '');
      pool.relays.forEach((r, key) => {
        if (String(key).replace(/\/+$/, '') === base && r === relay) pool.relays.delete(key);
      });
    } catch (_e) {}
  }

  /** One relay: resolves { ok } only after EOSE, so a silent or failed relay never counts as confirmation. */
  async function queryRelay(url, filters, timeoutMs) {
    const pool = App.pool;
    if (!pool || typeof pool.ensureRelay !== 'function') return { ok: false, events: [], code: 'NO_POOL' };
    let relay;
    try {
      relay = await pool.ensureRelay(url, { connectionTimeout: CONNECT_TIMEOUT_MS });
    } catch (_e) {
      dropDeadRelay(pool, url);
      return { ok: false, events: [], code: 'CONNECT_FAILED' };
    }
    return new Promise((resolve) => {
      const events = [];
      let settled = false;
      let sub = null;
      const finish = (ok, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          if (sub) sub.close();
        } catch (_e) {}
        if (!ok) evictRelay(pool, url, relay);
        resolve({ ok, events, code });
      };
      const timer = setTimeout(() => finish(false, 'TIMEOUT'), timeoutMs);
      try {
        sub = relay.subscribe(filters, {
          // nostr-tools fires oneose on its own timer (4.4s default); keep it past ours so silence never counts as EOSE.
          eoseTimeout: timeoutMs + 60000,
          onevent(ev) {
            events.push(ev);
          },
          oneose() {
            finish(true, 'EOSE');
          },
          onclose(reason) {
            finish(false, 'CLOSED:' + String(reason || '').slice(0, 60));
          },
        });
      } catch (_e2) {
        finish(false, 'SUBSCRIBE_FAILED');
      }
    });
  }

  async function fetchFromRelays(filters, timeoutMs) {
    const relays = relayList();
    const results = await Promise.all(relays.map((u) => queryRelay(u, filters, timeoutMs || QUERY_TIMEOUT_MS)));
    const byId = new Map();
    let ok = 0;
    results.forEach((r) => {
      if (r.ok) ok++;
      r.events.forEach((ev) => {
        if (ev && ev.id && !byId.has(ev.id)) byId.set(ev.id, ev);
      });
    });
    return { relaysOk: ok, relaysTotal: relays.length, events: Array.from(byId.values()), codes: results.map((r) => r.code) };
  }

  /** Admin 2FA attestations are fetched only when enforcement is on or the deployment requires attestations. */
  function admin2faActive() {
    const A = App.Admin2faProtocol;
    const C = App.Admin2faClient;
    return !!((A && A.isEnforced()) || (C && typeof C.required === 'function' && C.required()));
  }

  function authorityFilters() {
    const f = [{ kinds: [KIND_CONTROL, KIND_MEMBERSHIP], '#t': [GROUP_ID], limit: 2000 }];
    if (admin2faActive()) f.push({ kinds: [KIND_ATTESTATION], '#t': [GROUP_ID], limit: 2000 });
    return f;
  }

  function keepAttestation(ev) {
    if (!ev || ev.kind !== KIND_ATTESTATION || !ev.id || attestations.has(ev.id)) return false;
    if (attestations.size >= MAX_ATTESTATIONS) attestations.delete(attestations.keys().next().value);
    attestations.set(ev.id, ev);
    return true;
  }

  function localControlEvents() {
    try {
      const raw = window.localStorage.getItem('sos_group_control_v1_' + GROUP_ID);
      const parsed = raw ? JSON.parse(raw) : null;
      return (parsed && Array.isArray(parsed.rows) ? parsed.rows : []).map((r) => r && r.event).filter(Boolean);
    } catch (_e) {
      return [];
    }
  }

  function verifiedControl() {
    const g = GCS();
    if (!g || g.getStatus(GROUP_ID) !== 'VERIFIED') return null;
    const st = g.getVerifiedControlState(GROUP_ID);
    return st && st.verified === true && st.groupId === GROUP_ID ? st : null;
  }

  /** Deterministic apply of the accumulated signed event set (network + locally held). */
  function applyEventSet() {
    const g = GCS();
    const m = MS();
    if (!g || !m) return { ok: false, code: 'STORES_MISSING' };
    const A = App.Admin2faProtocol;
    const attested = A && attestations.size ? A.ingestAttestations(Array.from(attestations.values())) : 0;
    const control = [];
    const membership = [];
    networkEvents.forEach((ev) => {
      if (ev.kind === KIND_CONTROL) control.push(ev);
      else if (ev.kind === KIND_MEMBERSHIP) membership.push(ev);
    });
    const seenControl = new Set(control.map((e) => e.id));
    localControlEvents().forEach((ev) => {
      if (!seenControl.has(ev.id)) control.push(ev);
    });
    control.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (control.length) g.ingestControlEvents(control, { groupId: GROUP_ID });
    const status = g.getStatus(GROUP_ID);
    if (status === 'CONTROL_CONFLICT') return { ok: false, code: 'CONTROL_CONFLICT' };
    const st = verifiedControl();
    if (!st) return { ok: false, code: 'NO_VERIFIED_CONTROL' };
    const seenMem = new Set(membership.map((e) => e.id));
    (m.exportMembershipEvents(GROUP_ID) || []).forEach((ev) => {
      if (!seenMem.has(ev.id)) membership.push(ev);
    });
    const fp = st.eventId + '|' + attestations.size + '|' + membership.map((e) => e.id).sort().join(',');
    const changed = fp !== state.fingerprint || attested > 0;
    if (changed) {
      m.rebuildFromEvents(membership, st);
      state.fingerprint = fp;
    }
    state.controlEvents = control.length;
    state.membershipEvents = membership.length;
    return { ok: true, changed, controlEpoch: st.controlEpoch };
  }

  async function doReconcile(reason) {
    if (!isV2()) return { ok: false, code: 'V2_OFF' };
    const t0 = Date.now();
    if (!state.everSynced) state.status = 'LOADING';
    let res = await fetchFromRelays(authorityFilters());
    if (res.relaysOk === 0 && res.codes.some((c) => /^(TIMEOUT|CLOSED|SUBSCRIBE_FAILED|CONNECT_FAILED)/.test(String(c)))) {
      // Dead relays were evicted above; one fresh attempt covers sockets lost in a network drop. Still fails closed.
      await new Promise((r) => setTimeout(r, 300));
      res = await fetchFromRelays(authorityFilters());
    }
    state.lastCodes = res.codes.slice(0, 8);
    state.relaysOk = res.relaysOk;
    state.relaysTotal = res.relaysTotal;
    if (res.relaysOk === 0) {
      state.status = 'FAILED';
      state.lastError = 'RELAY_UNAVAILABLE';
      notify('network-failed');
      return { ok: false, code: 'NETWORK_AUTHORITY_UNVERIFIED', detail: 'RELAY_UNAVAILABLE', codes: res.codes };
    }
    res.events.forEach((ev) => {
      if (ev.kind === KIND_CONTROL || ev.kind === KIND_MEMBERSHIP) networkEvents.set(ev.id, ev);
      else keepAttestation(ev);
    });
    const applied = applyEventSet();
    state.lastLatencyMs = Date.now() - t0;
    if (!applied.ok) {
      state.status = 'FAILED';
      state.lastError = applied.code;
      notify('network-failed');
      return { ok: false, code: 'NETWORK_AUTHORITY_UNVERIFIED', detail: applied.code };
    }
    const first = !state.everSynced;
    state.status = 'SYNCED';
    state.everSynced = true;
    state.lastOkAt = Date.now();
    state.lastError = null;
    if (applied.changed || first) notify('network');
    if (started) startLive();
    pushControlToAdmission();
    return { ok: true, code: 'SYNCED', controlEpoch: applied.controlEpoch, relaysOk: res.relaysOk, latencyMs: state.lastLatencyMs };
  }

  /** Concurrent callers share one fetch; every call after it finishes fetches again. */
  function reconcile(reason) {
    if (inflight) return inflight;
    inflight = doReconcile(reason || 'manual').finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function onLiveEvent(ev) {
    if (!ev) return;
    if (ev.kind === KIND_ATTESTATION) {
      if (!keepAttestation(ev)) return;
    } else {
      if ((ev.kind !== KIND_CONTROL && ev.kind !== KIND_MEMBERSHIP) || networkEvents.has(ev.id)) return;
      networkEvents.set(ev.id, ev);
    }
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      const applied = applyEventSet();
      if (applied.ok) {
        state.status = 'SYNCED';
        state.lastOkAt = Date.now();
        if (applied.changed) notify('network-live');
        pushControlToAdmission();
      }
    }, LIVE_DEBOUNCE_MS);
  }

  function startLive() {
    if (liveSub || !App.pool || typeof App.pool.subscribeMany !== 'function') return;
    try {
      liveSub = App.pool.subscribeMany(
        relayList(),
        [
          {
            kinds: admin2faActive() ? [KIND_CONTROL, KIND_MEMBERSHIP, KIND_ATTESTATION] : [KIND_CONTROL, KIND_MEMBERSHIP],
            '#t': [GROUP_ID],
            since: Math.floor(Date.now() / 1000) - 5,
          },
        ],
        {
          onevent(ev) {
            onLiveEvent(ev);
          },
          onclose() {
            liveSub = null;
          },
        }
      );
    } catch (_e) {
      liveSub = null;
    }
  }

  function stopLive() {
    try {
      if (liveSub) liveSub.close();
    } catch (_e) {}
    liveSub = null;
  }

  // ---------------------------------------------------------------- admission service feed

  /** Keeps the admission service's control view current (signed events only; it re-verifies everything). */
  let pushedTip = '';
  function pushControlToAdmission() {
    const adm = App.FirstGroupAdmission || window.SosFirstGroupAdmission;
    const st = verifiedControl();
    if (!adm || !adm.configured() || !st || st.eventId === pushedTip) return Promise.resolve(null);
    const events = [];
    const seen = new Set();
    networkEvents.forEach((ev) => {
      if (ev.kind === KIND_CONTROL && !seen.has(ev.id)) {
        seen.add(ev.id);
        events.push(ev);
      }
    });
    localControlEvents().forEach((ev) => {
      if (!seen.has(ev.id)) {
        seen.add(ev.id);
        events.push(ev);
      }
    });
    const tip = st.eventId;
    return adm
      .syncControl(events)
      .then((r) => {
        if (r && r.result === 'OK') pushedTip = tip;
        return r;
      })
      .catch(() => null);
  }

  /** Kept for API compatibility: client-side / relay-order join approval no longer exists. */
  async function maybeApproveJoins() {
    return { ok: false, code: 'UNSERIALIZED_FALLBACK_DISABLED' };
  }

  // ---------------------------------------------------------------- lifecycle

  function start() {
    if (!isV2()) return;
    if (!started) {
      started = true;
      window.addEventListener('online', () => reconcile('online'));
      pollTimer = setInterval(() => {
        if (isV2()) reconcile('poll');
      }, POLL_INTERVAL_MS);
    }
    startLive();
    reconcile('start');
  }

  function stop() {
    clearInterval(pollTimer);
    pollTimer = null;
    started = false;
    stopLive();
  }

  function status() {
    return Object.freeze(Object.assign({}, state));
  }

  function isSynced() {
    return state.everSynced === true && state.status === 'SYNCED';
  }

  const api = Object.freeze({
    GROUP_ID,
    NETWORK_AUTHORITY_MODEL,
    DOUBLE_REDEEM_MODEL,
    LOCAL_CACHE_IS_AUTHORITY: false,
    NETWORK_STATE_AUTHORITATIVE: true,
    UNSERIALIZED_FALLBACK_ENABLED: false,
    reconcile,
    fetchFromRelays,
    maybeApproveJoins,
    pushControlToAdmission,
    start,
    stop,
    status,
    isSynced,
  });

  App.FirstGroupNetworkAuthority = api;
  window.SosFirstGroupNetworkAuthority = api;

  const boot = () => {
    if (isV2()) start();
  };
  window.addEventListener('sos-feature-flags-ready', boot);
  window.addEventListener('sos-access-control-v2-local', boot);
  window.addEventListener('sos-identity-ready', () => {
    if (isV2()) reconcile('identity');
  });
})(typeof window !== 'undefined' ? window : globalThis);
