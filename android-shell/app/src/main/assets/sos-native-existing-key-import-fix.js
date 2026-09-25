/**
 * F6J-R2-FIX1 — Package-892-compatible repair for existing-key import on native shell.
 * Injected by MainActivity after page load. No secrets in events/logs.
 */
(function sosNativeExistingKeyImportFix() {
  try {
    if (window.__SOS_EXISTING_KEY_IMPORT_FIX__) {
      // Re-schedule repair if already loaded (page soft-nav).
    } else {
      window.__SOS_EXISTING_KEY_IMPORT_FIX__ = true;
    }
  } catch (_e0) {
    return;
  }

  function bridge() {
    try {
      return window.SosNativeShell || null;
    } catch (_e) {
      return null;
    }
  }

  function isHex64(v) {
    return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(String(v).trim());
  }

  function readNativePubkey() {
    const b = bridge();
    if (!b || typeof b.getSecureWebIdentityJson !== 'function') return '';
    try {
      const parsed = JSON.parse(b.getSecureWebIdentityJson() || '{}');
      if (!parsed || parsed.ok !== true) return '';
      if (parsed.privkey || parsed.privateKey || parsed.nsec || parsed.k) return '';
      const pub = String(parsed.pubkey || '').trim().toLowerCase();
      return isHex64(pub) ? pub : '';
    } catch (_e) {
      return '';
    }
  }

  function applyAuthenticatedPublicState(pub, opts) {
    const o = opts || {};
    const App = window.NostrApp || window.App;
    if (!App || !isHex64(pub)) return false;
    try {
      App.privateKey = null;
      App.publicKey = String(pub).toLowerCase();
      App.guestMode = false;
      App.identityState = 'IDENTITY_OK';
      App._topBarAuthUiReady = true;
    } catch (_e) {}
    try {
      if (window.SOSKeyStorage && typeof window.SOSKeyStorage === 'object') {
        // Hint for Package 892 consumers without mutating raw K APIs.
        window.SOSKeyStorage.__sosTypedPubHint = String(pub).toLowerCase();
      }
    } catch (_h) {}
    try {
      const SA = App.SessionAuthority || window.SosSessionAuthority;
      if (SA && typeof SA.bindCurrentSession === 'function') {
        const detached = typeof SA.isDetached === 'function' && SA.isDetached();
        const already = typeof SA.isSessionValid === 'function' && SA.isSessionValid();
        if (!detached && !already) {
          SA.bindCurrentSession({
            accountPubkey: App.publicKey,
            bump: false,
            generation: o.generation,
          });
        }
      }
    } catch (_sa) {}
    try {
      if (typeof App.syncTopBarAuthUi === 'function') App.syncTopBarAuthUi();
    } catch (_ui) {}
    try {
      window.dispatchEvent(
        new CustomEvent('sos-auth-state', {
          detail: { guestMode: false, pubkey: App.publicKey, source: o.source || 'typed_boot' },
        })
      );
    } catch (_ev) {}
    try {
      console.log('EXISTING_KEY_TYPED_AUTH_ACTIVE fp=' + String(pub).slice(0, 8));
    } catch (_l) {}
    try {
      var bAck = bridge();
      if (bAck && typeof bAck.notifyTypedAuthRepair === 'function') {
        bAck.notifyTypedAuthRepair(String(pub).slice(0, 16));
      }
    } catch (_ack) {}
    return true;
  }

  function repairTypedBoot() {
    const pub = readNativePubkey();
    if (!pub) return false;
    const App = window.NostrApp || window.App;
    if (!App) return false;
    if (App.guestMode === false && isHex64(App.publicKey) && App.publicKey === pub && App.identityState === 'IDENTITY_OK') {
      return true;
    }
    // Heal Guest / NEW_USER / wiped pubkey while native sealed identity exists.
    return applyAuthenticatedPublicState(pub, { source: 'typed_boot_repair' });
  }

  function wrapEnsureKeys() {
    const App = window.NostrApp || window.App;
    if (!App || typeof App.ensureKeys !== 'function') return;
    if (App.__sosEnsureKeysTypedWrapped) return;
    const original = App.ensureKeys.bind(App);
    App.ensureKeys = function () {
      const pub = readNativePubkey();
      if (pub) {
        App.privateKey = null;
        App.publicKey = pub;
        App.guestMode = false;
        App.identityState = 'IDENTITY_OK';
        return { ok: true, state: 'IDENTITY_OK', privateKey: null, publicKey: pub, typedOnly: true };
      }
      return original();
    };
    App.__sosEnsureKeysTypedWrapped = true;
  }

  function wrapGetPublicKeyHint() {
    try {
      if (!window.SOSKeyStorage || typeof window.SOSKeyStorage.getPublicKeyHint !== 'function') return;
      if (window.SOSKeyStorage.__sosHintWrapped) return;
      const original = window.SOSKeyStorage.getPublicKeyHint.bind(window.SOSKeyStorage);
      window.SOSKeyStorage.getPublicKeyHint = function () {
        const n = readNativePubkey();
        if (n) return n;
        try {
          if (window.SOSKeyStorage.__sosTypedPubHint) return window.SOSKeyStorage.__sosTypedPubHint;
        } catch (_e) {}
        return original();
      };
      window.SOSKeyStorage.__sosHintWrapped = true;
    } catch (_e2) {}
  }

  function hebrewError(code) {
    switch (String(code || '')) {
      case 'INVALID_KEY':
        return 'המפתח שהוזן אינו תקין';
      case 'UNTRUSTED_ORIGIN':
      case 'SECURE_STORE_FAILED':
      case 'SESSION_BIND_FAILED':
      case 'ACCOUNT_MISMATCH':
      case 'IMPORT_IN_PROGRESS':
      case 'NATIVE_CRYPTO_FAILED':
        return 'לא ניתן היה לחבר את החשבון. נסה שוב.';
      default:
        return 'לא ניתן היה לחבר את החשבון. נסה שוב.';
    }
  }

  function importViaNative(hexPriv) {
    const b = bridge();
    if (!b || typeof b.importExistingSecureIdentity !== 'function') {
      return { ok: false, code: 'NATIVE_CRYPTO_FAILED' };
    }
    const hex = String(hexPriv || '')
      .trim()
      .replace(/^0x/i, '')
      .toLowerCase();
    if (!isHex64(hex)) return { ok: false, code: 'INVALID_KEY' };
    try {
      const raw = b.importExistingSecureIdentity(JSON.stringify({ privkey: hex }));
      const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
      return {
        ok: !!(parsed && parsed.ok === true),
        code: String((parsed && (parsed.code || parsed.errorCode)) || 'NATIVE_CRYPTO_FAILED'),
        pubkey: parsed && parsed.pubkey ? String(parsed.pubkey).toLowerCase() : '',
        generation: parsed && typeof parsed.generation === 'number' ? parsed.generation : -1,
      };
    } catch (_e) {
      return { ok: false, code: 'NATIVE_CRYPTO_FAILED' };
    }
  }

  function wrapSwitchAccountFromRawKey() {
    const App = window.NostrApp || window.App;
    if (!App || typeof App.switchAccountFromRawKey !== 'function') return;
    if (App.__sosExistingKeyImportWrapped) return;
    const original = App.switchAccountFromRawKey.bind(App);
    App.switchAccountFromRawKey = function (rawInput, options) {
      const opts = options && typeof options === 'object' ? options : {};
      const b = bridge();
      if (b && typeof b.importExistingSecureIdentity === 'function') {
        let prepared = null;
        try {
          if (typeof App.prepareAccountSwitch === 'function') {
            prepared = App.prepareAccountSwitch(rawInput);
          }
        } catch (_p) {
          prepared = null;
        }
        if (!prepared || !prepared.ok || !prepared.privateKey) {
          return { ok: false, reason: 'INVALID_TARGET', code: 'INVALID_KEY' };
        }
        const native = importViaNative(prepared.privateKey);
        if (!native.ok) {
          return {
            ok: false,
            reason: native.code,
            code: native.code,
            state: 'IDENTITY_RECOVERY_REQUIRED',
            hebrewError: hebrewError(native.code),
          };
        }
        try {
          App.privateKey = null;
          App.publicKey = native.pubkey || prepared.publicKey;
          App.guestMode = false;
          App.identityState = 'IDENTITY_OK';
          App._nativeSyncedPubkey = App.publicKey;
          App._nativeSyncedPrivkey = null;
        } catch (_a) {}
        try {
          const SA = App.SessionAuthority || window.SosSessionAuthority;
          if (SA && typeof SA.revokeSession === 'function') {
            SA.revokeSession({
              reason: 'account_switch',
              nextAccountPubkey: App.publicKey,
              rebind: true,
            });
          } else if (SA && typeof SA.bindCurrentSession === 'function') {
            SA.bindCurrentSession({ accountPubkey: App.publicKey, bump: true });
          }
        } catch (_sa) {}
        try {
          if (typeof App.syncTopBarAuthUi === 'function') App.syncTopBarAuthUi();
        } catch (_ui) {}
        try {
          window.dispatchEvent(
            new CustomEvent('sos-existing-key-imported', {
              detail: {
                ok: true,
                code: 'IMPORT_OK',
                pubkey: App.publicKey,
                guestMode: false,
              },
            })
          );
        } catch (_ev) {}
        if (opts.reload === true) {
          try {
            setTimeout(function () {
              window.location.reload();
            }, 50);
          } catch (_r) {}
        }
        return {
          ok: true,
          reason: 'SWITCH_COMPLETE',
          publicKey: App.publicKey,
          code: 'IMPORT_OK',
          ACCOUNT_SWITCH_GENERATES_REPLACEMENT_IDENTITY: false,
        };
      }
      return original(rawInput, options);
    };
    App.__sosExistingKeyImportWrapped = true;
    App.existingKeyImportHebrewError = hebrewError;
  }

  function patchAll() {
    wrapGetPublicKeyHint();
    wrapEnsureKeys();
    wrapSwitchAccountFromRawKey();
    repairTypedBoot();
  }

  function schedule() {
    patchAll();
    var n = 0;
    var t = setInterval(function () {
      n += 1;
      patchAll();
      if (n >= 60) clearInterval(t);
    }, 100);
    // Keep a slower heartbeat for late Package-892 reconcile overrides.
    var h = 0;
    var slow = setInterval(function () {
      h += 1;
      repairTypedBoot();
      wrapEnsureKeys();
      if (h >= 30) clearInterval(slow);
    }, 1000);
  }

  try {
    window.addEventListener('sos-existing-key-imported', function (ev) {
      try {
        var d = (ev && ev.detail) || {};
        if (d && d.ok && isHex64(d.pubkey)) {
          applyAuthenticatedPublicState(d.pubkey, {
            source: 'import_event',
            generation: d.generation,
          });
        }
      } catch (_e) {}
    });
  } catch (_e2) {}

  try {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      schedule();
    } else {
      document.addEventListener('DOMContentLoaded', schedule);
    }
  } catch (_e3) {
    schedule();
  }
  try {
    window.addEventListener('sos-native-ready', schedule);
  } catch (_e4) {}

  try {
    window.SosOpenSealedMigrationUi = function () {
      var b = bridge();
      if (b && typeof b.openSealedMigrationUi === 'function') {
        return b.openSealedMigrationUi();
      }
      return JSON.stringify({ ok: false, errorCode: 'NOT_AVAILABLE' });
    };
  } catch (_e5) {}
})();
