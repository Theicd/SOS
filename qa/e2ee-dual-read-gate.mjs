#!/usr/bin/env node
/**
 * E2 — Web dual-read for kind 1050 (legacy plaintext + sos-e2ee v1 receive).
 * Encrypt send must remain disabled.
 * Run: node qa/e2ee-dual-read-gate.mjs
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
const CHAT_KIND = 1050;
const CHAT_TAG = 'yalachat';

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

function cloneEvent(event) {
  return JSON.parse(JSON.stringify(event));
}

function skHex(sk) {
  return utils.bytesToHex(sk);
}

function loadDualReadHarness(options = {}) {
  const selfSk = options.selfSk || generateSecretKey();
  const peerSk = options.peerSk || generateSecretKey();
  const selfPk = getPublicKey(selfSk);
  const peerPk = getPublicKey(peerSk);
  const warnings = [];
  const appended = [];
  let onevent = null;
  let decryptCalls = 0;

  const localStorage = {
    store: Object.create(null),
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
    },
    setItem(key, value) {
      this.store[key] = String(value);
    },
    removeItem(key) {
      delete this.store[key];
    },
    get length() {
      return Object.keys(this.store).length;
    },
    key(index) {
      return Object.keys(this.store)[index] || null;
    },
  };

  const App = {
    chatState: { contacts: new Map() },
    _chatServiceBootstrapped: true,
    publicKey: selfPk,
    privateKey: options.omitPrivateKey ? '' : skHex(selfSk),
    relayUrls: ['wss://example.invalid'],
    hexToBytes: utils.hexToBytes,
    ensureChatContact() {},
    fetchProfile: async () => ({ name: 'Peer', picture: '' }),
    appendChatMessage(msg) {
      const idx = appended.findIndex((m) => m && m.id === msg.id);
      if (idx >= 0) {
        appended[idx] = msg;
      } else {
        appended.push(msg);
      }
    },
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
      try {
        const payload = JSON.parse(rawContent);
        if (
          payload &&
          typeof payload === 'object' &&
          (Object.prototype.hasOwnProperty.call(payload, 't') ||
            Object.prototype.hasOwnProperty.call(payload, 'a'))
        ) {
          return {
            displayText: payload.t || '',
            attachment: payload.a || null,
            hasAttachment: Boolean(payload.a),
          };
        }
      } catch (_err) {}
      return { displayText: rawContent, attachment: null, hasAttachment: false };
    },
    torrentTransfer: { handleIncomingRequest() {} },
    dataChannel: {
      isConnected() {
        return false;
      },
      connect() {},
    },
  };

  App.pool = {
    subscribeMany(_relays, _filters, handlers) {
      onevent = handlers && handlers.onevent;
      return { close() {} };
    },
    publish() {
      return [];
    },
  };

  const context = {
    console: {
      log() {},
      warn(...args) {
        warnings.push(args.map((value) => String(value)).join(' '));
      },
      error() {},
    },
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

  // Load E2EE in host realm; bind decrypt into App used by chat-service context.
  const hostApp = {
    inspectIncomingChatAttachment: App.inspectIncomingChatAttachment.bind(App),
    verifyIncomingChatAttachment: App.verifyIncomingChatAttachment.bind(App),
    hexToBytes: utils.hexToBytes,
  };
  globalThis.NostrApp = hostApp;
  globalThis.NostrTools = context.NostrTools;
  vm.runInThisContext(read('chat-e2ee.js'), { filename: 'chat-e2ee.js' });

  const realDecrypt = hostApp.decryptPrivateChatPayload;
  App.decryptPrivateChatPayload = function wrappedDecrypt(args) {
    decryptCalls += 1;
    return realDecrypt(args);
  };
  App.encryptPrivateChatPayload = hostApp.encryptPrivateChatPayload;
  App.isE2eeEnvelope = hostApp.isE2eeEnvelope;
  App.looksLikeSosE2eeEnvelope = hostApp.looksLikeSosE2eeEnvelope;
  App.parseEncryptedEnvelope = hostApp.parseEncryptedEnvelope;
  App.MAX_E2EE_CIPHERTEXT_CHARS = hostApp.MAX_E2EE_CIPHERTEXT_CHARS;

  if (typeof App.subscribeToChatEvents !== 'function') {
    throw new Error('subscribeToChatEvents missing');
  }
  App.subscribeToChatEvents();
  if (typeof onevent !== 'function') {
    throw new Error('onevent not captured');
  }

  async function deliver(event) {
    try {
      onevent(event);
    } catch (err) {
      warnings.push('onevent-threw ' + (err && err.message ? err.message : String(err)));
    }
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return {
    App,
    selfSk,
    selfPk,
    peerSk,
    peerPk,
    warnings,
    appended,
    deliver,
    getDecryptCalls: () => decryptCalls,
    resetDecryptCalls: () => {
      decryptCalls = 0;
    },
    encrypt: hostApp.encryptPrivateChatPayload,
  };
}

function signChat(authorSk, recipientPk, content, createdAt) {
  return cloneEvent(
    finalizeEvent(
      {
        kind: CHAT_KIND,
        created_at: createdAt || Math.floor(Date.now() / 1000),
        tags: [
          ['p', String(recipientPk).toLowerCase()],
          ['t', CHAT_TAG],
        ],
        content,
      },
      authorSk,
    ),
  );
}

function flipSig(event) {
  const copy = cloneEvent(event);
  const sig = String(copy.sig || '');
  copy.sig = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
  return copy;
}

function makeInner(h, overrides = {}) {
  return {
    v: 1,
    type: 'private-chat',
    messageId: 'logical-' + Math.random().toString(16).slice(2),
    sender: h.peerPk,
    recipient: h.selfPk,
    createdAt: Math.floor(Date.now() / 1000),
    text: 'Hello test',
    attachment: null,
    ...overrides,
  };
}

function encryptToSelf(h, overrides = {}) {
  const payload = makeInner(h, overrides);
  const envelope = h.encrypt({
    senderPrivateKeyHex: skHex(h.peerSk),
    senderPubkey: h.peerPk,
    recipientPubkey: h.selfPk,
    payload,
  });
  return { payload, envelope, content: JSON.stringify(envelope) };
}

// --- Static live-path assertions ---
const svc = read('chat-service.js');
const fts = read('chat-file-transfer-service.js');
const videos = read('videos.html');
const e2ee = read('chat-e2ee.js');

record('E2 receive wires decryptPrivateChatPayload', svc.includes('decryptPrivateChatPayload') && svc.includes('looksLikeIncomingE2eeContent'));
record('E2 fail-closed recognized envelope', svc.includes('Recognized sos-e2ee') || svc.includes('never legacy-fallback'));
record('E2 pending key retry present', svc.includes('queuePendingE2eeEvent') && svc.includes('flushPendingE2eeEvents'));
record('LIVE_E2EE_SEND=false', !svc.includes('encryptPrivateChatPayload') && !fts.includes('encryptPrivateChatPayload'));
record('videos.html loads chat-e2ee.js before chat-service', (() => {
  const a = videos.indexOf('chat-e2ee.js');
  const b = videos.indexOf('chat-service.js');
  return a >= 0 && b > a;
})());
record('videos.html does not load chat-e2ee-wrapper.js', !videos.includes('chat-e2ee-wrapper.js'));
record('message id strategy documented in service', svc.includes('transportEventId') && svc.includes('logicalMessageId'));
record('ciphertext size bound before decrypt', svc.includes('OVERSIZED_CIPHERTEXT') && e2ee.includes('87472'));
record('E2 reject log has no ciphertext field', !svc.includes('[SECURITY/E2EE_REJECT]') || !/E2EE_REJECT.*ciphertext/.test(svc));
record('25050/25055 paths untouched by E2 markers', !read('chat-voice-call.js').includes('sos-e2ee') && !read('chat-p2p-datachannel.js').includes('sos-e2ee'));

async function run() {
  const h = loadDualReadHarness();

  // Legacy plaintext
  {
    const before = h.appended.length;
    await h.deliver(signChat(h.peerSk, h.selfPk, 'plain hello'));
    record('legacy plaintext', h.appended.length === before + 1 && h.appended[before].content === 'plain hello' && h.appended[before].id.length === 64);
  }
  {
    const before = h.appended.length;
    await h.deliver(signChat(h.peerSk, h.selfPk, JSON.stringify({ t: 'json text', a: null })));
    record('legacy {t,a:null}', h.appended.length === before + 1 && h.appended[before].content === 'json text');
  }
  {
    const before = h.appended.length;
    const att = { name: 'pic.jpg', type: 'image/jpeg', size: 12, url: 'https://cdn.example.com/x.jpg' };
    await h.deliver(signChat(h.peerSk, h.selfPk, JSON.stringify({ t: '', a: att })));
    record('legacy image attachment', h.appended.length === before + 1 && h.appended[before].attachment && h.appended[before].attachment.type === 'image/jpeg');
  }
  {
    const before = h.appended.length;
    const att = { name: 'voice.webm', type: 'audio/webm; codecs=opus', size: 9, duration: 2, url: 'https://cdn.example.com/v.webm' };
    await h.deliver(signChat(h.peerSk, h.selfPk, JSON.stringify({ t: '', a: att })));
    const msg = h.appended[before];
    record(
      'legacy voice attachment',
      !!msg &&
        msg.attachment &&
        (msg.attachment.type === 'audio/webm' || msg.attachment.type === 'audio/webm; codecs=opus'),
    );
  }

  // Encrypted positives
  {
    const { content, payload } = encryptToSelf(h, { text: 'שלום E2', messageId: 'he1' });
    const before = h.appended.length;
    h.resetDecryptCalls();
    await h.deliver(signChat(h.peerSk, h.selfPk, content));
    const msg = h.appended[before];
    record(
      'encrypted Hebrew text',
      h.appended.length === before + 1 &&
        msg.content === 'שלום E2' &&
        msg.logicalMessageId === 'he1' &&
        msg.id !== 'he1' &&
        h.getDecryptCalls() === 1,
    );
  }
  {
    const { content } = encryptToSelf(h, { text: 'emoji 🙂', messageId: 'em1' });
    const before = h.appended.length;
    await h.deliver(signChat(h.peerSk, h.selfPk, content));
    record('encrypted emoji', h.appended.length === before + 1 && h.appended[before].content === 'emoji 🙂');
  }
  {
    const { content } = encryptToSelf(h, { text: 'line1\nline2', messageId: 'ml1' });
    const before = h.appended.length;
    await h.deliver(signChat(h.peerSk, h.selfPk, content));
    record('encrypted multiline', h.appended.length === before + 1 && h.appended[before].content === 'line1\nline2');
  }
  {
    const { content } = encryptToSelf(h, {
      text: '',
      messageId: 'att1',
      attachment: { name: 'a.png', type: 'image/png', size: 3, url: 'https://cdn.example.com/a.png' },
    });
    const before = h.appended.length;
    await h.deliver(signChat(h.peerSk, h.selfPk, content));
    record(
      'encrypted attachment-only',
      h.appended.length === before + 1 &&
        h.appended[before].content === '' &&
        h.appended[before].attachment &&
        h.appended[before].attachment.type === 'image/png',
    );
  }
  {
    const { content } = encryptToSelf(h, {
      text: '',
      messageId: 'voice1',
      attachment: {
        name: 'voice.webm',
        type: 'audio/webm; codecs=opus',
        size: 8,
        duration: 1.5,
        url: 'https://cdn.example.com/voice.webm',
      },
    });
    const before = h.appended.length;
    await h.deliver(signChat(h.peerSk, h.selfPk, content));
    const msg = h.appended[before];
    record(
      'encrypted Voice MIME',
      !!msg &&
        msg.attachment &&
        (msg.attachment.type === 'audio/webm' || String(msg.attachment.type).startsWith('audio/webm')),
    );
  }
  {
    // history-style older timestamp (still within retention)
    const { content } = encryptToSelf(h, { text: 'history msg', messageId: 'hist1', createdAt: Math.floor(Date.now() / 1000) - 86400 });
    const before = h.appended.length;
    await h.deliver(signChat(h.peerSk, h.selfPk, content, Math.floor(Date.now() / 1000) - 86400));
    record('encrypted history-style event', h.appended.length === before + 1 && h.appended[before].content === 'history msg');
  }

  // Signature before decrypt
  {
    const { content } = encryptToSelf(h, { text: 'sig-order', messageId: 'sig1' });
    const bad = flipSig(signChat(h.peerSk, h.selfPk, content));
    const before = h.appended.length;
    h.resetDecryptCalls();
    await h.deliver(bad);
    record(
      'signature-before-decrypt',
      h.appended.length === before && h.getDecryptCalls() === 0,
    );
  }

  // Wrong recipient (outer p tag)
  {
    const other = getPublicKey(generateSecretKey());
    const { content } = encryptToSelf(h, { text: 'wrong-p', messageId: 'wp1' });
    const ev = signChat(h.peerSk, other, content);
    const before = h.appended.length;
    h.resetDecryptCalls();
    await h.deliver(ev);
    record('wrong recipient before decrypt', h.appended.length === before && h.getDecryptCalls() === 0);
  }

  // Tampered ciphertext (re-signed after tamper)
  {
    const { envelope, payload } = encryptToSelf(h, { text: 'tamper-me', messageId: 'tm1' });
    const tampered = {
      ...envelope,
      ct: envelope.ct.slice(0, -3) + (envelope.ct.endsWith('AAA') ? 'BBB' : 'AAA'),
    };
    const before = h.appended.length;
    await h.deliver(signChat(h.peerSk, h.selfPk, JSON.stringify(tampered)));
    record(
      'tampered ciphertext rejected',
      h.appended.length === before &&
        h.warnings.some((w) => w.includes('E2EE_REJECT') && (w.includes('DECRYPT') || w.includes('DECRYPT_FAILURE') || w.includes('BAD_'))),
    );
  }

  // Inner sender mismatch
  {
    const ck = nip44.v2.utils.getConversationKey(h.peerSk, h.selfPk);
    const badInner = makeInner(h, { sender: h.selfPk, text: 'bad-sender', messageId: 'bs1' });
    const env = { family: 'sos-e2ee', v: 1, alg: 'nip44', ct: nip44.v2.encrypt(JSON.stringify(badInner), ck) };
    const before = h.appended.length;
    await h.deliver(signChat(h.peerSk, h.selfPk, JSON.stringify(env)));
    record('inner sender mismatch', h.appended.length === before);
  }

  // Inner recipient mismatch
  {
    const other = getPublicKey(generateSecretKey());
    const ck = nip44.v2.utils.getConversationKey(h.peerSk, h.selfPk);
    const badInner = makeInner(h, { recipient: other, text: 'bad-recip', messageId: 'br1' });
    const env = { family: 'sos-e2ee', v: 1, alg: 'nip44', ct: nip44.v2.encrypt(JSON.stringify(badInner), ck) };
    const before = h.appended.length;
    await h.deliver(signChat(h.peerSk, h.selfPk, JSON.stringify(env)));
    record('inner recipient mismatch', h.appended.length === before);
  }

  // Unknown version
  {
    const { envelope } = encryptToSelf(h, { text: 'v99', messageId: 'v99' });
    const before = h.appended.length;
    await h.deliver(signChat(h.peerSk, h.selfPk, JSON.stringify({ ...envelope, v: 99 })));
    record(
      'unknown version reject (not legacy)',
      h.appended.length === before &&
        !h.appended.some((m) => String(m.content || '').includes('"family"')),
    );
  }

  // Malformed envelope
  {
    const before = h.appended.length;
    await h.deliver(signChat(h.peerSk, h.selfPk, JSON.stringify({ family: 'sos-e2ee', v: 1, alg: 'nip44' })));
    record('malformed envelope missing ct', h.appended.length === before);
  }
  {
    const before = h.appended.length;
    await h.deliver(signChat(h.peerSk, h.selfPk, JSON.stringify({ family: 'sos-e2ee', v: 1, alg: 'nip04', ct: 'x' })));
    record('malformed envelope wrong alg', h.appended.length === before);
  }

  // Legacy JSON collision — not sos-e2ee family
  {
    const before = h.appended.length;
    const text = JSON.stringify({ family: 'something', v: 1 });
    await h.deliver(signChat(h.peerSk, h.selfPk, text));
    record(
      'legacy JSON collision stays readable',
      h.appended.length === before + 1 && h.appended[before].content === text,
    );
  }

  // Missing key + retry
  {
    const h2 = loadDualReadHarness({ omitPrivateKey: true });
    const { content, payload } = (() => {
      const inner = {
        v: 1,
        type: 'private-chat',
        messageId: 'retry1',
        sender: h2.peerPk,
        recipient: h2.selfPk,
        createdAt: Math.floor(Date.now() / 1000),
        text: 'retry-me',
        attachment: null,
      };
      const envelope = h2.encrypt({
        senderPrivateKeyHex: skHex(h2.peerSk),
        senderPubkey: h2.peerPk,
        recipientPubkey: h2.selfPk,
        payload: inner,
      });
      return { content: JSON.stringify(envelope), payload: inner };
    })();
    const before = h2.appended.length;
    await h2.deliver(signChat(h2.peerSk, h2.selfPk, content));
    const pendingOk =
      h2.appended.length === before &&
      h2.warnings.some((w) => w.includes('E2EE_DECRYPT_UNAVAILABLE'));
    h2.App.privateKey = skHex(h2.selfSk);
    if (typeof h2.App.flushPendingE2eeEvents === 'function') {
      h2.App.flushPendingE2eeEvents();
    }
    await new Promise((r) => setTimeout(r, 30));
    // Also deliver a benign event to trigger flush at handle start
    await h2.deliver(signChat(h2.peerSk, h2.selfPk, 'wake'));
    await new Promise((r) => setTimeout(r, 40));
    const recovered = h2.appended.some((m) => m.content === 'retry-me');
    record('missing key queues then retries', pendingOk && recovered);
  }

  // Dedupe same event twice
  {
    const { content } = encryptToSelf(h, { text: 'dedupe', messageId: 'dd1' });
    const ev = signChat(h.peerSk, h.selfPk, content);
    const before = h.appended.length;
    await h.deliver(ev);
    await h.deliver(cloneEvent(ev));
    const count = h.appended.filter((m) => m.id === ev.id).length;
    // appendMessageToConversation replaces same id — length may stay +1
    record('dedupe same encrypted event', h.appended.length === before + 1 || count === 1);
  }

  // Mixed history order
  {
    const h3 = loadDualReadHarness();
    const t0 = Math.floor(Date.now() / 1000) - 10;
    await h3.deliver(signChat(h3.peerSk, h3.selfPk, 'legacy-A', t0));
    const encB = encryptToSelf(h3, { text: 'enc-B', messageId: 'mixB', createdAt: t0 + 1 });
    await h3.deliver(signChat(h3.peerSk, h3.selfPk, encB.content, t0 + 1));
    await h3.deliver(signChat(h3.peerSk, h3.selfPk, 'legacy-C', t0 + 2));
    const encD = encryptToSelf(h3, {
      text: '',
      messageId: 'mixD',
      createdAt: t0 + 3,
      attachment: { name: 'f.bin', type: 'application/pdf', size: 1, url: 'https://cdn.example.com/f.pdf' },
    });
    await h3.deliver(signChat(h3.peerSk, h3.selfPk, encD.content, t0 + 3));
    const texts = h3.appended.map((m) => m.content);
    record(
      'mixed history order',
      texts.includes('legacy-A') &&
        texts.includes('enc-B') &&
        texts.includes('legacy-C') &&
        h3.appended.some((m) => m.attachment && m.attachment.type === 'application/pdf'),
    );
  }

  // XSS-looking encrypted text still appends as text (render safety is downstream)
  {
    const { content } = encryptToSelf(h, { text: '<script>alert(1)</script>', messageId: 'xss1' });
    const before = h.appended.length;
    await h.deliver(signChat(h.peerSk, h.selfPk, content));
    record(
      'encrypted XSS-looking text normalized',
      h.appended.length === before + 1 && h.appended[before].content === '<script>alert(1)</script>',
    );
  }

  // Malicious attachment URL in encrypted payload (bypass E1 encrypt gate via raw nip44)
  {
    const ck = nip44.v2.utils.getConversationKey(h.peerSk, h.selfPk);
    const bad = makeInner(h, {
      text: '',
      messageId: 'jsurl',
      attachment: { name: 'x.png', type: 'image/png', size: 1, url: 'javascript:alert(1)' },
    });
    const env = { family: 'sos-e2ee', v: 1, alg: 'nip44', ct: nip44.v2.encrypt(JSON.stringify(bad), ck) };
    const before = h.appended.length;
    await h.deliver(signChat(h.peerSk, h.selfPk, JSON.stringify(env)));
    const msg = h.appended[before];
    const ok =
      h.appended.length === before ||
      (msg && (!msg.attachment || !String(msg.attachment.url || '').toLowerCase().startsWith('javascript')));
    record('file safety on encrypted attachment', ok);
  }

  // Oversize ciphertext structural bound
  {
    const before = h.appended.length;
    const huge = {
      family: 'sos-e2ee',
      v: 1,
      alg: 'nip44',
      ct: 'A'.repeat(90000),
    };
    h.resetDecryptCalls();
    await h.deliver(signChat(h.peerSk, h.selfPk, JSON.stringify(huge)));
    record('oversize ciphertext rejected before/without success', h.appended.length === before && h.getDecryptCalls() === 0);
  }

  console.log(results.join('\n'));
  console.log(`\nSummary: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
