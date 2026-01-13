// חלק ניווט ראשי (navigation.js) – ניהול מצב הניווט העליון באפליקציה
(function initNavigation(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק ניווט ראשי (navigation.js) – מאחסן את מצב הלשונית הפעילה
  App.activeNav = App.activeNav || 'videos';

  const navRoot = document.querySelector('.primary-nav');
  if (!navRoot) {
    console.warn('[NAV] primary-nav not found');
    return;
  }

  const navButtons = Array.from(navRoot.querySelectorAll('[data-nav]'));
  console.log('[NAV] Navigation buttons found:', navButtons.length, navButtons.map(b => b.getAttribute('data-nav')));

  function updateNavSelection(targetKey) {
    navButtons.forEach((button) => {
      const key = button.getAttribute('data-nav');
      const isActive = key === targetKey;
      button.classList.toggle('is-active', isActive);
    });
    App.activeNav = targetKey;
  }

  // חלק פאנל פרופיל (navigation.js) – פונקציה לסגירת פאנל הפרופיל האישי | HYPER CORE TECH
  function closeProfilePanel() {
    const profilePanel = document.getElementById('profilePanel');
    const profileFrame = document.getElementById('profilePanelFrame');
    if (profilePanel && !profilePanel.hidden) {
      profilePanel.hidden = true;
      if (profileFrame) profileFrame.src = '';
      console.log('[NAV] Profile panel closed');
      return true;
    }
    return false;
  }

  // חלק פאנל פרופיל ציבורי (navigation.js) – פונקציה לסגירת פאנל פרופיל ציבורי | HYPER CORE TECH
  function closePublicProfilePanel() {
    const publicPanel = document.getElementById('publicProfilePanel');
    const publicFrame = document.getElementById('publicProfilePanelFrame');
    if (publicPanel && !publicPanel.hidden) {
      publicPanel.hidden = true;
      if (publicFrame) publicFrame.src = '';
      console.log('[NAV] Public profile panel closed');
      return true;
    }
    return false;
  }

  // חלק פאנל משחקים (navigation.js) – פונקציה לסגירת פאנל המשחקים | HYPER CORE TECH
  function closeGamesPanel() {
    const gamesPanel = document.getElementById('gamesPanel');
    const gamesFrame = document.getElementById('gamesPanelFrame');
    if (gamesPanel && !gamesPanel.hidden) {
      gamesPanel.hidden = true;
      if (gamesFrame) gamesFrame.src = '';
      console.log('[NAV] Games panel closed');
      return true;
    }
    return false;
  }

  // חלק סגירת כל ה-overlays (navigation.js) – סוגר פרופיל אישי, ציבורי ומשחקים | HYPER CORE TECH
  function closeAllOverlays() {
    let closed = false;
    if (closeProfilePanel()) closed = true;
    if (closePublicProfilePanel()) closed = true;
    if (closeGamesPanel()) closed = true;
    return closed;
  }

  // חשיפה גלובלית לסגירת פאנלים | HYPER CORE TECH
  App.closeProfilePanel = closeProfilePanel;
  App.closePublicProfilePanel = closePublicProfilePanel;
  App.closeGamesPanel = closeGamesPanel;
  App.closeAllOverlays = closeAllOverlays;

  function handleNavClick(event) {
    const key = event.currentTarget.getAttribute('data-nav');
    if (!key) {
      return;
    }

    console.log('[NAV] Navigation clicked:', key);
    const previousNav = App.activeNav;
    
    // חלק סגירת overlays (navigation.js) – סגירת כל ה-overlays בכל לחיצה על כפתור שאינו פרופיל | HYPER CORE TECH
    // אם overlay כלשהו נסגר, לא מנווטים לדף אחר - רק סוגרים ונשארים במקום
    if (key !== 'profile') {
      const wasClosed = closeAllOverlays();
      if (wasClosed) {
        console.log('[NAV] Overlay was closed, staying on current page');
        return;
      }
    }
    
    updateNavSelection(key);

    // חלק ניווט בית (navigation.js) – לחיצה על "בית" מחזירה לפיד הראשי (index)
    if (key === 'home') {
      // אם כבר בדף index.html - לא לרענן | HYPER CORE TECH
      if (window.location.pathname.includes('index.html') || window.location.pathname === '/' || window.location.pathname.endsWith('/')) {
        console.log('[NAV] Already on home page, staying here');
        return;
      }
      console.log('[NAV] Navigating to index.html');
      window.location.href = './index.html';
      return;
    }

    // חלק ניווט חדשות (navigation.js) – לחיצה על "חדשות" עוברת לדף החדשות החדש
    if (key === 'news') {
      console.log('[NAV] Navigating to news.html');
      window.location.href = './news.html';
      return;
    }

    // חלק ניווט וידאו (navigation.js) – לחיצה על "וידאו פיד" עוברת לדף הווידאו בסגנון רשתות
    if (key === 'videos') {
      // אם כבר בדף videos.html - לא לרענן, פשוט להישאר | HYPER CORE TECH
      if (window.location.pathname.includes('videos.html') || window.location.pathname.endsWith('/videos')) {
        console.log('[NAV] Already on videos page, staying here');
        return;
      }
      if (previousNav === 'profile' && App.cameFromVideos && typeof window.history?.back === 'function') {
        console.log('[NAV] Returning to videos via history.back()');
        window.history.back();
        return;
      }
      console.log('[NAV] Navigating to videos.html');
      window.location.href = './videos.html';
      return;
    }

    if (key === 'profile') {
      const app = window.NostrApp || {};
      // בדיקת מצב אורח - חסימת פרופיל למשתמשים לא מחוברים | HYPER CORE TECH
      if (app && typeof app.requireAuth === 'function') {
        if (!app.requireAuth('כדי לצפות בפרופיל אישי צריך להתחבר או להירשם.')) {
          return;
        }
      }
      // חלק פאנל פרופיל (navigation.js) – פתיחת פרופיל כ-overlay במקום ניווט לדף | HYPER CORE TECH
      const profilePanel = document.getElementById('profilePanel');
      const profileFrame = document.getElementById('profilePanelFrame');
      if (profilePanel && profileFrame) {
        // Toggle - אם פתוח, סגור; אם סגור, פתח
        if (!profilePanel.hidden) {
          profilePanel.hidden = true;
          profileFrame.src = '';
          console.log('[NAV] Profile panel closed');
        } else {
          // טעינת הפרופיל ב-iframe
          profileFrame.src = './profile.html?embedded=1';
          profilePanel.hidden = false;
          console.log('[NAV] Profile panel opened');
        }
        return;
      }
      // Fallback - אם אין פאנל, נווט לדף
      console.log('[NAV] Navigating to profile.html');
      window.location.href = './profile.html';
      return;
    }

    // חלק ניווט אחסון (navigation.js) – העברת המשתמש לדף "האחסון שלי" | HYPER CORE TECH
    if (key === 'storage') {
      console.log('[NAV] Navigating to storage.html');
      window.location.href = './storage.html';
      return;
    }

    // חלק ניווט חוזה (navigation.js) – לחיצה על "חוזה חכם" מפעילה את חוויית SPEAR ONE המעודכנת
    if (key === 'contract-v2' && typeof App.openContractDashboardV2 === 'function') {
      App.openContractDashboardV2();
      return;
    }

    // חלק ניווט משחקים (navigation.js) – לחיצה על "משחקים" פותחת כ-overlay ללא רענון הפיד | HYPER CORE TECH
    if (key === 'games') {
      const gamesPanel = document.getElementById('gamesPanel');
      const gamesFrame = document.getElementById('gamesPanelFrame');
      if (gamesPanel && gamesFrame) {
        // Toggle - אם פתוח, סגור; אם סגור, פתח
        if (!gamesPanel.hidden) {
          gamesPanel.hidden = true;
          gamesFrame.src = '';
          console.log('[NAV] Games panel closed');
        } else {
          gamesFrame.src = './games.html?embedded=1';
          gamesPanel.hidden = false;
          console.log('[NAV] Games panel opened');
        }
        return;
      }
      // Fallback - אם אין פאנל, נווט לדף
      window.location.href = './games.html';
      return;
    }

    // חלק ניווט הכרויות (navigation.js) – לחיצה על "הכרויות" פותחת את דף הטינדר החדש
    if (key === 'dating') {
      window.location.href = './dating.html';
    }
  }

  navButtons.forEach((button) => {
    const key = button.getAttribute('data-nav');
    console.log('[NAV] Binding click listener to button:', key);
    button.addEventListener('click', handleNavClick);
  });

  // חלק ניווט הכרויות (navigation.js) – חיבור אייקון הלב בסרגל העליון לאותה התנהגות
  try {
    const newsTopBtn = document.getElementById('newsToggleTop');
    if (newsTopBtn) {
      newsTopBtn.addEventListener('click', () => {
        updateNavSelection('news');
        window.location.href = './news.html';
      });
    }
    const datingTopBtn = document.getElementById('datingToggleTop');
    if (datingTopBtn) {
      datingTopBtn.addEventListener('click', () => {
        updateNavSelection('dating');
        window.location.href = './dating.html';
      });
    }
    // חלק כפתור משחקים עליון (navigation.js) – פתיחה כ-overlay | HYPER CORE TECH
    const gamesTopBtn = document.getElementById('gamesToggleTop');
    if (gamesTopBtn) {
      gamesTopBtn.addEventListener('click', () => {
        updateNavSelection('games');
        const gamesPanel = document.getElementById('gamesPanel');
        const gamesFrame = document.getElementById('gamesPanelFrame');
        if (gamesPanel && gamesFrame) {
          gamesFrame.src = './games.html?embedded=1';
          gamesPanel.hidden = false;
          console.log('[NAV] Games panel opened from top button');
          return;
        }
        window.location.href = './games.html';
      });
    }
  } catch (_) {}

  // חלק ניווט ראשי (navigation.js) – בעת טעינה מחדש, דואג שלשונית ברירת המחדל תוצג
  updateNavSelection(App.activeNav);

  // חלק ניווט ראשי (navigation.js) – הסתרה והצגה של סרגל הניווט בעת גלילה
  let lastScrollY = window.scrollY;
  let frameRequestId = null;

  function scheduleNavStateUpdate() {
    if (frameRequestId) {
      window.cancelAnimationFrame(frameRequestId);
    }
    frameRequestId = window.requestAnimationFrame(() => {
      const currentY = window.scrollY;
      const isScrollingDown = currentY > lastScrollY;
      lastScrollY = currentY;

      if (currentY <= 90) {
        navRoot.classList.remove('primary-nav--hidden');
        navRoot.classList.remove('primary-nav--compact');
        return;
      }

      if (isScrollingDown) {
        navRoot.classList.add('primary-nav--hidden');
        navRoot.classList.remove('primary-nav--compact');
      } else {
        navRoot.classList.remove('primary-nav--hidden');
        navRoot.classList.add('primary-nav--compact');
      }
    });
  }

  window.addEventListener('scroll', scheduleNavStateUpdate, { passive: true });
})(window);
