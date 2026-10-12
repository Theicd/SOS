/**
 * MD3W-W1B — Durable one-time ALD approval consumption (SQLite DO).
 * Re-verifies W1A WebAuthn artifact. No Root K. No MD3 sign.
 */
import { verifyAldApprovalArtifact, validateAldConsumeAuth } from './ald-w1a-verify.js';

const HEX64 = /^[0-9a-f]{64}$/;

function fail(code, extra) {
  const o = { result: 'INVALID', ok: false, code: String(code || 'INVALID') };
  if (extra && typeof extra === 'object') Object.assign(o, extra);
  return o;
}

export class AldApprovalAuthority {
  constructor(state, env) {
    this.ctx = state;
    this.env = env;
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
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

  async consumeAldApproval(body) {
    await this.ready;
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
      ROOT_K_RETURNED: false,
    };
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const path = url.pathname;
    let body = {};
    try {
      body = await request.json();
    } catch (_e) {
      return Response.json(fail('BAD_JSON'), { status: 400 });
    }
    if (path === '/ald/approval/consume') {
      return Response.json(await this.consumeAldApproval(body));
    }
    return Response.json(fail('NOT_FOUND'), { status: 404 });
  }
}
