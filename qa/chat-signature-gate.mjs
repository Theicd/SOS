#!/usr/bin/env node
/**
 * Phase 1A: deterministic fail-closed signature gate for relay chat events.
 * Run: node qa/chat-signature-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHAT_SERVICE_PATH = path.join(ROOT, 'chat-service.js');

const CHAT_KIND = 1050;
const DELETE_KIND = 5;
const READ_RECEIPT_KIND = 1051;
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

function cloneEvent(event) {
  return JSON.parse(JSON.stringify(event));
}

function hostVerifyEvent(event) {
  return verifyEvent({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: Array.isArray(event.tags)
      ? event.tags.map((tag) => (Array.isArray(tag) ? tag.map((value) => String(value)) : tag))
      : event.tags,
    content: event.content,
    sig: event.sig,
  });
}

function flipSig(event) {
  const copy = cloneEvent(event);
  const sig = String(copy.sig || '');
  const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
  copy.sig = flipped;
  return copy;
}

function loadHarness(options = {}) {
  const selfSk = options.selfSk || generateSecretKey();
  const peerSk = options.peerSk || generateSecretKey();
  const selfPk = getPublicKey(selfSk);
  const peerPk = getPublicKey(peerSk);
  const warnings = [];
  const appended = [];
  const removed = [];
  const statusUpdates = [];
  const pushes = [];
  const torrentRequests = [];
  const contacts = [];
  const seededMessages = Array.isArray(options.seededMessages) ? options.seededMessages : [];
  let onevent = null;

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
    relayUrls: ['wss://example.invalid'],
    ensureChatContact(pubkey) {
      contacts.push(String(pubkey || ''));
    },
    fetchProfile: async () => ({ name: 'Peer', picture: '' }),
    appendChatMessage(msg) {
      appended.push(msg);
    },
    removeChatMessage(peer, id) {
      removed.push({ peer, id });
    },
    getChatMessages() {
      return seededMessages.slice();
    },
    updateChatMessageStatus(id, status) {
      statusUpdates.push({ id, status });
    },
    getChatLastSyncTs() {
      return 0;
    },
    setChatLastSyncTs() {},
    triggerChatMessagePush(msg) {
      pushes.push(msg);
    },
    deserializeChatMessageContent(rawContent) {
      try {
        const payload = JSON.parse(rawContent);
        if (payload && typeof payload === 'object' && (Object.prototype.hasOwnProperty.call(payload, 't') || Object.prototype.hasOwnProperty.call(payload, 'a'))) {
          return {
            displayText: payload.t || '',
            attachment: payload.a || null,
            hasAttachment: Boolean(payload.a),
          };
        }
      } catch (_err) {}
      return { displayText: rawContent, attachment: null, hasAttachment: false };
    },
    torrentTransfer: {
      handleIncomingRequest(sender, data) {
        torrentRequests.push({ sender, data });
      },
    },
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
  };
  context.window = context;
  context.document = {
    readyState: 'complete',
    addEventListener() {},
    hidden: false,
  };
  context.NostrApp = App;
  context.NostrTools = { verifyEvent: hostVerifyEvent, finalizeEvent, generateSecretKey, getPublicKey };
  context.window.NostrApp = App;
  context.window.NostrTools = context.NostrTools;
  context.window.localStorage = localStorage;

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(CHAT_SERVICE_PATH, 'utf8'), context, { filename: 'chat-service.js' });
  if (typeof App.subscribeToChatEvents !== 'function') {
    throw new Error('chat-service.js did not export subscribeToChatEvents');
  }
  App.subscribeToChatEvents();
  if (typeof onevent !== 'function') {
    throw new Error('pool.subscribeMany did not capture onevent');
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
    context,
    selfPk,
    peerPk,
    selfSk,
    peerSk,
    warnings,
    appended,
    removed,
    statusUpdates,
    pushes,
    torrentRequests,
    contacts,
    seededMessages,
    deliver,
  };
}

function signChat(peerSk, selfPk, content) {
  return cloneEvent(finalizeEvent({
    kind: CHAT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', String(selfPk).toLowerCase()], ['t', CHAT_TAG]],
    content,
  }, peerSk));
}

function signDeletion(peerSk, selfPk, messageId) {
  return cloneEvent(finalizeEvent({
    kind: DELETE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['e', messageId], ['p', String(selfPk).toLowerCase()], ['t', CHAT_TAG]],
    content: '',
  }, peerSk));
}

function signChatWithTags(authorSk, tags, content, kind = CHAT_KIND) {
  return cloneEvent(finalizeEvent({
    kind,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  }, authorSk));
}

function signReadReceipt(peerSk, selfPk, lastReadAt, lastReadMessageId) {
  return cloneEvent(finalizeEvent({
    kind: READ_RECEIPT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', String(selfPk).toLowerCase()], ['t', CHAT_TAG]],
    content: JSON.stringify({
      type: 'chat_read_receipt',
      receiptId: 'rr-test-' + lastReadAt,
      lastReadAt,
      lastReadMessageId: lastReadMessageId || '',
    }),
  }, peerSk));
}

function logsAreSafe(warnings, forbidden) {
  const blob = warnings.join('\n');
  return !forbidden.some((token) => token && blob.includes(token));
}

async function main() {
  const source = fs.readFileSync(CHAT_SERVICE_PATH, 'utf8');
  const oneventIdx = source.indexOf('onevent: (event) => {');
  const verifyInOnevent = source.indexOf('if (!verifyIncomingChatRelayEvent(event))', oneventIdx);
  const recipientInOnevent = source.indexOf('if (!verifyIncomingChatRelayRecipient(event))', oneventIdx);
  const handleInOnevent = source.indexOf('handleIncomingChatEvent(event);', oneventIdx);
  record(
    'source gate sits in relay onevent before handlers',
    oneventIdx >= 0 && verifyInOnevent > oneventIdx && verifyInOnevent < handleInOnevent,
  );
  record(
    'source recipient check sits after signature gate and before handlers',
    recipientInOnevent > verifyInOnevent && recipientInOnevent < handleInOnevent,
  );
  record(
    'source uses NostrTools.verifyEvent',
    source.includes('window.NostrTools') && source.includes('verifyEvent'),
  );

  const chat = loadHarness();
  const validChat = signChat(chat.peerSk, chat.selfPk, 'hello-from-peer');
  record('NostrTools.verifyEvent accepts the signed chat fixture', verifyEvent(cloneEvent(validChat)) === true);
  await chat.deliver(validChat);
  record(
    'A valid signed chat event ACCEPT',
    chat.appended.length === 1 && chat.appended[0].content === 'hello-from-peer' && chat.appended[0].from === chat.peerPk.toLowerCase(),
    'appended=' + chat.appended.length,
  );

  const tampered = cloneEvent(validChat);
  tampered.content = 'tampered-content';
  const beforeTamper = chat.appended.length;
  await chat.deliver(tampered);
  record(
    'B same event after changing content REJECT',
    chat.appended.length === beforeTamper && chat.warnings.some((line) => line.includes('[SO-CALL SECURITY] rejected invalid signed event')),
    'appended=' + chat.appended.length,
  );

  const forgedPubkey = cloneEvent(validChat);
  forgedPubkey.pubkey = chat.selfPk;
  const beforeForgePk = chat.appended.length;
  await chat.deliver(forgedPubkey);
  record(
    'C same event after changing pubkey REJECT',
    chat.appended.length === beforeForgePk,
    'appended=' + chat.appended.length,
  );

  const badSig = flipSig(validChat);
  const beforeBadSig = chat.appended.length;
  await chat.deliver(badSig);
  record(
    'D invalid signature REJECT',
    chat.appended.length === beforeBadSig,
    'appended=' + chat.appended.length,
  );

  const deletion = loadHarness();
  const validDeletion = signDeletion(deletion.peerSk, deletion.selfPk, 'msg-to-delete');
  await deletion.deliver(validDeletion);
  record(
    'E valid deletion event kind 5 ACCEPT',
    deletion.removed.length === 1 && deletion.removed[0].id === 'msg-to-delete',
    'removed=' + deletion.removed.length,
  );

  const forgedDeletion = cloneEvent(validDeletion);
  forgedDeletion.content = 'forged-delete';
  const beforeForgedDel = deletion.removed.length;
  await deletion.deliver(forgedDeletion);
  record(
    'F forged deletion event REJECT',
    deletion.removed.length === beforeForgedDel,
    'removed=' + deletion.removed.length,
  );

  const now = Math.floor(Date.now() / 1000);
  const receipts = loadHarness({
    seededMessages: [{ id: 'out-1', direction: 'outgoing', createdAt: now - 30, status: 'sent' }],
  });
  const validReceipt = signReadReceipt(receipts.peerSk, receipts.selfPk, now, 'out-1');
  await receipts.deliver(validReceipt);
  record(
    'G valid read receipt ACCEPT',
    receipts.statusUpdates.some((row) => row.id === 'out-1' && row.status === 'read'),
    'updates=' + JSON.stringify(receipts.statusUpdates),
  );

  const forgedReceipt = cloneEvent(validReceipt);
  forgedReceipt.content = JSON.stringify({
    type: 'chat_read_receipt',
    receiptId: 'rr-forged',
    lastReadAt: now + 10,
    lastReadMessageId: 'out-1',
  });
  const beforeForgedRr = receipts.statusUpdates.length;
  await receipts.deliver(forgedReceipt);
  record(
    'H forged read receipt REJECT',
    receipts.statusUpdates.length === beforeForgedRr,
    'updates=' + receipts.statusUpdates.length,
  );

  const dc = loadHarness({
    seededMessages: [{ id: 'out-dc', direction: 'outgoing', createdAt: now - 10, status: 'sent' }],
  });
  dc.App.handleIncomingReadReceipt({
    type: 'chat_read_receipt',
    from: dc.peerPk,
    to: dc.selfPk,
    lastReadAt: now,
    receiptId: 'rr-dc',
  });
  record(
    'direct P2P unsigned read receipt still accepted',
    dc.statusUpdates.some((row) => row.id === 'out-dc' && row.status === 'read'),
  );

  const attach = loadHarness();
  const validAttachment = signChat(
    attach.peerSk,
    attach.selfPk,
    JSON.stringify({ t: 'file-note', a: { name: 'note.txt', size: 4, type: 'text/plain' } }),
  );
  await attach.deliver(validAttachment);
  record(
    'valid signed attachment payload still accepted',
    attach.appended.length === 1 && attach.appended[0].attachment && attach.appended[0].attachment.name === 'note.txt',
    'appended=' + attach.appended.length,
  );

  const missingVerifier = loadHarness();
  const validWhenMissing = signChat(missingVerifier.peerSk, missingVerifier.selfPk, 'should-drop');
  missingVerifier.context.NostrTools.verifyEvent = undefined;
  await missingVerifier.deliver(validWhenMissing);
  record(
    'verifier unavailable is fail-closed',
    missingVerifier.appended.length === 0,
  );

  const malformed = loadHarness();
  const beforeMalformed = malformed.appended.length;
  await malformed.deliver(null);
  await malformed.deliver({});
  await malformed.deliver({ kind: CHAT_KIND });
  record(
    'I malformed event REJECT without exception',
    malformed.appended.length === beforeMalformed &&
      !malformed.warnings.some((line) => line.startsWith('onevent-threw')) &&
      malformed.warnings.some((line) => line.includes('[SO-CALL SECURITY] rejected invalid signed event')),
    'appended=' + malformed.appended.length,
  );

  const throwing = loadHarness();
  const validThenThrow = signChat(throwing.peerSk, throwing.selfPk, 'after-throw');
  throwing.context.NostrTools.verifyEvent = () => {
    throw new Error('verify-boom');
  };
  await throwing.deliver(validThenThrow);
  throwing.context.NostrTools.verifyEvent = hostVerifyEvent;
  const validAfterThrow = signChat(throwing.peerSk, throwing.selfPk, 'recovered');
  await throwing.deliver(validAfterThrow);
  record(
    'verifyEvent throw drops the event and does not break the subscription',
    throwing.appended.length === 1 && throwing.appended[0].content === 'recovered' && !throwing.warnings.some((line) => line.startsWith('onevent-threw')),
    'appended=' + throwing.appended.length,
  );

  record(
    'security warnings omit plaintext and key material',
    logsAreSafe(chat.warnings, ['hello-from-peer', 'tampered-content']) &&
      logsAreSafe(deletion.warnings, ['forged-delete']) &&
      logsAreSafe(receipts.warnings, ['rr-forged']),
  );
  record(
    'reject log uses SO-CALL SECURITY prefix',
    chat.warnings.some((line) => /\[SO-CALL SECURITY\] rejected invalid signed event kind=1050 id=/.test(line)),
  );

  const recipient = loadHarness();
  const otherSk = generateSecretKey();
  const otherPk = getPublicKey(otherSk);
  const correctP = signChat(recipient.peerSk, recipient.selfPk, 'phase2-correct-p');
  await recipient.deliver(correctP);
  record(
    'Phase2 A valid signed 1050 with correct p ACCEPT',
    recipient.appended.length === 1 && recipient.appended[0].content === 'phase2-correct-p',
    'appended=' + recipient.appended.length,
  );

  const wrongP = signChat(recipient.peerSk, otherPk, 'phase2-wrong-p');
  const beforeWrongP = recipient.appended.length;
  await recipient.deliver(wrongP);
  record(
    'Phase2 B valid signed 1050 with wrong p REJECT',
    recipient.appended.length === beforeWrongP &&
      recipient.warnings.some((line) => /\[SO-CALL SECURITY\] rejected event for wrong recipient kind=1050 id=/.test(line)),
    'appended=' + recipient.appended.length,
  );

  const missingP = signChatWithTags(recipient.peerSk, [['t', CHAT_TAG]], 'phase2-missing-p');
  const beforeMissingP = recipient.appended.length;
  await recipient.deliver(missingP);
  record(
    'Phase2 C valid signed 1050 with no p REJECT',
    recipient.appended.length === beforeMissingP,
    'appended=' + recipient.appended.length,
  );

  const emptyP = signChatWithTags(recipient.peerSk, [['p', ''], ['t', CHAT_TAG]], 'phase2-empty-p');
  const beforeEmptyP = recipient.appended.length;
  await recipient.deliver(emptyP);
  record(
    'Phase2 D valid signed 1050 with empty p REJECT',
    recipient.appended.length === beforeEmptyP,
    'appended=' + recipient.appended.length,
  );

  const deletionOk = loadHarness();
  const validDeletionP2 = signDeletion(deletionOk.peerSk, deletionOk.selfPk, 'phase2-del-ok');
  await deletionOk.deliver(validDeletionP2);
  record(
    'Phase2 E valid signed kind 5 deletion with p=self ACCEPT',
    deletionOk.removed.length === 1 && deletionOk.removed[0].id === 'phase2-del-ok',
    'removed=' + deletionOk.removed.length,
  );

  const deletionWrong = loadHarness();
  const wrongDeletion = signDeletion(deletionWrong.peerSk, otherPk, 'phase2-del-wrong');
  await deletionWrong.deliver(wrongDeletion);
  record(
    'Phase2 F valid signed kind 5 deletion with wrong p REJECT before deletion handler',
    deletionWrong.removed.length === 0 &&
      deletionWrong.warnings.some((line) => /\[SO-CALL SECURITY\] rejected event for wrong recipient kind=5 id=/.test(line)),
    'removed=' + deletionWrong.removed.length,
  );

  const nowP2 = Math.floor(Date.now() / 1000);
  const receiptOk = loadHarness({
    seededMessages: [{ id: 'out-p2', direction: 'outgoing', createdAt: nowP2 - 30, status: 'sent' }],
  });
  const validReceiptP2 = signReadReceipt(receiptOk.peerSk, receiptOk.selfPk, nowP2, 'out-p2');
  await receiptOk.deliver(validReceiptP2);
  record(
    'Phase2 G valid signed kind 1051 receipt with p=self ACCEPT',
    receiptOk.statusUpdates.some((row) => row.id === 'out-p2' && row.status === 'read'),
    'updates=' + JSON.stringify(receiptOk.statusUpdates),
  );

  const receiptWrong = loadHarness({
    seededMessages: [{ id: 'out-p2-wrong', direction: 'outgoing', createdAt: nowP2 - 30, status: 'sent' }],
  });
  const wrongReceipt = signReadReceipt(receiptWrong.peerSk, otherPk, nowP2, 'out-p2-wrong');
  await receiptWrong.deliver(wrongReceipt);
  record(
    'Phase2 H valid signed kind 1051 receipt with wrong p REJECT before status mutation',
    receiptWrong.statusUpdates.length === 0 &&
      receiptWrong.warnings.some((line) => /\[SO-CALL SECURITY\] rejected event for wrong recipient kind=1051 id=/.test(line)),
    'updates=' + receiptWrong.statusUpdates.length,
  );

  const invalidSigCorrectP = loadHarness();
  const signedCorrectP = signChat(invalidSigCorrectP.peerSk, invalidSigCorrectP.selfPk, 'phase2-bad-sig');
  const badSigCorrectP = flipSig(signedCorrectP);
  await invalidSigCorrectP.deliver(badSigCorrectP);
  record(
    'Phase2 I invalid signature + correct p still rejected by Phase 1',
    invalidSigCorrectP.appended.length === 0 &&
      invalidSigCorrectP.warnings.some((line) => line.includes('[SO-CALL SECURITY] rejected invalid signed event')),
    'appended=' + invalidSigCorrectP.appended.length,
  );

  const selfAuthored = loadHarness();
  const selfEvent = signChat(selfAuthored.selfSk, selfAuthored.peerPk, 'own-echo');
  await selfAuthored.deliver(selfEvent);
  record(
    'Phase2 J self-authored valid event existing behavior unchanged',
    selfAuthored.appended.length === 1 &&
      selfAuthored.appended[0].content === 'own-echo' &&
      selfAuthored.appended[0].direction === 'outgoing' &&
      selfAuthored.appended[0].from === selfAuthored.selfPk.toLowerCase() &&
      selfAuthored.appended[0].to === selfAuthored.peerPk.toLowerCase() &&
      !selfAuthored.warnings.some((line) => line.includes('wrong recipient')),
    'appended=' + JSON.stringify(selfAuthored.appended),
  );

  record(
    'Phase2 recipient warnings omit plaintext',
    logsAreSafe(recipient.warnings, ['phase2-wrong-p', 'phase2-missing-p', 'phase2-empty-p']) &&
      logsAreSafe(deletionWrong.warnings, ['phase2-del-wrong']),
  );

  const schema = loadHarness();
  record(
    '8 verifyIncomingChatRelayPayload is exported',
    typeof schema.App.verifyIncomingChatRelayPayload === 'function',
  );
  record(
    '8 normal text accepted',
    schema.App.verifyIncomingChatRelayPayload('hello') === true,
  );
  const longText = 'ש'.repeat(8000);
  record(
    '8 legitimate long text accepted',
    schema.App.verifyIncomingChatRelayPayload(longText) === true,
  );
  record(
    '8 malformed JSON rejected safely',
    schema.App.verifyIncomingChatRelayPayload('{not-json') === false,
  );
  record(
    '8 huge invalid payload rejected',
    schema.App.verifyIncomingChatRelayPayload('x'.repeat(512 * 1024 + 1)) === false,
  );
  const validAtt = JSON.stringify({
    t: 'pic',
    a: { name: 'photo.jpg', type: 'image/jpeg', size: 1200, url: 'https://example.invalid/a.jpg' },
  });
  record(
    '8 valid attachment metadata accepted',
    schema.App.verifyIncomingChatRelayPayload(validAtt) === true,
  );
  record(
    '8 malformed attachment rejected',
    schema.App.verifyIncomingChatRelayPayload(JSON.stringify({ t: 'x', a: ['nope'] })) === false &&
      schema.App.verifyIncomingChatRelayPayload(JSON.stringify({ t: 'x', a: 'bad' })) === false,
  );

  await schema.deliver(signChat(schema.peerSk, schema.selfPk, 'hello-schema'));
  await schema.deliver(signChat(schema.peerSk, schema.selfPk, longText));
  await schema.deliver(signChat(schema.peerSk, schema.selfPk, validAtt));
  const beforeBad = schema.appended.length;
  const contactsAfterValid = schema.contacts.length;
  await schema.deliver(signChat(schema.peerSk, schema.selfPk, '{not-json'));
  await schema.deliver(signChat(schema.peerSk, schema.selfPk, JSON.stringify({ t: 'x', a: ['nope'] })));
  await schema.deliver(signChat(schema.peerSk, schema.selfPk, 'x'.repeat(512 * 1024 + 1)));
  record(
    '8 no state mutation on invalid chat structures',
    schema.appended.length === beforeBad &&
      schema.contacts.length === contactsAfterValid &&
      schema.appended.some((row) => row.content === 'hello-schema') &&
      schema.appended.some((row) => row.content === longText) &&
      schema.appended.some((row) => row.content === 'pic'),
    'appended=' + schema.appended.length,
  );

  const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=clip.mp4';
  const BLOSSOM = 'https://example.invalid/blossom/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.jpg';
  const DATA_IMG = 'data:image/jpeg;base64,' + 'A'.repeat(40);
  const DATA_AUDIO = 'data:audio/webm;base64,' + 'A'.repeat(40);
  const att = schema.App;

  record('9 normal image accepted', att.verifyIncomingChatAttachment({ name: 'photo.jpg', type: 'image/jpeg', size: 1200, url: BLOSSOM }) === true);
  record('9 normal video accepted', att.verifyIncomingChatAttachment({ name: 'clip.mp4', type: 'video/mp4', size: 5000, url: BLOSSOM }) === true);
  record('9 normal voice message accepted', att.verifyIncomingChatAttachment({ name: 'voice.webm', type: 'audio/webm', duration: 4, dataUrl: DATA_AUDIO }) === true);
  record('9 normal file accepted', att.verifyIncomingChatAttachment({ name: 'note.txt', type: 'text/plain', size: 4 }) === true);
  record('9 valid Blossom attachment accepted', att.verifyIncomingChatAttachment({ name: 'pic.jpg', type: 'image/jpeg', url: BLOSSOM }) === true);
  record('9 valid WebTorrent attachment accepted', att.verifyIncomingChatAttachment({ name: 'clip.mp4', type: 'video/mp4', magnetURI: MAGNET, infoHash: '0123456789abcdef0123456789abcdef01234567', isTorrent: true }) === true);
  record('9 valid inline attachment accepted', att.verifyIncomingChatAttachment({ name: 'photo.jpg', type: 'image/jpeg', dataUrl: DATA_IMG }) === true);

  record('9 malformed attachment object rejected', att.verifyIncomingChatAttachment(['nope']) === false && att.verifyIncomingChatAttachment('x') === false);
  record(
    '9 absurd filename sanitized',
    att.sanitizeIncomingChatFileName('a'.repeat(400) + '.jpg').length <= 180 &&
      !att.sanitizeIncomingChatFileName('a'.repeat(400) + '.jpg').includes('..'),
  );
  record(
    '9 path traversal filename neutralized',
    att.sanitizeIncomingChatFileName('../../etc/passwd') === 'passwd' &&
      att.sanitizeIncomingChatFileName('..\\..\\secret.png') === 'secret.png',
  );
  record(
    '9 dangerous URL scheme rejected',
    att.isSafeIncomingChatResource('javascript:alert(1)') === false &&
      att.isSafeIncomingChatResource('vbscript:msg') === false &&
      att.verifyIncomingChatAttachment({ name: 'x.jpg', type: 'image/jpeg', url: 'javascript:alert(1)' }) === false,
  );
  record(
    '9 invalid duration/type rejected',
    att.verifyIncomingChatAttachment({ name: 'voice.webm', type: 'audio/webm', duration: -1, dataUrl: DATA_AUDIO }) === false &&
      att.verifyIncomingChatAttachment({ name: 'file.bin', type: 'not-a-mime' }) === false,
  );
  record(
    '9 huge metadata rejected',
    att.verifyIncomingChatAttachment({ name: 'x'.repeat(2000), type: 'text/plain' }) === false,
  );
  record(
    '9 malformed magnet rejected',
    att.isValidIncomingMagnetURI('magnet:not-valid') === false &&
      att.verifyIncomingChatAttachment({ name: 'clip.mp4', type: 'video/mp4', magnetURI: 'http://evil.example/x', isTorrent: true }) === false,
  );
  record(
    '9 unsupported impossible field combinations rejected',
    att.verifyIncomingChatAttachment({ name: 'clip.mp4', type: 'video/mp4', isTorrent: true }) === false,
  );

  const codecVoice = { name: 'voice-message.webm', type: 'audio/webm; codecs=opus', duration: 4, size: 1200, dataUrl: DATA_AUDIO };
  record('9 recorded voice MIME with codecs accepted', att.verifyIncomingChatAttachment(codecVoice) === true);
  record('9 recorded voice MIME normalized to essence', codecVoice.type === 'audio/webm');
  record('9 ogg opus voice MIME accepted', att.verifyIncomingChatAttachment({ name: 'voice-message.ogg', type: 'audio/ogg; codecs=opus', duration: 3, dataUrl: DATA_AUDIO }) === true);
  record(
    '9 legacy file+voice name accepted',
    att.verifyIncomingChatAttachment({ name: 'voice-message.webm', type: 'file', duration: 4, url: BLOSSOM }) === true,
  );
  record(
    '9 inspect reports UNSUPPORTED_TYPE',
    att.inspectIncomingChatAttachment({ name: 'file.bin', type: 'not-a-mime' }).reasonCode === 'UNSUPPORTED_TYPE',
  );
  record(
    '9 inspect reports INVALID_SIZE',
    att.inspectIncomingChatAttachment({ name: 'voice.webm', type: 'audio/webm', size: -3 }).reasonCode === 'INVALID_SIZE',
  );
  record('9 image jpeg schema unchanged', att.verifyIncomingChatAttachment({ name: 'photo.jpg', type: 'image/jpeg', size: 206146, url: BLOSSOM }) === true);

  const p9 = loadHarness();
  await p9.deliver(signChat(p9.peerSk, p9.selfPk, JSON.stringify({
    t: 'voice',
    a: { name: 'voice.webm', type: 'audio/webm', duration: 4, dataUrl: DATA_AUDIO },
  })));
  await p9.deliver(signChat(p9.peerSk, p9.selfPk, JSON.stringify({
    t: '',
    a: { name: '../../etc/passwd', type: 'text/plain', size: 4 },
  })));
  const beforePoison = p9.appended.length;
  const torrentsBeforePoison = p9.torrentRequests.length;
  await p9.deliver(signChat(p9.peerSk, p9.selfPk, JSON.stringify({
    t: 'hack',
    a: { name: '<script>x</script>.jpg', type: 'image/jpeg', url: 'javascript:alert(1)' },
  })));
  await p9.deliver(signChat(p9.peerSk, p9.selfPk, JSON.stringify({
    t: 'bad-magnet',
    a: { name: 'clip.mp4', type: 'video/mp4', magnetURI: 'magnet:evil', isTorrent: true },
  })));
  record(
    '9 invalid attachment cannot mutate chat/torrent state',
    p9.appended.length === beforePoison &&
      p9.torrentRequests.length === torrentsBeforePoison &&
      p9.appended.some((row) => row.attachment && row.attachment.type === 'audio/webm') &&
      p9.appended.some((row) => row.attachment && row.attachment.name === 'passwd' && !String(row.attachment.name).includes('..')),
  );
  record(
    '9 dangerous URL omitted from security logs',
    p9.warnings.every((line) => !line.includes('javascript:alert(1)')),
  );
  record(
    '9 rejected attachment logs ATTACHMENT_REJECTED reasonCode',
    p9.warnings.some((line) => line.includes('ATTACHMENT_REJECTED') && line.includes('reasonCode=')),
  );

  const pVoice = loadHarness();
  await pVoice.deliver(signChat(pVoice.peerSk, pVoice.selfPk, JSON.stringify({
    t: '',
    a: { name: 'voice-message.webm', type: 'audio/webm; codecs=opus', duration: 4, size: 8000, dataUrl: DATA_AUDIO, fileId: 'audio-1' },
  })));
  await pVoice.deliver(signChat(pVoice.peerSk, pVoice.selfPk, JSON.stringify({
    t: '',
    a: { name: 'pic.jpg', type: 'image/jpeg', size: 206146, url: BLOSSOM },
  })));
  record(
    '9 codec voice and image both persist',
    pVoice.appended.some((row) => row.attachment && row.attachment.type === 'audio/webm' && row.attachment.name === 'voice-message.webm') &&
      pVoice.appended.some((row) => row.attachment && row.attachment.type === 'image/jpeg' && row.attachment.size === 206146),
  );

  console.log(results.join('\n'));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
