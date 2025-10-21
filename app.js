;(function bootstrapApp(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const tools = window.NostrTools;
  if (!tools) {
    console.error('NostrTools not available for bootstrap');
    return;
  }

  const { SimplePool } = tools;

  if (typeof App.ensureKeys === 'function') {
    App.ensureKeys();
  }

  App.profile = App.profile || {
    name: 'משתמש אנונימי',
    bio: 'יצירת תוכן מבוזר, בלי שוטר באמצע',
    avatarInitials: 'AN',
    picture: '',
  };

  if (!App.getInitials) {
    console.warn('getInitials missing on App. Defaulting to first letters only.');
    App.getInitials = (value = '') => value.trim().slice(0, 2).toUpperCase() || 'AN';
  }

  App.profile.avatarInitials = App.getInitials(App.profile.name || '');

  if (!App.profileCache) {
    App.profileCache = new Map();
  }
  App.profileCache.set(App.publicKey || 'self', {
    name: App.profile.name,
    bio: App.profile.bio,
    picture: App.profile.picture,
    initials: App.profile.avatarInitials,
  });

  if (!Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
    // חלק Bootstrap (app.js) – מגדיר רשימת ריליים ברירת מחדל כאשר הקונפיגורציה לא סיפקה אחת
    App.relayUrls = [
      'wss://relay.damus.io',
      'wss://relay.snort.social',
      'wss://nos.lol',
      'wss://purplerelay.com',
      'wss://relay.nostr.band',
    ];
  }

  App.pool = new SimplePool();
  if (typeof App.notifyPoolReady === 'function') {
    App.notifyPoolReady(App.pool);
  }
  document.getElementById('connection-status').textContent = 'Pool initialized. Connecting to relays...';
  console.log('Pool initialized');

  if (App.metadataPublishQueued && typeof App.publishProfileMetadata === 'function') {
    App.publishProfileMetadata();
  }

  if (typeof App.renderProfile === 'function') {
    // חלק Bootstrap (app.js) – דואג שהפרופיל הנוכחי יוצג מיד עם העלייה של האפליקציה
    App.renderProfile();
  }

  if (typeof App.loadOwnProfileMetadata === 'function') {
    // חלק Bootstrap (app.js) – מושך נתוני פרופיל מעודכנים מהריליים אם קיימים
    App.loadOwnProfileMetadata();
  }

  if (typeof App.subscribeOwnProfileMetadata === 'function') {
    // חלק Bootstrap (app.js) – מאזין לעדכונים שוטפים של פרטי הפרופיל מהריליים
    App.subscribeOwnProfileMetadata();
  }

  if (typeof App.loadFeed === 'function') {
    App.loadFeed();
  }

  if (typeof App.initializeGrowthDashboard === 'function') {
    App.initializeGrowthDashboard();
  }
  if (typeof App.initializeContractDashboard === 'function') {
    App.initializeContractDashboard();
  }

  window.openCompose = function openCompose() {
    document.getElementById('composeModal').style.display = 'flex';
  };

  window.closeCompose = function closeCompose() {
    document.getElementById('composeModal').style.display = 'none';
  };

  window.publishPost = App.publishPost || (() => {});
  window.openProfileSettings = App.openProfileSettings || (() => {});
  window.closeProfileSettings = App.closeProfileSettings || (() => {});
  window.saveProfileSettings = App.saveProfileSettings || (() => {});
  window.likePost = App.likePost || (() => {});
  window.sharePost = App.sharePost || (() => {});
  window.openGrowthDashboard = App.openGrowthDashboard || (() => {});
  window.closeGrowthDashboard = App.closeGrowthDashboard || (() => {});
  window.refreshGrowthDashboard = App.refreshGrowthDashboard || (() => {});
  window.openContractDashboard = App.openContractDashboard || (() => {});
  window.closeContractDashboard = App.closeContractDashboard || (() => {});
  window.openOptionPurchase = App.openOptionPurchase || (() => {});
  window.openContractDocs = App.openContractDocs || (() => {});

  // חלק סרגל עליון (app.js) – ניהול תפריט הפרופיל שנפתח תחת כפתור האווטר העליון
  (function initTopBarProfileMenu() {
    const profileWrapper = document.getElementById('topBarProfile');
    if (!profileWrapper) {
      return;
    }

    const profileButton = document.getElementById('topBarProfileButton');
    const profileMenu = document.getElementById('topBarProfileMenu');
    const selfButton = document.getElementById('topBarProfileSelf');
    const growthButton = document.getElementById('topBarProfileGrowth');
    const keyButton = document.getElementById('topBarProfileKey');

    if (!profileButton || !profileMenu) {
      return;
    }

    const closeMenu = () => {
      profileMenu.hidden = true;
      profileButton.setAttribute('aria-expanded', 'false');
    };

    const openMenu = () => {
      profileMenu.hidden = false;
      profileButton.setAttribute('aria-expanded', 'true');
    };

    const toggleMenu = () => {
      if (profileMenu.hidden) {
        openMenu();
      } else {
        closeMenu();
      }
    };

    profileButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleMenu();
    });

    window.addEventListener('click', (event) => {
      if (!profileWrapper.contains(event.target)) {
        closeMenu();
      }
    });

    if (selfButton) {
      selfButton.addEventListener('click', () => {
        closeMenu();
        window.location.href = 'profile.html';
      });
    }

    if (growthButton) {
      growthButton.addEventListener('click', () => {
        closeMenu();
        if (typeof window.openGrowthDashboard === 'function') {
          window.openGrowthDashboard();
        }
      });
    }

    if (keyButton) {
      keyButton.addEventListener('click', () => {
        closeMenu();
        if (typeof window.openKeyViewer === 'function') {
          window.openKeyViewer();
        }
      });
    }
  })();

  // חלק משחק טריוויה – מוודא שסקריפט המשחק נטען פעם אחת בלבד לאחר שהאפליקציה מוכנה
  if (!document.getElementById('triviaGameScript')) {
    const triviaScript = document.createElement('script');
    triviaScript.src = './game-trivia.js';
    triviaScript.id = 'triviaGameScript';
    triviaScript.defer = true;
    document.body.appendChild(triviaScript);
  }
})(window);
