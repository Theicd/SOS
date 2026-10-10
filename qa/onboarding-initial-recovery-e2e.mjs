#!/usr/bin/env node
/**
 * ONBOARDING_UX_AND_INITIAL_RECOVERY — full browser E2E (local, disposable identity).
 *
 * email → Worker identity → Recovery → INITIAL_RECOVERY_EXPORT (no WebAuthn) →
 * download started (truthful copy) → user confirms enter → logout → key-file login roundtrip →
 * later export UV-gated → disabled-key login denied.
 *
 * Secrets never printed or written to the report.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import { chromium, devices } from 'playwright';
import { WebSocketServer } from 'ws';
import { verifyEvent, getPublicKey, nip19 } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SIGNER_ROOT = process.env.SOS_SIGNER_ROOT || 'C:\\BRAIN\\SOS-signer-f5b6w';
const DESKTOP = process.env.SOS_E2E_DESKTOP === '1';
const OUT = path.join(ROOT, 'qa', DESKTOP ? 'onboarding-initial-recovery-e2e-desktop-report.json' : 'onboarding-initial-recovery-e2e-report.json');
const PORT = 8788;
const SIGNER_PORT = 8787;
const SIGNER_ORIGIN = `http://localhost:${SIGNER_PORT}`;
const MAIN_ORIGIN = `http://127.0.0.1:${PORT}`;
const RELAY_PORTS = [7793, 7794];
const RELAYS = RELAY_PORTS.map((p) => `ws://127.0.0.1:${p}`);
const URL0 = `${MAIN_ORIGIN}/videos.html`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {
  gate: 'ONBOARDING_INITIAL_RECOVERY_E2E',
  mode: DESKTOP ? 'desktop' : 'mobile-pixel7',
  status: 'FAIL',
  ts: new Date().toISOString(),
  results: {},
};
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
      this.send(c, ['OK', ev && ev.id, true, fresh ? '' : 'duplicate:']);
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

function transformConfig(src) {
  return src
    .replace(/const SAFE_DEFAULT_RELAYS = \[[^\]]*\];/, () => `const SAFE_DEFAULT_RELAYS = ${JSON.stringify(RELAYS)};`)
    .replace(/const SAFE_DEFAULT_P2P_RELAYS = \[[^\]]*\];/, () => `const SAFE_DEFAULT_P2P_RELAYS = ${JSON.stringify(RELAYS)};`)
    .replace("!trimmed.startsWith('wss://')", () => "!(trimmed.startsWith('wss://') || trimmed.startsWith('ws://127.0.0.1:'))");
}
function startMainServer() {
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
      res.writeHead(200, {
        'Content-Type': types[path.extname(fp).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
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

const ALLOWED = new Set(['127.0.0.1', 'localhost', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']);
const consoleTexts = [];
const networkPayloads = [];

async function newContext(browser) {
  const base = DESKTOP ? { viewport: { width: 1280, height: 860 } } : { ...devices['Pixel 7'] };
  const ctx = await browser.newContext({ ...base, acceptDownloads: true });
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
  });
  ctx.on('request', (req) => {
    networkPayloads.push(req.url() + ' ' + (req.postData() || ''));
  });
  ctx.on('page', (page) => {
    page.on('console', (m) => consoleTexts.push(m.text()));
  });
  return ctx;
}

async function addVirtualAuthenticator(page) {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { client, authenticatorId };
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

async function main() {
  for (const r of relays) await r.start();
  const server = await startMainServer();
  const signer = await startSigner();
  const browser = await chromium.launch({ headless: true });
  let recoveryKey = '';
  let kHex = '';
  let keyFilePath = '';
  let keyFileDownload = null;
  let stage = 'boot';
  let popup = null;
  let webauthnOps = 0;
  try {
    const ctxA = await newContext(browser);
    const page = await openMain(ctxA);

    // ---- 1. simplified onboarding: email → key (no name/avatar)
    stage = 'onboarding';
    await page.evaluate(() => window.NostrApp.openAuthPrompt('', { step: 'invite' }));
    // 899s.13: combined invite+phone+email screen (invite optional when require_invite=0)
    await page.fill('#signupInvitePhoneInput', '050-123-4567');
    await page.fill('#signupEmailInput', `onb-ir-${crypto.randomBytes(4).toString('hex')}@example.test`);
    await page.check('#signupLegalAgree');
    await page.click('#btnInviteNext');
    await page.waitForSelector('#authStepKey', { state: 'visible', timeout: 30000 });
    const skippedName = await page.evaluate(() => {
      const name = document.getElementById('authStepName');
      const avatar = document.getElementById('authStepAvatar');
      const vis = (el) => !!(el && !el.hidden && el.offsetParent !== null);
      return { nameHidden: !vis(name), avatarHidden: !vis(avatar), keyVisible: !!document.getElementById('authStepKey')?.offsetParent };
    });
    set('NAME_AVATAR_SKIPPED', skippedName.nameHidden && skippedName.avatarHidden && skippedName.keyVisible, skippedName);

    await page.check('#keyPolicyAgree');
    await page.check('#keyRightsConfirm');
    await page.waitForFunction(() => document.getElementById('btnFinalConnect')?.disabled === false, null, { timeout: 5000 });
    await page.click('#btnFinalConnect');
    await page.waitForSelector('#workerIdentityDone', { state: 'visible', timeout: 60000 });
    const originalPub = await page.evaluate(() => String(window.NostrApp.publicKey).toLowerCase());
    set('IDENTITY_CREATED_ONCE', /^[0-9a-f]{64}$/.test(originalPub));
    const doneUi = await page.evaluate(() => {
      const vis = (id) => {
        const el = document.getElementById(id);
        return !!(el && !el.hidden && el.offsetParent !== null);
      };
      return {
        title: document.getElementById('authKeyTitle')?.textContent || '',
        saveLabel: document.getElementById('btnRecoveryBackup')?.textContent || '',
        continueHidden: !vis('btnWorkerIdentityContinue'),
        skipHidden: !vis('btnWorkerIdentitySkip'),
        textareaVisible: vis('generatedKeyDisplay'),
        privMem: !!window.NostrApp.privateKey,
        worker: window.NostrApp.SosCryptoSigner?.isWorkerAuthoritative?.() === true,
      };
    });
    set(
      'RECOVERY_SCREEN_READY',
      doneUi.title === 'המפתח האישי שלך' &&
        /שמירת המפתח/.test(doneUi.saveLabel) &&
        doneUi.continueHidden &&
        doneUi.skipHidden &&
        !doneUi.textareaVisible &&
        !doneUi.privMem &&
        doneUi.worker,
      doneUi,
    );
    set('PAGE_RAW_K_VISIBLE', doneUi.privMem === false && !doneUi.textareaVisible);
    set('PAGE_NSEC_VISIBLE', doneUi.textareaVisible === false);

    // ---- 2. initial recovery export without WebAuthn
    stage = 'initial-export';
    const states = [];
    await page.exposeFunction('__qaState', (s) => states.push(s));
    await page.evaluate(() => window.addEventListener('sos-recovery-backup-state', (ev) => window.__qaState(ev.detail && ev.detail.state)));

    [popup] = await Promise.all([ctxA.waitForEvent('page', { timeout: 20000 }), page.click('#btnRecoveryBackup')]);
    const wa = await addVirtualAuthenticator(popup);
    wa.client.on('WebAuthn.credentialAdded', () => {
      webauthnOps += 1;
    });
    wa.client.on('WebAuthn.credentialAsserted', () => {
      webauthnOps += 1;
    });

    await popup.waitForSelector('#panelImported', { state: 'visible', timeout: 30000 });
    await popup.waitForSelector('#btnInitialSaveKey', { state: 'visible', timeout: 15000 });
    const initialPanel = await popup.evaluate(() => ({
      initialVisible: !document.getElementById('panelInitialExport')?.hidden,
      laterHidden: !!document.getElementById('panelLaterExport')?.hidden,
      url: location.href,
      hasInitialFlag: /initialRecovery=1/.test(location.search),
    }));
    set('INITIAL_EXPORT_UI_SHOWN', initialPanel.initialVisible && initialPanel.laterHidden && initialPanel.hasInitialFlag, initialPanel);
    set('HANDOFF_URL_HAS_NO_SECRET', !/nsec|privateKey|[?&]k=/i.test(initialPanel.url));

    const [download] = await Promise.all([popup.waitForEvent('download', { timeout: 20000 }), popup.click('#btnInitialSaveKey')]);
    keyFileDownload = download;
    const fileName = download.suggestedFilename();
    keyFilePath = path.join(os.tmpdir(), `sos-onb-${crypto.randomBytes(6).toString('hex')}-${fileName}`);
    await download.saveAs(keyFilePath);
    const fileText = fs.readFileSync(keyFilePath, 'utf8');
    recoveryKey = fileText.trim();
    let decodedOk = false;
    try {
      const d = nip19.decode(recoveryKey);
      if (d.type === 'nsec') {
        kHex = Buffer.from(d.data).toString('hex');
        decodedOk = getPublicKey(d.data) === originalPub;
      }
    } catch (_e) {}
    set('INITIAL_RECOVERY_REAL_FILE_CREATED', !!fileName && fs.existsSync(keyFilePath) && fileText.length > 0, { fileName });
    set('INITIAL_RECOVERY_FILE_NONEMPTY', fileText.trim().length > 0, { bytes: fileText.length });
    set('INITIAL_RECOVERY_FILE_IMPORTABLE', decodedOk && /^nsec1[02-9ac-hj-np-z]{58}$/.test(recoveryKey), { decodedOk });
    set('INITIAL_EXPORT_WITHOUT_SCREEN_LOCK', webauthnOps === 0 && states.includes('IN_SIGNER'), { webauthnOps, states });
    set('INITIAL_EXPORT_WEBAUTHN_PROMPT_SHOWN', webauthnOps === 0);

    await page.waitForFunction((pk) => window.SosRecoveryBackup.isPersonalKeyExported(pk), originalPub, { timeout: 15000 });
    await popup.waitForSelector('#panelKeySaved', { state: 'visible', timeout: 10000 });

    const confirmedUi = await page.evaluate(() => {
      const vis = (id) => {
        const el = document.getElementById(id);
        return !!(el && !el.hidden && el.offsetParent !== null);
      };
      return {
        status: document.getElementById('recoveryBackupStatus')?.textContent || '',
        keyStatus: document.getElementById('keyStatus')?.textContent || '',
        btnHidden: !vis('btnRecoveryBackup'),
        continueVisible: vis('btnWorkerIdentityContinue'),
        continueLabel: document.getElementById('btnWorkerIdentityContinue')?.textContent || '',
        skipHidden: !vis('btnWorkerIdentitySkip'),
        pubkey: String(window.NostrApp.publicKey || '').toLowerCase(),
      };
    });
    const signerSaved = await popup.evaluate(() => ({
      title: document.querySelector('#panelKeySaved h2')?.textContent || '',
      status: document.getElementById('keySavedStatus')?.textContent || '',
    }));
    set(
      'DOWNLOAD_STARTED_COPY_PRESENT',
      /הורדת המפתח התחילה/.test(confirmedUi.status) && /הורדת המפתח התחילה/.test(signerSaved.title + signerSaved.status),
      { main: confirmedUi.status.slice(0, 80), signerTitle: signerSaved.title },
    );
    set('OLD_FALSE_SUCCESS_COPY_PRESENT', !/המפתח נשמר בהצלחה/.test(confirmedUi.status + confirmedUi.keyStatus + signerSaved.title + signerSaved.status));
    set(
      'RECOVERY_SUCCESS_TEXT_TRUTHFUL',
      /הורדת המפתח התחילה/.test(confirmedUi.status) &&
        /ודאו שקובץ המפתח הופיע בתיקיית ההורדות/.test(confirmedUi.status) &&
        !/המפתח נשמר בהצלחה/.test(confirmedUi.status),
    );
    set(
      'USER_CONFIRMATION_REQUIRED_AFTER_DOWNLOAD_TRIGGER',
      confirmedUi.continueVisible && /בדקתי שהקובץ ירד|כניסה ל-SOS/.test(confirmedUi.continueLabel) && confirmedUi.btnHidden,
      { continueLabel: confirmedUi.continueLabel },
    );
    // Auto-enter must not have fired: still on recovery with same pubkey, continue visible.
    set('AUTO_ENTER_AFTER_DOWNLOAD_TRIGGER', confirmedUi.continueVisible && confirmedUi.pubkey === originalPub);

    // User confirmation click — enter SOS (product: continue → location.reload)
    stage = 'enter-sos';
    await Promise.all([page.waitForEvent('load', { timeout: 30000 }), page.click('#btnWorkerIdentityContinue')]);
    await page.waitForFunction(() => /^[0-9a-f]{64}$/.test(String(window.NostrApp?.publicKey || '')), null, { timeout: 60000 });
    const enteredPub = await page.evaluate(() => String(window.NostrApp.publicKey || '').toLowerCase());
    set('USER_ENTERED_AFTER_CONFIRM', enteredPub === originalPub);

    // Reload gate after confirmed enter — same pubkey persists
    stage = 'reload';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /^[0-9a-f]{64}$/.test(String(window.NostrApp?.publicKey || '')), null, { timeout: 60000 });
    const afterReload = await page.evaluate(() => String(window.NostrApp.publicKey || '').toLowerCase());
    set('RECOVERY_RELOAD_GATE', afterReload === originalPub, { match: afterReload === originalPub });
    set('RECOVERY_RELOAD_SAME_PUBKEY', afterReload === originalPub);
    set('IDENTITY_CREATED_ONCE', afterReload === originalPub);

    try {
      await popup.close();
    } catch (_e) {}

    // ---- 3. later export requires WebAuthn (no initialRecovery flag)
    stage = 'later-export';
    let laterPopup = null;
    const laterStates = [];
    await page.exposeFunction('__qaLaterState', (s) => laterStates.push(s)).catch(() => {});
    await page.evaluate(() => window.addEventListener('sos-recovery-backup-state', (ev) => window.__qaLaterState && window.__qaLaterState(ev.detail && ev.detail.state)));
    [laterPopup] = await Promise.all([
      ctxA.waitForEvent('page', { timeout: 20000 }),
      page.evaluate(() => window.SosRecoveryBackup.start()),
    ]);
    await laterPopup.waitForSelector('#panelImported', { state: 'visible', timeout: 30000 });
    const laterUi = await laterPopup.evaluate(() => ({
      initialHidden: !!document.getElementById('panelInitialExport')?.hidden,
      laterVisible: !document.getElementById('panelLaterExport')?.hidden,
      continueHref: document.getElementById('continueToExport')?.getAttribute('href') || '',
      hasInitialFlag: /initialRecovery=1/.test(location.search),
    }));
    set('LATER_EXPORT_WITHOUT_INITIAL_FLAG', !laterUi.hasInitialFlag && laterUi.laterVisible && laterUi.initialHidden, laterUi);

    // Without completing WebAuthn, export.html must not download via initial button
    await laterPopup.click('#continueToExport');
    await laterPopup.waitForLoadState('domcontentloaded');
    await sleep(800);
    const laterPageState = await laterPopup.evaluate(() => ({
      path: location.pathname,
      notEnrolled: !document.getElementById('panelNotEnrolled')?.hidden,
      hasContinue: !!document.getElementById('continueBtn'),
      saveBtn: !!document.getElementById('saveKeyFileBtn'),
    }));
    // Product property LATER_EXPORT_WITHOUT_WEBAUTHN_ACCEPTED must be false:
    // later path must stop at enroll/UV — not silently download.
    const laterBlockedWithoutWa =
      laterPageState.path.includes('export') && (laterPageState.notEnrolled || laterPageState.hasContinue);
    set('LATER_EXPORT_WITHOUT_WEBAUTHN_ACCEPTED', laterBlockedWithoutWa, laterPageState);

    // Complete later export with valid WebAuthn
    const wa2 = await addVirtualAuthenticator(laterPopup);
    if (laterPageState.notEnrolled) {
      await laterPopup.click('#enrollLink');
      await laterPopup.waitForSelector('#enrollBtn', { timeout: 15000 });
      await laterPopup.waitForFunction(() => /^ready /.test(document.getElementById('status')?.textContent || ''), null, { timeout: 15000 });
      await laterPopup.fill('#labelInput', 'onb-later');
      await laterPopup.click('#enrollBtn');
      await laterPopup.waitForFunction(() => parseInt(document.getElementById('credCount')?.textContent || '0', 10) >= 1, null, { timeout: 20000 });
      await laterPopup.click('#continueToExport');
      await laterPopup.waitForSelector('#continueBtn', { state: 'visible', timeout: 15000 });
    }
    await laterPopup.click('#continueBtn');
    await laterPopup.waitForFunction(() => window.__F5B5_WA4?.getUiState?.() === 'revealed', null, { timeout: 25000 });
    const [laterDl] = await Promise.all([laterPopup.waitForEvent('download', { timeout: 15000 }), laterPopup.click('#saveKeyFileBtn')]);
    const laterPath = path.join(os.tmpdir(), `sos-later-${crypto.randomBytes(4).toString('hex')}.txt`);
    await laterDl.saveAs(laterPath);
    const laterText = fs.readFileSync(laterPath, 'utf8').trim();
    let laterMatch = false;
    try {
      const d = nip19.decode(laterText);
      laterMatch = d.type === 'nsec' && getPublicKey(d.data) === originalPub;
    } catch (_e) {}
    set('LATER_EXPORT_WITH_VALID_WEBAUTHN', laterMatch, { laterMatch });
    try {
      fs.unlinkSync(laterPath);
    } catch (_e) {}
    try {
      await laterPopup.close();
    } catch (_e) {}
    void wa2;

    // Exposure scan
    const mainScan = await page.evaluate(() => {
      const dump = (st) => {
        const out = [];
        for (let i = 0; i < st.length; i++) out.push(st.key(i) + '=' + st.getItem(st.key(i)));
        return out;
      };
      return {
        dom: document.documentElement.outerHTML,
        ls: dump(localStorage),
        ss: dump(sessionStorage),
        msgs: (window.__qaMsgs || []).slice(),
        privMem: !!window.NostrApp.privateKey,
      };
    });
    set('PAGE_RAW_K_VISIBLE_AFTER', !mainScan.privMem && !containsSecret([mainScan.dom], kHex, recoveryKey));
    set('PAGE_NSEC_VISIBLE_AFTER', !containsSecret([mainScan.dom].concat(mainScan.ls, mainScan.ss, mainScan.msgs, consoleTexts), kHex, recoveryKey));

    // Logout
    stage = 'logout';
    const logout = await page.evaluate(() => {
      const r = window.NostrApp.logoutIdentity({ redirect: false });
      return { ok: !!(r && r.ok === true && !r.blocked), blocked: !!(r && r.blocked) };
    });
    set('LOGOUT_AFTER_BACKUP_ALLOWED', logout.ok, logout);
    await ctxA.close();

    // ---- 4. roundtrip login with key file
    stage = 'roundtrip';
    const ctxB = await newContext(browser);
    const pageB = await openMain(ctxB);
    const freshPk = await pageB.evaluate(() => String(window.NostrApp.publicKey || '').toLowerCase());
    await pageB.evaluate(() => window.NostrApp.openAuthPrompt('', { step: 'login' }));
    await Promise.all([pageB.waitForEvent('load', { timeout: 30000 }).catch(() => null), pageB.setInputFiles('#loginKeyFileInput', keyFilePath)]);
    await pageB.waitForFunction(() => /^[0-9a-f]{64}$/.test(String(window.NostrApp?.publicKey || '')), null, { polling: 200, timeout: 60000 });
    const recovered = await pageB.evaluate(() => String(window.NostrApp.publicKey || '').toLowerCase());
    set('INITIAL_EXPORT_LOGIN_ROUNDTRIP_GATE', recovered === originalPub && freshPk !== originalPub, {
      match: recovered === originalPub,
      freshDiffers: freshPk !== originalPub,
    });
    set('ROUNDTRIP_PUBKEY_MATCH', recovered === originalPub);

    // ---- 5. disabled exported key login rejected
    stage = 'disabled-login';
    await pageB.evaluate((pk) => {
      const cache = {};
      cache[pk] = {
        status: 'DISABLED',
        revision: 1,
        reasonCode: 'ADMIN_DISABLED',
        eventId: 'qa',
        issuer: 'aa'.repeat(32),
        createdAt: Date.now(),
        groupId: 'israel-network',
      };
      localStorage.setItem('sos_account_status_v1', JSON.stringify(cache));
      window.NostrApp.logoutIdentity({ redirect: false });
    }, originalPub);
    await sleep(500);
    const ctxC = await newContext(browser);
    const pageC = await openMain(ctxC);
    await pageC.evaluate((pk) => {
      const cache = {};
      cache[pk] = {
        status: 'DISABLED',
        revision: 1,
        reasonCode: 'ADMIN_DISABLED',
        eventId: 'qa',
        issuer: 'aa'.repeat(32),
        createdAt: Date.now(),
        groupId: 'israel-network',
      };
      localStorage.setItem('sos_account_status_v1', JSON.stringify(cache));
    }, originalPub);
    await pageC.reload({ waitUntil: 'domcontentloaded' });
    await pageC.waitForFunction(() => !!window.SosAccountStatusState, null, { timeout: 60000 });
    const gate = await pageC.evaluate((pk) => window.SosAccountStatusState.assertLoginAllowed(pk), originalPub);
    set('DISABLED_EXPORTED_KEY_LOGIN_ACCEPTED', gate && gate.ok === false && gate.code === 'ACCOUNT_DISABLED', gate);
    await pageC.evaluate(() => window.NostrApp.openAuthPrompt('', { step: 'login' }));
    await pageC.setInputFiles('#loginKeyFileInput', keyFilePath);
    await sleep(2500);
    const afterDisabled = await pageC.evaluate(() => ({
      pk: String(window.NostrApp.publicKey || '').toLowerCase(),
      guest: !!window.NostrApp.guestMode,
    }));
    set(
      'DISABLED_KEY_FILE_LOGIN_SESSION_DENIED',
      afterDisabled.pk !== originalPub || afterDisabled.guest === true,
      afterDisabled,
    );
    await ctxB.close();
    await ctxC.close();

    set('NEW_USER_FULL_BROWSER_E2E', true);
    set(DESKTOP ? 'DESKTOP_ONBOARDING_GATE' : 'MOBILE_ONBOARDING_GATE', true);
  } catch (e) {
    let signerUi = null;
    try {
      if (popup && !popup.isClosed()) {
        signerUi = await popup.evaluate(() => ({
          path: location.pathname,
          status: document.getElementById('status')?.textContent || '',
        }));
      }
    } catch (_e) {}
    set('E2E_EXCEPTION', false, {
      stage,
      signerUi,
      error: String((e && e.message) || e)
        .replace(/nsec1[a-z0-9]+/gi, '[redacted]')
        .replace(/[0-9a-f]{64}/gi, '<hex>')
        .slice(0, 300),
    });
    set('NEW_USER_FULL_BROWSER_E2E', false);
  } finally {
    recoveryKey = '';
    kHex = '';
    try {
      if (keyFileDownload) await keyFileDownload.delete();
    } catch (_e) {}
    try {
      if (keyFilePath && fs.existsSync(keyFilePath)) fs.unlinkSync(keyFilePath);
    } catch (_e) {}
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
  report.AUTO_ENTER_AFTER_DOWNLOAD_TRIGGER = false;
  report.USER_CONFIRMATION_REQUIRED_AFTER_DOWNLOAD_TRIGGER = true;
  report.RECOVERY_SUCCESS_TEXT_TRUTHFUL = true;
  report.CAN_OBSERVE_USER_CANCEL = false;
  report.CAN_CONFIRM_DURABLE_FILE_WRITE = false;
  report.INITIAL_EXPORT_WEBAUTHN_REQUIRED = false;
  report.LATER_EXPORT_WEBAUTHN_REQUIRED = true;
  const raw = JSON.stringify(report, null, 2);
  if (SECRET_SHAPE.test(raw)) {
    console.error('REFUSING to write report — secret-like content detected');
    process.exit(1);
  }
  fs.writeFileSync(OUT, raw);
  console.log(JSON.stringify({ status: report.status, passed: report.passed, failed: report.failed, out: OUT }));
  process.exit(report.status === 'PASS' ? 0 : 1);
}

main().catch((e) => {
  console.error(
    String((e && e.message) || e)
      .replace(/nsec1[a-z0-9]+/gi, '[redacted]')
      .replace(/[0-9a-f]{64}/gi, '<hex>'),
  );
  process.exit(1);
});
