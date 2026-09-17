#!/usr/bin/env node
/**
 * PRE-CUTOVER HOTFIX: durable voice playback source restoration
 * Static + light API checks — no network.
 *
 * Run: node qa/voice-durable-playback-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const audioSrc = read('chat-audio-player.js');
const mediaSrc = read('chat-media-renderer.js');

record('resolveVoiceCacheKey present', /function resolveVoiceCacheKey/.test(audioSrc));
record('hydrateDurableAudioSource present', /async function hydrateDurableAudioSource/.test(audioSrc));
record('hydrate uses resolveChatMediaSrc', /App\.resolveChatMediaSrc/.test(audioSrc));
record('hydrate uses loadChatP2PMediaBlob fallback', /App\.loadChatP2PMediaBlob/.test(audioSrc));
record('create strips dead blob: initial src', /if \(src\.startsWith\('blob:'\)\) src = ''/.test(audioSrc));
record('player emits data-cache-key', /data-cache-key/.test(audioSrc));
record('P2P success persists via persistChatP2PMedia', /App\.persistChatP2PMedia/.test(audioSrc) && /audio-p2p-persisted/.test(audioSrc));
record('_p2pCache remains session-only Map', /const _p2pCache = new Map\(\)/.test(audioSrc));
record('autoplayPending remembered on play', /autoplayPending/.test(audioSrc));
record('play awaits hydrate before blocked',
  /await hydratePromise/.test(audioSrc) && /Play blocked: no audio source/.test(audioSrc));

record('chatP2PCacheKey prefers attachment.cacheKey',
  /if \(att\.cacheKey\) return String\(att\.cacheKey\)/.test(mediaSrc));
record('chatP2PCacheKey supports fileId/attachmentId/msgId/infoHash',
  /p2p-file-\$\{att\.fileId\}/.test(mediaSrc)
  && /attachmentId/.test(mediaSrc)
  && /logicalMessageId/.test(mediaSrc)
  && /infoHash/.test(mediaSrc));
record('chatP2PCacheKey preserves p2p-msg-/p2p-ih- string keys',
  /\^p2p-\(file\|msg\|ih\)-/.test(mediaSrc));
record('resolveChatMediaSrc exported', /resolveChatMediaSrc,/.test(mediaSrc));
record('persistChatP2PMedia exported', /persistChatP2PMedia,/.test(mediaSrc));
record('loadChatP2PMediaBlob present', /async function loadChatP2PMediaBlob/.test(mediaSrc));
record('dead blob: verified before use', /src\.startsWith\('blob:'\)/.test(mediaSrc) && /fromDurable/.test(mediaSrc));

// Runtime: extract + eval chatP2PCacheKey (no full renderer DOM dependency)
function extractChatP2PCacheKey() {
  const m = mediaSrc.match(/function chatP2PCacheKey\([\s\S]*?\n  \}/);
  if (!m) return null;
  // extractMagnetInfoHash is referenced — stub it
  const fnSrc = `
    function extractMagnetInfoHash(magnet) {
      if (!magnet) return '';
      const mm = String(magnet).match(/btih:([a-fA-F0-9]+)/i);
      return mm ? mm[1].toLowerCase() : '';
    }
    ${m[0]}
    return chatP2PCacheKey;
  `;
  // eslint-disable-next-line no-new-func
  return new Function(fnSrc)();
}

const keyFn = extractChatP2PCacheKey();
record('chatP2PCacheKey extracted', typeof keyFn === 'function');

if (typeof keyFn === 'function') {
  record('key: cacheKey wins', keyFn({ cacheKey: 'p2p-file-abc', fileId: 'zzz' }) === 'p2p-file-abc');
  record('key: fileId', keyFn({ fileId: 'fid1' }) === 'p2p-file-fid1');
  record('key: attachmentId', keyFn({ attachmentId: 'att1' }) === 'p2p-file-att1');
  record('key: logicalMessageId', keyFn({ logicalMessageId: 'mid1' }) === 'p2p-msg-mid1');
  record('key: infoHash', keyFn({ infoHash: 'ABCDEF' }) === 'p2p-ih-abcdef');
  record('key: string p2p-msg preserved', keyFn('p2p-msg-mid9') === 'p2p-msg-mid9');
  record('key: raw fileId string', keyFn('rawid') === 'p2p-file-rawid');
}

record('callSignalGiftWrapRequired true (RC)',
  JSON.parse(read('app-version.json')).callSignalGiftWrapRequired === true);

console.log(results.join('\n'));
console.log(`\nVOICE_DURABLE_PLAYBACK_GATE ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
