(function initCompose(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const modal = document.getElementById('composeModal');
  if (!modal) return;

  const elements = {
    modal,
    textarea: document.getElementById('postText'),
    mediaInput: document.getElementById('composeMediaInput'),
    previewContainer: document.getElementById('composeMediaPreview'),
    previewImage: document.getElementById('composeMediaPreviewImage'),
    previewVideo: document.getElementById('composeMediaPreviewVideo'),
    status: document.getElementById('composeStatus'),
    profileName: document.getElementById('composeProfileName'),
    profileBio: document.getElementById('composeProfileBio'),
    profileAvatar: document.getElementById('composeProfileAvatar'),
    bgToggle: document.getElementById('composeBgToggle'),
    bgGallery: document.getElementById('composeBackgrounds'),
    bgClear: document.getElementById('composeBgClear'),
    bgOptions: document.getElementById('composeBgOptions'),
    bgTextOnlyToggle: document.getElementById('composeBgTextOnlyToggle'),
    bgZoomToggle: document.getElementById('composeBgZoomToggle'),
    policyCheckbox: document.getElementById('composePolicyCheckbox'),
    rightsCheckbox: document.getElementById('composeRightsCheckbox'),
    publishButton: document.getElementById('composePublishButton'),
  };

  const state = {
    media: null,
    // חלק קומפוזר – מצב עריכה: מזהה פוסט מקורי אם מדובר בעריכה ולא ביצירה חדשה
    editingOriginalId: null,
    mediaInputBound: false,
    // חלק רקעים – שליטה בבורר רקעים חינמי
    backgroundActive: false,
    backgroundChoices: [],
    selectedBackgroundUrl: '',
    bgImage: null,
    bgTextOnly: false,
    bgZoomFx: false,
    fx: null,
  };

  App.composeState = state;

  function setStatus(message, type = 'info') {
    if (!elements.status) return;
    elements.status.textContent = message;
    elements.status.className = 'compose-dialog__status';
    if (type && type !== 'info') {
      elements.status.classList.add(`compose-dialog__status--${type}`);
    }
  }

  function updateComposeLegalState() {
    if (!elements.publishButton) return;
    const policyOk = elements.policyCheckbox ? elements.policyCheckbox.checked : true;
    const rightsOk = elements.rightsCheckbox ? elements.rightsCheckbox.checked : true;
    elements.publishButton.disabled = !(policyOk && rightsOk);
  }

  // פונקציות התקדמות גרפיות חדשות
  function setProgressWithMeter(percent, stage, icon = '🎬') {
    if (!elements.status) return;
    
    const progressHTML = `
      <div class="progress-with-icon">
        <div class="progress-icon">${icon}</div>
        <div class="progress-text">${getProgressMessage(stage, percent)}</div>
        <div class="progress-spinner"></div>
      </div>
      <div class="progress-meter">
        <div class="progress-meter-fill" style="width: ${percent}%"></div>
      </div>
    `;
    
    elements.status.innerHTML = progressHTML;
    elements.status.className = 'compose-dialog__status';
  }

  function setProgressWithIcon(message, icon = '📤', showSpinner = true) {
    if (!elements.status) return;
    
    const progressHTML = `
      <div class="progress-with-icon">
        <div class="progress-icon">${icon}</div>
        <div class="progress-text">${message}</div>
        ${showSpinner ? '<div class="progress-spinner"></div>' : ''}
      </div>
    `;
    
    elements.status.innerHTML = progressHTML;
    elements.status.className = 'compose-dialog__status';
  }

  function getProgressMessage(stage, percent) {
    const messages = {
      'compressing': `מעבד וידאו... ${percent}%`,
      'finalizing': 'משלים עיבוד...',
      'uploading': `מעלה וידאו... ${percent}%`,
      'analyzing': 'מנתח וידאו...',
      'optimizing': `מייעל... ${percent}%`
    };
    
    return messages[stage] || `מעבד... ${percent}%`;
  }

  function setBgTextOnly(value) {
    state.bgTextOnly = !!value;
    if (state.bgTextOnly) {
      setStatus('הטקסט יוצג רק על התמונה.', 'info');
    }
  }

  // חלק אפקטים (compose.js) – שליטה ידנית על הפעלת אפקט הזום בלופ | HYPER CORE TECH
  function setBgZoomFx(value) {
    const isEnabled = !!value;
    state.bgZoomFx = isEnabled;
    state.fx = isEnabled ? 'zoomin' : null;
  }

  function resetStatus() {
    setStatus('', 'info');
  }

  function clearMediaPreview() {
    state.media = null;
    elements.previewContainer.classList.remove('is-visible');
    elements.previewImage.style.display = 'none';
    elements.previewImage.src = '';
    elements.previewVideo.style.display = 'none';
    elements.previewVideo.removeAttribute('src');
    elements.previewVideo.load();
  }

  function showMediaPreview(media) {
    elements.previewContainer.classList.add('is-visible');
    elements.previewImage.style.display = 'none';
    elements.previewVideo.style.display = 'none';

    if (media.type === 'image') {
      elements.previewImage.src = media.dataUrl;
      elements.previewImage.style.display = 'block';
      elements.previewImage.alt = 'תצוגה מקדימה לתמונה';
      
      // זיהוי יחס רוחב-גובה והתאמת התצוגה
      const img = new Image();
      img.onload = function() {
        const aspectRatio = this.width / this.height;
        console.log('[COMPOSE] Image aspect ratio detected:', {
          width: this.width,
          height: this.height,
          aspectRatio: aspectRatio.toFixed(2),
          orientation: aspectRatio > 1.2 ? 'landscape' : aspectRatio < 0.8 ? 'portrait' : 'square'
        });
        
        // התאמת סגנון התצוגה לפי יחס הרוחב-גובה
        if (aspectRatio > 1.2) {
          // תמונה רוחבית - הצג ברוחב מלא
          elements.previewImage.style.objectFit = 'cover';
          elements.previewImage.style.maxWidth = '100%';
          elements.previewImage.style.maxHeight = '300px';
          elements.previewImage.style.width = '100%';
          elements.previewImage.className = 'landscape';
        } else if (aspectRatio < 0.8) {
          // תמונה אנכית - הגבלה ברוחב וגובה מקסימלי
          elements.previewImage.style.objectFit = 'contain';
          elements.previewImage.style.maxWidth = '100%';
          elements.previewImage.style.maxHeight = '400px';
          elements.previewImage.style.width = 'auto';
          elements.previewImage.className = 'portrait';
        } else {
          // תמונה ריבועית או קרובה - תצוגה מאוזנת
          elements.previewImage.style.objectFit = 'cover';
          elements.previewImage.style.maxWidth = '100%';
          elements.previewImage.style.maxHeight = '350px';
          elements.previewImage.style.width = '100%';
          elements.previewImage.className = 'square';
        }
      };
      img.src = media.dataUrl;
      
    } else if (media.type === 'video') {
      elements.previewVideo.src = media.dataUrl;
      elements.previewVideo.style.display = 'block';
      elements.previewVideo.load();
    }
  }

  async function resizeImage(file) {
    // זיהוי יחס רוחב-גובה לפני ה-resize
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
    
    const aspectRatio = img.width / img.height;
    console.log('[COMPOSE] Original image dimensions:', {
      width: img.width,
      height: img.height,
      aspectRatio: aspectRatio.toFixed(2),
      orientation: aspectRatio > 1.2 ? 'landscape' : aspectRatio < 0.8 ? 'portrait' : 'square'
    });
    
    // ניקוי ה-URL זמני
    URL.revokeObjectURL(img.src);
    
    if (typeof App.resizeImageToDataUrl === 'function') {
      // התאמת המימדים לפי יחס הרוחב-גובה
      let maxWidth, maxHeight;
      
      if (aspectRatio > 1.2) {
        // תמונה רוחבית - מקסימום רוחב 1080, גובה מתאים
        maxWidth = 1080;
        maxHeight = Math.floor(1080 / aspectRatio);
      } else if (aspectRatio < 0.8) {
        // תמונה אנכית - מקסימום גובה 1080, רוחב מתאים
        maxHeight = 1080;
        maxWidth = Math.floor(1080 * aspectRatio);
      } else {
        // תמונה ריבועית או קרובה - מימדים שווים
        maxWidth = maxHeight = 1080;
      }
      
      console.log('[COMPOSE] Resizing image to:', {
        maxWidth,
        maxHeight,
        aspectRatio: aspectRatio.toFixed(2)
      });
      
      return App.resizeImageToDataUrl(file, maxWidth, maxHeight, 0.85);
    }
    
    // Fallback אם הפונקציה לא זמינה
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleMediaInput(event) {
    const [file] = event.target.files || [];
    console.log('[COMPOSE] handleMediaInput called with:', {
      file: file ? {
        name: file.name,
        type: file.type,
        size: (file.size / 1024 / 1024).toFixed(2) + 'MB'
      } : null
    });
    
    if (!file) {
      clearMediaPreview();
      resetStatus();
      return;
    }

    try {
      resetStatus();
      // אם המשתמש בוחר מדיה ידנית – ביטול מצב רקע מהטקסט
      clearTextareaBg();
      
      // חלק וידאו (compose.js) – טיפול בקבצי וידאו עם דחיסה והעלאה
      if (file.type.startsWith('video/')) {
        console.log('[COMPOSE] Processing video file...');
        await handleVideoFile(file);
        event.target.value = '';
        return;
      }
      
      // טיפול בתמונות (קיים)
      let dataUrl;
      if (file.type.startsWith('image/')) {
        setProgressWithIcon('מעבד תמונה...', '🖼️');
        dataUrl = await resizeImage(file);
        setProgressWithIcon('התמונה מוכנה!', '✅');
      } else {
        setStatus('סוג הקובץ לא נתמך. בחר תמונה או וידאו.', 'error');
        event.target.value = '';
        return;
      }

      if (!dataUrl) {
        setStatus('נכשלה טעינת הקובץ. נסה שוב.', 'error');
        event.target.value = '';
        return;
      }

      if (App.MAX_INLINE_MEDIA_LENGTH && dataUrl.length > App.MAX_INLINE_MEDIA_LENGTH) {
        setStatus('המדיה גדולה מדי. נסה קובץ קטן יותר.', 'error');
        clearMediaPreview();
        event.target.value = '';
        return;
      }

      state.media = { type: 'image', dataUrl };
      showMediaPreview(state.media);
      setStatus('המדיה נוספה. לחיצה על התצוגה תסיר אותה.');
    } catch (err) {
      console.error('Media load failed', err);
      setStatus('שגיאה בטעינת המדיה. נסה קובץ אחר.', 'error');
      clearMediaPreview();
    } finally {
      event.target.value = '';
    }
  }

  // חלק וידאו (compose.js) – טיפול בקובץ וידאו: בדיקה, דחיסה, העלאה
  async function handleVideoFile(file) {
    console.log('[COMPOSE] handleVideoFile started:', {
      name: file.name,
      type: file.type,
      size: (file.size / 1024 / 1024).toFixed(2) + 'MB'
    });
    
    const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB
    
    // בדיקת גודל
    if (file.size > MAX_VIDEO_SIZE) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      setStatus(`הוידיאו גדול מדי (${sizeMB}MB). מקסימום 100MB.`, 'error');
      return;
    }

    // בדיקת תמיכה בדחיסה
    if (typeof App.compressVideo !== 'function') {
      console.error('[COMPOSE] App.compressVideo not available:', typeof App.compressVideo);
      setStatus('מנוע דחיסת הווידאו לא זמין. רענן את הדף.', 'error');
      return;
    }

    try {
      // דחיסה
      setProgressWithIcon('מכין וידאו לעיבוד...', '⚙️');
      console.log('[COMPOSE] Starting video compression...');
      const result = await App.compressVideo(file, (progress) => {
        if (progress.stage === 'compressing') {
          setProgressWithMeter(progress.percent, 'compressing', '🎬');
        } else if (progress.stage === 'finalizing') {
          setProgressWithIcon('משלים עיבוד...', '⚡');
        } else if (progress.stage === 'uploading') {
          setProgressWithMeter(progress.percent, 'uploading', '📤');
        }
      });

      console.log('[COMPOSE] Video compression completed:', {
        original: (file.size / (1024 * 1024)).toFixed(2) + 'MB',
        compressed: (result.size / (1024 * 1024)).toFixed(2) + 'MB',
        ratio: result.compressionRatio + '%',
        hash: result.hash ? result.hash.substring(0, 16) + '...' : 'none'
      });

      // הודעה ידידותית אם לא הייתה דחיסה
      if (result.compressionRatio === '0.0') {
        console.log('העלאת קובץ מקורי (טלפון)');
      }

      // ניסיון העלאה ל-Blossom עם פולבאק ל-data URL במקרה של כשל רשת
      let uploadedUrl = '';
      try {
        setProgressWithIcon('מתחבר לשרת...', '🌐');
        const uploadResult = await uploadVideoToBlossom(result.blob, result.hash);
        if (uploadResult && uploadResult.url) {
          uploadedUrl = uploadResult.url;
          setProgressWithIcon('מעלה וידאו לשרת...', '☁️');
        } else {
          throw new Error('העלאה נכשלה');
        }
      } catch (uploadErr) {
        console.warn('Blossom upload failed, falling back to inline data URL', uploadErr);
        setProgressWithIcon('שומר וידאו מקומית...', '💾');
        // פולבאק: שמירה כ-data:video ישירות בפוסט
        const dataUrl = await new Promise((resolve, reject) => {
          try {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(result.blob);
          } catch (e) { reject(e); }
        });
        uploadedUrl = '';
        const inlineUrl = String(dataUrl || '');
        state.media = {
          type: 'video',
          dataUrl: inlineUrl,
          url: inlineUrl,
          hash: result.hash,
          size: result.size,
          mimeType: result.type || 'video/webm'
        };
        showMediaPreview(state.media);
        setStatus(`הוידאו הוכן מקומית (${(result.size / (1024 * 1024)).toFixed(1)}MB).`);
        return; // יציאה – המדיה הוגדרה כ-data URL
      }

      // שמירת מידע במצב (מסלול העלאה מוצלח)
      state.media = {
        type: 'video',
        dataUrl: URL.createObjectURL(result.blob),
        url: uploadedUrl,
        hash: result.hash,
        size: result.size,
        mimeType: result.type || 'video/webm'
      };

      // רישום הקובץ במערכת P2P
      if (typeof App.registerFileAvailability === 'function' && result.hash && result.blob) {
        try {
          await App.registerFileAvailability(result.hash, result.blob, result.type || 'video/webm');
          console.log('[COMPOSE] וידאו נרשם ב-P2P:', result.hash);
        } catch (err) {
          console.warn('[COMPOSE] רישום P2P נכשל:', err);
        }
      }

      showMediaPreview(state.media);
      setStatus(`וידאו הועלה בהצלחה (${(result.size / (1024 * 1024)).toFixed(1)}MB)`);
    } catch (err) {
      console.error('Video processing failed', err);
      setStatus(err.message || 'שגיאה בעיבוד הוידאו', 'error');
      clearMediaPreview();
    }
  }

  // חלק וידאו (compose.js) – העלאה ל-Blossom/void.cat
  async function uploadVideoToBlossom(blob, hash) {
    try {
      // ניסיון העלאה דרך uploadToBlossom אם קיים
      if (typeof App.uploadToBlossom === 'function') {
        const url = await App.uploadToBlossom(blob);
        return { url, hash };
      }

      // Fallback: העלאה ישירה ל-void.cat
      const formData = new FormData();
      formData.append('file', blob, 'video.webm');

      const response = await fetch('https://void.cat/upload', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error('Upload failed: ' + response.statusText);
      }

      const data = await response.json();
      const url = data.file?.url || data.url;
      
      if (!url) {
        throw new Error('No URL in upload response');
      }

      return { url, hash };
    } catch (err) {
      console.error('Blossom upload failed', err);
      throw new Error('העלאת הוידאו נכשלה. בדוק חיבור לאינטרנט.');
    }
  }

  function removeMedia() {
    if (!state.media) return;
    clearMediaPreview();
    setStatus('המדיה הוסרה.');
  }

  function applyTextareaBg(url) {
    // חלק קומפוזר – מציג רקע בתוך תיבת הטקסט, מונע גלילה מיותרת
    if (!elements.textarea) return;
    elements.textarea.style.backgroundImage = url ? `url('${url}')` : '';
    elements.textarea.style.backgroundSize = 'cover';
    elements.textarea.style.backgroundPosition = 'center';
    elements.textarea.style.backgroundRepeat = 'no-repeat';
    elements.textarea.style.backgroundColor = 'transparent';
    elements.textarea.style.color = '#fff';
    elements.textarea.style.textShadow = '0 1px 2px rgba(0,0,0,0.7)';
    elements.textarea.style.caretColor = '#fff';
    elements.textarea.style.padding = '20px';
  }

  function clearTextareaBg() {
    if (!elements.textarea) return;
    elements.textarea.style.backgroundImage = '';
    elements.textarea.style.backgroundSize = '';
    elements.textarea.style.backgroundPosition = '';
    elements.textarea.style.backgroundRepeat = '';
    elements.textarea.style.backgroundColor = '';
    elements.textarea.style.color = '';
    elements.textarea.style.textShadow = '';
    elements.textarea.style.caretColor = '';
    elements.textarea.style.padding = '';
  }

  async function fetchBackgroundsFromPicsum() {
    // חלק רקעים – מביא עד 12 רקעים רנדומליים מ-Picsum ללא צורך במפתח
    try {
      const page = Math.max(1, Math.floor(Math.random() * 50));
      const res = await fetch(`https://picsum.photos/v2/list?page=${page}&limit=12`);
      const arr = await res.json();
      return Array.isArray(arr)
        ? arr.map((x) => (x && x.id ? `https://picsum.photos/id/${x.id}/1080/1080` : null)).filter(Boolean)
        : [];
    } catch (e) {
      console.warn('Picsum fetch failed', e);
      return [];
    }
  }

  function renderBackgroundGallery(urls) {
    if (!elements.bgGallery) return;
    if (!Array.isArray(urls) || urls.length === 0) {
      elements.bgGallery.innerHTML = '';
      elements.bgGallery.setAttribute('hidden', '');
      return;
    }
    const items = urls.slice(0, 12).map((u) => `<button type="button" class="compose-bg__item" data-bg="${u}" style="background-image:url('${u}')"></button>`);
    elements.bgGallery.innerHTML = items.join('');
    elements.bgGallery.removeAttribute('hidden');
    Array.from(elements.bgGallery.querySelectorAll('button.compose-bg__item')).forEach((btn) => {
      btn.addEventListener('click', () => {
        const url = btn.getAttribute('data-bg');
        if (url) selectBackground(url);
      });
    });
  }

  function setBackgroundActive(active) {
    state.backgroundActive = !!active;
    if (!state.backgroundActive) {
      state.selectedBackgroundUrl = '';
      state.bgImage = null;
      state.bgTextOnly = false;
      setBgZoomFx(false);
      if (elements.bgTextOnlyToggle) {
        elements.bgTextOnlyToggle.checked = false;
      }
      if (elements.bgZoomToggle) {
        elements.bgZoomToggle.checked = false;
      }
      if (elements.bgGallery) elements.bgGallery.setAttribute('hidden', '');
      if (elements.bgOptions) elements.bgOptions.setAttribute('hidden', '');
      return;
    }
    // טוען גלריה טרייה בכל הפעלה
    fetchBackgroundsFromPicsum().then((urls) => {
      state.backgroundChoices = urls;
      renderBackgroundGallery(urls);
    });
    if (elements.bgOptions) {
      elements.bgOptions.removeAttribute('hidden');
    }
  }

  function selectBackground(url) {
    state.selectedBackgroundUrl = url;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      state.bgImage = img;
      regenerateBackgroundMedia();
    };
    img.onerror = () => {
      setStatus('טעינת הרקע נכשלה. נסה רקע אחר.', 'error');
    };
    img.src = url;
  }

  function wrapText(ctx, text, maxWidth, lineHeight) {
    const words = (text || '').split(/\s+/);
    const lines = [];
    let line = '';
    for (let n = 0; n < words.length; n += 1) {
      const testLine = line ? `${line} ${words[n]}` : words[n];
      const { width } = ctx.measureText(testLine);
      if (width > maxWidth && line) {
        lines.push(line);
        line = words[n];
      } else {
        line = testLine;
      }
    }
    if (line) lines.push(line);
    return lines.slice(0, 10); // הגבלה סבירה
  }

  function exportCanvasUnderLimitLocal(canvas) {
    const limit = (window.App && (App.MAX_INLINE_MEDIA_LENGTH || App.MAX_INLINE_PICTURE_LENGTH)) || 250000;
    const qualities = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25, 0.2, 0.15];
    const sizes = [1080, 960, 840, 720, 640, 600, 512, 448, 384, 320];
    for (let s = 0; s < sizes.length; s += 1) {
      const target = sizes[s];
      if (canvas.width !== target || canvas.height !== target) {
        const tmp = document.createElement('canvas');
        tmp.width = target; tmp.height = target;
        const tctx = tmp.getContext('2d');
        tctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, target, target);
        canvas = tmp;
      }
      for (let q = 0; q < qualities.length; q += 1) {
        const url = canvas.toDataURL('image/jpeg', qualities[q]);
        if (!limit || url.length <= limit) return url;
      }
    }
    return canvas.toDataURL('image/jpeg', 0.12);
  }

  function regenerateBackgroundMedia() {
    if (!state.backgroundActive || state.media || !state.bgImage || !elements.textarea) return;
    const text = elements.textarea.value.trim();
    if (!text) return;
    const size = 1080;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    // צייר רקע מכסה
    const img = state.bgImage;
    const ratio = Math.max(size / img.width, size / img.height);
    const w = img.width * ratio;
    const h = img.height * ratio;
    const dx = (size - w) / 2;
    const dy = (size - h) / 2;
    ctx.drawImage(img, dx, dy, w, h);
    // שכבת כהות קלה לשיפור ניגודיות
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, 0, size, size);
    // טקסט
    const padding = 80;
    const maxWidth = size - padding * 2;
    let fontSize = 64;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 4;
    // התאמת גודל פונט גסה
    ctx.font = `${fontSize}px sans-serif`;
    let lines = wrapText(ctx, text, maxWidth, fontSize * 1.3);
    while (lines.length > 6 && fontSize > 28) {
      fontSize -= 4;
      ctx.font = `${fontSize}px sans-serif`;
      lines = wrapText(ctx, text, maxWidth, fontSize * 1.3);
    }
    const lineHeight = fontSize * 1.3;
    const totalH = lines.length * lineHeight;
    let y = size / 2 - totalH / 2 + lineHeight / 2;
    lines.forEach((ln) => {
      ctx.strokeText(ln, size / 2, y);
      ctx.fillText(ln, size / 2, y);
      y += lineHeight;
    });
    const dataUrl = exportCanvasUnderLimitLocal(canvas);
    state.media = { type: 'image', dataUrl };
    showMediaPreview(state.media);
  }

  function syncProfileDetails() {
    if (!App.profile) return;
    if (elements.profileName) {
      elements.profileName.textContent = App.profile.name;
    }
    if (elements.profileBio) {
      elements.profileBio.textContent = App.profile.bio;
    }
    if (elements.profileAvatar) {
      elements.profileAvatar.innerHTML = '';
      if (App.profile.picture) {
        const img = document.createElement('img');
        img.src = App.profile.picture;
        img.alt = App.profile.name;
        elements.profileAvatar.appendChild(img);
      } else {
        elements.profileAvatar.textContent = App.profile.avatarInitials || 'AN';
      }
    }
  }

  function ensureMediaInputBound() {
    // חלק קומפוזר – מבטיח שמאזין change מחובר לקלט המדיה גם לאחר שינוי מיקום ב-DOM
    const input = document.getElementById('composeMediaInput');
    if (!input) return;
    elements.mediaInput = input;
    if (state.mediaInputBound) return;
    input.addEventListener('change', (event) => {
      handleMediaInput(event).catch((err) => {
        console.error('Media handler error', err);
        setStatus('שגיאה בטעינת הקובץ.', 'error');
      });
    });
    state.mediaInputBound = true;
  }

  function openCompose() {
    const app = window.NostrApp || {};
    // בדיקת מצב אורח - חסימת פרסום פוסט למשתמשים לא מחוברים | HYPER CORE TECH
    if (app && typeof app.requireAuth === 'function') {
      if (!app.requireAuth('כדי לפרסם פוסט צריך להתחבר או להירשם.')) {
        return;
      }
    }
    
    syncProfileDetails();
    resetStatus();
    ensureMediaInputBound();
    if (elements.policyCheckbox) {
      elements.policyCheckbox.checked = false;
    }
    if (elements.rightsCheckbox) {
      elements.rightsCheckbox.checked = false;
    }
    updateComposeLegalState();
    // חלק קומפוזר – ביטול מצבי תצוגה קודמים והבטחת הצגה עקבית
    elements.modal.style.display = 'flex';
    elements.modal.classList.add('is-visible');
    elements.modal.setAttribute('aria-hidden', 'false');
    
    // לא מפעילים focus אוטומטי במובייל כדי למנוע פתיחת מקלדת
    // המשתמש יצטרך ללחוץ על ה-textarea במפורש
    if (elements.textarea && !isMobile()) {
      elements.textarea.focus();
    }
    
    // התאמת המודאל למקלדת במובייל
    setupMobileKeyboardHandling();
    
    // חלק רקעים – חיבור מאוחר למודול הרקעים בעת פתיחה אם טרם בוצע
    if (window.NostrApp?.bg && !window.NostrApp._bgBound) {
      window.NostrApp.bg.bind({
        elements,
        state,
        setStatus,
        showMediaPreview,
        getText: () => (elements.textarea ? elements.textarea.value : ''),
        applyTextareaBg,
        clearTextareaBg,
      });
      window.NostrApp._bgBound = true;
    }
    // ניהול מצב פתיחה
    if (window.NostrApp?.bg && typeof window.NostrApp.bg.onOpenCompose === 'function') {
      window.NostrApp.bg.onOpenCompose();
    } else {
      setBackgroundActive(false);
    }
  }

  function closeCompose() {
    // חלק קומפוזר – סגירה כפולה (class + style) כדי למנוע פתיחה מחדש בעקבות מצב ביניים
    elements.modal.classList.remove('is-visible');
    elements.modal.setAttribute('aria-hidden', 'true');
    elements.modal.style.display = 'none';
  }

  function resetCompose() {
    if (elements.textarea) {
      elements.textarea.value = '';
    }
    if (elements.mediaInput) {
      elements.mediaInput.value = '';
    }
    clearMediaPreview();
    resetStatus();
    // חלק קומפוזר – איפוס מצב עריכה
    state.editingOriginalId = null;
    // חלק רקעים – איפוס סטייט
    if (window.NostrApp?.bg && typeof window.NostrApp.bg.onReset === 'function') {
      window.NostrApp.bg.onReset();
    } else {
      setBackgroundActive(false);
    }
    clearTextareaBg();
    setBgZoomFx(false);
    if (elements.bgZoomToggle) {
      elements.bgZoomToggle.checked = false;
    }
    if (elements.policyCheckbox) {
      elements.policyCheckbox.checked = false;
    }
    if (elements.rightsCheckbox) {
      elements.rightsCheckbox.checked = false;
    }
    updateComposeLegalState();
  }

  // פונקציית זיהוי מובייל
  function isMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
           (window.innerWidth <= 768 && 'ontouchstart' in window);
  }

  // התאמת המודאל למקלדת במובייל
  function setupMobileKeyboardHandling() {
    if (!isMobile()) return;
    
    const modal = elements.modal;
    const textarea = elements.textarea;
    
    if (!modal || !textarea) return;
    
    // הגדרת התנהגות מובייל למודאל
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.right = '0';
    modal.style.bottom = '0';
    modal.style.margin = '0';
    modal.style.maxHeight = '100vh';
    modal.style.overflowY = 'auto';
    
    // האזנה לאירועי focus/blur של ה-textarea
    let originalModalBottom = '0';
    
    textarea.addEventListener('focus', () => {
      // כשהמקלדת נפתחת, מרימים את המודאל
      setTimeout(() => {
        const viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        const modalHeight = modal.offsetHeight;
        
        if (modalHeight > viewportHeight * 0.8) {
          modal.style.transform = 'translateY(-10vh)';
          modal.style.transition = 'transform 0.3s ease';
        }
      }, 300);
    });
    
    textarea.addEventListener('blur', () => {
      // מחזירים את המודאל למקומו כשהמקלדת נסגרת
      setTimeout(() => {
        modal.style.transform = 'translateY(0)';
      }, 100);
    });
    
    // האזנה לשינויים ב-viewport (למקרה של סיבוב מסך)
    if (window.visualViewport) {
      const handleViewportChange = () => {
        const viewportHeight = window.visualViewport.height;
        const modalHeight = modal.offsetHeight;
        
        if (viewportHeight < modalHeight * 0.7) {
          modal.style.transform = `translateY(${window.visualViewport.offsetTop - 20}px) scale(0.95)`;
        } else {
          modal.style.transform = 'translateY(0) scale(1)';
        }
      };
      
      window.visualViewport.addEventListener('resize', handleViewportChange);
      window.visualViewport.addEventListener('scroll', handleViewportChange);
    }
  }

  function getComposePayload() {
    if (elements.policyCheckbox && !elements.policyCheckbox.checked) {
      setStatus('יש לאשר את תנאי התוכן לפני הפרסום.', 'error');
      return null;
    }
    if (elements.rightsCheckbox && !elements.rightsCheckbox.checked) {
      setStatus('יש לאשר שהזכויות לתוכן הן שלך.', 'error');
      return null;
    }
    const text = elements.textarea ? elements.textarea.value.trim() : '';
    const includeTextContent = !(state.backgroundActive && state.bgTextOnly);
    const textContent = includeTextContent ? text : '';

    if (!textContent && !state.media) {
      setStatus('כתוב טקסט או הוסף מדיה לפני הפרסום.', 'error');
      return null;
    }

    const parts = [];
    if (textContent) {
      parts.push(textContent);
    }
    
    // חלק וידאו (compose.js) – אם יש וידאו מועלה, נשתמש ב-URL במקום dataUrl
    if (state.media) {
      if (state.media.type === 'video' && state.media.url) {
        parts.push(state.media.url);
      } else if (state.media.dataUrl) {
        parts.push(state.media.dataUrl);
      }
    }

    const content = parts.join('\n');
    const textLimit = typeof App.MAX_TEXT_CONTENT_LENGTH === 'number' ? App.MAX_TEXT_CONTENT_LENGTH : 8000;
    if (textContent && textContent.length > textLimit) {
      setStatus('הטקסט ארוך מדי. קיצור קטן אמור לפתור.', 'error');
      return null;
    }

    // חלק וידאו (compose.js) – הוספת תגיות Nostr למדיה
    const mediaTags = [];
    if (state.media && state.media.type === 'video') {
      const mediaSource = state.media.url || state.media.dataUrl || '';
      if (mediaSource) {
        mediaTags.push(['media', state.media.mimeType || 'video/webm', mediaSource, state.media.hash || '']);
      }
    }

    return {
      content,
      text: textContent,
      media: state.media,
      mediaTags,
      // חלק קומפוזר – החזרת מזהה הפוסט המקורי (אם בעריכה)
      originalId: state.editingOriginalId || null,
    };
  }

  function initListeners() {
    ensureMediaInputBound();

    if (elements.previewContainer) {
      elements.previewContainer.addEventListener('click', removeMedia);
    }

    // חיבור מודול הרקעים המרכזי (אם נטען), מונע מאזינים כפולים
    if (window.NostrApp?.bg && !window.NostrApp._bgBound) {
      window.NostrApp.bg.bind({
        elements,
        state,
        setStatus,
        showMediaPreview,
        getText: () => (elements.textarea ? elements.textarea.value : ''),
        applyTextareaBg,
        clearTextareaBg,
      });
      window.NostrApp._bgBound = true;
    } else if (elements.bgToggle && !window.NostrApp?.bg) {
      // fallback: רק אם המודול לא קיים – מאזין בסיסי לכפתור
      elements.bgToggle.addEventListener('click', async () => {
        if (state.media) {
          setStatus('כדי להשתמש ברקע, הסר תחילה מדיה שהוספת.', 'info');
          return;
        }
        const next = !state.backgroundActive;
        setBackgroundActive(next);
        if (next && elements.textarea) {
          elements.textarea.dispatchEvent(new Event('input'));
        }
      });
    }

    if (elements.textarea) {
      elements.textarea.addEventListener('input', () => {
        if (!window.NostrApp?.bg) {
          if (!state.media && state.backgroundActive && state.bgImage) {
            regenerateBackgroundMedia();
          }
        }
      });
    }

    if (elements.bgClear) {
      elements.bgClear.addEventListener('click', () => {
        // הסרת רקע טקסט: ניקוי state.media אם מקורו רקע, ניקוי רקע מהטקסט, והצגת הגלריה מחדש אם מצב רקע פעיל
        clearTextareaBg();
        if (state.media && state.media.type === 'image') {
          // מאפשר להסיר רק את הרקע; לא נוגעים במדיה ידנית אחרת
          state.media = null;
        }
        if (elements.previewContainer) {
          elements.previewContainer.classList.remove('is-visible');
          elements.previewContainer.setAttribute('hidden', '');
        }
        if (window.NostrApp?.bg) {
          // הצג מחדש את הגלריה לבחירה חדשה
          window.NostrApp.bg.setActive(true);
        } else if (elements.bgGallery) {
          elements.bgGallery.removeAttribute('hidden');
        }
        if (elements.bgOptions) {
          elements.bgOptions.setAttribute('hidden', '');
        }
        if (elements.bgTextOnlyToggle) {
          elements.bgTextOnlyToggle.checked = false;
        }
        state.bgTextOnly = false;
        setStatus('הרקע הוסר.');
      });
    }

    if (elements.bgTextOnlyToggle) {
      elements.bgTextOnlyToggle.addEventListener('change', (event) => {
        setBgTextOnly(Boolean(event.target.checked));
      });
    }

    if (elements.bgZoomToggle) {
      elements.bgZoomToggle.addEventListener('change', (event) => {
        const enabled = Boolean(event.target.checked);
        if (!state.backgroundActive && enabled) {
          setStatus('הפעל אפקט זום מחייב רקע פעיל.', 'info');
          event.target.checked = false;
          return;
        }
        setBgZoomFx(enabled);
      });
    }

    if (elements.policyCheckbox) {
      elements.policyCheckbox.addEventListener('change', () => {
        updateComposeLegalState();
      });
    }
    if (elements.rightsCheckbox) {
      elements.rightsCheckbox.addEventListener('change', () => {
        updateComposeLegalState();
      });
    }

    // חלק שידור חי (compose.js) – כפתור שידור חי מתוך חלון השיתוף
    try {
      const liveBtn = document.getElementById('composeLiveButton');
      if (liveBtn) {
        // מחליפים מאזין כדי למנוע כפילות אם ה-DOM נטען מחדש
        const fresh = liveBtn.cloneNode(true);
        liveBtn.parentNode.replaceChild(fresh, liveBtn);
        fresh.addEventListener('click', () => {
          try { if (typeof App.closeCompose === 'function') App.closeCompose(); } catch (_) {}
          try { if (typeof App.openLiveBroadcast === 'function') App.openLiveBroadcast({ slug: 'live' }); } catch (_) {}
        });
      }
    } catch (_) {}
  }

  function setComposeDraft(text, mediaDataUrl, originalId = null) {
    // חלק קומפוזר – טוען טיוטה מוכנה (לעריכה או לשחזור), כולל מדיה
    try {
      if (elements.textarea) {
        elements.textarea.value = text || '';
      }
      if (mediaDataUrl) {
        if (typeof mediaDataUrl === 'string' && mediaDataUrl.startsWith('data:video/')) {
          state.media = { type: 'video', dataUrl: mediaDataUrl };
        } else if (typeof mediaDataUrl === 'string' && mediaDataUrl.startsWith('data:image/')) {
          state.media = { type: 'image', dataUrl: mediaDataUrl };
        }
        if (state.media) {
          showMediaPreview(state.media);
        } else {
          clearMediaPreview();
        }
      } else {
        clearMediaPreview();
      }
      state.editingOriginalId = originalId || null;
      openCompose();
    } catch (err) {
      console.warn('Failed setting compose draft', err);
    }
  }

  function clearEditing() {
    // חלק קומפוזר – ניקוי מצב העריכה בלבד (ללא מחיקת תוכן הטיוטה)
    state.editingOriginalId = null;
  }

  // חלק קומפוזר (compose.js) – פרסום פוסט: בניית payload, חתימה ופרסום ל-relays | HYPER CORE TECH
  async function publishPostImpl() {
    try {
      resetStatus();
      const payload = getComposePayload();
      if (!payload) return;

      const app = window.NostrApp || {};
      if (!app.pool || !Array.isArray(app.relayUrls) || app.relayUrls.length === 0) {
        setStatus('אין חיבור לריליים. נסה שוב לאחר ההתחברות.', 'error');
        return;
      }
      if (!app.privateKey || !app.publicKey || typeof app.finalizeEvent !== 'function') {
        setStatus('חסר מפתח או חתימה. היכנס/י לחשבון ונסה שוב.', 'error');
        return;
      }

      // בניית אירוע Kind 1
      const tags = [];
      if (Array.isArray(payload.mediaTags) && payload.mediaTags.length) {
        payload.mediaTags.forEach((t) => { if (Array.isArray(t)) tags.push(t); });
      }
      if (app.NETWORK_TAG) {
        tags.push(['t', app.NETWORK_TAG]);
      }

      const event = {
        kind: 1,
        pubkey: app.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: String(payload.content || '').trim(),
      };

      setStatus('מפרסם...');
      const signed = app.finalizeEvent(event, app.privateKey);
      await app.pool.publish(app.relayUrls, signed);

      // עדכון UI
      setStatus('פורסם בהצלחה');
      try { if (typeof app.onPostPublished === 'function') app.onPostPublished(signed); } catch (_) {}
      resetCompose();
      closeCompose();
    } catch (err) {
      console.error('Failed to publish post', err);
      setStatus('שגיאה בפרסום. נסה שוב.', 'error');
    }
  }

  initListeners();

  Object.assign(App, {
    setComposeStatus: setStatus,
    resetCompose,
    openCompose,
    closeCompose,
    getComposePayload,
    clearComposeMedia: removeMedia,
    // חלק קומפוזר – API לזרימת עריכה
    setComposeDraft,
    clearEditing,
    // חלק קומפוזר – פרסום פוסט גלובלי כדי לתמוך ב-videos.html גם ללא app.js
    publishPost: publishPostImpl,
  });

  // פונקציות נפרדות לתמונה ווידיאו
  function handleImageInput(event) {
    console.log('[COMPOSE] handleImageInput called');
    handleMediaInput(event);
  }

  function handleVideoInput(event) {
    console.log('[COMPOSE] handleVideoInput called');
    handleMediaInput(event);
  }

  // חשיפת פונקציות גלובליות עבור מודולים אחרים
  window.publishPost = publishPostImpl;
  window.handleMediaInput = handleMediaInput;
  window.handleImageInput = handleImageInput;
  window.handleVideoInput = handleVideoInput;
  window.openCompose = openCompose;
  window.closeCompose = closeCompose;
})(window);
