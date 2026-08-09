// חלק מובייל (mobile-viewport-fix.js) – תיקון בעיית 100vh באייפון | HYPER CORE TECH
(function initMobileViewportFix() {
  'use strict';

  // עדכון משתנה --app-height לגובה החלון האמיתי (layout — לא visualViewport של מקלדת) | HYPER CORE TECH
  function setAppHeight() {
    // כשהצ'אט פתוח לא מצמצמים --app-height לפי מקלדת (מונע קפיצת פיד) | HYPER CORE TECH
    if (document.body && document.body.classList.contains('chat-overlay-open')) {
      return;
    }
    const vh = Math.max(window.innerHeight || 0, document.documentElement?.clientHeight || 0);
    if (vh > 0) {
      document.documentElement.style.setProperty('--app-height', vh + 'px');
    }
  }

  // הרצה ראשונית
  setAppHeight();

  // עדכון ב-resize
  let resizeTimeout;
  window.addEventListener('resize', function() {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(setAppHeight, 100);
  }, { passive: true });

  // עדכון בשינוי אוריינטציה
  window.addEventListener('orientationchange', function() {
    setTimeout(setAppHeight, 150);
  }, { passive: true });

  // לא מאזינים ל-visualViewport כאן — שינוי גובה מקלדת לא צריך לכווץ את הפיד | HYPER CORE TECH

  console.log('[MOBILE] Viewport fix initialized');
})();
