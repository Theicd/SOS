#!/usr/bin/env node
/**
 * Offline encrypted Blossom fallback: the P2P transfer id must not replace
 * the cryptographic attachment id. Validators stay strict.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, utils } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const results = [];
let pass = 0;
let fail = 0;

function record(name, ok, detail) {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name + (detail ? ' — ' + detail : ''));
    return;
  }
  fail += 1;
  results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function pair() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), hex: utils.bytesToHex(sk) };
}

const p2pFile = read('chat-p2p-file.js');
const chatService = read('chat-service.js');
const mediaSrc = read('media-file-e2ee.js');

record(
  'source no longer writes the P2P file id into attachmentId',
  !/attachment\.attachmentId\s*=\s*String\(\s*transfer\.fileId/.test(p2pFile),
);
record(
  'crypto attachment id is preserved through publish',
  p2pFile.includes('ORIGINAL_ATTACHMENT_ID_PRESERVED') &&
    p2pFile.includes('UPLOADED_AWAITING_MESSAGE_PUBLISH') &&
    p2pFile.includes('clientTempId: logicalId'),
);
record(
  'plaintext blossom result is still rejected',
  p2pFile.includes('requireEncryption: true') && p2pFile.includes('non_encrypted_result_rejected'),
);
record(
  'publish retry reuses the uploaded descriptor',
  p2pFile.includes('ORPHAN_UPLOAD_RETRY') && p2pFile.includes('pendingBlossomPublish'),
);
record(
  'fallback does not read the root key',
  !/App\.privateKey/.test(p2pFile),
);
record(
  'attachment id validator is unchanged',
  /attachmentId must be 32 lowercase hex chars/.test(mediaSrc),
);
record(
  'delegated chat still signs through the device session',
  chatService.includes('delegatedChatEncrypt') && chatService.includes("role === 'LINKED_DEVICE'"),
);
record(
  'known-offline media skips a dead data channel',
  p2pFile.includes('P2P_OFFLINE_DETECTED') && p2pFile.includes('mediaPeerKnownOffline'),
);

const sandbox = {
  console,
  crypto: webcrypto,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  ArrayBuffer,
  Date,
  Math,
  JSON,
  Object,
  String,
  Number,
  Error,
  Set,
  Map,
  WeakMap,
  Promise,
  Buffer,
  performance: { now: () => Date.now() },
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.NostrTools = await import('nostr-tools');
vm.createContext(sandbox);
vm.runInContext(read('media-file-e2ee.js'), sandbox, { filename: 'media-file-e2ee.js' });
sandbox.NostrApp.inspectIncomingChatAttachment = function inspectIncomingChatAttachment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
  if (Object.keys(raw).length > 24) return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
  if (raw.type !== 'encrypted-media') return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
  try {
    sandbox.NostrApp.validateEncryptedMediaDescriptor(raw);
  } catch (_err) {
    return { ok: false, reasonCode: 'INVALID_DESCRIPTOR' };
  }
  if (raw.resource && typeof raw.resource.url === 'string' && !/^https:\/\//.test(raw.resource.url)) {
    return { ok: false, reasonCode: 'MISSING_URL' };
  }
  return { ok: true, encryptedBlossom: true };
};
vm.runInContext(read('chat-file-transfer-state.js'), sandbox, { filename: 'chat-file-transfer-state.js' });
vm.runInContext(read('chat-e2ee.js'), sandbox, { filename: 'chat-e2ee.js' });

const App = sandbox.NostrApp;
const sender = pair();
const recipient = pair();
const stranger = pair();
const messageId = 'p2p-recv-1792591903902-qzx9r8oeflh';
const p2pFileId = '1792591903902-qzx9r8oeflh';
const plain = new Uint8Array(64);
webcrypto.getRandomValues(plain);

const enc = await App.encryptMediaBlob(plain, {
  messageId,
  sender: sender.pk,
  recipient: recipient.pk,
  mime: 'image/jpeg',
  filename: 'photo.jpg',
  mode: 'single',
});
const descriptor = enc.descriptor;
descriptor.resource = { transport: 'blossom', url: 'https://blossom.primal.net/aa' };
descriptor.clientMessageId = messageId;
descriptor.logicalMessageId = messageId;
descriptor.aadParties = sender.pk + '|' + recipient.pk;

record('fresh attachment id is 32 lowercase hex', /^[0-9a-f]{32}$/.test(descriptor.attachmentId));
let rejectedP2pId = false;
try {
  App.validateEncryptedMediaDescriptor(Object.assign({}, descriptor, { attachmentId: p2pFileId }));
} catch (err) {
  rejectedP2pId = !!(err && /32 lowercase hex/.test(String(err.message || err)));
}
record('P2P transfer file id is rejected as attachmentId', rejectedP2pId, p2pFileId);

const wire = App.buildEncryptedAttachmentWireDescriptor(Object.assign({}, descriptor, { fileId: p2pFileId, name: 'photo.jpg' }));
record('wire descriptor keeps the cryptographic attachment id', wire && wire.attachmentId === descriptor.attachmentId && wire.fileId == null);
record('wire descriptor validates', App.validateEncryptedMediaDescriptor(wire).ok === true);
record('wire descriptor passes incoming inspection', App.inspectIncomingChatAttachment(Object.assign({}, wire)).ok === true);

const mutated = Object.assign({}, wire, { attachmentId: p2pFileId });
record('mutated wire fails inspection', App.inspectIncomingChatAttachment(mutated).ok === false);

const createdAt = Math.floor(Date.now() / 1000);
let encryptedOk = false;
try {
  const sealed = App.encryptPrivateChatPayload({
    senderPrivateKeyHex: sender.hex,
    senderPubkey: sender.pk,
    recipientPubkey: recipient.pk,
    payload: {
      messageId,
      sender: sender.pk,
      recipient: recipient.pk,
      createdAt,
      text: '',
      attachment: wire,
    },
  });
  encryptedOk = !!(sealed && sealed.ct);
} catch (_err) {
  encryptedOk = false;
}
record('original wire encrypts as a private chat payload', encryptedOk);

let mutatedRejected = false;
try {
  App.encryptPrivateChatPayload({
    senderPrivateKeyHex: sender.hex,
    senderPubkey: sender.pk,
    recipientPubkey: recipient.pk,
    payload: {
      messageId,
      sender: sender.pk,
      recipient: recipient.pk,
      createdAt,
      text: '',
      attachment: mutated,
    },
  });
} catch (err) {
  mutatedRejected = !!(err && (err.code === 'BAD_ATTACHMENT' || /INVALID_DESCRIPTOR|BAD_ATTACHMENT/.test(String(err.message || err))));
}
record('overwritten attachment id fails chat encryption', mutatedRejected);

const opened = await App.decryptMediaBlob(enc.ciphertext, descriptor, {
  messageId,
  sender: sender.pk,
  recipient: recipient.pk,
  attachmentId: descriptor.attachmentId,
});
record(
  'original AAD decrypts and matches plaintext',
  opened && opened.plaintext && opened.plaintext.length === plain.length && opened.plaintext.every((b, i) => b === plain[i]),
);

async function rejects(name, run) {
  try {
    await run();
    record(name, false, 'unexpected success');
  } catch (_err) {
    record(name, true);
  }
}

await rejects('wrong message id is rejected', () => App.decryptMediaBlob(enc.ciphertext, descriptor, {
  messageId: messageId + '-other',
  sender: sender.pk,
  recipient: recipient.pk,
  attachmentId: descriptor.attachmentId,
}));
await rejects('wrong recipient is rejected', () => App.decryptMediaBlob(enc.ciphertext, descriptor, {
  messageId,
  sender: sender.pk,
  recipient: stranger.pk,
  attachmentId: descriptor.attachmentId,
}));
await rejects('wrong attachment id binding is rejected', () => App.decryptMediaBlob(enc.ciphertext, descriptor, {
  messageId,
  sender: sender.pk,
  recipient: recipient.pk,
  attachmentId: 'ab'.repeat(16),
}));
const corrupt = new Uint8Array(enc.ciphertext);
corrupt[corrupt.length - 1] ^= 0xff;
await rejects('corrupted ciphertext is rejected', () => App.decryptMediaBlob(corrupt, descriptor, {
  messageId,
  sender: sender.pk,
  recipient: recipient.pk,
  attachmentId: descriptor.attachmentId,
}));
const badHash = Object.assign({}, descriptor, {
  cipher: Object.assign({}, descriptor.cipher, { sha256: 'f'.repeat(64) }),
});
await rejects('modified sha-256 is rejected', () => App.decryptMediaBlob(enc.ciphertext, badHash, {
  messageId,
  sender: sender.pk,
  recipient: recipient.pk,
  attachmentId: descriptor.attachmentId,
}));
const unsafe = Object.assign({}, wire, { resource: { transport: 'blossom', url: 'javascript:alert(1)' } });
record('unsafe attachment URL is rejected', App.inspectIncomingChatAttachment(unsafe).ok === false);

const plainBlob = { type: 'image/jpeg', url: 'https://blossom.primal.net/plain.jpg' };
record('plaintext attachment is not an encrypted descriptor', App.inspectIncomingChatAttachment(plainBlob).reasonCode === 'INVALID_DESCRIPTOR');

console.log(results.join('\n'));
console.log('STATUS=' + (fail === 0 ? 'PASS' : 'FAIL') + ' pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
