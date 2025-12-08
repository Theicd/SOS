/**
 * חלק דיבוג אייפון (ios-video-debug.js) – מודול דיבוג מעמיק לבעיות וידאו באייפון | HYPER CORE TECH
 * גרסה: 1.0.0
 * 
 * מטרה: לזהות למה וידאו לא מוצג באייפון למרות שהקול מתנגן
 */

(function() {
  'use strict';

  const IOS_DEBUG_VERSION = '1.0.0';
  
  // בדיקה אם זה iOS
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const iosVersion = (() => {
    const match = navigator.userAgent.match(/OS (\d+)_(\d+)_?(\d+)?/);
    return match ? { major: parseInt(match[1]), minor: parseInt(match[2]), patch: parseInt(match[3] || 0) } : null;
  })();

  // לוג מיוחד לדיבוג iOS
  function iosLog(category, message, data = {}) {
    const timestamp = new Date().toLocaleTimeString('he-IL');
    const prefix = `[iOS-DEBUG ${timestamp}]`;
    const colors = {
      'VIDEO': '#E91E63',
      'CODEC': '#9C27B0',
      'BLOB': '#673AB7',
      'CACHE': '#3F51B5',
      'RENDER': '#2196F3',
      'ERROR': '#F44336',
      'SUCCESS': '#4CAF50',
      'WARNING': '#FF9800',
      'INFO': '#607D8B'
    };
    
    const color = colors[category] || '#607D8B';
    const dataStr = Object.keys(data).length > 0 
      ? ' [' + Object.entries(data).map(([k,v]) => `${k}:${String(v).substring(0,30)}`).join(' | ') + ']'
      : '';
    
    console.log(`%c${prefix} 📱 ${category}: ${message}${dataStr}`, `color: ${color}; font-weight: bold`);
  }

  // בדיקת מידע על המכשיר
  function logDeviceInfo() {
    iosLog('INFO', '=== מידע על המכשיר ===');
    iosLog('INFO', 'User Agent', { ua: navigator.userAgent.substring(0, 100) });
    iosLog('INFO', 'Platform', { platform: navigator.platform });
    iosLog('INFO', 'iOS Detection', { isIOS, isSafari });
    if (iosVersion) {
      iosLog('INFO', 'iOS Version', { major: iosVersion.major, minor: iosVersion.minor, patch: iosVersion.patch });
    }
    iosLog('INFO', 'Screen', { width: screen.width, height: screen.height, pixelRatio: window.devicePixelRatio });
    iosLog('INFO', 'Viewport', { width: window.innerWidth, height: window.innerHeight });
    
    // בדיקת תמיכה ב-APIs
    iosLog('INFO', 'APIs Support', {
      indexedDB: !!window.indexedDB,
      webRTC: !!window.RTCPeerConnection,
      mediaSource: !!window.MediaSource,
      blob: !!window.Blob
    });
  }

  // בדיקת תמיכה בקודקים
  function checkCodecSupport() {
    iosLog('CODEC', '=== בדיקת תמיכה בקודקים ===');
    
    const video = document.createElement('video');
    const codecs = [
      'video/mp4',
      'video/mp4; codecs="avc1.42E01E"',
      'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
      'video/mp4; codecs="avc1.4D401E"',
      'video/mp4; codecs="avc1.64001E"',
      'video/mp4; codecs="hev1.1.6.L93.B0"',
      'video/webm',
      'video/webm; codecs="vp8"',
      'video/webm; codecs="vp9"',
      'video/ogg',
      'video/quicktime'
    ];
    
    codecs.forEach(codec => {
      const support = video.canPlayType(codec);
      const status = support === 'probably' ? '✅' : support === 'maybe' ? '⚠️' : '❌';
      iosLog('CODEC', `${status} ${codec}`, { support: support || 'no' });
    });
  }

  // מעקב אחרי אלמנטי וידאו
  function monitorVideoElement(videoEl, label = 'unknown') {
    if (!videoEl || videoEl._iosDebugMonitored) return;
    videoEl._iosDebugMonitored = true;
    
    iosLog('VIDEO', `מתחיל מעקב אחרי וידאו`, { label });
    
    // לוג מצב התחלתי
    iosLog('VIDEO', 'מצב התחלתי', {
      src: videoEl.src ? videoEl.src.substring(0, 50) : 'none',
      readyState: videoEl.readyState,
      networkState: videoEl.networkState,
      paused: videoEl.paused,
      muted: videoEl.muted,
      autoplay: videoEl.autoplay,
      playsInline: videoEl.playsInline
    });
    
    // לוג תכונות CSS
    const style = window.getComputedStyle(videoEl);
    iosLog('RENDER', 'CSS Properties', {
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      width: style.width,
      height: style.height,
      objectFit: style.objectFit,
      transform: style.transform.substring(0, 30)
    });
    
    // מעקב אחרי אירועים
    const events = [
      'loadstart', 'progress', 'suspend', 'abort', 'error', 'emptied', 'stalled',
      'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing',
      'waiting', 'seeking', 'seeked', 'ended', 'durationchange', 'timeupdate',
      'play', 'pause', 'ratechange', 'resize', 'volumechange'
    ];
    
    events.forEach(eventName => {
      videoEl.addEventListener(eventName, (e) => {
        const data = {
          readyState: videoEl.readyState,
          networkState: videoEl.networkState,
          currentTime: videoEl.currentTime?.toFixed(2),
          duration: videoEl.duration?.toFixed(2)
        };
        
        if (eventName === 'error') {
          const error = videoEl.error;
          iosLog('ERROR', `אירוע וידאו: ${eventName}`, {
            code: error?.code,
            message: error?.message || 'unknown'
          });
        } else if (['loadeddata', 'canplay', 'playing', 'error'].includes(eventName)) {
          iosLog('VIDEO', `אירוע וידאו: ${eventName}`, data);
        }
        
        // בדיקת videoWidth/videoHeight אחרי loadedmetadata
        if (eventName === 'loadedmetadata') {
          iosLog('VIDEO', 'מידע וידאו נטען', {
            videoWidth: videoEl.videoWidth,
            videoHeight: videoEl.videoHeight,
            duration: videoEl.duration?.toFixed(2)
          });
          
          // אם videoWidth או videoHeight הם 0 - זו הבעיה!
          if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
            iosLog('ERROR', '⚠️ videoWidth/videoHeight הם 0! זו כנראה הבעיה!');
          }
        }
      });
    });
    
    // בדיקה אם יש בעיית rendering
    setTimeout(() => {
      const rect = videoEl.getBoundingClientRect();
      iosLog('RENDER', 'Bounding Rect', {
        width: rect.width.toFixed(0),
        height: rect.height.toFixed(0),
        top: rect.top.toFixed(0),
        left: rect.left.toFixed(0),
        visible: rect.width > 0 && rect.height > 0
      });
      
      // בדיקה אם הווידאו מנגן אבל לא נראה
      if (!videoEl.paused && videoEl.currentTime > 0) {
        if (rect.width === 0 || rect.height === 0) {
          iosLog('ERROR', '⚠️ הווידאו מנגן אבל הגודל הוא 0!');
        }
        if (videoEl.videoWidth === 0) {
          iosLog('ERROR', '⚠️ הווידאו מנגן אבל videoWidth הוא 0!');
        }
      }
    }, 2000);
  }

  // מעקב אחרי Blob URLs
  const originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function(blob) {
    const url = originalCreateObjectURL.call(this, blob);
    
    if (blob instanceof Blob) {
      iosLog('BLOB', 'נוצר Blob URL', {
        type: blob.type,
        size: (blob.size / 1024).toFixed(1) + 'KB',
        url: url.substring(0, 50)
      });
      
      // בדיקה אם ה-MIME type נכון
      if (blob.type && !blob.type.startsWith('video/')) {
        iosLog('WARNING', '⚠️ Blob type לא וידאו!', { type: blob.type });
      }
      if (!blob.type) {
        iosLog('WARNING', '⚠️ Blob ללא type!');
      }
    }
    
    return url;
  };

  // מעקב אחרי IndexedDB
  function monitorIndexedDB() {
    if (!window.indexedDB) {
      iosLog('ERROR', 'IndexedDB לא נתמך!');
      return;
    }
    
    // בדיקת מגבלות אחסון
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(estimate => {
        const usedMB = (estimate.usage / 1024 / 1024).toFixed(2);
        const quotaMB = (estimate.quota / 1024 / 1024).toFixed(2);
        const percent = ((estimate.usage / estimate.quota) * 100).toFixed(1);
        
        iosLog('CACHE', 'מצב אחסון', {
          used: usedMB + 'MB',
          quota: quotaMB + 'MB',
          percent: percent + '%'
        });
        
        if (estimate.usage / estimate.quota > 0.9) {
          iosLog('WARNING', '⚠️ האחסון כמעט מלא!');
        }
      }).catch(err => {
        iosLog('ERROR', 'שגיאה בבדיקת אחסון', { error: err.message });
      });
    }
  }

  // מעקב אחרי שגיאות גלובליות
  window.addEventListener('error', (e) => {
    if (e.message && (e.message.includes('video') || e.message.includes('media'))) {
      iosLog('ERROR', 'שגיאה גלובלית', {
        message: e.message.substring(0, 100),
        filename: e.filename?.split('/').pop()
      });
    }
  });

  // מעקב אחרי unhandled promise rejections
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason?.message || String(e.reason);
    if (reason.includes('video') || reason.includes('media') || reason.includes('blob')) {
      iosLog('ERROR', 'Promise rejection', { reason: reason.substring(0, 100) });
    }
  });

  // Observer למעקב אחרי וידאו חדשים שנוספים ל-DOM
  function startVideoObserver() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeName === 'VIDEO') {
            iosLog('VIDEO', 'וידאו חדש נוסף ל-DOM');
            monitorVideoElement(node, 'dynamic');
          }
          if (node.querySelectorAll) {
            node.querySelectorAll('video').forEach((video, i) => {
              monitorVideoElement(video, `dynamic-${i}`);
            });
          }
        });
      });
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
    iosLog('INFO', 'Video Observer הופעל');
  }

  // בדיקת וידאו קיימים
  function checkExistingVideos() {
    const videos = document.querySelectorAll('video');
    iosLog('VIDEO', `נמצאו ${videos.length} אלמנטי וידאו קיימים`);
    videos.forEach((video, i) => {
      monitorVideoElement(video, `existing-${i}`);
    });
  }

  // פונקציה לבדיקה ידנית של וידאו ספציפי
  window.debugVideo = function(selector) {
    const video = typeof selector === 'string' 
      ? document.querySelector(selector) 
      : selector;
    
    if (!video) {
      iosLog('ERROR', 'וידאו לא נמצא');
      return;
    }
    
    iosLog('INFO', '=== בדיקה ידנית של וידאו ===');
    
    // מידע בסיסי
    console.log('Video Element:', video);
    console.log('src:', video.src);
    console.log('currentSrc:', video.currentSrc);
    console.log('readyState:', video.readyState);
    console.log('networkState:', video.networkState);
    console.log('error:', video.error);
    console.log('videoWidth:', video.videoWidth);
    console.log('videoHeight:', video.videoHeight);
    console.log('duration:', video.duration);
    console.log('paused:', video.paused);
    console.log('muted:', video.muted);
    
    // CSS
    const style = window.getComputedStyle(video);
    console.log('CSS display:', style.display);
    console.log('CSS visibility:', style.visibility);
    console.log('CSS opacity:', style.opacity);
    console.log('CSS width:', style.width);
    console.log('CSS height:', style.height);
    
    // Bounding rect
    const rect = video.getBoundingClientRect();
    console.log('Bounding rect:', rect);
    
    // ניסיון לנגן
    iosLog('INFO', 'מנסה לנגן...');
    video.play().then(() => {
      iosLog('SUCCESS', 'הווידאו התחיל לנגן');
      setTimeout(() => {
        iosLog('INFO', 'מצב אחרי 1 שנייה', {
          currentTime: video.currentTime,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight
        });
      }, 1000);
    }).catch(err => {
      iosLog('ERROR', 'שגיאה בניגון', { error: err.message });
    });
  };

  // פונקציה לבדיקת URL ישירות
  window.testVideoURL = function(url) {
    iosLog('INFO', '=== בדיקת URL וידאו ===', { url: url.substring(0, 50) });
    
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = false;
    video.preload = 'auto';
    video.style.cssText = 'position:fixed;top:10px;left:10px;width:200px;height:150px;z-index:99999;background:red;';
    
    monitorVideoElement(video, 'test');
    
    video.src = url;
    document.body.appendChild(video);
    
    video.load();
    
    setTimeout(() => {
      video.play().catch(e => iosLog('ERROR', 'Play failed', { error: e.message }));
    }, 1000);
    
    iosLog('INFO', 'וידאו טסט נוסף לפינה השמאלית העליונה');
    
    return video;
  };

  // אתחול
  function init() {
    iosLog('INFO', `=== iOS Video Debug v${IOS_DEBUG_VERSION} ===`);
    
    if (!isIOS) {
      iosLog('INFO', 'לא iOS - הדיבוג יפעל בכל מקרה');
    }
    
    logDeviceInfo();
    checkCodecSupport();
    monitorIndexedDB();
    
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        checkExistingVideos();
        startVideoObserver();
      });
    } else {
      checkExistingVideos();
      startVideoObserver();
    }
    
    iosLog('SUCCESS', 'מודול דיבוג iOS הופעל');
    iosLog('INFO', 'פקודות זמינות: debugVideo(selector), testVideoURL(url)');
  }

  init();

})();
