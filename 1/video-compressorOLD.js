// חלק דחיסת וידאו (video-compressor.js) – מודול לדחיסה והמרה ל-WEBM 720p בצד הלקוח
// שייך: SOS2 מדיה, משתמש ב-ffmpeg.wasm לעיבוד וידאו בדפדפן
(function initVideoCompressor(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק דחיסת וידאו – הגדרות ומגבלות
  const MAX_INPUT_SIZE = 100 * 1024 * 1024; // 100MB
  const TARGET_BITRATE = '1M'; // ~1Mbps לוידאו
  const AUDIO_BITRATE = '96k';
  const TARGET_HEIGHT = 720;
  const CRF = 32; // איכות VP9 (ערך נמוך = איכות גבוהה)

  let ffmpegInstance = null;
  let isLoading = false;
  let loadPromise = null;

  // חלק דחיסת וידאו – בדיקת תמיכה ב-WebCodecs
  function isWebCodecsSupported() {
    return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
  }

  // חלק דחיסת וידאו – טעינת ffmpeg.wasm (Singleton)
  async function loadFFmpeg() {
    if (ffmpegInstance) return ffmpegInstance;
    if (isLoading) return loadPromise;

    isLoading = true;
    loadPromise = (async () => {
      try {
        // ניסיון לטעון מ-CDN
        const { createFFmpeg, fetchFile } = window.FFmpeg || {};
        if (!createFFmpeg) {
          throw new Error('FFmpeg library not loaded. Include ffmpeg.wasm script.');
        }

        const ffmpeg = createFFmpeg({
          log: false,
          corePath: 'https://unpkg.com/@ffmpeg/core@0.10.0/dist/ffmpeg-core.js', // גרסה ישנה יותר
        });

        await ffmpeg.load();
        ffmpegInstance = ffmpeg;
        console.log('FFmpeg loaded successfully');
        return ffmpeg;
      } catch (err) {
        console.error('Failed to load FFmpeg', err);
        isLoading = false;
        // אם ffmpeg נכשל, ננסה WebCodecs
        if (isWebCodecsSupported()) {
          console.log('Falling back to WebCodecs API');
          return null; // סימן ש-WebCodecs ישמש
        }
        throw new Error('לא ניתן לטעון את מנוע הדחיסה. נסה לרענן את הדף.');
      }
    })();

    return loadPromise;
  }

  // חלק דחיסת וידאו – בדיקת גודל קלט
  function validateInputSize(file) {
    if (!file) {
      throw new Error('לא נבחר קובץ');
    }
    if (file.size > MAX_INPUT_SIZE) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      throw new Error(`הקובץ גדול מדי (${sizeMB}MB). מקסימום ${(MAX_INPUT_SIZE / (1024 * 1024)).toFixed(0)}MB.`);
    }
    if (!file.type.startsWith('video/')) {
      throw new Error('הקובץ אינו וידאו תקין');
    }
  }

  // חלק דחיסת וידאו – חישוב SHA-256 hash
  async function calculateHash(blob) {
    try {
      const buffer = await blob.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      return hashHex;
    } catch (err) {
      console.warn('Hash calculation failed', err);
      return '';
    }
  }

  function isDesktopCaptureSupported() {
    if (typeof navigator === 'undefined') return false;
    const isMobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || '');
    const proto = HTMLMediaElement.prototype;
    return !isMobile && typeof MediaRecorder !== 'undefined' && (proto.captureStream || proto.mozCaptureStream);
  }

  function getAdaptiveBitrates(fileSize, durationSeconds) {
    const safeDuration = Math.max(durationSeconds || 1, 0.5);
    const originalTotalBps = (fileSize * 8) / safeDuration;
    const minVideo = 250_000;
    const maxVideo = 900_000;
    const minAudio = 48_000;
    const maxAudio = 96_000;

    let videoBps = Math.round(originalTotalBps * 0.8);
    videoBps = Math.min(Math.max(videoBps, minVideo), maxVideo);

    let audioBps = Math.round(originalTotalBps * 0.12);
    audioBps = Math.min(Math.max(audioBps, minAudio), maxAudio);

    if (videoBps + audioBps > originalTotalBps) {
      const scale = originalTotalBps / (videoBps + audioBps);
      videoBps = Math.max(minVideo, Math.round(videoBps * scale));
      audioBps = Math.max(minAudio, Math.round(audioBps * scale));
    }

    return { videoBps, audioBps };
  }

  // חלק דחיסת וידיאו – דחיסה מהירה לדסקטופ דרך captureStream
  async function compressWithDirectRecorder(file, onProgress) {
    console.log('משתמש ב-captureStream דסקטופ עם אודיו מקורי...');

    if (typeof onProgress === 'function') {
      onProgress({ stage: 'loading', percent: 0 });
    }

    const video = document.createElement('video');
    video.style.display = 'none';
    video.preload = 'metadata';
    video.crossOrigin = 'anonymous';
    video.src = URL.createObjectURL(file);
    video.muted = true;
    video.defaultMuted = true;
    video.volume = 0;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    document.body.appendChild(video);

    try {
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = () => reject(new Error('Failed to load video metadata'));
        setTimeout(() => reject(new Error('Timeout loading video metadata')), 10000);
      });
    } catch (err) {
      URL.revokeObjectURL(video.src);
      document.body.removeChild(video);
      throw err;
    }

    const capture = video.captureStream ? video.captureStream() : video.mozCaptureStream?.();
    if (!capture) {
      URL.revokeObjectURL(video.src);
      document.body.removeChild(video);
      throw new Error('captureStream not supported');
    }

    const duration = Math.max(video.duration || 1, 0.5);
    const { videoBps, audioBps } = getAdaptiveBitrates(file.size, duration);

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';

    const recorder = new MediaRecorder(capture, {
      mimeType,
      videoBitsPerSecond: videoBps,
      audioBitsPerSecond: audioBps,
    });

    console.log('Desktop recorder bitrates:', {
      duration,
      originalMB: (file.size / (1024 * 1024)).toFixed(2),
      videoBps,
      audioBps,
    });

    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) {
        chunks.push(event.data);
      }
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

    recorder.start(100);
    await video.play();

    await new Promise((resolve) => {
      video.onended = () => {
        clearInterval(progressTimer);
        setTimeout(() => recorder.stop(), 100);
        resolve();
      };
    });

    await finished;
    URL.revokeObjectURL(video.src);
    document.body.removeChild(video);

    if (typeof onProgress === 'function') {
      onProgress({ stage: 'finalizing', percent: 95 });
    }

    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size >= file.size) {
      console.warn('Direct capture produced larger file, aborting and falling back');
      throw new Error('direct-result-larger');
    }
    const hash = await calculateHash(blob);

    if (typeof onProgress === 'function') {
      onProgress({ stage: 'complete', percent: 100 });
    }

    return {
      blob,
      hash,
      size: blob.size,
      type: mimeType,
      originalSize: file.size,
      compressionRatio: ((1 - blob.size / file.size) * 100).toFixed(1),
    };
  }

  // חלק דחיסת וידיאו – דחיסה פשוטה ויעילה למובייל עם אודיו
  async function compressWithCanvas(file, onProgress) {
    console.log('משתמש בדחיסה פשוטה לווידיאו עם אודיו...');
    
    if (typeof onProgress === 'function') {
      onProgress({ stage: 'preparing', percent: 5 });
    }

    // יצירת video element והמתנה לטעינה
    const video = document.createElement('video');
    video.muted = true; // דרוש כדי לאפשר autoplay במובייל
    video.defaultMuted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.crossOrigin = 'anonymous';
    video.volume = 0;
    video.style.position = 'fixed';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.top = '0';
    video.style.left = '0';
    document.body.appendChild(video); // מוסיפים ל-DOM כדי שיעבוד
    
    const videoUrl = URL.createObjectURL(file);
    video.src = videoUrl;

    // המתנה לטעינת המטא דאטה
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout loading video metadata'));
      }, 10000);

      video.onloadedmetadata = () => {
        clearTimeout(timeout);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Failed to load video metadata'));
      };
    });

    if (typeof onProgress === 'function') {
      onProgress({ stage: 'setup', percent: 10 });
    }

    // חישוב גודל חדש - מינימום 720x540 עם שמירה על יחס
    const minSize = 720;
    let canvasWidth, canvasHeight;
    
    // חישוב יחס המקורי
    const aspectRatio = video.videoWidth / video.videoHeight;
    
    if (video.videoWidth > video.videoHeight) {
      // וידיאו אופקי
      canvasWidth = Math.max(minSize, Math.floor(minSize * aspectRatio));
      canvasHeight = minSize;
    } else {
      // וידיאו אנכי או ריבועי
      canvasWidth = minSize;
      canvasHeight = Math.max(minSize, Math.floor(minSize / aspectRatio));
    }
    
    // הגבלת גודל מקסימלי לאיכות טובה יותר
    const maxSize = 1280;
    if (canvasWidth > maxSize) {
      canvasWidth = maxSize;
      canvasHeight = Math.floor(maxSize / aspectRatio);
    }
    if (canvasHeight > maxSize) {
      canvasHeight = maxSize;
      canvasWidth = Math.floor(maxSize * aspectRatio);
    }

    console.log('גדלים מקוריים:', { width: video.videoWidth, height: video.videoHeight });
    console.log('גדלים חדשים:', { width: canvasWidth, height: canvasHeight });

    // יצירת canvas
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');

    if (typeof onProgress === 'function') {
      onProgress({ stage: 'compressing', percent: 20 });
    }

    // פונקציית ציור פריימים
    const drawFrame = () => {
      ctx.drawImage(video, 0, 0, canvasWidth, canvasHeight);
    };

    // המתנה להתחלת הווידיאו
    await new Promise((resolve, reject) => {
      video.onplay = () => resolve();
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err) => {
          console.warn('autoplay blocked, retrying muted playback', err);
          video.muted = true;
          video.volume = 0;
          video.play().catch(() => reject(new Error('Failed to start video playback')));
        });
      }
      setTimeout(() => reject(new Error('Timeout starting video playback')), 10000);
    });

    // ניסיון להשתמש ב-WebCodecs API אם זמין
    if (typeof VideoEncoder !== 'undefined') {
      console.log('מנסה להשתמש ב-WebCodecs API עם אודיו...');
      try {
        return await compressWithWebCodecs(video, canvas, canvasWidth, canvasHeight, file, onProgress);
      } catch (err) {
        console.warn('WebCodecs נכשל, עובר ל-MediaRecorder:', err);
      }
    }

    // חזרה ל-MediaRecorder עם אודיו מקורי בלבד
    console.log('משתמש ב-MediaRecorder עם אודיו מקורי בלבד...');
    
    // יצירת stream מה-canvas
    const canvasStream = canvas.captureStream(30);
    
    // ניסיון לחלץ אודיו מקורי מהווידיאו element עצמו
    let audioAdded = false;
    
    try {
      // חיפוש אחר אודיו מקורי ב-wrapped stream
      if (video.captureStream) {
        const videoStream = video.captureStream();
        const audioTracks = videoStream.getAudioTracks();
        
        if (audioTracks.length > 0) {
          audioTracks.forEach(track => {
            canvasStream.addTrack(track);
          });
          audioAdded = true;
          console.log('מצאתי אודיו מקורי מהווידיאו!');
        }
      }
    } catch (captureErr) {
      console.warn('לא הצליח לחלץ אודיו מהווידיאו:', captureErr);
    }
    
    // אם לא מצאנו אודיו מקורי, נשתמש ב-Web Audio API
    if (!audioAdded) {
      try {
        const audioContext = new AudioContext();
        const source = audioContext.createMediaElementSource(video);
        const destination = audioContext.createMediaStreamDestination();
        source.connect(destination);
        
        const audioTrack = destination.stream.getAudioTracks()[0];
        if (audioTrack) {
          canvasStream.addTrack(audioTrack);
          audioAdded = true;
          console.log('הוספתי אודיו דרך Web Audio API!');
        }
      } catch (audioErr) {
        console.warn('Web Audio API נכשל:', audioErr);
      }
    }
    
    if (!audioAdded) {
      console.warn('לא הצליח להוסיף אודיו - הווידיאו יהיה שקט');
    }

    const recorder = new MediaRecorder(canvasStream, {
      mimeType: audioAdded ? 'video/webm;codecs=vp9,opus' : 'video/webm;codecs=vp9',
      videoBitsPerSecond: 500000, // 0.5 Mbps
      audioBitsPerSecond: audioAdded ? 64000 : undefined,  // 64 kbps רק אם יש אודיו
    });

    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    // התחלת הקלטה והפעלת וידיאו מיד
    recorder.start(100);
    video.play();
    
    console.log('התחלתי הקלטה ווידיאו במקביל');

    // ציור פריימים מסונכרן עם requestAnimationFrame
    let frameCount = 0;
    const targetFPS = 30;
    const frameInterval = 1000 / targetFPS;
    let lastFrameTime = 0;
    
    function drawFrameSync(currentTime) {
      if (video.ended || video.paused) {
        return;
      }
      
      // ציור פריים רק בקצב הרצוי
      if (currentTime - lastFrameTime >= frameInterval) {
        ctx.drawImage(video, 0, 0, canvasWidth, canvasHeight);
        lastFrameTime = currentTime;
        frameCount++;
        
        if (typeof onProgress === 'function') {
          const progress = Math.min(90, (video.currentTime / video.duration) * 90);
          onProgress({ stage: 'compressing', percent: progress });
        }
      }
      
      requestAnimationFrame(drawFrameSync);
    }
    
    // התחלת ציור מסונכרן
    requestAnimationFrame(drawFrameSync);

    // המתנה לסיום הווידיאו עם טיימאאוט דינמי
    const safetyTimeout = Math.min(
      Math.max(((video.duration || 0) * 1000) + 5000, 45000),
      180000
    );

    await Promise.race([
      new Promise((resolve) => {
        video.onended = () => {
          // פריים אחרון
          ctx.drawImage(video, 0, 0, canvasWidth, canvasHeight);
          setTimeout(() => {
            recorder.stop();
          }, 100);
        };
        recorder.onstop = resolve;
      }),
      new Promise((resolve) => {
        setTimeout(() => {
          console.warn('טיימאאוט של דחיסה - מפסיק אחרי', safetyTimeout, 'ms');
          recorder.stop();
          resolve();
        }, safetyTimeout);
      })
    ]);

    // ניקוי
    URL.revokeObjectURL(videoUrl);
    document.body.removeChild(video); // מסירים את הווידיאו מה-DOM

    // יצירת ה-blob
    const blob = new Blob(chunks, { type: 'video/webm' });
    
    if (blob.size === 0) {
      console.warn('Canvas compression failed - returning original file');
      return {
        blob: file,
        hash: await calculateHash(file),
        size: file.size,
        type: file.type,
        originalSize: file.size,
        compressionRatio: '0.0',
      };
    }

    const hash = await calculateHash(blob);

    if (typeof onProgress === 'function') {
      onProgress({ stage: 'complete', percent: 100 });
    }
    
    console.log('דחיסה הושלמה עם אודיו:', {
      original: (file.size / 1024 / 1024).toFixed(2) + 'MB',
      compressed: (blob.size / 1024 / 1024).toFixed(2) + 'MB',
      ratio: ((1 - blob.size / file.size) * 100).toFixed(1) + '%'
    });

    return {
      blob,
      hash,
      size: blob.size,
      type: 'video/webm',
      originalSize: file.size,
      compressionRatio: ((1 - blob.size / file.size) * 100).toFixed(1),
    };
  }

  // פונקציית עזר ל-WebCodecs API
  async function compressWithWebCodecs(video, canvas, canvasWidth, canvasHeight, file, onProgress) {
    // זו פונקציה מורכבת יותר שתוכל לעבוד עם אודיו טוב יותר
    // לעת עתה נחזור ל-MediaRecorder
    throw new Error('WebCodecs not implemented yet');
  }

  // חלק דחיסת וידאו – פונקציה ראשית לדחיסה והמרה
  async function compressVideo(file, onProgress) {
    validateInputSize(file);

    // קודם כל, אם מדובר בדסקטופ שתומך captureStream – נעדיף את זה
    if (isDesktopCaptureSupported()) {
      try {
        return await compressWithDirectRecorder(file, onProgress);
      } catch (desktopErr) {
        console.warn('Direct desktop capture failed, falling back to FFmpeg/Canvas:', desktopErr);
      }
    }

    // נסה לטעון FFmpeg
    try {
      const ffmpeg = await loadFFmpeg();
      
      // אם ffmpeg לא זמין, נשתמש ב-Canvas
      if (!ffmpeg) {
        console.log('Using Canvas API fallback for video compression');
        return await compressWithCanvas(file, onProgress);
      }
      
      // כתיבת קובץ קלט ל-FS של ffmpeg
      if (typeof onProgress === 'function') {
        onProgress({ stage: 'loading', percent: 0 });
      }

      const inputData = await window.FFmpeg.fetchFile(file);
      ffmpeg.FS('writeFile', inputName, inputData);

      if (typeof onProgress === 'function') {
        onProgress({ stage: 'compressing', percent: 10 });
      }

      // הרצת פקודת FFmpeg
      await ffmpeg.run(
        '-i', inputName,
        '-vf', `scale=-2:${TARGET_HEIGHT}`,
        '-c:v', 'libvpx-vp9',
        '-b:v', TARGET_BITRATE,
        '-crf', String(CRF),
        '-c:a', 'libopus',
        '-b:a', AUDIO_BITRATE,
        '-movflags', '+faststart',
        outputName
      );

      if (typeof onProgress === 'function') {
        onProgress({ stage: 'finalizing', percent: 90 });
      }

      const data = ffmpeg.FS('readFile', outputName);
      const blob = new Blob([data.buffer], { type: 'video/webm' });

      try {
        ffmpeg.FS('unlink', inputName);
        ffmpeg.FS('unlink', outputName);
      } catch (cleanupErr) {
        console.warn('Cleanup failed', cleanupErr);
      }

      const hash = await calculateHash(blob);

      if (typeof onProgress === 'function') {
        onProgress({ stage: 'complete', percent: 100 });
      }

      const result = {
        blob,
        hash,
        size: blob.size,
        type: 'video/webm',
        originalSize: file.size,
        compressionRatio: ((1 - blob.size / file.size) * 100).toFixed(1),
      };

      console.log('Video compression complete:', {
        original: (file.size / (1024 * 1024)).toFixed(2) + 'MB',
        compressed: (blob.size / (1024 * 1024)).toFixed(2) + 'MB',
        ratio: result.compressionRatio + '%',
        hash: hash.slice(0, 16) + '...',
      });

      return result;
    } catch (err) {
      console.error('FFmpeg compression failed, switching fallback:', err);
      return await compressWithCanvas(file, onProgress);
    }
  }

  // חלק דחיסת וידאו – בדיקת תמיכה
  function isSupported() {
    return !!(window.FFmpeg || typeof MediaRecorder !== 'undefined');
  }

  // חשיפה ל-App
  Object.assign(App, {
    compressVideo,
    isVideoCompressionSupported: isSupported,
    loadVideoCompressor: loadFFmpeg,
  });

  console.log('Video compressor module initialized');
})(window);
