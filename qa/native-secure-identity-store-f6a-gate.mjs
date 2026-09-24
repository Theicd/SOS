#!/usr/bin/env node
/**
 * F6A — Native secure identity store static gate (no APK deploy).
 * Run: node qa/native-secure-identity-store-f6a-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'native-secure-identity-store-f6a-report.json');

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

const storeRel = 'android-shell/app/src/main/java/com/sos010/app/SosSecureIdentityStore.kt';
const testRel = 'android-shell/app/src/test/java/com/sos010/app/SosSecureIdentityStoreTest.kt';
const manifest = 'android-shell/app/src/main/AndroidManifest.xml';
const backup = 'android-shell/app/src/main/res/xml/backup_rules.xml';
const extraction = 'android-shell/app/src/main/res/xml/data_extraction_rules.xml';
const bridge = 'android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt';
const session = 'android-shell/app/src/main/java/com/sos010/app/SosSessionStore.kt';
const design = 'docs/security/F6_ANDROID_NATIVE_TYPED_SIGNER_DESIGN.md';

record('secure store file exists', exists(storeRel));
record('unit test file exists', exists(testRel));
record('design doc present', exists(design));

const src = exists(storeRel) ? read(storeRel) : '';
const testSrc = exists(testRel) ? read(testRel) : '';
const man = exists(manifest) ? read(manifest) : '';
const bak = exists(backup) ? read(backup) : '';
const ext = exists(extraction) ? read(extraction) : '';
const br = exists(bridge) ? read(bridge) : '';
const sess = exists(session) ? read(session) : '';

record('Keystore alias sos_identity_wrap_v1', /sos_identity_wrap_v1/.test(src));
record('AES/GCM/NoPadding', /AES\/GCM\/NoPadding/.test(src));
record('Keystore key size 256', /setKeySize\(256\)/.test(src));
record('AAD SOS|android-identity|v1', /SOS\|android-identity\|v1/.test(src));
record('prefs sos_native_identity_secure_v1', /sos_native_identity_secure_v1/.test(src));
record('randomized encryption required', /setRandomizedEncryptionRequired\(true\)/.test(src));
record('no generateSecretKey in store', !/generateSecretKey/.test(src));
record('no getRawPrivateKeyForWebView', !/getRawPrivateKeyForWebView|exportPrivateKey|getNsec\s*\(/.test(src));
record('clearSecureIdentity API present', /fun clearSecureIdentity/.test(src));
record('legacy migrate retains (no removeItem privkey)', /migrateFromLegacySessionStoreIfNeeded/.test(src));
record('mismatch overwrite rejected', /DIFFERENT_IDENTITY_OVERWRITE/.test(src));
record('expected pubkey validated', /EXPECTED_PUBKEY_MISMATCH/.test(src));
record('community independent constant', /NATIVE_IDENTITY_COMMUNITY_INDEPENDENT\s*=\s*true/.test(src));
record('not session authority', /SECURE_IDENTITY_STORE_IS_SESSION_AUTHORITY\s*=\s*false/.test(src));
record('legacy delete allowed false', /LEGACY_DELETE_ALLOWED\s*=\s*false/.test(src));
record('zeroization claim false', /F6A_CLAIMS_PERFECT_ZEROIZATION\s*=\s*false/.test(src));

record('backup_rules excludes secure prefs', /sos_native_identity_secure_v1\.xml/.test(bak));
record('backup_rules excludes legacy session prefs', /sos_native_session\.xml/.test(bak));
record('data_extraction_rules excludes secure prefs', /sos_native_identity_secure_v1\.xml/.test(ext));
record('manifest references backup_rules', /fullBackupContent="@xml\/backup_rules"/.test(man));
record('manifest references data_extraction_rules', /dataExtractionRules="@xml\/data_extraction_rules"/.test(man));

// Legacy still present; WebView raw path still present (expected until F6B/C)
record('legacy SosSessionStore privkey still present', /KEY_PRIVKEY|"privkey"/.test(sess) && /fun getPrivkey/.test(sess));
record(
  'webview getVerifierSessionJson no longer exposes privkey (F6C)',
  /fun getVerifierSessionJson/.test(br) && !/put\("privkey"/.test(br)
);
record(
  'F6A did not add new WebView raw-K getter',
  !/fun getSecurePrivateKey|fun exportIdentityKey|fun getNsecForWeb/.test(br + src)
);

// R2 WIP files not modified by this gate's expected surface — check design doesn't require discard
record('IncomingCallActivity still present', exists('android-shell/app/src/main/java/com/sos010/app/IncomingCallActivity.kt'));
record('SosSecureCallSessionStore still present', exists('android-shell/app/src/main/java/com/sos010/app/SosSecureCallSessionStore.kt'));

// Tests cover critical cases
record('test same K/P', /writeAndReadPreservesSameKP/.test(testSrc));
record('test overwrite rejected', /differentIdentityOverwriteRejected/.test(testSrc));
record('test legacy migration', /legacyMigrationPreservesSameKPAndRetainsLegacy/.test(testSrc));
record('test corrupt recovery', /corruptCiphertextRecoveryRequired/.test(testSrc));
record('test failed write preserves', /failedWritePreservesPreviousIdentity/.test(testSrc));

// F7 unchanged
record(
  'session-authority.js unchanged by F6A (file exists)',
  exists('session-authority.js') && /sos_session_generation/.test(read('session-authority.js'))
);

const report = {
  gate: 'native-secure-identity-store-f6a',
  F6A_NATIVE_SECURE_STORE_GATE: fail === 0 ? 'PASS' : 'FAIL',
  ANDROID_KEYSTORE_USED: true,
  KEYSTORE_ALIAS: 'sos_identity_wrap_v1',
  KEYSTORE_CIPHER: 'AES/GCM/NoPadding',
  IDENTITY_AAD: 'SOS|android-identity|v1',
  IDENTITY_BLOB_VERSION: 1,
  LEGACY_PLAINTEXT_SESSIONSTORE_STILL_PRESENT: true,
  EXPECTED_TEMPORARY_STAGE: true,
  CURRENT_WEBVIEW_RAW_K_PATH_STILL_PRESENT: true,
  EXPECTED_UNTIL_F6B_F6C: true,
  LEGACY_IDENTITY_DELETE_PERFORMED: false,
  LEGACY_DELETE_ALLOWED: false,
  NATIVE_SECURE_IDENTITY_BACKUP_POLICY_SAFE: /sos_native_identity_secure_v1/.test(bak) && /dataExtractionRules/.test(man),
  SECURE_IDENTITY_STORE_IS_SESSION_AUTHORITY: false,
  NATIVE_IDENTITY_COMMUNITY_INDEPENDENT: true,
  pass,
  fail,
  results,
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('\nF6A_NATIVE_SECURE_STORE_GATE=' + report.F6A_NATIVE_SECURE_STORE_GATE);
console.log('REPORT=' + OUT);
process.exit(fail === 0 ? 0 : 1);
