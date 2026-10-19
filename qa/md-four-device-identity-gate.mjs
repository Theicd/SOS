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
check('phone lists verified linked devices', session.includes('function listAccountLinkedDevices') && session.includes('listAccountLinkedDevices: listAccountLinkedDevices'));
check('revoked device is refused', session.includes("code: 'DEVICE_REVOKED'") && session.includes('function revokeLinkedDevice'));

const sandbox = { window: {}, console, Promise, Date, JSON, Object, Array, String, Number, Math };
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

const other = 'c'.repeat(64);
const foreign = 'f'.repeat(64);
function dirEvent(body, pub, created) {
  return { kind: 30078, pubkey: pub, id: 'd'.repeat(64), sig: 'e'.repeat(128), created_at: created, content: JSON.stringify(body) };
}
sandbox.NostrTools = {
  verifyEvent(copy) { return String(copy.content).includes('"keep":1'); },
  getEventHash(copy) { return copy.id; },
};
sandbox.NostrApp.relayUrls = ['wss://example.invalid'];
sandbox.NostrApp.pool = {
  list() {
    return [
      dirEvent({ keep: 1, deviceLabel: 'Old', authorization: { accountP: account, deviceId: device, D_sign_pub: device, D_enc_pub: device, capabilities: ['DEVICE_CHAT'], createdAt: 1000 } }, device, 100),
      dirEvent({ keep: 1, deviceLabel: 'Windows', authorization: { accountP: account, deviceId: device, D_sign_pub: device, D_enc_pub: device, capabilities: ['DEVICE_CHAT'], createdAt: 2000 } }, device, 200),
      dirEvent({ keep: 1, authorization: { accountP: other, deviceId: foreign, D_sign_pub: foreign, D_enc_pub: foreign, capabilities: ['DEVICE_CHAT'] } }, foreign, 300),
      dirEvent({ keep: 0, authorization: { accountP: account, deviceId: foreign, D_sign_pub: foreign, D_enc_pub: foreign, capabilities: ['DEVICE_CHAT'] } }, foreign, 400),
    ];
  },
};
sandbox.NostrApp.Md4DeviceAuth = {
  verifyForDestination(auth) { return Promise.resolve({ ok: String(auth.accountP) === account }); },
};

sandbox.SosAccountSession.listAccountLinkedDevices(account).then(async (listed) => {
  const row = listed && listed.devices && listed.devices[0];
  check('verified directory device is listed once', !!(listed && listed.ok === true && listed.devices.length === 1 && row.deviceLabel === 'Windows' && row.lastSeenAt === 200000));
  const calls = await sandbox.SosAccountSession.listAuthorizedDevices(account, 'DEVICE_CALLS');
  check('call capability filter still applies', Array.isArray(calls) && calls.length === 0);
  sandbox.NostrTools.verifyEvent = function (copy) {
    const content = String(copy.content || '');
    return content.includes('"keep":1') || content.includes('"revoked"');
  };
  sandbox.NostrApp.pool.list = function () {
    return [
      dirEvent({ keep: 1, deviceLabel: 'Windows', authorization: { accountP: account, deviceId: device, D_sign_pub: device, D_enc_pub: device, capabilities: ['DEVICE_CHAT'], createdAt: 2000 } }, device, 200),
      {
        kind: 30078,
        pubkey: account,
        id: 'd'.repeat(64),
        sig: 'e'.repeat(128),
        created_at: 500,
        tags: [['d', 'sos-device-revocation']],
        content: JSON.stringify({ v: 1, revoked: [{ deviceSignPub: device, authorizationId: 'e'.repeat(64), at: 5 }] }),
      },
    ];
  };
  const after = await sandbox.SosAccountSession.listAccountLinkedDevices(account);
  check('revoked device leaves the phone list', !!(after && after.ok === true && after.devices.length === 0));
  console.log(failed ? 'STATUS=FAIL' : 'STATUS=PASS');
  process.exit(failed ? 1 : 0);
}).catch((err) => {
  console.log('FAIL directory list threw ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
