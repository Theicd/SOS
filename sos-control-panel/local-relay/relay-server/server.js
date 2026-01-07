const WebSocket = require('ws');
const Database = require('better-sqlite3');
const crypto = require('crypto');

// הגדרות
const PORT = process.env.PORT || 8080;
const DB_PATH = './relay.db';

// יצירת מסד נתונים
const db = new Database(DB_PATH);

// יצירת טבלאות
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    kind INTEGER NOT NULL,
    tags TEXT NOT NULL,
    content TEXT NOT NULL,
    sig TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pubkey ON events(pubkey);
  CREATE INDEX IF NOT EXISTS idx_kind ON events(kind);
  CREATE INDEX IF NOT EXISTS idx_created_at ON events(created_at);
`);

console.log('[SOS Relay] מסד נתונים מוכן');

// יצירת שרת WebSocket
const wss = new WebSocket.Server({ port: PORT });

console.log(`[SOS Relay] שרת פועל על פורט ${PORT}`);
console.log(`[SOS Relay] כתובת מקומית: ws://localhost:${PORT}`);

// מעקב אחרי מנויים
const subscriptions = new Map();

wss.on('connection', (ws, req) => {
  const clientId = crypto.randomBytes(4).toString('hex');
  console.log(`[SOS Relay] לקוח חדש: ${clientId}`);

  ws.clientId = clientId;
  ws.subscriptions = new Map();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleMessage(ws, msg);
    } catch (err) {
      console.error('[SOS Relay] שגיאת פרסור:', err.message);
    }
  });

  ws.on('close', () => {
    console.log(`[SOS Relay] לקוח התנתק: ${clientId}`);
    ws.subscriptions.clear();
  });
});

function handleMessage(ws, msg) {
  const [type, ...args] = msg;

  switch (type) {
    case 'REQ':
      handleReq(ws, args);
      break;
    case 'EVENT':
      handleEvent(ws, args[0]);
      break;
    case 'CLOSE':
      handleClose(ws, args[0]);
      break;
  }
}

function handleReq(ws, args) {
  const [subId, ...filters] = args;
  console.log(`[SOS Relay] REQ ${subId}`);

  // שמירת המנוי
  ws.subscriptions.set(subId, filters);

  // שליחת אירועים קיימים
  filters.forEach(filter => {
    const events = queryEvents(filter);
    events.forEach(event => {
      ws.send(JSON.stringify(['EVENT', subId, event]));
    });
  });

  // סיום טעינה ראשונית
  ws.send(JSON.stringify(['EOSE', subId]));
}

function handleEvent(ws, event) {
  console.log(`[SOS Relay] EVENT kind:${event.kind} from:${event.pubkey.slice(0,8)}...`);

  // שמירה במסד נתונים
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO events (id, pubkey, created_at, kind, tags, content, sig)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(event.id, event.pubkey, event.created_at, event.kind, JSON.stringify(event.tags), event.content, event.sig);

    // אישור
    ws.send(JSON.stringify(['OK', event.id, true, '']));

    // שידור לכל המנויים
    broadcastEvent(event);
  } catch (err) {
    ws.send(JSON.stringify(['OK', event.id, false, err.message]));
  }
}

function handleClose(ws, subId) {
  ws.subscriptions.delete(subId);
  console.log(`[SOS Relay] CLOSE ${subId}`);
}

function queryEvents(filter) {
  let sql = 'SELECT * FROM events WHERE 1=1';
  const params = [];

  if (filter.ids) {
    sql += ` AND id IN (${filter.ids.map(() => '?').join(',')})`;
    params.push(...filter.ids);
  }
  if (filter.authors) {
    sql += ` AND pubkey IN (${filter.authors.map(() => '?').join(',')})`;
    params.push(...filter.authors);
  }
  if (filter.kinds) {
    sql += ` AND kind IN (${filter.kinds.map(() => '?').join(',')})`;
    params.push(...filter.kinds);
  }
  if (filter.since) {
    sql += ' AND created_at >= ?';
    params.push(filter.since);
  }
  if (filter.until) {
    sql += ' AND created_at <= ?';
    params.push(filter.until);
  }

  sql += ' ORDER BY created_at DESC';

  if (filter.limit) {
    sql += ' LIMIT ?';
    params.push(filter.limit);
  }

  const rows = db.prepare(sql).all(...params);
  return rows.map(row => ({
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    tags: JSON.parse(row.tags),
    content: row.content,
    sig: row.sig
  }));
}

function broadcastEvent(event) {
  wss.clients.forEach(client => {
    if (client.readyState !== WebSocket.OPEN) return;

    client.subscriptions.forEach((filters, subId) => {
      if (matchesFilters(event, filters)) {
        client.send(JSON.stringify(['EVENT', subId, event]));
      }
    });
  });
}

function matchesFilters(event, filters) {
  return filters.some(filter => {
    if (filter.ids && !filter.ids.includes(event.id)) return false;
    if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
    if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
    if (filter.since && event.created_at < filter.since) return false;
    if (filter.until && event.created_at > filter.until) return false;
    return true;
  });
}

// סטטיסטיקות
setInterval(() => {
  const eventCount = db.prepare('SELECT COUNT(*) as count FROM events').get().count;
  console.log(`[SOS Relay] סטטיסטיקות: ${wss.clients.size} לקוחות, ${eventCount} אירועים`);
}, 60000);

console.log('[SOS Relay] מוכן לקבל חיבורים!');
