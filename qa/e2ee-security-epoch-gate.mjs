#!/usr/bin/env node
/**
 * E3A3 — Client security epoch / forced cutover gate.
 * Does not activate minSecureChatEpoch; does not enable encrypted send.
 * Run: node qa/e2ee-security-epoch-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let pass = 0;
let fail = 0;

function record(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name);
    return;
  }
  fail += 1;
  results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function loadEpochApi(overrides = {}) {
  const store = Object.create(null);
  const session = Object.create(null);
  const root = {
    NostrApp: {
      SOS_SECURE_CHAT_EPOCH: 1,
      ...(overrides.App || {}),
    },
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    sessionStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(session, k) ? session[k] : null),
      setItem: (k, v) => { session[k] = String(v); },
      removeItem: (k) => { delete session[k]; },
    },
    fetch: overrides.fetch,
    BroadcastChannel: overrides.BroadcastChannel,
    document: overrides.document,
    navigator: overrides.navigator || {},
    location: overrides.location || { reload() {}, href: 'http://local/videos.html' },
    addEventListener() {},
    console,
  };
  if (overrides.__qaSecureEpochFetch) {
    root.NostrApp.__qaSecureEpochFetch = overrides.__qaSecureEpochFetch;
  }
  if (typeof overrides.__qaSecureChatEpochOverride === 'number') {
    root.NostrApp.__qaSecureChatEpochOverride = overrides.__qaSecureChatEpochOverride;
  }
  const code = read('chat-secure-epoch.js');
  vm.runInNewContext(code, root, { filename: 'chat-secure-epoch.js' });
  return { api: root.SosSecureChatEpoch, App: root.NostrApp, root, store, session };
}

// --- Static wiring ---
const e2ee = read('chat-e2ee.js');
const epochSrc = read('chat-secure-epoch.js');
const svc = read('chat-service.js');
const sw = read('service-worker.js');
const pwa = read('pwa-installer.js');
const videos = read('videos.html');
const indexHtml = read('index.html');
const storage = read('storage.html');
const appVer = JSON.parse(read('app-version.json'));

record('SOS_SECURE_CHAT_EPOCH=2 in chat-e2ee.js', /SOS_SECURE_CHAT_EPOCH\s*=\s*2/.test(e2ee));
record('SOS_SECURE_CHAT_EPOCH exported on App', e2ee.includes('SOS_SECURE_CHAT_EPOCH'));
record('chat-secure-epoch.js present', epochSrc.includes('decideSecureChatGate') && epochSrc.includes('ensureSecureChatEpochReady'));
record('GATE_STATES include READY/UPDATE_REQUIRED/CHECK_FAILED/CHECKING',
  ['CHECKING', 'READY', 'UPDATE_REQUIRED', 'CHECK_FAILED'].every((s) => epochSrc.includes(s)));
record('no Later dismiss on secure blocker',
  epochSrc.includes('עדכן עכשיו') && epochSrc.includes('No "Later"') && !/#sos-secure-epoch[\s\S]*אח״כ/.test(epochSrc));
record('bounded reload attempts', epochSrc.includes('MAX_RELOAD_ATTEMPTS') && epochSrc.includes('MAX_RELOAD_ATTEMPTS = 3'));
record('BroadcastChannel SECURE_UPDATE_REQUIRED', epochSrc.includes('SECURE_UPDATE_REQUIRED'));
record('monotonic last-known min', epochSrc.includes('Monotonic') && epochSrc.includes('sos_secure_chat_min_epoch'));

record('videos.html loads epoch before chat-service', (() => {
  const a = videos.indexOf('chat-e2ee.js');
  const b = videos.indexOf('chat-secure-epoch.js');
  const c = videos.indexOf('chat-service.js');
  return a >= 0 && b > a && c > b;
})());
record('index.html loads chat-secure-epoch.js', indexHtml.includes('chat-secure-epoch.js'));
record('storage.html loads chat-secure-epoch.js', storage.includes('chat-secure-epoch.js'));

record('chat-service awaits ensureSecureChatEpochReady before subscribe',
  svc.includes('chat bootstrap deferred') &&
  svc.includes('await App.ensureSecureChatEpochReady()') &&
  /epochReady[\s\S]{0,200}subscribeToChatEvents/.test(svc));
record('subscribeToChatEvents gated by isSecureChatReady',
  /function subscribeToChatEvents\(\) \{[\s\S]{0,280}isSecureChatReady/.test(svc));
record('publishChatMessage gated before serialize/publish', (() => {
  const iFn = svc.indexOf('async function publishChatMessage');
  const iErr = svc.indexOf("error: 'secure-update-required'");
  const iSer = svc.indexOf('serializeChatMessageContent', iFn);
  const iPub = svc.indexOf('pool.publish', iFn);
  return iFn >= 0 && iErr > iFn && iErr < iSer && iErr < iPub;
})());
record('LIVE_E2EE_SEND=true (E3B ACTIVE; e2eeSendRequired explicit true)',
  svc.includes('isE2eeSendRequired') &&
  svc.includes('encryptPrivateChatPayload') &&
  Object.prototype.hasOwnProperty.call(appVer, 'e2eeSendRequired') && appVer.e2eeSendRequired === true);
record('E2 dual-read still present', svc.includes('decryptPrivateChatPayload') && svc.includes('looksLikeIncomingE2eeContent'));

record('SW cache bumped for video session adopt', /sos-cache-v856/.test(sw));
record('SW precaches chat-e2ee.js', sw.includes("'./chat-e2ee.js'"));
record('SW precaches chat-secure-epoch.js', sw.includes("'./chat-secure-epoch.js'"));
record('app-version.json still bypasses SW', sw.includes("app-version.json") && sw.includes('return'));
record('minSecureChatEpoch activated =2 in app-version.json',
  Object.prototype.hasOwnProperty.call(appVer, 'minSecureChatEpoch') &&
  Number(appVer.minSecureChatEpoch) === 2);
record('e2eeSendRequired explicit true (E3B ACTIVE)',
  Object.prototype.hasOwnProperty.call(appVer, 'e2eeSendRequired') && appVer.e2eeSendRequired === true);
record('normal PWA Later toast still exists', pwa.includes('pwa-update-toast__later') && pwa.includes('UPDATE_LATER_KEY'));
record('prepareCleanReloadAfterUiUpdate exposed', pwa.includes('prepareCleanReloadAfterUiUpdate'));

// --- Behavioral: inactive cutover ---
{
  const { api } = loadEpochApi();
  const d1 = api.decideSecureChatGate({ localEpoch: 1, remoteMin: 0, lastKnownMin: 0, fetchOk: true });
  record('inactive remoteMin=0 → READY', d1.state === 'READY' && d1.required === 0);
  const d2 = api.decideSecureChatGate({ localEpoch: 1, remoteMin: 0, lastKnownMin: 0, fetchOk: false });
  record('inactive fetch fail never-activated → READY', d2.state === 'READY');
}

{
  const { api, App } = loadEpochApi({
    __qaSecureEpochFetch: async () => ({
      ok: true,
      json: async () => ({ version: 'test', /* no minSecureChatEpoch */ }),
    }),
  });
  await App.ensureSecureChatEpochReady({ skipAutoReload: true, silentUi: true });
  record('inactive absent field evaluate → READY', App.isSecureChatReady() === true && App.getSecureChatGateState() === 'READY');
}

// --- Matched epoch ---
{
  const { api } = loadEpochApi();
  const d = api.decideSecureChatGate({ localEpoch: 1, remoteMin: 1, lastKnownMin: 0, fetchOk: true });
  record('matched remoteMin=1 local=1 → READY', d.state === 'READY' && d.required === 1);
}

{
  const { App } = loadEpochApi({
    __qaSecureEpochFetch: async () => ({
      ok: true,
      json: async () => ({ version: 'test', minSecureChatEpoch: 1 }),
    }),
  });
  const ok = await App.ensureSecureChatEpochReady({ skipAutoReload: true, silentUi: true });
  record('matched evaluate → READY + subscribe allowed', ok === true && App.isSecureChatReady());
}

// --- Stale client ---
{
  const { api } = loadEpochApi();
  const d = api.decideSecureChatGate({ localEpoch: 0, remoteMin: 1, lastKnownMin: 0, fetchOk: true });
  record('stale local=0 remote=1 → UPDATE_REQUIRED', d.state === 'UPDATE_REQUIRED' && d.required === 1);
}

{
  const { App } = loadEpochApi({
    __qaSecureChatEpochOverride: 0,
    __qaSecureEpochFetch: async () => ({
      ok: true,
      json: async () => ({ version: 'test', minSecureChatEpoch: 1 }),
    }),
  });
  const ok = await App.ensureSecureChatEpochReady({ skipAutoReload: true, silentUi: true });
  record('stale evaluate → blocked', ok === false && App.getSecureChatGateState() === 'UPDATE_REQUIRED' && !App.isSecureChatReady());
}

// --- Future epoch ---
{
  const { api } = loadEpochApi();
  const d = api.decideSecureChatGate({ localEpoch: 1, remoteMin: 2, lastKnownMin: 0, fetchOk: true });
  record('future remoteMin=2 local=1 → UPDATE_REQUIRED', d.state === 'UPDATE_REQUIRED' && d.required === 2);
}

// --- Network failure after known active ---
{
  const { api, App, store } = loadEpochApi({
    __qaSecureEpochFetch: async () => { throw new Error('offline'); },
  });
  store.sos_secure_chat_min_epoch = '1';
  const ok = await App.ensureSecureChatEpochReady({ skipAutoReload: true, silentUi: true });
  record('known-active fetch fail → fail-closed',
    ok === false &&
    (App.getSecureChatGateState() === 'CHECK_FAILED' || App.getSecureChatGateState() === 'UPDATE_REQUIRED'));
}

// --- Downgrade protection ---
{
  const { api, store } = loadEpochApi();
  store.sos_secure_chat_min_epoch = '1';
  const kept = api.writeLastKnownMinEpoch(0);
  record('downgrade remote/config 0 cannot lower known min', kept === 1 && api.readLastKnownMinEpoch() === 1);
  const d = api.decideSecureChatGate({ localEpoch: 1, remoteMin: 0, lastKnownMin: 1, fetchOk: true });
  record('decision retains required>=1 when known=1 even if remote 0', d.required === 1);
}

// --- parseRemoteMin ---
{
  const { api } = loadEpochApi();
  record('parse absent → 0', api.parseRemoteMinSecureChatEpoch({ version: 'x' }) === 0);
  record('parse 0 → 0', api.parseRemoteMinSecureChatEpoch({ minSecureChatEpoch: 0 }) === 0);
  record('parse 1 → 1', api.parseRemoteMinSecureChatEpoch({ minSecureChatEpoch: 1 }) === 1);
  record('parse junk → 0', api.parseRemoteMinSecureChatEpoch({ minSecureChatEpoch: 'nope' }) === 0);
}

// --- Multi-tab broadcast shape ---
{
  const messages = [];
  function FakeBC() {
    this.postMessage = (m) => messages.push(m);
    this.addEventListener = () => {};
  }
  const { api } = loadEpochApi({ BroadcastChannel: FakeBC });
  api.applySecureChatGateDecision(
    { state: 'UPDATE_REQUIRED', required: 1, local: 0 },
    { silentUi: true, skipAutoReload: true }
  );
  // apply with silentUi skips broadcast UI path that calls broadcast — force broadcast via decision without silent? 
  // broadcast only when !silentUi. Re-apply:
  api.applySecureChatGateDecision(
    { state: 'UPDATE_REQUIRED', required: 1, local: 0 },
    { skipAutoReload: true, silentUi: false }
  );
  record('multi-tab SECURE_UPDATE_REQUIRED broadcast',
    messages.some((m) => m && m.type === 'SECURE_UPDATE_REQUIRED' && m.required === 1));
}

// --- Reload loop bound ---
{
  const { api, session } = loadEpochApi({
    document: {
      getElementById: () => null,
      createElement: () => ({
        id: '',
        setAttribute() {},
        innerHTML: '',
        querySelector: () => ({ onclick: null, disabled: false }),
      }),
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
    navigator: { serviceWorker: { getRegistration: async () => null } },
    location: { reload() { session.__reloads = (session.__reloads || 0) + 1; }, href: 'x' },
  });
  session.sos_secure_epoch_reload_attempts = '3';
  await api.requestSecureReload();
  record('reload exhausted does not increment forever',
    api.readReloadAttempts() === 3 && !session.__reloads);
  session.sos_secure_epoch_reload_attempts = '0';
  await api.requestSecureReload();
  record('reload attempt increments then reloads',
    api.readReloadAttempts() === 1 && session.__reloads === 1);
}

// --- Simulated subscribe/send gate via source contract already covered;
// behavioral publish gate helper ---
{
  const { App } = loadEpochApi({
    __qaSecureChatEpochOverride: 0,
    __qaSecureEpochFetch: async () => ({
      ok: true,
      json: async () => ({ minSecureChatEpoch: 1 }),
    }),
  });
  await App.ensureSecureChatEpochReady({ skipAutoReload: true, silentUi: true });
  record('send gate: isSecureChatReady false when stale', App.isSecureChatReady() === false);
  record('subscribe gate: blocked when not READY', App.getSecureChatGateState() === 'UPDATE_REQUIRED');
}

// Secure blocker must not include Later button class from PWA
record('secure blocker has no pwa-update-toast__later', !epochSrc.includes('pwa-update-toast__later'));

console.log(results.join('\n'));
console.log(`\nSummary: ${pass} passed, ${fail} failed`);
console.log('LIVE_E2EE_SEND=true');
console.log('secure cutover active=true (minSecureChatEpoch=2)');
process.exit(fail ? 1 : 0);
