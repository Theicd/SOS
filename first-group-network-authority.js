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
 * Join approval: an online ROOT / MANAGE_MEMBERS client grants membership for valid invite redemptions.
 * Single-use invites are serialized by that approver: the earliest valid redemption (created_at, id)
 * wins; later redemptions of the same invite are never granted.
 */
(function initFirstGroupNetworkAuthority(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const GROUP_ID = 'israel-network';
  const KIND_CONTROL = 39001;
  const KIND_MEMBERSHIP = 39003;
  const QUERY_TIMEOUT_MS = 6000;
  const CONNECT_TIMEOUT_MS = 4000;
  const POLL_INTERVAL_MS = 15000;
  const LIVE_DEBOUNCE_MS = 150;
  // Redemptions younger than this are not granted yet, so concurrent redemptions of one invite can arrive
  // and the (created_at, id) winner is chosen from the full set rather than from arrival order.
  const REDEEM_SETTLE_S = 3;

  const NETWORK_AUTHORITY_MODEL =
    'Relays are transport. Authority = deterministic reconstruction of every valid signed 39001/39003 event ' +
    'fetched from the relay pool (plus locally held signed events), re-verified by the canonical stores.';
  const DOUBLE_REDEEM_MODEL =
    'Single-use invite redemptions (37379) are serialized by the approving ROOT / MANAGE_MEMBERS client: ' +
    'earliest valid (created_at, id) wins after a ' + REDEEM_SETTLE_S + 's settle window. Not atomic across concurrently online approvers.';

  const state = {
    status: 'IDLE',
    everSynced: false,
    lastOkAt: 0,
    lastError: null,
    relaysOk: 0,
    relaysTotal: 0,
    lastLatencyMs: null,
    controlEvents: 0,
    membershipEvents: 0,
    fingerprint: '',
  };
  const networkEvents = new Map();
  let inflight = null;
  let started = false;
  let pollTimer = null;
  let liveSub = null;
  let liveTimer = null;
  let approving = false;

  function isV2() {
    return window.SOS_ACCESS_CONTROL_V2 === true;
  }
  function GCS() {
    return App.GroupControlState || window.SosGroupControlState || null;
  }
  function MS() {
    return App.MembershipState || window.SosMembershipState || null;
  }
  function IP() {
    return App.InvitePolicy || window.SosInvitePolicy || null;
  }
  function FGA() {
    return App.FirstGroupAdmin || window.SosFirstGroupAdmin || null;
  }

  function normalizePubkey(value) {
    if (typeof value !== 'string') return '';
    const t = value.trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(t) ? t : '';
  }

  function readTag(ev, name) {
    const row = ev && Array.isArray(ev.tags) ? ev.tags.find((t) => Array.isArray(t) && t[0] === name && t[1] != null) : null;
    return row ? String(row[1]) : '';
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

  function authorityFilters() {
    return [{ kinds: [KIND_CONTROL, KIND_MEMBERSHIP], '#t': [GROUP_ID], limit: 2000 }];
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
    const fp = st.eventId + '|' + membership.map((e) => e.id).sort().join(',');
    const changed = fp !== state.fingerprint;
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
    const res = await fetchFromRelays(authorityFilters());
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
    maybeApproveJoins(reason);
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
    if (!ev || (ev.kind !== KIND_CONTROL && ev.kind !== KIND_MEMBERSHIP) || networkEvents.has(ev.id)) return;
    networkEvents.set(ev.id, ev);
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      const applied = applyEventSet();
      if (applied.ok) {
        state.status = 'SYNCED';
        state.lastOkAt = Date.now();
        if (applied.changed) notify('network-live');
        maybeApproveJoins('live');
      }
    }, LIVE_DEBOUNCE_MS);
  }

  function startLive() {
    if (liveSub || !App.pool || typeof App.pool.subscribeMany !== 'function') return;
    try {
      liveSub = App.pool.subscribeMany(
        relayList(),
        [{ kinds: [KIND_CONTROL, KIND_MEMBERSHIP, App.INVITE_USED_KIND || 37379], '#t': [GROUP_ID], since: Math.floor(Date.now() / 1000) - 5 }],
        {
          onevent(ev) {
            if (ev && ev.kind === (App.INVITE_USED_KIND || 37379)) maybeApproveJoins('live-redeem');
            else onLiveEvent(ev);
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

  // ---------------------------------------------------------------- join approval (serializer)

  function canApprove() {
    const F = FGA();
    if (!F || !App.publicKey || App.guestMode === true) return false;
    const a = F.myAuthority();
    return !!(a && a.verified && (a.isRoot || a.caps.indexOf('MANAGE_MEMBERS') !== -1));
  }

  function consumedInviteIds() {
    const m = MS();
    const out = new Set();
    (m ? m.exportMembershipEvents(GROUP_ID) : []).forEach((ev) => {
      try {
        const body = JSON.parse(ev.content || '{}');
        if (body.inviteEventId) out.add(String(body.inviteEventId).toLowerCase());
      } catch (_e) {}
    });
    return out;
  }

  /** Deterministic winner per single-use invite among valid redemptions. */
  async function pendingRedemptions() {
    const P = IP();
    const st = verifiedControl();
    if (!P || !st) return [];
    const usedKind = App.INVITE_USED_KIND || 37379;
    const used = (await fetchFromRelays([{ kinds: [usedKind], '#t': [GROUP_ID], limit: 500 }])).events;
    const ids = Array.from(new Set(used.map((u) => readTag(u, 'e').toLowerCase()).filter(Boolean)));
    if (!ids.length) return [];
    const inv = (await fetchFromRelays([{ kinds: [App.INVITE_KIND || 37378], ids }])).events;
    const rev = (await fetchFromRelays([{ kinds: [P.INVITE_REVOKE_EVENT_KIND || 37380], '#d': ids }])).events;
    const invites = new Map(inv.map((e) => [String(e.id).toLowerCase(), e]));
    const consumed = consumedInviteIds();
    const now = Math.floor(Date.now() / 1000);
    const out = [];
    for (const id of ids) {
      const invite = invites.get(id);
      if (!invite || consumed.has(id)) continue;
      if (!P.validateInviteEvent(invite, st, {}).ok) continue;
      if (rev.some((r) => P.validateRevokeEvent(r, invite, st).ok)) continue;
      const exp = Number(readTag(invite, 'expiration')) || 0;
      if (exp && exp < now) continue;
      const ih = readTag(invite, 'ih');
      const valid = used
        .filter((u) => readTag(u, 'e').toLowerCase() === id && P.validateUsedEvent(u, invite, ih).ok)
        .filter((u) => u.created_at >= invite.created_at)
        .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
      if (!valid.length) continue;
      out.push({
        inviteEventId: id,
        redeemer: normalizePubkey(valid[0].pubkey),
        usedEventId: valid[0].id,
        contenders: valid.length,
        settled: valid[0].created_at <= now - REDEEM_SETTLE_S,
      });
    }
    return out;
  }

  let settleTimer = null;
  function scheduleSettleRetry() {
    if (settleTimer) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      maybeApproveJoins('settle');
    }, (REDEEM_SETTLE_S + 1) * 1000);
  }

  async function maybeApproveJoins(_reason) {
    if (approving || !isV2() || !canApprove()) return;
    approving = true;
    try {
      const F = FGA();
      const m = MS();
      const rows = await pendingRedemptions();
      for (const r of rows) {
        if (!r.redeemer) continue;
        if (!r.settled) {
          scheduleSettleRetry();
          continue;
        }
        const status = m.getMemberState(r.redeemer, GROUP_ID);
        if (status !== 'UNKNOWN' && status !== 'REMOVED') continue;
        await F.approveJoin(r.redeemer, r.inviteEventId);
      }
    } catch (_e) {
    } finally {
      approving = false;
    }
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
    reconcile,
    fetchFromRelays,
    pendingRedemptions,
    maybeApproveJoins,
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
