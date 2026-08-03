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

  // חלק זיהוי מעטפת APK (pwa-installer.js) – WebView של האפליקציה המותקנת | HYPER CORE TECH
  function isRunningInNativeShell() {
    try {
      if (window.SOS_NATIVE_SHELL) return true;
      if (window.SosNativeShell && typeof window.SosNativeShell.isNativeShell === 'function') {
        const v = window.SosNativeShell.isNativeShell();
        return v === true || v === 'true';
      }
    } catch (_) {}
    return /SOSNativeShell\//i.test(navigator.userAgent || '');
  }

  // חלק בדיקת התקנה (pwa-installer.js) – PWA standalone או APK native | HYPER CORE TECH
  function checkIfInstalled() {
    // מעטפת Android מותקנת = כבר «מותקן», לא להציג באנר התקנה | HYPER CORE TECH
    if (isRunningInNativeShell()) {
      return true;
    }
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

  // כתובת APK של מעטפת Android – שם קובץ כולל גרסה להורדה ברורה | HYPER CORE TECH
  const NATIVE_APK_VERSION = '1.0.25';
  const NATIVE_APK_FILE = `SOS-${NATIVE_APK_VERSION}.apk`;
  const NATIVE_APK_URL = (typeof localStorage !== 'undefined' && localStorage.getItem('sos_apk_url'))
    || `./downloads/${NATIVE_APK_FILE}`;

  function startNativeApkInstall() {
    // הורדה ישירה של APK – בלי מדריכים ובלי תפריט Chrome | HYPER CORE TECH
    pwaToast(`מוריד את אפליקציית SOS ${NATIVE_APK_VERSION}…`);
    try {
      const link = document.createElement('a');
      link.href = NATIVE_APK_URL;
      link.setAttribute('download', NATIVE_APK_FILE);
      link.rel = 'noopener';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      setTimeout(() => link.remove(), 1000);
    } catch (err) {
      console.error('[PWA] APK download failed, fallback navigate', err);
      window.location.href = NATIVE_APK_URL;
    }
    return { outcome: 'apk_download', url: NATIVE_APK_URL, file: NATIVE_APK_FILE, version: NATIVE_APK_VERSION };
  }

  // חלק מדריך דסקטופ (pwa-installer.js) – כשאין beforeinstallprompt | HYPER CORE TECH
  function showDesktopInstallGuide() {
    const existingDialog = document.getElementById('desktop-install-guide');
    if (existingDialog) {
      existingDialog.showModal?.() || (existingDialog.style.display = 'flex');
      return;
    }

    const dialog = document.createElement('dialog');
    dialog.id = 'desktop-install-guide';
    dialog.className = 'pwa-install-dialog';
    dialog.innerHTML = `
      <div class="pwa-install-dialog__content">
        <img src="./icons/sos-logo-mobile.png?v=20260802aa" alt="SOS" class="pwa-install-dialog__logo" width="64" height="64">
        <h2>התקנה במחשב</h2>
        <div class="pwa-install-steps">
          <div class="pwa-install-step">
            <span class="pwa-install-step__number">1</span>
            <span>פתחו את האתר ב־Chrome או Edge</span>
          </div>
          <div class="pwa-install-step">
            <span class="pwa-install-step__number">2</span>
            <span>לחצו על תפריט הדפדפן (⋮) ובחרו «התקן את SOS» / Install app</span>
          </div>
          <div class="pwa-install-step">
            <span class="pwa-install-step__number">3</span>
            <span>אחרי ההתקנה יופיע אייקון בשולחן העבודה ובשורת המשימות</span>
          </div>
        </div>
        <p class="pwa-install-note">אם האפשרות לא מופיעה – רעננו את הדף ונסו שוב מכפתור «התקן»</p>
        <button type="button" class="pwa-install-dialog__close">הבנתי</button>
      </div>
    `;
    dialog.querySelector('.pwa-install-dialog__close').addEventListener('click', () => {
      dialog.close?.() || (dialog.style.display = 'none');
    });
    document.body.appendChild(dialog);
    dialog.showModal?.() || (dialog.style.display = 'flex');
  }

  function showChromeInstallGuide() {
    showDesktopInstallGuide();
  }

  // חלק התקנת PWA בדסקטופ (pwa-installer.js) – beforeinstallprompt בלבד, בלי נפילה ל־APK | HYPER CORE TECH
  function installPwaDesktop() {
    if (isRunningInNativeShell() || checkIfInstalled()) {
      isInstalled = true;
      pwaToast('הממשק כבר מותקן – פתח אותו מהאייקון');
      ensurePushAfterInstall();
      return { outcome: 'already_installed' };
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
            pwaToast('ההתקנה בוטלה');
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

    showDesktopInstallGuide();
    return { outcome: 'desktop_manual' };
  }

  function installAndroidApk() {
    if (isRunningInNativeShell()) {
      isInstalled = true;
      pwaToast('SOS כבר מותקן במכשיר');
      ensurePushAfterInstall();
      return { outcome: 'already_installed', platform: 'native' };
    }
    return startNativeApkInstall();
  }

  // חלק פתיחת בחירה (pwa-installer.js) – כרטיסיית PC / Android / iPhone | HYPER CORE TECH
  function openInstallChooserOrFallback() {
    if (isRunningInNativeShell()) {
      isInstalled = true;
      pwaToast('SOS כבר מותקן במכשיר');
      ensurePushAfterInstall();
      return { outcome: 'already_installed', platform: 'native' };
    }
    if (checkIfInstalled()) {
      isInstalled = true;
      pwaToast('הממשק כבר מותקן – פתח אותו מהאייקון');
      ensurePushAfterInstall();
      return { outcome: 'already_installed' };
    }
    if (typeof App.openInstallChooser === 'function') {
      App.openInstallChooser();
      return { outcome: 'chooser' };
    }
    // fallback אם המודול לא נטען
    const platform = getPlatformInfo();
    if (platform.isAndroid) return installAndroidApk();
    if (platform.isIOS) {
      showIOSInstallGuide();
      return { outcome: 'ios_manual' };
    }
    return installPwaDesktop();
  }

  // חלק הפעלת התקנה מלחיצה (pwa-installer.js) – פותח בחירת פלטפורמה | HYPER CORE TECH
  function runInstallFromUserGesture() {
    return openInstallChooserOrFallback();
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
    // ב־APK native מסתירים גם את כפתור התפריט – כבר מותקן | HYPER CORE TECH
    if (isRunningInNativeShell()) {
      const menuBtn = document.getElementById('pwa-install-menu-btn');
      if (menuBtn) {
        menuBtn.setAttribute('hidden', '');
        menuBtn.style.display = 'none';
      }
    }
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

      const existingBanner = document.getElementById('pwa-install-banner');
      if (existingBanner) existingBanner.remove();

      openInstallChooserOrFallback();
    });
  }

  // חלק הנחיות iOS (pwa-installer.js) – מדריך Add to Home Screen בסגנון ניאון | HYPER CORE TECH
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
        <img src="./icons/sos-logo-mobile.png?v=20260802aa" alt="SOS" class="pwa-install-dialog__logo" width="64" height="64">
        <h2>התקנת SOS באייפון</h2>
        <p class="pwa-install-dialog__lead">ב־Safari בלבד — אין התקנה אוטומטית באייפון</p>
        <div class="pwa-install-steps">
          <div class="pwa-install-step">
            <span class="pwa-install-step__number">1</span>
            <span>לחצו על כפתור השיתוף <i class="fa-solid fa-arrow-up-from-bracket"></i> בתחתית המסך</span>
          </div>
          <div class="pwa-install-step">
            <span class="pwa-install-step__number">2</span>
            <span>גללו ולחצו על «Add to Home Screen» / «הוסף למסך הבית»</span>
          </div>
          <div class="pwa-install-step">
            <span class="pwa-install-step__number">3</span>
            <span>לחצו «Add» / «הוסף» — האייקון יופיע במסך הבית</span>
          </div>
        </div>
        <p class="pwa-install-note">אחרי ההתקנה האפליקציה נפתחת במסך מלא וניתן להפעיל התראות Push</p>
        <button type="button" class="pwa-install-dialog__close">הבנתי</button>
      </div>
    `;
    dialog.querySelector('.pwa-install-dialog__close').addEventListener('click', () => {
      dialog.close?.() || (dialog.style.display = 'none');
    });
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

  // חלק באנר התקנה (pwa-installer.js) – מובייל למעלה, נעלם לבד אחרי 5 שניות | HYPER CORE TECH
  function createInstallBanner() {
    // בדיקה 1: לא מציגים אם כבר מותקן (כולל APK native) | HYPER CORE TECH
    if (isInstalled || isRunningInNativeShell() || checkIfInstalled()) {
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
    
    const existingBanner = document.getElementById('pwa-install-banner');
    if (existingBanner) return;
    
    const banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.className = 'pwa-install-banner';
    banner.innerHTML = `
      <div class="pwa-install-banner__content">
        <img src="./icons/sos-logo-mobile.png?v=20260802ad" alt="SOS" class="pwa-install-banner__icon">
        <div class="pwa-install-banner__text">
          <strong>התקן את אפליקציית SOS</strong>
          <span>התראות גם כשהמסך כבוי</span>
        </div>
      </div>
      <div class="pwa-install-banner__actions">
        <button type="button" class="pwa-install-banner__dismiss" aria-label="סגור">✕</button>
        <button type="button" class="pwa-install-banner__install">התקן</button>
      </div>
    `;

    function dismissInstallBanner(markDismissed) {
      if (!banner.isConnected) return;
      banner.classList.remove('pwa-install-banner--visible');
      setTimeout(() => {
        try { banner.remove(); } catch (_) {}
      }, 350);
      if (markDismissed) {
        try { localStorage.setItem('pwa_banner_dismissed', Date.now().toString()); } catch (_) {}
      }
    }
    
    banner.querySelector('.pwa-install-banner__dismiss').addEventListener('click', () => {
      dismissInstallBanner(true);
    });
    
    banner.querySelector('.pwa-install-banner__install').addEventListener('click', () => {
      const result = openInstallChooserOrFallback();
      if (result && result.outcome === 'already_installed') {
        dismissInstallBanner(true);
      }
    });
    
    document.body.appendChild(banner);
    
    // הצגה עם אנימציה + היעלמות אוטומטית אחרי 5 שניות (פחות מפריע לאורח חדש) | HYPER CORE TECH
    setTimeout(() => banner.classList.add('pwa-install-banner--visible'), 100);
    setTimeout(() => dismissInstallBanner(true), 5100);
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

    // אם הדגל מגיע מאוחר מ־onPageFinished – מסירים באנר אם הופיע | HYPER CORE TECH
    window.addEventListener('sos-native-ready', () => {
      isInstalled = true;
      try { localStorage.setItem('pwa_installed', 'true'); } catch (_) {}
      const banner = document.getElementById('pwa-install-banner');
      if (banner) banner.remove();
      hideInstallButton();
    });
    
    isInstalled = checkIfInstalled();
    console.log('[PWA] סטטוס התקנה:', isInstalled ? 'מותקן' : 'לא מותקן',
      isRunningInNativeShell() ? '(native shell)' : '');
    
    if (isInstalled) {
      console.log('[PWA] האפליקציה מותקנת - SW רשום לקבלת Push והתרעות ברקע');
      localStorage.setItem('pwa_installed', 'true');
      hideInstallButton();
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
    // APK / כבר מותקן – בלי באנר התקנה | HYPER CORE TECH
    if (isInstalled || isRunningInNativeShell() || checkIfInstalled()) {
      return;
    }

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
      if (isRunningInNativeShell() || checkIfInstalled()) return;
      if (!getDeferredPrompt()) {
        // Android בדפדפן: באנר מוביל לבחירה (APK) גם בלי beforeinstallprompt | HYPER CORE TECH
        console.log('[PWA] beforeinstallprompt לא התקבל עדיין');
        if (platform.isFirefox || platform.isAndroid) {
          createInstallBanner();
        }
      }
    }, 8000);
    
    // אם beforeinstallprompt מגיע לפני הטיימאוט, מציגים באנר
    window.addEventListener('beforeinstallprompt', () => {
      if (isRunningInNativeShell() || checkIfInstalled()) return;
      clearTimeout(bannerTimeout);
      setTimeout(createInstallBanner, 3000);
    }, { once: true });
  }

  // חלק עדכון גרסה (pwa-installer.js) – הצגת הודעה כשיש גרסה חדשה | HYPER CORE TECH
  function showUpdateAvailableToast() {
    if (document.getElementById('pwa-update-toast')) return;
    // אחרי לחיצה על «עדכן» – לא להציג שוב בטעינה הבאה | HYPER CORE TECH
    try {
      if (sessionStorage.getItem('pwa_just_updated') === '1') return;
    } catch (_) {}
    
    const toast = document.createElement('div');
    toast.id = 'pwa-update-toast';
    toast.className = 'pwa-update-toast';
    toast.innerHTML = `
      <img src="./icons/sos-logo-mobile.png?v=20260802ac" alt="SOS" class="pwa-update-toast__logo">
      <div class="pwa-update-toast__content">
        <span class="pwa-update-toast__title">גרסה חדשה זמינה!</span>
        <span class="pwa-update-toast__subtitle">עדכן כדי ליהנות משיפורים ותכונות חדשות</span>
      </div>
      <div class="pwa-update-toast__actions">
        <button type="button" class="pwa-update-toast__later">אח״כ</button>
        <button type="button" class="pwa-update-toast__now">עדכן</button>
      </div>
    `;
    
    toast.querySelector('.pwa-update-toast__later').onclick = () => {
      toast.classList.remove('pwa-update-toast--visible');
      setTimeout(() => toast.remove(), 300);
    };
    
    toast.querySelector('.pwa-update-toast__now').onclick = () => {
      try { sessionStorage.setItem('pwa_just_updated', '1'); } catch (_) {}
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
      }
      setTimeout(() => window.location.reload(), 500);
    };
    
    document.body.appendChild(toast);
    setTimeout(() => { toast.classList.add('pwa-update-toast--visible'); }, 100);
    console.log('[PWA] הוצגה הודעת עדכון גרסה');
  }

  // חלק עדכון גרסה (pwa-installer.js) – בדיקת עדכונים תקופתית | HYPER CORE TECH
  function setupUpdateChecker() {
    if (!navigator.serviceWorker) return;

    // כניסה ראשונה בלי SW קודם ≠ «גרסה חדשה» | HYPER CORE TECH
    const hadControllerAtLoad = !!navigator.serviceWorker.controller;
    let ignoredFirstControllerClaim = false;

    try {
      if (sessionStorage.getItem('pwa_just_updated') === '1') {
        setTimeout(() => {
          try { sessionStorage.removeItem('pwa_just_updated'); } catch (_) {}
        }, 4000);
      }
    } catch (_) {}
    
    // בדיקה מיידית + תקופתית כל דקה | HYPER CORE TECH
    async function checkForUpdates() {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          await reg.update();
          // worker ממתין = עדכון אמיתי רק אם כבר הייתה שליטה / אחרי claim ראשון | HYPER CORE TECH
          const canPromptUpdate = hadControllerAtLoad || ignoredFirstControllerClaim;
          if (reg.waiting && canPromptUpdate && navigator.serviceWorker.controller) {
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
      if (!hadControllerAtLoad && !ignoredFirstControllerClaim) {
        ignoredFirstControllerClaim = true;
        console.log('[PWA] Service Worker קיבל שליטה לראשונה – בלי הודעת עדכון');
        return;
      }
      console.log('[PWA] Service Worker הוחלף – מציגים הודעת עדכון');
      showUpdateAvailableToast();
    });
    
    // האזנה להודעות עדכון מה-SW
    navigator.serviceWorker.addEventListener('message', (event) => {
      // Push מכוון לעדכון אפליקציה – תמיד רלוונטי | HYPER CORE TECH
      if (event.data?.type === 'app-update-available') {
        console.log('[PWA] התקבלה הודעת עדכון מה-SW', event.data.version);
        showUpdateAvailableToast();
        return;
      }
      
      // activate: בכניסה ראשונה מתעלמים; בעדכון אמיתי מציגים | HYPER CORE TECH
      if (event.data?.type === 'NEW_VERSION_ACTIVATED') {
        if (!hadControllerAtLoad) {
          console.log('[PWA] מדלגים על NEW_VERSION_ACTIVATED (אין controller בטעינה)');
          return;
        }
        console.log('[PWA] גרסה חדשה הופעלה');
        showUpdateAvailableToast();
      }
    });
  }

  // חשיפת API ציבורי
  Object.assign(App, {
    getPlatformInfo,
    checkIfInstalled,
    isRunningInNativeShell,
    promptPwaInstall: promptInstall,
    installPwaDesktop,
    installAndroidApk,
    showIOSInstallGuide,
    showDesktopInstallGuide,
    showChromeInstallGuide,
    showInstallBanner: createInstallBanner,
    isPwaInstalled: () => isInstalled || checkIfInstalled(),
    showUpdateAvailableToast,
    ensurePushAfterInstall,
    SOS_APK_VERSION: NATIVE_APK_VERSION,
    SOS_APK_FILE: NATIVE_APK_FILE,
    SOS_APK_URL: NATIVE_APK_URL,
  });
  
  // פונקציה גלובלית להפעלת התקנה – פותחת בחירת פלטפורמה | HYPER CORE TECH
  window.requestPwaInstallPrompt = promptInstall;
  setupUpdateChecker();

  // אתחול כשהדף מוכן
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPwa);
  } else {
    initPwa();
  }
})(window);
