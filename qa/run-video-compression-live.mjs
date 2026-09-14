#!/usr/bin/env node
/**
 * Desktop live runner for isolated video compression benchmark.
 * QA only. Requires local serve on :3001 and fixtures in qa/_bench_fixtures.
 */
import { chromium } from 'playwright';

const BASE = process.env.SOS_BENCH_BASE || 'http://localhost:3001';
const PAGE = BASE + '/qa/video-compression-benchmark.html?v=2';

function strip(report) {
  if (!report || typeof report !== 'object') return report;
  const copy = { ...report };
  delete copy.blob;
  return copy;
}

async function fileFrom(page, url, name) {
  return page.evaluate(async ({ url: u, name: n }) => {
    const res = await fetch(u);
    if (!res.ok) throw new Error('fetch-failed ' + u + ' ' + res.status);
    const blob = await res.blob();
    return { size: blob.size, type: blob.type, name: n };
  }, { url, name });
}

async function bench(page, url, name, options) {
  return page.evaluate(async ({ url: u, name: n, options: opts }) => {
    const res = await fetch(u);
    if (!res.ok) throw new Error('fetch-failed ' + u + ' ' + res.status);
    const blob = await res.blob();
    const file = new File([blob], n, { type: blob.type || 'video/mp4' });
    const report = await window.NostrApp.benchmarkVideoCompression(file, opts);
    const copy = { ...report };
    delete copy.blob;
    return copy;
  }, { url, name, options });
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(20 * 60 * 1000);
const out = { page: PAGE, startedAt: new Date().toISOString() };
try {
  await page.goto(PAGE, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.NostrApp && typeof window.NostrApp.proveFFmpegStCompatibility === 'function');

  out.capability = await page.evaluate(() => window.NostrApp.probeVideoCompressionCapabilities());
  out.webcodecs = await page.evaluate(() => window.NostrApp.benchmarkWebCodecsAvailability());
  console.log('CAPABILITY', out.capability.platform.label, 'VE', out.capability.video.VideoEncoder.status, 'SAB', out.capability.isolation.SharedArrayBuffer.status);
  console.log('WEBCODECS full', out.webcodecs.fullTranscodeAvailable, out.webcodecs.blockedReason);

  console.log('GATE...');
  out.gate = await page.evaluate(() => window.NostrApp.proveFFmpegStCompatibility());
  console.log('GATE', out.gate.ok ? 'ok' : out.gate.error, 'first', out.gate.firstBytes, 'second', out.gate.secondBytes);

  if (!out.gate.ok) {
    console.log(JSON.stringify(out, null, 2));
    await browser.close();
    process.exit(1);
  }

  console.log('TEST1 ffmpeg-st ultrafast (720x960 efficient stand-in)...');
  out.test1 = await bench(page, BASE + '/qa/_bench_fixtures/a_720x960_20s.mp4', 'a_720x960_20s.mp4', {
    engine: 'ffmpeg-st',
    preset: 'ultrafast',
    motion: true,
  });
  console.log('TEST1', out.test1.speedRatio, out.test1.savingPct, out.test1.output.audio, out.test1.output.playable, out.test1.source.geometry);

  const presets = ['ultrafast', 'superfast', 'veryfast'];
  out.test2 = {};
  for (const preset of presets) {
    console.log('TEST2 ffmpeg-st', preset, '...');
    out.test2[preset] = await bench(page, BASE + '/qa/_bench_fixtures/b_1080p_20s.mp4', 'b_1080p_20s.mp4', {
      engine: 'ffmpeg-st',
      preset,
      motion: preset === 'ultrafast',
    });
    const r = out.test2[preset];
    console.log('TEST2', preset, r.speedRatio, r.savingPct + '%', r.times.encodeMs, r.output.width + 'x' + r.output.height, r.output.audio, r.performanceBand);
  }

  console.log('TEST3 ffmpeg-st ultrafast (1080p high bitrate 6s)...');
  out.test3 = await bench(page, BASE + '/qa/_bench_fixtures/c_1080p_hi_6s.mp4', 'c_1080p_hi_6s.mp4', {
    engine: 'ffmpeg-st',
    preset: 'ultrafast',
    motion: false,
  });
  console.log('TEST3', out.test3.speedRatio, out.test3.savingPct, out.test3.output.playable, out.test3.output.audio);

  console.log('REF DirectRecorder TEST3...');
  try {
    out.test3direct = await bench(page, BASE + '/qa/_bench_fixtures/c_1080p_hi_6s.mp4', 'c_1080p_hi_6s.mp4', {
      engine: 'direct',
      motion: false,
    });
    console.log('DIRECT', out.test3direct.speedRatio, out.test3direct.savingPct, out.test3direct.output.playable);
  } catch (err) {
    out.test3direct = { error: String(err && err.message || err) };
    console.log('DIRECT FAIL', out.test3direct.error);
  }

  out.finishedAt = new Date().toISOString();
  console.log('JSON_BEGIN');
  console.log(JSON.stringify(strip(out), null, 2));
  console.log('JSON_END');
} catch (err) {
  console.error('LIVE FAIL', err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
