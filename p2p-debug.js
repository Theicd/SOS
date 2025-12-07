/**
 * P2P Debug System - מערכת לוגים מפורטת לאבחון P2P
 * קובץ נפרד שעוטף את הפונקציות הקיימות ומוסיף לוגים מפורטים
 * 
 * שימוש:
 * 1. הוסף את הקובץ ל-HTML אחרי p2p-video-sharing.js
 * 2. פתח את הקונסול וסנן לפי "P2P"
 * 3. הרץ P2P_DEBUG.summary() לסיכום
 * 4. הרץ P2P_DEBUG.export() לייצוא הלוגים
 * 
 * @version 1.0.0
 * HYPER CORE TECH
 */

(function initP2PDebug(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  // ═══════════════════════════════════════════════════════════════════════════
  // מערכת לוגים מרכזית
  // ═══════════════════════════════════════════════════════════════════════════

  const P2P_DEBUG = {
    enabled: true,
    verbose: true, // לוגים מפורטים יותר
    sessionId: Math.random().toString(36).substr(2, 6),
    startTime: Date.now(),
    events: [],
    maxEvents: 1000, // מגבלת זיכרון

    // צבעים לפי קטגוריה
    colors: {
      INIT: '#9C27B0',      // סגול - אתחול
      RELAY: '#FF5722',     // כתום - תקשורת עם ריליי
      PEER: '#2196F3',      // כחול - peers
      DOWNLOAD: '#4CAF50',  // ירוק - הורדות
      UPLOAD: '#FF9800',    // כתום בהיר - העלאות
      SIGNAL: '#E91E63',    // ורוד - סיגנלים WebRTC
      ERROR: '#F44336',     // אדום - שגיאות
      CACHE: '#795548',     // חום - cache
      GUEST: '#607D8B',     // אפור - אורח
      NETWORK: '#00BCD4',   // טורקיז - מצב רשת
      HEARTBEAT: '#8BC34A', // ירוק בהיר - heartbeat
      WEBRTC: '#673AB7',    // סגול כהה - WebRTC
      MULTISOURCE: '#E91E63', // ורוד - Multi-Source
    },

    // אייקונים לפי קטגוריה
    icons: {
      INIT: '🚀',
      RELAY: '📡',
      PEER: '👥',
      DOWNLOAD: '📥',
      UPLOAD: '📤',
      SIGNAL: '📶',
      ERROR: '❌',
      CACHE: '💾',
      GUEST: '👤',
      NETWORK: '🌐',
      HEARTBEAT: '💓',
      WEBRTC: '🔗',
      MULTISOURCE: '🚀',
    },

    /**
     * לוג מפורט עם timestamp יחסי
     */
    log(category, action, data = {}) {
      if (!this.enabled) return;

      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);
      const entry = {
        time: elapsed,
        timestamp: new Date().toISOString(),
        session: this.sessionId,
        category,
        action,
        data: { ...data }
      };

      // שמירה עם הגבלת זיכרון
      this.events.push(entry);
      if (this.events.length > this.maxEvents) {
        this.events.shift();
      }

      const color = this.colors[category] || '#000';
      const icon = this.icons[category] || 'ℹ️';
      const prefix = `[P2P:${this.sessionId}][${elapsed}s]`;

      // פורמט הלוג
      const hasData = Object.keys(data).length > 0;
      
      if (hasData && this.verbose) {
        console.log(
          `%c${prefix} ${icon} [${category}] ${action}`,
          `color: ${color}; font-weight: bold`,
          data
        );
      } else {
        console.log(
          `%c${prefix} ${icon} [${category}] ${action}`,
          `color: ${color}; font-weight: bold`
        );
      }

      return entry;
    },

    /**
     * לוג שגיאה
     */
    error(action, data = {}) {
      return this.log('ERROR', action, data);
    },

    /**
     * לוג עם קבוצה (group)
     */
    group(category, title, fn) {
      const color = this.colors[category] || '#000';
      const icon = this.icons[category] || 'ℹ️';
      
      console.group(`%c${icon} [${category}] ${title}`, `color: ${color}; font-weight: bold`);
      try {
        fn();
      } finally {
        console.groupEnd();
      }
    },

    /**
     * סיכום הסשן
     */
    summary() {
      const duration = ((Date.now() - this.startTime) / 1000).toFixed(1);
      
      console.log('%c╔══════════════════════════════════════════════════════════════╗', 'color: #9C27B0; font-weight: bold');
      console.log('%c║                    P2P DEBUG SESSION SUMMARY                  ║', 'color: #9C27B0; font-weight: bold');
      console.log('%c╠══════════════════════════════════════════════════════════════╣', 'color: #9C27B0');
      console.log(`%c║  Session ID: ${this.sessionId.padEnd(47)}║`, 'color: #9C27B0');
      console.log(`%c║  Duration: ${(duration + ' seconds').padEnd(49)}║`, 'color: #9C27B0');
      console.log(`%c║  Total Events: ${String(this.events.length).padEnd(45)}║`, 'color: #9C27B0');
      console.log('%c╠══════════════════════════════════════════════════════════════╣', 'color: #9C27B0');

      // ספירה לפי קטגוריה
      const counts = {};
      this.events.forEach(e => {
        counts[e.category] = (counts[e.category] || 0) + 1;
      });

      console.log('%c║  Events by Category:                                         ║', 'color: #9C27B0');
      Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([cat, count]) => {
        const icon = this.icons[cat] || '•';
        const line = `${icon} ${cat}: ${count}`;
        console.log(`%c║    ${line.padEnd(57)}║`, `color: ${this.colors[cat] || '#000'}`);
      });

      // שגיאות
      const errors = this.events.filter(e => e.category === 'ERROR');
      if (errors.length > 0) {
        console.log('%c╠══════════════════════════════════════════════════════════════╣', 'color: #F44336');
        console.log(`%c║  ⚠️  ERRORS: ${String(errors.length).padEnd(48)}║`, 'color: #F44336; font-weight: bold');
        errors.slice(-5).forEach(err => {
          console.log(`%c║    [${err.time}s] ${err.action.slice(0, 50).padEnd(50)}║`, 'color: #F44336');
        });
      }

      // סטטיסטיקות P2P
      if (typeof App.getP2PStats === 'function') {
        const stats = App.getP2PStats();
        const multiSourcePct = stats.downloads?.fromP2P > 0 
          ? Math.round((stats.downloads?.fromMultiSource || 0) / stats.downloads.fromP2P * 100) 
          : 0;
        console.log('%c╠══════════════════════════════════════════════════════════════╣', 'color: #4CAF50');
        console.log('%c║  P2P Statistics:                                             ║', 'color: #4CAF50; font-weight: bold');
        console.log(`%c║    Downloads: ${String(stats.downloads?.total || 0).padEnd(46)}║`, 'color: #4CAF50');
        console.log(`%c║      - Cache: ${String(stats.downloads?.fromCache || 0).padEnd(46)}║`, 'color: #795548');
        console.log(`%c║      - Blossom: ${String(stats.downloads?.fromBlossom || 0).padEnd(44)}║`, 'color: #FF9800');
        console.log(`%c║      - P2P: ${String(stats.downloads?.fromP2P || 0).padEnd(48)}║`, 'color: #2196F3');
        console.log(`%c║      - Multi-Source: ${String((stats.downloads?.fromMultiSource || 0) + ' (' + multiSourcePct + '%)').padEnd(39)}║`, 'color: #E91E63');
        console.log(`%c║      - Failed: ${String(stats.downloads?.failed || 0).padEnd(45)}║`, 'color: #F44336');
        console.log(`%c║    Network Tier: ${String(stats.networkTier || 'UNKNOWN').padEnd(43)}║`, 'color: #00BCD4');
        console.log(`%c║    Peer Count: ${String(stats.peerCount || 0).padEnd(45)}║`, 'color: #2196F3');
        console.log(`%c║    Available Files: ${String(stats.availableFiles || 0).padEnd(40)}║`, 'color: #8BC34A');
        console.log(`%c║    Is Leader: ${String(stats.isLeader || false).padEnd(46)}║`, 'color: #9C27B0');
        console.log(`%c║    Is Guest: ${String(stats.isGuest || false).padEnd(47)}║`, 'color: #607D8B');
      }

      console.log('%c╚══════════════════════════════════════════════════════════════╝', 'color: #9C27B0; font-weight: bold');
    },

    /**
     * ייצוא הלוגים כ-JSON
     */
    export() {
      const data = {
        sessionId: this.sessionId,
        startTime: new Date(this.startTime).toISOString(),
        duration: ((Date.now() - this.startTime) / 1000).toFixed(1) + 's',
        events: this.events,
        stats: typeof App.getP2PStats === 'function' ? App.getP2PStats() : null
      };
      return JSON.stringify(data, null, 2);
    },

    /**
     * הורדת הלוגים כקובץ
     */
    download() {
      const data = this.export();
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `p2p-debug-${this.sessionId}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      console.log('%c📁 Logs downloaded!', 'color: #4CAF50; font-weight: bold');
    },

    /**
     * ניקוי הלוגים
     */
    clear() {
      this.events = [];
      this.startTime = Date.now();
      this.sessionId = Math.random().toString(36).substr(2, 6);
      console.log('%c🗑️ Logs cleared, new session started', 'color: #FF9800');
    },

    /**
     * סינון לוגים לפי קטגוריה
     */
    filter(category) {
      return this.events.filter(e => e.category === category);
    },

    /**
     * הצגת לוגים אחרונים
     */
    recent(count = 20) {
      const recent = this.events.slice(-count);
      console.table(recent.map(e => ({
        time: e.time + 's',
        category: e.category,
        action: e.action.slice(0, 50)
      })));
      return recent;
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // עטיפת פונקציות P2P קיימות
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * עטיפה כללית לפונקציה
   */
  function wrapFunction(obj, fnName, category, beforeLog, afterLog) {
    const original = obj[fnName];
    if (typeof original !== 'function') return;

    obj[fnName] = async function(...args) {
      const callId = Math.random().toString(36).substr(2, 4);
      
      if (beforeLog) {
        P2P_DEBUG.log(category, `${fnName} START`, beforeLog(args, callId));
      }

      const startTime = Date.now();
      
      try {
        const result = await original.apply(this, args);
        const duration = Date.now() - startTime;
        
        if (afterLog) {
          P2P_DEBUG.log(category, `${fnName} END`, afterLog(result, duration, callId));
        }
        
        return result;
      } catch (err) {
        const duration = Date.now() - startTime;
        P2P_DEBUG.error(`${fnName} FAILED`, {
          callId,
          duration: duration + 'ms',
          error: err.message,
          stack: err.stack?.split('\n').slice(0, 3).join(' | ')
        });
        throw err;
      }
    };

    // שמירת הפונקציה המקורית
    obj[`_original_${fnName}`] = original;
  }

  /**
   * אתחול העטיפות
   */
  function initWrappers() {
    P2P_DEBUG.log('INIT', 'Initializing P2P Debug Wrappers...');

    // ═══════════════════════════════════════════════════════════════════════
    // עטיפת downloadVideoWithP2P
    // ═══════════════════════════════════════════════════════════════════════
    if (typeof App.downloadVideoWithP2P === 'function') {
      wrapFunction(App, 'downloadVideoWithP2P', 'DOWNLOAD',
        (args, callId) => ({
          callId,
          url: args[0]?.slice(0, 60) + '...',
          hash: args[1]?.slice(0, 16) || 'no-hash',
          mimeType: args[2],
          options: args[3]
        }),
        (result, duration, callId) => ({
          callId,
          duration: duration + 'ms',
          source: result?.source,
          size: result?.blob?.size ? Math.round(result.blob.size / 1024) + 'KB' : 'unknown',
          tier: result?.tier
        })
      );
      P2P_DEBUG.log('INIT', 'Wrapped: downloadVideoWithP2P');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // עטיפת findPeersWithFile
    // ═══════════════════════════════════════════════════════════════════════
    if (typeof App.findPeersWithFile === 'function' || typeof App.searchForPeers === 'function') {
      const fnName = App.findPeersWithFile ? 'findPeersWithFile' : 'searchForPeers';
      wrapFunction(App, fnName, 'PEER',
        (args, callId) => ({
          callId,
          hash: args[0]?.slice(0, 16)
        }),
        (result, duration, callId) => ({
          callId,
          duration: duration + 'ms',
          peersFound: Array.isArray(result) ? result.length : 0,
          peers: Array.isArray(result) ? result.map(p => p?.slice(0, 12)) : []
        })
      );
      P2P_DEBUG.log('INIT', `Wrapped: ${fnName}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // עטיפת registerFileAvailability
    // ═══════════════════════════════════════════════════════════════════════
    if (typeof App.registerFileAvailability === 'function') {
      wrapFunction(App, 'registerFileAvailability', 'UPLOAD',
        (args, callId) => ({
          callId,
          hash: args[0]?.slice(0, 16),
          size: args[1]?.size ? Math.round(args[1].size / 1024) + 'KB' : 'unknown',
          mimeType: args[2]
        }),
        (result, duration, callId) => ({
          callId,
          duration: duration + 'ms',
          success: result?.success || result === true,
          published: result?.published
        })
      );
      P2P_DEBUG.log('INIT', 'Wrapped: registerFileAvailability');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // עטיפת countActivePeers
    // ═══════════════════════════════════════════════════════════════════════
    if (typeof App.countActivePeers === 'function') {
      wrapFunction(App, 'countActivePeers', 'NETWORK',
        (args, callId) => ({ callId }),
        (result, duration, callId) => ({
          callId,
          duration: duration + 'ms',
          peerCount: result
        })
      );
      P2P_DEBUG.log('INIT', 'Wrapped: countActivePeers');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // עטיפת updateNetworkTier
    // ═══════════════════════════════════════════════════════════════════════
    if (typeof App.updateNetworkTier === 'function') {
      wrapFunction(App, 'updateNetworkTier', 'NETWORK',
        (args, callId) => ({ callId }),
        (result, duration, callId) => ({
          callId,
          duration: duration + 'ms',
          tier: result?.tier,
          peerCount: result?.peerCount
        })
      );
      P2P_DEBUG.log('INIT', 'Wrapped: updateNetworkTier');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // עטיפת sendHeartbeat
    // ═══════════════════════════════════════════════════════════════════════
    if (typeof App.sendHeartbeat === 'function') {
      wrapFunction(App, 'sendHeartbeat', 'HEARTBEAT',
        (args, callId) => ({ callId }),
        (result, duration, callId) => ({
          callId,
          duration: duration + 'ms'
        })
      );
      P2P_DEBUG.log('INIT', 'Wrapped: sendHeartbeat');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // עטיפת downloadFromPeer
    // ═══════════════════════════════════════════════════════════════════════
    if (typeof App.downloadFromPeer === 'function') {
      wrapFunction(App, 'downloadFromPeer', 'WEBRTC',
        (args, callId) => ({
          callId,
          peer: args[0]?.slice(0, 16),
          hash: args[1]?.slice(0, 16)
        }),
        (result, duration, callId) => ({
          callId,
          duration: duration + 'ms',
          success: !!result?.blob,
          size: result?.blob?.size ? Math.round(result.blob.size / 1024) + 'KB' : 'unknown'
        })
      );
      P2P_DEBUG.log('INIT', 'Wrapped: downloadFromPeer');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // עטיפת getCachedMedia
    // ═══════════════════════════════════════════════════════════════════════
    if (typeof App.getCachedMedia === 'function') {
      wrapFunction(App, 'getCachedMedia', 'CACHE',
        (args, callId) => ({
          callId,
          hash: args[0]?.slice(0, 16)
        }),
        (result, duration, callId) => ({
          callId,
          duration: duration + 'ms',
          found: !!result?.blob,
          size: result?.blob?.size ? Math.round(result.blob.size / 1024) + 'KB' : 'not found'
        })
      );
      P2P_DEBUG.log('INIT', 'Wrapped: getCachedMedia');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // עטיפת cacheMedia
    // ═══════════════════════════════════════════════════════════════════════
    if (typeof App.cacheMedia === 'function') {
      wrapFunction(App, 'cacheMedia', 'CACHE',
        (args, callId) => ({
          callId,
          hash: args[1]?.slice(0, 16),
          size: args[2]?.size ? Math.round(args[2].size / 1024) + 'KB' : 'unknown'
        }),
        (result, duration, callId) => ({
          callId,
          duration: duration + 'ms',
          success: result !== false
        })
      );
      P2P_DEBUG.log('INIT', 'Wrapped: cacheMedia');
    }

    P2P_DEBUG.log('INIT', 'All wrappers initialized', {
      wrappedFunctions: [
        'downloadVideoWithP2P',
        'findPeersWithFile',
        'registerFileAvailability',
        'countActivePeers',
        'updateNetworkTier',
        'sendHeartbeat',
        'downloadFromPeer',
        'getCachedMedia',
        'cacheMedia'
      ].filter(fn => typeof App[fn] === 'function')
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // מעקב אחרי מצב הרשת
  // ═══════════════════════════════════════════════════════════════════════════

  function startNetworkMonitor() {
    // לוג מצב רשת כל 30 שניות
    setInterval(() => {
      if (typeof App.getP2PStats === 'function') {
        const stats = App.getP2PStats();
        P2P_DEBUG.log('NETWORK', 'Status Update', {
          tier: stats.networkTier,
          peers: stats.peerCount,
          downloads: stats.downloads?.total,
          fromP2P: stats.downloads?.fromP2P,
          fromBlossom: stats.downloads?.fromBlossom,
          fromCache: stats.downloads?.fromCache,
          failed: stats.downloads?.failed,
          availableFiles: stats.availableFiles,
          isLeader: stats.isLeader,
          isGuest: stats.isGuest
        });
      }
    }, 30000);

    P2P_DEBUG.log('INIT', 'Network monitor started (30s interval)');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // מעקב אחרי שגיאות גלובליות
  // ═══════════════════════════════════════════════════════════════════════════

  function setupErrorTracking() {
    window.addEventListener('error', (event) => {
      if (event.message?.includes('P2P') || event.filename?.includes('p2p')) {
        P2P_DEBUG.error('Global Error', {
          message: event.message,
          filename: event.filename,
          line: event.lineno,
          col: event.colno
        });
      }
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason?.message || String(event.reason);
      if (reason?.includes('P2P') || reason?.includes('peer') || reason?.includes('WebRTC')) {
        P2P_DEBUG.error('Unhandled Promise Rejection', {
          reason: reason.slice(0, 200)
        });
      }
    });

    P2P_DEBUG.log('INIT', 'Error tracking enabled');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // פקודות קונסול נוחות
  // ═══════════════════════════════════════════════════════════════════════════

  function setupConsoleHelpers() {
    // קיצורי דרך בקונסול
    window.p2p = {
      // סיכום
      summary: () => P2P_DEBUG.summary(),
      
      // ייצוא
      export: () => P2P_DEBUG.export(),
      download: () => P2P_DEBUG.download(),
      
      // לוגים
      logs: () => P2P_DEBUG.events,
      recent: (n) => P2P_DEBUG.recent(n),
      errors: () => P2P_DEBUG.filter('ERROR'),
      clear: () => P2P_DEBUG.clear(),
      
      // סטטיסטיקות
      stats: () => {
        if (typeof App.getP2PStats === 'function') {
          const stats = App.getP2PStats();
          console.table(stats);
          return stats;
        }
        console.log('P2P stats not available');
        return null;
      },
      
      // מצב רשת
      network: () => {
        if (typeof App.p2pGetNetworkState === 'function') {
          const state = App.p2pGetNetworkState();
          console.table(state);
          return state;
        }
        return null;
      },
      
      // קבצים זמינים
      files: () => {
        if (typeof App.p2pGetAvailableFiles === 'function') {
          const files = App.p2pGetAvailableFiles();
          console.log(`Available files: ${files.size}`);
          files.forEach((data, hash) => {
            console.log(`  ${hash.slice(0, 16)}... - ${Math.round(data.size / 1024)}KB`);
          });
          return files;
        }
        return null;
      },
      
      // בדיקת ריליי
      checkRelay: async () => {
        if (typeof App.p2pDebugCheckRelay === 'function') {
          console.log('Checking relay for P2P events...');
          const events = await App.p2pDebugCheckRelay();
          console.log(`Found ${events.length} events`);
          return events;
        }
        return null;
      },
      
      // פרסום מחדש
      republish: async () => {
        if (typeof App.republishAllFiles === 'function') {
          console.log('Republishing all files...');
          const count = await App.republishAllFiles();
          console.log(`Republished ${count} files`);
          return count;
        }
        return null;
      },
      
      // עזרה
      help: () => {
        console.log('%c═══════════════════════════════════════════════════════════', 'color: #9C27B0');
        console.log('%c                    P2P DEBUG COMMANDS                      ', 'color: #9C27B0; font-weight: bold');
        console.log('%c═══════════════════════════════════════════════════════════', 'color: #9C27B0');
        console.log('%cp2p.summary()    %c- הצגת סיכום הסשן', 'color: #4CAF50; font-weight: bold', 'color: #666');
        console.log('%cp2p.stats()      %c- סטטיסטיקות P2P', 'color: #4CAF50; font-weight: bold', 'color: #666');
        console.log('%cp2p.network()    %c- מצב רשת נוכחי', 'color: #4CAF50; font-weight: bold', 'color: #666');
        console.log('%cp2p.files()      %c- קבצים זמינים לשיתוף', 'color: #4CAF50; font-weight: bold', 'color: #666');
        console.log('%cp2p.logs()       %c- כל הלוגים', 'color: #4CAF50; font-weight: bold', 'color: #666');
        console.log('%cp2p.recent(20)   %c- 20 לוגים אחרונים', 'color: #4CAF50; font-weight: bold', 'color: #666');
        console.log('%cp2p.errors()     %c- רק שגיאות', 'color: #4CAF50; font-weight: bold', 'color: #666');
        console.log('%cp2p.download()   %c- הורדת לוגים כקובץ', 'color: #4CAF50; font-weight: bold', 'color: #666');
        console.log('%cp2p.checkRelay() %c- בדיקת events בריליי', 'color: #4CAF50; font-weight: bold', 'color: #666');
        console.log('%cp2p.republish()  %c- פרסום מחדש של קבצים', 'color: #4CAF50; font-weight: bold', 'color: #666');
        console.log('%cp2p.clear()      %c- ניקוי לוגים', 'color: #4CAF50; font-weight: bold', 'color: #666');
        console.log('%c═══════════════════════════════════════════════════════════', 'color: #9C27B0');
      }
    };

    P2P_DEBUG.log('INIT', 'Console helpers ready. Type p2p.help() for commands');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // אתחול
  // ═══════════════════════════════════════════════════════════════════════════

  function init() {
    console.log('%c╔══════════════════════════════════════════════════════════════╗', 'color: #9C27B0; font-weight: bold');
    console.log('%c║           🔍 P2P DEBUG SYSTEM INITIALIZED                    ║', 'color: #9C27B0; font-weight: bold');
    console.log('%c║                                                              ║', 'color: #9C27B0');
    console.log('%c║   Type p2p.help() for available commands                     ║', 'color: #9C27B0');
    console.log('%c║   Filter console by "P2P" to see only P2P logs               ║', 'color: #9C27B0');
    console.log('%c╚══════════════════════════════════════════════════════════════╝', 'color: #9C27B0; font-weight: bold');

    P2P_DEBUG.log('INIT', 'P2P Debug System Starting', {
      sessionId: P2P_DEBUG.sessionId,
      timestamp: new Date().toISOString()
    });

    // המתנה ל-App להיות מוכן
    let attempts = 0;
    const maxAttempts = 20;

    const tryInit = () => {
      attempts++;
      
      if (App.pool && (App.publicKey || App.isGuestP2P)) {
        P2P_DEBUG.log('INIT', 'App ready, initializing wrappers', {
          hasPool: !!App.pool,
          hasPublicKey: !!App.publicKey,
          isGuest: typeof App.isGuestP2P === 'function' ? App.isGuestP2P() : 'unknown'
        });
        
        initWrappers();
        startNetworkMonitor();
        setupErrorTracking();
        setupConsoleHelpers();
        
        P2P_DEBUG.log('INIT', 'P2P Debug System Ready!', {
          sessionId: P2P_DEBUG.sessionId
        });
        
        return true;
      }
      
      if (attempts >= maxAttempts) {
        P2P_DEBUG.log('INIT', 'App not ready after max attempts, initializing anyway');
        initWrappers();
        startNetworkMonitor();
        setupErrorTracking();
        setupConsoleHelpers();
        return true;
      }
      
      P2P_DEBUG.log('INIT', `Waiting for App... (${attempts}/${maxAttempts})`);
      setTimeout(tryInit, 500);
      return false;
    };

    // התחלה
    setTimeout(tryInit, 100);
  }

  // חשיפה גלובלית
  window.P2P_DEBUG = P2P_DEBUG;

  // אתחול
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window);
