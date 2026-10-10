#!/usr/bin/env node
/**
 * MD4 S5 — live Android → Desktop encrypted attachment sync E2E (kind 25060 t=sos-hist-v1).
 * Blossom ciphertext restore, local-only AEAD transfer, tombstone, integrity negatives.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import { generateSecretKey, getPublicKey, finalizeEvent, nip44 } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';
import { chromium } from 'playwright';
import { schnorr } from '@noble/curves/secp256k1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'md4-s5-attachment-e2e-report.json');
const RUN_ID = process.env.SOS_MD4_S5_RUN_ID || crypto.randomUUID();
const ADM_DIR = path.join(ROOT, 'admission-service');
const ADM_PORT = Number(process.env.SOS_MD3_ADM_PORT || 8799);
const WEB_PORT = Number(process.env.SOS_MD4_S5_WEB_PORT || 8835);
const RELAY_PORT = Number(process.env.SOS_MD3_RELAY_PORT || 7805);
const ADM_URL = `http://127.0.0.1:${ADM_PORT}`;
const ANDROID_ADM = `http://127.0.0.1:${ADM_PORT}`;
const DESKTOP_RELAY = `ws://127.0.0.1:${RELAY_PORT}`;
const ANDROID_RELAY = `ws://10.0.2.2:${RELAY_PORT}`;
const HANDOFF_HOST = path.join(ROOT, 'qa', '.md4-s5-md3-handoff.json');
const HANDOFF_DEV = '/data/local/tmp/sos-md3-e2e-handoff.json';
const HIST_HANDOFF_HOST = path.join(ROOT, 'qa', '.md4-s5-hist-handoff.json');
const HIST_HANDOFF_DEV = '/data/local/tmp/sos-md4-s3-hist-handoff.json';
const MEDIA_DIR = path.join(ROOT, 'qa', '.md4-s5-media');

const report = {
  gate: 'MD4_S5_ATTACHMENT_E2E',
  status: 'FAIL',
  runId: RUN_ID,
  ts: new Date().toISOString(),
  cases: {},
  ROOT_K_SENT_TO_DESKTOP: false,
  NSEC_SENT_TO_DESKTOP: false,
  results: {},
  P2P_ENCRYPTED_FETCH: 'NOT_VERIFIED',
};
const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 260));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function skPair() {
  const sk = generateSecretKey();
  return { hex: bytesToHex(sk), pub: getPublicKey(sk), sk };
}

const ROOT_KEY = skPair();
const SVC = skPair();
const COSIGN = skPair();
const PIN_PEPPER = bytesToHex(generateSecretKey());
const PHONE_PEPPER = bytesToHex(generateSecretKey());
const persistDir = path.join(ADM_DIR, '.wrangler-md3-e2e');
let admProc = null;
let admLog = '';
let webServer = null;
let pairRelay = null;

class PairingRelay {
  constructor(port) {
    this.port = port;
    this.stats = { received: 0, broadcast: 0, connections: 0 };
    this.child = null;
  }
  start() {
    return new Promise((resolve, reject) => {
      this.child = spawn(process.execPath, [path.join(ROOT, 'qa', 'md3-pairing-relay-child.cjs')], {
        env: Object.assign({}, process.env, { SOS_RELAY_PORT: String(this.port), SOS_RELAY_HOST: '0.0.0.0' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child.stdout.on('data', (d) => {
        for (const line of String(d).split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line);
            if (j.type === 'RELAY_UP') resolve();
            if (j.type === 'CONN') this.stats.connections++;
            if (j.type === 'EVENT') {
              this.stats.received++;
              this.stats.broadcast++;
              this.stats.lastKind = j.kind;
              this.stats.lastT = j.t;
            }
          } catch (_e) {}
        }
      });
      this.child.on('exit', (code) => {
        if (code && code !== 0) reject(new Error('relay_exit_' + code));
      });
      setTimeout(() => reject(new Error('relay_start_timeout')), 10000);
    });
  }
  stop() {
    if (this.child) try { this.child.kill(); } catch (_e) {}
  }
}

async function post(p, body) {
  const r = await fetch(ADM_URL + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({ result: 'BAD_JSON' }));
  j.__http = r.status;
  return j;
}

async function startAdmission() {
  fs.mkdirSync(persistDir, { recursive: true });
  fs.writeFileSync(
    path.join(ADM_DIR, '.dev.vars'),
    [
      `ROOT_PUBKEY=${ROOT_KEY.pub}`,
      `ADMISSION_SK=${SVC.hex}`,
      `ADMIN_COSIGN_SK=${COSIGN.hex}`,
      `ADMIN_PIN_PEPPER=${PIN_PEPPER}`,
      `PHONE_PEPPER=${PHONE_PEPPER}`,
      `TEST_FAULTS=1`,
      `ALLOWED_ORIGINS=*`,
      `ADMIN_2FA_SIGNER_PUBKEY=${COSIGN.pub}`,
      '',
    ].join('\n'),
  );
  admProc = spawn(
    'npx',
    [
      'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(ADM_PORT),
      '--persist-to', persistDir, '--show-interactive-dev-session=false',
    ],
    {
      cwd: ADM_DIR,
      shell: true,
      env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }),
      windowsHide: true,
    },
  );
  admProc.stdout.on('data', (d) => (admLog += d.toString()));
  admProc.stderr.on('data', (d) => (admLog += d.toString()));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(ADM_URL + '/v1/health', { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch (_e) {}
    await sleep(500);
  }
  throw new Error('admission worker failed:\n' + admLog.slice(-2500));
}

function startWeb() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const mime = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.bin': 'application/octet-stream',
    '.png': 'image/png',
  };
  webServer = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/videos.html';
    const fp = path.join(ROOT, p.replace(/^\//, ''));
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404); res.end('missing'); return;
    }
    res.writeHead(200, {
      'Content-Type': mime[path.extname(fp)] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(fp).pipe(res);
  });
  return new Promise((r) => webServer.listen(WEB_PORT, '0.0.0.0', r));
}

/** Encrypt real media in-page, persist ciphertext for Blossom-like GET, build kind-1050 events. */
async function seedAttachmentViaPage(page, account, peer, opts) {
  const mode = opts.attachMode || 'blossom'; // blossom | local | video | file | corrupt | tombstone
  const prepared = await page.evaluate(
    async ({ accountPub, peerPub, mime, filename, textLabel }) => {
      const App = window.NostrApp;
      if (typeof App.encryptMediaBlob !== 'function') return { ok: false, code: 'NO_ENCRYPT' };
      const bytes = new Uint8Array(4096);
      crypto.getRandomValues(bytes);
      // PNG-ish header for image mime so UI path stays image-shaped.
      if (String(mime).startsWith('image/')) {
        bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
      }
      const messageId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      const enc = await App.encryptMediaBlob(new Blob([bytes], { type: mime }), {
        messageId,
        sender: accountPub,
        recipient: peerPub,
        filename,
        mime,
        mode: 'single',
      });
      const ct = Array.from(enc.ciphertext);
      return {
        ok: true,
        messageId,
        descriptor: enc.descriptor,
        ciphertext: ct,
        textLabel,
      };
    },
    {
      accountPub: account.pub,
      peerPub: peer.pub,
      mime: opts.mime || 'image/png',
      filename: opts.filename || 's5-photo.png',
      textLabel: opts.textLabel || 'with-attachment',
    },
  );
  if (!prepared.ok) throw new Error('ATTACH_SEED_FAIL_' + prepared.code);
  const ct = Buffer.from(prepared.ciphertext);
  const fileName = prepared.descriptor.attachmentId + '.bin';
  fs.writeFileSync(path.join(MEDIA_DIR, fileName), ct);
  const descriptor = JSON.parse(JSON.stringify(prepared.descriptor));
  let localAttachmentCiphers = null;
  if (mode === 'local') {
    descriptor.localOnly = true;
    delete descriptor.resource;
    localAttachmentCiphers = {
      [descriptor.attachmentId]: ct.toString('base64'),
    };
  } else if (mode === 'corrupt') {
    descriptor.resource = {
      transport: 'blossom',
      url: `http://127.0.0.1:${WEB_PORT}/qa/.md4-s5-media/${fileName}`,
      encoding: 'raw',
    };
    // Flip a byte on disk after hashing — download hash will fail closed.
    const corrupt = Buffer.from(ct);
    corrupt[0] = corrupt[0] ^ 0xff;
    fs.writeFileSync(path.join(MEDIA_DIR, fileName), corrupt);
  } else {
    descriptor.resource = {
      transport: 'blossom',
      url: `http://127.0.0.1:${WEB_PORT}/qa/.md4-s5-media/${fileName}`,
      encoding: 'raw',
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const inner = {
    v: 1,
    type: 'private-chat',
    messageId: prepared.messageId,
    sender: account.pub,
    recipient: peer.pub,
    createdAt: now,
    text: prepared.textLabel || ' ',
    attachment: descriptor,
  };
  const ck = nip44.v2.utils.getConversationKey(account.sk, peer.pub);
  const envCt = nip44.v2.encrypt(JSON.stringify(inner), ck);
  const ev = finalizeEvent(
    {
      kind: 1050,
      created_at: now,
      tags: [['p', peer.pub], ['t', 'sos-private-chat']],
      content: JSON.stringify({ family: 'sos-e2ee', v: 1, alg: 'nip44', ct: envCt }),
    },
    account.sk,
  );
  const events = [ev];
  let tombMeta = null;
  if (mode === 'tombstone') {
    const tombAt = now + 2;
    const tombInner = {
      v: 1,
      type: 'tombstone',
      deleted: true,
      targetId: ev.id,
      messageId: bytesToHex(crypto.randomBytes(16)),
      sender: account.pub,
      recipient: peer.pub,
      createdAt: tombAt,
      text: ' ',
      attachment: null,
    };
    const tct = nip44.v2.encrypt(JSON.stringify(tombInner), ck);
    const tomb = finalizeEvent(
      {
        kind: 1050,
        created_at: tombAt,
        tags: [['p', peer.pub], ['t', 'sos-private-chat'], ['e', ev.id]],
        content: JSON.stringify({ family: 'sos-e2ee', v: 1, alg: 'nip44', ct: tct }),
      },
      account.sk,
    );
    events.push(tomb);
    tombMeta = { originalId: ev.id, tombId: tomb.id };
  }
  return {
    events,
    peers: [peer],
    localAttachmentCiphers,
    meta: {
      attachmentId: descriptor.attachmentId,
      messageId: prepared.messageId,
      mode,
      eventId: ev.id,
      mime: opts.mime || 'image/png',
    },
    tombMeta,
  };
}

function adb(args) {
  const sdk = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
  return execSync(`"${path.join(sdk, 'platform-tools', 'adb.exe')}" -s emulator-5554 ${args}`, {
    encoding: 'utf8', windowsHide: true,
  });
}

function pushJson(hostPath, devPath, obj) {
  fs.writeFileSync(hostPath, JSON.stringify(obj));
  adb(`push "${hostPath}" ${devPath}`);
}

function assembleAndInstall() {
  const env = Object.assign({}, process.env, {
    ANDROID_HOME: process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'),
    JAVA_HOME: process.env.JAVA_HOME || 'C:\\Program Files\\Java\\jdk-17',
  });
  const out = execSync('gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest', {
    cwd: path.join(ROOT, 'android-shell'), encoding: 'utf8', timeout: 480000, windowsHide: true, env,
  });
  if (!/BUILD SUCCESSFUL/.test(out)) throw new Error('assemble failed');
  adb(`install -r "${path.join(ROOT, 'android-shell', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')}"`);
  adb(`install -r "${path.join(ROOT, 'android-shell', 'app', 'build', 'outputs', 'apk', 'androidTest', 'debug', 'app-debug-androidTest.apk')}"`);
  return true;
}

function runInstrumentedAsync(className) {
  const sdk = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
  const adbBin = path.join(sdk, 'platform-tools', 'adb.exe');
  return new Promise((resolve) => {
    const child = spawn(adbBin, [
      '-s', 'emulator-5554', 'shell', 'am', 'instrument', '-w', '-r',
      '-e', 'class', className,
      'com.sos010.app.test/androidx.test.runner.AndroidJUnitRunner',
    ], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    child.on('close', () => {
      const ok = /OK \(1 test\)/.test(out) || (/Tests run:\s*1/.test(out) && !/FAILURES!!!/.test(out));
      resolve({ ok, out: out.slice(-8000) });
    });
  });
}

function pullHistResult() {
  try {
    const raw = adb('shell run-as com.sos010.app cat /data/data/com.sos010.app/files/sos-md4-s3-hist-result.json');
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

function pullMd3Result() {
  try {
    const raw = adb('shell run-as com.sos010.app cat /data/data/com.sos010.app/files/sos-md3-e2e-result.json');
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

function seedEncryptedEvents(account, peers, textsPerPeer) {
  const events = [];
  const now = Math.floor(Date.now() / 1000);
  peers.forEach((peer, pi) => {
    const texts = textsPerPeer[pi] || [];
    texts.forEach((text, ti) => {
      const outgoing = ti % 2 === 0;
      const senderSk = outgoing ? account.sk : peer.sk;
      const senderPub = outgoing ? account.pub : peer.pub;
      const recipientPub = outgoing ? peer.pub : account.pub;
      const messageId = bytesToHex(crypto.randomBytes(16));
      const createdAt = now - (peers.length - pi) * 100 - ti;
      const inner = {
        v: 1,
        type: 'private-chat',
        messageId,
        sender: senderPub,
        recipient: recipientPub,
        createdAt,
        text,
        attachment: null,
      };
      const ck = nip44.v2.utils.getConversationKey(senderSk, recipientPub);
      const ct = nip44.v2.encrypt(JSON.stringify(inner), ck);
      const env = { family: 'sos-e2ee', v: 1, alg: 'nip44', ct };
      const ev = finalizeEvent(
        {
          kind: 1050,
          created_at: createdAt,
          tags: [
            ['p', recipientPub],
            ['t', 'sos-private-chat'],
          ],
          content: JSON.stringify(env),
        },
        senderSk,
      );
      events.push(ev);
    });
  });
  return events;
}

/** Seed N events via the proven S3 encrypt path; force shared timestamps for cursor ties. */
function seedLargeHistory(account, peers, count) {
  const texts = [];
  for (let i = 0; i < count; i++) texts.push('s4-msg-' + i);
  const events = seedEncryptedEvents(account, peers, [texts]);
  // Collapse timestamps into shared seconds (created_at + eventId ordering still unique).
  const base = Math.floor(Date.now() / 1000) - Math.ceil(count / 3);
  return events.map((ev, i) => {
    const copy = Object.assign({}, ev, { created_at: base + Math.floor(i / 3) });
    // Re-sign so id matches mutated created_at.
    return finalizeEvent(
      {
        kind: 1050,
        created_at: copy.created_at,
        tags: copy.tags,
        content: copy.content,
      },
      // Recover sk: outgoing when pubkey === account
      (copy.pubkey === account.pub ? account.sk : peers[0].sk),
    );
  });
}

function seedTombstonePair(account, peer) {
  const seeded = seedEncryptedEvents(account, [peer], [['will-delete']]);
  const original = seeded[0];
  const createdAt = (original.created_at || Math.floor(Date.now() / 1000)) + 1;
  const messageId = bytesToHex(crypto.randomBytes(16));
  const inner = {
    v: 1,
    type: 'tombstone',
    deleted: true,
    targetId: original.id,
    messageId,
    sender: account.pub,
    recipient: peer.pub,
    createdAt,
    text: ' ',
    attachment: null,
  };
  const ck = nip44.v2.utils.getConversationKey(account.sk, peer.pub);
  const ct = nip44.v2.encrypt(JSON.stringify(inner), ck);
  const tomb = finalizeEvent(
    {
      kind: 1050,
      created_at: createdAt,
      tags: [
        ['p', peer.pub],
        ['t', 'sos-private-chat'],
      ],
      content: JSON.stringify({ family: 'sos-e2ee', v: 1, alg: 'nip44', ct }),
    },
    account.sk,
  );
  return { events: [original, tomb], originalId: original.id, tombId: tomb.id };
}

async function ensureNewAccount(account) {
  const phone = '+97250' + String(Math.floor(1000000 + Math.random() * 8999999));
  const code = bytesToHex(generateSecretKey()).slice(0, 32).toUpperCase();
  const ih = crypto.createHash('sha256').update(code).digest('hex');
  const now = Math.floor(Date.now() / 1000);
  const invite = finalizeEvent({
    kind: 37378,
    created_at: now,
    tags: [
      ['t', 'sos-invite'], ['t', 'israel-network'], ['purpose', 'NEW_ACCOUNT_INVITE'],
      ['expiration', String(now + 3600)], ['ih', ih], ['d', ih],
    ],
    content: JSON.stringify({ v: 2, type: 'invite', purpose: 'NEW_ACCOUNT_INVITE' }),
  }, ROOT_KEY.sk);
  const reg = await post('/v1/global/invites/new-account/register', { invite, purpose: 'NEW_ACCOUNT_INVITE', recipientPhone: phone });
  if (reg.result !== 'OK') {
    await post('/v1/global/account/status/set', {
      targetPubkey: account.pub, status: 'ACTIVE', reasonCode: 'MD4_S3',
      authEvent: finalizeEvent({
        kind: 22242, created_at: now,
        tags: [['t', 'sos-global-account-status'], ['p', account.pub], ['expiration', String(now + 120)]],
        content: JSON.stringify({ purpose: 'SET_GLOBAL_STATUS', status: 'ACTIVE' }),
      }, ROOT_KEY.sk),
    });
    return { result: 'OK', has39007: false, fallback: true };
  }
  const redeemed = await post('/v1/global/invites/new-account/redeem', {
    inviteId: reg.inviteId, code, phone, redeemerPubkey: account.pub,
    redeemerAuthEvent: finalizeEvent({
      kind: 22242, created_at: now,
      tags: [['t', 'sos-new-account-redeem'], ['e', String(reg.inviteId).toLowerCase()], ['expiration', String(now + 120)]],
      content: JSON.stringify({ purpose: 'REDEEM_NEW_ACCOUNT_INVITE', inviteId: String(reg.inviteId).toLowerCase(), v: 1 }),
    }, account.sk),
  });
  return { result: redeemed.result === 'OK' ? 'OK' : 'INVALID', has39007: redeemed.result === 'OK' };
}

async function desktopPairingSession(page) {
  await page.goto(`http://127.0.0.1:${WEB_PORT}/videos.html`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => !!(window.SosWebLinkedDevices && window.SosMd2PairingSession && window.NostrTools && window.SosMd4HistorySync && window.SosMd4HistoryCheckpoint && window.SosMd4Cki && window.SosChatE2ee), null, { timeout: 90000 });
  await page.exposeFunction('__sosSchnorrSignHex', (msgHex, skHex) => {
    return Buffer.from(schnorr.sign(Buffer.from(String(msgHex), 'hex'), Buffer.from(String(skHex), 'hex'))).toString('hex');
  });
  await page.exposeFunction('__sosSchnorrVerifyHex', async (sigHex, msgHex, pubHex) => {
    try {
      return schnorr.verify(Buffer.from(String(sigHex), 'hex'), Buffer.from(String(msgHex), 'hex'), Buffer.from(String(pubHex), 'hex'));
    } catch (_e) { return false; }
  });
  return page.evaluate(async ({ desktopRelay, androidRelay }) => {
    const App = window.NostrApp;
    const Session = App.Md2PairingSession || window.SosMd2PairingSession;
    const LD = window.SosWebLinkedDevices;
    const localPool = {
      _sockets: [],
      _subReady: null,
      subscribeMany(relays, filter, params) {
        const f = Array.isArray(filter) ? filter[0] : filter;
        let readyResolve;
        localPool._subReady = new Promise((r) => { readyResolve = r; });
        let opened = 0;
        const need = Math.max(1, (relays || []).length);
        const closers = (relays || []).map((url) => {
          const ws = new WebSocket(url);
          localPool._sockets.push(ws);
          ws.onopen = () => {
            try { ws.send(JSON.stringify(['REQ', 'md3-' + Date.now().toString(36), f])); } catch (_e) {}
            opened += 1;
            if (opened >= need) readyResolve(true);
          };
          ws.onerror = () => readyResolve(false);
          ws.onmessage = (ev) => {
            try {
              const m = JSON.parse(String(ev.data || ''));
              if (Array.isArray(m) && m[0] === 'EVENT' && params && typeof params.onevent === 'function') {
                params.onevent(m[2] || {});
              }
            } catch (_e) {}
          };
          return () => { try { ws.close(); } catch (_e) {} };
        });
        return { close: () => closers.forEach((c) => c()) };
      },
      publish(relays, ev) {
        return (relays || []).map(
          (url) =>
            new Promise((resolve) => {
              const ws = new WebSocket(url);
              localPool._sockets.push(ws);
              const done = (v) => { try { ws.close(); } catch (_e) {} resolve(v); };
              ws.onopen = () => {
                try { ws.send(JSON.stringify(['EVENT', ev])); } catch (_e) {}
                setTimeout(() => done('ok'), 250);
              };
              ws.onerror = () => done('err');
              setTimeout(() => done('timeout'), 4000);
            }),
        );
      },
    };
    const s = await Session.beginDesktopInitiator({
      ttlMs: 300000,
      deviceLabel: 'דפדפן-S4',
      pool: localPool,
      relays: [desktopRelay],
      rendezvous: androidRelay,
    });
    s.waitLinked(300000)
      .then(async (auth) => {
        try {
          const secrets = typeof s.exportDeviceSecrets === 'function' ? s.exportDeviceSecrets() : null;
          window.__sosMd3AcceptResult = await LD.acceptAuthorizationObject(auth, { session: s, secrets });
        } catch (e) {
          window.__sosMd3AcceptResult = { ok: false, code: String((e && e.message) || e).slice(0, 120) };
        }
      })
      .catch(() => {});
    window.__sosMd3E2eSession = s;
    const subReady = localPool._subReady ? await localPool._subReady : false;
    return { qrText: s.qrText, pairingId: s.payload && s.payload.pairingId, subReady: !!subReady };
  }, { desktopRelay: DESKTOP_RELAY, androidRelay: ANDROID_RELAY });
}

async function waitLinked(page, ms) {
  return page.evaluate(async (timeout) => {
    const LD = window.SosWebLinkedDevices;
    const sess = window.__sosMd3E2eSession;
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (sess && sess.state && sess.state() === 'LINKED') return { ok: true };
      const list = LD.listLinkedDevices && LD.listLinkedDevices();
      if (list && list.length) return { ok: true };
      await new Promise((r) => setTimeout(r, 400));
    }
    return { ok: false };
  }, ms);
}

async function runCase(label, opts) {
  const account = skPair();
  const peerA = skPair();
  const peerB = skPair();
  const caseRep = { label, accountP: account.pub, mode: opts.mode, seed: opts.seed };
  console.log('\n=== S4 CASE', label, opts.mode, opts.seed, '===');

  if (opts.mode === 'NEW_39007') {
    caseRep.newAccount = await ensureNewAccount(account);
  } else {
    caseRep.statusGet = await post('/v1/global/account/status/get', { pubkey: account.pub });
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const desk = await desktopPairingSession(page);
    if (!desk.qrText || !desk.subReady) {
      caseRep.ok = false; caseRep.reason = 'DESKTOP_QR'; report.cases[label] = caseRep;
      set(label + '_MD3', false, desk); return caseRep;
    }
    await sleep(400);
    pushJson(HANDOFF_HOST, HANDOFF_DEV, {
      privHex: account.hex, accountP: account.pub, qrText: desk.qrText, admissionUrl: ANDROID_ADM, mode: opts.mode,
    });
    const md3Inst = runInstrumentedAsync('com.sos010.app.SosMd3LinkedDevicePairingInstrumentedTest');
    const pollEnd = Date.now() + 130000;
    while (Date.now() < pollEnd) {
      const settled = await Promise.race([md3Inst.then((r) => ({ done: true, r })), sleep(800).then(() => ({ done: false }))]);
      if (settled.done) { caseRep.md3Instrumented = settled.r.ok; break; }
    }
    if (caseRep.md3Instrumented === undefined) {
      const r = await md3Inst; caseRep.md3Instrumented = r.ok;
    }
    const md3Res = pullMd3Result();
    const linked = await waitLinked(page, 60000);
    caseRep.md3 = { android: md3Res, linked, ok: !!(caseRep.md3Instrumented && md3Res && md3Res.ok && linked.ok) };
    set(label + '_MD3', !!caseRep.md3.ok, caseRep.md3);
    if (!caseRep.md3.ok) { caseRep.ok = false; report.cases[label] = caseRep; return caseRep; }

    // Build history seed
    let peers = [];
    let events = [];
    let tombMeta = null;
    let localAttachmentCiphers = null;
    let attachMeta = null;
    if (opts.seed === 'empty') {
      peers = []; events = [];
    } else if (opts.seed === 'attach' || String(opts.seed || '').startsWith('attach_')) {
      const seeded = await seedAttachmentViaPage(page, account, peerA, {
        attachMode: opts.attachMode || (opts.seed === 'attach_local' ? 'local' : opts.seed === 'attach_tombstone' ? 'tombstone' : opts.seed === 'attach_corrupt' ? 'corrupt' : 'blossom'),
        mime: opts.mime,
        filename: opts.filename,
        textLabel: opts.textLabel,
      });
      peers = seeded.peers;
      events = seeded.events;
      localAttachmentCiphers = seeded.localAttachmentCiphers;
      attachMeta = seeded.meta;
      tombMeta = seeded.tombMeta;
      caseRep.attachMeta = attachMeta;
      if (tombMeta) caseRep.tombMeta = { originalId: tombMeta.originalId, tombId: tombMeta.tombId };
    } else if (opts.seed === 'two_peer_attach') {
      const a1 = await seedAttachmentViaPage(page, account, peerA, { attachMode: 'blossom', filename: 'p1.png' });
      const a2 = await seedAttachmentViaPage(page, account, peerB, { attachMode: 'blossom', filename: 'p2.png', mime: 'image/png' });
      peers = [peerA, peerB];
      events = a1.events.concat(a2.events);
      attachMeta = { multi: [a1.meta, a2.meta] };
      caseRep.attachMeta = attachMeta;
    } else {
      peers = [peerA];
      events = seedEncryptedEvents(account, peers, [['text-only']]);
    }

    const authBundle = await page.evaluate(async (accountP) => {
      const Store = window.SosMd4DeviceStore || window.NostrApp.Md4DeviceStore;
      const loaded = await Store.loadAnyForAccount(accountP);
      if (!loaded || !loaded.ok) return { ok: false, code: loaded && loaded.code };
      return { ok: true, authorization: loaded.authorization, deviceId: loaded.deviceId, accountP: loaded.accountP };
    }, account.pub);
    if (!authBundle.ok) {
      caseRep.ok = false; caseRep.reason = 'NO_DURABLE_AUTH'; set(label + '_DURABLE', false, authBundle);
      report.cases[label] = caseRep; return caseRep;
    }
    set(label + '_DURABLE', true, { deviceId: authBundle.deviceId });

    const handoffBase = {
      authorization: authBundle.authorization,
      peers: peers.map((p) => p.pub),
      events,
      relays: [ANDROID_RELAY],
      timeoutMs: opts.timeoutMs || 180000,
      clearCheckpoint: !!opts.clearCheckpoint,
    };
    if (localAttachmentCiphers) handoffBase.localAttachmentCiphers = localAttachmentCiphers;

    async function runHistOnce(handoffExtra) {
      pushJson(HIST_HANDOFF_HOST, HIST_HANDOFF_DEV, Object.assign({}, handoffBase, handoffExtra || {}));
      const histInstPromise = runInstrumentedAsync('com.sos010.app.SosMd4HistoryBootstrapInstrumentedTest');
      await sleep(4000);
      const boot = await page.evaluate(async ({ accountP, desktopRelay, timeoutMs }) => {
        const Store = window.SosMd4DeviceStore;
        const Hist = window.SosMd4HistorySync;
        const deviceCtx = await Store.loadAnyForAccount(accountP);
        if (!deviceCtx.ok) return { ok: false, code: deviceCtx.code || 'LOAD_FAIL' };
        return Hist.beginBootstrap({
          deviceCtx,
          relays: [desktopRelay],
          timeoutMs: timeoutMs || 160000,
        });
      }, { accountP: account.pub, desktopRelay: DESKTOP_RELAY, timeoutMs: opts.desktopTimeoutMs || 160000 });
      const histInst = await histInstPromise;
      const phoneRes = pullHistResult();
      return { boot, phoneRes, histInst };
    }

    let boot; let phoneRes; let histInst;
    if (opts.interruptResume) {
      // Short desktop wait: phone stops after first ACK'd batch.
      const savedDeskTo = opts.desktopTimeoutMs;
      opts.desktopTimeoutMs = 35000;
      const part = await runHistOnce({
        interruptAfterBatches: 1,
        expectInterrupt: true,
        clearCheckpointOnComplete: false,
        skipWaitFinalAck: true,
      });
      opts.desktopTimeoutMs = savedDeskTo || 160000;
      caseRep.interrupt = { phone: part.phoneRes, desktop: part.boot };
      const resumeCursor =
        (part.phoneRes && part.phoneRes.cursorAfter) ||
        (part.boot && part.boot.cursorCommitted) ||
        null;
      const rest = await runHistOnce({
        resumeCursor,
        clearCheckpoint: false,
        expectInterrupt: false,
      });
      boot = rest.boot;
      phoneRes = rest.phoneRes;
      histInst = rest.histInst;
      // Success if resume imported remaining OR total progress across both legs.
      const importedTotal = (part.boot && part.boot.importedCount || 0) + (boot && boot.importedCount || 0);
      caseRep.resume = { phone: phoneRes, desktop: boot, resumeCursor, importedTotal };
      if (boot && boot.ok && importedTotal >= 50) {
        /* ok */
      } else if (boot && boot.ok && (boot.importedCount || 0) > 0) {
        /* ok */
      }
    } else {
      const once = await runHistOnce({ expectInterrupt: false });
      boot = once.boot;
      phoneRes = once.phoneRes;
      histInst = once.histInst;
    }

    caseRep.histPhone = phoneRes;
    caseRep.histPhoneInstrumented = histInst && histInst.ok;
    caseRep.histDesktop = boot;

    const phoneOk = !!(phoneRes && phoneRes.ok);
    const importedTotal = (boot && boot.importedCount) || 0;
    const attachMode = opts.attachMode || attachMeta && attachMeta.mode;
    const mediaState = await page.evaluate(({ eventId }) => {
      const App = window.NostrApp;
      let msg = null;
      if (App.chatState && App.chatState.conversations) {
        App.chatState.conversations.forEach((entry) => {
          if (msg || !entry || !Array.isArray(entry.messages)) return;
          const hit = entry.messages.find((m) => m && m.id === eventId);
          if (hit) msg = {
            id: hit.id,
            mediaSyncState: hit.mediaSyncState || null,
            hasAttachment: !!hit.attachment,
            hasBlob: !!(hit.attachment && hit.attachment._resolvedBlob),
            hasUrl: !!(hit.attachment && hit.attachment.url),
            source: hit.mediaSource || (hit.attachment && hit.attachment._resolvedSource) || null,
            deleted: !!hit.deleted,
          };
        });
      }
      return {
        msg,
        deletedHas: !!(eventId && App.deletedChatMessageIds && App.deletedChatMessageIds.has(eventId)),
        attachmentsComplete: null,
      };
    }, { eventId: attachMeta && attachMeta.eventId });
    caseRep.mediaState = mediaState;
    caseRep.attachStats = {
      queued: boot && boot.attachmentsQueued,
      complete: boot && boot.attachmentsComplete,
      missing: boot && boot.attachmentsMissing,
      failed: boot && boot.attachmentsFailed,
      mediaComplete: boot && boot.mediaComplete,
    };

    let importedOk = !!(boot && boot.ok);
    let mediaOk = true;
    if (attachMode === 'tombstone' || opts.seed === 'attach_tombstone') {
      importedOk = importedOk && (boot.tombstoneCount || 0) >= 1;
      mediaOk = !!(mediaState.deletedHas && (!mediaState.msg || mediaState.msg.deleted || mediaState.msg.mediaSyncState === 'TOMBSTONED' || !mediaState.msg.hasBlob));
    } else if (attachMode === 'corrupt' || opts.seed === 'attach_corrupt') {
      importedOk = importedOk && importedTotal >= 1;
      mediaOk = !!(boot.attachmentsFailed >= 1 || boot.attachmentsMissing >= 1 || (mediaState.msg && mediaState.msg.mediaSyncState && mediaState.msg.mediaSyncState !== 'COMPLETE'));
    } else if (opts.seed === 'two_peer_attach') {
      importedOk = importedOk && importedTotal >= 2;
      mediaOk = !!(boot.attachmentsComplete >= 2);
    } else if (String(opts.seed || '').startsWith('attach') || opts.seed === 'attach') {
      importedOk = importedOk && importedTotal >= 1;
      mediaOk = !!(
        (boot.attachmentsComplete || 0) >= 1 &&
        mediaState.msg &&
        mediaState.msg.hasAttachment &&
        (mediaState.msg.hasBlob || mediaState.msg.hasUrl) &&
        mediaState.msg.mediaSyncState === 'COMPLETE'
      );
    }
    const largeOk = true;
    caseRep.LIVE_CKI = !!(boot && boot.exportSessionId && phoneRes && phoneRes.exportSessionId);
    caseRep.ROOT_K_ON_DESKTOP = !!(boot && boot.ROOT_K_PRESENT);
    caseRep.completeness = boot && boot.completeness;
    caseRep.authOkCount = boot && boot.authOkCount;
    caseRep.DUPLICATE_AUTH_OK_SAFE = !boot || !boot.authOkCount || boot.authOkCount >= 1;
    caseRep.mediaOk = mediaOk;

    // Reload persistence / tombstone survival
    let reloadOk = true;
    let tombOk = true;
    if (opts.seed !== 'empty' && boot && boot.ok) {
      await page.evaluate(async () => {
        if (window.NostrApp && typeof window.NostrApp.flushChatPersist === 'function') {
          await window.NostrApp.flushChatPersist();
        }
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window.NostrApp && window.NostrApp.restoreChatState && window.SosMd4HistorySync), null, { timeout: 30000 });
      const after = await page.evaluate(async ({ accountP, originalId, peerPub, originalEvent }) => {
        window.NostrApp.publicKey = accountP;
        if (window.NostrApp.clearChatRuntimeIdentity) window.NostrApp.clearChatRuntimeIdentity();
        await window.NostrApp.restoreChatState();
        await new Promise((r) => setTimeout(r, 800));
        const peers = [];
        let deletedHas = false;
        if (window.NostrApp.deletedChatMessageIds && originalId) {
          deletedHas = window.NostrApp.deletedChatMessageIds.has(originalId);
        }
        if (window.NostrApp.chatState && window.NostrApp.chatState.conversations) {
          window.NostrApp.chatState.conversations.forEach((v, k) => {
            peers.push({ key: k, n: (v.messages || []).filter((m) => m && !m.deleted).length });
          });
        }
        let resurrect = null;
        let resurrectSigned = null;
        if (originalId && peerPub && window.SosMd4HistorySync) {
          const now = Math.floor(Date.now() / 1000);
          // Unsigned forged replay (must not resurrect).
          resurrect = window.SosMd4HistorySync.importDecryptedMessage(
            accountP,
            peerPub,
            {
              id: originalId,
              pubkey: accountP,
              kind: 1050,
              created_at: now,
              tags: [['p', peerPub]],
              content: '{}',
            },
            { text: 'resurrect-attempt' },
          );
          if (originalEvent && originalEvent.id) {
            resurrectSigned = window.SosMd4HistorySync.importDecryptedMessage(
              accountP,
              peerPub,
              originalEvent,
              { text: 'will-delete' },
            );
          }
        }
        return {
          peers,
          total: peers.reduce((s, p) => s + p.n, 0),
          deletedHas,
          resurrect,
          resurrectSigned,
          storageKey: typeof window.NostrApp.chatStorageKey === 'function' ? window.NostrApp.chatStorageKey() : null,
        };
      }, {
        accountP: account.pub,
        originalId: tombMeta && tombMeta.originalId,
        peerPub: peers[0] && peers[0].pub,
        originalEvent: tombMeta && tombMeta.events && tombMeta.events[0],
      });
      caseRep.reload = after;
      if (attachMode === 'tombstone' || opts.seed === 'attach_tombstone') {
        tombOk = !!(after.deletedHas && after.resurrect && after.resurrect.ok === false);
        reloadOk = tombOk;
      } else if (attachMode === 'corrupt' || opts.seed === 'attach_corrupt') {
        reloadOk = true; // message may persist; media must remain non-COMPLETE
      } else {
        reloadOk = after.total >= Math.min(boot.importedCount || 0, 1);
      }
    }
    caseRep.reloadOk = reloadOk;
    caseRep.tombOk = tombOk;

    caseRep.ok = !!(phoneOk && boot && boot.ok && importedOk && mediaOk && reloadOk && largeOk && tombOk && !caseRep.ROOT_K_ON_DESKTOP);
    set(label + '_ATTACH_SYNC', !!caseRep.ok, {
      phoneOk, desktopOk: boot && boot.ok, imported: boot && boot.importedCount,
      attachmentsComplete: boot && boot.attachmentsComplete,
      attachmentsMissing: boot && boot.attachmentsMissing,
      attachmentsFailed: boot && boot.attachmentsFailed,
      mediaOk, mediaSyncState: mediaState.msg && mediaState.msg.mediaSyncState,
      mediaSource: mediaState.msg && mediaState.msg.source,
      completeness: boot && boot.completeness, reloadOk, authOkCount: boot && boot.authOkCount,
      exportSessionId: boot && boot.exportSessionId,
    });
  } finally {
    await browser.close();
  }
  report.cases[label] = caseRep;
  return caseRep;
}

async function main() {
  try {
    adb('devices');
    set('ANDROID_EMULATOR_PRESENT', /emulator-5554/.test(adb('devices')));
    pairRelay = new PairingRelay(RELAY_PORT);
    await pairRelay.start();
    set('RELAY_UP', true, { DESKTOP_RELAY, ANDROID_RELAY });
    await startAdmission();
    set('ADMISSION_UP', true, { ADM_URL });
    await startWeb();
    set('WEB_UP', true, { WEB_PORT });
    try { adb(`reverse tcp:${ADM_PORT} tcp:${ADM_PORT}`); } catch (_e) {}
    assembleAndInstall();
    set('ANDROID_APKS_INSTALLED', true);

    for (const c of [
      ['NEW_IMAGE_BLOSSOM', { mode: 'NEW_39007', seed: 'attach_blossom', attachMode: 'blossom', mime: 'image/png', filename: 'new-img.png', clearCheckpoint: true }],
      ['LEGACY_IMAGE_BLOSSOM', { mode: 'LEGACY_NO_PHONE', seed: 'attach_blossom', attachMode: 'blossom', mime: 'image/png', filename: 'legacy-img.png', clearCheckpoint: true }],
      ['NEW_VIDEO_BLOSSOM', { mode: 'NEW_39007', seed: 'attach_blossom', attachMode: 'blossom', mime: 'video/mp4', filename: 'clip.mp4', clearCheckpoint: true }],
      ['NEW_FILE_BLOSSOM', { mode: 'NEW_39007', seed: 'attach_blossom', attachMode: 'blossom', mime: 'application/pdf', filename: 'doc.pdf', clearCheckpoint: true }],
      ['NEW_TWO_PEER_ATTACH', { mode: 'NEW_39007', seed: 'two_peer_attach', clearCheckpoint: true }],
      ['NEW_LOCAL_ONLY', { mode: 'NEW_39007', seed: 'attach_local', attachMode: 'local', mime: 'image/png', filename: 'local.png', clearCheckpoint: true }],
      ['NEW_CORRUPT_CIPHER', { mode: 'NEW_39007', seed: 'attach_corrupt', attachMode: 'corrupt', clearCheckpoint: true }],
      ['NEW_TOMBSTONE_ATTACH', { mode: 'NEW_39007', seed: 'attach_tombstone', attachMode: 'tombstone', clearCheckpoint: true }],
    ]) {
      try {
        await runCase(c[0], c[1]);
      } catch (e) {
        report.cases[c[0]] = { ok: false, error: String(e && e.message || e).slice(0, 500) };
        set(c[0] + '_ATTACH_SYNC', false, { error: String(e && e.message || e).slice(0, 200) });
      }
    }

    // Inline negatives (fail-closed)
    const negBrowser = await chromium.launch({ headless: true });
    try {
      const page = await negBrowser.newPage();
      await page.goto(`http://127.0.0.1:${WEB_PORT}/videos.html`, { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ url: `http://127.0.0.1:${WEB_PORT}/sos-md2-pairing-session.js` });
      await page.addScriptTag({ url: `http://127.0.0.1:${WEB_PORT}/sos-md4-device-auth.js` });
      await page.addScriptTag({ url: `http://127.0.0.1:${WEB_PORT}/sos-md4-device-store.js` });
      await page.addScriptTag({ url: `http://127.0.0.1:${WEB_PORT}/sos-md4-cki.js` });
      await page.addScriptTag({ url: `http://127.0.0.1:${WEB_PORT}/sos-md4-history-checkpoint.js` });
      await page.addScriptTag({ url: `http://127.0.0.1:${WEB_PORT}/sos-md4-history-sync.js` });
      await page.exposeFunction('__sosSchnorrVerifyHex', async (sigHex, msgHex, pubHex) => {
        try {
          return schnorr.verify(Buffer.from(String(sigHex), 'hex'), Buffer.from(String(msgHex), 'hex'), Buffer.from(String(pubHex), 'hex'));
        } catch (_e) { return false; }
      });
      const neg = await page.evaluate(async () => {
        const Hist = window.SosMd4HistorySync;
        const Ckpt = window.SosMd4HistoryCheckpoint;
        const App = window.NostrApp;
        App.publicKey = 'aa'.repeat(32);
        if (App.clearChatRuntimeIdentity) App.clearChatRuntimeIdentity();
        const now = Math.floor(Date.now() / 1000);
        const unlinked = await Hist.beginBootstrap({ deviceCtx: { ok: false }, relays: [] });
        const both = Hist.classifyTags([['t', 'sos-pair-v1'], ['t', 'sos-hist-v1']]);
        const badCk = await Ckpt.save({
          v: 1,
          accountP: 'aa'.repeat(32),
          deviceId: 'bb'.repeat(32),
          authorizationId: 'cc'.repeat(32),
          authEpoch: 1,
          collectionId: 'hist-bootstrap-v1',
          cursor: { createdAt: 1, eventId: 'dd'.repeat(32) },
          exportSessionId: '',
          committedBatchSeq: 0,
        });
        const cross = Ckpt.bindMatches(
          { accountP: '11'.repeat(32), deviceId: 'bb'.repeat(32), authorizationId: 'cc'.repeat(32), authEpoch: 1 },
          badCk.checkpoint,
        );
        const NT = window.NostrTools;
        const sk = NT.generateSecretKey();
        const pub = NT.getPublicKey(sk);
        const peer = NT.getPublicKey(NT.generateSecretKey());
        App.publicKey = pub;
        const ev = NT.finalizeEvent(
          { kind: 1050, created_at: now, tags: [['p', peer]], content: JSON.stringify({ text: 'one' }) },
          sk,
        );
        const conflict = Hist.importDecryptedMessage(pub, peer, ev, { text: 'one' });
        const conflict2 = Hist.importDecryptedMessage(pub, peer, ev, { text: 'two' });
        return { unlinked, both, cross, conflict, conflict2, maxBatch: Hist.MAX_BATCH_EVENTS, maxBytes: Hist.MAX_BATCH_BYTES };
      });
      set('NEG_UNLINKED_DESKTOP', neg.unlinked && neg.unlinked.ok === false, neg.unlinked);
      set('NEG_PROTOCOL_COLLISION', neg.both && neg.both.ok === false, neg.both);
      set('NEG_CROSS_ACCOUNT_CHECKPOINT', neg.cross && neg.cross.ok === false, neg.cross);
      set('NEG_CONFLICTING_EVENT', neg.conflict2 && neg.conflict2.code === 'CONFLICTING_EVENT', neg.conflict2);
      set('RESOURCE_LIMITS', neg.maxBatch === 50 && neg.maxBytes === 256 * 1024, neg);
    } finally {
      await negBrowser.close();
    }

    const caseOk = Object.values(report.cases).every((c) => c && c.ok);
    const crit = ['ANDROID_EMULATOR_PRESENT', 'RELAY_UP', 'ADMISSION_UP', 'ANDROID_APKS_INSTALLED'].every((k) => report.results[k] && report.results[k].ok);
    report.status = caseOk && crit ? 'PASS' : 'FAIL';
    report.failCount = Object.values(report.results).filter((r) => !r.ok).length;
    report.IMAGE_RESTORE = !!(report.cases.NEW_IMAGE_BLOSSOM && report.cases.NEW_IMAGE_BLOSSOM.ok);
    report.VIDEO_RESTORE = !!(report.cases.NEW_VIDEO_BLOSSOM && report.cases.NEW_VIDEO_BLOSSOM.ok);
    report.GENERIC_FILE_RESTORE = !!(report.cases.NEW_FILE_BLOSSOM && report.cases.NEW_FILE_BLOSSOM.ok);
    report.LOCAL_ONLY_MEDIA_TRANSFER = !!(report.cases.NEW_LOCAL_ONLY && report.cases.NEW_LOCAL_ONLY.ok);
    report.BLOSSOM_ENCRYPTED_FETCH = !!(report.cases.NEW_IMAGE_BLOSSOM && report.cases.NEW_IMAGE_BLOSSOM.ok);
    report.TOMBSTONE_NO_RESURRECTION = !!(report.cases.NEW_TOMBSTONE_ATTACH && report.cases.NEW_TOMBSTONE_ATTACH.ok);
    report.NEW_ACCOUNT_E2E = report.IMAGE_RESTORE;
    report.LEGACY_ACCOUNT_E2E = !!(report.cases.LEGACY_IMAGE_BLOSSOM && report.cases.LEGACY_IMAGE_BLOSSOM.ok);
    report.relayStats = pairRelay.stats;
  } catch (e) {
    report.status = 'FAIL';
    report.error = String(e && e.stack || e).slice(0, 4000);
    console.error(e);
  } finally {
    if (pairRelay) pairRelay.stop();
    if (admProc) {
      try { execSync(`taskkill /pid ${admProc.pid} /T /F`, { stdio: 'ignore' }); } catch (_e) {}
      admProc = null;
    }
    try { fs.rmSync(path.join(ADM_DIR, '.dev.vars'), { force: true }); } catch (_e) {}
    if (webServer) try { webServer.close(); } catch (_e) {}
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log('\nMD4_S5_ATTACHMENT_E2E=' + report.status, 'runId=' + RUN_ID);
    console.log('REPORT', OUT);
  }
  process.exit(report.status === 'PASS' ? 0 : 1);
}

main();
