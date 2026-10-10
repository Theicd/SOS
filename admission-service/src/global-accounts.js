/**
 * GLOBAL account authority (not Community-scoped).
 * Durable Object name: idFromName('global:accounts') — single instance.
 *
 * Owns:
 * - phoneToken → pubkey directory (HMAC tokens only; never plaintext phone)
 * - GLOBAL_ACCOUNT_CERT records (kind 39007 semantics)
 * - GLOBAL_ACCOUNT_STATUS tips (kind 39008 semantics)
 * - NEW_ACCOUNT_INVITE phone bindings (authoritative)
 *
 * PHONE_REBIND_NOT_IMPLEMENTED_YET=true — schema is revisioned for future rebind.
 */
import { DurableObject } from 'cloudflare:workers';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools';
import { verifyAldApprovalArtifact, validateAldConsumeAuth } from './ald-w1a-verify.js';
import { computePhoneToken, normalizePhoneE164, phoneTokensEqual, PHONE_PROOF_LEVEL, PHONE_TOKEN_SCHEME } from './phone.js';
import { servicePubkey } from './keys.js';

export const GLOBAL_ACCOUNT_CERT_KIND = 39007;
export const GLOBAL_ACCOUNT_STATUS_KIND = 39008;
export const INVITE_PURPOSE_NEW_ACCOUNT = 'NEW_ACCOUNT_INVITE';
export const INVITE_PURPOSE_COMMUNITY = 'COMMUNITY_INVITE';

const HEX64 = /^[0-9a-f]{64}$/;
const LOOKUP_WINDOW_MS = 60000;
const LOOKUP_WINDOW_MAX = 40;

function fail(code, extra) {
  return Object.assign({ result: 'INVALID', code }, extra || {});
}

function loadSk(env) {
  const raw = String(env.ADMISSION_SK || '');
  if (!/^[0-9a-f]{64}$/i.test(raw)) throw Object.assign(new Error('service key'), { code: 'NOT_CONFIGURED' });
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return { sk, pk: getPublicKey(sk) };
}

function rootOk(env, pk) {
  return HEX64.test(String(env.ROOT_PUBKEY || '').toLowerCase()) && String(env.ROOT_PUBKEY).toLowerCase() === String(pk || '').toLowerCase();
}

export class GlobalAccountAuthority extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.lookupWindowStart = 0;
    this.lookupWindowCount = 0;
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS phone_bindings (
          phone_token TEXT PRIMARY KEY,
          pubkey TEXT NOT NULL,
          revision INTEGER NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_phone_pubkey ON phone_bindings(pubkey);
        CREATE TABLE IF NOT EXISTS accounts (
          pubkey TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          status TEXT NOT NULL,
          account_created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          cert_event_json TEXT,
          status_event_json TEXT
        );
        CREATE TABLE IF NOT EXISTS new_account_invites (
          invite_id TEXT PRIMARY KEY,
          phone_token TEXT NOT NULL,
          invite_hash TEXT NOT NULL,
          creator_pubkey TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          state TEXT NOT NULL,
          redeemer_pubkey TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_nai_phone ON new_account_invites(phone_token);
        CREATE TABLE IF NOT EXISTS auth_spent (
          event_id TEXT PRIMARY KEY,
          spent_at INTEGER NOT NULL,
          purpose TEXT
        );
        CREATE TABLE IF NOT EXISTS ald_approval_spent (
          approval_id TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          account_p TEXT NOT NULL,
          device_id TEXT NOT NULL,
          spent_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ald_reqhash ON ald_approval_spent(request_hash);
      `);
    });
  }

  spendAuth(eventId, purpose) {
    const id = String(eventId || '').toLowerCase();
    if (!HEX64.test(id)) return fail('BAD_AUTH');
    const prior = this.ctx.storage.sql.exec('SELECT event_id FROM auth_spent WHERE event_id = ?', id).toArray();
    if (prior.length) return fail('AUTH_REPLAY', { AUTH_REPLAY_ACCEPTED: false });
    this.ctx.storage.sql.exec(
      'INSERT INTO auth_spent (event_id, spent_at, purpose) VALUES (?, ?, ?)',
      id,
      Math.floor(Date.now() / 1000),
      String(purpose || '').slice(0, 64),
    );
    return { ok: true };
  }

  /**
   * MD3W-W1B — durable one-time ALD approval consumption (cross-instance via DO SQLite).
   * Re-verifies W1A WebAuthn artifact before INSERT. Fail-closed.
   */
  async consumeAldApproval(body) {
    const artifact = body && body.artifact;
    const expectedRequest = (body && body.expectedRequest) || null;
    const authEvent = body && body.authEvent;
    if (!artifact || !artifact.approvalId) return fail('BAD_ARTIFACT');

    const prelimAccount = String(
      (artifact.canonicalRequest && artifact.canonicalRequest.accountP) || artifact.accountP || '',
    ).toLowerCase();
    if (!HEX64.test(prelimAccount)) return fail('BAD_ACCOUNT_P');

    const authOk = validateAldConsumeAuth(authEvent, prelimAccount);
    if (!authOk.ok) return fail(authOk.code || 'BAD_AUTH');

    const st = this.getStatus(prelimAccount);
    if (st && st.status === 'ACCOUNT_DISABLED') {
      return fail('ACCOUNT_DISABLED', { ACCOUNT_DISABLED: true });
    }

    const verified = await verifyAldApprovalArtifact(artifact, expectedRequest);
    if (!verified || verified.ok !== true) {
      return fail(verified && verified.code ? verified.code : 'W1A_PROOF_INVALID', {
        TRUSTED_W1A_PROOF_VERIFIED: false,
      });
    }
    if (String(verified.accountP).toLowerCase() !== prelimAccount) {
      return fail('PROOF_ACCOUNT_MISMATCH');
    }

    const approvalId = String(artifact.approvalId || verified.approvalId || '');
    const requestHash = String(verified.requestHash || '');
    const deviceId = String(verified.deviceId || '').toLowerCase();
    if (!approvalId || !HEX64.test(requestHash) || !HEX64.test(deviceId)) {
      return fail('BAD_CONSUME_FIELDS');
    }

    // Spend the auth event id (anti-replay of the consume request itself).
    const spentAuth = this.spendAuth(authEvent.id, 'ALD_APPROVAL_CONSUME');
    if (!spentAuth.ok) return spentAuth;

    let replay = false;
    let inserted = false;
    this.ctx.storage.transactionSync(() => {
      const prior = this.ctx.storage.sql
        .exec('SELECT approval_id FROM ald_approval_spent WHERE approval_id = ?', approvalId)
        .toArray();
      if (prior.length) {
        replay = true;
        return;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO ald_approval_spent (approval_id, request_hash, account_p, device_id, spent_at)
         VALUES (?, ?, ?, ?, ?)`,
        approvalId,
        requestHash,
        prelimAccount,
        deviceId,
        Math.floor(Date.now() / 1000),
      );
      inserted = true;
    });

    if (replay) {
      return fail('APPROVAL_REPLAY', {
        CONCURRENT_REPLAY_REJECTED: true,
        DURABLE_ONE_TIME_CONSUMPTION: true,
      });
    }
    if (!inserted) return fail('CONSUME_FAILED');
    return {
      result: 'OK',
      ok: true,
      code: 'CONSUMED',
      approvalId,
      requestHash,
      accountP: prelimAccount,
      deviceId,
      DURABLE_ONE_TIME_CONSUMPTION: true,
      TRUSTED_W1A_PROOF_VERIFIED: true,
      WEBAUTHN_UV_PROVEN: true,
    };
  }

  /**
   * ROOT-signed auth for SET_GLOBAL_STATUS.
   * Accepts fresh kind 22242 (preferred) or ROOT-signed kind 39005 mirror from Admin 2FA.
   */
  validateGlobalStatusAuth(auth, targetPk, status) {
    const now = Math.floor(Date.now() / 1000);
    const age = Math.abs(now - Number(auth.created_at || 0));
    if (age > 300) return fail('AUTH_STALE');
    const expTag = (auth.tags || []).find((t) => Array.isArray(t) && t[0] === 'expiration');
    const pTag = (auth.tags || []).find((t) => Array.isArray(t) && t[0] === 'p');
    const pFromTag = pTag ? String(pTag[1] || '').toLowerCase() : '';

    if (Number(auth.kind) === 22242) {
      let body;
      try {
        body = JSON.parse(auth.content || '{}');
      } catch (_e) {
        return fail('BAD_AUTH_CONTENT');
      }
      if (!body || body.purpose !== 'SET_GLOBAL_STATUS') return fail('BAD_AUTH_PURPOSE');
      if (String(body.status || '').toUpperCase() !== status) return fail('AUTH_STATUS_MISMATCH');
      if (pFromTag !== targetPk) return fail('AUTH_TARGET_MISMATCH');
      if (!expTag || Number(expTag[1]) < now) return fail('AUTH_EXPIRED');
      return { ok: true, mode: '22242' };
    }

    if (Number(auth.kind) === 39005) {
      // Privileged community account-status event used only as ROOT intent proof for Worker mirror.
      let body;
      try {
        body = JSON.parse(auth.content || '{}');
      } catch (_e) {
        return fail('BAD_AUTH_CONTENT');
      }
      const legacyStatus = String((body && body.status) || '').toUpperCase();
      const mapped =
        legacyStatus === 'DISABLED' || legacyStatus === 'ACCOUNT_DISABLED'
          ? 'ACCOUNT_DISABLED'
          : legacyStatus === 'ENABLED' || legacyStatus === 'ACTIVE'
            ? 'ACTIVE'
            : '';
      if (mapped !== status) return fail('AUTH_STATUS_MISMATCH');
      const target = String((body && body.targetPubkey) || pFromTag || '').toLowerCase();
      if (target !== targetPk) return fail('AUTH_TARGET_MISMATCH');
      // 39005 does not require expiration tag; freshness via created_at age above.
      return { ok: true, mode: '39005' };
    }

    return fail('BAD_AUTH_KIND', { COMMUNITY_ADMIN_GLOBAL_DISABLE_ACCEPTED: false });
  }

  rateLookup() {
    const now = Date.now();
    if (now - this.lookupWindowStart > LOOKUP_WINDOW_MS) {
      this.lookupWindowStart = now;
      this.lookupWindowCount = 0;
    }
    this.lookupWindowCount += 1;
    return this.lookupWindowCount > LOOKUP_WINDOW_MAX;
  }

  async requireLookupAuth(authEvent) {
    if (!authEvent || !verifyEvent(authEvent)) {
      return fail('UNAUTHORIZED', { ANONYMOUS_GENERAL_PHONE_LOOKUP: false });
    }
    const pk = String(authEvent.pubkey || '').toLowerCase();
    if (!HEX64.test(pk)) return fail('UNAUTHORIZED');
    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(authEvent.created_at || 0));
    if (age > 120) return fail('UNAUTHORIZED', { code: 'AUTH_STALE' });
    // Reject disabled accounts from using lookup as searcher.
    const st = this.getStatus(pk);
    if (st.ACCOUNT_DISABLED) {
      return fail('UNAUTHORIZED', { code: 'ACCOUNT_DISABLED', DISABLED_PUBKEY_CAN_USE_SOCALL: false });
    }
    return { ok: true, pubkey: pk };
  }

  async checkNewAccountInvitePhone(body) {
    const inviteId = String(body.inviteId || '').toLowerCase();
    const phone = body.phone;
    if (!HEX64.test(inviteId)) return fail('BAD_INVITE_ID');
    const tok = await computePhoneToken(this.env, phone);
    if (!tok.ok) return fail(tok.code);
    const rows = this.ctx.storage.sql.exec('SELECT * FROM new_account_invites WHERE invite_id = ?', inviteId).toArray();
    if (!rows.length) return fail('UNKNOWN_INVITE');
    const row = rows[0];
    if (row.state === 'PHONE_CONFLICT') {
      return fail('PHONE_ALREADY_REGISTERED', {
        WRONG_PHONE_CONSUMES_INVITE: false,
        INVITE_STATE: 'PHONE_CONFLICT',
        FAILED_REDEEM_INVITE_PERMANENTLY_CLAIMED: false,
      });
    }
    if (row.state !== 'UNUSED') return fail('ALREADY_USED', { WRONG_PHONE_CONSUMES_INVITE: false });
    if (row.expires_at * 1000 < Date.now()) return fail('EXPIRED');
    if (!phoneTokensEqual(row.phone_token, tok.phoneToken)) {
      return {
        result: 'INVALID',
        code: 'WRONG_PHONE',
        ok: false,
        WRONG_PHONE_INVITE_REDEEM_ACCEPTED: false,
        WRONG_PHONE_CREATES_IDENTITY: false,
        WRONG_PHONE_CONSUMES_INVITE: false,
        message: 'מספר הטלפון אינו תואם להזמנה.',
      };
    }
    return {
      result: 'OK',
      ok: true,
      inviteId,
      INVITE_REDEEM_PHONE_CHECK_SCOPED: true,
      // never return phoneToken
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    let body = {};
    if (request.method === 'POST') {
      try {
        body = await request.json();
      } catch (_e) {
        return Response.json(fail('BAD_JSON'), { status: 400 });
      }
    }
    try {
      if (path === '/meta') {
        return Response.json({
          result: 'OK',
          GLOBAL_ACCOUNT_CERT_KIND,
          GLOBAL_ACCOUNT_STATUS_KIND,
          PHONE_TOKEN_SCHEME,
          PHONE_PROOF_LEVEL,
          PHONE_TOKEN_CLIENT_COMPUTABLE: false,
          PHONE_TOKEN_COMMUNITY_SCOPED: false,
          GLOBAL_PHONE_DIRECTORY_PUBLICLY_ENUMERABLE: false,
          PHONE_REBIND_NOT_IMPLEMENTED_YET: true,
          COMMUNITY_HTML_MODEL_PHASE1: 'SAME_ORIGIN',
          CROSS_ORIGIN_COMMUNITY_HTML_DEFERRED: true,
          issuerPubkey: servicePubkey(this.env),
        });
      }
      if (path === '/phone/normalize') {
        const n = normalizePhoneE164(body.phone);
        return Response.json(n.ok ? { result: 'OK', e164: n.e164, digits: n.digits } : fail(n.code));
      }
      if (path === '/phone/lookup') {
        if (this.rateLookup()) return Response.json({ result: 'TEMPORARILY_UNAVAILABLE', code: 'RATE_LIMITED' }, { status: 429 });
        // ANONYMOUS_GENERAL_PHONE_LOOKUP=false — require fresh signed auth from a global SOS identity.
        const authOk = await this.requireLookupAuth(body.authEvent);
        if (!authOk.ok) return Response.json(authOk, { status: 401 });
        return Response.json(await this.lookupPhone(body.phone, { searcherPubkey: authOk.pubkey }));
      }
      if (path === '/invites/new-account/check-phone') {
        if (this.rateLookup()) return Response.json({ result: 'TEMPORARILY_UNAVAILABLE', code: 'RATE_LIMITED' }, { status: 429 });
        // INVITE_REDEEM_PHONE_CHECK_SCOPED=true — narrow check; does not consume invite.
        return Response.json(await this.checkNewAccountInvitePhone(body));
      }
      if (path === '/phone/bind') {
        // Public general-purpose phone bind is disabled. New accounts bind only via NEW_ACCOUNT invite redeem.
        // Existing-account phone linking is not an accepted product feature yet.
        return Response.json(
          fail('UNAUTHORIZED', {
            code: 'PHONE_REBIND_NOT_IMPLEMENTED_YET',
            PHONE_REBIND_NOT_IMPLEMENTED_YET: true,
            UNAUTHORIZED_PHONE_BIND_ACCEPTED: false,
            PHONE_BIND_TAKEOVER_ACCEPTED: false,
            NEW_ACCOUNT_PHONE_INVITE_FLOW_PRESERVED: true,
            LEGACY_USER_PHONE_REQUIRED: false,
            message: 'Public phone bind disabled. Use NEW_ACCOUNT invite redeem.',
          }),
          { status: 401 },
        );
      }
      if (path === '/account/cert/issue') {
        return Response.json(await this.issueCertHttp(body));
      }
      if (path === '/account/status/set') {
        return Response.json(await this.setStatus(body));
      }
      if (path === '/account/status/get') {
        return Response.json(this.getStatus(body.pubkey));
      }
      if (path === '/account/exists') {
        return Response.json(this.accountExists(body.pubkey));
      }
      if (path === '/invites/new-account/register') {
        return Response.json(await this.registerNewAccountInvite(body));
      }
      if (path === '/invites/new-account/redeem') {
        return Response.json(await this.redeemNewAccountInvite(body));
      }
      if (path === '/invites/new-account/status') {
        return Response.json(this.newAccountInviteStatus(body.inviteId));
      }
      if (path === '/ald/approval/consume') {
        return Response.json(await this.consumeAldApproval(body));
      }
      return Response.json(fail('NOT_FOUND'), { status: 404 });
    } catch (e) {
      const code = (e && e.code) || 'INTERNAL';
      return Response.json({ result: 'INVALID', code, message: String((e && e.message) || e).slice(0, 160) }, { status: 400 });
    }
  }

  accountExists(pubkey) {
    const pk = String(pubkey || '').toLowerCase();
    if (!HEX64.test(pk)) return fail('BAD_PUBKEY');
    const rows = this.ctx.storage.sql.exec('SELECT pubkey, status, revision, account_created_at FROM accounts WHERE pubkey = ?', pk).toArray();
    if (!rows.length) return { result: 'OK', exists: false, GLOBAL_ACCOUNT_EXISTS: false };
    const r = rows[0];
    return {
      result: 'OK',
      exists: true,
      GLOBAL_ACCOUNT_EXISTS: true,
      pubkey: r.pubkey,
      status: r.status,
      revision: r.revision,
      accountCreatedAt: r.account_created_at,
      SELF_ASSERTED_37377_SUFFICIENT: false,
    };
  }

  getStatus(pubkey) {
    const pk = String(pubkey || '').toLowerCase();
    if (!HEX64.test(pk)) return fail('BAD_PUBKEY');
    let issuer = '';
    try {
      issuer = servicePubkey(this.env);
    } catch (_e) {
      issuer = '';
    }
    const rows = this.ctx.storage.sql
      .exec('SELECT status, revision, updated_at, status_event_json FROM accounts WHERE pubkey = ?', pk)
      .toArray();
    if (!rows.length) {
      return {
        result: 'OK',
        status: 'ACTIVE',
        revision: 0,
        exists: false,
        statusEvent: null,
        issuerPubkey: issuer || null,
        // No global tip on file — legacy accounts without 39007 remain login-eligible; not a disable proof.
        LEGACY_NO_STATUS_RECORD: true,
      };
    }
    const r = rows[0];
    let statusEvent = null;
    try {
      statusEvent = r.status_event_json ? JSON.parse(r.status_event_json) : null;
    } catch (_e) {
      statusEvent = null;
    }
    return {
      result: 'OK',
      exists: true,
      status: r.status,
      revision: r.revision,
      updatedAt: r.updated_at,
      ACCOUNT_DISABLED: r.status === 'ACCOUNT_DISABLED',
      statusEvent,
      event: statusEvent,
      issuerPubkey: (statusEvent && statusEvent.pubkey) || issuer || null,
    };
  }

  async lookupPhone(phone, opts) {
    const tok = await computePhoneToken(this.env, phone);
    if (!tok.ok) return fail(tok.code);
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT pubkey, revision, status FROM phone_bindings
         WHERE phone_token = ? AND status = 'ACTIVE' ORDER BY revision DESC LIMIT 1`,
        tok.phoneToken,
      )
      .toArray();
    if (!rows.length) {
      return {
        result: 'OK',
        registered: false,
        PHONE_LOOKUP_REQUIRES_SHARED_COMMUNITY: false,
        PHONE_PREFIX_SEARCH: false,
      };
    }
    const row = rows[0];
    const st = this.getStatus(row.pubkey);
    // DISABLED: do not leak reason; privacy-safe unavailable for invite/search UX.
    if (st.status === 'ACCOUNT_DISABLED') {
      return {
        result: 'OK',
        registered: true,
        unavailable: true,
        contactable: false,
        pubkey: null,
        ACCOUNT_DISABLED_REASON_LEAKED_TO_SEARCHER: false,
        DISABLED_PHONE_NEW_ACCOUNT_INVITE_CREATED: false,
        PHONE_LOOKUP_REQUIRES_SHARED_COMMUNITY: false,
      };
    }
    return {
      result: 'OK',
      registered: true,
      unavailable: false,
      pubkey: row.pubkey,
      bindingRevision: row.revision,
      accountStatus: 'ACTIVE',
      contactable: true,
      PHONE_LOOKUP_REQUIRES_SHARED_COMMUNITY: false,
      searcher: opts && opts.searcherPubkey ? 'auth' : undefined,
    };
  }

  /**
   * Sync phone bind used inside storage.transactionSync (no await).
   * phoneToken must already be computed by the caller.
   */
  bindPhoneTokenSync(phoneToken, pubkey, now) {
    const pk = String(pubkey || '').toLowerCase();
    const existing = this.ctx.storage.sql
      .exec(`SELECT pubkey, status, revision FROM phone_bindings WHERE phone_token = ? AND status = 'ACTIVE' LIMIT 1`, phoneToken)
      .toArray();
    if (existing.length && existing[0].pubkey !== pk) {
      return fail('PHONE_ALREADY_REGISTERED', {
        pubkey: existing[0].pubkey,
        SAME_PHONE_CAN_CREATE_SECOND_ACTIVE_ACCOUNT: false,
      });
    }
    if (existing.length && existing[0].pubkey === pk) {
      return {
        result: 'OK',
        already: true,
        pubkey: pk,
        revision: existing[0].revision,
        PHONE_BINDING_CREATED_ONCE: true,
        PHONE_BINDING_REVISIONED: true,
      };
    }
    const prior = this.ctx.storage.sql.exec(`SELECT MAX(revision) AS m FROM phone_bindings WHERE phone_token = ?`, phoneToken).toArray();
    const rev = (prior[0] && prior[0].m ? Number(prior[0].m) : 0) + 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO phone_bindings (phone_token, pubkey, revision, status, created_at, updated_at)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?)
       ON CONFLICT(phone_token) DO UPDATE SET
         pubkey = excluded.pubkey,
         revision = excluded.revision,
         status = 'ACTIVE',
         updated_at = excluded.updated_at`,
      phoneToken,
      pk,
      rev,
      now,
      now,
    );
    return {
      result: 'OK',
      pubkey: pk,
      revision: rev,
      PHONE_BINDING_CREATED_ONCE: true,
      PHONE_BINDING_REVISIONED: true,
    };
  }

  /**
   * Internal phone bind only (redeem path). Public HTTP /phone/bind is denied in fetch().
   */
  async bindPhone(body) {
    return fail('UNAUTHORIZED', {
      code: 'PHONE_REBIND_NOT_IMPLEMENTED_YET',
      PHONE_REBIND_NOT_IMPLEMENTED_YET: true,
      UNAUTHORIZED_PHONE_BIND_ACCEPTED: false,
    });
  }

  /**
   * HTTP /account/cert/issue — never mint from anonymous callers or self-signed 37377.
   * New 39007 only via redeem internal authority. ROOT may re-fetch an existing cert (idempotent).
   */
  async issueCertHttp(body) {
    const pk = String(body.pubkey || '').toLowerCase();
    if (!HEX64.test(pk)) return fail('BAD_PUBKEY');
    // Client-supplied issuer / isAdmin / authorized flags are ignored (never trusted).
    const auth = body.authEvent;
    if (!auth || !verifyEvent(auth)) {
      return fail('UNAUTHORIZED', {
        code: 'CERT_ISSUE_AUTH_REQUIRED',
        UNAUTHORIZED_39007_ISSUANCE_ACCEPTED: false,
        FORGED_37377_MIGRATION_ACCEPTED: false,
        SELF_ASSERTED_37377_GLOBAL_ACCOUNT_ACCEPTED: false,
      });
    }
    if (!rootOk(this.env, auth.pubkey)) {
      return fail('UNAUTHORIZED', {
        code: 'NOT_GLOBAL_ROOT',
        UNAUTHORIZED_39007_ISSUANCE_ACCEPTED: false,
        FORGED_37377_MIGRATION_ACCEPTED: false,
      });
    }
    const now = Math.floor(Date.now() / 1000);
    const age = Math.abs(now - Number(auth.created_at || 0));
    if (age > 300) return fail('AUTH_STALE');
    const expTag = (auth.tags || []).find((t) => Array.isArray(t) && t[0] === 'expiration');
    if (!expTag || Number(expTag[1]) < now) return fail('AUTH_EXPIRED');
    const pTag = (auth.tags || []).find((t) => Array.isArray(t) && t[0] === 'p');
    if (!pTag || String(pTag[1] || '').toLowerCase() !== pk) return fail('AUTH_TARGET_MISMATCH');
    let content;
    try {
      content = JSON.parse(auth.content || '{}');
    } catch (_e) {
      return fail('BAD_AUTH_CONTENT');
    }
    if (!content || content.purpose !== 'ISSUE_GLOBAL_CERT') return fail('BAD_AUTH_PURPOSE');
    const spent = this.spendAuth(auth.id, 'ISSUE_GLOBAL_CERT');
    if (!spent.ok) return spent;

    const existing = this.ctx.storage.sql.exec('SELECT revision, cert_event_json FROM accounts WHERE pubkey = ?', pk).toArray();
    if (!existing.length) {
      // No automatic legacy migration / no mint of new K or P via HTTP.
      return fail('UNAUTHORIZED', {
        code: 'NO_LEGACY_AUTO_MINT',
        FORGED_37377_MIGRATION_ACCEPTED: false,
        SELF_ASSERTED_37377_GLOBAL_ACCOUNT_ACCEPTED: false,
        UNAUTHORIZED_39007_ISSUANCE_ACCEPTED: false,
        message: 'New 39007 only via NEW_ACCOUNT invite redeem',
      });
    }
    return this.issueCert({ pubkey: pk, allowIdempotent: true }, { internalAuthority: 'ROOT_IDEMPOTENT_READ' });
  }

  /**
   * Mint or re-fetch 39007. Callers must pass internalAuthority from redeem or ROOT idempotent read.
   * Never trust body.issuer / isAdmin / authorized.
   */
  async issueCert(body, opts) {
    const authority = opts && opts.internalAuthority;
    if (authority !== 'REDEEM_TXN' && authority !== 'ROOT_IDEMPOTENT_READ') {
      return fail('UNAUTHORIZED', {
        UNAUTHORIZED_39007_ISSUANCE_ACCEPTED: false,
        FORGED_37377_MIGRATION_ACCEPTED: false,
      });
    }
    const pk = String(body.pubkey || '').toLowerCase();
    if (!HEX64.test(pk)) return fail('BAD_PUBKEY');
    const now = Math.floor(Date.now() / 1000);
    const existing = this.ctx.storage.sql.exec('SELECT revision, status, cert_event_json FROM accounts WHERE pubkey = ?', pk).toArray();
    if (existing.length) {
      return {
        result: 'OK',
        already: true,
        GLOBAL_ACCOUNT_CREATED_ONCE: true,
        GLOBAL_ACCOUNT_CERT_EXACT_P_BINDING: true,
        pubkey: pk,
        revision: existing[0].revision,
        cert: existing[0].cert_event_json ? JSON.parse(existing[0].cert_event_json) : null,
        SELF_ASSERTED_37377_GLOBAL_ACCOUNT_ACCEPTED: false,
        GLOBAL_ACCOUNT_DEPENDS_ON_ISRAEL_NETWORK: false,
      };
    }
    if (authority === 'ROOT_IDEMPOTENT_READ') {
      return fail('UNAUTHORIZED', { code: 'NO_LEGACY_AUTO_MINT', FORGED_37377_MIGRATION_ACCEPTED: false });
    }
    const { sk, pk: issuer } = loadSk(this.env);
    const revision = 1;
    const content = JSON.stringify({
      schema: 'sos-global-account-cert',
      version: 1,
      pubkey: pk,
      accountCreatedAt: now,
      revision,
      status: 'ACTIVE',
      issuer,
      GLOBAL_ACCOUNT_DEPENDS_ON_ISRAEL_NETWORK: false,
      GLOBAL_ACCOUNT_CERT_EXACT_P_BINDING: true,
    });
    const draft = {
      kind: GLOBAL_ACCOUNT_CERT_KIND,
      created_at: now,
      tags: [
        ['d', pk + ':' + revision],
        ['p', pk],
        ['t', 'sos-global-account'],
        ['rev', String(revision)],
        ['status', 'ACTIVE'],
      ],
      content,
    };
    const cert = finalizeEvent(draft, sk);
    // Exact P binding: cert.tags p and content.pubkey must equal requested pk.
    if (String(cert.pubkey).toLowerCase() !== String(issuer).toLowerCase()) {
      return fail('ISSUER_MISMATCH');
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO accounts (pubkey, revision, status, account_created_at, updated_at, cert_event_json, status_event_json)
       VALUES (?, ?, 'ACTIVE', ?, ?, ?, NULL)`,
      pk,
      revision,
      now,
      now,
      JSON.stringify(cert),
    );
    return {
      result: 'OK',
      GLOBAL_ACCOUNT_CREATED_ONCE: true,
      GLOBAL_ACCOUNT_CERT_EXACT_P_BINDING: true,
      pubkey: pk,
      revision,
      cert,
      SELF_ASSERTED_37377_GLOBAL_ACCOUNT_ACCEPTED: false,
      GLOBAL_ACCOUNT_DEPENDS_ON_ISRAEL_NETWORK: false,
      UNAUTHORIZED_39007_ISSUANCE_ACCEPTED: false,
    };
  }

  async setStatus(body) {
    // Only designated global ROOT may authorize; community capability alone is insufficient.
    const auth = body.authEvent;
    if (!auth || !verifyEvent(auth)) {
      return fail('UNAUTHORIZED', {
        COMMUNITY_ADMIN_GLOBAL_DISABLE_ACCEPTED: false,
        UNAUTHORIZED_SET_STATUS_ACCEPTED: false,
      });
    }
    if (!rootOk(this.env, auth.pubkey)) {
      return fail('UNAUTHORIZED', {
        code: 'NOT_GLOBAL_ROOT',
        COMMUNITY_ADMIN_GLOBAL_DISABLE_ACCEPTED: false,
        UNAUTHORIZED_SET_STATUS_ACCEPTED: false,
      });
    }
    const pk = String(body.targetPubkey || '').toLowerCase();
    const status = String(body.status || '').toUpperCase();
    if (!HEX64.test(pk)) return fail('BAD_PUBKEY');
    if (status !== 'ACTIVE' && status !== 'ACCOUNT_DISABLED') return fail('BAD_STATUS');

    const bound = this.validateGlobalStatusAuth(auth, pk, status);
    if (!bound.ok) {
      return Object.assign(bound, {
        UNAUTHORIZED_SET_STATUS_ACCEPTED: false,
        COMMUNITY_ADMIN_GLOBAL_DISABLE_ACCEPTED: false,
      });
    }
    const spent = this.spendAuth(auth.id, 'SET_GLOBAL_STATUS');
    if (!spent.ok) return spent;

    const now = Math.floor(Date.now() / 1000);
    const rows = this.ctx.storage.sql.exec('SELECT revision, status FROM accounts WHERE pubkey = ?', pk).toArray();
    const priorRev = rows.length ? Number(rows[0].revision) : 0;
    const expectedRev = body.expectedRevision != null ? Number(body.expectedRevision) : null;
    if (expectedRev != null && Number.isFinite(expectedRev) && expectedRev !== priorRev) {
      return fail('REVISION_CONFLICT', { currentRevision: priorRev, expectedRevision: expectedRev });
    }
    const revision = priorRev + 1;
    const { sk, pk: issuer } = loadSk(this.env);
    const content = JSON.stringify({
      schema: 'sos-global-account-status',
      version: 1,
      targetPubkey: pk,
      status,
      revision,
      issuedAt: now,
      reasonCode: String(body.reasonCode || 'ADMIN_DISABLED').slice(0, 64),
      issuer,
      ACCOUNT_DISABLED_GLOBAL: true,
      COMMUNITY_ADMIN_GLOBAL_DISABLE_ACCEPTED: false,
      authMode: bound.mode,
    });
    const draft = {
      kind: GLOBAL_ACCOUNT_STATUS_KIND,
      created_at: now,
      tags: [
        ['d', pk + ':' + revision],
        ['p', pk],
        ['t', 'sos-global-account-status'],
        ['rev', String(revision)],
        ['status', status],
      ],
      content,
    };
    const ev = finalizeEvent(draft, sk);
    if (!rows.length) {
      this.ctx.storage.sql.exec(
        `INSERT INTO accounts (pubkey, revision, status, account_created_at, updated_at, cert_event_json, status_event_json)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        pk,
        revision,
        status,
        now,
        now,
        JSON.stringify(ev),
      );
    } else {
      this.ctx.storage.sql.exec(
        `UPDATE accounts SET revision = ?, status = ?, updated_at = ?, status_event_json = ? WHERE pubkey = ?`,
        revision,
        status,
        now,
        JSON.stringify(ev),
        pk,
      );
    }
    return {
      result: 'OK',
      targetPubkey: pk,
      status,
      revision,
      event: ev,
      statusEvent: ev,
      issuerPubkey: issuer,
      ACCOUNT_DISABLED_GLOBAL: true,
      COMMUNITY_ADMIN_GLOBAL_DISABLE_ACCEPTED: false,
      UNAUTHORIZED_SET_STATUS_ACCEPTED: false,
      GLOBAL_DISABLE_SIGNATURE_VERIFIED: true,
    };
  }

  async registerNewAccountInvite(body) {
    const invite = body.invite;
    if (!invite || invite.kind !== 37378 || !HEX64.test(String(invite.id || '').toLowerCase())) return fail('BAD_INVITE');
    if (!verifyEvent(invite)) return fail('BAD_INVITE_SIG');
    const purposeTag = (invite.tags || []).find((t) => Array.isArray(t) && t[0] === 'purpose');
    const purpose = purposeTag ? String(purposeTag[1] || '') : String(body.purpose || '');
    if (purpose !== INVITE_PURPOSE_NEW_ACCOUNT) return fail('WRONG_PURPOSE');
    const phone = body.recipientPhone || body.phone;
    const tok = await computePhoneToken(this.env, phone);
    if (!tok.ok) return fail(tok.code);
    // Conflict: phone already registered → do not create new-account invite
    const bound = this.ctx.storage.sql
      .exec(`SELECT pubkey FROM phone_bindings WHERE phone_token = ? AND status = 'ACTIVE' LIMIT 1`, tok.phoneToken)
      .toArray();
    if (bound.length) {
      const st = this.getStatus(bound[0].pubkey);
      if (st.status === 'ACCOUNT_DISABLED') {
        return fail('PHONE_UNAVAILABLE', {
          registered: true,
          unavailable: true,
          ACCOUNT_DISABLED_REASON_LEAKED_TO_SEARCHER: false,
          DISABLED_PHONE_NEW_ACCOUNT_INVITE_CREATED: false,
        });
      }
      return fail('PHONE_ALREADY_REGISTERED', { pubkey: bound[0].pubkey, registered: true });
    }
    const ih = (invite.tags || []).find((t) => Array.isArray(t) && t[0] === 'ih');
    const inviteHash = ih ? String(ih[1] || '').toLowerCase() : '';
    if (!HEX64.test(inviteHash)) return fail('BAD_INVITE_HASH');
    const expTag = (invite.tags || []).find((t) => Array.isArray(t) && t[0] === 'expiration');
    const expiresAt = expTag ? Number(expTag[1]) : 0;
    if (!expiresAt || expiresAt * 1000 < Date.now()) return fail('EXPIRED');
    const inviteId = String(invite.id).toLowerCase();
    const now = Math.floor(Date.now() / 1000);
    const prior = this.ctx.storage.sql.exec('SELECT state FROM new_account_invites WHERE invite_id = ?', inviteId).toArray();
    if (prior.length) return { result: 'OK', already: true, inviteId, state: prior[0].state };
    this.ctx.storage.sql.exec(
      `INSERT INTO new_account_invites
        (invite_id, phone_token, invite_hash, creator_pubkey, expires_at, state, redeemer_pubkey, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'UNUSED', NULL, ?, ?)`,
      inviteId,
      tok.phoneToken,
      inviteHash,
      String(invite.pubkey).toLowerCase(),
      expiresAt,
      now,
      now,
    );
    return {
      result: 'OK',
      inviteId,
      NEW_ACCOUNT_INVITE_PHONE_BOUND: true,
      CLIENT_CAN_FORGE_INVITE_PHONE_BINDING: false,
      WHATSAPP_SPECIFIC_RECIPIENT: true,
      // e164 returned only to creator path for WhatsApp targeting — not phoneToken
      recipientE164: tok.e164,
      PHONE_PROOF_LEVEL,
    };
  }

  /**
   * NEW_ACCOUNT invite state machine (this DO only; not First Group membership ledger):
   *   UNUSED → USED            (atomic claim+phone-bind winner)
   *   UNUSED → PHONE_CONFLICT  (atomic: phone already bound to another P; invite not consumed as account)
   *   USED   → USED            (idempotent retry by same redeemerPubkey)
   *   PHONE_CONFLICT is terminal for this invite (not UNAUSED; never creates account/binding)
   * Legacy CLAIMED treated as USED for winner idempotency only.
   *
   * Transaction boundary: phoneToken HMAC + code hash are computed OUTSIDE the txn (WebCrypto awaits).
   * claim uniqueness + phone_bindings ACTIVE insert run inside ONE storage.transactionSync (same DO/SQLite).
   * Cert signing (39007) is AFTER the txn and is idempotent — not part of the phone uniqueness txn.
   * First Group membership finalization is OUTSIDE this DO entirely.
   */
  requireRedeemerAuth(body, inviteId, redeemer) {
    const auth = body.redeemerAuthEvent;
    if (!auth || !verifyEvent(auth)) {
      return fail('UNAUTHORIZED', {
        code: 'REDEEMER_AUTH_REQUIRED',
        REDEEMER_AUTH_REQUIRED: true,
      });
    }
    if (String(auth.pubkey || '').toLowerCase() !== redeemer) {
      return fail('UNAUTHORIZED', { code: 'REDEEMER_MISMATCH' });
    }
    const now = Math.floor(Date.now() / 1000);
    const age = Math.abs(now - Number(auth.created_at || 0));
    if (age > 300) return fail('AUTH_STALE');
    const expTag = (auth.tags || []).find((t) => Array.isArray(t) && t[0] === 'expiration');
    if (!expTag || Number(expTag[1]) < now) return fail('AUTH_EXPIRED');
    let content;
    try {
      content = JSON.parse(auth.content || '{}');
    } catch (_e) {
      return fail('BAD_AUTH_CONTENT');
    }
    if (!content || content.purpose !== 'REDEEM_NEW_ACCOUNT_INVITE') return fail('BAD_AUTH_PURPOSE');
    if (String(content.inviteId || '').toLowerCase() !== inviteId) return fail('AUTH_INVITE_MISMATCH');
    const spent = this.spendAuth(auth.id, 'REDEEM_NEW_ACCOUNT_INVITE');
    if (!spent.ok) return spent;
    return { ok: true };
  }

  async redeemNewAccountInvite(body) {
    const inviteId = String(body.inviteId || '').toLowerCase();
    const code = String(body.code || '').trim().toUpperCase();
    const phone = body.phone;
    const redeemer = String(body.redeemerPubkey || '').toLowerCase();
    if (!HEX64.test(inviteId) || !HEX64.test(redeemer) || !code) return fail('BAD_REQUEST');
    const tok = await computePhoneToken(this.env, phone);
    if (!tok.ok) return fail(tok.code);

    const rows = this.ctx.storage.sql.exec('SELECT * FROM new_account_invites WHERE invite_id = ?', inviteId).toArray();
    if (!rows.length) return fail('UNKNOWN_INVITE');
    const row = rows[0];

    // Terminal phone conflict — invite was never a successful account redemption.
    if (row.state === 'PHONE_CONFLICT') {
      return fail('PHONE_ALREADY_REGISTERED', {
        INVITE_STATE: 'PHONE_CONFLICT',
        FAILED_REDEEM_INVITE_PERMANENTLY_CLAIMED: false,
        FAILED_REDEEM_CREATES_ACCOUNT: false,
        FAILED_REDEEM_CREATES_PHONE_BINDING: false,
        INVITE_CLAIM_CONFLICT_CLEANED: true,
      });
    }

    if (row.state === 'USED' || row.state === 'CLAIMED') {
      // Idempotent retry for the same redeemer — never create a second P binding.
      // Ownership already proven on first redeem; do not require a fresh single-use auth (would break retry).
      if (String(row.redeemer_pubkey || '').toLowerCase() === redeemer) {
        const cert = await this.issueCert({ pubkey: redeemer, allowIdempotent: true }, { internalAuthority: 'REDEEM_TXN' });
        return {
          result: 'OK',
          already: true,
          inviteId,
          redeemerPubkey: redeemer,
          INVITE_REDEEMED_ONCE: true,
          PHONE_BINDING_CREATED_ONCE: true,
          GLOBAL_ACCOUNT_CREATED_ONCE: true,
          GLOBAL_ACCOUNT_CERT_EXACT_P_BINDING: true,
          cert: cert.cert || null,
          ONBOARDING_RETRY_SECOND_INVITE_REDEEM: false,
          RETRY_IDEMPOTENT: true,
        };
      }
      return fail('ALREADY_USED', {
        INVITE_REDEEMED_ONCE: true,
        INVITE_REPLAY_ACCEPTED: false,
        redeemerPubkey: row.redeemer_pubkey || null,
      });
    }

    if (row.state !== 'UNUSED') return fail('ALREADY_USED', { INVITE_REDEEMED_ONCE: true });
    if (row.expires_at * 1000 < Date.now()) return fail('EXPIRED');
    if (!phoneTokensEqual(row.phone_token, tok.phoneToken)) {
      return fail('WRONG_PHONE', { WRONG_PHONE_INVITE_REDEEM_ACCEPTED: false, CLIENT_HASH_ONLY_REDEEM_ACCEPTED: false });
    }
    const enc = new TextEncoder();
    const dig = await crypto.subtle.digest('SHA-256', enc.encode(code));
    const codeHash = Array.from(new Uint8Array(dig), (b) => b.toString(16).padStart(2, '0')).join('');
    if (codeHash !== row.invite_hash) return fail('BAD_CODE');

    // Prove possession of redeemerPubkey before claim+bind (first redeem only).
    const redeemerOk = this.requireRedeemerAuth(body, inviteId, redeemer);
    if (!redeemerOk.ok) return redeemerOk;

    const now = Math.floor(Date.now() / 1000);
    let outcome = { code: 'INTERNAL' };
    this.ctx.storage.transactionSync(() => {
      const curRows = this.ctx.storage.sql.exec('SELECT * FROM new_account_invites WHERE invite_id = ?', inviteId).toArray();
      if (!curRows.length) {
        outcome = { code: 'UNKNOWN_INVITE' };
        return;
      }
      const cur = curRows[0];
      if (cur.state === 'PHONE_CONFLICT') {
        outcome = { code: 'PHONE_ALREADY_REGISTERED', conflict: true };
        return;
      }
      if (cur.state === 'USED' || cur.state === 'CLAIMED') {
        if (String(cur.redeemer_pubkey || '').toLowerCase() === redeemer) {
          outcome = { code: 'ALREADY_WON', already: true };
          return;
        }
        outcome = { code: 'ALREADY_USED' };
        return;
      }
      if (cur.state !== 'UNUSED') {
        outcome = { code: 'ALREADY_USED' };
        return;
      }

      const bound = this.ctx.storage.sql
        .exec(`SELECT pubkey FROM phone_bindings WHERE phone_token = ? AND status = 'ACTIVE' LIMIT 1`, tok.phoneToken)
        .toArray();
      if (bound.length && String(bound[0].pubkey).toLowerCase() !== redeemer) {
        // Losing invite: terminal PHONE_CONFLICT — not CLAIMED, not UNUSED, no account.
        this.ctx.storage.sql.exec(
          `UPDATE new_account_invites SET state = 'PHONE_CONFLICT', redeemer_pubkey = NULL, updated_at = ?
           WHERE invite_id = ? AND state = 'UNUSED'`,
          now,
          inviteId,
        );
        outcome = {
          code: 'PHONE_ALREADY_REGISTERED',
          conflict: true,
          winnerPubkey: bound[0].pubkey,
          INVITE_CLAIM_CONFLICT_CLEANED: true,
          LATE_LOSER_CANNOT_ROLLBACK_WINNER: true,
        };
        return;
      }

      const bind = this.bindPhoneTokenSync(tok.phoneToken, redeemer, now);
      if (bind.code === 'PHONE_ALREADY_REGISTERED') {
        this.ctx.storage.sql.exec(
          `UPDATE new_account_invites SET state = 'PHONE_CONFLICT', redeemer_pubkey = NULL, updated_at = ?
           WHERE invite_id = ? AND state = 'UNUSED'`,
          now,
          inviteId,
        );
        outcome = {
          code: 'PHONE_ALREADY_REGISTERED',
          conflict: true,
          winnerPubkey: bind.pubkey,
          INVITE_CLAIM_CONFLICT_CLEANED: true,
        };
        return;
      }

      this.ctx.storage.sql.exec(
        `UPDATE new_account_invites SET state = 'USED', redeemer_pubkey = ?, updated_at = ?
         WHERE invite_id = ? AND state = 'UNUSED'`,
        redeemer,
        now,
        inviteId,
      );
      outcome = {
        code: 'OK',
        already: !!bind.already,
        bindRevision: bind.revision,
        PHONE_BINDING_WINNER_UNCHANGED: true,
      };
    });

    if (outcome.code === 'PHONE_ALREADY_REGISTERED') {
      return fail('PHONE_ALREADY_REGISTERED', {
        pubkey: outcome.winnerPubkey || null,
        SAME_PHONE_CAN_CREATE_SECOND_ACTIVE_ACCOUNT: false,
        FAILED_REDEEM_INVITE_PERMANENTLY_CLAIMED: false,
        FAILED_REDEEM_CREATES_ACCOUNT: false,
        FAILED_REDEEM_CREATES_PHONE_BINDING: false,
        INVITE_CLAIM_CONFLICT_CLEANED: outcome.INVITE_CLAIM_CONFLICT_CLEANED === true,
        LATE_LOSER_CANNOT_ROLLBACK_WINNER: outcome.LATE_LOSER_CANNOT_ROLLBACK_WINNER === true,
        INVITE_STATE: 'PHONE_CONFLICT',
      });
    }
    if (outcome.code === 'ALREADY_USED') {
      return fail('ALREADY_USED', { INVITE_REDEEMED_ONCE: true, INVITE_REPLAY_ACCEPTED: false });
    }
    if (outcome.code === 'UNKNOWN_INVITE') return fail('UNKNOWN_INVITE');
    if (outcome.code !== 'OK' && outcome.code !== 'ALREADY_WON') {
      return fail(outcome.code || 'INTERNAL');
    }

    // Cert issuance is outside the phone-uniqueness txn; idempotent for retries.
    const cert = await this.issueCert({ pubkey: redeemer, allowIdempotent: true }, { internalAuthority: 'REDEEM_TXN' });
    return {
      result: 'OK',
      already: outcome.already === true || outcome.code === 'ALREADY_WON',
      inviteId,
      redeemerPubkey: redeemer,
      INVITE_REDEEMED_ONCE: true,
      PHONE_BINDING_CREATED_ONCE: true,
      GLOBAL_ACCOUNT_CREATED_ONCE: true,
      GLOBAL_ACCOUNT_CERT_EXACT_P_BINDING: true,
      cert: cert.cert || null,
      GLOBAL_ACCOUNT_DEPENDS_ON_ISRAEL_NETWORK: false,
      SELF_ASSERTED_37377_GLOBAL_ACCOUNT_ACCEPTED: false,
      UNAUTHORIZED_39007_ISSUANCE_ACCEPTED: false,
      WRONG_PHONE_INVITE_REDEEM_ACCEPTED: false,
      CLIENT_HASH_ONLY_REDEEM_ACCEPTED: false,
      PHONE_BINDING_WINNER_UNCHANGED: true,
      RETRY_IDEMPOTENT: true,
      NEW_ACCOUNT_PHONE_INVITE_FLOW_PRESERVED: true,
    };
  }

  newAccountInviteStatus(inviteId) {
    const id = String(inviteId || '').toLowerCase();
    if (!HEX64.test(id)) return fail('BAD_INVITE_ID');
    const rows = this.ctx.storage.sql.exec('SELECT state, expires_at, redeemer_pubkey FROM new_account_invites WHERE invite_id = ?', id).toArray();
    if (!rows.length) return { result: 'OK', known: false };
    return {
      result: 'OK',
      known: true,
      state: rows[0].state,
      expiresAt: rows[0].expires_at,
      redeemerPubkey: rows[0].redeemer_pubkey || null,
    };
  }
}
