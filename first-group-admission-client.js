/**
 * Package 898 — First group (israel-network) canonical admission service client.
 *
 * Single-use invites are consumed only by the admission service (Cloudflare Worker + one Durable Object per
 * invite). The service atomically claims the invite (UNUSED -> CLAIMED -> FINALIZED) and signs the invite-bound
 * GRANT_ACTIVE membership proof (kind 39003) with its own key, which clients accept only while GROUP_CONTROL
 * (root-signed) delegates FINALIZE_MEMBERSHIP_ADMISSION to that key.
 *
 * Requests reuse existing signed kinds: 37378 (invite registration), 37379 (redemption request, signed by the
 * redeemer, carrying operationId + member revision), 37380 (revoke). The invite code is sent only to the service
 * (proof of possession) and never published. If the service is unreachable, redemption fails closed; there is
 * no relay / client-order fallback.
 */
(function initFirstGroupAdmission(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const GROUP_ID = 'israel-network';
  const SERVICE_TAG = 'sos-first-group-admission-v1';
  const REQUEST_TIMEOUT_MS = 8000;
  const REDEEM_ATTEMPTS = 3;
  /** UI cache only: remembers this device's operationId per invite so a retry reuses the same operation. */
  const OP_PREFIX = 'sos_fg_admission_op_';

  const RESULTS = Object.freeze([
    'ACCEPTED',
    'ALREADY_REDEEMED',
    'REVOKED',
    'EXPIRED',
    'INVALID',
    'UNAUTHORIZED',
    'TEMPORARILY_UNAVAILABLE',
  ]);

  const MESSAGES = Object.freeze({
    ACCEPTED: 'ההצטרפות אושרה',
    ALREADY_REDEEMED: 'ההזמנה כבר נוצלה',
    EXPIRED: 'ההזמנה פגה',
    REVOKED: 'ההזמנה בוטלה',
    INVALID: 'ההזמנה אינה תקינה',
    UNAUTHORIZED: 'אין הרשאה לפעולה הזו',
    TEMPORARILY_UNAVAILABLE: 'שירות ההצטרפות אינו זמין כרגע. נסו שוב בעוד רגע.',
  });

  function MS() {
    return App.MembershipState || window.SosMembershipState || null;
  }
  function GCS() {
    return App.GroupControlState || window.SosGroupControlState || null;
  }

  function normalizePubkey(value) {
    if (typeof value !== 'string') return '';
    const t = value.trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(t) ? t : '';
  }

  function readTag(ev, name) {
    const row = ev && Array.isArray(ev.tags) ? ev.tags.find((t) => Array.isArray(t) && t[0] === name && t[1] != null) : null;
    return row ? String(row[1]) : '';
  }

  function baseUrl() {
    const u = String(App.FIRST_GROUP_ADMISSION_URL || '').trim().replace(/\/+$/, '');
    if (/^https:\/\/[^\s/?#]+$/.test(u)) return u;
    if (/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(u)) return u;
    return '';
  }

  function configured() {
    return !!baseUrl();
  }

  function message(result) {
    return MESSAGES[result] || MESSAGES.INVALID;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function post(path, body) {
    const url = baseUrl();
    if (!url) return { result: 'TEMPORARILY_UNAVAILABLE', code: 'NOT_CONFIGURED' };
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
        signal: ctl ? ctl.signal : undefined,
      });
      const data = await res.json().catch(() => null);
      if (!data || typeof data.result !== 'string') return { result: 'TEMPORARILY_UNAVAILABLE', code: 'BAD_RESPONSE' };
      return data;
    } catch (_e) {
      return { result: 'TEMPORARILY_UNAVAILABLE', code: 'NETWORK' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function syncControl(events, attestations) {
    const list = (Array.isArray(events) ? events : []).filter((e) => e && e.kind === 39001).slice(0, 500);
    if (!list.length) return Promise.resolve({ result: 'INVALID', code: 'NO_EVENTS' });
    // With Admin 2FA enforced the service verifies each control step only with its attestation (39004).
    const atts = (Array.isArray(attestations) ? attestations : []).filter((e) => e && e.kind === 39004).slice(0, 500);
    return post('/v1/control/ingest', { groupId: GROUP_ID, events: list, attestations: atts });
  }

  /** Brings the service's control view up to this client's verified tip (events are root-verified server-side). */
  async function pushControl() {
    const NA = App.FirstGroupNetworkAuthority;
    if (!NA || typeof NA.pushControlToAdmission !== 'function') return;
    try {
      await NA.pushControlToAdmission();
    } catch (_e) {}
  }

  async function registerInvite(inviteEvent) {
    await pushControl();
    return post('/v1/invites/register', { groupId: GROUP_ID, invite: inviteEvent });
  }

  async function revoke(revokeEvent) {
    await pushControl();
    return post('/v1/invites/revoke', { groupId: GROUP_ID, revoke: revokeEvent });
  }

  function status(inviteEventId, code) {
    return post('/v1/invites/status', {
      groupId: GROUP_ID,
      inviteId: String(inviteEventId || '').toLowerCase(),
      code: String(code || '').trim().toUpperCase(),
    });
  }

  function randomOperationId() {
    const b = new Uint8Array(18);
    window.crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  function loadOp(inviteId, pub) {
    try {
      const r = JSON.parse(window.localStorage.getItem(OP_PREFIX + inviteId) || 'null');
      if (r && r.pub === pub && /^[0-9a-f]{36}$/.test(String(r.op)) && Number.isInteger(r.rev)) return r;
    } catch (_e) {}
    return null;
  }

  /** Hint only: the service still decides; it returns the prior ACCEPTED proof only for the same P + operationId. */
  function hasOperation(inviteEventId) {
    const pub = normalizePubkey(App.publicKey);
    const id = String(inviteEventId || '').toLowerCase();
    return !!(pub && /^[0-9a-f]{64}$/.test(id) && loadOp(id, pub));
  }

  function saveOp(inviteId, rec) {
    try {
      window.localStorage.setItem(OP_PREFIX + inviteId, JSON.stringify(rec));
    } catch (_e) {}
  }

  function nextMemberRevision(pub) {
    const m = MS();
    if (!m || typeof m.getMemberSnapshot !== 'function') return 1;
    try {
      if (typeof m.bindMembershipStore === 'function') m.bindMembershipStore(GROUP_ID);
      const snap = m.getMemberSnapshot(pub);
      const rev = snap && snap.record ? Number(snap.record.memberRevision) || 0 : 0;
      return rev + 1;
    } catch (_e) {
      return 1;
    }
  }

  function verifiedControl() {
    const g = GCS();
    if (!g || g.getStatus(GROUP_ID) !== 'VERIFIED') return null;
    return g.getVerifiedControlState(GROUP_ID);
  }

  function publish(events) {
    if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) return;
    events.forEach((ev) => {
      try {
        Promise.all(App.pool.publish(App.relayUrls, ev)).catch(() => {});
      } catch (_e) {}
    });
  }

  function applyProof(proof) {
    const m = MS();
    const st = verifiedControl();
    if (!m || !st) return { ok: false, code: 'NO_VERIFIED_CONTROL' };
    try {
      const r = m.acceptMembershipEvent(proof, st, { groupId: GROUP_ID });
      return { ok: !!(r && r.ok), code: r && r.code };
    } catch (e) {
      return { ok: false, code: (e && e.code) || 'PROOF_REJECTED' };
    }
  }

  /**
   * Redeem a single-use invite through the canonical admission service.
   * The same operationId is reused for every retry on this device, so a lost response returns the same ACCEPTED proof.
   */
  async function redeem({ code, inviteEvent, inviterPubkey }) {
    const S = App.SosCryptoSigner;
    const pub = normalizePubkey(App.publicKey);
    if (!S || typeof S.hasIdentityKey !== 'function' || !S.hasIdentityKey() || !pub || App.guestMode === true) {
      return { ok: false, result: 'UNAUTHORIZED', code: 'NO_IDENTITY', error: message('UNAUTHORIZED') };
    }
    const inviteId = String((inviteEvent && inviteEvent.id) || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(inviteId)) return { ok: false, result: 'INVALID', code: 'NO_INVITE', error: message('INVALID') };
    if (!configured()) {
      return { ok: false, result: 'TEMPORARILY_UNAVAILABLE', code: 'NOT_CONFIGURED', error: message('TEMPORARILY_UNAVAILABLE') };
    }
    const NA = App.FirstGroupNetworkAuthority;
    if (NA && typeof NA.reconcile === 'function') {
      try {
        await NA.reconcile('admission-redeem');
      } catch (_e) {}
    }
    await pushControl();
    let rec = loadOp(inviteId, pub);
    if (!rec) {
      rec = { pub, op: randomOperationId(), rev: nextMemberRevision(pub) };
      saveOp(inviteId, rec);
    }
    const tags = [
      ['t', App.INVITE_USED_TAG || 'sos-invite-used'],
      ['t', GROUP_ID],
      ['e', inviteId],
      ['d', inviteId],
      ['ih', readTag(inviteEvent, 'ih')],
      ['op', rec.op],
      ['member-revision', String(rec.rev)],
      ['svc', SERVICE_TAG],
    ];
    const inviter = normalizePubkey(inviterPubkey || (inviteEvent && inviteEvent.pubkey));
    if (inviter) tags.push(['p', inviter]);
    let request;
    try {
      request = await Promise.resolve(
        S.signInviteEvent({
          kind: App.INVITE_USED_KIND || 37379,
          created_at: Math.floor(Date.now() / 1000),
          tags,
          content: JSON.stringify({ v: 2, type: 'invite-used' }),
          pubkey: pub,
        })
      );
    } catch (_e) {
      return { ok: false, result: 'UNAUTHORIZED', code: 'SIGN_FAILED', error: message('UNAUTHORIZED') };
    }
    let res = { result: 'TEMPORARILY_UNAVAILABLE' };
    for (let attempt = 0; attempt < REDEEM_ATTEMPTS; attempt++) {
      res = await post('/v1/invites/redeem', { groupId: GROUP_ID, request, code: String(code || '').trim().toUpperCase() });
      if (res.result !== 'TEMPORARILY_UNAVAILABLE') break;
      await sleep(500 * (attempt + 1));
    }
    const result = RESULTS.indexOf(res.result) !== -1 ? res.result : 'INVALID';
    if (result !== 'ACCEPTED') {
      return { ok: false, result, code: res.code || result, error: message(result), operationId: rec.op, event: request };
    }
    const proof = res.proof;
    const applied = proof ? applyProof(proof) : { ok: false, code: 'NO_PROOF' };
    if (proof) publish([proof, request]);
    rec.done = true;
    saveOp(inviteId, rec);
    try {
      window.dispatchEvent(new CustomEvent('sos-first-group-state-changed', { detail: { reason: 'admission' } }));
    } catch (_e) {}
    return { ok: true, result, code: 'ACCEPTED', operationId: rec.op, event: request, proof, applied, replay: res.replay === true };
  }

  const api = Object.freeze({
    GROUP_ID,
    SERVICE_TAG,
    RESULTS,
    MESSAGES,
    ADMISSION_AUTHORITY: 'FIRST_GROUP_ADMISSION_SERVICE (ROOT-delegated key, Durable Object per invite)',
    UNSERIALIZED_FALLBACK_ENABLED: false,
    configured,
    message,
    post,
    pushControl,
    syncControl,
    registerInvite,
    redeem,
    revoke,
    status,
    hasOperation,
  });

  App.FirstGroupAdmission = api;
  window.SosFirstGroupAdmission = api;
})(typeof window !== 'undefined' ? window : globalThis);
