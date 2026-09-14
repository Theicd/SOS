#!/usr/bin/env node
/**
 * Deterministic QA for P2P file-transfer ACK/send/completion idempotency.
 * Loads chat-p2p-file.js in a VM. No browser, no network, no protocol change.
 * Run: node qa/p2p-file-idempotency.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'chat-p2p-file.js'), 'utf8');

const results = [];
let passCount = 0;
let failCount = 0;

function record(name, ok, detail = '') {
  if (ok) {
    passCount += 1;
    results.push('PASS ' + name);
    return;
  }
  failCount += 1;
  results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(pred, timeoutMs = 2500, label = 'wait') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(label + ' timed out');
}

class FakeFileReader {
  constructor() {
    this.onload = null;
    this.onerror = null;
    this.result = null;
  }
  readAsArrayBuffer(blob) {
    Promise.resolve()
      .then(() => {
        if (blob && typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
        return blob;
      })
      .then((ab) => {
        this.result = ab;
        if (typeof this.onload === 'function') this.onload({ target: this });
      })
      .catch((err) => {
        if (typeof this.onerror === 'function') this.onerror(err);
      });
  }
}

function createOpenChannel(label = 'file-transfer') {
  const listeners = [];
  const ch = {
    label,
    readyState: 'open',
    binaryType: 'arraybuffer',
    bufferedAmount: 0,
    sent: [],
    send(data) {
      this.sent.push(data);
    },
    addEventListener(type, fn) {
      if (type === 'message') listeners.push(fn);
    },
    dispatch(data) {
      const ev = { data, currentTarget: ch };
      if (typeof ch.onmessage === 'function') ch.onmessage(ev);
      listeners.forEach((fn) => fn(ev));
    },
    get listenerCount() {
      return listeners.length;
    },
  };
  return ch;
}

function makeFile(size, name = 't.bin') {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = i % 251;
  if (typeof File === 'function') return new File([buf], name, { type: 'application/octet-stream' });
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  blob.name = name;
  return blob;
}

async function makeKeyPair(cryptoSubtle) {
  const key = await cryptoSubtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const exported = await cryptoSubtle.exportKey('raw', key);
  const bytes = new Uint8Array(exported);
  const keyStr = btoa(String.fromCharCode(...bytes));
  return { key, keyStr };
}

function loadHarness() {
  const notes = [];
  const appended = [];
  const persisted = [];
  const progress = [];
  const App = {
    publicKey: 'aa'.repeat(32),
    persistChatP2PMedia: async (fileId) => {
      persisted.push(fileId);
    },
    appendChatMessage: (msg) => {
      appended.push(msg);
    },
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    crypto: webcrypto,
    FileReader: FakeFileReader,
    Blob,
    File,
    Uint8Array,
    ArrayBuffer,
    Uint16Array,
    Promise,
    Map,
    Set,
    JSON,
    Math,
    Date,
    Number,
    String,
    Object,
    Error,
    TypeError,
    Array,
    parseInt,
    isNaN,
    atob,
    btoa,
    URL: {
      createObjectURL: () => 'blob:qa-p2p-file',
      revokeObjectURL: () => {},
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    NostrApp: App,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  App._p2pFileQaNote = (event, detail) => {
    notes.push({ event, ...(detail || {}) });
  };

  App.subscribeP2PFileProgress((evt) => {
    progress.push(evt);
  });

  return {
    App,
    notes,
    appended,
    persisted,
    progress,
    count(event, extraPred) {
      return notes.filter((n) => n.event === event && (!extraPred || extraPred(n))).length;
    },
  };
}

function ackMsg(fileId, index) {
  return JSON.stringify({ type: 'chunk-ack', fileId, index });
}

async function createSendTransfer(h, { chunks = 3, fileId = 'qa-file-' + Math.random().toString(36).slice(2) } = {}) {
  const size = chunks * h.App.P2P_FILE_CHUNK_SIZE;
  const file = makeFile(size);
  const { key, keyStr } = await makeKeyPair(webcrypto.subtle);
  const channel = createOpenChannel('file-transfer');
  const peer = 'bb'.repeat(32);
  const transfer = {
    fileId,
    file,
    key,
    keyStr,
    peerPubkey: peer,
    direction: 'send',
    currentChunk: 0,
    totalChunks: chunks,
    ackReceived: 0,
    paused: false,
    startTime: Date.now(),
    caption: '',
    dcWaitAttempts: 0,
    channel,
    lastAckedChunk: -1,
    completed: false,
    _sendInFlight: false,
    _sendQueued: false,
    _dcOfferSent: false,
    nextChunkToSend: 0,
    inFlightChunks: new Set(),
    ackedChunks: new Set(),
    sendGeneration: 0,
    maxInFlightSeen: 0,
  };
  h.App.activeP2PTransfers.set(fileId, transfer);
  return { fileId, transfer, channel, peer, file };
}

function injectAck(h, peer, fileId, index) {
  h.App._p2pFileQa.handleIncomingMessage(peer, ackMsg(fileId, index), null);
}

function maxInFlight(h) {
  const notes = h.notes.filter((n) => n.event === 'in-flight');
  return notes.reduce((m, n) => Math.max(m, n.count || 0, n.max || 0), 0);
}

async function ackAllSent(h, peer, fileId, transfer) {
  const sent = new Set(h.notes.filter((n) => n.event === 'chunk-sent').map((n) => n.chunkIndex));
  for (const idx of [...sent].sort((a, b) => a - b)) {
    if (!transfer.ackedChunks.has(idx)) injectAck(h, peer, fileId, idx);
  }
}

async function runA() {
  const h = loadHarness();
  const { fileId, transfer } = await createSendTransfer(h, { chunks: 10, fileId: 'qa-A' });
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => h.count('chunk-sent') >= 4, 2000, 'A window fill');
  await sleep(30);
  record('A window bound', h.count('chunk-sent') === 4 && maxInFlight(h) <= 4 && transfer.inFlightChunks.size === 4 && transfer.nextChunkToSend === 4, `sent=${h.count('chunk-sent')} maxIF=${maxInFlight(h)} inFlight=${transfer.inFlightChunks.size}`);
  h.App.cancelP2PFile(fileId);
}

async function runB() {
  const h = loadHarness();
  const { fileId, transfer, peer } = await createSendTransfer(h, { chunks: 10, fileId: 'qa-B' });
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => h.count('chunk-sent') === 4, 2000, 'B fill');
  injectAck(h, peer, fileId, 0);
  injectAck(h, peer, fileId, 0);
  injectAck(h, peer, fileId, 0);
  await waitUntil(() => h.count('chunk-sent', (n) => n.chunkIndex === 4) === 1, 2000, 'B slot fill');
  await sleep(40);
  record('B duplicate ACK', h.count('chunk-sent', (n) => n.chunkIndex === 4) === 1 && h.count('chunk-ack-accepted') === 1 && h.count('chunk-ack-ignored', (n) => n.reason === 'duplicate-or-stale') >= 2 && maxInFlight(h) <= 4, `sent4=${h.count('chunk-sent', (n) => n.chunkIndex === 4)} acked=${h.count('chunk-ack-accepted')} ign=${h.count('chunk-ack-ignored')}`);
  h.App.cancelP2PFile(fileId);
}

async function runC() {
  const h = loadHarness();
  const { fileId, transfer, peer } = await createSendTransfer(h, { chunks: 8, fileId: 'qa-C' });
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => h.count('chunk-sent') === 4);
  injectAck(h, peer, fileId, 2);
  injectAck(h, peer, fileId, 0);
  injectAck(h, peer, fileId, 1);
  await waitUntil(() => transfer.ackedChunks.size === 3 && h.count('chunk-sent') >= 7, 2000, 'C ooo fill');
  record('C out-of-order ACK', transfer.ackedChunks.has(0) && transfer.ackedChunks.has(1) && transfer.ackedChunks.has(2) && !transfer.ackedChunks.has(3) && transfer.inFlightChunks.has(3) && maxInFlight(h) <= 4 && h.count('chunk-ack-accepted') === 3, `acked=${[...transfer.ackedChunks].join(',')} inFlight=${[...transfer.inFlightChunks].join(',')} next=${transfer.nextChunkToSend}`);
  h.App.cancelP2PFile(fileId);
}

async function runD() {
  const h = loadHarness();
  const { fileId, transfer, channel } = await createSendTransfer(h, { chunks: 8, fileId: 'qa-D' });
  channel.bufferedAmount = 600 * 1024;
  const pump = h.App._p2pFileQa.sendNextChunk(fileId);
  await sleep(40);
  record('D buffer pause', h.count('chunk-sent') === 0 && h.count('buffer-pause') >= 1, `sent=${h.count('chunk-sent')} pauses=${h.count('buffer-pause')}`);
  channel.bufferedAmount = 0;
  await pump.catch(() => {});
  await waitUntil(() => h.count('chunk-sent') === 4, 2000, 'D resume');
  record('D buffer resume', h.count('chunk-sent') === 4 && maxInFlight(h) <= 4, `sent=${h.count('chunk-sent')}`);
  h.App.cancelP2PFile(fileId);
}

async function runE() {
  const h = loadHarness();
  const { fileId, transfer, peer } = await createSendTransfer(h, { chunks: 5, fileId: 'qa-E' });
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => h.count('chunk-sent') === 4);
  record('E no complete before acks', h.count('complete') === 0 && !transfer.completed, `complete=${h.count('complete')}`);
  injectAck(h, peer, fileId, 0);
  injectAck(h, peer, fileId, 1);
  injectAck(h, peer, fileId, 2);
  injectAck(h, peer, fileId, 3);
  await waitUntil(() => h.count('chunk-sent') === 5, 2000, 'E last send');
  injectAck(h, peer, fileId, 4);
  await waitUntil(() => h.count('complete') === 1, 2000, 'E complete');
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await h.App._p2pFileQa.completeSendOnce(fileId, transfer, null);
  injectAck(h, peer, fileId, 4);
  await sleep(40);
  const completeProg = h.progress.filter((p) => p.status === 'complete').length;
  record('E completion once after all ACKs', h.count('complete') === 1 && completeProg === 1 && h.persisted.length === 1 && h.appended.length === 1 && h.count('transfer-complete-event') === 1, `complete=${h.count('complete')} prog=${completeProg}`);
}

async function runF() {
  const h = loadHarness();
  const { fileId, transfer, peer } = await createSendTransfer(h, { chunks: 8, fileId: 'qa-F' });
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => transfer.nextChunkToSend === 4);
  injectAck(h, peer, fileId, 0);
  await waitUntil(() => transfer.nextChunkToSend === 5);
  await h.App.handleFileResendRequest(peer, { type: 'file-resend-request', fileId, fromChunk: 2 });
  await waitUntil(() => transfer.sendGeneration >= 1 && h.count('chunk-sent', (n) => n.chunkIndex === 2) >= 2, 2000, 'F rewind send');
  record('F rewind', transfer.lastAckedChunk === 1 && transfer.ackedChunks.has(0) && transfer.ackedChunks.has(1) && !transfer.ackedChunks.has(2) && transfer.sendGeneration >= 1, `gen=${transfer.sendGeneration} next=${transfer.nextChunkToSend} last=${transfer.lastAckedChunk} acked=${[...transfer.ackedChunks].join(',')}`);
  const deadline = Date.now() + 2500;
  while (!transfer.completed && Date.now() < deadline) {
    const pending = [...(transfer.inFlightChunks || [])];
    if (!pending.length) {
      await sleep(10);
      continue;
    }
    pending.forEach((idx) => injectAck(h, peer, fileId, idx));
    await sleep(10);
  }
  record('F resend then complete once', h.count('complete') === 1 && transfer.completed && transfer.ackedChunks.size === 8, `complete=${h.count('complete')} acked=${transfer.ackedChunks.size}`);
}

async function runG() {
  const h = loadHarness();
  const { fileId, transfer, peer } = await createSendTransfer(h, { chunks: 6, fileId: 'qa-G-stall' });
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => h.count('chunk-sent') === 4);
  const gen0 = transfer.sendGeneration;
  await h.App.handleFileResendRequest(peer, { type: 'file-resend-request', fileId, fromChunk: 0 });
  await waitUntil(() => transfer.sendGeneration > gen0, 2000, 'G gen bump');
  injectAck(h, peer, fileId, 3);
  await sleep(20);
  record('G old ACK after rewind ignored', !transfer.ackedChunks.has(3) && h.count('chunk-ack-ignored', (n) => n.reason === 'not-in-flight') >= 1, `acked3=${transfer.ackedChunks.has(3)}`);
  h.App.cancelP2PFile(fileId);

  const h2 = loadHarness();
  const { keyStr } = await makeKeyPair(webcrypto.subtle);
  const fileId2 = 'qa-G-offer';
  const peer2 = 'cc'.repeat(32);
  let release;
  const gate = new Promise((r) => { release = r; });
  h2.App._p2pFileQaHold = async (phase) => {
    if (phase === 'before-import-key') await gate;
  };
  const offer = {
    type: 'file-offer',
    fileId: fileId2,
    name: 'g.bin',
    size: 128,
    mimeType: 'application/octet-stream',
    keyStr,
    totalChunks: 1,
    createdAt: Math.floor(Date.now() / 1000),
  };
  const p1 = h2.App.handleP2PFileOffer(peer2, offer);
  const p2 = h2.App.handleP2PFileOffer(peer2, offer);
  await sleep(30);
  release();
  await Promise.all([p1, p2]);
  const receiveCount = [...h2.App.activeP2PTransfers.values()].filter((t) => t.direction === 'receive' && t.fileId === fileId2).length;
  record('G simultaneous offers still single init', h2.count('offer-reserved') === 1 && receiveCount === 1, `reserved=${h2.count('offer-reserved')} after=${receiveCount}`);
  h2.App.cancelP2PFile(fileId2);
}

async function runH() {
  const h = loadHarness();
  const peer = 'dd'.repeat(32);
  record('H no wire MAX_IN_FLIGHT leak', h.App.P2P_FILE_MAX_IN_FLIGHT === 4 && h.App.P2P_FILE_CHUNK_SIZE === 64 * 1024);

  const fresh = createOpenChannel('file-transfer');
  h.App._p2pFileQa.attachCanonicalFileHandler(peer, fresh);
  h.App._p2pFileQa.attachCanonicalFileHandler(peer, fresh);
  fresh.dispatch(JSON.stringify({ type: 'chunk-ack', fileId: 'none', index: 0 }));
  record('H attach once', fresh.listenerCount === 1 && h.count('incoming-message') === 1);

  const src = fs.readFileSync(path.join(ROOT, 'chat-p2p-file.js'), 'utf8');
  record('H wire unchanged', SRC.includes("type: 'chunk-ack'") && SRC.includes("type: 'chunk-meta'") && SRC.includes('MAX_IN_FLIGHT = 4') && SRC.includes("type: 'file-resend-request'"));
}

async function main() {
  if (!SRC.includes('MAX_IN_FLIGHT = 4') || !SRC.includes('inFlightChunks') || !SRC.includes('ackedChunks')) {
    record('source markers', false, 'window helpers missing');
  } else {
    record('source markers', true);
  }

  await runA();
  await runB();
  await runC();
  await runD();
  await runE();
  await runF();
  await runG();
  await runH();

  results.forEach((line) => console.log(line));
  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount) process.exit(1);
  console.log('\nP2P file window=4 gate passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL harness', err);
  process.exit(1);
});
