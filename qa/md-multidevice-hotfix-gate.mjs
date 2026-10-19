import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const chat = read('chat-service.js');
const session = read('sos-account-session.js');
const guest = read('guest-access-control.js');
const calls = read('call-signal-e2ee.js');
const p2p = read('p2p-video-sharing.js');
let fail = 0;
function check(name, ok) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
  if (!ok) fail += 1;
}
const delegated = chat.slice(chat.indexOf('async function publishDelegatedChatMessage'), chat.indexOf('async function publishChatMessage'));
check('delegated send waits for relay promises', delegated.includes('awaitRelayAccepted') && !delegated.includes('await pool.publish'));
check('delegated send replaces optimistic temp', delegated.includes('replaceOutgoingTempMessage'));
check('delegated send syncs to the phone', delegated.includes('sibling: true'));
check('own-device mirror is separate from the recipient copy', chat.includes("publishAuthorizedDeviceCopies(App.publicKey") && chat.includes('sos-own-sync'));
check('incoming device thread uses the account', chat.includes("kind: 'INCOMING_DEVICE_COPY'") && chat.includes("kind: 'INCOMING_FROM_EXTERNAL_ACCOUNT'") && chat.includes('to: account'));
check('md3 reject is logged', chat.includes('[MD3] rejected'));
check('linked device is not an unknown p2p principal', guest.includes("code: 'LINKED_DEVICE'") && guest.includes('DEVICE_P2P'));
check('call ring fans out to devices', calls.includes('CALL_DEVICE_FANOUT') && calls.includes('listAuthorizedDevices'));
check('linked heartbeat records relay ack', p2p.includes('LINKED_HEARTBEAT_RELAY_ACK'));
check('sibling tag carries the conversation peer', session.includes("tags.push(['sync-peer', norm(peer)])"));
console.log(fail ? 'STATUS=FAIL' : 'STATUS=PASS');
process.exit(fail ? 1 : 0);
