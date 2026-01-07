# SOS White Label Networks - מודל עסקי וארכיטקטורה

## 📋 תוכן עניינים

1. [סקירת המודל העסקי](#1-סקירת-המודל-העסקי)
2. [ארכיטקטורה טכנית](#2-ארכיטקטורה-טכנית)
3. [מערכת בקרה למנהלי קבוצות](#3-מערכת-בקרה-למנהלי-קבוצות)
4. [מערכת בקרה לבעל הרשת](#4-מערכת-בקרה-לבעל-הרשת)
5. [יישום טכני](#5-יישום-טכני)
6. [תנאי שימוש מומלצים](#6-תנאי-שימוש-מומלצים)

---

## 1. סקירת המודל העסקי

### 1.1 הרעיון המרכזי

```
┌─────────────────────────────────────────────────────────────────┐
│                         SOS MASTER                               │
│                    (הרשת הראשית שלך)                             │
│                                                                  │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│   │  קבוצה A    │  │  קבוצה B    │  │  קבוצה C    │             │
│   │  לוגו משלה  │  │  לוגו משלה  │  │  לוגו משלה  │             │
│   │  שם משלה   │  │  שם משלה   │  │  שם משלה   │             │
│   │  צבעים     │  │  צבעים     │  │  צבעים     │             │
│   │  דומיין    │  │  דומיין    │  │  דומיין    │             │
│   └─────────────┘  └─────────────┘  └─────────────┘             │
│                           │                                      │
│                           ▼                                      │
│              ┌─────────────────────────┐                        │
│              │   אותו Relay           │                        │
│              │   אותו קוד             │                        │
│              │   אותה בקרה מרכזית     │                        │
│              └─────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 מה אתה נותן (בחינם)

| רכיב | תיאור |
|------|-------|
| **קוד פתוח** | רישיון שימוש - לא לשנות |
| **פלטפורמה** | WhatsApp + TikTok מוכן |
| **תשתית** | Relay, אחסון, Push |
| **ממשק ניהול** | לוח בקרה למנהל הקבוצה |

### 1.3 מה אתה מקבל

| יתרון | הסבר |
|-------|------|
| **גישה לשיווק** | יכול לפרסם לכל הקבוצות |
| **ערך כלכלי** | ככל שיש יותר משתמשים = שווי גבוה יותר |
| **נכס למכירה** | הקוד + תשתית + גישה למשתמשים |
| **אין התחייבות** | יכול להפסיק בכל רגע |
| **אין אחריות** | לא אחראי לתוכן/זכויות יוצרים |

### 1.4 מה מנהלי הקבוצות מקבלים

| יתרון | הסבר |
|-------|------|
| **רשת חברתית בחינם** | לא צריכים לפתח |
| **מיתוג משלהם** | לוגו, שם, צבעים |
| **דומיין משלהם** | (בתשלום שלהם) |
| **שליטה בקהילה** | חסימת משתמשים, מחיקת תוכן |
| **עצמאות** | הם מנהלים, לא אתה |

---

## 2. ארכיטקטורה טכנית

### 2.1 איך זה עובד ב-Nostr

```
כל משתמש = מפתח ציבורי + פרטי (אוניברסלי)
           ↓
כל פוסט = אירוע Nostr עם tags
           ↓
ה-tag קובע לאיזו קבוצה הפוסט שייך
```

### 2.2 מבנה ה-Tags

```javascript
// פוסט בקבוצה A
{
  kind: 1,
  pubkey: "abc123...",
  content: "שלום עולם",
  tags: [
    ["t", "sos"],           // הרשת הראשית
    ["t", "group-a"],       // הקבוצה הספציפית
    ["t", "sos-network"]    // זיהוי כחלק מהרשת
  ]
}
```

### 2.3 זיהוי שיוך משתמש לקבוצה

```javascript
// כל משתמש שומר במטאדאטה שלו (kind 0)
{
  kind: 0,
  pubkey: "abc123...",
  content: JSON.stringify({
    name: "ישראל ישראלי",
    picture: "...",
    // שדה מותאם לזיהוי קבוצה
    sos_group: "group-a",
    sos_joined_at: 1704067200
  })
}
```

### 2.4 מבנה הקבוצות

```javascript
// הגדרת קבוצה (נשמר ב-kind 30000 או בשרת)
const GROUP_CONFIG = {
  id: "group-a",
  name: "רשת חברתית א",
  logo: "https://example.com/logo.png",
  colors: {
    primary: "#FF5722",
    secondary: "#2196F3",
    background: "#121212"
  },
  domain: "social-a.com",
  admin_pubkey: "def456...",
  created_at: 1704067200,
  settings: {
    allow_videos: true,
    allow_chat: true,
    max_post_length: 5000,
    require_approval: false
  }
};
```

---

## 3. מערכת בקרה למנהלי קבוצות

### 3.1 לוח בקרה - Group Admin Panel

```
┌─────────────────────────────────────────────────────────────────┐
│  🏠 רשת חברתית א - לוח בקרה                           [התנתק]  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐               │
│  │  👥     │ │  📊     │ │  ⚙️     │ │  🎨     │               │
│  │ משתמשים│ │ סטטיסטיקות│ │ הגדרות │ │ עיצוב  │               │
│  │  1,234 │ │         │ │         │ │         │               │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘               │
│                                                                  │
│  ══════════════════════════════════════════════════════════════ │
│                                                                  │
│  📈 סטטיסטיקות מהירות                                          │
│  ├── משתמשים פעילים היום: 342                                  │
│  ├── פוסטים היום: 89                                           │
│  ├── הודעות צ'אט: 1,456                                        │
│  └── צפיות בסרטונים: 12,340                                    │
│                                                                  │
│  🚨 דורשים התייחסות                                            │
│  ├── דיווחים על תוכן: 3                                        │
│  └── בקשות הצטרפות: 12                                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 יכולות מנהל קבוצה

| פעולה | תיאור | מימוש טכני |
|-------|-------|------------|
| **ניהול משתמשים** | צפייה, חסימה, אישור | רשימת pubkeys + סטטוס |
| **מחיקת תוכן** | הסרת פוסטים בעייתיים | kind 5 delete event |
| **עיצוב** | לוגו, צבעים, שם | config.json לכל קבוצה |
| **הגדרות** | וידאו, צ'אט, אישורים | settings object |
| **סטטיסטיקות** | צפיות, משתמשים, פעילות | אנליטיקס מה-Relay |
| **הודעות** | שליחה לכל הקבוצה | broadcast event |

### 3.3 קוד - GroupAdminPanel.js

```javascript
// מבנה בסיסי של לוח בקרה למנהל קבוצה
const GroupAdminPanel = {
  
  // אתחול
  async init(groupId, adminPubkey) {
    this.groupId = groupId;
    this.adminPubkey = adminPubkey;
    this.config = await this.loadGroupConfig();
    this.members = await this.loadMembers();
  },
  
  // טעינת הגדרות הקבוצה
  async loadGroupConfig() {
    const stored = localStorage.getItem(`group_config_${this.groupId}`);
    return stored ? JSON.parse(stored) : DEFAULT_GROUP_CONFIG;
  },
  
  // טעינת חברי הקבוצה
  async loadMembers() {
    // שליפת כל המשתמשים עם sos_group = groupId
    const filter = {
      kinds: [0],
      limit: 10000
    };
    const events = await App.pool.querySync(App.relayUrls, filter);
    return events.filter(e => {
      try {
        const meta = JSON.parse(e.content);
        return meta.sos_group === this.groupId;
      } catch { return false; }
    });
  },
  
  // חסימת משתמש
  async blockUser(pubkey) {
    const blocklist = this.config.blocklist || [];
    if (!blocklist.includes(pubkey)) {
      blocklist.push(pubkey);
      this.config.blocklist = blocklist;
      await this.saveConfig();
    }
  },
  
  // מחיקת פוסט (שליחת delete event)
  async deletePost(eventId) {
    const deleteEvent = {
      kind: 5,
      pubkey: this.adminPubkey,
      tags: [
        ['e', eventId],
        ['t', this.groupId]
      ],
      content: 'Deleted by group admin',
      created_at: Math.floor(Date.now() / 1000)
    };
    await App.pool.publish(App.relayUrls, App.finalizeEvent(deleteEvent));
  },
  
  // עדכון עיצוב
  async updateDesign(design) {
    this.config.design = { ...this.config.design, ...design };
    await this.saveConfig();
  },
  
  // שמירת הגדרות
  async saveConfig() {
    localStorage.setItem(`group_config_${this.groupId}`, JSON.stringify(this.config));
    // אפשר גם לשמור ב-Nostr כ-replaceable event
  },
  
  // שליחת הודעה לכל הקבוצה
  async broadcastToGroup(message) {
    const event = {
      kind: 1,
      pubkey: this.adminPubkey,
      tags: [
        ['t', 'sos'],
        ['t', this.groupId],
        ['t', 'announcement']
      ],
      content: `📢 ${message}`,
      created_at: Math.floor(Date.now() / 1000)
    };
    await App.pool.publish(App.relayUrls, App.finalizeEvent(event));
  },
  
  // סטטיסטיקות
  async getStats() {
    return {
      totalMembers: this.members.length,
      activeToday: await this.countActiveToday(),
      postsToday: await this.countPostsToday(),
      videosWatched: await this.getVideoViews()
    };
  }
};
```

---

## 4. מערכת בקרה לבעל הרשת

### 4.1 לוח בקרה ראשי - Master Control Panel

```
┌─────────────────────────────────────────────────────────────────┐
│  👑 SOS MASTER CONTROL                                [Admin]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  📊 סה"כ ברשת                                              ││
│  │  ═══════════════════════════════════════════════════════   ││
│  │  קבוצות: 15    משתמשים: 45,678    פוסטים: 1.2M            ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 📂 קבוצות פעילות                                          │  │
│  │ ┌─────────────────────────────────────────────────────────┤  │
│  │ │ שם          │ משתמשים │ פעילות │ סטטוס │ פעולות       │  │
│  │ ├─────────────────────────────────────────────────────────┤  │
│  │ │ רשת א       │ 12,345  │ 89%    │ ✅    │ [צפה] [ערוך] │  │
│  │ │ רשת ב       │ 8,901   │ 76%    │ ✅    │ [צפה] [ערוך] │  │
│  │ │ רשת ג       │ 5,432   │ 45%    │ ⚠️    │ [צפה] [ערוך] │  │
│  │ └─────────────────────────────────────────────────────────┤  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 📢 שיווק לכל הרשת                                         │  │
│  │ ┌─────────────────────────────────────────────────────────┤  │
│  │ │ [שלח הודעה לכל הקבוצות]  [פרסם פוסט גלובלי]            │  │
│  │ └─────────────────────────────────────────────────────────┤  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ⚙️ הגדרות גלובליות                                        │  │
│  │ ├── Relay Status: ✅ Online                               │  │
│  │ ├── Push Server: ✅ Active                                │  │
│  │ └── Storage: 45GB / 100GB                                 │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 יכולות בעל הרשת

| פעולה | תיאור | מימוש |
|-------|-------|-------|
| **צפייה בכל הקבוצות** | רשימת קבוצות + סטטיסטיקות | query all groups |
| **יצירת קבוצה חדשה** | הוספת קבוצה לרשת | new group config |
| **השעיית קבוצה** | חסימת קבוצה בעייתית | blocklist |
| **פרסום גלובלי** | פוסט שמופיע בכל הקבוצות | global tag |
| **שיווק** | שליחת הודעות לכל המשתמשים | broadcast |
| **ניהול Relay** | צפייה בסטטוס, ניקוי | relay admin |
| **אנליטיקס** | סטטיסטיקות כלל-רשתיות | aggregated stats |

### 4.3 קוד - MasterControlPanel.js

```javascript
// מבנה בסיסי של לוח בקרה ראשי
const MasterControlPanel = {
  
  // אתחול
  async init(masterPubkey) {
    this.masterPubkey = masterPubkey;
    this.groups = await this.loadAllGroups();
    this.stats = await this.loadGlobalStats();
  },
  
  // טעינת כל הקבוצות
  async loadAllGroups() {
    // קריאה מקובץ config או מ-Nostr
    const groupsConfig = await fetch('./groups-registry.json').then(r => r.json());
    return groupsConfig.groups || [];
  },
  
  // סטטיסטיקות גלובליות
  async loadGlobalStats() {
    let totalUsers = 0;
    let totalPosts = 0;
    
    for (const group of this.groups) {
      const stats = await this.getGroupStats(group.id);
      totalUsers += stats.members;
      totalPosts += stats.posts;
    }
    
    return { totalUsers, totalPosts, totalGroups: this.groups.length };
  },
  
  // יצירת קבוצה חדשה
  async createGroup(config) {
    const newGroup = {
      id: `group-${Date.now()}`,
      name: config.name,
      admin_pubkey: config.adminPubkey,
      logo: config.logo || '',
      colors: config.colors || DEFAULT_COLORS,
      domain: config.domain || null,
      created_at: Math.floor(Date.now() / 1000),
      created_by: this.masterPubkey,
      settings: {
        allow_videos: true,
        allow_chat: true,
        require_approval: false
      }
    };
    
    this.groups.push(newGroup);
    await this.saveGroupsRegistry();
    return newGroup;
  },
  
  // השעיית קבוצה
  async suspendGroup(groupId, reason) {
    const group = this.groups.find(g => g.id === groupId);
    if (group) {
      group.suspended = true;
      group.suspended_at = Date.now();
      group.suspend_reason = reason;
      await this.saveGroupsRegistry();
    }
  },
  
  // פרסום גלובלי - מופיע בכל הקבוצות
  async publishGlobalPost(content, options = {}) {
    const event = {
      kind: 1,
      pubkey: this.masterPubkey,
      tags: [
        ['t', 'sos'],
        ['t', 'sos-global'],        // tag מיוחד לפוסטים גלובליים
        ['t', 'sos-announcement'],
        ...this.groups.map(g => ['t', g.id])  // מופיע בכל הקבוצות
      ],
      content: options.pin ? `📌 ${content}` : content,
      created_at: Math.floor(Date.now() / 1000)
    };
    
    if (options.pin) {
      event.tags.push(['pinned', 'true']);
    }
    
    await App.pool.publish(App.relayUrls, App.finalizeEvent(event));
    console.log('[MASTER] Global post published to all groups');
  },
  
  // שליחת Push לכל המשתמשים ברשת
  async sendGlobalPush(title, body) {
    // קריאה ל-Push server לשליחה לכולם
    await fetch('https://sos-push-server.vercel.app/api/push/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        masterKey: this.masterPubkey,
        payload: { title, body, type: 'global-announcement' }
      })
    });
  },
  
  // קבלת רשימת כל המשתמשים ברשת
  async getAllUsers() {
    const allUsers = new Map();
    
    for (const group of this.groups) {
      const filter = { kinds: [0], limit: 50000 };
      const events = await App.pool.querySync(App.relayUrls, filter);
      
      events.forEach(e => {
        try {
          const meta = JSON.parse(e.content);
          if (meta.sos_group === group.id) {
            allUsers.set(e.pubkey, { 
              pubkey: e.pubkey, 
              name: meta.name,
              group: group.id,
              joinedAt: e.created_at
            });
          }
        } catch {}
      });
    }
    
    return Array.from(allUsers.values());
  },
  
  // שמירת רישום הקבוצות
  async saveGroupsRegistry() {
    // בפרודקשן - לשמור בשרת או ב-Nostr
    localStorage.setItem('sos_groups_registry', JSON.stringify({
      groups: this.groups,
      updated_at: Date.now()
    }));
  }
};
```

---

## 5. יישום טכני

### 5.1 מבנה הקבצים

```
SOS/
├── index.html              # דף ראשי
├── videos.html             # פיד וידאו
├── config.js               # הגדרות כלליות
├── app.js                  # לוגיקה ראשית
│
├── groups/                 # תיקייה לקבוצות
│   ├── registry.json       # רישום כל הקבוצות
│   ├── group-a/
│   │   ├── config.json     # הגדרות קבוצה א
│   │   └── assets/         # לוגו, תמונות
│   └── group-b/
│       ├── config.json
│       └── assets/
│
├── admin/                  # לוחות בקרה
│   ├── master-panel.html   # בקרה ראשית
│   ├── master-panel.js
│   ├── group-panel.html    # בקרה לקבוצה
│   └── group-panel.js
│
└── docs/
    └── WHITE-LABEL-BUSINESS-MODEL.md  # המסמך הזה
```

### 5.2 קובץ registry.json

```json
{
  "version": "1.0.0",
  "master_pubkey": "YOUR_MASTER_PUBKEY",
  "relay_url": "wss://your-relay.com",
  "push_server": "https://sos-push-server.vercel.app",
  "groups": [
    {
      "id": "sos-main",
      "name": "SOS - הרשת הראשית",
      "tag": "sos",
      "domain": "sos-app.com",
      "is_master": true
    },
    {
      "id": "group-a",
      "name": "רשת חברתית א",
      "tag": "group-a",
      "domain": "social-a.com",
      "admin_pubkey": "...",
      "logo": "https://...",
      "colors": {
        "primary": "#FF5722"
      }
    }
  ]
}
```

### 5.3 זיהוי קבוצה בטעינת האפליקציה

```javascript
// בתחילת app.js או config.js

async function detectCurrentGroup() {
  // אפשרות 1: לפי דומיין
  const domain = window.location.hostname;
  
  // אפשרות 2: לפי query param
  const urlParams = new URLSearchParams(window.location.search);
  const groupParam = urlParams.get('group');
  
  // אפשרות 3: לפי config.json מקומי
  const localConfig = await fetch('./config.json').then(r => r.json()).catch(() => null);
  
  // טעינת רישום הקבוצות
  const registry = await fetch('./groups/registry.json').then(r => r.json());
  
  // חיפוש הקבוצה המתאימה
  let currentGroup = registry.groups.find(g => g.domain === domain);
  if (!currentGroup && groupParam) {
    currentGroup = registry.groups.find(g => g.id === groupParam);
  }
  if (!currentGroup && localConfig?.groupId) {
    currentGroup = registry.groups.find(g => g.id === localConfig.groupId);
  }
  if (!currentGroup) {
    currentGroup = registry.groups.find(g => g.is_master);
  }
  
  // החלת הגדרות הקבוצה
  App.currentGroup = currentGroup;
  App.NETWORK_TAG = currentGroup.tag;
  
  // החלת עיצוב
  if (currentGroup.colors) {
    document.documentElement.style.setProperty('--primary-color', currentGroup.colors.primary);
  }
  if (currentGroup.logo) {
    document.querySelector('.app-logo')?.setAttribute('src', currentGroup.logo);
  }
  if (currentGroup.name) {
    document.title = currentGroup.name;
  }
  
  return currentGroup;
}

// קריאה בטעינה
detectCurrentGroup().then(group => {
  console.log(`[SOS] Running as: ${group.name} (${group.id})`);
});
```

### 5.4 סינון פוסטים לפי קבוצה

```javascript
// בפונקציית טעינת הפיד

function getGroupFilter() {
  const group = App.currentGroup;
  
  return {
    kinds: [1, 6],  // פוסטים ושיתופים
    '#t': [group.tag, 'sos-global'],  // פוסטים של הקבוצה + פוסטים גלובליים
    limit: 100
  };
}

// בהאזנה לאירועים
function subscribeToGroupFeed() {
  const filter = getGroupFilter();
  
  App.pool.subscribeMany(App.relayUrls, [filter], {
    onevent: (event) => {
      // בדיקה שהמפרסם לא חסום
      if (isUserBlocked(event.pubkey)) return;
      
      // הוספה לפיד
      addPostToFeed(event);
    }
  });
}
```

---

## 6. תנאי שימוש מומלצים

### 6.1 עקרונות מרכזיים

```markdown
## תנאי שימוש - SOS Network

### 1. השירות
- השירות ניתן בחינם, ללא התחייבות
- אנו שומרים זכות להפסיק את השירות בכל עת

### 2. תוכן
- זכויות היוצרים על התוכן נשארות אצל היוצר
- בשימוש בשירות, המשתמש מעניק לנו רישיון להציג ולאחסן את התוכן
- אנו רשאים להציג תוכן ממומן/הודעות מערכת

### 3. קבוצות
- מנהלי קבוצות אחראים לתוכן בקבוצתם
- אנו לא אחראים לפעולות של מנהלי קבוצות או משתמשים

### 4. פרטיות
- המפתחות הפרטיים שייכים למשתמש בלבד
- אנו לא שומרים מפתחות פרטיים

### 5. שינויים
- אנו רשאים לעדכן תנאים אלו בכל עת
```

---

## סיכום

### המודל שלך בקצרה:

| אתה נותן | אתה מקבל |
|----------|----------|
| פלטפורמה בחינם | ערך כלכלי |
| חופש למנהלי קבוצות | גישה לשיווק |
| אין התחייבות | נכס למכירה |
| אין אחריות לתוכן | שליטה טכנית |

### יתרונות:

- ✅ **פשוט טכנית** - רק tags שונים
- ✅ **אין עלויות נוספות** - אותו קוד, אותה תשתית
- ✅ **סקיילבילי** - אין הגבלה על מספר קבוצות
- ✅ **משפטית בטוח** - אין התחייבויות, אין אחריות לתוכן
- ✅ **ערך כלכלי** - ככל שיש יותר משתמשים = שווה יותר

---

*מסמך זה נוצר עבור SOS Network - HYPER CORE TECH*
