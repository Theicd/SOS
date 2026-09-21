#!/usr/bin/env node
/**
 * Stage 5E-E2B2A: browser secure copy. Legacy plaintext is not deleted by migration.
 * Run: node qa/identity-browser-secure-provider-gate.mjs
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

function makeStorage(seed) {
  const map = new Map(seed || []);
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

function makeIdb() {
  const stores = {
    wrapping_key: new Map(),
    identity_blob: new Map(),
    metadata: new Map(),
  };
  let opens = 0;
  const indexedDB = {
    open() {
      opens += 1;
      const req = {};
      const db = {
        objectStoreNames: { contains(name) { return Object.prototype.hasOwnProperty.call(stores, name); } },
        createObjectStore(name) { stores[name] = stores[name] || new Map(); return {}; },
        transaction(storeName) {
          const name = Array.isArray(storeName) ? storeName[0] : storeName;
          return {
            objectStore() {
              return {
                get(key) {
                  const r = {};
                  setTimeout(() => {
                    r.result = stores[name].get(key);
                    if (r.onsuccess) r.onsuccess();
                  }, 0);
                  return r;
                },
                put(value, key) {
                  const r = {};
                  setTimeout(() => {
                    stores[name].set(key, value);
                    r.result = key;
                    if (r.onsuccess) r.onsuccess();
                  }, 0);
                  return r;
                },
                delete(key) {
                  const r = {};
                  setTimeout(() => {
                    stores[name].delete(key);
                    if (r.onsuccess) r.onsuccess();
                  }, 0);
                  return r;
                },
              };
            },
          };
        },
        close() {},
      };
      setTimeout(() => {
        req.result = db;
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
  };
  return {
    indexedDB,
    opens: () => opens,
    blob: () => stores.identity_blob.get('current') || null,
    wrap: () => stores.wrapping_key.get('v1') || null,
  };
}

function load(options = {}) {
  const localStorage = options.localStorage || makeStorage();
  const sessionStorage = options.sessionStorage || makeStorage();
  const idb = options.idb || null;
  const gen = { n: 0 };
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    crypto: options.crypto === null ? undefined : globalThis.crypto,
    indexedDB: idb ? idb.indexedDB : undefined,
    window: null,
    localStorage,
    sessionStorage,
    __sosBrowserSecureDelayMs: options.delay || 0,
    __sosBrowserSecureForceFail: options.fail || '',
    NostrTools: {
      getPublicKey,
      generateSecretKey() { gen.n += 1; return generateSecretKey(); },
    },
  };
  ctx.window = ctx;
  ctx.NostrApp = {
    validateIdentityPair(priv, expected) {
      const p = String(priv || '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(p)) return { ok: false };
      let pub = '';
      try { pub = String(getPublicKey(p) || '').toLowerCase(); } catch (_e) { return { ok: false }; }
      const exp = String(expected || '').trim().toLowerCase();
      if (exp && exp !== pub) return { ok: false };
      return { ok: true, privateKey: p, publicKey: pub };
    },
  };
  if (options.native === 'new') {
    const store = options.nativeStore;
    ctx.SosNativeShell = {
      isNativeShell() { return true; },
      getIdentityStorageCapabilitiesJson() { return JSON.stringify({ nativeSecureWebIdentity: true, version: 1 }); },
      getSecureWebIdentityJson() {
        if (!store.priv) return JSON.stringify({ ok: false, state: 'WEB_SECURE_NONE' });
        return JSON.stringify({ ok: true, state: 'ACTIVE', pubkey: store.pub, privkey: store.priv });
      },
      writeSecureWebIdentity(pub, priv) {
        store.priv = String(priv).toLowerCase();
        store.pub = String(pub).toLowerCase();
        return JSON.stringify({ ok: true, state: 'ACTIVE', pubkey: store.pub });
      },
      clearUserSession() { store.priv = ''; store.pub = ''; return JSON.stringify({ ok: true }); },
    };
  } else if (options.native === 'old') {
    ctx.SosNativeShell = { isNativeShell() { return true; } };
  }
  vm.createContext(ctx);
  vm.runInContext(read('key-storage.js'), ctx);
  return { ctx, localStorage, sessionStorage, idb, gen };
}

const k1 = makeFake();
const k2 = makeFake();

async function main() {
  // A legacy only → copy verified, legacy remains
  {
    const idb = makeIdb();
    const ls = makeStorage([['nostr_private_key', k1.hex]]);
    const { ctx, localStorage, idb: db } = load({ localStorage: ls, idb });
    await ctx.SOSKeyStorage.ready;
    record('A_LEGACY_COPY_KEEPS_PLAINTEXT',
      ctx.SOSKeyStorage.getProviderState() === 'WEB_SECURE_COPY_VERIFIED'
      && localStorage.getItem('nostr_private_key') === k1.hex
      && ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex
      && db.blob() && db.blob().pubkey === k1.pub
      && ctx.SOSKeyStorage.activeProviderName() === 'BrowserSecureProvider');
  }

  // B both same
  {
    const seeded = makeIdb();
    const first = load({ localStorage: makeStorage([['nostr_private_key', k1.hex]]), idb: seeded });
    await first.ctx.SOSKeyStorage.ready;
    const second = load({ localStorage: first.localStorage, idb: seeded });
    await second.ctx.SOSKeyStorage.ready;
    record('B_BOTH_SAME',
      second.ctx.SOSKeyStorage.getProviderState() === 'WEB_SECURE_COPY_VERIFIED'
      && first.localStorage.getItem('nostr_private_key') === k1.hex
      && second.ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex);
  }

  // C mismatch
  {
    const idb = makeIdb();
    const prep = load({ localStorage: makeStorage([['nostr_private_key', k2.hex]]), idb });
    await prep.ctx.SOSKeyStorage.ready;
    const blobBefore = prep.idb.blob();
    prep.localStorage.setItem('nostr_private_key', k1.hex);
    const next = load({ localStorage: prep.localStorage, idb });
    await next.ctx.SOSKeyStorage.ready;
    record('C_MISMATCH_UNCHANGED',
      next.ctx.SOSKeyStorage.getProviderState() === 'WEB_SECURE_MISMATCH'
      && next.ctx.SOSKeyStorage.readPrivateKeyRaw() === ''
      && next.localStorage.getItem('nostr_private_key') === k1.hex
      && next.idb.blob() === blobBefore
      && next.ctx.SOSKeyStorage.writePrivateKeyHex(k1.hex) === false);
  }

  // D secure only
  {
    const idb = makeIdb();
    const prep = load({ localStorage: makeStorage([['nostr_private_key', k1.hex]]), idb });
    await prep.ctx.SOSKeyStorage.ready;
    prep.localStorage.removeItem('nostr_private_key');
    const redirects = [];
    const slow = load({ localStorage: prep.localStorage, idb, delay: 1500 });
    slow.ctx.location = { replace(url) { redirects.push(url); } };
    vm.runInContext(read('auth-guard.js'), slow.ctx);
    record('J_GUARD_WAITS_BEFORE_READY', redirects.length === 0);
    await slow.ctx.SOSKeyStorage.ready;
    record('D_SECURE_ONLY_ACTIVE',
      slow.ctx.SOSKeyStorage.getProviderState() === 'WEB_SECURE_ACTIVE'
      && slow.ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex
      && redirects.length === 0
      && !slow.localStorage.getItem('nostr_private_key'));
  }

  // E corrupt secure + valid legacy
  {
    const idb = makeIdb();
    const prep = load({ localStorage: makeStorage([['nostr_private_key', k1.hex]]), idb });
    await prep.ctx.SOSKeyStorage.ready;
    const blob = prep.idb.blob();
    const originalCt = blob.ciphertext;
    blob.ciphertext = new Uint8Array([1, 2, 3, 4]);
    const next = load({ localStorage: prep.localStorage, idb });
    await next.ctx.SOSKeyStorage.ready;
    record('E_CORRUPT_SECURE_KEEPS_LEGACY',
      next.ctx.SOSKeyStorage.getProviderState() === 'WEB_SECURE_RECOVERY_REQUIRED'
      && next.localStorage.getItem('nostr_private_key') === k1.hex
      && next.idb.blob().ciphertext === blob.ciphertext
      && originalCt !== blob.ciphertext
      && next.ctx.SOSKeyStorage.readPrivateKeyRaw() === '');
  }

  // F corrupt legacy + valid secure
  {
    const idb = makeIdb();
    const prep = load({ localStorage: makeStorage([['nostr_private_key', k1.hex]]), idb });
    await prep.ctx.SOSKeyStorage.ready;
    prep.localStorage.setItem('nostr_private_key', 'corrupt');
    const next = load({ localStorage: prep.localStorage, idb });
    await next.ctx.SOSKeyStorage.ready;
    record('F_SECURE_KEEPS_CORRUPT_LEGACY',
      next.ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex
      && next.localStorage.getItem('nostr_private_key') === 'corrupt'
      && next.ctx.SOSKeyStorage.getProviderState() === 'WEB_SECURE_ACTIVE');
  }

  // G H I fallbacks
  {
    const ls = makeStorage([['nostr_private_key', k1.hex]]);
    const noIdb = load({ localStorage: ls, fail: 'idb' });
    await noIdb.ctx.SOSKeyStorage.ready;
    record('G_NO_IDB_LEGACY',
      noIdb.ctx.SOSKeyStorage.activeProviderName() === 'LegacyProvider'
      && noIdb.localStorage.getItem('nostr_private_key') === k1.hex);
    const noSubtle = load({ localStorage: makeStorage([['nostr_private_key', k1.hex]]), fail: 'subtle', idb: makeIdb() });
    await noSubtle.ctx.SOSKeyStorage.ready;
    record('H_NO_SUBTLE_LEGACY',
      noSubtle.ctx.SOSKeyStorage.activeProviderName() === 'LegacyProvider'
      && noSubtle.idb.opens() === 0);
    const persist = load({
      localStorage: makeStorage([['nostr_private_key', k1.hex]]),
      idb: makeIdb(),
      fail: 'persist',
    });
    await persist.ctx.SOSKeyStorage.ready;
    record('I_PERSIST_FAIL_LEGACY',
      persist.ctx.SOSKeyStorage.activeProviderName() === 'LegacyProvider'
      && persist.localStorage.getItem('nostr_private_key') === k1.hex
      && persist.ctx.SOSKeyStorage.getProviderState() === 'WEB_SECURE_UNAVAILABLE');
  }

  // slow delays do not generate
  for (const delay of [0, 100, 500, 1500]) {
    const idb = makeIdb();
    const env = load({ localStorage: makeStorage([['nostr_private_key', k1.hex]]), idb, delay });
    await env.ctx.SOSKeyStorage.ready;
    record('SLOW_' + delay, env.gen.n === 0 && env.ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex);
  }

  // K one init
  {
    const env = load({ localStorage: makeStorage([['nostr_private_key', k1.hex]]), idb: makeIdb() });
    const p1 = env.ctx.SOSKeyStorage.initialize();
    const p2 = env.ctx.SOSKeyStorage.initialize();
    await p1;
    await p2;
    record('K_SINGLE_INIT', p1 === p2 && env.ctx.SOSKeyStorage.getInitCount() === 1);
  }

  // L create
  {
    const idb = makeIdb();
    const env = load({ idb });
    await env.ctx.SOSKeyStorage.ready;
    const ok = env.ctx.SOSKeyStorage.writePrivateKeyHex(k1.hex);
    await env.ctx.SOSKeyStorage.ready;
    record('L_CREATE_MIRROR',
      ok === true
      && env.gen.n === 0
      && env.localStorage.getItem('nostr_private_key') === k1.hex
      && env.ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex
      && env.idb.blob() && env.idb.blob().pubkey === k1.pub);
  }

  // M import / N invalid
  {
    const idb = makeIdb();
    const env = load({ localStorage: makeStorage([['nostr_private_key', k1.hex]]), idb });
    await env.ctx.SOSKeyStorage.ready;
    record('N_INVALID_IMPORT', env.ctx.SOSKeyStorage.writePrivateKeyRaw('nope') === false && env.localStorage.getItem('nostr_private_key') === k1.hex);
    env.ctx.SOSKeyStorage.clearPrivateKey();
    await env.ctx.SOSKeyStorage.ready;
    const ok = env.ctx.SOSKeyStorage.writePrivateKeyHex(k2.hex);
    await env.ctx.SOSKeyStorage.ready;
    record('M_IMPORT_TARGET',
      ok === true
      && env.localStorage.getItem('nostr_private_key') === k2.hex
      && env.ctx.SOSKeyStorage.readPrivateKeyHex() === k2.hex
      && env.idb.blob().pubkey === k2.pub);
  }

  // O logout then reload guest
  {
    const idb = makeIdb();
    const env = load({ localStorage: makeStorage([['nostr_private_key', k1.hex]]), idb });
    await env.ctx.SOSKeyStorage.ready;
    env.ctx.SOSKeyStorage.clearPrivateKey();
    await env.ctx.SOSKeyStorage.ready;
    record('O_LOGOUT_NO_REVIVE',
      !env.idb.blob()
      && !env.idb.wrap()
      && env.ctx.SOSKeyStorage.readPrivateKeyRaw() === ''
      && !env.localStorage.getItem('nostr_private_key'));
    const reloaded = load({ localStorage: env.localStorage, idb });
    await reloaded.ctx.SOSKeyStorage.ready;
    record('O_RELOAD_GUEST',
      reloaded.ctx.SOSKeyStorage.readPrivateKeyRaw() === ''
      && !reloaded.localStorage.getItem('nostr_private_key')
      && !reloaded.idb.blob());
  }

  // P switch
  {
    const idb = makeIdb();
    const env = load({ localStorage: makeStorage([['nostr_private_key', k1.hex]]), idb });
    await env.ctx.SOSKeyStorage.ready;
    env.ctx.SOSKeyStorage.clearPrivateKey();
    const ok = env.ctx.SOSKeyStorage.writePrivateKeyHex(k2.hex);
    await env.ctx.SOSKeyStorage.ready;
    record('P_SWITCH_NO_MIX',
      ok === true
      && env.ctx.SOSKeyStorage.readPrivateKeyHex() === k2.hex
      && env.localStorage.getItem('nostr_private_key') === k2.hex
      && env.idb.blob().pubkey === k2.pub
      && env.idb.blob().pubkey !== k1.pub);
  }

  // Q session only
  {
    const idb = makeIdb();
    const ls = makeStorage([['sos_session_only_key', '1']]);
    const ss = makeStorage();
    const env = load({ localStorage: ls, sessionStorage: ss, idb });
    await env.ctx.SOSKeyStorage.ready;
    const ok = env.ctx.SOSKeyStorage.writePrivateKeyHex(k1.hex);
    await env.ctx.SOSKeyStorage.ready;
    record('Q_SESSION_ONLY_NO_IDB',
      ok === true
      && env.ctx.SOSKeyStorage.activeProviderName() === 'SessionOnlyProvider'
      && !env.idb.blob()
      && !env.idb.wrap()
      && ss.getItem('nostr_private_key_ephemeral') === k1.hex
      && env.idb.opens() === 0);
  }

  // R android new
  {
    const idb = makeIdb();
    const store = { priv: k1.hex, pub: k1.pub };
    const env = load({ idb, native: 'new', nativeStore: store, localStorage: makeStorage() });
    await env.ctx.SOSKeyStorage.ready;
    record('R_ANDROID_NOT_BROWSER_SECURE',
      env.ctx.SOSKeyStorage.activeProviderName() === 'NativeSecureProvider'
      && env.idb.opens() === 0
      && !env.idb.blob());
  }

  // S old apk
  {
    const idb = makeIdb();
    const env = load({
      idb,
      native: 'old',
      localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    });
    await env.ctx.SOSKeyStorage.ready;
    record('S_OLD_APK_LEGACY',
      env.ctx.SOSKeyStorage.activeProviderName() === 'LegacyProvider'
      && env.localStorage.getItem('nostr_private_key') === k1.hex
      && env.idb.opens() === 0);
  }

  // T export
  {
    const idb = makeIdb();
    const env = load({ localStorage: makeStorage([['nostr_private_key', k1.hex]]), idb });
    await env.ctx.SOSKeyStorage.ready;
    record('T_EXPORT',
      env.ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex
      && env.localStorage.getItem('nostr_private_key') === k1.hex);
  }

  record('U_ZERO_GENERATION', !/generateSecretKey|generateAndStoreKey|createNewIdentityExplicit/.test(read('key-storage.js')));
  record('NO_MIGRATION_DELETE', /browserLegacyDeletePerformed = false/.test(read('key-storage.js')) && /AAD_TEXT = 'SOS\\|browser-identity\\|v1'/.test(read('key-storage.js')));

  const appFiles = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'android-shell', 'qa'].includes(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(js|html)$/.test(ent.name) && ent.name !== 'key-storage.js') appFiles.push(p);
    }
  }
  walk(root);
  const bypass = appFiles.filter((p) => fs.readFileSync(p, 'utf8').includes('nostr_private_key'));
  record('V_DIRECT_BYPASS_0', bypass.length === 0, bypass.map((p) => path.relative(root, p)).join(','));

  const failed = results.filter((r) => !r.ok);
  console.log('---');
  console.log('TOTAL ' + results.length + ' PASS ' + (results.length - failed.length) + ' FAIL ' + failed.length);
  if (failed.length) {
    console.log('FAILED: ' + failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
  console.log('STATUS=PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
