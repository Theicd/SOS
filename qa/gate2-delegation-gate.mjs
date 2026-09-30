/**
 * Gate 2 local gate (ACCESS_CONTROL_V2 OFF, Admin 2FA enforced — production flag shape).
 *
 * - Two local NIP-01 relays; config.js served with local relays, disposable root A and the local admission URL;
 *   first-group-admin.js served with the disposable service key in place of the production service pubkey.
 * - Local `wrangler dev --local` admission service with disposable keys (.dev.vars, deleted on exit) and
 *   CONTROL_RELAYS -> the local relays, ADMIN_2FA_SIGNER_PUBKEY -> the local co-sign key.
 * - Genesis is published first (Gate 1.5 path). The service must see it from the relays on its own. Then the root
 *   opens "ניהול הקבוצה" > "הגדרות מתקדמות" and clicks "הפעל שירות קבלת חברים" (confirm + step-up PIN).
 * - Also: step-up cancel publishes nothing, service rebuild from relays only, pre-publish validator negatives,
 *   service ingest negatives, and the owner revocation path (local only).
 * Never deploys. The test PIN is random per run and never printed.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'gate2-delegation-report.json');
const PORT = Number(process.env.SOS_G2_PORT || 8801);
const RELAY_PORTS = [7783, 7784];
const RELAYS = RELAY_PORTS.map((p) => `ws://127.0.0.1:${p}`);
const URL0 = `http://127.0.0.1:${PORT}/videos.html`;
const ADM_PORT = Number(process.env.SOS_G2_ADM_PORT || 8800);
const ADM_URL = `http://127.0.0.1:${ADM_PORT}`;
const ADM_DIR = path.join(ROOT, 'admission-service');
const PROD_ROOT = 'ede1e7fabb758aca75ae548680a206a234c6d6b257834b111d284c3692e67601';
const PROD_SERVICE = '752f47fa926d1833a451bdc97f3f2967ae4bc6452d0356bc7919c6928e4611ef';
const GROUP = 'israel-network';
const ADM = 'FINALIZE_MEMBERSHIP_ADMISSION';
const EXPLAIN = 'שירות הקבלה יקבל הרשאה מוגבלת לאשר הצטרפות חברים בלבד.';

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkKey = () => {
  const sk = generateSecretKey();
  return { sk, hex: hex(sk), pub: getPublicKey(sk) };
};
const TEST_PIN = (() => {
  for (;;) {
    const p = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const d = p.split('').map(Number);
    const step = d.slice(1).map((x, i) => (x - d[i] + 10) % 10);
    if (new Set(d).size >= 4 && !step.every((s) => s === 1) && !step.every((s) => s === 9)) return p;
  }
})();

const report = { gate: 'GATE2_DELEGATION_LOCAL', status: 'FAIL', ts: new Date().toISOString(), results: {} };
const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300));
};

// ---------------------------------------------------------------- NIP-01 test relay
function matchFilter(ev, f) {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.since && ev.created_at < f.since) return false;
  for (const k of Object.keys(f)) {
    if (k[0] !== '#') continue;
    const vals = f[k] || [];
    if (!(ev.tags || []).some((t) => t[0] === k.slice(1) && vals.includes(t[1]))) return false;
  }
  return true;
}
class TestRelay {
  constructor(port) {
    this.port = port;
    this.events = new Map();
    this.clients = new Set();
  }
  start() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port }, resolve);
      this.wss.on('error', reject);
      this.wss.on('connection', (ws) => {
        const c = { ws, subs: new Map() };
        this.clients.add(c);
        ws.on('message', (d) => this.onMsg(c, d));
        ws.on('close', () => this.clients.delete(c));
        ws.on('error', () => {});
      });
    });
  }
  stop() {
    for (const c of this.clients) c.ws.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
  send(c, arr) {
    try {
      c.ws.send(JSON.stringify(arr));
    } catch (_e) {}
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
      let ok = false;
      try {
        ok = !!ev && verifyEvent({ ...ev });
      } catch (_e) {}
      if (!ok) return this.send(c, ['OK', ev && ev.id, false, 'invalid: bad signature']);
      const fresh = !this.events.has(ev.id);
      if (fresh && !(ev.kind >= 20000 && ev.kind < 30000)) this.events.set(ev.id, ev);
      this.send(c, ['OK', ev.id, true, fresh ? '' : 'duplicate:']);
      if (fresh) {
        for (const cl of this.clients) for (const [id, fs2] of cl.subs) if (fs2.some((f) => matchFilter(ev, f))) this.send(cl, ['EVENT', id, ev]);
      }
    } else if (m[0] === 'REQ') {
      const [, id, ...filters] = m;
      c.subs.set(id, filters);
      const out = new Map();
      for (const f of filters) {
        let rows = Array.from(this.events.values()).filter((ev) => matchFilter(ev, f)).sort((a, b) => b.created_at - a.created_at);
        if (f.limit) rows = rows.slice(0, f.limit);
        rows.forEach((r) => out.set(r.id, r));
      }
      out.forEach((ev) => this.send(c, ['EVENT', id, ev]));
      this.send(c, ['EOSE', id]);
    } else if (m[0] === 'CLOSE') c.subs.delete(m[1]);
  }
  all(kinds) {
    return Array.from(this.events.values()).filter((e) => !kinds || kinds.includes(e.kind));
  }
  order() {
    return Array.from(this.events.values()).map((e) => e.kind);
  }
}
const relays = RELAY_PORTS.map((p) => new TestRelay(p));

// ---------------------------------------------------------------- static server
let ROOT_PUB = '';
const COSIGN = mkKey();
const SVC = mkKey();
const PIN_PEPPER = crypto.randomBytes(32).toString('hex');
function transformConfig(src) {
  return src
    .replace(/App\.FIRST_GROUP_ADMISSION_URL = '[^']*';/, () => `App.FIRST_GROUP_ADMISSION_URL = '${ADM_URL}';`)
    .replace(PROD_ROOT, ROOT_PUB)
    .replace(/const SAFE_DEFAULT_RELAYS = \[[^\]]*\];/, () => `const SAFE_DEFAULT_RELAYS = ${JSON.stringify(RELAYS)};`)
    .replace(/const SAFE_DEFAULT_P2P_RELAYS = \[[^\]]*\];/, () => `const SAFE_DEFAULT_P2P_RELAYS = ${JSON.stringify(RELAYS)};`)
    .replace("!trimmed.startsWith('wss://')", () => "!(trimmed.startsWith('wss://') || trimmed.startsWith('ws://127.0.0.1:'))");
}
const servedFlags = () => {
  const prod = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime-feature-flags.json'), 'utf8'));
  const pre = Object.assign({}, prod, { accessControlV2: false, admin2faSignerPubkey: COSIGN.pub });
  delete pre.accessControlV2Scope;
  return pre;
};
let fgaPinned = false;
function startServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp' };
  const server = http.createServer((req, res) => {
    try {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/') p = '/videos.html';
      if (p === '/runtime-feature-flags.json') {
        res.writeHead(200, { 'Content-Type': types['.json'], 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(servedFlags()));
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
      if (p === '/first-group-admin.js') {
        const src = fs.readFileSync(fp, 'utf8');
        fgaPinned = src.includes(`const ADMISSION_SERVICE_PUBKEY = '${PROD_SERVICE}';`);
        res.writeHead(200, { 'Content-Type': types['.js'], 'Cache-Control': 'no-store' });
        res.end(src.replace(`const ADMISSION_SERVICE_PUBKEY = '${PROD_SERVICE}';`, () => `const ADMISSION_SERVICE_PUBKEY = '${SVC.pub}';`));
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

// ---------------------------------------------------------------- local admission / Admin 2FA service
let admProc = null;
let admLog = '';
let admPersist = '';
async function startAdmission(rootPub) {
  admPersist = path.join(os.tmpdir(), 'sosg2-adm-' + Date.now());
  fs.writeFileSync(
    path.join(ADM_DIR, '.dev.vars'),
    `ROOT_PUBKEY=${rootPub}\nADMISSION_SK=${SVC.hex}\nADMIN_COSIGN_SK=${COSIGN.hex}\nADMIN_PIN_PEPPER=${PIN_PEPPER}\nTEST_FAULTS=1\n` +
      `ALLOWED_ORIGINS=http://127.0.0.1:${PORT}\nADMIN_2FA_SIGNER_PUBKEY=${COSIGN.pub}\nCONTROL_RELAYS=${RELAYS.join(',')}\n`
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
      if (r.ok && (await r.json()).adminPinService === true) return;
    } catch (_e) {}
    await sleep(500);
  }
  throw new Error('admission service did not start: ' + admLog.slice(-600).replace(/[0-9a-f]{32,}/g, '<hex>'));
}
function stopAdmission(keepVars) {
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
  if (!keepVars) {
    try {
      fs.rmSync(path.join(ADM_DIR, '.dev.vars'), { force: true });
    } catch (_e) {}
  }
  try {
    if (admPersist) fs.rmSync(admPersist, { recursive: true, force: true });
  } catch (_e) {}
}
const health = async () => (await fetch(ADM_URL + '/v1/health')).json();
const admPost = async (p, body) => (await fetch(ADM_URL + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ groupId: GROUP }, body)) })).json();
async function waitHealth(pred, ms) {
  let h = null;
  for (let i = 0; i < ms / 1000; i++) {
    h = await health().catch(() => null);
    if (h && pred(h)) return h;
    await sleep(1000);
  }
  return h;
}

// ---------------------------------------------------------------- browsers
const ALLOWED = new Set(['127.0.0.1', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']);
const pageErrors = [];
async function newUser(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.route('**/*', (route) => {
    let host = '';
    try {
      host = new URL(route.request().url()).hostname;
    } catch (_e) {}
    return ALLOWED.has(host) ? route.continue() : route.abort();
  });
  await ctx.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'serviceWorker', { get: () => undefined, configurable: true });
    } catch (_e) {}
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => {
    if (/first-group|group-admin-product-ui|admin-2fa/.test(String(e.stack || ''))) pageErrors.push(label + ': ' + String(e.message).slice(0, 200));
  });
  await page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(
    () => !!window.NostrApp?.createNewIdentityExplicit && !!window.NostrApp?.FirstGroupAdmin && !!window.NostrApp?.GroupAdminProductUi && window.SosFeatureFlags?.isResolved?.() === true && !!window.NostrApp?.pool,
    null,
    { polling: 200, timeout: 120000 }
  );
  return { ctx, page, label };
}
async function boot(page, key) {
  return page.evaluate(async (k) => {
    const App = window.NostrApp;
    const c = App.createNewIdentityExplicit({ privateKeyHex: k });
    App.guestMode = false;
    App.SessionAuthority?.bindCurrentSession?.({ accountPubkey: c.publicKey, bump: true });
    window.dispatchEvent(new CustomEvent('sos-identity-ready'));
    await new Promise((r) => setTimeout(r, 500));
    App.GroupAdminProductUi.ensureMenuEntry();
    return String(c.publicKey || '').toLowerCase();
  }, key.hex);
}
const relayCounts = () =>
  relays.map((r) => ({ c39001: r.all([39001]).length, c39004: r.all([39004]).length, c39003: r.all([39003]).length, order: r.order().filter((k) => k === 39001 || k === 39004 || k === 39003) }));

async function uiState(page) {
  return page.evaluate(() => {
    const st = document.getElementById('sosGapControlStatus');
    const shell = document.getElementById('sosGroupAdminShell');
    const adm = document.getElementById('sosGapAdmissionState');
    return {
      open: window.NostrApp.GroupAdminProductUi.isOpen(),
      status: st ? st.getAttribute('data-status') : '',
      activate: !!document.getElementById('sosGapActivateAdmission'),
      deactivate: !!document.getElementById('sosGapDeactivateAdmission'),
      explain: document.getElementById('sosGapAdmissionExplain')?.textContent || '',
      admissionActive: adm ? adm.getAttribute('data-active') : null,
      enabledMutations: shell ? Array.from(shell.querySelectorAll('[data-mutation]')).filter((b) => !b.disabled).length : -1,
      msg: document.getElementById('sosGapMsg')?.textContent || '',
      v2: window.SOS_ACCESS_CONTROL_V2 === true,
    };
  });
}
async function openAdvanced(page) {
  await page.evaluate(() => {
    if (!window.NostrApp.GroupAdminProductUi.isOpen()) window.NostrApp.GroupAdminProductUi.open('members');
  });
  await page.evaluate(() => {
    const d = document.getElementById('sosGapAdvanced');
    if (d) d.open = true;
  });
}
/** Clicks an owner button, accepts the confirm dialog, then answers (or cancels) the step-up PIN dialog. */
async function ownerAction(page, buttonId, pin, doneRe) {
  await page.waitForFunction((id) => !!document.getElementById(id), buttonId, { polling: 200, timeout: 30000 });
  await page.evaluate((id) => document.getElementById(id).click(), buttonId);
  await page.waitForFunction(() => document.getElementById('sosGapConfirm')?.classList.contains('is-open'), null, { polling: 100, timeout: 15000 });
  const confirmText = await page.evaluate(() => document.getElementById('sosGapConfirmText').textContent);
  await page.evaluate(() => document.getElementById('sosGapConfirmOk').click());
  await page.waitForSelector('#sosAdminPinDialog', { timeout: 30000 });
  const stepUpText = await page.evaluate(() => document.getElementById('sosAdminPinDialog')?.textContent || '');
  if (pin) {
    await page.fill('#sosAdminPinInput', pin);
    await page.click('#sosAdminPinOk');
  } else {
    await page.click('#sosAdminPinCancel');
  }
  await page.waitForFunction((re) => new RegExp(re).test(document.getElementById('sosGapMsg')?.textContent || ''), doneRe, { polling: 200, timeout: 90000 }).catch(() => {});
  const msg = await page.evaluate(() => document.getElementById('sosGapMsg')?.textContent || '');
  return { confirmText, stepUp: /פעולה רגישה/.test(stepUpText), msg };
}

async function main() {
  const A = mkKey();
  const M = mkKey();
  const X = mkKey();
  ROOT_PUB = A.pub;
  for (const r of relays) await r.start();
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    await startAdmission(A.pub);
    const ua = await newUser(browser, 'A');
    const um = await newUser(browser, 'M');
    await boot(ua.page, A);
    await boot(um.page, M);
    set('SERVED_FGA_PINS_PRODUCTION_SERVICE_KEY', fgaPinned, null);
    const env = await ua.page.evaluate(() => ({
      v2: window.SOS_ACCESS_CONTROL_V2 === true,
      enforced: window.NostrApp.Admin2faProtocol.isEnforced(),
      signer: window.NostrApp.Admin2faProtocol.activeSignerPubkey(),
    }));
    set('ENV_V2_OFF_ENFORCED', !env.v2 && env.enforced && env.signer === COSIGN.pub, env);

    // ---- genesis (Gate 1.5 path), then the service must pick it up from the relays by itself
    const pinCode = await ua.page.evaluate(async (pin) => (await window.NostrApp.AdminPinLock.setupPin(pin, pin)).code, TEST_PIN);
    const g15 = await ua.page.evaluate(async () => (await window.NostrApp.FirstGroupAdmin.activateGroupControl()).code);
    await sleep(600);
    const genesis = relays[0].all([39001])[0];
    set('PRECONDITION_GENESIS_PUBLISHED', pinCode === 'PIN_SET' && g15 === 'GATE15_PUBLISHED' && !!genesis, { pinCode, g15 });
    const h0 = await health();
    const h1 = await waitHealth((h) => h.controlPlane === 'ACTIVE', 40000);
    set(
      'SERVICE_CONTROL_FROM_RELAYS',
      h1 &&
        h1.controlPlane === 'ACTIVE' &&
        h1.controlStatus === 'VERIFIED' &&
        h1.bootstrapEventId === genesis.id &&
        h1.controlEpoch === 1 &&
        h1.controlRootPubkey === A.pub &&
        h1.admin2faSignerPubkey === COSIGN.pub &&
        h1.admin2faEnforced === true &&
        h1.delegationActive === false &&
        h1.servicePubkey === SVC.pub &&
        h1.lastRelayRefresh &&
        h1.lastRelayRefresh.relaysOk === 2,
      { firstHealth: h0.controlStatus, controlPlane: h1 && h1.controlPlane, epoch: h1 && h1.controlEpoch, relay: h1 && h1.lastRelayRefresh }
    );

    // ---- non-root refused
    const mRes = await um.page.evaluate(async () => (await window.NostrApp.FirstGroupAdmin.activateAdmissionService()).code);
    set('NON_ROOT_CANNOT_ACTIVATE_ADMISSION', mRes === 'FIRST_GROUP_ROOT_NOT_CONFIGURED' && relayCounts().every((c) => c.c39001 === 1), { mRes });

    // ---- UI before
    await openAdvanced(ua.page);
    await ua.page.waitForFunction(() => !!document.getElementById('sosGapActivateAdmission'), null, { polling: 200, timeout: 30000 }).catch(() => {});
    await openAdvanced(ua.page);
    const before = await uiState(ua.page);
    set('UI_BEFORE_OWNER_BUTTON', before.activate && before.explain.includes(EXPLAIN) && before.admissionActive === '0' && before.enabledMutations === 0 && !before.v2, before);

    // ---- step-up cancelled: nothing is published
    const cancel = await ownerAction(ua.page, 'sosGapActivateAdmission', null, 'קוד המנהל|בוטלה|נכשלה');
    await sleep(800);
    set('STEP_UP_CANCEL_PUBLISHES_NOTHING', cancel.stepUp && cancel.confirmText.includes(EXPLAIN) && relayCounts().every((c) => c.c39001 === 1 && c.c39004 === 1), { msg: cancel.msg, counts: relayCounts() });

    // ---- real activation through the UI
    await openAdvanced(ua.page);
    const act = await ownerAction(ua.page, 'sosGapActivateAdmission', TEST_PIN, 'הופעל$|נכשלה|אינו |אין |עדיין');
    await sleep(800);
    const counts = relayCounts();
    set('ACTIVATE_VIA_UI_WITH_STEP_UP', act.stepUp && act.msg === 'שירות קבלת החברים הופעל' && act.confirmText.includes(EXPLAIN), { msg: act.msg });
    set(
      'PUBLISHED_ATTESTATION_THEN_DELEGATION_ONLY',
      counts.every((c) => c.c39001 === 2 && c.c39004 === 2 && c.c39003 === 0 && c.order[2] === 39004 && c.order[3] === 39001),
      counts
    );
    const delegation = relays[0].all([39001]).find((e) => e.id !== genesis.id);
    const dAtt = relays[0].all([39004]).find((a) => (a.tags.find((t) => t[0] === 'e') || [])[1] === (delegation && delegation.id));
    const gBody = JSON.parse(genesis.content);
    const dBody = delegation ? JSON.parse(delegation.content) : {};
    const strip = (b) => {
      const c = Object.assign({}, b);
      delete c.controlEpoch;
      delete c.createdAt;
      delete c.capabilities;
      return JSON.stringify(c, Object.keys(c).sort());
    };
    set(
      'DELEGATION_EXACT_SINGLE_CAPABILITY',
      !!delegation &&
        delegation.pubkey === A.pub &&
        JSON.stringify(delegation.tags) === JSON.stringify([['d', GROUP + ':2'], ['t', GROUP], ['sos-control', 'v1']]) &&
        dBody.controlEpoch === 2 &&
        JSON.stringify(dBody.capabilities) === JSON.stringify({ [SVC.pub]: [ADM] }) &&
        strip(dBody) === strip(gBody),
      { caps: dBody.capabilities, epoch: dBody.controlEpoch }
    );
    const aBody = dAtt ? JSON.parse(dAtt.content) : {};
    set(
      'ATTESTATION_BINDS_DELEGATION_WITH_STEP_UP',
      !!dAtt && dAtt.pubkey === COSIGN.pub && aBody.eventId === delegation.id && JSON.stringify(aBody.operations) === '["CREATE_ADMISSION_DELEGATION"]' && aBody.controlEpoch === 2 && aBody.stepUp === true && aBody.rootPubkey === A.pub,
      { operations: aBody.operations, stepUp: aBody.stepUp, controlEpoch: aBody.controlEpoch }
    );

    // ---- service sees the delegation
    const h2 = await waitHealth((h) => h.delegationActive === true, 40000);
    set(
      'SERVICE_DELEGATION_ACTIVE',
      h2 && h2.delegationActive === true && h2.controlEpoch === 2 && h2.controlTipEventId === delegation.id && h2.bootstrapEventId === genesis.id && JSON.stringify(h2.delegatedCapabilities) === JSON.stringify([ADM]) && h2.servicePubkey === SVC.pub,
      { delegationActive: h2 && h2.delegationActive, caps: h2 && h2.delegatedCapabilities, epoch: h2 && h2.controlEpoch }
    );
    set('HEALTH_HAS_NO_SERVICE_SECRET', !JSON.stringify(h2).includes(SVC.hex) && !JSON.stringify(h2).includes(COSIGN.hex), null);

    // ---- UI after
    await sleep(1500);
    await openAdvanced(ua.page);
    await ua.page.waitForFunction(() => document.getElementById('sosGapAdmissionState')?.getAttribute('data-active') === '1', null, { polling: 200, timeout: 30000 }).catch(() => {});
    const after = await uiState(ua.page);
    set('UI_AFTER_ACTIVE_WRITES_OFF', after.admissionActive === '1' && !after.activate && after.deactivate && after.enabledMutations === 0 && !after.v2 && after.status === 'CONTROL_ACTIVE_WRITES_OFF', after);
    await ua.page.screenshot({ path: path.join(ROOT, 'qa', 'gate2-delegation-after.png') }).catch(() => {});
    const again = await ua.page.evaluate(async () => (await window.NostrApp.FirstGroupAdmin.activateAdmissionService()).code);
    set('SECOND_DELEGATION_REFUSED', again === 'DELEGATION_EXISTS' && relayCounts().every((c) => c.c39001 === 2), { again });

    // ---- service rebuild from relays only (fresh Durable Object storage, no client push)
    stopAdmission(true);
    await startAdmission(A.pub);
    const h3 = await waitHealth((h) => h.delegationActive === true, 40000);
    set('SERVICE_REBUILD_FROM_RELAYS_ONLY', h3 && h3.delegationActive === true && h3.controlEpoch === 2 && h3.controlTipEventId === delegation.id && h3.lastRelayRefresh && h3.lastRelayRefresh.relaysOk === 2, {
      delegationActive: h3 && h3.delegationActive,
      relay: h3 && h3.lastRelayRefresh,
    });
    // Fresh local storage also dropped the local PIN record: enroll the disposable test PIN again.
    const pin2 = await ua.page.evaluate(async (pin) => {
      const L = window.NostrApp.AdminPinLock;
      if (typeof L.lock === 'function') L.lock();
      return (await L.setupPin(pin, pin)).code;
    }, TEST_PIN);
    set('LOCAL_PIN_RE_ENROLLED_AFTER_REBUILD', pin2 === 'PIN_SET', { pin2 });

    // ---- pre-publish validator negatives (clean page holding only the verified genesis)
    const uc = await newUser(browser, 'CLEAN');
    const drafts = async (list) =>
      uc.page.evaluate(
        ({ list, root }) =>
          list.map((x) =>
            window.NostrApp.Admin2faProtocol.buildAttestationDraft({
              groupId: 'israel-network',
              rootPubkey: root,
              event: x.event,
              operations: x.ops,
              controlEpoch: x.epoch,
              principal: root,
              stepUp: true,
              issuedAt: x.issuedAt,
              requestId: x.requestId,
            })
          ),
        { list, root: A.pub }
      );
    const now = Math.floor(Date.now() / 1000);
    const gAtt = relays[0].all([39004]).find((a) => (a.tags.find((t) => t[0] === 'e') || [])[1] === genesis.id);
    const mkDel = (patch, key, tags) =>
      finalizeEvent(
        { kind: 39001, created_at: now, tags: tags || [['d', GROUP + ':2'], ['t', GROUP], ['sos-control', 'v1']], content: JSON.stringify(Object.assign({}, gBody, { controlEpoch: 2, createdAt: now, capabilities: { [SVC.pub]: [ADM] } }, patch || {})) },
        (key || A).sk
      );
    const cases = {
      real: { ev: mkDel() },
      wrongTarget: { ev: mkDel({ capabilities: { [X.pub]: [ADM] } }) },
      extraCapability: { ev: mkDel({ capabilities: { [SVC.pub]: [ADM, 'MANAGE_MEMBERS'].sort() } }) },
      secondDelegate: { ev: mkDel({ capabilities: { [SVC.pub]: [ADM], [X.pub]: [ADM] } }) },
      selfGrant: { ev: mkDel({ capabilities: { [A.pub]: [ADM] } }) },
      rootMutation: { ev: mkDel({ rootAdminPubkey: X.pub }) },
      policyChange: { ev: mkDel({ invitePolicy: 'ADMINS_ONLY' }) },
      signerChange: { ev: mkDel({ admin2faSignerPubkey: X.pub }) },
      wrongGroup: { ev: mkDel({ groupId: 'other-network' }, A, [['d', 'other-network:2'], ['t', 'other-network'], ['sos-control', 'v1']]) },
      notRootSigned: { ev: mkDel({}, X) },
      wrongEpoch: { ev: mkDel({ controlEpoch: 3 }, A, [['d', GROUP + ':3'], ['t', GROUP], ['sos-control', 'v1']]) },
    };
    const reqId = () => getPublicKey(generateSecretKey());
    const list = Object.keys(cases).map((k) => ({ event: cases[k].ev, ops: ['CREATE_ADMISSION_DELEGATION'], epoch: 2, issuedAt: now, requestId: reqId() }));
    const ds = await drafts(list);
    Object.keys(cases).forEach((k, i) => (cases[k].att = finalizeEvent(ds[i], COSIGN.sk)));
    const [dWrongOp, dExpired, dOther] = await drafts([
      { event: cases.real.ev, ops: ['GRANT_CAPABILITY'], epoch: 2, issuedAt: now, requestId: reqId() },
      { event: cases.real.ev, ops: ['CREATE_ADMISSION_DELEGATION'], epoch: 2, issuedAt: now - 7200, requestId: reqId() },
      { event: cases.wrongTarget.ev, ops: ['CREATE_ADMISSION_DELEGATION'], epoch: 2, issuedAt: now, requestId: reqId() },
    ]);
    cases.attWrongOperation = { ev: cases.real.ev, att: finalizeEvent(dWrongOp, COSIGN.sk) };
    cases.attExpired = { ev: cases.real.ev, att: finalizeEvent(dExpired, COSIGN.sk) };
    cases.attOtherEvent = { ev: cases.real.ev, att: finalizeEvent(dOther, COSIGN.sk) };
    cases.attForged = { ev: cases.real.ev, att: finalizeEvent({ kind: 39004, created_at: cases.real.att.created_at, tags: cases.real.att.tags, content: cases.real.att.content }, X.sk) };
    const pre = await uc.page.evaluate(
      ({ genesis, gAtt, cases, root, signer }) => {
        const App = window.NostrApp;
        const G = App.GroupControlState;
        const P = App.Admin2faProtocol;
        const F = App.FirstGroupAdmin;
        const out = {};
        for (const k of Object.keys(cases)) {
          G.clearAllStores();
          P.clearAttestations();
          P.ingestAttestations([gAtt, cases[k].att]);
          G.acceptControlEvent(genesis, { groupId: 'israel-network', persist: false });
          const prev = G.getVerifiedControlState('israel-network');
          const r = F.checkDelegationPackage(cases[k].ev, cases[k].att, prev, root, signer, F.DELEGATION_CHANGE.ACTIVATE);
          out[k] = r.ok ? 'PASS' : r.code;
        }
        return out;
      },
      { genesis, gAtt, cases: Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, { ev: v.ev, att: v.att }])), root: A.pub, signer: COSIGN.pub }
    );
    const negKeys = Object.keys(pre).filter((k) => k !== 'real');
    set('GATE2_PREPUBLISH_VALIDATION_REAL_PASSES', pre.real === 'PASS', pre.real);
    set('GATE2_PREPUBLISH_VALIDATION_NEGATIVES', negKeys.every((k) => pre[k] !== 'PASS'), pre);

    // ---- revocation path (local only): owner deactivates with step-up
    await openAdvanced(ua.page);
    const rev = await ownerAction(ua.page, 'sosGapDeactivateAdmission', TEST_PIN, 'הושבת$|נכשלה|אינו |אין |עדיין');
    await sleep(800);
    const revEv = relays[0].all([39001]).find((e) => JSON.parse(e.content).controlEpoch === 3);
    const revAtt = revEv ? relays[0].all([39004]).find((a) => (a.tags.find((t) => t[0] === 'e') || [])[1] === revEv.id) : null;
    const revBody = revEv ? JSON.parse(revEv.content) : {};
    const revAttBody = revAtt ? JSON.parse(revAtt.content) : {};
    const h4 = await waitHealth((h) => h.controlEpoch === 3, 40000);
    set(
      'DELEGATION_REVOCATION_PATH_READY',
      rev.stepUp &&
        rev.msg === 'שירות קבלת החברים הושבת' &&
        !!revEv &&
        JSON.stringify(revBody.capabilities) === '{}' &&
        JSON.stringify(revAttBody.operations) === '["REVOKE_ADMISSION_DELEGATION"]' &&
        revAttBody.stepUp === true &&
        h4 && h4.delegationActive === false && h4.controlEpoch === 3,
      { msg: rev.msg, caps: revBody.capabilities, ops: revAttBody.operations, serviceActive: h4 && h4.delegationActive }
    );

    // ---- service ingest negatives: root-signed re-delegation without / with forged attestation stays rejected
    const t5 = Math.floor(Date.now() / 1000);
    const reDel = finalizeEvent({ kind: 39001, created_at: t5, tags: [['d', GROUP + ':4'], ['t', GROUP], ['sos-control', 'v1']], content: JSON.stringify(Object.assign({}, revBody, { controlEpoch: 4, createdAt: t5, capabilities: { [SVC.pub]: [ADM] } })) }, A.sk);
    const [reDraft] = await drafts([{ event: reDel, ops: ['CREATE_ADMISSION_DELEGATION'], epoch: 4, issuedAt: t5, requestId: reqId() }]);
    const forgedRe = finalizeEvent(reDraft, X.sk);
    const i1 = await admPost('/v1/control/ingest', { events: [genesis, delegation, revEv, reDel], attestations: [gAtt, dAtt, revAtt] });
    const i2 = await admPost('/v1/control/ingest', { events: [reDel], attestations: [forgedRe] });
    const h5 = await health();
    set('SERVICE_REJECTS_UNATTESTED_OR_FORGED_ROOT_EVENT', h5.controlEpoch === 3 && h5.delegationActive === false, { i1: i1.controlEpoch, i2: i2.controlEpoch, epoch: h5.controlEpoch, active: h5.delegationActive });
    const wrongGroupIngest = await fetch(ADM_URL + '/v1/control/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: 'other-network' }) }).then((r) => r.json());
    set('SERVICE_REFRESH_WRONG_GROUP_REJECTED', wrongGroupIngest.code === 'WRONG_GROUP', wrongGroupIngest);

    const secrets = [TEST_PIN, COSIGN.hex, PIN_PEPPER, SVC.hex, A.hex];
    set('NO_SECRETS_IN_SERVICE_LOG', !secrets.some((s) => admLog.includes(s)));
    set('NO_PAGE_ERRORS', !pageErrors.length, pageErrors);
  } catch (e) {
    set('GATE_EXCEPTION', false, String((e && e.stack) || e).slice(0, 600));
  } finally {
    await browser.close().catch(() => {});
    server.close();
    for (const r of relays) await r.stop().catch(() => {});
    stopAdmission(false);
  }
  const vals = Object.values(report.results);
  report.passed = vals.filter((r) => r.ok).length;
  report.total = vals.length;
  report.status = vals.length && vals.every((r) => r.ok) ? 'PASS' : 'FAIL';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nGATE2_DELEGATION_LOCAL=${report.status} (${report.passed}/${report.total})`);
  process.exit(report.status === 'PASS' ? 0 : 1);
}

main();
