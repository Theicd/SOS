// חלק ניווט ראשי (navigation.js) – ניהול מצב הניווט העליון באפליקציה
(function initNavigation(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק ניווט ראשי (navigation.js) – מאחסן את מצב הלשונית הפעילה
  App.activeNav = App.activeNav || 'news';

  const navRoot = document.querySelector('.primary-nav');
  if (!navRoot) {
    return;
  }

  const navButtons = Array.from(navRoot.querySelectorAll('[data-nav]'));

  function updateNavSelection(targetKey) {
    navButtons.forEach((button) => {
      const key = button.getAttribute('data-nav');
      const isActive = key === targetKey;
      button.classList.toggle('is-active', isActive);
    });
    App.activeNav = targetKey;
  }

  function handleNavClick(event) {
    const key = event.currentTarget.getAttribute('data-nav');
    if (!key) {
      return;
    }

    updateNavSelection(key);

    // חלק ניווט חוזה (navigation.js) – לחיצה על "חוזה חכם" פותחת את לוח החוזה המבוזר במקום הכפתור הצף הישן
    if (key === 'contract' && typeof App.openContractDashboard === 'function') {
      App.openContractDashboard();
      return;
    }

    // חלק ניווט חוזה 2 (navigation.js) – לחיצה על "חוזה חכם 2" מפעילה את חוויית SPEAR ONE החדשה
    if (key === 'contract-v2' && typeof App.openContractDashboardV2 === 'function') {
      App.openContractDashboardV2();
      return;
    }

    // חלק ניווט משחקים (navigation.js) – לחיצה על "משחקים" פותחת את מודול הטריוויה הראשי
    if (key === 'games') {
      window.location.href = './games.html';
      return;
    }

    // חלק ניווט פרופיל (navigation.js) – לחיצה על "פרופיל" מעבירה לדף הפרופיל האישי החדש
    if (key === 'profile') {
      window.location.href = './profile.html';
    }

    // חלק ניווט הכרויות (navigation.js) – לחיצה על "הכרויות" פותחת את דף הטינדר החדש
    if (key === 'dating') {
      window.location.href = './dating.html';
    }
  }

  navButtons.forEach((button) => {
    button.addEventListener('click', handleNavClick);
  });

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
