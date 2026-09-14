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
  results.push('FAIL ' + name + (detail ? ' ג€” ' + detail : ''));
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
    nextChunkToPrepare: 0,
    inFlightChunks: new Set(),
    ackedChunks: new Set(),
    preparingChunks: new Map(),
    preparedChunks: new Map(),
    sendGeneration: 0,
    maxInFlightSeen: 0,
    maxPreparingSeen: 0,
    maxPreparedSeen: 0,
    inFlightSampleSum: 0,
    inFlightSampleCount: 0,
    totalReadMs: 0,
    totalAesMs: 0,
    totalPrepareMs: 0,
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

function maxPreparing(h) {
  return h.notes.filter((n) => n.event === 'prepare-stats').reduce((m, n) => Math.max(m, n.preparing || 0, n.maxPreparing || 0), 0);
}

function sentIndexes(h) {
  return h.notes.filter((n) => n.event === 'chunk-sent').map((n) => n.chunkIndex);
}

function uniqueCounts(arr) {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  return m;
}

async function drainAcks(h, peer, fileId, transfer, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (!transfer.completed && Date.now() < deadline) {
    const pending = [...(transfer.inFlightChunks || [])];
    if (!pending.length) {
      await sleep(10);
      continue;
    }
    pending.forEach((idx) => injectAck(h, peer, fileId, idx));
    await sleep(5);
  }
}

async function runA() {
  const h = loadHarness();
  h.App._p2pFileQaHold = async (phase) => {
    if (phase === 'before-read') await sleep(80);
  };
  const { fileId, transfer } = await createSendTransfer(h, { chunks: 10, fileId: 'qa-A' });
  const kick = h.App._p2pFileQa.sendNextChunk(fileId);
  await sleep(30);
  const starts = h.notes.filter((n) => n.event === 'prepare-start').map((n) => n.chunkIndex);
  const startCounts = uniqueCounts(starts);
  const dup = [...startCounts.values()].some((c) => c > 1);
  record(
    'A preparation concurrency',
    transfer.preparingChunks.size >= 2 && maxPreparing(h) >= 2 && starts.length >= 2 && !dup && h.count('chunk-sent') === 0,
    `preparing=${transfer.preparingChunks.size} maxPrep=${maxPreparing(h)} starts=${starts.join(',')} sent=${h.count('chunk-sent')}`
  );
  await kick.catch(() => {});
  h.App.cancelP2PFile(fileId);
}

async function runB() {
  const h = loadHarness();
  const { fileId, transfer } = await createSendTransfer(h, { chunks: 12, fileId: 'qa-B' });
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => (transfer.preparedChunks.size + transfer.preparingChunks.size) >= 4 && transfer.inFlightChunks.size === 4, 2000, 'B prefetch');
  await sleep(40);
  const occ = transfer.preparedChunks.size + transfer.preparingChunks.size;
  record(
    'B network window <=4 with prefetch',
    transfer.inFlightChunks.size <= 4 && maxInFlight(h) <= 4 && occ <= 8 && (transfer.maxPreparedSeen || 0) <= 8 && h.count('chunk-sent') === 4,
    `inFlight=${transfer.inFlightChunks.size} occ=${occ} maxPrepared=${transfer.maxPreparedSeen} sent=${h.count('chunk-sent')}`
  );
  h.App.cancelP2PFile(fileId);
}

async function runC() {
  const h = loadHarness();
  let release2;
  const gate2 = new Promise((r) => { release2 = r; });
  h.App._p2pFileQaHold = async (phase, detail) => {
    if (phase === 'before-encrypt' && detail && detail.chunkIndex === 2) await gate2;
  };
  const { fileId, transfer } = await createSendTransfer(h, { chunks: 8, fileId: 'qa-C' });
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => h.count('prepare-ready', (n) => n.chunkIndex === 3) >= 1, 2000, 'C chunk3 ready');
  const sentBefore = sentIndexes(h);
  record(
    'C hold 2 does not skip to 3',
    sentBefore.includes(0) && sentBefore.includes(1) && !sentBefore.includes(3) && !h.count('chunk-sent', (n) => n.chunkIndex === 2),
    `sent=${sentBefore.join(',')}`
  );
  release2();
  await waitUntil(() => sentIndexes(h).includes(2) && sentIndexes(h).includes(3), 2000, 'C send 2 then 3');
  const sent = sentIndexes(h);
  record('C transmission order 2 before 3', sent.indexOf(2) >= 0 && sent.indexOf(2) < sent.indexOf(3), `sent=${sent.join(',')}`);
  h.App.cancelP2PFile(fileId);
}

async function runD() {
  const h = loadHarness();
  const { fileId, transfer, peer } = await createSendTransfer(h, { chunks: 10, fileId: 'qa-D' });
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => h.count('chunk-sent') === 4, 2000, 'D fill');
  injectAck(h, peer, fileId, 0);
  injectAck(h, peer, fileId, 0);
  injectAck(h, peer, fileId, 0);
  await waitUntil(() => h.count('chunk-sent', (n) => n.chunkIndex === 4) === 1, 2000, 'D slot fill');
  await sleep(40);
  const startCounts = uniqueCounts(h.notes.filter((n) => n.event === 'prepare-start').map((n) => n.chunkIndex));
  const dupPrep = [...startCounts.values()].some((c) => c > 1);
  record(
    'D duplicate ACK',
    h.count('chunk-sent', (n) => n.chunkIndex === 4) === 1 && h.count('chunk-ack-accepted') === 1 && h.count('chunk-ack-ignored', (n) => n.reason === 'duplicate-or-stale') >= 2 && maxInFlight(h) <= 4 && !dupPrep && transfer.nextChunkToSend === 5,
    `sent4=${h.count('chunk-sent', (n) => n.chunkIndex === 4)} acked=${h.count('chunk-ack-accepted')} next=${transfer.nextChunkToSend}`
  );
  h.App.cancelP2PFile(fileId);
}

async function runE() {
  const h = loadHarness();
  h.App._p2pFileQaHold = async (phase) => {
    if (phase === 'before-read') await sleep(25);
  };
  const { fileId, transfer, peer } = await createSendTransfer(h, { chunks: 8, fileId: 'qa-E' });
  const kick = h.App._p2pFileQa.sendNextChunk(fileId);
  const deadline = Date.now() + 3000;
  while (!transfer.completed && Date.now() < deadline) {
    [...(transfer.inFlightChunks || [])].forEach((idx) => injectAck(h, peer, fileId, idx));
    await sleep(5);
  }
  await kick.catch(() => {});
  const sent = sentIndexes(h);
  const counts = uniqueCounts(sent);
  const skipped = [];
  for (let i = 0; i < 8; i++) if (!counts.has(i)) skipped.push(i);
  const dups = [...counts.entries()].filter(([, c]) => c > 1);
  record(
    'E prep vs rapid ACK',
    transfer.completed && h.count('complete') === 1 && skipped.length === 0 && dups.length === 0 && maxInFlight(h) <= 4,
    `complete=${h.count('complete')} skipped=${skipped.join(',')} dups=${dups.map((x) => x[0]).join(',')} sent=${sent.join(',')}`
  );
}

async function runF() {
  const h = loadHarness();
  let holdOpen = true;
  h.App._p2pFileQaHold = async (phase, detail) => {
    if (holdOpen && phase === 'before-encrypt' && detail && detail.chunkIndex >= 10 && detail.generation === 0) {
      while (holdOpen) await sleep(15);
    }
  };
  const { fileId, transfer, peer } = await createSendTransfer(h, { chunks: 16, fileId: 'qa-F' });
  const kick = h.App._p2pFileQa.sendNextChunk(fileId);
  const untilPast7 = Date.now() + 3000;
  while (Date.now() < untilPast7 && transfer.nextChunkToSend <= 7) {
    [...(transfer.inFlightChunks || [])].forEach((idx) => injectAck(h, peer, fileId, idx));
    await sleep(8);
  }
  await waitUntil(() => transfer.nextChunkToSend > 7 && (transfer.preparingChunks.has(10) || h.count('prepare-start', (n) => n.chunkIndex === 10) >= 1), 2000, 'F cursor past 7 and preparing 10');
  const gen0 = transfer.sendGeneration;
  await h.App.handleFileResendRequest(peer, { type: 'file-resend-request', fileId, fromChunk: 7 });
  record(
    'F rewind generation',
    transfer.sendGeneration > gen0 && transfer.nextChunkToSend === 7 && transfer.lastAckedChunk === 6 && (transfer.preparingChunks.get(10) === undefined || transfer.preparingChunks.get(10) === transfer.sendGeneration),
    `gen=${transfer.sendGeneration} next=${transfer.nextChunkToSend} last=${transfer.lastAckedChunk} prep10gen=${transfer.preparingChunks.get(10)}`
  );
  holdOpen = false;
  await sleep(60);
  const stale = h.count('prepare-stale', (n) => n.chunkIndex === 10) + h.count('prepare-abandoned', (n) => n.chunkIndex === 10);
  const prepared10 = transfer.preparedChunks.get(10);
  record(
    'F stale prep dropped',
    stale >= 1 && (!prepared10 || prepared10.generation === transfer.sendGeneration),
    `stale=${stale} prepared10gen=${prepared10 ? prepared10.generation : 'none'}`
  );
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await drainAcks(h, peer, fileId, transfer, 4000);
  await kick.catch(() => {});
  record('F resend completes once', h.count('complete') === 1 && transfer.completed && transfer.ackedChunks.size === 16, `complete=${h.count('complete')} acked=${transfer.ackedChunks.size}`);
}

async function runG() {
  const h = loadHarness();
  const { fileId, transfer, channel } = await createSendTransfer(h, { chunks: 12, fileId: 'qa-G' });
  channel.bufferedAmount = 600 * 1024;
  const pump = h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => h.count('buffer-pause') >= 1 || h.count('prepare-ready') >= 1, 2000, 'G pause or prep');
  await sleep(40);
  const occ = transfer.preparedChunks.size + transfer.preparingChunks.size;
  record(
    'G buffer pause bounded',
    h.count('chunk-sent') === 0 && h.count('buffer-pause') >= 1 && occ <= 8,
    `sent=${h.count('chunk-sent')} pauses=${h.count('buffer-pause')} occ=${occ}`
  );
  channel.bufferedAmount = 0;
  await pump.catch(() => {});
  await waitUntil(() => h.count('chunk-sent') === 4, 2000, 'G resume');
  record('G buffer resume', h.count('chunk-sent') === 4 && maxInFlight(h) <= 4, `sent=${h.count('chunk-sent')}`);
  h.App.cancelP2PFile(fileId);
}

async function runH() {
  const h = loadHarness();
  const { fileId, transfer, peer } = await createSendTransfer(h, { chunks: 5, fileId: 'qa-H' });
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => h.count('chunk-sent') === 4);
  record('H no complete before acks', h.count('complete') === 0 && !transfer.completed, `complete=${h.count('complete')}`);
  injectAck(h, peer, fileId, 0);
  injectAck(h, peer, fileId, 1);
  injectAck(h, peer, fileId, 2);
  injectAck(h, peer, fileId, 3);
  await waitUntil(() => h.count('chunk-sent') === 5, 2000, 'H last send');
  injectAck(h, peer, fileId, 4);
  await waitUntil(() => h.count('complete') === 1, 2000, 'H complete');
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await h.App._p2pFileQa.completeSendOnce(fileId, transfer, null);
  injectAck(h, peer, fileId, 4);
  await sleep(40);
  const completeProg = h.progress.filter((p) => p.status === 'complete').length;
  record(
    'H completion once after all ACKs',
    h.count('complete') === 1 && completeProg === 1 && h.persisted.length === 1 && h.appended.length === 1 && h.count('transfer-complete-event') === 1,
    `complete=${h.count('complete')} prog=${completeProg}`
  );
}

async function runI() {
  const h = loadHarness();
  let holdOpen = true;
  h.App._p2pFileQaHold = async (phase) => {
    if (holdOpen && phase === 'before-read') {
      while (holdOpen) await sleep(15);
    }
  };
  const { fileId, transfer } = await createSendTransfer(h, { chunks: 6, fileId: 'qa-I' });
  const kick = h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => transfer.preparingChunks.size >= 1, 2000, 'I preparing');
  h.App.cancelP2PFile(fileId);
  holdOpen = false;
  await kick.catch(() => {});
  await sleep(50);
  record(
    'I cancel cleanup',
    !h.App.activeP2PTransfers.has(fileId) && transfer.preparingChunks.size === 0 && transfer.preparedChunks.size === 0 && transfer._ackTimeout == null && transfer._progressUiTimer == null,
    `active=${h.App.activeP2PTransfers.has(fileId)} preparing=${transfer.preparingChunks.size} prepared=${transfer.preparedChunks.size}`
  );

  const h2 = loadHarness();
  const { fileId: fileId2, transfer: t2, peer } = await createSendTransfer(h2, { chunks: 3, fileId: 'qa-I-complete' });
  await h2.App._p2pFileQa.sendNextChunk(fileId2);
  await drainAcks(h2, peer, fileId2, t2, 2000);
  record(
    'I complete cleanup',
    h2.count('complete') === 1 && !h2.App.activeP2PTransfers.has(fileId2) && t2.preparingChunks.size === 0 && t2.preparedChunks.size === 0,
    `complete=${h2.count('complete')} active=${h2.App.activeP2PTransfers.has(fileId2)}`
  );

  const h3 = loadHarness();
  const { keyStr } = await makeKeyPair(webcrypto.subtle);
  const fileId3 = 'qa-I-offer';
  const peer3 = 'cc'.repeat(32);
  let release;
  const gate = new Promise((r) => { release = r; });
  h3.App._p2pFileQaHold = async (phase) => {
    if (phase === 'before-import-key') await gate;
  };
  const offer = {
    type: 'file-offer',
    fileId: fileId3,
    name: 'g.bin',
    size: 128,
    mimeType: 'application/octet-stream',
    keyStr,
    totalChunks: 1,
    createdAt: Math.floor(Date.now() / 1000),
  };
  const p1 = h3.App.handleP2PFileOffer(peer3, offer);
  const p2 = h3.App.handleP2PFileOffer(peer3, offer);
  await sleep(30);
  release();
  await Promise.all([p1, p2]);
  const receiveCount = [...h3.App.activeP2PTransfers.values()].filter((t) => t.direction === 'receive' && t.fileId === fileId3).length;
  record('I simultaneous offers still single init', h3.count('offer-reserved') === 1 && receiveCount === 1, `reserved=${h3.count('offer-reserved')} after=${receiveCount}`);
  h3.App.cancelP2PFile(fileId3);

  record('I wire unchanged', SRC.includes("type: 'chunk-ack'") && SRC.includes("type: 'chunk-meta'") && SRC.includes('MAX_IN_FLIGHT = 4') && SRC.includes('MAX_PREPARE_CONCURRENCY = 4') && SRC.includes('PREFETCH_TARGET = 8') && SRC.includes("type: 'file-resend-request'"));
  record('I no Window=8', !SRC.includes('MAX_IN_FLIGHT = 8'));
}

async function main() {
  if (!SRC.includes('MAX_PREPARE_CONCURRENCY = 4') || !SRC.includes('preparedChunks') || !SRC.includes('pumpPrepare')) {
    record('source markers', false, 'prepare pipeline missing');
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
  await runI();

  results.forEach((line) => console.log(line));
  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount) process.exit(1);
  console.log('\nP2P file prepare-pipeline gate passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL harness', err);
  process.exit(1);
});
