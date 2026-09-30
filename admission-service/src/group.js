import { DurableObject } from 'cloudflare:workers';
import { configure, GCS, Admin2fa, controlRelays, RELAY_CONTROL_KINDS } from './authority.js';
import { servicePubkey } from './keys.js';
import { fetchFromRelays } from './relay-fetch.js';

const MAX_STORED = 2000;
const MAX_ATTESTATIONS_PER_EVENT = 4;
const REFRESH_MIN_INTERVAL_MS = 20000;
const RELAY_TIMEOUT_MS = 8000;

/**
 * One instance per group (idFromName(groupId)). Holds the root-signed GROUP_CONTROL event set and exposes the
 * verified control snapshot. Anyone may push events; only events on the verified chain (or conflict
 * candidates) are kept, so unsigned / foreign / unauthorized events cannot bloat or change authority.
 * The service also reads the published chain (and Admin 2FA attestations) from the canonical relays itself.
 */
export class GroupAuthority extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS control_event (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
      ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS control_attestation (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, json TEXT NOT NULL)'
      );
    });
    this.cached = null;
    this.lastRefresh = null;
    this.refreshing = null;
  }

  load() {
    const { group } = configure(this.env);
    const G = GCS();
    const A = Admin2fa();
    G.clearAllStores();
    if (A) A.clearAttestations();
    const atts = this.ctx.storage.sql.exec('SELECT json FROM control_attestation').toArray();
    if (A && atts.length) A.ingestAttestations(atts.map((r) => JSON.parse(r.json)));
    const rows = this.ctx.storage.sql.exec('SELECT json FROM control_event').toArray();
    const events = rows.map((r) => JSON.parse(r.json));
    if (events.length) G.ingestControlEvents(events, { groupId: group, persist: false });
    return group;
  }

  /** Synchronous: group-control-state is module-global, so reconstruct + read never spans an await. */
  snapshot() {
    if (this.cached) return this.cached;
    const group = this.load();
    const G = GCS();
    const status = G.getStatus(group);
    const state = status === 'VERIFIED' ? G.getVerifiedControlState(group) : null;
    const chain = state ? G.getVerifiedControlChain(group) : [];
    let delegate = null;
    let svc = '';
    try {
      svc = servicePubkey(this.env);
      delegate = G.admissionDelegateInfo(svc, group);
    } catch (_e) {
      delegate = null;
    }
    this.cached = {
      status,
      state: state ? JSON.parse(JSON.stringify(state)) : null,
      tipId: state ? state.eventId : null,
      bootstrapEventId: chain.length ? chain[0].eventId : null,
      chainLength: chain.length,
      delegate: delegate ? JSON.parse(JSON.stringify(delegate)) : null,
      delegatedCapabilities: state && svc ? (state.capabilities[svc] || []).slice() : [],
      lastRefresh: this.lastRefresh,
    };
    return this.cached;
  }

  ingest(events, attestations) {
    this.cached = null;
    const group = this.load();
    const G = GCS();
    const A = Admin2fa();
    const attList = (Array.isArray(attestations) ? attestations : [])
      .filter((e) => e && typeof e === 'object' && e.kind === RELAY_CONTROL_KINDS.attestation)
      .slice(0, 2000);
    if (A && attList.length) A.ingestAttestations(attList);
    const list = (Array.isArray(events) ? events : []).filter((e) => e && typeof e === 'object').slice(0, 500);
    if (list.length) G.ingestControlEvents(list, { groupId: group, persist: false });
    const status = G.getStatus(group);
    const keep = new Map();
    G.getVerifiedControlChain(group).forEach((row) => keep.set(row.eventId, null));
    (G.getConflictCandidates ? G.getConflictCandidates() : []).forEach((c) => {
      if (c && c.eventId) keep.set(String(c.eventId), null);
    });
    const byId = new Map();
    this.ctx.storage.sql
      .exec('SELECT id, json FROM control_event')
      .toArray()
      .forEach((r) => byId.set(r.id, r.json));
    list.forEach((e) => {
      if (e && typeof e.id === 'string' && !byId.has(e.id)) byId.set(e.id, JSON.stringify(e));
    });
    // Only signer-verified attestations bound to kept events are stored (the protocol store already filtered them).
    const keepAtts = [];
    if (A) {
      for (const id of keep.keys()) {
        A.attestationsFor(id)
          .slice(0, MAX_ATTESTATIONS_PER_EVENT)
          .forEach((a) => keepAtts.push({ id: a.id, eventId: id, json: JSON.stringify(a) }));
      }
    }
    let added = 0;
    let attAdded = 0;
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      for (const id of keep.keys()) {
        const json = byId.get(id);
        if (!json) continue;
        const existed = sql.exec('SELECT 1 FROM control_event WHERE id = ?', id).toArray().length > 0;
        if (!existed) {
          sql.exec('INSERT INTO control_event (id, json) VALUES (?, ?)', id, json);
          added++;
        }
      }
      keepAtts.forEach((a) => {
        const existed = sql.exec('SELECT 1 FROM control_attestation WHERE id = ?', a.id).toArray().length > 0;
        if (!existed) {
          sql.exec('INSERT INTO control_attestation (id, event_id, json) VALUES (?, ?, ?)', a.id, a.eventId, a.json);
          attAdded++;
        }
      });
      const total = sql.exec('SELECT COUNT(*) AS n FROM control_event').one().n;
      if (total > MAX_STORED) {
        // Chain + candidates only; anything else was never authoritative.
        const ids = Array.from(keep.keys());
        sql.exec('DELETE FROM control_event WHERE id NOT IN (' + ids.map(() => '?').join(',') + ')', ...ids);
        sql.exec('DELETE FROM control_attestation WHERE event_id NOT IN (' + ids.map(() => '?').join(',') + ')', ...ids);
      }
    });
    this.cached = null;
    const snap = this.snapshot();
    return {
      result: status === 'VERIFIED' ? 'OK' : 'INVALID',
      status: snap.status,
      controlEpoch: snap.state ? snap.state.controlEpoch : null,
      added,
      attestationsAdded: attAdded,
    };
  }

  /** Public control summary (no secrets): what the service currently verifies. */
  summary() {
    const s = this.snapshot();
    return {
      status: s.status,
      controlEpoch: s.state ? s.state.controlEpoch : null,
      rootAdminPubkey: s.state ? s.state.rootAdminPubkey : null,
      admin2faSignerPubkey: s.state ? s.state.admin2faSignerPubkey || null : null,
      bootstrapEventId: s.bootstrapEventId,
      tipEventId: s.tipId,
      servicePubkey: s.delegate ? s.delegate.pubkey : null,
      delegationActive: !!(s.delegate && s.delegate.active),
      delegatedCapabilities: s.delegatedCapabilities,
    };
  }

  /** Pulls the published control chain + attestations from the canonical relays and re-verifies it (throttled). */
  async refresh() {
    const { group } = configure(this.env);
    if (this.refreshing) return this.refreshing;
    if (this.lastRefresh && Date.now() - this.lastRefresh.atMs < REFRESH_MIN_INTERVAL_MS) {
      return Object.assign({ result: 'THROTTLED' }, this.summary(), {
        relaysOk: this.lastRefresh.relaysOk,
        relaysTotal: this.lastRefresh.relaysTotal,
      });
    }
    const relays = controlRelays(this.env);
    if (!relays.length) return { result: 'INVALID', code: 'NO_CONTROL_RELAYS' };
    this.refreshing = (async () => {
      try {
        const res = await fetchFromRelays(
          relays,
          [
            { kinds: [RELAY_CONTROL_KINDS.control], '#t': [group], limit: 500 },
            { kinds: [RELAY_CONTROL_KINDS.attestation], '#t': [group], limit: 2000 },
          ],
          RELAY_TIMEOUT_MS
        );
        const control = res.events.filter((e) => e.kind === RELAY_CONTROL_KINDS.control);
        const atts = res.events.filter((e) => e.kind === RELAY_CONTROL_KINDS.attestation);
        const r = this.ingest(control, atts);
        this.lastRefresh = {
          atMs: Date.now(),
          relaysOk: res.relaysOk,
          relaysTotal: res.relaysTotal,
          perRelay: res.perRelay.map((p) => ({ url: p.url, ok: p.ok, code: p.code })),
        };
        this.cached = null;
        return Object.assign({ result: r.result, added: r.added, attestationsAdded: r.attestationsAdded }, this.summary(), {
          relaysOk: res.relaysOk,
          relaysTotal: res.relaysTotal,
          fetched: control.length,
        });
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Dry-run: would this control event be the next authorized step on the verified tip? Never stored. */
  validate(event) {
    this.cached = null;
    try {
      const group = this.load();
      return GCS().previewControlTransition(event, { groupId: group });
    } finally {
      this.cached = null;
    }
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/snapshot') return Response.json(this.snapshot());
      if (url.pathname === '/validate') {
        const body = await request.json();
        return Response.json(this.validate(body.event));
      }
      if (url.pathname === '/ingest') {
        const body = await request.json();
        return Response.json(this.ingest(body.events, body.attestations));
      }
      if (url.pathname === '/refresh') return Response.json(await this.refresh());
      return Response.json({ result: 'INVALID' }, { status: 404 });
    } catch (e) {
      const code = e && e.code === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'INTERNAL';
      return Response.json({ result: 'TEMPORARILY_UNAVAILABLE', code }, { status: 503 });
    }
  }
}
