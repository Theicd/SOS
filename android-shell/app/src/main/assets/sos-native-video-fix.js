// חלק מעטפת Native – הסתרת פליי לבן של Android WebView על <video> | HYPER CORE TECH
(function () {
  if (window.__sosNativeVideoFixInjected) return;
  window.__sosNativeVideoFixInjected = true;

  var STYLE_ID = 'sos-native-video-fix-style';
  var BLACK_POSTER =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '/* מעטפת APK: חוסם פליי מערכת של Chromium/WebView */',
      'video::-webkit-media-controls-overlay-play-button,',
      'video::-webkit-media-controls-start-playback-button,',
      'video::-webkit-media-controls-enclosure,',
      'video::-webkit-media-controls-panel,',
      'video::-webkit-media-controls {',
      '  display: none !important;',
      '  -webkit-appearance: none !important;',
      '  opacity: 0 !important;',
      '  width: 0 !important;',
      '  height: 0 !important;',
      '  pointer-events: none !important;',
      '  appearance: none !important;',
      '}',
      '.chat-message__video-container video,',
      '.chat-media-upload video,',
      '.chat-send-preview__video,',
      '.chat-send-preview video {',
      '  background: #000 !important;',
      '}',
      'html[data-sos-native="1"] .chat-message__video-container video:not(.is-playing),',
      'html[data-sos-native="1"] .chat-media-upload video:not(.is-playing),',
      'html[data-sos-native="1"] .chat-send-preview__video-wrap:not(.is-playing) video {',
      '  opacity: 0 !important;',
      '  visibility: hidden !important;',
      '}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function isUsablePoster(p) {
    return typeof p === 'string' && p.indexOf('data:image/') === 0 && p.length > 200 && p !== BLACK_POSTER;
  }

  function capturePoster(video) {
    if (!video || video.dataset.sosNativePoster === '1') return false;
    if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return false;
    try {
      var maxW = 640;
      var scale = Math.min(1, maxW / video.videoWidth);
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      var ctx = canvas.getContext('2d');
      if (!ctx) return false;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      var dataUrl = canvas.toDataURL('image/jpeg', 0.78);
      if (!isUsablePoster(dataUrl)) return false;
      video.poster = dataUrl;
      video.dataset.sosNativePoster = '1';
      video.dataset.posterCaptured = '1';
      var wrap = video.closest('.chat-message__video-container, .chat-media-upload, .chat-send-preview__video-wrap');
      if (wrap) {
        var thumb = wrap.querySelector('.chat-message__video-thumb, .chat-send-preview__poster');
        if (thumb) {
          thumb.src = dataUrl;
          thumb.hidden = false;
        }
        wrap.classList.add('has-video-thumb', 'has-poster', 'has-poster-bg');
        try {
          wrap.style.backgroundImage = 'url("' + dataUrl + '")';
          wrap.style.backgroundSize = 'cover';
          wrap.style.backgroundPosition = 'center';
          wrap.style.backgroundColor = '#000';
        } catch (_) {}
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function hardenVideo(video) {
    if (!video || video.nodeName !== 'VIDEO') return;
    if (video.dataset.sosNativeVideoHardened === '1') return;
    video.dataset.sosNativeVideoHardened = '1';
    try {
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.playsInline = true;
      video.style.background = '#000';
      if (!isUsablePoster(video.getAttribute('poster') || video.poster || '')) {
        video.setAttribute('poster', BLACK_POSTER);
      }
    } catch (_) {}

    var tryCapture = function () {
      if (capturePoster(video)) return;
      // play קצר מצייר פריים ב־WebView | HYPER CORE TECH
      try {
        var wasMuted = video.muted;
        video.muted = true;
        var p = video.play();
        if (p && typeof p.then === 'function') {
          p.catch(function () {}).then(function () {
            try { video.pause(); } catch (_) {}
            video.muted = wasMuted;
            capturePoster(video);
          });
        } else {
          try { video.pause(); } catch (_) {}
          video.muted = wasMuted;
          capturePoster(video);
        }
      } catch (_) {}
    };

    video.addEventListener('loadeddata', tryCapture, { once: true });
    video.addEventListener('loadedmetadata', tryCapture, { once: true });
    video.addEventListener('seeked', function () { capturePoster(video); }, { once: true });
    if (video.readyState >= 2) tryCapture();
  }

  function scan(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var list = scope.querySelectorAll
      ? scope.querySelectorAll(
          '.chat-message__video-container video, .chat-media-upload video, .chat-send-preview video, video.chat-message__video, video.chat-media-upload__media, video.chat-send-preview__media, video.chat-send-preview__video'
        )
      : [];
    for (var i = 0; i < list.length; i++) hardenVideo(list[i]);
    if (root && root.nodeName === 'VIDEO') hardenVideo(root);
  }

  function boot() {
    ensureStyle();
    try {
      document.documentElement.setAttribute('data-sos-native', '1');
    } catch (_) {}
    scan(document);
    if (window.__sosNativeVideoObserver) return;
    try {
      var obs = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          if (m.type === 'childList') {
            for (var j = 0; j < m.addedNodes.length; j++) {
              var n = m.addedNodes[j];
              if (!n || n.nodeType !== 1) continue;
              scan(n);
            }
          } else if (m.type === 'attributes' && m.target && m.target.nodeName === 'VIDEO') {
            hardenVideo(m.target);
          }
        }
      });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'poster']
      });
      window.__sosNativeVideoObserver = obs;
    } catch (_) {}
    setTimeout(function () { scan(document); }, 400);
    setTimeout(function () { scan(document); }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
  window.__sosNativeVideoFix = { rescan: function () { ensureStyle(); scan(document); } };
})();
