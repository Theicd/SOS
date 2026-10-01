/**
 * F5B6-W production check (https://sos010.com + https://signer.sos010.com), disposable identity only.
 *
 * Relay WebSockets are stubbed in the test browser, so nothing is published to production relays.
 * Worker identity is created in the test browser only (mobile viewport). The personal key file downloaded
 * from the signer is copied to a temporary path outside the repo, read only by this process, never printed or
 * written to the report, and deleted at the end.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { getPublicKey, nip19 } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'f5b6w-production-check-report.json');
const MAIN = 'https://sos010.com';
const SIGNER = 'https://signer.sos010.com';
const URL0 = `${MAIN}/videos.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { gate: 'F5B6W_PRODUCTION_CHECK', status: 'FAIL', ts: new Date().toISOString(), results: {} };
const SECRET_SHAPE = /nsec1[a-z0-9]{20,}/i;
const set = (k, ok, detail) => {
  let d = detail === undefined ? null : detail;
  if (d !== null && (SECRET_SHAPE.test(JSON.stringify(d)) || /[0-9a-f]{64}/i.test(JSON.stringify(d)))) d = '[redacted]';
  report.results[k] = { ok: !!ok, detail: d };
  console.log(ok ? 'PASS' : 'FAIL', k, d === null ? '' : JSON.stringify(d).slice(0, 300));
};

const consoleTexts = [];
const networkPayloads = [];
async function newContext(browser) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true });
  await ctx.addInitScript(() => {
    if (location.hostname === 'sos010.com' || location.hostname === 'www.sos010.com') {
      class NoRelaySocket extends EventTarget {
        constructor(url) {
          super();
          this.url = String(url);
          this.readyState = 0;
          this.bufferedAmount = 0;
          this.protocol = '';
          this.extensions = '';
          this.binaryType = 'blob';
          setTimeout(() => {
            this.readyState = 3;
            const ev = new Event('error');
            if (typeof this.onerror === 'function') this.onerror(ev);
            this.dispatchEvent(ev);
            const ce = new CloseEvent('close', { code: 1006 });
            if (typeof this.onclose === 'function') this.onclose(ce);
            this.dispatchEvent(ce);
          }, 50);
        }
        send() {}
        close() {
          this.readyState = 3;
        }
      }
      NoRelaySocket.CONNECTING = 0;
      NoRelaySocket.OPEN = 1;
      NoRelaySocket.CLOSING = 2;
      NoRelaySocket.CLOSED = 3;
      window.WebSocket = NoRelaySocket;
      const msgs = [];
      Object.defineProperty(window, '__qaMsgs', { value: msgs });
      window.addEventListener('message', (ev) => {
        try {
          msgs.push(ev.origin + ' ' + JSON.stringify(ev.data));
        } catch (_e) {}
      }, true);
    }
    if (location.hostname === 'signer.sos010.com') {
      const cap = [];
      Object.defineProperty(window, '__qaRevealCapture', { value: cap });
      const orig = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (t, ...rest) {
        if (this.canvas && this.canvas.id === 'nsecCanvas') cap.push(String(t));
        return orig.call(this, t, ...rest);
      };
    }
  });
  ctx.on('request', (req) => networkPayloads.push(req.url() + ' ' + (req.postData() || '')));
  ctx.on('page', (page) => {
    page.on('console', (m) => consoleTexts.push(m.text()));
    page.on('websocket', (ws) => networkPayloads.push('WS_OPENED ' + ws.url()));
  });
  return ctx;
}

async function addVirtualAuthenticator(page) {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

async function openMain(ctx) {
  const page = await ctx.newPage();
  await page.goto(URL0 + '?qa=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(
    () => !!window.NostrApp?.openAuthPrompt && !!window.SosCryptoWorkerVault && !!window.SosRecoveryBackup && !!window.NostrApp?.logoutIdentity,
    null,
    { polling: 300, timeout: 120000 },
  );
  return page;
}

const containsSecret = (texts, kHex, nsec) =>
  texts.some((t) => {
    const s = String(t || '').toLowerCase();
    return (kHex && s.includes(kHex)) || (nsec && s.includes(nsec.toLowerCase()));
  });

async function main() {
  const browser = await chromium.launch({ headless: true });
  let recoveryKey = '';
  let kHex = '';
  let keyFilePath = '';
  let stage = 'boot';
  try {
    const ctxA = await newContext(browser);
    const page = await openMain(ctxA);

    const live = await page.evaluate(async () => {
      const v = await fetch('/app-version.json?t=' + Date.now()).then((r) => r.json());
      const f = await fetch('/runtime-feature-flags.json?t=' + Date.now()).then((r) => r.json());
      return {
        version: v.version,
        v2: f.accessControlV2 === true,
        scope: f.accessControlV2Scope,
        signerOrigin: window.SosRecoveryBackup.signerOrigin(),
        workerDonePanel: !!document.getElementById('workerIdentityDone'),
        backupBtn: /קבלת המפתח ושמירה כקובץ/.test(document.getElementById('btnRecoveryBackup')?.textContent || ''),
        loginKeyFile: !!document.getElementById('loginKeyFileInput'),
        refreshInvite: typeof window.NostrApp.refreshInviteAuthority === 'function',
      };
    });
    set('LIVE_BUILD_899I', live.version === '2026.10.01-web-899i' && live.workerDonePanel && live.backupBtn && live.loginKeyFile && live.refreshInvite, live);
    set('LIVE_FLAGS_V2_CONTROL_PLANE', live.v2 && live.scope === 'CONTROL_PLANE', { v2: live.v2, scope: live.scope });
    set('LIVE_SIGNER_ORIGIN_PRODUCTION', live.signerOrigin === SIGNER);

    // ---- disposable Worker identity, same steps as onboarding (no relay publishing)
    stage = 'create';
    const created = await page.evaluate(async () => {
      const App = window.NostrApp;
      localStorage.setItem('SOS_CRYPTO_WORKER_AUTHORITATIVE', '1');
      window.SOS_CRYPTO_WORKER_AUTHORITATIVE = true;
      window.__SOS_CRYPTO_WORKER_AUTHORITATIVE__ = true;
      const nonce = 'c' + Date.now() + '-qa';
      const c = await window.SosCryptoWorkerVault.createBrowserIdentity({ createNonce: nonce });
      if (!c || !c.ok) return { ok: false, code: c && c.code };
      App.privateKey = null;
      App.publicKey = c.meta.pubkey;
      App.guestMode = false;
      App.identityState = 'IDENTITY_OK';
      const act = await window.SosCryptoWorkerVault.tryActivateAuthoritative();
      const ens = typeof App.ensureKeys === 'function' ? App.ensureKeys() : { ok: true };
      return {
        ok: !!(act && act.ok && ens && ens.ok),
        pk: String(App.publicKey).toLowerCase(),
        worker: App.SosCryptoSigner?.isWorkerAuthoritative?.() === true,
        needsBackup: window.SosRecoveryBackup.needsBackup(),
      };
    });
    set('PROD_WORKER_IDENTITY_CREATED', created.ok && created.worker && created.needsBackup && /^[0-9a-f]{64}$/.test(created.pk || ''), { ok: created.ok, worker: created.worker, needsBackup: created.needsBackup });
    const originalPub = created.pk;

    // ---- logout guard (real modal) -> "קבלת המפתח האישי"
    stage = 'guard';
    const guard = await page.evaluate(() => {
      const r = window.NostrApp.logoutIdentity({ redirect: false });
      return { blocked: !!(r && r.blocked), result: r && r.result, modal: !!document.getElementById('sosRecoveryLogoutGuard'), pk: String(window.NostrApp.publicKey || '').toLowerCase() };
    });
    set('PROD_WORKER_ACCOUNT_LOGOUT_WITHOUT_BACKUP_PROTECTED', guard.blocked && guard.result === 'LOGOUT_BLOCKED_NO_RECOVERY_BACKUP' && guard.modal && guard.pk === originalPub, { blocked: guard.blocked, result: guard.result, modal: guard.modal });

    const states = [];
    await page.exposeFunction('__qaState', (s) => states.push(s));
    await page.evaluate(() => window.addEventListener('sos-recovery-backup-state', (ev) => window.__qaState(ev.detail && ev.detail.state)));
    stage = 'handoff';
    const [popup] = await Promise.all([ctxA.waitForEvent('page', { timeout: 20000 }), page.click('#sosRecoveryGuardBackup')]);
    const popupErrors = [];
    popup.on('pageerror', (e) => popupErrors.push('pageerror ' + String(e.message).slice(0, 160)));
    popup.on('console', (m) => {
      if (m.type() === 'error' && !/frame-ancestors|inline style/.test(m.text())) popupErrors.push('console ' + m.text().slice(0, 160));
    });
    popup.on('requestfailed', (r) => popupErrors.push('reqfail ' + r.url().replace(/\?.*$/, '') + ' ' + (r.failure() && r.failure().errorText)));
    popup.on('framenavigated', (f) => {
      if (f === popup.mainFrame()) popupErrors.push('nav ' + f.url().replace(/\?.*$/, ''));
    });
    report.popupErrors = popupErrors;
    await addVirtualAuthenticator(popup);
    await popup.waitForSelector('#panelImported', { state: 'visible', timeout: 60000 });
    await sleep(500);
    set('PROD_HANDOFF_IMPORTED_INTO_SIGNER', states.includes('SEALED') && states.includes('IN_SIGNER') && /^https:\/\/signer\.sos010\.com\/handoff/.test(popup.url()), { states });
    set('PROD_BACKUP_NOT_CONFIRMED_BEFORE_REVEAL', (await page.evaluate((pk) => window.SosRecoveryBackup.isBackupConfirmed(pk), originalPub)) === false);

    stage = 'enroll';
    await popup.click('#continueToExport');
    await popup.waitForFunction(() => !!document.getElementById('panelNotEnrolled') && !document.getElementById('panelNotEnrolled').hidden, null, { timeout: 30000 });
    await popup.click('#enrollLink');
    await popup.waitForSelector('#enrollBtn', { timeout: 30000 });
    await popup.waitForFunction(() => /^ready /.test(document.getElementById('status')?.textContent || ''), null, { timeout: 30000 });
    await popup.fill('#labelInput', 'f5b6w-prod-check');
    await popup.click('#enrollBtn');
    await popup.waitForFunction(() => parseInt(document.getElementById('credCount')?.textContent || '0', 10) >= 1, null, { timeout: 30000 });
    stage = 'reveal';
    await popup.click('#continueToExport');
    await popup.waitForSelector('#continueBtn', { state: 'visible', timeout: 30000 });
    await popup.click('#continueBtn');
    await popup.waitForFunction(() => window.__F5B5_WA4?.getUiState?.() === 'revealed', null, { timeout: 30000 });
    const canvasKey = await popup.evaluate(() => window.__qaRevealCapture.slice(-2).join(''));
    set('PROD_NOT_EXPORTED_BEFORE_FILE_SAVE', (await page.evaluate((pk) => window.SosRecoveryBackup.isPersonalKeyExported(pk), originalPub)) === false);

    stage = 'save-file';
    const [download] = await Promise.all([popup.waitForEvent('download', { timeout: 20000 }), popup.click('#saveKeyFileBtn')]);
    const fileName = download.suggestedFilename();
    keyFilePath = path.join(os.tmpdir(), `sos-prod-${crypto.randomBytes(6).toString('hex')}-${fileName}`);
    await download.saveAs(keyFilePath);
    await download.delete().catch(() => {});
    const fileText = fs.readFileSync(keyFilePath, 'utf8');
    recoveryKey = fileText.trim();
    let validSame = false;
    try {
      const d = nip19.decode(recoveryKey);
      if (d.type === 'nsec') {
        kHex = Buffer.from(d.data).toString('hex');
        validSame = getPublicKey(d.data) === originalPub;
      }
    } catch (_e) {}
    set('PROD_PERSONAL_KEY_FILE_NAME', fileName === `SOS-personal-key-${originalPub.slice(0, 8)}-${originalPub.slice(-8)}.txt`, { fileName });
    set('PROD_PERSONAL_KEY_FILE_REAL', validSame && fileText === recoveryKey + '\n' && canvasKey === recoveryKey, { bytes: fileText.length });

    await page.waitForFunction((pk) => window.SosRecoveryBackup.isPersonalKeyExported(pk), originalPub, { timeout: 15000 });
    await popup.waitForSelector('#panelKeySaved', { state: 'visible', timeout: 15000 });
    set('PROD_PERSONAL_KEY_EXPORTED_STATE', states.includes('CONFIRMED') && (await page.evaluate(() => window.SosRecoveryBackup.needsBackup())) === false, { states });

    stage = 'scan';
    const scan = await page.evaluate(() => {
      const dump = (st) => Array.from({ length: st.length }, (_, i) => st.key(i) + '=' + st.getItem(st.key(i)));
      return { dom: document.documentElement.outerHTML, store: dump(localStorage).concat(dump(sessionStorage)), msgs: window.__qaMsgs.slice(), priv: !!window.NostrApp.privateKey };
    });
    set('PROD_PRIVATE_KEY_NORMAL_PAGE_EXPOSURE', !containsSecret([scan.dom], kHex, recoveryKey) && !containsSecret(scan.store, kHex, recoveryKey) && !scan.priv);
    set('PROD_PRIVATE_KEY_MESSAGES_TO_SOS010', !containsSecret(scan.msgs, kHex, recoveryKey), { messageCount: scan.msgs.length });
    set('PROD_PRIVATE_KEY_LOGGING', !containsSecret(consoleTexts, kHex, recoveryKey));
    set('PROD_PRIVATE_KEY_NETWORK_RETURN_TO_SOS010', !containsSecret(networkPayloads, kHex, recoveryKey), { requests: networkPayloads.length });
    set('PROD_NO_RELAY_SOCKETS_OPENED', !networkPayloads.some((p) => /^WS_OPENED wss?:\/\//.test(p) && !/signer\.sos010\.com/.test(p)));
    try {
      await popup.close();
    } catch (_e) {}

    stage = 'logout';
    const logout = await page.evaluate(() => {
      const r = window.NostrApp.logoutIdentity({ redirect: false });
      return { ok: !!(r && r.ok === true), result: r && r.result };
    });
    await sleep(1000);
    set('PROD_LOGOUT_AFTER_BACKUP_ALLOWED', logout.ok, logout);
    await ctxA.close();

    stage = 'recover';
    const ctxB = await newContext(browser);
    const pageB = await openMain(ctxB);
    await pageB.evaluate(() => window.NostrApp.openAuthPrompt('', { step: 'login' }));
    await Promise.all([pageB.waitForEvent('load', { timeout: 60000 }), pageB.setInputFiles('#loginKeyFileInput', keyFilePath)]);
    await pageB.waitForFunction(() => /^[0-9a-f]{64}$/.test(String(window.NostrApp?.publicKey || '')), null, { polling: 300, timeout: 90000 });
    const recovered = await pageB.evaluate(() => String(window.NostrApp.publicKey || '').toLowerCase());
    set('PROD_RECOVERED_PUBLIC_KEY_MATCH', recovered === originalPub);
    await ctxB.close();
  } catch (e) {
    let signerUi = null;
    try {
      const sp = browser.contexts().flatMap((c) => c.pages()).find((p) => /signer\.sos010\.com/.test(p.url()));
      if (sp) {
        signerUi = await sp.evaluate(() => ({
          path: location.pathname,
          status: document.getElementById('status')?.textContent || '',
          blocked: document.getElementById('blocked') && !document.getElementById('blocked').hidden ? document.getElementById('blocked').textContent.trim().slice(0, 160) : '',
          enrollDisabled: document.getElementById('enrollBtn')?.disabled,
          formHidden: document.getElementById('enrollForm')?.hidden,
          creds: document.getElementById('credCount')?.textContent || '',
        }));
      }
    } catch (_e) {}
    console.log('POPUP_EVENTS', JSON.stringify(report.popupErrors || []).replace(/nsec1[a-z0-9]+/gi, '[redacted]').replace(/[0-9a-f]{64}/gi, '<hex>'));
    set('PROD_CHECK_EXCEPTION', false, { stage, signerUi, error: String((e && e.message) || e).replace(/nsec1[a-z0-9]+/gi, '[redacted]').replace(/[0-9a-f]{64}/gi, '<hex>').slice(0, 300) });
  } finally {
    recoveryKey = '';
    kHex = '';
    try {
      if (keyFilePath && fs.existsSync(keyFilePath)) fs.unlinkSync(keyFilePath);
    } catch (_e) {}
    await browser.close().catch(() => {});
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
