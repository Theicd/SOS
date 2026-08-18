// חלק מעטפת Native – רק הסתרת פליי-מערכת של WebView בבועות צ'אט (לא לייטבוקס / לא ווב) | HYPER CORE TECH
(function () {
  if (window.__sosNativeVideoFixInjected) return;
  window.__sosNativeVideoFixInjected = true;

  var STYLE_ID = 'sos-native-video-fix-style';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    // חשוב: לא נוגעים ב־.chat-lightbox video — שם הווידאו חייב להופיע | HYPER CORE TECH
    style.textContent = [
      '/* APK בלבד: הסתרת כפתור פליי מערכת בבועת צ\'אט / העלאה / תצוגה מקדימה */',
      '.chat-message__video-container video::-webkit-media-controls-overlay-play-button,',
      '.chat-message__video-container video::-webkit-media-controls-start-playback-button,',
      '.chat-media-upload video::-webkit-media-controls-overlay-play-button,',
      '.chat-media-upload video::-webkit-media-controls-start-playback-button,',
      '.chat-send-preview video::-webkit-media-controls-overlay-play-button,',
      '.chat-send-preview video::-webkit-media-controls-start-playback-button {',
      '  display: none !important;',
      '  opacity: 0 !important;',
      '  pointer-events: none !important;',
      '  width: 0 !important;',
      '  height: 0 !important;',
      '}',
      '.chat-message__video-container video,',
      '.chat-media-upload video {',
      '  background-color: #000 !important;',
      '}',
      '/* לייטבוקס מסך מלא — ללא שינוי, וידאו גלוי */',
      '.chat-lightbox video,',
      '.chat-lightbox__stage video,',
      '#chatImageLightbox video,',
      '.chat-lightbox video::-webkit-media-controls-overlay-play-button {',
      '  display: revert !important;',
      '  opacity: revert !important;',
      '  visibility: visible !important;',
      '  width: revert !important;',
      '  height: revert !important;',
      '  pointer-events: auto !important;',
      '}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function isLightboxVideo(video) {
    if (!video || !video.closest) return false;
    return !!video.closest('.chat-lightbox, #chatImageLightbox, #chatYouTubeLightbox');
  }

  function hardenBubbleVideo(video) {
    if (!video || video.nodeName !== 'VIDEO') return;
    if (isLightboxVideo(video)) return;
    if (video.dataset.sosNativeVideoHardened === '1') return;
    // רק בועות צ'אט / העלאה / תצוגת שליחה | HYPER CORE TECH
    if (!video.closest('.chat-message__video-container, .chat-media-upload, .chat-send-preview')) {
      return;
    }
    video.dataset.sosNativeVideoHardened = '1';
    try {
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.playsInline = true;
      video.style.backgroundColor = '#000';
      if (!video.getAttribute('poster')) {
        video.setAttribute(
          'poster',
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
        );
      }
    } catch (_) {}
  }

  function scan(root) {
    var scope = root && root.querySelectorAll ? root : document;
    if (!scope.querySelectorAll) return;
    var list = scope.querySelectorAll(
      '.chat-message__video-container video, .chat-media-upload video, .chat-send-preview video'
    );
    for (var i = 0; i < list.length; i++) hardenBubbleVideo(list[i]);
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
            if (n.closest && n.closest('.chat-lightbox, #chatImageLightbox')) continue;
            scan(n);
          }
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      window.__sosNativeVideoObserver = obs;
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
