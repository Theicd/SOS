#!/usr/bin/env node
/**
 * Stage 5E-E2B2B-I2: pending enabled, deletion stays off.
 * Run: node qa/identity-browser-secure-cutover-gate.mjs
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
    dropBlob() { stores.identity_blob.delete('current'); },
    dropWrap() { stores.wrapping_key.delete('v1'); },
  };
}

function load(options = {}) {
  const localStorage = options.localStorage || makeStorage();
  const sessionStorage = options.sessionStorage || makeStorage();
  const idb = options.idb || null;
  const gen = { n: 0 };
  const listeners = [];
  const pageName = String(options.page || 'index.html');
  const moduleNames = options.modules || [
    'key-storage.js',
    'identity-storage-bootstrap.js',
    'auth-guard.js',
    'config.js',
    'keys.js',
    'app.js',
    'identity-lifecycle.js',
    'account.js',
    'key-viewer.js',
  ];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    indexedDB: idb ? idb.indexedDB : undefined,
    navigator: {
      storage: {
        async persisted() { return options.persisted === true; },
        async persist() { return options.persisted === true; },
      },
      serviceWorker: {
        controller: options.controller ? { scriptURL: 'service-worker.js' } : null,
        addEventListener(_type, fn) { listeners.push(fn); },
      },
    },
    location: {
      pathname: '/' + pageName,
      href: 'http://127.0.0.1/' + pageName,
      replace() {},
    },
    window: null,
    localStorage,
    sessionStorage,
    NostrTools: {
      getPublicKey,
      generateSecretKey() { gen.n += 1; return generateSecretKey(); },
    },
  };
  ctx.window = ctx;
  const version = 'browser-secure-cutover-v1';
  ctx.SOSIdentityStorageGeneration = {};
  moduleNames.forEach((name) => {
    ctx.SOSIdentityStorageGeneration[name] = version;
  });
  if (options.generationPatch && options.generationPatch.mismatch) {
    ctx.SOSIdentityStorageGeneration[options.generationPatch.mismatch] = 'old-cache';
  }
  if (options.generationPatch && options.generationPatch.omit) {
    delete ctx.SOSIdentityStorageGeneration[options.generationPatch.omit];
  }
  if (options.generationPatch && options.generationPatch.extra) {
    Object.keys(options.generationPatch.extra).forEach((name) => {
      ctx.SOSIdentityStorageGeneration[name] = options.generationPatch.extra[name];
    });
  }
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
  return { ctx, localStorage, sessionStorage, idb, gen, listeners };
}

function fillGeneration(ctx, patch) {
  const version = 'browser-secure-cutover-v1';
  ctx.SOSKeyStorage.REQUIRED_IDENTITY_MODULES.forEach((name) => {
    ctx.SOSIdentityStorageGeneration[name] = version;
  });
  if (patch && patch.mismatch) ctx.SOSIdentityStorageGeneration[patch.mismatch] = 'old-cache';
  if (patch && patch.omit) delete ctx.SOSIdentityStorageGeneration[patch.omit];
}

const k1 = makeFake();
const k2 = makeFake();
const MARKER = 'sos_browser_secure_cutover';

function markerOf(storage) {
  try { return JSON.parse(storage.getItem(MARKER) || 'null'); } catch (_e) { return null; }
}

async function main() {
  const boot1Idb = makeIdb();
  const boot1 = load({
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: boot1Idb,
    controller: true,
    persisted: true,
  });
  await boot1.ctx.SOSKeyStorage.ready;
  const flags = boot1.ctx.SOSKeyStorage.getCutoverFlags();
  const pending = markerOf(boot1.localStorage);
  record('A_FLAGS',
    flags.CUTOVER_PENDING_FLAG === true
    && flags.CUTOVER_DELETE_FLAG === false
    && flags.LEGACY_DELETE_ALLOWED === false
    && flags.BROWSER_LEGACY_WRITE_DISABLED === false);
  record('B_BOOT_N_PENDING',
    pending && pending.state === 'pending'
    && pending.publicKey === k1.pub
    && pending.codeVersion === 'browser-secure-cutover-v1'
    && boot1.localStorage.getItem('nostr_private_key') === k1.hex);
  record('C_PENDING_BOOT_ID',
    pending.pendingBootId === flags.currentBootId
    && pending.pendingBootId.length > 0);
  const sameBoot = await boot1.ctx.SOSKeyStorage.evaluateBootNPlusOneCutover();
  const pendingAfterSame = markerOf(boot1.localStorage);
  record('D_SAME_BOOT_BLOCKED',
    sameBoot.state === 'WEB_SECURE_CUTOVER_BLOCKED'
    && sameBoot.reasons.indexOf('SAME_BOOT') !== -1
    && pendingAfterSame.state === 'pending');
  record('F_LEGACY_AFTER_PENDING', boot1.localStorage.getItem('nostr_private_key') === k1.hex);
  const beforeRepeat = markerOf(boot1.localStorage);
  const again = await boot1.ctx.SOSKeyStorage.markBrowserCutoverPendingIfEnabled();
  const afterRepeat = markerOf(boot1.localStorage);
  record('J_PENDING_IDEMPOTENT',
    again.result === 'WEB_SECURE_CUTOVER_PENDING_EXISTS'
    && again.mutated === false
    && afterRepeat.pendingBootId === beforeRepeat.pendingBootId
    && afterRepeat.pendingAt === beforeRepeat.pendingAt
    && boot1.localStorage.getItem('nostr_private_key') === k1.hex);

  const boot2 = load({
    localStorage: boot1.localStorage,
    idb: boot1Idb,
    controller: true,
    persisted: true,
  });
  await boot2.ctx.SOSKeyStorage.ready;
  const verified = markerOf(boot2.localStorage);
  record('E_BOOT_N1_VERIFIED',
    verified.state === 'verified'
    && boot2.ctx.SOSKeyStorage.getCutoverFlags().currentBootId !== pending.pendingBootId);
  record('G_LEGACY_AFTER_VERIFIED', boot2.localStorage.getItem('nostr_private_key') === k1.hex);
  record('H_DELETE_STILL_FALSE', boot2.ctx.SOSKeyStorage.canDeleteBrowserLegacySecret() === false);
  record('U_SECOND_TAB_DOES_NOT_RESET_PENDING',
    verified.pendingBootId === pending.pendingBootId
    && verified.pendingAt === pending.pendingAt);
  record('AB_K_PRESERVED',
    boot2.ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex
    && boot1.gen.n === 0
    && boot2.gen.n === 0);

  const switched = load({
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  await switched.ctx.SOSKeyStorage.ready;
  const p1Boot = markerOf(switched.localStorage).pendingBootId;
  const wrote = switched.ctx.SOSKeyStorage.writePrivateKeyHex(k2.hex);
  await switched.ctx.SOSKeyStorage.ready;
  const afterSwitch = markerOf(switched.localStorage);
  record('K_SWITCH_CLEARS_OLD_PENDING',
    wrote === true
    && (!afterSwitch || afterSwitch.publicKey !== k1.pub)
    && (!afterSwitch || afterSwitch.pendingBootId !== p1Boot)
    && switched.localStorage.getItem('nostr_private_key') === k2.hex
    && switched.idb.blob().pubkey === k2.pub);

  const logoutIdb = makeIdb();
  const logout = load({
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: logoutIdb,
    controller: true,
    persisted: true,
  });
  await logout.ctx.SOSKeyStorage.ready;
  logout.ctx.SOSKeyStorage.clearPrivateKey();
  await logout.ctx.SOSKeyStorage.ready;
  const guest = load({
    localStorage: logout.localStorage,
    idb: logoutIdb,
    controller: true,
    persisted: true,
  });
  await guest.ctx.SOSKeyStorage.ready;
  record('L_LOGOUT_CLEARS_PENDING',
    !logout.localStorage.getItem(MARKER)
    && !guest.localStorage.getItem(MARKER)
    && guest.ctx.SOSKeyStorage.readPrivateKeyRaw() === ''
    && guest.ctx.SOSKeyStorage.getProviderState() !== 'WEB_SECURE_RECOVERY_REQUIRED');

  const lossIdb = makeIdb();
  const lossBoot = load({
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: lossIdb,
    controller: true,
    persisted: true,
  });
  await lossBoot.ctx.SOSKeyStorage.ready;
  lossIdb.dropBlob();
  const lossNext = load({
    localStorage: lossBoot.localStorage,
    idb: lossIdb,
    controller: true,
    persisted: true,
  });
  await lossNext.ctx.SOSKeyStorage.ready;
  record('M_BLOB_LOSS_RECOVERY',
    lossNext.ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex
    && lossNext.localStorage.getItem('nostr_private_key') === k1.hex
    && lossNext.ctx.SOSKeyStorage.getProviderState() === 'WEB_SECURE_COPY_VERIFIED'
    && markerOf(lossNext.localStorage).state !== 'complete'
    && lossNext.ctx.SOSKeyStorage.canDeleteBrowserLegacySecret() === false
    && lossNext.gen.n === 0
    && !!lossNext.idb.blob());

  const keyLossIdb = makeIdb();
  const keyLossBoot = load({
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: keyLossIdb,
    controller: true,
    persisted: true,
  });
  await keyLossBoot.ctx.SOSKeyStorage.ready;
  keyLossIdb.dropWrap();
  const keyLossNext = load({
    localStorage: keyLossBoot.localStorage,
    idb: keyLossIdb,
    controller: true,
    persisted: true,
  });
  await keyLossNext.ctx.SOSKeyStorage.ready;
  record('N_WRAP_LOSS_RECOVERY',
    keyLossNext.ctx.SOSKeyStorage.getProviderState() === 'WEB_SECURE_RECOVERY_REQUIRED'
    && keyLossNext.localStorage.getItem('nostr_private_key') === k1.hex
    && markerOf(keyLossNext.localStorage).state === 'pending'
    && keyLossNext.gen.n === 0);

  const persistBoot = load({
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  await persistBoot.ctx.SOSKeyStorage.ready;
  const persistNext = load({
    localStorage: persistBoot.localStorage,
    idb: persistBoot.idb,
    controller: true,
    persisted: false,
  });
  await persistNext.ctx.SOSKeyStorage.ready;
  const persistMarker = markerOf(persistNext.localStorage);
  record('O_PERSISTED_FALSE_ALLOWS_VERIFIED',
    persistMarker && persistMarker.state === 'verified'
    && persistNext.localStorage.getItem('nostr_private_key') === k1.hex
    && persistNext.ctx.SOSKeyStorage.canDeleteBrowserLegacySecret() === false
    && persistNext.ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex);

  const genBoot = load({
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  await genBoot.ctx.SOSKeyStorage.ready;
  const genNext = load({
    localStorage: genBoot.localStorage,
    idb: genBoot.idb,
    controller: true,
    persisted: true,
    generationPatch: { mismatch: 'auth-guard.js' },
  });
  await genNext.ctx.SOSKeyStorage.ready;
  const genCheck = await genNext.ctx.SOSKeyStorage.evaluateBootNPlusOneCutover();
  record('P_GENERATION_MISMATCH_BLOCKS',
    markerOf(genNext.localStorage).state === 'pending'
    && genCheck.reasons.indexOf('CODE_GENERATION_MISMATCH') !== -1
    && genNext.localStorage.getItem('nostr_private_key') === k1.hex
    && genNext.ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex);

  const ctrlBoot = load({
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  await ctrlBoot.ctx.SOSKeyStorage.ready;
  const ctrlNext = load({
    localStorage: ctrlBoot.localStorage,
    idb: ctrlBoot.idb,
    controller: true,
    persisted: true,
  });
  ctrlNext.listeners.forEach((fn) => fn());
  await ctrlNext.ctx.SOSKeyStorage.ready;
  const ctrlCheck = await ctrlNext.ctx.SOSKeyStorage.evaluateBootNPlusOneCutover();
  record('Q_CONTROLLER_UNSAFE_BLOCKS',
    markerOf(ctrlNext.localStorage).state === 'pending'
    && ctrlCheck.reasons.indexOf('CONTROLLER_UNSAFE') !== -1
    && ctrlNext.localStorage.getItem('nostr_private_key') === k1.hex);

  const tamperBoot = load({
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  await tamperBoot.ctx.SOSKeyStorage.ready;
  const blobBefore = tamperBoot.idb.blob();
  tamperBoot.localStorage.setItem('nostr_private_key', k2.hex);
  const tamperNext = load({
    localStorage: tamperBoot.localStorage,
    idb: tamperBoot.idb,
    controller: true,
    persisted: true,
  });
  await tamperNext.ctx.SOSKeyStorage.ready;
  record('R_LEGACY_TAMPER_MISMATCH',
    tamperNext.ctx.SOSKeyStorage.getProviderState() === 'WEB_SECURE_MISMATCH'
    && markerOf(tamperNext.localStorage).state === 'pending'
    && tamperNext.localStorage.getItem('nostr_private_key') === k2.hex
    && tamperNext.idb.blob() === blobBefore);

  const fakeBoot = load({
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  await fakeBoot.ctx.SOSKeyStorage.ready;
  const fake = markerOf(fakeBoot.localStorage);
  fake.publicKey = k2.pub;
  fake.state = 'pending';
  fakeBoot.localStorage.setItem(MARKER, JSON.stringify(fake));
  const fakeNext = load({
    localStorage: fakeBoot.localStorage,
    idb: fakeBoot.idb,
    controller: true,
    persisted: true,
  });
  await fakeNext.ctx.SOSKeyStorage.ready;
  const fakeCheck = await fakeNext.ctx.SOSKeyStorage.evaluateBootNPlusOneCutover();
  record('S_FAKE_PENDING_PUBKEY',
    markerOf(fakeNext.localStorage).publicKey === k2.pub
    && markerOf(fakeNext.localStorage).state !== 'verified'
    && markerOf(fakeNext.localStorage).state !== 'complete'
    && fakeCheck.state === 'WEB_SECURE_CUTOVER_BLOCKED'
    && fakeNext.localStorage.getItem('nostr_private_key') === k1.hex);

  const absentBoot = load({
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  await absentBoot.ctx.SOSKeyStorage.ready;
  absentBoot.localStorage.removeItem('nostr_private_key');
  const absentNext = load({
    localStorage: absentBoot.localStorage,
    idb: absentBoot.idb,
    controller: true,
    persisted: true,
  });
  await absentNext.ctx.SOSKeyStorage.ready;
  const absentMarker = markerOf(absentNext.localStorage);
  record('T_LEGACY_ABSENT_NOT_COMPLETE',
    absentNext.ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex
    && !absentNext.localStorage.getItem('nostr_private_key')
    && absentMarker
    && absentMarker.state !== 'complete'
    && absentMarker.state !== 'verified');

  const sessionIdb = makeIdb();
  const session = load({
    localStorage: makeStorage([['sos_session_only_key', '1']]),
    sessionStorage: makeStorage(),
    idb: sessionIdb,
    controller: true,
    persisted: true,
  });
  await session.ctx.SOSKeyStorage.ready;
  session.ctx.SOSKeyStorage.writePrivateKeyHex(k1.hex);
  await session.ctx.SOSKeyStorage.ready;
  record('V_SESSION_ONLY_NO_PENDING',
    !session.localStorage.getItem(MARKER)
    && !sessionIdb.blob()
    && sessionIdb.opens() === 0);

  const androidIdb = makeIdb();
  const android = load({
    idb: androidIdb,
    native: 'new',
    nativeStore: { priv: k1.hex, pub: k1.pub },
    localStorage: makeStorage(),
    controller: true,
    persisted: true,
  });
  await android.ctx.SOSKeyStorage.ready;
  record('W_ANDROID_NO_PENDING',
    !android.localStorage.getItem(MARKER)
    && android.ctx.SOSKeyStorage.activeProviderName() === 'NativeSecureProvider'
    && androidIdb.opens() === 0);

  const oldIdb = makeIdb();
  const oldApk = load({
    idb: oldIdb,
    native: 'old',
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    controller: true,
    persisted: true,
  });
  await oldApk.ctx.SOSKeyStorage.ready;
  record('X_OLD_APK_NO_PENDING',
    !oldApk.localStorage.getItem(MARKER)
    && oldApk.ctx.SOSKeyStorage.activeProviderName() === 'LegacyProvider'
    && oldApk.localStorage.getItem('nostr_private_key') === k1.hex
    && oldIdb.opens() === 0);

  const unsupported = load({
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: null,
    controller: true,
    persisted: true,
  });
  await unsupported.ctx.SOSKeyStorage.ready;
  record('Y_UNSUPPORTED_NO_PENDING',
    unsupported.ctx.SOSKeyStorage.activeProviderName() === 'LegacyProvider'
    && !unsupported.localStorage.getItem(MARKER)
    && unsupported.localStorage.getItem('nostr_private_key') === k1.hex);

  const ephemeral = load({
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: false,
  });
  await ephemeral.ctx.SOSKeyStorage.ready;
  const ephemeralMarker = markerOf(ephemeral.localStorage);
  const ephemeralEnv = await ephemeral.ctx.SOSKeyStorage.isBrowserCutoverEnvironmentSafe();
  record('Z_PERSISTED_FALSE_ALLOWS_PENDING',
    ephemeralMarker && ephemeralMarker.state === 'pending'
    && ephemeral.localStorage.getItem('nostr_private_key') === k1.hex
    && ephemeral.ctx.SOSKeyStorage.readPrivateKeyHex() === k1.hex
    && ephemeral.ctx.SOSKeyStorage.canDeleteBrowserLegacySecret() === false
    && ephemeralEnv.reasons.indexOf('STORAGE_NOT_PERSISTED') === -1);

  const futureBlocked = await ephemeral.ctx.SOSKeyStorage.evaluateFutureBrowserLegacyDeleteEligibility();
  const futureAllowedPersist = load({
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  await futureAllowedPersist.ctx.SOSKeyStorage.ready;
  const futureStillBlocked = await futureAllowedPersist.ctx.SOSKeyStorage.evaluateFutureBrowserLegacyDeleteEligibility();
  record('AN_FUTURE_DELETE_REQUIRES_PERSISTENCE',
    futureBlocked.persistenceRequired === true
    && futureBlocked.eligible === false
    && futureBlocked.persisted === false
    && futureBlocked.reasons.indexOf('STORAGE_NOT_PERSISTED') !== -1
    && futureStillBlocked.eligible === false
    && futureStillBlocked.persisted === true
    && futureStillBlocked.reasons.indexOf('STORAGE_NOT_PERSISTED') === -1
    && futureStillBlocked.reasons.indexOf('DELETE_FLAG_FALSE') !== -1
    && futureAllowedPersist.ctx.SOSKeyStorage.canDeleteBrowserLegacySecret() === false
    && futureAllowedPersist.localStorage.getItem('nostr_private_key') === k1.hex);

  const empty = load({
    localStorage: makeStorage(),
    idb: makeIdb(),
    controller: true,
    persisted: false,
  });
  await empty.ctx.SOSKeyStorage.ready;
  record('AO_BOTH_ABSENT_GUEST',
    empty.ctx.SOSKeyStorage.readPrivateKeyRaw() === ''
    && empty.gen.n === 0
    && !empty.localStorage.getItem(MARKER));

  const src = read('key-storage.js');
  const start = src.indexOf('/* CUTOVER_I1_START */');
  const end = src.indexOf('/* CUTOVER_I1_END */');
  const region = start >= 0 && end > start ? src.slice(start, end) : '';
  record('I_COMPLETE_UNREACHABLE',
    region.length > 0
    && !/state:\s*'complete'/.test(region)
    && !/state\s*=\s*'complete'/.test(region));
  record('AA_NO_GENERATION', !/generateSecretKey|generateAndStoreKey|createNewIdentityExplicit/.test(src));
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
  record('AC_DIRECT_BYPASS_0', bypass.length === 0, bypass.map((p) => path.relative(root, p)).join(','));
  record('AD_NO_CUTOVER_REMOVEITEM',
    region.length > 0
    && !region.includes('removeItem')
    && /const BROWSER_SECURE_CUTOVER_PENDING = true/.test(src)
    && /const BROWSER_SECURE_CUTOVER_DELETE_LEGACY = false/.test(src)
    && /function canDeleteBrowserLegacySecret\(\) \{\s*return false;\s*\}/.test(src)
    && src.includes('localStorage.setItem(LS, pair.priv)'));

  const videosModules = [
    'key-storage.js',
    'identity-storage-bootstrap.js',
    'config.js',
    'keys.js',
    'identity-lifecycle.js',
    'account.js',
    'key-viewer.js',
    'app.js',
  ];
  const videosOk = load({
    page: 'videos.html',
    modules: videosModules,
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  await videosOk.ctx.SOSKeyStorage.ready;
  const videosGen = videosOk.ctx.SOSKeyStorage.verifyIdentityStorageCodeGeneration();
  const videosMarker = markerOf(videosOk.localStorage);
  record('AE_VIDEOS_GENERATION_OK_WITHOUT_AUTH_GUARD',
    videosGen.result === 'CODE_GENERATION_OK'
    && videosGen.page === 'videos.html'
    && videosModules.indexOf('auth-guard.js') === -1
    && videosMarker && videosMarker.state === 'pending'
    && videosOk.localStorage.getItem('nostr_private_key') === k1.hex);

  const videosMissing = load({
    page: 'videos.html',
    modules: videosModules.filter((name) => name !== 'app.js'),
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  await videosMissing.ctx.SOSKeyStorage.ready;
  const missingGen = videosMissing.ctx.SOSKeyStorage.verifyIdentityStorageCodeGeneration();
  record('AF_VIDEOS_MISSING_MODULE_INCOMPLETE',
    missingGen.result === 'CODE_GENERATION_INCOMPLETE'
    && missingGen.missing.indexOf('app.js') !== -1
    && !videosMissing.localStorage.getItem(MARKER)
    && videosMissing.localStorage.getItem('nostr_private_key') === k1.hex);

  const videosMismatch = load({
    page: 'videos.html',
    modules: videosModules,
    generationPatch: { mismatch: 'app.js' },
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  await videosMismatch.ctx.SOSKeyStorage.ready;
  const mismatchGen = videosMismatch.ctx.SOSKeyStorage.verifyIdentityStorageCodeGeneration();
  record('AG_VIDEOS_WRONG_GENERATION_MISMATCH',
    mismatchGen.result === 'CODE_GENERATION_MISMATCH'
    && mismatchGen.mismatch.indexOf('app.js') !== -1
    && !videosMismatch.localStorage.getItem(MARKER));

  const videosMixed = load({
    page: 'videos.html',
    modules: videosModules,
    generationPatch: { extra: { 'auth-guard.js': 'old-cache' } },
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  await videosMixed.ctx.SOSKeyStorage.ready;
  const mixedGen = videosMixed.ctx.SOSKeyStorage.verifyIdentityStorageCodeGeneration();
  record('AH_VIDEOS_MIXED_GENERATION_FAILS',
    mixedGen.result === 'CODE_GENERATION_MISMATCH'
    && mixedGen.mismatch.indexOf('auth-guard.js') !== -1
    && !videosMixed.localStorage.getItem(MARKER));

  const indexNoGuard = load({
    page: 'index.html',
    modules: videosModules,
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  await indexNoGuard.ctx.SOSKeyStorage.ready;
  const indexGen = indexNoGuard.ctx.SOSKeyStorage.verifyIdentityStorageCodeGeneration();
  record('AI_INDEX_REQUIRES_AUTH_GUARD',
    indexGen.result === 'CODE_GENERATION_INCOMPLETE'
    && indexGen.missing.indexOf('auth-guard.js') !== -1
    && !indexNoGuard.localStorage.getItem(MARKER));

  const profileNoGuard = load({
    page: 'profile.html',
    modules: ['key-storage.js', 'identity-storage-bootstrap.js', 'app.js', 'config.js', 'keys.js'],
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  await profileNoGuard.ctx.SOSKeyStorage.ready;
  const profileGen = profileNoGuard.ctx.SOSKeyStorage.verifyIdentityStorageCodeGeneration();
  record('AJ_PROFILE_REQUIRES_AUTH_GUARD',
    profileGen.result === 'CODE_GENERATION_INCOMPLETE'
    && profileGen.missing.indexOf('auth-guard.js') !== -1);

  const viewerNoGuard = load({
    page: 'profile-viewer.html',
    modules: ['key-storage.js', 'identity-storage-bootstrap.js', 'config.js', 'keys.js'],
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  await viewerNoGuard.ctx.SOSKeyStorage.ready;
  const viewerGen = viewerNoGuard.ctx.SOSKeyStorage.verifyIdentityStorageCodeGeneration();
  record('AK_PROFILE_VIEWER_REQUIRES_AUTH_GUARD',
    viewerGen.result === 'CODE_GENERATION_INCOMPLETE'
    && viewerGen.missing.indexOf('auth-guard.js') !== -1);

  const unknown = load({
    page: 'unknown-page.html',
    modules: videosModules,
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  await unknown.ctx.SOSKeyStorage.ready;
  const unknownGen = unknown.ctx.SOSKeyStorage.verifyIdentityStorageCodeGeneration();
  record('AL_UNDECLARED_PAGE_INCOMPLETE',
    unknownGen.result === 'CODE_GENERATION_INCOMPLETE'
    && unknownGen.missing.indexOf('UNDECLARED_PAGE') !== -1
    && !unknown.localStorage.getItem(MARKER));

  const rewritten = load({
    page: 'index.html',
    modules: videosModules,
    localStorage: makeStorage([['nostr_private_key', k1.hex]]),
    idb: makeIdb(),
    controller: true,
    persisted: true,
  });
  rewritten.ctx.document = {
    body: { classList: { contains(name) { return name === 'videos-page'; } } },
  };
  const rewrittenGen = rewritten.ctx.SOSKeyStorage.verifyIdentityStorageCodeGeneration();
  record('AM_VIDEOS_URL_REWRITE_USES_VIDEOS_SET',
    rewrittenGen.result === 'CODE_GENERATION_OK'
    && rewrittenGen.page === 'videos.html');

  const failed = results.filter((row) => !row.ok);
  console.log('---');
  console.log('TOTAL ' + results.length + ' PASS ' + (results.length - failed.length) + ' FAIL ' + failed.length);
  if (failed.length) {
    console.log('FAILED: ' + failed.map((row) => row.name).join(', '));
    process.exit(1);
  }
  console.log('STATUS=PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

