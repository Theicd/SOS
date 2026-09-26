/**
 * Access Control V2 — LOCAL / TEST activation only.
 * Never enables V2 on production host sos010.com.
 * Production default remains SOS_ACCESS_CONTROL_V2=false.
 */
(function initAccessControlV2LocalTest(window) {
  'use strict';

  const FLAG = 'SOS_ACCESS_CONTROL_V2';
  const LOCAL_KEY = 'SOS_ACCESS_CONTROL_V2_LOCAL_TEST';
  const App = window.NostrApp || (window.NostrApp = {});

  if (typeof window[FLAG] === 'undefined') {
    window[FLAG] = false;
  }

  function hostIsProduction() {
    try {
      const h = String(window.location && window.location.hostname || '').toLowerCase();
      return h === 'sos010.com' || h === 'www.sos010.com';
    } catch (_e) {
      return false;
    }
  }

  function hostAllowsLocalTest() {
    try {
      const h = String(window.location && window.location.hostname || '').toLowerCase();
      const proto = String(window.location && window.location.protocol || '');
      if (hostIsProduction()) return false;
      if (proto === 'file:') return true;
      return (
        h === 'localhost' ||
        h === '127.0.0.1' ||
        h === '[::1]' ||
        h.endsWith('.local') ||
        /^192\.168\./.test(h) ||
        /^10\./.test(h)
      );
    } catch (_e) {
      return false;
    }
  }

  function readQueryEnable() {
    try {
      const q = new URLSearchParams(window.location.search || '');
      return q.get('acv2') === '1' || q.get('access_control_v2') === '1';
    } catch (_e) {
      return false;
    }
  }

  function readStorageEnable() {
    try {
      return window.localStorage && window.localStorage.getItem(LOCAL_KEY) === '1';
    } catch (_e) {
      return false;
    }
  }

  /**
   * Apply local test mode once at boot.
   * Production host: force false (ignore query/storage).
   */
  function applyLocalTestMode() {
    if (hostIsProduction()) {
      window[FLAG] = false;
      try {
        window.localStorage && window.localStorage.removeItem(LOCAL_KEY);
      } catch (_e) {}
      return { ok: false, code: 'PRODUCTION_HOST', enabled: false };
    }
    if (!hostAllowsLocalTest()) {
      return { ok: false, code: 'HOST_NOT_ALLOWED', enabled: window[FLAG] === true };
    }
    const want = readQueryEnable() || readStorageEnable();
    if (want) {
      window[FLAG] = true;
      try {
        window.localStorage && window.localStorage.setItem(LOCAL_KEY, '1');
      } catch (_e2) {}
      return { ok: true, code: 'LOCAL_TEST_ON', enabled: true };
    }
    return { ok: true, code: 'LOCAL_TEST_OFF', enabled: window[FLAG] === true };
  }

  function enableLocalTest() {
    if (!hostAllowsLocalTest() || hostIsProduction()) {
      return { ok: false, code: 'NOT_ALLOWED' };
    }
    try {
      window.localStorage.setItem(LOCAL_KEY, '1');
    } catch (_e) {}
    window[FLAG] = true;
    try {
      window.dispatchEvent(new CustomEvent('sos-access-control-v2-local', { detail: { enabled: true } }));
    } catch (_e2) {}
    return { ok: true, enabled: true };
  }

  function disableLocalTest() {
    try {
      window.localStorage && window.localStorage.removeItem(LOCAL_KEY);
    } catch (_e) {}
    if (!hostIsProduction()) window[FLAG] = false;
    try {
      window.dispatchEvent(new CustomEvent('sos-access-control-v2-local', { detail: { enabled: false } }));
    } catch (_e2) {}
    return { ok: true, enabled: false };
  }

  const result = applyLocalTestMode();

  const api = Object.freeze({
    FLAG,
    LOCAL_KEY,
    ACCESS_CONTROL_V2_DEFAULT_OFF: true,
    ACCESS_CONTROL_V2_LOCAL_TEST_MODE: true,
    hostIsProduction,
    hostAllowsLocalTest,
    applyLocalTestMode,
    enableLocalTest,
    disableLocalTest,
    isEnabled: () => window[FLAG] === true,
    lastApply: result,
  });

  App.AccessControlV2LocalTest = api;
  window.SosAccessControlV2LocalTest = api;
})(typeof window !== 'undefined' ? window : globalThis);
