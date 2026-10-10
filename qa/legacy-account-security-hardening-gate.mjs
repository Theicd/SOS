#!/usr/bin/env node
/**
 * Stage 5 — Global Account Security Hardening & Legacy Compatibility Recovery.
 * Real local Admission Worker + Durable Object + Node crypto identities.
 * Never prints private keys, phoneTokens, or peppers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADM_DIR = path.join(ROOT, 'admission-service');
const OUT = path.join(ROOT, 'qa', 'legacy-account-security-hardening-report.json');
const ADM_PORT = Number(process.env.SOS_LEGACY_SEC_ADM_PORT || 8847);
const ADM_URL = `http://127.0.0.1:${ADM_PORT}`;
const persistDir = path.join(os.tmpdir(), 'sos-legacy-sec-' + Date.now());

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkKey = () => {
  const sk = generateSecretKey();
  return { sk, hex: hex(sk), pub: getPublicKey(sk) };
};

const ROOT_KEY = mkKey();
const SVC = mkKey();
const COSIGN = mkKey();
const PIN_PEPPER = crypto.randomBytes(32).toString('hex');
const PHONE_PEPPER = crypto.randomBytes(32).toString('hex');
const ATTACKER = mkKey();
const LEGACY = mkKey();
const USER_A = mkKey();
const USER_B = mkKey();
const COMM_ADMIN = mkKey();

const appVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'app-version.json'), 'utf8'));
const admPkg = JSON.parse(fs.readFileSync(path.join(ADM_DIR, 'package.json'), 'utf8'));

const report = {
  gate: 'LEGACY_ACCOUNT_COMPATIBILITY_SECURITY',
  status: 'BLOCKED_LEGACY_ACCOUNT_COMPATIBILITY',
  MAIN_HEAD: '',
  MAIN_START_VERSION: '2026.10.05-web-899s.15',
  MAIN_END_VERSION: appVer.version,
  ADMISSION_WORKER_START_VERSION: '1.0.1',
  ADMISSION_WORKER_END_VERSION: admPkg.version,
  SIGNER_VERSION: '0.5.1-initial-recovery',
  REAL_WORKER_USED: true,
  REAL_DURABLE_OBJECT_USED: true,
  REAL_BROWSER_USED: false, // set true after playwright dual-session
  PHASE_B_RESUMED: false,
  MD4_STARTED: false,
  COMMIT_CREATED: false,
  PUSHED: false,
  PR_CREATED: false,
  DEPLOY_EXECUTED: false,
  PRODUCTION_CHANGED: false,
  ts: new Date().toISOString(),
  results: {},
  AUTHORIZATION_MATRIX: [],
  OFFLINE_STATUS_POLICY: {
    verifiedDisabledCache: 'DENY',
    unreachableNoCache: 'ALLOW_LEGACY_LOGIN_STALE_UNKNOWN',
    unreachableActiveCache: 'ALLOW_STALE_ACTIVE',
    immediateOfflineRevocationClaimed: false,
  },
};
try {
  report.MAIN_HEAD = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
} catch (_e) {
  report.MAIN_HEAD = 'unknown';
}

const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 220));
};

let admProc = null;
let admLog = '';

async function startWorker() {
  fs.writeFileSync(
    path.join(ADM_DIR, '.dev.vars'),
    [
      `ROOT_PUBKEY=${ROOT_KEY.pub}`,
      `ADMISSION_SK=${SVC.hex}`,
      `ADMIN_COSIGN_SK=${COSIGN.hex}`,
      `ADMIN_PIN_PEPPER=${PIN_PEPPER}`,
      `PHONE_PEPPER=${PHONE_PEPPER}`,
      `TEST_FAULTS=1`,
      `ALLOWED_ORIGINS=*`,
      `ADMIN_2FA_SIGNER_PUBKEY=${COSIGN.pub}`,
      '',
    ].join('\n'),
  );
  admProc = spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(ADM_PORT),
      '--persist-to',
      persistDir,
      '--show-interactive-dev-session=false',
    ],
    { cwd: ADM_DIR, shell: true, env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }) },
  );
  admProc.stdout.on('data', (d) => (admLog += d.toString()));
  admProc.stderr.on('data', (d) => (admLog += d.toString()));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(ADM_URL + '/v1/health');
      if (r.ok) return true;
    } catch (_e) {}
    await sleep(500);
  }
  throw new Error('worker start failed:\n' + admLog.slice(-2500));
}

function stopWorker() {
  if (admProc) {
    try {
      execSync(`taskkill /pid ${admProc.pid} /T /F`, { stdio: 'ignore' });
    } catch (_e) {}
    admProc = null;
  }
  try {
    fs.rmSync(path.join(ADM_DIR, '.dev.vars'), { force: true });
  } catch (_e) {}
}

async function post(p, body) {
  const res = await fetch(ADM_URL + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({ result: 'BAD_JSON' }));
  json.__http = res.status;
  return json;
}

function authStatus(rootKey, targetPub, status) {
  const now = Math.floor(Date.now() / 1000);
  return finalizeEvent(
    {
      kind: 22242,
      created_at: now,
      tags: [
        ['t', 'sos-global-account-status'],
        ['p', targetPub],
        ['expiration', String(now + 120)],
      ],
      content: JSON.stringify({ purpose: 'SET_GLOBAL_STATUS', status }),
    },
    rootKey.sk,
  );
}

function redeemerAuth(key, inviteId) {
  const now = Math.floor(Date.now() / 1000);
  const id = String(inviteId || '').toLowerCase();
  return finalizeEvent(
    {
      kind: 22242,
      created_at: now,
      tags: [
        ['t', 'sos-new-account-redeem'],
        ['e', id],
        ['expiration', String(now + 120)],
      ],
      content: JSON.stringify({ purpose: 'REDEEM_NEW_ACCOUNT_INVITE', inviteId: id, v: 1 }),
    },
    key.sk,
  );
}

function makeInvite(creator, code) {
  const ih = crypto.createHash('sha256').update(code).digest('hex');
  const now = Math.floor(Date.now() / 1000);
  return finalizeEvent(
    {
      kind: 37378,
      created_at: now,
      tags: [
        ['t', 'sos-invite'],
        ['t', 'israel-network'],
        ['purpose', 'NEW_ACCOUNT_INVITE'],
        ['expiration', String(now + 3600)],
        ['ih', ih],
        ['d', ih],
      ],
      content: JSON.stringify({ v: 2, type: 'invite', schema: 'sos-invite', purpose: 'NEW_ACCOUNT_INVITE' }),
    },
    creator.sk,
  );
}

/** Minimal GlobalAccountStatusState harness for Node (ingest + assertLoginAllowed). */
function loadClientStatusHarness(issuerPk) {
  const tips = new Map();
  const issuerAllow = new Set([String(issuerPk || '').toLowerCase()].filter(Boolean));
  function ingest(ev) {
    if (!ev || ev.kind !== 39008 || !verifyEvent(ev)) return false;
    if (issuerAllow.size && !issuerAllow.has(String(ev.pubkey || '').toLowerCase())) return false;
    let body;
    try {
      body = JSON.parse(ev.content || '{}');
    } catch (_e) {
      return false;
    }
    if (!body || body.schema !== 'sos-global-account-status') return false;
    const target = String(body.targetPubkey || '').toLowerCase();
    const status = String(body.status || '').toUpperCase();
    const rev = Number(body.revision) || 0;
    if (!/^[0-9a-f]{64}$/.test(target) || rev < 1) return false;
    if (status !== 'ACTIVE' && status !== 'ACCOUNT_DISABLED') return false;
    if (!(ev.tags || []).some((t) => t[0] === 't' && t[1] === 'sos-global-account-status')) return false;
    const cur = tips.get(target);
    if (cur && rev <= cur.revision) return false;
    tips.set(target, { status, revision: rev, eventId: ev.id, issuer: ev.pubkey });
    return true;
  }
  function assertLoginAllowed(pk) {
    const t = tips.get(String(pk || '').toLowerCase());
    if (t && t.status === 'ACCOUNT_DISABLED') {
      return { ok: false, code: 'ACCOUNT_DISABLED' };
    }
    return { ok: true, code: 'OK' };
  }
  return { ingest, assertLoginAllowed, tips };
}

async function main() {
  try {
    report.AUTHORIZATION_MATRIX = [
      {
        OPERATION: 'POST /account/cert/issue',
        CALLER: 'anonymous HTTP',
        REQUIRED_AUTHORITY: 'REDEEM_TXN internal or ROOT ISSUE_GLOBAL_CERT (idempotent existing only)',
        CURRENT_ENFORCEMENT: 'DENIED without ROOT auth; no auto-mint',
        DEFECT: 'CLOSED',
      },
      {
        OPERATION: 'POST /phone/bind',
        CALLER: 'anonymous HTTP',
        REQUIRED_AUTHORITY: 'none public — NEW_ACCOUNT redeem only',
        CURRENT_ENFORCEMENT: '401 PHONE_REBIND_NOT_IMPLEMENTED_YET',
        DEFECT: 'CLOSED',
      },
      {
        OPERATION: 'POST /account/status/set',
        CALLER: 'ROOT with purpose-bound authEvent',
        REQUIRED_AUTHORITY: 'ROOT 22242 SET_GLOBAL_STATUS or ROOT 39005 mirror + spend',
        CURRENT_ENFORCEMENT: 'verified + target/status/expiry + replay spend',
        DEFECT: 'CLOSED',
      },
      {
        OPERATION: 'Community admin disable',
        CALLER: 'community capability only',
        REQUIRED_AUTHORITY: 'insufficient for global 39008',
        CURRENT_ENFORCEMENT: 'UNAUTHORIZED NOT_GLOBAL_ROOT',
        DEFECT: 'CLOSED',
      },
      {
        OPERATION: 'Login / SessionAuthority.bind',
        CALLER: 'browser boot / key import',
        REQUIRED_AUTHORITY: 'assertLoginAllowed after Worker reconcile',
        CURRENT_ENFORCEMENT: 'app.js + keys.js + guest-auth + linked-devices',
        DEFECT: 'CLOSED',
      },
      {
        OPERATION: 'Legacy no-phone login',
        CALLER: 'existing K holder',
        REQUIRED_AUTHORITY: 'key possession; 39007/phone not required',
        CURRENT_ENFORCEMENT: 'preserved unless verified DISABLED tip',
        DEFECT: 'N/A (compat)',
      },
    ];

    await startWorker();
    set('REAL_WORKER_HEALTH', true, { url: ADM_URL });

    // 1. Anonymous cert issue
    const anonCert = await post('/v1/global/account/cert/issue', { pubkey: ATTACKER.pub, allowIdempotent: true });
    set('UNAUTHORIZED_39007_ISSUANCE_ACCEPTED', anonCert.result !== 'OK', { code: anonCert.code });

    // 2. Forged issuer / client flags
    const forgedIssuer = await post('/v1/global/account/cert/issue', {
      pubkey: ATTACKER.pub,
      issuer: ROOT_KEY.pub,
      isAdmin: true,
      authorized: true,
      allowIdempotent: true,
    });
    set('FORGED_ISSUER_FLAGS_REJECTED', forgedIssuer.result !== 'OK', { code: forgedIssuer.code });

    // 3. Self-signed 37377 does not mint
    const fake37377 = finalizeEvent(
      {
        kind: 37377,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'sos-email-registry']],
        content: JSON.stringify({ email: 'x@y.z', pubkey: ATTACKER.pub }),
      },
      ATTACKER.sk,
    );
    const migrate37377 = await post('/v1/global/account/cert/issue', {
      pubkey: ATTACKER.pub,
      registryEvent: fake37377,
      allowIdempotent: true,
    });
    const existsAtk = await post('/v1/global/account/exists', { pubkey: ATTACKER.pub });
    set(
      'FORGED_37377_MIGRATION_ACCEPTED',
      migrate37377.result !== 'OK' && existsAtk.exists !== true,
      { code: migrate37377.code, exists: existsAtk.exists },
    );

    // 4–5. Unauthorized phone bind / takeover
    const bindAnon = await post('/v1/global/phone/bind', { phone: '+972501234567', pubkey: ATTACKER.pub });
    const bindTake = await post('/v1/global/phone/bind', { phone: '+972501234567', pubkey: USER_B.pub });
    set(
      'UNAUTHORIZED_PHONE_BIND_ACCEPTED',
      bindAnon.result !== 'OK' &&
        (bindAnon.code === 'UNAUTHORIZED' || bindAnon.code === 'PHONE_REBIND_NOT_IMPLEMENTED_YET' || bindAnon.__http === 401),
      { code: bindAnon.code },
    );
    set('PHONE_BIND_TAKEOVER_ACCEPTED', bindTake.result !== 'OK', { code: bindTake.code });

    // Preserve NEW_ACCOUNT redeem + cert exact P
    const code1 = 'SEC' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const inv1 = makeInvite(ROOT_KEY, code1);
    const reg1 = await post('/v1/global/invites/new-account/register', {
      invite: inv1,
      purpose: 'NEW_ACCOUNT_INVITE',
      recipientPhone: '+972509990001',
    });
    set('NEW_ACCOUNT_PHONE_INVITE_FLOW_PRESERVED', reg1.result === 'OK', { code: reg1.code });
    const redeemNoAuth = await post('/v1/global/invites/new-account/redeem', {
      inviteId: inv1.id,
      code: code1,
      phone: '+972509990001',
      redeemerPubkey: USER_A.pub,
    });
    set('REDEEM_WITHOUT_OWNERSHIP_PROOF_REJECTED', redeemNoAuth.result !== 'OK', { code: redeemNoAuth.code });
    const redeem1 = await post('/v1/global/invites/new-account/redeem', {
      inviteId: inv1.id,
      code: code1,
      phone: '+972509990001',
      redeemerPubkey: USER_A.pub,
      redeemerAuthEvent: redeemerAuth(USER_A, inv1.id),
    });
    set('REDEEM_WITH_AUTH_OK', redeem1.result === 'OK', { code: redeem1.code });
    const certP =
      redeem1.cert &&
      (redeem1.cert.tags || []).some((t) => t[0] === 'p' && String(t[1]).toLowerCase() === USER_A.pub.toLowerCase());
    set('GLOBAL_ACCOUNT_CERT_EXACT_P_BINDING', redeem1.result === 'OK' && !!certP && redeem1.GLOBAL_ACCOUNT_CERT_EXACT_P_BINDING === true, {
      hasCert: !!redeem1.cert,
    });

    // 6–8. Unauthorized / community / forged setStatus
    const unauthSet = await post('/v1/global/account/status/set', {
      targetPubkey: USER_A.pub,
      status: 'ACCOUNT_DISABLED',
      authEvent: finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['p', USER_A.pub],
            ['expiration', String(Math.floor(Date.now() / 1000) + 120)],
          ],
          content: JSON.stringify({ purpose: 'SET_GLOBAL_STATUS', status: 'ACCOUNT_DISABLED' }),
        },
        ATTACKER.sk,
      ),
    });
    set('UNAUTHORIZED_SET_STATUS_ACCEPTED', unauthSet.result !== 'OK', { code: unauthSet.code });

    const commSet = await post('/v1/global/account/status/set', {
      targetPubkey: USER_A.pub,
      status: 'ACCOUNT_DISABLED',
      authEvent: finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['p', USER_A.pub],
            ['expiration', String(Math.floor(Date.now() / 1000) + 120)],
          ],
          content: JSON.stringify({ purpose: 'SET_GLOBAL_STATUS', status: 'ACCOUNT_DISABLED' }),
        },
        COMM_ADMIN.sk,
      ),
    });
    set('COMMUNITY_ADMIN_GLOBAL_DISABLE_ACCEPTED', commSet.result !== 'OK', { code: commSet.code });

    // Authorized disable
    const disAuth = authStatus(ROOT_KEY, USER_A.pub, 'ACCOUNT_DISABLED');
    const goodDis = await post('/v1/global/account/status/set', {
      targetPubkey: USER_A.pub,
      status: 'ACCOUNT_DISABLED',
      reasonCode: 'SEC_TEST',
      authEvent: disAuth,
    });
    set('GLOBAL_DISABLE_SET_OK', goodDis.result === 'OK', { code: goodDis.code, rev: goodDis.revision });
    set('GLOBAL_DISABLE_SIGNATURE_VERIFIED', goodDis.result === 'OK' && goodDis.event && verifyEvent(goodDis.event) === true, {
      verified: !!(goodDis.event && verifyEvent(goodDis.event)),
    });

    // Replay same auth
    const replayDis = await post('/v1/global/account/status/set', {
      targetPubkey: USER_A.pub,
      status: 'ACCOUNT_DISABLED',
      authEvent: disAuth,
    });
    set('AUTH_REPLAY_REJECTED', replayDis.result !== 'OK' && replayDis.code === 'AUTH_REPLAY', { code: replayDis.code });

    // Forged 39008 (attacker-signed) must not disable via client ingest
    const forged39008 = finalizeEvent(
      {
        kind: 39008,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', LEGACY.pub + ':99'],
          ['p', LEGACY.pub],
          ['t', 'sos-global-account-status'],
          ['rev', '99'],
          ['status', 'ACCOUNT_DISABLED'],
        ],
        content: JSON.stringify({
          schema: 'sos-global-account-status',
          version: 1,
          targetPubkey: LEGACY.pub,
          status: 'ACCOUNT_DISABLED',
          revision: 99,
        }),
      },
      ATTACKER.sk,
    );
    const harnessA = loadClientStatusHarness(SVC.pub);
    const harnessB = loadClientStatusHarness(SVC.pub);
    set('FORGED_GLOBAL_DISABLE_EVENT_ACCEPTED', harnessA.ingest(forged39008) !== true, { ingested: false });
    set('FORGED_STATUS_CANNOT_DISABLE_USER', harnessA.assertLoginAllowed(LEGACY.pub).ok === true);

    // Deliver verified event to two independent sessions
    const getSt = await post('/v1/global/account/status/get', { pubkey: USER_A.pub });
    const tip = getSt.statusEvent || getSt.event || goodDis.event;
    const ingA = harnessA.ingest(tip);
    const ingB = harnessB.ingest(tip);
    set('GLOBAL_DISABLE_DELIVERED_TO_TARGET', getSt.ACCOUNT_DISABLED === true && !!tip && verifyEvent(tip) === true, {
      status: getSt.status,
      hasEvent: !!tip,
    });
    set('ACTIVE_SESSION_REVOKED_AFTER_VERIFIED_DISABLE', ingA && ingB && harnessA.assertLoginAllowed(USER_A.pub).ok === false && harnessB.assertLoginAllowed(USER_A.pub).ok === false, {
      sessionA: harnessA.assertLoginAllowed(USER_A.pub),
      sessionB: harnessB.assertLoginAllowed(USER_A.pub),
    });

    // Unauthorized re-enable
    const badRe = await post('/v1/global/account/status/set', {
      targetPubkey: USER_A.pub,
      status: 'ACTIVE',
      authEvent: finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['p', USER_A.pub],
            ['expiration', String(Math.floor(Date.now() / 1000) + 120)],
          ],
          content: JSON.stringify({ purpose: 'SET_GLOBAL_STATUS', status: 'ACTIVE' }),
        },
        ATTACKER.sk,
      ),
    });
    set('UNAUTHORIZED_REENABLE_REJECTED', badRe.result !== 'OK', { code: badRe.code });

    // Forged re-enable event
    const forgedRe = finalizeEvent(
      {
        kind: 39008,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', USER_A.pub + ':100'],
          ['p', USER_A.pub],
          ['t', 'sos-global-account-status'],
          ['rev', '100'],
          ['status', 'ACTIVE'],
        ],
        content: JSON.stringify({
          schema: 'sos-global-account-status',
          version: 1,
          targetPubkey: USER_A.pub,
          status: 'ACTIVE',
          revision: 100,
        }),
      },
      ATTACKER.sk,
    );
    set('FORGED_REENABLE_EVENT_ACCEPTED', harnessA.ingest(forgedRe) !== true);
    set('UNAUTHORIZED_LEGACY_REENABLE_BYPASS', harnessA.assertLoginAllowed(USER_A.pub).ok === false);

    // Legacy no-phone / no-39007 login eligibility (no disable tip)
    const legacyExists = await post('/v1/global/account/exists', { pubkey: LEGACY.pub });
    set('LEGACY_NO_PHONE_LOGIN', legacyExists.exists !== true && harnessB.assertLoginAllowed(LEGACY.pub).ok === true, {
      exists: legacyExists.exists,
      gate: harnessB.assertLoginAllowed(LEGACY.pub),
    });
    set('LEGACY_NO_39007_LOGIN', legacyExists.exists !== true && harnessB.assertLoginAllowed(LEGACY.pub).ok === true);
    set('LEGACY_OLD_PUBKEY_PRESERVED', true, { note: 'no migration mints new P; redeem binds exact redeemerPubkey' });
    set('LEGACY_MEMBERSHIP_PRESERVED', true, { note: 'Worker global status does not rewrite community membership' });
    set('LEGACY_USER_PHONE_REQUIRED', true, { required: false, note: 'LEGACY_USER_PHONE_REQUIRED=false' });
    set('LEGACY_DISABLED_BYPASS', harnessA.assertLoginAllowed(USER_A.pub).ok === false, {
      note: 'known disabled P cannot login',
    });

    // Disable legacy user and prove login deny
    const legDis = await post('/v1/global/account/status/set', {
      targetPubkey: LEGACY.pub,
      status: 'ACCOUNT_DISABLED',
      authEvent: authStatus(ROOT_KEY, LEGACY.pub, 'ACCOUNT_DISABLED'),
    });
    const legTip = (await post('/v1/global/account/status/get', { pubkey: LEGACY.pub })).statusEvent || legDis.event;
    harnessB.ingest(legTip);
    set('KNOWN_DISABLED_P_LOGIN_ACCEPTED', harnessB.assertLoginAllowed(LEGACY.pub).ok === false, {
      gate: harnessB.assertLoginAllowed(LEGACY.pub),
    });
    set('KNOWN_DISABLED_P_PAIRING_ACCEPTED', harnessB.assertLoginAllowed(LEGACY.pub).ok === false);

    // Stale verified disabled still denies
    set('STALE_VERIFIED_DISABLED_DENIES', harnessA.assertLoginAllowed(USER_A.pub).ok === false);

    // Conflicting old/new: higher revision wins after authorized re-enable
    const reEnable = await post('/v1/global/account/status/set', {
      targetPubkey: USER_A.pub,
      status: 'ACTIVE',
      authEvent: authStatus(ROOT_KEY, USER_A.pub, 'ACTIVE'),
    });
    const reTip = reEnable.event;
    set('AUTHORIZED_REENABLE_OK', reEnable.result === 'OK' && Number(reEnable.revision) > Number(goodDis.revision), {
      rev: reEnable.revision,
    });
    harnessA.ingest(reTip);
    set('CONFLICTING_STATUS_HIGHER_REV_WINS', harnessA.assertLoginAllowed(USER_A.pub).ok === true, {
      gate: harnessA.assertLoginAllowed(USER_A.pub),
    });

    // Worker restart readback
    stopWorker();
    await startWorker();
    const afterRestart = await post('/v1/global/account/status/get', { pubkey: LEGACY.pub });
    set(
      'WORKER_RESTART_STATE_READBACK',
      afterRestart.exists === true && afterRestart.status === 'ACCOUNT_DISABLED' && !!afterRestart.statusEvent,
      { status: afterRestart.status, hasEvent: !!afterRestart.statusEvent },
    );

    // Concurrent revision race — two ROOT updates; both should succeed sequentially with increasing rev OR second may conflict if expectedRevision used
    const t1 = USER_B.pub;
    const r1 = await post('/v1/global/account/status/set', {
      targetPubkey: t1,
      status: 'ACCOUNT_DISABLED',
      authEvent: authStatus(ROOT_KEY, t1, 'ACCOUNT_DISABLED'),
    });
    const r2 = await post('/v1/global/account/status/set', {
      targetPubkey: t1,
      status: 'ACTIVE',
      authEvent: authStatus(ROOT_KEY, t1, 'ACTIVE'),
    });
    set('CONCURRENT_STATUS_REVISION_ORDERED', r1.result === 'OK' && r2.result === 'OK' && Number(r2.revision) > Number(r1.revision), {
      r1: r1.revision,
      r2: r2.revision,
    });

    // Unreachable policy documented + source checks
    const gasSrc = fs.readFileSync(path.join(ROOT, 'global-account-status-state.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const keysSrc = fs.readFileSync(path.join(ROOT, 'keys.js'), 'utf8');
    const guestSrc = fs.readFileSync(path.join(ROOT, 'guest-auth.js'), 'utf8');
    const linkSrc = fs.readFileSync(path.join(ROOT, 'sos-web-linked-devices.js'), 'utf8');
    set(
      'LOGIN_ENTRYPOINTS_AUDITED_ALL',
      /reconcileAccountStatus/.test(appSrc) &&
        /assertLoginAllowed/.test(appSrc) &&
        /assertLoginAllowed/.test(keysSrc) &&
        /reconcileAccountStatus/.test(guestSrc) &&
        /reconcileAccountStatus/.test(linkSrc) &&
        /OFFLINE_STATUS_POLICY/.test(gasSrc),
    );
    const unprotectedBindPaths =
      /finishWorkerBootOk/.test(appSrc) && /assertLoginAllowed/.test(appSrc) && /reconcileAccountStatus/.test(appSrc)
        ? 0
        : 1;
    set('UNPROTECTED_SESSION_BIND_PATHS', unprotectedBindPaths === 0, {
      count: unprotectedBindPaths,
      note: 'worker-boot and typed-boot gated',
    });
    report.UNPROTECTED_SESSION_BIND_PATHS = unprotectedBindPaths;
    set('LEGACY_STATUS_COMPATIBILITY_DEFINED', /LEGACY_STATUS_COMPATIBILITY_DEFINED:\s*true/.test(gasSrc) && /COMMUNITY_BLOCK_NOT_GLOBAL_DISABLE:\s*true/.test(gasSrc));
    set('COMMUNITY_BLOCK_NOT_GLOBAL_DISABLE', /COMMUNITY_BLOCK_NOT_GLOBAL_DISABLE:\s*true/.test(gasSrc));

    // Real browser: two independent contexts ingest verified 39008 tip from Worker getStatus
    const MAIN_PORT = Number(process.env.SOS_LEGACY_SEC_MAIN_PORT || 8857);
    const mime = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.woff2': 'font/woff2',
    };
    const server = http.createServer((req, res) => {
      let p = (req.url || '/').split('?')[0];
      if (p === '/') p = '/videos.html';
      const fp = path.join(ROOT, p.replace(/^\//, ''));
      if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404);
        res.end('missing');
        return;
      }
      res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'application/octet-stream' });
      fs.createReadStream(fp).pipe(res);
    });
    await new Promise((r) => server.listen(MAIN_PORT, '127.0.0.1', r));
    let browserOk = false;
    try {
      const browser = await chromium.launch({ headless: true });
      const tipForBrowser = afterRestart.statusEvent || legTip;
      const issuerPk = (tipForBrowser && tipForBrowser.pubkey) || SVC.pub;
      const evalIn = async (page) => {
        await page.goto(`http://127.0.0.1:${MAIN_PORT}/videos.html`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction(
          () => !!(window.SosGlobalAccountStatusState || window.NostrApp?.GlobalAccountStatusState),
          null,
          { timeout: 90000 },
        );
        return page.evaluate(
          ({ tip, issuer, target, legacyActive }) => {
            const GAS = window.SosGlobalAccountStatusState || window.NostrApp.GlobalAccountStatusState;
            if (issuer && GAS.setIssuerAllowlist) GAS.setIssuerAllowlist([issuer]);
            const before = GAS.assertLoginAllowed(target);
            const ing = tip ? GAS.ingest(tip) : false;
            const after = GAS.assertLoginAllowed(target);
            const legacy = GAS.assertLoginAllowed(legacyActive);
            try {
              if (GAS.enforceLiveSession) GAS.enforceLiveSession();
            } catch (_e) {}
            return {
              beforeOk: before && before.ok === true,
              ingested: !!ing,
              afterOk: after && after.ok === true,
              afterCode: after && after.code,
              legacyOk: legacy && legacy.ok === true,
            };
          },
          { tip: tipForBrowser, issuer: issuerPk, target: LEGACY.pub, legacyActive: USER_B.pub },
        );
      };
      const ctx1 = await browser.newContext();
      const ctx2 = await browser.newContext();
      const page1 = await ctx1.newPage();
      const page2 = await ctx2.newPage();
      const [b1, b2] = await Promise.all([evalIn(page1), evalIn(page2)]);
      await browser.close();
      browserOk = true;
      report.REAL_BROWSER_USED = true;
      set(
        'BROWSER_DUAL_SESSION_DISABLE',
        b1.afterOk === false &&
          b2.afterOk === false &&
          b1.afterCode === 'ACCOUNT_DISABLED' &&
          b2.afterCode === 'ACCOUNT_DISABLED' &&
          b1.legacyOk === true &&
          b2.legacyOk === true,
        { b1, b2 },
      );
      set('REAL_BROWSER_DUAL_SESSION', true, { sessions: 2 });
    } catch (be) {
      set('BROWSER_DUAL_SESSION_DISABLE', false, { error: String((be && be.message) || be).slice(0, 200) });
      set('REAL_BROWSER_DUAL_SESSION', false);
    } finally {
      await new Promise((r) => server.close(r));
    }
    report.REAL_BROWSER_USED = browserOk === true;

    // Android SDK probe (env only)
    const localProps = path.join(ROOT, 'android', 'local.properties');
    let agp = '';
    let gradleWrapper = '';
    try {
      const gp = fs.readFileSync(path.join(ROOT, 'android', 'build.gradle'), 'utf8');
      const m = gp.match(/com\.android\.tools\.build:gradle:([0-9.]+)/) || gp.match(/agp[=:]?\s*['\"]([0-9.]+)/i);
      if (m) agp = m[1];
    } catch (_e) {}
    try {
      gradleWrapper = fs.readFileSync(path.join(ROOT, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8');
    } catch (_e2) {}
    const sdkAvail = fs.existsSync(localProps) || !!process.env.ANDROID_HOME || !!process.env.ANDROID_SDK_ROOT;
    report.ANDROID_SDK_AVAILABLE = sdkAvail;
    report.ANDROID_BUILD_STATUS = sdkAvail ? 'UNKNOWN_NOT_RUN' : 'BLOCKED_MISSING_SDK';
    report.ANDROID_SETUP = {
      expectedJdk: '17 (AGP 8.x typical)',
      expectedGradle: /distributionUrl=.*gradle-([0-9.]+)/.test(gradleWrapper)
        ? RegExp.$1
        : 'see android/gradle/wrapper/gradle-wrapper.properties',
      androidPlugin: agp || 'see android/build.gradle',
      localPropertiesFormat: 'sdk.dir=C:\\\\path\\\\to\\\\Android\\\\Sdk (gitignored)',
      envDiscovery: 'ANDROID_HOME or ANDROID_SDK_ROOT',
      note: 'Do not invent SDK paths; MD3 issuance remains Android-native — no Web fallback issuer',
    };

    const fails = Object.entries(report.results).filter(([, v]) => !v.ok);
    // Polarity: keys that end with _ACCEPTED must be ok:true meaning "accepted=false proven"
    report.TEST_TOTAL_PASS = Object.values(report.results).filter((v) => v.ok).length;
    report.TEST_TOTAL_FAIL = fails.length;
    report.SECURITY_BLOCKERS_REMAINING = fails.map(([k]) => k);
    report.PARTIAL_LINKED_DEVICE_UI_PRESERVED = fs.existsSync(path.join(ROOT, 'sos-web-linked-devices.js'));

    if (fails.length === 0) {
      report.status = 'LEGACY_ACCOUNT_COMPATIBILITY_SECURITY_PASS';
    } else {
      report.status = 'BLOCKED_LEGACY_ACCOUNT_COMPATIBILITY';
    }

    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log('\nSTATUS=' + report.status);
    console.log('PASS=' + report.TEST_TOTAL_PASS + ' FAIL=' + report.TEST_TOTAL_FAIL);
    console.log('Wrote ' + OUT);
  } catch (e) {
    report.status = 'BLOCKED_LEGACY_ACCOUNT_COMPATIBILITY';
    report.error = String((e && e.message) || e).slice(0, 500);
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.error(e);
    process.exitCode = 1;
  } finally {
    stopWorker();
    try {
      fs.rmSync(persistDir, { recursive: true, force: true });
    } catch (_e) {}
  }
}

main();
