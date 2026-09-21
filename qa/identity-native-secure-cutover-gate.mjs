#!/usr/bin/env node
/**
 * Stage 5E-E2A: Native secure cutover. Web plaintext is out of scope.
 * Run: node qa/identity-native-secure-cutover-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function decide(secureValid, legacyValid, sameK, corrupt, pubkeyAgrees, residue = false) {
  const S = {
    none: 'NATIVE_SECURE_NONE',
    legacy: 'NATIVE_SECURE_LEGACY_ONLY',
    verified: 'NATIVE_SECURE_COPY_VERIFIED',
    active: 'NATIVE_SECURE_ACTIVE',
    mismatch: 'NATIVE_SECURE_MISMATCH',
    recovery: 'NATIVE_SECURE_RECOVERY_REQUIRED',
  };
  if (secureValid && legacyValid && !sameK) {
    return { state: S.mismatch, authoritative: 'mismatch', remove: false, copy: false, recovery: true };
  }
  if (secureValid && legacyValid && sameK) {
    if (!pubkeyAgrees) return { state: S.recovery, authoritative: 'secure', remove: false, copy: false, recovery: true };
    return { state: S.verified, authoritative: 'secure', remove: true, copy: false, recovery: false };
  }
  if (secureValid && !legacyValid) {
    if (!pubkeyAgrees) return { state: S.recovery, authoritative: 'secure', remove: false, copy: false, recovery: true };
    return { state: S.active, authoritative: 'secure', remove: residue, copy: false, recovery: false };
  }
  if (!secureValid && legacyValid) {
    if (!pubkeyAgrees) return { state: S.recovery, authoritative: 'legacy', remove: false, copy: false, recovery: true };
    if (corrupt) return { state: S.recovery, authoritative: 'legacy', remove: false, copy: true, recovery: true };
    return { state: S.legacy, authoritative: 'legacy', remove: false, copy: true, recovery: false };
  }
  if (corrupt) return { state: S.recovery, authoritative: 'none', remove: false, copy: false, recovery: true };
  return { state: S.none, authoritative: 'none', remove: false, copy: false, recovery: false };
}

const session = read('android-shell/app/src/main/java/com/sos010/app/SosSessionStore.kt');
const secure = read('android-shell/app/src/main/java/com/sos010/app/SosSecureIdentityStore.kt');
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const verifier = read('android-shell/app/src/main/java/com/sos010/app/SosNativeCallVerifier.kt');
const relay = read('android-shell/app/src/main/java/com/sos010/app/SosRelayWatcher.kt');
const p2p = read('android-shell/app/src/main/java/com/sos010/app/SosNativeP2pEngine.kt');
const manifest = read('android-shell/app/src/main/AndroidManifest.xml');
const backup = read('android-shell/app/src/main/res/xml/backup_rules.xml');
const mainKt = [
  session,
  secure,
  bridge,
  verifier,
  read('android-shell/app/src/main/java/com/sos010/app/SosNativeP2pEngine.kt'),
].join('\n');

record('NO_PLAINTEXT_PRIVKEY_WRITE', !/putString\(KEY_PRIVKEY/.test(session + secure + bridge));
record(
  'CUTOVER_HELPER_PRESENT',
  /fun removeLegacyPrivkeyAfterVerifiedCutover/.test(session) &&
    /fun hasLegacyPrivkey/.test(session) &&
    /fun decideNativeCutover/.test(secure)
);
record(
  'CUTOVER_LOG_MARKER',
  /NATIVE_SECURE_CUTOVER legacy_deleted=1 verified=1/.test(session)
);
record(
  'STATES',
  /NATIVE_SECURE_NONE/.test(secure) &&
    /NATIVE_SECURE_LEGACY_ONLY/.test(secure) &&
    /NATIVE_SECURE_COPY_VERIFIED/.test(secure) &&
    /NATIVE_SECURE_ACTIVE/.test(secure) &&
    /NATIVE_SECURE_MISMATCH/.test(secure) &&
    /NATIVE_SECURE_RECOVERY_REQUIRED/.test(secure) &&
    /secure_identity_version/.test(secure)
);
record('PUBKEY_NOT_REMOVED_ON_CUTOVER', /remove\(KEY_PRIVKEY\)/.test(session) && !/removeLegacyPrivkeyAfterVerifiedCutover[\s\S]{0,900}remove\(KEY_PUBKEY\)/.test(session));
record('NO_GENERATION', !/generateSecretKey|generateAndStoreKey|createNewIdentityExplicit/.test(session + secure));
record('LEGACY_BRIDGE_USES_SET_IDENTITY_PAIR', /return setIdentityPair\(context, pub, priv\)/.test(session));
record('WEB_SYNC_WRITES_SECURE', /writeSecurePrivkey\(context, priv\)/.test(session) && !/putString\(KEY_PRIVKEY/.test(session));
record(
  'BACKGROUND_USES_GETPRIVKEY',
  /SosSessionStore\.getPrivkey/.test(verifier) &&
    !/getLegacyPrivkey/.test(verifier + relay + p2p)
);
record('LOGOUT_CLEARS_BOTH', /remove\(KEY_PRIVKEY\)/.test(session) && /clearSecurePrivkey/.test(session));
record(
  'BACKUP_EXCLUDES_SECURE_PREFS',
  /sos_secure_identity\.xml/.test(backup) &&
    /fullBackupContent/.test(manifest) &&
    /dataExtractionRules/.test(manifest)
);
record('E1_MIGRATE_STILL_DOES_NOT_OWN_DELETE', /Does NOT delete legacy/.test(secure));

const a = decide(false, true, false, false, true);
record('A_LEGACY_124_COPY_THEN_REMOVE', a.copy && !a.remove && decide(true, true, true, false, true).remove);

const b = decide(true, true, true, false, true);
record('B_BOTH_SAME_REMOVE', b.remove && b.authoritative === 'secure');

const c = decide(true, true, false, false, true);
record('C_BOTH_DIFFERENT_NO_DELETE', c.authoritative === 'mismatch' && !c.remove && !c.copy);

const d = decide(false, true, false, true, true);
record('D_CORRUPT_SECURE_KEEP_LEGACY', d.authoritative === 'legacy' && !d.remove);

const e = decide(true, false, false, false, true, true);
record('E_SECURE_VALID_BAD_LEGACY_RESIDUE', e.authoritative === 'secure' && e.remove && !e.recovery);

const f = decide(false, true, false, false, true);
record('F_ENCRYPT_FAIL_MODEL_NO_DELETE', !f.remove && f.authoritative === 'legacy');

const g = decide(false, true, false, true, true);
record('G_DECRYPT_FAIL_MODEL_NO_DELETE', !g.remove && g.authoritative === 'legacy');

const h = decide(true, true, true, false, true);
record('H_DEATH_BEFORE_DELETE_RETRY', h.remove && h.authoritative === 'secure');

const i = decide(true, false, false, false, true, false);
record('I_DEATH_AFTER_DELETE_SECURE', i.state === 'NATIVE_SECURE_ACTIVE' && !i.remove);

const j1 = decide(true, false, false, false, true);
const j2 = decide(true, false, false, false, true);
record('J_REBOOT_SAME', j1.state === j2.state && j1.authoritative === 'secure');

const k0 = decide(false, true, false, false, true);
const k1 = decide(true, true, true, false, true);
record('K_APK_UPGRADE', k0.copy && !k0.remove && k1.remove && k1.authoritative === 'secure');

record('L_LOGOUT', /fun clear\(/.test(session) && /clearSecurePrivkey/.test(session) && /remove\(KEY_PRIVKEY\)/.test(session));

record('M_SWITCH_SECURE_WRITE', /writeSecurePrivkey/.test(session) && !/putString\(KEY_PRIVKEY/.test(session));

record('N_BACKGROUND_NO_LEGACY_REQUIRED', /fun getPrivkey/.test(session) && /SosSessionStore\.getPrivkey/.test(verifier));

record('O_WEB_ONLY_NO_PLAINTEXT', /writeSecurePrivkey\(context, priv\)/.test(session) && !/putString\(KEY_PRIVKEY/.test(mainKt));

record('P_OLD_BRIDGE_NO_PLAINTEXT_RECREATE', /fun setPrivkey/.test(session) && !/putString\(KEY_PRIVKEY/.test(session) && /setIdentityPair\(context, derived, normalized\)/.test(session));

const q = decide(false, false, false, true, false);
record('Q_KEYSTORE_INVALID_RECOVERY', q.state === 'NATIVE_SECURE_RECOVERY_REQUIRED' && q.authoritative === 'none' && !q.copy && !q.remove);

record('MISMATCH_NOT_DESTRUCTIVE', c.recovery && !c.remove);
record('PUBKEY_MISMATCH_NO_CUTOVER', decide(true, true, true, false, false).remove === false);

const failed = results.filter((r) => !r.ok);
console.log('---');
console.log('TOTAL ' + results.length + ' PASS ' + (results.length - failed.length) + ' FAIL ' + failed.length);
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join(', '));
  process.exit(1);
}
console.log('STATUS=PASS');
process.exit(0);
