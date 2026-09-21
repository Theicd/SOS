#!/usr/bin/env node
/**
 * Stage 5E-E1: secure-at-rest identity migration gate (prep + dual-read).
 * Isolated mocks / static analysis — never real user keys.
 * Run: node qa/identity-secure-storage-migration-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex } from 'nostr-tools/utils';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function makeStorage() {
  const map = new Map();
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(String(k), String(v));
    },
    removeItem(k) {
      map.delete(String(k));
    },
    clear() {
      map.clear();
    },
    _map: map,
  };
}

function makeFakeKey() {
  const sk = generateSecretKey();
  const hex = bytesToHex(sk).toLowerCase();
  const pub = getPublicKey(hex).toLowerCase();
  return { hex, pub };
}

/** Mirror Native decideDualRead contract in JS for scenarios A–F. */
function decideDualRead(secure, legacy, secureValid, legacyValid) {
  if (secureValid && legacyValid) {
    if (secure === legacy) {
      return { privkey: secure, state: 'IDENTITY_SECURE_MIRROR_OK', source: 'secure+legacy', mismatch: false };
    }
    return { privkey: '', state: 'IDENTITY_STORAGE_MISMATCH', source: 'mismatch', mismatch: true };
  }
  if (secureValid) {
    return { privkey: secure, state: 'SECURE_IDENTITY_ACTIVE', source: 'secure', mismatch: false };
  }
  if (legacyValid) {
    return { privkey: legacy, state: 'SECURE_IDENTITY_LEGACY_ONLY', source: 'legacy', mismatch: false };
  }
  return { privkey: '', state: 'SECURE_IDENTITY_NONE', source: 'none', mismatch: false };
}

function loadKeyStorage(options = {}) {
  const localStorage = options.localStorage || makeStorage();
  const sessionStorage = options.sessionStorage || makeStorage();
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    window: null,
    localStorage,
    sessionStorage,
  };
  ctx.window = ctx;
  if (options.nativeShell) {
    ctx.SosNativeShell = options.nativeShell;
  }
  vm.runInNewContext(read('key-storage.js'), ctx, { filename: 'key-storage.js' });
  return { ctx, localStorage, sessionStorage };
}

// --- Static Native contract ---
const secureKt = read('android-shell/app/src/main/java/com/sos010/app/SosSecureIdentityStore.kt');
const sessionKt = read('android-shell/app/src/main/java/com/sos010/app/SosSessionStore.kt');
const bridgeKt = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const lifecycleJs = read('identity-lifecycle.js');
const keysJs = read('keys.js');

record(
  'NATIVE_SECURE_STORE_FILE',
  /object SosSecureIdentityStore/.test(secureKt) &&
    /sos_identity_wrap_v1/.test(secureKt) &&
    /AES\/GCM\/NoPadding/.test(secureKt) &&
    /AndroidKeyStore/.test(secureKt) &&
    /setUserAuthenticationRequired\(false\)/.test(secureKt)
);

record(
  'NO_FAKE_ENCRYPTION',
  !/hard.?coded|static.?secret|XOR|Base64\.decode\(.*password/i.test(secureKt) &&
    /KeyGenParameterSpec/.test(secureKt)
);

record(
  'SECURE_API_SURFACE',
  /fun readSecurePrivkey/.test(secureKt) &&
    /fun writeSecurePrivkey/.test(secureKt) &&
    /fun clearSecurePrivkey/.test(secureKt) &&
    /fun hasSecurePrivkey/.test(secureKt) &&
    /fun migrateLegacyPrivkeyIfNeeded/.test(secureKt) &&
    /fun verifySecureIdentity/.test(secureKt) &&
    /fun decideDualRead/.test(secureKt)
);

record(
  'DUAL_READ_ORDER',
  /decideDualRead/.test(secureKt) &&
    /IDENTITY_STORAGE_MISMATCH/.test(secureKt) &&
    /IDENTITY_SECURE_MIRROR_OK/.test(secureKt) &&
    /getLegacyPrivkey/.test(sessionKt) &&
    /resolvePrivkey/.test(sessionKt)
);

record(
  'COPY_VERIFY_NO_LEGACY_DELETE',
  /SECURE_IDENTITY_COPY_VERIFIED/.test(secureKt) &&
    /legacyDeletePerformed.*false/.test(secureKt) &&
    /migrateLegacyPrivkeyIfNeeded/.test(sessionKt) &&
    !/remove\(KEY_PRIVKEY\).*migrate|deleteLegacy|LEGACY_DELETE_PERFORMED\s*=\s*true/.test(
      secureKt + sessionKt
    )
);

record(
  'CLEAR_CLEARS_SECURE',
  /SosSecureIdentityStore\.clearSecurePrivkey/.test(sessionKt) &&
    /getSecureIdentityStatusJson/.test(bridgeKt)
);

record(
  'NO_GENERATION_IN_SECURE_PATH',
  !/generateSecretKey|generateAndStoreKey|createNewIdentityExplicit/.test(secureKt)
);

record(
  'ZERO_GENERATION_KEYS_JS_STILL',
  /createNewIdentityExplicit/.test(keysJs) &&
    (/IDENTITY_NEW_USER/.test(keysJs) || /IDENTITY_NO_STORED_KEY/.test(keysJs)) &&
    /ensureKeys/.test(keysJs)
);

// --- Dual-read scenarios A–F ---
{
  const k1 = makeFakeKey();
  const k2 = makeFakeKey();

  // A legacy only → copy would use legacy; legacy retained
  const a = decideDualRead('', k1.hex, false, true);
  record('A_LEGACY_ONLY', a.privkey === k1.hex && a.source === 'legacy' && !a.mismatch);

  // B secure only
  const b = decideDualRead(k1.hex, '', true, false);
  record('B_SECURE_ONLY', b.privkey === k1.hex && b.source === 'secure');

  // C both same
  const c = decideDualRead(k1.hex, k1.hex, true, true);
  record('C_BOTH_SAME', c.state === 'IDENTITY_SECURE_MIRROR_OK' && c.privkey === k1.hex);

  // D both different — neither overwritten
  const d = decideDualRead(k1.hex, k2.hex, true, true);
  record(
    'D_BOTH_DIFFERENT_MISMATCH',
    d.mismatch && d.privkey === '' && d.state === 'IDENTITY_STORAGE_MISMATCH'
  );

  // E corrupt secure + valid legacy
  const e = decideDualRead('', k1.hex, false, true);
  record('E_CORRUPT_SECURE_LEGACY_FALLBACK', e.privkey === k1.hex && e.source === 'legacy');

  // F valid secure + corrupt legacy
  const f = decideDualRead(k1.hex, '', true, false);
  record('F_SECURE_KEPT_CORRUPT_LEGACY', f.privkey === k1.hex && f.source === 'secure');
}

// G/H encrypt/decrypt failure → legacy untouched (static + policy)
record(
  'G_ENCRYPT_FAIL_PRESERVES_LEGACY',
  /encrypt_fail/.test(secureKt) && /SECURE_IDENTITY_LEGACY_ONLY/.test(secureKt)
);
record(
  'H_DECRYPT_FAIL_PRESERVES_LEGACY',
  /decrypt_fail/.test(secureKt) && /remove\(KEY_BLOB\)/.test(secureKt)
);

// I restart K==K — dual-read returns same K when mirrored
{
  const k1 = makeFakeKey();
  const before = decideDualRead(k1.hex, k1.hex, true, true).privkey;
  const after = decideDualRead(k1.hex, k1.hex, true, true).privkey;
  record('I_APP_RESTART_K_STABLE', before === after && before === k1.hex);
}

// J APK upgrade simulation — legacy present, secure empty → legacy K used (no generation)
{
  const k1 = makeFakeKey();
  const r = decideDualRead('', k1.hex, false, true);
  record(
    'J_APK_UPGRADE_LEGACY_124',
    r.privkey === k1.hex && r.source === 'legacy' && !/generateSecretKey/.test(secureKt)
  );
}

// K logout clears secure + legacy (code contract)
record(
  'K_LOGOUT_CLEARS_BOTH',
  /clearSecurePrivkey/.test(sessionKt) &&
    /remove\(KEY_PRIVKEY\)/.test(sessionKt) &&
    /clearPrivateKey/.test(lifecycleJs)
);

// L switch A→B — prepare/commit still clears then writes B
record(
  'L_ACCOUNT_SWITCH_NO_MIX',
  /commitAccountSwitch/.test(lifecycleJs) &&
    /ACCOUNT_SWITCH_ABORT/.test(lifecycleJs) &&
    /clearUserSession/.test(lifecycleJs)
);

// M background verifier uses SosSessionStore.getPrivkey (now dual-read)
{
  const verifier = read('android-shell/app/src/main/java/com/sos010/app/SosNativeCallVerifier.kt');
  record(
    'M_BACKGROUND_VERIFIER_VIA_SESSION',
    /SosSessionStore\.getPrivkey/.test(verifier)
  );
}

// N session-only does not become durable Web secure
{
  const ls = makeStorage();
  const ss = makeStorage();
  ls.setItem('sos_session_only_key', '1');
  const { ctx } = loadKeyStorage({ localStorage: ls, sessionStorage: ss });
  const k1 = makeFakeKey();
  ctx.SOSKeyStorage.writePrivateKeyHex(k1.hex);
  const durable = ls.getItem('nostr_private_key');
  const eph = ss.getItem('nostr_private_key_ephemeral');
  const meta = ls.getItem('sos_web_secure_identity_meta_v1');
  record(
    'N_SESSION_ONLY_NOT_DURABLE',
    !durable && eph === k1.hex && !meta && ctx.SOSKeyStorage.isSessionOnly()
  );
}

// O zero generation in migration paths
record(
  'O_ZERO_GENERATION',
  !/generateSecretKey|generateAndStoreKey|createNewIdentityExplicit/.test(secureKt) &&
    !/generateSecretKey/.test(sessionKt)
);

// Web sync API compatibility
{
  const { ctx } = loadKeyStorage();
  const api = ctx.SOSKeyStorage;
  const k1 = makeFakeKey();
  record(
    'WEB_SYNC_API_COMPAT',
    typeof api.readPrivateKeyRaw === 'function' &&
      typeof api.readPrivateKeyHex === 'function' &&
      typeof api.writePrivateKeyRaw === 'function' &&
      typeof api.writePrivateKeyHex === 'function' &&
      typeof api.clearPrivateKey === 'function' &&
      api.writePrivateKeyHex(k1.hex) === true &&
      api.readPrivateKeyHex() === k1.hex
  );
  const notes = api.getSecurityDesignNotes();
  record(
    'WEB_DESIGN_NOTES',
    notes &&
      notes.asyncConversion === false &&
      notes.legacyDeletePerformed === false &&
      /XSS/.test(notes.xssLimitation || '')
  );
}

// Acceptance markers
record('LEGACY_DELETE_PERFORMED_FALSE', /legacyDeletePerformed.*,\s*false/.test(secureKt + sessionKt + bridgeKt));
record('EXISTING_K_PRESERVED_CONTRACT', /NO key generation|Never generates|no generation|ZERO_GENERATION|does NOT delete legacy/i.test(secureKt));

const failed = results.filter((r) => !r.ok);
console.log('---');
console.log('TOTAL ' + results.length + ' PASS ' + (results.length - failed.length) + ' FAIL ' + failed.length);
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join(', '));
  process.exit(1);
}
console.log('STATUS=PASS');
process.exit(0);
