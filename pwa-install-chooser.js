// חלק בחירת התקנה (pwa-install-chooser.js) – כרטיסיית PC / Android / iPhone | HYPER CORE TECH
(function initPwaInstallChooser(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const LOGO = './icons/sos-logo-mobile.png?v=20260802aa';

  function getPlatformInfo() {
    if (typeof App.getPlatformInfo === 'function') {
      return App.getPlatformInfo();
    }
    const ua = navigator.userAgent || '';
    return {
      isIOS: /iPad|iPhone|iPod/.test(ua) && !window.MSStream,
      isAndroid: /Android/i.test(ua),
      isDesktop: /Win32|Win64|Windows|Macintosh|MacIntel|Linux/.test(ua) && !/Android/i.test(ua),
    };
  }

  function closeInstallChooser() {
    const el = document.getElementById('pwa-install-chooser');
    if (!el) return;
    el.classList.remove('pwa-install-chooser--visible');
    setTimeout(() => {
      try { el.remove(); } catch (_) {}
    }, 280);
  }

  function openInstallChooser() {
    const alreadyInstalled =
      (typeof App.isRunningInNativeShell === 'function' && App.isRunningInNativeShell())
      || (typeof App.checkIfInstalled === 'function' && App.checkIfInstalled());
    if (alreadyInstalled) {
      if (typeof App.showToast === 'function') {
        App.showToast('הממשק כבר מותקן – פתח אותו מהאייקון');
      }
      return;
    }

    const existing = document.getElementById('pwa-install-chooser');
    if (existing) {
      existing.classList.add('pwa-install-chooser--visible');
      return;
    }

    const platform = getPlatformInfo();
    let recommended = 'desktop';
    if (platform.isAndroid) recommended = 'android';
    else if (platform.isIOS) recommended = 'ios';

    const root = document.createElement('div');
    root.id = 'pwa-install-chooser';
    root.className = 'pwa-install-chooser';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'בחירת התקנת SOS');
    root.innerHTML = `
      <div class="pwa-install-chooser__overlay" data-chooser-close></div>
      <div class="pwa-install-chooser__card">
        <button type="button" class="pwa-install-chooser__close" data-chooser-close aria-label="סגור">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
        <img class="pwa-install-chooser__logo" src="${LOGO}" alt="SOS" width="72" height="72">
        <h2 class="pwa-install-chooser__title">התקן את SOS</h2>
        <p class="pwa-install-chooser__lead">בחרו את המכשיר שלכם — התקנה מהירה בסגנון אפליקציה</p>
        <div class="pwa-install-chooser__options" role="list">
          <button type="button" class="pwa-install-chooser__option" data-install-target="desktop" role="listitem">
            <span class="pwa-install-chooser__option-icon" aria-hidden="true"><i class="fa-solid fa-desktop"></i></span>
            <span class="pwa-install-chooser__option-body">
              <span class="pwa-install-chooser__option-title">מחשב (PC)</span>
              <span class="pwa-install-chooser__option-sub">חלון עם מסגרת + אייקון בשולחן העבודה / שורת המשימות</span>
            </span>
            ${recommended === 'desktop' ? '<span class="pwa-install-chooser__badge">מומלץ</span>' : ''}
          </button>
          <button type="button" class="pwa-install-chooser__option" data-install-target="android" role="listitem">
            <span class="pwa-install-chooser__option-icon" aria-hidden="true"><i class="fa-brands fa-android"></i></span>
            <span class="pwa-install-chooser__option-body">
              <span class="pwa-install-chooser__option-title">אנדרואיד</span>
              <span class="pwa-install-chooser__option-sub">הורדת קובץ APK להתקנה כ־אפליקציה</span>
            </span>
            ${recommended === 'android' ? '<span class="pwa-install-chooser__badge">מומלץ</span>' : ''}
          </button>
          <button type="button" class="pwa-install-chooser__option" data-install-target="ios" role="listitem">
            <span class="pwa-install-chooser__option-icon" aria-hidden="true"><i class="fa-brands fa-apple"></i></span>
            <span class="pwa-install-chooser__option-body">
              <span class="pwa-install-chooser__option-title">אייפון</span>
              <span class="pwa-install-chooser__option-sub">קיצור דרך למסך הבית (Safari)</span>
            </span>
            ${recommended === 'ios' ? '<span class="pwa-install-chooser__badge">מומלץ</span>' : ''}
          </button>
        </div>
        <p class="pwa-install-chooser__note">אחרי ההתקנה תקבלו התראות גם כשהמסך כבוי</p>
      </div>
    `;

    root.querySelectorAll('[data-chooser-close]').forEach((btn) => {
      btn.addEventListener('click', closeInstallChooser);
    });

    root.querySelectorAll('[data-install-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-install-target');
        closeInstallChooser();
        setTimeout(() => {
          if (target === 'desktop' && typeof App.installPwaDesktop === 'function') {
            App.installPwaDesktop();
          } else if (target === 'android' && typeof App.installAndroidApk === 'function') {
            App.installAndroidApk();
          } else if (target === 'ios' && typeof App.showIOSInstallGuide === 'function') {
            App.showIOSInstallGuide();
          }
        }, 180);
      });
    });

    document.body.appendChild(root);
    requestAnimationFrame(() => root.classList.add('pwa-install-chooser--visible'));
  }

  App.openInstallChooser = openInstallChooser;
  App.closeInstallChooser = closeInstallChooser;
  window.openInstallChooser = openInstallChooser;
})(window);
