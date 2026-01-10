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
  function setupInstallPromptListener() {
    window.addEventListener('beforeinstallprompt', (event) => {
      // מניעת הופעה אוטומטית של הבאנר
      event.preventDefault();
      // שמירת האירוע לשימוש מאוחר יותר
      deferredInstallPrompt = event;
      window.deferredPwaPrompt = event;
      console.log('[PWA] אירוע beforeinstallprompt נתפס - הדפדפן תומך בהתקנה!');
      
      // הצגת כפתור התקנה אם קיים
      showInstallButton();
    });

    // האזנה לאירוע התקנה מוצלחת
    window.addEventListener('appinstalled', () => {
      console.log('[PWA] האפליקציה הותקנה בהצלחה!');
      isInstalled = true;
      deferredInstallPrompt = null;
      window.deferredPwaPrompt = null;
      hideInstallButton();
      
      // הצגת הודעת הצלחה
      if (typeof App.showToast === 'function') {
        App.showToast('האפליקציה הותקנה בהצלחה! 🎉');
      }
    });
  }

  // חלק הפעלת התקנה (pwa-installer.js) – הפעלת דיאלוג ההתקנה | HYPER CORE TECH
  async function promptInstall() {
    const platform = getPlatformInfo();
    
    // iOS - אין beforeinstallprompt, מציגים הנחיות ידניות
    if (platform.isIOS) {
      showIOSInstallGuide();
      return { outcome: 'ios_manual', platform: 'ios' };
    }
    
    // בדיקה אם יש אירוע התקנה שמור
    if (!deferredInstallPrompt) {
      console.log('[PWA] אין אירוע התקנה זמין');
      // Firefox או דפדפנים אחרים ללא תמיכה
      if (platform.isFirefox) {
        showFirefoxInstallGuide();
        return { outcome: 'firefox_manual', platform: 'firefox' };
      }
      return { outcome: 'unavailable', platform: 'unknown' };
    }
    
    try {
      // הפעלת הדיאלוג
      deferredInstallPrompt.prompt();
      // המתנה לתשובת המשתמש
      const choiceResult = await deferredInstallPrompt.userChoice;
      console.log('[PWA] תוצאת ההתקנה:', choiceResult.outcome);
      
      // ניקוי האירוע
      deferredInstallPrompt = null;
      window.deferredPwaPrompt = null;
      
      return choiceResult;
    } catch (err) {
      console.error('[PWA] שגיאה בהפעלת ההתקנה:', err);
      return { outcome: 'error', error: err.message };
    }
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
    const menuBtn = document.getElementById('pwa-install-menu-btn');
    if (menuBtn) {
      menuBtn.setAttribute('hidden', '');
    }
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
        <img src="./icons/sos-logo.jpg" alt="SOS" class="pwa-install-banner__icon">
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
    
    banner.querySelector('.pwa-install-banner__install').addEventListener('click', async () => {
      const result = await promptInstall();
      if (result.outcome === 'accepted') {
        banner.remove();
      }
    });
    
    document.body.appendChild(banner);
    
    // הצגה עם אנימציה
    setTimeout(() => banner.classList.add('pwa-install-banner--visible'), 100);
  }

  // חלק אתחול (pwa-installer.js) – אתחול מערכת ה-PWA | HYPER CORE TECH
  // חלק תיקון PWA ברקע – רישום SW תמיד כדי לאפשר Push והתרעות גם אחרי התקנה | HYPER CORE TECH
  async function initPwa() {
    // **תמיד** לרשום SW - קריטי לקבלת Push והתרעות גם ב-PWA מותקנת!
    await registerServiceWorker();
    
    isInstalled = checkIfInstalled();
    
    if (isInstalled) {
      console.log('[PWA] האפליקציה מותקנת - SW רשום לקבלת Push והתרעות ברקע');
      localStorage.setItem('pwa_installed', 'true');
      // ממשיכים לאתחל push גם אחרי התקנה
      if (typeof App.initPushSubscription === 'function') {
        setTimeout(() => App.initPushSubscription(), 1000);
      }
      return;
    }
    
    // הגדרת מאזיני התקנה
    setupInstallPromptListener();
    
    console.log('[PWA] מערכת PWA אותחלה');
    
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
    
    // Android/Desktop - ממתינים ל-beforeinstallprompt או מציגים אחרי זמן
    let bannerTimeout = setTimeout(() => {
      // אם אין beforeinstallprompt אחרי 8 שניות, הדפדפן לא תומך בהתקנה
      if (!deferredInstallPrompt) {
        console.log('[PWA] beforeinstallprompt לא התקבל - הדפדפן לא תומך בהתקנה');
        // אם זה Firefox, מציגים מדריך
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
      <div class="pwa-update-content">
        <i class="fa-solid fa-arrow-rotate-right"></i>
        <span>גרסה חדשה זמינה!</span>
      </div>
      <div class="pwa-update-actions">
        <button type="button" class="pwa-update-later">אח״כ</button>
        <button type="button" class="pwa-update-now">עדכן עכשיו</button>
      </div>
    `;
    
    toast.style.cssText = `position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(100px);background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;padding:12px 16px;border-radius:12px;display:flex;align-items:center;gap:16px;z-index:100001;box-shadow:0 4px 20px rgba(0,0,0,0.4);direction:rtl;transition:transform 0.3s ease-out;max-width:90vw;`;
    toast.querySelector('.pwa-update-content').style.cssText = 'display:flex;align-items:center;gap:10px;font-size:14px;';
    toast.querySelector('.pwa-update-actions').style.cssText = 'display:flex;gap:8px;';
    toast.querySelector('.pwa-update-later').style.cssText = 'background:transparent;border:1px solid rgba(255,255,255,0.3);color:#fff;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;';
    toast.querySelector('.pwa-update-now').style.cssText = 'background:#4a90d9;border:none;color:#fff;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;';
    
    toast.querySelector('.pwa-update-later').onclick = () => {
      toast.style.transform = 'translateX(-50%) translateY(100px)';
      setTimeout(() => toast.remove(), 300);
    };
    
    toast.querySelector('.pwa-update-now').onclick = () => {
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
      }
      setTimeout(() => window.location.reload(true), 500);
    };
    
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.transform = 'translateX(-50%) translateY(0)'; }, 100);
    console.log('[PWA] הוצגה הודעת עדכון גרסה');
  }

  // חלק עדכון גרסה (pwa-installer.js) – בדיקת עדכונים תקופתית | HYPER CORE TECH
  function setupUpdateChecker() {
    if (!navigator.serviceWorker) return;
    
    setInterval(async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
      } catch {}
    }, 5 * 60 * 1000);
    
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      console.log('[PWA] Service Worker עודכן');
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
        // אפשר להציג הודעה או לרענן
        if (typeof App.showToast === 'function') {
          App.showToast('האפליקציה עודכנה לגרסה החדשה ✓');
        }
      }
    });
  }

  // חשיפת API ציבורי
  Object.assign(App, {
    getPlatformInfo,
    checkIfInstalled,
    promptPwaInstall: promptInstall,
    showIOSInstallGuide,
    showInstallBanner: createInstallBanner,
    isPwaInstalled: () => isInstalled || checkIfInstalled(),
    showUpdateAvailableToast,
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
