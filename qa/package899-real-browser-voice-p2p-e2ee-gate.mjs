#!/usr/bin/env node
/**
 * Package 899 — REAL visible Chromium (two contexts): voice messages with application-level E2EE over WebTorrent.
 *  1. Real MediaRecorder voice (fake mic) 2/10/30/60 s, both directions, via App.finalizeVoiceToChat.
 *  2. Seeded bytes captured at wt.seed: hash == descriptor ciphertext hash, never the plaintext WebM.
 *  3. Recipient: inbound validation → P2P ciphertext → hash → local decrypt → ObjectURL → audio plays.
 *  4. Sentinel fixture, Blossom-only fallback (P2P unavailable), mid-flight fallback, dedup, tamper fail-closed.
 * Mocked Blossom host only. Disposable identities. Never logs keys / plaintext / full magnets.
 * Run: node qa/package899-real-browser-voice-p2p-e2ee-gate.mjs   (RV_DURATIONS=2,10,30,60)
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey, utils } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.RB_ROOT || path.resolve(__dirname, '..'));
const OUT = process.env.RV_OUT || path.join(__dirname, 'package899-real-browser-voice-p2p-e2ee-report.json');
const DURATIONS = (process.env.RV_DURATIONS || '2,10,30,60').split(',').map(Number).filter((n) => n > 0);
const MOCK_BLOSSOM = 'https://blossom.qa.mock';
// The descriptor reaches the recipient via relays in production; model that delivery latency here.
const RELAY_DELAY_MS = Number(process.env.RV_RELAY_DELAY_MS || 1500);
const SENTINEL = 'SOS899_VOICE_SENTINEL_PLAINTEXT_7f3a';
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const pct = (arr, p) => {
  const s = arr.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };
function serve(root) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.join(root, url === '/' ? '/videos.html' : url);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function boot(page, base, key, label) {
  await page.goto(base + '?rv=1&u=' + label, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.createNewIdentityExplicit, { timeout: 90000 });
  const created = await page.evaluate(({ k }) => {
    const App = window.NostrApp;
    const c = App.createNewIdentityExplicit({ privateKeyHex: k });
    const SA = App.SessionAuthority || window.SosSessionAuthority;
    if (SA?.bindCurrentSession) SA.bindCurrentSession({ accountPubkey: c.publicKey, bump: true });
    return { ok: !!(c && c.ok), pub: String(c?.publicKey || App.publicKey || '').toLowerCase() };
  }, { k: key });
  await sleep(2500);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction((pub) => {
    const App = window.NostrApp;
    return String(App?.publicKey || '').toLowerCase() === pub && App.guestMode !== true && !!App.finalizeVoiceToChat && !!App.resolveDurableVoicePlayback && !!window.__sosWebTorrentStackLoaded && !!App.torrentTransfer?.init?.();
  }, created.pub, { timeout: 120000 });
  await page.evaluate((mock) => { window.NostrApp.blossomServers = [{ url: mock }]; }, MOCK_BLOSSOM);
  return created;
}

function installMockBlossom(ctx, store, requests) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,PUT,POST,HEAD,OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type, Accept', 'access-control-max-age': '600' };
  return ctx.route(MOCK_BLOSSOM + '/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    requests.push({ method: req.method(), path: u.pathname });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if ((req.method() === 'PUT' || req.method() === 'POST') && u.pathname === '/upload') {
      const body = req.postDataBuffer() || Buffer.alloc(0);
      const id = 'b' + store.size + '-' + Date.now().toString(36);
      store.set(id, { body, contentType: req.headers()['content-type'] || '' });
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ url: `${MOCK_BLOSSOM}/${id}`, size: body.length }) });
    }
    const id = u.pathname.slice(1);
    if (req.method() === 'GET' && store.has(id)) {
      const it = store.get(id);
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': it.contentType || 'application/octet-stream' }, body: it.body });
    }
    return route.fulfill({ status: 404, headers: cors, body: '' });
  });
}

async function instrument(page) {
  await page.evaluate((SENTINEL) => {
    const App = window.NostrApp;
    const hexOf = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    const sha = async (u8) => hexOf(await crypto.subtle.digest('SHA-256', u8));
    const sent = new TextEncoder().encode(SENTINEL);
    const has = (u8, n) => {
      outer: for (let i = 0; i + n.length <= u8.length; i += 1) {
        for (let j = 0; j < n.length; j += 1) if (u8[i + j] !== n[j]) continue outer;
        return true;
      }
      return false;
    };
    const V = (window.__v = { seeds: [], adds: 0, downloaded: 0, enc: [], dec: [], plain: [], attached: [], longtasks: [], ops: [] });
    V.sha = sha;
    V.has = (u8) => has(u8, sent);
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => V.longtasks.push({ s: e.startTime, d: e.duration }))).observe({ type: 'longtask' });
    } catch (_) {}
    const wt = App.torrentTransfer.init();
    const origSeed = wt.seed.bind(wt);
    wt.seed = function (input, opts, cb) {
      const p = (async () => {
        const u8 = new Uint8Array(await input.arrayBuffer());
        V.seeds.push({ hash: await sha(u8), size: u8.length, name: input.name, type: input.type, sentinel: has(u8, sent), ebml: u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3 });
      })();
      V.seedPending = p;
      return origSeed(input, opts, cb);
    };
    const origAdd = wt.add.bind(wt);
    wt.add = function (...a) {
      V.adds += 1;
      const t = origAdd(...a);
      try { t.on('download', (n) => { V.downloaded += n; }); } catch (_) {}
      return t;
    };
    const origEnc = App.encryptMediaBlob;
    App.encryptMediaBlob = async function (...a) { const t = performance.now(); try { return await origEnc.apply(this, a); } finally { V.enc.push(performance.now() - t); } };
    const origDec = App.decryptMediaBlob;
    App.decryptMediaBlob = async function (...a) { const t = performance.now(); try { return await origDec.apply(this, a); } finally { V.dec.push(performance.now() - t); } };
    const origUp = App.uploadMediaForServerFallback;
    App.uploadMediaForServerFallback = async function (blob, opts) {
      try { const u8 = new Uint8Array(await blob.arrayBuffer()); V.plain.push({ hash: await sha(u8), size: u8.length }); } catch (_) {}
      return origUp.call(this, blob, opts);
    };
    App.setChatFileAttachment = function (peer, att) { V.attached.push(att); };
  }, SENTINEL);
}

const report = { gate: 'PACKAGE899_REAL_BROWSER_VOICE_P2P_E2EE', ts: new Date().toISOString(), status: 'FAIL', relayDelayMs: RELAY_DELAY_MS, voices: [], sentinel: null, fallback: null, midflight: null, dedup: null, failClosed: {}, perf: {}, security: {}, gates: {} };

async function sendRecorded(S, peer, seconds) {
  return S.evaluate(async ({ peer, seconds }) => {
    const App = window.NostrApp;
    const V = window.__v;
    const n0 = V.attached.length;
    await App.startVoiceRecording();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const t0 = performance.now();
    const att = await App.finalizeVoiceToChat(peer);
    const sendMs = performance.now() - t0;
    if (V.seedPending) await V.seedPending;
    V.ops.push({ s: t0, e: performance.now(), kind: 'send' });
    const wire = att && att.type === 'encrypted-media' ? App.buildEncryptedAttachmentWireDescriptor(att) : { type: att.type, dataUrl: att.dataUrl, duration: att.duration, isVoice: true, name: att.name };
    if (att.clientMessageId) wire.clientMessageId = att.clientMessageId;
    return { wire: JSON.parse(JSON.stringify(wire)), sendMs, attachedDelta: V.attached.length - n0, seed: att && att.p2p ? V.seeds[V.seeds.length - 1] : null, plain: att && att.type === 'encrypted-media' ? V.plain[V.plain.length - 1] : null, key: att.enc ? att.enc.key : null };
  }, { peer, seconds });
}

async function receive(R, wire, sender, recipient, opts = {}) {
  await sleep(RELAY_DELAY_MS);
  return R.evaluate(async ({ wire, sender, recipient, opts }) => {
    const App = window.NostrApp;
    const V = window.__v;
    const out = {};
    out.inspect = App.inspectIncomingChatAttachment(JSON.parse(JSON.stringify(wire)));
    const adds0 = V.adds;
    const dl0 = V.downloaded;
    const t0 = performance.now();
    let src = '';
    if (wire.type === 'encrypted-media') {
      const mk = () => Object.assign(JSON.parse(JSON.stringify(wire)), { isVoice: true });
      const ctx = { messageId: opts.messageId || wire.clientMessageId, sender, recipient: opts.recipient || recipient };
      if (opts.dup) {
        const [a, b] = await Promise.all([App.resolveDurableVoicePlayback(mk(), ctx), App.resolveDurableVoicePlayback(mk(), ctx)]);
        out.dupSources = [a.source, b.source];
        out.pr = a;
      } else {
        out.pr = await App.resolveDurableVoicePlayback(mk(), ctx);
      }
      src = out.pr && out.pr.ok ? out.pr.src : '';
    } else {
      src = wire.dataUrl || '';
      out.pr = { ok: !!src, source: 'INLINE_E2EE_MESSAGE' };
    }
    out.recvMs = performance.now() - t0;
    V.ops.push({ s: t0, e: performance.now(), kind: 'recv' });
    out.adds = V.adds - adds0;
    out.downloaded = V.downloaded - dl0;
    if (!src) return out;
    const buf = new Uint8Array(await (await fetch(src)).arrayBuffer());
    out.plainHash = await V.sha(buf);
    out.plainSize = buf.length;
    out.sentinel = V.has(buf);
    if (!opts.skipAudio) {
      try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        const decoded = await ac.decodeAudioData(buf.slice().buffer);
        out.decodedSec = Math.round(decoded.duration * 10) / 10;
        ac.close();
      } catch (e) { out.decodeErr = String(e && e.name); }
      try {
        const audio = new Audio(src);
        audio.muted = true;
        await audio.play();
        await new Promise((r) => setTimeout(r, 800));
        out.played = audio.currentTime > 0.2;
        audio.pause();
      } catch (e) { out.playErr = String(e && e.name); }
    }
    return out;
  }, { wire, sender, recipient, opts });
}

async function sendFixture(S, peer, size, seconds, { noP2p = false, throttle = 0 } = {}) {
  return S.evaluate(async ({ peer, size, seconds, SENTINEL, noP2p, throttle }) => {
    const App = window.NostrApp;
    const V = window.__v;
    const bytes = new Uint8Array(size);
    bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
    let x = 12345;
    for (let i = 4; i < size; i += 1) { x = (x * 1664525 + 1013904223) >>> 0; bytes[i] = x >>> 24; }
    const s = new TextEncoder().encode(SENTINEL);
    for (let off = 64; off + s.length < size; off += 4096) bytes.set(s, off);
    const plainHash = await V.sha(bytes);
    const origInit = App.torrentTransfer.init;
    if (noP2p) App.torrentTransfer.init = () => null;
    const wt = origInit();
    if (throttle && wt && typeof wt.throttleUpload === 'function') wt.throttleUpload(throttle);
    try {
      const seeds0 = V.seeds.length;
      const att = await App.sendVoiceBlobToChat(peer, { blob: new Blob([bytes], { type: 'audio/webm;codecs=opus' }), duration: seconds, mimeType: 'audio/webm;codecs=opus' });
      if (V.seedPending) await V.seedPending;
      const wire = JSON.parse(JSON.stringify(App.buildEncryptedAttachmentWireDescriptor(att)));
      wire.clientMessageId = att.clientMessageId;
      return { wire, plainHash, seed: V.seeds.length > seeds0 ? V.seeds[V.seeds.length - 1] : null, hasP2p: !!att.p2p, key: att.enc && att.enc.key };
    } finally {
      App.torrentTransfer.init = origInit;
    }
  }, { peer, size, seconds, SENTINEL, noP2p, throttle });
}

async function main() {
  const server = await serve(ROOT);
  const base = `http://127.0.0.1:${server.address().port}/videos.html`;
  const keyA = hex(generateSecretKey());
  const keyB = hex(generateSecretKey());
  const pubA = getPublicKey(utils.hexToBytes(keyA));
  const pubB = getPublicKey(utils.hexToBytes(keyB));
  const store = new Map();
  const mockReq = [];
  const foreignUploads = [];
  const allUrls = [];
  const consoleLines = [];
  const browser = await chromium.launch({
    headless: false,
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const ctxA = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const ctxB = await browser.newContext({ viewport: { width: 900, height: 700 } });
  for (const ctx of [ctxA, ctxB]) {
    await ctx.grantPermissions(['microphone'], { origin: new URL(base).origin });
    await installMockBlossom(ctx, store, mockReq);
    ctx.on('request', (r) => {
      allUrls.push(r.url());
      const m = r.method();
      if ((m === 'PUT' || m === 'POST') && /\/(upload|media|api\/v1\/upload|api\/upload)$/.test(new URL(r.url()).pathname) && !r.url().startsWith(MOCK_BLOSSOM)) foreignUploads.push(new URL(r.url()).host);
    });
  }
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  for (const p of [A, B]) p.on('console', (m) => { if (consoleLines.length < 30000) consoleLines.push(m.text()); });
  const keys = [];
  try {
    await boot(A, base, keyA, 'A');
    await boot(B, base, keyB, 'B');
    await instrument(A);
    await instrument(B);
    await sleep(1500);

    // 1. real recordings both directions
    for (const seconds of DURATIONS) {
      for (const [S, R, sp, rp, dir] of [[A, B, pubA, pubB, 'A2B'], [B, A, pubB, pubA, 'B2A']]) {
        const up0 = store.size;
        const s = await sendRecorded(S, rp, seconds);
        if (s.key) keys.push(s.key);
        const uploads = [...store.values()].slice(up0);
        const r = await receive(R, s.wire, sp, rp);
        const enc = s.wire.type === 'encrypted-media';
        const row = {
          dir, seconds,
          route: enc ? (s.wire.p2p ? 'P2P_APP_E2EE_VOICE' : 'SERVER_E2EE_VOICE') : 'INLINE_E2EE_MESSAGE',
          plaintextBytes: s.plain ? s.plain.size : r.plainSize,
          cipherBytes: enc ? s.wire.cipher.size : null,
          seededHashEqCipher: enc && s.seed ? s.seed.hash === s.wire.cipher.sha256 : null,
          plainHashNeCipher: enc && s.plain ? s.plain.hash !== s.wire.cipher.sha256 : null,
          seededNotPlaintext: s.seed ? s.seed.hash !== (s.plain && s.plain.hash) && !s.seed.ebml : null,
          seededName: s.seed ? s.seed.name + '|' + s.seed.type : null,
          blossomUploads: uploads.length,
          blossomPlaintext: s.plain ? uploads.some((u) => sha256(u.body) === s.plain.hash) : false,
          inboundOk: r.inspect && r.inspect.ok === true,
          source: r.pr && r.pr.source,
          p2pBytes: r.downloaded,
          recipientPlainHashMatch: s.plain ? r.plainHash === s.plain.hash : null,
          decodedSec: r.decodedSec, played: r.played === true,
          sendMs: Math.round(s.sendMs), recvMs: Math.round(r.recvMs), attachedOnce: s.attachedDelta === 1,
        };
        report.voices.push(row);
        console.log('VOICE', dir, seconds + 's', row.route, row.source, 'seed=cipher:' + row.seededHashEqCipher, 'plainMatch:' + row.recipientPlainHashMatch, 'dec=' + row.decodedSec + 's', 'played=' + row.played, 'send=' + row.sendMs + 'ms', 'recv=' + row.recvMs + 'ms');
      }
    }

    // 2. sentinel fixture over P2P
    {
      const up0 = store.size;
      const s = await sendFixture(A, pubB, 300 * 1024, 30);
      if (s.key) keys.push(s.key);
      const uploads = [...store.values()].slice(up0);
      const r = await receive(B, s.wire, pubA, pubB, { skipAudio: true });
      report.sentinel = {
        hasP2p: s.hasP2p,
        PLAINTEXT_HASH_NE_CIPHERTEXT_HASH: s.plainHash !== s.wire.cipher.sha256,
        SEEDED_HASH_EQ_CIPHERTEXT_HASH: !!s.seed && s.seed.hash === s.wire.cipher.sha256,
        SENTINEL_IN_SEEDED: !!s.seed && s.seed.sentinel,
        SENTINEL_IN_BLOSSOM: uploads.some((u) => u.body.includes(Buffer.from(SENTINEL))),
        source: r.pr && r.pr.source,
        recipientPlainHashMatch: r.plainHash === s.plainHash,
        recipientSentinelRecovered: r.sentinel === true,
      };
      console.log('SENTINEL', JSON.stringify(report.sentinel));
    }

    // 3. Blossom fallback (P2P unavailable at sender)
    {
      const up0 = store.size;
      const s = await sendFixture(A, pubB, 300 * 1024, 30, { noP2p: true });
      if (s.key) keys.push(s.key);
      const uploads = [...store.values()].slice(up0);
      const r = await receive(B, s.wire, pubA, pubB, { skipAudio: true });
      report.fallback = { hasP2p: s.hasP2p, seeded: !!s.seed, source: r.pr && r.pr.source, recipientPlainHashMatch: r.plainHash === s.plainHash, blossomPlaintext: uploads.some((u) => u.body.includes(Buffer.from(SENTINEL)) || sha256(u.body) === s.plainHash) };
      console.log('FALLBACK', JSON.stringify(report.fallback));
    }

    // 4. mid-flight fallback (sender upload throttled → Blossom wins after head start, torrent dropped)
    {
      const s = await sendFixture(A, pubB, 480 * 1024, 60, { throttle: 12000 });
      if (s.key) keys.push(s.key);
      const r = await receive(B, s.wire, pubA, pubB, { skipAudio: true });
      await A.evaluate(() => { const wt = window.NostrApp.torrentTransfer.init(); if (wt && typeof wt.throttleUpload === 'function') wt.throttleUpload(-1); });
      const bTorrents = await B.evaluate((mag) => { const wt = window.NostrApp.torrentTransfer.init(); return (wt.torrents || []).filter((t) => mag.includes(t.infoHash)).length; }, s.wire.p2p ? s.wire.p2p.magnetURI : '');
      report.midflight = { hasP2p: s.hasP2p, source: r.pr && r.pr.source, p2pBytesBeforeFallback: r.downloaded, recipientPlainHashMatch: r.plainHash === s.plainHash, torrentDroppedAfterFallback: bTorrents === 0, recvMs: Math.round(r.recvMs) };
      console.log('MIDFLIGHT', JSON.stringify(report.midflight));
    }

    // 5. dedup (two concurrent resolves of the same voice)
    {
      const s = await sendFixture(A, pubB, 240 * 1024, 30);
      if (s.key) keys.push(s.key);
      const get0 = mockReq.filter((q) => q.method === 'GET').length;
      const r = await receive(B, s.wire, pubA, pubB, { dup: true, skipAudio: true });
      const gets = mockReq.filter((q) => q.method === 'GET').length - get0;
      report.dedup = { sources: r.dupSources, torrentAdds: r.adds, blossomGets: gets, recipientPlainHashMatch: r.plainHash === s.plainHash };
      console.log('DEDUP', JSON.stringify(report.dedup));

      // 6. fail-closed in real browser
      const tampered = JSON.parse(JSON.stringify(s.wire));
      const k = Buffer.from(tampered.enc.key, 'base64url');
      k[0] ^= 1;
      tampered.enc.key = k.toString('base64url');
      tampered.cipher = Object.assign({}, tampered.cipher);
      const rt = await receive(B, tampered, pubA, pubB, { skipAudio: true });
      report.failClosed.tamperedKey = { source: rt.pr && rt.pr.source, failClosed: rt.pr && rt.pr.failClosed === true, played: !!rt.plainHash };
      const s2 = await sendFixture(A, pubB, 240 * 1024, 30);
      const rw = await receive(B, s2.wire, pubA, pubB, { recipient: pubA, skipAudio: true });
      report.failClosed.wrongRecipient = { source: rw.pr && rw.pr.source, failClosed: rw.pr && rw.pr.failClosed === true, played: !!rw.plainHash };
      const badVer = JSON.parse(JSON.stringify(s2.wire));
      badVer.p2p.v = 2;
      const ri = await B.evaluate((w) => window.NostrApp.inspectIncomingChatAttachment(w), badVer);
      report.failClosed.invalidP2pVersion = ri;
      console.log('FAILCLOSED', JSON.stringify(report.failClosed));
    }

    // performance / main thread
    const pa = await A.evaluate(() => ({ enc: window.__v.enc, dec: window.__v.dec, lt: window.__v.longtasks, ops: window.__v.ops }));
    const pb = await B.evaluate(() => ({ enc: window.__v.enc, dec: window.__v.dec, lt: window.__v.longtasks, ops: window.__v.ops }));
    const enc = [...pa.enc, ...pb.enc];
    const dec = [...pa.dec, ...pb.dec];
    const sendMs = report.voices.filter((v) => v.route !== 'INLINE_E2EE_MESSAGE').map((v) => v.sendMs);
    const recvMs = report.voices.filter((v) => v.route !== 'INLINE_E2EE_MESSAGE').map((v) => v.recvMs);
    const opLong = (p) => p.lt.filter((t) => p.ops.some((o) => t.s < o.e && t.s + t.d > o.s));
    const longA = opLong(pa);
    const longB = opLong(pb);
    report.perf = {
      VOICE_ENCRYPT_MS_P50: pct(enc, 50), VOICE_ENCRYPT_MS_P95: pct(enc, 95),
      VOICE_DECRYPT_MS_P50: pct(dec, 50), VOICE_DECRYPT_MS_P95: pct(dec, 95),
      VOICE_SEND_START_LATENCY_P50: pct(sendMs, 50), VOICE_SEND_START_LATENCY_P95: pct(sendMs, 95),
      VOICE_RECV_READY_P50: pct(recvMs, 50), VOICE_RECV_READY_P95: pct(recvMs, 95),
      LONG_TASKS_DURING_VOICE_OPS: longA.length + longB.length,
      LONG_TASK_MAX_MS: Math.round(Math.max(0, ...longA.map((t) => t.d), ...longB.map((t) => t.d))),
    };

    // security
    const allLog = consoleLines.join('\n');
    const urlText = allUrls.join('\n');
    report.security = {
      foreignPlaintextUploads: foreignUploads.length,
      fileKeyInLogs: keys.some((k) => k && allLog.includes(k)),
      fileKeyInUrls: keys.some((k) => k && urlText.includes(k)),
      nsecInLogs: /nsec1[0-9a-z]{20,}/.test(allLog),
      privKeyInLogs: allLog.includes(keyA) || allLog.includes(keyB),
      sentinelInLogs: allLog.includes(SENTINEL),
      sdpInLogs: /a=ice-pwd|a=fingerprint/.test(allLog),
      keysChecked: keys.length,
    };

    const g = report.gates;
    const enc2 = report.voices.filter((v) => v.route !== 'INLINE_E2EE_MESSAGE');
    const viaP2p = enc2.filter((v) => v.source === 'VOICE_SOURCE_P2P_E2EE');
    report.p2pDelivery = {
      encryptedVoices: enc2.length,
      deliveredViaP2p: viaP2p.length,
      deliveredViaBlossomE2ee: enc2.filter((v) => v.source === 'VOICE_SOURCE_BLOSSOM_E2EE').length,
      p2pPerDirection: { A2B: viaP2p.filter((v) => v.dir === 'A2B').length, B2A: viaP2p.filter((v) => v.dir === 'B2A').length },
      note: 'P2P discovery via public WebTorrent trackers is best-effort; a slow swarm falls back to the same ciphertext on Blossom (E2EE).',
    };
    g.REAL_BROWSER_VOICE_P2P_E2EE_GATE =
      report.voices.length === DURATIONS.length * 2 &&
      report.voices.every((v) => v.inboundOk && v.played && v.attachedOnce && (v.decodedSec == null || Math.abs(v.decodedSec - v.seconds) <= 1.5)) &&
      enc2.length > 0 &&
      enc2.every((v) => v.route === 'P2P_APP_E2EE_VOICE' && (v.source === 'VOICE_SOURCE_P2P_E2EE' || v.source === 'VOICE_SOURCE_BLOSSOM_E2EE') && v.recipientPlainHashMatch && v.seededHashEqCipher && v.plainHashNeCipher && v.seededNotPlaintext && !v.blossomPlaintext) &&
      report.p2pDelivery.p2pPerDirection.A2B > 0 && report.p2pDelivery.p2pPerDirection.B2A > 0
        ? 'PASS' : 'FAIL';
    const sn = report.sentinel;
    g.VOICE_P2P_ONWIRE_APP_CIPHERTEXT_GATE = sn && sn.hasP2p && sn.PLAINTEXT_HASH_NE_CIPHERTEXT_HASH && sn.SEEDED_HASH_EQ_CIPHERTEXT_HASH && !sn.SENTINEL_IN_SEEDED && !sn.SENTINEL_IN_BLOSSOM && sn.source === 'VOICE_SOURCE_P2P_E2EE' && sn.recipientPlainHashMatch && sn.recipientSentinelRecovered ? 'PASS' : 'FAIL';
    const fb = report.fallback;
    g.VOICE_BLOSSOM_E2EE_FALLBACK_GATE = fb && !fb.hasP2p && !fb.seeded && fb.source === 'VOICE_SOURCE_BLOSSOM_E2EE' && fb.recipientPlainHashMatch && !fb.blossomPlaintext ? 'PASS' : 'FAIL';
    const mf = report.midflight;
    g.VOICE_MIDFLIGHT_FALLBACK_E2EE_GATE = mf && mf.hasP2p && mf.source === 'VOICE_SOURCE_BLOSSOM_E2EE' && mf.recipientPlainHashMatch && mf.torrentDroppedAfterFallback ? 'PASS' : 'FAIL';
    const dd = report.dedup;
    g.VOICE_HYBRID_DEDUP_GATE = dd && dd.torrentAdds <= 1 && dd.blossomGets <= 1 && dd.recipientPlainHashMatch && (dd.sources || []).length === 2 && (dd.sources || []).every((x) => /P2P_E2EE|BLOSSOM_E2EE|LOCAL/.test(x)) ? 'PASS' : 'FAIL';
    const fc = report.failClosed;
    g.VOICE_P2P_CRYPTO_FAIL_CLOSED_REAL = fc.tamperedKey && fc.tamperedKey.failClosed && !fc.tamperedKey.played && fc.wrongRecipient && fc.wrongRecipient.failClosed && !fc.wrongRecipient.played && fc.invalidP2pVersion && fc.invalidP2pVersion.ok === false ? 'PASS' : 'FAIL';
    g.VOICE_E2EE_PERFORMANCE_GATE = report.perf.VOICE_ENCRYPT_MS_P95 != null && report.perf.VOICE_ENCRYPT_MS_P95 < 250 && report.perf.VOICE_DECRYPT_MS_P95 < 250 && report.perf.VOICE_SEND_START_LATENCY_P95 < 3000 ? 'PASS' : 'FAIL';
    g.VOICE_E2EE_MAIN_THREAD_GATE = report.perf.LONG_TASK_MAX_MS < 200 ? 'PASS' : 'FAIL';
    const sec = report.security;
    g.REAL_BROWSER_VOICE_PRIVACY = !sec.fileKeyInLogs && !sec.fileKeyInUrls && !sec.nsecInLogs && !sec.privKeyInLogs && !sec.sentinelInLogs && !sec.sdpInLogs && sec.foreignPlaintextUploads === 0 && sec.keysChecked > 0 ? 'PASS' : 'FAIL';
    report.status = Object.values(g).every((v) => v === 'PASS') ? 'PASS' : 'FAIL';
  } catch (e) {
    report.error = String((e && e.stack) || e).slice(0, 2000);
    console.error(e);
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report.perf));
    console.log(Object.entries(report.gates).map(([k, v]) => `${k}=${v}`).join('\n'));
    console.log('STATUS', report.status);
    await browser.close().catch(() => {});
    server.close();
  }
  process.exit(report.status === 'PASS' ? 0 : 1);
}

main();
