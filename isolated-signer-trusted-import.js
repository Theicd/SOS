/**
 * F5B4 — Minimal SO-CALL launcher for isolated signer trusted import.
 * Opens signer.sos010.com top-level import UI. Never handles raw K.
 * Community-independent: ignores CommunityContext / active networkTag.
 */
(function initIsolatedSignerTrustedImport(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});
  const STATUS_KEY = 'sos_signer_import_status_v1';
  const PROTOCOL = 1;
  const DEFAULT_SIGNER_ORIGIN = 'https://signer.sos010.com';
  const ALLOWED_SIGNER_ORIGINS = Object.freeze([
    'https://signer.sos010.com',
    'http://localhost:8787',
  ]);
  const ALLOWED_RETURN_ORIGINS = Object.freeze([
    'https://sos010.com',
    'https://www.sos010.com',
    'http://127.0.0.1:8788',
    'http://localhost:8788',
  ]);

  const pendingBySession = new Map();

  function randomToken(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function isHex64(s) {
    return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s.trim());
  }

  function normalizePubkey(p) {
    return String(p || '')
      .trim()
      .toLowerCase();
  }

  function getRegisteredPubkey() {
    const p =
      App.publicKey ||
      App.pubkey ||
      (App.identity && (App.identity.pubkey || App.identity.publicKey)) ||
      '';
    return normalizePubkey(p);
  }

  function loadStatus() {
    try {
      const raw = localStorage.getItem(STATUS_KEY);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object') return null;
      if (j.privateKey || j.k || j.nsec || j.seed) return null;
      return j;
    } catch (_e) {
      return null;
    }
  }

  function saveStatus(meta) {
    const clean = {
      signerImported: true,
      signerPubkey: normalizePubkey(meta.pubkey),
      signerFingerprint: String(meta.fingerprint || ''),
      signerVaultVersion: meta.generation || 1,
      sessionId: String(meta.sessionId || ''),
      updatedAt: Date.now(),
    };
    localStorage.setItem(STATUS_KEY, JSON.stringify(clean));
    return clean;
  }

  function resolveSignerOrigin(explicit) {
    const o = String(explicit || App.SIGNER_ORIGIN || DEFAULT_SIGNER_ORIGIN).replace(/\/$/, '');
    if (!ALLOWED_SIGNER_ORIGINS.includes(o)) {
      throw Object.assign(new Error('SIGNER_ORIGIN_REJECTED'), { code: 'SIGNER_ORIGIN_REJECTED' });
    }
    return o;
  }

  /**
   * Open trusted import for the currently registered public identity.
   * Does not create a new identity. Does not change App.publicKey.
   */
  function openTrustedImport(opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    for (const k of Object.keys(opts)) {
      if (/priv|nsec|seed|rawKey|privateKey|^k$/i.test(k)) {
        throw Object.assign(new Error('SECRET_FIELD_FORBIDDEN'), { code: 'SECRET_FIELD_FORBIDDEN' });
      }
    }
    const expectedPubkey = normalizePubkey(opts.expectedPubkey || getRegisteredPubkey());
    if (!isHex64(expectedPubkey)) {
      throw Object.assign(new Error('EXPECTED_PUBKEY_REQUIRED'), { code: 'EXPECTED_PUBKEY_REQUIRED' });
    }
    const returnOrigin = location.origin;
    if (!ALLOWED_RETURN_ORIGINS.includes(returnOrigin) && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(returnOrigin)) {
      // Allow same-origin production hosts already listed; reject arbitrary
      if (!ALLOWED_RETURN_ORIGINS.includes(returnOrigin)) {
        throw Object.assign(new Error('RETURN_ORIGIN_REJECTED'), { code: 'RETURN_ORIGIN_REJECTED' });
      }
    }
    const signerOrigin = resolveSignerOrigin(opts.signerOrigin);
    const sessionId = randomToken(16);
    const requestNonce = randomToken(8);
    const q = new URLSearchParams({
      protocol: String(PROTOCOL),
      sessionId,
      expectedPubkey,
      requestNonce,
      returnOrigin,
    });
    const url = signerOrigin + '/import.html?' + q.toString();
    pendingBySession.set(sessionId, {
      expectedPubkey,
      requestNonce,
      createdAt: Date.now(),
      completed: false,
    });
    window.open(url, 'sos_signer_import', 'noopener,noreferrer,width=480,height=640');
    return {
      ok: true,
      sessionId,
      expectedPubkey,
      urlHasSecret: false,
      communityIndependent: true,
    };
  }

  function handleImportSuccess(data, eventOrigin) {
    if (!data || data.type !== 'IMPORT_SUCCESS' || !data.ok) return { ok: false, code: 'NOT_SUCCESS' };
    if (Number(data.protocol) !== PROTOCOL) return { ok: false, code: 'BAD_PROTOCOL' };
    const sessionId = String(data.sessionId || '');
    const pending = pendingBySession.get(sessionId);
    if (!pending) return { ok: false, code: 'UNKNOWN_SESSION' };
    if (pending.completed) return { ok: false, code: 'IMPORT_SUCCESS_REPLAY' };
    const returned = normalizePubkey(data.pubkey);
    if (returned !== pending.expectedPubkey) {
      return { ok: false, code: 'APP_IMPORT_SUCCESS_PUBKEY_MISMATCH' };
    }
    const registered = getRegisteredPubkey();
    if (registered && returned !== registered) {
      return { ok: false, code: 'APP_REGISTERED_PUBKEY_RECHECK_FAIL' };
    }
    // Must not change app identity
    pending.completed = true;
    const status = saveStatus(data);
    try {
      window.dispatchEvent(
        new CustomEvent('sos-signer-import-success', { detail: { status, sessionId } })
      );
    } catch (_e) {}
    return { ok: true, status, appPubkeyChanged: false };
  }

  function onMessage(event) {
    if (!event || !event.data) return;
    const origin = event.origin;
    if (!ALLOWED_SIGNER_ORIGINS.includes(origin)) return;
    handleImportSuccess(event.data, origin);
  }

  window.addEventListener('message', onMessage);

  const api = {
    PROTOCOL,
    STATUS_KEY,
    DEFAULT_SIGNER_ORIGIN,
    COMMUNITY_INDEPENDENT: true,
    openTrustedImport,
    handleImportSuccess,
    getStatus: loadStatus,
    getRegisteredPubkey,
    // Explicit non-goals
    F5B5_EXPORT: false,
    F5B6_MIGRATION: false,
    DELETE_LEGACY_KEYS: false,
  };
  Object.freeze(api);
  App.IsolatedSignerTrustedImport = api;
  window.SosIsolatedSignerTrustedImport = api;
})(typeof window !== 'undefined' ? window : globalThis);
