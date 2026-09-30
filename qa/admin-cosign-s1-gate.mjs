/**
 * Admin co-sign stage 1 — server-authoritative admin PIN + co-sign service (local workerd only, no deploy).
 *
 * Starts `wrangler dev --local` with disposable root / admission / co-sign keys and pepper written to the
 * gitignored admission-service/.dev.vars (deleted on exit). The QA PIN is random per run and never printed.
 * Writes qa/admin-cosign-s1-report.json (no secrets).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import * as NostrTools from 'nostr-tools';

const { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } = NostrTools;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVC_DIR = path.join(ROOT, 'admission-service');
const REPORT = path.join(__dirname, 'admin-cosign-s1-report.json');
const GROUP = 'israel-network';
const PORT = Number(process.env.SOS_PIN_PORT || 8797);
const BASE = `http://127.0.0.1:${PORT}`;

const hex = (u8) => Buffer.from(u8).toString('hex');
function mkKey() {
  const sk = generateSecretKey();
  return { sk, hex: hex(sk), pub: getPublicKey(sk) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ------------------------------------------------------------ client control modules (same code as browsers)
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
for (const f of ['nostr-event-integrity.js', 'group-control-state.js', 'admin-2fa-protocol.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
}
console.log = origLog;
console.warn = origWarn;
const G = globalThis.NostrApp.GroupControlState;
const P = globalThis.NostrApp.Admin2faProtocol;

// ------------------------------------------------------------ disposable keys + QA PINs
const R = mkKey(); // QA root
const S = mkKey(); // admission service
const C = mkKey(); // co-sign service
const A2 = mkKey(); // delegated admin
const B = mkKey(); // inviter (not admin)
const X = mkKey(); // outsider
const PEPPER = crypto.randomBytes(32).toString('hex');
const randPin = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const PIN = randPin();
let OTHER = randPin();
while (OTHER === PIN) OTHER = randPin();
globalThis.NostrApp.adminSourceKeys = [R.pub];
const SECRETS = [R.hex, S.hex, C.hex, A2.hex, B.hex, X.hex, PEPPER];
const SENSITIVE = []; // derived values + session ids, checked against logs and inspect output

// ------------------------------------------------------------ report
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail == null ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail != null ? ' ' + JSON.stringify(detail) : ''}`);
}

// ------------------------------------------------------------ clock + http
let clockOffset = 0;
const nowMs = () => Date.now() + clockOffset;
const nowSec = () => Math.floor(nowMs() / 1000);

async function post(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sos-test-now': String(nowMs()) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch (_e) {}
  return { status: res.status, json, text };
}

function authFor(signer, action, paramsJson, o) {
  const opt = o || {};
  return finalizeEvent(
    {
      kind: opt.kind || 27235,
      created_at: opt.createdAt || nowSec(),
      tags: [
        ['u', 'sos-admin-pin:v1:' + (opt.action || action)],
        ['method', 'POST'],
        ['payload', opt.payload || sha256(paramsJson)],
        ['t', opt.group || GROUP],
        ['sos-admin-pin', 'v1'],
      ].concat(opt.noNonce ? [] : [['nonce', crypto.randomBytes(16).toString('hex')]]),
      content: '',
    },
    signer.sk
  );
}

async function pinCall(signer, action, params, o) {
  const paramsJson = JSON.stringify(params || {});
  const auth = (o && o.auth) || authFor(signer, action, paramsJson, o);
  const r = await post('/v1/admin-pin/' + action, { groupId: GROUP, auth, params: (o && o.paramsOverride) || paramsJson });
  r.auth = auth;
  r.paramsJson = paramsJson;
  return r;
}

function derive(pin, saltHex) {
  const d = crypto.pbkdf2Sync(pin, Buffer.from(saltHex, 'hex'), 600000, 32, 'sha256').toString('hex');
  SENSITIVE.push(d);
  return d;
}

// ------------------------------------------------------------ control chain
const controlEvents = [];
let tip = null;
function signControl(recObj, signer) {
  const record = G.parseAndValidateRecord(JSON.stringify(recObj));
  const d = G.buildSignDraft(record, signer.pub);
  return finalizeEvent({ kind: d.kind, created_at: d.created_at, tags: d.tags, content: d.content }, signer.sk);
}
function nextControl(patch, signer, epochStep) {
  const rec = JSON.parse(G.serializeRecord(tip));
  rec.controlEpoch += epochStep || 1;
  rec.createdAt = nowSec();
  patch(rec);
  return { ev: signControl(rec, signer || R), rec: G.parseAndValidateRecord(JSON.stringify(rec)) };
}
const ingest = () => post('/v1/control/ingest', { groupId: GROUP, events: controlEvents });

// ------------------------------------------------------------ wrangler
let wr = null;
let wrLog = '';
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sos-pin-'));
function writeDevVars() {
  fs.writeFileSync(
    path.join(SVC_DIR, '.dev.vars'),
    `ROOT_PUBKEY=${R.pub}\nADMISSION_SK=${S.hex}\nADMIN_COSIGN_SK=${C.hex}\nADMIN_PIN_PEPPER=${PEPPER}\nTEST_FAULTS=1\nALLOWED_ORIGINS=http://127.0.0.1:8898\n`
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
      if (r.ok) return;
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
  writeDevVars();
  await startWrangler();

  const healthRes = await fetch(BASE + '/v1/health');
  const healthText = await healthRes.text();
  const health = JSON.parse(healthText);
  check('HEALTH_EXPOSES_COSIGN_PUBKEY_ONLY', health.cosignPubkey === C.pub && health.adminPinService === true && SECRETS.every((s) => !healthText.includes(s)), {
    adminPinService: health.adminPinService,
  });
  check('COSIGN_KEY_DISTINCT_FROM_ROOT_AND_ADMISSION', health.cosignPubkey !== R.pub && health.cosignPubkey !== S.pub);

  // ---------------- request authentication
  const noAuth = await post('/v1/admin-pin/params', { groupId: GROUP, params: '{}' });
  const outsider = await pinCall(X, 'params', {});
  const wrongKind = await pinCall(R, 'params', {}, { kind: 1 });
  const wrongGroup = await pinCall(R, 'params', {}, { group: 'other-network' });
  const wrongAction = await pinCall(R, 'params', {}, { action: 'verify' });
  const stale = await pinCall(R, 'params', {}, { createdAt: nowSec() - 300 });
  const future = await pinCall(R, 'params', {}, { createdAt: nowSec() + 300 });
  const goodAuth = authFor(R, 'params', '{}');
  const badSig = Object.assign({}, goodAuth, { sig: '0'.repeat(128) });
  const forged = await pinCall(R, 'params', {}, { auth: badSig });
  const payloadSwap = await pinCall(R, 'params', {}, { paramsOverride: '{"x":1}' });
  const noNonce = await pinCall(R, 'params', {}, { noNonce: true });
  check(
    'AUTH_EVENT_REQUIRED_AND_BOUND',
    noAuth.json.code === 'NO_AUTH' &&
      outsider.json.code === 'NOT_ADMIN' &&
      wrongKind.json.code === 'BAD_AUTH_KIND' &&
      wrongGroup.json.code === 'CROSS_GROUP' &&
      wrongAction.json.code === 'WRONG_ACTION' &&
      stale.json.code === 'STALE_AUTH' &&
      future.json.code === 'STALE_AUTH' &&
      forged.json.code === 'STRICT_VERIFY_FAILED' &&
      payloadSwap.json.code === 'PAYLOAD_MISMATCH' &&
      noNonce.json.code === 'NO_NONCE',
    [noAuth, outsider, wrongKind, wrongGroup, wrongAction, stale, future, forged, payloadSwap, noNonce].map((r) => r.json.code)
  );

  // ---------------- first-time enrollment (SETUP_REQUIRED)
  const p1 = await pinCall(R, 'params', {});
  check('ROOT_FIRST_STATE_SETUP_REQUIRED', p1.json.result === 'OK' && p1.json.adminState === 'SETUP_REQUIRED' && p1.json.enrolled === false, { adminState: p1.json.adminState });
  check('PARAMS_SALT_AND_KDF', /^[0-9a-f]{32}$/.test(p1.json.salt || '') && p1.json.iterations === 600000 && p1.json.algorithm === 'PBKDF2-SHA256');
  const replay = await pinCall(R, 'params', {}, { auth: p1.auth });
  check('AUTH_REPLAY_DENIED', replay.json.code === 'AUTH_REPLAY', replay.json.code);
  const salt = p1.json.salt;
  const p1b = await pinCall(R, 'params', {});
  check('SALT_STABLE_UNTIL_ENROLLED', p1b.json.salt === salt);
  const dGood = derive(PIN, salt);
  const dOther = derive(OTHER, salt);
  const badDerived = await pinCall(R, 'enroll', { derived: 'abc', salt });
  const badSalt = await pinCall(R, 'enroll', { derived: dGood, salt: '00'.repeat(16) });
  check('ENROLL_INPUT_VALIDATION', badDerived.json.code === 'BAD_DERIVED' && badSalt.json.code === 'SALT_MISMATCH', [badDerived.json.code, badSalt.json.code]);
  const outsiderEnroll = await pinCall(X, 'enroll', { derived: dOther, salt });
  check('OUTSIDER_CANNOT_ENROLL', outsiderEnroll.json.code === 'NOT_ADMIN', outsiderEnroll.json.code);
  const enroll = await pinCall(R, 'enroll', { derived: dGood, salt });
  const session1 = enroll.json.sessionId;
  if (session1) SENSITIVE.push(session1);
  check('FIRST_TIME_ADMIN_ENROLLMENT', enroll.json.result === 'OK' && enroll.json.adminState === 'UNLOCKED' && /^[0-9a-f]{64}$/.test(session1 || ''), {
    adminState: enroll.json.adminState,
  });

  // ---------------- no silent replacement
  const reEnroll = await pinCall(R, 'enroll', { derived: dOther, salt });
  const p2 = await pinCall(R, 'params', {});
  const oldStillWorks = await pinCall(R, 'verify', { derived: dGood });
  if (oldStillWorks.json.sessionId) SENSITIVE.push(oldStillWorks.json.sessionId);
  check(
    'NO_SILENT_PIN_REPLACEMENT',
    reEnroll.json.code === 'ALREADY_ENROLLED' && p2.json.adminState === 'LOCKED' && p2.json.salt === salt && oldStillWorks.json.result === 'OK',
    [reEnroll.json.code, p2.json.adminState, oldStillWorks.json.result]
  );
  const concurrent = await Promise.all([pinCall(R, 'enroll', { derived: dOther, salt }), pinCall(R, 'enroll', { derived: dOther, salt })]);
  check('ENROLL_RACE_NO_OVERWRITE', concurrent.every((r) => r.json.code === 'ALREADY_ENROLLED'));

  // ---------------- verify + brute force lockout
  const wrongs = [];
  for (let i = 0; i < 4; i++) wrongs.push(await pinCall(R, 'verify', { derived: dOther }));
  const locked = await pinCall(R, 'verify', { derived: dGood });
  check(
    'SERVER_LOCKOUT_SCHEDULE',
    wrongs.slice(0, 3).every((r) => r.json.code === 'WRONG_PIN' && r.json.retryAfterMs === 0) &&
      wrongs[3].json.code === 'WRONG_PIN' &&
      wrongs[3].json.retryAfterMs === 30000 &&
      locked.json.code === 'PIN_LOCKED' &&
      locked.json.retryAfterMs > 0 &&
      !locked.json.sessionId,
    { fourth: wrongs[3].json.retryAfterMs, correctWhileLocked: locked.json.code }
  );
  clockOffset += 31000;
  const afterLock = await pinCall(R, 'verify', { derived: dGood });
  const session2 = afterLock.json.sessionId;
  if (session2) SENSITIVE.push(session2);
  check('CORRECT_PIN_AFTER_LOCK_UNLOCKS', afterLock.json.result === 'OK' && /^[0-9a-f]{64}$/.test(session2 || ''), afterLock.json.code);
  const w5 = [];
  for (let i = 0; i < 4; i++) w5.push(await pinCall(R, 'verify', { derived: dOther }));
  check('SUCCESS_RESETS_FAILURE_COUNTER', w5[2].json.retryAfterMs === 0 && w5[3].json.retryAfterMs === 30000, w5.map((r) => r.json.retryAfterMs));
  clockOffset += 31000;
  const w6 = await pinCall(R, 'verify', { derived: dOther });
  check('LOCKOUT_ESCALATES', w6.json.code === 'WRONG_PIN' && w6.json.retryAfterMs === 60000, w6.json.retryAfterMs);
  clockOffset += 61000;
  const unlock3 = await pinCall(R, 'verify', { derived: dGood });
  let session = unlock3.json.sessionId;
  if (session) SENSITIVE.push(session);
  check('ADMIN_PIN_SERVER_AUTHORITATIVE', unlock3.json.result === 'OK');

  // ---------------- co-sign: genesis must bind this signer
  const unbound = signControl(JSON.parse(G.serializeRecord(G.buildBootstrapRecord({ groupId: GROUP, rootAdminPubkey: R.pub, createdAt: nowSec() }))), R);
  const unboundRes = await pinCall(R, 'cosign', { event: unbound, sessionId: session, stepUp: dGood });
  const otherSigner = mkKey();
  const wrongBound = signControl(
    JSON.parse(G.serializeRecord(G.buildBootstrapRecord({ groupId: GROUP, rootAdminPubkey: R.pub, createdAt: nowSec(), admin2faSignerPubkey: otherSigner.pub }))),
    R
  );
  const wrongBoundRes = await pinCall(R, 'cosign', { event: wrongBound, sessionId: session, stepUp: dGood });
  check('GENESIS_MUST_BIND_COSIGN_SIGNER', unboundRes.json.code === 'SIGNER_NOT_BOUND' && wrongBoundRes.json.code === 'SIGNER_NOT_BOUND', [unboundRes.json.code, wrongBoundRes.json.code]);
  const staleBoot = signControl(
    JSON.parse(G.serializeRecord(G.buildBootstrapRecord({ groupId: GROUP, rootAdminPubkey: R.pub, createdAt: nowSec() - 3600, admin2faSignerPubkey: C.pub }))),
    R
  );
  const staleBootEv = finalizeEvent({ kind: staleBoot.kind, created_at: nowSec() - 3600, tags: staleBoot.tags, content: staleBoot.content }, R.sk);
  const staleRes = await pinCall(R, 'cosign', { event: staleBootEv, sessionId: session, stepUp: dGood });
  check('STALE_EVENT_NOT_COSIGNED', staleRes.json.code === 'STALE_EVENT', staleRes.json.code);

  // ---------------- co-sign: genesis requires session + step-up
  const boot = G.buildBootstrapRecord({ groupId: GROUP, rootAdminPubkey: R.pub, invitePolicy: 'AUTHORIZED_USERS_ONLY', admin2faSignerPubkey: C.pub });
  const bootRec = JSON.parse(G.serializeRecord(boot));
  bootRec.createdAt = nowSec();
  const e1 = signControl(bootRec, R);
  const noSess = await pinCall(R, 'cosign', { event: e1 });
  const fakeSess = await pinCall(R, 'cosign', { event: e1, sessionId: 'ab'.repeat(32) });
  const noStep = await pinCall(R, 'cosign', { event: e1, sessionId: session });
  const badStep = await pinCall(R, 'cosign', { event: e1, sessionId: session, stepUp: dOther });
  const cos1 = await pinCall(R, 'cosign', { event: e1, sessionId: session, stepUp: dGood });
  check('COSIGN_REQUIRES_PIN_SESSION', noSess.json.code === 'NO_SESSION' && fakeSess.json.code === 'NO_SESSION', [noSess.json.code, fakeSess.json.code]);
  // Phase 3 canonical re-auth policy: BOOTSTRAP needs the PIN session only (not a sensitive re-auth operation).
  check('GENESIS_SESSION_ONLY_CANONICAL_STEP_UP_POLICY', noStep.json.result === 'COSIGNED' && noStep.json.stepUp === false && badStep.json.result === 'COSIGNED' && cos1.json.result === 'COSIGNED', [
    noStep.json.result,
    badStep.json.result,
    cos1.json.result,
  ]);
  const att = cos1.json.attestation || {};
  let attBody = {};
  try {
    attBody = JSON.parse(att.content);
  } catch (_e) {}
  const t = (n) => ((att.tags || []).find((x) => x[0] === n) || [])[1];
  check(
    'ATTESTATION_SHAPE_AND_SIGNATURE',
    verifyEvent(att) &&
      att.kind === 39004 &&
      att.pubkey === C.pub &&
      t('e') === e1.id &&
      t('d') === GROUP + ':' + e1.id &&
      t('p') === R.pub &&
      t('t') === GROUP &&
      attBody.schema === 'sos-admin-cosign' &&
      attBody.protocol === 'sos-admin-2fa-v1' &&
      attBody.eventId === e1.id &&
      attBody.controlEpoch === 1 &&
      attBody.principal === R.pub &&
      attBody.rootPubkey === R.pub &&
      JSON.stringify(attBody.operations) === '["BOOTSTRAP_GROUP_CONTROL"]' &&
      attBody.expiresAt === attBody.issuedAt + 600 &&
      attBody.requestId === cos1.auth.id &&
      attBody.stepUp === false,
    { kind: att.kind, controlEpoch: attBody.controlEpoch, operations: attBody.operations }
  );
  const clientVerdict = P.verifyAdmin2faAttestation(e1, att, {
    groupId: GROUP,
    rootPubkey: R.pub,
    signerPubkey: C.pub,
    expectedOperations: P.classifyControlTransition(null, boot),
    controlEpoch: 1,
    nowSec: nowSec(),
  });
  check('PHASE1_PHASE2_PROTOCOL_MATCH', clientVerdict.ok === true, clientVerdict.code);
  const snapAfterCosign = await post('/v1/control/ingest', { groupId: GROUP, events: [] });
  check('COSIGN_IS_DRY_RUN_NO_CONTROL_MUTATION', snapAfterCosign.json.controlEpoch == null, snapAfterCosign.json);

  controlEvents.push(e1);
  tip = boot;
  const ing1 = await ingest();
  check('CONTROL_BOOTSTRAP_INGESTED', ing1.json.result === 'OK' && ing1.json.controlEpoch === 1, ing1.json);

  // ---------------- additive change: session suffices, no step-up
  const add = nextControl((r) => {
    r.capabilities[B.pub] = ['INVITE_USERS'];
    r.capabilities[A2.pub] = ['MANAGE_GROUP_SETTINGS'];
  });
  const cosAdd = await pinCall(R, 'cosign', { event: add.ev, sessionId: session });
  check('ADDITIVE_CHANGE_COSIGNED_WITHOUT_STEP_UP', cosAdd.json.result === 'COSIGNED' && cosAdd.json.stepUp === false, cosAdd.json.result);
  const addVerdict = P.verifyAdmin2faAttestation(add.ev, cosAdd.json.attestation, {
    groupId: GROUP,
    rootPubkey: R.pub,
    signerPubkey: C.pub,
    expectedOperations: P.classifyControlTransition(tip, add.rec),
    controlEpoch: 2,
  });
  check('SERVER_OPERATIONS_MATCH_CLIENT_CLASSIFIER', addVerdict.ok === true && cosAdd.json.operations.join(',') === 'GRANT_CAPABILITY,PROMOTE_ADMIN', [addVerdict.code, cosAdd.json.operations]);

  // ---------------- rejected co-sign inputs
  const byOutsider = signControl(Object.assign(JSON.parse(G.serializeRecord(add.rec)), { createdAt: nowSec() }), X);
  const issuerMismatch = await pinCall(R, 'cosign', { event: byOutsider, sessionId: session });
  const skip = nextControl(() => {}, R, 3);
  const badTransition = await pinCall(R, 'cosign', { event: skip.ev, sessionId: session });
  const kindEv = finalizeEvent({ kind: 39003, created_at: nowSec(), tags: [['t', GROUP]], content: '{}' }, R.sk);
  const badMember = await pinCall(R, 'cosign', { event: kindEv, sessionId: session });
  const badKind = await pinCall(R, 'cosign', { event: finalizeEvent({ kind: 30078, created_at: nowSec(), tags: [['t', GROUP]], content: '{}' }, R.sk), sessionId: session });
  const tampered = Object.assign({}, add.ev, { content: add.ev.content.replace('INVITE_USERS', 'MANAGE_ADMINS') });
  const badSigEv = await pinCall(R, 'cosign', { event: tampered, sessionId: session });
  const staleEv = await pinCall(R, 'cosign', { event: e1, sessionId: session, stepUp: dGood });
  check(
    'COSIGN_REJECTS_INVALID_EVENTS',
    issuerMismatch.json.code === 'ISSUER_MISMATCH' &&
      badTransition.json.code === 'INVALID_TRANSITION' &&
      badKind.json.code === 'KIND_NOT_COSIGNABLE' &&
      badMember.json.code === 'INVALID_MEMBERSHIP' &&
      !badMember.json.attestation &&
      badSigEv.json.code === 'STRICT_VERIFY_FAILED' &&
      staleEv.json.code === 'INVALID_TRANSITION',
    [issuerMismatch.json.code, badTransition.json.code, badTransition.json.reason, badKind.json.code, badMember.json.code, badSigEv.json.code, staleEv.json.code]
  );
  const outsiderCosign = await pinCall(X, 'cosign', { event: byOutsider, sessionId: session });
  check('SESSION_BOUND_TO_PRINCIPAL', outsiderCosign.json.code === 'NOT_ADMIN', outsiderCosign.json.code);

  controlEvents.push(add.ev);
  tip = add.rec;
  await ingest();

  // ---------------- canonical sensitive re-auth (P.requiresStepUp): demote, policy, blocking an admin
  const removeCap = nextControl((r) => delete r.capabilities[B.pub]);
  const demote = nextControl((r) => delete r.capabilities[A2.pub]);
  const policy = nextControl((r) => (r.invitePolicy = 'ADMINS_ONLY'));
  const block = nextControl((r) => r.blockedPubkeys.push(X.pub));
  const blockAdmin = nextControl((r) => r.blockedPubkeys.push(A2.pub));
  const rmNo = await pinCall(R, 'cosign', { event: removeCap.ev, sessionId: session });
  const demNo = await pinCall(R, 'cosign', { event: demote.ev, sessionId: session });
  const polNo = await pinCall(R, 'cosign', { event: policy.ev, sessionId: session });
  const blkNo = await pinCall(R, 'cosign', { event: block.ev, sessionId: session });
  const blkAdmNo = await pinCall(R, 'cosign', { event: blockAdmin.ev, sessionId: session });
  const demBad = await pinCall(R, 'cosign', { event: demote.ev, sessionId: session, stepUp: dOther });
  const demYes = await pinCall(R, 'cosign', { event: demote.ev, sessionId: session, stepUp: dGood });
  check(
    'SENSITIVE_CHANGE_REQUIRES_STEP_UP',
    rmNo.json.result === 'COSIGNED' &&
      rmNo.json.stepUp === false &&
      demNo.json.result === 'STEP_UP_REQUIRED' &&
      (polNo.json.result === 'STEP_UP_REQUIRED' || polNo.json.code === 'INVALID_TRANSITION') &&
      blkNo.json.result === 'COSIGNED' &&
      blkAdmNo.json.result === 'STEP_UP_REQUIRED' &&
      demBad.json.code === 'WRONG_PIN' &&
      demYes.json.result === 'COSIGNED' &&
      demYes.json.stepUp === true,
    [rmNo.json.result, demNo.json.result, polNo.json.result + '/' + (polNo.json.code || ''), blkNo.json.result, blkAdmNo.json.result, demBad.json.code, demYes.json.result]
  );
  // ---------------- delegated admin vs non-admin
  const a2p = await pinCall(A2, 'params', {});
  const bp = await pinCall(B, 'params', {});
  check('DELEGATED_ADMIN_OWN_ENROLLMENT_ONLY', a2p.json.adminState === 'SETUP_REQUIRED' && a2p.json.salt !== salt && bp.json.code === 'NOT_ADMIN', [a2p.json.adminState, bp.json.code]);
  const crossSession = await pinCall(A2, 'cosign', { event: add.ev, sessionId: session });
  check('ROOT_SESSION_NOT_USABLE_BY_OTHER_ADMIN', crossSession.json.code === 'NO_SESSION', crossSession.json.code);

  // ---------------- session lifetime + lock
  clockOffset += 16 * 60 * 1000;
  const idle = await pinCall(R, 'cosign', { event: removeCap.ev, sessionId: session, stepUp: dGood });
  check('SESSION_IDLE_TIMEOUT', idle.json.code === 'SESSION_EXPIRED', idle.json.code);
  const v4 = await pinCall(R, 'verify', { derived: dGood });
  session = v4.json.sessionId;
  if (session) SENSITIVE.push(session);
  const touchRes = [];
  for (let i = 0; i < 3; i++) {
    clockOffset += 10 * 60 * 1000;
    const fresh = nextControl((r) => delete r.capabilities[B.pub]);
    touchRes.push(await pinCall(R, 'cosign', { event: fresh.ev, sessionId: session, stepUp: dGood }));
  }
  check('SESSION_ACTIVITY_EXTENDS_IDLE', touchRes.every((r) => r.json.result === 'COSIGNED'), touchRes.map((r) => r.json.result));
  const lockRes = await pinCall(R, 'lock', { sessionId: session });
  const afterLockCos = await pinCall(R, 'cosign', { event: removeCap.ev, sessionId: session, stepUp: dGood });
  check('LOCK_REVOKES_SESSION', lockRes.json.adminState === 'LOCKED' && afterLockCos.json.code === 'NO_SESSION', afterLockCos.json.code);
  const v5 = await pinCall(R, 'verify', { derived: dGood });
  const s5 = v5.json.sessionId;
  if (s5) SENSITIVE.push(s5);
  clockOffset += 12 * 60 * 60 * 1000 + 1000;
  const absolute = await pinCall(R, 'cosign', { event: removeCap.ev, sessionId: s5, stepUp: dGood });
  check('SESSION_ABSOLUTE_LIFETIME', absolute.json.code === 'SESSION_EXPIRED', absolute.json.code);

  // ---------------- storage shape: verifier only, hashed sessions
  const insp = await post('/v1/test/pin-inspect', { groupId: GROUP });
  const rootRow = (insp.json.pins || []).find((p) => p.principal === R.pub) || {};
  check(
    'HARDENED_VERIFIER_ONLY',
    rootRow.verifierHexLen === 64 &&
      rootRow.saltHexLen === 32 &&
      (insp.json.columns || []).join(',') === 'principal,salt,verifier,enrolled_at,failures,lock_until' &&
      (insp.json.sessionHashLens || []).every((n) => n === 64) &&
      SENSITIVE.every((s) => !insp.text.includes(s)),
    { columns: insp.json.columns, sessions: (insp.json.sessionHashLens || []).length }
  );

  // ---------------- durability across restart
  stopWrangler();
  await sleep(1500);
  await startWrangler();
  const vAfter = await pinCall(R, 'verify', { derived: dGood });
  if (vAfter.json.sessionId) SENSITIVE.push(vAfter.json.sessionId);
  const reAfter = await pinCall(R, 'enroll', { derived: dOther, salt });
  check('ENROLLMENT_DURABLE_ACROSS_RESTART', vAfter.json.result === 'OK' && reAfter.json.code === 'ALREADY_ENROLLED', [vAfter.json.result, reAfter.json.code]);

  // ---------------- no generic signer
  const genericKinds = await Promise.all(
    [1, 0, 7, 27235, 39004, 30078].map((k) => pinCall(R, 'cosign', { event: finalizeEvent({ kind: k, created_at: nowSec(), tags: [], content: 'x' }, R.sk), sessionId: vAfter.json.sessionId }))
  );
  // Allowlisted kinds with no valid privileged meaning are refused too (no attestation, no arbitrary signing).
  const junkPrivileged = await Promise.all(
    [39002, 39003, 37380, 5].map((k) => pinCall(R, 'cosign', { event: finalizeEvent({ kind: k, created_at: nowSec(), tags: [['t', GROUP]], content: 'x' }, R.sk), sessionId: vAfter.json.sessionId }))
  );
  check(
    'GENERIC_SIGNER_EXPOSED_FALSE',
    genericKinds.every((r) => r.json.code === 'KIND_NOT_COSIGNABLE' && !r.json.attestation) &&
      junkPrivileged.every((r) => r.json.result !== 'COSIGNED' && !r.json.attestation),
    junkPrivileged.map((r) => r.json.code)
  );

  // ---------------- log privacy
  stopWrangler();
  const leaks = SECRETS.concat(SENSITIVE).filter((s) => wrLog.includes(s)).length;
  check('SERVICE_LOG_PRIVACY', leaks === 0, { leaks, logBytes: wrLog.length });

  const pass = checks.every((c) => c.ok);
  const report = {
    gate: 'ADMIN_COSIGN_STAGE1_GATE',
    mode: 'local-workerd',
    generatedAt: new Date().toISOString(),
    status: pass ? 'PASS' : 'FAIL',
    results: Object.fromEntries(checks.map((c) => [c.name, c.ok ? 'PASS' : 'FAIL'])),
    checks,
    FIRST_TIME_ADMIN_ENROLLMENT_READY: checks.find((c) => c.name === 'FIRST_TIME_ADMIN_ENROLLMENT').ok,
    ONE_TIME_ACTIVATION_REQUIRED: false,
    OWNER_CHOOSES_PIN_LOCALLY: true,
    ROOT_KEY_ONLY_ADMIN_ACCESS: false,
    ADMIN_PIN_SERVER_AUTHORITATIVE: pass,
    ADMIN_SECOND_FACTOR_REQUIRED: pass,
    PIN_ONLY_ADMIN_AUTHORIZATION: false,
    GENERIC_SIGNER_EXPOSED: false,
    PLAINTEXT_PIN_STORED: false,
    DEPLOYED: false,
    QA_KEYS: 'disposable (generated per run; only in gitignored .dev.vars during the run)',
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`\nADMIN_COSIGN_STAGE1_GATE=${report.status} (${checks.filter((c) => c.ok).length}/${checks.length})`);
  return pass;
}

function cleanup() {
  stopWrangler();
  try {
    fs.rmSync(path.join(SVC_DIR, '.dev.vars'), { force: true });
  } catch (_e) {}
  try {
    fs.rmSync(persistDir, { recursive: true, force: true });
  } catch (_e) {}
}

main()
  .then((ok) => {
    cleanup();
    process.exit(ok ? 0 : 1);
  })
  .catch((e) => {
    console.error('GATE ERROR', e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e);
    cleanup();
    process.exit(2);
  });
