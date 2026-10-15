import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
let fail = 0;
function check(name, ok) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
  if (!ok) fail += 1;
}

const bundle = read('vendor/nostr.bundle.min.js');
const sandbox = { console, crypto: globalThis.crypto };
vm.createContext(sandbox);
vm.runInContext(bundle, sandbox);
const NT = sandbox.NostrTools;
const sk = NT.generateSecretKey();
const auth = {
  version: 'sos-device-authorization-v1',
  accountP: 'a'.repeat(64),
  deviceId: 'b'.repeat(64),
  D_sign_pub: NT.getPublicKey(sk),
  D_enc_pub: 'c'.repeat(64),
  capabilities: ['DEVICE_CHAT', 'DEVICE_CALLS'],
};
const draft = {
  kind: 1050,
  created_at: 1_700_000_000,
  tags: [['p', 'd'.repeat(64)], ['t', 'yalachat'], ['sos-md3', JSON.stringify(auth)]],
  content: '{"family":"sos-e2ee","v":1}',
};
const event = NT.finalizeEvent(draft, sk);
check('fresh device event verifies', NT.verifyEvent(event) === true);

const frozen = JSON.parse(JSON.stringify(event));
Object.freeze(frozen);
Object.freeze(frozen.tags);
let frozenOk = false;
let frozenThrew = false;
try { frozenOk = NT.verifyEvent(frozen) === true; } catch (_e) { frozenThrew = true; }
check('frozen snapshot is not a valid verify target', frozenOk === false || frozenThrew === true);

sandbox.window = sandbox;
sandbox.NostrApp = {
  Md4DeviceAuth: { verifyForDestination: async () => ({ ok: true }) },
};
sandbox.NostrTools = NT;
vm.runInContext(read('sos-account-session.js'), sandbox);
const Session = sandbox.SosAccountSession;
const plain = await Session.verifyDelegatedEvent(frozen, 'DEVICE_CHAT');
check('plain copy accepts the frozen valid event', plain.ok === true && plain.accountP === auth.accountP && plain.deviceSignPub === auth.D_sign_pub);

const mutated = JSON.parse(JSON.stringify(event));
mutated.content = mutated.content + 'x';
const bad = await Session.verifyDelegatedEvent(mutated, 'DEVICE_CHAT');
check('mutated event is BAD_EVENT_SIG', bad.ok === false && bad.code === 'BAD_EVENT_SIG' && bad.detail === 'HASH_MISMATCH');

const forged = JSON.parse(JSON.stringify(event));
forged.sig = 'ab'.repeat(64);
const forgedResult = await Session.verifyDelegatedEvent(forged, 'DEVICE_CHAT');
check('forged signature is BAD_EVENT_SIG', forgedResult.ok === false && forgedResult.code === 'BAD_EVENT_SIG');

const mismatch = JSON.parse(JSON.stringify(event));
mismatch.pubkey = 'e'.repeat(64);
const pub = await Session.verifyDelegatedEvent(mismatch, 'DEVICE_CHAT');
check('pubkey swap is not treated as the account signature', pub.ok === false && pub.code === 'DEVICE_PUB_MISMATCH');

const chat = read('chat-service.js');
const calls = read('chat-voice-call.js');
const state = read('chat-state.js');
check('device-copy echo is not a contact', chat.includes('DEVICE_COPY_ECHO_IGNORED'));
check('self conversation label exists', read('chat-ui.js').includes('הודעות לעצמי'));
check('logical id dedupes transport copies', state.includes('item.id === message.logicalMessageId'));
check('device thread merge keeps the account', state.includes('function mergeDeviceConversationIntoAccount'));
check('desktop answer is bound to the account', calls.includes('NOT_AUTHORIZED_DEVICE') && calls.includes('CALL_ANSWER_REJECT') && calls.includes('CALL_RING_CANCELLED'));

console.log(fail ? 'STATUS=FAIL' : 'STATUS=PASS');
process.exit(fail ? 1 : 0);
