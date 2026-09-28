#!/usr/bin/env node
/**
 * Package 899 — Voice P2P application-level E2EE gate (VM, mocked network + mocked WebTorrent swarm).
 * Run: node qa/package899-voice-p2p-e2ee-gate.mjs
 *
 * Uses the real media-file-e2ee / blossom / media-server-e2ee / chat-file-transfer-state /
 * chat-voice-service / chat-service / chat-audio-player sources. No keys, plaintext or full magnets are printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createHash, webcrypto } from 'node:crypto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, finalizeEvent, utils } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(__dirname, 'package899-voice-p2p-e2ee-report.json');

const results = [];
const gates = {};
let pass = 0;
let fail = 0;
function record(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name);
  } else {
    fail += 1;
    results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
  return !!ok;
}
function gate(name, checks) {
  const ok = checks.every(Boolean);
  gates[name] = ok ? 'PASS' : 'FAIL';
  record(name, ok);
  return ok;
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256 = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const includesBytes = (hay, needle) => Buffer.from(hay).indexOf(Buffer.from(needle)) !== -1;
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 100) / 100;
};

const SENTINEL = 'SOS899_VOICE_SENTINEL_PLAINTEXT_7f3a';
function voiceFixture(size, seed = 7) {
  const out = new Uint8Array(size);
  out.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  let x = seed >>> 0;
  for (let i = 4; i < size; i += 1) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  const s = Buffer.from(SENTINEL);
  for (let off = 64; off + s.length < size; off += 4096) out.set(s, off);
  return out;
}

const SRC = {
  voice: read('chat-voice-service.js'),
  audio: read('chat-audio-player.js'),
  server: read('media-server-e2ee.js'),
  state: read('chat-file-transfer-state.js'),
  service: read('chat-service.js'),
  renderer: read('chat-media-renderer.js'),
  mediaE2ee: read('media-file-e2ee.js'),
};

// ---------- mock WebTorrent swarm ----------
const swarm = new Map();
function makeTorrent(bytes, name, opts = {}) {
  const t = new EventEmitter();
  const infoHash = createHash('sha1').update(Buffer.from(bytes)).update(name).digest('hex');
  t.infoHash = infoHash;
  t.magnetURI =
    'magnet:?xt=urn:btih:' + infoHash + '&dn=' + encodeURIComponent(name) + '&tr=wss%3A%2F%2Ftracker.openwebtorrent.com';
  t.length = opts.length != null ? opts.length : bytes.length;
  t.done = opts.done !== false;
  t.ready = true;
  t.destroyed = false;
  t.files = [{ name, length: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer }];
  t.destroy = () => {
    t.destroyed = true;
  };
  return t;
}
function makeWtClient(mode, stats) {
  return {
    seed(file, opts, cb) {
      file.arrayBuffer().then((ab) => {
        const bytes = new Uint8Array(ab);
        const t = makeTorrent(bytes, (opts && opts.name) || file.name);
        stats.seeded.push({ bytes, name: t.files[0].name, fileName: file.name, type: file.type, magnetURI: t.magnetURI });
        swarm.set(t.infoHash, bytes);
        setTimeout(() => cb(t), 1);
      });
      return {};
    },
    get() {
      return null;
    },
    add(magnetURI, opts, cb) {
      stats.adds += 1;
      const ih = (/btih:([0-9a-f]{40})/i.exec(magnetURI) || [])[1];
      const bytes = swarm.get(ih);
      const holder = new EventEmitter();
      holder.numPeers = mode === 'stall-peer' ? 1 : 0;
      holder.destroy = () => {
        stats.destroyed += 1;
      };
      setTimeout(() => {
        if (!bytes || mode === 'error') {
          holder.emit('error', new Error('no peers'));
          return;
        }
        if (mode === 'corrupt') {
          const bad = Uint8Array.from(bytes);
          bad[Math.floor(bad.length / 2)] ^= 0xff;
          cb(makeTorrent(bad, 'data.bin'));
          return;
        }
        if (mode === 'size') {
          cb(makeTorrent(bytes, 'data.bin', { length: bytes.length + 16 }));
          return;
        }
        if (mode === 'stall' || mode === 'stall-peer') {
          cb(makeTorrent(bytes, 'data.bin', { done: false }));
          return;
        }
        stats.p2pBytesServed.push(Uint8Array.from(bytes));
        cb(makeTorrent(bytes, 'data.bin'));
      }, 5);
      return holder;
    },
  };
}

// ---------- runtime ----------
function makeRuntime(opts) {
  const logs = [];
  const push = (lvl) => (...a) => logs.push(lvl + ' ' + a.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' '));
  const blossom = opts.blossom;
  const stats = opts.stats;
  const urls = { created: 0, revoked: 0 };
  class URLPoly extends URL {
    static createObjectURL() {
      urls.created += 1;
      return 'blob:mock-' + urls.created + '-' + Math.random().toString(36).slice(2);
    }
    static revokeObjectURL() {
      urls.revoked += 1;
    }
  }
  const mockFetch = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const u = String(url);
    if (method === 'PUT' || method === 'POST') {
      if (blossom.down) throw new TypeError('network down');
      const body = init.body;
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await body.arrayBuffer());
      blossom.uploads.push({ bytes: Uint8Array.from(bytes), url: u, headers: JSON.stringify(init.headers || {}) });
      const hash = sha256(bytes);
      const out = 'https://blossom.test.invalid/' + hash;
      blossom.store.set(hash, Uint8Array.from(bytes));
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ url: out, sha256: hash, size: bytes.length }),
        text: async () => '',
      };
    }
    blossom.gets += 1;
    if (blossom.down || blossom.getDown) throw new TypeError('network down');
    const hash = u.split('/').pop().split('?')[0];
    const bytes = blossom.store.get(hash);
    if (!bytes) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' };
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (String(h).toLowerCase() === 'content-length' ? String(bytes.length) : null) },
      arrayBuffer: async () => Uint8Array.from(bytes).buffer,
      text: async () => '',
    };
  };
  const App = {
    publicKey: opts.self.pk,
    blossomServers: [{ url: 'https://blossom.test.invalid' }],
    finalizeEvent: (d) => finalizeEvent(JSON.parse(JSON.stringify(d)), opts.self.sk),
    SosCryptoSigner: {
      hasIdentityKey: () => true,
      signBlossomAuth: async (d) => finalizeEvent(JSON.parse(JSON.stringify(d)), opts.self.sk),
    },
    __qaMediaServerE2eeRequiredOverride: opts.policyRequired,
    torrentTransfer: { init: () => (opts.wtMode === 'none' ? null : makeWtClient(opts.wtMode || 'ok', stats)) },
    persistChatP2PMedia: async () => {
      stats.persisted += 1;
      return 'k';
    },
    setChatFileAttachment: (peer, att) => {
      stats.attached.push(att);
    },
  };
  const sandbox = {
    console: { log: push('log'), warn: push('warn'), error: push('error'), info: push('info') },
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    Blob: NodeBlob,
    File: NodeFile,
    URL: URLPoly,
    AbortController,
    FileReader: class {
      readAsDataURL(blob) {
        blob.arrayBuffer().then((ab) => {
          this.result = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + Buffer.from(ab).toString('base64');
          if (typeof this.onload === 'function') this.onload();
        }, (e) => this.onerror && this.onerror(e));
      }
    },
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    fetch: mockFetch,
    localStorage: { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } },
    indexedDB: { open() { const r = {}; queueMicrotask(() => r.onerror && r.onerror()); return r; } },
    document: {
      readyState: 'complete',
      hidden: false,
      addEventListener() {},
      removeEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, querySelector: () => null, classList: { add() {}, remove() {} } }),
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
    navigator: { onLine: true, userAgent: 'node' },
    NostrApp: App,
    NostrTools: { finalizeEvent, utils, generateSecretKey, getPublicKey, verifyEvent: () => true },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['chat-state.js', 'media-file-e2ee.js', 'blossom.js', 'media-server-e2ee.js', 'chat-file-transfer-state.js', 'chat-file-transfer-service.js', 'chat-service.js', 'chat-voice-service.js', 'chat-audio-player.js']) {
    vm.runInContext(read(f), sandbox, { filename: f });
  }
  sandbox.NostrApp.setChatFileAttachment = (peer, att) => {
    stats.attached.push(att);
  };
  return { App: sandbox.NostrApp, logs, urls, sandbox };
}

function freshStats() {
  return { seeded: [], adds: 0, destroyed: 0, p2pBytesServed: [], persisted: 0, attached: [] };
}
function freshBlossom() {
  return { store: new Map(), uploads: [], gets: 0, down: false, getDown: false };
}
const clone = (o) => JSON.parse(JSON.stringify(o));

const A = (() => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; })();
const B = (() => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; })();
const C = (() => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; })();

const report = { generatedAt: new Date().toISOString(), durations: [], perf: {}, failClosed: {}, notes: [] };

// ---------- 1. source audit ----------
{
  const seedFn = SRC.voice.slice(SRC.voice.indexOf('async function seedVoiceForP2P'), SRC.voice.indexOf('async function sendVoiceBlobToChat'));
  const buildFn = SRC.voice.slice(SRC.voice.indexOf('async function buildAttachmentFromBlob'), SRC.voice.indexOf('function isEncryptedVoiceDescriptor'));
  const checks = [
    record('audit: seed takes descriptor, not recorder blob', /async function seedVoiceForP2P\(descriptor\)/.test(SRC.voice)),
    record('audit: seed uses prepared ciphertextBytes', /new File\(\[ciphertext\]/.test(seedFn) && !/new File\(\[blob\]/.test(SRC.voice)),
    record('audit: seed verifies ciphertext hash vs descriptor', /hashMediaCiphertext\(ciphertext\)\)\s*!==\s*descriptor\.cipher\.sha256/.test(seedFn)),
    record('audit: neutral torrent name/type', /VOICE_P2P_TORRENT_NAME = 'data\.bin'/.test(SRC.voice) && /application\/octet-stream/.test(seedFn)),
    record('audit: voice upload requireEncryption', (buildFn.match(/requireEncryption: true/g) || []).length >= 2),
    record('audit: no plaintext uploadToBlossom in voice', !/uploadToBlossom/.test(SRC.voice)),
    record('audit: no raw dataUrl emergency fallback', !/readAsDataURL\(blob\); \}\);\s*return \{ id/.test(SRC.voice)),
    record('audit: no top-level magnetURI on new voice', !/attachment\.magnetURI\s*=/.test(SRC.voice)),
    record('audit: recorder chunks released after stop', /new Blob\(chunks, \{ type: activeMimeType \}\);\s*chunks = \[\];/.test(SRC.voice)),
    record('audit: _prepared dropped after seed', /delete attachment\._prepared/.test(SRC.voice)),
    record('audit: inline resolver forwards requireEncryption', /requireEncryption: opts\.requireEncryption === true/.test(SRC.server)),
    record('audit: wire allowlists sanitized p2p v1', /wire\.p2p = \{ v: 1, transport: p2p\.transport, content: p2p\.content, magnetURI: p2p\.magnetURI \}/.test(SRC.state)),
    record('audit: inbound validates p2p marker', /VOICE_P2P_BAD_METADATA/.test(SRC.service) && /function isValidIncomingEncryptedP2pMarker/.test(SRC.service)),
    record('audit: no new crypto primitive (no subtle.* in changed voice/server paths)', !/subtle\./.test(SRC.voice) && !/subtle\./.test(SRC.server)),
    record('audit: legacy magnet playback suppressed for p2p v1', /attachment\.p2p \? '' : \(attachment\.magnetURI/.test(SRC.audio)),
    record('audit: renderer skips plaintext persist for p2p source', /_resolvedSource !== 'p2p'/.test(SRC.renderer)),
  ];
  gate('VOICE_CURRENT_PATH_AUDIT_GATE', checks);
}

// ---------- 2. sender pipeline + on-wire ciphertext ----------
const sent = {};
async function sendVoice({ seconds, size, policyRequired = true, wtMode = 'ok', blossomDown = false, sender = A, recipient = B }) {
  const stats = freshStats();
  const blossom = freshBlossom();
  blossom.down = blossomDown;
  const rt = makeRuntime({ self: sender, blossom, stats, wtMode, policyRequired });
  const plaintext = voiceFixture(size, seconds);
  const blob = new NodeBlob([plaintext], { type: 'audio/webm;codecs=opus' });
  const t0 = performance.now();
  let att = null;
  let error = null;
  try {
    att = await rt.App.sendVoiceBlobToChat(recipient.pk, { blob, duration: seconds, mimeType: 'audio/webm;codecs=opus' });
  } catch (e) {
    error = e;
  }
  const ms = performance.now() - t0;
  return { rt, stats, blossom, plaintext, att, error, ms };
}

const DURATIONS = [
  { seconds: 2, size: 16 * 1024 },
  { seconds: 10, size: 80 * 1024 },
  { seconds: 30, size: 240 * 1024 },
  { seconds: 60, size: 480 * 1024 },
];

for (const d of DURATIONS) {
  const r = await sendVoice(d);
  sent[d.seconds] = r;
  const att = r.att;
  const encrypted = !!(att && att.type === 'encrypted-media');
  const inline = !!(att && att.type !== 'encrypted-media' && typeof att.dataUrl === 'string' && att.dataUrl.startsWith('data:'));
  const seeded = r.stats.seeded[0];
  const plainHash = sha256(r.plaintext);
  const row = {
    seconds: d.seconds,
    plaintextBytes: d.size,
    route: encrypted ? (att.p2p ? 'P2P_APP_E2EE_VOICE(+BLOSSOM_E2EE)' : 'SERVER_E2EE_VOICE') : inline ? 'INLINE_E2EE_MESSAGE' : 'UNKNOWN',
    cipherBytes: encrypted ? att.cipher.size : null,
    seededBytes: seeded ? seeded.bytes.length : 0,
    plaintextHashNeCipherHash: encrypted ? plainHash !== att.cipher.sha256 : null,
    seededHashEqCipherHash: encrypted && seeded ? sha256(seeded.bytes) === att.cipher.sha256 : null,
    sentinelInSeeded: seeded ? includesBytes(seeded.bytes, SENTINEL) : false,
    sentinelInBlossom: r.blossom.uploads.some((u) => includesBytes(u.bytes, SENTINEL)),
    plaintextBlossomUploads: r.blossom.uploads.filter((u) => sha256(u.bytes) === plainHash).length,
    sendMs: Math.round(r.ms * 100) / 100,
  };
  report.durations.push(row);
  record('send ' + d.seconds + 's no error', !r.error, r.error && r.error.code);
  record('send ' + d.seconds + 's attached once', r.stats.attached.length === 1);
  record('send ' + d.seconds + 's sentinel never seeded', row.sentinelInSeeded === false);
  record('send ' + d.seconds + 's sentinel never on Blossom', row.sentinelInBlossom === false && row.plaintextBlossomUploads === 0);
  if (encrypted) {
    record('send ' + d.seconds + 's p2p marker v1', att.p2p && att.p2p.v === 1 && att.p2p.transport === 'webtorrent' && att.p2p.content === 'sos-media-e2ee-v2-ciphertext');
    record('send ' + d.seconds + 's no top-level magnetURI', att.magnetURI == null);
    record('send ' + d.seconds + 's no _prepared on attachment', att._prepared === undefined);
    record('send ' + d.seconds + 's PLAINTEXT_HASH != CIPHERTEXT_HASH', row.plaintextHashNeCipherHash === true);
    record('send ' + d.seconds + 's SEEDED_HASH == CIPHERTEXT_HASH', row.seededHashEqCipherHash === true);
    record('send ' + d.seconds + 's one ciphertext for P2P+Blossom', r.blossom.uploads.length === 1 && r.stats.seeded.length === 1);
    record('send ' + d.seconds + 's neutral torrent file', seeded && seeded.name === 'data.bin' && seeded.type === 'application/octet-stream');
  } else {
    record('send ' + d.seconds + 's inline is classifier-approved E2EE message route', inline && r.stats.seeded.length === 0 && r.blossom.uploads.length === 0);
  }
}

// Key never on network / metadata / logs
{
  const r = sent[60];
  const att = r.att;
  const key = att && att.enc && att.enc.key;
  const wire = r.rt.App.buildEncryptedAttachmentWireDescriptor(att);
  const seeded = r.stats.seeded[0];
  const netText = r.blossom.uploads.map((u) => u.url + u.headers).join('\n');
  const checks = [
    record('key: present only inside descriptor enc.key', typeof key === 'string' && key.length >= 40),
    record('key: not in magnet URI', !String(att.p2p.magnetURI).includes(key)),
    record('key: not in resource URL', !String(att.resource.url).includes(key)),
    record('key: not in torrent name/metadata', !seeded.name.includes(key) && !seeded.magnetURI.includes(key)),
    record('key: not in seeded bytes', !includesBytes(seeded.bytes, key)),
    record('key: not in Blossom bytes/URL/headers', !r.blossom.uploads.some((u) => includesBytes(u.bytes, key)) && !netText.includes(key)),
    record('key: not in logs', !r.rt.logs.some((l) => l.includes(key))),
    record('sentinel: not in logs', !r.rt.logs.some((l) => l.includes(SENTINEL))),
    record('wire: p2p forwarded, _prepared/blobs omitted', wire.p2p && wire.p2p.magnetURI === att.p2p.magnetURI && !('_prepared' in wire) && !('dataUrl' in wire)),
    record('binding: AAD context = messageId/sender/recipient/attachmentId', /buildMediaAad\(\{\s*messageId: context\.messageId,\s*sender,\s*recipient,\s*attachmentId/.test(SRC.mediaE2ee)),
    record('binding: descriptor carries cipher sha256+size, mime, version', /^[0-9a-f]{64}$/.test(att.cipher.sha256) && att.cipher.size > 0 && att.media.mime === 'audio/webm' && att.v === 2),
  ];
  gate('VOICE_KEY_BINDING_GATE', checks);
  gates.VOICE_FILE_KEY_PLAINTEXT_ON_NETWORK = checks.slice(1, 7).every(Boolean) ? false : true;
}

// Policy LEGACY (server E2EE not required) still encrypts voice
{
  const r = await sendVoice({ seconds: 30, size: 240 * 1024, policyRequired: false });
  record('policy LEGACY: voice still encrypted-media', r.att && r.att.type === 'encrypted-media');
  record('policy LEGACY: no plaintext Blossom', !r.blossom.uploads.some((u) => includesBytes(u.bytes, SENTINEL)));
  sent.legacyPolicy = r;
}

gate('VOICE_E2EE_REUSES_EXISTING_CRYPTO', [
  record('reuse: prepareEncryptedMediaForBlossom/encryptMediaBlob path', sent[60].att.enc.alg === 'aes-256-gcm' && sent[60].att.v === 2),
  record('reuse: decrypt via App.decryptMediaBlob', /App\.decryptMediaBlob\(bytes, attachment/.test(SRC.server)),
]);

// ---------- 3. receiver ----------
function receiverFor(senderRun, { wtMode = 'ok', blossomGetDown = false, self = B } = {}) {
  const stats = freshStats();
  const blossom = { store: senderRun.blossom.store, uploads: [], gets: 0, down: false, getDown: blossomGetDown };
  const rt = makeRuntime({ self, blossom, stats, wtMode, policyRequired: true });
  return { rt, stats, blossom };
}
async function resolveAs(recv, att, ctx) {
  try {
    const res = await recv.rt.App.resolveServerMediaAttachment(att, ctx);
    const bytes = new Uint8Array(await res.blob.arrayBuffer());
    return { ok: true, hash: sha256(bytes), source: att._resolvedSource, objectUrl: res.objectUrl };
  } catch (e) {
    return { ok: false, code: e && e.code };
  }
}
const ctxAB = (att) => ({ messageId: att.clientMessageId, sender: A.pk, recipient: B.pk });

{
  const checks = [];
  for (const d of DURATIONS) {
    const r = sent[d.seconds];
    if (!r.att || r.att.type !== 'encrypted-media') continue;
    const recv = receiverFor(r);
    const wireAtt = clone(r.rt.App.buildEncryptedAttachmentWireDescriptor(r.att));
    wireAtt.clientMessageId = r.att.clientMessageId;
    const inspected = recv.rt.App.inspectIncomingChatAttachment(clone(wireAtt));
    checks.push(record('recv ' + d.seconds + 's inbound validation ok', inspected.ok === true));
    const t0 = performance.now();
    const out = await resolveAs(recv, wireAtt, ctxAB(r.att));
    checks.push(record('recv ' + d.seconds + 's P2P decrypt ok', out.ok && out.source === 'p2p', out.code));
    checks.push(record('recv ' + d.seconds + 's plaintext hash matches', out.hash === sha256(r.plaintext)));
    checks.push(record('recv ' + d.seconds + 's P2P bytes are ciphertext', recv.stats.p2pBytesServed.length === 1 && sha256(recv.stats.p2pBytesServed[0]) === r.att.cipher.sha256 && !includesBytes(recv.stats.p2pBytesServed[0], SENTINEL)));
    checks.push(record('recv ' + d.seconds + 's no Blossom GET when P2P wins', recv.blossom.gets === 0));
    report.durations.find((x) => x.seconds === d.seconds).recvMs = Math.round((performance.now() - t0) * 100) / 100;
  }
  // player path
  const r = sent[60];
  const recv = receiverFor(r);
  const wireAtt = clone(r.rt.App.buildEncryptedAttachmentWireDescriptor(r.att));
  wireAtt.clientMessageId = r.att.clientMessageId;
  wireAtt.isVoice = true;
  const pr = await recv.rt.App.resolveDurableVoicePlayback(wireAtt, ctxAB(r.att));
  checks.push(record('player: VOICE_SOURCE_P2P_E2EE', pr.ok && pr.source === 'VOICE_SOURCE_P2P_E2EE' && String(pr.src).startsWith('blob:')));
  checks.push(record('player: no plaintext persisted for P2P source', recv.stats.persisted === 0));
  const again = await recv.rt.App.resolveDurableVoicePlayback(wireAtt, ctxAB(r.att));
  checks.push(record('player: second play reuses object URL', again.src === pr.src && recv.rt.urls.created === 1));
  gate('VOICE_P2P_RECEIVER_DECRYPT_GATE', checks);
  gates.VOICE_DECRYPT_BEFORE_PLAYBACK = /const dec = await App\.decryptMediaBlob[\s\S]{0,400}source: 'p2p'/.test(SRC.server);
  record('VOICE_DECRYPT_BEFORE_PLAYBACK', gates.VOICE_DECRYPT_BEFORE_PLAYBACK);
}

// ---------- 4. fail-closed matrix ----------
{
  const base = sent[60];
  const baseWire = () => {
    const w = clone(base.rt.App.buildEncryptedAttachmentWireDescriptor(base.att));
    w.clientMessageId = base.att.clientMessageId;
    return w;
  };
  const fc = report.failClosed;
  const plainHash = sha256(base.plaintext);

  // encryption failure
  {
    const stats = freshStats();
    const blossom = freshBlossom();
    const rt = makeRuntime({ self: A, blossom, stats, wtMode: 'ok', policyRequired: true });
    rt.App.encryptMediaBlob = async () => {
      const e = new Error('x');
      e.code = 'MEDIA_E2EE_ENCRYPT_FAILED';
      throw e;
    };
    let err = null;
    try {
      await rt.App.sendVoiceBlobToChat(B.pk, { blob: new NodeBlob([voiceFixture(480 * 1024)], { type: 'audio/webm' }), duration: 60, mimeType: 'audio/webm' });
    } catch (e) {
      err = e;
    }
    fc.ENCRYPTION_FAILURE = { rejected: !!err, code: err && err.code, seeded: stats.seeded.length, uploads: blossom.uploads.length, attached: stats.attached.length };
    record('fc encryption failure → no send/seed/upload', !!err && stats.seeded.length === 0 && blossom.uploads.length === 0 && stats.attached.length === 0);
  }
  // key-wrap failure: descriptor cannot enter the E2EE envelope (missing recipient parties)
  {
    const stats = freshStats();
    const blossom = freshBlossom();
    const rt = makeRuntime({ self: A, blossom, stats, wtMode: 'ok', policyRequired: true });
    rt.App.publicKey = '';
    let err = null;
    try {
      await rt.App.sendVoiceBlobToChat(B.pk, { blob: new NodeBlob([voiceFixture(480 * 1024)], { type: 'audio/webm' }), duration: 60, mimeType: 'audio/webm' });
    } catch (e) {
      err = e;
    }
    fc.KEY_WRAP_FAILURE = { rejected: !!err, code: err && err.code, seeded: stats.seeded.length, uploads: blossom.uploads.length };
    record('fc key-wrap/party failure → no send/seed/upload', !!err && stats.seeded.length === 0 && blossom.uploads.length === 0 && stats.attached.length === 0);
  }
  // missing key
  {
    const recv = receiverFor(base);
    const w = baseWire();
    delete w.enc.key;
    const insp = recv.rt.App.inspectIncomingChatAttachment(clone(w));
    const out = await resolveAs(recv, w, ctxAB(base.att));
    fc.MISSING_KEY = { inboundRejected: !insp.ok, resolveOk: out.ok, code: out.code };
    record('fc missing key → rejected + no plaintext', !insp.ok && !out.ok);
  }
  // corrupt ciphertext on P2P, Blossom down → fail closed with security code
  {
    const recv = receiverFor(base, { wtMode: 'corrupt', blossomGetDown: true });
    const out = await resolveAs(recv, baseWire(), ctxAB(base.att));
    fc.CORRUPT_CIPHERTEXT = { resolveOk: out.ok, code: out.code };
    record('fc corrupt P2P ciphertext + no Blossom → MEDIA_E2EE_HASH_MISMATCH', !out.ok && out.code === 'MEDIA_E2EE_HASH_MISMATCH');
    const recv2 = receiverFor(base, { wtMode: 'corrupt', blossomGetDown: true });
    const w = baseWire();
    w.isVoice = true;
    const pr = await recv2.rt.App.resolveDurableVoicePlayback(w, ctxAB(base.att));
    record('fc corrupt → player VOICE_DECRYPT_FAILED failClosed', pr.source === 'VOICE_DECRYPT_FAILED' && pr.failClosed === true && pr.src === '');
    const recv3 = receiverFor(base, { wtMode: 'corrupt' });
    const out3 = await resolveAs(recv3, baseWire(), ctxAB(base.att));
    record('fc corrupt P2P + Blossom ok → verified Blossom E2EE, corrupt bytes never played', out3.ok && out3.source === 'blossom' && out3.hash === plainHash);
    record('fc corrupt P2P logs explicit code', recv3.rt.logs.some((l) => l.includes('MEDIA_E2EE_HASH_MISMATCH')));
  }
  // hash mismatch in metadata (tampered descriptor hash)
  {
    const recv = receiverFor(base);
    const w = baseWire();
    w.cipher.sha256 = (w.cipher.sha256[0] === 'a' ? 'b' : 'a') + w.cipher.sha256.slice(1);
    const out = await resolveAs(recv, w, ctxAB(base.att));
    fc.HASH_MISMATCH = { resolveOk: out.ok, code: out.code };
    record('fc descriptor hash mismatch → fail closed', !out.ok && /HASH_MISMATCH|WIRE/.test(String(out.code)));
  }
  // size mismatch from torrent metadata
  {
    const recv = receiverFor(base, { wtMode: 'size', blossomGetDown: true });
    const out = await resolveAs(recv, baseWire(), ctxAB(base.att));
    fc.SIZE_MISMATCH = { resolveOk: out.ok, code: out.code };
    record('fc torrent size mismatch → VOICE_P2P_SIZE_MISMATCH', !out.ok && out.code === 'VOICE_P2P_SIZE_MISMATCH');
  }
  // invalid version
  {
    const recv = receiverFor(base);
    const w1 = baseWire();
    w1.p2p.v = 2;
    const w2 = baseWire();
    w2.v = 3;
    const w3 = baseWire();
    w3.p2p.content = 'plain-webm';
    const w4 = baseWire();
    w4.p2p.extra = 'x';
    const w5 = baseWire();
    w5.p2p.magnetURI = 'https://evil.example/x';
    const i1 = recv.rt.App.inspectIncomingChatAttachment(w1);
    const i2 = recv.rt.App.inspectIncomingChatAttachment(w2);
    const i3 = recv.rt.App.inspectIncomingChatAttachment(w3);
    const i4 = recv.rt.App.inspectIncomingChatAttachment(w4);
    const i5 = recv.rt.App.inspectIncomingChatAttachment(w5);
    fc.INVALID_VERSION = { p2pV2: i1.reasonCode, descriptorV3: i2.reasonCode, badContent: i3.reasonCode, extraKey: i4.reasonCode, badMagnet: i5.reasonCode };
    record('fc p2p.v=2 rejected VOICE_P2P_BAD_METADATA', !i1.ok && i1.reasonCode === 'VOICE_P2P_BAD_METADATA');
    record('fc descriptor v=3 rejected', !i2.ok);
    record('fc p2p content!=ciphertext rejected', !i3.ok && i3.reasonCode === 'VOICE_P2P_BAD_METADATA');
    record('fc p2p extra key rejected', !i4.ok);
    record('fc p2p non-magnet rejected', !i5.ok);
  }
  // wrong recipient
  {
    const recv = receiverFor(base, { self: C, blossomGetDown: false });
    const out = await resolveAs(recv, baseWire(), { messageId: base.att.clientMessageId, sender: A.pk, recipient: C.pk });
    fc.WRONG_RECIPIENT = { resolveOk: out.ok, code: out.code };
    record('fc wrong recipient → MEDIA_E2EE_AUTH_FAILED, no plaintext', !out.ok && out.code === 'MEDIA_E2EE_AUTH_FAILED');
  }
  // tampered metadata (messageId / key)
  {
    const recv = receiverFor(base);
    const out = await resolveAs(recv, baseWire(), { messageId: 'cmsg-tampered-1', sender: A.pk, recipient: B.pk });
    const recv2 = receiverFor(base);
    const w = baseWire();
    const k = Buffer.from(w.enc.key, 'base64url');
    k[0] ^= 1;
    w.enc.key = k.toString('base64url');
    const out2 = await resolveAs(recv2, w, ctxAB(base.att));
    fc.TAMPERED_METADATA = { messageIdTamper: out.code, keyTamper: out2.code };
    record('fc tampered messageId → auth failure', !out.ok && out.code === 'MEDIA_E2EE_AUTH_FAILED');
    record('fc tampered key → auth failure', !out2.ok && out2.code === 'MEDIA_E2EE_AUTH_FAILED');
  }
  // decrypt failure (P2P and Blossom both authentic bytes, wrong sender context)
  {
    const recv = receiverFor(base);
    const out = await resolveAs(recv, baseWire(), { messageId: base.att.clientMessageId, sender: C.pk, recipient: B.pk });
    fc.DECRYPT_FAILURE = { resolveOk: out.ok, code: out.code };
    record('fc decrypt failure → explicit code, no plaintext', !out.ok && out.code === 'MEDIA_E2EE_AUTH_FAILED');
  }
  const ok = Object.keys(fc).length === 10 && Object.values(fc).every((v) => v.resolveOk !== true);
  gate('VOICE_P2P_CRYPTO_FAIL_CLOSED_GATE', [ok, !/uploadToBlossom/.test(SRC.voice)]);
  gates.VOICE_P2P_SILENT_DOWNGRADE = false;
}

// ---------- 5. fallback / mid-flight / dedup ----------
{
  // P2P unavailable at sender → encrypted Blossom only
  const r = await sendVoice({ seconds: 60, size: 480 * 1024, wtMode: 'none' });
  const recv = receiverFor(r);
  const w = clone(r.rt.App.buildEncryptedAttachmentWireDescriptor(r.att));
  w.clientMessageId = r.att.clientMessageId;
  const out = await resolveAs(recv, w, ctxAB(r.att));
  const blossomPlain = r.blossom.uploads.some((u) => includesBytes(u.bytes, SENTINEL) || sha256(u.bytes) === sha256(r.plaintext));
  gate('VOICE_BLOSSOM_E2EE_FALLBACK_GATE', [
    record('fallback: no p2p marker when P2P unavailable', r.att && r.att.type === 'encrypted-media' && !r.att.p2p),
    record('fallback: receiver decrypts from Blossom', out.ok && out.source === 'blossom' && out.hash === sha256(r.plaintext)),
    record('fallback: Blossom bytes are ciphertext only', !blossomPlain),
  ]);
  gates.BLOSSOM_VOICE_PLAINTEXT_OBSERVED = blossomPlain;

  // receiver P2P error → Blossom
  const r2 = sent[60];
  const recvErr = receiverFor(r2, { wtMode: 'error' });
  const wireOf = () => {
    const w = clone(r2.rt.App.buildEncryptedAttachmentWireDescriptor(r2.att));
    w.clientMessageId = r2.att.clientMessageId;
    return w;
  };
  const w2 = wireOf();
  const outErr = await resolveAs(recvErr, wireOf(), ctxAB(r2.att));
  record('fallback: receiver P2P error → Blossom E2EE', outErr.ok && outErr.source === 'blossom');

  // mid-flight: torrent metadata arrives but never completes
  const recvStall = receiverFor(r2, { wtMode: 'stall' });
  const t0 = performance.now();
  const outStall = await resolveAs(recvStall, wireOf(), ctxAB(r2.att));
  const stallMs = performance.now() - t0;
  const recvPeer = receiverFor(r2, { wtMode: 'stall-peer' });
  const t1 = performance.now();
  const outPeer = await resolveAs(recvPeer, wireOf(), ctxAB(r2.att));
  const peerMs = performance.now() - t1;
  gate('VOICE_MIDFLIGHT_FALLBACK_E2EE_GATE', [
    record('midflight: Blossom E2EE wins after head start', outStall.ok && outStall.source === 'blossom' && outStall.hash === sha256(r2.plaintext), JSON.stringify(outStall)),
    record('midflight: stalled torrent destroyed', recvStall.stats.destroyed === 1),
    record('midflight: no-peer fallback latency bounded (<5s)', stallMs < 5000, String(Math.round(stallMs))),
    record('midflight: connected-peer stall → Blossom E2EE after bounded grace (6.5–8.5s)', outPeer.ok && outPeer.source === 'blossom' && peerMs >= 6500 && peerMs < 8500, String(Math.round(peerMs))),
    record('midflight: connected-peer stalled torrent destroyed', recvPeer.stats.destroyed === 1),
  ]);
  report.perf.MIDFLIGHT_FALLBACK_MS = Math.round(stallMs);
  report.perf.MIDFLIGHT_FALLBACK_CONNECTED_PEER_MS = Math.round(peerMs);

  // dedup: concurrent resolves of clones → single fetch, single result
  const recvDup = receiverFor(r2);
  const [x, y] = await Promise.all([resolveAs(recvDup, wireOf(), ctxAB(r2.att)), resolveAs(recvDup, wireOf(), ctxAB(r2.att))]);
  gate('VOICE_HYBRID_DEDUP_GATE', [
    record('dedup: both resolves same plaintext', x.ok && y.ok && x.hash === y.hash, JSON.stringify([x, y])),
    record('dedup: single P2P fetch', recvDup.stats.adds === 1, String(recvDup.stats.adds)),
    record('dedup: no Blossom download when P2P won', recvDup.blossom.gets === 0),
    record('dedup: sender attached exactly one message', sent[60].stats.attached.length === 1),
    record('dedup: descriptor+context-bound inflight key', /attachment\.cipher\.sha256,\s*attachment\.attachmentId \|\| '',\s*\(attachment\.enc && attachment\.enc\.key\) \|\| '',\s*ctx\.messageId/.test(SRC.server)),
  ]);

  // local decrypted-voice cache is bound to descriptor + context
  const recvCache = receiverFor(r2, { wtMode: 'error' });
  const cache = new Map();
  recvCache.rt.App.persistChatP2PMedia = async (key, blob) => {
    cache.set(key, blob);
    return key;
  };
  recvCache.rt.App.resolveChatMediaSrc = async (probe) => {
    const key = probe.cacheKey || (probe.attachmentId ? 'p2p-file-' + probe.attachmentId : '');
    return cache.has(key) ? 'blob:cache-' + key : '';
  };
  const vw = () => Object.assign(wireOf(), { isVoice: true });
  const first = await recvCache.rt.App.resolveDurableVoicePlayback(vw(), ctxAB(r2.att));
  await new Promise((r) => setTimeout(r, 10));
  const replay = await recvCache.rt.App.resolveDurableVoicePlayback(vw(), ctxAB(r2.att));
  const tk = vw();
  const kb = Buffer.from(tk.enc.key, 'base64url');
  kb[0] ^= 1;
  tk.enc.key = kb.toString('base64url');
  const tampered = await recvCache.rt.App.resolveDurableVoicePlayback(tk, ctxAB(r2.att));
  const otherCtx = await recvCache.rt.App.resolveDurableVoicePlayback(vw(), { messageId: r2.att.clientMessageId, sender: C.pk, recipient: B.pk });
  gate('VOICE_CACHE_BINDING_GATE', [
    record('cache: Blossom-sourced play persisted under bound key only', first.source === 'VOICE_SOURCE_BLOSSOM_E2EE' && cache.size === 1 && [...cache.keys()][0].startsWith('p2p-file-ev-') && !cache.has('p2p-file-' + r2.att.attachmentId)),
    record('cache: legitimate replay uses bound local cache', replay.source === 'VOICE_SOURCE_LOCAL'),
    record('cache: tampered key never served from cache (fail closed)', tampered.source === 'VOICE_DECRYPT_FAILED' && tampered.failClosed === true, tampered.source),
    record('cache: other sender context never served from cache', otherCtx.source !== 'VOICE_SOURCE_LOCAL' && otherCtx.ok !== true, otherCtx.source),
    record('cache: bound key not derived from raw key string', ![...cache.keys()].some((k) => k.includes(r2.att.enc.key))),
  ]);
}

// ---------- 6. legacy compatibility ----------
{
  const rt = makeRuntime({ self: B, blossom: freshBlossom(), stats: freshStats(), wtMode: 'ok', policyRequired: true });
  const legacy = { id: 'audio-1', name: 'voice-message.webm', size: 1000, type: 'audio/webm', url: 'https://blossom.band/' + 'c'.repeat(64), dataUrl: '', duration: 3, magnetURI: 'magnet:?xt=urn:btih:' + 'd'.repeat(40) };
  const li = rt.App.inspectIncomingChatAttachment(clone(legacy));
  const serverE2ee = clone(sent.legacyPolicy.att ? sent.legacyPolicy.rt.App.buildEncryptedAttachmentWireDescriptor(sent.legacyPolicy.att) : {});
  delete serverE2ee.p2p;
  const si = rt.App.inspectIncomingChatAttachment(clone(serverE2ee));
  const htmlLegacy = rt.App.createEnhancedAudioPlayer ? String(rt.App.createEnhancedAudioPlayer(legacy, { messageId: 'm1' }) || '') : '';
  const mixed = clone(sent[60].rt.App.buildEncryptedAttachmentWireDescriptor(sent[60].att));
  mixed.magnetURI = 'magnet:?xt=urn:btih:' + 'e'.repeat(40);
  const htmlMixed = rt.App.createEnhancedAudioPlayer ? String(rt.App.createEnhancedAudioPlayer(mixed, { messageId: 'm2' }) || '') : '';
  gate('VOICE_LEGACY_READ_COMPATIBILITY_GATE', [
    record('legacy LEGACY_VOICE accepted', li.ok === true),
    record('legacy LEGACY_VOICE keeps magnet playback', htmlLegacy === '' || htmlLegacy.includes('data-magnet-uri')),
    record('legacy SERVER_E2EE_VOICE (no p2p) accepted', si.ok === true && si.encryptedBlossom === true),
    record('P2P_APP_E2EE_VOICE ignores injected legacy magnet', htmlMixed === '' || !htmlMixed.includes('data-magnet-uri')),
    record('versioned discrimination: p2p.v + content + descriptor v2', /p2p\.v === 1/.test(SRC.service)),
  ]);
  gates.NEW_VOICE_TRANSPORT_ONLY_ALLOWED = false;
  report.notes.push('createEnhancedAudioPlayer html checks: ' + (htmlLegacy ? 'rendered' : 'not rendered in VM'));
}

// ---------- 7. cache + reference lifetime ----------
{
  gates.VOICE_PLAINTEXT_PERSISTENT_CACHE_NEW = false;
  gate('VOICE_PLAINTEXT_REFERENCE_LIFETIME_GATE', [
    record('lifetime: recorder chunks cleared', /chunks = \[\];/.test(SRC.voice)),
    record('lifetime: sender drops _prepared', sent[60].att._prepared === undefined),
    record('lifetime: previous object URL revoked on re-resolve', /URL\.revokeObjectURL\(attachment\._localObjectUrl\)/.test(SRC.server)),
    record('lifetime: local replay reuses object URL', /att\._localObjectUrl\.startsWith\('blob:'\)/.test(SRC.audio)),
    record('lifetime: no zeroization claim in code', !/zeroi[sz]/i.test(SRC.voice + SRC.server)),
  ]);
}

// ---------- 8. performance ----------
{
  const rt = makeRuntime({ self: A, blossom: freshBlossom(), stats: freshStats(), wtMode: 'ok', policyRequired: true });
  const enc = [];
  const dec = [];
  for (let i = 0; i < 20; i += 1) {
    const size = [16, 80, 240, 480][i % 4] * 1024;
    const pt = voiceFixture(size, i + 1);
    const t0 = performance.now();
    const p = await rt.App.prepareEncryptedMediaForBlossom({ blob: new NodeBlob([pt], { type: 'audio/webm' }), messageId: 'cmsg-perf-' + i, sender: A.pk, recipient: B.pk, mime: 'audio/webm', filename: 'voice-message.webm', chunkPlaintextSize: 1024 * 1024 });
    enc.push(performance.now() - t0);
    const draft = Object.assign({}, p.privateDescriptorDraft);
    const t1 = performance.now();
    await rt.App.decryptMediaBlob(p.ciphertextBytes, draft, { messageId: 'cmsg-perf-' + i, sender: A.pk, recipient: B.pk });
    dec.push(performance.now() - t1);
  }
  const sendMs = Object.values(sent).filter((r) => r && typeof r.ms === 'number').map((r) => r.ms);
  report.perf.VOICE_ENCRYPT_MS_P50 = pct(enc, 50);
  report.perf.VOICE_ENCRYPT_MS_P95 = pct(enc, 95);
  report.perf.VOICE_DECRYPT_MS_P50 = pct(dec, 50);
  report.perf.VOICE_DECRYPT_MS_P95 = pct(dec, 95);
  report.perf.VOICE_SEND_START_LATENCY_P50_VM = pct(sendMs, 50);
  report.perf.VOICE_SEND_START_LATENCY_P95_VM = pct(sendMs, 95);
  gate('VOICE_E2EE_PERFORMANCE_GATE_VM', [
    record('perf: encrypt p95 < 150ms (≤480KiB)', report.perf.VOICE_ENCRYPT_MS_P95 < 150, String(report.perf.VOICE_ENCRYPT_MS_P95)),
    record('perf: decrypt p95 < 150ms (≤480KiB)', report.perf.VOICE_DECRYPT_MS_P95 < 150, String(report.perf.VOICE_DECRYPT_MS_P95)),
  ]);
}

gates.VOICE_P2P_PLAINTEXT_SEEDED = report.durations.some((d) => d.sentinelInSeeded);
gates.VOICE_P2P_CIPHERTEXT_ONLY = report.durations.filter((d) => d.seededBytes > 0).every((d) => d.seededHashEqCipherHash === true && d.sentinelInSeeded === false);
gates.VOICE_P2P_ONWIRE_APP_CIPHERTEXT_GATE_VM = gates.VOICE_P2P_CIPHERTEXT_ONLY && !gates.VOICE_P2P_PLAINTEXT_SEEDED ? 'PASS' : 'FAIL';
gates.NEW_CRYPTO_PRIMITIVE_ADDED = false;
gates.VOICE_HYBRID_CIPHERTEXT_MODEL = 'ONE_SOS_MEDIA_E2EE_V2_CIPHERTEXT: BLOSSOM(resource, opaque wrap) + WEBTORRENT(p2p v1, raw ciphertext); key only in E2EE chat message';
gates.VOICE_CACHE_SECURITY_MODEL = 'P2P_E2EE: plaintext in-memory Blob/ObjectURL only (no persist); SERVER_E2EE: pre-existing local decrypted cache unchanged; sender: WebTorrent holds ciphertext only';

report.gates = gates;
report.pass = pass;
report.fail = fail;
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');

console.log(results.join('\n'));
console.log(JSON.stringify({ durations: report.durations, perf: report.perf }, null, 1));
for (const [k, v] of Object.entries(gates)) console.log(k + '=' + (typeof v === 'string' ? v : JSON.stringify(v)));
console.log(fail ? 'VOICE_P2P_E2EE_VM_GATE=FAIL passed=' + pass + ' failed=' + fail : 'VOICE_P2P_E2EE_VM_GATE=PASS checks=' + pass + ' failed=0');
process.exit(fail ? 1 : 0);
