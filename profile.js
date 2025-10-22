(function initProfile(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק אתחול נתוני פרופיל (profile.js) – מבטיח שמבנה הפרופיל כולל גלריה וקורא מהמטמון המקומי
  if (!App.profile || typeof App.profile !== 'object') {
    App.profile = {
      name: 'משתמש אנונימי',
      bio: 'יצירת תוכן מבוזר, בלי שוטר באמצע',
      avatarInitials: 'AN',
      picture: '',
      cover: '', // חלק תמונת נושא (profile.js) – נתיב/נתון לתמונת cover עבור באנר הכיסוי
      coverVideo: '', // חלק וידאו נושא (profile.js) – קישור MP4/WEBM או YouTube לרקע הבאנר
      gallery: [],
      dating: {
        optIn: false,
        bio: '',
        age: '',
        location: '',
        interests: [],
      },
    };
    try {
      const storedProfile = window.localStorage.getItem('nostr_profile');
      if (storedProfile) {
        const parsedProfile = JSON.parse(storedProfile);
        App.profile = Object.assign(
          {
            gallery: [],
            dating: { optIn: false, bio: '', age: '', location: '', interests: [] },
          },
          parsedProfile,
        );
      }
    } catch (err) {
      console.warn('Profile init: failed restoring cached profile', err);
    }
  }
  if (!Array.isArray(App.profile.gallery)) {
    App.profile.gallery = [];
  }
  if (!App.profile.dating || typeof App.profile.dating !== 'object') {
    App.profile.dating = { optIn: false, bio: '', age: '', location: '', interests: [] };
  } else {
    App.profile.dating = Object.assign({ optIn: false, bio: '', age: '', location: '', interests: [] }, App.profile.dating);
    if (!Array.isArray(App.profile.dating.interests)) {
      App.profile.dating.interests = [];
    }
  }

  let datingFormOpen = false;

  function applyDatingSettingsToUI() {
    const optInCheckbox = document.getElementById('profileDatingOptIn');
    const fieldsWrapper = document.getElementById('profileDatingFields');
    const bioInput = document.getElementById('profileDatingBio');
    const ageInput = document.getElementById('profileDatingAge');
    const locationInput = document.getElementById('profileDatingLocation');
    const interestsInput = document.getElementById('profileDatingInterests');
    const editButton = document.getElementById('profileDatingEditButton');
    if (!optInCheckbox || !fieldsWrapper) {
      return;
    }
    const dating = App.profile.dating || { optIn: false, bio: '', age: '', location: '', interests: [] };
    optInCheckbox.checked = Boolean(dating.optIn);
    if (bioInput) {
      bioInput.value = dating.bio || '';
    }
    if (ageInput) {
      ageInput.value = dating.age || '';
    }
    if (locationInput) {
      locationInput.value = dating.location || '';
    }
    if (interestsInput) {
      interestsInput.value = Array.isArray(dating.interests) ? dating.interests.join(', ') : '';
    }
    if (!dating.optIn) {
      datingFormOpen = false;
      fieldsWrapper.setAttribute('hidden', '');
      if (editButton) {
        editButton.hidden = true;
      }
      return;
    }
    if (datingFormOpen) {
      fieldsWrapper.removeAttribute('hidden');
    } else {
      fieldsWrapper.setAttribute('hidden', '');
    }
    if (editButton) {
      editButton.hidden = datingFormOpen;
    }
  }

  function bindDatingSettings() {
    const optInCheckbox = document.getElementById('profileDatingOptIn');
    const fieldsWrapper = document.getElementById('profileDatingFields');
    const saveButton = document.getElementById('profileDatingSaveButton');
    const status = document.getElementById('profileDatingStatus');
    const bioInput = document.getElementById('profileDatingBio');
    const ageInput = document.getElementById('profileDatingAge');
    const locationInput = document.getElementById('profileDatingLocation');
    const interestsInput = document.getElementById('profileDatingInterests');
    const editButton = document.getElementById('profileDatingEditButton');
    const closeButton = document.getElementById('profileDatingCloseButton');
    if (!optInCheckbox || !fieldsWrapper) {
      return;
    }

    optInCheckbox.addEventListener('change', () => {
      const isChecked = optInCheckbox.checked;
      App.profile.dating.optIn = isChecked;
      if (isChecked) {
        datingFormOpen = true;
        fieldsWrapper.removeAttribute('hidden');
        if (editButton) {
          editButton.hidden = true;
        }
      } else {
        datingFormOpen = false;
        fieldsWrapper.setAttribute('hidden', '');
        if (editButton) {
          editButton.hidden = true;
        }
      }
      persistDatingSettings(status, bioInput, ageInput, locationInput, interestsInput, false);
    });

    if (saveButton) {
      saveButton.addEventListener('click', () => {
        persistDatingSettings(status, bioInput, ageInput, locationInput, interestsInput, true);
      });
    }

    if (editButton) {
      editButton.addEventListener('click', () => {
        datingFormOpen = true;
        fieldsWrapper.removeAttribute('hidden');
        editButton.hidden = true;
      });
    }

    if (closeButton) {
      closeButton.addEventListener('click', () => {
        datingFormOpen = false;
        fieldsWrapper.setAttribute('hidden', '');
        if (editButton) {
          editButton.hidden = false;
        }
        if (status) {
          status.textContent = '';
        }
      });
    }
  }

  function persistDatingSettings(statusEl, bioInput, ageInput, locationInput, interestsInput, showMessage) {
    const dating = App.profile.dating || { optIn: false, bio: '', age: '', location: '', interests: [] };
    dating.bio = bioInput?.value?.trim() || '';
    dating.age = ageInput?.value?.trim() || '';
    dating.location = locationInput?.value?.trim() || '';
    const interestsValue = interestsInput?.value?.trim() || '';
    dating.interests = interestsValue
      ? interestsValue
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
    App.profile.dating = dating;

    try {
      window.localStorage.setItem('nostr_profile', JSON.stringify(App.profile));
    } catch (err) {
      console.error('Failed to persist dating settings locally', err);
    }

    if (App.profileCache instanceof Map) {
      App.profileCache.set(App.publicKey || 'self', {
        name: App.profile.name,
        bio: App.profile.bio,
        picture: App.profile.picture,
        initials: App.profile.avatarInitials,
        gallery: Array.isArray(App.profile.gallery) ? [...App.profile.gallery] : [],
        dating: {
          optIn: Boolean(App.profile.dating.optIn),
          bio: App.profile.dating.bio || '',
          age: App.profile.dating.age || '',
          location: App.profile.dating.location || '',
          interests: Array.isArray(App.profile.dating.interests) ? [...App.profile.dating.interests] : [],
        },
      });
    }

    publishProfileMetadata();
    applyDatingSettingsToUI();

    if (statusEl && showMessage) {
      statusEl.textContent = 'ההגדרות נשמרו והפרופיל עודכן באירוע הכרויות.';
      window.setTimeout(() => {
        if (statusEl.textContent.includes('ההגדרות')) {
          statusEl.textContent = '';
        }
      }, 4000);
    }
  }

  applyDatingSettingsToUI();
  bindDatingSettings();

  // חלק ניהול גלריה (profile.js) – מחזיק רפרנסים לאזור הדרופ וזיכרון מצב
  const galleryManagerRefs = {
    dropZone: null,
    fileInput: null,
    addButton: null,
    status: null,
  };
  let galleryManagerInitialized = false;

  // חלק מודל גלריה (profile.js) – רפרנסים לתצוגה מוגדלת
  const galleryModalRefs = {
    modal: null,
    image: null,
    close: null,
  };
  let galleryModalInitialized = false;

  function renderProfile() {
    // חלק פרופיל (profile.js) – מעדכן את פרטי הפרופיל בפיד הראשי
    setupGalleryManager();
    setupGalleryModal();
    if (!Array.isArray(App.profile.gallery)) {
      App.profile.gallery = [];
    }
    App.profile.avatarInitials = App.getInitials(App.profile.name || '');

    // חלק תמונת נושא (profile.js) – רינדור באנר הכיסוי על בסיס App.profile.cover
    const coverBanner = document.getElementById('profilePageCoverBanner');
    if (coverBanner) {
      if (App.profile.cover) {
        coverBanner.style.backgroundImage = `url("${App.profile.cover}")`;
      } else {
        coverBanner.style.backgroundImage = '';
      }
    }

    // חלק וידאו נושא (profile.js) – הצגת וידאו/YouTube בבאנר במידת הצורך עם פולבאק לתמונה
    const coverVideoEl = document.getElementById('profilePageCoverVideo');
    const coverYouTubeEl = document.getElementById('profilePageCoverYouTube');
    const videoUrl = (App.profile.coverVideo || '').trim();
    const ytIdMatch = videoUrl.match(/(?:https?:\/\/)?(?:www\.|m\.)?youtu(?:\.be|be\.com)\/(?:watch\?v=|embed\/|v\/)?([\w-]{11})/);
    if (coverVideoEl) {
      coverVideoEl.removeAttribute('src');
      coverVideoEl.style.display = 'none';
    }
    if (coverYouTubeEl) {
      coverYouTubeEl.removeAttribute('src');
      coverYouTubeEl.style.display = 'none';
    }
    if (videoUrl) {
      if (ytIdMatch) {
        const id = ytIdMatch[1];
        const params = 'autoplay=1&mute=1&playsinline=1&controls=0&modestbranding=1&rel=0&iv_load_policy=3&fs=0&disablekb=1&loop=1&playlist=' + id;
        if (coverYouTubeEl) {
          coverYouTubeEl.src = `https://www.youtube.com/embed/${id}?${params}`;
          coverYouTubeEl.style.display = 'block';
        }
      } else if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(videoUrl)) {
        if (coverVideoEl) {
          coverVideoEl.src = videoUrl;
          coverVideoEl.style.display = 'block';
          coverVideoEl.onerror = function () {
            try { this.style.display = 'none'; } catch (e) {}
          };
        }
      }
    }

    const profileNameEl = document.getElementById('profileName');
    if (profileNameEl) {
      profileNameEl.textContent = App.profile.name;
    }
    const profileBioEl = document.getElementById('profileBio');
    if (profileBioEl) {
      profileBioEl.textContent = App.profile.bio;
    }

    const avatar = document.getElementById('profileAvatar');
    if (avatar) {
      avatar.innerHTML = '';
      if (App.profile.picture) {
        const img = document.createElement('img');
        img.src = App.profile.picture;
        img.alt = App.profile.name;
        avatar.appendChild(img);
      } else {
        avatar.textContent = App.profile.avatarInitials;
      }
    }

    const navAvatar = document.getElementById('navProfileAvatar');
    if (navAvatar) {
      navAvatar.innerHTML = '';
      if (App.profile.picture) {
        const img = document.createElement('img');
        img.src = App.profile.picture;
        img.alt = App.profile.name;
        navAvatar.appendChild(img);
      } else {
        navAvatar.textContent = App.profile.avatarInitials;
      }
    }

    const topBarAvatar = document.getElementById('topBarProfileAvatar');
    if (topBarAvatar) {
      topBarAvatar.innerHTML = '';
      if (App.profile.picture) {
        const img = document.createElement('img');
        img.src = App.profile.picture;
        img.alt = App.profile.name;
        topBarAvatar.appendChild(img);
      } else {
        topBarAvatar.textContent = App.profile.avatarInitials;
      }
    }

    const composeNameEl = document.getElementById('composeProfileName');
    if (composeNameEl) {
      composeNameEl.textContent = App.profile.name;
    }
    const composeBioEl = document.getElementById('composeProfileBio');
    if (composeBioEl) {
      composeBioEl.textContent = App.profile.bio;
    }
    const composeAvatarEl = document.getElementById('composeProfileAvatar');
    if (composeAvatarEl) {
      composeAvatarEl.innerHTML = '';
      if (App.profile.picture) {
        const img = document.createElement('img');
        img.src = App.profile.picture;
        img.alt = App.profile.name;
        composeAvatarEl.appendChild(img);
      } else {
        composeAvatarEl.textContent = App.profile.avatarInitials;
      }
    }

    const galleryEl = document.getElementById('profileGallery');
    if (galleryEl) {
      galleryEl.innerHTML = '';
      const gallery = Array.isArray(App.profile.gallery) ? App.profile.gallery : [];
      if (gallery.length === 0) {
        const emptyItem = document.createElement('li');
        emptyItem.className = 'profile-gallery__empty';
        emptyItem.textContent = 'עוד לא נוספו תמונות לגלריה.';
        galleryEl.appendChild(emptyItem);
      } else {
        const canManageGallery = Boolean(galleryManagerRefs.dropZone);
        gallery.forEach((url, index) => {
          if (!url || typeof url !== 'string') {
            return;
          }
          const item = document.createElement('li');
          item.className = 'profile-gallery__item';
          const img = document.createElement('img');
          img.src = url;
          const altText = `${App.profile.name || 'משתמש'} – תמונת גלריה`;
          img.alt = altText;
          item.appendChild(img);
          item.addEventListener('click', () => openGalleryModal(url, altText));
          if (canManageGallery) {
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'profile-gallery__remove';
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', (event) => {
              event.stopPropagation();
              removeGalleryItem(index);
            });
            item.appendChild(removeBtn);
          }
          galleryEl.appendChild(item);
        });
      }
    }
  }

  // חלק מודל גלריה (profile.js) – מציג ומסתיר תמונות מוגדלות
  function setupGalleryModal() {
    if (galleryModalInitialized) {
      return;
    }
    galleryModalRefs.modal = document.getElementById('profileGalleryModal');
    galleryModalRefs.image = document.getElementById('profileGalleryModalImage');
    galleryModalRefs.close = document.getElementById('profileGalleryModalClose');
    if (!galleryModalRefs.modal || !galleryModalRefs.image || !galleryModalRefs.close) {
      return;
    }
    galleryModalRefs.close.addEventListener('click', closeGalleryModal);
    galleryModalRefs.modal.addEventListener('click', (event) => {
      if (event.target === galleryModalRefs.modal) {
        closeGalleryModal();
      }
    });
    document.addEventListener('keydown', handleGalleryModalKeydown);
    galleryModalInitialized = true;
  }

  function openGalleryModal(src, alt) {
    if (!galleryModalInitialized) {
      setupGalleryModal();
    }
    if (!galleryModalRefs.modal || !galleryModalRefs.image) {
      return;
    }
    galleryModalRefs.image.src = src;
    galleryModalRefs.image.alt = alt || 'תצוגת גלריה';
    galleryModalRefs.modal.hidden = false;
    galleryModalRefs.modal.removeAttribute('hidden');
    galleryModalRefs.modal.classList.add('is-visible');
  }

  function closeGalleryModal() {
    if (!galleryModalRefs.modal || !galleryModalRefs.image) {
      return;
    }
    galleryModalRefs.modal.classList.remove('is-visible');
    galleryModalRefs.modal.hidden = true;
    galleryModalRefs.modal.setAttribute('hidden', '');
    galleryModalRefs.image.src = '';
  }

  function handleGalleryModalKeydown(event) {
    if (event.key === 'Escape') {
      closeGalleryModal();
    }
  }

  // חלק ניהול גלריה (profile.js) – מציג הודעת סטטוס מתחת לדרופזון
  function setGalleryStatus(message, isError = false) {
    if (!galleryManagerRefs.status) {
      galleryManagerRefs.status = document.getElementById('profileGalleryStatus');
    }
    if (!galleryManagerRefs.status) {
      return;
    }
    galleryManagerRefs.status.textContent = message || '';
    galleryManagerRefs.status.classList.toggle('is-error', Boolean(isError));
  }

  // חלק ניהול גלריה (profile.js) – שומר שינויים בגלריה ומפרסם אותם
  async function persistGalleryChanges() {
    try {
      window.localStorage.setItem('nostr_profile', JSON.stringify(App.profile));
    } catch (err) {
      console.error('Failed to persist gallery to local storage', err);
    }
    if (App.profileCache instanceof Map) {
      App.profileCache.set(App.publicKey || 'self', {
        name: App.profile.name,
        bio: App.profile.bio,
        picture: App.profile.picture,
        initials: App.profile.avatarInitials,
        gallery: Array.isArray(App.profile.gallery) ? [...App.profile.gallery] : [],
      });
    }
    renderProfile();
    try {
      await App.publishProfileMetadata();
    } catch (err) {
      console.warn('Gallery update: failed publishing metadata', err);
    }
  }

  // חלק ניהול גלריה (profile.js) – מוסיף קבצים חדשים לגלריה הראשית
  async function addFilesToGallery(fileList) {
    if (!fileList || fileList.length === 0) {
      return;
    }
    const files = Array.from(fileList);
    let added = 0;
    for (const file of files) {
      try {
        const dataUrl = await App.resizeImageToDataUrl(file, 1200, 1200, 0.88);
        if (typeof dataUrl === 'string' && dataUrl) {
          App.profile.gallery.push(dataUrl);
          added += 1;
        }
      } catch (err) {
        console.error('Gallery upload failed', err);
        setGalleryStatus('שגיאה בעיבוד אחת התמונות. נסה קובץ אחר.', true);
      }
    }
    if (added > 0) {
      setGalleryStatus(`נוספו ${added} תמונות לגלריה.`);
      await persistGalleryChanges();
    }
  }

  // חלק ניהול גלריה (profile.js) – מסיר תמונה לפי המיקום שלה בגלריה
  async function removeGalleryItem(index) {
    if (!Array.isArray(App.profile.gallery)) {
      return;
    }
    if (index < 0 || index >= App.profile.gallery.length) {
      return;
    }
    App.profile.gallery.splice(index, 1);
    setGalleryStatus('התמונה הוסרה מהגלריה.');
    await persistGalleryChanges();
  }

  // חלק ניהול גלריה (profile.js) – מחבר את הדרופזון והכפתור לבחירת קבצים
  function setupGalleryManager() {
    if (galleryManagerInitialized) {
      return;
    }
    const dropZone = document.getElementById('profileGalleryDropZone');
    const fileInput = document.getElementById('profileGalleryFileInput');
    const addButton = document.getElementById('profileGalleryAddButton');
    if (!dropZone || !fileInput) {
      return;
    }
    galleryManagerRefs.dropZone = dropZone;
    galleryManagerRefs.fileInput = fileInput;
    galleryManagerRefs.addButton = addButton;
    galleryManagerRefs.status = document.getElementById('profileGalleryStatus');

    const stop = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((type) => {
      dropZone.addEventListener(type, stop);
    });
    dropZone.addEventListener('dragenter', () => dropZone.classList.add('is-dragging'));
    dropZone.addEventListener('dragover', () => dropZone.classList.add('is-dragging'));
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-dragging'));
    dropZone.addEventListener('drop', async (event) => {
      dropZone.classList.remove('is-dragging');
      const items = event.dataTransfer?.files;
      if (items && items.length) {
        await addFilesToGallery(items);
      }
    });
    dropZone.addEventListener('click', () => fileInput.click());
    if (addButton) {
      addButton.addEventListener('click', () => fileInput.click());
    }
    fileInput.addEventListener('change', async () => {
      if (fileInput.files && fileInput.files.length) {
        await addFilesToGallery(fileInput.files);
        fileInput.value = '';
      }
    });
    galleryManagerInitialized = true;
  }

  function applyMetadataToProfile(metadata, sourceLabel = 'metadata') {
    if (!metadata || typeof metadata !== 'object') {
      return false;
    }

    const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
    const about = typeof metadata.about === 'string' ? metadata.about.trim() : '';
    const picture = typeof metadata.picture === 'string' ? metadata.picture.trim() : '';
    // חלק תאימות Cover (profile.js) – תומך גם ב-'banner' שנפוץ בלקוחות Nostr
    const cover = typeof metadata.cover === 'string'
      ? metadata.cover.trim()
      : (typeof metadata.banner === 'string' ? metadata.banner.trim() : '');
    const coverVideo = (function () {
      const candidates = [metadata.cover_video, metadata.banner_video, metadata.header_video, metadata.wallpaper_video, metadata.coverVideo];
      for (const c of candidates) { if (typeof c === 'string' && c.trim()) return c.trim(); }
      return '';
    })();
    const gallery = Array.isArray(metadata.gallery)
      ? metadata.gallery.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
    const datingOptIn = Boolean(metadata.dating_opt_in);
    const datingBio = typeof metadata.dating_bio === 'string' ? metadata.dating_bio.trim() : '';
    const datingAge = typeof metadata.dating_age === 'string' ? metadata.dating_age.trim() : '';
    const datingLocation = typeof metadata.dating_location === 'string' ? metadata.dating_location.trim() : '';
    const datingInterests = Array.isArray(metadata.dating_interests)
      ? metadata.dating_interests.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];

    if (!name && !about && !picture && !cover && !coverVideo && gallery.length === 0) {
      console.log(`Profile metadata: ${sourceLabel} missing relevant fields`, metadata);
      return false;
    }

    if (name) {
      App.profile.name = name;
    }
    if (about) {
      App.profile.bio = about;
    }
    if (picture) {
      App.profile.picture = picture;
    }
    if (cover) {
      App.profile.cover = cover;
    }
    if (coverVideo) {
      App.profile.coverVideo = coverVideo;
    }
    App.profile.gallery = gallery;
    App.profile.avatarInitials = App.getInitials(App.profile.name || '');
    App.profile.dating = Object.assign(
      {
        optIn: false,
        bio: '',
        age: '',
        location: '',
        interests: [],
      },
      App.profile.dating,
      {
        optIn: datingOptIn,
        bio: datingBio,
        age: datingAge,
        location: datingLocation,
        interests: datingInterests,
      },
    );

    try {
      window.localStorage.setItem(
        'nostr_profile',
        JSON.stringify(
          Object.assign({}, App.profile, {
            gallery: Array.isArray(App.profile.gallery) ? [...App.profile.gallery] : [],
            dating: App.profile.dating
              ? {
                  optIn: Boolean(App.profile.dating.optIn),
                  bio: App.profile.dating.bio || '',
                  age: App.profile.dating.age || '',
                  location: App.profile.dating.location || '',
                  interests: Array.isArray(App.profile.dating.interests) ? [...App.profile.dating.interests] : [],
                }
              : { optIn: false, bio: '', age: '', location: '', interests: [] },
          }),
        ),
      );
    } catch (err) {
      console.warn('Profile metadata: failed caching profile locally', err);
    }

    if (App.profileCache instanceof Map) {
      App.profileCache.set(App.publicKey, {
        name: App.profile.name,
        bio: App.profile.bio,
        picture: App.profile.picture,
        cover: App.profile.cover,
        initials: App.profile.avatarInitials,
        gallery: Array.isArray(App.profile.gallery) ? [...App.profile.gallery] : [],
        dating: App.profile.dating
          ? {
              optIn: Boolean(App.profile.dating.optIn),
              bio: App.profile.dating.bio || '',
              age: App.profile.dating.age || '',
              location: App.profile.dating.location || '',
              interests: Array.isArray(App.profile.dating.interests) ? [...App.profile.dating.interests] : [],
            }
          : { optIn: false, bio: '', age: '', location: '', interests: [] },
      });
    }

    renderProfile();
    applyDatingSettingsToUI();
    return true;
  }

  async function publishProfileMetadata() {
    if (!App.pool || !App.publicKey) {
      App.metadataPublishQueued = true;
      return;
    }
    App.metadataPublishQueued = false;

    const metadata = {
      name: App.profile.name,
      about: App.profile.bio,
      picture: App.profile.picture,
      cover: App.profile.cover,
      // חלק תאימות Cover (profile.js) – מפרסם גם banner עבור לקוחות אחרים
      banner: App.profile.cover,
      cover_video: App.profile.coverVideo,
      banner_video: App.profile.coverVideo,
      gallery: Array.isArray(App.profile.gallery) ? App.profile.gallery : [],
      dating_opt_in: Boolean(App.profile.dating?.optIn),
      dating_bio: App.profile.dating?.bio || '',
      dating_age: App.profile.dating?.age || '',
      dating_location: App.profile.dating?.location || '',
      dating_interests: Array.isArray(App.profile.dating?.interests) ? App.profile.dating.interests : [],
    };

    const content = JSON.stringify(metadata);
    const maxLength = App.MAX_METADATA_CONTENT_LENGTH;
    // חלק מטא-דאטה (profile.js) – קיטון חכם: חל גם ללא גלריה כדי לאפשר cover תקין בפרסום
    if (content.length > maxLength) {
      const slimMetadata = Object.assign({}, metadata, {
        picture: metadata.picture && metadata.picture.length <= App.MAX_INLINE_PICTURE_LENGTH ? metadata.picture : '',
        cover: metadata.cover && metadata.cover.length <= App.MAX_INLINE_PICTURE_LENGTH ? metadata.cover : '',
        banner: metadata.banner && metadata.banner.length <= App.MAX_INLINE_PICTURE_LENGTH ? metadata.banner : '',
        cover_video: metadata.cover_video || '',
        banner_video: metadata.banner_video || '',
        gallery: metadata.gallery
          .filter((item) => typeof item === 'string' && item.startsWith('data:'))
          .sort((a, b) => a.length - b.length)
          .slice(0, 8),
      });
      const slimContent = JSON.stringify(slimMetadata);
      if (slimContent.length <= maxLength) {
        console.warn('Metadata content trimmed to fit limit');
        metadata.picture = slimMetadata.picture;
        metadata.cover = slimMetadata.cover;
        metadata.banner = slimMetadata.banner;
        metadata.cover_video = slimMetadata.cover_video;
        metadata.banner_video = slimMetadata.banner_video;
        metadata.gallery = slimMetadata.gallery;
      } else {
        const finalGallery = [];
        let accumulated = JSON.stringify(Object.assign({}, metadata, { picture: '', cover: '', banner: '', gallery: [] })).length;
        for (const item of slimMetadata.gallery) {
          const candidateLength = accumulated + item.length + 4;
          if (candidateLength > maxLength) {
            break;
          }
          finalGallery.push(item);
          accumulated += item.length + 4;
        }
        metadata.picture = slimMetadata.picture;
        metadata.cover = slimMetadata.cover;
        metadata.banner = slimMetadata.banner;
        metadata.cover_video = slimMetadata.cover_video;
        metadata.banner_video = slimMetadata.banner_video;
        metadata.gallery = finalGallery;
        console.warn('Metadata content aggressively trimmed to fit limit');
      }
    }
    // ניסיון נוסף: אם עדיין גדול – מסירים תחילה cover, ואז picture, כדי להבטיח פרסום נתונים בסיסיים
    let finalLength = JSON.stringify(metadata).length;
    if (finalLength > maxLength && metadata.banner) {
      metadata.banner = '';
      finalLength = JSON.stringify(metadata).length;
    }
    if (finalLength > maxLength && metadata.cover) {
      metadata.cover = '';
      finalLength = JSON.stringify(metadata).length;
    }
    if (finalLength > maxLength && metadata.cover_video) {
      metadata.cover_video = '';
      finalLength = JSON.stringify(metadata).length;
    }
    if (finalLength > maxLength && metadata.banner_video) {
      metadata.banner_video = '';
      finalLength = JSON.stringify(metadata).length;
    }
    if (finalLength > maxLength && metadata.picture) {
      metadata.picture = '';
      finalLength = JSON.stringify(metadata).length;
    }
    if (finalLength > maxLength) {
      console.warn('Metadata content still too large after trimming, skipping publish');
      return;
    }

    const draft = {
      kind: 0,
      pubkey: App.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', App.NETWORK_TAG]],
      content,
    };

    const event = App.finalizeEvent(draft, App.privateKey);

    try {
      await App.pool.publish(App.relayUrls, event);
      console.log('Profile metadata published');
    } catch (err) {
      App.metadataPublishQueued = true;
      console.error('Failed to publish profile metadata', err);
    }
  }

  function openProfileSettings() {
    document.getElementById('profileNameInput').value = App.profile.name;
    document.getElementById('profileBioInput').value = App.profile.bio;
    document.getElementById('profileImageUrlInput').value = App.profile.picture;
    const coverUrlEl = document.getElementById('profileCoverUrlInput');
    if (coverUrlEl) {
      coverUrlEl.value = App.profile.cover || '';
    }
    const coverVideoUrlEl = document.getElementById('profileCoverVideoUrlInput');
    if (coverVideoUrlEl) {
      coverVideoUrlEl.value = App.profile.coverVideo || '';
    }
    document.getElementById('profileStatus').textContent = '';
    document.getElementById('profileModal').style.display = 'flex';
  }

  function closeProfileSettings() {
    document.getElementById('profileModal').style.display = 'none';
  }

  async function saveProfileSettings() {
    const name = document.getElementById('profileNameInput').value.trim() || 'משתמש אנונימי';
    const bio = document.getElementById('profileBioInput').value.trim();
    let picture = document.getElementById('profileImageUrlInput').value.trim();
    let cover = document.getElementById('profileCoverUrlInput')?.value?.trim?.() || '';
    let coverVideoUrl = document.getElementById('profileCoverVideoUrlInput')?.value?.trim?.() || '';
    const gallerySelection = Array.isArray(App.profile.gallery) ? [...App.profile.gallery] : [];

    const fileInput = document.getElementById('profileImageFileInput');
    const coverFileInput = document.getElementById('profileCoverFileInput');
    const status = document.getElementById('profileStatus');

    const applyProfile = (finalPicture) => {
      App.profile.name = name;
      App.profile.bio = bio || 'יוצר מבוזר Nostr';
      const resolvedPicture = finalPicture || picture;
      if (
        resolvedPicture &&
        resolvedPicture.startsWith('data:') &&
        resolvedPicture.length > App.MAX_INLINE_PICTURE_LENGTH
      ) {
        status.textContent = 'תמונת הפרופיל גדולה מדי. העלה קישור חיצוני קצר.';
        return;
      }

      App.profile.picture = resolvedPicture;
      App.profile.cover = cover || App.profile.cover || '';
      App.profile.coverVideo = coverVideoUrl || '';
      App.profile.gallery = gallerySelection;
      App.profile.avatarInitials = App.getInitials(name);

      try {
        window.localStorage.setItem('nostr_profile', JSON.stringify(App.profile));
      } catch (e) {
        console.error('Failed to save profile to local storage', e);
      }
      renderProfile();
      closeProfileSettings();
      App.profileCache.set(App.publicKey || 'self', {
        name: App.profile.name,
        bio: App.profile.bio,
        picture: App.profile.picture,
        cover: App.profile.cover,
        coverVideo: App.profile.coverVideo,
        initials: App.profile.avatarInitials,
        gallery: Array.isArray(App.profile.gallery) ? [...App.profile.gallery] : [],
      });
      publishProfileMetadata();
    };

    if (fileInput.files && fileInput.files[0]) {
      try {
        const resized = await App.resizeImageToDataUrl(fileInput.files[0]);
        picture = resized;
        applyProfile(picture);
      } catch (e) {
        console.error('Failed to resize profile image', e);
        status.textContent = 'שגיאה בעיבוד התמונה. נסה קובץ אחר.';
      }
    } else {
      applyProfile(picture);
    }

    // חלק תמונת נושא (profile.js) – עיבוד קובץ cover אם הועלה
    if (coverFileInput && coverFileInput.files && coverFileInput.files[0]) {
      try {
        const coverResized = await App.resizeImageToDataUrl(coverFileInput.files[0], 1280, 720, 0.82);
        cover = coverResized;
        // עדכון מיידי של ה-cover ב-UI והמטמון
        App.profile.cover = cover;
        try {
          window.localStorage.setItem('nostr_profile', JSON.stringify(App.profile));
        } catch (e) {}
        const coverBanner = document.getElementById('profilePageCoverBanner');
        if (coverBanner) {
          coverBanner.style.backgroundImage = `url("${cover}")`;
        }
        publishProfileMetadata();
      } catch (e) {
        console.error('Failed to resize cover image', e);
      }
    }
  }

  async function loadOwnProfileMetadata() {
    if (!App.publicKey || !App.pool) {
      // חלק פרופיל (profile.js) – אם החיבור או המפתח עוד לא מוכנים אין מה לטעון
      return;
    }

    try {
      // חלק פרופיל (profile.js) – מושך נתוני פרופיל מהריליים עבור המשתמש הנוכחי
      console.log('Profile metadata: requesting own metadata for pubkey', App.publicKey);
      const event = await App.pool.get(App.relayUrls, { kinds: [0], authors: [App.publicKey] });
      if (!event?.content) {
        console.log('Profile metadata: no metadata event received for', App.publicKey);
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(event.content);
      } catch (err) {
        console.warn('Failed to parse own profile metadata', err);
        return;
      }
      if (applyMetadataToProfile(parsed, 'initial load')) {
        console.log('Profile metadata: updated local profile for', App.publicKey, App.profile);
      }
    } catch (err) {
      console.warn('Failed to load own profile metadata', err);
    }
  }

  function subscribeOwnProfileMetadata() {
    if (!App.pool || !App.publicKey || typeof App.pool.subscribeMany !== 'function') {
      return;
    }

    if (App.ownProfileMetadataSub?.close) {
      App.ownProfileMetadataSub.close();
    }

    // חלק פרופיל (profile.js) – מאזין לכל עדכון מטא-דאטה עבור המשתמש ומרענן את הממשק
    const sub = App.pool.subscribeMany(App.relayUrls, [{ kinds: [0], authors: [App.publicKey] }], {
      onevent(event) {
        if (!event?.content) {
          return;
        }
        try {
          const parsed = JSON.parse(event.content);
          if (applyMetadataToProfile(parsed, 'subscription')) {
            console.log('Profile metadata: subscription update applied', parsed);
          }
        } catch (err) {
          console.warn('Profile metadata: failed parsing subscription event', err);
        }
      },
    });

    App.ownProfileMetadataSub = sub;
  }

  App.renderProfile = renderProfile;
  App.publishProfileMetadata = publishProfileMetadata;
  App.openProfileSettings = openProfileSettings;
  App.closeProfileSettings = closeProfileSettings;
  App.saveProfileSettings = saveProfileSettings;
  App.loadOwnProfileMetadata = loadOwnProfileMetadata;
  App.subscribeOwnProfileMetadata = subscribeOwnProfileMetadata;

  // חלק פרופיל (profile.js) – פונקציית עזר שמחברת מאזיני לחיצה למספר כפתורים לפי מזהה
  function attachClicks(ids = [], handler) {
    if (!Array.isArray(ids) || typeof handler !== 'function') {
      return;
    }
    ids.forEach((id) => {
      if (typeof id !== 'string') {
        return;
      }
      const element = document.getElementById(id);
      if (!element) {
        return;
      }
      element.addEventListener('click', (event) => {
        handler(event);
      });
    });
  }

  function bindButtons() {
    attachClicks(['profileEditButton', 'profileTopEditButton'], () => {
      if (typeof window.openProfileSettings === 'function') {
        window.openProfileSettings();
      }
    });

    attachClicks(['profileHomeButton', 'profileTopHomeButton'], () => {
      window.location.href = 'index.html';
    });

    attachClicks(['profileTopBackButton'], () => {
      const target = document.getElementById('profileTopBackButton');
      const href = target?.getAttribute('data-back-target') || 'index.html';
      if (href === 'history') {
        window.history.back();
      } else {
        window.location.href = href;
      }
    });

    attachClicks(['profileRefreshPosts'], () => {
      if (typeof App.loadOwnPosts === 'function') {
        App.loadOwnPosts();
        return;
      }
      if (typeof window.loadOwnPosts === 'function') {
        window.loadOwnPosts();
        return;
      }
      if (typeof loadOwnPosts === 'function') {
        loadOwnPosts();
        return;
      }
      console.warn('Profile: loadOwnPosts unavailable when refresh requested');
    });
    attachClicks(['profileQuickCompose'], () => {
      window.location.href = 'index.html#compose';
    });
  }

  bindButtons();

  // חלק חשיפת פונקציות (profile.js) – מבטיח שגם בדפי פרופיל ללא טעינת app.js המקורי נוכל לפתוח/לסגור את המודל כמו בדף הבית
  if (typeof window.openProfileSettings !== 'function') {
    window.openProfileSettings = openProfileSettings;
  }
  if (typeof window.closeProfileSettings !== 'function') {
    window.closeProfileSettings = closeProfileSettings;
  }
  if (typeof window.saveProfileSettings !== 'function') {
    window.saveProfileSettings = saveProfileSettings;
  }
})(window);
