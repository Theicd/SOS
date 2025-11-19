// חלק מדיה (media-mirror.js) – ניהול mirrors ו-fallback אוטומטי לוידאו/תמונות
// שייך: SOS2 מדיה, מטפל ב-URLs שנפלו ומחפש חלופות
(function initMediaMirror(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק mirror (media-mirror.js) – הגדרות
  const TIMEOUT_MS = 10000; // 10 שניות timeout לכל ניסיון
  const MAX_RETRIES = 3; // מקסימום ניסיונות לכל URL

  // חלק mirror (media-mirror.js) – רשימת דומיינים מהימנים שתמיד זמינים
  const TRUSTED_DOMAINS = [
    'nostr.build',
    'void.cat',
    'nostrcheck.me',
    'nostr.download',
    'nostpic.com',
  ];

  // חלק mirror (media-mirror.js) – בדיקה אם URL מדומיין מהימן
  function isTrustedDomain(url) {
    try {
      const urlObj = new URL(url);
      return TRUSTED_DOMAINS.some(domain => urlObj.hostname.includes(domain));
    } catch {
      return false;
    }
  }

  // חלק mirror (media-mirror.js) – בדיקת זמינות URL
  async function checkUrlAvailability(url, timeout = TIMEOUT_MS) {
    try {
      // אם זה דומיין מהימן, נחזיר true מיד בלי לבדוק
      if (isTrustedDomain(url)) {
        console.log('Trusted domain, skipping check:', url.slice(0, 50));
        return true;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      // ניסיון ראשון עם HEAD (מהיר יותר)
      try {
        const headResponse = await fetch(url, {
          method: 'HEAD',
          signal: controller.signal,
          cache: 'no-cache',
        });

        clearTimeout(timeoutId);
        if (headResponse.ok) {
          return true;
        }
      } catch (headErr) {
        console.warn('HEAD request failed, trying GET:', headErr.message);
      }

      // אם HEAD נכשל, ננסה GET עם range קטן
      const controller2 = new AbortController();
      const timeoutId2 = setTimeout(() => controller2.abort(), timeout);

      const response = await fetch(url, {
        method: 'GET',
        signal: controller2.signal,
        cache: 'no-cache',
        headers: {
          'Range': 'bytes=0-1024', // רק 1KB ראשון
        },
      });

      clearTimeout(timeoutId2);
      return response.ok || response.status === 206; // 206 = Partial Content
    } catch (err) {
      console.warn('URL not available:', url, err.message);
      return false;
    }
  }

  // חלק mirror (media-mirror.js) – טעינת מדיה עם fallback chain
  async function loadMediaWithFallback(primaryUrl, mirrors = [], hash = null) {
    // רשימת כל ה-URLs לנסות (ראשי + mirrors)
    const urlsToTry = [primaryUrl, ...mirrors].filter(Boolean);

    console.log(`Trying to load media with ${urlsToTry.length} URLs...`);

    // ניסיון 1: טעינה מ-cache אם יש hash
    if (hash && typeof App.getCachedMedia === 'function') {
      try {
        const cached = await App.getCachedMedia(hash);
        if (cached && cached.blob) {
          console.log('✓ Loaded from cache:', hash.slice(0, 16));
          return {
            success: true,
            blob: cached.blob,
            url: cached.url,
            source: 'cache',
          };
        }
      } catch (err) {
        console.warn('Cache lookup failed:', err);
      }
    }

    // ניסיון 2: נסה כל URL ברשימה
    for (let i = 0; i < urlsToTry.length; i++) {
      const url = urlsToTry[i];
      console.log(`Trying URL ${i + 1}/${urlsToTry.length}:`, url);

      for (let retry = 0; retry < MAX_RETRIES; retry++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

          const response = await fetch(url, {
            signal: controller.signal,
            cache: 'default',
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const blob = await response.blob();

          // שמירה ב-cache אם יש hash
          if (hash && typeof App.cacheMedia === 'function') {
            App.cacheMedia(url, hash, blob, blob.type).catch(err => {
              console.warn('Failed to cache media:', err);
            });
          }

          console.log(`✓ Loaded from URL ${i + 1}:`, url);
          return {
            success: true,
            blob,
            url,
            source: i === 0 ? 'primary' : 'mirror',
            mirrorIndex: i,
          };
        } catch (err) {
          console.warn(`Attempt ${retry + 1}/${MAX_RETRIES} failed for ${url}:`, err.message);
          
          if (retry < MAX_RETRIES - 1) {
            // המתנה קצרה לפני ניסיון נוסף
            await new Promise(resolve => setTimeout(resolve, 1000 * (retry + 1)));
          }
        }
      }
    }

    // כל הניסיונות נכשלו
    console.error('✗ All URLs failed to load');
    return {
      success: false,
      error: 'All mirror URLs failed',
    };
  }

  // חלק mirror (media-mirror.js) – יצירת mirror חדש על ידי העלאה ל-Blossom
  async function createMirror(blob, hash) {
    try {
      if (typeof App.uploadToBlossom !== 'function') {
        console.warn('Blossom upload not available');
        return null;
      }

      console.log('Creating new mirror via Blossom...');
      const result = await App.uploadToBlossom(blob, hash);

      if (result && result.url) {
        console.log('✓ Mirror created:', result.url);
        return result.url;
      }

      return null;
    } catch (err) {
      console.error('Failed to create mirror:', err);
      return null;
    }
  }

  // חלק mirror (media-mirror.js) – פרסום תגית mirror חדשה לאירוע
  async function publishMirrorTag(eventId, mirrorUrl, hash) {
    try {
      // זה ידרוש הרחבה של compose.js או feed.js
      // כרגע רק נדפיס log
      console.log('TODO: Publish mirror tag for event', eventId, {
        mirror: mirrorUrl,
        hash,
      });

      // בעתיד: נשלח kind 1 event עם תגית:
      // ['mirror', mirrorUrl, hash, eventId]
      
      return true;
    } catch (err) {
      console.error('Failed to publish mirror tag:', err);
      return false;
    }
  }

  // חלק mirror (media-mirror.js) – טיפול באירוע שבו URL נפל
  async function handleFailedUrl(primaryUrl, hash, eventId = null) {
    console.log('Handling failed URL:', primaryUrl);

    // ניסיון לטעון מ-cache
    if (hash && typeof App.getCachedMedia === 'function') {
      const cached = await App.getCachedMedia(hash);
      if (cached && cached.blob) {
        console.log('Found in cache, creating new mirror...');
        
        // יצירת mirror חדש מה-cache
        const mirrorUrl = await createMirror(cached.blob, hash);
        
        if (mirrorUrl && eventId) {
          // פרסום תגית mirror
          await publishMirrorTag(eventId, mirrorUrl, hash);
        }

        return {
          success: true,
          blob: cached.blob,
          newMirror: mirrorUrl,
        };
      }
    }

    // אם אין ב-cache, נצטרך לבקש מ-peers (שלב 4)
    console.warn('Media not in cache, would need P2P request');
    return {
      success: false,
      needsP2P: true,
    };
  }

  // חלק mirror (media-mirror.js) – חילוץ mirrors מתגיות אירוע
  function extractMirrorsFromEvent(event) {
    const mirrors = [];
    
    try {
      if (Array.isArray(event.tags)) {
        event.tags.forEach(tag => {
          if (Array.isArray(tag) && tag[0] === 'mirror' && tag[1]) {
            mirrors.push({
              url: tag[1],
              hash: tag[2] || null,
            });
          }
        });
      }
    } catch (err) {
      console.warn('Failed to extract mirrors:', err);
    }

    return mirrors;
  }

  // חלק mirror (media-mirror.js) – בדיקת זמינות כל ה-mirrors באירוע
  async function checkEventMirrors(event) {
    const mirrors = extractMirrorsFromEvent(event);
    
    if (mirrors.length === 0) {
      return { available: [], unavailable: [] };
    }

    console.log(`Checking ${mirrors.length} mirrors for event ${event.id.slice(0, 8)}...`);

    const results = await Promise.all(
      mirrors.map(async (mirror) => {
        const isAvailable = await checkUrlAvailability(mirror.url);
        return { ...mirror, available: isAvailable };
      })
    );

    const available = results.filter(r => r.available);
    const unavailable = results.filter(r => !r.available);

    console.log(`Mirrors status: ${available.length} available, ${unavailable.length} unavailable`);

    return { available, unavailable };
  }

  // חלק mirror (media-mirror.js) – קבלת URL הטוב ביותר לשימוש
  async function getBestMediaUrl(primaryUrl, mirrors = []) {
    // בדיקה מהירה של ה-URL הראשי
    const primaryAvailable = await checkUrlAvailability(primaryUrl);
    
    if (primaryAvailable) {
      return primaryUrl;
    }

    // אם הראשי נפל, נסה mirrors
    for (const mirror of mirrors) {
      const url = typeof mirror === 'string' ? mirror : mirror.url;
      const available = await checkUrlAvailability(url);
      
      if (available) {
        console.log('Using mirror instead of primary:', url);
        return url;
      }
    }

    // אף אחד לא זמין
    console.warn('No available URLs found');
    return null;
  }

  // חשיפה ל-App
  Object.assign(App, {
    loadMediaWithFallback,
    createMirror,
    extractMirrorsFromEvent,
    checkEventMirrors,
    getBestMediaUrl,
    handleFailedUrl,
    checkUrlAvailability,
  });

  console.log('Media mirror module initialized');
})(window);
