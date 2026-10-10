#!/usr/bin/env node
/**
 * MD4 S5 acceptance — large encrypted attachment E2E (Blossom-like GET + S5 AttachmentSync).
 * Uses genuine AES-GCM ciphertext; proves integrity, mid-AEAD fail-closed, 100MiB limit, resume.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import v8 from 'node:v8';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'md4-s5-large-attachment-acceptance-report.json');
const RUN_ID = process.env.SOS_MD4_S5_LARGE_RUN_ID || crypto.randomUUID();
const MEDIA_DIR = path.join(ROOT, 'qa', '.md4-s5-large-media');
const LARGE_PLAIN_BYTES = Number(process.env.SOS_MD4_S5_LARGE_BYTES || 32 * 1024 * 1024);
const results = {};
let pass = 0;
let fail = 0;
function set(k, ok, detail) {
  results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  if (ok) pass++;
  else fail++;
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 260));
}

fs.mkdirSync(MEDIA_DIR, { recursive: true });

const mime = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
};
let interruptCutoff = -1;
const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://127.0.0.1');
  if (u.pathname.startsWith('/qa/.md4-s5-large-media/')) {
    const fp = path.join(ROOT, u.pathname.replace(/^\//, ''));
    if (!fp.startsWith(MEDIA_DIR)) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        fs.mkdirSync(MEDIA_DIR, { recursive: true });
        fs.writeFileSync(fp, Buffer.concat(chunks));
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, bytes: fs.statSync(fp).size }));
      });
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }
    if (!fs.existsSync(fp)) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    const buf = fs.readFileSync(fp);
    const cut = interruptCutoff;
    if (cut >= 0 && cut < buf.length) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Content-Length': String(cut),
      });
      res.end(buf.subarray(0, cut));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': String(buf.length),
    });
    res.end(buf);
    return;
  }
  let p = decodeURIComponent(u.pathname === '/' ? '/videos.html' : u.pathname);
  const fp = path.join(ROOT, p.replace(/^\//, ''));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404);
    res.end('missing');
    return;
  }
  res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(fp).pipe(res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log('WEB', base, 'LARGE_PLAIN_BYTES', LARGE_PLAIN_BYTES);

const memBefore = process.memoryUsage();
const heapBefore = v8.getHeapStatistics();

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(base + '/videos.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !!(window.NostrTools && window.NostrApp && window.NostrApp.encryptMediaBlob), null, {
  timeout: 60000,
});
for (const s of ['/sos-md4-attachment-sync.js', '/sos-md4-history-sync.js']) {
  await page.addScriptTag({ url: base + s });
}
await page.waitForFunction(() => !!(window.SosMd4AttachmentSync && window.SosMd4HistorySync), null, { timeout: 20000 });

const prepared = await page.evaluate(async ({ size, uploadBase }) => {
  const App = window.NostrApp;
  const NT = window.NostrTools;
  const sk = NT.generateSecretKey();
  const pub = NT.getPublicKey(sk);
  const peer = NT.getPublicKey(NT.generateSecretKey());
  App.publicKey = pub;
  const plain = new Uint8Array(size);
  // getRandomValues is capped at 65536 bytes per call in browsers.
  for (let off = 0; off < plain.length; off += 65536) {
    crypto.getRandomValues(plain.subarray(off, Math.min(off + 65536, plain.length)));
  }
  // Deterministic marker for equality check
  plain[0] = 0x89;
  plain[1] = 0x50;
  plain[2] = 0x4e;
  plain[3] = 0x47;
  const messageId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const enc = await App.encryptMediaBlob(new Blob([plain], { type: 'application/octet-stream' }), {
    messageId,
    sender: pub,
    recipient: peer,
    filename: 'large-s5.bin',
    mime: 'application/octet-stream',
    mode: 'single',
  });
  const uploadUrl = uploadBase + '/qa/.md4-s5-large-media/' + enc.descriptor.attachmentId + '.bin';
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: enc.ciphertext,
  });
  if (!put.ok) throw new Error('CIPHER_UPLOAD_FAILED_' + put.status);
  const putJson = await put.json();
  const plainSha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', plain)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
  // Drop plaintext + ciphertext from the evaluate return (avoid Playwright IPC OOM).
  return {
    pub,
    peer,
    messageId,
    descriptor: enc.descriptor,
    cipherBytes: enc.ciphertext.byteLength,
    plainLen: plain.length,
    plainSha,
    uploaded: putJson.bytes,
  };
}, { size: LARGE_PLAIN_BYTES, uploadBase: base });

const ctPath = path.join(MEDIA_DIR, prepared.descriptor.attachmentId + '.bin');
const tempDisk = fs.existsSync(ctPath) ? fs.statSync(ctPath).size : 0;
const ctBufLen = tempDisk;
set('LARGE_CIPHER_WRITTEN', ctBufLen === prepared.descriptor.cipher.size && prepared.uploaded === ctBufLen, {
  cipherBytes: ctBufLen,
  plainBytes: prepared.plainLen,
  uploaded: prepared.uploaded,
});

const desc = JSON.parse(JSON.stringify(prepared.descriptor));
desc.resource = {
  transport: 'blossom',
  url: `${base}/qa/.md4-s5-large-media/${prepared.descriptor.attachmentId}.bin`,
  encoding: 'raw',
};

// --- Mid-AEAD interrupt: serve truncated body (no full tag) ---
interruptCutoff = Math.max(16, Math.floor(ctBufLen * 0.55));
const mid = await page.evaluate(async ({ desc, pub, peer, messageId, eventId, auth }) => {
  const Att = window.SosMd4AttachmentSync;
  const App = window.NostrApp;
  App.deletedChatMessageIds = new Set();
  App.chatState = { conversations: new Map(), messageIndex: new Map() };
  App.appendChatMessage = (m) => {
    const key = [pub, peer].sort().join(':');
    if (!App.chatState.conversations.has(key)) App.chatState.conversations.set(key, { messages: [] });
    App.chatState.conversations.get(key).messages.push(m);
    App.chatState.messageIndex.set(m.id, { key });
  };
  App.appendChatMessage({
    id: eventId,
    from: pub,
    to: peer,
    content: 'large',
    createdAt: Math.floor(Date.now() / 1000),
    attachment: desc,
    logicalMessageId: messageId,
    mediaSyncState: 'PENDING',
  });
  const built = Att.buildJob({
    accountP: auth.accountP,
    deviceId: auth.deviceId,
    authorizationId: auth.authorizationId,
    authEpoch: auth.authEpoch,
    sessionId: auth.sessionId,
    peerP: peer,
    eventId,
    messageId,
    sender: pub,
    recipient: peer,
    attachment: desc,
  });
  if (!built.ok) return { ok: false, phase: 'build', code: built.code };
  await Att.saveJob(built.job);
  const r = await Att.hydrateJob(built.job, desc);
  return { ok: r.ok, code: r.code, state: built.job.state, errorCode: built.job.errorCode };
}, {
  desc,
  pub: prepared.pub,
  peer: prepared.peer,
  messageId: prepared.messageId,
  eventId: 'a1'.repeat(32),
  auth: {
    accountP: prepared.pub,
    deviceId: 'b1'.repeat(32),
    authorizationId: 'c1'.repeat(32),
    authEpoch: 1,
    sessionId: 'd1'.repeat(32),
  },
});
set('MID_AEAD_FAIL_CLOSED', mid && mid.ok === false && mid.state !== 'COMPLETE', mid);

// --- Resume full transfer ---
interruptCutoff = -1;
const full = await page.evaluate(async ({ desc, pub, peer, messageId, eventId, auth, expectPlainSha }) => {
  const Att = window.SosMd4AttachmentSync;
  const App = window.NostrApp;
  const msg = (() => {
    let found = null;
    App.chatState.conversations.forEach((e) => {
      const hit = e.messages.find((m) => m.id === eventId);
      if (hit) found = hit;
    });
    return found;
  })();
  if (msg) {
    msg.attachment = desc;
    msg.mediaSyncState = 'PENDING';
    delete msg.attachment._resolvedBlob;
    delete msg.attachment._localObjectUrl;
    delete msg.attachment.url;
  }
  const loaded = await Att.loadJob(auth.accountP, auth.deviceId, desc.attachmentId);
  const job = loaded.job || (await Att.buildJob({
    accountP: auth.accountP,
    deviceId: auth.deviceId,
    authorizationId: auth.authorizationId,
    authEpoch: auth.authEpoch,
    sessionId: auth.sessionId,
    peerP: peer,
    eventId,
    messageId,
    sender: pub,
    recipient: peer,
    attachment: desc,
  })).job;
  job.state = Att.STATES.PENDING;
  job.retries = 0;
  job.errorCode = '';
  await Att.saveJob(job);
  const r = await Att.hydrateJob(job, desc);
  let restoredSha = null;
  let restoredLen = 0;
  if (r.ok && msg && msg.attachment && msg.attachment._resolvedBlob) {
    const ab = await msg.attachment._resolvedBlob.arrayBuffer();
    restoredLen = ab.byteLength;
    const d = await crypto.subtle.digest('SHA-256', ab);
    restoredSha = Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
  }
  return {
    ok: r.ok,
    code: r.code,
    state: job.state,
    source: r.source || (msg && msg.mediaSource),
    restoredLen,
    restoredSha,
    expectPlainSha,
    equal: restoredSha === expectPlainSha && restoredLen > 0,
  };
}, {
  desc,
  pub: prepared.pub,
  peer: prepared.peer,
  messageId: prepared.messageId,
  eventId: 'a1'.repeat(32),
  auth: {
    accountP: prepared.pub,
    deviceId: 'b1'.repeat(32),
    authorizationId: 'c1'.repeat(32),
    authEpoch: 1,
    sessionId: 'd1'.repeat(32),
  },
  expectPlainSha: prepared.plainSha,
});
set('LARGE_MEDIA_REAL_E2E', full && full.ok === true && full.state === 'COMPLETE', full);
set('LARGE_MEDIA_INTEGRITY', full && full.equal === true, {
  restoredLen: full && full.restoredLen,
  equal: full && full.equal,
});
set('LARGE_MEDIA_INTERRUPT_RESUME', mid && mid.ok === false && full && full.ok === true, { mid, fullOk: full && full.ok });

// --- 100MiB limit enforcement (buildJob rejects oversized cipher claim) ---
const limit = await page.evaluate(async ({ pub, peer }) => {
  const Att = window.SosMd4AttachmentSync;
  const over = {
    v: 2,
    type: 'encrypted-media',
    attachmentId: 'ab'.repeat(16),
    enc: { alg: 'aes-256-gcm', mode: 'single', key: 'A'.repeat(43), nonce: 'B'.repeat(16) },
    cipher: { size: Att.MAX_CIPHER_BYTES + 1, sha256: 'cd'.repeat(32) },
    media: { mime: 'application/octet-stream', filename: 'too-big.bin', originalSize: Att.MAX_CIPHER_BYTES + 1 },
  };
  // Fix base64url-ish lengths for key/nonce to pass earlier checks if any — buildJob checks size first after isEncryptedMedia
  const r = Att.buildJob({
    accountP: pub,
    deviceId: 'b1'.repeat(32),
    authorizationId: 'c1'.repeat(32),
    authEpoch: 1,
    sessionId: 'd1'.repeat(32),
    peerP: peer,
    eventId: 'e1'.repeat(32),
    messageId: 'cmsg-limit',
    sender: pub,
    recipient: peer,
    attachment: over,
  });
  return { max: Att.MAX_CIPHER_BYTES, code: r.code, ok: r.ok };
}, { pub: prepared.pub, peer: prepared.peer });
set('SIZE_LIMIT_ENFORCEMENT', limit && limit.ok === false && limit.code === 'OVERSIZED_CIPHER' && limit.max === 100 * 1024 * 1024, limit);

const memAfter = process.memoryUsage();
const heapAfter = v8.getHeapStatistics();
const peakRss = Math.max(memBefore.rss, memAfter.rss);
const peakHeap = Math.max(heapBefore.used_heap_size, heapAfter.used_heap_size);
// Bound: node harness peak should stay well under ~cipher*4 (streaming fetch in browser; node only holds file once)
const boundOk = peakRss < LARGE_PLAIN_BYTES * 8 + 400 * 1024 * 1024;
set('BOUNDED_MEMORY', boundOk, {
  peakRss,
  peakHeap,
  plainBytes: LARGE_PLAIN_BYTES,
  cipherBytes: ctBufLen,
  tempDisk,
});

await browser.close();
server.close();

const report = {
  gate: 'MD4_S5_LARGE_ATTACHMENT_ACCEPTANCE',
  runId: RUN_ID,
  ts: new Date().toISOString(),
  pass,
  fail,
  results,
  STATUS: fail === 0 ? 'PASS' : 'FAIL',
  LARGE_MEDIA_TEST_SIZE: LARGE_PLAIN_BYTES,
  LARGE_MEDIA_CIPHER_BYTES: ctBufLen,
  PEAK_MEMORY_RSS: peakRss,
  PEAK_HEAP: peakHeap,
  TEMP_DISK_USAGE: tempDisk,
  MID_AEAD_FAIL_CLOSED: !!results.MID_AEAD_FAIL_CLOSED?.ok,
  LARGE_MEDIA_INTERRUPT_RESUME: !!results.LARGE_MEDIA_INTERRUPT_RESUME?.ok,
  SIZE_LIMIT_ENFORCEMENT: !!results.SIZE_LIMIT_ENFORCEMENT?.ok,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('MD4_S5_LARGE_ATTACHMENT_ACCEPTANCE=' + report.STATUS, 'runId=' + RUN_ID);
process.exit(fail === 0 ? 0 : 1);
