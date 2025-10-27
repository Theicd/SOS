// חלק דחיסת וידאו (video-compressor.js) – מודול לדחיסה והמרה ל-WEBM 720p בצד הלקוח
// שייך: SOS2 מדיה, משתמש ב-ffmpeg.wasm לעיבוד וידאו בדפדפן
(function initVideoCompressor(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק דחיסת וידאו – הגדרות ומגבלות
  const MAX_INPUT_SIZE = 30 * 1024 * 1024; // 30MB
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
      throw new Error(`הקובץ גדול מדי (${sizeMB}MB). מקסימום 30MB.`);
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

  // חלק דחיסת וידאו – דחיסה עם captureStream מה-video element
  async function compressWithMediaRecorder(file, onProgress) {
    console.log('משתמש ב-MediaRecorder לדחיסת וידאו עם אודיו...');

    if (typeof onProgress === 'function') {
      onProgress({ stage: 'loading', percent: 0 });
    }

    // בדיקה אם MediaRecorder נתמך
    if (typeof MediaRecorder === 'undefined') {
      console.warn('MediaRecorder לא נתמך - מחזיר קובץ מקורי');
      const hash = await calculateHash(file);
      return {
        blob: file,
        hash,
        size: file.size,
        type: file.type,
        originalSize: file.size,
        compressionRatio: '0.0',
      };
    }

    // יצירת video element
    const video = document.createElement('video');
    video.src = URL.createObjectURL(file);
    video.muted = false; // חשוב! לא muted כדי שהאודיו ייכלל ב-stream
    video.volume = 0; // אבל נשתיק את הרמקולים
    video.playsInline = true;

    try {
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = () => reject(new Error('נכשלה טעינת הוידאו'));
        setTimeout(() => reject(new Error('Timeout loading video')), 10000);
      });
    } catch (err) {
      console.error('נכשלה טעינת הוידאו:', err);
      URL.revokeObjectURL(video.src);
      const hash = await calculateHash(file);
      return {
        blob: file,
        hash,
        size: file.size,
        type: file.type,
        originalSize: file.size,
        compressionRatio: '0.0',
      };
    }

    if (typeof onProgress === 'function') {
      onProgress({ stage: 'compressing', percent: 10 });
    }

    // קבלת stream ישירות מה-video (כולל אודיו!)
    let stream;
    try {
      if (typeof video.captureStream === 'function') {
        stream = video.captureStream();
      } else if (typeof video.mozCaptureStream === 'function') {
        stream = video.mozCaptureStream();
      } else {
        throw new Error('captureStream not supported');
      }
    } catch (err) {
      console.warn('לא ניתן להשתמש ב-captureStream (טלפון?):', err);
      URL.revokeObjectURL(video.src);
      // חזרה לקובץ המקורי
      const hash = await calculateHash(file);
      if (typeof onProgress === 'function') {
        onProgress({ stage: 'complete', percent: 100 });
      }
      console.log('משתמש בקובץ מקורי (טלפון)');
      return {
        blob: file,
        hash,
        size: file.size,
        type: file.type,
        originalSize: file.size,
        compressionRatio: '0.0',
      };
    }

    console.log('Stream tracks:', {
      video: stream.getVideoTracks().length,
      audio: stream.getAudioTracks().length
    });

    // הגדרות MediaRecorder
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') 
      ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
      : 'video/webm';

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 1000000, // 1 Mbps
      audioBitsPerSecond: 96000,   // 96 kbps
    });

    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    // התחלת ההקלטה
    recorder.start(100); // איסוף דאטה כל 100ms
    video.play();

    // עדכון progress
    const duration = video.duration;
    const progressInterval = setInterval(() => {
      if (video.paused || video.ended) return;
      const percent = Math.min(90, 10 + (video.currentTime / duration) * 80);
      if (typeof onProgress === 'function') {
        onProgress({ stage: 'compressing', percent: Math.round(percent) });
      }
    }, 500);

    // המתנה לסיום
    await new Promise((resolve) => {
      video.onended = () => {
        clearInterval(progressInterval);
        setTimeout(() => {
          recorder.stop();
        }, 100);
      };
      recorder.onstop = resolve;
    });

    URL.revokeObjectURL(video.src);

    if (typeof onProgress === 'function') {
      onProgress({ stage: 'finalizing', percent: 95 });
    }

    const blob = new Blob(chunks, { type: mimeType });
    const hash = await calculateHash(blob);

    if (typeof onProgress === 'function') {
      onProgress({ stage: 'complete', percent: 100 });
    }

    console.log('דחיסה הושלמה:', {
      original: (file.size / 1024 / 1024).toFixed(2) + 'MB',
      compressed: (blob.size / 1024 / 1024).toFixed(2) + 'MB',
      ratio: ((1 - blob.size / file.size) * 100).toFixed(1) + '%'
    });

    return {
      blob,
      hash,
      size: blob.size,
      type: mimeType,
      originalSize: file.size,
      compressionRatio: ((1 - blob.size / file.size) * 100).toFixed(1),
    };
  }

  // חלק דחיסת וידאו – פונקציה ראשית לדחיסה והמרה
  async function compressVideo(file, onProgress) {
    validateInputSize(file);

    const ffmpeg = await loadFFmpeg();
    
    // אם ffmpeg לא זמין, השתמש ב-MediaRecorder fallback
    if (!ffmpeg) {
      console.log('Using MediaRecorder fallback for video compression');
      return await compressWithMediaRecorder(file, onProgress);
    }

    const inputName = 'input' + (file.name.match(/\.\w+$/) || ['.mp4'])[0];
    const outputName = 'output.webm';

    try {
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
      console.error('Video compression failed', err);
      try {
        ffmpeg.FS('unlink', inputName);
        ffmpeg.FS('unlink', outputName);
      } catch {}
      throw new Error('דחיסת הוידאו נכשלה. נסה קובץ אחר או רענן את הדף.');
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
