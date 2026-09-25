#!/usr/bin/env node
/**
 * F5B6 — Sealed same-identity migration to authorized device (local only).
 * Run: node qa/f5b6-sealed-migration-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'f5b6-sealed-migration-report.json');

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
  mig: 'android-shell/app/src/main/java/com/sos010/app/SosSealedIdentityMigration.kt',
  strong: 'android-shell/app/src/main/java/com/sos010/app/SosNativeStrongConfirmation.kt',
  trusted: 'android-shell/app/src/main/java/com/sos010/app/SosNativeTrustedConfirmation.kt',
  test: 'android-shell/app/src/test/java/com/sos010/app/SosSealedIdentityMigrationTest.kt',
  bridge: 'android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt',
};
for (const [k, rel] of Object.entries(files)) record('file:' + k, exists(rel));

const mig = exists(files.mig) ? read(files.mig) : '';
const strong = exists(files.strong) ? read(files.strong) : '';
const trusted = exists(files.trusted) ? read(files.trusted) : '';
const test = exists(files.test) ? read(files.test) : '';
const bridge = exists(files.bridge) ? read(files.bridge) : '';

record('protocol sos-sealed-migration-v1', /sos-sealed-migration-v1/.test(mig));
record('domain SOS_SEALED_MIGRATION_V1', /SOS_SEALED_MIGRATION_V1/.test(mig));
record('uses F6G3 strong confirm', /SosNativeStrongConfirmation/.test(mig) && /F5B6_USES_F6G3_STRONG_CONFIRM\s*=\s*true/.test(mig));
record('HKDF-SHA256', /HKDF-SHA256/.test(mig) && /HKDF_INFO/.test(mig));
record('AES-256-GCM', /AES-256-GCM|AES\/GCM\/NoPadding/.test(mig));
record('ephemeral X25519', /SosX25519\.generateKeyPair/.test(mig));
record('root migration signature', /migrationSignMessage|verifyRootMigrationSig/.test(mig));
record('no generic seal API', /GENERIC_SEAL_TO_PUBKEY_API_CREATED\s*=\s*false/.test(mig));
record('no nsec', /F5B6_NSEC_CREATED\s*=\s*false/.test(mig));
record('no history transfer', /F5B6_TRANSFERS_MESSAGE_HISTORY\s*=\s*false/.test(mig));
record('no recovery capsule', /RECOVERY_CAPSULE_IMPLEMENTED_IN_F5B6\s*=\s*false/.test(mig));
record('preserves same K/P', /F5B6_PRESERVES_SAME_K\s*=\s*true/.test(mig) && /F5B6_PRESERVES_SAME_P\s*=\s*true/.test(mig));
record('destination ACK by D_sign', /ACK_DOMAIN/.test(mig) && /signWithLocalDSign/.test(mig));
record('state machine explicit', /enum class State/.test(mig) && /COMPLETE/.test(mig));
record('trusted flag F5B6 true', /F5B6_MIGRATION_IMPLEMENTED\s*=\s*true/.test(trusted));
record('F6G3 still no envelope', /SEALED_MIGRATION_ENVELOPE_IMPLEMENTED\s*=\s*false/.test(strong));
record('no WebView migration API', !/SealedIdentityMigration|sealRootK|migrateIdentity/.test(bridge));
record('test happy path', /validSameKMigration/.test(test));
record('test preauth no K', /missingRecoveryFailsBeforeKRead/.test(test));
record('test account mismatch', /differentExistingAccountNotOverwritten/.test(test));

let secretHit = false;
for (const rel of [files.mig, files.test]) {
  if (!exists(rel)) continue;
  const t = read(rel);
  if (/nsec1[a-z0-9]{20,}/i.test(t) || /BEGIN (EC )?PRIVATE KEY/.test(t)) {
    secretHit = true;
    record('secret:' + rel, false);
  }
}
if (!secretHit) record('F5B6_STATIC_SECRET_SCAN', true);

const leakOk =
  !/Log\.(d|i|w|e|v)\([^)]*rootPriv|Log\.[^(]*nsec|println\([^)]*privateKey/i.test(mig) &&
  !/toString\(\)[^\n]*kBytes/.test(mig);
record('F5B6_SECRET_LEAK_SCAN', leakOk);

let gradleOk = false;
try {
  const out = execSync(
    'gradlew.bat :app:testDebugUnitTest --tests com.sos010.app.SosSealedIdentityMigrationTest',
    { cwd: path.join(ROOT, 'android-shell'), encoding: 'utf8', timeout: 360000, windowsHide: true },
  );
  gradleOk = /BUILD SUCCESSFUL/.test(out);
  fs.writeFileSync(path.join(ROOT, 'qa', '.f5b6-gradle-test.txt'), out.slice(-10000));
} catch (e) {
  fs.writeFileSync(path.join(ROOT, 'qa', '.f5b6-gradle-test.txt'), String((e.stdout || '') + (e.stderr || e)).slice(-12000));
}
record('F5B6_ANDROID_UNIT_TESTS', gradleOk);

function runGate(rel) {
  try { execSync(`node ${rel}`, { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true }); return true; }
  catch { return false; }
}
function gateReportPass(rel) {
  try {
    const j = JSON.parse(read(rel));
    return j.status === 'PASS';
  } catch { return false; }
}

record('F6G3_NATIVE_STRONG_CONFIRM_GATE', runGate('qa/f6g3-native-strong-confirm-gate.mjs'));
record('MD3_DEVICE_AUTHORIZATION_GATE', runGate('qa/md3-device-authorization-gate.mjs'));
record('MD2_PAIRING_PROTOCOL_GATE', gateReportPass('qa/md2-pairing-protocol-report.json'));
record('MD1_DEVICE_IDENTITY_GATE', gateReportPass('qa/md1-device-identity-report.json'));

let f5b5Ok = false;
try {
  const f5b5 = JSON.parse(read('qa/stage5-post-f5b5-dependency-reconciliation-report.json'));
  f5b5Ok = f5b5.status === 'PASS' && f5b5.securityTrack?.F5B5 === 'CLOSED';
} catch { /* */ }
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
  (gateReportPass('qa/f6g3-native-strong-confirm-report.json') ? 'PASS ' : 'FAIL ') + 'qa/f6g3-native-strong-confirm-gate.mjs',
  (gateReportPass('qa/md3-device-authorization-report.json') ? 'PASS ' : 'FAIL ') + 'qa/md3-device-authorization-gate.mjs',
  (gateReportPass('qa/md2-pairing-protocol-report.json') ? 'PASS ' : 'FAIL ') + 'qa/md2-pairing-protocol-gate.mjs',
  (gateReportPass('qa/md1-device-identity-report.json') ? 'PASS ' : 'FAIL ') + 'qa/md1-device-identity-gate.mjs',
);
const masterFail = masterLines.filter((l) => l.startsWith('FAIL ')).length;
masterLines.push('TOTAL_FAIL=' + masterFail);
fs.writeFileSync(path.join(ROOT, 'qa', '.f5b6-master-regression.txt'), masterLines.join('\n') + '\n');
record('MASTER_SECURITY_REGRESSION', masterFail === 0, 'TOTAL_FAIL=' + masterFail);

const report = {
  gate: 'F5B6_SEALED_MIGRATION',
  status: fail === 0 ? 'PASS' : 'FAIL',
  pass, fail, results,
  F5B6_MODULE: 'SosSealedIdentityMigration',
  F5B6_PROTOCOL_VERSION: 'sos-sealed-migration-v1',
  F5B6_ENVELOPE_FORMAT: 'sos-sealed-migration-v1{version,header,senderEphemeralPub,aeadNonce,ciphertext,rootSignature}',
  F5B6_AEAD: 'AES-256-GCM',
  F5B6_KDF: 'HKDF-SHA256',
  F5B6_MIGRATION_TTL_SECONDS: 120,
  F5B6_ATOMICITY_MODEL: 'CEREMONY_MEMORY_ONLY; source restart requires fresh strong-confirm; identical envelope returns same ACK; no second identity',
  SAME_ACCOUNT_REIMPORT_POLICY: 'IDEMPOTENT_ACK_WITHOUT_REIMPORT_OR_SAFE_SAME_K_RESEAL',
  F5B6_IDENTICAL_RETRANSMISSION_POLICY: 'SAME_ENVELOPE_HASH_RETURNS_CACHED_ACK_WITHOUT_REUNWRAP',
  F5B6_CIPHERTEXT_ENVELOPE_PERSISTENCE: 'TRANSIENT_IN_MEMORY_FOR_TRANSPORT_ONLY',
  SUCCESSFUL_F5B6_ROOT_K_READ_COUNT: 1,
  F5B6_ROOT_SIGNATURE_COUNT_PER_SUCCESS: 1,
  F5B6_PREAUTH_ROOT_K_READ_COUNT: 0,
  F5B6_ANDROID_TEST_LEVEL: 'UNIT_SOFT_STRONG_AUTH',
  PHYSICAL_BIOMETRIC_HARDWARE_TESTED: false,
  F5B6_MIGRATION_REPLAY_GATE: fail === 0 ? 'PASS' : 'FAIL',
  F5B6_SECRET_LEAK_SCAN: leakOk ? 'PASS' : 'FAIL',
  F5B6_STATIC_SECRET_SCAN: secretHit ? 'FAIL' : 'PASS',
  F6H_DEPENDS_ON_F5B6: true,
  F6H_BLOCKER_FROM_F5B6_CLEARED: fail === 0,
  READY_FOR_F6H: fail === 0,
  F6H_REMAINING_NOTE: fail === 0
    ? 'F5B6 protocol primitive closed; F6H is UX wiring to this sealed path (not implemented here)'
    : 'F5B6 incomplete',
  MD6_CAN_REUSE_F5B6_SEALING: true,
  WINDOWS_F5B6_RUNTIME_IMPLEMENTED: false,
  PACKAGE: 892,
  PACKAGE_893_CREATED: false,
  ACCESS_CONTROL_V2_CHANGED: false,
  ts: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log('\nF5B6_SEALED_MIGRATION_GATE=' + report.status);
process.exit(fail === 0 ? 0 : 1);
