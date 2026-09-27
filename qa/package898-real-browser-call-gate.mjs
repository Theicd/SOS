/**
 * Package 898 — real visible-Chromium voice + video call acceptance.
 * Two independent contexts, fake media devices, the app's own call modules and signaling relays.
 * Default URL: local RC server; override with SOS_CALL_URL. Disposable identities; never logs keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'package898-real-browser-call-report.json');
const URL0 = process.env.SOS_CALL_URL || 'http://127.0.0.1:8794/videos.html';
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { gate: 'PACKAGE898_REAL_BROWSER_CALLS', url: URL0, status: 'FAIL', ts: new Date().toISOString(), voice: {}, video: {} };

async function boot(page, key) {
  await page.goto(URL0, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.createNewIdentityExplicit && !!window.NostrApp?.voiceCall && !!window.NostrApp?.videoCall && !!window.NostrApp?.pool, null, { timeout: 120000 });
  return page.evaluate(async (k) => {
    const App = window.NostrApp;
    const c = App.createNewIdentityExplicit({ privateKeyHex: k });
    App.guestMode = false;
    App.SessionAuthority?.bindCurrentSession?.({ accountPubkey: c.publicKey, bump: true });
    try {
      window.dispatchEvent(new CustomEvent('sos-identity-ready'));
    } catch (_e) {}
    await new Promise((r) => setTimeout(r, 1500));
    try {
      App.voiceCall.subscribe();
    } catch (_e) {}
    try {
      App.initVideoCall?.({ force: true });
      App.videoCall.subscribe();
    } catch (_e) {}
    const v = await fetch('./app-version.json?_=' + Date.now()).then((r) => r.json()).catch(() => ({}));
    return { pub: String(c.publicKey || '').toLowerCase(), pkg: v.version || '' };
  }, key);
}

async function hookIncoming(page) {
  await page.evaluate(() => {
    const App = window.NostrApp;
    window.__inVoice = null;
    window.__inVideo = null;
    const ov = App.onVoiceCallIncoming;
    App.onVoiceCallIncoming = function (peer, offer) {
      window.__inVoice = { peer, offer };
      try {
        return ov && ov.apply(this, arguments);
      } catch (_e) {}
    };
    const ovd = App.onVideoCallIncoming;
    App.onVideoCallIncoming = function (peer, offer) {
      window.__inVideo = { peer, offer };
      try {
        return ovd && ovd.apply(this, arguments);
      } catch (_e) {}
    };
  });
}

async function audioStats(page) {
  return page.evaluate(async () => {
    const pc = window.NostrApp.voiceCall.getState().peerConnection;
    if (!pc) return { state: null };
    const out = { state: pc.connectionState, ice: pc.iceConnectionState, inBytes: 0, outBytes: 0, candidate: null };
    const stats = await pc.getStats();
    const byId = new Map();
    stats.forEach((s) => byId.set(s.id, s));
    stats.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') out.inBytes += s.bytesReceived || 0;
      if (s.type === 'outbound-rtp' && s.kind === 'audio') out.outBytes += s.bytesSent || 0;
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) {
        const l = byId.get(s.localCandidateId);
        const r = byId.get(s.remoteCandidateId);
        out.candidate = (l && l.candidateType) + '/' + (r && r.candidateType);
      }
    });
    return out;
  });
}

async function main() {
  const kA = hex(generateSecretKey());
  const kB = hex(generateSecretKey());
  const pubA = getPublicKey(Buffer.from(kA, 'hex'));
  const pubB = getPublicKey(Buffer.from(kB, 'hex'));
  const browser = await chromium.launch({
    headless: false,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctxA = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1000, height: 760 } });
  const ctxB = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1000, height: 760 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  try {
    const a = await boot(pageA, kA);
    const b = await boot(pageB, kB);
    report.package = a.pkg || b.pkg;
    report.identities = a.pub === pubA && b.pub === pubB;
    await hookIncoming(pageB);
    await hookIncoming(pageA);
    await sleep(2500);

    // ---------------- voice
    const tV = Date.now();
    report.voice.start = await pageA.evaluate(async (p) => {
      try {
        await window.NostrApp.voiceCall.start(p);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e.message || e).slice(0, 160) };
      }
    }, pubB);
    const gotVoice = await pageB.waitForFunction(() => !!window.__inVoice, null, { polling: 250, timeout: 60000 }).then(() => true).catch(() => false);
    report.voice.offerReceivedMs = gotVoice ? Date.now() - tV : null;
    if (gotVoice) {
      report.voice.accept = await pageB.evaluate(async () => {
        try {
          await window.NostrApp.voiceCall.accept(window.__inVoice.peer, window.__inVoice.offer);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String(e.message || e).slice(0, 160) };
        }
      });
    }
    let sa = null;
    let sb = null;
    for (let i = 0; i < 60; i++) {
      sa = await audioStats(pageA);
      sb = await audioStats(pageB);
      if (sa.state === 'connected' && sb.state === 'connected') break;
      await sleep(1000);
    }
    report.voice.connectedMs = sa && sa.state === 'connected' ? Date.now() - tV : null;
    await sleep(4000);
    sa = await audioStats(pageA);
    sb = await audioStats(pageB);
    report.voice.statsA = sa;
    report.voice.statsB = sb;
    report.voice.REAL_VOICE_CALL = sa.state === 'connected' && sb.state === 'connected' && sa.inBytes > 0 && sb.inBytes > 0;
    await pageA.evaluate(async () => {
      try {
        await window.NostrApp.voiceCall.end({ reason: 'qa_done' });
      } catch (_e) {}
    });
    const endedB = await pageB
      .waitForFunction(() => !window.NostrApp.voiceCall.getState().peerConnection || window.NostrApp.voiceCall.getState().isCallActive === false, null, { polling: 300, timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    report.voice.REMOTE_HANGUP_PROPAGATED = endedB;
    await pageB.evaluate(async () => {
      try {
        await window.NostrApp.voiceCall.end({ reason: 'qa_cleanup' });
      } catch (_e) {}
    });
    await sleep(3000);

    // ---------------- video
    const tVid = Date.now();
    report.video.start = await pageA.evaluate(async (p) => {
      try {
        await window.NostrApp.videoCall.start(p);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e.message || e).slice(0, 160) };
      }
    }, pubB);
    const gotVideo = await pageB.waitForFunction(() => !!window.__inVideo, null, { polling: 250, timeout: 60000 }).then(() => true).catch(() => false);
    report.video.offerReceivedMs = gotVideo ? Date.now() - tVid : null;
    if (gotVideo) {
      report.video.accept = await pageB.evaluate(async () => {
        try {
          await window.NostrApp.videoCall.accept(window.__inVideo.peer, window.__inVideo.offer);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String(e.message || e).slice(0, 160) };
        }
      });
    }
    const remoteVideo = (page) =>
      page.evaluate(() => {
        const s = window.NostrApp.videoCall.getState();
        const rs = s.remoteStream;
        const v = rs ? rs.getVideoTracks() : [];
        const au = rs ? rs.getAudioTracks() : [];
        return { active: !!s.isActive, video: v.length ? v[0].readyState + (v[0].muted ? ':muted' : ':unmuted') : 'none', audio: au.length ? au[0].readyState : 'none' };
      });
    let va = null;
    let vb = null;
    for (let i = 0; i < 60; i++) {
      va = await remoteVideo(pageA);
      vb = await remoteVideo(pageB);
      if (/^live:unmuted/.test(va.video) && /^live:unmuted/.test(vb.video)) break;
      await sleep(1000);
    }
    report.video.connectedMs = /^live:unmuted/.test(va.video) ? Date.now() - tVid : null;
    report.video.remoteA = va;
    report.video.remoteB = vb;
    report.video.REAL_VIDEO_CALL = /^live:unmuted/.test(va.video) && /^live:unmuted/.test(vb.video);
    await pageA.evaluate(async () => {
      try {
        await window.NostrApp.videoCall.end();
      } catch (_e) {}
    });
    await sleep(1500);
    report.nsecInDom = await pageA.evaluate(() => /nsec1[02-9ac-hj-np-z]{20,}/.test(document.body.innerText || ''));
    report.status = report.voice.REAL_VOICE_CALL && report.video.REAL_VIDEO_CALL && !report.nsecInDom ? 'PASS' : 'FAIL';
  } catch (e) {
    report.error = String(e.stack || e).slice(0, 800);
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    await browser.close().catch(() => {});
  }
  console.log('VOICE', JSON.stringify(report.voice).slice(0, 400));
  console.log('VIDEO', JSON.stringify(report.video).slice(0, 400));
  console.log('STATUS', report.status);
  process.exit(report.status === 'PASS' ? 0 : 1);
}

main();
