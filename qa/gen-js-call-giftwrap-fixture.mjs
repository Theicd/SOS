#!/usr/bin/env node
/**
 * Production JS gift-wrap fixture.
 * Uses the shipped nostr-tools 2.7.2 bundle and call-signal-e2ee.js in one VM realm.
 * Test keys only. Deterministic CSPRNG only inside this generator.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SENDER_PRIV = '0000000000000000000000000000000000000000000000000000000000000001';
const RECIPIENT_PRIV = '0000000000000000000000000000000000000000000000000000000000000002';

function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boot(seed) {
  const context = vm.createContext();
  let s = seed >>> 0;
  const next = mulberry32(s);
  context.crypto = {
    getRandomValues(arr) {
      for (let i = 0; i < arr.length; i += 1) arr[i] = Math.floor(next() * 256);
      return arr;
    },
  };
  context.console = console;
  vm.runInContext(`
    globalThis.TextEncoder = class TextEncoder {
      encode(input) {
        const s = String(input);
        const out = [];
        for (let i = 0; i < s.length; i += 1) {
          let c = s.charCodeAt(i);
          if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
            const c2 = s.charCodeAt(i + 1);
            if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
              c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
              i += 1;
            }
          }
          if (c < 0x80) out.push(c);
          else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
          else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
          else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
        }
        return new Uint8Array(out);
      }
    };
    globalThis.TextDecoder = class TextDecoder {
      decode(input) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        let out = '';
        for (let i = 0; i < bytes.length;) {
          const b = bytes[i];
          if (b < 0x80) { out += String.fromCharCode(b); i += 1; }
          else if ((b & 0xE0) === 0xC0) { out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F)); i += 2; }
          else if ((b & 0xF0) === 0xE0) { out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)); i += 3; }
          else {
            const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
            const u = cp - 0x10000;
            out += String.fromCharCode(0xD800 + (u >> 10), 0xDC00 + (u & 0x3FF));
            i += 4;
          }
        }
        return out;
      }
    };
  `, context);
  context.window = context;
  context.globalThis = context;
  context.self = context;
  context.NostrApp = {};
  const bundle = fs.readFileSync(
    path.join(ROOT, 'android-shell/app/src/main/assets/secure-call-verifier/nostr.bundle.min.js'),
    'utf8'
  );
  vm.runInContext(bundle, context, { filename: 'nostr.bundle.min.js' });
  if (!context.NostrTools || typeof context.NostrTools.finalizeEvent !== 'function') {
    throw new Error('production nostr-tools bundle did not export NostrTools');
  }
  context.window.NostrTools = context.NostrTools;
  const e2ee = fs.readFileSync(path.join(ROOT, 'call-signal-e2ee.js'), 'utf8');
  vm.runInContext(e2ee, context, { filename: 'call-signal-e2ee.js' });
  return context;
}

const buildSrc = `
async function __build(senderPriv, recipientPriv, media, type, data, sessionId) {
  const NT = window.NostrTools;
  const App = window.NostrApp;
  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const senderSk = hexToBytes(senderPriv);
  const recipientSk = hexToBytes(recipientPriv);
  const senderPub = NT.getPublicKey(senderSk);
  const recipientPub = NT.getPublicKey(recipientSk);
  const pool = { publish() { return [Promise.resolve('ok')]; } };
  const built = await App.CallSignalE2ee.publishGiftWrappedCallSignal({
    media,
    type,
    data,
    sessionId,
    peerPubkey: recipientPub,
    senderPubkey: senderPub,
    senderPrivateKey: senderPriv,
    pool,
    relays: ['wss://example.invalid'],
  });
  const opened = await App.CallSignalE2ee.unwrapGiftWrappedCallSignal(built.event, recipientPriv, recipientPub);
  if (!opened) throw new Error('production JS failed to unwrap its own gift wrap');
  return {
    senderPub,
    recipientPub,
    wrap: built.event,
    seal: opened.seal,
    rumor: opened.rumor,
    expected: {
      family: 'sos-call-signal',
      v: 1,
      media: opened.media,
      action: opened.action,
      sessionId: opened.sessionId,
      signalId: opened.signalId,
      sender: opened.sender,
      recipient: opened.recipient,
      sentAt: opened.sentAt,
      data: opened.data,
    },
  };
}
`;

async function buildOne(seed, media, type, data, sessionId) {
  const ctx = boot(seed);
  vm.runInContext(buildSrc, ctx, { filename: 'build-one.js' });
  const built = await ctx.__build(SENDER_PRIV, RECIPIENT_PRIV, media, type, data, sessionId);
  return JSON.parse(JSON.stringify(built));
}

export async function unwrapNativeDisconnect(filePath) {
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const ctx = boot(0x122099);
  vm.runInContext(`
    async function __open(wrap, recipientPriv, recipientPub) {
      return await window.NostrApp.CallSignalE2ee.unwrapGiftWrappedCallSignal(wrap, recipientPriv, recipientPub);
    }
  `, ctx);
  const opened = await ctx.__open(doc.wrap, doc.recipientPriv, doc.recipientPub);
  if (!opened || opened.action !== 'disconnect' || opened.sender !== doc.senderPub) {
    console.log('NATIVE_TO_JS_DISCONNECT=FAIL');
    process.exitCode = 1;
    return false;
  }
  console.log('NATIVE_TO_JS_DISCONNECT=PASS');
  return true;
}

function isDirectRun() {
  const arg = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return arg.toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
}

async function main() {
  const session = '0123456789abcdef0123456789abcdef';
  const sdpVoice = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:sha-256 AB/CD\r\n';
  const sdpVideo = 'v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\ns=-\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';

  const voice = await buildOne(0x121001, 'voice', 'offer', sdpVoice, session);
  const video = await buildOne(0x121002, 'video', 'offer', sdpVideo, session);
  const candidate = await buildOne(0x121003, 'voice', 'candidate', 'candidate:1 1 udp 1 1.2.3.4 9 typ host', session);
  const disconnect = await buildOne(0x121004, 'voice', 'disconnect', null, session);

  const fixture = {
    generatedAt: new Date().toISOString(),
    stack: 'call-signal-e2ee.js + nostr-tools@2.7.2 bundle',
    senderPriv: SENDER_PRIV,
    recipientPriv: RECIPIENT_PRIV,
    senderPub: voice.senderPub,
    recipientPub: voice.recipientPub,
    voiceOffer: voice,
    videoOffer: video,
    candidate,
    disconnect,
  };

  const outDir = path.join(ROOT, 'qa/fixtures');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'js-call-giftwrap.json');
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  console.log('WROTE ' + outPath);
  console.log('VOICE_WRAP_ID ' + voice.wrap.id);
  console.log('VIDEO_WRAP_ID ' + video.wrap.id);
}

if (isDirectRun()) {
  await main();
}
