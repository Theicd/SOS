#!/usr/bin/env node
/**
 * Automatic history sync after a real QR link.
 * Seeds the phone through appendChatMessage, then links a desktop
 * without calling publishLinkedHistoryBundle.
 */
import { chromium, devices } from 'playwright';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { installCanvasCamera, linkAnotherDesktop, pollPage, waitApp, patchPoolPublishIterable } from './stage5-two-browser-qr-lab.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '.stage5-lab', 'history-' + Date.now().toString(36));
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

function hexPeer(i) {
  return crypto.createHash('sha256').update('hist-peer-' + i).digest('hex');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const report = { STATUS: 'RUNNING', AUTO_SYNC_TRIGGER: false, SOURCE_MESSAGE_COUNT: 0 };
  try {
    const pixel = devices['Pixel 7'];
    const phoneCtx = await browser.newContext({ ...pixel, locale: 'he-IL', serviceWorkers: 'block' });
    const phonePage = await phoneCtx.newPage();
    const blank = path.join(OUT, 'camera.png');
    fs.writeFileSync(blank, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    await installCanvasCamera(phonePage, blank);
    const phoneKey = crypto.randomBytes(32).toString('hex');
    await phonePage.goto('https://sos010.com/videos.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitApp(phonePage);
    await patchPoolPublishIterable(phonePage);
    const created = await phonePage.evaluate((k) => {
      const App = window.NostrApp;
      const c = App.createNewIdentityExplicit({ privateKeyHex: k });
      const SA = App.SessionAuthority || window.SosSessionAuthority;
      if (SA && typeof SA.bindCurrentSession === 'function') SA.bindCurrentSession({ accountPubkey: c.publicKey, bump: true });
      return { ok: !!(c && c.ok && c.publicKey), pub: String((c && c.publicKey) || '').toLowerCase() };
    }, phoneKey);
    await phonePage.waitForTimeout(1500);
    await phonePage.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitApp(phonePage);
    await patchPoolPublishIterable(phonePage);
    await phonePage.waitForFunction((fp) => {
      const App = window.NostrApp;
      return String(App && App.publicKey || '').toLowerCase().startsWith(fp) && App.guestMode !== true;
    }, created.pub.slice(0, 12), { timeout: 120000 });
    const phone = { page: phonePage, pub: created.pub, fp: created.pub.slice(0, 8) };
    const peers = [0, 1, 2, 3].map(hexPeer);
    const seeded = await phone.page.evaluate(async ({ peers, jpegB64, self }) => {
      const App = window.NostrApp;
      if (typeof App.restoreChatState === 'function') await App.restoreChatState();
      let n = 0;
      const logicals = [];
      for (let p = 0; p < peers.length; p += 1) {
        for (let i = 0; i < 20; i += 1) {
          const id = 'seed-' + p + '-' + i;
          const deleted = p === 0 && i === 3;
          App.appendChatMessage({
            id: id,
            logicalMessageId: id,
            from: i % 2 === 0 ? self : peers[p],
            to: i % 2 === 0 ? peers[p] : self,
            content: deleted ? 'gone-' + id : 'hello-' + id,
            direction: i % 2 === 0 ? 'outgoing' : 'incoming',
            createdAt: Math.floor(Date.now() / 1000) - (p * 20 + i),
            deleted: deleted,
            tombstone: deleted,
          });
          logicals.push(id);
          n += 1;
        }
      }
      for (let i = 0; i < 20; i += 1) {
        const id = 'self-' + i;
        App.appendChatMessage({
          id: id,
          logicalMessageId: id,
          from: self,
          to: self,
          content: 'self-' + i,
          direction: 'outgoing',
          createdAt: Math.floor(Date.now() / 1000) - 500 - i,
        });
        logicals.push(id);
        n += 1;
      }
      const fileId = 'hist-jpeg-' + Date.now();
      const bin = atob(jpegB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/jpeg' });
      if (typeof App.persistChatP2PMedia === 'function') await App.persistChatP2PMedia(fileId, blob, { name: 'note.jpg', type: 'image/jpeg' });
      const imageId = 'seed-image';
      App.appendChatMessage({
        id: imageId,
        logicalMessageId: imageId,
        from: self,
        to: peers[0],
        content: '',
        direction: 'outgoing',
        createdAt: Math.floor(Date.now() / 1000) - 10,
        attachment: { name: 'note.jpg', type: 'image/jpeg', fileId: fileId, cacheKey: 'p2p-file-' + fileId, size: bytes.length },
      });
      logicals.push(imageId);
      n += 1;
      let stored = 0;
      App.chatState.conversations.forEach((entry) => { stored += (entry.messages || []).length; });
      return { n: n, stored: stored, fileId: fileId, imageId: imageId, logicals: logicals };
    }, { peers: peers, jpegB64: JPEG.toString('base64'), self: phone.pub });
    report.SOURCE_MESSAGE_COUNT = seeded.stored;
    report.SOURCE_ATTACHMENT_COUNT = 1;
    report.SOURCE_CONVERSATION_COUNT = 5;
    if (seeded.stored < 100) throw new Error('SEED_SHORT ' + seeded.stored);
    const phoneLogs = [];
    phone.page.on('console', (msg) => {
      const t = msg.text();
      if (t.indexOf('PHONE_HISTORY') !== -1 || t.indexOf('HISTORY_') !== -1) phoneLogs.push(t.slice(0, 240));
    });
    phone.page.on('pageerror', (err) => phoneLogs.push('PAGEERROR ' + String(err && err.message || err).slice(0, 200)));
    await phone.page.evaluate(() => {
      const S = window.SosAccountSession;
      if (!S || S.__histWrap) return;
      const orig = S.acceptHistoryRequest;
      S.acceptHistoryRequest = async function (ev) {
        try {
          const r = await Promise.race([
            Promise.resolve(orig.call(S, ev)),
            new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: 'HUNG' }), 20000)),
          ]);
          const line = 'HISTORY_REQ_RESULT ok=' + !!(r && r.ok) + ' code=' + String((r && r.code) || '') + ' count=' + String(r && r.count) + ' pages=' + String(r && r.pages);
          console.log(line);
          window.__histReqResult = r;
          return r;
        } catch (err) {
          console.log('HISTORY_REQ_THROW ' + String(err && (err.message || err.code) || err).slice(0, 180));
          throw err;
        }
      };
      S.__histWrap = true;
    });
    console.log('STEP link desktop seeded=' + seeded.stored);
    const link = await linkAnotherDesktop(browser, phone.page, phone.fp, { keep: true });
    report.LINK = { ok: !!(link && link.ok), code: link && link.code ? String(link.code).slice(0, 200) : '' };
    if (!link || link.ok !== true || !link.page) throw new Error('LINK_' + String((link && link.code) || 'NO_PAGE'));
    const desktopPage = link.page;
    const logs = [];
    desktopPage.on('console', (msg) => {
      const t = msg.text();
      if (t.indexOf('DESKTOP_HISTORY') !== -1 || t.indexOf('HISTORY_') !== -1) logs.push(t.slice(0, 180));
    });
    const seen = await pollPage(desktopPage, async () => {
      const sync = window.__sosLdHistorySync;
      const App = window.NostrApp;
      let stored = 0;
      const ids = {};
      if (App && App.chatState && App.chatState.conversations) {
        App.chatState.conversations.forEach((entry) => {
          (entry.messages || []).forEach((m) => {
            stored += 1;
            if (m && m.logicalMessageId) ids[m.logicalMessageId] = true;
          });
        });
      }
      return {
        ok: !!(sync && sync.HISTORY_TEXT_SYNC_COMPLETE === true && stored >= 100),
        stored: stored,
        sync: sync || null,
      };
    }, null, 120000);
    const detail = await desktopPage.evaluate(async (imageId) => {
      const App = window.NostrApp;
      const sync = window.__sosLdHistorySync || null;
      let stored = 0;
      let deleted = 0;
      let image = null;
      const peers = {};
      if (App.chatState && App.chatState.conversations) {
        App.chatState.conversations.forEach((entry) => {
          peers[entry.peer] = (entry.messages || []).length;
          (entry.messages || []).forEach((m) => {
            stored += 1;
            if (m && (m.deleted === true || m.tombstone === true)) deleted += 1;
            if (m && m.logicalMessageId === imageId) image = m.attachment || null;
          });
        });
      }
      let hash = '';
      if (image && image.fileId && typeof App.loadChatP2PMediaBlob === 'function') {
        const blob = await App.loadChatP2PMediaBlob('p2p-file-' + image.fileId);
        if (blob) {
          const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
          hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
        }
      }
      const session = window.SosAccountSession && window.SosAccountSession.getAccountSession ? window.SosAccountSession.getAccountSession() : null;
      return {
        stored: stored,
        deleted: deleted,
        peers: Object.keys(peers).length,
        hash: hash,
        sync: sync,
        root: !!(session && session.ROOT_K_PRESENT),
        role: session && session.role,
      };
    }, seeded.imageId);
    report.AUTO_SYNC_TRIGGER = logs.some((l) => l.indexOf('DESKTOP_HISTORY_SYNC_REQUEST') !== -1) || phoneLogs.some((l) => l.indexOf('PHONE_HISTORY_REQUEST_RECEIVED') !== -1);
    report.PHONE_LOGS = phoneLogs.slice(-8);
    report.DESKTOP_LOGS = logs.slice(-8);
    report.SEEN = seen;
    report.DETAIL = detail;
    report.DESTINATION_MESSAGE_COUNT = detail.stored;
    report.MEDIA_HASH = detail.hash;
    report.ROOT_K_ON_DESKTOP = detail.root === true;
    report.TEXT_SYNC_COMPLETE = !!(detail.sync && detail.sync.HISTORY_TEXT_SYNC_COMPLETE === true && detail.stored >= 100);
    await desktopPage.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitApp(desktopPage);
    const reloaded = await pollPage(desktopPage, async (imageId) => {
      const App = window.NostrApp;
      if (typeof App.restoreChatState === 'function') {
        try { await App.restoreChatState(); } catch (_e) {}
      }
      let stored = 0;
      let deleted = 0;
      let image = null;
      if (App && App.chatState && App.chatState.conversations) {
        App.chatState.conversations.forEach((entry) => {
          (entry.messages || []).forEach((m) => {
            stored += 1;
            if (m && (m.deleted === true || m.tombstone === true)) deleted += 1;
            if (m && m.logicalMessageId === imageId) image = m.attachment || null;
          });
        });
      }
      let hash = '';
      if (image && image.fileId && typeof App.loadChatP2PMediaBlob === 'function') {
        const blob = await App.loadChatP2PMediaBlob('p2p-file-' + image.fileId);
        if (blob) {
          const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
          hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
        }
      }
      const session = window.SosAccountSession && window.SosAccountSession.getAccountSession ? window.SosAccountSession.getAccountSession() : null;
      return {
        ok: stored >= 100 && deleted >= 1 && hash.length === 64 && !(session && session.ROOT_K_PRESENT),
        stored: stored,
        deleted: deleted,
        hash: hash,
        root: !!(session && session.ROOT_K_PRESENT),
      };
    }, seeded.imageId, 45000);
    report.RELOAD = reloaded;
    report.RELOAD_PERSISTENCE = reloaded && reloaded.ok === true;
    report.STATUS = report.TEXT_SYNC_COMPLETE && detail.hash && detail.root !== true && report.RELOAD_PERSISTENCE ? 'PASS_INITIAL_HISTORY_LAB' : 'FAIL';
  } catch (err) {
    report.STATUS = 'FAIL';
    report.ERROR = String(err && err.message || err).slice(0, 300);
  } finally {
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log('EVIDENCE=' + path.join(OUT, 'result.json'));
    await browser.close().catch(() => {});
  }
  process.exit(report.STATUS === 'PASS_INITIAL_HISTORY_LAB' ? 0 : 1);
}

main();
