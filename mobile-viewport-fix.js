// חלק מובייל (mobile-viewport-fix.js) – תיקון בעיית 100vh באייפון | HYPER CORE TECH
(function initMobileViewportFix() {
  'use strict';

  // עדכון משתנה --app-height לגובה החלון האמיתי
  function setAppHeight() {
    const vh = window.innerHeight;
    document.documentElement.style.setProperty('--app-height', vh + 'px');
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

  // עדכון כשהמקלדת נפתחת/נסגרת (iOS)
  if ('visualViewport' in window) {
    window.visualViewport.addEventListener('resize', setAppHeight, { passive: true });
  }

  console.log('[MOBILE] Viewport fix initialized');
})();
