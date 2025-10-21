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
  };

  const state = {
    media: null,
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

  function openCompose() {
    syncProfileDetails();
    resetStatus();
    elements.modal.classList.add('is-visible');
    elements.modal.setAttribute('aria-hidden', 'false');
    if (elements.textarea) {
      elements.textarea.focus();
    }
  }

  function closeCompose() {
    elements.modal.classList.remove('is-visible');
    elements.modal.setAttribute('aria-hidden', 'true');
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
    if (App.MAX_METADATA_CONTENT_LENGTH && content.length > App.MAX_METADATA_CONTENT_LENGTH) {
      setStatus('התוכן ארוך מדי. קיצור קטן אמור לפתור.', 'error');
      return null;
    }

    return {
      content,
      text,
      media: state.media,
    };
  }

  function initListeners() {
    if (elements.mediaInput) {
      elements.mediaInput.addEventListener('change', (event) => {
        handleMediaInput(event).catch((err) => {
          console.error('Media handler error', err);
          setStatus('שגיאה בטעינת הקובץ.', 'error');
        });
      });
    }

    if (elements.previewContainer) {
      elements.previewContainer.addEventListener('click', removeMedia);
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
  });
})(window);
