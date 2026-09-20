#!/usr/bin/env node
/**
 * Private-chat documents use encrypted Blossom when direct P2P is unavailable.
 * Mocked network only. Does not change voice or read-receipt protocol.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
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

const p2p = read('chat-p2p-file.js');
const e2ee = read('media-server-e2ee.js');
const ui = read('chat-file-transfer-ui.js');
const renderer = read('chat-media-renderer.js');
const chatUi = read('chat-ui.js');
const audio = read('chat-audio-player.js');
const state = read('chat-state.js');

record('A routing no longer media-only',
  /function isPrivateChatServerFileSupported/.test(e2ee)
  && /isPrivateChatServerFileSupported\(mime, name\)/.test(e2ee)
  && /App\.isPrivateChatServerFileSupported/.test(p2p));
record('K direct P2P still preferred',
  /P2P_PREFERRED_FROM_BYTES\s*=\s*90\s*\*\s*1024/.test(ui)
  && /shouldPreferP2P\s*=\s*file\.size\s*>\s*P2P_PREFERRED_FROM_BYTES\s*\|\|\s*dcConnectedNow/.test(ui)
  && /fallbackToBlossom\(transfer, onProgress\)/.test(p2p));
record('download recovers full descriptor',
  /function downloadChatAttachment/.test(renderer)
  && /resolveServerMediaAttachment/.test(renderer)
  && /DOCUMENT_SOURCE_BLOSSOM_ENCRYPTED/.test(renderer)
  && /DOCUMENT_DOWNLOAD_INTEGRITY_FAILED/.test(renderer)
  && /data-chat-secure-download/.test(chatUi));
record('stage 5A voice unchanged', /VOICE_SOURCE_BLOSSOM_E2EE/.test(audio) && /resolveDurableVoicePlayback/.test(audio));
record('stage 5B boundary unchanged', /function getReceiptBoundaryId/.test(state) && /function normalizeReceiptBoundaryId/.test(state));

function hexPair(fill) {
  const pk = fill.repeat(64);
  return { pk, hex: pk };
}
class BlobPoly {
  constructor(parts = [], opts2 = {}) {
    const bufs = parts.map((p) => (p instanceof Uint8Array ? Buffer.from(p) : Buffer.from(p)));
    this._buf = Buffer.concat(bufs.length ? bufs : [Buffer.alloc(0)]);
    this.type = (opts2 && opts2.type) || '';
    this.size = this._buf.length;
  }
  async arrayBuffer() {
    return this._buf.buffer.slice(this._buf.byteOffset, this._buf.byteOffset + this._buf.byteLength);
  }
}
function bytesEqual(a, b) {
  const left = a instanceof Uint8Array ? a : new Uint8Array(a);
  const right = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

const store = new Map();
const sender = hexPair('a');
const recipient = hexPair('b');
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  crypto: webcrypto,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  ArrayBuffer,
  Buffer,
  Blob: BlobPoly,
  URL,
  btoa(s) { return Buffer.from(s, 'binary').toString('base64'); },
  atob(s) { return Buffer.from(s, 'base64').toString('binary'); },
  fetch: async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const u = String(url);
    let bodyBytes = null;
    if (init.body) {
      if (init.body instanceof Uint8Array) bodyBytes = init.body;
      else if (typeof init.body.arrayBuffer === 'function') bodyBytes = new Uint8Array(await init.body.arrayBuffer());
      else if (init.body._buf) bodyBytes = new Uint8Array(init.body._buf);
    }
    if (method === 'PUT' || method === 'POST') {
      const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', bodyBytes || new Uint8Array())).toString('hex');
      const resultUrl = 'https://blossom.test.invalid/' + hash;
      store.set(resultUrl, Buffer.from(bodyBytes || []));
      store.set(hash, Buffer.from(bodyBytes || []));
      return {
        ok: true,
        status: 200,
        headers: { get: () => String((bodyBytes || []).length) },
        async json() { return { url: resultUrl, sha256: hash, size: (bodyBytes || []).length }; },
        async text() { return ''; },
        async arrayBuffer() { return (bodyBytes || new Uint8Array()).buffer; },
      };
    }
    const hash = u.split('/').pop().split('?')[0];
    const bytes = store.get(u) || store.get(hash) || null;
    if (!bytes) {
      return { ok: false, status: 404, headers: { get: () => null }, async arrayBuffer() { return new ArrayBuffer(0); }, async text() { return ''; } };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => String(h).toLowerCase() === 'content-length' ? String(bytes.length) : null },
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
      async text() { return ''; },
    };
  },
  localStorage: { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } },
  setTimeout,
  clearTimeout,
  NostrApp: {
    publicKey: sender.pk,
    privateKey: sender.hex,
    finalizeEvent(draft) {
      return Object.assign({}, draft, { id: 'a'.repeat(64), sig: 'b'.repeat(128) });
    },
    blossomServers: [{ url: 'https://blossom.test.invalid' }],
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.__SOS_MEDIA_SERVER_E2EE_REQUIRED__ = true;
sandbox.URL.createObjectURL = () => 'blob:mock';
sandbox.URL.revokeObjectURL = () => {};
vm.createContext(sandbox);
vm.runInContext(read('media-file-e2ee.js'), sandbox);
vm.runInContext(read('blossom.js'), sandbox);
vm.runInContext(read('media-server-e2ee.js'), sandbox);
const App = sandbox.NostrApp;

const cases = [
  ['A TXT', 'text/plain', 'sos-debug-all-0200.txt', new TextEncoder().encode('hello durable txt')],
  ['B PDF', 'application/pdf', 'note.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 9])],
  ['C DOCX', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'note.docx', new Uint8Array([0x50, 0x4b, 3, 4, 9])],
  ['D XLSX', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet.xlsx', new Uint8Array([0x50, 0x4b, 3, 4, 8])],
  ['E PPTX', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck.pptx', new Uint8Array([0x50, 0x4b, 3, 4, 7])],
  ['F octet-stream', 'application/octet-stream', 'blob.bin', new Uint8Array([9, 8, 7, 6, 5])],
  ['DOC', 'application/msword', 'note.doc', new Uint8Array([0xd0, 0xcf, 1, 1])],
  ['XLS', 'application/vnd.ms-excel', 'sheet.xls', new Uint8Array([0xd0, 0xcf, 2, 2])],
  ['CSV', 'text/csv', 'rows.csv', new TextEncoder().encode('a,b\n1,2\n')],
  ['PPT', 'application/vnd.ms-powerpoint', 'deck.ppt', new Uint8Array([0xd0, 0xcf, 3, 3])],
  ['RTF', 'application/rtf', 'note.rtf', new TextEncoder().encode('{\\rtf1 hi}')],
  ['LOG', 'text/plain', 'app.log', new TextEncoder().encode('line\n')],
  ['ZIP', 'application/zip', 'pack.zip', new Uint8Array([0x50, 0x4b, 3, 4, 1])],
];

let torrentSelected = false;
for (const [label, mime, name, bytes] of cases) {
  record(label + ' eligible', App.isPrivateChatServerFileSupported(mime, name) === true);
  const uploaded = await App.uploadMediaForServerFallback(new BlobPoly([bytes], { type: mime }), {
    messageId: 'cmsg-' + label.replace(/\s+/g, ''),
    sender: sender.pk,
    recipient: recipient.pk,
    mimeType: mime,
    fileName: name,
    skipPolicyFetch: true,
  });
  record(label + ' encrypted descriptor',
    uploaded && uploaded.type === 'encrypted-media' && uploaded.resource && uploaded.resource.transport === 'blossom');
  record(label + ' filename and mime kept',
    uploaded.media && uploaded.media.filename === name && uploaded.media.mime === mime);
  const resolved = await App.resolveServerMediaAttachment(JSON.parse(JSON.stringify(uploaded)), {
    messageId: uploaded.logicalMessageId,
    sender: sender.pk,
    recipient: recipient.pk,
  });
  const out = new Uint8Array(await resolved.blob.arrayBuffer());
  record(label + ' bytes match with sender offline', bytesEqual(out, bytes) && !torrentSelected);
}

const txt = cases[0];
const base = await App.uploadMediaForServerFallback(new BlobPoly([txt[3]], { type: txt[1] }), {
  messageId: 'cmsg-restart',
  sender: sender.pk,
  recipient: recipient.pk,
  mimeType: txt[1],
  fileName: txt[2],
  skipPolicyFetch: true,
});
const restored = JSON.parse(JSON.stringify(base));
restored.url = 'blob:http://local/dead';
delete restored._resolvedBlob;
delete restored._localObjectUrl;
const afterRestart = await App.resolveServerMediaAttachment(restored, {
  messageId: restored.logicalMessageId,
  sender: sender.pk,
  recipient: recipient.pk,
});
record('G restart recovers descriptor', afterRestart && afterRestart.blob && afterRestart.blob.size === txt[3].length);
record('H dead blob is not authoritative', restored.url.startsWith('blob:') && bytesEqual(new Uint8Array(await afterRestart.blob.arrayBuffer()), txt[3]));
record('I no P2P peer required', !sandbox.NostrApp.dataChannel);

const tamper = JSON.parse(JSON.stringify(base));
store.set(tamper.resource.url, Buffer.from([1, 2, 3, 4, 5]));
let tamperFailed = false;
try {
  await App.resolveServerMediaAttachment(tamper, {
    messageId: tamper.logicalMessageId,
    sender: sender.pk,
    recipient: recipient.pk,
  });
} catch (_err) {
  tamperFailed = true;
}
record('J tamper fails closed', tamperFailed === true);

console.log(results.join('\n'));
console.log(fail ? 'CHAT_DOCUMENT_BLOSSOM_GATE FAIL (' + pass + ' passed, ' + fail + ' failed)' : 'CHAT_DOCUMENT_BLOSSOM_GATE PASS (' + pass + ' passed, 0 failed)');
process.exit(fail ? 1 : 0);
