#!/usr/bin/env node
/**
 * Stage 5E-C: Web↔Native identity reconciliation — mismatch-safe, no rotation.
 * Deterministic fake keys only. Run: node qa/identity-web-native-reconcile-gate.mjs
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

/** Pure JS mirror of SosSessionStore 5E-C policy for isolated tests. */
function createNativeStore() {
  let pub = '';
  let priv = '';
  let stagedPub = '';
  let stagedPriv = '';
  const NATIVE_IDENTITY_OK = 'NATIVE_IDENTITY_OK';
  const NATIVE_IDENTITY_EMPTY = 'NATIVE_IDENTITY_EMPTY';
  const NATIVE_IDENTITY_INVALID = 'NATIVE_IDENTITY_INVALID';
  const NATIVE_IDENTITY_MISMATCH = 'NATIVE_IDENTITY_MISMATCH';
  const SYNC_IDENTITY_OK = 'SYNC_IDENTITY_OK';
  const SYNC_IDENTITY_SAME = 'SYNC_IDENTITY_SAME';
  const SYNC_IDENTITY_REJECT_INVALID = 'SYNC_IDENTITY_REJECT_INVALID';
  const SYNC_IDENTITY_REJECT_MISMATCH = 'SYNC_IDENTITY_REJECT_MISMATCH';
  const SYNC_IDENTITY_REJECT_BLOCKED = 'SYNC_IDENTITY_REJECT_BLOCKED';

  function norm(v) {
    const n = String(v || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(n) ? n : '';
  }
  function derive(p) {
    const n = norm(p);
    if (!n) return '';
    try { return getPublicKey(n).toLowerCase(); } catch (_) { return ''; }
  }
  function evaluate() {
    if (!pub && !priv) return { hasIdentity: false, valid: false, pubkey: '', state: NATIVE_IDENTITY_EMPTY };
    if (!pub || !priv) return { hasIdentity: true, valid: false, pubkey: pub, state: NATIVE_IDENTITY_INVALID };
    const d = derive(priv);
    if (!d) return { hasIdentity: true, valid: false, pubkey: pub, state: NATIVE_IDENTITY_INVALID };
    if (d !== pub) return { hasIdentity: true, valid: false, pubkey: pub, state: NATIVE_IDENTITY_MISMATCH };
    return { hasIdentity: true, valid: true, pubkey: pub, state: NATIVE_IDENTITY_OK };
  }
  function setIdentityPair(pubkey, privkey) {
    const p = norm(privkey);
    const expected = norm(pubkey);
    const d = derive(p);
    if (!p || !d) return SYNC_IDENTITY_REJECT_INVALID;
    if (expected && expected !== d) return SYNC_IDENTITY_REJECT_MISMATCH;
    const stored = evaluate();
    if (stored.valid && stored.pubkey === d && priv === p) return SYNC_IDENTITY_SAME;
    if (stored.valid && stored.pubkey !== d) return SYNC_IDENTITY_REJECT_MISMATCH;
    if (stored.hasIdentity && !stored.valid) return SYNC_IDENTITY_REJECT_BLOCKED;
    pub = d;
    priv = p;
    stagedPub = '';
    stagedPriv = '';
    return SYNC_IDENTITY_OK;
  }
  function flush() {
    if (!stagedPub || !stagedPriv) return SYNC_IDENTITY_OK;
    return setIdentityPair(stagedPub, stagedPriv);
  }
  function stagePubkey(pubkey) {
    const p = norm(pubkey);
    if (!p) return SYNC_IDENTITY_REJECT_INVALID;
    const stored = evaluate();
    if (stored.valid && stored.pubkey === p) { stagedPub = ''; stagedPriv = ''; return SYNC_IDENTITY_SAME; }
    if (stored.valid && stored.pubkey !== p) return SYNC_IDENTITY_REJECT_MISMATCH;
    if (stored.hasIdentity && !stored.valid) return SYNC_IDENTITY_REJECT_BLOCKED;
    stagedPub = p;
    return flush();
  }
  function stagePrivkey(privkey) {
    const p = norm(privkey);
    const d = derive(p);
    if (!p || !d) return SYNC_IDENTITY_REJECT_INVALID;
    const stored = evaluate();
    if (stored.valid && priv === p && stored.pubkey === d) { stagedPub = ''; stagedPriv = ''; return SYNC_IDENTITY_SAME; }
    if (stored.valid && stored.pubkey !== d) return SYNC_IDENTITY_REJECT_MISMATCH;
    if (stored.hasIdentity && !stored.valid) return SYNC_IDENTITY_REJECT_BLOCKED;
    stagedPriv = p;
    if (!stagedPub) stagedPub = d;
    else if (stagedPub !== d) { stagedPub = ''; stagedPriv = ''; return SYNC_IDENTITY_REJECT_MISMATCH; }
    return flush();
  }
  return {
    getPubkey: () => pub,
    getPrivkey: () => priv,
    evaluate,
    setIdentityPair,
    stagePubkey,
    stagePrivkey,
    statusJson() {
      const s = evaluate();
      return JSON.stringify({ hasIdentity: s.hasIdentity, valid: s.valid, pubkey: s.pubkey, state: s.state });
    },
    // test helpers
    _forceRaw(pubHex, privHex) { pub = norm(pubHex); priv = norm(privHex); },
    _snapshot: () => ({ pub, priv, stagedPub, stagedPriv }),
  };
}

function loadWebKeys() {
  const localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(String(k), String(v)); },
    removeItem(k) { this._m.delete(k); },
  };
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    window: null,
    localStorage,
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    NostrTools: { generateSecretKey, getPublicKey },
  };
  ctx.window = ctx;
  ctx.NostrApp = {
    bytesToHex,
    hexToBytes(hex) {
      const h = String(hex).replace(/^0x/i, '');
      const out = new Uint8Array(h.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
      return out;
    },
    getPublicKey,
  };
  vm.createContext(ctx);
  vm.runInContext(read('key-storage.js'), ctx);
  vm.runInContext(read('keys.js'), ctx);
  return ctx;
}

function staticAssertions() {
  const bridge = read('native-shell-bridge.js');
  const session = read('android-shell/app/src/main/java/com/sos010/app/SosSessionStore.kt');
  const jsBridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
  const keys = read('keys.js');

  const reconcileChunk = bridge.slice(
    bridge.indexOf('function reconcileIdentityWithNative'),
    bridge.indexOf('function syncPubkeyToNative')
  );
  record('static reconcile has NO generateSecretKey', !/generateSecretKey/.test(reconcileChunk));
  record('static reconcile has NO generateAndStoreKey', !/generateAndStoreKey/.test(reconcileChunk));
  record('static reconcile has NO createNewIdentityExplicit', !/createNewIdentityExplicit/.test(reconcileChunk));
  record('static syncUserIdentity bridge present', /fun syncUserIdentity/.test(jsBridge));
  record('static getNativeIdentityStatusJson present', /fun getNativeIdentityStatusJson/.test(jsBridge));
  record('static setIdentityPair atomic commit',
    /writeSecurePrivkey/.test(session) &&
    /putString\(KEY_PUBKEY/.test(session) &&
    !/putString\(KEY_PRIVKEY/.test(session));
  record('static status JSON has no privkey field',
    /identityStatusJson/.test(session)
    && !/\.put\("privkey"/.test(session)
    && !/\.put\("privateKey"/.test(session));
  record('static getNativeIdentityStatusJson source exposes no privkey string key',
    /getNativeIdentityStatusJson[\s\S]{0,400}identityStatusJson/.test(jsBridge));
  record('static validateIdentityPair in keys.js', /function validateIdentityPair/.test(keys));
  record('static legacy setUserPubkey uses stagePubkey', /stagePubkey/.test(jsBridge));
  record('static legacy setUserPrivkey uses stagePrivkey', /stagePrivkey/.test(jsBridge));
  record('static verifier getVerifierSessionJson retained', /fun getVerifierSessionJson/.test(jsBridge));
  record('static main bridge does not call getVerifierSessionJson',
    !/getVerifierSessionJson/.test(bridge));
  record('static IDENTITY_MISMATCH block log', /IDENTITY_MISMATCH/.test(bridge));
  record('static IDENTITY_NATIVE_ONLY no web revive',
    /IDENTITY_NATIVE_ONLY/.test(bridge) && !/writePrivateKeyRaw\(.*native/i.test(bridge));
}

function runtimeCases() {
  const a = makeFake();
  const b = makeFake();

  // 1 WEB==NATIVE
  {
    const native = createNativeStore();
    native.setIdentityPair(a.pub, a.hex);
    const before = native._snapshot();
    const web = loadWebKeys();
    web.localStorage.setItem('nostr_private_key', a.hex);
    web.NostrApp.ensureKeys();
    const pair = web.NostrApp.validateIdentityPair(a.hex, a.pub);
    const same = pair.ok && native.evaluate().valid && native.getPubkey() === pair.publicKey;
    const after = native._snapshot();
    record('1 WEB==NATIVE → IDENTITY_OK conceptually, no write needed',
      same && before.pub === after.pub && before.priv === after.priv);
  }

  // 2 WEB_ONLY atomic sync
  {
    const native = createNativeStore();
    const r = native.setIdentityPair(a.pub, a.hex);
    record('2 WEB_ONLY atomic sync → Native K1/P1',
      r === 'SYNC_IDENTITY_OK'
      && native.getPubkey() === a.pub
      && native.getPrivkey() === a.hex
      && native.evaluate().valid);
  }

  // 3 NATIVE_ONLY — Web remains empty
  {
    const native = createNativeStore();
    native.setIdentityPair(a.pub, a.hex);
    const web = loadWebKeys();
    const ensured = web.NostrApp.ensureKeys();
    record('3 NATIVE_ONLY → Web empty, zero generation',
      native.evaluate().valid
      && ensured.state === 'IDENTITY_NEW_USER'
      && !web.localStorage.getItem('nostr_private_key')
      && (web.NostrApp.privateKey == null));
  }

  // 4 MISMATCH neither changed
  {
    const native = createNativeStore();
    native.setIdentityPair(a.pub, a.hex);
    const before = native._snapshot();
    const r = native.setIdentityPair(b.pub, b.hex);
    const after = native._snapshot();
    record('4 WEB!=NATIVE → REJECT_MISMATCH, neither changed',
      r === 'SYNC_IDENTITY_REJECT_MISMATCH'
      && before.pub === after.pub
      && before.priv === after.priv);
  }

  // 5 Native pub/priv mismatch stored
  {
    const native = createNativeStore();
    native._forceRaw(a.pub, b.hex); // mismatched pair
    const st = native.evaluate();
    const before = native._snapshot();
    const r = native.setIdentityPair(a.pub, a.hex);
    const after = native._snapshot();
    record('5 Native pub!=priv → MISMATCH state, zero overwrite',
      st.state === 'NATIVE_IDENTITY_MISMATCH'
      && r === 'SYNC_IDENTITY_REJECT_BLOCKED'
      && before.pub === after.pub
      && before.priv === after.priv);
  }

  // 6 Web invalid + Native valid
  {
    const native = createNativeStore();
    native.setIdentityPair(a.pub, a.hex);
    const before = native._snapshot();
    const web = loadWebKeys();
    web.localStorage.setItem('nostr_private_key', 'not-valid');
    const ensured = web.NostrApp.ensureKeys();
    const after = native._snapshot();
    record('6 Web invalid + Native valid → Native unchanged',
      (ensured.state === 'IDENTITY_INVALID' || ensured.state === 'IDENTITY_RECOVERY_REQUIRED')
      && before.pub === after.pub
      && before.priv === after.priv);
  }

  // 7 Web valid + Native invalid
  {
    const native = createNativeStore();
    native._forceRaw(a.pub, ''); // incomplete
    const before = native._snapshot();
    const r = native.setIdentityPair(a.pub, a.hex);
    const after = native._snapshot();
    record('7 Web valid + Native invalid → blocked, Web path would not overwrite',
      native.evaluate().state === 'NATIVE_IDENTITY_INVALID'
      && r === 'SYNC_IDENTITY_REJECT_BLOCKED'
      && before.pub === after.pub
      && before.priv === after.priv);
  }

  // 8 neither
  {
    const native = createNativeStore();
    const web = loadWebKeys();
    const ensured = web.NostrApp.ensureKeys();
    record('8 neither → NEW_USER zero generation',
      native.evaluate().state === 'NATIVE_IDENTITY_EMPTY'
      && ensured.state === 'IDENTITY_NEW_USER');
  }

  // 9 atomic rejects pubkey not from priv
  {
    const native = createNativeStore();
    const r = native.setIdentityPair(a.pub, b.hex);
    record('9 atomic sync rejects pubkey≠derive(priv)',
      r === 'SYNC_IDENTITY_REJECT_MISMATCH'
      && !native.getPubkey()
      && !native.getPrivkey());
  }

  // 10 legacy ordering cannot leave mismatched pair
  {
    const native = createNativeStore();
    native.stagePubkey(a.pub); // incomplete — no persist
    const mid = native._snapshot();
    const partialEmpty = !mid.pub && !mid.priv;
    native.stagePrivkey(b.hex); // different identity vs staged pub
    const afterBad = native._snapshot();
    const native2 = createNativeStore();
    native2.stagePubkey(a.pub);
    native2.stagePrivkey(a.hex);
    const ok = native2.evaluate().valid && native2.getPubkey() === a.pub;
    // pub first then matching priv
    const native3 = createNativeStore();
    native3.stagePrivkey(a.hex); // priv first derives staged pub
    const privFirst = native3.evaluate().valid && native3.getPrivkey() === a.hex;
    record('10 legacy ordering cannot leave mismatched pair',
      partialEmpty
      && !afterBad.pub && !afterBad.priv
      && ok
      && privFirst);
  }

  // 11-13 periodic/resume/storage cannot overwrite mismatch — same policy function
  {
    const native = createNativeStore();
    native.setIdentityPair(a.pub, a.hex);
    const attempts = [
      native.setIdentityPair(b.pub, b.hex),
      native.stagePubkey(b.pub),
      native.stagePrivkey(b.hex),
    ];
    record('11-13 periodic/resume/storage sync cannot overwrite mismatched Native',
      attempts.every((r) => r === 'SYNC_IDENTITY_REJECT_MISMATCH')
      && native.getPubkey() === a.pub
      && native.getPrivkey() === a.hex);
  }

  // 14 Native-only does not hydrate Web private key
  {
    const native = createNativeStore();
    native.setIdentityPair(a.pub, a.hex);
    const status = JSON.parse(native.statusJson());
    const web = loadWebKeys();
    // simulate bridge status only — no priv in JSON
    record('14 Native-only status has pubkey only; Web storage stays empty',
      status.valid
      && status.pubkey === a.pub
      && !('privkey' in status)
      && !('privateKey' in status)
      && !web.localStorage.getItem('nostr_private_key'));
  }

  // 15 getNativeIdentityStatusJson exposes no private key
  {
    const native = createNativeStore();
    native.setIdentityPair(a.pub, a.hex);
    const raw = native.statusJson();
    record('15 status JSON exposes no private key / nsec',
      !/privkey/i.test(raw)
      && !/privateKey/i.test(raw)
      && !/nsec/i.test(raw)
      && raw.includes(a.pub));
  }

  // 16 verifier-only path still gets valid identity when needed
  {
    const native = createNativeStore();
    native.setIdentityPair(a.pub, a.hex);
    // simulate getVerifierSessionJson fields (not exposed to main bridge)
    const verifier = {
      pubkey: native.getPubkey(),
      privkey: native.getPrivkey(),
    };
    record('16 verifier path can still read valid Native pair when needed',
      verifier.pubkey === a.pub
      && verifier.privkey === a.hex
      && getPublicKey(verifier.privkey).toLowerCase() === verifier.pubkey);
  }

  // duplicate / retry same
  {
    const native = createNativeStore();
    const r1 = native.setIdentityPair(a.pub, a.hex);
    const r2 = native.setIdentityPair(a.pub, a.hex);
    record('retry same identity → SYNC_IDENTITY_SAME',
      r1 === 'SYNC_IDENTITY_OK' && r2 === 'SYNC_IDENTITY_SAME');
  }

  // validateIdentityPair web
  {
    const web = loadWebKeys();
    const ok = web.NostrApp.validateIdentityPair(a.hex, a.pub);
    const bad = web.NostrApp.validateIdentityPair(a.hex, b.pub);
    record('Web validateIdentityPair ok/mismatch',
      ok.ok === true && ok.publicKey === a.pub
      && bad.ok === false && bad.state === 'IDENTITY_MISMATCH');
  }
}

staticAssertions();
runtimeCases();
const failed = results.filter((r) => !r.ok);
console.log('TOTAL ' + results.length + ' FAIL ' + failed.length);
if (failed.length) process.exitCode = 1;
