/**
 * GLOBAL account status (kind 39008) — identity security, not Community membership.
 * ACCOUNT_DISABLED_GLOBAL=true. Community BLOCKED/REMOVED remain separate.
 * COMMUNITY_ADMIN_GLOBAL_DISABLE_ACCEPTED=false — only authoritative global issuer tips accepted.
 */
(function initGlobalAccountStatusState(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const KIND = 39008;
  const SCHEMA = 'sos-global-account-status';
  const VERSION = 1;
  const CACHE_KEY = 'sos_global_account_status_v1';
  const TAG = 'sos-global-account-status';

  const STATUS = Object.freeze({
    ACTIVE: 'ACTIVE',
    ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  });

  /** targetPubkey -> tip */
  const tips = new Map();
  let issuerAllow = new Set();

  function norm(pk) {
    const t = String(pk || '')
      .trim()
      .toLowerCase()
      .replace(/^0x/, '');
    return /^[0-9a-f]{64}$/.test(t) ? t : '';
  }

  function verifyEvent(ev) {
    try {
      const NT = window.NostrTools;
      return !!(ev && NT && typeof NT.verifyEvent === 'function' && NT.verifyEvent(ev) === true);
    } catch (_e) {
      return false;
    }
  }

  function setIssuerAllowlist(pks) {
    issuerAllow = new Set((Array.isArray(pks) ? pks : []).map(norm).filter(Boolean));
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return {};
      const o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : {};
    } catch (_e) {
      return {};
    }
  }

  function writeCache() {
    try {
      const out = {};
      tips.forEach((v, k) => {
        out[k] = v;
      });
      localStorage.setItem(CACHE_KEY, JSON.stringify(out));
    } catch (_e) {}
  }

  function hydrateFromCache() {
    const c = readCache();
    Object.keys(c).forEach((k) => {
      const pk = norm(k);
      const row = c[k];
      if (!pk || !row) return;
      const rev = Number(row.revision) || 0;
      if (rev < 1) return;
      const cur = tips.get(pk);
      if (!cur || rev > cur.revision) tips.set(pk, row);
    });
  }

  function parseBody(ev) {
    if (!ev || ev.kind !== KIND || !verifyEvent(ev)) return null;
    let body;
    try {
      body = JSON.parse(ev.content || '{}');
    } catch (_e) {
      return null;
    }
    if (!body || body.schema !== SCHEMA) return null;
    const target = norm(body.targetPubkey || (ev.tags || []).find((t) => t[0] === 'p')?.[1]);
    const status = String(body.status || '').toUpperCase();
    if (!target || (status !== STATUS.ACTIVE && status !== STATUS.ACCOUNT_DISABLED)) return null;
    if (issuerAllow.size && !issuerAllow.has(norm(ev.pubkey))) return null;
    // Must carry global status tag — community-only events are not accepted as global disable.
    if (!(ev.tags || []).some((t) => t[0] === 't' && t[1] === TAG)) return null;
    if (body.groupId) return null;
    return {
      status,
      revision: Number(body.revision) || 0,
      reasonCode: String(body.reasonCode || ''),
      eventId: String(ev.id || ''),
      issuer: norm(ev.pubkey),
      createdAt: Number(ev.created_at) || 0,
      ACCOUNT_DISABLED_GLOBAL: true,
    };
  }

  function ingest(ev) {
    const tip = parseBody(ev);
    if (!tip || tip.revision < 1) return false;
    const target = norm((ev.tags || []).find((t) => t[0] === 'p')?.[1]);
    if (!target) return false;
    const cur = tips.get(target);
    if (cur && tip.revision <= cur.revision) return false;
    tips.set(target, tip);
    writeCache();
    try {
      window.dispatchEvent(new CustomEvent('sos-global-account-status-changed', { detail: { pubkey: target, tip } }));
    } catch (_e) {}
    return true;
  }

  function ingestMany(events) {
    (Array.isArray(events) ? events : []).forEach(ingest);
  }

  function statusOf(pk) {
    const t = tips.get(norm(pk));
    return t && t.status === STATUS.ACCOUNT_DISABLED ? STATUS.ACCOUNT_DISABLED : STATUS.ACTIVE;
  }

  function isDisabled(pk) {
    return statusOf(pk) === STATUS.ACCOUNT_DISABLED;
  }

  /**
   * Global login / SO-CALL / DM / call / linked-device gate.
   * Merges with legacy 39005 AccountStatusState when present (OR deny).
   */
  /**
   * Offline / stale-cache policy (documented for Stage 5):
   * - Verified DISABLED tip in local cache → DENY login / pairing / SO-CALL (no silent ACTIVE).
   * - Worker unreachable + no verified tip → ALLOW legacy login (cannot prove disable offline);
   *   not claimed as immediate revocation on a fully offline device.
   * - Worker unreachable + cached ACTIVE → ALLOW with STALE_ACTIVE (next online reconcile may revoke).
   * - Operations requiring current authority (SO-CALL, linked-device bind) should call
   *   reconcileAccountStatus first; if unreachable and cache is not DISABLED, pairing/SO-CALL
   *   may still proceed under STALE, but a verified DISABLED cache always denies.
   * - Community 39005 BLOCKED/REMOVED remain community-scoped and do not equal global disable;
   *   legacy 39005 ACCOUNT_DISABLED still OR-denies login (dual-read).
   * - Unknown historical status / missing 39007 → not disable; legacy no-phone login preserved.
   * - Conflicting revisions: higher verified global revision wins; forged events fail issuer allowlist.
   */
  const OFFLINE_STATUS_POLICY = Object.freeze({
    verifiedDisabledCache: 'DENY',
    unreachableNoCache: 'ALLOW_LEGACY_LOGIN_STALE_UNKNOWN',
    unreachableActiveCache: 'ALLOW_STALE_ACTIVE',
    requiredAuthorityPreferRefresh: true,
    immediateOfflineRevocationClaimed: false,
  });

  /**
   * Apply Worker getStatus tip when statusEvent is absent but status=ACCOUNT_DISABLED
   * (should be rare — prefer ingesting the signed event). Does not invent issuer signatures.
   */
  function applyWorkerStatusTip(pk, st) {
    const target = norm(pk);
    if (!target || !st || st.result !== 'OK') return false;
    if (st.statusEvent || st.event) return false;
    if (st.status !== STATUS.ACCOUNT_DISABLED) return false;
    const rev = Number(st.revision) || 0;
    if (rev < 1) return false;
    const cur = tips.get(target);
    if (cur && rev <= cur.revision) return false;
    tips.set(target, {
      status: STATUS.ACCOUNT_DISABLED,
      revision: rev,
      reasonCode: 'WORKER_TIP',
      eventId: '',
      issuer: norm(st.issuerPubkey),
      createdAt: Number(st.updatedAt) || Math.floor(Date.now() / 1000),
      ACCOUNT_DISABLED_GLOBAL: true,
      fromWorkerTip: true,
    });
    writeCache();
    try {
      window.dispatchEvent(new CustomEvent('sos-global-account-status-changed', { detail: { pubkey: target } }));
    } catch (_e) {}
    return true;
  }

  function assertLoginAllowed(pk) {
    hydrateFromCache();
    const target = norm(pk);
    if (!target) return { ok: false, code: 'BAD_PUBKEY', message: 'החשבון אינו מורשה להתחבר ל-SOS.' };
    if (isDisabled(target)) {
      return {
        ok: false,
        code: 'ACCOUNT_DISABLED',
        message: 'החשבון הושבת ואינו מורשה להתחבר ל-SOS.',
        ACCOUNT_DISABLED_GLOBAL: true,
        DISABLED_PUBKEY_CAN_LOGIN_IN_ANY_COMMUNITY: false,
        OFFLINE_STATUS_POLICY,
      };
    }
    // Legacy First-Group 39005 still denies if present (local migration dual-read).
    try {
      const legacy = App.AccountStatusState || window.SosAccountStatusState;
      if (legacy && typeof legacy.assertLoginAllowed === 'function') {
        const g = legacy.assertLoginAllowed(target);
        if (g && g.ok === false && g.code === 'ACCOUNT_DISABLED') return g;
      }
    } catch (_e) {}
    return { ok: true, code: 'OK', OFFLINE_STATUS_POLICY };
  }

  function enforceLiveSession() {
    const me = norm(App.publicKey);
    if (!me || !isDisabled(me)) return { revoked: false };
    try {
      const SA = App.SessionAuthority || window.SosSessionAuthority;
      if (SA && typeof SA.revokeSession === 'function') {
        SA.revokeSession({ reason: 'account_disabled_global', rebind: false });
      }
    } catch (_e) {}
    try {
      App.guestMode = true;
      if (typeof App.syncTopBarAuthUi === 'function') App.syncTopBarAuthUi();
    } catch (_e2) {}
    return { revoked: true };
  }

  function assertSocallAllowed(pk) {
    const g = assertLoginAllowed(pk);
    if (!g.ok) return Object.assign({}, g, { DISABLED_PUBKEY_CAN_USE_SOCALL: false });
    return { ok: true };
  }

  function assertDmAllowed(pk) {
    const g = assertLoginAllowed(pk);
    if (!g.ok) return Object.assign({}, g, { DISABLED_PUBKEY_CAN_USE_DM: false });
    return { ok: true };
  }

  function assertCallAllowed(pk) {
    const g = assertLoginAllowed(pk);
    if (!g.ok) return Object.assign({}, g, { DISABLED_PUBKEY_CAN_USE_CALLS: false });
    return { ok: true };
  }

  function assertLinkedDeviceBindAllowed(pk) {
    const g = assertLoginAllowed(pk);
    if (!g.ok) return Object.assign({}, g, { DISABLED_PUBKEY_CAN_BIND_LINKED_DEVICE: false });
    return { ok: true };
  }

  hydrateFromCache();

  window.addEventListener('sos-global-account-status-changed', () => {
    enforceLiveSession();
  });

  const api = Object.freeze({
    KIND,
    SCHEMA,
    VERSION,
    TAG,
    STATUS,
    OFFLINE_STATUS_POLICY,
    setIssuerAllowlist,
    ingest,
    ingestMany,
    applyWorkerStatusTip,
    statusOf,
    isDisabled,
    assertLoginAllowed,
    assertSocallAllowed,
    assertDmAllowed,
    assertCallAllowed,
    assertLinkedDeviceBindAllowed,
    enforceLiveSession,
    ACCOUNT_DISABLED_GLOBAL: true,
    COMMUNITY_ADMIN_GLOBAL_DISABLE_ACCEPTED: false,
    SELF_ASSERTED_37377_GLOBAL_ACCOUNT_ACCEPTED: false,
    LEGACY_STATUS_COMPATIBILITY_DEFINED: true,
    COMMUNITY_BLOCK_NOT_GLOBAL_DISABLE: true,
  });

  App.GlobalAccountStatusState = api;
  window.SosGlobalAccountStatusState = api;
})(window);
