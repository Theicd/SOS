/**
 * C0 — Multi-community scope foundation.
 * CommunityContext is the single source of truth for active Community metadata.
 * Authority = communityId/networkTag (immutable). slug/name are display/routing only.
 * Does NOT grant membership/admin/root. ACCESS_CONTROL_V2 remains caller-controlled.
 */
(function initCommunityContext(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});

  const SOS010 = Object.freeze({
    communityId: 'sos010',
    networkTag: 'israel-network',
    groupId: 'israel-network',
    slug: 'sos010',
    name: 'SOS010',
    logoRef: 'icons/sos-logo-mobile.png',
    description: 'רשת תקשורת גלובלית SOS010',
  });

  const DIRECTORY_STORAGE_KEY = 'sos-community-directory-v1';
  const ACTIVE_STORAGE_KEY = 'sos-active-community-id-v1';
  const FEED_SELECTION_STORAGE_KEY = 'sos-feed-community-selection-v1';

  /** @type {Map<string, object>} */
  const byCommunityId = new Map();
  /** @type {Map<string, object>} */
  const byNetworkTag = new Map();
  /** @type {Map<string, object>} */
  const bySlug = new Map();

  /** @type {object|null} */
  let active = null;

  /** Feed selection (communityIds) — independent of membership. */
  /** @type {string[]} */
  let feedSelection = ['sos010'];

  /** Listeners for atomic switch. */
  const listeners = new Set();

  function freezeMeta(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const communityId = String(raw.communityId || '').trim();
    const networkTag = String(raw.networkTag || raw.groupId || '').trim();
    const slug = String(raw.slug || communityId || '').trim().toLowerCase();
    const name = String(raw.name || communityId || '').trim() || communityId;
    if (!communityId || !networkTag) return null;
    return Object.freeze({
      communityId,
      networkTag,
      groupId: networkTag,
      slug,
      name,
      logoRef: raw.logoRef ? String(raw.logoRef) : '',
      description: raw.description ? String(raw.description) : '',
    });
  }

  function persistDirectory() {
    try {
      const rows = Array.from(byCommunityId.values())
        .filter((m) => m.communityId !== SOS010.communityId)
        .map((m) => ({
          communityId: m.communityId,
          networkTag: m.networkTag,
          groupId: m.groupId,
          slug: m.slug,
          name: m.name,
          logoRef: m.logoRef || '',
          description: m.description || '',
        }));
      window.localStorage.setItem(DIRECTORY_STORAGE_KEY, JSON.stringify(rows));
      if (active && active.communityId) {
        window.localStorage.setItem(ACTIVE_STORAGE_KEY, active.communityId);
      }
    } catch (_e) {}
  }

  function restoreDirectory() {
    try {
      const raw = window.localStorage.getItem(DIRECTORY_STORAGE_KEY);
      if (!raw) return;
      const rows = JSON.parse(raw);
      if (!Array.isArray(rows)) return;
      rows.forEach((row) => {
        try {
          register(row, { persist: false });
        } catch (_e) {}
      });
      const activeId = window.localStorage.getItem(ACTIVE_STORAGE_KEY);
      if (activeId && byCommunityId.has(activeId)) {
        setActive(activeId, { persist: false });
      }
    } catch (_e2) {}
  }

  function persistFeedSelection() {
    try {
      window.localStorage.setItem(FEED_SELECTION_STORAGE_KEY, JSON.stringify(feedSelection.slice()));
    } catch (_e) {}
  }

  function restoreFeedSelection() {
    try {
      const raw = window.localStorage.getItem(FEED_SELECTION_STORAGE_KEY);
      if (!raw) return;
      const rows = JSON.parse(raw);
      if (!Array.isArray(rows)) return;
      const cleaned = rows.map((x) => String(x || '').trim()).filter(Boolean);
      if (cleaned.length) feedSelection = cleaned;
    } catch (_e) {}
  }

  function register(meta, opts) {
    const m = freezeMeta(meta);
    if (!m) throw Object.assign(new Error('BAD_COMMUNITY_META'), { code: 'BAD_COMMUNITY_META' });
    // Immutability: refuse changing networkTag/communityId for existing ids
    const prev = byCommunityId.get(m.communityId);
    if (prev) {
      if (prev.networkTag !== m.networkTag) {
        throw Object.assign(new Error('COMMUNITY_ID_IMMUTABLE'), { code: 'COMMUNITY_ID_IMMUTABLE' });
      }
      // Allow display/logo refresh only via new object with same ids
    }
    const prevNet = byNetworkTag.get(m.networkTag);
    if (prevNet && prevNet.communityId !== m.communityId) {
      throw Object.assign(new Error('NETWORK_TAG_IMMUTABLE'), { code: 'NETWORK_TAG_COLLISION' });
    }
    byCommunityId.set(m.communityId, m);
    byNetworkTag.set(m.networkTag, m);
    bySlug.set(m.slug, m);
    if (!opts || opts.persist !== false) persistDirectory();
    return m;
  }

  /**
   * Update display metadata only (name/logo/description). Never mutates ids/tags.
   */
  function updateDisplayMeta(communityId, patch) {
    const prev = getByCommunityId(communityId);
    if (!prev) {
      throw Object.assign(new Error('UNKNOWN_COMMUNITY'), { code: 'UNKNOWN_COMMUNITY' });
    }
    const next = register(
      {
        communityId: prev.communityId,
        networkTag: prev.networkTag,
        groupId: prev.groupId,
        slug: prev.slug,
        name: patch && patch.name != null ? String(patch.name) : prev.name,
        logoRef: patch && patch.logoRef != null ? String(patch.logoRef) : prev.logoRef,
        description: patch && patch.description != null ? String(patch.description) : prev.description,
      },
      { persist: true }
    );
    if (active && active.communityId === next.communityId) {
      active = next;
      syncLegacyAmbient(next);
      try {
        window.dispatchEvent(
          new CustomEvent('sos-community-switch', {
            detail: { prev: snapshotFrom(prev), next: snapshot() },
          })
        );
      } catch (_e) {}
    }
    return next;
  }

  function getByCommunityId(id) {
    return byCommunityId.get(String(id || '').trim()) || null;
  }

  function getByNetworkTag(tag) {
    return byNetworkTag.get(String(tag || '').trim()) || null;
  }

  function getBySlug(slug) {
    return bySlug.get(String(slug || '').trim().toLowerCase()) || null;
  }

  function getActive() {
    return active;
  }

  function snapshot() {
    if (!active) return null;
    return snapshotFrom(active);
  }

  function syncLegacyAmbient(meta) {
    // Legacy mirror only — NOT authority source for AC/signer.
    try {
      App.NETWORK_TAG = meta.networkTag;
    } catch (_e) {}
  }

  function setActive(target, opts) {
    let meta = null;
    if (typeof target === 'string') {
      meta = getByCommunityId(target) || getByNetworkTag(target) || getBySlug(target);
    } else if (target && typeof target === 'object') {
      meta =
        getByCommunityId(target.communityId) ||
        getByNetworkTag(target.networkTag || target.groupId) ||
        (target.slug ? getBySlug(target.slug) : null);
      if (!meta && target.communityId && target.networkTag) {
        meta = register(target, { persist: false });
      }
    }
    if (!meta) {
      return { ok: false, code: 'UNKNOWN_COMMUNITY' };
    }
    const prev = active;
    active = meta;
    syncLegacyAmbient(meta);
    if (!opts || opts.persist !== false) persistDirectory();
    listeners.forEach((fn) => {
      try {
        fn({ prev: prev ? snapshotFrom(prev) : null, next: snapshot() });
      } catch (_e) {}
    });
    try {
      window.dispatchEvent(
        new CustomEvent('sos-community-switch', {
          detail: { prev: prev ? snapshotFrom(prev) : null, next: snapshot() },
        })
      );
    } catch (_e2) {}
    return { ok: true, community: snapshot() };
  }

  function snapshotFrom(meta) {
    return Object.freeze({
      communityId: meta.communityId,
      networkTag: meta.networkTag,
      groupId: meta.groupId,
      slug: meta.slug,
      name: meta.name,
      logoRef: meta.logoRef || '',
      description: meta.description || '',
    });
  }

  function getFeedSelection() {
    return feedSelection.slice();
  }

  /**
   * Set which communities appear in "הפיד שלי".
   * Does NOT join/leave membership.
   */
  function setFeedSelection(communityIds) {
    const next = [];
    const seen = new Set();
    (Array.isArray(communityIds) ? communityIds : []).forEach((id) => {
      const cid = String(id || '').trim();
      if (!cid || seen.has(cid)) return;
      if (!byCommunityId.has(cid) && cid !== SOS010.communityId) return;
      seen.add(cid);
      next.push(cid);
    });
    if (!next.length) next.push(SOS010.communityId);
    feedSelection = next;
    persistFeedSelection();
    try {
      window.dispatchEvent(
        new CustomEvent('sos-feed-selection-changed', {
          detail: { communityIds: feedSelection.slice() },
        })
      );
    } catch (_e) {}
    return feedSelection.slice();
  }

  function getSelectedNetworkTags() {
    return getFeedSelection()
      .map((id) => {
        const m = getByCommunityId(id);
        return m ? m.networkTag : id === SOS010.communityId ? SOS010.networkTag : '';
      })
      .filter(Boolean);
  }

  function isGlobalNetworkActive() {
    return !!(active && active.communityId === SOS010.communityId);
  }

  function onSwitch(fn) {
    if (typeof fn !== 'function') return function noop() {};
    listeners.add(fn);
    return function unsub() {
      listeners.delete(fn);
    };
  }

  /**
   * Resolve /c/<slug> path. Never grants authority.
   * @returns {{ ok: boolean, community?: object, code?: string }}
   */
  function resolveRoutePath(pathname) {
    const path = String(pathname || '');
    const m = path.match(/\/c\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?/);
    if (!m) return { ok: false, code: 'NOT_COMMUNITY_ROUTE' };
    const slug = m[1].toLowerCase();
    const community = getBySlug(slug);
    if (!community) return { ok: false, code: 'UNKNOWN_COMMUNITY_SLUG', slug };
    return { ok: true, community: snapshotFrom(community), grantsAuthority: false };
  }

  /** Apply route if present; fails safe without granting authority. */
  function applyDocumentRoute() {
    try {
      const res = resolveRoutePath(window.location && window.location.pathname);
      if (!res.ok) return res;
      // Setting active is metadata only — no membership/admin grant.
      return setActive(res.community.communityId);
    } catch (_e) {
      return { ok: false, code: 'ROUTE_APPLY_FAILED' };
    }
  }

  function listCommunities() {
    return Array.from(byCommunityId.values()).map(snapshotFrom);
  }

  function requireExplicitNetworkTag(explicit) {
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
    throw Object.assign(new Error('EXPLICIT_NETWORK_TAG_REQUIRED'), {
      code: 'EXPLICIT_NETWORK_TAG_REQUIRED',
    });
  }

  function resolveAuthorityNetworkTag(explicit) {
    // Authority path: explicit required. No ambient-only resolution.
    return requireExplicitNetworkTag(explicit);
  }

  function resolveActiveNetworkTag() {
    if (active && active.networkTag) return active.networkTag;
    if (typeof App.NETWORK_TAG === 'string' && App.NETWORK_TAG.trim()) return App.NETWORK_TAG.trim();
    return SOS010.networkTag;
  }

  // Boot defaults
  register(SOS010, { persist: false });
  restoreDirectory();
  restoreFeedSelection();
  if (!active) setActive(SOS010.communityId, { persist: false });

  const api = {
    SOS010,
    COMMUNITY_ID_IMMUTABLE: true,
    NETWORK_TAG_IMMUTABLE: true,
    GROUP_ID_EQUALS_AUTHORITY_NETWORK_TAG: true,
    SLUG_IS_AUTHORITY: false,
    DISPLAY_NAME_IS_AUTHORITY: false,
    AMBIENT_NETWORK_TAG_IS_AUTHORITY_SOURCE: false,
    COMMUNITY_ROUTE_CAN_GRANT_AUTHORITY: false,
    COMMUNITY_DIRECTORY_REMOTE_IMPLEMENTED: false,
    EXTERNAL_INTERACTION_ENABLED_IN_C0: false,
    EXTERNAL_BLOCKLIST_IMPLEMENTED: false,
    COMMUNITY_FOLLOW_IMPLEMENTED: false,
    COMMUNITY_BRIDGE_IMPLEMENTED: false,
    COMMUNITY_CREATION_IMPLEMENTED: true,
    COMMUNITY_CREATION_REQUIRES_RAW_PRIVATE_ADMIN_KEY: false,
    GLOBAL_IDENTITY_MODEL: 'single_P_across_communities',
    DIRECT_COMMUNICATION_REQUIRES_COMMUNITY_MEMBERSHIP: false,
    FEED_SELECTION_CHANGES_MEMBERSHIP: false,
    DIRECTORY_STORAGE_KEY,
    ACTIVE_STORAGE_KEY,
    FEED_SELECTION_STORAGE_KEY,
    register,
    updateDisplayMeta,
    getByCommunityId,
    getByNetworkTag,
    getBySlug,
    getActive,
    setActive,
    snapshot,
    onSwitch,
    listCommunities,
    getFeedSelection,
    setFeedSelection,
    getSelectedNetworkTags,
    isGlobalNetworkActive,
    persistDirectory,
    restoreDirectory,
    resolveRoutePath,
    applyDocumentRoute,
    requireExplicitNetworkTag,
    resolveAuthorityNetworkTag,
    resolveActiveNetworkTag,
  };

  Object.freeze(api);
  App.CommunityContext = api;
  window.SosCommunityContext = api;

  try {
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          applyDocumentRoute();
        });
      } else {
        applyDocumentRoute();
      }
    }
  } catch (_boot) {}
})(typeof window !== 'undefined' ? window : globalThis);
