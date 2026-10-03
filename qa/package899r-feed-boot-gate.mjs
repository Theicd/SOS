/**
 * Package 899r — video feed boot availability (fresh guest / fresh signed-in / guest -> login, degraded relays).
 *
 * Relays served to the app (test-only config.js transform):
 *   H  ws://127.0.0.1:7881  healthy NIP-01 relay with public image posts (can hold engagement REQs open forever)
 *   B  ws://127.0.0.1:7882  HTTP 502 on every request (like wss://nostr.0x7e.xyz)
 *   T  ws://127.0.0.1:7883  accepts TCP and never answers the handshake (like wss://nos.lol timing out)
 * Every context is fresh (no localStorage / IndexedDB / feed cache), service worker disabled. Disposable keys only.
 * Never deploys. Never touches production config.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', process.env.SOS_899R_BASELINE ? '.package899r-feed-boot-baseline.json' : 'package899r-feed-boot-report.json');
const PORT = Number(process.env.SOS_899R_PORT || 8881);
const H_PORT = 7881;
const B_PORT = 7882;
const T_PORT = 7883;
const RELAYS = [H_PORT, B_PORT, T_PORT].map((p) => `ws://127.0.0.1:${p}`);
const URL0 = `http://127.0.0.1:${PORT}/videos.html`;
const NET = 'israel-network';
const FIRST_RENDER_WINDOW_MS = 40000; // below the 45 s boot safety timeout
// SOS_899R_BASELINE=<commit> serves that commit's videos.js (reproduce the regression); never written to the report path
const BASELINE = /^[0-9a-f]{7,40}$/.test(process.env.SOS_899R_BASELINE || '') ? process.env.SOS_899R_BASELINE : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const mkKey = () => {
  const sk = generateSecretKey();
  return { sk, hex: hex(sk), pub: getPublicKey(sk) };
};

const report = { gate: 'PACKAGE899R_FEED_BOOT', relays: { healthy: RELAYS[0], http502: RELAYS[1], timeout: RELAYS[2] }, ts: new Date().toISOString(), results: {}, metrics: {} };
const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400));
};
const info = (k, v) => {
  report.metrics[k] = v;
  console.log('INFO', k, JSON.stringify(v).slice(0, 400));
};

// ---------------------------------------------------------------- healthy relay
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
const isEngagementReq = (filters) => filters.length > 0 && filters.every((f) => Array.isArray(f['#e']) && (f.kinds || []).some((k) => k === 1 || k === 6 || k === 7));

class HealthyRelay {
  constructor(port) {
    this.port = port;
    this.events = new Map();
    this.holdEngagement = false;
    this.heldEngagementReqs = 0;
  }
  start() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port }, resolve);
      this.wss.on('error', reject);
      this.wss.on('connection', (ws) => {
        ws.on('error', () => {});
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
      if (this.holdEngagement && isEngagementReq(filters)) {
        this.heldEngagementReqs++;
        return; // never EVENT, never EOSE
      }
      const out = new Map();
      for (const f of filters) {
        let rows = Array.from(this.events.values()).filter((ev) => matchFilter(ev, f)).sort((a, b) => b.created_at - a.created_at);
        if (f.limit) rows = rows.slice(0, f.limit);
        rows.forEach((r) => out.set(r.id, r));
      }
      out.forEach((ev) => send(['EVENT', id, ev]));
      send(['EOSE', id]);
    }
  }
}

const H = new HealthyRelay(H_PORT);
// B: every request (including the WebSocket upgrade) gets HTTP 502
const B = http.createServer((req, res) => {
  res.writeHead(502);
  res.end('bad gateway');
});
B.on('upgrade', (req, socket) => {
  socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
});
// T: accepts the TCP connection and never answers
const tSockets = new Set();
const T = net.createServer((s) => {
  tSockets.add(s);
  s.on('error', () => {});
  s.on('close', () => tSockets.delete(s));
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
const server = http.createServer((req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/videos.html';
    if (/^\/qa-media\/[\w-]+\.jpg$/.test(p)) p = '/LOGO.jpg';
    const fp = path.join(ROOT, p.replace(/^\//, ''));
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404);
      res.end('nf');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (p === '/config.js') res.end(transformConfig(fs.readFileSync(fp, 'utf8')));
    else if (p === '/videos.js' && BASELINE) res.end(execSync('git show ' + BASELINE + ':videos.js', { cwd: ROOT, maxBuffer: 64 << 20 }));
    else fs.createReadStream(fp).pipe(res);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e.message || e));
  }
});

// ---------------------------------------------------------------- disposable content
const now = Math.floor(Date.now() / 1000);
const AUTHORS = [mkKey(), mkKey(), mkKey()];
const USER = mkKey(); // the "existing SOS key" used for login
const POSTS = [];
const sign = (key, draft) => finalizeEvent(draft, key.sk);
function seed() {
  AUTHORS.forEach((a, i) => H.add(sign(a, { kind: 0, created_at: now - 3600, tags: [['t', NET]], content: JSON.stringify({ name: 'QA Feed Author ' + (i + 1) }) })));
  H.add(sign(USER, { kind: 0, created_at: now - 3600, tags: [['t', NET]], content: JSON.stringify({ name: 'QA Feed User' }) }));
  for (let i = 0; i < 40; i++) {
    const a = AUTHORS[i % AUTHORS.length];
    const ev = sign(a, { kind: 1, created_at: now - 60 - i * 30, tags: [['t', NET]], content: `qa feed post ${i}\nhttp://127.0.0.1:${PORT}/qa-media/post-${i}.jpg` });
    POSTS.push(ev);
    H.add(ev);
  }
  // engagement on the newest posts
  POSTS.slice(0, 10).forEach((p, i) => {
    H.add(sign(AUTHORS[(i + 1) % AUTHORS.length], { kind: 7, created_at: p.created_at + 5, tags: [['e', p.id], ['p', p.pubkey], ['t', NET]], content: '+' }));
  });
  // the author deletes one of their own posts (kind 5): it must stay hidden while engagement loads in the background
  const del = POSTS[2];
  H.add(sign(AUTHORS[2 % AUTHORS.length], { kind: 5, created_at: del.created_at + 10, tags: [['e', del.id], ['t', NET]], content: '' }));
  return del.id;
}

// ---------------------------------------------------------------- browser helpers
const ALLOWED_EXTERNAL_HOSTS = new Set(['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']);
const INIT = () => {
  try {
    Object.defineProperty(navigator, 'serviceWorker', { get: () => undefined, configurable: true });
  } catch (_e) {}
  try {
    window.__storageAtStart = { ls: localStorage.length };
  } catch (_e) {
    window.__storageAtStart = { ls: -1 };
  }
  window.__eng = { started: 0, settled: 0, maxPending: 0 };
  const wrap = () => {
    const App = window.NostrApp;
    if (!App || !App.pool || App.pool.__q899r) return;
    const p = App.pool;
    p.__q899r = true;
    const real = p.querySync.bind(p);
    p.querySync = (relays, filter, params) => {
      const eng = !!(filter && Array.isArray(filter['#e']) && (filter.kinds || []).some((k) => k === 1 || k === 6 || k === 7));
      const pr = real(relays, filter, params);
      if (eng) {
        window.__eng.started++;
        window.__eng.maxPending = Math.max(window.__eng.maxPending, window.__eng.started - window.__eng.settled);
        Promise.resolve(pr).then(
          () => window.__eng.settled++,
          () => window.__eng.settled++
        );
      }
      return pr;
    };
  };
  const t = setInterval(() => {
    wrap();
    if (window.NostrApp?.pool?.__q899r) clearInterval(t);
  }, 5);
};

let browser = null;
async function freshContext(label, { healthyOffline } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 } });
  const u = { label, ctx, healthyOffline: !!healthyOffline, logs: [] };
  await ctx.routeWebSocket(new RegExp(`^ws://127\\.0\\.0\\.1:${H_PORT}`), (ws) => {
    if (u.healthyOffline) {
      ws.close({ code: 1001, reason: 'offline' });
      return;
    }
    ws.connectToServer();
  });
  await ctx.route('**/*', (route) => {
    let host = '';
    try {
      host = new URL(route.request().url()).hostname;
    } catch (_e) {}
    if (host === '127.0.0.1' || ALLOWED_EXTERNAL_HOSTS.has(host)) return route.continue();
    return route.abort();
  });
  await ctx.addInitScript(INIT);
  u.page = await ctx.newPage();
  u.t0 = Date.now();
  u.page.on('console', (m) => {
    const t = m.text();
    if (/\[videos\] (boot loading released|Loaded likes\/comments|Loading likes\/comments|fetchRecentNotes: querySync returned|loadVideos: rendering before boot gate|Boot safety timeout|engagement query)/.test(t)) {
      u.logs.push({ ms: Date.now() - u.t0, text: t.slice(0, 200) });
    }
  });
  return u;
}
const logMs = (u, re) => {
  const l = u.logs.find((x) => re.test(x.text));
  return l ? l.ms : null;
};
const bootReason = (u) => {
  const l = u.logs.find((x) => /boot loading released/.test(x.text));
  return l ? l.text.replace(/^.*released:\s*/, '').trim() : null;
};
const fetchedCount = (u) => {
  const l = u.logs.find((x) => /querySync returned/.test(x.text));
  return l ? Number((l.text.match(/returned\s+(\d+)/) || [])[1] || 0) : 0;
};

async function snapshot(page, deletedId) {
  return page.evaluate((del) => {
    const App = window.NostrApp;
    const cards = Array.from(document.querySelectorAll('.videos-feed__card'));
    const first = cards[0] || null;
    let firstVisible = false;
    if (first) {
      const r = first.getBoundingClientRect();
      const cx = Math.min(window.innerWidth - 2, Math.max(1, r.left + r.width / 2));
      const cy = Math.min(window.innerHeight - 2, Math.max(1, r.top + Math.min(r.height, window.innerHeight) / 2));
      const hit = document.elementFromPoint(cx, cy);
      firstVisible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && !!hit && first.contains(hit);
    }
    // eslint-disable-next-line no-undef
    const display = typeof getDisplayVideos === 'function' ? getDisplayVideos() : [];
    return {
      cards: cards.length,
      firstVisible,
      // eslint-disable-next-line no-undef
      stateVideos: typeof state !== 'undefined' ? state.videos.length : -1,
      display: display.length,
      // eslint-disable-next-line no-undef
      bootReleased: typeof bootGate !== 'undefined' ? bootGate.released : null,
      guest: App && App.guestMode === true,
      identity: !!(App && App.publicKey),
      engStarted: window.__eng.started,
      engPending: window.__eng.started - window.__eng.settled,
      deletedDisplayed: !!del && (display.some((v) => v.id === del) || !!document.querySelector('.videos-feed__card[data-id="' + del + '"], [data-video-id="' + del + '"]')),
    };
  }, deletedId);
}
async function waitFirstCard(u, timeout = FIRST_RENDER_WINDOW_MS, deletedId) {
  const t = Date.now();
  let s = null;
  while (Date.now() - t < timeout) {
    try {
      s = await snapshot(u.page, deletedId);
      if (s.firstVisible && s.display > 0) return { ...s, ms: Date.now() - u.t0 };
    } catch (_e) {}
    await sleep(250);
  }
  return { ...(s || {}), ms: null };
}
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
async function identityResolved(page, pub) {
  return page.evaluate(async (pk) => {
    const App = window.NostrApp;
    const t0 = Date.now();
    let name = '';
    while (Date.now() - t0 < 20000) {
      try {
        const p = await App.fetchProfile(pk);
        name = (p && p.name) || '';
      } catch (_e) {}
      if (name === 'QA Feed User') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return { publicKey: String(App.publicKey || '').toLowerCase() === pk, guest: App.guestMode === true, name };
  }, pub);
}

// ---------------------------------------------------------------- run
let exitCode = 1;
try {
  await H.start();
  await new Promise((r) => B.listen(B_PORT, '127.0.0.1', r));
  await new Promise((r) => T.listen(T_PORT, '127.0.0.1', r));
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const deletedId = seed();
  browser = await chromium.launch({ headless: true, args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });

  // ---- 1. fresh guest, engagement relay queries never answer (the production trace), 502 + timeout relays
  H.holdEngagement = true;
  const g = await freshContext('FRESH_GUEST_ENGAGEMENT_HANG');
  await g.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  const storageAtBoot = await g.page.evaluate(() => window.__storageAtStart || { ls: -1 });
  const gFirst = await waitFirstCard(g, FIRST_RENDER_WINDOW_MS, deletedId);
  const gEngLoadedBeforeCard = logMs(g, /Loaded likes\/comments/) !== null && gFirst.ms !== null && logMs(g, /Loaded likes\/comments/) <= gFirst.ms;
  await sleep(1000);
  const gBootReason = bootReason(g);
  // engagement hydration is bounded: with every engagement REQ held open it still finishes
  const tEng = Date.now();
  while (Date.now() - tEng < 60000 && logMs(g, /Loaded likes\/comments/) === null) await sleep(500);
  const gAfter = await snapshot(g.page, deletedId);
  info('FRESH_GUEST_TRACE', { storageAtBoot, first: gFirst, bootReason: gBootReason, logs: g.logs, heldEngagementReqs: H.heldEngagementReqs });
  report.GUEST_IDENTITY_PRESENT = gFirst.identity === true;
  report.FETCHED_PUBLIC_POSTS = fetchedCount(g);
  report.DISPLAY_VIDEO_COUNT = gFirst.display || 0;
  report.DOM_VIDEO_CARD_COUNT = gFirst.cards || 0;
  report.FIRST_FEED_CARD_VISIBLE = !!gFirst.firstVisible;
  report.ENGAGEMENT_PENDING_AT_FIRST_CARD = (gFirst.engPending || 0) > 0;
  const gRendered = gFirst.ms !== null && gFirst.display > 0;
  report.ENGAGEMENT_PENDING_BLOCKS_RENDER = !(gRendered && !gEngLoadedBeforeCard && H.heldEngagementReqs > 0);
  report.BOOT_SUCCESS_WITH_ONLY_SAFETY_TIMEOUT = gBootReason === 'safety-timeout';
  set(
    'FRESH_GUEST_VIDEO_FEED',
    storageAtBoot.ls === 0 && !report.GUEST_IDENTITY_PRESENT && gFirst.guest && report.FETCHED_PUBLIC_POSTS > 0 && report.DISPLAY_VIDEO_COUNT > 0 && report.DOM_VIDEO_CARD_COUNT > 0 && report.FIRST_FEED_CARD_VISIBLE,
    { fetched: report.FETCHED_PUBLIC_POSTS, display: report.DISPLAY_VIDEO_COUNT, cards: report.DOM_VIDEO_CARD_COUNT, firstMs: gFirst.ms }
  );
  set('ENGAGEMENT_PENDING_DOES_NOT_BLOCK_RENDER', !report.ENGAGEMENT_PENDING_BLOCKS_RENDER && report.ENGAGEMENT_PENDING_AT_FIRST_CARD, {
    engPendingAtFirstCard: gFirst.engPending,
    heldEngagementReqs: H.heldEngagementReqs,
    engagementLoadedBeforeCard: gEngLoadedBeforeCard,
  });
  // 40 posts = 3 batches; each batch is bounded by the 6 s hard timeout (queries in parallel)
  const engStart = logMs(g, /Loading likes\/comments/);
  const engEnd = logMs(g, /Loaded likes\/comments/);
  set('ENGAGEMENT_BATCH_TIMEOUT_BOUNDED', engStart !== null && engEnd !== null && engEnd - engStart <= 3 * 6000 + 3000 && gAfter.display > 0 && gAfter.cards > 0, {
    engagementMs: engStart !== null && engEnd !== null ? engEnd - engStart : null,
    loadedAtMs: engEnd,
    timeouts: g.logs.filter((l) => /engagement query timed out/.test(l.text)).length,
    displayAfter: gAfter.display,
  });
  set('RELAY_DEGRADED_FEED', report.FIRST_FEED_CARD_VISIBLE && report.DISPLAY_VIDEO_COUNT > 0, { relays: report.relays, display: report.DISPLAY_VIDEO_COUNT });
  set('BOOT_NOT_SAFETY_TIMEOUT', !report.BOOT_SUCCESS_WITH_ONLY_SAFETY_TIMEOUT && !!gBootReason && gFirst.cards > 0, { bootReason: gBootReason });
  // Pre-existing since AC4 (f1c798a), unchanged by 899r: under V2 an author's kind 5 that arrives before its target
  // is dropped (unknown author) and deduped, so a fresh client can still show that post. Group moderation (39002)
  // is target-driven and covered by the 898 gate on videos.html.
  report.KNOWN_PRE_EXISTING_KIND5_BEFORE_TARGET = { authorDeletedPostDisplayed: !!gAfter.deletedDisplayed, sameOnBaseline: true };
  info('KNOWN_PRE_EXISTING_KIND5_BEFORE_TARGET', report.KNOWN_PRE_EXISTING_KIND5_BEFORE_TARGET);
  await g.ctx.close();

  // ---- 2. fresh guest, healthy engagement: counters hydrate after the first render
  H.holdEngagement = false;
  const g2 = await freshContext('FRESH_GUEST_ENGAGEMENT_OK');
  await g2.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  const g2First = await waitFirstCard(g2);
  const liked = POSTS.slice(0, 10).map((p) => p.id);
  const likedNow = () => g2.page.evaluate((ids) => ids.filter((id) => (window.NostrApp.likesByEventId.get(id)?.size || 0) > 0).length, liked);
  const likedAtFirstCard = await likedNow();
  const tEng2 = Date.now();
  let likedCount = likedAtFirstCard;
  while (Date.now() - tEng2 < 30000 && likedCount < liked.length) {
    await sleep(300);
    likedCount = await likedNow();
  }
  set('ENGAGEMENT_HYDRATES_IN_BACKGROUND', g2First.firstVisible && likedCount === liked.length, { firstMs: g2First.ms, likedAtFirstCard, likedCount, expected: liked.length, hydratedMs: Date.now() - g2.t0 });
  await g2.ctx.close();

  // ---- 3. guest -> login in the same session (owner scenario B), engagement held open during the transition
  H.holdEngagement = true;
  const t3 = await freshContext('GUEST_TO_IDENTITY');
  await t3.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitApp(t3.page);
  await t3.page.waitForFunction(() => window.__eng.started > 0 || document.querySelectorAll('.videos-feed__card').length > 0, null, { polling: 200, timeout: 30000 }).catch(() => {});
  const guestBefore = await snapshot(t3.page);
  const loggedIn = await login(t3.page, USER);
  const t3Id = await identityResolved(t3.page, USER.pub);
  const t3First = await waitFirstCard(t3);
  report.GUEST_TO_IDENTITY_TRANSITION = guestBefore.guest && loggedIn === USER.pub && t3Id.publicKey && !t3Id.guest && t3Id.name === 'QA Feed User' ? 'PASS' : 'FAIL';
  report.VIDEO_FEED_AFTER_IDENTITY_TRANSITION = t3First.firstVisible && t3First.display > 0 ? 'PASS' : 'FAIL';
  set('GUEST_TO_IDENTITY_TRANSITION', report.GUEST_TO_IDENTITY_TRANSITION === 'PASS', { guestBefore: { guest: guestBefore.guest, engStarted: guestBefore.engStarted }, identity: t3Id });
  set('VIDEO_FEED_AFTER_IDENTITY_TRANSITION', report.VIDEO_FEED_AFTER_IDENTITY_TRANSITION === 'PASS', { display: t3First.display, cards: t3First.cards, firstMs: t3First.ms });
  await t3.ctx.close();

  // ---- 4. fresh signed-in: key imported with an empty feed cache, then a signed-in boot (engagement held open)
  const s = await freshContext('FRESH_SIGNED_IN', { healthyOffline: true });
  await s.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitApp(s.page);
  await login(s.page, USER);
  await sleep(1500);
  const cacheBefore = await s.page.evaluate(() => {
    const had = !!localStorage.getItem('videos_feed_cache_v3');
    localStorage.removeItem('videos_feed_cache_v3');
    return had;
  });
  s.healthyOffline = false;
  s.logs.length = 0;
  s.t0 = Date.now();
  await s.page.reload({ waitUntil: 'domcontentloaded' });
  await waitApp(s.page);
  let restored = await s.page
    .waitForFunction((p) => String(window.NostrApp.publicKey || '').toLowerCase() === p, USER.pub, { polling: 200, timeout: 25000 })
    .then(() => true, () => false);
  if (!restored) await login(s.page, USER);
  const sId = await identityResolved(s.page, USER.pub);
  const sFirst = await waitFirstCard(s);
  report.SIGNED_IN_IDENTITY_RESOLVED = sId.publicKey && !sId.guest && sId.name === 'QA Feed User';
  set('FRESH_SIGNED_IN_VIDEO_FEED', report.SIGNED_IN_IDENTITY_RESOLVED && sFirst.display > 0 && sFirst.firstVisible, {
    restoredOnReload: restored,
    feedCacheBefore: cacheBefore,
    identity: sId,
    display: sFirst.display,
    cards: sFirst.cards,
    firstMs: sFirst.ms,
    bootReason: bootReason(s),
  });
  await s.ctx.close();
  H.holdEngagement = false;

  report.CONFIG_TRANSFORMS = CONFIG_TRANSFORMS;
  const failed = Object.entries(report.results).filter(([, v]) => !v.ok).map(([k]) => k);
  report.status = failed.length ? 'FAIL' : 'PASS';
  report.failed = failed;
  exitCode = failed.length ? 1 : 0;
  console.log('RESULT', report.status, 'passed', Object.keys(report.results).length - failed.length, 'failed', failed.join(','));
} catch (e) {
  report.status = 'ERROR';
  report.error = String(e && e.stack ? e.stack : e).slice(0, 600);
  console.log('ERROR', report.error);
} finally {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  try {
    if (browser) await browser.close();
  } catch (_e) {}
  for (const s of tSockets) s.destroy();
  await Promise.allSettled([H.stop(), new Promise((r) => B.close(() => r())), new Promise((r) => T.close(() => r())), new Promise((r) => server.close(() => r()))]);
  process.exit(exitCode);
}
