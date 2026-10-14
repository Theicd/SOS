/**
 * Live check: VAULT_NOT_READY opens a session-bound import, not a bare import.html.
 * Uses a disposable public key only. Never sends or logs a private key.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'stage5-import-session-live-report.json');
const BASE = 'https://sos010.com/videos.html';
const PK = 'ab'.repeat(32);
const report = { gate: 'STAGE5_IMPORT_SESSION_LIVE', status: 'FAIL', checks: {} };

function check(name, ok, detail) {
  report.checks[name] = { ok: !!ok, detail: detail || '' };
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

function paramsOf(url) {
  const u = new URL(url);
  return {
    path: u.pathname,
    protocol: u.searchParams.get('protocol') || '',
    sessionId: u.searchParams.get('sessionId') || '',
    requestNonce: u.searchParams.get('requestNonce') || '',
    expectedPubkey: u.searchParams.get('expectedPubkey') || '',
    returnOrigin: u.searchParams.get('returnOrigin') || '',
    hasNsec: /nsec1|privateKey|privHex/i.test(u.search),
  };
}

async function showVaultFailure(page) {
  await page.evaluate(() => {
    const App = window.NostrApp;
    window.SosWebLinkedQrScanner.startLinkedDeviceQrScan = async () => ({ ok: true, qrText: 'SOSPAIR1:stub' });
    App.Md2PairingQr.parseQr = () => ({
      ok: true,
      payload: { pairingId: '7ce8a85ae2e4' + '00'.repeat(26), deviceId: '11'.repeat(32), deviceLabel: 'lab' },
    });
    if (App.GlobalAccountStatusState) {
      App.GlobalAccountStatusState.assertLinkedDeviceBindAllowed = () => ({ ok: true });
    }
    App.WebPhoneIssuer.issueFromPairingQr = async () => ({ ok: false, code: 'VAULT_NOT_READY', vaultState: 'EMPTY' });
    return window.SosWebLinkedDevices.beginPrimaryCameraScan();
  });
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => window.SosWebLinkedDevices && window.SosIsolatedSignerTrustedImport && window.NostrApp && window.NostrApp.WebPhoneIssuer,
    null,
    { timeout: 30000 },
  );
  await page.evaluate((pk) => {
    const App = window.NostrApp;
    App.publicKey = pk;
    App.guestMode = false;
    if (App.SosCryptoSigner && typeof App.SosCryptoSigner.setBackend === 'function') {
      App.SosCryptoSigner.setBackend('MAIN_THREAD');
    }
    window.SosWebLinkedDevices.openMobileLinkedDevicesPage();
  }, PK);
  await showVaultFailure(page);
  const buttonText = await page.locator('#sosLdMobileLinkStatus button').innerText();
  check('setup button visible', /השלמת אישור החשבון/.test(buttonText), buttonText);
  const direct = await page.locator('#sosLdMobileLinkStatus a[href*="import.html"]').count();
  check('no bare import link', direct === 0, String(direct));

  await page.evaluate((pk) => {
    const App = window.NostrApp;
    App.publicKey = pk;
    App.guestMode = false;
    window.__sosOpened = [];
    const orig = window.open.bind(window);
    window.open = function (url, name, features) {
      window.__sosOpened.push({ url: String(url || ''), name: String(name || ''), features: String(features || '') });
      return orig(url, name, features);
    };
  }, PK);
  const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
  await page.locator('#sosLdMobileLinkStatus button').click();
  const popup = await popupPromise;
  const opened = await page.evaluate(() => window.__sosOpened || []);
  const statusAfter = await page.locator('#sosLdMobileLinkStatus').innerText();
  if (!popup) {
    check('import popup opened', false, JSON.stringify({ opened: opened.map((o) => o.url.split('?')[0]), status: statusAfter.slice(0, 180) }));
    throw new Error('NO_POPUP');
  }
  await popup.waitForLoadState('domcontentloaded');
  const q = paramsOf(popup.url());
  check('import path', q.path === '/import' || q.path === '/import.html', q.path);
  check('protocol', q.protocol === '1', q.protocol);
  check('sessionId', /^[0-9a-f]{16,64}$/.test(q.sessionId), 'len=' + q.sessionId.length);
  check('requestNonce', /^[0-9a-f]{8,64}$/.test(q.requestNonce), 'len=' + q.requestNonce.length);
  check('expected pubkey', q.expectedPubkey === PK, q.expectedPubkey.slice(0, 8));
  check('return origin', q.returnOrigin === 'https://sos010.com', q.returnOrigin);
  check('url has no secret', q.hasNsec === false);
  await popup.waitForTimeout(800);
  const fp = await popup.locator('#expectedFp').innerText();
  const status = await popup.locator('#status').innerText();
  check('expected identity shown', fp && !fp.includes('—') && fp.startsWith('abababab'), fp);
  check('not SESSION_REQUIRED', !/SESSION_REQUIRED/.test(status), status.slice(0, 80));
  await popup.close();

  await showVaultFailure(page);
  await page.evaluate(() => {
    const App = window.NostrApp;
    if (App.SosCryptoSigner && typeof App.SosCryptoSigner.setBackend === 'function') {
      App.SosCryptoSigner.setBackend('WORKER_VAULT');
    }
  });
  const [handoff] = await Promise.all([
    page.waitForEvent('popup', { timeout: 15000 }),
    page.locator('#sosLdMobileLinkStatus button').click(),
  ]);
  await handoff.waitForLoadState('domcontentloaded');
  const hq = paramsOf(handoff.url());
  check('handoff path', hq.path === '/handoff' || hq.path === '/handoff.html', hq.path);
  check('handoff expected pubkey', hq.expectedPubkey === PK, hq.expectedPubkey.slice(0, 8));
  check('handoff return origin', hq.returnOrigin === 'https://sos010.com', hq.returnOrigin);
  check('handoff url has no secret', hq.hasNsec === false);
  const body = await handoff.locator('body').innerText();
  check('handoff not 404', !/404|not found|SIGNER_SHELL_OFFLINE/i.test(body), body.slice(0, 80));
  await handoff.close();
} catch (err) {
  check('run', false, String(err && err.message ? err.message : err).slice(0, 300));
} finally {
  await browser.close();
}

const failed = Object.values(report.checks).filter((c) => !c.ok);
report.status = failed.length ? 'FAIL' : 'PASS';
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('STATUS=' + report.status);
process.exit(failed.length ? 1 : 0);
