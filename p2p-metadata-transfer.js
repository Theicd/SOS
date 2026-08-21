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
    MAX_RECENT_COMMENTS: 5,        // מקסימום תגובות לשלוח
    MAX_LIKERS: 20,                // מקסימום likers לשלוח
    MAX_CONTENT_LENGTH: 500,       // מקסימום אורך תוכן פוסט
    METADATA_FRESHNESS: 5 * 60,    // 5 דקות בשניות - אחרי זה צריך עדכון
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════════════════════════
  
  const state = {
    // metadata שקיבלנו מ-peers
    // hash -> { postMetadata, receivedAt, verified }
    receivedMetadata: new Map(),
    
    // סטטיסטיקות
    stats: {
      metadataSent: 0,
      metadataReceived: 0,
      metadataApplied: 0,
    },
  };

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
    if (!eventId) return null;
    
    try {
      // מידע בסיסי על הפוסט
      const post = event ? {
        id: event.id,
        content: (event.content || '').slice(0, CONFIG.MAX_CONTENT_LENGTH),
        createdAt: event.created_at,
        pubkey: event.pubkey,
      } : { id: eventId };
      
      // מידע על היוצר
      let author = null;
      if (event?.pubkey && App.profileCache) {
        const profile = App.profileCache.get(event.pubkey);
        if (profile) {
          author = {
            name: (profile.name || '').slice(0, 50),
            picture: profile.picture || '',
            initials: profile.initials || 'AN',
          };
        }
      }
      
      // סטטיסטיקות
      const stats = {
        likes: 0,
        comments: 0,
        asOf: Math.floor(Date.now() / 1000),
      };
      
      if (App.likesByEventId) {
        const likes = App.likesByEventId.get(eventId);
        stats.likes = likes ? likes.size : 0;
      }
      
      if (App.commentsByParent) {
        const comments = App.commentsByParent.get(eventId);
        stats.comments = comments ? comments.size : 0;
      }
      
      // תגובות אחרונות
      const recentComments = getRecentComments(eventId, CONFIG.MAX_RECENT_COMMENTS);
      
      // רשימת likers
      const likers = getLikersList(eventId, CONFIG.MAX_LIKERS);
      
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
              picture: authorProfile.picture || '',
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
    
    state.receivedMetadata.set(hash, {
      postMetadata,
      receivedAt: Date.now(),
      verified: false,
    });
    
    state.stats.metadataReceived++;
    
    log('metadata', 'נשמר metadata', {
      hash: hash.slice(0, 12),
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
      // עדכון פרופיל המחבר
      if (postMetadata.author && postMetadata.post?.pubkey && App.profileCache) {
        const existing = App.profileCache.get(postMetadata.post.pubkey) || {};
        App.profileCache.set(postMetadata.post.pubkey, {
          ...existing,
          name: postMetadata.author.name || existing.name,
          picture: postMetadata.author.picture || existing.picture,
          initials: postMetadata.author.initials || existing.initials,
        });
      }
      
      // עדכון תגובות
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
            
            // עדכון פרופיל המגיב
            if (comment.author?.pubkey && App.profileCache) {
              const existing = App.profileCache.get(comment.author.pubkey) || {};
              App.profileCache.set(comment.author.pubkey, {
                ...existing,
                name: comment.author.name || existing.name,
                picture: comment.author.picture || existing.picture,
                initials: comment.author.initials || existing.initials,
              });
            }
          }
        });
      }
      
      state.stats.metadataApplied++;
      
      log('success', 'Metadata הוחל', {
        eventId: eventId.slice(0, 12),
        likes: postMetadata.stats?.likes,
        comments: postMetadata.recentComments?.length,
      });
      
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
    return state.receivedMetadata.get(hash);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // הרחבת הודעת metadata
  // ═══════════════════════════════════════════════════════════════════════════
  
  /**
   * הרחבת הודעת metadata רגילה עם מידע נוסף
   */
  function extendMetadataMessage(baseMessage, hash, eventId = null) {
    if (!baseMessage) return baseMessage;
    
    // יצירת metadata מורחב
    const postMetadata = createPostMetadata(eventId);
    
    if (postMetadata) {
      baseMessage.postMetadata = postMetadata;
      state.stats.metadataSent++;
      
      log('metadata', 'הוספתי metadata להודעה', {
        hash: hash?.slice(0, 12),
        hasAuthor: !!postMetadata.author,
        likes: postMetadata.stats?.likes,
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
        } else {
          // metadata ישן - מחילים אבל מתזמנים עדכון
          applyMetadata(msg.postMetadata.post.id, msg.postMetadata);
          scheduleMetadataRefresh(msg.postMetadata.post.id);
        }
      }
    }
  }

  /**
   * תזמון עדכון metadata מ-Relay
   */
  function scheduleMetadataRefresh(eventId) {
    if (!eventId) return;
    
    // עדכון ברקע אחרי 5 שניות
    setTimeout(() => {
      log('info', 'מתזמן עדכון metadata מ-Relay', { eventId: eventId.slice(0, 12) });
      
      // קריאה לפונקציות קיימות לעדכון לייקים ותגובות
      if (typeof App.fetchLikesForEvent === 'function') {
        App.fetchLikesForEvent(eventId);
      }
      if (typeof App.fetchCommentsForEvent === 'function') {
        App.fetchCommentsForEvent(eventId);
      }
    }, 5000);
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
