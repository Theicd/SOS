# סדרת בדיקות בקרה - ביצועים וחווית משתמש
## Performance & UX Test Suite - SOS

**תאריך:** 05/01/2026  
**גרסה:** 2.4.0  

---

## 1. בדיקות טעינה ראשונית

### 1.1 זמני טעינה

| מזהה | בדיקה | יעד | כיצד לבדוק | סטטוס |
|------|-------|-----|------------|-------|
| LOAD-001 | טעינת הפיד מקאש | < 1 שנייה | פתח videos.html, מדוד זמן עד הצגת פוסט ראשון | ⏳ |
| LOAD-002 | טעינת מחיקות מקאש | < 100ms | בדוק בקונסול "[videos] deletions loaded from cache" | ⏳ |
| LOAD-003 | טעינה חוזרת (refresh) | ללא בקשות מחיקות כפולות | בדוק בקונסול שאין בקשות מחיקות חוזרות | ⏳ |
| LOAD-004 | רענון אוטומטי בחזרה לדף | < 2 שניות | עבור לטאב אחר, חזור אחרי דקה | ⏳ |

### 1.2 בדיקות קאש

```javascript
// הרץ בקונסול לבדיקת קאש מחיקות
console.log('Deletions cache:', localStorage.getItem('videos_deletions_cache_v1'));

// בדוק כמה מחיקות נטענו
console.log('Deleted IDs:', window.NostrApp?.deletedEventIds?.size || 0);
```

---

## 2. בדיקות ביצועי צ'אט

### 2.1 זמני תגובה לכפתורים

| מזהה | בדיקה | יעד | כיצד לבדוק | סטטוס |
|------|-------|-----|------------|-------|
| CHAT-001 | לחיצה על כפתור הודעות | < 100ms | מדוד זמן מלחיצה ועד פתיחת פאנל | ⏳ |
| CHAT-002 | לחיצה על איש קשר | < 150ms | מדוד זמן מלחיצה ועד הצגת שיחה | ⏳ |
| CHAT-003 | גלילה ברשימת אנשי קשר | 60fps | בדוק עם DevTools Performance | ⏳ |
| CHAT-004 | חיפוש אנשי קשר (debounce) | < 200ms | הקלד מהר, ודא שאין קפיצות | ⏳ |
| CHAT-005 | שליחת הודעה | < 500ms | מדוד זמן מלחיצה ועד הופעת ההודעה | ⏳ |

### 2.2 בדיקת touch-action

```javascript
// בדוק שכפתורים מוגדרים נכון
const buttons = document.querySelectorAll('button, .chat-contact, .nav-item');
buttons.forEach(btn => {
  const style = getComputedStyle(btn);
  if (style.touchAction !== 'manipulation') {
    console.warn('Missing touch-action:', btn);
  }
});
```

---

## 3. בדיקות שיחות קול/וידאו

### 3.1 זמני תגובה

| מזהה | בדיקה | יעד | כיצד לבדוק | סטטוס |
|------|-------|-----|------------|-------|
| CALL-001 | לחיצה על כפתור שיחה | < 100ms | מדוד זמן מלחיצה ועד פתיחת דיאלוג | ⏳ |
| CALL-002 | קבלת שיחה נכנסת | < 200ms | בדוק תגובת UI בשיחה נכנסת | ⏳ |
| CALL-003 | כפתור השתקה (mute) | מיידי | לחץ על mute, ודא תגובה מיידית | ⏳ |
| CALL-004 | כפתור סיום שיחה | < 100ms | מדוד זמן מלחיצה ועד סגירת דיאלוג | ⏳ |

---

## 4. בדיקות Push Notifications

### 4.1 צמצום בקשות

| מזהה | בדיקה | יעד | כיצד לבדוק | סטטוס |
|------|-------|-----|------------|-------|
| PUSH-001 | rate limiting פועל | בקשה אחת לדקה מקסימום | בדוק Network tab | ⏳ |
| PUSH-002 | deduplication פועל | אין בקשות כפולות ב-5 שניות | בדוק Network tab | ⏳ |
| PUSH-003 | שרת לא זמין - הפסקת ניסיונות | אין בקשות למשך דקה | כבה שרת, בדוק Network | ⏳ |

### 4.2 בדיקת קונסול

```javascript
// בדוק סטטוס Push
console.log('Push server available check - should see no 404 spam');
// אם רואים הרבה 404 - יש בעיה ב-rate limiting
```

---

## 5. בדיקות פיד וידאו

### 5.1 מרכוז ו-snap

| מזהה | בדיקה | יעד | כיצד לבדוק | סטטוס |
|------|-------|-----|------------|-------|
| VID-001 | מרכוז כרטיסיות | לא רואים פוסט הבא | גלול בפיד, ודא שכל פוסט ממלא מסך | ⏳ |
| VID-002 | snap בגלילה | כרטיסייה נעצרת במרכז | גלול במהירות, ודא snap | ⏳ |
| VID-003 | PWA standalone mode | גובה נכון | התקן כ-PWA, בדוק מרכוז | ⏳ |
| VID-004 | safe-area-inset | אין חפיפה עם notch | בדוק באייפון עם notch | ⏳ |

### 5.2 בדיקת CSS

```javascript
// בדוק שמשתמשים ב-dvh
const card = document.querySelector('.videos-feed__card');
const style = getComputedStyle(card);
console.log('Card height:', style.height);
// צריך להיות calc(100dvh - ...) או fallback
```

---

## 6. בדיקות במכשירים

### 6.1 רשימת מכשירים לבדיקה

| מכשיר | מערכת | בדיקה עיקרית | סטטוס |
|-------|-------|--------------|-------|
| iPhone 15 | iOS 17 | מרכוז פיד, שיחות | ⏳ |
| iPhone 12 | iOS 16 | ביצועי צ'אט | ⏳ |
| Samsung S24 | Android 14 | מרכוז PWA | ⏳ |
| Pixel 7 | Android 13 | התרעות | ⏳ |
| מכשיר ישן (4GB RAM) | Android 10 | ביצועים כלליים | ⏳ |

### 6.2 בדיקות ספציפיות למובייל

| מזהה | בדיקה | כיצד לבדוק |
|------|-------|------------|
| MOB-001 | 300ms tap delay מבוטל | לחץ על כפתור, ודא תגובה מיידית |
| MOB-002 | אין highlight כחול בלחיצה | לחץ על כפתור, ודא שאין צבע מודגש |
| MOB-003 | גלילה חלקה | גלול במהירות, ודא 60fps |
| MOB-004 | זיכרון סביר | בדוק עם DevTools Memory |

---

## 7. כלי בדיקה

### 7.1 DevTools Performance

```javascript
// רשום ביצועים למשך 5 שניות
// 1. פתח DevTools > Performance
// 2. לחץ Record
// 3. בצע פעולות (גלילה, לחיצות)
// 4. עצור והנתח

// יעדים:
// - Frame rate: 60fps
// - Main thread: < 50ms per task
// - Layout shifts: < 0.1 CLS
```

### 7.2 Network Throttling

```
// בדיקת טעינה ברשת איטית
// DevTools > Network > Throttling > Slow 3G
// בדוק שהפיד נטען מהמטמון
```

### 7.3 Memory Profiling

```javascript
// בדוק דליפות זיכרון
// DevTools > Memory > Take heap snapshot
// בצע פעולות חוזרות (פתח/סגור צ'אט 10 פעמים)
// Take another snapshot
// השווה - לא אמור להיות גידול משמעותי
```

---

## 8. סקריפטים אוטומטיים

### 8.1 בדיקת טעינה

```javascript
// הדבק בקונסול למדידת זמני טעינה
(function measureLoad() {
  const start = performance.now();
  const observer = new MutationObserver((mutations, obs) => {
    const card = document.querySelector('.videos-feed__card video');
    if (card) {
      const end = performance.now();
      console.log(`✅ First video card loaded in ${(end - start).toFixed(0)}ms`);
      obs.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
```

### 8.2 בדיקת כפתורים

```javascript
// בדיקת תגובתיות כפתורים
(function testButtons() {
  document.addEventListener('click', (e) => {
    const start = performance.now();
    requestAnimationFrame(() => {
      const end = performance.now();
      console.log(`Click response: ${(end - start).toFixed(1)}ms`);
    });
  }, { capture: true });
  console.log('Button response test active - click buttons to measure');
})();
```

### 8.3 בדיקת Network requests

```javascript
// ספירת בקשות Push
(function countPushRequests() {
  let count = 0;
  const original = window.fetch;
  window.fetch = function(...args) {
    if (args[0]?.includes?.('push')) {
      count++;
      console.log(`Push request #${count}`);
    }
    return original.apply(this, args);
  };
  console.log('Push request counter active');
})();
```

---

## 9. קריטריונים לאישור

### 9.1 חובה (Blocking)

- [ ] טעינת פיד מקאש < 1 שנייה
- [ ] אין בקשות מחיקות כפולות
- [ ] תגובת כפתורים < 100ms
- [ ] אין 404 spam מ-Push server
- [ ] מרכוז פיד נכון בכל המכשירים

### 9.2 רצוי (Non-blocking)

- [ ] Frame rate 60fps בגלילה
- [ ] זיכרון < 200MB
- [ ] LCP < 2.5s
- [ ] CLS < 0.1

---

## 10. דוח סיכום

| קטגוריה | בדיקות | עובר | נכשל |
|---------|--------|------|------|
| טעינה | 4 | ⏳ | ⏳ |
| צ'אט | 5 | ⏳ | ⏳ |
| שיחות | 4 | ⏳ | ⏳ |
| Push | 3 | ⏳ | ⏳ |
| וידאו | 4 | ⏳ | ⏳ |
| מובייל | 4 | ⏳ | ⏳ |
| **סה"כ** | **24** | **⏳** | **⏳** |

---

**הערות:**
- ⏳ = ממתין
- ✅ = עובר  
- ❌ = נכשל

**אחראי QA:** _____________________  
**תאריך:** _____________________
