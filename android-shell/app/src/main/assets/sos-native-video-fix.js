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

      '/* תצוגה מקדימה לפני שליחה — כמו לייטבוקס: בלי פליי מערכת, רק תקציר */',
      '.chat-send-preview video::-webkit-media-controls-overlay-play-button,',
      '.chat-send-preview video::-webkit-media-controls-start-playback-button,',
      '.chat-send-preview video::-webkit-media-controls-enclosure,',
      '.chat-send-preview video::-webkit-media-controls-panel,',
      '.chat-send-preview video::-webkit-media-controls {',
      '  display: none !important;',
      '  opacity: 0 !important;',
      '  pointer-events: none !important;',
      '  width: 0 !important;',
      '  height: 0 !important;',
      '}',
      '.chat-send-preview video.sos-apk-send-pending {',
      '  opacity: 0 !important;',
      '  visibility: hidden !important;',
      '  background: #000 !important;',
      '  pointer-events: none !important;',
      '}',
      '.chat-send-preview video.sos-apk-send-ready {',
      '  opacity: 1 !important;',
      '  visibility: visible !important;',
      '  pointer-events: auto !important;',
      '}',
      '.chat-send-preview__stage { position: relative; }',
      '.chat-send-preview__apk-poster {',
      '  position: absolute;',
      '  inset: 0;',
      '  margin: auto;',
      '  max-width: 100%;',
      '  max-height: 100%;',
      '  width: auto;',
      '  height: auto;',
      '  object-fit: contain;',
      '  border-radius: 12px;',
      '  z-index: 3;',
      '  pointer-events: none;',
      '  background: #000;',
      '}',
      '.chat-send-preview__apk-poster[hidden] { display: none !important; }',
      '.chat-send-preview__apk-play {',
      '  position: absolute;',
      '  top: 50%;',
      '  left: 50%;',
      '  transform: translate(-50%, -50%);',
      '  width: 64px;',
      '  height: 64px;',
      '  border: none;',
      '  border-radius: 50%;',
      '  background: rgba(0,0,0,0.45);',
      '  z-index: 4;',
      '  cursor: pointer;',
      '  padding: 0;',
      '}',
      '.chat-send-preview__apk-play[hidden] { display: none !important; }',
      '.chat-send-preview__apk-play-icon {',
      '  display: block;',
      '  width: 0;',
      '  height: 0;',
      '  margin: 0 auto;',
      '  margin-inline-start: 22px;',
      '  border-style: solid;',
      '  border-width: 12px 0 12px 20px;',
      '  border-color: transparent transparent transparent #fff;',
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
    if (video.dataset.sosSendPreviewFixed === '1') return;
    video.dataset.sosSendPreviewFixed = '1';

    var stage = video.closest('.chat-send-preview__stage') || video.parentElement;
    if (!stage) return;

    try {
      stage.style.position = 'relative';
      // כמו לייטבוקס: מסתירים את משטח ה־video עד שיש תקציר / נגינה | HYPER CORE TECH
      video.classList.add('sos-apk-send-pending');
      video.classList.remove('sos-apk-send-ready');
      video.controls = false;
      video.muted = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.playsInline = true;
      video.preload = 'auto';
      video.style.background = '#000';
      // לא קוראים ל־load() מחדש — מאט את הפריים הראשון ב־WebView | HYPER CORE TECH
    } catch (_) {}

    function ensureUi() {
      var poster = stage.querySelector('.chat-send-preview__apk-poster');
      if (!poster) {
        poster = document.createElement('img');
        poster.className = 'chat-send-preview__apk-poster';
        poster.alt = '';
        poster.setAttribute('aria-hidden', 'true');
        stage.appendChild(poster);
      }
      var playBtn = stage.querySelector('.chat-send-preview__apk-play');
      if (!playBtn) {
        playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'chat-send-preview__apk-play';
        playBtn.setAttribute('aria-label', 'נגן');
        playBtn.innerHTML = '<span class="chat-send-preview__apk-play-icon" aria-hidden="true"></span>';
        stage.appendChild(playBtn);
        playBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          startUserPlay();
        });
      }
      return { poster: poster, playBtn: playBtn };
    }

    function revealForUser() {
      try {
        video.classList.remove('sos-apk-send-pending');
        video.classList.add('sos-apk-send-ready');
        video.controls = true;
        video.muted = false;
        var ui = ensureUi();
        ui.poster.hidden = true;
        ui.playBtn.hidden = true;
      } catch (_) {}
    }

    function startUserPlay() {
      revealForUser();
      try {
        var p = video.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (_) {}
    }

    function applyPoster(dataUrl) {
      if (!dataUrl || dataUrl.length < 200) return false;
      try {
        video.poster = dataUrl;
        video.setAttribute('poster', dataUrl);
        video.dataset.sosSendPoster = '1';
        var ui = ensureUi();
        ui.poster.src = dataUrl;
        ui.poster.hidden = false;
        ui.playBtn.hidden = false;
        // נשארים על תקציר — הווידאו מוסתר (בלי פליי לבן) | HYPER CORE TECH
        video.classList.add('sos-apk-send-pending');
        video.classList.remove('sos-apk-send-ready');
        video.controls = false;
        return true;
      } catch (_) {
        return false;
      }
    }

    function grabFromVideo() {
      try {
        if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return '';
        var maxW = 720;
        var scale = Math.min(1, maxW / video.videoWidth);
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        var ctx = canvas.getContext('2d');
        if (!ctx) return '';
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        return dataUrl && dataUrl.length > 200 ? dataUrl : '';
      } catch (_) {
        return '';
      }
    }

    async function captureFrame() {
      if (video.dataset.sosSendPoster === '1') return;
      if (video.dataset.sosSendCapturing === '1') return;
      video.dataset.sosSendCapturing = '1';

      try {
        // נתיב מהיר בלבד — בלי capturePosterFromBlob (פענוח כפול של כל הקובץ) | HYPER CORE TECH
        video.muted = true;
        video.classList.add('sos-apk-send-pending');
        if (video.readyState < 1) {
          await new Promise(function (r) {
            video.addEventListener('loadedmetadata', function () { r(); }, { once: true });
            setTimeout(r, 800);
          });
        }
        var p = video.play();
        if (p && typeof p.then === 'function') await p.catch(function () {});
        await new Promise(function (r) { setTimeout(r, 60); });
        try { video.pause(); } catch (_) {}

        var shot = grabFromVideo();
        if (!shot) {
          var duration = isFinite(video.duration) ? video.duration : 0;
          var target = duration > 0.3 ? Math.min(0.12, duration * 0.02) : 0.04;
          try {
            if (typeof video.fastSeek === 'function') video.fastSeek(target);
            else video.currentTime = target;
          } catch (_) {}
          await new Promise(function (r) {
            video.addEventListener('seeked', function () { r(); }, { once: true });
            setTimeout(r, 250);
          });
          shot = grabFromVideo();
        }
        if (!shot) {
          try { video.currentTime = 0.001; } catch (_) {}
          await new Promise(function (r) { setTimeout(r, 120); });
          shot = grabFromVideo();
        }
        if (shot) applyPoster(shot);
        else ensureUi();
        try { video.pause(); } catch (_) {}
      } catch (_) {
        ensureUi();
      } finally {
        try { delete video.dataset.sosSendCapturing; } catch (_) {}
      }
    }

    ensureUi();
    video.addEventListener('play', function () {
      if (!video.classList.contains('sos-apk-send-pending')) revealForUser();
    });
    // טריגר אחד מהיר — בלי 500/1500 כפולים | HYPER CORE TECH
    video.addEventListener('loadeddata', function () { captureFrame(); }, { once: true });
    if (video.readyState >= 2) captureFrame();
    else if (video.readyState >= 1) {
      setTimeout(function () { captureFrame(); }, 80);
    } else {
      video.addEventListener('loadedmetadata', function () { captureFrame(); }, { once: true });
      setTimeout(function () { captureFrame(); }, 400);
    }
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
