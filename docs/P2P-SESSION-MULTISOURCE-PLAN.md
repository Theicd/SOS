# תוכנית עבודה: איחוד P2P + Multi-Source + זמינות פיד

**סטטוס:** שלבים A (קוד) + B (קוד) בוצעו ב־2026-08-19 — בדיקות ידניות B5/B6 ו־A4 עדיין פתוחות.  
**תאריך:** 2026-08-19  
**רקע מוכח מלוגים:** צ׳אט-DC עובד; פיד-P2P נכשל כשאין answer (במיוחד מובייל/רקע); כשיש answer מ־peer חי — `מ-P2P` מצליח; הורדה היום = peer אחד ברצף, לא swarm.
**גרסת לקוח אחרי A+B:** `pwa235` / cache `v556` / `?v=20260819feed1`

---

## 0. מטרות

1. **סדר:** מפה אחת של חיבורים (צ׳אט / פיד / טורנט / מעטפת) בלי כפילויות מבלבלות.  
2. **Session אחד לכל peer:** נורת הצ׳אט = בסיס גם למדיה פיד.  
3. **זמינות:** מענה להורדות גם כשהכרטיסייה חיה ברקע (ואחר כך מדיניות לכרטיסייה סגורה).  
4. **Multi-Source:** הורדה מ־2–3 מקורות במקביל (chunks), לא failover בלבד.  
5. **סקייל 10k+:** פחות ריליי לכל לייק/קובץ; יותר peers קרובים; heartbeat דק.  
6. **חבילת פוסט:** מדיה + לייקים/תגובות ב־P2P כדי לחסוך ריענון שרת.

**לא במטרת השלבים הראשונים:** BitTorrent מלא לכל הפיד; Native WebRTC כשכרטיסייה סגורה לגמרי (רק אחרי Session יציב ב־WebView).

---

## 1. מצב נוכחי (מה יש בקוד)

| שכבה | קבצים עיקריים | התנהגות |
|------|----------------|----------|
| צ׳אט DC | `chat-p2p-datachannel.js`, `chat-service.js`, `chat-p2p-file.js` | WebRTC `sos-chat`; קבצי צ׳אט על אותו DC; סיגנל ~25055 |
| פיד מדיה P2P | `p2p-video-sharing.js` | heartbeat + `p2p-file` + `file-request` (30078); Persistent נפרד; הורדה מ־peer אחד |
| מטא-דאטה | `p2p-metadata-transfer.js`, `p2p-event-sync.js` | התחלה של likes/inventory ב־P2P |
| טורנט | `webtorrent-transfer.js`, `chat-audio-player.js` | magnet / קבצים גדולים; הרבה timeout→URL |
| סטטיסטיקה | `videos.js` (`SOS רשת` = `fromP2P`) | לא סופר טורנט; `fromMultiSource` בדיבאג בלבד ולא ממומש |
| מעטפת | `SosP2pStandby.kt`, `SosRelayWatcher.kt`, FGS | כרטיסייה סגורה = התראות בלבד, בלי Native P2P לפיד |

---

## 2. עקרונות סקייל (חוקים לכל שלב)

- [ ] Heartbeat = נוכחות בלבד (לא רשימת hashes מלאה בריליי).  
- [ ] גילוי קובץ: שאילתה לפי `#x` / PeerExchange / peers עם Session פתוח — לא broadcast לכל הרשת.  
- [ ] Multi-Source: מקסימום **K=2–3** peers לקובץ; עדיפות ל־DC פתוח / RTT נמוך.  
- [ ] אחרי הורדה: המכשיר הופך למקור (כבר קיים — לשמר ולחזק).  
- [ ] ריליי = סיגנל קטן + delta חי; מדיה ו־engagement כבדים ב־P2P/קאש.  
- [ ] כל שינוי נמדד: `% מ-P2P`, זמן ל־first paint, כשלי answer, עומס kind 30078/likes.

---

## 3. שלבי ביצוע + צ׳ק־ליסט

### שלב A — מיפוי וסדר מושגים (תיעוד + טלמטריה קלה)

**מטרה:** צוות וממשק מדברים באותה שפה; לוגים ברורים.

**קבצים:** `docs/P2P-SESSION-MULTISOURCE-PLAN.md` (זה), אופציונלי הערות ב־`videos.js` / לוגים ב־`p2p-video-sharing.js`.

- [x] A1. טבלת שמות קבועה ב־UI/לוגים: `chat-dc` / `feed-session` / `torrent` / `blossom` / `cache`.  
  - בוצע: `FEED_PATH` + תגי `[feed-session]` ב־`p2p-video-sharing.js`; רמז בסטטיסטיקות ב־`videos.js`.  
- [x] A2. בסטטיסטיקות: להבהיר ש־`SOS (רשת)` = WebRTC פיד (לא WebTorrent).  
  - בוצע: תווית `SOS (WebRTC)` + שורת הסבר.  
- [x] A3. לוג אחיד כש־`file-request` נכנס/נענה/נדחה (כולל סיבת רקע).  
  - בוצע: `file-request IN/ACCEPT/REJECT` + `serve START/DONE/FAIL` עם `hidden`.  
- [ ] A4. מדד בסיס מ־3 מכשירים: אחוז `מ-P2P` vs Blossom עם כרטיסייה בחזית.  
  - **ידני** — להריץ אחרי deploy של `pwa235` ולרשום תוצאות כאן.

**קריטריון יציאה:** אפשר להסביר במשפט אחד מה כל מונה עושה; לוג מקור/מקבל מתואם בזמן.

---

### שלב B — Session אחד: מדיה פיד על chat DC כשיש חיבור

**מטרה:** אם נורת הצ׳אט דולקת — הורדת hash לא דורשת PC חדש + answer נפרד.

**קבצים עיקריים:**
- `chat-p2p-datachannel.js` — גשר הודעות מדיה על `sos-chat`
- `p2p-video-sharing.js` — `downloadFromPeer` / Persistent: העדפת `getChatDC`
- `chat-p2p-file.js` — לא לשבור העברת קבצי צ׳אט (כבר על chat DC)

**צ׳ק־ליסט:**
- [x] B1. פרוטוקול מינימלי על DC: reuse של Persistent (`request` / `metadata` / binary / `complete`) על `sos-chat`.  
- [x] B2. ב־`downloadFromPeer`: אם `App.dataChannel.getChatDC(peer)` פתוח → להשתמש בו לפני יצירת PC חדש.  
- [x] B3. בצד המגיש: מאזין על chat DC לבקשות hash מ־`availableFiles` / קאש.  
- [x] B4. שמירה על fallback: אין DC → Persistent → 30078 file-request.  
- [ ] B5. בדיקה: 2 דפדפנים — נורת צ׳אט דולקת → הורדת פוסט = `מ-P2P` בלי `לא התקבל answer`.  
- [ ] B6. בדיקה: צ׳אט טקסט + קובץ צ׳אט לא נשברים בזמן הורדת פיד.  
- [x] B7. Bump `app-version.json` + `CACHE_NAME` + `?v=` ב־`videos.html` אחרי מיזוג. (`pwa235` / `v556` / `feed1`)

**קריטריון יציאה:** עם DC פתוח, לפחות 70% מהורדות הפיד בין 2 peers בחזית הן `מ-P2P` (בלי Blossom כששניהם עם הקובץ).

**סיכון:** עומס על אותו SCTP — להגביל concurrency (כבר יש `MAX_CONCURRENT_P2P_TRANSFERS`).

---

### שלב C — זמינות ברקע (כרטיסייה חיה)

**מטרה:** מובייל עם Activity חיה ברקע עדיין עונה ל־media-get / file-request.

**קבצים עיקריים:**
- `chat-p2p-datachannel.js` — keepalive כבר חלקי ב־native shell
- `p2p-video-sharing.js` — visibility / SW heartbeat
- `android-shell/.../SosP2pStandby.kt`, `MainActivity.kt`, FGS — pump WebView
- `service-worker.js` — תיאום heartbeat

**צ׳ק־ליסט:**
- [ ] C1. כש־`document.hidden` אבל Native Shell / Activity חיה: **לא** להפסיק מאזיני 30078 / media-get.  
- [ ] C2. לוג מפורש: `serving while hidden` / `skip serve reason=...`.  
- [ ] C3. מעטפת: `pumpWebViewKeepAlive` בזמן warm ל־peer (כבר קיים חלקית — לוודא שמכסה בקשות מדיה).  
- [ ] C4. בדיקה: מקור במובייל ברקע (לא כבוי לגמרי) + מקבל מוריד → `מ-P2P` או לפחות answer בזמן.  
- [ ] C5. בדיקה: מסך כבוי (best-effort) — לתעד איזה מכשירים עובדים; לא לחסום את שלב D אם חלק נכשלים.

**קריטריון יציאה:** תרחיש “מקור ברקע, מקבל בחזית” מצליח ב־≥1 משני מכשירי אנדרואיד עיקריים.

**מחוץ לסקופ C:** כרטיסייה סגורה לגמרי = עדיין alerts-only עד שלב F.

---

### שלב D — Multi-Source (K≤3)

**מטרה:** כשיש 2+ מקורות — הורדה מקבילה של chunks, לא ניסיון סדרתי בלבד.

**קבצים עיקריים:**
- `p2p-video-sharing.js` — ליבת ההורדה והסטטיסטיקה
- אופציונלי מודול חדש: `p2p-multisource.js`
- `videos.js` — מונה `fromMultiSource` / UI
- `p2p-debug.js` — כבר מציג fromMultiSource (לחבר לאמת)

**צ׳ק־ליסט:**
- [ ] D1. פיצול blob ל־chunks בגודל קבוע (למשל 256KB–1MB; מובייל קטן יותר).  
- [ ] D2. בחירת עד 3 peers: DC פתוח > Persistent > רשימת `findPeersWithFile`.  
- [ ] D3. בקשות chunk מקבילות + איחוד + בדיקת hash/גודל.  
- [ ] D4. peer איטי/timeout → החלפת מקור לאותו chunk.  
- [ ] D5. `p2pStats.downloads.fromMultiSource++` כשהורדה השתמשה ב־≥2 peers.  
- [ ] D6. UI סטטיסטיקות: להציג Multi-Source (או תת־שורה תחת SOS).  
- [ ] D7. הגבלת סקייל: לא לפתוח יותר מ־K חיבורים חדשים לקובץ; reuse Session.  
- [ ] D8. בדיקה: 1 מקבל + 2 מקורות עם אותו hash → לוג מראה שני peers + `fromMultiSource`.  
- [ ] D9. בדיקה: מקור אחד נופל באמצע → ההורדה מסתיימת מהשני בלי Blossom אם אפשר.

**קריטריון יציאה:** קובץ בינוני (1–10MB) עם 2 מקורות חיים יורד מהר יותר או יציב יותר מ־single-peer; הסטטיסטיקה משקפת.

---

### שלב E — חבילת engagement עם המדיה

**מטרה:** אחרי/בזמן הורדת מדיה — לייקים ותגובות מ־peer, פחות `list` כבד בריליי.

**קבצים עיקריים:**
- `p2p-metadata-transfer.js`
- `p2p-event-sync.js`
- `feed.js` / `videos.js` — מתי מדלגים על ריענון ריליי
- כבר יש העדפות “thin backbone” — להרחיב בעקביות

**צ׳ק־ליסט:**
- [ ] E1. אחרי `מ-P2P` מוצלח: בקשת metadata ל־`eventId` מאותו peer (`EventSync` / metadata API קיים).  
- [ ] E2. מיזוג likes/comments לקאש מקומי (`likesByEventId` וכו׳).  
- [ ] E3. דילוג על ריענון ריליי לפוסט אם יש עותק P2P טרי (TTL ברור, למשל 15–30 דק׳).  
- [ ] E4. ריליי נשאר ל־delta חי (אירוע חדש בזמן אמת).  
- [ ] E5. בדיקה: ניתוק זמני מריליי likes — הפיד עדיין מציג engagement שהגיע ב־P2P.  
- [ ] E6. מדידת ירידה ב־`feed-like-sub` / שאילתות מיותרות בלוג REQ.

**קריטריון יציאה:** בגלילה עם peers חיים — פחות תעבורת likes מריליי לעומת baseline, בלי UI ריק של לייקים.

---

### שלב F — מעטפת: מדיניות כרטיסייה סגורה / מסך כבוי

**מטרה:** הגדרה מפורשת מה חי ומה לא; בלי להרוג התראות.

**קבצים:** `SosP2pStandby.kt`, `SosNativeP2pEngine.kt`, `SosRelayWatcher.kt`, גשר JS

**צ׳ק־ליסט:**
- [ ] F1. מסמך מדיניות קצר בקוד/בתוכנית:  
  - כרטיסייה חיה ברקע → Session + serve מדיה  
  - כרטיסייה סגורה → Push + warm ממוקד ל־N peers חמים (אופציונלי)  
  - מסך כבוי → best-effort לפי OEM  
- [ ] F2. אם מוסיפים warm ל־file-request כשסגור: לא לשבור FCM/RelayWatcher (עדיפות התראות).  
- [ ] F3. בדיקות על 2–3 יצרני אנדרואיד שונים + תיעוד תוצאות.  
- [ ] F4. APK bump רק אחרי יציבות Web (B–E).

**קריטריון יציאה:** התנהגות מתועדת; אין רגרסיה בהתראות צ׳אט.

---

### שלב G — טורנט (רק אחרי B–D)

**מטרה:** WebTorrent נשאר ל־edge cases (קובץ ענק / אודיו), לא ליבת הפיד.

**צ׳ק־ליסט:**
- [ ] G1. לא לחבר טורנט כנתיב ראשי לפיד לפני ש־Session+Multi-Source יציבים.  
- [ ] G2. אודיו: timeout קצר יותר + פחות ניסיונות מקבילים (תיקון `MaxListeners` אם עדיין רלוונטי).  
- [ ] G3. אם רוצים swarm אמיתי לקבצים ענקיים — מודול נפרד עם מגבלת peers, לא על כל וידאו פיד.

---

## 4. סדר עדיפויות מומלץ

| סדר | שלב | למה |
|-----|------|-----|
| 1 | A | סדר + מדידה |
| 2 | B | הכי משפיע על הזמינות שראינו בלוגים |
| 3 | C | מובייל ברקע |
| 4 | D | Multi-Source |
| 5 | E | חיסכון ריליי + חוויית פיד |
| 6 | F | מעטפת / כרטיסייה סגורה |
| 7 | G | טורנט כ־fallback מלוטש |

**כל שלב = PR נפרד** (או שני commits קטנים) + bump גרסת PWA + בדיקת 2–3 מכשירים.

---

## 5. תבנית בדיקה לכל PR

- [ ] 2 peers בחזית, אותו פוסט — מצפים ל־`מ-P2P` (או Multi-Source אחרי D).  
- [ ] נורת צ׳אט דולקת — הודעה + קובץ צ׳אט תקינים.  
- [ ] מקור ברקע (אחרי C) — מקבל עדיין מצליח או נופל ל־Blossom אחרי timeout מוגדר (לא תקיעה).  
- [ ] So-Call / שיחה קולית לא נשברים תוך כדי הורדת פיד.  
- [ ] אין עלייה חדה באירועי ריליי (לעומת baseline).  
- [ ] לוג מקבל + לוג מקור מאותו חלון זמן נשמרים לדיבאג.

---

## 6. הגדרת הצלחה כוללת (אחרי B–E)

| מדד | יעד כיווני |
|-----|------------|
| `% מ-P2P` ברשת עם ≥2 peers חיים בחזית | עלייה משמעותית מול “הכל Blossom” |
| `לא התקבל answer` כשיש DC פתוח | נדיר / אפס |
| Multi-Source | נספר בסטטיסטיקה כשיש ≥2 מקורות |
| בקשות likes מריליי בגלילה | ירידה כשיש metadata מ־P2P |
| יציבות צ׳אט / So-Call | בלי רגרסיה |

---

## 7. צ׳ק־ליסט התחלת עבודה (עכשיו)

- [x] לאשר עם הצוות: מתחילים ב־**שלב A** ואז **B**.  
- [x] ביצוע קוד A1–A3 + B1–B4 + B7 (2026-08-19).  
- [ ] A4 + B5 + B6 — בדיקות ידניות אחרי deploy.  
- [ ] אחרי בדיקות: push ל־GitHub (לפי בקשה מפורשת).  
- [ ] שלב C הבא לפי התוכנית.

---

## 8. הפניות קבצים מהירות

| נושא | קובץ |
|------|------|
| Chat DC | `chat-p2p-datachannel.js` |
| קבצי צ׳אט | `chat-p2p-file.js` |
| פיד P2P | `p2p-video-sharing.js` |
| Metadata | `p2p-metadata-transfer.js`, `p2p-event-sync.js` |
| סטטיסטיקות UI | `videos.js` |
| מעטפת רקע | `android-shell/.../SosP2pStandby.kt` |
| גרסת לקוח | `app-version.json`, `service-worker.js`, `videos.html` |

---

**צעד הבא המומלץ:** לבצע **A3+A4** (לוג serve + מדידת בסיס) ואז להתחיל מימוש **B1–B3** ב־Agent.
