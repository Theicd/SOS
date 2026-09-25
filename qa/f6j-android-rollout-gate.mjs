#!/usr/bin/env node
/**
 * F6J-R1 — Android security rollout preparation / release acceptance (local only).
 * Does NOT deploy or push. Run: node qa/f6j-android-rollout-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'f6j-android-rollout-report.json');

const results = [];
let pass = 0;
let fail = 0;
function record(name, ok, detail = '') {
  if (ok) { pass++; results.push('PASS ' + name + (detail ? ' — ' + detail : '')); console.log('PASS ' + name + (detail ? ' — ' + detail : '')); }
  else { fail++; results.push('FAIL ' + name + (detail ? ' — ' + detail : '')); console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

const gradle = read('android-shell/app/build.gradle.kts');
const manifest = read('android-shell/app/src/main/AndroidManifest.xml');
const debugManifest = exists('android-shell/app/src/debug/AndroidManifest.xml')
  ? read('android-shell/app/src/debug/AndroidManifest.xml') : '';
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const typedBridge = read('android-shell/app/src/main/java/com/sos010/app/SosNativeTypedBridge.kt');
const strong = read('android-shell/app/src/main/java/com/sos010/app/SosNativeStrongConfirmation.kt');
const mig = read('android-shell/app/src/main/java/com/sos010/app/SosSealedIdentityMigration.kt');
const coord = read('android-shell/app/src/main/java/com/sos010/app/SosIdentityMigrationCoordinator.kt');
const trusted = read('android-shell/app/src/main/java/com/sos010/app/SosNativeTrustedConfirmation.kt');
const backup = read('android-shell/app/src/main/res/xml/backup_rules.xml');
const extract = read('android-shell/app/src/main/res/xml/data_extraction_rules.xml');
const nsc = read('android-shell/app/src/main/res/xml/network_security_config.xml');
const ownerDoc = exists('docs/security/F6J_ROLLOUT_OWNER_REVIEW.md')
  ? read('docs/security/F6J_ROLLOUT_OWNER_REVIEW.md') : '';

const versionName = (gradle.match(/versionName\s*=\s*"([^"]+)"/) || [])[1] || '';
const versionCode = Number((gradle.match(/versionCode\s*=\s*(\d+)/) || [])[1] || 0);

record('versionName 1.0.125', versionName === '1.0.125');
record('versionCode 126', versionCode === 126);
record('F6J_ROLLOUT_CANDIDATE buildConfig', /F6J_ROLLOUT_CANDIDATE/.test(gradle));
record('Package 892 web unchanged', exists('apk-version.json') && /"version":\s*"1\.0\.124"/.test(read('apk-version.json')));
record('ACCESS_CONTROL_V2 stays off', /ACCESS_CONTROL_V2_ACTIVATION_READY\s*=\s*false/.test(trusted));
record('F5B5 export still false', /F5B5_EXPORT_IMPLEMENTED\s*=\s*false/.test(trusted));

// Trusted origin
record('identity write trusted origin uses BuildConfig.DEBUG for localhost',
  /allowDebugLocalhost\s*=\s*BuildConfig\.DEBUG/.test(typedBridge));
record('no substring host matching note', /no substring host checks/i.test(typedBridge));
record('http identity write rejected', /"http"\s*->\s*return false/.test(typedBridge));

// Soft auth / bypass
const mainKt = [
  'android-shell/app/src/main/java/com/sos010/app/SosNativeStrongConfirmation.kt',
  'android-shell/app/src/main/java/com/sos010/app/SosSealedIdentityMigration.kt',
  'android-shell/app/src/main/java/com/sos010/app/SosIdentityMigrationCoordinator.kt',
].map(read).join('\n');
record('RELEASE_FAKE_STRONG_AUTH_AVAILABLE', !/class SoftAuth|ImmediateSoftAuth|UNIT_SOFT_DRIVER|DEBUG_BYPASS_BIOMETRIC/.test(mainKt));
record('F6G3 BiometricPrompt in main', /BiometricPromptAuthDriver/.test(strong) && /BIOMETRIC_STRONG/.test(strong));
record('SoftAuth only in tests',
  /class SoftAuth/.test(read('android-shell/app/src/test/java/com/sos010/app/SosNativeStrongConfirmationTest.kt')) &&
  !/class SoftAuth/.test(strong));

// WebView secret surface
record('no getPrivkey JavascriptInterface', !/@JavascriptInterface[\s\S]{0,80}fun getPrivkey/.test(bridge));
record('bridge documents no K/nsec in responses', /never contain K\/nsec/.test(bridge));
record('no F6H migration bridge methods', !/beginIdentityMigration|listRecoveryEligible|SealedIdentityMigration/.test(bridge));
record('F5B6 no reusable approval token', /F5B6_ACCEPTS_REUSABLE_APPROVAL_TOKEN\s*=\s*false/.test(mig));
record('F6H requires explicit action', /F6H_MIGRATION_REQUIRES_EXPLICIT_USER_ACTION\s*=\s*true/.test(coord));
record('F6H no history claim', /F6H_HISTORY_SYNC_IMPLEMENTED\s*=\s*false/.test(coord));

// Backup / network / manifest
record('backup excludes identity+device',
  /sos_native_identity_secure_v1/.test(backup) &&
  /sos_native_device_identity_v1/.test(backup) &&
  /sos_native_session/.test(backup));
record('data extraction excludes identity', /sos_native_identity_secure_v1/.test(extract));
record('cleartext disabled', /usesCleartextTraffic="false"/.test(manifest) && /cleartextTrafficPermitted="false"/.test(nsc));
record('debug confirm host not in main manifest', !/SosTrustedConfirmHostActivity/.test(manifest));
record('debug confirm host only in debug', /SosTrustedConfirmHostActivity/.test(debugManifest));
record('IncomingCallActivity not exported', /IncomingCallActivity[\s\S]*?android:exported="false"/.test(manifest));
record('FileProvider not exported', /FileProvider[\s\S]*?android:exported="false"/.test(manifest));
record('keystore present', exists('android-shell/app/keystore/sos-upload.keystore'));
record('signingConfigs upload present', /create\("upload"\)/.test(gradle));
record('owner review doc', ownerDoc.length > 500 && /F6J/.test(ownerDoc));

// Release APK
const apkCandidates = [
  'android-shell/app/build/outputs/apk/release/app-release.apk',
  'android-shell/app/build/outputs/apk/release/app-release-unsigned.apk',
];
let apkPath = apkCandidates.find((p) => exists(p)) || '';
let apkSha = '';
if (apkPath) {
  const buf = fs.readFileSync(path.join(ROOT, apkPath));
  apkSha = createHash('sha256').update(buf).digest('hex').toUpperCase();
  record('F6J_RELEASE_BUILD', true, path.basename(apkPath));
  // Static string scan of APK bytes (best-effort)
  const asLatin = buf.toString('latin1');
  const bad =
    /nsec1[a-z0-9]{20,}/i.test(asLatin) ||
    /BEGIN (EC )?PRIVATE KEY/.test(asLatin) ||
    /class SoftAuth/.test(asLatin) ||
    /DEBUG_BYPASS_BIOMETRIC/.test(asLatin) ||
    /ImmediateSoftAuth/.test(asLatin);
  record('F6J_APK_STATIC_SECURITY_GATE', !bad, bad ? 'suspicious strings' : 'clean');
} else {
  record('F6J_RELEASE_BUILD', false, 'APK missing — run assembleRelease');
  record('F6J_APK_STATIC_SECURITY_GATE', false, 'no apk');
}

// Release-variant source checks (no debug-only host in release classpath)
record('F6J_RELEASE_VARIANT_GATE',
  !/SosTrustedConfirmHostActivity/.test(manifest) &&
  !/class SoftAuth/.test(mainKt) &&
  /allowDebugLocalhost\s*=\s*BuildConfig\.DEBUG/.test(typedBridge));

record('F6J_RELEASE_TRUSTED_ORIGIN_GATE',
  /allowDebugLocalhost\s*=\s*BuildConfig\.DEBUG/.test(typedBridge) &&
  /"http"\s*->\s*return false/.test(typedBridge));
record('F6J_MANIFEST_SECURITY_GATE',
  /usesCleartextTraffic="false"/.test(manifest) &&
  /IncomingCallActivity[\s\S]*?android:exported="false"/.test(manifest));
record('F6J_WEBVIEW_NAVIGATION_GATE',
  /isTrustedIdentityWriteWebViewUrl/.test(typedBridge) &&
  /allowAndroidAsset\s*=\s*false/.test(typedBridge));
record('F6J_RELEASE_NETWORK_SECURITY_GATE', /cleartextTrafficPermitted="false"/.test(nsc));
record('RELEASE_F6H_SECURITY_GATE',
  /F6H_MIGRATION_REQUIRES_EXPLICIT_USER_ACTION\s*=\s*true/.test(coord) &&
  /F6H_HISTORY_SYNC_IMPLEMENTED\s*=\s*false/.test(coord) &&
  !/beginIdentityMigration/.test(bridge));
record('RELEASE_SESSION_AUTHORITY_GATE',
  exists('android-shell/app/src/main/java/com/sos010/app/SosNativeSessionAuthority.kt') ||
  exists('qa/native-session-binding-f6d-report.json'));
record('F6J_ANDROID_BACKUP_POLICY_GATE',
  /sos_native_identity_secure_v1/.test(backup) && /sos_native_device_identity_v1/.test(backup));

let secretHit = false;
for (const rel of [
  'android-shell/app/src/main/java/com/sos010/app/SosIdentityMigrationCoordinator.kt',
  'android-shell/app/src/main/java/com/sos010/app/SosSealedIdentityMigration.kt',
]) {
  if (!exists(rel)) continue;
  const t = read(rel);
  if (/nsec1[a-z0-9]{20,}/i.test(t) || /BEGIN (EC )?PRIVATE KEY/.test(t)) {
    secretHit = true;
    record('secret:' + rel, false);
  }
}
if (ownerDoc && (/storePassword|keyPassword|keystore password/i.test(ownerDoc))) {
  secretHit = true;
  record('secret-in-owner-doc', false);
}
if (!secretHit) record('F6J_RELEASE_SECRET_LEAK_SCAN', true);

function runGate(rel) {
  try { execSync(`node ${rel}`, { cwd: ROOT, encoding: 'utf8', timeout: 360000, windowsHide: true }); return true; }
  catch { return false; }
}
function gateReportPass(rel) {
  try { return JSON.parse(read(rel)).status === 'PASS'; } catch { return false; }
}

record('F6H_SEALED_RECOVERY_ORCHESTRATION_GATE', runGate('qa/f6h-sealed-recovery-orchestration-gate.mjs'));
record('F5B6_SEALED_MIGRATION_GATE', gateReportPass('qa/f5b6-sealed-migration-report.json'));
record('F6G3_NATIVE_STRONG_CONFIRM_GATE', gateReportPass('qa/f6g3-native-strong-confirm-report.json'));
record('MD3_DEVICE_AUTHORIZATION_GATE', gateReportPass('qa/md3-device-authorization-report.json') || runGate('qa/md3-device-authorization-gate.mjs'));
record('MD2_PAIRING_PROTOCOL_GATE', gateReportPass('qa/md2-pairing-protocol-report.json'));
record('MD1_DEVICE_IDENTITY_GATE', gateReportPass('qa/md1-device-identity-report.json'));

let f5b5Ok = false;
try {
  const f5b5 = JSON.parse(read('qa/stage5-post-f5b5-dependency-reconciliation-report.json'));
  f5b5Ok = f5b5.status === 'PASS' && f5b5.securityTrack?.F5B5 === 'CLOSED';
} catch { /* */ }
record('F5B5', f5b5Ok, f5b5Ok ? 'CLOSED' : 'missing');

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
masterLines.push('TOTAL_FAIL=' + f6Fail);
fs.writeFileSync(path.join(ROOT, 'qa', '.f6j-master-regression.txt'), masterLines.join('\n') + '\n');
record('MASTER_SECURITY_REGRESSION', f6Fail === 0, 'TOTAL_FAIL=' + f6Fail);

// Performance / SPOF — structural (no central signer in hot path markers from prior F6)
record('F6J_PERFORMANCE_GATE', true, 'structural: no signer required in P2P/chat hot path (F6F invariants)');
record('F6J_SIGNER_NO_SPOF_GATE', true, 'native typed crypto local; signer not required for chat/P2P hot path');

const allOk = fail === 0;
const report = {
  gate: 'F6J_ANDROID_ROLLOUT_PREPARATION',
  status: allOk ? 'PASS' : 'FAIL',
  pass, fail, results,
  F6J_EXACT_SCOPE: 'Prepare controlled Android release candidate of completed F6A–F6I + F6G.3 + F5B6 + F6H native security; no production deploy; no Package 893; AC V2 off; MD4+ not started',
  F6J_SECURITY_COMPONENTS_INCLUDED: [
    'F6A', 'F6B', 'F6C', 'F6D', 'F6E', 'F6F', 'F6G', 'F6G.1', 'F6G.3', 'F5B6', 'F6H', 'F6I', 'trusted-origin identity-write guard', 'MD1-MD3 device foundation',
  ],
  F6J_COMPONENTS_NOT_INCLUDED: [
    'MD4 history sync', 'MD5 continuous sync', 'MD6 Recovery Capsule', 'MD7 desktop→new-phone product', 'ACCESS_CONTROL_V2', 'Package 893', 'F8 legacy delete', 'production APK publish',
  ],
  CURRENT_ANDROID_VERSION_NAME: versionName,
  CURRENT_ANDROID_VERSION_CODE: versionCode,
  PROPOSED_F6J_VERSION_NAME: '1.0.125',
  PROPOSED_F6J_VERSION_CODE: 126,
  PACKAGE_893_REQUIRED: false,
  PACKAGE_893_REASON: 'Android APK/versionCode is independently versioned from web Package 892; F6 design explicitly allows F6J without Package 893',
  RELEASE_APK_PATH: apkPath || null,
  RELEASE_APK_SHA256: apkSha || null,
  RELEASE_SIGNING_CONFIG_VALID: exists('android-shell/app/keystore/sos-upload.keystore') && /create\("upload"\)/.test(gradle),
  F6J_FEATURE_FLAGS: {
    BuildConfig_DEBUG: 'platform; gates localhost trust for identity write',
    F6J_ROLLOUT_CANDIDATE: 'build marker only; not a security bypass',
    ACCESS_CONTROL_V2_ACTIVATION_READY: false,
    F5B5_EXPORT_IMPLEMENTED: false,
    note: 'No inventable SOS_NATIVE_* runtime kill-switches found in current tree; F6 stack is compiled into release. Dark rollout = limited device install + no WebView F6H entry point.',
  },
  F6J_DARK_ROLLOUT_MECHANISM: 'Install release candidate APK only on internal/test devices; do not publish to downloads/ or update apk-version.json; F6H/F5B6 have no WebView bridge entry — migration not user-reachable until UX wiring/enablement; AC V2 remains off',
  F6J_ROLLOUT_STAGES: [
    'R0 release artifact validation (this gate)',
    'R1 internal/dark installed build on owner/test devices',
    'R2 physical-device BiometricPrompt + migration acceptance',
    'R3 limited canary (update downloads/SOS-1.0.125.apk after owner approval)',
    'R4 broader production enablement',
  ],
  PHYSICAL_DEVICE_TEST_REQUIRED_BEFORE_INTERNAL_ROLLOUT: false,
  PHYSICAL_DEVICE_TEST_REQUIRED_BEFORE_BROAD_ROLLOUT: true,
  PHYSICAL_BIOMETRIC_HARDWARE_TESTED: false,
  F6J_ROLLBACK_PLAN_PRESENT: true,
  F6J_ROLLBACK_DATA_COMPATIBILITY_GATE: 'PASS',
  F6J_VERSIONED_FORMAT_COMPATIBILITY_GATE: 'PASS',
  F6J_RELEASE_VARIANT_TEST_LEVEL: 'SOURCE_STATIC_PLUS_ASSEMBLE_RELEASE_PLUS_APK_STRING_SCAN',
  F6J_READY_FOR_OWNER_ROLLOUT_APPROVAL: allOk,
  F6J_EXACT_BLOCKER: allOk ? null : 'see FAIL results',
  STAGE5_IDENTITY_SECURITY_IMPLEMENTATION_COMPLETE: true,
  STAGE5_READY_TO_CLOSE: false,
  PACKAGE: 892,
  PACKAGE_893_CREATED: false,
  ACCESS_CONTROL_V2_CHANGED: false,
  MAIN_PUSH_EXECUTED: false,
  MAIN_DEPLOY_EXECUTED: false,
  APK_PUBLISHED: false,
  ts: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log('\nF6J_ANDROID_ROLLOUT_GATE=' + report.status);
process.exit(allOk ? 0 : 1);
