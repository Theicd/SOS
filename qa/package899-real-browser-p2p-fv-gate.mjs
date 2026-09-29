#!/usr/bin/env node
/**
 * Package 899 Phase F+V — REAL visible Chromium (two contexts) against the exact local RC tree.
 *  1. App DataChannel via real signaling → state machine history observed in-browser.
 *  2. App E2EE text (P2pSecureV2) both directions.
 *  3. App file transfer (App.sendP2PFile) 1/5/10/25 MB both directions, SHA-256 verified at receiver.
 *  4. Controlled encrypted Blossom fallback (image / video / voice) against a mocked Blossom host:
 *     P2P forced unavailable → client-side encryption → ciphertext upload → recipient decrypts.
 * Disposable identities only. Never logs keys / nsec / SDP / file keys.
 * Run: node qa/package899-real-browser-p2p-fv-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey, utils } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.RB_ROOT || path.resolve(__dirname, '..'));
const OUT = process.env.RB_OUT || path.join(__dirname, 'package899-real-browser-p2p-fv-report.json');
const CONNECT_ONLY = process.env.RB_CONNECT_ONLY === '1';
const SIZES_MB = (process.env.RB_SIZES || '1,5,10,25').split(',').map(Number).filter((n) => n > 0);
const MOCK_BLOSSOM = 'https://blossom.qa.mock';
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const report = {
  gate: 'PACKAGE899_REAL_BROWSER_P2P_FV', ts: new Date().toISOString(), status: 'FAIL',
  connect: {}, text: {}, files: [], fallback: [], security: {}, gates: {},
};

async function boot(page, base, key, label) {
  await page.goto(base + '?rb-fv=1&u=' + label, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.createNewIdentityExplicit && !!window.NostrApp?.dataChannel && !!window.NostrApp?.subscribeP2PFileProgress, { timeout: 90000 });
  const created = await page.evaluate(({ k }) => {
    const App = window.NostrApp;
    const c = App.createNewIdentityExplicit({ privateKeyHex: k });
    const SA = App.SessionAuthority || window.SosSessionAuthority;
    if (SA?.bindCurrentSession) SA.bindCurrentSession({ accountPubkey: c.publicKey, bump: true });
    return { ok: !!(c && c.ok), pub: String(c?.publicKey || App.publicKey || '').toLowerCase() };
  }, { k: key });
  await sleep(2500);
  // guest boot שקדם ל-identity משאיר guestMode=true ובלי sub ל-25055; טעינה מחדש = משתמש מחובר חוזר
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction((pub) => {
    const App = window.NostrApp;
    return !!App?.dataChannel && !!App?.subscribeP2PFileProgress && String(App.publicKey || '').toLowerCase() === pub && App.guestMode !== true;
  }, created.pub, { timeout: 90000 }).catch(async (e) => {
    const st = await page.evaluate(() => ({ pub: String(window.NostrApp?.publicKey || '').slice(0, 12), guest: window.NostrApp?.guestMode, dc: !!window.NostrApp?.dataChannel, prog: !!window.NostrApp?.subscribeP2PFileProgress })).catch((x) => String(x));
    throw new Error(`boot ${label} post-reload not ready: ${JSON.stringify(st)} want=${created.pub.slice(0, 12)} ${e.message}`);
  });
  return page.evaluate(async ({ mock, c }) => {
    const App = window.NostrApp;
    App.blossomServers = [{ url: mock }];
    await new Promise((r) => setTimeout(r, 1500));
    return { ok: c.ok, pub: c.pub, hasConnState: !!App.P2pConn, guest: App.guestMode === true };
  }, { mock: MOCK_BLOSSOM, c: created });
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
  await page.evaluate(() => {
    const App = window.NostrApp;
    window.__fv = { text: [], recv: {}, progress: [] };
    App.dataChannel.subscribeIncomingMessages((peer, m) => { try { window.__fv.text.push(String((m && (m.content || m.text)) || '')); } catch (_) {} });
    const origPersist = App.persistChatP2PMedia;
    App.persistChatP2PMedia = async (fileId, blob, meta) => {
      try {
        const buf = await blob.arrayBuffer();
        const d = await crypto.subtle.digest('SHA-256', buf);
        window.__fv.persistCount = window.__fv.persistCount || {};
        window.__fv.persistCount[fileId] = (window.__fv.persistCount[fileId] || 0) + 1;
        window.__fv.recv[fileId] = { size: buf.byteLength, hash: Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join(''), at: performance.now() };
      } catch (_) {}
      if (typeof origPersist === 'function') return origPersist(fileId, blob, meta);
    };
    App.subscribeP2PFileProgress((e) => { if (e && e.fileId) window.__fv.progress.push({ fileId: e.fileId, status: e.status, direction: e.direction, failureCode: e.failureCode || null, p2pFailureCode: e.p2pFailureCode || null, at: performance.now() }); });
  });
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
  const consoleLines = [];
  const DUMP = process.env.RB_DUMP || '';
  const dumpLines = [];

  const browser = await chromium.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctxA = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  const ctxB = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  for (const ctx of [ctxA, ctxB]) {
    await installMockBlossom(ctx, store, mockReq);
    ctx.on('request', (r) => {
      const m = r.method();
      if ((m === 'PUT' || m === 'POST') && /\/(upload|media|api\/v1\/upload|api\/upload)$/.test(new URL(r.url()).pathname) && !r.url().startsWith(MOCK_BLOSSOM)) foreignUploads.push(new URL(r.url()).host);
    });
  }
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const sigLines = { A: [], B: [] };
  for (const [p, n] of [[A, 'A'], [B, 'B']]) p.on('console', (m) => {
    const t = m.text();
    if (consoleLines.length < 20000) consoleLines.push(t);
    if (DUMP && (process.env.RB_DUMP_ALL || /CHAT\/P2P|QA\]|P2P-FILE/.test(t)) && dumpLines.length < 6000) dumpLines.push(`${Date.now()} ${n} ${t.slice(0, 220)}`);
    if (/\[P2P-SIG\]|\[DC\]|\[P2P_CONN_FAIL\]|\[SECURITY\/|\[P2P-ICE\]|\[P2P-DC\]/.test(t) && sigLines[n].length < 400) sigLines[n].push(t.slice(0, 200));
  });

  try {
    const a = await boot(A, base, keyA, 'A');
    const b = await boot(B, base, keyB, 'B');
    report.connect.boot = { a: a.ok, b: b.ok, connStateModule: a.hasConnState && b.hasConnState };
    await A.evaluate((p) => { window.NostrApp.ensureChatContact?.(p, { name: 'PeerB' }); window.NostrApp.showChatConversation?.(p); }, pubB);
    await B.evaluate((p) => { window.NostrApp.ensureChatContact?.(p, { name: 'PeerA' }); window.NostrApp.showChatConversation?.(p); }, pubA);
    await instrument(A);
    await instrument(B);
    await sleep(1500);

    // 1. connect
    const t0 = Date.now();
    await Promise.all([A.evaluate((p) => window.NostrApp.dataChannel.connect(p), pubB), B.evaluate((p) => window.NostrApp.dataChannel.connect(p), pubA)]);
    let ready = false;
    for (let i = 0; i < 90 && !ready; i++) {
      const [sa, sb] = await Promise.all([
        A.evaluate((p) => { const d = window.NostrApp.dataChannel; return { h: d.isHealthy ? d.isHealthy(p) : d.isConnected(p), s: !!window.NostrApp.P2pSecureV2?.isPeerSecureP2pV2(p) }; }, pubB),
        B.evaluate((p) => { const d = window.NostrApp.dataChannel; return { h: d.isHealthy ? d.isHealthy(p) : d.isConnected(p), s: !!window.NostrApp.P2pSecureV2?.isPeerSecureP2pV2(p) }; }, pubA),
      ]);
      ready = sa.h && sb.h && sa.s && sb.s;
      if (!ready && i > 0 && i % 20 === 0) {
        await Promise.all([A.evaluate((p) => window.NostrApp.dataChannel.connect(p), pubB), B.evaluate((p) => window.NostrApp.dataChannel.connect(p), pubA)]);
      }
      if (!ready) await sleep(1000);
    }
    report.connect.setupMs = Date.now() - t0;
    report.connect.ready = ready;
    report.connect.diagA = await A.evaluate((p) => window.NostrApp.dataChannel.getDiagnostics?.(p) || { status: window.NostrApp.dataChannel.getStatus(p), history: [] }, pubB);
    report.connect.diagB = await B.evaluate((p) => window.NostrApp.dataChannel.getDiagnostics?.(p) || { status: window.NostrApp.dataChannel.getStatus(p), history: [] }, pubA);
    report.connect.relaysA = await A.evaluate(() => (window.NostrApp.relayUrls || []).length);
    report.connect.sigLines = sigLines;
    console.log('CONNECT', ready, report.connect.setupMs + 'ms', (report.connect.diagA.history || []).join(','));
    if (CONNECT_ONLY) { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); if (DUMP) fs.writeFileSync(DUMP, dumpLines.join('\n')); await browser.close(); server.close(); process.exit(ready ? 0 : 1); }

    if (ready && Number(process.env.RB_SETTLE_MS) > 0) await sleep(Number(process.env.RB_SETTLE_MS));
    if (ready) {
      // 2. text both directions (app E2EE path)
      for (const [S, R, peer, dir] of [[A, B, pubB, 'A2B'], [B, A, pubA, 'B2A']]) {
        const tok = `FV-TEXT-${dir}-${Date.now()}`;
        const sent = await S.evaluate(({ p, tok }) => window.NostrApp.dataChannel.send(p, { id: 'fv-' + tok, content: tok, createdAt: Math.floor(Date.now() / 1000) }), { p: peer, tok });
        let got = false;
        for (let i = 0; i < 30 && !got; i++) { got = await R.evaluate((t) => window.__fv.text.some((x) => x.includes(t)), tok); if (!got) await sleep(200); }
        report.text[dir] = { sent, received: got };
      }

      // 3. files both directions
      for (const [S, R, peer, dir] of [[A, B, pubB, 'A2B'], [B, A, pubA, 'B2A']]) {
        for (const mb of SIZES_MB) {
          const size = Math.round(mb * 1024 * 1024);
          const STATS = !!process.env.RB_STATS;
          const startStats = (P, other) => P.evaluate((o) => {
            const pc = window.NostrApp.dataChannel.getChatPC(o);
            const t0 = performance.now();
            window.__st = [];
            window.__stT = setInterval(async () => {
              try {
                const r = await pc.getStats();
                let dcS = 0, dcR = 0, cpS = 0, cpR = 0, rtt = null;
                r.forEach((s) => {
                  if (s.type === 'data-channel' && s.label === 'file-transfer') { dcS += s.bytesSent || 0; dcR += s.bytesReceived || 0; }
                  if (s.type === 'candidate-pair' && s.nominated) { cpS = s.bytesSent || 0; cpR = s.bytesReceived || 0; rtt = s.currentRoundTripTime; }
                });
                window.__st.push([Math.round(performance.now() - t0), dcS, dcR, cpS, cpR, rtt]);
              } catch (_) {}
            }, 100);
          }, other);
          const stopStats = (P) => P.evaluate(() => { clearInterval(window.__stT); return window.__st; });
          if (STATS) { await startStats(S, peer); await startStats(R, dir === 'A2B' ? pubA : pubB); }
          const PROF = process.env.RB_PROFILE && !report._profiled;
          const cdps = [];
          if (PROF) { for (const P of [S, R]) { const c = await P.context().newCDPSession(P); await c.send('Profiler.enable'); await c.send('Profiler.setSamplingInterval', { interval: 500 }); await c.send('Profiler.start'); cdps.push(c); } }
          const res = await S.evaluate(async ({ p, size }) => {
            const bytes = new Uint8Array(size);
            for (let o = 0; o < size; o += 65536) crypto.getRandomValues(bytes.subarray(o, Math.min(size, o + 65536)));
            const d = await crypto.subtle.digest('SHA-256', bytes);
            const hash = Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
            const file = new File([bytes], `fv-${size}.bin`, { type: 'application/octet-stream' });
            const t = performance.now();
            const fileId = await window.NostrApp.sendP2PFile(p, file);
            return { fileId, hash, t };
          }, { p: peer, size });
          let recv = null;
          const w0 = Date.now();
          while (!recv && Date.now() - w0 < 180000) {
            recv = await R.evaluate((fid) => window.__fv.recv[fid] || null, res.fileId);
            if (!recv) {
              const failed = await S.evaluate((fid) => window.__fv.progress.find((e) => e.fileId === fid && (e.status === 'failed' || e.status === 'complete-blossom')) || null, res.fileId);
              if (failed) break;
              await sleep(250);
            }
          }
          const sendDone = await S.evaluate((fid) => window.__fv.progress.filter((e) => e.fileId === fid && e.direction === 'send').map((e) => e.status + (e.p2pFailureCode ? ':' + e.p2pFailureCode : '')).slice(-3), res.fileId);
          const ms = recv ? Math.round(Date.now() - w0) : null;
          const row = { dir, mb, hashMatch: !!recv && recv.hash === res.hash && recv.size === size, transport: sendDone.some((s) => s.startsWith('complete-blossom')) ? 'BLOSSOM' : 'P2P', ms, mbpsApprox: ms ? Math.round(((size * 8) / (ms / 1000) / 1e6) * 10) / 10 : null, sendStatus: sendDone };
          const tl = async (P) => P.evaluate((fid) => { const ev = window.__fv.progress.filter((e) => e.fileId === fid); const t0 = ev.length ? ev[0].at : 0; const out = []; let last = ''; for (const e of ev) { const k = e.direction + ':' + e.status; if (k !== last) out.push(k + '@' + Math.round(e.at - t0)); last = k; } return out.slice(0, 40); }, res.fileId);
          await sleep(400);
          row.receiverLogicalMessages = await R.evaluate(({ fid, from }) => {
            const list = (window.NostrApp.getChatMessages && window.NostrApp.getChatMessages(from)) || [];
            return list.filter((m) => m && m.attachment && (m.attachment.fileId === fid || m.id === fid || m.attachment.id === fid)).length;
          }, { fid: res.fileId, from: dir === 'A2B' ? pubA : pubB });
          row.receiverPersistCount = await R.evaluate((fid) => (window.__fv.persistCount || {})[fid] || 0, res.fileId);
          row.senderTimeline = await tl(S);
          row.receiverTimeline = await tl(R);
          if (STATS) { row.statsSender = await stopStats(S); row.statsReceiver = await stopStats(R); }
          if (PROF) {
            report._profiled = true;
            for (const [i, c] of cdps.entries()) {
              const { profile } = await c.send('Profiler.stop');
              const self = new Map();
              const byId = new Map(profile.nodes.map((n) => [n.id, n]));
              const dt = profile.timeDeltas || [];
              (profile.samples || []).forEach((id, k) => { const n = byId.get(id); const f = n.callFrame; const key = `${f.functionName || '(anon)'} ${String(f.url).split('/').pop()}:${f.lineNumber + 1}`; self.set(key, (self.get(key) || 0) + (dt[k] || 0) / 1000); });
              const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${Math.round(v)}ms ${k}`);
              fs.writeFileSync(`qa/.rb-profile-${i === 0 ? 'sender' : 'receiver'}.txt`, top.join('\n'));
            }
          }
          report.files.push(row);
          console.log('FILE', dir, mb + 'MB', row.hashMatch, row.transport, row.ms + 'ms');
        }
      }
    }

    // 4. controlled encrypted Blossom fallback (image / video / voice)
    const media = [
      { name: 'fv.png', type: 'image/png', size: 300 * 1024 },
      { name: 'fv.mp4', type: 'video/mp4', size: 2 * 1024 * 1024 },
      { name: 'fv-voice.webm', type: 'audio/webm', size: 150 * 1024 },
    ];
    await A.evaluate(() => {
      const App = window.NostrApp;
      const dc = App.dataChannel;
      window.__fvOrig = { isHealthy: dc.isHealthy, isConnected: dc.isConnected, waitForOpen: dc.waitForOpen, getPersistentConnection: App.getPersistentConnection, publishChatMessage: App.publishChatMessage, setChatFileAttachment: App.setChatFileAttachment };
      dc.isHealthy = () => false;
      dc.isConnected = () => false;
      dc.waitForOpen = async () => ({ ok: false, failure: 'PEER_OFFLINE', negotiationStarted: false, waitedMs: 1 });
      App.getPersistentConnection = () => null;
      window.__fvDesc = {};
      App.setChatFileAttachment = function (peer, att) {
        try {
          if (att && att.type === 'encrypted-media' && att.fileId) {
            const clean = {};
            Object.keys(att).forEach((k) => { if (k[0] !== '_') clean[k] = att[k]; });
            window.__fvDesc[att.fileId] = JSON.parse(JSON.stringify(clean));
          }
        } catch (_) {}
        return window.__fvOrig.setChatFileAttachment ? window.__fvOrig.setChatFileAttachment.apply(this, arguments) : undefined;
      };
      App.publishChatMessage = async () => ({ ok: true, qaCaptured: true });
    });
    const fbDescs = [];
    for (const m of media) {
      const up0 = store.size;
      const res = await A.evaluate(async ({ p, m }) => {
        const marker = new TextEncoder().encode('SOS-PLAINTEXT-MARKER-');
        const bytes = new Uint8Array(m.size);
        for (let o = 0; o < m.size; o += marker.length) bytes.set(marker.subarray(0, Math.min(marker.length, m.size - o)), o);
        const d = await crypto.subtle.digest('SHA-256', bytes);
        const hash = Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
        const t = performance.now();
        const fileId = await window.NostrApp.sendP2PFile(p, new File([bytes], m.name, { type: m.type }));
        let st = null;
        for (let i = 0; i < 200 && !st; i++) {
          st = window.__fv.progress.find((e) => e.fileId === fileId && (e.status === 'complete-blossom' || e.status === 'failed')) || null;
          if (!st) await new Promise((r) => setTimeout(r, 100));
        }
        return { fileId, hash, status: st && st.status, p2pFailureCode: st && st.p2pFailureCode, failureCode: st && st.failureCode, ms: Math.round(performance.now() - t), desc: window.__fvDesc[fileId] || null };
      }, { p: pubB, m });
      const uploaded = [...store.values()].slice(up0);
      const marker = Buffer.from('SOS-PLAINTEXT-MARKER-');
      const ciphertextOnly = uploaded.length > 0 && uploaded.every((u) => !u.body.includes(marker));
      let dec = null;
      if (res.desc) {
        dec = await B.evaluate(async ({ desc, a, b }) => {
          try {
            const r = await window.NostrApp.resolveServerMediaAttachment(desc, { messageId: desc.clientMessageId || desc.logicalMessageId, sender: a, recipient: b });
            const buf = await r.blob.arrayBuffer();
            const d = await crypto.subtle.digest('SHA-256', buf);
            return { ok: true, size: buf.byteLength, hash: Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('') };
          } catch (e) { return { ok: false, code: e && (e.code || e.message) }; }
        }, { desc: res.desc, a: pubA, b: pubB });
      }
      const row = {
        media: m.type, size: m.size, status: res.status, p2pFailureCode: res.p2pFailureCode, ms: res.ms,
        uploads: uploaded.length, ciphertextOnly, descriptorEncrypted: !!res.desc && res.desc.type === 'encrypted-media',
        recipientDecrypt: !!dec && dec.ok && dec.hash === res.hash && dec.size === m.size, decErr: dec && !dec.ok ? dec.code : undefined,
      };
      report.fallback.push(row);
      if (res.desc) fbDescs.push(res.desc);
      console.log('FALLBACK', m.type, row.status, row.p2pFailureCode, 'cipherOnly=' + ciphertextOnly, 'decrypt=' + row.recipientDecrypt);
    }
    // descriptor-bound local plaintext cache (real IndexedDB on B)
    if (fbDescs[0]) {
      report.cacheBinding = await B.evaluate(async ({ desc, a, b }) => {
        const App = window.NostrApp;
        const ctx = { messageId: desc.clientMessageId || desc.logicalMessageId, sender: a, recipient: b };
        const clone = () => { const c = JSON.parse(JSON.stringify(desc)); delete c.url; delete c.dataUrl; return c; };
        const rk = () => { const k = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...k)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
        const hit = async (att) => { try { return !!(await App.resolveChatMediaSrc(att)); } catch (_) { return false; } };
        const out = {};
        const L = clone();
        await App.resolveServerMediaAttachment(L, ctx);
        const src1 = await App.resolveChatMediaSrc(L);
        await new Promise((r) => setTimeout(r, 1000));
        const bound = typeof App.encryptedMediaCacheKey === 'function' ? await App.encryptedMediaCacheKey(clone()) : '';
        out.boundKeyFormat = /^p2p-file-eb-[0-9a-f]{40}$/.test(bound);
        out.boundEntry = !!(await App.getChatMediaFromCache(bound));
        out.attachmentIdEntry = !!(await App.getChatMediaFromCache('p2p-file-' + desc.attachmentId));
        out.fileIdEntry = desc.fileId ? !!(await App.getChatMediaFromCache('p2p-file-' + desc.fileId)) : false;
        out.legitReplayHit = await hit(clone());
        const T = clone(); T.enc = { ...T.enc, key: rk() };
        out.tamperedKeyCacheHit = await hit(T);
        try { await App.resolveServerMediaAttachment(T, ctx); out.tamperedKeyDecrypt = 'ok'; } catch (e) { out.tamperedKeyDecrypt = String((e && e.code) || 'error'); }
        const S = clone(); S.cipher = { ...S.cipher, sha256: '0'.repeat(64) };
        out.staleCipherCacheHit = await hit(S);
        const I = clone(); I.enc = { ...I.enc, key: rk() }; I.cacheKey = bound; I.fileId = desc.fileId || desc.attachmentId; I._localObjectUrl = src1; I._resolvedBlob = {};
        const ins = App.inspectIncomingChatAttachment(I, { network: true });
        out.injectedLocalFieldsStripped = !!ins.ok && !('cacheKey' in I) && !('fileId' in I) && !('_localObjectUrl' in I) && !('_resolvedBlob' in I);
        out.injectedCacheHit = await hit(I);
        const J = clone(); J.enc = { ...J.enc, key: rk() }; J.cacheKey = 'p2p-file-' + desc.attachmentId;
        out.legacyCacheKeyHit = await hit(J);
        const K = clone(); K.enc = { ...K.enc, key: rk() }; K._resolvedBlob = {}; K._localObjectUrl = src1;
        try { const r = await App.resolveServerMediaAttachment(K, ctx); out.fakeResolvedBlobAccepted = !!r && r.objectUrl === src1; } catch (_) { out.fakeResolvedBlobAccepted = false; }
        const insR = App.inspectIncomingChatAttachment(L);
        out.restoreKeepsLiveState = !!insR.ok && L._resolvedBlob instanceof Blob && typeof L._localObjectUrl === 'string';
        return out;
      }, { desc: fbDescs[0], a: pubA, b: pubB });
      console.log('CACHE_BINDING', JSON.stringify(report.cacheBinding));
    }
    // crypto failure during fallback (real browser) → fail closed
    const cf = await A.evaluate(async (p) => {
      const App = window.NostrApp;
      const orig = App.uploadEncryptedMediaToBlossom;
      App.uploadEncryptedMediaToBlossom = async () => { const e = new Error('MEDIA_E2EE_ENCRYPT_FAILED'); e.code = 'MEDIA_E2EE_ENCRYPT_FAILED'; throw e; };
      const fileId = await App.sendP2PFile(p, new File([new Uint8Array(4096)], 'cf.png', { type: 'image/png' }));
      let st = null;
      for (let i = 0; i < 100 && !st; i++) { st = window.__fv.progress.find((e) => e.fileId === fileId && (e.status === 'complete-blossom' || e.status === 'failed')) || null; if (!st) await new Promise((r) => setTimeout(r, 50)); }
      App.uploadEncryptedMediaToBlossom = orig;
      return st;
    }, pubB);
    report.security.cryptoFailureDuringFallback = cf;
    await A.evaluate(() => {
      const App = window.NostrApp; const o = window.__fvOrig; const dc = App.dataChannel;
      dc.isHealthy = o.isHealthy; dc.isConnected = o.isConnected; dc.waitForOpen = o.waitForOpen;
      App.getPersistentConnection = o.getPersistentConnection; App.publishChatMessage = o.publishChatMessage; App.setChatFileAttachment = o.setChatFileAttachment;
    });

    // security / privacy
    const allLog = consoleLines.join('\n');
    report.security.foreignPlaintextUploads = foreignUploads.length;
    report.security.nsecInLogs = /nsec1[0-9a-z]{20,}/.test(allLog);
    report.security.sdpInLogs = /a=ice-pwd|a=fingerprint/.test(allLog);
    report.security.privKeyInLogs = allLog.includes(keyA) || allLog.includes(keyB);
    report.security.p2pAttemptLines = consoleLines.filter((l) => l.includes('[P2P_ATTEMPT]')).length;
    report.security.mockRequests = mockReq.length;

    const files = report.files;
    const g = report.gates;
    g.REAL_BROWSER_P2P_CONNECT = ready ? 'PASS' : 'FAIL';
    g.REAL_BROWSER_P2P_TEXT_GATE = report.text.A2B?.received && report.text.B2A?.received ? 'PASS' : 'FAIL';
    g.REAL_BROWSER_P2P_FILE_GATE = files.length === SIZES_MB.length * 2 && files.every((f) => f.hashMatch && f.transport === 'P2P') ? 'PASS' : 'FAIL';
    g.NO_DUPLICATE_LOGICAL_MESSAGE = files.length > 0 && files.every((f) => f.receiverLogicalMessages <= 1 && f.receiverPersistCount === 1) ? 'PASS' : 'FAIL';
    g.ALL_HASHES_MATCH = files.length > 0 && files.every((f) => f.hashMatch) && report.fallback.every((f) => f.recipientDecrypt) ? 'PASS' : 'FAIL';
    g.ENCRYPTED_BLOSSOM_FALLBACK_E2E_GATE = report.fallback.length === 3 && report.fallback.every((f) => f.status === 'complete-blossom' && f.p2pFailureCode === 'PEER_OFFLINE' && f.ciphertextOnly && f.descriptorEncrypted && f.recipientDecrypt) ? 'PASS' : 'FAIL';
    g.P2P_FALLBACK_CRYPTO_FAIL_CLOSED_REAL = cf && cf.status === 'failed' && cf.failureCode === 'ENCRYPTION_FAILED' ? 'PASS' : 'FAIL';
    const cbr = report.cacheBinding || {};
    g.DESCRIPTOR_CACHE_BINDING_GATE =
      cbr.boundKeyFormat && cbr.boundEntry && !cbr.attachmentIdEntry && !cbr.fileIdEntry && cbr.legitReplayHit &&
      !cbr.tamperedKeyCacheHit && cbr.tamperedKeyDecrypt && cbr.tamperedKeyDecrypt !== 'ok' && !cbr.staleCipherCacheHit &&
      cbr.injectedLocalFieldsStripped && !cbr.injectedCacheHit && !cbr.legacyCacheKeyHit && !cbr.fakeResolvedBlobAccepted && cbr.restoreKeepsLiveState
        ? 'PASS' : 'FAIL';
    g.REAL_BROWSER_DIAGNOSTIC_PRIVACY = !report.security.nsecInLogs && !report.security.sdpInLogs && !report.security.privKeyInLogs && foreignUploads.length === 0 ? 'PASS' : 'FAIL';
    report.status = Object.values(g).every((v) => v === 'PASS') ? 'PASS' : 'FAIL';
  } catch (e) {
    report.error = String((e && e.stack) || e).slice(0, 2000);
    console.error(e);
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    if (DUMP) fs.writeFileSync(DUMP, dumpLines.join('\n'));
    console.log(Object.entries(report.gates).map(([k, v]) => `${k}=${v}`).join('\n'));
    console.log('STATUS', report.status);
    await browser.close().catch(() => {});
    server.close();
  }
  process.exit(report.status === 'PASS' ? 0 : 1);
}

main();
