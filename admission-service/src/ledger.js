import { DurableObject } from 'cloudflare:workers';
import { configure, Policy, strictVerify } from './authority.js';
import { servicePubkey, signAdmissionProof } from './keys.js';

export const SERVICE_TAG = 'sos-first-group-admission-v1';
const INVITE_KIND = 37378;
const USED_KIND = 37379;
const REVOKE_KIND = 37380;
const MAX_INVITE_TTL_SEC = 31 * 24 * 60 * 60;
const REQUEST_FRESHNESS_SEC = 300;
const REGISTER_SKEW_SEC = 600;
const RECOVERY_ALARM_MS = 15000;
const HEX64 = /^[0-9a-f]{64}$/;
const OP_RE = /^[A-Za-z0-9_-]{16,80}$/;

const nowSec = () => Math.floor(Date.now() / 1000);

function tag(ev, name) {
  const row = ev && Array.isArray(ev.tags) ? ev.tags.find((t) => Array.isArray(t) && t[0] === name && t[1] != null) : null;
  return row ? String(row[1]) : '';
}
function hasT(ev, value) {
  return !!(ev && Array.isArray(ev.tags) && ev.tags.some((t) => Array.isArray(t) && t[0] === 't' && t[1] === value));
}
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
const out = (result, extra) => Object.assign({ result }, extra || {});

/**
 * One Durable Object per invite: idFromName(firstGroupId + ':' + inviteId). Cloudflare guarantees a single live
 * instance per id, and every state transition below runs synchronously inside transactionSync after all awaits,
 * so UNUSED -> CLAIMED is a true compare-and-set: exactly one redeemer can ever win.
 *
 * States: UNUSED -> CLAIMED -> REDEEMED (finalized proof), UNUSED -> REVOKED, UNUSED -> EXPIRED.
 * CLAIMED never returns to UNUSED; finalization is retried by the winner's retry or by the recovery alarm.
 */
export class InviteLedger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS invite (
        k INTEGER PRIMARY KEY CHECK (k = 1),
        invite_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        creator TEXT NOT NULL,
        ih TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        single_use INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL,
        registered_at INTEGER NOT NULL,
        registered_epoch INTEGER,
        invite_json TEXT NOT NULL,
        redeemer TEXT,
        op_id TEXT,
        member_rev INTEGER,
        request_id TEXT,
        claimed_at INTEGER,
        finalized_at INTEGER,
        proof_id TEXT,
        proof_json TEXT,
        revoked_by TEXT,
        revoked_at INTEGER,
        state_changed_at INTEGER
      )`);
    });
  }

  row() {
    return this.sql.exec('SELECT * FROM invite WHERE k = 1').toArray()[0] || null;
  }

  async snapshot() {
    const { group } = configure(this.env);
    const stub = this.env.GROUP.get(this.env.GROUP.idFromName(group));
    const res = await stub.fetch('https://group/snapshot');
    if (!res.ok) throw Object.assign(new Error('group unavailable'), { code: 'GROUP_UNAVAILABLE' });
    return res.json();
  }

  /** Sync compare-and-set; returns true only if the row was in `from` and is now in `to`. */
  cas(from, to, sets, params) {
    let written = 0;
    this.ctx.storage.transactionSync(() => {
      const cur = this.sql.exec(
        'UPDATE invite SET state = ?, state_changed_at = ?' + (sets ? ', ' + sets : '') + ' WHERE k = 1 AND state = ?',
        to,
        nowSec(),
        ...(params || []),
        from
      );
      written = cur.rowsWritten;
    });
    return written === 1;
  }

  // ------------------------------------------------------------------ register

  async register(body, inviteId) {
    const { group } = configure(this.env);
    const inv = body && body.invite;
    if (!inv || typeof inv !== 'object' || inv.kind !== INVITE_KIND || String(inv.id || '').toLowerCase() !== inviteId) {
      return out('INVALID', { code: 'BAD_INVITE' });
    }
    const existing = this.row();
    if (existing) {
      if (existing.invite_id === inviteId) return out('REGISTERED', { replay: true });
      return out('INVALID', { code: 'LEDGER_MISMATCH' });
    }
    if (!strictVerify(inv)) return out('INVALID', { code: 'STRICT_VERIFY_FAILED' });
    if (!hasT(inv, group)) return out('INVALID', { code: 'CROSS_GROUP' });
    const ih = tag(inv, 'ih').toLowerCase();
    if (!HEX64.test(ih) || tag(inv, 'd').toLowerCase() !== ih) return out('INVALID', { code: 'BAD_IH' });
    const now = nowSec();
    const exp = Number(tag(inv, 'expiration'));
    if (!Number.isInteger(exp) || exp <= now + 1 || exp > now + MAX_INVITE_TTL_SEC) return out('INVALID', { code: 'BAD_EXPIRATION' });
    if (inv.created_at > now + REGISTER_SKEW_SEC || inv.created_at < now - REGISTER_SKEW_SEC) {
      return out('INVALID', { code: 'STALE_INVITE' });
    }

    const snap = await this.snapshot();
    if (snap.status !== 'VERIFIED' || !snap.state) return out('TEMPORARILY_UNAVAILABLE', { code: 'NO_VERIFIED_CONTROL' });
    if (!snap.delegate || snap.delegate.active !== true) return out('TEMPORARILY_UNAVAILABLE', { code: 'DELEGATION_INACTIVE' });
    const P = Policy();
    const v = P.validateInviteEvent(inv, snap.state, {});
    if (!v.ok) return out('UNAUTHORIZED', { code: v.detail || v.code });
    // The service holds no member roster, so registration requires an explicit inviter capability.
    const creator = String(inv.pubkey).toLowerCase();
    const st = snap.state;
    if (!(creator === st.rootAdminPubkey || P.hasCap(creator, st, 'INVITE_USERS') || P.isAdminPrincipal(creator, st))) {
      return out('UNAUTHORIZED', { code: 'REGISTRATION_REQUIRES_INVITE_CAPABILITY' });
    }

    if (this.row()) return out('REGISTERED', { replay: true });
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO invite (k, invite_id, group_id, creator, ih, created_at, expires_at, single_use, state,
          registered_at, registered_epoch, invite_json, state_changed_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, 1, 'UNUSED', ?, ?, ?, ?)`,
        inviteId,
        group,
        creator,
        ih,
        inv.created_at,
        exp,
        now,
        st.controlEpoch,
        JSON.stringify(inv),
        now
      );
    });
    return out('REGISTERED', { replay: false, expiresAt: exp });
  }

  // ------------------------------------------------------------------ redeem

  buildProof(r, snap) {
    const st = snap.state;
    const svc = servicePubkey(this.env);
    const now = nowSec();
    const body = {
      schema: 'sos-group-member',
      version: 1,
      groupId: r.group_id,
      memberPubkey: r.redeemer,
      status: 'ACTIVE',
      memberRevision: r.member_rev,
      controlEpochAtIssue: st.controlEpoch,
      membershipEpoch: st.membershipEpoch,
      issuerPubkey: svc,
      transition: 'GRANT_ACTIVE',
      createdAt: now,
      inviteEventId: r.invite_id,
      admission: {
        schema: 'sos-first-group-admission',
        version: 1,
        inviteEventId: r.invite_id,
        redeemerPubkey: r.redeemer,
        groupId: r.group_id,
        operationId: r.op_id,
      },
    };
    return signAdmissionProof(this.env, {
      kind: 39003,
      created_at: now,
      pubkey: svc,
      tags: [
        ['d', r.group_id + ':' + r.redeemer + ':' + r.member_rev],
        ['p', r.redeemer],
        ['t', r.group_id],
        ['t', 'sos-group-member'],
        ['status', 'ACTIVE'],
        ['member-revision', String(r.member_rev)],
        ['membership-epoch', String(st.membershipEpoch)],
        ['control-epoch', String(st.controlEpoch)],
        ['admission', r.invite_id],
      ],
      content: JSON.stringify(body),
    });
  }

  /** CLAIMED -> REDEEMED. Requires an active delegation now; otherwise stays CLAIMED (never reverts). */
  finalize(snap) {
    const r = this.row();
    if (!r || r.state !== 'CLAIMED') return r;
    if (snap.status !== 'VERIFIED' || !snap.state || !snap.delegate || snap.delegate.active !== true) return r;
    const proof = this.buildProof(r, snap);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE invite SET state = 'REDEEMED', finalized_at = ?, proof_id = ?, proof_json = ?, state_changed_at = ?
         WHERE k = 1 AND state = 'CLAIMED' AND redeemer = ? AND op_id = ?`,
        nowSec(),
        proof.id,
        JSON.stringify(proof),
        nowSec(),
        r.redeemer,
        r.op_id
      );
    });
    return this.row();
  }

  accepted(r, replay) {
    return out('ACCEPTED', { replay, proof: JSON.parse(r.proof_json), proofId: r.proof_id, operationId: r.op_id });
  }

  async redeem(body, inviteId, fault) {
    const { group } = configure(this.env);
    const req = body && body.request;
    if (!req || typeof req !== 'object' || req.kind !== USED_KIND) return out('INVALID', { code: 'BAD_REQUEST' });
    if (!strictVerify(req)) return out('UNAUTHORIZED', { code: 'STRICT_VERIFY_FAILED' });
    const redeemer = String(req.pubkey).toLowerCase();
    const op = tag(req, 'op');
    const rev = Number(tag(req, 'member-revision'));
    if (
      !hasT(req, group) ||
      tag(req, 'e').toLowerCase() !== inviteId ||
      tag(req, 'd').toLowerCase() !== inviteId ||
      tag(req, 'svc') !== SERVICE_TAG ||
      !OP_RE.test(op) ||
      !Number.isInteger(rev) ||
      rev < 1 ||
      rev > 1000000
    ) {
      return out('INVALID', { code: 'BAD_REQUEST_BINDING' });
    }
    const code = String((body && body.code) || '').trim().toUpperCase();
    if (code.length < 6 || code.length > 64) return out('INVALID', { code: 'BAD_CODE' });
    const codeHash = await sha256Hex(code);

    let r = this.row();
    if (!r) return out('INVALID', { code: 'NOT_REGISTERED' });
    if (codeHash !== r.ih || tag(req, 'ih').toLowerCase() !== r.ih) return out('INVALID', { code: 'CODE_MISMATCH' });

    // Losers and replays are answered without needing the group snapshot.
    if (r.state === 'REDEEMED' || r.state === 'CLAIMED') {
      if (r.redeemer !== redeemer || r.op_id !== op) return out('ALREADY_REDEEMED');
      if (r.state === 'REDEEMED') return this.accepted(r, true);
    }
    if (r.state === 'REVOKED') return out('REVOKED');
    if (r.state === 'EXPIRED') return out('EXPIRED');

    const snap = await this.snapshot();

    // ---- everything below is synchronous: no interleaving with other requests to this invite ----
    r = this.row();
    const now = nowSec();
    if (r.state === 'REDEEMED' || r.state === 'CLAIMED') {
      if (r.redeemer !== redeemer || r.op_id !== op) return out('ALREADY_REDEEMED');
      if (r.state === 'REDEEMED') return this.accepted(r, true);
      const f = this.finalize(snap);
      return f.state === 'REDEEMED' ? this.accepted(f, true) : out('TEMPORARILY_UNAVAILABLE', { code: 'FINALIZATION_PENDING' });
    }
    if (r.state === 'REVOKED') return out('REVOKED');
    if (r.state === 'EXPIRED') return out('EXPIRED');
    if (r.state !== 'UNUSED') return out('INVALID', { code: 'BAD_STATE' });
    if (now >= r.expires_at) {
      this.cas('UNUSED', 'EXPIRED');
      return out('EXPIRED');
    }
    if (Math.abs(now - Number(req.created_at)) > REQUEST_FRESHNESS_SEC) return out('INVALID', { code: 'STALE_REQUEST' });
    if (snap.status !== 'VERIFIED' || !snap.state) return out('TEMPORARILY_UNAVAILABLE', { code: 'NO_VERIFIED_CONTROL' });
    if (!snap.delegate || snap.delegate.active !== true) return out('TEMPORARILY_UNAVAILABLE', { code: 'DELEGATION_INACTIVE' });
    const st = snap.state;
    if ((st.blockedPubkeys || []).indexOf(redeemer) !== -1) return out('UNAUTHORIZED', { code: 'REDEEMER_BLOCKED' });
    if ((st.blockedPubkeys || []).indexOf(r.creator) !== -1) return out('UNAUTHORIZED', { code: 'INVITER_BLOCKED' });
    if (redeemer === r.creator) return out('INVALID', { code: 'SELF_REDEEM' });

    const won = this.cas(
      'UNUSED',
      'CLAIMED',
      'redeemer = ?, op_id = ?, member_rev = ?, request_id = ?, claimed_at = ?',
      [redeemer, op, rev, String(req.id).toLowerCase(), now]
    );
    if (!won) return out('ALREADY_REDEEMED');
    this.ctx.storage.setAlarm(Date.now() + RECOVERY_ALARM_MS);
    if (fault === 'after-claim' && this.env.TEST_FAULTS === '1') {
      return out('TEMPORARILY_UNAVAILABLE', { code: 'TEST_FAULT_AFTER_CLAIM' });
    }
    const f = this.finalize(snap);
    return f.state === 'REDEEMED' ? this.accepted(f, false) : out('TEMPORARILY_UNAVAILABLE', { code: 'FINALIZATION_PENDING' });
  }

  /** Recovery: a CLAIMED invite whose winner never came back is finalized here (never reverted). */
  async alarm() {
    const r = this.row();
    if (!r || r.state !== 'CLAIMED') return;
    try {
      const snap = await this.snapshot();
      const f = this.finalize(snap);
      if (f && f.state === 'CLAIMED') this.ctx.storage.setAlarm(Date.now() + RECOVERY_ALARM_MS * 4);
    } catch (_e) {
      this.ctx.storage.setAlarm(Date.now() + RECOVERY_ALARM_MS * 4);
    }
  }

  // ------------------------------------------------------------------ revoke

  async revoke(body, inviteId) {
    const { group } = configure(this.env);
    const ev = body && body.revoke;
    if (!ev || typeof ev !== 'object' || ev.kind !== REVOKE_KIND) return out('INVALID', { code: 'BAD_REVOKE' });
    if (tag(ev, 'd').toLowerCase() !== inviteId || !hasT(ev, group)) return out('INVALID', { code: 'BAD_REVOKE_BINDING' });
    let r = this.row();
    if (!r) return out('INVALID', { code: 'NOT_REGISTERED' });
    const inv = JSON.parse(r.invite_json);
    if (Number(ev.created_at) < Number(inv.created_at)) return out('INVALID', { code: 'REVOKE_BEFORE_INVITE' });
    const snap = await this.snapshot();
    if (snap.status !== 'VERIFIED' || !snap.state) return out('TEMPORARILY_UNAVAILABLE', { code: 'NO_VERIFIED_CONTROL' });
    const v = Policy().validateRevokeEvent(ev, inv, snap.state);
    if (!v.ok) return out('UNAUTHORIZED', { code: v.code });

    r = this.row();
    if (r.state === 'REVOKED') return out('REVOKED', { replay: true });
    if (r.state === 'CLAIMED' || r.state === 'REDEEMED') return out('ALREADY_REDEEMED');
    if (r.state === 'EXPIRED') return out('EXPIRED');
    if (nowSec() >= r.expires_at) {
      this.cas('UNUSED', 'EXPIRED');
      return out('EXPIRED');
    }
    const ok = this.cas('UNUSED', 'REVOKED', 'revoked_by = ?, revoked_at = ?', [String(ev.pubkey).toLowerCase(), nowSec()]);
    return ok ? out('REVOKED', { replay: false }) : out('ALREADY_REDEEMED');
  }

  // ------------------------------------------------------------------ status

  /** Privacy-safe: requires the invite code, returns only the state class (never the redeemer). */
  async status(body) {
    const code = String((body && body.code) || '').trim().toUpperCase();
    const r = this.row();
    if (!r || code.length < 6 || code.length > 64) return out('INVALID');
    if ((await sha256Hex(code)) !== r.ih) return out('INVALID');
    const cur = this.row();
    if (cur.state === 'UNUSED') {
      if (nowSec() >= cur.expires_at) {
        this.cas('UNUSED', 'EXPIRED');
        return out('EXPIRED');
      }
      return out('UNUSED', { expiresAt: cur.expires_at });
    }
    if (cur.state === 'CLAIMED' || cur.state === 'REDEEMED') return out('ALREADY_REDEEMED');
    return out(cur.state);
  }

  /** Test/audit only (TEST_FAULTS=1): full ledger row minus invite payload. */
  inspect() {
    const r = this.row();
    if (!r) return out('INVALID');
    const copy = Object.assign({}, r);
    delete copy.invite_json;
    delete copy.proof_json;
    return out('OK', { ledger: copy });
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      const inviteId = String(url.searchParams.get('invite') || '');
      if (!HEX64.test(inviteId)) return Response.json(out('INVALID'));
      const body = request.method === 'POST' ? await request.json() : {};
      const fault = request.headers.get('x-sos-test-fault') || '';
      let res;
      if (url.pathname === '/register') res = await this.register(body, inviteId);
      else if (url.pathname === '/redeem') res = await this.redeem(body, inviteId, fault);
      else if (url.pathname === '/revoke') res = await this.revoke(body, inviteId);
      else if (url.pathname === '/status') res = await this.status(body);
      else if (url.pathname === '/inspect' && this.env.TEST_FAULTS === '1') res = this.inspect();
      else res = out('INVALID');
      return Response.json(res);
    } catch (e) {
      const code = e && (e.code === 'NOT_CONFIGURED' || e.code === 'GROUP_UNAVAILABLE') ? e.code : 'INTERNAL';
      return Response.json(out('TEMPORARILY_UNAVAILABLE', { code }));
    }
  }
}
