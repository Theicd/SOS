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

  function showFileLoading(label) {
    try {
      var A = window.NostrApp || {};
      if (typeof A.showChatFilePickLoading === 'function') {
        A.showChatFilePickLoading(label || 'טוען...');
      }
    } catch (_) {}
  }

  function hideFileLoading() {
    try {
      var A = window.NostrApp || {};
      if (typeof A.hideChatFilePickLoading === 'function') {
        A.hideChatFilePickLoading();
      }
    } catch (_) {}
  }

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

  function base64ToFile(b64, name, type) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], name || 'file', { type: type || 'application/octet-stream' });
  }

  function metaToFile(m) {
    return new Promise(function (resolve, reject) {
      if (!m) {
        reject(new Error('empty-meta'));
        return;
      }
      if (m.base64) {
        try {
          resolve(base64ToFile(m.base64, m.name, m.type));
        } catch (err) {
          reject(err);
        }
        return;
      }
      var url = m.url || (m.id ? ('https://sos-native.app/file/' + m.id) : '');
      if (!url) {
        reject(new Error('missing-url'));
        return;
      }
      fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('native file fetch ' + res.status);
          return res.blob();
        })
        .then(function (blob) {
          resolve(new File([blob], m.name || 'file', {
            type: m.type || blob.type || 'application/octet-stream'
          }));
        })
        .catch(reject);
    });
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
        if (!files || !files.length) hideFileLoading();
        resolve(files);
      }
      function onRes(ev) {
        var d = ev && ev.detail;
        if (!d || d.requestId !== id) return;
        var metas = d.files || [];
        console.log('[SOS-NATIVE] pick result count=' + metas.length);
        if (!metas.length) {
          finish([]);
          return;
        }
        // מחזיקים שכבת טעינה בזמן המרה ל-File (base64/fetch) – בלי show חוזר שמבטל הסתרה | HYPER CORE TECH
        var pending = metas.length;
        var out = [];
        function stepDone() {
          pending -= 1;
          if (pending <= 0) finish(out);
        }
        for (var i = 0; i < metas.length; i++) {
          (function (m) {
            metaToFile(m).then(function (file) {
              console.log('[SOS-NATIVE] file ready', file && file.name, file && file.type, file && file.size);
              out.push(file);
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
    return !!(t.closest('#chatComposerFileButton') || t.closest('#chatComposerTrashButton') || t.closest('#chatComposerFileInput') || t.closest('label[for="chatComposerFileInput"]'));
  }

  function isComposeUploadTarget(t) {
    if (!t || !t.closest) return false;
    return !!(t.closest('#composeUploadChoice') || t.closest('#composeMediaInput'));
  }

  function deliverToChat(file) {
    var App = window.NostrApp || {};
    if (typeof App.openChatSendPreview === 'function') {
      try {
        App.openChatSendPreview(file);
        hideFileLoading();
        return true;
      } catch (err) {
        console.error('[SOS-NATIVE] openChatSendPreview failed', err);
      }
    }
    if (typeof App.handleChatFileSelection === 'function') {
      hideFileLoading();
      Promise.resolve(App.handleChatFileSelection(file)).catch(function (err) {
        console.error('[SOS-NATIVE] handleChatFileSelection failed', err);
      });
      return true;
    }
    console.warn('[SOS-NATIVE] App.handleChatFileSelection missing');
    hideFileLoading();
    return false;
  }

  function deliverToCompose(file) {
    var App = window.NostrApp || {};
    if (typeof App.handleComposeMediaFile === 'function') {
      Promise.resolve(App.handleComposeMediaFile(file)).catch(function (err) {
        console.error('[SOS-NATIVE] handleComposeMediaFile failed', err);
      });
      return true;
    }
    if (typeof window.handleComposeMediaFile === 'function') {
      Promise.resolve(window.handleComposeMediaFile(file)).catch(function (err) {
        console.error('[SOS-NATIVE] window.handleComposeMediaFile failed', err);
      });
      return true;
    }
    if (typeof window.handleMediaInput === 'function') {
      Promise.resolve(window.handleMediaInput({ target: { files: [file], value: '' } })).catch(function (err) {
        console.error('[SOS-NATIVE] handleMediaInput failed', err);
      });
      return true;
    }
    console.warn('[SOS-NATIVE] compose media handler missing');
    return false;
  }

  function onDocClick(e) {
    var t = e.target;
    var App = window.NostrApp || {};
    if (isChatAttachTarget(t) && typeof App.isChatSendPreviewOpen === 'function' && App.isChatSendPreviewOpen()) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      if (typeof App.closeChatSendPreview === 'function') App.closeChatSendPreview();
      return;
    }
    if (isChatAttachTarget(t)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      console.log('[SOS-NATIVE] chat attach click');
      pick((document.getElementById('chatComposerFileInput') || {}).accept || '*/*').then(function (files) {
        if (!files || !files[0]) {
          console.warn('[SOS-NATIVE] chat pick returned no file');
          hideFileLoading();
          return;
        }
        deliverToChat(files[0]);
      });
      return;
    }
    if (isComposeUploadTarget(t)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      console.log('[SOS-NATIVE] compose upload click');
      pick((document.getElementById('composeMediaInput') || {}).accept || 'image/*,video/*').then(function (files) {
        if (!files || !files[0]) {
          console.warn('[SOS-NATIVE] compose pick returned no file');
          hideFileLoading();
          return;
        }
        hideFileLoading();
        deliverToCompose(files[0]);
      });
    }
  }

  window.__sosWireNativeFilePick = function () {
    disableHtmlFileInputs();
  };

  document.addEventListener('click', onDocClick, true);

  disableHtmlFileInputs();
  setTimeout(disableHtmlFileInputs, 800);
  setTimeout(disableHtmlFileInputs, 2500);
  setInterval(disableHtmlFileInputs, 5000);

  window.addEventListener('sos-native-keyboard-media', function (ev) {
    if (window.__sosKeyboardMediaHandledAt && (Date.now() - window.__sosKeyboardMediaHandledAt) < 1500) {
      console.log('[SOS-NATIVE] keyboard media ignored (dedupe)');
      return;
    }
    window.__sosKeyboardMediaHandledAt = Date.now();
    var d = ev && ev.detail;
    var meta = d && d.file;
    if (!meta) {
      console.warn('[SOS-NATIVE] keyboard media missing file meta');
      return;
    }
    console.log('[SOS-NATIVE] keyboard media', meta.name, meta.type, meta.size);
    showFileLoading('טוען...');
    metaToFile(meta).then(function (file) {
      if (!deliverToChat(file)) {
        hideFileLoading();
        console.warn('[SOS-NATIVE] keyboard GIF not delivered – open a chat first');
      }
    }).catch(function (err) {
      hideFileLoading();
      console.warn('[SOS-NATIVE] keyboard media load failed', err);
    });
  });

  console.log('[SOS-NATIVE] file picker document-delegation ready (base64+cors+keyboard-gif)');
})();
