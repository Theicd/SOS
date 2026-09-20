/**
 * Call-cold boot priority — establish BEFORE expensive home/feed subsystems.
 * Must load early (non-defer) in videos.html.
 */
(function initSosCallColdBoot(window) {
  const deferred = [];
  const deferredNames = new Set();
  const startedNames = new Set();
  let active = false;
  let released = false;
  let enabledLogged = false;
  let enableSource = '';

  function detectSource() {
    try {
      const params = new URLSearchParams(window.location.search || '');
      if (String(params.get('incomingCall') || '').trim()) return 'url';
    } catch (_) {}
    try {
      if (window.__sosNativePendingAnswer && window.__sosNativePendingAnswer.peer) return 'pending-answer';
    } catch (_) {}
    try {
      const bridge = window.SosNativeShell;
      if (bridge && typeof bridge.isIncomingCallAnsweredForPeer === 'function') {
        // Bridge present; answered-for-peer may be consulted later with peer.
        if (window.__sosIncomingCallActive) return 'native';
      }
    } catch (_) {}
    try {
      if (window.__sosIncomingCallActive) return 'native';
    } catch (_) {}
    try {
      if (document.body && document.body.classList.contains('sos-call-active')) return 'native';
    } catch (_) {}
    return '';
  }

  function detectFromPage() {
    return !!detectSource()
      || (function () {
        try {
          return document.documentElement.getAttribute('data-sos-deeplink') === '1'
            && String(window.location.search || '').includes('incomingCall');
        } catch (_) {
          return false;
        }
      })();
  }

  function enable(reason) {
    if (released) return false;
    if (active) return true;
    active = true;
    const src = detectSource() || String(reason || 'detect');
    enableSource = src;
    if (!enabledLogged) {
      enabledLogged = true;
      try {
        console.log('CALL_COLD_BOOT_PRIORITY_ON source=' + src);
      } catch (_) {}
    }
    try {
      document.documentElement.setAttribute('data-sos-call-cold-boot', '1');
    } catch (_) {}
    return true;
  }

  function isActive() {
    if (released) return false;
    if (active) return true;
    if (detectFromPage()) {
      enable(detectSource() || 'late-detect');
      return true;
    }
    return false;
  }

  function shouldDefer(subsystem) {
    return isActive() && !released;
  }

  function defer(subsystem, fn) {
    const name = String(subsystem || 'unknown');
    if (!shouldDefer(name)) {
      try { if (typeof fn === 'function') fn(); } catch (_) {}
      return false;
    }
    if (deferredNames.has(name)) {
      return true;
    }
    deferredNames.add(name);
    try {
      console.log('CALL_COLD_BOOT_DEFER subsystem=' + name);
    } catch (_) {}
    deferred.push({ name, fn });
    return true;
  }

  /** Return true on first real start; false if already started (skip duplicate init). */
  function markEntry(subsystem) {
    const name = String(subsystem || 'unknown');
    if (startedNames.has(name)) return false;
    startedNames.add(name);
    try {
      console.log('CALL_COLD_SUBSYSTEM_ENTRY subsystem=' + name);
    } catch (_) {}
    return true;
  }

  function release(reason) {
    if (released) return;
    released = true;
    active = false;
    const why = String(reason || 'unknown');
    try {
      console.log('CALL_COLD_BOOT_RELEASE reason=' + why);
    } catch (_) {}
    try {
      document.documentElement.removeAttribute('data-sos-call-cold-boot');
    } catch (_) {}
    const queue = deferred.splice(0, deferred.length);
    deferredNames.clear();
    for (let i = 0; i < queue.length; i += 1) {
      const item = queue[i];
      try {
        if (item && typeof item.fn === 'function') item.fn();
      } catch (err) {
        try { console.warn('CALL_COLD_BOOT_RELEASE_ERR subsystem=' + (item && item.name), err); } catch (_) {}
      }
    }
  }

  function getEnableSource() {
    return enableSource || detectSource() || '';
  }

  // FIRST-PAINT: URL is available immediately — enable before deferred scripts run.
  try {
    const src = detectSource();
    if (src) enable(src);
  } catch (_) {}

  window.SosCallColdBoot = {
    isActive,
    enable,
    shouldDefer,
    defer,
    release,
    markEntry,
    detectFromPage,
    detectSource,
    getEnableSource,
  };

  try {
    const App = window.NostrApp || (window.NostrApp = {});
    App.releaseCallColdBoot = release;
    App.isCallColdBootActive = isActive;
  } catch (_) {}
})(window);
