# לוג שינויים – עדכון פיד וידאו בזמן אמת

## סיכום קצר
מטרה: להכניס פוסטים חדשים (kind 1) ומחיקות (kind 5) לפיד הווידאו מיד, גם מריליי וגם מ-P2P, בלי רענון ובלי לפגוע בתיקוני iOS/loop≤20.

## פירוט שינויים בקוד

### 1) videos.js – עדכון מנוי חי מה-Relay
- **מה השתנה:** בתוך `setupVideoRealtimeSubscription` נוספה המרה מיידית של אירוע kind 1 ל-`video object` וקריאה ל-`upsertVideoInState`, בתנאי שאין מחיקה/כפילות.
- **למה:** כדי שפוסטים חדשים מהריליי יוצגו מיידית בפיד ללא רענון.
- **שורות:** @videos.js#2928-2993

### 2) p2p-event-sync.js – שידור CustomEvent אחרי קליטת אירוע P2P
- **מה השתנה:** לאחר `putEvent` ב-`ingestEvent`, נוספה שליחת `CustomEvent` בשם `p2p:event-ingested` כשמקור האירוע `p2p:*`.
- **למה:** לאפשר למודולי UI (כמו videos) להגיב מידית לאירועים שנקלטו מ-P2P.
- **שורות:** @p2p-event-sync.js#135-154

### 3) videos-p2p-events.js – מאזין לאירועי P2P ומעדכן UI
- **מה השתנה:** קובץ חדש שמאזין ל-`p2p:event-ingested`, ממיר kind 1 לוידאו ומכניס לפיד (`upsertVideoInState`), מטפל במחיקות kind 5 (`registerDeletion` + הסרת כרטיס), ומעביר kind 7 ל-engagement.
- **למה:** להביא realtime גם מה-P2P, כולל מחיקות, עם סינון רשת/כפילות והשלמת פרופיל מה-cache.
- **שורות:** @videos-p2p-events.js#1-88

### 4) videos.html – טעינת המודול החדש
- **מה השתנה:** הוספת `<script src="./videos-p2p-events.js" defer></script>` מיד אחרי `p2p-event-sync.js`.
- **למה:** להבטיח שהמאזין ל-P2P נטען מוקדם לפני ש-videos.js מתחיל לפעול.
- **שורות:** @videos.html#1208-1216

## משימה/מטרה לכל שינוי (רכזת)
1. **Relay realtime insert** – הכנסת פוסטים חדשים מהריליי לפיד מידית (videos.js).
2. **P2P dispatch hook** – שידור אירוע UI אחרי קליטת אירוע ב-P2P (p2p-event-sync.js).
3. **P2P UI listener** – קליטה והמרה של אירועי P2P לפיד + מחיקות + אנגייג׳מנט (videos-p2p-events.js).
4. **Load order** – טעינת מאזין ה-P2P בזמן הנכון (videos.html).

## קבצים שנוספו/עודכנו
- עודכן: `videos.js` – realtime kind 1 + טיפול מחיקות.
- עודכן: `p2p-event-sync.js` – dispatch `p2p:event-ingested`.
- חדש: `videos-p2p-events.js` – מאזין P2P → UI.
- עודכן: `videos.html` – טעינת `videos-p2p-events.js`.

## קטעי קוד שנוספו/שונו

### videos.js – הזרקת kind 1 בזמן אמת מהריליי
```js
  videoRealtimeSub = app.pool.subscribeMany(app.relayUrls, filters, {
    onevent: (event) => {
      if (!event || !event.kind) return;
      if (event.kind === 1) {
        registerVideoSourceEvent(event);
        registerVideoEngagementEvent(event);

	    if (!app?.deletedEventIds?.has?.(event.id) && !state.videos.some((v) => v.id === event.id)) {
	      const convert = app.convertVideoEventToVideoObject;
	      const video = typeof convert === 'function' ? convert(event) : null;
	      if (video) {
	        const profileData = app?.profileCache?.get(video.pubkey) || {};
	        video.authorName = profileData.name || `משתמש ${String(video.pubkey || '').slice(0, 8)}`;
	        video.authorPicture = profileData.picture || '';
	        video.authorInitials = profileData.initials || 'AN';
	        upsertVideoInState(video);
	      }
	    }
      } else if (event.kind === 5) {
        // טיפול במחיקות בזמן אמת
        console.log('%c[DELETE_DEBUG] videos realtime deletion received', 'color: #FF5722; font-weight: bold', {
          id: event.id,
          pubkey: event.pubkey,
          tags: event.tags
        });
        if (typeof app.registerDeletion === 'function') {
          app.registerDeletion(event);
        }
        // הסרת הפוסט מהפיד המקומי
        if (Array.isArray(event.tags)) {
          event.tags.forEach(tag => {
            if (Array.isArray(tag) && tag[0] === 'e' && tag[1]) {
              const deletedId = tag[1];
              removeVideoFromState(deletedId);
              removeVideoCard(deletedId);
              console.log('%c[DELETE_DEBUG] videos removed card', 'color: #FF5722; font-weight: bold', { deletedId });
            }
          });
        }
```

### p2p-event-sync.js – שידור CustomEvent אחרי קליטת P2P
```js
    const source = meta.source || 'unknown';
    const stored = await putEvent(event, source);
    if (typeof source === 'string' && source.startsWith('p2p:')) {
      try {
        window.dispatchEvent(new CustomEvent('p2p:event-ingested', { detail: { event, source } }));
      } catch (_) {}
    }
    return stored;
```

### videos-p2p-events.js – מאזין לאירועי P2P → UI
```js
(function initVideosP2PEvents(window) {
  const queue = [];

  function canProcess() {
    return (
      typeof registerVideoSourceEvent === 'function' &&
      typeof registerVideoEngagementEvent === 'function' &&
      typeof upsertVideoInState === 'function' &&
      typeof removeVideoFromState === 'function' &&
      typeof removeVideoCard === 'function'
    );
  }
...
  window.addEventListener('p2p:event-ingested', (evt) => {
    const event = evt?.detail?.event;
    if (!event) return;
    queue.push(event);
    flush();
  });

  window.addEventListener('DOMContentLoaded', flush);
})(window);
```

### videos.html – טעינת המאזין החדש
```html
    <script src="./p2p-event-sync.js" defer></script>
    <script src="./videos-p2p-events.js" defer></script>
    <script src="./p2p-video-sharing.js" defer></script>
```

## גלילה / Infinite Loop / טעינה מקדימה

### מניעת קפיצות וגלילה בלולאה (iOS)
- `removeVideoCard` ב-iOS מתקן `scrollTop` כשהכרטיס שנמחק היה מעל ה-viewport כדי למנוע קפיצה (@videos-ios-patch.js#6-35).
- `setupInfiniteLoop` ב-iOS:
  - מופעל רק אם מספר הכרטיסים 1–20 (`canLoop`) כדי לא להכביד על פיד ארוך (@videos-ios-patch.js#47-52).
  - קופץ להתחלה/סוף רק כשמנסים לגלול מעבר לגבולות (wheel/touch) (@videos-ios-patch.js#82-116).
  - משתמש ב־`scrollBehavior='auto'` לזמן קצר כדי למנוע “אנימציית קפיצה” (@videos-ios-patch.js#63-78).

### טעינה מקדימה ומניעת הבזקי פריסה
- `hydrateFeedFromCache` מרנדר מטמון קודם כדי לצמצם השהיה/קפיצות לפני רשת.
- `state.firstCardRendered` + `hideLoadingAnimation`/`autoPlayFirstVideo` מופעלים רק פעם אחת כדי לא לגעת בגלילה הקיימת בעת prepend.
- `truncateFeedLength` שומר על מגבלת `FEED_CACHE_LIMIT` ומסיר עודפים למטה, כך שהמסך לא “קופץ” עקב פיד ארוך מדי.
- `hideCardUntilMediaReady`/`markCardMediaReady` מסתירים כרטיס עד שהמדיה מוכנה כדי למנוע הבזקי גובה שמשנים את הגלילה.

### מחיקות בזמן אמת ללא קפיצה
- מחיקה חיה (`kind 5` Relay/P2P) מסירה גם state וגם DOM נקודתית; ב-iOS הפונקציה הפאטצ׳ד מתקנת `scrollTop` אם צריך.

## הערות תפעול
- iOS patch ו-loop≤20 לא שונו.
- מניעת כפילות: בודקים `state.videos`/`deletedEventIds` לפני הכנסת פוסט חדש.
- פרופילי מחברים: ממולא מה-`profileCache` כדי להציג שם/תמונה מיד.
