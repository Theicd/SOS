// חלק מעטפת Native – תיקוני וידאו ל־APK בלבד (לא משנים לוגיקת PWA) | HYPER CORE TECH
(function () {
  if (window.__sosNativeVideoFixInjected) {
    try {
      if (typeof window.__sosNativeVideoFixRescan === 'function') window.__sosNativeVideoFixRescan();
    } catch (_) {}
    return;
  }
  window.__sosNativeVideoFixInjected = true;

  var STYLE_ID = 'sos-native-video-fix-style';

  function ensureStyle() {
    var existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '/* בועות צ\'אט בלבד: הסתרת פליי מערכת של WebView */',
      '.chat-message__video-container video::-webkit-media-controls-overlay-play-button,',
      '.chat-message__video-container video::-webkit-media-controls-start-playback-button,',
      '.chat-media-upload video::-webkit-media-controls-overlay-play-button,',
      '.chat-media-upload video::-webkit-media-controls-start-playback-button {',
      '  display: none !important;',
      '  opacity: 0 !important;',
      '  pointer-events: none !important;',
      '  width: 0 !important;',
      '  height: 0 !important;',
      '}',

      '/* לייטבוקס: מסתירים פליי מערכת (לא revert!) */',
      '.chat-lightbox video::-webkit-media-controls-overlay-play-button,',
      '.chat-lightbox video::-webkit-media-controls-start-playback-button,',
      '#chatMediaLightbox video::-webkit-media-controls-overlay-play-button,',
      '#chatImageLightbox video::-webkit-media-controls-overlay-play-button {',
      '  display: none !important;',
      '  opacity: 0 !important;',
      '  pointer-events: none !important;',
      '  width: 0 !important;',
      '  height: 0 !important;',
      '}',

      '/* עד שיש פריים אמיתי — וידאו הלייטבוקס מוסתר מאחורי poster/רקע שחור */',
      '.chat-lightbox video.sos-apk-video-pending,',
      '#chatMediaLightbox video.sos-apk-video-pending {',
      '  opacity: 0 !important;',
      '  background: #000 !important;',
      '}',
      '.chat-lightbox video.sos-apk-video-ready,',
      '#chatMediaLightbox video.sos-apk-video-ready {',
      '  opacity: 1 !important;',
      '}',

      '/* תצוגה מקדימה לפני שליחה — לא נוגעים בנראות/controls של הווידאו */',
      '.chat-send-preview video {',
      '  background: #000 !important;',
      '  opacity: 1 !important;',
      '  visibility: visible !important;',
      '}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function findPosterFromChatBubble(src) {
    if (!src) return '';
    try {
      var nodes = document.querySelectorAll(
        '.chat-message__video-thumb[src], .chat-message__video[poster], .chat-media-upload video[poster]'
      );
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var poster = el.getAttribute('src') || el.getAttribute('poster') || '';
        if (poster && poster.indexOf('data:image/') === 0 && poster.length > 200) return poster;
      }
      var containers = document.querySelectorAll('[data-media-src]');
      for (var j = 0; j < containers.length; j++) {
        var c = containers[j];
        if ((c.getAttribute('data-media-src') || '') === src) {
          var thumb = c.querySelector('.chat-message__video-thumb');
          if (thumb && thumb.src && thumb.src.indexOf('data:image/') === 0) return thumb.src;
          var v = c.querySelector('video');
          if (v && v.poster && v.poster.indexOf('data:image/') === 0 && v.poster.length > 200) {
            return v.poster;
          }
        }
      }
    } catch (_) {}
    return '';
  }

  function armLightboxVideo(video) {
    if (!video || video.nodeName !== 'VIDEO') return;
    if (!video.closest('.chat-lightbox, #chatMediaLightbox, #chatImageLightbox')) return;
    if (video.dataset.sosApkLightboxArmed === '1') return;
    video.dataset.sosApkLightboxArmed = '1';

    try {
      video.classList.add('sos-apk-video-pending');
      video.style.background = '#000';
      var src =
        (video.currentSrc || video.src || '') ||
        ((video.querySelector('source') && video.querySelector('source').src) || '');
      var poster = findPosterFromChatBubble(src);
      if (poster) {
        video.setAttribute('poster', poster);
        video.poster = poster;
      }
    } catch (_) {}

    var revealed = false;
    var reveal = function () {
      if (revealed) return;
      revealed = true;
      try {
        video.classList.remove('sos-apk-video-pending');
        video.classList.add('sos-apk-video-ready');
      } catch (_) {}
    };

    video.addEventListener('playing', reveal, { once: true });
    video.addEventListener('loadeddata', function () {
      if (video.readyState >= 2) reveal();
    });
    video.addEventListener('canplay', function () {
      if (video.readyState >= 2) reveal();
    });
    // גיבוי: לא להשאיר מוסתר לנצח | HYPER CORE TECH
    setTimeout(reveal, 2500);

    try {
      var p = video.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (_) {}
  }

  function hardenBubbleOnly(video) {
    if (!video || video.nodeName !== 'VIDEO') return;
    if (video.closest('.chat-lightbox, #chatMediaLightbox, .chat-send-preview')) return;
    if (!video.closest('.chat-message__video-container, .chat-media-upload')) return;
    if (video.dataset.sosNativeVideoHardened === '1') return;
    video.dataset.sosNativeVideoHardened = '1';
    try {
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.playsInline = true;
      video.style.backgroundColor = '#000';
    } catch (_) {}
  }

  function fixSendPreviewVideo(video) {
    if (!video || video.nodeName !== 'VIDEO') return;
    if (!video.closest('.chat-send-preview')) return;
    // מבטיחים שהווידאו נשאר גלוי עם controls ב־APK | HYPER CORE TECH
    try {
      video.style.opacity = '1';
      video.style.visibility = 'visible';
      video.style.display = 'block';
      video.style.background = '#000';
      video.controls = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.playsInline = true;
      video.preload = video.preload || 'metadata';
      if (!video.src && video.querySelector('source')) {
        /* source כבר קיים */
      }
      // אם אין src בכלל — לא נוגעים (ה־PWA אמור לשים) | HYPER CORE TECH
      var paint = function () {
        try {
          if (!video.videoWidth || video.readyState < 2) return;
          if (video.dataset.sosSendPoster === '1') return;
          var canvas = document.createElement('canvas');
          var scale = Math.min(1, 640 / video.videoWidth);
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          var ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          var dataUrl = canvas.toDataURL('image/jpeg', 0.8);
          if (dataUrl && dataUrl.length > 200) {
            video.poster = dataUrl;
            video.dataset.sosSendPoster = '1';
          }
        } catch (_) {}
      };
      video.addEventListener('loadeddata', paint, { once: true });
      if (video.readyState >= 2) paint();
    } catch (_) {}
  }

  function scan(root) {
    var scope = root && root.querySelectorAll ? root : document;
    if (!scope.querySelectorAll) return;

    var lightboxVideos = scope.querySelectorAll
      ? scope.querySelectorAll('.chat-lightbox video, #chatMediaLightbox video')
      : [];
    for (var i = 0; i < lightboxVideos.length; i++) armLightboxVideo(lightboxVideos[i]);

    var bubbleVideos = scope.querySelectorAll
      ? scope.querySelectorAll('.chat-message__video-container video, .chat-media-upload video')
      : [];
    for (var j = 0; j < bubbleVideos.length; j++) hardenBubbleOnly(bubbleVideos[j]);

    var sendVideos = scope.querySelectorAll ? scope.querySelectorAll('.chat-send-preview video') : [];
    for (var k = 0; k < sendVideos.length; k++) fixSendPreviewVideo(sendVideos[k]);

    if (root && root.nodeName === 'VIDEO') {
      armLightboxVideo(root);
      hardenBubbleOnly(root);
      fixSendPreviewVideo(root);
    }
  }

  function boot() {
    ensureStyle();
    scan(document);
    if (window.__sosNativeVideoObserver) return;
    try {
      var obs = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          if (m.type !== 'childList') continue;
          for (var j = 0; j < m.addedNodes.length; j++) {
            var n = m.addedNodes[j];
            if (!n || n.nodeType !== 1) continue;
            scan(n);
          }
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      window.__sosNativeVideoObserver = obs;
    } catch (_) {}
    setTimeout(function () { scan(document); }, 300);
  }

  window.__sosNativeVideoFixRescan = function () {
    ensureStyle();
    scan(document);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
