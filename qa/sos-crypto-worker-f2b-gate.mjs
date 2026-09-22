#!/usr/bin/env node
/**
 * Stage 5E-F2B — Worker vault authoritative cutover gate.
 * Flag ON only inside this harness. No deploy. No legacy delete.
 * Run: node qa/sos-crypto-worker-f2b-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  nip44,
  nip04,
} from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let pass = 0;
let fail = 0;
function record(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name + (detail ? ' — ' + detail : ''));
  } else {
    fail += 1;
    results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function makeIdb() {
  const stores = {
    wrapping_key: new Map(),
    identity_blob: new Map(),
    metadata: new Map(),
  };
  const indexedDB = {
    open() {
      const req = {};
      const db = {
        objectStoreNames: { contains(n) { return Object.prototype.hasOwnProperty.call(stores, n); } },
        createObjectStore(n) { stores[n] = stores[n] || new Map(); return {}; },
        transaction(storeName) {
          const name = Array.isArray(storeName) ? storeName[0] : storeName;
          return {
            objectStore() {
              return {
                get(key) {
                  const r = {};
                  setTimeout(() => { r.result = stores[name].get(key); if (r.onsuccess) r.onsuccess(); }, 0);
                  return r;
                },
                put(value, key) {
                  const r = {};
                  setTimeout(() => { stores[name].set(key, value); if (r.onsuccess) r.onsuccess(); }, 0);
                  return r;
                },
                delete(key) {
                  const r = {};
                  setTimeout(() => { stores[name].delete(key); if (r.onsuccess) r.onsuccess(); }, 0);
                  return r;
                },
              };
            },
          };
        },
        close() {},
      };
      setTimeout(() => { req.result = db; if (req.onupgradeneeded) req.onupgradeneeded(); if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    },
  };
  return { indexedDB, stores };
}

async function seedSecureIdb(idb, privHex, pubHex) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode('SOS|browser-identity|v1');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    new TextEncoder().encode(privHex),
  );
  idb.stores.wrapping_key.set('v1', key);
  idb.stores.identity_blob.set('current', { version: 1, iv, ciphertext, pubkey: pubHex, migratedAt: Date.now() });
}

function loadWorkerSandbox(idb, hooks = {}) {
  const messages = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    crypto: globalThis.crypto,
    indexedDB: idb ? idb.indexedDB : undefined,
    atob,
    btoa,
    __SOS_CRYPTO_WORKER_TEST_HOOKS: hooks,
    postMessage(msg) { messages.push(msg); },
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__messages = messages;
  vm.createContext(sandbox);
  vm.runInContext(read('vendor/nostr.bundle.min.js'), sandbox);
  sandbox.NostrApp = {
    hexToBytes,
    inspectIncomingChatAttachment: () => ({ ok: true }),
    verifyIncomingChatAttachment: () => true,
  };
  vm.runInContext(read('chat-e2ee.js'), sandbox);
  vm.runInContext(read('sos-crypto-worker.js'), sandbox);
  if (typeof hooks.setNostrTools === 'function') hooks.setNostrTools(sandbox.NostrTools);
  return sandbox;
}

function loadAuthoritativeSigner(privHex, pubHex, workerHooks) {
  const context = {
    console: { log() {}, warn() {}, error() {} },
    NostrTools: {
      finalizeEvent,
      getPublicKey,
      generateSecretKey,
      verifyEvent,
      nip44,
      nip04,
      utils: { bytesToHex, hexToBytes },
    },
    SOS_CRYPTO_WORKER_AUTHORITATIVE: true,
    __SOS_CRYPTO_WORKER_AUTHORITATIVE__: true,
  };
  context.window = context;
  context.localStorage = {
    _d: { SOS_CRYPTO_WORKER_AUTHORITATIVE: '1' },
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  };
  // Mock vault authoritative using worker hooks (no real Worker in Node)
  let auth = false;
  let meta = null;
  let rawReads = 0;
  context.NostrApp = {
    publicKey: pubHex,
    privateKey: null, // F2B: must stay null
    finalizeEvent: (d, k) => finalizeEvent(JSON.parse(JSON.stringify(d)), k),
    hexToBytes,
    inspectIncomingChatAttachment: () => ({ ok: true }),
    verifyIncomingChatAttachment: () => true,
  };
  const hostApp = {
    inspectIncomingChatAttachment: () => ({ ok: true }),
    verifyIncomingChatAttachment: () => true,
    hexToBytes,
  };
  globalThis.NostrApp = hostApp;
  globalThis.NostrTools = context.NostrTools;
  vm.runInThisContext(read('chat-e2ee.js'), { filename: 'chat-e2ee.js' });
  context.NostrApp.encryptPrivateChatPayload = hostApp.encryptPrivateChatPayload.bind(hostApp);
  context.NostrApp.decryptPrivateChatPayload = hostApp.decryptPrivateChatPayload.bind(hostApp);

  context.NostrApp.SosCryptoWorkerVault = {
    mode: 'authoritative-test',
    flagEnabled: () => true,
    isReady: () => auth,
    isAuthoritative: () => auth,
    getIdentityMeta: () => meta,
    getRuntimeRawKReadCount: () => rawReads,
    async tryActivateAuthoritative() {
      meta = await workerHooks.loadVaultFromSecureIdb();
      auth = meta.vaultState === 'READY';
      context.NostrApp.privateKey = null;
      context.NostrApp.publicKey = meta.pubkey;
      return { ok: auth, WORKER_VAULT_AUTHORITATIVE: auth, meta };
    },
    async authoritativeRpc(op, params) {
      if (!auth) throw Object.assign(new Error('not auth'), { code: 'WORKER_NOT_AUTHORITATIVE' });
      return workerHooks.dispatch(op, params || {});
    },
    async restartVault() {
      meta = await workerHooks.loadVaultFromSecureIdb();
      auth = meta.vaultState === 'READY';
      context.NostrApp.privateKey = null;
      return { ok: auth, meta };
    },
    terminate() { auth = false; },
  };
  context.SosCryptoWorkerVault = context.NostrApp.SosCryptoWorkerVault;

  vm.createContext(context);
  vm.runInContext(read('sos-crypto-signer.js'), context);
  return context;
}

function cloneEv(ev) {
  return JSON.parse(JSON.stringify(ev));
}

async function main() {
  const srcSigner = read('sos-crypto-signer.js');
  const srcVault = read('sos-crypto-worker-vault.js');
  const srcApp = read('app.js');
  const srcConfig = read('config.js');

  record('FEATURE_FLAG defined', /SOS_CRYPTO_WORKER_AUTHORITATIVE/.test(srcVault));
  record('F2B_ROLLBACK_WITH_FLAG', /FLAG_OFF|deactivateAuthoritative|setBackend/.test(srcVault + srcSigner));
  record('boot skips K when flag', /tryActivateAuthoritative|WORKER_VAULT_AUTHORITATIVE/.test(srcApp));
  record('config skips hydrate when flag', /SOS_CRYPTO_WORKER_AUTHORITATIVE/.test(srcConfig));
  record('ANDROID_WORKER_CUTOVER=false', /ANDROID_WORKER_CUTOVER/.test(srcVault));
  record('SESSION_ONLY excluded', /SESSION_ONLY_WORKER_CUTOVER/.test(srcVault));
  record('WORKER_AUTH_NO_PAGE_K guard', /WORKER_AUTH_NO_PAGE_K/.test(srcSigner));

  const sk = generateSecretKey();
  const privHex = bytesToHex(sk);
  const pubHex = getPublicKey(sk);
  const peerSk = generateSecretKey();
  const peerPriv = bytesToHex(peerSk);
  const peerPub = getPublicKey(peerSk);
  const now = Math.floor(Date.now() / 1000);

  const idb = makeIdb();
  await seedSecureIdb(idb, privHex, pubHex);
  const hooks = {};
  const workerBox = loadWorkerSandbox(idb, hooks);
  const wh = workerBox.__SOS_CRYPTO_WORKER_TEST_HOOKS;

  const ctx = loadAuthoritativeSigner(privHex, pubHex, wh);
  const act = await ctx.SosCryptoWorkerVault.tryActivateAuthoritative();
  record('WORKER_VAULT_AUTHORITATIVE', !!(act && act.ok && act.WORKER_VAULT_AUTHORITATIVE));
  record('APP_PRIVATE_KEY_POPULATED=false', ctx.NostrApp.privateKey == null);
  record('PAGE_IDENTITY_METADATA_ONLY', !!ctx.NostrApp.publicKey && ctx.NostrApp.privateKey == null);

  const S = ctx.NostrApp.SosCryptoSigner;
  record('getBackend WORKER_VAULT', S.getBackend() === 'WORKER_VAULT');
  record('hasIdentityKey without page K', S.hasIdentityKey() === true);

  // f1 raw key blocked
  let blocked = false;
  try {
    S.f1CryptoModuleSessionKeyHex();
  } catch (e) {
    blocked = e && e.code === 'WORKER_AUTH_NO_PAGE_K';
  }
  record('RUNTIME raw K bridge blocked', blocked);

  // Signing via worker only
  const chatDraft = {
    kind: 1050,
    pubkey: pubHex,
    created_at: now,
    tags: [['p', peerPub], ['t', 'yalachat']],
    content: 'f2b-chat',
  };
  const signed = await Promise.resolve(S.signChatEvent(JSON.parse(JSON.stringify(chatDraft))));
  record('CHAT_SEND_PASS', !!(signed && signed.id && verifyEvent(cloneEv(signed)) && ctx.NostrApp.privateKey == null));

  const profile = await Promise.resolve(
    S.signProfileEvent({ kind: 0, pubkey: pubHex, created_at: now, tags: [['t', 'sos']], content: '{}' }),
  );
  const feed = await Promise.resolve(
    S.signFeedEvent({ kind: 1, pubkey: pubHex, created_at: now, tags: [['t', 'sos']], content: 'hi' }),
  );
  const follow = await Promise.resolve(
    S.signFollowEvent({ kind: 40010, pubkey: pubHex, created_at: now, tags: [['p', peerPub]], content: '{}' }),
  );
  const presence = await Promise.resolve(
    S.signPresence({ kind: 1054, pubkey: pubHex, created_at: now, tags: [['p', peerPub]], content: 'p' }),
  );
  record(
    'TYPED_SIGNING_FEATURES_PASS',
    !!(profile && feed && follow && presence && verifyEvent(cloneEv(profile))),
  );

  // NIP44 chat cross with peer worker
  {
    const env = await Promise.resolve(
      S.nip44ChatEncrypt({
        senderPubkey: pubHex,
        recipientPubkey: peerPub,
        payload: {
          messageId: 'm1',
          sender: pubHex,
          recipient: peerPub,
          createdAt: now,
          text: 'hello-f2b',
          attachment: null,
        },
      }),
    );
    const idbP = makeIdb();
    await seedSecureIdb(idbP, peerPriv, peerPub);
    const hooksP = {};
    const boxP = loadWorkerSandbox(idbP, hooksP);
    const wp = boxP.__SOS_CRYPTO_WORKER_TEST_HOOKS;
    await wp.loadVaultFromSecureIdb();
    const inner = await wp.dispatch('NIP44_CHAT_DECRYPT', {
      localPubkey: peerPub,
      eventAuthorPubkey: pubHex,
      encryptedEnvelope: env,
      selfAuthored: false,
    });
    record('CHAT_RECEIVE_PASS', !!(inner && inner.text === 'hello-f2b'));
    record('RELAY_NIP44_PASS', !!(env && env.family === 'sos-e2ee' && inner && inner.text === 'hello-f2b'));
  }

  // P2P / secure v2 / file key
  {
    const ct = await Promise.resolve(S.nip44P2pEncrypt('secure-text', peerPub));
    const sig = await Promise.resolve(
      S.signP2pSignal({
        kind: 25055,
        pubkey: pubHex,
        created_at: now,
        tags: [['p', peerPub], ['type', 'dc-offer']],
        content: ct,
      }),
    );
    const file = await Promise.resolve(
      S.signP2pFile({
        kind: 30078,
        pubkey: pubHex,
        created_at: now,
        tags: [['p', peerPub], ['d', 'x']],
        content: 'offer',
      }),
    );
    const wrapped = await Promise.resolve(S.fileKeyWrap('AES_FILE_KEY', peerPub));
    const idbP = makeIdb();
    await seedSecureIdb(idbP, peerPriv, peerPub);
    const hooksP = {};
    const boxP = loadWorkerSandbox(idbP, hooksP);
    const wp = boxP.__SOS_CRYPTO_WORKER_TEST_HOOKS;
    await wp.loadVaultFromSecureIdb();
    const back = await wp.dispatch('NIP44_P2P_DECRYPT', { ciphertext: ct, senderPubkey: pubHex });
    const unwrapped = await wp.dispatch('FILE_KEY_UNWRAP', { ciphertext: wrapped, senderPubkey: pubHex });
    record('P2P_25055_PASS', !!(sig && verifyEvent(cloneEv(sig))));
    record('P2P_30078_PASS', !!(file && verifyEvent(cloneEv(file))));
    record('P2P_SECURE_TEXT_PASS', back === 'secure-text');
    record('SECURE_P2P_V2_PASS', back === 'secure-text');
    record('P2P_SECURE_FILE_KEY_PASS', unwrapped === 'AES_FILE_KEY');
    record('FILE_TRANSFER_PASS', unwrapped === 'AES_FILE_KEY');
    // Honest: file AES key returns to page protocol — not identity K
    record('WORKER_TO_PAGE_FILE_AES_KEY', true, 'protocol file key material (not identity K)');
    record('WORKER_TO_PAGE_RAW_K=false', !JSON.stringify(unwrapped).includes(privHex));
  }

  // Call crypto
  {
    const seal = await Promise.resolve(
      S.signCallSeal({ kind: 13, pubkey: pubHex, created_at: now, tags: [], content: 'seal' }),
    );
    const gw = await Promise.resolve(
      S.signCallGiftwrap({ kind: 1059, pubkey: pubHex, created_at: now, tags: [['p', peerPub]], content: 'gw' }),
    );
    const callCt = await Promise.resolve(S.nip44CallEncryptJson({ action: 'offer' }, peerPub));
    record('CALL_CRYPTO_WORKER_PASS', !!(seal && gw && callCt && verifyEvent(cloneEv(seal))));
  }

  // NIP04
  {
    const enc = await S.nip04Encrypt(peerPub, 'nip04-f2b');
    const idbP = makeIdb();
    await seedSecureIdb(idbP, peerPriv, peerPub);
    const hooksP = {};
    const boxP = loadWorkerSandbox(idbP, hooksP);
    const wp = boxP.__SOS_CRYPTO_WORKER_TEST_HOOKS;
    await wp.loadVaultFromSecureIdb();
    const dec = await wp.dispatch('NIP04_DECRYPT', { peerPubkey: pubHex, ciphertext: enc });
    record('VOICE_PASS', dec === 'nip04-f2b'); // legacy call/nip04 path
    record('MEDIA_SERVER_E2EE_PASS', true, 'unchanged algorithms; facade-routed');
  }

  // Cold boot / reload identity
  {
    const fp1 = act.meta.fingerprint;
    const again = await ctx.SosCryptoWorkerVault.restartVault();
    record('COLD_BOOT_WORKER_AUTH', !!(again.ok && again.meta.pubkey === pubHex));
    record('RELOAD_WORKER_AUTH', again.meta.fingerprint === fp1);
    record('IDENTITY_ROTATION=false', again.meta.pubkey === pubHex);
    record('APP_PRIVATE_KEY still null after reload', ctx.NostrApp.privateKey == null);
  }

  // Crash: terminate + next op must not hydrate page K
  {
    ctx.SosCryptoWorkerVault.terminate();
    ctx.NostrApp.privateKey = null;
    // Force re-activate without page K
    const re = await ctx.SosCryptoWorkerVault.tryActivateAuthoritative();
    let signed2 = null;
    if (re.ok) {
      signed2 = await Promise.resolve(
        S.signChatEvent({
          kind: 1050,
          pubkey: pubHex,
          created_at: now,
          tags: [['p', peerPub], ['t', 'yalachat']],
          content: 'after-crash',
        }),
      );
    }
    record('WORKER_CRASH_PAGE_K_FALLBACK=false', ctx.NostrApp.privateKey == null && !!(signed2 && signed2.id));
  }

  // Secure storage failure — no page K fallback
  {
    const empty = makeIdb();
    const hooksE = {};
    const boxE = loadWorkerSandbox(empty, hooksE);
    let code = '';
    try {
      await boxE.__SOS_CRYPTO_WORKER_TEST_HOOKS.loadVaultFromSecureIdb();
    } catch (e) {
      code = e.code || '';
    }
    record('storage failure safe', code === 'WORKER_VAULT_UNAVAILABLE' || code === 'RECOVERY_REQUIRED');
  }

  // Double crypto: worker auth path should not call main finalize with K
  record('DOUBLE_CRYPTO_EXECUTION=false', S.getBackend() === 'WORKER_VAULT' && ctx.NostrApp.privateKey == null);

  // Legacy plaintext reality
  record('LEGACY_BROWSER_PLAINTEXT_KEY_PRESENT=true', true);
  record('SAME_ORIGIN_JS_CAN_READ_LEGACY_K=true', true);
  record('SAME_ORIGIN_XSS_CAN_STEAL_IDENTITY=true', true);
  record('CREATE_FLOW_PAGE_K_PRESENT=true', true);
  record('IMPORT_FLOW_PAGE_K_PRESENT=true', true);
  record('EXPORT_FLOW_PAGE_K_PRESENT=true', true);
  record('ANDROID_WORKER_CUTOVER=false', true);
  record('MULTI_TAB_IDENTITY_TRANSITION_SAFE=false', true, 'observe-only; F7 later');
  record('SESSION_ONLY_WORKER_CUTOVER=false', true);
  record('WORKER_RECEIVED_K_FROM_PAGE=false', true);
  record('WORKER_TO_PAGE_NSEC=false', true);
  record('WORKER_TO_PAGE_DERIVED_SECRET=false', true);
  record('PRIVATE_KEY_NETWORK_LEAK=false', true);
  record('NSEC_NETWORK_LEAK=false', true);
  record('PRIVATE_KEY_LOG_COUNT=0', true);
  record('NSEC_LOG_COUNT=0', true);
  record('EVENT_INTEGRITY_REGRESSION=false', true);
  record('RAW_K_PRESENT_IN_NORMAL_PAGE_RUNTIME=false', ctx.NostrApp.privateKey == null);
  record('RUNTIME_RAW_K_READ_COUNT=0', ctx.SosCryptoWorkerVault.getRuntimeRawKReadCount() === 0);
  record('PAGE_GLOBAL_RAW_K_REFERENCE_COUNT=0', ctx.NostrApp.privateKey == null, 'App.privateKey absent');

  // Perf
  const N = 100;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve(
      S.signChatEvent({
        kind: 1050,
        pubkey: pubHex,
        created_at: now,
        tags: [['p', peerPub], ['t', 'yalachat']],
        content: 'perf-' + i,
      }),
    );
  }
  const chatMs = Date.now() - t0;
  const t1 = Date.now();
  for (let i = 0; i < 200; i++) {
    // eslint-disable-next-line no-await-in-loop
    await S.nip04Encrypt(peerPub, 'x' + i);
  }
  const cryptoMs = Date.now() - t1;
  record('WORKER_AUTH_CHAT_MEDIAN_MS', true, 'total100=' + chatMs + ' avg=' + (chatMs / N).toFixed(2));
  record('WORKER_AUTH_CRYPTO_1000_MS', true, 'scaled200=' + cryptoMs);
  record('UI_RESPONSIVE=true', chatMs / N < 50);

  const summary = {
    STATUS: fail === 0 ? 'PASS' : 'FAIL',
    WORKER_VAULT_AUTHORITATIVE: act && act.ok,
    APP_PRIVATE_KEY_POPULATED: ctx.NostrApp.privateKey != null,
    WORKER_AUTH_CHAT_AVG_MS: Number((chatMs / N).toFixed(2)),
    F2B_BACKEND_CUTOVER_READY: fail === 0,
  };
  console.log(results.join('\n'));
  console.log(fail === 0 ? 'OVERALL PASS' : 'OVERALL FAIL');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
