#!/usr/bin/env node
/**
 * Four isolated browsers on production.
 * Two disposable accounts, each with a primary and a linked desktop.
 * Real QR / MD3. No Root K on the desktops. No owner keys.
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
  waitDecryptedHash,
  collectBuildMeta,
} from './stage5-two-browser-qr-lab.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', '.stage5-lab', 'four-device-' + Date.now().toString(36));
const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '').slice(7) || 'https://sos010.com/videos.html';
const PIXEL = devices['Pixel 7'];

const report = {
  STATUS: 'RUNNING',
  BASE,
  FIRST_FAILED_TRANSITION: '',
  LIVE_VERSION: '',
  TEXT_A2_TO_B1: 'NOT_RUN',
  TEXT_A2_TO_B2: 'NOT_RUN',
  TEXT_OUTGOING_A1: 'NOT_RUN',
  TEXT_OUTGOING_A2: 'NOT_RUN',
  VOICE_A2_TO_B1: 'NOT_RUN',
  VOICE_A2_TO_B2: 'NOT_RUN',
  VOICE_OUTGOING_SIBLING_SYNC: 'NOT_RUN',
  VOICE_BYTES_VERIFIED: 'NOT_RUN',
  TEXT_B2_TO_A1: 'NOT_RUN',
  TEXT_B2_TO_A2: 'NOT_RUN',
  TEXT_B2_OUTGOING_B1: 'NOT_RUN',
  TEXT_B2_OUTGOING_B2: 'NOT_RUN',
  VOICE_B2_TO_A1: 'NOT_RUN',
  VOICE_B2_TO_A2: 'NOT_RUN',
  VOICE_B2_OUTGOING_B1: 'NOT_RUN',
  TEXT_A1_TO_B1: 'NOT_RUN',
  TEXT_A1_TO_B2: 'NOT_RUN',
  TEXT_A1_OUTGOING_A2: 'NOT_RUN',
  RECIPIENT_PHONE_OFFLINE_DESKTOP_DELIVERY: 'NOT_RUN',
  SENDER_PHONE_OFFLINE_DESKTOP_SEND: 'NOT_RUN',
  TRUE_SELF_CHAT: 'NOT_RUN',
  RELOAD: 'NOT_RUN',
  DEVICE_DIRECTORY_VALID: 'NOT_RUN',
  MD3_VERIFIED: 'NOT_RUN',
  DEVICE_ENCRYPTION_VALID: 'NOT_RUN',
  LOGICAL_ID_MATCH: 'NOT_RUN',
  DUPLICATE_MESSAGES: 'NOT_RUN',
  FALSE_SELF_MESSAGES: 'NOT_RUN',
  DATA_LOSS: 'NOT_RUN',
  SECURITY: {},
};

function fail(step, detail) {
  if (!report.FIRST_FAILED_TRANSITION) report.FIRST_FAILED_TRANSITION = step + (detail ? ' ' + String(detail).slice(0, 180) : '');
  report.STATUS = 'FAIL';
  throw new Error(step + (detail ? ' ' + detail : ''));
}

function prefix(pub) {
  return String(pub || '').toLowerCase().slice(0, 8);
}

async function loginPrimary(browser, label) {
  const ctx = await browser.newContext({
    ...PIXEL,
    locale: 'he-IL',
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const png = path.join(OUT, label + '-blank.png');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  await installCanvasCamera(page, png);
  const sk = crypto.randomBytes(32).toString('hex');
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitApp(page);
  await patchPoolPublishIterable(page);
  const created = await page.evaluate((k) => {
    const App = window.NostrApp;
    const c = App.createNewIdentityExplicit({ privateKeyHex: k });
    const SA = App.SessionAuthority || window.SosSessionAuthority;
    if (SA && typeof SA.bindCurrentSession === 'function') SA.bindCurrentSession({ accountPubkey: c.publicKey, bump: true });
    return { ok: !!(c && c.ok && c.publicKey), pub: String((c && c.publicKey) || '').toLowerCase() };
  }, sk);
  if (!created.ok) fail(label + '_LOGIN');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitApp(page);
  await patchPoolPublishIterable(page);
  await page.waitForFunction((fp) => {
    const App = window.NostrApp;
    return String(App && App.publicKey || '').toLowerCase().startsWith(fp) && App.guestMode !== true;
  }, created.pub.slice(0, 12), { timeout: 120000 });
  return { ctx, page, pub: created.pub };
}

async function sendText(page, peer, text) {
  return page.evaluate(async ({ peer, text }) => {
    const App = window.NostrApp;
    if (typeof App.ensureSecureChatEpochReady === 'function') await App.ensureSecureChatEpochReady({ skipAutoReload: true });
    if (typeof App.subscribeToChatEvents === 'function') App.subscribeToChatEvents();
    const out = await App.publishChatMessage(peer, text);
    return {
      ok: !!(out && out.ok),
      delegated: out && out.delegated === true,
      copies: out && typeof out.deviceCopies === 'number' ? out.deviceCopies : null,
      error: out && out.error ? String(out.error) : '',
      rootPresent: App.privateKey != null,
    };
  }, { peer, text });
}

async function expectChat(page, text, dir, peerPub) {
  const peer8 = prefix(peerPub);
  return pollPage(page, async (args) => {
    const App = window.NostrApp;
    const Session = window.SosAccountSession;
    if (typeof App.ensureSecureChatEpochReady === 'function') {
      try { await App.ensureSecureChatEpochReady({ skipAutoReload: true }); } catch (_e) {}
    }
    if (Session && typeof Session.pullLinkedDirectMessages === 'function') {
      try { await Session.pullLinkedDirectMessages(); } catch (_e) {}
    }
    if (typeof App.subscribeToChatEvents === 'function') {
      try { App.subscribeToChatEvents(); } catch (_e) {}
    }
    if (typeof App.pullRecentAccountChat === 'function') {
      try { await App.pullRecentAccountChat(); } catch (_e) {}
    }
    const self = String(App.publicKey || '').toLowerCase();
    const conv = App.chatState && App.chatState.conversations;
    const external = [];
    let selfHits = 0;
    if (conv && typeof conv.forEach === 'function') {
      conv.forEach((entry) => {
        const messages = entry && entry.messages;
        if (!Array.isArray(messages)) return;
        const selfThread = String(entry.peer || '').toLowerCase() === self;
        messages.forEach((m) => {
          if (!m || m.content !== args.text) return;
          if (selfThread) selfHits += 1;
          else {
            external.push({
              dir: m.direction || '',
              peer: String(entry.peer || '').toLowerCase().slice(0, 8),
              logical: String(m.logicalMessageId || ''),
              route: String(m.routeKind || ''),
            });
          }
        });
      });
    }
    const hit = external[0] || null;
    return {
      ok: external.length === 1 && selfHits === 0 && hit && hit.dir === args.dir && hit.peer === args.peer8,
      pulled: 0,
      n: external.length,
      selfHits,
      dir: hit ? hit.dir : '',
      peer: hit ? hit.peer : '',
      logical: hit ? hit.logical : '',
      route: hit ? hit.route : '',
    };
  }, { text, dir, peer8 }, 50000);
}

async function directoryHas(page, account) {
  return page.evaluate(async (account) => {
    const Session = window.SosAccountSession;
    if (!Session || typeof Session.listAuthorizedDevices !== 'function') return { ok: false, n: 0 };
    const rows = await Session.listAuthorizedDevices(account, 'DEVICE_CHAT');
    const list = Array.isArray(rows) ? rows : [];
    return {
      ok: list.length > 0,
      n: list.length,
      sign: list.map((row) => String(row.deviceSignPub || '').slice(0, 8)),
      encSame: list.some((row) => row.deviceSignPub && row.deviceEncPub && String(row.deviceSignPub) === String(row.deviceEncPub)),
    };
  }, account);
}

async function sendVoice(page, peer) {
  return page.evaluate(async (account) => {
    const App = window.NostrApp;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => { rec.onstop = () => resolve(true); });
    rec.start();
    await new Promise((r) => setTimeout(r, 700));
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    const raw = new Uint8Array(await blob.arrayBuffer());
    const hash = await App.hashMediaCiphertext(raw);
    const descriptor = await App.uploadMediaForServerFallback(blob, {
      sender: App.publicKey,
      recipient: account,
      mimeType: blob.type || 'audio/webm',
      fileName: 'voice-message.webm',
      duration: 1,
      requireEncryption: true,
    });
    if (!descriptor || descriptor.type !== 'encrypted-media') return { ok: false, hash, error: 'VOICE_NOT_ENCRYPTED' };
    if (typeof App.setChatFileAttachment === 'function') App.setChatFileAttachment(account, descriptor);
    const sent = await App.publishChatMessage(account, '', { clientTempId: descriptor.clientMessageId || descriptor.logicalMessageId });
    const ctx = App.mediaAuthContext ? App.mediaAuthContext(descriptor, { from: App.publicKey, to: account }) : null;
    const local = ctx ? await App.resolveServerMediaAttachment(descriptor, ctx) : null;
    const localHash = local && local.blob ? await App.hashMediaCiphertext(new Uint8Array(await local.blob.arrayBuffer())) : '';
    return {
      ok: !!(sent && sent.ok) && localHash === hash,
      hash,
      localHash,
      copies: sent && sent.deviceCopies,
      logical: descriptor.logicalMessageId || descriptor.clientMessageId || '',
      error: sent && sent.error ? String(sent.error) : '',
    };
  }, peer);
}

async function waitPlainHash(page, expectedHash, timeoutMs) {
  return pollPage(page, async (hash) => {
    const App = window.NostrApp;
    const Session = window.SosAccountSession;
    if (Session && typeof Session.pullLinkedDirectMessages === 'function') {
      try { await Session.pullLinkedDirectMessages(); } catch (_e) {}
    }
    if (typeof App.pullRecentAccountChat === 'function') {
      try { await App.pullRecentAccountChat(); } catch (_e) {}
    }
    const conv = App.chatState && App.chatState.conversations;
    if (!conv || typeof conv.forEach !== 'function') return { ok: false, n: 0 };
    const jobs = [];
    conv.forEach((entry) => {
      (entry.messages || []).forEach((m) => { if (m && m.attachment) jobs.push(m); });
    });
    for (let i = 0; i < jobs.length; i += 1) {
      const att = jobs[i].attachment;
      try {
        let bytes = null;
        if (att.type === 'encrypted-media' && typeof App.resolveServerMediaAttachment === 'function') {
          const ctx = typeof App.mediaAuthContext === 'function' ? App.mediaAuthContext(att, jobs[i]) : {};
          const resolved = await App.resolveServerMediaAttachment(att, ctx);
          if (resolved && resolved.blob) bytes = new Uint8Array(await resolved.blob.arrayBuffer());
        } else if (typeof att.url === 'string' && att.url.indexOf('blob:') === 0) {
          const res = await fetch(att.url);
          bytes = new Uint8Array(await res.arrayBuffer());
        }
        if (!bytes || typeof App.hashMediaCiphertext !== 'function') continue;
        const got = await App.hashMediaCiphertext(bytes);
        if (got === hash) return { ok: true, transport: String(jobs[i].transport || ''), logical: String(jobs[i].logicalMessageId || '') };
      } catch (_e) {}
    }
    return { ok: false, n: jobs.length };
  }, expectedHash, timeoutMs);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  let a1;
  let b1;
  let a2;
  let b2;
  try {
    console.log('STEP login A1');
    try { a1 = await loginPrimary(browser, 'A1'); } catch (err) {
      console.log('RETRY login A1');
      a1 = await loginPrimary(browser, 'A1b');
    }
    const build = await collectBuildMeta(a1.page);
    report.LIVE_VERSION = JSON.stringify(build).slice(0, 300);
    const pkg = await a1.page.evaluate(() => {
      const src = [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src') || '');
      return {
        chat: (src.find((s) => s.indexOf('chat-service.js') !== -1) || ''),
        session: (src.find((s) => s.indexOf('sos-account-session.js') !== -1) || ''),
        dc: (src.find((s) => s.indexOf('chat-p2p-datachannel.js') !== -1) || ''),
        file: (src.find((s) => s.indexOf('chat-p2p-file.js') !== -1) || ''),
        p2p: (src.find((s) => s.indexOf('p2p-video-sharing.js') !== -1) || ''),
      };
    });
    if (pkg.chat.indexOf('pkg=899s49') === -1 || pkg.session.indexOf('pkg=899s50') === -1 || pkg.dc.indexOf('pkg=899s45') === -1 || pkg.file.indexOf('pkg=899s48') === -1 || pkg.p2p.indexOf('pkg=899s47') === -1) {
      fail('CDN_STALE', pkg.chat + ' ' + pkg.session);
    }
    report.LIVE_VERSION = pkg.chat;
    console.log('STEP link A2 ' + report.LIVE_VERSION);
    let aLink = await linkAnotherDesktop(browser, a1.page, prefix(a1.pub), { keep: true });
    if (!aLink.ok || !aLink.page) aLink = await linkAnotherDesktop(browser, a1.page, prefix(a1.pub), { keep: true });
    if (!aLink.ok || !aLink.page) fail('A2_LINK', aLink.code || 'LINK_FAILED');
    a2 = aLink;
    const a2root = await a2.page.evaluate(() => {
      const App = window.NostrApp || {};
      const session = App.getAccountSession ? App.getAccountSession() : null;
      return { root: App.privateKey != null, role: session && session.role, device: String(session && session.deviceSignPub || '').slice(0, 8) };
    });
    if (a2root.root === true || a2root.role !== 'LINKED_DEVICE') fail('A2_ROOT_OR_ROLE', JSON.stringify(a2root));
    report.MD3_VERIFIED = 'PASS';

    console.log('STEP login B1');
    try { b1 = await loginPrimary(browser, 'B1'); } catch (err) {
      console.log('RETRY login B1');
      b1 = await loginPrimary(browser, 'B1b');
    }
    let bLink = await linkAnotherDesktop(browser, b1.page, prefix(b1.pub), { keep: true });
    if (!bLink.ok || !bLink.page) bLink = await linkAnotherDesktop(browser, b1.page, prefix(b1.pub), { keep: true });
    if (!bLink.ok || !bLink.page) fail('B2_LINK', bLink.code || 'LINK_FAILED');
    b2 = bLink;
    const b2root = await b2.page.evaluate(() => {
      const App = window.NostrApp || {};
      return App.privateKey == null && App.getAccountSession && App.getAccountSession().role === 'LINKED_DEVICE';
    });
    if (b2root !== true) fail('B2_ROOT_OR_ROLE');

    let dir = { ok: false, n: 0, encSame: false };
    for (let i = 0; i < 15 && !dir.ok; i += 1) {
      dir = await directoryHas(a2.page, b1.pub);
      if (!dir.ok) await new Promise((r) => setTimeout(r, 2000));
    }
    report.DEVICE_DIRECTORY_VALID = dir.ok === true && dir.encSame !== true ? 'PASS' : 'FAIL';
    report.DEVICE_ENCRYPTION_VALID = dir.encSame === true ? 'FAIL' : 'PASS';
    if (!dir.ok) fail('DEVICE_DIRECTORY', 'n=' + dir.n);

    console.log('STEP text A2');
    const a1Notes = [];
    a1.page.on('console', (msg) => {
      const line = msg.text();
      if (/MD3|CHAT\/E2EE|CHAT\/ROUTE|sibling|SYNC/.test(line)) a1Notes.push(line.slice(0, 180));
    });
    const text = 'fd4-text-' + crypto.randomBytes(4).toString('hex');
    const sent = await sendText(a2.page, b1.pub, text);
    const authored = await a2.page.evaluate(async () => {
      const App = window.NostrApp;
      const session = App.getAccountSession ? App.getAccountSession() : null;
      const device = session && session.deviceSignPub ? String(session.deviceSignPub) : '';
      let events = [];
      try {
        const filter = { kinds: [1050], authors: [device], limit: 15 };
        if (typeof App.pool.querySync === 'function') {
          const result = await App.pool.querySync(App.relayUrls, filter);
          events = Array.isArray(result && result.events) ? result.events : (Array.isArray(result) ? result : []);
        } else if (typeof App.pool.list === 'function') {
          events = await App.pool.list(App.relayUrls, [filter]);
        } else return { error: 'NO_QUERY', keys: Object.keys(App.pool || {}) };
      } catch (e) { return { error: String(e && e.message || e).slice(0, 120) }; }
      const flat = Array.isArray(events) ? events : [];
      return {
        n: flat.length,
        rows: flat.slice(0, 8).map((ev) => ({
          id: String(ev && ev.id || '').slice(0, 8),
          p: ((ev && ev.tags) || []).filter((t) => t && t[0] === 'p').map((t) => String(t[1] || '').slice(0, 8)),
          t: ((ev && ev.tags) || []).filter((t) => t && (t[0] === 't' || t[0] === 'sync-peer')).map((t) => t[0] + '=' + String(t[1] || '').slice(0, 16)),
        })),
      };
    });
    console.log('AUTHORED ' + JSON.stringify(authored));
    if (!sent.ok || sent.delegated !== true || sent.rootPresent === true) fail('A2_TEXT_SEND', sent.error || JSON.stringify(sent));
    const a1text = await expectChat(a1.page, text, 'outgoing', b1.pub);
    const a2text = await expectChat(a2.page, text, 'outgoing', b1.pub);
    const b1text = await expectChat(b1.page, text, 'incoming', a1.pub);
    const b2text = await expectChat(b2.page, text, 'incoming', a1.pub);
    report.TEXT_OUTGOING_A1 = a1text.ok ? 'PASS' : 'FAIL';
    report.TEXT_OUTGOING_A2 = a2text.ok ? 'PASS' : 'FAIL';
    report.TEXT_A2_TO_B1 = b1text.ok ? 'PASS' : 'FAIL';
    report.TEXT_A2_TO_B2 = b2text.ok ? 'PASS' : 'FAIL';
    report.FALSE_SELF_MESSAGES = [a1text, a2text, b1text, b2text].every((row) => row.selfHits === 0) ? 0 : 1;
    report.DUPLICATE_MESSAGES = [a1text, a2text, b1text, b2text].every((row) => row.n === 1) ? 0 : 1;
    const logicals = [a1text.logical, a2text.logical, b1text.logical, b2text.logical].filter(Boolean);
    report.LOGICAL_ID_MATCH = logicals.length === 4 && logicals.every((id) => id === logicals[0]) ? 'PASS' : 'FAIL';
    report.AUTHORED = authored;
    if (!a1text.ok || !a2text.ok || !b1text.ok || !b2text.ok) {
      report.A1_NOTES = a1Notes.slice(-12);
      fail('A2_TEXT', JSON.stringify({ a1: a1text, a2: a2text, b1: b1text, b2: b2text }));
    }

    const voice = await sendVoice(a2.page, b1.pub);
    if (!voice.ok || !voice.hash) fail('A2_VOICE_SEND', voice.error || 'NO_HASH');
    const voicePages = [
      ['A1', a1.page],
      ['A2', a2.page],
      ['B1', b1.page],
      ['B2', b2.page],
    ];
    const voiceHits = {};
    for (let i = 0; i < voicePages.length; i += 1) {
      voiceHits[voicePages[i][0]] = await waitDecryptedHash(voicePages[i][1], voice.hash, 50000);
    }
    report.VOICE_OUTGOING_SIBLING_SYNC = voiceHits.A1 && voiceHits.A1.ok ? 'PASS' : 'FAIL';
    report.VOICE_A2_TO_B1 = voiceHits.B1 && voiceHits.B1.ok ? 'PASS' : 'FAIL';
    report.VOICE_A2_TO_B2 = voiceHits.B2 && voiceHits.B2.ok ? 'PASS' : 'FAIL';
    report.VOICE_BYTES_VERIFIED = voice.localHash === voice.hash && voiceHits.B1 && voiceHits.B1.ok && voiceHits.B2 && voiceHits.B2.ok && voiceHits.A1 && voiceHits.A1.ok ? 'PASS' : 'FAIL';
    if (report.VOICE_BYTES_VERIFIED !== 'PASS') fail('A2_VOICE', JSON.stringify(voiceHits));

    const back = 'fd4-back-' + crypto.randomBytes(4).toString('hex');
    const backSent = await sendText(b2.page, a1.pub, back);
    if (!backSent.ok) fail('B2_TEXT_SEND', backSent.error || '');
    const backA1 = await expectChat(a1.page, back, 'incoming', b1.pub);
    const backA2 = await expectChat(a2.page, back, 'incoming', b1.pub);
    const backB1 = await expectChat(b1.page, back, 'outgoing', a1.pub);
    const backB2 = await expectChat(b2.page, back, 'outgoing', a1.pub);
    report.TEXT_B2_TO_A1 = backA1.ok ? 'PASS' : 'FAIL';
    report.TEXT_B2_TO_A2 = backA2.ok ? 'PASS' : 'FAIL';
    report.TEXT_B2_OUTGOING_B1 = backB1.ok ? 'PASS' : 'FAIL';
    report.TEXT_B2_OUTGOING_B2 = backB2.ok ? 'PASS' : 'FAIL';
    if (!backA1.ok || !backA2.ok || !backB1.ok || !backB2.ok) fail('B2_TEXT', JSON.stringify({ a1: backA1, a2: backA2, b1: backB1, b2: backB2 }));

    const backVoice = await sendVoice(b2.page, a1.pub);
    if (!backVoice.ok || !backVoice.hash) fail('B2_VOICE_SEND', backVoice.error || '');
    const backVoiceA1 = await waitDecryptedHash(a1.page, backVoice.hash, 50000);
    const backVoiceA2 = await waitDecryptedHash(a2.page, backVoice.hash, 50000);
    const backVoiceB1 = await waitDecryptedHash(b1.page, backVoice.hash, 50000);
    report.VOICE_B2_TO_A1 = backVoiceA1.ok ? 'PASS' : 'FAIL';
    report.VOICE_B2_TO_A2 = backVoiceA2.ok ? 'PASS' : 'FAIL';
    report.VOICE_B2_OUTGOING_B1 = backVoiceB1.ok ? 'PASS' : 'FAIL';
    if (!backVoiceA1.ok || !backVoiceA2.ok || !backVoiceB1.ok) fail('B2_VOICE', JSON.stringify({ a1: backVoiceA1, a2: backVoiceA2, b1: backVoiceB1 }));

    const phoneText = 'fd4-phone-' + crypto.randomBytes(4).toString('hex');
    const phoneSent = await sendText(a1.page, b1.pub, phoneText);
    if (!phoneSent.ok) fail('A1_TEXT_SEND', phoneSent.error || '');
    const phoneB1 = await expectChat(b1.page, phoneText, 'incoming', a1.pub);
    const phoneB2 = await expectChat(b2.page, phoneText, 'incoming', a1.pub);
    const phoneA2 = await expectChat(a2.page, phoneText, 'outgoing', b1.pub);
    report.TEXT_A1_TO_B1 = phoneB1.ok ? 'PASS' : 'FAIL';
    report.TEXT_A1_TO_B2 = phoneB2.ok ? 'PASS' : 'FAIL';
    report.TEXT_A1_OUTGOING_A2 = phoneA2.ok ? 'PASS' : 'FAIL';
    if (!phoneB1.ok || !phoneB2.ok || !phoneA2.ok) fail('A1_TEXT', JSON.stringify({ b1: phoneB1, b2: phoneB2, a2: phoneA2 }));

    await b1.ctx.setOffline(true);
    const offlineText = 'fd4-b1off-' + crypto.randomBytes(4).toString('hex');
    const offlineSent = await sendText(a2.page, b1.pub, offlineText);
    if (!offlineSent.ok) fail('OFFLINE_B1_SEND', offlineSent.error || '');
    const offlineB2 = await expectChat(b2.page, offlineText, 'incoming', a1.pub);
    report.RECIPIENT_PHONE_OFFLINE_DESKTOP_DELIVERY = offlineB2.ok ? 'PASS' : 'FAIL';
    if (!offlineB2.ok) fail('B1_OFFLINE_B2', JSON.stringify(offlineB2));
    await b1.ctx.setOffline(false);
    const offlineCatch = await expectChat(b1.page, offlineText, 'incoming', a1.pub);
    if (!offlineCatch.ok || offlineCatch.n !== 1) fail('B1_CATCHUP', JSON.stringify(offlineCatch));

    await a1.ctx.setOffline(true);
    const senderOff = 'fd4-a1off-' + crypto.randomBytes(4).toString('hex');
    const senderSent = await sendText(a2.page, b1.pub, senderOff);
    if (!senderSent.ok || senderSent.rootPresent === true) fail('A1_OFFLINE_SEND', senderSent.error || '');
    const senderB1 = await expectChat(b1.page, senderOff, 'incoming', a1.pub);
    const senderB2 = await expectChat(b2.page, senderOff, 'incoming', a1.pub);
    report.SENDER_PHONE_OFFLINE_DESKTOP_SEND = senderSent.ok && senderB1.ok && senderB2.ok ? 'PASS' : 'FAIL';
    if (!senderB1.ok || !senderB2.ok) fail('A1_OFFLINE_B', JSON.stringify({ b1: senderB1, b2: senderB2 }));
    await a1.ctx.setOffline(false);
    const senderCatch = await expectChat(a1.page, senderOff, 'outgoing', b1.pub);
    if (!senderCatch.ok || senderCatch.n !== 1) fail('A1_CATCHUP', JSON.stringify(senderCatch));

    const selfText = 'fd4-self-' + crypto.randomBytes(4).toString('hex');
    const selfSent = await a1.page.evaluate(async (text) => {
      const App = window.NostrApp;
      const out = await App.publishChatMessage(App.publicKey, text);
      return { ok: !!(out && out.ok && out.selfChat === true) };
    }, selfText);
    if (!selfSent.ok) fail('SELF_SEND');
    const selfA1 = await pollPage(a1.page, async (text) => {
      const App = window.NostrApp;
      const self = String(App.publicKey || '').toLowerCase();
      let n = 0;
      const conv = App.chatState && App.chatState.conversations;
      if (conv) conv.forEach((entry) => {
        if (String(entry.peer || '').toLowerCase() !== self) return;
        (entry.messages || []).forEach((m) => { if (m && m.content === text) n += 1; });
      });
      return { ok: n === 1, n };
    }, selfText, 20000);
    const selfA2 = await pollPage(a2.page, async (text) => {
      const App = window.NostrApp;
      const Session = window.SosAccountSession;
      if (Session && Session.pullLinkedDirectMessages) {
        try { await Session.pullLinkedDirectMessages(); } catch (_e) {}
      }
      const self = String(App.publicKey || '').toLowerCase();
      let n = 0;
      const conv = App.chatState && App.chatState.conversations;
      if (conv) conv.forEach((entry) => {
        if (String(entry.peer || '').toLowerCase() !== self) return;
        (entry.messages || []).forEach((m) => { if (m && m.content === text) n += 1; });
      });
      return { ok: n === 1, n };
    }, selfText, 40000);
    const selfB = await b1.page.evaluate((text) => {
      let n = 0;
      const conv = window.NostrApp.chatState && window.NostrApp.chatState.conversations;
      if (conv) conv.forEach((entry) => {
        (entry.messages || []).forEach((m) => { if (m && m.content === text) n += 1; });
      });
      return n;
    }, selfText);
    report.TRUE_SELF_CHAT = selfA1.ok && selfA2.ok && selfB === 0 ? 'PASS' : 'FAIL';
    if (report.TRUE_SELF_CHAT !== 'PASS') fail('SELF_CHAT', JSON.stringify({ a1: selfA1, a2: selfA2, b: selfB }));

    for (const page of [a1.page, a2.page, b1.page, b2.page]) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
      await waitApp(page);
      await patchPoolPublishIterable(page);
    }
    const reA1 = await expectChat(a1.page, text, 'outgoing', b1.pub);
    const reB2 = await expectChat(b2.page, text, 'incoming', a1.pub);
    report.RELOAD = reA1.ok && reA1.n === 1 && reB2.ok && reB2.n === 1 && reA1.selfHits === 0 ? 'PASS' : 'FAIL';
    report.DATA_LOSS = reA1.ok && reB2.ok ? 0 : 1;
    if (report.RELOAD !== 'PASS') fail('RELOAD', JSON.stringify({ a1: reA1, b2: reB2 }));

    report.SECURITY = await a2.page.evaluate(async () => {
      const App = window.NostrApp;
      const Session = window.SosAccountSession;
      const account = String(App.publicKey || '').toLowerCase();
      const other = 'ab'.repeat(32);
      const device = 'cd'.repeat(32);
      const route = App.classifyChatDelivery({
        accountUser: account,
        devicePub: device,
        onDevice: true,
        sender: device,
        senderAccount: account,
        recipient: other,
        recipientAccount: other,
        selfAuthored: true,
        syncVerified: true,
      });
      const forged = await Session.verifyDelegatedEvent({
        kind: 1050,
        pubkey: device,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', other], ['t', 'yalachat'], ['sos-md3', '{"forged":true}']],
        content: '{}',
        id: '11'.repeat(32),
        sig: '22'.repeat(64),
      }, 'DEVICE_CHAT');
      const mutated = App.classifyChatDelivery({
        accountUser: account,
        onDevice: true,
        sender: 'ef'.repeat(32),
        senderAccount: other,
        recipient: account,
        syncPeerAccount: '99'.repeat(32),
        ownSync: true,
        syncVerified: false,
        selfAuthored: false,
        deviceCopy: true,
      });
      return {
        selfAuthoredStaysOutgoing: !!(route && route.kind === 'OUTGOING_TO_EXTERNAL_ACCOUNT' && route.peer === other),
        forgedMd3: !!(forged && forged.ok === false),
        mutatedSync: !!(mutated && mutated.peer === other && mutated.kind !== 'SELF_CONVERSATION'),
      };
    });
    if (!report.SECURITY.selfAuthoredStaysOutgoing || !report.SECURITY.forgedMd3 || !report.SECURITY.mutatedSync) {
      fail('SECURITY', JSON.stringify(report.SECURITY));
    }

    const selfBack = 'fd4-self-desk-' + crypto.randomBytes(4).toString('hex');
    const selfBackSent = await sendText(a2.page, a1.pub, selfBack);
    const selfBackA1 = await pollPage(a1.page, async (text) => {
      const App = window.NostrApp;
      if (typeof App.pullRecentAccountChat === 'function') {
        try { await App.pullRecentAccountChat(); } catch (_e) {}
      }
      const self = String(App.publicKey || '').toLowerCase();
      let n = 0;
      const conv = App.chatState && App.chatState.conversations;
      if (conv) conv.forEach((entry) => {
        if (String(entry.peer || '').toLowerCase() !== self) return;
        (entry.messages || []).forEach((m) => { if (m && m.content === text) n += 1; });
      });
      return { ok: n === 1, n };
    }, selfBack, 40000);
    report.SELF_TEXT_DESKTOP_TO_PHONE = selfBackSent.ok && selfBackA1.ok ? 'PASS' : 'FAIL';
    if (report.SELF_TEXT_DESKTOP_TO_PHONE !== 'PASS') fail('SELF_DESKTOP', JSON.stringify({ sent: selfBackSent, a1: selfBackA1 }));

    console.log('STEP jpeg A1');
    const jpeg = await a1.page.evaluate(async (account) => {
      const App = window.NostrApp;
      const canvas = document.createElement('canvas');
      canvas.width = 48;
      canvas.height = 48;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#19c37d';
      ctx.fillRect(0, 0, 48, 48);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      const raw = new Uint8Array(await blob.arrayBuffer());
      const hash = await App.hashMediaCiphertext(raw);
      const file = new File([blob], 'fd4-photo.jpg', { type: 'image/jpeg' });
      const id = await App.sendP2PFile(account, file, () => {});
      return { id: String(id || ''), hash, queued: id === 'LOCAL_QUEUED' };
    }, b1.pub);
    const jpegHits = {};
    for (const row of [['B1', b1.page], ['B2', b2.page], ['A2', a2.page]]) {
      jpegHits[row[0]] = await waitPlainHash(row[1], jpeg.hash, 70000);
    }
    report.PHONE_JPEG = { id: jpeg.id, queued: jpeg.queued, hash: jpeg.hash, hits: jpegHits };

    console.log('STEP jpeg A2');
    const desk = await a2.page.evaluate(async (account) => {
      const App = window.NostrApp;
      const canvas = document.createElement('canvas');
      canvas.width = 36;
      canvas.height = 36;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#2d88ff';
      ctx.fillRect(0, 0, 36, 36);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      const raw = new Uint8Array(await blob.arrayBuffer());
      const hash = await App.hashMediaCiphertext(raw);
      const file = new File([blob], 'fd4-desk.jpg', { type: 'image/jpeg' });
      const id = await App.sendP2PFile(account, file, () => {});
      return { id: String(id || ''), hash, queued: id === 'LOCAL_QUEUED', root: App.privateKey != null };
    }, b1.pub);
    const deskHits = {};
    for (const row of [['A1', a1.page], ['B1', b1.page], ['B2', b2.page]]) {
      deskHits[row[0]] = await waitPlainHash(row[1], desk.hash, 70000);
    }
    report.DESKTOP_JPEG = { id: desk.id, queued: desk.queued, root: desk.root, hits: deskHits };

    console.log('STEP self jpeg');
    const selfJpeg = await a1.page.evaluate(async () => {
      const App = window.NostrApp;
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ff8800';
      ctx.fillRect(0, 0, 32, 32);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      const raw = new Uint8Array(await blob.arrayBuffer());
      const hash = await App.hashMediaCiphertext(raw);
      const file = new File([blob], 'self-photo.jpg', { type: 'image/jpeg' });
      const id = await App.sendP2PFile(App.publicKey, file, () => {});
      return { id: String(id || ''), hash, queued: id === 'LOCAL_QUEUED' };
    });
    report.SELF_JPEG = {
      id: selfJpeg.id,
      queued: selfJpeg.queued,
      hash: selfJpeg.hash,
      A2: await waitPlainHash(a2.page, selfJpeg.hash, 45000),
    };
    report.STATUS = 'PASS_FOUR_DEVICE_CHAT';
    report.FIRST_FAILED_TRANSITION = '';
  } catch (err) {
    if (report.STATUS !== 'FAIL') report.STATUS = 'FAIL';
    if (!report.FIRST_FAILED_TRANSITION) report.FIRST_FAILED_TRANSITION = String(err && err.message || err).slice(0, 200);
  } finally {
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log('EVIDENCE=' + path.join(OUT, 'result.json'));
    await browser.close().catch(() => {});
  }
  if (report.STATUS !== 'PASS_FOUR_DEVICE_CHAT') process.exit(1);
}

main();
