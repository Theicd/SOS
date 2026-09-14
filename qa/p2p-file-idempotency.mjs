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
  };
  h.App.activeP2PTransfers.set(fileId, transfer);
  return { fileId, transfer, channel, peer, file };
}

function injectAck(h, peer, fileId, index) {
  h.App._p2pFileQa.handleIncomingMessage(peer, ackMsg(fileId, index), null);
}

async function runA() {
  const h = loadHarness();
  const { fileId, transfer, peer } = await createSendTransfer(h, { chunks: 3, fileId: 'qa-A' });
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => h.count('chunk-sent', (n) => n.chunkIndex === 0) === 1, 2000, 'A chunk0');
  injectAck(h, peer, fileId, 0);
  injectAck(h, peer, fileId, 0);
  injectAck(h, peer, fileId, 0);
  await waitUntil(() => h.count('chunk-sent', (n) => n.chunkIndex === 1) === 1, 2000, 'A chunk1');
  await sleep(40);
  record('A duplicate ACK', h.count('chunk-sent', (n) => n.chunkIndex === 1) === 1 && transfer.currentChunk === 2 && h.count('chunk-ack-accepted') === 1, `sent1=${h.count('chunk-sent', (n) => n.chunkIndex === 1)} cur=${transfer.currentChunk} acked=${h.count('chunk-ack-accepted')}`);
  h.App.cancelP2PFile(fileId);
}

async function runB() {
  const h = loadHarness();
  const { fileId, transfer, peer } = await createSendTransfer(h, { chunks: 4, fileId: 'qa-B' });
  let release;
  const gate = new Promise((r) => { release = r; });
  h.App._p2pFileQaHold = async (phase, detail) => {
    if (phase === 'before-encrypt' && detail && detail.chunkIndex === 1) {
      await gate;
    }
  };
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => h.count('chunk-sent', (n) => n.chunkIndex === 0) === 1, 2000, 'B chunk0');
  injectAck(h, peer, fileId, 0);
  await waitUntil(() => transfer._sendInFlight === true, 2000, 'B in-flight');
  injectAck(h, peer, fileId, 0);
  injectAck(h, peer, fileId, 0);
  record('B no skip during in-flight', transfer.currentChunk === 1 && h.count('chunk-sent', (n) => n.chunkIndex === 1) === 0, `cur=${transfer.currentChunk} sent1=${h.count('chunk-sent', (n) => n.chunkIndex === 1)}`);
  release();
  await waitUntil(() => h.count('chunk-sent', (n) => n.chunkIndex === 1) === 1, 2000, 'B chunk1 after release');
  await sleep(30);
  record('B single concurrent send', h.count('chunk-sent', (n) => n.chunkIndex === 1) === 1 && transfer.currentChunk === 2 && h.count('chunk-sent', (n) => n.chunkIndex === 2) === 0, `sent1=${h.count('chunk-sent', (n) => n.chunkIndex === 1)} cur=${transfer.currentChunk}`);
  h.App.cancelP2PFile(fileId);
}

async function runC() {
  const h = loadHarness();
  const { fileId, transfer, peer } = await createSendTransfer(h, { chunks: 5, fileId: 'qa-C' });
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => h.count('chunk-sent', (n) => n.chunkIndex === 0) === 1);
  injectAck(h, peer, fileId, 0);
  await waitUntil(() => h.count('chunk-sent', (n) => n.chunkIndex === 1) === 1);
  injectAck(h, peer, fileId, 1);
  await waitUntil(() => h.count('chunk-sent', (n) => n.chunkIndex === 2) === 1);
  injectAck(h, peer, fileId, 2);
  await waitUntil(() => h.count('chunk-sent', (n) => n.chunkIndex === 3) === 1 && transfer.lastAckedChunk === 2);
  const before = { cur: transfer.currentChunk, last: transfer.lastAckedChunk, sent: h.count('chunk-sent') };
  injectAck(h, peer, fileId, 1);
  await sleep(40);
  record('C stale ACK', transfer.currentChunk === before.cur && transfer.lastAckedChunk === before.last && h.count('chunk-sent') === before.sent && h.count('chunk-ack-ignored', (n) => n.reason === 'duplicate-or-stale') >= 1, `cur=${transfer.currentChunk} last=${transfer.lastAckedChunk}`);
  h.App.cancelP2PFile(fileId);
}

async function runD() {
  const h = loadHarness();
  const { fileId, transfer, peer } = await createSendTransfer(h, { chunks: 6, fileId: 'qa-D' });
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => h.count('chunk-sent', (n) => n.chunkIndex === 0) === 1);
  injectAck(h, peer, fileId, 0);
  await waitUntil(() => h.count('chunk-sent', (n) => n.chunkIndex === 1) === 1);
  injectAck(h, peer, fileId, 1);
  await waitUntil(() => h.count('chunk-sent', (n) => n.chunkIndex === 2) === 1);
  const before = { cur: transfer.currentChunk, last: transfer.lastAckedChunk, sent: h.count('chunk-sent') };
  injectAck(h, peer, fileId, 5);
  await sleep(40);
  record('D future ACK', transfer.currentChunk === before.cur && transfer.lastAckedChunk === before.last && h.count('chunk-sent') === before.sent, `cur=${transfer.currentChunk} last=${transfer.lastAckedChunk}`);
  injectAck(h, peer, fileId, 2);
  await waitUntil(() => h.count('chunk-sent', (n) => n.chunkIndex === 3) === 1);
  record('D expected ACK still works', transfer.currentChunk === 4 && transfer.lastAckedChunk === 2);
  h.App.cancelP2PFile(fileId);
}

async function runE() {
  const h = loadHarness();
  const { fileId, transfer, peer } = await createSendTransfer(h, { chunks: 8, fileId: 'qa-E' });
  await h.App._p2pFileQa.sendNextChunk(fileId);
  for (let i = 0; i < 5; i++) {
    await waitUntil(() => h.count('chunk-sent', (n) => n.chunkIndex === i) === 1, 2000, 'E send ' + i);
    injectAck(h, peer, fileId, i);
  }
  await waitUntil(() => transfer.currentChunk === 5, 2000, 'E at chunk 5');
  await h.App.handleFileResendRequest(peer, { type: 'file-resend-request', fileId, fromChunk: 2 });
  record('E rewind', transfer.lastAckedChunk === 1 && transfer.currentChunk >= 2 && transfer.currentChunk <= 3, `last=${transfer.lastAckedChunk} cur=${transfer.currentChunk}`);
  for (let i = 2; i < 7; i++) {
    await waitUntil(() => transfer.currentChunk === i + 1 && transfer.lastAckedChunk === i - 1, 2000, 'E sent ' + i);
    injectAck(h, peer, fileId, i);
  }
  await waitUntil(() => h.count('complete') === 1, 2000, 'E complete');
  await sleep(40);
  record('E resend then complete once', h.count('complete') === 1 && h.progress.filter((p) => p.status === 'complete').length === 1, `complete=${h.count('complete')} prog=${h.progress.filter((p) => p.status === 'complete').length}`);
}

async function runF() {
  const h = loadHarness();
  const { fileId, transfer, peer } = await createSendTransfer(h, { chunks: 1, fileId: 'qa-F' });
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await waitUntil(() => h.count('complete') === 1, 2000, 'F first complete');
  await h.App._p2pFileQa.sendNextChunk(fileId);
  await h.App._p2pFileQa.completeSendOnce(fileId, transfer, null);
  injectAck(h, peer, fileId, 0);
  await sleep(40);
  const completeProg = h.progress.filter((p) => p.status === 'complete').length;
  record('F completion once', h.count('complete') === 1 && completeProg === 1 && h.persisted.length === 1 && h.appended.length === 1 && h.count('resend-cache') === 1 && h.count('transfer-complete-event') === 1, `complete=${h.count('complete')} prog=${completeProg} persist=${h.persisted.length} append=${h.appended.length} cache=${h.count('resend-cache')} ev=${h.count('transfer-complete-event')}`);
}

async function runG() {
  const h = loadHarness();
  const { keyStr } = await makeKeyPair(webcrypto.subtle);
  const fileId = 'qa-G';
  const peer = 'cc'.repeat(32);
  let release;
  const gate = new Promise((r) => { release = r; });
  h.App._p2pFileQaHold = async (phase) => {
    if (phase === 'before-import-key') await gate;
  };
  const offer = {
    type: 'file-offer',
    fileId,
    name: 'g.bin',
    size: 128,
    mimeType: 'application/octet-stream',
    keyStr,
    totalChunks: 1,
    createdAt: Math.floor(Date.now() / 1000),
  };
  const p1 = h.App.handleP2PFileOffer(peer, offer);
  const p2 = h.App.handleP2PFileOffer(peer, offer);
  await sleep(30);
  const reservedDuringHold = h.count('offer-reserved');
  const activeDuringHold = [...h.App.activeP2PTransfers.values()].filter((t) => t.fileId === fileId).length;
  release();
  await Promise.all([p1, p2]);
  const receiveCount = [...h.App.activeP2PTransfers.values()].filter((t) => t.direction === 'receive' && t.fileId === fileId).length;
  record('G simultaneous offers', reservedDuringHold === 1 && activeDuringHold === 1 && receiveCount === 1 && h.count('offer-ignored-existing') >= 1, `reserved=${reservedDuringHold} during=${activeDuringHold} after=${receiveCount}`);
  h.App.cancelP2PFile(fileId);
}

async function runH() {
  const h = loadHarness();
  const peer = 'dd'.repeat(32);

  const fresh = createOpenChannel('file-transfer');
  h.App._p2pFileQa.attachCanonicalFileHandler(peer, fresh);
  h.App._p2pFileQa.attachCanonicalFileHandler(peer, fresh);
  fresh.dispatch(JSON.stringify({ type: 'chunk-ack', fileId: 'none', index: 0 }));
  record('H attach once', fresh.listenerCount === 1 && h.count('incoming-message') === 1 && h.count('handler-attached') === 1 && h.count('handler-skip-already-attached') >= 1, `listeners=${fresh.listenerCount} incoming=${h.count('incoming-message')}`);

  const notesBefore = h.notes.length;
  const chatDc = createOpenChannel('sos-chat');
  chatDc.onmessage = (ev) => h.App.handleP2PFileMessage(peer, ev.data, chatDc);
  h.App._p2pFileQa.attachCanonicalFileHandler(peer, chatDc);
  chatDc.dispatch(JSON.stringify({ type: 'chunk-ack', fileId: 'none2', index: 0 }));
  const incomingAfterChat = h.notes.slice(notesBefore).filter((n) => n.event === 'incoming-message').length;
  record('H chat-dc not double', chatDc.listenerCount === 0 && chatDc._p2pFileHandler === 'chat-dc-bridged' && incomingAfterChat === 1, `listeners=${chatDc.listenerCount} incoming=${incomingAfterChat} flag=${chatDc._p2pFileHandler}`);

  const bridged = createOpenChannel('file-transfer');
  bridged.onmessage = (ev) => h.App.handleP2PFileMessage(peer, ev.data, bridged);
  h.App._p2pFileQa.attachCanonicalFileHandler(peer, bridged);
  const beforeBridge = h.notes.filter((n) => n.event === 'incoming-message').length;
  bridged.dispatch(JSON.stringify({ type: 'chunk-ack', fileId: 'none3', index: 0 }));
  const afterBridge = h.notes.filter((n) => n.event === 'incoming-message').length;
  record('H onmessage-bridged once', bridged.listenerCount === 0 && bridged._p2pFileHandler === 'onmessage-bridged' && afterBridge - beforeBridge === 1, `listeners=${bridged.listenerCount} delta=${afterBridge - beforeBridge}`);
}

async function main() {
  if (!SRC.includes('lastAckedChunk') || !SRC.includes('attachCanonicalFileHandler') || !SRC.includes('_sendInFlight')) {
    record('source markers', false, 'idempotency helpers missing');
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
  console.log('\nP2P file idempotency gate passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL harness', err);
  process.exit(1);
});
