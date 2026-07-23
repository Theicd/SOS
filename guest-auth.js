// =======================
// לוגיקת חלון התחברות / הרשמה למצב אורח (guest-auth.js) – Guest Auth Logic | HYPER CORE TECH
// קוד זה שייך ל-NostrApp ומתחבר ל-modal שהוגדר ב-videos.html
// משמש לחקות את חוויית טיקטוק - צפייה חופשית + התחברות קלה בעת פעולה
// =======================
(function initGuestAuthModal() {
  var App = window.NostrApp || (window.NostrApp = {});

  function storeNostrPrivateKeyGuest(hex) {
    if (window.SOSKeyStorage && typeof window.SOSKeyStorage.writePrivateKeyRaw === 'function') {
      window.SOSKeyStorage.writePrivateKeyRaw(hex);
    } else {
      try {
        window.localStorage.setItem('nostr_private_key', hex);
      } catch (_e) {}
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
    inviterPubkey: ''
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
      inviteCode: '',
      invitePhone: '',
      invitePhoneHash: '',
      inviterPubkey: ''
    };
  }

  function prefillInviteFromUrl() {
    var inviteInput = document.getElementById('signupInviteCodeInput');
    if (!inviteInput) return;
    if (inviteInput.value && inviteInput.value.trim()) return;
    if (typeof App.getInviteCodeFromLocation === 'function') {
      var code = App.getInviteCodeFromLocation();
      if (code) inviteInput.value = code;
    }
  }

  // פונקציה לפתיחת חלון ההתחברות/הרשמה
  App.openAuthPrompt = function(message) {
    var modal = document.getElementById('guestAuthModal');
    var reasonNode = document.getElementById('guestAuthModalReason');
    if (!modal) return;

    if (reasonNode) {
      reasonNode.textContent = message || 'כדי להמשיך צריך להתחבר או להירשם.';
    }
    showStep('authStepInitial');
    prefillInviteFromUrl();
    modal.style.display = 'flex';
  };

  // פונקציה לסגירת חלון ההתחברות/הרשמה
  App.closeAuthPrompt = function() {
    var modal = document.getElementById('guestAuthModal');
    if (!modal) return;
    modal.style.display = 'none';
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

    function updateFinalConnectState() {
      if (!btnFinalConnect) return;
      var confirmChecked = keyConfirmCheckbox ? keyConfirmCheckbox.checked : true;
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
        prefillInviteFromUrl();
        showStep(requireInviteEnabled() ? 'authStepInvite' : 'authStepEmail');
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
          storeNostrPrivateKeyGuest(privateKey);
          App.privateKey = privateKey;
          if (typeof App.ensureKeys === 'function') {
            App.ensureKeys();
          }
          App.guestMode = false;
          setStatus('loginStatus', 'מתחבר...', false);
          setTimeout(function() {
            window.location.reload();
          }, 500);
        } catch (e) {
          setStatus('loginStatus', 'שגיאה בשמירת המפתח', true);
        }
      });
    }

    // הרשמה - שלב הזמנה
    if (btnInviteNext) {
      btnInviteNext.addEventListener('click', async function() {
        var code = (signupInviteCodeInput && signupInviteCodeInput.value || '').trim().toUpperCase();
        var phone = (signupInvitePhoneInput && signupInvitePhoneInput.value || '').trim();
        btnInviteNext.disabled = true;
        setStatus('inviteStatus', 'בודק הזמנה...', false);
        try {
          if (!(await waitForPool(25))) {
            setStatus('inviteStatus', 'אין חיבור לריליים. נסו שוב בעוד רגע.', true);
            return;
          }
          if (typeof App.validateInvite !== 'function') {
            setStatus('inviteStatus', 'מנגנון ההזמנות לא נטען', true);
            return;
          }
          var result = await App.validateInvite({ code: code, phone: phone });
          if (!result || !result.ok) {
            setStatus('inviteStatus', (result && result.error) || 'ההזמנה לא תקפה', true);
            return;
          }
          signupData.inviteCode = result.code;
          signupData.invitePhone = phone || '';
          signupData.invitePhoneHash = result.phoneHash || '';
          signupData.inviterPubkey = result.inviterPubkey || '';
          setStatus('inviteStatus', '', false);
          showStep('authStepEmail');
        } catch (e) {
          setStatus('inviteStatus', 'שגיאה בבדיקת הזמנה: ' + (e.message || e), true);
        } finally {
          btnInviteNext.disabled = false;
        }
      });
    }

    // הרשמה - שלב מייל
    if (btnEmailNext) {
      btnEmailNext.addEventListener('click', async function() {
        var email = normalizeEmail(signupEmailInput && signupEmailInput.value);
        if (signupLegalCheckbox && !signupLegalCheckbox.checked) {
          setStatus('emailStatus', 'נא לאשר את תנאי השימוש לפני המשך.', true);
          return;
        }
        if (!isValidEmail(email)) {
          setStatus('emailStatus', 'נא להזין כתובת מייל תקינה', true);
          return;
        }
        if (requireInviteEnabled() && !signupData.inviteCode) {
          setStatus('emailStatus', 'חסרה הזמנה תקפה. חזרו לשלב ההזמנה.', true);
          showStep('authStepInvite');
          return;
        }

        btnEmailNext.disabled = true;
        setStatus('emailStatus', 'בודק שהמייל פנוי...', false);

        try {
          var hash = await computeEmailHash(email);
          var availability = await checkEmailAvailability(hash);
          if (!availability.ok) {
            setStatus('emailStatus', availability.error || 'לא ניתן לבדוק את המייל כרגע. נסו שוב.', true);
            return;
          }
          if (availability.used) {
            setStatus('emailStatus', 'המייל הזה כבר קיבל מפתח בעבר. התחברו עם המפתח הקיים.', true);
            return;
          }
          signupData.email = email;
          signupData.emailHash = hash;
          setStatus('emailStatus', '', false);
          showStep('authStepName');
        } catch (e) {
          console.error('Email check error:', e);
          setStatus('emailStatus', 'שגיאה בבדיקת המייל: ' + e.message, true);
        } finally {
          btnEmailNext.disabled = false;
        }
      });
    }

    // הרשמה - שלב שם
    if (btnNameNext) {
      btnNameNext.addEventListener('click', function() {
        var name = signupNameInput.value.trim();
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

    // יצירת והצגת מפתח
    function generateAndShowKey() {
      try {
        var privateKeyHex = generatePrivateKeyHex();
        var displayValue = encodeKeyForDisplay(privateKeyHex);
        signupData.privateKey = privateKeyHex;
        generatedKeyDisplay.value = displayValue;
        setStatus('keyStatus', '', false);
      } catch (e) {
        setStatus('keyStatus', 'שגיאה ביצירת מפתח: ' + e.message, true);
      }
    }

    // העתקת מפתח
    if (btnCopyKey) {
      btnCopyKey.addEventListener('click', async function() {
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
        if (!signupData.privateKey) {
          setStatus('keyStatus', 'אין מפתח', true);
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

          // לפני שמירה מקומית — רושמים מייל ברשת כדי למנוע כפילויות | HYPER CORE TECH
          setStatus('keyStatus', 'רושם את המייל ברשת...', false);
          var emailReg = await publishAndVerifyEmailRegistry(signupData.emailHash, signupData.privateKey);
          if (!emailReg.ok) {
            setStatus('keyStatus', 'לא ניתן להשלים הרשמה: ' + (emailReg.error || 'רישום מייל נכשל'), true);
            btnFinalConnect.disabled = false;
            updateFinalConnectState();
            return;
          }

          // סימון הזמנה כמשומשת (לפני reload)
          if (signupData.inviteCode && typeof App.markInviteUsed === 'function') {
            setStatus('keyStatus', 'מסמן את ההזמנה כמשומשת...', false);
            // זמנית שמים מפתח כדי ש-markInviteUsed יוכל לחתום
            App.privateKey = signupData.privateKey;
            if (typeof App.ensureKeys === 'function') {
              App.ensureKeys();
            }
            var usedResult = await App.markInviteUsed({
              code: signupData.inviteCode,
              inviterPubkey: signupData.inviterPubkey
            });
            if (!usedResult || !usedResult.ok) {
              console.warn('Invite mark-used failed', usedResult);
              setStatus('keyStatus', 'ההרשמה נעצרה: לא ניתן לסמן שההזמנה נוצלה. נסו שוב.', true);
              btnFinalConnect.disabled = false;
              updateFinalConnectState();
              return;
            }
          }

          setStatus('keyStatus', 'שומר נתונים...', false);
          storeNostrPrivateKeyGuest(signupData.privateKey);
          App.privateKey = signupData.privateKey;
          
          if (typeof App.ensureKeys === 'function') {
            var result = App.ensureKeys();
            if (result && result.publicKey) {
              App.publicKey = result.publicKey;
              if (typeof App.updateSubscriptionWithPubkey === 'function') {
                App.updateSubscriptionWithPubkey(result.publicKey);
              }
            }
          }

          var profile = {
            name: signupData.name || 'משתמש אנונימי',
            picture: signupData.avatarDataUrl || '',
            about: '',
            banner: ''
          };
          App.profile = profile;
          window.localStorage.setItem('nostr_profile', JSON.stringify(profile));

          App.guestMode = false;
          setStatus('keyStatus', 'מפרסם פרופיל...', false);

          if (typeof App.publishProfileMetadata === 'function') {
            try {
              await App.publishProfileMetadata();
              console.log('Profile published successfully');
            } catch (e) {
              console.warn('Profile publish failed', e);
            }
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

    // כפתור הזמן משתמש — פותח וואטסאפ לבחירת איש קשר (בלי הקלדת טלפון) | HYPER CORE TECH
    var btnOpenInviteFriend = document.getElementById('topBarInviteFriend');
    if (btnOpenInviteFriend) {
      btnOpenInviteFriend.addEventListener('click', async function() {
        var menu = document.getElementById('topBarProfileMenu');
        if (menu) menu.hidden = true;

        if (App.guestMode || !App.privateKey) {
          if (typeof App.openAuthPrompt === 'function') {
            App.openAuthPrompt('כדי להזמין חברים צריך להתחבר.');
          }
          return;
        }

        btnOpenInviteFriend.disabled = true;
        try {
          if (typeof App.createInvite !== 'function') {
            throw new Error('מנגנון ההזמנות לא נטען');
          }
          var created = await App.createInvite();
          if (typeof App.openWhatsAppInvite === 'function') {
            App.openWhatsAppInvite(created.whatsappUrl);
          } else {
            window.open(created.whatsappUrl, '_blank', 'noopener');
          }
        } catch (e) {
          alert(e.message || 'יצירת ההזמנה נכשלה');
        } finally {
          btnOpenInviteFriend.disabled = false;
        }
      });
    }

    // אם נכנסו עם ?invite= — פותחים הרשמה ישירות לשלב ההזמנה
    try {
      prefillInviteFromUrl();
      if (typeof App.getInviteCodeFromLocation === 'function' && App.getInviteCodeFromLocation()) {
        var isGuest = !!(App.guestMode === true || !App.privateKey);
        if (isGuest) {
          setTimeout(function() {
            App.openAuthPrompt('יש לכם הזמנה לרשת. המשיכו בפתיחת משתמש חדש.');
            if (requireInviteEnabled()) showStep('authStepInvite');
          }, 600);
        }
      }
    } catch (_) {}

    // הצגת כפתור "התחבר / הירשם" רק במצב אורח
    try {
      var isGuest = !!(App.guestMode === true || !App.privateKey);
      if (guestLoginButton && isGuest) {
        guestLoginButton.style.display = 'inline-block';
        guestLoginButton.addEventListener('click', function () {
          App.openAuthPrompt('התחברו או הירשמו כדי ליצור פרופיל אישי, לייקים ותגובות.');
        });
      }
    } catch (e) {
      console.warn('Guest login button init failed:', e);
    }

    // הסתרת תפריט הפרופיל במצב אורח
    try {
      var topBarProfile = document.getElementById('topBarProfile');
      if (topBarProfile && App.guestMode === true) {
        topBarProfile.style.display = 'none';
      }
    } catch (e) {
      console.warn('Profile menu hide failed:', e);
    }
  });
})();
