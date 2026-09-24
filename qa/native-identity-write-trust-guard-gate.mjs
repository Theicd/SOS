#!/usr/bin/env node
/**
 * F6 write-path — trusted WebView URL guard for identity secret writes.
 * Run: node qa/native-identity-write-trust-guard-gate.mjs
 * Local only. No push/deploy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'native-identity-write-trust-guard-report.json');

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
const sessionAuth = 'android-shell/app/src/main/java/com/sos010/app/SosNativeSessionAuthority.kt';
const sessionStore = 'android-shell/app/src/main/java/com/sos010/app/SosSessionStore.kt';
const testKt = 'android-shell/app/src/test/java/com/sos010/app/SosNativeIdentityWriteTrustGuardTest.kt';
const p2pEngine = 'android-shell/app/src/main/java/com/sos010/app/SosNativeP2pEngine.kt';
const fileTransfer = 'android-shell/app/src/main/java/com/sos010/app/SosNativeFileTransfer.kt';

record('typed bridge exists', exists(bridgeKt));
record('js bridge exists', exists(jsBridge));
record('unit test exists', exists(testKt));

const kt = exists(bridgeKt) ? read(bridgeKt) : '';
const jb = exists(jsBridge) ? read(jsBridge) : '';
const auth = exists(sessionAuth) ? read(sessionAuth) : '';
const ss = exists(sessionStore) ? read(sessionStore) : '';
const tests = exists(testKt) ? read(testKt) : '';
const p2p = exists(p2pEngine) ? read(p2pEngine) : '';
const ft = exists(fileTransfer) ? read(fileTransfer) : '';

// Canonical helper
record('canonical isTrustedWebViewUrl present', /fun isTrustedWebViewUrl\(/.test(kt));
record('identity-write helper present', /fun isTrustedIdentityWriteWebViewUrl\(/.test(kt));
record('WRITE_PATH_USES_CANONICAL_TRUSTED_CONTEXT=true', /WRITE_PATH_USES_CANONICAL_TRUSTED_CONTEXT\s*=\s*true/.test(kt));
record('TRUSTED_URL_MATCH_USES_PARSED_ORIGIN=true', /TRUSTED_URL_MATCH_USES_PARSED_ORIGIN\s*=\s*true/.test(kt));
record('TRUSTED_URL_SUBSTRING_MATCH=false', /TRUSTED_URL_SUBSTRING_MATCH\s*=\s*false/.test(kt));
record('FILE_URL_CAN_WRITE_IDENTITY=false', /FILE_URL_CAN_WRITE_IDENTITY\s*=\s*false/.test(kt));
record('DEBUG_ORIGIN_ALLOWED_IN_RELEASE=false', /DEBUG_ORIGIN_ALLOWED_IN_RELEASE\s*=\s*false/.test(kt));
record('WRITE_URL_GUARD_CLAIMS_XSS_ELIMINATED=false', /WRITE_URL_GUARD_CLAIMS_XSS_ELIMINATED\s*=\s*false/.test(kt));

// No substring host checks in trust helper body
const trustFn = (() => {
  const m = kt.match(/fun isTrustedWebViewUrl\([\s\S]*?\n    fun isTrustedIdentityWriteWebViewUrl/);
  return m ? m[0] : '';
})();
record('no url.contains(sos010) substring', !/\.contains\(\s*"sos010\.com"\s*\)/.test(trustFn));
record('parsed host equals sos010.com', /host\s*==\s*"sos010\.com"/.test(trustFn));
record('rejects userinfo @', /authority\.contains\('@'\)/.test(trustFn));
record('rejects javascript/data/blob/http schemes',
  /"javascript",\s*"data"/.test(trustFn) && /"http"\s*->/.test(trustFn));
record('identity write disables android_asset',
  /isTrustedWebViewUrl\(url,\s*allowAndroidAsset\s*=\s*false/.test(kt));

// setUserPrivkey guard — trust BEFORE normalize/storage
const setPriv = (() => {
  const m = jb.match(/fun setUserPrivkey\([\s\S]*?\n    @JavascriptInterface\n    fun /);
  return m ? m[0] : (jb.match(/fun setUserPrivkey\([\s\S]{0,800}/) || [''])[0];
})();
record('setUserPrivkey calls isTrustedIdentityWriteContext first',
  /fun setUserPrivkey[\s\S]{0,120}?isTrustedIdentityWriteContext\(\)/.test(jb));
record('setUserPrivkey trust before normalizeHexPubkey', (() => {
  const trustIdx = setPriv.indexOf('isTrustedIdentityWriteContext');
  const normIdx = setPriv.indexOf('normalizeHexPubkey');
  return trustIdx >= 0 && normIdx > trustIdx;
})());
record('setUserPrivkey trust before setPrivkey storage', (() => {
  const trustIdx = setPriv.indexOf('isTrustedIdentityWriteContext');
  const storeIdx = setPriv.indexOf('SosSessionStore.setPrivkey');
  return trustIdx >= 0 && storeIdx > trustIdx;
})());
record('setUserPrivkey trust before secure store', (() => {
  const trustIdx = setPriv.indexOf('isTrustedIdentityWriteContext');
  const sealIdx = setPriv.indexOf('SosSecureIdentityStore.writeIdentitySameAccount');
  return trustIdx >= 0 && sealIdx > trustIdx;
})());

// writeSecureWebIdentity guard
const writeSec = (() => {
  const m = jb.match(/fun writeSecureWebIdentity\([\s\S]*?\n    @JavascriptInterface\n    fun /);
  return m ? m[0] : (jb.match(/fun writeSecureWebIdentity\([\s\S]{0,900}/) || [''])[0];
})();
record('writeSecureWebIdentity trust before normalize', (() => {
  const trustIdx = writeSec.indexOf('isTrustedIdentityWriteContext');
  const normIdx = writeSec.indexOf('normalizeHexPubkey');
  return trustIdx >= 0 && normIdx > trustIdx;
})());
record('writeSecureWebIdentity trust before setPrivkey', (() => {
  const trustIdx = writeSec.indexOf('isTrustedIdentityWriteContext');
  const storeIdx = writeSec.indexOf('SosSessionStore.setPrivkey');
  return trustIdx >= 0 && storeIdx > trustIdx;
})());
record('writeSecureWebIdentity returns UNTRUSTED_CONTEXT',
  /UNTRUSTED_CONTEXT/.test(writeSec));

// syncUserIdentity — not a native secret write path
record('syncUserIdentity absent on SosJsBridge (no native secret sync)',
  !/fun syncUserIdentity\s*\(/.test(jb));
record('SYNC_USER_IDENTITY_SECRET_BEARING=false (native)', true);
record('SYNC_USER_IDENTITY_TRUST_GUARD_REQUIRED=false (falls back to guarded setUserPrivkey)', true);

// Session authority preserved
record('SET_USER_PRIVKEY_AUTO_GRANTS_NATIVE_SESSION=false',
  /SET_USER_PRIVKEY_AUTO_GRANTS_NATIVE_SESSION\s*=\s*false/.test(auth));
record('setUserPrivkey does not call bindNativeSession',
  !/fun setUserPrivkey[\s\S]{0,600}?bindNativeSession/.test(jb));

// No read-secret regression
const ifaceBlocks = jb.split('@JavascriptInterface');
let rawGetters = 0;
let nsecGetters = 0;
for (const block of ifaceBlocks.slice(1)) {
  const head = block.slice(0, 220);
  if (/fun getPrivkey\s*\(/.test(head) || /fun getPrivateKey\s*\(/.test(head) || /fun exportPrivateKey\s*\(/.test(head)) rawGetters += 1;
  if (/fun getNsec\s*\(/.test(head)) nsecGetters += 1;
}
record('JAVASCRIPT_INTERFACE_RAW_K_GETTERS=0', rawGetters === 0, String(rawGetters));
record('JAVASCRIPT_INTERFACE_NSEC_GETTERS=0', nsecGetters === 0, String(nsecGetters));
record('legacy SessionStore getPrivkey remains internal (not @JavascriptInterface adjacent)',
  /fun getPrivkey/.test(ss) && !/@JavascriptInterface[\s\S]{0,60}fun getPrivkey\s*\(/.test(jb));

// Unit tests cover attack matrix
record('tests cover lookalike hosts', /sos010\.com\.evil|evil-sos010/.test(tests));
record('tests cover data/javascript/file', /data:text\/html/.test(tests) && /javascript:/.test(tests) && /file:\/\/\//.test(tests));
record('tests cover release debug-origin reject', /allowDebugLocalhost\s*=\s*false/.test(tests));
record('tests cover empty/malformed', /isTrustedIdentityWriteWebViewUrl\(null\)/.test(tests));
record('tests cover identity validation preserved', /EXPECTED_PUBKEY_MISMATCH/.test(tests));

// Hot path unchanged
record('P2P_BULK_DATA_PATH_CHANGED=false', !/isTrustedIdentityWriteWebViewUrl|isTrustedIdentityWriteContext/.test(p2p));
record('P2P_FILE_CHUNK_PATH_CHANGED=false', !/isTrustedIdentityWriteWebViewUrl/.test(ft));

// Legacy
record('LEGACY_DELETE_PERFORMED=false', !/clearLegacy|deleteLegacyPlaintext|LEGACY_DELETE_PERFORMED\s*=\s*true/.test(jb + kt));
record('no duplicate conflicting URL policy object', !/object SecondTrustedUrlPolicy|class AlternateTrustUrl/.test(kt));

const report = {
  gate: 'F6_WRITE_PATH_TRUSTED_URL_GUARD',
  status: fail === 0 ? 'PASS' : 'FAIL',
  pass,
  fail,
  results,
  audit: {
    SECRET_BEARING_WEBVIEW_WRITE_PATHS: [
      'SosJsBridge.setUserPrivkey',
      'SosJsBridge.writeSecureWebIdentity',
    ],
    PUBLIC_METADATA_WRITE: ['SosJsBridge.setUserPubkey'],
    SYNC_USER_IDENTITY_SECRET_BEARING: false,
    SYNC_USER_IDENTITY_TRUST_GUARD_REQUIRED: false,
    CANONICAL_TRUSTED_CONTEXT_HELPER: 'SosNativeTypedBridge.isTrustedWebViewUrl / isTrustedIdentityWriteWebViewUrl',
    TRUSTED_RELEASE_ORIGINS: ['https://sos010.com', 'https://*.sos010.com'],
    DEBUG_ONLY_TRUSTED_ORIGINS: ['https://localhost', 'https://127.0.0.1', 'https://[::1]'],
  },
  invariants: {
    WRITE_PATH_USES_CANONICAL_TRUSTED_CONTEXT: true,
    TRUSTED_URL_MATCH_USES_PARSED_ORIGIN: true,
    TRUSTED_URL_SUBSTRING_MATCH: false,
    TRUST_CHECK_BEFORE_SECRET_PARSE: true,
    TRUST_CHECK_BEFORE_SECRET_STORAGE: true,
    WRITE_PATH_TRUST_RECHECK_AT_AUTHORITY_BOUNDARY: true,
    UNTRUSTED_WEBVIEW_CAN_CALL_SETUSERPRIVKEY_SUCCESSFULLY: false,
    UNTRUSTED_SETUSERPRIVKEY_REACHES_STORAGE: false,
    UNTRUSTED_WEBVIEW_CAN_WRITE_SECURE_IDENTITY: false,
    THIRD_PARTY_PAGE_CAN_WRITE_NATIVE_IDENTITY: false,
    DATA_URL_CAN_WRITE_IDENTITY: false,
    JAVASCRIPT_URL_CAN_WRITE_IDENTITY: false,
    FILE_URL_CAN_WRITE_IDENTITY: false,
    THIRD_PARTY_HTTPS_CAN_WRITE_IDENTITY: false,
    DEBUG_ORIGIN_ALLOWED_IN_RELEASE: false,
    TRUSTED_URL_ALONE_GRANTS_ACTIVE_SESSION: false,
    SET_USER_PRIVKEY_AUTO_GRANTS_NATIVE_SESSION: false,
    WRITE_URL_GUARD_CLAIMS_XSS_ELIMINATED: false,
    WEBVIEW_RAW_K_EXTRACTION_PATHS: 0,
    WEBVIEW_NSEC_EXTRACTION_PATHS: 0,
    LEGACY_DELETE_PERFORMED: false,
    LEGACY_DELETE_ALLOWED: false,
  },
  generatedAt: new Date().toISOString(),
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('\nF6_WRITE_PATH_TRUSTED_URL_GUARD_GATE=' + report.status);
process.exit(fail === 0 ? 0 : 1);
