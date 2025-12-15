(function initAuth(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // הפניות לאלמנטים החדשים
  const entryPanel = document.getElementById('authEntryPanel');
  const importCard = document.querySelector('.auth-card--import');
  const createCard = document.getElementById('authCreatePanel');
  const headerMenuToggle = document.getElementById('siteHeaderMenuToggle');
  const headerNav = document.getElementById('siteHeaderNav');
  const infoPanelsContainer = document.getElementById('authInfoPanels');
  const infoPanelButtons = Array.from(document.querySelectorAll('[data-info-target]'));
  const infoPanelCloseButtons = Array.from(document.querySelectorAll('[data-info-close]'));
  const promoOverlay = document.getElementById('authPromo');
  const entryLoginButton = document.getElementById('authEntryLoginButton');
  const entryRegisterButton = document.getElementById('authEntryRegisterButton');
  const cpanelToggleButton = document.getElementById('authCpanelToggle');
  const cpanelPanel = document.getElementById('authCpanelPanel');
  const cpanelModal = document.getElementById('authCpanelModal');
  const cpanelPasswordInput = document.getElementById('authCpanelPasswordInput');
  const cpanelPasswordError = document.getElementById('authCpanelPasswordError');
  const cpanelPasswordSubmit = document.getElementById('authCpanelPasswordSubmit');
  const cpanelPasswordCancel = document.getElementById('authCpanelPasswordCancel');
  const goCreateButton = document.getElementById('authGoCreateButton');
  const backToEntryFromLogin = document.getElementById('authBackToEntryFromLogin');
  const backToEntryButton = document.getElementById('authBackToEntry');
  const shareWhatsappButton = document.getElementById('authShareWhatsappButton');
  const generateButton = document.getElementById('authGenerateButton');
  // חלק זרימת אימייל (auth.js) – שליטה ברכיבי בקשת המפתח
  const sendEmailButton = document.getElementById('authSendEmailButton');
  const emailInput = document.getElementById('authEmailInput');
  const flowEmailStep = document.getElementById('authFlowEmailStep');
  const flowProfileStep = document.getElementById('authFlowProfileStep');
  const flowKeyStep = document.getElementById('authFlowKeyStep');
  // חלק פרטי פרופיל (auth.js) – רכיבים רלוונטיים לזרימה מצומצמת
  const profileNameInput = document.getElementById('authProfileNameInput');
  const profileBackButton = document.getElementById('authProfileBackButton');
  const profileNextButton = document.getElementById('authProfileNextButton');
  const avatarDropZone = document.getElementById('authAvatarDropZone');
  const avatarFileInput = document.getElementById('authAvatarFileInput');
  const avatarPlaceholder = document.getElementById('authAvatarPlaceholder');
  const avatarPreview = document.getElementById('authAvatarPreview');
  const avatarUrlInput = null;
  const keyBackButton = document.getElementById('authKeyBackButton');
  const copyCreateButton = document.getElementById('authCopyCreateButton');
  const downloadCreateButton = document.getElementById('authDownloadCreateButton');
  const continueButton = document.getElementById('authContinueButton');
  const createTextarea = document.getElementById('authCreateKey');
  const createConfirm = document.getElementById('authCreateConfirm');
  const createStatus = document.getElementById('authCreateStatus');
  const importTextarea = document.getElementById('authImportInput');
  const importButton = document.getElementById('authImportButton');
  const importStatus = document.getElementById('authImportStatus');
  const { SimplePool } = window.NostrTools || {};

  let registryPool = null;

  // חלק זרימת אימייל (auth.js) – מצב מפתח שהודבק ואומת
  let preparedPrivateKey = '';
  let emailRequestInFlight = false;
  let emailHashForRegistry = '';
  let uploadedAvatarDataUrl = '';

  function showPanel(panel) {
    const panels = [entryPanel, importCard, createCard];
    panels.forEach((section) => {
      if (!section) return;
      section.hidden = true;
      section.classList.remove('is-active');
    });

    let target = null;
    if (panel === 'entry') {
      target = entryPanel;
    } else if (panel === 'import') {
      target = importCard;
    } else if (panel === 'create') {
      target = createCard;
    }

    if (!target) {
      return;
    }

    target.hidden = false;
    target.classList.add('is-active');

    if (panel !== 'create') {
      if (createTextarea) {
        createTextarea.value = '';
      }
      if (createConfirm) {
        createConfirm.checked = false;
        if (continueButton) continueButton.disabled = true;
      }
      if (copyCreateButton) copyCreateButton.disabled = true;
      if (downloadCreateButton) downloadCreateButton.disabled = true;
      if (shareWhatsappButton) shareWhatsappButton.disabled = true;
      setCreateStatus('');
    }

    if (panel !== 'import' && importTextarea) {
      importTextarea.value = '';
      setImportStatus('');
    }
  }

  const CPANEL_ACCESS_CODE = '2048';
  let cpanelUnlocked = false;

  function openCpanelModal() {
    if (!cpanelModal) {
      return;
    }
    cpanelModal.hidden = false;
    cpanelModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    if (cpanelPasswordError) {
      cpanelPasswordError.hidden = true;
    }
    if (cpanelPasswordInput) {
      cpanelPasswordInput.value = '';
      cpanelPasswordInput.focus();
    }
  }

  function closeCpanelModal() {
    if (!cpanelModal) {
      return;
    }
    cpanelModal.hidden = true;
    cpanelModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  function handleCpanelPasswordSubmit() {
    if (!cpanelPasswordInput) {
      return;
    }
    const value = (cpanelPasswordInput.value || '').trim();
    if (value === CPANEL_ACCESS_CODE) {
      cpanelUnlocked = true;
      closeCpanelModal();
      toggleCpanel(true);
      return;
    }
    if (cpanelPasswordError) {
      cpanelPasswordError.hidden = false;
    }
    cpanelPasswordInput.focus();
    cpanelPasswordInput.select();
  }

  function bindCpanelModalEvents() {
    if (!cpanelModal) {
      return;
    }
    cpanelPasswordSubmit?.addEventListener('click', handleCpanelPasswordSubmit);
    cpanelPasswordCancel?.addEventListener('click', () => {
      closeCpanelModal();
    });
    cpanelPasswordInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleCpanelPasswordSubmit();
      }
      if (event.key === 'Escape') {
        closeCpanelModal();
      }
    });
    cpanelModal.addEventListener('click', (event) => {
      if (event.target === cpanelModal || event.target?.dataset?.cpanelDismiss !== undefined) {
        closeCpanelModal();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !cpanelModal.hidden && !cpanelUnlocked) {
        closeCpanelModal();
      }
    });
  }

  function bindCpanelToggle() {
    if (!cpanelToggleButton) {
      return;
    }
    cpanelToggleButton.setAttribute('aria-controls', 'authCpanelPanel');
    cpanelToggleButton.setAttribute('aria-expanded', 'false');
    cpanelToggleButton.addEventListener('click', () => {
      toggleCpanel();
    });
  }

  function toggleHeaderNav(force) {
    if (!headerNav || !headerMenuToggle) {
      return;
    }
    const isOpen = typeof force === 'boolean' ? force : !headerNav.classList.contains('is-open');
    headerNav.classList.toggle('is-open', isOpen);
    headerNav.setAttribute('aria-hidden', String(!isOpen));
    headerMenuToggle.setAttribute('aria-expanded', String(isOpen));
  }

  function toggleCpanel(force) {
    if (!cpanelToggleButton || !cpanelPanel) {
      return;
    }
    if (!cpanelUnlocked) {
      openCpanelModal();
      return;
    }
    const shouldOpen = typeof force === 'boolean' ? force : cpanelPanel.hasAttribute('hidden');
    if (shouldOpen) {
      cpanelPanel.hidden = false;
      cpanelPanel.classList.add('is-open');
      cpanelToggleButton?.classList.add('is-active');
      cpanelToggleButton?.setAttribute('aria-expanded', 'true');
    } else {
      cpanelPanel.hidden = true;
      cpanelPanel.classList.remove('is-open');
      cpanelToggleButton?.classList.remove('is-active');
      cpanelToggleButton?.setAttribute('aria-expanded', 'false');
    }
  }

  function bindCpanelToggle() {
    if (!cpanelToggleButton) {
      return;
    }
    cpanelToggleButton.setAttribute('aria-controls', 'authCpanelPanel');
    cpanelToggleButton.setAttribute('aria-expanded', 'false');
    cpanelToggleButton.addEventListener('click', () => {
      toggleCpanel();
    });
  }

  function hideAllInfoPanels() {
    if (!infoPanelsContainer) {
      return;
    }
    const panels = Array.from(infoPanelsContainer.querySelectorAll('.auth-info-panel'));
    panels.forEach((panel) => {
      panel.hidden = true;
      panel.classList.remove('is-active');
    });
  }

  function openInfoPanel(panelId) {
    if (!panelId) {
      return;
    }
    const target = document.getElementById(panelId);
    if (!target) {
      return;
    }
    hideAllInfoPanels();
    target.hidden = false;
    target.classList.add('is-active');
  }

  // שכבת פרומו – מציגה מסרים קצרים בעת עליית הדף וכבה בעדינות
  function runPromoOverlay() {
    if (!promoOverlay) {
      return;
    }
    // הצגה
    promoOverlay.hidden = false;
    // העלמה אחרי ~1.6ש׳, עם דהייה 350ms
    setTimeout(() => {
      promoOverlay.classList.add('is-fade');
      setTimeout(() => {
        promoOverlay.hidden = true;
        promoOverlay.classList.remove('is-fade');
      }, 380);
    }, 1600);
  }

  function isProfileReady() {
    const nameValid = Boolean((profileNameInput?.value || '').trim());
    const hasAvatar = Boolean(uploadedAvatarDataUrl);
    if (!profileNameInput && !avatarDropZone) {
      return true;
    }
    return nameValid && hasAvatar;
  }

  function updateProfileNextState() {
    if (profileNextButton) {
      profileNextButton.disabled = !isProfileReady();
    }
  }

  async function handleProfileNext(event) {
    if (event) {
      event.preventDefault();
    }
    if (!isProfileReady()) {
      setCreateStatus('יש להזין שם ולצרף תמונת פרופיל לפני המשך.', 'error');
      return;
    }

    if (profileNextButton) {
      profileNextButton.disabled = true;
    }

    try {
      const privateKeyHex = generatePrivateKeyHex();
      const displayValue = encodeKeyForDisplay(privateKeyHex);
      preparedPrivateKey = privateKeyHex;

      if (emailHashForRegistry) {
        setCreateStatus('רושם את כתובת האימייל בריליי המבוזרים...');
        const publishResult = await publishEmailRegistry(emailHashForRegistry, privateKeyHex);
        if (!publishResult.ok) {
          const reason = publishResult.error === 'missing-signing-key'
            ? 'לא נמצא מפתח חתימה תקף לרישום האימייל.'
            : publishResult.error === 'publish-failed'
              ? 'הרישום המבוזר נכשל. ודאו שהריליי מגיב ונסו שוב.'
              : publishResult.error;
          setCreateStatus(reason || 'הרישום המבוזר נכשל. נסו שוב.', 'error');
          preparedPrivateKey = '';
          if (profileNextButton) {
            updateProfileNextState();
          }
          return;
        }

        const published = await verifyEmailHashPublished(
          emailHashForRegistry,
          publishResult.relays,
          publishResult.pubkey
        );
        if (!published) {
          setCreateStatus('לא הצלחנו לאמת את רישום האימייל בריליי. נסו שוב או בדקו חיבור לריליי.', 'error');
          preparedPrivateKey = '';
          if (profileNextButton) {
            updateProfileNextState();
          }
          return;
        }
      }

      switchToKeyStep();
      if (createTextarea) {
        createTextarea.readOnly = true;
        createTextarea.value = displayValue;
      }
      validateCreateInput();
      setCreateStatus('הקוד האישי שלכם מוכן. שמרו אותו ואשרו את התיבה כדי להמשיך.');
    } catch (err) {
      console.error('Profile step failed', err);
      setCreateStatus(err?.message || 'שגיאה בהמשך התהליך. נסו שוב לאחר רענון.', 'error');
      preparedPrivateKey = '';
      if (profileNextButton) {
        updateProfileNextState();
      }
      return;
    }

    updateProfileNextState();
  }

  function handleAvatarFile(file) {
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      setCreateStatus('ניתן להעלות רק קבצי תמונה.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      if (typeof result === 'string') {
        uploadedAvatarDataUrl = result;
        if (avatarPreview) {
          avatarPreview.src = result;
          avatarPreview.hidden = false;
        }
        if (avatarPlaceholder) {
          avatarPlaceholder.hidden = true;
        }
        updateProfileNextState();
      }
    };
    reader.onerror = (event) => {
      console.error('Avatar file load failed', event);
      setCreateStatus('טעינת הקובץ נכשלה. נסו קובץ אחר.', 'error');
    };
    reader.readAsDataURL(file);
  }

  function wireAvatarDropZone() {
    if (!avatarDropZone) {
      return;
    }
    const stop = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((ev) => {
      avatarDropZone.addEventListener(ev, stop);
    });

    avatarDropZone.addEventListener('dragenter', () => {
      avatarDropZone.classList.add('is-dragging');
    });
    avatarDropZone.addEventListener('dragover', () => {
      avatarDropZone.classList.add('is-dragging');
    });
    avatarDropZone.addEventListener('dragleave', () => {
      avatarDropZone.classList.remove('is-dragging');
    });
    avatarDropZone.addEventListener('drop', (event) => {
      avatarDropZone.classList.remove('is-dragging');
      const file = event.dataTransfer?.files?.[0];
      if (file) {
        handleAvatarFile(file);
      }
    });

    avatarDropZone.addEventListener('click', () => {
      avatarFileInput?.click();
    });
    avatarDropZone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        avatarFileInput?.click();
      }
    });
  }


  function ensureAvatarPlaceholder() {
    if (uploadedAvatarDataUrl) {
      if (avatarPreview) {
        avatarPreview.hidden = false;
        avatarPreview.src = uploadedAvatarDataUrl;
      }
      if (avatarPlaceholder) {
        avatarPlaceholder.hidden = true;
      }
    } else {
      if (avatarPreview) {
        avatarPreview.hidden = true;
        avatarPreview.src = '';
      }
      if (avatarPlaceholder) {
        avatarPlaceholder.hidden = false;
      }
    }
  }

  function sleep(durationMs) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, Math.max(0, durationMs || 0));
    });
  }

  async function verifyEmailHashPublished(emailHash, preferredRelays = [], expectedPubkey) {
    // חלק אימות ריליי (auth.js) – בודק שהאירוע באמת פורסם לפני המשך יצירת המפתח
    if (!emailHash) {
      return false;
    }
    const maxAttempts = 4;
    const delayMs = 450;
    const baseRelays = Array.isArray(App.relayUrls) ? [...App.relayUrls] : [];
    const hintedRelays = Array.isArray(preferredRelays)
      ? preferredRelays.filter((relay) => typeof relay === 'string' && relay.startsWith('wss://'))
      : [];
    const orderedRelays = [...new Set([...hintedRelays, ...baseRelays])];
    const tagKey = App.EMAIL_REGISTRY_HASH_TAG || 'h';
    const filter = {
      kinds: [App.EMAIL_REGISTRY_KIND],
      [`#${tagKey}`]: [emailHash],
      limit: 1,
    };

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const pool = ensureRegistryPool();
      if (orderedRelays.length > 0 && typeof pool.get === 'function') {
        try {
          const result = await pool.get(orderedRelays, filter);
          if (result && (!expectedPubkey || result.pubkey === expectedPubkey)) {
            return true;
          }
        } catch (relayErr) {
          console.warn('Relay get verification failed', relayErr);
        }
      }

      try {
        const exists = await isEmailHashRegistered(emailHash);
        if (exists) {
          return true;
        }
      } catch (err) {
        console.warn('Verification lookup failed', err);
      }

      if (attempt < maxAttempts - 1) {
        await sleep(delayMs);
      }
    }
    return false;
  }

  function setCreateStatus(message = '', tone = 'info') {
    if (!createStatus) {
      console.warn('setCreateStatus called without createStatus element');
      return;
    }
    createStatus.textContent = message;
    createStatus.classList.toggle('is-error', tone === 'error');
  }

  function setImportStatus(message = '', tone = 'info') {
    if (!importStatus) {
      console.warn('setImportStatus called without importStatus element');
      return;
    }
    importStatus.textContent = message;
    importStatus.classList.toggle('is-error', tone === 'error');
  }

  function resetCreateFlow() {
    // חלק זרימת אימייל (auth.js) – מאפס את מצב יצירת הפרופיל בכל כניסה למסך
    preparedPrivateKey = '';
    emailRequestInFlight = false;
    if (flowEmailStep) flowEmailStep.hidden = false;
    if (flowProfileStep) flowProfileStep.hidden = true;
    if (flowKeyStep) flowKeyStep.hidden = true;
    if (sendEmailButton) {
      sendEmailButton.disabled = false;
      sendEmailButton.classList.remove('is-loading');
    }
    if (emailInput) {
      emailInput.disabled = false;
      emailInput.value = '';
    }
    if (createTextarea) {
      createTextarea.value = '';
      createTextarea.readOnly = true;
    }
    if (profileNameInput) profileNameInput.value = '';
    if (avatarFileInput) avatarFileInput.value = '';
    if (avatarPreview) {
      avatarPreview.src = '';
      avatarPreview.hidden = true;
    }
    if (avatarPlaceholder) avatarPlaceholder.hidden = false;
    uploadedAvatarDataUrl = '';
    emailHashForRegistry = '';
    if (createConfirm) createConfirm.checked = false;
    if (continueButton) continueButton.disabled = true;
    if (copyCreateButton) copyCreateButton.disabled = true;
    if (downloadCreateButton) downloadCreateButton.disabled = true;
    if (shareWhatsappButton) shareWhatsappButton.disabled = true;
    if (generateButton) generateButton.disabled = false;
    setCreateStatus('');
    ensureAvatarPlaceholder();
    updateProfileNextState();
  }

  function switchToProfileStep() {
    if (!flowProfileStep) {
      switchToKeyStep();
      return;
    }
    if (flowEmailStep) flowEmailStep.hidden = true;
    flowProfileStep.hidden = false;
    if (profileNameInput) {
      profileNameInput.focus();
    }
    ensureAvatarPlaceholder();
    updateProfileNextState();
  }

  function switchToKeyStep() {
    // שלב קוד מחליף את המסך – אין גלילה: מחביאים אימייל ופרופיל (אם יש) ומציגים רק את הקוד
    if (flowEmailStep) flowEmailStep.hidden = true;
    if (flowProfileStep) flowProfileStep.hidden = true;
    if (flowKeyStep) flowKeyStep.hidden = false;
    if (createTextarea) {
      createTextarea.focus();
    }
  }

  function switchBackToEmailStep() {
    if (flowEmailStep) flowEmailStep.hidden = false;
    if (flowProfileStep) flowProfileStep.hidden = true;
    if (flowKeyStep) flowKeyStep.hidden = true;
    emailHashForRegistry = '';
    uploadedAvatarDataUrl = '';
    if (avatarFileInput) avatarFileInput.value = '';
    ensureAvatarPlaceholder();
    updateProfileNextState();
    if (sendEmailButton) sendEmailButton.disabled = false;
    if (emailInput) {
      emailInput.disabled = false;
      emailInput.focus();
    }
    preparedPrivateKey = '';
    if (createTextarea) createTextarea.value = '';
    if (createConfirm) {
      createConfirm.checked = false;
      if (continueButton) continueButton.disabled = true;
    }
    if (copyCreateButton) copyCreateButton.disabled = true;
    if (downloadCreateButton) downloadCreateButton.disabled = true;
    if (shareWhatsappButton) shareWhatsappButton.disabled = true;
    setCreateStatus('ניתן לעדכן את כתובת האימייל לפני המשך.');
  }

  function switchBackToProfileStep() {
    // כפתור חזרה חכם: אם אין שלב פרופיל, חוזרים ישירות למסך אימייל, אחרת חוזרים לפרופיל
    if (!flowProfileStep) {
      switchBackToEmailStep();
      return;
    }
    if (flowKeyStep) flowKeyStep.hidden = true;
    flowProfileStep.hidden = false;
    preparedPrivateKey = '';
    if (createTextarea) createTextarea.value = '';
    if (createConfirm) {
      createConfirm.checked = false;
      if (continueButton) continueButton.disabled = true;
    }
    if (copyCreateButton) copyCreateButton.disabled = true;
    if (downloadCreateButton) downloadCreateButton.disabled = true;
    if (shareWhatsappButton) shareWhatsappButton.disabled = true;
    ensureAvatarPlaceholder();
    updateProfileNextState();
    setCreateStatus('רוצים לשנות את הפרטים לפני שמירת הקוד? אפשר לחזור שלב אחד אחורה.');
  }

  function ensureRegistryPool() {
    if (registryPool) {
      return registryPool;
    }
    if (!SimplePool) {
      throw new Error('SimplePool unavailable – ודאו ש-nostr-tools נטען כראוי.');
    }
    if (!Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      throw new Error('No relay URLs configured עבור רישום אימיילים.');
    }
    registryPool = new SimplePool();
    return registryPool;
  }

  function arrayBufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async function computeEmailHash(email) {
    const encoder = new TextEncoder();
    const data = encoder.encode(email);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    return arrayBufferToHex(digest);
  }

  async function isEmailHashRegistered(emailHash) {
    const pool = ensureRegistryPool();
    const tagKey = App.EMAIL_REGISTRY_HASH_TAG || 'h';
    const filters = [
      {
        kinds: [App.EMAIL_REGISTRY_KIND],
        [`#${tagKey}`]: [emailHash],
        limit: 1,
      },
    ];
    try {
      if (typeof pool.list === 'function') {
        const events = await pool.list(App.relayUrls, filters);
        if (Array.isArray(events) && events.length > 0) {
          return true;
        }
      } else if (typeof pool.listMany === 'function') {
        const events = await pool.listMany(App.relayUrls, filters);
        if (Array.isArray(events) && events.length > 0) {
          return true;
        }
      } else if (typeof pool.get === 'function') {
        const event = await pool.get(App.relayUrls, filters[0]);
        if (event) {
          return true;
        }
      }
    } catch (err) {
      console.warn('Email hash lookup failed', err);
    }
    return false;
  }

  async function publishEmailRegistry(emailHash, signingKeyHex) {
    const privateKeyHex = (signingKeyHex || App.identityAdminPrivateKey || '').trim().toLowerCase();
    if (!privateKeyHex || privateKeyHex.length !== 64) {
      return { ok: false, error: 'missing-signing-key' };
    }
    if (typeof App.finalizeEvent !== 'function') {
      return { ok: false, error: 'missing-finalize' };
    }
    const pool = ensureRegistryPool();
    const createdAt = Math.floor(Date.now() / 1000);
    const tags = [
      ['t', App.EMAIL_REGISTRY_TAG],
      [App.EMAIL_REGISTRY_HASH_TAG, emailHash],
    ];
    if (App.NETWORK_TAG) {
      tags.push(['t', App.NETWORK_TAG]);
    }
    const draft = {
      kind: App.EMAIL_REGISTRY_KIND,
      created_at: createdAt,
      tags,
      content: JSON.stringify({ hash: emailHash, issued_at: createdAt }),
    };
    const event = App.finalizeEvent(draft, privateKeyHex);
    const relays = Array.isArray(App.relayUrls) && App.relayUrls.length > 0 ? [...App.relayUrls] : [];
    try {
      await pool.publish(relays, event);
      return { ok: true, relays, pubkey: event.pubkey };
    } catch (err) {
      console.warn('Email hash publish failed', err);
      return { ok: false, error: err?.message || 'publish-failed' };
    }
  }

  function generatePrivateKeyHex() {
    let bytes;
    if (typeof App.generateSecretKey === 'function') {
      bytes = App.generateSecretKey();
    } else if (window.NostrTools?.generateSecretKey) {
      bytes = window.NostrTools.generateSecretKey();
    }
    if (!bytes) {
      throw new Error('generateSecretKey unavailable');
    }
    const hex = App.bytesToHex
      ? App.bytesToHex(bytes)
      : Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
    return hex.toLowerCase();
  }

  function encodeKeyForDisplay(privateKeyHex) {
    if (typeof App.encodePrivateKey === 'function') {
      try {
        return App.encodePrivateKey(privateKeyHex) || privateKeyHex;
      } catch (err) {
        console.warn('encodePrivateKey failed', err);
      }
    }
    return privateKeyHex;
  }

  function isValidEmail(value) {
    // חלק זרימת אימייל (auth.js) – בדיקת אימייל בסיסית לפני שליחה לשירות החיצוני
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function extractPrivateKey(value) {
    // חלק זרימת אימייל (auth.js) – מפענח את המפתח שהודבק לטקסטאירה ומחזיר Hex תקני
    if (!value) {
      return '';
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return '';
    }
    if (typeof App.decodePrivateKey === 'function') {
      const decoded = App.decodePrivateKey(trimmed);
      if (decoded) {
        return decoded.toLowerCase();
      }
    }
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    return '';
  }

  async function handleSendEmail(event) {
    // חלק זרימת אימייל (auth.js) – מפיק מפתח מיידי ומוודא שהאימייל לא שימש בעבר
    if (event) {
      event.preventDefault();
    }
    if (emailRequestInFlight) {
      return;
    }
    const email = (emailInput?.value || '').trim().toLowerCase();
    if (!email) {
      setCreateStatus('יש להזין כתובת אימייל לפני קבלת המפתח.', 'error');
      return;
    }
    if (!isValidEmail(email)) {
      setCreateStatus('כתובת האימייל אינה תקינה. בדקו שלא נפלה טעות הקלדה.', 'error');
      return;
    }

    emailRequestInFlight = true;
    setCreateStatus('בודק אם כתובת האימייל כבר רשומה ברשת...');
    if (sendEmailButton) sendEmailButton.disabled = true;
    if (emailInput) emailInput.disabled = true;

    try {
      const emailHash = await computeEmailHash(email);
      const alreadyUsed = await isEmailHashRegistered(emailHash);
      if (alreadyUsed) {
        setCreateStatus('הכתובת הזו כבר קיבלה קוד בעבר. נסו להשתמש בו או צרו קשר עם התמיכה לקבלת סיוע.', 'error');
        if (sendEmailButton) sendEmailButton.disabled = false;
        if (emailInput) emailInput.disabled = false;
        return;
      }
      emailHashForRegistry = emailHash;
      switchToProfileStep();
      if (flowProfileStep) {
        setCreateStatus('המשיכו לשלב הפרופיל כדי להשלים את ההרשמה.');
      }
    } catch (err) {
      console.error('Email-based key generation failed', err);
      setCreateStatus('משהו לא עבד בשליחה. נסו שוב בעוד רגע או רעננו את הדף.', 'error');
      if (sendEmailButton) sendEmailButton.disabled = false;
      if (emailInput) emailInput.disabled = false;
      resetCreateFlow();
    } finally {
      emailRequestInFlight = false;
    }
  }

  function validateCreateInput() {
    // חלק זרימת אימייל (auth.js) – מאמת את המפתח שהודבק ומכין אותו לשמירה
    if (!createTextarea) {
      return;
    }
    const rawValue = createTextarea.value;
    if (copyCreateButton) copyCreateButton.disabled = true;
    if (downloadCreateButton) downloadCreateButton.disabled = true;
    if (shareWhatsappButton) shareWhatsappButton.disabled = true;

    const normalized = extractPrivateKey(rawValue);
    if (!normalized) {
      preparedPrivateKey = '';
      if (rawValue.trim()) {
        setCreateStatus('לא זוהה קוד תקין. ודאו שהעתקתם את הכול במדויק.', 'error');
      } else {
        setCreateStatus('לחצו "קבלו את הקוד שלי" כדי להציג אותו כאן.');
      }
      if (continueButton) continueButton.disabled = true;
      return;
    }

    preparedPrivateKey = normalized;
    if (typeof App.encodePrivateKey === 'function') {
      try {
        const encoded = App.encodePrivateKey(preparedPrivateKey);
        if (encoded) {
          createTextarea.value = encoded;
        }
      } catch (err) {
        console.warn('Encode private key failed', err);
      }
    }

    if (copyCreateButton) copyCreateButton.disabled = false;
    if (downloadCreateButton) downloadCreateButton.disabled = false;
    if (shareWhatsappButton) shareWhatsappButton.disabled = false;
    setCreateStatus('הקוד אומת. שמרו אותו ואשרו ששמרתם כדי להמשיך.');
    if (continueButton) {
      continueButton.disabled = !canContinue();
    }
  }

  async function copyCreateKey() {
    try {
      await navigator.clipboard.writeText(createTextarea.value);
      setCreateStatus('הקוד הועתק ללוח הזיכרון.');
    } catch (err) {
      console.error('Copy create key failed', err);
      setCreateStatus('לא הצלחתי להעתיק ללוח. נסו שוב או העתיקו ידנית.', 'error');
    }
  }

  function downloadCreateKey() {
    const value = createTextarea.value.trim();
    if (!value) {
      setCreateStatus('אין קוד לשמור.', 'error');
      return;
    }
    const blob = new Blob([value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'nostr-private-key.txt';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setCreateStatus('קובץ הגיבוי נשמר אצלכם.');
  }

  function canContinue() {
    return Boolean(preparedPrivateKey) && createConfirm.checked;
  }

  function handleContinue() {
    if (!canContinue()) {
      setCreateStatus('יש לשמור את הקוד ולאשר שסימנתם זאת.', 'error');
      return;
    }
    try {
      if (!preparedPrivateKey) {
        throw new Error('Missing prepared key');
      }
      window.localStorage.setItem('nostr_private_key', preparedPrivateKey);
      App.privateKey = preparedPrivateKey;
      if (typeof App.ensureKeys === 'function') {
        const { publicKey } = App.ensureKeys() || {};
        if (publicKey) {
          App.publicKey = publicKey;
        }
      }

      const currentProfile = App.profile || {};
      const selectedName = (profileNameInput?.value || '').trim();
      const chosenAvatar = uploadedAvatarDataUrl || currentProfile.picture || '';
      const nextProfile = {
        ...currentProfile,
        name: selectedName || currentProfile.name || 'משתמש אנונימי',
        picture: chosenAvatar,
      };
      App.profile = nextProfile;
      window.localStorage.setItem('nostr_profile', JSON.stringify(nextProfile));

      setCreateStatus('מתחברים לרשת...');
      setTimeout(() => {
        // חלק Redirect (auth.js) – חזרה לעמוד שממנו הגיע המשתמש או לפיד הראשי | HYPER CORE TECH
        try {
          const params = new URLSearchParams(window.location.search);
          const redirect = params.get('redirect');
          if (redirect) {
            window.location.href = decodeURIComponent(redirect);
          } else {
            window.location.replace('videos.html');
          }
        } catch (e) {
          window.location.replace('videos.html');
        }
      }, 350);
    } catch (err) {
      console.error('Handle continue failed', err);
      setCreateStatus('לא הצלחנו להשלים את הכניסה. נסו שוב לאחר רענון.', 'error');
    }
  }

  function shareWhatsapp() {
    if (!shareWhatsappButton) {
      return;
    }
    const value = createTextarea.value.trim();
    if (!value) {
      setCreateStatus('אין קוד לשלוח.', 'error');
      return;
    }
    const message = encodeURIComponent(`הקוד האישי שלי ל-SphereOne Social:\n${value}`);
    const url = `https://wa.me/?text=${message}`;
    window.open(url, '_blank', 'noopener');
    setCreateStatus('פתחתי עבורך וואטסאפ לשיתוף הקוד.');
  }

  async function handleGenerateKey(event) {
    // חלק יצירת מפתח (auth.js) – מפיק מפתח חדש ומכין את הממשק לשמירה ושיתוף
    if (event) {
      event.preventDefault();
    }
    if (!createTextarea) {
      setCreateStatus('לא נמצא שדה להצגת המפתח החדש.', 'error');
      return;
    }

    try {
      if (generateButton) {
        generateButton.disabled = true;
      }

      const privateKeyHex = generatePrivateKeyHex();
      const displayValue = encodeKeyForDisplay(privateKeyHex);

      preparedPrivateKey = privateKeyHex;
      createTextarea.readOnly = true;
      createTextarea.value = displayValue;

      validateCreateInput();
      setCreateStatus('המפתח נוצר בהצלחה. שמרו אותו ואשרו את התיבה להמשך.');
      if (continueButton) {
        continueButton.disabled = !canContinue();
      }
    } catch (err) {
      console.error('Generate key failed', err);
      preparedPrivateKey = '';
      setCreateStatus(err?.message || 'יצירת המפתח נכשלה. נסו שוב.', 'error');
    } finally {
      if (generateButton) {
        generateButton.disabled = false;
      }
    }
  }

  function decodeImportValue() {
    const value = importTextarea.value.trim();
    if (!value) return null;
    if (typeof App.decodePrivateKey === 'function') {
      return App.decodePrivateKey(value);
    }
    if (/^[0-9a-fA-F]{64}$/.test(value)) {
      return value.toLowerCase();
    }
    return null;
  }

  function handleImport() {
    const privateKey = decodeImportValue();
    if (!privateKey) {
      setImportStatus('לא זוהה מפתח פרטי חוקי.', 'error');
      return;
    }
    try {
      window.localStorage.setItem('nostr_private_key', privateKey);
      App.privateKey = privateKey;
      if (typeof App.ensureKeys === 'function') {
        App.ensureKeys();
      }
      setImportStatus('הקוד אומת. מעבירים אתכם ללוח הראשי...');
      setTimeout(() => {
        // חלק Redirect (auth.js) – חזרה לעמוד שממנו הגיע המשתמש או לפיד הראשי | HYPER CORE TECH
        try {
          const params = new URLSearchParams(window.location.search);
          const redirect = params.get('redirect');
          if (redirect) {
            window.location.href = decodeURIComponent(redirect);
          } else {
            window.location.replace('videos.html');
          }
        } catch (e) {
          window.location.replace('videos.html');
        }
      }, 600);
    } catch (err) {
      console.error('Import failed', err);
      setImportStatus('שגיאה בשמירת המפתח.', 'error');
    }
  }

  // האזנות לאירועים
  const openCreatePanel = () => {
    showPanel('create');
    resetCreateFlow();
    setCreateStatus('');
    setImportStatus('');
  };

  const openImportPanel = () => {
    showPanel('import');
    setCreateStatus('');
    setImportStatus('');
  };

  if (entryLoginButton) {
    entryLoginButton.addEventListener('click', openImportPanel);
  }

  if (entryRegisterButton) {
    entryRegisterButton.addEventListener('click', openCreatePanel);
  }

  if (goCreateButton) {
    goCreateButton.addEventListener('click', openCreatePanel);
  }

  if (backToEntryFromLogin) {
    backToEntryFromLogin.addEventListener('click', () => {
      showPanel('entry');
      setCreateStatus('');
      setImportStatus('');
      resetCreateFlow();
    });
  }

  if (backToEntryButton) {
    backToEntryButton.addEventListener('click', () => {
      showPanel('entry');
      setCreateStatus('');
      setImportStatus('');
      resetCreateFlow();
    });
  }

  if (sendEmailButton) {
    sendEmailButton.addEventListener('click', handleSendEmail);
  }

  if (profileBackButton) {
    profileBackButton.addEventListener('click', (event) => {
      event.preventDefault();
      switchBackToEmailStep();
    });
  }

  if (profileNextButton) {
    profileNextButton.addEventListener('click', handleProfileNext);
  }

  if (keyBackButton) {
    keyBackButton.addEventListener('click', (event) => {
      event.preventDefault();
      switchBackToProfileStep();
    });
  }

  if (profileNameInput) {
    profileNameInput.addEventListener('input', updateProfileNextState);
  }

  if (avatarFileInput) {
    avatarFileInput.addEventListener('change', (event) => {
      const file = event.target?.files?.[0];
      if (file) {
        handleAvatarFile(file);
      }
    });
  }

  wireAvatarDropZone();
  ensureAvatarPlaceholder();
  runPromoOverlay();
  updateProfileNextState();
  bindCpanelToggle();
  bindCpanelModalEvents();

  if (emailInput) {
    emailInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleSendEmail().catch((err) => console.error('Email submit error', err));
      }
    });
  }

  if (createTextarea) {
    createTextarea.addEventListener('input', () => {
      validateCreateInput();
      if (continueButton) {
        continueButton.disabled = !canContinue();
      }
    });
  }

  if (copyCreateButton) {
    copyCreateButton.addEventListener('click', copyCreateKey);
  }

  if (downloadCreateButton) {
    downloadCreateButton.addEventListener('click', downloadCreateKey);
  }

  if (shareWhatsappButton) {
    shareWhatsappButton.addEventListener('click', shareWhatsapp);
  }

  if (generateButton) {
    generateButton.addEventListener('click', handleGenerateKey);
  }

  infoPanelButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const targetId = button.getAttribute('data-info-target');
      openInfoPanel(targetId);
      toggleHeaderNav(false);
    });
  });

  infoPanelCloseButtons.forEach((button) => {
    button.addEventListener('click', () => {
      hideAllInfoPanels();
      if (entryPanel) {
        entryPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });

  if (createConfirm) {
    createConfirm.addEventListener('change', () => {
      continueButton.disabled = !canContinue();
    });
  }

  if (continueButton) {
    continueButton.addEventListener('click', handleContinue);
  }

  if (importButton) {
    importButton.addEventListener('click', handleImport);
  }

  if (headerMenuToggle && headerNav) {
    headerMenuToggle.addEventListener('click', () => toggleHeaderNav());
    window.addEventListener('resize', () => {
      if (window.innerWidth > 560) {
        toggleHeaderNav(true);
      } else {
        toggleHeaderNav(false);
      }
    });
    toggleHeaderNav(window.innerWidth > 560);
  }

  // הפעלת פרומו קצר בעת טעינת הדף (ללא פגיעה בתהליך)
  runPromoOverlay();

  showPanel('entry');
  resetCreateFlow();

  Object.assign(App, {
    authHandleEmailRequest: handleSendEmail,
    authCopyCreateKey: copyCreateKey,
    authDownloadCreateKey: downloadCreateKey,
    authHandleContinue: handleContinue,
    authHandleImport: handleImport,
    authShareWhatsapp: shareWhatsapp,
    authResetCreateFlow: resetCreateFlow,
  });

  // פונקציות לניהול המודאל (auth.js) – HYPER CORE TECH
  const modals = {
    spearInfo: {
      title: 'SPEAR ONE – רשת חברתית חופשית',
      sections: [
        {
          icon: 'fa-solid fa-flask',
          title: 'טכנולוגיית SPEAR ONE – ניסוי חי',
          paragraphs: [
            'SPEAR ONE היא טכנולוגיה ניסיונית שפיתחנו להחזקת פלטפורמות אינטרנטיות ללא שרת מרכזי ועלויות תשתית כבדות.',
            'אנחנו בודקים אותה על רשת חברתית אמיתית ומזמינים את כולם להצטרף כשותפים לחזון – לראות איך קהילה מנהלת מערכת דיגיטלית בבעלותה שלה.'
          ]
        },
        {
          icon: 'fa-solid fa-circle-info',
          title: 'מה הופך את SPEAR ONE לשונה?',
          paragraphs: [
            'הטכנולוגיה מאפשרת לבנות שירותים מקוונים ללא שרת מרכזי – כמו אחסון תמונות, וידאו, שיחות קול ועוד. הרשת החברתית שלנו מציגה את כל היכולות האלה בפעולה.',
            'כל שירות עובד על רשת של משתמשים פעילים במקום על מרכז נתונים יחיד, מה שמייצר חיסכון תשתיתי ניכר ויציבות גבוהה.'
          ],
          list: [
            'אחסון תמונות ווידאו בחינם עם קישור ישיר',
            'שיחות קול ווידאו ללא שרת מרכזי',
            'ניתן להתאים לכל סוג של שירות מקוון'
          ]
        },
        {
          icon: 'fa-solid fa-scale-balanced',
          title: 'איך נקבע ערך SPEAR ONE (USD)?',
          paragraphs: [
            'הערך של SPEAR ONE משקף את ההתקדמות של המיזם בזמן אמת ומשלב נתונים מהשטח.'
          ],
          list: [
            'היקף ההשקעה שנכנס למערכת',
            'כמות המשתמשים הפעילים ברשת',
            'חיסכון תשתיתי שנמדד בצריכת משאבים',
            'פעילות מאומתת ותרומה קהילתית'
          ]
        }
      ]
    },
    blockchainInfo: {
      title: 'הלב הטכנולוגי – Blockchain',
      sections: [
        {
          icon: 'fa-solid fa-link-circle-check',
          title: 'איך הבלוקצ׳יין פועל כאן?',
          paragraphs: [
            'כל פעולה ברשת – פרסום פוסט, הקלטת שיחה או הצבעה – נחתמת בשרשרת בלוקים ומבטיחה שקיפות מלאה בין המשתתפים.',
            'החוזה החכם של SPEAR ONE מבטיח שכללים יופעלו באופן אוטומטי ושקוף, ללא אפשרות התערבות חיצונית.'
          ]
        },
        {
          icon: 'fa-solid fa-shield-halved',
          title: 'יתרונות המודל המבוזר',
          list: [
            'אין גוף מרכזי שיכול לחסום או למחוק תוכן שרירותית',
            'האמון מבוסס על קוד פתוח ותשתית שקופה',
            'הנכס האמיתי הוא רשת התקשורת עצמה – לא מטבע ספקולטיבי'
          ]
        }
      ]
    },
    partnershipInfo: {
      title: 'חוזה השותפים של SPEAR ONE',
      sections: [
        {
          icon: 'fa-solid fa-handshake-angle',
          title: 'שותפים אמיתיים, לא קהל פסיבי',
          paragraphs: [
            'כל משתמש פעיל יכול להפוך לשותף באמצעות חוזה דיגיטלי, ולקבל חלק הוגן מהרווחים שהרשת מייצרת.',
            'כאשר נוצרות הכנסות (כמו מפרסום שקוף או שיתופי פעולה), 50% מהן חוזרות מיד לקהילה לפי חלקם של השותפים.'
          ]
        },
        {
          icon: 'fa-solid fa-chart-line-up',
          title: 'השקעה מתמשכת בפיתוח',
          list: [
            'היתרה מושקעת בהרחבת הרשת והשקת יכולות חדשות',
            'לוח שקיפות מעדכן את הקהילה היכן מושקע כל דולר',
            'יצירת מעגל שמתגמל את המשתמשים עצמם – ולא חברות פרסום'
          ]
        }
      ]
    }
  };

  let modalSlidesData = [];
  let modalCurrentSlide = 0;
  let modalSlidesContainer = null;
  let modalDotsContainer = null;
  let modalPrevButton = null;
  let modalNextButton = null;
  let modalControlsContainer = null;

  function initModals() {
    const modal = document.getElementById('infoModal');
    if (!modal) return; // אין מודאל בדף הזה - יוצאים בשקט
    const closeBtn = modal.querySelector('.auth-modal__close');
    if (!closeBtn) return;
    modalSlidesContainer = document.getElementById('modalSlides');
    modalDotsContainer = document.getElementById('modalDots');
    modalPrevButton = document.getElementById('modalPrev');
    modalNextButton = document.getElementById('modalNext');
    modalControlsContainer = document.getElementById('modalControls');

    closeBtn.addEventListener('click', function() {
      modal.style.display = 'none';
      modal.setAttribute('aria-hidden', 'true');
    });

    if (modalPrevButton) {
      modalPrevButton.addEventListener('click', () => shiftModalSlide(-1));
    }

    if (modalNextButton) {
      modalNextButton.addEventListener('click', () => shiftModalSlide(1));
    }

    if (modalDotsContainer) {
      modalDotsContainer.addEventListener('click', (event) => {
        const dot = event.target.closest('.auth-modal__dot');
        if (!dot || typeof dot.dataset.index === 'undefined') {
          return;
        }
        const index = Number(dot.dataset.index);
        setModalSlide(index);
      });
    }

    document.querySelectorAll('[data-modal]').forEach(btn => {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        const modalType = this.getAttribute('data-modal');
        showModal(modals[modalType]);
      });
    });
  }

  function shiftModalSlide(delta) {
    setModalSlide(modalCurrentSlide + delta);
  }

  function setModalSlide(targetIndex) {
    if (!Array.isArray(modalSlidesData) || !modalSlidesContainer) {
      return;
    }

    const clampedIndex = Math.max(0, Math.min(targetIndex, modalSlidesData.length - 1));
    modalCurrentSlide = clampedIndex;

    const slides = Array.from(modalSlidesContainer.children);
    slides.forEach((slide, idx) => {
      slide.classList.toggle('is-active', idx === modalCurrentSlide);
    });

    if (modalDotsContainer) {
      const dots = Array.from(modalDotsContainer.children);
      dots.forEach((dot, idx) => {
        dot.classList.toggle('is-active', idx === modalCurrentSlide);
      });
    }

    if (modalPrevButton) {
      modalPrevButton.disabled = modalCurrentSlide === 0;
    }

    if (modalNextButton) {
      modalNextButton.disabled = modalCurrentSlide === modalSlidesData.length - 1;
    }
  }

  function renderModalSlides(sections) {
    if (!modalSlidesContainer || !modalDotsContainer || !modalControlsContainer) {
      return;
    }

    modalSlidesContainer.innerHTML = '';
    modalDotsContainer.innerHTML = '';

    if (!Array.isArray(sections) || sections.length === 0) {
      modalControlsContainer.classList.add('is-hidden');
      modalDotsContainer.classList.add('is-hidden');
      return;
    }

    sections.forEach((section, index) => {
      const slide = document.createElement('div');
      slide.className = 'auth-modal__slide';
      slide.dataset.index = String(index);

      const sectionWrapper = document.createElement('section');
      sectionWrapper.className = 'auth-modal__section';

      const header = document.createElement('header');
      header.className = 'auth-modal__section-title';
      header.innerHTML = `
        <i class="${section.icon || 'fa-solid fa-circle'}" aria-hidden="true"></i>
        <span>${section.title || ''}</span>
      `;

      sectionWrapper.appendChild(header);

      if (Array.isArray(section.paragraphs)) {
        section.paragraphs.forEach((paragraph) => {
          const p = document.createElement('p');
          p.className = 'auth-modal__paragraph';
          p.textContent = paragraph;
          sectionWrapper.appendChild(p);
        });
      }

      if (Array.isArray(section.list) && section.list.length > 0) {
        const listEl = document.createElement('ul');
        listEl.className = 'auth-modal__list';
        section.list.forEach((item) => {
          const li = document.createElement('li');
          li.textContent = item;
          listEl.appendChild(li);
        });
        sectionWrapper.appendChild(listEl);
      }

      slide.appendChild(sectionWrapper);
      modalSlidesContainer.appendChild(slide);

      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'auth-modal__dot';
      dot.dataset.index = String(index);
      dot.setAttribute('aria-label', `מעבר לשקופית ${index + 1}`);
      modalDotsContainer.appendChild(dot);
    });

    if (sections.length > 1) {
      modalControlsContainer.classList.remove('is-hidden');
      modalDotsContainer.classList.remove('is-hidden');
    } else {
      modalControlsContainer.classList.add('is-hidden');
      modalDotsContainer.classList.add('is-hidden');
    }
  }

  function showModal(data) {
    const modal = document.getElementById('infoModal');
    const title = document.getElementById('modalTitle');

    if (!modal || !title || !data) {
      return;
    }

    title.textContent = data.title || '';

    modalSlidesData = Array.isArray(data.sections) ? data.sections : [];
    modalCurrentSlide = 0;
    renderModalSlides(modalSlidesData);
    setModalSlide(modalCurrentSlide);

    modal.style.display = 'block';
    modal.setAttribute('aria-hidden', 'false');
  }

  // קריאה לאתחול המודאלים עם טעינת הדף
  window.addEventListener('DOMContentLoaded', initModals);

  // חשיפת פונקציות לשימוש חיצוני (guest-auth.js) | HYPER CORE TECH
  if (typeof window.NostrApp !== 'undefined') {
    window.NostrApp.publishEmailRegistry = publishEmailRegistry;
  }
})(window);
