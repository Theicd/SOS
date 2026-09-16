#!/usr/bin/env node
/**
 * E1 — Web E2EE crypto foundation gate (isolated NIP-44 envelope).
 * Does NOT activate live 1050 send/receive.
 * Run: node qa/e2ee-foundation-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  generateSecretKey,
  getPublicKey,
  utils,
  nip44,
  verifyEvent,
  finalizeEvent,
} from 'nostr-tools';

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

function loadE2eeWithAttachmentInspector() {
  const App = {
    chatState: { contacts: new Map() },
    _chatServiceBootstrapped: true,
    publicKey: '',
    privateKey: '',
    relayUrls: ['wss://example.invalid'],
    pool: {
      subscribeMany() {
        return { close() {} };
      },
      publish() {
        return [];
      },
    },
    contacts: new Map(),
    conversations: new Map(),
    ensureChatContact() {},
    fetchProfile: async () => ({ name: 'Peer', picture: '' }),
    appendChatMessage() {},
    removeChatMessage() {},
    getChatMessages() {
      return [];
    },
    updateChatMessageStatus() {},
    getChatLastSyncTs() {
      return 0;
    },
    setChatLastSyncTs() {},
    triggerChatMessagePush() {},
    deserializeChatMessageContent(rawContent) {
      return { displayText: String(rawContent || ''), attachment: null, hasAttachment: false };
    },
    torrentTransfer: { handleIncomingRequest() {} },
    dataChannel: { isConnected() { return false; }, connect() {} },
    getChatRetentionCutoffTs(nowSec) {
      return nowSec - 90 * 24 * 60 * 60;
    },
  };

  const localStorage = {
    _data: Object.create(null),
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null;
    },
    setItem(k, v) {
      this._data[k] = String(v);
    },
    removeItem(k) {
      delete this._data[k];
    },
    key(i) {
      return Object.keys(this._data)[i] || null;
    },
    get length() {
      return Object.keys(this._data).length;
    },
  };

  const context = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    btoa(value) {
      return Buffer.from(String(value), 'utf8').toString('base64');
    },
    atob(value) {
      return Buffer.from(String(value), 'base64').toString('utf8');
    },
    URL,
    URLSearchParams,
    localStorage,
    navigator: { onLine: true },
    document: {
      readyState: 'complete',
      addEventListener() {},
      hidden: false,
    },
  };
  context.window = context;
  context.NostrApp = App;
  context.NostrTools = {
    verifyEvent,
    finalizeEvent,
    generateSecretKey,
    getPublicKey,
    utils,
    nip44,
  };
  context.window.NostrApp = App;
  context.window.NostrTools = context.NostrTools;
  context.window.localStorage = localStorage;

  vm.createContext(context);
  vm.runInContext(read('chat-service.js'), context, { filename: 'chat-service.js' });
  if (typeof App.inspectIncomingChatAttachment !== 'function') {
    throw new Error('inspectIncomingChatAttachment missing after chat-service load');
  }

  // Load E2EE in the current Node realm so noble/nip44 accept Uint8Array keys.
  const hostApp = {
    inspectIncomingChatAttachment: App.inspectIncomingChatAttachment.bind(App),
    verifyIncomingChatAttachment: App.verifyIncomingChatAttachment.bind(App),
    hexToBytes: utils.hexToBytes,
  };
  globalThis.NostrApp = hostApp;
  globalThis.NostrTools = {
    verifyEvent,
    finalizeEvent,
    generateSecretKey,
    getPublicKey,
    utils,
    nip44,
  };
  vm.runInThisContext(read('chat-e2ee.js'), { filename: 'chat-e2ee.js' });
  if (typeof hostApp.encryptPrivateChatPayload !== 'function') {
    throw new Error('encryptPrivateChatPayload missing after chat-e2ee load');
  }
  return { App: hostApp, api: globalThis.SosChatE2ee };
}

const { App, api } = loadE2eeWithAttachmentInspector();

function skHex(sk) {
  return utils.bytesToHex(sk);
}

function makePair() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), hex: skHex(sk) };
}

const alice = makePair();
const bob = makePair();
const now = Math.floor(Date.now() / 1000);

function basePayload(overrides = {}) {
  return {
    v: 1,
    type: 'private-chat',
    messageId: 'client-msg-' + Math.random().toString(16).slice(2),
    sender: alice.pk,
    recipient: bob.pk,
    createdAt: now,
    text: 'Hello test',
    attachment: null,
    ...overrides,
  };
}

function encryptAliceToBob(payloadOverrides = {}) {
  const payload = basePayload(payloadOverrides);
  return {
    payload,
    envelope: App.encryptPrivateChatPayload({
      senderPrivateKeyHex: alice.hex,
      senderPubkey: alice.pk,
      recipientPubkey: bob.pk,
      payload,
    }),
  };
}

function decryptAsBob(envelope, authorPk = alice.pk) {
  return App.decryptPrivateChatPayload({
    localPrivateKeyHex: bob.hex,
    localPubkey: bob.pk,
    eventAuthorPubkey: authorPk,
    encryptedEnvelope: envelope,
  });
}

function decryptAsAlice(envelope, authorPk = bob.pk) {
  return App.decryptPrivateChatPayload({
    localPrivateKeyHex: alice.hex,
    localPubkey: alice.pk,
    eventAuthorPubkey: authorPk,
    encryptedEnvelope: envelope,
  });
}

function expectFail(name, fn, expectedCode) {
  try {
    const result = fn();
    record(name, false, 'expected failure but got ' + JSON.stringify(result && result.ct ? { family: result.family } : result));
  } catch (err) {
    const codeOk = !expectedCode || err.code === expectedCode;
    record(name, codeOk, codeOk ? '' : 'code=' + err.code + ' expected=' + expectedCode);
  }
}

// --- Live path static assertions ---
const chatServiceSrc = read('chat-service.js');
const fileTransferSrc = read('chat-file-transfer-service.js');
const videosHtml = read('videos.html');
const indexHtml = read('index.html');
const storageHtml = read('storage.html');
const e2eeSrc = read('chat-e2ee.js');

record(
  'live_path_encrypt_gated_by_isE2eeSendRequired',
  chatServiceSrc.includes('isE2eeSendRequired') && chatServiceSrc.includes('encryptPrivateChatPayload'),
);
record(
  'live_path_no_encrypt_in_chat-file-transfer-service',
  !fileTransferSrc.includes('encryptPrivateChatPayload') && !fileTransferSrc.includes('sos-e2ee'),
);
record(
  'LIVE_E2EE_SEND=false (activation ABSENT in app-version)',
  JSON.parse(read('app-version.json')).e2eeSendRequired === false,
);
// E2 may load chat-e2ee.js for receive-only dual-read.
record(
  'videos.html does not load chat-e2ee-wrapper.js',
  !videosHtml.includes('chat-e2ee-wrapper.js'),
);
record('index.html does not load chat-e2ee-wrapper.js', !indexHtml.includes('chat-e2ee-wrapper.js'));
record('storage.html does not load chat-e2ee-wrapper.js', !storageHtml.includes('chat-e2ee-wrapper.js'));
record(
  'E2EE encrypt engine present; send gated',
  e2eeSrc.includes('E2EE_FAMILY') && chatServiceSrc.includes('isE2eeSendRequired'),
);
record('chat-e2ee documents CLIENT_MESSAGE_ID != OUTER_NOSTR_EVENT_ID', e2eeSrc.includes('CLIENT_MESSAGE_ID != OUTER_NOSTR_EVENT_ID'));
record('chat-e2ee documents no Signal-style PFS', e2eeSrc.includes('does NOT provide Signal-style'));

// --- Round trips ---
try {
  const { payload, envelope } = encryptAliceToBob({ text: 'Hello test' });
  const out = decryptAsBob(envelope);
  record(
    'Alice→Bob',
    out.text === payload.text && out.sender === alice.pk && out.recipient === bob.pk && out.messageId === payload.messageId,
  );
} catch (err) {
  record('Alice→Bob', false, err.message);
}

try {
  const payload = basePayload({
    sender: bob.pk,
    recipient: alice.pk,
    text: 'Bob replies',
    messageId: 'bob-1',
  });
  const envelope = App.encryptPrivateChatPayload({
    senderPrivateKeyHex: bob.hex,
    senderPubkey: bob.pk,
    recipientPubkey: alice.pk,
    payload,
  });
  const out = decryptAsAlice(envelope);
  record('Bob→Alice', out.text === 'Bob replies' && out.sender === bob.pk);
} catch (err) {
  record('Bob→Alice', false, err.message);
}

const unicodeCases = [
  ['Unicode Hebrew', 'שלום, מה נשמע?'],
  ['Unicode English', 'Hello test'],
  ['Unicode emoji', 'ok 🙂🚀'],
  ['Unicode multiline', 'line1\nline2\nline3'],
  ['Unicode quotes', 'he said "hi" and \'bye\''],
  ['Unicode HTML-looking', '<script>alert(1)</script>'],
];
for (const [name, text] of unicodeCases) {
  try {
    const { envelope } = encryptAliceToBob({ text, messageId: 'u-' + name });
    const out = decryptAsBob(envelope);
    record(name, out.text === text);
  } catch (err) {
    record(name, false, err.message);
  }
}

// Empty text + attachment
try {
  const att = {
    name: 'photo.jpg',
    type: 'image/jpeg',
    size: 12345,
    url: 'https://cdn.example.com/a.jpg',
  };
  const { envelope } = encryptAliceToBob({ text: '', attachment: att, messageId: 'att-empty-text' });
  const out = decryptAsBob(envelope);
  record(
    'empty text + image attachment',
    out.text === '' && out.attachment && out.attachment.type === 'image/jpeg' && out.attachment.url === att.url,
  );
} catch (err) {
  record('empty text + image attachment', false, err.message);
}

try {
  const att = {
    name: 'voice.webm',
    type: 'audio/webm; codecs=opus',
    size: 8000,
    duration: 3.5,
    url: 'https://cdn.example.com/v.webm',
  };
  const { envelope } = encryptAliceToBob({ text: '', attachment: att, messageId: 'voice-1' });
  const out = decryptAsBob(envelope);
  // Stage 15 normalizes MIME to essence
  record(
    'Voice MIME codecs=opus',
    out.attachment &&
      (out.attachment.type === 'audio/webm' || out.attachment.type === 'audio/webm; codecs=opus') &&
      out.attachment.duration === 3.5,
  );
} catch (err) {
  record('Voice MIME codecs=opus', false, err.message);
}

try {
  const att = {
    name: 'doc.pdf',
    type: 'application/pdf',
    size: 999,
    url: 'https://cdn.example.com/doc.pdf',
  };
  const { envelope } = encryptAliceToBob({ text: 'file', attachment: att, messageId: 'pdf-1' });
  const out = decryptAsBob(envelope);
  record('generic file metadata', out.attachment && out.attachment.type === 'application/pdf');
} catch (err) {
  record('generic file metadata', false, err.message);
}

// --- Crypto failures ---
{
  const { envelope } = encryptAliceToBob({ text: 'secret', messageId: 'neg-1' });
  expectFail('wrong recipient private key', () => {
    return App.decryptPrivateChatPayload({
      localPrivateKeyHex: alice.hex,
      localPubkey: bob.pk,
      eventAuthorPubkey: alice.pk,
      encryptedEnvelope: envelope,
    });
  }, 'DECRYPT_FAILURE');

  expectFail('wrong sender context', () => {
    return decryptAsBob(envelope, bob.pk);
  }, 'DECRYPT_FAILURE');

  const tampered = { ...envelope, ct: envelope.ct.slice(0, -2) + (envelope.ct.endsWith('A') ? 'B' : 'A') };
  expectFail('tamper ciphertext', () => decryptAsBob(tampered), 'DECRYPT_FAILURE');

  const truncated = { ...envelope, ct: envelope.ct.slice(0, 40) };
  expectFail('truncated ciphertext', () => decryptAsBob(truncated), 'DECRYPT_FAILURE');

  expectFail('invalid ciphertext', () => decryptAsBob({ ...envelope, ct: '%%%not-base64%%%' }), 'DECRYPT_FAILURE');

  expectFail('unknown family', () => decryptAsBob({ ...envelope, family: 'other' }), 'UNKNOWN_FAMILY');
  expectFail('unknown version', () => decryptAsBob({ ...envelope, v: 99 }), 'UNKNOWN_VERSION');
  expectFail('unsupported algorithm', () => decryptAsBob({ ...envelope, alg: 'nip04' }), 'UNSUPPORTED_ALGORITHM');
  expectFail('missing ciphertext', () => decryptAsBob({ family: 'sos-e2ee', v: 1, alg: 'nip44' }), 'BAD_CIPHERTEXT');
  expectFail('ciphertext wrong type', () => decryptAsBob({ ...envelope, ct: 123 }), 'BAD_CIPHERTEXT');
}

// Malformed inner after forge: encrypt valid then decrypt with patched plaintext via raw nip44 is hard;
// instead feed envelope whose ct encrypts bad JSON by building conversation key ourselves.
{
  const ck = nip44.v2.utils.getConversationKey(alice.sk, bob.pk);
  const badJsonEnv = {
    family: 'sos-e2ee',
    v: 1,
    alg: 'nip44',
    ct: nip44.v2.encrypt('not-json', ck),
  };
  expectFail('malformed decrypted JSON', () => decryptAsBob(badJsonEnv), 'BAD_JSON');

  const arrayEnv = {
    family: 'sos-e2ee',
    v: 1,
    alg: 'nip44',
    ct: nip44.v2.encrypt(JSON.stringify([{ v: 1 }]), ck),
  };
  expectFail('JSON array schema', () => decryptAsBob(arrayEnv), 'BAD_SCHEMA');

  const badSchema = {
    family: 'sos-e2ee',
    v: 1,
    alg: 'nip44',
    ct: nip44.v2.encrypt(
      JSON.stringify({
        v: 1,
        type: 'private-chat',
        messageId: 'x',
        sender: alice.pk,
        recipient: bob.pk,
        createdAt: now,
        text: 123,
        attachment: null,
      }),
      ck,
    ),
  };
  expectFail('valid JSON wrong schema', () => decryptAsBob(badSchema), 'BAD_TEXT');
}

expectFail(
  'sender mismatch',
  () => {
    const { envelope } = encryptAliceToBob({
      text: 'x',
      messageId: 'sm',
      sender: bob.pk,
    });
    return envelope;
  },
  'SENDER_MISMATCH',
);

{
  const ck = nip44.v2.utils.getConversationKey(alice.sk, bob.pk);
  const mismatchInner = {
    v: 1,
    type: 'private-chat',
    messageId: 'rm1',
    sender: alice.pk,
    recipient: alice.pk,
    createdAt: now,
    text: 'nope',
    attachment: null,
  };
  const env = { family: 'sos-e2ee', v: 1, alg: 'nip44', ct: nip44.v2.encrypt(JSON.stringify(mismatchInner), ck) };
  expectFail('recipient mismatch', () => decryptAsBob(env), 'RECIPIENT_MISMATCH');
}

expectFail(
  'oversized text',
  () =>
    encryptAliceToBob({
      text: 'x'.repeat(16001),
      messageId: 'big',
    }),
  'OVERSIZED_TEXT',
);

expectFail(
  'malformed attachment',
  () =>
    encryptAliceToBob({
      text: '',
      messageId: 'bad-att',
      attachment: { name: 'x', type: 'javascript:alert(1)', url: 'javascript:alert(1)' },
    }),
  'BAD_ATTACHMENT',
);

// Key input tests
expectFail(
  'bad pubkey length',
  () =>
    App.encryptPrivateChatPayload({
      senderPrivateKeyHex: alice.hex,
      senderPubkey: 'abcd',
      recipientPubkey: bob.pk,
      payload: basePayload(),
    }),
  'BAD_SENDER',
);
expectFail(
  'non-hex pubkey',
  () =>
    App.encryptPrivateChatPayload({
      senderPrivateKeyHex: alice.hex,
      senderPubkey: 'z'.repeat(64),
      recipientPubkey: bob.pk,
      payload: basePayload(),
    }),
  'BAD_SENDER',
);
expectFail(
  'empty private key',
  () =>
    App.encryptPrivateChatPayload({
      senderPrivateKeyHex: '',
      senderPubkey: alice.pk,
      recipientPubkey: bob.pk,
      payload: basePayload(),
    }),
  'BAD_PRIVATE_KEY',
);
expectFail(
  'bad private key length',
  () =>
    App.encryptPrivateChatPayload({
      senderPrivateKeyHex: 'aa',
      senderPubkey: alice.pk,
      recipientPubkey: bob.pk,
      payload: basePayload(),
    }),
  'BAD_PRIVATE_KEY',
);

// Timestamp
expectFail(
  'createdAt NaN',
  () => encryptAliceToBob({ createdAt: NaN, messageId: 'ts1' }),
  'BAD_CREATED_AT',
);
expectFail(
  'createdAt Infinity',
  () => encryptAliceToBob({ createdAt: Infinity, messageId: 'ts2' }),
  'BAD_CREATED_AT',
);
expectFail(
  'createdAt negative',
  () => encryptAliceToBob({ createdAt: -1, messageId: 'ts3' }),
  'BAD_CREATED_AT',
);
expectFail(
  'createdAt non-integer',
  () => encryptAliceToBob({ createdAt: 1.5, messageId: 'ts4' }),
  'BAD_CREATED_AT',
);

// Uppercase pubkey normalization
try {
  const payload = basePayload({
    sender: alice.pk.toUpperCase(),
    recipient: bob.pk.toUpperCase(),
    text: 'upper',
    messageId: 'up1',
  });
  const envelope = App.encryptPrivateChatPayload({
    senderPrivateKeyHex: alice.hex,
    senderPubkey: alice.pk.toUpperCase(),
    recipientPubkey: bob.pk.toUpperCase(),
    payload,
  });
  const out = decryptAsBob(envelope);
  record('uppercase pubkey normalized', out.sender === alice.pk && out.recipient === bob.pk && out.text === 'upper');
} catch (err) {
  record('uppercase pubkey normalized', false, err.message);
}

// Randomization
try {
  const payload = basePayload({ text: 'same-plain', messageId: 'rand-shared' });
  // Use same logical fields but allow different messageIds for two encrypts of same text
  const e1 = App.encryptPrivateChatPayload({
    senderPrivateKeyHex: alice.hex,
    senderPubkey: alice.pk,
    recipientPubkey: bob.pk,
    payload: { ...payload, messageId: 'rand-1' },
  });
  const e2 = App.encryptPrivateChatPayload({
    senderPrivateKeyHex: alice.hex,
    senderPubkey: alice.pk,
    recipientPubkey: bob.pk,
    payload: { ...payload, messageId: 'rand-1' },
  });
  const d1 = decryptAsBob(e1);
  const d2 = decryptAsBob(e2);
  record(
    'randomization different ciphertext',
    e1.ct !== e2.ct && d1.text === 'same-plain' && d2.text === 'same-plain',
  );
} catch (err) {
  record('randomization different ciphertext', false, err.message);
}

// Plaintext marker sanity
const MARKER = 'E1-SECRET-PLAINTEXT-TEST-7F31';
try {
  const { envelope } = encryptAliceToBob({ text: MARKER, messageId: 'marker' });
  const wire = JSON.stringify(envelope);
  const out = decryptAsBob(envelope);
  record(
    'ciphertext plaintext sanity',
    !wire.includes(MARKER) && !envelope.ct.includes(MARKER) && out.text === MARKER,
  );
} catch (err) {
  record('ciphertext plaintext sanity', false, err.message);
}

// encryption_failure_never_returns_plaintext
{
  const originalEncrypt = nip44.v2.encrypt;
  let sawPlain = false;
  try {
    nip44.v2.encrypt = function boom(plaintext) {
      if (typeof plaintext === 'string' && plaintext.includes('MUST-NOT-LEAK')) sawPlain = true;
      throw new Error('forced-encrypt-failure');
    };
    // Reload? App already closed over NT from context — need to break via context.NostrTools
    // The loaded module holds reference to context.NostrTools.nip44.v2.encrypt
    const nt = App.encryptPrivateChatPayload;
    // Patch through global tools used by the vm context — re-get from context via App path:
    // chat-e2ee closes over NT from load time = context.NostrTools
    // So patching nip44.v2.encrypt on the imported object should affect context if same ref.
    let result = null;
    let threw = false;
    let errCode = '';
    try {
      result = App.encryptPrivateChatPayload({
        senderPrivateKeyHex: alice.hex,
        senderPubkey: alice.pk,
        recipientPubkey: bob.pk,
        payload: basePayload({ text: 'MUST-NOT-LEAK', messageId: 'nofallback' }),
      });
    } catch (err) {
      threw = true;
      errCode = err.code || '';
    }
    const leaked =
      result &&
      (result.text === 'MUST-NOT-LEAK' ||
        result.t === 'MUST-NOT-LEAK' ||
        (typeof result === 'string' && result.includes('MUST-NOT-LEAK')) ||
        JSON.stringify(result || {}).includes('MUST-NOT-LEAK'));
    record(
      'encryption_failure_never_returns_plaintext',
      threw && errCode === 'ENCRYPT_FAILURE' && !leaked,
      threw ? '' : 'did not throw',
    );
  } finally {
    nip44.v2.encrypt = originalEncrypt;
  }
}

// Representative MIME still accepted via attachment inspector
const mimeOk = [
  ['image/png', 'a.png'],
  ['video/mp4', 'a.mp4'],
  ['audio/webm', 'a.webm'],
];
for (const [type, name] of mimeOk) {
  try {
    const { envelope } = encryptAliceToBob({
      text: '',
      messageId: 'mime-' + type,
      attachment: { name, type, size: 10, url: 'https://cdn.example.com/' + name },
    });
    const out = decryptAsBob(envelope);
    record('MIME ok ' + type, out.attachment && out.attachment.type === type);
  } catch (err) {
    record('MIME ok ' + type, false, err.message);
  }
}

console.log(results.join('\n'));
console.log(`\nSummary: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
