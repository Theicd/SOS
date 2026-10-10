/**
 * Directory hygiene (kind 39006): hide/restore identities from default management lists.
 * Not cryptographic deletion. Does not erase relay/Nostr history.
 * Parameterized-replaceable: d = groupId:targetPubkey:revision
 * Highest revision wins; ROOT issuer only.
 */
(function initDirectoryHygieneState(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const KIND = 39006;
  const SCHEMA = 'sos-directory-hygiene';
  const VERSION = 1;
  const GROUP_ID = 'israel-network';
  const CACHE_KEY = 'sos_directory_hygiene_v1';

  const VISIBILITY = Object.freeze({
    VISIBLE: 'VISIBLE',
    HIDDEN: 'HIDDEN',
  });

  /** targetPubkey -> tip */
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
          visibility: v.visibility,
          revision: v.revision,
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
      if (!pk || !row) return;
      if (row.visibility !== VISIBILITY.HIDDEN && row.visibility !== VISIBILITY.VISIBLE) return;
      const rev = Number(row.revision) || 0;
      if (rev < 1) return;
      const cur = tips.get(pk);
      if (!cur || rev > cur.revision) {
        tips.set(pk, {
          visibility: row.visibility,
          revision: rev,
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
    if (body.visibility !== VISIBILITY.HIDDEN && body.visibility !== VISIBILITY.VISIBLE) return null;
    const revision = Number(body.revision);
    if (!Number.isInteger(revision) || revision < 1) return null;
    return {
      targetPubkey: target,
      visibility: body.visibility,
      revision,
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
    const cur = tips.get(row.targetPubkey);
    if (cur && row.revision < cur.revision) return { ok: false, code: 'STALE' };
    tips.set(row.targetPubkey, row);
    writeCache();
    try {
      window.dispatchEvent(
        new CustomEvent('sos-directory-hygiene-changed', {
          detail: { targetPubkey: row.targetPubkey, visibility: row.visibility },
        })
      );
    } catch (_e) {}
    return { ok: true, code: 'APPLIED', tip: row };
  }

  function ingestMany(events) {
    (events || []).forEach((e) => ingest(e));
  }

  function isHidden(pk) {
    hydrateFromCache();
    const t = tips.get(norm(pk));
    return !!(t && t.visibility === VISIBILITY.HIDDEN);
  }

  function tipOf(pk) {
    return tips.get(norm(pk)) || null;
  }

  function listHidden() {
    const out = [];
    tips.forEach((v, k) => {
      if (v.visibility === VISIBILITY.HIDDEN) out.push(Object.assign({ targetPubkey: k }, v));
    });
    return out;
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
    if (rootPubkey) {
      tips.forEach((v, k) => {
        if (v.issuer && v.issuer !== rootPubkey) tips.delete(k);
      });
      writeCache();
    }
    return { ok: true, code: 'OK', count: events.length };
  }

  hydrateFromCache();

  const api = Object.freeze({
    KIND,
    SCHEMA,
    VERSION,
    GROUP_ID,
    VISIBILITY,
    setRoot,
    ingest,
    ingestMany,
    isHidden,
    tipOf,
    listHidden,
    reconcileFromRelays,
    CLAIMS_PHYSICAL_ERASURE: false,
    CRYPTOGRAPHIC_DELETION: false,
  });

  App.DirectoryHygieneState = api;
  window.SosDirectoryHygieneState = api;
})(window);
