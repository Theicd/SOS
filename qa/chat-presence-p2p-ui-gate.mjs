#!/usr/bin/env node
/**
 * Stage 5C.1 — presence UI + P2P transport indicators.
 * Static + lightweight presence format checks. No network.
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

const ui = read('chat-ui.js');
const presence = read('chat-presence.js');
const state = read('chat-state.js');
const service = read('chat-service.js');
const css = read('styles/chat.css');
const audio = read('chat-audio-player.js');
const index = read('index.html');
const dc = read('chat-p2p-datachannel.js');

record('1 header no longer writes P2P ישיר into status line',
  !/el\.innerHTML = dcOn[\s\S]{0,200}?P2P ישיר/.test(ui)
  && /updateConversationPresence/.test(ui)
  && !/⚡ P2P ישיר/.test(ui));
record('2 header no longer writes דרך שרת into status line',
  !/דרך שרת/.test(ui));
record('3 DC connected adds green lamp to conversation avatar',
  /chat-conversation__avatar--p2p/.test(ui)
  && /chat-conversation__avatar--p2p::after/.test(css)
  && /updateConversationP2PIndicator/.test(ui));
record('4 DC disconnect removes header lamp',
  /classList\.toggle\('chat-conversation__avatar--p2p', on\)/.test(ui));

const box = {
  console, setTimeout, clearTimeout, clearInterval, setInterval,
  document: {
    hidden: false,
    visibilityState: 'visible',
    readyState: 'complete',
    addEventListener() {},
  },
  localStorage: {
    _d: {},
    getItem(k) { return this._d[k] || null; },
    setItem(k, v) { this._d[k] = String(v); },
  },
  Map, Set, Date, Math, JSON, Object, Array, String, Number, CustomEvent,
};
box.window = box;
box.globalThis = box;
vm.runInNewContext(presence, box, { filename: 'chat-presence.js' });
const App = box.window.NostrApp;
App.publicKey = 'a'.repeat(64);
App.privateKey = 'b'.repeat(64);

const onlineFmt = App.formatChatPresence({ online: true, lastSeenAt: Math.floor(Date.now() / 1000) });
record('5 online presence shows מחובר green',
  onlineFmt.text === 'מחובר' && onlineFmt.tone === 'online'
  && App.presenceToneClass('online') === 'chat-conversation__status--online'
  && /chat-conversation__status--online/.test(css)
  && /#25e47a/.test(css));

const recentAt = Math.floor(Date.now() / 1000) - 3600;
const recentFmt = App.formatChatPresence({ online: false, lastSeenAt: recentAt });
record('6 fresh offline lastSeen <=24h blue',
  recentFmt.tone === 'recent'
  && App.presenceToneClass('recent') === 'chat-conversation__status--recent'
  && /#00afff/.test(css)
  && /נראה לאחרונה/.test(recentFmt.text));

const olderAt = Math.floor(Date.now() / 1000) - (3 * 86400);
const olderFmt = App.formatChatPresence({ online: false, lastSeenAt: olderAt });
record('7 1–7 day lastSeen yellow',
  olderFmt.tone === 'older'
  && App.presenceToneClass('older') === 'chat-conversation__status--older'
  && /#ffc928/.test(css));

const staleAt = Math.floor(Date.now() / 1000) - (10 * 86400);
const staleFmt = App.formatChatPresence({ online: false, lastSeenAt: staleAt });
record('8 >=7 day lastSeen red',
  staleFmt.tone === 'stale'
  && App.presenceToneClass('stale') === 'chat-conversation__status--stale'
  && /#ff304f/.test(css));

const unknownFmt = App.formatChatPresence({ online: false, lastSeenAt: 0 });
record('9 unknown presence muted',
  unknownFmt.tone === 'unknown'
  && App.presenceToneClass('unknown') === 'chat-conversation__status--unknown'
  && /#8fa2b7/.test(css));

record('10 Native/Relay background alone cannot keep user online',
  /isUiForegroundActive/.test(presence)
  && /document\.hidden/.test(presence)
  && /publishPresenceToPeers\(false\)/.test(presence));

App.setChatPresence('c'.repeat(64), {
  online: true,
  lastSeenAt: Math.floor(Date.now() / 1000),
  lastPresenceAt: Date.now() - (App.PRESENCE_ONLINE_TTL_MS + 1000),
});
const expired = App.getChatPresence('c'.repeat(64));
record('11 stale online state expires by TTL',
  App.PRESENCE_ONLINE_TTL_MS === 90000
  && App.PRESENCE_HEARTBEAT_MS === 45000
  && expired.online === false);

record('12 direct P2P message indicator ON',
  /buildMessageTransportIndicatorHtml/.test(ui)
  && /getChatMessageTransport/.test(state)
  && /transport:\s*'DC'/.test(service));

record('13 Relay text indicator OFF',
  /String\(transport \|\| ''\)\.toUpperCase\(\) !== 'DC'/.test(ui)
  || /!== 'DC'\) return ''/.test(ui));

record('14 encrypted Blossom TXT indicator OFF',
  !/encrypted-media[\s\S]{0,80}p2p-lamp/.test(ui)
  && /getChatMessageTransport/.test(state));

record('15 encrypted Blossom PDF indicator OFF',
  /inferMessageTransport/.test(state)
  && /message\.p2p \|\| String\(message\.id/.test(state));

record('16 direct P2P image/file indicator ON when DC provenance',
  /transport:\s*'DC'/.test(read('chat-p2p-file.js'))
  && /buildFileCardMetaRowHtml\([\s\S]*message/.test(ui));

record('17 historical P2P lamp does not depend on current DC',
  /getChatMessageTransport\(message\)/.test(ui)
  && !/buildMessageTransportIndicatorHtml[\s\S]{0,200}isPeerP2PConnected/.test(ui));

record('18 historical Relay message does not gain lamp after DC connects',
  /buildMessageTransportIndicatorHtml/.test(ui)
  && /transport provenance|getChatMessageTransport|message\.transport/.test(state + ui));

record('19 P2P message lamp survives state restore',
  /stampMessageTransport|message\.transport/.test(state)
  && /transport:\s*'DC'/.test(dc));

record('20 READ checks still work',
  /buildChatMessageStatusHtml/.test(ui)
  && /chat-message__status--read/.test(ui)
  && /applyIncomingReadReceipt/.test(state));

record('21 document READ still works',
  /getReceiptBoundaryId/.test(state)
  && /logicalMessageId/.test(state));

record('22 Stage 5A voice durability unchanged',
  /VOICE_SOURCE_BLOSSOM_E2EE/.test(audio)
  && /resolveDurableVoicePlayback/.test(audio));

record('23 Stage 5B read receipt gates still referenced',
  fs.existsSync(path.join(ROOT, 'qa/chat-read-receipt-gate.mjs'))
  && /READ_RECEIPT_KIND/.test(service));

record('presence kind 1054 unused dedicated',
  /PRESENCE_KIND = 1054/.test(presence)
  && /PRESENCE_KIND/.test(service)
  && !/\b1054\b/.test(read('market-dashboard.js')));

record('presence loaded in index/videos',
  /chat-presence\.js/.test(index)
  && /chat-presence\.js/.test(read('videos.html')));

record('DC presence handler',
  /chat_presence/.test(dc));

record('message lamp CSS 6px',
  /\.chat-message__p2p-lamp[\s\S]{0,120}width:\s*6px/.test(css));

console.log(results.join('\n'));
console.log(
  fail
    ? 'CHAT_PRESENCE_P2P_UI_GATE FAIL (' + pass + ' passed, ' + fail + ' failed)'
    : 'CHAT_PRESENCE_P2P_UI_GATE PASS (' + pass + ' passed, 0 failed)'
);
process.exit(fail ? 1 : 0);
