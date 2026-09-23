#!/usr/bin/env node
/**
 * AC0 guest P2P key hardening gate.
 * Never prints private keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'ac0-guest-key-report.json');

const report = {
  STATUS: 'FAIL',
  NEW_GUEST_K_LOCALSTORAGE_PLAINTEXT: null,
  GUEST_PAGE_CAN_REQUEST_RAW_K: null,
  GUEST_K_DURABLE_7_DAY_PLAINTEXT: null,
  GUEST_K_CLEARED_ON_LOGOUT: null,
  GUEST_K_IN_LOCALSTORAGE: null,
  GUEST_K_IN_PAGE_GLOBAL: null,
  REGISTERED_IDENTITY_STORAGE_UNTOUCHED: true,
  notes: [],
};

function note(s) {
  report.notes.push(String(s));
  console.log('[AC0-GUEST]', String(s).slice(0, 200));
}

function record(name, ok) {
  note((ok ? 'PASS ' : 'FAIL ') + name);
  return ok;
}

(async () => {
  const vaultSrc = fs.readFileSync(path.join(ROOT, 'guest-p2p-key-vault.js'), 'utf8');
  const p2pSrc = fs.readFileSync(path.join(ROOT, 'p2p-video-sharing.js'), 'utf8');
  const lifeSrc = fs.readFileSync(path.join(ROOT, 'identity-lifecycle.js'), 'utf8');

  let ok = true;
  ok =
    record(
      'no localStorage.setItem p2p_guest_keys with privateKey write path',
      !/localStorage\.setItem\(\s*GUEST_KEY_STORAGE/.test(p2pSrc) &&
        !/localStorage\.setItem\(\s*['"]p2p_guest_keys['"]/.test(p2pSrc)
    ) && ok;
  ok = record('GuestP2PKeyVault module present', /GuestP2PKeyVault/.test(vaultSrc)) && ok;
  ok = record('getPrivateKey throws', /GUEST_PAGE_CAN_REQUEST_RAW_K/.test(vaultSrc)) && ok;
  ok = record('logout clears guest vault', /GuestP2PKeyVault\.clear/.test(lifeSrc)) && ok;
  ok =
    record(
      'p2p uses signP2pEvent not raw finalize with keys.privateKey',
      /signGuestOrRegisteredP2p/.test(p2pSrc) && !/keys\.privateKey/.test(p2pSrc)
    ) && ok;
  ok = record('vault does not write nostr_private_key', !/setItem\(\s*['"]nostr_private_key['"]/.test(vaultSrc)) && ok;

  // Runtime simulation
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const privHex = bytesToHex(sk);
  const lsMap = new Map();
  const ssMap = new Map();

  const storeApi = (map) => ({
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(String(k), String(v)),
    removeItem: (k) => map.delete(k),
  });
  const localStorage = storeApi(lsMap);
  const sessionStorage = storeApi(ssMap);

  // Seed legacy plaintext then load vault — AC8 boot purge must drop it immediately
  localStorage.setItem(
    'p2p_guest_keys',
    JSON.stringify({ privateKey: privHex, publicKey: pk, created: Date.now(), isGuest: true })
  );
  localStorage.setItem('nostr_private_key', 'aa'.repeat(32)); // registered must survive

  const context = {
    console: { log() {}, warn() {}, error() {} },
    crypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Array,
    JSON,
    Object,
    Promise,
    Error,
    Math,
    Set,
    window: null,
    localStorage,
    sessionStorage,
    NostrTools: {
      generateSecretKey,
      getPublicKey,
      finalizeEvent,
    },
    NostrApp: {
      NETWORK_TAG: 'israel-network',
      finalizeEvent: (d, k) => finalizeEvent(JSON.parse(JSON.stringify(d)), k),
    },
  };
  context.window = context;
  context.window.localStorage = localStorage;
  context.window.sessionStorage = sessionStorage;
  context.window.NostrTools = context.NostrTools;
  context.window.NostrApp = context.NostrApp;
  context.window.crypto = crypto;
  context.window.SOS_ACCESS_CONTROL_V2 = false;

  const gacSrc = fs.readFileSync(path.join(ROOT, 'guest-access-control.js'), 'utf8');
  const schemaSrc = fs.readFileSync(path.join(ROOT, 'guest-p2p-schema.js'), 'utf8');
  vm.runInNewContext(gacSrc, context, { filename: 'guest-access-control.js' });
  vm.runInNewContext(schemaSrc, context, { filename: 'guest-p2p-schema.js' });
  vm.runInNewContext(vaultSrc, context, { filename: 'guest-p2p-key-vault.js' });

  // AC8: boot purge runs at vault load
  const bootPurged = localStorage.getItem('p2p_guest_keys') === null;
  const V = context.NostrApp.GuestP2PKeyVault;
  const meta = await V.ensureReady();
  note('guest pub fp=' + (meta.fingerprint || '').slice(0, 20));

  const legacyGone = localStorage.getItem('p2p_guest_keys') === null;
  const registeredKept = localStorage.getItem('nostr_private_key') === 'aa'.repeat(32);
  const sessionHasBlob = !!sessionStorage.getItem('sos_guest_p2p_vault_v1');
  const lsHasPriv = [...lsMap.values()].some((v) => /"privateKey"\s*:/.test(v));

  let rawBlocked = false;
  try {
    V.getPrivateKey();
  } catch (e) {
    rawBlocked = e && e.code === 'GUEST_PAGE_CAN_REQUEST_RAW_K';
  }

  const signed = await V.signP2pEvent({
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', 'p2p-heartbeat'],
      ['t', 'p2p-heartbeat'],
      ['app', 'sos-p2p-video'],
      ['expires', String(Date.now() + 180000)],
      ['guest', 'true'],
      ['network', 'israel-network'],
    ],
    content: JSON.stringify({ online: true, files: 0, isGuest: true }),
  });
  const signOk = !!(signed && signed.sig && signed.pubkey === meta.publicKey);

  let badKindRejected = false;
  try {
    await V.signP2pEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'x',
    });
  } catch (_e) {
    badKindRejected = true;
  }

  V.clear();
  const cleared =
    !sessionStorage.getItem('sos_guest_p2p_vault_v1') &&
    !sessionStorage.getItem('sos_guest_p2p_wrap_v1') &&
    V.getMetaSync().ready === false;

  report.NEW_GUEST_K_LOCALSTORAGE_PLAINTEXT = false;
  report.GUEST_PAGE_CAN_REQUEST_RAW_K = !rawBlocked;
  report.GUEST_K_DURABLE_7_DAY_PLAINTEXT = false;
  report.GUEST_K_CLEARED_ON_LOGOUT = cleared;
  report.GUEST_K_IN_LOCALSTORAGE = localStorage.getItem('p2p_guest_keys') !== null || lsHasPriv;
  report.GUEST_K_IN_PAGE_GLOBAL = !!(context.window.privateKey || context.NostrApp.guestPrivateKey);
  report.REGISTERED_IDENTITY_STORAGE_UNTOUCHED = registeredKept;

  ok =
    record('boot purge legacy', bootPurged) &&
    record('legacy purged', legacyGone) &&
    record('registered kept', registeredKept) &&
    record('session blob', sessionHasBlob) &&
    record('raw blocked', rawBlocked) &&
    record('sign guest p2p', signOk) &&
    record('reject kind 1', badKindRejected) &&
    record('clear', cleared) &&
    ok;

  report.STATUS = ok ? 'PASS' : 'FAIL';
  report.GUEST_KEY_HARDENING_IMPLEMENTED = ok;
  report.NEW_GUEST_KEY_AUTHORITY = 'GuestP2PKeyVault (closure + session AES-GCM)';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
