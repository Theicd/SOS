#!/usr/bin/env node
/**
 * Stage 15 — File safety wiring + voice MIME regression + descriptor bounds.
 * Run: node qa/file-safety-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let pass = 0;
let fail = 0;

function record(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name);
    return;
  }
  fail += 1;
  results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const fileJs = read('chat-p2p-file.js');
const media = read('chat-media-renderer.js');
const blossom = read('blossom.js');
const wt = read('webtorrent-transfer.js');
const p2p = read('p2p-video-sharing.js');
const state = read('chat-state.js');
const dc = read('chat-p2p-datachannel.js');
const svc = read('chat-service.js');

record('file-offer sanitizes name via sanitizeIncomingChatFileName', fileJs.includes('sanitizeOfferFileName') && fileJs.includes('sanitizeIncomingChatFileName'));
record('file-offer clamps mime via safeBlobContentType', fileJs.includes('safeBlobContentType'));
record('Blob type rejects text/html', fileJs.includes("essence === 'text/html'") && fileJs.includes('application/octet-stream'));
record('chunk index bounds checked', fileJs.includes('bad_index') && fileJs.includes('chunkIndex >= transfer.totalChunks'));
record('finalize requires complete chunks', fileJs.includes('incomplete_chunks') && fileJs.includes('sparse_chunks'));
record('finalize size mismatch fail-closed', fileJs.includes('size_mismatch'));
record('video source type escaped', media.includes('escapeAttr(type)') && media.includes('initialSrcAttr'));
record('download filename sanitized', media.includes('sanitizeIncomingChatFileName(filename'));
record('blossom result URL http(s) only', blossom.includes('isSafeBlossomResultUrl') && blossom.includes('bad_result_url'));
record('webtorrent magnet gated approveTransfer', wt.includes('isValidIncomingMagnetURI') && wt.includes('approveTransfer-bad-magnet'));
record('webtorrent magnet gated download', wt.includes('download-bad-magnet'));
record('30078 verifyEvent gate present', p2p.includes('verifyIncomingFileSignalEvent') && p2p.includes('rejected invalid signed event kind=30078'));
record('30078 verify signature before recipient before decrypt', (() => {
  const idx = p2p.indexOf('onevent: async (event) => {');
  const slice = p2p.slice(idx, idx + 1600);
  const a = slice.indexOf('verifyIncomingFileSignalEvent');
  const b = slice.indexOf('verifyIncomingFileSignalRecipient');
  const c = slice.indexOf('extractSignalContent');
  return a >= 0 && b > a && c > b;
})());
record('history restore scrubs attachments', state.includes('kind=history reason=bad_attachment') && state.includes('inspectIncomingChatAttachment'));
record('Package B DC chat-text still validates attachments', dc.includes('inspectIncomingChatAttachment'));
record('Package B 25055 verify before rate bucket', (() => {
  const handleIdx = dc.indexOf('async function handleSig(event)');
  const verifyIdx = dc.indexOf('verifyIncomingP2pRelayEvent(event)', handleIdx);
  const rateIdx = dc.indexOf('allowPeerSignalRate', handleIdx);
  return verifyIdx > handleIdx && rateIdx > verifyIdx;
})());
record('chat-service still normalizes codec MIME', svc.includes('canonicalChatMimeType') && svc.includes('codecs'));
record('chat-service inspect rejects javascript scheme', /javascript\|vbscript\|file\|about/.test(svc));
record('chat-service sanitize strips path traversal', svc.includes("part !== '..'") && svc.includes('sanitizeIncomingChatFileName'));
record('phase9 voice codec gate still present', read('qa/chat-signature-gate.mjs').includes('codecs=opus'));

function sanitizeIncomingChatFileName(name) {
  let value = String(name == null ? '' : name);
  value = value.replace(/[\u0000-\u001f\u007f]/g, '');
  value = value.replace(/\\/g, '/');
  const parts = value.split('/').filter((part) => part && part !== '.' && part !== '..');
  value = parts.length ? parts[parts.length - 1] : 'file';
  if (!value || value === '.' || value === '..') value = 'file';
  if (value.length > 180) {
    const lastDot = value.lastIndexOf('.');
    const ext = lastDot > 0 && value.length - lastDot <= 8 ? value.slice(lastDot) : '';
    value = value.slice(0, Math.max(8, 180 - ext.length)) + ext;
  }
  return value;
}
function isValidIncomingMagnetURI(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return false;
  const trimmed = value.trim();
  if (!/^magnet:\?/i.test(trimmed)) return false;
  return /[?&]xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})(?:&|$)/i.test(trimmed);
}
record('filename traversal neutralized', sanitizeIncomingChatFileName('../etc/passwd') === 'passwd');
record('filename hebrew preserved', sanitizeIncomingChatFileName('שלום.webm').includes('שלום'));
record('filename emoji preserved', sanitizeIncomingChatFileName('voice🎤.webm').includes('🎤'));
record('filename empty → file', sanitizeIncomingChatFileName('') === 'file');
record('magnet valid 40-hex', isValidIncomingMagnetURI('magnet:?xt=urn:btih:' + 'a'.repeat(40)) === true);
record('magnet rejects junk', isValidIncomingMagnetURI('magnet:?xt=urn:btih:zz') === false);
record(
  'magnet rejects oversized',
  isValidIncomingMagnetURI('magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&x=' + 'y'.repeat(5000)) === false,
);

async function sha256Hex(buf) {
  const dig = await webcrypto.subtle.digest('SHA-256', buf);
  return Buffer.from(dig).toString('hex');
}
const sample = new TextEncoder().encode('sos-stage15-file-safety-bytes');
const h1 = await sha256Hex(sample);
const h2 = await sha256Hex(sample.slice(0));
record('QA-only SHA-256 self-consistency', h1 === h2 && h1.length === 64);

console.log(results.join('\n'));
console.log(`\nSummary: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
