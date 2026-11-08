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
    this.slides = [];
    this.slideIndex = 0;
    this.slideSeconds = 5;
    this._slideTimer = 0;
    this.selectedBgUrl = '';
    this.bgUrls = [];
    this.overlayText = '';
    this.overlayTextPos = 'top';
    this.overlayStyle = 'classic';
    this.overlayColor = '#ffffff';
    this.overlayBg = false;
    this.overlayAlign = 'center';
    this.overlayScale = 1;
    this._studioOpen = false;
    this._confirming = false;
    this._swipeHintShown = false;
    this._swipeHintTimer = 0;
    this._bgNavLock = false;
    this._bgClosing = false;
    this._bgNavTimer = 0;
    this._bgLoadToken = 0;
    this.bgStripScrolled = false;
    this.cameraAvailable = true;
    this._bgLoadTimer = 0;
    this.countdownTimer = null;
    this._beepCtx = null;
    this.gridOn = false;
    this.backgroundsOpen = false;
    this.toolsExpanded = true;
    this._bgContinuing = false;
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
    this.reviewImageB = document.getElementById('videoRecordReviewImageB');
    this.slideDock = document.getElementById('videoRecordSlideDock');
    this.slideRow = document.getElementById('videoRecordSlideRow');
    this.slideAdd = document.getElementById('videoRecordSlideAdd');
    this.slideClock = document.getElementById('videoRecordSlideClock');
    this.slideTime = document.getElementById('videoRecordSlideTime');
    this.slideSecondsEl = document.getElementById('videoRecordSlideSeconds');
    this.slideInput = document.getElementById('videoRecordSlideInput');
    this.addSheet = document.getElementById('videoRecordAddSheet');
    this.recordButton = document.getElementById('recordButton');
    this.cameraSwitch = document.getElementById('cameraSwitchButton');
    this.flashButton = document.getElementById('cameraFlashButton');
    this.gridButton = document.getElementById('videoRecordGridBtn');
    this.gridEl = document.getElementById('videoRecordGrid');
    this.countdownEl = document.getElementById('videoRecordCountdown');
    this.reviewTextLayer = document.getElementById('videoRecordReviewTextLayer');
    this.reviewTextBtn = document.getElementById('videoRecordReviewTextBtn');
    this.textStudio = document.getElementById('videoRecordTextStudio');
    this.textStudioBottom = document.getElementById('videoRecordTextStudioBottom');
    this.textStudioDone = document.getElementById('videoRecordTextStudioDone');
    this.textAlignBtn = document.getElementById('videoRecordTextAlign');
    this.textColorBtn = document.getElementById('videoRecordTextColor');
    this.textColorDot = document.getElementById('videoRecordTextColorDot');
    this.textColors = document.getElementById('videoRecordTextColors');
    this.textBgBtn = document.getElementById('videoRecordTextBg');
    this.textSize = document.getElementById('videoRecordTextSize');
    this.studioInput = document.getElementById('videoRecordStudioInput');
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
    this.sideTools = document.getElementById('videoRecordSideTools');
    this.toolsToggle = document.getElementById('videoRecordToolsToggle');
    this.liveBtn = document.getElementById('videoRecordLiveBtn');
    this.bgBtn = document.getElementById('videoRecordBgBtn');
    this.continueBtn = document.getElementById('videoRecordContinueBtn');
    this.swipeHint = document.getElementById('videoRecordSwipeHint');
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
    this.toolsToggle?.addEventListener('click', () => this.toggleToolsExpanded());
    this.continueBtn?.addEventListener('click', () => this.continueWithBackground());
    this.cameraSwitch?.addEventListener('click', () => this.switchCamera());
    this.flashButton?.addEventListener('click', () => this.toggleFlash());
    this.gridButton?.addEventListener('click', () => this.toggleGrid());
    this.closeBtn?.addEventListener('click', () => {
      if (this._appendNext && this.slides.length) {
        this.returnToReviewFromAdd();
        return;
      }
      this.closeModal();
    });
    this.reviewBackBtn?.addEventListener('click', () => {
      if (this._studioOpen) {
        this.closeTextStudio();
        return;
      }
      this.backToCamera();
    });
    this.reviewTextBtn?.addEventListener('click', () => this.openTextStudio());
    this.textStudioDone?.addEventListener('click', () => this.closeTextStudio());
    this.textAlignBtn?.addEventListener('click', () => this.cycleTextAlign());
    this.textColorBtn?.addEventListener('click', () => this.toggleColorPop());
    this.textBgBtn?.addEventListener('click', () => this.toggleTextBackground());
    this.textSize?.addEventListener('input', () => {
      const n = Number(this.textSize.value) || 100;
      this.overlayScale = Math.max(0.55, Math.min(1.8, n / 100));
      this.renderTextLayer();
    });
    this.studioInput?.addEventListener('input', () => {
      this.overlayText = String(this.studioInput.value || '').trim();
      this.renderTextLayer();
    });
    this.textColors?.querySelectorAll('[data-color]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setOverlayColor(btn.getAttribute('data-color') || '#ffffff');
      });
    });
    this.textStudio?.querySelectorAll('[data-font]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setOverlayStyle(btn.getAttribute('data-font') || 'classic');
      });
    });
    this.textStudio?.querySelectorAll('[data-text-pos]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setTextPosition(btn.getAttribute('data-text-pos') || 'middle');
      });
    });
    if (window.visualViewport && !VideoRecorder._vvBound) {
      VideoRecorder._vvBound = true;
      const place = () => window.videoRecorder?.placeStudioAboveKeyboard();
      window.visualViewport.addEventListener('resize', place);
      window.visualViewport.addEventListener('scroll', place);
    }
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
        if (mode === '10' || mode === '20' || mode === '30') {
          this.setCaptureMode(mode);
          return;
        }
        if (mode === 'photo') {
          this.setCaptureMode('photo');
          if (this.cameraAvailable && this.stream) this.capturePhoto();
          else {
            try { this.galleryInput?.click(); } catch (_) {}
          }
        }
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
    this.slideAdd?.addEventListener('click', () => this.openAddSheet());
    this.addSheet?.addEventListener('click', (event) => {
      const choice = event.target?.closest?.('[data-add]')?.getAttribute('data-add');
      if (!choice || choice === 'cancel') {
        this.closeAddSheet();
        return;
      }
      this.closeAddSheet();
      if (choice === 'gallery') {
        this.slideInput?.click();
        return;
      }
      this.beginAppendCapture(choice);
    });
    this.slideInput?.addEventListener('change', (event) => {
      const files = [...(event.target?.files || [])];
      this.addSlideFiles(files);
      try { event.target.value = ''; } catch (_) {}
    });
    this.slideRow?.addEventListener('click', (event) => {
      const thumb = event.target?.closest?.('[data-slide]');
      if (!thumb) return;
      this.showSlide(Number(thumb.getAttribute('data-slide')) || 0, false);
      this.startSlideShow();
    });
    this.slideClock?.addEventListener('click', () => this.toggleSlideTime());
    this.slideTime?.addEventListener('click', (event) => {
      const btn = event.target?.closest?.('[data-sec]');
      if (!btn) return;
      this.changeSlideSeconds(Number(btn.getAttribute('data-sec')) || 0);
    });

    this.bgStrip?.addEventListener('click', (event) => {
      if (event.target?.closest?.('.vr-bg-dismiss')) return;
      const thumb = event.target?.closest?.('.vr-bg-thumb');
      if (!thumb || !this.bgStrip) return;
      this.focusBackgroundThumb(thumb);
    });

    this.bgStrip?.addEventListener('scrollend', () => {
      this._bgNavLock = false;
      if (this._bgClosing) return;
      this.syncBackgroundFromScroll(true);
      this.updateBgDismissVisibility();
    });

    this.bindPreviewSwipe();
    this.restoreToolsExpanded();
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
    this.setShutterSolid(true);
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
    try {
      const FeedApp = window.NostrApp || {};
      if (typeof FeedApp.setFeedWarmupPaused === 'function') FeedApp.setFeedWarmupPaused(true);
    } catch (_) {}
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
      const FeedApp = window.NostrApp || {};
      if (typeof FeedApp.maybeResumeFeedAfterChat === 'function') {
        FeedApp.maybeResumeFeedAfterChat();
      } else if (typeof FeedApp.setFeedWarmupPaused === 'function') {
        FeedApp.setFeedWarmupPaused(false);
      }
      if (typeof window.resumeCenteredFeedVideo === 'function') {
        window.resumeCenteredFeedVideo();
      } else if (typeof FeedApp.resumeCenteredFeedVideo === 'function') {
        FeedApp.resumeCenteredFeedVideo();
      }
    } catch (_) {}
  }

  openModal() {
    if (!this.modal) return;
    this.modal.classList.add('is-visible');
    this.modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('video-record-open');
    this.freezeFeedForCamera();
    this.resetState();
    this.cameraAvailable = true;
    this.clearOverlayText();
    this.clearBackgroundSelection();
    this.hideTextEditor();
    this.exitNoCameraMode();
    this.showCameraStage();
    this.setCaptureMode(this.captureMode || '10');
    this.restoreToolsExpanded();
    this.restoreGalleryThumb();
    this.startCamera();
    this.scheduleBackgroundStrip();
    this._swipeHintShown = false;
    this.hideSwipeHint(false);
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
    this.hideSwipeHint(false);
    this.closeAddSheet();
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
      this.floatingTimer.textContent = '0:00';
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
      this.reviewImage.hidden = true;
      this.reviewImage.removeAttribute('src');
    }
    if (this.reviewImageB) {
      this.reviewImageB.hidden = true;
      this.reviewImageB.removeAttribute('src');
    }
    this.stopSlideShow();
    this.revokeOwnedSlides();
    this.slides = [];
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

  resetSlides(file, url) {
    this.stopSlideShow();
    this.revokeOwnedSlides();
    this.slides = [{ id: Date.now(), file, url, owned: false, overlay: this.captureOverlay() }];
    this.slideIndex = 0;
    this.renderSlideRow();
    this.syncSlideSecondsLabel();
  }

  revokeOwnedSlides() {
    (this.slides || []).forEach((slide) => {
      if (slide?.owned && slide.url) {
        try { URL.revokeObjectURL(slide.url); } catch (_) {}
      }
    });
  }

  openAddSheet() {
    if (!this.addSheet) {
      this.slideInput?.click();
      return;
    }
    this.addSheet.hidden = false;
    this.addSheet.removeAttribute('hidden');
  }

  closeAddSheet() {
    if (!this.addSheet) return;
    this.addSheet.hidden = true;
    this.addSheet.setAttribute('hidden', '');
  }

  beginAppendCapture(mode) {
    this.saveOverlayToSlide(this.slideIndex);
    this.closeTextStudio();
    this.stopSlideShow();
    this._appendNext = true;
    this.showCameraStage();
    this.startCamera();
    this.setCaptureMode('photo');
    if (mode === 'random') this.openReadyImagePicker();
  }

  async openReadyImagePicker() {
    if (!this.bgStrip?.querySelector('.vr-bg-thumb[data-bg]:not([data-bg=""])')) {
      await this.loadBackgroundStrip();
    }
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const first = [...(this.bgStrip?.querySelectorAll('.vr-bg-thumb') || [])]
      .find((el) => el.getAttribute('data-bg'));
    if (first) this.focusBackgroundThumb(first);
  }

  returnToReviewFromAdd() {
    this._appendNext = false;
    this.clearBackgroundSelection();
    this.stopCamera();
    this.showReviewStage();
    this.showSlide(this.slideIndex, false);
    if (this.slides.length > 1) this.startSlideShow();
  }

  addSlideFiles(files) {
    let added = false;
    files.forEach((file) => {
      if (!file || !String(file.type || '').startsWith('image/')) return;
      if (this.slides.length >= 8) return;
      const url = URL.createObjectURL(file);
      this.slides.push({
        id: Date.now() + Math.random(),
        file,
        url,
        owned: true,
        overlay: null,
      });
      added = true;
    });
    if (!added) return;
    this.renderSlideRow();
    this.startSlideShow();
  }

  renderSlideRow() {
    if (!this.slideRow) return;
    this.slideRow.innerHTML = this.slides.map((slide, index) => (
      `<button type="button" class="vr-slide-thumb${index === this.slideIndex ? ' is-on' : ''}" data-slide="${index}" style="background-image:url('${slide.url}')" aria-label="תמונה ${index + 1}"></button>`
    )).join('');
  }

  showSlide(index, animate) {
    if (!this.slides.length) return;
    const next = ((index % this.slides.length) + this.slides.length) % this.slides.length;
    this.saveOverlayToSlide(this.slideIndex);
    const slide = this.slides[next];
    this.slideIndex = next;
    this.pendingFile = slide.file;
    this.loadOverlayFromSlide(slide);
    if (!animate || this.slides.length < 2) {
      if (this.reviewImage) this.reviewImage.src = slide.url;
      if (this.reviewImageB) this.reviewImageB.hidden = true;
    } else {
      this.transitionTo(slide.url);
    }
    this.renderSlideRow();
  }

  captureOverlay() {
    if (this._studioOpen && this.studioInput) {
      this.overlayText = String(this.studioInput.value || '').trim();
    }
    return {
      text: String(this.overlayText || ''),
      pos: this.overlayTextPos || 'top',
      style: this.overlayStyle || 'classic',
      color: this.overlayColor || '#ffffff',
      bg: !!this.overlayBg,
      align: this.overlayAlign || 'center',
      scale: Number(this.overlayScale) || 1,
    };
  }

  saveOverlayToSlide(index) {
    const slide = this.slides?.[index];
    if (!slide) return;
    slide.overlay = this.captureOverlay();
  }

  loadOverlayFromSlide(slide) {
    const overlay = slide?.overlay || {};
    this.overlayText = String(overlay.text || '');
    this.overlayTextPos = overlay.pos || 'top';
    this.overlayStyle = overlay.style || 'classic';
    this.overlayColor = overlay.color || '#ffffff';
    this.overlayBg = !!overlay.bg;
    this.overlayAlign = overlay.align || 'center';
    this.overlayScale = Number(overlay.scale) || 1;
    if (this.studioInput) this.studioInput.value = this.overlayText;
    if (this.textInput) this.textInput.value = this.overlayText;
    if (this.textSize) this.textSize.value = String(Math.round((Number(this.overlayScale) || 1) * 100));
    this.syncTextControls();
    this.renderTextLayer();
  }

  pickTransition() {
    const effects = ['fade', 'slide', 'zoom'];
    return effects[Math.floor(Math.random() * effects.length)];
  }

  transitionTo(url) {
    const incoming = this.reviewImageB;
    if (!incoming || !this.reviewImage) {
      if (this.reviewImage) this.reviewImage.src = url;
      return;
    }
    const token = (this._slideToken || 0) + 1;
    this._slideToken = token;
    let started = false;
    const start = () => {
      if (started || token !== this._slideToken) return;
      started = true;
      const effect = this.pickTransition();
      incoming.classList.remove('is-fade', 'is-slide', 'is-zoom');
      incoming.src = url;
      incoming.hidden = false;
      incoming.removeAttribute('hidden');
      void incoming.offsetWidth;
      incoming.classList.add(`is-${effect}`);
      let finished = false;
      const finish = () => {
        if (finished || token !== this._slideToken) return;
        finished = true;
        this.reviewImage.src = url;
        incoming.classList.remove('is-fade', 'is-slide', 'is-zoom');
        incoming.hidden = true;
        incoming.setAttribute('hidden', '');
      };
      incoming.addEventListener('animationend', finish, { once: true });
      setTimeout(finish, 900);
    };
    const preload = new Image();
    preload.onload = start;
    preload.onerror = () => { if (this.reviewImage) this.reviewImage.src = url; };
    preload.src = url;
    if (preload.complete && preload.naturalWidth) start();
  }

  startSlideShow() {
    this.stopSlideShow();
    if (this.slides.length < 2 || !this.stageReview?.classList.contains('is-image')) return;
    const wait = Math.max(1, Number(this.slideSeconds) || 5) * 1000;
    this._slideTimer = setInterval(() => {
      this.showSlide(this.slideIndex + 1, true);
    }, wait);
  }

  stopSlideShow() {
    if (this._slideTimer) {
      clearInterval(this._slideTimer);
      this._slideTimer = 0;
    }
    this._slideToken = (this._slideToken || 0) + 1;
  }

  toggleSlideTime() {
    if (!this.slideTime) return;
    const open = this.slideTime.hasAttribute('hidden');
    this.slideTime.hidden = !open;
    if (open) this.slideTime.removeAttribute('hidden');
    else this.slideTime.setAttribute('hidden', '');
    this.slideClock?.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  changeSlideSeconds(delta) {
    const next = Math.max(1, Math.min(15, (Number(this.slideSeconds) || 5) + delta));
    this.slideSeconds = next;
    this.syncSlideSecondsLabel();
    if (this.slides.length > 1) this.startSlideShow();
  }

  syncSlideSecondsLabel() {
    if (this.slideSecondsEl) this.slideSecondsEl.textContent = String(this.slideSeconds || 5);
  }

  showReview(file) {
    if (!file) return;
    const isVideo = String(file.type || '').startsWith('video/');
    if (this._appendNext && !isVideo && this.slides.length) {
      this._appendNext = false;
      if (this.isRecording) this.stopRecording();
      this.stopCamera();
      this.closeTextStudio();
      this.clearBackgroundSelection();
      const url = URL.createObjectURL(file);
      this.slides.push({
        id: Date.now() + Math.random(),
        file,
        url,
        owned: true,
        overlay: null,
      });
      this.slideIndex = this.slides.length - 1;
      this.pendingFile = file;
      this.stageReview?.classList.add('is-image');
      if (this.reviewVideo) this.reviewVideo.hidden = true;
      if (this.reviewImage) {
        this.reviewImage.hidden = false;
        this.reviewImage.src = url;
      }
      this.loadOverlayFromSlide(this.slides[this.slideIndex]);
      this.renderSlideRow();
      this.showReviewStage();
      this.startSlideShow();
      this.scheduleHideShellFilePickLoading();
      return;
    }
    if (this.isRecording) this.stopRecording();
    this.stopCamera();
    this.clearPendingPreview();
    this.pendingFile = file;
    this.setGalleryThumbFromFile(file);
    this.pendingObjectUrl = URL.createObjectURL(file);
    this._overlayBurnedInFile = false;
    this.stageReview?.classList.toggle('is-image', !isVideo);
    this.closeTextStudio();
    if (isVideo && this.reviewVideo) {
      this.reviewVideo.hidden = false;
      if (this.reviewImage) this.reviewImage.hidden = true;
      this.reviewVideo.src = this.pendingObjectUrl;
      this.reviewVideo.play?.().catch(() => {});
    } else if (this.reviewImage) {
      this.reviewImage.hidden = false;
      if (this.reviewVideo) this.reviewVideo.hidden = true;
      this.reviewImage.src = this.pendingObjectUrl;
      this.resetSlides(file, this.pendingObjectUrl);
    }
    this.renderTextLayer();
    this.showReviewStage();
    this.scheduleHideShellFilePickLoading();
  }

  backToCamera() {
    this.closeTextStudio();
    this.clearPendingPreview();
    this.showCameraStage();
    this.startCamera();
  }

  async confirmPendingFile() {
    if (this._confirming || !this.pendingFile) return;
    this._confirming = true;
    try {
      if (this._studioOpen) this.closeTextStudio();
      this.stopSlideShow();
      this.saveOverlayToSlide(this.slideIndex);
      const albumSlides = (this.slides || []).filter((slide) => slide?.file && !String(slide.file.type || '').startsWith('video/'));
      if (albumSlides.length > 1 && typeof window.handleImageAlbum === 'function') {
        const files = [];
        for (const slide of albumSlides) {
          const overlay = slide.overlay || {};
          this.overlayText = String(overlay.text || '');
          this.overlayTextPos = overlay.pos || 'top';
          this.overlayStyle = overlay.style || 'classic';
          this.overlayColor = overlay.color || '#ffffff';
          this.overlayBg = !!overlay.bg;
          this.overlayAlign = overlay.align || 'center';
          this.overlayScale = Number(overlay.scale) || 1;
          const burned = String(this.overlayText).trim()
            ? await this.burnTextOntoImage(slide.file)
            : slide.file;
          if (burned) files.push(burned);
        }
        const seconds = this.slideSeconds || 5;
        this._composeOverlayText = '';
        if (typeof window.openCompose === 'function') {
          window.openCompose({ step: 'editor', composeMode: 'camera' });
        } else if (window.NostrApp?.openCompose) {
          window.NostrApp.openCompose({ step: 'editor', composeMode: 'camera' });
        }
        this.clearPendingPreview();
        await window.handleImageAlbum(files, { seconds });
        this.closeModal({ skipResume: true });
        return;
      }
      let file = this.pendingFile;
      const isVideo = String(file.type || '').startsWith('video/');
      const text = String(this.overlayText || '').trim();
      if (!isVideo && text) {
        const burned = await this.burnTextOntoImage(file);
        if (burned) file = burned;
        this._composeOverlayText = '';
      } else {
        this._composeOverlayText = text;
      }
    this.lastShareFile = file;
      this.pendingFile = file;
      this.clearPendingPreview();
      this.transferToCompose(file);
      this.closeModal({ skipResume: true });
    } finally {
      this._confirming = false;
    }
  }

  /** חזרה מעורך הפוסט לתצוגה גדולה של אותו קובץ | HYPER CORE TECH */
  openReviewWithFile(file) {
    const target = file || this.lastShareFile;
    if (!this.modal || !target) return;
    this.lastShareFile = target;
    this.modal.classList.add('is-visible');
    this.modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('video-record-open');
    this.freezeFeedForCamera();
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
    if (this.isRecording) this.stopRecording();
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

  playCountdownBeep(isGo = false) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!this._beepCtx) this._beepCtx = new Ctx();
      const ctx = this._beepCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t = ctx.currentTime;
      if (isGo) {
        osc.frequency.setValueAtTime(1320, t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.16, t + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        osc.start(t);
        osc.stop(t + 0.24);
      } else {
        osc.frequency.setValueAtTime(980, t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.14, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
        osc.start(t);
        osc.stop(t + 0.13);
      }
    } catch (_) {}
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
    this.playCountdownBeep(false);
  }

  startCountdown(onDone) {
    this.cancelCountdown();
    this.modal?.classList.add('is-countdown');
    this.ensureMicForRecording()
      .catch((err) => console.warn('[VideoRecorder] mic for recording failed', err));
    let n = 3;
    this.showCountdownNumber(n);
    this.countdownTimer = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        this.playCountdownBeep(true);
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
      this.dismissBackgroundStrip();
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
    const noneBtn = `<button type="button" class="vr-bg-thumb vr-bg-thumb--none" data-bg="" tabindex="-1" aria-hidden="true"></button>`;
    const thumbs = urls.map((url) => {
      const thumb = url.replace('/720/720', '/120/120').replace('/1080/1080', '/120/120');
      return `<button type="button" class="vr-bg-thumb" data-bg="${url}" style="background-image:url('${thumb}')" aria-label="רקע מובנה"></button>`;
    }).join('');
    this.bgStrip.innerHTML = noneBtn + thumbs;
    if (urls[0] && !this.galleryThumbWrap?.classList.contains('has-image')) {
      const preview = urls[0].replace('/720/720', '/120/120').replace('/1080/1080', '/120/120');
      this.setGalleryThumbFromUrl(preview, false);
    }
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
    if (this._bgNavLock || this._bgClosing) return;
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
    this.syncBgPickChrome();
  }

  updateContinueVisibility() {
    this.syncBgPickChrome();
  }

  syncBgPickChrome() {
    const picked = !!this.selectedBgUrl && !this.isRecording;
    this.bgStripScrolled = picked;
    this.modal?.classList.toggle('is-bg-picked', picked);
    [this.bgDismiss, this.continueBtn].forEach((el) => {
      if (!el) return;
      el.hidden = !picked;
      if (picked) el.removeAttribute('hidden');
      else el.setAttribute('hidden', '');
    });
    if (picked) this.bgDismiss?.classList.add('is-visible');
    else this.bgDismiss?.classList.remove('is-visible');
    if (picked) this.showSwipeHint();
  }

  showSwipeHint() {
    if (this._swipeHintShown || !this.swipeHint) return;
    if (!window.matchMedia('(max-width: 768px)').matches) return;
    this._swipeHintShown = true;
    this.swipeHint.hidden = false;
    this.swipeHint.removeAttribute('hidden');
    this.swipeHint.classList.add('is-on');
    clearTimeout(this._swipeHintTimer);
    this._swipeHintTimer = setTimeout(() => this.hideSwipeHint(false), 4500);
  }

  hideSwipeHint(markSeen) {
    clearTimeout(this._swipeHintTimer);
    this._swipeHintTimer = 0;
    if (markSeen) this._swipeHintShown = true;
    if (!this.swipeHint) return;
    this.swipeHint.classList.remove('is-on');
    this.swipeHint.hidden = true;
    this.swipeHint.setAttribute('hidden', '');
  }

  bindPreviewSwipe() {
    const stage = this.stageCamera;
    if (!stage || stage.dataset.swipeBound) return;
    stage.dataset.swipeBound = '1';
    let startX = 0;
    let startY = 0;
    let tracking = false;
    stage.addEventListener('pointerdown', (event) => {
      if (event.target?.closest?.('button, a, label, input, textarea, .vr-bottom, .vr-side-tools, .vr-close')) return;
      tracking = true;
      startX = event.clientX;
      startY = event.clientY;
    });
    stage.addEventListener('pointerup', (event) => {
      if (!tracking) return;
      tracking = false;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) < 42 || Math.abs(dx) < Math.abs(dy)) return;
      this.hideSwipeHint();
      this.stepBackground(dx < 0 ? 1 : -1);
    });
    stage.addEventListener('pointercancel', () => { tracking = false; });
  }

  stepBackground(dir) {
    const thumbs = [...(this.bgStrip?.querySelectorAll('.vr-bg-thumb') || [])];
    if (thumbs.length < 2 || !this.bgStrip) return;
    let index = thumbs.findIndex((el) => el.classList.contains('is-selected'));
    if (index < 0) index = 0;
    const next = Math.max(0, Math.min(thumbs.length - 1, index + dir));
    this.focusBackgroundThumb(thumbs[next]);
  }

  focusBackgroundThumb(thumb) {
    if (!thumb || !this.bgStrip) return;
    this._bgNavLock = true;
    clearTimeout(this._bgNavTimer);
    this._bgNavTimer = setTimeout(() => { this._bgNavLock = false; }, 700);
    const targetLeft = thumb.offsetLeft - (this.bgStrip.clientWidth / 2) + (thumb.offsetWidth / 2);
    this.bgStrip.scrollTo({ left: Math.max(0, targetLeft), behavior: 'smooth' });
    const url = thumb.getAttribute('data-bg') || '';
    if (!url) this.clearBackgroundSelection(true);
    else this.selectBackground(url, thumb);
  }

  dismissBackgroundStrip() {
    this._bgClosing = true;
    this._bgNavLock = true;
    clearTimeout(this._bgNavTimer);
    this.clearBackgroundSelection(true);
    this.hideSwipeHint(false);
    if (this.bgStrip) {
      const noneThumb = this.bgStrip.querySelector('.vr-bg-thumb--none');
      const targetLeft = noneThumb
        ? noneThumb.offsetLeft - (this.bgStrip.clientWidth / 2) + (noneThumb.offsetWidth / 2)
        : 0;
      this.bgStrip.scrollLeft = Math.max(0, targetLeft);
    }
    this.updateBgDismissVisibility();
    requestAnimationFrame(() => {
      this._bgClosing = false;
      this._bgNavLock = false;
    });
  }

  restoreToolsExpanded() {
    this.applyToolsExpanded(false, false);
    this.toolsToggle?.classList.add('is-hint');
  }

  applyToolsExpanded(expanded, persist) {
    this.toolsExpanded = !!expanded;
    this.sideTools?.classList.toggle('is-collapsed', !this.toolsExpanded);
    this.toolsToggle?.setAttribute('aria-expanded', this.toolsExpanded ? 'true' : 'false');
    this.toolsToggle?.setAttribute('aria-label', this.toolsExpanded ? 'הסתר הסברים' : 'הצג הסברים');
    const icon = this.toolsToggle?.querySelector('i');
    if (icon) icon.className = this.toolsExpanded ? 'fa-solid fa-chevron-left' : 'fa-solid fa-chevron-right';
    if (expanded) this.toolsToggle?.classList.remove('is-hint');
    if (persist) {
      try { localStorage.setItem('sos_vr_tools_open', this.toolsExpanded ? '1' : '0'); } catch (_) {}
    }
  }

  toggleToolsExpanded() {
    this.toolsToggle?.classList.remove('is-hint');
    this.applyToolsExpanded(!this.toolsExpanded, false);
  }

  async toggleBackgrounds() {
    if (this.isRecording) return;
    if (this.backgroundsOpen) {
      this.setBackgroundsOpen(false);
      return;
    }
    this.setBackgroundsOpen(true);
    if (!this.bgStrip?.querySelector('.vr-bg-thumb')) {
      await this.loadBackgroundStrip();
    }
  }

  setBackgroundsOpen(open) {
    this.backgroundsOpen = !!open;
    this.bgBtn?.classList.toggle('is-active', this.backgroundsOpen);
    this.bgBtn?.setAttribute('aria-pressed', this.backgroundsOpen ? 'true' : 'false');
    if (this.bgStrip) {
      this.bgStrip.hidden = !this.backgroundsOpen;
      if (this.backgroundsOpen) this.bgStrip.removeAttribute('hidden');
      else this.bgStrip.setAttribute('hidden', '');
    }
    if (!this.backgroundsOpen) this.clearBackgroundSelection();
    this.updateBgDismissVisibility();
    this.updateContinueVisibility();
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
    this.setTextPosition(this.overlayTextPos || 'top');
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
    this.modal?.querySelectorAll('[data-text-pos]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-text-pos') === next);
    });
    if (this.textLayer) this.textLayer.setAttribute('data-pos', next);
    if (this.reviewTextLayer) this.reviewTextLayer.setAttribute('data-pos', next);
    this.renderTextLayer();
  }

  applyTextToLayer(layer, forceHide) {
    if (!layer) return;
    const text = String(this.overlayText || '').trim();
    layer.replaceChildren();
    if (forceHide || !text) {
      layer.hidden = true;
      layer.setAttribute('hidden', '');
      return;
    }
    const ink = document.createElement('span');
    ink.className = 'vr-text-ink';
    ink.textContent = this.overlayStyle === 'retro' ? text.toUpperCase() : text;
    if (this.overlayBg) ink.style.background = this.plateColor(this.overlayColor);
    layer.appendChild(ink);
    layer.setAttribute('data-pos', this.overlayTextPos || 'top');
    layer.setAttribute('data-style', this.overlayStyle || 'classic');
    layer.setAttribute('data-align', this.overlayAlign || 'center');
    layer.setAttribute('data-bg', this.overlayBg ? '1' : '0');
    layer.style.color = this.overlayColor || '#ffffff';
    layer.style.fontSize = `${(7 * (Number(this.overlayScale) || 1)).toFixed(2)}vw`;
    layer.hidden = false;
    layer.removeAttribute('hidden');
  }

  renderTextLayer() {
    this.applyTextToLayer(this.textLayer);
    this.applyTextToLayer(this.reviewTextLayer, this._overlayBurnedInFile);
  }

  clearOverlayText() {
    this.overlayText = '';
    this.overlayTextPos = 'top';
    this.overlayStyle = 'classic';
    this.overlayColor = '#ffffff';
    this.overlayBg = false;
    this.overlayAlign = 'center';
    this.overlayScale = 1;
    if (this.textInput) this.textInput.value = '';
    if (this.studioInput) this.studioInput.value = '';
    if (this.textSize) this.textSize.value = '100';
    this.syncTextControls();
    this.closeTextStudio();
    this.renderTextLayer();
    this.hideTextEditor();
  }

  openTextStudio() {
    if (!this.textStudio || !this.stageReview?.classList.contains('is-image')) return;
    this.stopSlideShow();
    this._studioOpen = true;
    this.textStudio.hidden = false;
    this.textStudio.removeAttribute('hidden');
    this.stageReview.classList.add('is-texting');
    this.reviewTextBtn?.classList.add('is-active');
    if (this.studioInput) {
      this.studioInput.value = this.overlayText || '';
      try { this.studioInput.focus(); } catch (_) {}
    }
    this.syncTextControls();
    this.renderTextLayer();
    this.placeStudioAboveKeyboard();
  }

  closeTextStudio() {
    const wasOpen = this._studioOpen;
    this._studioOpen = false;
    if (wasOpen && this.studioInput) this.overlayText = String(this.studioInput.value || '').trim();
    if (this.textStudio) {
      this.textStudio.hidden = true;
      this.textStudio.setAttribute('hidden', '');
    }
    if (this.textColors) {
      this.textColors.hidden = true;
      this.textColors.setAttribute('hidden', '');
    }
    this.textColorBtn?.setAttribute('aria-expanded', 'false');
    this.stageReview?.classList.remove('is-texting');
    this.reviewTextBtn?.classList.remove('is-active');
    if (this.textStudioBottom) this.textStudioBottom.style.transform = '';
    this.saveOverlayToSlide(this.slideIndex);
    this.renderTextLayer();
    const reviewOpen = this.modal?.classList.contains('is-visible') && this.stageReview && !this.stageReview.hidden;
    if (reviewOpen && this.slides.length > 1) this.startSlideShow();
  }

  placeStudioAboveKeyboard() {
    if (!this._studioOpen || !this.textStudioBottom || !window.visualViewport) return;
    const vv = window.visualViewport;
    const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    this.textStudioBottom.style.transform = offset ? `translateY(-${Math.round(offset)}px)` : '';
  }

  syncTextControls() {
    const style = this.overlayStyle || 'classic';
    const color = this.overlayColor || '#ffffff';
    const align = this.overlayAlign || 'center';
    this.textStudio?.querySelectorAll('[data-font]').forEach((btn) => {
      btn.classList.toggle('is-on', btn.getAttribute('data-font') === style);
    });
    this.textColors?.querySelectorAll('[data-color]').forEach((btn) => {
      btn.classList.toggle('is-on', (btn.getAttribute('data-color') || '').toLowerCase() === color.toLowerCase());
    });
    if (this.textColorDot) this.textColorDot.style.background = '';
    this.textBgBtn?.classList.toggle('is-on', !!this.overlayBg);
    this.textBgBtn?.setAttribute('aria-pressed', this.overlayBg ? 'true' : 'false');
    const icon = this.textAlignBtn?.querySelector('i');
    if (icon) {
      icon.className = align === 'right'
        ? 'fa-solid fa-align-right'
        : align === 'left'
          ? 'fa-solid fa-align-left'
          : 'fa-solid fa-align-center';
    }
    this.modal?.querySelectorAll('[data-text-pos]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-text-pos') === (this.overlayTextPos || 'top'));
    });
  }

  setOverlayStyle(style) {
    const allowed = ['classic', 'retro', 'neon', 'comic', 'elegant'];
    this.overlayStyle = allowed.includes(style) ? style : 'classic';
    this.syncTextControls();
    this.renderTextLayer();
  }

  setOverlayColor(color) {
    this.overlayColor = color || '#ffffff';
    if (this.textColors) {
      this.textColors.hidden = true;
      this.textColors.setAttribute('hidden', '');
    }
    this.textColorBtn?.setAttribute('aria-expanded', 'false');
    this.syncTextControls();
    this.renderTextLayer();
  }

  toggleColorPop() {
    if (!this.textColors) return;
    const open = this.textColors.hasAttribute('hidden');
    this.textColors.hidden = !open;
    if (open) this.textColors.removeAttribute('hidden');
    else this.textColors.setAttribute('hidden', '');
    this.textColorBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  toggleTextBackground() {
    this.overlayBg = !this.overlayBg;
    this.syncTextControls();
    this.renderTextLayer();
  }

  cycleTextAlign() {
    const order = ['center', 'right', 'left'];
    const i = order.indexOf(this.overlayAlign || 'center');
    this.overlayAlign = order[(i + 1) % order.length];
    this.syncTextControls();
    this.renderTextLayer();
  }

  plateColor(hex) {
    const c = String(hex || '').replace('#', '');
    if (c.length < 6) return 'rgba(0,0,0,0.78)';
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.62 ? 'rgba(0,0,0,0.78)' : 'rgba(255,255,255,0.92)';
  }

  fillRoundRect(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
    ctx.fill();
  }

  async burnTextOntoImage(file) {
    if (!file) return null;
    const text = String(this.overlayText || '').trim();
    if (!text) return file;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = dataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width || 1080;
      canvas.height = img.naturalHeight || img.height || 1080;
      const ctx = canvas.getContext('2d');
      if (!ctx) return file;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      this.drawOverlayText(ctx, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (!blob) return file;
      return new File([blob], `photo-text-${Date.now()}.jpg`, { type: 'image/jpeg' });
    } catch (err) {
      console.error('[VideoRecorder] burn text failed', err);
      return file;
    }
  }

  coverFrame(imgW, imgH) {
    const viewW = Math.max(1, window.innerWidth || 390);
    const viewH = Math.max(1, window.innerHeight || 844);
    const viewRatio = viewW / viewH;
    const imgRatio = imgW / Math.max(1, imgH);
    if (imgRatio > viewRatio) {
      const w = imgH * viewRatio;
      return { x: (imgW - w) / 2, y: 0, w, h: imgH };
    }
    const h = imgW / viewRatio;
    return { x: 0, y: (imgH - h) / 2, w: imgW, h };
  }

  layoutOverlayLines(ctx, text, fontSize, family, weight, fontStyle, maxWidth) {
    ctx.font = `${fontStyle} ${weight} ${fontSize}px ${family}`;
    const lines = [];
    let tooWide = false;
    String(text || '').split(/\n+/).forEach((para) => {
      const words = para.split(/\s+/).filter(Boolean);
      let line = '';
      words.forEach((word) => {
        if (ctx.measureText(word).width > maxWidth) tooWide = true;
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && line) {
          lines.push(line);
          line = word;
        } else {
          line = test;
        }
      });
      if (line) lines.push(line);
    });
    if (!lines.length && text) lines.push(text);
    lines.forEach((line) => {
      if (ctx.measureText(line).width > maxWidth) tooWide = true;
    });
    return { lines, tooWide, lineHeight: fontSize * 1.25 };
  }

  drawOverlayText(ctx, width, height) {
    const raw = String(this.overlayText || '').trim();
    if (!raw || !ctx) return;
    const pos = this.overlayTextPos || 'top';
    const align = this.overlayAlign || 'center';
    const style = this.overlayStyle || 'classic';
    const scale = Number(this.overlayScale) || 1;
    const color = this.overlayColor || '#ffffff';
    const text = style === 'retro' ? raw.toUpperCase() : raw;
    const frame = this.coverFrame(width, height);
    const maxWidth = frame.w * 0.86;
    const family = style === 'retro'
      ? '"Courier New", monospace'
      : style === 'comic'
        ? '"Comic Sans MS", "Comic Sans", cursive'
        : style === 'elegant'
          ? 'Georgia, "Times New Roman", serif'
          : 'sans-serif';
    const weight = style === 'elegant' ? 600 : 800;
    const fontStyle = style === 'elegant' ? 'italic' : 'normal';
    ctx.save();
    ctx.direction = 'rtl';
    ctx.textAlign = align === 'right' ? 'right' : align === 'left' ? 'left' : 'center';
    ctx.textBaseline = 'middle';
    let fontSize = Math.max(18, Math.round(frame.w * 0.07 * scale));
    let layout = this.layoutOverlayLines(ctx, text, fontSize, family, weight, fontStyle, maxWidth);
    while ((layout.tooWide || layout.lines.length * layout.lineHeight > frame.h * 0.62) && fontSize > 16) {
      fontSize -= 2;
      layout = this.layoutOverlayLines(ctx, text, fontSize, family, weight, fontStyle, maxWidth);
    }
    const { lines, lineHeight } = layout;
    const blockH = Math.max(lineHeight, lines.length * lineHeight);
    let y;
    if (pos === 'top') y = frame.y + frame.h * 0.16;
    else if (pos === 'bottom') y = frame.y + frame.h * 0.84 - blockH + lineHeight;
    else y = frame.y + (frame.h - blockH) / 2 + lineHeight / 2;
    const minY = frame.y + lineHeight / 2 + 8;
    const maxY = frame.y + frame.h - blockH + lineHeight / 2 - 8;
    y = Math.max(minY, Math.min(maxY, y));
    const x = align === 'right'
      ? frame.x + frame.w * 0.9
      : align === 'left'
        ? frame.x + frame.w * 0.1
        : frame.x + frame.w / 2;
    if (this.overlayBg && lines.length) {
      const padX = fontSize * 0.34;
      const padY = fontSize * 0.16;
      const maxLine = Math.max(...lines.map((ln) => ctx.measureText(ln).width));
      const boxW = maxLine + padX * 2;
      const boxH = blockH + padY * 2;
      const bx = align === 'right' ? x - boxW : align === 'left' ? x : x - boxW / 2;
      const by = y - lineHeight / 2 - padY;
      ctx.fillStyle = this.plateColor(color);
      this.fillRoundRect(ctx, bx, by, boxW, boxH, fontSize * 0.22);
    }
    ctx.fillStyle = color;
    ctx.strokeStyle = style === 'neon' ? color : 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(2, Math.round(fontSize * (style === 'neon' ? 0.05 : 0.08)));
    if (style === 'neon') {
      ctx.shadowColor = color;
      ctx.shadowBlur = fontSize * 0.45;
    }
    lines.forEach((ln, i) => {
      const yy = y + i * lineHeight;
      if (style !== 'neon') ctx.strokeText(ln, x, yy);
      ctx.fillText(ln, x, yy);
    });
    ctx.restore();
  }

  selectBackground(url, thumbEl) {
    this.selectedBgUrl = url;
    this.bgStrip?.querySelectorAll('.vr-bg-thumb').forEach((el) => {
      el.classList.toggle('is-selected', el === thumbEl || el.getAttribute('data-bg') === url);
    });
    this._bgLoadToken = (this._bgLoadToken || 0) + 1;
    const token = this._bgLoadToken;
    const reveal = () => {
      if (token !== this._bgLoadToken || this.selectedBgUrl !== url || !this.bgFrame) return;
      if (this.bgFrame.getAttribute('src') !== url) this.bgFrame.src = url;
      this.bgFrame.hidden = false;
      this.bgFrame.removeAttribute('hidden');
    };
    const pending = new Image();
    pending.onload = reveal;
    pending.src = url;
    if (pending.complete && pending.naturalWidth) reveal();
    this.setShutterSolid(true);
    this.updateContinueVisibility();
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
    this.updateContinueVisibility();
    this.updateBgDismissVisibility();
  }

  async buildBackgroundFile() {
    const url = this.selectedBgUrl;
    if (!url) return null;
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
      const outBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (!outBlob) throw new Error('blob');
      const file = new File([outBlob], `bg-${Date.now()}.jpg`, { type: 'image/jpeg' });
      return file;
    } catch (err) {
      console.error('[VideoRecorder] background use failed', err);
      alert('טעינת הרקע נכשלה. נסו תמונה אחרת.');
      return null;
    }
  }

  async continueWithBackground() {
    if (this._bgContinuing || !this.selectedBgUrl) return;
    this._bgContinuing = true;
    this.continueBtn?.setAttribute('disabled', '');
    try {
      const file = await this.buildBackgroundFile();
      if (!file) return;
      this.clearBackgroundSelection();
      this.showReview(file);
    } finally {
      this._bgContinuing = false;
      this.continueBtn?.removeAttribute('disabled');
    }
  }

  async useSelectedBackground() {
    const file = await this.buildBackgroundFile();
    if (!file) return;
    this.clearBackgroundSelection();
    this.showReview(file);
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

  recordStream() {
    return this.stream;
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
    const src = this.recordStream();
    const opts = {
      videoBitsPerSecond: 1_500_000,
      audioBitsPerSecond: 96_000,
    };
    if (mimeType) opts.mimeType = mimeType;
    try {
      return new MediaRecorder(src, opts);
    } catch (_) {
      if (mimeType) {
        try { return new MediaRecorder(src, { mimeType }); } catch (__) {}
      }
      return new MediaRecorder(src);
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
    this.setShutterSolid(true);
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
      const display = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
      if (this.floatingTimer) this.floatingTimer.textContent = display;
    };
    updateFloatingTimer();
    this.floatingTimerInterval = setInterval(updateFloatingTimer, 1000);
  }

  async processRecording() {
    try {
      if (this.recordedChunks.length) {
        const mimeType = this.mediaRecorder?.mimeType || 'video/webm';
        const blob = new Blob(this.recordedChunks, { type: mimeType });
        const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const file = new File([blob], `video-${Date.now()}.${ext}`, { type: mimeType });
        this.showReview(file);
      }
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
