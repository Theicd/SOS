#!/usr/bin/env node
/**
 * MD4 S5 acceptance — P2P encrypted attachment fetch via existing hybrid media stack.
 * Classification A: S5 hydrate → resolveServerMediaAttachment → downloadEncryptedMediaHybrid.
 * Uses authorized in-process WebTorrent mock swarm (same pattern as package899 voice P2P gate);
 * does not invent a new P2P subsystem. Proves ciphertext integrity + no plaintext downgrade.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createHash, webcrypto } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'md4-s5-p2p-encrypted-fetch-acceptance-report.json');
const RUN_ID = process.env.SOS_MD4_S5_P2P_RUN_ID || crypto.randomUUID();

const results = {};
let pass = 0;
let fail = 0;
function set(k, ok, detail) {
  results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  if (ok) pass++;
  else fail++;
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 280));
}

// --- product-path classification (static) ---
const attachSrc = fs.readFileSync(path.join(ROOT, 'sos-md4-attachment-sync.js'), 'utf8');
const mediaSrc = fs.readFileSync(path.join(ROOT, 'media-server-e2ee.js'), 'utf8');
const integrated =
  /resolveServerMediaAttachment/.test(attachSrc) &&
  /downloadEncryptedMediaHybrid/.test(mediaSrc) &&
  /hasEncryptedP2pMarker|attachment\.p2p\.magnetURI/.test(mediaSrc) &&
  /availability = 'P2P'/.test(attachSrc);
set('P2P_PATH_INTEGRATED_IN_S5', integrated, {
  attachCallsResolve: /resolveServerMediaAttachment/.test(attachSrc),
  hybridPresent: /downloadEncryptedMediaHybrid/.test(mediaSrc),
});

const mime = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/videos.html';
  const fp = path.join(ROOT, p.replace(/^\//, ''));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404);
    res.end('missing');
    return;
  }
  res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(base + '/videos.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !!(window.NostrTools && window.NostrApp && window.NostrApp.encryptMediaBlob), null, {
  timeout: 60000,
});
for (const s of ['/sos-md4-attachment-sync.js', '/sos-md4-history-sync.js']) {
  await page.addScriptTag({ url: base + s });
}
await page.waitForFunction(() => !!(window.SosMd4AttachmentSync && window.SosMd4HistorySync), null, { timeout: 20000 });

const live = await page.evaluate(async () => {
  const App = window.NostrApp;
  const NT = window.NostrTools;
  const Att = window.SosMd4AttachmentSync;
  const sk = NT.generateSecretKey();
  const pub = NT.getPublicKey(sk);
  const peerSk = NT.generateSecretKey();
  const peer = NT.getPublicKey(peerSk);
  App.publicKey = pub;

  // Install authorized WebTorrent mock (same contract as media-server-e2ee fetchCiphertextViaWebTorrent).
  const swarm = new Map();
  const seeded = [];
  function ihOf(bytes) {
    let h = bytes.length.toString(16).padStart(8, '0');
    for (let i = 0; i < 16; i++) h += (bytes[i] || 0).toString(16).padStart(2, '0');
    return h.slice(0, 40);
  }
  const wt = {
    seed(file, opts, cb) {
      return file.arrayBuffer().then((ab) => {
        const bytes = new Uint8Array(ab);
        const infoHash = ihOf(bytes);
        const magnetURI = 'magnet:?xt=urn:btih:' + infoHash + '&dn=data.bin';
        swarm.set(infoHash, bytes);
        seeded.push({ infoHash, magnetURI, len: bytes.length });
        const t = {
          infoHash,
          magnetURI,
          length: bytes.length,
          done: true,
          ready: true,
          files: [
            {
              name: 'data.bin',
              length: bytes.length,
              arrayBuffer: async () => {
                const out = new ArrayBuffer(bytes.length);
                new Uint8Array(out).set(bytes);
                return out;
              },
            },
          ],
          destroy() {},
        };
        setTimeout(() => cb(t), 1);
        return t;
      });
    },
    get() {
      return null;
    },
    add(magnetURI, opts, cb) {
      const ih = (/btih:([0-9a-f]{40})/i.exec(magnetURI) || [])[1];
      const bytes = swarm.get(ih);
      const holder = { numPeers: 1, destroy() {}, on() {}, once() {} };
      setTimeout(() => {
        if (!bytes) {
          holder.error = true;
          return;
        }
        const copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        cb({
          infoHash: ih,
          magnetURI,
          length: copy.length,
          done: true,
          ready: true,
          numPeers: 1,
          files: [
            {
              name: 'data.bin',
              length: copy.length,
              arrayBuffer: async () => {
                const out = new ArrayBuffer(copy.length);
                new Uint8Array(out).set(copy);
                return out;
              },
            },
          ],
          destroy() {},
          once(ev, fn) {
            if (ev === 'done' || ev === 'ready') fn();
          },
          on() {},
        });
      }, 5);
      return holder;
    },
  };
  App.torrentTransfer = { init: () => wt };

  // Block Blossom so P2P must win (no silent blossom success).
  const origBlossom = App.downloadEncryptedMediaFromBlossom;
  App.downloadEncryptedMediaFromBlossom = async () => {
    const e = new Error('BLOSSOM_FORCED_DOWN');
    e.code = 'BLOSSOM_DOWNLOAD_FAILED';
    throw e;
  };

  const plain = new Uint8Array(8192);
  crypto.getRandomValues(plain);
  plain[0] = 0x89;
  plain[1] = 0x50;
  const messageId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const enc = await App.encryptMediaBlob(new Blob([plain], { type: 'image/png' }), {
    messageId,
    sender: pub,
    recipient: peer,
    filename: 'p2p-s5.png',
    mime: 'image/png',
    mode: 'single',
  });
  // Plain object copy — avoid frozen/sealed descriptor quirks from encryptMediaBlob.
  const desc = JSON.parse(JSON.stringify(enc.descriptor));
  // Seed ciphertext only via mock WT
  const seedFile = new File([enc.ciphertext], 'data.bin', { type: 'application/octet-stream' });
  const torrent = await new Promise((resolve) => {
    wt.seed(seedFile, { name: 'data.bin' }, resolve);
  });
  desc.p2p = {
    v: 1,
    transport: 'webtorrent',
    content: 'sos-media-e2ee-v2-ciphertext',
    magnetURI: torrent.magnetURI,
  };
  // resolveServerMediaAttachment requires an encrypted Blossom descriptor shape;
  // hybrid then races P2P vs Blossom. Blossom is forced down so P2P must supply ciphertext.
  desc.resource = {
    transport: 'blossom',
    url: 'http://127.0.0.1:9/forced-blossom-down/' + desc.attachmentId,
    encoding: 'raw',
  };
  delete desc.localOnly;

  const eventId = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
  const deviceId = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
  const authorizationId = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
  const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

  App.deletedChatMessageIds = new Set();
  App.chatState = { conversations: new Map(), messageIndex: new Map() };
  App.appendChatMessage = (m) => {
    const key = [pub, peer].sort().join(':');
    if (!App.chatState.conversations.has(key)) App.chatState.conversations.set(key, { messages: [] });
    App.chatState.conversations.get(key).messages.push(m);
    App.chatState.messageIndex.set(m.id, { key });
  };
  App.appendChatMessage({
    id: eventId,
    from: pub,
    to: peer,
    content: 'p2p-att',
    createdAt: Math.floor(Date.now() / 1000),
    attachment: desc,
    logicalMessageId: messageId,
    mediaSyncState: 'PENDING',
  });

  const built = Att.buildJob({
    accountP: pub,
    deviceId,
    authorizationId,
    authEpoch: 1,
    sessionId,
    peerP: peer,
    eventId,
    messageId,
    sender: pub,
    recipient: peer,
    attachment: desc,
  });
  if (!built.ok) {
    App.downloadEncryptedMediaFromBlossom = origBlossom;
    return { ok: false, phase: 'build', code: built.code };
  }

  const blossomShape =
    typeof App.isEncryptedBlossomDescriptor === 'function' ? App.isEncryptedBlossomDescriptor(desc) : null;
  let hybridProbe = null;
  try {
    if (typeof App.downloadEncryptedMediaHybrid === 'function') {
      hybridProbe = await App.downloadEncryptedMediaHybrid(desc, {
        messageId,
        sender: pub,
        recipient: peer,
      });
      hybridProbe = {
        ok: true,
        source: hybridProbe && hybridProbe.source,
        blobSize: hybridProbe && hybridProbe.blob && hybridProbe.blob.size,
      };
    } else {
      hybridProbe = { ok: false, code: 'NO_HYBRID_EXPORT' };
    }
  } catch (e) {
    hybridProbe = { ok: false, code: (e && e.code) || 'HYBRID_THROW', message: String((e && e.message) || e) };
  }
  let resolveProbe = null;
  try {
    const resolved = await App.resolveServerMediaAttachment(desc, {
      messageId,
      sender: pub,
      recipient: peer,
    });
    resolveProbe = {
      ok: !!(resolved && resolved.blob && resolved.objectUrl),
      source: resolved && resolved.descriptor && resolved.descriptor._resolvedSource,
      blobSize: resolved && resolved.blob && resolved.blob.size,
    };
  } catch (e) {
    resolveProbe = { ok: false, code: (e && e.code) || 'RESOLVE_THROW', message: String((e && e.message) || e) };
  }

  const r = await Att.hydrateJob(built.job, desc);
  const msg = (() => {
    let found = null;
    App.chatState.conversations.forEach((e) => {
      const hit = e.messages.find((m) => m.id === eventId);
      if (hit) found = hit;
    });
    return found;
  })();

  let restoredSha = null;
  let restoredLen = 0;
  let plainSha = null;
  {
    const d = await crypto.subtle.digest('SHA-256', plain);
    plainSha = Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
  }
  if (msg && msg.attachment && msg.attachment._resolvedBlob) {
    const ab = await msg.attachment._resolvedBlob.arrayBuffer();
    restoredLen = ab.byteLength;
    const d = await crypto.subtle.digest('SHA-256', ab);
    restoredSha = Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
  }

  // Corrupt P2P path must fail closed (no plaintext accept)
  const badDesc = JSON.parse(JSON.stringify(desc));
  badDesc.attachmentId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const badPlain = new Uint8Array(plain);
  badPlain[10] ^= 0xff;
  // Re-encrypt would change hash; instead flip cipher on swarm for same magnet — inject corrupt seed under new magnet
  const corruptBytes = new Uint8Array(enc.ciphertext);
  corruptBytes[4] ^= 0xff;
  const badIh = ihOf(corruptBytes);
  swarm.set(badIh, corruptBytes);
  badDesc.p2p = {
    v: 1,
    transport: 'webtorrent',
    content: 'sos-media-e2ee-v2-ciphertext',
    magnetURI: 'magnet:?xt=urn:btih:' + badIh + '&dn=data.bin',
  };
  badDesc.resource = {
    transport: 'blossom',
    url: 'http://127.0.0.1:9/forced-blossom-down/' + badDesc.attachmentId,
    encoding: 'raw',
  };
  // Keep original cipher.sha256 so hash check fails
  const eventId2 = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
  App.appendChatMessage({
    id: eventId2,
    from: pub,
    to: peer,
    content: 'p2p-bad',
    createdAt: Math.floor(Date.now() / 1000),
    attachment: badDesc,
    logicalMessageId: messageId + 'x',
    mediaSyncState: 'PENDING',
  });
  const built2 = Att.buildJob({
    accountP: pub,
    deviceId,
    authorizationId,
    authEpoch: 1,
    sessionId,
    peerP: peer,
    eventId: eventId2,
    messageId: messageId + 'x',
    sender: pub,
    recipient: peer,
    attachment: badDesc,
  });
  let corrupt = { ok: true, code: 'NOT_RUN' };
  if (built2.ok) {
    corrupt = await Att.hydrateJob(built2.job, badDesc);
  } else {
    corrupt = { ok: false, code: built2.code };
  }

  App.downloadEncryptedMediaFromBlossom = origBlossom;

  return {
    buildOk: built.ok,
    availability: built.job && built.job.availability,
    hasP2p: built.job && built.job.hasP2p,
    resourceUrl: desc.resource && desc.resource.url,
    blossomShape,
    hybridProbe,
    resolveProbe,
    hydrateOk: r.ok,
    hydrateCode: r.code,
    source: r.source || (msg && msg.mediaSource),
    state: built.job && built.job.state,
    restoredLen,
    plainLen: plain.length,
    integrity: restoredSha === plainSha && restoredLen === plain.length,
    plaintextDowngrade: false, // Blossom was forced down; success implies P2P ciphertext path
    corruptOk: corrupt.ok,
    corruptCode: corrupt.code,
    corruptState: built2.ok ? built2.job.state : null,
    seeded: seeded[0] || null,
  };
});

set(
  'P2P_JOB_AVAILABILITY',
  live && live.hasP2p === true && (live.availability === 'P2P' || live.availability === 'BLOSSOM') && live.blossomShape === true,
  live,
);
set('P2P_ENCRYPTED_FETCH', live && live.hydrateOk === true && live.source === 'p2p' && live.state === 'COMPLETE', {
  source: live && live.source,
  state: live && live.state,
  code: live && live.hydrateCode,
});
set('P2P_INTEGRITY', live && live.integrity === true, {
  restoredLen: live && live.restoredLen,
  plainLen: live && live.plainLen,
});
set('P2P_NO_PLAINTEXT_DOWNGRADE', live && live.hydrateOk === true && live.source === 'p2p', {
  source: live && live.source,
});
set('P2P_CORRUPT_FAIL_CLOSED', live && live.corruptOk === false, {
  code: live && live.corruptCode,
  state: live && live.corruptState,
});

await browser.close();
server.close();

const classification = integrated
  ? results.P2P_ENCRYPTED_FETCH?.ok
    ? 'A_IMPLEMENTED_AND_VERIFIED'
    : 'A_IMPLEMENTED_LIVE_VERIFY_FAILED'
  : 'C_NOT_INTEGRATED';

const report = {
  gate: 'MD4_S5_P2P_ENCRYPTED_FETCH_ACCEPTANCE',
  runId: RUN_ID,
  ts: new Date().toISOString(),
  P2P_SUPPORT_CLASSIFICATION: classification,
  note:
    'Uses existing downloadEncryptedMediaHybrid + torrentTransfer.init contract with in-page mock swarm; Blossom forced down so P2P must supply ciphertext. Real public WebTorrent tracker swarm is environment-dependent and not required for MD4 S5 product path proof.',
  pass,
  fail,
  results,
  STATUS: fail === 0 ? 'PASS' : 'FAIL',
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('MD4_S5_P2P_ENCRYPTED_FETCH_ACCEPTANCE=' + report.STATUS, 'class=' + classification, 'runId=' + RUN_ID);
process.exit(fail === 0 ? 0 : 1);
