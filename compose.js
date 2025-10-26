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
  };

  App.composeState = state;

  function setStatus(message = '', tone = 'info') {
    if (!elements.status) return;
    elements.status.textContent = message;
    if (tone === 'error') {
      elements.status.style.color = '#f02849';
    } else {
      elements.status.style.color = '';
    }
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
    } else if (media.type === 'video') {
      elements.previewVideo.src = media.dataUrl;
      elements.previewVideo.style.display = 'block';
      elements.previewVideo.load();
    }
  }

  async function resizeImage(file) {
    if (typeof App.resizeImageToDataUrl === 'function') {
      return App.resizeImageToDataUrl(file, 1080, 1080, 0.85);
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleMediaInput(event) {
    const [file] = event.target.files || [];
    if (!file) {
      clearMediaPreview();
      resetStatus();
      return;
    }

    try {
      resetStatus();
      // אם המשתמש בוחר מדיה ידנית – ביטול מצב רקע מהטקסט
      clearTextareaBg();
      let dataUrl;
      if (file.type.startsWith('image/')) {
        dataUrl = await resizeImage(file);
      } else if (file.type.startsWith('video/')) {
        dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
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

      if (file.type.startsWith('video/')) {
        state.media = { type: 'video', dataUrl };
      } else {
        state.media = { type: 'image', dataUrl };
      }

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
      if (elements.bgGallery) elements.bgGallery.setAttribute('hidden', '');
      return;
    }
    // טוען גלריה טרייה בכל הפעלה
    fetchBackgroundsFromPicsum().then((urls) => {
      state.backgroundChoices = urls;
      renderBackgroundGallery(urls);
    });
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
    syncProfileDetails();
    resetStatus();
    ensureMediaInputBound();
    // חלק קומפוזר – ביטול מצבי תצוגה קודמים והבטחת הצגה עקבית
    elements.modal.style.display = 'flex';
    elements.modal.classList.add('is-visible');
    elements.modal.setAttribute('aria-hidden', 'false');
    if (elements.textarea) {
      elements.textarea.focus();
    }
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
  }

  function getComposePayload() {
    const text = elements.textarea ? elements.textarea.value.trim() : '';
    if (!text && !state.media) {
      setStatus('כתוב טקסט או הוסף מדיה לפני הפרסום.', 'error');
      return null;
    }

    const parts = [];
    if (text) {
      parts.push(text);
    }
    if (state.media?.dataUrl) {
      parts.push(state.media.dataUrl);
    }

    const content = parts.join('\n');
    const textLimit = typeof App.MAX_TEXT_CONTENT_LENGTH === 'number' ? App.MAX_TEXT_CONTENT_LENGTH : 8000;
    if (text && text.length > textLimit) {
      setStatus('הטקסט ארוך מדי. קיצור קטן אמור לפתור.', 'error');
      return null;
    }

    return {
      content,
      text,
      media: state.media,
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
        setStatus('הרקע הוסר.');
      });
    }
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
  });
})(window);
