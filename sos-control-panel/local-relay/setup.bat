@echo off
chcp 65001 >nul
echo ========================================
echo    SOS Local Relay Server Setup
echo ========================================
echo.

:: בדיקה אם Node.js מותקן
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js לא מותקן!
    echo אנא התקן מ: https://nodejs.org/
    pause
    exit /b 1
)

echo [OK] Node.js נמצא
node --version

:: יצירת תיקיית הפרויקט
if not exist "relay-server" mkdir relay-server
cd relay-server

:: יצירת package.json
echo [INFO] יוצר package.json...
(
echo {
echo   "name": "sos-local-relay",
echo   "version": "1.0.0",
echo   "description": "SOS Local Nostr Relay Server",
echo   "main": "server.js",
echo   "scripts": {
echo     "start": "node server.js",
echo     "dev": "node server.js"
echo   },
echo   "dependencies": {
echo     "ws": "^8.14.2",
echo     "better-sqlite3": "^9.2.2"
echo   }
echo }
) > package.json

:: התקנת תלויות
echo [INFO] מתקין תלויות...
call npm install

:: יצירת קובץ השרת
echo [INFO] יוצר שרת Relay...
call :createServer

echo.
echo ========================================
echo    ההתקנה הושלמה!
echo ========================================
echo.
echo להפעלת השרת הרץ: npm start
echo השרת יאזין על: ws://localhost:8080
echo.
echo לחיבור מרחוק עם No-IP:
echo 1. הגדר Port Forwarding בראוטר: 8080 -^> IP מקומי
echo 2. השתמש בכתובת: wss://sos12345.ddns.net:8080
echo.
pause
exit /b 0

:createServer
(
echo const WebSocket = require^('ws'^);
echo const Database = require^('better-sqlite3'^);
echo const crypto = require^('crypto'^);
echo.
echo // הגדרות
echo const PORT = process.env.PORT ^|^| 8080;
echo const DB_PATH = './relay.db';
echo.
echo // יצירת מסד נתונים
echo const db = new Database^(DB_PATH^);
echo.
echo // יצירת טבלאות
echo db.exec^(`
echo   CREATE TABLE IF NOT EXISTS events ^(
echo     id TEXT PRIMARY KEY,
echo     pubkey TEXT NOT NULL,
echo     created_at INTEGER NOT NULL,
echo     kind INTEGER NOT NULL,
echo     tags TEXT NOT NULL,
echo     content TEXT NOT NULL,
echo     sig TEXT NOT NULL
echo   ^);
echo   CREATE INDEX IF NOT EXISTS idx_pubkey ON events^(pubkey^);
echo   CREATE INDEX IF NOT EXISTS idx_kind ON events^(kind^);
echo   CREATE INDEX IF NOT EXISTS idx_created_at ON events^(created_at^);
echo `^);
echo.
echo console.log^('[SOS Relay] מסד נתונים מוכן'^);
echo.
echo // יצירת שרת WebSocket
echo const wss = new WebSocket.Server^({ port: PORT }^);
echo.
echo console.log^(`[SOS Relay] שרת פועל על פורט ${PORT}`^);
echo console.log^(`[SOS Relay] כתובת מקומית: ws://localhost:${PORT}`^);
echo.
echo // מעקב אחרי מנויים
echo const subscriptions = new Map^(^);
echo.
echo wss.on^('connection', ^(ws, req^) =^> {
echo   const clientId = crypto.randomBytes^(4^).toString^('hex'^);
echo   console.log^(`[SOS Relay] לקוח חדש: ${clientId}`^);
echo.
echo   ws.clientId = clientId;
echo   ws.subscriptions = new Map^(^);
echo.
echo   ws.on^('message', ^(data^) =^> {
echo     try {
echo       const msg = JSON.parse^(data^);
echo       handleMessage^(ws, msg^);
echo     } catch ^(err^) {
echo       console.error^('[SOS Relay] שגיאת פרסור:', err.message^);
echo     }
echo   }^);
echo.
echo   ws.on^('close', ^(^) =^> {
echo     console.log^(`[SOS Relay] לקוח התנתק: ${clientId}`^);
echo     ws.subscriptions.clear^(^);
echo   }^);
echo }^);
echo.
echo function handleMessage^(ws, msg^) {
echo   const [type, ...args] = msg;
echo.
echo   switch ^(type^) {
echo     case 'REQ':
echo       handleReq^(ws, args^);
echo       break;
echo     case 'EVENT':
echo       handleEvent^(ws, args[0]^);
echo       break;
echo     case 'CLOSE':
echo       handleClose^(ws, args[0]^);
echo       break;
echo   }
echo }
echo.
echo function handleReq^(ws, args^) {
echo   const [subId, ...filters] = args;
echo   console.log^(`[SOS Relay] REQ ${subId}`^);
echo.
echo   // שמירת המנוי
echo   ws.subscriptions.set^(subId, filters^);
echo.
echo   // שליחת אירועים קיימים
echo   filters.forEach^(filter =^> {
echo     const events = queryEvents^(filter^);
echo     events.forEach^(event =^> {
echo       ws.send^(JSON.stringify^(['EVENT', subId, event]^)^);
echo     }^);
echo   }^);
echo.
echo   // סיום טעינה ראשונית
echo   ws.send^(JSON.stringify^(['EOSE', subId]^)^);
echo }
echo.
echo function handleEvent^(ws, event^) {
echo   console.log^(`[SOS Relay] EVENT kind:${event.kind} from:${event.pubkey.slice^(0,8^)}...`^);
echo.
echo   // שמירה במסד נתונים
echo   try {
echo     const stmt = db.prepare^(`
echo       INSERT OR REPLACE INTO events ^(id, pubkey, created_at, kind, tags, content, sig^)
echo       VALUES ^(?, ?, ?, ?, ?, ?, ?^)
echo     `^);
echo     stmt.run^(event.id, event.pubkey, event.created_at, event.kind, JSON.stringify^(event.tags^), event.content, event.sig^);
echo.
echo     // אישור
echo     ws.send^(JSON.stringify^(['OK', event.id, true, '']^)^);
echo.
echo     // שידור לכל המנויים
echo     broadcastEvent^(event^);
echo   } catch ^(err^) {
echo     ws.send^(JSON.stringify^(['OK', event.id, false, err.message]^)^);
echo   }
echo }
echo.
echo function handleClose^(ws, subId^) {
echo   ws.subscriptions.delete^(subId^);
echo   console.log^(`[SOS Relay] CLOSE ${subId}`^);
echo }
echo.
echo function queryEvents^(filter^) {
echo   let sql = 'SELECT * FROM events WHERE 1=1';
echo   const params = [];
echo.
echo   if ^(filter.ids^) {
echo     sql += ` AND id IN ^(${filter.ids.map^(^(^) =^> '?'^).join^(','^)}^)`;
echo     params.push^(...filter.ids^);
echo   }
echo   if ^(filter.authors^) {
echo     sql += ` AND pubkey IN ^(${filter.authors.map^(^(^) =^> '?'^).join^(','^)}^)`;
echo     params.push^(...filter.authors^);
echo   }
echo   if ^(filter.kinds^) {
echo     sql += ` AND kind IN ^(${filter.kinds.map^(^(^) =^> '?'^).join^(','^)}^)`;
echo     params.push^(...filter.kinds^);
echo   }
echo   if ^(filter.since^) {
echo     sql += ' AND created_at ^>= ?';
echo     params.push^(filter.since^);
echo   }
echo   if ^(filter.until^) {
echo     sql += ' AND created_at ^<= ?';
echo     params.push^(filter.until^);
echo   }
echo.
echo   sql += ' ORDER BY created_at DESC';
echo.
echo   if ^(filter.limit^) {
echo     sql += ' LIMIT ?';
echo     params.push^(filter.limit^);
echo   }
echo.
echo   const rows = db.prepare^(sql^).all^(...params^);
echo   return rows.map^(row =^> ^({
echo     id: row.id,
echo     pubkey: row.pubkey,
echo     created_at: row.created_at,
echo     kind: row.kind,
echo     tags: JSON.parse^(row.tags^),
echo     content: row.content,
echo     sig: row.sig
echo   }^)^);
echo }
echo.
echo function broadcastEvent^(event^) {
echo   wss.clients.forEach^(client =^> {
echo     if ^(client.readyState !== WebSocket.OPEN^) return;
echo.
echo     client.subscriptions.forEach^(^(filters, subId^) =^> {
echo       if ^(matchesFilters^(event, filters^)^) {
echo         client.send^(JSON.stringify^(['EVENT', subId, event]^)^);
echo       }
echo     }^);
echo   }^);
echo }
echo.
echo function matchesFilters^(event, filters^) {
echo   return filters.some^(filter =^> {
echo     if ^(filter.ids ^&^& !filter.ids.includes^(event.id^)^) return false;
echo     if ^(filter.authors ^&^& !filter.authors.includes^(event.pubkey^)^) return false;
echo     if ^(filter.kinds ^&^& !filter.kinds.includes^(event.kind^)^) return false;
echo     if ^(filter.since ^&^& event.created_at ^< filter.since^) return false;
echo     if ^(filter.until ^&^& event.created_at ^> filter.until^) return false;
echo     return true;
echo   }^);
echo }
echo.
echo // סטטיסטיקות
echo setInterval^(^(^) =^> {
echo   const eventCount = db.prepare^('SELECT COUNT^(*^) as count FROM events'^).get^(^).count;
echo   console.log^(`[SOS Relay] סטטיסטיקות: ${wss.clients.size} לקוחות, ${eventCount} אירועים`^);
echo }, 60000^);
echo.
echo console.log^('[SOS Relay] מוכן לקבל חיבורים!'^);
) > server.js
goto :eof
