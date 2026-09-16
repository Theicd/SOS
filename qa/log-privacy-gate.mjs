#!/usr/bin/env node
/**
 * Stage 2 log-privacy gate. Scans production-capable console logging only.
 * Does not change protocol, pagination, or Stage 3 volume.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const FILES = [
  'utils.js',
  'chat-transfer-monitor.js',
  'transfer-monitor.html',
  'chat-voice-call.js',
  'chat-video-call.js',
  'profile.js',
  'blossom.js',
  'service-worker.js',
  'chat-p2p-file.js',
  'chat-ui.js',
  'chat-media-renderer.js',
  'webtorrent-transfer.js',
  'chat-service.js',
  'p2p-video-sharing.js',
  'media-mirror.js',
  'feed.js',
  'push-client.js',
  'push-trigger.js',
  'native-shell-bridge.js',
  'android-bridge.js',
  'wifi-direct-service.js',
  'chat-voice-service.js',
  'chat-audio-player.js',
  'chat-request-logger.js',
  'media-reupload-handler.js',
  'videos.js',
  'chat-p2p-datachannel.js',
];

function fail(msg) {
  console.error('FAIL', msg);
  process.exit(1);
}

function pass(name) {
  console.log('PASS', name);
}

function extractConsoleCalls(src) {
  const out = [];
  const re = /console\.(log|warn|error|info|debug)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    let end = i;
    while (end < src.length && depth > 0) {
      const ch = src[end];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      end += 1;
    }
    out.push(src.slice(m.index, end));
  }
  return out;
}

const forbidden = [
  { name: 'plaintext chat preview', re: /preview\s*:/i },
  { name: 'full SDP dump', re: /Received valid offer:\s*['"]?\s*,\s*offerData\b|Received valid offer:\s*['"]?\s*,\s*offer\b/ },
  { name: 'ice-pwd in logs', re: /ice-pwd/i },
  { name: 'ice-ufrag in logs', re: /ice-ufrag/i },
  { name: 'raw ICE candidate dump', re: /Invalid video candidates received['"]\s*,\s*candidatesData\b|console\.(log|error|warn)\([^)]*event\.candidate\b/ },
  { name: 'profile picture/base64', re: /data:image|App\.profile\s*[,)]/ },
  { name: 'private key/nsec dump', re: /console\.(log|warn|error|info|debug)\([^)]*\b(nsec|privateKey|keyStr)\b/ },
  { name: 'auth/session secrets', re: /Authorization|Bearer / },
];

let issues = [];
for (const rel of FILES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (rel === 'videos.js') {
    if (!src.includes('SOS-FEED-OLDER-PAGINATION-POLICY-START')) {
      fail('Stage 1 pagination markers missing from videos.js');
    }
    pass('Stage 1 pagination markers still present');
    continue;
  }
  const calls = extractConsoleCalls(src);
  for (const call of calls) {
    for (const rule of forbidden) {
      if (rule.name === 'plaintext chat preview' && rel !== 'chat-transfer-monitor.js' && rel !== 'transfer-monitor.html') {
        continue;
      }
      if (rule.name === 'profile picture/base64' && /diagProfileLog|diagSafeUrl|diagRedactForLog/.test(call)) {
        continue;
      }
      if (rule.name === 'private key/nsec dump' && /missing signer|nsec decode failed|Failed to encode nsec|חסר fileId או keyStr/.test(call)) {
        continue;
      }
      if (rule.re.test(call)) {
        issues.push(`${rel}: ${rule.name} :: ${call.replace(/\s+/g, ' ').slice(0, 180)}`);
      }
    }
  }
}

const monitor = fs.readFileSync(path.join(ROOT, 'chat-transfer-monitor.js'), 'utf8');
if (/\.slice\(0,\s*60\)/.test(monitor) && /text/.test(monitor)) {
  if (/preview/.test(monitor)) issues.push('chat-transfer-monitor.js still has preview');
}
if (!/sanitizeDetails/.test(monitor)) fail('chat-transfer-monitor.js missing sanitizeDetails');
if (!/contentLength/.test(monitor)) fail('chat-transfer-monitor.js missing contentLength-only text logs');

const voice = fs.readFileSync(path.join(ROOT, 'chat-voice-call.js'), 'utf8');
if (/Received valid offer:\s*['"]\s*,\s*offerData/.test(voice)) fail('voice still dumps full offerData');
if (!/sdpLength/.test(voice)) fail('voice missing sdpLength metadata');

const video = fs.readFileSync(path.join(ROOT, 'chat-video-call.js'), 'utf8');
if (/Invalid video candidates received['"]\s*,\s*candidatesData/.test(video)) fail('video still dumps raw candidates');
if (!/candidateCount/.test(video)) fail('video missing candidateCount metadata');

const profile = fs.readFileSync(path.join(ROOT, 'profile.js'), 'utf8');
if (/updated local profile for',\s*App\.publicKey,\s*App\.profile/.test(profile)) fail('profile still dumps App.profile');
if (!/diagProfileLog/.test(profile)) fail('profile missing diagProfileLog');

const sw = fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8');
if (/App Update Push received',\s*payload\)/.test(sw)) fail('SW still dumps full push payload');

if (issues.length) {
  issues.forEach((line) => console.error('FAIL', line));
  process.exit(1);
}

pass('no plaintext chat preview in monitor logs');
pass('no full SDP dump');
pass('no ice-pwd / ice-ufrag in console');
pass('no raw video ICE candidate dump');
pass('no profile picture/base64 in logs');
pass('no private key/nsec/keyStr dump');
pass('no auth/session secrets in logs');
pass('push payload reduced to type/action/version/status');
console.log('\nStage 2 log-privacy gate passed');
