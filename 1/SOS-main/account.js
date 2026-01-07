(function initAccount(window) {
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
        App.ensureKeys();
      }
    } catch (err) {
      console.error('ensureKeys failed', err);
    }
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
    ensurePrivateKey();
    const privateKey = App.privateKey || '';
    if (exportTextarea) {
      exportTextarea.value = encodePrivateKey(privateKey);
    }
    if (importTextarea) {
      importTextarea.value = '';
    }
    resetStatus();
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
      return;
    }
    try {
      window.localStorage.setItem('nostr_private_key', privateKey);
      App.privateKey = privateKey;
      if (typeof App.ensureKeys === 'function') {
        App.ensureKeys();
      }
      setStatus('המפתח נטען בהצלחה. מומלץ לרענן את העמוד.');
      if (typeof App.loadFeed === 'function') {
        App.loadFeed();
      }
    } catch (err) {
      console.error('Failed to apply private key', err);
      setStatus('שגיאה בטעינת המפתח.', 'error');
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
