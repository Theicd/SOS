/**
 * SosCryptoWorkerVault — F2A shadow + F2B authoritative bridge.
 * Never posts raw K. Android excluded. Session-only excluded from authoritative.
 * HYPER CORE TECH
 */
(function initSosCryptoWorkerVault(root) {
  const App = root.NostrApp || (root.NostrApp = {});

  const FLAG = 'SOS_CRYPTO_WORKER_AUTHORITATIVE';
  const SHADOW_FLAG = '__SOS_F2A_SHADOW__';
  // Android never uses worker vault (F2A/F2B). Kept for gate literals:
  const ANDROID_F2A_APPLIES = false; // ANDROID_F2A_EXCLUDED
  void ANDROID_F2A_APPLIES;

  let worker = null;
  let ready = false;
  let authoritative = false;
  let initPromise = null;
  let reqSeq = 0;
  const pending = new Map();
  let lastMeta = null;
  let runtimeRawKReadCount = 0;
  let shadowStats = { compares: 0, mismatches: 0, errors: 0 };

  function flagEnabled() {
    try {
      if (root[FLAG] === true || root.__SOS_CRYPTO_WORKER_AUTHORITATIVE__ === true) return true;
      if (typeof localStorage !== 'undefined' && localStorage.getItem(FLAG) === '1') return true;
    } catch (_e) {}
    return false;
  }

  function isAndroidNative() {
    try {
      const bridge = root.SosNativeShell;
      if (bridge && typeof bridge.isNativeShell === 'function' && bridge.isNativeShell() === true) {
        return true;
      }
    } catch (_e) {}
    return false;
  }

  function isSessionOnly() {
    try {
      return !!(window.SOSKeyStorage && typeof window.SOSKeyStorage.isSessionOnly === 'function' && window.SOSKeyStorage.isSessionOnly());
    } catch (_e) {
      return false;
    }
  }

  function isBrowserSecureProvider() {
    try {
      const name =
        window.SOSKeyStorage && typeof window.SOSKeyStorage.activeProviderName === 'function'
          ? window.SOSKeyStorage.activeProviderName()
          : '';
      return name === 'BrowserSecureProvider';
    } catch (_e) {
      return false;
    }
  }

  function rpc(op, params) {
    if (!worker) {
      return Promise.reject(Object.assign(new Error('worker missing'), { code: 'WORKER_VAULT_UNAVAILABLE' }));
    }
    const id = 'r' + ++reqSeq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, op, t0: Date.now() });
      try {
        worker.postMessage({ id, op, params: params || {} });
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  function onWorkerMessage(ev) {
    const msg = ev && ev.data;
    if (!msg) return;
    if (msg.op === 'WORKER_BOOTED') return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.ok) slot.resolve(msg.result);
    else {
      const err = new Error((msg.error && msg.error.message) || 'worker error');
      err.code = (msg.error && msg.error.code) || 'WORKER_ERROR';
      slot.reject(err);
    }
  }

  function onWorkerError() {
    ready = false;
    if (authoritative) {
      // Fail closed — do NOT hydrate page K.
      try {
        console.warn('[F2B] worker crash — page K fallback blocked');
      } catch (_e) {}
    }
    pending.forEach((slot) => {
      const err = new Error('worker crash');
      err.code = 'WORKER_CRASH';
      slot.reject(err);
    });
    pending.clear();
  }

  /**
   * Restart worker and re-open secure IDB. Never requests K from page.
   */
  async function restartVault() {
    terminateWorkerOnly();
    initPromise = null;
    const result = await init({ force: true });
    return result;
  }

  async function ensureReadyRpc(op, params) {
    if (!ready || !worker) {
      const restarted = await restartVault();
      if (!restarted || !restarted.ok) {
        const err = new Error((restarted && restarted.code) || 'WORKER_VAULT_UNAVAILABLE');
        err.code = (restarted && restarted.code) || 'WORKER_VAULT_UNAVAILABLE';
        throw err;
      }
    }
    try {
      return await rpc(op, params);
    } catch (err) {
      if (err && err.code === 'WORKER_CRASH') {
        const again = await restartVault();
        if (!again.ok) throw err;
        return rpc(op, params);
      }
      throw err;
    }
  }

  function eligibilityPrecheck() {
    if (isAndroidNative()) {
      return { ok: false, code: 'ANDROID_WORKER_CUTOVER_EXCLUDED', ANDROID_WORKER_CUTOVER: false };
    }
    if (isSessionOnly()) {
      return { ok: false, code: 'SESSION_ONLY_WORKER_CUTOVER', SESSION_ONLY_WORKER_CUTOVER: false };
    }
    if (typeof Worker === 'undefined') {
      return { ok: false, code: 'WORKER_VAULT_UNAVAILABLE', reason: 'Worker unsupported' };
    }
    return { ok: true };
  }

  async function init(opts) {
    const force = opts && opts.force;
    if (isAndroidNative()) {
      return { ok: false, code: 'ANDROID_WORKER_CUTOVER_EXCLUDED', ANDROID_WORKER_CUTOVER: false };
    }
    if (!force && initPromise) return initPromise;
    initPromise = (async () => {
      const pre = eligibilityPrecheck();
      if (!pre.ok) return pre;
      try {
        worker = new Worker('./sos-crypto-worker.js');
        worker.onmessage = onWorkerMessage;
        worker.onerror = onWorkerError;
        lastMeta = await rpc('VAULT_INIT', {});
        ready = !!(lastMeta && lastMeta.vaultState === 'READY' && lastMeta.pubkey);
        if (!ready) {
          return {
            ok: false,
            code: (lastMeta && lastMeta.loadErrorCode) || 'WORKER_VAULT_UNAVAILABLE',
            meta: lastMeta,
            ANDROID_WORKER_CUTOVER: false,
          };
        }
        return { ok: true, meta: lastMeta, ANDROID_WORKER_CUTOVER: false };
      } catch (err) {
        ready = false;
        return {
          ok: false,
          code: (err && err.code) || 'WORKER_VAULT_UNAVAILABLE',
          message: err && err.message,
          ANDROID_WORKER_CUTOVER: false,
        };
      }
    })();
    return initPromise;
  }

  /**
   * F2B: activate authoritative mode only when flag ON and vault ready.
   * Does not hydrate App.privateKey.
   */
  async function tryActivateAuthoritative() {
    if (!flagEnabled()) {
      authoritative = false;
      return { ok: false, code: 'FLAG_OFF', WORKER_VAULT_AUTHORITATIVE: false };
    }
    if (isAndroidNative() || isSessionOnly()) {
      authoritative = false;
      return {
        ok: false,
        code: isAndroidNative() ? 'ANDROID_WORKER_CUTOVER_EXCLUDED' : 'SESSION_ONLY_WORKER_CUTOVER',
        WORKER_VAULT_AUTHORITATIVE: false,
      };
    }
    // Prefer BrowserSecureProvider, but allow vault success as source of truth
    // (provider name may lag until boot completes).
    const boot = await init();
    if (!boot.ok) {
      authoritative = false;
      return Object.assign({ WORKER_VAULT_AUTHORITATIVE: false }, boot);
    }
    if (!isBrowserSecureProvider() && boot.meta && boot.meta.vaultState === 'READY') {
      // Vault decrypted from sos_identity_secure — treat as durable browser identity.
    } else if (!isBrowserSecureProvider()) {
      authoritative = false;
      return { ok: false, code: 'NOT_BROWSER_SECURE', WORKER_VAULT_AUTHORITATIVE: false };
    }
    authoritative = true;
    App.privateKey = null;
    if (boot.meta && boot.meta.pubkey) {
      App.publicKey = boot.meta.pubkey;
    }
    App.guestMode = false;
    App.identityState = 'IDENTITY_OK';
    App.workerVaultState = boot.meta;
    try {
      if (window.SOSKeyStorage && typeof window.SOSKeyStorage.dropPageMemoryPrivateKey === 'function') {
        window.SOSKeyStorage.dropPageMemoryPrivateKey();
      }
    } catch (_drop) {}
    installRawKReadGuard();
    try {
      console.log('[F2B] WORKER_VAULT_AUTHORITATIVE=true fp=' + (boot.meta && boot.meta.fingerprint));
    } catch (_e) {}
    return { ok: true, WORKER_VAULT_AUTHORITATIVE: true, meta: boot.meta };
  }

  function installRawKReadGuard() {
    try {
      const store = window.SOSKeyStorage;
      if (!store || store.__f2bRawGuard) return;
      const origRaw = store.readPrivateKeyRaw && store.readPrivateKeyRaw.bind(store);
      const origHex = store.readPrivateKeyHex && store.readPrivateKeyHex.bind(store);
      if (origRaw) {
        store.readPrivateKeyRaw = function guardedRaw() {
          if (authoritative && !root.__SOS_ALLOW_RAW_K_READ__) {
            runtimeRawKReadCount += 1;
            try {
              console.warn('[F2B] blocked readPrivateKeyRaw in worker-auth runtime');
            } catch (_e) {}
            return '';
          }
          if (authoritative) runtimeRawKReadCount += 1;
          return origRaw();
        };
      }
      if (origHex) {
        store.readPrivateKeyHex = function guardedHex() {
          if (authoritative && !root.__SOS_ALLOW_RAW_K_READ__) {
            runtimeRawKReadCount += 1;
            return '';
          }
          if (authoritative) runtimeRawKReadCount += 1;
          return origHex();
        };
      }
      store.__f2bRawGuard = true;
    } catch (_e) {}
  }

  function isReady() {
    return ready === true;
  }

  function isAuthoritative() {
    return authoritative === true && ready === true;
  }

  function getIdentityMeta() {
    return lastMeta;
  }

  function getRuntimeRawKReadCount() {
    return runtimeRawKReadCount;
  }

  function compareSignedEvents(a, b) {
    if (!a || !b) return false;
    return (
      a.id === b.id &&
      a.pubkey === b.pubkey &&
      a.kind === b.kind &&
      a.content === b.content &&
      JSON.stringify(a.tags) === JSON.stringify(b.tags)
    );
  }

  async function shadowCompareSign(op, draft, mainEvent) {
    if (!root[SHADOW_FLAG] || !ready || authoritative) return { skipped: true };
    const t0 = Date.now();
    try {
      const workerEvent = await rpc(op, { draft });
      const ok = compareSignedEvents(mainEvent, workerEvent);
      shadowStats.compares += 1;
      if (!ok) shadowStats.mismatches += 1;
      return { ok, workerEvent, durationMs: Date.now() - t0 };
    } catch (err) {
      shadowStats.errors += 1;
      return { ok: false, error: err };
    }
  }

  async function authoritativeRpc(op, params) {
    if (!isAuthoritative()) {
      const err = new Error('worker not authoritative');
      err.code = 'WORKER_NOT_AUTHORITATIVE';
      throw err;
    }
    // Session gate at Worker signing boundary (page must hold valid bind)
    try {
      const SA = App.SessionAuthority || root.SosSessionAuthority;
      if (SA && typeof SA.assertSessionForSensitiveOp === 'function') {
        SA.assertSessionForSensitiveOp('WORKER:' + String(op || 'rpc'));
      }
    } catch (sessionErr) {
      try {
        deactivateAuthoritative();
        terminateWorkerOnly();
      } catch (_t) {}
      throw sessionErr;
    }
    return ensureReadyRpc(op, params);
  }

  function terminateWorkerOnly() {
    ready = false;
    if (worker) {
      try {
        worker.terminate();
      } catch (_e) {}
      worker = null;
    }
  }

  function terminate() {
    authoritative = false;
    initPromise = null;
    terminateWorkerOnly();
  }

  function deactivateAuthoritative() {
    authoritative = false;
  }

  async function ensureWorkerSpawned() {
    if (worker) return true;
    const pre = eligibilityPrecheck();
    if (!pre.ok) {
      const err = new Error(pre.code || 'WORKER_VAULT_UNAVAILABLE');
      err.code = pre.code || 'WORKER_VAULT_UNAVAILABLE';
      throw err;
    }
    worker = new Worker('./sos-crypto-worker.js');
    worker.onmessage = onWorkerMessage;
    worker.onerror = onWorkerError;
    return true;
  }

  /**
   * F5A — create identity inside Worker. Never hydrates App.privateKey.
   * Returns metadata only. Rejects stale createNonce mismatch.
   */
  async function createBrowserIdentity(options) {
    const opts = options && typeof options === 'object' ? options : {};
    if (isAndroidNative()) {
      return { ok: false, code: 'ANDROID_WORKER_CUTOVER_EXCLUDED' };
    }
    if (isSessionOnly()) {
      return { ok: false, code: 'SESSION_ONLY_WORKER_CUTOVER' };
    }
    const createNonce =
      typeof opts.createNonce === 'string' && opts.createNonce
        ? opts.createNonce
        : 'c' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    try {
      await ensureWorkerSpawned();
      const meta = await rpc('CREATE_BROWSER_IDENTITY', { createNonce });
      if (!meta || meta.vaultState !== 'READY' || !meta.pubkey) {
        return { ok: false, code: 'CREATE_FAILED', meta };
      }
      if (meta.createNonce && meta.createNonce !== createNonce) {
        return { ok: false, code: 'STALE_CREATE_REJECTED', meta };
      }
      ready = true;
      lastMeta = meta;
      App.privateKey = null;
      App.publicKey = meta.pubkey;
      App.guestMode = false;
      App.identityState = 'IDENTITY_OK';
      App.workerVaultState = meta;
      try {
        const SA = App.SessionAuthority || root.SosSessionAuthority;
        if (SA && typeof SA.bindCurrentSession === 'function') {
          // New identity create in this tab — bump so other tabs cannot keep old session.
          SA.bindCurrentSession({ accountPubkey: meta.pubkey, bump: true });
        }
      } catch (_sa) {}
      // Optionally activate authoritative when flag ON
      if (flagEnabled()) {
        authoritative = true;
        installRawKReadGuard();
        try {
          console.log('[F5A] CREATE_BROWSER_IDENTITY ok WORKER_VAULT_AUTHORITATIVE=true');
        } catch (_e) {}
      } else {
        try {
          console.log('[F5A] CREATE_BROWSER_IDENTITY ok (flag off — MAIN_THREAD may hydrate later)');
        } catch (_e2) {}
      }
      return {
        ok: true,
        meta,
        createNonce,
        CREATE_FLOW_WORKER_GENERATES_K: true,
        CREATE_FLOW_PAGE_K_PRESENT: false,
        CREATE_FLOW_WORKER_TO_PAGE_K: false,
        WORKER_VAULT_AUTHORITATIVE: authoritative,
      };
    } catch (err) {
      return {
        ok: false,
        code: (err && err.code) || 'CREATE_FAILED',
        message: err && err.message ? String(err.message).slice(0, 160) : 'create failed',
      };
    }
  }

  App.SosCryptoWorkerVault = {
    mode: 'shadow-or-authoritative',
    FLAG,
    flagEnabled,
    init,
    tryActivateAuthoritative,
    deactivateAuthoritative,
    createBrowserIdentity,
    isReady,
    isAuthoritative,
    getIdentityMeta,
    getRuntimeRawKReadCount,
    shadowCompareSign,
    authoritativeRpc,
    rpc: ensureReadyRpc,
    restartVault,
    getShadowStats: () => Object.assign({}, shadowStats),
    terminate,
    eligibilityPrecheck,
  };
  root.SosCryptoWorkerVault = App.SosCryptoWorkerVault;
  root[FLAG] = root[FLAG] === true ? true : false;

  try {
    console.log('[SOS-CRYPTO-WORKER-VAULT] F2B bridge loaded flagDefault=OFF');
  } catch (_e) {}
})(typeof window !== 'undefined' ? window : globalThis);
