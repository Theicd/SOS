/**
 * חלק P2P Metadata (p2p-metadata-transfer.js) – העברת מטא-דאטה ב-P2P | HYPER CORE TECH
 * 
 * מודול זה מאפשר העברת מידע על פוסטים (לייקים, תגובות, פרטי יוצר)
 * יחד עם הקובץ ב-P2P, מה שמפחית את העומס על ה-Relays.
 * 
 * גרסה: 1.0.0
 * תאריך: 8 בדצמבר 2025
 */

(function initMetadataTransfer(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // ═══════════════════════════════════════════════════════════════════════════
  // הגדרות
  // ═══════════════════════════════════════════════════════════════════════════
  
  const CONFIG = {
    MAX_RECENT_COMMENTS: 40,       // E: צילום מצב עשיר יותר עם המדיה | HYPER CORE TECH
    MAX_LIKERS: 50,
    MAX_CONTENT_LENGTH: 500,
    MAX_PICTURE_CHARS: 8000,       // לא שולחים data-URL ענק של אווטאר
    // עמוד שדרה דק: metadata מ-P2P נחשב טרי לזמן ארוך יותר – פחות חזרה ל-Relays | HYPER CORE TECH
    METADATA_FRESHNESS: 30 * 60,   // 30 דקות – לא קצב לייקים חיים
    RELAY_REFRESH_DELAY_MS: 45000,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════════════════════════
  
  const state = {
    // metadata שקיבלנו מ-peers
    // hash -> { postMetadata, receivedAt, verified }
    receivedMetadata: new Map(),
    // hash מדיה → eventId של הפוסט (כדי לצרף engagement בהגשה) | HYPER CORE TECH
    hashToEventId: new Map(),
    // eventId → asOf (שניות) – דילוג על משיכת likes כבדה מריליי | HYPER CORE TECH
    engagementFreshUntil: new Map(),
    
    // סטטיסטיקות
    stats: {
      metadataSent: 0,
      metadataReceived: 0,
      metadataApplied: 0,
    },
  };

  function sanitizePicture(pic) {
    if (!pic || typeof pic !== 'string') return '';
    if (pic.startsWith('http://') || pic.startsWith('https://')) {
      return pic.slice(0, 500);
    }
    if (pic.startsWith('data:image/') && pic.length <= CONFIG.MAX_PICTURE_CHARS) {
      return pic;
    }
    return '';
  }

  function bindMediaHash(hash, eventId) {
    const h = String(hash || '').toLowerCase();
    const id = String(eventId || '');
    if (!h || !id) return false;
    state.hashToEventId.set(h, id);
    return true;
  }

  function resolveEventIdForHash(hash) {
    const h = String(hash || '').toLowerCase();
    if (!h) return null;
    return state.hashToEventId.get(h) || null;
  }

  function markEngagementFresh(eventId, asOfSec) {
    const id = String(eventId || '');
    if (!id) return;
    const asOf = typeof asOfSec === 'number' ? asOfSec : Math.floor(Date.now() / 1000);
    state.engagementFreshUntil.set(id, asOf + CONFIG.METADATA_FRESHNESS);
  }

  function hasFreshEngagement(eventId) {
    const id = String(eventId || '');
    if (!id) return false;
    const until = state.engagementFreshUntil.get(id);
    if (!until) return false;
    return Math.floor(Date.now() / 1000) < until;
  }

  function resolvePostEvent(eventId, event) {
    if (event && event.id) return event;
    const id = String(eventId || '');
    if (!id) return null;
    try {
      if (App.postsById instanceof Map && App.postsById.has(id)) {
        return App.postsById.get(id);
      }
    } catch (_) {}
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // לוגים
  // ═══════════════════════════════════════════════════════════════════════════
  
  function log(type, message, data = null) {
    const timestamp = new Date().toLocaleTimeString('he-IL');
    const colors = {
      info: '#607D8B',
      success: '#4CAF50',
      error: '#F44336',
      metadata: '#FF9800',
    };
    const color = colors[type] || '#607D8B';
    
    let logLine = `📋 [Metadata] ${message}`;
    if (data) {
      const shortData = Object.entries(data)
        .map(([k, v]) => `${k}:${typeof v === 'string' && v.length > 20 ? v.slice(0,16)+'...' : v}`)
        .join(' | ');
      logLine += ` [${shortData}]`;
    }
    
    console.log(`%c${timestamp} ${logLine}`, `color: ${color}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // יצירת Metadata
  // ═══════════════════════════════════════════════════════════════════════════
  
  /**
   * יצירת metadata מורחב לפוסט
   */
  function createPostMetadata(eventId, event = null) {
    const resolvedEvent = resolvePostEvent(eventId, event);
    const id = String(eventId || resolvedEvent?.id || '');
    if (!id) return null;
    
    try {
      // מידע בסיסי על הפוסט
      const post = resolvedEvent ? {
        id: resolvedEvent.id,
        content: (resolvedEvent.content || '').slice(0, CONFIG.MAX_CONTENT_LENGTH),
        createdAt: resolvedEvent.created_at,
        pubkey: resolvedEvent.pubkey,
      } : { id };
      
      // מידע על היוצר (שם + אווטאר לכרטיס) | HYPER CORE TECH
      let author = null;
      const authorPk = String(post.pubkey || resolvedEvent?.pubkey || '').toLowerCase();
      if (authorPk && App.profileCache) {
        const profile = App.profileCache.get(authorPk) || App.profileCache.get(post.pubkey) || {};
        author = {
          name: (profile.name || '').slice(0, 50),
          picture: sanitizePicture(profile.picture || ''),
          initials: profile.initials || 'AN',
        };
      }
      
      // סטטיסטיקות
      const stats = {
        likes: 0,
        comments: 0,
        asOf: Math.floor(Date.now() / 1000),
      };
      
      if (App.likesByEventId) {
        const likes = App.likesByEventId.get(id);
        stats.likes = likes ? likes.size : 0;
      }
      
      if (App.commentsByParent) {
        const comments = App.commentsByParent.get(id);
        stats.comments = comments ? comments.size : 0;
      }
      
      // תגובות אחרונות
      const recentComments = getRecentComments(id, CONFIG.MAX_RECENT_COMMENTS);
      
      // רשימת likers
      const likers = getLikersList(id, CONFIG.MAX_LIKERS);
      
      return {
        post,
        author,
        stats,
        recentComments,
        likers,
      };
    } catch (err) {
      log('error', 'שגיאה ביצירת metadata', { error: err.message });
      return null;
    }
  }

  /**
   * קבלת תגובות אחרונות
   */
  function getRecentComments(eventId, limit = 5) {
    if (!eventId || !App.commentsByParent) return [];
    
    const commentMap = App.commentsByParent.get(eventId);
    if (!commentMap) return [];
    
    try {
      return Array.from(commentMap.values())
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
        .slice(0, limit)
        .map(comment => {
          const authorProfile = App.profileCache?.get(comment.pubkey) || {};
          return {
            id: comment.id,
            content: (comment.content || '').slice(0, 200),
            createdAt: comment.created_at,
            author: {
              pubkey: comment.pubkey,
              name: (authorProfile.name || '').slice(0, 50),
              picture: sanitizePicture(authorProfile.picture || ''),
              initials: authorProfile.initials || 'AN',
            },
          };
        });
    } catch (err) {
      return [];
    }
  }

  /**
   * קבלת רשימת likers
   */
  function getLikersList(eventId, limit = 20) {
    if (!eventId || !App.likesByEventId) return [];
    
    const likersSet = App.likesByEventId.get(eventId);
    if (!likersSet) return [];
    
    try {
      return Array.from(likersSet)
        .slice(0, limit)
        .map(pubkey => {
          const profile = App.profileCache?.get(pubkey) || {};
          return {
            pubkey,
            name: (profile.name || '').slice(0, 50),
          };
        });
    } catch (err) {
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // עיבוד Metadata שהתקבל
  // ═══════════════════════════════════════════════════════════════════════════
  
  /**
   * בדיקה אם metadata עדכני
   */
  function isMetadataFresh(postMetadata) {
    if (!postMetadata?.stats?.asOf) return false;
    const age = Math.floor(Date.now() / 1000) - postMetadata.stats.asOf;
    return age < CONFIG.METADATA_FRESHNESS;
  }

  /**
   * שמירת metadata שהתקבל
   */
  function storeReceivedMetadata(hash, postMetadata) {
    if (!hash || !postMetadata) return;
    const h = String(hash).toLowerCase();
    
    state.receivedMetadata.set(h, {
      postMetadata,
      receivedAt: Date.now(),
      verified: false,
    });
    
    state.stats.metadataReceived++;
    
    log('metadata', 'נשמר metadata', {
      hash: h.slice(0, 12),
      likes: postMetadata.stats?.likes,
      comments: postMetadata.stats?.comments,
    });
  }

  /**
   * החלת metadata על ה-cache המקומי
   */
  function applyMetadata(eventId, postMetadata) {
    if (!eventId || !postMetadata) return false;
    
    try {
      // עדכון פרופיל המחבר (מיזוג – לא דורסים ערכים קיימים טובים) | HYPER CORE TECH
      const authorPk = String(postMetadata.post?.pubkey || '').toLowerCase();
      if (postMetadata.author && authorPk && App.profileCache) {
        const existing = App.profileCache.get(authorPk) || {};
        const nextPicture = sanitizePicture(postMetadata.author.picture) || existing.picture || '';
        App.profileCache.set(authorPk, {
          ...existing,
          name: postMetadata.author.name || existing.name,
          picture: nextPicture,
          initials: postMetadata.author.initials || existing.initials,
        });
      }
      
      // עדכון לייקים מ-P2P (מיזוג ל־likesByEventId הקיים) | HYPER CORE TECH
      if (Array.isArray(postMetadata.likers) && App.likesByEventId) {
        if (!App.likesByEventId.has(eventId)) {
          App.likesByEventId.set(eventId, new Set());
        }
        const likeSet = App.likesByEventId.get(eventId);
        postMetadata.likers.forEach((liker) => {
          const pk = typeof liker === 'string' ? liker : (liker?.pubkey || '');
          if (pk && pk.length >= 16) likeSet.add(pk.toLowerCase());
        });
      }

      // עדכון תגובות (מיזוג – לא מוחקים תגובות קיימות)
      if (postMetadata.recentComments && App.commentsByParent) {
        if (!App.commentsByParent.has(eventId)) {
          App.commentsByParent.set(eventId, new Map());
        }
        const commentMap = App.commentsByParent.get(eventId);
        
        postMetadata.recentComments.forEach(comment => {
          if (comment.id && !commentMap.has(comment.id)) {
            commentMap.set(comment.id, {
              id: comment.id,
              content: comment.content,
              created_at: comment.createdAt,
              pubkey: comment.author?.pubkey,
            });
            
            if (comment.author?.pubkey && App.profileCache) {
              const cpk = String(comment.author.pubkey).toLowerCase();
              const existing = App.profileCache.get(cpk) || {};
              App.profileCache.set(cpk, {
                ...existing,
                name: comment.author.name || existing.name,
                picture: sanitizePicture(comment.author.picture) || existing.picture || '',
                initials: comment.author.initials || existing.initials,
              });
            }
          }
        });
      }

      markEngagementFresh(eventId, postMetadata.stats?.asOf);
      state.stats.metadataApplied++;
      
      log('success', 'Metadata הוחל', {
        eventId: eventId.slice(0, 12),
        likes: postMetadata.stats?.likes,
        comments: postMetadata.recentComments?.length,
        hasAuthor: !!postMetadata.author?.name,
      });

      try {
        window.dispatchEvent(new CustomEvent('sos:p2p-metadata-applied', {
          detail: {
            eventId,
            pubkey: authorPk || null,
            likes: App.likesByEventId?.get(eventId)?.size || 0,
            comments: App.commentsByParent?.get(eventId)?.size || 0,
            author: postMetadata.author || null,
          },
        }));
      } catch (_) {}
      
      return true;
    } catch (err) {
      log('error', 'שגיאה בהחלת metadata', { error: err.message });
      return false;
    }
  }

  /**
   * קבלת metadata שנשמר
   */
  function getStoredMetadata(hash) {
    return state.receivedMetadata.get(String(hash || '').toLowerCase());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // הרחבת הודעת metadata
  // ═══════════════════════════════════════════════════════════════════════════
  
  /**
   * הרחבת הודעת metadata רגילה עם מידע נוסף
   */
  function extendMetadataMessage(baseMessage, hash, eventId = null) {
    if (!baseMessage) return baseMessage;
    
    const resolvedId = eventId || resolveEventIdForHash(hash);
    if (resolvedId && hash) bindMediaHash(hash, resolvedId);
    const postMetadata = createPostMetadata(resolvedId);
    
    if (postMetadata) {
      baseMessage.postMetadata = postMetadata;
      state.stats.metadataSent++;
      
      log('metadata', 'הוספתי metadata להודעה', {
        hash: hash?.slice(0, 12),
        eventId: (resolvedId || '').slice(0, 12),
        hasAuthor: !!postMetadata.author,
        likes: postMetadata.stats?.likes,
        comments: postMetadata.stats?.comments,
      });
    }
    
    return baseMessage;
  }

  /**
   * עיבוד הודעת metadata שהתקבלה
   */
  function processReceivedMetadata(msg, hash) {
    if (!msg || !hash) return;
    
    if (msg.postMetadata) {
      storeReceivedMetadata(hash, msg.postMetadata);
      
      // אם יש eventId - מחילים מיד
      if (msg.postMetadata.post?.id) {
        if (isMetadataFresh(msg.postMetadata)) {
          applyMetadata(msg.postMetadata.post.id, msg.postMetadata);
          // טרי מ-P2P – לא רצים ל-Relay בכלל (עמוד שדרה דק) | HYPER CORE TECH
        } else {
          // metadata ישן - מחילים אבל מרעננים מ-Relay רק אחרי השהייה ארוכה | HYPER CORE TECH
          applyMetadata(msg.postMetadata.post.id, msg.postMetadata);
          scheduleMetadataRefresh(msg.postMetadata.post.id);
        }
      }
    }
  }

  /**
   * תזמון עדכון metadata מ-Relay – רק כשאין מספיק נתונים מקומיים | HYPER CORE TECH
   */
  function scheduleMetadataRefresh(eventId) {
    if (!eventId) return;

    setTimeout(() => {
      try {
        const likes = App.likesByEventId?.get?.(eventId);
        const comments = App.commentsByParent?.get?.(eventId);
        const hasLocal =
          (likes && likes.size > 0) ||
          (comments && comments.size > 0);
        // אם כבר יש engagement מקומי מ-P2P/cache – מדלגים על Relay | HYPER CORE TECH
        if (hasLocal) {
          log('info', 'מדלג על רענון Relay – יש engagement מקומי', { eventId: eventId.slice(0, 12) });
          return;
        }
      } catch (_) {}

      log('info', 'מתזמן עדכון metadata מ-Relay (חסר מקומי)', { eventId: eventId.slice(0, 12) });
      if (typeof App.fetchLikesForEvent === 'function') {
        App.fetchLikesForEvent(eventId);
      }
      if (typeof App.fetchCommentsForEvent === 'function') {
        App.fetchCommentsForEvent(eventId);
      }
    }, CONFIG.RELAY_REFRESH_DELAY_MS);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // סטטיסטיקות
  // ═══════════════════════════════════════════════════════════════════════════
  
  function getStats() {
    return {
      storedMetadata: state.receivedMetadata.size,
      ...state.stats,
    };
  }

  function printStats() {
    const stats = getStats();
    console.log('%c┌──────────────────────────────────────────────────┐', 'color: #FF9800; font-weight: bold');
    console.log('%c│        📋 Metadata Transfer Statistics           │', 'color: #FF9800; font-weight: bold');
    console.log('%c├──────────────────────────────────────────────────┤', 'color: #FF9800');
    console.log(`%c│ 📤 Metadata Sent: ${stats.metadataSent}`, 'color: #2196F3');
    console.log(`%c│ 📥 Metadata Received: ${stats.metadataReceived}`, 'color: #4CAF50');
    console.log(`%c│ ✅ Metadata Applied: ${stats.metadataApplied}`, 'color: #8BC34A');
    console.log(`%c│ 💾 Stored Metadata: ${stats.storedMetadata}`, 'color: #607D8B');
    console.log('%c└──────────────────────────────────────────────────┘', 'color: #FF9800; font-weight: bold');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // אתחול
  // ═══════════════════════════════════════════════════════════════════════════
  
  function init() {
    log('info', 'מאתחל Metadata Transfer מודול...');
    log('success', 'Metadata Transfer מודול מוכן!');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // API ציבורי
  // ═══════════════════════════════════════════════════════════════════════════
  
  App.MetadataTransfer = {
    // יצירה
    createPostMetadata,
    extendMetadataMessage,
    
    // עיבוד
    processReceivedMetadata,
    applyMetadata,
    isMetadataFresh,
    
    // אחסון
    storeReceivedMetadata,
    getStoredMetadata,
    bindMediaHash,
    resolveEventIdForHash,
    markEngagementFresh,
    hasFreshEngagement,
    
    // סטטיסטיקות
    getStats,
    printStats,
    
    // קונפיגורציה
    CONFIG,
  };

  // פקודות קונסול
  window.metadataTransfer = {
    stats: printStats,
    stored: () => console.table([...state.receivedMetadata.entries()].map(([hash, data]) => ({
      hash: hash.slice(0, 16),
      likes: data.postMetadata?.stats?.likes,
      comments: data.postMetadata?.stats?.comments,
      age: Math.round((Date.now() - data.receivedAt) / 1000) + 's',
      verified: data.verified,
    }))),
  };

  console.log('%c📋 Metadata Transfer מודול נטען - הקלד metadataTransfer.stats() לסטטיסטיקות', 'color: #FF9800; font-weight: bold');

})(window);
