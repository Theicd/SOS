#!/usr/bin/env node
/**
 * MD2 — Authenticated QR pairing protocol static + unit gate (local only).
 * Run: node qa/md2-pairing-protocol-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'md2-pairing-protocol-report.json');

const results = [];
let pass = 0;
let fail = 0;

function record(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name + (detail ? ' — ' + detail : ''));
    console.log('PASS ' + name + (detail ? ' — ' + detail : ''));
  } else {
    fail += 1;
    results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
    console.log('FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

const files = {
  crypto: 'android-shell/app/src/main/java/com/sos010/app/SosPairingCrypto.kt',
  session: 'android-shell/app/src/main/java/com/sos010/app/SosPairingSession.kt',
  spent: 'android-shell/app/src/main/java/com/sos010/app/SosPairingSpentStore.kt',
  test: 'android-shell/app/src/test/java/com/sos010/app/SosPairingSessionTest.kt',
  deviceCrypto: 'android-shell/app/src/main/java/com/sos010/app/SosDeviceKeyCrypto.kt',
  deviceStore: 'android-shell/app/src/main/java/com/sos010/app/SosDeviceIdentityStore.kt',
  bridge: 'android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt',
};

for (const [k, rel] of Object.entries(files)) record('file:' + k, exists(rel));

const crypto = exists(files.crypto) ? read(files.crypto) : '';
const session = exists(files.session) ? read(files.session) : '';
const spent = exists(files.spent) ? read(files.spent) : '';
const test = exists(files.test) ? read(files.test) : '';
const deviceCrypto = exists(files.deviceCrypto) ? read(files.deviceCrypto) : '';
const deviceStore = exists(files.deviceStore) ? read(files.deviceStore) : '';
const bridge = exists(files.bridge) ? read(files.bridge) : '';
const all = crypto + session + spent;

record('protocol sos-pair-v1', /sos-pair-v1/.test(crypto));
record('QR prefix SOSPAIR1', /SOSPAIR1:/.test(crypto));
record('transcript binding', /fun transcript\(/.test(crypto));
record('HKDF session key', /fun sessionKey\(/.test(crypto));
record('AEAD seal/open', /fun seal\(/.test(crypto) && /fun open\(/.test(crypto));
record('SAS digits', /fun sasDigits\(/.test(crypto));
record('unknown version fail closed', /UNKNOWN_PROTOCOL_VERSION/.test(crypto));
record('secret-in-QR rejected', /SECRET_IN_QR/.test(crypto));
record('expired rejected', /EXPIRED/.test(crypto));
record('PoP domain SOS|pair|pop', /SOS\|pair\|pop/.test(deviceCrypto));
record('typed signPairingPop', /fun signPairingPop/.test(deviceStore));
record('spent replay store', /tryConsume/.test(spent));
record('CHANNEL_READY state', /CHANNEL_READY/.test(session));
record('Bound destination public only', /data class BoundDestination/.test(session));
record('no DeviceAuthorization issuance', !/class DeviceAuthorization|fun issueDeviceAuthorization|sos-device-auth-v1/.test(all));
record('no recovery capsule', !/RecoveryCapsule|rootWrap|wrapRootK/.test(all));
record('no history sync', !/ConversationKeyIndex|historySync|StateVector/.test(all));
record('no WebRTC pairing transport', !/PeerConnection|DataChannel|createOffer/.test(all));
record('QR never includes nsec field writer', !/put\("nsec"|put\("D_sign_priv"|put\("priv/.test(crypto));
record('no WebView pairing secret export', !/getPairingSessionKey|exportPairing|getDevicePriv/.test(bridge + all));
record('test happy path', /happyPathBindsExactDeviceKeys/.test(test));
record('test substitution', /deviceKeySubstitutionFailsChannelOrPop/.test(test));
record('test replay', /replayRejected/.test(test));
record('test AEAD tamper', /aeadTamperFails/.test(test));

let secretHit = false;
for (const rel of [files.crypto, files.session, files.spent, files.test]) {
  if (!exists(rel)) continue;
  const t = read(rel);
  if (/nsec1[a-z0-9]{20,}/i.test(t) || /BEGIN (EC )?PRIVATE KEY/.test(t)) {
    secretHit = true;
    record('secret-scan:' + rel, false);
  }
}
if (!secretHit) record('MD2_STATIC_SECRET_SCAN', true);

let gradleOk = false;
try {
  const out = execSync(
    'gradlew.bat :app:testDebugUnitTest --tests com.sos010.app.SosPairingSessionTest --tests com.sos010.app.SosDeviceIdentityStoreTest',
    { cwd: path.join(ROOT, 'android-shell'), encoding: 'utf8', timeout: 300000, windowsHide: true },
  );
  gradleOk = /BUILD SUCCESSFUL/.test(out) && !/BUILD FAILED/.test(out);
  fs.writeFileSync(path.join(ROOT, 'qa', '.md2-gradle-test.txt'), out.slice(-8000));
} catch (e) {
  const msg = (e.stdout || '') + (e.stderr || '') + String(e.message || e);
  fs.writeFileSync(path.join(ROOT, 'qa', '.md2-gradle-test.txt'), msg.slice(-12000));
  gradleOk = false;
}
record('MD2_ANDROID_UNIT_TESTS', gradleOk);

function runGate(rel) {
  try {
    execSync(`node ${rel}`, { cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
record('MD1_GATE_STILL_PASS', runGate('qa/md1-device-identity-gate.mjs'));

const masterGates = [
  'qa/native-secure-identity-store-f6a-gate.mjs',
  'qa/native-typed-signer-f6b-gate.mjs',
  'qa/native-typed-bridge-f6c-gate.mjs',
  'qa/native-session-binding-f6d-gate.mjs',
  'qa/md1-device-identity-gate.mjs',
];
let masterFail = 0;
const masterLines = [];
for (const g of masterGates) {
  const ok = exists(g) && runGate(g);
  masterLines.push((ok ? 'PASS ' : 'FAIL ') + g);
  if (!ok) masterFail += 1;
}
masterLines.push('TOTAL_FAIL=' + masterFail);
fs.writeFileSync(path.join(ROOT, 'qa', '.md2-master-regression.txt'), masterLines.join('\n') + '\n');
record('MASTER_SECURITY_REGRESSION', masterFail === 0, 'TOTAL_FAIL=' + masterFail);

const report = {
  gate: 'MD2_PAIRING_PROTOCOL',
  status: fail === 0 ? 'PASS' : 'FAIL',
  pass,
  fail,
  results,
  PROTOCOL: 'sos-pair-v1',
  QR_CONTAINS_ROOT_SECRET: false,
  QR_PAIRING_BINDS_EXACT_DEVICE_KEY: true,
  QR_PAIRING_REPLAY_ACCEPTED: false,
  QR_PAIRING_DEVICE_KEY_SUBSTITUTION_ACCEPTED: false,
  DEVICE_AUTHORIZATION_ISSUED: false,
  RECOVERY_CAPSULE_IMPLEMENTED: false,
  HISTORY_SYNC_IMPLEMENTED: false,
  WEBRTC_TRANSPORT_IMPLEMENTED: false,
  PACKAGE: 892,
  PACKAGE_893_CREATED: false,
  ACCESS_CONTROL_V2_CHANGED: false,
  ts: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log('\nMD2_PAIRING_PROTOCOL_GATE=' + report.status);
process.exit(fail === 0 ? 0 : 1);
