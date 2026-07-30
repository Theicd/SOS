// חלק דחיסת וידאו (video-compressor.js) – דחיסה חכמה + passthrough + תאימות מעטפת APK | HYPER CORE TECH
(function initVideoCompressor(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const MAX_INPUT_SIZE = 100 * 1024 * 1024; // 100MB
  // 720p: חיסכון משמעותי מול 1080/4K בלי לפגוע בזרימה למובייל | HYPER CORE TECH
  const TARGET_HEIGHT = 720;
  const TARGET_MAX_WIDTH = 1280;
  // קבצים ידידותיים עד הסף – בלי קידוד מחדש (שומר סנכרון/איכות) | HYPER CORE TECH
  const SKIP_REENCODE_MAX_BYTES = 40 * 1024 * 1024;
  // במעטפת: אם FFmpeg נכשל – מעדיפים מקור עד הסף (Canvas ב-WebView שובר וידאו) | HYPER CORE TECH
  const SHELL_PASSTHROUGH_MAX_BYTES = 45 * 1024 * 1024;
  // מקור שכבר ≤720p ודל – אל תיגע | HYPER CORE TECH
  const LOW_QUALITY_MAX_BPS = 2_800_000;
  const LOW_QUALITY_MAX_HEIGHT = 720;

  const MIN_VIDEO_BITRATE = 1_200_000;
  const MAX_VIDEO_BITRATE = 3_500_000;
  const MIN_AUDIO_BITRATE = 96_000;
  const MAX_AUDIO_BITRATE = 128_000;
  const FFMPEG_CRF = '21';
  const FFMPEG_CRF_SOFT = '23'; // מקורות בינוניים – פחות אגרסיבי | HYPER CORE TECH
  const FFMPEG_MAXRATE = 3_500_000;

  let ffmpegInstance = null;
  let isLoading = false;
  let loadPromise = null;

  function isNativeShell() {
    try {
      if (window.SOS_NATIVE_SHELL) return true;
      if (document.documentElement?.getAttribute('data-sos-native') === '1') return true;
      if (/SOSNativeShell\//i.test(navigator.userAgent || '')) return true;
      if (window.SosNativeShell && typeof window.SosNativeShell.isNativeShell === 'function') {
        const v = window.SosNativeShell.isNativeShell();
        return v === true || v === 'true';
      }
    } catch (_) {}
    return false;
  }

  function getDeviceInfo() {
    const ua = navigator.userAgent || '';
    const isIOS = /iphone|ipad|ipod/i.test(ua);
    const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    const isAndroid = /android/i.test(ua);
    const isSafari = /safari/i.test(ua) && !/chrome|chromium|crios|fxios|edgios|opios/i.test(ua);
    const finalIsIOS = isIOS || isIPadOS;
    const nativeShell = isNativeShell();
    const isMobile = finalIsIOS || isAndroid || nativeShell || /mobile/i.test(ua);
    return { isIOS: finalIsIOS, isAndroid, isSafari, isMobile, nativeShell };
  }

  function looksLikeVideo(file) {
    if (!file) return false;
    const type = String(file.type || '').toLowerCase();
    if (type.startsWith('video/')) return true;
    return /\.(mp4|m4v|mov|webm|mkv|avi|3gp)$/i.test(file.name || '');
  }

  function guessMimeFromName(name) {
    const lower = String(name || '').toLowerCase();
    if (lower.endsWith('.webm')) return 'video/webm';
    if (lower.endsWith('.mov')) return 'video/quicktime';
    if (lower.endsWith('.m4v')) return 'video/x-m4v';
    if (lower.endsWith('.mkv')) return 'video/x-matroska';
    if (lower.endsWith('.3gp')) return 'video/3gpp';
    if (lower.endsWith('.avi')) return 'video/x-msvideo';
    return 'video/mp4';
  }

  // חלק מעטפת (video-compressor.js) – משלים MIME חסר מקבצי DocumentsUI | HYPER CORE TECH
  function normalizeVideoFile(file) {
    if (!file) return file;
    const type = String(file.type || '').toLowerCase();
    if (type.startsWith('video/')) return file;
    const name = file.name || 'video.mp4';
    const mime = guessMimeFromName(name);
    try {
      return new File([file], name, { type: mime, lastModified: file.lastModified || Date.now() });
    } catch (_) {
      return file;
    }
  }

  function getBestRecorderCodec() {
    const { isIOS, isSafari } = getDeviceInfo();
    const canCheck = typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function';

    const mp4Candidates = [
      'video/mp4;codecs=avc1.4D401E,mp4a.40.2',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4',
    ];
    for (let i = 0; i < mp4Candidates.length; i += 1) {
      if (canCheck && MediaRecorder.isTypeSupported(mp4Candidates[i])) {
        return { mimeType: mp4Candidates[i], container: 'mp4' };
      }
    }

    if (!(isIOS || isSafari)) {
      if (canCheck && MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) {
        return { mimeType: 'video/webm;codecs=vp9,opus', container: 'webm' };
      }
      if (canCheck && MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) {
        return { mimeType: 'video/webm;codecs=vp8,opus', container: 'webm' };
      }
      if (canCheck && MediaRecorder.isTypeSupported('video/webm')) {
        return { mimeType: 'video/webm', container: 'webm' };
      }
    }

    return { mimeType: 'video/mp4', container: 'mp4' };
  }

  async function loadFFmpeg() {
    if (ffmpegInstance) return ffmpegInstance;
    if (isLoading) return loadPromise;

    isLoading = true;
    loadPromise = (async () => {
      try {
        const { createFFmpeg } = window.FFmpeg || {};
        if (!createFFmpeg) {
          throw new Error('FFmpeg library not loaded');
        }

        const ffmpeg = createFFmpeg({
          log: false,
          corePath: 'https://unpkg.com/@ffmpeg/core@0.10.0/dist/ffmpeg-core.js',
        });

        await ffmpeg.load();
        ffmpegInstance = ffmpeg;
        console.log('[COMPRESS] FFmpeg loaded');
        return ffmpeg;
      } catch (err) {
        console.warn('[COMPRESS] FFmpeg load failed', err);
        isLoading = false;
        ffmpegInstance = null;
        return null;
      } finally {
        isLoading = false;
      }
    })();

    return loadPromise;
  }

  function validateInputSize(file) {
    if (!file) throw new Error('לא נבחר קובץ');
    if (file.size > MAX_INPUT_SIZE) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      throw new Error(`הקובץ גדול מדי (${sizeMB}MB). מקסימום ${(MAX_INPUT_SIZE / (1024 * 1024)).toFixed(0)}MB.`);
    }
    if (!looksLikeVideo(file)) {
      throw new Error('הקובץ אינו וידאו תקין');
    }
  }

  async function calculateHash(blob) {
    try {
      const buffer = await blob.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (err) {
      console.warn('[COMPRESS] Hash failed', err);
      return '';
    }
  }

  function guessInputName(file) {
    const name = (file && file.name) || '';
    if (/\.(mp4|m4v|mov|webm|mkv|avi|3gp)$/i.test(name)) return name.replace(/[^\w.\-]+/g, '_');
    const type = String(file.type || '');
    if (type.includes('webm')) return 'input.webm';
    if (type.includes('quicktime') || type.includes('mov')) return 'input.mov';
    return 'input.mp4';
  }

  function isFriendlyContainer(file) {
    if (!file) return false;
    const type = String(file.type || '').toLowerCase();
    const name = String(file.name || '').toLowerCase();
    return (
      type.includes('mp4') ||
      type.includes('quicktime') ||
      type.includes('m4v') ||
      /\.(mp4|m4v|mov)$/i.test(name)
    );
  }

  function getAdaptiveBitrates(fileSize, durationSeconds, targetCompressionRatio = 0.55) {
    const safeDuration = Math.max(durationSeconds || 1, 0.5);
    const originalBps = (fileSize * 8) / safeDuration;
    const targetTotalBps = originalBps * targetCompressionRatio;

    let videoBps = Math.round(targetTotalBps * 0.85);
    let audioBps = Math.round(targetTotalBps * 0.15);

    videoBps = Math.min(Math.max(videoBps, MIN_VIDEO_BITRATE), MAX_VIDEO_BITRATE);
    audioBps = Math.min(Math.max(audioBps, MIN_AUDIO_BITRATE), MAX_AUDIO_BITRATE);

    if (originalBps < MIN_VIDEO_BITRATE + MIN_AUDIO_BITRATE) {
      // מקור דל – לא לרדת מתחת למקור | HYPER CORE TECH
      videoBps = Math.min(Math.max(Math.round(originalBps * 0.95), 1_200_000), MAX_VIDEO_BITRATE);
      audioBps = MIN_AUDIO_BITRATE;
    }

    console.log('[COMPRESS] Adaptive bitrates:', {
      originalMbps: (originalBps / 1_000_000).toFixed(2),
      targetMbps: ((videoBps + audioBps) / 1_000_000).toFixed(2),
      videoBps,
      audioBps,
    });

    return { videoBps, audioBps, originalBps };
  }

  function isDesktopCaptureSupported() {
    if (typeof navigator === 'undefined') return false;
    if (isNativeShell()) return false;
    const isMobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || '');
    const proto = HTMLMediaElement.prototype;
    return !isMobile && typeof MediaRecorder !== 'undefined' && (proto.captureStream || proto.mozCaptureStream);
  }

  async function probeVideo(file) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('metadata timeout')), 12000);
        video.onloadedmetadata = () => {
          clearTimeout(t);
          resolve();
        };
        video.onerror = () => {
          clearTimeout(t);
          reject(new Error('metadata error'));
        };
      });
      const duration = Math.max(video.duration || 1, 0.5);
      const width = video.videoWidth || 0;
      const height = video.videoHeight || 0;
      const estimatedBps = (file.size * 8) / duration;
      return {
        duration,
        width,
        height,
        maxEdge: Math.max(width, height),
        estimatedBps,
      };
    } finally {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      try { video.load(); } catch (_) {}
    }
  }

  async function probeDuration(file) {
    try {
      const meta = await probeVideo(file);
      return meta.duration;
    } catch (_) {
      return 1;
    }
  }

  async function makePassthroughResult(file, reason) {
    console.log('[COMPRESS] Passthrough:', reason, {
      name: file.name,
      sizeMB: (file.size / 1024 / 1024).toFixed(2),
      type: file.type,
    });
    return {
      blob: file,
      hash: await calculateHash(file),
      size: file.size,
      type: file.type || guessMimeFromName(file.name),
      originalSize: file.size,
      compressionRatio: '0.0',
      method: 'passthrough',
      reason,
    };
  }

  // חלק החלטה (video-compressor.js) – מתי לא לקודד מחדש כדי לא לפגוע באיכות מינימלית | HYPER CORE TECH
  function shouldPassthrough(file, meta) {
    if (!isFriendlyContainer(file)) return { skip: false };

    if (file.size <= SKIP_REENCODE_MAX_BYTES) {
      if (!meta || !meta.height) {
        return { skip: true, reason: 'friendly-small-container' };
      }
      if (meta.height <= LOW_QUALITY_MAX_HEIGHT && meta.width <= TARGET_MAX_WIDTH) {
        return { skip: true, reason: 'friendly-under-720p' };
      }
    }

    if (meta && meta.height > 0) {
      const alreadyLow =
        meta.height <= LOW_QUALITY_MAX_HEIGHT &&
        meta.estimatedBps > 0 &&
        meta.estimatedBps <= LOW_QUALITY_MAX_BPS &&
        file.size <= SKIP_REENCODE_MAX_BYTES;
      if (alreadyLow) {
        return { skip: true, reason: 'already-low-bitrate' };
      }
    }

    return { skip: false };
  }

  async function withWakeLock(fn) {
    let wakeLock = null;
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (_) {}
    try {
      return await fn();
    } finally {
      try {
        if (wakeLock) await wakeLock.release();
      } catch (_) {}
    }
  }

  // FFmpeg: scale רק כלפי מטה, בלי כפיית fps=30 (שומר קצב מקור) | HYPER CORE TECH
  async function compressWithFFmpeg(file, onProgress, meta) {
    const ffmpeg = await loadFFmpeg();
    if (!ffmpeg) throw new Error('ffmpeg-unavailable');

    const { fetchFile } = window.FFmpeg || {};
    if (typeof fetchFile !== 'function') throw new Error('ffmpeg-fetchFile-missing');

    if (typeof onProgress === 'function') onProgress({ stage: 'loading', percent: 5 });

    const duration = (meta && meta.duration) || await probeDuration(file).catch(() => 1);
    const { audioBps, originalBps } = getAdaptiveBitrates(file.size, duration);
    const inputName = guessInputName(file);
    const outputName = 'output.mp4';
    const needDownscale = !meta || !meta.height || meta.height > TARGET_HEIGHT || meta.width > TARGET_MAX_WIDTH;
    const crf = originalBps > 0 && originalBps < 4_500_000 ? FFMPEG_CRF_SOFT : FFMPEG_CRF;

    ffmpeg.FS('writeFile', inputName, await fetchFile(file));
    if (typeof onProgress === 'function') onProgress({ stage: 'compressing', percent: 20 });

    let fakePct = 20;
    const tick = setInterval(() => {
      fakePct = Math.min(88, fakePct + 3);
      if (typeof onProgress === 'function') onProgress({ stage: 'compressing', percent: fakePct });
    }, 700);

    const args = ['-i', inputName];
    if (needDownscale) {
      // scale רק כלפי מטה; בלי כפיית fps (שומר קצב מקור ומונע קיצור/גמגום) | HYPER CORE TECH
      args.push('-vf', `scale=-2:min(${TARGET_HEIGHT}\\,ih)`);
    }
    args.push(
      '-c:v', 'libx264',
      '-preset', 'medium',
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

    try {
      console.log('[COMPRESS] FFmpeg args', {
        needDownscale,
        crf,
        height: meta && meta.height,
        originalMbps: originalBps ? (originalBps / 1e6).toFixed(2) : 'n/a',
      });
      await ffmpeg.run(...args);
    } finally {
      clearInterval(tick);
      try { ffmpeg.FS('unlink', inputName); } catch (_) {}
    }

    if (typeof onProgress === 'function') onProgress({ stage: 'finalizing', percent: 92 });

    const data = ffmpeg.FS('readFile', outputName);
    try { ffmpeg.FS('unlink', outputName); } catch (_) {}

    const blob = new Blob([data.buffer], { type: 'video/mp4' });
    if (!blob.size) throw new Error('ffmpeg-empty-output');
    if (blob.size >= file.size * 0.98) {
      throw new Error('ffmpeg-not-smaller');
    }

    const hash = await calculateHash(blob);
    if (typeof onProgress === 'function') onProgress({ stage: 'complete', percent: 100 });

    return {
      blob,
      hash,
      size: blob.size,
      type: 'video/mp4',
      originalSize: file.size,
      compressionRatio: ((1 - blob.size / file.size) * 100).toFixed(1),
      method: 'ffmpeg',
    };
  }

  async function compressWithDirectRecorder(file, onProgress) {
    console.log('[COMPRESS] Desktop captureStream (synced A/V)...');
    if (typeof onProgress === 'function') onProgress({ stage: 'loading', percent: 0 });

    const video = document.createElement('video');
    video.style.display = 'none';
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.src = URL.createObjectURL(file);
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    document.body.appendChild(video);

    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Timeout loading video metadata')), 12000);
        video.onloadedmetadata = () => {
          clearTimeout(t);
          resolve();
        };
        video.onerror = () => {
          clearTimeout(t);
          reject(new Error('Failed to load video metadata'));
        };
      });
    } catch (err) {
      URL.revokeObjectURL(video.src);
      document.body.removeChild(video);
      throw err;
    }

    const capture = video.captureStream
      ? video.captureStream()
      : video.mozCaptureStream?.();
    if (!capture) {
      URL.revokeObjectURL(video.src);
      document.body.removeChild(video);
      throw new Error('captureStream not supported');
    }

    const duration = Math.max(video.duration || 1, 0.5);
    const { videoBps, audioBps } = getAdaptiveBitrates(file.size, duration);
    const { mimeType, container } = getBestRecorderCodec();

    let recorder;
    try {
      recorder = new MediaRecorder(capture, {
        mimeType,
        videoBitsPerSecond: videoBps,
        audioBitsPerSecond: audioBps,
      });
    } catch (_) {
      recorder = new MediaRecorder(capture, {
        videoBitsPerSecond: videoBps,
        audioBitsPerSecond: audioBps,
      });
    }

    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };

    const progressTimer = setInterval(() => {
      if (video.paused || video.ended) return;
      const pct = Math.min(90, 10 + (video.currentTime / duration) * 80);
      if (typeof onProgress === 'function') {
        onProgress({ stage: 'compressing', percent: Math.round(pct) });
      }
    }, 400);

    const finished = new Promise((resolve) => {
      recorder.onstop = resolve;
    });

    try {
      video.currentTime = 0;
      await new Promise((r) => setTimeout(r, 40));
      recorder.start(250);
      await video.play();

      await new Promise((resolve) => {
        video.onended = () => {
          clearInterval(progressTimer);
          setTimeout(() => {
            try {
              if (recorder.state !== 'inactive') recorder.stop();
            } catch (_) {}
            resolve();
          }, 180);
        };
      });

      await finished;
    } finally {
      clearInterval(progressTimer);
      URL.revokeObjectURL(video.src);
      if (video.parentNode) document.body.removeChild(video);
    }

    if (typeof onProgress === 'function') onProgress({ stage: 'finalizing', percent: 95 });

    const outType = (recorder.mimeType || mimeType || 'video/mp4').split(';')[0];
    const blob = new Blob(chunks, { type: outType });
    if (!blob.size) throw new Error('direct-empty');
    if (blob.size >= file.size) throw new Error('direct-result-larger');

    const hash = await calculateHash(blob);
    if (typeof onProgress === 'function') onProgress({ stage: 'complete', percent: 100 });

    return {
      blob,
      hash,
      size: blob.size,
      type: container === 'mp4' || outType.includes('mp4') ? 'video/mp4' : outType,
      originalSize: file.size,
      compressionRatio: ((1 - blob.size / file.size) * 100).toFixed(1),
      method: 'capture-stream',
    };
  }

  function computeCanvasSize(video) {
    const minSize = TARGET_HEIGHT;
    const maxSize = TARGET_MAX_WIDTH;
    const aspectRatio = video.videoWidth / Math.max(video.videoHeight, 1);
    let canvasWidth;
    let canvasHeight;

    // לא להגדיל מקור קטן – רק להקטין אם צריך | HYPER CORE TECH
    if (video.videoWidth >= video.videoHeight) {
      canvasHeight = Math.min(minSize, video.videoHeight || minSize);
      canvasWidth = Math.max(2, Math.floor(canvasHeight * aspectRatio));
    } else {
      canvasWidth = Math.min(minSize, video.videoWidth || minSize);
      canvasHeight = Math.max(2, Math.floor(canvasWidth / aspectRatio));
    }

    if (canvasWidth > maxSize) {
      canvasWidth = maxSize;
      canvasHeight = Math.floor(maxSize / aspectRatio);
    }
    if (canvasHeight > maxSize) {
      canvasHeight = maxSize;
      canvasWidth = Math.floor(maxSize * aspectRatio);
    }

    canvasWidth -= canvasWidth % 2;
    canvasHeight -= canvasHeight % 2;
    return { canvasWidth, canvasHeight };
  }

  async function compressWithCanvas(file, onProgress) {
    console.log('[COMPRESS] Canvas path (synced frames, no WebAudio)...');
    if (typeof onProgress === 'function') onProgress({ stage: 'preparing', percent: 5 });

    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;top:0;left:0';
    document.body.appendChild(video);

    const videoUrl = URL.createObjectURL(file);
    video.src = videoUrl;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout loading video metadata')), 12000);
      video.onloadedmetadata = () => {
        clearTimeout(timeout);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Failed to load video metadata'));
      };
    });

    if (typeof onProgress === 'function') onProgress({ stage: 'setup', percent: 10 });

    const { canvasWidth, canvasHeight } = computeCanvasSize(video);
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    const { isIOS, isSafari } = getDeviceInfo();
    const { mimeType, container } = getBestRecorderCodec();
    const duration = Math.max(video.duration || 1, 0.5);
    const { videoBps, audioBps } = getAdaptiveBitrates(file.size, duration);

    const canvasStream = canvas.captureStream(0);
    const canvasVideoTrack = canvasStream.getVideoTracks()[0];

    let audioAdded = false;
    try {
      if (typeof video.captureStream === 'function') {
        const videoStream = video.captureStream();
        videoStream.getAudioTracks().forEach((track) => {
          canvasStream.addTrack(track);
          audioAdded = true;
        });
      }
    } catch (err) {
      console.warn('[COMPRESS] video.captureStream audio failed', err);
    }

    if (!audioAdded) {
      console.warn('[COMPRESS] No audio track – video will be silent (avoiding WebAudio drift)');
    }

    const recorderOptions = {
      mimeType,
      videoBitsPerSecond: videoBps,
      audioBitsPerSecond: audioAdded ? audioBps : undefined,
    };

    let recorder;
    try {
      recorder = new MediaRecorder(canvasStream, recorderOptions);
    } catch (err) {
      console.warn('[COMPRESS] MediaRecorder fallback', err);
      recorder = new MediaRecorder(canvasStream);
    }

    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    let frameCount = 0;
    let stopDrawing = false;
    let rafId = 0;
    let rvfcId = 0;

    const paint = () => {
      if (stopDrawing) return;
      ctx.drawImage(video, 0, 0, canvasWidth, canvasHeight);
      frameCount += 1;
      if (canvasVideoTrack && typeof canvasVideoTrack.requestFrame === 'function') {
        try { canvasVideoTrack.requestFrame(); } catch (_) {}
      }
      if (typeof onProgress === 'function' && duration > 0) {
        const progress = Math.min(90, 15 + (video.currentTime / duration) * 75);
        onProgress({ stage: 'compressing', percent: Math.round(progress) });
      }
    };

    const startDrawing = () => {
      if (typeof video.requestVideoFrameCallback === 'function') {
        const onFrame = () => {
          if (stopDrawing || video.ended) return;
          paint();
          rvfcId = video.requestVideoFrameCallback(onFrame);
        };
        rvfcId = video.requestVideoFrameCallback(onFrame);
        return;
      }
      const tick = () => {
        if (stopDrawing || video.ended) return;
        paint();
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    };

    const stopDrawingLoop = () => {
      stopDrawing = true;
      if (rafId) cancelAnimationFrame(rafId);
      try {
        if (rvfcId && typeof video.cancelVideoFrameCallback === 'function') {
          video.cancelVideoFrameCallback(rvfcId);
        }
      } catch (_) {}
    };

    try {
      video.pause();
      if (video.currentTime > 0.01) {
        await new Promise((resolve) => {
          const done = () => {
            video.onseeked = null;
            resolve();
          };
          video.onseeked = done;
          video.currentTime = 0;
          setTimeout(done, 1500);
        });
      }
    } catch (_) {}

    recorder.start(250);
    await video.play();
    startDrawing();

    const safetyTimeout = Math.min(
      Math.max(((video.duration || 0) * 1000) + 8000, 45000),
      180000
    );

    let stopRequested = false;
    const safeStopRecorder = () => {
      if (stopRequested) return;
      stopRequested = true;
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch (_) {}
    };

    let safetyTimerId = 0;
    await Promise.race([
      new Promise((resolve) => {
        video.onended = () => {
          stopDrawingLoop();
          paint();
          if (safetyTimerId) clearTimeout(safetyTimerId);
          setTimeout(() => {
            safeStopRecorder();
          }, 220);
        };
        recorder.onstop = resolve;
      }),
      new Promise((resolve) => {
        safetyTimerId = setTimeout(() => {
          console.warn('[COMPRESS] safety timeout', safetyTimeout);
          stopDrawingLoop();
          safeStopRecorder();
          resolve();
        }, safetyTimeout);
      }),
    ]);

    if (safetyTimerId) clearTimeout(safetyTimerId);
    stopDrawingLoop();
    URL.revokeObjectURL(videoUrl);
    if (video.parentNode) document.body.removeChild(video);

    const outMime = (recorder.mimeType || mimeType || 'video/mp4').split(';')[0];
    const blob = new Blob(chunks, { type: outMime });
    if (!blob.size) {
      console.warn('[COMPRESS] empty canvas output – returning original');
      return makePassthroughResult(file, 'canvas-empty');
    }

    if (blob.size >= file.size) {
      console.warn('[COMPRESS] grew – returning original');
      return makePassthroughResult(file, 'canvas-grew');
    }

    // חלק איכות (video-compressor.js) – אם כמעט אין פריימים ביחס למשך, עדיף מקור | HYPER CORE TECH
    const expectedMinFrames = Math.max(8, Math.floor(duration * 8));
    if (frameCount < expectedMinFrames) {
      console.warn('[COMPRESS] too few canvas frames', { frameCount, expectedMinFrames, duration });
      return makePassthroughResult(file, 'canvas-too-few-frames');
    }

    const hash = await calculateHash(blob);
    if (typeof onProgress === 'function') onProgress({ stage: 'complete', percent: 100 });

    const outputType = (container === 'mp4' || outMime.includes('mp4'))
      ? 'video/mp4'
      : outMime;

    console.log('[COMPRESS] Canvas done', {
      frames: frameCount,
      effectiveFPS: (frameCount / duration).toFixed(1),
      isIOS,
      isSafari,
      outputType,
      audioAdded,
    });

    return {
      blob,
      hash,
      size: blob.size,
      type: outputType,
      originalSize: file.size,
      compressionRatio: ((1 - blob.size / file.size) * 100).toFixed(1),
      method: 'canvas',
    };
  }

  async function compressVideo(file, onProgress) {
    return withWakeLock(async () => {
      const normalized = normalizeVideoFile(file);
      validateInputSize(normalized);
      const { isIOS, isAndroid, isMobile, nativeShell } = getDeviceInfo();

      console.log('[COMPRESS] Starting:', {
        fileName: normalized.name,
        fileSize: `${(normalized.size / 1024 / 1024).toFixed(2)}MB`,
        fileType: normalized.type,
        isIOS,
        isAndroid,
        isMobile,
        nativeShell,
      });

      let meta = null;
      try {
        meta = await probeVideo(normalized);
        console.log('[COMPRESS] Probe:', {
          w: meta.width,
          h: meta.height,
          duration: meta.duration.toFixed(2),
          mbps: (meta.estimatedBps / 1e6).toFixed(2),
        });
      } catch (err) {
        console.warn('[COMPRESS] probe failed', err?.message || err);
      }

      const pass = shouldPassthrough(normalized, meta);
      if (pass.skip) {
        if (typeof onProgress === 'function') onProgress({ stage: 'complete', percent: 100 });
        return makePassthroughResult(normalized, pass.reason);
      }

      // FFmpeg ראשון – הכי אמין לסנכרון ולאייפון | HYPER CORE TECH
      try {
        const ff = await compressWithFFmpeg(normalized, onProgress, meta);
        console.log('[COMPRESS] FFmpeg success', ff.compressionRatio + '%');
        return ff;
      } catch (err) {
        console.warn('[COMPRESS] FFmpeg path failed, falling back:', err?.message || err);
      }

      // חלק מעטפת (video-compressor.js) – לא Canvas ב-WebView (שמע בלי תמונה / קיצור / טשטוש) | HYPER CORE TECH
      if (nativeShell || isAndroid) {
        if (normalized.size <= SHELL_PASSTHROUGH_MAX_BYTES || isFriendlyContainer(normalized)) {
          if (typeof onProgress === 'function') onProgress({ stage: 'complete', percent: 100 });
          return makePassthroughResult(normalized, 'shell-avoid-canvas');
        }
        throw new Error(
          'לא ניתן לדחוס את הווידאו במעטפת. בחר קובץ קטן יותר (עד ~45MB) או נסה שוב מהדפדפן.'
        );
      }

      if (!isMobile && isDesktopCaptureSupported()) {
        try {
          return await compressWithDirectRecorder(normalized, onProgress);
        } catch (err) {
          console.warn('[COMPRESS] Desktop capture failed:', err?.message || err);
        }
      }

      return await compressWithCanvas(normalized, onProgress);
    });
  }

  function isSupported() {
    return !!(window.FFmpeg || typeof MediaRecorder !== 'undefined');
  }

  Object.assign(App, {
    compressVideo,
    isVideoCompressionSupported: isSupported,
    loadVideoCompressor: loadFFmpeg,
    normalizeVideoFile,
  });

  console.log('[COMPRESS] Video compressor module initialized (smart passthrough + shell-safe)');
})(window);
