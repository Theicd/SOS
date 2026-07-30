// חלק PWA (pwa-installer.js) – התקנת האפליקציה כ-PWA ותמיכה במערכות הפעלה שונות | HYPER CORE TECH
(function initPwaInstaller(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // משתנים גלובליים
  let deferredInstallPrompt = null;
  let isInstalled = false;

  // חלק זיהוי פלטפורמה (pwa-installer.js) – זיהוי סוג המכשיר ומערכת ההפעלה | HYPER CORE TECH
  function getPlatformInfo() {
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    const isAndroid = /Android/i.test(ua);
    const isMac = /Macintosh|MacIntel|MacPPC|Mac68K/.test(ua);
    const isWindows = /Win32|Win64|Windows|WinCE/.test(ua);
    const isLinux = /Linux/.test(ua) && !isAndroid;
    const isSafari = /Safari/i.test(ua) && !/Chrome|CriOS|Chromium/i.test(ua);
    const isChrome = /Chrome|CriOS/i.test(ua) && !/Edge|Edg/i.test(ua);
    const isFirefox = /Firefox/i.test(ua);
    const isEdge = /Edge|Edg/i.test(ua);
    
    return {
      isIOS,
      isAndroid,
      isMac,
      isWindows,
      isLinux,
      isSafari,
      isChrome,
      isFirefox,
      isEdge,
      isMobile: isIOS || isAndroid,
      isDesktop: isMac || isWindows || isLinux,
    };
  }

  // חלק בדיקת התקנה (pwa-installer.js) – בודק אם האפליקציה כבר מותקנת | HYPER CORE TECH
  function checkIfInstalled() {
    // בדיקה דרך display-mode
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
      return true;
    }
    // בדיקה דרך navigator.standalone (iOS Safari)
    if (navigator.standalone === true) {
      return true;
    }
    // בדיקה דרך document.referrer (Android TWA)
    if (document.referrer && document.referrer.includes('android-app://')) {
      return true;
    }
    return false;
  }

  // חלק רישום SW (pwa-installer.js) – רישום Service Worker | HYPER CORE TECH
  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      console.warn('[PWA] Service Worker לא נתמך בדפדפן זה');
      return null;
    }
    if (!window.isSecureContext) {
      console.warn('[PWA] Service Worker דורש HTTPS');
      return null;
    }
    try {
      const registration = await navigator.serviceWorker.register('./service-worker.js', { scope: './' });
      console.log('[PWA] Service Worker נרשם בהצלחה', registration.scope);
      
      // אם יש גרסה ממתינה, נבקש ממנה להפעיל את עצמה
      if (registration.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
      
      // האזנה לעדכונים
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[PWA] גרסה חדשה זמינה');
              // אפשר להציג הודעה למשתמש לרענן
              if (typeof App.showUpdateAvailableToast === 'function') {
                App.showUpdateAvailableToast();
              }
            }
          });
        }
      });
      
      return registration;
    } catch (err) {
      console.error('[PWA] שגיאה ברישום Service Worker:', err);
      return null;
    }
  }

  // חלק beforeinstallprompt (pwa-installer.js) – האזנה לאירוע התקנה | HYPER CORE TECH
  function getDeferredPrompt() {
    if (!deferredInstallPrompt && window.deferredPwaPrompt) {
      deferredInstallPrompt = window.deferredPwaPrompt;
    }
    return deferredInstallPrompt || window.deferredPwaPrompt || null;
  }

  function pwaToast(message) {
    if (typeof App.showToast === 'function') {
      App.showToast(message);
      return;
    }
    console.log('[PWA]', message);
  }

  // חלק Push אחרי התקנה (pwa-installer.js) – חיוני להתראות עם מסך כבוי | HYPER CORE TECH
  // forcePermissionPrompt=true רק אחרי התקנה טרייה – לא בכל פתיחת PWA | HYPER CORE TECH
  function ensurePushAfterInstall(options) {
    const forcePermissionPrompt = !!(options && options.forcePermissionPrompt);
    if (forcePermissionPrompt) {
      try {
        localStorage.removeItem('push_modal_dismissed');
      } catch (_) {}
    }

    const run = () => {
      if (forcePermissionPrompt && typeof App.ensurePushReady === 'function') {
        App.ensurePushReady();
        return;
      }
      if (typeof App.initPushNotifications === 'function') {
        App.initPushNotifications();
        return;
      }
      if (typeof App.initPushSubscription === 'function') {
        App.initPushSubscription();
        return;
      }
      if (forcePermissionPrompt && typeof App.showPushPermissionModal === 'function') {
        App.showPushPermissionModal();
      }
    };

    setTimeout(run, 900);
  }

  function setupInstallPromptListener() {
    console.log('[PWA] מאזין לאירוע beforeinstallprompt...');
    
    // בדיקה אם כבר יש prompt שמור מקודם (יכול לקרות אם הקוד נטען מאוחר)
    if (window.deferredPwaPrompt) {
      deferredInstallPrompt = window.deferredPwaPrompt;
      console.log('[PWA] נמצא prompt שמור מקודם!');
    }
    
    window.addEventListener('beforeinstallprompt', (event) => {
      // מניעת הופעה אוטומטית של הבאנר
      event.preventDefault();
      // שמירת האירוע לשימוש מאוחר יותר
      deferredInstallPrompt = event;
      window.deferredPwaPrompt = event;
      console.log('[PWA] ✅ אירוע beforeinstallprompt נתפס - הדפדפן תומך בהתקנה!');
      
      // עדכון כפתור ההתקנה בדסקטופ
      const chatInstallBtn = document.getElementById('chatWelcomeInstallBtn');
      if (chatInstallBtn) {
        chatInstallBtn.classList.add('pwa-ready');
        console.log('[PWA] כפתור התקנה מוכן');
      }
      
      // הצגת כפתור התקנה אם קיים
      showInstallButton();
    });

    // האזנה לאירוע התקנה מוצלחת
    window.addEventListener('appinstalled', () => {
      console.log('[PWA] האפליקציה הותקנה בהצלחה!');
      isInstalled = true;
      deferredInstallPrompt = null;
      window.deferredPwaPrompt = null;
      try {
        localStorage.setItem('pwa_installed', 'true');
      } catch (_) {}
      const banner = document.getElementById('pwa-install-banner');
      if (banner) banner.remove();
      
      pwaToast('האפליקציה הותקנה בהצלחה');
      // קריטי: בלי מנוי Push אין התראות כשהמסך כבוי | HYPER CORE TECH
      ensurePushAfterInstall({ forcePermissionPrompt: true });
    });
  }

  // חלק מדריך Chrome (pwa-installer.js) – כשאין beforeinstallprompt אבל Chrome תומך | HYPER CORE TECH
  function showChromeInstallGuide() {
    const existingDialog = document.getElementById('chrome-install-guide');
    if (existingDialog) {
      existingDialog.showModal?.() || (existingDialog.style.display = 'flex');
      return;
    }

    const platform = getPlatformInfo();
    const mobileHint = platform.isAndroid
      ? 'ב־Chrome במובייל: תפריט ⋮ → <strong>התקן אפליקציה</strong> / Install app'
      : 'ב־Chrome במחשב: אייקון ההתקנה בשורת הכתובת, או תפריט ⋮ → <strong>התקן את SOS</strong> / Install SOS';

    const dialog = document.createElement('dialog');
    dialog.id = 'chrome-install-guide';
    dialog.className = 'pwa-install-dialog';
    dialog.innerHTML = `
      <div class="pwa-install-dialog__content">
        <h2>התקנת SOS ב־Chrome</h2>
        <div class="pwa-install-steps">
          <div class="pwa-install-step">
            <span class="pwa-install-step__number">1</span>
            <span>${mobileHint}</span>
          </div>
          <div class="pwa-install-step">
            <span class="pwa-install-step__number">2</span>
            <span>אשר את ההתקנה בחלון של Chrome</span>
          </div>
          <div class="pwa-install-step">
            <span class="pwa-install-step__number">3</span>
            <span>פתח את SOS מהאייקון ואשר <strong>התראות</strong> – כדי לקבל הודעות גם כשהמסך כבוי</span>
          </div>
        </div>
        <p class="pwa-install-note">Chrome תומך בהתקנה. אם הכפתור לא פתח דיאלוג – ההתקנה זמינה מתפריט הדפדפן (לפעמים אחרי שההצעה נדחתה בעבר).</p>
        <button type="button" class="pwa-install-dialog__close" id="chromeInstallGuideClose">הבנתי</button>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.querySelector('#chromeInstallGuideClose')?.addEventListener('click', () => {
      dialog.close?.();
      dialog.remove();
    });
    dialog.showModal?.() || (dialog.style.display = 'flex');
  }

  // חלק הפעלת התקנה מלחיצה (pwa-installer.js) – דיאלוג native בלבד, בלי באנר | HYPER CORE TECH
  function runInstallFromUserGesture() {
    if (checkIfInstalled()) {
      isInstalled = true;
      pwaToast('הממשק כבר מותקן – פתח אותו מהאייקון');
      ensurePushAfterInstall();
      return { outcome: 'already_installed' };
    }

    const platform = getPlatformInfo();
    if (platform.isIOS) {
      showIOSInstallGuide();
      return { outcome: 'ios_manual', platform: 'ios' };
    }

    const promptEvent = getDeferredPrompt();
    if (promptEvent && typeof promptEvent.prompt === 'function') {
      try {
        promptEvent.prompt();
        Promise.resolve(promptEvent.userChoice).then((choiceResult) => {
          console.log('[PWA] תוצאת התקנה:', choiceResult && choiceResult.outcome);
          deferredInstallPrompt = null;
          window.deferredPwaPrompt = null;
          if (choiceResult && choiceResult.outcome === 'accepted') {
            isInstalled = true;
            try { localStorage.setItem('pwa_installed', 'true'); } catch (_) {}
            const banner = document.getElementById('pwa-install-banner');
            if (banner) banner.remove();
            pwaToast('הממשק מותקן בהצלחה');
            ensurePushAfterInstall({ forcePermissionPrompt: true });
          } else if (choiceResult && choiceResult.outcome === 'dismissed') {
            pwaToast('ההתקנה בוטלה – אפשר לנסות שוב מתפריט Chrome');
          }
        }).catch((err) => {
          console.error('[PWA] שגיאה ב-userChoice:', err);
        });
        return { outcome: 'prompted' };
      } catch (err) {
        console.error('[PWA] שגיאה בהפעלת prompt:', err);
        pwaToast('לא ניתן להפעיל התקנה כרגע');
        return { outcome: 'error', error: err.message };
      }
    }

    // אין beforeinstallprompt – זה לא אומר שאין תמיכה ב־Chrome | HYPER CORE TECH
    if (platform.isFirefox) {
      showFirefoxInstallGuide();
      return { outcome: 'manual_guide', platform: 'firefox' };
    }

    showChromeInstallGuide();
    return { outcome: 'manual_guide', platform: platform.isChrome || platform.isEdge ? 'chrome' : 'unknown' };
  }

  // חלק הפעלת התקנה (pwa-installer.js) – הפעלת דיאלוג ההתקנה | HYPER CORE TECH
  async function promptInstall() {
    return runInstallFromUserGesture();
  }

  // חלק UI התקנה (pwa-installer.js) – הצגת והסתרת כפתור התקנה | HYPER CORE TECH
  function showInstallButton() {
    const btn = document.getElementById('pwa-install-btn');
    if (btn) {
      btn.removeAttribute('hidden');
      btn.style.display = '';
    }
    // עדכון כפתור בתפריט אם קיים
    const menuBtn = document.getElementById('pwa-install-menu-btn');
    if (menuBtn) {
      menuBtn.removeAttribute('hidden');
    }
  }

  function hideInstallButton() {
    const btn = document.getElementById('pwa-install-btn');
    if (btn) {
      btn.setAttribute('hidden', '');
      btn.style.display = 'none';
    }
    // כפתור בתפריט הפרופיל נשאר קבוע – לא מסתירים | HYPER CORE TECH
  }

  // חלק כפתור תפריט (pwa-installer.js) – התקנה ישירה בלי באנר תחתון | HYPER CORE TECH
  function bindInstallMenuButton() {
    const menuBtn = document.getElementById('pwa-install-menu-btn');
    if (!menuBtn || menuBtn.dataset.bound === '1') return;
    menuBtn.dataset.bound = '1';
    menuBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();

      const profileMenu = document.getElementById('topBarProfileMenu');
      const profileBtn = document.getElementById('topBarProfileButton');
      if (profileMenu) profileMenu.hidden = true;
      if (profileBtn) profileBtn.setAttribute('aria-expanded', 'false');

      // לא לפתוח באנר תחתון – רק דיאלוג native / מדריך התקנה | HYPER CORE TECH
      const existingBanner = document.getElementById('pwa-install-banner');
      if (existingBanner) existingBanner.remove();

      runInstallFromUserGesture();
    });
  }

  // חלק הנחיות iOS (pwa-installer.js) – מדריך התקנה ידנית ל-iOS | HYPER CORE TECH
  function showIOSInstallGuide() {
    const existingDialog = document.getElementById('ios-install-guide');
    if (existingDialog) {
      existingDialog.showModal?.() || (existingDialog.style.display = 'flex');
      return;
    }
    
    const dialog = document.createElement('dialog');
    dialog.id = 'ios-install-guide';
    dialog.className = 'pwa-install-dialog';
    dialog.innerHTML = `
      <div class="pwa-install-dialog__content">
        <h2>📱 התקנת SOS באייפון</h2>
        <div class="pwa-install-steps">
          <div class="pwa-install-step">
            <span class="pwa-install-step__number">1</span>
            <span>לחץ על כפתור השיתוף <i class="fa-solid fa-arrow-up-from-bracket"></i> בתחתית המסך</span>
          </div>
          <div class="pwa-install-step">
            <span class="pwa-install-step__number">2</span>
            <span>גלול למטה ולחץ על "Add to Home Screen" או "הוסף למסך הבית"</span>
          </div>
          <div class="pwa-install-step">
            <span class="pwa-install-step__number">3</span>
            <span>לחץ "Add" או "הוסף" בפינה הימנית העליונה</span>
          </div>
        </div>
        <p class="pwa-install-note">💡 לאחר ההתקנה, האפליקציה תפעל במסך מלא ותתמוך בהתראות Push!</p>
        <button type="button" class="pwa-install-dialog__close" onclick="this.closest('dialog').close()">הבנתי</button>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.showModal?.() || (dialog.style.display = 'flex');
  }

  // חלק הנחיות Firefox (pwa-installer.js) – מדריך התקנה ל-Firefox | HYPER CORE TECH
  function showFirefoxInstallGuide() {
    const existingDialog = document.getElementById('firefox-install-guide');
    if (existingDialog) {
      existingDialog.showModal?.() || (existingDialog.style.display = 'flex');
      return;
    }
    
    const dialog = document.createElement('dialog');
    dialog.id = 'firefox-install-guide';
    dialog.className = 'pwa-install-dialog';
    dialog.innerHTML = `
      <div class="pwa-install-dialog__content">
        <h2>🦊 התקנת SOS ב-Firefox</h2>
        <div class="pwa-install-steps">
          <div class="pwa-install-step">
            <span class="pwa-install-step__number">1</span>
            <span>לחץ על שלוש הנקודות בתפריט (⋮) בפינה הימנית העליונה</span>
          </div>
          <div class="pwa-install-step">
            <span class="pwa-install-step__number">2</span>
            <span>בחר "Install" או "התקן" (אם זמין)</span>
          </div>
          <div class="pwa-install-step">
            <span class="pwa-install-step__number">3</span>
            <span>אם לא זמין, הוסף לסימניות לגישה מהירה</span>
          </div>
        </div>
        <button type="button" class="pwa-install-dialog__close" onclick="this.closest('dialog').close()">הבנתי</button>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.showModal?.() || (dialog.style.display = 'flex');
  }

  // חלק באנר התקנה (pwa-installer.js) – יצירת באנר התקנה בתחתית המסך | HYPER CORE TECH
  function createInstallBanner() {
    // בדיקה 1: לא מציגים אם כבר מותקן
    if (isInstalled || checkIfInstalled()) {
      console.log('[PWA] האפליקציה כבר מותקנת - לא מציגים באנר');
      return;
    }
    
    // בדיקה 2: לא מציגים אם המשתמש כבר סגר את הבאנר (ב-7 ימים האחרונים)
    const dismissed = localStorage.getItem('pwa_banner_dismissed');
    if (dismissed) {
      const dismissedAt = parseInt(dismissed, 10);
      const daysSinceDismissed = (Date.now() - dismissedAt) / (1000 * 60 * 60 * 24);
      if (daysSinceDismissed < 7) {
        console.log('[PWA] המשתמש סגר את הבאנר לאחרונה');
        return;
      }
    }
    
    // בדיקה 3: לא מציגים אם המשתמש כבר התקין בעבר
    if (localStorage.getItem('pwa_installed') === 'true') {
      console.log('[PWA] המשתמש כבר התקין בעבר');
      return;
    }
    
    const platform = getPlatformInfo();
    const existingBanner = document.getElementById('pwa-install-banner');
    if (existingBanner) return;
    
    const banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.className = 'pwa-install-banner';
    banner.innerHTML = `
      <div class="pwa-install-banner__content">
        <img src="./icons/so-call010.png" alt="SOS Call 010" class="pwa-install-banner__icon">
        <div class="pwa-install-banner__text">
          <strong>התקן את SOS</strong>
          <span>גישה מהירה והתראות בזמן אמת</span>
        </div>
      </div>
      <div class="pwa-install-banner__actions">
        <button type="button" class="pwa-install-banner__dismiss" aria-label="סגור">✕</button>
        <button type="button" class="pwa-install-banner__install">התקן</button>
      </div>
    `;
    
    // אירועים
    banner.querySelector('.pwa-install-banner__dismiss').addEventListener('click', () => {
      banner.remove();
      localStorage.setItem('pwa_banner_dismissed', Date.now().toString());
    });
    
    banner.querySelector('.pwa-install-banner__install').addEventListener('click', () => {
      const result = runInstallFromUserGesture();
      if (result && (result.outcome === 'accepted' || result.outcome === 'prompted' || result.outcome === 'already_installed')) {
        // prompted = דיאלוג נפתח; accepted מגיע מ-appinstalled / userChoice
        if (result.outcome === 'already_installed') banner.remove();
      }
      // אם המשתמש אישר – appinstalled יסיר את הבאנר
    });
    
    document.body.appendChild(banner);
    
    // הצגה עם אנימציה
    setTimeout(() => banner.classList.add('pwa-install-banner--visible'), 100);
  }

  // חלק אתחול (pwa-installer.js) – אתחול מערכת ה-PWA | HYPER CORE TECH
  // חלק תיקון PWA ברקע – רישום SW תמיד כדי לאפשר Push והתרעות גם אחרי התקנה | HYPER CORE TECH
  async function initPwa() {
    console.log('[PWA] מאתחל מערכת PWA...');
    
    // **תמיד** לרשום SW - קריטי לקבלת Push והתרעות גם ב-PWA מותקנת!
    await registerServiceWorker();
    
    // **תמיד** להגדיר מאזין להתקנה - גם אם נראה מותקן (יכול להיות חלון דפדפן רגיל)
    setupInstallPromptListener();
    bindInstallMenuButton();
    
    isInstalled = checkIfInstalled();
    console.log('[PWA] סטטוס התקנה:', isInstalled ? 'מותקן' : 'לא מותקן');
    
    if (isInstalled) {
      console.log('[PWA] האפליקציה מותקנת - SW רשום לקבלת Push והתרעות ברקע');
      localStorage.setItem('pwa_installed', 'true');
      // ממשיכים לאתחל push גם אחרי התקנה (שם הפונקציה הנכון) | HYPER CORE TECH
      ensurePushAfterInstall();
      return;
    }
    
    console.log('[PWA] מערכת PWA אותחלה - ממתין ל-beforeinstallprompt');
    
    // יצירת באנר התקנה - עם השהייה לתת beforeinstallprompt זמן להגיע
    scheduleInstallBanner();
  }

  // חלק תזמון באנר (pwa-installer.js) – הצגת באנר התקנה בתזמון נכון | HYPER CORE TECH
  function scheduleInstallBanner() {
    const platform = getPlatformInfo();
    
    // iOS - מציגים באנר מיד (אין beforeinstallprompt)
    if (platform.isIOS) {
      setTimeout(() => {
        if (!isInstalled && !checkIfInstalled()) {
          createInstallBanner();
        }
      }, 5000);
      return;
    }
    
    // Android/Desktop - ממתינים ל-beforeinstallprompt
    let bannerTimeout = setTimeout(() => {
      if (!getDeferredPrompt()) {
        // Chrome עדיין תומך – פשוט האירוע לא הגיע (נדחה בעבר / כבר מותקן / קריטריונים) | HYPER CORE TECH
        console.log('[PWA] beforeinstallprompt לא התקבל עדיין – לא מציגים באנר אוטומטי');
        if (platform.isFirefox) {
          createInstallBanner();
        }
      }
    }, 8000);
    
    // אם beforeinstallprompt מגיע לפני הטיימאוט, מציגים באנר
    window.addEventListener('beforeinstallprompt', () => {
      clearTimeout(bannerTimeout);
      setTimeout(createInstallBanner, 3000);
    }, { once: true });
  }

  // חלק עדכון גרסה (pwa-installer.js) – הצגת הודעה כשיש גרסה חדשה | HYPER CORE TECH
  function showUpdateAvailableToast() {
    if (document.getElementById('pwa-update-toast')) return;
    
    const toast = document.createElement('div');
    toast.id = 'pwa-update-toast';
    toast.innerHTML = `
      <div class="pwa-update-icon">
        <i class="fa-solid fa-arrow-rotate-right"></i>
      </div>
      <div class="pwa-update-content">
        <span class="pwa-update-title">גרסה חדשה זמינה!</span>
        <span class="pwa-update-subtitle">עדכן כדי ליהנות משיפורים ותכונות חדשות</span>
      </div>
      <div class="pwa-update-actions">
        <button type="button" class="pwa-update-later">אח״כ</button>
        <button type="button" class="pwa-update-now">עדכן</button>
      </div>
    `;
    
    // עיצוב מותאם לממשק ומובייל - רקע כהה עם accent בסגנון האפליקציה | HYPER CORE TECH
    toast.style.cssText = `position:fixed;bottom:calc(80px + env(safe-area-inset-bottom,0px));left:12px;right:12px;transform:translateY(150px);background:linear-gradient(135deg,#0a0a1a 0%,#1a1a2e 50%,#16213e 100%);color:#fff;padding:14px;border-radius:16px;display:flex;flex-wrap:wrap;align-items:center;gap:12px;z-index:100001;box-shadow:0 8px 32px rgba(0,0,0,0.6);direction:rtl;transition:transform 0.3s cubic-bezier(0.175,0.885,0.32,1.275);border:1px solid rgba(45,136,255,0.2);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);`;
    toast.querySelector('.pwa-update-icon').style.cssText = 'width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#ff2d55 0%,#2d88ff 100%);display:flex;align-items:center;justify-content:center;font-size:16px;color:#000;flex-shrink:0;';
    toast.querySelector('.pwa-update-content').style.cssText = 'display:flex;flex-direction:column;gap:2px;flex:1;min-width:120px;';
    toast.querySelector('.pwa-update-title').style.cssText = 'font-size:14px;font-weight:700;color:#fff;';
    toast.querySelector('.pwa-update-subtitle').style.cssText = 'font-size:11px;color:rgba(255,255,255,0.6);';
    toast.querySelector('.pwa-update-actions').style.cssText = 'display:flex;gap:8px;flex-shrink:0;margin-right:auto;';
    toast.querySelector('.pwa-update-later').style.cssText = 'background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.8);padding:8px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;transition:all 0.2s;';
    toast.querySelector('.pwa-update-now').style.cssText = 'background:linear-gradient(135deg,#ff2d55 0%,#2d88ff 100%);border:none;color:#000;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;transition:all 0.2s;box-shadow:0 4px 12px rgba(45,136,255,0.3);';
    
    toast.querySelector('.pwa-update-later').onclick = () => {
      toast.style.transform = 'translateY(150px)';
      setTimeout(() => toast.remove(), 300);
    };
    
    toast.querySelector('.pwa-update-now').onclick = () => {
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
      }
      setTimeout(() => window.location.reload(true), 500);
    };
    
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.transform = 'translateY(0)'; }, 100);
    console.log('[PWA] הוצגה הודעת עדכון גרסה');
  }

  // חלק עדכון גרסה (pwa-installer.js) – בדיקת עדכונים תקופתית | HYPER CORE TECH
  function setupUpdateChecker() {
    if (!navigator.serviceWorker) return;
    
    // בדיקה מיידית + תקופתית כל דקה | HYPER CORE TECH
    async function checkForUpdates() {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          await reg.update();
          // בדיקה אם יש עדכון ממתין
          if (reg.waiting) {
            console.log('[PWA] נמצא עדכון ממתין!');
            showUpdateAvailableToast();
          }
        }
      } catch (err) {
        console.warn('[PWA] שגיאה בבדיקת עדכונים:', err);
      }
    }
    
    // בדיקה ראשונית אחרי 3 שניות
    setTimeout(checkForUpdates, 3000);
    // בדיקה תקופתית כל דקה
    setInterval(checkForUpdates, 60 * 1000);
    
    // חלק מניעת רענון אוטומטי (pwa-installer.js) – לא מרעננים אוטומטית כדי לא לאבד קאש ופוסטים | HYPER CORE TECH
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      console.log('[PWA] Service Worker עודכן - מציגים הודעה למשתמש');
      // במקום רענון אוטומטי - מציגים הודעה למשתמש שיבחר מתי לרענן
      // זה מונע איבוד קאש ופוסטים באמצע רענון לא מתוכנן
      showUpdateAvailableToast();
    });
    
    // האזנה להודעות עדכון מה-SW (Push)
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'app-update-available') {
        console.log('[PWA] התקבלה הודעת עדכון מה-SW', event.data.version);
        showUpdateAvailableToast();
      }
      
      // חלק עדכון גרסה (pwa-installer.js) – גרסה חדשה הופעלה | HYPER CORE TECH
      if (event.data?.type === 'NEW_VERSION_ACTIVATED') {
        console.log('[PWA] גרסה חדשה הופעלה!');
        showUpdateAvailableToast();
      }
    });
  }

  // חשיפת API ציבורי
  Object.assign(App, {
    getPlatformInfo,
    checkIfInstalled,
    promptPwaInstall: promptInstall,
    showIOSInstallGuide,
    showChromeInstallGuide,
    showInstallBanner: createInstallBanner,
    isPwaInstalled: () => isInstalled || checkIfInstalled(),
    showUpdateAvailableToast,
    ensurePushAfterInstall,
  });
  
  // פונקציה גלובלית להפעלת התקנה
  window.requestPwaInstallPrompt = promptInstall;
  setupUpdateChecker();

  // אתחול כשהדף מוכן
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPwa);
  } else {
    initPwa();
  }
})(window);
