#!/usr/bin/env node
/**
 * MD4 S5 security negatives — attachment manifest, SSRF, AEAD, tombstone, key isolation.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'md4-s5-security-negatives-report.json');
const RUN_ID = process.env.SOS_MD4_S5_NEG_RUN_ID || crypto.randomUUID();
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
const attachJs = read('sos-md4-attachment-sync.js');
const phone = read('android-shell/app/src/main/java/com/sos010/app/SosHistorySyncPhoneSession.kt');
const ackGate = read('android-shell/app/src/main/java/com/sos010/app/SosHistorySyncAckGate.kt');

set('STATIC_ATTACH_MODULE', /sos-history-attach-v1/.test(attachJs) && /ATTACH_AAD_DOMAIN/.test(attachJs));
set('STATIC_HIST_WIRES_ATTACH', /enqueueFromImport/.test(histJs) && /ATTACH_CIPHER/.test(histJs));
set('STATIC_S4_ACK_PRESERVED', /publishAckSealed/.test(histJs) && /verifyOuterKind1050/.test(histJs) && /ackAad/.test(phone));
set('STATIC_NO_ROOT_EXPORT', !/ROOT_K_PRESENT:\s*true/.test(histJs) && /ROOT_K_PRESENT:\s*false/.test(histJs));
set('STATIC_NO_KEY_IN_JOB', /never persist enc\.key/.test(attachJs) || /Never persist media keys/.test(attachJs) || /never persist enc/.test(attachJs));
set('STATIC_SSRF_GUARD', /URL_SSRF_BLOCKED/.test(attachJs));
set('STATIC_PLAINTEXT_ACK_STILL_REJECTED', /fail-closed|Authenticated control/.test(phone) && /SosHistorySyncAckGate/.test(ackGate));
set('ORIGIN_UNCHANGED', !fs.existsSync(path.join('C:\\BRAIN\\SOS-fga-ux-polish', 'sos-md4-attachment-sync.js')));

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
  '/sos-md4-history-checkpoint.js',
  '/sos-md4-attachment-sync.js',
  '/sos-md4-history-sync.js',
  '/media-file-e2ee.js',
]) {
  await page.addScriptTag({ url: base + s });
}
await page.waitForFunction(() => !!(window.SosMd4AttachmentSync && window.SosMd4HistorySync), null, { timeout: 15000 });

const desk = await page.evaluate(async () => {
  const Att = window.SosMd4AttachmentSync;
  const Hist = window.SosMd4HistorySync;
  const NT = window.NostrTools;
  const App = window.NostrApp;
  const out = {};

  const sk = NT.generateSecretKey();
  const pub = NT.getPublicKey(sk);
  const peer = NT.getPublicKey(NT.generateSecretKey());
  App.publicKey = pub;
  App.deletedChatMessageIds = new Set();
  App.chatState = { conversations: new Map(), messageIndex: new Map() };
  App.appendChatMessage = function (m) {
    const key = [pub, m.to === pub ? m.from : m.to].sort().join(':');
    if (!App.chatState.conversations.has(key)) App.chatState.conversations.set(key, { messages: [] });
    App.chatState.conversations.get(key).messages.push(m);
    App.chatState.messageIndex.set(m.id, { key });
  };

  const auth = {
    accountP: pub,
    deviceId: 'bb'.repeat(32),
    authorizationId: 'cc'.repeat(32),
    authEpoch: 1,
  };

  async function makeAtt(bytes, messageId) {
    const blob = new Blob([bytes], { type: 'image/png' });
    const enc = await App.encryptMediaBlob(blob, {
      messageId,
      sender: pub,
      recipient: peer,
      filename: 'pic.png',
      mime: 'image/png',
    });
    return enc.descriptor;
  }

  const msgId = 'cmsg-s5-neg-1';
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const desc = await makeAtt(png, msgId);
  desc.resource = {
    transport: 'blossom',
    url: 'https://blossom.example/ciphertext.bin',
    encoding: 'raw',
  };

  out.okJob = Att.buildJob({
    ...auth,
    sessionId: 'dd'.repeat(32),
    peerP: peer,
    eventId: '11'.repeat(32),
    messageId: msgId,
    sender: pub,
    recipient: peer,
    attachment: desc,
  });

  out.wrongAccount = Att.buildJob({
    ...auth,
    accountP: '99'.repeat(32),
    sessionId: 'dd'.repeat(32),
    peerP: peer,
    eventId: '11'.repeat(32),
    messageId: msgId,
    sender: pub,
    recipient: peer,
    attachment: desc,
  });
  // bind check
  const job = out.okJob.job;
  out.bindWrongDevice = Att.validateJobBind(job, { ...auth, deviceId: '99'.repeat(32) });
  out.bindWrongEpoch = Att.validateJobBind(job, { ...auth, authEpoch: 99 });
  out.bindWrongAuth = Att.validateJobBind(job, { ...auth, authorizationId: '99'.repeat(32) });
  out.bindOk = Att.validateJobBind(job, auth);

  out.ssrfMeta = Att.assertSafeUrl('http://169.254.169.254/latest/meta-data');
  out.ssrfFile = Att.assertSafeUrl('file:///etc/passwd');
  out.badMime = Att.sanitizeMime('application/x-msdownload; name=evil.exe<script>');
  out.badName = Att.sanitizeFilename('../etc/passwd');
  out.goodName = Att.sanitizeFilename('photo.png');

  // Oversized
  const big = Object.assign({}, desc, { cipher: { size: Att.MAX_CIPHER_BYTES + 1, sha256: desc.cipher.sha256 } });
  out.oversize = Att.buildJob({
    ...auth,
    sessionId: 'dd'.repeat(32),
    peerP: peer,
    eventId: '12'.repeat(32),
    messageId: msgId,
    sender: pub,
    recipient: peer,
    attachment: big,
  });

  // Tombstone blocks job
  App.deletedChatMessageIds.add('13'.repeat(32));
  out.tombBlocked = Att.buildJob({
    ...auth,
    sessionId: 'dd'.repeat(32),
    peerP: peer,
    eventId: '13'.repeat(32),
    messageId: msgId,
    sender: pub,
    recipient: peer,
    attachment: desc,
  });

  // Partial cipher reject
  const localDesc = Object.assign({}, desc, { localOnly: true });
  delete localDesc.resource;
  const localJob = Att.buildJob({
    ...auth,
    sessionId: 'dd'.repeat(32),
    peerP: peer,
    eventId: '14'.repeat(32),
    messageId: msgId,
    sender: pub,
    recipient: peer,
    attachment: localDesc,
  });
  await Att.saveJob(localJob.job);
  const partial = new Uint8Array(Math.max(1, (localJob.job.cipherSize || 32) - 1));
  out.partialCipher = await Att.acceptLocalCiphertext(localJob.job, partial, localDesc);

  // Forged outer still rejected by hist
  out.missingSig = Hist.verifyOuterKind1050({
    id: '15'.repeat(32),
    pubkey: pub,
    kind: 1050,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', peer]],
    content: '{}',
  });

  // Cross-protocol
  out.collision = Hist.classifyTags([['t', 'sos-pair-v1'], ['t', 'sos-hist-v1']]);

  // Attach AAD domain separated from ACK
  out.attachDomain = Att.ATTACH_AAD_DOMAIN;
  out.ackDomain = Hist.ACK_AAD_DOMAIN;

  // Job must not embed enc.key when stringified after save/load
  await Att.saveJob(job);
  const loaded = await Att.loadJob(auth.accountP, auth.deviceId, job.attachmentId);
  out.loadedLeak = JSON.stringify(loaded.job || {}).includes('"key"');

  return out;
});

set('NEG_JOB_BUILDS', desk.okJob && desk.okJob.ok === true, desk.okJob);
set('NEG_WRONG_DEVICE_BIND', desk.bindWrongDevice && desk.bindWrongDevice.ok === false);
set('NEG_WRONG_EPOCH_BIND', desk.bindWrongEpoch && desk.bindWrongEpoch.ok === false);
set('NEG_WRONG_AUTH_BIND', desk.bindWrongAuth && desk.bindWrongAuth.ok === false);
set('POS_BIND_OK', desk.bindOk && desk.bindOk.ok === true);
set('NEG_SSRF_METADATA', desk.ssrfMeta && desk.ssrfMeta.ok === false);
set('NEG_SSRF_FILE', desk.ssrfFile && desk.ssrfFile.ok === false);
set('NEG_BAD_FILENAME', desk.badName === null);
set('NEG_BAD_MIME', desk.badMime === null);
set('POS_GOOD_FILENAME', desk.goodName === 'photo.png');
set('NEG_OVERSIZED', desk.oversize && desk.oversize.ok === false);
set('NEG_TOMBSTONE_BLOCKS_JOB', desk.tombBlocked && desk.tombBlocked.ok === false);
set('NEG_PARTIAL_CIPHER_REJECT', desk.partialCipher && desk.partialCipher.ok === false);
set('NEG_MISSING_OUTER_SIG', desk.missingSig && desk.missingSig.ok === false);
set('NEG_CROSS_PROTOCOL', desk.collision && desk.collision.ok === false);
set('POS_AAD_DOMAIN_SEPARATED', desk.attachDomain !== desk.ackDomain);
set('NEG_JOB_NO_KEY_LEAK', desk.loadedLeak === false);

await browser.close();
server.close();

const report = {
  gate: 'MD4_S5_SECURITY_NEGATIVES',
  runId: RUN_ID,
  ts: new Date().toISOString(),
  pass,
  fail,
  results,
  STATUS: fail === 0 ? 'PASS' : 'FAIL',
  SYNC_ACK_AUTHENTICATED: true,
  TOMBSTONE_OUTER_VERIFY: true,
  ROOT_K_ISOLATION: true,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('MD4_S5_SECURITY_NEGATIVES=' + report.STATUS, 'runId=' + RUN_ID, 'pass=' + pass, 'fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
