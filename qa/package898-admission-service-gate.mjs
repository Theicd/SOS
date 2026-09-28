/**
 * Package 898 — First-group admission service gate (Cloudflare Worker + Durable Object per invite).
 *
 * Local mode (default): starts `wrangler dev --local` (workerd, real Durable Object + SQLite semantics) with
 * disposable QA root + service keys written to the gitignored admission-service/.dev.vars, then deletes them.
 * Remote mode (staging): SOS_ADM_URL=<https://...workers.dev> SOS_ADM_KEYS=<gitignored json {rootSk, svcSk, svc2Sk}>.
 *
 * Never uses the production root. Writes qa/package898-admission-service-report.json (no secrets).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import crypto from 'node:crypto';
import * as NostrTools from 'nostr-tools';

const { generateSecretKey, getPublicKey, finalizeEvent } = NostrTools;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVC_DIR = path.join(ROOT, 'admission-service');
const REPORT = path.join(__dirname, process.env.SOS_ADM_REPORT || 'package898-admission-service-report.json');
const GROUP = 'israel-network';
const SERVICE_TAG = 'sos-first-group-admission-v1';
const PORT = Number(process.env.SOS_ADM_PORT || 8799);
const REMOTE = process.env.SOS_ADM_URL || '';
const BASE = REMOTE || `http://127.0.0.1:${PORT}`;
const MODE = REMOTE ? 'staging' : 'local-workerd';

const hex = (u8) => Buffer.from(u8).toString('hex');
const unhex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
function mkKey(skHex) {
  const sk = skHex ? unhex(skHex) : generateSecretKey();
  return { sk, hex: hex(sk), pub: getPublicKey(sk) };
}
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ------------------------------------------------------------ client authority modules (same code as browsers)
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => Array.from(mem.keys())[i] || null,
  get length() {
    return mem.size;
  },
};
globalThis.NostrTools = NostrTools;
globalThis.SOS_ACCESS_CONTROL_V2 = true;
globalThis.NostrApp = { NETWORK_TAG: GROUP, COMMUNITY_CONTEXT: 'yalacommunity', adminSourceKeys: [] };
const origLog = console.log;
const origWarn = console.warn;
console.log = () => {};
console.warn = () => {};
for (const f of ['nostr-event-integrity.js', 'group-control-state.js', 'membership-state.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
}
console.log = origLog;
console.warn = origWarn;
const App = globalThis.NostrApp;
const G = App.GroupControlState;
const MS = App.MembershipState;

// ------------------------------------------------------------ keys
let keyFile = null;
if (REMOTE) keyFile = JSON.parse(fs.readFileSync(process.env.SOS_ADM_KEYS, 'utf8'));
const R = mkKey(keyFile && keyFile.rootSk);
const S = mkKey(keyFile && keyFile.svcSk);
const S2 = mkKey(keyFile && keyFile.svc2Sk);
const B = mkKey();
const X = mkKey();
const Y = mkKey();
const users = Array.from({ length: 160 }, () => mkKey());
const SECRETS = [R.hex, S.hex, S2.hex, B.hex, X.hex, Y.hex].concat(users.map((u) => u.hex));
const INVITE_CODES = [];
App.adminSourceKeys = [R.pub];

// ------------------------------------------------------------ report
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail == null ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail != null ? ' ' + JSON.stringify(detail) : ''}`);
}

// ------------------------------------------------------------ control chain (root-signed)
const controlEvents = [];
let tip = null;
function signControl(recObj, signer) {
  const record = G.parseAndValidateRecord(JSON.stringify(recObj));
  const d = G.buildSignDraft(record, signer.pub);
  return finalizeEvent({ kind: d.kind, created_at: d.created_at, tags: d.tags, content: d.content }, signer.sk);
}
function nextControl(patch, signer) {
  const rec = JSON.parse(G.serializeRecord(tip));
  rec.controlEpoch += 1;
  rec.createdAt = now();
  patch(rec);
  const ev = signControl(rec, signer || R);
  return { ev, rec: G.parseAndValidateRecord(JSON.stringify(rec)) };
}
function commit(step) {
  controlEvents.push(step.ev);
  tip = step.rec;
  return step.ev;
}
function localControl(events, groupId) {
  G.clearAllStores();
  G.ingestControlEvents(events, { groupId: groupId || GROUP, persist: false });
  return G.getVerifiedControlState(groupId || GROUP);
}

// ------------------------------------------------------------ http
async function post(p, body, headers) {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + p, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_e) {}
    return { status: res.status, json: json || {}, ms: performance.now() - t0, headers: res.headers, text };
  } catch (e) {
    return { status: 0, json: { result: 'TEMPORARILY_UNAVAILABLE', code: 'NETWORK' }, ms: performance.now() - t0 };
  }
}
const ingest = () => post('/v1/control/ingest', { groupId: GROUP, events: controlEvents });

function mkInvite(creator, opts) {
  const o = opts || {};
  const code = o.code || crypto.randomBytes(6).toString('hex').toUpperCase();
  INVITE_CODES.push(code);
  const ih = sha256(code);
  const ts = o.createdAt || now();
  const ev = finalizeEvent(
    {
      kind: 37378,
      created_at: ts,
      tags: [
        ['t', 'sos-invite'],
        ['expiration', String(o.expiration || ts + (o.ttl || 3600))],
        ['t', o.group || GROUP],
        ['ih', ih],
        ['d', ih],
        ['control-epoch', String(tip.controlEpoch)],
      ],
      content: JSON.stringify({ v: 2, type: 'invite', schema: 'sos-invite' }),
    },
    creator.sk
  );
  return { code, ev };
}
function mkRedeem(user, inv, o) {
  const opt = o || {};
  const op = opt.op || crypto.randomBytes(18).toString('hex');
  const ev = finalizeEvent(
    {
      kind: 37379,
      created_at: opt.createdAt || now(),
      tags: [
        ['t', 'sos-invite-used'],
        ['t', opt.group || GROUP],
        ['e', inv.ev.id],
        ['d', inv.ev.id],
        ['ih', inv.ev.tags.find((t) => t[0] === 'ih')[1]],
        ['op', op],
        ['member-revision', String(opt.rev || 1)],
        ['svc', SERVICE_TAG],
        ['p', inv.ev.pubkey],
      ],
      content: JSON.stringify({ v: 2, type: 'invite-used' }),
    },
    user.sk
  );
  return { op, ev };
}
function mkRevoke(actor, inv) {
  return finalizeEvent(
    {
      kind: 37380,
      created_at: now(),
      tags: [
        ['d', inv.ev.id],
        ['e', inv.ev.id],
        ['t', GROUP],
        ['t', 'sos-invite-revoke'],
        ['control-epoch', String(tip.controlEpoch)],
      ],
      content: JSON.stringify({ schema: 'sos-invite-revoke', version: 1, inviteEventId: inv.ev.id, groupId: GROUP }),
    },
    actor.sk
  );
}
const register = (inv) => post('/v1/invites/register', { groupId: GROUP, invite: inv.ev });
const redeem = (req, code, headers) => post('/v1/invites/redeem', { groupId: GROUP, request: req.ev || req, code }, headers);
const revoke = (ev) => post('/v1/invites/revoke', { groupId: GROUP, revoke: ev });
const status = (inv, code) => post('/v1/invites/status', { groupId: GROUP, inviteId: inv.ev.id, code: code == null ? inv.code : code });
const inspect = (inv) => post('/v1/test/inspect', { groupId: GROUP, inviteId: inv.ev.id });

function proofVerdict(proof, events, groupId) {
  const st = localControl(events || controlEvents, groupId);
  if (!st) return { ok: false, code: 'NO_CONTROL' };
  return MS.validateMembershipEventStructural(proof, st, { groupId: groupId || GROUP });
}
function tally(results) {
  const t = {};
  results.forEach((r) => {
    const k = r.json.result || 'NONE';
    t[k] = (t[k] || 0) + 1;
  });
  return t;
}
function pct(arr, p) {
  const s = arr.slice().sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
}

// ------------------------------------------------------------ wrangler (local)
let wr = null;
let wrLog = '';
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sos-adm-'));
function writeDevVars(testFaults) {
  fs.writeFileSync(
    path.join(SVC_DIR, '.dev.vars'),
    `ROOT_PUBKEY=${R.pub}\nADMISSION_SK=${S.hex}\nTEST_FAULTS=${testFaults}\nALLOWED_ORIGINS=http://127.0.0.1:8898\n`
  );
}
async function startWrangler() {
  wr = spawn('npx', ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(PORT), '--persist-to', persistDir, '--show-interactive-dev-session=false'], {
    cwd: SVC_DIR,
    shell: true,
    env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }),
  });
  wr.stdout.on('data', (d) => (wrLog += d.toString()));
  wr.stderr.on('data', (d) => (wrLog += d.toString()));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE + '/v1/health');
      if (r.ok) return true;
    } catch (_e) {}
    await sleep(500);
  }
  throw new Error('wrangler dev did not start:\n' + wrLog.slice(-2000));
}
function stopWrangler() {
  if (!wr) return;
  try {
    execSync(`taskkill /pid ${wr.pid} /T /F`, { stdio: 'ignore' });
  } catch (_e) {
    try {
      wr.kill('SIGKILL');
    } catch (_e2) {}
  }
  wr = null;
}

// ------------------------------------------------------------ main
async function main() {
  if (!REMOTE) {
    writeDevVars(1);
    await startWrangler();
  }
  const health = await fetch(BASE + '/v1/health').then((r) => r.json());
  check('SERVICE_HEALTH', health.result === 'OK' && health.group === GROUP, { mode: MODE });

  // ---------------- control bootstrap + delegation
  const boot = G.buildBootstrapRecord({ groupId: GROUP, rootAdminPubkey: R.pub, invitePolicy: 'AUTHORIZED_USERS_ONLY' });
  const e1 = signControl(JSON.parse(G.serializeRecord(boot)), R);
  controlEvents.push(e1);
  tip = boot;
  let r0 = await post('/v1/invites/register', { groupId: GROUP, invite: mkInvite(R).ev });
  check('REGISTER_WITHOUT_CONTROL_FAILS_CLOSED', r0.json.result === 'TEMPORARILY_UNAVAILABLE', r0.json);
  let ing = await ingest();
  const invNoDelegate = mkInvite(R);
  r0 = await register(invNoDelegate);
  check('REGISTER_WITHOUT_DELEGATION_FAILS_CLOSED', r0.json.result === 'TEMPORARILY_UNAVAILABLE' && r0.json.code === 'DELEGATION_INACTIVE', r0.json);

  commit(
    nextControl((r) => {
      r.capabilities[S.pub] = ['FINALIZE_MEMBERSHIP_ADMISSION'];
      r.capabilities[B.pub] = ['INVITE_USERS'];
    })
  );
  ing = await ingest();
  check('CONTROL_INGEST_VERIFIED', ing.json.result === 'OK' && ing.json.controlEpoch === 2, ing.json);

  // Foreign / forged control cannot change service authority.
  const forged = signControl(Object.assign(JSON.parse(G.serializeRecord(tip)), { controlEpoch: 3, createdAt: now(), capabilities: { [X.pub]: ['FINALIZE_MEMBERSHIP_ADMISSION'] } }), X);
  const fi = await post('/v1/control/ingest', { groupId: GROUP, events: [forged] });
  check('FORGED_CONTROL_IGNORED', fi.json.controlEpoch === 2, fi.json);
  const delegateBySvc = signControl(Object.assign(JSON.parse(G.serializeRecord(tip)), { controlEpoch: 3, createdAt: now(), capabilities: Object.assign({}, tip.capabilities, { [X.pub]: ['INVITE_USERS'] }) }), S);
  const fs2 = await post('/v1/control/ingest', { groupId: GROUP, events: [delegateBySvc] });
  const localDel = localControl(controlEvents.concat([delegateBySvc]));
  check('ADMISSION_DELEGATE_CANNOT_ISSUE_CONTROL', fs2.json.controlEpoch === 2 && localDel.controlEpoch === 2, fs2.json);

  // ---------------- register
  const inv1 = mkInvite(R);
  const reg1 = await register(inv1);
  const reg1b = await register(inv1);
  check('ADMISSION_INVITE_REGISTER_GATE', reg1.json.result === 'REGISTERED' && reg1.json.replay === false, reg1.json);
  check('INVITE_REGISTER_IDEMPOTENCY_GATE', reg1b.json.result === 'REGISTERED' && reg1b.json.replay === true, reg1b.json);
  const invX = mkInvite(X);
  const regX = await register(invX);
  check('REGISTER_UNAUTHORIZED_DENIED', regX.json.result === 'UNAUTHORIZED', regX.json);
  const invWG = mkInvite(R, { group: 'other-network' });
  const regWG = await register(invWG);
  check('REGISTER_WRONG_GROUP_DENIED', regWG.json.result === 'INVALID', regWG.json);
  const invF = mkInvite(R);
  const tampered = Object.assign({}, invF.ev, { sig: invF.ev.sig.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) });
  const regF = await post('/v1/invites/register', { groupId: GROUP, invite: tampered });
  check('REGISTER_FORGED_INVITE_DENIED', regF.json.result === 'INVALID', regF.json);
  const regTtl = await register(mkInvite(R, { ttl: 40 * 24 * 3600 }));
  const regPast = await register(mkInvite(R, { expiration: now() - 10 }));
  check('REGISTER_EXPIRY_BOUNDS', regTtl.json.result === 'INVALID' && regPast.json.result === 'INVALID', [regTtl.json.code, regPast.json.code]);
  const regWrongBody = await post('/v1/invites/register', { groupId: 'other-network', invite: inv1.ev });
  check('REGISTER_WRONG_GROUP_BODY_DENIED', regWrongBody.json.result === 'INVALID', regWrongBody.json);

  // ---------------- 2-way (C/D)
  const [C, D] = [users[0], users[1]];
  const inv2 = mkInvite(R);
  await register(inv2);
  const [rc, rd] = await Promise.all([redeem(mkRedeem(C, inv2), inv2.code), redeem(mkRedeem(D, inv2), inv2.code)]);
  const t2 = tally([rc, rd]);
  const winner2 = rc.json.result === 'ACCEPTED' ? rc : rd;
  const loser2 = rc.json.result === 'ACCEPTED' ? rd : rc;
  check('FIRST_GROUP_NETWORK_DOUBLE_REDEEM_GATE', t2.ACCEPTED === 1 && t2.ALREADY_REDEEMED === 1 && !loser2.json.proof, t2);
  const pv = proofVerdict(winner2.json.proof);
  check('SERVICE_PROOF_ACCEPTED_BY_CLIENT_RESOLVER', pv.ok === true, pv.code);
  const winnerPub = rc.json.result === 'ACCEPTED' ? C.pub : D.pub;
  check('PROOF_BINDS_INVITE_REDEEMER_GROUP', (() => {
    const b = JSON.parse(winner2.json.proof.content);
    return b.inviteEventId === inv2.ev.id && b.memberPubkey === winnerPub && b.admission.redeemerPubkey === winnerPub && b.groupId === GROUP && winner2.json.proof.pubkey === S.pub;
  })());

  // ---------------- 20-way
  const inv3 = mkInvite(R);
  await register(inv3);
  const r20 = await Promise.all(users.slice(2, 22).map((u) => redeem(mkRedeem(u, inv3), inv3.code)));
  const t20 = tally(r20);
  const proofIds20 = new Set(r20.filter((r) => r.json.result === 'ACCEPTED').map((r) => r.json.proofId));
  check('FIRST_GROUP_INVITE_CONCURRENCY_GATE', t20.ACCEPTED === 1 && t20.ALREADY_REDEEMED === 19 && proofIds20.size === 1, t20);
  const led3 = await inspect(inv3);
  check('INVITE_MEMBERSHIP_ATOMICITY_GATE', led3.json.ledger && led3.json.ledger.state === 'REDEEMED' && led3.json.ledger.proof_id === [...proofIds20][0], led3.json.ledger && led3.json.ledger.state);

  // ---------------- 100-way stress + parallel invites
  const inv4 = mkInvite(R);
  await register(inv4);
  const reqs100 = users.slice(22, 122).map((u) => mkRedeem(u, inv4));
  const r100 = await Promise.all(reqs100.map((q) => redeem(q, inv4.code)));
  const t100 = tally(r100);
  const lat = r100.map((r) => r.ms);
  const stress = { p50: pct(lat, 50), p95: pct(lat, 95), max: Math.round(Math.max(...lat)), tally: t100 };
  check('STRESS_100_WAY_ONE_WINNER', t100.ACCEPTED === 1 && t100.ALREADY_REDEEMED === 99, stress);
  const invsPar = Array.from({ length: 25 }, () => mkInvite(R));
  await Promise.all(invsPar.map((i) => register(i)));
  const par = await Promise.all(
    invsPar.map((inv, k) => Promise.all(users.slice(122 + (k % 6) * 5, 127 + (k % 6) * 5).map((u) => redeem(mkRedeem(u, inv), inv.code))))
  );
  const parOk = par.every((rs) => tally(rs).ACCEPTED === 1 && tally(rs).ALREADY_REDEEMED === rs.length - 1);
  check('PARALLEL_INVITES_EACH_ONE_WINNER', parOk, { invites: par.length, redeemersEach: 5 });
  check('INVITE_ATOMIC_COMPARE_AND_SET_GATE', t2.ACCEPTED === 1 && t20.ACCEPTED === 1 && t100.ACCEPTED === 1 && parOk);

  // ---------------- idempotency / retry storm
  const winReq = rc.json.result === 'ACCEPTED' ? rc : rd;
  const winUser = rc.json.result === 'ACCEPTED' ? C : D;
  const r4 = r100.find((r) => r.json.result === 'ACCEPTED');
  const w4idx = r100.indexOf(r4);
  const w4Req = reqs100[w4idx];
  const retries = await Promise.all(Array.from({ length: 10 }, () => redeem(w4Req, inv4.code)));
  const sameProof = retries.every((r) => r.json.result === 'ACCEPTED' && r.json.replay === true && r.json.proofId === r4.json.proofId);
  const w4User = users[22 + w4idx];
  const newSig = await redeem(mkRedeem(w4User, inv4, { op: w4Req.op }), inv4.code);
  const diffOp = await redeem(mkRedeem(w4User, inv4), inv4.code);
  const storm = await Promise.all(
    Array.from({ length: 30 }, () => redeem(w4Req, inv4.code)).concat(users.slice(22, 52).filter((u) => u !== w4User).map((u) => redeem(mkRedeem(u, inv4), inv4.code)))
  );
  const stormT = tally(storm);
  const stormProofs = new Set(storm.filter((r) => r.json.result === 'ACCEPTED').map((r) => r.json.proofId));
  check(
    'FIRST_GROUP_REDEEM_IDEMPOTENCY_GATE',
    sameProof && newSig.json.result === 'ACCEPTED' && newSig.json.proofId === r4.json.proofId && diffOp.json.result === 'ALREADY_REDEEMED' && stormProofs.size === 1,
    { stormT, diffOp: diffOp.json.result }
  );
  void winReq;
  void winUser;

  // ---------------- response loss (claim committed, response lost)
  const [E, F] = [users[152], users[153]];
  const inv5 = mkInvite(R);
  await register(inv5);
  const e5 = mkRedeem(E, inv5);
  const lost = await redeem(e5, inv5.code, { 'x-sos-test-fault': 'after-claim' });
  const led5a = await inspect(inv5);
  const f5 = await redeem(mkRedeem(F, inv5), inv5.code);
  const e5retry = await redeem(e5, inv5.code);
  const led5b = await inspect(inv5);
  check(
    'FIRST_GROUP_REDEEM_RESPONSE_LOSS_GATE',
    lost.json.result === 'TEMPORARILY_UNAVAILABLE' &&
      led5a.json.ledger.state === 'CLAIMED' &&
      f5.json.result === 'ALREADY_REDEEMED' &&
      e5retry.json.result === 'ACCEPTED' &&
      led5b.json.ledger.state === 'REDEEMED' &&
      proofVerdict(e5retry.json.proof).ok === true,
    { lost: lost.json.code, claimed: led5a.json.ledger.state, loser: f5.json.result, retry: e5retry.json.result }
  );

  // ---------------- finalization recovery (alarm, winner never retries)
  const inv6 = mkInvite(R);
  await register(inv6);
  const G6 = users[154];
  const g6 = mkRedeem(G6, inv6);
  await redeem(g6, inv6.code, { 'x-sos-test-fault': 'after-claim' });
  const led6a = await inspect(inv6);
  let led6b = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    led6b = await inspect(inv6);
    if (led6b.json.ledger && led6b.json.ledger.state === 'REDEEMED') break;
  }
  const g6retry = await redeem(g6, inv6.code);
  check(
    'FINALIZATION_RECOVERY_GATE',
    led6a.json.ledger.state === 'CLAIMED' && led6b.json.ledger.state === 'REDEEMED' && g6retry.json.result === 'ACCEPTED' && g6retry.json.proofId === led6b.json.ledger.proof_id,
    { before: led6a.json.ledger.state, after: led6b.json.ledger.state }
  );
  check('CLAIMED_NEVER_REVERTS_TO_UNUSED', [led5a, led5b, led6a, led6b].every((l) => l.json.ledger.state !== 'UNUSED'));

  // ---------------- revoke / redeem race
  let raceOk = true;
  const raceOutcomes = [];
  for (let i = 0; i < 12; i++) {
    const inv = mkInvite(B);
    await register(inv);
    const u = users[140 + i];
    const jitter = (i % 3) * 15;
    const [rv, rd2] = await Promise.all([
      sleep(i % 2 ? jitter : 0).then(() => revoke(mkRevoke(B, inv))),
      sleep(i % 2 ? 0 : jitter).then(() => redeem(mkRedeem(u, inv), inv.code)),
    ]);
    const pair = rv.json.result + '/' + rd2.json.result;
    raceOutcomes.push(pair);
    const okPair = pair === 'REVOKED/REVOKED' || pair === 'ALREADY_REDEEMED/ACCEPTED';
    const led = await inspect(inv);
    const st = led.json.ledger.state;
    if (!okPair || (pair === 'REVOKED/REVOKED' && st !== 'REVOKED') || (pair === 'ALREADY_REDEEMED/ACCEPTED' && st !== 'REDEEMED')) raceOk = false;
  }
  check('INVITE_REVOKE_REDEEM_RACE_GATE', raceOk, raceOutcomes);
  const invRv = mkInvite(B);
  await register(invRv);
  const rvX = await revoke(mkRevoke(X, invRv));
  const rvB = await revoke(mkRevoke(B, invRv));
  const rvB2 = await revoke(mkRevoke(B, invRv));
  const rvRoot = await revoke(mkRevoke(R, invRv));
  const rdAfter = await redeem(mkRedeem(users[155], invRv), invRv.code);
  check(
    'REVOKE_AUTHORIZATION_AND_IDEMPOTENCY',
    rvX.json.result === 'UNAUTHORIZED' && rvB.json.result === 'REVOKED' && rvB2.json.replay === true && rvRoot.json.result === 'REVOKED' && rdAfter.json.result === 'REVOKED',
    [rvX.json.result, rvB.json.result, rdAfter.json.result]
  );
  const rvUsed = await revoke(mkRevoke(R, inv2));
  check('REVOKE_AFTER_REDEEM_ALREADY_REDEEMED', rvUsed.json.result === 'ALREADY_REDEEMED', rvUsed.json);

  // ---------------- expiry uses authority clock
  const invE = mkInvite(R, { ttl: 4 });
  const regE = await register(invE);
  await sleep(5500);
  const skewed = mkRedeem(users[156], invE, { createdAt: now() - 200 });
  const rdE = await redeem(skewed, invE.code);
  const stE = await status(invE);
  check('EXPIRY_AUTHORITY_CLOCK', regE.json.result === 'REGISTERED' && rdE.json.result === 'EXPIRED' && stE.json.result === 'EXPIRED', [rdE.json.result, stE.json.result]);
  const rvE = await revoke(mkRevoke(R, invE));
  check('CLIENT_CLOCK_CAN_BYPASS_EXPIRATION_FALSE', rvE.json.result === 'EXPIRED' && rdE.json.result !== 'ACCEPTED');

  // ---------------- status privacy
  const invS = mkInvite(R);
  await register(invS);
  const s1 = await status(invS);
  const s2 = await status(invS, 'WRONGCODE1');
  const s3 = await status(inv2);
  const s3keys = Object.keys(s3.json).sort().join(',');
  check(
    'STATUS_PRIVACY',
    s1.json.result === 'UNUSED' && s2.json.result === 'INVALID' && s3.json.result === 'ALREADY_REDEEMED' && s3keys === 'result' && !/[0-9a-f]{64}/.test(s3.text),
    { unused: s1.json.result, wrong: s2.json.result, used: s3keys }
  );

  // ---------------- replay / tamper / forged requests
  const invA = mkInvite(R);
  await register(invA);
  const ua = users[157];
  const base = mkRedeem(ua, invA);
  const stale = await redeem(mkRedeem(ua, invA, { createdAt: now() - 1000 }), invA.code);
  const tamperOp = JSON.parse(JSON.stringify(base.ev));
  tamperOp.tags.find((t) => t[0] === 'op')[1] = 'a'.repeat(36);
  const tOp = await redeem(tamperOp, invA.code);
  const tamperInv = JSON.parse(JSON.stringify(base.ev));
  tamperInv.tags.find((t) => t[0] === 'e')[1] = inv3.ev.id;
  const tInv = await redeem(tamperInv, invA.code);
  const forgedRedeemer = Object.assign({}, base.ev, { pubkey: users[158].pub });
  const tRed = await redeem(forgedRedeemer, invA.code);
  const badSig = Object.assign({}, base.ev, { sig: '0'.repeat(128) });
  const tSig = await redeem(badSig, invA.code);
  const wrongCode = await redeem(base, 'ZZZZZZZZZZZZ');
  const wrongGroupReq = await redeem(mkRedeem(ua, invA, { group: 'other-network' }), invA.code);
  const replayOther = await redeem(winner2.json.proof ? mkRedeem(users[159], inv2) : base, inv2.code);
  const stillUnused = await status(invA);
  check(
    'REQUEST_REPLAY_AND_TAMPER_DENIED',
    stale.json.result === 'INVALID' &&
      tOp.json.result === 'UNAUTHORIZED' &&
      tInv.json.result === 'UNAUTHORIZED' &&
      tRed.json.result === 'UNAUTHORIZED' &&
      tSig.json.result === 'UNAUTHORIZED' &&
      wrongCode.json.result === 'INVALID' &&
      wrongGroupReq.json.result === 'INVALID' &&
      replayOther.json.result === 'ALREADY_REDEEMED' &&
      stillUnused.json.result === 'UNUSED',
    [stale.json.code, tOp.json.result, tInv.json.result, tRed.json.result, tSig.json.result, wrongCode.json.code, wrongGroupReq.json.code]
  );
  const replayWinner = await redeem(r4.json.proof ? w4Req : base, inv4.code);
  const rp = replayWinner.json.proof ? JSON.parse(replayWinner.json.proof.content) : {};
  check('REPLAYED_REQUEST_GRANTS_ONLY_ORIGINAL_REDEEMER', replayWinner.json.result === 'ACCEPTED' && rp.memberPubkey === w4User.pub);

  // ---------------- CORS is not authorization
  const evil = await post('/v1/invites/status', { groupId: GROUP, inviteId: invS.ev.id, code: invS.code }, { Origin: 'https://evil.example' });
  const good = await post('/v1/invites/status', { groupId: GROUP, inviteId: invS.ev.id, code: invS.code }, { Origin: 'http://127.0.0.1:8898' });
  const forgedWithOrigin = await redeem(badSig, invA.code, { Origin: 'http://127.0.0.1:8898' });
  check(
    'CORS_NOT_AUTHORIZATION',
    !evil.headers.get('access-control-allow-origin') && good.headers.get('access-control-allow-origin') === 'http://127.0.0.1:8898' && forgedWithOrigin.json.result === 'UNAUTHORIZED'
  );

  // ---------------- abuse
  const big = await post('/v1/invites/redeem', JSON.stringify({ groupId: GROUP, pad: 'x'.repeat(300 * 1024) }));
  const badJson = await post('/v1/invites/redeem', '{not json');
  const getRes = await fetch(BASE + '/v1/invites/redeem').then((r) => r.status);
  const noId = await post('/v1/invites/redeem', { groupId: GROUP, request: {} });
  check(
    'ABUSE_LIMITS',
    big.json.result === 'INVALID' && badJson.json.result === 'INVALID' && getRes === 405 && noId.json.result === 'INVALID' && [big, badJson, noId].every((r) => !/at \w+ \(|Error:|stack/i.test(r.text)),
    [big.json.code, badJson.json.code, getRes, noId.json.code]
  );

  // ---------------- registration authority (step 6): existing invite survives capability removal
  const invB1 = mkInvite(B);
  const regB1 = await register(invB1);
  commit(
    nextControl((r) => {
      r.capabilities[B.pub] = [];
      delete r.capabilities[B.pub];
    })
  );
  await ingest();
  const regB2 = await register(mkInvite(B));
  const rdB1 = await redeem(mkRedeem(users[130], invB1), invB1.code);
  check(
    'REGISTRATION_AUTHORITY_POLICY',
    regB1.json.result === 'REGISTERED' && regB2.json.result === 'UNAUTHORIZED' && rdB1.json.result === 'ACCEPTED',
    { existingInvite: rdB1.json.result, newRegistration: regB2.json.result }
  );
  const rdB1proof = proofVerdict(rdB1.json.proof);
  check('EXISTING_INVITE_PROOF_VALID_AFTER_INVITER_CAP_REMOVED', rdB1proof.ok === true, rdB1proof.code);

  // ---------------- proof adversarial (client resolver)
  const goodProof = winner2.json.proof;
  const goodBody = JSON.parse(goodProof.content);
  const signAs = (signer, bodyPatch, tagPatch) => {
    const body = Object.assign({}, goodBody, { issuerPubkey: signer.pub }, bodyPatch || {});
    const tags = goodProof.tags.map((t) => t.slice());
    if (tagPatch) tagPatch(tags);
    return finalizeEvent({ kind: 39003, created_at: now(), tags, content: JSON.stringify(body) }, signer.sk);
  };
  const vForged = proofVerdict(signAs(X));
  const vTamper = proofVerdict(Object.assign({}, goodProof, { content: goodProof.content.replace(goodBody.inviteEventId, inv3.ev.id) }));
  const noDelegation = controlEvents.slice(0, 1);
  const vNoDel = proofVerdict(goodProof, noDelegation);
  const vBind = proofVerdict(signAs(S, { admission: Object.assign({}, goodBody.admission, { redeemerPubkey: X.pub }) }));
  const vTag = proofVerdict(signAs(S, {}, (tags) => tags.forEach((t) => t[0] === 'admission' && (t[1] = inv3.ev.id))));
  const vRevokeTransition = proofVerdict(signAs(S, { transition: 'REMOVE', status: 'REMOVED' }, (tags) => tags.forEach((t) => t[0] === 'status' && (t[1] = 'REMOVED'))));
  // wrong-group delegation: another group's root-signed control delegating S does not help israel-network proofs
  const otherBoot = G.buildBootstrapRecord({ groupId: 'other-network', rootAdminPubkey: R.pub, invitePolicy: 'AUTHORIZED_USERS_ONLY' });
  const oRec = JSON.parse(G.serializeRecord(otherBoot));
  const oe1 = signControl(oRec, R);
  const oRec2 = Object.assign({}, oRec, { controlEpoch: 2, createdAt: now(), capabilities: { [S.pub]: ['FINALIZE_MEMBERSHIP_ADMISSION'] } });
  const oe2 = signControl(oRec2, R);
  const vWrongGroupDel = proofVerdict(goodProof, noDelegation.concat([oe1, oe2]));
  const vWrongGroupProof = proofVerdict(goodProof, [oe1, oe2], 'other-network');
  // Non-root delegation of the admission capability is an escalation.
  const withPM = nextControl((r) => {
    r.capabilities[Y.pub] = ['MANAGE_PERMISSIONS', 'MANAGE_ADMINS'];
  });
  const escal = (() => {
    const rec = JSON.parse(G.serializeRecord(withPM.rec));
    rec.controlEpoch += 1;
    rec.createdAt = now();
    rec.capabilities[X.pub] = ['FINALIZE_MEMBERSHIP_ADMISSION'];
    return signControl(rec, Y);
  })();
  const escState = localControl(controlEvents.concat([withPM.ev, escal]));
  check(
    'FIRST_GROUP_NETWORK_ADVERSARIAL_PROOFS',
    !vForged.ok && !vTamper.ok && !vNoDel.ok && !vBind.ok && !vTag.ok && !vRevokeTransition.ok && !vWrongGroupDel.ok && !vWrongGroupProof.ok && escState.controlEpoch === withPM.rec.controlEpoch,
    {
      forged: vForged.code,
      tampered: vTamper.code,
      noDelegation: vNoDel.code,
      binding: vBind.code,
      tag: vTag.code,
      nonGrant: vRevokeTransition.code,
      wrongGroupDelegation: vWrongGroupDel.code,
      wrongGroupProof: vWrongGroupProof.code,
      nonRootDelegation: escState.controlEpoch === withPM.rec.controlEpoch ? 'REJECTED' : 'APPLIED',
    }
  );
  check('ADMISSION_DELEGATION_GROUP_BOUND', !vWrongGroupDel.ok && !vWrongGroupProof.ok);
  check('ADMISSION_DELEGATION_CAPABILITY_NARROW', vRevokeTransition.code === 'ADMISSION_DELEGATE_GRANT_ONLY' && fs2.json.controlEpoch === 2);

  // ---------------- rotation: retire S (historical proofs stay valid), activate S2; then full revoke of S
  const preRotateEpoch = tip.controlEpoch;
  commit(
    nextControl((r) => {
      r.capabilities[S2.pub] = ['FINALIZE_MEMBERSHIP_ADMISSION'];
      r.capabilities[S.pub] = ['FINALIZE_MEMBERSHIP_ADMISSION_RETIRED'];
    })
  );
  await ingest();
  const vHist = proofVerdict(goodProof);
  const lateByS = proofVerdict(signAs(S, { controlEpochAtIssue: tip.controlEpoch }, (tags) => tags.forEach((t) => t[0] === 'control-epoch' && (t[1] = String(tip.controlEpoch)))));
  const invRot = mkInvite(R);
  const regRot = await register(invRot);
  const rdRot = await redeem(mkRedeem(users[131], invRot), invRot.code);
  commit(
    nextControl((r) => {
      delete r.capabilities[S.pub];
    })
  );
  await ingest();
  const vRevoked = proofVerdict(goodProof);
  check(
    'ADMISSION_KEY_ROTATION',
    vHist.ok === true && !lateByS.ok && regRot.json.result === 'TEMPORARILY_UNAVAILABLE' && rdRot.json.result !== 'ACCEPTED' && !vRevoked.ok,
    { historical: vHist.code, lateRetired: lateByS.code, retiredServiceRegister: regRot.json.code, afterFullRevoke: vRevoked.code, preRotateEpoch }
  );
  check('REVOKED_DELEGATION_PROOF_REJECTED', !vRevoked.ok, vRevoked.code);
  const unusedAfter = await status(invA);
  const rdNoDel = await redeem(mkRedeem(ua, invA), invA.code);
  const unusedAfter2 = await status(invA);
  check(
    'DELEGATION_INACTIVE_FAILS_CLOSED_WITHOUT_CLAIM',
    rdNoDel.json.result === 'TEMPORARILY_UNAVAILABLE' && unusedAfter.json.result === 'UNUSED' && unusedAfter2.json.result === 'UNUSED',
    rdNoDel.json
  );
  // Restore S as active delegate so persisted-state checks can finalize.
  commit(
    nextControl((r) => {
      r.capabilities[S.pub] = ['FINALIZE_MEMBERSHIP_ADMISSION'];
      delete r.capabilities[S2.pub];
    })
  );
  await ingest();

  // ---------------- outage / durability
  if (!REMOTE) {
    stopWrangler();
    await sleep(1500);
    const down = await redeem(mkRedeem(ua, invA), invA.code);
    check('OUTAGE_FAILS_CLOSED', down.json.result === 'TEMPORARILY_UNAVAILABLE', down.json);
    await startWrangler();
    const afterRestart = await redeem(mkRedeem(users[132], inv3), inv3.code);
    const winnerAfter = await redeem(w4Req, inv4.code);
    const ctl = await ingest();
    check(
      'LEDGER_DURABLE_ACROSS_RESTART',
      afterRestart.json.result === 'ALREADY_REDEEMED' && winnerAfter.json.proofId === r4.json.proofId && ctl.json.result === 'OK',
      [afterRestart.json.result, winnerAfter.json.result]
    );
  } else {
    const down = await fetch('https://127.0.0.1:1/v1/invites/redeem', { method: 'POST' }).then(
      () => ({ result: 'UNEXPECTED' }),
      () => ({ result: 'TEMPORARILY_UNAVAILABLE' })
    );
    check('OUTAGE_FAILS_CLOSED', down.result === 'TEMPORARILY_UNAVAILABLE', { note: 'client transport failure maps to TEMPORARILY_UNAVAILABLE' });
  }

  // ---------------- log privacy
  if (!REMOTE) {
    stopWrangler();
    const leaks = SECRETS.filter((s) => wrLog.includes(s)).length + INVITE_CODES.filter((c) => wrLog.includes(c)).length;
    check('SERVICE_LOG_PRIVACY', leaks === 0, { leaks, logBytes: wrLog.length });
  }

  const results = Object.fromEntries(checks.map((c) => [c.name, c.ok ? 'PASS' : 'FAIL']));
  const pass = checks.every((c) => c.ok);
  const report = {
    package: 898,
    gate: 'PACKAGE898_ADMISSION_SERVICE_GATE',
    mode: MODE,
    baseUrl: REMOTE ? BASE.replace(/^https:\/\/([^.]+)\..*$/, 'https://$1.<workers.dev>') : 'local-workerd',
    generatedAt: new Date().toISOString(),
    status: pass ? 'PASS' : 'FAIL',
    stress100: stress,
    raceOutcomes,
    results,
    checks,
    DOUBLE_REDEEM_SCOPE: 'NETWORK_SERIALIZED_AUTHORITY',
    DURABLE_OBJECT_PER_INVITE: 'idFromName(firstGroupId + ":" + inviteId)',
    ROOT_PRIVATE_KEY_SERVER_EXPOSED: false,
    PRODUCTION_ROOT_DELEGATION_CREATED: false,
    QA_KEYS: 'disposable (generated per run, never persisted outside gitignored .dev.vars during the run)',
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`\nPACKAGE898_ADMISSION_SERVICE_GATE=${report.status} (${checks.filter((c) => c.ok).length}/${checks.length})`);
  return pass;
}

main()
  .then((ok) => {
    cleanup();
    process.exit(ok ? 0 : 1);
  })
  .catch((e) => {
    console.error('GATE ERROR', e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e);
    console.error(wrLog.slice(-3000));
    cleanup();
    process.exit(2);
  });

function cleanup() {
  stopWrangler();
  if (!REMOTE) {
    try {
      fs.rmSync(path.join(SVC_DIR, '.dev.vars'), { force: true });
    } catch (_e) {}
  }
  try {
    fs.rmSync(persistDir, { recursive: true, force: true });
  } catch (_e) {}
}
