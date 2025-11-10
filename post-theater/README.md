# Post Theater Viewer (Standalone)

מודול עצמאי המציג פוסט בדסקטופ במצב "תיאטרון" בסגנון פייסבוק: פאנל שמאלי לטקסט/פעולות/תגובות ומדיה מימין על גבי שכבת־על כהה.

## קבצים
- index.html – דף הדגמה עצמאי.
- theater-viewer.css – עיצוב.
- theater-viewer.js – לוגיקת פתיחה/סגירה ורינדור.

## שימוש באפליקציה קיימת
1. כלול את שני הקבצים:
```html
<link rel="stylesheet" href="/SOS2/post-theater/theater-viewer.css">
<script src="/SOS2/post-theater/theater-viewer.js"></script>
```
2. בעת לחיצה על פוסט, העבר אובייקט פוסט ופתח:
```js
PostTheaterViewer.open({
  id: '...',
  author: { name: '...', avatarUrl: '...' },
  timestamp: Date.now(),
  text: 'תוכן ארוך...';
  media: [{ type: 'image', src: '...' }], // או {type:'video', src:'...', poster:'...'}
  counts: { likes: 0, comments: 0, shares: 0 },
  comments: [{ id:'c1', authorName:'...', avatarUrl:'...', text:'...', timestamp: Date.now() }]
});
```
3. סגירה: `PostTheaterViewer.close()` או ESC או לחיצה מחוץ לפריסה.

## הערות
- אין שינוי בקוד הקיים. שילוב נעשה בהוספת קבצים בלבד.
- העיצוב כהה ונקי; ניתן להתאים צב-palettes בהמשך.
