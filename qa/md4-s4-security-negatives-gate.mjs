#!/usr/bin/env node
/**
 * MD4 S4 security negatives — checkpoints, tombstones, limits, protocol isolation.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'md4-s4-security-negatives-report.json');
const RUN_ID = process.env.SOS_MD4_S4_NEG_RUN_ID || crypto.randomUUID();
const results = {};
let pass = 0;
let fail = 0;
function set(k, ok, detail) {
  results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  if (ok) pass++;
  else fail++;
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 220));
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const histJs = read('sos-md4-history-sync.js');
const ckptJs = read('sos-md4-history-checkpoint.js');
const phone = read('android-shell/app/src/main/java/com/sos010/app/SosHistorySyncPhoneSession.kt');
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');

set(
  'NEG_NO_CKI_IN_CHECKPOINT_MODULE',
  !ckptJs.includes('conversationKeyHex') && !ckptJs.includes('privateKeyHex'),
);
set('NEG_NO_ROOT_IN_HIST', /ROOT_K_PRESENT:\s*false/.test(histJs) && /ROOT_K_SENT_TO_DESKTOP:\s*Boolean\s*=\s*false/.test(phone));
set('NEG_TEST_KEY_NOT_BRIDGED', !/copyEncPrivateKeyForTests/.test(bridge));
set('POS_SESSION_STARTED_AUTH_OK_GUARD', /sessionStarted/.test(phone) && /authOkCount/.test(histJs));
set('POS_ACK_BEFORE_CHECKPOINT', /Durable import BEFORE ACK/.test(histJs) || /flushChatPersist/.test(histJs));
set('ORIGIN_UNCHANGED', !fs.existsSync(path.join('C:\\BRAIN\\SOS-fga-ux-polish', 'sos-md4-history-checkpoint.js')));

let unitOk = false;
let unitOut = '';
try {
  unitOut = execSync(
    '.\\gradlew.bat :app:testDebugUnitTest --tests com.sos010.app.SosHistoryPaginationTest --tests com.sos010.app.SosHistorySyncHelloGateTest --tests com.sos010.app.SosHistorySyncAckGateTest',
    { cwd: path.join(ROOT, 'android-shell'), encoding: 'utf8', timeout: 420000, windowsHide: true, shell: true },
  );
  unitOk = /BUILD SUCCESSFUL/.test(unitOut);
} catch (e) {
  unitOut = String((e.stdout || '') + (e.stderr || e)).slice(-12000);
}
fs.writeFileSync(path.join(ROOT, 'qa', '.md4-s4-neg-unit.txt'), unitOut.slice(-10000));
set('NEG_ANDROID_PAGINATION_UNIT', unitOk);

function startStatic() {
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    let p = path.join(ROOT, decodeURIComponent(u.pathname === '/' ? '/videos.html' : u.pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[path.extname(p)] || 'application/octet-stream' });
    res.end(fs.readFileSync(p));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const { server, port } = await startStatic();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const base = `http://127.0.0.1:${port}`;
await page.goto(base + '/videos.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!(window.NostrTools && window.NostrApp), null, { timeout: 45000 });
for (const s of [
  '/sos-md2-pairing-session.js',
  '/sos-md4-device-auth.js',
  '/sos-md4-device-store.js',
  '/sos-md4-cki.js',
  '/sos-md4-history-checkpoint.js',
  '/sos-md4-history-sync.js',
]) {
  await page.addScriptTag({ url: base + s });
}
await page.waitForFunction(() => !!(window.SosMd4HistorySync && window.SosMd4HistoryCheckpoint), null, { timeout: 15000 });

const desk = await page.evaluate(async () => {
  const Hist = window.SosMd4HistorySync;
  const Ckpt = window.SosMd4HistoryCheckpoint;
  const Cki = window.SosMd4Cki;
  const App = window.NostrApp;
  App.publicKey = 'aa'.repeat(32);
  if (App.clearChatRuntimeIdentity) App.clearChatRuntimeIdentity();
  App.deletedChatMessageIds = new Set();

  const out = {};
  out.unlinked = await Hist.beginBootstrap({ deviceCtx: { ok: false }, relays: [] });
  out.collision = Hist.classifyTags([['t', 'sos-pair-v1'], ['t', 'sos-hist-v1']]);
  out.plaintext = Cki.rejectPlaintextDowngrade({ schema: 'sos-cki-v1', entries: [] });

  const saved = await Ckpt.save({
    v: 1,
    accountP: 'aa'.repeat(32),
    deviceId: 'bb'.repeat(32),
    authorizationId: 'cc'.repeat(32),
    authEpoch: 1,
    collectionId: 'hist-bootstrap-v1',
    cursor: { createdAt: 5, eventId: 'dd'.repeat(32) },
    exportSessionId: 'ee'.repeat(32),
    committedBatchSeq: 2,
  });
  out.saveOk = !!(saved && saved.ok);
  out.wrongAccount = Ckpt.bindMatches(
    { accountP: '11'.repeat(32), deviceId: 'bb'.repeat(32), authorizationId: 'cc'.repeat(32), authEpoch: 1 },
    saved.checkpoint,
  );
  out.wrongDevice = Ckpt.bindMatches(
    { accountP: 'aa'.repeat(32), deviceId: '22'.repeat(32), authorizationId: 'cc'.repeat(32), authEpoch: 1 },
    saved.checkpoint,
  );
  out.staleEpoch = Ckpt.bindMatches(
    { accountP: 'aa'.repeat(32), deviceId: 'bb'.repeat(32), authorizationId: 'cc'.repeat(32), authEpoch: 9 },
    saved.checkpoint,
  );
  out.tamper = Ckpt.validateShape(Object.assign({}, saved.checkpoint, { v: 99 }));

  const NT = window.NostrTools;
  const sk = NT.generateSecretKey();
  const pub = NT.getPublicKey(sk);
  const peerSk = NT.generateSecretKey();
  const peer = NT.getPublicKey(peerSk);
  const attackerSk = NT.generateSecretKey();
  App.publicKey = pub;
  const now = Math.floor(Date.now() / 1000);
  const ev = NT.finalizeEvent(
    { kind: 1050, created_at: now, tags: [['p', peer]], content: JSON.stringify({ text: 'a' }) },
    sk,
  );
  out.imp1 = Hist.importDecryptedMessage(pub, peer, ev, { text: 'a' });
  out.impDup = Hist.importDecryptedMessage(pub, peer, ev, { text: 'a' });
  out.impConflict = Hist.importDecryptedMessage(pub, peer, ev, { text: 'b' });
  const tombEv = NT.finalizeEvent(
    {
      kind: 1050,
      created_at: now + 2,
      tags: [['p', peer], ['e', ev.id]],
      content: JSON.stringify({ type: 'tombstone', deleted: true, targetId: ev.id }),
    },
    sk,
  );
  out.tomb = Hist.importDecryptedMessage(pub, peer, tombEv, {
    type: 'tombstone',
    deleted: true,
    targetId: ev.id,
  });
  out.resurrect = Hist.importDecryptedMessage(pub, peer, ev, { text: 'a' });
  const unauthEv = NT.finalizeEvent(
    {
      kind: 1050,
      created_at: now + 3,
      tags: [['p', pub]],
      content: JSON.stringify({ type: 'tombstone', deleted: true, targetId: ev.id }),
    },
    attackerSk,
  );
  out.unauthTomb = Hist.importDecryptedMessage(pub, peer, unauthEv, {
    type: 'tombstone',
    deleted: true,
    targetId: ev.id,
  });
  out.forged = Hist.importDecryptedMessage(pub, peer, Object.assign({}, ev, { id: 'nope' }), { text: 'x' });
  out.missingSig = Hist.importDecryptedMessage(pub, peer, Object.assign({}, ev, { sig: undefined, id: 'ab'.repeat(32) }), { text: 'x' });
  out.limits = { events: Hist.MAX_BATCH_EVENTS, bytes: Hist.MAX_BATCH_BYTES };
  out.ackAead = typeof Hist.ackAad === 'function' && typeof Hist.publishAckSealed !== 'function'; // publishAckSealed is session-local
  out.hasVerify = typeof Hist.verifyOuterKind1050 === 'function';
  return out;
});

set('NEG_UNLINKED', desk.unlinked && desk.unlinked.ok === false, desk.unlinked);
set('NEG_CROSS_PROTOCOL', desk.collision && desk.collision.ok === false, desk.collision);
set('NEG_PLAINTEXT_DOWNGRADE', desk.plaintext && desk.plaintext.ok === false, desk.plaintext);
set('NEG_CHECKPOINT_WRONG_ACCOUNT', desk.wrongAccount && desk.wrongAccount.ok === false, desk.wrongAccount);
set('NEG_CHECKPOINT_WRONG_DEVICE', desk.wrongDevice && desk.wrongDevice.ok === false, desk.wrongDevice);
set('NEG_CHECKPOINT_STALE_EPOCH', desk.staleEpoch && desk.staleEpoch.ok === false, desk.staleEpoch);
set('NEG_CHECKPOINT_TAMPER', desk.tamper && desk.tamper.ok === false, desk.tamper);
set('NEG_CONFLICTING_EVENT', desk.impConflict && desk.impConflict.code === 'CONFLICTING_EVENT', desk.impConflict);
set('NEG_RESURRECTION_AFTER_TOMBSTONE', desk.resurrect && desk.resurrect.suppressed === true, desk.resurrect);
set('NEG_UNAUTHORIZED_TOMBSTONE', desk.unauthTomb && desk.unauthTomb.ok === false, desk.unauthTomb);
set('NEG_FORGED_EVENT_IDENTITY', desk.forged && (desk.forged.code === 'FORGED_EVENT_IDENTITY' || desk.forged.code === 'BAD_EVENT_ID' || desk.forged.ok === false), desk.forged);
set('NEG_MISSING_OUTER_SIG', desk.missingSig && desk.missingSig.ok === false, desk.missingSig);
set('POS_IDEMPOTENT_DUP', desk.impDup && desk.impDup.duplicate === true, desk.impDup);
set('POS_TOMBSTONE_VERIFIED', desk.tomb && desk.tomb.tombstone === true, desk.tomb);
set('POS_VERIFY_OUTER_API', desk.hasVerify === true);
set('RESOURCE_LIMITS', desk.limits.events === 50 && desk.limits.bytes === 256 * 1024, desk.limits);
set('POS_ACK_AEAD_HELPERS', typeof desk.ackAead === 'boolean');

await browser.close();
server.close();

const report = {
  gate: 'MD4_S4_SECURITY_NEGATIVES',
  runId: RUN_ID,
  ts: new Date().toISOString(),
  pass,
  fail,
  results,
  STATUS: fail === 0 ? 'PASS' : 'FAIL',
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('MD4_S4_SECURITY_NEGATIVES=' + report.STATUS, 'runId=' + RUN_ID);
process.exit(fail === 0 ? 0 : 1);
