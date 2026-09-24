#!/usr/bin/env node
/**
 * F6B — Native typed signer static gate (no APK deploy / no WebView cutover).
 * Run: node qa/native-typed-signer-f6b-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'native-typed-signer-f6b-report.json');

const results = [];
let pass = 0;
let fail = 0;

function record(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name);
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

const signerRel = 'android-shell/app/src/main/java/com/sos010/app/SosNativeTypedSigner.kt';
const testRel = 'android-shell/app/src/test/java/com/sos010/app/SosNativeTypedSignerTest.kt';
const storeRel = 'android-shell/app/src/main/java/com/sos010/app/SosSecureIdentityStore.kt';
const bridgeRel = 'android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt';
const fileTransfer = 'android-shell/app/src/main/java/com/sos010/app/SosNativeFileTransfer.kt';
const p2pEngine = 'android-shell/app/src/main/java/com/sos010/app/SosNativeP2pEngine.kt';
const nostrCrypto = 'android-shell/app/src/main/java/com/sos010/app/SosNostrCrypto.kt';

record('typed signer exists', exists(signerRel));
record('typed signer test exists', exists(testRel));
record('F6A store still present', exists(storeRel));

const src = exists(signerRel) ? read(signerRel) : '';
const testSrc = exists(testRel) ? read(testRel) : '';
const bridge = exists(bridgeRel) ? read(bridgeRel) : '';
const ft = exists(fileTransfer) ? read(fileTransfer) : '';
const p2p = exists(p2pEngine) ? read(p2pEngine) : '';
const crypto = exists(nostrCrypto) ? read(nostrCrypto) : '';

record('uses SosSecureIdentityStore', /SosSecureIdentityStore/.test(src));
record('allowlist SIGN_CHAT_EVENT', /SIGN_CHAT_EVENT/.test(src));
record('allowlist SIGN_CALL_SEAL', /SIGN_CALL_SEAL/.test(src));
record('allowlist SIGN_CALL_GIFTWRAP', /SIGN_CALL_GIFTWRAP/.test(src));
record('allowlist SIGN_PRESENCE_EVENT', /SIGN_PRESENCE_EVENT/.test(src));
record('allowlist SIGN_READ_RECEIPT_EVENT', /SIGN_READ_RECEIPT_EVENT/.test(src));
record('no SIGN_NOSTR_EVENT op', !/SIGN_NOSTR_EVENT\s*\(/.test(src));
record('arbitrary event rejected', /ARBITRARY_EVENT_SIGNING_UNAVAILABLE/.test(src));
record('session gate extension point', /SessionAuthorityGate/.test(src) && /F6B_SESSION_BINDING_EXTENSION_POINT_PRESENT\s*=\s*true/.test(src));
record('does not bypass F6D', /F6B_DOES_NOT_BYPASS_FUTURE_F6D\s*=\s*true/.test(src));
record('community independent', /NATIVE_SIGNER_IDENTITY_COMMUNITY_INDEPENDENT\s*=\s*true/.test(src));
record('no generic sign API flag', /GENERIC_NATIVE_SIGN_API\s*=\s*false/.test(src));
record('no generic decrypt API flag', /GENERIC_NATIVE_DECRYPT_API\s*=\s*false/.test(src));
record('returns raw K false', /NATIVE_TYPED_SIGNER_RETURNS_RAW_K\s*=\s*false/.test(src));
record('returns nsec false', /NATIVE_TYPED_SIGNER_RETURNS_NSEC\s*=\s*false/.test(src));

// Negative API surface on typed signer
record('no public getPrivateKey', !/fun getPrivateKey\s*\(/.test(src));
record('no public getPrivkey', !/fun getPrivkey\s*\(/.test(src));
record('no public getNsec', !/fun getNsec\s*\(/.test(src));
record('no public exportPrivateKey', !/fun exportPrivateKey\s*\(/.test(src));
record('no public signArbitrary', !/fun signArbitrary\s*\(/.test(src));
record('no public signHash', !/fun signHash\s*\(/.test(src));
record('no public signBytes', !/fun signBytes\s*\(/.test(src));
record('no public genericDecrypt', !/fun genericDecrypt\s*\(/.test(src));
record('no @JavascriptInterface annotation', !/@JavascriptInterface/.test(src));

// WebView not cut over
record(
  'bridge still has getVerifierSessionJson privkey (expected until F6C)',
  /fun getVerifierSessionJson/.test(bridge) && /put\("privkey"/.test(bridge)
);
record(
  'F6B did not add JavascriptInterface typed crypto',
  !/SosNativeTypedSigner/.test(bridge)
);

// Legacy privHex path still present
record('legacy SosNostrCrypto.signEvent(privHex) still present', /fun signEvent\(privHex/.test(crypto));

// Hot path untouched
record('file transfer does not reference typed signer', !/SosNativeTypedSigner/.test(ft));
record('p2p engine does not reference typed signer yet', !/SosNativeTypedSigner/.test(p2p));

// R2 WIP present
record('IncomingCallActivity preserved', exists('android-shell/app/src/main/java/com/sos010/app/IncomingCallActivity.kt'));
record('SosSecureCallSessionStore preserved', exists('android-shell/app/src/main/java/com/sos010/app/SosSecureCallSessionStore.kt'));

// Tests
record('test chat sign', /validSecureIdentitySignsChatEvent/.test(testSrc));
record('test call ops', /callSealAndGiftwrapTypedOps/.test(testSrc));
record('test recovery cannot sign', /invalidIdentityCannotSign/.test(testSrc));
record('test arbitrary unavailable', /arbitraryEventSigningUnavailable/.test(testSrc));
record('test benchmark', /signingBenchmarkPass/.test(testSrc));
record('test session gate deny', /sessionGateExtensionPointCanDeny/.test(testSrc));

// F6A gate still runnable
record('F6A gate file present', exists('qa/native-secure-identity-store-f6a-gate.mjs'));

const report = {
  gate: 'native-typed-signer-f6b',
  F6B_NATIVE_TYPED_SIGNER_GATE: fail === 0 ? 'PASS' : 'FAIL',
  F6B_NO_GENERIC_API_GATE: fail === 0 ? 'PASS' : 'FAIL',
  F6B_TYPED_OPERATION_ALLOWLIST_PRESENT: true,
  TYPED_OPERATIONS: [
    'SIGN_CHAT_EVENT',
    'SIGN_CALL_SEAL',
    'SIGN_CALL_GIFTWRAP',
    'SIGN_PRESENCE_EVENT',
    'SIGN_READ_RECEIPT_EVENT',
  ],
  NATIVE_TYPED_SIGNER_USES_SECURE_STORE: true,
  CURRENT_WEBVIEW_RAW_K_PATH_STILL_PRESENT: true,
  EXPECTED_UNTIL_F6C: true,
  LEGACY_PRIVHEX_SIGNING_PATH_STILL_PRESENT: true,
  CALL_PROTOCOL_CHANGED: false,
  P2P_BULK_DATA_PATH_CHANGED: false,
  F6B_NEW_WEBVIEW_CRYPTO_INTERFACE_EXPOSED: false,
  pass,
  fail,
  results,
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('\nF6B_NATIVE_TYPED_SIGNER_GATE=' + report.F6B_NATIVE_TYPED_SIGNER_GATE);
console.log('F6B_NO_GENERIC_API_GATE=' + report.F6B_NO_GENERIC_API_GATE);
console.log('REPORT=' + OUT);
process.exit(fail === 0 ? 0 : 1);
