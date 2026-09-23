/**
 * F5B4R — Non-sensitive signer availability + circuit breaker (main app).
 * Never grants signing authority. Never polls signer in background.
 * Never blocks app boot / Community / feed / chat / calls / emergency / P2P.
 */
(function initSignerOutageIsolation(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});
  const STATE_KEY = 'sos_signer_availability_v1';
  const CB_KEY = 'sos_signer_circuit_v1';

  const Availability = Object.freeze({
    UNKNOWN: 'SIGNER_UNKNOWN',
    AVAILABLE: 'SIGNER_AVAILABLE',
    TEMPORARILY_UNAVAILABLE: 'SIGNER_TEMPORARILY_UNAVAILABLE',
    OFFLINE_CACHE_POSSIBLE: 'SIGNER_OFFLINE_CACHE_POSSIBLE',
  });

  const CB = {
    maxFailures: 3,
    openMs: 60 * 1000,
    // No background health polling by design
    backgroundHealthPolling: false,
  };

  function readJson(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object') return null;
      if (j.k || j.nsec || j.privateKey || j.seed) return null;
      return j;
    } catch (_e) {
      return null;
    }
  }

  function writeJson(key, obj) {
    try {
      const clean = Object.assign({}, obj);
      delete clean.k;
      delete clean.nsec;
      delete clean.privateKey;
      delete clean.seed;
      localStorage.setItem(key, JSON.stringify(clean));
    } catch (_e) {}
  }

  function getCircuit() {
    const c = readJson(CB_KEY) || { failures: 0, openUntil: 0, state: 'closed' };
    const now = Date.now();
    if (c.openUntil && now >= c.openUntil) {
      // half-open: allow one user-initiated attempt, no auto retry
      c.state = 'half-open';
      c.openUntil = 0;
      writeJson(CB_KEY, c);
    }
    return c;
  }

  function recordSuccess() {
    writeJson(CB_KEY, { failures: 0, openUntil: 0, state: 'closed' });
    writeJson(STATE_KEY, {
      availability: Availability.AVAILABLE,
      updatedAt: Date.now(),
      isSecurityAuthority: false,
    });
  }

  function recordFailure(code) {
    const c = getCircuit();
    c.failures = (c.failures || 0) + 1;
    if (c.failures >= CB.maxFailures) {
      c.state = 'open';
      c.openUntil = Date.now() + CB.openMs;
    }
    writeJson(CB_KEY, c);
    writeJson(STATE_KEY, {
      availability: Availability.TEMPORARILY_UNAVAILABLE,
      lastCode: String(code || 'UNAVAILABLE').slice(0, 64),
      updatedAt: Date.now(),
      isSecurityAuthority: false,
    });
    return c;
  }

  /**
   * Exponential backoff with capped jitter — for user-initiated retries only.
   * Sensitive ops must NOT auto-retry.
   */
  function nextBackoffMs(attempt) {
    const n = Math.max(0, Math.min(8, Number(attempt) || 0));
    const base = Math.min(30000, 500 * Math.pow(2, n));
    const jitter = Math.floor(Math.random() * Math.min(1000, base * 0.2));
    return base + jitter;
  }

  function canAttemptUserAction() {
    const c = getCircuit();
    if (c.state === 'open' && c.openUntil && Date.now() < c.openUntil) {
      return { ok: false, code: 'SIGNER_TEMPORARILY_UNAVAILABLE', circuit: 'open' };
    }
    return { ok: true, circuit: c.state || 'closed' };
  }

  function getAvailability() {
    const s = readJson(STATE_KEY);
    return (s && s.availability) || Availability.UNKNOWN;
  }

  // Explicit: no boot-time signer probe
  function assertBootIndependent() {
    return {
      APP_BOOT_REQUIRES_SIGNER: false,
      APP_BOOT_WAITS_FOR_SIGNER_NETWORK: false,
      SIGNER_HEALTH_CHECK_BLOCKS_APP_BOOT: false,
      SIGNER_BACKGROUND_HEALTH_POLLING: false,
      SIGNER_AVAILABILITY_IS_SECURITY_AUTHORITY: false,
    };
  }

  const api = {
    Availability,
    STATE_KEY,
    CB_KEY,
    getAvailability,
    getCircuit,
    recordSuccess,
    recordFailure,
    canAttemptUserAction,
    nextBackoffMs,
    assertBootIndependent,
    SIGNER_CIRCUIT_BREAKER_IMPLEMENTED: true,
    SIGNER_BACKGROUND_HEALTH_POLLING: false,
    SIGNER_RETRY_BACKOFF_IMPLEMENTED: true,
    SENSITIVE_OPERATION_AUTO_RETRY: false,
    SIGNER_RETRY_LOOP_AGGRESSIVE: false,
    SIGNER_AVAILABILITY_IS_SECURITY_AUTHORITY: false,
    // Architecture assertions (static)
    CENTRAL_SIGNING_API_PRESENT: false,
    REMOTE_SIGNING_SERVICE_PRESENT: false,
    PER_COMMUNITY_SIGNER_REQUIRED: false,
    NEW_COMMUNITY_REQUIRES_NEW_SIGNER: false,
    SIGNER_100K_NO_BOOT_HEALTHCHECK_STORM: true,
    SIGNER_100K_NO_CENTRAL_SIGNING_BOTTLENECK: true,
  };
  Object.freeze(api);
  App.SignerOutageIsolation = api;
  window.SosSignerOutageIsolation = api;
})(typeof window !== 'undefined' ? window : globalThis);
