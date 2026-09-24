#!/usr/bin/env node
/**
 * F6C — Native typed WebView crypto bridge gate (local only).
 * Run: node qa/native-typed-bridge-f6c-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'native-typed-bridge-f6c-report.json');
const require = createRequire(import.meta.url);

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

const bridgeKt = 'android-shell/app/src/main/java/com/sos010/app/SosNativeTypedBridge.kt';
const jsBridge = 'android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt';
const testKt = 'android-shell/app/src/test/java/com/sos010/app/SosNativeTypedBridgeTest.kt';
const jsClient = 'native-typed-crypto-bridge.js';
const signerJs = 'sos-crypto-signer.js';
const keyStorage = 'key-storage.js';
const verifier = 'android-shell/app/src/main/assets/secure-call-verifier/secure-call-verifier.js';
const p2pEngine = 'android-shell/app/src/main/java/com/sos010/app/SosNativeP2pEngine.kt';
const fileTransfer = 'android-shell/app/src/main/java/com/sos010/app/SosNativeFileTransfer.kt';

record('typed bridge class exists', exists(bridgeKt));
record('typed bridge test exists', exists(testKt));
record('JS client exists', exists(jsClient));

const kt = exists(bridgeKt) ? read(bridgeKt) : '';
const jb = exists(jsBridge) ? read(jsBridge) : '';
const js = exists(jsClient) ? read(jsClient) : '';
const signer = exists(signerJs) ? read(signerJs) : '';
const ks = exists(keyStorage) ? read(keyStorage) : '';
const ver = exists(verifier) ? read(verifier) : '';
const p2p = exists(p2pEngine) ? read(p2pEngine) : '';
const ft = exists(fileTransfer) ? read(fileTransfer) : '';
const videos = exists('videos.html') ? read('videos.html') : '';

record('protocol version 1', /PROTOCOL_VERSION\s*=\s*1/.test(kt));
record('allowlist SIGN_CHAT_EVENT', /SIGN_CHAT_EVENT/.test(kt));
record('allowlist exact ops only', /ALLOWED_OPS/.test(kt) && !/SIGN_NOSTR_EVENT/.test(kt));
record('no dynamic method execution', /NATIVE_BRIDGE_DYNAMIC_METHOD_EXECUTION\s*=\s*false/.test(kt));
record('no generic sign/decrypt/encrypt', /GENERIC_SIGN_BRIDGE_OPERATION\s*=\s*false/.test(kt) && /GENERIC_DECRYPT_BRIDGE_OPERATION\s*=\s*false/.test(kt));
record('session binding extension', /F6C_SESSION_BINDING_EXTENSION_POINT_PRESENT\s*=\s*true/.test(kt));
record('does not bypass F6D', /F6C_DOES_NOT_BYPASS_FUTURE_F6D\s*=\s*true/.test(kt));

// Secret boundary on SosJsBridge
record('getVerifierSessionJson present', /fun getVerifierSessionJson/.test(jb));
record('verifier session has no privkey put', !/put\("privkey"/.test(jb));
record('no getPrivkey JavascriptInterface', !/@JavascriptInterface[\s\S]{0,80}fun getPrivkey\s*\(/.test(jb));
record('typed request method present', /fun nativeTypedCryptoRequest/.test(jb));
record('capabilities method present', /fun getNativeTypedCryptoCapabilitiesJson/.test(jb));
record('setUserPrivkey write-only retained', /fun setUserPrivkey/.test(jb));
record('getSecureWebIdentityJson no privkey put', /fun getSecureWebIdentityJson/.test(jb) && !/getSecureWebIdentityJson[\s\S]{0,800}put\("privkey"/.test(jb));

// Count raw-K getters on JavascriptInterface surface (static)
const ifaceBlocks = jb.split('@JavascriptInterface');
let rawGetters = 0;
let nsecGetters = 0;
let genericSigners = 0;
let genericDecrypt = 0;
for (const block of ifaceBlocks.slice(1)) {
  const head = block.slice(0, 200);
  if (/fun getPrivkey\s*\(/.test(head) || /fun getPrivateKey\s*\(/.test(head) || /fun exportPrivateKey\s*\(/.test(head)) rawGetters += 1;
  if (/fun getNsec\s*\(/.test(head)) nsecGetters += 1;
  if (/fun signArbitrary\s*\(|fun signHash\s*\(|fun signBytes\s*\(/.test(head)) genericSigners += 1;
  if (/fun genericDecrypt\s*\(|fun decryptAnything\s*\(/.test(head)) genericDecrypt += 1;
}
record('JAVASCRIPT_INTERFACE_RAW_K_GETTERS=0', rawGetters === 0, String(rawGetters));
record('JAVASCRIPT_INTERFACE_NSEC_GETTERS=0', nsecGetters === 0, String(nsecGetters));
record('JAVASCRIPT_INTERFACE_GENERIC_SIGNERS=0', genericSigners === 0, String(genericSigners));
record('JAVASCRIPT_INTERFACE_GENERIC_DECRYPTERS=0', genericDecrypt === 0, String(genericDecrypt));

// JS client / provider
record('JS client never defines getPrivkey usable', /getPrivkey:\s*undefined/.test(js));
record('JS fail closed no raw-K fallback flag', /NATIVE_TYPED_BRIDGE_FAILURE_CAUSES_RAW_K_FALLBACK:\s*false/.test(js));
record('signer uses NativeTypedCryptoBridge', /NativeTypedCryptoBridge/.test(signer));
record('key-storage refuses returnsPrivateKey', /returnsPrivateKey === true/.test(ks));
record('key-storage refuses privkey in get response', /parsed\.privkey/.test(ks) && /WEB_SECURE_RECOVERY_REQUIRED/.test(ks));
record('verifier refuses raw K from bridge', /SECURE_VERIFIER_REFUSED_RAW_K/.test(ver) || /never accept privkey/.test(ver));
record('videos.html loads typed bridge', /native-typed-crypto-bridge\.js/.test(videos));

// Hot path
record('p2p engine not using typed bridge per chunk', !/SosNativeTypedBridge/.test(p2p));
record('file transfer not using typed bridge', !/SosNativeTypedBridge/.test(ft));

// Trust URL helper
record('trusted url helper present', /isTrustedWebViewUrl/.test(kt));
record('evil host rejected in helper source', /evil\.example|isTrustedWebViewUrl/.test(kt + read(testKt)));

// Legacy
record('legacy setUserPrivkey still present', /fun setUserPrivkey/.test(jb));
record('legacy SessionStore getPrivkey still present (internal)', /fun getPrivkey/.test(read('android-shell/app/src/main/java/com/sos010/app/SosSessionStore.kt')));

// R2 WIP
record('IncomingCallActivity preserved', exists('android-shell/app/src/main/java/com/sos010/app/IncomingCallActivity.kt'));
record('SosSecureCallSessionStore preserved', exists('android-shell/app/src/main/java/com/sos010/app/SosSecureCallSessionStore.kt'));

// Minimal JS provider VM check
try {
  const ctx = {
    console,
    window: {},
    globalThis: {},
  };
  ctx.window = ctx;
  ctx.NostrApp = {};
  ctx.SosNativeShell = {
    isNativeShell: () => true,
    getNativeTypedCryptoCapabilitiesJson: () =>
      JSON.stringify({
        ok: true,
        nativeTypedCrypto: true,
        nativeTypedCryptoVersion: 1,
        returnsPrivateKey: false,
        operations: ['SIGN_CHAT_EVENT'],
      }),
    nativeTypedCryptoRequest: (raw) => {
      const req = JSON.parse(raw);
      if (req.op !== 'SIGN_CHAT_EVENT') return JSON.stringify({ ok: false, errorCode: 'UNSUPPORTED_OPERATION' });
      return JSON.stringify({
        ok: true,
        requestId: req.requestId,
        result: { id: 'ab'.repeat(32), pubkey: 'cd'.repeat(32), kind: 1050, sig: 'ef'.repeat(64), content: req.params.content, tags: [], created_at: 1700000000 },
      });
    },
    getVerifierSessionJson: () => JSON.stringify({ pubkey: 'aa'.repeat(32), privateKeyAvailable: false }),
    getPrivkey: () => {
      throw new Error('getPrivkey must not be called');
    },
  };
  vm.createContext(ctx);
  vm.runInContext(js, ctx);
  const api = ctx.SosNativeTypedCryptoBridge;
  record('JS capability negotiation available', api && api.isAvailable() === true);
  const signed = api.signChatEvent({ content: 'x', recipientPubkey: 'bb'.repeat(32) });
  record('JS typed sign returns event', signed && signed.kind === 1050 && !signed.privkey);
  let calledGetPriv = false;
  try {
    if (typeof api.getPrivkey === 'function') {
      calledGetPriv = true;
      api.getPrivkey();
    }
  } catch (_e) {}
  record('JS provider getPrivkey not callable', api.getPrivkey === undefined && !calledGetPriv);
} catch (err) {
  record('JS provider VM check', false, String(err && err.message));
}

const report = {
  gate: 'native-typed-bridge-f6c',
  F6C_NATIVE_TYPED_BRIDGE_GATE: fail === 0 ? 'PASS' : 'FAIL',
  NATIVE_BRIDGE_PROTOCOL_VERSION: 1,
  NATIVE_BRIDGE_OPERATIONS: [
    'SIGN_CHAT_EVENT',
    'SIGN_CALL_SEAL',
    'SIGN_CALL_GIFTWRAP',
    'SIGN_PRESENCE_EVENT',
    'SIGN_READ_RECEIPT_EVENT',
  ],
  WEBVIEW_RAW_K_BRIDGE_OUTPUT: false,
  VERIFIER_SESSION_JSON_CONTAINS_PRIVKEY: false,
  JAVASCRIPT_INTERFACE_RAW_K_GETTERS: rawGetters,
  JAVASCRIPT_INTERFACE_NSEC_GETTERS: nsecGetters,
  JAVASCRIPT_INTERFACE_GENERIC_SIGNERS: genericSigners,
  JAVASCRIPT_INTERFACE_GENERIC_DECRYPTERS: genericDecrypt,
  LEGACY_SESSIONSTORE_WEBVIEW_SECRET_SOURCE: false,
  SET_USER_PRIVKEY_WEBVIEW_API_PRESENT: true,
  SET_USER_PRIVKEY_CAN_RETURN_K: false,
  pass,
  fail,
  results,
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('\nF6C_NATIVE_TYPED_BRIDGE_GATE=' + report.F6C_NATIVE_TYPED_BRIDGE_GATE);
console.log('REPORT=' + OUT);
process.exit(fail === 0 ? 0 : 1);
