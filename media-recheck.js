// חלק מדיה (media-recheck.js) – בדיקה תקופתית של זמינות URLs ויצירת mirrors אוטומטית
// שייך: SOS2 מדיה, רץ ברקע ובודק URLs שנפלו
(function initMediaRecheck(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק recheck (media-recheck.js) – הגדרות
  const RECHECK_INTERVAL = 30 * 60 * 1000; // 30 דקות
  const BATCH_SIZE = 10; // כמה URLs לבדוק בכל פעם
  const MIN_RECHECK_DELAY = 5 * 60 * 1000; // 5 דקות מינימום בין בדיקות
  const AUTO_PUBLISH_MIRRORS = false; // כיבוי פרסום אוטומטי של mirrors (למנוע החלפת לינקים)
  const ENABLE_AUTO_MIRROR_CREATION = false; // כיבוי יצירת mirrors אוטומטית - צריך לבקש מהמשתמש המקורי!

  let recheckTimer = null;
  let isRecheckRunning = false;
  let lastRecheckTime = 0;
  let mediaRegistry = new Map(); // מפה של URLs שנמצאים בפיד

  // חלק recheck (media-recheck.js) – רישום URL לבדיקה
  function registerMediaUrl(url, hash, eventId, mirrors = []) {
    if (!url) return;

    mediaRegistry.set(url, {
      url,
      hash: hash || null,
      eventId: eventId || null,
      mirrors: mirrors || [],
      lastCheck: 0,
      status: 'unknown', // unknown, available, unavailable
      failCount: 0,
    });

    console.log(`Registered media URL: ${url.slice(0, 50)}...`);
  }

  // חלק recheck (media-recheck.js) – הסרת URL מהרישום
  function unregisterMediaUrl(url) {
    if (mediaRegistry.has(url)) {
      mediaRegistry.delete(url);
      console.log(`Unregistered media URL: ${url.slice(0, 50)}...`);
    }
  }

  // חלק recheck (media-recheck.js) – קבלת כל ה-URLs שצריך לבדוק
  function getUrlsToCheck() {
    const now = Date.now();
    const urls = [];

    for (const [url, info] of mediaRegistry.entries()) {
      // בדיקה רק אם עבר מספיק זמן מהבדיקה האחרונה
      if (now - info.lastCheck >= MIN_RECHECK_DELAY) {
        urls.push({ url, info });
      }
    }

    // מיון לפי עדיפות: URLs שנכשלו קודם
    urls.sort((a, b) => {
      if (a.info.status === 'unavailable' && b.info.status !== 'unavailable') return -1;
      if (a.info.status !== 'unavailable' && b.info.status === 'unavailable') return 1;
      return b.info.failCount - a.info.failCount;
    });

    return urls.slice(0, BATCH_SIZE);
  }

  // חלק recheck (media-recheck.js) – בדיקת URL בודד
  async function checkSingleUrl(url, info) {
    const now = Date.now();
    info.lastCheck = now;

    try {
      if (typeof App.checkUrlAvailability !== 'function') {
        console.warn('checkUrlAvailability not available');
        return false;
      }

      const isAvailable = await App.checkUrlAvailability(url);

      if (isAvailable) {
        info.status = 'available';
        info.failCount = 0;
        return true;
      } else {
        info.status = 'unavailable';
        info.failCount++;
        console.warn(`URL unavailable (${info.failCount} fails):`, url);
        return false;
      }
    } catch (err) {
      info.status = 'unavailable';
      info.failCount++;
      console.error('URL check failed:', url, err);
      return false;
    }
  }

  // חלק recheck (media-recheck.js) – ניסיון ליצור mirror חדש
  async function attemptMirrorCreation(url, hash, eventId) {
    try {
      console.log('Attempting to create mirror for:', url);

      // ניסיון לטעון מ-cache
      if (!hash || typeof App.getCachedMedia !== 'function') {
        console.warn('Cannot create mirror: no hash or cache unavailable');
        return null;
      }

      const cached = await App.getCachedMedia(hash);
      if (!cached || !cached.blob) {
        console.warn('Cannot create mirror: not in cache');
        return null;
      }

      // יצירת mirror חדש
      if (typeof App.createMirror !== 'function') {
        console.warn('createMirror not available');
        return null;
      }

      const mirrorUrl = await App.createMirror(cached.blob, hash);
      
      if (!mirrorUrl) {
        console.warn('Failed to create mirror');
        return null;
      }

      console.log('✓ Mirror created successfully:', mirrorUrl);

      // פרסום תגית mirror רק אם מופעל
      if (eventId && AUTO_PUBLISH_MIRRORS) {
        await publishMirrorUpdate(eventId, mirrorUrl, hash);
      } else if (eventId) {
        console.log('Mirror created but not published (AUTO_PUBLISH_MIRRORS=false)');
      }

      return mirrorUrl;
    } catch (err) {
      console.error('Mirror creation failed:', err);
      return null;
    }
  }

  // חלק recheck (media-recheck.js) – בקשה מהמשתמש המקורי להעלות מחדש
  async function requestReuploadFromAuthor(eventId, failedUrl, hash) {
    try {
      console.log('🔄 Requesting re-upload from original author...');
      
      // מציאת המשתמש המקורי של הפוסט
      const authorPubkey = App.eventAuthorById?.get(eventId);
      
      if (!authorPubkey) {
        console.warn('Cannot find original author for event:', eventId);
        return false;
      }
      
      console.log('Original author:', authorPubkey.slice(0, 16) + '...');
      
      // בדיקה אם זה המשתמש הנוכחי
      if (authorPubkey === App.publicKey) {
        console.log('⚠️ This is YOUR post! You should re-upload the media.');
        // TODO: פתיחת דיאלוג למשתמש לבקש ממנו להעלות מחדש
        return false;
      }
      
      // שליחת kind 1 event עם בקשה להעלאה מחדש
      if (!App.pool || !App.publicKey || typeof App.finalizeEvent !== 'function') {
        console.warn('Cannot send re-upload request: missing pool or keys');
        return false;
      }
      
      const draft = {
        kind: 1,
        pubkey: App.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', eventId, '', 'root'],  // קישור לפוסט המקורי
          ['p', authorPubkey],          // תיוג המשתמש המקורי
          ['x', hash || ''],            // hash של המדיה
          ['request', 'reupload'],      // סוג הבקשה
        ],
        content: `🔄 Media unavailable: ${failedUrl.slice(0, 50)}...\nPlease re-upload if you have the original file.`,
      };
      
      const event = App.finalizeEvent(draft, App.privateKey);
      await App.pool.publish(App.relayUrls, event);
      
      console.log('✓ Re-upload request sent to author');
      return true;
      
    } catch (err) {
      console.error('Failed to request re-upload:', err);
      return false;
    }
  }

  // חלק recheck (media-recheck.js) – פרסום עדכון mirror לרשת
  async function publishMirrorUpdate(eventId, mirrorUrl, hash) {
    try {
      // בדיקה שיש לנו את כל הכלים הנדרשים
      if (!App.pool || !App.publicKey || !App.privateKey) {
        console.warn('Cannot publish mirror: pool or keys not available');
        return false;
      }

      if (typeof App.finalizeEvent !== 'function') {
        console.warn('Cannot publish mirror: finalizeEvent not available');
        return false;
      }

      if (!Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
        console.warn('Cannot publish mirror: no relays configured');
        return false;
      }

      // יצירת kind 1 event עם תגית mirror
      const draft = {
        kind: 1,
        pubkey: App.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', eventId, '', 'root'],  // קישור לפוסט המקורי
          ['mirror', mirrorUrl, hash],  // תגית mirror חדשה
          ['x', hash],                   // hash לזיהוי
        ],
        content: `🔄 Mirror created for media`,
      };

      // חתימה ופרסום
      const event = App.finalizeEvent(draft, App.privateKey);
      await App.pool.publish(App.relayUrls, event);

      console.log('✓ Mirror published to network:', {
        eventId: event.id.slice(0, 8),
        mirrorUrl: mirrorUrl.slice(0, 50),
        hash: hash.slice(0, 16),
      });

      return true;
    } catch (err) {
      console.error('Failed to publish mirror update:', err);
      return false;
    }
  }

  // חלק recheck (media-recheck.js) – בדיקת כל ה-mirrors של URL
  async function checkUrlMirrors(url, info) {
    if (!info.mirrors || info.mirrors.length === 0) {
      return [];
    }

    console.log(`Checking ${info.mirrors.length} mirrors for ${url.slice(0, 50)}...`);

    const results = await Promise.all(
      info.mirrors.map(async (mirrorUrl) => {
        const isAvailable = await App.checkUrlAvailability(mirrorUrl);
        return { url: mirrorUrl, available: isAvailable };
      })
    );

    const available = results.filter(r => r.available).map(r => r.url);
    const unavailable = results.filter(r => !r.available).map(r => r.url);

    if (unavailable.length > 0) {
      console.warn(`${unavailable.length} mirrors unavailable`);
    }

    return available;
  }

  // חלק recheck (media-recheck.js) – טיפול ב-URL שנפל
  async function handleUnavailableUrl(url, info) {
    console.log('Handling unavailable URL:', url);

    // בדיקת mirrors קיימים
    const availableMirrors = await checkUrlMirrors(url, info);

    if (availableMirrors.length > 0) {
      console.log(`Found ${availableMirrors.length} working mirrors`);
      return true;
    }

    // אם אין mirrors זמינים ויצירה אוטומטית מופעלת
    if (ENABLE_AUTO_MIRROR_CREATION && info.hash && info.eventId) {
      const newMirror = await attemptMirrorCreation(url, info.hash, info.eventId);
      
      if (newMirror) {
        // הוספת ה-mirror החדש לרשימה
        info.mirrors.push(newMirror);
        return true;
      }
    } else if (!ENABLE_AUTO_MIRROR_CREATION) {
      console.warn('⚠️ URL unavailable but auto-mirror creation is DISABLED');
      console.warn('   Requesting re-upload from original author...');
      console.warn('   URL:', url);
      console.warn('   EventID:', info.eventId);
      
      // שליחת בקשה למשתמש המקורי להעלות מחדש
      if (info.eventId) {
        await requestReuploadFromAuthor(info.eventId, url, info.hash);
      }
    }

    // אם כל הניסיונות נכשלו
    console.warn('Could not recover URL:', url);
    return false;
  }

  // חלק recheck (media-recheck.js) – הרצת בדיקה תקופתית
  async function runRecheck() {
    if (isRecheckRunning) {
      console.log('Recheck already running, skipping...');
      return;
    }

    const now = Date.now();
    if (now - lastRecheckTime < MIN_RECHECK_DELAY) {
      console.log('Too soon for recheck, skipping...');
      return;
    }

    isRecheckRunning = true;
    lastRecheckTime = now;

    try {
      const urlsToCheck = getUrlsToCheck();

      if (urlsToCheck.length === 0) {
        console.log('No URLs to recheck');
        return;
      }

      console.log(`Rechecking ${urlsToCheck.length} URLs...`);

      for (const { url, info } of urlsToCheck) {
        const isAvailable = await checkSingleUrl(url, info);

        if (!isAvailable) {
          // URL נפל - ננסה לטפל בזה
          await handleUnavailableUrl(url, info);
        }

        // המתנה קצרה בין בדיקות
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      console.log('Recheck completed');
    } catch (err) {
      console.error('Recheck failed:', err);
    } finally {
      isRecheckRunning = false;
    }
  }

  // חלק recheck (media-recheck.js) – התחלת בדיקה תקופתית
  function startRecheck() {
    if (recheckTimer) {
      console.log('Recheck already started');
      return;
    }

    console.log(`Starting media recheck (interval: ${RECHECK_INTERVAL / 60000} minutes)`);

    // בדיקה ראשונה אחרי 5 דקות
    setTimeout(() => {
      runRecheck();
    }, 5 * 60 * 1000);

    // בדיקות תקופתיות
    recheckTimer = setInterval(() => {
      runRecheck();
    }, RECHECK_INTERVAL);
  }

  // חלק recheck (media-recheck.js) – עצירת בדיקה תקופתית
  function stopRecheck() {
    if (recheckTimer) {
      clearInterval(recheckTimer);
      recheckTimer = null;
      console.log('Media recheck stopped');
    }
  }

  // חלק recheck (media-recheck.js) – קבלת סטטיסטיקות
  function getRecheckStats() {
    const stats = {
      total: mediaRegistry.size,
      available: 0,
      unavailable: 0,
      unknown: 0,
      withMirrors: 0,
    };

    for (const [url, info] of mediaRegistry.entries()) {
      if (info.status === 'available') stats.available++;
      else if (info.status === 'unavailable') stats.unavailable++;
      else stats.unknown++;

      if (info.mirrors && info.mirrors.length > 0) {
        stats.withMirrors++;
      }
    }

    return stats;
  }

  // חלק recheck (media-recheck.js) – ניקוי רישום ישן
  function cleanupRegistry() {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 שעות

    let cleaned = 0;
    for (const [url, info] of mediaRegistry.entries()) {
      if (now - info.lastCheck > maxAge) {
        mediaRegistry.delete(url);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`Cleaned ${cleaned} old URLs from registry`);
    }
  }

  // חלק recheck (media-recheck.js) – בדיקה ידנית מיידית
  async function recheckNow() {
    console.log('Manual recheck triggered');
    await runRecheck();
  }

  // חשיפה ל-App
  Object.assign(App, {
    registerMediaUrl,
    unregisterMediaUrl,
    startMediaRecheck: startRecheck,
    stopMediaRecheck: stopRecheck,
    recheckMediaNow: recheckNow,
    getMediaRecheckStats: getRecheckStats,
  });

  // אתחול אוטומטי
  function init() {
    console.log('=== Media Recheck Module Initialized ===');
    console.log(`AUTO_PUBLISH_MIRRORS: ${AUTO_PUBLISH_MIRRORS} (mirrors will ${AUTO_PUBLISH_MIRRORS ? '' : 'NOT '}be published automatically)`);
    console.log(`ENABLE_AUTO_MIRROR_CREATION: ${ENABLE_AUTO_MIRROR_CREATION} (mirrors will ${ENABLE_AUTO_MIRROR_CREATION ? '' : 'NOT '}be created automatically)`);
    
    if (!ENABLE_AUTO_MIRROR_CREATION) {
      console.log('✓ System will REQUEST RE-UPLOAD from original authors instead of creating mirrors');
    }
    
    // התחלת בדיקה תקופתית
    startRecheck();

    // ניקוי תקופתי של הרישום
    setInterval(cleanupRegistry, 60 * 60 * 1000); // כל שעה
  }

  // אתחול
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
