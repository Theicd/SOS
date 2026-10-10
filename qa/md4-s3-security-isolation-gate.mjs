#!/usr/bin/env node
/**
 * MD4 S3 preflight — test-only key API + production bridge secret isolation.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'md4-s3-security-isolation-report.json');
const RUN_ID = process.env.SOS_MD4_S3_ISO_RUN_ID || crypto.randomUUID();

const results = {};
let pass = 0;
let fail = 0;
function set(k, ok, detail) {
  results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  if (ok) pass++;
  else fail++;
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 200));
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const store = read('android-shell/app/src/main/java/com/sos010/app/SosDeviceIdentityStore.kt');
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const exporter = read('android-shell/app/src/main/java/com/sos010/app/SosHistorySyncExporter.kt');
const phone = read('android-shell/app/src/main/java/com/sos010/app/SosHistorySyncPhoneSession.kt');
const histJs = read('sos-md4-history-sync.js');
const pairTransport = read('android-shell/app/src/main/java/com/sos010/app/SosPairingNostrTransport.kt');

set('COPY_ENC_PRIV_DEBUG_GATED', /BuildConfig\.DEBUG/.test(store) && /copyEncPrivateKeyForTests/.test(store));
set('COPY_ENC_PRIV_NOT_ON_JSBRIDGE', !/copyEncPrivateKeyForTests/.test(bridge));
set(
  'BRIDGE_EXPORT_SEALED_ONLY',
  /exportConversationKeyIndexSealed/.test(bridge) &&
    !/conversationKey|privateKeyHex|rootK|nsec/.test(bridge.match(/exportConversationKeyIndexSealed[\s\S]{0,900}/)?.[0] || ''),
);
set('EXPORTER_NO_PLAINTEXT_KEYS_IN_PUBLIC_JSON', /PLAINTEXT_KEYS_EXPORTED,\s*false/.test(exporter) || /PLAINTEXT_KEYS_EXPORTED/.test(exporter));
set('PHONE_SESSION_NO_ROOT_EXPORT', /ROOT_K_SENT_TO_DESKTOP:\s*Boolean\s*=\s*false/.test(phone));
set('HIST_JS_NO_ROOT', !/rootK|getNsec|privateKeyHex/.test(histJs) || /ROOT_K_PRESENT:\s*false/.test(histJs));
set('PAIR_TRANSPORT_REJECTS_NON_PAIR_TAG', /protocolTag != TAG/.test(pairTransport));
set('HIST_TRANSPORT_USES_HIST_TAG', /sos-hist-v1/.test(read('android-shell/app/src/main/java/com/sos010/app/SosHistoryNostrTransport.kt')));
set('FIXTURE_PRIV_NOT_IN_PRODUCT_RUNTIME', !/android-sealed-cki\.json|\.md4-s2-fixtures/.test(histJs + phone + bridge));
set('ORIGIN_UNCHANGED', !fs.existsSync(path.join('C:\\BRAIN\\SOS-fga-ux-polish', 'sos-md4-history-sync.js')));

let gradleOk = false;
try {
  const out = execSync(
    'gradlew.bat :app:testDebugUnitTest --tests com.sos010.app.SosHistorySyncCryptoTest --tests com.sos010.app.SosConversationKeyIndexTest',
    { cwd: path.join(ROOT, 'android-shell'), encoding: 'utf8', timeout: 360000, windowsHide: true },
  );
  gradleOk = /BUILD SUCCESSFUL/.test(out);
  fs.writeFileSync(path.join(ROOT, 'qa', '.md4-s3-unit.txt'), out.slice(-8000));
} catch (e) {
  fs.writeFileSync(path.join(ROOT, 'qa', '.md4-s3-unit.txt'), String((e.stdout || '') + (e.stderr || e)).slice(-12000));
}
set('S3_UNIT_CRYPTO_AND_CKI', gradleOk);

const report = {
  gate: 'MD4_S3_SECURITY_ISOLATION',
  runId: RUN_ID,
  ts: new Date().toISOString(),
  pass,
  fail,
  results,
  STATUS: fail === 0 ? 'PASS' : 'FAIL',
  TEST_ONLY_KEY_API_RELEASE_ISOLATION: results.COPY_ENC_PRIV_DEBUG_GATED?.ok && results.COPY_ENC_PRIV_NOT_ON_JSBRIDGE?.ok,
  PRODUCTION_BRIDGE_SECRET_ISOLATION: results.BRIDGE_EXPORT_SEALED_ONLY?.ok,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('REPORT', OUT, report.STATUS);
process.exit(fail === 0 ? 0 : 1);
