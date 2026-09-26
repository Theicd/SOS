/**
 * Single Service Worker registration owner.
 * Every caller must use this URL and scope. Do not register service-worker.js elsewhere.
 */
(function initSOSServiceWorkerRegistration(window) {
  const SCRIPT_URL = './service-worker.js?pkg=895';
  const SCOPE = './';
  let pending = null;

  function register() {
    try {
      if (!window.isSecureContext) return Promise.resolve(null);
      const sw = window.navigator && window.navigator.serviceWorker;
      if (!sw || typeof sw.register !== 'function') return Promise.resolve(null);
      if (pending) return pending;
      pending = sw.register(SCRIPT_URL, { scope: SCOPE, updateViaCache: 'none' }).catch((err) => {
        pending = null;
        return Promise.reject(err);
      });
      return pending;
    } catch (err) {
      pending = null;
      return Promise.reject(err);
    }
  }

  window.SOSServiceWorker = {
    SCRIPT_URL: SCRIPT_URL,
    SCOPE: SCOPE,
    register: register,
  };
})(window);
