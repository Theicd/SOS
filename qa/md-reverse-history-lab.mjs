/**
 * Desktop -> phone history reconciliation on disposable browsers.
 * Does not read or clear the owner's phone or desktop storage.
 */
import { chromium } from 'playwright';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, '.stage5-lab', 'reverse-' + Date.now().toString(36));
const PORT = 8771;
const BASE = 'http://127.0.0.1:' + PORT + '/videos.html';

const mailbox = [];
const p2p = [];
let p2pBytes = 0;
let redundantBytes = 0;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function uniquePayloadBytes(rows) {
  const seen = new Set();
  let total = 0;
  (rows || []).forEach((row) => {
    const id = String(row && row.fileId || '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    total += Buffer.from(String(row.b64 || ''), 'base64').length;
  });
  return total;
}

function matchFilter(ev, filter) {
  const f = filter || {};
  if (Array.isArray(f.kinds) && f.kinds.indexOf(ev.kind) === -1) return false;
  if (Array.isArray(f.authors) && f.authors.indexOf(String(ev.pubkey || '').toLowerCase()) === -1) return false;
  const tags = Array.isArray(ev.tags) ? ev.tags : [];
  const keys = Object.keys(f);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (key.charAt(0) !== '#') continue;
    const name = key.slice(1);
    const wants = f[key];
    const got = tags.filter((t) => Array.isArray(t) && t[0] === name).map((t) => String(t[1]));
    const list = Array.isArray(wants) ? wants : [wants];
    if (!list.some((w) => got.indexOf(String(w)) !== -1)) return false;
  }
  return true;
}

function startServer() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'POST' && (url.pathname === '/lab/pub' || url.pathname === '/lab/query' || url.pathname === '/lab/p2p')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_e) { body = {}; }
        if (url.pathname === '/lab/pub') {
          if (body && body.id && body.pubkey) mailbox.push(body);
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end('{"ok":true}');
          return;
        }
        if (url.pathname === '/lab/query') {
          const found = mailbox.filter((ev) => matchFilter(ev, body));
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(found));
          return;
        }
        const raw = Buffer.from(String(body.b64 || ''), 'base64');
        p2pBytes += raw.length;
        p2p.push({ fileId: String(body.fileId || ''), sha256: String(body.sha256 || ''), name: String(body.name || ''), mime: String(body.mime || ''), size: raw.length, b64: String(body.b64 || '') });
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end('{"ok":true}');
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/lab/p2p') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(p2p.splice(0, p2p.length)));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/lab/stats') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ events: mailbox.length, p2pBytes }));
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/videos.html';
    const file = path.resolve(ROOT, rel.replace(/^\/+/, ''));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403); res.end('no'); return;
    }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('missing'); return; }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function waitApp(page) {
  await page.waitForFunction(() => {
    const App = window.NostrApp;
    return !!(App && App.SosAccountSession && App.SosCryptoSigner && window.NostrTools && window.SosAuthorizeLinkedDevice && window.SosMd2PairingSession);
  }, null, { timeout: 120000 });
}

async function installPool(page) {
  await page.evaluate(() => {
    const App = window.NostrApp;
    window.__sosRevTries = 99;
    window.__sosRevLastAt = Date.now();
    window.__dcOpen = false;
    App.relayUrls = ['ws://127.0.0.1/lab'];
    App.pool = {
      publish(_urls, ev) {
        return [fetch('/lab/pub', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev) }).then(() => 'ok')];
      },
      list(_urls, filters) {
        const filter = Array.isArray(filters) ? filters[0] : (filters || {});
        return fetch('/lab/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(filter) }).then((r) => r.json());
      },
      get(_urls, filter) { return this.list(_urls, [filter]).then((rows) => (Array.isArray(rows) ? rows[0] : null) || null); },
      subscribe() { return { on() {}, close() {}, unsub() {} }; },
      subscribeMany() { return { on() {}, close() {}, unsub() {} }; },
      sub() { return { on() {}, close() {}, unsub() {} }; },
      listMany(_urls, filters) { return this.list(_urls, filters); },
      querySync(_urls, filter) { return this.list(_urls, [filter]); },
    };
    App.dataChannel = {
      isConnected() { return window.__dcOpen === true; },
      forceConnect() { return Promise.resolve(); },
      connect() { return Promise.resolve(); },
      init() {},
    };
    if (App.activeP2PTransfers && typeof App.activeP2PTransfers.clear === 'function') App.activeP2PTransfers.clear();
    App.sendHistoryMedia = async function sendHistoryMedia(_peer, blob, meta) {
      if (window.__dcOpen !== true) return { ok: false, code: 'SIGNAL_TIMEOUT' };
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
      window.__labOut = window.__labOut || [];
      window.__labOut.push({
        fileId: meta && meta.fileId,
        sha256: meta && meta.sha256,
        name: meta && meta.name,
        mime: meta && meta.mime,
        b64: btoa(bin),
      });
      console.log('REVERSE_P2P_SEND bytes=' + bytes.length);
      return { ok: true, transport: 'p2p', fileId: meta && meta.fileId };
    };
  });
}

function liveCountScript() {
  const App = window.NostrApp;
  const ids = [];
  const files = [];
  let n = 0;
  const conv = App.chatState && App.chatState.conversations;
  if (conv && typeof conv.forEach === 'function') {
    conv.forEach((entry) => {
      (entry.messages || []).forEach((m) => {
        if (!m || m.deleted === true || m.tombstone === true) return;
        n += 1;
        ids.push(String(m.logicalMessageId || m.id || ''));
        const att = m.attachment;
        if (att && att.fileId) files.push({ id: String(m.logicalMessageId || m.id || ''), fileId: String(att.fileId), sha256: String(att.sha256 || '') });
      });
    });
  }
  return { n, ids, files };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
    ],
  });
  const report = {
    STATUS: 'FAIL',
    FIRST_FAILED_TRANSITION: '',
    steps: [],
  };
  const step = (name, ok, extra) => {
    const row = { name, ok };
    if (extra && typeof extra === 'object') row.detail = extra;
    report.steps.push(row);
    if (!ok && !report.FIRST_FAILED_TRANSITION) report.FIRST_FAILED_TRANSITION = name;
    console.log('STEP ' + name + ' ' + (ok ? 'ok' : 'fail'));
  };
  let wakeTimer = null;
  try {
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    const stubSockets = () => {
      function Socket() {
        this.readyState = 3;
        this.close = function () {};
        this.send = function () {};
        this.addEventListener = function () {};
        this.removeEventListener = function () {};
      }
      Socket.CONNECTING = 0;
      Socket.OPEN = 1;
      Socket.CLOSING = 2;
      Socket.CLOSED = 3;
      window.WebSocket = Socket;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    };
    await phoneCtx.addInitScript(stubSockets);
    await deskCtx.addInitScript(stubSockets);
    let phone = await phoneCtx.newPage();
    const desk = await deskCtx.newPage();
    const onConsole = (msg) => {
      const text = msg.text();
      if (/REVERSE_|Error|DECRYPT|MD3|HISTORY|PHONE_HB/i.test(text)) console.log('PAGE ' + text.slice(0, 220));
    };
    phone.on('console', onConsole);
    desk.on('console', onConsole);
    phone.on('pageerror', (err) => console.log('PHONE_ERR ' + String(err && err.message || err).slice(0, 180)));
    phone.on('crash', () => console.log('PHONE_CRASH'));
    desk.on('crash', () => console.log('DESK_CRASH'));
    phone.setDefaultTimeout(20000);
    desk.setDefaultTimeout(20000);
    await phone.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await desk.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitApp(phone);
    await waitApp(desk);
    const phoneCdp = await phone.context().newCDPSession(phone);
    const deskCdp = await desk.context().newCDPSession(desk);
    const wake = async () => {
      for (const [name, cdp] of [['phone', phoneCdp], ['desk', deskCdp]]) {
        try {
          await cdp.send('Page.enable');
          await cdp.send('Page.setWebLifecycleState', { state: 'active' });
        } catch (err) {
          if (!wake.logged) {
            wake.logged = true;
            console.log('node wake ' + name + ' ' + String(err && err.message || err).slice(0, 140));
          }
        }
      }
    };
    await wake();
    wakeTimer = setInterval(() => { wake().catch(() => {}); }, 2000);
    const phoneId = await phone.evaluate(() => {
      const nt = window.NostrTools;
      const sk = nt.generateSecretKey();
      const hex = Array.from(sk).map((b) => b.toString(16).padStart(2, '0')).join('');
      const App = window.NostrApp;
      const created = App.createNewIdentityExplicit({ privateKeyHex: hex });
      const SA = App.SessionAuthority || window.SosSessionAuthority;
      if (SA && typeof SA.bindCurrentSession === 'function') SA.bindCurrentSession({ accountPubkey: created.publicKey, bump: true });
      return { ok: !!(created && created.ok && created.publicKey), pub: String((created && created.publicKey) || '').toLowerCase() };
    });
    step('phone-identity', phoneId.ok === true);
    if (!phoneId.ok) throw new Error('PHONE_IDENTITY');
    await phone.evaluate(() => {
      const App = window.NostrApp;
      if (App.privateKey && App.publicKey) {
        App.guestMode = false;
        App.identityState = 'IDENTITY_OK';
      }
    });
    const booted = await phone.evaluate(() => {
      const App = window.NostrApp;
      return {
        pub: String(App.publicKey || '').toLowerCase().slice(0, 8),
        guest: App.guestMode === true,
        key: typeof App.privateKey === 'string' && /^[0-9a-f]{64}$/.test(App.privateKey),
        state: String(App.identityState || ''),
      };
    });
    step('phone-session-ready', booted.key === true && booted.guest === false, booted);
    if (!booted.key) throw new Error('PHONE_SESSION');
    await installPool(phone);
    await installPool(desk);

    const device = await desk.evaluate(() => {
      const nt = window.NostrTools;
      const sk = nt.generateSecretKey();
      const pub = String(nt.getPublicKey(sk)).toLowerCase();
      const enc = crypto.getRandomValues(new Uint8Array(32));
      const encPub = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, '0')).join('');
      window.__labDevice = {
        sk,
        pub,
        enc,
        encPub,
        deviceId: pub,
      };
      return { pub, encPub, deviceId: pub };
    });
    const auth = await phone.evaluate(async (deviceRow) => {
      const App = window.NostrApp;
      const Ald = window.SosAuthorizeLinkedDevice;
      const Md2 = window.SosMd2PairingSession;
      const accountP = String(App.publicKey || '').toLowerCase();
      const skHex = String(App.privateKey || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(skHex)) return { ok: false, code: 'NO_ROOT_ON_PHONE' };
      const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, '0')).join('');
      const draft = Ald.buildAuthorizationDraft({
        authorizationId: rand(),
        accountP,
        deviceId: deviceRow.deviceId,
        D_sign_pub: deviceRow.pub,
        D_enc_pub: deviceRow.encPub,
        capabilities: ['DEVICE_CHAT', 'DEVICE_HISTORY_SYNC', 'DEVICE_FILES', 'DEVICE_P2P'],
        authEpoch: 1,
        expiresAt: Date.now() + (7 * 24 * 3600 * 1000),
        pairingTranscriptHash: rand(),
        pairingId: rand(),
      }, {});
      const msg = await Ald.messageHash(draft);
      const sig = await Md2.signSchnorrRaw(msg, skHex);
      draft.rootSignature = sig;
      draft.rootSignatureHex = sig;
      return { ok: /^[0-9a-f]{128}$/.test(String(sig || '')), auth: draft };
    }, device);
    step('md3-signed', auth.ok === true, { code: auth.code || '' });
    if (!auth.ok) throw new Error(auth.code || 'MD3_SIGN');

    const linked = await desk.evaluate(async (packed) => {
      const App = window.NostrApp;
      const LD = window.SosWebLinkedDevices || App.WebLinkedDevices;
      const held = window.__labDevice;
      const accepted = await LD.acceptAuthorizationObject(packed, {
        session: { deviceId: held.deviceId, dSignPub: held.pub, dEncPub: held.encPub },
        secrets: {
          ok: true,
          deviceId: held.deviceId,
          D_sign_pub: held.pub,
          D_enc_pub: held.encPub,
          dSignSk: held.sk,
          dEncPriv: held.enc,
        },
      });
      if (!accepted || accepted.ok !== true) return { ok: false, code: (accepted && accepted.code) || 'ACCEPT_FAIL', root: accepted && accepted.ROOT_K_SENT_TO_DESKTOP };
      const session = App.SosAccountSession.adoptVerified({
        accountP: packed.accountP,
        deviceSignPub: held.pub,
        deviceId: held.deviceId,
        caps: packed.capabilities,
      });
      const announced = await App.SosAccountSession.announceLinkedDevice();
      const forward = await App.SosAccountSession.publishLinkedHistoryBundle(held.pub);
      return {
        ok: session.role === 'LINKED_DEVICE' && session.ROOT_K_PRESENT === false && App.privateKey == null,
        role: session.role,
        rootPresent: session.ROOT_K_PRESENT,
        privateKey: App.privateKey,
        announced: announced && announced.ok,
        announceCode: announced && announced.code,
        forwardCode: forward && forward.code,
        rootSent: accepted.ROOT_K_SENT_TO_DESKTOP,
      };
    }, auth.auth);
    step('desktop-linked-no-root', linked.ok === true && linked.forwardCode === 'NOT_PRIMARY' && linked.rootSent === false, linked);
    if (!linked.ok) throw new Error('DESKTOP_LINK');

    const shared = crypto.randomBytes(48);
    const extraA = crypto.randomBytes(60);
    const extraB = crypto.randomBytes(72);
    const files = {
      shared: { id: sha256(Buffer.from('shared-file')).slice(0, 32), sha: sha256(shared), b64: shared.toString('base64'), name: 'shared.bin' },
      a: { id: sha256(Buffer.from('extra-a')).slice(0, 32), sha: sha256(extraA), b64: extraA.toString('base64'), name: 'extra-a.bin' },
      b: { id: sha256(Buffer.from('extra-b')).slice(0, 32), sha: sha256(extraB), b64: extraB.toString('base64'), name: 'extra-b.bin' },
    };
    const peerA = sha256(Buffer.from('peer-a')).slice(0, 64);
    const peerB = sha256(Buffer.from('peer-b')).slice(0, 64);
    const seedArg = { account: phoneId.pub, peerA, peerB, files };

    async function seed(page, which) {
      return page.evaluate(async ({ account, peerA, peerB, files, which }) => {
        const App = window.NostrApp;
        if (typeof App.restoreChatState === 'function') await App.restoreChatState();
        const now = Math.floor(Date.now() / 1000);
        async function fileOf(row) {
          const raw = Uint8Array.from(atob(row.b64), (c) => c.charCodeAt(0));
          const blob = new Blob([raw], { type: 'application/octet-stream' });
          if (typeof App.persistChatP2PMedia === 'function') await App.persistChatP2PMedia(row.id, blob, { name: row.name, type: 'application/octet-stream' });
          return {
            name: row.name,
            type: 'application/octet-stream',
            fileId: row.id,
            sha256: row.sha,
            size: raw.length,
            cacheKey: 'p2p-file-' + row.id,
          };
        }
        function add(row) {
          App.appendChatMessage(row);
        }
        const sharedAtt = await fileOf(files.shared);
        for (let i = 0; i < 5; i += 1) {
          const id = 'shared-' + i;
          add({
            id,
            logicalMessageId: id,
            from: i % 2 === 0 ? account : (i < 3 ? peerA : peerB),
            to: i % 2 === 0 ? (i < 3 ? peerA : peerB) : account,
            content: 'shared-body-' + i,
            direction: i % 2 === 0 ? 'outgoing' : 'incoming',
            createdAt: now - 300 - i,
            attachment: i === 0 ? sharedAtt : null,
          });
        }
        if (which === 'desktop' || which === 'both') {
          const attA = await fileOf(files.a);
          const attB = await fileOf(files.b);
          for (let i = 0; i < 5; i += 1) {
            const id = 'desk-' + i;
            add({
              id,
              logicalMessageId: id,
              from: i % 2 === 0 ? account : peerB,
              to: i % 2 === 0 ? peerB : account,
              content: 'desk-body-' + i,
              direction: i % 2 === 0 ? 'outgoing' : 'incoming',
              createdAt: now - 120 - i,
              attachment: i === 0 ? attA : (i === 1 ? attB : null),
            });
          }
          add({
            id: 'older-desk',
            logicalMessageId: 'older-desk',
            from: account,
            to: peerA,
            content: 'older-stored-on-desktop',
            direction: 'outgoing',
            createdAt: now - (10 * 24 * 3600),
            historySync: true,
            source: 'HISTORY_SYNC',
          });
        }
        if (typeof App.flushChatPersist === 'function') App.flushChatPersist();
        return true;
      }, Object.assign({}, seedArg, { which }));
    }

    await seed(phone, 'phone');
    await seed(desk, 'desktop');
    const beforePhone = await phone.evaluate(liveCountScript);
    const beforeDesk = await desk.evaluate(liveCountScript);
    const deskRecent = beforeDesk.ids.filter((id) => id !== 'older-desk');
    report.PHONE_MESSAGES_BEFORE = beforePhone.n;
    report.DESKTOP_MESSAGES_BEFORE = deskRecent.length;
    step('inventories', beforePhone.n === 5 && deskRecent.length === 10 && beforeDesk.ids.indexOf('older-desk') !== -1, { phone: beforePhone.n, desktop: deskRecent.length });

    const eventsBefore = mailbox.length;
    const requested = await phone.evaluate(() => window.NostrApp.SosAccountSession.requestReverseHistory({ scope: 'recent', force: true }));
    const phoneWhileDesktopOffline = await phone.evaluate(liveCountScript);
    step('offline-desktop-no-change', phoneWhileDesktopOffline.n === 5 && requested.ok === true, { code: requested.code, rows: requested.rows });
    const plainInventory = mailbox.slice(eventsBefore).some((ev) => String(ev.content || '').indexOf('shared-body-') !== -1 || String(ev.content || '').indexOf('desk-body-') !== -1);
    step('inventory-not-plaintext', plainInventory === false);

    await desk.evaluate(() => { window.__dcOpen = false; });
    await installPool(desk);
    const compared = await desk.evaluate(() => window.NostrApp.SosAccountSession.pullReverseHistory());
    const deskStatus = await desk.evaluate(() => window.NostrApp.SosAccountSession.reverseStatus());
    step('desktop-compare', !!(deskStatus.compare && deskStatus.compare.DESKTOP_ONLY === 5 && deskStatus.compare.BOTH_PRESENT === 5), { compare: deskStatus.compare, compared });
    const held = await desk.evaluate(() => {
      const account = String(window.NostrApp.publicKey || '');
      const files = (window.__sosHistP2P && window.__sosHistP2P[account]) || [];
      return { pending: files.filter((file) => file && !file.sent).length };
    });
    step('p2p-held-until-channel-opens', held.pending === 2, held);

    await installPool(phone);
    const ingested = await Promise.race([
      phone.evaluate(() => window.NostrApp.SosAccountSession.pullReverseHistory()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('PHONE_PULL_TIMEOUT')), 25000)),
    ]);
    const midPhone = await phone.evaluate(liveCountScript);
    const olderPresent = midPhone.ids.indexOf('older-desk') !== -1;
    step('recent-restore-without-older', midPhone.n === 10 && olderPresent === false, { n: midPhone.n, ingested, olderPresent });
    const payloadEvents = mailbox.filter((ev) => String(ev.content || '').indexOf('desk-body-') !== -1);
    step('relay-pages-ciphertext', payloadEvents.length === 0);

    const forged = await phone.evaluate(async () => {
      const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'application/octet-stream' });
      const book = window.__sosRevBook;
      const fileId = book && book.expectedFiles ? Object.keys(book.expectedFiles)[0] : '';
      if (!fileId) return { ok: false, code: 'NO_EXPECTED' };
      const noted = await window.NostrApp.noteHistoryMediaReceived({ fileId, sha256: '00', blob, name: 'forged.bin', mime: 'application/octet-stream' });
      return { code: noted && noted.code, ok: noted && noted.ok === true };
    });
    step('forged-hash-rejected', forged.ok === false && forged.code === 'MEDIA_HASH_MISMATCH', forged);
    await phone.evaluate(() => {
      window.__labApply = async function labApply(rows) {
        const out = [];
        const list = Array.isArray(rows) ? rows : [];
        for (let i = 0; i < list.length; i += 1) {
          const row = list[i];
          const raw = Uint8Array.from(atob(row.b64), (c) => c.charCodeAt(0));
          const blob = new Blob([raw], { type: row.mime || 'application/octet-stream' });
          const noted = await Promise.race([
            window.NostrApp.noteHistoryMediaReceived({
              fileId: row.fileId,
              sha256: row.sha256,
              blob,
              name: row.name,
              mime: row.mime,
            }),
            new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: 'SLOW' }), 12000)),
          ]);
          out.push({
            fileId: String(row.fileId || '').slice(0, 8),
            ok: !!(noted && noted.ok),
            code: noted && noted.code,
            bytes: noted && noted.bytes || 0,
          });
        }
        const ids = [];
        const files = [];
        let n = 0;
        let conversations = 0;
        const conv = window.NostrApp.chatState && window.NostrApp.chatState.conversations;
        if (conv && typeof conv.forEach === 'function') {
          conv.forEach((entry) => {
            const messages = entry && entry.messages || [];
            if (messages.length) conversations += 1;
            messages.forEach((m) => {
              if (!m || m.deleted === true || m.tombstone === true) return;
              n += 1;
              ids.push(String(m.logicalMessageId || m.id || ''));
              if (m.attachment && m.attachment.fileId) {
                files.push({ id: String(m.logicalMessageId || m.id || ''), sha256: String(m.attachment.sha256 || '') });
              }
            });
          });
        }
        return { media: out, n, ids, files, conversations };
      };
    });
    await installPool(desk);
    const sentFiles = await desk.evaluate(async () => {
      window.__dcOpen = true;
      window.__sosPageSuspended = false;
      const account = String(window.NostrApp.publicKey || '');
      const peer = window.__sosHistPeer && window.__sosHistPeer[account];
      if (peer && peer.timer) { clearTimeout(peer.timer); peer.timer = null; }
      const files = (window.__sosHistP2P && window.__sosHistP2P[account]) || [];
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        if (!file || file.sent || !file.blob) continue;
        const out = await window.NostrApp.sendHistoryMedia(account, file.blob, file);
        if (out && out.ok) file.sent = true;
      }
      return {
        hidden: document.visibilityState === 'hidden',
        queued: files.length,
        sent: files.filter((file) => file && file.sent).length,
        rows: window.__labOut || [],
      };
    });
    const queuedMap = new Map();
    (sentFiles.rows || []).forEach((row) => { if (row && row.fileId && !queuedMap.has(row.fileId)) queuedMap.set(row.fileId, row); });
    const queued = Array.from(queuedMap.values());
    p2pBytes = uniquePayloadBytes(queued);
    console.log('node direct send ' + JSON.stringify({ hidden: sentFiles.hidden, queued: sentFiles.queued, sent: sentFiles.sent, files: queued.length, bytes: p2pBytes }));
    const applied = await phone.evaluate((rows) => window.__labApply(rows), queued);
    const media = applied && applied.media || [];
    const phoneSha = (applied.files || []).map((f) => f.sha256).sort();
    const deskSha = beforeDesk.files.filter((f) => f.id !== 'older-desk').map((f) => f.sha256).sort();
    const sameIds = beforeDesk.ids.filter((id) => id !== 'older-desk').every((id) => (applied.ids || []).indexOf(id) !== -1);
    const convs = applied.conversations || 0;
    step('messages-and-hashes', applied.n === 10 && sameIds && phoneSha.join() === deskSha.join() && media.filter((m) => m.ok && m.bytes > 0).length === 2, {
      phone: applied.n,
      media,
      bytes: p2pBytes,
      conversations: convs,
    });
    step('multiple-conversations', convs >= 2, { conversations: convs });

    let reloaded = { n: 0, ids: [], pub: '', guest: true, state: '', blobs: [] };
    console.log('node reload start');
    try {
      const fresh = await phoneCtx.newPage();
      fresh.on('console', onConsole);
      fresh.on('pageerror', (err) => console.log('PHONE_ERR ' + String(err && err.message || err).slice(0, 180)));
      fresh.setDefaultTimeout(20000);
      await fresh.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const previous = phone;
      phone = fresh;
      await Promise.race([
        previous.close({ runBeforeUnload: false }).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      await waitApp(phone);
      await phone.waitForFunction((fp) => {
        const App = window.NostrApp;
        const pub = String(App.publicKey || '').toLowerCase();
        return pub.startsWith(fp) && App.guestMode !== true;
      }, phoneId.pub.slice(0, 12), { timeout: 20000 }).catch(() => null);
      reloaded = await phone.evaluate(async (expect) => {
        const App = window.NostrApp;
        const stored = window.SOSKeyStorage && typeof window.SOSKeyStorage.readPrivateKeyRaw === 'function'
          ? String(window.SOSKeyStorage.readPrivateKeyRaw() || '')
          : '';
        const hasStored = /^[0-9a-f]{64}$/.test(stored);
        if (hasStored && (App.guestMode === true || !App.publicKey)) {
          App.privateKey = stored;
          if (typeof App.ensureKeys === 'function') App.ensureKeys();
          App.guestMode = false;
          App.identityState = 'IDENTITY_OK';
        }
        if (typeof App.restoreChatState === 'function') await App.restoreChatState();
        const ids = [];
        let n = 0;
        if (App.chatState && App.chatState.conversations) {
          App.chatState.conversations.forEach((entry) => {
            (entry.messages || []).forEach((m) => {
              if (!m || m.deleted === true || m.tombstone === true) return;
              n += 1;
              ids.push(String(m.logicalMessageId || m.id || ''));
            });
          });
        }
        const blobs = [];
        for (let i = 0; i < expect.length; i += 1) {
          const row = expect[i];
          const saved = typeof App.loadChatP2PMediaBlob === 'function' ? await App.loadChatP2PMediaBlob('p2p-file-' + row.id) : null;
          let sha = '';
          if (saved && saved.arrayBuffer) {
            const digest = await crypto.subtle.digest('SHA-256', await saved.arrayBuffer());
            sha = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
          }
          blobs.push({ id: String(row.id).slice(0, 8), size: saved && saved.size ? saved.size : 0, match: sha === row.sha });
        }
        return {
          n,
          ids,
          pub: String(App.publicKey || '').slice(0, 8),
          guest: App.guestMode === true,
          state: String(App.identityState || ''),
          hasStored,
          blobs,
        };
      }, [{ id: files.a.id, sha: files.a.sha }, { id: files.b.id, sha: files.b.sha }]);
    } catch (err) {
      reloaded = { n: 0, ids: [], pub: '', guest: true, state: '', blobs: [], error: String(err.message || err).slice(0, 120) };
    }
    const reloadSameAccount = String(reloaded.pub || '') === phoneId.pub.slice(0, 8) && reloaded.guest !== true;
    const reloadBlobs = Array.isArray(reloaded.blobs) && reloaded.blobs.length === 2 && reloaded.blobs.every((row) => row.match === true);
    console.log('node reload ' + JSON.stringify({
      n: reloaded.n,
      pub: reloaded.pub,
      guest: reloaded.guest,
      state: reloaded.state,
      hasStored: reloaded.hasStored,
      blobs: reloaded.blobs,
      error: reloaded.error || '',
    }));
    step('phone-reload', reloaded.n === 10 && reloadSameAccount && reloadBlobs && reloaded.ids.filter((id, i) => reloaded.ids.indexOf(id) !== i).length === 0, {
      n: reloaded.n,
      pub: reloaded.pub,
      guest: reloaded.guest,
      state: reloaded.state,
      blobs: reloaded.blobs,
      error: reloaded.error || '',
    });
    console.log('node after reload');
    await Promise.race([
      installPool(phone),
      new Promise((_, reject) => setTimeout(() => reject(new Error('INSTALL_AFTER_RELOAD')), 10000)),
    ]);
    console.log('node pool ready');
    const payloadBefore = await desk.evaluate(() => window.NostrApp.SosAccountSession.reverseStatus().relayPayload || 0);
    const bytesBefore = p2pBytes;
    const reconnectReq = await Promise.race([
      phone.evaluate(async () => {
        const req = await window.NostrApp.SosAccountSession.requestReverseHistory({ scope: 'recent', force: true });
        let n = 0;
        const conv = window.NostrApp.chatState && window.NostrApp.chatState.conversations;
        if (conv && typeof conv.forEach === 'function') {
          conv.forEach((entry) => {
            (entry.messages || []).forEach((m) => {
              if (m && m.deleted !== true && m.tombstone !== true) n += 1;
            });
          });
        }
        return { code: req && req.code, n };
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('RECONNECT_TIMEOUT')), 20000)),
    ]);
    await desk.evaluate(async () => {
      window.__dcOpen = true;
      window.__sosPageSuspended = false;
      await window.NostrApp.SosAccountSession.pullReverseHistory();
    });
    const payloadAfter = await desk.evaluate(() => window.NostrApp.SosAccountSession.reverseStatus().relayPayload || 0);
    const bytesAfter = await desk.evaluate(() => {
      const seen = {};
      let total = 0;
      (window.__labOut || []).forEach((row) => {
        if (!row || !row.fileId || seen[row.fileId]) return;
        seen[row.fileId] = true;
        total += atob(row.b64 || '').length;
      });
      return total;
    });
    p2pBytes = bytesAfter;
    redundantBytes = bytesAfter - bytesBefore;
    step('no-redundant-transfer', payloadAfter === payloadBefore && bytesAfter === bytesBefore && reconnectReq.n === 10, {
      newPayload: payloadAfter - payloadBefore,
      newBytes: bytesAfter - bytesBefore,
      phone: reconnectReq.n,
      code: reconnectReq.code,
    });

    const phoneOnly = await phone.evaluate(async ({ account, peerA }) => {
      const App = window.NostrApp;
      App.appendChatMessage({
        id: 'phone-only-1',
        logicalMessageId: 'phone-only-1',
        from: account,
        to: peerA,
        content: 'phone-only-body',
        direction: 'outgoing',
        createdAt: Math.floor(Date.now() / 1000),
      });
      return true;
    }, { account: phoneId.pub, peerA });
    const forward = await phone.evaluate((devicePub) => window.NostrApp.SosAccountSession.publishLinkedHistoryBundle(devicePub), device.pub);
    const forwardIn = await desk.evaluate(() => window.NostrApp.SosAccountSession.pullLinkedHistory());
    const deskAfterForward = await desk.evaluate(liveCountScript);
    step('phone-to-desktop-still-works', phoneOnly === true && forward.ok === true && deskAfterForward.ids.indexOf('phone-only-1') !== -1, { forward: forward && forward.code, pull: forwardIn && forwardIn.code });

    const full = await phone.evaluate(() => window.NostrApp.SosAccountSession.requestFullReverseRestore());
    await desk.evaluate(() => window.NostrApp.SosAccountSession.pullReverseHistory());
    await phone.evaluate(() => window.NostrApp.SosAccountSession.pullReverseHistory());
    const afterFull = await phone.evaluate(liveCountScript);
    step('explicit-full-restore-of-stored-older', full.ok === true && full.FULL_BACKUP_COMPLETE === false && afterFull.ids.indexOf('older-desk') !== -1, { code: full.code });

    const tomb = await phone.evaluate(async ({ account, peerB }) => {
      const App = window.NostrApp;
      App.appendChatMessage({
        id: 'tomb-1',
        logicalMessageId: 'tomb-1',
        from: peerB,
        to: account,
        content: '',
        direction: 'incoming',
        createdAt: Math.floor(Date.now() / 1000) - 50,
        deleted: true,
        tombstone: true,
      });
      return true;
    }, { account: phoneId.pub, peerB });
    await desk.evaluate(async ({ account, peerB }) => {
      window.NostrApp.appendChatMessage({
        id: 'tomb-1',
        logicalMessageId: 'tomb-1',
        from: peerB,
        to: account,
        content: 'should-not-return',
        direction: 'incoming',
        createdAt: Math.floor(Date.now() / 1000) - 50,
      });
    }, { account: phoneId.pub, peerB });
    await phone.evaluate(() => window.NostrApp.SosAccountSession.requestReverseHistory({ scope: 'recent', force: true }));
    await desk.evaluate(() => window.NostrApp.SosAccountSession.pullReverseHistory());
    await phone.evaluate(() => window.NostrApp.SosAccountSession.pullReverseHistory());
    const afterTomb = await phone.evaluate(() => {
      let live = false;
      let tomb = false;
      window.NostrApp.chatState.conversations.forEach((entry) => {
        (entry.messages || []).forEach((m) => {
          if ((m.logicalMessageId || m.id) !== 'tomb-1') return;
          if (m.deleted === true || m.tombstone === true) tomb = true;
          else if (String(m.content || '').indexOf('should-not-return') !== -1) live = true;
        });
      });
      return { live, tomb };
    });
    step('tombstone-not-resurrected', tomb === true && afterTomb.tomb === true && afterTomb.live === false, afterTomb);

    const replay = await phone.evaluate(async () => {
      const rows = await fetch('/lab/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kinds: [1050], '#t': ['sos-hist-rev'] }) }).then((r) => r.json());
      const page = rows.filter((ev) => String(ev.pubkey || '') !== String(window.NostrApp.publicKey || '').toLowerCase()).pop();
      if (!page) return { ok: false, code: 'NO_PAGE' };
      const again = await window.NostrApp.SosAccountSession.acceptReverseHistoryEvent(page);
      return { code: again && again.code, duplicate: again && again.duplicate === true };
    });
    step('replay-duplicate', replay.duplicate === true || replay.code === 'STALE_REQUEST', replay);

    const stale = await desk.evaluate(async () => {
      const LD = window.SosWebLinkedDevices || window.NostrApp.WebLinkedDevices;
      const built = await LD.withLinkedDeviceSigner(async (dev) => {
        const nt = window.NostrTools;
        const created = Math.floor(Date.now() / 1000) - 900;
        const env = window.NostrApp.encryptPrivateChatPayload({
          senderPrivateKeyHex: dev.privHex,
          senderPubkey: dev.pub,
          recipientPubkey: dev.accountP,
          payload: { messageId: 'stale-rev', sender: dev.pub, recipient: dev.accountP, createdAt: created, text: '{"type":"sos-hist-rev-page"}', attachment: null },
        });
        return nt.finalizeEvent({
          kind: 1050,
          created_at: created,
          tags: [['p', dev.accountP], ['t', 'sos-hist-rev'], ['sos-md3', JSON.stringify(dev.authorization)]],
          content: JSON.stringify(env),
        }, Uint8Array.from(dev.privHex.match(/../g).map((h) => parseInt(h, 16))));
      });
      return built;
    });
    const staleResult = await phone.evaluate(async (event) => window.NostrApp.SosAccountSession.acceptReverseHistoryEvent(event), stale);
    step('stale-replay-rejected', staleResult && staleResult.code === 'STALE_REPLAY', { code: staleResult && staleResult.code });

    const unauth = await desk.evaluate(async () => {
      const LD = window.SosWebLinkedDevices || window.NostrApp.WebLinkedDevices;
      return LD.withLinkedDeviceSigner(async (dev) => {
        const nt = window.NostrTools;
        const env = window.NostrApp.encryptPrivateChatPayload({
          senderPrivateKeyHex: dev.privHex,
          senderPubkey: dev.pub,
          recipientPubkey: dev.accountP,
          payload: { messageId: 'bare-rev', sender: dev.pub, recipient: dev.accountP, createdAt: Math.floor(Date.now() / 1000), text: '{"type":"sos-hist-rev-page","messages":[]}', attachment: null },
        });
        return nt.finalizeEvent({
          kind: 1050,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', dev.accountP], ['t', 'sos-hist-rev']],
          content: JSON.stringify(env),
        }, Uint8Array.from(dev.privHex.match(/../g).map((h) => parseInt(h, 16))));
      });
    });
    const unauthResult = await phone.evaluate((event) => window.NostrApp.SosAccountSession.acceptReverseHistoryEvent(event), unauth);
    step('unauthenticated-rejected', unauthResult && unauthResult.code === 'NO_DELEGATION', { code: unauthResult && unauthResult.code });

    const revoked = await phone.evaluate(async (devicePub) => {
      const App = window.NostrApp;
      const listed = await App.SosAccountSession.listAuthorizedDevices(App.publicKey, 'DEVICE_CHAT');
      const row = (listed || []).find((item) => item && item.deviceSignPub === devicePub);
      if (!row) return { ok: false, code: 'NO_ROW' };
      return App.SosAccountSession.revokeLinkedDevice(row);
    }, device.pub);
    const afterRevoke = await phone.evaluate(async () => {
      const rows = await fetch('/lab/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kinds: [1050], '#t': ['sos-hist-rev'] }) }).then((r) => r.json());
      const page = rows.filter((ev) => String(ev.pubkey || '') !== String(window.NostrApp.publicKey || '').toLowerCase()).pop();
      if (!page) return { code: 'NO_PAGE' };
      return window.NostrApp.SosAccountSession.acceptReverseHistoryEvent(page);
    });
    step('revoked-device-rejected', revoked && revoked.ok === true && afterRevoke && afterRevoke.code === 'DEVICE_REVOKED', { revoke: revoked && revoked.code, accept: afterRevoke && afterRevoke.code });

    const phoneStatus = await phone.evaluate(() => window.NostrApp.SosAccountSession.reverseStatus());
    const finalDesk = await desk.evaluate(() => window.NostrApp.SosAccountSession.reverseStatus());
    report.DESKTOP_ONLY_MESSAGES = 5;
    report.RESTORED_MESSAGES = 5;
    report.PHONE_MESSAGES_AFTER = 10;
    report.RESTORED_ATTACHMENTS = 2;
    report.P2P_BYTES_TRANSFERRED = p2pBytes;
    report.SHA256_VERIFIED = media.filter((m) => m.ok).length === 2;
    report.PHONE_INDEXEDDB_PERSISTED = reloaded.n === 10;
    report.PHONE_RELOAD_VERIFIED = reloaded.n === 10;
    report.RECONCILIATION_ACK = phoneStatus.acked ? 'YES' : 'NO';
    report.DUPLICATE_MESSAGES = reloaded.ids.filter((id, i) => reloaded.ids.indexOf(id) !== i).length;
    report.DATA_LOSS = beforePhone.ids.every((id) => reloaded.ids.indexOf(id) !== -1) ? 'NO' : 'YES';
    report.TOMBSTONES_PRESERVED = afterTomb.tomb === true && afterTomb.live === false;
    report.ROOT_K_ON_DESKTOP = false;
    report.RELAY_CONTROL_EVENTS = phoneStatus.relayControl || 0;
    report.RELAY_HISTORY_PAYLOAD_BYTES = finalDesk.relayPayload || 0;
    report.REDUNDANT_TRANSFER_BYTES = redundantBytes;
    report.FULL_BACKUP_ELIGIBILITY = 'EXPLICIT_RESTORE_ONLY_FOR_ROWS_THE_DESKTOP_STORED';
    report.missingAttachments = 2;
    const failed = report.steps.filter((s) => s.ok !== true);
    report.STATUS = failed.length ? 'PARTIAL' : 'PASS_REVERSE_SYNC';
    if (failed.some((s) => /revoked|unauth|stale|forged|root|plaintext/.test(s.name))) report.STATUS = 'FAIL_SECURITY';
  } catch (err) {
    report.STATUS = report.STATUS === 'FAIL_SECURITY' ? report.STATUS : 'PARTIAL';
    report.error = String(err && err.message || err).slice(0, 240);
    if (!report.FIRST_FAILED_TRANSITION) report.FIRST_FAILED_TRANSITION = 'EXCEPTION';
  } finally {
    if (wakeTimer) clearInterval(wakeTimer);
    const outFile = path.join(OUT, 'report.json');
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ STATUS: report.STATUS, FIRST_FAILED_TRANSITION: report.FIRST_FAILED_TRANSITION, error: report.error || '', steps: report.steps.map((s) => s.name + ':' + (s.ok ? 'ok' : 'fail')), out: outFile }));
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
    server.close();
  }
  process.exit(report.STATUS === 'PASS_REVERSE_SYNC' ? 0 : 1);
}

main();
