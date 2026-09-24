/**
 * Stage5 multi-tab session authority — local-first revocation.
 * Persistent monotonic sessionGeneration is the source of truth.
 * BroadcastChannel / storage events are wake-up hints only (never grant authority).
 * Identity material (K/P/vault) is NOT deleted or rotated by revocation itself.
 * HYPER CORE TECH
 */
(function initSessionAuthority(root) {
  const App = root.NostrApp || (root.NostrApp = {});

  const GEN_KEY = 'sos_session_generation';
  const ACCOUNT_KEY = 'sos_session_account';
  const CHANNEL_NAME = 'sos-session-authority';
  const MSG_TYPE = 'SESSION_AUTHORITY_HINT';
  const MSG_SCHEMA = 1;

  /** In-memory bind for this browsing context (tab/window). */
  let boundGeneration = null;
  let boundAccount = '';
  let detached = false;
  let bc = null;
  let hooksInstalled = false;
  let lastDetachReason = '';

  function log(msg) {
    try {
      console.log(msg);
    } catch (_e) {}
  }

  function storageGet(key) {
    try {
      if (!root.localStorage) return null;
      return root.localStorage.getItem(key);
    } catch (_e) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      if (!root.localStorage) return false;
      root.localStorage.setItem(key, String(value));
      return true;
    } catch (_e) {
      return false;
    }
  }

  function parseGeneration(raw) {
    if (raw == null || raw === '') return 0;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
    return n;
  }

  function normalizeAccount(pk) {
    const s = String(pk || '')
      .trim()
      .toLowerCase();
    if (!s) return '';
    if (!/^[0-9a-f]{64}$/.test(s)) return '';
    return s;
  }

  /** O(1) persistent authoritative generation. */
  function getAuthoritativeGeneration() {
    const parsed = parseGeneration(storageGet(GEN_KEY));
    if (parsed === null) {
      // Corrupt persistent value → fail closed by treating as unreachable high watermark
      return Number.MAX_SAFE_INTEGER;
    }
    return parsed;
  }

  function getAuthoritativeAccount() {
    return normalizeAccount(storageGet(ACCOUNT_KEY));
  }

  function writeAuthoritative(generation, account) {
    const gen = Math.max(0, Math.floor(Number(generation) || 0));
    storageSet(GEN_KEY, String(gen));
    storageSet(ACCOUNT_KEY, normalizeAccount(account));
    return gen;
  }

  function getBoundGeneration() {
    return boundGeneration;
  }

  function getBoundAccount() {
    return boundAccount;
  }

  function isDetached() {
    return detached === true;
  }

  function getLastDetachReason() {
    return lastDetachReason || '';
  }

  /**
   * Valid when this context has an explicit bind and it matches persistent SoT.
   * Unbound contexts are never authoritative for sensitive ops.
   */
  function isSessionValid() {
    if (detached) return false;
    if (boundGeneration == null || !Number.isInteger(boundGeneration)) return false;
    const auth = getAuthoritativeGeneration();
    if (auth !== boundGeneration) return false;
    const authAcct = getAuthoritativeAccount();
    const boundAcct = normalizeAccount(boundAccount);
    // Logged-out authoritative account is empty — bound session must also be empty
    if (authAcct !== boundAcct) return false;
    return true;
  }

  function vaultApi() {
    return App.SosCryptoWorkerVault || root.SosCryptoWorkerVault || null;
  }

  /**
   * Detach this tab's live authority. Does NOT delete durable identity vault/K.
   * Does NOT rotate identity. Clears in-memory session mirrors + Worker signing.
   */
  function detachLocalAuthority(reason) {
    detached = true;
    lastDetachReason = String(reason || 'DETACHED');
    boundGeneration = null;
    boundAccount = '';
    try {
      App.privateKey = null;
    } catch (_e) {}
    try {
      // Clear page pubkey mirror so stale tab cannot publish as old account
      App.publicKey = null;
    } catch (_e2) {}
    try {
      App.guestMode = true;
    } catch (_e3) {}
    try {
      App._sessionAuthorityDetached = true;
      App._sessionDetachReason = lastDetachReason;
    } catch (_e4) {}
    const v = vaultApi();
    if (v) {
      try {
        if (typeof v.deactivateAuthoritative === 'function') v.deactivateAuthoritative();
      } catch (_e5) {}
      try {
        if (typeof v.terminate === 'function') v.terminate();
      } catch (_e6) {}
    }
    log('SESSION_AUTHORITY_DETACHED reason=' + lastDetachReason);
    try {
      if (typeof App.onSessionAuthorityDetached === 'function') {
        App.onSessionAuthorityDetached({ reason: lastDetachReason });
      }
    } catch (_e7) {}
    return { ok: true, detached: true, reason: lastDetachReason };
  }

  function revalidateFromPersistent(reason) {
    if (boundGeneration == null) {
      // Never had a bind — still not valid for sensitive ops
      try {
        const NTC = App.NativeTypedCryptoBridge || root.SosNativeTypedCryptoBridge;
        if (NTC && typeof NTC.revalidateNativeSession === 'function') {
          NTC.revalidateNativeSession();
        }
      } catch (_e0) {}
      return { ok: false, code: 'SESSION_UNBOUND', reason: String(reason || 'revalidate') };
    }
    if (isSessionValid()) {
      try {
        const NTC = App.NativeTypedCryptoBridge || root.SosNativeTypedCryptoBridge;
        if (NTC && typeof NTC.revalidateNativeSession === 'function') {
          const native = NTC.revalidateNativeSession();
          if (native && native.active === false && typeof NTC.clearCapability === 'function') {
            NTC.clearCapability();
          }
        }
      } catch (_e1) {}
      return { ok: true, generation: boundGeneration, account: boundAccount };
    }
    detachLocalAuthority(reason || 'STALE_GENERATION');
    try {
      const NTC = App.NativeTypedCryptoBridge || root.SosNativeTypedCryptoBridge;
      if (NTC && typeof NTC.revokeNativeSession === 'function') {
        NTC.revokeNativeSession('STALE_GENERATION');
      }
    } catch (_e2) {}
    return { ok: false, code: 'SESSION_REVOKED', reason: lastDetachReason };
  }

  /**
   * Bind this context to the current persistent generation after a successful
   * local login / account-switch commit in THIS tab.
   */
  function bindCurrentSession(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const account = normalizeAccount(opts.accountPubkey || opts.pubkey || App.publicKey || '');
    let gen = getAuthoritativeGeneration();
    if (gen >= Number.MAX_SAFE_INTEGER) {
      // Repair corrupt store to a known value before bind
      gen = writeAuthoritative(1, account);
    } else if (opts.bump === true) {
      gen = writeAuthoritative(gen + 1, account);
    } else {
      // Ensure account mirror matches without bumping (fresh page after login write)
      writeAuthoritative(gen, account);
    }
    boundGeneration = gen;
    boundAccount = account;
    detached = false;
    lastDetachReason = '';
    try {
      App._sessionAuthorityDetached = false;
      App._sessionDetachReason = '';
      App._sessionGeneration = gen;
    } catch (_e) {}
    log('SESSION_AUTHORITY_BOUND gen=' + gen + ' account=' + (account ? account.slice(0, 8) : 'none'));
    // F6D: sync native typed-crypto session binding (opaque capability; no K).
    try {
      const NTC = App.NativeTypedCryptoBridge || root.SosNativeTypedCryptoBridge;
      if (NTC && typeof NTC.bindNativeSession === 'function') {
        NTC.bindNativeSession({ generation: gen, accountPubkey: account });
      }
    } catch (_eNative) {}
    return { ok: true, generation: gen, account: account };
  }

  /**
   * Revoke all tabs' authority by bumping persistent generation.
   * Optional nextAccount for account-switch: committer may re-bind immediately.
   * Broadcast is a hint only — never grants authority.
   */
  function revokeSession(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const reason = String(opts.reason || 'revoke');
    const nextAccount = Object.prototype.hasOwnProperty.call(opts, 'nextAccountPubkey')
      ? normalizeAccount(opts.nextAccountPubkey)
      : '';
    const prev = getAuthoritativeGeneration();
    const safePrev = prev >= Number.MAX_SAFE_INTEGER ? 0 : prev;
    const next = writeAuthoritative(safePrev + 1, nextAccount);

    // Revoking tab: either re-bind to new session (account switch) or detach (logout)
    if (opts.rebind === true) {
      boundGeneration = next;
      boundAccount = nextAccount;
      detached = false;
      lastDetachReason = '';
      try {
        App._sessionAuthorityDetached = false;
        App._sessionGeneration = next;
      } catch (_e) {}
      log('SESSION_AUTHORITY_REVOKED_REBOUND gen=' + next + ' reason=' + reason);
      try {
        const NTC = App.NativeTypedCryptoBridge || root.SosNativeTypedCryptoBridge;
        if (NTC && typeof NTC.revokeNativeSession === 'function') {
          NTC.revokeNativeSession(reason);
        }
        if (NTC && typeof NTC.bindNativeSession === 'function') {
          NTC.bindNativeSession({ generation: next, accountPubkey: nextAccount });
        }
      } catch (_eNative) {}
    } else {
      detachLocalAuthority(reason);
      // Ensure unbound after logout even if detach cleared bind
      boundGeneration = null;
      boundAccount = '';
      log('SESSION_AUTHORITY_REVOKED gen=' + next + ' reason=' + reason);
      try {
        const NTC = App.NativeTypedCryptoBridge || root.SosNativeTypedCryptoBridge;
        if (NTC && typeof NTC.revokeNativeSession === 'function') {
          NTC.revokeNativeSession(reason);
        }
      } catch (_eNative2) {}
    }

    postHint({
      type: MSG_TYPE,
      schema: MSG_SCHEMA,
      generation: next,
      account: nextAccount,
      reason: reason,
      ts: Date.now(),
    });

    return {
      ok: true,
      generation: next,
      previousGeneration: safePrev,
      account: nextAccount,
      reason: reason,
      SESSION_REVOCATION_DELETES_IDENTITY: false,
      SESSION_REVOCATION_ROTATES_IDENTITY: false,
    };
  }

  function validateHintMessage(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, code: 'MALFORMED' };
    }
    if (data.type !== MSG_TYPE) return { ok: false, code: 'BAD_TYPE' };
    if (data.schema !== MSG_SCHEMA) return { ok: false, code: 'BAD_SCHEMA' };
    if (!Object.prototype.hasOwnProperty.call(data, 'generation')) {
      return { ok: false, code: 'BAD_GENERATION' };
    }
    const gen = parseGeneration(data.generation);
    // Reject null/empty/non-integer — parseGeneration maps null→0 for storage reads only
    if (data.generation == null || data.generation === '' || gen === null) {
      return { ok: false, code: 'BAD_GENERATION' };
    }
    // Hint must never claim a future generation beyond persistent SoT — ignore as grant
    const auth = getAuthoritativeGeneration();
    if (gen > auth) return { ok: false, code: 'FUTURE_GENERATION' };
    if (Object.prototype.hasOwnProperty.call(data, 'account')) {
      const acct = String(data.account || '');
      if (acct && !/^[0-9a-f]{64}$/i.test(acct)) return { ok: false, code: 'BAD_ACCOUNT' };
    }
    return { ok: true, generation: gen };
  }

  function onHint(data) {
    const v = validateHintMessage(data);
    if (!v.ok) {
      log('SESSION_AUTHORITY_HINT_REJECT code=' + v.code);
      return { ok: false, code: v.code };
    }
    // Wake-up only: re-read persistent SoT and detach if stale
    return revalidateFromPersistent('HINT_' + (data.reason || 'wake'));
  }

  function postHint(payload) {
    try {
      if (!bc && typeof root.BroadcastChannel === 'function') {
        bc = new root.BroadcastChannel(CHANNEL_NAME);
      }
      if (bc) bc.postMessage(payload);
    } catch (_e) {}
    // storage event wake-up for browsers without BC: touch a companion key
    try {
      storageSet('sos_session_authority_ping', String(Date.now()));
    } catch (_e2) {}
  }

  function ensureChannel() {
    if (bc || typeof root.BroadcastChannel !== 'function') return;
    try {
      bc = new root.BroadcastChannel(CHANNEL_NAME);
      bc.onmessage = function (ev) {
        try {
          onHint(ev && ev.data);
        } catch (_e) {}
      };
    } catch (_e2) {
      bc = null;
    }
  }

  function onStorageEvent(ev) {
    try {
      if (!ev) return;
      const key = ev.key;
      if (
        key !== GEN_KEY &&
        key !== ACCOUNT_KEY &&
        key !== 'sos_session_authority_ping' &&
        key != null
      ) {
        return;
      }
      revalidateFromPersistent('STORAGE_EVENT');
    } catch (_e) {}
  }

  function onVisibility() {
    try {
      if (root.document && root.document.hidden) return;
      revalidateFromPersistent('VISIBILITY_RESUME');
    } catch (_e) {}
  }

  function onPageShow(ev) {
    try {
      const fromBf = !!(ev && ev.persisted);
      revalidateFromPersistent(fromBf ? 'BFCACHE_RESTORE' : 'PAGESHOW');
    } catch (_e) {}
  }

  function onFocus() {
    try {
      revalidateFromPersistent('FOCUS_RESUME');
    } catch (_e) {}
  }

  function installResumeHooks() {
    if (hooksInstalled) return;
    hooksInstalled = true;
    ensureChannel();
    try {
      if (root.addEventListener) {
        root.addEventListener('storage', onStorageEvent);
        root.addEventListener('pageshow', onPageShow);
        root.addEventListener('focus', onFocus);
      }
    } catch (_e) {}
    try {
      if (root.document && root.document.addEventListener) {
        root.document.addEventListener('visibilitychange', onVisibility);
      }
    } catch (_e2) {}
  }

  function failSession(code, message) {
    const err = new Error(message || code);
    err.code = code;
    err.name = 'SessionAuthorityError';
    throw err;
  }

  /**
   * Sensitive-operation gate — O(1), local only, fail-closed.
   * Call immediately before typed sign / publish / admin mutate / call start.
   */
  function assertSessionForSensitiveOp(opName) {
    installResumeHooks();
    const check = revalidateFromPersistent('SENSITIVE:' + String(opName || 'op'));
    if (!check.ok) {
      failSession(
        check.code || 'SESSION_REVOKED',
        'session authority rejected for ' + String(opName || 'op')
      );
    }
    return {
      ok: true,
      generation: boundGeneration,
      account: boundAccount,
      op: String(opName || ''),
    };
  }

  function checkSessionForSensitiveOp(opName) {
    try {
      return assertSessionForSensitiveOp(opName);
    } catch (err) {
      return {
        ok: false,
        code: (err && err.code) || 'SESSION_REVOKED',
        op: String(opName || ''),
      };
    }
  }

  /** Future isolated-signer binding surface (F5B5/F5B6 not implemented). */
  function getSessionBindingToken() {
    if (!isSessionValid()) return null;
    return {
      schema: MSG_SCHEMA,
      generation: boundGeneration,
      account: boundAccount,
      // Non-secret handle for future signer request binding
      binding: 'sos-session-v1:' + boundGeneration + ':' + (boundAccount || 'none'),
    };
  }

  const api = {
    GEN_KEY,
    ACCOUNT_KEY,
    CHANNEL_NAME,
    MSG_TYPE,
    MSG_SCHEMA,
    getAuthoritativeGeneration,
    getAuthoritativeAccount,
    getBoundGeneration,
    getBoundAccount,
    isSessionValid,
    isDetached,
    getLastDetachReason,
    bindCurrentSession,
    revokeSession,
    detachLocalAuthority,
    revalidateFromPersistent,
    assertSessionForSensitiveOp,
    checkSessionForSensitiveOp,
    validateHintMessage,
    onHint,
    installResumeHooks,
    getSessionBindingToken,
    // Explicit non-goals / invariants for QA
    INVARIANTS: Object.freeze({
      BROADCASTCHANNEL_IS_SOLE_REVOCATION_AUTHORITY: false,
      REVOCATION_BROADCAST_MESSAGE_IS_AUTHORITY: false,
      SESSION_REVOCATION_DELETES_IDENTITY: false,
      SESSION_REVOCATION_ROTATES_IDENTITY: false,
      MULTITAB_REVOCATION_REQUIRES_REMOTE_API: false,
      MULTITAB_REVOCATION_REQUIRES_SIGNER_HOST: false,
      MULTITAB_REVOCATION_REQUIRES_CLOUDFLARE: false,
      MULTITAB_REVOCATION_BACKGROUND_POLLING: false,
      SESSION_REVALIDATION_COMPLEXITY: 'O(1)',
      SESSION_IDENTITY_COMMUNITY_INDEPENDENT: true,
      FUTURE_SIGNER_SESSION_BINDING_READY: true,
    }),
  };

  App.SessionAuthority = api;
  root.SosSessionAuthority = api;

  // Auto-install resume hooks when DOM is available
  try {
    if (root.document) {
      if (root.document.readyState === 'loading') {
        root.document.addEventListener('DOMContentLoaded', function () {
          installResumeHooks();
        });
      } else {
        installResumeHooks();
      }
    }
  } catch (_e) {}

  try {
    log('[SESSION-AUTHORITY] multi-tab revocation loaded');
  } catch (_e2) {}
})(typeof window !== 'undefined' ? window : globalThis);
