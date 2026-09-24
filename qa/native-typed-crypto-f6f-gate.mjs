#!/usr/bin/env node
/**
 * F6F — Native typed NIP44 / P2P / call crypto static gate.
 * Run: node qa/native-typed-crypto-f6f-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'native-typed-crypto-f6f-report.json');

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

const cryptoKt = 'android-shell/app/src/main/java/com/sos010/app/SosNativeTypedCrypto.kt';
const bridgeKt = 'android-shell/app/src/main/java/com/sos010/app/SosNativeTypedBridge.kt';
const testKt = 'android-shell/app/src/test/java/com/sos010/app/SosNativeTypedCryptoTest.kt';
const jsBridge = 'native-typed-crypto-bridge.js';
const signer = 'sos-crypto-signer.js';
const p2p = 'android-shell/app/src/main/java/com/sos010/app/SosNativeP2pEngine.kt';
const ft = 'android-shell/app/src/main/java/com/sos010/app/SosNativeFileTransfer.kt';
const nip44 = 'android-shell/app/src/main/java/com/sos010/app/SosNip44.kt';
const admin = 'android-shell/app/src/main/java/com/sos010/app/SosNativeAdminTypedSigner.kt';

record('typed crypto class present', exists(cryptoKt));
record('typed crypto test present', exists(testKt));
const c = exists(cryptoKt) ? read(cryptoKt) : '';
const br = exists(bridgeKt) ? read(bridgeKt) : '';
const js = exists(jsBridge) ? read(jsBridge) : '';
const sig = exists(signer) ? read(signer) : '';
const p2pSrc = exists(p2p) ? read(p2p) : '';
const ftSrc = exists(ft) ? read(ft) : '';
const nip = exists(nip44) ? read(nip44) : '';
const adm = exists(admin) ? read(admin) : '';

record('F6F_TYPED_CRYPTO_ALLOWLIST_PRESENT', /F6F_TYPED_CRYPTO_ALLOWLIST_PRESENT\s*=\s*true/.test(c));
record('NIP44 v2', /NIP44_VERSION_USED\s*=\s*"v2"/.test(c) && /nip44-v2/.test(nip));
record('NIP44 protocol unchanged', /NIP44_PROTOCOL_CHANGED\s*=\s*false/.test(c));
record('no generic encrypt', /GENERIC_NATIVE_ENCRYPT_API\s*=\s*false/.test(c));
record('no generic decrypt', /GENERIC_NATIVE_DECRYPT_API\s*=\s*false/.test(c));
record('no generic ECDH', /GENERIC_NATIVE_ECDH_API\s*=\s*false/.test(c));
record('no conversation key API', /GENERIC_CONVERSATION_KEY_API\s*=\s*false/.test(c));
record('caller cannot supply private key', /CALLER_SUPPLIED_PRIVATE_KEY_ACCEPTED\s*=\s*false/.test(c));
record('session required', /ALL_F6F_OPS_REQUIRE_NATIVE_SESSION\s*=\s*true/.test(c));
record('recheck before crypto', /F6F_RECHECKS_SESSION_BEFORE_PRIVATE_CRYPTO\s*=\s*true/.test(c));
record('uses secure identity', /F6F_USES_SECURE_IDENTITY_STORE\s*=\s*true/.test(c));
record('no legacy raw K in typed crypto', /F6F_TYPED_CRYPTO_READS_LEGACY_RAW_K_DIRECTLY\s*=\s*false/.test(c));
record('no raw-K fallback on failure', /F6F_FAILURE_CAUSES_RAW_K_FALLBACK\s*=\s*false/.test(c));
record('provider separation', /PROVIDER_CUSTODY_MODE_EXPLICIT\s*=\s*true/.test(c));
record('native K not copied to browser', /NATIVE_K_COPIED_TO_BROWSER\s*=\s*false/.test(c));
record('browser mode still supported', /BROWSER_CUSTODIED_MODE_STILL_SUPPORTED\s*=\s*true/.test(c));
record('NIP04 still required for P2P signal', /NIP04_RUNTIME_REQUIRED\s*=\s*true/.test(c));
record('RAW_FILE_KEY_OVER_DC false', /RAW_FILE_KEY_OVER_DC\s*=\s*false/.test(c));
record('P2P bulk path unchanged flag', /P2P_BULK_DATA_PATH_CHANGED\s*=\s*false/.test(c));
record('file chunk path unchanged flag', /P2P_FILE_CHUNK_PATH_CHANGED\s*=\s*false/.test(c));
record('typed giftwrap unwrap', /TYPED_CALL_GIFTWRAP_UNWRAP\s*=\s*true/.test(c));
record('no generic giftwrap', /GENERIC_GIFTWRAP_DECRYPT_API\s*=\s*false/.test(c));
record('file key wrap typed', /FILE_KEY_WRAP_TYPED\s*=\s*true/.test(c));

const ops = [
  'CHAT_ENCRYPT', 'CHAT_DECRYPT',
  'P2P_SIGNAL_ENCRYPT', 'P2P_SIGNAL_DECRYPT',
  'CALL_SIGNAL_ENCRYPT', 'CALL_SIGNAL_DECRYPT',
  'CALL_GIFTWRAP_UNWRAP',
  'FILE_KEY_WRAP', 'FILE_KEY_UNWRAP',
];
for (const op of ops) {
  record('allowlist ' + op, new RegExp('\\b' + op + '\\b').test(c) && new RegExp('\\b' + op + '\\b').test(br));
  record('JS bridge ' + op, new RegExp(op).test(js));
}

record('bridge no generic crypto', /F6F_GENERIC_CRYPTO_BRIDGE\s*=\s*false/.test(br));
record('F6C generic sign remains false', /F6C_GENERIC_SIGN_REMAINS_FALSE\s*=\s*true/.test(br) || /GENERIC_SIGN_BRIDGE_OPERATION\s*=\s*false/.test(br));
record('signer native custody without page K', /isNativeCustodyWithoutPageK/.test(sig));
record('signer tryNativeTypedCrypto', /tryNativeTypedCrypto/.test(sig));
record('signer no K fallback', /never fall back to raw K|Native custody: never fall back/.test(sig));

record('p2p uses secure identity prefer', /SosSecureIdentityStore\.readIdentityForNativeUse/.test(p2pSrc));
record('p2p file transfer no typed crypto bridge', !/SosNativeTypedCrypto|SosNativeTypedBridge/.test(ftSrc));
record('p2p chunk path no bridge', !/NATIVE_BRIDGE_USED_PER_FILE_CHUNK|nativeTypedCryptoRequest/.test(ftSrc));

record('F6E admin still blocked before F6G', /HIGH_RISK_ADMIN_OP_CAN_SIGN_BEFORE_F6G\s*=\s*false/.test(adm));

const forbidden = [
  'fun nip44Encrypt(anything',
  'fun getConversationKey(',
  'fun deriveConversationKey(',
  'fun encryptAny(',
  'fun decryptAny(',
  'fun rawECDH(',
  'chatEncrypt(anything',
];
// Public bridge / JS surfaces only (not internal SosNostrCrypto helpers).
const surface = br + js + sig;
let clean = true;
for (const f of [
  'fun getConversationKey(',
  'fun deriveConversationKey(',
  'fun encryptAny(',
  'fun decryptAny(',
  'fun rawECDH(',
  'genericCrypto(',
  'getConversationKey(peer',
]) {
  if (surface.includes(f)) {
    clean = false;
    record('no public ' + f.trim(), false);
  } else {
    record('no public ' + f.trim(), true);
  }
}
record('no generic nip44Encrypt bridge API', !/fun nip44Encrypt\(/.test(br) && !/\.nip44Encrypt\s*=/.test(js));
record('no generic nip44Decrypt bridge API', !/fun nip44Decrypt\(/.test(br) && !/\.nip44Decrypt\s*=/.test(js));
record('no generic crypto bridge surface', clean && !/fun nip44Encrypt\(/.test(br));

// JS VM: native custody encrypt without App.privateKey
try {
  let cap = 'cap1';
  const ctx = { console, window: {}, globalThis: {}, NostrApp: {} };
  ctx.window = ctx;
  ctx.SosNativeShell = {
    isNativeShell: () => true,
    getNativeTypedCryptoCapabilitiesJson: () =>
      JSON.stringify({
        ok: true,
        nativeTypedCrypto: true,
        nativeTypedCryptoVersion: 1,
        returnsPrivateKey: false,
        f6fTypedCrypto: true,
        operations: ops,
      }),
    bindNativeSessionAuthority: () =>
      JSON.stringify({ ok: true, generation: 1, accountPubkey: 'aa'.repeat(32), sessionCapability: cap }),
    revokeNativeSessionAuthority: () => {
      cap = '';
      return JSON.stringify({ ok: true });
    },
    revalidateNativeSessionAuthority: () => JSON.stringify({ ok: true, active: !!cap }),
    nativeTypedCryptoRequest: (raw) => {
      const req = JSON.parse(raw);
      if (!cap || req.sessionCapability !== cap) {
        return JSON.stringify({ ok: false, errorCode: 'SESSION_REVOKED' });
      }
      if (req.op === 'CHAT_ENCRYPT') {
        return JSON.stringify({
          ok: true,
          requestId: req.requestId,
          result: { family: 'sos-e2ee', v: 1, alg: 'nip44', ct: 'ct-' + req.params.plaintext },
        });
      }
      if (req.op === 'FILE_KEY_WRAP') {
        return JSON.stringify({
          ok: true,
          requestId: req.requestId,
          result: { ciphertext: 'wrap-' + req.params.keyMaterial, alg: 'nip44' },
        });
      }
      return JSON.stringify({ ok: false, errorCode: 'UNSUPPORTED_OPERATION' });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(js, ctx);
  const api = ctx.SosNativeTypedCryptoBridge;
  api.bindNativeSession({ generation: 1, accountPubkey: 'aa'.repeat(32) });
  const env = api.chatEncrypt({ plaintext: 'hello', recipientPubkey: 'bb'.repeat(32) });
  record('JS chatEncrypt without page K', env && env.ct === 'ct-hello' && !env.privateKey);
  const wrapped = api.fileKeyWrap({ keyMaterial: 'AESKEY', recipientPubkey: 'bb'.repeat(32) });
  record('JS fileKeyWrap without page K', wrapped && wrapped.ciphertext === 'wrap-AESKEY');
  api.revokeNativeSession('t');
  let revoked = false;
  try {
    api.chatEncrypt({ plaintext: 'x', recipientPubkey: 'bb'.repeat(32) });
  } catch (e) {
    revoked = e && (e.code === 'SESSION_REVOKED' || e.code === 'SESSION_REQUIRED');
  }
  record('JS revoked session cannot encrypt', revoked);
} catch (e) {
  record('JS VM crypto path', false, String(e && e.message));
}

const report = {
  gate: 'F6F_NATIVE_TYPED_CRYPTO',
  status: fail === 0 ? 'PASS' : 'FAIL',
  pass,
  fail,
  results,
  invariants: {
    NIP44_VERSION_USED: 'v2',
    NIP44_PROTOCOL_CHANGED: false,
    NIP04_RUNTIME_REQUIRED: true,
    P2P_BULK_DATA_PATH_CHANGED: false,
    RAW_FILE_KEY_OVER_DC: false,
    HIGH_RISK_ADMIN_OP_CAN_SIGN_BEFORE_F6G: false,
  },
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('\nF6F_NATIVE_TYPED_CRYPTO_GATE=' + report.status);
process.exit(fail === 0 ? 0 : 1);
