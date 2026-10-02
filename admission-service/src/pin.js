import { DurableObject } from 'cloudflare:workers';
import { Admin2fa, configure, Membership, Moderation, Policy, strictVerify, validateBeforeAttestation } from './authority.js';
import { cosignPubkey, pepperBytes, signAttestation } from './cosign-keys.js';

/**
 * Server-authoritative admin PIN + co-sign (one instance per group: idFromName('admin-pin:' + groupId)).
 *
 * The client derives PBKDF2-SHA256(pin, salt, 600k) and sends only the 32-byte derivation; the server stores
 * HMAC(pepper, principal|salt|derived). The plaintext PIN never reaches the server, the verifier never leaves it.
 * Every request carries a fresh, single-use kind 27235 auth event signed by the admin key, so a PIN alone is
 * useless without the key, and a leaked key alone cannot obtain a co-signature without the PIN.
 */
export const PBKDF2_ITERATIONS = 600000;
const CONTROL_KIND = 39001;
const MODERATION_KIND = 39002;
const MEMBERSHIP_KIND = 39003;
const INVITE_KIND = 37378;
const INVITE_REVOKE_KIND = 37380;
const DELETION_KIND = 5;
const CONTENT_KIND = 1;
const ADMISSION_CAPS = ['FINALIZE_MEMBERSHIP_ADMISSION', 'FINALIZE_MEMBERSHIP_ADMISSION_RETIRED'];
const HEX64 = /^[0-9a-f]{64}$/;
const AUTH_FRESHNESS_SEC = 120;
const USED_AUTH_RETENTION_SEC = 600;
const SESSION_IDLE_MS = 15 * 60 * 1000;
const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS_PER_PRINCIPAL = 5;
const MAX_PARAMS_CHARS = 200000;
// Instance-wide ceiling on PIN comparisons, on top of the per-principal lockout.
const GUESS_WINDOW_MS = 60000;
const GUESS_WINDOW_MAX = 30;
const ACTIONS = new Set(['params', 'session', 'enroll', 'verify', 'cosign', 'lock']);

const enc = new TextEncoder();

function hex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

function randomHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return hex(b);
}

function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function tag(ev, name) {
  const row = ev && Array.isArray(ev.tags) ? ev.tags.find((t) => Array.isArray(t) && t[0] === name && t[1] != null) : null;
  return row ? String(row[1]) : '';
}

function out(result, extra) {
  return Object.assign({ result }, extra || {});
}

function fail(result, code, extra) {
  return Object.assign(new Error(code), { reply: out(result, Object.assign({ code }, extra || {})) });
}

/** Same schedule as the client lock: 1-3 free, then 30s, 60s, 5 min doubling, capped at 1h. */
export function delayForFailures(n) {
  if (n <= 3) return 0;
  if (n === 4) return 30000;
  if (n === 5) return 60000;
  return Math.min(300000 * Math.pow(2, n - 6), 3600000);
}

function capsOf(state, pk) {
  return state && state.capabilities && Array.isArray(state.capabilities[pk]) ? state.capabilities[pk] : [];
}

function strictContent(ev) {
  return !!ev && typeof ev === 'object' && ev.kind === CONTENT_KIND && HEX64.test(String(ev.id || '')) && strictVerify(ev);
}

export class AdminPinAuthority extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.guessWindowStart = 0;
    this.guessWindowCount = 0;
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(
        'CREATE TABLE IF NOT EXISTS admin_pin (principal TEXT PRIMARY KEY, salt TEXT NOT NULL, verifier TEXT, enrolled_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, lock_until INTEGER NOT NULL DEFAULT 0)'
      );
      sql.exec('CREATE TABLE IF NOT EXISTS pin_session (hash TEXT PRIMARY KEY, principal TEXT NOT NULL, created_ms INTEGER NOT NULL, last_ms INTEGER NOT NULL)');
      sql.exec('CREATE TABLE IF NOT EXISTS used_auth (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)');
    });
  }

  now(request) {
    const t = request.headers.get('x-sos-test-now');
    if (t && this.env.TEST_FAULTS === '1' && Number.isFinite(Number(t))) return Number(t);
    return Date.now();
  }

  async groupCall(path, body) {
    const stub = this.env.GROUP.get(this.env.GROUP.idFromName(this.env.FIRST_GROUP_ID));
    const res = await stub.fetch('https://group' + path, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
    return res.json();
  }

  async authenticate(body, action, nowMs, group, root) {
    const auth = body.auth;
    if (!auth || typeof auth !== 'object') throw fail('UNAUTHORIZED', 'NO_AUTH');
    if (auth.kind !== Admin2fa().AUTH_KIND) throw fail('UNAUTHORIZED', 'BAD_AUTH_KIND');
    if (!strictVerify(auth)) throw fail('UNAUTHORIZED', 'STRICT_VERIFY_FAILED');
    if (tag(auth, 'u') !== Admin2fa().AUTH_U_PREFIX + action) throw fail('UNAUTHORIZED', 'WRONG_ACTION');
    if (tag(auth, 'method') !== 'POST') throw fail('UNAUTHORIZED', 'WRONG_METHOD');
    if (tag(auth, 't') !== group) throw fail('UNAUTHORIZED', 'CROSS_GROUP');
    // Distinct ids for identical requests in the same second (ids are the single-use replay key).
    if (!/^[0-9a-f]{32,64}$/.test(tag(auth, 'nonce'))) throw fail('UNAUTHORIZED', 'NO_NONCE');
    if (typeof body.params !== 'string' || body.params.length > MAX_PARAMS_CHARS) throw fail('INVALID', 'BAD_PARAMS');
    if (!sameHex(tag(auth, 'payload').toLowerCase(), await sha256hex(body.params))) throw fail('UNAUTHORIZED', 'PAYLOAD_MISMATCH');
    const nowSec = Math.floor(nowMs / 1000);
    if (typeof auth.created_at !== 'number' || Math.abs(nowSec - auth.created_at) > AUTH_FRESHNESS_SEC) {
      throw fail('UNAUTHORIZED', 'STALE_AUTH');
    }
    let params;
    try {
      params = JSON.parse(body.params);
    } catch (_e) {
      throw fail('INVALID', 'BAD_PARAMS');
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw fail('INVALID', 'BAD_PARAMS');

    const principal = String(auth.pubkey).toLowerCase();
    if (principal !== root) {
      const snap = await this.groupCall('/snapshot');
      if (!snap || !snap.state || !Policy().isAdminPrincipal(principal, snap.state)) throw fail('UNAUTHORIZED', 'NOT_ADMIN');
    }

    const sql = this.ctx.storage.sql;
    let replay = false;
    this.ctx.storage.transactionSync(() => {
      sql.exec('DELETE FROM used_auth WHERE created_at < ?', nowSec - USED_AUTH_RETENTION_SEC);
      if (sql.exec('SELECT 1 FROM used_auth WHERE id = ?', String(auth.id)).toArray().length) replay = true;
      else sql.exec('INSERT INTO used_auth (id, created_at) VALUES (?, ?)', String(auth.id), auth.created_at);
    });
    if (replay) throw fail('UNAUTHORIZED', 'AUTH_REPLAY');
    return { principal, params, requestId: String(auth.id).toLowerCase() };
  }

  row(principal) {
    const rows = this.ctx.storage.sql.exec('SELECT * FROM admin_pin WHERE principal = ?', principal).toArray();
    return rows[0] || null;
  }

  async verifierFor(principal, salt, derived) {
    const key = await crypto.subtle.importKey('raw', pepperBytes(this.env), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, enc.encode('sos-admin-pin-v1|' + principal + '|' + salt + '|' + derived)));
  }

  /** One PIN comparison under per-principal lockout and the instance-wide ceiling. */
  async checkPin(principal, derived, nowMs) {
    if (typeof derived !== 'string' || !HEX64.test(derived)) throw fail('INVALID', 'BAD_DERIVED');
    const row = this.row(principal);
    if (!row || !row.verifier) throw fail('UNAUTHORIZED', 'NOT_ENROLLED');
    if (row.lock_until > nowMs) throw fail('LOCKED', 'PIN_LOCKED', { retryAfterMs: row.lock_until - nowMs });
    if (nowMs - this.guessWindowStart > GUESS_WINDOW_MS) {
      this.guessWindowStart = nowMs;
      this.guessWindowCount = 0;
    }
    if (++this.guessWindowCount > GUESS_WINDOW_MAX) throw fail('TEMPORARILY_UNAVAILABLE', 'RATE_LIMITED');
    const candidate = await this.verifierFor(principal, row.salt, derived);
    const sql = this.ctx.storage.sql;
    if (sameHex(candidate, row.verifier)) {
      sql.exec('UPDATE admin_pin SET failures = 0, lock_until = 0 WHERE principal = ?', principal);
      return;
    }
    let failures = 0;
    let lockUntil = 0;
    this.ctx.storage.transactionSync(() => {
      const cur = this.row(principal);
      failures = (cur ? cur.failures : 0) + 1;
      const d = delayForFailures(failures);
      lockUntil = d ? nowMs + d : 0;
      sql.exec('UPDATE admin_pin SET failures = ?, lock_until = ? WHERE principal = ?', failures, lockUntil, principal);
    });
    throw fail('UNAUTHORIZED', 'WRONG_PIN', { failures, retryAfterMs: lockUntil ? lockUntil - nowMs : 0 });
  }

  async openSession(principal, nowMs) {
    const id = randomHex(32);
    const hash = await sha256hex(id);
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec('INSERT INTO pin_session (hash, principal, created_ms, last_ms) VALUES (?, ?, ?, ?)', hash, principal, nowMs, nowMs);
      const extra = sql
        .exec('SELECT hash FROM pin_session WHERE principal = ? ORDER BY created_ms DESC LIMIT -1 OFFSET ?', principal, MAX_SESSIONS_PER_PRINCIPAL)
        .toArray();
      extra.forEach((r) => sql.exec('DELETE FROM pin_session WHERE hash = ?', r.hash));
    });
    return { sessionId: id, idleMs: SESSION_IDLE_MS, expiresAt: nowMs + SESSION_MAX_MS };
  }

  async requireSession(principal, sessionId, nowMs) {
    if (typeof sessionId !== 'string' || !HEX64.test(sessionId)) throw fail('UNAUTHORIZED', 'NO_SESSION');
    const hash = await sha256hex(sessionId);
    const sql = this.ctx.storage.sql;
    const row = sql.exec('SELECT * FROM pin_session WHERE hash = ?', hash).toArray()[0];
    if (!row || row.principal !== principal) throw fail('UNAUTHORIZED', 'NO_SESSION');
    if (nowMs - row.last_ms > SESSION_IDLE_MS || nowMs - row.created_ms > SESSION_MAX_MS) {
      sql.exec('DELETE FROM pin_session WHERE hash = ?', hash);
      throw fail('UNAUTHORIZED', 'SESSION_EXPIRED');
    }
    sql.exec('UPDATE pin_session SET last_ms = ? WHERE hash = ?', nowMs, hash);
    return hash;
  }

  async params(principal) {
    let row = this.row(principal);
    if (!row) {
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO admin_pin (principal, salt) VALUES (?, ?)', principal, randomHex(16));
      row = this.row(principal);
    }
    return row;
  }

  /**
   * Maps a signed privileged event to its canonical operations using the same validators receivers run.
   * Only allowlisted kinds with a server-validated authority check are co-signed; nothing else is signed.
   */
  async classify(ev, params, principal, group, root) {
    const P = Admin2fa();
    if (ev.kind === CONTROL_KIND) {
      const v = await this.groupCall('/validate', { event: ev });
      if (!v || !v.ok || !v.next) throw fail('INVALID', 'INVALID_TRANSITION', { reason: (v && v.code) || null });
      if (v.next.admin2faSignerPubkey !== cosignPubkey(this.env)) throw fail('INVALID', 'SIGNER_NOT_BOUND');
      return {
        operations: P.classifyControlTransition(v.prev, v.next),
        controlEpoch: v.next.controlEpoch,
        targetIsAdmin: P.controlTargetsAdmin(v.prev, v.next),
      };
    }

    const snap = await this.groupCall('/snapshot');
    const state = snap && snap.state && snap.state.groupId === group ? snap.state : null;

    if (ev.kind === DELETION_KIND) {
      // Legacy cross-author removal: exactly one target, which must be another user's post or comment.
      const target = params.target;
      if (!strictContent(target)) throw fail('INVALID', 'TARGET_REQUIRED');
      const e = (ev.tags || []).filter((t) => Array.isArray(t) && t[0] === 'e');
      if (e.length !== 1 || String(e[0][1]).toLowerCase() !== target.id) throw fail('INVALID', 'TARGET_MISMATCH');
      if (!(ev.tags || []).some((t) => Array.isArray(t) && t[0] === 't' && t[1] === group)) throw fail('INVALID', 'CROSS_GROUP');
      if (String(target.pubkey).toLowerCase() === principal) throw fail('INVALID', 'OWN_CONTENT_NOT_PRIVILEGED');
      const mayModerate = principal === root || (state && Moderation().hasCap(principal, state, 'MODERATE_CONTENT'));
      if (!mayModerate) throw fail('UNAUTHORIZED', 'NO_MODERATE_CAP');
      return { operations: [P.contentRemovalOperation(target)], controlEpoch: state ? state.controlEpoch : 0, targetIsAdmin: false };
    }

    if (!state) throw fail('INVALID', 'NO_VERIFIED_CONTROL');

    if (ev.kind === MODERATION_KIND) {
      const target = params.target;
      if (!strictContent(target)) throw fail('INVALID', 'TARGET_REQUIRED');
      const v = validateBeforeAttestation(() => Moderation().validateModerationEvent(ev, target, state));
      if (!v.ok) throw fail('INVALID', 'INVALID_MODERATION', { reason: v.code });
      return { operations: [P.contentRemovalOperation(target)], controlEpoch: state.controlEpoch, targetIsAdmin: false };
    }

    if (ev.kind === MEMBERSHIP_KIND) {
      if (capsOf(state, principal).some((c) => ADMISSION_CAPS.indexOf(c) !== -1)) throw fail('INVALID', 'ADMISSION_NOT_COSIGNABLE');
      const v = validateBeforeAttestation(() => Membership().validateMembershipEventStructural(ev, state, { groupId: group }));
      if (!v.ok) throw fail('INVALID', 'INVALID_MEMBERSHIP', { reason: v.code });
      const op = P.membershipOperation(v.body.transition);
      if (!op) throw fail('INVALID', 'OPERATION_NOT_PRIVILEGED');
      return { operations: [op], controlEpoch: state.controlEpoch, targetIsAdmin: P.isAdminTier(capsOf(state, v.memberPubkey)) };
    }

    // INVITE_REVOKE_KIND: only revoking another author's invite is an admin action.
    const invite = params.invite;
    if (!invite || typeof invite !== 'object' || invite.kind !== INVITE_KIND || !strictVerify(invite)) {
      throw fail('INVALID', 'INVITE_REQUIRED');
    }
    if (String(invite.pubkey).toLowerCase() === principal) throw fail('INVALID', 'OWN_INVITE_NOT_PRIVILEGED');
    const v = validateBeforeAttestation(() => Policy().validateRevokeEvent(ev, invite, state));
    if (!v.ok) throw fail('INVALID', 'INVALID_REVOKE', { reason: v.code });
    return { operations: ['REVOKE_INVITE'], controlEpoch: state.controlEpoch, targetIsAdmin: false };
  }

  async handle(action, body, nowMs) {
    const { root, group } = configure(this.env);
    pepperBytes(this.env);
    const { principal, params, requestId } = await this.authenticate(body, action, nowMs, group, root);

    if (action === 'params') {
      const row = await this.params(principal);
      return out('OK', {
        adminState: row.verifier ? 'LOCKED' : 'SETUP_REQUIRED',
        enrolled: !!row.verifier,
        salt: row.salt,
        algorithm: 'PBKDF2-SHA256',
        iterations: PBKDF2_ITERATIONS,
        retryAfterMs: row.lock_until > nowMs ? row.lock_until - nowMs : 0,
      });
    }

    if (action === 'enroll') {
      if (typeof params.derived !== 'string' || !HEX64.test(params.derived)) throw fail('INVALID', 'BAD_DERIVED');
      const row = this.row(principal);
      if (!row) throw fail('INVALID', 'PARAMS_FIRST');
      if (row.verifier) throw fail('CONFLICT', 'ALREADY_ENROLLED');
      if (params.salt !== row.salt) throw fail('INVALID', 'SALT_MISMATCH');
      const verifier = await this.verifierFor(principal, row.salt, params.derived);
      const sql = this.ctx.storage.sql;
      let written = 0;
      this.ctx.storage.transactionSync(() => {
        const cur = sql.exec(
          'UPDATE admin_pin SET verifier = ?, enrolled_at = ?, failures = 0, lock_until = 0 WHERE principal = ? AND verifier IS NULL AND salt = ?',
          verifier,
          nowMs,
          principal,
          row.salt
        );
        written = cur.rowsWritten;
      });
      if (!written) throw fail('CONFLICT', 'ALREADY_ENROLLED');
      return out('OK', Object.assign({ adminState: 'UNLOCKED' }, await this.openSession(principal, nowMs)));
    }

    if (action === 'verify') {
      await this.checkPin(principal, params.derived, nowMs);
      return out('OK', Object.assign({ adminState: 'UNLOCKED' }, await this.openSession(principal, nowMs)));
    }

    if (action === 'lock') {
      if (typeof params.sessionId === 'string' && HEX64.test(params.sessionId)) {
        const hash = await sha256hex(params.sessionId);
        this.ctx.storage.sql.exec('DELETE FROM pin_session WHERE hash = ? AND principal = ?', hash, principal);
      }
      return out('OK', { adminState: 'LOCKED' });
    }

    if (action === 'session') {
      const row = await this.params(principal);
      let active = false;
      let expired = false;
      if (row.verifier && typeof params.sessionId === 'string') {
        try {
          await this.requireSession(principal, params.sessionId, nowMs);
          active = true;
        } catch (_e) {
          expired = true;
        }
      }
      return out('OK', {
        adminState: active ? 'UNLOCKED' : row.verifier ? 'LOCKED' : 'SETUP_REQUIRED',
        enrolled: !!row.verifier,
        sessionExpired: expired,
        idleMs: SESSION_IDLE_MS,
        retryAfterMs: row.lock_until > nowMs ? row.lock_until - nowMs : 0,
      });
    }

    // cosign
    await this.requireSession(principal, params.sessionId, nowMs);
    const ev = params.event;
    if (!ev || typeof ev !== 'object') throw fail('INVALID', 'NO_EVENT');
    if (Admin2fa().PRIVILEGED_EVENT_KINDS.indexOf(ev.kind) === -1) throw fail('INVALID', 'KIND_NOT_COSIGNABLE');
    if (!strictVerify(ev)) throw fail('INVALID', 'STRICT_VERIFY_FAILED');
    if (String(ev.pubkey).toLowerCase() !== principal) throw fail('UNAUTHORIZED', 'ISSUER_MISMATCH');
    const P = Admin2fa();
    const nowSec = Math.floor(nowMs / 1000);
    if (Math.abs(nowSec - ev.created_at) > P.ATTESTATION_TTL_SEC) throw fail('INVALID', 'STALE_EVENT');
    const { operations, controlEpoch, targetIsAdmin } = await this.classify(ev, params, principal, group, root);
    if (!operations.length || operations.some((op) => P.PRIVILEGED_OPERATIONS.indexOf(op) === -1)) {
      throw fail('INVALID', 'OPERATION_NOT_PRIVILEGED');
    }
    const stepUp = P.requiresStepUp(operations, { targetIsAdmin });
    if (stepUp) {
      if (params.stepUp == null) throw fail('STEP_UP_REQUIRED', 'STEP_UP_REQUIRED');
      await this.checkPin(principal, params.stepUp, nowMs);
    }
    const attestation = signAttestation(
      this.env,
      P.buildAttestationDraft({
        groupId: group,
        rootPubkey: root,
        event: ev,
        operations,
        controlEpoch,
        principal,
        stepUp,
        issuedAt: nowSec,
        requestId,
      })
    );
    return out('COSIGNED', { attestation, stepUp, operations });
  }

  /** Test-only shape check; never returns salts, verifiers or session ids. */
  inspect() {
    const sql = this.ctx.storage.sql;
    const pins = sql.exec('SELECT principal, salt, verifier, failures, lock_until FROM admin_pin').toArray();
    return out('OK', {
      columns: sql.exec("SELECT name FROM pragma_table_info('admin_pin')").toArray().map((r) => r.name),
      pins: pins.map((r) => ({
        principal: r.principal,
        saltHexLen: r.salt ? r.salt.length : 0,
        verifierHexLen: r.verifier ? r.verifier.length : 0,
        failures: r.failures,
        locked: r.lock_until > 0,
      })),
      sessionHashLens: sql.exec('SELECT hash FROM pin_session').toArray().map((r) => r.hash.length),
      usedAuth: sql.exec('SELECT COUNT(*) AS n FROM used_auth').one().n,
    });
  }

  /** Public health fact: whether the canonical root has an enrolled PIN. Nothing else about the row. */
  publicStatus() {
    const root = String(this.env.ROOT_PUBKEY || '').toLowerCase();
    const row = this.ctx.storage.sql.exec('SELECT verifier FROM admin_pin WHERE principal = ?', root).toArray()[0];
    return out('OK', { rootPinConfigured: !!(row && row.verifier) });
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      const action = url.pathname.replace(/^\//, '');
      if (action === 'inspect' && this.env.TEST_FAULTS === '1') return Response.json(this.inspect());
      if (action === 'status') return Response.json(this.publicStatus());
      if (!ACTIONS.has(action)) return Response.json(out('INVALID', { code: 'NOT_FOUND' }), { status: 404 });
      const body = await request.json();
      return Response.json(await this.handle(action, body, this.now(request)));
    } catch (e) {
      if (e && e.reply) return Response.json(e.reply);
      const code = e && e.code === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'INTERNAL';
      return Response.json(out('TEMPORARILY_UNAVAILABLE', { code }), { status: 503 });
    }
  }
}
