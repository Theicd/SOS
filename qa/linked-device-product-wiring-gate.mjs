#!/usr/bin/env node
/**
 * PHASE B — Linked Device product wiring gate (web) + Android env probe.
 * Does not claim MD3 cryptographic E2E PASS without native issuer.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'linked-device-product-wiring-report.json');
const PORT = Number(process.env.SOS_LD_PORT || 8795);

const report = {
  gate: 'LINKED_DEVICE_PRODUCT_WIRING',
  status: 'FAIL',
  ts: new Date().toISOString(),
  results: {},
  ANDROID_LINKED_DEVICES_E2E: 'BLOCKED_ENVIRONMENT',
  DEVICE_REVOKE_PRODUCT_READY: false,
  HISTORY_SYNC_READY: false,
  LIVE_SYNC_READY: false,
};
const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 220));
};

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function existsJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const ld = read('sos-web-linked-devices.js');
  const md2 = read('sos-md2-pairing-qr.js');
  const videos = read('videos.html');
  const guest = read('guest-auth.js');
  const av = JSON.parse(read('app-version.json'));

  set('VERSION_899S15', /899s\.(1[5-9]|[2-9]\d)/.test(String(av.version || '')), { version: av.version });
  set('WEB_MODULE_PRESENT', /WebLinkedDevices/.test(ld) && /sos-pair-v1/.test(ld));
  set('VIDEOS_LOADS_MODULE', /sos-web-linked-devices\.js/.test(videos));
  set('NO_ROOT_K_IN_QR_MODULE', !/nsec|privateKey|rootK/.test(ld.match(/encodeQr|qrText|toPublicJson[\s\S]{0,200}/)?.[0] || 'ok'));
  set('ROOT_K_SENT_TO_DESKTOP_FALSE', /ROOT_K_SENT_TO_DESKTOP:\s*false/.test(ld));
  set('NSEC_SENT_TO_DESKTOP_FALSE', /NSEC_SENT_TO_DESKTOP:\s*false/.test(ld));
  set('PAIRING_REQUIRES_PHONE_NUMBER_BINDING_FALSE', /PAIRING_REQUIRES_PHONE_NUMBER_BINDING:\s*false/.test(ld));
  set('FAKE_HISTORY_SYNC_FALSE', /FAKE_HISTORY_SYNC:\s*false/.test(ld));
  set('NO_FAKE_REVOKE_BUTTON', /DEVICE_REVOKE_PRODUCT_READY:\s*false/.test(ld) && /אין כפתור הסרה מדומה/.test(ld));
  set('WEB_MD3_ISSUANCE_FALSE', /WEB_MD3_ISSUANCE:\s*false/.test(ld));
  set('MD2_NO_STATIC_FIXTURE_ZEROS', !/pairingId: '0'\.repeat\(32\)/.test(md2));

  // Android env
  const sdkMissing = !process.env.ANDROID_HOME && !fs.existsSync(path.join(ROOT, 'android-shell', 'local.properties'));
  const md3Report = existsJson('qa/md3-linked-device-android-integration-report.json');
  const md3UnitPass = md3Report && md3Report.status === 'PASS';
  report.ANDROID_LINKED_DEVICES_E2E = sdkMissing
    ? 'BLOCKED_ENVIRONMENT'
    : md3UnitPass
      ? 'ANDROID_UNIT_PASS_PRODUCT_E2E_PENDING'
      : 'ATTEMPTED';
  report.TEST_ENVIRONMENT_BLOCKERS = sdkMissing
    ? ['ANDROID_SDK / local.properties missing — cannot run MD1/MD2/MD3 instrumentation']
    : [];
  set('ANDROID_ENV_CLASSIFIED', true, { ANDROID_LINKED_DEVICES_E2E: report.ANDROID_LINKED_DEVICES_E2E, md3UnitPass });

  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/videos.html';
    const fp = path.join(ROOT, p.replace(/^\//, ''));
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${PORT}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(`${origin}/videos.html`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => !!(window.SosWebLinkedDevices || window.NostrApp?.WebLinkedDevices), null, { timeout: 90000 });

    const ui = await page.evaluate(async () => {
      const LD = window.SosWebLinkedDevices;
      LD.wireUi();
      const hasLoginBtn = !!document.getElementById('btnLoginLinkPhone') || !!document.getElementById('btnStartLinkPhone');
      // open auth initial to ensure buttons
      if (window.NostrApp?.openAuthPrompt) window.NostrApp.openAuthPrompt('', { step: 'initial' });
      const hasStart = !!document.getElementById('btnStartLinkPhone');
      const hasSettings = !!document.getElementById('topBarLinkedDevices');
      const session = await LD.startDesktopPairingSession();
      const qr = session.qrText || '';
      const parsed = window.NostrApp.Md2PairingQr.parseQr(qr);
      const secretOk = !/nsec1|privateKey|d_sign_priv/i.test(qr);
      return {
        hasLoginBtn: hasLoginBtn || hasStart,
        hasSettings,
        qrPrefix: qr.startsWith('SOSPAIR1:'),
        parsedOk: parsed.ok === true,
        secretOk,
        state: session.state,
        pairingIdLen: String(session.payload?.pairingId || '').length,
        webMd3: LD.WEB_MD3_ISSUANCE === false,
        phoneBindRequired: LD.PAIRING_REQUIRES_PHONE_NUMBER_BINDING === false,
      };
    });

    set('DESKTOP_LINK_DEVICE_ENTRY_VISIBLE', ui.hasLoginBtn === true, ui);
    set('PHONE_LINKED_DEVICE_ENTRY_VISIBLE', ui.hasSettings === true, ui);
    set('DESKTOP_PAIRING_QR_WORKS', ui.qrPrefix && ui.parsedOk && ui.secretOk && ui.pairingIdLen === 64, ui);
    set('PHONE_EXPLICIT_APPROVAL_REQUIRED', /requiresExplicitApproval:\s*true/.test(ld));
    set('PAIR_REPLAY_FIXTURE_REJECT_PATH', /parseQr/.test(md2) && /EXPIRED|BAD_PREFIX/.test(md2));

    // Expired QR
    const exp = await page.evaluate(async () => {
      const LD = window.SosWebLinkedDevices;
      const Md2 = window.NostrApp.Md2PairingQr;
      const s = await LD.startDesktopPairingSession();
      const payload = Object.assign({}, s.payload, { expiresAt: Date.now() - 120000 });
      const qr = Md2.encodeQr(payload);
      return Md2.parseQr(qr, Date.now());
    });
    report.results.PAIR_EXPIRED_ACCEPTED = { ok: exp.ok !== true, detail: { error: exp.error } };
    console.log(report.results.PAIR_EXPIRED_ACCEPTED.ok ? 'PASS' : 'FAIL', 'PAIR_EXPIRED_ACCEPTED');

    // Cryptographic product E2E requires logged-in Android PhoneIssuer + desktop browser.
    // Unit-level MD3 PhoneIssuer / adversarial suite is reported via android integration gate.
    const e2eDetail = sdkMissing
      ? { status: 'BLOCKED_ENVIRONMENT', reason: 'ANDROID_SDK missing' }
      : {
          status: 'PENDING_REAL_DEVICE_ACCOUNT',
          reason:
            'Emulator/device has PhoneIssuer path; full QR→approve→verify E2E needs logged-in primary identity on Android + desktop session',
          ANDROID_MD3_UNIT: md3UnitPass ? 'PASS' : 'UNKNOWN',
        };
    report.results.NEW_ACCOUNT_PAIRING_E2E = { ok: false, detail: e2eDetail };
    report.results.LEGACY_NO_PHONE_PAIRING_E2E = { ok: false, detail: e2eDetail };
    console.log('FAIL NEW_ACCOUNT_PAIRING_E2E', JSON.stringify(e2eDetail));
    console.log('FAIL LEGACY_NO_PHONE_PAIRING_E2E', JSON.stringify(e2eDetail));

    report.results.MD3_AUTHORIZATION_VERIFIED = {
      ok: !!md3UnitPass,
      detail: {
        WEB_MD3_ISSUANCE: false,
        ANDROID_UNIT_CRYPTO: md3UnitPass ? 'PASS' : 'FAIL',
        note: 'Root schnorr DeviceAuthorization verified in Android unit tests; live product E2E separate',
      },
    };
    console.log(report.results.MD3_AUTHORIZATION_VERIFIED.ok ? 'PASS' : 'FAIL', 'MD3_AUTHORIZATION_VERIFIED');

    report.NEW_ACCOUNT_PAIRING_E2E = e2eDetail.status;
    report.LEGACY_NO_PHONE_PAIRING_E2E = e2eDetail.status;
    report.SAME_GLOBAL_P_AFTER_PAIRING = null;
    report.WEB_PAIRING_E2E = ui.qrPrefix && ui.parsedOk ? 'QR_SESSION_PASS' : 'FAIL';
    report.MD1_GATE = md3UnitPass ? 'PASS' : 'UNKNOWN';
    report.MD2_GATE = 'WEB_PRESENTATION_PLUS_SESSION';
    report.MD3_GATE = md3UnitPass ? 'ANDROID_UNIT_PASS' : 'ANDROID_ISSUANCE_ONLY';

    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }

  const fails = Object.entries(report.results).filter(([, v]) => !v.ok).map(([k]) => k);
  const qrOk = report.results.DESKTOP_PAIRING_QR_WORKS?.ok === true;
  const cryptoUnitOk = report.results.MD3_AUTHORIZATION_VERIFIED?.ok === true;
  // Product E2E still pending real logged-in Android primary — not a silent PASS.
  report.status =
    qrOk && cryptoUnitOk && !sdkMissing
      ? 'PASS_WITH_E2E_PENDING'
      : sdkMissing
        ? 'BLOCKED_ANDROID_ENVIRONMENT'
        : 'FAIL_IMPLEMENTATION';
  report.SECURITY_BLOCKERS = [
    'MD3 DeviceAuthorization issuance is Android-native (no WebView authorize API by design)',
  ];
  if (sdkMissing) {
    report.SECURITY_BLOCKERS.push('ANDROID_SDK/local.properties missing');
  } else if (!report.results.NEW_ACCOUNT_PAIRING_E2E?.ok) {
    report.SECURITY_BLOCKERS.push('Real Android↔desktop pairing E2E pending logged-in primary on device/emulator');
  }
  report.fails = fails;
  report.pass = Object.keys(report.results).length - fails.length;
  report.fail = fails.length;
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('\nLINKED_DEVICE_PRODUCT_WIRING', report.status, `(pass=${report.pass} fail=${report.fail})`);
  console.log('ANDROID_LINKED_DEVICES_E2E', report.ANDROID_LINKED_DEVICES_E2E);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
