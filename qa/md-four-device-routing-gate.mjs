#!/usr/bin/env node
/**
 * Four-device chat routing.
 * Reproduces e4796fd1: a linked desktop's own send to another account
 * must stay outgoing in that account's conversation.
 * Reproduces the text fanout gap: ordinary text uses the same device copies as media.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const A = '11'.repeat(32);
const B = '22'.repeat(32);
const DA = '33'.repeat(32);
const DB = '44'.repeat(32);
const DA2 = '55'.repeat(32);
const ENC = '66'.repeat(32);
const ATTACKER = '77'.repeat(32);
const ATTACKER_DEVICE = '88'.repeat(32);
const VICTIM = '99'.repeat(32);
const REVOKED = 'ab'.repeat(32);

let failed = 0;
function check(name, ok) {
  if (!ok) failed += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
}

const chat = read('chat-service.js');
const session = read('sos-account-session.js');
const state = read('chat-state.js');
check('e4796fd1 override branch is gone', !chat.includes('senderAccount && senderAccount !== sender && sender !== accountUser'));
check('classification is shared', chat.includes('function classifyChatDelivery') && chat.includes('normalizedMessage.routeKind = route.kind'));
check('dedup returns before a second conversation', chat.includes('[CHAT/E2EE] self-echo deduped') && /if \(selfEchoDeduped\) \{[\s\S]{0,500}return;/.test(chat));
check('text fanout is not media-only', chat.includes('FANOUT_ALL_LOGICAL') && !/attachment\.type === 'encrypted-media'[\s\S]{0,180}publishAuthorizedDeviceCopies\(/.test(chat));
check('linked sender fans out without Root K', chat.includes('async function publishDelegatedDeviceCopies') && chat.includes('deviceCopy: true'));
check('D_sign is the chat recipient', session.includes("code: 'D_ENC_NOT_CHAT_RECIPIENT'") && session.includes('deliverTo = deviceCopy ? devicePub'));
check('false self row is removed only when the external copy exists', state.includes('SKIP_FALSE_SELF') && state.includes('RECONCILE_FALSE_SELF') && !state.includes('conversations.delete(selfKey)'));
check('phone pulls account-addressed copies', chat.includes('async function pullRecentAccountChat') && chat.includes('ACCOUNT_CHAT_PULL') && /function subscribeToChatEvents\(\) \{[\s\S]{0,1200}pullRecentAccountChat\(/.test(chat));

function loadChat(sessionExtra) {
  const appended = [];
  const logs = [];
  const App = {
    _chatServiceBootstrapped: true,
    publicKey: A,
    relayUrls: ['wss://example.invalid'],
    chatState: { contacts: new Map() },
    pool: { publish() { return [Promise.resolve()]; }, subscribeMany() { return { close() {} }; } },
    getAccountSession() {
      return { role: 'LINKED_DEVICE', verified: true, deviceSignPub: DA, accountP: A };
    },
    ensureChatContact() {},
    fetchProfile: async () => ({ name: 'Peer' }),
    appendChatMessage(msg) { appended.push(msg); },
    getChatMessages(peer) {
      const p = String(peer || '').toLowerCase();
      const self = String(App.publicKey || '').toLowerCase();
      return appended.filter((m) => {
        const from = String(m.from || '').toLowerCase();
        const to = String(m.to || '').toLowerCase();
        const keyPeer = from === self ? to : from;
        return keyPeer === p;
      });
    },
    isSecureChatReady() { return true; },
    getSecureChatGateState() { return 'READY'; },
  };
  const context = {
    console: {
      log(...args) { logs.push(args.map(String).join(' ')); },
      warn(...args) { logs.push(args.map(String).join(' ')); },
      error(...args) { logs.push(args.map(String).join(' ')); },
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    btoa(v) { return Buffer.from(String(v), 'utf8').toString('base64'); },
    atob(v) { return Buffer.from(String(v), 'base64').toString('utf8'); },
    navigator: { onLine: true },
    document: { readyState: 'complete', hidden: false, addEventListener() {}, getElementById() { return null; }, createElement() { return { style: {} }; } },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  };
  context.window = context;
  context.NostrApp = App;
  context.SosAccountSession = Object.assign({
    verifyDelegatedEvent: async () => ({ ok: true, accountP: A }),
    canonicalPeer: async (pk) => String(pk || '').toLowerCase(),
    decryptForLinkedDevice: async (_event, _env, _self, _peer) => ({
      ok: true,
      payload: { messageId: 'logical-e4796fd1', text: 'שלום', sender: DA, recipient: B, createdAt: Math.floor(Date.now() / 1000), attachment: null },
    }),
    listAuthorizedDevices: async () => [],
    delegatedChatEncrypt: async () => ({ ok: false, code: 'UNSTUBBED' }),
  }, sessionExtra || {});
  vm.createContext(context);
  vm.runInContext(read('chat-service.js'), context, { filename: 'chat-service.js' });
  return { App, appended, logs, context };
}

function envelopeEvent(id, author, recipient, extraTags, createdAt) {
  return {
    id,
    pubkey: author,
    kind: 1050,
    created_at: createdAt || Math.floor(Date.now() / 1000),
    content: JSON.stringify({ family: 'sos-e2ee', v: 1, alg: 'nip44', ct: 'ciphertext-not-plaintext' }),
    tags: [['p', recipient], ['t', 'yalachat'], ['sos-md3', '{}']].concat(extraTags || []),
    sig: 'ab'.repeat(64),
  };
}

const h = loadChat();
const e4796 = h.App.classifyChatDelivery({
  accountUser: A,
  devicePub: DA,
  onDevice: true,
  sender: DA,
  senderAccount: A,
  recipient: B,
  recipientAccount: B,
  selfAuthored: true,
  syncVerified: true,
  ownSync: false,
  inboundSync: false,
  deviceCopy: false,
});
check('e4796fd1 stays outgoing to the external account', e4796 && e4796.kind === 'OUTGOING_TO_EXTERNAL_ACCOUNT' && e4796.direction === 'outgoing' && e4796.peer === B && e4796.from === A && e4796.to === B);
check('e4796fd1 is not a self conversation', !(e4796 && e4796.from === A && e4796.to === A));

const trueSelf = h.App.classifyChatDelivery({
  accountUser: A,
  devicePub: DA,
  onDevice: true,
  sender: DA,
  senderAccount: A,
  recipient: A,
  recipientAccount: A,
  selfAuthored: true,
  syncVerified: true,
});
check('real self chat is both logical accounts', trueSelf && trueSelf.kind === 'SELF_CONVERSATION' && trueSelf.from === A && trueSelf.to === A && trueSelf.direction === 'outgoing');

const siblingOnly = h.App.classifyChatDelivery({
  accountUser: A,
  devicePub: DA,
  onDevice: true,
  sender: DA2,
  senderAccount: A,
  recipient: DA,
  recipientAccount: A,
  selfAuthored: false,
  syncVerified: false,
  deviceCopy: true,
});
check('same-account device key is not inferred as self chat', siblingOnly == null);

const mutated = h.App.classifyChatDelivery({
  accountUser: B,
  devicePub: DB,
  onDevice: true,
  sender: ATTACKER_DEVICE,
  senderAccount: ATTACKER,
  recipient: DB,
  recipientAccount: DB,
  syncPeerAccount: VICTIM,
  ownSync: true,
  syncVerified: false,
  selfAuthored: false,
  deviceCopy: true,
});
check('unverified sync-peer cannot retarget the conversation', mutated && mutated.peer === ATTACKER && mutated.peer !== VICTIM && mutated.kind !== 'SELF_CONVERSATION');

const incomingCopy = h.App.classifyChatDelivery({
  accountUser: B,
  devicePub: DB,
  onDevice: true,
  sender: DA,
  senderAccount: A,
  recipient: DB,
  recipientAccount: DB,
  selfAuthored: false,
  deviceCopy: true,
  syncVerified: true,
});
check('recipient desktop copy is incoming from the sender account', incomingCopy && incomingCopy.kind === 'INCOMING_DEVICE_COPY' && incomingCopy.direction === 'incoming' && incomingCopy.peer === A && incomingCopy.to === B);

await h.App.handleIncomingChatEvent(envelopeEvent('e4796fd1' + 'ab'.repeat(28), DA, B));
check('handler files e4796fd1 once as outgoing', h.appended.length === 1 && h.appended[0].direction === 'outgoing' && h.appended[0].to === B && h.appended[0].from === A && h.appended[0].routeKind === 'OUTGOING_TO_EXTERNAL_ACCOUNT');
check('handler does not append a false self message', h.appended.every((m) => !(m.from === A && m.to === A && m.direction === 'incoming')));
const beforeReplay = h.appended.length;
await h.App.handleIncomingChatEvent(envelopeEvent('e4796fd1' + 'ab'.repeat(28), DA, B));
check('replay of the same logical message does not append again', h.appended.length === beforeReplay && h.logs.some((line) => line.includes('self-echo deduped')));

h.appended.length = 0;
h.context.SosAccountSession.decryptForLinkedDevice = async () => ({
  ok: true,
  payload: { messageId: 'logical-same-text-2', text: 'שלום', sender: DA, recipient: B, createdAt: Math.floor(Date.now() / 1000), attachment: null },
});
await h.App.handleIncomingChatEvent(envelopeEvent('bbbb' + 'cd'.repeat(30), DA, B));
check('same text with a different logical id is kept', h.appended.length === 1 && h.appended[0].logicalMessageId === 'logical-same-text-2');

h.appended.length = 0;
h.context.SosAccountSession.decryptForLinkedDevice = async () => ({
  ok: true,
  payload: { messageId: 'logical-self-1', text: 'לעצמי', sender: DA, recipient: A, createdAt: Math.floor(Date.now() / 1000), attachment: null },
});
await h.App.handleIncomingChatEvent(envelopeEvent('self' + '11'.repeat(30), DA, A));
check('explicit self send stays in the self conversation', h.appended.length === 1 && h.appended[0].routeKind === 'SELF_CONVERSATION' && h.appended[0].from === A && h.appended[0].to === A && h.appended[0].direction === 'outgoing');

const other = loadChat();
other.App.publicKey = B;
other.App.getAccountSession = () => ({ role: 'LINKED_DEVICE', verified: true, deviceSignPub: DB, accountP: B });
await other.App.handleIncomingChatEvent(envelopeEvent('self' + '11'.repeat(30), DA, A));
check('the other account does not receive the self conversation', other.appended.length === 0);

other.context.SosAccountSession.verifyDelegatedEvent = async () => ({ ok: false, code: 'BAD_DELEGATION' });
await other.App.handleIncomingChatEvent(envelopeEvent('forged' + '22'.repeat(29), ATTACKER_DEVICE, DB));
check('forged MD3 is dropped', other.appended.length === 0);

other.context.SosAccountSession.verifyDelegatedEvent = async () => ({ ok: true, accountP: ATTACKER });
other.context.SosAccountSession.decryptForLinkedDevice = async () => ({
  ok: true,
  payload: { messageId: 'logical-mutated', text: 'שלום', sender: ATTACKER_DEVICE, recipient: DB, createdAt: Math.floor(Date.now() / 1000), attachment: null },
});
await other.App.handleIncomingChatEvent(envelopeEvent('mutated1' + '33'.repeat(28), ATTACKER_DEVICE, DB, [['t', 'sos-own-sync'], ['sync-peer', VICTIM]]));
check('mutated sync-peer stays on the attacker account', other.appended.length === 1 && other.appended[0].peer !== VICTIM && other.appended[0].from === ATTACKER && other.appended[0].to === B);

const fan = loadChat({
  listAuthorizedDevices: async (account) => {
    if (account === B) {
      return [
        { deviceSignPub: DB, deviceEncPub: ENC },
        { deviceSignPub: ENC, deviceEncPub: ENC },
        { deviceSignPub: REVOKED, deviceEncPub: 'cd'.repeat(32) },
      ];
    }
    return [
      { deviceSignPub: DA, deviceEncPub: 'de'.repeat(32) },
      { deviceSignPub: DA2, deviceEncPub: 'ef'.repeat(32) },
    ];
  },
});
const encrypts = [];
fan.context.SosAccountSession.listAuthorizedDevices = fan.context.SosAccountSession.listAuthorizedDevices;
fan.context.SosAccountSession.delegatedChatEncrypt = async (peer, text, id, extra) => {
  encrypts.push({ peer, text, id, extra: extra || {} });
  return { ok: true, event: { id: 'ev' + encrypts.length, created_at: Math.floor(Date.now() / 1000), pubkey: DA } };
};
fan.context.SosAccountSession.listAuthorizedDevices = async (account) => {
  if (account === B) {
    return [{ deviceSignPub: DB, deviceEncPub: ENC }];
  }
  return [
    { deviceSignPub: DA, deviceEncPub: 'de'.repeat(32) },
    { deviceSignPub: DA2, deviceEncPub: 'ef'.repeat(32) },
    { deviceSignPub: ENC, deviceEncPub: ENC },
  ];
};
const sent = await fan.App.publishChatMessage(B, 'text-e4796fd1');
const copies = encrypts.filter((row) => row.extra && row.extra.deviceCopy === true);
check('text publish reaches the recipient device', sent && sent.ok === true && copies.some((row) => row.extra.devicePub === DB && row.text === 'text-e4796fd1' && row.id));
check('text publish syncs the sender sibling', copies.some((row) => row.extra.devicePub === DA2 && row.extra.mirror === 'outgoing' && row.extra.devicePub !== row.extra.deviceEncPub));
check('D_enc is not used as the chat recipient', copies.every((row) => row.extra.devicePub !== ENC && row.extra.devicePub !== row.extra.deviceEncPub));
check('revoked device is absent from the directory result', copies.every((row) => row.extra.devicePub !== REVOKED));
check('linked text fanout does not require the primary signer', sent.deviceCopies >= 1 && !fan.App.SosCryptoSigner);

function loadState() {
  const App = { _chatStateBootstrapped: true, publicKey: A, deletedChatMessageIds: new Set() };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: { readyState: 'complete', addEventListener() {}, getElementById() { return null; } },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    indexedDB: undefined,
  };
  context.window = context;
  context.NostrApp = App;
  vm.createContext(context);
  vm.runInContext(read('chat-state.js'), context, { filename: 'chat-state.js' });
  return App;
}

const stateApp = loadState();
const now = Math.floor(Date.now() / 1000);
stateApp.appendChatMessage({ id: 'ext-1', from: A, to: B, content: 'שלום', createdAt: now, direction: 'outgoing', logicalMessageId: 'L-external' });
stateApp.appendChatMessage({ id: 'false-1', from: A, to: A, content: 'שלום', createdAt: now, direction: 'incoming', logicalMessageId: 'L-external' });
stateApp.appendChatMessage({ id: 'self-ok', from: A, to: A, content: 'לעצמי', createdAt: now, direction: 'outgoing', logicalMessageId: 'L-self' });
stateApp.appendChatMessage({ id: 'self-same-text', from: A, to: A, content: 'שלום', createdAt: now, direction: 'outgoing', logicalMessageId: 'L-self-same-text' });
const selfRows = stateApp.getChatMessages(A);
const externalRows = stateApp.getChatMessages(B);
check('false self row is not stored beside the external copy', selfRows.every((m) => m.logicalMessageId !== 'L-external'));
check('external copy is kept', externalRows.length === 1 && externalRows[0].content === 'שלום' && externalRows[0].logicalMessageId === 'L-external');
check('true self chat is preserved', selfRows.some((m) => m.logicalMessageId === 'L-self' && m.content === 'לעצמי'));
check('same text in the real self chat is preserved', selfRows.some((m) => m.logicalMessageId === 'L-self-same-text'));

stateApp.appendChatMessage({ id: 'false-first', from: A, to: A, content: 'voice', createdAt: now, direction: 'incoming', logicalMessageId: 'L-voice', attachment: { type: 'encrypted-media', name: 'voice.webm' } });
check('unproven self row is retained', stateApp.getChatMessages(A).some((m) => m.id === 'false-first' && m.attachment && m.attachment.name === 'voice.webm'));
stateApp.appendChatMessage({ id: 'voice-ext', from: A, to: B, content: 'voice', createdAt: now, direction: 'outgoing', logicalMessageId: 'L-voice', attachment: { type: 'encrypted-media', name: 'voice.webm' } });
check('proven false self row is removed without deleting the voice', !stateApp.getChatMessages(A).some((m) => m.logicalMessageId === 'L-voice') && stateApp.getChatMessages(B).some((m) => m.id === 'voice-ext' && m.attachment && m.attachment.name === 'voice.webm'));
check('self conversation still has the real self message', stateApp.getChatMessages(A).some((m) => m.logicalMessageId === 'L-self'));

const phone = loadChat();
phone.App.getAccountSession = () => ({ role: 'PRIMARY_ACCOUNT', verified: true, accountP: A });
let phoneFilter = null;
phone.App.pool.querySync = async (_relays, filter) => {
  phoneFilter = filter;
  return [];
};
await phone.App.pullRecentAccountChat();
check('primary pull asks for the account', !!(phoneFilter && Array.isArray(phoneFilter['#p']) && phoneFilter['#p'][0] === A && phoneFilter['#t'][0] === 'yalachat'));

const desktop = loadChat();
let desktopFilter = null;
desktop.App.pool.querySync = async (_relays, filter) => {
  desktopFilter = filter;
  return [];
};
await desktop.App.pullRecentAccountChat();
check('desktop pull asks for the device key', !!(desktopFilter && Array.isArray(desktopFilter['#p']) && desktopFilter['#p'][0] === DA));

if (failed) {
  console.log('STATUS=FAIL failed=' + failed);
  process.exit(1);
}
console.log('STATUS=PASS_ROUTING_REGRESSION');
