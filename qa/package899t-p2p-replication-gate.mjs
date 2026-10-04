/**
 * Package 899t — user-as-server media replication on the public Videos feed (real browsers, real P2P transfer path).
 *
 * Every client is a separate Playwright context on the Edge channel (H.264). Real WebRTC data channels between the
 * contexts; signalling over the app's own secure signalling through a local NIP-01 relay (test-only config.js
 * transform, same as the 899s gate). Media is a real H.264 MP4 (qa/fixtures/899s-h264-160x120.mp4) plus a trailing
 * ISO-BMFF `free` box (distinct SHA-256 per post, ~400 KB so throughput is measurable).
 *
 * Blossom / mirror hosts are intercepted per context: each context decides which hashes are dead (404), slow, or
 * served with wrong bytes. A "slow peer" throttles its own RTCDataChannel.send inside its page (harness-only init
 * script); no production code path is altered by the harness.
 *
 * Registered peer scenarios use fresh disposable registered identities. Guests take part over the narrow
 * GUEST_PUBLIC_MEDIA_FILE_TRANSFER path (covered end-to-end by package899t-guest-p2p-gate.mjs); the guest
 * first-paint cases here check that a peer-capable guest still never waits for peers before HTTP.
 *
 * Disposable keys only; keys / nsec / SDP are never logged or written to the report. Never deploys.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'package899t-p2p-replication-report.json');
const PORT = Number(process.env.SOS_899T_PORT || 8896);
const R_PORT = 7896;
const RELAY = `ws://127.0.0.1:${R_PORT}`;
const URL0 = `http://127.0.0.1:${PORT}/videos.html`;
const NET = 'israel-network';
const LIMITS = { FIRST_NATIVE_CARD_VISIBLE_MS: 5000, SECOND_NATIVE_CARD_READY_MS: 8000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const mkKey = () => {
  const sk = generateSecretKey();
  return { sk, hex: hex(sk), pub: getPublicKey(sk) };
};

const report = { gate: 'PACKAGE899T_P2P_REPLICATION', relay: RELAY, ts: new Date().toISOString(), results: {}, metrics: {} };
const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600));
};
const info = (k, v) => {
  report.metrics[k] = v;
  console.log('INFO', k, JSON.stringify(v).slice(0, 600));
};

// ---------------------------------------------------------------- media
const FIXTURE = fs.readFileSync(path.join(ROOT, 'qa', 'fixtures', '899s-h264-160x120.mp4'));
const MEDIA = new Map(); // hash -> Buffer
function mkMedia(label) {
  const payload = Buffer.concat([Buffer.from(`sos-899t-qa:${label}:`), crypto.randomBytes(400 * 1024)]);
  const box = Buffer.alloc(8);
  box.writeUInt32BE(8 + payload.length, 0);
  box.write('free', 4, 'ascii');
  const buf = Buffer.concat([FIXTURE, box, payload]);
  const h = crypto.createHash('sha256').update(buf).digest('hex');
  MEDIA.set(h, buf);
  return h;
}
const BLOSSOM_HOSTS = new Set(['blossom.band', 'blossom.nostr.build', 'files.sovbit.host', 'media.qa-sos.test']);

// ---------------------------------------------------------------- relay with live fan-out
function matchFilter(ev, f) {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.since && ev.created_at < f.since) return false;
  if (f.until && ev.created_at > f.until) return false;
  for (const k of Object.keys(f)) {
    if (k[0] !== '#') continue;
    const vals = f[k] || [];
    if (!(ev.tags || []).some((t) => t[0] === k.slice(1) && vals.includes(t[1]))) return false;
  }
  return true;
}
class Relay {
  constructor(port) {
    this.port = port;
    this.events = new Map();
    this.subs = new Map();
  }
  start() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port }, resolve);
      this.wss.on('error', reject);
      this.wss.on('connection', (ws) => {
        this.subs.set(ws, new Map());
        ws.on('error', () => {});
        ws.on('close', () => this.subs.delete(ws));
        ws.on('message', (d) => this.onMsg(ws, d));
      });
    });
  }
  stop() {
    for (const c of this.wss.clients) c.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
  store(ev) {
    // NIP-33 replaceable (kind 30000-39999): keep newest per pubkey+d
    if (ev.kind >= 30000 && ev.kind < 40000) {
      const d = (ev.tags.find((t) => t[0] === 'd') || [])[1] || '';
      for (const [id, old] of this.events) {
        if (old.kind === ev.kind && old.pubkey === ev.pubkey && ((old.tags.find((t) => t[0] === 'd') || [])[1] || '') === d) {
          if (old.created_at > ev.created_at) return;
          this.events.delete(id);
        }
      }
    }
    this.events.set(ev.id, ev);
  }
  publish(ev) {
    if (!verifyEvent({ ...ev })) return 0;
    this.store(ev);
    let delivered = 0;
    this.subs.forEach((subs, ws) => {
      subs.forEach((filters, id) => {
        if (filters.some((f) => matchFilter(ev, f))) {
          try {
            ws.send(JSON.stringify(['EVENT', id, ev]));
            delivered++;
          } catch (_e) {}
        }
      });
    });
    return delivered;
  }
  onMsg(ws, data) {
    let m;
    try {
      m = JSON.parse(String(data));
    } catch (_e) {
      return;
    }
    const send = (a) => {
      try {
        ws.send(JSON.stringify(a));
      } catch (_e) {}
    };
    if (!Array.isArray(m)) return;
    if (m[0] === 'EVENT') {
      const ev = m[1];
      const ok = !!ev && verifyEvent({ ...ev });
      if (ok) this.publish(ev);
      send(['OK', ev && ev.id, ok, ok ? '' : 'invalid']);
    } else if (m[0] === 'REQ') {
      const [, id, ...filters] = m;
      this.subs.get(ws)?.set(id, filters);
      const out = new Map();
      for (const f of filters) {
        let rows = Array.from(this.events.values()).filter((ev) => matchFilter(ev, f)).sort((a, b) => b.created_at - a.created_at);
        if (f.limit) rows = rows.slice(0, f.limit);
        rows.forEach((r) => out.set(r.id, r));
      }
      out.forEach((ev) => send(['EVENT', id, ev]));
      send(['EOSE', id]);
    } else if (m[0] === 'CLOSE') {
      this.subs.get(ws)?.delete(m[1]);
    }
  }
  availability(hash) {
    return Array.from(this.events.values()).filter((e) => e.kind === 30078 && e.tags.some((t) => t[0] === 't' && t[1] === 'p2p-file') && e.tags.some((t) => t[0] === 'x' && t[1] === hash));
  }
  heartbeats(pub) {
    return Array.from(this.events.values()).filter((e) => e.kind === 30078 && e.pubkey === pub && e.tags.some((t) => t[0] === 't' && t[1] === 'p2p-heartbeat'));
  }
}
const H = new Relay(R_PORT);

// ---------------------------------------------------------------- static server (test-only config transform)
const CONFIG_TRANSFORMS = { relays: false, p2p: false, sanitizer: false };
function transformConfig(src) {
  let out = src.replace(/const SAFE_DEFAULT_RELAYS = \[[^\]]*\];/, () => {
    CONFIG_TRANSFORMS.relays = true;
    return `const SAFE_DEFAULT_RELAYS = ${JSON.stringify([RELAY])};`;
  });
  out = out.replace(/const SAFE_DEFAULT_P2P_RELAYS = \[[^\]]*\];/, () => {
    CONFIG_TRANSFORMS.p2p = true;
    return `const SAFE_DEFAULT_P2P_RELAYS = ${JSON.stringify([RELAY])};`;
  });
  out = out.replace("!trimmed.startsWith('wss://')", () => {
    CONFIG_TRANSFORMS.sanitizer = true;
    return "!(trimmed.startsWith('wss://') || trimmed.startsWith('ws://127.0.0.1:'))";
  });
  return out;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/videos.html';
    const fp = path.join(ROOT, p.replace(/^\//, ''));
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404);
      res.end('nf');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (p === '/config.js') res.end(transformConfig(fs.readFileSync(fp, 'utf8')));
    else fs.createReadStream(fp).pipe(res);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e.message || e));
  }
});

// ---------------------------------------------------------------- content: 16 hash-backed native posts (newest first)
const now = Math.floor(Date.now() / 1000);
const AUTHOR = mkKey();
const P = []; // index -> { ev, hash, url }
const W0 = {}; // media not posted in the feed (held by the slow peer only) — watchdog measurement
const W1 = {}; // media posted live after boot (held by peer C) — steady-state source
function seedPosts() {
  W0.hash = mkMedia('W0');
  W0.url = `https://blossom.band/${W0.hash}.mp4`;
  W1.hash = mkMedia('W1');
  W1.url = `https://blossom.band/${W1.hash}.mp4`;
  H.publish(finalizeEvent({ kind: 0, created_at: now - 3600, tags: [['t', NET]], content: JSON.stringify({ name: 'QA 899t Author' }) }, AUTHOR.sk));
  for (let i = 0; i < 16; i++) {
    const h = mkMedia('P' + i);
    const url = `https://blossom.band/${h}.mp4`;
    const ev = finalizeEvent({ kind: 1, created_at: now - 60 - i * 30, tags: [['t', NET], ['media', 'video/mp4', url, h]], content: `qa 899t P${i}\n${url}` }, AUTHOR.sk);
    H.publish(ev);
    P.push({ ev, hash: h, url });
  }
}
const labelOfHash = (h) => {
  const k = String(h || '').slice(0, 12);
  if (k && W0.hash?.startsWith(k)) return 'W0';
  if (k && W1.hash?.startsWith(k)) return 'W1';
  const i = P.findIndex((p) => p.hash.startsWith(k));
  return i > -1 ? 'P' + i : '?';
};

// ---------------------------------------------------------------- browser
const ALLOWED_EXTERNAL_HOSTS = new Set(['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']);
const QA_LOG_RE = /^\[VIDEO_MEDIA_SOURCE\]|^\[MEDIA_REPLICA_(STORED|ADVERTISED)\]|^\[P2P-HASH\]|^\[videos\] (boot loading released|boot wave extended|media recovered via p2p|media parked for p2p recovery|empty feed auto-recovery|http candidates failed)/;
const INIT = ({ reStr }) => {
  try {
    Object.defineProperty(navigator, 'serviceWorker', { get: () => undefined, configurable: true });
  } catch (_e) {}
  const re = new RegExp(reStr);
  window.__qaLog = [];
  ['log', 'warn'].forEach((level) => {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      try {
        if (typeof args[0] === 'string' && re.test(args[0])) {
          let data = null;
          try {
            data = args[1] === undefined ? null : JSON.parse(JSON.stringify(args[1]));
          } catch (_e) {}
          window.__qaLog.push({ t: Math.round(performance.now()), text: args[0], data });
        }
      } catch (_e) {}
      return orig(...args);
    };
  });
  // harness-only slow peer: throttles this page's outgoing data-channel traffic while window.__qaSlowDcMs > 0
  try {
    const origSend = RTCDataChannel.prototype.send;
    let chain = Promise.resolve();
    RTCDataChannel.prototype.send = function (data) {
      const ms = Number(window.__qaSlowDcMs) || 0;
      if (!ms) return origSend.call(this, data);
      const ch = this;
      chain = chain.then(() => new Promise((r) => setTimeout(r, ms))).then(() => {
        try {
          if (ch.readyState === 'open') origSend.call(ch, data);
        } catch (_e) {}
      });
      return undefined;
    };
  } catch (_e) {}
  // harness-only: the identity-setup document must not pre-fetch media over WebRTC (flag dies with the reload)
  try {
    const OrigPC = window.RTCPeerConnection;
    window.RTCPeerConnection = function (...args) {
      if (window.__qaNoPeer) throw new Error('qa-setup-no-peer');
      return new OrigPC(...args);
    };
    window.RTCPeerConnection.prototype = OrigPC.prototype;
  } catch (_e) {}
  // first paint: first native card visible after boot release; second native card ready
  window.__qaT = {};
  const tick = () => {
    try {
      const released = !document.body.classList.contains('videos-boot-loading');
      const ready = Array.from(document.querySelectorAll('.videos-feed__card[data-event-id]')).filter((c) => {
        if (c.dataset.mediaReady !== 'ready' || c.style.display === 'none') return false;
        const m = c.querySelector('.videos-feed__media');
        const v = c.querySelector('video');
        return m && m.dataset.mediaType === 'file' && v && v.readyState >= 2;
      });
      if (released && ready.length >= 1 && !window.__qaT.first) window.__qaT.first = Math.round(performance.now());
      if (ready.length >= 2 && !window.__qaT.second) window.__qaT.second = Math.round(performance.now());
    } catch (_e) {}
    if (!window.__qaT.second || !window.__qaT.first) setTimeout(tick, 50);
  };
  document.addEventListener('DOMContentLoaded', tick);
};

let browser = null;
const contexts = [];
async function newClient(label, { dead = [], slow = [], badBlossom = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, serviceWorkers: 'block' });
  const u = { label, ctx, st: { setup: false, dead: new Set(dead), slow: new Set(slow), slowMs: 9000, badBlossom: new Set(badBlossom) }, media: [], homeClicks: 0 };
  await ctx.routeWebSocket(new RegExp(`^ws://127\\.0\\.0\\.1:${R_PORT}`), (ws) => ws.connectToServer());
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    let url;
    try {
      url = new URL(req.url());
    } catch (_e) {
      return route.abort();
    }
    const host = url.hostname;
    if (host === '127.0.0.1' || ALLOWED_EXTERNAL_HOSTS.has(host)) return route.continue();
    if (!BLOSSOM_HOSTS.has(host)) return route.abort();
    const h = (url.pathname.match(/([0-9a-f]{64})/) || [])[1] || '';
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range', 'Cache-Control': 'no-store' };
    u.media.push({ t: Date.now(), host, h: h.slice(0, 12), method: req.method(), range: req.headers()['range'] || '' });
    const buf = MEDIA.get(h);
    if (!buf || u.st.setup || u.st.dead.has(h)) return route.fulfill({ status: 404, headers: cors, body: 'not found' });
    if (u.st.slow.has(h)) await sleep(u.st.slowMs);
    let body = buf;
    if (u.st.badBlossom.has(h) && host === 'blossom.band') body = Buffer.concat([buf.subarray(0, buf.length - 64), Buffer.alloc(64, 0x5a)]);
    const headers = { ...cors, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };
    if (req.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...headers, 'Content-Length': String(body.length) }, body: '' });
    const range = req.headers()['range'];
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      const s = m[1] ? Number(m[1]) : 0;
      const e = Math.min(m[2] ? Number(m[2]) : body.length - 1, body.length - 1);
      return route.fulfill({ status: 206, headers: { ...headers, 'Content-Range': `bytes ${s}-${e}/${body.length}` }, body: body.subarray(s, e + 1) });
    }
    return route.fulfill({ status: 200, headers, body });
  });
  await ctx.addInitScript(INIT, { reStr: QA_LOG_RE.source });
  u.page = await ctx.newPage();
  u.consoleAll = [];
  u.page.on('console', (m) => {
    if (u.consoleAll.length < 30000) u.consoleAll.push(m.text());
  });
  contexts.push(u);
  return u;
}

const appReady = (page) =>
  page.waitForFunction(() => !!window.NostrApp?.downloadVideoWithP2P && !!window.NostrApp?.PeerExchange && typeof window.NostrApp?.canDownloadFromPeers === 'function', null, { timeout: 90000 });

async function openGuest(u) {
  await u.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await appReady(u.page);
}

// fresh registered identity: setup load with all media blocked (nothing cached), then the measured load
async function openRegistered(u) {
  const key = mkKey();
  u.pub = key.pub;
  u.st.setup = true;
  await u.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await appReady(u.page);
  await u.page.evaluate((k) => {
    window.__qaNoPeer = true;
    const App = window.NostrApp;
    const c = App.createNewIdentityExplicit({ privateKeyHex: k });
    const SA = App.SessionAuthority || window.SosSessionAuthority;
    if (SA?.bindCurrentSession) SA.bindCurrentSession({ accountPubkey: c.publicKey, bump: true });
    return !!(c && c.ok);
  }, key.hex);
  await sleep(2500);
  const cachedAfterSetup = await u.page.evaluate(async (hashes) => {
    const App = window.NostrApp;
    let n = 0;
    for (const h of hashes) if (await App.getCachedMedia?.(h)) n++;
    return n;
  }, P.map((p) => p.hash));
  u.st.setup = false;
  await u.page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await u.page.waitForFunction(
    (pub) => String(window.NostrApp?.publicKey || '').toLowerCase() === pub && window.NostrApp.guestMode !== true && window.NostrApp.canDownloadFromPeers?.() === true,
    key.pub,
    { timeout: 90000 },
  );
  return { cachedAfterSetup };
}

const waitLeader = (u) => u.page.waitForFunction(() => window.NostrApp?.isP2PLeader?.() === true, null, { timeout: 30000 }).then(() => true).catch(() => false);
const qaLog = (u) => u.page.evaluate(() => window.__qaLog.slice());
const firstPaint = (u) => u.page.evaluate(() => ({ ...window.__qaT }));
const sources = async (u) => (await qaLog(u)).filter((l) => l.text.startsWith('[VIDEO_MEDIA_SOURCE]')).map((l) => ({ src: l.text.split('=')[1], label: labelOfHash(l.data?.hash), ...l.data }));
async function poll(fn, ms, step = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}
async function hashState(u, h) {
  return u.page.evaluate(async (hash) => {
    const App = window.NostrApp;
    const shaOf = async (blob) => {
      const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
    };
    const cached = await App.getCachedMedia(hash);
    const avail = App.getAvailableFiles().get(hash);
    let availBlob = avail && avail.blob;
    if (!availBlob && avail) {
      const c2 = await App.getCachedMedia(hash);
      availBlob = c2 && c2.blob;
    }
    return {
      cache: !!(cached && cached.blob),
      cacheShaOk: !!(cached && cached.blob) && (await shaOf(cached.blob)) === hash,
      availableFiles: !!avail,
      availableShaOk: !!availBlob && (await shaOf(availBlob)) === hash,
      availableFilesCount: App.getAvailableFiles().size,
    };
  }, h);
}
async function seedFromBlossom(u, idx) {
  const item = typeof idx === 'number' ? P[idx] : idx;
  return u.page.evaluate(async ({ url, hash }) => {
    try {
      const r = await window.NostrApp.downloadVideoWithP2P(url, hash, 'video/mp4', { mode: 'PERSIST_REPLICA', allowHttpFallback: true, verifyHash: true, httpCandidates: [url] });
      return { ok: true, source: r.source, mediaSource: r.mediaSource || r.source };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }, { url: item.url, hash: item.hash });
}
async function cardState(u, idx) {
  return u.page.evaluate((id) => {
    const c = document.querySelector(`.videos-feed__card[data-event-id="${id}"]`);
    const v = c && c.querySelector('video');
    return { mounted: !!c, ready: !!c && c.dataset.mediaReady === 'ready' && c.style.display !== 'none', readyState: v ? v.readyState : -1, src: v ? String(v.dataset.mediaSource || '').replace(/[0-9a-f]{64}/, '<hash>') : '' };
  }, P[idx].ev.id);
}

// ---------------------------------------------------------------- main
async function main() {
  await H.start();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  seedPosts();
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  report.browser = `msedge ${browser.version()}`;

  // ================= A -> B -> C replication (X = P0) =================
  const X = P[0].hash;
  const A = await newClient('A');
  const aSetup = await openRegistered(A);
  const aLeader = await waitLeader(A);
  const aSeed = await seedFromBlossom(A, 0);
  await A.page.evaluate(() => window.NostrApp.sendHeartbeat?.());
  await poll(async () => H.availability(X).some((e) => e.pubkey === A.pub), 10000);
  await poll(async () => H.heartbeats(A.pub).some((e) => (JSON.parse(e.content || '{}').files || 0) >= 1), 10000);
  const aState = await hashState(A, X);
  const aFeedSrc = (await sources(A)).find((s) => s.label === 'P0' && s.src === 'blossom-full');
  const aFromBlossom = aSeed.ok && (aSeed.mediaSource === 'blossom-full' || (aSeed.mediaSource === 'cache' && !!aFeedSrc));
  const aHeartbeat = H.heartbeats(A.pub).map((e) => JSON.parse(e.content || '{}').files || 0).reduce((m, x) => Math.max(m, x), 0);
  report.A_CACHE_CONTAINS_HASH = aState.cache && aState.cacheShaOk;
  report.A_AVAILABLE_FILES_CONTAINS_HASH = aState.availableFiles;
  report.A_HEARTBEAT_FILES = aHeartbeat;
  set('A_ACQUIRES_FROM_BLOSSOM_AND_ADVERTISES', aFromBlossom && report.A_CACHE_CONTAINS_HASH && report.A_AVAILABLE_FILES_CONTAINS_HASH && aHeartbeat >= 1 && H.availability(X).some((e) => e.pubkey === A.pub), {
    leader: aLeader, seed: aSeed, feedAcquire: aFeedSrc || null, state: aState, heartbeatFiles: aHeartbeat, cachedAfterSetup: aSetup.cachedAfterSetup,
  });

  // B: Blossom 404 for X; opens the feed (no Home click)
  const B = await newClient('B', { dead: [X] });
  await openRegistered(B);
  await waitLeader(B);
  const bSrc = await poll(async () => (await sources(B)).find((s) => s.label === 'P0'), 45000);
  await poll(async () => (await hashState(B, X)).availableFiles, 10000);
  const bState = await hashState(B, X);
  const bLog = await qaLog(B);
  await poll(async () => H.availability(X).some((e) => e.pubkey === B.pub), 15000);
  report.B_SOURCE = bSrc ? bSrc.src : null;
  report.B_P2P_BYTES_RECEIVED = bSrc && bSrc.src === 'p2p' ? bSrc.bytes : 0;
  report.B_HASH_VERIFIED = !!bSrc && bState.cacheShaOk && !bLog.some((l) => l.text.startsWith('[P2P-HASH]'));
  report.B_CACHE_CONTAINS_HASH = bState.cache;
  report.B_AVAILABLE_FILES_CONTAINS_HASH = bState.availableFiles;
  const bCard = await poll(async () => {
    const c = await cardState(B, 0);
    return c.ready ? c : null;
  }, 20000);
  set('B_BLOSSOM_404_DOWNLOADS_FROM_A', report.B_SOURCE === 'p2p' && bSrc.peer === A.pub.slice(0, 8) && report.B_P2P_BYTES_RECEIVED > 0 && report.B_HASH_VERIFIED && report.B_CACHE_CONTAINS_HASH && report.B_AVAILABLE_FILES_CONTAINS_HASH && !!bCard, {
    source: bSrc, state: bState, card: bCard,
    debug: bSrc ? undefined : await B.page.evaluate(async ({ h, a }) => {
      const App = window.NostrApp;
      const found = await Promise.race([App.findPeersWithFile(h), new Promise((r) => setTimeout(() => r('timeout'), 12000))]);
      return { canPeer: App.canDownloadFromPeers(), guestP2P: App.isGuestP2P?.(), known: App.findKnownPeersForHash(h), found: Array.isArray(found) ? found.map((p) => p.slice(0, 8)) : found, aPub: a.slice(0, 8), relayAvail: true };
    }, { h: X, a: A.pub }).catch((e) => String(e)),
    blossomFullGetsForX: B.media.filter((m) => m.h === X.slice(0, 12) && !m.range && m.method === 'GET').length,
  });

  // C: A and B online, then A offline; C must download from B
  const C = await newClient('C', { dead: [X] });
  await A.ctx.close();
  report.A_OFFLINE = true;
  await openRegistered(C);
  await waitLeader(C);
  const cSrc = await poll(async () => (await sources(C)).find((s) => s.label === 'P0'), 60000);
  await poll(async () => (await hashState(C, X)).availableFiles, 10000);
  const cState = await hashState(C, X);
  const cKnowsB = await C.page.evaluate(({ h, b }) => (window.NostrApp.PeerExchange.findPeersWithFileLocally(h) || []).map((p) => String(p).toLowerCase()).includes(b), { h: X, b: B.pub });
  report.B_INVENTORY_ADVERTISES_HASH = H.availability(X).some((e) => e.pubkey === B.pub) && cKnowsB;
  report.C_SOURCE = cSrc ? cSrc.src : null;
  report.C_PEER = cSrc && cSrc.peer === B.pub.slice(0, 8) ? 'B' : cSrc ? cSrc.peer : null;
  report.C_HASH_VERIFIED = cState.cacheShaOk;
  report.A_OFFLINE_C_DOWNLOAD_FROM_B = report.A_OFFLINE && report.C_SOURCE === 'p2p' && report.C_PEER === 'B' && report.C_HASH_VERIFIED;
  set('A_OFFLINE_C_DOWNLOADS_FROM_B', report.A_OFFLINE_C_DOWNLOAD_FROM_B, { source: cSrc, state: cState });
  set('B_INVENTORY_ADVERTISES_HASH', report.B_INVENTORY_ADVERTISES_HASH, { relayAvailabilityFromB: H.availability(X).some((e) => e.pubkey === B.pub), cPeerExchangeListsB: cKnowsB });
  report.LOCAL_AVAILABLE_FILES_AFTER_REPLICATION = { B: bState.availableFilesCount, C: cState.availableFilesCount };
  report.HEARTBEAT_FILES_AFTER_REPLICATION = {};
  for (const [n, u] of [['B', B], ['C', C]]) {
    await u.page.evaluate(() => window.NostrApp.sendHeartbeat?.());
    await poll(async () => H.heartbeats(u.pub).some((e) => (JSON.parse(e.content || '{}').files || 0) >= 1), 8000);
    report.HEARTBEAT_FILES_AFTER_REPLICATION[n] = H.heartbeats(u.pub).map((e) => JSON.parse(e.content || '{}').files || 0).reduce((m, x) => Math.max(m, x), 0);
  }
  set('REPLICA_STATE_CONSISTENT', bState.availableFiles && bState.cache && cState.availableFiles && cState.cache && report.HEARTBEAT_FILES_AFTER_REPLICATION.B >= 1 && report.HEARTBEAT_FILES_AFTER_REPLICATION.C >= 1, {
    LOCAL_AVAILABLE_FILES_AFTER_REPLICATION: report.LOCAL_AVAILABLE_FILES_AFTER_REPLICATION,
    HEARTBEAT_FILES_AFTER_REPLICATION: report.HEARTBEAT_FILES_AFTER_REPLICATION,
  });

  if (process.env.Q899T_ONLY_ABC === '1') return;

  // seed more files for the first-paint cases: B holds P1, P3 and W0; C holds P1 and W1
  for (const [u, idx] of [[B, 1], [B, 3], [B, W0], [C, 1], [C, W1]]) {
    const r = await seedFromBlossom(u, idx);
    info(`SEED_${u.label}_${typeof idx === 'number' ? 'P' + idx : labelOfHash(idx.hash)}`, r);
  }
  await poll(async () => H.availability(P[1].hash).length >= 2 && H.availability(W0.hash).length >= 1 && H.availability(W1.hash).length >= 1, 15000);

  const fp = {};
  const measure = async (u, label) => {
    const t = await poll(async () => {
      const x = await firstPaint(u);
      return x.first && x.second ? x : null;
    }, 30000);
    const x = t || (await firstPaint(u));
    fp[label] = { first: x.first ?? null, second: x.second ?? null };
    return fp[label];
  };
  const fpOk = (m) => m.first !== null && m.first < LIMITS.FIRST_NATIVE_CARD_VISIBLE_MS && m.second !== null && m.second < LIMITS.SECOND_NATIVE_CARD_READY_MS;

  // ---- case A: healthy Blossom, no peers (fresh guest)
  const GA = await newClient('FP_A');
  await openGuest(GA);
  const ga = await measure(GA, 'A');
  const gaGuestPeer = await GA.page.evaluate(() => window.NostrApp.canDownloadFromPeers());
  set('FIRST_PAINT_A_HEALTHY_BLOSSOM_NO_PEERS', fpOk(ga) && gaGuestPeer === true, { ...ga, guestPeerDownload: gaGuestPeer, sources: (await sources(GA)).slice(0, 3).map((s) => `${s.label}:${s.src}`) });
  await GA.ctx.close();

  // ---- case B: healthy peer, slow Blossom (fresh registered)
  const FB = await newClient('FP_B', { slow: [P[0].hash, P[1].hash] });
  await openRegistered(FB);
  const fb = await measure(FB, 'B');
  const fbSrc = await sources(FB);
  set('FIRST_PAINT_B_HEALTHY_PEER_SLOW_BLOSSOM', fpOk(fb) && fbSrc.some((s) => s.label === 'P0' && s.src === 'p2p'), { ...fb, sources: fbSrc.slice(0, 4).map((s) => `${s.label}:${s.src}:${s.peer || ''}`) });
  await FB.ctx.close();

  // ---- case C: slow peer (B throttled), healthy Blossom
  await B.page.evaluate(() => { window.__qaSlowDcMs = 400; });
  const FC = await newClient('FP_C');
  await openRegistered(FC);
  const fc = await measure(FC, 'C');
  const fcSrc = await sources(FC);
  set('FIRST_PAINT_C_SLOW_PEER_HEALTHY_BLOSSOM', fpOk(fc) && fcSrc.some((s) => ['P0', 'P1'].includes(s.label) && s.src === 'blossom-stream'), { ...fc, sources: fcSrc.slice(0, 4).map((s) => `${s.label}:${s.src}`) });
  await FC.ctx.close();

  // ---- case D: peer #1 slow (B), peer #2 healthy (C), Blossom dead for P1
  const FD = await newClient('FP_D', { dead: [P[1].hash] });
  await openRegistered(FD);
  const fd = await measure(FD, 'D');
  const fdP1 = await poll(async () => (await sources(FD)).find((s) => s.label === 'P1'), 40000);
  report.SLOW_PEER_SECOND_PEER_START_MS = fdP1?.secondPeerStartMs ?? null;
  set('FIRST_PAINT_D_SLOW_PEER1_HEALTHY_PEER2', fpOk(fd) && !!fdP1 && fdP1.src === 'p2p' && fdP1.peer === C.pub.slice(0, 8), {
    ...fd, p1: fdP1, slowPeerTriedFirst: fdP1 ? fdP1.peerStarts > 1 : null,
  });
  // slow peer + healthy Blossom in a background replica: Blossom watchdog starts at the slow-probe window
  const wd = await FD.page.evaluate(async ({ url, hash }) => {
    try {
      const r = await window.NostrApp.downloadVideoWithP2P(url, hash, 'video/mp4', { mode: 'PERSIST_REPLICA', allowHttpFallback: true, verifyHash: true, httpCandidates: [url] });
      return { ok: true, source: r.mediaSource, diag: r.diag };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }, { url: W0.url, hash: W0.hash });
  report.SLOW_PEER_BLOSSOM_WATCHDOG_MS = wd.diag?.blossomWatchdogMs ?? null;
  set('SLOW_PEER_BLOSSOM_WATCHDOG', wd.ok && wd.source === 'blossom-full' && typeof wd.diag?.blossomWatchdogMs === 'number' && wd.diag.httpReason !== 'zero-peers-after-discovery', wd);
  await FD.ctx.close();
  await B.page.evaluate(() => { window.__qaSlowDcMs = 0; });

  // ---- case E: first 6 candidates dead, 7-8 healthy (fresh guest)
  const GE = await newClient('FP_E', { dead: P.slice(0, 6).map((p) => p.hash) });
  await openGuest(GE);
  const ge = await measure(GE, 'E');
  const geLog = await qaLog(GE);
  set('FIRST_PAINT_E_FIRST_6_DEAD', fpOk(ge) && geLog.some((l) => l.text.startsWith('[videos] boot wave extended')), {
    ...ge, release: (geLog.find((l) => l.text.startsWith('[videos] boot loading released')) || {}).text || null,
    timeline: geLog.slice(0, 24).map((l) => `${l.t} ${l.text.slice(0, 44)}`),
  });
  await GE.ctx.close();

  // ---- case F: HTTP dead, peer owns the file (fresh registered)
  const FF = await newClient('FP_F', { dead: [P[0].hash] });
  await openRegistered(FF);
  const ff = await measure(FF, 'F');
  const ffP0 = await poll(async () => (await sources(FF)).find((s) => s.label === 'P0'), 40000);
  set('FIRST_PAINT_F_HTTP_DEAD_PEER_OWNS', fpOk(ff) && !!ffP0 && ffP0.src === 'p2p', { ...ff, p0: ffP0 });
  // steady state: a new post after boot whose file a known peer (C) holds -> P2P primary even with healthy Blossom
  await poll(async () => FF.page.evaluate((h) => (window.NostrApp.findKnownPeersForHash(h) || []).length > 0, W1.hash), 20000);
  const knownBefore = await FF.page.evaluate((h) => (window.NostrApp.findKnownPeersForHash(h) || []).length, W1.hash);
  const live = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [['t', NET], ['media', 'video/mp4', W1.url, W1.hash]], content: `qa 899t LIVE\n${W1.url}` }, AUTHOR.sk);
  const rtBefore = await FF.page.evaluate(() => (typeof videoRealtimeSub !== 'undefined' ? !!videoRealtimeSub : 'n/a'));
  const relaySubsMatching = Array.from(H.subs.values()).reduce((n, m) => n + Array.from(m.values()).filter((fs) => fs.some((f) => matchFilter(live, f))).length, 0);
  const liveDelivered = H.publish(live);
  const steady = await poll(async () => (await sources(FF)).find((s) => s.label === 'W1' && s.mode === 'P2P_STEADY'), 30000);
  report.STEADY_STATE_PRIMARY_SOURCE = steady ? steady.src : null;
  const liveDom = await FF.page.evaluate((id) => !!document.querySelector(`.videos-feed__card[data-event-id="${id}"]`), live.id);
  set('STEADY_STATE_PRIMARY_SOURCE_P2P', !!steady && steady.src === 'p2p', { knownPeersBefore: knownBefore, steady, liveDelivered, liveDom, rtBefore, relaySubsMatching });
  await FF.ctx.close();

  // ---- case G: HTTP fails first, the peer appears 5 s later -> recovered
  const FG = await newClient('FP_G', { dead: [P[8].hash] });
  await openRegistered(FG);
  const fg = await measure(FG, 'G');
  const parked = await poll(async () => (await qaLog(FG)).find((l) => l.text.startsWith('[videos] media parked for p2p recovery') && labelOfHash(l.data?.hash) === 'P8'), 30000);
  await sleep(5000);
  const gSeed = await seedFromBlossom(C, 8);
  const recovered = await poll(async () => (await qaLog(FG)).find((l) => l.text.startsWith('[videos] media recovered via p2p') && labelOfHash(l.data?.hash) === 'P8'), 45000);
  const gCard = await poll(async () => {
    const c = await cardState(FG, 8);
    return c.ready && c.readyState >= 2 ? c : null;
  }, 25000);
  const gPersisted = await FG.page.evaluate((id) => {
    try {
      const raw = JSON.parse(localStorage.getItem('videos_failed_media_v4') || '{}');
      return (raw.ids || []).includes(id);
    } catch (_e) {
      return null;
    }
  }, P[8].ev.id);
  report.HTTP_FAILURE_P2P_RECOVERY = !!parked && !!recovered && !!gCard && gPersisted === false;
  set('FIRST_PAINT_G_PEER_AFTER_HTTP_FAILURE', fpOk(fg) && report.HTTP_FAILURE_P2P_RECOVERY, { ...fg, parked: !!parked, cSeed: gSeed, recovered: recovered && recovered.data, card: gCard, persistedBlacklist: gPersisted });

  // ---- hash verification: a peer advertising wrong bytes; a Blossom host serving wrong bytes
  const EVIL = await newClient('EVIL');
  await openRegistered(EVIL);
  await waitLeader(EVIL);
  await EVIL.page.evaluate(async (hash) => {
    const bad = new Blob([new Uint8Array(300 * 1024).fill(7)], { type: 'video/mp4' });
    await window.NostrApp.registerFileAvailability(hash, bad, 'video/mp4');
  }, P[9].hash);
  await poll(async () => H.availability(P[9].hash).some((e) => e.pubkey === EVIL.pub), 10000);
  FG.st.badBlossom.add(P[10].hash);
  const evilRun = await FG.page.evaluate(async ({ url, hash }) => {
    try {
      const r = await window.NostrApp.downloadVideoWithP2P(url, hash, 'video/mp4', { mode: 'PERSIST_REPLICA', allowHttpFallback: true, verifyHash: true, httpCandidates: [url] });
      return { ok: true, source: r.mediaSource, diag: r.diag };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }, { url: P[9].url, hash: P[9].hash });
  const evilState = await hashState(FG, P[9].hash);
  const fgLog = await qaLog(FG);
  const peerMismatch = fgLog.find((l) => l.text.startsWith('[P2P-HASH] MISMATCH') && l.data?.source === 'p2p' && labelOfHash(l.data?.hash) === 'P9');
  const evilExcluded = await FG.page.evaluate(({ h, e }) => !(window.NostrApp.findKnownPeersForHash(h) || []).includes(e), { h: P[9].hash, e: EVIL.pub });
  report.P2P_FULL_FILE_HASH_VERIFIED = !!peerMismatch && evilRun.ok && evilState.cacheShaOk;
  report.BAD_PEER_BYTES_CACHED = !evilState.cacheShaOk && evilState.cache;
  report.BAD_PEER_BYTES_ADVERTISED = evilState.availableFiles && !evilState.availableShaOk;
  set('BAD_PEER_BYTES_REJECTED', !!peerMismatch && evilRun.ok && evilRun.source === 'blossom-full' && !report.BAD_PEER_BYTES_CACHED && !report.BAD_PEER_BYTES_ADVERTISED && evilExcluded, {
    run: evilRun, state: evilState, mismatchLogged: !!peerMismatch, evilPenalized: evilExcluded,
  });
  const badBlossomRun = await FG.page.evaluate(async ({ url, alt, hash }) => {
    try {
      const r = await window.NostrApp.downloadVideoWithP2P(url, hash, 'video/mp4', { mode: 'PERSIST_REPLICA', allowHttpFallback: true, verifyHash: true, httpCandidates: [url, alt] });
      return { ok: true, source: r.mediaSource };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }, { url: P[10].url, alt: `https://blossom.nostr.build/${P[10].hash}.mp4`, hash: P[10].hash });
  const bbState = await hashState(FG, P[10].hash);
  const bbMismatch = (await qaLog(FG)).find((l) => l.text.startsWith('[P2P-HASH] MISMATCH') && l.data?.source === 'http' && labelOfHash(l.data?.hash) === 'P10');
  report.BLOSSOM_FULL_FILE_HASH_VERIFIED = !!bbMismatch && badBlossomRun.ok && bbState.cacheShaOk;
  report.BAD_BLOSSOM_BYTES_ADVERTISED = bbState.availableFiles && !bbState.availableShaOk;
  set('BAD_BLOSSOM_BYTES_REJECTED', report.BLOSSOM_FULL_FILE_HASH_VERIFIED && !report.BAD_BLOSSOM_BYTES_ADVERTISED, { run: badBlossomRun, state: bbState, mismatchLogged: !!bbMismatch });

  // ---- zero known peers: HTTP starts without a peer search
  const zp = await FG.page.evaluate(async ({ url, hash }) => {
    try {
      const r = await window.NostrApp.downloadVideoWithP2P(url, hash, 'video/mp4', { mode: 'P2P_STEADY', allowHttpFallback: true, verifyHash: true, httpCandidates: [url] });
      return { ok: true, source: r.mediaSource, diag: r.diag };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }, { url: P[11].url, hash: P[11].hash });
  report.ZERO_PEER_TO_HTTP_START_MS = zp.diag?.httpStartMs ?? null;
  set('ZERO_PEER_HTTP_START_FAST', zp.ok && zp.diag?.knownPeers === 0 && report.ZERO_PEER_TO_HTTP_START_MS !== null && report.ZERO_PEER_TO_HTTP_START_MS <= 1000, zp);
  const cfg = await FG.page.evaluate(() => window.NostrApp.getFeedAcquireConfig());
  report.FAST_BOOT_PEER_DISCOVERY_BUDGET_MS = cfg.FAST_BOOT_PEER_DISCOVERY_BUDGET_MS;
  report.P2P_MAX_PARALLEL_PEERS_PER_FILE = cfg.MAX_PARALLEL_PEERS_PER_FILE;
  set('FEED_ACQUIRE_BOUNDS', cfg.FAST_BOOT_PEER_DISCOVERY_BUDGET_MS <= 1500 && cfg.MAX_PARALLEL_PEERS_PER_FILE === 2 && cfg.SLOW_DOWNLOAD_BPS === 50 * 1024 && cfg.SLOW_PROBE_MS === 2000, cfg);

  // ---- canonical engine only: the feed does not carry its own transfer code
  const videosSrc = fs.readFileSync(path.join(ROOT, 'videos.js'), 'utf8');
  const duplicate = /RTCPeerConnection|createDataChannel|crypto\.subtle\.digest/.test(videosSrc);
  report.DUPLICATE_P2P_ENGINE_CREATED = duplicate;
  set('PUBLIC_FEED_USES_CANONICAL_P2P_ENGINE', !duplicate && /App\.downloadVideoWithP2P\(/.test(videosSrc), { duplicateTransferCodeInVideosJs: duplicate });

  report.FIRST_PAINT = fp;
  report.FIRST_VISIBLE_CARD_MS = Math.max(...Object.values(fp).map((m) => m.first ?? Infinity));
  report.SECOND_READY_CARD_MS = Math.max(...Object.values(fp).map((m) => m.second ?? Infinity));
  report.HOME_CLICKS = contexts.reduce((n, u) => n + u.homeClicks, 0);
  set('NO_HOME_CLICK', report.HOME_CLICKS === 0, { homeClicks: report.HOME_CLICKS });

  // ---- privacy: no keys / nsec / SDP in console
  const all = contexts.flatMap((u) => u.consoleAll).join('\n');
  const leak = /nsec1[0-9a-z]{20,}/.test(all) || /a=ice-pwd|a=fingerprint/.test(all);
  set('DIAGNOSTIC_PRIVACY', !leak && CONFIG_TRANSFORMS.relays && CONFIG_TRANSFORMS.p2p && CONFIG_TRANSFORMS.sanitizer, { leak, transforms: CONFIG_TRANSFORMS });
}

main()
  .catch((e) => {
    report.error = String((e && e.stack) || e).slice(0, 3000);
    console.error(e);
  })
  .finally(async () => {
    const vals = Object.values(report.results);
    report.passed = vals.filter((v) => v.ok).length;
    report.failed = vals.filter((v) => !v.ok).length;
    report.status = !report.error && report.failed === 0 && report.passed > 0 ? 'PASS' : 'FAIL';
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    if (process.env.Q899T_DUMP_DIR) {
      const re = /P2P|feed-session|ChatDC|VIDEO_MEDIA|MEDIA_REPLICA|\[videos\]|\[DC\]|HASH|SECURITY/;
      contexts.forEach((u) => fs.writeFileSync(path.join(process.env.Q899T_DUMP_DIR, `q899t-${u.label}.txt`), u.consoleAll.filter((l) => re.test(l)).map((l) => l.slice(0, 300)).join('\n')));
    }
    console.log('RESULT', report.status, 'passed', report.passed, 'failed', report.failed);
    try {
      await browser?.close();
    } catch (_e) {}
    server.close();
    await H.stop().catch(() => {});
    process.exit(report.status === 'PASS' ? 0 : 1);
  });
