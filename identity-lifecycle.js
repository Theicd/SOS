/**
 * Stage 5E-D — atomic logout / account-switch identity lifecycle.
 * Never generates keys. Never logs secrets.
 */
(function initIdentityLifecycle(window) {
  const reg = window.SOSIdentityStorageGeneration || (window.SOSIdentityStorageGeneration = {});
  reg['identity-lifecycle.js'] = 'browser-secure-cutover-v1';
  window.SOS_IDENTITY_STORAGE_CODE_VERSION = 'browser-secure-cutover-v1';
  const App = window.NostrApp || (window.NostrApp = {});

  function logTransition(state) {
    App.identityTransition = state;
    try {
      console.log('IDENTITY_TRANSITION state=' + state);
    } catch (_e) {}
  }

  function logMarker(msg) {
    try {
      console.log(msg);
    } catch (_e) {}
  }

  function isNativeShellPresent() {
    try {
      if (typeof App.isNativeShell === 'function' && App.isNativeShell()) return true;
    } catch (_e) {}
    try {
      return !!(window.SosNativeShell && typeof window.SosNativeShell.clearUserSession === 'function');
    } catch (_e2) {
      return false;
    }
  }

  function getBridge() {
    try {
      return window.SosNativeShell || null;
    } catch (_e) {
      return null;
    }
  }

  function readNativeStatus() {
    const bridge = getBridge();
    if (!bridge || typeof bridge.getNativeIdentityStatusJson !== 'function') {
      return { available: false, hasIdentity: false, valid: false, state: 'NATIVE_IDENTITY_EMPTY', pubkey: '' };
    }
    try {
      const raw = bridge.getNativeIdentityStatusJson();
      const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
      return {
        available: true,
        hasIdentity: !!parsed.hasIdentity,
        valid: !!parsed.valid,
        state: String(parsed.state || ''),
        pubkey: String(parsed.pubkey || '').trim().toLowerCase(),
      };
    } catch (_e) {
      return { available: true, hasIdentity: false, valid: false, state: 'NATIVE_IDENTITY_EMPTY', pubkey: '' };
    }
  }

  function clearNativeUserSession() {
    if (!isNativeShellPresent()) {
      return { ok: true, result: 'LOGOUT_NATIVE_CLEAR_SKIPPED', applicable: false };
    }
    const bridge = getBridge();
    if (!bridge || typeof bridge.clearUserSession !== 'function') {
      return { ok: false, result: 'LOGOUT_NATIVE_CLEAR_FAILED', applicable: true };
    }
    try {
      const raw = bridge.clearUserSession();
      let parsed = null;
      if (typeof raw === 'string' && raw.trim()) {
        try {
          parsed = JSON.parse(raw);
        } catch (_e) {
          parsed = null;
        }
      }
      if (parsed && typeof parsed.ok === 'boolean') {
        if (parsed.ok) logMarker('LOGOUT_NATIVE_CLEAR_OK');
        else logMarker('LOGOUT_NATIVE_CLEAR_FAILED');
        return {
          ok: !!parsed.ok,
          result: String(parsed.result || (parsed.ok ? 'LOGOUT_NATIVE_CLEAR_OK' : 'LOGOUT_NATIVE_CLEAR_FAILED')),
          applicable: true,
        };
      }
      // Legacy void clearUserSession — verify via status API when available
      const status = readNativeStatus();
      if (status.available) {
        const ok = !status.hasIdentity;
        logMarker(ok ? 'LOGOUT_NATIVE_CLEAR_OK' : 'LOGOUT_NATIVE_CLEAR_FAILED');
        return {
          ok,
          result: ok ? 'LOGOUT_NATIVE_CLEAR_OK' : 'LOGOUT_NATIVE_CLEAR_FAILED',
          applicable: true,
        };
      }
      logMarker('LOGOUT_NATIVE_CLEAR_OK');
      return { ok: true, result: 'LOGOUT_NATIVE_CLEAR_OK', applicable: true };
    } catch (_err) {
      logMarker('LOGOUT_NATIVE_CLEAR_FAILED');
      return { ok: false, result: 'LOGOUT_NATIVE_CLEAR_FAILED', applicable: true };
    }
  }

  function quiesceIdentityBoundActivity() {
    try {
      if (App.voiceCall && typeof App.voiceCall.end === 'function') {
        App.voiceCall.end({ reason: 'identity_transition' });
      }
    } catch (_e) {}
    try {
      if (App.videoCall && typeof App.videoCall.end === 'function') {
        App.videoCall.end({ reason: 'identity_transition' });
      }
    } catch (_e2) {}
    try {
      window.__sosIncomingCallActive = false;
    } catch (_e3) {}
    try {
      document.body && document.body.classList.remove('sos-call-active');
    } catch (_e4) {}
    try {
      const bridge = getBridge();
      if (bridge && typeof bridge.stopCallSounds === 'function') bridge.stopCallSounds();
      if (bridge && typeof bridge.clearIncomingCallOffer === 'function') bridge.clearIncomingCallOffer();
    } catch (_e5) {}
  }

  function clearWebIdentitySecrets() {
    try {
      if (window.SOSKeyStorage && typeof window.SOSKeyStorage.clearPrivateKey === 'function') {
        window.SOSKeyStorage.clearPrivateKey();
      }
    } catch (_e2) {}
    // Session-only flag is an account/session preference — reset on logout
    try {
      window.localStorage.removeItem('sos_session_only_key');
    } catch (_e3) {}
    App.privateKey = null;
    App.publicKey = null;
  }

  function clearPublicIdentityMirrors() {
    try { window.localStorage.removeItem('nostr_profile'); } catch (_e) {}
    try { window.localStorage.removeItem('sos_pubkey'); } catch (_e2) {}
    try { window.localStorage.removeItem('nostr_pubkey'); } catch (_e3) {}
    try { App.profile = null; } catch (_e4) {}
  }

  function clearUserScopedCaches(oldPubkey) {
    const pk = String(oldPubkey || '').trim().toLowerCase();
    if (pk && /^[0-9a-f]{64}$/.test(pk)) {
      try { window.localStorage.removeItem('nostr_chat_' + pk); } catch (_e) {}
      try { window.localStorage.removeItem('sos_chat_presence_' + pk); } catch (_e2) {}
      try { window.localStorage.removeItem('nostr_profile_' + pk); } catch (_e3) {}
    }
    try {
      if (typeof App.clearChatRuntimeIdentity === 'function') {
        App.clearChatRuntimeIdentity();
      }
    } catch (_e4) {}
    // Guest P2P identity is separate from account — reset on logout so it cannot linger as confusion
    try { window.localStorage.removeItem('p2p_guest_keys'); } catch (_e5) {}
    try {
      App._nativeSyncedPubkey = null;
      App._nativeSyncedPrivkey = null;
      App._identityReconcileState = null;
    } catch (_e6) {}
  }

  /**
   * Atomic logout. Never generates. If Native shell present and clear fails → not success.
   */
  function logoutIdentity(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const oldPubkey = String(App.publicKey || '').trim().toLowerCase();
    logTransition('LOGOUT_IN_PROGRESS');

    quiesceIdentityBoundActivity();

    const nativeResult = clearNativeUserSession();
    if (nativeResult.applicable && !nativeResult.ok) {
      App.identityState = App.IDENTITY_RECOVERY_REQUIRED || 'IDENTITY_RECOVERY_REQUIRED';
      logMarker('IDENTITY_RECOVERY_REQUIRED');
      return {
        ok: false,
        state: 'IDENTITY_RECOVERY_REQUIRED',
        result: 'LOGOUT_NATIVE_CLEAR_FAILED',
        native: nativeResult,
      };
    }

    clearWebIdentitySecrets();
    clearPublicIdentityMirrors();
    clearUserScopedCaches(oldPubkey);

    App.guestMode = true;
    App.identityState = App.IDENTITY_NEW_USER || 'IDENTITY_NEW_USER';
    logTransition('LOGOUT_COMPLETE');

    if (opts.redirect !== false) {
      try {
        window.location.replace(opts.redirectUrl || 'videos.html');
      } catch (_e) {}
    }

    return {
      ok: true,
      state: 'IDENTITY_NEW_USER',
      result: 'LOGOUT_COMPLETE',
      native: nativeResult,
    };
  }

  /**
   * Phase 1 — validate target only. No storage mutation.
   */
  function prepareAccountSwitch(rawInput) {
    let decoded = null;
    try {
      if (typeof App.decodePrivateKey === 'function') {
        decoded = App.decodePrivateKey(rawInput);
      }
    } catch (_e) {
      decoded = null;
    }
    if (!decoded && /^[0-9a-fA-F]{64}$/.test(String(rawInput || '').trim())) {
      decoded = String(rawInput).trim().toLowerCase();
    }
    if (!decoded) {
      logMarker('ACCOUNT_SWITCH_ABORT reason=INVALID_TARGET');
      return { ok: false, reason: 'INVALID_TARGET' };
    }

    let pair = null;
    if (typeof App.validateIdentityPair === 'function') {
      pair = App.validateIdentityPair(decoded, null);
    } else {
      try {
        const getPublicKey = App.getPublicKey || window.NostrTools?.getPublicKey;
        const pub = getPublicKey(decoded);
        pair = {
          ok: !!(pub && /^[0-9a-f]{64}$/i.test(pub)),
          privateKey: decoded,
          publicKey: String(pub || '').toLowerCase(),
          state: 'IDENTITY_OK',
        };
      } catch (_err) {
        pair = { ok: false };
      }
    }

    if (!pair || !pair.ok || !pair.privateKey || !pair.publicKey) {
      logMarker('ACCOUNT_SWITCH_ABORT reason=INVALID_TARGET');
      return { ok: false, reason: 'INVALID_TARGET' };
    }

    logTransition('SWITCH_PREPARED');
    return {
      ok: true,
      reason: 'TARGET_IDENTITY_VALIDATED',
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
    };
  }

  /**
   * Phase 2 — commit only after prepare. Quiesce A, clear Native A, write B, atomic sync.
   */
  function commitAccountSwitch(prepared, options) {
    const opts = options && typeof options === 'object' ? options : {};
    if (!prepared || !prepared.ok || !prepared.privateKey || !prepared.publicKey) {
      logMarker('ACCOUNT_SWITCH_ABORT reason=INVALID_TARGET');
      return { ok: false, reason: 'INVALID_TARGET' };
    }

    const oldPubkey = String(App.publicKey || '').trim().toLowerCase();
    logTransition('SWITCH_IN_PROGRESS');
    App._accountSwitchInProgress = true;

    try {
      quiesceIdentityBoundActivity();

      const nativeClear = clearNativeUserSession();
      if (nativeClear.applicable && !nativeClear.ok) {
        App._accountSwitchInProgress = false;
        App.identityState = App.IDENTITY_RECOVERY_REQUIRED || 'IDENTITY_RECOVERY_REQUIRED';
        logMarker('IDENTITY_RECOVERY_REQUIRED');
        logMarker('ACCOUNT_SWITCH_ABORT reason=NATIVE_CLEAR_FAILED');
        return {
          ok: false,
          reason: 'NATIVE_CLEAR_FAILED',
          state: 'IDENTITY_RECOVERY_REQUIRED',
          // Keep validated target in memory only for safe retry — not persisted
          pendingTarget: {
            privateKey: prepared.privateKey,
            publicKey: prepared.publicKey,
          },
        };
      }

      clearUserScopedCaches(oldPubkey);
      clearPublicIdentityMirrors();

      // Commit Web B
      try {
        if (window.SOSKeyStorage && typeof window.SOSKeyStorage.writePrivateKeyRaw === 'function') {
          window.SOSKeyStorage.writePrivateKeyRaw(prepared.privateKey);
        }
      } catch (_e) {
        App._accountSwitchInProgress = false;
        App.identityState = App.IDENTITY_RECOVERY_REQUIRED || 'IDENTITY_RECOVERY_REQUIRED';
        logMarker('IDENTITY_RECOVERY_REQUIRED');
        logMarker('ACCOUNT_SWITCH_ABORT reason=WEB_WRITE_FAILED');
        return { ok: false, reason: 'WEB_WRITE_FAILED', state: 'IDENTITY_RECOVERY_REQUIRED' };
      }

      App.privateKey = prepared.privateKey;
      App.publicKey = prepared.publicKey;
      App.guestMode = false;

      if (typeof App.ensureKeys === 'function') {
        const ensured = App.ensureKeys();
        if (!ensured || ensured.ok !== true || ensured.publicKey !== prepared.publicKey) {
          App._accountSwitchInProgress = false;
          App.identityState = App.IDENTITY_RECOVERY_REQUIRED || 'IDENTITY_RECOVERY_REQUIRED';
          logMarker('IDENTITY_RECOVERY_REQUIRED');
          logMarker('ACCOUNT_SWITCH_ABORT reason=ENSURE_FAILED');
          return { ok: false, reason: 'ENSURE_FAILED', state: 'IDENTITY_RECOVERY_REQUIRED' };
        }
      }

      // Atomic Native sync B (5E-C)
      let syncResult = 'SYNC_IDENTITY_OK';
      if (isNativeShellPresent() && !(window.SOSKeyStorage && typeof window.SOSKeyStorage.isSessionOnly === 'function' && window.SOSKeyStorage.isSessionOnly())) {
        const bridge = getBridge();
        try {
          if (bridge && typeof bridge.syncUserIdentity === 'function') {
            syncResult = String(bridge.syncUserIdentity(prepared.publicKey, prepared.privateKey) || '');
          } else if (bridge && typeof bridge.setUserPubkey === 'function' && typeof bridge.setUserPrivkey === 'function') {
            bridge.setUserPubkey(prepared.publicKey);
            bridge.setUserPrivkey(prepared.privateKey);
            syncResult = 'SYNC_IDENTITY_OK';
          }
        } catch (_syncErr) {
          syncResult = 'SYNC_IDENTITY_REJECT_INVALID';
        }
        if (syncResult !== 'SYNC_IDENTITY_OK' && syncResult !== 'SYNC_IDENTITY_SAME') {
          App._accountSwitchInProgress = false;
          App.identityState = App.IDENTITY_RECOVERY_REQUIRED || 'IDENTITY_RECOVERY_REQUIRED';
          logMarker('IDENTITY_RECOVERY_REQUIRED');
          logMarker('ACCOUNT_SWITCH_ABORT reason=NATIVE_SYNC_FAILED');
          return {
            ok: false,
            reason: 'NATIVE_SYNC_FAILED',
            state: 'IDENTITY_RECOVERY_REQUIRED',
            syncResult,
          };
        }
        App._nativeSyncedPubkey = prepared.publicKey;
        App._nativeSyncedPrivkey = prepared.privateKey;
      }

      App.identityState = App.IDENTITY_OK || 'IDENTITY_OK';
      App._accountSwitchInProgress = false;
      logTransition('SWITCH_COMPLETE');

      if (opts.reload !== false) {
        try {
          if (typeof App.loadFeed === 'function') App.loadFeed();
        } catch (_lf) {}
      }

      return {
        ok: true,
        reason: 'SWITCH_COMPLETE',
        publicKey: prepared.publicKey,
        syncResult,
      };
    } catch (err) {
      App._accountSwitchInProgress = false;
      App.identityState = App.IDENTITY_RECOVERY_REQUIRED || 'IDENTITY_RECOVERY_REQUIRED';
      logMarker('IDENTITY_RECOVERY_REQUIRED');
      logMarker('ACCOUNT_SWITCH_ABORT reason=UNEXPECTED');
      return { ok: false, reason: 'UNEXPECTED', state: 'IDENTITY_RECOVERY_REQUIRED' };
    }
  }

  function switchAccountFromRawKey(rawInput, options) {
    const prepared = prepareAccountSwitch(rawInput);
    if (!prepared.ok) return prepared;
    return commitAccountSwitch(prepared, options);
  }

  App.logoutIdentity = logoutIdentity;
  App.prepareAccountSwitch = prepareAccountSwitch;
  App.commitAccountSwitch = commitAccountSwitch;
  App.switchAccountFromRawKey = switchAccountFromRawKey;
})(window);
