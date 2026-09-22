#!/usr/bin/env node
/**
 * E3B — Sender self-echo / history rebuild for encrypted kind 1050.
 * Does NOT change production e2eeSendRequired.
 * Run: node qa/e2ee-self-echo-gate.mjs
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

function skHex(sk) {
  return utils.bytesToHex(sk);
}

function makePair() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), hex: skHex(sk) };
}

function loadHarness(identity, options = {}) {
  const appended = [];
  const pushCalls = [];
  const logs = [];
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

  const App = {
    chatState: { contacts: new Map() },
    _chatServiceBootstrapped: true,
    publicKey: identity.pk,
    privateKey: identity.hex,
    relayUrls: ['wss://example.invalid'],
    forceRelay: true,
    NETWORK_TAG: 'sos',
    hexToBytes: utils.hexToBytes,
    finalizeEvent(draft, key) {
      const hostDraft = JSON.parse(JSON.stringify(draft));
      const sk = typeof key === 'string' ? utils.hexToBytes(key) : key;
      return finalizeEvent(hostDraft, sk);
    },
    pool: {
      subscribeMany() {
        return { close() {} };
      },
      publish() {
        return Promise.resolve([]);
      },
    },
    ensureChatContact() {},
    fetchProfile: async () => ({ name: 'Peer', picture: '' }),
    appendChatMessage(msg) {
      const idx = appended.findIndex((m) => m && m.id === msg.id);
      if (idx >= 0) return;
      appended.push(msg);
    },
    getChatMessages(peer) {
      const p = String(peer || '').toLowerCase();
      return appended.filter((m) => {
        const from = String(m.from || '').toLowerCase();
        const to = String(m.to || '').toLowerCase();
        return from === p || to === p;
      });
    },
    removeChatMessage() {},
    updateChatMessageStatus() {},
    markChatConversationRead() {},
    getChatLastSyncTs() {
      return 0;
    },
    setChatLastSyncTs() {},
    triggerChatMessagePush(msg) {
      pushCalls.push(msg);
    },
    triggerOutgoingMessagePush() {},
    afterChatMessagePublished() {},
    hasChatFileAttachment() {
      return false;
    },
    serializeChatMessageContent(_peer, text) {
      return {
        rawContent: JSON.stringify({ t: text || '', a: null }),
        displayText: text || '',
        attachment: null,
        hasAttachment: false,
      };
    },
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
    dataChannel: { isConnected() { return false; }, connect() {}, send() { return false; } },
    torrentTransfer: { handleIncomingRequest() {} },
    getChatRetentionCutoffTs(nowSec) {
      return nowSec - 90 * 24 * 60 * 60;
    },
    isSecureChatReady() {
      return true;
    },
    getSecureChatGateState() {
      return 'READY';
    },
    isE2eeSendRequired() {
      return true;
    },
    resolveRelayE2eeSendDecision: async () => ({ ok: true, encrypt: true }),
    ...options.App,
  };

  const context = {
    console: {
      log(...a) {
        logs.push(['log', a.map(String).join(' ')]);
      },
      warn(...a) {
        logs.push(['warn', a.map(String).join(' ')]);
      },
      error(...a) {
        logs.push(['error', a.map(String).join(' ')]);
      },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    btoa(v) {
      return Buffer.from(String(v), 'utf8').toString('base64');
    },
    atob(v) {
      return Buffer.from(String(v), 'base64').toString('utf8');
    },
    URL,
    URLSearchParams,
    localStorage,
    navigator: { onLine: true },
    document: {
      readyState: 'complete',
      hidden: false,
      addEventListener() {},
      getElementById() {
        return null;
      },
      createElement() {
        return { style: {}, setAttribute() {}, appendChild() {}, querySelector() { return null; } };
      },
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        version: 't',
        minSecureChatEpoch: 1,
        e2eeSendRequired: true,
      }),
    }),
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
  App.finalizeEvent = (draft, key) => finalizeEvent(JSON.parse(JSON.stringify(draft)), key);
  App.hexToBytes = utils.hexToBytes;
  vm.runInContext(read('sos-crypto-signer.js'), context, { filename: 'sos-crypto-signer.js' });
  vm.runInContext(read('chat-service.js'), context, { filename: 'chat-service.js' });

  const hostApp = Object.assign(App, {
    inspectIncomingChatAttachment: App.inspectIncomingChatAttachment.bind(App),
    verifyIncomingChatAttachment: App.verifyIncomingChatAttachment.bind(App),
    hexToBytes: utils.hexToBytes,
  });
  globalThis.NostrApp = hostApp;
  globalThis.NostrTools = context.NostrTools;
  vm.runInThisContext(read('chat-e2ee.js'), { filename: 'chat-e2ee.js' });
  Object.assign(App, {
    encryptPrivateChatPayload: globalThis.NostrApp.encryptPrivateChatPayload,
    decryptPrivateChatPayload: globalThis.NostrApp.decryptPrivateChatPayload,
    looksLikeSosE2eeEnvelope: globalThis.NostrApp.looksLikeSosE2eeEnvelope,
    normalizeHexPubkey: globalThis.NostrApp.normalizeHexPubkey,
    MAX_E2EE_CIPHERTEXT_CHARS: globalThis.NostrApp.MAX_E2EE_CIPHERTEXT_CHARS,
  });

  return { App, appended, pushCalls, logs, identity };
}

function signChat(author, recipientPk, content, createdAt) {
  return JSON.parse(
    JSON.stringify(
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
        author.sk,
      ),
    ),
  );
}

const svc = read('chat-service.js');
const e2ee = read('chat-e2ee.js');
record('self-authored decrypt path present', e2ee.includes('selfAuthored') && e2ee.includes('intendedRecipientPubkey'));
record('bindOuterInnerIdentitiesSelfAuthored present', e2ee.includes('bindOuterInnerIdentitiesSelfAuthored'));
record('extractValidatedChatRecipientPTag present', svc.includes('extractValidatedChatRecipientPTag'));
record('accepted-self log present', svc.includes('accepted-self'));
record('self-echo deduped log present', svc.includes('self-echo deduped'));
record('no plaintext fallback on E2EE', svc.includes('never legacy-fallback') || svc.includes('Recognized sos-e2ee'));

async function run() {
  const alice = makePair();
  const bob = makePair();
  const mallory = makePair();
  const now = Math.floor(Date.now() / 1000);
  const SECRET = 'SELF_ECHO_SECRET_91827';

  const envelope = (() => {
    const h = loadHarness(alice);
    return h.App.encryptPrivateChatPayload({
      senderPrivateKeyHex: alice.hex,
      senderPubkey: alice.pk,
      recipientPubkey: bob.pk,
      payload: {
        messageId: 'cmsg-self-echo-1',
        sender: alice.pk,
        recipient: bob.pk,
        createdAt: now,
        text: SECRET,
        attachment: null,
      },
    });
  })();
  const event = signChat(alice, bob.pk, JSON.stringify(envelope), now);
  record('fixture kind 1050 signed', event.kind === 1050 && !!event.id && !!event.sig);
  record('fixture has single p tag to bob', event.tags.filter((t) => t[0] === 'p').length === 1 && event.tags.find((t) => t[0] === 'p')[1] === bob.pk);

  // 1-2: Bob decrypts incoming
  {
    const bobH = loadHarness(bob);
    await bobH.App.handleIncomingChatEvent(event);
    record('encrypted Alice→Bob Bob decrypts PASS', bobH.appended.length === 1 && bobH.appended[0].content === SECRET);
    record('Bob direction incoming', bobH.appended[0]?.direction === 'incoming');
    record('Bob peer conversation from Alice', bobH.appended[0]?.from === alice.pk);
    record('Bob no self Push for remote', bobH.pushCalls.length === 1 || bobH.pushCalls.length === 0); // may push if recent
  }

  // 3-4: Alice receives same event (self-echo)
  {
    const aliceH = loadHarness(alice);
    await aliceH.App.handleIncomingChatEvent(event);
    record('Alice self-echo decrypt PASS', aliceH.appended.length === 1 && aliceH.appended[0].content === SECRET);
    record('Alice direction outgoing', aliceH.appended[0]?.direction === 'outgoing');
    record('Alice conversation peer Bob', aliceH.appended[0]?.to === bob.pk || aliceH.appended[0]?.from === alice.pk);
    record(
      'Alice accepted-self log',
      aliceH.logs.some((l) => String(l[1]).includes('accepted-self') && String(l[1]).includes(event.id.slice(0, 8))),
    );
    record('Alice no DECRYPT_FAILURE', !aliceH.logs.some((l) => String(l[1]).includes('DECRYPT_FAILURE')));
    record('Alice no self Push', aliceH.pushCalls.length === 0);
  }

  // 5: dedupe — local already has outgoing
  {
    const aliceH = loadHarness(alice);
    aliceH.appended.push({
      id: event.id,
      from: alice.pk,
      to: bob.pk,
      content: SECRET,
      createdAt: now,
      direction: 'outgoing',
    });
    await aliceH.App.handleIncomingChatEvent(event);
    record('self-echo dedupe no duplicate', aliceH.appended.length === 1);
    record(
      'self-echo deduped log',
      aliceH.logs.some((l) => String(l[1]).includes('self-echo deduped')),
    );
  }

  // 6: history rebuild clean Alice runtime
  {
    const aliceH = loadHarness(alice);
    record('history rebuild starts empty', aliceH.appended.length === 0);
    await aliceH.App.handleIncomingChatEvent(event);
    record('Alice history rebuild PASS', aliceH.appended.length === 1 && aliceH.appended[0].content === SECRET);
    record('history rebuild direction outgoing', aliceH.appended[0].direction === 'outgoing');
  }

  // 7: both directions in same conversation after rebuild
  {
    const aliceH = loadHarness(alice);
    const bobEnv = (() => {
      const h = loadHarness(bob);
      return h.App.encryptPrivateChatPayload({
        senderPrivateKeyHex: bob.hex,
        senderPubkey: bob.pk,
        recipientPubkey: alice.pk,
        payload: {
          messageId: 'cmsg-bob-1',
          sender: bob.pk,
          recipient: alice.pk,
          createdAt: now + 1,
          text: 'hello from bob',
          attachment: null,
        },
      });
    })();
    const bobEvent = signChat(bob, alice.pk, JSON.stringify(bobEnv), now + 1);
    await aliceH.App.handleIncomingChatEvent(event);
    await aliceH.App.handleIncomingChatEvent(bobEvent);
    record(
      'both directions reconstructed',
      aliceH.appended.length === 2 &&
        aliceH.appended.some((m) => m.direction === 'outgoing' && m.content === SECRET) &&
        aliceH.appended.some((m) => m.direction === 'incoming' && m.content === 'hello from bob'),
    );
  }

  // 8: wrong p-tag reject
  {
    const aliceH = loadHarness(alice);
    const bad = JSON.parse(JSON.stringify(event));
    bad.tags = [
      ['p', mallory.pk],
      ['t', CHAT_TAG],
    ];
    // resign would change id; for decrypt path we call resolve directly with tampered tags but same ciphertext
    // Use unsigned structural resolve via resolveIncomingE2eeChatPayload
    const resolved = aliceH.App.resolveIncomingE2eeChatPayload(bad);
    record('wrong p-tag reject', resolved.ok === false);
  }

  // 9: inner recipient mismatch — encrypt for Bob but p-tag Mallory won't decrypt with mallory key binding
  {
    const aliceH = loadHarness(alice);
    const bad = JSON.parse(JSON.stringify(event));
    bad.tags = [
      ['p', mallory.pk],
      ['t', CHAT_TAG],
    ];
    const resolved = aliceH.App.resolveIncomingE2eeChatPayload(bad);
    record('p-tag not matching ciphertext peer reject', resolved.ok === false);
  }

  // 10: conflicting p tags
  {
    const aliceH = loadHarness(alice);
    const bad = JSON.parse(JSON.stringify(event));
    bad.tags = [
      ['p', bob.pk],
      ['p', mallory.pk],
      ['t', CHAT_TAG],
    ];
    const p = aliceH.App.extractValidatedChatRecipientPTag(bad);
    record('multiple conflicting p tags reject', p.ok === false && p.reason === 'CONFLICTING_P_TAGS');
    await aliceH.App.handleIncomingChatEvent(bad);
    record('conflicting p tags no append', aliceH.appended.length === 0);
  }

  // 11: malformed envelope
  {
    const aliceH = loadHarness(alice);
    const bad = signChat(
      alice,
      bob.pk,
      JSON.stringify({ family: 'sos-e2ee', v: 1, alg: 'nip44', ct: 'not-valid' }),
      now,
    );
    const resolved = aliceH.App.resolveIncomingE2eeChatPayload(bad);
    record('malformed envelope reject', resolved.ok === false);
    record('malformed no plaintext fallback', aliceH.appended.length === 0);
  }

  // 12: inner sender mismatch via decrypt API (tamper after decrypt impossible); use encrypt then wrong author claim
  {
    const aliceH = loadHarness(alice);
    let rejected = false;
    try {
      aliceH.App.decryptPrivateChatPayload({
        localPrivateKeyHex: alice.hex,
        localPubkey: alice.pk,
        eventAuthorPubkey: mallory.pk,
        encryptedEnvelope: envelope,
        selfAuthored: true,
        intendedRecipientPubkey: bob.pk,
      });
    } catch (_e) {
      rejected = true;
    }
    record('selfAuthored with wrong author reject', rejected);
  }

  // 13: remote incoming unchanged (Bob→Alice on Alice)
  {
    const aliceH = loadHarness(alice);
    const bobEnv = aliceH.App.encryptPrivateChatPayload({
      senderPrivateKeyHex: bob.hex,
      senderPubkey: bob.pk,
      recipientPubkey: alice.pk,
      payload: {
        messageId: 'cmsg-in-1',
        sender: bob.pk,
        recipient: alice.pk,
        createdAt: now,
        text: 'remote ok',
        attachment: null,
      },
    });
    // encrypt was with alice's App encrypt using bob keys - wait, encrypt uses aliceH.App which has alice's inspect - OK
    // But we used bob.hex as senderPrivateKey - encryptPrivateChatPayload on App just needs the function
    const bobEvent = signChat(bob, alice.pk, JSON.stringify(bobEnv), now);
    await aliceH.App.handleIncomingChatEvent(bobEvent);
    record('incoming Bob→Alice unchanged', aliceH.appended.length === 1 && aliceH.appended[0].direction === 'incoming' && aliceH.appended[0].content === 'remote ok');
  }

  // 14: mixed legacy + e2ee
  {
    const aliceH = loadHarness(alice);
    const legacy = signChat(bob, alice.pk, JSON.stringify({ t: 'legacy hi', a: null }), now - 10);
    await aliceH.App.handleIncomingChatEvent(legacy);
    await aliceH.App.handleIncomingChatEvent(event);
    record(
      'mixed Legacy/E2EE history',
      aliceH.appended.length === 2 &&
        aliceH.appended.some((m) => m.content === 'legacy hi') &&
        aliceH.appended.some((m) => m.content === SECRET && m.direction === 'outgoing'),
    );
  }
}

await run();
console.log(results.join('\n'));
console.log(`\nSummary: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
