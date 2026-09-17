#!/usr/bin/env node
/**
 * Phase 6: recipient-validation completion audit for private Web Nostr ingress.
 * Run: node qa/phase6-recipient-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
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

function sliceBetween(src, startNeedle, endNeedle) {
  const start = src.indexOf(startNeedle);
  if (start < 0) return '';
  const end = src.indexOf(endNeedle, start + startNeedle.length);
  return end > start ? src.slice(start, end) : src.slice(start);
}

const chat = read('chat-service.js');
const p2p = read('chat-p2p-datachannel.js');
const voice = read('chat-voice-call.js');
const video = read('chat-video-call.js');
const fileP2p = read('p2p-video-sharing.js');
const live = read('live-stream.js');
const notify = read('notifications-service.js');
const dating = read('dating.js');
const sendP2pFile = sliceBetween(fileP2p, 'const kind = FILE_REQUEST_KIND;', 'await App.pool.publish(relays, signed);');
const sendChat = sliceBetween(chat, 'async function publishChatEvent', 'await App.pool.publish');
const handleSig = sliceBetween(p2p, 'async function handleSig(event)', 'function onMsg');
const liveOn = sliceBetween(live, 'async function onSignalEvent(ev)', 'function subscribe(roomId)');
const fileOnevent = sliceBetween(fileP2p, 'onevent: async (event) => {', 'oneose:');
const fileListen = sliceBetween(fileP2p, 'kinds: [FILE_REQUEST_KIND]', 'oneose:');

record(
  'chat 1050/5/1051 have signature then recipient before handlers',
  chat.includes('verifyIncomingChatRelayEvent') &&
    chat.includes('verifyIncomingChatRelayRecipient') &&
    chat.indexOf('if (!verifyIncomingChatRelayEvent(event))') <
      chat.indexOf('if (!verifyIncomingChatRelayRecipient(event))'),
);
record(
  'chat self-authored skip remains in recipient helper',
  chat.includes('if (sender === self)') && chat.includes('return true;'),
);
record(
  'chat outgoing p tag unchanged',
  sendChat.includes("['p'") || chat.includes("['p', ") || /tags:[\s\S]*\['p'/.test(chat),
);

record(
  'p2p 25055 cheap p==self before signature, then before seen/decrypt',
  handleSig.includes('verifyIncomingP2pRelayEvent(event)') &&
    (handleSig.includes("t[0]==='p'") || handleSig.includes("t[0] === 'p'")) &&
    handleSig.indexOf("t[0] === 'p'") < handleSig.indexOf('verifyIncomingP2pRelayEvent') &&
    handleSig.indexOf('selfKey') < handleSig.indexOf('s.seen.has') &&
    handleSig.indexOf('selfKey') < handleSig.indexOf('nip04.decrypt'),
);
record(
  'p2p 25055 outgoing p tag unchanged',
  p2p.includes("['p',p.toLowerCase()]") && p2p.includes('kind:SIG_KIND'),
);

const voiceSub = sliceBetween(voice, 'function subscribeToSignals(options)', 'function forceResubscribeSignals');
const videoSub = sliceBetween(video, 'function subscribeToSignals(options)', 'function forceResubscribeSignals');
const helperSrc = read('call-signal-e2ee.js');
const secureEnsure = sliceBetween(helperSrc, 'function ensureSecureCallSubscription', 'function drainPendingSecureWrapsFromNative');

record(
  'shared secure 1059 signature then recipient before dispatch',
  secureEnsure.includes('verifyEventSig(ev)') &&
    secureEnsure.includes('getPTag(ev)') &&
    secureEnsure.includes('enqueueSecureDispatch(ev)') &&
    secureEnsure.indexOf('verifyEventSig(ev)') < secureEnsure.indexOf('getPTag(ev)') &&
    secureEnsure.indexOf('getPTag(ev)') < secureEnsure.indexOf('enqueueSecureDispatch(ev)') &&
    helperSrc.includes('dispatchGiftWrappedCallSignal'),
);

record(
  'voice+video legacy 25050 only; secure via shared dispatcher handlers',
  voiceSub.includes('kinds: [25050]') &&
    !voiceSub.includes('kinds: [1059]') &&
    videoSub.includes('kinds: [25050]') &&
    !videoSub.includes('kinds: [1059]') &&
    voice.includes('handleSecureSignal') &&
    video.includes('handleSecureSignal'),
);

record(
  'live 25056 explicit p==self before decrypt',
  liveOn.includes("t[0]==='p'") &&
    liveOn.indexOf('pTag') < liveOn.indexOf('nip04.decrypt') &&
    liveOn.includes('normKey(pTag[1])') &&
    liveOn.includes('normKey(App.publicKey)'),
);

record(
  '30078 file-signal subscription still filters #p current user',
  fileListen.includes("'#p': [keys.publicKey]"),
);
record(
  '30078 file-signal onevent checks recipient before decrypt',
  fileOnevent.includes('verifyIncomingFileSignalRecipient(event)') &&
    fileOnevent.indexOf('verifyIncomingFileSignalRecipient(event)') <
      fileOnevent.indexOf('extractSignalContent'),
);
record(
  '30078 outgoing tags still include p=peer only',
  sendP2pFile.includes("['p', peerPubkey]") &&
    sendP2pFile.includes('kind') &&
    !sendP2pFile.includes('verifyIncomingFileSignalRecipient'),
);
record(
  '30078 public heartbeat/file-availability paths are not recipient-gated',
  fileP2p.includes("'#t': ['p2p-heartbeat']") &&
    !sliceBetween(fileP2p, "'#t': ['p2p-heartbeat']", 'oneose:').includes('verifyIncomingFileSignalRecipient'),
);

record(
  'notifications likes/comments already require p==self; follows remain social',
  notify.includes("tag[0] === 'p' && tag[1]?.toLowerCase?.() === me") &&
    notify.includes('event.kind !== FOLLOW_KIND'),
);
record(
  'dating incoming likes stay social #p filter, not private chat state',
  dating.includes("kinds: [DATE_LIKE_KIND], '#p': [App.publicKey]"),
);
record(
  'feed/public kind 1 not treated as private chat recipient path in this phase',
  !read('feed.js').includes('verifyIncomingChatRelayRecipient'),
);

console.log(results.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
