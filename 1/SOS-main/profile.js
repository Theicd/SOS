(function initProfile(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק אתחול נתוני פרופיל (profile.js) – מבטיח שמבנה הפרופיל כולל גלריה וקורא מהמטמון המקומי
  if (!App.profile || typeof App.profile !== 'object') {
    App.profile = {};
  }

  // חלק ניקוי (profile.js) – מנקה localStorage מנתונים גדולים שגורמים ל-QuotaExceededError
  function cleanupLocalStorage() {
    try {
      const stored = window.localStorage.getItem('nostr_profile');
      if (!stored) return;
      
      const profile = JSON.parse(stored);
      let needsCleanup = false;
      
      // בדיקה אם יש data URLs גדולים
      if (profile.picture && profile.picture.startsWith('data:') && profile.picture.length > 50000) {
        profile.picture = '';
        needsCleanup = true;
      }
      if (profile.cover && profile.cover.startsWith('data:') && profile.cover.length > 50000) {
        profile.cover = '';
        needsCleanup = true;
      }
      if (Array.isArray(profile.gallery) && profile.gallery.length > 0) {
        const cleanGallery = profile.gallery.filter(url => !url.startsWith('data:') || url.length < 50000);
        if (cleanGallery.length !== profile.gallery.length) {
          profile.gallery = cleanGallery;
          needsCleanup = true;
        }
      }
      
      if (needsCleanup) {
        window.localStorage.setItem('nostr_profile', JSON.stringify(profile));
        console.log('Profile: cleaned up large data URLs from localStorage');
      }
    } catch (err) {
      console.warn('Profile: failed to cleanup localStorage', err);
      // אם הניקוי נכשל, ננסה למחוק הכל ולהתחיל מחדש
      try {
        window.localStorage.removeItem('nostr_profile');
        console.log('Profile: cleared localStorage due to cleanup failure');
      } catch (e) {
        console.error('Profile: even localStorage clear failed', e);
      }
    }
  }

  // הרצת ניקוי בהתחלה
  cleanupLocalStorage();

  let profileCoverClickBound = false;
  function bindProfileCoverClick() {
    if (profileCoverClickBound) {
      return;
    }
    const coverBanner = document.getElementById('profilePageCoverBanner');
    if (!coverBanner) {
      return;
    }
    coverBanner.addEventListener('click', async (event) => {
      // התעלמות מלחיצות על אזור הכפתורים או על האווטאר
      if (event.target.closest('.profile-cover__actions') || event.target.closest('#profilePageAvatar')) {
        return;
      }
      const shouldReplace = await requestCoverReplacement();
      if (!shouldReplace) {
        return;
      }
      deleteProfileCover();
      const tempInput = document.createElement('input');
      tempInput.type = 'file';
      tempInput.accept = 'image/*';
      tempInput.style.display = 'none';
      tempInput.addEventListener(
        'change',
        async () => {
          try {
            const [file] = tempInput.files || [];
            if (file) {
              const resized = await App.resizeImageToDataUrl(file, 1280, 720, 0.82);
              await applyCoverUpdate(resized);
            }
          } catch (err) {
            console.error('Profile: failed replacing cover via quick picker', err);
          } finally {
            tempInput.remove();
          }
        },
        { once: true },
      );
      document.body.appendChild(tempInput);
      tempInput.click();
    });
    profileCoverClickBound = true;
  }

  async function applyCoverUpdate(coverDataUrl) {
    if (!coverDataUrl || typeof coverDataUrl !== 'string') {
      return;
    }
    App.profile.cover = coverDataUrl;
    try {
      window.localStorage.setItem('nostr_profile', JSON.stringify(App.profile));
    } catch (err) {
      console.error('Profile: failed persisting quick cover change', err);
    }
    if (App.profileCache instanceof Map) {
      App.profileCache.set(App.publicKey || 'self', {
        name: App.profile.name,
        bio: App.profile.bio,
        picture: App.profile.picture,
        cover: App.profile.cover,
        initials: App.profile.avatarInitials,
        gallery: Array.isArray(App.profile.gallery) ? [...App.profile.gallery] : [],
      });
    }
    renderProfile();
    try {
      await publishProfileMetadata();
    } catch (err) {
      console.warn('Profile: quick cover publish failed', err);
    }
    showProfileDialog({
      title: 'רענון מומלץ',
      message: 'התמונה עודכנה. אם אינך רואה שינוי מידי, רענן את הדף.',
    });
  }

  const profileDefaults = {
    name: 'משתמש אנונימי',
    bio: 'יצירת תוכן מבוזר, בלי שוטר באמצע',
    headline: '',
    role: '',
    company: '',
    location: '',
    website: '',
    avatarInitials: 'AN',
    picture: '',
    cover: '', // חלק תמונת נושא (profile.js) – נתיב/נתון לתמונת cover עבור באנר הכיסוי
    gallery: [],
    dating: {
      optIn: false,
      gender: '',
      bio: '',
      age: '',
      location: '',
      interests: [],
    },
  };

  const normalizeWebsite = (value) => {
    if (typeof value !== 'string') {
      return '';
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return '';
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
      return trimmed;
    }
    return `https://${trimmed}`;
  };

  const AVATAR_REPLACE_PROMPT = 'האם למחוק את תמונת הפרופיל הנוכחית ולבחור תמונה חדשה?';

  try {
    const storedProfile = window.localStorage.getItem('nostr_profile');
    if (storedProfile) {
      const parsedProfile = JSON.parse(storedProfile);
      App.profile = Object.assign({}, profileDefaults, parsedProfile);
    } else {
      App.profile = Object.assign({}, profileDefaults, App.profile);
    }
  } catch (err) {
    console.warn('Profile init: failed restoring cached profile', err);
    App.profile = Object.assign({}, profileDefaults, App.profile);
  }

  App.profile.headline = typeof App.profile.headline === 'string' ? App.profile.headline : '';
  App.profile.role = typeof App.profile.role === 'string' ? App.profile.role : '';
  App.profile.company = typeof App.profile.company === 'string' ? App.profile.company : '';
  App.profile.location = typeof App.profile.location === 'string' ? App.profile.location : '';
  App.profile.website = normalizeWebsite(typeof App.profile.website === 'string' ? App.profile.website : '');
  if (!Array.isArray(App.profile.gallery)) {
    App.profile.gallery = [];
  }
  if (!App.profile.dating || typeof App.profile.dating !== 'object') {
    App.profile.dating = { optIn: false, gender: '', bio: '', age: '', location: '', interests: [] };
  } else {
    App.profile.dating = Object.assign({ optIn: false, gender: '', bio: '', age: '', location: '', interests: [] }, App.profile.dating);
    if (!Array.isArray(App.profile.dating.interests)) {
      App.profile.dating.interests = [];
    }
  }

  let datingFormOpen = false;
  let profileAvatarClickBound = false;
  const avatarDialogRefs = {
    dialog: null,
    confirm: null,
    cancel: null,
  };
  let avatarDialogInitialized = false;
  let avatarDialogResolver = null;
  const infoDialogRefs = {
    dialog: null,
    close: null,
    title: null,
    message: null,
  };
  let infoDialogInitialized = false;
  const COVER_REPLACE_PROMPT = 'האם למחוק את תמונת הנושא הנוכחית ולבחור תמונה חדשה?';
  const coverDialogRefs = {
    dialog: null,
    confirm: null,
    cancel: null,
  };
  let coverDialogInitialized = false;
  let coverDialogResolver = null;

  function resolveAvatarDialog(result) {
    if (avatarDialogResolver) {
      const resolver = avatarDialogResolver;
      avatarDialogResolver = null;
      resolver(Boolean(result));
    }
  }

  function ensureAvatarDialog() {
    if (avatarDialogInitialized) {
      return;
    }
    const dialog = document.getElementById('profileAvatarDialog');
    const confirmButton = document.getElementById('profileAvatarDialogConfirm');
    const cancelButton = document.getElementById('profileAvatarDialogCancel');
    if (!dialog || !confirmButton || !cancelButton || typeof dialog.showModal !== 'function') {
      return;
    }
    avatarDialogRefs.dialog = dialog;
    avatarDialogRefs.confirm = confirmButton;
    avatarDialogRefs.cancel = cancelButton;

    const messageEl = dialog.querySelector('.profile-dialog__message');
    if (messageEl) {
      messageEl.textContent = 'התמונה הנוכחית תימחק ונפתח עבורך חלון לבחירת תמונה חדשה מהמכשיר. האם להמשיך?';
    }

    confirmButton.addEventListener('click', () => {
      dialog.close('confirm');
    });

    cancelButton.addEventListener('click', () => {
      dialog.close('cancel');
    });

    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      dialog.close('cancel');
    });

    dialog.addEventListener('close', () => {
      resolveAvatarDialog(dialog.returnValue === 'confirm');
    });

    avatarDialogInitialized = true;
  }

  function requestAvatarReplacement() {
    ensureAvatarDialog();
    const dialog = avatarDialogRefs.dialog;
    if (!dialog || typeof dialog.showModal !== 'function') {
      const fallback = window.confirm(AVATAR_REPLACE_PROMPT);
      return Promise.resolve(fallback);
    }

    if (dialog.open) {
      dialog.close('cancel');
    }

    if (avatarDialogResolver) {
      resolveAvatarDialog(false);
    }

    return new Promise((resolve) => {
      avatarDialogResolver = resolve;
      dialog.returnValue = '';
      try {
        dialog.showModal();
      } catch (err) {
        console.warn('Profile: failed opening avatar dialog, falling back to confirm', err);
        avatarDialogResolver = null;
        resolve(window.confirm(AVATAR_REPLACE_PROMPT));
      }
    });
  }

  function ensureCoverDialog() {
    if (coverDialogInitialized) {
      return;
    }
    const dialog = document.getElementById('profileCoverDialog');
    const confirmButton = document.getElementById('profileCoverDialogConfirm');
    const cancelButton = document.getElementById('profileCoverDialogCancel');
    if (!dialog || !confirmButton || !cancelButton || typeof dialog.showModal !== 'function') {
      return;
    }
    coverDialogRefs.dialog = dialog;
    coverDialogRefs.confirm = confirmButton;
    coverDialogRefs.cancel = cancelButton;

    const messageEl = dialog.querySelector('.profile-dialog__message');
    if (messageEl) {
      messageEl.textContent = 'תמונת הנושא הנוכחית תימחק ונפתח עבורך חלון לבחירת תמונה חדשה מהמכשיר. האם להמשיך?';
    }

    confirmButton.addEventListener('click', () => {
      dialog.close('confirm');
    });
    cancelButton.addEventListener('click', () => {
      dialog.close('cancel');
    });
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      dialog.close('cancel');
    });
    dialog.addEventListener('close', () => {
      if (coverDialogResolver) {
        const resolver = coverDialogResolver;
        coverDialogResolver = null;
        resolver(dialog.returnValue === 'confirm');
      }
    });
    coverDialogInitialized = true;
  }

  function requestCoverReplacement() {
    ensureCoverDialog();
    const dialog = coverDialogRefs.dialog;
    if (!dialog || typeof dialog.showModal !== 'function') {
      const fallback = window.confirm(COVER_REPLACE_PROMPT);
      return Promise.resolve(fallback);
    }
    if (dialog.open) {
      dialog.close('cancel');
    }
    if (coverDialogResolver) {
      const resolver = coverDialogResolver;
      coverDialogResolver = null;
      resolver(false);
    }
    return new Promise((resolve) => {
      coverDialogResolver = resolve;
      dialog.returnValue = '';
      try {
        dialog.showModal();
      } catch (err) {
        console.warn('Profile: failed opening cover dialog, falling back to confirm', err);
        coverDialogResolver = null;
        resolve(window.confirm(COVER_REPLACE_PROMPT));
      }
    });
  }

  function ensureInfoDialog() {
    if (infoDialogInitialized) {
      return;
    }
    const dialog = document.getElementById('profileInfoDialog');
    const closeButton = document.getElementById('profileInfoDialogClose');
    const titleEl = document.getElementById('profileInfoDialogTitle');
    const messageEl = document.getElementById('profileInfoDialogMessage');
    if (!dialog || !closeButton || typeof dialog.showModal !== 'function') {
      return;
    }
    infoDialogRefs.dialog = dialog;
    infoDialogRefs.close = closeButton;
    infoDialogRefs.title = titleEl || null;
    infoDialogRefs.message = messageEl || null;

    closeButton.addEventListener('click', () => {
      dialog.close('dismiss');
    });

    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      dialog.close('dismiss');
    });

    infoDialogInitialized = true;
  }

  function showProfileDialog({ title, message }) {
    ensureInfoDialog();
    const dialog = infoDialogRefs.dialog;
    if (!dialog || typeof dialog.showModal !== 'function') {
      window.alert(message || title || '');
      return;
    }

    if (dialog.open) {
      dialog.close('dismiss');
    }

    if (infoDialogRefs.title) {
      infoDialogRefs.title.textContent = title || 'הודעה';
    }
    if (infoDialogRefs.message) {
      infoDialogRefs.message.textContent = message || '';
    }

    try {
      dialog.showModal();
    } catch (err) {
      console.warn('Profile: failed opening info dialog, falling back to alert', err);
      window.alert(message || title || '');
    }
  }

  function applyDatingSettingsToUI() {
    const optInCheckbox = document.getElementById('profileDatingOptIn');
    const fieldsWrapper = document.getElementById('profileDatingFields');
    const genderSelect = document.getElementById('profileDatingGender');
    const bioInput = document.getElementById('profileDatingBio');
    const ageInput = document.getElementById('profileDatingAge');
    const locationInput = document.getElementById('profileDatingLocation');
    const interestsInput = document.getElementById('profileDatingInterests');
    const editButton = document.getElementById('profileDatingEditButton');
    if (!optInCheckbox || !fieldsWrapper) {
      return;
    }
    const dating =
      App.profile.dating || { optIn: false, gender: '', bio: '', age: '', location: '', interests: [] };
    if (genderSelect) {
      genderSelect.value = dating.gender || '';
    }
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
    const genderSelect = document.getElementById('profileDatingGender');
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
      persistDatingSettings(status, genderSelect, bioInput, ageInput, locationInput, interestsInput, false);
    });

    if (saveButton) {
      saveButton.addEventListener('click', () => {
        persistDatingSettings(status, genderSelect, bioInput, ageInput, locationInput, interestsInput, true);
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

  function persistDatingSettings(statusEl, genderSelect, bioInput, ageInput, locationInput, interestsInput, showMessage) {
    const dating =
      App.profile.dating || { optIn: false, gender: '', bio: '', age: '', location: '', interests: [] };
    dating.bio = bioInput?.value?.trim() || '';
    dating.gender = genderSelect?.value || '';
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
    // חלק הכרויות (profile.js) – שליחת אירוע על שינוי מגדר הצופה להכרויות
    try {
      window.dispatchEvent(
        new CustomEvent('dating:viewer-gender-changed', {
          detail: { gender: dating.gender || '' },
        }),
      );
    } catch (err) {
      console.warn('Profile dating: failed dispatching viewer gender change', err);
    }

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
          gender: App.profile.dating.gender || '',
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

  function bindProfileAvatarClick() {
    if (profileAvatarClickBound) {
      return;
    }
    const avatarEl = document.getElementById('profilePageAvatar');
    if (!avatarEl) {
      return;
    }
    avatarEl.addEventListener('click', async () => {
      const shouldReplace = await requestAvatarReplacement();
      if (!shouldReplace) {
        return;
      }
      deleteProfileImage();
      const tempInput = document.createElement('input');
      tempInput.type = 'file';
      tempInput.accept = 'image/*';
      tempInput.style.display = 'none';
      tempInput.addEventListener(
        'change',
        async () => {
          try {
            const [file] = tempInput.files || [];
            if (file) {
              // חלק תמונת פרופיל (profile.js) – עיבוד באיכות גבוהה כמו תמונת נושא להכרויות
              const resized = await App.resizeImageToDataUrl(file, 512, 512, 0.85);
              applyProfilePictureUpdate(resized);
            }
          } catch (err) {
            console.error('Profile: failed replacing avatar via quick picker', err);
          } finally {
            tempInput.remove();
          }
        },
        { once: true },
      );
      document.body.appendChild(tempInput);
      tempInput.click();
    });
    profileAvatarClickBound = true;
  }

  // חלק פרופיל (profile.js) – החלפת תמונת פרופיל בזמן אמת ללא פתיחת טופס עריכה
  async function applyProfilePictureUpdate(pictureDataUrl) {
    if (!pictureDataUrl || typeof pictureDataUrl !== 'string') {
      return;
    }
    App.profile.picture = pictureDataUrl;
    App.profile.avatarInitials = App.getInitials(App.profile.name || '');
    const urlInput = document.getElementById('profileImageUrlInput');
    if (urlInput) {
      urlInput.value = pictureDataUrl;
    }
    // חלק פרופיל (profile.js) – שמירה קלה ללא data URLs גדולים
    try {
      const lightProfile = {
        name: App.profile.name,
        bio: App.profile.bio,
        headline: App.profile.headline,
        role: App.profile.role,
        company: App.profile.company,
        location: App.profile.location,
        website: App.profile.website,
        picture: (App.profile.picture && !App.profile.picture.startsWith('data:')) ? App.profile.picture : '',
        cover: (App.profile.cover && !App.profile.cover.startsWith('data:')) ? App.profile.cover : '',
        avatarInitials: App.profile.avatarInitials,
        lastUpdateTimestamp: App.profile.lastUpdateTimestamp,
      };
      window.localStorage.setItem('nostr_profile', JSON.stringify(lightProfile));
    } catch (err) {
      console.error('Profile: failed persisting quick avatar change', err);
    }
    const normalizedPubkey = typeof App.publicKey === 'string' ? App.publicKey.toLowerCase() : 'self';
    // חלק פרופיל (profile.js) – שמירת timestamp של העדכון המקומי
    App.profile.lastUpdateTimestamp = Math.floor(Date.now() / 1000);
    if (App.profileCache instanceof Map) {
      const profileData = {
        name: App.profile.name,
        bio: App.profile.bio,
        picture: App.profile.picture,
        cover: App.profile.cover,
        initials: App.profile.avatarInitials,
        gallery: Array.isArray(App.profile.gallery) ? [...App.profile.gallery] : [],
      };
      // עדכון כל הוריאציות של ה-pubkey
      App.profileCache.set(normalizedPubkey, profileData);
      App.profileCache.set(App.publicKey || 'self', profileData);
      if (App.feedAuthorProfiles instanceof Map) {
        App.feedAuthorProfiles.set(normalizedPubkey, profileData);
        App.feedAuthorProfiles.set(App.publicKey || 'self', profileData);
      }
      if (App.authorProfiles instanceof Map) {
        App.authorProfiles.set(normalizedPubkey, profileData);
        App.authorProfiles.set(App.publicKey || 'self', profileData);
      }
    }
    renderProfile();
    // חלק פרופיל (profile.js) – מעדכן את כל הפוסטים בפיד עם התמונה החדשה
    if (typeof App.updateRenderedAuthorProfile === 'function') {
      App.updateRenderedAuthorProfile(normalizedPubkey, {
        name: App.profile.name,
        bio: App.profile.bio,
        picture: App.profile.picture,
        initials: App.profile.avatarInitials,
      });
    }
    try {
      await publishProfileMetadata();
    } catch (err) {
      console.warn('Profile: quick avatar publish failed', err);
    }
    showProfileDialog({
      title: 'רענון מומלץ',
      message: 'התמונה עודכנה. אם אינך רואה שינוי מידי, רענן את הדף.',
    });
  }

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
    bindProfileCoverClick();

    // חלק אווטאר כיסוי (profile.js) – מעדכן את תמונת פרופיל הבאנר לאחר שינוי מיידי
    const coverAvatarEl = document.getElementById('profilePageAvatar');
    if (coverAvatarEl) {
      coverAvatarEl.innerHTML = '';
      if (App.profile.picture) {
        const coverAvatarImg = document.createElement('img');
        coverAvatarImg.src = App.profile.picture;
        coverAvatarImg.alt = App.profile.name;
        coverAvatarEl.appendChild(coverAvatarImg);
      } else {
        coverAvatarEl.textContent = App.profile.avatarInitials;
      }
    }

    // חלק כותרת כיסוי (profile.js) – מעדכן את שם המשתמש בבאנר העליון ללא רענון דף
    const coverNameEl = document.getElementById('profilePageName');
    if (coverNameEl) {
      coverNameEl.textContent = App.profile.name || 'משתמש';
    }
    // חלק ביוגרפיית כיסוי (profile.js) – מעדכן את תיאור המשתמש בבאנר העליון
    const coverBioEl = document.getElementById('profilePageBio');
    if (coverBioEl) {
      coverBioEl.textContent = App.profile.bio || 'מעדכנים את תיאור הפרופיל...';
    }

    const profileNameEl = document.getElementById('profileName');
    if (profileNameEl) {
      profileNameEl.textContent = App.profile.name;
    }
    const topTitle = document.getElementById('profileTopTitle');
    if (topTitle) {
      topTitle.textContent = App.profile.name || 'הפרופיל שלי';
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

    bindProfileAvatarClick();

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
      composeNameEl.textContent = App.profile.name || 'משתמש';
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

    const profileFollowersList = document.getElementById('profileFollowersList');
    if (profileFollowersList) {
      profileFollowersList.innerHTML = '';
    }

    const aboutHeadlineRow = document.getElementById('profileAboutHeadlineRow');
    const aboutHeadline = document.getElementById('profileAboutHeadline');
    if (aboutHeadlineRow) {
      const value = App.profile.headline?.trim();
      if (value) {
        aboutHeadlineRow.hidden = false;
        if (aboutHeadline) {
          aboutHeadline.textContent = value;
        }
      } else {
        aboutHeadlineRow.hidden = true;
      }
    }

    const aboutRoleRow = document.getElementById('profileAboutRoleRow');
    const aboutRole = document.getElementById('profileAboutRole');
    const aboutCompany = document.getElementById('profileAboutCompany');
    const roleValue = App.profile.role?.trim();
    const companyValue = App.profile.company?.trim();
    if (aboutRoleRow) {
      if (roleValue || companyValue) {
        aboutRoleRow.hidden = false;
        if (aboutRole) {
          aboutRole.textContent = roleValue || 'תפקיד';
        }
        if (aboutCompany) {
          aboutCompany.textContent = companyValue ? `ב${companyValue}` : '';
        }
      } else {
        aboutRoleRow.hidden = true;
      }
    }

    const aboutLocationRow = document.getElementById('profileAboutLocationRow');
    const aboutLocation = document.getElementById('profileAboutLocation');
    if (aboutLocationRow) {
      const locationValue = App.profile.location?.trim();
      if (locationValue) {
        aboutLocationRow.hidden = false;
        if (aboutLocation) {
          aboutLocation.textContent = locationValue;
        }
      } else {
        aboutLocationRow.hidden = true;
      }
    }

    const aboutWebsiteRow = document.getElementById('profileAboutWebsiteRow');
    const aboutWebsite = document.getElementById('profileAboutWebsite');
    const websiteValue = App.profile.website?.trim();
    if (aboutWebsiteRow) {
      if (websiteValue) {
        aboutWebsiteRow.hidden = false;
        if (aboutWebsite) {
          aboutWebsite.href = websiteValue;
          const label = websiteValue.replace(/^https?:\/\//i, '');
          aboutWebsite.textContent = label;
        }
      } else {
        aboutWebsiteRow.hidden = true;
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

  function applyMetadataToProfile(metadata, sourceLabel = 'metadata', eventTimestamp = 0) {
    if (!metadata || typeof metadata !== 'object') {
      return false;
    }

    // חלק פרופיל (profile.js) – שמירת timestamp של העדכון
    if (eventTimestamp > 0) {
      App.profile.lastUpdateTimestamp = eventTimestamp;
    }

    const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
    const about = typeof metadata.about === 'string' ? metadata.about.trim() : '';
    const headline = typeof metadata.profile_headline === 'string' ? metadata.profile_headline.trim() : '';
    const role = typeof metadata.profile_role === 'string' ? metadata.profile_role.trim() : '';
    const company = typeof metadata.profile_company === 'string' ? metadata.profile_company.trim() : '';
    const location = typeof metadata.profile_location === 'string' ? metadata.profile_location.trim() : '';
    const website = normalizeWebsite(typeof metadata.profile_website === 'string' ? metadata.profile_website.trim() : '');
    const picture = typeof metadata.picture === 'string' ? metadata.picture.trim() : '';
    // חלק תאימות Cover (profile.js) – תומך גם ב-'banner' שנפוץ בלקוחות Nostr
    const cover = typeof metadata.cover === 'string'
      ? metadata.cover.trim()
      : (typeof metadata.banner === 'string' ? metadata.banner.trim() : '');
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

    if (!name && !about && !headline && !role && !company && !location && !website && !picture && !cover && gallery.length === 0) {
      console.log(`Profile metadata: ${sourceLabel} missing relevant fields`, metadata);
      return false;
    }

    if (name) {
      App.profile.name = name;
    }
    if (about) {
      App.profile.bio = about;
    }
    if (headline || metadata.hasOwnProperty('profile_headline')) {
      App.profile.headline = headline;
    }
    if (role || metadata.hasOwnProperty('profile_role')) {
      App.profile.role = role;
    }
    if (company || metadata.hasOwnProperty('profile_company')) {
      App.profile.company = company;
    }
    if (location || metadata.hasOwnProperty('profile_location')) {
      App.profile.location = location;
    }
    if (website || metadata.hasOwnProperty('profile_website')) {
      App.profile.website = website;
    }
    if (picture) {
      App.profile.picture = picture;
    }
    if (cover) {
      App.profile.cover = cover;
    }
    App.profile.gallery = gallery;
    App.profile.avatarInitials = App.getInitials(App.profile.name || '');
    App.profile.dating = Object.assign(
      {
        optIn: false,
        gender: '',
        bio: '',
        age: '',
        location: '',
        interests: [],
      },
      App.profile.dating,
      {
        optIn: datingOptIn,
        gender: typeof metadata.dating_gender === 'string' ? metadata.dating_gender.trim() : '',
        bio: datingBio,
        age: datingAge,
        location: datingLocation,
        interests: datingInterests,
      },
    );

    // חלק פרופיל (profile.js) – שמירה רק של נתונים חיוניים ללא תמונות data: גדולות
    try {
      const lightProfile = {
        name: App.profile.name,
        bio: App.profile.bio,
        headline: App.profile.headline,
        role: App.profile.role,
        company: App.profile.company,
        location: App.profile.location,
        website: App.profile.website,
        // שמירת URLs של תמונות רק אם הן לא data URLs גדולים
        picture: (App.profile.picture && !App.profile.picture.startsWith('data:')) ? App.profile.picture : '',
        cover: (App.profile.cover && !App.profile.cover.startsWith('data:')) ? App.profile.cover : '',
        avatarInitials: App.profile.avatarInitials,
        lastUpdateTimestamp: App.profile.lastUpdateTimestamp,
        // שמירת gallery רק אם אין בו data URLs גדולים
        gallery: Array.isArray(App.profile.gallery) 
          ? App.profile.gallery.filter(url => !url.startsWith('data:') || url.length < 50000) 
          : [],
        dating: App.profile.dating
          ? {
              optIn: Boolean(App.profile.dating.optIn),
              gender: App.profile.dating.gender || '',
              bio: App.profile.dating.bio || '',
              age: App.profile.dating.age || '',
              location: App.profile.dating.location || '',
              interests: Array.isArray(App.profile.dating.interests) ? [...App.profile.dating.interests] : [],
            }
          : { optIn: false, gender: '', bio: '', age: '', location: '', interests: [] },
      };
      window.localStorage.setItem('nostr_profile', JSON.stringify(lightProfile));
    } catch (err) {
      console.warn('Profile metadata: failed caching profile locally', err);
      // ניסיון נוסף עם נתונים מינימליים בלבד
      try {
        const minimalProfile = {
          name: App.profile.name,
          bio: App.profile.bio,
          avatarInitials: App.profile.avatarInitials,
          lastUpdateTimestamp: App.profile.lastUpdateTimestamp,
        };
        window.localStorage.setItem('nostr_profile', JSON.stringify(minimalProfile));
      } catch (e) {
        console.error('Profile metadata: even minimal profile save failed', e);
      }
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
              gender: App.profile.dating.gender || '',
              bio: App.profile.dating.bio || '',
              age: App.profile.dating.age || '',
              location: App.profile.dating.location || '',
              interests: Array.isArray(App.profile.dating.interests) ? [...App.profile.dating.interests] : [],
            }
          : { optIn: false, gender: '', bio: '', age: '', location: '', interests: [] },
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
      profile_headline: App.profile.headline,
      profile_role: App.profile.role,
      profile_company: App.profile.company,
      profile_location: App.profile.location,
      profile_website: App.profile.website,
      picture: App.profile.picture,
      cover: App.profile.cover,
      // חלק תאימות Cover (profile.js) – מפרסם גם banner עבור לקוחות אחרים
      banner: App.profile.cover,
      gallery: Array.isArray(App.profile.gallery) ? App.profile.gallery : [],
      dating_opt_in: Boolean(App.profile.dating?.optIn),
      dating_gender: App.profile.dating?.gender || '',
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
    const headlineInput = document.getElementById('profileHeadlineInput');
    if (headlineInput) headlineInput.value = App.profile.headline || '';
    const roleInput = document.getElementById('profileRoleInput');
    if (roleInput) roleInput.value = App.profile.role || '';
    const companyInput = document.getElementById('profileCompanyInput');
    if (companyInput) companyInput.value = App.profile.company || '';
    const locationInput = document.getElementById('profileLocationInput');
    if (locationInput) locationInput.value = App.profile.location || '';
    const websiteInput = document.getElementById('profileWebsiteInput');
    if (websiteInput) websiteInput.value = App.profile.website || '';
    const imageUrlInput = document.getElementById('profileImageUrlInput');
    if (imageUrlInput) {
      imageUrlInput.value = App.profile.picture || '';
    }
    const coverUrlEl = document.getElementById('profileCoverUrlInput');
    if (coverUrlEl) {
      coverUrlEl.value = App.profile.cover || '';
    }
    const statusEl = document.getElementById('profileStatus');
    if (statusEl) {
      statusEl.textContent = '';
    }
    document.getElementById('profileModal').style.display = 'flex';
  }

  function closeProfileSettings() {
    document.getElementById('profileModal').style.display = 'none';
  }

  async function saveProfileSettings() {
    const name = document.getElementById('profileNameInput').value.trim() || 'משתמש אנונימי';
    const bio = document.getElementById('profileBioInput').value.trim();
    const headlineInput = document.getElementById('profileHeadlineInput');
    const roleInput = document.getElementById('profileRoleInput');
    const companyInput = document.getElementById('profileCompanyInput');
    const locationInput = document.getElementById('profileLocationInput');
    const websiteInput = document.getElementById('profileWebsiteInput');
    const imageUrlInput = document.getElementById('profileImageUrlInput');
    let picture = imageUrlInput ? imageUrlInput.value.trim() : App.profile.picture || '';
    let cover = document.getElementById('profileCoverUrlInput')?.value?.trim?.() || '';
    const gallerySelection = Array.isArray(App.profile.gallery) ? [...App.profile.gallery] : [];

    const fileInput = document.getElementById('profileImageFileInput');
    const coverFileInput = document.getElementById('profileCoverFileInput');
    const status = document.getElementById('profileStatus');

    const applyProfile = (finalPicture) => {
      App.profile.name = name;
      App.profile.bio = bio || 'יוצר מבוזר Nostr';
      App.profile.headline = headlineInput?.value?.trim() || '';
      App.profile.role = roleInput?.value?.trim() || '';
      App.profile.company = companyInput?.value?.trim() || '';
      App.profile.location = locationInput?.value?.trim() || '';
      App.profile.website = normalizeWebsite(websiteInput?.value || '');
      const resolvedPicture = finalPicture || picture;
      if (
        resolvedPicture &&
        resolvedPicture.startsWith('data:') &&
        resolvedPicture.length > App.MAX_INLINE_PICTURE_LENGTH
      ) {
        if (status) {
          status.textContent = 'תמונת הפרופיל גדולה מדי. העלה קישור חיצוני קצר.';
        }
        return;
      }

      App.profile.picture = resolvedPicture;
      App.profile.cover = cover || App.profile.cover || '';
      App.profile.gallery = gallerySelection;
      App.profile.avatarInitials = App.getInitials(name);

      // חלק פרופיל (profile.js) – שמירה קלה ללא data URLs גדולים
      try {
        const lightProfile = {
          name: App.profile.name,
          bio: App.profile.bio,
          headline: App.profile.headline,
          role: App.profile.role,
          company: App.profile.company,
          location: App.profile.location,
          website: App.profile.website,
          picture: (App.profile.picture && !App.profile.picture.startsWith('data:')) ? App.profile.picture : '',
          cover: (App.profile.cover && !App.profile.cover.startsWith('data:')) ? App.profile.cover : '',
          avatarInitials: App.profile.avatarInitials,
          lastUpdateTimestamp: App.profile.lastUpdateTimestamp,
        };
        window.localStorage.setItem('nostr_profile', JSON.stringify(lightProfile));
      } catch (e) {
        console.error('Failed to save profile to local storage', e);
      }
      renderProfile();
      closeProfileSettings();
      const normalizedPubkey = typeof App.publicKey === 'string' ? App.publicKey.toLowerCase() : 'self';
      // חלק פרופיל (profile.js) – שמירת timestamp של העדכון המקומי
      App.profile.lastUpdateTimestamp = Math.floor(Date.now() / 1000);
      const profileData = {
        name: App.profile.name,
        bio: App.profile.bio,
        picture: App.profile.picture,
        cover: App.profile.cover,
        initials: App.profile.avatarInitials,
        gallery: Array.isArray(App.profile.gallery) ? [...App.profile.gallery] : [],
      };
      // עדכון כל הוריאציות של ה-pubkey
      App.profileCache.set(normalizedPubkey, profileData);
      App.profileCache.set(App.publicKey || 'self', profileData);
      if (App.feedAuthorProfiles instanceof Map) {
        App.feedAuthorProfiles.set(normalizedPubkey, profileData);
        App.feedAuthorProfiles.set(App.publicKey || 'self', profileData);
      }
      if (App.authorProfiles instanceof Map) {
        App.authorProfiles.set(normalizedPubkey, profileData);
        App.authorProfiles.set(App.publicKey || 'self', profileData);
      }
      // חלק פרופיל (profile.js) – מעדכן את כל הפוסטים בפיד עם השם והתמונה החדשים
      if (typeof App.updateRenderedAuthorProfile === 'function') {
        App.updateRenderedAuthorProfile(normalizedPubkey, {
          name: App.profile.name,
          bio: App.profile.bio,
          picture: App.profile.picture,
          initials: App.profile.avatarInitials,
        });
      }
      publishProfileMetadata();
    };

    if (fileInput && fileInput.files && fileInput.files[0]) {
      try {
        // חלק תמונת פרופיל (profile.js) – עיבוד באיכות גבוהה כמו תמונת נושא להכרויות
        const resized = await App.resizeImageToDataUrl(fileInput.files[0], 512, 512, 0.85);
        picture = resized;
        applyProfile(picture);
      } catch (e) {
        console.error('Failed to resize profile image', e);
        if (status) {
          status.textContent = 'שגיאה בעיבוד התמונה. נסה קובץ אחר.';
        }
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

      // חלק פרופיל (profile.js) – בדיקת timestamp למניעת דריסת שינויים חדשים בנתונים ישנים
      const lastLocalUpdate = App.profile.lastUpdateTimestamp || 0;
      const eventTimestamp = event.created_at || 0;
      if (lastLocalUpdate > eventTimestamp) {
        console.log('Profile metadata: skipping older relay data', { local: lastLocalUpdate, relay: eventTimestamp });
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(event.content);
      } catch (err) {
        console.warn('Failed to parse own profile metadata', err);
        return;
      }
      if (applyMetadataToProfile(parsed, 'initial load', eventTimestamp)) {
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
        // חלק פרופיל (profile.js) – בדיקת timestamp למניעת דריסת שינויים חדשים בנתונים ישנים
        const lastLocalUpdate = App.profile.lastUpdateTimestamp || 0;
        const eventTimestamp = event.created_at || 0;
        if (lastLocalUpdate > eventTimestamp) {
          console.log('Profile metadata: skipping older subscription data', { local: lastLocalUpdate, relay: eventTimestamp });
          return;
        }
        try {
          const parsed = JSON.parse(event.content);
          if (applyMetadataToProfile(parsed, 'subscription', eventTimestamp)) {
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
    attachClicks(['profileEditButton'], () => {
      if (typeof window.openProfileSettings === 'function') {
        window.openProfileSettings();
      }
    });

    attachClicks(['profileSaveButton'], () => {
      if (typeof window.saveProfileSettings === 'function') {
        window.saveProfileSettings();
      }
    });

    attachClicks(['profileCancelButton'], () => {
      if (typeof window.closeProfileSettings === 'function') {
        window.closeProfileSettings();
      }
    });

    attachClicks(['profileHomeButton', 'profileTopHomeButton'], () => {
      if (App.cameFromVideos && typeof window.history?.back === 'function') {
        window.history.back();
        return;
      }
      window.location.href = 'index.html';
    });

    attachClicks(['profileTopRefreshButton'], () => {
      window.location.reload();
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

  // חלק טאבים מובייל (profile.js) – ניהול ניווט אקורדיון כאשר המסך צר
  function activateMobileTab(targetKey) {
    const tabs = document.querySelectorAll('.profile-mobile-tab');
    const panels = document.querySelectorAll('[data-profile-panel]');
    tabs.forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.profileTab === targetKey);
    });
    panels.forEach((panel) => {
      const panelKey = panel.getAttribute('data-profile-panel');
      if (panelKey === targetKey || (targetKey === 'about' && panelKey === 'about')) {
        panel.classList.add('is-active');
      } else if (panelKey === 'posts' && targetKey === 'posts') {
        panel.classList.add('is-active');
      } else {
        panel.classList.remove('is-active');
      }
    });
  }

  function bindMobileTabs() {
    const tabs = document.querySelectorAll('.profile-mobile-tab');
    if (!tabs.length) {
      return;
    }
    tabs.forEach((tab) => {
      if (tab.dataset.listenerAttached === 'true') {
        return;
      }
      tab.dataset.listenerAttached = 'true';
      tab.addEventListener('click', () => {
        const key = tab.getAttribute('data-profile-tab') || 'about';
        activateMobileTab(key);
      });
    });
    activateMobileTab('about');
  }

  bindMobileTabs();

  // חלק מחיקת תמונות (profile.js) – לוגיקה למחיקת תמונת פרופיל ותמונת נושא והחלת השינוי בממשק ובמטא-דאטה
  function deleteProfileImage() {
    const status = document.getElementById('profileStatus');
    const urlInput = document.getElementById('profileImageUrlInput');
    const fileInput = document.getElementById('profileImageFileInput');
    App.profile.picture = '';
    if (urlInput) urlInput.value = '';
    if (fileInput) fileInput.value = '';
    try {
      window.localStorage.setItem('nostr_profile', JSON.stringify(App.profile));
    } catch (e) {}
    if (App.profileCache instanceof Map) {
      App.profileCache.set(App.publicKey || 'self', {
        name: App.profile.name,
        bio: App.profile.bio,
        picture: '',
        cover: App.profile.cover,
        initials: App.profile.avatarInitials,
        gallery: Array.isArray(App.profile.gallery) ? [...App.profile.gallery] : [],
      });
    }
    renderProfile();
    publishProfileMetadata();
    if (status) {
      status.textContent = 'תמונת הפרופיל נמחקה.';
      window.setTimeout(() => {
        if (status.textContent.includes('תמונת הפרופיל')) status.textContent = '';
      }, 3000);
    }
  }

  function deleteProfileCover() {
    const status = document.getElementById('profileStatus');
    const urlInput = document.getElementById('profileCoverUrlInput');
    const fileInput = document.getElementById('profileCoverFileInput');
    App.profile.cover = '';
    if (urlInput) urlInput.value = '';
    if (fileInput) fileInput.value = '';
    try {
      window.localStorage.setItem('nostr_profile', JSON.stringify(App.profile));
    } catch (e) {}
    if (App.profileCache instanceof Map) {
      App.profileCache.set(App.publicKey || 'self', {
        name: App.profile.name,
        bio: App.profile.bio,
        picture: App.profile.picture,
        cover: '',
        initials: App.profile.avatarInitials,
        gallery: Array.isArray(App.profile.gallery) ? [...App.profile.gallery] : [],
      });
    }
    // ניקוי מיידי של הבאנר במסך
    const coverBanner = document.getElementById('profilePageCoverBanner');
    if (coverBanner) {
      coverBanner.style.background = '';
      coverBanner.style.backgroundImage = '';
    }
    renderProfile();
    publishProfileMetadata();
    if (status) {
      status.textContent = 'תמונת הנושא נמחקה.';
      window.setTimeout(() => {
        if (status.textContent.includes('תמונת הנושא')) status.textContent = '';
      }, 3000);
    }
  }

  function bindDeleteButtons() {
    const imgDel = document.getElementById('profileImageDeleteButton');
    const coverDel = document.getElementById('profileCoverDeleteButton');
    const homeImgDel = document.getElementById('homeProfileImageDeleteButton');
    if (imgDel && imgDel.dataset.listenerAttached !== 'true') {
      imgDel.dataset.listenerAttached = 'true';
      imgDel.addEventListener('click', deleteProfileImage);
    }
    if (coverDel && coverDel.dataset.listenerAttached !== 'true') {
      coverDel.dataset.listenerAttached = 'true';
      coverDel.addEventListener('click', deleteProfileCover);
    }
    if (homeImgDel && homeImgDel.dataset.listenerAttached !== 'true') {
      homeImgDel.dataset.listenerAttached = 'true';
      homeImgDel.addEventListener('click', deleteProfileImage);
    }
  }

  // קישור מאזינים לכפתורי מחיקה עם הטעינה
  bindDeleteButtons();

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
