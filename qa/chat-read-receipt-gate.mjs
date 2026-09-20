#!/usr/bin/env node
/**
 * Stage 5B read-receipt boundary, dedupe, and relay privacy checks.
 * No network. Does not touch voice playback code.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const stateSrc = fs.readFileSync(path.join(ROOT, 'chat-state.js'), 'utf8');
const serviceSrc = fs.readFileSync(path.join(ROOT, 'chat-service.js'), 'utf8');
const audioSrc = fs.readFileSync(path.join(ROOT, 'chat-audio-player.js'), 'utf8');

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

const sandbox = {
  console,
  setTimeout: () => 1,
  clearTimeout() {},
  document: { addEventListener() {}, readyState: 'loading' },
  Map, Set, Date, Math, JSON, Object, Array, String, Number,
};
sandbox.window = {};
sandbox.globalThis = sandbox;
vm.runInNewContext(stateSrc, sandbox, { filename: 'chat-state.js' });
const App = sandbox.window.NostrApp;
const SELF = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
App.publicKey = SELF;

const NOW = Math.floor(Date.now() / 1000) - 80;
function add(id, createdAt, extra) {
  App.appendChatMessage(Object.assign({
    id,
    from: SELF,
    to: PEER,
    content: id,
    createdAt,
    direction: 'outgoing',
    status: 'sent',
  }, extra || {}));
}
function statusOf(id) {
  const row = App.getChatMessages(PEER).find((message) => message.id === id);
  return row ? row.status : '';
}
function receipt(id, ts) {
  return {
    from: PEER,
    to: SELF,
    lastReadMessageId: id,
    lastReadAt: ts,
    receiptId: App.buildChatReadReceiptId(PEER, SELF, id, ts),
  };
}

add('M1', NOW);
add('M2', NOW);
add('M3', NOW + 10);
add('M4', NOW + 20);
const first = App.applyIncomingReadReceipt(receipt('M1', NOW));
record('1 message id is boundary', first.applied === true && statusOf('M1') === 'read' && statusOf('M2') === 'sent');
record('2 equal timestamp does not mark later', statusOf('M2') === 'sent');

App.applyIncomingReadReceipt(receipt('M3', NOW + 10));
record('3 cumulative advance', statusOf('M1') === 'read' && statusOf('M2') === 'read' && statusOf('M3') === 'read' && statusOf('M4') === 'sent');
const before = App.getChatMessages(PEER).map((message) => message.status).join(',');
const old = App.applyIncomingReadReceipt(Object.assign({}, receipt('M1', NOW), { receiptId: 'rr-older-boundary' }));
record('4 old receipt does not regress', old.ignored === true && App.getChatMessages(PEER).map((message) => message.status).join(',') === before);

const dup = App.applyIncomingReadReceipt(receipt('M3', NOW + 10));
record('5 duplicate receiptId ignored', dup.duplicate === true);

const relayDup = App.applyIncomingReadReceipt(receipt('M3', NOW + 10));
record('6 second transport duplicate ignored', relayDup.duplicate === true && statusOf('M4') === 'sent');

record('7 relay fallback remains after DC and mesh',
  /function transmitReadReceipt[\s\S]*sendReceiptOverDc[\s\S]*sendReceiptOverMesh[\s\S]*sendReceiptOverNostr/.test(serviceSrc)
  && /kind: READ_RECEIPT_KIND/.test(serviceSrc));
record('7 apply does not require dataChannel', !/dataChannel/.test(stateSrc.slice(stateSrc.indexOf('function applyIncomingReadReceipt'), stateSrc.indexOf('function retryInboundReadReceipt'))));

const fresh = {
  console, setTimeout: () => 1, clearTimeout() {},
  document: { addEventListener() {}, readyState: 'loading' },
  Map, Set, Date, Math, JSON, Object, Array, String, Number,
};
fresh.window = {};
fresh.globalThis = fresh;
vm.runInNewContext(stateSrc, fresh, { filename: 'chat-state.js' });
const App2 = fresh.window.NostrApp;
App2.publicKey = SELF;
App2.appendChatMessage({ id: 'M1', from: SELF, to: PEER, content: '1', createdAt: NOW, direction: 'outgoing', status: 'sent' });
App2.appendChatMessage({ id: 'M2', from: SELF, to: PEER, content: '2', createdAt: NOW + 10, direction: 'outgoing', status: 'sent' });
const early = App2.applyIncomingReadReceipt({
  from: PEER,
  to: SELF,
  lastReadMessageId: 'M3',
  lastReadAt: NOW + 10,
  receiptId: App2.buildChatReadReceiptId(PEER, SELF, 'M3', NOW + 10),
});
record('8 receipt waits for hydration', early.pending === true && App2.getChatMessages(PEER).find((m) => m.id === 'M2').status === 'sent');
App2.appendChatMessage({ id: 'M3', from: SELF, to: PEER, content: '3', createdAt: NOW + 10, direction: 'outgoing', status: 'sent' });
record('8 boundary applies when message arrives',
  App2.getChatMessages(PEER).every((m) => m.status === 'read'));

add('V1', NOW + 30, { attachment: { type: 'encrypted-media', isVoice: true, media: { mime: 'audio/webm' } } });
App.applyIncomingReadReceipt(receipt('V1', NOW + 30));
record('9 voice message is read by boundary', statusOf('V1') === 'read');
record('10 playback is not required', !/audio\.play|VOICE_SOURCE_/.test(stateSrc.slice(stateSrc.indexOf('function applyIncomingReadReceipt'), stateSrc.indexOf('function retryInboundReadReceipt'))));
record('11 encrypted relay receipt, plaintext rejected',
  /encryptPrivateChatPayload/.test(serviceSrc)
  && /plaintext-receipt/.test(serviceSrc)
  && /looksLikeSosE2eeEnvelope/.test(serviceSrc));
record('12 stage 5A voice resolver remains',
  /VOICE_SOURCE_BLOSSOM_E2EE/.test(audioSrc) && /resolveDurableVoicePlayback/.test(audioSrc));
record('receipt id stable for same boundary',
  App.buildChatReadReceiptId(PEER, SELF, 'M3', 200) === App.buildChatReadReceiptId(PEER, SELF, 'M3', 999));
record('publish does not infer read', /updateChatMessageStatus\(event\.id, 'sent'\)/.test(serviceSrc));

const uiSrc = fs.readFileSync(path.join(ROOT, 'chat-ui.js'), 'utf8');
const enhancedCss = fs.readFileSync(path.join(ROOT, 'chat-enhanced-styles.css'), 'utf8');
const themeCss = fs.readFileSync(path.join(ROOT, 'styles/chat-whatsapp-theme.css'), 'utf8');
const desktopCss = fs.readFileSync(path.join(ROOT, 'styles/chat-desktop-sos-cyber.css'), 'utf8');
const chatCss = fs.readFileSync(path.join(ROOT, 'styles/chat.css'), 'utf8');
const readHtml = "chat-message__status--read";
const helperStart = uiSrc.indexOf('function buildChatMessageStatusHtml');
const helperEnd = uiSrc.indexOf('function settleFileCardBubble');
const helperSrc = helperStart >= 0 && helperEnd > helperStart ? uiSrc.slice(helperStart, helperEnd) : '';
const settleStart = uiSrc.indexOf('function settleFileCardBubble');
const settleEnd = uiSrc.indexOf('function settleOutgoingFileTransfer');
const settleSrc = settleStart >= 0 && settleEnd > settleStart ? uiSrc.slice(settleStart, settleEnd) : '';
const statusFnStart = uiSrc.indexOf('function updateMessageStatus');
const statusFnEnd = uiSrc.indexOf('function clearChatContactsSearch');
const statusFnSrc = statusFnStart >= 0 && statusFnEnd > statusFnStart ? uiSrc.slice(statusFnStart, statusFnEnd) : '';
const READ = '#53bdeb';

record('UI1 text read markup is blue class', helperSrc.includes("st === 'read'") && helperSrc.includes(readHtml));
record('UI2 image status uses helper', /function appendVisualMediaMessageWithoutWipe[\s\S]{0,2500}buildChatMessageStatusHtml\(message\.status/.test(uiSrc) || uiSrc.includes("const statusHtml = isOutgoing ? buildChatMessageStatusHtml(message.status || 'sent')"));
record('UI3 voice status uses helper', (uiSrc.match(/buildChatMessageStatusHtml\(message\.status \|\| 'sent'\)/g) || []).length >= 4);
record('UI4 PDF/TXT settle uses message.status', /buildChatMessageStatusHtml\(message\.status \|\| 'sent'\)/.test(settleSrc) && !/status--sent"/.test(settleSrc));
record('UI5 generic file card not hard-coded SENT', settleSrc.includes('message.status') && !settleSrc.includes('chat-message__status--sent'));
record('UI6 settleFileCardBubble respects message.status', /buildChatMessageStatusHtml\(message\.status/.test(settleSrc));
record('UI7 settled card refreshes status without reopen',
  /settledMediaTransferIds\.has\(settleKey\)[\s\S]{0,180}updateMessageStatus\(message\.id, message\.status/.test(uiSrc)
  && /statusUpdate && message\?\.id[\s\S]{0,120}updateMessageStatus\(message\.id, message\.status/.test(uiSrc)
  && statusFnSrc.includes('buildChatMessageStatusHtml(newStatus)'));
record('UI8 contact and conversation READ share #53bdeb',
  enhancedCss.includes('.chat-message__status--read') && enhancedCss.includes(READ)
  && enhancedCss.includes('.chat-contact__status--read')
  && themeCss.includes('.chat-contact__status--read') && themeCss.includes(READ)
  && chatCss.includes(READ)
  && desktopCss.includes('color: #53bdeb !important'));
record('UI9 FAILED stays red and distinct',
  enhancedCss.includes('.chat-message__status--failed') && enhancedCss.includes('#e74c3c')
  && helperSrc.includes("st === 'failed'") && helperSrc.includes('status--failed'));
record('UI10 document READ is conversation boundary not download',
  !/download|openedFile|fileOpened/.test(stateSrc.slice(stateSrc.indexOf('function applyIncomingReadReceipt'), stateSrc.indexOf('function retryInboundReadReceipt')))
  && /READ_RECEIPT_DUPLICATE_IGNORED/.test(serviceSrc)
  && /READ_RECEIPT_APPLIED/.test(serviceSrc));
record('UI11 no stage 5A regression', /VOICE_SOURCE_BLOSSOM_E2EE/.test(audioSrc) && /resolveDurableVoicePlayback/.test(audioSrc));
record('UI12 no stage 5B boundary/dedupe regression',
  /seenReceiptIds/.test(stateSrc) && /receiptMovesForward/.test(stateSrc) && /lastReadMessageId/.test(stateSrc));
record('UI13 read color token not red',
  !/\.chat-message__status--read\s*\{[^}]*#e74c3c/.test(enhancedCss)
  && !/\.chat-audio-whatsapp__meta-slot \.chat-message__status--read\s*\{[^}]*#ef4444/.test(enhancedCss)
  && !/rgba\(52, 211, 153/.test(themeCss.slice(themeCss.indexOf('.chat-contact__status--read'), themeCss.indexOf('.chat-contact__status--read') + 80)));

function bootState() {
  const box = {
    console, setTimeout: () => 1, clearTimeout() {},
    document: { addEventListener() {}, readyState: 'loading' },
    Map, Set, Date, Math, JSON, Object, Array, String, Number,
  };
  box.window = {};
  box.globalThis = box;
  vm.runInNewContext(stateSrc, box, { filename: 'chat-state.js' });
  const app = box.window.NostrApp;
  app.publicKey = SELF;
  return app;
}
function proveP2PFile(label, mime, name) {
  const app = bootState();
  const fileId = 'F-' + label.replace(/\s+/g, '');
  app.appendChatMessage({
    id: 'p2p-send-' + fileId,
    from: SELF,
    to: PEER,
    content: name,
    createdAt: NOW + 40,
    direction: 'outgoing',
    status: 'sent',
    attachment: { fileId, type: mime, name },
  });
  const local = app.getChatMessages(PEER)[0];
  const canon = app.getReceiptBoundaryId(local);
  const applied = app.applyIncomingReadReceipt({
    from: PEER,
    to: SELF,
    lastReadMessageId: 'p2p-recv-' + fileId,
    lastReadAt: NOW + 40,
    receiptId: app.buildChatReadReceiptId(PEER, SELF, 'p2p-recv-' + fileId, NOW + 40),
  });
  record(label + ' shared canonical id',
    canon === 'p2p-file-' + fileId
    && app.normalizeReceiptBoundaryId('p2p-send-' + fileId) === canon
    && app.normalizeReceiptBoundaryId('p2p-recv-' + fileId) === canon
    && app.normalizeReceiptBoundaryId(canon) === canon);
  record(label + ' READ without a later text',
    applied.applied === true && local.status === 'read' && local.id === 'p2p-send-' + fileId);
}
proveP2PFile('P2P image', 'image/jpeg', 'photo.jpg');
proveP2PFile('P2P TXT', 'text/plain', 'note.txt');
proveP2PFile('P2P PDF', 'application/pdf', 'doc.pdf');
proveP2PFile('P2P generic', 'application/octet-stream', 'pack.zip');

const legacy = bootState();
legacy.appendChatMessage({
  id: 'p2p-send-LEGACY1',
  from: SELF,
  to: PEER,
  content: 'legacy',
  createdAt: NOW + 41,
  direction: 'outgoing',
  status: 'sent',
  attachment: { fileId: 'LEGACY1', type: 'application/pdf', name: 'old.pdf' },
});
const legacyHit = legacy.applyIncomingReadReceipt({
  from: PEER,
  to: SELF,
  lastReadMessageId: 'p2p-recv-LEGACY1',
  lastReadAt: NOW + 41,
  receiptId: 'rr-legacy-recv',
});
record('legacy p2p-recv matches local p2p-send',
  legacyHit.applied === true && legacy.getChatMessages(PEER)[0].status === 'read');

const textP2p = bootState();
const textId = 'p2p-1789858720969-94m2vg';
record('normal P2P text id unchanged', textP2p.normalizeReceiptBoundaryId(textId) === textId);
textP2p.appendChatMessage({ id: textId, from: SELF, to: PEER, content: 'hi', createdAt: NOW, direction: 'outgoing', status: 'sent' });
const textHit = textP2p.applyIncomingReadReceipt({
  from: PEER, to: SELF, lastReadMessageId: textId, lastReadAt: NOW,
  receiptId: textP2p.buildChatReadReceiptId(PEER, SELF, textId, NOW),
});
record('normal P2P text still reads', textHit.applied === true && textP2p.getChatMessages(PEER)[0].status === 'read');

const relayId = 'c'.repeat(64);
record('relay id unchanged', textP2p.normalizeReceiptBoundaryId(relayId) === relayId);
textP2p.appendChatMessage({ id: relayId, from: SELF, to: PEER, content: 'relay', createdAt: NOW + 3, direction: 'outgoing', status: 'sent' });
const relayHit = textP2p.applyIncomingReadReceipt({
  from: PEER, to: SELF, lastReadMessageId: relayId, lastReadAt: NOW + 3,
  receiptId: textP2p.buildChatReadReceiptId(PEER, SELF, relayId, NOW + 3),
});
record('relay id still reads', relayHit.applied === true && textP2p.getChatMessages(PEER).find((m) => m.id === relayId).status === 'read');

const sameTs = bootState();
sameTs.appendChatMessage({
  id: 'p2p-send-EQ1', from: SELF, to: PEER, content: 'a', createdAt: NOW, direction: 'outgoing', status: 'sent',
  attachment: { fileId: 'EQ1', type: 'image/png', name: 'a.png' },
});
sameTs.appendChatMessage({
  id: 'p2p-send-EQ2', from: SELF, to: PEER, content: 'b', createdAt: NOW, direction: 'outgoing', status: 'sent',
  attachment: { fileId: 'EQ2', type: 'text/plain', name: 'b.txt' },
});
sameTs.applyIncomingReadReceipt({
  from: PEER, to: SELF, lastReadMessageId: 'p2p-recv-EQ1', lastReadAt: NOW,
  receiptId: sameTs.buildChatReadReceiptId(PEER, SELF, 'p2p-recv-EQ1', NOW),
});
record('equal timestamps stay safe for P2P files',
  sameTs.getChatMessages(PEER).find((m) => m.id === 'p2p-send-EQ1').status === 'read'
  && sameTs.getChatMessages(PEER).find((m) => m.id === 'p2p-send-EQ2').status === 'sent');
record('canonical receipt id ignores send/recv prefix',
  sameTs.buildChatReadReceiptId(PEER, SELF, 'p2p-send-EQ1', 1) === sameTs.buildChatReadReceiptId(PEER, SELF, 'p2p-recv-EQ1', 9));

const boundaryApp = bootState();
boundaryApp.appendChatMessage({ id: 'in-viewed', from: PEER, to: SELF, content: 'seen', createdAt: NOW, direction: 'incoming', status: 'sent' });
boundaryApp.appendChatMessage({ id: 'out-local', from: SELF, to: PEER, content: 'mine', createdAt: NOW + 30, direction: 'outgoing', status: 'sent' });
boundaryApp.appendChatMessage({ id: 'sys-note', from: SELF, to: PEER, content: 'notice', createdAt: NOW + 31, direction: 'system', isSystem: true, systemKind: 'disappearing-intro' });
boundaryApp.markChatConversationRead(PEER);
const storedBoundary = boundaryApp.chatState.contacts.get(PEER).lastReadMessageId || '';
record('outgoing and system are not the read boundary', storedBoundary === 'in-viewed');

const uiLive = fs.readFileSync(path.join(ROOT, 'chat-ui.js'), 'utf8');
record('foreground reconcile marks only the active viewed conversation',
  /function reconcileActiveConversationRead/.test(uiLive)
  && /if \(!isConversationActivelyViewed\(peer\)\) return;/.test(uiLive)
  && /reconcileActiveConversationRead\('visibilitychange'\)/.test(uiLive)
  && /reconcileActiveConversationRead\('native-resume'\)/.test(uiLive)
  && /doc\.hidden \|\| doc\.visibilityState === 'hidden'/.test(uiLive));
record('receipt logs distinguish pending and regress',
  /READ_RECEIPT_PENDING_BOUNDARY/.test(serviceSrc)
  && /READ_RECEIPT_TRUE_REGRESS_IGNORED/.test(serviceSrc)
  && /READ_RECEIPT_SAME_BOUNDARY_APPLIED/.test(serviceSrc)
  && /currentBoundaryPrefix=/.test(serviceSrc)
  && /boundaryFound=/.test(serviceSrc)
  && /local boundary-found=false/.test(serviceSrc));
record('sender persists the same inner logical id',
  /relayLogicalMessageId = innerMessageId/.test(serviceSrc)
  && /outgoingMessage\.logicalMessageId = relayLogicalMessageId/.test(serviceSrc));

function blossomDoc(mime, name, logicalId) {
  const app = bootState();
  const sender = {
    id: 'nostr-event-1',
    logicalMessageId: logicalId,
    from: SELF,
    to: PEER,
    content: name,
    createdAt: NOW + 40,
    direction: 'outgoing',
    status: 'sent',
    attachment: { type: 'encrypted-media', logicalMessageId: logicalId, clientMessageId: logicalId, media: { mime, filename: name } },
  };
  const receiver = Object.assign({}, sender, { direction: 'incoming', from: PEER, to: SELF });
  app.appendChatMessage(sender);
  const senderBoundary = app.getReceiptBoundaryId(app.getChatMessages(PEER)[0]);
  const receiverBoundary = app.getReceiptBoundaryId(receiver);
  const hit = app.applyIncomingReadReceipt({
    from: PEER, to: SELF, lastReadMessageId: logicalId, lastReadAt: NOW + 40, receiptId: 'rr-' + logicalId,
  });
  return senderBoundary === logicalId && receiverBoundary === logicalId && hit.applied === true
    && app.getChatMessages(PEER)[0].status === 'read';
}
['text/plain', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/octet-stream'].forEach((mime, index) => {
  const names = ['a.txt', 'a.pdf', 'a.docx', 'a.xlsx', 'a.pptx', 'a.bin'];
  record('blossom document READ ' + names[index], blossomDoc(mime, names[index], 'cmsg-doc-' + (index + 1)));
});

const oldDoc = bootState();
oldDoc.appendChatMessage({
  id: 'nostr-event-1', from: SELF, to: PEER, content: 'old', createdAt: NOW + 41, direction: 'outgoing', status: 'sent',
  attachment: { type: 'encrypted-media', logicalMessageId: 'cmsg-doc-1' },
});
record('old attachment logical id is the boundary',
  oldDoc.getReceiptBoundaryId(oldDoc.getChatMessages(PEER)[0]) === 'cmsg-doc-1');
const oldHit = oldDoc.applyIncomingReadReceipt({
  from: PEER, to: SELF, lastReadMessageId: 'cmsg-doc-1', lastReadAt: NOW + 41, receiptId: 'rr-old-doc',
});
record('old blossom attachment receipt applies', oldHit.applied === true && oldDoc.getChatMessages(PEER)[0].status === 'read');

const miss = bootState();
miss.appendChatMessage({ id: 'M1', from: SELF, to: PEER, content: '1', createdAt: NOW, direction: 'outgoing', status: 'sent' });
miss.applyIncomingReadReceipt({ from: PEER, to: SELF, lastReadMessageId: 'M1', lastReadAt: NOW, receiptId: 'rr-m1-base' });
const pendingHit = miss.applyIncomingReadReceipt({
  from: PEER, to: SELF, lastReadMessageId: 'cmsg-later', lastReadAt: NOW + 20, receiptId: 'rr-missing',
});
record('unknown boundary is pending not regress', pendingHit.pending === true && pendingHit.reason !== 'regress');
miss.appendChatMessage({
  id: 'nostr-2', logicalMessageId: 'cmsg-later', from: SELF, to: PEER, content: '2',
  createdAt: NOW + 20, direction: 'outgoing', status: 'sent',
});
record('pending receipt applies after hydration',
  miss.getChatMessages(PEER).filter((m) => m.direction === 'outgoing').every((m) => m.status === 'read'));

const regress = bootState();
['M1', 'M2', 'M3'].forEach((id, index) => {
  regress.appendChatMessage({ id, from: SELF, to: PEER, content: id, createdAt: NOW + index, direction: 'outgoing', status: 'sent' });
});
regress.applyIncomingReadReceipt({ from: PEER, to: SELF, lastReadMessageId: 'M3', lastReadAt: NOW + 2, receiptId: 'rr-m3-wm' });
const back = regress.applyIncomingReadReceipt({ from: PEER, to: SELF, lastReadMessageId: 'M2', lastReadAt: NOW + 1, receiptId: 'rr-m2-late' });
record('true older boundary stays regress', back.ignored === true && back.reason === 'regress'
  && regress.chatState.readWatermarks.get(PEER).lastReadMessageId === 'M3');

const same = bootState();
same.appendChatMessage({ id: 'M3', from: SELF, to: PEER, content: '3', createdAt: NOW + 3, direction: 'outgoing', status: 'sent' });
same.applyIncomingReadReceipt({ from: PEER, to: SELF, lastReadMessageId: 'M3', lastReadAt: NOW + 3, receiptId: 'rr-m3-first' });
same.getChatMessages(PEER)[0].status = 'sent';
const again = same.applyIncomingReadReceipt({ from: PEER, to: SELF, lastReadMessageId: 'M3', lastReadAt: NOW + 3, receiptId: 'rr-m3-again' });
record('same boundary repairs READ without moving watermark',
  again.sameBoundary === true
  && same.getChatMessages(PEER)[0].status === 'read'
  && same.chatState.readWatermarks.get(PEER).lastReadMessageId === 'M3');

const echo = bootState();
echo.appendChatMessage({ id: 'nostr-event-1', from: SELF, to: PEER, content: 'x', createdAt: NOW + 4, direction: 'outgoing', status: 'sent' });
echo.appendChatMessage({
  id: 'nostr-event-1', logicalMessageId: 'cmsg-doc-1', from: SELF, to: PEER, content: 'x',
  createdAt: NOW + 4, direction: 'outgoing', status: 'sent',
  attachment: { type: 'encrypted-media', logicalMessageId: 'cmsg-doc-1' },
});
record('self-echo merges logical id without a duplicate',
  echo.getChatMessages(PEER).length === 1
  && echo.getReceiptBoundaryId(echo.getChatMessages(PEER)[0]) === 'cmsg-doc-1');

console.log(results.join('\n'));
console.log(fail ? 'CHAT_READ_RECEIPT_GATE FAIL (' + pass + ' passed, ' + fail + ' failed)' : 'CHAT_READ_RECEIPT_GATE PASS (' + pass + ' passed, 0 failed)');
process.exit(fail ? 1 : 0);
