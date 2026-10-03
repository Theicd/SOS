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
    `ROOT_PUBKEY=${rootPub}\nADMISSION_SK=${svcHex}\nADMIN_COSIGN_SK=${COSIGN.hex}\nADMIN_PIN_PEPPER=${PIN_PEPPER}\nTEST_FAULTS=1\nALLOWED_ORIGINS=http://127.0.0.1:${PORT}\nADMIN_2FA_SIGNER_PUBKEY=${COSIGN.pub}\nCONTROL_RELAYS=${RELAYS.join(',')}\n`
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
  page.on('requestfailed', (req) => {
    if (!req.url().startsWith(ADM_URL)) return;
    (report.ADM_REQUEST_FAILURES = report.ADM_REQUEST_FAILURES || []).push({ user: u.label, path: new URL(req.url()).pathname, error: String((req.failure() || {}).errorText || '') });
  });
  page.on('response', async (res) => {
    if (res.url().startsWith(ADM_URL) && res.status() >= 400) {
      (report.ADM_HTTP_ERRORS = report.ADM_HTTP_ERRORS || []).push({ user: u.label, path: new URL(res.url()).pathname, status: res.status() });
    }
    if (!/\/v1\/admin-pin\/cosign/.test(res.url())) return;
    try {
      const j = await res.json();
      if (j && j.result !== 'COSIGNED') {
        (report.COSIGN_DENIALS = report.COSIGN_DENIALS || []).push({ user: u.label, result: j.result, code: j.code || null, reason: j.reason || null });
      }
    } catch (_e) {}
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
  const pub = await bootIdentity(page, key);
  await pinReady(page);
  return pub;
}

/** Signs in without touching the admin PIN (a fresh principal enrolls only when an admin action asks for it). */
async function bootIdentity(page, key) {
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
async function actConfirm(page, selector) {
  await page.evaluate(() => {
    const m = document.getElementById('sosGapMsg');
    if (m) {
      m.textContent = '';
      m.className = 'gap-msg';
    }
  });
  await domClick(page, selector);
  await waitSel(page, '#sosGapConfirm.is-open', 15000);
  await page.evaluate(() => document.getElementById('sosGapConfirmOk').click());
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

/** Signed kind-1 group note (or reply) published through the app pool; returns the event. */
async function publishNote(page, content, parentId) {
  return page.evaluate(
    async ({ content, parentId }) => {
      const App = window.NostrApp;
      const tags = [['t', App.NETWORK_TAG || 'israel-network']];
      if (parentId) tags.unshift(['e', parentId, '', 'root'], ['e', parentId, '', 'reply']);
      const ev = await Promise.resolve(App.SosCryptoSigner.signFeedEvent({ kind: 1, pubkey: App.publicKey, created_at: Math.floor(Date.now() / 1000), tags, content }));
      const r = App.pool.publish(App.relayUrls, ev);
      await (Array.isArray(r) ? Promise.any(r) : r);
      return ev;
    },
    { content, parentId: parentId || '' }
  );
}

async function modRemove(page, target) {
  return page.evaluate(async (t) => {
    const r = await window.NostrApp.moderateRemoveEvent(t);
    return { ok: !!(r && r.ok), code: r && r.code };
  }, target);
}

/** Content / participation view of `pk` from this page (no reconcile). */
async function blockView(page, pk) {
  return page.evaluate((pk) => {
    const App = window.NostrApp;
    const MS = App.MembershipState;
    return {
      member: MS.getMemberState(pk, 'israel-network'),
      listed: MS.inBlockedPubkeys(pk),
      suppressed: App.ModerationPolicy.isAuthorSuppressed(pk),
      post: MS.canPerformMemberAction(pk, 'post_create').ok,
      comment: MS.canPerformMemberAction(pk, 'comment_reply').ok,
      reaction: MS.canPerformMemberAction(pk, 'reaction').ok,
      p2p: MS.canPerformMemberAction(pk, 'group_p2p_signal').ok,
      caps: App.FirstGroupAdmin.authorityFor(pk).caps.slice().sort(),
      assigned: App.FirstGroupAdmin.authorityFor(pk).assigned.slice().sort(),
      blockState: App.FirstGroupAdmin.blockStateOf(pk),
    };
  }, pk);
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
      bCard.remove && bCard.edit && editor.target === B.pub && JSON.stringify(editor.caps.slice().sort()) === JSON.stringify(editor.canonical.slice().sort()) && editor.enabled > 0 && editor.roleButtons > 0,
      { bCard, target: editor.target === B.pub, caps: editor.caps.length, enabled: editor.enabled, roleButtons: editor.roleButtons }
    );
    const bNoPanel = await ev(ub.page, async () => {
      const r = await window.NostrApp.GroupAdminProductUi.open('members');
      return { code: r.code, dialog: !!document.getElementById('sosAdminPinDialog') };
    });
    set('MEMBER_CANNOT_OPEN_CONTROL', bNoPanel.code === 'UNAUTHORIZED' && !bNoPanel.dialog, bNoPanel);

    // MANAGE_MEMBERS UX: accurate description; pending joins are read-only (admission is automatic).
    await openUi(ua.page, 'members');
    await domClick(ua.page, `#sosGapBody [data-act="select-member"][data-pk="${B.pub}"]`);
    await sleep(200);
    const mmHelp = await ev(ua.page, () => document.querySelector('#sosGapCaps input[data-cap="MANAGE_MEMBERS"]')?.closest('label')?.querySelector('.gap-cap-help')?.textContent || '');
    await ev(ua.page, () => document.querySelector('#sosGapMemberDetail [data-act="close-user"]')?.click());
    set('MANAGE_MEMBERS_DESCRIPTION', mmHelp === 'מאפשר להוסיף ולהסיר חברים קיימים מהקבוצה. לא מאפשר לשנות הרשאות.', { mmHelp });
    const pendingPk = mkKey().pub;
    const pending = await ev(ua.page, async (pk) => {
      const App = window.NostrApp;
      const real = App.FirstGroupAdmin;
      App.FirstGroupAdmin = Object.assign({}, real, { listPendingJoins: async () => ({ ok: true, rows: [{ memberPubkey: pk, inviteEventId: 'ab'.repeat(32), status: 'NONE' }] }) });
      try {
        document.querySelector('#sosGapBody [data-act="load-joins"]').click();
        for (let i = 0; i < 50 && !document.querySelector(`#sosGapJoinList [data-pending-pk="${pk}"]`); i++) await new Promise((r) => setTimeout(r, 100));
        const row = document.querySelector(`#sosGapJoinList [data-pending-pk="${pk}"]`);
        return {
          row: !!row,
          status: row ? row.querySelector('.gap-join-status')?.textContent || '' : '',
          buttonsInRow: row ? row.querySelectorAll('button').length : -1,
          approveAnywhere: document.querySelectorAll('#sosGroupAdminShell [data-act="approve-join"]').length,
          approveText: /אישור הצטרפות/.test(document.getElementById('sosGapBody')?.innerText || ''),
        };
      } finally {
        App.FirstGroupAdmin = real;
      }
    }, pendingPk);
    set('PENDING_JOIN_MANUAL_APPROVE_VISIBLE_FALSE', pending.approveAnywhere === 0 && pending.buttonsInRow === 0 && !pending.approveText, pending);
    set('PENDING_JOIN_READ_ONLY_STATUS', pending.row && pending.status === 'ממתין לאישור אוטומטי', pending);
    const manualApprove = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.approveJoin(pk, 'ab'.repeat(32))).code, pendingPk);
    set('ADMISSION_SERVICE_REQUIRED_PATH_UNCHANGED', manualApprove === 'ADMISSION_SERVICE_REQUIRED', { manualApprove });

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
    const inviteItemVisible = (page) =>
      ev(page, () => {
        window.NostrApp.GroupAdminProductUi.ensureMenuEntry();
        const el = document.getElementById('topBarInviteFriend');
        return !!el && !el.hidden && getComputedStyle(el).display !== 'none';
      });
    const topUi = async (page) => {
      const can = await ev(page, async () => {
        const App = window.NostrApp;
        await App.refreshInviteAuthority();
        return App.canCreateInviteUi();
      });
      return can === true && (await inviteItemVisible(page)) === true ? true : can === false && (await inviteItemVisible(page)) === false ? false : 'MISMATCH';
    };
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
    const bounded = (label, p, ms = 60000) =>
      Promise.race([p, sleep(ms).then(() => { throw new Error('TIMEOUT ' + label); })]).catch(async (e) => {
        const dlg = await aTabSwitch.evaluate(() => ({
          pinDialog: !!document.querySelector('#sosAdminPinDialog') && getComputedStyle(document.querySelector('#sosAdminPinDialog')).display !== 'none',
          pinText: (document.querySelector('#sosAdminPinDialog')?.textContent || '').slice(0, 80),
        })).catch(() => null);
        info('ACCOUNT_SWITCH_STEP_TIMEOUT', { label, error: String(e.message || e).slice(0, 120), dlg });
        return null;
      });
    trace('switch:goto');
    await aTabSwitch.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitApp(aTabSwitch);
    await aTabSwitch.waitForFunction((p) => String(window.NostrApp.publicKey || '').toLowerCase() === p, A.pub, { polling: 200, timeout: 30000 }).catch(() => {});
    trace('switch:reconcile');
    await bounded('reconcile', aTabSwitch.evaluate(async () => {
      window.NostrApp.guestMode = false;
      window.NostrApp.FirstGroupAdmin.boot();
      await window.NostrApp.FirstGroupNetworkAuthority.reconcile('switch-tab');
    }));
    trace('switch:pin');
    await bounded('pinReady', pinReady(aTabSwitch));
    trace('switch:open');
    await bounded('open-invites', aTabSwitch.evaluate(async () => {
      window.NostrApp.GroupAdminProductUi.ensureMenuEntry();
      await window.NostrApp.GroupAdminProductUi.open('invites');
    }));
    trace('switch:leak');
    const leak = (await bounded('switch-account', aTabSwitch.evaluate(async (kC) => {
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
    }, C.hex), 90000)) || { timeout: true };
    trace('switch:done');
    set('ACCOUNT_SWITCH', leak.pub === C.pub && !leak.menu && !leak.open && leak.invitesAfter === 0 && leak.codesInDom === 0 && leak.caps === 0 && leak.member === 'REMOVED' && leak.rootOp !== 'APPLIED', leak);
    await aTabSwitch.close();
    await boot(ua.page, A);

    // ================================================================ Phase 1 extension: moderation, block, unblock, private reports
    trace('phase1');
    const T = expectedWinner.who === 'D' ? D : E; // ordinary member, author of disposable content
    const tPage = expectedWinner.page;
    await pinReady(ua.page);
    await pinReady(ub.page);
    const dropToInviteOnly = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.setPermissions(pk, ['INVITE_USERS'])).code, B.pub);
    const bNoMod = await waitView(ub.page, B.pub, "v.caps.indexOf('MODERATE_CONTENT') === -1 && v.caps.indexOf('MANAGE_PERMISSIONS') === -1", 30000);
    info('P1_B_RESET', { dropToInviteOnly, ok: bNoMod.ok });

    // ---- direct add infrastructure (canonical GRANT_ACTIVE, Admin 2FA, no invite): kept as API; not offered in the default community UI
    const openDrawer = async (page, pk) => {
      await openUi(page, 'members');
      await ev(page, (p) => {
        const i = document.getElementById('sosGapUserSearch');
        if (!i) return;
        i.value = p;
        i.dispatchEvent(new Event('input', { bubbles: true }));
      }, pk);
      for (let i = 0; i < 3; i++) {
        const clicked = await domClick(page, `#sosGapSearchResults [data-act="select-member"][data-pk="${pk}"]`).then(() => true, () => false);
        if (!clicked) break;
        const opened = await page
          .waitForFunction((p) => document.getElementById('sosGapMemberDetail')?.getAttribute('data-pk') === p, pk, { polling: 100, timeout: 3000 })
          .then(() => true, () => false);
        if (opened) break;
      }
      await page.waitForFunction(() => {
        const n = document.getElementById('sosGapLegacyNote');
        return !n || n.getAttribute('data-known') !== 'checking';
      }, null, { polling: 200, timeout: 20000 }).catch(() => {});
      await sleep(200);
      return ev(page, () => {
        const d = document.getElementById('sosGapMemberDetail');
        const save = d?.querySelector('#sosGapSaveUser');
        return {
          pk: d?.getAttribute('data-pk') || '',
          text: d?.querySelector('.gap-who')?.innerText || '',
          known: d?.querySelector('#sosGapLegacyNote')?.getAttribute('data-known') || '',
          stateNote: d?.querySelector('#sosGapUserStateNote')?.textContent || '',
          addBtn: !!d?.querySelector('#sosGapAddMember'),
          confirmBtn: !!d?.querySelector('#sosGapConfirmMember'),
          inviteBtn: !!d?.querySelector('[data-act="invite-user"]'),
          save: !!save,
          saveEnabled: !!save && !save.disabled,
          permsTitle: Array.from(d?.querySelectorAll('h3') || []).some((h) => h.textContent.trim() === 'ניהול הרשאות'),
          remove: !!d?.querySelector('[data-act="remove-member"]'),
          block: !!d?.querySelector('[data-act="block-user"]'),
          unblock: !!d?.querySelector('[data-act="unblock-user"]'),
        };
      });
    };
    const closeDrawer = (page) => ev(page, () => document.querySelector('#sosGapMemberDetail [data-act="close-user"]')?.click());
    const invitesBeforeAdd = r1.all([37378]).length;
    const zBefore = await view(ua.page, Z.pub);
    const bAddDenied = await ev(ub.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.addMember(pk)).code, Z.pub);
    const zDrawerBefore = await openDrawer(ua.page, Z.pub);
    await closeDrawer(ua.page);
    const addApi = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.addMember(pk)).code, Z.pub);
    const zOnB = await waitView(ub.page, Z.pub, "v.member === 'ACTIVE'", 30000);
    const zAfter = await view(ub.page, Z.pub);
    const zDrawerAfter = await openDrawer(ua.page, Z.pub);
    await shot(ua.page, 'p1-direct-add-drawer');
    await closeDrawer(ua.page);
    const zProof = r1
      .all([39003])
      .filter((e) => e.pubkey === A.pub && e.tags.some((t) => t[0] === 'p' && t[1] === Z.pub))
      .map((e) => JSON.parse(e.content))
      .find((b) => b.transition === 'GRANT_ACTIVE');
    const invitesAfterAdd = r1.all([37378]).length;
    const zAgain = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.addMember(pk)).code, Z.pub);
    set(
      'DEFAULT_COMMUNITY_NO_ADD_BUTTON_FOR_UNREGISTERED',
      zBefore.member !== 'ACTIVE' && zDrawerBefore.pk === Z.pub && /לא חבר בקבוצה/.test(zDrawerBefore.text) && zDrawerBefore.known === '0' &&
        !zDrawerBefore.addBtn && !zDrawerBefore.confirmBtn && !zDrawerBefore.saveEnabled && !zDrawerBefore.inviteBtn,
      { zBefore: zBefore.member, zDrawerBefore }
    );
    set(
      'EXISTING_USER_DIRECT_ADD',
      /^ADDED/.test(addApi) && zOnB.ok && zAfter.member === 'ACTIVE' && zAgain === 'ALREADY_MEMBER' &&
        /חבר פעיל/.test(zDrawerAfter.text) && !zDrawerAfter.addBtn && zDrawerAfter.save && zDrawerAfter.remove && zDrawerAfter.block,
      { addApi, zOnB: zOnB.ok, zAgain, zDrawerAfter }
    );
    set('DIRECT_ADD_REQUIRES_MANAGE_MEMBERS', bAddDenied === 'UNAUTHORIZED', { bAddDenied });
    set('DIRECT_ADD_TARGET_BOUND', !!zProof && zProof.memberPubkey === Z.pub && zProof.groupId === GROUP && !zProof.inviteEventId && !zProof.admission, {
      proof: zProof ? { member: zProof.memberPubkey === Z.pub, group: zProof.groupId, invite: !!zProof.inviteEventId, admission: !!zProof.admission } : null,
    });
    set('DIRECT_ADD_NO_INVITE_NO_CAPS', invitesAfterAdd === invitesBeforeAdd && zAfter.assigned.length === 0 && zAfter.caps.length === 0, {
      invitesBeforeAdd,
      invitesAfterAdd,
      assigned: zAfter.assigned,
    });

    // ---- "כל המשתמשים": global SOS directory, legacy confirm / one-action permissions, REMOVED / BLOCKED never re-added
    trace('user-directory');
    const Q = mkKey(); // registered, then blocklisted
    const N = mkKey(); // email-registry for another network only (not an SOS account here)
    const PO = mkKey(); // legacy account with an SOS-published profile only
    const XU = mkKey(); // arbitrary Nostr key, nothing published
    const now = () => Math.floor(Date.now() / 1000);
    const regEvent = (k, network) =>
      finalizeEvent(
        {
          kind: 37377,
          created_at: now(),
          tags: [['d', crypto.randomBytes(16).toString('hex')], ['t', 'email-registry'], ['h', crypto.createHash('sha256').update(k.pub + '@qa.invalid').digest('hex')], ['t', network]],
          content: JSON.stringify({ issued_at: now() }),
        },
        k.sk
      );
    [regEvent(Y, GROUP), regEvent(Q, GROUP), regEvent(Z, GROUP), regEvent(N, 'community-other')].forEach(publishAll);
    publishAll(finalizeEvent({ kind: 0, created_at: now(), tags: [['t', GROUP]], content: JSON.stringify({ name: 'profile only' }) }, PO.sk));
    const qBlock = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.blockMember(pk)).code, Q.pub);
    const zRemove = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.removeMember(pk)).code, Z.pub);
    const zRemovedOnA = await waitView(ua.page, Z.pub, "v.member === 'REMOVED'", 30000);
    const yBefore = await view(ua.page, Y.pub);
    const poBefore = await view(ua.page, PO.pub);
    const bDenied = await ev(
      ub.page,
      async (a) => {
        const F = window.NostrApp.FirstGroupAdmin;
        return {
          list: (await F.listKnownUsers()).code,
          confirm: (await F.confirmLegacyMember(a.po)).code,
          save: (await F.savePermissions(a.y, ['MODERATE_CONTENT'])).code,
        };
      },
      { po: PO.pub, y: Y.pub }
    );

    // directory UI
    await openUi(ua.page, 'members');
    await sleep(800);
    await domClick(ua.page, '#sosGapDirRefresh').catch(() => {});
    await ua.page.waitForFunction(() => document.getElementById('sosGapDirCount')?.getAttribute('data-loaded') === '1', null, { polling: 200, timeout: 45000 }).catch(() => {});
    await sleep(300);
    const dirRows = () =>
      ev(ua.page, () =>
        Array.from(document.querySelectorAll('#sosGapMemberList [data-dir-pk]')).map((e) => ({
          pk: e.getAttribute('data-dir-pk'),
          status: e.getAttribute('data-dir-status'),
          badge: e.querySelector('.gap-chip')?.textContent.trim() || '',
          name: e.querySelector('.gap-user-name')?.textContent.trim() || '',
          avatar: !!e.querySelector('.gap-avatar, img, [class*="avatar"]'),
          short: e.querySelector('.gap-mono')?.textContent.trim() || '',
        }))
      );
    const dirAll = await dirRows();
    await shot(ua.page, 'p1-directory-all');
    const byPk = new Map(dirAll.map((r) => [r.pk, r]));
    const filterRows = async (id) => {
      await domClick(ua.page, `#sosGapDirFilters [data-filter="${id}"]`);
      await sleep(250);
      return dirRows();
    };
    const fLegacy = await filterRows('LEGACY');
    const fBlocked = await filterRows('BLOCKED');
    const fRemoved = await filterRows('REMOVED');
    const fActive = await filterRows('ACTIVE');
    await filterRows('ALL');
    await ev(ua.page, (q) => {
      const i = document.getElementById('sosGapDirSearch');
      i.value = q;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }, 'profile only');
    await sleep(250);
    const searchByName = await dirRows();
    await ev(ua.page, (q) => {
      const i = document.getElementById('sosGapDirSearch');
      i.value = q;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }, Y.pub);
    await sleep(250);
    const searchByPk = await dirRows();
    await ev(ua.page, () => {
      const i = document.getElementById('sosGapDirSearch');
      i.value = '';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const filterLabels = await ev(ua.page, () => Array.from(document.querySelectorAll('#sosGapDirFilters [data-filter]')).map((b) => b.textContent.trim()));
    const tabLabel = await ev(ua.page, () => document.querySelector('#sosGapTabs [data-tab="members"]')?.textContent.trim() || '');

    // drawers before any change
    const poDrawer = await openDrawer(ua.page, PO.pub);
    await shot(ua.page, 'p1-legacy-drawer');
    await closeDrawer(ua.page);
    const nDrawer = await openDrawer(ua.page, N.pub);
    await closeDrawer(ua.page);
    const xDrawer = await openDrawer(ua.page, XU.pub);
    await closeDrawer(ua.page);
    const zRemDrawer = await openDrawer(ua.page, Z.pub);
    await closeDrawer(ua.page);
    const qDrawer = await openDrawer(ua.page, Q.pub);
    await closeDrawer(ua.page);

    // PO: "אישור כחבר" → plain member, no capability, no invite authority
    const grantsFor = (pk) =>
      r1
        .all([39003])
        .map((e) => ({ e, b: JSON.parse(e.content) }))
        .filter((x) => x.e.pubkey === A.pub && x.b.memberPubkey === pk && x.b.transition === 'GRANT_ACTIVE');
    const invitesBeforeDir = r1.all([37378]).length;
    await openDrawer(ua.page, PO.pub);
    const poConfirmUi = await actConfirm(ua.page, '#sosGapConfirmMember').catch((e) => ({ ok: false, text: String(e.message || e).slice(0, 80) }));
    const poOnB = await waitView(ub.page, PO.pub, "v.member === 'ACTIVE'", 30000);
    const poAfter = await view(ub.page, PO.pub);
    const poInviteUi = await ev(ub.page, (pk) => {
      const F = window.NostrApp.FirstGroupAdmin;
      const a = F.authorityFor(pk);
      return { invite: a.caps.indexOf('INVITE_USERS') !== -1, role: a.role };
    }, PO.pub);
    await closeDrawer(ua.page);

    // Y: legacy (registered) → "ניהול הרשאות" save with MODERATE_CONTENT: membership + exactly that capability in one owner action
    const yDrawerBefore = await openDrawer(ua.page, Y.pub);
    await domClick(ua.page, '#sosGapMemberDetail input[data-cap="MODERATE_CONTENT"]');
    const ySaveUi = await actConfirm(ua.page, '#sosGapSaveUser').catch((e) => ({ ok: false, text: String(e.message || e).slice(0, 80) }));
    const yOnB = await waitView(ub.page, Y.pub, "v.member === 'ACTIVE' && v.caps.indexOf('MODERATE_CONTENT') !== -1", 45000);
    const yAfter = await view(ub.page, Y.pub);
    await closeDrawer(ua.page);
    const yDrawer = await openDrawer(ua.page, Y.pub);
    await closeDrawer(ua.page);

    // rejections and idempotency (API, same paths as the UI)
    const rej = await ev(
      ua.page,
      async (k) => {
        const F = window.NostrApp.FirstGroupAdmin;
        return {
          zConfirm: (await F.confirmLegacyMember(k.z)).code,
          zSave: (await F.savePermissions(k.z, ['MODERATE_CONTENT'])).code,
          qConfirm: (await F.confirmLegacyMember(k.q)).code,
          qSave: (await F.savePermissions(k.q, ['MODERATE_CONTENT'])).code,
          nConfirm: (await F.confirmLegacyMember(k.n)).code,
          nSave: (await F.savePermissions(k.n, ['MODERATE_CONTENT'])).code,
          xConfirm: (await F.confirmLegacyMember(k.x)).code,
          poAgain: (await F.confirmLegacyMember(k.po)).code,
          rootConfirm: (await F.confirmLegacyMember(k.root)).code,
        };
      },
      { z: Z.pub, q: Q.pub, n: N.pub, x: XU.pub, po: PO.pub, root: A.pub }
    );
    await sleep(500);
    const zAfter2 = await view(ub.page, Z.pub);
    const qState = await ev(ub.page, (pk) => {
      const App = window.NostrApp;
      const st = App.GroupControlState.getVerifiedControlState('israel-network') || {};
      return { member: App.MembershipState.getMemberState(pk, 'israel-network'), listed: (st.blockedPubkeys || []).includes(pk), caps: App.FirstGroupAdmin.authorityFor(pk).caps.length };
    }, Q.pub);
    const nState = await view(ub.page, N.pub);
    const xState = await view(ub.page, XU.pub);
    const invitesAfterDir = r1.all([37378]).length;
    info('P1_USER_DIRECTORY', {
      qBlock,
      zRemove,
      bDenied,
      dirCount: dirAll.length,
      statuses: { y: byPk.get(Y.pub)?.status, po: byPk.get(PO.pub)?.status, q: byPk.get(Q.pub)?.status, z: byPk.get(Z.pub)?.status, n: !!byPk.get(N.pub), x: !!byPk.get(XU.pub) },
      poConfirmUi,
      ySaveUi,
      rej,
    });
    set('ALL_USERS_TAB_LABEL', tabLabel === 'כל המשתמשים', { tabLabel });
    set('ALL_USERS_DIRECTORY_VISIBLE', dirAll.length >= 5 && !!byPk.get(A.pub) && byPk.get(A.pub).status === 'ROOT', { count: dirAll.length, root: byPk.get(A.pub)?.status });
    set(
      'DIRECTORY_STATUSES',
      byPk.get(Y.pub)?.status === 'LEGACY' && byPk.get(PO.pub)?.status === 'LEGACY' && byPk.get(Q.pub)?.status === 'BLOCKED' && byPk.get(Z.pub)?.status === 'REMOVED' &&
        byPk.get(Y.pub)?.badge === 'חשבון ותיק' && byPk.get(Q.pub)?.badge === 'חסום' && byPk.get(Z.pub)?.badge === 'הוסר' &&
        dirAll.filter((r) => r.status === 'ACTIVE').every((r) => r.badge === 'חבר פעיל'),
      { y: byPk.get(Y.pub), po: byPk.get(PO.pub), q: byPk.get(Q.pub), z: byPk.get(Z.pub) }
    );
    set('DIRECTORY_EXCLUDES_ARBITRARY_KEYS', !byPk.get(N.pub) && !byPk.get(XU.pub), { n: !!byPk.get(N.pub), x: !!byPk.get(XU.pub) });
    set(
      'DIRECTORY_NO_TECHNICAL_TERMS',
      dirAll.every((r) => !/registration|GRANT_ACTIVE|membership|record/i.test(r.badge + r.name)) && dirAll.every((r) => r.short.length > 0 && r.short.length < 30),
      { sample: dirAll.slice(0, 3).map((r) => r.short) }
    );
    set('PROFILE_NAME_AND_AVATAR_VISIBLE', byPk.get(PO.pub)?.name === 'profile only' && dirAll.every((r) => r.avatar), { po: byPk.get(PO.pub)?.name });
    set(
      'DIRECTORY_FILTERS',
      JSON.stringify(filterLabels) === JSON.stringify(['הכל', 'חברים פעילים', 'חשבונות ותיקים', 'חסומים', 'הוסרו']) &&
        fLegacy.length >= 2 && fLegacy.every((r) => r.status === 'LEGACY') && fLegacy.some((r) => r.pk === PO.pub) && fLegacy.some((r) => r.pk === Y.pub) &&
        fBlocked.every((r) => r.status === 'BLOCKED') && fBlocked.some((r) => r.pk === Q.pub) &&
        fRemoved.every((r) => r.status === 'REMOVED') && fRemoved.some((r) => r.pk === Z.pub) &&
        fActive.every((r) => r.status === 'ACTIVE' || r.status === 'ROOT') && !fActive.some((r) => r.pk === Q.pub || r.pk === Z.pub),
      { filterLabels, legacy: fLegacy.length, blocked: fBlocked.length, removed: fRemoved.length, active: fActive.length }
    );
    set('DIRECTORY_SEARCH', searchByName.length >= 1 && searchByName.every((r) => r.pk === PO.pub) && searchByPk.length === 1 && searchByPk[0].pk === Y.pub, {
      byName: searchByName.length,
      byPk: searchByPk.length,
    });
    set(
      'OLD_USER_MANAGE_PANEL_VISIBLE',
      poDrawer.known === '1' && /חשבון ותיק/.test(poDrawer.text) && poDrawer.confirmBtn && poDrawer.saveEnabled && poDrawer.permsTitle && !poDrawer.remove && poDrawer.block && !poDrawer.addBtn,
      poDrawer
    );
    set('UNKNOWN_KEY_NOT_ADDABLE', nDrawer.known === '0' && !nDrawer.confirmBtn && !nDrawer.saveEnabled && !nDrawer.addBtn && xDrawer.known === '0' && !xDrawer.confirmBtn && !xDrawer.saveEnabled, { nDrawer, xDrawer });
    set('REMOVED_DRAWER_NO_AUTO_REACTIVATE', /הוסר/.test(zRemDrawer.text) && /לא יצורף מחדש אוטומטית/.test(zRemDrawer.stateNote) && !zRemDrawer.confirmBtn && !zRemDrawer.save, zRemDrawer);
    set('BLOCKED_DRAWER_UNBLOCK_ONLY', /חסום/.test(qDrawer.text) && qDrawer.unblock && !qDrawer.confirmBtn && !qDrawer.save && !qDrawer.remove, qDrawer);
    set(
      'LEGACY_CONFIRM_GRANTS_ACTIVE_NO_CAPS',
      poBefore.member === 'UNKNOWN' && poConfirmUi.ok && poOnB.ok && poAfter.member === 'ACTIVE' && poAfter.assigned.length === 0 && poAfter.caps.length === 0 && grantsFor(PO.pub).length === 1,
      { poBefore: poBefore.member, poConfirmUi, poAfter: { member: poAfter.member, caps: poAfter.caps }, grants: grantsFor(PO.pub).length }
    );
    set('MEMBERSHIP_DOES_NOT_GRANT_INVITE', !poInviteUi.invite && poInviteUi.role === 'MEMBER' && invitesAfterDir === invitesBeforeDir, { poInviteUi, invitesBeforeDir, invitesAfterDir });
    set(
      'OLD_ACTIVE_USER_CAN_RECEIVE_PERMISSIONS',
      yBefore.member === 'UNKNOWN' && yDrawerBefore.saveEnabled && ySaveUi.ok && yOnB.ok && yAfter.member === 'ACTIVE' &&
        JSON.stringify(yAfter.assigned) === JSON.stringify(['MODERATE_CONTENT']) && yAfter.caps.indexOf('INVITE_USERS') === -1 && grantsFor(Y.pub).length === 1,
      { yBefore: yBefore.member, ySaveUi, yAfter: { member: yAfter.member, assigned: yAfter.assigned, caps: yAfter.caps }, grants: grantsFor(Y.pub).length }
    );
    set('PERMISSIONS_DEPEND_ON_INVITE_HISTORY_FALSE', yOnB.ok && poOnB.ok && !r1.all([37379]).some((e) => e.pubkey === Y.pub || e.pubkey === PO.pub), { y: yOnB.ok, po: poOnB.ok });
    set(
      'LEGACY_REJECTS_REMOVED_BLOCKED_UNKNOWN_ROOT',
      rej.zConfirm === 'TARGET_REMOVED' && rej.zSave === 'TARGET_REMOVED' && rej.qConfirm === 'TARGET_BLOCKED' && rej.qSave === 'TARGET_BLOCKED' &&
        rej.nConfirm === 'NOT_KNOWN_SOS_ACCOUNT' && rej.nSave === 'NOT_KNOWN_SOS_ACCOUNT' && rej.xConfirm === 'NOT_KNOWN_SOS_ACCOUNT' && rej.rootConfirm === 'ROOT_PROTECTED' &&
        zRemovedOnA.ok && zAfter2.member === 'REMOVED' && zAfter2.caps.length === 0 && qState.listed && qState.member !== 'ACTIVE' && qState.caps === 0 &&
        nState.member !== 'ACTIVE' && xState.member !== 'ACTIVE' && grantsFor(Z.pub).length === 1 && grantsFor(Q.pub).length === 0 && grantsFor(N.pub).length === 0 && grantsFor(XU.pub).length === 0,
      { rej, z: zAfter2.member, q: qState, n: nState.member, x: xState.member }
    );
    set('LEGACY_CONFIRM_IDEMPOTENT', rej.poAgain === 'ALREADY_MEMBER' && grantsFor(PO.pub).length === 1, { poAgain: rej.poAgain });
    set('LEGACY_REQUIRES_AUTHORITY', bDenied.list === 'UNAUTHORIZED' && bDenied.confirm === 'UNAUTHORIZED' && bDenied.save === 'UNAUTHORIZED', bDenied);
    set('REGISTERED_MEMBER_DRAWER', /חבר פעיל/.test(yDrawer.text) && !yDrawer.addBtn && !yDrawer.confirmBtn && yDrawer.save && yDrawer.remove && yDrawer.block, yDrawer);

    // ---- invite lifecycle: 24h single-use invites; lifecycle list with statuses
    const lcInv = await ev(ua.page, async () => {
      const F = window.NostrApp.FirstGroupAdmin;
      const lc = await F.listInviteLifecycle();
      const rows = lc.ok ? lc.rows : [];
      return {
        ok: lc.ok,
        scope: lc.scope,
        counts: lc.counts,
        rows: rows.length,
        maxTtl: rows.reduce((m, r) => Math.max(m, r.expiresAt - r.createdAt), 0),
        allSingleUse: rows.every((r) => r.singleUse === true),
        noCodes: rows.every((r) => !('code' in r) && !('inviteCode' in r)),
      };
    });
    const tagTtls = r1.all([37378]).map((e) => Number((e.tags.find((t) => t[0] === 'expiration') || [])[1]) - e.created_at);
    const tagTtl = tagTtls.length ? Math.max(...tagTtls) : 0;
    await openUi(ua.page, 'invites');
    await ua.page.waitForFunction(() => !!document.querySelector('#sosGapInviteList') && !!document.querySelector('#sosGapInviteHistory'), null, { timeout: 30000 }).catch(() => {});
    const invUi = await ev(ua.page, () => ({
      active: document.querySelectorAll('#sosGapInviteList [data-invite-status="ACTIVE"]').length,
      history: Array.from(document.querySelectorAll('#sosGapInviteHistory [data-invite-status]')).map((e) => e.getAttribute('data-invite-status')),
      collapsed: document.getElementById('sosGapInviteHistory')?.open === false,
      labels: (document.getElementById('sosGapInviteHistory')?.innerText || '').match(/נוצלה|פגה|בוטלה/g) || [],
      revokeBtn: !!document.querySelector('#sosGapInviteList [data-act="revoke-invite"]'),
    }));
    await shot(ua.page, 'p1-invite-lifecycle');
    set(
      'INVITE_LIFECYCLE_24H_SINGLE_USE',
      lcInv.ok && lcInv.scope === 'GROUP' && lcInv.rows > 0 && lcInv.counts.ACTIVE >= 1 && lcInv.maxTtl <= 86400 && lcInv.allSingleUse && tagTtl > 0 && tagTtl <= 86400 && lcInv.noCodes,
      Object.assign({ tagTtl }, lcInv)
    );
    set('INVITE_STATUS_UI', invUi.active >= 1 && invUi.revokeBtn && invUi.collapsed && invUi.history.includes('USED') && invUi.history.includes('REVOKED'), invUi);
    report.INVITE_LIFECYCLE_COUNTS = lcInv.counts;
    const P1 = await publishNote(tPage, 'p1 disposable post ' + Date.now());
    const C1 = await publishNote(tPage, 'p1 disposable comment ' + Date.now(), P1.id);
    const P2 = await publishNote(tPage, 'p1 disposable post two ' + Date.now());
    const noCap = await modRemove(ub.page, P1);
    const grantMod = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.grantCapability(pk, 'MODERATE_CONTENT')).code, B.pub);
    const bMod2 = await waitView(ub.page, B.pub, "v.caps.indexOf('MODERATE_CONTENT') !== -1", 30000);
    const bModMenu = await ev(ub.page, async () => {
      const ui = window.NostrApp.GroupAdminProductUi;
      ui.ensureMenuEntry();
      const direct = await ui.open('members');
      const item = (id) => {
        const el = document.getElementById(id);
        return !!el && !el.hidden && el.style.display !== 'none';
      };
      return { control: ui.canSeeGroupAdminMenu(), controlItem: item('sosGroupControlMenuItem'), reportsItem: item('sosGroupReportsMenuItem'), direct: direct.code };
    });
    await ev(ub.page, () => window.NostrApp.GroupAdminProductUi.openReports());
    await ub.page.waitForFunction(() => window.NostrApp.GroupAdminProductUi.isOpen(), null, { timeout: 20000 }).catch(() => {});
    await sleep(300);
    const bModTabs = await visibleTabs(ub.page);
    await shot(ub.page, 'p1-moderator-tabs');
    const modPost = await modRemove(ub.page, P1);
    const modComment = await modRemove(ub.page, C1);
    await sleep(800);
    const modTargetSeen = (t) => r1.all([39002]).some((m) => (m.tags || []).some((x) => (x[0] === 'd' || x[0] === 'e') && x[1] === t.id));
    for (let i = 0; i < 20 && !(modTargetSeen(P1) && modTargetSeen(C1)); i++) await sleep(500);
    const modEvents = r1.all([39002]);
    const obsVerdicts = await ev(
      ua.page,
      async ({ mods, p1, c1 }) => {
        const MP = window.NostrApp.ModerationPolicy;
        const pick = (t) => mods.find((m) => (m.tags || []).some((x) => (x[0] === 'd' || x[0] === 'e') && x[1] === t.id));
        const vp = pick(p1);
        const vc = pick(c1);
        const check = () => ({
          p: vp ? MP.validateModerationEvent(vp, p1, null) : { ok: false, code: 'NOT_FOUND' },
          c: vc ? MP.validateModerationEvent(vc, c1, null) : { ok: false, code: 'NOT_FOUND' },
        });
        let r = check();
        for (let i = 0; i < 20 && !(r.p.ok && r.c.ok); i++) {
          await new Promise((res) => setTimeout(res, 500));
          r = check();
        }
        return { post: r.p.ok, comment: r.c.ok, postCode: r.p.code || null, commentCode: r.c.code || null };
      },
      { mods: modEvents, p1: P1, c1: C1 }
    );
    const bLocal = await ev(ub.page, ({ p, c }) => ({ p: window.NostrApp.deletedEventIds.has(p), c: window.NostrApp.deletedEventIds.has(c) }), { p: P1.id, c: C1.id });
    set('MODERATE_POST_DELETE', !noCap.ok && grantMod === 'APPLIED' && bMod2.ok && modPost.ok && obsVerdicts.post && bLocal.p, { noCap, grantMod, modPost, obs: obsVerdicts.post, code: obsVerdicts.postCode });
    set('MODERATE_COMMENT_DELETE', modComment.ok && obsVerdicts.comment && bLocal.c, { modComment, obs: obsVerdicts.comment, code: obsVerdicts.commentCode });
    set(
      'MODERATOR_PANEL_REPORTS_ONLY',
      !bModMenu.control && !bModMenu.controlItem && bModMenu.reportsItem && bModMenu.direct === 'UNAUTHORIZED' && JSON.stringify(bModTabs) === JSON.stringify(['reports']),
      { bModMenu, bModTabs }
    );
    await ev(ub.page, () => window.NostrApp.GroupAdminProductUi.close());
    const revokeMod = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.revokeCapability(pk, 'MODERATE_CONTENT')).code, B.pub);
    const bLostMod = await waitView(ub.page, B.pub, "v.caps.indexOf('MODERATE_CONTENT') === -1", 30000);
    const afterRevoke = await modRemove(ub.page, P2);
    const ownDelete = await tPage.evaluate(async (p) => {
      const App = window.NostrApp;
      App.postsById.set(p.id, p);
      App.eventAuthorById.set(p.id, p.pubkey);
      const can = App.canViewerDeletePost(p.id) === true;
      await App.deletePostQuiet(p.id);
      return { can };
    }, P2);
    await sleep(800);
    const kind5 = r1.all([5]).some((e) => e.pubkey === T.pub && e.tags.some((t) => t[0] === 'e' && t[1] === P2.id));
    set('MODERATE_CONTENT_REVOKE', revokeMod === 'APPLIED' && bLostMod.ok && !afterRevoke.ok, { revokeMod, ms: bLostMod.ms, afterRevoke });
    set('OWN_CONTENT_DELETE_STILL_ALLOWED', ownDelete.can && kind5, { ownDelete, kind5 });
    report.MODERATION_PERMISSION_PROPAGATION = bMod2.ok && bLostMod.ok ? 'LIVE' : 'BROKEN';

    // ---- Phase 1 consistency: menus per persona, moderator delete through the content UI, cross-client hiding
    trace('p1-consistency');
    const um = await newProfile('USER_Y_MOD', { persistent: false });
    um.dialogs = [];
    um.page.on('dialog', (d) => {
      um.dialogs.push(d.type() + ':' + d.message().slice(0, 80));
      d.accept().catch(() => {});
    });
    await um.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await bootIdentity(um.page, Y);
    const yReady = await waitView(um.page, Y.pub, "v.member === 'ACTIVE' && v.caps.indexOf('MODERATE_CONTENT') !== -1", 45000);
    const ug = await newProfile('GUEST_VIEW', { persistent: false });
    await ug.page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitApp(ug.page);
    const PS = await publishNote(tPage, 'p1c probe post ' + Date.now());
    const persona = (page, probeId, probeAuthor) =>
      ev(
        page,
        async ({ probeId, author }) => {
          const App = window.NostrApp;
          const ui = App.GroupAdminProductUi;
          ui.ensureMenuEntry();
          const vis = (id) => {
            const el = document.getElementById(id);
            return !!el && !el.hidden && getComputedStyle(el).display !== 'none';
          };
          let btn = document.getElementById('p1cModProbe');
          if (!btn) {
            btn = document.createElement('button');
            btn.id = 'p1cModProbe';
            document.body.appendChild(btn);
          }
          btn.setAttribute('data-mod-delete', probeId);
          App.eventAuthorById.set(probeId, author);
          App.syncModerationControls();
          const canOpen = ui.canSeeGroupControl();
          const direct = canOpen ? null : await ui.open('members');
          return {
            INVITE_MENU_VISIBLE: vis('topBarInviteFriend'),
            GROUP_CONTROL_MENU_VISIBLE: vis('sosGroupControlMenuItem'),
            REPORTS_MENU_VISIBLE: vis('sosGroupReportsMenuItem'),
            MODERATOR_DELETE_VISIBLE: !btn.hidden && btn.style.display !== 'none',
            CAN_OPEN_GROUP_CONTROL: canOpen,
            DIRECT_OPEN: direct ? direct.code + (ui.isOpen() ? ':OPEN' : '') : 'ALLOWED',
            CAN_CREATE_INVITE: App.canCreateInviteUi() === true,
            CAN_MODERATE_CONTENT: App.canViewerDeletePost(probeId) === true,
          };
        },
        { probeId, author: probeAuthor || T.pub }
      );
    const expect = (p, inv, ctl, mod) =>
      p.INVITE_MENU_VISIBLE === inv && p.CAN_CREATE_INVITE === inv && p.GROUP_CONTROL_MENU_VISIBLE === ctl && p.CAN_OPEN_GROUP_CONTROL === ctl &&
      p.MODERATOR_DELETE_VISIBLE === mod && p.CAN_MODERATE_CONTENT === mod && (ctl || p.DIRECT_OPEN === 'UNAUTHORIZED');
    const personas = {};
    personas.MODERATE_CONTENT_ONLY = await persona(um.page, PS.id);

    // moderator deletes another member's post and comment through the content UI (confirm + first-time PIN setup)
    const PM = await publishNote(tPage, 'p1c moderator target post ' + Date.now());
    const CM = await publishNote(tPage, 'p1c moderator target comment ' + Date.now(), PM.id);
    const arrived = await um.page
      .waitForFunction(({ p, c }) => window.NostrApp.postsById.has(p) && window.NostrApp.listVisibleComments(p).some((x) => x.id === c), { p: PM.id, c: CM.id }, { polling: 300, timeout: 20000 })
      .then(() => true, () => false);
    if (!arrived) {
      await ev(um.page, ({ p, c }) => {
        const App = window.NostrApp;
        App.postsById.set(p.id, p);
        App.eventAuthorById.set(p.id, p.pubkey);
        App.registerComment(c, p.id);
      }, { p: PM, c: CM });
    }
    for (const p of [ub.page, ug.page]) {
      await ev(p, ({ p, c }) => {
        const App = window.NostrApp;
        if (!App.postsById.has(p.id)) App.postsById.set(p.id, p);
        App.eventAuthorById.set(p.id, p.pubkey);
        App.registerComment(c, p.id);
      }, { p: PM, c: CM });
    }
    const fillPinSetup = async (page) => {
      const shown = await page.waitForSelector('#sosAdminPinNew', { timeout: 30000 }).then(() => true, () => false);
      if (!shown) return false;
      await page.fill('#sosAdminPinNew', TEST_PIN);
      await page.fill('#sosAdminPinConfirm', TEST_PIN);
      await page.click('#sosAdminPinOk');
      return true;
    };
    const uiDeletePost = um.page.evaluate((id) => window.NostrApp.deletePost(id).then((r) => (r ? { ok: r.ok, code: r.code } : null)), PM.id);
    const pinSetupShown = await fillPinSetup(um.page);
    const modPostRes = await uiDeletePost;
    const modCommentRes = await um.page.evaluate(({ c, p }) => window.NostrApp.deleteComment(c, p).then((r) => (r ? { ok: r.ok, code: r.code } : null)), { c: CM.id, p: PM.id });
    const relayTrace = (target, by) => {
      const mods = allRelays.map((r) => r.all([39002]).filter((m) => m.pubkey === by && m.tags.some((t) => t[0] === 'd' && t[1] === target.id)));
      const mod = mods.flat()[0] || null;
      const att = mod ? r1.all([39004]).find((a) => a.tags.some((t) => t[0] === 'e' && t[1] === mod.id)) : null;
      let ops = [];
      try {
        ops = att ? JSON.parse(att.content).operations || [] : [];
      } catch (_e) {}
      return {
        EVENT_KIND: mod ? mod.kind : null,
        OPERATION: mod ? (target.tags.some((t) => t[0] === 'e') ? 'DELETE_COMMENT' : 'DELETE_POST') : null,
        ATTESTATION_OPERATION: ops.join(',') || null,
        RELAY_ACKS: mods.filter((m) => m.length > 0).length,
      };
    };
    for (let i = 0; i < 20 && !(relayTrace(PM, Y.pub).EVENT_KIND && relayTrace(CM, Y.pub).EVENT_KIND); i++) await sleep(300);
    const hiddenOn = (page, ids) =>
      page
        .waitForFunction(
          ({ p, c }) => {
            const App = window.NostrApp;
            const sel = (s) => Array.from(document.querySelectorAll(s)).some((el) => el.offsetParent !== null);
            return (
              App.deletedEventIds.has(p) && App.deletedEventIds.has(c) && !App.postsById.has(p) && !App.listVisibleComments(p).some((x) => x.id === c) &&
              !sel('[data-post-id="' + p + '"]') && !sel('[data-comment-id="' + c + '"]')
            );
          },
          ids,
          { polling: 300, timeout: 30000 }
        )
        .then(() => true, () => false);
    const delIds = { p: PM.id, c: CM.id };
    const viewerLive = await hiddenOn(ub.page, delIds);
    const guestLive = await hiddenOn(ug.page, delIds);
    const suppression = await ev(ub.page, ({ p, c }) => [p, c].map((id) => (window.NostrApp.deletionTombstones.get(id) || {}).source || ''), delIds);
    const modEvPost = allRelays.map((r) => r.all([39002]).find((m) => m.pubkey === Y.pub && m.tags.some((t) => t[0] === 'd' && t[1] === PM.id))).find(Boolean) || null;
    const attFor = (m) => (m ? r1.all([39004]).find((a) => a.tags.some((t) => t[0] === 'e' && t[1] === m.id)) || null : null);
    const viewerDiag = await ev(ub.page, ({ m, att, p }) => {
      const App = window.NostrApp;
      const MP = App.ModerationPolicy;
      const A = App.Admin2faProtocol;
      const target = App.postsById.get(p.id) || null;
      const out = {
        seen: !!(m && App._seenModerationEventIds instanceof Set && App._seenModerationEventIds.has(m.id)),
        enforced: !!(A && A.isEnforced()),
        targetSigned: !!(target && target.sig),
        verdictNow: m && MP ? MP.validateModerationEvent(m, target && Array.isArray(target.tags) ? target : p, null).code : 'NO_EVENT',
      };
      if (m && att && A) {
        out.ingest = !!A.ingestAttestations([att]);
        out.verdictAfterIngest = MP.validateModerationEvent(m, p, null).code;
      }
      return out;
    }, { m: modEvPost, att: attFor(modEvPost), p: PM }).catch((e) => ({ error: String(e.message || e).slice(0, 120) }));
    await hardReload(ub.page, B);
    const viewerAfterRefresh = await hiddenOn(ub.page, delIds);
    await ug.page.reload({ waitUntil: 'domcontentloaded' });
    await waitApp(ug.page);
    const guestAfterRefresh = await ug.page
      .waitForFunction(({ p, c }) => window.NostrApp.deletedEventIds.has(p) && window.NostrApp.deletedEventIds.has(c), delIds, { polling: 300, timeout: 45000 })
      .then(() => true, () => false);
    const modTrace = { post: relayTrace(PM, Y.pub), comment: relayTrace(CM, Y.pub) };
    report.MODERATOR_DELETE_TRACE = { pinSetupShown, targetArrivedLive: arrived, post: modPostRes, comment: modCommentRes, relay: modTrace, suppression, viewerDiag, dialogs: um.dialogs.slice() };

    // the same UI path for ROOT
    const PR = await publishNote(tPage, 'p1c root target post ' + Date.now());
    await ev(ua.page, (p) => {
      const App = window.NostrApp;
      if (!App.postsById.has(p.id)) App.postsById.set(p.id, p);
      App.eventAuthorById.set(p.id, p.pubkey);
    }, PR);
    ua.page.once('dialog', (d) => d.accept().catch(() => {}));
    const rootRes = await ua.page.evaluate((id) => window.NostrApp.deletePost(id).then((r) => (r ? { ok: r.ok, code: r.code } : null)), PR.id);
    for (let i = 0; i < 20 && !relayTrace(PR, A.pub).EVENT_KIND; i++) await sleep(300);
    const rootTrace = relayTrace(PR, A.pub);
    const rootHidden = await ub.page
      .waitForFunction((p) => window.NostrApp.deletedEventIds.has(p), PR.id, { polling: 300, timeout: 30000 })
      .then(() => true, () => false);
    report.ROOT_DELETE_TRACE = { result: rootRes, relay: rootTrace, viewerHidden: rootHidden };

    // a failed publish changes nothing locally and tells the moderator
    const PF = await publishNote(tPage, 'p1c publish-failure target ' + Date.now());
    const failRes = await um.page.evaluate(async (p) => {
      const App = window.NostrApp;
      App.postsById.set(p.id, p);
      App.eventAuthorById.set(p.id, p.pubkey);
      const real = App.pool.publish;
      const realToast = App.showToast;
      const notices = [];
      App.pool.publish = (relays) => relays.map(() => Promise.reject(new Error('relay down')));
      if (typeof realToast === 'function') App.showToast = (t, ...rest) => (notices.push(String(t)), realToast.call(App, t, ...rest));
      let r;
      try {
        r = await App.deletePost(p.id);
      } finally {
        App.pool.publish = real;
        if (typeof realToast === 'function') App.showToast = realToast;
      }
      notices.forEach((t) => window.__p1Notices && window.__p1Notices.push(t));
      window.__p1LastNotices = notices;
      const tomb = JSON.stringify(Object.entries(localStorage).filter(([k]) => /tomb|delet/i.test(k)).map(([, v]) => v));
      return { code: r && r.code, ok: !!(r && r.ok), localHidden: App.deletedEventIds.has(p.id), stillPresent: App.postsById.has(p.id), persisted: tomb.includes(p.id), notices };
    }, PF);
    const failAlert = um.dialogs.some((d) => /^alert:.*לא נשמרה/.test(d)) || (failRes.notices || []).some((t) => /לא נשמרה/.test(t));
    await hardReload(um.page, Y).catch(() => {});
    const failAfterReload = await ev(um.page, (id) => window.NostrApp.deletedEventIds.has(id), PF.id);
    const pfOnRelay = r1.all([39002]).some((m) => m.tags.some((t) => t[0] === 'd' && t[1] === PF.id));

    set('ROOT_DELETE_CANONICAL', !!(rootRes && rootRes.ok) && rootTrace.EVENT_KIND === 39002 && rootTrace.ATTESTATION_OPERATION === 'DELETE_OTHER_USER_POST' && rootTrace.RELAY_ACKS >= 1 && rootHidden, report.ROOT_DELETE_TRACE);
    set(
      'MODERATOR_POST_DELETE_CANONICAL',
      pinSetupShown && !!(modPostRes && modPostRes.ok) && modTrace.post.EVENT_KIND === 39002 && modTrace.post.ATTESTATION_OPERATION === 'DELETE_OTHER_USER_POST' && modTrace.post.RELAY_ACKS >= 1,
      { pinSetupShown, modPostRes, trace: modTrace.post }
    );
    set(
      'MODERATOR_COMMENT_DELETE_CANONICAL',
      !!(modCommentRes && modCommentRes.ok) && modTrace.comment.EVENT_KIND === 39002 && modTrace.comment.ATTESTATION_OPERATION === 'DELETE_OTHER_USER_COMMENT' && modTrace.comment.RELAY_ACKS >= 1,
      { modCommentRes, trace: modTrace.comment }
    );
    set('MODERATOR_DELETE_HIDDEN_OTHER_CLIENTS', viewerLive && guestLive && suppression.every((s) => s === 'moderation'), { viewerLive, guestLive, suppression });
    set('MODERATOR_DELETE_SURVIVES_REFRESH', viewerAfterRefresh && guestAfterRefresh, { viewerAfterRefresh, guestAfterRefresh });
    set(
      'MODERATOR_DELETE_FAILURE_RESTORES',
      !failRes.ok && !failRes.localHidden && failRes.stillPresent && !failRes.persisted && failAlert && !failAfterReload && !pfOnRelay,
      { failRes, failAlert, failAfterReload, pfOnRelay }
    );
    report.MODERATOR_DELETE_LOCAL_ONLY = !(modTrace.post.RELAY_ACKS >= 1 && modTrace.comment.RELAY_ACKS >= 1 && viewerLive && guestLive);

    // live persona changes on the same moderator tab (no reload, no logout), then other personas
    const setY = async (caps, pred) => {
      const code = await ev(ua.page, async ({ pk, caps }) => (await window.NostrApp.FirstGroupAdmin.setPermissions(pk, caps)).code, { pk: Y.pub, caps });
      const w = await waitView(um.page, Y.pub, pred, 30000);
      await sleep(400);
      return { code, ok: w.ok, ms: w.ms };
    };
    const live = {};
    live.modInvite = await setY(['MODERATE_CONTENT', 'INVITE_USERS'], "v.caps.indexOf('INVITE_USERS') !== -1 && v.caps.indexOf('MODERATE_CONTENT') !== -1");
    personas.MODERATE_CONTENT_AND_INVITE_USERS = await persona(um.page, PS.id);
    live.inviteOnly = await setY(['INVITE_USERS'], "v.caps.indexOf('MODERATE_CONTENT') === -1 && v.caps.indexOf('INVITE_USERS') !== -1");
    personas.INVITE_USERS_ONLY_LIVE = await persona(um.page, PS.id);
    const PX = await publishNote(tPage, 'p1c after revoke ' + Date.now());
    const afterRevokeDelete = await um.page.evaluate(async (p) => {
      const App = window.NostrApp;
      App.postsById.set(p.id, p);
      App.eventAuthorById.set(p.id, p.pubkey);
      const r = await App.moderateRemoveEvent(p);
      return { ok: r.ok, code: r.code, hidden: App.deletedEventIds.has(p.id) };
    }, PX);
    live.manageMembers = await setY(['MANAGE_MEMBERS'], "v.caps.indexOf('MANAGE_MEMBERS') !== -1 && v.caps.indexOf('INVITE_USERS') === -1");
    personas.MANAGE_MEMBERS_ONLY = await persona(um.page, PS.id);
    live.member = await setY([], 'v.caps.length === 0');
    personas.MEMBER = await persona(um.page, PS.id);
    personas.INVITE_USERS_ONLY = await persona(ub.page, PS.id);
    personas.ROOT = await persona(ua.page, PS.id);
    await ev(ua.page, () => window.NostrApp.GroupAdminProductUi.close());
    report.PERSONA_MATRIX = personas;
    report.PERSONA_LIVE_CHANGES = live;
    const pxOnRelay = r1.all([39002]).some((m) => m.tags.some((t) => t[0] === 'd' && t[1] === PX.id));
    set(
      'PERSONA_MATRIX',
      expect(personas.MEMBER, false, false, false) &&
        expect(personas.INVITE_USERS_ONLY, true, false, false) &&
        expect(personas.INVITE_USERS_ONLY_LIVE, true, false, false) &&
        expect(personas.MODERATE_CONTENT_ONLY, false, false, true) &&
        expect(personas.MODERATE_CONTENT_AND_INVITE_USERS, true, false, true) &&
        expect(personas.MANAGE_MEMBERS_ONLY, false, true, false) &&
        expect(personas.ROOT, true, true, true) &&
        personas.MODERATE_CONTENT_ONLY.REPORTS_MENU_VISIBLE &&
        !personas.INVITE_USERS_ONLY.REPORTS_MENU_VISIBLE &&
        !personas.MANAGE_MEMBERS_ONLY.REPORTS_MENU_VISIBLE,
      personas
    );
    set('PERSONA_PERMISSION_PROPAGATION_LIVE', yReady.ok && Object.values(live).every((l) => l.ok && /APPLIED|SAVED|NO_CHANGE|UNCHANGED/.test(String(l.code))), live);
    set('MODERATE_CONTENT_REVOKE_LIVE', !afterRevokeDelete.ok && !afterRevokeDelete.hidden && !pxOnRelay && personas.INVITE_USERS_ONLY_LIVE.MODERATOR_DELETE_VISIBLE === false, { afterRevokeDelete, pxOnRelay });
    await closeProfile(um);
    await closeProfile(ug);

    // ---- block / unblock (canonical blocklist + membership tip), enforced for the blocked user and for viewers
    const grantTInvite = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.grantCapability(pk, 'INVITE_USERS')).code, T.pub);
    await waitView(tPage, T.pub, "v.caps.indexOf('INVITE_USERS') !== -1", 30000);
    const PB = await publishNote(ub.page, 'p1 member post with replies ' + Date.now());
    const P3 = await publishNote(tPage, 'p1 content of soon-blocked user ' + Date.now());
    const C3 = await publishNote(tPage, 'p1 comment of soon-blocked user ' + Date.now(), PB.id);
    for (const p of [ua.page, ub.page]) {
      await p.evaluate(({ p3, c3, pb }) => {
        const App = window.NostrApp;
        App.postsById.set(p3.id, p3);
        App.eventAuthorById.set(p3.id, p3.pubkey);
        App.postsById.set(pb.id, pb);
        App.registerComment(c3, pb.id);
      }, { p3: P3, c3: C3, pb: PB });
    }
    const beforeBlock = await ev(ub.page, ({ p3, c3, parent }) => ({ post: window.NostrApp.postsById.has(p3), comment: window.NostrApp.listVisibleComments(parent).some((c) => c.id === c3) }), { p3: P3.id, c3: C3.id, parent: PB.id });
    await openUi(ua.page, 'members');
    await domClick(ua.page, `#sosGapBody [data-act="select-member"][data-pk="${T.pub}"]`);
    await sleep(200);
    const tDrawer = await ev(ua.page, () => {
      const d = document.getElementById('sosGapMemberDetail');
      const txt = (sel) => (d && d.querySelector(sel) ? d.querySelector(sel).textContent.trim() : '');
      return { remove: txt('[data-act="remove-member"]'), block: txt('[data-act="block-user"]'), unblock: txt('[data-act="unblock-user"]'), content: txt('[data-act="user-content"]') };
    });
    const blockUi = await actConfirm(ua.page, '#sosGapMemberDetail [data-act="block-user"]').catch((e) => ({ ok: false, text: String(e.message || e).slice(0, 80) }));
    const tBlockedOnT = await waitView(tPage, T.pub, "v.member === 'BLOCKED'", 30000);
    const tBlockedOnB = await waitView(ub.page, T.pub, "v.member === 'BLOCKED'", 30000);
    await sleep(800);
    const tSelf = await tPage.evaluate(async () => {
      const App = window.NostrApp;
      const F = App.FirstGroupAdmin;
      let commentErr = '';
      try {
        await App.postComment('ab'.repeat(32), 'blocked comment');
      } catch (e) {
        commentErr = String(e.message || e).slice(0, 80);
      }
      App.GroupAdminProductUi.ensureMenuEntry();
      return {
        invite: (await F.createInvite()).code,
        menu: App.GroupAdminProductUi.canSeeGroupAdminMenu(),
        caps: F.myAuthority().caps.length,
        commentDenied: !!commentErr,
        like: await App.likePost('cd'.repeat(32)),
      };
    });
    const tOnB = await blockView(ub.page, T.pub);
    const afterBlockB = await ev(ub.page, ({ p3, c3, parent }) => ({ post: window.NostrApp.postsById.has(p3), comment: window.NostrApp.listVisibleComments(parent).some((c) => c.id === c3) }), { p3: P3.id, c3: C3.id, parent: PB.id });
    const afterBlockA = await ev(ua.page, ({ p3 }) => window.NostrApp.postsById.has(p3), { p3: P3.id });
    await shot(ua.page, 'p1-blocked-user-drawer');
    set('BLOCK_USER_UI', tDrawer.block === 'חסום משתמש' && tDrawer.remove === 'הסר משתמש' && tDrawer.content === 'תוכן המשתמש' && blockUi.ok, { tDrawer, blockUi });
    set(
      'BLOCK_USER_ENFORCED',
      tBlockedOnT.ok && tBlockedOnB.ok && !tOnB.post && !tOnB.comment && !tOnB.reaction && !tOnB.p2p && tSelf.commentDenied && tSelf.like === null && tSelf.invite !== 'CREATED' && !tSelf.menu && tSelf.caps === 0,
      { tOnB, tSelf }
    );
    set('BLOCKED_USER_CONTENT_HIDDEN', beforeBlock.post && beforeBlock.comment && tOnB.suppressed && !afterBlockB.post && !afterBlockB.comment && !afterBlockA, { beforeBlock, afterBlockB, afterBlockA });
    report.BLOCKED_USER_CAN_POST = tOnB.post;
    report.BLOCKED_USER_CAN_COMMENT = tOnB.comment || !tSelf.commentDenied;
    report.BLOCKED_USER_CAN_INVITE = tSelf.invite === 'CREATED';
    report.BLOCKED_USER_CAN_USE_GROUP_CONTROL = tSelf.menu;
    report.BLOCKED_USER_CONTENT_VISIBLE_IN_SOS = afterBlockB.post || afterBlockB.comment || afterBlockA;
    personas.BLOCKED = await persona(tPage, 'ef'.repeat(32), B.pub).catch((e) => ({ error: String(e.message || e).slice(0, 80) }));
    set('PERSONA_BLOCKED', expect(personas.BLOCKED, false, false, false), personas.BLOCKED);

    // capabilities are frozen (and inert) while blocked; unblock restores exactly the assigned set, then a revoke sticks
    const tAssignedBlocked = (await blockView(ub.page, T.pub)).assigned;
    const revokeWhileBlocked = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.revokeCapability(pk, 'INVITE_USERS')).code, T.pub);
    await openUi(ua.page, 'members');
    await domClick(ua.page, `#sosGapBody [data-act="select-member"][data-pk="${T.pub}"]`);
    await sleep(200);
    const unblockBtn = await ev(ua.page, () => document.querySelector('#sosGapMemberDetail [data-act="unblock-user"]')?.textContent.trim() || '');
    const unblockUi = await actConfirm(ua.page, '#sosGapMemberDetail [data-act="unblock-user"]').catch((e) => ({ ok: false, text: String(e.message || e).slice(0, 80) }));
    const tActive = await waitView(tPage, T.pub, "v.member === 'ACTIVE'", 30000);
    await sleep(800);
    const tAfterUnblock = await blockView(ub.page, T.pub);
    const revokeAfterUnblock = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.revokeCapability(pk, 'INVITE_USERS')).code, T.pub);
    const tRevoked = await waitView(ub.page, T.pub, "v.caps.indexOf('INVITE_USERS') === -1", 30000);
    const tAfterRevoke = await blockView(ub.page, T.pub);
    const sameSet = JSON.stringify(tAfterUnblock.assigned.slice().sort()) === JSON.stringify(tAssignedBlocked.slice().sort());
    set('UNBLOCK_USER_UI', unblockBtn === 'הסר חסימה' && unblockUi.ok, { unblockBtn, unblockUi });
    set(
      'UNBLOCK_CANONICAL_STATE',
      tActive.ok && tAfterUnblock.member === 'ACTIVE' && !tAfterUnblock.listed && !tAfterUnblock.suppressed && tAfterUnblock.post && tAfterUnblock.comment &&
        revokeWhileBlocked === 'TARGET_BLOCKED' && sameSet && revokeAfterUnblock === 'APPLIED' && tRevoked.ok && !tAfterRevoke.assigned.includes('INVITE_USERS'),
      { grantTInvite, revokeWhileBlocked, tAssignedBlocked, tAfterUnblock, revokeAfterUnblock, tAfterRevoke }
    );
    // a REMOVED member: block = blocklist entry only; unblock never restores the membership
    const blockRemoved = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.blockMember(pk)).code, C.pub);
    const waitListed = (want) =>
      ub.page.waitForFunction((a) => window.NostrApp.MembershipState.inBlockedPubkeys(a.pk) === a.w, { pk: C.pub, w: want }, { polling: 250, timeout: 30000 }).catch(() => {});
    await waitListed(true);
    const cListed = await blockView(ub.page, C.pub);
    const unblockRemoved = await ev(ua.page, async (pk) => (await window.NostrApp.FirstGroupAdmin.unblockMember(pk)).code, C.pub);
    await waitListed(false);
    const cAfter = await blockView(ub.page, C.pub);
    const rootBlock = await ev(ub.page, async (a) => (await window.NostrApp.FirstGroupAdmin.blockMember(a)).code, A.pub);
    const rootBlockByRoot = await ev(ua.page, async (a) => (await window.NostrApp.FirstGroupAdmin.blockMember(a)).code, A.pub);
    set(
      'UNBLOCK_DOES_NOT_RESTORE_REMOVED',
      blockRemoved === 'APPLIED' && cListed.listed && cListed.member === 'REMOVED' && unblockRemoved === 'APPLIED' && !cAfter.listed && cAfter.member === 'REMOVED',
      { blockRemoved, cListed: { member: cListed.member, listed: cListed.listed }, unblockRemoved, cAfter: { member: cAfter.member, listed: cAfter.listed } }
    );
    set('BLOCK_ROOT_REJECTED', rootBlock !== 'APPLIED' && rootBlock !== 'BLOCKED' && /ROOT|SELF/.test(String(rootBlockByRoot)), { rootBlock, rootBlockByRoot });

    // ---- private reports: T reports a post by B; only the moderator (root A) can read it
    const P4 = await publishNote(ub.page, 'p1 reported post ' + Date.now());
    const guestReport = await ev(ux.page, (p) => {
      const App = window.NostrApp;
      const prev = App.guestMode;
      App.requireAuth = () => false;
      App.guestMode = true;
      try {
        return App.reportEvent(p.id, '', { pubkey: p.pubkey, content: p.content }).code;
      } finally {
        App.guestMode = prev;
      }
    }, P4);
    const submit = await tPage.evaluate(async (p) => window.NostrApp.GroupReports.submitReport({ id: p.id, pubkey: p.pubkey, kind: 1, preview: p.content }, 'SPAM', ''), P4);
    const dup = await tPage.evaluate(async (p) => (await window.NostrApp.GroupReports.submitReport({ id: p.id, pubkey: p.pubkey, kind: 1, preview: p.content }, 'SPAM', '')).code, P4);
    await sleep(800);
    const inboxA = await ev(ua.page, async (id) => {
      const R = window.NostrApp.GroupReports;
      let s = await R.loadInbox();
      let row = s.rows.find((r) => r.targetId === id);
      for (let i = 0; !row && i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        s = await R.loadInbox();
        row = s.rows.find((r) => r.targetId === id);
      }
      window.NostrApp.GroupAdminProductUi.ensureMenuEntry();
      const badge = document.querySelector('#sosGroupControlMenuItem .sos-report-badge');
      return { ok: s.ok, unresolved: s.unresolved, row: row ? { status: row.status, count: row.reportCount, reasons: row.reasons, reported: row.reportedPubkey } : null, badge: badge ? badge.textContent : '' };
    }, P4.id);
    const inboxB = await ev(ub.page, async () => {
      const s = await window.NostrApp.GroupReports.loadInbox();
      return { ok: s.ok, code: s.code, rows: s.rows.length };
    });
    const wraps = r1.all([39010]);
    const wrapBlob = JSON.stringify(wraps);
    const privacy = {
      wraps: wraps.length,
      reporterVisible: wraps.some((w) => w.pubkey === T.pub || w.tags.some((t) => t[1] === T.pub)) || wrapBlob.includes(T.pub),
      targetVisible: wrapBlob.includes(P4.id) || wrapBlob.includes(B.pub),
      reasonVisible: /SPAM|ספאם/.test(wrapBlob),
      onlyPTagsToModerators: wraps.every((w) => w.tags.filter((t) => t[0] === 'p').every((t) => t[1] === A.pub || t[1] === Y.pub)),
    };
    await openUi(ua.page, 'reports');
    await sleep(300);
    const reportRowUi = await ev(ua.page, (id) => {
      const row = document.querySelector(`#sosGapReportList [data-report-target="${id}"]`);
      const tab = document.querySelector('#sosGapTabs button[data-tab="reports"]');
      return { row: !!row, text: row ? row.innerText : '', actions: row ? Array.from(row.querySelectorAll('button')).map((b) => b.textContent.trim()) : [], tab: tab ? tab.textContent : '' };
    }, P4.id);
    await shot(ua.page, 'p1-reports-inbox');
    const removeRes = await actConfirm(ua.page, `#sosGapReportList [data-act="report-remove"][data-target="${P4.id}"]`).catch((e) => ({ ok: false, text: String(e.message || e).slice(0, 80) }));
    await sleep(1200);
    const resolved = await ev(ua.page, async (id) => {
      const App = window.NostrApp;
      const R = App.GroupReports;
      const s = await R.loadInbox();
      const row = s.rows.find((r) => r.targetId === id);
      App.GroupAdminProductUi.ensureMenuEntry();
      return {
        status: row && row.status,
        removed: App.deletedEventIds.has(id),
        unresolved: s.unresolved,
        badge: document.querySelector('#sosGroupControlMenuItem .sos-report-badge')?.textContent || '',
        audit: R.resolutionAudit().map((r) => r.action),
      };
    }, P4.id);
    const bAuditReports = await ev(ub.page, () => window.NostrApp.GroupReports.resolutionAudit().length);
    // inbox dedupe even when the reporter clears the client limit; client flood limit per hour
    const flood = await tPage.evaluate(async (p) => {
      const R = window.NostrApp.GroupReports;
      Object.keys(localStorage).filter((k) => k.startsWith('sos_group_reports_sent_v1:')).forEach((k) => localStorage.removeItem(k));
      const again = (await R.submitReport({ id: p.id, pubkey: p.pubkey, kind: 1 }, 'HARASSMENT', '')).code;
      const codes = [];
      for (let i = 0; i < 10; i++) {
        const id = Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, '0')).join('');
        codes.push((await R.submitReport({ id, pubkey: p.pubkey, kind: 1 }, 'SPAM', '')).code);
      }
      return { again, codes };
    }, P4);
    await sleep(800);
    const dedupe = await ev(ua.page, async (id) => {
      const s = await window.NostrApp.GroupReports.loadInbox();
      const row = s.rows.find((r) => r.targetId === id);
      return { count: row && row.reportCount, status: row && row.status };
    }, P4.id);
    await openUi(ua.page, 'activity');
    await sleep(300);
    const auditActions = await ev(ua.page, () => Array.from(new Set(Array.from(document.querySelectorAll('#sosGapAudit [data-audit-action]')).map((e) => e.getAttribute('data-audit-action')))));
    await shot(ua.page, 'p1-activity');
    set('REPORT_SUBMIT', submit.ok && submit.delivered >= 1 && dup === 'ALREADY_REPORTED' && guestReport === 'LOGIN_REQUIRED', { submit, dup, guestReport });
    set('REPORT_PRIVATE_STORAGE', privacy.wraps >= 1 && !privacy.reporterVisible && !privacy.targetVisible && !privacy.reasonVisible && privacy.onlyPTagsToModerators, privacy);
    set(
      'REPORT_APPEARS_IN_MODERATION_INBOX',
      inboxA.ok && inboxA.row && inboxA.row.status === 'NEW' && inboxA.row.count === 1 && inboxA.row.reported === B.pub && reportRowUi.row && /ספאם/.test(reportRowUi.text) && !inboxB.ok,
      { inboxA, inboxB, actions: reportRowUi.actions }
    );
    set('REPORT_BADGE', inboxA.badge === String(inboxA.unresolved) && inboxA.unresolved >= 1 && /דיווחים \(\d+\)/.test(reportRowUi.tab) && resolved.badge === '', { before: inboxA.badge, tab: reportRowUi.tab, after: resolved.badge });
    set('REPORT_RESOLUTION', removeRes.ok && resolved.status === 'RESOLVED' && resolved.removed && resolved.unresolved === 0 && resolved.audit.includes('REPORT_RESOLVED') && bAuditReports === 0, { removeRes, resolved, bAuditReports });
    set('REPORT_FLOOD_PROTECTION', flood.again === 'DELIVERED' && dedupe.count === 1 && flood.codes.filter((c) => c === 'DELIVERED').length === 9 && flood.codes[9] === 'RATE_LIMITED', { flood, dedupe });
    set('AUDIT_LOG_PHASE1', ['CONTENT_REMOVED', 'BLOCKLIST_CHANGED', 'MEMBER_BLOCKED', 'MEMBER_UNBLOCKED', 'REPORT_RESOLVED'].every((a) => auditActions.includes(a)), { auditActions });
    report.REPORTED_CONTENT_VISIBLE_AFTER_REMOVAL = !resolved.removed;
    report.NEW_REPORT_VISIBLE_TO_MODERATOR = !!(inboxA.row && reportRowUi.row);
    report.REPORT_BUTTON_SOURCE = {
      post: /data-report-event="\$\{event\.id\}"/.test(fs.readFileSync(path.join(ROOT, 'feed.js'), 'utf8')),
      comment: /feed-comment__report/.test(fs.readFileSync(path.join(ROOT, 'feed.js'), 'utf8')) && /videos-comment-report/.test(fs.readFileSync(path.join(ROOT, 'videos.js'), 'utf8')),
      video: /videos-feed__action--report/.test(fs.readFileSync(path.join(ROOT, 'videos.js'), 'utf8')),
    };

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
  // Local diagnostics only (untracked dot-file); the secret-hex check above already ran on this log.
  if (report.SERVICE_LOG_SECRET_HITS === 0) fs.writeFileSync(path.join(ROOT, 'qa', '.898-admission-service.log'), admLog.slice(-200000));
  console.log('RESULT', report.status, 'passed', report.passed, 'failed', report.failedKeys.join(','));
  process.exit(report.status === 'PASS' ? 0 : 1);
}

main();
