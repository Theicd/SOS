/**
 * GLOBAL identity model invariants + invite purpose constants + reachability foundation.
 * COMMUNITY_HTML_MODEL_PHASE1=SAME_ORIGIN — multi-domain deferred.
 */
(function initGlobalIdentityFoundation(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const GLOBAL_ACCOUNT_CERT_KIND = 39007;
  const GLOBAL_ACCOUNT_STATUS_KIND = 39008;
  const REACHABILITY_KIND = 10002; // NIP-65 relay list metadata

  const INVITE_PURPOSE = Object.freeze({
    NEW_ACCOUNT: 'NEW_ACCOUNT_INVITE',
    COMMUNITY: 'COMMUNITY_INVITE',
  });

  /** Fixed tag for global identity writers — never follow ambient CommunityContext switches. */
  const GLOBAL_IDENTITY_TAG = 'sos-global-identity';

  /**
   * Compatibility discovery tag retained for First Group readers that still filter israel-network.
   * Writers of GLOBAL profile/presence/follow use BOTH tags where needed for readback,
   * but MUST NOT use mutable App.NETWORK_TAG alone.
   */
  const GLOBAL_DISCOVERY_COMPAT_TAG = 'israel-network';

  function communityMembershipCanCreateIdentity() {
    return false;
  }

  function invitePurposeOfEvent(ev) {
    const t = (ev && Array.isArray(ev.tags) ? ev.tags : []).find((x) => Array.isArray(x) && x[0] === 'purpose');
    const p = t ? String(t[1] || '') : '';
    if (p === INVITE_PURPOSE.NEW_ACCOUNT || p === INVITE_PURPOSE.COMMUNITY) return p;
    // Legacy invites without purpose: treat as COMMUNITY (First Group membership) for redeem routing.
    return INVITE_PURPOSE.COMMUNITY;
  }

  /**
   * NIP-65 reachability draft for current user. USER_REACHABILITY_GLOBAL=true.
   * Does not publish Community content relays as DM relays automatically.
   */
  function buildReachabilityDraft(opts) {
    const o = opts || {};
    const relays = Array.isArray(o.readWriteRelays) ? o.readWriteRelays : App.relayUrls || [];
    const callRelays = Array.isArray(o.callRelays) ? o.callRelays : App.CANONICAL_CALL_RELAYS || [];
    const tags = [];
    relays.slice(0, 20).forEach((url) => {
      const u = String(url || '').trim();
      if (/^wss:\/\//i.test(u)) tags.push(['r', u]);
    });
    callRelays.slice(0, 8).forEach((url) => {
      const u = String(url || '').trim();
      if (/^wss:\/\//i.test(u) && !tags.some((t) => t[1] === u)) tags.push(['r', u, 'call']);
    });
    tags.push(['t', GLOBAL_IDENTITY_TAG]);
    tags.push(['client', 'sos-reachability-v1']);
    // No phone/email; no private Community content relays by default.
    return {
      kind: REACHABILITY_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: JSON.stringify({
        schema: 'sos-user-reachability',
        version: 1,
        USER_REACHABILITY_GLOBAL: true,
        USER_REACHABILITY_COMMUNITY_SCOPED: false,
        REACHABILITY_STANDARD_USED: 'NIP-65 kind 10002 (+ sos call marker)',
      }),
    };
  }

  let _reachabilityEnsuring = false;
  let _reachabilityLastPub = '';
  let _reachabilityLastAt = 0;
  const REACHABILITY_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // avoid unnecessary republish

  /**
   * Conservative NIP-65 ensure after global identity/session readiness.
   * NIP65_COMMUNITY_SWITCH_REPUBLISH=false — do not call on community switch.
   */
  async function ensureGlobalReachability(reason) {
    const why = String(reason || 'identity-ready');
    if (why === 'community-switch' || why.indexOf('community') === 0) {
      return { ok: false, skipped: true, code: 'NIP65_COMMUNITY_SWITCH_REPUBLISH_FALSE' };
    }
    if (!App.publicKey || App.guestMode) return { ok: false, skipped: true, code: 'NO_IDENTITY' };
    if (!App.SosCryptoSigner || typeof App.SosCryptoSigner.signReachabilityEvent !== 'function') {
      return { ok: false, skipped: true, code: 'NO_SIGNER' };
    }
    if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) {
      return { ok: false, skipped: true, code: 'NO_RELAYS' };
    }
    const pk = String(App.publicKey).toLowerCase();
    const now = Date.now();
    if (_reachabilityEnsuring) return { ok: false, skipped: true, code: 'IN_FLIGHT' };
    if (_reachabilityLastPub === pk && now - _reachabilityLastAt < REACHABILITY_MIN_INTERVAL_MS) {
      return { ok: true, skipped: true, code: 'RECENT', NIP65_AUTO_ENSURE_IMPLEMENTED: true };
    }
    _reachabilityEnsuring = true;
    try {
      const draft = buildReachabilityDraft();
      draft.pubkey = pk;
      const signed = await Promise.resolve(App.SosCryptoSigner.signReachabilityEvent(draft));
      await App.pool.publish(App.relayUrls, signed);
      _reachabilityLastPub = pk;
      _reachabilityLastAt = now;
      return {
        ok: true,
        eventId: signed && signed.id,
        NIP65_AUTO_ENSURE_IMPLEMENTED: true,
        NIP65_COMMUNITY_SWITCH_REPUBLISH: false,
        NIP65_CONTAINS_PRIVATE_COMMUNITY_RELAY_BY_DEFAULT: false,
      };
    } catch (e) {
      return { ok: false, code: 'PUBLISH_FAILED', error: String((e && e.message) || e).slice(0, 120) };
    } finally {
      _reachabilityEnsuring = false;
    }
  }

  function wireReachabilityLifecycle() {
    if (wireReachabilityLifecycle._done) return;
    wireReachabilityLifecycle._done = true;
    const trigger = (reason) => {
      try {
        Promise.resolve(ensureGlobalReachability(reason)).catch(function () {});
      } catch (_e) {}
    };
    window.addEventListener('sos-identity-ready', function () {
      trigger('sos-identity-ready');
    });
    // Fallback: after worker/boot identity notifications.
    const prev = App.notifyCallIdentityReady;
    if (typeof prev === 'function') {
      App.notifyCallIdentityReady = function (reason) {
        const r = prev.apply(this, arguments);
        if (String(reason || '').indexOf('community') === -1) trigger(reason || 'call-identity-ready');
        return r;
      };
    } else {
      App.notifyCallIdentityReady = function (reason) {
        if (String(reason || '').indexOf('community') === -1) trigger(reason || 'call-identity-ready');
      };
    }
  }

  const api = Object.freeze({
    GLOBAL_IDENTITY_MODEL: 'single_P_across_communities',
    GLOBAL_PUBKEY_IS_ACCOUNT_ID: true,
    COMMUNITY_MEMBERSHIP_CAN_CREATE_IDENTITY: false,
    communityMembershipCanCreateIdentity,
    GLOBAL_ACCOUNT_CERT_KIND,
    GLOBAL_ACCOUNT_STATUS_KIND,
    REACHABILITY_KIND,
    INVITE_PURPOSE,
    INVITE_TYPES_EXPLICIT: true,
    invitePurposeOfEvent,
    GLOBAL_IDENTITY_TAG,
    GLOBAL_DISCOVERY_COMPAT_TAG,
    EMAIL_USED_FOR_GLOBAL_IDENTITY_AUTHORITY: false,
    SELF_ASSERTED_37377_CAN_CREATE_GLOBAL_ACCOUNT: false,
    GLOBAL_ACCOUNT_DEPENDS_ON_ISRAEL_NETWORK: false,
    PHONE_PROOF_LEVEL: 'WHATSAPP_DELIVERY_BOUND_INVITE',
    PHONE_ONBOARDING_UI_CHANGED: true,
    PHONE_REBIND_NOT_IMPLEMENTED_YET: true,
    COMMUNITY_HTML_MODEL_PHASE1: 'SAME_ORIGIN',
    CROSS_ORIGIN_COMMUNITY_HTML_DEFERRED: true,
    USER_REACHABILITY_GLOBAL: true,
    USER_REACHABILITY_COMMUNITY_SCOPED: false,
    REACHABILITY_STANDARD_USED: 'NIP-65',
    NIP65_AUTO_ENSURE_IMPLEMENTED: true,
    NIP65_COMMUNITY_SWITCH_REPUBLISH: false,
    NIP65_CONTAINS_PRIVATE_COMMUNITY_RELAY_BY_DEFAULT: false,
    buildReachabilityDraft,
    ensureGlobalReachability,
    wireReachabilityLifecycle,
  });

  App.GlobalIdentity = api;
  window.SosGlobalIdentity = api;
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', wireReachabilityLifecycle);
    } else {
      wireReachabilityLifecycle();
    }
  } catch (_w) {
    wireReachabilityLifecycle();
  }

  // Mirror C0 declarations for gates
  if (App.CommunityContext) {
    try {
      App.CommunityContext.GLOBAL_IDENTITY_MODEL = api.GLOBAL_IDENTITY_MODEL;
      App.CommunityContext.COMMUNITY_MEMBERSHIP_CAN_CREATE_IDENTITY = false;
      App.CommunityContext.COMMUNITY_HTML_MODEL_PHASE1 = 'SAME_ORIGIN';
      App.CommunityContext.CROSS_ORIGIN_COMMUNITY_HTML_DEFERRED = true;
    } catch (_e) {}
  }
})(window);
