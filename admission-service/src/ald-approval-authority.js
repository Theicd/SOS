/**
 * MD3W-W1B — Durable one-time ALD approval consumption (SQLite DO).
 * Re-verifies W1A WebAuthn artifact. No Root K. No MD3 sign.
 */
import { verifyAldApprovalArtifact, validateAldConsumeAuth, validateScanLinkConsumeAuth, canonicalScanLinkJson, sha256HexUtf8 } from './ald-w1a-verify.js';

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
        CREATE TABLE IF NOT EXISTS scan_link_spent (
          pairing_id TEXT PRIMARY KEY,
          authorization_id TEXT NOT NULL UNIQUE,
          request_hash TEXT NOT NULL,
          account_p TEXT NOT NULL,
          device_id TEXT NOT NULL,
          spent_at INTEGER NOT NULL
        );
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

  async consumeScanLink(body) {
    await this.ready;
    const expected = body && body.expectedRequest;
    const authEvent = body && body.authEvent;
    if (!expected || !authEvent) return fail('BAD_REQUEST', { WEBAUTHN_UV_PROVEN: false, SCAN_ONLY_LINK: false });
    if (body.artifact || body.webauthnUvProven === true) {
      return fail('SCAN_ONLY_MIXED_AUTHORITY', { WEBAUTHN_UV_PROVEN: false, TRUSTED_W1A_PROOF_VERIFIED: false });
    }
    const accountP = String(expected.accountP || '').toLowerCase().replace(/^0x/, '');
    if (!HEX64.test(accountP)) return fail('BAD_ACCOUNT_P');
    const authOk = validateScanLinkConsumeAuth(authEvent, accountP);
    if (!authOk.ok) return fail(authOk.code || 'BAD_AUTH', { WEBAUTHN_UV_PROVEN: false });

    const requestHash = await sha256HexUtf8(canonicalScanLinkJson(expected));
    if (authOk.requestHash !== requestHash) return fail('REQUEST_HASH_MISMATCH');
    if (authOk.pairingId !== String(expected.pairingId || '').toLowerCase()) return fail('PAIRING_MISMATCH');
    if (authOk.authorizationId !== String(expected.authorizationId || '').toLowerCase()) return fail('AUTHORIZATION_MISMATCH');
    if (authOk.deviceId !== String(expected.deviceId || '').toLowerCase()) return fail('DEVICE_MISMATCH');

    const now = Date.now();
    const exp = Number(expected.expiresAt);
    if (!(exp > now) || exp - now > 8 * 24 * 3600 * 1000) return fail('BAD_EXPIRY');
    const caps = Array.isArray(expected.capabilities) ? expected.capabilities.map(String).sort() : [];
    const want = [
      'DEVICE_CALLS',
      'DEVICE_CHAT',
      'DEVICE_FILES',
      'DEVICE_HISTORY_SYNC',
      'DEVICE_P2P',
      'DEVICE_PRESENCE',
      'DEVICE_RECEIPTS',
      'DEVICE_SETTINGS',
    ];
    if (caps.length !== want.length || caps.some((c, i) => c !== want[i])) return fail('PRIVILEGED_CAPABILITY');

    const spentAuth = this.spendAuth(authEvent.id, 'SCAN_ONLY_LINK_CONSUME');
    if (!spentAuth.ok) return spentAuth;

    let replayCode = '';
    let inserted = false;
    this.ctx.storage.transactionSync(() => {
      const byPair = this.ctx.storage.sql.exec('SELECT pairing_id FROM scan_link_spent WHERE pairing_id = ?', authOk.pairingId).toArray();
      if (byPair.length) {
        replayCode = 'PAIRING_REPLAY';
        return;
      }
      const byAuth = this.ctx.storage.sql.exec('SELECT authorization_id FROM scan_link_spent WHERE authorization_id = ?', authOk.authorizationId).toArray();
      if (byAuth.length) {
        replayCode = 'AUTHORIZATION_REPLAY';
        return;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO scan_link_spent (pairing_id, authorization_id, request_hash, account_p, device_id, spent_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        authOk.pairingId,
        authOk.authorizationId,
        requestHash,
        accountP,
        authOk.deviceId,
        Math.floor(Date.now() / 1000),
      );
      inserted = true;
    });
    if (replayCode) {
      return fail(replayCode, { CONCURRENT_REPLAY_REJECTED: true, DURABLE_ONE_TIME_CONSUMPTION: true, WEBAUTHN_UV_PROVEN: false });
    }
    if (!inserted) return fail('CONSUME_FAILED');
    return {
      result: 'OK',
      ok: true,
      code: 'CONSUMED',
      requestHash,
      pairingId: authOk.pairingId,
      authorizationId: authOk.authorizationId,
      accountP,
      deviceId: authOk.deviceId,
      SCAN_ONLY_LINK: true,
      WEBAUTHN_UV_PROVEN: false,
      TRUSTED_W1A_PROOF_VERIFIED: false,
      DURABLE_ONE_TIME_CONSUMPTION: true,
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
    if (path === '/ald/scan-link/consume') {
      return Response.json(await this.consumeScanLink(body));
    }
    return Response.json(fail('NOT_FOUND'), { status: 404 });
  }
}
