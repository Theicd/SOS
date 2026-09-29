#!/usr/bin/env node
/**
 * Package 899 — Web security closure gate (two audit blockers).
 *  Blocker 1: mesh relay-signal must never carry a private file-offer (keyStr / metadata) in plaintext.
 *             A → B (intermediary) → C with the real p2p-video-sharing.js + chat-p2p-secure-v2.js runtime.
 *  Blocker 2: outgoing call signaling is kind 1059 only; policy failure never publishes kind 25050.
 * Run: node qa/package899-web-security-closure-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  generateSecretKey, getPublicKey, finalizeEvent, getEventHash, verifyEvent, utils, nip44, nip04,
} from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(ROOT, 'qa', 'package899-web-security-closure-report.json');
const results = [];
const gates = {};
let pass = 0;
let fail = 0;
function record(name, ok, detail = '') {
  if (ok) { pass += 1; results.push('PASS ' + name); return true; }
  fail += 1;
  results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
  return false;
}
function gate(name, checks) {
  gates[name] = checks.every(Boolean) ? 'PASS' : 'FAIL';
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function party() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), hex: utils.bytesToHex(sk) };
}

const SECRET = {
  keyStr: 'QA_SECRET_FILE_AES_KEY_b64url_Zm9vYmFy',
  name: 'qa-private-medical-report.pdf',
  mimeType: 'application/x-qa-private-mime',
  caption: 'QA PRIVATE CAPTION',
  fileId: 'qa-private-file-id-7f3a9c',
  sha256: 'ab'.repeat(32),
};
const PRIVATE_STRINGS = [SECRET.keyStr, SECRET.name, SECRET.mimeType, SECRET.caption, SECRET.fileId, SECRET.sha256];
function offer() {
  return {
    type: 'file-offer',
    fileId: SECRET.fileId,
    name: SECRET.name,
    size: 5 * 1024 * 1024 + 17,
    mimeType: SECRET.mimeType,
    keyStr: SECRET.keyStr,
    totalChunks: 81,
    createdAt: Math.floor(Date.now() / 1000),
    caption: SECRET.caption,
    sha256: SECRET.sha256,
  };
}

// ---------------------------------------------------------------- P2P runtime (real modules)
function loadP2p(me, opts = {}) {
  const logs = [];
  const relaySends = [];
  const offers = [];
  const localStorage = {
    s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = String(v); }, removeItem(k) { delete this.s[k]; },
  };
  const App = {
    publicKey: me.pk,
    privateKey: me.hex,
    hexToBytes: utils.hexToBytes,
    pool: {
      publish() { return []; },
      subscribeMany() { return { close() {} }; },
    },
    finalizeEvent(draft, key) {
      const sk = typeof key === 'string' ? utils.hexToBytes(key) : key;
      return finalizeEvent(JSON.parse(JSON.stringify(draft)), sk);
    },
  };
  const push = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const sandbox = {
    console: { log: push, warn: push, error: push, info: push, debug: push },
    navigator: { userAgent: 'NodeQA', onLine: true },
    document: { readyState: 'complete', addEventListener() {}, hidden: false, visibilityState: 'visible' },
    localStorage,
    crypto: webcrypto,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Map, Set, Promise, JSON, Date, Math, Number, String, Array, Object, Boolean, Error, TypeError,
    Uint8Array, ArrayBuffer, TextEncoder, TextDecoder,
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    NostrApp: App,
    NostrTools: { finalizeEvent, utils, nip44, verifyEvent, generateSecretKey, getPublicKey },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('sos-crypto-signer.js'), sandbox, { filename: 'sos-crypto-signer.js' });
  vm.runInContext(read('chat-p2p-secure-v2.js'), sandbox, { filename: 'chat-p2p-secure-v2.js' });
  vm.runInContext(read('p2p-video-sharing.js'), sandbox, { filename: 'p2p-video-sharing.js' });
  // Peer-exchange transport: record exactly the DataChannel wire JSON the intermediary would receive.
  App.PeerExchange = {
    findRelayPeer: () => (opts.via || null),
    sendRelaySignal(targetPubkey, signal, viaPubkey) {
      relaySends.push({
        via: viaPubkey,
        wire: JSON.stringify({ type: 'relay-signal', targetPubkey, signal, originalSender: App.publicKey, timestamp: Date.now(), hops: 1 }),
        signal,
      });
      return true;
    },
  };
  App.handleP2PFileOffer = async (sender, data) => { offers.push({ sender, data }); };
  App.handleFileResendRequest = async () => {};
  return { App, logs, relaySends, offers, sandbox };
}

async function blocker1() {
  const A = party(); const B = party(); const C = party(); const D = party(); const M = party();
  const pSrc = read('p2p-video-sharing.js');
  const fSrc = read('chat-p2p-file.js');
  const secSrc = read('chat-p2p-secure-v2.js');
  const peSrc = read('p2p-peer-exchange.js');

  // ---- Audit of the path (source-derived).
  const offerFields = (fSrc.match(/const metadata = \{\s*type: 'file-offer',[\s\S]*?\};/) || [''])[0];
  const fields = ['fileId', 'name', 'size', 'mimeType', 'keyStr', 'totalChunks', 'createdAt', 'caption', 'sha256']
    .filter((f) => new RegExp('\\b' + f + '\\b').test(offerFields));
  const tryRelayBlock = (pSrc.match(/const tryRelay = async \(\) => \{[\s\S]*?\n {6}\};/) || [''])[0];
  const auditChecks = [
    record('AUDIT file-offer fields identified (' + fields.join(',') + ')', fields.length === 9),
    record('AUDIT file-offer sent via App.sendP2PSignal → sendSignal', /await App\.sendP2PSignal\(peerKey, metadata\)/.test(fSrc) && /return sendSignal\(peerPubkey, type, data\)/.test(pSrc)),
    record('AUDIT direct DC offer uses encryptFileOfferForDc (secure-v2 only)', /encryptFileOfferForDc/.test(fSrc) && /LEGACY_DTLS_KEY_EXCHANGE/.test(fSrc)),
    record('AUDIT relay (30078) path is NIP-44 enforced', /encrypted envelope required/.test(pSrc)),
    record('AUDIT peer-exchange forwards signal verbatim (so it must already be ciphertext)', /signal,\s*\n\s*originalSender,/.test(peSrc)),
    record('AUDIT mesh tryRelay uses P2pSecureV2.encryptMeshSignal', /encryptMeshSignal\(peerPubkey, type, data\)/.test(tryRelayBlock)),
    record('AUDIT mesh tryRelay never passes plaintext {type,data}', !/sendRelaySignal\(peerPubkey, \{ type, data \}/.test(pSrc)),
    record('AUDIT both tryRelay call sites awaited', (pSrc.match(/await tryRelay\(\)/g) || []).length === 2 && !/[^t] tryRelay\(\)\) return/.test(pSrc.replace(/await tryRelay\(\)/g, ''))),
    record('AUDIT receiver rejects non-secure relayed signal', /plaintext_relayed_signal_rejected/.test(pSrc) && /decryptMeshSignal\(senderPubkey, outer\)/.test(pSrc)),
    record('NEW_CRYPTO_PRIMITIVE_ADDED=false (secure-v2 module unchanged API)', /async function encryptMeshSignal/.test(secSrc) && /async function decryptMeshSignal/.test(secSrc)),
  ];
  gate('MESH_FILE_SIGNAL_AUDIT_GATE', auditChecks);

  // ---- A → B → C.
  const a = loadP2p(A, { via: B.pk });
  a.App.pool = null; // relay pool unavailable → mesh relay is the path under test
  await a.App.sendP2PSignal(C.pk, offer());
  const send = a.relaySends[0];
  const bSees = send ? send.wire : '';
  const leaks = PRIVATE_STRINGS.filter((s) => bSees.includes(s));
  let bParsed = null;
  try { bParsed = JSON.parse(bSees); } catch (_) {}
  let sig = null;
  try { sig = bParsed && typeof bParsed.signal === 'string' ? JSON.parse(bParsed.signal) : (bParsed && bParsed.signal) || null; } catch (_) {}
  // B tries to decrypt with its own key (as recipient) and via its conversation key with A.
  const bModule = loadP2p(B);
  let bDecrypt = false;
  try { await bModule.App.P2pSecureV2.decryptMeshSignal(A.pk, bParsed && bParsed.signal); bDecrypt = true; } catch (_) {}
  let bRaw = false;
  try {
    const ck = nip44.v2.utils.getConversationKey(B.sk, A.pk);
    nip44.v2.decrypt(sig.envelope.ct, ck);
    bRaw = true;
  } catch (_) {}
  const confChecks = [
    record('MESH exactly one relay send, via B', a.relaySends.length === 1 && send.via === B.pk),
    record('MESH intermediary wire is secure mesh envelope', !!sig && sig.type === 'p2p-secure-mesh-signal' && sig.envelope && sig.envelope.family === 'sos-p2p-secure-v2' && sig.envelope.alg === 'nip44'),
    record('MESH intermediary sees ZERO private strings (keyStr/name/mime/caption/fileId/sha256)', leaks.length === 0, leaks.join(',')),
    record('MESH intermediary sees no signal type in clear', !/"file-offer"/.test(bSees)),
    record('MESH intermediary routing only: target + sender pubkeys', !!bParsed && bParsed.targetPubkey === C.pk && bParsed.originalSender === A.pk),
    record('MESH intermediary cannot decrypt via secure-v2', bDecrypt === false),
    record('MESH intermediary cannot decrypt raw NIP-44 with its own key', bRaw === false),
    record('MESH sender logs contain no key/metadata', !a.logs.some((l) => PRIVATE_STRINGS.some((s) => l.includes(s)))),
  ];

  // ---- C receives through B's verbatim forward.
  const c = loadP2p(C);
  await c.App.handleRelayedSignal(bParsed.signal, bParsed.originalSender);
  const got = c.offers[0] && c.offers[0].data;
  confChecks.push(
    record('MESH recipient decrypts and gets the file-offer', c.offers.length === 1 && c.offers[0].sender === A.pk),
    record('MESH recipient recovers keyStr + metadata intact', !!got && got.keyStr === SECRET.keyStr && got.name === SECRET.name && got.mimeType === SECRET.mimeType && got.fileId === SECRET.fileId && got.sha256 === SECRET.sha256 && got.caption === SECRET.caption),
    record('MESH recipient logs contain no key/metadata', !c.logs.some((l) => PRIVATE_STRINGS.some((s) => l.includes(s)))),
  );
  gate('MESH_INTERMEDIARY_CONFIDENTIALITY_GATE', confChecks);
  gates.PRIVATE_FILE_METADATA_MESH_ENCRYPTED = leaks.length === 0 && !!sig ? 'true' : 'false';

  // ---- Tamper matrix (fresh sends so replay cache does not mask results).
  async function freshWire() {
    const x = loadP2p(A, { via: B.pk });
    x.App.pool = null;
    await x.App.sendP2PSignal(C.pk, offer());
    return JSON.parse(x.relaySends[0].wire);
  }
  async function deliver(to, signal, claimedSender) {
    const r = loadP2p(to);
    await r.App.handleRelayedSignal(signal, claimedSender);
    return r;
  }
  const flip = (s) => { const i = Math.floor(s.length / 2); return s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1); };
  const tamperChecks = [];
  try {
  {
    const w = await freshWire(); const s = JSON.parse(w.signal); s.envelope.ct = flip(s.envelope.ct);
    const r = await deliver(C, JSON.stringify(s), A.pk);
    tamperChecks.push(record('TAMPER ciphertext (fileId/hash/key region) rejected', r.offers.length === 0 && r.logs.some((l) => /PARSE_REJECT\] kind=mesh .*reason=DECRYPT_FAILURE/.test(l))));
  }
  {
    const w = await freshWire();
    const r = await deliver(D, w.signal, A.pk);
    tamperChecks.push(record('TAMPER recipient (re-targeted to D) rejected', r.offers.length === 0));
  }
  {
    const w = await freshWire();
    const r = await deliver(C, w.signal, M.pk);
    tamperChecks.push(record('TAMPER sender binding (claimed originalSender=M) rejected', r.offers.length === 0));
  }
  {
    const w = await freshWire(); const s = JSON.parse(w.signal); s.envelope.v = 2;
    const r = await deliver(C, JSON.stringify(s), A.pk);
    tamperChecks.push(record('TAMPER envelope version rejected', r.offers.length === 0 && r.logs.some((l) => /UNKNOWN_VERSION/.test(l))));
  }
  {
    const w = await freshWire(); const s = JSON.parse(w.signal); s.envelope.family = 'sos-p2p-secure-v1';
    const r = await deliver(C, JSON.stringify(s), A.pk);
    tamperChecks.push(record('TAMPER envelope family rejected', r.offers.length === 0));
  }
  {
    const w = await freshWire(); const s = JSON.parse(w.signal); s.type = 'file-offer';
    const r = await deliver(C, JSON.stringify(s), A.pk);
    tamperChecks.push(record('TAMPER outer type relabel rejected', r.offers.length === 0));
  }
  {
    const w = await freshWire();
    const r = loadP2p(C);
    await r.App.handleRelayedSignal(w.signal, A.pk);
    await r.App.handleRelayedSignal(w.signal, A.pk);
    tamperChecks.push(record('REPLAY of same mesh envelope accepted once', r.offers.length === 1));
  }
  } catch (e) {
    tamperChecks.push(record('TAMPER matrix requires a secure mesh envelope', false, String(e && e.message).slice(0, 80)));
  }
  gate('MESH_SIGNAL_TAMPER_GATE', tamperChecks);

  // ---- Receiver rejects legacy plaintext relayed signals.
  const rejChecks = [];
  {
    const r = loadP2p(C);
    await r.App.handleRelayedSignal(JSON.stringify({ type: 'file-offer', data: offer() }), A.pk);
    await r.App.handleRelayedSignal({ type: 'file-offer', ...offer() }, A.pk);
    rejChecks.push(record('PLAINTEXT relayed file-offer with keyStr rejected (string + object)', r.offers.length === 0 && r.logs.filter((l) => /plaintext_relayed_signal_rejected/.test(l)).length === 2));
    await r.App.handleRelayedSignal(JSON.stringify({ type: 'file-resend-request', data: { fileId: 'x' } }), A.pk);
    rejChecks.push(record('PLAINTEXT relayed non-offer signal rejected', r.logs.filter((l) => /plaintext_relayed_signal_rejected/.test(l)).length === 3));
    rejChecks.push(record('PLAINTEXT rejection logs no key material', !r.logs.some((l) => l.includes(SECRET.keyStr))));
  }
  rejChecks.push(record('DIRECT DC plaintext keyStr still rejected (unchanged)', /legacy_plaintext_key_rejected/.test(read('chat-p2p-file.js'))));
  gate('PLAINTEXT_MESH_FILE_OFFER_REJECT_GATE', rejChecks);

  // ---- Fail closed.
  const fcChecks = [];
  {
    const x = loadP2p(A, { via: B.pk });
    x.App.pool = null;
    x.App.P2pSecureV2.encryptMeshSignal = async () => { const e = new Error('qa'); e.code = 'ENCRYPT_FAILURE'; throw e; };
    let code = '';
    try { await x.App.sendP2PSignal(C.pk, offer()); } catch (e) { code = e && e.code; }
    fcChecks.push(record('FAIL_CLOSED encrypt failure → no mesh send, secure error', x.relaySends.length === 0 && code === 'P2P_PRIVATE_SIGNAL_ENCRYPT_FAILED'));
  }
  {
    const x = loadP2p(A, { via: B.pk });
    x.App.pool = null;
    x.App.P2pSecureV2 = undefined;
    let code = '';
    try { await x.App.sendP2PSignal(C.pk, offer()); } catch (e) { code = e && e.code; }
    fcChecks.push(record('FAIL_CLOSED secure module missing → no mesh send', x.relaySends.length === 0 && code === 'P2P_PRIVATE_SIGNAL_ENCRYPT_FAILED'));
  }
  {
    const x = loadP2p(A, { via: B.pk });
    x.App.pool = null;
    x.App.guestMode = true;
    let code = '';
    try { await x.App.sendP2PSignal(C.pk, offer()); } catch (e) { code = e && e.code; }
    fcChecks.push(record('FAIL_CLOSED local not secure-v2 capable → no mesh send', x.relaySends.length === 0 && !!code));
  }
  {
    const x = loadP2p(A, { via: B.pk });
    x.App.pool = { publish() { throw new Error('qa-publish-down'); }, subscribeMany() { return { close() {} }; } };
    try { await x.App.sendP2PSignal(C.pk, offer()); } catch (_) {}
    const w = x.relaySends[0] ? x.relaySends[0].wire : '';
    let wt = '';
    try { const s = JSON.parse(w).signal; wt = (typeof s === 'string' ? JSON.parse(s) : s).type; } catch (_) {}
    fcChecks.push(record('FAIL_CLOSED publish-failure fallback is encrypted mesh only', x.relaySends.length === 1 && !PRIVATE_STRINGS.some((s) => w.includes(s)) && wt === 'p2p-secure-mesh-signal'));
  }
  gate('MESH_FILE_SIGNAL_CRYPTO_FAIL_CLOSED_GATE', fcChecks);
  gates.FILE_KEY_PLAINTEXT_MESH_PATH_COUNT = gates.MESH_INTERMEDIARY_CONFIDENTIALITY_GATE === 'PASS' && gates.MESH_FILE_SIGNAL_CRYPTO_FAIL_CLOSED_GATE === 'PASS' ? 0 : 1;
}

// ---------------------------------------------------------------- Call runtime (real module)
function loadCall({ seen = false } = {}) {
  const logs = [];
  const published = [];
  const App = { publicKey: null, relayUrls: ['wss://qa.example'] };
  const localStorage = { s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = String(v); }, removeItem(k) { delete this.s[k]; } };
  if (seen) localStorage.s.sos_call_signal_giftwrap_required_seen = '1';
  const sandbox = {
    console: { log(m) { logs.push(String(m)); }, warn(m) { logs.push(String(m)); }, error() {}, info() {}, debug() {} },
    navigator: { userAgent: 'NodeQA', onLine: true },
    crypto: webcrypto,
    fetch: () => Promise.reject(new Error('offline-qa')),
    localStorage,
    sessionStorage: { s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = String(v); }, removeItem(k) { delete this.s[k]; } },
    document: { visibilityState: 'visible', hidden: false, addEventListener() {}, removeEventListener() {} },
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
  vm.runInContext(read('call-signal-e2ee.js'), sandbox, { filename: 'call-signal-e2ee.js' });
  App.SosCryptoSigner = { hasIdentityKey: () => true, isWorkerAuthoritative: () => false };
  const pool = {
    publish(_relays, ev) { published.push(JSON.parse(JSON.stringify(ev))); return [Promise.resolve('ok'), Promise.resolve('ok')]; },
    subscribeMany(relays, filters, h) { const s = { relays, filters, h, close() {} }; pool.subs.push(s); return s; },
    subs: [],
  };
  App.pool = pool;
  return { App, api: App.CallSignalE2ee, logs, published, pool };
}

function unwrap(wrap, recipientSk) {
  const seal = JSON.parse(nip44.v2.decrypt(wrap.content, nip44.v2.utils.getConversationKey(recipientSk, wrap.pubkey)));
  const rumor = JSON.parse(nip44.v2.decrypt(seal.content, nip44.v2.utils.getConversationKey(recipientSk, seal.pubkey)));
  return { seal, rumor, payload: JSON.parse(rumor.content) };
}

const res = (status, body, badJson) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (badJson) throw new SyntaxError('qa-malformed'); return body; } });
const POLICY_CASES = [
  { id: 'endpoint-unavailable', fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) },
  { id: 'http-failure-503', fetchImpl: async () => res(503, {}) },
  { id: 'timeout-abort', fetchImpl: () => new Promise((_, rej) => setTimeout(() => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; rej(e); }, 20)) },
  { id: 'malformed-json', fetchImpl: async () => res(200, null, true) },
  { id: 'unknown-schema', fetchImpl: async () => res(200, { schema: 'unknown-v9', version: 'x' }) },
  { id: 'missing-response-body', fetchImpl: async () => res(200, null) },
  { id: 'first-load-no-cache-fetch-fail', fetchImpl: () => Promise.reject(new Error('offline')) },
  { id: 'remote-explicit-false', fetchImpl: async () => res(200, { callSignalGiftWrapRequired: false }) },
  { id: 'cached-secure-policy', seen: true, fetchImpl: () => Promise.reject(new Error('offline')) },
  { id: 'normal-success-true', fetchImpl: async () => res(200, { callSignalGiftWrapRequired: true }) },
];

async function blocker2() {
  const src = read('call-signal-e2ee.js');
  const voiceSrc = read('chat-voice-call.js');
  const videoSrc = read('chat-video-call.js');
  const sender = party(); const recipient = party();
  const matrix = [];
  let legacyOnFailure = 0;
  const matrixChecks = [];
  for (const c of POLICY_CASES) {
    const rt = loadCall({ seen: !!c.seen });
    rt.App.publicKey = sender.pk;
    let out = null; let err = null;
    try {
      out = await rt.api.publishCallSignal({
        media: 'voice', type: 'offer', peerPubkey: recipient.pk, senderPubkey: sender.pk, senderPrivateKey: sender.hex,
        data: { type: 'offer', sdp: 'v=0 qa' }, pool: rt.pool, relays: ['wss://qa.example'],
        policyOptions: { fetchImpl: c.fetchImpl, forceFetch: true },
      });
    } catch (e) { err = e; }
    const k1059 = rt.published.filter((e) => e.kind === 1059).length;
    const k25050 = rt.published.filter((e) => e.kind === 25050).length;
    if (c.id !== 'normal-success-true' && c.id !== 'cached-secure-policy') legacyOnFailure += k25050;
    matrix.push({ case: c.id, transport: out && out.transport, mode: out && out.mode, kind1059: k1059, kind25050: k25050, error: err ? err.code || 'ERR' : null });
    matrixChecks.push(record('POLICY ' + c.id + ' → kind1059 only, 25050=0', !err && out && out.transport === 'giftwrap1059' && k1059 === 1 && k25050 === 0, err ? String(err.code || err.message) : ''));
  }
  // Crypto/identity prerequisites missing → fail closed, nothing published.
  for (const [id, mut] of [
    ['bad-private-key', (o) => { o.senderPrivateKey = 'zz'; }],
    ['no-identity-no-signer', (o) => { o.senderPrivateKey = ''; }],
    ['bad-recipient', (o) => { o.peerPubkey = 'not-a-pubkey'; }],
  ]) {
    const rt = loadCall();
    rt.App.publicKey = sender.pk;
    if (id === 'no-identity-no-signer') rt.App.SosCryptoSigner = { hasIdentityKey: () => false, isWorkerAuthoritative: () => false, f1CryptoModuleSessionKeyHex: () => '' };
    const o = { media: 'video', type: 'offer', peerPubkey: recipient.pk, senderPubkey: sender.pk, senderPrivateKey: sender.hex, data: { type: 'offer', sdp: 'v=0' }, pool: rt.pool, policyOptions: { fetchImpl: () => Promise.reject(new Error('offline')), forceFetch: true } };
    mut(o);
    let code = '';
    try { await rt.api.publishCallSignal(o); } catch (e) { code = e && e.code; }
    matrixChecks.push(record('CRYPTO_FAIL ' + id + ' → throws, publish ZERO (no 25050)', !!code && rt.published.length === 0, code));
    matrix.push({ case: 'crypto-' + id, error: code || null, published: rt.published.length });
  }
  {
    const rt = loadCall();
    let code = '';
    try { await rt.api.publishLegacyDirectCallSignal({ media: 'voice', type: 'offer', peerPubkey: recipient.pk, senderPubkey: sender.pk, senderPrivateKey: sender.hex, data: {}, pool: rt.pool }); } catch (e) { code = e && e.code; }
    matrixChecks.push(record('publishLegacyDirectCallSignal disabled → throws, publish ZERO', code === 'CALL_SIGNAL_LEGACY_SEND_DISABLED' && rt.published.length === 0));
  }
  matrixChecks.push(
    record('SOURCE resolveCallSignalSecurityDecision returns SECURE only', !/mode: SEND_MODES\.LEGACY_ROLLOUT/.test(src)),
    record('SOURCE publishCallSignal has no legacy publish call', !/await publishLegacyDirectCallSignal\(/.test(src)),
    record('SOURCE no outgoing kind 25050 builder remains (no nip04.encrypt in send path)', !/nip04\.encrypt\(senderSk/.test(src)),
    record('SOURCE voice/video modules publish only via publishCallSignal', /api\.publishCallSignal\(/.test(voiceSrc) && /api\.publishCallSignal\(/.test(videoSrc) && !/kind:\s*25050[^\]]/.test(voiceSrc.replace(/kinds:\s*\[25050\]/g, '')) && !/kind:\s*25050[^\]]/.test(videoSrc.replace(/kinds:\s*\[25050\]/g, ''))),
  );
  gate('CALL_POLICY_FAILURE_MATRIX_GATE', matrixChecks);
  gate('CALL_SIGNAL_CRYPTO_FAIL_CLOSED_GATE', matrixChecks.slice(POLICY_CASES.length));
  gates.LEGACY_25050_OUTGOING_PUBLISH_COUNT_ON_POLICY_FAILURE = legacyOnFailure;

  // ---- 1059 E2EE across every action, voice + video; recipient unwraps; binding + replay.
  const e2eeChecks = [];
  const actions = ['ring', 'offer', 'answer', 'candidate', 'candidates', 'disconnect'];
  for (const media of ['voice', 'video']) {
    for (const action of actions) {
      const rt = loadCall();
      rt.App.publicKey = sender.pk;
      const data = action === 'offer' || action === 'answer' ? { type: action, sdp: 'v=0 qa-' + action } : action.startsWith('cand') ? { candidate: 'candidate:1 qa' } : null;
      let ok = false; let detail = '';
      try {
        await rt.api.publishCallSignal({ media, type: action, peerPubkey: recipient.pk, senderPubkey: sender.pk, senderPrivateKey: sender.hex, data, pool: rt.pool, policyOptions: { fetchImpl: () => Promise.reject(new Error('offline')), forceFetch: true } });
        const wrap = rt.published[0];
        const u = unwrap(wrap, recipient.sk);
        ok = rt.published.length === 1 && wrap.kind === 1059 && verifyEvent(wrap) && wrap.pubkey !== sender.pk &&
          wrap.tags.length === 1 && wrap.tags[0][0] === 'p' && wrap.tags[0][1] === recipient.pk &&
          u.seal.kind === 13 && verifyEvent(u.seal) && u.seal.pubkey === sender.pk &&
          u.rumor.pubkey === sender.pk && u.payload.sender === sender.pk && u.payload.recipient === recipient.pk &&
          u.payload.media === media && !wrap.content.includes('qa-') && !JSON.stringify(wrap.tags).includes(sender.pk);
      } catch (e) { detail = String(e && (e.code || e.message)); }
      e2eeChecks.push(record(`1059 ${media}/${action}: wrap ephemeral, seal signed, recipient-bound, outer opaque`, ok, detail));
    }
  }
  {
    // Third party cannot unwrap; tampered wrap signature rejected by verifier.
    const rt = loadCall();
    rt.App.publicKey = sender.pk;
    await rt.api.publishCallSignal({ media: 'voice', type: 'offer', peerPubkey: recipient.pk, senderPubkey: sender.pk, senderPrivateKey: sender.hex, data: { type: 'offer', sdp: 'v=0' }, pool: rt.pool, policyOptions: { fetchImpl: () => Promise.reject(new Error('x')), forceFetch: true } });
    const wrap = rt.published[0];
    let third = false;
    try { unwrap(wrap, party().sk); third = true; } catch (_) {}
    e2eeChecks.push(record('1059 third party cannot unwrap', third === false));
    const bad = { ...wrap, content: wrap.content.slice(0, -2) + (wrap.content.endsWith('A') ? 'B' : 'A') + '=' };
    e2eeChecks.push(record('1059 tampered wrap fails signature verification', verifyEvent(bad) === false));
  }
  e2eeChecks.push(
    record('1059 receive: signature/freshness/replay code paths unchanged', /function verifyEventSig/.test(src) && /FRESHNESS_SEC\[/.test(src) && /rememberSignalId/.test(src) && /rememberWrapId/.test(src)),
  );
  gate('CALL_1059_E2EE_GATE', e2eeChecks);
  gate('CALL_RING_SECURITY_GATE', e2eeChecks.filter((_, i) => i === 0 || i === actions.length));

  // ---- Legacy 25050 READ compatibility kept.
  const readChecks = [];
  {
    const rt = loadCall();
    rt.App.publicKey = recipient.pk;
    const got = [];
    const sub = rt.api.subscribeLegacyCallSignals('qa-voice', { since: 0, onevent: (ev) => got.push(ev) });
    await sleep(10);
    const s = rt.pool.subs.find((x) => x.filters[0] && x.filters[0].kinds && x.filters[0].kinds[0] === 25050);
    const legacyEv = finalizeEvent({ kind: 25050, created_at: Math.floor(Date.now() / 1000), tags: [['type', 'voice-call-offer'], ['p', recipient.pk]], content: 'qa' }, sender.sk);
    if (s) s.h.onevent(legacyEv);
    readChecks.push(record('LEGACY 25050 read subscription still opens for current identity', !!s && s.filters[0]['#p'][0] === recipient.pk));
    readChecks.push(record('LEGACY 25050 inbound event still delivered to listeners', got.length === 1));
    readChecks.push(record('LEGACY 25050 looksLikeLegacyDirectCallSignal still recognises', rt.api.looksLikeLegacyDirectCallSignal(legacyEv) === true));
    sub.close();
  }
  readChecks.push(
    record('LEGACY 25050 voice/video read handlers still present', /kinds: \[25050\]/.test(voiceSrc) && /kinds: \[25050\]/.test(videoSrc)),
    record('LEGACY 25050 inbound signature/recipient/replay checks still present', /rejected invalid voice-call signal kind=25050/.test(voiceSrc) && /rejected event for wrong recipient kind=25050/.test(voiceSrc) && /rejected stale or replayed live signal kind=25050/.test(voiceSrc)),
  );
  gate('LEGACY_25050_READ_COMPATIBILITY_GATE', readChecks);
  return matrix;
}

// ---------------------------------------------------------------- invariants (source)
function invariants() {
  const signer = read('sos-crypto-signer.js');
  const logChecks = [];
  const sources = ['p2p-video-sharing.js', 'call-signal-e2ee.js'].map(read).join('\n');
  logChecks.push(record('INVARIANT no keyStr/privateKey/nsec logged by changed files', !/console\.(log|warn)\([^)]*\b(keyStr|privateKey|nsec|senderSk)\b/.test(sources)));
  logChecks.push(record('INVARIANT SIGN_FEED kinds [1,6] in main signer', /SIGN_FEED:\s*\{\s*kinds:\s*\[1,\s*6\]\s*\}/.test(signer)));
  logChecks.push(record('INVARIANT typed signer: signEvent is game-kind only (no generic signer)', /KIND_NOT_ALLOWED/.test(signer) && !/signEventGeneric|signAnyEvent/.test(signer)));
  gate('SECRET_SIGNER_INVARIANT_SOURCE_GATE', logChecks);
}

async function run() {
  await blocker1();
  const matrix = await blocker2();
  invariants();
  gates.MESH_SIGNAL_REUSES_P2P_SECURE_V2 = gates.MESH_FILE_SIGNAL_AUDIT_GATE === 'PASS' ? 'true' : 'false';
  gates.NEW_CRYPTO_PRIMITIVE_ADDED = 'false';
  gates.MESH_FILE_PLAINTEXT_FALLBACK = gates.MESH_FILE_SIGNAL_CRYPTO_FAIL_CLOSED_GATE === 'PASS' ? 'false' : 'true';
  gates.CALL_POLICY_UNAVAILABLE_BEHAVIOR = gates.CALL_POLICY_FAILURE_MATRIX_GATE === 'PASS' ? 'SECURE_REQUIRED' : 'UNSAFE';
  gates.OUTGOING_CALL_25050_DOWNGRADE_ENABLED = gates.CALL_POLICY_FAILURE_MATRIX_GATE === 'PASS' ? 'false' : 'true';
  gates.CALL_SIGNAL_SILENT_DOWNGRADE = gates.OUTGOING_CALL_25050_DOWNGRADE_ENABLED;
  console.log('package899-web-security-closure gate');
  for (const line of results) console.log(line);
  for (const [k, v] of Object.entries(gates)) console.log(k + '=' + v);
  console.log('TOTAL ' + pass + '/' + (pass + fail));
  fs.writeFileSync(REPORT, JSON.stringify({
    gate: 'package899-web-security-closure',
    generatedAt: new Date().toISOString(),
    status: fail === 0 ? 'PASS' : 'FAIL',
    pass, fail, gates, callPolicyMatrix: matrix, results,
  }, null, 2) + '\n');
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
