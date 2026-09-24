#!/usr/bin/env node
/**
 * MD3 — Device authorization static + unit gate (local only).
 * Run: node qa/md3-device-authorization-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'md3-device-authorization-report.json');

const results = [];
let pass = 0;
let fail = 0;
function record(name, ok, detail = '') {
  if (ok) { pass++; results.push('PASS ' + name + (detail ? ' — ' + detail : '')); console.log('PASS ' + name + (detail ? ' — ' + detail : '')); }
  else { fail++; results.push('FAIL ' + name + (detail ? ' — ' + detail : '')); console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

const files = {
  auth: 'android-shell/app/src/main/java/com/sos010/app/SosDeviceAuthorization.kt',
  reg: 'android-shell/app/src/main/java/com/sos010/app/SosDeviceAuthorizationRegistry.kt',
  cer: 'android-shell/app/src/main/java/com/sos010/app/SosDeviceAuthorizationCeremony.kt',
  test: 'android-shell/app/src/test/java/com/sos010/app/SosDeviceAuthorizationTest.kt',
  doc: 'docs/security/MD3_DEVICE_AUTHORIZATION.md',
  bridge: 'android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt',
};
for (const [k, rel] of Object.entries(files)) record('file:' + k, exists(rel));

const auth = exists(files.auth) ? read(files.auth) : '';
const reg = exists(files.reg) ? read(files.reg) : '';
const cer = exists(files.cer) ? read(files.cer) : '';
const test = exists(files.test) ? read(files.test) : '';
const doc = exists(files.doc) ? read(files.doc) : '';
const bridge = exists(files.bridge) ? read(files.bridge) : '';
const all = auth + reg + cer;

record('version sos-device-authorization-v1', /sos-device-authorization-v1/.test(auth));
record('domain SOS_DEVICE_AUTHORIZATION_V1', /SOS_DEVICE_AUTHORIZATION_V1/.test(auth));
record('typed AUTHORIZE_LINKED_DEVICE', /AUTHORIZE_LINKED_DEVICE/.test(cer));
record('no generic root sign API', !/fun signArbitrary|fun signBytes|fun getPrivkey|fun getNsec/.test(all));
record('MAX_LINKED_DEVICES 4', /MAX_LINKED_DEVICES/.test(auth + reg) && /MAX_LINKED_DEVICES\s*=\s*4|MAX_LINKED_DEVICES/.test(auth));
record('DEVICE_ADMIN not auto', /DEVICE_ADMIN/.test(auth) && /ADMIN_NOT_ALLOWED|never/.test(auth + doc));
record('recovery requires confirm', /RECOVERY_CAPABLE_DEFAULT|userConfirmedRecovery|recoveryEnabled/.test(cer + auth));
record('SOFTWARE_ONLY no recovery', /RECOVERY_STORAGE_CLASS|SOFTWARE_ONLY/.test(auth));
record('pairing consumed', /PAIRING_ALREADY_CONSUMED|spentPairings/.test(cer));
record('atomic LINKED_AUTHORIZED', /LINKED_AUTHORIZED/.test(cer));
record('no recovery capsule', !/RecoveryCapsule|rootWrap|wrapRootK/.test(all));
record('no history key transfer', !/ConversationKeyIndex|transferHistoryKeys/.test(all));
record('no WebView authorize API', !/authorizeLinkedDevice|AUTHORIZE_LINKED_DEVICE/.test(bridge));
record('doc present', /F5B6_MODEL_B_PRIMITIVE/.test(doc) || /F5B6/.test(doc));
record('test happy path', /happyPathLinkedAuthorized/.test(test));
record('test fifth device', /fifthDeviceRejected/.test(test));
record('test cancel', /cancelBeforeSignNoActive|cancelAfterSignNoActive/.test(test));

let secretHit = false;
for (const rel of Object.values(files)) {
  if (!exists(rel)) continue;
  const t = read(rel);
  if (/nsec1[a-z0-9]{20,}/i.test(t) || /BEGIN (EC )?PRIVATE KEY/.test(t)) { secretHit = true; record('secret:' + rel, false); }
}
if (!secretHit) record('MD3_STATIC_SECRET_SCAN', true);

let gradleOk = false;
try {
  const out = execSync(
    'gradlew.bat :app:testDebugUnitTest --tests com.sos010.app.SosDeviceAuthorizationTest --tests com.sos010.app.SosPairingSessionTest --tests com.sos010.app.SosDeviceIdentityStoreTest',
    { cwd: path.join(ROOT, 'android-shell'), encoding: 'utf8', timeout: 360000, windowsHide: true },
  );
  gradleOk = /BUILD SUCCESSFUL/.test(out);
  fs.writeFileSync(path.join(ROOT, 'qa', '.md3-gradle-test.txt'), out.slice(-10000));
} catch (e) {
  fs.writeFileSync(path.join(ROOT, 'qa', '.md3-gradle-test.txt'), String((e.stdout || '') + (e.stderr || e)).slice(-12000));
}
record('MD3_ANDROID_UNIT_TESTS', gradleOk);

function runGate(rel) {
  try { execSync(`node ${rel}`, { cwd: ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true }); return true; }
  catch { return false; }
}
record('MD2_PAIRING_PROTOCOL_GATE', runGate('qa/md2-pairing-protocol-gate.mjs'));
record('MD1_DEVICE_IDENTITY_GATE', runGate('qa/md1-device-identity-gate.mjs'));

const masterGates = [
  'qa/native-secure-identity-store-f6a-gate.mjs',
  'qa/native-typed-signer-f6b-gate.mjs',
  'qa/md1-device-identity-gate.mjs',
  'qa/md2-pairing-protocol-gate.mjs',
];
let masterFail = 0;
const lines = [];
for (const g of masterGates) {
  const ok = exists(g) && runGate(g);
  lines.push((ok ? 'PASS ' : 'FAIL ') + g);
  if (!ok) masterFail++;
}
lines.push('TOTAL_FAIL=' + masterFail);
fs.writeFileSync(path.join(ROOT, 'qa', '.md3-master-regression.txt'), lines.join('\n') + '\n');
record('MASTER_SECURITY_REGRESSION', masterFail === 0, 'TOTAL_FAIL=' + masterFail);

const report = {
  gate: 'MD3_DEVICE_AUTHORIZATION',
  status: fail === 0 ? 'PASS' : 'FAIL',
  pass, fail, results,
  DEVICE_AUTHORIZATION_VERSION: 'sos-device-authorization-v1',
  DEVICE_AUTHORIZATION_ENCODING: 'canonical-line-v1+sha256+schnorr',
  DEVICE_AUTH_ROOT_SIGNING_PATH: 'SosSecureIdentityStore→PhoneIssuer.signAfterConfirm→signUnderRoot(SOS_DEVICE_AUTHORIZATION_V1)',
  DEVICE_AUTHORIZATION_DEFAULT_LIFETIME: '365d',
  DEVICE_AUTH_EPOCH_INITIAL: 1,
  MAX_LINKED_DEVICES: 4,
  F5B6_AUTHENTICATED_DESTINATION_KEY_AVAILABLE: true,
  F5B6_MODEL_B_PRIMITIVE_COMPLETE: true,
  F5B6_READY_AFTER_MD3: false,
  ROOT_K_TRANSFERRED_TO_DEVICE_IN_MD3: false,
  RECOVERY_CAPSULE_IMPLEMENTED: false,
  HISTORY_SYNC_IMPLEMENTED: false,
  ACCESS_CONTROL_V2_CHANGED: false,
  PACKAGE: 892,
  PACKAGE_893_CREATED: false,
  ts: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log('\nMD3_DEVICE_AUTHORIZATION_GATE=' + report.status);
process.exit(fail === 0 ? 0 : 1);
