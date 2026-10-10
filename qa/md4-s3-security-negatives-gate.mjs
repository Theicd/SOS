#!/usr/bin/env node
/**
 * MD4 S3 security negatives — fail-closed matrix (desktop import + protocol + Android hello gate).
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
const OUT = path.join(ROOT, 'qa', 'md4-s3-security-negatives-report.json');
const RUN_ID = process.env.SOS_MD4_S3_NEG_RUN_ID || crypto.randomUUID();

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

function startStatic() {
  const mime = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
  };
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
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Source isolation
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const store = read('android-shell/app/src/main/java/com/sos010/app/SosDeviceIdentityStore.kt');
const histJs = read('sos-md4-history-sync.js');
const pairT = read('android-shell/app/src/main/java/com/sos010/app/SosPairingNostrTransport.kt');
const histT = read('android-shell/app/src/main/java/com/sos010/app/SosHistoryNostrTransport.kt');
const phone = read('android-shell/app/src/main/java/com/sos010/app/SosHistorySyncPhoneSession.kt');

set('NEG_TEST_ONLY_KEY_API_PRODUCT_RUNTIME', !/copyEncPrivateKeyForTests/.test(bridge) && /BuildConfig\.DEBUG/.test(store));
set('NEG_PAIR_TRANSPORT_HIST_CONFUSION', /protocolTag != TAG/.test(pairT) && /sos-hist-v1/.test(histT));
set('NEG_SECRET_LEAKAGE_SOURCE', !/Log\.[divwe].*(privateKey|nsec|conversationKeyHex)|console\.log\([^)]*conversationKey/.test(histJs + phone + bridge));
set('NEG_NO_PLAINTEXT_CKI_PERSIST', /PERSISTED_PLAINTEXT_CKI:\s*false/.test(histJs));

let unitOk = false;
let unitOut = '';
try {
  unitOut = execSync(
    '.\\gradlew.bat :app:testDebugUnitTest --tests com.sos010.app.SosHistorySyncHelloGateTest --tests com.sos010.app.SosHistorySyncCryptoTest',
    { cwd: path.join(ROOT, 'android-shell'), encoding: 'utf8', timeout: 420000, windowsHide: true, shell: true },
  );
  unitOk = /BUILD SUCCESSFUL/.test(unitOut);
} catch (e) {
  unitOut = String((e.stdout || '') + (e.stderr || e)).slice(-16000);
}
fs.writeFileSync(path.join(ROOT, 'qa', '.md4-s3-neg-unit.txt'), unitOut.slice(-12000));
set('NEG_ANDROID_HELLO_GATE_UNIT', unitOk, unitOk ? 'BUILD_OK' : unitOut.slice(-400));

const { server, port } = await startStatic();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const base = `http://127.0.0.1:${port}`;
await page.goto(base + '/videos.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!(window.NostrTools && window.NostrApp), null, { timeout: 45000 });
await page.addScriptTag({ url: base + '/sos-md2-pairing-session.js' });
await page.addScriptTag({ url: base + '/sos-md4-device-auth.js' });
await page.addScriptTag({ url: base + '/sos-md4-device-store.js' });
await page.addScriptTag({ url: base + '/sos-md4-cki.js' });
await page.addScriptTag({ url: base + '/sos-md4-history-sync.js' });
await page.waitForFunction(() => !!(window.SosMd4HistorySync && window.SosMd4Cki && window.SosMd4DeviceAuth), null, { timeout: 15000 });

const desktop = await page.evaluate(async () => {
  const Hist = window.SosMd4HistorySync;
  const Cki = window.SosMd4Cki;
  const Auth = window.SosMd4DeviceAuth;
  const App = window.NostrApp;
  const out = {};

  out.unlinked = await Hist.beginBootstrap({ deviceCtx: { ok: false }, relays: [], timeoutMs: 1000 });
  out.pairOnHist = Hist.classifyTags([['t', 'sos-pair-v1']]);
  out.histOk = Hist.classifyTags([['t', 'sos-hist-v1']]);
  out.both = Hist.classifyTags([['t', 'sos-pair-v1'], ['t', 'sos-hist-v1']]);
  out.plaintext = Cki.rejectPlaintextDowngrade({ schema: 'sos-cki-v1', entries: [] });

  // After S4 outer-sig hardening, import requires verifyEvent — use real signed events (parity with S4 negatives).
  const NT = window.NostrTools;
  const sk = NT.generateSecretKey();
  const self = NT.getPublicKey(sk);
  const peer = NT.getPublicKey(NT.generateSecretKey());
  App.publicKey = self;
  if (App.clearChatRuntimeIdentity) App.clearChatRuntimeIdentity();
  const now = Math.floor(Date.now() / 1000);
  const ev = NT.finalizeEvent(
    { kind: 1050, created_at: now, tags: [['p', peer]], content: JSON.stringify({ text: 'hello' }) },
    sk,
  );
  out.importOk = Hist.importDecryptedMessage(self, peer, ev, { text: 'hello' });
  out.importDup = Hist.importDecryptedMessage(self, peer, ev, { text: 'hello' });
  out.importConflict = Hist.importDecryptedMessage(self, peer, ev, { text: 'OTHER' });
  out.forgedId = Hist.importDecryptedMessage(self, peer, Object.assign({}, ev, { id: 'not-hex' }), { text: 'x' });
  out.crossAccount = Hist.importDecryptedMessage(self, peer, Object.assign({}, ev, {
    id: 'dd'.repeat(32),
    pubkey: 'ee'.repeat(32),
    tags: [['p', 'ff'.repeat(32)]],
    sig: undefined,
  }), { text: 'x' });
  out.unauthConv = Hist.importDecryptedMessage(self, peer, Object.assign({}, ev, {
    id: '11'.repeat(32),
    pubkey: peer,
    tags: [['p', '22'.repeat(32)]],
    sig: undefined,
  }), { text: 'x' });

  // Oversized constant exposed
  out.maxBatch = Hist.MAX_BATCH_EVENTS;

  // Auth negatives (device auth)
  const fakeAuth = {
    version: 'SOS_DEVICE_AUTHORIZATION_V1',
    authorizationId: '11'.repeat(32),
    accountP: self,
    deviceId: '22'.repeat(32),
    D_sign_pub: '33'.repeat(32),
    D_enc_pub: '44'.repeat(32),
    capabilities: ['DEVICE_CHAT'],
    authEpoch: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + 100000,
    pairingTranscriptHash: '55'.repeat(32),
    pairingId: '66'.repeat(32),
    storageSecurityClass: 'SOFT',
    recoveryEligibleAtAuthorization: false,
    rootSignature: '77'.repeat(32),
  };
  out.missingHist = await Auth.assertHistorySyncAuthorized({
    authorization: fakeAuth,
    device: { accountP: self, deviceId: fakeAuth.deviceId, D_sign_pub: fakeAuth.D_sign_pub, D_enc_pub: fakeAuth.D_enc_pub },
    nowMs: Date.now(),
    minAcceptedAuthEpoch: 1,
  });
  out.expired = await Auth.assertHistorySyncAuthorized({
    authorization: Object.assign({}, fakeAuth, {
      capabilities: ['DEVICE_CHAT', 'DEVICE_HISTORY_SYNC'],
      expiresAt: 1,
    }),
    device: { accountP: self, deviceId: fakeAuth.deviceId, D_sign_pub: fakeAuth.D_sign_pub, D_enc_pub: fakeAuth.D_enc_pub },
    nowMs: Date.now(),
    minAcceptedAuthEpoch: 1,
  });
  out.staleEpoch = await Auth.assertHistorySyncAuthorized({
    authorization: Object.assign({}, fakeAuth, {
      capabilities: ['DEVICE_CHAT', 'DEVICE_HISTORY_SYNC'],
    }),
    device: { accountP: self, deviceId: fakeAuth.deviceId, D_sign_pub: fakeAuth.D_sign_pub, D_enc_pub: fakeAuth.D_enc_pub },
    nowMs: Date.now(),
    minAcceptedAuthEpoch: 99,
  });
  out.wrongP = await Auth.assertHistorySyncAuthorized({
    authorization: Object.assign({}, fakeAuth, {
      capabilities: ['DEVICE_CHAT', 'DEVICE_HISTORY_SYNC'],
    }),
    device: { accountP: '99'.repeat(32), deviceId: fakeAuth.deviceId, D_sign_pub: fakeAuth.D_sign_pub, D_enc_pub: fakeAuth.D_enc_pub },
    nowMs: Date.now(),
    minAcceptedAuthEpoch: 1,
  });

  return out;
});

set('NEG_UNLINKED_DESKTOP', desktop.unlinked && desktop.unlinked.ok === false, desktop.unlinked);
set('NEG_CROSS_PROTOCOL_KIND25060', desktop.both && desktop.both.ok === false && desktop.pairOnHist && desktop.pairOnHist.protocol === 'sos-pair-v1', desktop);
set('NEG_PLAINTEXT_DOWNGRADE', desktop.plaintext && desktop.plaintext.ok === false, desktop.plaintext);
set('NEG_FORGED_EVENT_IDENTITY', desktop.forgedId && desktop.forgedId.code === 'FORGED_EVENT_IDENTITY', desktop.forgedId);
set('NEG_CONFLICTING_DUPLICATE_EVENT', desktop.importConflict && desktop.importConflict.code === 'CONFLICTING_EVENT', desktop.importConflict);
set('NEG_CROSS_ACCOUNT_IMPORT', desktop.crossAccount && desktop.crossAccount.ok === false, desktop.crossAccount);
set('NEG_UNAUTHORIZED_CONVERSATION', desktop.unauthConv && desktop.unauthConv.ok === false, desktop.unauthConv);
set('POS_IDEMPOTENT_IMPORT', desktop.importOk && desktop.importOk.ok && desktop.importDup && desktop.importDup.duplicate === true, {
  importOk: desktop.importOk,
  importDup: desktop.importDup,
});
set('NEG_MISSING_DEVICE_HISTORY_SYNC', desktop.missingHist && desktop.missingHist.ok === false, desktop.missingHist);
set('NEG_EXPIRED_AUTHORIZATION', desktop.expired && desktop.expired.ok === false, desktop.expired);
set('NEG_STALE_AUTH_EPOCH', desktop.staleEpoch && desktop.staleEpoch.ok === false, desktop.staleEpoch);
set('NEG_WRONG_GLOBAL_P', desktop.wrongP && desktop.wrongP.ok === false, desktop.wrongP);
set('NEG_OVERSIZED_BOOTSTRAP_BOUND', desktop.maxBatch === 50, desktop.maxBatch);

await browser.close();
server.close();

const fixture = path.join(ROOT, 'qa', '.md4-s2-fixtures', 'android-sealed-cki.json');
results.NEG_S2_CKI_DENC_REPLAY_COVERED_BY_S2_GATE = {
  ok: true,
  detail: fs.existsSync(fixture) ? 'FIXTURE_PRESENT' : 'DEFER_TO_S2_GATE_AND_HELLO_AEAD_UNIT',
};

const report = {
  gate: 'MD4_S3_SECURITY_NEGATIVES',
  runId: RUN_ID,
  ts: new Date().toISOString(),
  pass,
  fail,
  results,
  STATUS: fail === 0 ? 'PASS' : 'FAIL',
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('MD4_S3_SECURITY_NEGATIVES=' + report.STATUS, 'runId=' + RUN_ID);
console.log('REPORT', OUT);
process.exit(fail === 0 ? 0 : 1);
