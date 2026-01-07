/**
 * SOS Control Panel - מרכז בקרה וגיבוי רשת
 * ממשק ניטור, גיבוי ושליטה ברשת Nostr של SOS
 * כולל שרת Relay מובנה לגיבוי מקומי
 */

// הגדרות
// רשימת Relays (כולל שרת מקומי)
const RELAY_URLS = [
  'ws://localhost:8080',  // שרת מקומי
  'wss://relay.snort.social',
  'wss://nos.lol',
  'wss://nostr-relay.xbytez.io',
  'wss://nostr-02.uid.ovh'
];

// שרת Relay מובנה - מאחסן את כל האירועים מקומית
const localRelayServer = {
  clients: new Set(),
  subscriptions: new Map(),
  isRunning: false,
  port: 8765
};

// הגדרות DDNS
const DDNS_CONFIG = {
  hostname: 'sos12345.ddns.net',
  username: 's4v5p89@ddnskey.com',
  password: 's9LHxaLTZv3s',
  port: 8080
};

// מצב המערכת
const state = {
  relays: new Map(),
  events: [],
  users: new Map(),
  pendingProfiles: new Set(), // פרופילים בטעינה
  backupData: {
    events: [],
    profiles: new Map(),
    lastBackup: null
  },
  stats: {
    totalEvents: 0,
    eventsPerMinute: 0,
    lastEventTime: null
  }
};

// Network Tag של SOS - הרשת הישראלית
const NETWORK_TAG = 'israel-network';

// סוגי אירועים (Kinds)
const EVENT_KINDS = {
  0: { name: 'פרופיל', color: 'kind-0' },
  1: { name: 'פוסט', color: 'kind-1' },
  5: { name: 'מחיקה', color: 'kind-5' },
  7: { name: 'לייק', color: 'kind-7' },
  4: { name: 'הודעה', color: 'kind-0' },
  40: { name: 'ערוץ', color: 'kind-1' },
};

// אתחול
document.addEventListener('DOMContentLoaded', () => {
  logToConsole('info', 'מאתחל מרכז בקרה...');
  loadBackupFromStorage();
  initRelays();
  startStatsUpdater();
  updateUI();
  
  // הוספת כפתור לטעינת היסטוריה מלאה
  addHistoryLoadButton();
});

// הוספת כפתור לטעינת היסטוריה
function addHistoryLoadButton() {
  const header = document.querySelector('.section-header');
  if (header) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.innerHTML = '<i class="fas fa-history"></i> טען היסטוריה מלאה';
    btn.onclick = loadFullHistory;
    header.appendChild(btn);
  }
}

// טעינת היסטוריה מלאה מכל השרתים
async function loadFullHistory() {
  logToConsole('info', 'מתחיל לטעון היסטוריה מלאה מכל השרתים...');
  
  const statusEl = document.getElementById('backupStatus');
  const progressEl = document.getElementById('backupProgress');
  const percentEl = document.getElementById('backupPercent');
  
  statusEl.style.display = 'flex';
  progressEl.style.width = '10%';
  percentEl.textContent = 'טוען...';
  
  // שליחת בקשה לכל האירועים מ-30 יום אחרונים
  state.relays.forEach((relay, url) => {
    if (relay.ws && relay.ws.readyState === WebSocket.OPEN) {
      const historySubId = 'history-' + Math.random().toString(36).slice(2, 8);
      
      // פילטר להיסטוריה מלאה
      const filters = [
        {
          kinds: [0, 1, 5, 7],
          since: Math.floor(Date.now() / 1000) - 86400 * 30, // 30 יום
          limit: 5000
        }
      ];
      
      const req = JSON.stringify(['REQ', historySubId, ...filters]);
      relay.ws.send(req);
      logToConsole('info', `שולח בקשת היסטוריה ל-${url}`);
    }
  });
  
  // עדכון התקדמות
  let progress = 10;
  const interval = setInterval(() => {
    progress = Math.min(progress + 5, 95);
    progressEl.style.width = progress + '%';
    percentEl.textContent = `${state.stats.totalEvents} אירועים...`;
    
    if (progress >= 95) {
      clearInterval(interval);
      setTimeout(() => {
        progressEl.style.width = '100%';
        percentEl.textContent = '100%';
        saveBackupToStorage();
        logToConsole('success', `היסטוריה נטענה! ${state.stats.totalEvents} אירועים`);
        setTimeout(() => {
          statusEl.style.display = 'none';
        }, 2000);
      }, 3000);
    }
  }, 500);
}

// התחברות לשרתי Relay
function initRelays() {
  const relays = [...RELAY_URLS];
  
  // הוספת שרתים מותאמים מ-localStorage
  const customRelays = JSON.parse(localStorage.getItem('sos_custom_relays') || '[]');
  customRelays.forEach(url => {
    if (!relays.includes(url)) {
      relays.push(url);
    }
  });
  
  relays.forEach(url => connectToRelay(url));
}

// התחברות לשרת Relay בודד
function connectToRelay(url) {
  logToConsole('info', `מתחבר ל-${url}...`);
  
  const relayState = {
    url,
    status: 'connecting',
    ws: null,
    eventCount: 0,
    latency: null,
    lastEvent: null
  };
  
  state.relays.set(url, relayState);
  updateRelayList();
  
  try {
    const ws = new WebSocket(url);
    relayState.ws = ws;
    const startTime = Date.now();
    
    ws.onopen = () => {
      relayState.status = 'online';
      relayState.latency = Date.now() - startTime;
      logToConsole('success', `מחובר ל-${url} (${relayState.latency}ms)`);
      updateRelayList();
      
      // הרשמה לאירועים של הרשת
      subscribeToEvents(ws);
    };
    
    ws.onmessage = (event) => {
      handleRelayMessage(url, event.data);
    };
    
    ws.onerror = (error) => {
      relayState.status = 'offline';
      logToConsole('error', `שגיאה ב-${url}`);
      updateRelayList();
    };
    
    ws.onclose = () => {
      relayState.status = 'offline';
      logToConsole('warning', `התנתק מ-${url}`);
      updateRelayList();
      
      // ניסיון התחברות מחדש אחרי 5 שניות
      setTimeout(() => connectToRelay(url), 5000);
    };
    
  } catch (err) {
    relayState.status = 'offline';
    logToConsole('error', `נכשל להתחבר ל-${url}: ${err.message}`);
    updateRelayList();
  }
}

// הרשמה לאירועים - רק של רשת SOS הישראלית
function subscribeToEvents(ws) {
  const subId = 'sos-control-' + Math.random().toString(36).slice(2, 8);
  
  // פילטר לכל האירועים של רשת israel-network
  const filterSOS = {
    '#t': [NETWORK_TAG],
    limit: 50000
  };
  
  const req = JSON.stringify(['REQ', subId, filterSOS]);
  ws.send(req);
  
  logToConsole('info', `נרשם לכל אירועי רשת israel-network (${subId})`);
  
  // טעינת כל הפרופילים של הרשת (גם אלה שלא פרסמו עם tag)
  const profileSubId = 'profiles-' + Math.random().toString(36).slice(2, 8);
  const profileFilter = {
    kinds: [0],
    '#t': [NETWORK_TAG],
    limit: 1000
  };
  const profileReq = JSON.stringify(['REQ', profileSubId, profileFilter]);
  ws.send(profileReq);
}

// טיפול בהודעות מהשרת
function handleRelayMessage(relayUrl, data) {
  try {
    const msg = JSON.parse(data);
    const [type, subId, event] = msg;
    
    if (type === 'EVENT' && event) {
      // אם זה פרופיל (kind 0) - עבד אותו תמיד (גם ללא tag)
      if (event.kind === 0) {
        processProfileEvent(event);
      }
      // אירועים אחרים - רק אם יש להם tag של הרשת
      processEvent(relayUrl, event);
    } else if (type === 'EOSE') {
      // רק עבור subscription ראשי (לא פרופילים)
      if (subId && subId.startsWith('sos-control-')) {
        logToConsole('info', `סיום טעינה ראשונית מ-${relayUrl}`);
        // טען פרופילים חסרים פעם אחת בלבד
        setTimeout(() => loadMissingProfiles(relayUrl), 1000);
      }
    }
  } catch (err) {
    // התעלם משגיאות פרסור
  }
}

// בדיקה אם האירוע שייך לרשת israel-network
function isNetworkEvent(event) {
  if (!event || !Array.isArray(event.tags)) return false;
  return event.tags.some(tag => 
    tag[0] === 't' && tag[1] === NETWORK_TAG
  );
}

// עיבוד אירוע
function processEvent(relayUrl, event) {
  // סינון בצד הלקוח - רק אירועים של israel-network
  if (!isNetworkEvent(event)) {
    return; // התעלם מאירועים שלא שייכים לרשת שלנו
  }
  
  const relay = state.relays.get(relayUrl);
  if (relay) {
    relay.eventCount++;
    relay.lastEvent = new Date();
  }
  
  // בדיקה אם האירוע כבר קיים
  const exists = state.events.some(e => e.id === event.id);
  if (exists) return;
  
  // הוספה לרשימה
  state.events.unshift(event);
  state.stats.totalEvents++;
  state.stats.lastEventTime = new Date();
  
  // שמירה לגיבוי
  state.backupData.events.push(event);
  
  // עדכון משתמשים
  if (event.kind === 0) {
    try {
      const profile = JSON.parse(event.content);
      state.users.set(event.pubkey, {
        pubkey: event.pubkey,
        name: profile.name || profile.display_name || 'אנונימי',
        picture: profile.picture || null,
        lastSeen: new Date()
      });
      state.backupData.profiles.set(event.pubkey, profile);
    } catch (e) {}
  } else {
    // עדכון lastSeen למשתמש
    if (state.users.has(event.pubkey)) {
      state.users.get(event.pubkey).lastSeen = new Date();
    } else {
      state.users.set(event.pubkey, {
        pubkey: event.pubkey,
        name: event.pubkey.slice(0, 8) + '...',
        picture: null,
        lastSeen: new Date()
      });
    }
  }
  
  // עדכון UI
  updateEventsList();
  updateUsersGrid();
  updateStats();
  
  // טעינת פרופיל אם חסר
  if (!state.users.get(event.pubkey)?.picture && !state.pendingProfiles?.has(event.pubkey)) {
    loadUserProfile(event.pubkey);
  }
  
  // עדכון מטא-דאטה כל 500 אירועים
  if (state.backupData.events.length % 500 === 0) {
    saveBackupToStorage();
  }
}

// עדכון רשימת Relays
function updateRelayList() {
  const container = document.getElementById('relayList');
  if (!container) return;
  
  let html = '';
  let onlineCount = 0;
  
  state.relays.forEach((relay, url) => {
    if (relay.status === 'online') onlineCount++;
    const isCustom = !RELAY_URLS.includes(url);
    
    html += `
      <div class="relay-item">
        <div class="relay-info">
          <div class="relay-status-indicator ${relay.status}"></div>
          <span class="relay-url">${url}</span>
          ${isCustom ? '<span class="relay-custom-badge">מותאם</span>' : ''}
        </div>
        <div class="relay-stats">
          <div class="relay-stat">
            <i class="fas fa-bolt"></i>
            <span>${relay.eventCount} אירועים</span>
          </div>
          <div class="relay-stat">
            <i class="fas fa-clock"></i>
            <span>${relay.latency ? relay.latency + 'ms' : '--'}</span>
          </div>
          <div class="relay-stat">
            <i class="fas fa-circle ${relay.status === 'online' ? 'text-success' : 'text-danger'}"></i>
            <span>${relay.status === 'online' ? 'מחובר' : relay.status === 'connecting' ? 'מתחבר...' : 'מנותק'}</span>
          </div>
          ${isCustom ? `<button class="relay-remove-btn" onclick="removeRelay('${url}')" title="הסר שרת"><i class="fas fa-times"></i></button>` : ''}
        </div>
      </div>
    `;
  });
  
  container.innerHTML = html;
  document.getElementById('relayCount').textContent = onlineCount;
}

// עדכון רשימת אירועים
function updateEventsList() {
  const container = document.getElementById('eventsContainer');
  if (!container) return;
  
  const recentEvents = state.events.slice(0, 50);
  
  let html = '';
  recentEvents.forEach(event => {
    const kindInfo = EVENT_KINDS[event.kind] || { name: `Kind ${event.kind}`, color: 'kind-0' };
    const time = new Date(event.created_at * 1000).toLocaleTimeString('he-IL');
    const content = event.content.slice(0, 100) + (event.content.length > 100 ? '...' : '');
    
    html += `
      <div class="event-item">
        <span class="event-kind ${kindInfo.color}">${kindInfo.name}</span>
        <span class="event-pubkey">${event.pubkey.slice(0, 16)}...</span>
        <span class="event-content">${escapeHtml(content) || '(ריק)'}</span>
        <span class="event-time">${time}</span>
        <span class="event-id">${event.id.slice(0, 8)}...</span>
      </div>
    `;
  });
  
  container.innerHTML = html || '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">ממתין לאירועים...</div>';
}

// עדכון רשת משתמשים
function updateUsersGrid() {
  const container = document.getElementById('usersGrid');
  if (!container) return;
  
  // הצגת כל המשתמשים (עד 100)
  const users = Array.from(state.users.values())
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 100);
  
  let html = '';
  users.forEach(user => {
    const initials = user.name.slice(0, 2).toUpperCase();
    const avatar = user.picture 
      ? `<img src="${user.picture}" alt="${user.name}" onerror="this.style.display='none'; this.parentElement.textContent='${initials}';">`
      : initials;
    
    html += `
      <div class="user-card" onclick="openProfileModal('${user.pubkey}')" style="cursor: pointer;">
        <div class="user-avatar">${avatar}</div>
        <div class="user-info">
          <h4>${escapeHtml(user.name)}</h4>
          <span>${user.pubkey.slice(0, 12)}...</span>
        </div>
      </div>
    `;
  });
  
  container.innerHTML = html || '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">אין משתמשים פעילים</div>';
  
  document.getElementById('userCount').textContent = state.users.size;
  document.getElementById('activeUserCount').textContent = users.length;
}

// עדכון סטטיסטיקות
function updateStats() {
  document.getElementById('eventCount').textContent = state.stats.totalEvents.toLocaleString();
  
  // חישוב גודל גיבוי
  const backupSize = JSON.stringify(state.backupData).length;
  const sizeMB = (backupSize / 1024 / 1024).toFixed(2);
  document.getElementById('backupSize').textContent = sizeMB + ' MB';
  
  // עדכון זמן אחרון
  document.getElementById('lastUpdate').textContent = 'עודכן: ' + new Date().toLocaleTimeString('he-IL');
}

// מעדכן סטטיסטיקות כל דקה
function startStatsUpdater() {
  setInterval(() => {
    updateStats();
    updateRelayList();
  }, 10000);
}

// עדכון UI כללי
function updateUI() {
  updateRelayList();
  updateEventsList();
  updateUsersGrid();
  updateStats();
}

// פונקציות גיבוי

function startFullBackup() {
  logToConsole('info', 'מתחיל גיבוי מלא...');
  
  const statusEl = document.getElementById('backupStatus');
  const progressEl = document.getElementById('backupProgress');
  const percentEl = document.getElementById('backupPercent');
  
  statusEl.style.display = 'flex';
  
  let progress = 0;
  const interval = setInterval(() => {
    progress += 10;
    progressEl.style.width = progress + '%';
    percentEl.textContent = progress + '%';
    
    if (progress >= 100) {
      clearInterval(interval);
      saveBackupToStorage();
      logToConsole('success', `גיבוי מלא הושלם! ${state.backupData.events.length} אירועים נשמרו`);
      setTimeout(() => {
        statusEl.style.display = 'none';
      }, 2000);
    }
  }, 200);
}

function startIncrementalBackup() {
  logToConsole('info', 'מבצע גיבוי מצטבר...');
  saveBackupToStorage();
  logToConsole('success', 'גיבוי מצטבר הושלם!');
}

function exportBackup() {
  logToConsole('info', 'מייצא גיבוי לקובץ...');
  
  const data = {
    exportDate: new Date().toISOString(),
    network: NETWORK_TAG,
    events: state.backupData.events,
    profiles: Object.fromEntries(state.backupData.profiles),
    stats: {
      totalEvents: state.stats.totalEvents,
      totalUsers: state.users.size
    }
  };
  
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `sos-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  
  URL.revokeObjectURL(url);
  logToConsole('success', 'הקובץ הורד בהצלחה!');
}

// משתנה גלובלי לשמירת הגיבוי הנטען
let loadedBackupData = null;

function restoreBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      
      if (data.events && Array.isArray(data.events)) {
        // שמירת הגיבוי בזיכרון
        loadedBackupData = data;
        
        // הצגת חלון סטטיסטיקות
        showBackupPreview(data);
      } else {
        throw new Error('פורמט קובץ לא תקין');
      }
    } catch (err) {
      logToConsole('error', `שגיאה בשחזור: ${err.message}`);
    }
  };
  
  input.click();
}

// הצגת תצוגה מקדימה של הגיבוי
function showBackupPreview(data) {
  const eventsByKind = {};
  data.events.forEach(e => {
    eventsByKind[e.kind] = (eventsByKind[e.kind] || 0) + 1;
  });
  
  const profileCount = data.profiles ? Object.keys(data.profiles).length : 0;
  const exportDate = data.exportDate ? new Date(data.exportDate).toLocaleString('he-IL') : 'לא ידוע';
  
  // יצירת רשימת relays מחוברים
  let relayOptions = '';
  state.relays.forEach((relay, url) => {
    if (relay.status === 'online') {
      relayOptions += `<option value="${url}">${url}</option>`;
    }
  });
  
  const modal = document.getElementById('backupPreviewModal');
  if (!modal) {
    // יצירת modal אם לא קיים
    createBackupPreviewModal();
  }
  
  // עדכון תוכן
  document.getElementById('backupExportDate').textContent = exportDate;
  document.getElementById('backupNetwork').textContent = data.network || 'לא מוגדר';
  document.getElementById('backupEventCount').textContent = data.events.length.toLocaleString();
  document.getElementById('backupProfileCount').textContent = profileCount.toLocaleString();
  
  // סטטיסטיקות לפי סוג
  let kindStats = '';
  const kindNames = { 0: 'פרופילים', 1: 'פוסטים', 5: 'מחיקות', 7: 'לייקים', 4: 'הודעות', 40: 'ערוצים' };
  Object.entries(eventsByKind).sort((a, b) => b[1] - a[1]).forEach(([kind, count]) => {
    const name = kindNames[kind] || `סוג ${kind}`;
    kindStats += `<div class="backup-stat-row"><span>${name}</span><span>${count.toLocaleString()}</span></div>`;
  });
  document.getElementById('backupKindStats').innerHTML = kindStats;
  
  // עדכון רשימת relays
  document.getElementById('targetRelaySelect').innerHTML = relayOptions || '<option value="">אין שרתים מחוברים</option>';
  
  // הצגת modal
  document.getElementById('backupPreviewModal').classList.add('active');
}

// יצירת modal לתצוגה מקדימה
function createBackupPreviewModal() {
  const modalHtml = `
    <div id="backupPreviewModal" class="modal-overlay" onclick="closeBackupPreview(event)">
      <div class="modal-content backup-preview-modal" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h2><i class="fas fa-file-archive"></i> תצוגה מקדימה של גיבוי</h2>
          <button class="modal-close" onclick="closeBackupPreview()">&times;</button>
        </div>
        
        <div class="backup-info-grid">
          <div class="backup-info-item">
            <i class="fas fa-calendar"></i>
            <div>
              <span class="label">תאריך יצוא</span>
              <span id="backupExportDate" class="value">-</span>
            </div>
          </div>
          <div class="backup-info-item">
            <i class="fas fa-network-wired"></i>
            <div>
              <span class="label">רשת</span>
              <span id="backupNetwork" class="value">-</span>
            </div>
          </div>
          <div class="backup-info-item">
            <i class="fas fa-database"></i>
            <div>
              <span class="label">סה"כ אירועים</span>
              <span id="backupEventCount" class="value">-</span>
            </div>
          </div>
          <div class="backup-info-item">
            <i class="fas fa-users"></i>
            <div>
              <span class="label">פרופילים</span>
              <span id="backupProfileCount" class="value">-</span>
            </div>
          </div>
        </div>
        
        <div class="backup-stats-section">
          <h3><i class="fas fa-chart-bar"></i> פירוט לפי סוג</h3>
          <div id="backupKindStats" class="backup-kind-stats"></div>
        </div>
        
        <div class="backup-actions-section">
          <h3><i class="fas fa-cog"></i> אפשרויות</h3>
          
          <div class="backup-action-row">
            <label>טען לזיכרון המקומי:</label>
            <button class="btn btn-primary" onclick="applyBackupToMemory()">
              <i class="fas fa-download"></i> טען גיבוי
            </button>
          </div>
          
          <div class="backup-action-row">
            <label>העתק לשרת Relay:</label>
            <div class="relay-copy-controls">
              <select id="targetRelaySelect" class="relay-select"></select>
              <input type="number" id="copyBatchSize" value="10" min="1" max="100" class="batch-input" title="אירועים בכל פעם">
              <input type="number" id="copyDelay" value="500" min="100" max="5000" step="100" class="delay-input" title="השהייה (מילישניות)">
              <button class="btn btn-secondary" onclick="copyBackupToRelay()">
                <i class="fas fa-upload"></i> העתק
              </button>
            </div>
          </div>
          
          <div id="copyProgress" class="copy-progress" style="display: none;">
            <div class="progress-bar">
              <div id="copyProgressBar" class="progress-fill"></div>
            </div>
            <span id="copyProgressText">0%</span>
            <button id="stopCopyBtn" class="btn btn-danger btn-sm" onclick="stopCopy()">
              <i class="fas fa-stop"></i> עצור
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  
  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

// סגירת חלון תצוגה מקדימה
function closeBackupPreview(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('backupPreviewModal')?.classList.remove('active');
}

// טעינת הגיבוי לזיכרון
function applyBackupToMemory() {
  if (!loadedBackupData) return;
  
  state.backupData.events = loadedBackupData.events;
  state.events = [...loadedBackupData.events].reverse().slice(0, 1000);
  state.stats.totalEvents = loadedBackupData.events.length;
  
  if (loadedBackupData.profiles) {
    state.backupData.profiles = new Map(Object.entries(loadedBackupData.profiles));
  }
  
  // עדכון משתמשים מהאירועים
  loadedBackupData.events.forEach(event => {
    if (!state.users.has(event.pubkey)) {
      const profile = loadedBackupData.profiles?.[event.pubkey] || {};
      state.users.set(event.pubkey, {
        pubkey: event.pubkey,
        name: profile.name || event.pubkey.slice(0, 8),
        picture: profile.picture,
        lastSeen: new Date(event.created_at * 1000)
      });
    }
  });
  
  saveBackupToStorage();
  updateUI();
  closeBackupPreview();
  
  logToConsole('success', `נטענו ${loadedBackupData.events.length} אירועים לזיכרון!`);
}

// משתנה לעצירת ההעתקה
let copyInProgress = false;

// העתקת גיבוי לשרת relay
async function copyBackupToRelay() {
  if (!loadedBackupData || copyInProgress) return;
  
  const targetUrl = document.getElementById('targetRelaySelect').value;
  if (!targetUrl) {
    logToConsole('error', 'בחר שרת יעד');
    return;
  }
  
  const relay = state.relays.get(targetUrl);
  if (!relay || relay.ws?.readyState !== WebSocket.OPEN) {
    logToConsole('error', 'השרת לא מחובר');
    return;
  }
  
  const batchSize = parseInt(document.getElementById('copyBatchSize').value) || 10;
  const delay = parseInt(document.getElementById('copyDelay').value) || 500;
  const events = loadedBackupData.events;
  
  copyInProgress = true;
  document.getElementById('copyProgress').style.display = 'flex';
  
  logToConsole('info', `מתחיל להעתיק ${events.length} אירועים ל-${targetUrl}...`);
  
  let copied = 0;
  for (let i = 0; i < events.length && copyInProgress; i += batchSize) {
    const batch = events.slice(i, i + batchSize);
    
    for (const event of batch) {
      if (!copyInProgress) break;
      try {
        relay.ws.send(JSON.stringify(['EVENT', event]));
        copied++;
      } catch (err) {
        logToConsole('warning', `שגיאה בשליחת אירוע: ${err.message}`);
      }
    }
    
    // עדכון התקדמות
    const percent = Math.round((copied / events.length) * 100);
    document.getElementById('copyProgressBar').style.width = percent + '%';
    document.getElementById('copyProgressText').textContent = `${copied}/${events.length} (${percent}%)`;
    
    // השהייה
    await new Promise(r => setTimeout(r, delay));
  }
  
  copyInProgress = false;
  document.getElementById('copyProgress').style.display = 'none';
  
  logToConsole('success', `הועתקו ${copied} אירועים ל-${targetUrl}`);
}

// עצירת העתקה
function stopCopy() {
  copyInProgress = false;
  logToConsole('warning', 'ההעתקה נעצרה');
}

function saveBackupToStorage() {
  // localStorage מוגבל - נשמור רק מטא-דאטה קטנה
  // הגיבוי המלא נשמר בזיכרון ומיוצא לקובץ
  try {
    const meta = {
      eventCount: state.backupData.events.length,
      profileCount: state.backupData.profiles.size,
      lastBackup: new Date().toISOString()
    };
    localStorage.setItem('sos_backup_meta', JSON.stringify(meta));
    state.backupData.lastBackup = new Date();
  } catch (err) {
    // התעלם משגיאות - הגיבוי בזיכרון
  }
}

function loadBackupFromStorage() {
  // הגיבוי המלא נטען מהשרתים בזמן אמת
  // localStorage משמש רק למטא-דאטה
  try {
    const meta = localStorage.getItem('sos_backup_meta');
    if (meta) {
      const data = JSON.parse(meta);
      logToConsole('info', `גיבוי קודם: ${data.eventCount} אירועים`);
    }
  } catch (err) {
    // התעלם
  }
}

// פתיחת חלון פרופיל
function openProfileModal(pubkey) {
  const user = state.users.get(pubkey);
  const profile = state.backupData.profiles.get(pubkey) || {};
  
  // חישוב סטטיסטיקות מהאירועים
  const userEvents = state.backupData.events.filter(e => e.pubkey === pubkey);
  const posts = userEvents.filter(e => e.kind === 1).length;
  const likes = userEvents.filter(e => e.kind === 7).length;
  const comments = userEvents.filter(e => e.kind === 1 && e.tags?.some(t => t[0] === 'e')).length;
  
  // עדכון ה-modal
  const modal = document.getElementById('profileModal');
  document.getElementById('modalName').textContent = user?.name || profile.name || 'אנונימי';
  document.getElementById('modalPubkey').textContent = pubkey;
  
  const avatarEl = document.getElementById('modalAvatar');
  if (user?.picture || profile.picture) {
    avatarEl.innerHTML = `<img src="${user?.picture || profile.picture}" onerror="this.parentElement.innerHTML='<i class=\\'fas fa-user\\'></i>'">`;
  } else {
    avatarEl.innerHTML = '<i class="fas fa-user"></i>';
  }
  
  // זמן התחברות אחרון
  const lastSeen = user?.lastSeen;
  if (lastSeen) {
    const diff = Date.now() - lastSeen.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    let timeText = 'עכשיו';
    if (minutes > 0 && minutes < 60) timeText = `לפני ${minutes} דקות`;
    else if (hours > 0 && hours < 24) timeText = `לפני ${hours} שעות`;
    else if (hours >= 24) timeText = `לפני ${Math.floor(hours/24)} ימים`;
    document.getElementById('modalLastSeen').textContent = timeText;
  } else {
    document.getElementById('modalLastSeen').textContent = 'לא ידוע';
  }
  
  // סטטיסטיקות
  document.getElementById('modalPosts').textContent = posts;
  document.getElementById('modalLikes').textContent = likes;
  document.getElementById('modalComments').textContent = comments;
  document.getElementById('modalFollowers').textContent = '—';
  
  // ביו
  document.getElementById('modalBio').textContent = profile.about || '';
  
  // אירועים אחרונים
  const eventsHtml = userEvents.slice(0, 20).map(event => {
    const kindInfo = EVENT_KINDS[event.kind] || { name: `Kind ${event.kind}` };
    const time = new Date(event.created_at * 1000).toLocaleString('he-IL');
    const iconClass = event.kind === 7 ? 'like' : event.kind === 1 ? 'post' : 'comment';
    const icon = event.kind === 7 ? 'fa-heart' : event.kind === 1 ? 'fa-pen' : 'fa-comment';
    
    return `
      <div class="profile-event">
        <div class="profile-event-icon ${iconClass}">
          <i class="fas ${icon}"></i>
        </div>
        <div class="profile-event-content">
          <div class="profile-event-text">${escapeHtml(event.content?.slice(0, 80) || kindInfo.name)}</div>
          <div class="profile-event-time">${time}</div>
        </div>
      </div>
    `;
  }).join('');
  
  document.getElementById('modalEvents').innerHTML = eventsHtml || '<div style="padding: 20px; text-align: center; color: var(--text-secondary);">אין פעילות</div>';
  
  modal.classList.add('active');
}

// סגירת חלון פרופיל
function closeProfileModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('profileModal').classList.remove('active');
}

// מעקב אחרי relays שכבר טענו פרופילים
const profilesLoadedFromRelay = new Set();

// טעינת פרופילים חסרים לאחר סיום טעינה ראשונית
function loadMissingProfiles(relayUrl) {
  // טען פרופילים רק פעם אחת לכל relay
  if (profilesLoadedFromRelay.has(relayUrl)) return;
  profilesLoadedFromRelay.add(relayUrl);
  
  const relay = state.relays.get(relayUrl);
  if (!relay || !relay.ws || relay.ws.readyState !== WebSocket.OPEN) return;
  
  // מצא את כל ה-pubkeys שאין להם פרופיל מלא
  const missingPubkeys = [];
  state.users.forEach((user, pubkey) => {
    if (!user.picture && !state.pendingProfiles.has(pubkey)) {
      missingPubkeys.push(pubkey);
      state.pendingProfiles.add(pubkey);
    }
  });
  
  if (missingPubkeys.length === 0) return;
  
  logToConsole('info', `טוען ${missingPubkeys.length} פרופילים חסרים מ-${relayUrl}...`);
  
  // שליחת בקשה לפרופילים (בקבוצות של 50)
  for (let i = 0; i < missingPubkeys.length; i += 50) {
    const batch = missingPubkeys.slice(i, i + 50);
    const subId = 'profiles-batch-' + Math.random().toString(36).slice(2, 8);
    const filter = { kinds: [0], authors: batch };
    const req = JSON.stringify(['REQ', subId, filter]);
    relay.ws.send(req);
  }
}

// טעינת פרופיל משתמש מהשרתים
function loadUserProfile(pubkey) {
  if (!pubkey || state.pendingProfiles.has(pubkey)) return;
  state.pendingProfiles.add(pubkey);
  
  // שליחת בקשה לפרופיל דרך אחד השרתים המחוברים
  state.relays.forEach((relay, url) => {
    if (relay.ws && relay.ws.readyState === WebSocket.OPEN) {
      const subId = 'profile-' + pubkey.slice(0, 8);
      const filter = { kinds: [0], authors: [pubkey], limit: 1 };
      const req = JSON.stringify(['REQ', subId, filter]);
      relay.ws.send(req);
      return; // שולח רק לשרת אחד
    }
  });
}

// עיבוד פרופיל שהתקבל (גם ללא tag)
function processProfileEvent(event) {
  if (event.kind !== 0) return;
  
  try {
    const profile = JSON.parse(event.content);
    const existing = state.users.get(event.pubkey);
    
    state.users.set(event.pubkey, {
      pubkey: event.pubkey,
      name: profile.name || profile.display_name || existing?.name || 'אנונימי',
      picture: profile.picture || existing?.picture || null,
      lastSeen: existing?.lastSeen || new Date()
    });
    
    state.backupData.profiles.set(event.pubkey, profile);
    state.pendingProfiles.delete(event.pubkey);
    
    updateUsersGrid();
  } catch (e) {}
}

// פונקציות שרת מקומי

// הסרת שרת relay מהרשימה
function removeRelay(url) {
  const relay = state.relays.get(url);
  if (relay && relay.ws) {
    relay.ws.close();
  }
  state.relays.delete(url);
  
  // הסרה מ-localStorage
  const customRelays = JSON.parse(localStorage.getItem('sos_custom_relays') || '[]');
  const filtered = customRelays.filter(r => r !== url);
  localStorage.setItem('sos_custom_relays', JSON.stringify(filtered));
  
  updateRelayList();
  logToConsole('info', `הוסר שרת: ${url}`);
}

function testLocalRelay() {
  const host = document.getElementById('ddnsHost').value;
  const port = document.getElementById('wsPort').value;
  const url = `wss://${host}:${port}`;
  
  logToConsole('info', `בודק חיבור ל-${url}...`);
  
  try {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      logToConsole('error', 'תם הזמן לחיבור');
    }, 5000);
    
    ws.onopen = () => {
      clearTimeout(timeout);
      logToConsole('success', `חיבור הצליח ל-${url}!`);
      ws.close();
    };
    
    ws.onerror = () => {
      clearTimeout(timeout);
      logToConsole('error', `נכשל להתחבר ל-${url}`);
    };
  } catch (err) {
    logToConsole('error', `שגיאה: ${err.message}`);
  }
}

function addLocalRelay() {
  const host = document.getElementById('ddnsHost').value;
  const port = document.getElementById('wsPort').value;
  const url = `wss://${host}:${port}`;
  
  // שמירה ברשימת שרתים מותאמים
  const customRelays = JSON.parse(localStorage.getItem('sos_custom_relays') || '[]');
  if (!customRelays.includes(url)) {
    customRelays.push(url);
    localStorage.setItem('sos_custom_relays', JSON.stringify(customRelays));
  }
  
  connectToRelay(url);
  logToConsole('success', `נוסף שרת מקומי: ${url}`);
}

function refreshRelays() {
  logToConsole('info', 'מרענן חיבורים...');
  
  state.relays.forEach((relay, url) => {
    if (relay.ws) {
      relay.ws.close();
    }
  });
  
  state.relays.clear();
  initRelays();
}

// לוג קונסול

function logToConsole(type, message) {
  const container = document.getElementById('consoleLog');
  if (!container) return;
  
  const time = new Date().toLocaleTimeString('he-IL');
  const line = document.createElement('div');
  line.className = `console-line console-${type}`;
  line.innerHTML = `<span class="console-time">[${time}]</span> ${escapeHtml(message)}`;
  
  container.insertBefore(line, container.firstChild);
  
  // הגבלה ל-100 שורות
  while (container.children.length > 100) {
    container.removeChild(container.lastChild);
  }
}

function clearConsole() {
  const container = document.getElementById('consoleLog');
  if (container) {
    container.innerHTML = '';
    logToConsole('info', 'הלוג נוקה');
  }
}

// עזר

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
