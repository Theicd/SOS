// חלק הקלטת וידאו (video-record.js) – ממשק הקלטת וידאו עם טיימר ומצלמה קדמית/אחורית | HYPER CORE TECH

class VideoRecorder {
  constructor() {
    this.stream = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.selectedDuration = 10;
    this.isRecording = false;
    this.recordingStartTime = null;
    this.recordingTimer = null;
    this.currentCamera = 'environment'; // 'user' for front, 'environment' for back
    this.constraints = {
      video: {
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        facingMode: this.currentCamera,
        frameRate: { ideal: 30, max: 60 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 44100
      }
    };
    
    this.initializeElements();
    this.bindEvents();
  }

  initializeElements() {
    this.modal = document.getElementById('videoRecordModal');
    this.timerSelection = document.getElementById('videoRecordTimerSelection');
    this.recordInterface = document.getElementById('videoRecordInterface');
    this.preview = document.getElementById('videoRecordPreview');
    this.recordButton = document.getElementById('recordButton');
    this.cameraSwitch = document.getElementById('cameraSwitchButton');
    this.timerDisplay = document.getElementById('recordTimer');
    this.timerOptions = document.querySelectorAll('.timer-option');
  }

  bindEvents() {
    // כפתור פתיחת הקלטה בקומפוזר
    const recordButton = document.getElementById('composeVideoRecordButton');
    if (recordButton) {
      recordButton.addEventListener('click', () => this.openModal());
    }

    // בחירת משך הקלטה
    this.timerOptions.forEach(option => {
      option.addEventListener('click', (e) => {
        this.selectedDuration = parseInt(e.target.dataset.seconds);
        this.startCamera();
      });
    });

    // כפתור הקלטה
    this.recordButton.addEventListener('click', () => {
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
    if (this.modal) {
      this.modal.classList.add('is-visible');
      this.modal.setAttribute('aria-hidden', 'false');
      this.resetState();
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
    this.selectedDuration = 10;
    this.currentCamera = 'environment';
    this.constraints.video.facingMode = this.currentCamera;
    
    if (this.timerSelection) this.timerSelection.style.display = 'block';
    if (this.recordInterface) this.recordInterface.style.display = 'none';
    if (this.recordButton) this.recordButton.classList.remove('recording');
    if (this.timerDisplay) this.timerDisplay.textContent = '00:00';
    
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = null;
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

      // בקשת גישה למצלמה עם איכות גבוהה
      this.stream = await navigator.mediaDevices.getUserMedia(this.constraints);
      
      if (this.preview) {
        this.preview.srcObject = this.stream;
      }

      // מעבר לממשק הקלטה
      if (this.timerSelection) this.timerSelection.style.display = 'none';
      if (this.recordInterface) this.recordInterface.style.display = 'block';

    } catch (error) {
      console.error('[VideoRecorder] Failed to access camera:', error);
      alert('לא ניתן לגשת למצלמה. אנא בדוק את ההרשאות.');
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
    if (!this.stream) return;

    try {
      // הגדרות MediaRecorder משופרות
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';

      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType,
        videoBitsPerSecond: 4000000, // 4 Mbps - איכות גבוהה
        audioBitsPerSecond: 128000,   // 128 kbps - איכות אודיו טובה
      });

      this.recordedChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this.processRecording();
      };

      // התחלת הקלטה
      this.mediaRecorder.start(100);
      this.isRecording = true;
      this.recordingStartTime = Date.now();

      // עדכון UI
      if (this.recordButton) {
        this.recordButton.classList.add('recording');
      }

      // הפעלת טיימר
      this.startTimer();

      // עצירה אוטומטית אחרי הזמן הנבחר
      setTimeout(() => {
        if (this.isRecording) {
          this.stopRecording();
        }
      }, this.selectedDuration * 1000);

    } catch (error) {
      console.error('[VideoRecorder] Failed to start recording:', error);
      alert('לא ניתן להתחיל הקלטה. אנא נסה שוב.');
    }
  }

  stopRecording() {
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
      this.isRecording = false;

      // עצירת טיימר
      if (this.recordingTimer) {
        clearInterval(this.recordingTimer);
        this.recordingTimer = null;
      }

      // עדכון UI
      if (this.recordButton) {
        this.recordButton.classList.remove('recording');
      }
    }
  }

  startTimer() {
    const updateTimer = () => {
      if (!this.isRecording) return;

      const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
      const remaining = Math.max(0, this.selectedDuration - elapsed);
      
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
        duration: this.selectedDuration + 's',
        type: mimeType
      });

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
      if (typeof openCompose === 'function') {
        openCompose();
      }
    }

    // המתנה קצרה שהקומפוזר ייפתח
    setTimeout(() => {
      // העברת הקובץ לפונקציית הטיפול במדיה של הקומפוזר
      if (typeof handleMediaInput === 'function') {
        handleMediaInput({ target: { files: [file] } });
      }
    }, 300);
  }
}

// אתחול המחלקה כשהדף נטען
document.addEventListener('DOMContentLoaded', () => {
  window.videoRecorder = new VideoRecorder();
});

// פונקציות גלובליות לשימוש ב-HTML
function closeVideoRecordModal() {
  if (window.videoRecorder) {
    window.videoRecorder.closeModal();
  }
}
