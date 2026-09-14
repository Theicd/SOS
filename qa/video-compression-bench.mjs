#!/usr/bin/env node
/**
 * Deterministic QA for isolated video-compression benchmark helpers.
 * No live chat integration. No network. No encoding.
 * Run: node qa/video-compression-bench.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let passCount = 0;
let failCount = 0;

function record(name, ok, detail = '') {
  if (ok) {
    passCount += 1;
    results.push('PASS ' + name);
    return;
  }
  failCount += 1;
  results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function loadCapability(extra = {}) {
  const windowObj = {
    navigator: { userAgent: 'Mozilla/5.0', maxTouchPoints: 0, platform: 'Win32' },
    document: { documentElement: { getAttribute() { return null; } } },
    NostrApp: {},
    ...extra,
  };
  const ctx = { window: windowObj, globalThis: windowObj, console };
  ctx.window.window = windowObj;
  vm.createContext(ctx);
  vm.runInContext(read('video-compression-capability.js'), ctx);
  vm.runInContext(read('video-compression-benchmark.js'), ctx);
  return windowObj.NostrApp;
}

const compressorSrc = read('video-compressor.js');
const chatUiSrc = read('chat-file-transfer-ui.js');
const p2pSrc = read('chat-p2p-file.js');
const capSrc = read('video-compression-capability.js');
const benchSrc = read('video-compression-benchmark.js');
const videosHtml = read('videos.html');
const indexHtml = read('index.html');

const App = loadCapability();

const gA = App.computeVideoBenchmarkGeometry(720, 960);
record('A 720x960 within target', gA.withinTarget === true && gA.scaled === false && gA.width === 720 && gA.height === 960);

const gB = App.computeVideoBenchmarkGeometry(960, 720);
record('B 960x720 within target', gB.withinTarget === true && gB.scaled === false && gB.width === 960 && gB.height === 720);

const gC = App.computeVideoBenchmarkGeometry(1080, 1920);
record(
  'C 1080x1920 needs downscale',
  gC.scaled === true && gC.withinTarget === false && gC.width === 720 && gC.height === 1280
);

const gD = App.computeVideoBenchmarkGeometry(1920, 1080);
record(
  'D 1920x1080 needs downscale',
  gD.scaled === true && gD.withinTarget === false && gD.width === 1280 && gD.height === 720
);

const gKeep = App.computeVideoBenchmarkGeometry(1280, 720);
record('1280x720 no scale', gKeep.scaled === false && gKeep.withinTarget === true);

const gKeep2 = App.computeVideoBenchmarkGeometry(720, 1280);
record('720x1280 no scale', gKeep2.scaled === false && gKeep2.withinTarget === true);

const noWc = loadCapability();
const wcOff = await noWc.benchmarkWebCodecsAvailability();
record(
  'E WebCodecs unavailable clean result',
  wcOff.supported === false
    && wcOff.fullTranscodeAvailable === false
    && wcOff.blockedReason === 'no-demux-mux'
    && wcOff.VideoEncoder === 'UNSUPPORTED'
);

function FakeVideoEncoder() {}
FakeVideoEncoder.isConfigSupported = async (config) => ({
  supported: true,
  config: { ...config, hardwareAcceleration: 'prefer-hardware' },
});
const withWc = loadCapability({ VideoEncoder: FakeVideoEncoder, VideoDecoder: function VideoDecoder() {}, AudioEncoder: function AudioEncoder() {} });
const wcOn = await withWc.benchmarkWebCodecsAvailability();
record(
  'F WebCodecs available but no muxer',
  wcOn.supported === true
    && wcOn.fullTranscodeAvailable === false
    && wcOn.blockedReason === 'no-demux-mux'
);

record(
  'G benchmark module never auto-run',
  !/App\.benchmarkVideoCompression\s*\(/.test(benchSrc)
    && !/App\.proveFFmpegStCompatibility\s*\(/.test(benchSrc)
    && !/App\.loadFFmpegSTBenchmark\s*\(/.test(benchSrc)
);
record(
  'G capability probe never auto-run',
  !/App\.probeVideoCompressionCapabilities\s*\(/.test(capSrc)
    && !/App\.benchmarkWebCodecsAvailability\s*\(/.test(capSrc)
);
record('G autoRun flag false', /autoRun:\s*false/.test(benchSrc));

record(
  'H production corePath unchanged',
  compressorSrc.includes("corePath: 'https://unpkg.com/@ffmpeg/core@0.10.0/dist/ffmpeg-core.js'")
    && !compressorSrc.includes('@ffmpeg/core-st')
);
record(
  'H loadFFmpeg still pthread core only',
  /async function loadFFmpeg\(/.test(compressorSrc)
    && !/mainName:\s*'main'/.test(compressorSrc)
);
record(
  'H compressVideo still FFmpeg first',
  /async function compressVideo\(/.test(compressorSrc)
    && compressorSrc.indexOf('compressWithFFmpeg(normalized') < compressorSrc.indexOf('compressWithDirectRecorder(normalized')
    && compressorSrc.indexOf('compressWithDirectRecorder(normalized') < compressorSrc.indexOf('compressWithCanvas(normalized')
);
record(
  'H chat still awaits maybeCompressVideoForChat then sendP2PFile',
  /const compressResult = await maybeCompressVideoForChat/.test(chatUiSrc)
    && chatUiSrc.indexOf('await maybeCompressVideoForChat') < chatUiSrc.indexOf('await App.sendP2PFile')
);
record('H chat-p2p-file.js has no benchmark import', !/video-compression-benchmark|videobench/.test(p2pSrc));
record('H chat-file-transfer-ui.js has no benchmark import', !/video-compression-benchmark|videobench/.test(chatUiSrc));
record(
  'H internals export does not change compressVideo signature',
  /__videoCompressionInternals/.test(compressorSrc)
    && /compressWithDirectRecorder,/.test(compressorSrc)
);

record(
  'query flag videos.html',
  videosHtml.includes("get('videobench') !== '1'")
    && videosHtml.includes('video-compression-capability.js')
    && videosHtml.includes('video-compression-benchmark.js')
);
record(
  'query flag index.html',
  indexHtml.includes("get('videobench') !== '1'")
    && indexHtml.includes('video-compression-capability.js')
);
record(
  'no unconditional bench script tags on videos.html',
  !/<script[^>]+src="\.\/video-compression-(capability|benchmark)\.js/.test(videosHtml)
);

const motion = App.__videoCompressionBenchmarkMeta.classifyMotionFromMeanDiff;
record('motion LOW', motion(3) === 'LOW');
record('motion NORMAL', motion(12) === 'NORMAL');
record('motion HIGH', motion(30) === 'HIGH');

const fakeCaps = loadCapability({
  VideoEncoder: FakeVideoEncoder,
  crossOriginIsolated: false,
});
const capReport = fakeCaps.probeVideoCompressionCapabilities();
record('capability stores App.videoCompressionCapabilities', !!fakeCaps.videoCompressionCapabilities && fakeCaps.videoCompressionCapabilities.video.VideoEncoder.status === 'SUPPORTED');
record('isolation reports crossOriginIsolated false', capReport.isolation.crossOriginIsolated.value === false);

console.log(results.join('\n'));
console.log('TOTAL', passCount + '/' + (passCount + failCount));
if (failCount) process.exit(1);
