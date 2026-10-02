/**
 * Phase 1A/1B/1C production check (https://sos010.com), disposable identity only.
 *
 * Publishes a disposable test profile (kind 0) to the production relays and uploads a small generated
 * test image to a public Blossom server. Verifies with an independent Node relay query (newest kind 0),
 * reload persistence, and a second fresh browser resolving the profile. Never prints keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'phase1-profile-production-report.json');
const MAIN = 'https://sos010.com';
const RELAYS = ['wss://relay.snort.social', 'wss://nos.lol', 'wss://nostr-relay.xbytez.io', 'wss://nostr-02.uid.ovh'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { gate: 'PHASE1_PROFILE_PRODUCTION_CHECK', status: 'FAIL', ts: new Date().toISOString(), results: {} };
const SECRET_SHAPE = /nsec1[a-z0-9]{20,}/i;
const set = (k, ok, detail) => {
  let d = detail === undefined ? null : detail;
  if (d !== null && (SECRET_SHAPE.test(JSON.stringify(d)) || /[0-9a-f]{64}/i.test(JSON.stringify(d)))) d = '[redacted]';
  report.results[k] = { ok: !!ok, detail: d };
  console.log(ok ? 'PASS' : 'FAIL', k, d === null ? '' : JSON.stringify(d).slice(0, 300));
};

function makePng(w, h, seed) {
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
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) raw.set([(x * 4 + seed) & 255, (y * 4) & 255, 160], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function queryRelay(url, filter, ms = 8000) {
  return new Promise((resolve) => {
    const out = [];
    let ws;
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch (_e) {}
      resolve(out);
    };
    try {
      ws = new WebSocket(url);
    } catch (_e) {
      return resolve(out);
    }
    const t = setTimeout(fin, ms);
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'p1', filter]));
    ws.onmessage = (m) => {
      try {
        const a = JSON.parse(String(m.data));
        if (a[0] === 'EVENT') out.push(a[2]);
        if (a[0] === 'EOSE') {
          clearTimeout(t);
          fin();
        }
      } catch (_e) {}
    };
    ws.onerror = () => {
      clearTimeout(t);
      fin();
    };
  });
}
async function newestOnRelays(pk) {
  const per = await Promise.all(RELAYS.map((r) => queryRelay(r, { kinds: [0], authors: [pk] })));
  const all = per.flat();
  all.sort((a, b) => b.created_at - a.created_at);
  let meta = null;
  try {
    meta = all[0] ? JSON.parse(all[0].content) : null;
  } catch (_e) {}
  return { relaysWithEvent: per.filter((x) => x.length).length, meta };
}

async function newContext(browser) {
  return browser.newContext({ ...devices['Pixel 7'] });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const NAME1 = 'QA P1 ' + crypto.randomBytes(2).toString('hex');
  let stage = 'boot';
  try {
    const ctxA = await newContext(browser);
    const page = await ctxA.newPage();
    await page.goto(`${MAIN}/videos.html?qa=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => !!window.NostrApp?.openAuthPrompt && !!window.SosCryptoWorkerVault && !!window.NostrApp?.pool, null, { polling: 300, timeout: 120000 });

    const live = await page.evaluate(async () => {
      const v = await fetch('/app-version.json?t=' + Date.now()).then((r) => r.json());
      const f = await fetch('/runtime-feature-flags.json?t=' + Date.now()).then((r) => r.json());
      const ph = await fetch('/profile.html?t=' + Date.now()).then((r) => r.text());
      return {
        version: v.version,
        v2: f.accessControlV2 === true,
        scope: f.accessControlV2Scope,
        profilePageSigner: /sos-crypto-signer\.js/.test(ph) && /sos-crypto-worker-vault\.js/.test(ph) && /blossom\.js/.test(ph),
      };
    });
    set('LIVE_BUILD_899J', /^2026\.10\.01-web-899[jklmn]$/.test(live.version) && live.profilePageSigner, live);
    set('LIVE_FLAGS_V2_CONTROL_PLANE', live.v2 && live.scope === 'CONTROL_PLANE', { v2: live.v2, scope: live.scope });

    // ---- disposable Worker identity (same primitives as onboarding)
    stage = 'create';
    const created = await page.evaluate(async () => {
      const App = window.NostrApp;
      localStorage.setItem('SOS_CRYPTO_WORKER_AUTHORITATIVE', '1');
      window.SOS_CRYPTO_WORKER_AUTHORITATIVE = true;
      window.__SOS_CRYPTO_WORKER_AUTHORITATIVE__ = true;
      const c = await window.SosCryptoWorkerVault.createBrowserIdentity({ createNonce: 'c' + Date.now() + '-qa' });
      if (!c || !c.ok) return { ok: false };
      App.privateKey = null;
      App.publicKey = c.meta.pubkey;
      App.guestMode = false;
      App.identityState = 'IDENTITY_OK';
      const act = await window.SosCryptoWorkerVault.tryActivateAuthoritative();
      const ens = typeof App.ensureKeys === 'function' ? App.ensureKeys() : { ok: true };
      return { ok: !!(act && act.ok && ens && ens.ok), pk: String(App.publicKey).toLowerCase(), worker: App.SosCryptoSigner?.isWorkerAuthoritative?.() === true };
    });
    set('PROD_DISPOSABLE_IDENTITY', created.ok && created.worker, { ok: created.ok, worker: created.worker });
    const pk = created.pk;

    // ---- home: no floating group-management button
    const home = await page.evaluate(() => ({
      floating: !!document.getElementById('sosGroupAdminMenuEntry') || !!document.getElementById('sosAdminSettingsEntry'),
      blueText: Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'ניהול קבוצה' && b.offsetParent !== null),
    }));
    set('HOME_GROUP_MANAGEMENT_BUTTON_PRESENT_FALSE', !home.floating && !home.blueText, home);

    // ---- profile page: name + avatar through the UI
    stage = 'profile-page';
    await page.goto(`${MAIN}/profile.html?qa=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(
      (want) => {
        const App = window.NostrApp || {};
        return String(App.publicKey || '').toLowerCase() === want && !!App.pool && typeof App.SosCryptoSigner?.signProfileEvent === 'function' && typeof App.openProfileSettings === 'function' && typeof App.uploadToBlossom === 'function';
      },
      pk,
      { polling: 300, timeout: 90000 },
    );
    set('PROD_PROFILE_PAGE_SIGNER_READY', true);
    await page.evaluate(() => window.NostrApp.openProfileSettings());
    await page.fill('#profileNameInput', NAME1);
    await page.click('#profileSaveButton');
    await page.waitForFunction(() => window.NostrApp.lastProfilePublish && window.NostrApp.lastProfilePublish.ok !== undefined, null, { timeout: 30000 }).catch(() => {});
    const r1 = await page.evaluate(() => window.NostrApp.lastProfilePublish || null);
    set('PROFILE_WRITE_PUBLISHED', !!(r1 && r1.ok && r1.acks > 0), { ok: r1?.ok, acks: r1?.acks });

    stage = 'avatar';
    await page.evaluate(() => {
      window.NostrApp.lastProfilePublish = null;
    });
    await page.click('#profilePageAvatar');
    await page.waitForSelector('#profileAvatarDialogConfirm', { state: 'visible', timeout: 5000 });
    const chooserP = page.waitForEvent('filechooser', { timeout: 10000 });
    await page.click('#profileAvatarDialogConfirm');
    const chooser = await chooserP;
    await chooser.setFiles({ name: 'qa.png', mimeType: 'image/png', buffer: makePng(96, 96, crypto.randomInt(255)) });
    await page.waitForFunction(() => window.NostrApp.lastProfilePublish && window.NostrApp.lastProfilePublish.ok !== undefined, null, { timeout: 90000 }).catch(() => {});
    const r2 = await page.evaluate(() => ({ res: window.NostrApp.lastProfilePublish || null, picture: window.NostrApp.profile?.picture || '' }));
    const durable = /^https:\/\//.test(r2.picture);
    set('PROFILE_PICTURE_DURABLE_URL', !!(r2.res && r2.res.ok && r2.res.pictureDurable) && durable, { ok: r2.res?.ok, acks: r2.res?.acks, durable });

    stage = 'relay-readback';
    await sleep(3000);
    const rb = await newestOnRelays(pk);
    set('PROD_RELAY_READBACK_NEWEST', rb.meta?.name === NAME1 && /^https:\/\//.test(rb.meta?.picture || ''), { relaysWithEvent: rb.relaysWithEvent, name: rb.meta?.name === NAME1, pictureHttps: /^https:\/\//.test(rb.meta?.picture || '') });
    let pictureFetch = 0;
    try {
      pictureFetch = (await fetch(rb.meta?.picture || 'about:blank')).status;
    } catch (_e) {}
    set('PROD_PICTURE_URL_REACHABLE', pictureFetch === 200, { status: pictureFetch });

    stage = 'reload';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction((want) => String(window.NostrApp?.publicKey || '').toLowerCase() === want && !!window.NostrApp?.profile, pk, { polling: 300, timeout: 90000 });
    await sleep(4000);
    const after = await page.evaluate(() => ({ name: window.NostrApp.profile?.name, picture: window.NostrApp.profile?.picture || '' }));
    set('PROFILE_NAME_PERSISTENCE', after.name === NAME1, { same: after.name === NAME1 });
    set('PROFILE_AVATAR_PERSISTENCE', /^https:\/\//.test(after.picture) && after.picture === rb.meta?.picture, { https: /^https:\/\//.test(after.picture) });
    set('PROFILE_REFRESH_WITHOUT_RELOGIN', true);

    // ---- second fresh browser resolves the profile
    stage = 'cross-user';
    const ctxB = await newContext(browser);
    const pageB = await ctxB.newPage();
    await pageB.goto(`${MAIN}/videos.html?qa=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await pageB.waitForFunction(() => typeof window.NostrApp?.fetchProfile === 'function' && !!window.NostrApp?.pool && typeof window.NostrApp?.ensureChatContact === 'function', null, { polling: 300, timeout: 120000 });
    await sleep(3000);
    const cross = await pageB.evaluate(async (target) => {
      const p = await window.NostrApp.fetchProfile(target);
      return { name: p?.name, picture: p?.picture || '' };
    }, pk);
    set('CROSS_USER_PROFILE_RESOLUTION', cross.name === NAME1 && cross.picture === rb.meta?.picture, { name: cross.name === NAME1, picture: cross.picture === rb.meta?.picture });
    const conv = await pageB.evaluate(async (target) => {
      const App = window.NostrApp;
      App.ensureChatContact(target, { name: 'משתמש ' + target.slice(0, 8), picture: '', profileFetchedAt: Math.floor(Date.now() / 1000) });
      if (typeof App.bootstrapChatContacts === 'function') App.bootstrapChatContacts();
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        const c = App.chatState?.contacts?.get(target);
        if (c && !/^משתמש [0-9a-f]{8}$/.test(String(c.name || ''))) return { name: c.name };
        await new Promise((r) => setTimeout(r, 400));
      }
      return { name: App.chatState?.contacts?.get(target)?.name };
    }, pk);
    set('CONVERSATION_PROFILE_RESOLUTION', conv.name === NAME1, { same: conv.name === NAME1 });

    await ctxA.close();
    await ctxB.close();
  } catch (e) {
    set('PROD_CHECK_EXCEPTION', false, { stage, error: String((e && e.message) || e).replace(/nsec1[a-z0-9]+/gi, '[redacted]').replace(/[0-9a-f]{64}/gi, '<hex>').slice(0, 300) });
  } finally {
    try {
      await browser.close();
    } catch (_e) {}
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
