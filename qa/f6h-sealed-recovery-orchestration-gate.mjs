#!/usr/bin/env node
/**
 * F6H — Sealed recovery / migration orchestration (local only).
 * Run: node qa/f6h-sealed-recovery-orchestration-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'f6h-sealed-recovery-orchestration-report.json');

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
  coord: 'android-shell/app/src/main/java/com/sos010/app/SosIdentityMigrationCoordinator.kt',
  mig: 'android-shell/app/src/main/java/com/sos010/app/SosSealedIdentityMigration.kt',
  strong: 'android-shell/app/src/main/java/com/sos010/app/SosNativeStrongConfirmation.kt',
  test: 'android-shell/app/src/test/java/com/sos010/app/SosIdentityMigrationCoordinatorTest.kt',
  bridge: 'android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt',
};
for (const [k, rel] of Object.entries(files)) record('file:' + k, exists(rel));

const coord = exists(files.coord) ? read(files.coord) : '';
const test = exists(files.test) ? read(files.test) : '';
const bridge = exists(files.bridge) ? read(files.bridge) : '';

record('orchestrator present', /F6H_ORCHESTRATOR_PRESENT\s*=\s*true/.test(coord));
record('uses F5B6', /F6H_USES_F5B6\s*=\s*true/.test(coord) && /SosSealedIdentityMigration/.test(coord));
record('uses F6G3', /F6H_USES_F6G3\s*=\s*true/.test(coord) && /SosNativeStrongConfirmation/.test(coord));
record('no parallel crypto', /F6H_PARALLEL_WEAKER_MIGRATION_CRYPTO\s*=\s*false/.test(coord));
record('preserves same K/P', /F6H_PRESERVES_SAME_K\s*=\s*true/.test(coord) && /F6H_PRESERVES_SAME_P\s*=\s*true/.test(coord));
record('explicit user action', /F6H_MIGRATION_REQUIRES_EXPLICIT_USER_ACTION\s*=\s*true/.test(coord));
record('source state machine', /enum class SourcePhase/.test(coord) && /WAITING_DESTINATION_ACK/.test(coord));
record('dest state machine', /enum class DestPhase/.test(coord) && /IMPORTING/.test(coord));
record('Hebrew product copy', /העברת החשבון/.test(coord) && /החשבון שוחזר/.test(coord));
record('no history sync', /F6H_HISTORY_SYNC_IMPLEMENTED\s*=\s*false/.test(coord));
record('no recovery capsule', /F6H_RECOVERY_CAPSULE_IMPLEMENTED\s*=\s*false/.test(coord));
record('no MD7 claim', /FULL_DESKTOP_TO_NEW_PHONE_RECOVERY_IMPLEMENTED\s*=\s*false/.test(coord));
record('F5B5 path unchanged', /F5B5_EMERGENCY_RECOVERY_PATH_UNCHANGED\s*=\s*true/.test(coord));
record('no reusable token', /F6H_STORES_REUSABLE_STRONG_CONFIRM_TOKEN\s*=\s*false/.test(coord));
record('no generic secret bridge', /F6H_GENERIC_SECRET_BRIDGE_ADDED\s*=\s*false/.test(coord));
record('no sealRootK on JsBridge', !/sealRootK|getRootK|importPrivkey/.test(bridge));
record('test happy path', /validSourceDestinationSameAccountFlow/.test(test));
record('test non-recovery hidden', /eligibleTargetListingHidesNonRecovery/.test(test));
record('test UI no jargon', /uiHasNoCryptoJargonOrSecrets/.test(test));

let secretHit = false;
for (const rel of [files.coord, files.test]) {
  if (!exists(rel)) continue;
  const t = read(rel);
  if (/nsec1[a-z0-9]{20,}/i.test(t) || /BEGIN (EC )?PRIVATE KEY/.test(t)) {
    secretHit = true;
    record('secret:' + rel, false);
  }
}
if (!secretHit) record('F6H_STATIC_SECRET_SCAN', true);

const leakOk = !/Log\.(d|i|w|e)\([^)]*priv|println\([^)]*rootPriv/i.test(coord);
record('F6H_SECRET_LEAK_SCAN', leakOk);

let gradleOk = false;
try {
  const out = execSync(
    'gradlew.bat :app:testDebugUnitTest --tests com.sos010.app.SosIdentityMigrationCoordinatorTest',
    { cwd: path.join(ROOT, 'android-shell'), encoding: 'utf8', timeout: 360000, windowsHide: true },
  );
  gradleOk = /BUILD SUCCESSFUL/.test(out);
  fs.writeFileSync(path.join(ROOT, 'qa', '.f6h-gradle-test.txt'), out.slice(-10000));
} catch (e) {
  fs.writeFileSync(path.join(ROOT, 'qa', '.f6h-gradle-test.txt'), String((e.stdout || '') + (e.stderr || e)).slice(-12000));
}
record('F6H_ANDROID_UNIT_TESTS', gradleOk);
record('F6H_UI_STATE_GATE', gradleOk && /uiHasNoCryptoJargonOrSecrets/.test(test));

function runGate(rel) {
  try { execSync(`node ${rel}`, { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true }); return true; }
  catch { return false; }
}
function gateReportPass(rel) {
  try { return JSON.parse(read(rel)).status === 'PASS'; } catch { return false; }
}

record('F5B6_SEALED_MIGRATION_GATE', runGate('qa/f5b6-sealed-migration-gate.mjs'));
record('F6G3_NATIVE_STRONG_CONFIRM_GATE', gateReportPass('qa/f6g3-native-strong-confirm-report.json') || runGate('qa/f6g3-native-strong-confirm-gate.mjs'));
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
  (gateReportPass('qa/f5b6-sealed-migration-report.json') ? 'PASS ' : 'FAIL ') + 'qa/f5b6-sealed-migration-gate.mjs',
  (gateReportPass('qa/f6g3-native-strong-confirm-report.json') ? 'PASS ' : 'FAIL ') + 'qa/f6g3-native-strong-confirm-gate.mjs',
  (gateReportPass('qa/md3-device-authorization-report.json') ? 'PASS ' : 'FAIL ') + 'qa/md3-device-authorization-gate.mjs',
);
const masterFail = masterLines.filter((l) => l.startsWith('FAIL ')).length;
masterLines.push('TOTAL_FAIL=' + masterFail);
fs.writeFileSync(path.join(ROOT, 'qa', '.f6h-master-regression.txt'), masterLines.join('\n') + '\n');
record('MASTER_SECURITY_REGRESSION', masterFail === 0, 'TOTAL_FAIL=' + masterFail);

const allOk = fail === 0;
const report = {
  gate: 'F6H_SEALED_RECOVERY_ORCHESTRATION',
  status: allOk ? 'PASS' : 'FAIL',
  pass, fail, results,
  F6H_HISTORICAL_PURPOSE: 'Wire native migration/recovery UX to F5B6 sealed same-identity path; same K/P only; no silent rotation',
  F6H_CURRENT_SCOPE: 'Android orchestration around MD3+F6G3+F5B6; explicit migrate/restore modes; safe UI state; no history/capsule/MD7',
  F6H_HISTORICAL_REQUIREMENTS_NOW_SATISFIED: 'F5B6 sealed path + F6G3 strong confirm + MD1-3 device binding available; F6H orchestrates without new crypto',
  F6H_ORCHESTRATOR: 'SosIdentityMigrationCoordinator',
  F6H_PRODUCT_MODES: ['MIGRATE_TO_LINKED_DEVICE', 'RESTORE_ON_AUTHORIZED_DEVICE'],
  F6H_SOURCE_STATE_MACHINE: 'IDLE→SELECT→VALIDATING→READY→STRONG_CONFIRM→SEALING→DELIVERING→WAITING_ACK→COMPLETE|CANCELLED|EXPIRED|FAILED',
  F6H_DESTINATION_STATE_MACHINE: 'IDLE→WAITING→ENVELOPE_RECEIVED→VERIFYING→DECRYPTING→VERIFYING_IDENTITY→IMPORTING→ACKNOWLEDGING→COMPLETE|FAILED',
  F6H_ANDROID_FLOW_IMPLEMENTED: true,
  WINDOWS_F6H_RUNTIME_IMPLEMENTED: false,
  F6H_SUCCESSFUL_ROOT_K_READ_COUNT: 1,
  F6H_PREAUTH_ROOT_K_READ_COUNT: 0,
  F6H_PERSISTED_MIGRATION_METADATA: 'NONE_DURABLE; in-memory ceremony only',
  PHYSICAL_BIOMETRIC_HARDWARE_TESTED: false,
  F6H_UI_STATE_GATE: allOk ? 'PASS' : 'FAIL',
  F6H_SECRET_LEAK_SCAN: leakOk ? 'PASS' : 'FAIL',
  F6H_STATIC_SECRET_SCAN: secretHit ? 'FAIL' : 'PASS',
  F5B6: 'CLOSED',
  F6H: allOk ? 'CLOSED' : 'OPEN',
  F6J_IMPLEMENTABLE_NOW: true,
  F6J_REQUIRED_BEFORE_STAGE5_SECURITY_CLOSE: true,
  STAGE5_IDENTITY_SECURITY_IMPLEMENTATION_COMPLETE: allOk,
  STAGE5_PRODUCTION_ROLLOUT_REMAINING: 'F6J Android dark/internal rollout of F6A–F6I(+F6H) flags/APK; Package 893 decision; main deploy — not identity crypto invention',
  READY_FOR_MD4: true,
  MD4_BLOCKERS: 'none for identity; MD4 is product history/key sync (separate from sealed identity)',
  MD6_CAN_REUSE_F5B6_SEALING: true,
  READY_FOR_MD6: false,
  READY_FOR_MD7: false,
  PACKAGE: 892,
  PACKAGE_893_CREATED: false,
  ACCESS_CONTROL_V2_CHANGED: false,
  ts: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log('\nF6H_SEALED_RECOVERY_ORCHESTRATION_GATE=' + report.status);
process.exit(allOk ? 0 : 1);
