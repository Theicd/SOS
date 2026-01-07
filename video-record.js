// חלק הקלטת וידאו (video-record.js) – ממשק הקלטת וידאו עם טיימר ומצלמה קדמית/אחורית | HYPER CORE TECH

class VideoRecorder {
  constructor() {
    this.stream = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.maxDuration = 60; // מקסימום 60 שניות
    this.isRecording = false;
    this.recordingStartTime = null;
    this.recordingTimer = null;
    this.floatingTimerInterval = null;
    this.currentCamera = 'environment'; // 'user' for front, 'environment' for back
    this.constraints = {
      video: {
        width: { ideal: 1280, max: 1280 },  // 720p מדויק לביצועים
        height: { ideal: 720, max: 720 },    // 720p מדויק לביצועים
        facingMode: this.currentCamera,
        frameRate: { ideal: 30, max: 30 },   // 30fps יציב
        // התאמה למובייל - העדפות לביצועים
        aspectRatio: 16/9,
        // ביטול עיבוד מיותר למהירות
        resizeMode: 'none',
        // אופטימיזציה למובייל
        width: { min: 640, ideal: 1280, max: 1280 },
        height: { min: 480, ideal: 720, max: 720 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000,  // קצב דגימה גבוה יותר לאיכות
        // הגדרות אופטימליות למובייל
        channelCount: 2,   // סטריאו לאיכות טובה יותר
        latency: 0.005     // השהיה נמוכה מאוד
      }
    };
    
    this.initializeElements();
    this.bindEvents();
  }

  initializeElements() {
    this.modal = document.getElementById('videoRecordModal');
    this.recordInterface = document.getElementById('videoRecordInterface');
    this.preview = document.getElementById('videoRecordPreview');
    this.recordButton = document.getElementById('recordButton');
    this.cameraSwitch = document.getElementById('cameraSwitchButton');
    this.timerDisplay = document.getElementById('recordTimer');
    this.floatingTimer = document.getElementById('floatingTimer');
  }

  bindEvents() {
    // כפתור פתיחת הקלטה בקומפוזר
    const recordButton = document.getElementById('composeVideoRecordButton');
    console.log('[VideoRecorder] Looking for composeVideoRecordButton:', recordButton);
    if (recordButton) {
      recordButton.addEventListener('click', (e) => {
        console.log('[VideoRecorder] Record button clicked!');
        e.preventDefault();
        e.stopPropagation();
        this.openModal();
      });
      console.log('[VideoRecorder] Event listener attached to record button');
    } else {
      console.error('[VideoRecorder] composeVideoRecordButton not found!');
    }

    // כפתור הקלטה
    this.recordButton.addEventListener('click', () => {
      console.log('[VideoRecorder] Record button clicked! Current state:', {
        isRecording: this.isRecording,
        hasStream: !!this.stream,
        hasMediaRecorder: !!this.mediaRecorder
      });
      
      if (this.isRecording) {
        this.stopRecording();
      } else {
        this.startRecording();
      }
    });

    // החלפת מצלמה
    this.cameraSwitch.addEventListener('click', () => {
      this.switchCamera();
    });
  }

  openModal() {
    console.log('[VideoRecorder] Opening modal...');
    if (this.modal) {
      console.log('[VideoRecorder] Modal found, adding classes...');
      this.modal.classList.add('is-visible');
      this.modal.setAttribute('aria-hidden', 'false');
      this.resetState();
      // הפעלת מצלמה מיד
      this.startCamera();
      console.log('[VideoRecorder] Modal opened successfully');
    } else {
      console.error('[VideoRecorder] Modal not found!');
    }
  }

  closeModal() {
    if (this.modal) {
      this.modal.classList.remove('is-visible');
      this.modal.setAttribute('aria-hidden', 'true');
      this.stopCamera();
      this.resetState();
    }
  }

  resetState() {
    this.isRecording = false;
    this.recordedChunks = [];
    this.currentCamera = 'environment';
    this.constraints.video.facingMode = this.currentCamera;
    
    // הממשק תמיד גלוי
    if (this.recordInterface) this.recordInterface.style.display = 'block';
    if (this.recordButton) this.recordButton.classList.remove('recording');
    if (this.timerDisplay) this.timerDisplay.textContent = '00:00';
    if (this.floatingTimer) {
      this.floatingTimer.textContent = '00:00';
      this.floatingTimer.classList.remove('visible', 'pulse');
    }
    
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = null;
    }
    
    if (this.floatingTimerInterval) {
      clearInterval(this.floatingTimerInterval);
      this.floatingTimerInterval = null;
    }
  }

  async startCamera() {
    try {
      // עצירת מצלמה קודמת אם קיימת
      if (this.stream) {
        this.stream.getTracks().forEach(track => track.stop());
      }

      // עדכון constraints למצלמה הנוכחית
      this.constraints.video.facingMode = this.currentCamera;

      console.log('[VideoRecorder] Attempting camera with constraints:', this.constraints);

      let stream;
      try {
        // ניסיון ראשון - איכות אופטימלית
        stream = await navigator.mediaDevices.getUserMedia(this.constraints);
      } catch (primaryError) {
        console.warn('[VideoRecorder] Primary constraints failed, trying fallback:', primaryError);
        
        // פולבאק למובייל - איכות נמוכה יותר אבל עדיין טובה
        const fallbackConstraints = {
          video: {
            width: { ideal: 1280, max: 1280 },   // עדיין 720p
            height: { ideal: 720, max: 720 },    // עדיין 720p
            facingMode: this.currentCamera,
            frameRate: { ideal: 25, max: 30 },    // קצב פריימים טוב
            aspectRatio: 16/9
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 44100,  // עדיין איכות טובה
            channelCount: 2     // סטריאו
          }
        };
        
        try {
          stream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
          console.log('[VideoRecorder] Fallback constraints successful');
        } catch (fallbackError) {
          console.error('[VideoRecorder] Fallback also failed:', fallbackError);
          
          // פולבאק אחרון - בסיסי מאוד
          const basicConstraints = {
            video: {
              width: { ideal: 480, max: 640 },
              height: { ideal: 360, max: 480 },
              facingMode: this.currentCamera,
              frameRate: { ideal: 15, max: 24 }
            },
            audio: true
          };
          
          stream = await navigator.mediaDevices.getUserMedia(basicConstraints);
          console.log('[VideoRecorder] Basic constraints successful');
        }
      }
      
      this.stream = stream;
      
      // בדיקת זרמים והגדרות
      const videoTrack = this.stream.getVideoTracks()[0];
      const audioTrack = this.stream.getAudioTracks()[0];
      
      if (videoTrack) {
        const settings = videoTrack.getSettings();
        console.log('[VideoRecorder] Video settings:', {
          resolution: `${settings.width}x${settings.height}`,
          frameRate: settings.frameRate,
          facingMode: settings.facingMode
        });
      }
      
      if (audioTrack) {
        const settings = audioTrack.getSettings();
        console.log('[VideoRecorder] Audio settings:', {
          sampleRate: settings.sampleRate,
          channelCount: settings.channelCount,
          echoCancellation: settings.echoCancellation
        });
      }
      
      if (this.preview) {
        this.preview.srcObject = this.stream;
        // הגדרות וידיאו אופטימליות למובייל
        this.preview.playsInline = true;
        this.preview.muted = true; // מניע ריבאונד
        this.preview.setAttribute('playsinline', '');
        this.preview.setAttribute('webkit-playsinline', '');
        
        // תיקון ייפול מצלמה - חשוב מאוד!
        // מצלמה קדמית צריכה להתנהג כמו מראה (mirror)
        // מצלמה אחורית צריכה להתנהג כמו מצלמה רגילה
        if (this.currentCamera === 'user') {
          this.preview.style.transform = 'scaleX(-1)'; // היפוך אופקי למצלמה קדמית
        } else {
          this.preview.style.transform = 'scaleX(1)';  // לא מפוך למצלמה אחורית
        }
        
        console.log('[VideoRecorder] Camera preview setup:', {
          facingMode: this.currentCamera,
          mirror: this.currentCamera === 'user'
        });
      }

      // ממשק הקלטה כבר גלוי - לא צריך להחליף
      console.log('[VideoRecorder] Camera ready for recording');

    } catch (error) {
      console.error('[VideoRecorder] Failed to access camera:', error);
      alert('לא ניתן לגשת למצלמה. אנא בדוק את ההרשאות ונסה שוב.');
      this.closeModal();
    }
  }

  stopCamera() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    
    if (this.preview) {
      this.preview.srcObject = null;
    }
  }

  async switchCamera() {
    // החלפת בין מצלמה קדמית לאחורית
    this.currentCamera = this.currentCamera === 'user' ? 'environment' : 'user';
    
    // אם מקליטים, עוצרים את ההקלטה
    if (this.isRecording) {
      this.stopRecording();
    }
    
    // הפעלת מצלמה חדשה
    await this.startCamera();
  }

  startRecording() {
    console.log('[VideoRecorder] startRecording called! Stream:', !!this.stream);
    
    if (!this.stream) {
      console.error('[VideoRecorder] No stream available! Cannot start recording.');
      alert('מצלמה לא מוכנה. אנא המתן עד שהמצלמה תיטען.');
      return;
    }

    try {
      // בדיקת תמיכה ב-codecs - עדיפות ל-codecs מהירים יותר
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : MediaRecorder.isTypeSupported('video/webm;codecs=h264,opus')
        ? 'video/webm;codecs=h264,opus'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : 'video/webm';

      console.log('[VideoRecorder] Using mimeType:', mimeType);

      // הגדרות MediaRecorder מותאמות למהירות וביצועים
      const recorderOptions = {
        mimeType,
        videoBitsPerSecond: 800000,   // 0.8 Mbps - הפחתה משמעותית לביצועים
        audioBitsPerSecond: 64000,    // 64 kbps - הפחתה לאיכות סבירה
      };

      // התאמה דינמית לרזולוציה בפועל - אופטימיזציה לביצועים
      const videoTrack = this.stream.getVideoTracks()[0];
      if (videoTrack) {
        const settings = videoTrack.getSettings();
        console.log('[VideoRecorder] Video track settings:', settings);
        
        // הפחתת bitrate לפי רזולוציה
        if (settings.width <= 640 || settings.height <= 360) {
          recorderOptions.videoBitsPerSecond = 400000;  // 0.4 Mbps לרזולוציה נמוכה
        } else if (settings.width <= 854 || settings.height <= 480) {
          recorderOptions.videoBitsPerSecond = 600000;  // 0.6 Mbps לרזולוציה בינונית
        }
      }

      this.mediaRecorder = new MediaRecorder(this.stream, recorderOptions);
      this.recordedChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        console.log('[VideoRecorder] Recording stopped, processing...');
        this.processRecording();
      };

      this.mediaRecorder.onerror = (event) => {
        console.error('[VideoRecorder] MediaRecorder error:', event);
        alert('שגיאה בהקלטה. נסה שוב.');
        this.stopRecording();
      };

      // התחלת הקלטה עם איסוף תכופות יותר לזרימה חלקה
      this.mediaRecorder.start(200); // איסוף כל 200ms - איזון בין ביצועים לאיכות
      this.isRecording = true;
      this.recordingStartTime = Date.now();

      // עדכון UI
      if (this.recordButton) {
        this.recordButton.classList.add('recording');
      }

      // הפעלת טיימרים
      this.startTimer();
      this.startFloatingTimer();

      // עצירה אוטומטית אחרי 60 שניות
      setTimeout(() => {
        if (this.isRecording) {
          console.log('[VideoRecorder] Auto-stopping recording after 60 seconds');
          this.stopRecording();
        }
      }, this.maxDuration * 1000);

      console.log('[VideoRecorder] Recording started with optimized settings:', recorderOptions);

    } catch (error) {
      console.error('[VideoRecorder] Failed to start recording:', error);
      alert('לא ניתן להתחיל הקלטה. נסה לרענן את הדף.');
    }
  }

  stopRecording() {
    if (!this.isRecording || !this.mediaRecorder) return;

    console.log('[VideoRecorder] Stopping recording...');
    
    this.mediaRecorder.stop();
    this.isRecording = false;

    // עצירת טיימר רגיל
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = null;
    }

    // עצירת טיימר צף
    if (this.floatingTimerInterval) {
      clearInterval(this.floatingTimerInterval);
      this.floatingTimerInterval = null;
    }

    // הסתרת טיימר צף
    if (this.floatingTimer) {
      this.floatingTimer.classList.remove('visible');
    }

    // עדכון UI
    if (this.recordButton) {
      this.recordButton.classList.remove('recording');
    }
  }

  startTimer() {
    const updateTimer = () => {
      if (!this.isRecording) return;

      const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
      const remaining = Math.max(0, this.maxDuration - elapsed);
      
      const minutes = Math.floor(remaining / 60);
      const seconds = remaining % 60;
      const display = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
      
      if (this.timerDisplay) {
        this.timerDisplay.textContent = display;
      }

      // שינוי צבע אם נשאר פחות מ-3 שניות
      if (remaining <= 3 && remaining > 0) {
        this.timerDisplay.style.color = '#ff4444';
      } else {
        this.timerDisplay.style.color = 'white';
      }
    };

    updateTimer();
    this.recordingTimer = setInterval(updateTimer, 100);
  }

  startFloatingTimer() {
    // הצגת הטיימר הצף מיד
    if (this.floatingTimer) {
      this.floatingTimer.classList.add('visible');
    }

    const updateFloatingTimer = () => {
      if (!this.isRecording) {
        // הסתרת הטיימר הצף בסוף ההקלטה
        if (this.floatingTimer) {
          this.floatingTimer.classList.remove('visible');
        }
        return;
      }

      const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
      const display = `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;
      
      if (this.floatingTimer) {
        this.floatingTimer.textContent = display;
        
        // אפקט פולס כל 10 שניות
        if (elapsed % 10 === 0 && elapsed > 0) {
          this.floatingTimer.classList.remove('pulse');
          void this.floatingTimer.offsetWidth; // Trigger reflow
          this.floatingTimer.classList.add('pulse');
        }
      }
    };

    updateFloatingTimer();
    this.floatingTimerInterval = setInterval(updateFloatingTimer, 100);
  }

  async processRecording() {
    if (this.recordedChunks.length === 0) {
      console.warn('[VideoRecorder] No recorded data');
      return;
    }

    try {
      // יצירת Blob מההקלטה
      const mimeType = this.mediaRecorder?.mimeType || 'video/webm';
      const blob = new Blob(this.recordedChunks, { type: mimeType });
      
      // המרה ל-File כדי לדמות קובץ שהועלה
      const file = new File([blob], `video-${Date.now()}.webm`, { type: mimeType });
      
      console.log('[VideoRecorder] Recording completed:', {
        size: (blob.size / 1024 / 1024).toFixed(2) + 'MB',
        duration: Math.floor((Date.now() - this.recordingStartTime) / 1000) + 's',
        type: mimeType,
        chunkCount: this.recordedChunks.length
      });

      console.log('[VideoRecorder] Transferring to compose...');
      
      // העברת הקובץ לקומפוזר
      this.transferToCompose(file);

      // סגירת חלון ההקלטה
      this.closeModal();

    } catch (error) {
      console.error('[VideoRecorder] Failed to process recording:', error);
      alert('שגיאה בעיבוד ההקלטה. אנא נסה שוב.');
    }
  }

  transferToCompose(file) {
    // הפעלת הקומפוזר אם לא פתוח
    const composeModal = document.getElementById('composeModal');
    if (!composeModal || composeModal.getAttribute('aria-hidden') === 'true') {
      if (typeof window.openCompose === 'function') {
        window.openCompose();
      } else if (typeof openCompose === 'function') {
        openCompose();
      }
    }

    // המתנה קצרה שהקומפוזר ייפתח והאלמנטים יהיו זמינים
    setTimeout(() => {
      // העברת הקובץ לפונקציית הטיפול במדיה של הקומפוזר
      if (typeof window.handleMediaInput === 'function') {
        window.handleMediaInput({ target: { files: [file] } });
      } else if (typeof handleMediaInput === 'function') {
        handleMediaInput({ target: { files: [file] } });
      } else {
        console.error('[VideoRecorder] handleMediaInput function not found!');
        alert('שגיאה בהעברת הווידיאו לקומפוזר. נסו לבחור קובץ ידנית.');
      }
    }, 500); // הגדלתי את ההמתנה ל-500ms לוודא שהכל נטען
  }
}

// אתחול המחלקה כשהדף נטען
document.addEventListener('DOMContentLoaded', () => {
  console.log('[VideoRecorder] DOM loaded, initializing VideoRecorder...');
  window.videoRecorder = new VideoRecorder();
  console.log('[VideoRecorder] VideoRecorder initialized:', window.videoRecorder);
});

// גם אתחול גיבוי אם DOMContentLoaded כבר קרה
if (document.readyState === 'loading') {
  // עדיין טוען
  console.log('[VideoRecorder] Document still loading, waiting for DOMContentLoaded...');
} else {
  // כבר נטען
  console.log('[VideoRecorder] Document already loaded, initializing immediately...');
  if (!window.videoRecorder) {
    window.videoRecorder = new VideoRecorder();
    console.log('[VideoRecorder] VideoRecorder initialized immediately:', window.videoRecorder);
  }
}

// פונקציות גלובליות לשימוש ב-HTML
function closeVideoRecordModal() {
  if (window.videoRecorder) {
    window.videoRecorder.closeModal();
  }
}

function openVideoRecordModal() {
  console.log('[VideoRecorder] Global openVideoRecordModal called');
  if (window.videoRecorder) {
    window.videoRecorder.openModal();
  } else {
    console.error('[VideoRecorder] VideoRecorder not initialized!');
    // נסה לאתחל שוב
    window.videoRecorder = new VideoRecorder();
    if (window.videoRecorder) {
      window.videoRecorder.openModal();
    }
  }
}
