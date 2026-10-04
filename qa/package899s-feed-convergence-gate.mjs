/**
 * Package 899s — Videos feed convergence (eligibility, parallel native boot, public media fast path, realtime posts).
 *
 * Relays served to the app (test-only config.js transform):
 *   H  ws://127.0.0.1:7891  healthy NIP-01 relay with live fan-out to open subscriptions
 *   B  ws://127.0.0.1:7892  HTTP 502 on every request
 * Media is a real small H.264 MP4 (qa/fixtures/899s-h264-160x120.mp4). Every post gets a distinct, valid MP4
 * (fixture + trailing ISO-BMFF `free` box) so every post has its own SHA-256 media hash.
 * Media hosts are intercepted inside the browser context only:
 *   media.qa-sos.test / mirror.qa-sos.test   healthy (Range / 206)
 *   dead.qa-sos.test                         404
 *   busy.qa-sos.test                         503
 *   hang.qa-sos.test                         never answers
 *   blossom.band / blossom.nostr.build / files.sovbit.host   mock Blossom: serves only hashes it holds, 404 otherwise
 *   files.sovbit.host can be forced to 404 / 503 per hash (SOVBIT_FORCE)
 * Every context is fresh (no localStorage / IndexedDB / feed cache). The service worker is disabled except in the
 * SW_* contexts, which run the real service worker (127.0.0.1 is a secure context). Disposable keys only.
 * Runs on the Edge channel (H.264), plus a WebKit smoke when the Playwright WebKit build is installed.
 * Never deploys. Never touches production config.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { chromium, webkit } from 'playwright';
import { WebSocketServer } from 'ws';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'package899s-feed-convergence-report.json');
const PORT = Number(process.env.SOS_899S_PORT || 8891);
const H_PORT = 7891;
const B_PORT = 7892;
const RELAYS = [H_PORT, B_PORT].map((p) => `ws://127.0.0.1:${p}`);
const URL0 = `http://127.0.0.1:${PORT}/videos.html`;
const NET = 'israel-network';
// SOS_899S_BASELINE=<commit> additionally measures that commit's videos.js (first paint only; informational)
const BASELINE = /^[0-9a-f]{7,40}$/.test(process.env.SOS_899S_BASELINE || '') ? process.env.SOS_899S_BASELINE : '';
const PERF = { FIRST_NATIVE_CARD_VISIBLE_MS: 15000, BOOT_RELEASE_MS: 20000, FALLBACK_404_MS: 2000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const mkKey = () => {
  const sk = generateSecretKey();
  return { sk, hex: hex(sk), pub: getPublicKey(sk) };
};

const report = { gate: 'PACKAGE899S_FEED_CONVERGENCE', relays: { healthy: RELAYS[0], http502: RELAYS[1] }, ts: new Date().toISOString(), results: {}, metrics: {} };
const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500));
};
const info = (k, v) => {
  report.metrics[k] = v;
  console.log('INFO', k, JSON.stringify(v).slice(0, 500));
};

// ---------------------------------------------------------------- media fixture
const FIXTURE = fs.readFileSync(path.join(ROOT, 'qa', 'fixtures', '899s-h264-160x120.mp4'));
const MEDIA = new Map(); // hash -> Buffer
function mkMedia(label) {
  const payload = Buffer.from(`sos-899s-qa:${label}`);
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write('free', 4, 'ascii');
  payload.copy(box, 8);
  const buf = Buffer.concat([FIXTURE, box]);
  const h = crypto.createHash('sha256').update(buf).digest('hex');
  MEDIA.set(h, buf);
  return h;
}
const HOST_MODE = {
  'media.qa-sos.test': 'healthy',
  'mirror.qa-sos.test': 'healthy',
  'dead.qa-sos.test': '404',
  'busy.qa-sos.test': '503',
  'hang.qa-sos.test': 'hang',
  'blossom.band': 'blossom',
  'blossom.nostr.build': 'blossom',
  'files.sovbit.host': 'blossom',
};
const BLOSSOM_HAS = { 'blossom.band': new Set(), 'blossom.nostr.build': new Set(), 'files.sovbit.host': new Set() };
const SOVBIT_FORCE = new Map(); // hash -> 404 | 503

// ---------------------------------------------------------------- healthy relay with live fan-out
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
class HealthyRelay {
  constructor(port) {
    this.port = port;
    this.events = new Map();
    this.subs = new Map(); // ws -> Map(subId -> filters)
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
  add(ev) {
    if (verifyEvent({ ...ev })) this.events.set(ev.id, ev);
  }
  publish(ev) {
    this.add(ev);
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
      if (ok) this.events.set(ev.id, ev);
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
}
const H = new HealthyRelay(H_PORT);
const B = http.createServer((req, res) => {
  res.writeHead(502);
  res.end('bad gateway');
});
B.on('upgrade', (req, socket) => {
  socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
});

// ---------------------------------------------------------------- static server (test-only config transform)
const CONFIG_TRANSFORMS = { relays: false, p2p: false, sanitizer: false };
function transformConfig(src) {
  let out = src.replace(/const SAFE_DEFAULT_RELAYS = \[[^\]]*\];/, () => {
    CONFIG_TRANSFORMS.relays = true;
    return `const SAFE_DEFAULT_RELAYS = ${JSON.stringify(RELAYS)};`;
  });
  out = out.replace(/const SAFE_DEFAULT_P2P_RELAYS = \[[^\]]*\];/, () => {
    CONFIG_TRANSFORMS.p2p = true;
    return `const SAFE_DEFAULT_P2P_RELAYS = ${JSON.stringify([RELAYS[0]])};`;
  });
  out = out.replace("!trimmed.startsWith('wss://')", () => {
    CONFIG_TRANSFORMS.sanitizer = true;
    return "!(trimmed.startsWith('wss://') || trimmed.startsWith('ws://127.0.0.1:'))";
  });
  return out;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp' };
let serveBaseline = '';
const server = http.createServer((req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/videos.html';
    if (/^\/qa-media\/[\w-]+\.jpg$/.test(p)) p = '/LOGO.jpg';
    // real HTTP media for the WebKit smoke (Playwright WebKit cannot play route-fulfilled media)
    const mp4 = /^\/qa-mp4\/([0-9a-f]{64})\.mp4$/.exec(p);
    if (mp4) {
      const buf = MEDIA.get(mp4[1]);
      if (!buf) {
        res.writeHead(404);
        res.end('nf');
        return;
      }
      const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (m) {
        const s = m[1] ? Number(m[1]) : 0;
        const e = Math.min(m[2] ? Number(m[2]) : buf.length - 1, buf.length - 1);
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${s}-${e}/${buf.length}`, 'Content-Length': e - s + 1 });
        res.end(req.method === 'HEAD' ? undefined : buf.subarray(s, e + 1));
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': buf.length });
      res.end(req.method === 'HEAD' ? undefined : buf);
      return;
    }
    const fp = path.join(ROOT, p.replace(/^\//, ''));
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404);
      res.end('nf');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (p === '/config.js') res.end(transformConfig(fs.readFileSync(fp, 'utf8')));
    else if (p === '/videos.js' && serveBaseline) res.end(execSync('git show ' + serveBaseline + ':videos.js', { cwd: ROOT, maxBuffer: 64 << 20 }));
    else fs.createReadStream(fp).pipe(res);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e.message || e));
  }
});

// ---------------------------------------------------------------- disposable content
const now = Math.floor(Date.now() / 1000);
const AUTHORS = [mkKey(), mkKey(), mkKey()];
const USER = mkKey();
const sign = (key, draft) => finalizeEvent(draft, key.sk);
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const img = (label) => `http://127.0.0.1:${PORT}/qa-media/${label}.jpg`;
const P = {}; // label -> event
const HASH = {}; // label -> media hash
function nativePost(label, key, createdAt, host, { mirrors = [], yt = false } = {}) {
  const h = mkMedia(label);
  HASH[label] = h;
  const url = /^https?:\/\//.test(host) ? `${host}/${h}.mp4` : `https://${host}/${h}.mp4`;
  const lines = [`qa 899s ${label}`];
  if (yt) lines.push(YT);
  lines.push(url);
  const tags = [['t', NET], ['media', 'video/mp4', url, h], ...mirrors.map((m) => ['mirror', `https://${m}/${h}.mp4`])];
  return sign(key, { kind: 1, created_at: createdAt, tags, content: lines.join('\n') });
}
function textPost(label, key, createdAt, lines) {
  return sign(key, { kind: 1, created_at: createdAt, tags: [['t', NET]], content: [`qa 899s ${label}`, ...lines].join('\n') });
}
const ORDER = [];
function seed() {
  AUTHORS.forEach((a, i) => H.add(sign(a, { kind: 0, created_at: now - 3600, tags: [['t', NET]], content: JSON.stringify({ name: 'QA 899s Author ' + (i + 1) }) })));
  H.add(sign(USER, { kind: 0, created_at: now - 3600, tags: [['t', NET]], content: JSON.stringify({ name: 'QA 899s User' }) }));
  let i = 0;
  const at = () => now - 60 - i++ * 30;
  const a = (n) => AUTHORS[n % AUTHORS.length];
  const add = (label, ev) => {
    P[label] = ev;
    ORDER.push(label);
    H.add(ev);
  };
  add('Y0', textPost('Y0', a(0), at(), [YT])); // YouTube only
  add('D0', nativePost('D0', a(1), at(), 'dead.qa-sos.test')); // every candidate 404
  add('N1', nativePost('N1', a(2), at(), 'media.qa-sos.test'));
  add('B2', nativePost('B2', a(0), at(), 'dead.qa-sos.test')); // dead original; first Blossom 404, second Blossom healthy
  BLOSSOM_HAS['blossom.band'].add(HASH.B2);
  add('S3', nativePost('S3', a(1), at(), 'mirror.qa-sos.test', { mirrors: ['busy.qa-sos.test'] })); // declared mirror 503 (tried first), healthy original
  add('YN4', nativePost('YN4', a(2), at(), 'media.qa-sos.test', { yt: true })); // YouTube + native
  add('YI5', textPost('YI5', a(0), at(), [YT, img('yi5')])); // YouTube + image
  add('H6', nativePost('H6', a(1), at(), 'dead.qa-sos.test', { mirrors: ['hang.qa-sos.test'] })); // declared mirror never answers, Blossom has it
  BLOSSOM_HAS['blossom.nostr.build'].add(HASH.H6);
  for (let n = 7; n <= 14; n++) add('N' + n, nativePost('N' + n, a(n), at(), 'media.qa-sos.test'));
  // sovbit originals: never the first attempt when a hash alternative exists
  add('SV16', nativePost('SV16', a(0), at(), 'files.sovbit.host')); // sovbit 404, blossom.band healthy
  SOVBIT_FORCE.set(HASH.SV16, 404);
  BLOSSOM_HAS['blossom.band'].add(HASH.SV16);
  add('SV17', nativePost('SV17', a(1), at(), 'files.sovbit.host')); // sovbit 503, blossom.nostr.build healthy
  SOVBIT_FORCE.set(HASH.SV17, 503);
  BLOSSOM_HAS['blossom.nostr.build'].add(HASH.SV17);
  add('SV18', nativePost('SV18', a(2), at(), 'files.sovbit.host')); // sovbit 503, no alternative holds it
  SOVBIT_FORCE.set(HASH.SV18, 503);
  add('I15', textPost('I15', a(2), at(), [img('i15')])); // image only
  // engagement on N1
  H.add(sign(a(0), { kind: 7, created_at: P.N1.created_at + 5, tags: [['e', P.N1.id], ['p', P.N1.pubkey], ['t', NET]], content: '+' }));
  H.add(sign(a(1), { kind: 1, created_at: P.N1.created_at + 6, tags: [['e', P.N1.id], ['p', P.N1.pubkey], ['t', NET]], content: 'qa 899s comment' }));
  // 200 historical posts (2-3 h old): replayed by the realtime subscription before EOSE, must never auto-mount
  for (let k = 0; k < 200; k++) {
    const ev = textPost('HIST' + k, a(k), now - 7200 - k * 20, [img('hist-' + k)]);
    P['HIST' + k] = ev;
    H.add(ev);
  }
}
const histIds = () => Object.keys(P).filter((k) => k.startsWith('HIST')).map((k) => P[k].id);

// ---------------------------------------------------------------- browser helpers
const ALLOWED_EXTERNAL_HOSTS = new Set(['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']);
const QA_LOG_RE = /^\[videos\] (media candidate|media candidates failed|boot loading released|live post accepted|new post auto-mounted|new post warming|Boot safety timeout|mounted parked card)/;
const INIT = ({ reStr, realSw, saveData }) => {
  if (!realSw) {
    try {
      Object.defineProperty(navigator, 'serviceWorker', { get: () => undefined, configurable: true });
    } catch (_e) {}
  }
  window.__qaCtrlAtLoad = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  window.__qaDocId = Math.random().toString(36).slice(2);
  if (saveData) {
    const conn = { saveData: true, effectiveType: '4g', addEventListener() {}, removeEventListener() {} };
    try {
      Object.defineProperty(navigator, 'connection', { get: () => conn, configurable: true });
    } catch (_e) {}
  }
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
          window.__qaLog.push({ t: Date.now(), text: args[0], data });
        }
      } catch (_e) {}
      return orig(...args);
    };
  });
};

let browser = null;
async function freshContext(label, { b = browser, realSw = false, saveData = false } = {}) {
  const ctx = await b.newContext({ viewport: { width: 420, height: 860 }, serviceWorkers: realSw ? 'allow' : 'block' });
  const u = { label, ctx, media: [], hung: [] };
  await ctx.routeWebSocket(new RegExp(`^ws://127\\.0\\.0\\.1:${H_PORT}`), (ws) => ws.connectToServer());
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
    if (/(^|\.)ytimg\.com$/.test(host)) {
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(path.join(ROOT, 'LOGO.jpg')) });
    }
    const mode = HOST_MODE[host];
    if (!mode) return route.abort();
    const h = (url.pathname.match(/([0-9a-f]{64})/) || [])[1] || '';
    u.media.push({ t: Date.now(), host, h: h.slice(0, 12), method: req.method(), range: req.headers()['range'] || '' });
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range', 'Cache-Control': 'no-store' };
    if (host === 'files.sovbit.host' && SOVBIT_FORCE.has(h)) return route.fulfill({ status: SOVBIT_FORCE.get(h), headers: cors, body: 'sovbit' });
    if (mode === '404') return route.fulfill({ status: 404, headers: cors, body: 'not found' });
    if (mode === '503') return route.fulfill({ status: 503, headers: cors, body: 'busy' });
    if (mode === 'hang') {
      u.hung.push(route);
      return undefined; // never answered
    }
    const buf = MEDIA.get(h);
    if (!buf || (mode === 'blossom' && !BLOSSOM_HAS[host].has(h))) return route.fulfill({ status: 404, headers: cors, body: 'not found' });
    const headers = { ...cors, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };
    if (req.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...headers, 'Content-Length': String(buf.length) }, body: '' });
    const range = req.headers()['range'];
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      const s = m[1] ? Number(m[1]) : 0;
      const e = Math.min(m[2] ? Number(m[2]) : buf.length - 1, buf.length - 1);
      return route.fulfill({ status: 206, headers: { ...headers, 'Content-Range': `bytes ${s}-${e}/${buf.length}` }, body: buf.subarray(s, e + 1) });
    }
    return route.fulfill({ status: 200, headers, body: buf });
  });
  await ctx.addInitScript(INIT, { reStr: QA_LOG_RE.source, realSw, saveData });
  u.page = await ctx.newPage();
  u.navs = 0;
  u.page.on('framenavigated', (f) => {
    if (f === u.page.mainFrame()) u.navs++;
  });
  u.t0 = Date.now();
  return u;
}
// full-body GETs (no Range header) are background persist downloads; <video> streaming always sends Range
const fullGets = (u, lbl) => u.media.filter((m) => m.method === 'GET' && !m.range && (!lbl || m.h === HASH[lbl].slice(0, 12)));
const labelOfHash12 = (h12) => Object.keys(HASH).find((k) => HASH[k].slice(0, 12) === h12) || h12;
async function poll(fn, timeout, step = 250) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}
async function playCentered(page) {
  return page.evaluate(async () => {
    const vp = document.querySelector('.videos-feed__viewport');
    // eslint-disable-next-line no-undef
    const card = getCenteredFeedCard(vp);
    const v = card && card.querySelector('video');
    if (!v) return { id: card ? card.getAttribute('data-event-id') : null, playing: false };
    v.muted = true;
    if (v.paused) {
      try {
        await v.play();
      } catch (_e) {}
    }
    return { id: card.getAttribute('data-event-id'), playing: !v.paused };
  });
}
async function scrollToCard(page, id) {
  await page.evaluate((eid) => {
    const c = document.querySelector(`.videos-feed__stream .videos-feed__card[data-event-id="${eid}"]`);
    if (c) c.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, id);
  await sleep(1200);
}
const cachedHas = (page, h) => page.evaluate((x) => !!window.NostrApp?.mediaCacheHashSet?.has(x), h);
const qaLog = (u) => u.page.evaluate(() => window.__qaLog.slice());
async function waitApp(page) {
  await page.waitForFunction(() => !!window.NostrApp?.createNewIdentityExplicit && !!window.NostrApp?.pool && window.SosFeatureFlags?.isResolved?.() === true, null, { polling: 200, timeout: 120000 });
}
async function login(page, key) {
  return page.evaluate(async (k) => {
    const App = window.NostrApp;
    const c = App.createNewIdentityExplicit({ privateKeyHex: k });
    App.guestMode = false;
    App.SessionAuthority?.bindCurrentSession?.({ accountPubkey: c.publicKey, bump: true });
    try {
      window.dispatchEvent(new CustomEvent('sos-identity-ready'));
    } catch (_e) {}
    return String(c.publicKey || '').toLowerCase();
  }, key.hex);
}

// one DOM/state snapshot, ids mapped back to labels by the caller
async function feedSnapshot(page) {
  return page.evaluate(() => {
    const vp = document.querySelector('.videos-feed__viewport');
    const vpr = vp ? vp.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const cards = Array.from(document.querySelectorAll('.videos-feed__stream .videos-feed__card[data-event-id]')).map((c) => {
      const media = c.querySelector('.videos-feed__media');
      const v = media && media.querySelector('video');
      const r = c.getBoundingClientRect();
      return {
        id: c.getAttribute('data-event-id'),
        type: (media && media.dataset.mediaType) || '',
        ready: c.dataset.mediaReady === 'ready',
        hidden: c.style.display === 'none',
        readyState: v ? v.readyState : -1,
        src: v ? String(v.dataset.mediaSource || '') : '',
        inView: r.height > 0 && r.bottom > vpr.top + 1 && r.top < vpr.bottom - 1,
      };
    });
    // eslint-disable-next-line no-undef
    const display = typeof getDisplayVideos === 'function' ? getDisplayVideos().map((v) => v.id) : [];
    // eslint-disable-next-line no-undef
    const centered = typeof getCenteredFeedCard === 'function' ? getCenteredFeedCard(vp)?.getAttribute('data-event-id') || null : null;
    return {
      cards,
      display,
      centered,
      scrollTop: vp ? vp.scrollTop : -1,
      // eslint-disable-next-line no-undef
      bootReleased: typeof bootGate !== 'undefined' ? bootGate.released : null,
      // eslint-disable-next-line no-undef
      stateIds: typeof state !== 'undefined' ? state.videos.map((v) => v.id) : [],
      // eslint-disable-next-line no-undef
      failedIds: typeof failedMediaIds !== 'undefined' ? Array.from(failedMediaIds) : [],
      guest: window.NostrApp?.guestMode === true,
    };
  });
}
const firstNativeVisible = (snap) => snap.bootReleased && snap.cards.find((c) => c.type === 'file' && c.ready && !c.hidden && c.readyState >= 2 && c.inView);

// Boot measurement: polls until the first native card is visible and boot released (or the window closes)
async function measureBoot(u, windowMs = 30000) {
  const t = Date.now();
  let firstMs = null;
  let snap = null;
  while (Date.now() - t < windowMs) {
    try {
      snap = await feedSnapshot(u.page);
      if (firstMs === null && firstNativeVisible(snap)) firstMs = Date.now() - u.t0;
      if (firstMs !== null) break;
    } catch (_e) {}
    await sleep(150);
  }
  const log = await qaLog(u);
  const rel = log.find((l) => /boot loading released/.test(l.text));
  const reason = rel ? String(rel.data ?? '').trim() || rel.text : null;
  return {
    firstMs,
    bootReleaseMs: rel ? rel.t - u.t0 : null,
    bootReason: reason,
    safety: log.some((l) => /Boot safety timeout/.test(l.text)) || /safety/.test(String(reason || '')),
    snap,
  };
}
async function waitCard(page, id, timeout = 25000, pred = (c) => c.ready && !c.hidden) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    const s = await feedSnapshot(page);
    const c = s.cards.find((x) => x.id === id);
    if (c && pred(c)) return { ms: Date.now() - t, card: c, snap: s };
    await sleep(200);
  }
  return { ms: null, card: null, snap: await feedSnapshot(page) };
}
function duplicateAttempts(log) {
  const seen = new Map();
  let dups = 0;
  log.filter((l) => /media candidate$/.test(l.text) && l.data).forEach((l) => {
    const k = l.data.id8 + '|' + l.data.ref;
    if (seen.has(k)) dups++;
    seen.set(k, true);
  });
  return dups;
}

// ---------------------------------------------------------------- run
let exitCode = 1;
try {
  await H.start();
  await new Promise((r) => B.listen(B_PORT, '127.0.0.1', r));
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  seed();
  const label = new Map(Object.entries(P).map(([k, ev]) => [ev.id, k]));
  const L = (id) => label.get(id) || String(id || '').slice(0, 8);
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--autoplay-policy=no-user-gesture-required'] });

  // ---- 1. fresh guest: boot, eligibility, media fast path
  const g = await freshContext('FRESH_GUEST');
  await g.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  const gBoot = await measureBoot(g);
  // let the slow paths settle (hang -> Blossom after the candidate timeout)
  await waitCard(g.page, P.H6.id, 30000);
  await waitCard(g.page, P.SV17.id, 30000);
  await waitCard(g.page, P.I15.id, 30000);
  await sleep(1500);
  const gSnap = await feedSnapshot(g.page);
  const gLog = await qaLog(g);
  const card = (lbl) => gSnap.cards.find((c) => c.id === P[lbl].id) || null;
  info('FRESH_GUEST_BOOT', { firstMs: gBoot.firstMs, bootReleaseMs: gBoot.bootReleaseMs, bootReason: gBoot.bootReason, safety: gBoot.safety });
  info('FRESH_GUEST_DOM_ORDER', gSnap.cards.slice(0, 20).map((c) => `${L(c.id)}:${c.type}${c.ready ? '' : '(pending)'}`));

  report.FIRST_NATIVE_CARD_VISIBLE_MS = gBoot.firstMs;
  report.BOOT_RELEASE_MS = gBoot.bootReleaseMs;
  report.SAFETY_TIMEOUT_USED = gBoot.safety;
  set('FRESH_GUEST_MP4_VISIBLE', gBoot.firstMs !== null && gSnap.guest && !!card('N1') && card('N1').readyState >= 2, { firstMs: gBoot.firstMs, guest: gSnap.guest, n1: card('N1') });
  set('GUEST_PUBLIC_READ', gSnap.guest && gSnap.display.length > 0 && gSnap.cards.length > 0, { display: gSnap.display.length, cards: gSnap.cards.length });
  set('PERF_FIRST_NATIVE_CARD_VISIBLE', gBoot.firstMs !== null && gBoot.firstMs < PERF.FIRST_NATIVE_CARD_VISIBLE_MS, { ms: gBoot.firstMs, limit: PERF.FIRST_NATIVE_CARD_VISIBLE_MS });
  set('PERF_BOOT_RELEASE', gBoot.bootReleaseMs !== null && gBoot.bootReleaseMs < PERF.BOOT_RELEASE_MS, { ms: gBoot.bootReleaseMs, limit: PERF.BOOT_RELEASE_MS });
  set('SAFETY_TIMEOUT_NOT_USED', !gBoot.safety, { reason: gBoot.bootReason });
  const bootReady = /boot-ready media=(\d+)\/2/.exec(String(gBoot.bootReason));
  set('FIRST_CANDIDATE_DEAD_BOOT_2_OF_2', !!bootReady && Number(bootReady[1]) >= 2 && !card('D0') && gSnap.failedIds.includes(P.D0.id), {
    reason: gBoot.bootReason,
    deadMounted: !!card('D0'),
    deadMarkedPermanent: gSnap.failedIds.includes(P.D0.id),
  });
  set('YOUTUBE_ONLY_ABSENT', !gSnap.display.includes(P.Y0.id) && !card('Y0') && gSnap.stateIds.includes(P.Y0.id), { inState: gSnap.stateIds.includes(P.Y0.id) });
  set('YOUTUBE_PLUS_NATIVE_SHOWS_NATIVE', !!card('YN4') && card('YN4').type === 'file' && card('YN4').readyState >= 2, { card: card('YN4') });
  set('YOUTUBE_PLUS_IMAGE_SHOWS_IMAGE', !!card('YI5') && card('YI5').type === 'image', { card: card('YI5') });
  set('NATIVE_VIDEO_VISIBLE', ['N1', 'N7', 'N8', 'N9'].every((l) => card(l) && card(l).type === 'file' && card(l).readyState >= 2), {
    cards: ['N1', 'N7', 'N8', 'N9'].map((l) => card(l)),
  });
  const candLogs = (lbl) => gLog.filter((l) => /media candidate$/.test(l.text) && l.data && l.data.id8 === P[lbl].id.slice(0, 8));
  const b2 = candLogs('B2');
  const b2FallbackMs = b2.length >= 2 ? b2[1].t - b2[0].t : null;
  report.FALLBACK_404_MS = b2FallbackMs;
  set('DEAD_ORIGINAL_HEALTHY_BLOSSOM', !!card('B2') && card('B2').readyState >= 2 && /blossom\.band/.test(card('B2').src), { card: card('B2'), attempts: b2.map((l) => l.data.ref) });
  set('HTTP_404_FAST_FALLBACK', b2FallbackMs !== null && b2FallbackMs <= PERF.FALLBACK_404_MS, { ms: b2FallbackMs, limit: PERF.FALLBACK_404_MS });
  // 503 / hanging originals must not block other cards: healthy cards behind them become ready before they do
  const readyAt = (lbl) => {
    const m = gLog.find((l) => /media candidate$/.test(l.text) && l.data && l.data.id8 === P[lbl].id.slice(0, 8));
    return m ? m.t - g.t0 : null;
  };
  const h6 = candLogs('H6');
  const s3 = candLogs('S3');
  set('HTTP_503_AND_TIMEOUT_DO_NOT_BLOCK', !!card('S3') && /mirror\.qa-sos\.test/.test(card('S3').src) && /^busy\.qa-sos\.test/.test(s3[0]?.data.ref || '') && !!card('H6') && /blossom\.nostr\.build/.test(card('H6').src) && /^hang\.qa-sos\.test/.test(h6[0]?.data.ref || '') && !!card('N7') && card('N7').readyState >= 2, {
    s3: card('S3'),
    s3Attempts: s3.map((l) => l.data.ref),
    h6: card('H6'),
    h6Attempts: h6.map((l) => ({ ref: l.data.ref, ms: l.t - g.t0 })),
    n7FirstCandidateMs: readyAt('N7'),
  });

  // sovbit is never the first attempt when a valid hash offers Blossom alternatives
  const unitOrder = await g.page.evaluate((h) => {
    // eslint-disable-next-line no-undef
    const list = buildPublicMediaCandidates(`https://files.sovbit.host/${h}.mp4`, h, []);
    return list.map((x) => new URL(x).hostname);
  }, HASH.SV16);
  const firstRef = (lbl) => String(candLogs(lbl)[0]?.data.ref || '');
  const sovFirst = ['SV16', 'SV17', 'SV18'].filter((l) => firstRef(l).startsWith('files.sovbit.host'));
  report.SOVBIT_FIRST_WITH_HASH_ALTERNATIVE = sovFirst.length > 0 || unitOrder[0] === 'files.sovbit.host';
  set('SOVBIT_NOT_FIRST_WITH_HASH_ALTERNATIVE', !report.SOVBIT_FIRST_WITH_HASH_ALTERNATIVE && unitOrder[unitOrder.length - 1] === 'files.sovbit.host', {
    unitOrder,
    firstAttempts: ['SV16', 'SV17', 'SV18'].map((l) => `${l}:${firstRef(l).split('/')[0]}`),
  });
  const sovbitHitsBefore = (lbl) => {
    const okAt = g.media.find((m) => m.h === HASH[lbl].slice(0, 12) && m.host !== 'files.sovbit.host' && m.method === 'GET');
    return g.media.filter((m) => m.h === HASH[lbl].slice(0, 12) && m.host === 'files.sovbit.host' && (!okAt || m.t <= okAt.t)).length;
  };
  const sv16 = candLogs('SV16');
  report.FIRST_ATTEMPT_HOST_SOVBIT_404 = firstRef('SV16').split('/')[0];
  set('SOVBIT_404_FAST_FALLBACK', !!card('SV16') && card('SV16').readyState >= 2 && /blossom\.band/.test(card('SV16').src) && report.FIRST_ATTEMPT_HOST_SOVBIT_404 !== 'files.sovbit.host' && sovbitHitsBefore('SV16') === 0, {
    firstAttemptHost: report.FIRST_ATTEMPT_HOST_SOVBIT_404,
    attempts: sv16.map((l) => l.data.ref.split('/')[0]),
    sovbitRequestsBeforeBlossom: sovbitHitsBefore('SV16'),
    SOVBIT_404_DOES_NOT_DELAY_HEALTHY_BLOSSOM: sovbitHitsBefore('SV16') === 0 ? 'PASS' : 'FAIL',
  });
  const sv18 = candLogs('SV18');
  set('SOVBIT_503_NONBLOCKING', !!card('SV17') && /blossom\.nostr\.build/.test(card('SV17').src) && sovbitHitsBefore('SV17') === 0 && !card('SV18') && !!card('I15') && gBoot.firstMs !== null && !gBoot.safety, {
    sv17: card('SV17') && card('SV17').src.replace(/[0-9a-f]{64}/, '<hash>'),
    sv17Attempts: candLogs('SV17').map((l) => l.data.ref.split('/')[0]),
    sv18Attempts: sv18.map((l) => l.data.ref.split('/')[0]),
    sv18Mounted: !!card('SV18'),
    nextCardMounted: !!card('I15'),
    SOVBIT_503_DOES_NOT_BLOCK_FIRST_PAINT: gBoot.firstMs !== null && !gBoot.safety ? 'PASS' : 'FAIL',
  });
  const dups = duplicateAttempts(gLog);
  report.DUPLICATE_MEDIA_URL_ATTEMPTS = dups;
  set('NO_DUPLICATE_MEDIA_URL', dups === 0, { duplicates: dups, candidateLogs: gLog.filter((l) => /media candidate$/.test(l.text)).length });
  const domIds = gSnap.cards.map((c) => c.id);
  const displayMounted = gSnap.display.filter((id) => domIds.includes(id));
  set('DETERMINISTIC_ORDER', JSON.stringify(displayMounted) === JSON.stringify(domIds.filter((id) => gSnap.display.includes(id))), { dom: domIds.slice(0, 12).map(L) });
  const stream = gLog.find((l) => /media candidate$/.test(l.text));
  set('STREAM_FIRST_PUBLIC_MEDIA', !!card('N1') && /^https:\/\/media\.qa-sos\.test\//.test(card('N1').src), { n1Source: card('N1') && card('N1').src.replace(/[0-9a-f]{64}/, '<hash>'), firstCandidate: stream && stream.data });

  // engagement still hydrates
  const tEng = Date.now();
  let eng = { likes: 0, comments: 0 };
  while (Date.now() - tEng < 30000) {
    eng = await g.page.evaluate((id) => ({ likes: window.NostrApp.likesByEventId?.get(id)?.size || 0, comments: typeof getVisibleCommentCount === 'function' ? getVisibleCommentCount(id) : 0 }), P.N1.id); // eslint-disable-line no-undef
    if (eng.likes > 0 && eng.comments > 0) break;
    await sleep(500);
  }
  set('LIKES', eng.likes > 0, eng);
  set('COMMENTS', eng.comments > 0, eng);

  // historical replay (200 posts before EOSE) never auto-mounts
  const accepted = gLog.filter((l) => /live post accepted/.test(l.text));
  const hist = new Set(histIds().map((id) => id.slice(0, 8)));
  const histAuto = gLog.filter((l) => /live post accepted|new post auto-mounted/.test(l.text) && l.data && hist.has(String(l.data.id || '').slice(0, 8))).length;
  report.HISTORICAL_REPLAY_AUTO_MOUNT_COUNT = histAuto;
  set('HISTORICAL_REPLAY_NOT_MOUNTED', histAuto === 0 && accepted.length === 0, { acceptedDuringBoot: accepted.length, historicalAutoMounted: histAuto });

  // ---- 2. remote kind 1 after EOSE auto-mounts (user at top -> becomes the first card)
  await g.page.evaluate(() => {
    const vp = document.querySelector('.videos-feed__viewport');
    if (vp) vp.scrollTop = 0;
  });
  await sleep(500);
  const R1 = nativePost('R1', AUTHORS[1], Math.floor(Date.now() / 1000), 'media.qa-sos.test');
  P.R1 = R1;
  label.set(R1.id, 'R1');
  const delivered = H.publish(R1);
  const r1 = await waitCard(g.page, R1.id, 20000);
  report.REMOTE_NEW_POST_AUTO_MOUNT_MS = r1.ms;
  set('REMOTE_KIND1_AFTER_EOSE_AUTO_MOUNTS', r1.ms !== null && r1.snap.cards[0]?.id === R1.id, { ms: r1.ms, delivered, first: L(r1.snap.cards[0]?.id) });

  // late-delivered old event after EOSE (created 2 h ago) is not auto-mounted
  const OLD = textPost('OLD_LIVE', AUTHORS[2], now - 7300, [img('old-live')]);
  label.set(OLD.id, 'OLD_LIVE');
  H.publish(OLD);
  await sleep(4000);
  const oldSnap = await feedSnapshot(g.page);
  const oldLog = (await qaLog(g)).filter((l) => /live post accepted/.test(l.text) && l.data && l.data.id === OLD.id.slice(0, 8));
  set('LATE_HISTORICAL_EVENT_NOT_MOUNTED', !oldSnap.cards.some((c) => c.id === OLD.id) && oldLog.length === 0, { mounted: oldSnap.cards.some((c) => c.id === OLD.id) });

  // ---- 3. mid-feed: a new post must not move the centered card
  await g.page.evaluate(() => {
    const cards = document.querySelectorAll('.videos-feed__stream .videos-feed__card[data-event-id]');
    const target = cards[4] || cards[cards.length - 1];
    if (target) target.scrollIntoView({ block: 'start', behavior: 'auto' });
  });
  await sleep(1200);
  const before = await feedSnapshot(g.page);
  const R2 = nativePost('R2', AUTHORS[0], Math.floor(Date.now() / 1000), 'media.qa-sos.test');
  label.set(R2.id, 'R2');
  H.publish(R2);
  const r2 = await waitCard(g.page, R2.id, 20000);
  await sleep(800);
  const after = await feedSnapshot(g.page);
  report.SCROLL_ANCHOR_PRESERVED = !!before.centered && before.centered === after.centered && r2.ms !== null && before.scrollTop > 24;
  set('SCROLL_ANCHOR_PRESERVED', report.SCROLL_ANCHOR_PRESERVED, {
    centeredBefore: L(before.centered),
    centeredAfter: L(after.centered),
    scrollTopBefore: before.scrollTop,
    scrollTopAfter: after.scrollTop,
    r2Mounted: r2.ms !== null,
    r2Index: after.cards.findIndex((c) => c.id === R2.id),
  });

  // ---- 4. periodic refresh path (same loadVideos tick the 120 s interval runs) auto-mounts without Home
  const R3 = nativePost('R3', AUTHORS[2], Math.floor(Date.now() / 1000), 'media.qa-sos.test');
  label.set(R3.id, 'R3');
  H.add(R3); // stored only: not delivered to the live subscription
  await g.page.evaluate(() => loadVideos()); // eslint-disable-line no-undef
  const r3 = await waitCard(g.page, R3.id, 25000);
  report.PERIODIC_RECOVERY_AUTO_MOUNT = r3.ms !== null;
  set('PERIODIC_REFRESH_AUTO_MOUNT_WITHOUT_HOME', r3.ms !== null, { ms: r3.ms });

  // ---- 5. deletion / moderation unchanged: the author's live kind 5 removes the card
  const delTarget = P.N8;
  H.publish(sign(AUTHORS[8 % AUTHORS.length], { kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [['e', delTarget.id], ['t', NET]], content: '' }));
  const tDel = Date.now();
  let delSnap = null;
  while (Date.now() - tDel < 15000) {
    delSnap = await feedSnapshot(g.page);
    if (!delSnap.cards.some((c) => c.id === delTarget.id) && !delSnap.display.includes(delTarget.id)) break;
    await sleep(300);
  }
  set('DELETION_UNCHANGED', !delSnap.cards.some((c) => c.id === delTarget.id) && !delSnap.display.includes(delTarget.id), { ms: Date.now() - tDel });

  // ---- 6. blocked / suppressed author cannot re-enter through the getDisplayVideos fallback
  const blocked = await g.page.evaluate((pk) => {
    /* eslint-disable no-undef */
    // the policy object is frozen: swap the App reference for a test-only wrapper, then restore it
    const App = window.NostrApp;
    const MP = App?.ModerationPolicy || window.SosModerationPolicy;
    const saved = state.videos;
    try {
      // a state where only suppressed-author file posts exist -> the general filter is empty and the fallback runs
      state.videos = saved.filter((v) => v.pubkey === pk && (v.videoUrl || v.hash));
      App.ModerationPolicy = { ...MP, isAuthorSuppressed: (p) => p === pk || MP.isAuthorSuppressed(p) };
      const patched = App.ModerationPolicy !== MP && isVideoAuthorSuppressed({ pubkey: pk });
      return { candidates: state.videos.length, displayed: getDisplayVideos().length, hasPolicy: !!MP && patched };
    } finally {
      state.videos = saved;
      App.ModerationPolicy = MP;
    }
    /* eslint-enable no-undef */
  }, AUTHORS[1].pub);
  report.BLOCKED_AUTHOR_FALLBACK = blocked.hasPolicy && blocked.candidates > 0 && blocked.displayed === 0 ? 'EXCLUDED' : 'LEAK';
  set('BLOCKED_AUTHOR_FALLBACK_EXCLUDED', report.BLOCKED_AUTHOR_FALLBACK === 'EXCLUDED', blocked);

  // ---- 7. YouTube still renders outside the general Videos feed (profile / own-posts surface)
  const ytElsewhere = await g.page.evaluate((id) => {
    /* eslint-disable no-undef */
    const v = state.videos.find((x) => x.id === id);
    const savedMode = state.feedMode;
    try {
      state.feedMode = 'own-posts';
      const r = v ? renderVideoCard(v) : null;
      r?.mediaReadyPromise?.catch(() => {});
      const type = r?.card?.querySelector('.videos-feed__media')?.dataset.mediaType || '';
      return { parsedYoutubeId: !!v?.youtubeId, ownPostsType: type };
    } finally {
      state.feedMode = savedMode;
    }
    /* eslint-enable no-undef */
  }, P.Y0.id);
  const feedJsUntouched = execSync('git diff --name-only HEAD -- feed.js chat-media-renderer.js', { cwd: ROOT }).toString().trim() === '';
  set('YOUTUBE_OUTSIDE_VIDEOS_FEED_PRESERVED', ytElsewhere.parsedYoutubeId && ytElsewhere.ownPostsType === 'youtube' && feedJsUntouched, { ...ytElsewhere, feedJsUntouched });
  await g.ctx.close();

  // ---- 7b. background persist is view-driven and cache never reorders the feed
  const pc = await freshContext('PERSIST_CACHE_ORDER');
  await pc.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await measureBoot(pc);
  const warmed = await poll(async () => {
    const sn = await feedSnapshot(pc.page);
    return sn.cards.filter((c) => c.type === 'file' && c.ready).length >= 10 ? sn : null;
  }, 40000);
  await sleep(2500);
  const pcSnap0 = await feedSnapshot(pc.page);
  const centered0 = L(pcSnap0.centered);
  const unviewed = fullGets(pc).filter((m) => labelOfHash12(m.h) !== centered0);
  report.UNVIEWED_BACKGROUND_FULL_FETCH_COUNT = unviewed.length;
  report.WARMED_NATIVE_CARDS = pcSnap0.cards.filter((c) => c.type === 'file' && c.ready).length;
  set('UNVIEWED_MEDIA_NOT_BACKGROUND_PERSISTED', !!warmed && report.WARMED_NATIVE_CARDS >= 10 && unviewed.length === 0, {
    warmedNativeCards: report.WARMED_NATIVE_CARDS,
    centered: centered0,
    unviewedFullFetches: unviewed.map((m) => `${m.host}:${labelOfHash12(m.h)}`),
  });
  const constants = await pc.page.evaluate(() => ({
    /* eslint-disable no-undef */
    queueMax: BACKGROUND_PERSIST_QUEUE_MAX,
    sessionBudget: BACKGROUND_PERSIST_SESSION_BYTE_BUDGET,
    /* eslint-enable no-undef */
  }));
  report.BACKGROUND_PERSIST_QUEUE_MAX = constants.queueMax;
  report.BACKGROUND_PERSIST_SESSION_BYTE_BUDGET = constants.sessionBudget;
  set('BACKGROUND_PERSIST_BOUNDS', constants.queueMax <= 3 && constants.sessionBudget <= 160 * 1024 * 1024, constants);

  // the centered card plays -> exactly one background persist for it
  const displayBeforeWrite = pcSnap0.display.slice();
  if (!fullGets(pc, centered0).length) await playCentered(pc.page);
  await poll(async () => fullGets(pc, centered0).length >= 1 && (await cachedHas(pc.page, HASH[centered0])), 15000);
  await sleep(1500);
  report.VIEWED_VIDEO_BACKGROUND_PERSIST_COUNT = fullGets(pc, centered0).length;
  set('VIEWED_MEDIA_PERSISTED_ONCE', report.VIEWED_VIDEO_BACKGROUND_PERSIST_COUNT === 1 && (await cachedHas(pc.page, HASH[centered0])) && fullGets(pc).length === 1, {
    centered: centered0,
    viewedFullFetches: report.VIEWED_VIDEO_BACKGROUND_PERSIST_COUNT,
    totalFullFetches: fullGets(pc).length,
    cached: await cachedHas(pc.page, HASH[centered0]),
  });

  // navigate to an older card: one more bounded persist, no duplicate job for the first one
  await scrollToCard(pc.page, P.N12.id);
  const nav = await playCentered(pc.page);
  await poll(async () => fullGets(pc, 'N12').length >= 1 && (await cachedHas(pc.page, HASH.N12)), 15000);
  await scrollToCard(pc.page, pcSnap0.centered);
  await playCentered(pc.page);
  await sleep(2000);
  const pcSnap1 = await feedSnapshot(pc.page);
  set('NAVIGATE_PERSIST_BOUNDED_NO_DUPLICATE', L(nav.id) === 'N12' && fullGets(pc, 'N12').length === 1 && fullGets(pc, centered0).length === 1 && fullGets(pc).length === 2, {
    navigatedTo: L(nav.id),
    full: fullGets(pc).map((m) => labelOfHash12(m.h)),
  });

  // cache state never changes display order (same session, after the cache write)
  const n12Cached = await cachedHas(pc.page, HASH.N12);
  const n11Cached = await cachedHas(pc.page, HASH.N11);
  const idx = (arr, lbl) => arr.indexOf(P[lbl].id);
  const createdDesc = (arr) => arr.every((id, i) => i === 0 || (P[L(arr[i - 1])]?.created_at ?? Infinity) >= (P[L(id)]?.created_at ?? -Infinity));
  const sameOrder = (a, b2x) => {
    const common = a.filter((id) => b2x.includes(id));
    return JSON.stringify(common) === JSON.stringify(b2x.filter((id) => common.includes(id)));
  };
  report.NEWER_UNCACHED_BEFORE_OLDER_CACHED = n12Cached && !n11Cached && idx(pcSnap1.display, 'N11') >= 0 && idx(pcSnap1.display, 'N11') < idx(pcSnap1.display, 'N12');
  report.DISPLAY_ORDER_UNCHANGED_AFTER_CACHE_WRITE = JSON.stringify(displayBeforeWrite) === JSON.stringify(pcSnap1.display);
  // ---- warm restart (same context: IndexedDB media cache + localStorage feed cache survive)
  await pc.page.reload({ waitUntil: 'domcontentloaded' });
  pc.t0 = Date.now();
  await measureBoot(pc);
  await poll(async () => (await cachedHas(pc.page, HASH.N12)) && (await feedSnapshot(pc.page)).display.includes(P.N12.id), 20000);
  await sleep(2000);
  const pcSnap2 = await feedSnapshot(pc.page);
  const restartCached = await cachedHas(pc.page, HASH.N12);
  report.DISPLAY_ORDER_UNCHANGED_ON_WARM_RESTART = restartCached && sameOrder(pcSnap1.display, pcSnap2.display) && idx(pcSnap2.display, 'N11') < idx(pcSnap2.display, 'N12') && createdDesc(pcSnap2.display);
  report.CACHE_CAN_REORDER_FEED = !(report.NEWER_UNCACHED_BEFORE_OLDER_CACHED && report.DISPLAY_ORDER_UNCHANGED_AFTER_CACHE_WRITE && report.DISPLAY_ORDER_UNCHANGED_ON_WARM_RESTART);
  set('CACHE_DOES_NOT_REORDER_FEED', !report.CACHE_CAN_REORDER_FEED, {
    NEWER_UNCACHED_BEFORE_OLDER_CACHED: report.NEWER_UNCACHED_BEFORE_OLDER_CACHED,
    DISPLAY_ORDER_UNCHANGED_AFTER_CACHE_WRITE: report.DISPLAY_ORDER_UNCHANGED_AFTER_CACHE_WRITE,
    DISPLAY_ORDER_UNCHANGED_ON_WARM_RESTART: report.DISPLAY_ORDER_UNCHANGED_ON_WARM_RESTART,
    restartCached,
    displayCreatedDesc: createdDesc(pcSnap2.display),
    displayAfterWrite: pcSnap1.display.slice(0, 18).map(L),
    displayRestart: pcSnap2.display.slice(0, 18).map(L),
  });
  await pc.ctx.close();

  // ---- 7c. Save-Data: optional persist skipped entirely
  const sd = await freshContext('SAVE_DATA', { saveData: true });
  await sd.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  const sdBoot = await measureBoot(sd);
  const sdPlay = await playCentered(sd.page);
  await sleep(5000);
  report.SAVE_DATA_OPTIONAL_CACHE_FETCH_COUNT = fullGets(sd).length;
  set('SAVE_DATA_SKIPS_OPTIONAL_PERSIST', sdBoot.firstMs !== null && sdPlay.playing && fullGets(sd).length === 0, {
    firstMs: sdBoot.firstMs,
    centeredPlaying: sdPlay.playing,
    fullFetches: fullGets(sd).length,
  });
  await sd.ctx.close();

  // ---- 7d. real service worker: fresh (no controller) and controlled reload
  const sw = await freshContext('SW_FRESH', { realSw: true });
  await sw.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  const docId = () => sw.page.evaluate(() => ({ id: window.__qaDocId, nav: performance.getEntriesByType('navigation')[0]?.type || '' }));
  const swDoc0 = await docId();
  const swBoot = await measureBoot(sw);
  const swDoc1 = await docId();
  const swReg = await poll(
    () =>
      sw.page.evaluate(async () => {
        const r = navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
        return r && (r.active || r.waiting || r.installing) ? { scope: r.scope, active: !!r.active } : null;
      }),
    30000,
    500
  );
  const swA = await sw.page.evaluate(() => ({ ctrlAtLoad: window.__qaCtrlAtLoad === true, secure: window.isSecureContext === true }));
  await sleep(3000);
  const swDoc2 = await docId();
  // same document id from goto through first card and 3 s after registration -> no reload was needed
  const noReload = swDoc0.id === swDoc1.id && swDoc1.id === swDoc2.id && swDoc1.nav === 'navigate';
  report.SW_FIRST_LOAD_NO_CONTROLLER = {
    SW_REGISTERED: !!swReg,
    CONTROLLER_AT_LOAD: swA.ctrlAtLoad,
    PUBLIC_NATIVE_FEED_VISIBLE: swBoot.firstMs !== null,
    FIRST_NATIVE_CARD_VISIBLE_WITHOUT_RELOAD: swBoot.firstMs !== null && noReload,
    SAFETY_TIMEOUT_USED: swBoot.safety,
    firstMs: swBoot.firstMs,
    navigationType: swDoc1.nav,
    frameNavigatedEvents: sw.navs,
  };
  set('SW_FRESH_NO_CONTROLLER_FEED', swA.secure && !!swReg && !swA.ctrlAtLoad && swBoot.firstMs !== null && noReload && !swBoot.safety, report.SW_FIRST_LOAD_NO_CONTROLLER);
  await poll(() => sw.page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active), 20000, 500);
  sw.navs = 0;
  await sw.page.reload({ waitUntil: 'domcontentloaded' });
  sw.t0 = Date.now();
  const swBoot2 = await measureBoot(sw);
  const swB = await sw.page.evaluate(() => ({ ctrlAtLoad: window.__qaCtrlAtLoad === true, ctrlNow: !!navigator.serviceWorker?.controller }));
  report.SW_CONTROLLED_RELOAD = {
    SW_CONTROLLER_PRESENT: swB.ctrlAtLoad || swB.ctrlNow,
    PUBLIC_NATIVE_FEED_VISIBLE: swBoot2.firstMs !== null,
    SAFETY_TIMEOUT_USED: swBoot2.safety,
    firstMs: swBoot2.firstMs,
  };
  set('SW_CONTROLLED_RELOAD_FEED', (swB.ctrlAtLoad || swB.ctrlNow) && swBoot2.firstMs !== null && !swBoot2.safety, report.SW_CONTROLLED_RELOAD);
  await sw.ctx.close();

  // ---- 8. fresh signed-in (no peers): key imported, feed cache cleared, signed-in boot
  const s = await freshContext('FRESH_SIGNED_IN');
  await s.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitApp(s.page);
  await login(s.page, USER);
  await sleep(1500);
  await s.page.evaluate(() => {
    localStorage.removeItem('videos_feed_cache_v3');
    localStorage.removeItem('videos_failed_media_v3');
  });
  await s.page.reload({ waitUntil: 'domcontentloaded' });
  s.t0 = Date.now();
  await s.page.evaluate(() => {
    window.__qaLog = [];
  });
  await waitApp(s.page);
  const restored = await s.page
    .waitForFunction((p) => String(window.NostrApp.publicKey || '').toLowerCase() === p, USER.pub, { polling: 200, timeout: 25000 })
    .then(() => true, () => false);
  if (!restored) await login(s.page, USER);
  const sBoot = await measureBoot(s);
  const sIdentity = await s.page.evaluate(() => ({ guest: window.NostrApp.guestMode === true, pub: String(window.NostrApp.publicKey || '').toLowerCase() }));
  report.SIGNED_IN_FIRST_NATIVE_CARD_VISIBLE_MS = sBoot.firstMs;
  report.SIGNED_IN_BOOT_RELEASE_MS = sBoot.bootReleaseMs;
  set('FRESH_SIGNED_IN_MP4_VISIBLE', !sIdentity.guest && sIdentity.pub === USER.pub && sBoot.firstMs !== null && sBoot.firstMs < PERF.FIRST_NATIVE_CARD_VISIBLE_MS && !sBoot.safety, {
    restoredOnReload: restored,
    firstMs: sBoot.firstMs,
    bootReleaseMs: sBoot.bootReleaseMs,
    bootReason: sBoot.bootReason,
  });
  report.SIGNED_IN_NO_PEER_BOOT_BLOCK = report.results.FRESH_SIGNED_IN_MP4_VISIBLE.ok ? 'PASS' : 'FAIL';

  // self publish stays immediate (forceShow -> top)
  const SELF = nativePost('SELF', USER, Math.floor(Date.now() / 1000), 'media.qa-sos.test');
  H.add(SELF);
  await s.page.evaluate((ev) => onVideoPostPublished(ev), SELF); // eslint-disable-line no-undef
  label.set(SELF.id, 'SELF');
  const self = await waitCard(s.page, SELF.id, 15000);
  await sleep(1500);
  const selfAfter = await feedSnapshot(s.page);
  set('SELF_PUBLISH', self.ms !== null && selfAfter.cards[0]?.id === SELF.id && selfAfter.scrollTop <= 24, {
    ms: self.ms,
    domTop: selfAfter.cards.slice(0, 3).map((c) => L(c.id)),
    displayTop: selfAfter.display.slice(0, 3).map(L),
    scrollTop: selfAfter.scrollTop,
    domIndex: selfAfter.cards.findIndex((c) => c.id === SELF.id),
    displayIndex: selfAfter.display.indexOf(SELF.id),
    stateIndex: selfAfter.stateIds.indexOf(SELF.id),
    failed: selfAfter.failedIds.includes(SELF.id),
  });
  await s.ctx.close();

  // ---- 9. optional baseline (first paint only, informational)
  if (BASELINE) {
    serveBaseline = BASELINE;
    const bg = await freshContext('BASELINE_GUEST');
    await bg.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const bgBoot = await measureBoot(bg, 60000);
    await bg.ctx.close();
    const bs = await freshContext('BASELINE_SIGNED_IN');
    await bs.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitApp(bs.page);
    await login(bs.page, USER);
    await sleep(1500);
    await bs.page.evaluate(() => {
      localStorage.removeItem('videos_feed_cache_v3');
      localStorage.removeItem('videos_failed_media_v3');
    });
    await bs.page.reload({ waitUntil: 'domcontentloaded' });
    bs.t0 = Date.now();
    await waitApp(bs.page);
    const bsBoot = await measureBoot(bs, 60000);
    await bs.ctx.close();
    serveBaseline = '';
    report.BASELINE = {
      commit: BASELINE,
      guestFirstNativeMs: bgBoot.firstMs,
      guestBootReleaseMs: bgBoot.bootReleaseMs,
      guestBootReason: bgBoot.bootReason,
      signedInFirstNativeMs: bsBoot.firstMs,
      signedInBootReleaseMs: bsBoot.bootReleaseMs,
      signedInBootReason: bsBoot.bootReason,
    };
    info('BASELINE', report.BASELINE);
    const oldMs = bsBoot.firstMs === null ? Infinity : bsBoot.firstMs;
    report.SIGNED_IN_NO_PEER_FIRST_PAINT_PENALTY_LT_OLD_PATH = sBoot.firstMs !== null && sBoot.firstMs < oldMs;
    set('SIGNED_IN_NO_PEER_FASTER_THAN_OLD_PATH', report.SIGNED_IN_NO_PEER_FIRST_PAINT_PENALTY_LT_OLD_PATH, { newMs: sBoot.firstMs, oldMs: bsBoot.firstMs });
  }

  // ---- 10. WebKit smoke (real H.264 fixture); never fabricated when WebKit is unavailable
  let wk = null;
  try {
    wk = await webkit.launch({ headless: true });
  } catch (e) {
    report.WEBKIT_SMOKE = 'NOT_AVAILABLE';
    report.WEBKIT_SMOKE_DETAIL = String(e && e.message ? e.message : e).split('\n')[0].slice(0, 200);
  }
  if (wk) {
    try {
      const WK = nativePost('WK1', AUTHORS[0], Math.floor(Date.now() / 1000), `http://127.0.0.1:${PORT}/qa-mp4`);
      P.WK1 = WK;
      label.set(WK.id, 'WK1');
      H.add(WK);
      const w = await freshContext('WEBKIT_SMOKE', { b: wk });
      await w.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
      const wSnap = await poll(async () => {
        const sn = await feedSnapshot(w.page);
        return sn.bootReleased && sn.cards.some((c) => c.id === WK.id && c.type === 'file' && c.readyState >= 1) ? sn : null;
      }, 60000, 300);
      const wLast = wSnap || (await feedSnapshot(w.page));
      const wLog = await qaLog(w);
      const wSafety = wLog.some((l) => /Boot safety timeout/.test(l.text) || (/boot loading released/.test(l.text) && /safety/.test(String(l.data ?? ''))));
      const wFile = wLast.cards.filter((c) => c.id === WK.id && c.type === 'file');
      const smoke = {
        YOUTUBE_ONLY_ABSENT: !wLast.display.includes(P.Y0.id) && !wLast.cards.some((c) => c.id === P.Y0.id),
        NATIVE_CARD_CREATED: wFile.length > 0,
        LOADEDMETADATA_OR_PLAYABLE: wFile.some((c) => c.readyState >= 1),
        SAFETY_TIMEOUT_USED: wSafety,
        firstFileReadyState: wFile[0] ? wFile[0].readyState : null,
        version: wk.version(),
        cards: wLast.cards.length,
        display: wLast.display.length,
        bootReleased: wLast.bootReleased,
        mediaRequests: w.media.length,
        candidateLogs: wLog.filter((l) => /media candidate/.test(l.text)).length,
        canPlayH264: await w.page.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"')),
        harnessNote: 'Playwright WebKit (Windows) rejects route-fulfilled media (MEDIA_ERR_SRC_NOT_SUPPORTED); the smoke card streams the same H.264 fixture from the local HTTP server.',
      };
      report.WEBKIT_SMOKE_DETAIL = smoke;
      report.WEBKIT_SMOKE = smoke.YOUTUBE_ONLY_ABSENT && smoke.NATIVE_CARD_CREATED && smoke.LOADEDMETADATA_OR_PLAYABLE && !smoke.SAFETY_TIMEOUT_USED ? 'PASS' : 'FAIL';
      set('WEBKIT_SMOKE', report.WEBKIT_SMOKE === 'PASS', smoke);
      await w.ctx.close();
    } finally {
      await wk.close().catch(() => {});
    }
  } else {
    info('WEBKIT_SMOKE', report.WEBKIT_SMOKE_DETAIL);
  }
  report.IOS_SAFARI_DEPLOY_GATE = 'PENDING_OWNER_MANUAL';

  report.CONFIG_TRANSFORMS = CONFIG_TRANSFORMS;
  report.STREAM_FIRST_TRADEOFF =
    'Public feed media streams from the winning candidate URL for first paint. Persistent caching is view-driven: only a card that is centered and playing re-fetches its URL once in the background (queue max 3, 160MB per session, skipped under Save-Data, SHA-256 verified against the event hash). Warmed but unviewed cards are never fully downloaded in the background.';
  const failed = Object.entries(report.results).filter(([, v]) => !v.ok).map(([k]) => k);
  report.status = failed.length ? 'FAIL' : 'PASS';
  report.failed = failed;
  exitCode = failed.length ? 1 : 0;
  console.log('RESULT', report.status, 'passed', Object.keys(report.results).length - failed.length, 'failed', failed.join(','));
} catch (e) {
  report.status = 'ERROR';
  report.error = String(e && e.stack ? e.stack : e).slice(0, 800);
  console.log('ERROR', report.error);
} finally {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  try {
    if (browser) await browser.close();
  } catch (_e) {}
  await Promise.allSettled([H.stop(), new Promise((r) => B.close(() => r())), new Promise((r) => server.close(() => r()))]);
  process.exit(exitCode);
}
