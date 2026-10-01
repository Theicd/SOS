/**
 * F5B6-W / Blocker 1 — Worker identity recovery E2E (local, disposable identity only).
 *
 * Main app (this repo) on http://127.0.0.1:8788 with two local NIP-01 relays; isolated signer
 * (C:\BRAIN\SOS-signer-f5b6w, tools/dev-server.mjs) on http://localhost:8787.
 *
 * Flow: real onboarding (Worker create) -> truthful key step -> logout guard -> "גיבוי לשחזור החשבון"
 * -> signer handoff popup (sealed envelope) -> Passkey enroll (CDP virtual authenticator) -> F5B5 reveal
 * -> confirm inside signer -> backup confirmed on main -> logout -> clean browser -> login with the
 * recovery key -> same public key.
 *
 * The recovery key is read only from the signer canvas draw call (what the user reads on screen),
 * kept in memory, compared in Node, and never printed, logged or written to the report.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { verifyEvent, getPublicKey, nip19 } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SIGNER_ROOT = process.env.SOS_SIGNER_ROOT || 'C:\\BRAIN\\SOS-signer-f5b6w';
const OUT = path.join(ROOT, 'qa', 'f5b6w-recovery-e2e-report.json');
const PORT = 8788;
const SIGNER_PORT = 8787;
const SIGNER_ORIGIN = `http://localhost:${SIGNER_PORT}`;
const MAIN_ORIGIN = `http://127.0.0.1:${PORT}`;
const RELAY_PORTS = [7791, 7792];
const RELAYS = RELAY_PORTS.map((p) => `ws://127.0.0.1:${p}`);
const URL0 = `${MAIN_ORIGIN}/videos.html`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { gate: 'F5B6W_RECOVERY_E2E', status: 'FAIL', ts: new Date().toISOString(), results: {} };
const SECRET_SHAPE = /nsec1[a-z0-9]{20,}/i;
function safeDetail(detail) {
  if (detail === undefined) return null;
  const s = JSON.stringify(detail);
  if (SECRET_SHAPE.test(s) || /[0-9a-f]{64}/i.test(s)) return '[redacted]';
  return detail;
}
const set = (k, ok, detail) => {
  const d = safeDetail(detail);
  report.results[k] = { ok: !!ok, detail: d };
  console.log(ok ? 'PASS' : 'FAIL', k, d === null ? '' : JSON.stringify(d).slice(0, 300));
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
    this.rawFrames = [];
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
    const raw = String(data);
    this.rawFrames.push(raw);
    let m;
    try {
      m = JSON.parse(raw);
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
}
const relays = RELAY_PORTS.map((p) => new TestRelay(p));

// ---------------------------------------------------------------- main static server
function transformConfig(src) {
  return src
    .replace(/const SAFE_DEFAULT_RELAYS = \[[^\]]*\];/, () => `const SAFE_DEFAULT_RELAYS = ${JSON.stringify(RELAYS)};`)
    .replace(/const SAFE_DEFAULT_P2P_RELAYS = \[[^\]]*\];/, () => `const SAFE_DEFAULT_P2P_RELAYS = ${JSON.stringify(RELAYS)};`)
    .replace("!trimmed.startsWith('wss://')", () => "!(trimmed.startsWith('wss://') || trimmed.startsWith('ws://127.0.0.1:'))");
}
function startMainServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp' };
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

// ---------------------------------------------------------------- signer dev server
function startSigner() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SIGNER_ROOT, 'tools', 'dev-server.mjs')], {
      cwd: SIGNER_ROOT,
      env: { ...process.env, SIGNER_PORT: String(SIGNER_PORT), MAIN_PORT: '8789' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    const onData = (buf) => {
      if (!ready && /READY/.test(buf.toString())) {
        ready = true;
        setTimeout(() => resolve(child), 300);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    setTimeout(() => {
      if (!ready) reject(new Error('signer dev-server did not start'));
    }, 8000);
  });
}

// ---------------------------------------------------------------- browser helpers
const ALLOWED = new Set(['127.0.0.1', 'localhost', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']);
const consoleTexts = [];
const networkPayloads = [];

async function newContext(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.route('**/*', (route) => {
    let host = '';
    try {
      host = new URL(route.request().url()).hostname;
    } catch (_e) {}
    return ALLOWED.has(host) ? route.continue() : route.abort();
  });
  await ctx.addInitScript(() => {
    if (location.hostname === '127.0.0.1') {
      try {
        Object.defineProperty(navigator, 'serviceWorker', { get: () => undefined, configurable: true });
      } catch (_e) {}
      try {
        localStorage.setItem('nostr_require_invite', '0');
      } catch (_e) {}
      const msgs = [];
      Object.defineProperty(window, '__qaMsgs', { value: msgs });
      window.addEventListener(
        'message',
        (ev) => {
          try {
            msgs.push(ev.origin + ' ' + JSON.stringify(ev.data));
          } catch (_e) {}
        },
        true,
      );
    }
    if (location.hostname === 'localhost') {
      const cap = [];
      Object.defineProperty(window, '__qaRevealCapture', { value: cap });
      const orig = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (t, ...rest) {
        if (this.canvas && this.canvas.id === 'nsecCanvas') cap.push(String(t));
        return orig.call(this, t, ...rest);
      };
    }
  });
  ctx.on('request', (req) => {
    networkPayloads.push(req.url() + ' ' + (req.postData() || ''));
  });
  ctx.on('page', (page) => {
    page.on('console', (m) => consoleTexts.push(m.text()));
    page.on('websocket', (ws) => ws.on('framesent', (f) => networkPayloads.push(String(f.payload || ''))));
  });
  return ctx;
}

async function addVirtualAuthenticator(page) {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return client;
}

async function openMain(ctx) {
  const page = await ctx.newPage();
  await page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(
    () => !!window.NostrApp?.openAuthPrompt && !!window.SosCryptoWorkerVault && !!window.SosRecoveryBackup && !!window.NostrApp?.logoutIdentity,
    null,
    { polling: 200, timeout: 120000 },
  );
  return page;
}

function containsSecret(texts, kHex, nsec) {
  return texts.some((t) => {
    const s = String(t || '').toLowerCase();
    return (kHex && s.includes(kHex)) || (nsec && s.includes(nsec.toLowerCase()));
  });
}

// ---------------------------------------------------------------- main
async function main() {
  for (const r of relays) await r.start();
  const server = await startMainServer();
  const signer = await startSigner();
  const browser = await chromium.launch({ headless: true });
  let recoveryKey = '';
  let kHex = '';
  let stage = 'boot';
  let popup = null;
  try {
    const ctxA = await newContext(browser);
    const page = await openMain(ctxA);

    // ---- 1. real onboarding up to the key step
    await page.evaluate(() => window.NostrApp.openAuthPrompt('', { step: 'email' }));
    await page.fill('#signupEmailInput', `f5b6w-${crypto.randomBytes(4).toString('hex')}@example.test`);
    await page.check('#signupLegalAgree');
    await page.click('#btnEmailNext');
    await page.waitForSelector('#authStepName', { state: 'visible', timeout: 30000 });
    await page.fill('#signupNameInput', 'F5B6W');
    await page.click('#btnNameNext');
    await page.click('#btnSkipAvatar');
    await page.waitForSelector('#authStepKey', { state: 'visible', timeout: 10000 });
    const keyStep = await page.evaluate(() => {
      const vis = (id) => {
        const el = document.getElementById(id);
        return !!(el && !el.hidden && el.offsetParent !== null);
      };
      const ta = document.getElementById('generatedKeyDisplay');
      return {
        workerIntro: vis('workerKeyIntro'),
        textareaVisible: vis('generatedKeyDisplay'),
        textareaValueLen: ta ? ta.value.length : 0,
        copyVisible: vis('btnCopyKey'),
        downloadVisible: vis('btnDownloadKey'),
        legacyConfirmVisible: vis('legacyKeyConfirm'),
        legacyWarningVisible: vis('legacyKeyWarning'),
      };
    });
    set(
      'ONBOARDING_KEY_STEP_WORKER_MODE',
      keyStep.workerIntro && !keyStep.textareaVisible && keyStep.textareaValueLen === 0 && !keyStep.copyVisible && !keyStep.downloadVisible && !keyStep.legacyConfirmVisible && !keyStep.legacyWarningVisible,
      keyStep,
    );

    await page.check('#keyPolicyAgree');
    await page.check('#keyRightsConfirm');
    await page.waitForFunction(() => document.getElementById('btnFinalConnect')?.disabled === false, null, { timeout: 5000 });
    await page.click('#btnFinalConnect');
    await page.waitForSelector('#workerIdentityDone', { state: 'visible', timeout: 60000 });
    const done = await page.evaluate(() => {
      const App = window.NostrApp;
      const pk = String(App.publicKey || '').toLowerCase();
      const panel = document.getElementById('workerIdentityDone');
      const vis = (id) => {
        const el = document.getElementById(id);
        return !!(el && !el.hidden && el.offsetParent !== null);
      };
      return {
        pkOk: /^[0-9a-f]{64}$/.test(pk),
        pubShown: document.getElementById('workerIdentityPubkey')?.textContent === pk,
        fpShown: (document.getElementById('workerIdentityFingerprint')?.textContent || '').startsWith(pk.slice(0, 8)),
        successText: /הזהות שלך נוצרה בהצלחה/.test(panel.textContent),
        truthText: /המפתח הפרטי שלך נשמר במנגנון האבטחה של SOS ואינו מוצג במסך הרגיל/.test(panel.textContent),
        statusNotCreated: /טרם נוצר/.test(document.getElementById('recoveryBackupStatus')?.textContent || ''),
        backupBtn: vis('btnRecoveryBackup') && /גיבוי לשחזור החשבון/.test(document.getElementById('btnRecoveryBackup').textContent),
        oldConfirmVisible: vis('legacyKeyConfirm'),
        textareaVisible: vis('generatedKeyDisplay'),
        claimsRecoverable: /ניתן לשחזר|שוחזר|נוצר ואושר/.test(panel.textContent),
        worker: App.SosCryptoSigner?.isWorkerAuthoritative?.() === true,
        privInMemory: !!App.privateKey,
        needsBackup: window.SosRecoveryBackup.needsBackup(),
      };
    });
    set(
      'ONBOARDING_TRUTHFUL_DONE_STATE',
      done.pkOk && done.pubShown && done.fpShown && done.successText && done.truthText && done.statusNotCreated && done.backupBtn && !done.oldConfirmVisible && !done.textareaVisible && !done.claimsRecoverable,
      done,
    );
    set('WORKER_IDENTITY_CREATED', done.worker && !done.privInMemory && done.needsBackup, { worker: done.worker, privInMemory: done.privInMemory });
    const originalPub = await page.evaluate(() => String(window.NostrApp.publicKey).toLowerCase());

    // ---- 2. logout guard before backup
    const guard = await page.evaluate(async () => {
      const App = window.NostrApp;
      const r = App.logoutIdentity({ redirect: false });
      const modal = !!document.getElementById('sosRecoveryLogoutGuard');
      const stillPk = String(App.publicKey || '').toLowerCase();
      const meta = await window.SosCryptoWorkerVault.rpc('GET_IDENTITY_META', {}).catch((e) => ({ err: e && e.code }));
      const destroyDisabled = document.getElementById('sosRecoveryGuardDestroy')?.disabled === true;
      const hasBackupBtn = /צור גיבוי לשחזור/.test(document.getElementById('sosRecoveryGuardBackup')?.textContent || '');
      document.getElementById('sosRecoveryGuardCancel')?.click();
      return { blocked: r && r.blocked === true, result: r && r.result, modal, stillPk, metaPk: meta && meta.pubkey, destroyDisabled, hasBackupBtn };
    });
    set(
      'WORKER_ACCOUNT_LOGOUT_WITHOUT_BACKUP_PROTECTED',
      guard.blocked && guard.result === 'LOGOUT_BLOCKED_NO_RECOVERY_BACKUP' && guard.modal && guard.stillPk === originalPub && guard.metaPk === originalPub && guard.destroyDisabled && guard.hasBackupBtn,
      { blocked: guard.blocked, result: guard.result, modal: guard.modal, destroyDisabled: guard.destroyDisabled, hasBackupBtn: guard.hasBackupBtn, metaSame: guard.metaPk === originalPub },
    );

    // ---- 3. forged confirmation from a non-signer origin is ignored
    const forged = await page.evaluate(async (pk) => {
      window.postMessage({ protocol: 1, type: 'SOS_F5B6W_BACKUP_CONFIRMED', sessionId: 'ab'.repeat(16), pubkey: pk }, '*');
      await new Promise((r) => setTimeout(r, 300));
      return window.SosRecoveryBackup.isBackupConfirmed(pk);
    }, originalPub);
    set('FORGED_BACKUP_CONFIRMATION_IGNORED', forged === false);

    // ---- 4. start backup from the onboarding button -> signer handoff popup
    const states = [];
    await page.exposeFunction('__qaState', (s) => states.push(s));
    await page.evaluate(() => window.addEventListener('sos-recovery-backup-state', (ev) => window.__qaState(ev.detail && ev.detail.state)));
    stage = 'handoff';
    [popup] = await Promise.all([ctxA.waitForEvent('page', { timeout: 15000 }), page.click('#btnRecoveryBackup')]);
    await addVirtualAuthenticator(popup);
    await popup.waitForSelector('#panelImported', { state: 'visible', timeout: 30000 });
    await sleep(500);
    const afterHandoff = await page.evaluate((pk) => window.SosRecoveryBackup.isBackupConfirmed(pk), originalPub);
    set('HANDOFF_IMPORTED_INTO_SIGNER', states.includes('SEALED') && states.includes('IN_SIGNER'), { states });
    set('BACKUP_NOT_CONFIRMED_BEFORE_REVEAL', afterHandoff === false);
    const popupUrl = popup.url();
    set('HANDOFF_URL_HAS_NO_SECRET', /^http:\/\/localhost:8787\/handoff/.test(popupUrl) && !/nsec|privateKey|[?&]k=/i.test(popupUrl));

    // ---- 5. signer: enroll Passkey -> export -> reveal
    stage = 'export-not-enrolled';
    await popup.click('#continueToExport');
    await popup.waitForLoadState('domcontentloaded');
    await popup.waitForFunction(() => !!document.getElementById('panelNotEnrolled') && !document.getElementById('panelNotEnrolled').hidden, null, { timeout: 15000 });
    stage = 'enroll';
    await popup.click('#enrollLink');
    await popup.waitForSelector('#enrollBtn', { timeout: 15000 });
    await popup.waitForFunction(() => /^ready /.test(document.getElementById('status')?.textContent || ''), null, { timeout: 15000 });
    await popup.fill('#labelInput', 'f5b6w-e2e');
    await popup.click('#enrollBtn');
    await popup.waitForFunction(() => parseInt(document.getElementById('credCount')?.textContent || '0', 10) >= 1, null, { timeout: 20000 });
    set('PASSKEY_ENROLLED', true);
    stage = 'export-ready';
    await popup.click('#continueToExport');
    await popup.waitForSelector('#continueBtn', { state: 'visible', timeout: 15000 });
    stage = 'reveal';
    await popup.click('#continueBtn');
    await popup.waitForFunction(() => window.__F5B5_WA4?.getUiState?.() === 'revealed', null, { timeout: 20000 });
    stage = 'confirm';
    recoveryKey = await popup.evaluate(() => window.__qaRevealCapture.slice(-2).join(''));
    let decodedOk = false;
    try {
      const d = nip19.decode(recoveryKey);
      if (d.type === 'nsec') {
        kHex = Buffer.from(d.data).toString('hex');
        decodedOk = getPublicKey(d.data) === originalPub;
      }
    } catch (_e) {}
    set('RECOVERY_MATERIAL_VALID_FOR_SAME_IDENTITY', decodedOk);

    await popup.waitForSelector('#panelBackupConfirm', { state: 'visible', timeout: 10000 });
    const beforeConfirm = await page.evaluate((pk) => window.SosRecoveryBackup.isBackupConfirmed(pk), originalPub);
    await popup.click('#backupConfirmBtn');
    await page.waitForFunction((pk) => window.SosRecoveryBackup.isBackupConfirmed(pk), originalPub, { timeout: 10000 });
    const confirmedUi = await page.evaluate(() => ({
      status: document.getElementById('recoveryBackupStatus')?.textContent || '',
      btnHidden: document.getElementById('btnRecoveryBackup')?.hidden === true,
      needsBackup: window.SosRecoveryBackup.needsBackup(),
    }));
    set(
      'RECOVERY_BACKUP_CONFIRMED_ONLY_AFTER_REVEAL',
      beforeConfirm === false && states.includes('CONFIRMED') && /נוצר ואושר/.test(confirmedUi.status) && confirmedUi.btnHidden && confirmedUi.needsBackup === false,
      { beforeConfirm, states, needsBackup: confirmedUi.needsBackup },
    );

    // ---- 6. normal page exposure scans (main origin)
    const mainScan = await page.evaluate(() => {
      const dump = (st) => {
        const out = [];
        for (let i = 0; i < st.length; i++) {
          const k = st.key(i);
          out.push(k + '=' + st.getItem(k));
        }
        return out;
      };
      return {
        dom: document.documentElement.outerHTML,
        ls: dump(localStorage),
        ss: dump(sessionStorage),
        msgs: window.__qaMsgs.slice(),
        privMem: !!window.NostrApp.privateKey,
      };
    });
    set('PRIVATE_KEY_NORMAL_PAGE_EXPOSURE_DOM', !containsSecret([mainScan.dom], kHex, recoveryKey));
    set('PRIVATE_KEY_NORMAL_PAGE_EXPOSURE_STORAGE', !containsSecret(mainScan.ls.concat(mainScan.ss), kHex, recoveryKey) && !mainScan.privMem);
    set('PRIVATE_KEY_MESSAGES_TO_SOS010', !containsSecret(mainScan.msgs, kHex, recoveryKey), { messageCount: mainScan.msgs.length });
    set('PRIVATE_KEY_LOGGING', !containsSecret(consoleTexts, kHex, recoveryKey), { consoleLines: consoleTexts.length });
    const relayFrames = relays.flatMap((r) => r.rawFrames);
    set('PRIVATE_KEY_NETWORK_RETURN_TO_SOS010', !containsSecret(networkPayloads.concat(relayFrames), kHex, recoveryKey), { requests: networkPayloads.length, relayFrames: relayFrames.length });

    // ---- 7. adversarial Worker seal checks (no envelope is opened by the page)
    const adv = await page.evaluate(async (pk) => {
      const V = window.SosCryptoWorkerVault;
      const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const recip = Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)), (b) => b.toString(16).padStart(2, '0')).join('');
      const sid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      const tryRpc = async (op, params) => {
        try {
          const r = await V.rpc(op, params);
          return { ok: true, sealsRemaining: r && r.sealsRemaining, keys: Object.keys(r || {}) };
        } catch (e) {
          return { ok: false, code: (e && e.code) || String(e && e.message) };
        }
      };
      const exp = () => Date.now() + 60000;
      const out = {};
      out.wrongPubkey = await tryRpc('SEAL_IDENTITY_FOR_SIGNER', { sessionId: sid(), expectedPubkey: 'ab'.repeat(32), recipientPub: recip, exp: exp() });
      out.badRecipient = await tryRpc('SEAL_IDENTITY_FOR_SIGNER', { sessionId: sid(), expectedPubkey: pk, recipientPub: '04' + '00'.repeat(10), exp: exp() });
      out.longTtl = await tryRpc('SEAL_IDENTITY_FOR_SIGNER', { sessionId: sid(), expectedPubkey: pk, recipientPub: recip, exp: Date.now() + 10 * 60000 });
      out.injection = await tryRpc('SEAL_IDENTITY_FOR_SIGNER', { sessionId: sid(), expectedPubkey: pk, recipientPub: recip, exp: exp(), privateKey: 'ab'.repeat(32) });
      out.exportOp = await tryRpc('EXPORT_RAW_K', {});
      out.status1 = await tryRpc('GET_HANDOFF_STATUS', {});
      const fixed = sid();
      out.seal2 = await tryRpc('SEAL_IDENTITY_FOR_SIGNER', { sessionId: fixed, expectedPubkey: pk, recipientPub: recip, exp: exp() });
      out.replay = await tryRpc('SEAL_IDENTITY_FOR_SIGNER', { sessionId: fixed, expectedPubkey: pk, recipientPub: recip, exp: exp() });
      out.seal3 = await tryRpc('SEAL_IDENTITY_FOR_SIGNER', { sessionId: sid(), expectedPubkey: pk, recipientPub: recip, exp: exp() });
      out.seal4 = await tryRpc('SEAL_IDENTITY_FOR_SIGNER', { sessionId: sid(), expectedPubkey: pk, recipientPub: recip, exp: exp() });
      return out;
    }, originalPub);
    set('SEAL_WRONG_PUBKEY_REFUSED', !adv.wrongPubkey.ok && adv.wrongPubkey.code === 'HANDOFF_PUBKEY_MISMATCH', adv.wrongPubkey);
    set('SEAL_BAD_RECIPIENT_REFUSED', !adv.badRecipient.ok && adv.badRecipient.code === 'HANDOFF_BAD_RECIPIENT', adv.badRecipient);
    set('SEAL_LONG_TTL_REFUSED', !adv.longTtl.ok && adv.longTtl.code === 'HANDOFF_EXPIRED', adv.longTtl);
    set('SEAL_KEY_FIELD_INJECTION_REFUSED', !adv.injection.ok, adv.injection);
    set('RAW_EXPORT_OP_REFUSED', !adv.exportOp.ok, adv.exportOp);
    set('SEAL_COUNT_AFTER_REAL_HANDOFF', adv.status1.ok && adv.status1.sealsRemaining === 2, adv.status1);
    set('SEAL_REPLAY_REFUSED', adv.seal2.ok && !adv.replay.ok && adv.replay.code === 'HANDOFF_REPLAY', { seal2: adv.seal2.ok, replay: adv.replay.code });
    set('SEAL_LIFETIME_CAP_3', adv.seal3.ok && adv.seal3.sealsRemaining === 0 && !adv.seal4.ok && adv.seal4.code === 'HANDOFF_LIMIT_REACHED', { seal3: adv.seal3.ok, seal4: adv.seal4.code });
    set('SEAL_RESPONSE_HAS_NO_KEY_FIELDS', !(adv.seal2.keys || []).some((k) => /priv|nsec|rawkey|secret/i.test(k)), adv.seal2.keys);

    // ---- 8. signer-side origin / opener / framing checks
    const sigAdv = await page.evaluate(async ({ signer, pk }) => {
      const offers = [];
      const onMsg = (ev) => {
        if (ev.origin === signer && ev.data && ev.data.type === 'SOS_F5B6W_OFFER') offers.push(ev.data.sessionId);
      };
      window.addEventListener('message', onMsg);
      const evil = window.open(signer + '/handoff?protocol=1&expectedPubkey=' + pk + '&returnOrigin=' + encodeURIComponent('https://evil.example'), 'qa_evil', 'width=400,height=400');
      const other = window.open(signer + '/handoff?protocol=1&expectedPubkey=' + 'cd'.repeat(32) + '&returnOrigin=' + encodeURIComponent(location.origin), 'qa_other', 'width=400,height=400');
      await new Promise((r) => setTimeout(r, 2500));
      window.removeEventListener('message', onMsg);
      try { evil.close(); } catch (_e) {}
      try { other.close(); } catch (_e) {}
      return { offers: offers.length };
    }, { signer: SIGNER_ORIGIN, pk: originalPub });
    set('SIGNER_HANDOFF_FOREIGN_ORIGIN_OR_OTHER_IDENTITY_NO_OFFER', sigAdv.offers === 0, sigAdv);
    const noOpener = await (async () => {
      const p = await ctxA.newPage();
      await p.goto(`${SIGNER_ORIGIN}/handoff?protocol=1&expectedPubkey=${'cd'.repeat(32)}&returnOrigin=${encodeURIComponent(MAIN_ORIGIN)}`, { waitUntil: 'domcontentloaded' });
      await p.waitForFunction(() => !!window.__F5B6W, null, { timeout: 10000 });
      const boot = await p.evaluate(() => window.__F5B6W.boot);
      await p.close();
      return boot;
    })();
    set('SIGNER_HANDOFF_WITHOUT_OPENER_REFUSED', noOpener === 'BAD_REQUEST', { boot: noOpener });
    const framed = await (async () => {
      const p = await ctxA.newPage();
      await p.goto(URL0, { waitUntil: 'domcontentloaded' });
      await p.evaluate((src) => {
        const f = document.createElement('iframe');
        f.id = 'qaf';
        f.src = src;
        document.body.appendChild(f);
      }, `${SIGNER_ORIGIN}/handoff?protocol=1&expectedPubkey=${originalPub}&returnOrigin=${encodeURIComponent(MAIN_ORIGIN)}`);
      await sleep(1500);
      const frame = p.frames().find((f) => /localhost:8787\/handoff/.test(f.url()));
      let boot = 'NOT_LOADED';
      if (frame) {
        try {
          boot = await frame.evaluate(() => (window.__F5B6W ? window.__F5B6W.boot : 'NO_BOOT'));
        } catch (_e) {
          boot = 'BLOCKED';
        }
      }
      await p.close();
      return boot;
    })();
    set('SIGNER_HANDOFF_IFRAME_REFUSED', framed !== 'OFFER_SENT' && framed !== 'ALREADY_IN_SIGNER', { boot: framed });

    try {
      await popup.close();
    } catch (_e) {}

    // ---- 9. logout now allowed (backup confirmed) and removes the browser identity
    const logout = await page.evaluate(() => {
      const r = window.NostrApp.logoutIdentity({ redirect: false });
      return { ok: !!(r && r.ok === true && !r.blocked), result: r && r.result, modal: !!document.getElementById('sosRecoveryLogoutGuard') };
    });
    await sleep(1000);
    const afterLogout = await page.evaluate(async () => {
      const dbs = (await indexedDB.databases?.()) || [];
      if (!dbs.some((d) => d.name === 'sos_identity_secure')) return { hasBlob: false };
      const hasBlob = await new Promise((resolve) => {
        const req = indexedDB.open('sos_identity_secure');
        req.onsuccess = () => {
          const db = req.result;
          const names = Array.from(db.objectStoreNames);
          if (!names.length) {
            db.close();
            return resolve(false);
          }
          const tx = db.transaction(names, 'readonly');
          let found = false;
          let pending = names.length;
          const fin = () => {
            if (--pending === 0) {
              db.close();
              resolve(found);
            }
          };
          names.forEach((n) => {
            const g = tx.objectStore(n).getAllKeys();
            g.onsuccess = () => {
              if ((g.result || []).some((k) => /identity_blob|wrapping_key/.test(String(k)))) found = true;
              fin();
            };
            g.onerror = fin;
          });
        };
        req.onerror = () => resolve(false);
      });
      return { hasBlob };
    });
    set('LOGOUT_AFTER_BACKUP_ALLOWED', logout.ok && !logout.modal, logout);
    set('BROWSER_IDENTITY_CLEARED', afterLogout.hasBlob === false, afterLogout);
    await ctxA.close();

    // ---- 10. clean browser: recover with the recovery key through the login screen
    const ctxB = await newContext(browser);
    const pageB = await openMain(ctxB);
    const freshPk = await pageB.evaluate(() => String(window.NostrApp.publicKey || '').toLowerCase());
    await pageB.evaluate(() => window.NostrApp.openAuthPrompt('', { step: 'login' }));
    await pageB.fill('#loginKeyInput', recoveryKey);
    await Promise.all([pageB.waitForEvent('load', { timeout: 30000 }), pageB.click('#btnLoginSubmit')]);
    await pageB.waitForFunction(() => /^[0-9a-f]{64}$/.test(String(window.NostrApp?.publicKey || '')), null, { polling: 200, timeout: 60000 });
    const recovered = await pageB.evaluate(() => String(window.NostrApp.publicKey || '').toLowerCase());
    set('RECOVERED_PUBLIC_KEY_MATCH', recovered === originalPub && freshPk !== originalPub, { match: recovered === originalPub, freshDiffers: freshPk !== originalPub });
    await ctxB.close();
  } catch (e) {
    let signerUi = null;
    try {
      if (popup && !popup.isClosed()) {
        signerUi = await popup.evaluate(() => ({
          path: location.pathname,
          status: document.getElementById('status')?.textContent || '',
          ui: window.__F5B5_WA4?.getUiState?.() || '',
          creds: document.getElementById('credCount')?.textContent || '',
        }));
      }
    } catch (_e) {}
    set('E2E_EXCEPTION', false, {
      stage,
      signerUi,
      error: String((e && e.message) || e).replace(/nsec1[a-z0-9]+/gi, '[redacted]').replace(/[0-9a-f]{64}/gi, '<hex>').slice(0, 300),
    });
  } finally {
    recoveryKey = '';
    kHex = '';
    try {
      await browser.close();
    } catch (_e) {}
    try {
      execSync(`taskkill /pid ${signer.pid} /T /F`, { stdio: 'ignore' });
    } catch (_e) {}
    server.close();
    for (const r of relays) await r.stop();
  }

  const all = Object.values(report.results);
  report.passed = all.filter((r) => r.ok).length;
  report.failed = all.filter((r) => !r.ok).length;
  report.status = report.failed === 0 && report.passed > 0 ? 'PASS' : 'FAIL';
  const raw = JSON.stringify(report, null, 2);
  if (SECRET_SHAPE.test(raw)) {
    console.error('REFUSING to write report — secret-like content detected');
    process.exit(1);
  }
  fs.writeFileSync(OUT, raw);
  console.log(JSON.stringify({ status: report.status, passed: report.passed, failed: report.failed }));
  process.exit(report.status === 'PASS' ? 0 : 1);
}

main().catch((e) => {
  console.error(String((e && e.message) || e).replace(/nsec1[a-z0-9]+/gi, '[redacted]').replace(/[0-9a-f]{64}/gi, '<hex>'));
  process.exit(1);
});
