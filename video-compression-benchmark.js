// חלק בדיקה (video-compression-benchmark.js) – FFmpeg-ST מבודד; לא צינור צ'אט חי | HYPER CORE TECH
(function initVideoCompressionBenchmark(root) {
  const App = root.NostrApp || (root.NostrApp = {});

  const FFMPEG_ST_CORE = 'https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js';
  const FFMPEG_ST_MAIN = 'main';
  const ALLOWED_PRESETS = ['ultrafast', 'superfast', 'veryfast'];
  const FFMPEG_CRF = '21';
  const FFMPEG_CRF_SOFT = '23';
  const FFMPEG_MAXRATE = 3_500_000;
  const MIN_AUDIO_BITRATE = 64_000;
  const MAX_AUDIO_BITRATE = 96_000;
  const MOTION_BUDGET_MS = 800;
  const REALTIME_FALLBACK_MAX_DURATION_SEC = 60;

  let stInstance = null;
  let stLoadPromise = null;
  let stLoadMeta = null;
  let abortFlag = false;
  let runSeq = 0;

  function internals() {
    return App.__videoCompressionInternals || {};
  }

  function geometryOf(width, height) {
    if (typeof App.computeVideoBenchmarkGeometry === 'function') {
      return App.computeVideoBenchmarkGeometry(width, height);
    }
    return { width, height, scaled: false, withinTarget: true, scale: 1 };
  }

  function nowMs() {
    try {
      if (root.performance && typeof root.performance.now === 'function') return root.performance.now();
    } catch (_) {}
    return Date.now();
  }

  function heapSnapshot() {
    try {
      const mem = root.performance && root.performance.memory;
      if (!mem) return null;
      return {
        usedJSHeapSize: mem.usedJSHeapSize,
        totalJSHeapSize: mem.totalJSHeapSize,
        jsHeapSizeLimit: mem.jsHeapSizeLimit,
      };
    } catch (_) {
      return null;
    }
  }

  function isolationSnapshot() {
    let isolated = null;
    try { isolated = !!root.crossOriginIsolated; } catch (_) { isolated = null; }
    let sabType = 'unavailable';
    let sabConstruct = false;
    try {
      sabType = typeof root.SharedArrayBuffer;
      if (sabType === 'function') {
        try {
          sabConstruct = new root.SharedArrayBuffer(8).byteLength === 8;
        } catch (_) {
          sabConstruct = false;
        }
      }
    } catch (_) {}
    return {
      crossOriginIsolated: isolated,
      sharedArrayBufferTypeof: sabType,
      sharedArrayBufferConstruct: sabConstruct,
    };
  }

  function normalizePreset(preset) {
    const p = String(preset || 'veryfast').toLowerCase();
    return ALLOWED_PRESETS.indexOf(p) >= 0 ? p : 'veryfast';
  }

  function guessInputName(file) {
    const name = (file && file.name) || '';
    if (/\.(mp4|m4v|mov|webm|mkv|avi|3gp)$/i.test(name)) return name.replace(/[^\w.\-]+/g, '_');
    const type = String(file && file.type || '');
    if (type.includes('webm')) return 'input.webm';
    if (type.includes('quicktime') || type.includes('mov')) return 'input.mov';
    return 'input.mp4';
  }

  async function probeSource(file) {
    const hook = internals().probeVideo;
    if (typeof hook === 'function') {
      const meta = await hook(file);
      const geo = geometryOf(meta.width, meta.height);
      return {
        bytes: file.size,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        estimatedBps: meta.estimatedBps,
        fps: null,
        geometry: geo,
      };
    }
    throw new Error('probeVideo-unavailable');
  }

  async function calculateHash(blob) {
    const hook = internals().calculateHash;
    if (typeof hook === 'function') return hook(blob);
    try {
      const buffer = await blob.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      return '';
    }
  }

  function classifyMotionFromMeanDiff(meanDiff) {
    if (!(meanDiff >= 0)) return 'NORMAL';
    if (meanDiff < 8) return 'LOW';
    if (meanDiff < 22) return 'NORMAL';
    return 'HIGH';
  }

  async function probeMotionComplexity(file, duration, budgetMs) {
    const started = nowMs();
    const video = root.document && root.document.createElement ? root.document.createElement('video') : null;
    if (!video || typeof root.document === 'undefined') {
      return { status: 'SKIPPED', reason: 'no-video-element', elapsedMs: 0 };
    }
    const url = URL.createObjectURL(file);
    const canvas = root.document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    video.muted = true;
    video.preload = 'auto';
    video.src = url;
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('motion-meta-timeout')), Math.min(budgetMs, 600));
        video.onloadedmetadata = () => { clearTimeout(t); resolve(); };
        video.onerror = () => { clearTimeout(t); reject(new Error('motion-meta-error')); };
      });
      const dur = Math.max(duration || video.duration || 1, 0.5);
      const stamps = [0.15, 0.35, 0.55, 0.75, 0.9].map((p) => Math.min(dur * 0.98, Math.max(0, dur * p)));
      let prev = null;
      const diffs = [];
      for (let i = 0; i < stamps.length; i += 1) {
        if (nowMs() - started > budgetMs) {
          return {
            status: 'SKIPPED',
            reason: 'budget',
            elapsedMs: Math.round(nowMs() - started),
            samples: diffs.length,
          };
        }
        await new Promise((resolve) => {
          const done = () => { video.onseeked = null; resolve(); };
          video.onseeked = done;
          video.currentTime = stamps[i];
          setTimeout(done, 180);
        });
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        if (prev) {
          let acc = 0;
          let n = 0;
          for (let p = 0; p < frame.length; p += 16) {
            const g1 = (prev[p] + prev[p + 1] + prev[p + 2]) / 3;
            const g2 = (frame[p] + frame[p + 1] + frame[p + 2]) / 3;
            acc += Math.abs(g1 - g2);
            n += 1;
          }
          diffs.push(n ? acc / n : 0);
        }
        prev = frame;
      }
      const mean = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0;
      return {
        status: 'PASS',
        class: classifyMotionFromMeanDiff(mean),
        meanDiff: Number(mean.toFixed(2)),
        samples: diffs.length,
        elapsedMs: Math.round(nowMs() - started),
      };
    } catch (err) {
      return {
        status: 'SKIPPED',
        reason: String(err && err.message || err),
        elapsedMs: Math.round(nowMs() - started),
      };
    } finally {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      try { video.load(); } catch (_) {}
    }
  }

  async function inspectOutput(blob) {
    const video = root.document && root.document.createElement ? root.document.createElement('video') : null;
    if (!video) {
      return { playable: blob && blob.size > 0, audio: 'NOT VERIFIED', width: 0, height: 0, duration: 0, seek: 'NOT VERIFIED' };
    }
    const url = URL.createObjectURL(blob);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = url;
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('output-metadata-timeout')), 12000);
        video.onloadedmetadata = () => { clearTimeout(t); resolve(); };
        video.onerror = () => { clearTimeout(t); reject(new Error('output-not-playable')); };
      });
      let audio = 'NOT VERIFIED';
      try {
        if (typeof video.mozHasAudio === 'boolean') audio = video.mozHasAudio ? 'PRESENT' : 'MISSING';
        else if (video.audioTracks && typeof video.audioTracks.length === 'number') {
          audio = video.audioTracks.length > 0 ? 'PRESENT' : 'MISSING';
        }
      } catch (_) {}
      try {
        if (audio === 'NOT VERIFIED' || audio === 'MISSING') {
          video.muted = true;
          await video.play();
          await new Promise((r) => setTimeout(r, 450));
          if (typeof video.webkitAudioDecodedByteCount === 'number' && video.webkitAudioDecodedByteCount > 0) {
            audio = 'PRESENT';
          }
          video.pause();
        }
      } catch (_) {}
      let seek = 'NOT VERIFIED';
      try {
        const mid = Math.max(0.05, (video.duration || 0) / 2);
        await new Promise((resolve) => {
          const done = () => { video.onseeked = null; resolve(); };
          video.onseeked = done;
          video.currentTime = mid;
          setTimeout(done, 1500);
        });
        seek = Math.abs(video.currentTime - mid) < 1.5 ? 'OK' : 'DRIFT';
      } catch (_) {}
      return {
        playable: true,
        audio,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        duration: video.duration || 0,
        seek,
      };
    } catch (err) {
      return {
        playable: false,
        audio: 'NOT VERIFIED',
        width: 0,
        height: 0,
        duration: 0,
        seek: 'FAIL',
        error: String(err && err.message || err),
      };
    } finally {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      try { video.load(); } catch (_) {}
    }
  }

  function throwIfAborted() {
    if (abortFlag) throw new Error('benchmark-aborted');
  }

  function buildStArgs(inputName, outputName, preset, geo, duration, fileSize) {
    const hook = internals().getAdaptiveBitrates;
    const rates = typeof hook === 'function'
      ? hook(fileSize, duration)
      : { audioBps: 80_000, originalBps: (fileSize * 8) / Math.max(duration, 0.5) };
    const audioBps = Math.min(Math.max(rates.audioBps || 80_000, MIN_AUDIO_BITRATE), MAX_AUDIO_BITRATE);
    const originalBps = rates.originalBps || 0;
    const crf = originalBps > 0 && originalBps < 4_500_000 ? FFMPEG_CRF_SOFT : FFMPEG_CRF;
    const args = ['-i', inputName];
    if (geo && geo.scaled && geo.width && geo.height) {
      args.push('-vf', 'scale=' + geo.width + ':' + geo.height);
    }
    args.push(
      '-c:v', 'libx264',
      '-preset', preset,
      '-profile:v', 'main',
      '-level', '4.0',
      '-crf', crf,
      '-maxrate', String(FFMPEG_MAXRATE),
      '-bufsize', String(FFMPEG_MAXRATE * 2),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', String(audioBps),
      '-ar', '44100',
      '-ac', '2',
      '-af', 'aresample=async=1:first_pts=0',
      '-movflags', '+faststart',
      '-y',
      outputName
    );
    return { args, crf, audioBps, originalBps };
  }

  function isBenignFfmpegExit(err) {
    const m = String(err && err.message || err);
    return /exit\(0\)|ffmpeg has exited/i.test(m);
  }

  async function runSt(ffmpeg, args, outputName) {
    try {
      await ffmpeg.run(...args);
    } catch (err) {
      if (!isBenignFfmpegExit(err)) throw err;
    }
    if (!outputName) return;
    const data = ffmpeg.FS('readFile', outputName);
    if (!data || !data.length) throw new Error('st-run-no-output');
  }

  async function disposeFFmpegST() {
    try {
      if (stInstance && typeof stInstance.exit === 'function') stInstance.exit();
    } catch (_) {}
    stInstance = null;
    stLoadPromise = null;
  }

  async function loadFFmpegST(forceReload) {
    if (forceReload) await disposeFFmpegST();
    if (stInstance) return stInstance;
    if (stLoadPromise) return stLoadPromise;
    stLoadPromise = (async () => {
      const { createFFmpeg } = root.FFmpeg || {};
      if (typeof createFFmpeg !== 'function') {
        throw new Error('ffmpeg-wrapper-missing');
      }
      const iso = isolationSnapshot();
      const t0 = nowMs();
      const ffmpeg = createFFmpeg({
        log: false,
        corePath: FFMPEG_ST_CORE,
        mainName: FFMPEG_ST_MAIN,
      });
      await ffmpeg.load();
      stInstance = ffmpeg;
      stLoadMeta = {
        core: FFMPEG_ST_CORE,
        mainName: FFMPEG_ST_MAIN,
        loadMs: Math.round(nowMs() - t0),
        isolationAtLoad: iso,
      };
      console.log('[VIDEO-BENCH] FFmpeg-ST loaded', stLoadMeta);
      return ffmpeg;
    })();
    try {
      return await stLoadPromise;
    } catch (err) {
      stLoadPromise = null;
      stInstance = null;
      throw err;
    }
  }

  async function proveFFmpegStCompatibility() {
    abortFlag = false;
    const report = {
      ok: false,
      core: FFMPEG_ST_CORE,
      mainName: FFMPEG_ST_MAIN,
      isolation: isolationSnapshot(),
      steps: {},
      blocked: false,
    };
    const t0 = nowMs();
    try {
      report.steps.load = 'pending';
      let ffmpeg = await loadFFmpegST();
      report.steps.load = 'ok';
      report.loadMs = stLoadMeta && stLoadMeta.loadMs;
      report.sabRequired = false;
      report.sabAtLoad = stLoadMeta && stLoadMeta.isolationAtLoad;

      report.steps.writeFile = 'pending';
      throwIfAborted();
      await runSt(ffmpeg, [
        '-f', 'lavfi', '-i', 'testsrc=duration=0.4:size=320x240:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.4',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-t', '0.4',
        '-c:a', 'aac', '-ac', '1', '-ar', '44100',
        '-shortest', '-y', 'gate1.mp4'
      ], 'gate1.mp4');
      report.steps.writeFile = 'ok';
      report.steps.run = 'ok';

      report.steps.readFile = 'pending';
      const data1 = ffmpeg.FS('readFile', 'gate1.mp4');
      report.steps.readFile = 'ok';
      report.firstBytes = data1 && data1.length || 0;
      if (!report.firstBytes) throw new Error('gate-empty-output');
      try { ffmpeg.FS('unlink', 'gate1.mp4'); } catch (_) {}
      report.steps.cleanup = 'ok';

      report.steps.secondRun = 'pending';
      throwIfAborted();
      ffmpeg = await loadFFmpegST(true);
      await runSt(ffmpeg, [
        '-f', 'lavfi', '-i', 'testsrc=duration=0.4:size=320x240:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-t', '0.4',
        '-c:a', 'aac', '-ac', '1', '-ar', '44100',
        '-shortest', '-y', 'gate2.mp4'
      ], 'gate2.mp4');
      const data2 = ffmpeg.FS('readFile', 'gate2.mp4');
      try { ffmpeg.FS('unlink', 'gate2.mp4'); } catch (_) {}
      report.secondBytes = data2 && data2.length || 0;
      if (!report.secondBytes) throw new Error('gate-second-empty');
      report.steps.secondRun = 'ok';

      const blob = new Blob([data2.buffer], { type: 'video/mp4' });
      report.playback = await inspectOutput(blob);
      report.ok = true;
      report.elapsedMs = Math.round(nowMs() - t0);
      return report;
    } catch (err) {
      report.ok = false;
      report.blocked = true;
      report.status = 'FFMPEG-ST BLOCKED';
      report.error = String(err && err.message || err);
      report.elapsedMs = Math.round(nowMs() - t0);
      return report;
    }
  }

  async function runFFmpegStOnFile(file, options, source) {
    const preset = normalizePreset(options && options.preset);
    const ffmpeg = await loadFFmpegST(true);
    const { fetchFile } = root.FFmpeg || {};
    if (typeof fetchFile !== 'function') throw new Error('ffmpeg-fetchFile-missing');
    throwIfAborted();
    const seq = (runSeq += 1);
    const inputName = 'in_' + seq + '_' + guessInputName(file);
    const outputName = 'out_' + seq + '.mp4';
    const built = buildStArgs(inputName, outputName, preset, source.geometry, source.duration, file.size);
    const times = { setupMs: stLoadMeta && stLoadMeta.loadMs || 0 };
    const heapBefore = heapSnapshot();
    const tWrite = nowMs();
    ffmpeg.FS('writeFile', inputName, await fetchFile(file));
    times.writeMs = Math.round(nowMs() - tWrite);
    throwIfAborted();
    if (typeof options.onProgress === 'function') options.onProgress({ stage: 'compressing', percent: 20 });
    const tEnc = nowMs();
    try {
      await runSt(ffmpeg, built.args, outputName);
    } finally {
      try { ffmpeg.FS('unlink', inputName); } catch (_) {}
    }
    times.encodeMs = Math.round(nowMs() - tEnc);
    throwIfAborted();
    const tRead = nowMs();
    const data = ffmpeg.FS('readFile', outputName);
    try { ffmpeg.FS('unlink', outputName); } catch (_) {}
    times.readMs = Math.round(nowMs() - tRead);
    const blob = new Blob([data.buffer], { type: 'video/mp4' });
    const tHash = nowMs();
    const hash = options && options.hash === false ? '' : await calculateHash(blob);
    times.hashMs = Math.round(nowMs() - tHash);
    times.totalMs = times.writeMs + times.encodeMs + times.readMs + times.hashMs;
    return {
      blob,
      hash,
      times,
      heapBefore,
      heapAfter: heapSnapshot(),
      preset,
      crf: built.crf,
      audioBps: built.audioBps,
      args: built.args,
    };
  }

  async function runReferenceEngine(engine, file, options) {
    const fn = engine === 'canvas'
      ? internals().compressWithCanvas
      : internals().compressWithDirectRecorder;
    if (typeof fn !== 'function') throw new Error(engine + '-internals-missing');
    const t0 = nowMs();
    const heapBefore = heapSnapshot();
    const result = await fn(file, options && options.onProgress);
    return {
      blob: result && result.blob,
      hash: result && result.hash || '',
      times: {
        setupMs: 0,
        writeMs: 0,
        encodeMs: Math.round(nowMs() - t0),
        readMs: 0,
        hashMs: 0,
        totalMs: Math.round(nowMs() - t0),
      },
      heapBefore,
      heapAfter: heapSnapshot(),
      method: result && result.method,
      reason: result && result.reason,
    };
  }

  function speedRatio(encodeMs, durationSec) {
    const d = Math.max(Number(durationSec) || 0, 0.001);
    return Number(((encodeMs / 1000) / d).toFixed(3));
  }

  function performanceBand(ratio) {
    if (!(ratio >= 0)) return 'UNKNOWN';
    if (ratio <= 0.25) return 'GOOD';
    if (ratio <= 0.50) return 'ACCEPTABLE';
    if (ratio < 1) return 'POOR';
    return 'FAIL AS PERFORMANCE REPLACEMENT';
  }

  async function benchmarkVideoCompression(file, options) {
    abortFlag = false;
    const opts = options || {};
    const engine = String(opts.engine || 'ffmpeg-st');
    if (!file) throw new Error('no-file');
    const tAll = nowMs();
    const source = await probeSource(file);
    let motion = { status: 'SKIPPED', reason: 'not-requested' };
    if (opts.motion !== false) {
      motion = await probeMotionComplexity(file, source.duration, MOTION_BUDGET_MS);
    }
    throwIfAborted();
    let raw;
    if (engine === 'ffmpeg-st') {
      raw = await runFFmpegStOnFile(file, opts, source);
    } else if (engine === 'direct' || engine === 'canvas') {
      raw = await runReferenceEngine(engine, file, opts);
    } else {
      throw new Error('unknown-engine');
    }
    const playback = raw.blob ? await inspectOutput(raw.blob) : { playable: false, audio: 'MISSING' };
    const outBytes = raw.blob ? raw.blob.size : 0;
    const encodeMs = raw.times.encodeMs;
    const ratio = speedRatio(encodeMs, source.duration);
    const report = {
      engine,
      preset: engine === 'ffmpeg-st' ? normalizePreset(opts.preset) : null,
      source: {
        name: file.name,
        bytes: file.size,
        duration: source.duration,
        width: source.width,
        height: source.height,
        estimatedBps: source.estimatedBps,
        geometry: source.geometry,
      },
      motion,
      output: {
        bytes: outBytes,
        type: raw.blob && raw.blob.type || '',
        width: playback.width,
        height: playback.height,
        duration: playback.duration,
        hash: raw.hash || '',
        playable: playback.playable,
        audio: playback.audio,
        seek: playback.seek,
      },
      savingPct: file.size ? Number((((file.size - outBytes) / file.size) * 100).toFixed(1)) : 0,
      times: raw.times,
      speedRatio: ratio,
      performanceBand: performanceBand(ratio),
      heap: { before: raw.heapBefore, after: raw.heapAfter },
      ffmpegSt: engine === 'ffmpeg-st' ? {
        core: FFMPEG_ST_CORE,
        mainName: FFMPEG_ST_MAIN,
        loadMs: stLoadMeta && stLoadMeta.loadMs,
        isolationAtLoad: stLoadMeta && stLoadMeta.isolationAtLoad,
        crf: raw.crf,
        args: raw.args,
      } : null,
      blob: raw.blob || null,
      totalWallMs: Math.round(nowMs() - tAll),
      realtimeFallbackMaxDurationSec: REALTIME_FALLBACK_MAX_DURATION_SEC,
    };
    if (typeof opts.onProgress === 'function') opts.onProgress({ stage: 'complete', percent: 100 });
    console.log('[VIDEO-BENCH] result', {
      engine: report.engine,
      preset: report.preset,
      duration: source.duration,
      encodeMs,
      speedRatio: ratio,
      savingPct: report.savingPct,
      playable: playback.playable,
      audio: playback.audio,
    });
    return report;
  }

  function abortVideoCompressionBenchmark() {
    abortFlag = true;
    disposeFFmpegST();
    return { aborted: true };
  }

  App.benchmarkVideoCompression = benchmarkVideoCompression;
  App.proveFFmpegStCompatibility = proveFFmpegStCompatibility;
  App.abortVideoCompressionBenchmark = abortVideoCompressionBenchmark;
  App.loadFFmpegSTBenchmark = loadFFmpegST;
  App.probeVideoMotionComplexity = probeMotionComplexity;
  App.__videoCompressionBenchmarkMeta = {
    core: FFMPEG_ST_CORE,
    mainName: FFMPEG_ST_MAIN,
    presets: ALLOWED_PRESETS,
    autoRun: false,
    classifyMotionFromMeanDiff,
  };

  console.log('[VIDEO-BENCH] benchmark module loaded (inert until called)');
})(typeof window !== 'undefined' ? window : globalThis);
