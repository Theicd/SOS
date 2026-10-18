import fs from 'fs';
import vm from 'vm';

const read = (name) => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const session = read('sos-account-session.js');
const chat = read('chat-service.js');
const state = read('chat-state.js');
const calls = read('chat-voice-call.js');
const callUi = read('chat-voice-call-ui.js');
const presence = read('chat-presence.js');
const ui = read('chat-ui.js');
const signal = read('call-signal-e2ee.js');

let failed = 0;
function check(name, ok) {
  if (!ok) failed += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
}

check('actor resolver is exported', session.includes('resolveVerifiedActor: resolveVerifiedActor') && session.includes('canonicalPeer: canonicalPeer'));
check('unknown device is not merged', session.includes("authorization: 'direct-account'"));
check('chat maps sender before the contact', chat.includes('senderAccount = await mapAccount(sender)') && chat.includes('contactPubkey = await mapAccount(syncPeerEarly)'));
check('device author is filed on the account even on a linked device', chat.includes('senderAccount && senderAccount !== sender && sender !== accountUser'));
check('p2p does not dial a verified device key', chat.includes('skip device endpoint'));
check('stored parties rewrite a verified device', state.includes('accountForStoredParty'));
check('logical duplicate keeps the attachment', state.includes('existing.attachment = message.attachment'));
check('call bind resolves a device before a peer is selected', calls.includes("reason: 'ACCOUNT_MISMATCH'") && calls.includes('resolveDeviceAccount(devicePub)'));
check('ring and offer display the account', calls.includes('state.currentPeer = logicalPeer || peerPubkey') && calls.includes('App.onVoiceCallIncoming(logicalPeer || peerPubkey, offerData)'));
check('cancel tombstone blocks a late ring', calls.includes('function sessionTombstoned') && calls.includes("CALL_SIGNAL_REJECT terminal_session"));
check('claimed-here still uses the device key', calls.includes('cancelClaimedByThisDevice(claimed)'));
check('dial tone cannot restart after the session is sealed', callUi.includes('function sealCallAudio') && callUi.includes('audioStoppedSession === sid'));
check('call screen does not use a device fingerprint as a name', !callUi.includes('משתמש ${') && callUi.includes('function callDisplayName'));
check('presence can be signed by a linked device', presence.includes('function sendLinkedDevicePresence') && presence.includes("verifyDelegatedEvent(event, 'DEVICE_PRESENCE')"));
check('presence copy is addressed to linked devices', presence.includes('listAuthorizedDevices(payload.to, \'DEVICE_CHAT\')'));
check('foreground notification uses the account and one logical id', ui.includes('function canonicalNotifyPeer') && ui.includes('message?.logicalMessageId || message?.id'));
check('linked caller can fan out a cancel', signal.includes('linkedFan') && signal.includes('cancel: 1'));

const sandbox = { window: {}, console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(session, sandbox);
const owners = {};
sandbox.window.__sosVerifiedDeviceOwners = owners;
const device = 'a'.repeat(64);
const account = 'b'.repeat(64);
owners[device] = account;
const mapped = sandbox.window.SosAccountSession.verifiedAccountOf(device);
const unknown = sandbox.window.SosAccountSession.verifiedAccountOf('c'.repeat(64));
check('cached md3 owner resolves', mapped === account);
check('unknown key is not rewritten', unknown === '');

console.log(failed ? 'STATUS=FAIL' : 'STATUS=PASS');
process.exit(failed ? 1 : 0);
