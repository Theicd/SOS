import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const signal = read('call-signal-e2ee.js');
const voice = read('chat-voice-call.js');
const ui = read('chat-voice-call-ui.js');
const state = read('chat-state.js');
const file = read('chat-p2p-file.js');
const html = read('videos.html');

const checks = [];
function check(name, ok) {
  checks.push({ name, ok: !!ok });
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name);
}

check('offer fanout includes answer and disconnect', /answer: 1, disconnect: 1/.test(signal));
check('offer build log', signal.includes('CALL_DEVICE_OFFER_BUILD'));
check('offer relay ack log', signal.includes('CALL_DEVICE_OFFER_RELAY_ACK'));
check('offer observed verified decrypted', signal.includes('CALL_DEVICE_OFFER_OBSERVED') && signal.includes('CALL_DEVICE_OFFER_VERIFIED') && signal.includes('CALL_DEVICE_OFFER_DECRYPTED'));
check('offer cache stored by session', signal.includes('CALL_DEVICE_OFFER_CACHE_STORED') && signal.includes('secureOfferBySession'));
check('session offer lookup exported', signal.includes('getCachedSecureOfferForSession'));
check('device listen pubkeys on recovery', signal.includes('callListenPubkeys()'));
check('linked desktop can recover offers', signal.includes('linkedCallReady()'));
check('fanout retries when no device copy', signal.includes('__fanRetry'));
check('subscription count log', signal.includes('ACTIVE_SUBSCRIPTION_COUNT'));
check('subscription open close eose', signal.includes('SUBSCRIPTION_OPEN') && signal.includes('SUBSCRIPTION_CLOSE') && signal.includes('EOSE kind=1059'));
check('do not drop live call subscription', signal.includes('SUBSCRIPTION_KEEP reason=active-call'));
check('decline uses device signer', voice.includes("terminalReason: reason") && voice.includes("sendSignal(account, 'cancel'"));
check('decline reasons', voice.includes('DECLINED_BY_RECIPIENT') && voice.includes('CANCELLED_BY_CALLER') && voice.includes('ANSWERED_ON_OTHER_DEVICE') && voice.includes('ENDED_AFTER_CONNECTION'));
check('sibling terminal is authorized', voice.includes('siblingTerminal'));
check('hydrate by session', ui.includes('getCachedSecureOfferForSession') && ui.includes('CALL_DEVICE_OFFER_HYDRATED'));
check('media merge by file id', state.includes('MEDIA_LOGICAL_MERGE') && state.includes('attachment.fileId'));
check('image mirror is not silent', file.includes('IMAGE_MIRROR_FAIL') && !file.includes('mirrorInboundP2pFileToLinkedDevices({') === false);
check('image delivery logs', file.includes('IMAGE_LOGICAL_ID') && file.includes('ATTACHMENT_BYTES_AVAILABLE') && file.includes('HASH_VERIFIED'));
check('fallback shares p2p logical id', file.includes("const messageId = 'p2p-recv-' + String(transfer.fileId || '');"));
check('transfer timing log', file.includes('P2P_TRANSFER_TIMING'));
check('live package 899s48', html.includes('call-signal-e2ee.js?v=20261019&pkg=899s48') && html.includes('chat-p2p-file.js?v=20261019&pkg=899s51'));

const failed = checks.filter((c) => !c.ok);
console.log('STATUS=' + (failed.length ? 'FAIL' : 'PASS_FOUR_DEVICE_CALL_SOURCE'));
console.log('CHECKS=' + checks.length + ' FAILED=' + failed.length);
process.exit(failed.length ? 1 : 0);
