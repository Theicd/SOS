/**
 * Package 899t — guest user-as-server media replication (real browsers, real WebRTC, real bytes).
 *
 * A fresh guest downloads, verifies, caches, advertises and SERVES public hash-backed media over the narrow
 * GUEST_PUBLIC_MEDIA_FILE_TRANSFER path (file-request / file-response / ice-candidate only, NIP-44 to an explicit
 * recipient, signed by the ephemeral guest identity inside the vault, network-bound, TTL + replay protected).
 * Generic guest private signalling stays denied; the negative matrix injects forged signals straight into the
 * guest's live subscription and counts the guest's real responses on the relay.
 *
 * Same harness as package899t-p2p-replication-gate.mjs (local NIP-01 relay, test-only config.js relay transform,
 * per-context Blossom interception). App.downloadVideoWithP2P is never mocked.
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
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, nip44 } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'package899t-guest-p2p-report.json');
const PORT = Number(process.env.SOS_899T_GUEST_PORT || 8897);
const R_PORT = 7897;
const RELAY = `ws://127.0.0.1:${R_PORT}`;
const URL0 = `http://127.0.0.1:${PORT}/videos.html`;
const NET = 'israel-network';
const LIMITS = { FIRST_NATIVE_CARD_VISIBLE_MS: 5000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const mkKey = () => {
  const sk = generateSecretKey();
  return { sk, hex: hex(sk), pub: getPublicKey(sk) };
};

const report = { gate: 'PACKAGE899T_GUEST_P2P', relay: RELAY, ts: new Date().toISOString(), results: {}, metrics: {} };
const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600));
};

// ---------------------------------------------------------------- media
const FIXTURE = fs.readFileSync(path.join(ROOT, 'qa', 'fixtures', '899s-h264-160x120.mp4'));
const MEDIA = new Map();
function mkMedia(label) {
  const payload = Buffer.concat([Buffer.from(`sos-899t-guest-qa:${label}:`), crypto.randomBytes(400 * 1024)]);
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
  // raw delivery into every live subscription that targets `pub` (bypasses relay verification and dedupe)
  inject(pub, ev) {
    let delivered = 0;
    this.subs.forEach((subs, ws) => {
      subs.forEach((filters, id) => {
        if (filters.some((f) => Array.isArray(f['#p']) && f['#p'].includes(pub))) {
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
  privateSignalsBy(pub) {
    return Array.from(this.events.values()).filter((e) => e.kind === 30078 && e.pubkey === pub && e.tags.some((t) => t[0] === 't' && /^p2p-(req|res|ice)$/.test(t[1])));
  }
  responsesTo(from, to) {
    return this.privateSignalsBy(from).filter((e) => e.tags.some((t) => t[0] === 't' && t[1] === 'p2p-res') && e.tags.some((t) => t[0] === 'p' && t[1] === to));
  }
  hasLiveSubFor(pub) {
    let found = false;
    this.subs.forEach((subs) => subs.forEach((filters) => {
      if (filters.some((f) => Array.isArray(f['#p']) && f['#p'].includes(pub))) found = true;
    }));
    return found;
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

// ---------------------------------------------------------------- content
const now = Math.floor(Date.now() / 1000);
const AUTHOR = mkKey();
const P = [];
function seedPosts() {
  H.publish(finalizeEvent({ kind: 0, created_at: now - 3600, tags: [['t', NET]], content: JSON.stringify({ name: 'QA 899t Guest Author' }) }, AUTHOR.sk));
  for (let i = 0; i < 14; i++) {
    const h = mkMedia('P' + i);
    const url = `https://blossom.band/${h}.mp4`;
    const ev = finalizeEvent({ kind: 1, created_at: now - 60 - i * 30, tags: [['t', NET], ['media', 'video/mp4', url, h]], content: `qa 899t guest P${i}\n${url}` }, AUTHOR.sk);
    H.publish(ev);
    P.push({ ev, hash: h, url });
  }
}
const labelOfHash = (h) => {
  const k = String(h || '').slice(0, 12);
  const i = P.findIndex((p) => k && p.hash.startsWith(k));
  return i > -1 ? 'P' + i : '?';
};

// ---------------------------------------------------------------- browser
const ALLOWED_EXTERNAL_HOSTS = new Set(['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']);
const QA_LOG_RE = /^\[VIDEO_MEDIA_SOURCE\]|^\[MEDIA_REPLICA_(STORED|ADVERTISED)\]|^\[P2P-HASH\]|^\[SO-CALL SECURITY\]|^\[videos\] (boot loading released|media candidate|media recovered via p2p|media parked for p2p recovery|http candidates failed)/;
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
  try {
    const OrigPC = window.RTCPeerConnection;
    window.RTCPeerConnection = function (...args) {
      if (window.__qaNoPeer) throw new Error('qa-setup-no-peer');
      return new OrigPC(...args);
    };
    window.RTCPeerConnection.prototype = OrigPC.prototype;
  } catch (_e) {}
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
const pages = [];
function watchPage(u, page) {
  const buf = [];
  page.on('console', (m) => {
    if (buf.length < 30000) buf.push(m.text());
  });
  pages.push({ label: u.label, buf });
  u.consoleAll = buf;
}
async function newClient(label, { dead = [], slow = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, serviceWorkers: 'block' });
  const u = { label, ctx, st: { setup: false, dead: new Set(dead), slow: new Set(slow), slowMs: 9000 }, media: [] };
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
  await ctx.addInitScript(INIT, { reStr: QA_LOG_RE.source });
  u.page = await ctx.newPage();
  watchPage(u, u.page);
  contexts.push(u);
  return u;
}

const appReady = (page) =>
  page.waitForFunction(() => !!window.NostrApp?.downloadVideoWithP2P && typeof window.NostrApp?.canDownloadFromPeers === 'function', null, { timeout: 90000 });

async function guestPub(page) {
  return page.evaluate(() => String(window.NostrApp.getGuestKeys?.()?.publicKey || '').toLowerCase());
}
async function openGuest(u) {
  await u.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await appReady(u.page);
  const capable = await u.page.waitForFunction(() => window.NostrApp.guestMode !== false && window.NostrApp.canDownloadFromPeers() === true, null, { timeout: 30000 }).then(() => true).catch(() => false);
  u.pub = await guestPub(u.page);
  u.isGuest = true;
  return capable;
}
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
  u.st.setup = false;
  await u.page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await u.page.waitForFunction(
    (pub) => String(window.NostrApp?.publicKey || '').toLowerCase() === pub && window.NostrApp.guestMode !== true && window.NostrApp.canDownloadFromPeers?.() === true,
    key.pub,
    { timeout: 90000 },
  );
}

const waitLeader = (page) => page.waitForFunction(() => window.NostrApp?.isP2PLeader?.() === true, null, { timeout: 30000 }).then(() => true).catch(() => false);
const qaLog = (page) => page.evaluate(() => window.__qaLog.slice());
const firstPaint = (page) => page.evaluate(() => ({ ...window.__qaT }));
const sources = async (page) => (await qaLog(page)).filter((l) => l.text.startsWith('[VIDEO_MEDIA_SOURCE]')).map((l) => ({ src: l.text.split('=')[1], label: labelOfHash(l.data?.hash), ...l.data }));
async function poll(fn, ms, step = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}
async function hashState(page, h) {
  return page.evaluate(async (hash) => {
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
    };
  }, h);
}
// a same-hash boot download already in flight (FAST_BOOT, no HTTP fallback) is shared by the engine; retry like the feed recovery loop
async function acquire(page, item, mode = 'PERSIST_REPLICA', extra = {}) {
  let r = null;
  for (let i = 0; i < 4; i++) {
    r = await acquireOnce(page, item, mode, extra);
    if (r.ok) return { ...r, attempts: i + 1 };
    await sleep(1500);
  }
  return { ...r, attempts: 4 };
}
async function acquireOnce(page, item, mode, extra) {
  return page.evaluate(async ({ url, hash, mode, extra }) => {
    try {
      const r = await window.NostrApp.downloadVideoWithP2P(url, hash, 'video/mp4', { mode, allowHttpFallback: true, verifyHash: true, httpCandidates: [url], ...extra });
      return { ok: true, source: r.source, mediaSource: r.mediaSource || r.source, peer: r.peer ? String(r.peer).slice(0, 8) : null };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }, { url: item.url, hash: item.hash, mode, extra });
}
const maxHeartbeatFiles = (pub) => H.heartbeats(pub).map((e) => JSON.parse(e.content || '{}').files || 0).reduce((m, x) => Math.max(m, x), 0);
async function heartbeatAtLeastOne(page, pub) {
  await page.evaluate(() => window.NostrApp.sendHeartbeat?.());
  await poll(async () => maxHeartbeatFiles(pub) >= 1, 10000);
  return maxHeartbeatFiles(pub);
}
const fpOk = (m) => m && m.first !== null && m.first !== undefined && m.first < LIMITS.FIRST_NATIVE_CARD_VISIBLE_MS;

// ---------------------------------------------------------------- forged signals (negative matrix)
function forgeSignal({ attacker, recipient, type, data, t, network = NET, createdAt, extraTags = [], plaintext = false, omitP = false, omitNetwork = false, rawMessage = null }) {
  const message = rawMessage || { type, data };
  let content;
  if (plaintext) content = JSON.stringify(message);
  else {
    const key = nip44.v2.utils.getConversationKey(attacker.sk, recipient);
    content = JSON.stringify({ family: 'sos-p2p-signal', v: 1, alg: 'nip44', ct: nip44.v2.encrypt(JSON.stringify(message), key) });
  }
  const tags = [['d', `sos-p2p-video:signal:${Date.now()}${Math.random().toString(36).slice(2, 6)}`]];
  if (!omitP) tags.push(['p', recipient]);
  tags.push(['t', t || { 'file-request': 'p2p-req', 'file-response': 'p2p-res', 'ice-candidate': 'p2p-ice' }[type] || 'p2p-ice']);
  if (!plaintext) tags.push(['enc', 'nip44']);
  if (!omitNetwork) tags.push(['network', network]);
  extraTags.forEach((x) => tags.push(x));
  return finalizeEvent({ kind: 30078, created_at: createdAt || Math.floor(Date.now() / 1000), tags, content }, attacker.sk);
}

// ---------------------------------------------------------------- main
async function main() {
  await H.start();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  seedPosts();
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  report.browser = `msedge ${browser.version()}`;
  const X = P[0].hash;

  // ================= G4: no peer anywhere, healthy Blossom (fresh guest) =================
  const G4 = await newClient('G4');
  const g4Capable = await openGuest(G4);
  const g4fp = await poll(async () => {
    const x = await firstPaint(G4.page);
    return x.first ? x : null;
  }, 30000) || (await firstPaint(G4.page));
  const g4Src = await sources(G4.page);
  const g4Log = await qaLog(G4.page);
  const g4FirstCandidate = g4Log.find((l) => l.text.startsWith('[videos] media candidate'));
  const g4AwaitedP2P = g4Log.some((l) => l.text.startsWith('[videos] http candidates failed'));
  const g4Cfg = await G4.page.evaluate(() => window.NostrApp.getFeedAcquireConfig());
  report.GUEST_FIRST_CARD_NO_PEER_MS = g4fp.first ?? null;
  report.NO_P2P_DELAY_BEFORE_HTTP = !!g4FirstCandidate && !g4AwaitedP2P && g4Src.some((s) => s.label === 'P0' && s.src === 'blossom-stream');
  set('G4_NO_PEER_HEALTHY_BLOSSOM_FIRST_CARD', g4Capable && fpOk(g4fp) && report.NO_P2P_DELAY_BEFORE_HTTP
    && g4Cfg.GUEST_P2P_CAN_WIN_FIRST_CARD === true && g4Cfg.GUEST_BLOSSOM_CAN_WIN_FIRST_CARD === true, {
    guestCanDownloadFromPeers: g4Capable, FIRST_NATIVE_CARD_VISIBLE_MS: g4fp.first ?? null, firstCandidateMs: g4FirstCandidate?.t ?? null,
    sources: g4Src.slice(0, 3).map((s) => `${s.label}:${s.src}`), raceFlags: { p2p: g4Cfg.GUEST_P2P_CAN_WIN_FIRST_CARD, blossom: g4Cfg.GUEST_BLOSSOM_CAN_WIN_FIRST_CARD },
  });
  await G4.ctx.close();

  // ================= A registered seeds X from Blossom =================
  const A = await newClient('A');
  await openRegistered(A);
  await waitLeader(A.page);
  const aSeed = await acquire(A.page, P[0]);
  await A.page.evaluate(() => window.NostrApp.sendHeartbeat?.());
  await poll(async () => H.availability(X).some((e) => e.pubkey === A.pub), 10000);
  set('A_SEEDS_X', aSeed.ok && H.availability(X).some((e) => e.pubkey === A.pub), { seed: aSeed });

  // ================= G1: fresh guest, Blossom 404 for X -> downloads from A =================
  const G = await newClient('G', { dead: [X] });
  const gCapable = await openGuest(G);
  await waitLeader(G.page);
  const oldGuestPub = G.pub;
  const gSrc = await poll(async () => (await sources(G.page)).find((s) => s.label === 'P0'), 45000);
  await poll(async () => (await hashState(G.page, X)).availableFiles, 10000);
  const gState = await hashState(G.page, X);
  const gLog = await qaLog(G.page);
  await poll(async () => H.availability(X).some((e) => e.pubkey === G.pub), 15000);
  report.GUEST_CAN_DOWNLOAD_FROM_PEERS = gCapable;
  report.GUEST_SOURCE = gSrc ? gSrc.src : null;
  report.GUEST_P2P_BYTES_RECEIVED = gSrc && gSrc.src === 'p2p' ? gSrc.bytes : 0;
  report.GUEST_HASH_VERIFIED = !!gSrc && gState.cacheShaOk && !gLog.some((l) => l.text.startsWith('[P2P-HASH]'));
  report.GUEST_CACHE_CONTAINS_HASH = gState.cache && gState.cacheShaOk;
  report.GUEST_AVAILABLE_FILES_CONTAINS_HASH = gState.availableFiles && gState.availableShaOk;
  report.GUEST_INVENTORY_ADVERTISES_HASH = H.availability(X).some((e) => e.pubkey === G.pub && e.tags.some((t) => t[0] === 'guest'));
  report.GUEST_HEARTBEAT_FILES = await heartbeatAtLeastOne(G.page, G.pub);
  const gStored = gLog.find((l) => l.text.startsWith('[MEDIA_REPLICA_STORED]') && labelOfHash(l.data?.hash) === 'P0');
  set('G1_GUEST_BLOSSOM_404_DOWNLOADS_FROM_A', gCapable && report.GUEST_SOURCE === 'p2p' && gSrc.peer === A.pub.slice(0, 8) && report.GUEST_P2P_BYTES_RECEIVED > 0
    && report.GUEST_HASH_VERIFIED && report.GUEST_CACHE_CONTAINS_HASH && report.GUEST_AVAILABLE_FILES_CONTAINS_HASH
    && report.GUEST_INVENTORY_ADVERTISES_HASH && report.GUEST_HEARTBEAT_FILES >= 1 && gStored?.data?.indexedDb === true, {
    source: gSrc, state: gState, storedLog: gStored?.data || null, heartbeatFiles: report.GUEST_HEARTBEAT_FILES,
    leader: await G.page.evaluate(() => window.NostrApp.isP2PLeader?.()), guestPub8: G.pub.slice(0, 8),
    shareLog: G.consoleAll.filter((l) => /שיתוף|שותף|Availability|חתימה|denied|GUEST_|תור/.test(l)).slice(-10).map((l) => l.slice(0, 220)),
    availability: H.availability(X).map((e) => e.pubkey.slice(0, 8) + (e.tags.some((t) => t[0] === 'guest') ? ':guest' : '')),
    debug: gSrc ? undefined : (G.consoleAll.filter((l) => /feed-session|SECURITY|signal|P2P_PRIVATE/.test(l)).slice(-25).map((l) => l.slice(0, 200))),
  });

  // guest outgoing private signals on the wire: all encrypted envelopes, recipient-bound, network-bound
  const gWire = H.privateSignalsBy(G.pub);
  const wireOk = (e) => {
    const tg = (k) => e.tags.filter((t) => t[0] === k);
    let env = null;
    try {
      env = JSON.parse(e.content);
    } catch (_e) {}
    return tg('p').length === 1 && tg('enc').length === 1 && tg('enc')[0][1] === 'nip44' && tg('network')[0]?.[1] === NET
      && tg('guest')[0]?.[1] === 'true' && !!env && env.alg === 'nip44' && typeof env.ct === 'string' && env.type === undefined;
  };
  report.GUEST_P2P_SIGNAL_ENCRYPTED = gWire.length > 0 && gWire.every(wireOk);
  set('GUEST_P2P_SIGNALS_ENCRYPTED_ON_WIRE', report.GUEST_P2P_SIGNAL_ENCRYPTED, { count: gWire.length, types: [...new Set(gWire.map((e) => e.tags.find((t) => t[0] === 't')[1]))] });

  // ================= G2: A offline; C downloads X from guest G =================
  await A.ctx.close();
  const C = await newClient('C', { dead: [X] });
  await openRegistered(C);
  await waitLeader(C.page);
  const cRun = await acquire(C.page, P[0], 'PERSIST_REPLICA');
  const cSrc = (await sources(C.page)).find((s) => s.label === 'P0');
  const cState = await hashState(C.page, X);
  report.C_SOURCE = cSrc ? cSrc.src : null;
  report.C_PEER = cSrc && cSrc.peer === G.pub.slice(0, 8) ? 'GUEST' : cSrc ? cSrc.peer : null;
  report.C_HASH_VERIFIED = cState.cacheShaOk;
  report.A_OFFLINE_C_DOWNLOAD_FROM_GUEST = report.C_SOURCE === 'p2p' && report.C_PEER === 'GUEST' && report.C_HASH_VERIFIED;
  set('G2_A_OFFLINE_C_DOWNLOADS_FROM_GUEST', report.A_OFFLINE_C_DOWNLOAD_FROM_GUEST, {
    run: cRun, source: cSrc, state: cState,
    debug: report.A_OFFLINE_C_DOWNLOAD_FROM_GUEST ? undefined : {
      c: C.consoleAll.filter((l) => /feed-session|SECURITY|signal/.test(l)).slice(-15).map((l) => l.slice(0, 200)),
      g: G.consoleAll.filter((l) => /SECURITY|signal|קובץ/.test(l)).slice(-15).map((l) => l.slice(0, 200)),
    },
  });

  if (process.env.Q899T_GUEST_STOP_AFTER_G2 === '1') return;

  // ================= §12 negative matrix against the live guest G =================
  const offerSrc = await C.page.evaluate(async () => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel('qa');
    const o = await pc.createOffer();
    pc.close();
    return { type: o.type, sdp: o.sdp };
  });
  const req = (hash, cid) => ({ offer: offerSrc, hash, connectionId: cid });
  const cases = [];
  const runCase = async (name, build, expectResponses, { inject = true, repeat = 1 } = {}) => {
    const attacker = mkKey();
    const ev = build(attacker);
    for (let i = 0; i < repeat; i++) {
      if (inject) H.inject(G.pub, ev);
      else H.publish(ev);
      await sleep(150);
    }
    await sleep(2500);
    const got = H.responsesTo(G.pub, attacker.pub).length;
    const ok = got === expectResponses;
    cases.push({ name, expected: expectResponses, responses: got, ok });
    return ok;
  };
  const cid = () => `qa-${crypto.randomBytes(6).toString('hex')}`;
  await runCase('VALID_CONTROL', (a) => forgeSignal({ attacker: a, recipient: G.pub, type: 'file-request', data: req(X, cid()) }), 1);
  await runCase('REPLAYED', (a) => forgeSignal({ attacker: a, recipient: G.pub, type: 'file-request', data: req(X, cid()) }), 1, { repeat: 3 });
  await runCase('WRONG_RECIPIENT', (a) => forgeSignal({ attacker: a, recipient: mkKey().pub, type: 'file-request', data: req(X, cid()), extraTags: [] }), 0);
  await runCase('MISSING_RECIPIENT', (a) => forgeSignal({ attacker: a, recipient: G.pub, type: 'file-request', data: req(X, cid()), omitP: true }), 0);
  await runCase('WRONG_NETWORK', (a) => forgeSignal({ attacker: a, recipient: G.pub, type: 'file-request', data: req(X, cid()), network: 'other-network' }), 0);
  await runCase('MISSING_NETWORK', (a) => forgeSignal({ attacker: a, recipient: G.pub, type: 'file-request', data: req(X, cid()), omitNetwork: true }), 0);
  await runCase('STALE', (a) => forgeSignal({ attacker: a, recipient: G.pub, type: 'file-request', data: req(X, cid()), createdAt: Math.floor(Date.now() / 1000) - 900 }), 0);
  await runCase('BAD_SIGNATURE', (a) => {
    const ev = forgeSignal({ attacker: a, recipient: G.pub, type: 'file-request', data: req(X, cid()) });
    return { ...ev, sig: ev.sig.slice(0, -4) + (ev.sig.endsWith('0000') ? '1111' : '0000') };
  }, 0);
  await runCase('UNSUPPORTED_TYPE_FILE_OFFER', (a) => forgeSignal({ attacker: a, recipient: G.pub, type: 'file-offer', t: 'p2p-ice', data: req(X, cid()) }), 0);
  for (const kind of ['DIRECT_MESSAGE', 'GROUP_CHAT', 'VOICE', 'CALL', 'PRESENCE', 'POST', 'COMMENT', 'REACTION', 'INVITE', 'ADMIN', 'MODERATION', 'MEMBERSHIP', 'CAPABILITY_GRANT']) {
    await runCase(`DENIED_${kind}`, (a) => forgeSignal({ attacker: a, recipient: G.pub, t: 'p2p-req', rawMessage: { type: kind.toLowerCase().replace(/_/g, '-'), data: { connectionId: cid(), text: 'x' } } }), 0);
  }
  await runCase('OVERSIZED', (a) => forgeSignal({ attacker: a, recipient: G.pub, type: 'file-request', data: { offer: { type: 'offer', sdp: offerSrc.sdp + 'a=x-pad:' + 'z'.repeat(17000) + '\r\n' }, hash: X, connectionId: cid() } }), 0);
  await runCase('PRIVILEGED_FIELDS', (a) => forgeSignal({ attacker: a, recipient: G.pub, type: 'file-request', data: { ...req(X, cid()), capability: 'ADMIN' } }), 0);
  await runCase('EMBEDDED_EVENT', (a) => forgeSignal({ attacker: a, recipient: G.pub, rawMessage: { type: 'file-request', data: req(X, cid()), pubkey: a.pub, sig: 'ff'.repeat(64), kind: 1 } }), 0);
  await runCase('PLAINTEXT_PRIVATE_SIGNAL', (a) => forgeSignal({ attacker: a, recipient: G.pub, type: 'file-request', data: req(X, cid()), plaintext: true }), 0);
  await runCase('T_TAG_TYPE_MISMATCH', (a) => forgeSignal({ attacker: a, recipient: G.pub, type: 'file-request', t: 'p2p-ice', data: req(X, cid()) }), 0);

  // in-page: typed vault / access-control surface of the guest
  const surface = await G.page.evaluate(async () => {
    const App = window.NostrApp;
    const v = App.GuestP2PKeyVault || window.SosGuestP2PKeyVault;
    const GAC = App.GuestAccessControl || window.SosGuestAccessControl;
    const pub = String(App.getGuestKeys().publicKey || '').toLowerCase();
    const other = 'a'.repeat(64);
    const out = { sendDenied: {}, actionsDenied: {}, rawKey: {} };
    const types = ['dm', 'chat-message', 'group-chat', 'voice', 'call-offer', 'presence', 'post', 'comment', 'reaction', 'invite', 'admin', 'moderation', 'membership', 'capability-grant', 'file-offer', 'file-resend-request', 'file-ready'];
    for (const t of types) {
      try {
        await v.signPublicMediaFileSignal({ recipient: other, type: t, data: { connectionId: 'qa-1' } });
        out.sendDenied[t] = false;
      } catch (e) {
        out.sendDenied[t] = String(e.code || e.message || 'denied');
      }
    }
    const tryCode = async (fn) => {
      try {
        await fn();
        return 'ALLOWED';
      } catch (e) {
        return String(e.code || e.message || 'denied');
      }
    };
    out.missingRecipient = await tryCode(() => v.signPublicMediaFileSignal({ type: 'file-request', data: { connectionId: 'qa-1', hash: 'b'.repeat(64), offer: { type: 'offer', sdp: 'v=0' } } }));
    out.selfRecipient = await tryCode(() => v.signPublicMediaFileSignal({ recipient: pub, type: 'file-request', data: { connectionId: 'qa-1', hash: 'b'.repeat(64), offer: { type: 'offer', sdp: 'v=0' } } }));
    out.privilegedField = await tryCode(() => v.signPublicMediaFileSignal({ recipient: other, type: 'file-request', data: { connectionId: 'qa-1', hash: 'b'.repeat(64), offer: { type: 'offer', sdp: 'v=0' }, role: 'admin' } }));
    out.genericPrivateSignP2pEvent = await tryCode(() => v.signP2pEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'sos-p2p-video:signal:1'], ['p', other], ['t', 'p2p-req']], content: '{}' }));
    out.genericPrivateGate = GAC.canUseGroupP2P(pub, { signalClass: 'PEER_TARGETED_PRIVATE', requireRegistered: true });
    out.mediaGateWrongNetwork = GAC.canUseGroupP2P(pub, { signalClass: 'GUEST_PUBLIC_MEDIA_FILE_TRANSFER', signalType: 'file-request', recipient: other, networkTag: 'other-network' });
    out.mediaGateNoRecipient = GAC.canUseGroupP2P(pub, { signalClass: 'GUEST_PUBLIC_MEDIA_FILE_TRANSFER', signalType: 'file-request', networkTag: 'israel-network' });
    out.mediaGateBadType = GAC.canUseGroupP2P(pub, { signalClass: 'GUEST_PUBLIC_MEDIA_FILE_TRANSFER', signalType: 'dm', recipient: other, networkTag: 'israel-network' });
    out.mediaGateOk = GAC.canUseGroupP2P(pub, { signalClass: 'GUEST_PUBLIC_MEDIA_FILE_TRANSFER', signalType: 'file-request', recipient: other, networkTag: 'israel-network' });
    for (const a of ['POST', 'COMMENT', 'REACTION', 'FOLLOW', 'DIRECT_MESSAGE', 'GROUP_CHAT', 'PRESENCE', 'VOICE', 'CALL', 'PROFILE_EDIT', 'INVITE', 'MODERATION', 'MEMBERSHIP', 'ADMIN', 'CAPABILITIES']) {
      out.actionsDenied[a] = GAC.canGuestAction(a) === false;
    }
    out.rawKey.getPrivateKey = await tryCode(() => v.getPrivateKey());
    out.rawKey.exportGuestK = await tryCode(() => v.exportGuestK());
    const api = Object.keys(v).filter((k) => typeof v[k] === 'function');
    out.genericSignApis = api.filter((k) => /^(sign|signEvent|nip44Encrypt|nip44Decrypt|encrypt|decrypt|getSecret|getKey|exportKey)$/i.test(k));
    const ss = JSON.stringify(Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k)));
    out.rawKey.nsecInSessionStorage = /nsec1[0-9a-z]{20,}/.test(ss);
    out.rawKey.nsecInLocalStorage = /nsec1[0-9a-z]{20,}/.test(JSON.stringify(Object.keys(localStorage).map((k) => localStorage.getItem(k))));
    return out;
  });
  const sendAllDenied = Object.values(surface.sendDenied).every((x) => x !== false);
  const actionsAllDenied = Object.values(surface.actionsDenied).every(Boolean);
  const gatesOk = surface.genericPrivateGate?.ok === false && surface.mediaGateWrongNetwork?.ok === false && surface.mediaGateNoRecipient?.ok === false
    && surface.mediaGateBadType?.ok === false && surface.mediaGateOk?.ok === true && surface.mediaGateOk?.grantsMembership === false && surface.mediaGateOk?.grantsControlCapability === false;
  const vaultRejects = ![surface.missingRecipient, surface.selfRecipient, surface.privilegedField, surface.genericPrivateSignP2pEvent].includes('ALLOWED');
  report.GUEST_RAW_PRIVATE_KEY_EXPOSED = surface.rawKey.getPrivateKey === 'ALLOWED' || surface.rawKey.exportGuestK === 'ALLOWED' || surface.rawKey.nsecInSessionStorage || surface.rawKey.nsecInLocalStorage;
  report.NO_GENERIC_GUEST_PRIVATE_SIGNAL = surface.genericPrivateGate?.ok === false && surface.genericPrivateSignP2pEvent !== 'ALLOWED' && surface.genericSignApis.length === 0;
  report.GENERIC_GUEST_PRIVATE_P2P_ALLOWED = !report.NO_GENERIC_GUEST_PRIVATE_SIGNAL;
  const matrixOk = cases.every((c) => c.ok);
  report.GUEST_PUBLIC_MEDIA_FILE_TRANSFER_ONLY = matrixOk && sendAllDenied && actionsAllDenied && gatesOk && vaultRejects;
  report.NEGATIVE_MATRIX = { passed: cases.filter((c) => c.ok).length, total: cases.length };
  set('GUEST_SECURITY_NEGATIVE_MATRIX', matrixOk, { cases });
  set('GUEST_TYPED_SURFACE_ONLY', report.GUEST_PUBLIC_MEDIA_FILE_TRANSFER_ONLY && report.NO_GENERIC_GUEST_PRIVATE_SIGNAL && !report.GUEST_RAW_PRIVATE_KEY_EXPOSED, surface);

  // ================= G3: close G; reopen the same storage as a fresh guest =================
  await G.page.close();
  G.page = await G.ctx.newPage();
  watchPage(G, G.page);
  await openGuest(G);
  await waitLeader(G.page);
  const newGuestPub = G.pub;
  await poll(async () => (await hashState(G.page, X)).availableFiles, 15000);
  const g3State = await hashState(G.page, X);
  await poll(async () => H.availability(X).some((e) => e.pubkey === newGuestPub), 15000);
  const g3Heartbeat = await heartbeatAtLeastOne(G.page, newGuestPub);
  report.NEW_GUEST_IDENTITY_AFTER_RELOAD = !!newGuestPub && newGuestPub !== oldGuestPub;
  report.GUEST_RELOAD_CACHE_SURVIVES = g3State.cache && g3State.cacheShaOk;
  report.GUEST_RELOAD_READVERTISES = g3State.availableFiles && H.availability(X).some((e) => e.pubkey === newGuestPub) && g3Heartbeat >= 1;
  await C.ctx.close();
  const D = await newClient('D', { dead: [X] });
  await openRegistered(D);
  await waitLeader(D.page);
  const dRun = await acquire(D.page, P[0], 'PERSIST_REPLICA');
  const dSrc = (await sources(D.page)).find((s) => s.label === 'P0');
  const dState = await hashState(D.page, X);
  const dFromReloaded = !!dSrc && dSrc.src === 'p2p' && dSrc.peer === newGuestPub.slice(0, 8) && dState.cacheShaOk;
  set('G3_GUEST_RELOAD_CACHE_AND_READVERTISE', report.NEW_GUEST_IDENTITY_AFTER_RELOAD && report.GUEST_RELOAD_CACHE_SURVIVES && report.GUEST_RELOAD_READVERTISES && dFromReloaded, {
    newIdentity: report.NEW_GUEST_IDENTITY_AFTER_RELOAD, state: g3State, heartbeatFiles: g3Heartbeat, dRun, dSource: dSrc, dState,
  });

  // ================= G5: fast peer, slow Blossom (fresh guest) =================
  const cSeed1 = await acquire(D.page, P[1]);
  await poll(async () => H.availability(P[1].hash).some((e) => e.pubkey === D.pub), 10000);
  for (const live of [G, D]) await live.page.evaluate(() => window.NostrApp.sendHeartbeat?.());
  await sleep(1200);
  const G5 = await newClient('G5', { slow: [P[0].hash, P[1].hash] });
  await openGuest(G5);
  const g5fp = await poll(async () => {
    const x = await firstPaint(G5.page);
    return x.first ? x : null;
  }, 30000) || (await firstPaint(G5.page));
  const g5P0 = await poll(async () => (await sources(G5.page)).find((s) => s.label === 'P0'), 20000);
  report.GUEST_FIRST_CARD_FAST_PEER_MS = g5fp.first ?? null;
  report.GUEST_FAST_PEER_SOURCE = g5P0 ? g5P0.src : null;
  set('G5_FAST_PEER_SLOW_BLOSSOM_FIRST_CARD_P2P', report.GUEST_FAST_PEER_SOURCE === 'p2p' && fpOk(g5fp), { first: g5fp.first ?? null, p0: g5P0, seedP1: cSeed1 });

  // ================= G6: bad peer bytes to a guest =================
  const EVIL = await newClient('EVIL');
  await openRegistered(EVIL);
  await waitLeader(EVIL.page);
  await EVIL.page.evaluate(async (hash) => {
    const bad = new Blob([new Uint8Array(300 * 1024).fill(7)], { type: 'video/mp4' });
    await window.NostrApp.registerFileAvailability(hash, bad, 'video/mp4');
  }, P[9].hash);
  await poll(async () => H.availability(P[9].hash).some((e) => e.pubkey === EVIL.pub), 10000);
  const evilRun = await acquire(G5.page, P[9]);
  const evilState = await hashState(G5.page, P[9].hash);
  const g5Log = await qaLog(G5.page);
  const mismatch = g5Log.find((l) => l.text.startsWith('[P2P-HASH] MISMATCH') && l.data?.source === 'p2p' && labelOfHash(l.data?.hash) === 'P9');
  report.HASH_MISMATCH_REJECTED = !!mismatch;
  report.BAD_GUEST_PEER_BYTES_CACHED = evilState.cache && !evilState.cacheShaOk;
  report.BAD_GUEST_PEER_BYTES_ADVERTISED = evilState.availableFiles && !evilState.availableShaOk;
  const recovered = evilRun.ok && evilRun.mediaSource === 'blossom-full' && evilState.cacheShaOk;
  set('G6_BAD_PEER_BYTES_REJECTED_AND_RECOVERED', report.HASH_MISMATCH_REJECTED && !report.BAD_GUEST_PEER_BYTES_CACHED && !report.BAD_GUEST_PEER_BYTES_ADVERTISED && recovered, {
    run: evilRun, state: evilState, mismatchLogged: !!mismatch,
  });

  // ================= §14 cache-write false is never reported durable =================
  const cw = await G5.page.evaluate(async ({ url, hash }) => {
    const App = window.NostrApp;
    const orig = App.cacheMedia;
    App.cacheMedia = async () => false; // harness-only: simulate a refused IndexedDB write
    try {
      await App.downloadVideoWithP2P(url, hash, 'video/mp4', { mode: 'PERSIST_REPLICA', allowHttpFallback: true, verifyHash: true, httpCandidates: [url] });
    } catch (_e) {}
    App.cacheMedia = orig;
    const rec = window.__qaLog.filter((l) => l.text.startsWith('[MEDIA_REPLICA_STORED]') && l.data && hash.startsWith(l.data.hash)).pop();
    return { logged: !!rec, indexedDb: rec ? rec.data.indexedDb : null };
  }, { url: P[12].url, hash: P[12].hash });
  report.CACHE_WRITE_FALSE_REPORTED_DURABLE = cw.indexedDb === true;
  set('CACHE_WRITE_FALSE_NOT_REPORTED_DURABLE', cw.logged && cw.indexedDb === false && report.GUEST_RELOAD_CACHE_SURVIVES, cw);

  // ---- privacy: no keys / nsec / SDP in any console
  const all = pages.flatMap((p) => p.buf).join('\n');
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
      const re = /P2P|feed-session|VIDEO_MEDIA|MEDIA_REPLICA|\[videos\]|HASH|SECURITY|signal/;
      pages.forEach((p, i) => fs.writeFileSync(path.join(process.env.Q899T_DUMP_DIR, `q899t-guest-${i}-${p.label}.txt`), p.buf.filter((l) => re.test(l)).map((l) => l.slice(0, 300)).join('\n')));
    }
    console.log('RESULT', report.status, 'passed', report.passed, 'failed', report.failed);
    try {
      await browser?.close();
    } catch (_e) {}
    server.close();
    await H.stop().catch(() => {});
    process.exit(report.status === 'PASS' ? 0 : 1);
  });
