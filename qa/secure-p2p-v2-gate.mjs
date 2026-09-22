/**
 * Stage 5E — Secure P2P v2 structural + negative envelope tests (no live network).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const require = createRequire(pathToFileURL(path.join(ROOT, 'package.json')));

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

let pass = 0;
let fail = 0;
function record(name, ok) {
  if (ok) {
    pass += 1;
    console.log('PASS', name);
  } else {
    fail += 1;
    console.log('FAIL', name);
  }
}

const dc = read('chat-p2p-datachannel.js');
const fileJs = read('chat-p2p-file.js');
const svc = read('chat-service.js');
const sec = read('chat-p2p-secure-v2.js');

record('secure module defines secureP2pV2 capability', /secureP2pV2:\s*true/.test(sec));
record('secure module uses NIP-44 v2', /nip44\.v2/.test(sec) && /alg:\s*ALG/.test(sec) && /ALG\s*=\s*'nip44'/.test(sec));
record('DC send no plaintext chat-text for v2 path', !/send\(JSON\.stringify\(\{type:'chat-text'/.test(dc));
record('DC receive handles p2p-secure-text', /p2p-secure-text/.test(dc));
record('DC legacy inbound chat-text logged', /LEGACY_INBOUND_DTLS_ONLY/.test(dc));
record('mesh send requires peer v2', /isPeerSecureP2pV2\(p\)/.test(dc) && /MESH_SECURE/.test(dc));
record('mesh no plaintext signal object for v2', !/JSON\.stringify\(signal\)/.test(dc.split('async function sendMeshSig')[1] || ''));
record('file DC rejects plaintext keyStr offer', /legacy_plaintext_key_rejected/.test(fileJs));
record('file secure offer type wired', /p2p-secure-file-offer/.test(fileJs));
record('DC bridges p2p-secure-file-offer in CHAT_FILE_TYPES', /CHAT_FILE_TYPES\s*=\s*\[[^\]]*p2p-secure-file-offer/.test(dc));
record('chat-service awaits DC send', /await App\.dataChannel\.send/.test(svc));
record('chat-service waits capability', /waitForPeerCapability/.test(svc));
record('videos.html loads secure module before datachannel', (() => {
  const html = read('videos.html');
  const a = html.indexOf('chat-p2p-secure-v2.js');
  const b = html.indexOf('chat-p2p-datachannel.js');
  return a > 0 && b > 0 && a < b;
})());
record('chunk encrypt unchanged AES-GCM', /AES-GCM/.test(fileJs) && /encryptChunk/.test(fileJs));
record('control frames chunk-meta no keyStr', !/chunk-meta[\s\S]{0,120}keyStr/.test(fileJs));

// Negative decrypt tests with stub NostrTools in vm
const NT = require('nostr-tools');
const { generateSecretKey, getPublicKey, utils } = NT;
const bytesToHex =
  (utils && typeof utils.bytesToHex === 'function' && utils.bytesToHex) ||
  ((u8) => Buffer.from(u8).toString('hex'));
const aliceSk = generateSecretKey();
const bobSk = generateSecretKey();
const alicePk = getPublicKey(aliceSk);
const bobPk = getPublicKey(bobSk);
const aliceHex = bytesToHex(aliceSk);
const bobHex = bytesToHex(bobSk);

const ctx = {
  window: {},
  NostrApp: {},
  NostrTools: NT,
  console,
};
ctx.window = ctx;
ctx.window.NostrApp = ctx.NostrApp;
ctx.window.NostrTools = NT;
ctx.NostrApp.publicKey = alicePk;
ctx.NostrApp.privateKey = aliceHex;
ctx.NostrApp.guestMode = false;

vm.runInNewContext(sec, ctx, { filename: 'chat-p2p-secure-v2.js' });
const P2 = ctx.NostrApp.P2pSecureV2;
record('module exports P2pSecureV2', !!P2);

P2.setPeerCapability(bobPk, true);
record('peer capability v2', P2.isPeerSecureP2pV2(bobPk));

const msg = { id: 'm1', content: 'hello', attachment: null, createdAt: Math.floor(Date.now() / 1000) };
const wire = await P2.encryptChatTextForDc(bobPk, msg);
record('encrypt chat wire type', wire && wire.type === 'p2p-secure-text');

ctx.NostrApp.publicKey = bobPk;
ctx.NostrApp.privateKey = bobHex;
const dec = await P2.decryptChatTextFromDc(alicePk, wire);
record('decrypt chat roundtrip', dec && dec.content === 'hello');

let replayBlocked = false;
try {
  await P2.decryptChatTextFromDc(alicePk, wire);
} catch (e) {
  replayBlocked = e && e.code === 'REPLAY';
}
record('replay blocked on duplicate recv', replayBlocked);

ctx.NostrApp.publicKey = alicePk;
ctx.NostrApp.privateKey = aliceHex;
const badWire = JSON.parse(JSON.stringify(wire));
badWire.envelope.ct = badWire.envelope.ct.slice(0, -4) + 'ffff';
let tamperRejected = false;
try {
  ctx.NostrApp.publicKey = bobPk;
  ctx.NostrApp.privateKey = bobHex;
  await P2.decryptChatTextFromDc(alicePk, badWire);
} catch (e) {
  tamperRejected = true;
}
record('tampered ciphertext rejected', tamperRejected);

console.log('---');
console.log(`TOTAL ${pass + fail} PASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);
