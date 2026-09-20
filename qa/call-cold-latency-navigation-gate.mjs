#!/usr/bin/env node
/**
 * Cold Answer latency — duplicate MainActivity nav + call-cold boot priority.
 * Run: node qa/call-cold-latency-navigation-gate.mjs
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

function staticNative() {
  const incoming = read('android-shell/app/src/main/java/com/sos010/app/IncomingCallActivity.kt');
  const main = read('android-shell/app/src/main/java/com/sos010/app/MainActivity.kt');

  const onAnswer = incoming.slice(
    incoming.indexOf('private fun onAnswer()'),
    incoming.indexOf('private fun onDecline()'),
  );
  const startIdx = onAnswer.indexOf('startActivity(launch)');
  const catchIdx = onAnswer.indexOf('catch');
  const bringInCatch = onAnswer.indexOf('bringHostToFront', catchIdx);
  const bringBeforeCatch = onAnswer.indexOf('bringHostToFront', startIdx);
  record('1 successful Answer uses startActivity(launch)',
    /startActivity\(launch\)/.test(onAnswer));
  record('2 successful startActivity → bringHostToFront NOT after try success',
    bringBeforeCatch < 0 || bringBeforeCatch > catchIdx);
  record('3 failed startActivity → bringHostToFront fallback in catch',
    bringInCatch > catchIdx && bringInCatch > 0);

  record('4 CALL_COLD_NAV_SKIP same-answer-load-in-flight',
    /CALL_COLD_NAV_SKIP reason=same-answer-load-in-flight/.test(main)
    && /shouldSkipDuplicateAnswerLoad/.test(main)
    && /coldAnswerLoadInFlight/.test(main));
  record('4b loadWebForCallOrHome tracks gen/url',
    /CALL_COLD_LOAD_URL/.test(main) && /webLoadGeneration/.test(main));
  record('5 different navigation still loads (skip requires same url)',
    /normalizeCallNavUrl/.test(main)
    && /if \(target != inflight\) return false/.test(main));
}

function staticWeb() {
  const bootSrc = read('call-cold-boot.js');
  const voice = read('chat-voice-call.js');
  const video = read('chat-video-call.js');
  const voiceUi = read('chat-voice-call-ui.js');
  const media = read('media-cache.js');
  const wt = read('webtorrent-transfer.js');
  const videos = read('videos.js');
  const html = read('videos.html');
  const p2p = read('chat-p2p-datachannel.js');
  const deeplink = read('chat-deeplink.js');

  record('6 call-cold boot mode markers',
    /CALL_COLD_BOOT_PRIORITY_ON source=/.test(bootSrc)
    && /CALL_COLD_BOOT_DEFER/.test(bootSrc)
    && /CALL_COLD_BOOT_RELEASE/.test(bootSrc));
  record('6b videos.html loads call-cold-boot early',
    /call-cold-boot\.js/.test(html));
  record('6c media-cache/webtorrent/feed/p2p defer',
    /media-cache-scan/.test(media)
    && /webtorrent/.test(wt)
    && /feed-hydrate/.test(videos)
    && /p2p-dc/.test(p2p));
  record('7 connected releases deferred startup',
    /SosCallColdBoot\.release\('connected'\)/.test(voice)
    && /SosCallColdBoot\.release\('connected'\)/.test(video));
  record('8 ended/failed releases deferred startup',
    /release\(options && options\.failed \? 'failed' : 'ended'\)/.test(voice)
    && /release\(options && options\.failed \? 'failed' : 'ended'\)/.test(video));
  record('9 feature-detect answered bridge remains',
    /typeof bridge\.isIncomingCallAnsweredForPeer === 'function'/.test(voiceUi)
    || /typeof bridge\.isIncomingCallAnsweredForPeer === 'function'/.test(deeplink));
  record('10 voice/video GUM markers + single permission path',
    /CALL_ACCEPT_GUM_START/.test(voice)
    && /CALL_ACCEPT_GUM_OK/.test(voice)
    && /CALL_ACCEPT_GUM_START/.test(video)
    && /CALL_ACCEPT_GUM_OK/.test(video)
    && /async function ensureMicReady\(\) \{[\s\S]*?nativeRequestMediaPermissions[\s\S]*?else[\s\S]*?requestMediaPermissions[\s\S]*?\n  \}/.test(voiceUi)
    && (voiceUi.match(/requestMediaPermissions\(false\)/g) || []).length <= 1);
}

function runtimeBoot() {
  const box = { logs: [] };
  const ctx = {
    console: {
      log: (...a) => box.logs.push(a.map(String).join(' ')),
      warn: (...a) => box.logs.push(a.map(String).join(' ')),
      error: (...a) => box.logs.push(a.map(String).join(' ')),
    },
    URLSearchParams,
    window: null,
    document: {
      documentElement: {
        setAttribute() {},
        removeAttribute() {},
        getAttribute() { return null; },
      },
      body: { classList: { contains() { return false; }, add() {}, remove() {} } },
    },
    location: { search: '?incomingCall=voice&shell=124' },
    NostrApp: {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('call-cold-boot.js'), ctx, { filename: 'call-cold-boot.js' });
  const cold = ctx.SosCallColdBoot;
  record('runtime cold detect enables priority',
    cold.isActive() === true
    && box.logs.some((l) => l.includes('CALL_COLD_BOOT_PRIORITY_ON source=url')));

  let ran = 0;
  cold.defer('feed-hydrate', () => { ran += 1; });
  cold.defer('webtorrent', () => { ran += 1; });
  record('runtime defer queues while active',
    cold.shouldDefer('feed-hydrate') === true
    && box.logs.filter((l) => l.includes('CALL_COLD_BOOT_DEFER')).length >= 2
    && ran === 0);

  cold.release('connected');
  record('runtime release connected runs queue',
    ran === 2
    && box.logs.some((l) => l.includes('CALL_COLD_BOOT_RELEASE reason=connected'))
    && cold.isActive() === false);

  const box2 = { logs: [] };
  const ctx2 = {
    console: {
      log: (...a) => box2.logs.push(a.map(String).join(' ')),
      warn: (...a) => box2.logs.push(a.map(String).join(' ')),
      error: (...a) => box2.logs.push(a.map(String).join(' ')),
    },
    URLSearchParams,
    window: null,
    document: {
      documentElement: { setAttribute() {}, removeAttribute() {}, getAttribute() { return null; } },
      body: { classList: { contains() { return false; }, add() {}, remove() {} } },
    },
    location: { search: '?incomingCall=video' },
    NostrApp: {},
  };
  ctx2.window = ctx2;
  vm.createContext(ctx2);
  vm.runInContext(read('call-cold-boot.js'), ctx2, { filename: 'call-cold-boot.js' });
  let endedRan = 0;
  ctx2.SosCallColdBoot.defer('p2p-dc', () => { endedRan += 1; });
  ctx2.SosCallColdBoot.release('ended');
  record('runtime release ended also drains queue',
    endedRan === 1
    && box2.logs.some((l) => l.includes('CALL_COLD_BOOT_RELEASE reason=ended')));
}

function main() {
  staticNative();
  staticWeb();
  runtimeBoot();
  const failed = results.filter((r) => !r.ok);
  console.log('TOTAL ' + results.length + ' FAIL ' + failed.length);
  process.exit(failed.length ? 1 : 0);
}

main();
