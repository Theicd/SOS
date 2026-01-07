(function initKeyViewer(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const modal = document.getElementById('keyModal');
  if (!modal) return;

  const textarea = document.getElementById('keyViewerTextarea');
  const statusLabel = document.getElementById('keyViewerStatus');

  function setStatus(message = '', tone = 'info') {
    if (!statusLabel) return;
    statusLabel.textContent = message;
    statusLabel.style.color = tone === 'error' ? '#ff6b6b' : '';
  }

  function ensureKeys() {
    if (typeof App.ensureKeys === 'function') {
      try {
        App.ensureKeys();
      } catch (err) {
        console.error('ensureKeys failed', err);
      }
    }
  }

  function getDisplayKey() {
    ensureKeys();
    const privateKey = App.privateKey;
    if (!privateKey) {
      return null;
    }
    if (typeof App.encodePrivateKey === 'function') {
      try {
        return App.encodePrivateKey(privateKey);
      } catch (err) {
        console.warn('encodePrivateKey failed', err);
      }
    }
    return privateKey;
  }

  function openKeyViewer() {
    const key = getDisplayKey();
    if (!key) {
      textarea.value = '';
      setStatus('לא נמצא מפתח לשחזור.', 'error');
    } else {
      textarea.value = key;
      setStatus('שמור את המפתח במקום בטוח.');
      textarea.focus();
      textarea.select();
    }
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeKeyViewer() {
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }

  function clearCredentials() {
    try {
      window.localStorage.removeItem('nostr_private_key');
      window.localStorage.removeItem('nostr_profile');
    } catch (err) {
      console.error('Failed clearing local credentials', err);
    }
    App.privateKey = null;
    App.publicKey = null;
  }

  async function copyKeyViewer() {
    if (!textarea.value) {
      setStatus('אין מפתח להעתקה.', 'error');
      return;
    }
    if (!navigator.clipboard) {
      setStatus('הדפדפן לא תומך בהעתקה אוטומטית.', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(textarea.value);
      setStatus('המפתח הועתק ללוח.');
    } catch (err) {
      console.error('Copy key failed', err);
      setStatus('נכשלה ההעתקה ללוח.', 'error');
    }
  }

  function logoutAndSwitchUser() {
    const confirmed = window.confirm('האם להתנתק מהמשתמש הנוכחי?');
    if (!confirmed) {
      return;
    }
    clearCredentials();
    closeKeyViewer();
    // חזרה לדף הווידאו במצב אורח | HYPER CORE TECH
    window.location.replace('videos.html');
  }

  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeKeyViewer();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.style.display === 'flex') {
      closeKeyViewer();
    }
  });

  Object.assign(App, {
    openKeyViewer,
    closeKeyViewer,
    copyKeyViewer,
    logoutAndSwitchUser,
  });

  window.openKeyViewer = openKeyViewer;
  window.closeKeyViewer = closeKeyViewer;
  window.copyKeyViewer = copyKeyViewer;
  window.logoutAndSwitchUser = logoutAndSwitchUser;
})(window);
