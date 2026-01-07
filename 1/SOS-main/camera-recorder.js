// חלק מצלמה (camera-recorder.js) – מודול הקלטת וידאו מהמצלמה עם בחירת זמן ומעבר בין מצלמות
// שייך: SOS2 מדיה, מטפל בצילום וידאו ישיר מהמצלמה | HYPER CORE TECH
(function initCameraRecorder(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  let currentStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordingTimer = null;
  let currentFacingMode = 'user'; // 'user' = קדמית, 'environment' = אחורית

  // חלק מצלמה – קבלת stream מהמצלמה עם constraints מתקדמים
  async function getCameraStream(facingMode = 'user') {
    const constraints = {
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: 30, max: 30 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000
      }
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
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

    // בחירת codec הטוב ביותר
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
      : MediaRecorder.isTypeSupported('video/webm')
      ? 'video/webm'
      : '';

    if (!mimeType) {
      throw new Error('הדפדפן לא תומך בהקלטת וידאו');
    }

    try {
      mediaRecorder = new MediaRecorder(currentStream, {
        mimeType,
        videoBitsPerSecond: 2500000, // 2.5 Mbps
        audioBitsPerSecond: 128000   // 128 kbps
      });

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
        elapsed += 0.1;
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
      }, 100);

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
