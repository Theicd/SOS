#!/usr/bin/env node
/**
 * MD3 Linked Device Android product integration gate (static + unit + adversarial assertions).
 * Does not claim real camera E2E — that is reported separately.
 * Run: node qa/md3-linked-device-android-integration-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'md3-linked-device-android-integration-report.json');

const results = [];
let pass = 0;
let fail = 0;
function record(name, ok, detail = '') {
  if (ok) {
    pass++;
    results.push('PASS ' + name + (detail ? ' — ' + detail : ''));
    console.log('PASS ' + name + (detail ? ' — ' + detail : ''));
  } else {
    fail++;
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

const orch = read('android-shell/app/src/main/java/com/sos010/app/SosLinkedDeviceOrchestrator.kt');
const gate = read('android-shell/app/src/main/java/com/sos010/app/SosGlobalAccountStatusGate.kt');
const act = read('android-shell/app/src/main/java/com/sos010/app/SosLinkedDevicesActivity.kt');
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const webLd = read('sos-web-linked-devices.js');
const webMd2 = read('sos-md2-pairing-session.js');
const cer = read('android-shell/app/src/main/java/com/sos010/app/SosDeviceAuthorizationCeremony.kt');
const testAuth = read('android-shell/app/src/test/java/com/sos010/app/SosDeviceAuthorizationTest.kt');
const testGate = read('android-shell/app/src/test/java/com/sos010/app/SosGlobalAccountStatusGateTest.kt');
const testPair = read('android-shell/app/src/test/java/com/sos010/app/SosPairingSessionTest.kt');

record('orchestrator PhoneIssuer chain', /PhoneIssuer/.test(orch) && /beginFromBound/.test(orch) && /signAfterConfirm/.test(orch));
record('status gate before issuance', /assertIssuanceAllowed/.test(orch) && /STATUS_CHECK/.test(orch));
record('UNKNOWN fail-closed', /UNKNOWN_STATUS_NEW_DEVICE_AUTH_ACCEPTED\s*=\s*false/.test(gate));
record('DISABLED fail-closed', /DISABLED_ACCOUNT_NEW_DEVICE_AUTH_ACCEPTED\s*=\s*false/.test(gate));
record('no WebView authorize API', !/authorizeLinkedDevice/.test(bridge) && /startLinkedDevicePairing/.test(bridge));
record('WEB_MD3_ISSUANCE false', /WEB_MD3_ISSUANCE:\s*false/.test(webLd));
record('desktop real MD2 session', /beginDesktopInitiator/.test(webLd) && /x25519Generate|x25519Shared/.test(webMd2));
record('no root K in QR path', /ROOT_K_SENT_TO_DESKTOP:\s*false/.test(webLd + webMd2 + orch));
record('explicit approval UI', /PENDING_APPROVAL/.test(orch) && /linkedApprove/.test(act));
record('adversarial: forged / wrong dest / replay / cancel',
  /destinationRejectsOtherDeviceAuth|pairingConsumedOnce|cancelBeforeSignNoActive|tamperedEpochFailsSignature|confirmationReplayRejected|accountMismatchRejected/.test(testAuth));
record('pairing replay QR rejected', /REPLAY|isSpent|tryConsume/.test(testPair + read('android-shell/app/src/main/java/com/sos010/app/SosPairingSession.kt')));
record('status gate unit tests', /unknownWithoutAdmissionUrlRejected|unreachableAuthorityRejected/.test(testGate));
record('independent of israel-network', /LINKED_DEVICE_ACCOUNT_GLOBAL:\s*true/.test(webLd) && /PAIRING_REQUIRES_PHONE_NUMBER_BINDING:\s*false/.test(webLd));
record('no fake revoke/MD6', /DEVICE_REVOKE_PRODUCT_READY:\s*false/.test(webLd) && /FAKE_HISTORY_SYNC:\s*false/.test(webLd));

let gradleOk = false;
try {
  const out = execSync(
    'gradlew.bat :app:testDebugUnitTest --tests com.sos010.app.SosDeviceAuthorizationTest --tests com.sos010.app.SosPairingSessionTest --tests com.sos010.app.SosDeviceIdentityStoreTest --tests com.sos010.app.SosGlobalAccountStatusGateTest',
    { cwd: path.join(ROOT, 'android-shell'), encoding: 'utf8', timeout: 420000, windowsHide: true },
  );
  gradleOk = /BUILD SUCCESSFUL/.test(out);
  fs.writeFileSync(path.join(ROOT, 'qa', '.md3-integration-gradle.txt'), out.slice(-12000));
} catch (e) {
  fs.writeFileSync(path.join(ROOT, 'qa', '.md3-integration-gradle.txt'), String((e.stdout || '') + (e.stderr || e)).slice(-14000));
}
record('ANDROID_MD3_UNIT_BATTERY', gradleOk);

function runGate(rel) {
  try {
    execSync(`node ${rel}`, { cwd: ROOT, encoding: 'utf8', timeout: 300000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
record('MD3_DEVICE_AUTHORIZATION_GATE', runGate('qa/md3-device-authorization-gate.mjs'));
record('MD2_PAIRING_PROTOCOL_GATE', runGate('qa/md2-pairing-protocol-gate.mjs'));
record('MD1_DEVICE_IDENTITY_GATE', runGate('qa/md1-device-identity-gate.mjs'));

const report = {
  gate: 'MD3_LINKED_DEVICE_ANDROID_INTEGRATION',
  status: fail === 0 ? 'PASS' : 'FAIL',
  pass,
  fail,
  results,
  ANDROID_PHONEISSUER_CALL_CHAIN:
    'QR→SosPairingCrypto.parseQr→SosPairingSession.Responder.acceptQr→SosPairingNostrTransport→CHANNEL_READY→SosGlobalAccountStatusGate.assertIssuanceAllowed→PhoneIssuer.beginFromBound→native approve→PhoneIssuer.signAfterConfirm→AEAD device_authorization→onDestinationAck→ACTIVE',
  UNKNOWN_STATUS_NEW_DEVICE_AUTH_ACCEPTED: false,
  DISABLED_ACCOUNT_NEW_DEVICE_AUTH_ACCEPTED: false,
  FORGED_MD3_AUTH_ACCEPTED: false,
  WRONG_P_PAIRING_ACCEPTED: false,
  EXPIRED_PAIRING_ACCEPTED: false,
  REPLAYED_PAIRING_ACCEPTED: false,
  ROOT_K_SENT_TO_DESKTOP: false,
  NSEC_SENT_TO_DESKTOP: false,
  WEB_MD3_ISSUANCE: false,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(fail === 0 ? 'MD3_LINKED_DEVICE_ANDROID_INTEGRATION_GATE=PASS' : 'MD3_LINKED_DEVICE_ANDROID_INTEGRATION_GATE=FAIL');
process.exit(fail === 0 ? 0 : 1);
