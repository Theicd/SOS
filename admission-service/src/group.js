import { DurableObject } from 'cloudflare:workers';
import { configure, GCS } from './authority.js';
import { servicePubkey } from './keys.js';

const MAX_STORED = 2000;

/**
 * One instance per group (idFromName(groupId)). Holds the root-signed GROUP_CONTROL event set and exposes the
 * verified control snapshot. Anyone may push events; only events on the verified chain (or conflict
 * candidates) are kept, so unsigned / foreign / unauthorized events cannot bloat or change authority.
 */
export class GroupAuthority extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS control_event (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
    });
    this.cached = null;
  }

  load() {
    const { group } = configure(this.env);
    const G = GCS();
    G.clearAllStores();
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
    let delegate = null;
    try {
      const pk = servicePubkey(this.env);
      delegate = G.admissionDelegateInfo(pk, group);
    } catch (_e) {
      delegate = null;
    }
    this.cached = {
      status,
      state: state ? JSON.parse(JSON.stringify(state)) : null,
      tipId: state ? state.eventId : null,
      delegate: delegate ? JSON.parse(JSON.stringify(delegate)) : null,
    };
    return this.cached;
  }

  ingest(events) {
    this.cached = null;
    const group = this.load();
    const G = GCS();
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
    let added = 0;
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
      const total = sql.exec('SELECT COUNT(*) AS n FROM control_event').one().n;
      if (total > MAX_STORED) {
        // Chain + candidates only; anything else was never authoritative.
        const ids = Array.from(keep.keys());
        sql.exec('DELETE FROM control_event WHERE id NOT IN (' + ids.map(() => '?').join(',') + ')', ...ids);
      }
    });
    this.cached = null;
    const snap = this.snapshot();
    return { result: status === 'VERIFIED' ? 'OK' : 'INVALID', status: snap.status, controlEpoch: snap.state ? snap.state.controlEpoch : null, added };
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/snapshot') return Response.json(this.snapshot());
      if (url.pathname === '/ingest') {
        const body = await request.json();
        return Response.json(this.ingest(body.events));
      }
      return Response.json({ result: 'INVALID' }, { status: 404 });
    } catch (e) {
      const code = e && e.code === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'INTERNAL';
      return Response.json({ result: 'TEMPORARILY_UNAVAILABLE', code }, { status: 503 });
    }
  }
}
