# תהליך ייצוב ו‑QA (שלבים)

המטרה: להריץ בדיקות **מהקל אל הכבד**, ולעצור כששלב נכשל — בלי “להרוס” את הקוד בבת אחת.

## דרישות

- Node 18+
- `npm install` בשורש הפרויקט
- `npx playwright install chromium` (לשלב הדפדפן)
- שרת סטטי על הקבצים (מומלץ **לא** `serve -s` עם SPA fallback ל‑QA):

```powershell
cd /path/to/SOS-main
python -m http.server 3012
```

## שלב 0 — סריקת אבטחה סטטית (מהיר, ללא דפדפן)

```bash
npm run qa:phase:security
```

יוצא קוד 0. הפלט הוא JSON עם דגלים וטיפים — לא “ציון”, אלא רשימת נושאים.

## שלב 1 — QA דו‑משתמש מקומי (מומלץ לפני כל שינוי ב‑P2P)

שני דפדפנים, אותו `localhost`, שני מפתחות hex (למשל מ‑`nostr-tools`).

מפתחות ב‑environment (מומלץ, לא לשמור בקוד):

```powershell
$env:QA_KEY_A="....64hex...."
$env:QA_KEY_B="....64hex...."
npm run qa:phase:p2p-local
```

או ידנית:

```bash
node qa/dual-user-qa.mjs --keyA=... --keyB=... --skipRemote=true --localUrl=http://127.0.0.1:3012/videos.html --largeMb=1 --headless=true
```

## שלב 2 — כל השלבים ברצף

מריץ שלב 0, ואז שלב 1 **רק אם** מוגדרים `QA_KEY_A` ו‑`QA_KEY_B`:

```powershell
npm run qa:phases
```

## שלב 3 — מול פרודקשן / GitHub Pages (אופציונלי)

אחרי שהמקומי ירוק:

```bash
node qa/dual-user-qa.mjs --keyA=... --keyB=... --localUrl=http://127.0.0.1:3012/videos.html --remoteUrl=https://your-domain/videos.html
```

## מה נחשב “ירוק” בשלב 1

- טקסט דו‑כיווני + מצורף קטן
- העדפת `p2p: true` כש‑DC מחובר
- קבצים גדולים — תלוי רשת; אם נכשל — לבדוק לוג `[CHAT/P2P]` לפני שמשנים לוגיקה רחבה

## הערות פיתוח

- שינויים ב‑`chat-p2p-file.js` / `p2p-video-sharing.js`: הריצו תמיד שלב 0 + שלב 1.
- אחרי שינוי אבטחה (`key-storage.js`, HTML meta): הריצו `npm run qa:phase:security`.
