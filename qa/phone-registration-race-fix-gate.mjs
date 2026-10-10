#!/usr/bin/env node
/**
 * GLOBAL PHONE REGISTRATION RACE FIX — real Worker/DO concurrency + retry gates.
 * Disposable PHONE_PEPPER. Never logs phone plaintext, phoneToken, or private keys.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADM_DIR = path.join(ROOT, 'admission-service');
const OUT = path.join(ROOT, 'qa', 'phone-registration-race-fix-report.json');
const ADM_PORT = Number(process.env.SOS_RACE_ADM_PORT || 8841);
const ADM_URL = `http://127.0.0.1:${ADM_PORT}`;
const persistDir = path.join(os.tmpdir(), 'sos-phone-race-' + Date.now());

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

const report = {
  gate: 'PHONE_REGISTRATION_RACE_FIX',
  status: 'FAIL',
  REAL_WORKER_USED: true,
  REAL_DURABLE_OBJECT_USED: true,
  ts: new Date().toISOString(),
  results: {},
  inviteStateMachine: {
    UNUSED: ['USED', 'PHONE_CONFLICT'],
    USED: ['USED (idempotent same redeemer)'],
    PHONE_CONFLICT: ['terminal'],
    CLAIMED_legacy: 'treated as USED for winner idempotency',
  },
  transactionBoundary:
    'computePhoneToken+codeHash outside; claim uniqueness + phone_bindings ACTIVE insert inside one storage.transactionSync; cert 39007 after txn idempotent; First Group membership outside this DO',
};
const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 240));
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
    ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(ADM_PORT), '--persist-to', persistDir, '--show-interactive-dev-session=false'],
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
  try {
    fs.rmSync(persistDir, { recursive: true, force: true });
  } catch (_e) {}
}

async function post(p, body) {
  const r = await fetch(ADM_URL + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  j.__http = r.status;
  return j;
}

function authLookup(key) {
  const now = Math.floor(Date.now() / 1000);
  return finalizeEvent(
    { kind: 22242, created_at: now, tags: [['expiration', String(now + 120)]], content: 'sos-phone-lookup' },
    key.sk,
  );
}

function makeInviteEvent(creator, code) {
  const now = Math.floor(Date.now() / 1000);
  const ih = crypto.createHash('sha256').update(code).digest('hex');
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

async function registerInvite(phone, code) {
  const inv = makeInviteEvent(ROOT_KEY, code);
  const reg = await post('/v1/global/invites/new-account/register', {
    invite: inv,
    purpose: 'NEW_ACCOUNT_INVITE',
    recipientPhone: phone,
  });
  return { inv, code, reg };
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

async function redeem(inv, code, phone, key) {
  const pubkey = typeof key === 'string' ? key : key.pub;
  const skKey = typeof key === 'string' ? null : key;
  const body = {
    inviteId: inv.id,
    code,
    phone,
    redeemerPubkey: pubkey,
  };
  if (skKey) body.redeemerAuthEvent = redeemerAuth(skKey, inv.id);
  return post('/v1/global/invites/new-account/redeem', body);
}

async function status(inviteId) {
  return post('/v1/global/invites/new-account/status', { inviteId });
}

async function raceN(n, phonePrefix) {
  const phone = phonePrefix;
  const invites = [];
  for (let i = 0; i < n; i++) {
    const code = ('R' + n + i + crypto.randomBytes(3).toString('hex')).toUpperCase().slice(0, 12);
    const { inv, reg } = await registerInvite(phone, code);
    if (reg.result !== 'OK' && !reg.already) throw new Error('register failed ' + (reg.code || ''));
    invites.push({ inv, code, key: mkKey() });
  }
  // Shuffle start order slightly
  const order = invites.slice().sort(() => Math.random() - 0.5);
  const results = await Promise.all(order.map((x) => redeem(x.inv, x.code, phone, x.key)));
  const winners = results.filter((r) => r.result === 'OK');
  const look = await post('/v1/global/phone/lookup', { phone, authEvent: authLookup(ROOT_KEY) });
  const states = [];
  for (const x of invites) {
    const st = await status(x.inv.id);
    states.push(st.state);
  }
  const orphanClaimed = states.filter((s) => s === 'CLAIMED').length;
  const used = states.filter((s) => s === 'USED' || s === 'CLAIMED').length;
  const conflicts = states.filter((s) => s === 'PHONE_CONFLICT').length;
  const existsChecks = [];
  for (const x of invites) {
    const ex = await post('/v1/global/account/exists', { pubkey: x.key.pub });
    existsChecks.push(!!ex.exists);
  }
  const accountCount = existsChecks.filter(Boolean).length;
  return {
    n,
    winners: winners.length,
    registered: look.registered === true,
    orphanClaimed,
    used,
    conflicts,
    accountCount,
    states,
    loserCodes: results.filter((r) => r.result !== 'OK').map((r) => r.code),
  };
}

async function main() {
  try {
    await startWorker();
    set('REAL_WORKER_HEALTH', true, { url: ADM_URL });

    // --- 2-way race (original defect)
    const phone2 = '+972504001001';
    const a = await registerInvite(phone2, 'AA' + crypto.randomBytes(4).toString('hex').toUpperCase());
    const b = await registerInvite(phone2, 'BB' + crypto.randomBytes(4).toString('hex').toUpperCase());
    const ka = mkKey();
    const kb = mkKey();
    const [ra, rb] = await Promise.all([
      redeem(a.inv, a.code, phone2, ka),
      redeem(b.inv, b.code, phone2, kb),
    ]);
    const stA = await status(a.inv.id);
    const stB = await status(b.inv.id);
    const look2 = await post('/v1/global/phone/lookup', { phone: phone2, authEvent: authLookup(ROOT_KEY) });
    const winners2 = [ra, rb].filter((r) => r.result === 'OK');
    const loser = [ra, rb].find((r) => r.result !== 'OK');
    const loserSt = loser === ra ? stA : stB;
    const winnerSt = loser === ra ? stB : stA;
    set('TWO_WAY_ONE_WINNER', winners2.length === 1 && look2.registered === true, {
      winners: winners2.length,
      loserCode: loser && loser.code,
    });
    set(
      'ORPHAN_PHONE_RESERVATION',
      !(loserSt.state === 'CLAIMED' || (loserSt.state === 'USED' && String(loserSt.redeemerPubkey || '') !== String(look2.pubkey || ''))),
      { loserState: loserSt.state, winnerState: winnerSt.state },
    );
    // Required polarity helpers
    report.results.ORPHAN_PHONE_RESERVATION_FALSE = {
      ok: report.results.ORPHAN_PHONE_RESERVATION.ok,
      detail: { ORPHAN_PHONE_RESERVATION: !report.results.ORPHAN_PHONE_RESERVATION.ok ? true : false },
    };
    set(
      'INVITE_CLAIM_CONFLICT_CLEANED',
      loserSt.state === 'PHONE_CONFLICT' && (winnerSt.state === 'USED' || winnerSt.state === 'CLAIMED'),
      { loser: loserSt.state, winner: winnerSt.state },
    );
    set('FAILED_REDEEM_INVITE_PERMANENTLY_CLAIMED', loserSt.state !== 'CLAIMED' && loserSt.state !== 'USED', {
      state: loserSt.state,
    });
    const exA = await post('/v1/global/account/exists', { pubkey: ka.pub });
    const exB = await post('/v1/global/account/exists', { pubkey: kb.pub });
    set('FAILED_REDEEM_CREATES_ACCOUNT', [exA.exists, exB.exists].filter(Boolean).length === 1, {
      accounts: [!!exA.exists, !!exB.exists],
    });
    report.results.TWO_ACTIVE_ACCOUNTS_SAME_PHONE = {
      ok: winners2.length === 1 && look2.registered === true,
      detail: { winners: winners2.length, registered: look2.registered, note: 'ok means second active account rejected' },
    };
    console.log(report.results.TWO_ACTIVE_ACCOUNTS_SAME_PHONE.ok ? 'PASS' : 'FAIL', 'TWO_ACTIVE_ACCOUNTS_SAME_PHONE');

    // Winner binding unchanged after late loser retry
    const late = await redeem(loser === ra ? a.inv : b.inv, loser === ra ? a.code : b.code, phone2, loser === ra ? ka : kb);
    const lookLate = await post('/v1/global/phone/lookup', { phone: phone2, authEvent: authLookup(ROOT_KEY) });
    set(
      'LATE_LOSER_CANNOT_ROLLBACK_WINNER',
      late.result !== 'OK' && lookLate.pubkey === look2.pubkey,
      { lateCode: late.code },
    );
    set('PHONE_BINDING_CANNOT_BE_STOLEN', lookLate.pubkey === look2.pubkey);

    // Winner idempotent retry
    const winKey = winners2[0] === ra ? ka : kb;
    const winInv = winners2[0] === ra ? a : b;
    const retryWin = await redeem(winInv.inv, winInv.code, phone2, winKey);
    set('RETRY_IDEMPOTENT', retryWin.result === 'OK' && retryWin.already === true, { already: retryWin.already });

    // Same invite replay other pubkey
    const thief = mkKey();
    const replay = await redeem(winInv.inv, winInv.code, phone2, thief);
    report.results.INVITE_REPLAY_ACCEPTED = {
      ok: replay.result !== 'OK',
      detail: { code: replay.code },
    };
    console.log(report.results.INVITE_REPLAY_ACCEPTED.ok ? 'PASS' : 'FAIL', 'INVITE_REPLAY_ACCEPTED');

    // Stress 2/5/10/25
    const stress = {};
    for (const n of [2, 5, 10, 25]) {
      const phone = `+97250410${String(n).padStart(4, '0')}`;
      const r = await raceN(n, phone);
      stress[n] = r;
      set(
        `STRESS_N_${n}`,
        r.winners === 1 && r.orphanClaimed === 0 && r.accountCount === 1 && r.conflicts === n - 1,
        { winners: r.winners, orphanClaimed: r.orphanClaimed, accounts: r.accountCount, conflicts: r.conflicts },
      );
    }
    report.stress = stress;
    const orphanTotal = Object.values(stress).reduce((s, r) => s + r.orphanClaimed, 0);
    set('ORPHAN_CLAIM_COUNT', orphanTotal === 0, { orphanTotal });
    set('ACTIVE_PHONE_BINDINGS_PER_PHONE_MAX', Object.values(stress).every((r) => r.winners === 1 && r.registered), {
      maxObservedWinners: Math.max(...Object.values(stress).map((r) => r.winners)),
    });
    set('DUPLICATE_ACCOUNT_CERT_COUNT', Object.values(stress).every((r) => r.accountCount === 1), {
      maxAccounts: Math.max(...Object.values(stress).map((r) => r.accountCount)),
    });

    // Same invite duplicate concurrent redeems
    const phoneDup = '+972504200200';
    const dup = await registerInvite(phoneDup, 'DUP' + crypto.randomBytes(3).toString('hex').toUpperCase());
    const k1 = mkKey();
    const k2 = mkKey();
    const [d1, d2] = await Promise.all([
      redeem(dup.inv, dup.code, phoneDup, k1),
      redeem(dup.inv, dup.code, phoneDup, k2),
    ]);
    const dupWinners = [d1, d2].filter((r) => r.result === 'OK');
    const stDup = await status(dup.inv.id);
    set('SAME_INVITE_CONCURRENT_ONE_WINNER', dupWinners.length === 1 && (stDup.state === 'USED' || stDup.state === 'CLAIMED'), {
      winners: dupWinners.length,
      state: stDup.state,
    });

    // Multi-phone simultaneous
    const phones = ['+972504300301', '+972504300302', '+972504300303'];
    const multi = await Promise.all(
      phones.map(async (ph, i) => {
        const code = ('M' + i + crypto.randomBytes(3).toString('hex')).toUpperCase();
        const { inv } = await registerInvite(ph, code);
        const k = mkKey();
        const r = await redeem(inv, code, ph, k);
        return { r, k, ph };
      }),
    );
    set(
      'MULTI_PHONE_SIMULTANEOUS',
      multi.every((m) => m.r.result === 'OK'),
      { okCount: multi.filter((m) => m.r.result === 'OK').length },
    );

    const fails = Object.entries(report.results).filter(([, v]) => !v.ok).map(([k]) => k);
    report.status = fails.length === 0 ? 'PASS' : 'FAIL';
    report.fails = fails;
    report.pass = Object.keys(report.results).length - fails.length;
    report.fail = fails.length;
  } catch (e) {
    report.status = 'FAIL';
    report.error = String(e && e.message ? e.message : e).slice(0, 600);
    console.error('RACE_GATE_ERROR', report.error);
  } finally {
    stopWorker();
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  }
  console.log('\nPHONE_REGISTRATION_RACE_FIX', report.status, `(${report.pass || 0}/${(report.pass || 0) + (report.fail || 0)})`);
  process.exit(report.status === 'PASS' ? 0 : 1);
}

main();
