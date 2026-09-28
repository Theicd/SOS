// relay-health.js – shared relay health + circuit breaker for realtime signaling (calls, P2P) | HYPER CORE TECH
// Records per-relay publish/connect outcomes. Never stores event content, keys, or payloads.
(function initRelayHealth(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  if (App.RelayHealth) return;

  const FAILS_TO_OPEN = 2;
  const BASE_BACKOFF_MS = 5000;
  const MAX_BACKOFF_MS = 5 * 60 * 1000;
  const LATENCY_ALPHA = 0.3;
  const stats = new Map(); // url -> { ok, fail, consecutiveFails, openUntil, latencyMs, lastReason, lastAt }

  function norm(url) {
    return String(url || '').trim().replace(/\/$/, '');
  }

  function entry(url) {
    const key = norm(url);
    let e = stats.get(key);
    if (!e) {
      e = { ok: 0, fail: 0, consecutiveFails: 0, openUntil: 0, latencyMs: 0, lastReason: '', lastAt: 0 };
      stats.set(key, e);
    }
    return e;
  }

  function record(url, ok, latencyMs, reason) {
    if (!norm(url)) return;
    const e = entry(url);
    e.lastAt = Date.now();
    if (ok) {
      e.ok += 1;
      e.consecutiveFails = 0;
      e.openUntil = 0;
      e.lastReason = '';
      const ms = Number(latencyMs) || 0;
      if (ms > 0) e.latencyMs = e.latencyMs ? Math.round(e.latencyMs * (1 - LATENCY_ALPHA) + ms * LATENCY_ALPHA) : ms;
      return;
    }
    e.fail += 1;
    e.consecutiveFails += 1;
    e.lastReason = String(reason || 'other').slice(0, 32);
    if (e.consecutiveFails >= FAILS_TO_OPEN) {
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, e.consecutiveFails - FAILS_TO_OPEN));
      e.openUntil = Date.now() + backoff;
    }
  }

  /** Circuit closed, or open window elapsed (half-open: one probe allowed until next failure). */
  function isAvailable(url) {
    const e = stats.get(norm(url));
    return !e || !e.openUntil || Date.now() >= e.openUntil;
  }

  /** Healthy relays first (by latency); circuit-open relays dropped unless nothing else is left. */
  function select(urls) {
    const list = (Array.isArray(urls) ? urls : []).map(norm).filter(Boolean);
    const open = list.filter(isAvailable);
    const pick = open.length ? open : list;
    return pick.slice().sort((a, b) => {
      const la = (stats.get(a) || {}).latencyMs || 0;
      const lb = (stats.get(b) || {}).latencyMs || 0;
      if (!la || !lb) return 0;
      return la - lb;
    });
  }

  function snapshot() {
    const out = {};
    stats.forEach((e, url) => {
      out[url] = {
        ok: e.ok,
        fail: e.fail,
        consecutiveFails: e.consecutiveFails,
        circuitOpen: !!(e.openUntil && Date.now() < e.openUntil),
        latencyMs: e.latencyMs,
        lastReason: e.lastReason,
      };
    });
    return out;
  }

  function reset() {
    stats.clear();
  }

  App.RelayHealth = { record, isAvailable, select, snapshot, reset, FAILS_TO_OPEN, BASE_BACKOFF_MS, MAX_BACKOFF_MS };
})(typeof window !== 'undefined' ? window : globalThis);
