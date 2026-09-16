;(function initChatSecureEpoch(root) {
  // חלק אבטחה (chat-secure-epoch.js) – שער epoch לצ'אט פרטי; cutover כבוי כשאין minSecureChatEpoch | HYPER CORE TECH
  const App = root.NostrApp || (root.NostrApp = {});

  const GATE_STATES = Object.freeze({
    CHECKING: 'CHECKING',
    READY: 'READY',
    UPDATE_REQUIRED: 'UPDATE_REQUIRED',
    CHECK_FAILED: 'CHECK_FAILED',
  });

  const LAST_KNOWN_MIN_KEY = 'sos_secure_chat_min_epoch';
  const RELOAD_ATTEMPTS_KEY = 'sos_secure_epoch_reload_attempts';
  const CHANNEL_NAME = 'sos-secure-epoch';
  const APP_VERSION_URL = './app-version.json';
  const MAX_RELOAD_ATTEMPTS = 3;
  const BLOCKER_ID = 'sos-secure-epoch-blocker';

  let gateState = GATE_STATES.CHECKING;
  let requiredEpoch = 0;
  let evaluatePromise = null;
  let blockerShown = false;
  let bc = null;

  function getLocalSecureChatEpoch() {
    if (typeof App.__qaSecureChatEpochOverride === 'number' && Number.isFinite(App.__qaSecureChatEpochOverride)) {
      return Math.max(0, Math.floor(App.__qaSecureChatEpochOverride));
    }
    const n = Number(App.SOS_SECURE_CHAT_EPOCH);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  function readLastKnownMinEpoch() {
    try {
      const raw = root.localStorage && root.localStorage.getItem(LAST_KNOWN_MIN_KEY);
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return 0;
      return Math.floor(n);
    } catch (_err) {
      return 0;
    }
  }

  function writeLastKnownMinEpoch(value) {
    const next = Math.max(0, Math.floor(Number(value) || 0));
    const prev = readLastKnownMinEpoch();
    // Monotonic: never lower required security floor from stale/missing responses.
    const stored = Math.max(prev, next);
    try {
      if (root.localStorage) root.localStorage.setItem(LAST_KNOWN_MIN_KEY, String(stored));
    } catch (_err) { /* ignore quota */ }
    return stored;
  }

  function parseRemoteMinSecureChatEpoch(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 0;
    if (!Object.prototype.hasOwnProperty.call(data, 'minSecureChatEpoch')) return 0;
    const n = Number(data.minSecureChatEpoch);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  /**
   * Pure decision helper (QA + runtime).
   * fetchOk=false + lastKnownMin=0 → READY (cutover never activated).
   * fetchOk=false + lastKnownMin>0 → fail-closed (CHECK_FAILED or UPDATE_REQUIRED).
   */
  function decideSecureChatGate({ localEpoch, remoteMin, lastKnownMin, fetchOk }) {
    const local = Math.max(0, Math.floor(Number(localEpoch) || 0));
    const remote = Math.max(0, Math.floor(Number(remoteMin) || 0));
    const known = Math.max(0, Math.floor(Number(lastKnownMin) || 0));

    if (!fetchOk) {
      if (known > 0) {
        const required = known;
        if (local < required) {
          return { state: GATE_STATES.UPDATE_REQUIRED, required, local };
        }
        return { state: GATE_STATES.CHECK_FAILED, required, local };
      }
      return { state: GATE_STATES.READY, required: 0, local };
    }

    const required = Math.max(known, remote);
    if (required <= local) {
      return { state: GATE_STATES.READY, required, local };
    }
    return { state: GATE_STATES.UPDATE_REQUIRED, required, local };
  }

  function getSecureChatGateState() {
    return gateState;
  }

  function isSecureChatReady() {
    return gateState === GATE_STATES.READY;
  }

  function isPrivateChatBlockedBySecureEpoch() {
    return gateState === GATE_STATES.UPDATE_REQUIRED || gateState === GATE_STATES.CHECK_FAILED;
  }

  function stopPrivateChatProcessing(reason) {
    try {
      if (typeof App.stopPrivateChatSubscription === 'function') {
        App.stopPrivateChatSubscription(reason || 'secure-epoch');
      }
    } catch (_err) { /* ignore */ }
  }

  function readReloadAttempts() {
    try {
      const n = Number(root.sessionStorage && root.sessionStorage.getItem(RELOAD_ATTEMPTS_KEY));
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch (_err) {
      return 0;
    }
  }

  function writeReloadAttempts(n) {
    try {
      if (root.sessionStorage) root.sessionStorage.setItem(RELOAD_ATTEMPTS_KEY, String(Math.max(0, n | 0)));
    } catch (_err) { /* ignore */ }
  }

  function clearReloadAttempts() {
    try {
      if (root.sessionStorage) root.sessionStorage.removeItem(RELOAD_ATTEMPTS_KEY);
    } catch (_err) { /* ignore */ }
  }

  function broadcastSecureUpdateRequired(required) {
    try {
      if (!bc && typeof root.BroadcastChannel === 'function') {
        bc = new root.BroadcastChannel(CHANNEL_NAME);
      }
      if (bc) {
        bc.postMessage({
          type: 'SECURE_UPDATE_REQUIRED',
          required: required || requiredEpoch || 0,
          local: getLocalSecureChatEpoch(),
        });
      }
    } catch (_err) { /* ignore */ }
  }

  function ensureBlockerStyles() {
    if (root.document && root.document.getElementById('sos-secure-epoch-style')) return;
    try {
      const style = root.document.createElement('style');
      style.id = 'sos-secure-epoch-style';
      style.textContent = [
        '#' + BLOCKER_ID + '{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;',
        'background:rgba(8,12,18,.72);padding:24px;box-sizing:border-box;font-family:inherit;}',
        '#' + BLOCKER_ID + ' .sos-secure-epoch-card{max-width:420px;width:100%;background:#101820;color:#f3f6fa;border-radius:14px;',
        'padding:22px 20px;box-shadow:0 12px 40px rgba(0,0,0,.35);text-align:center;direction:rtl;}',
        '#' + BLOCKER_ID + ' .sos-secure-epoch-title{font-size:1.05rem;font-weight:700;margin:0 0 10px;}',
        '#' + BLOCKER_ID + ' .sos-secure-epoch-body{font-size:.92rem;line-height:1.45;opacity:.92;margin:0 0 18px;}',
        '#' + BLOCKER_ID + ' .sos-secure-epoch-now{appearance:none;border:0;border-radius:10px;padding:12px 18px;font-size:1rem;',
        'font-weight:700;cursor:pointer;background:#2f6fed;color:#fff;width:100%;}',
        '#' + BLOCKER_ID + ' .sos-secure-epoch-now:disabled{opacity:.55;cursor:default;}',
        '#' + BLOCKER_ID + ' .sos-secure-epoch-hint{margin-top:12px;font-size:.8rem;opacity:.75;}',
      ].join('');
      root.document.head.appendChild(style);
    } catch (_err) { /* ignore */ }
  }

  async function requestSecureReload() {
    const attempts = readReloadAttempts();
    if (attempts >= MAX_RELOAD_ATTEMPTS) {
      showSecureUpdateBlocker({ exhausted: true });
      return;
    }
    writeReloadAttempts(attempts + 1);
    try {
      const reg = root.navigator && root.navigator.serviceWorker
        ? await root.navigator.serviceWorker.getRegistration()
        : null;
      if (reg) {
        try { await reg.update(); } catch (_u) { /* continue */ }
        if (reg.waiting) {
          try { reg.waiting.postMessage({ type: 'SKIP_WAITING' }); } catch (_m) { /* continue */ }
        }
      }
    } catch (_err) { /* continue to hard reload */ }
    try {
      if (typeof App.prepareCleanReloadAfterUiUpdate === 'function') {
        App.prepareCleanReloadAfterUiUpdate();
        return;
      }
    } catch (_err) { /* fall through */ }
    try {
      root.location.reload();
    } catch (_err2) {
      try { root.location.href = root.location.href; } catch (_err3) { /* stuck */ }
    }
  }

  function showSecureUpdateBlocker(opts) {
    if (!root.document) return;
    ensureBlockerStyles();
    const exhausted = !!(opts && opts.exhausted);
    let el = root.document.getElementById(BLOCKER_ID);
    if (!el) {
      el = root.document.createElement('div');
      el.id = BLOCKER_ID;
      el.setAttribute('role', 'alertdialog');
      el.setAttribute('aria-modal', 'true');
      root.document.body.appendChild(el);
    }
    const hint = exhausted
      ? 'העדכון לא הושלם. נסה שוב או רענן ידנית לאחר חיבור לרשת.'
      : gateState === GATE_STATES.CHECK_FAILED
        ? 'לא ניתן לאמת את דרישות האבטחה כרגע. הצ׳אט נעול עד לאימות.'
        : 'אין אפשרות לדחות עדכון אבטחה זה.';
    el.innerHTML =
      '<div class="sos-secure-epoch-card">' +
      '<p class="sos-secure-epoch-title">נדרש עדכון אבטחה כדי להמשיך בצ\'אט.</p>' +
      '<p class="sos-secure-epoch-body">גרסת האפליקציה בטאב זה אינה עומדת בדרישת האבטחה הנוכחית.</p>' +
      '<button type="button" class="sos-secure-epoch-now">עדכן עכשיו</button>' +
      '<p class="sos-secure-epoch-hint">' + hint + '</p>' +
      '</div>';
    const btn = el.querySelector('.sos-secure-epoch-now');
    if (btn) {
      btn.onclick = function onSecureUpdateNow(e) {
        try { e.preventDefault(); e.stopPropagation(); } catch (_err) { /* ignore */ }
        btn.disabled = true;
        requestSecureReload();
      };
    }
    blockerShown = true;
    // No "Later" control — intentional for secure epoch cutover.
  }

  function hideSecureUpdateBlocker() {
    try {
      const el = root.document && root.document.getElementById(BLOCKER_ID);
      if (el) el.remove();
    } catch (_err) { /* ignore */ }
    blockerShown = false;
  }

  function applySecureChatGateDecision(decision, options) {
    const opts = options || {};
    gateState = decision.state;
    requiredEpoch = decision.required || 0;
    try {
      console.log(
        '[E2EE/EPOCH] local=' + (decision.local != null ? decision.local : getLocalSecureChatEpoch()) +
          ' required=' + requiredEpoch +
          ' state=' + gateState
      );
    } catch (_err) { /* ignore */ }

    if (gateState === GATE_STATES.READY) {
      clearReloadAttempts();
      hideSecureUpdateBlocker();
      return gateState;
    }

    stopPrivateChatProcessing(gateState);
    if (!opts.silentUi) {
      const attempts = readReloadAttempts();
      showSecureUpdateBlocker({ exhausted: attempts >= MAX_RELOAD_ATTEMPTS });
      if (gateState === GATE_STATES.UPDATE_REQUIRED) {
        broadcastSecureUpdateRequired(requiredEpoch);
        if (!opts.skipAutoReload && attempts < MAX_RELOAD_ATTEMPTS && !opts.fromBroadcast) {
          // Bounded auto-reload once per evaluate when cutover requires newer code.
          if (attempts === 0) {
            requestSecureReload();
          }
        }
      }
    }
    return gateState;
  }

  async function fetchAuthoritativeAppVersionJson() {
    const fetchFn = typeof App.__qaSecureEpochFetch === 'function'
      ? App.__qaSecureEpochFetch
      : (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    if (!fetchFn) throw new Error('fetch-unavailable');
    const url = APP_VERSION_URL + '?_=' + Date.now();
    const res = await fetchFn(url, { cache: 'no-store' });
    if (!res || !res.ok) throw new Error('app-version-http');
    const data = await res.json();
    return data;
  }

  async function evaluateSecureChatEpoch(options) {
    const opts = options || {};
    gateState = GATE_STATES.CHECKING;
    const local = getLocalSecureChatEpoch();
    const lastKnown = readLastKnownMinEpoch();
    let fetchOk = false;
    let remoteMin = 0;
    try {
      const data = await fetchAuthoritativeAppVersionJson();
      remoteMin = parseRemoteMinSecureChatEpoch(data);
      fetchOk = true;
      writeLastKnownMinEpoch(remoteMin);
    } catch (_err) {
      fetchOk = false;
    }
    const knownAfter = readLastKnownMinEpoch();
    const decision = decideSecureChatGate({
      localEpoch: local,
      remoteMin,
      lastKnownMin: knownAfter,
      fetchOk,
    });
    // Persist monotonic floor also when remote reported higher than known.
    if (fetchOk && decision.required > 0) {
      writeLastKnownMinEpoch(decision.required);
    }
    applySecureChatGateDecision(decision, opts);
    return gateState === GATE_STATES.READY;
  }

  function ensureSecureChatEpochReady(options) {
    if (evaluatePromise) return evaluatePromise;
    evaluatePromise = Promise.resolve()
      .then(() => evaluateSecureChatEpoch(options))
      .finally(() => {
        evaluatePromise = null;
      });
    return evaluatePromise;
  }

  function onSecureEpochBroadcast(event) {
    try {
      const data = event && event.data;
      if (!data || data.type !== 'SECURE_UPDATE_REQUIRED') return;
      const required = Math.max(0, Math.floor(Number(data.required) || 0));
      if (required > 0) writeLastKnownMinEpoch(required);
      const local = getLocalSecureChatEpoch();
      if (local >= required && required > 0) {
        // Peer tab is stale; this tab meets floor — re-check network when possible.
        ensureSecureChatEpochReady({ skipAutoReload: true });
        return;
      }
      applySecureChatGateDecision(
        {
          state: GATE_STATES.UPDATE_REQUIRED,
          required: Math.max(required, readLastKnownMinEpoch()),
          local,
        },
        { fromBroadcast: true, skipAutoReload: false }
      );
    } catch (_err) { /* ignore */ }
  }

  function initSecureEpochChannel() {
    try {
      if (typeof root.BroadcastChannel !== 'function') return;
      bc = new root.BroadcastChannel(CHANNEL_NAME);
      bc.addEventListener('message', onSecureEpochBroadcast);
    } catch (_err) { /* ignore */ }
  }

  function initSecureEpochOnlineRetry() {
    try {
      if (!root.addEventListener) return;
      root.addEventListener('online', () => {
        if (gateState === GATE_STATES.CHECK_FAILED || gateState === GATE_STATES.UPDATE_REQUIRED) {
          ensureSecureChatEpochReady({ skipAutoReload: true }).then((ok) => {
            if (ok && typeof App.resumePrivateChatAfterSecureEpoch === 'function') {
              try { App.resumePrivateChatAfterSecureEpoch(); } catch (_e) { /* ignore */ }
            }
          });
        }
      });
    } catch (_err) { /* ignore */ }
  }

  const api = {
    GATE_STATES,
    SOS_SECURE_EPOCH_CHANNEL: CHANNEL_NAME,
    MAX_SECURE_EPOCH_RELOAD_ATTEMPTS: MAX_RELOAD_ATTEMPTS,
    LAST_KNOWN_MIN_KEY,
    getLocalSecureChatEpoch,
    parseRemoteMinSecureChatEpoch,
    decideSecureChatGate,
    getSecureChatGateState,
    isSecureChatReady,
    isPrivateChatBlockedBySecureEpoch,
    ensureSecureChatEpochReady,
    evaluateSecureChatEpoch,
    applySecureChatGateDecision,
    readLastKnownMinEpoch,
    writeLastKnownMinEpoch,
    showSecureUpdateBlocker,
    requestSecureReload,
    readReloadAttempts,
    clearReloadAttempts,
  };

  Object.assign(App, {
    getSecureChatGateState,
    isSecureChatReady,
    isPrivateChatBlockedBySecureEpoch,
    ensureSecureChatEpochReady,
    evaluateSecureChatEpoch,
    decideSecureChatGate,
    parseRemoteMinSecureChatEpoch,
    getLocalSecureChatEpoch,
    GATE_STATES_SECURE_CHAT: GATE_STATES,
  });

  root.SosSecureChatEpoch = api;
  initSecureEpochChannel();
  initSecureEpochOnlineRetry();
  return api;
})(typeof window !== 'undefined' ? window : globalThis);
