// =======================
// לוגיקת חלון התחברות / הרשמה למצב אורח (guest-auth.js) – Guest Auth Logic | HYPER CORE TECH
// קוד זה שייך ל-NostrApp ומתחבר ל-modal שהוגדר ב-videos.html
// משמש לחקות את חוויית טיקטוק - צפייה חופשית + התחברות קלה בעת פעולה
// =======================
(function initGuestAuthModal() {
  var App = window.NostrApp || (window.NostrApp = {});

  // משתנים גלובליים לשמירת נתוני ההרשמה
  var signupData = {
    email: '',
    emailHash: '',
    name: '',
    avatarDataUrl: '',
    privateKey: ''
  };

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
    var normalized = email.trim().toLowerCase();
    var encoder = new TextEncoder();
    var data = encoder.encode(normalized);
    var hashBuffer = await crypto.subtle.digest('SHA-256', data);
    var hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(function(b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  async function isEmailHashRegistered(hash) {
    if (!App.pool || !Array.isArray(App.relayUrls) || !App.EMAIL_REGISTRY_KIND) {
      console.warn('Pool or relays not ready for email check');
      return false;
    }
    try {
      var tagKey = App.EMAIL_REGISTRY_HASH_TAG || 'h';
      var filter = {
        kinds: [App.EMAIL_REGISTRY_KIND],
        limit: 10
      };
      filter['#' + tagKey] = [hash];
      
      // ניסיון עם שיטות שונות של pool
      var events = [];
      if (typeof App.pool.querySync === 'function') {
        events = await App.pool.querySync(App.relayUrls, filter);
      } else if (typeof App.pool.list === 'function') {
        events = await App.pool.list(App.relayUrls, [filter]);
      } else if (typeof App.pool.get === 'function') {
        var event = await App.pool.get(App.relayUrls, filter);
        if (event) events = [event];
      }
      
      console.log('Email hash check result:', { hash: hash.slice(0, 8), found: events.length > 0 });
      return events && events.length > 0;
    } catch (e) {
      console.error('Email hash check failed', e);
      return false;
    }
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
    var steps = ['authStepInitial', 'authStepLogin', 'authStepEmail', 'authStepName', 'authStepAvatar', 'authStepKey'];
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

  // פונקציה לפתיחת חלון ההתחברות/הרשמה
  App.openAuthPrompt = function(message) {
    var modal = document.getElementById('guestAuthModal');
    var reasonNode = document.getElementById('guestAuthModalReason');
    if (!modal) return;

    if (reasonNode) {
      reasonNode.textContent = message || 'כדי להמשיך צריך להתחבר או להירשם.';
    }
    showStep('authStepInitial');
    modal.style.display = 'flex';
  };

  // פונקציה לסגירת חלון ההתחברות/הרשמה
  App.closeAuthPrompt = function() {
    var modal = document.getElementById('guestAuthModal');
    if (!modal) return;
    modal.style.display = 'none';
    showStep('authStepInitial');
    signupData = { email: '', emailHash: '', name: '', avatarDataUrl: '', privateKey: '' };
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

    // סגירה וחזרה
    if (closeBtn) closeBtn.addEventListener('click', App.closeAuthPrompt);
    if (btnBackFromLogin) btnBackFromLogin.addEventListener('click', function() { showStep('authStepInitial'); });
    if (btnBackFromEmail) btnBackFromEmail.addEventListener('click', function() { showStep('authStepInitial'); });
    if (btnBackFromName) btnBackFromName.addEventListener('click', function() { showStep('authStepEmail'); });
    if (btnBackFromAvatar) btnBackFromAvatar.addEventListener('click', function() { showStep('authStepName'); });

    // מעבר לשלבים
    if (btnStartLogin) btnStartLogin.addEventListener('click', function() { showStep('authStepLogin'); });
    if (btnStartSignup) btnStartSignup.addEventListener('click', function() { showStep('authStepEmail'); });

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
          window.localStorage.setItem('nostr_private_key', privateKey);
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

    // הרשמה - שלב מייל
    if (btnEmailNext) {
      btnEmailNext.addEventListener('click', async function() {
        var email = signupEmailInput.value.trim();
        if (signupLegalCheckbox && !signupLegalCheckbox.checked) {
          setStatus('emailStatus', 'נא לאשר את תנאי השימוש לפני המשך.', true);
          return;
        }
        if (!email || !/\S+@\S+\.\S+/.test(email)) {
          setStatus('emailStatus', 'נא להזין כתובת מייל תקינה', true);
          return;
        }

        btnEmailNext.disabled = true;
        setStatus('emailStatus', 'בודק...', false);

        try {
          // המתנה ל-pool אם עדיין לא מוכן
          var attempts = 0;
          while ((!App.pool || !App.relayUrls) && attempts < 20) {
            await new Promise(function(resolve) { setTimeout(resolve, 200); });
            attempts++;
          }

          var hash = await computeEmailHash(email);
          var used = await isEmailHashRegistered(hash);
          if (used) {
            setStatus('emailStatus', 'המייל הזה כבר קיבל מפתח בעבר. נסה להתחבר עם המפתח הקיים.', true);
            btnEmailNext.disabled = false;
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

        try {
          btnFinalConnect.disabled = true;
          setStatus('keyStatus', 'שומר נתונים...', false);

          window.localStorage.setItem('nostr_private_key', signupData.privateKey);
          App.privateKey = signupData.privateKey;
          
          if (typeof App.ensureKeys === 'function') {
            var result = App.ensureKeys();
            if (result && result.publicKey) {
              App.publicKey = result.publicKey;
              // עדכון מנוי Push עם ה-pubkey החדש | HYPER CORE TECH
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

          // פרסום פרופיל לרשת
          if (typeof App.publishProfileMetadata === 'function') {
            try {
              await App.publishProfileMetadata();
              console.log('Profile published successfully');
            } catch (e) {
              console.warn('Profile publish failed', e);
            }
          }

          // פרסום רישום מייל אם יש
          if (signupData.emailHash && typeof App.publishEmailRegistry === 'function') {
            try {
              await App.publishEmailRegistry(signupData.emailHash);
              console.log('Email registry published');
            } catch (e) {
              console.warn('Email registry publish failed', e);
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
        }
      });
      updateFinalConnectState();
    }

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
