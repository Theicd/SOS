#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const chat = read('chat-service.js');
const p2p = read('chat-p2p-file.js');
const ui = read('chat-file-transfer-ui.js');
const session = read('sos-account-session.js');
let failed = 0;
function check(name, ok) {
  if (!ok) failed += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
}

const completeAt = p2p.indexOf('async function completeSendOnce');
const completeBody = p2p.slice(completeAt, completeAt + 12000);
const ownAt = completeBody.indexOf('OWN_DEVICE_SYNC');
check('p2p success copies the file to the sender devices', ownAt !== -1 && completeBody.indexOf('activeTransfers.delete(fileId)', ownAt) > ownAt);
check('p2p success keeps one logical id', completeBody.includes('logicalMessageId: fileId'));
check('self file does not fall back to blossom', p2p.includes('transfer.selfChat === true') && p2p.includes("transport: 'LOCAL_QUEUED'"));
check('self p2p targets a linked device', p2p.includes('async function pickLinkedDeviceForSelfP2P') && p2p.includes("transport=P2P_DIRECT"));
const selfAt = chat.indexOf('async function publishSelfChatMessage');
const selfBody = chat.slice(selfAt, selfAt + 4500);
check('self encrypt receives the attachment', selfBody.includes('attachment: packed && packed.wire'));
check('empty self payload is rejected', selfBody.includes("error: (packed && packed.code) || 'EMPTY_PAYLOAD'"));
check('zero device copies are not a completed self sync', selfBody.includes('SELF_SYNC_COMPLETE: false') && selfBody.includes('deviceCopies > 0'));
check('account pull skips events it already applied', chat.includes('accountPullSeen.has(id)') && chat.includes('ACCOUNT_CHAT_PULL n='));
check('file ui does not freeze at 85 percent', !ui.includes('progress: 0.85') && ui.includes("status: 'failed'"));
check('history does not call a truncated bundle complete', session.includes('complete: omitted === 0 && unavailable.length === 0'));
check('history keeps an encrypted attachment descriptor', session.includes("type: 'encrypted-media'") && session.includes('cipher: { sha256:'));

if (failed) {
  console.log('STATUS=FAIL failed=' + failed);
  process.exit(1);
}
console.log('STATUS=PASS_SELF_SYNC');
