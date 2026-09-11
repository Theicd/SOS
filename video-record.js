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
    this.selectedBgUrl = '';
    this.bgUrls = [];
    this.overlayText = '';
    this.overlayTextPos = 'middle';
    this.bgStripScrolled = false;
    this.cameraAvailable = true;
    this._bgLoadTimer = 0;
    this.countdownTimer = null;
    this.gridOn = false;
    this._overlayBurnedInFile = false;
    this._composeOverlayText = '';
    this.constraints = {
      video: {
        facingMode: this.currentCamera,
        width: { ideal: 640, max: 1280 },
        height: { ideal: 480, max: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    };

    this.initializeElements();
    this.bindEvents();
  }

  initializeElements() {
    this.modal = document.getElementById('videoRecordModal');
    this.stageCamera = document.getElementById('videoRecordStageCamera');
    this.stageReview = document.getElementById('videoRecordStageReview');
    this.previewWrap = document.getElementById('videoRecordPreviewWrap');
    this.preview = document.getElementById('videoRecordPreview');
    this.reviewVideo = document.getElementById('videoRecordReviewVideo');
    this.reviewImage = document.getElementById('videoRecordReviewImage');
    this.recordButton = document.getElementById('recordButton');
    this.cameraSwitch = document.getElementById('cameraSwitchButton');
    this.flashButton = document.getElementById('cameraFlashButton');
    this.gridButton = document.getElementById('videoRecordGridBtn');
    this.gridEl = document.getElementById('videoRecordGrid');
    this.countdownEl = document.getElementById('videoRecordCountdown');
    this.reviewTextLayer = document.getElementById('videoRecordReviewTextLayer');
    this.floatingTimer = document.getElementById('floatingTimer');
    this.modes = document.getElementById('videoRecordModes');
    this.galleryInput = document.getElementById('videoRecordGalleryInput');
    this.galleryThumb = document.getElementById('videoRecordGalleryThumb');
    this.galleryThumbWrap = document.querySelector('#videoRecordGalleryBtn .vr-gallery-thumb');
    this.closeBtn = document.getElementById('videoRecordCloseBtn');
    this.reviewBackBtn = document.getElementById('videoRecordReviewBackBtn');
    this.nextBtn = document.getElementById('videoRecordNextBtn');
    this.bgStrip = document.getElementById('videoRecordBgStrip');
    this.bgFrame = document.getElementById('videoRecordBgFrame');
    this.shutterRow = document.getElementById('videoRecordShutterRow');
    this.bgDismiss = document.getElementById('videoRecordBgDismiss');
    this.liveBtn = document.getElementById('videoRecordLiveBtn');
    this.textBtn = document.getElementById('videoRecordTextBtn');
    this.textEditor = document.getElementById('videoRecordTextEditor');
    this.textInput = document.getElementById('videoRecordTextInput');
    this.textDone = document.getElementById('videoRecordTextDone');
    this.textLayer = document.getElementById('videoRecordTextLayer');
    this.noCamera = document.getElementById('videoRecordNoCamera');
    this.noCameraBg = document.getElementById('videoRecordNoCameraBg');
    this._bgScrollRaf = 0;
    this._galleryThumbUrl = null;
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
    this.gridButton?.addEventListener('click', () => this.toggleGrid());
    this.closeBtn?.addEventListener('click', () => this.closeModal());
    this.reviewBackBtn?.addEventListener('click', () => this.backToCamera());
    this.nextBtn?.addEventListener('click', () => this.confirmPendingFile());
    this.liveBtn?.addEventListener('click', () => {
      try { this.closeModal(); } catch (_) {}
      const LiveApp = window.NostrApp || {};
      if (typeof LiveApp.openLiveBroadcast === 'function') {
        LiveApp.openLiveBroadcast({ slug: 'live' });
        return;
      }
      alert('שידור חי לא זמין כרגע');
    });
    this.bgDismiss?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dismissBackgroundStrip();
    });
    this.textBtn?.addEventListener('click', () => this.toggleTextEditor());
    this.textDone?.addEventListener('click', () => this.commitTextEditor());
    this.textInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commitTextEditor();
      }
    });
    this.textInput?.addEventListener('input', () => {
      this.overlayText = String(this.textInput.value || '').trim();
      this.renderTextLayer();
    });
    this.textEditor?.querySelectorAll('[data-text-pos]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pos = btn.getAttribute('data-text-pos') || 'middle';
        this.setTextPosition(pos);
      });
    });

    this.modes?.querySelectorAll('[data-vr-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-vr-mode');
        if (mode === 'text') {
          if (this.selectedBgUrl) {
            this.useSelectedBackground();
            return;
          }
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
      this.setGalleryThumbFromFile(file);
      this.clearBackgroundSelection();
      this.showReview(file);
      try { event.target.value = ''; } catch (_) {}
    });
    this.reviewVideo?.addEventListener('loadeddata', () => this.hideShellFilePickLoading());
    this.reviewVideo?.addEventListener('canplay', () => this.hideShellFilePickLoading());
    this.reviewImage?.addEventListener('load', () => this.hideShellFilePickLoading());

    this.bgStrip?.addEventListener('click', (event) => {
      if (event.target?.closest?.('.vr-bg-dismiss')) return;
      const thumb = event.target?.closest?.('.vr-bg-thumb');
      if (!thumb || !this.bgStrip) return;
      const targetLeft = thumb.offsetLeft - (this.bgStrip.clientWidth / 2) + (thumb.offsetWidth / 2);
      this.bgStrip.scrollTo({ left: Math.max(0, targetLeft), behavior: 'smooth' });
      const url = thumb.getAttribute('data-bg') || '';
      if (!url) this.clearBackgroundSelection(true);
      else this.selectBackground(url, thumb);
      this.updateBgDismissVisibility();
    });

    this.bgStrip?.addEventListener('scroll', () => {
      if (this._bgScrollRaf) cancelAnimationFrame(this._bgScrollRaf);
      this._bgScrollRaf = requestAnimationFrame(() => {
        this.syncBackgroundFromScroll();
        this.updateBgDismissVisibility();
      });
    }, { passive: true });

    this.bgStrip?.addEventListener('scrollend', () => {
      this.syncBackgroundFromScroll(true);
      this.updateBgDismissVisibility();
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
    if (!this.selectedBgUrl) this.setShutterSolid(true);
  }

  pauseFeedVideos() {
    try {
      if (typeof App !== 'undefined' && typeof App.pauseAllFeedVideos === 'function') {
        App.pauseAllFeedVideos();
      } else if (typeof window.pauseAllFeedVideos === 'function') {
        window.pauseAllFeedVideos();
      }
    } catch (_) {}
  }

  ensureFeedFreezeHook() {
    if (VideoRecorder._feedHooked) return;
    VideoRecorder._feedHooked = true;
    const wrap = (fn) => {
      if (typeof fn !== 'function' || fn.__vrUnfreezeWrapped) return fn;
      const wrapped = function wrappedResume() {
        try { window.videoRecorder?.unfreezeFeedForCamera(); } catch (_) {}
        return fn.apply(this, arguments);
      };
      wrapped.__vrUnfreezeWrapped = true;
      return wrapped;
    };
    if (typeof window.resumeCenteredFeedVideo === 'function') {
      window.resumeCenteredFeedVideo = wrap(window.resumeCenteredFeedVideo);
    }
    const AppRef = window.NostrApp;
    if (AppRef && typeof AppRef.resumeCenteredFeedVideo === 'function') {
      AppRef.resumeCenteredFeedVideo = wrap(AppRef.resumeCenteredFeedVideo);
    }
  }

  freezeFeedForCamera() {
    this.pauseFeedVideos();
    this.ensureFeedFreezeHook();
    if (this._feedFrozen?.length) return;
    this._feedFrozen = [];
    try {
      document.querySelectorAll('.videos-feed video').forEach((video) => {
        if (!video || video.closest?.('.video-record-modal')) return;
        const type = video.closest?.('.videos-feed__media')?.dataset?.mediaType || '';
        if (type === 'hls-live' || type === 'p2p-live') {
          try { video.pause(); } catch (_) {}
          return;
        }
        const rec = {
          el: video,
          src: video.getAttribute('src') || '',
          srcObject: video.srcObject || null,
          time: video.currentTime || 0,
        };
        try { video.pause(); } catch (_) {}
        try { video.srcObject = null; } catch (_) {}
        if (rec.src || rec.srcObject) {
          try { video.removeAttribute('src'); } catch (_) {}
          try { video.load(); } catch (_) {}
        }
        this._feedFrozen.push(rec);
      });
      document.querySelectorAll('.videos-feed iframe').forEach((iframe) => {
        if (!iframe) return;
        const src = iframe.getAttribute('src') || '';
        if (!src || src === 'about:blank') return;
        this._feedFrozen.push({ el: iframe, src, isIframe: true });
        try { iframe.src = 'about:blank'; } catch (_) {}
      });
    } catch (_) {}
  }

  unfreezeFeedForCamera() {
    const list = this._feedFrozen;
    this._feedFrozen = [];
    if (!list?.length) return;
    list.forEach((rec) => {
      try {
        if (rec.isIframe) {
          if (rec.src) rec.el.src = rec.src;
          return;
        }
        const video = rec.el;
        if (!video) return;
        if (rec.srcObject) video.srcObject = rec.srcObject;
        else if (rec.src) video.src = rec.src;
        try { if (rec.time) video.currentTime = rec.time; } catch (_) {}
      } catch (_) {}
    });
  }

  resumeFeedIfShareClosed() {
    try {
      const composeOpen = document.getElementById('composeModal')?.classList.contains('is-visible');
      const recordOpen = this.modal?.classList.contains('is-visible');
      if (composeOpen || recordOpen) return;
      this.unfreezeFeedForCamera();
      if (typeof window.resumeCenteredFeedVideo === 'function') {
        window.resumeCenteredFeedVideo();
      } else if (typeof App !== 'undefined' && typeof App.resumeCenteredFeedVideo === 'function') {
        App.resumeCenteredFeedVideo();
      }
    } catch (_) {}
  }

  openModal() {
    if (!this.modal) return;
    this.freezeFeedForCamera();
    this.modal.classList.add('is-visible');
    this.modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('video-record-open');
    this.resetState();
    this.cameraAvailable = true;
    this.clearOverlayText();
    this.clearBackgroundSelection();
    this.hideTextEditor();
    this.exitNoCameraMode();
    this.showCameraStage();
    this.setCaptureMode(this.captureMode || '10');
    this.restoreGalleryThumb();
    this.startCamera();
    this.scheduleBackgroundStrip();
  }

  closeModal(options = {}) {
    if (!this.modal) return;
    this.modal.classList.remove('is-visible');
    this.modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('video-record-open');
    this.cancelCountdown();
    this.cancelBackgroundStripLoad();
    this.stopCamera();
    this.clearPendingPreview();
    this.clearOverlayText();
    this.clearBackgroundSelection();
    this.hideTextEditor();
    this.exitNoCameraMode();
    this.resetState();
    this.showCameraStage();
    if (!options.skipResume) this.resumeFeedIfShareClosed();
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
    this.modal?.classList.remove('is-recording');
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
    this.cancelCountdown();
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

  hideShellFilePickLoading() {
    try {
      const AppNs = window.NostrApp || {};
      if (typeof AppNs.hideChatFilePickLoading === 'function') {
        AppNs.hideChatFilePickLoading();
      }
    } catch (_) {}
    try {
      const el = document.getElementById('chatFilePickLoading');
      if (el) {
        el.classList.remove('is-visible');
        el.hidden = true;
      }
    } catch (_) {}
    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.hideFilePickLoadingNow === 'function') {
        bridge.hideFilePickLoadingNow();
      } else if (bridge && typeof bridge.hideFilePickLoading === 'function') {
        bridge.hideFilePickLoading();
      }
    } catch (_) {}
  }

  scheduleHideShellFilePickLoading() {
    this.hideShellFilePickLoading();
    [80, 250, 700].forEach((ms) => {
      setTimeout(() => this.hideShellFilePickLoading(), ms);
    });
  }

  showReview(file) {
    if (!file) return;
    if (this.isRecording) this.stopRecording();
    this.stopCamera();
    this.clearPendingPreview();
    this.pendingFile = file;
    this.setGalleryThumbFromFile(file);
    this.pendingObjectUrl = URL.createObjectURL(file);
    const isVideo = String(file.type || '').startsWith('video/');
    this._overlayBurnedInFile = !isVideo;
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
    this.renderTextLayer();
    this.showReviewStage();
    this.scheduleHideShellFilePickLoading();
  }

  backToCamera() {
    this.clearPendingPreview();
    this.showCameraStage();
    this.startCamera();
  }

  confirmPendingFile() {
    if (!this.pendingFile) return;
    const file = this.pendingFile;
    this._composeOverlayText = String(this.overlayText || '').trim();
    this.lastShareFile = file;
    this.clearPendingPreview();
    this.closeModal({ skipResume: true });
    this.transferToCompose(file);
  }

  /** חזרה מעורך הפוסט לתצוגה גדולה של אותו קובץ | HYPER CORE TECH */
  openReviewWithFile(file) {
    const target = file || this.lastShareFile;
    if (!this.modal || !target) return;
    this.lastShareFile = target;
    this.freezeFeedForCamera();
    this.modal.classList.add('is-visible');
    this.modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('video-record-open');
    this.resetState();
    this.clearOverlayText();
    this.clearBackgroundSelection();
    this.hideTextEditor();
    this.exitNoCameraMode();
    this.stopCamera();
    this.showReview(target);
  }

  pickRecorderMime() {
    const picked = this.listRecorderMimes();
    return picked[0] || '';
  }

  listRecorderMimes() {
    const canCheck = typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function';
    const candidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1.4D401E,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=h264,opus',
      'video/webm;codecs=avc1.42E01E,opus',
      'video/webm;codecs=h264',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    if (!canCheck) return ['video/webm'];
    return candidates.filter((mime) => {
      try { return MediaRecorder.isTypeSupported(mime); } catch (_) { return false; }
    });
  }

  applyPreviewMirror() {
    this.previewWrap?.classList.toggle('is-front', this.currentCamera === 'user');
    if (this.preview) this.preview.style.transform = '';
  }

  async softenCameraTrack(stream) {
    const track = stream?.getVideoTracks?.()?.[0];
    if (!track) return;
    try { track.contentHint = 'motion'; } catch (_) {}
  }

  async startCamera() {
    try {
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
      }
      this.constraints.video.facingMode = this.currentCamera;

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: this.constraints.video,
          audio: false,
        });
      } catch (_) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: this.currentCamera },
            audio: false,
          });
        } catch (__) {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }
      }

      this.stream = stream;
      await this.softenCameraTrack(stream);
      this.cameraAvailable = true;
      this.exitNoCameraMode();
      if (this.preview) {
        this.preview.srcObject = this.stream;
        this.preview.playsInline = true;
        this.preview.muted = true;
        this.preview.setAttribute('playsinline', '');
        this.preview.setAttribute('webkit-playsinline', '');
        this.applyPreviewMirror();
        try { await this.preview.play(); } catch (_) {}
      }
    } catch (error) {
      console.warn('[VideoRecorder] camera unavailable — stay on screen', error);
      // לא סוגרים ולא זורקים אחורה — מציגים מצב ללא מצלמה | HYPER CORE TECH
      this.enterNoCameraMode();
    }
  }

  enterNoCameraMode() {
    this.cameraAvailable = false;
    this.stopCamera();
    if (this.preview) {
      this.preview.srcObject = null;
      this.preview.style.opacity = '0';
    }
    const bgUrl = this.pickNoCameraBackground();
    if (this.noCameraBg && bgUrl) {
      this.noCameraBg.src = bgUrl;
    }
    if (this.noCamera) {
      this.noCamera.hidden = false;
      this.noCamera.removeAttribute('hidden');
    }
    this.modal?.classList.add('is-no-camera');
    this.cameraSwitch?.setAttribute('disabled', '');
    this.flashButton?.setAttribute('disabled', '');
  }

  exitNoCameraMode() {
    if (this.preview) this.preview.style.opacity = '';
    if (this.noCamera) {
      this.noCamera.hidden = true;
      this.noCamera.setAttribute('hidden', '');
    }
    this.modal?.classList.remove('is-no-camera');
    this.cameraSwitch?.removeAttribute('disabled');
    this.flashButton?.removeAttribute('disabled');
  }

  pickNoCameraBackground() {
    const fromStrip = Array.isArray(this.bgUrls) ? this.bgUrls.filter(Boolean) : [];
    if (fromStrip.length) {
      return fromStrip[Math.floor(Math.random() * fromStrip.length)];
    }
    const page = Math.max(1, Math.floor(Math.random() * 50) + 1);
    // fallback מיידי עד ש־Picsum נטען | HYPER CORE TECH
    return `https://picsum.photos/id/${80 + (page % 40)}/720/1280`;
  }

  stopCamera() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.preview) this.preview.srcObject = null;
  }

  async switchCamera() {
    if (!this.cameraAvailable) return;
    this.currentCamera = this.currentCamera === 'user' ? 'environment' : 'user';
    this.flashOn = false;
    if (this.flashButton) {
      this.flashButton.classList.remove('is-on');
      this.flashButton.setAttribute('aria-pressed', 'false');
    }
    if (this.isRecording) this.stopRecording();
    this.cancelCountdown();
    await this.startCamera();
  }

  async toggleFlash() {
    if (!this.cameraAvailable) return;
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

  toggleGrid() {
    this.gridOn = !this.gridOn;
    this.gridButton?.classList.toggle('is-on', this.gridOn);
    this.gridButton?.setAttribute('aria-pressed', this.gridOn ? 'true' : 'false');
    if (this.gridEl) {
      this.gridEl.hidden = !this.gridOn;
      if (this.gridOn) this.gridEl.removeAttribute('hidden');
      else this.gridEl.setAttribute('hidden', '');
    }
  }

  cancelCountdown() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.modal?.classList.remove('is-countdown');
    if (this.countdownEl) {
      this.countdownEl.hidden = true;
      this.countdownEl.setAttribute('hidden', '');
      this.countdownEl.textContent = '';
      this.countdownEl.classList.remove('is-pop');
    }
  }

  showCountdownNumber(n) {
    if (!this.countdownEl) return;
    this.countdownEl.hidden = false;
    this.countdownEl.removeAttribute('hidden');
    this.countdownEl.textContent = String(n);
    this.countdownEl.classList.remove('is-pop');
    void this.countdownEl.offsetWidth;
    this.countdownEl.classList.add('is-pop');
  }

  startCountdown(onDone) {
    this.cancelCountdown();
    this.modal?.classList.add('is-countdown');
    let n = 3;
    this.showCountdownNumber(n);
    this.countdownTimer = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        this.cancelCountdown();
        try {
          if (typeof onDone === 'function') onDone();
        } catch (err) {
          console.error('[VideoRecorder] countdown start failed', err);
        }
        return;
      }
      this.showCountdownNumber(n);
    }, 1000);
  }

  onShutter() {
    // בלי מצלמה — פותחים גלריה במקום הקלטה | HYPER CORE TECH
    if (!this.cameraAvailable) {
      try { this.galleryInput?.click(); } catch (_) {}
      return;
    }
    if (this.countdownTimer) {
      this.cancelCountdown();
      return;
    }
    if (this.selectedBgUrl) {
      this.useSelectedBackground();
      return;
    }
    if (this.captureMode === 'photo') {
      this.capturePhoto();
      return;
    }
    if (this.isRecording) this.stopRecording();
    else this.startCountdown(() => this.startRecording());
  }

  cancelBackgroundStripLoad() {
    if (this._bgLoadTimer) {
      clearTimeout(this._bgLoadTimer);
      this._bgLoadTimer = 0;
    }
  }

  scheduleBackgroundStrip() {
    this.cancelBackgroundStripLoad();
    this._bgLoadTimer = setTimeout(() => {
      this._bgLoadTimer = 0;
      if (!this.modal?.classList.contains('is-visible') || this.isRecording) return;
      this.loadBackgroundStrip();
    }, 3500);
  }

  async loadBackgroundStrip() {
    if (!this.bgStrip) return;
    this.bgStrip.innerHTML = '';
    this.bgUrls = [];
    try {
      const page = Math.max(1, Math.floor(Math.random() * 50) + 1);
      const res = await fetch(`https://picsum.photos/v2/list?page=${page}&limit=20`, { cache: 'no-store' });
      const arr = await res.json();
      const urls = Array.isArray(arr)
        ? arr.map((x) => (x && x.id ? `https://picsum.photos/id/${x.id}/720/720` : null)).filter(Boolean)
        : [];
      this.bgUrls = urls;
      this.renderBackgroundStrip(urls);
      if (!this.cameraAvailable) {
        const bgUrl = this.pickNoCameraBackground();
        if (this.noCameraBg && bgUrl) this.noCameraBg.src = bgUrl;
      }
    } catch (err) {
      console.warn('[VideoRecorder] Picsum load failed', err);
    }
  }

  renderBackgroundStrip(urls) {
    if (!this.bgStrip) return;
    if (!urls.length) {
      this.bgStrip.innerHTML = '';
      return;
    }
    const noneBtn = `<button type="button" class="vr-bg-thumb vr-bg-thumb--none is-selected" data-bg="" aria-label="בלי רקע"></button>`;
    const thumbs = urls.map((url) => {
      const thumb = url.replace('/720/720', '/120/120').replace('/1080/1080', '/120/120');
      return `<button type="button" class="vr-bg-thumb" data-bg="${url}" style="background-image:url('${thumb}')" aria-label="רקע מובנה"></button>`;
    }).join('');
    this.bgStrip.innerHTML = noneBtn + thumbs;
    // תמונה זעירה לגלריה מתוך סט הבחירה | HYPER CORE TECH
    if (urls[0] && !this.galleryThumbWrap?.classList.contains('has-image')) {
      const preview = urls[0].replace('/720/720', '/120/120').replace('/1080/1080', '/120/120');
      this.setGalleryThumbFromUrl(preview, false);
    }
    // התחלה בלי רקע (עיגול ראשון במרכז) | HYPER CORE TECH
    requestAnimationFrame(() => {
      try { this.bgStrip.scrollLeft = 0; } catch (_) {}
      this.clearBackgroundSelection(true);
      this.syncBackgroundFromScroll(true);
      this.updateBgDismissVisibility();
    });
  }

  getCenterThumb() {
    if (!this.bgStrip) return null;
    const stripRect = this.bgStrip.getBoundingClientRect();
    const centerX = stripRect.left + stripRect.width / 2;
    let best = null;
    let bestDist = Infinity;
    this.bgStrip.querySelectorAll('.vr-bg-thumb').forEach((el) => {
      const r = el.getBoundingClientRect();
      const mid = r.left + r.width / 2;
      const dist = Math.abs(mid - centerX);
      if (dist < bestDist) {
        bestDist = dist;
        best = el;
      }
    });
    return best;
  }

  syncBackgroundFromScroll(force) {
    const thumb = this.getCenterThumb();
    if (!thumb) return;
    const url = thumb.getAttribute('data-bg') || '';
    if (!url) {
      if (force || this.selectedBgUrl) this.clearBackgroundSelection(true);
      return;
    }
    if (url !== this.selectedBgUrl || force) {
      this.selectBackground(url, thumb);
    }
  }

  setShutterSolid(solid) {
    this.recordButton?.classList.toggle('is-solid', !!solid);
  }

  setGalleryThumbFromUrl(url, persist = true) {
    if (!url || !this.galleryThumb) return;
    if (this._galleryThumbUrl && this._galleryThumbUrl.startsWith('blob:')) {
      try { URL.revokeObjectURL(this._galleryThumbUrl); } catch (_) {}
    }
    this._galleryThumbUrl = url;
    this.galleryThumb.src = url;
    this.galleryThumbWrap?.classList.add('has-image');
    if (persist) {
      try {
        if (String(url).startsWith('data:')) {
          sessionStorage.setItem('sos_vr_gallery_thumb', url);
        }
      } catch (_) {}
    }
  }

  async setGalleryThumbFromFile(file) {
    if (!file) return;
    try {
      if (String(file.type || '').startsWith('video/')) {
        const videoUrl = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.src = videoUrl;
        await new Promise((resolve, reject) => {
          video.onloadeddata = resolve;
          video.onerror = reject;
        });
        try { video.currentTime = Math.min(0.2, (video.duration || 1) * 0.05); } catch (_) {}
        await new Promise((resolve) => {
          video.onseeked = resolve;
          setTimeout(resolve, 400);
        });
        const canvas = document.createElement('canvas');
        canvas.width = 120;
        canvas.height = 120;
        const ctx = canvas.getContext('2d');
        const vw = video.videoWidth || 120;
        const vh = video.videoHeight || 120;
        const scale = Math.max(120 / vw, 120 / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        ctx.drawImage(video, (120 - dw) / 2, (120 - dh) / 2, dw, dh);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        try { URL.revokeObjectURL(videoUrl); } catch (_) {}
        this.setGalleryThumbFromUrl(dataUrl);
        return;
      }
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      // ממוזער קטן ל־sessionStorage | HYPER CORE TECH
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = dataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 120;
      const ctx = canvas.getContext('2d');
      const scale = Math.max(120 / img.width, 120 / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (120 - dw) / 2, (120 - dh) / 2, dw, dh);
      this.setGalleryThumbFromUrl(canvas.toDataURL('image/jpeg', 0.7));
    } catch (err) {
      console.warn('[VideoRecorder] gallery thumb failed', err);
    }
  }

  restoreGalleryThumb() {
    try {
      const saved = sessionStorage.getItem('sos_vr_gallery_thumb');
      if (saved) this.setGalleryThumbFromUrl(saved);
    } catch (_) {}
  }

  updateBgDismissVisibility() {
    const scrolled = (this.bgStrip?.scrollLeft || 0) > 8;
    const show = scrolled || !!this.selectedBgUrl;
    this.bgStripScrolled = show;
    if (!this.bgDismiss) return;
    if (show) {
      this.bgDismiss.hidden = false;
      this.bgDismiss.removeAttribute('hidden');
      this.bgDismiss.classList.add('is-visible');
    } else {
      this.bgDismiss.hidden = true;
      this.bgDismiss.setAttribute('hidden', '');
      this.bgDismiss.classList.remove('is-visible');
    }
  }

  dismissBackgroundStrip() {
    const noneThumb = this.bgStrip?.querySelector?.('.vr-bg-thumb--none');
    if (noneThumb && this.bgStrip) {
      const targetLeft = noneThumb.offsetLeft - (this.bgStrip.clientWidth / 2) + (noneThumb.offsetWidth / 2);
      this.bgStrip.scrollTo({ left: Math.max(0, targetLeft), behavior: 'smooth' });
    } else if (this.bgStrip) {
      this.bgStrip.scrollTo({ left: 0, behavior: 'smooth' });
    }
    this.clearBackgroundSelection(true);
    this.updateBgDismissVisibility();
  }

  toggleTextEditor() {
    const open = this.textEditor && !this.textEditor.hasAttribute('hidden');
    if (open) {
      this.commitTextEditor();
      return;
    }
    this.showTextEditor();
  }

  showTextEditor() {
    if (!this.textEditor) return;
    this.textEditor.hidden = false;
    this.textEditor.removeAttribute('hidden');
    this.textBtn?.classList.add('is-active');
    if (this.textInput) {
      this.textInput.value = this.overlayText || '';
      try { this.textInput.focus(); } catch (_) {}
    }
    this.setTextPosition(this.overlayTextPos || 'middle');
    this.renderTextLayer();
  }

  hideTextEditor() {
    if (this.textEditor) {
      this.textEditor.hidden = true;
      this.textEditor.setAttribute('hidden', '');
    }
    this.textBtn?.classList.remove('is-active');
  }

  commitTextEditor() {
    this.overlayText = String(this.textInput?.value || '').trim();
    this.hideTextEditor();
    this.renderTextLayer();
  }

  setTextPosition(pos) {
    const next = ['top', 'middle', 'bottom'].includes(pos) ? pos : 'middle';
    this.overlayTextPos = next;
    this.textEditor?.querySelectorAll('[data-text-pos]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-text-pos') === next);
    });
    if (this.textLayer) this.textLayer.setAttribute('data-pos', next);
    if (this.reviewTextLayer) this.reviewTextLayer.setAttribute('data-pos', next);
    this.renderTextLayer();
  }

  applyTextToLayer(layer, forceHide) {
    if (!layer) return;
    const text = String(this.overlayText || '').trim();
    if (forceHide || !text) {
      layer.textContent = '';
      layer.hidden = true;
      layer.setAttribute('hidden', '');
      return;
    }
    layer.textContent = text;
    layer.setAttribute('data-pos', this.overlayTextPos || 'middle');
    layer.hidden = false;
    layer.removeAttribute('hidden');
  }

  renderTextLayer() {
    this.applyTextToLayer(this.textLayer);
    this.applyTextToLayer(this.reviewTextLayer, this._overlayBurnedInFile);
  }

  clearOverlayText() {
    this.overlayText = '';
    this.overlayTextPos = 'middle';
    if (this.textInput) this.textInput.value = '';
    this.renderTextLayer();
    this.hideTextEditor();
  }

  drawOverlayText(ctx, width, height) {
    const text = String(this.overlayText || '').trim();
    if (!text || !ctx) return;
    const pos = this.overlayTextPos || 'middle';
    let fontSize = Math.max(28, Math.round(width * 0.07));
    ctx.save();
    ctx.direction = 'rtl';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(3, Math.round(fontSize * 0.08));
    ctx.font = `800 ${fontSize}px sans-serif`;
    const maxWidth = width * 0.86;
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';
    words.forEach((word) => {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    });
    if (line) lines.push(line);
    while (lines.length > 4 && fontSize > 22) {
      fontSize -= 2;
      ctx.font = `800 ${fontSize}px sans-serif`;
    }
    const lineHeight = fontSize * 1.25;
    const blockH = lines.length * lineHeight;
    let y;
    if (pos === 'top') y = height * 0.18;
    else if (pos === 'bottom') y = height * 0.72 - blockH / 2;
    else y = height * 0.5 - blockH / 2 + lineHeight / 2;
    const x = width / 2;
    lines.forEach((ln, i) => {
      const yy = y + i * lineHeight;
      ctx.strokeText(ln, x, yy);
      ctx.fillText(ln, x, yy);
    });
    ctx.restore();
  }

  selectBackground(url, thumbEl) {
    this.selectedBgUrl = url;
    this.bgStrip?.querySelectorAll('.vr-bg-thumb').forEach((el) => {
      el.classList.toggle('is-selected', el === thumbEl || el.getAttribute('data-bg') === url);
    });
    if (this.bgFrame) {
      this.bgFrame.src = url;
      this.bgFrame.hidden = false;
      this.bgFrame.removeAttribute('hidden');
    }
    this.setShutterSolid(false);
    this.updateBgDismissVisibility();
  }

  clearBackgroundSelection(keepScrollMark) {
    this.selectedBgUrl = '';
    this.bgStrip?.querySelectorAll('.vr-bg-thumb').forEach((el) => {
      const isNone = !el.getAttribute('data-bg');
      el.classList.toggle('is-selected', keepScrollMark ? isNone : false);
    });
    if (this.bgFrame) {
      this.bgFrame.hidden = true;
      this.bgFrame.setAttribute('hidden', '');
      this.bgFrame.removeAttribute('src');
    }
    this.setShutterSolid(true);
    this.updateBgDismissVisibility();
  }

  async useSelectedBackground() {
    const url = this.selectedBgUrl;
    if (!url) return;
    try {
      const resp = await fetch(url, { mode: 'cors', cache: 'no-store' });
      const blob = await resp.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = dataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || 1080;
      canvas.height = img.naturalHeight || 1080;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      this.drawOverlayText(ctx, canvas.width, canvas.height);
      const outBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (!outBlob) throw new Error('blob');
      const file = new File([outBlob], `bg-${Date.now()}.jpg`, { type: 'image/jpeg' });
      this.clearBackgroundSelection();
      this.showReview(file);
    } catch (err) {
      console.error('[VideoRecorder] background use failed', err);
      alert('טעינת הרקע נכשלה. נסו תמונה אחרת.');
    }
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
      // אחרי שיקוף — איפוס טרנספורם לפני ציור טקסט | HYPER CORE TECH
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.drawOverlayText(ctx, w, h);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (!blob) throw new Error('blob');
      const file = new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
      this.showReview(file);
    } catch (err) {
      console.error('[VideoRecorder] photo failed', err);
      alert('צילום התמונה נכשל');
    }
  }

  async ensureMicForRecording() {
    if (!this.stream) return;
    const liveMic = this.stream.getAudioTracks().some((track) => track.readyState === 'live');
    if (liveMic) return;
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      mic.getAudioTracks().forEach((track) => {
        try { this.stream.addTrack(track); } catch (_) {}
      });
    } catch (err) {
      console.warn('[VideoRecorder] mic for recording failed', err);
    }
  }

  bindMediaRecorder(recorder) {
    this.mediaRecorder = recorder;
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.recordedChunks.push(event.data);
    };
    this.mediaRecorder.onstop = () => this.processRecording();
    this.mediaRecorder.onerror = () => this.fallbackRecorderIfNeeded();
  }

  createMediaRecorder(mimeType) {
    const opts = {
      videoBitsPerSecond: 1_500_000,
      audioBitsPerSecond: 96_000,
    };
    if (mimeType) opts.mimeType = mimeType;
    try {
      return new MediaRecorder(this.stream, opts);
    } catch (_) {
      if (mimeType) {
        try { return new MediaRecorder(this.stream, { mimeType }); } catch (__) {}
      }
      return new MediaRecorder(this.stream);
    }
  }

  fallbackRecorderIfNeeded() {
    if (this._recorderFallback || this.recordedChunks.length) return;
    this._recorderFallback = true;
    try {
      this.mediaRecorder.onstop = null;
      this.mediaRecorder.onerror = null;
    } catch (_) {}
    try { this.mediaRecorder.stop(); } catch (_) {}
    try {
      const recorder = this.createMediaRecorder('video/webm;codecs=vp8,opus');
      this.recordedChunks = [];
      this.bindMediaRecorder(recorder);
      this.mediaRecorder.start(1000);
    } catch (err) {
      console.warn('[VideoRecorder] recorder fallback failed', err);
    }
  }

  async startRecording() {
    if (!this.stream) {
      alert('מצלמה לא מוכנה. אנא המתן עד שהמצלמה תיטען.');
      return;
    }

    try {
      await this.ensureMicForRecording();
      this.recordedChunks = [];
      this._recorderFallback = false;
      const mimes = this.listRecorderMimes();
      let recorder = null;
      for (let i = 0; i < mimes.length; i += 1) {
        try {
          recorder = this.createMediaRecorder(mimes[i]);
          if (recorder) break;
        } catch (_) {}
      }
      if (!recorder) recorder = this.createMediaRecorder('');
      this.bindMediaRecorder(recorder);
      this.mediaRecorder.start(1000);
      this.isRecording = true;
      this.recordingStartTime = Date.now();
      this.recordButton?.classList.add('recording');
      this.modal?.classList.add('is-recording');
      this.setShutterSolid(true);
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
    this.modal?.classList.remove('is-recording');
    this.setShutterSolid(!this.selectedBgUrl);
  }

  startTimer() {
    this.startFloatingTimer();
  }

  startFloatingTimer() {
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = null;
    }
    if (this.floatingTimerInterval) {
      clearInterval(this.floatingTimerInterval);
      this.floatingTimerInterval = null;
    }
    this.floatingTimer?.classList.add('visible');
    this.floatingTimer?.classList.remove('pulse');
    const updateFloatingTimer = () => {
      if (!this.isRecording) {
        this.floatingTimer?.classList.remove('visible');
        return;
      }
      const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
      const display = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
      if (this.floatingTimer) this.floatingTimer.textContent = display;
    };
    updateFloatingTimer();
    this.floatingTimerInterval = setInterval(updateFloatingTimer, 1000);
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
      const overlay = String(this._composeOverlayText || '').trim();
      this._composeOverlayText = '';
      if (typeof window.handleMediaInput !== 'function') {
        console.error('[VideoRecorder] handleMediaInput function not found!');
        alert('שגיאה בהעברת המדיה לקומפוזר. נסו לבחור קובץ ידנית.');
        return;
      }
      Promise.resolve(window.handleMediaInput({ target: { files: [file], value: '' } }))
        .catch((err) => {
          console.error('[VideoRecorder] handleMediaInput failed', err);
        })
        .then(() => {
          const ta = document.getElementById('postText');
          if (overlay && ta && !String(ta.value || '').trim()) {
            ta.value = overlay;
            try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
          }
        });
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

function openVideoRecordReview(file) {
  if (!window.videoRecorder) window.videoRecorder = new VideoRecorder();
  window.videoRecorder.openReviewWithFile(file);
}

window.closeVideoRecordModal = closeVideoRecordModal;
window.openVideoRecordModal = openVideoRecordModal;
window.openVideoRecordReview = openVideoRecordReview;

document.addEventListener('DOMContentLoaded', () => {
  if (!window.videoRecorder) window.videoRecorder = new VideoRecorder();
});

if (document.readyState !== 'loading' && !window.videoRecorder) {
  window.videoRecorder = new VideoRecorder();
}
