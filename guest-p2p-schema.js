/**
 * AC8 — Canonical guest kind-30078 schema + short-TTL replay cache.
 * Shared by GuestP2PKeyVault (pre-sign) and p2p-video-sharing (receive).
 * Custody unchanged (AC0 vault). XSS isolation NOT claimed.
 */
(function initGuestP2PSchema(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const KIND = 30078;
  const P2P_APP_TAG = 'sos-p2p-video';
  const NETWORK_TAG_NAME = 'network';
  const MAX_PUBLIC_CONTENT_CHARS = 512;
  const MAX_HASH_HEX = 128;
  const MAX_MIME_LEN = 128;
  const MAX_D_LEN = 200;
  const SIGNAL_TTL_SEC = 300;
  const REPLAY_SS_KEY = 'sos_guest_p2p_replay_v1';
  const MAX_REPLAY_ENTRIES = 400;

  const EVENT_TYPE = Object.freeze({
    HEARTBEAT: 'HEARTBEAT',
    FILE_AVAILABILITY: 'FILE_AVAILABILITY',
  });

  /** Tags allowed on guest public 30078 (exact set per type). */
  const TAG_KEYS_HEARTBEAT = Object.freeze(['d', 't', 'app', 'expires', 'guest', 'network']);
  const TAG_KEYS_FILE = Object.freeze(['d', 't', 'x', 'size', 'mime', 'expires', 'guest', 'network']);

  function isHex64(s) {
    return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s.trim());
  }

  function resolveNetworkTag() {
    if (typeof App.NETWORK_TAG === 'string' && App.NETWORK_TAG.trim()) {
      return App.NETWORK_TAG.trim();
    }
    return 'israel-network';
  }

  function tagMap(tags) {
    const m = Object.create(null);
    if (!Array.isArray(tags)) return m;
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      if (!Array.isArray(t) || typeof t[0] !== 'string') continue;
      const k = t[0];
      if (!m[k]) m[k] = [];
      m[k].push(typeof t[1] === 'string' ? t[1] : t[1] == null ? '' : String(t[1]));
    }
    return m;
  }

  function allTagKeys(tags) {
    const keys = [];
    if (!Array.isArray(tags)) return keys;
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      if (Array.isArray(t) && typeof t[0] === 'string') keys.push(t[0]);
    }
    return keys;
  }

  function reject(code, detail) {
    const err = new Error(code);
    err.code = code;
    if (detail) err.detail = detail;
    return { ok: false, code, detail: detail || null };
  }

  function okResult(extra) {
    return Object.assign({ ok: true, code: 'OK' }, extra || {});
  }

  function hasProtoPollution(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    if (Object.prototype.hasOwnProperty.call(obj, '__proto__')) return true;
    if (Object.prototype.hasOwnProperty.call(obj, 'constructor')) return true;
    if (Object.prototype.hasOwnProperty.call(obj, 'prototype')) return true;
    return false;
  }

  function looksLikeEmbeddedEvent(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (typeof obj.sig === 'string' || typeof obj.id === 'string') return true;
    if (typeof obj.kind === 'number' && (obj.pubkey || obj.tags)) return true;
    if (typeof obj.privateKey === 'string' || typeof obj.nsec === 'string') return true;
    if (typeof obj.priv === 'string' || typeof obj.sk === 'string') return true;
    return false;
  }

  function classifyGuestDraft(draft) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      return { type: null, reason: 'MALFORMED_DRAFT' };
    }
    if (draft.kind !== KIND) {
      return { type: null, reason: 'KIND_NOT_ALLOWED' };
    }
    const tm = tagMap(draft.tags);
    const tVals = tm.t || [];
    if (tVals.indexOf('p2p-heartbeat') !== -1) {
      return { type: EVENT_TYPE.HEARTBEAT, reason: null };
    }
    if (tVals.indexOf('p2p-file') !== -1) {
      return { type: EVENT_TYPE.FILE_AVAILABILITY, reason: null };
    }
    // Private peer signal shapes — guests must not sign via Guest vault
    if (
      tVals.some((v) => v === 'p2p-req' || v === 'p2p-res' || v === 'p2p-ice') ||
      (tm.enc && tm.enc.indexOf('nip44') !== -1)
    ) {
      return { type: null, reason: 'GUEST_PRIVATE_SIGNAL_DENIED' };
    }
    return { type: null, reason: 'UNKNOWN_TYPE' };
  }

  function validateTagsExact(tags, allowedKeys) {
    const keys = allTagKeys(tags);
    const allow = new Set(allowedKeys);
    for (let i = 0; i < keys.length; i++) {
      if (!allow.has(keys[i])) {
        return reject('ARBITRARY_TAG', keys[i]);
      }
    }
    return okResult();
  }

  function validateNetworkBinding(tm, opts) {
    const expected = (opts && opts.networkTag) || resolveNetworkTag();
    const vals = tm.network || [];
    const direction = (opts && opts.direction) || 'sign';
    if (direction === 'sign') {
      if (vals.length !== 1 || vals[0] !== expected) {
        return reject('NETWORK_BINDING_REQUIRED', expected);
      }
      return okResult({ networkTag: expected, legacyNoNetwork: false });
    }
    // receive: require match if present; allow exact legacy without network
    if (vals.length === 0) {
      if (opts && opts.allowLegacyNoNetwork === true) {
        return okResult({ networkTag: null, legacyNoNetwork: true });
      }
      return reject('NETWORK_BINDING_MISSING');
    }
    if (vals.length !== 1 || vals[0] !== expected) {
      return reject('CROSS_GROUP_REJECTED', vals[0]);
    }
    return okResult({ networkTag: expected, legacyNoNetwork: false });
  }

  function validateHeartbeat(draft, opts) {
    const tagCheck = validateTagsExact(draft.tags, TAG_KEYS_HEARTBEAT);
    if (!tagCheck.ok) return tagCheck;
    const tm = tagMap(draft.tags);
    if (!tm.d || tm.d[0] !== 'p2p-heartbeat') return reject('BAD_D_TAG');
    if (!tm.t || tm.t.indexOf('p2p-heartbeat') === -1) return reject('BAD_T_TAG');
    if (!tm.app || tm.app[0] !== P2P_APP_TAG) return reject('BAD_APP_TAG');
    if (!tm.expires || !/^\d+$/.test(tm.expires[0])) return reject('BAD_EXPIRES');
    if (tm.guest && tm.guest[0] !== 'true') return reject('BAD_GUEST_TAG');

    const net = validateNetworkBinding(tm, opts);
    if (!net.ok) return net;

    if (typeof draft.content !== 'string') return reject('BAD_CONTENT');
    if (draft.content.length > MAX_PUBLIC_CONTENT_CHARS) return reject('CONTENT_TOO_LARGE');
    let parsed;
    try {
      parsed = JSON.parse(draft.content);
    } catch (_e) {
      return reject('CONTENT_NOT_JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return reject('CONTENT_NOT_OBJECT');
    }
    if (hasProtoPollution(parsed) || looksLikeEmbeddedEvent(parsed)) {
      return reject('CONTENT_PRIVILEGED_REJECTED');
    }
    const keys = Object.keys(parsed);
    const allowed = new Set(['online', 'files', 'isGuest']);
    for (let i = 0; i < keys.length; i++) {
      if (!allowed.has(keys[i])) return reject('EXTRA_CONTENT_FIELD', keys[i]);
    }
    if (parsed.online !== true) return reject('BAD_ONLINE');
    if (typeof parsed.files !== 'number' || !Number.isFinite(parsed.files) || parsed.files < 0 || parsed.files > 100000) {
      return reject('BAD_FILES');
    }
    if (parsed.isGuest !== undefined && typeof parsed.isGuest !== 'boolean') {
      return reject('BAD_IS_GUEST');
    }

    return okResult({
      eventType: EVENT_TYPE.HEARTBEAT,
      signalClass: 'PUBLIC_AVAILABILITY',
      networkTag: net.networkTag,
      legacyNoNetwork: net.legacyNoNetwork === true,
    });
  }

  function validateFileAvailability(draft, opts) {
    const tagCheck = validateTagsExact(draft.tags, TAG_KEYS_FILE);
    if (!tagCheck.ok) return tagCheck;
    const tm = tagMap(draft.tags);
    if (!tm.t || tm.t.indexOf('p2p-file') === -1) return reject('BAD_T_TAG');
    if (!tm.d || tm.d.length !== 1 || tm.d[0].length > MAX_D_LEN) return reject('BAD_D_TAG');
    if (!tm.d[0].startsWith(P2P_APP_TAG + ':file:')) return reject('BAD_D_PREFIX');
    if (!tm.x || !tm.x[0] || tm.x[0].length > MAX_HASH_HEX || !/^[0-9a-fA-F]+$/.test(tm.x[0])) {
      return reject('BAD_X_HASH');
    }
    if (!tm.size || !/^\d+$/.test(tm.size[0])) return reject('BAD_SIZE');
    if (!tm.mime || !tm.mime[0] || tm.mime[0].length > MAX_MIME_LEN) return reject('BAD_MIME');
    if (!tm.expires || !/^\d+$/.test(tm.expires[0])) return reject('BAD_EXPIRES');
    if (tm.guest && tm.guest[0] !== 'true') return reject('BAD_GUEST_TAG');

    const net = validateNetworkBinding(tm, opts);
    if (!net.ok) return net;

    // Protocol uses empty content for availability
    if (typeof draft.content !== 'string') return reject('BAD_CONTENT');
    if (draft.content.length > 0) return reject('FILE_CONTENT_MUST_BE_EMPTY');

    return okResult({
      eventType: EVENT_TYPE.FILE_AVAILABILITY,
      signalClass: 'PUBLIC_AVAILABILITY',
      networkTag: net.networkTag,
      legacyNoNetwork: net.legacyNoNetwork === true,
    });
  }

  /**
   * Canonical validator — used for sign and receive.
   * opts: { direction: 'sign'|'receive', networkTag?, allowLegacyNoNetwork?, nowSec? }
   * V2 ON: missing network always rejects on receive (no legacy exception).
   * V2 OFF: exact legacy no-network shapes may be accepted when allowLegacyNoNetwork.
   */
  function validateGuest30078(draft, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const direction = o.direction === 'receive' ? 'receive' : 'sign';
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      return reject('MALFORMED_DRAFT');
    }
    if (draft.kind !== KIND) {
      return reject('KIND_NOT_ALLOWED');
    }
    if (!Array.isArray(draft.tags)) return reject('BAD_TAGS');
    if (typeof draft.content !== 'string') return reject('BAD_CONTENT');

    // Freshness (created_at) when present
    const nowSec =
      typeof o.nowSec === 'number' && Number.isFinite(o.nowSec)
        ? Math.floor(o.nowSec)
        : Math.floor(Date.now() / 1000);
    if (draft.created_at !== undefined && draft.created_at !== null) {
      const created = Number(draft.created_at);
      if (!Number.isFinite(created) || !Number.isInteger(created)) {
        return reject('BAD_CREATED_AT');
      }
      if (created > nowSec + 120) return reject('CREATED_IN_FUTURE');
      if (nowSec - created > SIGNAL_TTL_SEC) return reject('EXPIRED_TTL');
    }

    const classified = classifyGuestDraft(draft);
    if (!classified.type) {
      return reject(classified.reason || 'UNKNOWN_TYPE');
    }

    const FF = typeof window !== 'undefined' && window.NostrApp ? window.NostrApp.FeatureFlags : null;
    const v2On =
      typeof window !== 'undefined' &&
      window.SOS_ACCESS_CONTROL_V2 === true &&
      !(FF && typeof FF.accessControlV2Scope === 'function' && FF.accessControlV2Scope() === 'CONTROL_PLANE');
    let allowLegacy;
    if (direction !== 'receive') {
      allowLegacy = false;
    } else if (typeof o.allowLegacyNoNetwork === 'boolean') {
      // Explicit override — but never allow legacy exception while V2 is ON
      allowLegacy = o.allowLegacyNoNetwork === true && !v2On;
    } else {
      allowLegacy = !v2On;
    }

    const bindOpts = {
      direction,
      networkTag: o.networkTag || resolveNetworkTag(),
      allowLegacyNoNetwork: allowLegacy,
    };

    if (classified.type === EVENT_TYPE.HEARTBEAT) {
      return validateHeartbeat(draft, bindOpts);
    }
    if (classified.type === EVENT_TYPE.FILE_AVAILABILITY) {
      return validateFileAvailability(draft, bindOpts);
    }
    return reject('UNKNOWN_TYPE');
  }

  function assertGuest30078ForSign(draft) {
    const result = validateGuest30078(draft, {
      direction: 'sign',
      networkTag: resolveNetworkTag(),
      allowLegacyNoNetwork: false,
    });
    if (!result.ok) {
      throw Object.assign(new Error(result.code), {
        code: result.code,
        detail: result.detail,
      });
    }
    return result;
  }

  // --- Guest public-media file transfer (typed, recipient-bound, NIP-44) ---
  // Only the WebRTC negotiation needed to move a PUBLIC hash-backed media file.
  // Chat files, DMs, presence, calls and every other private type stay denied.
  const GUEST_MEDIA_SIGNAL_TYPES = Object.freeze(['file-request', 'file-response', 'ice-candidate']);
  const GUEST_MEDIA_SIGNAL_T_TAG = Object.freeze({
    'file-request': 'p2p-req',
    'file-response': 'p2p-res',
    'ice-candidate': 'p2p-ice',
  });
  const TAG_KEYS_MEDIA_SIGNAL = Object.freeze(['d', 'p', 't', 'enc', 'guest', 'network']);
  const MAX_MEDIA_SIGNAL_PLAINTEXT_CHARS = 20000;
  const MAX_SDP_CHARS = 16000;
  const MAX_CANDIDATE_CHARS = 1024;
  const CONNECTION_ID_RE = /^[0-9A-Za-z:_.-]{1,256}$/;

  function onlyKeys(obj, allowed) {
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      if (allowed.indexOf(keys[i]) === -1) return keys[i];
    }
    return '';
  }

  function validateSessionDescription(desc, expectedType) {
    if (!desc || typeof desc !== 'object' || Array.isArray(desc)) return reject('BAD_SDP');
    if (hasProtoPollution(desc) || looksLikeEmbeddedEvent(desc)) return reject('PRIVILEGED_FIELD');
    const extra = onlyKeys(desc, ['type', 'sdp']);
    if (extra) return reject('EXTRA_FIELD', extra);
    if (desc.type !== expectedType) return reject('BAD_SDP_TYPE');
    if (typeof desc.sdp !== 'string' || !desc.sdp || desc.sdp.length > MAX_SDP_CHARS) return reject('BAD_SDP');
    return okResult();
  }

  function validateIceCandidate(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return reject('BAD_CANDIDATE');
    if (hasProtoPollution(c) || looksLikeEmbeddedEvent(c)) return reject('PRIVILEGED_FIELD');
    const extra = onlyKeys(c, ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment']);
    if (extra) return reject('EXTRA_FIELD', extra);
    if (typeof c.candidate !== 'string' || c.candidate.length > MAX_CANDIDATE_CHARS) return reject('BAD_CANDIDATE');
    if (c.sdpMid != null && (typeof c.sdpMid !== 'string' || c.sdpMid.length > 64)) return reject('BAD_CANDIDATE');
    if (c.sdpMLineIndex != null && !(Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 64)) {
      return reject('BAD_CANDIDATE');
    }
    if (c.usernameFragment != null && (typeof c.usernameFragment !== 'string' || c.usernameFragment.length > 256)) {
      return reject('BAD_CANDIDATE');
    }
    return okResult();
  }

  /** Validates the decrypted {type, data} message of a guest public-media file signal. */
  function validateGuestMediaFileSignalMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return reject('MALFORMED_SIGNAL');
    if (hasProtoPollution(message) || looksLikeEmbeddedEvent(message)) return reject('PRIVILEGED_FIELD');
    const extraTop = onlyKeys(message, ['type', 'data']);
    if (extraTop) return reject('EXTRA_FIELD', extraTop);
    if (GUEST_MEDIA_SIGNAL_TYPES.indexOf(message.type) === -1) return reject('GUEST_MEDIA_SIGNAL_TYPE_DENIED', String(message.type));
    const data = message.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return reject('MALFORMED_SIGNAL');
    if (hasProtoPollution(data) || looksLikeEmbeddedEvent(data)) return reject('PRIVILEGED_FIELD');
    const extra = onlyKeys(data, message.type === 'file-request' ? ['offer', 'hash', 'connectionId']
      : message.type === 'file-response' ? ['answer', 'hash', 'connectionId']
        : ['candidate', 'hash', 'connectionId']);
    if (extra) return reject('EXTRA_FIELD', extra);
    if (typeof data.connectionId !== 'string' || !CONNECTION_ID_RE.test(data.connectionId)) return reject('BAD_CONNECTION_ID');
    if (message.type === 'file-request' || data.hash !== undefined) {
      if (!isHex64(data.hash)) return reject('BAD_MEDIA_HASH');
    }
    let inner;
    if (message.type === 'file-request') inner = validateSessionDescription(data.offer, 'offer');
    else if (message.type === 'file-response') inner = validateSessionDescription(data.answer, 'answer');
    else inner = validateIceCandidate(data.candidate);
    if (!inner.ok) return inner;
    const size = JSON.stringify(message).length;
    if (size > MAX_MEDIA_SIGNAL_PLAINTEXT_CHARS) return reject('SIGNAL_TOO_LARGE');
    return okResult({ signalClass: 'GUEST_PUBLIC_MEDIA_FILE_TRANSFER', signalType: message.type });
  }

  /**
   * Validates the outer kind-30078 event of a public-media file signal (sign or receive).
   * opts: { direction, networkTag, type, recipient, requireGuestTag, nowSec }
   */
  function validateGuestMediaFileSignalEvent(draft, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const direction = o.direction === 'receive' ? 'receive' : 'sign';
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return reject('MALFORMED_DRAFT');
    if (draft.kind !== KIND) return reject('KIND_NOT_ALLOWED');
    if (!Array.isArray(draft.tags)) return reject('BAD_TAGS');
    if (typeof draft.content !== 'string' || !draft.content) return reject('BAD_CONTENT');
    if (draft.content.length > MAX_MEDIA_SIGNAL_PLAINTEXT_CHARS * 2) return reject('SIGNAL_TOO_LARGE');
    const nowSec = typeof o.nowSec === 'number' ? Math.floor(o.nowSec) : Math.floor(Date.now() / 1000);
    const created = Number(draft.created_at);
    if (!Number.isFinite(created) || !Number.isInteger(created)) return reject('BAD_CREATED_AT');
    if (created > nowSec + 120) return reject('CREATED_IN_FUTURE');
    if (nowSec - created > SIGNAL_TTL_SEC) return reject('EXPIRED_TTL');
    const tagCheck = validateTagsExact(draft.tags, TAG_KEYS_MEDIA_SIGNAL);
    if (!tagCheck.ok) return tagCheck;
    const tm = tagMap(draft.tags);
    if (!tm.d || tm.d.length !== 1 || tm.d[0].length > MAX_D_LEN || !tm.d[0].startsWith(P2P_APP_TAG + ':signal:')) {
      return reject('BAD_D_TAG');
    }
    if (!tm.p || tm.p.length !== 1 || !isHex64(tm.p[0])) return reject('RECIPIENT_REQUIRED');
    if (o.recipient && tm.p[0].toLowerCase() !== String(o.recipient).toLowerCase()) return reject('WRONG_RECIPIENT');
    const tVals = Object.keys(GUEST_MEDIA_SIGNAL_T_TAG).map((k) => GUEST_MEDIA_SIGNAL_T_TAG[k]);
    if (!tm.t || tm.t.length !== 1 || tVals.indexOf(tm.t[0]) === -1) return reject('BAD_T_TAG');
    if (o.type && GUEST_MEDIA_SIGNAL_T_TAG[o.type] !== tm.t[0]) return reject('T_TAG_TYPE_MISMATCH');
    if (!tm.enc || tm.enc.length !== 1 || tm.enc[0] !== 'nip44') return reject('ENCRYPTION_REQUIRED');
    if (tm.guest && (tm.guest.length !== 1 || tm.guest[0] !== 'true')) return reject('BAD_GUEST_TAG');
    if (o.requireGuestTag === true && !tm.guest) return reject('BAD_GUEST_TAG');
    const net = validateNetworkBinding(tm, { direction, networkTag: o.networkTag || resolveNetworkTag(), allowLegacyNoNetwork: false });
    if (!net.ok) return net;
    let env;
    try {
      env = JSON.parse(draft.content);
    } catch (_e) {
      return reject('PLAINTEXT_PRIVATE_SIGNAL_REJECTED');
    }
    if (!env || typeof env !== 'object' || Array.isArray(env) || env.alg !== 'nip44' || typeof env.ct !== 'string' || !env.ct
      || typeof env.type === 'string') {
      return reject('PLAINTEXT_PRIVATE_SIGNAL_REJECTED');
    }
    return okResult({ signalClass: 'GUEST_PUBLIC_MEDIA_FILE_TRANSFER', tTag: tm.t[0], recipient: tm.p[0].toLowerCase() });
  }

  // --- session-scoped replay cache (ids + expiry only; no secrets) ---
  function loadReplayMap() {
    try {
      const raw = window.sessionStorage.getItem(REPLAY_SS_KEY);
      if (!raw) return Object.create(null);
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Object.create(null);
      return parsed;
    } catch (_e) {
      return Object.create(null);
    }
  }

  function saveReplayMap(map) {
    try {
      const now = Date.now();
      const entries = Object.keys(map)
        .filter((id) => map[id] && map[id] > now)
        .map((id) => [id, map[id]]);
      entries.sort((a, b) => b[1] - a[1]);
      const trimmed = entries.slice(0, MAX_REPLAY_ENTRIES);
      const out = Object.create(null);
      for (let i = 0; i < trimmed.length; i++) out[trimmed[i][0]] = trimmed[i][1];
      window.sessionStorage.setItem(REPLAY_SS_KEY, JSON.stringify(out));
    } catch (_e) {}
  }

  /**
   * @returns {boolean} true if already seen (replay — caller must reject)
   */
  function rememberGuestEventId(eventId, ttlSec) {
    if (!eventId || typeof eventId !== 'string') return false;
    const ttl = typeof ttlSec === 'number' && ttlSec > 0 ? ttlSec : SIGNAL_TTL_SEC;
    const map = loadReplayMap();
    const now = Date.now();
    if (map[eventId] && map[eventId] > now) {
      return true;
    }
    map[eventId] = now + ttl * 1000;
    saveReplayMap(map);
    return false;
  }

  function clearGuestReplayCache() {
    try {
      window.sessionStorage.removeItem(REPLAY_SS_KEY);
    } catch (_e) {}
  }

  function ensureNetworkTagOnTags(tags, networkTag) {
    const net = networkTag || resolveNetworkTag();
    const out = Array.isArray(tags) ? tags.slice() : [];
    let found = false;
    for (let i = 0; i < out.length; i++) {
      if (Array.isArray(out[i]) && out[i][0] === NETWORK_TAG_NAME) {
        out[i] = [NETWORK_TAG_NAME, net];
        found = true;
      }
    }
    if (!found) out.push([NETWORK_TAG_NAME, net]);
    return out;
  }

  const api = Object.freeze({
    KIND,
    P2P_APP_TAG,
    NETWORK_TAG_NAME,
    SIGNAL_TTL_SEC,
    MAX_PUBLIC_CONTENT_CHARS,
    EVENT_TYPE,
    TAG_KEYS_HEARTBEAT,
    TAG_KEYS_FILE,
    GUEST_30078_ALLOWED_TAGS: Object.freeze(
      Array.from(new Set([].concat(TAG_KEYS_HEARTBEAT, TAG_KEYS_FILE)))
    ),
    resolveNetworkTag,
    classifyGuestDraft,
    validateGuest30078,
    assertGuest30078ForSign,
    rememberGuestEventId,
    clearGuestReplayCache,
    ensureNetworkTagOnTags,
    REPLAY_SS_KEY,
    GUEST_MEDIA_SIGNAL_TYPES,
    GUEST_MEDIA_SIGNAL_T_TAG,
    TAG_KEYS_MEDIA_SIGNAL,
    validateGuestMediaFileSignalMessage,
    validateGuestMediaFileSignalEvent,
  });

  App.GuestP2PSchema = api;
  window.SosGuestP2PSchema = api;
})(typeof window !== 'undefined' ? window : globalThis);
