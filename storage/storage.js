'use strict';

/* חלק אחסון (storage.js) – לוגיקת הדף המלאה לפי הפתרון שסופק | HYPER CORE TECH */
(() => {
  const doc = document;
  const win = window;
  const App = win.NostrApp || (win.NostrApp = {});

  const dropZone = doc.getElementById('dropZone');
  const fileInput = doc.getElementById('fileInput');
  const selectButton = doc.getElementById('selectButton');
  const statusBox = doc.getElementById('statusBox');
  const statusMessage = doc.getElementById('statusMessage');
  const resultPanel = doc.getElementById('resultPanel');
  const copyButton = doc.getElementById('copyButton');
  const previewContainer = doc.getElementById('resultPreview');
  const progressBar = doc.getElementById('progressBar');
  const progressValue = doc.getElementById('progressValue');
  const availabilityStatus = doc.getElementById('availabilityStatus');

  const MAX_VIDEO_BYTES = 30 * 1024 * 1024;

  function setAvailability(text, isError) {
    if (!availabilityStatus) return;
    availabilityStatus.textContent = text;
    availabilityStatus.style.color = isError ? '#ff8f8f' : 'var(--text-muted)';
  }

  async function checkAvailability() {
    try {
      setAvailability('מוכן להעלאה');
    } catch (err) {
      console.warn('availability check failed', err);
      setAvailability('זמינות לא ידועה', true);
    }
  }

  function showProgress(value) {
    if (!progressBar || !progressValue) return;
    const safe = Math.max(0, Math.min(100, Math.round(value)));
    progressBar.hidden = false;
    progressBar.max = 100;
    progressBar.value = safe;
    progressValue.hidden = false;
    progressValue.textContent = `${safe}%`;
  }

  function hideProgress() {
    if (!progressBar || !progressValue) return;
    progressBar.hidden = true;
    progressBar.removeAttribute('value');
    progressValue.hidden = true;
    progressValue.textContent = '0%';
  }

  function updateStatus(message, isError = false, keepProgress = false) {
    if (statusMessage) {
      statusMessage.textContent = message;
      statusMessage.style.color = isError ? '#ff8f8f' : 'var(--text-muted)';
    }
    if (statusBox) {
      statusBox.style.color = isError ? '#ff8f8f' : 'var(--text-muted)';
    }
    if (!keepProgress) {
      hideProgress();
    }
  }

  function resetResult() {
    if (resultPanel) {
      resultPanel.hidden = true;
    }
    if (copyButton) {
      delete copyButton.dataset.href;
      copyButton.textContent = 'העתיקו קישור';
    }
    if (previewContainer) {
      previewContainer.innerHTML = '';
    }
    hideProgress();
  }

  async function compressVideo(file) {
    if (!file.type.startsWith('video/')) {
      throw new Error('not-video');
    }
    if (file.size > MAX_VIDEO_BYTES) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      throw new Error(`big-file:${sizeMB}`);
    }

    updateStatus('טוען וידאו לדחיסה...', false, true);

    const video = doc.createElement('video');
    video.src = URL.createObjectURL(file);
    video.muted = false; // חלק אחסון (storage.js) – חשוב! לא muted כדי שהאודיו ייכלל ב-stream | HYPER CORE TECH
    video.volume = 0; // אבל נשתיק את הרמקולים
    video.crossOrigin = 'anonymous';

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('load-failed'));
      setTimeout(() => reject(new Error('load-timeout')), 10_000);
    });

    const stream = typeof video.captureStream === 'function'
      ? video.captureStream()
      : video.mozCaptureStream?.();
    if (!stream) {
      URL.revokeObjectURL(video.src);
      throw new Error('stream-missing');
    }
    
    // חלק אחסון (storage.js) – וודא שהאודיו נתפס בזרם | HYPER CORE TECH
    console.log('[STORAGE] Stream tracks:', {
      video: stream.getVideoTracks().length,
      audio: stream.getAudioTracks().length
    });

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';

    const chunks = [];
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 1_000_000,
      audioBitsPerSecond: 96_000,
    });

    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };

    const duration = video.duration || 1;
    const interval = setInterval(() => {
      const percent = Math.min(90, Math.round((video.currentTime / duration) * 80) + 10);
      updateStatus(`דוחס וידאו... ${percent}%`, false, true);
      showProgress(percent);
    }, 400);

    const completion = new Promise((resolve) => {
      recorder.onstop = resolve;
    });

    recorder.start(100);
    await video.play();
    await new Promise((resolve) => {
      video.onended = () => {
        clearInterval(interval);
        recorder.stop();
        resolve();
      };
    });
    await completion;

    URL.revokeObjectURL(video.src);
    updateStatus('מסיים דחיסה...', false, true);

    return new Blob(chunks, { type: mimeType });
  }

  async function uploadBinary(blob, originalName, onProgress) {
    const fd = new FormData();
    fd.append('file', blob, originalName || 'video.webm');
    const xhr = new XMLHttpRequest();
    const endpoint = 'https://void.cat/upload';

    const response = await new Promise((resolve, reject) => {
      xhr.upload.onprogress = (event) => {
        if (typeof onProgress === 'function') {
          const totalBytes = (event.total && event.total > 0) ? event.total : (blob?.size || event.loaded || 1);
          const loadedBytes = event.loaded ?? 0;
          onProgress(loadedBytes, totalBytes, false);
        }
      };

      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.responseText);
        } else {
          reject(new Error('upload-failed'));
        }
      };

      xhr.onerror = () => reject(new Error('upload-failed'));
      xhr.open('POST', endpoint, true);
      xhr.send(fd);
    });

    try {
      const data = JSON.parse(response);
      if (data?.file?.url) return data.file.url;
      if (data?.url) return data.url;
    } catch (err) {
      console.warn('parse upload response failed', err);
    }
    throw new Error('no-url');
  }

  async function uploadViaApp(blob, mimeType, onProgress) {
    const app = win.NostrApp || {};
    if (typeof app.uploadToBlossom !== 'function') {
      return null;
    }

    if (typeof app.ensureKeys === 'function') {
      try {
        app.ensureKeys();
      } catch (err) {
        console.warn('ensureKeys failed', err);
      }
    }

    let syntheticTimer = null;
    let syntheticValue = 0;

    if (typeof onProgress === 'function') {
      syntheticTimer = setInterval(() => {
        syntheticValue = Math.min(95, syntheticValue + 4);
        onProgress(syntheticValue, 100, true);
      }, 450);
    }

    try {
      const url = await app.uploadToBlossom(blob, null, mimeType);
      if (!url) return null;
      if (typeof onProgress === 'function') {
        onProgress(100, 100, true);
      }
      return typeof url === 'string' ? url : url?.url || null;
    } catch (err) {
      console.warn('app upload failed', err);
      return null;
    } finally {
      if (syntheticTimer) clearInterval(syntheticTimer);
    }
  }

  function presentResult(file, url, label) {
    if (!previewContainer || !resultPanel) return;
    previewContainer.innerHTML = '';

    if (file.type.startsWith('video/')) {
      const wrapper = doc.createElement('div');
      wrapper.style.position = 'relative';
      wrapper.style.display = 'inline-block';
      const video = doc.createElement('video');
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.style.width = '100%';

      const play = doc.createElement('button');
      play.type = 'button';
      play.textContent = '▶';
      play.style.position = 'absolute';
      play.style.inset = '0';
      play.style.margin = 'auto';
      play.style.width = '72px';
      play.style.height = '72px';
      play.style.borderRadius = '50%';
      play.style.border = 'none';
      play.style.background = 'rgba(0,0,0,0.6)';
      play.style.color = '#fff';
      play.style.fontSize = '32px';
      play.style.cursor = 'pointer';
      play.addEventListener('click', () => {
        play.remove();
        video.play().catch(() => {});
      });
      wrapper.appendChild(video);
      wrapper.appendChild(play);
      previewContainer.appendChild(wrapper);
    } else if (file.type.startsWith('audio/')) {
      const audio = doc.createElement('audio');
      audio.controls = true;
      audio.src = url;
      audio.style.width = '100%';
      previewContainer.appendChild(audio);
    } else if (file.type.startsWith('image/')) {
      const img = doc.createElement('img');
      img.src = url;
      img.alt = label;
      img.style.maxWidth = '100%';
      img.style.display = 'block';
      previewContainer.appendChild(img);
    }

    if (copyButton) {
      copyButton.dataset.href = url;
      copyButton.textContent = 'העתיקו קישור';
    }
    resultPanel.hidden = false;
  }

  async function processFiles(list) {
    const file = list?.length ? list[0] : null;
    if (!file) {
      updateStatus('לא נבחר וידאו.', true);
      return;
    }

    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');
    const isAudio = file.type.startsWith('audio/');

    if (!isVideo && !isImage && !isAudio) {
      updateStatus('הקובץ שנבחר אינו וידאו, אודיו או תמונה נתמכים.', true);
      return;
    }

    resetResult();

    try {
      let blob = file;
      let typeLabel = 'מדיה';

      if (isVideo) {
        blob = await compressVideo(file);
        typeLabel = 'וידאו';
        showProgress(0);
        updateStatus('מעלה וידאו...', false, true);
      } else if (isAudio) {
        typeLabel = 'אודיו';
        showProgress(0);
        updateStatus('מעלה אודיו...', false, true);
      } else {
        typeLabel = 'תמונה';
        showProgress(0);
        updateStatus('מעלה תמונה...', false, true);
      }

      const totalBytes = blob.size || file.size || 1;

      const updateProgressDisplay = (loaded, total, synthetic) => {
        let percent;
        if (synthetic) {
          percent = Math.max(0, Math.min(100, Math.round(loaded)));
        } else {
          const baseTotal = total && total > 0 ? total : totalBytes;
          percent = Math.max(0, Math.min(100, Math.round(((loaded ?? 0) / baseTotal) * 100)));
        }
        showProgress(percent);
        updateStatus(`מעלה ${typeLabel}...`, false, true);
      };

      updateProgressDisplay(0, totalBytes, false);

      let url = await uploadViaApp(blob, file.type, updateProgressDisplay);
      if (!url) {
        const fallbackName = isVideo ? 'video.webm' : isAudio ? 'audio.webm' : 'image';
        url = await uploadBinary(blob, file.name || fallbackName, updateProgressDisplay);
      }

      updateProgressDisplay(totalBytes, totalBytes, false);
      presentResult(file, url, file.name || typeLabel);
      updateStatus(`${typeLabel} עלתה בהצלחה.`, false);
      setTimeout(hideProgress, 600);
    } catch (err) {
      console.error('storage upload failed', err);
      hideProgress();
      if (progressValue) progressValue.textContent = '0%';
      const key = err?.message?.split(':')[0];
      const messages = {
        'big-file': 'הקובץ גדול מדי. הגבול הוא 30MB.',
        'load-failed': 'טעינת הווידאו נכשלה. בדקו שהקובץ תקין.',
        'load-timeout': 'טעינת הווידאו ארכה יותר מדי זמן.',
        'stream-missing': 'הדפדפן לא תומך בדחיסה. נסו דפדפן אחר.',
        'upload-failed': 'העלאה נכשלה. נסו שוב מאוחר יותר.',
        'no-url': 'השרת לא החזיר כתובת שיתוף.',
      };
      updateStatus(messages[key] || 'אירעה שגיאה. נסו קובץ אחר או רעננו את העמוד.', true);
    }
  }

  function preventDefaults(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function bindDragAndDrop() {
    if (!dropZone) return;
    ['dragenter', 'dragover'].forEach((type) => {
      dropZone.addEventListener(type, (event) => {
        preventDefaults(event);
        dropZone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach((type) => {
      dropZone.addEventListener(type, (event) => {
        preventDefaults(event);
        dropZone.classList.remove('dragover');
        if (type === 'drop' && event.dataTransfer?.files?.length) {
          processFiles(event.dataTransfer.files);
        }
      });
    });

    dropZone.addEventListener('click', () => fileInput?.click());
  }

  function bindFileSelection() {
    selectButton?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
      if (fileInput.files?.length) {
        processFiles(fileInput.files);
      }
      fileInput.value = '';
    });
  }

  function bindCopyButton() {
    copyButton?.addEventListener('click', async () => {
      const url = copyButton.dataset.href;
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        copyButton.textContent = 'הועתק';
        setTimeout(() => {
          copyButton.textContent = 'העתיקו קישור';
        }, 2000);
      } catch (err) {
        console.warn('clipboard write failed', err);
        copyButton.textContent = 'שגיאת העתקה';
        setTimeout(() => {
          copyButton.textContent = 'העתיקו קישור';
        }, 2000);
      }
    });
  }

  function bindModals() {
    const modalButtons = Array.from(doc.querySelectorAll('[data-modal-target]'));
    const closeButtons = Array.from(doc.querySelectorAll('[data-modal-close]'));

    const openModal = (id) => {
      const modal = doc.getElementById(id);
      if (!modal) return;
      modal.hidden = false;
      modal.setAttribute('aria-hidden', 'false');
      const content = modal.querySelector('.storage-modal__content');
      if (content) content.style.transform = 'scale(1)';
    };

    const closeModal = (id) => {
      const modal = doc.getElementById(id);
      if (!modal) return;
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      const content = modal.querySelector('.storage-modal__content');
      if (content) content.style.transform = 'scale(0.9)';
    };

    modalButtons.forEach((btn) => {
      btn.addEventListener('click', () => openModal(btn.dataset.modalTarget));
    });

    closeButtons.forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.modalClose));
    });

    doc.querySelectorAll('.storage-modal__backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', () => closeModal(backdrop.dataset.modalClose));
    });

    doc.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        doc.querySelectorAll('.storage-modal[aria-hidden="false"]').forEach((modal) => {
          closeModal(modal.id);
        });
      }
    });
  }

  function init() {
    if (!dropZone || !fileInput) {
      console.error('storage page missing elements');
      return;
    }
    updateStatus('ממתין לקובץ...');
    bindDragAndDrop();
    bindFileSelection();
    bindCopyButton();
    bindModals();
    checkAvailability();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
