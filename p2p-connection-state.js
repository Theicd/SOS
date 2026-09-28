// חלק מצב חיבור P2P (p2p-connection-state.js) – מכונת מצבים, קודי כשל קנוניים, דדליינים לפי שלב, לוג אבחון בטוח | HYPER CORE TECH
(function initP2pConnectionState(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const STATES = Object.freeze({
    IDLE: 'IDLE',
    SIGNALING: 'SIGNALING',
    OFFER_SENT: 'OFFER_SENT',
    ANSWER_WAIT: 'ANSWER_WAIT',
    ICE_CONNECTING: 'ICE_CONNECTING',
    DC_CONNECTING: 'DC_CONNECTING',
    DC_OPEN: 'DC_OPEN',
    TRANSFER_ACTIVE: 'TRANSFER_ACTIVE',
    TRANSFER_STALLED: 'TRANSFER_STALLED',
    FAILED: 'FAILED',
    PEER_OFFLINE: 'PEER_OFFLINE',
    FALLBACK_ACTIVE: 'FALLBACK_ACTIVE',
    CLOSED: 'CLOSED',
  });

  const FAILURES = Object.freeze({
    SIGNAL_RELAY_UNAVAILABLE: 'SIGNAL_RELAY_UNAVAILABLE',
    SIGNAL_PUBLISH_FAILED: 'SIGNAL_PUBLISH_FAILED',
    SIGNAL_DELIVERY_TIMEOUT: 'SIGNAL_DELIVERY_TIMEOUT',
    ANSWER_TIMEOUT: 'ANSWER_TIMEOUT',
    ICE_FAILED: 'ICE_FAILED',
    ICE_TIMEOUT: 'ICE_TIMEOUT',
    PEER_CONNECTION_FAILED: 'PEER_CONNECTION_FAILED',
    DATA_CHANNEL_TIMEOUT: 'DATA_CHANNEL_TIMEOUT',
    DATA_CHANNEL_CLOSED: 'DATA_CHANNEL_CLOSED',
    DATA_CHANNEL_ERROR: 'DATA_CHANNEL_ERROR',
    PEER_OFFLINE: 'PEER_OFFLINE',
    TRANSFER_READY_TIMEOUT: 'TRANSFER_READY_TIMEOUT',
    TRANSFER_PROGRESS_TIMEOUT: 'TRANSFER_PROGRESS_TIMEOUT',
    APPLICATION_ACK_TIMEOUT: 'APPLICATION_ACK_TIMEOUT',
    APPLICATION_PROTOCOL_FAILED: 'APPLICATION_PROTOCOL_FAILED',
    INTEGRITY_HASH_FAILED: 'INTEGRITY_HASH_FAILED',
    ENCRYPTION_FAILED: 'ENCRYPTION_FAILED',
    DECRYPTION_FAILED: 'DECRYPTION_FAILED',
    NETWORK_ENVIRONMENT_BLOCKED: 'NETWORK_ENVIRONMENT_BLOCKED',
    USER_CANCELLED: 'USER_CANCELLED',
    UNKNOWN_P2P_FAILURE: 'UNKNOWN_P2P_FAILURE',
    // fallback (Blossom מוצפן) — לא כשל P2P אלא כשל מסלול חלופי
    SERVER_E2EE_POLICY_BLOCKED: 'SERVER_E2EE_POLICY_BLOCKED',
    FALLBACK_TYPE_UNSUPPORTED: 'FALLBACK_TYPE_UNSUPPORTED',
    FALLBACK_UPLOAD_FAILED: 'FALLBACK_UPLOAD_FAILED',
    FALLBACK_PUBLISH_FAILED: 'FALLBACK_PUBLISH_FAILED',
  });

  // soft = פעולת התאוששות (retry offer / need-offer / המתנה מורחבת); hard = הכרזת כשל מדויק
  // בסיס: OFFER_RETRY_MS=12s, file DC open 5s, INITIAL_CHUNK_WAIT 12s, ack timeout 16s, relay publish 4s
  const DEADLINES = Object.freeze({
    SIGNAL_PUBLISH: Object.freeze({ soft: 1500, hard: 4000 }),
    ANSWER_WAIT: Object.freeze({ soft: 4000, hard: 12000 }),
    ICE_CONNECT: Object.freeze({ soft: 5000, hard: 15000 }),
    DC_OPEN: Object.freeze({ soft: 2000, hard: 5000 }),
    FILE_READY: Object.freeze({ soft: 12000, hard: 24000 }),
    TRANSFER_PROGRESS: Object.freeze({ soft: 16000, hard: 48000 }),
    ICE_DISCONNECT_GRACE: Object.freeze({ soft: 4000, hard: 10000 }),
  });

  const PEER_OFFLINE_RECENT_MS = 60000;
  const PEER_OFFLINE_STALE_MS = 5 * 60 * 1000;

  function deadline(phase, kind) {
    const row = DEADLINES[phase];
    if (!row) return 0;
    const base = row[kind === 'hard' ? 'hard' : 'soft'];
    const scale = App._p2pQaDeadlineScale;
    return typeof scale === 'number' && scale > 0 && scale <= 1 ? Math.max(1, Math.round(base * scale)) : base;
  }

  function peerFingerprint(peer) {
    const k = String(peer || '').toLowerCase();
    return /^[0-9a-f]{64}$/.test(k) ? k.slice(0, 8) : '';
  }

  // חלק מודל offline (p2p-connection-state.js) – heartbeat לבד לעולם לא סמכותי; תחבורה פעילה גוברת | HYPER CORE TECH
  function decidePeerOffline(ev) {
    const e = ev || {};
    const basis = [];
    if (e.dcState === 'open' || e.iceState === 'connected' || e.iceState === 'completed') {
      basis.push('transport_active');
      return { decision: 'ONLINE', basis };
    }
    const rxAge = Number.isFinite(e.lastPeerRxAgeMs) ? e.lastPeerRxAgeMs : Infinity;
    if (rxAge <= PEER_OFFLINE_RECENT_MS) {
      basis.push('recent_peer_signal');
      return { decision: 'ONLINE_RECENT', basis };
    }
    const presenceAge = Number.isFinite(e.presenceAgeMs) ? e.presenceAgeMs : Infinity;
    if (presenceAge <= PEER_OFFLINE_RECENT_MS) basis.push('presence_recent_non_authoritative');
    if (e.publishOk !== true) {
      basis.push('signal_not_delivered_to_relay');
      return { decision: 'UNKNOWN', basis };
    }
    if (e.answerReceived === true) {
      basis.push('answer_received');
      return { decision: 'ONLINE_RECENT', basis };
    }
    // presence לא ידוע (Infinity) אינו ראיה ל-offline — רק presence ידוע וישן
    if (e.answerDeadlineExpired === true && rxAge > PEER_OFFLINE_STALE_MS && Number.isFinite(presenceAge) && presenceAge > PEER_OFFLINE_STALE_MS) {
      basis.push('no_answer_after_hard_deadline', 'no_peer_signal_5m', 'no_presence_5m');
      return { decision: 'OFFLINE_LIKELY', basis };
    }
    basis.push('insufficient_evidence');
    return { decision: 'UNKNOWN', basis };
  }

  // חלק סיווג פרסום סיגנל (p2p-connection-state.js) – ריליי לא זמין מול דחייה של ריליי | HYPER CORE TECH
  function classifyPublishFailure(reasons) {
    const list = (Array.isArray(reasons) ? reasons : []).map((r) => String(r || '').toLowerCase());
    if (!list.length) return FAILURES.SIGNAL_RELAY_UNAVAILABLE;
    const unavailable = /connect|connection|timeout|timed out|closed|websocket|network|502|503|unreachable|no relays/;
    return list.every((r) => unavailable.test(r)) ? FAILURES.SIGNAL_RELAY_UNAVAILABLE : FAILURES.SIGNAL_PUBLISH_FAILED;
  }

  // חלק סיווג חיבור (p2p-connection-state.js) – ICE/DC רק אם המשא ומתן WebRTC באמת התחיל | HYPER CORE TECH
  function classifyConnectFailure(ev) {
    const e = ev || {};
    if (e.userCancelled) return FAILURES.USER_CANCELLED;
    if (e.publishOk === false) return classifyPublishFailure(e.publishReasons);
    if (!e.negotiationStarted) {
      if (e.publishOk !== true) return FAILURES.SIGNAL_RELAY_UNAVAILABLE;
      const off = decidePeerOffline(Object.assign({}, e, { answerDeadlineExpired: true }));
      if (off.decision === 'OFFLINE_LIKELY') return FAILURES.PEER_OFFLINE;
      if (off.decision === 'ONLINE_RECENT') return FAILURES.ANSWER_TIMEOUT;
      return FAILURES.SIGNAL_DELIVERY_TIMEOUT;
    }
    if (e.dcEverOpen) {
      if (e.dcError) return FAILURES.DATA_CHANNEL_ERROR;
      return FAILURES.DATA_CHANNEL_CLOSED;
    }
    if (e.iceEverConnected) {
      if (e.pcState === 'failed' || e.iceState === 'failed') return FAILURES.PEER_CONNECTION_FAILED;
      if (e.dcError) return FAILURES.DATA_CHANNEL_ERROR;
      return FAILURES.DATA_CHANNEL_TIMEOUT;
    }
    if (e.iceState === 'failed' || e.pcState === 'failed') {
      if ((e.remoteCandidates || 0) > 0 && (e.localCandidates || 0) > 0) return FAILURES.NETWORK_ENVIRONMENT_BLOCKED;
      return FAILURES.ICE_FAILED;
    }
    if (e.phaseExpired === 'ICE_CONNECT') return FAILURES.ICE_TIMEOUT;
    return FAILURES.UNKNOWN_P2P_FAILURE;
  }

  // חלק סיווג שגיאת fallback (p2p-connection-state.js) – crypto → ENCRYPTION_FAILED, בלי plaintext | HYPER CORE TECH
  function classifyFallbackError(err) {
    const code = String((err && (err.code || err.message)) || '').toUpperCase();
    const name = String((err && err.name) || '');
    if (/POLICY_BLOCKED/.test(code)) return FAILURES.SERVER_E2EE_POLICY_BLOCKED;
    if (/ENCRYPT|CRYPTO|CIPHER|KEY_|WRAP|NONCE|IV_/.test(code) || name === 'OperationError' || name === 'DataError') {
      return FAILURES.ENCRYPTION_FAILED;
    }
    if (/UNSUPPORTED_TYPE|TYPE_UNSUPPORTED/.test(code)) return FAILURES.FALLBACK_TYPE_UNSUPPORTED;
    return FAILURES.FALLBACK_UPLOAD_FAILED;
  }

  // חלק tracker לכל peer (p2p-connection-state.js) – מעברים מפורשים, היסטוריה חסומה, ללא תוכן | HYPER CORE TECH
  const trackers = new Map();
  const TRACKER_CAP = 64;
  const HISTORY_CAP = 24;

  function peerTracker(peer) {
    const k = String(peer || '').toLowerCase();
    if (!k) return null;
    let t = trackers.get(k);
    if (!t) {
      if (trackers.size >= TRACKER_CAP) trackers.delete(trackers.keys().next().value);
      t = newTracker(k);
      trackers.set(k, t);
    }
    return t;
  }

  function newTracker(k) {
    const t = {
      peer: k,
      state: STATES.IDLE,
      since: Date.now(),
      failure: null,
      history: [],
      evidence: {
        publishOk: null,
        publishReasons: [],
        negotiationStarted: false,
        peerSignalSeen: false,
        lastPeerRxAt: 0,
        iceState: '',
        pcState: '',
        dcState: '',
        iceEverConnected: false,
        dcEverOpen: false,
        dcError: false,
        localCandidates: 0,
        remoteCandidates: 0,
      },
      transition(state, info) {
        if (!STATES[state]) return;
        const now = Date.now();
        if (state !== t.state) {
          t.history.push({ from: t.state, to: state, ms: now - t.since, at: now, code: info && info.code ? String(info.code) : undefined });
          if (t.history.length > HISTORY_CAP) t.history.splice(0, t.history.length - HISTORY_CAP);
          t.state = state;
          t.since = now;
        }
        if (state !== STATES.FAILED && state !== STATES.PEER_OFFLINE) t.failure = null;
      },
      fail(code, info) {
        const c = FAILURES[code] ? code : FAILURES.UNKNOWN_P2P_FAILURE;
        t.failure = { code: c, at: Date.now(), phase: t.state, negotiationStarted: !!t.evidence.negotiationStarted };
        t.transition(c === FAILURES.PEER_OFFLINE ? STATES.PEER_OFFLINE : STATES.FAILED, { code: c });
        logSafe('P2P_CONN_FAIL', {
          peer: peerFingerprint(k),
          code: c,
          phase: t.failure.phase,
          negotiationStarted: t.failure.negotiationStarted,
          detail: info && info.detail ? String(info.detail).slice(0, 60) : undefined,
        });
        return c;
      },
      resetAttempt() {
        const ev = t.evidence;
        ev.publishOk = null;
        ev.publishReasons = [];
        ev.negotiationStarted = false;
        ev.iceState = '';
        ev.pcState = '';
        ev.iceEverConnected = false;
        ev.dcEverOpen = false;
        ev.dcError = false;
        ev.localCandidates = 0;
        ev.remoteCandidates = 0;
        t.failure = null;
      },
      phaseAgeMs() {
        return Date.now() - t.since;
      },
      snapshot() {
        return {
          peer: peerFingerprint(k),
          state: t.state,
          phaseAgeMs: Date.now() - t.since,
          failure: t.failure ? t.failure.code : null,
          negotiationStarted: !!t.evidence.negotiationStarted,
          iceState: t.evidence.iceState,
          dcState: t.evidence.dcState,
          publishOk: t.evidence.publishOk,
          history: t.history.slice(-8).map((h) => `${h.from}>${h.to}${h.code ? ':' + h.code : ''}`),
        };
      },
    };
    return t;
  }

  // חלק לוג בטוח (p2p-connection-state.js) – whitelist של מפתחות/ערכים פשוטים בלבד | HYPER CORE TECH
  const SAFE_KEYS = new Set([
    'attemptId', 'peer', 'kind', 'phase', 'code', 'state', 'negotiationStarted', 'detail', 'startAt', 'phaseLatencyMs',
    'failureCode', 'fallbackUsed', 'dcReused', 'iceOutcome', 'bytes', 'durationMs', 'mbps', 'ackTimeouts', 'retransmits',
    'windowPeak', 'windowDownshifts', 'bufferedPeak', 'hashVerified', 'fallbackLatencyMs', 'direction', 'result',
  ]);
  const FORBIDDEN_VALUE = /nsec1|sdp|a=fingerprint|ice-pwd|ice-ufrag|keyStr|BEGIN|-----/i;

  function sanitize(fields) {
    const out = {};
    Object.keys(fields || {}).forEach((key) => {
      if (!SAFE_KEYS.has(key)) return;
      const v = fields[key];
      if (v == null) return;
      if (typeof v === 'number') {
        if (Number.isFinite(v)) out[key] = Math.round(v * 100) / 100;
      } else if (typeof v === 'boolean') {
        out[key] = v;
      } else if (typeof v === 'string') {
        const s = v.slice(0, 64);
        if (!FORBIDDEN_VALUE.test(s) && !/^[0-9a-f]{40,}$/i.test(s)) out[key] = s;
      }
    });
    return out;
  }

  const recentLog = [];
  function logSafe(tag, fields) {
    const clean = sanitize(fields);
    recentLog.push({ tag, at: Date.now(), fields: clean });
    if (recentLog.length > 100) recentLog.splice(0, recentLog.length - 100);
    try { console.log(`[${tag}] ${JSON.stringify(clean)}`); } catch (_) {}
    return clean;
  }

  let attemptSeq = 0;
  function newAttemptId() {
    attemptSeq += 1;
    return `p2p-${Date.now().toString(36)}-${attemptSeq}`;
  }

  App.P2pConn = {
    STATES,
    FAILURES,
    DEADLINES,
    deadline,
    peer: peerTracker,
    decidePeerOffline,
    classifyPublishFailure,
    classifyConnectFailure,
    classifyFallbackError,
    peerFingerprint,
    newAttemptId,
    logAttempt: (fields) => logSafe('P2P_ATTEMPT', fields),
    logSafe,
    sanitize,
    _recentLog: recentLog,
    _trackers: trackers,
  };
})(typeof window !== 'undefined' ? window : globalThis);
