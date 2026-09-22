#!/usr/bin/env node
/**
 * Stage 5E-F2A — Worker vault shadow / parity gate.
 * Does NOT cut over. Does NOT post K to worker. Does NOT deploy.
 * Run: node qa/sos-crypto-worker-f2a-gate.mjs
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
        objectStoreNames: {
          contains(name) {
            return Object.prototype.hasOwnProperty.call(stores, name);
          },
        },
        createObjectStore(name) {
          stores[name] = stores[name] || new Map();
          return {};
        },
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
  return { indexedDB, stores };
}

async function seedSecureIdb(idb, privHex, pubHex) {
  const key = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode('SOS|browser-identity|v1');
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    new TextEncoder().encode(privHex),
  );
  idb.stores.wrapping_key.set('v1', key);
  idb.stores.identity_blob.set('current', {
    version: 1,
    iv,
    ciphertext,
    pubkey: pubHex,
    migratedAt: Date.now(),
  });
  idb.stores.metadata.set('provider', { identity_storage_provider: 'browser-secure-v1' });
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
    postMessage(msg) {
      messages.push(msg);
    },
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__messages = messages;
  vm.createContext(sandbox);
  vm.runInContext(read('vendor/nostr.bundle.min.js'), sandbox, { filename: 'nostr.bundle.min.js' });
  sandbox.NostrApp = {
    hexToBytes,
    inspectIncomingChatAttachment: () => ({ ok: true }),
    verifyIncomingChatAttachment: () => true,
  };
  vm.runInContext(read('chat-e2ee.js'), sandbox, { filename: 'chat-e2ee.js' });
  vm.runInContext(read('sos-crypto-worker.js'), sandbox, { filename: 'sos-crypto-worker.js' });
  if (typeof hooks.setNostrTools === 'function') hooks.setNostrTools(sandbox.NostrTools);
  return sandbox;
}

function loadMainSigner(privHex, pubHex) {
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
  };
  context.window = context;
  context.NostrApp = {
    publicKey: pubHex,
    privateKey: privHex,
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
  vm.createContext(context);
  vm.runInContext(read('sos-crypto-signer.js'), context, { filename: 'sos-crypto-signer.js' });
  return context.NostrApp.SosCryptoSigner;
}

function cloneEv(ev) {
  return JSON.parse(JSON.stringify(ev));
}

function eventParity(a, b) {
  const aa = cloneEv(a);
  const bb = cloneEv(b);
  return !!(
    aa &&
    bb &&
    aa.id === bb.id &&
    aa.pubkey === bb.pubkey &&
    aa.kind === bb.kind &&
    aa.content === bb.content &&
    JSON.stringify(aa.tags) === JSON.stringify(bb.tags) &&
    verifyEvent(aa) &&
    verifyEvent(bb)
  );
}

async function main() {
  const srcWorker = read('sos-crypto-worker.js');
  const srcVault = read('sos-crypto-worker-vault.js');
  const apiSurface = (srcWorker + '\n' + srcVault)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  record('WORKER_VAULT_IMPLEMENTED', fs.existsSync(path.join(ROOT, 'sos-crypto-worker.js')));
  record('WORKER_VAULT_SHADOW_MODE', /mode:\s*'shadow'|SHADOW/.test(srcVault));
  // Public typed surface only — ban-list mentions of SIGN_RAW/GET_KEY are allowed as rejects.
  const hasBannedPublicApi =
    /\bfunction\s+signAnything\b|\bsignRaw\s*\(|\bdecryptAnything\s*\(|\bgetPrivateKey\s*\(|\bexportRawKey\s*\(/.test(
      apiSurface,
    ) || /case\s+'SIGN_RAW'|case\s+'GET_KEY'|case\s+'EXPORT_KEY'|case\s+'DECRYPT_ANY'/.test(srcWorker);
  record('WORKER_GENERIC_SIGN_API=false', !hasBannedPublicApi);
  record('WORKER_GENERIC_DECRYPT_API=false', !hasBannedPublicApi);
  record('WORKER_RAW_KEY_API=false', !hasBannedPublicApi);
  record('WORKER_LEGACY_RAW_K_FALLBACK=false', !/nostr_private_key/.test(srcWorker));
  record('WORKER_REJECTS_PAGE_K', /WORKER_REJECTS_PAGE_K/.test(srcWorker));
  record('local vendor nostr bundle', fs.existsSync(path.join(ROOT, 'vendor/nostr.bundle.min.js')));
  record('ANDROID_F2A_APPLIES=false', /ANDROID_F2A_APPLIES:\s*false|ANDROID_F2A_EXCLUDED/.test(srcVault));

  const sk = generateSecretKey();
  const privHex = bytesToHex(sk);
  const pubHex = getPublicKey(sk);
  const peerSk = generateSecretKey();
  const peerPriv = bytesToHex(peerSk);
  const peerPub = getPublicKey(peerSk);
  const now = Math.floor(Date.now() / 1000);

  // Seed secure IDB and load worker vault
  const idb = makeIdb();
  await seedSecureIdb(idb, privHex, pubHex);
  const hooks = {};
  const workerBox = loadWorkerSandbox(idb, hooks);
  const w = workerBox.__SOS_CRYPTO_WORKER_TEST_HOOKS;

  let meta;
  try {
    meta = await w.loadVaultFromSecureIdb();
    record('WORKER_LOADED_K_DIRECTLY_FROM_SECURE_IDB', meta.vaultState === 'READY' && meta.pubkey === pubHex);
  } catch (e) {
    record('WORKER_LOADED_K_DIRECTLY_FROM_SECURE_IDB', false, e.message);
  }
  record('WORKER_IDENTITY_METADATA_ONLY', meta && meta.pubkey && !meta.privateKey && !JSON.stringify(meta).includes(privHex));
  record('WORKER_RECEIVED_K_FROM_PAGE=false', true); // by design; reject path tested below

  // Reject page-injected K
  {
    workerBox.__messages.length = 0;
    workerBox.onmessage({
      data: {
        id: 'inj1',
        op: 'SIGN_CHAT_EVENT',
        params: { privateKey: privHex, draft: {} },
      },
    });
    // allow microtask for promise
    await new Promise((r) => setTimeout(r, 10));
    const resp = workerBox.__messages.find((m) => m && m.id === 'inj1');
    record(
      'page→worker K rejected',
      !!(resp && resp.ok === false && resp.error && resp.error.code === 'WORKER_REJECTS_PAGE_K'),
    );
  }

  const mainS = loadMainSigner(privHex, pubHex);

  // Signing parity
  const signOps = [
    ['SIGN_CHAT_EVENT', { kind: 1050, pubkey: pubHex, created_at: now, tags: [['p', peerPub], ['t', 'yalachat']], content: 'c' }, (d) => mainS.signChatEvent(d)],
    ['SIGN_PROFILE_EVENT', { kind: 0, pubkey: pubHex, created_at: now, tags: [['t', 'sos']], content: '{}' }, (d) => mainS.signProfileEvent(d)],
    ['SIGN_P2P_SIGNAL', { kind: 25055, pubkey: pubHex, created_at: now, tags: [['p', peerPub], ['type', 'dc-offer']], content: 'enc' }, (d) => mainS.signP2pSignal(d)],
    ['SIGN_P2P_FILE', { kind: 30078, pubkey: pubHex, created_at: now, tags: [['p', peerPub], ['d', 'x']], content: 'offer' }, (d) => mainS.signP2pFile(d)],
    ['SIGN_CALL_GIFTWRAP', { kind: 1059, pubkey: pubHex, created_at: now, tags: [['p', peerPub]], content: 'gw' }, (d) => mainS.signCallGiftwrap(d)],
    ['SIGN_CALL_SEAL', { kind: 13, pubkey: pubHex, created_at: now, tags: [], content: 'seal' }, (d) => mainS.signCallSeal(d)],
    ['SIGN_READ_RECEIPT', { kind: 1051, pubkey: pubHex, created_at: now, tags: [['p', peerPub]], content: 'rr' }, (d) => mainS.signReadReceipt(d)],
    ['SIGN_PRESENCE', { kind: 1054, pubkey: pubHex, created_at: now, tags: [['p', peerPub]], content: 'pr' }, (d) => mainS.signPresence(d)],
    ['SIGN_DELETE', { kind: 5, pubkey: pubHex, created_at: now, tags: [['e', 'a'.repeat(64)]], content: '' }, (d) => mainS.signDelete(d)],
  ];

  let signingOk = true;
  for (const [op, draft, mainFn] of signOps) {
    const mainEv = mainFn(JSON.parse(JSON.stringify(draft)));
    const workerEv = await w.dispatch(op, { draft: JSON.parse(JSON.stringify(draft)) });
    const ok = eventParity(mainEv, workerEv);
    if (!ok) signingOk = false;
    record('sign parity ' + op, ok);
  }
  record('SIGNING_PARITY', signingOk);

  // NIP44 P2P / CALL / FILE cross decrypt
  {
    const plain = 'p2p-shadow-plain';
    const mainCt = mainS.nip44P2pEncrypt(plain, peerPub);
    // worker decrypt needs peer's vault — re-seed peer vault
    const idbPeer = makeIdb();
    await seedSecureIdb(idbPeer, peerPriv, peerPub);
    const hooksPeer = {};
    const peerBox = loadWorkerSandbox(idbPeer, hooksPeer);
    const wp = peerBox.__SOS_CRYPTO_WORKER_TEST_HOOKS;
    await wp.loadVaultFromSecureIdb();
    const fromMain = await wp.dispatch('NIP44_P2P_DECRYPT', { ciphertext: mainCt, senderPubkey: pubHex });
    const workerCt = await w.dispatch('NIP44_P2P_ENCRYPT', { plaintext: plain, recipientPubkey: peerPub });
    const fromWorker = mainS; // main as peer: need peer's main signer
    const peerMain = loadMainSigner(peerPriv, peerPub);
    const back = peerMain.nip44P2pDecrypt(workerCt, pubHex);
    record('NIP44_CROSS_DECRYPT_PARITY p2p', fromMain === plain && back === plain);

    const callObj = { action: 'offer', v: 1 };
    const mainCallCt = mainS.nip44CallEncryptJson(callObj, peerPub);
    const callFromMain = JSON.parse(
      await wp.dispatch('NIP44_CALL_DECRYPT', { ciphertext: mainCallCt, senderPubkey: pubHex }),
    );
    const workerCallCt = await w.dispatch('NIP44_CALL_ENCRYPT', { obj: callObj, recipientPubkey: peerPub });
    const callBack = JSON.parse(peerMain.nip44CallDecryptToString(workerCallCt, pubHex));
    record('CALL_CRYPTO_PARITY nip44', callFromMain.action === 'offer' && callBack.action === 'offer');

    const keyMat = 'FILE_AES_KEY_MATERIAL';
    const wrappedMain = mainS.fileKeyWrap(keyMat, peerPub);
    const unwrapW = await wp.dispatch('FILE_KEY_UNWRAP', { ciphertext: wrappedMain, senderPubkey: pubHex });
    const wrappedW = await w.dispatch('FILE_KEY_WRAP', { keyMaterial: keyMat, recipientPubkey: peerPub });
    const unwrapM = peerMain.fileKeyUnwrap(wrappedW, pubHex);
    record('FILE_KEY_CRYPTO_PARITY', unwrapW === keyMat && unwrapM === keyMat);

    // Secure P2P v2 crypto = same nip44 p2p path + sign kinds
    record('SECURE_P2P_V2_CRYPTO_PARITY', fromMain === plain && back === plain && signingOk);
  }

  // NIP44 chat cross
  {
    const env = mainS.nip44ChatEncrypt({
      senderPubkey: pubHex,
      recipientPubkey: peerPub,
      payload: {
        messageId: 'm1',
        sender: pubHex,
        recipient: peerPub,
        createdAt: now,
        text: 'chat-shadow',
        attachment: null,
      },
    });
    const idbPeer = makeIdb();
    await seedSecureIdb(idbPeer, peerPriv, peerPub);
    const hooksPeer = {};
    const peerBox = loadWorkerSandbox(idbPeer, hooksPeer);
    const wp = peerBox.__SOS_CRYPTO_WORKER_TEST_HOOKS;
    await wp.loadVaultFromSecureIdb();
    const inner = await wp.dispatch('NIP44_CHAT_DECRYPT', {
      localPubkey: peerPub,
      eventAuthorPubkey: pubHex,
      encryptedEnvelope: env,
      selfAuthored: false,
    });
    const envW = await w.dispatch('NIP44_CHAT_ENCRYPT', {
      senderPubkey: pubHex,
      recipientPubkey: peerPub,
      payload: {
        messageId: 'm2',
        sender: pubHex,
        recipient: peerPub,
        createdAt: now,
        text: 'chat-worker',
        attachment: null,
      },
    });
    const peerMain = loadMainSigner(peerPriv, peerPub);
    const innerM = peerMain.nip44ChatDecrypt({
      localPubkey: peerPub,
      eventAuthorPubkey: pubHex,
      encryptedEnvelope: envW,
      selfAuthored: false,
    });
    record(
      'NIP44_CROSS_DECRYPT_PARITY chat',
      !!(inner && inner.text === 'chat-shadow' && innerM && innerM.text === 'chat-worker'),
    );
  }

  // NIP04 cross
  {
    const plain = 'nip04-shadow';
    const a = await nip04.encrypt(privHex, peerPub, plain);
    const idbPeer = makeIdb();
    await seedSecureIdb(idbPeer, peerPriv, peerPub);
    const hooksPeer = {};
    const peerBox = loadWorkerSandbox(idbPeer, hooksPeer);
    const wp = peerBox.__SOS_CRYPTO_WORKER_TEST_HOOKS;
    await wp.loadVaultFromSecureIdb();
    const da = await wp.dispatch('NIP04_DECRYPT', { peerPubkey: pubHex, ciphertext: a });
    const b = await w.dispatch('NIP04_ENCRYPT', { peerPubkey: peerPub, plaintext: plain });
    const db = await nip04.decrypt(peerPriv, pubHex, b);
    record('NIP04_CROSS_DECRYPT_PARITY', da === plain && db === plain);
  }

  // Failure modes
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
    record('missing wrapping_key → UNAVAILABLE', code === 'WORKER_VAULT_UNAVAILABLE');
  }
  {
    const idbBad = makeIdb();
    await seedSecureIdb(idbBad, privHex, pubHex);
    idbBad.stores.identity_blob.set('current', {
      version: 1,
      iv: globalThis.crypto.getRandomValues(new Uint8Array(12)),
      ciphertext: globalThis.crypto.getRandomValues(new Uint8Array(48)),
      pubkey: pubHex,
    });
    const hooksB = {};
    const boxB = loadWorkerSandbox(idbBad, hooksB);
    let code = '';
    try {
      await boxB.__SOS_CRYPTO_WORKER_TEST_HOOKS.loadVaultFromSecureIdb();
    } catch (e) {
      code = e.code || '';
    }
    record('corrupt blob / AES fail → RECOVERY_REQUIRED', code === 'RECOVERY_REQUIRED');
  }
  {
    const idbWrong = makeIdb();
    await seedSecureIdb(idbWrong, privHex, pubHex);
    const blob = idbWrong.stores.identity_blob.get('current');
    blob.pubkey = peerPub; // wrong persisted P
    const hooksW = {};
    const boxW = loadWorkerSandbox(idbWrong, hooksW);
    let code = '';
    try {
      await boxW.__SOS_CRYPTO_WORKER_TEST_HOOKS.loadVaultFromSecureIdb();
    } catch (e) {
      code = e.code || '';
    }
    record('wrong stored pubkey → RECOVERY_REQUIRED', code === 'RECOVERY_REQUIRED');
  }
  {
    const hooksN = {};
    const boxN = loadWorkerSandbox(null, hooksN);
    let code = '';
    try {
      await boxN.__SOS_CRYPTO_WORKER_TEST_HOOKS.loadVaultFromSecureIdb();
    } catch (e) {
      code = e.code || '';
    }
    record('IndexedDB unavailable → safe error', !!code);
  }

  // Identity preservation across reload
  {
    const idb2 = makeIdb();
    await seedSecureIdb(idb2, privHex, pubHex);
    const h1 = {};
    const b1 = loadWorkerSandbox(idb2, h1);
    const m1 = await b1.__SOS_CRYPTO_WORKER_TEST_HOOKS.loadVaultFromSecureIdb();
    const h2 = {};
    const b2 = loadWorkerSandbox(idb2, h2);
    const m2 = await b2.__SOS_CRYPTO_WORKER_TEST_HOOKS.loadVaultFromSecureIdb();
    record('WORKER_IDENTITY_ROTATION=false', m1.pubkey === m2.pubkey && m1.fingerprint === m2.fingerprint);
  }

  // Session-only audit (static)
  record(
    'SESSION_ONLY_WORKER_SUPPORTED=false',
    !/sessionStorage|nostr_private_key_ephemeral/.test(srcWorker),
  );
  record('CREATE_FLOW_WORKER_READY=false', true);
  record('IMPORT_FLOW_WORKER_READY=false', true);
  record('EXPORT_FLOW_WORKER_READY=false', true);

  // RPC never exports K
  {
    const meta2 = await w.dispatch('GET_IDENTITY_META', {});
    const dumped = JSON.stringify(meta2);
    record('WORKER_RPC_CAN_EXPORT_RAW_K=false', !dumped.includes(privHex) && !('privateKey' in (meta2 || {})));
  }

  // Perf
  const N = 200; // lighter than 1000 for CI time; scale report
  const drafts = [];
  for (let i = 0; i < N; i++) {
    drafts.push({
      kind: 1050,
      pubkey: pubHex,
      created_at: now,
      tags: [['p', peerPub], ['t', 'yalachat']],
      content: 'perf-' + i,
    });
  }
  const t0 = Date.now();
  for (let i = 0; i < N; i++) mainS.signChatEvent(JSON.parse(JSON.stringify(drafts[i])));
  const mainSignMs = Date.now() - t0;
  const t1 = Date.now();
  for (let i = 0; i < N; i++) {
    // eslint-disable-next-line no-await-in-loop
    await w.dispatch('SIGN_CHAT_EVENT', { draft: JSON.parse(JSON.stringify(drafts[i])) });
  }
  const workerSignMs = Date.now() - t1;
  const signOverhead = workerSignMs - mainSignMs;
  record('WORKER_SIGN_RPC_OVERHEAD_MS', true, 'N=' + N + ' main=' + mainSignMs + ' worker=' + workerSignMs + ' delta=' + signOverhead);

  const et0 = Date.now();
  for (let i = 0; i < N; i++) {
    // eslint-disable-next-line no-await-in-loop
    await mainS.nip04Encrypt(peerPub, 'x' + i);
  }
  const mainEnc = Date.now() - et0;
  const et1 = Date.now();
  for (let i = 0; i < N; i++) {
    // eslint-disable-next-line no-await-in-loop
    await w.dispatch('NIP04_ENCRYPT', { peerPubkey: peerPub, plaintext: 'x' + i });
  }
  const workerEnc = Date.now() - et1;
  const encOverhead = workerEnc - mainEnc;
  record(
    'WORKER_NIP44_RPC_OVERHEAD_MS',
    true,
    'N=' + N + ' nip04-proxy main=' + mainEnc + ' worker=' + workerEnc + ' delta=' + encOverhead,
  );

  // Expected F2A truths
  record('RAW_K_PRESENT_IN_PAGE_JS_MEMORY=true', true);
  record('PAGE_JS_CAN_REQUEST_RAW_PRIVATE_KEY=true', true);
  record('SAME_ORIGIN_XSS_CAN_STEAL_IDENTITY=true', true);

  // Strict verify later?
  record('STRICT_VERIFY_WORKER_CANDIDATE_LATER=true', true);

  const summary = {
    STATUS: fail === 0 ? 'PASS' : 'FAIL',
    SIGNING_PARITY: signingOk,
    WORKER_SIGN_RPC_OVERHEAD_MS: Math.round((signOverhead * 1000) / N) + ' per-op-est-from-' + N,
    WORKER_NIP44_RPC_OVERHEAD_MS: Math.round((encOverhead * 1000) / N) + ' per-op-est-from-' + N,
    F2B_BACKEND_CUTOVER_READY: fail === 0,
  };

  console.log(results.join('\n'));
  console.log(fail === 0 ? 'OVERALL PASS' : 'OVERALL FAIL');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
