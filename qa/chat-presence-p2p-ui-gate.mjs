#!/usr/bin/env node
/**
 * Stage 5C.1b — conversation-view presence + circular avatar + strict P2P provenance.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
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

const presenceSrc = read('chat-presence.js');
const stateSrc = read('chat-state.js');
const uiSrc = read('chat-ui.js');
const css = read('styles/chat.css');
const waCss = read('styles/chat-whatsapp-theme.css');
const mainKt = read('android-shell/app/src/main/java/com/sos010/app/MainActivity.kt');
const serviceSrc = read('chat-service.js');

const box = {
  console, setTimeout, clearTimeout, clearInterval, setInterval,
  document: { hidden: false, visibilityState: 'visible', readyState: 'complete', addEventListener() {} },
  localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); } },
  Map, Set, Date, Math, JSON, Object, Array, String, Number, CustomEvent,
};
box.window = box;
box.globalThis = box;
vm.runInNewContext(presenceSrc, box, { filename: 'chat-presence.js' });
const App = box.window.NostrApp;
App.publicKey = 'a'.repeat(64);
App.privateKey = 'b'.repeat(64);

const peerA = 'b'.repeat(64);
const peerC = 'c'.repeat(64);
let viewedPeer = '';
App.getChatPresenceViewedPeer = () => viewedPeer;

const NOW = Math.floor(Date.now() / 1000);

// A: exact conversation open → מחובר (no DC involved)
viewedPeer = peerA;
App.applyIncomingChatPresence({
  type: 'chat_presence', from: peerA, to: App.publicKey,
  online: true, viewing: true, lastSeenAt: NOW, sentAt: NOW,
});
record('A exact conversation open shows מחובר',
  App.getChatPresence(peerA).online === true
  && App.formatChatPresence(peerA).text === 'מחובר'
  && App.formatChatPresence(peerA).tone === 'online');

// B: DC is irrelevant to presence
record('B presence independent of DC state markers',
  /getChatPresenceViewedPeer/.test(presenceSrc)
  && /updateConversationP2PIndicator/.test(uiSrc)
  && !/getChatPresence[\s\S]{0,200}isConnected/.test(presenceSrc)
  && !/online\s*=\s*.*isConnected/.test(presenceSrc));

// C: switch conversation → offline for A
App.applyIncomingChatPresence({
  type: 'chat_presence', from: peerA, to: App.publicKey,
  online: false, viewing: false, lastSeenAt: NOW, sentAt: NOW + 1,
});
record('C leave conversation → last seen now',
  App.getChatPresence(peerA).online === false
  && App.formatChatPresence(peerA).text === 'נראה לאחרונה עכשיו');

// D: native pause event
record('D sos-native-pause from MainActivity + JS listener',
  /sos-native-pause/.test(mainKt)
  && /sos-native-pause/.test(presenceSrc)
  && /leaveAllConversationViewing\('native-pause'\)|onNativePause/.test(presenceSrc));

// E: stale Relay online=true 10 minutes ago
const tenMinAgo = NOW - 600;
App.applyIncomingChatPresence({
  type: 'chat_presence', from: peerC, to: App.publicKey,
  online: true, viewing: true, lastSeenAt: tenMinAgo, sentAt: tenMinAgo,
});
const stale = App.getChatPresence(peerC);
const staleFmt = App.formatChatPresence(peerC);
record('E stale Relay online not מחובר',
  stale.online === false
  && /נראה לאחרונה לפני 10 דקות/.test(staleFmt.text));

// F: out-of-order older online ignored
App.applyIncomingChatPresence({
  type: 'chat_presence', from: peerA, to: App.publicKey,
  online: false, viewing: false, lastSeenAt: NOW + 5, sentAt: NOW + 5,
});
App.applyIncomingChatPresence({
  type: 'chat_presence', from: peerA, to: App.publicKey,
  online: true, viewing: true, lastSeenAt: NOW + 4, sentAt: NOW + 4,
});
record('F out-of-order older online ignored',
  App.getChatPresence(peerA).online === false);

// G/H: no broadcast to all contacts
record('G/H heartbeat only active viewing peer',
  !/getChatContacts/.test(presenceSrc)
  && !/MAX_HEARTBEAT_PEERS/.test(presenceSrc)
  && /getActiveViewingPeer|getChatPresenceViewedPeer/.test(presenceSrc)
  && /setChatPresenceViewing/.test(presenceSrc));

record('I P2P lamp independent of presence',
  /updateConversationP2PIndicator/.test(uiSrc)
  && /isPeerP2PConnected/.test(uiSrc)
  && !/getChatPresence[\s\S]{0,80}isPeerP2PConnected/.test(uiSrc));

// Transport helpers via state source assertions + lightweight eval of function body
vm.runInNewContext(stateSrc, {
  console, setTimeout: () => 1, clearTimeout() {}, clearInterval() {}, setInterval() {},
  document: { addEventListener() {}, readyState: 'loading' },
  Map, Set, Date, Math, JSON, Object, Array, String, Number,
  window: {}, globalThis: {},
}, { filename: 'chat-state.js' });
// state may not export without window.NostrApp - the IIFE sets window.NostrApp
const stateBox = { console, setTimeout: () => 1, clearTimeout() {}, clearInterval() {}, setInterval() {},
  document: { addEventListener() {}, readyState: 'loading' },
  Map, Set, Date, Math, JSON, Object, Array, String, Number };
stateBox.window = {};
stateBox.globalThis = stateBox;
vm.runInNewContext(stateSrc, stateBox, { filename: 'chat-state.js' });
const StateApp = stateBox.window.NostrApp;
StateApp.publicKey = 'a'.repeat(64);

record('J Relay/Blossom TXT no P2P lamp',
  StateApp.getChatMessageTransport({
    id: 'nostr1', source: 'NOSTR', transport: 'NOSTR',
    attachment: { type: 'encrypted-media', resource: { transport: 'blossom' } },
  }) === 'NOSTR'
  && StateApp.getChatMessageTransport({
    id: 'p2p-old-attempt', p2p: true, source: 'NOSTR',
    attachment: { type: 'encrypted-media', resource: { transport: 'blossom' } },
  }) === 'NOSTR');

record('K direct DC TXT lamp ON',
  StateApp.getChatMessageTransport({ id: 'p2p-send-1', p2p: true, transport: 'DC' }) === 'DC');

record('L historical Relay never becomes DC',
  StateApp.getChatMessageTransport({ id: 'abc', transport: 'NOSTR' }) === 'NOSTR'
  && StateApp.getChatMessageTransport({ id: 'abc', source: 'NOSTR' }) === 'NOSTR');

record('M historical DC keeps DC',
  StateApp.getChatMessageTransport({ id: 'p2p-x', transport: 'DC' }) === 'DC'
  && StateApp.getChatMessageTransport({ id: 'p2p-send-f1', p2p: true }) === 'DC');

record('N avatar stays circular with P2P lamp',
  /\.chat-conversation__avatar img[\s\S]{0,80}border-radius:\s*inherit/.test(css)
  && /\.chat-conversation__avatar img[\s\S]{0,80}border-radius:\s*inherit/.test(waCss)
  && /\.chat-conversation__avatar--p2p[\s\S]{0,120}overflow:\s*visible/.test(css)
  && !/\.chat-conversation__avatar--p2p[\s\S]{0,80}border-radius:\s*0/.test(css)
  && /\.chat-panel \.chat-conversation__avatar[\s\S]{0,120}overflow:\s*visible/.test(css));

record('relay outgoing stamped NOSTR',
  /transport:\s*'NOSTR'/.test(serviceSrc)
  && /source:\s*'NOSTR'/.test(serviceSrc));

record('viewing false immediate offline',
  /viewing:\s*on/.test(presenceSrc) || /viewing: on/.test(presenceSrc)
  || /viewing: viewing === true/.test(presenceSrc)
  || /viewingFlag/.test(presenceSrc));

record('sender sentAt authoritative for freshness',
  /lastPresenceAt: sentMs/.test(presenceSrc)
  && /ageMs <= ONLINE_TTL_MS/.test(presenceSrc)
  && !/lastPresenceAt: online \? Date\.now\(\)/.test(presenceSrc));

console.log(results.join('\n'));
console.log(
  fail
    ? 'CHAT_PRESENCE_P2P_UI_GATE FAIL (' + pass + ' passed, ' + fail + ' failed)'
    : 'CHAT_PRESENCE_P2P_UI_GATE PASS (' + pass + ' passed, 0 failed)'
);
process.exit(fail ? 1 : 0);
