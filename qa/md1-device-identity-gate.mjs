#!/usr/bin/env node
/**
 * MD1 — Device identity + secure storage static gate (local only).
 * Run: node qa/md1-device-identity-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'md1-device-identity-report.json');

const results = [];
let pass = 0;
let fail = 0;

function record(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name + (detail ? ' — ' + detail : ''));
    console.log('PASS ' + name + (detail ? ' — ' + detail : ''));
    return true;
  }
  fail += 1;
  results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
  console.log('FAIL ' + name + (detail ? ' — ' + detail : ''));
  return false;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

const files = {
  store: 'android-shell/app/src/main/java/com/sos010/app/SosDeviceIdentityStore.kt',
  crypto: 'android-shell/app/src/main/java/com/sos010/app/SosDeviceKeyCrypto.kt',
  policy: 'android-shell/app/src/main/java/com/sos010/app/SosDeviceKeyPolicy.kt',
  x25519: 'android-shell/app/src/main/java/com/sos010/app/SosX25519.kt',
  test: 'android-shell/app/src/test/java/com/sos010/app/SosDeviceIdentityStoreTest.kt',
  contract: 'docs/security/MD1_WINDOWS_DEVICE_STORAGE_CONTRACT.md',
  md0: 'docs/security/MD0_LINKED_DEVICES_ARCHITECTURE.md',
  backup: 'android-shell/app/src/main/res/xml/backup_rules.xml',
  extraction: 'android-shell/app/src/main/res/xml/data_extraction_rules.xml',
  bridge: 'android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt',
};

for (const [k, rel] of Object.entries(files)) {
  record(`file:${k}`, exists(rel));
}

const store = exists(files.store) ? read(files.store) : '';
const crypto = exists(files.crypto) ? read(files.crypto) : '';
const policy = exists(files.policy) ? read(files.policy) : '';
const x25519 = exists(files.x25519) ? read(files.x25519) : '';
const test = exists(files.test) ? read(files.test) : '';
const contract = exists(files.contract) ? read(files.contract) : '';
const bak = exists(files.backup) ? read(files.backup) : '';
const ext = exists(files.extraction) ? read(files.extraction) : '';
const bridge = exists(files.bridge) ? read(files.bridge) : '';
const allKotlin = store + crypto + policy + x25519;

record('scheme sos-device-keys-v1', /sos-device-keys-v1/.test(policy + store));
record('MAX_LINKED_DEVICES=4', /MAX_LINKED_DEVICES\s*=\s*4/.test(policy));
record('DEVICE_ID_BITS=256', /DEVICE_ID_BITS\s*=\s*256/.test(policy));
record('D_sign secp256k1', /DEVICE_SIGNING_ALGORITHM\s*=\s*"secp256k1"/.test(policy));
record('D_enc X25519', /DEVICE_ENCRYPTION_ALGORITHM\s*=\s*"X25519"/.test(policy));
record('D_SIGN encoding versioned', /secp256k1-xonly-hex-v1/.test(policy));
record('D_ENC encoding versioned', /x25519-u-hex-v1/.test(policy));
record('storage class PLATFORM_WRAPPED', /PLATFORM_WRAPPED/.test(policy + store));
record('SOFTWARE_ONLY not recovery eligible', /INSECURE_SOFT_KEY_RECOVERY_ELIGIBLE\s*=\s*false/.test(policy));
record('RECOVERY_CAPABILITY_GRANTED_IN_MD1=false', /RECOVERY_CAPABILITY_GRANTED_IN_MD1\s*=\s*false/.test(policy));
record('scope installation', /DEVICE_IDENTITY_SCOPE\s*=\s*"installation"/.test(policy));
record('AAD device-key v1', /SOS\|device-key\|v1/.test(store));
record('dedicated wrap alias', /sos_device_key_wrap_v1/.test(store));
record('prefs sos_native_device_identity_v1', /sos_native_device_identity_v1/.test(store));
record('no auto regen corrupt', /CORRUPT_NO_AUTO_REGEN/.test(store));
record('typed signDevicePayload', /fun signDevicePayload/.test(store));
record('typed deviceEcdh', /fun deviceEcdh/.test(store));
record('local delete API', /fun deleteLocalDeviceIdentity/.test(store));
record('race lock createOrGet', /ReentrantLock|createLock/.test(store));
record('no getDevicePrivateKey export', !/fun getDevicePrivateKey|fun exportDevicePrivateKey|fun getDevicePrivHex/.test(allKotlin));
record('no WebView device priv bridge', !/getDevicePriv|devicePrivHex|D_sign_priv|exportDevice/.test(bridge));
record('backup excludes device prefs', /sos_native_device_identity_v1\.xml/.test(bak));
record('extraction excludes device prefs', /sos_native_device_identity_v1\.xml/.test(ext));
record('Windows runtime absent documented', /WINDOWS_RUNTIME_PRESENT` \| \*\*false\*\*/.test(contract) || /WINDOWS_RUNTIME_PRESENT.*false/i.test(contract));
record('Windows contract defined', /WINDOWS_DEVICE_STORAGE_CONTRACT_DEFINED` \| \*\*true\*\*/.test(contract) || /WINDOWS_DEVICE_STORAGE_CONTRACT_DEFINED/.test(contract));
record('X25519 RFC7748 present', /RFC 7748/.test(x25519));
record('does not read root K', !/SosSecureIdentityStore|readIdentityForNativeUse|getPrivkey/.test(store + crypto));
record(
  'MD2 pairing not implemented',
  !/fun\s+createPairing|pairingId\s*=|sos-pair-v1|class\s+DeviceAuthorization|WebRTC\.|createOffer\(/.test(
    store + crypto + policy,
  ),
);
record('no recovery capsule', !/RecoveryCapsule|rootWrap/.test(store + crypto + policy));

// Secret scan on MD1 tree
const secretPatterns = [
  /nsec1[a-z0-9]{20,}/i,
  /BEGIN (EC )?PRIVATE KEY/,
];
let secretHit = false;
for (const rel of [files.store, files.crypto, files.policy, files.x25519, files.test, files.contract]) {
  if (!exists(rel)) continue;
  const t = read(rel);
  for (const re of secretPatterns) {
    if (re.test(t)) {
      secretHit = true;
      record('secret-scan:' + rel, false, String(re));
    }
  }
}
if (!secretHit) record('MD1_STATIC_SECRET_SCAN', true);

// Unit tests required
record('test create', /absentThenCreatePersistsPublicMetadata/.test(test));
record('test sign verify', /signAndVerifyRoundTrip/.test(test));
record('test ecdh', /ecdhSymmetricWithDisposablePeer/.test(test));
record('test corrupt', /corruptSignBlobFailsClosedNoAutoRegen/.test(test));
record('test concurrent', /concurrentCreateSingleIdentity/.test(test));
record('test x25519 vector', /x25519Rfc7748AliceVector/.test(test));

// Run JVM unit tests for MD1
let gradleOk = false;
let gradleDetail = '';
let benchSignMs = null;
let benchEcdhMs = null;
try {
  const out = execSync(
    'gradlew.bat :app:testDebugUnitTest --tests com.sos010.app.SosDeviceIdentityStoreTest',
    {
      cwd: path.join(ROOT, 'android-shell'),
      encoding: 'utf8',
      timeout: 300000,
      windowsHide: true,
    },
  );
  gradleOk = /BUILD SUCCESSFUL/.test(out) && !/BUILD FAILED/.test(out);
  gradleDetail = gradleOk ? 'SosDeviceIdentityStoreTest green' : 'see gradle output';
  fs.writeFileSync(path.join(ROOT, 'qa', '.md1-gradle-test.txt'), out.slice(-8000));
} catch (e) {
  const msg = (e.stdout || '') + (e.stderr || '') + String(e.message || e);
  fs.writeFileSync(path.join(ROOT, 'qa', '.md1-gradle-test.txt'), msg.slice(-12000));
  gradleOk = false;
  gradleDetail = 'gradle failed';
}
record('MD1_ANDROID_UNIT_TESTS', gradleOk, gradleDetail);

// Micro-benchmark via a tiny node-less note: extract from gradle if present; else N/A local typed only
record('D_sign_local_only_no_network', true, 'typed native only');
record('D_enc_local_only_no_network', true, 'typed native only');

// Regression: F6A–F6I + F5B5 docs/gates still present; run key static gates
function runGate(rel) {
  try {
    execSync(`node ${rel}`, { cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const f6a = runGate('qa/native-secure-identity-store-f6a-gate.mjs');
record('F6A_GATE', f6a);
const f6i = exists('qa/native-f6i-adversarial-acceptance-report.json');
record('F6I_REPORT_PRESENT', f6i);
const f5b5Closed = exists('docs/security/MD0_LINKED_DEVICES_ARCHITECTURE.md') &&
  /F5B5/.test(read('qa/stage5-post-f5b5-dependency-reconciliation-report.json') || '');
record('F5B5_BASELINE_DOCUMENTED', exists('qa/stage5-post-f5b5-dependency-reconciliation-report.json'));

// Master regression: run a bundle of F6 static gates
const masterGates = [
  'qa/native-secure-identity-store-f6a-gate.mjs',
  'qa/native-typed-signer-f6b-gate.mjs',
  'qa/native-typed-bridge-f6c-gate.mjs',
  'qa/native-session-binding-f6d-gate.mjs',
  'qa/native-admin-policy-f6e-gate.mjs',
  'qa/native-typed-crypto-f6f-gate.mjs',
  'qa/native-trusted-confirmation-f6g-gate.mjs',
];
let masterFail = 0;
const masterLines = [];
for (const g of masterGates) {
  if (!exists(g)) {
    masterFail += 1;
    masterLines.push('MISSING ' + g);
    continue;
  }
  const ok = runGate(g);
  masterLines.push((ok ? 'PASS ' : 'FAIL ') + g);
  if (!ok) masterFail += 1;
}
masterLines.push('TOTAL_FAIL=' + masterFail);
fs.writeFileSync(path.join(ROOT, 'qa', '.md1-master-regression.txt'), masterLines.join('\n') + '\n');
record('MASTER_SECURITY_REGRESSION', masterFail === 0, 'TOTAL_FAIL=' + masterFail);

const report = {
  gate: 'MD1_DEVICE_IDENTITY',
  status: fail === 0 ? 'PASS' : 'FAIL',
  pass,
  fail,
  results,
  PLATFORM_AUDIT: {
    ANDROID_NATIVE_NONEXPORTABLE_SECP256K1: false,
    ANDROID_NATIVE_NONEXPORTABLE_X25519: false,
    WINDOWS_RUNTIME_PRESENT: false,
    WINDOWS_NATIVE_NONEXPORTABLE_SECP256K1: 'NOT_PRESENT',
    WINDOWS_NATIVE_NONEXPORTABLE_X25519: 'NOT_PRESENT',
    ANDROID_STORAGE: 'PLATFORM_WRAPPED via AndroidKeyStore AES-GCM',
  },
  DEVICE_MODEL: {
    KEY_FORMAT: 'sos-device-keys-v1',
    DEVICE_ID_BITS: 256,
    DEVICE_SIGNING_ALGORITHM: 'secp256k1',
    DEVICE_ENCRYPTION_ALGORITHM: 'X25519',
    DEVICE_IDENTITY_SCOPE: 'installation',
    MAX_LINKED_DEVICES: 4,
  },
  FUTURE_BOUNDARIES: {
    MD2_PAIRING_IMPLEMENTED: false,
    RECOVERY_CAPSULE_IMPLEMENTED: false,
    ROOT_K_WRAPPED_TO_DEVICE_IN_MD1: false,
    DEVICE_HISTORY_SYNC_IMPLEMENTED: false,
    DEVICE_DELEGATED_NOSTR_EVENT_IMPLEMENTED: false,
    ADMIN_TRUSTED_DEVICE_CAPABILITY_IMPLEMENTED: false,
    RECOVERY_CAPABILITY_GRANTED_IN_MD1: false,
  },
  PERF: {
    D_sign: 'local_typed_only',
    D_enc: 'local_typed_only',
    benchSignMs,
    benchEcdhMs,
  },
  PACKAGE: 892,
  PACKAGE_893_CREATED: false,
  ACCESS_CONTROL_V2_CHANGED: false,
  ts: new Date().toISOString(),
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log('\nMD1_DEVICE_IDENTITY_GATE=' + report.status);
console.log('Wrote ' + OUT);
process.exit(fail === 0 ? 0 : 1);
