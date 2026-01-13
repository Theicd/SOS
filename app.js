(function bootstrapApp(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const tools = window.NostrTools;
  if (!tools) {
    console.error('NostrTools not available for bootstrap');
    return;
  }

  const { SimplePool, finalizeEvent, getEventHash, getSignature } = tools;
  
  // הוספת finalizeEvent ל-App
  if (!App.finalizeEvent && typeof finalizeEvent === 'function') {
    App.finalizeEvent = finalizeEvent;
  } else if (!App.finalizeEvent && typeof getEventHash === 'function' && typeof getSignature === 'function') {
    // fallback אם finalizeEvent לא קיים
    App.finalizeEvent = (event, privateKey) => {
      event.id = getEventHash(event);
      event.sig = getSignature(event, privateKey);
      return event;
    };
  }

  function hookPoolForEventSync(pool) {
    if (!pool || App._eventSyncPoolHooked || typeof pool.subscribeMany !== 'function') {
      return;
    }

    const originalSubscribeMany = pool.subscribeMany.bind(pool);
    pool.subscribeMany = (relays, filters, handlers = {}) => {
      const originalOnevent = handlers.onevent;
      return originalSubscribeMany(relays, filters, Object.assign({}, handlers, {
        onevent: (event) => {
          try { App.EventSync?.ingestEvent?.(event, { source: 'relay' }); } catch (_) {}
          if (typeof originalOnevent === 'function') {
            return originalOnevent(event);
          }
        },
      }));
    };

    App._eventSyncPoolHooked = true;
  }
  const LOGIN_METRIC_KIND = 1050; // חלק מדדי שימוש (app.js) – kind עבור רישום כניסות למערכת | HYPER CORE TECH
  let loginMetricRetryHandle = null;

  function scheduleLoginMetricRetry() {
    if (loginMetricRetryHandle) {
      return;
    }
    loginMetricRetryHandle = window.setTimeout(() => {
      loginMetricRetryHandle = null;
      publishLoginActivity();
    }, 1200);
  }

  async function publishLoginActivity() {
    // חלק מדדי שימוש (app.js) – שולח אירוע kind 1050 עם תג login כדי להזין את לוח הגידול | HYPER CORE TECH
    if (App._loginMetricPublished) {
      return;
    }
    if (
      !App.pool ||
      !Array.isArray(App.relayUrls) ||
      App.relayUrls.length === 0 ||
      !App.privateKey ||
      !App.publicKey ||
      typeof App.finalizeEvent !== 'function'
    ) {
      scheduleLoginMetricRetry();
      return;
    }

    const tags = [['t', 'login']];
    if (App.NETWORK_TAG) {
      tags.push(['t', App.NETWORK_TAG]);
    }

    const event = {
      kind: LOGIN_METRIC_KIND,
      pubkey: App.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: JSON.stringify({ type: 'login', at: new Date().toISOString() }),
    };

    try {
      const signed = App.finalizeEvent(event, App.privateKey);
      await App.pool.publish(App.relayUrls, signed);
      App._loginMetricPublished = true;
    } catch (error) {
      console.warn('Login metric publish failed', error);
      scheduleLoginMetricRetry();
    }
  }

  // =======================
  // מצב אורח - NostrApp (app.js) – זיהוי אם המשתמש עובד כאורח או כמשתמש מחובר | HYPER CORE TECH
  // קוד זה אחראי לזהות האם המשתמש עובד כאורח (בלי מפתח) או כמשתמש מחובר
  // =======================
  (function initGuestMode() {
    try {
      const storedKey = window.localStorage.getItem('nostr_private_key');

      if (storedKey && typeof storedKey === 'string' && storedKey.trim().length > 0) {
        // יש מפתח שמור - מצב משתמש מחובר
        App.guestMode = false;
        App.privateKey = storedKey;
        if (typeof App.ensureKeys === 'function') {
          App.ensureKeys();
        }
      } else {
        // אין מפתח שמור - מצב אורח מלא
        App.guestMode = true;
        App.privateKey = null;
        App.publicKey = null;
      }
    } catch (e) {
      // במקרה של שגיאה נקבע כברירת מחדל מצב אורח
      console.error('Guest mode init failed, falling back to guest:', e);
      App.guestMode = true;
      App.privateKey = null;
      App.publicKey = null;
    }
  })();

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
      'wss://relay.snort.social',
      'wss://nos.lol',
      'wss://nostr-relay.xbytez.io',
      'wss://nostr-02.uid.ovh',
    ];
  }

  if (!Array.isArray(App.p2pRelayUrls) || App.p2pRelayUrls.length === 0) {
    App.p2pRelayUrls = [
      'wss://relay.snort.social',
      'wss://nos.lol',
      'wss://nostr-relay.xbytez.io',
      'wss://nostr.0x7e.xyz',
    ];
  }

  // חלק Bootstrap (app.js) – יצירת Pool והרצת מדדי התחברות פעם אחת בלבד בכל סשן
  if (!App.pool) {
    App.pool = new SimplePool();
    hookPoolForEventSync(App.pool);
    if (typeof App.notifyPoolReady === 'function') {
      App.notifyPoolReady(App.pool);
    }
    publishLoginActivity();
    const connectionStatus = document.getElementById('connection-status');
    if (connectionStatus) {
      connectionStatus.textContent = 'Pool initialized. Connecting to relays...';
    }
    console.log('Pool initialized');
  }

  hookPoolForEventSync(App.pool);

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

  // חלק HOME FEED – הפעלת מצב טעינה מוקדם למניעת גלילה לפני טעינת הסט הראשון
  try {
    if (document.querySelector('.home-feed__viewport')) {
      document.body.classList.add('home-feed--loading');
    }
  } catch (_) {}

  // אל תטען את הפיד מחדש בעמודים שניים (למשל storage.html)
  if (!App._bootstrapped && typeof App.loadFeed === 'function') {
    App.loadFeed();
  }

  if (!App._bootstrapped && typeof App.initializeGrowthDashboard === 'function') {
    App.initializeGrowthDashboard();
  }

  window.openCompose = function openCompose() {
    // בדיקת מצב אורח - חסימת יצירת פוסט למשתמשים לא מחוברים | HYPER CORE TECH
    if (typeof App.requireAuth === 'function') {
      if (!App.requireAuth('כדי ליצור פוסט חדש צריך להתחבר או להירשם.')) {
        return;
      }
    }
    // חלק קומפוזר (app.js) – מפנה לפונקציית המודאל המרכזית ב-compose.js כדי למנוע מצבי תצוגה כפולים
    if (typeof App.openCompose === 'function') {
      App.openCompose();
      return;
    }
    const m = document.getElementById('composeModal');
    if (m) m.style.display = 'flex';
  };

  window.closeCompose = function closeCompose() {
    // חלק קומפוזר (app.js) – מפנה לפונקציית הסגירה המרכזית ב-compose.js
    if (typeof App.closeCompose === 'function') {
      App.closeCompose();
      return;
    }
    const m = document.getElementById('composeModal');
    if (m) m.style.display = 'none';
  };

  // =======================
  // דרישת התחברות לפעולות שכותבות לרשת (app.js) – Auth Guard | HYPER CORE TECH
  // פונקציה זו משמשת כל הכפתורים של לייק, תגובה, עקוב, פרסום ועוד
  // =======================
  App.requireAuth = function(requirementText, onAuthenticated) {
    const hasKey = !!App.privateKey && typeof App.privateKey === 'string';

    if (hasKey && App.guestMode === false) {
      // כבר מחובר - אפשר להמשיך
      if (typeof onAuthenticated === 'function') {
        onAuthenticated();
      }
      return true;
    }

    // מצב אורח - מציג חלון התחברות / הרשמה
    if (typeof App.openAuthPrompt === 'function') {
      App.openAuthPrompt(requirementText || 'כדי להמשיך צריך להתחבר או להירשם.');
    } else {
      // נפילה אחורית: מעבר למסך auth.html עם פרמטר redirect
      const redirect = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = 'auth.html?redirect=' + redirect;
    }

    return false;
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
    const homeButton = document.getElementById('topBarProfileHome');
    const keyButton = document.getElementById('topBarProfileKey');
    const contractButton = document.getElementById('topBarProfileContract');
    const storageButton = document.getElementById('topBarProfileStorage');
    const miscMenuButton = document.getElementById('topBarMiscMenu');
    const miscSubmenu = document.getElementById('topBarMiscSubmenu');

    if (!profileButton || !profileMenu) {
      return;
    }

    // מניעת חיבור כפול של מאזינים בעת טעינת עמוד נוסף
    if (profileWrapper.dataset.bound === '1') {
      return;
    }

    const closeMenu = () => {
      profileMenu.hidden = true;
      profileButton.setAttribute('aria-expanded', 'false');
      // סגירת תת-תפריט שונות
      if (miscSubmenu) {
        miscSubmenu.hidden = true;
        if (miscMenuButton) {
          miscMenuButton.classList.remove('top-bar__dropdown-item--active');
        }
      }
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

    // חלק תת-תפריט שונות (app.js) – ניהול פתיחה/סגירה של תת-תפריט | HYPER CORE TECH
    const toggleMiscSubmenu = () => {
      if (!miscSubmenu || !miscMenuButton) return;
      
      const wasHidden = miscSubmenu.hidden;
      if (wasHidden) {
        miscSubmenu.hidden = false;
        miscMenuButton.classList.add('top-bar__dropdown-item--active');
      } else {
        miscSubmenu.hidden = true;
        miscMenuButton.classList.remove('top-bar__dropdown-item--active');
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

    // חלק תת-תפריט שונות (app.js) – כעת נפתח מיד ללא סיסמה | HYPER CORE TECH
    if (miscMenuButton) {
      miscMenuButton.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleMiscSubmenu();
      });
    }

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

    if (homeButton) {
      homeButton.addEventListener('click', () => {
        closeMenu();
        window.location.href = 'index.html';
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

    // חלק חוזה חכם (app.js) – כפתור בתפריט הפרופיל לפתיחת לוח החוזה החכם כמו בתפריט התחתון
    if (contractButton) {
      contractButton.addEventListener('click', () => {
        closeMenu();
        if (typeof App.openContractDashboardV2 === 'function') {
          App.openContractDashboardV2();
        } else if (typeof window.openContractDashboardV2 === 'function') {
          window.openContractDashboardV2();
        }
      });
    }

    // חלק אחסון (app.js) – ניווט מהתפריט העליון לעמוד האחסון | HYPER CORE TECH
    if (storageButton) {
      storageButton.addEventListener('click', () => {
        closeMenu();
        window.location.href = 'storage.html';
      });
    }

    // חלק תת-תפריט שונות (app.js) – מאזינים לכפתורים בתת-תפריט | HYPER CORE TECH
    const newsButton = document.getElementById('newsToggleTop');
    if (newsButton) {
      newsButton.addEventListener('click', () => {
        closeMenu();
        window.location.href = 'news.html';
      });
    }

    // חלק כפתור משחקים (app.js) – פתיחה כ-overlay במקום ניווט לדף | HYPER CORE TECH
    const gamesButton = document.getElementById('gamesToggleTop');
    if (gamesButton) {
      gamesButton.addEventListener('click', () => {
        closeMenu();
        // פתיחה כ-overlay אם קיים הפאנל
        const gamesPanel = document.getElementById('gamesPanel');
        const gamesFrame = document.getElementById('gamesPanelFrame');
        if (gamesPanel && gamesFrame) {
          gamesFrame.src = './games.html?embedded=1';
          gamesPanel.hidden = false;
          console.log('[APP] Games panel opened from top menu');
          return;
        }
        // Fallback
        window.location.href = 'games.html';
      });
    }

    const datingButton = document.getElementById('datingToggleTop');
    if (datingButton) {
      datingButton.addEventListener('click', () => {
        closeMenu();
        window.location.href = 'dating.html';
      });
    }

    profileWrapper.dataset.bound = '1';
  })();

  // חלק משחק טריוויה – מוודא שסקריפט המשחק נטען פעם אחת בלבד לאחר שהאפליקציה מוכנה
  if (!document.getElementById('triviaGameScript')) {
    const triviaScript = document.createElement('script');
    triviaScript.src = './game-trivia.js';
    triviaScript.id = 'triviaGameScript';
    triviaScript.defer = true;
    document.body.appendChild(triviaScript);
  }
  // סימון שהאתחול הכבד בוצע – כדי להימנע מריצה חוזרת בדפים נוספים
  App._bootstrapped = true;
})(window);
