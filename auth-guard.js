(function enforceAuth(window) {
  const reg = window.SOSIdentityStorageGeneration || (window.SOSIdentityStorageGeneration = {});
  reg['auth-guard.js'] = 'browser-secure-cutover-v1';
  window.SOS_IDENTITY_STORAGE_CODE_VERSION = 'browser-secure-cutover-v1';
  function decide() {
    try {
      const flagOn =
        window.SOS_CRYPTO_WORKER_AUTHORITATIVE === true ||
        window.__SOS_CRYPTO_WORKER_AUTHORITATIVE__ === true ||
        (window.localStorage && window.localStorage.getItem('SOS_CRYPTO_WORKER_AUTHORITATIVE') === '1');
      if (flagOn) {
        // Metadata-only identity check — do not read raw K.
        let pub = '';
        try {
          if (window.SOSKeyStorage && typeof window.SOSKeyStorage.getPublicKeyHint === 'function') {
            pub = window.SOSKeyStorage.getPublicKeyHint() || '';
          }
        } catch (_e) {}
        if (!pub) {
          try {
            const raw = window.localStorage && window.localStorage.getItem('sos_browser_secure_cutover');
            if (raw) {
              const marker = JSON.parse(raw);
              pub = marker && marker.publicKey ? String(marker.publicKey) : '';
            }
          } catch (_e2) {}
        }
        if (!pub && window.location && typeof window.location.replace === 'function') {
          window.location.replace('auth.html');
        }
        return;
      }
      const hasKey =
        window.SOSKeyStorage && typeof window.SOSKeyStorage.readPrivateKeyRaw === 'function'
          ? window.SOSKeyStorage.readPrivateKeyRaw()
          : '';
      if (!hasKey && window.location && typeof window.location.replace === 'function') {
        window.location.replace('auth.html');
      }
    } catch (err) {
      console.warn('Auth guard failed', err);
    }
  }
  try {
    const ready = window.SOSIdentityStorageReady || (window.SOSKeyStorage && window.SOSKeyStorage.ready);
    if (ready && typeof ready.then === 'function') ready.then(decide);
    else decide();
  } catch (err) {
    console.warn('Auth guard failed', err);
  }
})(window);
