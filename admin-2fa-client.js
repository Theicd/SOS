/**
 * Admin 2FA client — the web side of the authoritative admin PIN service (admission Worker /v1/admin-pin/*).
 *
 * Admin authority = admin identity + server PIN enrollment/verification + a short-lived in-memory admin session
 * + a server attestation (kind 39004) for each privileged event, verified locally before anything is published.
 * The PIN is turned into PBKDF2-SHA256(pin, serverSalt, 600k) here; only that derivation is sent. The PIN, the
 * derivation and the session id are never stored, logged or placed in URLs. No local verifier is authority and
 * there is no local-PIN or key-only fallback: if the service is unavailable, privileged actions fail closed.
 */
(function initAdmin2faClient(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const GROUP_ID = 'israel-network';
  const PROTOCOL = 'sos-admin-2fa-v1';
  const ADMIN_SESSION_TTL_MINUTES = 15;
  const SESSION_TTL_MS = ADMIN_SESSION_TTL_MINUTES * 60 * 1000;
  const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
  const MIN_ITERATIONS = 600000;
  const PIN_RE = /^[0-9]{6}$/;
  const HEX64 = /^[0-9a-f]{64}$/;
  const DENY = new Set([
    '000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999',
    '123456', '234567', '345678', '456789', '567890', '012345', '654321', '543210', '987654', '876543',
    '765432', '098765', '123123', '321321', '121212', '112233', '123321', '101010', '696969', '159753',
    '147258', '789456', '102030', '111222', '000001', '100000', '999000', '000999', '420420', '131313',
  ]);

  const STATE = Object.freeze({
    NO_IDENTITY: 'NO_IDENTITY',
    NOT_ADMIN: 'NOT_ADMIN',
    PIN_NOT_CONFIGURED: 'PIN_NOT_CONFIGURED',
    PIN_CONFIGURED_LOCKED: 'PIN_CONFIGURED_LOCKED',
    ADMIN_SESSION_ACTIVE: 'ADMIN_SESSION_ACTIVE',
    SERVICE_UNAVAILABLE: 'ADMIN_2FA_SERVICE_UNAVAILABLE',
  });

  const SERVICE_UNAVAILABLE_TEXT = 'שירות אימות המנהל אינו זמין כרגע';

  let session = null;

  function P() {
    return App.Admin2faProtocol || window.SosAdmin2faProtocol || null;
  }
  function Adm() {
    return App.FirstGroupAdmission || window.SosFirstGroupAdmission || null;
  }
  function Signer() {
    return App.SosCryptoSigner || null;
  }

  function normalizePubkey(value) {
    if (typeof value !== 'string') return '';
    const t = value.trim().toLowerCase().replace(/^0x/, '');
    return HEX64.test(t) ? t : '';
  }
  function actor() {
    return normalizePubkey(App.publicKey);
  }
  function fail(code, extra) {
    return Object.assign({ ok: false, code }, extra || {});
  }
  function now() {
    return Date.now();
  }

  function hex(bytes) {
    return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  function randomHex(n) {
    return hex(window.crypto.getRandomValues(new Uint8Array(n)));
  }
  function hexToBytes(h) {
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  async function sha256Hex(text) {
    return hex(await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  }

  function isTrivialPin(pin) {
    const p = String(pin || '');
    if (!PIN_RE.test(p)) return true;
    if (DENY.has(p)) return true;
    if (/^(\d)\1{5}$/.test(p) || /^(\d\d)\1\1$/.test(p) || /^(\d{3})\1$/.test(p)) return true;
    const d = p.split('').map(Number);
    let asc = true;
    let desc = true;
    for (let i = 1; i < d.length; i++) {
      if ((d[i] - d[i - 1] + 10) % 10 !== 1) asc = false;
      if ((d[i - 1] - d[i] + 10) % 10 !== 1) desc = false;
    }
    return asc || desc;
  }

  // ---------------------------------------------------------------- identity / session binding

  function sessionAuth() {
    const SA = App.SessionAuthority || window.SosSessionAuthority;
    if (!SA || typeof SA.checkSessionForSensitiveOp !== 'function') return { ok: false };
    const s = SA.checkSessionForSensitiveOp('ADMIN_PIN_LOCK');
    if (!s || s.ok !== true) return { ok: false };
    if (s.account && normalizePubkey(s.account) && normalizePubkey(s.account) !== actor()) return { ok: false };
    return { ok: true, generation: s.generation };
  }

  function clearSession(reason) {
    const prev = session;
    session = null;
    if (prev) {
      try {
        window.dispatchEvent(new CustomEvent('sos-admin-pin-locked', { detail: { reason: String(reason || 'lock') } }));
      } catch (_e) {}
    }
    return prev;
  }

  /** The in-memory admin session, or null. Any identity, session-generation, group or time mismatch clears it. */
  function active() {
    if (!session) return null;
    const me = actor();
    const sa = sessionAuth();
    if (
      !me ||
      me !== session.pubkey ||
      !sa.ok ||
      sa.generation !== session.generation ||
      App.guestMode === true ||
      session.groupId !== GROUP_ID ||
      session.protocol !== PROTOCOL
    ) {
      clearSession('identity');
      return null;
    }
    const t = now();
    if (t - session.lastActivity > SESSION_TTL_MS || t > session.expiresAt) {
      clearSession('timeout');
      return null;
    }
    return session;
  }

  function isActive(pubkey) {
    const s = active();
    if (!s) return false;
    return pubkey == null || normalizePubkey(pubkey) === s.pubkey;
  }

  function touch() {
    const s = active();
    if (s) s.lastActivity = now();
  }

  function remainingMs() {
    const s = active();
    return s ? Math.max(0, Math.min(SESSION_TTL_MS - (now() - s.lastActivity), s.expiresAt - now())) : 0;
  }

  function openSession(res, me, generation) {
    const t = now();
    const serverMax = Number(res.expiresAt);
    session = {
      sessionId: String(res.sessionId),
      pubkey: me,
      groupId: GROUP_ID,
      protocol: PROTOCOL,
      generation,
      createdAt: t,
      lastActivity: t,
      expiresAt: Number.isFinite(serverMax) ? Math.min(serverMax, t + SESSION_MAX_MS) : t + SESSION_MAX_MS,
    };
  }

  // ---------------------------------------------------------------- transport

  function configured() {
    const A = Adm();
    return !!(A && typeof A.configured === 'function' && A.configured() && typeof A.post === 'function');
  }

  /** Attestations are required whenever enforcement is on, or the deployment has the service and signer configured. */
  function required() {
    const p = P();
    if (!p) return false;
    return p.isEnforced() === true || (configured() && !!p.activeSignerPubkey());
  }

  async function call(action, params) {
    if (!configured()) return { result: 'TEMPORARILY_UNAVAILABLE', code: 'NOT_CONFIGURED' };
    const me = actor();
    const S = Signer();
    if (!me || App.guestMode === true || !S || typeof S.signAdmin2faAuth !== 'function') return { result: 'UNAUTHORIZED', code: 'NO_IDENTITY' };
    const body = JSON.stringify(params || {});
    let auth;
    try {
      auth = await Promise.resolve(
        S.signAdmin2faAuth({ action, payloadHash: await sha256Hex(body), groupId: GROUP_ID, nonce: randomHex(16) })
      );
    } catch (_e) {
      return { result: 'UNAUTHORIZED', code: 'SIGN_FAILED' };
    }
    if (!auth || normalizePubkey(auth.pubkey) !== me) return { result: 'UNAUTHORIZED', code: 'IDENTITY_MISMATCH' };
    const res = await Adm().post('/v1/admin-pin/' + action, { groupId: GROUP_ID, auth, params: body });
    // The account may have changed while the request was in flight.
    if (actor() !== me) return { result: 'UNAUTHORIZED', code: 'IDENTITY_CHANGED' };
    return res;
  }

  function mapFailure(r) {
    const res = r || {};
    if (res.result === 'LOCKED') return fail('PIN_LOCKED', { retryAfterMs: Number(res.retryAfterMs) || 0 });
    if (res.code === 'WRONG_PIN') return fail('PIN_WRONG', { failures: Number(res.failures) || 0, retryAfterMs: Number(res.retryAfterMs) || 0 });
    if (res.code === 'RATE_LIMITED') return fail('PIN_RATE_LIMITED', { retryAfterMs: 60000 });
    if (res.code === 'ALREADY_ENROLLED') return fail('PIN_ALREADY_SET');
    if (res.code === 'NOT_ENROLLED') return fail('PIN_NOT_SET');
    if (res.code === 'NO_SESSION' || res.code === 'SESSION_EXPIRED') return fail('ADMIN_SESSION_EXPIRED');
    if (res.code === 'NOT_ADMIN') return fail('UNAUTHORIZED');
    if (res.code === 'NO_IDENTITY' || res.code === 'IDENTITY_CHANGED' || res.code === 'IDENTITY_MISMATCH') return fail('NO_IDENTITY');
    if (res.result === 'TEMPORARILY_UNAVAILABLE' || !res.result) return fail('ADMIN_2FA_SERVICE_UNAVAILABLE');
    return fail('ADMIN_2FA_DENIED', { reason: res.code || res.result, detail: typeof res.reason === 'string' ? res.reason : undefined });
  }

  async function derive(pin, saltHex, iterations) {
    const base = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(
      await window.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations }, base, 256)
    );
    const out = hex(bits);
    bits.fill(0);
    return out;
  }

  async function serverParams() {
    const p = await call('params', {});
    if (p.result !== 'OK') return mapFailure(p);
    if (!/^[0-9a-f]{32,64}$/.test(String(p.salt || '')) || !(Number(p.iterations) >= MIN_ITERATIONS)) return fail('ADMIN_2FA_DENIED');
    return Object.assign({ ok: true }, p);
  }

  // ---------------------------------------------------------------- PIN state / enroll / verify / lock

  /** Server-derived admin state; browser storage is never consulted. */
  async function state() {
    const me = actor();
    if (!me || App.guestMode === true) return { state: STATE.NO_IDENTITY };
    if (!configured()) return { state: STATE.SERVICE_UNAVAILABLE, code: 'NOT_CONFIGURED' };
    const s = active();
    const r = await call('session', s ? { sessionId: s.sessionId } : {});
    if (r.result !== 'OK') {
      const f = mapFailure(r);
      if (f.code === 'UNAUTHORIZED') return { state: STATE.NOT_ADMIN };
      if (f.code === 'NO_IDENTITY') return { state: STATE.NO_IDENTITY };
      return { state: STATE.SERVICE_UNAVAILABLE, code: f.code };
    }
    if (r.adminState === 'UNLOCKED' && s && active() === s) {
      touch();
      return { state: STATE.ADMIN_SESSION_ACTIVE };
    }
    if (s) clearSession(r.sessionExpired ? 'expired' : 'server');
    if (r.adminState === 'SETUP_REQUIRED') return { state: STATE.PIN_NOT_CONFIGURED };
    return { state: STATE.PIN_CONFIGURED_LOCKED, retryAfterMs: Number(r.retryAfterMs) || 0 };
  }

  let pinBusy = false;

  async function withPinBusy(fn) {
    if (pinBusy) return fail('PIN_BUSY');
    pinBusy = true;
    try {
      return await fn();
    } catch (_e) {
      return fail('ADMIN_2FA_SERVICE_UNAVAILABLE');
    } finally {
      pinBusy = false;
    }
  }

  function enroll(pin, confirmPin) {
    const me = actor();
    if (!me || App.guestMode === true) return Promise.resolve(fail('NO_IDENTITY'));
    const sa = sessionAuth();
    if (!sa.ok) return Promise.resolve(fail('SESSION_REVOKED'));
    if (String(pin) !== String(confirmPin)) return Promise.resolve(fail('PIN_MISMATCH'));
    if (!PIN_RE.test(String(pin))) return Promise.resolve(fail('PIN_FORMAT'));
    if (isTrivialPin(pin)) return Promise.resolve(fail('PIN_TOO_SIMPLE'));
    return withPinBusy(async () => {
      const p = await serverParams();
      if (!p.ok) return p;
      if (p.enrolled) return fail('PIN_ALREADY_SET');
      const derived = await derive(pin, p.salt, Number(p.iterations));
      const r = await call('enroll', { salt: p.salt, derived });
      if (r.result !== 'OK' || !HEX64.test(String(r.sessionId || ''))) return mapFailure(r);
      if (actor() !== me || sessionAuth().generation !== sa.generation) return fail('NO_IDENTITY');
      openSession(r, me, sa.generation);
      return { ok: true, code: 'PIN_SET' };
    });
  }

  function verify(pin) {
    const me = actor();
    if (!me || App.guestMode === true) return Promise.resolve(fail('NO_IDENTITY'));
    const sa = sessionAuth();
    if (!sa.ok) return Promise.resolve(fail('SESSION_REVOKED'));
    if (!PIN_RE.test(String(pin))) return Promise.resolve(fail('PIN_FORMAT'));
    return withPinBusy(async () => {
      const p = await serverParams();
      if (!p.ok) return p;
      if (!p.enrolled) return fail('PIN_NOT_SET');
      if (Number(p.retryAfterMs) > 0) return fail('PIN_LOCKED', { retryAfterMs: Number(p.retryAfterMs) });
      const derived = await derive(pin, p.salt, Number(p.iterations));
      const r = await call('verify', { derived });
      if (r.result !== 'OK' || !HEX64.test(String(r.sessionId || ''))) return mapFailure(r);
      if (actor() !== me || sessionAuth().generation !== sa.generation) return fail('NO_IDENTITY');
      openSession(r, me, sa.generation);
      return { ok: true, code: 'UNLOCKED' };
    });
  }

  /** Clears the in-memory session and asks the service to drop it (best effort; the server TTL still applies). */
  function lock(reason) {
    const prev = clearSession(reason);
    if (prev && configured() && actor() === prev.pubkey) {
      call('lock', { sessionId: prev.sessionId }).catch(() => {});
    }
  }

  async function lockoutState() {
    const p = await serverParams().catch(() => fail('ADMIN_2FA_SERVICE_UNAVAILABLE'));
    if (!p.ok) return { failures: 0, retryAfterMs: 0, code: p.code };
    return { failures: 0, retryAfterMs: Number(p.retryAfterMs) || 0, enrolled: !!p.enrolled };
  }

  async function stepUpDerivation(pin) {
    if (!PIN_RE.test(String(pin))) return fail('PIN_FORMAT');
    const p = await serverParams();
    if (!p.ok) return p;
    if (Number(p.retryAfterMs) > 0) return fail('PIN_LOCKED', { retryAfterMs: Number(p.retryAfterMs) });
    return { ok: true, derived: await derive(pin, p.salt, Number(p.iterations)) };
  }

  // ---------------------------------------------------------------- privileged pipeline

  function pinUi() {
    return App.AdminPinLock || window.SosAdminPinLock || null;
  }

  let lastUnlockCode = '';

  async function ensureSession() {
    lastUnlockCode = '';
    let s = active();
    if (s) return s;
    const ui = pinUi();
    if (!ui || typeof ui.requestUnlock !== 'function') return null;
    const u = await ui.requestUnlock();
    if (!u || !u.ok) {
      lastUnlockCode = (u && u.code) || '';
      return null;
    }
    s = active();
    return s;
  }

  function unlockFailure(fallback) {
    return fail(lastUnlockCode === 'ADMIN_2FA_SERVICE_UNAVAILABLE' ? lastUnlockCode : fallback);
  }

  /**
   * Obtains and locally verifies the server attestation for an already signed, NOT yet published privileged event.
   * extra: { target? (removed content event), invite? (revoked invite event), expectedOperations?, controlEpoch? }.
   * Returns { ok:true, attestation } only after verifyAdmin2faAttestation passes; the caller publishes afterwards.
   */
  async function attest(event, extra) {
    const opts = extra || {};
    if (!required()) return { ok: true, code: 'ADMIN_2FA_NOT_REQUIRED', skipped: true };
    const p = P();
    const signer = p.activeSignerPubkey();
    const root = p.canonicalRootPubkey();
    if (!configured() || !signer || !root) return fail('ADMIN_2FA_SERVICE_UNAVAILABLE');
    if (!event || !HEX64.test(String(event.id || '')) || p.PRIVILEGED_EVENT_KINDS.indexOf(event.kind) === -1) {
      return fail('ADMIN_2FA_BAD_EVENT');
    }
    const me = actor();
    if (!me || normalizePubkey(event.pubkey) !== me) return fail('NO_IDENTITY');

    let s = await ensureSession();
    if (!s) return unlockFailure('ADMIN_PIN_REQUIRED');
    const A = Adm();
    if (typeof A.pushControl === 'function') await A.pushControl();
    const base = { event: JSON.parse(JSON.stringify(event)) };
    if (opts.target) base.target = JSON.parse(JSON.stringify(opts.target));
    if (opts.invite) base.invite = JSON.parse(JSON.stringify(opts.invite));

    let res = await call('cosign', Object.assign({ sessionId: s.sessionId }, base));
    if (res.result === 'UNAUTHORIZED' && (res.code === 'SESSION_EXPIRED' || res.code === 'NO_SESSION')) {
      clearSession('expired');
      s = await ensureSession();
      if (!s) return unlockFailure('ADMIN_SESSION_EXPIRED');
      res = await call('cosign', Object.assign({ sessionId: s.sessionId }, base));
    }
    if (res.result === 'STEP_UP_REQUIRED') {
      const ui = pinUi();
      if (!ui || typeof ui.requestStepUp !== 'function') return fail('ADMIN_STEP_UP_REQUIRED');
      let cosigned = null;
      const r = await ui.requestStepUp(async (pin) => {
        const d = await stepUpDerivation(pin);
        if (!d.ok) return d;
        const cur = active();
        if (!cur) return fail('ADMIN_SESSION_EXPIRED');
        const rr = await call('cosign', Object.assign({ sessionId: cur.sessionId, stepUp: d.derived }, base));
        if (rr.result === 'COSIGNED') {
          cosigned = rr;
          return { ok: true, code: 'STEP_UP_OK' };
        }
        return mapFailure(rr);
      });
      if (!r || !r.ok || !cosigned) return fail(r && r.code === 'CANCELLED' ? 'ADMIN_STEP_UP_CANCELLED' : (r && r.code) || 'ADMIN_STEP_UP_REQUIRED');
      res = cosigned;
    }
    if (res.result !== 'COSIGNED' || !res.attestation) return mapFailure(res);

    const ops = Array.isArray(res.operations) ? res.operations.slice().sort() : [];
    if (Array.isArray(opts.expectedOperations) && opts.expectedOperations.slice().sort().join(',') !== ops.join(',')) {
      return fail('ADMIN_2FA_OPERATION_MISMATCH');
    }
    const v = p.verifyAdmin2faAttestation(event, res.attestation, {
      groupId: GROUP_ID,
      rootPubkey: root,
      signerPubkey: signer,
      expectedOperations: ops,
      controlEpoch: opts.controlEpoch,
      nowSec: Math.floor(now() / 1000),
      requireUnexpired: true,
    });
    if (!v.ok) return fail(v.code);
    p.ingestAttestations([res.attestation]);
    touch();
    return { ok: true, code: 'ADMIN_2FA_ATTESTED', attestation: res.attestation, operations: ops, stepUp: v.stepUp === true };
  }

  /** Publishes the attestation before the event it covers, so receivers can verify on arrival. */
  async function publishAttested(event, attestation) {
    if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) throw Object.assign(new Error('NO_POOL'), { code: 'NO_POOL' });
    if (attestation) await App.pool.publish(App.relayUrls, attestation);
    return App.pool.publish(App.relayUrls, event);
  }

  function message(code) {
    return code === 'ADMIN_2FA_SERVICE_UNAVAILABLE' ? SERVICE_UNAVAILABLE_TEXT : '';
  }

  // ---------------------------------------------------------------- lifecycle

  let lastActor = '';
  function watch() {
    const me = actor();
    if (lastActor && me !== lastActor) clearSession('identity');
    lastActor = me;
    if (session) active();
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('sos-identity-ready', watch);
    window.addEventListener('storage', watch);
    window.addEventListener('pagehide', () => lock('pagehide'));
  }
  if (typeof setInterval === 'function') setInterval(watch, 5000);

  const api = Object.freeze({
    GROUP_ID,
    PROTOCOL,
    STATE,
    ADMIN_SESSION_TTL_MINUTES,
    PBKDF2_ITERATIONS: MIN_ITERATIONS,
    SERVICE_UNAVAILABLE_TEXT,
    SERVER_PIN_AUTHORITATIVE: true,
    LOCAL_UI_PIN_ONLY: false,
    ADMIN_STATE_SERVER_DERIVED: true,
    LOCAL_PIN_VERIFIER_MIGRATED_AS_SECRET: false,
    PUBLISH_BEFORE_ATTESTATION: false,
    LOCAL_ATTESTATION_VERIFY_BEFORE_PUBLISH: true,
    ROOT_ONLY_FALLBACK: false,
    isTrivialPin,
    configured,
    required,
    state,
    enroll,
    verify,
    lock,
    isActive,
    touch,
    remainingMs,
    lockoutState,
    attest,
    publishAttested,
    message,
  });

  App.Admin2faClient = api;
  window.SosAdmin2faClient = api;
})(typeof window !== 'undefined' ? window : globalThis);
