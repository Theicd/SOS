#!/usr/bin/env node
/**
 * Stage 5A: encrypted voice prefers secure Blossom over P2P.
 * Local only. No network. No plaintext bytes logged.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const audioSrc = fs.readFileSync(path.join(ROOT, 'chat-audio-player.js'), 'utf8');

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

record('resolver exported', /resolveDurableVoicePlayback/.test(audioSrc));
record('blossom token', /VOICE_SOURCE_BLOSSOM_E2EE/.test(audioSrc));
record('local token', /VOICE_SOURCE_LOCAL/.test(audioSrc));
record('p2p token', /VOICE_SOURCE_P2P/.test(audioSrc));
record('blossom fail token', /VOICE_BLOSSOM_RESOLVE_FAILED/.test(audioSrc));
record('decrypt fail token', /VOICE_DECRYPT_FAILED/.test(audioSrc));
record('secure resolver used', /App\.resolveServerMediaAttachment\(att/.test(audioSrc));
record('fail closed blocks torrent', /voiceFailClosed === 'true'/.test(audioSrc) && /durableHydrated === 'true'/.test(audioSrc));
record('encrypted skips plaintext fallback', /voiceEncrypted === 'true' \? '' : fallbackSrc/.test(audioSrc));

function descriptor() {
  return {
    v: 2,
    type: 'encrypted-media',
    enc: { alg: 'aes-gcm' },
    cipher: { sha256: 'a'.repeat(64), size: 32 },
    media: { mime: 'audio/webm', filename: 'voice-message.webm' },
    resource: { transport: 'blossom', url: 'https://blossom.example/cipher' },
    chunks: [{ index: 0 }],
    context: { messageId: 'cmsg-1' },
    clientMessageId: 'cmsg-1',
    logicalMessageId: 'cmsg-1',
    magnetURI: 'magnet:?xt=urn:btih:' + 'b'.repeat(40),
    isVoice: true,
  };
}

function load(mocks) {
  const App = Object.assign({
    isEncryptedBlossomDescriptor(att) {
      return !!(att && att.v === 2 && att.type === 'encrypted-media' && att.resource && att.resource.transport === 'blossom' && att.resource.url);
    },
    resolveChatMediaSrc: async () => '',
    persistChatP2PMedia: async () => 'k',
  }, mocks);
  const sandbox = { window: { NostrApp: App }, console, URL, Blob };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(audioSrc, sandbox, { filename: 'chat-audio-player.js' });
  return App;
}

const seen = [];
const appA = load({
  async resolveServerMediaAttachment(att) {
    seen.push(att);
    return { objectUrl: 'blob:decrypted', blob: new Blob(['ok'], { type: 'audio/webm' }) };
  },
});
const original = descriptor();
const a = await appA.resolveDurableVoicePlayback(original, {
  messageId: 'cmsg-1',
  sender: 'a'.repeat(64),
  recipient: 'b'.repeat(64),
});
record('A blossom source', a.source === 'VOICE_SOURCE_BLOSSOM_E2EE' && a.src === 'blob:decrypted');
record('A same descriptor object', seen[0] === original);
record('A keeps enc', seen[0] && seen[0].enc && seen[0].enc.alg === 'aes-gcm');
record('A keeps cipher', seen[0] && seen[0].cipher && seen[0].cipher.size === 32);
record('A keeps resource', seen[0] && seen[0].resource && seen[0].resource.transport === 'blossom');
record('A keeps chunks', Array.isArray(seen[0] && seen[0].chunks));
record('A keeps context', !!(seen[0] && seen[0].context));
record('A magnet does not block blossom', a.ok === true);

let blossomCalls = 0;
const appB = load({
  async resolveChatMediaSrc() {
    return 'blob:cached-local';
  },
  async resolveServerMediaAttachment() {
    blossomCalls += 1;
    return { objectUrl: 'blob:should-not', blob: new Blob(['x']) };
  },
});
const b = await appB.resolveDurableVoicePlayback(descriptor(), { messageId: 'cmsg-1', sender: 'aa', recipient: 'bb' });
record('B local before blossom', b.source === 'VOICE_SOURCE_LOCAL' && blossomCalls === 0);

const appC = load({
  async resolveServerMediaAttachment(att) {
    record('C descriptor still v2', att.v === 2 && att.type === 'encrypted-media');
    return { objectUrl: 'blob:reload', blob: new Blob(['ok'], { type: 'audio/webm' }) };
  },
});
const persisted = descriptor();
persisted.url = 'blob:dead-after-reload';
const c = await appC.resolveDurableVoicePlayback(persisted, { messageId: 'cmsg-1', sender: 'aa', recipient: 'bb' });
record('C reload uses blossom', c.source === 'VOICE_SOURCE_BLOSSOM_E2EE');

const appD = load({
  async resolveServerMediaAttachment() {
    return { objectUrl: 'blob:offline-sender', blob: new Blob(['ok'], { type: 'audio/webm' }) };
  },
});
const d = await appD.resolveDurableVoicePlayback(descriptor(), { messageId: 'cmsg-1', sender: 'aa', recipient: 'bb' });
record('D no torrent inside resolver', d.source === 'VOICE_SOURCE_BLOSSOM_E2EE' && !/tryLoadAudioFromTorrent\(/.test(audioSrc.slice(audioSrc.indexOf('async function resolveDurableVoicePlayback'), audioSrc.indexOf('function createEnhancedAudioPlayer'))));

const appE = load({
  async resolveServerMediaAttachment() {
    const err = new Error('hash');
    err.code = 'MEDIA_E2EE_HASH_MISMATCH';
    throw err;
  },
});
const e = await appE.resolveDurableVoicePlayback(descriptor(), { messageId: 'cmsg-1', sender: 'aa', recipient: 'bb' });
record('E fail closed', e.source === 'VOICE_DECRYPT_FAILED' && e.failClosed === true && e.src === '');

const appNet = load({
  async resolveChatMediaSrc() {
    return 'https://blossom.example/cipher';
  },
  async resolveServerMediaAttachment() {
    const err = new Error('down');
    err.code = 'BLOSSOM_DOWNLOAD_FAILED';
    throw err;
  },
});
const net = await appNet.resolveDurableVoicePlayback(descriptor(), { fallbackSrc: 'https://blossom.example/cipher' });
record('E no ciphertext url', net.src === '' && net.source === 'VOICE_BLOSSOM_RESOLVE_FAILED' && net.failClosed === false);

console.log(results.join('\n'));
console.log(fail ? 'VOICE_BLOSSOM_PRIORITY_GATE FAIL (' + pass + ' passed, ' + fail + ' failed)' : 'VOICE_BLOSSOM_PRIORITY_GATE PASS (' + pass + ' passed, 0 failed)');
process.exit(fail ? 1 : 0);
