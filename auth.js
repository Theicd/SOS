(function initAuth(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // הפניות לאלמנטים החדשים
  const entryPanel = document.getElementById('authEntryPanel');
  const importCard = document.querySelector('.auth-card--import');
  const createCard = document.getElementById('authCreatePanel');
  const headerMenuToggle = document.getElementById('siteHeaderMenuToggle');
  const headerNav = document.getElementById('siteHeaderNav');
  const entryLoginButton = document.getElementById('authEntryLoginButton');
  const entryRegisterButton = document.getElementById('authEntryRegisterButton');
  const goCreateButton = document.getElementById('authGoCreateButton');
  const backToEntryFromLogin = document.getElementById('authBackToEntryFromLogin');
  const backToEntryButton = document.getElementById('authBackToEntry');
  const shareWhatsappButton = document.getElementById('authShareWhatsappButton');
  // חלק זרימת אימייל (auth.js) – שליטה ברכיבי בקשת המפתח
  const sendEmailButton = document.getElementById('authSendEmailButton');
  const emailInput = document.getElementById('authEmailInput');
  const flowEmailStep = document.getElementById('authFlowEmailStep');
  const flowProfileStep = document.getElementById('authFlowProfileStep');
  const flowKeyStep = document.getElementById('authFlowKeyStep');
  // חלק פרטי פרופיל (auth.js) – קלטים אופציונליים לשם ותמונה
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

  function toggleHeaderNav(force) {
    if (!headerNav || !headerMenuToggle) {
      return;
    }
    const isOpen = typeof force === 'boolean' ? force : !headerNav.classList.contains('is-open');
    headerNav.classList.toggle('is-open', isOpen);
    headerNav.setAttribute('aria-hidden', String(!isOpen));
    headerMenuToggle.setAttribute('aria-expanded', String(isOpen));
  }

  function isProfileReady() {
    const nameValid = Boolean((profileNameInput?.value || '').trim());
    const hasAvatar = Boolean(uploadedAvatarDataUrl);
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
      setCreateStatus('המפתח נוצר עבורך. שמור אותו היטב ואשר את התיבה כדי להמשיך.');
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
    createStatus.textContent = message;
    createStatus.classList.toggle('is-error', tone === 'error');
  }

  function setImportStatus(message = '', tone = 'info') {
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
    setCreateStatus('');
    ensureAvatarPlaceholder();
    updateProfileNextState();
  }

  function switchToProfileStep() {
    if (flowEmailStep) flowEmailStep.hidden = true;
    if (flowProfileStep) flowProfileStep.hidden = false;
    if (profileNameInput) {
      profileNameInput.focus();
    }
    ensureAvatarPlaceholder();
    updateProfileNextState();
  }

  function switchToKeyStep() {
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
    if (flowKeyStep) flowKeyStep.hidden = true;
    if (flowProfileStep) flowProfileStep.hidden = false;
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
    setCreateStatus('ניתן לעדכן את שם הפרופיל או התמונה לפני שמירת המפתח.');
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
        setCreateStatus('כתובת האימייל הזו כבר קיבלה מפתח ואינה יכולה לפתוח חדש.', 'error');
        if (sendEmailButton) sendEmailButton.disabled = false;
        if (emailInput) emailInput.disabled = false;
        return;
      }
      emailHashForRegistry = emailHash;
      switchToProfileStep();
      setCreateStatus('המשיכו לשלב הפרופיל כדי להשלים את ההרשמה.');
    } catch (err) {
      console.error('Email-based key generation failed', err);
      setCreateStatus(err.message || 'יצירת המפתח נכשלה. נסו שוב או רעננו את הדף.', 'error');
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
        setCreateStatus('לא זוהה מפתח פרטי תקין. ודאו שהעתקתם את כל התווים.', 'error');
      } else {
        setCreateStatus('לחצו "קבלת מפתח ייחודי" כדי להפיק מפתח לרשת.');
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
    setCreateStatus('המפתח אומת. ודאו ששמרתם אותו ואשרו את התיבה כדי להמשיך.');
    if (continueButton) {
      continueButton.disabled = !canContinue();
    }
  }

  async function copyCreateKey() {
    try {
      await navigator.clipboard.writeText(createTextarea.value);
      setCreateStatus('המפתח הועתק ללוח הזיכרון.');
    } catch (err) {
      console.error('Copy create key failed', err);
      setCreateStatus('נכשלה ההעתקה ללוח.', 'error');
    }
  }

  function downloadCreateKey() {
    const value = createTextarea.value.trim();
    if (!value) {
      setCreateStatus('אין מפתח לשמור.', 'error');
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
    setCreateStatus('קובץ הגיבוי נשמר.');
  }

  function canContinue() {
    return Boolean(preparedPrivateKey) && createConfirm.checked;
  }

  function handleContinue() {
    if (!canContinue()) {
      setCreateStatus('יש לשמור את המפתח ולאשר שסימנת זאת.', 'error');
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

      setCreateStatus('נכנסים לרשת...');
      setTimeout(() => {
        window.location.replace('index.html');
      }, 350);
    } catch (err) {
      console.error('Handle continue failed', err);
      setCreateStatus('שגיאה בהשלמת ההרשמה. נסו שוב לאחר רענון.', 'error');
    }
  }

  function shareWhatsapp() {
    if (!shareWhatsappButton) {
      return;
    }
    const value = createTextarea.value.trim();
    if (!value) {
      setCreateStatus('אין מפתח לשלוח.', 'error');
      return;
    }
    const message = encodeURIComponent(`המפתח הפרטי שלי ליאלה תקשורת:\n${value}`);
    const url = `https://wa.me/?text=${message}`;
    window.open(url, '_blank', 'noopener');
    setCreateStatus('פתחתי עבורך וואטסאפ לשיתוף המפתח.');
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
      setImportStatus('המפתח נטען בהצלחה. מעבירים ללוח הראשי...');
      setTimeout(() => window.location.replace('index.html'), 600);
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
  updateProfileNextState();

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
})(window);
