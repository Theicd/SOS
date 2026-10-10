/**
 * Client for Admission Worker /v1/global/* (phone directory + NEW_ACCOUNT_INVITE + account cert/status).
 * Does not expose phoneToken to callers. PHONE_TOKEN_SECRET_IN_BROWSER=false.
 * General phone lookup requires authenticated signed authEvent.
 * Public /phone/bind and anonymous /account/cert/issue are denied server-side.
 */
(function initGlobalAdmissionClient(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  function baseUrl() {
    return String(App.FIRST_GROUP_ADMISSION_URL || App.GLOBAL_ADMISSION_URL || '').replace(/\/$/, '');
  }

  async function post(path, body) {
    const base = baseUrl();
    if (!base) return { result: 'INVALID', code: 'NO_ADMISSION_URL' };
    try {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const json = await res.json().catch(() => null);
      if (!json || typeof json !== 'object') return { result: 'TEMPORARILY_UNAVAILABLE', code: 'BAD_RESPONSE', http: res.status };
      if (typeof json.http !== 'number') json.http = res.status;
      return json;
    } catch (_e) {
      return { result: 'TEMPORARILY_UNAVAILABLE', code: 'NETWORK' };
    }
  }

  async function buildLookupAuthEvent() {
    const S = App.SosCryptoSigner;
    if (!S || typeof S.signEvent !== 'function' || !App.publicKey) {
      return { ok: false, code: 'NOT_AUTHENTICATED' };
    }
    const GAS = App.GlobalAccountStatusState || window.SosGlobalAccountStatusState;
    if (GAS && typeof GAS.assertSocallAllowed === 'function') {
      const g = GAS.assertSocallAllowed(App.publicKey);
      if (g && g.ok === false) return { ok: false, code: g.code || 'ACCOUNT_DISABLED' };
    }
    try {
      if (typeof S.signPhoneLookupAuth !== 'function') {
        return { ok: false, code: 'SIGNER_MISSING_PHONE_LOOKUP' };
      }
      const draft = {
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['t', 'sos-phone-lookup'],
          ['client', 'sos-global-admission'],
          ['expiration', String(Math.floor(Date.now() / 1000) + 120)],
        ],
        content: JSON.stringify({ purpose: 'PHONE_LOOKUP', v: 1 }),
      };
      const ev = await Promise.resolve(S.signPhoneLookupAuth(draft));
      return { ok: true, authEvent: ev };
    } catch (e) {
      return { ok: false, code: 'SIGN_FAILED', error: String((e && e.message) || e) };
    }
  }

  async function buildRedeemerAuthEvent(inviteId) {
    const S = App.SosCryptoSigner;
    const id = String(inviteId || '').toLowerCase();
    if (!S || typeof S.signPhoneLookupAuth !== 'function' || !App.publicKey) {
      return { ok: false, code: 'NOT_AUTHENTICATED' };
    }
    if (!/^[0-9a-f]{64}$/.test(id)) return { ok: false, code: 'BAD_INVITE_ID' };
    try {
      const now = Math.floor(Date.now() / 1000);
      const draft = {
        kind: 22242,
        created_at: now,
        tags: [
          ['t', 'sos-new-account-redeem'],
          ['e', id],
          ['expiration', String(now + 120)],
        ],
        content: JSON.stringify({ purpose: 'REDEEM_NEW_ACCOUNT_INVITE', inviteId: id, v: 1 }),
      };
      const ev = await Promise.resolve(S.signPhoneLookupAuth(draft));
      return { ok: true, authEvent: ev };
    } catch (e) {
      return { ok: false, code: 'SIGN_FAILED', error: String((e && e.message) || e) };
    }
  }

  /** Authenticated SO-CALL / inviter lookup. ANONYMOUS_GENERAL_PHONE_LOOKUP=false */
  async function lookupPhone(phone) {
    const auth = await buildLookupAuthEvent();
    if (!auth.ok) return { result: 'INVALID', code: auth.code || 'NOT_AUTHENTICATED', ANONYMOUS_GENERAL_PHONE_LOOKUP: false };
    return post('/v1/global/phone/lookup', { phone: String(phone || ''), authEvent: auth.authEvent });
  }

  /** Scoped invite redeem phone check — does not require general lookup auth. */
  async function checkNewAccountInvitePhone(inviteId, phone) {
    return post('/v1/global/invites/new-account/check-phone', {
      inviteId: String(inviteId || '').toLowerCase(),
      phone: String(phone || ''),
    });
  }

  async function accountExists(pubkey) {
    return post('/v1/global/account/exists', { pubkey: String(pubkey || '').toLowerCase() });
  }

  async function getAccountStatus(pubkey) {
    return post('/v1/global/account/status/get', { pubkey: String(pubkey || '').toLowerCase() });
  }

  /**
   * Fetch authoritative global status tip and ingest verified 39008 into local cache.
   * Used on boot / login before SessionAuthority bind.
   */
  async function reconcileAccountStatus(pubkey) {
    const pk = String(pubkey || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pk)) {
      return { ok: false, code: 'BAD_PUBKEY', reachable: false };
    }
    const GAS = App.GlobalAccountStatusState || window.SosGlobalAccountStatusState;
    const st = await getAccountStatus(pk);
    if (st.result === 'TEMPORARILY_UNAVAILABLE' || st.code === 'NETWORK' || st.code === 'NO_ADMISSION_URL') {
      return {
        ok: false,
        code: st.code || 'UNREACHABLE',
        reachable: false,
        OFFLINE_STATUS_POLICY: true,
      };
    }
    if (st.result !== 'OK') {
      return { ok: false, code: st.code || 'STATUS_ERROR', reachable: true };
    }
    if (GAS && typeof GAS.setIssuerAllowlist === 'function' && st.issuerPubkey) {
      try {
        GAS.setIssuerAllowlist([st.issuerPubkey]);
      } catch (_e) {}
    }
    const ev = st.statusEvent || st.event || null;
    if (ev && GAS && typeof GAS.ingest === 'function') {
      GAS.ingest(ev);
    } else if (GAS && typeof GAS.applyWorkerStatusTip === 'function') {
      GAS.applyWorkerStatusTip(pk, st);
    }
    return {
      ok: true,
      reachable: true,
      status: st.status,
      revision: st.revision,
      exists: st.exists === true,
      ACCOUNT_DISABLED: st.ACCOUNT_DISABLED === true || st.status === 'ACCOUNT_DISABLED',
      ingested: !!ev,
    };
  }

  async function registerNewAccountInvite(inviteEvent, recipientPhone) {
    return post('/v1/global/invites/new-account/register', {
      invite: inviteEvent,
      purpose: 'NEW_ACCOUNT_INVITE',
      recipientPhone: String(recipientPhone || ''),
    });
  }

  async function redeemNewAccountInvite(opts) {
    const o = opts || {};
    const inviteId = o.inviteId;
    let redeemerAuthEvent = o.redeemerAuthEvent || null;
    if (!redeemerAuthEvent) {
      const built = await buildRedeemerAuthEvent(inviteId);
      if (!built.ok) {
        return { result: 'INVALID', code: built.code || 'REDEEMER_AUTH_REQUIRED', REDEEMER_AUTH_REQUIRED: true };
      }
      redeemerAuthEvent = built.authEvent;
    }
    return post('/v1/global/invites/new-account/redeem', {
      inviteId,
      code: o.code,
      phone: o.phone,
      redeemerPubkey: o.redeemerPubkey,
      redeemerAuthEvent,
    });
  }

  /** Public cert mint is disabled — redeem path issues 39007 server-side. */
  async function issueAccountCert(_pubkey) {
    return {
      result: 'INVALID',
      code: 'CERT_ISSUE_PUBLIC_DISABLED',
      UNAUTHORIZED_39007_ISSUANCE_ACCEPTED: false,
      FORGED_37377_MIGRATION_ACCEPTED: false,
      SELF_ASSERTED_37377_GLOBAL_ACCOUNT_ACCEPTED: false,
    };
  }

  async function setGlobalAccountStatus(opts) {
    return post('/v1/global/account/status/set', opts || {});
  }

  async function meta() {
    return post('/v1/global/meta', {});
  }

  const api = Object.freeze({
    lookupPhone,
    checkNewAccountInvitePhone,
    accountExists,
    getAccountStatus,
    reconcileAccountStatus,
    registerNewAccountInvite,
    redeemNewAccountInvite,
    issueAccountCert,
    setGlobalAccountStatus,
    meta,
    buildRedeemerAuthEvent,
    PHONE_LOOKUP_REQUIRES_SHARED_COMMUNITY: false,
    PHONE_TOKEN_SECRET_IN_BROWSER: false,
    PHONE_TOKEN_CLIENT_COMPUTABLE: false,
    ANONYMOUS_GENERAL_PHONE_LOOKUP: false,
    AUTHENTICATED_SOCALL_PHONE_LOOKUP: true,
    INVITE_REDEEM_PHONE_CHECK_SCOPED: true,
    UNAUTHORIZED_39007_ISSUANCE_ACCEPTED: false,
    UNAUTHORIZED_PHONE_BIND_ACCEPTED: false,
  });

  App.GlobalAdmission = api;
  window.SosGlobalAdmission = api;
})(window);
