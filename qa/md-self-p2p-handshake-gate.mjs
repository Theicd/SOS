#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const dc = read('chat-p2p-datachannel.js');
const session = read('sos-account-session.js');
let failed = 0;
function check(name, ok) {
  if (!ok) failed += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
}

const phone = 'ede1e7fa' + 'ab'.repeat(28);
const desk = '59e28af4' + 'cd'.repeat(28);
check('phone endpoint is the responder', !(phone < desk));
check('desktop endpoint is the initiator', desk < phone);
check('roles use the local endpoint', dc.includes('function localEndpointPub()') && dc.includes('function amInitiator(peer)') && dc.includes('const local = localEndpointPub()'));
check('room id uses the local endpoint', dc.includes('function roomId(p)') && dc.includes('const a = localEndpointPub()'));
check('account signature is not dropped before the endpoint check', !dc.includes('if (event.pubkey === App.publicKey) return;'));
check('target must be the local endpoint', dc.includes("reason=TARGET_MISMATCH") && dc.includes('hex64(pTag[1]) !== local'));
check('linked desktop signs with its device key', dc.includes('async function signLinkedSignal') && dc.includes('withLinkedDeviceSigner'));
check('linked desktop decrypts with its device key', dc.includes('NT.nip04.decrypt(dev.privHex, author, content)'));
check('primary still uses the root signal signer', dc.includes('signP2pSignal'));
check('same-account device must be authorized', session.includes('async function classifyP2pSignalAuthor') && session.includes("code: 'SAME_ACCOUNT_DEVICE'") && session.includes("code: 'REVOKED'") && session.includes("code: 'CAPABILITY_DENIED'"));
check('signal trace names the drops', dc.includes('SIG_PUBLISHED') && dc.includes('SIG_RELAY_ACCEPTED') && dc.includes('DC_NEED_OFFER_RX') && dc.includes('DC_OFFER_SENT') && dc.includes('DATA_CHANNEL_OPEN'));
check('root key is not copied onto the desktop path', !dc.includes('App.privateKey =') && session.includes('ROOT_K_ON_DESKTOP: false'));
check('linked device signs before any root signer', dc.includes('if (onDevice) signed = await signLinkedSignal(remote, type, raw);'));
check('self-chat completion does not upload the file', read('chat-p2p-file.js').includes('owned.selfChat !== true'));
check('missing queued bytes are not a completed transfer', read('chat-p2p-file.js').includes('FILE_BYTES_UNAVAILABLE'));

const bundle = fs.readFileSync(path.join(ROOT, 'vendor', 'nostr.bundle.min.js'), 'utf8');
const sandbox = {
  console,
  crypto: globalThis.crypto,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  Map,
  Set,
  Uint8Array,
  Array,
  String,
  Number,
  Date,
  Math,
  JSON,
  TextEncoder,
  TextDecoder,
  URL,
  Blob,
  location: { search: '' },
  navigator: { userAgent: 'gate' },
  document: {
    readyState: 'complete',
    documentElement: { getAttribute() { return ''; }, setAttribute() {} },
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(bundle, sandbox);
sandbox.NostrTools = sandbox.NostrTools;
sandbox.NostrApp = {
  relayUrls: ['wss://gate.invalid'],
  guestMode: false,
  publicKey: '',
  privateKey: null,
  linkedDeviceSession: false,
  RTC_ICE_SERVERS: [],
  SosCryptoSigner: { hasIdentityKey() { return sandbox.__primary === true; } },
  pool: {
    subscribeMany() { return { close() {}, unsub() {} }; },
    querySync(_urls, filter) {
      const tag = filter && filter['#d'] && filter['#d'][0];
      const author = filter && filter.authors && filter.authors[0];
      const table = tag === 'sos-device-revocation' ? sandbox.__revs : sandbox.__dirs;
      const event = table && table[author];
      return event ? [event] : [];
    },
  },
  Md4DeviceAuth: {
    async verifyForDestination(auth) {
      const mode = sandbox.__modes && sandbox.__modes[String(auth.D_sign_pub || '').toLowerCase()];
      if (mode) return { ok: false, code: mode };
      return { ok: true };
    },
  },
};
sandbox.__dirs = {};
sandbox.__revs = {};
sandbox.__modes = {};
vm.runInContext(session, sandbox);
vm.runInContext(dc, sandbox);
const NT = sandbox.NostrTools;
const Session = sandbox.NostrApp.SosAccountSession;

function party() {
  const sk = NT.generateSecretKey();
  return { sk, pk: NT.getPublicKey(sk) };
}
function hexOf(sk) {
  return Array.from(sk).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function directory(device, accountP, caps, enc) {
  sandbox.__signSk = device.sk;
  sandbox.__payload = JSON.stringify({
    authorization: {
      accountP,
      deviceId: '11'.repeat(32),
      D_sign_pub: device.pk,
      D_enc_pub: enc,
      capabilities: caps,
      authorizationId: 'ab'.repeat(32),
    },
  });
  return vm.runInContext("NostrTools.finalizeEvent({kind:30078,created_at:Math.floor(Date.now()/1000),tags:[['d','sos-device-directory']],content:__payload}, __signSk)", sandbox);
}
function revocation(account, devicePk) {
  sandbox.__signSk = account.sk;
  sandbox.__payload = JSON.stringify({ revoked: [{ deviceSignPub: devicePk, authorizationId: 'cd'.repeat(32) }] });
  return vm.runInContext("NostrTools.finalizeEvent({kind:30078,created_at:Math.floor(Date.now()/1000),tags:[['d','sos-device-revocation']],content:__payload}, __signSk)", sandbox);
}

const phoneKey = party();
const deskKey = party();
const other = party();
const enc = party();
sandbox.NostrApp.publicKey = phoneKey.pk;
sandbox.NostrApp.guestMode = false;
sandbox.NostrApp.adoptLinkedDeviceSession({
  accountP: phoneKey.pk,
  deviceSignPub: deskKey.pk,
  deviceId: '22'.repeat(32),
  caps: ['DEVICE_CHAT', 'DEVICE_P2P'],
});
const primaryToDevice = await Session.classifyP2pSignalAuthor(phoneKey.pk);
check('primary signal to its desktop is authorized', primaryToDevice.ok === true && primaryToDevice.code === 'PRIMARY_TO_DEVICE' && primaryToDevice.SIGNAL_MD3_AUTHORIZED === true);
const selfEndpoint = await Session.classifyP2pSignalAuthor(deskKey.pk);
check('desktop does not accept its own endpoint', selfEndpoint.ok === false && selfEndpoint.code === 'SELF_ENDPOINT');

sandbox.__dirs[other.pk] = directory(other, other.pk, ['DEVICE_CHAT'], enc.pk);
const externalDevice = await Session.classifyP2pSignalAuthor(other.pk);
check('another account device stays a foreign device', externalDevice.ok === true && externalDevice.code === 'EXTERNAL_DEVICE' && externalDevice.accountP === other.pk);

sandbox.NostrApp.SosAccountSession.releaseLinkedDevice('TEST');
sandbox.NostrApp.publicKey = phoneKey.pk;
sandbox.NostrApp.guestMode = false;
sandbox.NostrApp.linkedDeviceSession = false;
sandbox.__primary = true;
const sibling = party();
sandbox.__dirs[sibling.pk] = directory(sibling, phoneKey.pk, ['DEVICE_CHAT'], enc.pk);
const same = await Session.classifyP2pSignalAuthor(sibling.pk);
check('primary accepts its authorized desktop', same.ok === true && same.code === 'SAME_ACCOUNT_DEVICE' && same.SIGNAL_MD3_AUTHORIZED === true);

const bare = party();
const foreign = await Session.classifyP2pSignalAuthor(bare.pk);
check('independent account does not need a device directory', foreign.ok === true && foreign.code === 'EXTERNAL_ACCOUNT' && foreign.SIGNAL_MD3_AUTHORIZED === false);

const weak = party();
sandbox.__dirs[weak.pk] = directory(weak, phoneKey.pk, ['DEVICE_CALLS'], enc.pk);
const denied = await Session.classifyP2pSignalAuthor(weak.pk);
check('device without chat capability is rejected', denied.ok === false && denied.code === 'CAPABILITY_DENIED');

const expired = party();
sandbox.__modes[expired.pk] = 'EXPIRED';
sandbox.__dirs[expired.pk] = directory(expired, phoneKey.pk, ['DEVICE_CHAT'], enc.pk);
const expiredResult = await Session.classifyP2pSignalAuthor(expired.pk);
check('expired device authorization is rejected', expiredResult.ok === false && expiredResult.code === 'EXPIRED');

const forgedAuth = party();
sandbox.__modes[forgedAuth.pk] = 'BAD_SIGNATURE';
sandbox.__dirs[forgedAuth.pk] = directory(forgedAuth, phoneKey.pk, ['DEVICE_CHAT'], enc.pk);
const forgedAuthResult = await Session.classifyP2pSignalAuthor(forgedAuth.pk);
check('forged device authorization is rejected', forgedAuthResult.ok === false && forgedAuthResult.code === 'BAD_SIGNATURE');

const encAsSign = party();
sandbox.__dirs[encAsSign.pk] = directory(encAsSign, phoneKey.pk, ['DEVICE_CHAT'], encAsSign.pk);
const encResult = await Session.classifyP2pSignalAuthor(encAsSign.pk);
check('encryption key is not a signal endpoint', encResult.ok === false && encResult.code === 'D_ENC_NOT_SIGNAL');

const revokedAccount = party();
const revokedDevice = party();
sandbox.__revs[revokedAccount.pk] = revocation(revokedAccount, revokedDevice.pk);
sandbox.__dirs[revokedDevice.pk] = directory(revokedDevice, revokedAccount.pk, ['DEVICE_P2P'], enc.pk);
const revokedResult = await Session.classifyP2pSignalAuthor(revokedDevice.pk);
check('revoked device is rejected', revokedResult.ok === false && revokedResult.code === 'REVOKED');

const forged = party();
const forgedEvent = directory(forged, phoneKey.pk, ['DEVICE_CHAT'], enc.pk);
forgedEvent.sig = '00'.repeat(64);
sandbox.__dirs[forged.pk] = forgedEvent;
const forgedEventResult = await Session.classifyP2pSignalAuthor(forged.pk);
check('forged directory event is rejected', forgedEventResult.ok === false && forgedEventResult.code === 'BAD_EVENT_SIG');

const plain = JSON.stringify({ type: 'offer', sdp: 'v=0' });
const sealed = await NT.nip04.encrypt(hexOf(phoneKey.sk), deskKey.pk, plain);
const opened = await NT.nip04.decrypt(hexOf(deskKey.sk), phoneKey.pk, sealed);
const sealedBack = await NT.nip04.encrypt(hexOf(deskKey.sk), phoneKey.pk, plain);
const openedBack = await NT.nip04.decrypt(hexOf(phoneKey.sk), deskKey.pk, sealedBack);
check('device and account signal encryption match both ways', opened === plain && openedBack === plain);

sandbox.NostrApp.strictVerifyNostrEvent = (event) => NT.verifyEvent(event) === true;
sandbox.__signSk = phoneKey.sk;
sandbox.__payload = sealed;
sandbox.__peer = deskKey.pk;
const signal = vm.runInContext("NostrTools.finalizeEvent({kind:25055,created_at:Math.floor(Date.now()/1000),tags:[['type','dc-need-offer'],['p',__peer]],content:__payload}, __signSk)", sandbox);
check('valid signal signature is accepted', sandbox.NostrApp.dataChannel.verifyIncomingRelayEvent(signal) === true);
sandbox.__signal = signal;
const broken = vm.runInContext("({id:__signal.id,pubkey:__signal.pubkey,created_at:__signal.created_at,kind:__signal.kind,tags:__signal.tags.map(function(tag){return tag.slice();}),content:__signal.content,sig:'" + '11'.repeat(64) + "'})", sandbox);
check('forged signal signature is rejected', sandbox.NostrApp.dataChannel.verifyIncomingRelayEvent(broken) === false);

const phoneEp = 'ede1e7fa' + 'ab'.repeat(28);
const deskEp = '59e28af4' + 'cd'.repeat(28);
sandbox.NostrApp.SosAccountSession.releaseLinkedDevice('ROLE');
sandbox.__primary = false;
sandbox.NostrApp.adoptLinkedDeviceSession({
  accountP: phoneEp,
  deviceSignPub: deskEp,
  deviceId: '33'.repeat(32),
  caps: ['DEVICE_CHAT'],
});
check('recorded desktop is the only initiator', sandbox.NostrApp.dataChannel.amInitiator(phoneEp) === true && sandbox.NostrApp.dataChannel.amInitiator(deskEp) === false);

if (failed) {
  console.log('STATUS=FAIL failed=' + failed);
  process.exit(1);
}
console.log('STATUS=PASS_SELF_P2P_HANDSHAKE');
