#!/usr/bin/env node
/**
 * History relay-load contract.
 * One unchanged snapshot is reused, one file is not probed once per retry,
 * and a frozen page does not start a transfer storm.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const session = fs.readFileSync(path.join(root, 'sos-account-session.js'), 'utf8');
const video = fs.readFileSync(path.join(root, 'p2p-video-sharing.js'), 'utf8');
const logger = fs.readFileSync(path.join(root, 'chat-request-logger.js'), 'utf8');
const videos = fs.readFileSync(path.join(root, 'videos.html'), 'utf8');
let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed += 1;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' ' + detail : ''));
}

check('stable snapshot id', session.includes("norm(App.publicKey) + ':' + peer + ':' + inventoryKey"));
check('no clock snapshot id', !session.includes("':' + String(Date.now()) + ':' + messages.length"));
check('inventory reuse', session.includes('prior.inventoryKey === inventoryKey'));
check('stale request', session.includes('STALE_REQUEST'));
check('join window', session.includes('Date.now() - latest.at) < 25000'));
check('no shared p2p timer', !session.includes('__sosHistP2PTimer'));
check('one probe before files', session.includes('async function probeHistoryPeer'));
check('waiting state', session.includes("noteHistoryDevice(peer, 'WAITING_FOR_DEVICE')"));
check('suspend', session.includes("onHide('freeze')") && session.includes("code: 'SUSPENDED'"));
check('checkpoint', session.includes('function writeHistCheckpoint'));
check('peer sub closed on timeout', video.includes('let sub = null;') && video.includes('sub.close()'));
check('linked sub not recreated', !video.includes('keys.linkedDevice) {\n      try { if (typeof App._p2pSignalsSub.close'));
check('feed yields during history send', video.includes('window.__sosHistSyncActive === true'));
check('logger batches', logger.includes('function scheduleSave') && !logger.includes("save();\n  }\n\n  // חלק סיכום"));
check('active sub counter', logger.includes('SUBSCRIPTION_ACTIVE n='));
check('package', videos.includes('sos-account-session.js?v=20261020&pkg=899s54') && videos.includes('p2p-video-sharing.js?v=20261020&pkg=899s53'));
check('72 hour window', session.includes('HIST_RECENT_SEC = 72 * 3600') && session.includes('HISTORY_WINDOW_V2'));
check('older week', session.includes('HIST_OLDER_SEC = 7 * 86400') && session.includes("scope === 'older'"));
check('recent is not a full backup', session.includes('FULL_BACKUP_COMPLETE: false') && session.includes('RECENT_HISTORY_SYNC_COMPLETE'));

function backoff(fails) {
  return Math.min(120000, 15000 * Math.pow(2, Math.min(fails - 1, 3)));
}
check('backoff grows', backoff(1) === 15000 && backoff(2) === 30000 && backoff(4) === 120000 && backoff(8) === 120000);

const seen = {};
const latest = {};
function accept(device, id, created, now) {
  if (seen[id]) return 'duplicate';
  seen[id] = true;
  if ((Math.floor(now / 1000) - created) > 600) return 'stale';
  const prev = latest[device];
  if (prev && prev.created > created) return 'duplicate';
  if (prev && prev.at && (now - prev.at) < 25000) return 'join';
  latest[device] = { created: created, at: now };
  return 'start';
}
const t0 = 1_700_000_000_000;
check('burst joins', accept('dev', 'a', 1_700_000_000, t0) === 'start' && accept('dev', 'b', 1_700_000_010, t0 + 1000) === 'join');
check('stale dropped', accept('dev', 'c', 1_700_000_000 - 1000, t0) === 'stale');
check('older dropped', accept('dev', 'd', 1_700_000_000 - 5, t0 + 30000) === 'duplicate');
check('later device starts', accept('other', 'e', 1_700_000_020, t0 + 30000) === 'start');

console.log(failed ? 'FAIL ' + failed : 'PASS history-relay-load-gate');
process.exit(failed ? 1 : 0);
