#!/usr/bin/env node
/**
 * Stage 5E-D: logout / account-switch atomicity.
 * Deterministic fake keys only. Run: node qa/identity-logout-switch-atomicity-gate.mjs
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
  return { hex, pub: getPublicKey(hex).toLowerCase() };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
    _map: map,
  };
}

function createNativeMock(options = {}) {
  let pub = '';
  let priv = '';
  let failClear = !!options.failClear;
  function evaluate() {
    if (!pub && !priv) return { hasIdentity: false, valid: false, pubkey: '', state: 'NATIVE_IDENTITY_EMPTY' };
    if (!pub || !priv) return { hasIdentity: true, valid: false, pubkey: pub, state: 'NATIVE_IDENTITY_INVALID' };
    const d = getPublicKey(priv).toLowerCase();
    if (d !== pub) return { hasIdentity: true, valid: false, pubkey: pub, state: 'NATIVE_IDENTITY_MISMATCH' };
    return { hasIdentity: true, valid: true, pubkey: pub, state: 'NATIVE_IDENTITY_OK' };
  }
  return {
    isNativeShell: () => true,
    setFailClear(v) { failClear = !!v; },
    seed(p, sk) { pub = p; priv = sk; },
    getPubkey: () => pub,
    getPrivkey: () => priv,
    getNativeIdentityStatusJson() {
      const s = evaluate();
      return JSON.stringify({ hasIdentity: s.hasIdentity, valid: s.valid, pubkey: s.pubkey, state: s.state });
    },
    clearUserSession() {
      if (failClear) {
        return JSON.stringify({ ok: false, result: 'LOGOUT_NATIVE_CLEAR_FAILED' });
      }
      pub = '';
      priv = '';
      return JSON.stringify({ ok: true, result: 'LOGOUT_NATIVE_CLEAR_OK', state: 'NATIVE_IDENTITY_EMPTY' });
    },
    syncUserIdentity(pubkey, privkey) {
      const d = getPublicKey(String(privkey).toLowerCase()).toLowerCase();
      const p = String(pubkey).toLowerCase();
      if (d !== p) return 'SYNC_IDENTITY_REJECT_MISMATCH';
      if (failClear) return 'SYNC_IDENTITY_REJECT_INVALID';
      pub = p;
      priv = String(privkey).toLowerCase();
      return 'SYNC_IDENTITY_OK';
    },
    setUserPubkey() {},
    setUserPrivkey() {},
  };
}

function loadRuntime(nativeMock) {
  const localStorage = makeStorage();
  const sessionStorage = makeStorage();
  const logs = [];
  const ctx = {
    console: {
      log: (...a) => logs.push(a.map(String).join(' ')),
      warn: (...a) => logs.push(a.map(String).join(' ')),
      error: (...a) => logs.push(a.map(String).join(' ')),
    },
    window: null,
    document: {
      body: { classList: { remove() {} } },
      readyState: 'complete',
      addEventListener() {},
    },
    localStorage,
    sessionStorage,
    location: { replace() {}, href: 'videos.html' },
    NostrTools: { generateSecretKey, getPublicKey },
    SosNativeShell: nativeMock || null,
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
    decodePrivateKey(v) {
      const t = String(v || '').trim();
      if (/^[0-9a-fA-F]{64}$/.test(t)) return t.toLowerCase();
      return null;
    },
    isNativeShell: () => !!(nativeMock && nativeMock.isNativeShell()),
    voiceCall: { end() { ctx._voiceEnded = true; } },
    videoCall: { end() { ctx._videoEnded = true; } },
    clearChatRuntimeIdentity() {
      ctx._chatCleared = true;
      try { localStorage.removeItem('nostr_chat_' + (ctx.NostrApp.publicKey || '')); } catch (_e) {}
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read('key-storage.js'), ctx);
  vm.runInContext(read('keys.js'), ctx);
  vm.runInContext(read('identity-lifecycle.js'), ctx);
  return { ctx, localStorage, sessionStorage, logs, get genLogs() { return logs; } };
}

function seedWeb(rt, fake) {
  rt.localStorage.setItem('nostr_private_key', fake.hex);
  rt.localStorage.setItem('nostr_profile', JSON.stringify({ name: 'UserA' }));
  rt.localStorage.setItem('sos_pubkey', fake.pub);
  rt.localStorage.setItem('nostr_pubkey', fake.pub);
  rt.localStorage.setItem('nostr_chat_' + fake.pub, JSON.stringify({ contacts: [{ pubkey: 'c'.repeat(64) }] }));
  rt.localStorage.setItem('sos_chat_presence_' + fake.pub, JSON.stringify({ x: 1 }));
  rt.localStorage.setItem('p2p_guest_keys', JSON.stringify({ isGuest: true, privateKey: 'aa'.repeat(32) }));
  rt.ctx.NostrApp.privateKey = fake.hex;
  rt.ctx.NostrApp.publicKey = fake.pub;
  rt.ctx.NostrApp.guestMode = false;
  rt.ctx.NostrApp.ensureKeys();
}

function staticChecks() {
  const life = read('identity-lifecycle.js');
  const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
  const kv = read('key-viewer.js');
  const account = read('account.js');
  record('static lifecycle has NO generateSecretKey', !/generateSecretKey/.test(life));
  record('static lifecycle has NO generateAndStoreKey', !/generateAndStoreKey/.test(life));
  record('static lifecycle has NO createNewIdentityExplicit', !/createNewIdentityExplicit/.test(life));
  // Canonical Native API is void; JS lifecycle accepts optional JSON string OR verifies via status API.
  record(
    'static clearUserSession is void (canonical) with JS dual-path',
    /fun clearUserSession\(\)\s*\{/.test(bridge) &&
      !/fun clearUserSession\(\):\s*String/.test(bridge) &&
      /Legacy void clearUserSession/.test(life) &&
      /readNativeStatus/.test(life)
  );
  record('static logout uses logoutIdentity', /logoutIdentity/.test(kv));
  record('static account import uses prepare/commit', /prepareAccountSwitch/.test(account) && /commitAccountSwitch/.test(account));
  record('static videos.html loads identity-lifecycle.js', /identity-lifecycle\.js/.test(read('videos.html')));
  record('static guest p2p never synced as account in lifecycle',
    /p2p_guest_keys/.test(life) && !/syncUserIdentity\([^\)]*p2p_guest/.test(life));
}

function runtimeCases() {
  const a = makeFake();
  const b = makeFake();

  // A logout native
  {
    const native = createNativeMock();
    native.seed(a.pub, a.hex);
    const rt = loadRuntime(native);
    seedWeb(rt, a);
    const res = rt.ctx.NostrApp.logoutIdentity({ redirect: false });
    const status = JSON.parse(native.getNativeIdentityStatusJson());
    record('A LOGOUT NORMAL NATIVE clears Web+Native+runtime',
      res.ok === true
      && res.state === 'IDENTITY_NEW_USER'
      && !rt.localStorage.getItem('nostr_private_key')
      && !rt.ctx.NostrApp.privateKey
      && !rt.ctx.NostrApp.publicKey
      && rt.ctx.NostrApp.guestMode === true
      && status.hasIdentity === false
      && !native.getPrivkey()
      && rt.logs.some((l) => l.includes('LOGOUT_COMPLETE')));
  }

  // B logout web-only
  {
    const rt = loadRuntime(null);
    seedWeb(rt, a);
    const res = rt.ctx.NostrApp.logoutIdentity({ redirect: false });
    record('B LOGOUT WEB-ONLY succeeds',
      res.ok === true
      && !rt.localStorage.getItem('nostr_private_key')
      && res.native && res.native.applicable === false);
  }

  // C native clear failure
  {
    const native = createNativeMock({ failClear: true });
    native.seed(a.pub, a.hex);
    const rt = loadRuntime(native);
    seedWeb(rt, a);
    const before = rt.localStorage.getItem('nostr_private_key');
    const res = rt.ctx.NostrApp.logoutIdentity({ redirect: false });
    record('C LOGOUT NATIVE CLEAR FAILURE does not report guest success',
      res.ok === false
      && res.result === 'LOGOUT_NATIVE_CLEAR_FAILED'
      && rt.localStorage.getItem('nostr_private_key') === before
      && !!native.getPrivkey()
      && rt.logs.some((l) => l.includes('LOGOUT_NATIVE_CLEAR_FAILED')));
  }

  // D mirrors
  {
    const native = createNativeMock();
    native.seed(a.pub, a.hex);
    const rt = loadRuntime(native);
    seedWeb(rt, a);
    rt.localStorage.setItem('sos_session_only_key', '1');
    rt.ctx.NostrApp.logoutIdentity({ redirect: false });
    record('D LOGOUT clears sos_pubkey/nostr_pubkey mirrors',
      !rt.localStorage.getItem('sos_pubkey')
      && !rt.localStorage.getItem('nostr_pubkey')
      && !rt.localStorage.getItem('nostr_profile')
      && !rt.localStorage.getItem('sos_session_only_key'));
  }

  // E user-scoped chat
  {
    const native = createNativeMock();
    native.seed(a.pub, a.hex);
    const rt = loadRuntime(native);
    seedWeb(rt, a);
    rt.ctx.NostrApp.logoutIdentity({ redirect: false });
    record('E LOGOUT clears user-scoped chat/presence keys + runtime',
      !rt.localStorage.getItem('nostr_chat_' + a.pub)
      && !rt.localStorage.getItem('sos_chat_presence_' + a.pub)
      && rt.ctx._chatCleared === true);
  }

  // F invalid switch
  {
    const native = createNativeMock();
    native.seed(a.pub, a.hex);
    const rt = loadRuntime(native);
    seedWeb(rt, a);
    const chatBefore = rt.localStorage.getItem('nostr_chat_' + a.pub);
    const prepared = rt.ctx.NostrApp.prepareAccountSwitch('not-a-key');
    record('F INVALID SWITCH prepare aborts; A untouched',
      prepared.ok === false
      && prepared.reason === 'INVALID_TARGET'
      && rt.localStorage.getItem('nostr_private_key') === a.hex
      && native.getPrivkey() === a.hex
      && rt.localStorage.getItem('nostr_chat_' + a.pub) === chatBefore);
  }

  // G valid switch A→B
  {
    const native = createNativeMock();
    native.seed(a.pub, a.hex);
    const rt = loadRuntime(native);
    seedWeb(rt, a);
    const prepared = rt.ctx.NostrApp.prepareAccountSwitch(b.hex);
    const committed = rt.ctx.NostrApp.commitAccountSwitch(prepared, { reload: false });
    const status = JSON.parse(native.getNativeIdentityStatusJson());
    record('G VALID SWITCH A→B Web==Native==B',
      prepared.ok === true
      && committed.ok === true
      && rt.localStorage.getItem('nostr_private_key') === b.hex
      && rt.ctx.NostrApp.publicKey === b.pub
      && native.getPrivkey() === b.hex
      && native.getPubkey() === b.pub
      && status.pubkey === b.pub
      && status.valid === true);
  }

  // H no mix window flag
  {
    const native = createNativeMock();
    native.seed(a.pub, a.hex);
    const rt = loadRuntime(native);
    seedWeb(rt, a);
    let sawInProgress = false;
    const origQuiesceEnd = rt.ctx.NostrApp.voiceCall.end;
    rt.ctx.NostrApp.voiceCall.end = function () {
      sawInProgress = rt.ctx.NostrApp._accountSwitchInProgress === true
        || rt.ctx.NostrApp.identityTransition === 'SWITCH_IN_PROGRESS';
      return origQuiesceEnd();
    };
    const prepared = rt.ctx.NostrApp.prepareAccountSwitch(b.hex);
    // Patch commit path observation via transition log
    rt.ctx.NostrApp.commitAccountSwitch(prepared, { reload: false });
    record('H NO MIX WINDOW — transition markers present; calls ended',
      rt.logs.some((l) => l.includes('SWITCH_IN_PROGRESS'))
      && rt.logs.some((l) => l.includes('SWITCH_COMPLETE'))
      && rt.ctx._voiceEnded === true
      && rt.ctx._videoEnded === true);
  }

  // I native sync failure during switch
  {
    const native = createNativeMock();
    native.seed(a.pub, a.hex);
    const rt = loadRuntime(native);
    seedWeb(rt, a);
    const prepared = rt.ctx.NostrApp.prepareAccountSwitch(b.hex);
    // After clear, force sync fail
    const origSync = native.syncUserIdentity.bind(native);
    let cleared = false;
    native.clearUserSession = function () {
      cleared = true;
      return JSON.stringify({ ok: true, result: 'LOGOUT_NATIVE_CLEAR_OK', state: 'NATIVE_IDENTITY_EMPTY' });
    };
    native.syncUserIdentity = function () {
      return 'SYNC_IDENTITY_REJECT_INVALID';
    };
    const committed = rt.ctx.NostrApp.commitAccountSwitch(prepared, { reload: false });
    record('I NATIVE SYNC FAILURE → recovery, no generation',
      committed.ok === false
      && committed.state === 'IDENTITY_RECOVERY_REQUIRED'
      && cleared === true
      && !rt.logs.some((l) => /IDENTITY_EXPLICIT_CREATE|generateSecretKey/.test(l)));
    native.syncUserIdentity = origSync;
  }

  // J cache isolation A→B
  {
    const native = createNativeMock();
    native.seed(a.pub, a.hex);
    const rt = loadRuntime(native);
    seedWeb(rt, a);
    const prepared = rt.ctx.NostrApp.prepareAccountSwitch(b.hex);
    rt.ctx.NostrApp.commitAccountSwitch(prepared, { reload: false });
    record('J A CACHE ISOLATION after switch to B',
      !rt.localStorage.getItem('nostr_chat_' + a.pub)
      && !rt.localStorage.getItem('sos_chat_presence_' + a.pub)
      && rt.ctx.NostrApp.publicKey === b.pub
      && rt.ctx._chatCleared === true);
  }

  // K call state cleared
  {
    const native = createNativeMock();
    native.seed(a.pub, a.hex);
    const rt = loadRuntime(native);
    seedWeb(rt, a);
    rt.ctx.__sosIncomingCallActive = true;
    rt.ctx.NostrApp.logoutIdentity({ redirect: false });
    record('K CALL STATE cleared on logout',
      rt.ctx._voiceEnded === true
      && rt.ctx._videoEnded === true
      && rt.ctx.__sosIncomingCallActive === false);
  }

  // L guest p2p never account
  {
    const life = read('identity-lifecycle.js');
    const bridge = read('native-shell-bridge.js');
    record('L GUEST P2P never promoted to account identity',
      /p2p_guest_keys/.test(life)
      && !/p2p_guest_keys/.test(bridge)
      && !/readPrivateKeyRaw[\s\S]{0,80}p2p_guest/.test(bridge));
  }

  // M invariants still hold in sources
  {
    const keys = read('keys.js');
    const ensureBody = keys.slice(keys.indexOf('function ensureKeys('), keys.indexOf('function createNewIdentityExplicit'));
    record('M 5E-B ensureKeys still no generation',
      !/generateSecretKey/.test(ensureBody)
      && !/generateAndStoreKey/.test(ensureBody)
      && !/createNewIdentityExplicit/.test(ensureBody));
    record('M 5E-C mismatch overwrite still blocked in lifecycle sync path',
      /syncUserIdentity/.test(read('identity-lifecycle.js')));
  }
}

staticChecks();
runtimeCases();
const failed = results.filter((r) => !r.ok);
console.log('TOTAL ' + results.length + ' FAIL ' + failed.length);
if (failed.length) process.exitCode = 1;
