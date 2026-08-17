# תוכנית העברת מנגנון חירום SOS → מעטפת חדשה

**סטטוס:** תשתית תכנון בלבד — אין שינוי קוד אפליקציה בשלב זה.  
**תאריך מיפוי:** 2026-08-17  
**מקור מוכח:** `c:\Users\Avatar001\CascadeProjects\SOS-Relay-Android` + APK `app-debug (46).apk`  
**יעד:** `c:\BRAIN\SOS-main\android-shell` + ממשק Web של SOS-main  

---

## 0. מטרת ה־MVP

1. מסך חירום + הפעלת ממסר במעטפת החדשה.  
2. עץ אב/ילדים/אחים (max 5) עם מניעת הצפות.  
3. בדיקות `test-runner` בין 2–3 מכשירים.  
4. גשר `AndroidBridge` פעיל ליד `SosNativeShell`.  
5. רק אחר כך: הודעות/קבצים קטנים של SOS דרך הרשת המקומית.

---

## 1. מיפוי מקור → יעד

### 1.1 Native (Kotlin / XML)

| # | מקור (Relay) | יעד מוצע (android-shell) | הערות |
|---|--------------|---------------------------|--------|
| N1 | `.../com/sos/relay/SOSBackgroundService.kt` | `com/sos010/app/SosEmergencyRelayService.kt` | **מנוע ממסר פעיל** — UDP 9001, TCP 9000, JOIN/REDIRECT |
| N2 | `.../MainActivity.kt` (לוגיקת עץ+MSG) | למזג לתוך `SosEmergencyRelayService.kt` | ריליי `MSG` להורה/ילדים/אחים חובה מהמסך הישן |
| N3 | `.../MainActivity.kt` (UI בלבד) | `SosEmergencyActivity.kt` | מסך ניסוי/הפעלה בלבד |
| N4 | `res/layout/activity_main.xml` | `res/layout/activity_sos_emergency.xml` | עיצוב מסך חירום |
| N5 | `.../WebAppInterface.kt` | `SosEmergencyBridge.kt` | חשיפה כ־`AndroidBridge` |
| N6 | `res/layout/activity_webapp.xml` (emergencyBar) | תוספת ל־`activity_main.xml` של המעטפת **או** overlay | פס תחתון «מצב חירום» |
| N7 | `WebAppActivity.setupEmergencyButton()` | `MainActivity` / layout listener | פתיחת `SosEmergencyActivity` |
| N8 | `TestRunnerActivity.kt` | `SosEmergencyTestActivity.kt` | בדיקות |
| N9 | `assets/test-runner.html` | `assets/emergency/test-runner.html` **או** URL מקומי מ־assets | לשמר סויטה |
| N10 | `ServiceLogActivity.kt` + layout | `SosEmergencyLogActivity.kt` + layout | לוג ממסר |
| N11 | `SOSApplication.startBackgroundServiceNow()` | קריאה מ־`SosApp` / Activity | הפעלת FGS |
| N12 | `BootReceiver.kt` | הרחבת `BootCompletedReceiver.kt` **או** receiver נפרד | אופציונלי ל־MVP |
| N13 | `AndroidManifest.xml` (הרשאות+activities+service) | `android-shell/.../AndroidManifest.xml` | ראה סעיף 3 |
| N14 | `wifi-direct-service.js` | — | **לא להעביר** (הדמיה) |

### 1.2 JavaScript (ממשק SOS)

| # | מקור | יעד | הערות |
|---|------|-----|--------|
| J1 | Relay `assets/emergency-bridge.js` | `SOS-main/emergency-bridge.js` (חסר היום) | `SOSEmergency` + `SOSBridge` |
| J2 | `SOS-main/android-bridge.js` (קיים) | להישאר + **לחבר** ל־`videos.html` | כבר קיים בריפו |
| J3 | `SOS-main/emergency-wrapper.js` (קיים) | להישאר + **לחבר** ל־`videos.html` | mirror ל־`pool.publish` |
| J4 | טעינת סקריפטים ב־`videos.html` | סדר טעינה אחרי ליבת הצ׳אט | שלב מאוחר יותר — רק תיעוד עכשיו |

### 1.3 מה כבר קיים ביעד (לא לדרוס)

| קיים | יחס לחירום |
|------|------------|
| `SosJsBridge` / `SosNativeShell` | נשאר; לא מחליף `AndroidBridge` |
| `SosNativeP2pEngine` | מסלול P2P אחר (אינטרנט/Nostr) — מקביל, לא תחליף |
| `SosForegroundService` | שירות אחר; ממסר החירום = service נפרד |
| `BootCompletedReceiver` | אפשר להרחיב בהמשך |

---

## 2. לוגיקה חובה לשימור (מפרט פונקציונלי)

### 2.1 קבועים
- `SOS_NETWORK_NAME` / `SOS_NETWORK_PASSWORD` = `SOS12345`
- `SERVER_PORT` = 9000
- `DISCOVERY_PORT` = 9001
- `maxChildren` = 5
- subnet check: /24

### 2.2 UDP
- שליחה מחזורית: `SOS_HERE:ip:childCount:maxChildren` (כל ~5 שנ׳)
- קבלה: `SOS_HERE`, `SOS_DISCOVER`
- כללי הצטרפות / מניעת לולאות (ילדים קיימים, הורה קיים, כבר peer, מקום פנוי)

### 2.3 TCP / עץ
- `JOIN` → `ACCEPTED:siblings` | `REDIRECT:child` | `FULL`
- `SIBLING_UPDATE` / `SIBLINGS`
- `PING` / `PONG` + failover לאח
- **ריליי:** `MSG:` → הורה + ילדים + אחים (לא כולל השולח)

### 2.4 מצב משותף ל־JS
- `sharedPeers`, `sharedParentIp`, `isRelayRunning`
- סטטוס: `getEmergencyNetworkStatus`, `getRelayPeers`, `isRelayNetworkActive`

### 2.5 API חובה ב־`AndroidBridge`
ראה טבלה בסעיף 4.

### 2.6 Broadcasts פנימיים
- `com.sos010.app.EMERGENCY_STATUS_UPDATE` (שם חדש מומלץ; או לשמור תאימות זמנית)
- `...EMERGENCY_SERVICE_LOG`
- `...EMERGENCY_WEBVIEW_MESSAGE`

> בהעברה: להחליף package מ־`com.sos.relay` ל־`com.sos010.app` בכל Intent/bridge.

---

## 3. Manifest / הרשאות (רשימת עבודה)

להוסיף ליעד (בשלב מימוש עתידי):

**Permissions**
- ACCESS_WIFI_STATE, CHANGE_WIFI_STATE  
- ACCESS_NETWORK_STATE, CHANGE_NETWORK_STATE  
- ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION  
- (קיימים כבר: INTERNET, FGS, POST_NOTIFICATIONS, WAKE_LOCK, BOOT, CAMERA, RECORD_AUDIO…)

**Components**
- `SosEmergencyActivity` (exported=false)
- `SosEmergencyTestActivity`
- `SosEmergencyLogActivity`
- `SosEmergencyRelayService` (foregroundServiceType=dataSync)
- Boot hook (אופציונלי)

---

## 4. חוזה `AndroidBridge` (רשימת מתודות להעתקה)

| מתודה | חובה ל־MVP |
|--------|------------|
| `isEmergencyMode` | כן |
| `isOfflineMode` | כן |
| `getLocalIpAddress` | כן |
| `getNetworkInfo` | כן |
| `getPeerList` | כן |
| `isRelayNetworkActive` | כן |
| `getEmergencyNetworkStatus` | כן |
| `getRelayPeers` | כן |
| `broadcastMessage` | כן |
| `sendToPeer` | כן |
| `sendP2PMessage` | כן |
| `requestPeerUpdate` | כן |
| `openEmergencySettings` | כן |
| `publishNostrEvent` | שלב 2 |
| `sendWebRTCSignal` | שלב 2 |
| `startLocalRelay` / `stopLocalRelay` | לבדוק כפילות מול Service — לא כפול בלי צורך |
| `registerCallbacks` / `registerPeerUpdateCallback` | כן |
| `showCallNotification` / `showMessageNotification` | שלב 2 |

חשיפה ב־WebView: **`AndroidBridge`** (נפרד מ־`SosNativeShell`).

---

## 5. תוכנית העברה — קובץ אחר קובץ

כל שלב = קובץ/קבוצת קבצים אחת. **לא להתחיל שלב הבא לפני בדיקת השלב הנוכחי.**  
בשלב התשתית הנוכחי: רק המסמך הזה. המימוש יתחיל רק אחרי אישור מפורש.

### שלב A — שלד Native בלי רשת
| סדר | פעולה | קבצים | קריטריון סיום |
|-----|--------|--------|----------------|
| A1 | יצירת Activity ריק + layout ממסך החירום | `SosEmergencyActivity.kt`, `activity_sos_emergency.xml` | נפתח מהמעטפת, נראה UI |
| A2 | פס תחתון / כניסה למסך | layout מעטפת + listener | לחיצה → מסך חירום |
| A3 | כפתורי ניווט פנימיים (חזרה / לוג / בדיקות כ־stubs) | אותו Activity | ניווט בסיסי עובד |

### שלב B — מנוע ממסר (ליבה)
| סדר | פעולה | קבצים | קריטריון סיום |
|-----|--------|--------|----------------|
| B1 | Service + פורטים + FGS notification | `SosEmergencyRelayService.kt` | שירות רץ אחרי «הפעל ממסר» |
| B2 | UDP `SOS_HERE` / גילוי | אותו Service | 2 מכשירים רואים זה את זה בלוג |
| B3 | TCP JOIN/ACCEPTED/REDIRECT/FULL + max 5 | אותו Service | עץ נבנה; מלא → REDIRECT |
| B4 | Siblings + heartbeat + failover | אותו Service | ניתוק הורה → מעבר לאח |
| B5 | ריליי `MSG` (מהעתקת MainActivity) | אותו Service | הודעה עוברת דרך צומת ביניים |
| B6 | מצב משותף (peers/parent/running) | object/`SosEmergencyState` | Bridge יכול לקרוא סטטוס |

### שלב C — גשר JS
| סדר | פעולה | קבצים | קריטריון סיום |
|-----|--------|--------|----------------|
| C1 | `SosEmergencyBridge.kt` + `addJavascriptInterface(..., "AndroidBridge")` | Bridge + MainActivity/WebView | `typeof AndroidBridge !== 'undefined'` |
| C2 | מתודות MVP מהטבלה בסעיף 4 | אותו Bridge | getPeerList / sendToPeer עובדים |
| C3 | העברת `emergency-bridge.js` ל־SOS-main | `emergency-bridge.js` | קובץ קיים בריפו |
| C4 | חיבור טעינה ב־`videos.html` (אחרי אישור) | `videos.html` + cache bust | `SOSEmergency` זמין באפליקציה |

### שלב D — בדיקות (השלב שעבד אצלך)
| סדר | פעולה | קבצים | קריטריון סיום |
|-----|--------|--------|----------------|
| D1 | `SosEmergencyTestActivity` + `test-runner.html` | Activity + asset | נפתח מכפתור «בדיקות» |
| D2 | הרצת סויטה על 2–3 מכשירים באותה רשת | — | network/peers/tcp/message/file_small עוברים |
| D3 | לוג שירות | Log Activity | רואים JOIN/UDP בזמן אמת |

### שלב E — חיבור ל־SOS (רק אחרי D)
| סדר | פעולה | קבצים | קריטריון סיום |
|-----|--------|--------|----------------|
| E1 | חיבור `android-bridge.js` + `emergency-wrapper.js` | `videos.html` | mirror kind 1050 כשממסר פעיל |
| E2 | הודעת צ׳אט אחת דרך חירום | — | נראית במכשיר שני בלי אינטרנט |
| E3 | קובץ קטן (כמו test-runner) דרך חירום | — | עברת בהצלחה |
| E4 | (עתידי) סיגנל WebRTC מקומי / קבצים גדולים | — | מחוץ ל־MVP |

### שלב F — Manifest / הרשאות / versioning
| סדר | פעולה | קבצים |
|-----|--------|--------|
| F1 | הרשאות Wi‑Fi + Location | `AndroidManifest.xml` |
| F2 | רישום Activities + Service | Manifest |
| F3 | Bump גרסת אפליקציה/cache לפי נוהל הפרויקט | `app-version.json` / SW — רק בעת מימוש |

---

## 6. סדר עדיפויות למיזוג קוד (כשמתחילים)

1. **קודם** Service טופולוגיה מ־`SOSBackgroundService`.  
2. **אחר כך** הדבק ריליי `handleMessage` מ־`MainActivity` (שורות הורה/ילדים/אחים).  
3. **אל** תריץ שני מאזינים על פורט 9000 במקביל.  
4. UI Activity = דק; בלי שרת TCP כפול ב־Activity.  
5. `startLocalRelay` ב־Bridge: לא לפתוח ServerSocket שני אם ה־Service כבר מאזין.

---

## 7. רשימת קבצי מקור להעתקה (checklist)

### חובה
- [ ] `SOSBackgroundService.kt`
- [ ] חלקי עץ/MSG מ־`MainActivity.kt`
- [ ] UI מ־`MainActivity.kt` + `activity_main.xml`
- [ ] `WebAppInterface.kt` → Bridge
- [ ] פס חירום מ־`activity_webapp.xml` + `setupEmergencyButton`
- [ ] `TestRunnerActivity.kt` + `test-runner.html`
- [ ] `emergency-bridge.js` (מהמקור; חסר ב־SOS-main)
- [ ] הרשאות/רכיבים ב־Manifest

### מומלץ
- [ ] `ServiceLogActivity.kt` + layout
- [ ] חיבור `android-bridge.js` / `emergency-wrapper.js` (כבר ב־SOS-main)

### לא להעביר
- [ ] `wifi-direct-service.js` (stub)
- [ ] עותק כפול של שרת TCP מ־Activity אחרי המיזוג
- [ ] assets כבדים לא רלוונטיים לחירום מתוך Relay (כל אתר SOS המלא כבר ב־SOS-main)

---

## 8. סיכוני תשתית (לדעת מראש)

| סיכון | מיתון |
|--------|--------|
| כפילות MainActivity vs Service | מנוע אחד בלבד (סעיף 6) |
| Android 10+ חיבור ל־SSID | UI מנחה Hotspot ידני + Suggestion API כמו במקור |
| LocalOnlyHotspot עם SSID אקראי | להעדיף Hotspot ידני בשם `SOS12345` כמו בניסוי |
| התנגשות עם `SosNativeP2pEngine` | מסלולים מקבילים; חירום רק כש־`isRelayNetworkActive` |
| Package/Intent names | להחליף ל־`com.sos010.app` בעקביות |

---

## 9. הגדרת «סיום תשתית תכנון» / התחלת מימוש

מסמך זה נשמר כמפרט.  
**מימוש ראשוני בוצע ב־2026-08-17:** שלבים A–D/F (מסך, Service, Bridge, test-runner, Manifest, JS).  
שלב E (צ׳אט מלא דרך חירום) — לאימות בשטח.

**אין שינוי בקוד האפליקציה במסגרת שלב התכנון בלבד** — המימוש מתחיל רק אחרי הוראה מפורשת.

---

## 10. הצעד הבא אחרי אישור

להתחיל **שלב A1 בלבד** (Activity + layout מסך חירום) — רק אחרי הוראה מפורשת להתחיל מימוש.
