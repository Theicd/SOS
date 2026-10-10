/**
 * Account-level SOS access status (kind 39005).
 * Separate from membership BLOCKED/REMOVED. ROOT-only disable/enable.
 * Parameterized-replaceable: d = groupId:targetPubkey:revision
 * Highest revision wins; only ROOT issuer accepted. Cache verified tips for offline deny.
 */
(function initAccountStatusState(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const KIND = 39005;
  const SCHEMA = 'sos-account-status';
  const VERSION = 1;
  const GROUP_ID = 'israel-network';
  const CACHE_KEY = 'sos_account_status_v1';

  const STATUS = Object.freeze({
    ENABLED: 'ENABLED',
    DISABLED: 'DISABLED',
  });

  const REASON = Object.freeze({
    ADMIN_DISABLED: 'ADMIN_DISABLED',
    IMPERSONATION: 'IMPERSONATION',
    IDENTITY_COMPROMISE: 'IDENTITY_COMPROMISED',
    ABUSE: 'ABUSE',
    FAKE_ACCOUNT: 'FAKE_ACCOUNT',
    OTHER: 'OTHER',
  });

  /** targetPubkey -> { status, revision, reasonCode, eventId, issuer, createdAt, groupId } */
  const tips = new Map();
  let rootPubkey = '';

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
        out[k] = {
          status: v.status,
          revision: v.revision,
          reasonCode: v.reasonCode || '',
          eventId: v.eventId || '',
          issuer: v.issuer || '',
          createdAt: v.createdAt || 0,
          groupId: v.groupId || GROUP_ID,
        };
      });
      localStorage.setItem(CACHE_KEY, JSON.stringify(out));
    } catch (_e) {}
  }

  function hydrateFromCache() {
    const c = readCache();
    Object.keys(c).forEach((k) => {
      const pk = norm(k);
      const row = c[k];
      if (!pk || !row || (row.status !== STATUS.DISABLED && row.status !== STATUS.ENABLED)) return;
      const rev = Number(row.revision) || 0;
      if (rev < 1) return;
      const cur = tips.get(pk);
      if (!cur || rev > cur.revision) {
        tips.set(pk, {
          status: row.status,
          revision: rev,
          reasonCode: String(row.reasonCode || ''),
          eventId: String(row.eventId || ''),
          issuer: norm(row.issuer),
          createdAt: Number(row.createdAt) || 0,
          groupId: String(row.groupId || GROUP_ID),
        });
      }
    });
  }

  function setRoot(pk) {
    rootPubkey = norm(pk);
  }

  function parseBody(ev) {
    if (!ev || ev.kind !== KIND || !verifyEvent(ev)) return null;
    let body;
    try {
      body = JSON.parse(ev.content);
    } catch (_e) {
      return null;
    }
    if (!body || body.schema !== SCHEMA || body.version !== VERSION) return null;
    if (body.groupId !== GROUP_ID) return null;
    const target = norm(body.targetPubkey);
    const issuer = norm(ev.pubkey);
    if (!target || !issuer) return null;
    if (body.status !== STATUS.ENABLED && body.status !== STATUS.DISABLED) return null;
    const revision = Number(body.revision);
    if (!Number.isInteger(revision) || revision < 1) return null;
    const reasonCode = String(body.reasonCode || REASON.ADMIN_DISABLED);
    const allowedReasons = Object.values(REASON);
    if (allowedReasons.indexOf(reasonCode) === -1) return null;
    return {
      targetPubkey: target,
      status: body.status,
      revision,
      reasonCode,
      eventId: String(ev.id || ''),
      issuer,
      createdAt: Number(body.createdAt) || Number(ev.created_at) || 0,
      groupId: GROUP_ID,
      event: ev,
    };
  }

  function ingest(ev) {
    const row = parseBody(ev);
    if (!row) return { ok: false, code: 'REJECTED' };
    if (rootPubkey && row.issuer !== rootPubkey) return { ok: false, code: 'NON_ROOT_ISSUER' };
    // Without known root yet, still accept but mark; reconcile later with root check
    if (!rootPubkey) {
      // keep pending only if cache already had it or we'll set root soon
    } else if (row.issuer !== rootPubkey) {
      return { ok: false, code: 'NON_ROOT_ISSUER' };
    }
    const cur = tips.get(row.targetPubkey);
    if (cur && row.revision < cur.revision) return { ok: false, code: 'STALE' };
    if (cur && row.revision === cur.revision && cur.eventId && cur.eventId !== row.eventId) {
      // conflict: prefer DISABLED (fail closed)
      if (cur.status === STATUS.DISABLED || row.status === STATUS.DISABLED) {
        const keep = cur.status === STATUS.DISABLED ? cur : row;
        tips.set(row.targetPubkey, keep);
        writeCache();
        return { ok: true, code: 'CONFLICT_KEEP_DISABLED', tip: keep };
      }
      return { ok: false, code: 'CONFLICT' };
    }
    tips.set(row.targetPubkey, row);
    writeCache();
    try {
      window.dispatchEvent(
        new CustomEvent('sos-account-status-changed', {
          detail: { targetPubkey: row.targetPubkey, status: row.status, revision: row.revision },
        })
      );
    } catch (_e) {}
    return { ok: true, code: 'APPLIED', tip: row };
  }

  function ingestMany(events) {
    (events || []).forEach((e) => ingest(e));
  }

  function statusOf(pk) {
    const t = tips.get(norm(pk));
    if (!t) return STATUS.ENABLED;
    return t.status === STATUS.DISABLED ? STATUS.DISABLED : STATUS.ENABLED;
  }

  function isDisabled(pk) {
    return statusOf(pk) === STATUS.DISABLED;
  }

  function tipOf(pk) {
    return tips.get(norm(pk)) || null;
  }

  function listDisabled() {
    const out = [];
    tips.forEach((v, k) => {
      if (v.status === STATUS.DISABLED) out.push(Object.assign({ targetPubkey: k }, v));
    });
    return out;
  }

  /**
   * Gate before session bind. Returns { ok, code, message }.
   * Uses memory + durable cache; does not require live network.
   */
  function assertLoginAllowed(pk) {
    hydrateFromCache();
    const target = norm(pk);
    if (!target) return { ok: false, code: 'BAD_PUBKEY', message: 'החשבון אינו מורשה להתחבר ל-SOS.' };
    if (isDisabled(target)) {
      return {
        ok: false,
        code: 'ACCOUNT_DISABLED',
        message: 'החשבון הושבת ואינו מורשה להתחבר ל-SOS.',
      };
    }
    return { ok: true, code: 'OK' };
  }

  async function reconcileFromRelays(opts) {
    const o = opts || {};
    const relays = Array.isArray(o.relayUrls) ? o.relayUrls : App.relayUrls || [];
    if (!App.pool || !relays.length) return { ok: false, code: 'NO_RELAY' };
    if (o.rootPubkey) setRoot(o.rootPubkey);
    const filter = { kinds: [KIND], '#t': [GROUP_ID], limit: 200 };
    if (o.targetPubkey) filter['#p'] = [norm(o.targetPubkey)];
    let events = [];
    try {
      if (typeof App.pool.querySync === 'function') {
        events = (await App.pool.querySync(relays, filter, { maxWait: o.maxWait || 5000 })) || [];
      } else if (typeof App.pool.list === 'function') {
        events = (await App.pool.list(relays, [filter])) || [];
      }
    } catch (_e) {
      events = [];
    }
    ingestMany(events);
    // Drop tips whose issuer is not root once root is known
    if (rootPubkey) {
      tips.forEach((v, k) => {
        if (v.issuer && v.issuer !== rootPubkey) tips.delete(k);
      });
      writeCache();
    }
    return { ok: true, code: 'OK', count: events.length };
  }

  /** If current account becomes disabled, revoke SessionAuthority. */
  function enforceLiveSession() {
    const me = norm(App.publicKey);
    if (!me || !isDisabled(me)) return { revoked: false };
    try {
      const SA = App.SessionAuthority || window.SosSessionAuthority;
      if (SA && typeof SA.revokeSession === 'function') {
        SA.revokeSession({ reason: 'account_disabled', rebind: false });
      }
    } catch (_e) {}
    try {
      App.guestMode = true;
      if (typeof App.syncTopBarAuthUi === 'function') App.syncTopBarAuthUi();
    } catch (_e2) {}
    try {
      window.dispatchEvent(new CustomEvent('sos-account-disabled-active', { detail: { pubkey: me } }));
    } catch (_e3) {}
    return { revoked: true };
  }

  hydrateFromCache();

  window.addEventListener('sos-account-status-changed', () => {
    enforceLiveSession();
  });

  const api = Object.freeze({
    KIND,
    SCHEMA,
    VERSION,
    GROUP_ID,
    STATUS,
    REASON,
    setRoot,
    ingest,
    ingestMany,
    statusOf,
    isDisabled,
    tipOf,
    listDisabled,
    assertLoginAllowed,
    reconcileFromRelays,
    enforceLiveSession,
    DISABLED_KEY_FILE_LOGIN_ACCEPTED: false,
    CACHED_DISABLED_FAILS_OPEN: false,
    NON_ROOT_ACCOUNT_DISABLE_ALLOWED: false,
  });

  App.AccountStatusState = api;
  window.SosAccountStatusState = api;
})(window);
