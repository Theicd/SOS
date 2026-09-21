(function enforceAuth(window) {
  const reg = window.SOSIdentityStorageGeneration || (window.SOSIdentityStorageGeneration = {});
  reg['auth-guard.js'] = 'browser-secure-cutover-v1';
  window.SOS_IDENTITY_STORAGE_CODE_VERSION = 'browser-secure-cutover-v1';
  function decide() {
    try {
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
