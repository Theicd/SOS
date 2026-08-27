// חלק הקלטת וידאו (video-record.js) – מסך מצלמה מלא בסגנון טיקטוק | HYPER CORE TECH

class VideoRecorder {
  constructor() {
    this.stream = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.maxDuration = 10;
    this.captureMode = '10'; // photo | 10 | 20 | 30
    this.isRecording = false;
    this.recordingStartTime = null;
    this.recordingTimer = null;
    this.floatingTimerInterval = null;
    this.autoStopTimer = null;
    this.currentCamera = 'environment';
    this.flashOn = false;
    this.pendingFile = null;
    this.pendingObjectUrl = null;
    this.constraints = {
      video: {
        width: { min: 640, ideal: 1280, max: 1280 },
        height: { min: 480, ideal: 720, max: 720 },
        facingMode: this.currentCamera,
        frameRate: { ideal: 30, max: 30 },
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    };

    this.initializeElements();
    this.bindEvents();
  }

  initializeElements() {
    this.modal = document.getElementById('videoRecordModal');
    this.stageCamera = document.getElementById('videoRecordStageCamera');
    this.stageReview = document.getElementById('videoRecordStageReview');
    this.preview = document.getElementById('videoRecordPreview');
    this.reviewVideo = document.getElementById('videoRecordReviewVideo');
    this.reviewImage = document.getElementById('videoRecordReviewImage');
    this.recordButton = document.getElementById('recordButton');
    this.cameraSwitch = document.getElementById('cameraSwitchButton');
    this.flashButton = document.getElementById('cameraFlashButton');
    this.floatingTimer = document.getElementById('floatingTimer');
    this.modes = document.getElementById('videoRecordModes');
    this.galleryInput = document.getElementById('videoRecordGalleryInput');
    this.liveBtn = document.getElementById('videoRecordLiveBtn');
    this.closeBtn = document.getElementById('videoRecordCloseBtn');
    this.reviewBackBtn = document.getElementById('videoRecordReviewBackBtn');
    this.nextBtn = document.getElementById('videoRecordNextBtn');
  }

  bindEvents() {
    const recordOpenBtn = document.getElementById('composeVideoRecordButton');
    if (recordOpenBtn && !recordOpenBtn.dataset.vrBound) {
      recordOpenBtn.dataset.vrBound = '1';
      recordOpenBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          if (window.NostrApp?.closeCompose) window.NostrApp.closeCompose();
          else if (typeof window.closeCompose === 'function') window.closeCompose();
        } catch (_) {}
        this.openModal();
      });
    }

    this.recordButton?.addEventListener('click', () => this.onShutter());
    this.cameraSwitch?.addEventListener('click', () => this.switchCamera());
    this.flashButton?.addEventListener('click', () => this.toggleFlash());
    this.closeBtn?.addEventListener('click', () => this.closeModal());
    this.reviewBackBtn?.addEventListener('click', () => this.backToCamera());
    this.nextBtn?.addEventListener('click', () => this.confirmPendingFile());
    this.liveBtn?.addEventListener('click', () => {
      alert('שידור חי יופיע כאן בקרוב');
    });

    this.modes?.querySelectorAll('[data-vr-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-vr-mode');
        if (mode === 'text') {
          this.closeModal();
          if (typeof window.openCompose === 'function') {
            window.openCompose({ step: 'editor', composeMode: 'text' });
          } else if (window.NostrApp?.openCompose) {
            window.NostrApp.openCompose({ step: 'editor', composeMode: 'text' });
          }
          return;
        }
        this.setCaptureMode(mode);
      });
    });

    this.galleryInput?.addEventListener('change', (event) => {
      const file = event.target?.files?.[0];
      if (!file) return;
      this.showReview(file);
      try { event.target.value = ''; } catch (_) {}
    });
  }

  setCaptureMode(mode) {
    const next = String(mode || '10');
    this.captureMode = next;
    if (next === 'photo') {
      this.maxDuration = 0;
    } else {
      const sec = Number(next) || 10;
      this.maxDuration = sec;
    }
    this.modes?.querySelectorAll('[data-vr-mode]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-vr-mode') === next);
    });
    this.recordButton?.classList.toggle('is-photo', next === 'photo');
  }

  openModal() {
    if (!this.modal) return;
    this.modal.classList.add('is-visible');
    this.modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('video-record-open');
    this.resetState();
    this.showCameraStage();
    this.setCaptureMode(this.captureMode || '10');
    this.startCamera();
  }

  closeModal() {
    if (!this.modal) return;
    this.modal.classList.remove('is-visible');
    this.modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('video-record-open');
    this.stopCamera();
    this.clearPendingPreview();
    this.resetState();
    this.showCameraStage();
  }

  resetState() {
    this.isRecording = false;
    this.recordedChunks = [];
    this.flashOn = false;
    if (this.flashButton) {
      this.flashButton.classList.remove('is-on');
      this.flashButton.setAttribute('aria-pressed', 'false');
    }
    if (this.recordButton) this.recordButton.classList.remove('recording');
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
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
  }

  showCameraStage() {
    if (this.stageCamera) this.stageCamera.hidden = false;
    if (this.stageReview) this.stageReview.hidden = true;
  }

  showReviewStage() {
    if (this.stageCamera) this.stageCamera.hidden = true;
    if (this.stageReview) this.stageReview.hidden = false;
  }

  clearPendingPreview() {
    this.pendingFile = null;
    if (this.pendingObjectUrl) {
      try { URL.revokeObjectURL(this.pendingObjectUrl); } catch (_) {}
      this.pendingObjectUrl = null;
    }
    if (this.reviewVideo) {
      try { this.reviewVideo.pause(); } catch (_) {}
      this.reviewVideo.removeAttribute('src');
      this.reviewVideo.load?.();
      this.reviewVideo.hidden = true;
    }
    if (this.reviewImage) {
      this.reviewImage.removeAttribute('src');
      this.reviewImage.hidden = true;
    }
  }

  showReview(file) {
    if (!file) return;
    if (this.isRecording) this.stopRecording();
    this.stopCamera();
    this.clearPendingPreview();
    this.pendingFile = file;
    this.pendingObjectUrl = URL.createObjectURL(file);
    const isVideo = String(file.type || '').startsWith('video/');
    if (isVideo && this.reviewVideo) {
      this.reviewVideo.hidden = false;
      if (this.reviewImage) this.reviewImage.hidden = true;
      this.reviewVideo.src = this.pendingObjectUrl;
      this.reviewVideo.play?.().catch(() => {});
    } else if (this.reviewImage) {
      this.reviewImage.hidden = false;
      if (this.reviewVideo) this.reviewVideo.hidden = true;
      this.reviewImage.src = this.pendingObjectUrl;
    }
    this.showReviewStage();
  }

  backToCamera() {
    this.clearPendingPreview();
    this.showCameraStage();
    this.startCamera();
  }

  confirmPendingFile() {
    if (!this.pendingFile) return;
    const file = this.pendingFile;
    this.clearPendingPreview();
    this.closeModal();
    this.transferToCompose(file);
  }

  async startCamera() {
    try {
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
      }
      this.constraints.video.facingMode = this.currentCamera;

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(this.constraints);
      } catch (_) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: this.currentCamera },
          audio: true,
        });
      }

      this.stream = stream;
      if (this.preview) {
        this.preview.srcObject = this.stream;
        this.preview.playsInline = true;
        this.preview.muted = true;
        this.preview.style.transform = this.currentCamera === 'user' ? 'scaleX(-1)' : 'scaleX(1)';
        try { await this.preview.play(); } catch (_) {}
      }
    } catch (error) {
      console.error('[VideoRecorder] Failed to access camera:', error);
      alert('לא ניתן לגשת למצלמה. אנא בדוק את ההרשאות ונסה שוב.');
      this.closeModal();
    }
  }

  stopCamera() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.preview) this.preview.srcObject = null;
  }

  async switchCamera() {
    this.currentCamera = this.currentCamera === 'user' ? 'environment' : 'user';
    this.flashOn = false;
    if (this.flashButton) {
      this.flashButton.classList.remove('is-on');
      this.flashButton.setAttribute('aria-pressed', 'false');
    }
    if (this.isRecording) this.stopRecording();
    await this.startCamera();
  }

  async toggleFlash() {
    const track = this.stream?.getVideoTracks?.()?.[0];
    if (!track) return;
    const caps = (typeof track.getCapabilities === 'function' && track.getCapabilities()) || {};
    if (!caps.torch) {
      alert('הפלאש לא נתמך במכשיר זה');
      return;
    }
    this.flashOn = !this.flashOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: this.flashOn }] });
      this.flashButton?.classList.toggle('is-on', this.flashOn);
      this.flashButton?.setAttribute('aria-pressed', this.flashOn ? 'true' : 'false');
    } catch (err) {
      console.warn('[VideoRecorder] flash failed', err);
      this.flashOn = false;
      alert('לא ניתן להפעיל פלאש');
    }
  }

  onShutter() {
    if (this.captureMode === 'photo') {
      this.capturePhoto();
      return;
    }
    if (this.isRecording) this.stopRecording();
    else this.startRecording();
  }

  async capturePhoto() {
    if (!this.preview || !this.stream) {
      alert('מצלמה לא מוכנה');
      return;
    }
    try {
      const w = this.preview.videoWidth || 720;
      const h = this.preview.videoHeight || 1280;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas');
      if (this.currentCamera === 'user') {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(this.preview, 0, 0, w, h);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (!blob) throw new Error('blob');
      const file = new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
      this.showReview(file);
    } catch (err) {
      console.error('[VideoRecorder] photo failed', err);
      alert('צילום התמונה נכשל');
    }
  }

  startRecording() {
    if (!this.stream) {
      alert('מצלמה לא מוכנה. אנא המתן עד שהמצלמה תיטען.');
      return;
    }

    try {
      this.recordedChunks = [];
      let mimeType = 'video/webm;codecs=vp8,opus';
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
        if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) {
          mimeType = 'video/webm;codecs=vp9,opus';
        } else if (MediaRecorder.isTypeSupported('video/mp4')) {
          mimeType = 'video/mp4';
        } else if (MediaRecorder.isTypeSupported('video/webm')) {
          mimeType = 'video/webm';
        }
      }

      this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) this.recordedChunks.push(event.data);
      };
      this.mediaRecorder.onstop = () => this.processRecording();
      this.mediaRecorder.start(200);
      this.isRecording = true;
      this.recordingStartTime = Date.now();
      this.recordButton?.classList.add('recording');
      this.startTimer();
      this.startFloatingTimer();

      if (this.autoStopTimer) clearTimeout(this.autoStopTimer);
      this.autoStopTimer = setTimeout(() => {
        if (this.isRecording) this.stopRecording();
      }, Math.max(1, this.maxDuration) * 1000);
    } catch (error) {
      console.error('[VideoRecorder] Failed to start recording:', error);
      alert('לא ניתן להתחיל הקלטה. נסה לרענן את הדף.');
    }
  }

  stopRecording() {
    if (!this.isRecording || !this.mediaRecorder) return;
    try { this.mediaRecorder.stop(); } catch (_) {}
    this.isRecording = false;
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = null;
    }
    if (this.floatingTimerInterval) {
      clearInterval(this.floatingTimerInterval);
      this.floatingTimerInterval = null;
    }
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    this.floatingTimer?.classList.remove('visible');
    this.recordButton?.classList.remove('recording');
  }

  startTimer() {
    const updateTimer = () => {
      if (!this.isRecording) return;
      const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
      const remaining = Math.max(0, this.maxDuration - elapsed);
      const display = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
      if (this.floatingTimer) this.floatingTimer.textContent = display;
    };
    updateTimer();
    this.recordingTimer = setInterval(updateTimer, 200);
  }

  startFloatingTimer() {
    this.floatingTimer?.classList.add('visible');
    const updateFloatingTimer = () => {
      if (!this.isRecording) {
        this.floatingTimer?.classList.remove('visible');
        return;
      }
      const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
      const display = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
      if (this.floatingTimer) {
        this.floatingTimer.textContent = display;
        if (elapsed > 0 && elapsed % 10 === 0) {
          this.floatingTimer.classList.remove('pulse');
          void this.floatingTimer.offsetWidth;
          this.floatingTimer.classList.add('pulse');
        }
      }
    };
    updateFloatingTimer();
    this.floatingTimerInterval = setInterval(updateFloatingTimer, 200);
  }

  async processRecording() {
    if (!this.recordedChunks.length) return;
    try {
      const mimeType = this.mediaRecorder?.mimeType || 'video/webm';
      const blob = new Blob(this.recordedChunks, { type: mimeType });
      const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
      const file = new File([blob], `video-${Date.now()}.${ext}`, { type: mimeType });
      this.showReview(file);
    } catch (error) {
      console.error('[VideoRecorder] Failed to process recording:', error);
      alert('שגיאה בעיבוד ההקלטה. אנא נסה שוב.');
    }
  }

  transferToCompose(file) {
    const openEditor = () => {
      if (typeof window.openCompose === 'function') {
        window.openCompose({ step: 'editor', composeMode: 'camera' });
      } else if (window.NostrApp?.openCompose) {
        window.NostrApp.openCompose({ step: 'editor', composeMode: 'camera' });
      }
    };

    const composeModal = document.getElementById('composeModal');
    if (!composeModal || composeModal.getAttribute('aria-hidden') === 'true') {
      openEditor();
    } else if (window.NostrApp?.showComposeStep) {
      if (window.NostrApp.composeState) window.NostrApp.composeState.composeMode = 'camera';
      window.NostrApp.showComposeStep('editor');
    }

    setTimeout(() => {
      if (typeof window.handleMediaInput === 'function') {
        window.handleMediaInput({ target: { files: [file], value: '' } });
      } else {
        console.error('[VideoRecorder] handleMediaInput function not found!');
        alert('שגיאה בהעברת המדיה לקומפוזר. נסו לבחור קובץ ידנית.');
      }
    }, 450);
  }
}

function closeVideoRecordModal() {
  window.videoRecorder?.closeModal();
}

function openVideoRecordModal() {
  if (!window.videoRecorder) window.videoRecorder = new VideoRecorder();
  window.videoRecorder.openModal();
}

window.closeVideoRecordModal = closeVideoRecordModal;
window.openVideoRecordModal = openVideoRecordModal;

document.addEventListener('DOMContentLoaded', () => {
  if (!window.videoRecorder) window.videoRecorder = new VideoRecorder();
});

if (document.readyState !== 'loading' && !window.videoRecorder) {
  window.videoRecorder = new VideoRecorder();
}
