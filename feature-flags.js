/**
 * Canonical runtime feature flags (Package 896).
 *
 * Single source of truth for SOS_ACCESS_CONTROL_V2 in production:
 * same-origin, deployment-controlled `runtime-feature-flags.json`.
 *
 * - Fail-closed: missing / unreachable / malformed / unknown schema / invalid => OFF.
 * - Flag stays OFF until the config resolves (no V2 UI flash).
 * - Outside local/test hosts, writes to window.SOS_ACCESS_CONTROL_V2 are ignored,
 *   so query / fragment / localStorage / sessionStorage / DOM cannot enable V2.
 * - Local/test hosts keep the local test helper (access-control-v2-local-test.js).
 * - UI flag only. Authorization stays in (P, communityId, capability) enforcement.
 *
 * Must load synchronously before any V2 module or UI script.
 */
(function initSosFeatureFlags(window) {
  'use strict';

  const FLAG = 'SOS_ACCESS_CONTROL_V2';
  const SCHEMA = 'sos-feature-flags-v1';
  const CONFIG_PATH = './runtime-feature-flags.json';
  const READY_EVENT = 'sos-feature-flags-ready';
  const FETCH_TIMEOUT_MS = 5000;
  const MAX_CONFIG_BYTES = 2048;
  const ALLOWED_KEYS = ['schema', 'accessControlV2', 'accessControlV2Scope', 'admin2faEnforcement', 'admin2faSignerPubkey'];
  // FULL: V2 also gates member content/P2P and enables the multi-community UI.
  // CONTROL_PLANE: V2 governs admin/control/invite/admission only; member content, P2P and the single-network UI stay as V2 off.
  const V2_SCOPES = ['FULL', 'CONTROL_PLANE'];

  const App = window.NostrApp || (window.NostrApp = {});

  function hostname() {
    try {
      return String((window.location && window.location.hostname) || '').toLowerCase();
    } catch (_e) {
      return '';
    }
  }

  function hostIsProduction() {
    const h = hostname();
    return h === 'sos010.com' || h === 'www.sos010.com';
  }

  function hostAllowsLocalOverride() {
    if (hostIsProduction()) return false;
    try {
      if (String((window.location && window.location.protocol) || '') === 'file:') return true;
    } catch (_e) {
      return false;
    }
    const h = hostname();
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '[::1]' ||
      h.endsWith('.local') ||
      /^192\.168\./.test(h) ||
      /^10\./.test(h)
    );
  }

  const localOverrideAllowed = hostAllowsLocalOverride();
  const state = {
    resolved: false,
    canonical: false,
    localValue: false,
    source: 'default_off',
    errorCode: null,
    guardInstalled: false,
    // Admin 2FA: canonical config only (no local override on any host).
    admin2faEnforcement: false,
    admin2faSignerPubkey: '',
    v2Scope: 'FULL',
  };

  function effective() {
    if (state.canonical === true) return true;
    return localOverrideAllowed && state.localValue === true;
  }

  try {
    Object.defineProperty(window, FLAG, {
      configurable: false,
      enumerable: true,
      get: effective,
      set(v) {
        if (localOverrideAllowed) state.localValue = v === true;
      },
    });
    state.guardInstalled = true;
  } catch (_e) {
    try {
      window[FLAG] = false;
    } catch (_e2) {}
    state.errorCode = 'FLAG_GUARD_UNAVAILABLE';
  }

  function validate(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'CONFIG_NOT_OBJECT';
    if (obj.schema !== SCHEMA) return 'UNKNOWN_SCHEMA';
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i += 1) {
      if (ALLOWED_KEYS.indexOf(keys[i]) === -1) return 'UNKNOWN_KEY';
    }
    if (typeof obj.accessControlV2 !== 'boolean') return 'INVALID_VALUE';
    if (obj.accessControlV2Scope != null && V2_SCOPES.indexOf(obj.accessControlV2Scope) === -1) return 'INVALID_VALUE';
    if (obj.admin2faEnforcement != null && typeof obj.admin2faEnforcement !== 'boolean') return 'INVALID_VALUE';
    if (obj.admin2faSignerPubkey != null && !/^[0-9a-f]{64}$/.test(String(obj.admin2faSignerPubkey))) {
      return 'INVALID_VALUE';
    }
    return null;
  }

  function snapshot() {
    return {
      schema: SCHEMA,
      configPath: CONFIG_PATH,
      resolved: state.resolved,
      accessControlV2: effective(),
      canonicalAccessControlV2: state.canonical,
      source: state.canonical ? 'canonical_config' : effective() ? 'local_test_override' : state.source,
      errorCode: state.errorCode,
      productionHost: hostIsProduction(),
      localOverrideAllowed,
      guardInstalled: state.guardInstalled,
      admin2faEnforcement: state.admin2faEnforcement,
      accessControlV2Scope: state.v2Scope,
    };
  }

  function finish(canonical, source, errorCode) {
    if (state.resolved) return;
    state.canonical = canonical === true && state.guardInstalled;
    state.source = source;
    if (errorCode) state.errorCode = errorCode;
    state.resolved = true;
    try {
      window.dispatchEvent(new CustomEvent(READY_EVENT, { detail: snapshot() }));
    } catch (_e) {}
  }

  function load() {
    if (typeof window.fetch !== 'function') {
      finish(false, 'default_off', 'FETCH_UNAVAILABLE');
      return Promise.resolve(snapshot());
    }
    let timer = null;
    let controller = null;
    try {
      controller = typeof AbortController === 'function' ? new AbortController() : null;
    } catch (_e) {
      controller = null;
    }
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        try {
          if (controller) controller.abort();
        } catch (_e) {}
        resolve({ timeout: true });
      }, FETCH_TIMEOUT_MS);
    });
    const request = window
      .fetch(CONFIG_PATH + '?ts=' + Date.now(), {
        cache: 'no-store',
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        signal: controller ? controller.signal : undefined,
      })
      .then((res) => {
        if (!res || !res.ok) return { error: 'CONFIG_HTTP_' + (res ? res.status : 'NONE') };
        return res.text().then((text) => ({ text }));
      })
      .catch(() => ({ error: 'CONFIG_UNREACHABLE' }));

    return Promise.race([request, timeout]).then((r) => {
      if (timer) clearTimeout(timer);
      if (r.timeout) return finish(false, 'default_off', 'CONFIG_TIMEOUT');
      if (r.error) return finish(false, 'default_off', r.error);
      const text = String(r.text || '');
      if (text.length > MAX_CONFIG_BYTES) return finish(false, 'default_off', 'CONFIG_TOO_LARGE');
      let obj = null;
      try {
        obj = JSON.parse(text);
      } catch (_e) {
        return finish(false, 'default_off', 'CONFIG_MALFORMED');
      }
      const err = validate(obj);
      if (err) return finish(false, 'default_off', err);
      state.admin2faEnforcement = obj.admin2faEnforcement === true;
      state.admin2faSignerPubkey = obj.admin2faSignerPubkey || '';
      state.v2Scope = obj.accessControlV2Scope || 'FULL';
      return finish(obj.accessControlV2 === true, 'canonical_config', null);
    }).then(() => snapshot());
  }

  const ready = load();

  const api = Object.freeze({
    FLAG,
    SCHEMA,
    CONFIG_PATH,
    READY_EVENT,
    FEATURE_FLAG_IS_AUTHORITY: false,
    FAIL_CLOSED: true,
    isResolved: () => state.resolved,
    isAccessControlV2Enabled: effective,
    isAdmin2faEnforced: () => state.resolved && state.admin2faEnforcement === true,
    admin2faSignerPubkey: () => (state.resolved ? state.admin2faSignerPubkey : ''),
    accessControlV2Scope: () => state.v2Scope,
    /** V2 member-content / multi-community gating (true only for V2 on + FULL scope). */
    isV2MemberScopeEnabled: () => effective() && state.v2Scope === 'FULL',
    whenReady: () => ready,
    snapshot,
    validate,
  });

  App.FeatureFlags = api;
  window.SosFeatureFlags = api;
})(typeof window !== 'undefined' ? window : globalThis);
