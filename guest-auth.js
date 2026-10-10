// =======================
// לוגיקת חלון התחברות / הרשמה למצב אורח (guest-auth.js) – Guest Auth Logic | HYPER CORE TECH
// קוד זה שייך ל-NostrApp ומתחבר ל-modal שהוגדר ב-videos.html
// משמש לחקות את חוויית טיקטוק - צפייה חופשית + התחברות קלה בעת פעולה
// =======================
(function initGuestAuthModal() {
  var App = window.NostrApp || (window.NostrApp = {});

  // Top-bar auth UI — fail-closed until IDENTITY_OK; no raw-K reads | HYPER CORE TECH
  App._topBarAuthUiReady = App._topBarAuthUiReady === true;

  function isAuthenticatedTopBarUi() {
    if (App.guestMode !== false) return false;
    var st = String(App.identityState || '');
    if (
      st === (App.IDENTITY_NEW_USER || 'IDENTITY_NEW_USER') ||
      st === (App.IDENTITY_RECOVERY_REQUIRED || 'IDENTITY_RECOVERY_REQUIRED') ||
      st === (App.IDENTITY_INVALID || 'IDENTITY_INVALID') ||
      /MISMATCH|INVALID|RECOVERY/i.test(st)
    ) {
      return false;
    }
    if (st && st !== (App.IDENTITY_OK || 'IDENTITY_OK')) return false;
    var pub = String(App.publicKey || '').trim();
    return /^[0-9a-f]{64}$/i.test(pub);
  }

  function syncTopBarAuthUi() {
    var profile = document.getElementById('topBarProfile');
    var guestBtn = document.getElementById('guestLoginButton');
    var authed = isAuthenticatedTopBarUi();
    var ready = App._topBarAuthUiReady === true;

    if (profile) {
      if (authed) {
        profile.hidden = false;
        try { profile.style.removeProperty('display'); } catch (_e) {}
      } else {
        profile.hidden = true;
        var menu = document.getElementById('topBarProfileMenu');
        var pbtn = document.getElementById('topBarProfileButton');
        if (menu) menu.hidden = true;
        if (pbtn) pbtn.setAttribute('aria-expanded', 'false');
      }
    }

    if (guestBtn) {
      if (!ready || authed) {
        guestBtn.hidden = true;
        guestBtn.style.display = 'none';
      } else {
        guestBtn.hidden = false;
        guestBtn.style.display = 'inline-flex';
      }
    }
  }

  App.isAuthenticatedTopBarUi = isAuthenticatedTopBarUi;
  App.syncTopBarAuthUi = syncTopBarAuthUi;

  function storeNostrPrivateKeyGuest(hex) {
    if (window.SOSKeyStorage && typeof window.SOSKeyStorage.writePrivateKeyRaw === 'function') {
      window.SOSKeyStorage.writePrivateKeyRaw(hex);
    }
  }

  // משתנים גלובליים לשמירת נתוני ההרשמה
  var signupData = {
    email: '',
    emailHash: '',
    name: '',
    avatarDataUrl: '',
    privateKey: '',
    inviteCode: '',
    invitePhone: '',
    invitePhoneHash: '',
    inviterPubkey: '',
    invitePurpose: '',
    inviteEventId: ''
  };

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
  }

  // פונקציות עזר מ-auth.js
  function generatePrivateKeyHex() {
    if (typeof NostrTools === 'undefined' || !NostrTools.generateSecretKey) {
      throw new Error('NostrTools לא זמין');
    }
    var secretKey = NostrTools.generateSecretKey();
    if (typeof App.bytesToHex === 'function') {
      return App.bytesToHex(secretKey);
    }
    return Array.from(secretKey, function(b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  /** F5A — authenticated without reading raw K */
  function isAuthenticatedIdentity() {
    if (App.guestMode === true) return false;
    if (App.SosCryptoSigner && typeof App.SosCryptoSigner.isWorkerAuthoritative === 'function' && App.SosCryptoSigner.isWorkerAuthoritative()) {
      return !!(App.publicKey && App.SosCryptoSigner.hasIdentityKey());
    }
    if (App.publicKey && App.SosCryptoSigner && App.SosCryptoSigner.hasIdentityKey()) return true;
    return !!(App.publicKey && App.privateKey);
  }

  function shouldUseWorkerCreate() {
    try {
      if (window.SosNativeShell && typeof window.SosNativeShell.isNativeShell === 'function' && window.SosNativeShell.isNativeShell() === true) {
        return false;
      }
      if (window.SOSKeyStorage && typeof window.SOSKeyStorage.isSessionOnly === 'function' && window.SOSKeyStorage.isSessionOnly()) {
        return false;
      }
      if (!window.SosCryptoWorkerVault || typeof window.SosCryptoWorkerVault.createBrowserIdentity !== 'function') {
        return false;
      }
      var pre = window.SosCryptoWorkerVault.eligibilityPrecheck && window.SosCryptoWorkerVault.eligibilityPrecheck();
      if (pre && pre.ok === false) return false;
      // Prefer Worker create whenever Worker is available (BrowserSecure path).
      return true;
    } catch (_e) {
      return false;
    }
  }

  function encodeKeyForDisplay(hexKey) {
    if (typeof App.encodePrivateKey === 'function') {
      try {
        return App.encodePrivateKey(hexKey);
      } catch (e) {
        console.warn('Encode failed, returning hex', e);
      }
    }
    return hexKey;
  }

  function decodePrivateKey(value) {
    if (!value) return null;
    if (typeof App.decodePrivateKey === 'function') {
      return App.decodePrivateKey(value);
    }
    if (/^[0-9a-fA-F]{64}$/.test(value)) {
      return value.toLowerCase();
    }
    return null;
  }

  async function computeEmailHash(email) {
    var normalized = normalizeEmail(email);
    var encoder = new TextEncoder();
    var data = encoder.encode(normalized);
    var hashBuffer = await crypto.subtle.digest('SHA-256', data);
    var hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(function(b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  async function waitForPool(maxAttempts) {
    var attempts = 0;
    var limit = typeof maxAttempts === 'number' ? maxAttempts : 25;
    while ((!App.pool || !Array.isArray(App.relayUrls) || App.relayUrls.length === 0) && attempts < limit) {
      await new Promise(function(resolve) { setTimeout(resolve, 200); });
      attempts++;
    }
    return !!(App.pool && Array.isArray(App.relayUrls) && App.relayUrls.length);
  }

  // מחזיר { ok, used } — ok=false כשלא ניתן לבדוק (fail-closed) | HYPER CORE TECH
  async function checkEmailAvailability(hash) {
    if (!App.EMAIL_REGISTRY_KIND) {
      return { ok: false, used: false, error: 'רישום מייל לא מוגדר במערכת' };
    }
    if (!(await waitForPool(25))) {
      return { ok: false, used: false, error: 'אין חיבור לריליים לבדיקת מייל' };
    }
    try {
      if (typeof App.isEmailHashRegistered === 'function') {
        var usedByApp = await App.isEmailHashRegistered(hash);
        // App ישן מחזיר false גם בכשל — נבדוק גם מקומית לאימות חיובי
        if (usedByApp === true) {
          return { ok: true, used: true };
        }
      }

      var tagKey = App.EMAIL_REGISTRY_HASH_TAG || 'h';
      var filter = {
        kinds: [App.EMAIL_REGISTRY_KIND],
        limit: 10
      };
      filter['#' + tagKey] = [hash];

      var events = [];
      var queried = false;
      if (typeof App.pool.querySync === 'function') {
        events = await App.pool.querySync(App.relayUrls, filter);
        queried = true;
      } else if (typeof App.pool.list === 'function') {
        events = await App.pool.list(App.relayUrls, [filter]);
        queried = true;
      } else if (typeof App.pool.get === 'function') {
        var event = await App.pool.get(App.relayUrls, filter);
        if (event) events = [event];
        queried = true;
      }

      if (!queried) {
        return { ok: false, used: false, error: 'לא ניתן לבדוק מייל מול הריליים' };
      }

      var list = Array.isArray(events) ? events : [];
      console.log('Email hash check result:', { hash: hash.slice(0, 8), found: list.length > 0 });
      return { ok: true, used: list.length > 0 };
    } catch (e) {
      console.error('Email hash check failed', e);
      return { ok: false, used: false, error: e.message || 'בדיקת מייל נכשלה' };
    }
  }

  async function publishAndVerifyEmailRegistry(emailHash, privateKeyHex) {
    if (typeof App.publishEmailRegistry !== 'function') {
      return { ok: false, error: 'מנגנון רישום מייל לא זמין' };
    }
    var publishResult = await App.publishEmailRegistry(emailHash, privateKeyHex);
    if (!publishResult || !publishResult.ok) {
      return {
        ok: false,
        error: (publishResult && publishResult.error) || 'פרסום רישום המייל נכשל'
      };
    }

    if (typeof App.verifyEmailHashPublished === 'function') {
      var verified = await App.verifyEmailHashPublished(
        emailHash,
        publishResult.relays || App.relayUrls,
        publishResult.pubkey
      );
      if (!verified) {
        return { ok: false, error: 'רישום המייל לא אומת בריליים' };
      }
    } else {
      // גיבוי: בדיקה חוזרת מקומית
      await new Promise(function(resolve) { setTimeout(resolve, 500); });
      var again = await checkEmailAvailability(emailHash);
      if (!again.ok || !again.used) {
        return { ok: false, error: 'רישום המייל לא נמצא אחרי הפרסום' };
      }
    }
    return { ok: true };
  }

  function resizeImageToDataUrl(file, maxWidth, callback) {
    function fallbackResize() {
      var reader = new FileReader();
      reader.onload = function(e) {
        var img = new Image();
        img.onload = function() {
          var canvas = document.createElement('canvas');
          var scale = maxWidth / img.width;
          canvas.width = maxWidth;
          canvas.height = img.height * scale;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          callback(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }

    if (typeof App.resizeImageToDataUrl === 'function') {
      try {
        var maybePromise = App.resizeImageToDataUrl(file, maxWidth, maxWidth, 0.85);
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(callback).catch(function(err) {
            console.error('resizeImageToDataUrl async failed', err);
            fallbackResize();
          });
          return;
        }
        if (typeof maybePromise === 'string') {
          callback(maybePromise);
          return;
        }
      } catch (err) {
        console.error('resizeImageToDataUrl error', err);
      }
    }

    fallbackResize();
  }

  // ניהול שלבים
  function showStep(stepId) {
    var steps = [
      'authStepInitial',
      'authStepLogin',
      'authStepInvite',
      'authStepEmail',
      'authStepName',
      'authStepAvatar',
      'authStepKey'
    ];
    steps.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.style.display = (id === stepId) ? 'block' : 'none';
    });
  }

  function setStatus(elementId, message, isError) {
    var el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? '#dc3545' : '#28a745';
  }

  function resetSignupData() {
    signupData = {
      email: '',
      emailHash: '',
      name: '',
      avatarDataUrl: '',
      privateKey: '',
      workerCreate: false,
      createNonce: '',
      inviteCode: '',
      invitePhone: '',
      invitePhoneHash: '',
      inviterPubkey: '',
      invitePurpose: '',
      inviteEventId: ''
    };
  }

  function prefillInviteFromUrl(force) {
    var inviteInput = document.getElementById('signupInviteCodeInput');
    if (!inviteInput) return '';
    if (!force && inviteInput.value && inviteInput.value.trim()) {
      return inviteInput.value.trim().toUpperCase();
    }
    if (typeof App.getInviteCodeFromLocation === 'function') {
      var code = App.getInviteCodeFromLocation();
      if (code) {
        inviteInput.value = code;
        return code;
      }
    }
    return (inviteInput.value || '').trim().toUpperCase();
  }

  function resolveAuthStep(step) {
    // Legacy 'email' step maps to combined invite+phone+email registration screen.
    if (step === 'email' || step === 'authStepEmail') return 'authStepInvite';
    if (!step || step === 'initial') return 'authStepInitial';
    if (step === 'invite' || step === 'authStepInvite') return 'authStepInvite';
    if (step === 'login' || step === 'authStepLogin') return 'authStepLogin';
    if (String(step).indexOf('authStep') === 0) return step;
    return 'authStepInitial';
  }

  // פונקציה לפתיחת חלון ההתחברות/הרשמה
  // options.step: 'initial' | 'invite' | 'login' | 'email'
  App.openAuthPrompt = function(message, options) {
    var opts = options && typeof options === 'object' ? options : {};
    var modal = document.getElementById('guestAuthModal');
    var reasonNode = document.getElementById('guestAuthModalReason');
    if (!modal) return;

    if (reasonNode) {
      reasonNode.textContent = message || 'כדי להמשיך צריך להתחבר או להירשם.';
    }

    var step = resolveAuthStep(opts.step);
    // קישור הזמנה מה־URL → תמיד שלב ההזמנה עם קוד ממולא | HYPER CORE TECH
    var urlInvite = typeof App.getInviteCodeFromLocation === 'function'
      ? App.getInviteCodeFromLocation()
      : '';
    if (urlInvite && (opts.preferInvite !== false) && (step === 'authStepInitial' || opts.fromInviteLink)) {
      step = 'authStepInvite';
    }

    if (step === 'authStepInvite') {
      prefillInviteFromUrl(true);
    } else {
      prefillInviteFromUrl(false);
    }

    showStep(step);
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
  };

  // פונקציה לסגירת חלון ההתחברות/הרשמה
  App.closeAuthPrompt = function() {
    var modal = document.getElementById('guestAuthModal');
    if (!modal) return;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    showStep('authStepInitial');
    resetSignupData();
  };

  // חיבור כפתורים ופעולות
  document.addEventListener('DOMContentLoaded', function () {
    var modal = document.getElementById('guestAuthModal');
    if (!modal) return;

    // כפתורים ראשיים
    var closeBtn = modal.querySelector('[data-guest-auth-close]');
    var btnStartLogin = document.getElementById('btnStartLogin');
    var btnStartSignup = document.getElementById('btnStartSignup');
    var guestLoginButton = document.getElementById('guestLoginButton');

    // כפתורי חזרה
    var btnBackFromLogin = document.getElementById('btnBackFromLogin');
    var btnBackFromEmail = document.getElementById('btnBackFromEmail');
    var btnBackFromName = document.getElementById('btnBackFromName');
    var btnBackFromAvatar = document.getElementById('btnBackFromAvatar');

    // שלב התחברות
    var loginKeyInput = document.getElementById('loginKeyInput');
    var btnLoginSubmit = document.getElementById('btnLoginSubmit');
    var btnLoginPaste = document.getElementById('btnLoginPaste');

    // שלב הרשמה - הזמנה
    var signupInviteCodeInput = document.getElementById('signupInviteCodeInput');
    var signupInvitePhoneInput = document.getElementById('signupInvitePhoneInput');
    var btnInviteNext = document.getElementById('btnInviteNext');
    var btnBackFromInvite = document.getElementById('btnBackFromInvite');

    // שלב הרשמה - מייל
    var signupEmailInput = document.getElementById('signupEmailInput');
    var btnEmailNext = document.getElementById('btnEmailNext');
    var signupLegalCheckbox = document.getElementById('signupLegalAgree');

    // שלב הרשמה - שם
    var signupNameInput = document.getElementById('signupNameInput');
    var btnNameNext = document.getElementById('btnNameNext');

    // שלב הרשמה - אווטר
    var signupAvatarInput = document.getElementById('signupAvatarInput');
    var btnChooseAvatar = document.getElementById('btnChooseAvatar');
    var btnSkipAvatar = document.getElementById('btnSkipAvatar');
    var btnAvatarNext = document.getElementById('btnAvatarNext');
    var avatarPreview = document.getElementById('avatarPreview');

    // שלב הרשמה - מפתח
    var generatedKeyDisplay = document.getElementById('generatedKeyDisplay');
    var btnCopyKey = document.getElementById('btnCopyKey');
    var btnDownloadKey = document.getElementById('btnDownloadKey');
    var keyConfirmCheckbox = document.getElementById('keyConfirmCheckbox');
    var btnFinalConnect = document.getElementById('btnFinalConnect');
    var keyPolicyCheckbox = document.getElementById('keyPolicyAgree');
    var keyRightsCheckbox = document.getElementById('keyRightsConfirm');

    // Several key-step blocks carry inline display styles, which override the hidden attribute.
    function setBlockVisible(el, visible) {
      if (!el) return;
      el.hidden = !visible;
      if (!visible) {
        if (el.style.display !== 'none') el.setAttribute('data-sos-display', el.style.display || '');
        el.style.display = 'none';
      } else if (el.style.display === 'none') {
        el.style.display = el.getAttribute('data-sos-display') || '';
      }
    }

    function setWorkerKeyMode(on) {
      var show = function(id, visible) {
        setBlockVisible(document.getElementById(id), visible);
      };
      show('workerKeyIntro', on);
      show('legacyKeyWarning', !on);
      show('generatedKeyDisplay', !on);
      show('legacyKeyActions', !on);
      show('legacyKeyConfirm', !on);
      show('workerIdentityDone', false);
      var title = document.getElementById('authKeyTitle');
      if (title) title.textContent = on ? 'יצירת הזהות שלך' : 'זה המפתח האישי שלך!';
      if (generatedKeyDisplay) generatedKeyDisplay.value = '';
    }

    function renderRecoveryBackupStatus() {
      var statusEl = document.getElementById('recoveryBackupStatus');
      var btn = document.getElementById('btnRecoveryBackup');
      var continueBtn = document.getElementById('btnWorkerIdentityContinue');
      var RB = App.RecoveryBackup;
      var exported = !!(RB && RB.isPersonalKeyExported(App.publicKey));
      if (statusEl) {
        // Blob+anchor download can only confirm initiation — not durable disk write.
        statusEl.textContent = exported
          ? 'הורדת המפתח התחילה. ודאו שקובץ המפתח הופיע בתיקיית ההורדות ושמרו אותו במקום בטוח.'
          : 'קובץ זה משמש לכניסה ולשחזור החשבון. שמרו אותו במקום בטוח. SOS אינו יכול לשחזר אותו עבורכם.';
        statusEl.style.color = exported ? '#4caf50' : '#ffc107';
      }
      setBlockVisible(btn, !exported);
      setBlockVisible(continueBtn, exported);
      if (continueBtn && exported) {
        continueBtn.textContent = 'בדקתי שהקובץ ירד — כניסה ל-SOS';
      }
      // INITIAL_BACKUP_REQUIRED: never offer skip-later for new Worker identities.
      setBlockVisible(document.getElementById('btnWorkerIdentitySkip'), false);
    }

    function showWorkerIdentityDone() {
      var pub = String(App.publicKey || '').toLowerCase();
      var pubEl = document.getElementById('workerIdentityPubkey');
      var fpEl = document.getElementById('workerIdentityFingerprint');
      if (pubEl) pubEl.textContent = pub;
      if (fpEl) fpEl.textContent = pub ? pub.slice(0, 8) + '…' + pub.slice(-8) : '';
      ['workerKeyIntro', 'legacyKeyActions', 'legacyKeyConfirm'].forEach(function(id) {
        setBlockVisible(document.getElementById(id), false);
      });
      setBlockVisible(document.querySelector('#authStepKey .auth-legal-block'), false);
      setBlockVisible(btnFinalConnect, false);
      setBlockVisible(document.getElementById('workerIdentityDone'), true);
      var title = document.getElementById('authKeyTitle');
      if (title) title.textContent = 'המפתח האישי שלך';
      var saveBtn = document.getElementById('btnRecoveryBackup');
      if (saveBtn) saveBtn.textContent = 'שמירת המפתח';
      renderRecoveryBackupStatus();
    }

    var btnRecoveryBackup = document.getElementById('btnRecoveryBackup');
    if (btnRecoveryBackup) {
      btnRecoveryBackup.addEventListener('click', function() {
        var RB = App.RecoveryBackup;
        var r = RB && typeof RB.start === 'function' ? RB.start({ initialRecovery: true }) : { ok: false, code: 'UNAVAILABLE' };
        if (!r || !r.ok) {
          setStatus('keyStatus', r && r.code === 'POPUP_BLOCKED' ? 'הדפדפן חסם את החלון המאובטח. אפשרו חלונות קופצים ונסו שוב.' : 'לא ניתן לפתוח את החלון המאובטח כרגע.', true);
          return;
        }
        setStatus('keyStatus', 'המשיכו בחלון המאובטח: שמירת המפתח כקובץ.', false);
      });
    }
    window.addEventListener('sos-recovery-backup-state', function(ev) {
      renderRecoveryBackupStatus();
      var st = ev && ev.detail && ev.detail.state;
      if (st === 'CONFIRMED') {
        setStatus('keyStatus', 'הורדת המפתח התחילה. ודאו שקובץ המפתח הופיע בתיקיית ההורדות ושמרו אותו במקום בטוח.', false);
      } else if (st === 'IN_SIGNER') {
        setStatus('keyStatus', 'המפתח הועבר לחלון המאובטח. השלימו שם את שמירת הקובץ.', false);
      } else if (st === 'ERROR') {
        setStatus('keyStatus', 'קבלת המפתח נכשלה: ' + ((ev.detail && ev.detail.code) || 'שגיאה'), true);
      }
    });
    var btnWorkerContinue = document.getElementById('btnWorkerIdentityContinue');
    if (btnWorkerContinue) {
      // AUTO_ENTER_AFTER_DOWNLOAD_TRIGGER=false — user must click after download initiation.
      btnWorkerContinue.addEventListener('click', function() {
        var RB = App.RecoveryBackup;
        if (!(RB && RB.isPersonalKeyExported(App.publicKey))) {
          setStatus('keyStatus', 'יש להתחיל את הורדת המפתח לפני הכניסה ל-SOS.', true);
          return;
        }
        window.location.reload();
      });
    }
    var btnWorkerSkip = document.getElementById('btnWorkerIdentitySkip');
    if (btnWorkerSkip) {
      btnWorkerSkip.hidden = true;
      btnWorkerSkip.style.display = 'none';
    }

    function updateFinalConnectState() {
      if (!btnFinalConnect) return;
      var confirmChecked = signupData.workerCreate ? true : keyConfirmCheckbox ? keyConfirmCheckbox.checked : true;
      var policyChecked = keyPolicyCheckbox ? keyPolicyCheckbox.checked : true;
      var rightsChecked = keyRightsCheckbox ? keyRightsCheckbox.checked : true;
      btnFinalConnect.disabled = !(confirmChecked && policyChecked && rightsChecked);
    }

    function requireInviteEnabled() {
      return App.REQUIRE_INVITE_FOR_SIGNUP !== false;
    }

    // סגירה וחזרה
    if (closeBtn) closeBtn.addEventListener('click', App.closeAuthPrompt);
    if (btnBackFromLogin) btnBackFromLogin.addEventListener('click', function() { showStep('authStepInitial'); });
    if (btnBackFromInvite) btnBackFromInvite.addEventListener('click', function() { showStep('authStepInitial'); });
    if (btnBackFromEmail) {
      btnBackFromEmail.addEventListener('click', function() {
        showStep(requireInviteEnabled() ? 'authStepInvite' : 'authStepInitial');
      });
    }
    if (btnBackFromName) btnBackFromName.addEventListener('click', function() { showStep('authStepEmail'); });
    if (btnBackFromAvatar) btnBackFromAvatar.addEventListener('click', function() { showStep('authStepName'); });

    // מעבר לשלבים
    if (btnStartLogin) btnStartLogin.addEventListener('click', function() { showStep('authStepLogin'); });
    if (btnStartSignup) {
      btnStartSignup.addEventListener('click', function() {
        var inviteCode = prefillInviteFromUrl(true);
        // Phone + email + legal always on the invite registration screen.
        showStep('authStepInvite');
        if (inviteCode) {
          setTimeout(function() { submitInviteStep({ auto: true }); }, 200);
        }
      });
    }

    // הדבקת מפתח מהלוח – מחשב ומובייל | HYPER CORE TECH
    if (btnLoginPaste && loginKeyInput) {
      btnLoginPaste.addEventListener('click', async function() {
        try {
          if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
            setStatus('loginStatus', 'הדבקה אוטומטית לא נתמכת – הדביקו ידנית בשדה', true);
            try { loginKeyInput.focus(); } catch (_) {}
            return;
          }
          var text = await navigator.clipboard.readText();
          text = String(text || '').trim();
          if (!text) {
            setStatus('loginStatus', 'הלוח ריק – העתיקו את המפתח ואז לחצו הדבק', true);
            return;
          }
          loginKeyInput.value = text;
          try { loginKeyInput.focus(); } catch (_) {}
          setStatus('loginStatus', 'המפתח הודבק', false);
        } catch (_) {
          setStatus('loginStatus', 'לא ניתן לגשת ללוח – הדביקו ידנית בשדה', true);
          try { loginKeyInput.focus(); } catch (__) {}
        }
      });
    }

    // טעינת קובץ המפתח האישי (SOS-personal-key-*.txt) – נקרא מקומית בלבד
    var btnLoginKeyFile = document.getElementById('btnLoginKeyFile');
    var loginKeyFileInput = document.getElementById('loginKeyFileInput');
    if (btnLoginKeyFile && loginKeyFileInput && loginKeyInput) {
      btnLoginKeyFile.addEventListener('click', function() {
        loginKeyFileInput.value = '';
        loginKeyFileInput.click();
      });
      loginKeyFileInput.addEventListener('change', function() {
        var file = loginKeyFileInput.files && loginKeyFileInput.files[0];
        loginKeyFileInput.value = '';
        if (!file) return;
        if (file.size > 4096) {
          setStatus('loginStatus', 'הקובץ אינו קובץ מפתח של SOS', true);
          return;
        }
        file.text().then(function(text) {
          var m = String(text || '').match(/\b(nsec1[02-9ac-hj-np-z]{58}|[0-9a-fA-F]{64})\b/);
          text = null;
          if (!m) {
            setStatus('loginStatus', 'לא נמצא מפתח תקין בקובץ', true);
            return;
          }
          loginKeyInput.value = m[1];
          if (btnLoginSubmit) btnLoginSubmit.click();
        }).catch(function() {
          setStatus('loginStatus', 'לא ניתן לקרוא את הקובץ', true);
        });
      });
    }

    // התחברות
    if (btnLoginSubmit) {
      btnLoginSubmit.addEventListener('click', async function() {
        var rawKey = loginKeyInput.value.trim();
        if (!rawKey) {
          setStatus('loginStatus', 'נא להדביק את המפתח הפרטי', true);
          return;
        }

        var privateKey = decodePrivateKey(rawKey);
        if (!privateKey) {
          setStatus('loginStatus', 'המפתח לא תקין', true);
          return;
        }

        try {
          if (typeof App.switchAccountFromRawKey === 'function') {
            var switchedLogin = App.switchAccountFromRawKey(privateKey, { reload: false });
            if (!switchedLogin || !switchedLogin.ok) {
              var errCode = (switchedLogin && (switchedLogin.code || switchedLogin.reason)) || '';
              var msg =
                errCode === 'ACCOUNT_DISABLED'
                  ? (switchedLogin.message || 'החשבון הושבת ואינו מורשה להתחבר ל-SOS.')
                  : (switchedLogin && switchedLogin.hebrewError) ||
                    (typeof App.existingKeyImportHebrewError === 'function'
                      ? App.existingKeyImportHebrewError(errCode)
                      : '') ||
                    (switchedLogin && switchedLogin.state === 'IDENTITY_RECOVERY_REQUIRED'
                      ? 'לא ניתן היה לחבר את החשבון. נסה שוב.'
                      : 'המפתח שהוזן אינו תקין');
              setStatus('loginStatus', msg, true);
              return;
            }
            App.guestMode = false;
            App.privateKey = null;
            try { if (typeof App.syncTopBarAuthUi === 'function') App.syncTopBarAuthUi(); } catch (_s) {}
            setStatus('loginStatus', 'מתחבר...', false);
            setTimeout(function() {
              window.location.reload();
            }, 500);
            return;
          }
          var normalizedLogin = privateKey;
          if (typeof App.normalizePrivateKey === 'function') {
            normalizedLogin = App.normalizePrivateKey(privateKey, { persist: false });
          }
          if (!normalizedLogin || !/^[0-9a-f]{64}$/.test(normalizedLogin)) {
            setStatus('loginStatus', 'המפתח לא תקין', true);
            return;
          }
          try {
            var getPk = App.getPublicKey || (window.NostrTools && window.NostrTools.getPublicKey);
            if (typeof getPk === 'function') getPk(normalizedLogin);
          } catch (_deriveErr) {
            setStatus('loginStatus', 'המפתח לא תקין', true);
            return;
          }
          storeNostrPrivateKeyGuest(normalizedLogin);
          App.privateKey = normalizedLogin;
          var derivedPub = '';
          try {
            var getPk2 = App.getPublicKey || (window.NostrTools && window.NostrTools.getPublicKey);
            if (typeof getPk2 === 'function') derivedPub = String(getPk2(normalizedLogin) || '').toLowerCase();
          } catch (_dp) {
            derivedPub = '';
          }
          function finishKeyLogin() {
            if (typeof App.ensureKeys === 'function') {
              var loginResult = App.ensureKeys();
              if (!loginResult || loginResult.ok !== true) {
                var disabled =
                  loginResult && (loginResult.code === 'ACCOUNT_DISABLED' || loginResult.ACCOUNT_DISABLED === true);
                setStatus(
                  'loginStatus',
                  disabled ? (loginResult.message || 'החשבון הושבת ואינו מורשה להתחבר ל-SOS.') : 'המפתח לא תקין',
                  true,
                );
                return;
              }
            }
            App.guestMode = false;
            try {
              if (typeof App.syncTopBarAuthUi === 'function') App.syncTopBarAuthUi();
            } catch (_s) {}
            setStatus('loginStatus', 'מתחבר...', false);
            setTimeout(function () {
              window.location.reload();
            }, 500);
          }
          try {
            var GA = App.GlobalAdmission || window.SosGlobalAdmission;
            if (GA && typeof GA.reconcileAccountStatus === 'function' && /^[0-9a-f]{64}$/.test(derivedPub)) {
              Promise.resolve(GA.reconcileAccountStatus(derivedPub))
                .then(finishKeyLogin)
                .catch(finishKeyLogin);
              return;
            }
          } catch (_recLogin) {}
          finishKeyLogin();
        } catch (e) {
          setStatus('loginStatus', 'שגיאה בשמירת המפתח', true);
        }
      });
    }

    // הרשמה — מסך אחד: הזמנה + טלפון + מייל + אישור משפטי
    async function submitInviteStep(options) {
      var opts = options || {};
      var auto = !!opts.auto;
      var code = prefillInviteFromUrl(true) ||
        ((signupInviteCodeInput && signupInviteCodeInput.value) || '').trim().toUpperCase();
      var phoneRaw = (signupInvitePhoneInput && signupInvitePhoneInput.value || '').trim();
      var email = normalizeEmail(signupEmailInput && signupEmailInput.value);
      var PN = App.PhoneNormalize || window.SosPhoneNormalize;
      var inviteRequired = requireInviteEnabled();

      if (signupInviteCodeInput && code) {
        signupInviteCodeInput.value = code;
      }

      if (!code && inviteRequired) {
        if (!auto) setStatus('inviteStatus', 'נא להזין קוד הזמנה', true);
        return false;
      }
      // Deep-link auto-fill must NOT skip phone/email — user must enter phone.
      if (auto && !phoneRaw) {
        setStatus('inviteStatus', 'הזינו את מספר הטלפון שאליו נשלחה ההזמנה.', false);
        if (signupInvitePhoneInput) signupInvitePhoneInput.focus();
        return false;
      }
      if (!phoneRaw) {
        setStatus('inviteStatus', 'נא להזין מספר טלפון', true);
        return false;
      }
      var phoneNorm = PN && typeof PN.normalizePhoneE164 === 'function' ? PN.normalizePhoneE164(phoneRaw) : null;
      if (!phoneNorm || !phoneNorm.ok) {
        setStatus('inviteStatus', 'מספר טלפון לא תקין', true);
        return false;
      }
      if (signupLegalCheckbox && !signupLegalCheckbox.checked) {
        setStatus('inviteStatus', 'נא לאשר את תנאי השימוש לפני המשך.', true);
        return false;
      }
      if (!isValidEmail(email)) {
        setStatus('inviteStatus', 'נא להזין כתובת מייל תקינה', true);
        return false;
      }

      if (btnInviteNext) btnInviteNext.disabled = true;
      setStatus('inviteStatus', code ? 'בודק הזמנה ומספר טלפון...' : 'בודק מספר טלפון ומייל...', false);
      try {
        if (!(await waitForPool(25))) {
          setStatus('inviteStatus', 'אין חיבור לריליים. נסו שוב בעוד רגע.', true);
          return false;
        }
        if (code) {
          if (typeof App.validateInvite !== 'function') {
            setStatus('inviteStatus', 'מנגנון ההזמנות לא נטען', true);
            return false;
          }
          var result = await App.validateInvite({ code: code, phone: phoneNorm.e164 });
          if (!result || !result.ok) {
            var errMsg = (result && result.error) || 'ההזמנה לא תקפה';
            if (result && result.code === 'WRONG_PHONE') errMsg = 'מספר הטלפון אינו תואם להזמנה.';
            setStatus('inviteStatus', errMsg, true);
            return false;
          }
          // WRONG_PHONE must not create identity — stop before key.
          signupData.inviteCode = result.code;
          signupData.invitePhone = phoneNorm.e164;
          signupData.invitePhoneHash = '';
          signupData.inviterPubkey = result.inviterPubkey || '';
          signupData.invitePurpose = result.purpose || 'NEW_ACCOUNT_INVITE';
          signupData.inviteEventId = result.inviteEvent && result.inviteEvent.id ? result.inviteEvent.id : '';
        } else {
          signupData.inviteCode = '';
          signupData.invitePhone = phoneNorm.e164;
          signupData.invitePurpose = '';
          signupData.inviteEventId = '';
        }

        setStatus('inviteStatus', 'בודק שהמייל פנוי...', false);
        var hash = await computeEmailHash(email);
        var availability = await checkEmailAvailability(hash);
        if (!availability.ok) {
          setStatus('inviteStatus', availability.error || 'לא ניתן לבדוק את המייל כרגע. נסו שוב.', true);
          return false;
        }
        if (availability.used) {
          setStatus('inviteStatus', 'המייל הזה כבר קיבל מפתח בעבר. התחברו עם המפתח הקיים.', true);
          return false;
        }
        signupData.email = email;
        signupData.emailHash = hash;
        signupData.name = '';
        signupData.avatarDataUrl = '';
        setStatus('inviteStatus', '', false);
        showStep('authStepKey');
        generateAndShowKey();
        return true;
      } catch (e) {
        setStatus('inviteStatus', 'שגיאה בבדיקת הזמנה: ' + (e.message || e), true);
        return false;
      } finally {
        if (btnInviteNext) btnInviteNext.disabled = false;
      }
    }

    if (btnInviteNext) {
      btnInviteNext.addEventListener('click', function() {
        submitInviteStep({ auto: false });
      });
    }

    function readInviteCodeFallback() {
      try {
        var params = new URLSearchParams(window.location.search || '');
        var fromQuery = (params.get('invite') || '').trim().toUpperCase();
        if (fromQuery) return fromQuery;
        var hash = String(window.location.hash || '');
        var match = hash.match(/invite=([A-Z0-9]+)/i);
        return match ? match[1].toUpperCase() : '';
      } catch (_) {
        return '';
      }
    }

    function openInviteDeepLinkFlow() {
      var code = (typeof App.getInviteCodeFromLocation === 'function'
        ? App.getInviteCodeFromLocation()
        : '') || readInviteCodeFallback();
      if (!code) return false;

      // אורח = אין זהות מאומתת (בלי לקרוא raw K)
      var isGuest = !isAuthenticatedIdentity();

      // AUTHENTICATED_EXISTING_P_CAN_PROCESS_COMMUNITY_INVITE=true
      // Existing P must never be pushed through new-signup / second identity.
      if (!isGuest) {
        processAuthenticatedCommunityInvite(code);
        return true;
      }

      if (signupInviteCodeInput) {
        signupInviteCodeInput.value = code;
      }

      App.openAuthPrompt('הזמנה זוהתה — הקוד כבר מולא. הזינו טלפון ומייל להמשך.', {
        step: 'invite',
        fromInviteLink: true
      });
      prefillInviteFromUrl(true);
      // Do not auto-submit: phone must be entered and verified against authoritative binding.
      setTimeout(function() {
        submitInviteStep({ auto: true });
      }, 400);
      return true;
    }

    async function processAuthenticatedCommunityInvite(code) {
      try {
        if (typeof App.validateInvite !== 'function' || typeof App.markInviteUsed !== 'function') return;
        var result = await App.validateInvite({ code: code });
        if (!result || !result.ok) {
          if (typeof App.showToast === 'function') {
            App.showToast((result && result.error) || 'ההזמנה אינה תקפה', 'error');
          }
          return;
        }
        var purpose = result.purpose || 'COMMUNITY_INVITE';
        if (purpose === 'NEW_ACCOUNT_INVITE') {
          // Already has global P — do not create another identity.
          if (typeof App.showToast === 'function') {
            App.showToast('כבר יש לכם חשבון SOS. הזמנה זו מיועדת למשתמש חדש.', 'info');
          }
          return;
        }
        var used = await App.markInviteUsed({
          code: code,
          inviterPubkey: result.inviterPubkey,
          inviteEventId: result.inviteEvent && result.inviteEvent.id
        });
        if (typeof App.showToast === 'function') {
          App.showToast(
            used && used.ok !== false ? 'ההזמנה מומשה עבור החשבון הקיים (אותו מפתח ציבורי).' : 'מימוש ההזמנה נכשל או כבר בוצע.',
            used && used.ok !== false ? 'success' : 'error'
          );
        }
      } catch (e) {
        if (typeof App.showToast === 'function') {
          App.showToast('שגיאה במימוש הזמנה: ' + (e && e.message ? e.message : 'שגיאה'), 'error');
        }
      }
    }

    // Legacy email-next → combined invite+phone+email submit
    if (btnEmailNext) {
      btnEmailNext.addEventListener('click', function() {
        showStep('authStepInvite');
        submitInviteStep({ auto: false });
      });
    }

    // הרשמה - שלב שם (legacy UI retained; no longer on the blocking new-user path)
    if (btnNameNext) {
      btnNameNext.addEventListener('click', function() {
        var name = signupNameInput.value.trim().slice(0, 15);
        if (!name) {
          setStatus('nameStatus', 'נא להזין שם', true);
          return;
        }
        signupData.name = name;
        showStep('authStepAvatar');
      });
    }

    // הרשמה - שלב אווטר
    if (btnChooseAvatar) {
      btnChooseAvatar.addEventListener('click', function() {
        signupAvatarInput.click();
      });
    }

    if (signupAvatarInput) {
      signupAvatarInput.addEventListener('change', function(e) {
        var file = e.target.files[0];
        if (!file) return;

        setStatus('avatarStatus', 'מעבד תמונה...', false);
        resizeImageToDataUrl(file, 400, function(dataUrl) {
          signupData.avatarDataUrl = dataUrl;
          avatarPreview.innerHTML = '<img src="' + dataUrl + '" style="width:100%; height:100%; object-fit:cover;" />';
          setStatus('avatarStatus', 'התמונה נטענה בהצלחה', false);
        });
      });
    }

    if (btnSkipAvatar) {
      btnSkipAvatar.addEventListener('click', function() {
        signupData.avatarDataUrl = '';
        showStep('authStepKey');
        generateAndShowKey();
      });
    }

    if (btnAvatarNext) {
      btnAvatarNext.addEventListener('click', function() {
        showStep('authStepKey');
        generateAndShowKey();
      });
    }

    // יצירת והצגת מפתח / F5A Worker vault create (ללא K בעמוד)
    function generateAndShowKey() {
      try {
        if (shouldUseWorkerCreate()) {
          signupData.privateKey = '';
          signupData.workerCreate = true;
          signupData.createNonce = 'c' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
          setWorkerKeyMode(true);
          setStatus('keyStatus', '', false);
          updateFinalConnectState();
          return;
        }
        setWorkerKeyMode(false);
        var privateKeyHex = generatePrivateKeyHex();
        var displayValue = encodeKeyForDisplay(privateKeyHex);
        signupData.privateKey = privateKeyHex;
        signupData.workerCreate = false;
        generatedKeyDisplay.value = displayValue;
        setStatus('keyStatus', '', false);
      } catch (e) {
        setStatus('keyStatus', 'שגיאה ביצירת מפתח: ' + e.message, true);
      }
    }

    // העתקת מפתח
    if (btnCopyKey) {
      btnCopyKey.addEventListener('click', async function() {
        if (signupData.workerCreate || !generatedKeyDisplay || !generatedKeyDisplay.value) return;
        try {
          await navigator.clipboard.writeText(generatedKeyDisplay.value);
          setStatus('keyStatus', 'המפתח הועתק ללוח', false);
        } catch (e) {
          setStatus('keyStatus', 'לא הצלחתי להעתיק', true);
        }
      });
    }

    // הורדת מפתח
    if (btnDownloadKey) {
      btnDownloadKey.addEventListener('click', function() {
        if (signupData.workerCreate || !generatedKeyDisplay || !generatedKeyDisplay.value) return;
        var blob = new Blob([generatedKeyDisplay.value], { type: 'text/plain' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'nostr-private-key.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setStatus('keyStatus', 'הקובץ נשמר', false);
      });
    }

    // אישור שמירת מפתח
    if (keyConfirmCheckbox) {
      keyConfirmCheckbox.addEventListener('change', updateFinalConnectState);
    }
    if (keyPolicyCheckbox) {
      keyPolicyCheckbox.addEventListener('change', updateFinalConnectState);
    }
    if (keyRightsCheckbox) {
      keyRightsCheckbox.addEventListener('change', updateFinalConnectState);
    }

    // התחברות סופית
    if (btnFinalConnect) {
      btnFinalConnect.addEventListener('click', async function() {
        if (keyPolicyCheckbox && !keyPolicyCheckbox.checked) {
          setStatus('keyStatus', 'נא לאשר את מדיניות התוכן לפני התחברות.', true);
          updateFinalConnectState();
          return;
        }
        if (keyRightsCheckbox && !keyRightsCheckbox.checked) {
          setStatus('keyStatus', 'יש לאשר שהזכויות לתוכן הן שלך.', true);
          updateFinalConnectState();
          return;
        }
        if (!signupData.workerCreate && !signupData.privateKey) {
          setStatus('keyStatus', 'אין מפתח', true);
          return;
        }
        if (signupData.workerCreate && !signupData.createNonce) {
          setStatus('keyStatus', 'חסר אסימון יצירה מאובטח', true);
          return;
        }
        if (!signupData.emailHash) {
          setStatus('keyStatus', 'חסר רישום מייל. חזרו לשלב המייל.', true);
          return;
        }
        if (requireInviteEnabled() && !signupData.inviteCode) {
          setStatus('keyStatus', 'חסרה הזמנה תקפה.', true);
          showStep('authStepInvite');
          return;
        }

        try {
          btnFinalConnect.disabled = true;

          if (requireInviteEnabled()) {
            setStatus('keyStatus', 'מאמת הזמנה מחדש...', false);
            if (!(await waitForPool(25))) {
              setStatus('keyStatus', 'אין חיבור לריליים. נסו שוב.', true);
              btnFinalConnect.disabled = false;
              updateFinalConnectState();
              return;
            }
            var inviteCheck = await App.validateInvite({
              code: signupData.inviteCode,
              phone: signupData.invitePhone
            });
            if (!inviteCheck || !inviteCheck.ok) {
              setStatus('keyStatus', (inviteCheck && inviteCheck.error) || 'ההזמנה כבר לא תקפה', true);
              btnFinalConnect.disabled = false;
              updateFinalConnectState();
              showStep('authStepInvite');
              return;
            }
            signupData.inviterPubkey = inviteCheck.inviterPubkey || signupData.inviterPubkey;
          }

          // F5A: Worker create BEFORE email/invite signing — no page K
          if (signupData.workerCreate) {
            setStatus('keyStatus', 'יוצר זהות מאובטחת בכספת...', false);
            // Fresh computer accounts must keep Worker vault authoritative across reload
            // so Chat has a signer without raw K in the main origin.
            try {
              if (typeof localStorage !== 'undefined') {
                localStorage.setItem('SOS_CRYPTO_WORKER_AUTHORITATIVE', '1');
              }
              window.SOS_CRYPTO_WORKER_AUTHORITATIVE = true;
              window.__SOS_CRYPTO_WORKER_AUTHORITATIVE__ = true;
            } catch (_flagOn) {}
            var createdW = await window.SosCryptoWorkerVault.createBrowserIdentity({
              createNonce: signupData.createNonce
            });
            if (!createdW || !createdW.ok) {
              setStatus('keyStatus', 'יצירת זהות נכשלה: ' + ((createdW && (createdW.code || createdW.message)) || 'שגיאה'), true);
              btnFinalConnect.disabled = false;
              updateFinalConnectState();
              return;
            }
            if (createdW.createNonce && createdW.createNonce !== signupData.createNonce) {
              setStatus('keyStatus', 'תשובת יצירה לא תואמת (stale) — נדחה.', true);
              btnFinalConnect.disabled = false;
              updateFinalConnectState();
              return;
            }
            App.privateKey = null;
            if (createdW.meta && createdW.meta.pubkey) {
              App.publicKey = createdW.meta.pubkey;
              if (typeof App.updateSubscriptionWithPubkey === 'function') {
                App.updateSubscriptionWithPubkey(createdW.meta.pubkey);
              }
            }
            App.guestMode = false;
            App.identityState = 'IDENTITY_OK';
            try {
              var actW = await window.SosCryptoWorkerVault.tryActivateAuthoritative();
              if (!actW || actW.ok !== true) {
                setStatus('keyStatus', 'יצירת זהות נשמרה אך אין סמכות חתימה. נסו שוב.', true);
                btnFinalConnect.disabled = false;
                updateFinalConnectState();
                return;
              }
            } catch (_act) {
              setStatus('keyStatus', 'יצירת זהות נשמרה אך אין סמכות חתימה. נסו שוב.', true);
              btnFinalConnect.disabled = false;
              updateFinalConnectState();
              return;
            }
            if (!(App.SosCryptoSigner && typeof App.SosCryptoSigner.hasIdentityKey === 'function' && App.SosCryptoSigner.hasIdentityKey())) {
              setStatus('keyStatus', 'אין חותם מוכן לחשבון החדש. נסו שוב.', true);
              btnFinalConnect.disabled = false;
              updateFinalConnectState();
              return;
            }
          }

          // לפני סימון הזמנה — שמירה עמידה של זהות חדשה (native/web).
          // אסור לשרוף הזמנה לפני שהזהות נשמרה בהצלחה.
          setStatus('keyStatus', 'שומר זהות...', false);
          if (signupData.workerCreate) {
            App.privateKey = null;
            // Coherent public snapshot — no secrets.
            try {
              if (typeof App.ensureKeys === 'function') {
                var ensuredW = App.ensureKeys();
                if (!ensuredW || ensuredW.ok !== true || ensuredW.state !== 'IDENTITY_OK') {
                  setStatus('keyStatus', 'זהות Worker לא אומתה כ-IDENTITY_OK.', true);
                  btnFinalConnect.disabled = false;
                  updateFinalConnectState();
                  return;
                }
              }
              App.guestMode = false;
              App.identityState = 'IDENTITY_OK';
              App._webAccountSnapshot = {
                authenticated: true,
                guest: false,
                accountP: String(App.publicKey || '').toLowerCase(),
                identityState: 'IDENTITY_OK',
                providerState:
                  (window.SOSKeyStorage &&
                    typeof window.SOSKeyStorage.getProviderState === 'function' &&
                    window.SOSKeyStorage.getProviderState()) ||
                  'WORKER_VAULT',
                hasSigner: !!(
                  App.SosCryptoSigner &&
                  typeof App.SosCryptoSigner.hasIdentityKey === 'function' &&
                  App.SosCryptoSigner.hasIdentityKey()
                ),
                workerAuthoritative: !!(
                  App.SosCryptoSigner &&
                  typeof App.SosCryptoSigner.isWorkerAuthoritative === 'function' &&
                  App.SosCryptoSigner.isWorkerAuthoritative()
                ),
              };
              if (!App._webAccountSnapshot.hasSigner || !App._webAccountSnapshot.accountP) {
                setStatus('keyStatus', 'אין חותם מוכן לפני סימון הזמנה.', true);
                btnFinalConnect.disabled = false;
                updateFinalConnectState();
                return;
              }
            } catch (_snap) {
              setStatus('keyStatus', 'כשל באימות זהות לפני הזמנה.', true);
              btnFinalConnect.disabled = false;
              updateFinalConnectState();
              return;
            }
          } else if (typeof App.createNewIdentityExplicit === 'function') {
            var created = App.createNewIdentityExplicit({ privateKeyHex: signupData.privateKey });
            if (!created || created.ok !== true) {
              setStatus('keyStatus', 'שגיאה בשמירת זהות חדשה', true);
              btnFinalConnect.disabled = false;
              updateFinalConnectState();
              return;
            }
            if (created.publicKey && typeof App.updateSubscriptionWithPubkey === 'function') {
              App.updateSubscriptionWithPubkey(created.publicKey);
            }
            // Keep hex only in-memory briefly for email/invite signing if needed.
            if (!created.typedOnly) {
              App.privateKey = signupData.privateKey;
            } else {
              App.privateKey = null;
              App.publicKey = created.publicKey;
            }
          } else {
            storeNostrPrivateKeyGuest(signupData.privateKey);
            App.privateKey = signupData.privateKey;
            if (typeof App.ensureKeys === 'function') {
              var resultEarly = App.ensureKeys();
              if (resultEarly && resultEarly.publicKey) {
                App.publicKey = resultEarly.publicKey;
                if (typeof App.updateSubscriptionWithPubkey === 'function') {
                  App.updateSubscriptionWithPubkey(resultEarly.publicKey);
                }
              }
            }
          }

          // לפני סיום — רושמים מייל ברשת כדי למנוע כפילויות | HYPER CORE TECH
          setStatus('keyStatus', 'רושם את המייל ברשת...', false);
          var emailReg = await publishAndVerifyEmailRegistry(
            signupData.emailHash,
            signupData.workerCreate ? null : signupData.privateKey
          );
          if (!emailReg.ok) {
            setStatus('keyStatus', 'לא ניתן להשלים הרשמה: ' + (emailReg.error || 'רישום מייל נכשל'), true);
            btnFinalConnect.disabled = false;
            updateFinalConnectState();
            return;
          }

          // סימון הזמנה כמשומשת רק אחרי שמירת זהות מוצלחת
          if (signupData.inviteCode && typeof App.markInviteUsed === 'function') {
            setStatus('keyStatus', 'מסמן את ההזמנה כמשומשת...', false);
            if (!signupData.workerCreate && App.privateKey) {
              if (typeof App.ensureKeys === 'function') {
                var inviteKeyResult = App.ensureKeys();
                if (!inviteKeyResult || inviteKeyResult.ok !== true) {
                  setStatus('keyStatus', 'ההרשמה נעצרה: מפתח לא תקין.', true);
                  btnFinalConnect.disabled = false;
                  updateFinalConnectState();
                  return;
                }
              }
            }
            var usedResult = await App.markInviteUsed({
              code: signupData.inviteCode,
              inviterPubkey: signupData.inviterPubkey,
              inviteEventId: signupData.inviteEventId,
              phone: signupData.invitePhone,
              purpose: signupData.invitePurpose || 'NEW_ACCOUNT_INVITE'
            });
            if (!usedResult || !usedResult.ok) {
              console.warn('Invite mark-used failed', usedResult && usedResult.code);
              setStatus(
                'keyStatus',
                usedResult && usedResult.userMessage
                  ? 'ההרשמה נעצרה: ' + usedResult.userMessage
                  : 'ההרשמה נעצרה: לא ניתן לסמן שההזמנה נוצלה. נסו שוב.',
                true
              );
              btnFinalConnect.disabled = false;
              updateFinalConnectState();
              return;
            }
            try {
              signupData._redeemMeta = {
                INVITE_REDEEMED_ONCE: usedResult.INVITE_REDEEMED_ONCE === true,
                GLOBAL_ACCOUNT_CREATED_ONCE: usedResult.GLOBAL_ACCOUNT_CREATED_ONCE === true,
                PHONE_BINDING_CREATED_ONCE: usedResult.PHONE_BINDING_CREATED_ONCE === true,
                MEMBERSHIP_FINALIZED_ONCE: usedResult.MEMBERSHIP_FINALIZED_ONCE === true
              };
            } catch (_rm) {}
          }

          setStatus('keyStatus', 'שומר נתונים...', false);
          if (signupData.workerCreate) {
            App.privateKey = null;
          }

          // Neutral pubkey fingerprint placeholder — never derive display name from email.
          var pkShort = String(App.publicKey || '').toLowerCase();
          var placeholderName = pkShort
            ? 'משתמש ' + pkShort.slice(0, 8)
            : 'משתמש';
          var profile = {
            name: signupData.name || placeholderName,
            picture: signupData.avatarDataUrl || '',
            about: '',
            banner: ''
          };
          App.profile = profile;
          window.localStorage.setItem('nostr_profile', JSON.stringify(profile));

          App.guestMode = false;
          try { if (typeof App.syncTopBarAuthUi === 'function') App.syncTopBarAuthUi(); } catch (_s) {}
          // Profile publish is optional after SOS; skip blocking publish when name/avatar were not collected.
          if (signupData.name || signupData.avatarDataUrl) {
            setStatus('keyStatus', 'מפרסם פרופיל...', false);
            if (typeof App.publishProfileMetadata === 'function') {
              try {
                await App.publishProfileMetadata();
              } catch (e) {
                console.warn('Profile publish failed', e);
              }
            }
          }

          if (signupData.workerCreate) {
            setStatus('keyStatus', '', false);
            showWorkerIdentityDone();
            return;
          }
          setStatus('keyStatus', 'מתחבר לרשת...', false);
          setTimeout(function() {
            window.location.reload();
          }, 1000);
        } catch (e) {
          console.error('Final connect error:', e);
          setStatus('keyStatus', 'שגיאה בהתחברות: ' + e.message, true);
          btnFinalConnect.disabled = false;
          updateFinalConnectState();
        }
      });
      updateFinalConnectState();
    }

    // הזמן חבר — בחירת איש קשר / הזנה ידנית + lookup לפני הזמנה
    var inviteFriendModal = document.getElementById('inviteFriendModal');
    var btnInvitePickContact = document.getElementById('btnInvitePickContact');
    var btnInviteManualPhone = document.getElementById('btnInviteManualPhone');
    var inviteFriendManualBlock = document.getElementById('inviteFriendManualBlock');
    var inviteFriendPhoneInput = document.getElementById('inviteFriendPhoneInput');
    var btnInviteFriendContinue = document.getElementById('btnInviteFriendContinue');
    var inviteFriendResult = document.getElementById('inviteFriendResult');
    var inviteFriendStatus = document.getElementById('inviteFriendStatus');
    var btnInviteFriendClose = document.getElementById('btnInviteFriendClose');

    function setInviteFriendStatus(msg, isError) {
      if (!inviteFriendStatus) return;
      inviteFriendStatus.textContent = msg || '';
      inviteFriendStatus.style.color = isError ? '#dc3545' : '#ffc107';
    }

    function openInviteFriendModal() {
      if (!inviteFriendModal) return;
      inviteFriendModal.hidden = false;
      inviteFriendModal.style.display = 'flex';
      inviteFriendModal.setAttribute('aria-hidden', 'false');
      if (inviteFriendManualBlock) inviteFriendManualBlock.hidden = true;
      if (inviteFriendResult) {
        inviteFriendResult.hidden = true;
        inviteFriendResult.innerHTML = '';
      }
      if (inviteFriendPhoneInput) inviteFriendPhoneInput.value = '';
      setInviteFriendStatus('', false);
      // Contact Picker: feature-detect; hide if unsupported (manual always works).
      var supported = !!(
        typeof navigator !== 'undefined' &&
        navigator.contacts &&
        typeof navigator.contacts.select === 'function'
      );
      if (btnInvitePickContact) {
        btnInvitePickContact.style.display = supported ? '' : 'none';
        btnInvitePickContact.hidden = !supported;
      }
    }

    function closeInviteFriendModal() {
      if (!inviteFriendModal) return;
      inviteFriendModal.hidden = true;
      inviteFriendModal.style.display = 'none';
      inviteFriendModal.setAttribute('aria-hidden', 'true');
    }

    async function resolveProfileCard(pubkey) {
      var name = 'משתמש ' + String(pubkey || '').slice(0, 8);
      var picture = '';
      try {
        if (typeof App.resolveProfileForPubkey === 'function') {
          var p = await App.resolveProfileForPubkey(pubkey);
          if (p && p.name) name = p.name;
          if (p && (p.picture || p.image)) picture = p.picture || p.image;
        } else if (typeof App.getCachedProfile === 'function') {
          var c = App.getCachedProfile(pubkey);
          if (c && c.name) name = c.name;
          if (c && c.picture) picture = c.picture;
        }
      } catch (_e) {}
      return { name: name, picture: picture, pubkey: pubkey };
    }

    async function handleInviteFriendPhone(rawPhone, localContactName) {
      var PN = App.PhoneNormalize || window.SosPhoneNormalize;
      var norm = PN && typeof PN.normalizePhoneE164 === 'function' ? PN.normalizePhoneE164(rawPhone) : null;
      if (!norm || !norm.ok) {
        setInviteFriendStatus('מספר טלפון לא תקין', true);
        return;
      }
      // CONTACT_NAME_BECOMES_GLOBAL_PROFILE=false — local display only, never sent as profile.
      var localLabel = localContactName ? String(localContactName).slice(0, 40) : '';
      setInviteFriendStatus('בודק מספר ב-SOS...', false);
      var GA = App.GlobalAdmission || window.SosGlobalAdmission;
      if (!GA || typeof GA.lookupPhone !== 'function') {
        setInviteFriendStatus('שירות החיפוש אינו זמין', true);
        return;
      }
      var look = await GA.lookupPhone(norm.e164);
      if (look && look.unavailable === true) {
        setInviteFriendStatus('לא ניתן לשלוח הזמנה למספר זה כרגע.', true);
        if (inviteFriendResult) {
          inviteFriendResult.hidden = false;
          inviteFriendResult.innerHTML = '<p style="color:#ccc;">לא ניתן לשלוח הזמנה למספר זה כרגע.</p>';
        }
        return;
      }
      if (look && look.registered === true && look.pubkey) {
        var card = await resolveProfileCard(look.pubkey);
        var display = localLabel ? localLabel + ' · ' + card.name : card.name;
        if (inviteFriendResult) {
          inviteFriendResult.hidden = false;
          inviteFriendResult.innerHTML =
            '<div style="padding:12px;border:1px solid #444;border-radius:10px;text-align:right;">' +
            '<p style="margin:0 0 8px;font-weight:600;">כבר נמצא ב-SOS</p>' +
            '<p style="margin:0 0 12px;color:#aaa;">' +
            display.replace(/[<>&]/g, '') +
            '</p>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<button type="button" class="button-primary" id="btnInviteOpenProfile" data-pk="' +
            look.pubkey +
            '">פתח פרופיל</button>' +
            '<button type="button" class="button-secondary" id="btnInviteSendMsg" data-pk="' +
            look.pubkey +
            '">שלח הודעה</button>' +
            '<button type="button" class="button-secondary" id="btnInviteCall" data-pk="' +
            look.pubkey +
            '">התקשר</button>' +
            '</div></div>';
          var openBtn = document.getElementById('btnInviteOpenProfile');
          var msgBtn = document.getElementById('btnInviteSendMsg');
          var callBtn = document.getElementById('btnInviteCall');
          if (openBtn) {
            openBtn.addEventListener('click', function() {
              closeInviteFriendModal();
              if (typeof App.openPublicProfile === 'function') App.openPublicProfile(look.pubkey);
              else if (typeof App.showProfile === 'function') App.showProfile(look.pubkey);
            });
          }
          if (msgBtn) {
            msgBtn.addEventListener('click', function() {
              closeInviteFriendModal();
              if (typeof App.showChatConversation === 'function') App.showChatConversation(look.pubkey);
              else if (typeof App.openChatList === 'function') App.openChatList();
            });
          }
          if (callBtn) {
            callBtn.addEventListener('click', function() {
              closeInviteFriendModal();
              if (typeof App.showChatConversation === 'function') App.showChatConversation(look.pubkey);
              if (App.voiceCall && typeof App.voiceCall.start === 'function') {
                App.voiceCall.start(look.pubkey);
              }
            });
          }
        }
        setInviteFriendStatus('', false);
        return;
      }
      // Case A: not registered → create NEW_ACCOUNT_INVITE + WhatsApp specific recipient
      setInviteFriendStatus('יוצר הזמנה...', false);
      try {
        var created = await App.createInvite({
          purpose: 'NEW_ACCOUNT_INVITE',
          recipientPhone: norm.e164
        });
        if (inviteFriendResult) {
          inviteFriendResult.hidden = false;
          inviteFriendResult.innerHTML =
            '<p style="margin:0 0 10px;">ההזמנה מוכנה' +
            (localLabel ? ' עבור ' + localLabel.replace(/[<>&]/g, '') : '') +
            '.</p>' +
            '<a class="button-primary" id="btnInviteWhatsAppGo" href="' +
            String(created.whatsappUrl || '#').replace(/"/g, '') +
            '" target="_blank" rel="noopener" style="display:inline-block;padding:12px 16px;text-decoration:none;">שלח הזמנה ב-WhatsApp</a>';
        }
        setInviteFriendStatus('', false);
        if (typeof App.showInviteQrModal === 'function' && created.inviteUrl) {
          try {
            await App.showInviteQrModal(created.inviteUrl, created.code);
          } catch (_qr) {}
        }
      } catch (e) {
        if (e && e.code === 'PHONE_ALREADY_REGISTERED') {
          setInviteFriendStatus('כבר נמצא ב-SOS', true);
        } else if (e && e.code === 'PHONE_UNAVAILABLE') {
          setInviteFriendStatus('לא ניתן לשלוח הזמנה למספר זה כרגע.', true);
        } else {
          setInviteFriendStatus((e && e.message) || 'יצירת ההזמנה נכשלה', true);
        }
      }
    }

    if (btnInviteFriendClose) btnInviteFriendClose.addEventListener('click', closeInviteFriendModal);
    if (btnInviteManualPhone) {
      btnInviteManualPhone.addEventListener('click', function() {
        if (inviteFriendManualBlock) inviteFriendManualBlock.hidden = false;
        if (inviteFriendPhoneInput) inviteFriendPhoneInput.focus();
      });
    }
    if (btnInviteFriendContinue) {
      btnInviteFriendContinue.addEventListener('click', function() {
        handleInviteFriendPhone(inviteFriendPhoneInput && inviteFriendPhoneInput.value);
      });
    }
    if (btnInvitePickContact) {
      btnInvitePickContact.addEventListener('click', async function() {
        try {
          if (!(navigator.contacts && typeof navigator.contacts.select === 'function')) {
            setInviteFriendStatus('בחירת אנשי קשר אינה נתמכת בדפדפן זה — הזינו מספר ידנית.', true);
            if (inviteFriendManualBlock) inviteFriendManualBlock.hidden = false;
            return;
          }
          // Minimum fields: phone required; name for local UI only. FULL_ADDRESS_BOOK_UPLOAD=false.
          var contacts = await navigator.contacts.select(['tel', 'name'], { multiple: false });
          var c0 = contacts && contacts[0];
          var tel = c0 && c0.tel && c0.tel[0] ? c0.tel[0] : '';
          var nm = c0 && c0.name && c0.name[0] ? c0.name[0] : '';
          if (!tel) {
            setInviteFriendStatus('לא נבחר מספר טלפון', true);
            return;
          }
          await handleInviteFriendPhone(tel, nm);
        } catch (e) {
          setInviteFriendStatus('בחירת איש קשר בוטלה או נכשלה — ניתן להזין ידנית.', true);
          if (inviteFriendManualBlock) inviteFriendManualBlock.hidden = false;
        }
      });
    }

    var btnOpenInviteFriend = document.getElementById('topBarInviteFriend');
    if (btnOpenInviteFriend) {
      btnOpenInviteFriend.addEventListener('click', async function() {
        var menu = document.getElementById('topBarProfileMenu');
        if (menu) menu.hidden = true;

        if (App.guestMode || !isAuthenticatedIdentity() || (typeof App.isAuthenticatedTopBarUi === 'function' && !App.isAuthenticatedTopBarUi())) {
          if (typeof App.openAuthPrompt === 'function') {
            App.openAuthPrompt('כדי להזמין חברים צריך להתחבר.');
          }
          return;
        }

        if (typeof App.refreshInviteAuthority === 'function') {
          btnOpenInviteFriend.disabled = true;
          await App.refreshInviteAuthority();
          btnOpenInviteFriend.disabled = false;
        }
        if (typeof App.canCreateInviteUi === 'function' && !App.canCreateInviteUi()) {
          alert('אין הרשאה ליצור הזמנה');
          return;
        }

        // Canonical INVITE_USERS path: COMMUNITY invite + QR modal (First Group remote inviter).
        // Phone-first NEW_ACCOUNT UX remains via openInviteFriendModal (lookup-before-invite);
        // do not replace this top-bar path with phone-only — that broke FG network e2e / sosInviteQrModal.
        btnOpenInviteFriend.disabled = true;
        try {
          if (typeof App.createInvite !== 'function') {
            throw new Error('מנגנון ההזמנות לא נטען');
          }
          var created = await App.createInvite();
          if (typeof App.showInviteQrModal === 'function' && created && created.inviteUrl) {
            try {
              await App.showInviteQrModal(created.inviteUrl, created.code);
            } catch (qrErr) {
              console.warn('[invite-qr] render failed', qrErr);
            }
          }
          if (typeof App.openWhatsAppInvite === 'function') {
            App.openWhatsAppInvite(created.whatsappUrl);
          } else if (created && created.whatsappUrl) {
            window.open(created.whatsappUrl, '_blank', 'noopener');
          }
        } catch (e) {
          alert((e && e.message) || 'יצירת ההזמנה נכשלה');
        } finally {
          btnOpenInviteFriend.disabled = false;
        }
      });
    }

    // Phone NEW_ACCOUNT invite modal (inviteFriendModal) remains for SO-CALL lookup-before-invite
    // flows; top-bar INVITE_USERS keeps COMMUNITY createInvite + sosInviteQrModal above.

    // אם נכנסו עם ?invite= — פותחים ישר את שלב ההזמנה עם קוד ממולא | HYPER CORE TECH
    try {
      var openedInvite = openInviteDeepLinkFlow();
      if (!openedInvite) {
        setTimeout(function() { openInviteDeepLinkFlow(); }, 500);
        setTimeout(function() { openInviteDeepLinkFlow(); }, 1500);
      }
      window.addEventListener('load', function() {
        openInviteDeepLinkFlow();
      });
    } catch (_) {}

    // הצגת כפתור "התחבר"/"הירשם" + הסתרת תפריט פרופיל — syncTopBarAuthUi | HYPER CORE TECH
    try {
      var guestLoginButton = document.getElementById('guestLoginButton');
      if (guestLoginButton && guestLoginButton.dataset.guestBound !== '1') {
        guestLoginButton.dataset.guestBound = '1';
        guestLoginButton.addEventListener('click', function () {
          var inviteCode = typeof App.getInviteCodeFromLocation === 'function'
            ? App.getInviteCodeFromLocation()
            : '';
          if (inviteCode) {
            App.openAuthPrompt('הזמנה זוהתה — הקוד כבר מולא. המשיכו בהרשמה.', {
              step: 'invite',
              fromInviteLink: true
            });
            setTimeout(function() { submitInviteStep({ auto: true }); }, 300);
          } else {
            App.openAuthPrompt('התחברו או הירשמו כדי ליצור פרופיל אישי, לייקים ותגובות.');
          }
        });

        var words = guestLoginButton.querySelectorAll('.guest-login-btn__word');
        if (words.length >= 2) {
          var wordIndex = 0;
          var reduceMotion = false;
          try {
            reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          } catch (_) {}
          if (!reduceMotion && !guestLoginButton._labelSwapTimer) {
            guestLoginButton._labelSwapTimer = setInterval(function () {
              if (!guestLoginButton.isConnected) {
                clearInterval(guestLoginButton._labelSwapTimer);
                guestLoginButton._labelSwapTimer = null;
                return;
              }
              words[wordIndex].classList.remove('is-visible');
              wordIndex = (wordIndex + 1) % words.length;
              words[wordIndex].classList.add('is-visible');
            }, 4000);
          }
        }
      }

      // Fail-closed until identity boot marks ready
      syncTopBarAuthUi();

      function markReadyAndSync() {
        App._topBarAuthUiReady = true;
        syncTopBarAuthUi();
      }

      try {
        var identityReady = window.SOSIdentityStorageReady || (window.SOSKeyStorage && window.SOSKeyStorage.ready);
        if (identityReady && typeof identityReady.then === 'function') {
          identityReady.then(function () {
            // After storage ready; bootGuestIdentity in app.js may still be mid-flight — sync again shortly
            markReadyAndSync();
            setTimeout(syncTopBarAuthUi, 0);
            setTimeout(syncTopBarAuthUi, 50);
          }).catch(function () {
            markReadyAndSync();
          });
        } else {
          markReadyAndSync();
        }
      } catch (_readyErr) {
        markReadyAndSync();
      }

      var gamesQuickBtn = document.getElementById('gamesToggleTop');
      if (gamesQuickBtn) {
        gamesQuickBtn.style.display = '';
        gamesQuickBtn.hidden = false;
      }
      var liveTvQuickBtn = document.getElementById('liveTvToggleTop');
      if (liveTvQuickBtn) {
        liveTvQuickBtn.style.display = '';
        liveTvQuickBtn.hidden = false;
      }
    } catch (e) {
      console.warn('Top-bar auth UI sync failed:', e);
    }
  });
})();
