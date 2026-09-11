// חלק מצלמה (camera-recorder.js) – מודול הקלטת וידאו מהמצלמה עם בחירת זמן ומעבר בין מצלמות
// שייך: SOS2 מדיה, מטפל בצילום וידאו ישיר מהמצלמה | HYPER CORE TECH
(function initCameraRecorder(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  let currentStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordingTimer = null;
  let currentFacingMode = 'user'; // 'user' = קדמית, 'environment' = אחורית

  function pickRecorderMime() {
    const canCheck = typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function';
    const candidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    if (!canCheck) return 'video/webm';
    for (let i = 0; i < candidates.length; i += 1) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  // חלק מצלמה – קבלת stream מהמצלמה עם constraints קלים למובייל
  async function getCameraStream(facingMode = 'user') {
    const constraints = {
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 720, max: 1280 },
        height: { ideal: 720, max: 1280 },
        frameRate: { ideal: 30, max: 30 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = stream.getVideoTracks()[0];
      if (track) {
        try { track.contentHint = 'motion'; } catch (_) {}
      }
      return stream;
    } catch (err) {
      console.error('Failed to get camera stream:', err);
      // נסיון עם constraints פשוטים יותר
      try {
        const simpleConstraints = {
          video: { facingMode: facingMode },
          audio: true
        };
        return await navigator.mediaDevices.getUserMedia(simpleConstraints);
      } catch (fallbackErr) {
        throw new Error('לא ניתן לגשת למצלמה. אנא אפשר גישה למצלמה בהגדרות הדפדפן.');
      }
    }
  }

  // חלק מצלמה – החלפה בין מצלמה קדמית ואחורית
  async function switchCamera() {
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    
    if (currentStream) {
      currentStream.getTracks().forEach(track => track.stop());
    }

    try {
      currentStream = await getCameraStream(currentFacingMode);
      return { stream: currentStream, facingMode: currentFacingMode };
    } catch (err) {
      console.error('Failed to switch camera:', err);
      throw err;
    }
  }

  // חלק מצלמה – התחלת הקלטה עם טיימר
  async function startRecording(durationSeconds, onProgress) {
    if (!currentStream) {
      throw new Error('אין stream פעיל. יש לפתוח את המצלמה תחילה.');
    }

    recordedChunks = [];

    // בחירת codec קל למובייל (H.264 / VP8, לא VP9)
    const mimeType = pickRecorderMime();

    if (!mimeType && typeof MediaRecorder === 'undefined') {
      throw new Error('הדפדפן לא תומך בהקלטת וידאו');
    }

    try {
      const recorderOpts = {
        videoBitsPerSecond: 1500000,
        audioBitsPerSecond: 96000
      };
      if (mimeType) recorderOpts.mimeType = mimeType;
      try {
        mediaRecorder = new MediaRecorder(currentStream, recorderOpts);
      } catch (_) {
        mediaRecorder = mimeType
          ? new MediaRecorder(currentStream, { mimeType })
          : new MediaRecorder(currentStream);
      }

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        if (recordingTimer) {
          clearInterval(recordingTimer);
          recordingTimer = null;
        }
      };

      // התחלת הקלטה
      mediaRecorder.start(1000); // chunk כל שנייה

      // טיימר לעדכון progress
      let elapsed = 0;
      recordingTimer = setInterval(() => {
        elapsed += 1;
        const progress = Math.min(100, (elapsed / durationSeconds) * 100);
        
        if (typeof onProgress === 'function') {
          onProgress({
            elapsed: elapsed,
            total: durationSeconds,
            percent: Math.round(progress)
          });
        }

        if (elapsed >= durationSeconds) {
          stopRecording();
        }
      }, 1000);

      return true;
    } catch (err) {
      console.error('Failed to start recording:', err);
      throw new Error('נכשל בהתחלת ההקלטה');
    }
  }

  // חלק מצלמה – עצירת הקלטה
  function stopRecording() {
    return new Promise((resolve) => {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        resolve(null);
        return;
      }

      mediaRecorder.onstop = () => {
        if (recordingTimer) {
          clearInterval(recordingTimer);
          recordingTimer = null;
        }

        const mimeType = mediaRecorder.mimeType || 'video/webm';
        const blob = new Blob(recordedChunks, { type: mimeType });
        recordedChunks = [];
        
        resolve(blob);
      };

      mediaRecorder.stop();
    });
  }

  // חלק מצלמה – סגירת המצלמה ושחרור משאבים
  function closeCamera() {
    if (recordingTimer) {
      clearInterval(recordingTimer);
      recordingTimer = null;
    }

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }

    if (currentStream) {
      currentStream.getTracks().forEach(track => track.stop());
      currentStream = null;
    }

    mediaRecorder = null;
    recordedChunks = [];
  }

  // חלק מצלמה – בדיקת תמיכה במצלמה
  function isCameraSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  // חשיפת API
  App.CameraRecorder = {
    getCameraStream,
    switchCamera,
    startRecording,
    stopRecording,
    closeCamera,
    isCameraSupported,
    getCurrentStream: () => currentStream,
    getCurrentFacingMode: () => currentFacingMode
  };

})(window);
