/**
 * Voice AAD, inbound image fanout, ring-cancel identity, and ICE fanout.
 * Matching AAD decrypts. A different message id or party is rejected.
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
let failed = 0;
function check(name, ok) {
  if (!ok) failed += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
}

const voiceCall = read('chat-voice-call.js');
const signals = read('call-signal-e2ee.js');
const chat = read('chat-service.js');
const blossom = read('blossom.js');
const voiceSvc = read('chat-voice-service.js');
const audio = read('chat-audio-player.js');
const wire = read('chat-file-transfer-state.js');
const media = read('media-server-e2ee.js');
const p2p = read('chat-p2p-file.js');

check('linked cancel ignores only the device key', voiceCall.includes('function cancelClaimedByThisDevice') && voiceCall.includes("c === String(linked.deviceSignPub).toLowerCase()") && !voiceCall.includes('String(claimed).toLowerCase() === selfKey'));
check('cancel requires an authorized sender', voiceCall.includes('CALL_RING_CANCEL_REJECT') && voiceCall.includes('!binding.authorized'));
check('fresh ring clears a previous claim', voiceCall.includes('state.callClaim.sessionId !== preParsed.sessionId'));
check('connected requires bidirectional rtp', voiceCall.includes('RTP_PACKETS_FLOWING_BOTH_DIRECTIONS') && voiceCall.includes('reason=await-rtp'));
check('ice candidates fan out to linked devices', signals.includes('candidate: 1, candidates: 1'));
check('voice publish keeps the aead message id', read('chat-voice-ui.js').includes('clientTempId: boundId') && chat.includes('pendingAtt.clientMessageId'));
check('playback prefers the encrypted attachment id', audio.includes('App.mediaAuthContext') && media.includes('att.clientMessageId || att.logicalMessageId'));
check('wire carries the aead parties', wire.includes('wire.aadParties') && wire.includes('wire.clientMessageId'));
check('inbound file mirror is a device copy', chat.includes("mode === 'inbound'") && chat.includes("'sos-inbound-sync'") && p2p.includes('mirrorInboundP2pFileToLinkedDevices'));
check('inbound sync is filed from the external peer', chat.includes('INBOUND_SYNC_REJECT') && chat.includes("bubbleDirection = 'incoming'"));
check('torrent upload is not a receipt', voiceSvc.includes('receipt=NOT_ACK') && !voiceSvc.includes('הצד השני קיבל'));
check('linked blossom auth is device-signed and capability gated', blossom.includes('BLOSSOM_DEVICE_AUTH') && blossom.includes("caps.indexOf('DEVICE_FILES')") && blossom.includes('pub === String(App.publicKey || \'\').toLowerCase()) return null'));

const sandbox = {
  console,
  crypto: globalThis.crypto,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  ArrayBuffer,
  Buffer,
  Blob: globalThis.Blob,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(read('media-file-e2ee.js'), sandbox, { filename: 'media-file-e2ee.js' });
const api = sandbox.NostrApp;
const sender = 'a'.repeat(64);
const recipient = 'b'.repeat(64);
const other = 'c'.repeat(64);
const plain = new TextEncoder().encode('voice-bytes');
const enc = await api.encryptMediaBlob(plain, {
  messageId: 'cmsg-voice-1',
  sender,
  recipient,
  mime: 'audio/webm',
  filename: 'voice-message.webm',
  mode: 'single',
});
const good = await api.decryptMediaBlob(enc.ciphertext, enc.descriptor, {
  messageId: 'cmsg-voice-1',
  sender,
  recipient,
  attachmentId: enc.descriptor.attachmentId,
});
check('matching aad decrypts', good && good.plaintext && new TextDecoder().decode(good.plaintext) === 'voice-bytes');
let rejected = false;
try {
  await api.decryptMediaBlob(enc.ciphertext, enc.descriptor, {
    messageId: 'cmsg-other',
    sender,
    recipient,
    attachmentId: enc.descriptor.attachmentId,
  });
} catch (err) {
  rejected = !!(err && (err.code === 'MEDIA_E2EE_AUTH_FAILED' || String(err.message || '').includes('AUTH')));
}
check('wrong message id is rejected', rejected);
let wrongParty = false;
try {
  await api.decryptMediaBlob(enc.ciphertext, enc.descriptor, {
    messageId: 'cmsg-voice-1',
    sender,
    recipient: other,
    attachmentId: enc.descriptor.attachmentId,
  });
} catch (err) {
  wrongParty = !!(err && err.code);
}
check('wrong recipient is rejected', wrongParty);

console.log(failed ? 'STATUS=FAIL' : 'STATUS=PASS');
process.exit(failed ? 1 : 0);
