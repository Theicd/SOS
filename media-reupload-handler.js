// חלק מדיה (media-reupload-handler.js) – טיפול בבקשות להעלאה מחדש של מדיה
// שייך: SOS2 מדיה, מאזין לבקשות re-upload ומציג התראות למשתמש
(function initMediaReuploadHandler(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק reupload (media-reupload-handler.js) – רשימת בקשות העלאה מחדש
  const reuploadRequests = new Map(); // eventId -> { requests: [], url: '', hash: '' }

  // חלק reupload (media-reupload-handler.js) – האזנה לבקשות העלאה מחדש
  function listenForReuploadRequests() {
    if (!App.pool || !App.publicKey || !Array.isArray(App.relayUrls)) {
      console.warn('Cannot listen for reupload requests: missing pool or keys');
      return;
    }

    console.log('👂 Listening for media re-upload requests...');

    // האזנה ל-kind 1 events עם תגית request=reupload שמתייגים אותי
    const filters = [
      {
        kinds: [1],
        '#p': [App.publicKey],
        '#request': ['reupload'],
        since: Math.floor(Date.now() / 1000) - 24 * 3600, // 24 שעות אחורה
      },
    ];

    try {
      const sub = App.pool.subscribeMany(App.relayUrls, filters, {
        onevent: (event) => {
          handleReuploadRequest(event);
        },
        oneose: () => {
          console.log('✓ Loaded existing re-upload requests');
        },
      });

      // שמירת ה-subscription כדי שנוכל לעצור אותו
      App._reuploadRequestsSub = sub;
    } catch (err) {
      console.error('Failed to subscribe to reupload requests:', err);
    }
  }

  // חלק reupload (media-reupload-handler.js) – טיפול בבקשת העלאה מחדש
  function handleReuploadRequest(event) {
    try {
      if (!event || !event.tags) return;

      // חילוץ מידע מהתגיות
      let eventId = null;
      let hash = null;
      let requesterPubkey = event.pubkey;

      event.tags.forEach(tag => {
        if (tag[0] === 'e' && tag[1]) {
          eventId = tag[1];
        } else if (tag[0] === 'x' && tag[1]) {
          hash = tag[1];
        }
      });

      if (!eventId) {
        console.warn('Re-upload request without event ID');
        return;
      }

      // בדיקה אם זה באמת הפוסט שלי
      const authorPubkey = App.eventAuthorById?.get(eventId);
      if (authorPubkey !== App.publicKey) {
        console.log('Re-upload request for someone else\'s post, ignoring');
        return;
      }

      console.log('📬 Received re-upload request for your post:', eventId.slice(0, 8));
      console.log('   From:', requesterPubkey.slice(0, 16) + '...');
      console.log('   Hash:', hash?.slice(0, 16) || 'unknown');

      // שמירת הבקשה
      if (!reuploadRequests.has(eventId)) {
        reuploadRequests.set(eventId, {
          eventId,
          hash,
          url: extractUrlFromEvent(eventId),
          requests: [],
        });
      }

      const record = reuploadRequests.get(eventId);
      record.requests.push({
        requesterPubkey,
        timestamp: event.created_at,
        content: event.content,
      });

      // הצגת התראה למשתמש
      showReuploadNotification(eventId, record);

    } catch (err) {
      console.error('Failed to handle reupload request:', err);
    }
  }

  // חלק reupload (media-reupload-handler.js) – חילוץ URL מהאירוע
  function extractUrlFromEvent(eventId) {
    try {
      // חיפוש הפוסט ב-DOM
      const postElement = document.querySelector(`[data-post-id="${eventId}"]`);
      if (!postElement) return null;

      const videoContainer = postElement.querySelector('[data-video-url]');
      if (videoContainer) {
        return videoContainer.dataset.videoUrl;
      }

      return null;
    } catch {
      return null;
    }
  }

  // חלק reupload (media-reupload-handler.js) – הצגת התראה למשתמש
  function showReuploadNotification(eventId, record) {
    try {
      const count = record.requests.length;
      const message = count === 1
        ? '📬 Someone requested you to re-upload media from your post'
        : `📬 ${count} people requested you to re-upload media from your post`;

      console.log(`\n${'='.repeat(60)}`);
      console.log(message);
      console.log(`Post ID: ${eventId.slice(0, 16)}...`);
      console.log(`URL: ${record.url || 'unknown'}`);
      console.log(`Hash: ${record.hash?.slice(0, 16) || 'unknown'}`);
      console.log(`${'='.repeat(60)}\n`);

      // יצירת התראה ויזואלית (אם יש מערכת התראות)
      if (typeof App.showNotification === 'function') {
        App.showNotification({
          type: 'reupload-request',
          title: 'Media Re-upload Request',
          message: message,
          eventId,
          url: record.url,
          hash: record.hash,
          actions: [
            {
              label: 'Re-upload',
              callback: () => openReuploadDialog(eventId, record),
            },
            {
              label: 'Ignore',
              callback: () => dismissReuploadRequest(eventId),
            },
          ],
        });
      }

      // TODO: פתיחת דיאלוג להעלאה מחדש
      // openReuploadDialog(eventId, record);

    } catch (err) {
      console.error('Failed to show reupload notification:', err);
    }
  }

  // חלק reupload (media-reupload-handler.js) – פתיחת דיאלוג להעלאה מחדש
  function openReuploadDialog(eventId, record) {
    console.log('TODO: Open re-upload dialog for event:', eventId);
    console.log('User should select the original file and re-upload it');
    
    // TODO: פתיחת file picker
    // TODO: העלאה ל-Blossom
    // TODO: פרסום event חדש עם ה-URL החדש
  }

  // חלק reupload (media-reupload-handler.js) – התעלמות מבקשת העלאה מחדש
  function dismissReuploadRequest(eventId) {
    reuploadRequests.delete(eventId);
    console.log('Dismissed re-upload request for:', eventId.slice(0, 8));
  }

  // חלק reupload (media-reupload-handler.js) – קבלת כל הבקשות
  function getReuploadRequests() {
    return Array.from(reuploadRequests.values());
  }

  // חשיפה ל-App
  Object.assign(App, {
    listenForReuploadRequests,
    getReuploadRequests,
    dismissReuploadRequest,
    openReuploadDialog,
  });

  // אתחול אוטומטי
  function init() {
    console.log('Media re-upload handler initialized');
    
    // המתנה לאתחול המערכת
    setTimeout(() => {
      if (App.publicKey && App.pool) {
        listenForReuploadRequests();
      }
    }, 2000);
  }

  // אתחול
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
