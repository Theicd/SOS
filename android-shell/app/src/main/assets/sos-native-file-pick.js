// חלק מעטפת Native – בחירת קבצים ב-APK בלי להסתמך על input[type=file] של WebView
(function () {
  if (window.__sosNativeFilePickInjected) {
    if (typeof window.__sosWireNativeFilePick === 'function') {
      window.__sosWireNativeFilePick();
    }
    return;
  }
  window.__sosNativeFilePickInjected = true;

  var inflight = false;

  function disableHtmlFileInputs() {
    var nodes = document.querySelectorAll('#chatComposerFileInput, #composeMediaInput, input[type="file"]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      try {
        el.setAttribute('tabindex', '-1');
        el.style.setProperty('pointer-events', 'none', 'important');
        el.style.setProperty('position', 'absolute', 'important');
        el.style.setProperty('width', '1px', 'important');
        el.style.setProperty('height', '1px', 'important');
        el.style.setProperty('opacity', '0', 'important');
        el.style.setProperty('z-index', '-1', 'important');
      } catch (_) {}
    }
  }

  function pick(accept) {
    return new Promise(function (resolve) {
      var bridge = window.SosNativeShell;
      if (!bridge || typeof bridge.openFilePicker !== 'function') {
        console.warn('[SOS-NATIVE] openFilePicker missing on SosNativeShell');
        resolve(null);
        return;
      }
      if (inflight) {
        resolve(null);
        return;
      }
      inflight = true;
      var id = 'fp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      var done = false;
      function finish(files) {
        if (done) return;
        done = true;
        inflight = false;
        window.removeEventListener('sos-native-file-pick', onRes);
        resolve(files);
      }
      function onRes(ev) {
        var d = ev && ev.detail;
        if (!d || d.requestId !== id) return;
        var metas = d.files || [];
        if (!metas.length) {
          finish([]);
          return;
        }
        var pending = metas.length;
        var out = [];
        function stepDone() {
          pending -= 1;
          if (pending <= 0) finish(out);
        }
        for (var i = 0; i < metas.length; i++) {
          (function (m) {
            var url = m.url || (m.id ? ('https://sos-native.app/file/' + m.id) : '');
            if (!url) {
              stepDone();
              return;
            }
            fetch(url).then(function (res) {
              return res.blob();
            }).then(function (blob) {
              out.push(new File([blob], m.name || 'file', {
                type: m.type || blob.type || 'application/octet-stream'
              }));
              stepDone();
            }).catch(function (err) {
              console.warn('[SOS-NATIVE] file load failed', err);
              stepDone();
            });
          })(metas[i] || {});
        }
      }
      window.addEventListener('sos-native-file-pick', onRes);
      try {
        console.log('[SOS-NATIVE] calling openFilePicker', id, accept);
        bridge.openFilePicker(id, String(accept || '*/*'));
      } catch (err) {
        console.warn('[SOS-NATIVE] openFilePicker threw', err);
        finish(null);
        return;
      }
      setTimeout(function () { finish(null); }, 180000);
    });
  }

  function isChatAttachTarget(t) {
    if (!t || !t.closest) return false;
    return !!(t.closest('#chatComposerFileButton') || t.closest('#chatComposerFileInput') || t.closest('label[for="chatComposerFileInput"]'));
  }

  function isComposeUploadTarget(t) {
    if (!t || !t.closest) return false;
    return !!(t.closest('#composeUploadChoice') || t.closest('#composeMediaInput'));
  }

  function onDocClick(e) {
    var t = e.target;
    if (isChatAttachTarget(t)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      console.log('[SOS-NATIVE] chat attach click');
      pick((document.getElementById('chatComposerFileInput') || {}).accept || '*/*').then(function (files) {
        if (!files || !files[0]) return;
        var App = window.NostrApp || {};
        if (typeof App.handleChatFileSelection === 'function') {
          App.handleChatFileSelection(files[0]);
        }
      });
      return;
    }
    if (isComposeUploadTarget(t)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      console.log('[SOS-NATIVE] compose upload click');
      pick((document.getElementById('composeMediaInput') || {}).accept || 'image/*,video/*').then(function (files) {
        if (!files || !files[0]) return;
        var App = window.NostrApp || {};
        if (typeof App.handleComposeMediaFile === 'function') App.handleComposeMediaFile(files[0]);
        else if (typeof window.handleComposeMediaFile === 'function') window.handleComposeMediaFile(files[0]);
        else if (typeof window.handleMediaInput === 'function') {
          window.handleMediaInput({ target: { files: files, value: '' } });
        }
      });
    }
  }

  window.__sosWireNativeFilePick = function () {
    disableHtmlFileInputs();
  };

  document.addEventListener('click', onDocClick, true);
  document.addEventListener('touchend', function (e) {
    // חלק מובייל – חלק ממכשירי WebView בולעים click על label; touchend כגיבוי
    if (!e || !e.target) return;
    if (!isChatAttachTarget(e.target) && !isComposeUploadTarget(e.target)) return;
    // לא מונעים כאן – מחכים ל-click; אם אין click תוך 400ms מפעילים ידנית
    var target = e.target;
    setTimeout(function () {
      if (inflight) return;
      if (isChatAttachTarget(target) || isComposeUploadTarget(target)) {
        // אם click כבר טיפל – inflight יהיה true או שהדיאלוג פתוח
      }
    }, 0);
  }, true);

  disableHtmlFileInputs();
  setTimeout(disableHtmlFileInputs, 800);
  setTimeout(disableHtmlFileInputs, 2500);
  setInterval(disableHtmlFileInputs, 5000);
  console.log('[SOS-NATIVE] file picker document-delegation ready');
})();
