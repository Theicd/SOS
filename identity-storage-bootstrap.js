/**
 * Single async identity-storage boundary.
 * Calls the same SOSKeyStorage.initialize() promise. Does not start a second init.
 */
(function initIdentityStorageBootstrap(window) {
  const reg = window.SOSIdentityStorageGeneration || (window.SOSIdentityStorageGeneration = {});
  reg['identity-storage-bootstrap.js'] = 'browser-secure-cutover-v1';
  window.SOS_IDENTITY_STORAGE_CODE_VERSION = 'browser-secure-cutover-v1';
  const storage = window.SOSKeyStorage;
  const ready = storage && typeof storage.initialize === 'function'
    ? storage.initialize()
    : Promise.resolve({ provider: 'LegacyProvider', state: 'WEB_SECURE_UNAVAILABLE' });
  window.SOSIdentityStorageReady = ready;
  if (storage) storage.ready = ready;
})(window);
