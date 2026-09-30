/**
 * Gate 1.5 activation gate (ACCESS_CONTROL_V2 OFF, Admin 2FA enforcement ON — the production flag state for Gate 1.5).
 *
 * - Two local NIP-01 relays; config.js served with SAFE_DEFAULT_RELAYS -> local relays and the first-group root ->
 *   disposable test root A; admission URL -> local `wrangler dev --local` service with disposable keys (.dev.vars,
 *   deleted on exit). runtime-feature-flags.json is served as the production shape with the local co-sign pubkey.
 * - The root opens "ניהול הקבוצה" with a server PIN session and clicks "הפעלת מערכת הניהול" in "הגדרות מתקדמות".
 * - Checks: attested genesis only (39004 then 39001, no 39003), genesis pins the signer, clean verifier sees
 *   VERIFIED, second activation refused, non-root refused, writes stay disabled, negatives rejected.
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
const OUT = path.join(ROOT, 'qa', 'gate15-activation-report.json');
const PORT = Number(process.env.SOS_G15_PORT || 8797);
const RELAY_PORTS = [7781, 7782];
const RELAYS = RELAY_PORTS.map((p) => `ws://127.0.0.1:${p}`);
const URL0 = `http://127.0.0.1:${PORT}/videos.html`;
const ADM_PORT = Number(process.env.SOS_G15_ADM_PORT || 8796);
const ADM_URL = `http://127.0.0.1:${ADM_PORT}`;
const ADM_DIR = path.join(ROOT, 'admission-service');
const PROD_ROOT = 'ede1e7fabb758aca75ae548680a206a234c6d6b257834b111d284c3692e67601';
const GROUP = 'israel-network';

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

const report = { gate: 'GATE15_ACTIVATION', status: 'FAIL', ts: new Date().toISOString(), results: {} };
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
  return Object.assign({}, prod, { admin2faSignerPubkey: COSIGN.pub });
};
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
const admPersist = path.join(os.tmpdir(), 'sosg15-adm-' + Date.now());
async function startAdmission(rootPub) {
  fs.writeFileSync(
    path.join(ADM_DIR, '.dev.vars'),
    `ROOT_PUBKEY=${rootPub}\nADMISSION_SK=${hex(generateSecretKey())}\nADMIN_COSIGN_SK=${COSIGN.hex}\nADMIN_PIN_PEPPER=${PIN_PEPPER}\nTEST_FAULTS=1\nALLOWED_ORIGINS=http://127.0.0.1:${PORT}\n`
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
    return {
      open: window.NostrApp.GroupAdminProductUi.isOpen(),
      status: st ? st.getAttribute('data-status') : '',
      text: st ? st.textContent.trim() : '',
      activate: !!document.getElementById('sosGapActivateControl'),
      signer: document.getElementById('sosGapAdmin2faSigner')?.textContent || '',
      enabledMutations: shell ? Array.from(shell.querySelectorAll('[data-mutation]')).filter((b) => !b.disabled).length : -1,
      msg: document.getElementById('sosGapMsg')?.textContent || '',
      v2: window.SOS_ACCESS_CONTROL_V2 === true,
    };
  });
}

async function main() {
  const A = mkKey();
  const M = mkKey();
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
    const env = await ua.page.evaluate(() => ({
      v2: window.SOS_ACCESS_CONTROL_V2 === true,
      enforced: window.NostrApp.Admin2faProtocol.isEnforced(),
      signer: window.NostrApp.Admin2faProtocol.activeSignerPubkey(),
      relays: window.NostrApp.relayUrls,
    }));
    set('ENV_PRODUCTION_FLAG_SHAPE', !env.v2 && env.enforced && env.signer === COSIGN.pub && RELAYS.every((u) => env.relays.includes(u)), env);

    // ---- non-root cannot activate; nothing published
    const mRes = await um.page.evaluate(async () => ({
      menu: window.NostrApp.GroupAdminProductUi.canSeeGroupControl(),
      act: (await window.NostrApp.FirstGroupAdmin.activateGroupControl()).code,
    }));
    set('NON_ROOT_CANNOT_ACTIVATE', !mRes.menu && mRes.act === 'FIRST_GROUP_ROOT_NOT_CONFIGURED' && relayCounts().every((c) => c.c39001 === 0 && c.c39004 === 0), mRes);

    // ---- root: panel needs a server PIN session; then the activation button appears only after the relay probe
    const pinCode = await ua.page.evaluate(async (pin) => (await window.NostrApp.AdminPinLock.setupPin(pin, pin)).code, TEST_PIN);
    await ua.page.evaluate(() => window.NostrApp.GroupAdminProductUi.open('members'));
    await ua.page.waitForFunction(() => !!document.getElementById('sosGapActivateControl'), null, { polling: 200, timeout: 30000 }).catch(() => {});
    const before = await uiState(ua.page);
    set(
      'BEFORE_INACTIVE_WITH_ACTIVATE_BUTTON',
      pinCode === 'PIN_SET' && before.open && before.status === 'CONTROL_PLANE_NOT_ACTIVE' && /עדיין לא הופעלה/.test(before.text) && before.activate && before.enabledMutations === 0,
      { pinCode, ...before }
    );

    // ---- activate through the UI (confirm dialog)
    await ua.page.evaluate(() => {
      const d = document.getElementById('sosGapAdvanced');
      if (d) d.open = true;
      document.getElementById('sosGapActivateControl').click();
    });
    await ua.page.waitForFunction(() => document.getElementById('sosGapConfirm')?.classList.contains('is-open'), null, { polling: 100, timeout: 15000 });
    const confirmText = await ua.page.evaluate(() => document.getElementById('sosGapConfirmText').textContent);
    await ua.page.evaluate(() => document.getElementById('sosGapConfirmOk').click());
    await ua.page.waitForFunction(() => /הופעלה|נכשלה|אינו זמין|אין /.test(document.getElementById('sosGapMsg')?.textContent || ''), null, { polling: 200, timeout: 60000 }).catch(() => {});
    const msg = await ua.page.evaluate(() => document.getElementById('sosGapMsg')?.textContent || '');
    await sleep(800);
    const counts = relayCounts();
    set('ACTIVATE_VIA_UI', msg === 'מערכת הניהול הופעלה' && /חד־פעמית/.test(confirmText), { msg });
    set(
      'PUBLISHED_ATTESTED_GENESIS_ONLY',
      counts.every((c) => c.c39001 === 1 && c.c39004 === 1 && c.c39003 === 0 && c.order[0] === 39004 && c.order[1] === 39001),
      counts
    );

    const genesis = relays[0].all([39001])[0];
    const att = relays[0].all([39004])[0];
    const body = genesis ? JSON.parse(genesis.content) : {};
    const attBody = att ? JSON.parse(att.content) : {};
    set(
      'GENESIS_SHAPE',
      !!genesis &&
        genesis.pubkey === A.pub &&
        JSON.stringify(genesis.tags) === JSON.stringify([['d', GROUP + ':1'], ['t', GROUP], ['sos-control', 'v1']]) &&
        body.groupId === GROUP && body.controlEpoch === 1 && body.membershipEpoch === 1 && body.rootAdminPubkey === A.pub &&
        JSON.stringify(body.capabilities) === '{}' && JSON.stringify(body.blockedPubkeys) === '[]' && body.invitePolicy === 'AUTHORIZED_USERS_ONLY' &&
        body.groupSettings && body.groupSettings.displayName === 'SOS' && body.groupSettings.networkTag === GROUP,
      { tags: genesis && genesis.tags, keys: Object.keys(body).sort() }
    );
    set('ADMIN_2FA_SIGNER_PINNED_IN_GENESIS', body.admin2faSignerPubkey === COSIGN.pub, { signer: body.admin2faSignerPubkey });
    set(
      'ATTESTATION_BINDS_GENESIS',
      !!att && att.pubkey === COSIGN.pub && (att.tags.find((t) => t[0] === 'e') || [])[1] === genesis.id && attBody.eventId === genesis.id &&
        JSON.stringify(attBody.operations) === '["BOOTSTRAP_GROUP_CONTROL"]' && attBody.rootPubkey === A.pub && attBody.groupId === GROUP && attBody.controlEpoch === 1,
      { operations: attBody.operations, controlEpoch: attBody.controlEpoch }
    );

    // ---- after: control recognized, writes still off, button gone
    await ua.page.waitForFunction(() => document.getElementById('sosGapControlStatus')?.getAttribute('data-status') === 'CONTROL_ACTIVE_WRITES_OFF', null, { polling: 200, timeout: 30000 }).catch(() => {});
    const after = await uiState(ua.page);
    set(
      'AFTER_ACTIVE_WRITES_OFF',
      after.status === 'CONTROL_ACTIVE_WRITES_OFF' && /הופעלה/.test(after.text) && !after.activate && after.enabledMutations === 0 && !after.v2 && after.signer.includes(COSIGN.pub),
      after
    );
    await ua.page.screenshot({ path: path.join(ROOT, 'qa', 'gate15-activation-after.png') }).catch(() => {});

    const again = await ua.page.evaluate(async () => (await window.NostrApp.FirstGroupAdmin.activateGroupControl()).code);
    set('SECOND_ACTIVATION_REFUSED', again === 'ALREADY_BOOTSTRAPPED' && relayCounts().every((c) => c.c39001 === 1), { again });

    // ---- independent clean verifier (no identity, no local state)
    const uc = await newUser(browser, 'CLEAN');
    const clean = await uc.page.evaluate(async () => {
      const r = await window.NostrApp.FirstGroupAdmin.probeNetworkControl();
      return { status: r.status, epoch: r.controlEpoch, root: r.rootAdminPubkey, signer: r.admin2faSignerPubkey, eventId: r.eventId, identity: !!window.NostrApp.publicKey };
    });
    set('CLEAN_VERIFIER_ACTIVE', clean.status === 'VERIFIED' && clean.epoch === 1 && clean.root === A.pub && clean.signer === COSIGN.pub && clean.eventId === genesis.id && !clean.identity, clean);

    // ---- negatives in the clean verifier (enforcement on)
    const now = Math.floor(Date.now() / 1000);
    const X = mkKey();
    const signGenesis = (sk, patch, tags) =>
      finalizeEvent({ kind: 39001, created_at: now, tags: tags || [['d', GROUP + ':1'], ['t', GROUP], ['sos-control', 'v1']], content: JSON.stringify(Object.assign({}, body, { createdAt: now }, patch || {})) }, sk);
    const forgedAtt = finalizeEvent({ kind: 39004, created_at: att.created_at, tags: att.tags, content: att.content }, X.sk);
    const rootNoAtt = signGenesis(A.sk, { groupSettings: { displayName: 'SOS2', networkTag: GROUP } });
    const wrongRoot = signGenesis(X.sk, { rootAdminPubkey: X.pub });
    const wrongGroup = signGenesis(A.sk, { groupId: 'other-network', groupSettings: { displayName: 'SOS', networkTag: 'other-network' } }, [['d', 'other-network:1'], ['t', 'other-network'], ['sos-control', 'v1']]);
    const wrongSigner = signGenesis(A.sk, { admin2faSignerPubkey: X.pub });
    const takeover = signGenesis(X.sk, { controlEpoch: 2, rootAdminPubkey: X.pub }, [['d', GROUP + ':2'], ['t', GROUP], ['sos-control', 'v1']]);
    const neg = await uc.page.evaluate(
      ({ genesis, att, forgedAtt, rootNoAtt, wrongRoot, wrongGroup, wrongSigner, takeover }) => {
        const App = window.NostrApp;
        const G = App.GroupControlState;
        const P = App.Admin2faProtocol;
        const one = (ev, atts) => {
          G.clearAllStores();
          P.clearAttestations();
          if (atts) P.ingestAttestations(atts);
          const r = G.acceptControlEvent(ev, { groupId: 'israel-network', persist: false });
          return { ok: !!r.ok, code: r.code || r.status };
        };
        const out = {
          realWithAtt: one(genesis, [att]),
          realWithoutAtt: one(genesis, []),
          forgedAttestation: one(genesis, [forgedAtt]),
          rootOnlyNoAttestation: one(rootNoAtt, []),
          rootWithOtherEventsAttestation: one(rootNoAtt, [att]),
          wrongRoot: one(wrongRoot, []),
          wrongGroup: one(wrongGroup, [att]),
          wrongSigner: one(wrongSigner, []),
        };
        G.clearAllStores();
        P.clearAttestations();
        P.ingestAttestations([att]);
        G.acceptControlEvent(genesis, { groupId: 'israel-network', persist: false });
        G.acceptControlEvent(rootNoAtt, { groupId: 'israel-network', persist: false });
        G.acceptControlEvent(takeover, { groupId: 'israel-network', persist: false });
        const tip = G.getVerifiedControlState('israel-network');
        const tipEv = G.getVerifiedControlEvent('israel-network');
        out.competingAndTakeover = { status: G.getStatus('israel-network'), tipIsGenesis: !!tipEv && tipEv.id === genesis.id, epoch: tip && tip.controlEpoch, root: tip && tip.rootAdminPubkey };
        return out;
      },
      { genesis, att, forgedAtt, rootNoAtt, wrongRoot, wrongGroup, wrongSigner, takeover }
    );
    const selfGrant = {};
    for (const transition of ['GRANT_ACTIVE', 'BOOTSTRAP_ACTIVE']) {
      const draft = await uc.page.evaluate(
        ({ root, transition }) => {
          try {
            return { draft: window.NostrApp.MembershipState.buildMembershipDraft({ memberPubkey: root, transition }) };
          } catch (e) {
            return { code: (e && e.code) || 'THREW' };
          }
        },
        { root: A.pub, transition }
      );
      if (!draft.draft) {
        selfGrant[transition] = { ok: false, code: 'DRAFT_' + draft.code };
        continue;
      }
      const signed = finalizeEvent({ kind: draft.draft.kind, created_at: draft.draft.created_at, tags: draft.draft.tags, content: draft.draft.content }, A.sk);
      selfGrant[transition] = await uc.page.evaluate((e) => {
        const App = window.NostrApp;
        const r = App.MembershipState.acceptMembershipEvent(e, App.GroupControlState.getVerifiedControlState('israel-network'), { groupId: 'israel-network' });
        return { ok: !!(r && r.ok), code: r && r.code };
      }, signed);
    }
    neg.selfGrantMembership = { ok: Object.values(selfGrant).some((r) => r.ok), detail: selfGrant, allSelfGrant: Object.values(selfGrant).every((r) => ['SELF_GRANT', 'V2_REQUIRED'].includes(r.code) || /^DRAFT_/.test(r.code)) };
    set('NEG_REAL_GENESIS_ACCEPTED_WITH_ATTESTATION', neg.realWithAtt.ok, neg.realWithAtt);
    set('NEG_GENESIS_WITHOUT_ATTESTATION_REJECTED', !neg.realWithoutAtt.ok, neg.realWithoutAtt);
    set('NEG_FORGED_ATTESTATION_REJECTED', !neg.forgedAttestation.ok, neg.forgedAttestation);
    set('NEG_ROOT_ONLY_BOOTSTRAP_REJECTED', !neg.rootOnlyNoAttestation.ok, neg.rootOnlyNoAttestation);
    set('NEG_ATTESTATION_OTHER_EVENT_ID_REJECTED', !neg.rootWithOtherEventsAttestation.ok, neg.rootWithOtherEventsAttestation);
    set('NEG_WRONG_ROOT_REJECTED', !neg.wrongRoot.ok, neg.wrongRoot);
    set('NEG_WRONG_GROUP_REJECTED', !neg.wrongGroup.ok, neg.wrongGroup);
    set('NEG_WRONG_SIGNER_REJECTED', !neg.wrongSigner.ok, neg.wrongSigner);
    set(
      'NEG_COMPETING_GENESIS_AND_ROOT_REPLACEMENT_REJECTED',
      neg.competingAndTakeover.status === 'VERIFIED' && neg.competingAndTakeover.tipIsGenesis && neg.competingAndTakeover.epoch === 1 && neg.competingAndTakeover.root === A.pub,
      neg.competingAndTakeover
    );
    set('NEG_SELF_GRANT_MEMBERSHIP_REJECTED', !neg.selfGrantMembership.ok && neg.selfGrantMembership.allSelfGrant, neg.selfGrantMembership);

    const pinLeak = admLog.includes(TEST_PIN) || [COSIGN.hex, PIN_PEPPER].some((s) => admLog.includes(s));
    set('NO_SECRETS_IN_SERVICE_LOG', !pinLeak);
    set('NO_PAGE_ERRORS', !pageErrors.length, pageErrors);
  } catch (e) {
    set('GATE_EXCEPTION', false, String((e && e.stack) || e).slice(0, 600));
  } finally {
    await browser.close().catch(() => {});
    server.close();
    for (const r of relays) await r.stop().catch(() => {});
    stopAdmission();
  }
  const vals = Object.values(report.results);
  report.passed = vals.filter((r) => r.ok).length;
  report.total = vals.length;
  report.status = vals.length && vals.every((r) => r.ok) ? 'PASS' : 'FAIL';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nGATE15_ACTIVATION=${report.status} (${report.passed}/${report.total})`);
  process.exit(report.status === 'PASS' ? 0 : 1);
}

main();
