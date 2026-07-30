#!/usr/bin/env node
// חלק QA (scripts/qa-file-transfer-invariants.js) – בדיקות סטטיות להעברת קבצים בלי דפדפן | HYPER CORE TECH
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
let fail = 0;
const results = [];

function test(name, ok) {
  if (ok) {
    pass++;
    results.push(`✅ ${name}`);
  } else {
    fail++;
    results.push(`❌ ${name}`);
  }
}

const p2p = read('chat-p2p-file.js');
const ui = read('chat-ui.js');
const monitor = read('chat-transfer-monitor.js');
const fileUi = read('chat-file-transfer-ui.js');

test('CHUNK_SIZE is 64KB', /CHUNK_SIZE\s*=\s*64\s*\*\s*1024/.test(p2p));
test('no unreliable maxRetransmits on file DC', !/createDataChannel\(\s*['"]file-transfer['"]\s*,\s*\{[^}]*maxRetransmits\s*:/.test(p2p));
test('cancelP2PFile exported', /cancelP2PFile/.test(p2p) && /P2P_FILE_CHUNK_SIZE/.test(p2p));
test('resend cooldown exists', /RESEND_COOLDOWN_MS/.test(p2p));
test('bidirectional preferred receive map', /peerPreferredReceiveFileId/.test(p2p));
test('no showToast for resend string', !/showToast\(`🔄 שולח מחדש/.test(p2p));
test('no showToast for stall string', !/showToast\(`⏱️ העברת/.test(p2p));
test('UI in-place update path', /עדכון במקום/.test(ui) || /existing && existing\.querySelector\('\.torrent-bubble'\)/.test(ui));
test('UI avoids ממתין להמשך flip', !/ממתין להמשך\.\.\./.test(ui));
test('monitor suppresses transfer toasts', /toast-suppressed/.test(monitor));
test('file-ui no alternate-path toast', !/הקובץ נשלח במסלול חלופי/.test(fileUi));
test('tests cover large + bidir', /7\.6 קובץ גדול/.test(read('chat-file-transfer-tests.js')));

console.log('═══ QA File Transfer Invariants ═══');
results.forEach((r) => console.log(r));
console.log(fail === 0 ? `\n${pass}/${pass + fail} passed ✅` : `\n${pass}/${pass + fail} passed, ${fail} FAILED ⚠️`);
process.exit(fail === 0 ? 0 : 1);
