#!/usr/bin/env node
/**
 * Prove call-cold boot order, identity not deferred, release/init-once, APK 1.0.124 Web compat.
 * Run: node qa/call-cold-boot-order-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}
function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function staticOrder() {
  const html = read('videos.html');
  const coldIdx = html.indexOf('call-cold-boot.js');
  const mediaIdx = html.indexOf('media-cache.js');
  const p2pIdx = html.indexOf('chat-p2p-datachannel.js');
  const videosJsIdx = html.indexOf('videos.js?');
  const wtLoaderIdx = html.indexOf('loadWebTorrentStackWhenAllowed');
  const staticWtCdn = /<script[^>]+webtorrent\.min\.js/.test(html);

  record('call-cold-boot script before media-cache',
    coldIdx > 0 && mediaIdx > coldIdx);
  record('call-cold-boot before videos.js and p2p',
    coldIdx > 0 && videosJsIdx > coldIdx && p2pIdx > coldIdx);
  record('no static early WebTorrent CDN script',
    !staticWtCdn && wtLoaderIdx > coldIdx);
  record('WebTorrent loader defers when cold',
    /shouldDefer\('webtorrent'\)/.test(html)
    && /cold\.defer\('webtorrent'/.test(html));

  const boot = read('call-cold-boot.js');
  record('PRIORITY_ON uses source=',
    /CALL_COLD_BOOT_PRIORITY_ON source=/.test(boot));
  record('defer-once by subsystem name',
    /deferredNames\.has/.test(boot) && /markEntry/.test(boot));

  const keys = read('keys.js');
  record('identity bootstrap marker not deferred',
    /CALL_REQUIRED_IDENTITY_BOOTSTRAP ok=1 deferred=0/.test(keys));
  record('keys.js is not behind SosCallColdBoot.defer',
    !/SosCallColdBoot/.test(keys));

  record('full-chat-history deferred (not identity)',
    /full-chat-history-bootstrap/.test(html)
    && !/cold\.defer\('chat-bootstrap'/.test(html));

  const media = read('media-cache.js');
  const wt = read('webtorrent-transfer.js');
  const p2p = read('chat-p2p-datachannel.js');
  const videos = read('videos.js');
  record('subsystem entry after defer decision (no side effect first)',
    /shouldDefer\('media-cache-scan'\)[\s\S]{0,200}return/.test(media)
    && /shouldDefer\('webtorrent'\)[\s\S]{0,300}return null/.test(wt)
    && /shouldDefer\('p2p-dc'\)[\s\S]{0,200}return/.test(p2p)
    && /feed-hydrate/.test(videos));
  record('CALL_COLD_SUBSYSTEM_ENTRY on real start',
    /markEntry\('media-cache-scan'\)/.test(media)
    && /markEntry\('webtorrent'\)/.test(wt)
    && /markEntry\('p2p-dc'\)/.test(p2p));

  const appVer = JSON.parse(read('app-version.json'));
  record('security flags unchanged',
    appVer.minSecureChatEpoch === 2
    && appVer.e2eeSendRequired === true
    && appVer.mediaServerE2eeRequired === true
    && appVer.callSignalGiftWrapRequired === true);

  const voiceUi = read('chat-voice-call-ui.js');
  const videoUi = read('chat-video-call-ui.js');
  const deeplink = read('chat-deeplink.js');
  record('APK 1.0.124 bridge APIs still feature-detected',
    /typeof bridge\.isIncomingCallAnsweredForPeer === 'function'/.test(voiceUi)
    && /typeof bridge\.notifySoCallCallUiReady === 'function'/.test(voiceUi)
    && /typeof bridge\.isIncomingCallAnsweredForPeer === 'function'/.test(deeplink)
    && /typeof bridge\.notifySoCallCallUiReady === 'function'/.test(videoUi));
  record('no new Web dependency on APK>1.0.124-only API',
    !/holdSoCallSplashForCall/.test(voiceUi + videoUi + deeplink)
    && !/CALL_COLD_NAV_SKIP/.test(voiceUi + videoUi + deeplink)
    && /typeof bridge\.isIncomingCallAnsweredForPeer === 'function'/.test(voiceUi)
    && /typeof bridge\.notifySoCallCallUiReady === 'function'/.test(voiceUi));
}

function runtimeOrder() {
  const logs = [];
  const ctx = {
    console: {
      log: (...a) => logs.push(a.map(String).join(' ')),
      warn: (...a) => logs.push(a.map(String).join(' ')),
      error: (...a) => logs.push(a.map(String).join(' ')),
    },
    URLSearchParams,
    window: null,
    document: {
      documentElement: {
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        getAttribute(k) { return this.attrs[k] || null; },
      },
      body: { classList: { contains() { return false; }, add() {}, remove() {} } },
      head: { appendChild() {} },
      createElement() {
        return { src: '', onload: null, setAttribute() {} };
      },
    },
    location: { search: '?incomingCall=voice' },
    NostrApp: {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('call-cold-boot.js'), ctx, { filename: 'call-cold-boot.js' });

  const cold = ctx.SosCallColdBoot;
  record('runtime PRIORITY_ON source=url before subsystems',
    cold.isActive()
    && logs.some((l) => l.includes('CALL_COLD_BOOT_PRIORITY_ON source=url')));

  let wtStarts = 0;
  let mediaStarts = 0;
  let p2pStarts = 0;
  cold.defer('webtorrent', () => {
    if (cold.markEntry('webtorrent')) wtStarts += 1;
  });
  cold.defer('webtorrent', () => {
    if (cold.markEntry('webtorrent')) wtStarts += 1;
  });
  cold.defer('media-cache-scan', () => {
    if (cold.markEntry('media-cache-scan')) mediaStarts += 1;
  });
  cold.defer('p2p-dc', () => {
    if (cold.markEntry('p2p-dc')) p2pStarts += 1;
  });

  record('runtime defer once (duplicate webtorrent ignored)',
    logs.filter((l) => l.includes('CALL_COLD_BOOT_DEFER subsystem=webtorrent')).length === 1
    && wtStarts === 0);

  // Simulate identity available while cold (keys.js path — not deferred)
  ctx.NostrApp.publicKey = 'aa'.repeat(32);
  ctx.NostrApp.privateKey = 'bb'.repeat(32);
  record('runtime identity available while cold active',
    cold.isActive()
    && typeof ctx.NostrApp.publicKey === 'string'
    && typeof ctx.NostrApp.privateKey === 'string');

  cold.release('connected');
  record('runtime release connected starts deferred once each',
    logs.some((l) => l.includes('CALL_COLD_BOOT_RELEASE reason=connected'))
    && wtStarts === 1
    && mediaStarts === 1
    && p2pStarts === 1
    && logs.filter((l) => l.includes('CALL_COLD_SUBSYSTEM_ENTRY subsystem=webtorrent')).length === 1);

  // failure/end path
  const logs2 = [];
  const ctx2 = {
    console: {
      log: (...a) => logs2.push(a.map(String).join(' ')),
      warn: (...a) => logs2.push(a.map(String).join(' ')),
      error: (...a) => logs2.push(a.map(String).join(' ')),
    },
    URLSearchParams,
    window: null,
    document: {
      documentElement: {
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        getAttribute(k) { return this.attrs[k] || null; },
      },
      body: { classList: { contains() { return false; }, add() {}, remove() {} } },
    },
    location: { search: '?incomingCall=video' },
    NostrApp: {},
  };
  ctx2.window = ctx2;
  vm.createContext(ctx2);
  vm.runInContext(read('call-cold-boot.js'), ctx2, { filename: 'call-cold-boot.js' });
  let ended = 0;
  ctx2.SosCallColdBoot.defer('feed-hydrate', () => { ended += 1; });
  ctx2.SosCallColdBoot.release('ended');
  record('runtime release ended drains queue',
    ended === 1 && logs2.some((l) => l.includes('CALL_COLD_BOOT_RELEASE reason=ended')));

  // normal launch unchanged (no incomingCall)
  const logs3 = [];
  const ctx3 = {
    console: {
      log: (...a) => logs3.push(a.map(String).join(' ')),
      warn: (...a) => logs3.push(a.map(String).join(' ')),
      error: (...a) => logs3.push(a.map(String).join(' ')),
    },
    URLSearchParams,
    window: null,
    document: {
      documentElement: {
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        getAttribute(k) { return this.attrs[k] || null; },
      },
      body: { classList: { contains() { return false; }, add() {}, remove() {} } },
    },
    location: { search: '?shell=124' },
    NostrApp: {},
  };
  ctx3.window = ctx3;
  vm.createContext(ctx3);
  vm.runInContext(read('call-cold-boot.js'), ctx3, { filename: 'call-cold-boot.js' });
  let normalRan = 0;
  const deferred = ctx3.SosCallColdBoot.defer('webtorrent', () => { normalRan += 1; });
  record('ordinary launch does not force cold defer',
    ctx3.SosCallColdBoot.isActive() === false
    && deferred === false
    && normalRan === 1
    && !logs3.some((l) => l.includes('CALL_COLD_BOOT_PRIORITY_ON')));
}

function main() {
  staticOrder();
  runtimeOrder();
  const failed = results.filter((r) => !r.ok);
  console.log('TOTAL ' + results.length + ' FAIL ' + failed.length);
  process.exit(failed.length ? 1 : 0);
}

main();
