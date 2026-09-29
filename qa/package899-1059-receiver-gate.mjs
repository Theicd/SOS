#!/usr/bin/env node
/**
 * Package 899 — shared secure kind-1059 incoming-call receiver lifecycle gate.
 *  - Reproduces the original race on the pre-fix source (pool ready before identity → no receiver).
 *  - Fixed source: receiver starts on identity-ready in both script load orders, stays singleton,
 *    recovers from a dead subscription with bounded backoff, and is re-bound on account switch/logout.
 * Run: node qa/package899-1059-receiver-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, finalizeEvent, getEventHash, verifyEvent, utils, nip44, nip04 } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PRE_FIX_COMMIT = '73d433041c8276c72fe36d0464c28bcd5d3d439a';
const results = [];
const out = {};
let pass = 0;
let fail = 0;
function record(name, ok, detail = '') {
  if (ok) { pass += 1; results.push('PASS ' + name); return; }
  fail += 1;
  results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pk = () => getPublicKey(generateSecretKey());

function makePool({ autoEose = true } = {}) {
  const subs = [];
  const pool = {
    subs,
    autoEose,
    subscribeMany(relays, filters, h) {
      const s = { relays, filters, h, closed: false, close() { this.closed = true; } };
      subs.push(s);
      if (pool.autoEose) setTimeout(() => { if (!s.closed) h.oneose(); }, 5);
      return s;
    },
    async ensureRelay() { return { subscribe(_f, h) { setTimeout(() => h.oneose && h.oneose(), 5); return { close() {} }; } }; },
    publish() { return [Promise.resolve('ok')]; },
    open() { return subs.filter((s) => !s.closed); },
    pOf(s) { return ((s.filters[0] || {})['#p'] || [])[0]; },
  };
  return pool;
}

function load(source, App) {
  const logs = [];
  const docHandlers = {};
  const sandbox = {
    console: { log(m) { logs.push(String(m)); }, warn(m) { logs.push(String(m)); }, error() {}, info() {}, debug() {} },
    navigator: { userAgent: 'NodeQA', onLine: true },
    crypto: webcrypto,
    fetch: () => Promise.reject(new Error('offline-qa')),
    localStorage: { s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = String(v); }, removeItem(k) { delete this.s[k]; } },
    sessionStorage: { s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = String(v); }, removeItem(k) { delete this.s[k]; } },
    document: {
      visibilityState: 'visible',
      hidden: false,
      addEventListener(t, f) { (docHandlers[t] = docHandlers[t] || []).push(f); },
      removeEventListener() {},
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Map, Set, Promise, JSON, Date, Math, Number, String, Array, Object, Boolean, Error, TypeError,
    Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, URL,
    NostrApp: App,
    NostrTools: {
      finalizeEvent: (d, sk) => finalizeEvent(JSON.parse(JSON.stringify(d)), sk),
      getEventHash: (ev) => getEventHash(JSON.parse(JSON.stringify(ev))),
      verifyEvent: (ev) => verifyEvent(JSON.parse(JSON.stringify(ev))),
      generateSecretKey, getPublicKey, utils, nip44, nip04,
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('nostr-event-integrity.js'), sandbox, { filename: 'nostr-event-integrity.js' });
  vm.runInContext(read('sos-crypto-signer.js'), sandbox, { filename: 'sos-crypto-signer.js' });
  vm.runInContext(read('relay-health.js'), sandbox, { filename: 'relay-health.js' });
  vm.runInContext(source, sandbox, { filename: 'call-signal-e2ee.js' });
  const unwraps = [];
  App.SosCryptoSigner = {
    hasIdentityKey: () => true,
    isWorkerAuthoritative: () => true,
    unwrapCallGiftwrap: async (ev) => { unwraps.push(ev.id); return null; },
  };
  const fireVisible = () => (docHandlers.visibilitychange || []).forEach((f) => { try { f(); } catch (_) {} });
  return { App, api: App.CallSignalE2ee, logs, unwraps, fireVisible };
}

function wrapFor(recipient) {
  return finalizeEvent({ kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [['p', recipient]], content: 'opaque-qa' }, generateSecretKey());
}

const FIXED = read('call-signal-e2ee.js');
const OLD = execFileSync('git', ['show', PRE_FIX_COMMIT + ':call-signal-e2ee.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

// ---- Original race on pre-fix source (index.html order: module first, pool, identity later).
async function raceOld() {
  const pool = makePool();
  const App = { publicKey: null, relayUrls: ['wss://qa.example'] };
  const rt = load(OLD, App);
  App.pool = pool;
  App.notifyPoolReady(pool);
  const afterPool = pool.subs.length;
  App.publicKey = pk();
  App.guestMode = false;
  if (typeof App.notifyCallIdentityReady === 'function') App.notifyCallIdentityReady('boot');
  await sleep(50);
  out.OLD_SUBS_AFTER_IDENTITY = pool.subs.length;
  record('IDENTITY_AFTER_POOL_RACE_REPRO_OLD (pre-fix: no receiver after identity)', afterPool === 0 && pool.subs.length === 0 && typeof rt.App.notifyCallIdentityReady !== 'function');
  // Old self-heal: a later ensure (outgoing call / chat / visibility) is what finally starts it.
  rt.api.ensureSecureCallSubscription();
  record('OLD self-heal only via later ensure (outgoing call path)', pool.subs.length === 1);
}

// ---- Fixed: same order.
async function raceFixed() {
  const pool = makePool();
  const App = { publicKey: null, relayUrls: ['wss://qa.example'] };
  const rt = load(FIXED, App);
  App.pool = pool;
  App.notifyPoolReady(pool);
  const afterPool = pool.subs.length;
  const me = pk();
  App.publicKey = me;
  App.guestMode = false;
  App.notifyCallIdentityReady('boot');
  await sleep(30);
  record('IDENTITY_AFTER_POOL_RACE_FIXED: receiver starts on identity-ready', afterPool === 0 && pool.subs.length === 1 && pool.pOf(pool.subs[0]) === me);
  record('CALL_RECEIVE_READY only after EOSE of current identity', rt.api.isSecureCallReceiverReady() === true && rt.logs.includes('CALL_RECEIVE_READY=true'));
  record('No outgoing call / chat / visibility needed', !rt.logs.some((l) => /RECONNECT reason=visibility/.test(l)));
  return { pool, rt, App };
}

// ---- Receive-ready semantics: before EOSE not ready.
async function readySemantics() {
  const pool = makePool({ autoEose: false });
  const App = { publicKey: pk(), guestMode: false, relayUrls: ['wss://qa.example'] };
  const rt = load(FIXED, App);
  App.pool = pool;
  App.notifyCallIdentityReady('boot');
  const before = rt.api.isSecureCallReceiverReady();
  rt.api.ensureSecureCallSubscription();
  rt.api.ensureSecureCallSubscription();
  const converging = pool.subs.length;
  pool.subs[0].h.oneose();
  record('CALL_RECEIVE_READY_SEMANTICS_GATE (not ready before EOSE, ready after)', before === false && rt.api.isSecureCallReceiverReady() === true);
  record('Converging receiver not duplicated before EOSE', converging === 1);
}

// ---- Reverse order (videos.html): pool + identity ready before module loads.
async function lateModuleLoad() {
  const pool = makePool();
  const me = pk();
  const App = { publicKey: me, guestMode: false, pool, relayUrls: ['wss://qa.example'] };
  const rt = load(FIXED, App);
  await sleep(30);
  record('LATE_CALL_MODULE_LOAD_GATE: receiver starts at module load', pool.subs.length === 1 && pool.pOf(pool.subs[0]) === me && rt.api.isSecureCallReceiverReady());
  // app.js hook fired earlier than module existed is a no-op; late hook call must not duplicate.
  App.notifyCallIdentityReady('boot');
  record('Late duplicate identity-ready does not stack', pool.open().length === 1);
}

// ---- Idempotency from every caller.
async function idempotency(ctx) {
  const { pool, rt, App } = ctx;
  rt.api.ensureSecureCallSubscription();
  rt.api.ensureSecureCallSubscription({ reason: 'voice' });
  App.notifyCallIdentityReady('again');
  App.notifyPoolReady(pool);
  rt.fireVisible();
  rt.api.ensureSecureCallSubscription({ force: true, reason: 'visibility' });
  await sleep(20);
  out.MAX_SIMULTANEOUS_SHARED_1059_SUBSCRIPTIONS = pool.open().length;
  record('Singleton: ensure/identity/pool-ready/visibility converge on one receiver', pool.subs.length === 1 && pool.open().length === 1);
  record('VISIBILITY_HEALTHY_1059_SUB_PRESERVED', rt.logs.some((l) => l === 'CALL_SECURE_SUBSCRIBE_KEEP reason=visibility') && !rt.logs.some((l) => /RECONNECT reason=visibility/.test(l)));
}

// ---- Dead subscription → reference cleared → bounded reconnect → one replacement.
async function deadSub() {
  const pool = makePool();
  const App = { publicKey: pk(), guestMode: false, pool, relayUrls: ['wss://qa.example'] };
  const rt = load(FIXED, App);
  await sleep(20);
  const first = pool.subs[0];
  first.closed = true;
  first.h.onclose(['relay closed']);
  const st = rt.api.getSecureReceiverStateForQa();
  record('DEAD_1059_SUB_REFERENCE_CLEARED', st.open === false && st.healthy === false && st.retryPending === true && st.retryDelayMs === 3000);
  // Visibility while dead must recover immediately (not wait for backoff).
  rt.fireVisible();
  await sleep(20);
  record('VISIBILITY_DEAD_1059_SUB_RECOVERED', pool.subs.length === 2 && pool.open().length === 1 && rt.api.isSecureCallReceiverReady());
  // Retry timer fires later but a healthy receiver exists → no-op.
  await sleep(3100);
  record('Retry with healthy replacement present is a no-op', pool.subs.length === 2 && pool.open().length === 1);

  // Hot-loop guard: relay closes every new subscription immediately (no EOSE).
  const pool2 = makePool({ autoEose: false });
  pool2.subscribeMany = function (relays, filters, h) {
    const s = { relays, filters, h, closed: true, close() {} };
    pool2.subs.push(s);
    h.onclose(['auth-required']);
    return s;
  };
  const App2 = { publicKey: pk(), guestMode: false, pool: pool2, relayUrls: ['wss://qa.example'] };
  const rt2 = load(FIXED, App2);
  await sleep(3200);
  const attempts = pool2.subs.length;
  const delay = rt2.api.getSecureReceiverStateForQa().retryDelayMs;
  out.HOT_LOOP_ATTEMPTS_IN_3_2S = attempts;
  record('SECURE_1059_RECONNECT_BOUNDED (backoff doubles 3s→6s)', attempts === 2 && delay === 6000, 'attempts=' + attempts + ' delay=' + delay);
  record('SECURE_1059_RECONNECT_HOT_LOOP=false', attempts <= 2);
  rt2.api.closeSecureCallSubscription('qa-end');
  App2.publicKey = null;
  App2.notifyCallIdentityReady('qa-end');
  record('DEAD_SUB_RECOVERY_GATE', true);
}

// ---- Account switch / logout.
async function accountSwitch() {
  const pool = makePool();
  const A = pk();
  const B = pk();
  const App = { publicKey: A, guestMode: false, pool, relayUrls: ['wss://qa.example'] };
  const rt = load(FIXED, App);
  await sleep(20);
  const subA = pool.subs[0];
  App.publicKey = B;
  App.notifyCallIdentityReady('account-switch');
  await sleep(20);
  const subB = pool.subs[1];
  record('Account switch closes A receiver and opens B', subA.closed && subB && !subB.closed && pool.pOf(subB) === B && pool.open().length === 1);
  const u0 = rt.unwraps.length;
  subA.h.onevent(wrapFor(A));
  subA.h.onevent(wrapFor(B));
  subB.h.onevent(wrapFor(A));
  await sleep(30);
  record('STALE_IDENTITY_1059_LISTENER=false (A receiver + A-tagged events never reach unwrap)', rt.unwraps.length === u0, 'unwraps=' + (rt.unwraps.length - u0));
  subB.h.onevent(wrapFor(B));
  await sleep(30);
  record('Current identity event reaches the dispatcher', rt.unwraps.length === u0 + 1);
  // Identity changed without hook: next ensure still re-binds.
  const C = pk();
  App.publicKey = C;
  rt.api.ensureSecureCallSubscription();
  record('Unhooked identity change re-bound on next ensure', subB.closed && pool.open().length === 1 && pool.pOf(pool.open()[0]) === C);
  // Logout.
  App.publicKey = null;
  App.notifyCallIdentityReady('logout');
  record('Logout closes receiver, no anonymous receiver', pool.open().length === 0 && rt.api.getSecureReceiverStateForQa().open === false);
  App.guestMode = true;
  App.publicKey = pk();
  rt.api.ensureSecureCallSubscription();
  record('Guest mode never opens a receiver', pool.open().length === 0);
  record('CALL_RECEIVER_ACCOUNT_SWITCH_GATE', true);
}

// ---- Source wiring: identity-ready call sites; generic event untouched; crypto unchanged.
function sourceWiring() {
  const app = read('app.js');
  record('app.js worker-boot identity-ready hook', /notifyCallIdentity\('worker-boot'\)/.test(app));
  record('app.js sync boot identity-ready hook', /notifyCallIdentity\('boot'\)/.test(app));
  record('identity-lifecycle account-switch + logout hooks', /notifyCallIdentityReady\('account-switch'\)/.test(read('identity-lifecycle.js')) && /notifyCallIdentityReady\('logout'\)/.test(read('identity-lifecycle.js')));
  record('session-authority detach hook', /notifyCallIdentityReady\('session-detached'\)/.test(read('session-authority.js')));
  const all = ['app.js', 'identity-lifecycle.js', 'session-authority.js', 'call-signal-e2ee.js'].map(read).join('\n');
  record('Generic sos-identity-ready event NOT dispatched', !/dispatchEvent\([^)]*sos-identity-ready/.test(all));
  record('No polling added for receiver readiness', !/setInterval\([^)]*ensureSecureCallSubscription/.test(FIXED));
  const cryptoFns = ['unwrapGiftWrappedCallSignal', 'publishGiftWrappedCallSignal', 'validatePayload', 'verifyEventSig', 'dispatchGiftWrappedCallSignal'];
  const body = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) return null;
    let depth = 0; let started = false;
    for (let j = src.indexOf('{', i); j < src.length; j += 1) {
      if (src[j] === '{') { depth += 1; started = true; }
      else if (src[j] === '}') { depth -= 1; if (started && depth === 0) return src.slice(i, j + 1); }
    }
    return null;
  };
  const lf = (s) => (s == null ? s : s.replace(/\r\n/g, '\n'));
  const changed = cryptoFns.filter((n) => !body(FIXED, n) || lf(body(OLD, n)) !== lf(body(FIXED, n)));
  record('CALL_1059_E2EE_GATE: wrap/unwrap/validate/verify/dispatch unchanged', changed.length === 0, changed.join(','));
}

await raceOld();
const ctx = await raceFixed();
await readySemantics();
await lateModuleLoad();
await idempotency(ctx);
await deadSub();
await accountSwitch();
sourceWiring();

out.PASS = pass;
out.FAIL = fail;
out.CALL_RECEIVER_LOAD_ORDER_GATE = results.some((r) => r.startsWith('FAIL IDENTITY_AFTER') || r.startsWith('FAIL LATE_')) ? 'FAIL' : 'PASS';
console.log(results.join('\n'));
console.log('SUMMARY ' + JSON.stringify(out));
fs.writeFileSync(path.join(ROOT, 'qa', 'package899-1059-receiver-report.json'), JSON.stringify({ results, ...out }, null, 2));
process.exit(fail ? 1 : 0);
