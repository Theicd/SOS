(function initAccount(window) {
  const reg = window.SOSIdentityStorageGeneration || (window.SOSIdentityStorageGeneration = {});
  reg['account.js'] = 'browser-secure-cutover-v1';
  window.SOS_IDENTITY_STORAGE_CODE_VERSION = 'browser-secure-cutover-v1';
  const App = window.NostrApp || (window.NostrApp = {});
  const modal = document.getElementById('accountModal');
  if (!modal) {
    return;
  }

  const exportTextarea = document.getElementById('accountExportKey');
  const importTextarea = document.getElementById('accountImportInput');
  const statusLabel = document.getElementById('accountStatus');
  const copyButton = document.getElementById('accountCopyKeyButton');
  const downloadButton = document.getElementById('accountDownloadBackupButton');
  const importButton = document.getElementById('accountImportButton');

  function setStatus(message = '', tone = 'info') {
    if (!statusLabel) return;
    statusLabel.textContent = message;
    statusLabel.style.color = tone === 'error' ? '#f02849' : '';
  }

  function resetStatus() {
    setStatus('');
  }

  function ensurePrivateKey() {
    try {
      if (typeof App.ensureKeys === 'function') {
        const result = App.ensureKeys();
        // Guest / invalid: never auto-create identity from account modal
        if (!result || result.ok !== true) {
          return result || { ok: false, state: App.IDENTITY_NEW_USER || 'IDENTITY_NEW_USER' };
        }
        return result;
      }
    } catch (err) {
      console.error('ensureKeys failed', err);
    }
    return { ok: false, state: App.IDENTITY_NEW_USER || 'IDENTITY_NEW_USER' };
  }

  function encodePrivateKey(privateKey) {
    const trimmed = (privateKey || '').trim();
    if (!trimmed) return '';
    const nip19 = App.nip19 || window.NostrTools?.nip19;
    if (!nip19) return trimmed;
    try {
      return nip19.nsecEncode(trimmed);
    } catch (err) {
      console.warn('Failed to encode nsec', err);
      return trimmed;
    }
  }

  function decodePrivateKey(input) {
    if (!input) return null;
    const trimmed = input.trim();
    if (!trimmed) return null;

    const nip19 = App.nip19 || window.NostrTools?.nip19;
    if (trimmed.startsWith('nsec') && nip19) {
      try {
        const decoded = nip19.decode(trimmed);
        if (decoded?.type === 'nsec' && typeof decoded.data === 'string') {
          return decoded.data;
        }
      } catch (err) {
        console.warn('nsec decode failed', err);
      }
    }

    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return trimmed.toLowerCase();
    }

    return null;
  }

  function openAccount() {
    const identity = ensurePrivateKey();
    const privateKey = identity && identity.ok ? (App.privateKey || '') : '';
    if (exportTextarea) {
      exportTextarea.value = privateKey ? encodePrivateKey(privateKey) : '';
    }
    if (importTextarea) {
      importTextarea.value = '';
    }
    resetStatus();
    if (!identity || identity.ok !== true) {
      if (identity && identity.state === (App.IDENTITY_INVALID || 'IDENTITY_INVALID')) {
        setStatus('המפתח השמור אינו תקין. ייבאו מפתח גיבוי או צרו חשבון מחדש.', 'error');
      } else if (identity && identity.state === (App.IDENTITY_RECOVERY_REQUIRED || 'IDENTITY_RECOVERY_REQUIRED')) {
        setStatus('נדרש שחזור זהות. ייבאו את המפתח הפרטי שלכם.', 'error');
      }
    }
    modal.classList.add('is-visible');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeAccount() {
    modal.classList.remove('is-visible');
    modal.setAttribute('aria-hidden', 'true');
  }

  async function copyToClipboard() {
    if (!navigator.clipboard || !exportTextarea) {
      setStatus('הדפדפן לא תומך בהעתקה אוטומטית.', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(exportTextarea.value);
      setStatus('הועתק ללוח הזיכרון.');
    } catch (err) {
      console.error('Copy failed', err);
      setStatus('השמירה ללוח נכשלה.', 'error');
    }
  }

  function downloadBackup() {
    if (!exportTextarea?.value) {
      setStatus('אין מפתח לייצא.', 'error');
      return;
    }
    const blob = new Blob([exportTextarea.value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'nostr-private-key.txt';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setStatus('קובץ הגיבוי נשמר.');
  }

  function applyImportedKey(privateKey) {
    if (!privateKey) {
      setStatus('המפתח אינו תקין.', 'error');
      return false;
    }
    // Two-phase Stage 5E-D: prepare (no mutate) → commit (atomic switch)
    if (typeof App.prepareAccountSwitch === 'function' && typeof App.commitAccountSwitch === 'function') {
      const prepared = App.prepareAccountSwitch(privateKey);
      if (!prepared || !prepared.ok) {
        setStatus('המפתח אינו תקין. הזהות הקיימת לא שונתה.', 'error');
        return false;
      }
      const committed = App.commitAccountSwitch(prepared, { reload: true });
      if (!committed || !committed.ok) {
        if (committed && committed.state === 'IDENTITY_RECOVERY_REQUIRED') {
          setStatus('מעבר חשבון נכשל — נדרש שחזור זהות.', 'error');
        } else {
          setStatus('המפתח אינו תקין. הזהות הקיימת לא שונתה.', 'error');
        }
        return false;
      }
      setStatus('המפתח נטען בהצלחה. מומלץ לרענן את העמוד.');
      return true;
    }

    // Legacy fallback (pre-lifecycle): validate before write
    let normalized = null;
    try {
      if (typeof App.normalizePrivateKey === 'function') {
        normalized = App.normalizePrivateKey(privateKey, { persist: false });
      } else if (/^[0-9a-fA-F]{64}$/.test(String(privateKey).trim())) {
        normalized = String(privateKey).trim().toLowerCase();
      }
    } catch (_e) {
      normalized = null;
    }
    if (!normalized || !/^[0-9a-f]{64}$/.test(normalized)) {
      setStatus('המפתח אינו תקין. הזהות הקיימת לא שונתה.', 'error');
      return false;
    }
    try {
      const getPublicKey = App.getPublicKey || window.NostrTools?.getPublicKey;
      if (typeof getPublicKey === 'function') {
        getPublicKey(normalized);
      }
    } catch (_err) {
      setStatus('המפתח אינו תקין. הזהות הקיימת לא שונתה.', 'error');
      return false;
    }

    try {
      if (window.SOSKeyStorage && typeof window.SOSKeyStorage.writePrivateKeyRaw === 'function') {
        window.SOSKeyStorage.writePrivateKeyRaw(normalized);
      }
      App.privateKey = normalized;
      if (typeof App.ensureKeys === 'function') {
        const result = App.ensureKeys();
        if (!result || result.ok !== true) {
          setStatus('המפתח אינו תקין. הזהות הקיימת לא שונתה.', 'error');
          return false;
        }
      }
      setStatus('המפתח נטען בהצלחה. מומלץ לרענן את העמוד.');
      if (typeof App.loadFeed === 'function') {
        App.loadFeed();
      }
      return true;
    } catch (err) {
      console.error('Failed to apply private key', err);
      setStatus('שגיאה בטעינת המפתח.', 'error');
      return false;
    }
  }

  function handleImport() {
    const value = importTextarea?.value;
    const privateKey = decodePrivateKey(value);
    if (!privateKey) {
      setStatus('לא זוהה מפתח חוקי. ודא שהעתקת nsec או hex.', 'error');
      return;
    }
    applyImportedKey(privateKey);
  }

  if (copyButton) {
    copyButton.addEventListener('click', copyToClipboard);
  }

  if (downloadButton) {
    downloadButton.addEventListener('click', downloadBackup);
  }

  if (importButton) {
    importButton.addEventListener('click', handleImport);
  }

  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeAccount();
    }
  });

  Object.assign(App, {
    openAccount,
    closeAccount,
  });

  window.openAccount = openAccount;
  window.closeAccount = closeAccount;
})(window);
