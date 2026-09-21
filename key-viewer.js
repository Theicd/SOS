(function initKeyViewer(window) {
  const reg = window.SOSIdentityStorageGeneration || (window.SOSIdentityStorageGeneration = {});
  reg['key-viewer.js'] = 'browser-secure-cutover-v1';
  window.SOS_IDENTITY_STORAGE_CODE_VERSION = 'browser-secure-cutover-v1';
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
        return App.ensureKeys();
      } catch (err) {
        console.error('ensureKeys failed', err);
        return { ok: false, state: App.IDENTITY_RECOVERY_REQUIRED || 'IDENTITY_RECOVERY_REQUIRED' };
      }
    }
    return { ok: false, state: App.IDENTITY_NEW_USER || 'IDENTITY_NEW_USER' };
  }

  function getDisplayKey() {
    const identity = ensureKeys();
    if (!identity || identity.ok !== true) {
      return null;
    }
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
    // Deprecated thin clear — prefer App.logoutIdentity for atomic Web+Native logout
    try {
      if (window.SOSKeyStorage && typeof window.SOSKeyStorage.clearPrivateKey === 'function') {
        window.SOSKeyStorage.clearPrivateKey();
      }
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
    closeKeyViewer();
    if (typeof App.logoutIdentity === 'function') {
      const result = App.logoutIdentity({ redirect: true, redirectUrl: 'videos.html' });
      if (!result || result.ok !== true) {
        setStatus('התנתקות נכשלה — נדרש שחזור זהות.', 'error');
        try {
          modal.style.display = 'flex';
          modal.setAttribute('aria-hidden', 'false');
        } catch (_e) {}
      }
      return;
    }
    // Fallback without lifecycle module
    clearCredentials();
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
