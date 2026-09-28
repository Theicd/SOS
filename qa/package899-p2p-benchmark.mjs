#!/usr/bin/env node
/**
 * Package 899 ג€” P2P DataChannel benchmark (QA only, local loopback, no relays).
 *  Phase B: raw DataChannel baseline (optimal flow control) vs SOS encrypted file protocol
 *  (real chat-p2p-file.js, AES-GCM per chunk, ACK window) over the SAME connection.
 * Usage: node qa/package899-p2p-benchmark.mjs [--root <repo>] [--sizes 1,5,10,25,50] [--delay-ms 0] [--out file]
 * Delay emulates one-way latency by delaying delivery of every DataChannel message (both sides, order kept).
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const ROOT = path.resolve(arg('root', path.resolve(__dirname, '..')));
const SIZES_MB = arg('sizes', '1,5,10,25,50').split(',').map(Number).filter((n) => n > 0);
const DELAY_MS = Number(arg('delay-ms', '0')) || 0;
const OUT = arg('out', path.join(__dirname, 'package899-p2p-benchmark-report.json'));
const DIRECTIONS = arg('dirs', 'AtoB,BtoA').split(',');
const RAW_HIGH = Number(arg('raw-high', String(1024 * 1024)));

const BENCH_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
window.NostrApp = { publicKey: 'x', persistChatP2PMedia: async (fileId, blob) => { window.__received.set(fileId, blob); } };
window.__received = new Map();
window.__longTasks = { n: 0, ms: 0 };
try { new PerformanceObserver((l) => l.getEntries().forEach((e) => { __longTasks.n++; __longTasks.ms += e.duration; })).observe({ type: 'longtask', buffered: true }); } catch (_) {}
</script>
<script src="/p2p-connection-state.js"></script>
<script src="/chat-p2p-file.js"></script>
<script>
(function () {
  const App = window.NostrApp;
  const B = window.__bench = { pc: null, dc: null, delayMs: 0, mode: 'raw', peer: '', raw: null, bufPeak: 0 };
  const q = [];
  let qTimer = null;
  function pump() {
    qTimer = null;
    const t = performance.now();
    while (q.length && q[0][0] <= t) handle(q.shift()[1]);
    if (q.length) qTimer = setTimeout(pump, Math.max(0, q[0][0] - performance.now()));
  }
  function deliver(data) {
    if (!B.delayMs) return handle(data);
    q.push([performance.now() + B.delayMs, data]);
    if (!qTimer) qTimer = setTimeout(pump, B.delayMs);
  }
  function handle(data) {
    if (B.mode === 'raw') {
      const r = B.raw;
      if (!r) return;
      if (typeof data === 'string') {
        if (data === 'RAW_END') { r.endAt = performance.now(); r.done(); }
        return;
      }
      if (!r.startAt) r.startAt = performance.now();
      r.bytes += data.byteLength;
      r.parts.push(data);
      return;
    }
    App._p2pFileQa.handleIncomingMessage(B.peer, data, B.dc);
  }
  function wireDc(dc) {
    B.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev) => deliver(ev.data);
  }
  B.createOffer = async () => {
    B.pc = new RTCPeerConnection({ iceServers: [] });
    wireDc(B.pc.createDataChannel('file-transfer', { ordered: true }));
    await B.pc.setLocalDescription(await B.pc.createOffer());
    await new Promise((r) => { if (B.pc.iceGatheringState === 'complete') r(); else B.pc.onicegatheringstatechange = () => B.pc.iceGatheringState === 'complete' && r(); });
    return B.pc.localDescription.toJSON();
  };
  B.acceptOffer = async (offer) => {
    B.pc = new RTCPeerConnection({ iceServers: [] });
    B.pc.ondatachannel = (ev) => wireDc(ev.channel);
    await B.pc.setRemoteDescription(offer);
    await B.pc.setLocalDescription(await B.pc.createAnswer());
    await new Promise((r) => { if (B.pc.iceGatheringState === 'complete') r(); else B.pc.onicegatheringstatechange = () => B.pc.iceGatheringState === 'complete' && r(); });
    return B.pc.localDescription.toJSON();
  };
  B.applyAnswer = async (answer) => { await B.pc.setRemoteDescription(answer); };
  B.waitOpen = () => new Promise((r) => { const t = setInterval(() => { if (B.dc && B.dc.readyState === 'open') { clearInterval(t); r(); } }, 5); });
  function fill(bytes, seed) { let x = seed >>> 0 || 1; for (let i = 0; i < bytes.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; bytes[i] = x & 255; } return bytes; }
  B.makeBytes = (size, seed) => fill(new Uint8Array(size), seed);
  B.sha = async (buf) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map((b) => b.toString(16).padStart(2, '0')).join('');
  B.mem = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
  // ---- raw ----
  B.rawRecvStart = () => new Promise((resolve) => {
    B.mode = 'raw';
    B.raw = { bytes: 0, parts: [], startAt: 0, endAt: 0, done: null };
    B.raw.done = async () => {
      const total = new Uint8Array(B.raw.bytes);
      let o = 0;
      for (const p of B.raw.parts) { total.set(new Uint8Array(p), o); o += p.byteLength; }
      B.raw.parts = [];
      B.rawResult = { bytes: B.raw.bytes, hash: await B.sha(total), firstByteAt: B.raw.startAt, endAt: B.raw.endAt };
    };
    resolve(true);
  });
  B.rawSend = async (size, seed) => {
    B.mode = 'raw';
    const data = B.makeBytes(size, seed);
    const hash = await B.sha(data);
    const dc = B.dc;
    const CH = 64 * 1024, HIGH = B.rawHigh || 1024 * 1024, LOW = Math.floor(HIGH / 4);
    dc.bufferedAmountLowThreshold = LOW;
    let peak = 0;
    const lt0 = { ...window.__longTasks };
    const t0 = performance.now();
    for (let o = 0; o < size; o += CH) {
      if (dc.bufferedAmount > HIGH) await new Promise((r) => { dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); }; });
      dc.send(data.subarray(o, Math.min(size, o + CH)));
      if (dc.bufferedAmount > peak) peak = dc.bufferedAmount;
    }
    dc.send('RAW_END');
    return { t0, hash, bufPeak: peak, longTasks: window.__longTasks.n - lt0.n, longTaskMs: Math.round(window.__longTasks.ms - lt0.ms), mem: B.mem() };
  };
  // ---- SOS protocol ----
  async function makeKey() {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    return { key, keyStr: btoa(String.fromCharCode(...raw)) };
  }
  B.sosPrepareRecv = async (offer, peer) => {
    B.mode = 'sos';
    B.peer = peer;
    await App.handleP2PFileOffer(peer, offer);
    return !!App.activeP2PTransfers.get(offer.fileId);
  };
  B.sosSend = async (size, seed, fileId, peer) => {
    B.mode = 'sos';
    B.peer = peer;
    const data = B.makeBytes(size, seed);
    const hash = await B.sha(data);
    const file = new File([data], 'bench.bin', { type: 'application/octet-stream' });
    const { key, keyStr } = await makeKey();
    const totalChunks = Math.ceil(size / App.P2P_FILE_CHUNK_SIZE);
    const transfer = {
      fileId, file, key, keyStr, peerPubkey: peer, direction: 'send', currentChunk: 0, totalChunks,
      ackReceived: 0, paused: false, startTime: Date.now(), caption: '', dcWaitAttempts: 0, channel: B.dc,
      lastAckedChunk: -1, completed: false, _sendInFlight: false, _sendQueued: false, _dcOfferSent: true,
      nextChunkToSend: 0, nextChunkToPrepare: 0, inFlightChunks: new Set(), ackedChunks: new Set(),
      preparingChunks: new Map(), preparedChunks: new Map(), sendGeneration: 0,
    };
    App.activeP2PTransfers.set(fileId, transfer);
    B.sosSendState = { transfer, t0: 0, doneAt: 0, bufPeak: 0 };
    return { offer: { fileId, name: 'bench.bin', size, mimeType: 'application/octet-stream', keyStr, totalChunks, createdAt: Math.floor(Date.now() / 1000) }, hash };
  };
  B.sosStart = (fileId) => {
    const st = B.sosSendState;
    st.lt0 = { ...window.__longTasks };
    st.t0 = performance.now();
    const iv = setInterval(() => { if (B.dc.bufferedAmount > st.bufPeak) st.bufPeak = B.dc.bufferedAmount; }, 20);
    const unsub = App.subscribeP2PFileProgress((e) => {
      if (e && e.fileId === fileId && e.direction === 'send' && (e.status === 'completed' || e.status === 'complete' || e.status === 'sent')) {
        if (!st.doneAt) st.doneAt = performance.now();
      }
    });
    st.firstChunkAt = 0;
    st.win = {};
    App._p2pFileQaNote = (ev, d) => {
      if (!d || d.fileId !== fileId) return;
      if (ev === 'chunk-sent' && !st.firstChunkAt) st.firstChunkAt = performance.now();
      const w = st.transfer.sendWindow || 0;
      for (const n of [8, 16, 32]) if (w >= n && !st.win[n]) st.win[n] = performance.now();
    };
    st.stop = () => { clearInterval(iv); unsub(); App._p2pFileQaNote = null; };
    App._p2pFileQa.sendNextChunk(fileId);
    return st.t0;
  };
  B.sosSendResult = () => {
    const st = B.sosSendState;
    const t = st.transfer;
    return {
      acked: t.ackedChunks.size, total: t.totalChunks, completed: !!t.completed, t0: st.t0, doneAt: st.doneAt, bufPeak: st.bufPeak,
      maxInFlight: t.maxInFlightSeen || 0, readMs: t.totalReadMs || 0, aesMs: t.totalAesMs || 0,
      longTasks: window.__longTasks.n - st.lt0.n, longTaskMs: Math.round(window.__longTasks.ms - st.lt0.ms), mem: B.mem(),
      ackTimeouts: t.ackTimeouts || 0, retransmits: t.retransmits || 0, windowDownshifts: t.windowDownshifts || 0,
      p2pFailure: t.p2pFailure || null, fallbackActive: !!t.fallbackActive,
      winMs: Object.fromEntries([8, 16, 32].map((n) => [n, st.win[n] && st.firstChunkAt ? Math.round(st.win[n] - st.firstChunkAt) : null])),
    };
  };
  B.sosRecvResult = async (fileId) => {
    const blob = window.__received.get(fileId);
    if (!blob) return null;
    const buf = await blob.arrayBuffer();
    return { size: buf.byteLength, hash: await B.sha(buf), at: performance.now() };
  };
})();
</script></body></html>`;

function serve(root) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/qa-p2p-bench.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(BENCH_HTML);
      return;
    }
    const file = path.join(root, url);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const pct = (arr, p) => {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))];
};
const mbps = (bytes, ms) => (ms > 0 ? Math.round(((bytes * 8) / (ms / 1000) / 1e6) * 100) / 100 : null);
const until = async (fn, timeoutMs, stepMs = 50) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, stepMs)); }
  return null;
};

(async () => {
  const server = await serve(ROOT);
  const base = `http://127.0.0.1:${server.address().port}/qa-p2p-bench.html`;
  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--enable-precise-memory-info'] });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const Bp = await ctxB.newPage();
  const consoleErr = [];
  for (const p of [A, Bp]) p.on('pageerror', (e) => consoleErr.push(String(e).slice(0, 200)));
  await Promise.all([A.goto(base), Bp.goto(base)]);
  const setupT0 = Date.now();
  const offer = await A.evaluate(() => window.__bench.createOffer());
  const answer = await Bp.evaluate((o) => window.__bench.acceptOffer(o), offer);
  await A.evaluate((a) => window.__bench.applyAnswer(a), answer);
  await Promise.all([A.evaluate(() => window.__bench.waitOpen()), Bp.evaluate(() => window.__bench.waitOpen())]);
  const setupMs = Date.now() - setupT0;
  await A.evaluate((d) => { window.__bench.delayMs = d; }, DELAY_MS);
  await Bp.evaluate((d) => { window.__bench.delayMs = d; }, DELAY_MS);
  for (const p of [A, Bp]) await p.evaluate((h) => { window.__bench.rawHigh = h; }, RAW_HIGH);
  const PEER_A = 'a'.repeat(64);
  const PEER_B = 'b'.repeat(64);

  for (const [S, R] of [[A, Bp], [Bp, A]]) {
    await R.evaluate(() => { window.__bench.rawResult = null; return window.__bench.rawRecvStart(); });
    await S.evaluate(() => window.__bench.rawSend(4 * 1024 * 1024, 3));
    if (process.env.BENCH_DEBUG) console.log('warmup sent');
    const w = await until(() => R.evaluate(() => window.__bench.rawResult), 60000);
    if (!w) console.log('WARMUP_STALL', JSON.stringify(await R.evaluate(() => ({ bytes: window.__bench.raw && window.__bench.raw.bytes, mode: window.__bench.mode, delay: window.__bench.delayMs, vis: document.visibilityState }))));
  }
  const runs = [];
  let seed = 7;
  for (const dir of DIRECTIONS) {
    const [S, R, sPeerOfR, rPeerOfS] = dir === 'AtoB' ? [A, Bp, PEER_B, PEER_A] : [Bp, A, PEER_A, PEER_B];
    for (const mb of SIZES_MB) {
      const size = Math.round(mb * 1024 * 1024);
      // raw
      seed += 1;
      await R.evaluate(() => window.__bench.rawRecvStart());
      await R.evaluate(() => { window.__bench.rawResult = null; });
      const sent = await S.evaluate(([sz, sd]) => window.__bench.rawSend(sz, sd), [size, seed]);
      const rr = await until(() => R.evaluate(() => window.__bench.rawResult), 180000);
      const rawMs = rr ? Math.round(rr.endAt - rr.firstByteAt) : null;
      runs.push({ kind: 'raw', dir, mb, bytes: size, transferMs: rawMs, mbps: rr ? mbps(size, rawMs) : null, hashOk: !!rr && rr.hash === sent.hash && rr.bytes === size, bufferedPeak: sent.bufPeak, longTasks: sent.longTasks, longTaskMs: sent.longTaskMs, memBytes: sent.mem });
      // sos protocol
      seed += 1;
      const fileId = `${Date.now()}-bench-${dir}-${mb}`;
      const prep = await S.evaluate(([sz, sd, fid, peer]) => window.__bench.sosSend(sz, sd, fid, peer), [size, seed, fileId, sPeerOfR]);
      const ready = await R.evaluate(([o, peer]) => window.__bench.sosPrepareRecv(o, peer), [prep.offer, rPeerOfS]);
      await S.evaluate((fid) => window.__bench.sosStart(fid), fileId);
      const recv = await until(() => R.evaluate((fid) => window.__bench.sosRecvResult(fid), fileId), Number(process.env.BENCH_SOS_TIMEOUT_MS || 300000), 100);
      if (!recv) {
        const st = await S.evaluate((fid) => { const t = window.NostrApp.activeP2PTransfers.get(fid); return t ? { acked: t.ackedChunks && t.ackedChunks.size, total: t.totalChunks, next: t.nextChunkToSend, inflight: t.inFlightChunks && t.inFlightChunks.size, completed: t.completed, fb: t.fallbackReason || t.status || null, dc: window.__bench.dc.readyState } : 'gone'; }, fileId);
        const rt = await R.evaluate((fid) => { const t = window.NostrApp.activeP2PTransfers.get(fid); return t ? { recv: t.receivedChunks && (t.receivedChunks.size ?? t.receivedChunks.length), total: t.totalChunks, status: t.status || null } : 'gone'; }, fileId);
        console.log('SOS_STALL', dir, mb, JSON.stringify(st), JSON.stringify(rt), JSON.stringify(consoleErr.slice(-3)));
      }
      const sres = await S.evaluate(() => window.__bench.sosSendResult());
      await S.evaluate(() => window.__bench.sosSendState.stop());
      const sosMs = recv ? Math.round(recv.at - sres.t0) : null;
      runs.push({
        kind: 'sos', dir, mb, bytes: size, transferMs: sosMs, mbps: recv ? mbps(size, sosMs) : null,
        hashOk: !!recv && recv.hash === prep.hash && recv.size === size, recvReady: ready, bufferedPeak: sres.bufPeak,
        maxInFlight: sres.maxInFlight, senderReadMs: Math.round(sres.readMs), senderAesMs: Math.round(sres.aesMs),
        longTasks: sres.longTasks, longTaskMs: sres.longTaskMs, memBytes: sres.mem,
        ackTimeouts: sres.ackTimeouts, retransmits: sres.retransmits, windowDownshifts: sres.windowDownshifts,
        p2pFailure: sres.p2pFailure, firstChunkToWindowMs: sres.winMs,
      });
      console.log(`${dir} ${mb}MB raw=${runs[runs.length - 2].mbps}Mbps sos=${runs[runs.length - 1].mbps}Mbps hash raw=${runs[runs.length - 2].hashOk} sos=${runs[runs.length - 1].hashOk}`);
    }
  }
  const raw = runs.filter((r) => r.kind === 'raw');
  const sos = runs.filter((r) => r.kind === 'sos');
  const rawP50 = pct(raw.map((r) => r.mbps), 50);
  const sosP50 = pct(sos.map((r) => r.mbps), 50);
  const report = {
    gate: 'P2P_RAW_BASELINE',
    root: path.basename(ROOT),
    network: 'local-loopback (Chromium, host candidates, no TURN)',
    emulatedOneWayDelayMs: DELAY_MS,
    rawHighWaterBytes: RAW_HIGH,
    setupMs,
    RAW_DC_MBPS_P50: rawP50,
    RAW_DC_MBPS_P95: pct(raw.map((r) => r.mbps), 95),
    SOS_FILE_MBPS_P50: sosP50,
    SOS_FILE_MBPS_P95: pct(sos.map((r) => r.mbps), 95),
    SOS_PROTOCOL_EFFICIENCY_RATIO: rawP50 && sosP50 ? Math.round((sosP50 / rawP50) * 1000) / 1000 : null,
    ALL_HASHES_OK: runs.every((r) => r.hashOk),
    MAX_IN_FLIGHT_SEEN: Math.max(0, ...sos.map((r) => r.maxInFlight || 0)),
    SOS_BUFFERED_PEAK_MAX: Math.max(0, ...sos.map((r) => r.bufferedPeak || 0)),
    SOS_LARGE_FILE_MBPS_P50: pct(sos.filter((r) => r.mb >= 10).map((r) => r.mbps), 50),
    ACK_TIMEOUT_COUNT: sos.reduce((a, r) => a + (r.ackTimeouts || 0), 0),
    RETRANSMIT_COUNT: sos.reduce((a, r) => a + (r.retransmits || 0), 0),
    WINDOW_DOWNSHIFTS: sos.reduce((a, r) => a + (r.windowDownshifts || 0), 0),
    TRANSFER_SUCCESS: `${sos.filter((r) => r.hashOk).length}/${sos.length}`,
    FIRST_CHUNK_TO_WINDOW_8_MS: pct(sos.map((r) => r.firstChunkToWindowMs && r.firstChunkToWindowMs[8]), 50),
    FIRST_CHUNK_TO_WINDOW_16_MS: pct(sos.map((r) => r.firstChunkToWindowMs && r.firstChunkToWindowMs[16]), 50),
    FIRST_CHUNK_TO_WINDOW_32_MS: pct(sos.map((r) => r.firstChunkToWindowMs && r.firstChunkToWindowMs[32]), 50),
    pageErrors: consoleErr,
    runs,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ RAW_DC_MBPS_P50: report.RAW_DC_MBPS_P50, RAW_DC_MBPS_P95: report.RAW_DC_MBPS_P95, SOS_FILE_MBPS_P50: report.SOS_FILE_MBPS_P50, SOS_FILE_MBPS_P95: report.SOS_FILE_MBPS_P95, RATIO: report.SOS_PROTOCOL_EFFICIENCY_RATIO, HASHES: report.ALL_HASHES_OK, delay: DELAY_MS, root: report.root, LARGE: report.SOS_LARGE_FILE_MBPS_P50, ACK_TO: report.ACK_TIMEOUT_COUNT, RETX: report.RETRANSMIT_COUNT, DOWN: report.WINDOW_DOWNSHIFTS, OK: report.TRANSFER_SUCCESS, W8: report.FIRST_CHUNK_TO_WINDOW_8_MS, W16: report.FIRST_CHUNK_TO_WINDOW_16_MS, W32: report.FIRST_CHUNK_TO_WINDOW_32_MS }));
  await browser.close();
  server.close();
})().catch((e) => { console.error('BENCH_CRASH', e && e.stack || e); process.exit(2); });
