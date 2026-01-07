// חלק דחיסת וידאו (video-compressor.js) – מודול לדחיסה והמרה ל-MP4/WEBM בצד הלקוח
// שייך: SOS2 מדיה, תומך במובייל iOS ואנדרואיד עם איכות גבוהה
(function initVideoCompressor(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק דחיסת וידאו – הגדרות ומגבלות
  const MAX_INPUT_SIZE = 100 * 1024 * 1024; // 100MB
  const TARGET_HEIGHT = 720;
  const TARGET_FPS = 30;
  
  // הגדרות bitrate דינמיות - מותאמות לאיכות טובה
  const MIN_VIDEO_BITRATE = 800_000;   // 800kbps מינימום
  const MAX_VIDEO_BITRATE = 2_500_000; // 2.5Mbps מקסימום
  const MIN_AUDIO_BITRATE = 96_000;    // 96kbps מינימום
  const MAX_AUDIO_BITRATE = 192_000;   // 192kbps מקסימום

  let ffmpegInstance = null;
  let isLoading = false;
  let loadPromise = null;

  // חלק דחיסת וידאו – זיהוי מכשיר ודפדפן
  function getDeviceInfo() {
    const ua = navigator.userAgent || '';
    const isIOS = /iphone|ipad|ipod/i.test(ua);
    const isAndroid = /android/i.test(ua);
    const isSafari = /safari/i.test(ua) && !/chrome|chromium|crios/i.test(ua);
    const isMobile = isIOS || isAndroid || /mobile/i.test(ua);
    return { isIOS, isAndroid, isSafari, isMobile };
  }

  // חלק דחיסת וידאו – בחירת codec מתאים למכשיר
  function getBestCodec() {
    const { isIOS, isSafari } = getDeviceInfo();
    
    // iOS/Safari לא תומכים ב-VP9 - נשתמש ב-H.264
    if (isIOS || isSafari) {
      if (MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')) {
        return { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', container: 'mp4' };
      }
      if (MediaRecorder.isTypeSupported('video/mp4')) {
        return { mimeType: 'video/mp4', container: 'mp4' };
      }
    }
    
    // VP9 עם Opus - הכי טוב לדחיסה
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) {
      return { mimeType: 'video/webm;codecs=vp9,opus', container: 'webm' };
    }
    // VP8 עם Opus - fallback
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) {
      return { mimeType: 'video/webm;codecs=vp8,opus', container: 'webm' };
    }
    // H.264 עם AAC
    if (MediaRecorder.isTypeSupported('video/webm;codecs=h264,opus')) {
      return { mimeType: 'video/webm;codecs=h264,opus', container: 'webm' };
    }
    // ברירת מחדל
    return { mimeType: 'video/webm', container: 'webm' };
  }

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

  // חלק דחיסת וידאו – חישוב bitrate דינמי חכם
  function getAdaptiveBitrates(fileSize, durationSeconds, targetCompressionRatio = 0.3) {
    const safeDuration = Math.max(durationSeconds || 1, 0.5);
    const originalBps = (fileSize * 8) / safeDuration;
    
    // מטרה: להקטין לכ-30% מהגודל המקורי תוך שמירה על איכות
    const targetTotalBps = originalBps * targetCompressionRatio;
    
    // חלוקה: 85% לוידאו, 15% לאודיו
    let videoBps = Math.round(targetTotalBps * 0.85);
    let audioBps = Math.round(targetTotalBps * 0.15);
    
    // הגבלות מינימום/מקסימום לאיכות טובה
    videoBps = Math.min(Math.max(videoBps, MIN_VIDEO_BITRATE), MAX_VIDEO_BITRATE);
    audioBps = Math.min(Math.max(audioBps, MIN_AUDIO_BITRATE), MAX_AUDIO_BITRATE);
    
    // אם הקובץ המקורי קטן - לא נדחוס יותר מדי
    if (originalBps < MIN_VIDEO_BITRATE + MIN_AUDIO_BITRATE) {
      videoBps = Math.round(originalBps * 0.85);
      audioBps = Math.round(originalBps * 0.15);
    }
    
    console.log('[COMPRESS] Adaptive bitrates:', {
      originalMbps: (originalBps / 1_000_000).toFixed(2),
      targetMbps: ((videoBps + audioBps) / 1_000_000).toFixed(2),
      videoBps,
      audioBps,
      expectedRatio: ((videoBps + audioBps) / originalBps * 100).toFixed(1) + '%'
    });

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

    // חזרה ל-MediaRecorder עם אודיו מקורי - משופר לאיכות גבוהה
    console.log('[COMPRESS] משתמש ב-MediaRecorder משופר...');
    
    const { isIOS, isSafari, isMobile } = getDeviceInfo();
    const { mimeType, container } = getBestCodec();
    const duration = video.duration || 1;
    const { videoBps, audioBps } = getAdaptiveBitrates(file.size, duration);
    
    console.log('[COMPRESS] Selected codec:', { mimeType, container, isIOS, isSafari });
    
    // יצירת stream מה-canvas עם FPS קבוע
    const canvasStream = canvas.captureStream(TARGET_FPS);
    
    // ניסיון לחלץ אודיו מקורי מהווידיאו
    let audioAdded = false;
    let audioContext = null;
    
    try {
      // שיטה 1: captureStream ישירות מהווידאו
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

    // יצירת MediaRecorder עם הגדרות מותאמות
    const recorderOptions = {
      mimeType,
      videoBitsPerSecond: videoBps,
      audioBitsPerSecond: audioAdded ? audioBps : undefined,
    };
    
    console.log('[COMPRESS] MediaRecorder options:', recorderOptions);
    
    const recorder = new MediaRecorder(canvasStream, recorderOptions);

    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    // ציור פריימים מסונכרן עם setInterval - יותר עקבי מ-requestAnimationFrame
    const frameInterval = 1000 / TARGET_FPS;
    let frameCount = 0;
    let drawInterval = null;
    
    function startDrawing() {
      // ציור ראשוני
      ctx.drawImage(video, 0, 0, canvasWidth, canvasHeight);
      frameCount++;
      
      // ציור מתוזמן בקצב קבוע
      drawInterval = setInterval(() => {
        if (video.ended || video.paused) {
          if (drawInterval) clearInterval(drawInterval);
          return;
        }
        
        ctx.drawImage(video, 0, 0, canvasWidth, canvasHeight);
        frameCount++;
        
        if (typeof onProgress === 'function') {
          const progress = Math.min(90, 20 + (video.currentTime / video.duration) * 70);
          onProgress({ stage: 'compressing', percent: Math.round(progress) });
        }
      }, frameInterval);
    }

    // התחלת הקלטה והפעלת וידיאו מיד
    recorder.start(100);
    video.currentTime = 0;
    await video.play();
    startDrawing();
    
    console.log('[COMPRESS] התחלתי הקלטה ווידיאו במקביל, FPS:', TARGET_FPS);

    // המתנה לסיום הווידיאו עם טיימאאוט דינמי
    const safetyTimeout = Math.min(
      Math.max(((video.duration || 0) * 1000) + 5000, 45000),
      180000
    );

    await Promise.race([
      new Promise((resolve) => {
        video.onended = () => {
          // עצירת ציור
          if (drawInterval) clearInterval(drawInterval);
          // פריים אחרון
          ctx.drawImage(video, 0, 0, canvasWidth, canvasHeight);
          frameCount++;
          setTimeout(() => {
            recorder.stop();
          }, 200);
        };
        recorder.onstop = resolve;
      }),
      new Promise((resolve) => {
        setTimeout(() => {
          console.warn('[COMPRESS] טיימאאוט - מפסיק אחרי', safetyTimeout, 'ms');
          if (drawInterval) clearInterval(drawInterval);
          recorder.stop();
          resolve();
        }, safetyTimeout);
      })
    ]);

    // ניקוי משאבים
    if (drawInterval) clearInterval(drawInterval);
    if (audioContext) {
      try { audioContext.close(); } catch (_) {}
    }
    URL.revokeObjectURL(videoUrl);
    document.body.removeChild(video);
    
    console.log('[COMPRESS] סה"כ פריימים שצוירו:', frameCount);

    // יצירת ה-blob עם סוג הקובץ הנכון
    const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
    
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
    
    const compressionRatio = ((1 - blob.size / file.size) * 100).toFixed(1);
    const outputType = container === 'mp4' ? 'video/mp4' : 'video/webm';
    
    console.log('[COMPRESS] דחיסה הושלמה:', {
      original: (file.size / 1024 / 1024).toFixed(2) + 'MB',
      compressed: (blob.size / 1024 / 1024).toFixed(2) + 'MB',
      ratio: compressionRatio + '%',
      frames: frameCount,
      duration: duration.toFixed(1) + 's',
      effectiveFPS: (frameCount / duration).toFixed(1),
      outputType
    });

    // אם הקובץ גדל במקום להתכווץ - נחזיר את המקורי
    if (blob.size >= file.size) {
      console.warn('[COMPRESS] הקובץ גדל! מחזיר מקורי');
      return {
        blob: file,
        hash: await calculateHash(file),
        size: file.size,
        type: file.type,
        originalSize: file.size,
        compressionRatio: '0.0',
      };
    }

    return {
      blob,
      hash,
      size: blob.size,
      type: outputType,
      originalSize: file.size,
      compressionRatio,
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
    
    const { isIOS, isMobile } = getDeviceInfo();
    
    console.log('[COMPRESS] Starting compression:', {
      fileName: file.name,
      fileSize: (file.size / 1024 / 1024).toFixed(2) + 'MB',
      fileType: file.type,
      isIOS,
      isMobile
    });

    // במובייל - תמיד נשתמש ב-Canvas (FFmpeg לא עובד טוב ב-iOS)
    if (isMobile) {
      console.log('[COMPRESS] Mobile detected - using Canvas compression');
      return await compressWithCanvas(file, onProgress);
    }

    // בדסקטופ - נעדיף captureStream אם זמין
    if (isDesktopCaptureSupported()) {
      try {
        return await compressWithDirectRecorder(file, onProgress);
      } catch (desktopErr) {
        console.warn('[COMPRESS] Desktop capture failed:', desktopErr);
      }
    }

    // Fallback ל-Canvas (FFmpeg לא אמין מספיק)
    console.log('[COMPRESS] Using Canvas fallback');
    return await compressWithCanvas(file, onProgress);
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
