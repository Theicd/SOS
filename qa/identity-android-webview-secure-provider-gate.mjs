#!/usr/bin/env node
/**
 * Stage 5E-E2B1: Android WebView NativeSecureProvider.
 * Browser and old APK stay on LegacyProvider.
 * Run: node qa/identity-android-webview-secure-provider-gate.mjs
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

function makeFake() {
  const sk = generateSecretKey();
  const hex = bytesToHex(sk).toLowerCase();
  const pub = getPublicKey(hex).toLowerCase();
  return { hex, pub };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(k); },
    _map: map,
  };
}

function makeBridge(store) {
  return {
    isNativeShell() { return true; },
    getIdentityStorageCapabilitiesJson() {
      if (!store.capable) return JSON.stringify({ nativeSecureWebIdentity: false, version: 0 });
      return JSON.stringify({ nativeSecureWebIdentity: true, version: 1 });
    },
    getSecureWebIdentityJson() {
      if (store.mismatchInternal) return JSON.stringify({ ok: false, state: 'WEB_SECURE_MISMATCH' });
      if (store.recovery) return JSON.stringify({ ok: false, state: 'WEB_SECURE_RECOVERY_REQUIRED' });
      if (!store.priv || !store.pub) return JSON.stringify({ ok: false, state: 'WEB_SECURE_NONE' });
      return JSON.stringify({ ok: true, state: 'ACTIVE', pubkey: store.pub, privkey: store.priv });
    },
    writeSecureWebIdentity(pub, priv) {
      store.writeCalls = (store.writeCalls || 0) + 1;
      if (store.rejectWrite) return JSON.stringify({ ok: false, state: 'WEB_SECURE_RECOVERY_REQUIRED' });
      store.priv = String(priv || '').toLowerCase();
      store.pub = String(pub || '').toLowerCase();
      return JSON.stringify({ ok: true, state: 'ACTIVE', pubkey: store.pub, result: 'SYNC_IDENTITY_OK' });
    },
    clearUserSession() {
      store.priv = '';
      store.pub = '';
      store.cleared = true;
      return JSON.stringify({ ok: true, result: 'LOGOUT_NATIVE_CLEAR_OK' });
    },
  };
}

function load(options = {}) {
  const localStorage = options.localStorage || makeStorage();
  const sessionStorage = options.sessionStorage || makeStorage();
  const store = options.store || null;
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    window: null,
    localStorage,
    sessionStorage,
    NostrTools: { getPublicKey, generateSecretKey },
  };
  ctx.window = ctx;
  ctx.NostrApp = {
    validateIdentityPair(priv, expected) {
      const p = String(priv || '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(p)) return { ok: false };
      let pub = '';
      try { pub = String(getPublicKey(p) || '').toLowerCase(); } catch (_e) { return { ok: false }; }
      const exp = String(expected || '').trim().toLowerCase();
      if (exp && exp !== pub) return { ok: false, privateKey: p, publicKey: pub };
      return { ok: true, privateKey: p, publicKey: pub };
    },
    getPublicKey,
  };
  if (store) ctx.SosNativeShell = makeBridge(store);
  else if (options.oldApk) {
    ctx.SosNativeShell = { isNativeShell() { return true; } };
  }
  vm.createContext(ctx);
  vm.runInContext(read('key-storage.js'), ctx);
  return { ctx, localStorage, sessionStorage, store };
}

const k1 = makeFake();
const k2 = makeFake();

// A both same → delete web plaintext
{
  const ls = makeStorage();
  ls.setItem('nostr_private_key', k1.hex);
  const store = { capable: true, priv: k1.hex, pub: k1.pub, writeCalls: 0 };
  const { ctx, localStorage } = load({ localStorage: ls, store });
  const got = ctx.SOSKeyStorage.readPrivateKeyHex();
  record('A_SAME_CUTOVER',
    got === k1.hex
    && !localStorage.getItem('nostr_private_key')
    && ctx.SOSKeyStorage.getProviderState() === 'WEB_SECURE_ACTIVE'
    && store.priv === k1.hex
    && store.writeCalls === 0);
}

// B native only hydrate
{
  const store = { capable: true, priv: k1.hex, pub: k1.pub };
  const { ctx, localStorage } = load({ store });
  record('B_NATIVE_ONLY_HYDRATE',
    ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex
    && !localStorage.getItem('nostr_private_key')
    && ctx.SOSKeyStorage.activeProviderName() === 'NativeSecureProvider'
    && ctx.SOSKeyStorage.getProviderState() === 'WEB_SECURE_ACTIVE');
}

// C mismatch delete nothing
{
  const ls = makeStorage();
  ls.setItem('nostr_private_key', k2.hex);
  const store = { capable: true, priv: k1.hex, pub: k1.pub, writeCalls: 0 };
  const { ctx, localStorage } = load({ localStorage: ls, store });
  const got = ctx.SOSKeyStorage.readPrivateKeyRaw();
  record('C_MISMATCH_NO_DELETE',
    got === ''
    && localStorage.getItem('nostr_private_key') === k2.hex
    && store.priv === k1.hex
    && store.writeCalls === 0
    && ctx.SOSKeyStorage.getProviderState() === 'WEB_SECURE_MISMATCH');
}

// D invalid native
{
  const store = { capable: true, recovery: true, priv: '', pub: '' };
  const { ctx, localStorage } = load({ store });
  record('D_INVALID_NATIVE_RECOVERY',
    ctx.SOSKeyStorage.readPrivateKeyRaw() === ''
    && ctx.SOSKeyStorage.getProviderState() === 'WEB_SECURE_RECOVERY_REQUIRED'
    && !localStorage.getItem('nostr_private_key'));
}

// E old APK
{
  const ls = makeStorage();
  ls.setItem('nostr_private_key', k1.hex);
  const { ctx, localStorage } = load({ localStorage: ls, oldApk: true });
  record('E_OLD_APK_LEGACY',
    ctx.SOSKeyStorage.activeProviderName() === 'LegacyProvider'
    && ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex
    && localStorage.getItem('nostr_private_key') === k1.hex);
}

// F browser
{
  const ls = makeStorage();
  ls.setItem('nostr_private_key', k1.hex);
  const { ctx, localStorage } = load({ localStorage: ls });
  const wrote = ctx.SOSKeyStorage.writePrivateKeyHex(k1.hex);
  record('F_BROWSER_LEGACY_UNCHANGED',
    ctx.SOSKeyStorage.activeProviderName() === 'LegacyProvider'
    && wrote === true
    && localStorage.getItem('nostr_private_key') === k1.hex
    && ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex);
}

// G explicit create new apk — one secure write, no web plaintext
{
  const store = { capable: true, priv: '', pub: '', writeCalls: 0 };
  const { ctx, localStorage } = load({ store });
  const ok = ctx.SOSKeyStorage.writePrivateKeyHex(k1.hex);
  record('G_CREATE_SECURE_NO_PLAINTEXT',
    ok === true
    && store.writeCalls === 1
    && store.priv === k1.hex
    && store.pub === k1.pub
    && !localStorage.getItem('nostr_private_key')
    && ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex);
}

// H import
{
  const store = { capable: true, priv: k1.hex, pub: k1.pub, writeCalls: 0 };
  const { ctx, localStorage } = load({ store });
  ctx.SOSKeyStorage.clearPrivateKey();
  const ok = ctx.SOSKeyStorage.writePrivateKeyHex(k2.hex);
  record('H_IMPORT_SECURE',
    ok === true
    && store.cleared === true
    && store.priv === k2.hex
    && store.pub === k2.pub
    && !localStorage.getItem('nostr_private_key'));
}

// I invalid import — write rejected, previous remains
{
  const store = { capable: true, priv: k1.hex, pub: k1.pub, writeCalls: 0 };
  const { ctx, localStorage } = load({ store });
  const ok = ctx.SOSKeyStorage.writePrivateKeyRaw('not-a-key');
  record('I_INVALID_IMPORT_PRESERVED',
    ok === false
    && store.priv === k1.hex
    && store.writeCalls === 0
    && !localStorage.getItem('nostr_private_key'));
}

// J logout then reload no revive
{
  const store = { capable: true, priv: k1.hex, pub: k1.pub };
  const first = load({ store });
  first.ctx.SOSKeyStorage.readPrivateKeyHex();
  first.ctx.SOSKeyStorage.clearPrivateKey();
  const second = load({ store, localStorage: first.localStorage, sessionStorage: first.sessionStorage });
  record('J_LOGOUT_NO_REVIVE',
    store.cleared === true
    && !store.priv
    && second.ctx.SOSKeyStorage.readPrivateKeyRaw() === ''
    && !first.localStorage.getItem('nostr_private_key'));
}

// K session only no durable native write
{
  const ls = makeStorage();
  const ss = makeStorage();
  ls.setItem('sos_session_only_key', '1');
  const store = { capable: true, priv: '', pub: '', writeCalls: 0 };
  const { ctx, localStorage, sessionStorage } = load({ localStorage: ls, sessionStorage: ss, store });
  const ok = ctx.SOSKeyStorage.writePrivateKeyHex(k1.hex);
  record('K_SESSION_ONLY_NO_DURABLE',
    ok === true
    && ctx.SOSKeyStorage.activeProviderName() === 'SessionOnlyProvider'
    && store.writeCalls === 0
    && !store.priv
    && !localStorage.getItem('nostr_private_key')
    && sessionStorage.getItem('nostr_private_key_ephemeral') === k1.hex);
}

// L export via read does not recreate plaintext
{
  const store = { capable: true, priv: k1.hex, pub: k1.pub };
  const { ctx, localStorage } = load({ store });
  const exported = ctx.SOSKeyStorage.readPrivateKeyHex();
  record('L_EXPORT_NO_PLAINTEXT_COPY',
    exported === k1.hex
    && !localStorage.getItem('nostr_private_key'));
}

const appFiles = [];
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'android-shell' || ent.name === 'qa') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (/\.(js|html)$/.test(ent.name) && ent.name !== 'key-storage.js') appFiles.push(p);
  }
}
walk(root);
const bypass = appFiles.filter((p) => fs.readFileSync(p, 'utf8').includes('nostr_private_key'));
record('M_CONFIG_NO_DIRECT', !read('config.js').includes('nostr_private_key'));
record('N_AUTH_GUARD_USES_PROVIDER', /SOSKeyStorage/.test(read('auth-guard.js')) && !read('auth-guard.js').includes('nostr_private_key'));
record('O_RECONCILE_NO_LEGACY_FALLBACK',
  !read('native-shell-bridge.js').includes('nostr_private_key')
  && /SESSION_ONLY_NO_DURABLE_NATIVE/.test(read('native-shell-bridge.js'))
  && !/getVerifierSessionJson\(/.test(read('key-storage.js')));
record('P_GAMES_NO_BYPASS',
  !read('hexgl-multiplayer.html').includes("getItem('nostr_private_key'")
  && read('hexgl-multiplayer.html').includes('key-storage.js')
  && read('doom-multiplayer.html').includes('SOSKeyStorage')
  && read('nzp-multiplayer.html').includes('SOSKeyStorage'));
record('Q_ZERO_GENERATION', !/generateSecretKey|generateAndStoreKey|createNewIdentityExplicit/.test(read('key-storage.js')));
record('DIRECT_ACCOUNT_LEGACY_BYPASS_0', bypass.length === 0, bypass.map((p) => path.relative(root, p)).join(','));

record('BRIDGE_APIS',
  /fun getSecureWebIdentityJson/.test(read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt'))
  && /fun getIdentityStorageCapabilitiesJson/.test(read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt'))
  && /fun writeSecureWebIdentity/.test(read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt'))
  && /nativeSecureWebIdentity/.test(read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt')));

const indexHtml = read('index.html');
record('SCRIPT_ORDER_INDEX',
  indexHtml.indexOf('key-storage.js') >= 0
  && indexHtml.indexOf('auth-guard.js') > indexHtml.indexOf('key-storage.js'));

const failed = results.filter((r) => !r.ok);
console.log('---');
console.log('TOTAL ' + results.length + ' PASS ' + (results.length - failed.length) + ' FAIL ' + failed.length);
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join(', '));
  process.exit(1);
}
console.log('STATUS=PASS');
process.exit(0);
