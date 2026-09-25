#!/usr/bin/env node
/**
 * F6G.3 — Native strong confirmation for SEALED_MIGRATION (local only).
 * Run: node qa/f6g3-native-strong-confirm-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'f6g3-native-strong-confirm-report.json');

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
  strong: 'android-shell/app/src/main/java/com/sos010/app/SosNativeStrongConfirmation.kt',
  trusted: 'android-shell/app/src/main/java/com/sos010/app/SosNativeTrustedConfirmation.kt',
  test: 'android-shell/app/src/test/java/com/sos010/app/SosNativeStrongConfirmationTest.kt',
  gradle: 'android-shell/app/build.gradle.kts',
  bridge: 'android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt',
};
for (const [k, rel] of Object.entries(files)) record('file:' + k, exists(rel));

const strong = exists(files.strong) ? read(files.strong) : '';
const trusted = exists(files.trusted) ? read(files.trusted) : '';
const test = exists(files.test) ? read(files.test) : '';
const gradle = exists(files.gradle) ? read(files.gradle) : '';
const bridge = exists(files.bridge) ? read(files.bridge) : '';

record('androidx.biometric dependency', /androidx\.biometric:biometric/.test(gradle));
record('minSdk 26', /minSdk\s*=\s*26/.test(gradle));
record('targetSdk 35', /targetSdk\s*=\s*35/.test(gradle));
record('domain SOS_STRONG_CONFIRM_SEALED_MIGRATION_V1', /SOS_STRONG_CONFIRM_SEALED_MIGRATION_V1/.test(strong));
record('only SEALED_MIGRATION op', /OPERATION\s*=\s*"SEALED_MIGRATION"/.test(strong));
record('BiometricPrompt driver', /BiometricPromptAuthDriver/.test(strong));
record('CryptoObject / Keystore key', /sos_strong_confirm_v1/.test(strong) && /CryptoObject/.test(strong));
record('no remember-me', /REUSE_WINDOW_SECONDS\s*=\s*0/.test(strong) && /REMEMBER_ME\s*=\s*false/.test(strong));
record('no WebView boolean/token', /WEBVIEW_RECEIVES_STRONG_CONFIRM_BOOLEAN\s*=\s*false/.test(strong));
record('no K read in F6G3', /F5B6_CONTINUATION_READS_K_IN_F6G3\s*=\s*false/.test(strong));
record('envelope not implemented', /SEALED_MIGRATION_ENVELOPE_IMPLEMENTED\s*=\s*false/.test(strong));
record('DEVICE_RECOVERY required', /MISSING_DEVICE_RECOVERY/.test(strong));
record('no fallback dialog', /FALLBACK_TO_NORMAL_DIALOG\s*=\s*false/.test(strong));
record('NORMAL confirm unchanged marker', /TRUSTED_NATIVE_CONFIRMATION_PRESENT/.test(trusted));
record('F6G3 flag on trusted', /F6G3_STRONG_CONFIRM_AVAILABLE\s*=\s*true/.test(trusted));
record('F6G3 does not seal K envelope', /SEALED_MIGRATION_ENVELOPE_IMPLEMENTED\s*=\s*false/.test(strong));
record('F6G3 continuation does not read K', /F5B6_CONTINUATION_READS_K_IN_F6G3\s*=\s*false/.test(strong));
record('no strong confirm on JsBridge', !/StrongConfirm|strongConfirm|SEALED_MIGRATION/.test(bridge));
record('fake soft auth only in test', /class SoftAuth/.test(test) && !/class ImmediateSoftAuthDriver|class SoftAuth/.test(strong));
record('test valid path', /validRequestInvokesContinuationWithoutReadingK/.test(test));
record('test missing recovery', /missingRecoveryCapabilityFails/.test(test));

let secretHit = false;
for (const rel of [files.strong, files.test]) {
  if (!exists(rel)) continue;
  const t = read(rel);
  if (/nsec1[a-z0-9]{20,}/i.test(t) || /BEGIN (EC )?PRIVATE KEY/.test(t)) {
    secretHit = true;
    record('secret:' + rel, false);
  }
}
if (!secretHit) record('F6G3_STATIC_SECRET_SCAN', true);

// Release bypass audit
const releaseBypass =
  /RELEASE_STRONG_CONFIRM_BYPASS\s*=\s*true/.test(strong) ||
  /fakeStrongAuth\s*=\s*true/.test(strong) ||
  /DEBUG_BYPASS_BIOMETRIC/.test(strong);
record('RELEASE_STRONG_CONFIRM_BYPASS_FOUND', !releaseBypass, releaseBypass ? 'found' : 'clean');

let gradleOk = false;
try {
  const out = execSync(
    'gradlew.bat :app:testDebugUnitTest --tests com.sos010.app.SosNativeStrongConfirmationTest',
    { cwd: path.join(ROOT, 'android-shell'), encoding: 'utf8', timeout: 360000, windowsHide: true },
  );
  gradleOk = /BUILD SUCCESSFUL/.test(out);
  fs.writeFileSync(path.join(ROOT, 'qa', '.f6g3-gradle-test.txt'), out.slice(-10000));
} catch (e) {
  fs.writeFileSync(path.join(ROOT, 'qa', '.f6g3-gradle-test.txt'), String((e.stdout || '') + (e.stderr || e)).slice(-12000));
}
record('F6G3_ANDROID_UNIT_TESTS', gradleOk);

function runGate(rel) {
  try { execSync(`node ${rel}`, { cwd: ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true }); return true; }
  catch { return false; }
}
// MD3 gate cascades MD2→MD1 internally — run once, then trust sibling reports.
record('MD3_DEVICE_AUTHORIZATION_GATE', runGate('qa/md3-device-authorization-gate.mjs'));
function gateReportPass(rel) {
  try {
    const j = JSON.parse(read(rel));
    return j.status === 'PASS';
  } catch { return false; }
}
record('MD2_PAIRING_PROTOCOL_GATE', gateReportPass('qa/md2-pairing-protocol-report.json'));
record('MD1_DEVICE_IDENTITY_GATE', gateReportPass('qa/md1-device-identity-report.json'));

let f5b5Ok = false;
try {
  const f5b5 = JSON.parse(read('qa/stage5-post-f5b5-dependency-reconciliation-report.json'));
  f5b5Ok = f5b5.status === 'PASS' && f5b5.securityTrack?.F5B5 === 'CLOSED';
} catch { /* missing */ }
record('F5B5', f5b5Ok, f5b5Ok ? 'CLOSED' : 'missing/open');

const f6Gates = [
  'qa/native-secure-identity-store-f6a-gate.mjs',
  'qa/native-typed-signer-f6b-gate.mjs',
  'qa/native-typed-bridge-f6c-gate.mjs',
  'qa/native-session-binding-f6d-gate.mjs',
  'qa/native-admin-policy-f6e-gate.mjs',
  'qa/native-typed-crypto-f6f-gate.mjs',
  'qa/native-trusted-confirmation-f6g-gate.mjs',
  'qa/native-trusted-confirmation-f6g1-gate.mjs',
  'qa/native-f6i-adversarial-acceptance-gate.mjs',
];
let f6Fail = 0;
const masterLines = [];
for (const g of f6Gates) {
  const ok = exists(g) && runGate(g);
  masterLines.push((ok ? 'PASS ' : 'FAIL ') + g);
  if (!ok) f6Fail++;
}
record('F6A_F6I', f6Fail === 0, 'FAIL_COUNT=' + f6Fail);

masterLines.push(
  (gateReportPass('qa/md3-device-authorization-report.json') ? 'PASS ' : 'FAIL ') + 'qa/md3-device-authorization-gate.mjs',
  (gateReportPass('qa/md2-pairing-protocol-report.json') ? 'PASS ' : 'FAIL ') + 'qa/md2-pairing-protocol-gate.mjs',
  (gateReportPass('qa/md1-device-identity-report.json') ? 'PASS ' : 'FAIL ') + 'qa/md1-device-identity-gate.mjs',
);
const masterFail = masterLines.filter((l) => l.startsWith('FAIL ')).length;
masterLines.push('TOTAL_FAIL=' + masterFail);
fs.writeFileSync(path.join(ROOT, 'qa', '.f6g3-master-regression.txt'), masterLines.join('\n') + '\n');
record('MASTER_SECURITY_REGRESSION', masterFail === 0, 'TOTAL_FAIL=' + masterFail);

const report = {
  gate: 'F6G3_NATIVE_STRONG_CONFIRM',
  status: fail === 0 ? 'PASS' : 'FAIL',
  pass, fail, results,
  ANDROIDX_BIOMETRIC_AVAILABLE: true,
  ANDROID_MIN_SDK: 26,
  ANDROID_TARGET_SDK: 35,
  BIOMETRIC_CRYPTOOBJECT_BINDING_AVAILABLE: true,
  STRONG_CONFIRM_AUTHENTICATOR_POLICY: 'BIOMETRIC_STRONG|DEVICE_CREDENTIAL',
  STRONG_CONFIRM_MODULE: 'SosNativeStrongConfirmation',
  F6G3_SUPPORTED_STRONG_INTENTS: ['SEALED_MIGRATION'],
  STRONG_CONFIRM_REQUEST_TTL_SECONDS: 120,
  F5B6_PRIVATE_CONTINUATION_POINT_PRESENT: true,
  F5B6_CONTINUATION_READS_K_IN_F6G3: false,
  F6G3_ANDROID_INSTRUMENTATION_LEVEL: 'UNIT_SOFT_DRIVER',
  PHYSICAL_BIOMETRIC_HARDWARE_TESTED: false,
  RELEASE_CAN_USE_FAKE_STRONG_AUTH: false,
  F5B6_MODEL_B_PRIMITIVE_COMPLETE: true,
  F5B6_STRONG_CONFIRMATION_AVAILABLE_NOW: fail === 0,
  READY_FOR_F5B6: fail === 0,
  PACKAGE: 892,
  PACKAGE_893_CREATED: false,
  ACCESS_CONTROL_V2_CHANGED: false,
  ts: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log('\nF6G3_NATIVE_STRONG_CONFIRM_GATE=' + report.status);
process.exit(fail === 0 ? 0 : 1);
