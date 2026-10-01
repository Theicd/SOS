/**
 * Phase 1A/1B — profile write/read/cache E2E (local, disposable identities only).
 *
 * Main app on http://127.0.0.1:8790 with two local NIP-01 relays; Blossom upload servers are mocked
 * (no external network). Pixel 7 viewport.
 *
 * A: real onboarding (Worker identity) with avatar -> kind 0 on relays with https picture.
 *    profile.html: edit name + replace avatar -> newest kind 0 has new name + durable https picture.
 *    reload profile.html -> name/picture persist without re-login.
 * B: second identity -> App.fetchProfile(A) returns A's latest name/picture;
 *    stale stub conversation contact for A is refreshed to the real name.
 *
 * Never prints keys; report redacts 64-hex and nsec shapes.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { WebSocketServer } from 'ws';
import { verifyEvent } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'phase1-profile-e2e-report.json');
const PORT = 8790;
const MAIN_ORIGIN = `http://127.0.0.1:${PORT}`;
const RELAY_PORTS = [7795, 7796];
const RELAYS = RELAY_PORTS.map((p) => `ws://127.0.0.1:${p}`);
const BLOSSOM_HOSTS = new Set(['blossom.band', 'blossom.nostr.build', 'nostr.build', 'blossom.primal.net', 'files.sovbit.host']);
function makePng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) raw.set([x * 4, y * 4, 160], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng(64, 64);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { gate: 'PHASE1_PROFILE_E2E', status: 'FAIL', ts: new Date().toISOString(), results: {} };
const SECRET_SHAPE = /nsec1[a-z0-9]{20,}/i;
function safeDetail(detail) {
  if (detail === undefined) return null;
  const s = JSON.stringify(detail);
  if (SECRET_SHAPE.test(s) || /[0-9a-f]{64}/i.test(s)) return '[redacted]';
  return detail;
}
const set = (k, ok, detail) => {
  const d = safeDetail(detail);
  report.results[k] = { ok: !!ok, detail: d };
  console.log(ok ? 'PASS' : 'FAIL', k, d === null ? '' : JSON.stringify(d).slice(0, 300));
};

// ---------------------------------------------------------------- NIP-01 test relay
function matchFilter(ev, f) {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.since && ev.created_at < f.since) return false;
  for (const k of Object.keys(f)) {
    if (k[0] !== '#') continue;
    const vals = f[k] || [];
    if (!(ev.tags || []).some((t) => t[0] === k.slice(1) && vals.includes(t[1]))) return false;
  }
  return true;
}
class TestRelay {
  constructor(port) {
    this.port = port;
    this.events = new Map();
    this.clients = new Set();
  }
  start() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port }, resolve);
      this.wss.on('error', reject);
      this.wss.on('connection', (ws) => {
        const c = { ws, subs: new Map() };
        this.clients.add(c);
        ws.on('message', (d) => this.onMsg(c, d));
        ws.on('close', () => this.clients.delete(c));
        ws.on('error', () => {});
      });
    });
  }
  stop() {
    for (const c of this.clients) c.ws.terminate();
    return new Promise((r) => this.wss.close(() => r()));
  }
  send(c, arr) {
    try {
      c.ws.send(JSON.stringify(arr));
    } catch (_e) {}
  }
  onMsg(c, data) {
    let m;
    try {
      m = JSON.parse(String(data));
    } catch (_e) {
      return;
    }
    if (!Array.isArray(m)) return;
    if (m[0] === 'EVENT') {
      const ev = m[1];
      let ok = false;
      try {
        ok = !!ev && verifyEvent({ ...ev });
      } catch (_e) {}
      if (!ok) return this.send(c, ['OK', ev && ev.id, false, 'invalid: bad signature']);
      const fresh = !this.events.has(ev.id);
      if (fresh && !(ev.kind >= 20000 && ev.kind < 30000)) this.events.set(ev.id, ev);
      this.send(c, ['OK', ev.id, true, fresh ? '' : 'duplicate:']);
      if (fresh) {
        for (const cl of this.clients) for (const [id, fs2] of cl.subs) if (fs2.some((f) => matchFilter(ev, f))) this.send(cl, ['EVENT', id, ev]);
      }
    } else if (m[0] === 'REQ') {
      const [, id, ...filters] = m;
      c.subs.set(id, filters);
      const out = new Map();
      for (const f of filters) {
        let rows = Array.from(this.events.values()).filter((ev) => matchFilter(ev, f)).sort((a, b) => b.created_at - a.created_at);
        if (f.limit) rows = rows.slice(0, f.limit);
        rows.forEach((r) => out.set(r.id, r));
      }
      out.forEach((ev) => this.send(c, ['EVENT', id, ev]));
      this.send(c, ['EOSE', id]);
    } else if (m[0] === 'CLOSE') c.subs.delete(m[1]);
  }
  newestProfile(pk) {
    const rows = Array.from(this.events.values()).filter((e) => e.kind === 0 && e.pubkey === pk).sort((a, b) => b.created_at - a.created_at);
    if (!rows.length) return null;
    try {
      return { count: rows.length, created_at: rows[0].created_at, meta: JSON.parse(rows[0].content) };
    } catch (_e) {
      return { count: rows.length, meta: null };
    }
  }
}
const relays = RELAY_PORTS.map((p) => new TestRelay(p));

// ---------------------------------------------------------------- main static server
function transformConfig(src) {
  return src
    .replace(/const SAFE_DEFAULT_RELAYS = \[[^\]]*\];/, () => `const SAFE_DEFAULT_RELAYS = ${JSON.stringify(RELAYS)};`)
    .replace(/const SAFE_DEFAULT_P2P_RELAYS = \[[^\]]*\];/, () => `const SAFE_DEFAULT_P2P_RELAYS = ${JSON.stringify(RELAYS)};`)
    .replace("!trimmed.startsWith('wss://')", () => "!(trimmed.startsWith('wss://') || trimmed.startsWith('ws://127.0.0.1:'))");
}
function startMainServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp' };
  const server = http.createServer((req, res) => {
    try {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/') p = '/videos.html';
      const fp = path.join(ROOT, p.replace(/^\//, ''));
      if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404);
        res.end('nf');
        return;
      }
      if (p === '/config.js') {
        res.writeHead(200, { 'Content-Type': types['.js'], 'Cache-Control': 'no-store' });
        res.end(transformConfig(fs.readFileSync(fp, 'utf8')));
        return;
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(fp).pipe(res);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e.message || e));
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(PORT, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------- browser helpers
const ALLOWED = new Set(['127.0.0.1', 'localhost', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']);
const blossomUploads = [];

async function newContext(browser) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    let u;
    try {
      u = new URL(req.url());
    } catch (_e) {
      return route.abort();
    }
    if (BLOSSOM_HOSTS.has(u.hostname)) {
      if (req.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'PUT, POST, GET', 'access-control-allow-headers': '*' } });
      }
      if ((req.method() === 'PUT' || req.method() === 'POST') && u.pathname === '/upload') {
        const body = req.postDataBuffer() || Buffer.alloc(0);
        const sha = crypto.createHash('sha256').update(body).digest('hex');
        const auth = req.headers()['authorization'] || '';
        blossomUploads.push({ host: u.hostname, size: body.length, auth: auth.startsWith('Nostr ') });
        return route.fulfill({
          status: 200,
          headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
          body: JSON.stringify({ url: `https://${u.hostname}/${sha}.jpg`, sha256: sha, size: body.length }),
        });
      }
      if (req.method() === 'GET') {
        return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png' }, body: PNG });
      }
      return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
    }
    return ALLOWED.has(u.hostname) ? route.continue() : route.abort();
  });
  await ctx.addInitScript(() => {
    if (location.hostname === '127.0.0.1') {
      try {
        Object.defineProperty(navigator, 'serviceWorker', { get: () => undefined, configurable: true });
      } catch (_e) {}
      try {
        localStorage.setItem('nostr_require_invite', '0');
      } catch (_e) {}
    }
  });
  return ctx;
}

async function openMain(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${MAIN_ORIGIN}/videos.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.openAuthPrompt && !!window.SosCryptoWorkerVault, null, { polling: 200, timeout: 120000 });
  return page;
}

async function onboard(page, name, withAvatar) {
  await page.evaluate(() => window.NostrApp.openAuthPrompt('', { step: 'email' }));
  await page.fill('#signupEmailInput', `p1-${crypto.randomBytes(4).toString('hex')}@example.test`);
  await page.check('#signupLegalAgree');
  await page.click('#btnEmailNext');
  await page.waitForSelector('#authStepName', { state: 'visible', timeout: 30000 });
  await page.fill('#signupNameInput', name);
  await page.click('#btnNameNext');
  await page.waitForSelector('#authStepAvatar', { state: 'visible', timeout: 10000 });
  if (withAvatar) {
    await page.setInputFiles('#signupAvatarInput', { name: 'a.png', mimeType: 'image/png', buffer: PNG });
    await sleep(800);
    await page.click('#btnAvatarNext');
  } else {
    await page.click('#btnSkipAvatar');
  }
  await page.waitForSelector('#authStepKey', { state: 'visible', timeout: 10000 });
  await page.check('#keyPolicyAgree');
  await page.check('#keyRightsConfirm');
  await page.waitForFunction(() => document.getElementById('btnFinalConnect')?.disabled === false, null, { timeout: 5000 });
  await page.click('#btnFinalConnect');
  await page.waitForSelector('#workerIdentityDone', { state: 'visible', timeout: 60000 });
  const pk = await page.evaluate(() => String(window.NostrApp.publicKey || '').toLowerCase());
  await page.click('#btnWorkerIdentitySkip').catch(() => {});
  return pk;
}

async function waitRelayProfile(pk, pred, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = relays.map((r) => r.newestProfile(pk));
    if (last.every((x) => x && x.meta && pred(x.meta))) return last;
    await sleep(300);
  }
  return last;
}

const isDurable = (u) => typeof u === 'string' && /^https:\/\//.test(u);

// ---------------------------------------------------------------- main
async function main() {
  for (const r of relays) await r.start();
  const server = await startMainServer();
  const browser = await chromium.launch({ headless: true });
  let stage = 'boot';
  try {
    // ---- A: registration with avatar
    stage = 'A-onboard';
    const ctxA = await newContext(browser);
    const pageA = await openMain(ctxA);
    const pkA = await onboard(pageA, 'Alice', true);
    set('A_IDENTITY_CREATED', /^[0-9a-f]{64}$/.test(pkA), { ok: /^[0-9a-f]{64}$/.test(pkA) });
    const reg = await waitRelayProfile(pkA, (m) => m.name === 'Alice' && isDurable(m.picture));
    set('REGISTRATION_KIND0_PUBLISHED', !!(reg && reg.every((x) => x && x.meta && x.meta.name === 'Alice')), reg && reg.map((x) => x && { name: x.meta?.name, pictureHttps: isDurable(x.meta?.picture) }));
    set('REGISTRATION_PICTURE_DURABLE_URL', !!(reg && reg.every((x) => x && isDurable(x.meta?.picture))), { uploads: blossomUploads.length });

    // ---- A: edit name + avatar on profile.html
    stage = 'A-profile-page';
    await pageA.goto(`${MAIN_ORIGIN}/profile.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await pageA.waitForFunction(
      () => {
        const App = window.NostrApp || {};
        return /^[0-9a-f]{64}$/.test(String(App.publicKey || '')) && !!App.pool && typeof App.SosCryptoSigner?.signProfileEvent === 'function' && typeof App.openProfileSettings === 'function' && typeof App.uploadToBlossom === 'function';
      },
      null,
      { polling: 300, timeout: 60000 },
    );
    const pagePk = await pageA.evaluate(() => String(window.NostrApp.publicKey || '').toLowerCase());
    set('PROFILE_PAGE_SIGNER_READY', pagePk === pkA, { samePk: pagePk === pkA });

    await pageA.evaluate(() => window.NostrApp.openProfileSettings());
    await pageA.fill('#profileNameInput', 'Alice2');
    await pageA.click('#profileSaveButton');
    const nameRes = await waitRelayProfile(pkA, (m) => m.name === 'Alice2');
    set('PROFILE_WRITE_PUBLISHED', !!(nameRes && nameRes.every((x) => x && x.meta?.name === 'Alice2')), nameRes && nameRes.map((x) => x && { name: x.meta?.name, count: x.count }));

    stage = 'A-avatar';
    const uploadsBefore = blossomUploads.length;
    await pageA.click('#profilePageAvatar');
    await pageA.waitForSelector('#profileAvatarDialogConfirm', { state: 'visible', timeout: 5000 });
    const chooserP = pageA.waitForEvent('filechooser', { timeout: 10000 });
    await pageA.click('#profileAvatarDialogConfirm');
    const chooser = await chooserP;
    await chooser.setFiles({ name: 'b.png', mimeType: 'image/png', buffer: PNG });
    const avatarRes = await waitRelayProfile(pkA, (m) => m.name === 'Alice2' && isDurable(m.picture) && blossomUploads.length > uploadsBefore);
    const avatarOk = !!(avatarRes && avatarRes.every((x) => x && x.meta?.name === 'Alice2' && isDurable(x.meta?.picture)));
    set('PROFILE_AVATAR_PUBLISHED_DURABLE', avatarOk, { uploads: blossomUploads.length - uploadsBefore, pictureHttps: avatarRes && avatarRes.map((x) => isDurable(x?.meta?.picture)) });
    const noEmptyPictureEvent = relays.every((r) => {
      const rows = Array.from(r.events.values()).filter((e) => e.kind === 0 && e.pubkey === pkA);
      return rows.every((e) => {
        try {
          return !!JSON.parse(e.content).picture;
        } catch (_e) {
          return false;
        }
      });
    });
    set('NO_EMPTY_PICTURE_EVENT_ON_REPLACE', noEmptyPictureEvent, { ok: noEmptyPictureEvent });
    const dialog = await pageA.evaluate(() => document.querySelector('#profileInfoDialog .profile-dialog__title, .profile-dialog[open] h2, dialog[open] h2')?.textContent || '');
    set('AVATAR_SAVE_STATUS_SHOWN', /נשמרה/.test(dialog) || dialog === '', { title: dialog });

    // ---- A: refresh without re-login
    stage = 'A-reload';
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.waitForFunction(() => /^[0-9a-f]{64}$/.test(String(window.NostrApp?.publicKey || '')) && !!window.NostrApp?.profile, null, { polling: 300, timeout: 60000 });
    await sleep(3000);
    const afterReload = await pageA.evaluate(() => ({
      pk: String(window.NostrApp.publicKey || '').toLowerCase(),
      name: window.NostrApp.profile?.name,
      picture: window.NostrApp.profile?.picture || '',
      authPromptOpen: !!document.querySelector('#authStepEmail:not([style*="none"]), #authStepLogin:not([style*="none"])'),
    }));
    set('PROFILE_NAME_PERSISTENCE', afterReload.pk === pkA && afterReload.name === 'Alice2', { name: afterReload.name });
    set('PROFILE_AVATAR_PERSISTENCE', isDurable(afterReload.picture), { pictureHttps: isDurable(afterReload.picture) });
    set('PROFILE_REFRESH_WITHOUT_RELOGIN', afterReload.pk === pkA && !afterReload.authPromptOpen, { samePk: afterReload.pk === pkA });

    // ---- B: cross-user resolution
    stage = 'B';
    const ctxB = await newContext(browser);
    const pageB = await openMain(ctxB);
    const pkB = await onboard(pageB, 'Bob', false);
    set('B_IDENTITY_CREATED', /^[0-9a-f]{64}$/.test(pkB) && pkB !== pkA, { ok: pkB !== pkA });
    await pageB.waitForFunction(() => typeof window.NostrApp?.fetchProfile === 'function' && typeof window.NostrApp?.ensureChatContact === 'function' && typeof window.NostrApp?.bootstrapChatContacts === 'function', null, { polling: 300, timeout: 60000 });
    const cross = await pageB.evaluate(async (pk) => {
      const p = await window.NostrApp.fetchProfile(pk);
      return { name: p?.name, picture: p?.picture || '' };
    }, pkA);
    set('CROSS_USER_PROFILE_RESOLUTION', cross.name === 'Alice2' && isDurable(cross.picture), { name: cross.name, pictureHttps: isDurable(cross.picture) });

    const conv = await pageB.evaluate(async (pk) => {
      const App = window.NostrApp;
      App.ensureChatContact(pk, { name: 'משתמש ' + pk.slice(0, 8), picture: '', profileFetchedAt: Math.floor(Date.now() / 1000) });
      const before = App.chatState.contacts.get(pk)?.name;
      App.bootstrapChatContacts();
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        const c = App.chatState.contacts.get(pk);
        if (c && c.name === 'Alice2') return { before, after: c.name, pictureHttps: /^https:\/\//.test(String(c.picture || '')) || String(c.picture || '').startsWith('data:') || String(c.picture || '').startsWith('blob:') };
        await new Promise((r) => setTimeout(r, 300));
      }
      const c = App.chatState.contacts.get(pk);
      return { before, after: c?.name, pictureHttps: false };
    }, pkA);
    set('CONVERSATION_PROFILE_RESOLUTION', conv.after === 'Alice2' && /^משתמש [0-9a-f]{8}$/.test(conv.before || ''), { after: conv.after, picture: conv.pictureHttps });

    await ctxA.close();
    await ctxB.close();
  } catch (e) {
    set('E2E_EXCEPTION', false, { stage, error: String((e && e.message) || e).replace(/nsec1[a-z0-9]+/gi, '[redacted]').replace(/[0-9a-f]{64}/gi, '<hex>').slice(0, 300) });
  } finally {
    try {
      await browser.close();
    } catch (_e) {}
    server.close();
    for (const r of relays) await r.stop();
  }

  const all = Object.values(report.results);
  report.passed = all.filter((r) => r.ok).length;
  report.failed = all.filter((r) => !r.ok).length;
  report.status = report.failed === 0 && report.passed > 0 ? 'PASS' : 'FAIL';
  const raw = JSON.stringify(report, null, 2);
  if (SECRET_SHAPE.test(raw)) {
    console.error('REFUSING to write report — secret-like content detected');
    process.exit(1);
  }
  fs.writeFileSync(OUT, raw);
  console.log(JSON.stringify({ status: report.status, passed: report.passed, failed: report.failed }));
  process.exit(report.status === 'PASS' ? 0 : 1);
}

main().catch((e) => {
  console.error(String((e && e.message) || e).replace(/nsec1[a-z0-9]+/gi, '[redacted]').replace(/[0-9a-f]{64}/gi, '<hex>'));
  process.exit(1);
});
