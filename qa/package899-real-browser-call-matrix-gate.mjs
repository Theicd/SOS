#!/usr/bin/env node
/**
 * Package 899 Phases H/I/J/K/L/M/N/O — REAL visible Chromium call matrix against the exact local RC tree.
 *  - Two contexts, fake media devices, the app's own call modules and the live signaling relays.
 *  - Every relay WebSocket is tapped with Playwright routeWebSocket (pass-through) so REQ/EVENT frames
 *    can be counted and relay faults injected on the caller side (down / slow / gift-wrap rejected /
 *    auth-required / disconnect after publish).
 *  - Latency is derived from App.RealtimePerf marks (wall0 + ms offsets, same machine clock for both pages).
 * Disposable identities only. Never logs keys / nsec / SDP.
 * Run: node qa/package899-real-browser-call-matrix-gate.mjs   (CM_N, CM_RING_N, CM_ROOT, CM_OUT, CM_SKIP_FAILOVER=1)
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey, utils } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.CM_ROOT || path.resolve(__dirname, '..'));
const OUT = process.env.CM_OUT || path.join(__dirname, 'package899-real-browser-call-matrix-report.json');
const N = Math.max(1, Number(process.env.CM_N || 20));
const RING_N = Math.max(0, Number(process.env.CM_RING_N || 40));
const IDLE_MS = Math.max(0, Number(process.env.CM_IDLE_MS || 60000));
const GAP_MS = Math.max(500, Number(process.env.CM_GAP_MS || 2000));
const SKIP_FAILOVER = process.env.CM_SKIP_FAILOVER === '1';
const MEDIA = (process.env.CM_MEDIA || 'voice,video').split(',').filter(Boolean);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };
function serve(root) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.join(root, url === '/' ? '/videos.html' : url);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function pct(arr, p) {
  const a = arr.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))];
}
const stat = (arr) => ({ n: arr.filter((x) => Number.isFinite(x)).length, p50: pct(arr, 50), p95: pct(arr, 95), max: pct(arr, 100) });

// ---------------------------------------------------------------- WebSocket tap + fault injection
const SECRET_PATTERNS = [];
const LOGS = { A: [], B: [] };
const TAPS = {};
const PAGE_LABEL = new WeakMap();
const calleeSkips = (page, from) => (LOGS[PAGE_LABEL.get(page)] || []).filter((l) => l.at >= from && /CALL_SIGNAL_(SKIP|REJECT)|TOMBSTONE|ignored|CALL_RING_RX|CALL_STALE/.test(l.t)).map((l) => l.t.slice(0, 80)).slice(0, 12);
function installWsTap(ctx, label) {
  const tap = {
    label, fault: null, sockets: new Set(), subs: new Map(),
    eventsByKind: {}, eventsByHostKind: {}, okFalse: [], authChallenges: 0, downRejects: 0,
    giftWrapPubkeys: new Set(), privacyViolations: [], reqLog: [], faultEvents: {}, inbound: [],
  };
  const parse = (m) => { try { const v = JSON.parse(typeof m === 'string' ? m : Buffer.from(m).toString('utf8')); return Array.isArray(v) ? v : null; } catch (_) { return null; } };
  ctx.routeWebSocket(/^wss?:\/\//, (ws) => {
    let host = '';
    try { host = new URL(ws.url()).host; } catch (_) {}
    const f0 = tap.fault && tap.fault.host === host ? tap.fault : null;
    if (f0 && f0.mode === 'down') { tap.downRejects++; ws.close({ code: 1011, reason: 'qa-relay-down' }); return; }
    const server = ws.connectToServer();
    const rec = { host, ws, server };
    tap.sockets.add(rec);
    ws.onClose(() => { tap.sockets.delete(rec); try { server.close(); } catch (_) {} });
    server.onClose(() => { tap.sockets.delete(rec); try { ws.close(); } catch (_) {} });
    ws.onMessage((m) => {
      const text = typeof m === 'string' ? m : Buffer.from(m).toString('utf8');
      const msg = parse(m);
      for (const s of SECRET_PATTERNS) if (text.includes(s)) tap.privacyViolations.push('secret_in_frame:' + host);
      if (msg && msg[0] === 'EVENT' && msg[1] && typeof msg[1] === 'object') {
        const k = Number(msg[1].kind);
        tap.eventsByKind[k] = (tap.eventsByKind[k] || 0) + 1;
        const hk = (tap.eventsByHostKind[host] = tap.eventsByHostKind[host] || {});
        hk[k] = (hk[k] || 0) + 1;
        if (k === 1059) {
          tap.giftWrapPubkeys.add(String(msg[1].pubkey || '').toLowerCase());
          if (/a=fingerprint|a=ice-ufrag|"sdp"\s*:/.test(String(msg[1].content || ''))) tap.privacyViolations.push('sdp_in_giftwrap:' + host);
        }
        if (k === 25050) tap.privacyViolations.push('legacy_25050_publish:' + host);
      }
      if (msg && msg[0] === 'REQ') {
        const filters = msg.slice(2).filter((x) => x && typeof x === 'object');
        const kinds = [...new Set(filters.flatMap((x) => (Array.isArray(x.kinds) ? x.kinds : [])))];
        tap.subs.set(host + '|' + msg[1], { host, kinds, at: Date.now() });
        tap.reqLog.push({ host, kinds, at: Date.now() });
      }
      if (msg && msg[0] === 'CLOSE') tap.subs.delete(host + '|' + msg[1]);
      const fx = tap.fault && tap.fault.host === host ? tap.fault : null;
      const isGw = !!(msg && msg[0] === 'EVENT' && msg[1] && Number(msg[1].kind) === 1059);
      if (fx && isGw) tap.faultEvents[fx.name] = (tap.faultEvents[fx.name] || 0) + 1;
      if (fx && isGw && (fx.mode === 'reject' || fx.mode === 'authReject')) {
        const reason = fx.mode === 'authReject' ? 'auth-required: authenticate to publish gift wraps' : 'blocked: qa gift-wrap rejected';
        try { ws.send(JSON.stringify(['OK', msg[1].id, false, reason])); } catch (_) {}
        return;
      }
      if (fx && fx.mode === 'slow') { setTimeout(() => { try { server.send(m); } catch (_) {} }, fx.delayMs || 6000); return; }
      try { server.send(m); } catch (_) {}
      if (fx && fx.mode === 'dropAfterPublish' && isGw) setTimeout(() => { try { ws.close({ code: 1011, reason: 'qa-drop-after-publish' }); } catch (_) {} }, 30);
    });
    server.onMessage((m) => {
      const msg = parse(m);
      if (msg && msg[0] === 'OK' && msg[2] === false) tap.okFalse.push({ host, reason: String(msg[3] || '').slice(0, 80) });
      if (msg && msg[0] === 'AUTH') tap.authChallenges++;
      if (msg && msg[0] === 'EVENT' && msg[2] && Number(msg[2].kind) === 1059) {
        tap.inbound.push({ host, at: Date.now(), sub: String(msg[1] || '').slice(0, 12), id: String(msg[2].id || '').slice(0, 8) });
        if (tap.inbound.length > 5000) tap.inbound.splice(0, 1000);
      }
      if (msg && msg[0] === 'CLOSED') tap.subs.delete(host + '|' + msg[1]);
      const fx = tap.fault && tap.fault.host === host ? tap.fault : null;
      if (fx && fx.mode === 'slow') { setTimeout(() => { try { ws.send(m); } catch (_) {} }, fx.delayMs || 6000); return; }
      try { ws.send(m); } catch (_) {}
    });
  });
  tap.setFault = (fault) => {
    tap.fault = fault;
    if (fault && fault.mode === 'down') {
      for (const rec of [...tap.sockets]) if (rec.host === fault.host) { try { rec.ws.close({ code: 1011, reason: 'qa-relay-down' }); } catch (_) {} }
    }
  };
  tap.activeSubsByKind = (kind) => {
    const byHost = {};
    for (const s of tap.subs.values()) if (s.kinds.includes(kind)) byHost[s.host] = (byHost[s.host] || 0) + 1;
    return byHost;
  };
  return tap;
}

// ---------------------------------------------------------------- page helpers
async function boot(page, base, key, label) {
  await page.goto(base + '?cm=1&u=' + label, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!window.NostrApp?.createNewIdentityExplicit && !!window.NostrApp?.pool, null, { timeout: 120000 });
  const created = await page.evaluate(({ k }) => {
    const App = window.NostrApp;
    const c = App.createNewIdentityExplicit({ privateKeyHex: k });
    const SA = App.SessionAuthority || window.SosSessionAuthority;
    if (SA?.bindCurrentSession) SA.bindCurrentSession({ accountPubkey: c.publicKey, bump: true });
    return { pub: String(c?.publicKey || App.publicKey || '').toLowerCase() };
  }, { k: key });
  await sleep(2500);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction((pub) => {
    const App = window.NostrApp;
    return !!App?.voiceCall && !!App?.videoCall && String(App.publicKey || '').toLowerCase() === pub && App.guestMode !== true;
  }, created.pub, { timeout: 120000 });
  return page.evaluate(async () => {
    const App = window.NostrApp;
    try { App.initVoiceCall?.({}); } catch (_) {}
    try { App.initVideoCall?.({}); } catch (_) {}
    await new Promise((r) => setTimeout(r, 3000));
    const v = await fetch('./app-version.json?_=' + Date.now()).then((r) => r.json()).catch(() => ({}));
    return { pub: String(App.publicKey || '').toLowerCase(), pkg: v.version || '', perf: !!App.RealtimePerf, health: !!App.RelayHealth };
  });
}

async function hook(page) {
  return page.evaluate(() => {
    const App = window.NostrApp;
    const cm = (window.__cm = { ring: { voice: 0, video: 0 }, inc: { voice: 0, video: 0 }, ready: { voice: 0, video: 0 }, offer: { voice: null, video: null }, firstUiAt: { voice: 0, video: 0 }, ended: { voice: 0, video: 0 } });
    const present = {};
    const wrap = (name, fn) => {
      const orig = App[name];
      present[name] = typeof orig === 'function';
      App[name] = function () {
        try { fn.apply(null, arguments); } catch (_) {}
        if (typeof orig === 'function') { try { return orig.apply(this, arguments); } catch (_) {} }
      };
    };
    const ui = (m) => { if (!cm.firstUiAt[m]) cm.firstUiAt[m] = Date.now(); };
    window.__pcStates = [];
    if (!window.__pcPatched && typeof window.RTCPeerConnection === 'function') {
      window.__pcPatched = true;
      const Orig = window.RTCPeerConnection;
      const Patched = function (...args) {
        const pc = new Orig(...args);
        pc.addEventListener('connectionstatechange', () => { window.__pcStates.push({ at: Date.now(), cs: pc.connectionState, ice: pc.iceConnectionState }); });
        return pc;
      };
      Patched.prototype = Orig.prototype;
      Object.setPrototypeOf(Patched, Orig);
      window.RTCPeerConnection = Patched;
    }
    wrap('onVoiceCallRinging', () => { cm.ring.voice++; ui('voice'); });
    wrap('onVoiceCallIncoming', (peer, offer) => { cm.inc.voice++; ui('voice'); cm.offer.voice = { peer, offer }; });
    wrap('onVoiceCallOfferReady', (peer, offer) => { cm.ready.voice++; cm.offer.voice = { peer, offer }; });
    wrap('onVoiceCallEnded', () => { cm.ended.voice++; });
    wrap('onVideoCallRinging', () => { cm.ring.video++; ui('video'); });
    wrap('onVideoCallIncoming', (peer, offer) => { cm.inc.video++; ui('video'); cm.offer.video = { peer, offer }; });
    wrap('onVideoCallEnded', () => { cm.ended.video++; });
    return present;
  });
}

const resetHooks = (page) => page.evaluate(() => { const c = window.__cm; ['ring', 'inc', 'ready', 'ended', 'firstUiAt'].forEach((k) => { c[k] = { voice: 0, video: 0 }; }); c.offer = { voice: null, video: null }; });
const api = (m) => (m === 'voice' ? 'voiceCall' : 'videoCall');

async function startCall(page, media, peer) {
  await page.evaluate(({ m, p }) => {
    window.__cmStart = 'pending';
    window.NostrApp[m].start(p).then(() => { window.__cmStart = 'ok'; }, (e) => { window.__cmStart = 'err:' + String((e && e.message) || e).slice(0, 80); });
  }, { m: api(media), p: peer });
}
async function endCall(page, media) {
  await page.evaluate(async (m) => { try { await window.NostrApp[m].end({ reason: 'qa_done' }); } catch (_) {} }, api(media)).catch(() => {});
}
async function idle(page, media) {
  return page.evaluate((m) => {
    const s = window.NostrApp[m === 'voice' ? 'voiceCall' : 'videoCall'].getState();
    return m === 'voice' ? !s.currentPeer && !s.peerConnection && !s.isCallActive : !s.currentPeer && !s.isActive;
  }, media).catch(() => false);
}
async function waitIdle(pages, media, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    let all = true;
    for (const p of pages) if (!(await idle(p, media))) all = false;
    if (all) return true;
    await sleep(250);
  }
  return false;
}
async function forceIdle(pages, media) {
  for (const p of pages) await endCall(p, media);
  return waitIdle(pages, media, 10000);
}
const perfSnap = (page) => page.evaluate(() => (window.NostrApp.RealtimePerf ? window.NostrApp.RealtimePerf.snapshot() : null)).catch(() => null);
function lastRec(snap, media, pred) {
  if (!snap || !Array.isArray(snap.calls)) return null;
  for (let i = snap.calls.length - 1; i >= 0; i--) { const c = snap.calls[i]; if (c.media === media && pred(c)) return c; }
  return null;
}
const abs = (rec, name) => (rec && rec.marks && rec.marks[name] != null ? rec.wall0 + rec.marks[name] : null);
const dm = (rec, a, b) => (rec && rec.marks && rec.marks[a] != null && rec.marks[b] != null ? rec.marks[b] - rec.marks[a] : null);
const dAbs = (x, y) => (x != null && y != null ? y - x : null);

async function connectedBoth(caller, callee, media, since, ms) {
  const t = Date.now();
  let bothAt = 0;
  while (Date.now() - t < ms) {
    const [a, b] = [await perfSnap(caller), await perfSnap(callee)];
    const ra = lastRec(a, media, (c) => c.wall0 >= since - 50 && c.marks.CALL_CLICK != null);
    const rb = lastRec(b, media, (c) => c.wall0 >= since - 50);
    const both = ra && rb && ra.marks.CALL_CONNECTED != null && rb.marks.CALL_CONNECTED != null;
    if (both && ra.marks.PC_CONNECTED != null && rb.marks.PC_CONNECTED != null) return { ra, rb };
    if (both && !bothAt) bothAt = Date.now();
    if (both && Date.now() - bothAt > 3000) return { ra, rb, pcMissing: true };
    await sleep(200);
  }
  const [a, b] = [await perfSnap(caller), await perfSnap(callee)];
  return { ra: lastRec(a, media, (c) => c.wall0 >= since - 50 && c.marks.CALL_CLICK != null), rb: lastRec(b, media, (c) => c.wall0 >= since - 50), timeout: true };
}

// One full call: caller clicks, callee auto-accepts the moment the offer is available.
async function fullCall(caller, callee, media, peer, opts = {}) {
  await resetHooks(callee);
  await resetHooks(caller);
  const since = Date.now();
  await startCall(caller, media, peer);
  const offerOk = await callee.waitForFunction((m) => !!window.__cm.offer[m], media, { polling: 50, timeout: opts.offerTimeoutMs || 30000 }).then(() => true).catch(() => false);
  let accept = null;
  if (offerOk && !opts.noAccept) {
    accept = await callee.evaluate(async (m) => {
      const o = window.__cm.offer[m];
      try { await window.NostrApp[m === 'voice' ? 'voiceCall' : 'videoCall'].accept(o.peer, o.offer); return 'ok'; } catch (e) { return 'err:' + String((e && e.message) || e).slice(0, 80); }
    }, media);
  }
  const res = offerOk && !opts.noAccept ? await connectedBoth(caller, callee, media, since, opts.connectTimeoutMs || 25000) : { ra: lastRec(await perfSnap(caller), media, (c) => c.wall0 >= since - 50 && c.marks.CALL_CLICK != null), rb: lastRec(await perfSnap(callee), media, (c) => c.wall0 >= since - 50) };
  const hooks = await callee.evaluate(() => JSON.parse(JSON.stringify({ ring: window.__cm.ring, inc: window.__cm.inc, ready: window.__cm.ready, firstUiAt: window.__cm.firstUiAt })));
  const startRes = await caller.evaluate(() => window.__cmStart).catch(() => null);
  const pcStates = {
    caller: await caller.evaluate((t) => (window.__pcStates || []).filter((x) => x.at >= t).map((x) => x.cs), since).catch(() => []),
    callee: await callee.evaluate((t) => (window.__pcStates || []).filter((x) => x.at >= t).map((x) => x.cs), since).catch(() => []),
  };
  await endCall(caller, media);
  const cleaned = await waitIdle([caller, callee], media, 15000);
  if (!cleaned) await forceIdle([caller, callee], media);
  await sleep(GAP_MS);
  const { ra, rb } = res;
  const clickAbs = abs(ra, 'CALL_CLICK');
  const remoteUi = abs(rb, 'CALL_REMOTE_RING_UI_SHOWN') ?? (hooks.firstUiAt[media] || null);
  const row = {
    media, offerOk, accept, start: startRes, pcStates, connected: !!(ra && rb && ra.marks.CALL_CONNECTED != null && rb.marks.CALL_CONNECTED != null), cleaned,
    pcConnectedBoth: !!(ra && rb && ra.marks.PC_CONNECTED != null && rb.marks.PC_CONNECTED != null),
    ringHooks: hooks.ring[media], incomingHooks: hooks.inc[media], offerReadyHooks: hooks.ready[media],
    CALL_CLICK_TO_RING_PUBLISH_START: dm(ra, 'CALL_CLICK', 'CALL_RING_PUBLISH_START'),
    CALL_CLICK_TO_RING_PUBLISH: dm(ra, 'CALL_CLICK', 'CALL_RING_FIRST_RELAY_ACK'),
    CALL_CLICK_TO_REMOTE_RING_SIGNAL: dAbs(clickAbs, abs(rb, 'CALL_REMOTE_RING_SIGNAL_RX')),
    CALL_CLICK_TO_REMOTE_RING: dAbs(clickAbs, remoteUi),
    CALL_GUM: dm(ra, 'GUM_START', 'GUM_READY'),
    CALL_CLICK_TO_OFFER_PUBLISH: dm(ra, 'CALL_CLICK', 'OFFER_FIRST_RELAY_ACK'),
    CALL_CLICK_TO_OFFER_REMOTE_RX: dAbs(clickAbs, abs(rb, 'OFFER_REMOTE_RX')),
    CALL_ACCEPT_TO_ANSWER_PUBLISHED: dm(rb, 'ANSWER_START', 'ANSWER_PUBLISHED'),
    CALL_ACCEPT_TO_ANSWER_REMOTE_RX: dAbs(abs(rb, 'ANSWER_START'), abs(ra, 'ANSWER_REMOTE_RX')),
    CALL_ACCEPT_TO_ICE_CONNECTED: dm(rb, 'ANSWER_START', 'ICE_CONNECTED'),
    CALL_ACCEPT_TO_CONNECTED_CALLEE: dm(rb, 'ANSWER_START', 'CALL_CONNECTED'),
    CALL_ACCEPT_TO_CONNECTED: dAbs(abs(rb, 'ANSWER_START'), Math.max(abs(rb, 'CALL_CONNECTED') ?? -Infinity, abs(ra, 'CALL_CONNECTED') ?? -Infinity, abs(rb, 'PC_CONNECTED') ?? -Infinity, abs(ra, 'PC_CONNECTED') ?? -Infinity)),
    CALL_ACCEPT_TO_PC_CONNECTED_CALLEE: dm(rb, 'ANSWER_START', 'PC_CONNECTED'),
    CALL_CLICK_TO_CONNECTED: ra && ra.marks.CALL_CONNECTED != null ? Math.max(ra.marks.CALL_CONNECTED, ra.marks.PC_CONNECTED ?? 0) - ra.marks.CALL_CLICK : null,
    ringSignalRx: !!(rb && rb.marks && rb.marks.CALL_REMOTE_RING_SIGNAL_RX != null),
    callerMarkValues: ra ? ra.marks : null, calleeMarkValues: rb ? rb.marks : null,
    ringBeforeGumReady: ra && ra.marks.CALL_RING_PUBLISH_START != null && ra.marks.GUM_READY != null ? ra.marks.CALL_RING_PUBLISH_START <= ra.marks.GUM_READY : null,
    remoteRingBeforeCallerGumReady: remoteUi != null && abs(ra, 'GUM_READY') != null ? remoteUi < abs(ra, 'GUM_READY') : null,
    callerMarks: ra ? Object.keys(ra.marks) : [], calleeMarks: rb ? Object.keys(rb.marks) : [],
    calleeLog: calleeSkips(callee, since),
    callerTimeline: process.env.CM_TIMELINE === '1'
      ? (LOGS[PAGE_LABEL.get(caller)] || []).filter((l) => l.at >= since && l.at <= since + 12000 && !/^CALL_SEND_|^CALL_SIGNAL_SENT|^CALL_RELAY_OK/.test(l.t)).map((l) => (l.at - since) + ' ' + l.t.slice(0, 90)).slice(0, 80)
      : undefined,
    callerInbound1059: process.env.CM_TIMELINE === '1'
      ? (TAPS[PAGE_LABEL.get(caller)]?.inbound || []).filter((x) => x.at >= since && x.at <= since + 12000).map((x) => (x.at - since) + ' ' + x.host + ' ' + x.sub + ' ' + x.id).slice(0, 60)
      : undefined,
  };
  if (!Number.isFinite(row.CALL_ACCEPT_TO_CONNECTED)) row.CALL_ACCEPT_TO_CONNECTED = null;
  return row;
}

// Ring-only trial: caller clicks, callee must show ringing UI; caller cancels.
async function ringTrial(caller, callee, media, peer, timeoutMs = 12000) {
  await resetHooks(callee);
  const since = Date.now();
  await startCall(caller, media, peer);
  const shown = await callee.waitForFunction((m) => window.__cm.ring[m] > 0 || window.__cm.inc[m] > 0, media, { polling: 50, timeout: timeoutMs }).then(() => true).catch(() => false);
  await sleep(1200);
  const hooks = await callee.evaluate(() => JSON.parse(JSON.stringify({ ring: window.__cm.ring, inc: window.__cm.inc, firstUiAt: window.__cm.firstUiAt })));
  const ra = lastRec(await perfSnap(caller), media, (c) => c.wall0 >= since - 50 && c.marks.CALL_CLICK != null);
  await endCall(caller, media);
  const cleaned = await waitIdle([caller, callee], media, 15000);
  if (!cleaned) await forceIdle([caller, callee], media);
  await sleep(GAP_MS);
  const clickAbs = abs(ra, 'CALL_CLICK');
  const dup = media === 'voice' ? hooks.ring.voice > 1 || (hooks.ring.voice >= 1 && hooks.inc.voice >= 1) || hooks.inc.voice > 1 : hooks.ring.video > 1 || hooks.inc.video > 1;
  return {
    media, shown, duplicate: dup, cleaned, calleeLog: calleeSkips(callee, since),
    clickToRemoteRing: shown && clickAbs != null && hooks.firstUiAt[media] ? hooks.firstUiAt[media] - clickAbs : null,
    clickToRingPublish: dm(ra, 'CALL_CLICK', 'CALL_RING_FIRST_RELAY_ACK'),
  };
}

// ---------------------------------------------------------------- main
async function main() {
  const report = { gate: 'PACKAGE899_REAL_BROWSER_CALL_MATRIX', ts: new Date().toISOString(), root: ROOT, status: 'FAIL', config: { N, RING_N, IDLE_MS, GAP_MS, MEDIA }, gates: {}, metrics: {}, calls: [], rings: [], failover: [], churn: {}, subscriptions: {}, security: {} };
  const server = await serve(ROOT);
  const base = `http://127.0.0.1:${server.address().port}/videos.html`;
  const kA = hex(generateSecretKey());
  const kB = hex(generateSecretKey());
  const pubA = getPublicKey(utils.hexToBytes(kA));
  const pubB = getPublicKey(utils.hexToBytes(kB));
  SECRET_PATTERNS.push(kA, kB);
  const browser = await chromium.launch({ headless: false, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctxA = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 900, height: 700 } });
  const ctxB = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 900, height: 700 } });
  const tapA = installWsTap(ctxA, 'A');
  const tapB = installWsTap(ctxB, 'B');
  TAPS.A = tapA;
  TAPS.B = tapB;
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const logs = LOGS;
  PAGE_LABEL.set(pageA, 'A');
  PAGE_LABEL.set(pageB, 'B');
  const secretLog = [];
  const keep = /^(CALL_|SECURE_|Incoming voice ignored|Incoming video ignored|Voice call|Video call|RELAY_)/;
  for (const [label, page] of [['A', pageA], ['B', pageB]]) {
    page.on('console', (m) => {
      const t = m.text();
      if (t.includes(kA) || t.includes(kB) || /nsec1[02-9ac-hj-np-z]{20,}/.test(t) || /a=fingerprint:/.test(t)) secretLog.push(label);
      if (keep.test(t)) logs[label].push({ at: Date.now(), t: t.slice(0, 200) });
    });
  }
  const countLogs = (label, re, from = 0, to = Infinity) => logs[label].filter((l) => l.at >= from && l.at <= to && re.test(l.t)).length;
  const churnWindow = (from, to) => {
    const out = {};
    for (const L of ['A', 'B']) {
      out[L] = {
        CALL_RECOVERY_QUERY_COUNT: countLogs(L, /^CALL_WEB_RECOVERY_QUERY/, from, to),
        CALL_RECOVERY_TICK_COUNT: countLogs(L, /^CALL_WEB_RECOVERY_TICK/, from, to),
        CALL_RECOVERY_EMPTY_COUNT: countLogs(L, /^CALL_WEB_RECOVERY_EMPTY/, from, to),
        CALL_RECOVERY_SUBSCRIBE_COUNT: countLogs(L, /^CALL_SECURE_SUBSCRIBE_START/, from, to),
      };
    }
    out.minutes = Math.round(((to - from) / 60000) * 100) / 100;
    return out;
  };
  try {
    const a = await boot(pageA, base, kA, 'A');
    const b = await boot(pageB, base, kB, 'B');
    report.package = a.pkg || b.pkg;
    report.identities = a.pub === pubA && b.pub === pubB;
    report.instrumentation = { perfA: a.perf, perfB: b.perf, relayHealth: a.health && b.health };
    report.uiHooksPresent = { A: await hook(pageA), B: await hook(pageB) };

    // Phase M/N: idle window — subscription fan-out and recovery churn with no call in progress.
    const idleFrom = Date.now();
    await sleep(IDLE_MS);
    report.churn.idle = churnWindow(idleFrom, Date.now());
    report.subscriptions.idle = {
      A_25050_byHost: tapA.activeSubsByKind(25050), B_25050_byHost: tapB.activeSubsByKind(25050),
      A_1059_byHost: tapA.activeSubsByKind(1059), B_1059_byHost: tapB.activeSubsByKind(1059),
      A_legacyStats: await pageA.evaluate(() => window.NostrApp.CallSignalE2ee?.getLegacySubscriptionStats?.() || null),
      B_legacyStats: await pageB.evaluate(() => window.NostrApp.CallSignalE2ee?.getLegacySubscriptionStats?.() || null),
    };

    // Phase I: foreground matrix.
    const matrixFrom = Date.now();
    for (const media of MEDIA) {
      for (const [dir, caller, callee, peer] of [['A2B', pageA, pageB, pubB], ['B2A', pageB, pageA, pubA]]) {
        for (let i = 0; i < N; i++) {
          const row = await fullCall(caller, callee, media, peer);
          row.dir = dir; row.i = i;
          report.calls.push(row);
          console.log(`CALL ${media} ${dir} #${i} connected=${row.connected} ring=${row.CALL_CLICK_TO_RING_PUBLISH} remoteRing=${row.CALL_CLICK_TO_REMOTE_RING} a2c=${row.CALL_ACCEPT_TO_CONNECTED} c2c=${row.CALL_CLICK_TO_CONNECTED}`);
        }
      }
    }
    report.churn.matrix = churnWindow(matrixFrom, Date.now());
    report.churn.matrixCalls = report.calls.length;

    // Phase O: video accepted+ended then voice from the same peer must ring (not "already in call").
    const staleFrom = Date.now();
    const stale = [];
    for (let i = 0; i < 3; i++) {
      stale.push(await fullCall(pageA, pageB, 'video', pubB));
      stale.push(await fullCall(pageA, pageB, 'voice', pubB));
    }
    report.staleState = {
      rows: stale.map((r) => ({ media: r.media, connected: r.connected, ringHooks: r.ringHooks, incomingHooks: r.incomingHooks })),
      ignoredAlreadyInCall: countLogs('B', /Incoming (voice|video) ignored/, staleFrom),
      ringBusySkips: countLogs('B', /^CALL_SIGNAL_SKIP ring_busy/, staleFrom),
    };

    // Phase F: ring must not wait for getUserMedia — caller GUM artificially delayed by 2.5 s.
    const gumRows = [];
    await pageA.evaluate(() => {
      const md = navigator.mediaDevices;
      window.__origGum = md.getUserMedia.bind(md);
      md.getUserMedia = (c) => new Promise((r) => setTimeout(r, 2500)).then(() => window.__origGum(c));
    });
    for (const media of MEDIA) for (let i = 0; i < 2; i++) gumRows.push(await fullCall(pageA, pageB, media, pubB));
    await pageA.evaluate(() => { navigator.mediaDevices.getUserMedia = window.__origGum; });
    report.gumDelayed = gumRows.map((r) => ({ callerMarkValues: r.callerMarkValues, calleeMarkValues: r.calleeMarkValues, calleeLog: r.calleeLog, media: r.media, connected: r.connected, gum: r.CALL_GUM, remoteRing: r.CALL_CLICK_TO_REMOTE_RING, ringBeforeGumReady: r.ringBeforeGumReady, remoteRingBeforeCallerGumReady: r.remoteRingBeforeCallerGumReady }));

    // Phase K: ring reliability (ring-only, alternating direction and media).
    for (let i = 0; i < RING_N; i++) {
      const media = MEDIA[i % MEDIA.length];
      const [caller, callee, peer, dir] = i % 2 === 0 ? [pageA, pageB, pubB, 'A2B'] : [pageB, pageA, pubA, 'B2A'];
      const r = await ringTrial(caller, callee, media, peer);
      r.dir = dir;
      report.rings.push(r);
    }

    // Phase L: relay failure on the caller side.
    if (!SKIP_FAILOVER) {
      const hs = await pageA.evaluate(() => (window.NostrApp.RelayHealth ? window.NostrApp.RelayHealth.snapshot() : null));
      report.relayHealthBeforeFailover = hs;
      const relays = await pageA.evaluate(() => (window.NostrApp.CallSignalE2ee?.getCallSignalRelays?.() || []));
      report.callRelays = relays;
      const host = (u) => { try { return new URL(u).host; } catch (_) { return ''; } };
      // Each scenario starts from a clean health state; primary/secondary = current deliverable order.
      const order = async () => {
        await pageA.evaluate(() => window.NostrApp.RelayHealth?.reset?.());
        return pageA.evaluate(() => {
          const App = window.NostrApp;
          const api = App.CallSignalE2ee;
          const list = api.getCallSignalRelays();
          const sel = App.RelayHealth ? App.RelayHealth.select(list, { min: 2, capable: (u) => !api.isDeliveryGatedRelay?.(u) }) : list;
          return sel.filter((u) => !api.isDeliveryGatedRelay?.(u));
        });
      };
      const scenarios = [
        { name: 'PRIMARY_DOWN', mode: 'down', pick: 0 },
        { name: 'SECONDARY_DOWN', mode: 'down', pick: 1 },
        { name: 'NIP42_RELAY_DOWN', mode: 'down', fixedHost: 'nostr-02.uid.ovh' },
        { name: 'SLOW_RELAY', mode: 'slow', pick: 0, delayMs: 6000 },
        { name: 'GIFTWRAP_REJECTED', mode: 'reject', pick: 0 },
        { name: 'AUTH_REQUIRED_GIFTWRAP', mode: 'authReject', pick: 1 },
        { name: 'DISCONNECT_AFTER_PUBLISH', mode: 'dropAfterPublish', pick: 0 },
      ];
      for (const sc0 of scenarios) {
        const ord = (await order()).map(host).filter(Boolean);
        const sc = { ...sc0, host: sc0.fixedHost || ord[sc0.pick] || ord[0] || 'relay.snort.social' };
        report.failoverOrder = report.failoverOrder || {};
        report.failoverOrder[sc.name] = ord;
        tapA.setFault(sc);
        await sleep(1500);
        const from = Date.now();
        const gwBefore = tapA.eventsByKind[1059] || 0;
        const hostBefore = Object.fromEntries(Object.entries(tapA.eventsByHostKind).map(([h, k]) => [h, k[1059] || 0]));
        const rings = [];
        for (let i = 0; i < 3; i++) rings.push(await ringTrial(pageA, pageB, 'voice', pubB));
        const full = await fullCall(pageA, pageB, 'voice', pubB);
        const perfA = await perfSnap(pageA);
        const health = await pageA.evaluate((h) => { const s = window.NostrApp.RelayHealth?.snapshot?.(); if (!s) return null; const k = Object.keys(s).find((x) => x.includes(h)); return k ? s[k] : s; }, sc.host);
        const signals = (tapA.eventsByKind[1059] || 0) - gwBefore;
        const perHost = Object.fromEntries(Object.entries(tapA.eventsByHostKind).map(([h, k]) => [h, (k[1059] || 0) - (hostBefore[h] || 0)]));
        const othersMax = Math.max(0, ...Object.entries(perHost).filter(([h]) => h !== sc.host).map(([, n]) => n));
        report.failover.push({
          name: sc.name, host: sc.host, mode: sc.mode,
          ringDelivered: rings.filter((r) => r.shown).length, ringTrials: rings.length,
          clickToRingPublish: rings.map((r) => r.clickToRingPublish), clickToRemoteRing: rings.map((r) => r.clickToRemoteRing),
          fullConnected: full.connected, fullAcceptToConnected: full.CALL_ACCEPT_TO_CONNECTED,
          giftWrapsToFaultedRelay: tapA.faultEvents[sc.name] || 0, giftWrapFramesTotal: signals, giftWrapsPerHost: perHost, othersMax,
          degradedLogs: countLogs('A', /^CALL_RELAY_DEGRADED/, from), authRequiredLogs: countLogs('A', /^CALL_RELAY_AUTH_REQUIRED/, from),
          loopLagMaxMs: perfA?.main?.loopLagMaxMs ?? null, longTaskMaxMs: perfA?.main?.longTaskMaxMs ?? null,
          health,
        });
        console.log('FAILOVER', sc.name, JSON.stringify(report.failover[report.failover.length - 1]).slice(0, 300));
        tapA.setFault(null);
        await sleep(2000);
      }
    }

    // ---------------------------------------------------------------- aggregate
    const ok = report.calls.filter((r) => r.connected);
    const pick = (rows, key) => rows.map((r) => r[key]);
    const byMedia = (m) => ok.filter((r) => r.media === m);
    const keys = ['CALL_CLICK_TO_RING_PUBLISH_START', 'CALL_CLICK_TO_RING_PUBLISH', 'CALL_CLICK_TO_REMOTE_RING_SIGNAL', 'CALL_CLICK_TO_REMOTE_RING', 'CALL_GUM', 'CALL_CLICK_TO_OFFER_PUBLISH', 'CALL_CLICK_TO_OFFER_REMOTE_RX', 'CALL_ACCEPT_TO_ANSWER_PUBLISHED', 'CALL_ACCEPT_TO_ANSWER_REMOTE_RX', 'CALL_ACCEPT_TO_ICE_CONNECTED', 'CALL_ACCEPT_TO_CONNECTED_CALLEE', 'CALL_ACCEPT_TO_PC_CONNECTED_CALLEE', 'CALL_ACCEPT_TO_CONNECTED', 'CALL_CLICK_TO_CONNECTED'];
    for (const m of MEDIA) {
      report.metrics[m] = {};
      for (const k of keys) report.metrics[m][k] = stat(pick(byMedia(m), k));
      for (const dir of ['A2B', 'B2A']) report.metrics[m][dir] = { attempted: report.calls.filter((r) => r.media === m && r.dir === dir).length, connected: byMedia(m).filter((r) => r.dir === dir).length };
    }
    report.metrics.all = {};
    for (const k of keys) report.metrics.all[k] = stat(pick(ok, k));

    const REQUIRED_MARKS_CALLER = ['CALL_CLICK', 'CALL_SESSION_CREATED', 'CALL_RING_BUILD_START', 'CALL_RING_PUBLISH_START', 'CALL_RING_FIRST_RELAY_ACK', 'GUM_START', 'GUM_READY', 'OFFER_BUILD_START', 'OFFER_PUBLISH_START', 'OFFER_FIRST_RELAY_ACK', 'ANSWER_REMOTE_RX', 'ICE_CHECKING', 'ICE_CONNECTED', 'PC_CONNECTED', 'CALL_CONNECTED'];
    const REQUIRED_MARKS_CALLEE = ['CALL_REMOTE_RING_SIGNAL_RX', 'CALL_REMOTE_RING_UI_SHOWN', 'OFFER_REMOTE_RX', 'ANSWER_START', 'ANSWER_PUBLISHED', 'ICE_CHECKING', 'ICE_CONNECTED', 'PC_CONNECTED', 'CALL_CONNECTED'];
    // Instrumented = every mark is emitted for each media; per-call coverage is reported (a lost ring
    // shows up as missing CALL_REMOTE_RING_SIGNAL_RX and is counted by the reliability metrics instead).
    const coverage = {};
    const missing = [];
    for (const m of MEDIA) {
      const rows = byMedia(m);
      for (const [side, list, key] of [['caller', REQUIRED_MARKS_CALLER, 'callerMarks'], ['callee', REQUIRED_MARKS_CALLEE, 'calleeMarks']]) {
        for (const x of list) {
          const hit = rows.filter((r) => r[key].includes(x)).length;
          coverage[m + ':' + side + ':' + x] = rows.length ? Math.round((hit / rows.length) * 1000) / 10 : 0;
          if (!hit) missing.push(m + ':' + side + ':' + x);
        }
      }
    }
    report.markCoverage = coverage;
    report.missingMarks = missing;

    const ringsAll = [
      ...report.rings.map((r) => ({ shown: r.shown, duplicate: r.duplicate })),
      ...report.calls.map((r) => ({ shown: r.ringHooks + r.incomingHooks > 0, duplicate: r.media === 'voice' ? r.ringHooks > 1 || r.incomingHooks > 1 || (r.ringHooks >= 1 && r.incomingHooks >= 1) : r.ringHooks > 1 || r.incomingHooks > 1 })),
    ];
    const ringOk = ringsAll.filter((r) => r.shown).length;
    report.metrics.ring = {
      trials: ringsAll.length,
      CALL_RING_DELIVERY_SUCCESS_RATE: ringsAll.length ? Math.round((ringOk / ringsAll.length) * 10000) / 100 : null,
      CALL_RING_DUPLICATE_RATE: ringsAll.length ? Math.round((ringsAll.filter((r) => r.duplicate).length / ringsAll.length) * 10000) / 100 : null,
      CALL_RING_MISSED_RATE: ringsAll.length ? Math.round(((ringsAll.length - ringOk) / ringsAll.length) * 10000) / 100 : null,
      ringOnlyClickToRemoteRing: stat(report.rings.map((r) => r.clickToRemoteRing)),
      RING_SIGNAL_RX_RATE: ok.length ? Math.round((ok.filter((r) => r.ringSignalRx).length / ok.length) * 10000) / 100 : null,
    };

    const gwPub = [...tapA.giftWrapPubkeys, ...tapB.giftWrapPubkeys];
    report.security = {
      giftWrapsPublished: (tapA.eventsByKind[1059] || 0) + (tapB.eventsByKind[1059] || 0),
      legacy25050Published: (tapA.eventsByKind[25050] || 0) + (tapB.eventsByKind[25050] || 0),
      giftWrapOuterKeyIsIdentity: gwPub.includes(pubA) || gwPub.includes(pubB),
      privacyViolations: [...tapA.privacyViolations, ...tapB.privacyViolations].slice(0, 20),
      secretsInConsole: secretLog.length,
      okFalseReasons: [...new Set([...tapA.okFalse, ...tapB.okFalse].map((x) => x.host + ':' + x.reason))].slice(0, 30),
      authChallenges: { A: tapA.authChallenges, B: tapB.authChallenges },
    };

    const M = report.metrics;
    const all = M.all;
    const connectedRate = report.calls.length ? ok.length / report.calls.length : 0;
    report.metrics.connectedRate = Math.round(connectedRate * 10000) / 100;
    report.metrics.pcConnectedBothRate = report.calls.length ? Math.round((report.calls.filter((r) => r.pcConnectedBoth).length / report.calls.length) * 10000) / 100 : null;
    const fo = report.failover;
    const subsOk = [report.subscriptions.idle.A_25050_byHost, report.subscriptions.idle.B_25050_byHost].every((m) => Object.values(m).every((n) => n <= 1));
    report.gates = {
      CALL_LATENCY_INSTRUMENTATION_GATE: ok.length > 0 && report.missingMarks.length === 0 && secretLog.length === 0 ? 'PASS' : 'FAIL',
      CALL_RING_INDEPENDENT_OF_GUM_GATE: report.gumDelayed.length > 0 && report.gumDelayed.every((r) => r.ringBeforeGumReady === true && r.remoteRingBeforeCallerGumReady === true) ? 'PASS' : 'FAIL',
      CALL_RING_PUBLISHED_P95_LT_300: all.CALL_CLICK_TO_RING_PUBLISH.p95 != null && all.CALL_CLICK_TO_RING_PUBLISH.p95 < 300 ? 'PASS' : 'FAIL',
      CALL_REMOTE_RING_P95_LT_1500: all.CALL_CLICK_TO_REMOTE_RING.p95 != null && all.CALL_CLICK_TO_REMOTE_RING.p95 < 1500 ? 'PASS' : 'FAIL',
      CALL_ACCEPT_TO_CONNECTED_P95_LT_2000: all.CALL_ACCEPT_TO_CONNECTED.p95 != null && all.CALL_ACCEPT_TO_CONNECTED.p95 < 2000 ? 'PASS' : 'FAIL',
      CALL_RING_RELIABILITY_GATE: M.ring.CALL_RING_DELIVERY_SUCCESS_RATE != null && M.ring.CALL_RING_DELIVERY_SUCCESS_RATE >= 99 && M.ring.CALL_RING_DUPLICATE_RATE === 0 ? 'PASS' : 'FAIL',
      CALL_CONNECT_RATE_GATE: connectedRate >= 0.99 ? 'PASS' : 'FAIL',
      CALL_RELAY_FAILOVER_GATE: SKIP_FAILOVER ? 'SKIPPED' : fo.length > 0 && fo.every((f) => f.ringDelivered === f.ringTrials && f.fullConnected && f.giftWrapsToFaultedRelay <= f.othersMax + 2 && (f.loopLagMaxMs == null || f.loopLagMaxMs < 1000))
        && fo.filter((f) => f.mode !== 'down').every((f) => f.giftWrapsToFaultedRelay > 0) ? 'PASS' : 'FAIL',
      CALL_DUPLICATE_SUBSCRIPTION_GATE: subsOk ? 'PASS' : 'FAIL',
      CALL_STALE_SESSION_GATE: report.staleState.rows.every((r) => r.connected) && report.staleState.ignoredAlreadyInCall === 0 ? 'PASS' : 'FAIL',
      CALL_1059_E2EE_GATE: report.security.giftWrapsPublished > 0 && report.security.legacy25050Published === 0 && !report.security.giftWrapOuterKeyIsIdentity && report.security.privacyViolations.length === 0 ? 'PASS' : 'FAIL',
    };
    report.gates.CALL_FOREGROUND_LATENCY_GATE = ['CALL_RING_PUBLISHED_P95_LT_300', 'CALL_REMOTE_RING_P95_LT_1500', 'CALL_ACCEPT_TO_CONNECTED_P95_LT_2000'].every((g) => report.gates[g] === 'PASS') ? 'PASS' : 'FAIL';
    report.status = Object.values(report.gates).every((g) => g === 'PASS' || g === 'SKIPPED') ? 'PASS' : 'FAIL';
  } catch (e) {
    report.error = String((e && e.stack) || e).slice(0, 1200);
  } finally {
    report.logTail = { A: logs.A.slice(-40).map((l) => l.t), B: logs.B.slice(-40).map((l) => l.t) };
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    await browser.close().catch(() => {});
    server.close();
  }
  console.log('METRICS', JSON.stringify(report.metrics.all));
  console.log('RING', JSON.stringify(report.metrics.ring));
  console.log('GATES', JSON.stringify(report.gates));
  console.log('STATUS', report.status, report.error ? report.error.slice(0, 300) : '');
  process.exit(report.status === 'PASS' ? 0 : 1);
}

main();
