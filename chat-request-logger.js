// chat-request-logger.js
// חלק לוגר פניות (chat-request-logger.js) — מעקב מלא אחר כל פנייה לשרתי Relay, Blossom, Cache, P2P
// כולל זיהוי בזבוזים, כפילויות, וניתוח ביצועים. שומר ב-localStorage לדשבורד transfer-monitor.html | HYPER CORE TECH
(function initRequestLogger(window) {
  'use strict';
  const App = window.NostrApp || (window.NostrApp = {});
  const STORAGE_KEY = 'sos_request_log';
  const MAX_ENTRIES = 1200;
  const SESSION_START = Date.now();

  // חלק מאגר (chat-request-logger.js) — מערך אירועים + מוני סיכום + מעקב בזבוזים | HYPER CORE TECH
  let entries = [];
  let counters = {
    // --- relay צ'אט ---
    'relay-sub':0,'relay-pub':0,'relay-resub':0,'relay-profile':0,'relay-sync':0,
    // --- relay פיד/רשת חברתית ---
    'feed-list':0,'feed-sub':0,'feed-like-sub':0,'feed-comment-sub':0,
    'feed-post-pub':0,'feed-like-pub':0,'feed-comment-pub':0,'feed-share-pub':0,'feed-delete-pub':0,
    // --- blossom ---
    'blossom-fetch':0,'blossom-upload':0,
    // --- cache ---
    'cache-hit-media':0,'cache-hit-avatar':0,'cache-hit-profile':0,'cache-hit-video':0,
    // --- P2P ---
    'p2p-send':0,'p2p-receive':0,'p2p-heartbeat':0,'p2p-signal-sub':0,
    // --- בזבוזים ---
    'waste-dup-profile':0,'waste-read-receipt-flood':0,'waste-heartbeat-excess':0,'waste-double-like-fetch':0,
    // --- אחר ---
    'avatar-fetch':0,'deletion-recv':0
  };

  // חלק מעקב כפילויות (chat-request-logger.js) — רישום פניות אחרונות לזיהוי בזבוז | HYPER CORE TECH
  const recentProfileFetches = new Map(); // pubkey -> { ts, count }
  const PROFILE_DUP_WINDOW_MS = 10000; // חלון 10 שניות לזיהוי כפילות
  let readReceiptCountThisSession = 0;
  let lastHeartbeatTs = 0;
  let heartbeatCountThisMinute = 0;
  let heartbeatMinuteStart = Date.now();

  // חלק localStorage (chat-request-logger.js) — טעינה ושמירה | HYPER CORE TECH
  function load() {
    try { const d = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (d) { entries = d.entries||[]; Object.assign(counters, d.counters||{}); } } catch { entries=[]; }
  }
  function save() {
    try {
      if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        entries, counters, sessionStart: SESSION_START, lastUpdate: Date.now(),
        waste: getWasteSummary()
      }));
    } catch {}
  }
  load();

  // חלק רישום (chat-request-logger.js) — רישום פנייה בודדת + לוג קונסול צבעוני | HYPER CORE TECH
  const COLORS = {
    'relay-sub':'#90a4ae','relay-pub':'#90a4ae','relay-resub':'#ffab40','relay-profile':'#ce93d8',
    'relay-sync':'#ef5350',
    'feed-list':'#ffcc80','feed-sub':'#ffcc80','feed-like-sub':'#ffcc80','feed-comment-sub':'#ffcc80',
    'feed-post-pub':'#ff9800','feed-like-pub':'#ff9800','feed-comment-pub':'#ff9800',
    'feed-share-pub':'#ff9800','feed-delete-pub':'#ff9800',
    'blossom-fetch':'#42a5f5','blossom-upload':'#42a5f5',
    'cache-hit-media':'#66bb6a','cache-hit-avatar':'#66bb6a','cache-hit-profile':'#66bb6a','cache-hit-video':'#66bb6a',
    'p2p-send':'#00e676','p2p-receive':'#00e676','p2p-heartbeat':'#76ff03','p2p-signal-sub':'#76ff03',
    'waste-dup-profile':'#f44336','waste-read-receipt-flood':'#f44336',
    'waste-heartbeat-excess':'#f44336','waste-double-like-fetch':'#f44336',
    'avatar-fetch':'#ce93d8','deletion-recv':'#e91e63'
  };
  function logReq(cat, details) {
    entries.push({ ts:Date.now(), cat, d:details||{} });
    counters[cat] = (counters[cat]||0) + 1;
    const isWaste = cat.startsWith('waste-');
    const prefix = isWaste ? '⚠️ [WASTE]' : '[REQ-LOG]';
    console.log('%c'+prefix+' '+cat, 'color:'+(COLORS[cat]||'#fff')+';font-weight:bold', details||'');
    save();
  }

  // חלק סיכום בזבוזים (chat-request-logger.js) — חישוב מטריקות בזבוז לדשבורד | HYPER CORE TECH
  function getWasteSummary() {
    const totalRelay = (counters['relay-sub']||0)+(counters['relay-pub']||0)+(counters['relay-resub']||0)+
      (counters['relay-profile']||0)+(counters['relay-sync']||0)+
      (counters['feed-list']||0)+(counters['feed-sub']||0)+(counters['feed-like-sub']||0)+
      (counters['feed-comment-sub']||0)+(counters['feed-post-pub']||0)+(counters['feed-like-pub']||0)+
      (counters['feed-comment-pub']||0)+(counters['feed-share-pub']||0)+(counters['feed-delete-pub']||0);
    const totalWaste = (counters['waste-dup-profile']||0)+(counters['waste-read-receipt-flood']||0)+
      (counters['waste-heartbeat-excess']||0)+(counters['waste-double-like-fetch']||0);
    const totalCache = (counters['cache-hit-media']||0)+(counters['cache-hit-avatar']||0)+
      (counters['cache-hit-profile']||0)+(counters['cache-hit-video']||0);
    const totalP2P = (counters['p2p-send']||0)+(counters['p2p-receive']||0);
    const totalBlossom = (counters['blossom-fetch']||0)+(counters['blossom-upload']||0);
    const totalAll = totalRelay + totalBlossom + totalCache + totalP2P;
    return {
      totalRelay, totalBlossom, totalCache, totalP2P, totalAll, totalWaste,
      wastePct: totalAll ? Math.round(totalWaste/totalAll*100) : 0,
      savedPct: totalAll ? Math.round((totalCache+totalP2P)/totalAll*100) : 0,
      dupProfiles: counters['waste-dup-profile']||0,
      readReceiptFlood: readReceiptCountThisSession,
      heartbeatExcess: counters['waste-heartbeat-excess']||0
    };
  }

  // חלק hooks (chat-request-logger.js) — עטיפת כל הפונקציות בממשק | HYPER CORE TECH
  function hookAll() {
    hookPool();
    hookPoolList();
    hookProfile();
    hookSyncHistory();
    hookBlossomMedia();
    hookBlossomUpload();
    hookAvatarFetch();
    hookP2P();
    hookReadReceipt();
    hookDeleteMessage();
    hookVisibility();
    hookFeedActions();
    console.log('%c[REQ-LOG] ✅ מעקב פניות פעיל (v2 — כולל פיד + זיהוי בזבוזים)','color:#00e676;font-weight:bold');
  }

  // חלק hook pool.publish (chat-request-logger.js) — קטגוריזציה חכמה לפי kind | HYPER CORE TECH
  function hookPool() {
    const wait = setInterval(() => {
      if (!App.pool) return;
      clearInterval(wait);
      if (typeof App.pool.publish === 'function') {
        const orig = App.pool.publish;
        App.pool.publish = function(relays, event) {
          const k = event?.kind;
          const nRelays = Array.isArray(relays)?relays.length:0;
          const id12 = event?.id?.slice(0,12);
          // קטגוריזציה חכמה לפי kind
          if (k === 1050) {
            logReq('relay-pub', {action:'chat-message', kind:k, relays:nRelays, id:id12});
          } else if (k === 5) {
            // מחיקה — בדיקה אם פיד או צ'אט לפי תגיות
            const hasFeedTag = event?.tags?.some(t => t[0]==='t');
            logReq(hasFeedTag ? 'feed-delete-pub' : 'relay-pub', {action:'delete', kind:k, relays:nRelays, id:id12});
          } else if (k === 1051) {
            logReq('relay-pub', {action:'read-receipt', kind:k, relays:nRelays, id:id12});
          } else if (k === 30078) {
            // חלק kind-30078 (chat-request-logger.js) — סיווג מדויק: heartbeat אמיתי מול סיגנלים/אירועי P2P אחרים | HYPER CORE TECH
            const tTag = event?.tags?.find?.((t) => Array.isArray(t) && t[0] === 't');
            const appTag = event?.tags?.find?.((t) => Array.isArray(t) && t[0] === 'app');
            const tValue = tTag?.[1] || '';
            const appValue = appTag?.[1] || '';
            if (tValue === 'p2p-heartbeat') {
              trackHeartbeat(nRelays, id12);
            } else {
              logReq('relay-pub', {
                action: 'kind-30078-signal',
                kind: k,
                relays: nRelays,
                id: id12,
                t: tValue || undefined,
                app: appValue || undefined,
              });
            }
          } else if (k === 7) {
            logReq('feed-like-pub', {action:'like', kind:k, relays:nRelays, id:id12});
          } else if (k === 6) {
            logReq('feed-share-pub', {action:'share', kind:k, relays:nRelays, id:id12});
          } else if (k === 1) {
            // פוסט או תגובה — בדיקה אם reply
            const isReply = event?.tags?.some(t => t[0]==='e');
            logReq(isReply ? 'feed-comment-pub' : 'feed-post-pub', {action:isReply?'comment':'post', kind:k, relays:nRelays, id:id12});
          } else if (k === 24242) {
            logReq('blossom-upload', {action:'auth-event', kind:k, relays:nRelays, id:id12});
          } else {
            logReq('relay-pub', {action:'kind-'+k, kind:k, relays:nRelays, id:id12});
          }
          return orig.apply(this, arguments);
        };
      }
      // pool.subscribeMany — קטגוריזציה לפי kinds בפילטר
      if (typeof App.pool.subscribeMany === 'function') {
        const orig = App.pool.subscribeMany;
        App.pool.subscribeMany = function(relays, filters, opts) {
          const kinds = (filters||[]).flatMap(f=>f.kinds||[]);
          const nRelays = Array.isArray(relays)?relays.length:0;
          const nFilters = filters?.length||0;
          // קטגוריזציה חכמה
          const hasLikes = kinds.includes(7);
          const hasComments = kinds.includes(1) && (filters||[]).some(f => f['#e']);
          const hasFeedTag = (filters||[]).some(f => f['#t']);
          const hasChatKinds = kinds.includes(1050) || kinds.includes(1051);
          const hasP2PSignal = kinds.includes(30078);
          if (hasP2PSignal && !hasChatKinds) {
            logReq('p2p-signal-sub', {relays:nRelays, filters:nFilters, kinds});
          } else if (hasChatKinds) {
            logReq('relay-sub', {action:'chat-subscribe', relays:nRelays, filters:nFilters, kinds});
          } else if (hasLikes && !hasFeedTag) {
            logReq('feed-like-sub', {relays:nRelays, filters:nFilters, kinds, postCount:((filters||[])[0]?.['#e']||[]).length});
          } else if (hasComments) {
            logReq('feed-comment-sub', {relays:nRelays, filters:nFilters, kinds});
          } else if (hasFeedTag) {
            logReq('feed-sub', {relays:nRelays, filters:nFilters, kinds});
          } else {
            logReq('relay-sub', {action:'subscribeMany', relays:nRelays, filters:nFilters, kinds});
          }
          return orig.apply(this, arguments);
        };
      }
    }, 500);
  }

  // חלק hook pool.list (chat-request-logger.js) — מעקב שליפת רשימה חד-פעמית | HYPER CORE TECH
  function hookPoolList() {
    const wait = setInterval(() => {
      if (!App.pool) return;
      clearInterval(wait);
      ['list','listMany'].forEach(fn => {
        if (typeof App.pool[fn] !== 'function') return;
        const orig = App.pool[fn];
        App.pool[fn] = function(relays, filters) {
          const kinds = (filters||[]).flatMap(f=>f.kinds||[]);
          const nRelays = Array.isArray(relays)?relays.length:0;
          const hasLikes = kinds.includes(7);
          if (hasLikes) {
            logReq('feed-like-sub', {action:fn+'-prefetch', relays:nRelays, kinds, note:'שליפה חד-פעמית'});
          } else {
            logReq('feed-list', {action:fn, relays:nRelays, filters:filters?.length||0, kinds});
          }
          return orig.apply(this, arguments);
        };
      });
    }, 500);
  }

  // חלק hook profile (chat-request-logger.js) — מעקב + זיהוי כפילויות פרופיל | HYPER CORE TECH
  function hookProfile() {
    const orig = App.fetchProfile;
    if (typeof orig !== 'function') return;
    App.fetchProfile = async function(pubkey) {
      const pk12 = pubkey?.slice(0,12);
      const now = Date.now();
      // זיהוי כפילות — אם אותו pubkey נקרא ב-10 שניות אחרונות
      const recent = recentProfileFetches.get(pk12);
      if (recent && (now - recent.ts) < PROFILE_DUP_WINDOW_MS) {
        recent.count++;
        logReq('waste-dup-profile', {pubkey:pk12, timesInWindow:recent.count, windowMs:PROFILE_DUP_WINDOW_MS});
      } else {
        recentProfileFetches.set(pk12, {ts:now, count:1});
      }
      // ניקוי ערכים ישנים
      if (recentProfileFetches.size > 100) {
        for (const [k,v] of recentProfileFetches) { if (now - v.ts > 30000) recentProfileFetches.delete(k); }
      }
      logReq('relay-profile', {pubkey:pk12});
      return orig.apply(this, arguments);
    };
  }

  // חלק hook sync (chat-request-logger.js) — מעקב סנכרון היסטוריה מלא | HYPER CORE TECH
  function hookSyncHistory() {
    const orig = App.syncChatHistory;
    if (typeof orig !== 'function') return;
    App.syncChatHistory = async function() {
      logReq('relay-sync', {action:'full-history-sync'});
      return orig.apply(this, arguments);
    };
  }

  // חלק hook blossom media (chat-request-logger.js) — מעקב הורדת מדיה vs cache hit | HYPER CORE TECH
  function hookBlossomMedia() {
    const origFetch = App.fetchAndCacheChatMedia;
    if (typeof origFetch === 'function') {
      App.fetchAndCacheChatMedia = async function(url) {
        const cached = typeof App.getChatMediaFromCache === 'function' ? await App.getChatMediaFromCache(url) : null;
        if (cached) {
          logReq('cache-hit-media', {url:url?.slice(0,60)});
          return URL.createObjectURL(cached);
        }
        logReq('blossom-fetch', {url:url?.slice(0,60)});
        return origFetch.apply(this, arguments);
      };
    }
  }

  // חלק hook blossom upload (chat-request-logger.js) — מעקב העלאה ל-Blossom | HYPER CORE TECH
  function hookBlossomUpload() {
    const origUpload = App.uploadToBlossom;
    if (typeof origUpload === 'function') {
      App.uploadToBlossom = async function(blob) {
        const sizeMB = blob?.size ? (blob.size/1024/1024).toFixed(2) : '?';
        logReq('blossom-upload', {action:'upload', sizeMB, type:blob?.type||'?'});
        return origUpload.apply(this, arguments);
      };
    }
  }

  // חלק hook avatar (chat-request-logger.js) — מעקב cache hits של אווטרים ב-localStorage | HYPER CORE TECH
  function hookAvatarFetch() {
    const origGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      const val = origGetItem.call(this, key);
      if (key && key.startsWith('avatar_cache_') && val) {
        try {
          const p = JSON.parse(val);
          if (p?.dataUrl && p?.ts) {
            const age = Math.floor(Date.now()/1000) - p.ts;
            if (age < 86400) { logReq('cache-hit-avatar', {key:key.slice(0,30), ageSec:age}); }
          }
        } catch {}
      }
      return val;
    };
  }

  // חלק hook P2P (chat-request-logger.js) — מעקב הודעות/קבצים ישירים | HYPER CORE TECH
  function hookP2P() {
    const waitDC = setInterval(() => {
      if (!App.dataChannel || typeof App.dataChannel.send !== 'function') return;
      clearInterval(waitDC);
      const origSend = App.dataChannel.send;
      App.dataChannel.send = function(peer, msg) {
        logReq('p2p-send', {peer:peer?.slice(0,12), hasAttachment:!!msg?.attachment});
        return origSend.apply(this, arguments);
      };
    }, 1000);

    // חלק קבלת הודעות DC (chat-request-logger.js) — hook מודרני ל-incoming ב-DataChannel החדש | HYPER CORE TECH
    const waitRecv = setInterval(() => {
      if (!App.dataChannel) return;

      if (typeof App.dataChannel.subscribeIncomingMessages === 'function') {
        clearInterval(waitRecv);
        App.dataChannel.subscribeIncomingMessages((peer, msg) => {
          logReq('p2p-receive', {
            peer: peer?.slice(0, 12),
            hasAttachment: !!msg?.attachment,
          });
        });
        return;
      }

      // fallback ל-API ישן אם קיים
      const origHandler = App.dataChannel.onMessage || App.dataChannel._onMessage;
      if (typeof origHandler !== 'function') return;
      clearInterval(waitRecv);
      const handlerKey = App.dataChannel.onMessage ? 'onMessage' : '_onMessage';
      App.dataChannel[handlerKey] = function(peer, data) {
        logReq('p2p-receive', {peer:peer?.slice(0,12)});
        return origHandler.apply(this, arguments);
      };
    }, 1000);

    // חלק קבצים P2P (chat-request-logger.js) — ספירת שליחה/קבלה אמיתית לפי chunk ראשון (sending/receiving) | HYPER CORE TECH
    const waitFileP2P = setInterval(() => {
      if (typeof App.subscribeP2PFileProgress !== 'function') return;
      clearInterval(waitFileP2P);

      const countedFileTransfers = new Set();
      App.subscribeP2PFileProgress((payload) => {
        const fileId = typeof payload?.fileId === 'string' ? payload.fileId : '';
        const direction = payload?.direction === 'send' || payload?.direction === 'receive' ? payload.direction : '';
        const status = typeof payload?.status === 'string' ? payload.status : '';
        const isP2PSend = direction === 'send' && status === 'sending';
        const isP2PReceive = direction === 'receive' && status === 'receiving';
        if (!fileId || (!isP2PSend && !isP2PReceive)) {
          return;
        }

        const dedupKey = `${fileId}:${direction}`;
        if (countedFileTransfers.has(dedupKey)) {
          return;
        }
        countedFileTransfers.add(dedupKey);
        if (countedFileTransfers.size > 600) {
          const staleKeys = Array.from(countedFileTransfers).slice(0, 200);
          staleKeys.forEach((key) => countedFileTransfers.delete(key));
        }

        const peerShort = typeof payload?.peerPubkey === 'string' ? payload.peerPubkey.slice(0, 12) : undefined;
        logReq(isP2PSend ? 'p2p-send' : 'p2p-receive', {
          peer: peerShort,
          hasAttachment: true,
          via: 'file-transfer-dc',
          fileId: fileId.slice(0, 12),
          name: payload?.name,
          size: payload?.size,
        });
      });
    }, 1000);
  }

  // חלק hook heartbeat (chat-request-logger.js) — מעקב תדירות heartbeat וזיהוי עודף | HYPER CORE TECH
  // dedup לפי event ID — אותו heartbeat נשלח ל-N relays אבל נספר פעם אחת בלבד
  let _lastHBEventId = '';
  function trackHeartbeat(nRelays, id12) {
    // אם אותו event ID כבר נספר (שליחה ל-relay נוסף), דלג
    if (id12 && id12 === _lastHBEventId) return;
    _lastHBEventId = id12 || '';
    const now = Date.now();
    // איפוס מונה דקה
    if (now - heartbeatMinuteStart > 60000) { heartbeatCountThisMinute = 0; heartbeatMinuteStart = now; }
    heartbeatCountThisMinute++;
    const interval = lastHeartbeatTs ? Math.round((now - lastHeartbeatTs)/1000) : 0;
    lastHeartbeatTs = now;
    logReq('p2p-heartbeat', {relays:nRelays, id:id12, intervalSec:interval, countThisMin:heartbeatCountThisMinute});
    // זיהוי עודף: יותר מ-4 heartbeats בדקה = בזבוז (1 לדקה רגיל, עד 4 עם focus/visibility)
    if (heartbeatCountThisMinute > 4) {
      logReq('waste-heartbeat-excess', {countThisMin:heartbeatCountThisMinute, note:'יותר מ-4 heartbeats/דקה'});
    }
  }

  // חלק hook read-receipt (chat-request-logger.js) — מעקב + זיהוי שטפון read receipts | HYPER CORE TECH
  function hookReadReceipt() {
    const orig = App.sendReadReceipt;
    if (typeof orig !== 'function') return;
    App.sendReadReceipt = async function(peer, ts) {
      logReq('relay-pub', {action:'read-receipt', peer:peer?.slice(0,12)});
      return orig.apply(this, arguments);
    };
    // מעקב קבלת read receipts — hook ב-handleIncomingReadReceipt
    const origHandler = App.handleIncomingReadReceipt;
    if (typeof origHandler === 'function') {
      App.handleIncomingReadReceipt = function() {
        readReceiptCountThisSession++;
        if (readReceiptCountThisSession > 20 && readReceiptCountThisSession % 10 === 0) {
          logReq('waste-read-receipt-flood', {total:readReceiptCountThisSession, note:'עודף read receipts מריליי'});
        }
        return origHandler.apply(this, arguments);
      };
    }
  }

  // חלק hook delete (chat-request-logger.js) — מעקב מחיקת הודעות צ'אט | HYPER CORE TECH
  function hookDeleteMessage() {
    const orig = App.deleteChatMessage;
    if (typeof orig !== 'function') return;
    App.deleteChatMessage = async function(peer, msgId) {
      logReq('relay-pub', {action:'delete-message', peer:peer?.slice(0,12), msgId:msgId?.slice(0,12)});
      return orig.apply(this, arguments);
    };
  }

  // חלק hook visibility (chat-request-logger.js) — מעקב resubscribe עקב visibility/online | HYPER CORE TECH
  function hookVisibility() {
    let lastLog = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastLog < 5000) return;
      lastLog = now;
      logReq('relay-resub', {reason:'visibility-change'});
    });
    window.addEventListener('online', () => logReq('relay-resub', {reason:'network-online'}));
  }

  // חלק hook feed (chat-request-logger.js) — מעקב פעולות רשת חברתית: loadFeed, cache video | HYPER CORE TECH
  function hookFeedActions() {
    // מעקב cache-hit-video — כשנטען וידאו מ-cache
    const origLoadVideo = App.loadVideoWithCache;
    if (typeof origLoadVideo === 'function') {
      App.loadVideoWithCache = async function(videoEl, url, hash, mirrors) {
        const result = await origLoadVideo.apply(this, arguments);
        if (result?.source === 'cache') {
          logReq('cache-hit-video', {hash:hash?.slice(0,12), sizeMB:result.blob?.size?(result.blob.size/1024/1024).toFixed(1):'?'});
        }
        return result;
      };
    }
    // מעקב deletion events שמתקבלים — hook ב-registerDeletion אם קיים
    if (typeof App.registerDeletion === 'function') {
      const origDel = App.registerDeletion;
      App.registerDeletion = function(event) {
        logReq('deletion-recv', {id:event?.id?.slice(0,12), from:event?.pubkey?.slice(0,12)});
        return origDel.apply(this, arguments);
      };
    }
  }

  // חלק אתחול (chat-request-logger.js) — הפעלה אחרי טעינת כל המודולים | HYPER CORE TECH
  function init() {
    logReq('relay-sub', {action:'app-startup', note:'session started (v2)'});
    setTimeout(hookAll, 1200);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 400));
  else setTimeout(init, 400);

  // חלק דוח אבחון (chat-request-logger.js) — ייצור טקסט מופרד ל-2 מערכות שניתן להעתיק | HYPER CORE TECH
  function generateDiagnosticReport() {
    const c = counters;
    const w = getWasteSummary();
    const now = new Date();
    const uptime = Math.round((Date.now() - SESSION_START) / 60000);
    const line = (label, val) => `  ${label}: ${val}`;
    const sep = '\n' + '='.repeat(44) + '\n';
    const secHead = (title) => '\n' + '-'.repeat(40) + '\n  ' + title + '\n' + '-'.repeat(40);

    // --- חלק תקשורת (וואטסאפ) ---
    const chatSub = c['relay-sub']||0;
    const chatPub = c['relay-pub']||0;
    const chatResub = c['relay-resub']||0;
    const chatProfile = c['relay-profile']||0;
    const chatSync = c['relay-sync']||0;
    const chatP2pSend = c['p2p-send']||0;
    const chatP2pRecv = c['p2p-receive']||0;
    const chatHB = c['p2p-heartbeat']||0;
    const chatCacheMedia = c['cache-hit-media']||0;
    const chatCacheAvatar = c['cache-hit-avatar']||0;
    const chatBlossomFetch = c['blossom-fetch']||0;
    const chatBlossomUpload = c['blossom-upload']||0;
    const chatTotalRelay = chatSub + chatPub + chatResub + chatProfile + chatSync;
    const chatTotalP2P = chatP2pSend + chatP2pRecv;
    const chatTotalCache = chatCacheMedia + chatCacheAvatar;
    const chatTotalBlossom = chatBlossomFetch + chatBlossomUpload;
    const chatTotal = chatTotalRelay + chatTotalP2P + chatTotalCache + chatTotalBlossom;
    const chatSavedPct = chatTotal ? Math.round((chatTotalP2P + chatTotalCache) / chatTotal * 100) : 0;
    const chatWaste = (c['waste-dup-profile']||0) + (c['waste-read-receipt-flood']||0) + (c['waste-heartbeat-excess']||0);

    // --- חלק רשת חברתית (טיקטוק) ---
    const feedList = c['feed-list']||0;
    const feedSub = c['feed-sub']||0;
    const feedLikeSub = c['feed-like-sub']||0;
    const feedCommentSub = c['feed-comment-sub']||0;
    const feedPostPub = c['feed-post-pub']||0;
    const feedLikePub = c['feed-like-pub']||0;
    const feedCommentPub = c['feed-comment-pub']||0;
    const feedSharePub = c['feed-share-pub']||0;
    const feedDeletePub = c['feed-delete-pub']||0;
    const feedCacheVideo = c['cache-hit-video']||0;
    const feedDelRecv = c['deletion-recv']||0;
    const feedTotalRelay = feedList + feedSub + feedLikeSub + feedCommentSub + feedPostPub + feedLikePub + feedCommentPub + feedSharePub + feedDeletePub;
    const feedTotal = feedTotalRelay + feedCacheVideo;
    const feedSavedPct = feedTotal ? Math.round(feedCacheVideo / feedTotal * 100) : 0;
    const feedWaste = c['waste-double-like-fetch']||0;

    // --- בניית הדוח ---
    let report = '';
    report += '\u2554' + '\u2550'.repeat(44) + '\u2557\n';
    report += '\u2551  SOS DIAGNOSTIC REPORT                    \u2551\n';
    report += '\u2551  ' + now.toLocaleString('he-IL') + '                  \u2551\n';
    report += '\u255a' + '\u2550'.repeat(44) + '\u255d\n';
    report += line('\u23f1 זמן פעיל', uptime + ' דקות');
    report += '\n' + line('\ud83d\udcca סה"כ פניות', w.totalAll);
    report += '\n' + line('\u26a0\ufe0f סה"כ בזבוזים', w.totalWaste);

    // === דוח תקשורת ===
    report += sep;
    report += '\ud83d\udcf1 מערכת תקשורת (כמו וואטסאפ)';
    report += sep;
    report += line('סה"כ פניות', chatTotal);
    report += '\n' + line('% נחסך (P2P+Cache)', chatSavedPct + '%');
    report += '\n' + line('בזבוזים שזוהו', chatWaste);
    report += secHead('Relay צ\u05f3אט');
    report += '\n' + line('Subscribe', chatSub);
    report += '\n' + line('Publish', chatPub);
    report += '\n' + line('Resubscribe', chatResub);
    report += '\n' + line('Profile fetch', chatProfile);
    report += '\n' + line('Sync history', chatSync);
    report += secHead('P2P ישיר');
    report += '\n' + line('שליחה DC', chatP2pSend);
    report += '\n' + line('קבלה DC', chatP2pRecv);
    report += '\n' + line('Heartbeat', chatHB);
    report += secHead('Cache & Blossom');
    report += '\n' + line('Cache מדיה', chatCacheMedia);
    report += '\n' + line('Cache אווטר', chatCacheAvatar);
    report += '\n' + line('Blossom הורדה', chatBlossomFetch);
    report += '\n' + line('Blossom העלאה', chatBlossomUpload);
    if (chatWaste > 0) {
      report += secHead('\u26a0\ufe0f בזבוזים');
      if (c['waste-dup-profile']||0) report += '\n' + line('\ud83d\udd34 כפילויות פרופיל', c['waste-dup-profile']);
      if (c['waste-read-receipt-flood']||0) report += '\n' + line('\ud83d\udd34 שטפון RR', c['waste-read-receipt-flood']);
      if (c['waste-heartbeat-excess']||0) report += '\n' + line('\ud83d\udfe1 HB עודף', c['waste-heartbeat-excess']);
    }

    // === דוח רשת חברתית ===
    report += sep;
    report += '\ud83c\udfac מערכת רשת חברתית (כמו טיקטוק)';
    report += sep;
    report += line('סה"כ פניות', feedTotal);
    report += '\n' + line('% נחסך (Cache)', feedSavedPct + '%');
    report += '\n' + line('בזבוזים שזוהו', feedWaste);
    report += secHead('Relay פיד');
    report += '\n' + line('טעינת פיד (list)', feedList);
    report += '\n' + line('מנוי פיד (sub)', feedSub);
    report += '\n' + line('מנוי לייקים', feedLikeSub);
    report += '\n' + line('מנוי תגובות', feedCommentSub);
    report += secHead('פרסום');
    report += '\n' + line('פוסט חדש', feedPostPub);
    report += '\n' + line('לייק', feedLikePub);
    report += '\n' + line('תגובה', feedCommentPub);
    report += '\n' + line('שיתוף', feedSharePub);
    report += '\n' + line('מחיקה', feedDeletePub);
    report += secHead('Cache & מחיקות');
    report += '\n' + line('Cache וידאו', feedCacheVideo);
    report += '\n' + line('מחיקות שהתקבלו', feedDelRecv);
    if (feedWaste > 0) {
      report += secHead('\u26a0\ufe0f בזבוזים');
      if (c['waste-double-like-fetch']||0) report += '\n' + line('\ud83d\udfe1 לייקים כפולים', c['waste-double-like-fetch']);
    }

    // === סיכום ===
    report += sep;
    report += '\u2705 סיכום כללי';
    report += sep;
    const totalAll = chatTotal + feedTotal;
    const totalSaved = chatTotalP2P + chatTotalCache + feedCacheVideo;
    const totalSavedPct = totalAll ? Math.round(totalSaved / totalAll * 100) : 0;
    const totalWaste = chatWaste + feedWaste;
    const efficiency = totalAll ? Math.max(0, 100 - (totalWaste / totalAll * 100)).toFixed(0) : 100;
    report += line('ציון יעילות', efficiency + '%');
    report += '\n' + line('נחסך ללא שרת', totalSavedPct + '%');
    report += '\n' + line('סה"כ בזבוזים', totalWaste);
    report += '\n' + line('Hooks פעילים', 'כן \u2705');
    report += '\n\nנוצר ע"י SOS Monitor v2';
    return report;
  }

  // חלק API (chat-request-logger.js) — חשיפה למודולים אחרים ולדשבורד | HYPER CORE TECH
  App.requestLogger = { entries, counters, logReq, getWasteSummary, generateDiagnosticReport };
})(window);
