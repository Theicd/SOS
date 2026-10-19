#!/usr/bin/env node
/**
 * Two independent browsers on production.
 * Primary phone and its linked desktop. No root key on the desktop.
 * Proves the data-channel handshake and a real JPEG both ways.
 */
import { chromium, devices } from 'playwright';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  installCanvasCamera,
  linkAnotherDesktop,
  waitApp,
  patchPoolPublishIterable,
  pollPage,
} from './stage5-two-browser-qr-lab.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', '.stage5-lab', 'self-p2p-' + Date.now().toString(36));
const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '').slice(7) || 'https://sos010.com/videos.html';
const PIXEL = devices['Pixel 7'];
const QUEUED_ID = '1792406381486-r06dblsp5j';

const report = {
  STATUS: 'RUNNING',
  BASE,
  FIRST_FAILED_TRANSITION: '',
  PHONE_ENDPOINT: '',
  DESKTOP_ENDPOINT: '',
  PHONE_ROLE: '',
  DESKTOP_ROLE: '',
  SIGNAL_RELAY_ACCEPTED: false,
  SIGNAL_DESKTOP_RECEIVED: false,
  SIGNAL_TARGET_VERIFIED: false,
  SIGNAL_MD3_AUTHORIZED: false,
  SIGNAL_DECRYPTED: false,
  DC_NEED_OFFER_RECEIVED: false,
  DC_OFFER_SENT: false,
  DC_OFFER_RECEIVED: false,
  DC_ANSWER_RECEIVED: false,
  ICE_CONNECTED: false,
  DATA_CHANNEL_OPEN: false,
  JPEG_BYTES_SENT: 0,
  JPEG_BYTES_RECEIVED: 0,
  SHA256_MATCH: false,
  RECIPIENT_PERSISTED: false,
  RELOAD_PERSISTENCE: false,
  REVERSE_SHA256_MATCH: false,
  BLOSSOM_FILE_UPLOAD_COUNT: 0,
  RELAY_FILE_BYTES_UPLOAD_COUNT: 0,
  QUEUED_FILE_RETRY: '',
  logs: { phone: [], desktop: [] },
};

function note(step) {
  if (!report.FIRST_FAILED_TRANSITION) report.FIRST_FAILED_TRANSITION = step;
  report.STATUS = 'PARTIAL';
}

function watch(page, bucket) {
  page.on('console', (msg) => {
    const text = msg.text();
    if (!/\[P2P-SIG\]|\[DC\]|\[BLOSSOM\]|\[CHAT\/SELF\]|\[CHAT\/P2P\]|ICE_CONNECTED|DATA_CHANNEL/.test(text)) return;
    if (/sdp|priv|nsec|BEGIN /i.test(text)) return;
    bucket.push(text.slice(0, 220));
    if (bucket.length > 400) bucket.shift();
  });
}

async function loginPrimary(browser) {
  const ctx = await browser.newContext({ ...PIXEL, locale: 'he-IL', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const png = path.join(OUT, 'blank.png');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  await installCanvasCamera(page, png);
  const sk = crypto.randomBytes(32).toString('hex');
  await page.goto(BASE + (BASE.includes('?') ? '&' : '?') + 'selfp2p=' + Date.now().toString(36), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitApp(page);
  await patchPoolPublishIterable(page);
  const created = await page.evaluate((k) => {
    const App = window.NostrApp;
    const c = App.createNewIdentityExplicit({ privateKeyHex: k });
    const SA = App.SessionAuthority || window.SosSessionAuthority;
    if (SA && typeof SA.bindCurrentSession === 'function') SA.bindCurrentSession({ accountPubkey: c.publicKey, bump: true });
    return { ok: !!(c && c.ok && c.publicKey), pub: String((c && c.publicKey) || '').toLowerCase() };
  }, sk);
  if (!created.ok) throw new Error('LOGIN');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitApp(page);
  await patchPoolPublishIterable(page);
  await page.waitForFunction((fp) => {
    const App = window.NostrApp;
    return String(App && App.publicKey || '').toLowerCase().startsWith(fp) && App.guestMode !== true;
  }, created.pub.slice(0, 12), { timeout: 120000 });
  return { ctx, page, pub: created.pub };
}

async function arm(page) {
  await page.evaluate(() => {
    const App = window.NostrApp;
    App.__qaBlossom = 0;
    App.__qaRelayLarge = 0;
    const origFetch = window.fetch;
    window.fetch = function (url, opts) {
      const method = String((opts && opts.method) || 'GET').toUpperCase();
      if (/blossom/i.test(String(url || '')) && method !== 'GET' && method !== 'HEAD') App.__qaBlossom += 1;
      return origFetch.apply(this, arguments);
    };
    if (App.pool && typeof App.pool.publish === 'function' && !App.pool.__qaWrapped) {
      const orig = App.pool.publish.bind(App.pool);
      App.pool.publish = function (urls, event) {
        const len = event && event.content ? String(event.content).length : 0;
        if (event && event.kind !== 25055 && len > 8000) App.__qaRelayLarge += 1;
        return orig(urls, event);
      };
      App.pool.__qaWrapped = true;
    }
    if (App.dataChannel && typeof App.dataChannel.init === 'function') App.dataChannel.init();
    if (App.dataChannel && typeof App.dataChannel.ensureSignalSubscription === 'function') App.dataChannel.ensureSignalSubscription();
  });
}

async function identity(page) {
  return page.evaluate(() => {
    const App = window.NostrApp;
    const session = typeof App.getAccountSession === 'function' ? App.getAccountSession() : null;
    const account = String((session && session.accountP) || App.publicKey || '').toLowerCase();
    const device = String((session && session.deviceSignPub) || '').toLowerCase();
    const local = session && session.role === 'LINKED_DEVICE' && device && device !== account ? device : account;
    return {
      role: session && session.role,
      account,
      device,
      local,
      root: App.privateKey != null,
      identityKey: !!(App.SosCryptoSigner && App.SosCryptoSigner.hasIdentityKey && App.SosCryptoSigner.hasIdentityKey()),
    };
  });
}

async function sendJpeg(page) {
  return page.evaluate(async () => {
    const App = window.NostrApp;
    const canvas = document.createElement('canvas');
    canvas.width = 1400;
    canvas.height = 900;
    const g = canvas.getContext('2d');
    g.fillStyle = '#123';
    g.fillRect(0, 0, 1400, 900);
    for (let i = 0; i < 120; i += 1) {
      g.fillStyle = 'rgb(' + ((i * 17) % 255) + ',' + ((i * 29) % 255) + ',' + ((i * 13) % 255) + ')';
      g.fillRect((i * 11) % 1300, (i * 7) % 800, 36, 28);
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    const raw = new Uint8Array(await blob.arrayBuffer());
    const hash = typeof App.hashMediaCiphertext === 'function' ? await App.hashMediaCiphertext(raw) : '';
    const file = new File([blob], 'self-photo.jpg', { type: 'image/jpeg' });
    const id = await App.sendP2PFile(App.publicKey, file, () => {});
    return { id: String(id || ''), hash, size: raw.length, queued: id === 'LOCAL_QUEUED' };
  });
}

async function waitHash(page, hash, timeoutMs) {
  return pollPage(page, async (expected) => {
    const App = window.NostrApp;
    const conv = App.chatState && App.chatState.conversations;
    const jobs = [];
    if (conv && typeof conv.forEach === 'function') {
      conv.forEach((entry) => {
        (entry.messages || []).forEach((m) => { if (m && m.attachment) jobs.push(m); });
      });
    }
    for (let i = 0; i < jobs.length; i += 1) {
      const att = jobs[i].attachment;
      try {
        let bytes = null;
        if (typeof att.url === 'string' && att.url.indexOf('blob:') === 0) {
          const res = await fetch(att.url);
          bytes = new Uint8Array(await res.arrayBuffer());
        } else if (att.cacheKey && typeof App.getChatMediaFromCache === 'function') {
          const blob = await App.getChatMediaFromCache(att.cacheKey);
          if (blob) bytes = new Uint8Array(await blob.arrayBuffer());
        } else if (att.fileId && typeof App.getChatMediaFromCache === 'function' && typeof App.chatP2PCacheKey === 'function') {
          const blob = await App.getChatMediaFromCache(App.chatP2PCacheKey(att.fileId));
          if (blob) bytes = new Uint8Array(await blob.arrayBuffer());
        }
        if (!bytes || typeof App.hashMediaCiphertext !== 'function') continue;
        const got = await App.hashMediaCiphertext(bytes);
        if (got === expected) return { ok: true, size: bytes.length, logical: String(jobs[i].logicalMessageId || '') };
      } catch (_e) {}
    }
    return { ok: false, n: jobs.length };
  }, hash, timeoutMs);
}

function stages(lines) {
  const text = lines.join('\n');
  return {
    accepted: text.includes('SIG_RELAY_ACCEPTED'),
    observed: text.includes('SIG_EVENT_OBSERVED'),
    target: text.includes('SIG_TARGET_MATCH'),
    md3: /SIG_AUTHOR_AUTHORIZED[^\n]*md3=true/.test(text),
    decrypted: text.includes('SIG_DECRYPTED'),
    need: text.includes('DC_NEED_OFFER_RX'),
    offerSent: text.includes('DC_OFFER_SENT'),
    offerRx: text.includes('DC_OFFER_RX'),
    answerRx: text.includes('DC_ANSWER_RX'),
    answerSent: text.includes('DC_ANSWER_SENT'),
    ice: text.includes('ICE_CONNECTED'),
    open: text.includes('DATA_CHANNEL_OPEN'),
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  let phone;
  let desk;
  try {
    phone = await loginPrimary(browser);
    watch(phone.page, report.logs.phone);
    const pkg = await phone.page.evaluate(() => {
      const src = [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src') || '');
      return {
        session: src.find((s) => s.indexOf('sos-account-session.js') !== -1) || '',
        dc: src.find((s) => s.indexOf('chat-p2p-datachannel.js') !== -1) || '',
        file: src.find((s) => s.indexOf('chat-p2p-file.js') !== -1) || '',
      };
    });
    report.LIVE_BUILD = pkg;
    if (pkg.session.indexOf('pkg=899s45') === -1 || pkg.dc.indexOf('pkg=899s45') === -1 || pkg.file.indexOf('pkg=899s45') === -1) {
      note('CDN_STALE');
      throw new Error('CDN_STALE');
    }
    let link = await linkAnotherDesktop(browser, phone.page, phone.pub.slice(0, 8), { keep: true });
    if (!link.ok || !link.page) link = await linkAnotherDesktop(browser, phone.page, phone.pub.slice(0, 8), { keep: true });
    if (!link.ok || !link.page) {
      note('LINK');
      throw new Error(link.code || 'LINK');
    }
    desk = link;
    watch(desk.page, report.logs.desktop);
    await arm(phone.page);
    await arm(desk.page);
    const phoneId = await identity(phone.page);
    const deskId = await identity(desk.page);
    report.PHONE_ENDPOINT = phoneId.local;
    report.DESKTOP_ENDPOINT = deskId.local;
    report.ROOT_ON_DESKTOP = deskId.root === true || deskId.identityKey === true;
    if (report.ROOT_ON_DESKTOP || deskId.role !== 'LINKED_DEVICE' || deskId.local === phoneId.local) {
      note('ENDPOINT_IDENTITY');
      throw new Error('ENDPOINT_IDENTITY');
    }
    const roles = await phone.page.evaluate((desktop) => {
      const App = window.NostrApp;
      return App.dataChannel && App.dataChannel.amInitiator(desktop);
    }, deskId.local);
    const deskRole = await desk.page.evaluate((phoneKey) => {
      const App = window.NostrApp;
      return App.dataChannel && App.dataChannel.amInitiator(phoneKey);
    }, phoneId.local);
    report.PHONE_ROLE = roles ? 'initiator' : 'responder';
    report.DESKTOP_ROLE = deskRole ? 'initiator' : 'responder';
    if (report.PHONE_ROLE === report.DESKTOP_ROLE) note('ROLE_CONFLICT');
    const queued = await phone.page.evaluate((id) => {
      const App = window.NostrApp;
      const conv = App.chatState && App.chatState.conversations;
      let found = false;
      if (conv && typeof conv.forEach === 'function') {
        conv.forEach((entry) => {
          (entry.messages || []).forEach((m) => {
            if (m && (m.id === id || m.logicalMessageId === id || (m.attachment && m.attachment.fileId === id))) found = true;
          });
        });
      }
      return found ? 'BYTES_PRESENT' : 'FILE_BYTES_UNAVAILABLE';
    }, QUEUED_ID);
    report.QUEUED_FILE_RETRY = queued;

    const sent = await sendJpeg(phone.page);
    report.JPEG_BYTES_SENT = sent.size;
    report.PHONE_FILE_ID = sent.id;
    const got = await waitHash(desk.page, sent.hash, 70000);
    const phoneStages = stages(report.logs.phone);
    const deskStages = stages(report.logs.desktop);
    report.SIGNAL_RELAY_ACCEPTED = phoneStages.accepted || deskStages.accepted;
    report.SIGNAL_DESKTOP_RECEIVED = deskStages.observed;
    report.SIGNAL_TARGET_VERIFIED = deskStages.target;
    report.SIGNAL_MD3_AUTHORIZED = deskStages.md3 || phoneStages.md3;
    report.SIGNAL_DECRYPTED = deskStages.decrypted;
    report.DC_NEED_OFFER_RECEIVED = deskStages.need;
    report.DC_OFFER_SENT = deskStages.offerSent || phoneStages.offerSent;
    report.DC_OFFER_RECEIVED = phoneStages.offerRx || deskStages.offerRx;
    report.DC_ANSWER_RECEIVED = deskStages.answerRx || phoneStages.answerRx;
    report.ICE_CONNECTED = phoneStages.ice || deskStages.ice;
    report.DATA_CHANNEL_OPEN = phoneStages.open && deskStages.open;
    report.SHA256_MATCH = got.ok === true;
    report.JPEG_BYTES_RECEIVED = got.ok ? got.size : 0;
    report.RECIPIENT_PERSISTED = got.ok === true;
    if (!report.DATA_CHANNEL_OPEN) note(report.DC_NEED_OFFER_RECEIVED ? 'DC_OFFER' : 'DC_NEED_OFFER_RX');
    else if (!report.SHA256_MATCH) note('JPEG_HASH');

    if (got.ok) {
      await desk.page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
      await waitApp(desk.page);
      const reloaded = await waitHash(desk.page, sent.hash, 20000);
      report.RELOAD_PERSISTENCE = reloaded.ok === true;
      if (!reloaded.ok) note('RELOAD_PERSISTENCE');
    }

    const back = await sendJpeg(desk.page);
    const backGot = await waitHash(phone.page, back.hash, 70000);
    report.REVERSE_SHA256_MATCH = backGot.ok === true;
    report.REVERSE_BYTES = back.size;
    if (got.ok && !backGot.ok) note('REVERSE_JPEG');

    const counts = await Promise.all([phone.page, desk.page].map((page) => page.evaluate(() => ({
      blossom: window.NostrApp.__qaBlossom || 0,
      relay: window.NostrApp.__qaRelayLarge || 0,
    })).catch(() => ({ blossom: 0, relay: 0 }))));
    report.BLOSSOM_FILE_UPLOAD_COUNT = counts.reduce((n, row) => n + row.blossom, 0);
    report.RELAY_FILE_BYTES_UPLOAD_COUNT = counts.reduce((n, row) => n + row.relay, 0);
    if (report.BLOSSOM_FILE_UPLOAD_COUNT > 0) note('BLOSSOM_UPLOAD');
    if (report.RELAY_FILE_BYTES_UPLOAD_COUNT > 0) note('RELAY_FILE_BYTES');
    if (
      report.DATA_CHANNEL_OPEN &&
      report.SHA256_MATCH &&
      report.REVERSE_SHA256_MATCH &&
      report.RELOAD_PERSISTENCE &&
      report.RECIPIENT_PERSISTED &&
      report.BLOSSOM_FILE_UPLOAD_COUNT === 0 &&
      report.RELAY_FILE_BYTES_UPLOAD_COUNT === 0 &&
      report.PHONE_ROLE !== report.DESKTOP_ROLE &&
      report.ROOT_ON_DESKTOP !== true
    ) {
      report.STATUS = 'PASS_DIRECT_SELF_P2P';
      report.FIRST_FAILED_TRANSITION = '';
    } else if (report.STATUS === 'RUNNING') {
      report.STATUS = 'PARTIAL';
    }
  } catch (err) {
    if (report.STATUS === 'RUNNING') report.STATUS = 'PARTIAL';
    if (!report.FIRST_FAILED_TRANSITION) report.FIRST_FAILED_TRANSITION = String(err && err.message || err).slice(0, 180);
  } finally {
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      STATUS: report.STATUS,
      FIRST_FAILED_TRANSITION: report.FIRST_FAILED_TRANSITION,
      PHONE_ENDPOINT: String(report.PHONE_ENDPOINT).slice(0, 8),
      DESKTOP_ENDPOINT: String(report.DESKTOP_ENDPOINT).slice(0, 8),
      PHONE_ROLE: report.PHONE_ROLE,
      DESKTOP_ROLE: report.DESKTOP_ROLE,
      DATA_CHANNEL_OPEN: report.DATA_CHANNEL_OPEN,
      SHA256_MATCH: report.SHA256_MATCH,
      REVERSE_SHA256_MATCH: report.REVERSE_SHA256_MATCH,
      RELOAD_PERSISTENCE: report.RELOAD_PERSISTENCE,
      BLOSSOM_FILE_UPLOAD_COUNT: report.BLOSSOM_FILE_UPLOAD_COUNT,
      RELAY_FILE_BYTES_UPLOAD_COUNT: report.RELAY_FILE_BYTES_UPLOAD_COUNT,
      QUEUED_FILE_RETRY: report.QUEUED_FILE_RETRY,
      OUT,
    }, null, 2));
    await browser.close().catch(() => {});
  }
  if (report.STATUS !== 'PASS_DIRECT_SELF_P2P') process.exit(1);
}

main();
