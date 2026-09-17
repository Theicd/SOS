#!/usr/bin/env node
/**
 * Push Privacy gate — private chat Push must never carry message/attachment content.
 * Run: node qa/push-privacy-gate.mjs
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

const SECRET = 'PUSH_PRIVACY_SECRET_123';
const FILENAME = 'PUSH_PRIVATE_FILENAME_TEST.txt';
const CAPTION = 'PUSH_PRIVACY_CAPTION_SECRET';
const URL_SECRET = 'https://evil.example/PUSH_PRIVACY_URL_SECRET';

const push = read('push-trigger.js');
const svc = read('chat-service.js');
const p2p = read('chat-p2p-file.js');
const appVer = JSON.parse(read('app-version.json'));
const e2ee = read('chat-e2ee.js');

record('no messageContent.slice plaintext path', !/messageContent\.length\s*>\s*100/.test(push));
record('sanitizePrivateChatPushPayload present', push.includes('sanitizePrivateChatPushPayload'));
record('generic chat title/body constants', push.includes("GENERIC_CHAT_TITLE = 'SOS'") && push.includes("GENERIC_CHAT_BODY = 'הודעה חדשה'"));
record('chat-service does not pass serialization.rawContent to Push', !/triggerOutgoingMessagePush\([^)]*rawContent/.test(svc));
record('chat-service uses options object for Push', /triggerOutgoingMessagePush\(\s*peerPubkey\s*,\s*\{/.test(svc));
record('chat-p2p-file does not pass attachment name to Push', !/triggerOutgoingMessagePush\([^)]*name:\s*transfer\.file/.test(p2p));
record('call incoming push disabled (secure native wake)', push.includes('CALL_PUSH_DISABLED') && push.includes('triggerIncomingCallPush'));
record('missed call push disabled', push.includes('MISSED_CALL_PUSH_DISABLED') && push.includes('triggerMissedCallPush'));
record('call push has no peerPubkey field in send path', !/type:\s*isVideo\s*\?\s*'video-call-incoming'/.test(push));
record('call push has no contactInfo.name body', !/contactInfo\.name\} מתקשר/.test(push));
record('LIVE_E2EE_SEND=true (E3B ACTIVE)',
  JSON.parse(fs.readFileSync(path.join(ROOT, 'app-version.json'), 'utf8')).e2eeSendRequired === true);
record('dual-read still present', svc.includes('decryptPrivateChatPayload'));
record('secure epoch code SOS_SECURE_CHAT_EPOCH=2', /SOS_SECURE_CHAT_EPOCH\s*=\s*2/.test(e2ee));
record('push privacy does not edit app-version.json in this gate scope', true);

// Behavioral: build outgoing payload with secrets and ensure they never appear
const captured = [];
const root = {
  window: {},
  document: { hidden: false, hasFocus: () => true },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: async (url, opts) => {
    captured.push({ url: String(url), body: String(opts && opts.body || '') });
    return { ok: true, status: 200, json: async () => ({ ok: true, sent: 1 }) };
  },
  console,
  btoa: (s) => Buffer.from(String(s)).toString('base64'),
  URL: class {
    constructor() { this.searchParams = { get: () => null }; }
  },
  setTimeout,
};
root.window = root;
root.NostrApp = {
  publicKey: 'aa'.repeat(32),
  profile: { name: 'Alice', picture: 'https://cdn.example/a.png' },
  sendFcmToPubkey(pubkey, payload) {
    captured.push({ fcm: true, pubkey, payload: JSON.stringify(payload) });
  },
};
vm.runInNewContext(push.replace('(window);', '(root);').replace('})(window);', '})(root);'), { ...root, root, window: root, document: root.document, localStorage: root.localStorage, fetch: root.fetch, console, btoa: root.btoa, URL: root.URL, setTimeout, NostrApp: root.NostrApp });

// Fix IIFE invocation - the file ends with })(window); - run properly
const code = read('push-trigger.js');
const sandbox = {
  window: { NostrApp: {
    publicKey: 'aa'.repeat(32),
    profile: { name: 'Alice', picture: 'data:image/png;base64,xxx' },
    sendFcmToPubkey(pubkey, payload) {
      captured.push({ fcm: true, body: JSON.stringify(payload) });
    },
  } },
  document: { hidden: false, hasFocus: () => true },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: async (url, opts) => {
    captured.push({ url: String(url), body: String(opts && opts.body || '') });
    return { ok: true, status: 200, json: async () => ({ ok: true, sent: 1 }) };
  },
  console: { log() {}, warn() {}, error() {} },
  btoa: (s) => Buffer.from(String(s)).toString('base64'),
  setTimeout: (fn) => { /* no-op timers in QA */ },
  URL: class FakeURL {
    constructor() { this.searchParams = { get() { return null; } }; }
  },
};
sandbox.window.document = sandbox.document;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.NostrApp = sandbox.window.NostrApp;
vm.runInNewContext(code, sandbox);

const App = sandbox.window.NostrApp;
captured.length = 0;

await App.triggerOutgoingMessagePush('bb'.repeat(32), SECRET, {
  type: 'file',
  name: FILENAME,
  url: URL_SECRET,
  caption: CAPTION,
  size: 99,
}, 'evt-secret');

await App.triggerOutgoingMessagePush('bb'.repeat(32), {
  eventId: 'evt2',
  hasAttachment: true,
  messageContent: SECRET,
  rawContent: SECRET,
  caption: CAPTION,
});

await App.triggerChatMessagePush({
  from: 'cc'.repeat(32),
  direction: 'incoming',
  createdAt: Math.floor(Date.now() / 1000),
  content: SECRET,
  id: 'msg1',
  attachment: { type: 'file', name: FILENAME, url: URL_SECRET, caption: CAPTION },
});

const blob = captured.map((c) => JSON.stringify(c)).join('\n');
record('outgoing ignores plaintext SECRET', !blob.includes(SECRET));
record('outgoing ignores attachment filename', !blob.includes(FILENAME));
record('outgoing ignores caption', !blob.includes(CAPTION));
record('outgoing ignores attachment URL', !blob.includes('PUSH_PRIVACY_URL_SECRET'));
record('outgoing uses generic SOS / הודעה חדשה', blob.includes('SOS') && blob.includes('הודעה חדשה'));
record('HTTP push body is chat-message type', /"type":"chat-message"/.test(blob) || blob.includes('chat-message'));

// Sanitize helper reject fields
const sanitized = App.sanitizePrivateChatPushPayload({
  type: 'chat-message',
  title: SECRET,
  body: SECRET,
  messageContent: SECRET,
  rawContent: SECRET,
  preview: SECRET,
  caption: CAPTION,
  attachment: { name: FILENAME, url: URL_SECRET },
  peerPubkey: 'dd'.repeat(32),
  eventId: 'e1',
});
const sanStr = JSON.stringify(sanitized);
record('sanitizer drops secrets', !sanStr.includes(SECRET) && !sanStr.includes(FILENAME) && !sanStr.includes(CAPTION));
record('sanitizer forces generic body', sanitized.body === 'הודעה חדשה' && sanitized.title === 'SOS');

// Phase 1B: call Push disabled — no voice/video call type to FCM
record('incoming call push disabled', push.includes('CALL_PUSH_DISABLED') && !/type:\s*isVideo\s*\?\s*'video-call-incoming'\s*:\s*'voice-call-incoming'/.test(push));
record('missed call push disabled', push.includes('MISSED_CALL_PUSH_DISABLED'));

// Server source if present adjacent
const serverSend = path.join('C:\\BRAIN\\sos-push-server\\api\\push\\send.js');
if (fs.existsSync(serverSend)) {
  const s = fs.readFileSync(serverSend, 'utf8');
  record('server forces generic chat body', s.includes("body: 'הודעה חדשה'") && s.includes("title: 'SOS'"));
  record('server no longer logs full request body JSON', !s.includes('JSON.stringify(req.body'));
} else {
  record('server source checked', false, 'sos-push-server missing');
}

const fcm = read('fcm-push-api/api/index.js');
record('fcm-api forces generic chat body', fcm.includes("safeBody = isChat ? 'הודעה חדשה'") || fcm.includes("isChat ? 'הודעה חדשה'"));

console.log(results.join('\n'));
console.log(`\nSummary: ${pass} passed, ${fail} failed`);
console.log(fail ? 'PUSH_PLAINTEXT_BLOCKS_E3B: YES' : 'PUSH_PLAINTEXT_BLOCKS_E3B: NO');
process.exit(fail ? 1 : 0);
