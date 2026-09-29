// realtime-perf.js – realtime performance instrumentation (calls, P2P, main thread) | HYPER CORE TECH
// Records mark names and numbers only. Never pass keys, SDP, content, file names or event bodies here.
(function initRealtimePerf(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  if (App.RealtimePerf) return;

  const now = () => (window.performance && performance.now ? performance.now() : Date.now());
  const MAX_CALLS = 30;
  const MAX_P2P = 60;
  const LAG_INTERVAL_MS = 500;
  const CALL_SESSION_MAX_MS = 90000;
  const main = {
    bootMs: Math.round(now()),
    longTasks: 0,
    longTaskMs: 0,
    longTaskMaxMs: 0,
    loafCount: 0,
    forcedLayoutFrames: 0,
    forcedLayoutMs: 0,
    loopLagMaxMs: 0,
    loopLagOver100: 0,
  };
  const calls = []; // { media, marks: { NAME: msFromClick } }
  const current = { voice: null, video: null };
  const p2p = [];
  const SAFE_NAME = /^[A-Z0-9_]{2,48}$/;

  function safeNumbers(fields) {
    const out = {};
    if (!fields || typeof fields !== 'object') return out;
    Object.keys(fields).forEach((k) => {
      const v = fields[k];
      if (!/^[a-zA-Z0-9_]{1,32}$/.test(k)) return;
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
      else if (typeof v === 'boolean') out[k] = v;
      else if (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/.test(v)) out[k] = v;
    });
    return out;
  }

  function markCall(media, name) {
    if ((media !== 'voice' && media !== 'video') || !SAFE_NAME.test(String(name || ''))) return;
    const t = now();
    const cur = current[media];
    const startsCall = name === 'CALL_CLICK_TS' || name === 'CALL_RING_RX_TS' || name === 'CALL_OFFER_RX_TS';
    const stale = !cur || cur.marks.CALL_CONNECTED_TS != null || (t - cur.t0) > CALL_SESSION_MAX_MS;
    if (!cur || (startsCall && (stale || cur.marks[name] != null || name === 'CALL_CLICK_TS'))) {
      current[media] = { media, t0: t, wall0: Date.now(), marks: {} };
      calls.push(current[media]);
      while (calls.length > MAX_CALLS) calls.shift();
    }
    const c = current[media];
    if (c.marks[name] == null) c.marks[name] = Math.round(t - c.t0);
    if (name === 'CALL_CONNECTED_TS') {
      try { console.log('CALL_PERF media=' + media + ' ' + Object.keys(c.marks).map((k) => k + '=' + c.marks[k]).join(' ')); } catch (_) {}
    }
  }

  function markP2p(name, fields) {
    if (!SAFE_NAME.test(String(name || ''))) return;
    p2p.push({ name, at: Math.round(now()), ...safeNumbers(fields) });
    while (p2p.length > MAX_P2P) p2p.shift();
  }

  function observe(type, cb) {
    try {
      if (!window.PerformanceObserver) return;
      const supported = PerformanceObserver.supportedEntryTypes || [];
      if (supported.indexOf(type) < 0) return;
      new PerformanceObserver((list) => list.getEntries().forEach(cb)).observe({ type, buffered: true });
    } catch (_) {}
  }

  observe('longtask', (e) => {
    main.longTasks += 1;
    main.longTaskMs += e.duration;
    if (e.duration > main.longTaskMaxMs) main.longTaskMaxMs = Math.round(e.duration);
  });
  // Long Animation Frames: forcedStyleAndLayoutDuration is the closest measurable proxy for forced reflow.
  observe('long-animation-frame', (e) => {
    main.loafCount += 1;
    let forced = 0;
    try { (e.scripts || []).forEach((s) => { forced += Number(s.forcedStyleAndLayoutDuration) || 0; }); } catch (_) {}
    if (forced > 0) {
      main.forcedLayoutFrames += 1;
      main.forcedLayoutMs += forced;
    }
  });

  const HIDDEN_LAG_INTERVAL_MS = 10000;
  let lagExpected = now() + LAG_INTERVAL_MS;
  function lagTick() {
    const t = now();
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (!hidden) {
      const lag = Math.max(0, t - lagExpected);
      if (lag > main.loopLagMaxMs) main.loopLagMaxMs = Math.round(lag);
      if (lag > 100) main.loopLagOver100 += 1;
    }
    const next = hidden ? HIDDEN_LAG_INTERVAL_MS : LAG_INTERVAL_MS;
    lagExpected = t + next;
    setTimeout(lagTick, next);
  }
  setTimeout(lagTick, LAG_INTERVAL_MS);

  function snapshot() {
    return {
      main: { ...main, longTaskMs: Math.round(main.longTaskMs), forcedLayoutMs: Math.round(main.forcedLayoutMs) },
      calls: calls.map((c) => ({ media: c.media, wall0: c.wall0, marks: { ...c.marks } })),
      p2p: p2p.slice(),
      relays: App.RelayHealth && typeof App.RelayHealth.snapshot === 'function' ? App.RelayHealth.snapshot() : {},
    };
  }

  App.RealtimePerf = { markCall, markP2p, snapshot };
  try { console.log('APP_BOOT_MS=' + main.bootMs); } catch (_) {}
})(typeof window !== 'undefined' ? window : globalThis);
