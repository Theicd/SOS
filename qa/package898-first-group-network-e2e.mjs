/**
 * Package 898 — First group network-backed administration E2E (NETWORK_BACKED_E2E).
 *
 * - Two real local NIP-01 WebSocket relays (ws) with parameterized-replaceable storage semantics.
 *   The browsers talk to them through the app's own nostr-tools pool; no in-page stubs, no state export/import.
 * - USER_A / USER_B / USER_C each run in their own persistent Chromium profile (separate process, separate storage).
 *   D / E / X / observers run in isolated contexts of a second browser.
 * - Test-only transforms of the served config.js: SAFE_DEFAULT_RELAYS -> local relays (ws://127.0.0.1 allowed),
 *   configured first-group root -> USER_A. runtime-feature-flags.json is served ON locally.
 * Never deploys. Never touches production config.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'package898-first-group-network-e2e-report.json');
const PORT = Number(process.env.SOS_898_PORT || 8798);
const RELAY_PORTS = [7791, 7792];
const RELAYS = RELAY_PORTS.map((p) => `ws://127.0.0.1:${p}`);
const URL0 = `http://127.0.0.1:${PORT}/videos.html`;
const ADM_PORT = Number(process.env.SOS_898_ADM_PORT || 8799);
const ADM_URL = `http://127.0.0.1:${ADM_PORT}`;
const ADM_DIR = path.join(ROOT, 'admission-service');
const PROD_ROOT = 'ede1e7fabb758aca75ae548680a206a234c6d6b257834b111d284c3692e67601';
const GROUP = 'israel-network';
const PROFILES = path.join(os.tmpdir(), 'sos898-e2e-' + Date.now());

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkKey = () => {
  const sk = generateSecretKey();
  return { sk, hex: hex(sk), pub: getPublicKey(sk) };
};
// 899f: per-run admin PIN (random, never printed); unlocks the admin UI/session lock only.
const TEST_PIN = (() => {
  for (;;) {
    const p = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const d = p.split('').map(Number);
    const step = d.slice(1).map((x, i) => (x - d[i] + 10) % 10);
    if (new Set(d).size >= 4 && !step.every((s) => s === 1) && !step.every((s) => s === 9)) return p;
  }
})();

const report = {
  gate: 'PACKAGE898_FIRST_GROUP_NETWORK_E2E',
  E2E_SCOPE: 'NETWORK_BACKED_E2E',
  NETWORK_BACKED_E2E: true,
  relays: RELAYS,
  status: 'FAIL',
  ts: new Date().toISOString(),
  results: {},
  metrics: {},
  screenshots: [],
};
const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300));
};
const info = (k, v) => {
  report.metrics[k] = v;
  console.log('INFO', k, JSON.stringify(v).slice(0, 300));
};
const T0 = Date.now();
const trace = (m) => console.log('TRACE +' + (Date.now() - T0) + 'ms ' + m);

// ---------------------------------------------------------------- NIP-01 test relay
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
function safeVerify(ev) {
  try {
    return !!ev && verifyEvent({ ...ev });
  } catch (_e) {
    return false;
  }
}

class TestRelay {
  constructor(port) {
    this.port = port;
    this.events = new Map();
    this.byKey = new Map();
    this.clients = new Set();
    this.mode = 'up'; // up | down | silent
    this.eoseDelayMs = 0;
    this.acceptInvalid = false;
    this.order = 'desc'; // desc | asc | shuffle
    this.stats = { received: 0, rejectedInvalid: 0, replaced: 0, duplicates: 0 };
  }
  start() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port }, resolve);
      this.wss.on('error', reject);
      this.wss.on('connection', (ws) => this.onConn(ws));
    });
  }
  stop() {
    for (const c of this.clients) c.ws.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
  down() {
    this.mode = 'down';
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
  }
  up() {
    this.mode = 'up';
  }
  onConn(ws) {
    if (this.mode === 'down') {
      ws.terminate();
      return;
    }
    const c = { ws, subs: new Map() };
    this.clients.add(c);
    ws.on('message', (d) => this.onMsg(c, d));
    ws.on('close', () => this.clients.delete(c));
    ws.on('error', () => {});
  }
  send(c, arr) {
    try {
      c.ws.send(JSON.stringify(arr));
    } catch (_e) {}
  }
  keyOf(ev) {
    const k = ev.kind;
    if (k === 0 || k === 3 || (k >= 10000 && k < 20000)) return ev.pubkey + ':' + k;
    if (k >= 30000 && k < 40000) {
      const d = ((ev.tags || []).find((t) => t[0] === 'd') || [])[1] || '';
      return ev.pubkey + ':' + k + ':' + d;
    }
    return null;
  }
  /** NIP-01 storage: regular kept; replaceable / parameterized-replaceable keep newest per key. */
  store(ev) {
    if (this.events.has(ev.id)) {
      this.stats.duplicates++;
      return false;
    }
    if (ev.kind >= 20000 && ev.kind < 30000) return true;
    const key = this.keyOf(ev);
    if (key) {
      const prevId = this.byKey.get(key);
      const prev = prevId && this.events.get(prevId);
      if (prev) {
        if (prev.created_at > ev.created_at || (prev.created_at === ev.created_at && prev.id < ev.id)) return false;
        this.events.delete(prevId);
        this.stats.replaced++;
      }
      this.byKey.set(key, ev.id);
    }
    this.events.set(ev.id, ev);
    return true;
  }
  publish(ev) {
    this.stats.received++;
    if (!this.acceptInvalid && !safeVerify(ev)) {
      this.stats.rejectedInvalid++;
      return false;
    }
    const stored = this.store(ev);
    if (stored) this.broadcast(ev);
    return stored;
  }
  onMsg(c, data) {
    let m;
    try {
      m = JSON.parse(String(data));
    } catch (_e) {
      return;
    }
    if (!Array.isArray(m)) return;
    if (m[0] === 'EVENT') {
      const ev = m[1];
      this.stats.received++;
      if (!this.acceptInvalid && !safeVerify(ev)) {
        this.stats.rejectedInvalid++;
        this.send(c, ['OK', ev && ev.id, false, 'invalid: bad signature']);
        return;
      }
      const stored = this.store(ev);
      this.send(c, ['OK', ev.id, true, stored ? '' : 'duplicate:']);
      if (stored) this.broadcast(ev);
    } else if (m[0] === 'REQ') {
      const [, id, ...filters] = m;
      c.subs.set(id, filters);
      if (this.mode === 'silent') return;
      const out = this.query(filters);
      const fire = () => {
        out.forEach((ev) => this.send(c, ['EVENT', id, ev]));
        this.send(c, ['EOSE', id]);
      };
      if (this.eoseDelayMs) setTimeout(fire, this.eoseDelayMs);
      else fire();
    } else if (m[0] === 'CLOSE') {
      c.subs.delete(m[1]);
    }
  }
  query(filters) {
    const out = new Map();
    for (const f of filters) {
      let rows = Array.from(this.events.values())
        .filter((ev) => matchFilter(ev, f))
        .sort((a, b) => b.created_at - a.created_at);
      if (f.limit) rows = rows.slice(0, f.limit);
      rows.forEach((r) => out.set(r.id, r));
    }
    let list = Array.from(out.values());
    if (this.order === 'asc') list.reverse();
    if (this.order === 'shuffle') list = list.map((e) => [Math.random(), e]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    return list;
  }
  broadcast(ev) {
    if (this.mode !== 'up') return;
    for (const c of this.clients) {
      for (const [id, fs2] of c.subs) {
        if (fs2.some((f) => matchFilter(ev, { ...f, limit: undefined }))) this.send(c, ['EVENT', id, ev]);
      }
    }
  }
  all(kinds) {
    return Array.from(this.events.values()).filter((e) => !kinds || kinds.includes(e.kind));
  }
}

const r1 = new TestRelay(RELAY_PORTS[0]);
const r2 = new TestRelay(RELAY_PORTS[1]);
const allRelays = [r1, r2];
const publishAll = (ev) => allRelays.map((r) => r.publish(ev));

// ---------------------------------------------------------------- static server
let ROOT_PUB = '';
const CONFIG_TRANSFORMS = { root: false, relays: false, p2p: false, sanitizer: false, admission: false };
function transformConfig(src) {
  let out = src;
  out = out.replace(/App\.FIRST_GROUP_ADMISSION_URL = '[^']*';/, () => {
    CONFIG_TRANSFORMS.admission = true;
    return `App.FIRST_GROUP_ADMISSION_URL = '${ADM_URL}';`;
  });
  if (out.includes(PROD_ROOT)) {
    out = out.replace(PROD_ROOT, ROOT_PUB);
    CONFIG_TRANSFORMS.root = true;
  }
  out = out.replace(/const SAFE_DEFAULT_RELAYS = \[[^\]]*\];/, () => {
    CONFIG_TRANSFORMS.relays = true;
    return `const SAFE_DEFAULT_RELAYS = ${JSON.stringify(RELAYS)};`;
  });
  out = out.replace(/const SAFE_DEFAULT_P2P_RELAYS = \[[^\]]*\];/, () => {
    CONFIG_TRANSFORMS.p2p = true;
    return `const SAFE_DEFAULT_P2P_RELAYS = ${JSON.stringify(RELAYS)};`;
  });
  out = out.replace("!trimmed.startsWith('wss://')", () => {
    CONFIG_TRANSFORMS.sanitizer = true;
    return "!(trimmed.startsWith('wss://') || trimmed.startsWith('ws://127.0.0.1:'))";
  });
  return out;
}
function startServer() {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.webp': 'image/webp',
  };
  const server = http.createServer((req, res) => {
    try {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/') p = '/videos.html';
      if (p === '/runtime-feature-flags.json') {
        res.writeHead(200, { 'Content-Type': types['.json'], 'Cache-Control': 'no-store' });
        const flags = { schema: 'sos-feature-flags-v1', accessControlV2: true, admin2faEnforcement: true, admin2faSignerPubkey: COSIGN.pub };
        if (process.env.SOS_GATE_V2_SCOPE) flags.accessControlV2Scope = process.env.SOS_GATE_V2_SCOPE;
        res.end(JSON.stringify(flags));
        return;
      }
      const fp = path.join(ROOT, p.replace(/^\//, ''));
      if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404);
        res.end('nf');
        return;
      }
      if (p === '/config.js') {
        res.writeHead(200, { 'Content-Type': types['.js'], 'Cache-Control': 'no-store' });
        res.end(transformConfig(fs.readFileSync(fp, 'utf8')));
        return;
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(fp).pipe(res);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e.message || e));
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(PORT, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------- admission service (local workerd, disposable keys)
let admProc = null;
let admLog = '';
const admPersist = path.join(os.tmpdir(), 'sos898-adm-' + Date.now());
// Admin 2FA Phase 3: disposable co-sign key + pepper; served flags enforce attestations with this signer (local only).
const COSIGN = mkKey();
const PIN_PEPPER = crypto.randomBytes(32).toString('hex');
async function startAdmission(rootPub, svcHex) {
  fs.writeFileSync(
    path.join(ADM_DIR, '.dev.vars'),
    `ROOT_PUBKEY=${rootPub}\nADMISSION_SK=${svcHex}\nADMIN_COSIGN_SK=${COSIGN.hex}\nADMIN_PIN_PEPPER=${PIN_PEPPER}\nTEST_FAULTS=1\nALLOWED_ORIGINS=http://127.0.0.1:${PORT}\n`
  );
  admProc = spawn('npx', ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(ADM_PORT), '--persist-to', admPersist, '--show-interactive-dev-session=false'], {
    cwd: ADM_DIR,
    shell: true,
    env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }),
  });
  admProc.stdout.on('data', (d) => (admLog += d.toString()));
  admProc.stderr.on('data', (d) => (admLog += d.toString()));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(ADM_URL + '/v1/health');
      if (r.ok) return true;
    } catch (_e) {}
    await sleep(500);
  }
  throw new Error('admission service did not start');
}
function stopAdmission() {
  if (admProc) {
    try {
      execSync(`taskkill /pid ${admProc.pid} /T /F`, { stdio: 'ignore' });
    } catch (_e) {
      try {
        admProc.kill('SIGKILL');
      } catch (_e2) {}
    }
    admProc = null;
  }
  try {
    fs.rmSync(path.join(ADM_DIR, '.dev.vars'), { force: true });
  } catch (_e) {}
  try {
    fs.rmSync(admPersist, { recursive: true, force: true });
  } catch (_e) {}
}

// ---------------------------------------------------------------- browsers / profiles
const CHROME_ARGS = [
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion',
];
const ALLOWED_EXTERNAL_HOSTS = new Set(['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']);
const NO_SW_INIT = () => {
  try {
    Object.defineProperty(navigator, 'serviceWorker', { get: () => undefined, configurable: true });
  } catch (_e) {}
};
let sharedBrowser = null;
const USERS = [];

async function prepareContext(u) {
  // Per-user network cut: relay sockets are proxied so one user can go offline while others stay online.
  await u.ctx.routeWebSocket(/^ws:\/\/127\.0\.0\.1:779\d/, (ws) => {
    if (u.offline) {
      ws.close({ code: 1001, reason: 'offline' });
      return;
    }
    ws.connectToServer();
    u.sockets.add(ws);
  });
  await u.ctx.route('**/*', (route) => {
    let host = '';
    try {
      host = new URL(route.request().url()).hostname;
    } catch (_e) {}
    if (host === '127.0.0.1' || ALLOWED_EXTERNAL_HOSTS.has(host)) return route.continue();
    return route.abort();
  });
  await u.ctx.addInitScript(NO_SW_INIT);
}

function watchPage(u, page) {
  page.on('crash', () => (report.pageCrashes = report.pageCrashes || []).push(u.label));
  page.on('pageerror', (e) => {
    if (/first-group|group-admin-product-ui|invite-service/.test(String(e.stack || ''))) {
      (report.pageErrors = report.pageErrors || []).push(u.label + ': ' + String(e.message).slice(0, 200));
    }
  });
}

async function newProfile(label, { persistent = true, viewport } = {}) {
  const opts = { viewport: viewport || { width: 1280, height: 860 }, permissions: ['clipboard-read', 'clipboard-write'] };
  const u = { label, offline: false, sockets: new Set(), persistent };
  if (persistent) {
    u.dir = path.join(PROFILES, label);
    u.ctx = await chromium.launchPersistentContext(u.dir, { ...opts, headless: true, args: CHROME_ARGS });
  } else {
    u.ctx = await sharedBrowser.newContext(opts);
  }
  await prepareContext(u);
  u.page = u.ctx.pages()[0] || (await u.ctx.newPage());
  watchPage(u, u.page);
  USERS.push(u);
  return u;
}

async function closeProfile(u) {
  try {
    await u.ctx.close();
  } catch (_e) {}
  const i = USERS.indexOf(u);
  if (i !== -1) USERS.splice(i, 1);
}

async function goOffline(u) {
  u.offline = true;
  for (const ws of u.sockets) {
    try {
      await ws.close({ code: 1001, reason: 'offline' });
    } catch (_e) {}
  }
  u.sockets.clear();
  for (const p of u.ctx.pages()) await p.evaluate(() => window.dispatchEvent(new Event('offline'))).catch(() => {});
}

async function goOnline(u) {
  u.offline = false;
  for (const p of u.ctx.pages()) await p.evaluate(() => window.dispatchEvent(new Event('online'))).catch(() => {});
}

async function waitApp(page) {
  await page.waitForFunction(
    () =>
      !!window.NostrApp?.createNewIdentityExplicit &&
      !!window.NostrApp?.FirstGroupAdmin &&
      !!window.NostrApp?.FirstGroupNetworkAuthority &&
      !!window.NostrApp?.GroupAdminProductUi &&
      window.SosFeatureFlags?.isResolved?.() === true &&
      !!window.NostrApp?.pool,
    null,
    { polling: 200, timeout: 120000 }
  );
}

async function boot(page, key) {
  await waitApp(page);
  const pub = await page.evaluate(async (k) => {
    const App = window.NostrApp;
    const c = App.createNewIdentityExplicit({ privateKeyHex: k });
    App.guestMode = false;
    App.SessionAuthority?.bindCurrentSession?.({ accountPubkey: c.publicKey, bump: true });
    try {
      window.dispatchEvent(new CustomEvent('sos-identity-ready'));
    } catch (_e) {}
    await new Promise((r) => setTimeout(r, 500));
    App.FirstGroupAdmin.boot();
    await App.FirstGroupNetworkAuthority.reconcile('test-boot');
    return String(c.publicKey || '').toLowerCase();
  }, key.hex);
  await pinReady(page);
  return pub;
}

/** Sets up (first time for this identity/profile) or enters the admin PIN. */
async function pinReady(page) {
  return page.evaluate(async (pin) => {
    const P = window.NostrApp.AdminPinLock;
    if (P.isUnlocked()) return 'ALREADY_UNLOCKED';
    const r = (await P.hasPin()) ? await P.verifyPin(pin) : await P.setupPin(pin, pin);
    return r.code;
  }, TEST_PIN);
}

// Sensitive admin operations (demote, remove admin, policy, delegation) open the step-up dialog; answer it like a user.
let stepUpTimer = null;
const stepUpStats = { filled: 0 };
function startStepUpResponder() {
  let busy = false;
  stepUpTimer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (const u of USERS.slice()) {
        for (const page of u.ctx ? u.ctx.pages() : []) {
          const isStepUp = await page
            .evaluate(() => {
              const d = document.getElementById('sosAdminPinDialog');
              const ok = document.getElementById('sosAdminPinOk');
              return !!d && /פעולה רגישה/.test(d.textContent || '') && !!ok && !ok.disabled;
            })
            .catch(() => false);
          if (!isStepUp) continue;
          await page.fill('#sosAdminPinInput', TEST_PIN, { timeout: 2000 }).catch(() => {});
          await page.click('#sosAdminPinOk', { timeout: 2000 }).catch(() => {});
          stepUpStats.filled++;
        }
      }
    } finally {
      busy = false;
    }
  }, 250);
}
function stopStepUpResponder() {
  if (stepUpTimer) clearInterval(stepUpTimer);
  stepUpTimer = null;
}

async function openPage(u, key) {
  await u.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  return boot(u.page, key);
}

async function hardReload(page, key) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitApp(page);
  let restored = false;
  try {
    await page.waitForFunction((p) => String(window.NostrApp.publicKey || '').toLowerCase() === p, key.pub, { polling: 200, timeout: 25000 });
    restored = true;
  } catch (_e) {}
  if (!restored) await boot(page, key);
  await page.evaluate(async () => {
    window.NostrApp.guestMode = false;
    window.NostrApp.FirstGroupAdmin.boot();
    await window.NostrApp.FirstGroupNetworkAuthority.reconcile('test-reload');
  });
  await pinReady(page);
  return restored;
}

const ev = (page, fn, arg) => page.evaluate(fn, arg);

/** Authority / membership of `pk` as this page currently resolves it (no reconcile). */
async function view(page, pk) {
  return page.evaluate(
    ({ pk, g }) => {
      const App = window.NostrApp;
      const F = App.FirstGroupAdmin;
      const a = F.authorityFor(pk);
      return {
        role: a.role,
        caps: a.caps.slice().sort(),
        assigned: a.assigned.slice().sort(),
        verified: a.verified,
        isRoot: a.isRoot,
        member: App.MembershipState.getMemberState(pk, g),
        control: App.GroupControlState.getStatus(g),
        epoch: (App.GroupControlState.getVerifiedControlState(g) || {}).controlEpoch || null,
        net: App.FirstGroupNetworkAuthority.status().status,
      };
    },
    { pk, g: GROUP }
  );
}

/** Polls a predicate over view(page, pk) without triggering reconcile: only live/poll network delivery can satisfy it. */
async function waitView(page, pk, predSrc, timeout = 30000) {
  const t0 = Date.now();
  try {
    await page.waitForFunction(
      ({ pk, g, src }) => {
        const App = window.NostrApp;
        const a = App.FirstGroupAdmin.authorityFor(pk);
        const v = { role: a.role, caps: a.caps, assigned: a.assigned, member: App.MembershipState.getMemberState(pk, g), control: App.GroupControlState.getStatus(g) };
        // eslint-disable-next-line no-new-func
        return new Function('v', 'return (' + src + ');')(v);
      },
      { pk, g: GROUP, src: predSrc },
      { polling: 100, timeout }
    );
    return { ok: true, ms: Date.now() - t0 };
  } catch (_e) {
    return { ok: false, ms: Date.now() - t0, last: await view(page, pk).catch(() => null) };
  }
}

async function snapshot(page, pubs) {
  return page.evaluate(
    ({ pubs, g }) => {
      const App = window.NostrApp;
      const F = App.FirstGroupAdmin;
      const st = App.GroupControlState.getVerifiedControlState(g);
      return JSON.stringify({
        epoch: st ? st.controlEpoch : null,
        tip: st ? st.eventId : null,
        rows: pubs.map((pk) => [pk.slice(0, 8), App.MembershipState.getMemberState(pk, g), F.authorityFor(pk).caps.slice().sort().join('+')]),
      });
    },
    { pubs, g: GROUP }
  );
}

// ---------------------------------------------------------------- UI helpers (DOM-driven)
async function openUi(page, tab) {
  const render = () =>
    page.evaluate((t) => {
      const ui = window.NostrApp.GroupAdminProductUi;
      ui.ensureMenuEntry();
      ui.open(t);
      ui.renderTab(t);
      return document.querySelector('#sosGapTabs button.active')?.dataset.tab || null;
    }, tab);
  let active = await render();
  for (let i = 0; active !== tab && i < 10; i++) {
    await sleep(400);
    active = await render();
  }
  await sleep(200);
  return active === tab;
}
async function waitSel(page, selector, timeout = 20000) {
  await page.waitForFunction((sel) => !!document.querySelector(sel), selector, { polling: 200, timeout });
}
async function domClick(page, selector) {
  await waitSel(page, selector, 15000);
  await page.$eval(selector, (el) => el.click());
}
async function waitMsg(page) {
  await page.waitForFunction(
    () => {
      const m = document.getElementById('sosGapMsg');
      return !!m && /\b(ok|err)\b/.test(m.className);
    },
    null,
    { polling: 200, timeout: 60000 }
  );
  return page.evaluate(() => {
    const m = document.getElementById('sosGapMsg');
    return { ok: /\bok\b/.test(m.className), text: m.textContent };
  });
}
async function act(page, selector) {
  await page.evaluate(() => {
    const m = document.getElementById('sosGapMsg');
    if (m) {
      m.textContent = '';
      m.className = 'gap-msg';
    }
  });
  await domClick(page, selector);
  return waitMsg(page);
}
async function visibleTabs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#sosGapTabs button'))
      .filter((b) => !b.hidden && getComputedStyle(b).display !== 'none')
      .map((b) => b.dataset.tab)
  );
}
async function menuVisible(page) {
  return page.evaluate(() => {
    window.NostrApp.GroupAdminProductUi.ensureMenuEntry();
    const el = document.getElementById('sosGroupControlMenuItem');
    return !!el && !el.hidden && el.style.display !== 'none';
  });
}
function decodeQrDataUrl(dataUrl) {
  const png = PNG.sync.read(Buffer.from(String(dataUrl).split(',')[1] || '', 'base64'));
  const res = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return res ? res.data : '';
}

async function redeem(page, code) {
  return page.evaluate(async (code) => {
    const App = window.NostrApp;
    await App.FirstGroupNetworkAuthority.reconcile('redeem');
    const v = await App.validateInvite({ code });
    if (!v.ok) return { ok: false, stage: 'validate', error: v.error, code: v.code };
    const m = await App.markInviteUsed({ code, inviterPubkey: v.inviterPubkey, inviteEventId: v.inviteEvent.id });
    return { ok: !!m.ok, stage: 'mark', inviteEventId: v.inviteEvent.id, inviter: v.inviterPubkey, usedId: m.event && m.event.id, markError: m.error };
  }, code);
}

async function createInviteApi(page) {
  return page.evaluate(async () => {
    const r = await window.NostrApp.FirstGroupAdmin.createInvite();
    return { ok: r.ok, code: r.code, invite: r.invite ? { code: r.invite.code, eventId: r.invite.eventId, url: r.invite.inviteUrl } : null, error: r.error };
  });
}

/** Unsigned control draft from the verified tip with a patch; signed in Node by `signer`. */
async function forgeControl(page, signer, patchSrc) {
  const draft = await page.evaluate(
    ({ patchSrc, pub }) => {
      const G = window.NostrApp.GroupControlState;
      const st = G.getVerifiedControlState('israel-network');
      const rec = JSON.parse(G.serializeRecord(st));
      // eslint-disable-next-line no-new-func
      const patched = new Function('r', patchSrc)(rec) || rec;
      patched.createdAt = Math.floor(Date.now() / 1000);
      const record = G.parseAndValidateRecord(G.serializeRecord(patched));
      return G.buildSignDraft(record, pub);
    },
    { patchSrc, pub: signer.pub }
  );
  return finalizeEvent({ kind: draft.kind, created_at: draft.created_at, tags: draft.tags, content: draft.content }, signer.sk);
}

async function forgeMembership(page, signer, memberPub, transition, extra) {
  const draft = await page.evaluate(
    ({ memberPub, transition, issuer, extra }) =>
      window.NostrApp.MembershipState.buildMembershipDraft(Object.assign({ memberPubkey: memberPub, transition, issuerPubkey: issuer }, extra || {})),
    { memberPub, transition, issuer: signer.pub, extra }
  );
  return finalizeEvent({ kind: draft.kind, created_at: draft.created_at, tags: draft.tags, content: draft.content }, signer.sk);
}

// ---------------------------------------------------------------- main
async function main() {
  const A = mkKey();
  const B = mkKey();
  const C = mkKey();
  const D = mkKey();
  const E = mkKey();
  const X = mkKey();
  const Y = mkKey();
  const Z = mkKey();
  const W = mkKey();
  const S = mkKey(); // disposable admission service key (QA only)
  const SECRET_HEXES = [A, B, C, D, E, X, Y, Z, W, S, COSIGN].map((k) => k.hex).concat([PIN_PEPPER]);
  globalThis.__SOS_SECRET_HEXES = SECRET_HEXES;
  ROOT_PUB = A.pub;
  fs.mkdirSync(PROFILES, { recursive: true });
  await r1.start();
  await r2.start();
  await startAdmission(A.pub, S.hex);
  report.ADMISSION_SERVICE = { mode: 'local-workerd', url: ADM_URL, servicePubkey: S.pub };
  const server = await startServer();
  sharedBrowser = await chromium.launch({ headless: true, args: CHROME_ARGS });
  startStepUpResponder();
  const shot = async (page, name) => {
    const file = path.join(ROOT, 'qa', `package898-${name}.png`);
    try {
      await page.screenshot({ path: file, fullPage: false, timeout: 20000 });
      report.screenshots.push(path.relative(ROOT, file).replace(/\\/g, '/'));
    } catch (e) {
      (report.screenshotErrors = report.screenshotErrors || []).push({ name, error: String(e.message || e).slice(0, 120) });
    }
  };
  const createdCodes = [];

  try {
    // ================================================================ setup: three independent profiles
    trace('profiles');
    const ua = await newProfile('USER_A');
    const ub = await newProfile('USER_B');
    const uc = await newProfile('USER_C');
    const pa = await openPage(ua, A);
    const pb = await openPage(ub, B);
    const pc = await openPage(uc, C);
    set('CONFIG_TEST_TRANSFORMS_APPLIED', Object.values(CONFIG_TRANSFORMS).every(Boolean), CONFIG_TRANSFORMS);
    set('THREE_INDEPENDENT_PROFILES', pa === A.pub && pb === B.pub && pc === C.pub && new Set([ua.dir, ub.dir, uc.dir]).size === 3, {
      separateProcesses: true,
      sharedStorage: false,
    });
    const relayCfg = await ev(ua.page, () => ({ relays: window.NostrApp.relayUrls, writable: window.NostrApp.getWritableRelays() }));
    set('APP_USES_LOCAL_TEST_RELAYS', JSON.stringify(relayCfg.writable) === JSON.stringify(RELAYS), relayCfg);

    // ================================================================ canonical first-group id
    const ids = [];
    for (const u of [ua, ub, uc]) {
      ids.push(
        await ev(u.page, () => ({
          fga: window.NostrApp.FirstGroupAdmin.FIRST_GROUP_ID,
          na: window.NostrApp.FirstGroupNetworkAuthority.GROUP_ID,
          tag: window.NostrApp.NETWORK_TAG,
          ctx: window.NostrApp.FirstGroupAdmin.contextCheck().ok,
          mismatch: window.NostrApp.FirstGroupAdmin.contextCheck('community-other').code,
        }))
      );
    }
    report.FIRST_GROUP_ID = GROUP;
    set('FIRST_GROUP_CANONICAL_ID', ids.every((r) => r.fga === GROUP && r.na === GROUP && r.tag === GROUP && r.ctx && r.mismatch === 'FIRST_GROUP_CONTEXT_MISMATCH'), ids);

    // ================================================================ bootstrap published to relays
    const preBoot = await ev(ua.page, () => window.NostrApp.FirstGroupNetworkAuthority.status());
    const menuBeforeControl = await ev(ub.page, () => window.NostrApp.FirstGroupAdmin.canSeeAdminMenu());
    const bootRes = await ev(ua.page, async () => {
      const r = await window.NostrApp.FirstGroupAdmin.bootstrapFirstGroup({ displayName: 'SOS' });
      return { ok: r.ok, code: r.code, member: r.rootMembership && r.rootMembership.code, memberDetail: r.rootMembership && r.rootMembership.detail };
    });
    await sleep(600);
    const relayControl = allRelays.map((r) => r.all([39001]).length);
    const relayAttest = allRelays.map((r) => r.all([39004]).length);
    const relayMember = allRelays.map((r) => r.all([39003]).length);
    // Admin 2FA: the BOOTSTRAP goes out with its server attestation. The ROOT self-membership record is rejected by
    // membership rules (SELF_GRANT), so the server refuses to co-sign it and it is never published.
    set(
      'ROOT_BOOTSTRAP_PUBLISHED_TO_RELAYS',
      bootRes.ok && relayControl.every((n) => n >= 1) && relayAttest.every((n) => n >= 1) && relayMember.every((n) => n === 0) && bootRes.memberDetail === 'SELF_GRANT',
      {
        bootRes,
        preBoot: { relaysOk: preBoot.relaysOk, lastError: preBoot.lastError },
        relayControl,
        relayAttest,
        relayMember,
      }
    );
    set('NO_ADMIN_UI_WITHOUT_NETWORK_CONTROL', menuBeforeControl === false);

    // ROOT delegates only FINALIZE_MEMBERSHIP_ADMISSION to the service key (root key never leaves the browser).
    const delegation = await ev(
      ua.page,
      async (svc) => {
        const F = window.NostrApp.FirstGroupAdmin;
        const r = await F.setAdmissionDelegate(svc);
        const push = await window.NostrApp.FirstGroupNetworkAuthority.pushControlToAdmission();
        const st = window.NostrApp.GroupControlState.getVerifiedControlState('israel-network');
        return { code: r.code, push: push && push.result, caps: (st.capabilities[svc] || []).slice(), delegates: F.admissionDelegates() };
      },
      S.pub
    );
    const delegateByNonRoot = await ev(ub.page, async (svc) => (await window.NostrApp.FirstGroupAdmin.setAdmissionDelegate(svc)).code, B.pub);
    info('ADMISSION_DELEGATION', { delegation, delegateByNonRoot });
    report.ADMISSION_DELEGATION_OK =
      delegation.code === 'APPLIED' && JSON.stringify(delegation.caps) === JSON.stringify(['FINALIZE_MEMBERSHIP_ADMISSION']) && delegateByNonRoot !== 'APPLIED';

    const bCtl = await waitView(ub.page, A.pub, "v.control === 'VERIFIED'", 30000);
    const cCtl = await waitView(uc.page, A.pub, "v.control === 'VERIFIED'", 30000);
    set('CONTROL_RECEIVED_FROM_NETWORK', bCtl.ok && cCtl.ok, { bMs: bCtl.ms, cMs: cCtl.ms });

    // ================================================================ B joins through a network invite (auto-approved by A)
    const invA = await createInviteApi(ua.page);
    createdCodes.push(invA.invite && invA.invite.code);
    const redB = await redeem(ub.page, invA.invite.code);
    const tJoinB = Date.now();
    const bMemberOnB = await waitView(ub.page, B.pub, "v.member === 'ACTIVE'", 45000);
    const bMemberOnA = await waitView(ua.page, B.pub, "v.member === 'ACTIVE'", 5000);
    info('JOIN_APPROVAL_LATENCY_MS_B', Date.now() - tJoinB);
    set('REMOTE_MEMBERSHIP_GRANT', invA.ok && redB.ok && bMemberOnB.ok && bMemberOnA.ok, { invA: invA.code, redB, bOnB: bMemberOnB, bOnA: bMemberOnA.ok });

    // ================================================================ A opens the admin UI and sees members from network state
    const aMenu = await menuVisible(ua.page);
    await openUi(ua.page, 'members');
    await sleep(500);
    const aSeesB = await ev(ua.page, (pk) => !!document.querySelector(`#sosGapBody [data-act="select-member"][data-pk="${pk}"]`) || (document.getElementById('sosGapBody')?.innerText || '').includes(pk.slice(0, 8)), B.pub);
    await shot(ua.page, 'a-members-network');
    set('A_ADMIN_UI_MEMBERS_FROM_NETWORK', aMenu && aSeesB, { aMenu, aSeesB });

    // ================================================================ 899f: admin PIN lock in active control mode
    const controlMenu = await ev(ua.page, () => {
      const el = document.getElementById('sosGroupControlMenuItem');
      return !!el && el.style.display !== 'none' && el.textContent.trim() === 'שליטה על הקבוצה';
    });
    const bControlMenu = await ev(ub.page, () => {
      window.NostrApp.GroupAdminProductUi.ensureMenuEntry();
      const el = document.getElementById('sosGroupControlMenuItem');
      return !!el && el.style.display !== 'none';
    });
    set('GROUP_CONTROL_MENU_ADMIN_ONLY', controlMenu && !bControlMenu, { controlMenu, bControlMenu });
    const noPin = await ev(ua.page, async (pk) => {
      const App = window.NostrApp;
      App.AdminPinLock.lock('test');
      const F = App.FirstGroupAdmin;
      const before = F.authorityFor(pk).assigned.join(',');
      const r = {
        open: App.GroupAdminProductUi.isOpen(),
        grant: (await F.grantCapability(pk, 'MODERATE_CONTENT')).code,
        remove: (await F.removeMember(pk)).code,
        meta: (await F.updateMetadata({ description: 'no-pin' })).code,
        invite: (await F.createInvite()).code,
      };
      await App.FirstGroupNetworkAuthority.reconcile('no-pin-check');
      r.unchanged = F.authorityFor(pk).assigned.join(',') === before && App.MembershipState.getMemberState(pk, 'israel-network') === 'ACTIVE';
      return r;
    }, B.pub);
    set('DIRECT_MUTATION_WITHOUT_PIN_REJECTED', !noPin.open && ['grant', 'remove', 'meta', 'invite'].every((x) => noPin[x] === 'ADMIN_PIN_REQUIRED') && noPin.unchanged, noPin);
    await ev(ua.page, () => {
      window.__pinOpen = window.NostrApp.GroupAdminProductUi.open('members');
    });
    await waitSel(ua.page, '#sosAdminPinDialog');
    const uiPrompt = await ev(ua.page, () => document.getElementById('sosAdminPinTitle')?.textContent || '');
    await ua.page.fill('#sosAdminPinInput', TEST_PIN);
    await ua.page.click('#sosAdminPinOk');
    await ua.page.waitForFunction(() => window.NostrApp.GroupAdminProductUi.isOpen(), null, { polling: 100, timeout: 20000 });
    set('PIN_PROMPT_THEN_PANEL', uiPrompt === 'קוד מנהל', { uiPrompt });
    await openUi(ua.page, 'admins');
    const rootCard = await ev(ua.page, (a) => {
      const row = document.querySelector(`#sosGapAdminList [data-admin="${a}"]`);
      return { found: !!row, protectedLabel: !!row && /מוגן/.test(row.textContent), demoteBtn: !!(row && row.querySelector('[data-act="demote"]')) };
    }, A.pub);
    const rootOps = await ev(ua.page, async (a) => {
      const F = window.NostrApp.FirstGroupAdmin;
      return { remove: (await F.removeMember(a)).code, demote: (await F.demoteAdmin(a)).code, revoke: (await F.revokeCapability(a, 'MANAGE_MEMBERS')).code };
    }, A.pub);
    await openUi(ua.page, 'members');
    await domClick(ua.page, `#sosGapBody [data-act="select-member"][data-pk="${A.pub}"]`).catch(() => {});
    await sleep(200);
    const rootDetail = await ev(ua.page, () => {
      const d = document.getElementById('sosGapMemberDetail');
      return {
        shown: !!d,
        locked: !!(d && d.querySelector('#sosGapRootLocked')),
        remove: !!(d && d.querySelector('[data-act="remove-member"]')),
        edit: !!(d && (d.querySelector('[data-act="save-user"]') || d.querySelector('#sosGapCaps'))),
      };
    });
    await ev(ua.page, () => document.querySelector('#sosGapMemberDetail [data-act="close-user"]')?.click());
    set(
      'ROOT_CARD_PROTECTED',
      rootCard.found && rootCard.protectedLabel && !rootCard.demoteBtn && rootDetail.shown && rootDetail.locked && !rootDetail.remove && !rootDetail.edit && Object.values(rootOps).every((c) => /ROOT_/.test(String(c))),
      { rootCard, rootDetail, rootOps }
    );
    await openUi(ua.page, 'members');
    await domClick(ua.page, `#sosGapBody [data-act="select-member"][data-pk="${B.pub}"]`);
    await sleep(200);
    const bCard = await ev(ua.page, () => {
      const d = document.getElementById('sosGapMemberDetail');
      const save = d && d.querySelector('[data-act="save-user"]');
      return { remove: !!(d && d.querySelector('[data-act="remove-member"]')), edit: !!save && !save.disabled };
    });
    const editor = await ev(ua.page, (b) => ({
      target: document.getElementById('sosGapMemberDetail')?.getAttribute('data-pk') || '',
      caps: Array.from(document.querySelectorAll('#sosGapCaps input[data-cap]')).map((c) => c.getAttribute('data-cap')),
      canonical: Object.keys(window.NostrApp.FirstGroupAdmin.CAP_LABELS),
      enabled: Array.from(document.querySelectorAll('#sosGapCaps input[data-cap]')).filter((c) => !c.disabled).length,
      roleButtons: document.querySelectorAll('#sosGapRoleOptions [data-role]:not([disabled])').length,
      b,
    }), B.pub);
    // Per-user panel save (V2 on, enforcement on): signed control change + Admin 2FA attestation, then revert.
    await ev(ua.page, () => document.querySelector('#sosGapCaps input[data-cap="MODERATE_CONTENT"]').click());
    const uiSave = await act(ua.page, '#sosGapMemberDetail [data-act="save-user"]');
    const bMod = await waitView(ub.page, B.pub, "v.caps.indexOf('MODERATE_CONTENT') !== -1", 30000);
    await domClick(ua.page, `#sosGapBody [data-act="select-member"][data-pk="${B.pub}"]`);
    await ev(ua.page, () => {
      document.querySelector('#sosGapCaps input[data-cap="MODERATE_CONTENT"]').click();
      const m = document.getElementById('sosGapMsg');
      m.textContent = '';
      m.className = 'gap-msg';
      document.querySelector('#sosGapMemberDetail [data-act="save-user"]').click();
    });
    await waitSel(ua.page, '#sosGapConfirm.is-open');
    await ev(ua.page, () => document.getElementById('sosGapConfirmOk').click());
    const uiRevert = await waitMsg(ua.page);
    const bUnmod = await waitView(ub.page, B.pub, "v.caps.indexOf('MODERATE_CONTENT') === -1", 30000);
    set('PER_USER_PANEL_SAVE_ATTESTED', uiSave.ok && bMod.ok && uiRevert.ok && bUnmod.ok, { uiSave, bMod: bMod.ok, uiRevert, bUnmod: bUnmod.ok });
    await ev(ua.page, () => document.querySelector('#sosGapMemberDetail [data-act="close-user"]')?.click());
    set(
      'MEMBER_CARD_CONTROLS_FOLLOW_POLICY',
      bCard.remove && bCard.edit && editor.target === B.pub && JSON.stringify(editor.caps) === JSON.stringify(editor.canonical) && editor.enabled > 0 && editor.roleButtons > 0,
      { bCard, target: editor.target === B.pub, caps: editor.caps.length, enabled: editor.enabled, roleButtons: editor.roleButtons }
    );
    const bNoPanel = await ev(ub.page, async () => {
      const r = await window.NostrApp.GroupAdminProductUi.open('members');
      return { code: r.code, dialog: !!document.getElementById('sosAdminPinDialog') };
    });
    set('MEMBER_CANNOT_OPEN_CONTROL', bNoPanel.code === 'UNAUTHORIZED' && !bNoPanel.dialog, bNoPanel);

    // ================================================================ A grants B INVITE_USERS only; B receives it from the network
    const tGrant = Date.now();
    const grant = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.grantCapability(pk, 'INVITE_USERS')).code, B.pub);
    const bGot = await waitView(ub.page, B.pub, "v.caps.indexOf('INVITE_USERS') !== -1", 30000);
    const grantLatency = Date.now() - tGrant;
    info('REALTIME_GRANT_LATENCY_MS', grantLatency);
    const bView1 = await view(ub.page, B.pub);
    const bSections = await ev(ub.page, () => window.NostrApp.FirstGroupAdmin.visibleSections());
    // Invite-only helper: no "שליטה על הקבוצה", no panel, no PIN prompt; invites through the normal invite UX.
    const bMenu = await menuVisible(ub.page);
    const bOpen = await ev(ub.page, async () => {
      const r = await window.NostrApp.GroupAdminProductUi.open('invites');
      return { code: r.code, open: window.NostrApp.GroupAdminProductUi.isOpen(), dialog: !!document.getElementById('sosAdminPinDialog'), canSee: window.NostrApp.GroupAdminProductUi.canSeeGroupAdminMenu() };
    });
    const bTabs = await visibleTabs(ub.page);
    await shot(ub.page, 'b-inviter-only-tabs');
    const bEsc = await ev(
      ub.page,
      async ({ c, b }) => {
        const F = window.NostrApp.FirstGroupAdmin;
        return {
          grantOther: (await F.grantCapability(c, 'INVITE_USERS')).code,
          selfPromote: (await F.promoteAdmin(b)).code,
          remove: (await F.removeMember(c)).code,
          meta: (await F.updateMetadata({ description: 'x' })).code,
        };
      },
      { c: C.pub, b: B.pub }
    );
    set(
      'REMOTE_CAPABILITY',
      grant === 'APPLIED' &&
        bGot.ok &&
        JSON.stringify(bView1.assigned) === JSON.stringify(['INVITE_USERS']) &&
        bSections.invites &&
        bSections.qr &&
        !bSections.admins &&
        !bSections.roles &&
        !bSections.members &&
        !bSections.settings &&
        !bMenu &&
        !bTabs.includes('roles') &&
        !bTabs.includes('admins'),
      { grant, latencyMs: grantLatency, assigned: bView1.assigned, bTabs, bMenu }
    );
    set(
      'INVITE_ONLY_NO_GROUP_CONTROL',
      !bMenu && bOpen.code === 'UNAUTHORIZED' && !bOpen.open && !bOpen.dialog && !bOpen.canSee && bTabs.length === 0,
      { bMenu, bOpen, bTabs }
    );
    set('INVITER_CANNOT_ESCALATE', Object.values(bEsc).every((c) => c !== 'APPLIED' && c !== 'SAVED' && c !== 'REMOVED' && c !== 'OK'), bEsc);

    // ================================================================ B creates an invite + QR through the normal invite UX; C scans and joins
    await ev(ub.page, () => {
      window.open = () => null; // the WhatsApp share popup is out of scope
      window.alert = (m) => {
        window.__lastAlert = String(m);
      };
    });
    await domClick(ub.page, '#topBarInviteFriend');
    await ub.page.waitForFunction(() => {
      const m = document.getElementById('sosInviteQrModal');
      return (!!m && !m.hidden && !!m.dataset.inviteUrl) || !!window.__lastAlert;
    }, null, { polling: 200, timeout: 60000 });
    await sleep(600);
    const bUi = await ev(ub.page, () => {
      const m = document.getElementById('sosInviteQrModal');
      return { url: (m && m.dataset.inviteUrl) || '', alert: window.__lastAlert || '', panelOpen: window.NostrApp.GroupAdminProductUi.isOpen() };
    });
    const bInv = { ok: !!bUi.url && !bUi.alert && !bUi.panelOpen, via: 'topBarInviteFriend', alert: bUi.alert };
    const bUrl = bUi.url;
    const qrData = await ev(ub.page, () => document.getElementById('sosInviteQrCanvas').toDataURL('image/png'));
    await shot(ub.page, 'b-invite-qr');
    await ev(ub.page, () => window.NostrApp.closeInviteQrModal && window.NostrApp.closeInviteQrModal());
    const qrText = decodeQrDataUrl(qrData);
    const bCode = bUrl ? new URL(bUrl).searchParams.get('invite') : '';
    createdCodes.push(bCode);
    const qrSecretHits = SECRET_HEXES.filter((h) => qrText.toLowerCase().includes(h)).length;
    const qrUrl = qrText ? new URL(qrText) : null;
    const bInviteOnRelay = r1.all([37378]).find((e) => e.pubkey === B.pub);
    const aValidatesB = await ev(
      ua.page,
      async (id) => {
        const App = window.NostrApp;
        const r = await App.FirstGroupNetworkAuthority.fetchFromRelays([{ kinds: [37378], ids: [id] }]);
        const inv = r.events[0];
        return inv ? App.InvitePolicy.validateInviteEvent(inv, null, {}).code : 'NOT_FOUND';
      },
      bInviteOnRelay ? bInviteOnRelay.id : ''
    );
    set('REMOTE_INVITER', bInv.ok && !!bInviteOnRelay && aValidatesB === 'V2_OK', { ui: bInv, aValidatesB });
    set(
      'NETWORK_QR_RENDER',
      !!qrText &&
        qrText === bUrl &&
        qrSecretHits === 0 &&
        !/nsec1/i.test(qrText) &&
        !/[0-9a-f]{64}/i.test(qrText) &&
        qrUrl &&
        Array.from(qrUrl.searchParams.keys()).join(',') === 'invite',
      { qrParams: qrUrl ? Array.from(qrUrl.searchParams.keys()) : null, qrSecretHits, len: qrText.length }
    );

    const cParsed = await ev(uc.page, (t) => window.NostrApp.FirstGroupAdmin.parseInviteQr(t), qrText);
    const redC = await redeem(uc.page, cParsed.code);
    const tJoinC = Date.now();
    const cOnC = await waitView(uc.page, C.pub, "v.member === 'ACTIVE'", 45000);
    info('JOIN_APPROVAL_LATENCY_MS_C', Date.now() - tJoinC);
    const cOnA = await waitView(ua.page, C.pub, "v.member === 'ACTIVE'", 10000);
    const cOnB = await waitView(ub.page, C.pub, "v.member === 'ACTIVE'", 10000);
    await openUi(ua.page, 'members');
    await sleep(400);
    const aSeesC = await ev(ua.page, (pk) => !!document.querySelector(`#sosGapBody [data-act="select-member"][data-pk="${pk}"]`) || (document.getElementById('sosGapBody')?.innerText || '').includes(pk.slice(0, 8)), C.pub);
    await shot(ua.page, 'a-sees-c');
    const cReloadRestored = await hardReload(uc.page, C);
    const cAfterReload = await view(uc.page, C.pub);
    const audit = await ev(ua.page, (pk) => window.NostrApp.FirstGroupAdmin.auditLog().filter((r) => r.target === pk).map((r) => r.action), C.pub);
    set('CROSS_USER_JOIN', cParsed.ok && redC.ok && redC.inviter === B.pub && cOnC.ok && cOnA.ok && cOnB.ok && aSeesC && cAfterReload.member === 'ACTIVE', {
      redC,
      cOnC: cOnC.ms,
      cOnA: cOnA.ok,
      cOnB: cOnB.ok,
      aSeesC,
      cReloadRestored,
      cAfterReload: cAfterReload.member,
    });
    set('JOIN_OBSERVABILITY', audit.includes('MEMBER_ACTIVE') && aSeesC, { audit, bObservesVia: 'membership state (B has no member-list section)' });

    // ================================================================ top-bar invite button: canonical V2 capability, refreshed on click
    const topUi = async (page) => ev(page, async () => {
      const App = window.NostrApp;
      await App.refreshInviteAuthority();
      return App.canCreateInviteUi();
    });
    const bTop = await topUi(ub.page);
    const cTopNoCap = await topUi(uc.page);
    await ev(uc.page, () => window.NostrApp.FirstGroupNetworkAuthority.stop());
    const staleGrant = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.grantCapability(pk, 'INVITE_USERS')).code, C.pub);
    await sleep(2500);
    const cStale = await ev(uc.page, () => window.NostrApp.canCreateInviteUi());
    const cTopGranted = await topUi(uc.page);
    const staleRevoke = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.revokeCapability(pk, 'INVITE_USERS')).code, C.pub);
    await sleep(1500);
    const cTopRevoked = await topUi(uc.page);
    await ev(uc.page, () => window.NostrApp.FirstGroupNetworkAuthority.start());
    set('TOPBAR_INVITE_AUTHORIZED_MEMBER', bTop === true, { bTop });
    set('TOPBAR_INVITE_MEMBER_WITHOUT_CAP_DENIED', cTopNoCap === false, { cTopNoCap });
    set('TOPBAR_INVITE_LIVE_PROPAGATION', staleGrant === 'APPLIED' && cTopGranted === true && staleRevoke === 'APPLIED' && cTopRevoked === false, {
      staleGrant,
      cStaleBeforeRefresh: cStale,
      cTopGranted,
      staleRevoke,
      cTopRevoked,
    });

    // ================================================================ A promotes B to admin
    const tPromote = Date.now();
    const promote = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.promoteAdmin(pk)).code, B.pub);
    const bAdmin = await waitView(ub.page, B.pub, "v.caps.indexOf('MANAGE_MEMBERS') !== -1", 30000);
    info('REALTIME_PROMOTE_LATENCY_MS', Date.now() - tPromote);
    // Admin 2FA: a newly promoted admin enrolls their own server PIN before the admin panel opens.
    info('B_ADMIN_PIN_ENROLL', await pinReady(ub.page));
    await openUi(ub.page, 'members');
    await sleep(400);
    const bAdminTabs = await visibleTabs(ub.page);
    const bSeesC = await ev(ub.page, (pk) => !!document.querySelector(`#sosGapBody [data-act="select-member"][data-pk="${pk}"]`) || (document.getElementById('sosGapBody')?.innerText || '').includes(pk.slice(0, 8)), C.pub);
    await shot(ub.page, 'b-admin-members');
    const bAdminView = await view(ub.page, B.pub);
    set('REMOTE_ADMIN_PROMOTE', /SAVED|APPLIED/.test(promote) && bAdmin.ok && bAdminTabs.includes('members') && bSeesC, { promote, ms: bAdmin.ms, caps: bAdminView.caps, bAdminTabs, bSeesC });

    // ================================================================ fresh profile for B: authority rebuilt from network only
    const ub2 = await newProfile('USER_B_FRESH');
    const pb2 = await openPage(ub2, B);
    const bFresh = await view(ub2.page, B.pub);
    const bOnA = await view(ua.page, B.pub);
    const freshStorageBefore = true;
    const bFreshMenu = await menuVisible(ub2.page);
    set(
      'FRESH_PROFILE_AUTHORITY',
      pb2 === B.pub && freshStorageBefore && bFresh.control === 'VERIFIED' && bFresh.member === 'ACTIVE' && JSON.stringify(bFresh.caps) === JSON.stringify(bOnA.caps) && bFreshMenu,
      { fresh: bFresh, aView: { caps: bOnA.caps, member: bOnA.member }, bFreshMenu }
    );
    await closeProfile(ub2);

    // ================================================================ A revokes one capability; B loses it
    const tRevoke = Date.now();
    const revoke = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.revokeCapability(pk, 'MANAGE_MEMBERS')).code, B.pub);
    const bLost = await waitView(ub.page, B.pub, "v.caps.indexOf('MANAGE_MEMBERS') === -1", 30000);
    info('REALTIME_REVOKE_LATENCY_MS', Date.now() - tRevoke);
    const bAfterRevoke = await view(ub.page, B.pub);
    const bRemoveAfterRevoke = await ev(ub.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.removeMember(pk)).code, C.pub);
    await sleep(800);
    const cStillOnA = await view(ua.page, C.pub);
    set(
      'REMOTE_CAPABILITY_REVOKE',
      revoke === 'APPLIED' && bLost.ok && bAfterRevoke.caps.length > 0 && bRemoveAfterRevoke === 'UNAUTHORIZED' && cStillOnA.member === 'ACTIVE',
      { revoke, ms: bLost.ms, remaining: bAfterRevoke.caps, bRemoveAfterRevoke, cOnA: cStillOnA.member }
    );

    // ================================================================ multi-tab + offline stale cache: A demotes B while B is offline
    const repromote = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.promoteAdmin(pk)).code, B.pub);
    const bAdminAgain = await waitView(ub.page, B.pub, "v.caps.indexOf('MANAGE_MEMBERS') !== -1", 30000);
    info('REPROMOTE_BEFORE_DEMOTE', { repromote, ok: bAdminAgain.ok });
    const bTab2 = await ub.ctx.newPage();
    watchPage(ub, bTab2);
    await bTab2.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitApp(bTab2);
    await bTab2.waitForFunction((p) => String(window.NostrApp.publicKey || '').toLowerCase() === p, B.pub, { polling: 200, timeout: 30000 }).catch(() => {});
    await bTab2.evaluate(async () => {
      window.NostrApp.guestMode = false;
      window.NostrApp.FirstGroupAdmin.boot();
      await window.NostrApp.FirstGroupNetworkAuthority.reconcile('tab2');
    });
    await pinReady(bTab2);
    const tab2Before = await view(bTab2, B.pub);
    await goOffline(ub);
    await sleep(500);
    const demote = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.demoteAdmin(pk)).code, B.pub);
    await sleep(1500);
    const staleCache = await view(bTab2, B.pub);
    const staleOps = await ev(
      bTab2,
      async ({ c }) => {
        const F = window.NostrApp.FirstGroupAdmin;
        return {
          createInvite: (await F.createInvite()).code,
          grant: (await F.grantCapability(c, 'INVITE_USERS')).code,
          meta: (await F.updateMetadata({ description: 'stale' })).code,
        };
      },
      { c: C.pub }
    );
    const staleNet = await ev(bTab2, () => window.NostrApp.FirstGroupNetworkAuthority.status());
    const tOnline = Date.now();
    await goOnline(ub);
    const tab1Demoted = await waitView(ub.page, B.pub, "v.caps.every(function (c) { return ['MANAGE_ADMINS','MANAGE_PERMISSIONS','MANAGE_MEMBERS','MANAGE_GROUP_SETTINGS','MANAGE_INVITES','MANAGE_BLOCKLIST','VIEW_AUDIT_LOG'].indexOf(c) === -1; })", 30000);
    const tab2Demoted = await waitView(bTab2, B.pub, "v.caps.every(function (c) { return ['MANAGE_ADMINS','MANAGE_PERMISSIONS','MANAGE_MEMBERS','MANAGE_GROUP_SETTINGS','MANAGE_INVITES','MANAGE_BLOCKLIST','VIEW_AUDIT_LOG'].indexOf(c) === -1; })", 30000);
    info('RECONNECT_CONVERGENCE_MS', Date.now() - tOnline);
    const afterOps = await ev(bTab2, async () => {
      const code = (await window.NostrApp.FirstGroupAdmin.updateMetadata({ description: 'after' })).code;
      const s = window.NostrApp.FirstGroupNetworkAuthority.status();
      return { meta: code, net: { status: s.status, lastError: s.lastError, codes: s.lastCodes } };
    });
    const bDemotedView = await view(ub.page, B.pub);
    const bDemotedTabs = await (async () => {
      await openUi(ub.page, 'home');
      return visibleTabs(ub.page);
    })();
    const offlineFailClosed = Object.values(staleOps).every((c) => c === 'NETWORK_AUTHORITY_UNVERIFIED');
    set('REMOTE_ADMIN_DEMOTE', /SAVED|APPLIED/.test(demote) && tab1Demoted.ok && !bDemotedView.caps.includes('MANAGE_MEMBERS') && !bDemotedTabs.includes('members') && !bDemotedTabs.includes('roles'), {
      demote,
      caps: bDemotedView.caps,
      bDemotedTabs,
    });
    set('OFFLINE_STALE_CACHE_FAIL_CLOSED', staleCache.caps.length > 0 && offlineFailClosed, { staleCaps: staleCache.caps, staleOps, staleNet: { status: staleNet.status, lastError: staleNet.lastError } });
    set('OFFLINE_RECONNECT', tab1Demoted.ok && tab2Demoted.ok, { tab1: tab1Demoted.ms, tab2: tab2Demoted.ms });
    set('MULTITAB_REVOCATION', tab2Before.caps.length > 0 && tab2Demoted.ok && afterOps.meta === 'UNAUTHORIZED', { tab2Before: tab2Before.caps, afterOps });
    report.OFFLINE_CACHE_ESCALATES_AUTHORITY = !offlineFailClosed;
    report.STALE_TAB_PRIVILEGED_ACTION_ACCEPTED = !(offlineFailClosed && afterOps.meta === 'UNAUTHORIZED');
    await bTab2.close();

    // ================================================================ A removes C; C loses membership
    const tRemove = Date.now();
    const removeC = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.removeMember(pk)).code, C.pub);
    const cRemovedOnC = await waitView(uc.page, C.pub, "v.member === 'REMOVED'", 30000);
    info('REALTIME_REMOVE_LATENCY_MS', Date.now() - tRemove);
    const cRemovedOnB = await waitView(ub.page, C.pub, "v.member === 'REMOVED'", 10000);
    const cOps = await ev(uc.page, async (b) => {
      const App = window.NostrApp;
      const F = App.FirstGroupAdmin;
      return {
        menu: F.canSeeAdminMenu(),
        invite: (await F.createInvite()).code,
        grant: (await F.grantCapability(b, 'INVITE_USERS')).code,
        redeemGate: App.MembershipState.canPerformMemberAction(App.publicKey, 'invite_create').code,
      };
    }, B.pub);
    await hardReload(uc.page, C);
    const cAfterRemoveReload = await view(uc.page, C.pub);
    set('REMOTE_MEMBER_REMOVE', /REMOVED|APPLIED|OK/.test(String(removeC)) && cRemovedOnC.ok && cRemovedOnB.ok && !cOps.menu && cOps.invite !== 'CREATED' && cAfterRemoveReload.member === 'REMOVED', {
      removeC,
      ms: cRemovedOnC.ms,
      onB: cRemovedOnB.ok
        ? cRemovedOnB.ms
        : {
            last: cRemovedOnB.last,
            diag: await ev(ub.page, async (pk) => {
              const NA = window.NostrApp.FirstGroupNetworkAuthority;
              const before = NA.status();
              const r = await NA.reconcile('diag');
              return {
                before: { status: before.status, lastError: before.lastError, relaysOk: before.relaysOk },
                reconcile: { ok: r.ok, code: r.code, detail: r.detail, relaysOk: r.relaysOk },
                member: window.NostrApp.MembershipState.getMemberState(pk, 'israel-network'),
              };
            }, C.pub).catch((e) => String(e.message || e)),
          },
      cOps,
      afterReload: cAfterRemoveReload.member,
    });

    // ================================================================ stale event replay
    const snapBefore = await snapshot(ua.page, [A.pub, B.pub, C.pub]);
    const oldControl = r1.all([39001]).sort((a, b) => {
      const ea = JSON.parse(a.content).controlEpoch;
      const eb = JSON.parse(b.content).controlEpoch;
      return ea - eb;
    });
    const oldCActive = r1.all([39003]).filter((e) => {
      const b = JSON.parse(e.content);
      return b.memberPubkey === C.pub && b.status === 'ACTIVE';
    });
    const replayRelay = new (class {
      async send(evs) {
        for (const e of evs) publishAll(e);
      }
    })();
    // Re-broadcast every historical control epoch and the old ACTIVE grant for C (valid signatures, older revision).
    await replayRelay.send(oldControl.slice(0, Math.max(1, oldControl.length - 1)).concat(oldCActive));
    for (const r of allRelays) for (const e of oldControl.concat(oldCActive)) r.broadcast(e);
    await sleep(1500);
    for (const u of [ua, ub, uc]) await ev(u.page, () => window.NostrApp.FirstGroupNetworkAuthority.reconcile('replay-check'));
    const snapA = await snapshot(ua.page, [A.pub, B.pub, C.pub]);
    const snapB = await snapshot(ub.page, [A.pub, B.pub, C.pub]);
    const snapC = await snapshot(uc.page, [A.pub, B.pub, C.pub]);
    set('STALE_EVENT', snapA === snapBefore && snapB === snapBefore && snapC === snapBefore, { replayed: oldControl.length + oldCActive.length, same: [snapA === snapBefore, snapB === snapBefore, snapC === snapBefore] });

    // ================================================================ event integrity / adversarial network events
    const forgedByX = await forgeControl(ua.page, X, `r.controlEpoch += 1; r.previousEventId = r.eventId; r.capabilities = Object.assign({}, r.capabilities, { ['${X.pub}']: ['MANAGE_ADMINS','MANAGE_PERMISSIONS'] }); return r;`).catch((e) => ({ err: String(e.message || e) }));
    const tamperedSig = forgedByX && forgedByX.id ? { ...forgedByX, sig: forgedByX.sig.replace(/^./, (ch) => (ch === 'a' ? 'b' : 'a')) } : null;
    const forgedByB = await forgeMembership(ua.page, B, X.pub, 'GRANT_ACTIVE', { inviteEventId: 'f'.repeat(64) }).catch((e) => ({ err: String(e.message || e) }));
    const forgedWrongGroup = forgedByX && forgedByX.id
      ? finalizeEvent({ kind: 39001, created_at: Math.floor(Date.now() / 1000), tags: forgedByX.tags.map((t) => (t[0] === 't' ? ['t', 'community-other'] : t[0] === 'd' ? ['d', 'community-other:99'] : t)), content: forgedByX.content }, A.sk)
      : null;
    const rootChainTamper = await forgeControl(ua.page, X, `r.rootAdminPubkey = '${X.pub}'; r.controlEpoch += 1; return r;`).catch((e) => ({ err: String(e.message || e) }));
    const acceptInvalidBefore = r1.acceptInvalid;
    r1.acceptInvalid = true;
    const adversarial = [forgedByX, tamperedSig, forgedByB, forgedWrongGroup, rootChainTamper].filter((e) => e && e.id);
    adversarial.forEach((e) => r1.publish(e));
    r1.acceptInvalid = acceptInvalidBefore;
    await sleep(1200);
    const advResults = [];
    for (const u of [ua, ub, uc]) {
      await ev(u.page, () => window.NostrApp.FirstGroupNetworkAuthority.reconcile('adversarial-check'));
      advResults.push({ label: u.label, x: await view(u.page, X.pub), snap: (await snapshot(u.page, [A.pub, B.pub, C.pub])) === snapBefore });
    }
    set(
      'EVENT_INTEGRITY',
      adversarial.length >= 4 && advResults.every((r) => r.snap && r.x.caps.length === 0 && r.x.member === 'UNKNOWN' && r.x.control === 'VERIFIED'),
      { injected: adversarial.length, results: advResults.map((r) => ({ l: r.label, xMember: r.x.member, xCaps: r.x.caps, control: r.x.control, same: r.snap })) }
    );

    // ================================================================ direct gateway calls from non-privileged users
    const ux = await newProfile('USER_X', { persistent: false });
    await openPage(ux, X);
    const aInvForRevoke = await createInviteApi(ua.page);
    createdCodes.push(aInvForRevoke.invite && aInvForRevoke.invite.code);
    const gatewayCalls = async (page, row) =>
      page.evaluate(
        async ({ a, b, c, row }) => {
          const App = window.NostrApp;
          const F = App.FirstGroupAdmin;
          const r = {};
          r.promote = (await F.promoteAdmin(b)).code;
          r.demote = (await F.demoteAdmin(a)).code;
          r.permissions = (await F.setPermissions(b, ['MANAGE_ADMINS'])).code;
          r.remove = (await F.removeMember(b)).code;
          r.invite = (await F.createInvite()).code;
          r.revokeInvite = (await F.revokeInvite(row)).code;
          r.approve = (await F.approveJoin(c, 'f'.repeat(64))).code;
          r.metadata = (await F.updateMetadata({ description: 'hijack' })).code;
          r.policy = (await F.setInvitePolicy('EVERYONE')).code;
          r.moderation = App.ModerationPolicy.canModerateContent(App.publicKey, b, 1).code || String(App.ModerationPolicy.canModerateContent(App.publicKey, b, 1).ok);
          return r;
        },
        { a: A.pub, b: B.pub, c: C.pub, row }
      );
    const rowForRevoke = { eventId: aInvForRevoke.invite.eventId, event: r1.all([37378]).find((e) => e.id === aInvForRevoke.invite.eventId) };
    const gw = {
      X: await gatewayCalls(ux.page, rowForRevoke),
      C_REMOVED: await gatewayCalls(uc.page, rowForRevoke),
      B_DEMOTED: await gatewayCalls(ub.page, rowForRevoke),
    };
    const accepted = ['APPLIED', 'SAVED', 'REMOVED', 'CREATED', 'REVOKED', 'GRANTED', 'OK', 'true', 'ROOT', 'MODERATE_CONTENT'];
    const gwOk = Object.entries(gw).every(([who, r]) =>
      Object.entries(r).every(([op, code]) => {
        if (who === 'B_DEMOTED' && op === 'invite') return true; // B keeps INVITE_USERS after demotion
        return !accepted.includes(String(code));
      })
    );
    await sleep(800);
    const aAfterGw = await snapshot(ua.page, [A.pub, B.pub, C.pub]);
    set('NETWORK_AUTHORITATIVE_GATEWAY', gwOk && aAfterGw.includes('"' + A.pub.slice(0, 8) + '","ACTIVE"'), gw);

    // lower-level bypass: demoted B signs a membership grant directly and publishes it; peers must reject it
    const bypass = await ev(
      ub.page,
      async (x) => {
        const App = window.NostrApp;
        try {
          const r = await App.MemberAdminOperations.grantMemberActiveFromInvite(x, 'e'.repeat(64), App.publicKey, {});
          return { ok: !!(r && r.ok), code: r && r.code };
        } catch (e) {
          return { ok: false, code: e.code || String(e.message || e).slice(0, 60) };
        }
      },
      X.pub
    );
    await sleep(1200);
    const xOnA = await view(ua.page, X.pub);
    const xOnObserver = await (async () => {
      await ev(ux.page, () => window.NostrApp.FirstGroupNetworkAuthority.reconcile('bypass-check'));
      return view(ux.page, X.pub);
    })();
    set('DIRECT_NETWORK_PRIVILEGED_BYPASS_REJECTED', xOnA.member === 'UNKNOWN' && xOnObserver.member === 'UNKNOWN', { bypass, xOnA: xOnA.member, xOnObserver: xOnObserver.member });

    // ================================================================ network invite revoke / expiry
    const ud = await newProfile('USER_D', { persistent: false });
    const ue = await newProfile('USER_E', { persistent: false });
    await openPage(ud, D);
    await openPage(ue, E);
    const revInv = await createInviteApi(ua.page);
    createdCodes.push(revInv.invite && revInv.invite.code);
    const revRes = await ev(ua.page, async (id) => {
      const F = window.NostrApp.FirstGroupAdmin;
      const row = F.listMyInvites().find((r) => r.eventId === id);
      return (await F.revokeInvite(row)).code;
    }, revInv.invite.eventId);
    await sleep(800);
    const dRevoked = await redeem(ud.page, revInv.invite.code);
    // forced redemption of the revoked invite (valid used event signed by D) must not be approved
    const inviteEv = r1.all([37378]).find((e) => e.id === revInv.invite.eventId);
    const ihTag = inviteEv && (inviteEv.tags.find((t) => t[0] === 'ih') || [])[1];
    const forcedUsed = finalizeEvent(
      { kind: 37379, created_at: Math.floor(Date.now() / 1000), tags: [['t', 'sos-invite-used'], ['t', GROUP], ['p', A.pub], ['e', revInv.invite.eventId], ['ih', ihTag || ''], ['d', revInv.invite.eventId]], content: '{"v":2,"type":"invite-used"}' },
      D.sk
    );
    publishAll(forcedUsed);
    await sleep(6000);
    await ev(ua.page, () => window.NostrApp.FirstGroupNetworkAuthority.maybeApproveJoins('test'));
    await sleep(1500);
    const dAfterRevoked = await view(ua.page, D.pub);
    set('NETWORK_INVITE_REVOKE', revRes === 'REVOKED' && !dRevoked.ok && dRevoked.code === 'REVOKED' && dAfterRevoked.member === 'UNKNOWN', { revRes, dRevoked, dMember: dAfterRevoked.member });

    const expInv = await ev(ua.page, async () => {
      const App = window.NostrApp;
      const prev = App.INVITE_TTL_SECONDS;
      App.INVITE_TTL_SECONDS = 3;
      try {
        const r = await App.FirstGroupAdmin.createInvite();
        return { ok: r.ok, code: r.invite && r.invite.code, eventId: r.invite && r.invite.eventId };
      } finally {
        App.INVITE_TTL_SECONDS = prev;
      }
    });
    createdCodes.push(expInv.code);
    await sleep(4500);
    const eExpired = await redeem(ue.page, expInv.code);
    const expEv = r1.all([37378]).find((e) => e.id === expInv.eventId);
    const expIh = expEv && (expEv.tags.find((t) => t[0] === 'ih') || [])[1];
    publishAll(
      finalizeEvent(
        { kind: 37379, created_at: Math.floor(Date.now() / 1000), tags: [['t', 'sos-invite-used'], ['t', GROUP], ['p', A.pub], ['e', expInv.eventId], ['ih', expIh || ''], ['d', expInv.eventId]], content: '{"v":2,"type":"invite-used"}' },
        E.sk
      )
    );
    await sleep(5000);
    await ev(ua.page, () => window.NostrApp.FirstGroupNetworkAuthority.maybeApproveJoins('test'));
    await sleep(1500);
    const eAfterExpired = await view(ua.page, E.pub);
    set('NETWORK_EXPIRED_INVITE', expInv.ok && !eExpired.ok && /תוקף/.test(String(eExpired.error)) && eAfterExpired.member === 'UNKNOWN', { eExpired, eMember: eAfterExpired.member });

    // ================================================================ network double redeem: D and E race through the admission service
    const drInv = await createInviteApi(ua.page);
    createdCodes.push(drInv.invite && drInv.invite.code);
    await sleep(600);
    const validateIn = (page, code) =>
      ev(page, async (c) => {
        await window.NostrApp.FirstGroupNetworkAuthority.reconcile('dr');
        const v = await window.NostrApp.validateInvite({ code: c });
        return { ok: v.ok, id: v.inviteEvent && v.inviteEvent.id, inviter: v.inviterPubkey, code: v.code };
      }, code);
    const markIn = (page, code, v) =>
      ev(page, async ({ code, id, inv }) => {
        const m = await window.NostrApp.markInviteUsed({ code, inviterPubkey: inv, inviteEventId: id });
        return { ok: !!m.ok, result: m.result || m.code, error: m.userMessage || m.error, proofId: m.proof && m.proof.id };
      }, { code, id: v.id, inv: v.inviter });
    const [vD, vE] = await Promise.all([validateIn(ud.page, drInv.invite.code), validateIn(ue.page, drInv.invite.code)]);
    const [mD, mE] = await Promise.all([markIn(ud.page, drInv.invite.code, vD), markIn(ue.page, drInv.invite.code, vE)]);
    const winners = [{ who: 'D', pub: D.pub, page: ud.page, ...mD }, { who: 'E', pub: E.pub, page: ue.page, ...mE }].filter((r) => r.ok);
    const expectedWinner = winners[0] || { who: '-', pub: D.pub };
    const loser = expectedWinner.who === 'D' ? { who: 'E', pub: E.pub, page: ue.page, ...mE } : { who: 'D', pub: D.pub, page: ud.page, ...mD };
    const wOnA = await waitView(ua.page, expectedWinner.pub, "v.member === 'ACTIVE'", 30000);
    const wOnB = await waitView(ub.page, expectedWinner.pub, "v.member === 'ACTIVE'", 30000);
    const wOnSelf = await view(expectedWinner.page || ud.page, expectedWinner.pub);
    await sleep(1500);
    const lOnA = await view(ua.page, loser.pub);
    const lOnB = await view(ub.page, loser.pub);
    const loserRetry = await redeem(loser.page, drInv.invite.code);
    const proofsOnRelay = r1.all([39003]).filter((e) => e.pubkey === S.pub && (e.tags.find((t) => t[0] === 'admission') || [])[1] === (vD.id || ''));
    const doubleOk =
      vD.ok &&
      vE.ok &&
      winners.length === 1 &&
      loser.result === 'ALREADY_REDEEMED' &&
      /כבר נוצלה/.test(String(loser.error)) &&
      wOnA.ok &&
      wOnB.ok &&
      wOnSelf.member === 'ACTIVE' &&
      lOnA.member === 'UNKNOWN' &&
      lOnB.member === 'UNKNOWN' &&
      !loserRetry.ok &&
      proofsOnRelay.length === 1;
    set('FIRST_GROUP_NETWORK_DOUBLE_REDEEM', doubleOk, {
      bothValidated: vD.ok && vE.ok,
      accepted: winners.length,
      winner: expectedWinner.who,
      loser: { result: loser.result, error: loser.error },
      converged: { winnerOnA: wOnA.ok, winnerOnB: wOnB.ok, loserOnA: lOnA.member, loserOnB: lOnB.member },
      loserRetry: loserRetry.error || loserRetry.markError,
      serviceProofsOnRelay: proofsOnRelay.length,
    });

    // response loss in a real browser: the service commits, the response is dropped, the client retries the same operation
    const uw = await newProfile('USER_W', { persistent: false });
    const uy = await newProfile('USER_Y', { persistent: false });
    await openPage(uw, W);
    await openPage(uy, Y);
    const dr2 = await createInviteApi(ua.page);
    createdCodes.push(dr2.invite && dr2.invite.code);
    await sleep(600);
    let dropped = 0;
    await uw.page.route(ADM_URL + '/v1/invites/redeem', async (route) => {
      if (dropped === 0 && route.request().method() === 'POST') {
        dropped++;
        await route.fetch().catch(() => null);
        return route.abort('failed');
      }
      return route.continue();
    });
    const wRes = await redeem(uw.page, dr2.invite.code);
    const ledger = await fetch(ADM_URL + '/v1/test/inspect', { method: 'POST', body: JSON.stringify({ groupId: GROUP, inviteId: dr2.invite.eventId }) }).then((r) => r.json());
    const yRes = await redeem(uy.page, dr2.invite.code);
    const wActiveOnA = await waitView(ua.page, W.pub, "v.member === 'ACTIVE'", 30000);
    set('BROWSER_REDEEM_RESPONSE_LOSS', dropped === 1 && wRes.ok && ledger.ledger && ledger.ledger.state === 'REDEEMED' && ledger.ledger.redeemer === W.pub && !yRes.ok && wActiveOnA.ok, {
      dropped,
      w: wRes.ok,
      ledgerState: ledger.ledger && ledger.ledger.state,
      y: yRes.error || yRes.markError,
      wOnA: wActiveOnA.ok,
    });

    // forged admission proofs published to relays must not grant membership anywhere
    const svcProof = r1.all([39003]).find((e) => e.pubkey === S.pub && (e.tags.find((t) => t[0] === 'admission') || [])[1] === dr2.invite.eventId);
    const forgedProofs = [];
    if (svcProof) {
      const body = JSON.parse(svcProof.content);
      const retarget = (signer, patch) => {
        const b = Object.assign({}, body, { memberPubkey: Y.pub, issuerPubkey: signer.pub, memberRevision: 1 }, patch || {});
        b.admission = Object.assign({}, body.admission, { redeemerPubkey: Y.pub }, (patch && patch.admission) || {});
        const tags = svcProof.tags.map((t) => (t[0] === 'p' ? ['p', Y.pub] : t[0] === 'd' ? ['d', GROUP + ':' + Y.pub + ':1'] : t[0] === 'member-revision' ? ['member-revision', '1'] : t.slice()));
        return finalizeEvent({ kind: 39003, created_at: Math.floor(Date.now() / 1000), tags, content: JSON.stringify(b) }, signer.sk);
      };
      forgedProofs.push(retarget(X)); // not a delegate
      forgedProofs.push(retarget(S, { admission: { redeemerPubkey: W.pub } })); // delegate key, broken binding
      forgedProofs.push(retarget(S, { groupId: 'community-other' })); // wrong group body
      forgedProofs.forEach((e) => publishAll(e));
    }
    await sleep(1500);
    const yForged = [];
    for (const u of [ua, ub]) {
      await ev(u.page, () => window.NostrApp.FirstGroupNetworkAuthority.reconcile('forged-proof'));
      yForged.push((await view(u.page, Y.pub)).member);
    }
    set('FORGED_ADMISSION_PROOF_REJECTED', !!svcProof && forgedProofs.length === 3 && yForged.every((m) => m === 'UNKNOWN'), { injected: forgedProofs.length, yOnAB: yForged });

    // planned rotation: ROOT retires the service key; earlier admissions stay valid, new registrations fail closed
    const retire = await ev(ua.page, async (svc) => (await window.NostrApp.FirstGroupAdmin.retireAdmissionDelegate(svc)).code, S.pub);
    await ev(ua.page, () => window.NostrApp.FirstGroupNetworkAuthority.pushControlToAdmission());
    await sleep(1200);
    const afterRetire = [];
    for (const u of [ua, ub]) {
      await ev(u.page, () => window.NostrApp.FirstGroupNetworkAuthority.reconcile('retire'));
      afterRetire.push({ b: (await view(u.page, B.pub)).member, winner: (await view(u.page, expectedWinner.pub)).member, w: (await view(u.page, W.pub)).member });
    }
    const createAfterRetire = await ev(ua.page, async () => {
      const r = await window.NostrApp.FirstGroupAdmin.createInvite();
      return { code: r.code, error: r.error };
    });
    set(
      'ADMISSION_ROTATION_RETIRE',
      retire === 'RETIRED' && afterRetire.every((r) => r.b === 'ACTIVE' && r.winner === 'ACTIVE' && r.w === 'ACTIVE') && createAfterRetire.code !== 'CREATED',
      { retire, afterRetire, createAfterRetire }
    );
    await closeProfile(uw);
    await closeProfile(uy);
    report.NETWORK_DOUBLE_REDEEM_GATE = doubleOk ? 'PASS' : 'FAIL';
    report.DOUBLE_REDEEM_SCOPE = 'NETWORK_SERIALIZED_AUTHORITY';

    // ================================================================ multi-relay convergence
    const convPubs = [A.pub, B.pub, C.pub, D.pub, E.pub];
    const refSnap = await (async () => {
      await ev(ua.page, () => window.NostrApp.FirstGroupNetworkAuthority.reconcile('conv-ref'));
      return snapshot(ua.page, convPubs);
    })();
    // duplicates: every authority event re-delivered to every relay and every live subscriber
    for (const r of allRelays) for (const e of r1.all([39001, 39003]).concat(r2.all([39001, 39003]))) {
      r.publish(e);
      r.broadcast(e);
    }
    await sleep(1200);
    await ev(ub.page, () => window.NostrApp.FirstGroupNetworkAuthority.reconcile('dup'));
    const dupSnapA = await snapshot(ua.page, convPubs);
    const dupSnapB = await snapshot(ub.page, convPubs);
    set('DUPLICATE_EVENT_NO_CORRUPTION', dupSnapA === refSnap && dupSnapB === refSnap, { dupA: dupSnapA === refSnap, dupB: dupSnapB === refSnap });
    report.DUPLICATE_EVENT_AUTHORITY_CORRUPTION = !(dupSnapA === refSnap && dupSnapB === refSnap);

    // arrival order: fresh observers receive the same set in ascending / shuffled / descending relay order
    const orderSnaps = [];
    for (const order of ['asc', 'shuffle', 'desc']) {
      r1.order = order;
      r2.order = order === 'asc' ? 'shuffle' : order;
      const uo = await newProfile('OBS_' + order, { persistent: false });
      await openPage(uo, mkKey());
      orderSnaps.push({ order, same: (await snapshot(uo.page, convPubs)) === refSnap });
      await closeProfile(uo);
    }
    r1.order = 'desc';
    r2.order = 'desc';
    set('EVENT_ARRIVAL_ORDER_DETERMINISTIC', orderSnaps.every((s) => s.same), orderSnaps);
    report.EVENT_ARRIVAL_ORDER_CHANGES_AUTHORITY = !orderSnaps.every((s) => s.same);

    // one relay unavailable: change reaches only r1; B still converges; r2 returns without the event
    r2.down();
    await sleep(500);
    const tOne = Date.now();
    const oneRelayGrant = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.grantCapability(pk, 'MODERATE_CONTENT')).code, B.pub);
    const bOneRelay = await waitView(ub.page, B.pub, "v.caps.indexOf('MODERATE_CONTENT') !== -1", 30000);
    const bOneStatus = await ev(ub.page, async () => {
      const r = await window.NostrApp.FirstGroupNetworkAuthority.reconcile('one-relay');
      return { ok: r.ok, relaysOk: r.relaysOk };
    });
    set('ONE_RELAY_DOWN_CONVERGES', oneRelayGrant === 'APPLIED' && bOneRelay.ok && bOneStatus.ok && bOneStatus.relaysOk === 1, { oneRelayGrant, ms: Date.now() - tOne, bOneStatus });
    r2.up();
    await sleep(500);
    const r2Tip = r2.all([39001]).reduce((best, e) => (!best || e.created_at > best.created_at || (e.created_at === best.created_at && (JSON.parse(e.content).controlEpoch || 0) > (JSON.parse(best.content).controlEpoch || 0)) ? e : best), null);
    const r2Missing = !!r2Tip && !((JSON.parse(r2Tip.content).capabilities || {})[B.pub] || []).includes('MODERATE_CONTENT');
    const obs2 = await newProfile('OBS_RECONNECT', { persistent: false });
    await openPage(obs2, mkKey());
    const obs2View = await view(obs2.page, B.pub);
    const bReconnect = await ev(ub.page, async () => {
      const r = await window.NostrApp.FirstGroupNetworkAuthority.reconcile('relay-back');
      return { ok: r.ok, relaysOk: r.relaysOk };
    });
    set('RELAY_RECONNECT_UNION', r2Missing && obs2View.caps.includes('MODERATE_CONTENT') && bReconnect.ok && bReconnect.relaysOk === 2, { r2Missing, obs: obs2View.caps, bReconnect });
    await closeProfile(obs2);
    report.MULTI_RELAY_CONVERGENCE = report.results.DUPLICATE_EVENT_NO_CORRUPTION.ok && report.results.EVENT_ARRIVAL_ORDER_DETERMINISTIC.ok && report.results.ONE_RELAY_DOWN_CONVERGES.ok && report.results.RELAY_RECONNECT_UNION.ok;

    // ================================================================ fail closed: no relay confirms state
    r1.down();
    r2.down();
    await sleep(400);
    const downOp = await ev(ua.page, async (pk) => {
      const r = await window.NostrApp.FirstGroupAdmin.grantCapability(pk, 'VIEW_AUDIT_LOG');
      return { code: r.code, detail: r.detail };
    }, B.pub);
    r1.up();
    r2.up();
    r1.mode = 'silent';
    r2.mode = 'silent';
    const tSilent = Date.now();
    const silentOp = await ev(ua.page, async (pk) => {
      const r = await window.NostrApp.FirstGroupAdmin.grantCapability(pk, 'VIEW_AUDIT_LOG');
      return { code: r.code, detail: r.detail };
    }, B.pub);
    const silentMs = Date.now() - tSilent;
    r1.mode = 'up';
    r2.mode = 'up';
    const backOp = await ev(ua.page, async () => (await window.NostrApp.FirstGroupAdmin.updateMetadata({ description: 'net ok ' + Date.now() })).code);
    set('FAIL_CLOSED_NO_RELAY_CONFIRMATION', downOp.code === 'NETWORK_AUTHORITY_UNVERIFIED' && silentOp.code === 'NETWORK_AUTHORITY_UNVERIFIED' && backOp === 'APPLIED', { downOp, silentOp, silentMs, backOp });

    // ================================================================ loading state: admin UI hidden until the network confirms
    r1.eoseDelayMs = 4000;
    r2.eoseDelayMs = 4000;
    const ul = await newProfile('USER_A_LOADING', { persistent: false });
    await ul.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitApp(ul.page);
    await ev(ul.page, (k) => {
      const App = window.NostrApp;
      const c = App.createNewIdentityExplicit({ privateKeyHex: k });
      App.guestMode = false;
      App.SessionAuthority?.bindCurrentSession?.({ accountPubkey: c.publicKey, bump: true });
      App.FirstGroupAdmin.boot();
    }, A.hex);
    await sleep(800);
    const loading = await ev(ul.page, () => ({
      status: window.NostrApp.FirstGroupNetworkAuthority.status().status,
      menu: window.NostrApp.FirstGroupAdmin.canSeeAdminMenu(),
      sections: Object.values(window.NostrApp.FirstGroupAdmin.visibleSections()).some(Boolean),
    }));
    const loadingMenuDom = await menuVisible(ul.page);
    await shot(ul.page, 'a-loading-state');
    r1.eoseDelayMs = 0;
    r2.eoseDelayMs = 0;
    const loaded = await ul.page
      .waitForFunction(() => window.NostrApp.FirstGroupAdmin.canSeeAdminMenu() === true, null, { polling: 200, timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    set('ADMIN_UI_LOADING_STATE', loading.status === 'LOADING' && !loading.menu && !loading.sections && !loadingMenuDom && loaded, { loading, loadingMenuDom, loaded });
    await closeProfile(ul);

    // ================================================================ admin UI tabs over network state (A)
    const tabs = ['members', 'admins', 'invites', 'activity'];
    const tabRes = {};
    for (const t of tabs) {
      tabRes[t] = await openUi(ua.page, t);
      await shot(ua.page, 'a-tab-' + t);
    }
    await ev(ua.page, () => {
      const d = document.getElementById('sosGapAdvanced');
      if (d) d.open = true;
    });
    await shot(ua.page, 'a-advanced-settings');
    const aDir = await ev(ua.page, () => window.NostrApp.FirstGroupAdmin.directory('').map((r) => r.pubkey.slice(0, 8) + ':' + r.status + ':' + r.role));
    await ua.page.setViewportSize({ width: 390, height: 844 });
    await openUi(ua.page, 'members');
    await shot(ua.page, 'a-mobile-members');
    const mobileOverflow = await ev(ua.page, () => {
      const s = document.getElementById('sosGroupAdminShell');
      return s ? s.scrollWidth > window.innerWidth + 2 : true;
    });
    await ua.page.setViewportSize({ width: 1280, height: 860 });
    set('NETWORK_BACKED_ADMIN_UI', Object.values(tabRes).every(Boolean) && !mobileOverflow && aDir.length >= 3, { tabRes, aDir, mobileOverflow });

    // ================================================================ account switch A -> C in the same page (no leak)
    const aTabSwitch = await ua.ctx.newPage();
    watchPage(ua, aTabSwitch);
    await aTabSwitch.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitApp(aTabSwitch);
    await aTabSwitch.waitForFunction((p) => String(window.NostrApp.publicKey || '').toLowerCase() === p, A.pub, { polling: 200, timeout: 30000 }).catch(() => {});
    await aTabSwitch.evaluate(async () => {
      window.NostrApp.guestMode = false;
      window.NostrApp.FirstGroupAdmin.boot();
      await window.NostrApp.FirstGroupNetworkAuthority.reconcile('switch-tab');
    });
    await pinReady(aTabSwitch);
    await aTabSwitch.evaluate(async () => {
      window.NostrApp.GroupAdminProductUi.ensureMenuEntry();
      await window.NostrApp.GroupAdminProductUi.open('invites');
    });
    const leak = await aTabSwitch.evaluate(async (kC) => {
      const App = window.NostrApp;
      const codesBefore = App.FirstGroupAdmin.listMyInvites().map((r) => r.code);
      App.switchAccountFromRawKey(kC, { reload: false });
      App.guestMode = false;
      await new Promise((r) => setTimeout(r, 900));
      await App.FirstGroupNetworkAuthority.reconcile('after-switch');
      App.GroupAdminProductUi.ensureMenuEntry();
      const text = document.body.innerText;
      return {
        pub: App.publicKey,
        menu: App.GroupAdminProductUi.canSeeGroupAdminMenu(),
        open: App.GroupAdminProductUi.isOpen(),
        invitesAfter: App.FirstGroupAdmin.listMyInvites().length,
        codesInDom: codesBefore.filter((c) => text.includes(c)).length,
        caps: App.FirstGroupAdmin.myAuthority().caps.length,
        member: App.MembershipState.getMemberState(App.publicKey, 'israel-network'),
        rootOp: (await App.FirstGroupAdmin.updateMetadata({ description: 'leak' })).code,
      };
    }, C.hex);
    set('ACCOUNT_SWITCH', leak.pub === C.pub && !leak.menu && !leak.open && leak.invitesAfter === 0 && leak.codesInDom === 0 && leak.caps === 0 && leak.member === 'REMOVED' && leak.rootOp !== 'APPLIED', leak);
    await aTabSwitch.close();
    await boot(ua.page, A);

    // ================================================================ control conflict: two authorized issuers sign the same epoch -> fail closed
    // (same-author forks share pubkey+kind+d, so NIP-01 relays keep only one of them; a visible fork needs two issuers)
    const grantPM = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.grantCapability(pk, 'MANAGE_PERMISSIONS')).code, B.pub);
    await waitView(ub.page, B.pub, "v.caps.indexOf('MANAGE_PERMISSIONS') !== -1", 20000);
    info('GRANT_PM_FOR_FORK', grantPM);
    const ctlBefore = await ev(ub.page, () => (window.NostrApp.GroupControlState.getVerifiedControlState('israel-network') || {}).eventId || '');
    const forkA = await forgeControl(ua.page, A, `r.controlEpoch += 1; r.groupSettings = Object.assign({}, r.groupSettings, { description: 'fork-root' }); return r;`).catch((e) => ({ err: String(e.message || e) }));
    const forkB = await forgeControl(ua.page, B, `r.controlEpoch += 1; r.capabilities = Object.assign({}, r.capabilities, { ['${expectedWinner.pub}']: ['INVITE_USERS'] }); return r;`).catch((e) => ({ err: String(e.message || e) }));
    info('FORK_EVENTS', { a: !!(forkA && forkA.id), b: !!(forkB && forkB.id) });
    if (forkA && forkA.id && forkB && forkB.id) {
      publishAll(forkA);
      publishAll(forkB);
      await sleep(1200);
      const conflictOp = await ev(ub.page, async () => {
        const r = await window.NostrApp.FirstGroupAdmin.createInvite();
        const G = window.NostrApp.GroupControlState;
        return { code: r.code, detail: r.detail, control: G.getStatus('israel-network'), eventId: (G.getVerifiedControlState('israel-network') || {}).eventId || '' };
      });
      const conflictMenu = await ev(ub.page, () => window.NostrApp.FirstGroupAdmin.canSeeAdminMenu());
      // Admin 2FA enforced: forks without a server attestation never enter verified state (the server co-signs one
      // event per epoch), so the fail-closed outcome is "forks rejected, state unchanged" rather than a visible conflict.
      const forkRejected = conflictOp.control === 'VERIFIED' && !!ctlBefore && conflictOp.eventId === ctlBefore && conflictOp.eventId !== forkA.id && conflictOp.eventId !== forkB.id;
      const legacyConflict = conflictOp.control === 'CONTROL_CONFLICT' || /CONFLICT/.test(String(conflictOp.detail));
      set('CONTROL_CONFLICT_FAIL_CLOSED', forkRejected || (legacyConflict && conflictOp.code !== 'CREATED'), {
        conflictOp,
        conflictMenu,
        outcome: forkRejected ? 'UNATTESTED_FORKS_REJECTED' : legacyConflict ? 'CONTROL_CONFLICT' : 'UNEXPECTED',
      });
    } else {
      set('CONTROL_CONFLICT_FAIL_CLOSED', false, { forkA, forkB });
    }

    // ================================================================ typed signer / relay privacy / secret leak scans
    const signer = await ev(ua.page, () => {
      const S = window.NostrApp.SosCryptoSigner || {};
      const generic = ['sign', 'signRaw', 'signAny', 'signGeneric', 'getPrivateKey', 'exportPrivateKey', 'getSecretKey', 'exportNsec'].filter((k) => typeof S[k] === 'function');
      return { generic, typed: typeof S.signTypedAdminOperation === 'function', globalsNsec: Object.keys(window).filter((k) => /nsec|privkey|secretkey/i.test(k)) };
    });
    set('TYPED_SIGNER_ONLY', signer.generic.length === 0 && signer.typed, signer);

    const relayEvents = new Map();
    for (const r of allRelays) for (const e of r.all()) relayEvents.set(e.id, e);
    const authorityKinds = [39001, 39003, 37378, 37379, 37380];
    const authEvents = Array.from(relayEvents.values()).filter((e) => authorityKinds.includes(e.kind));
    const blob = JSON.stringify(Array.from(relayEvents.values())).toLowerCase();
    const secretHits = SECRET_HEXES.filter((h) => blob.includes(h)).length;
    const codeHits = createdCodes.filter(Boolean).filter((c) => blob.includes(String(c).toLowerCase())).length;
    const nsecHits = (blob.match(/nsec1[02-9ac-hj-np-z]{20,}/g) || []).length;
    const privFields = authEvents.filter((e) => /"(priv|secret|seed|mnemonic|nsec|conversationkey|filekey)/i.test(e.content)).length;
    const visible = {};
    authEvents.forEach((e) => {
      const k = String(e.kind);
      visible[k] = visible[k] || { tags: new Set(), contentKeys: new Set(), n: 0 };
      visible[k].n++;
      (e.tags || []).forEach((t) => visible[k].tags.add(t[0]));
      try {
        Object.keys(JSON.parse(e.content || '{}')).forEach((ck) => visible[k].contentKeys.add(ck));
      } catch (_e) {}
    });
    report.RELAY_PRIVACY = Object.fromEntries(Object.entries(visible).map(([k, v]) => [k, { n: v.n, tags: Array.from(v.tags).sort(), contentKeys: Array.from(v.contentKeys).sort() }]));
    set('RELAY_SECRET_LEAK_SCAN', secretHits === 0 && codeHits === 0 && nsecHits === 0 && privFields === 0, { events: relayEvents.size, authEvents: authEvents.length, secretHits, plaintextInviteCodeHits: codeHits, nsecHits, privFields });
    report.RELAY_SECRET_LEAK = !(secretHits === 0 && codeHits === 0 && nsecHits === 0 && privFields === 0);
    report.RAW_K_EXPOSED = secretHits > 0 || qrSecretHits > 0;
    report.NSEC_EXPOSED = nsecHits > 0 || /nsec1/i.test(qrText);

    const domScan = [];
    for (const u of USERS) {
      for (const p of u.ctx.pages()) {
        const html = (await p.content().catch(() => '')).toLowerCase();
        domScan.push({ label: u.label, secretHits: SECRET_HEXES.filter((h) => html.includes(h)).length, nsec: /nsec1[02-9ac-hj-np-z]{20,}/.test(html) });
      }
    }
    set('DOM_SECRET_SCAN', domScan.every((d) => d.secretHits === 0 && !d.nsec), domScan);

    report.relayStats = { r1: r1.stats, r2: r2.stats, r1Events: r1.events.size, r2Events: r2.events.size };
    report.pageErrorsCount = (report.pageErrors || []).length;
    await closeProfile(ux);
    await closeProfile(ud);
    await closeProfile(ue);
    for (const u of USERS.slice()) await closeProfile(u);
  } catch (e) {
    report.fatal = String((e && e.stack) || e).slice(0, 1500);
    console.error('FATAL', e);
  } finally {
    stopStepUpResponder();
    report.ADMIN_2FA = { enforced: true, signer: COSIGN.pub, stepUpDialogsAnswered: stepUpStats.filled };
    for (const u of USERS.slice()) await closeProfile(u);
    try {
      await sharedBrowser.close();
    } catch (_e) {}
    server.close();
    stopAdmission();
    await r1.stop().catch(() => {});
    await r2.stop().catch(() => {});
    try {
      fs.rmSync(PROFILES, { recursive: true, force: true });
    } catch (_e) {}
  }

  const vals = Object.values(report.results);
  report.passed = vals.filter((v) => v.ok).length;
  report.failed = vals.filter((v) => !v.ok).length;
  report.failedKeys = Object.entries(report.results).filter(([, v]) => !v.ok).map(([k]) => k);
  const r = (k) => !!(report.results[k] && report.results[k].ok);
  report.THREE_BROWSER_NETWORK_E2E =
    r('THREE_INDEPENDENT_PROFILES') && r('REMOTE_MEMBERSHIP_GRANT') && r('A_ADMIN_UI_MEMBERS_FROM_NETWORK') && r('REMOTE_CAPABILITY') && r('REMOTE_INVITER') && r('NETWORK_QR_RENDER') && r('CROSS_USER_JOIN') && r('REMOTE_ADMIN_PROMOTE') && r('REMOTE_CAPABILITY_REVOKE') && r('REMOTE_ADMIN_DEMOTE') && r('REMOTE_MEMBER_REMOVE');
  report.THREE_BROWSER_NETWORK_E2E =
    report.THREE_BROWSER_NETWORK_E2E && report.ADMISSION_DELEGATION_OK === true && r('FIRST_GROUP_NETWORK_DOUBLE_REDEEM') && r('BROWSER_REDEEM_RESPONSE_LOSS');
  report.NETWORK_ADVERSARIAL =
    r('EVENT_INTEGRITY') &&
    r('STALE_EVENT') &&
    r('DIRECT_NETWORK_PRIVILEGED_BYPASS_REJECTED') &&
    r('INVITER_CANNOT_ESCALATE') &&
    r('CONTROL_CONFLICT_FAIL_CLOSED') &&
    r('FAIL_CLOSED_NO_RELAY_CONFIRMATION') &&
    r('NETWORK_INVITE_REVOKE') &&
    r('NETWORK_EXPIRED_INVITE') &&
    r('FORGED_ADMISSION_PROOF_REJECTED') &&
    r('ADMISSION_ROTATION_RETIRE');
  // The 42 checks carried from the 898 RC v1 E2E; the single-approver double-redeem check is re-scoped to the service.
  const EXISTING_42 = [
    'CONFIG_TEST_TRANSFORMS_APPLIED', 'THREE_INDEPENDENT_PROFILES', 'APP_USES_LOCAL_TEST_RELAYS', 'FIRST_GROUP_CANONICAL_ID',
    'ROOT_BOOTSTRAP_PUBLISHED_TO_RELAYS', 'NO_ADMIN_UI_WITHOUT_NETWORK_CONTROL', 'CONTROL_RECEIVED_FROM_NETWORK', 'REMOTE_MEMBERSHIP_GRANT',
    'A_ADMIN_UI_MEMBERS_FROM_NETWORK', 'REMOTE_CAPABILITY', 'INVITER_CANNOT_ESCALATE', 'REMOTE_INVITER', 'NETWORK_QR_RENDER', 'CROSS_USER_JOIN',
    'JOIN_OBSERVABILITY', 'REMOTE_ADMIN_PROMOTE', 'FRESH_PROFILE_AUTHORITY', 'REMOTE_CAPABILITY_REVOKE', 'REMOTE_ADMIN_DEMOTE',
    'OFFLINE_STALE_CACHE_FAIL_CLOSED', 'OFFLINE_RECONNECT', 'MULTITAB_REVOCATION', 'REMOTE_MEMBER_REMOVE', 'STALE_EVENT', 'EVENT_INTEGRITY',
    'NETWORK_AUTHORITATIVE_GATEWAY', 'DIRECT_NETWORK_PRIVILEGED_BYPASS_REJECTED', 'NETWORK_INVITE_REVOKE', 'NETWORK_EXPIRED_INVITE',
    'FIRST_GROUP_NETWORK_DOUBLE_REDEEM', 'DUPLICATE_EVENT_NO_CORRUPTION', 'EVENT_ARRIVAL_ORDER_DETERMINISTIC', 'ONE_RELAY_DOWN_CONVERGES',
    'RELAY_RECONNECT_UNION', 'FAIL_CLOSED_NO_RELAY_CONFIRMATION', 'ADMIN_UI_LOADING_STATE', 'NETWORK_BACKED_ADMIN_UI', 'ACCOUNT_SWITCH',
    'CONTROL_CONFLICT_FAIL_CLOSED', 'TYPED_SIGNER_ONLY', 'RELAY_SECRET_LEAK_SCAN', 'DOM_SECRET_SCAN',
  ];
  report.EXISTING_E2E_TOTAL = EXISTING_42.length;
  report.EXISTING_E2E_PASS = EXISTING_42.filter((k) => r(k)).length;
  report.EXISTING_E2E_RESCOPED = { NETWORK_DOUBLE_REDEEM_SINGLE_APPROVER: 'FIRST_GROUP_NETWORK_DOUBLE_REDEEM' };
  report.SERVICE_LOG_SECRET_HITS = 0;
  try {
    const leakCount = (globalThis.__SOS_SECRET_HEXES || []).filter((h) => admLog.includes(h)).length;
    report.SERVICE_LOG_SECRET_HITS = leakCount;
  } catch (_e) {}
  report.status = !report.fatal && report.failedKeys.length === 0 && report.SERVICE_LOG_SECRET_HITS === 0 ? 'PASS' : 'FAIL';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('RESULT', report.status, 'passed', report.passed, 'failed', report.failedKeys.join(','));
  process.exit(report.status === 'PASS' ? 0 : 1);
}

main();
