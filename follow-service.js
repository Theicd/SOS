/* __F2B_AWAIT_WRAPPED__ */
;(function initFollowService(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  // חלק ניהול עוקבים (follow-service.js) – הגדרת kind ייעודי ושמירתו ב-App לשימוש מודולים אחרים
  const FOLLOW_KIND = 40010;
  App.FOLLOW_KIND = FOLLOW_KIND;
  // חלק מצב פנימי (follow-service.js) – שומר מבני נתונים לרשימות עוקבים והקשרים בין מאזינים
  const followState = {
    followersByTarget: new Map(),
    callbacksByTarget: new Map(),
    followerSubscriptions: new Map(),
    pendingTargets: new Set(),
    // target -> { action, created_at, eventId } של הצופה הנוכחי בלבד; unfollow נשמר כ-tombstone | HYPER CORE TECH
    followingByTarget: new Map(),
    viewer: '',
    generation: 0,
    restorePromise: null,
    restoreSettled: false,
    restored: false,
    pendingPersist: false,
    relayPromise: null,
    relayLoaded: false,
    relayRetryAt: 0,
    relayAttempts: 0,
    batch: null,
    syncing: false,
  };
  const STORAGE_PREFIX = 'nostr_following_';
  const RELAY_QUERY_MAX_WAIT_MS = 6000;
  const RELAY_RETRY_DELAYS_MS = [5000, 15000, 45000];
  const VIEWER_WATCH_INTERVAL_MS = 1500;
  const MAX_TIMESTAMP_BUMP_SEC = 5;
  let relayRetryTimer = null;

  // חלק IndexedDB Cache (follow-service.js) – שמירת follow state ב-IndexedDB למניעת פניות מיותרות לריליי | HYPER CORE TECH
  const FOLLOW_DB_NAME = 'SOS2FollowCache';
  const FOLLOW_DB_VERSION = 1;
  const FOLLOW_STORE_NAME = 'followState';
  let followDB = null;

  async function openFollowDB() {
    if (followDB) return followDB;
    if (typeof indexedDB === 'undefined' || !indexedDB) return null;
    return new Promise((resolve) => {
      try {
        const request = indexedDB.open(FOLLOW_DB_NAME, FOLLOW_DB_VERSION);
        request.onerror = () => resolve(null);
        request.onsuccess = () => {
          followDB = request.result;
          resolve(followDB);
        };
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(FOLLOW_STORE_NAME)) {
            db.createObjectStore(FOLLOW_STORE_NAME, { keyPath: 'pubkey' });
          }
        };
      } catch (err) {
        console.warn('Follow service: failed to open IndexedDB', err);
        resolve(null);
      }
    });
  }

  async function writeFollowRecordToIndexedDB(record) {
    const db = await openFollowDB();
    if (!db) return;
    try {
      const tx = db.transaction([FOLLOW_STORE_NAME], 'readwrite');
      tx.objectStore(FOLLOW_STORE_NAME).put(record);
    } catch (err) {
      console.warn('Follow service: failed to persist to IndexedDB', err);
    }
  }

  async function readFollowRecordFromIndexedDB(viewer) {
    const db = await openFollowDB();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction([FOLLOW_STORE_NAME], 'readonly');
        const request = tx.objectStore(FOLLOW_STORE_NAME).get(viewer);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
      } catch (err) {
        console.warn('Follow service: failed to restore from IndexedDB', err);
        resolve(null);
      }
    });
  }

  // חלק מטא-דאטה (follow-service.js) – מספק פונקציית גיבוי לשליפת פרופילים עבור דפי פרופיל ו-Follow
  async function fetchProfileFallback(pubkey) {
    const normalized = normalizePubkey(pubkey);
    if (!normalized) {
      return {
        name: 'משתמש אנונימי',
        bio: '',
        picture: '',
        initials: 'AN',
      };
    }
    if (!(App.profileCache instanceof Map)) {
      App.profileCache = new Map();
    }
    const fallback = {
      name: `משתמש ${normalized.slice(0, 8)}`,
      bio: '',
      picture: '',
      initials: typeof App.getInitials === 'function' ? App.getInitials(normalized) : normalized.slice(0, 2).toUpperCase(),
    };
    const cached = App.profileCache.get(normalized);
    if (cached && (cached.picture || (cached.name && cached.name !== fallback.name))) {
      return cached;
    }
    if (!App.pool || !Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      return cached || fallback;
    }
    try {
      const filter = { kinds: [0], authors: [normalized] };
      let metadataEvent = null;
      if (typeof App.pool.querySync === 'function') {
        const list = await App.pool.querySync(App.relayUrls, filter, { maxWait: 4000 });
        (Array.isArray(list) ? list : []).forEach((ev) => {
          if (ev && (!metadataEvent || (ev.created_at || 0) > (metadataEvent.created_at || 0))) metadataEvent = ev;
        });
      } else if (typeof App.pool.get === 'function') {
        metadataEvent = await App.pool.get(App.relayUrls, filter);
      }
      if (metadataEvent?.content) {
        const parsed = JSON.parse(metadataEvent.content);
        const displayName = typeof parsed.display_name === 'string' ? parsed.display_name.trim() : '';
        const name = displayName || (parsed.name ? parsed.name.toString().trim() : fallback.name);
        const bio = parsed.about ? parsed.about.toString().trim() : '';
        const picture = parsed.picture ? parsed.picture.toString().trim() : '';
        const enriched = {
          name: name || fallback.name,
          bio,
          picture,
          initials: typeof App.getInitials === 'function' ? App.getInitials(name || normalized) : fallback.initials,
        };
        App.profileCache.set(normalized, enriched);
        return enriched;
      }
    } catch (err) {
      console.warn('Follow service: failed fetching profile metadata fallback', err);
    }
    return fallback;
  }

  if (typeof App.fetchProfile !== 'function') {
    App.fetchProfile = fetchProfileFallback;
  }

  function normalizePubkey(pubkey) {
    return typeof pubkey === 'string' ? pubkey.trim().toLowerCase() : '';
  }
  function getCurrentViewer() {
    const pubkey = normalizePubkey(App.publicKey);
    return /^[0-9a-f]{64}$/.test(pubkey) ? pubkey : '';
  }

  // חלק השוואת אירועים (follow-service.js) – האירוע החדש ביותר מנצח; בשוויון זמן – מזהה אירוע דטרמיניסטי | HYPER CORE TECH
  function isNewerEntry(candidate, existing) {
    if (!existing) return true;
    const candidateTs = candidate.created_at || 0;
    const existingTs = existing.created_at || 0;
    if (candidateTs !== existingTs) return candidateTs > existingTs;
    const candidateId = candidate.eventId || '';
    const existingId = existing.eventId || '';
    if (!candidateId) return false;
    if (!existingId) return true;
    return candidateId > existingId;
  }
  function isFollowingEntry(entry) {
    return !!entry && entry.action === 'follow';
  }
  function getPersistableEntry(entry) {
    return entry && entry.optimistic ? entry.previous || null : entry;
  }
  function getFollowingListInternal() {
    const list = [];
    followState.followingByTarget.forEach((entry, target) => {
      if (isFollowingEntry(entry)) list.push(target);
    });
    return list;
  }

  // חלק אירוע שינוי (follow-service.js) – התרעה אחת קנונית על שינוי מצב Follow | HYPER CORE TECH
  function dispatchFollowChanged(detail) {
    try {
      if (typeof window.dispatchEvent !== 'function' || typeof window.CustomEvent !== 'function') return;
      window.dispatchEvent(new window.CustomEvent('sos:follow-changed', { detail }));
    } catch (err) {
      console.warn('Follow service: follow-changed dispatch failed', err);
    }
  }

  function upsertFollowingEntry(target, entry, reason, options = {}) {
    const persist = options.persist !== false;
    const existing = followState.followingByTarget.get(target);
    if (!isNewerEntry(entry, existing)) return false;
    const wasFollowing = isFollowingEntry(existing);
    followState.followingByTarget.set(target, entry);
    const nowFollowing = isFollowingEntry(entry);
    const changed = wasFollowing !== nowFollowing;
    if (followState.batch) {
      if (persist) followState.batch.touched = true;
      if (changed) followState.batch.changed.set(target, nowFollowing);
      return true;
    }
    if (persist) persistFollowing();
    if (changed) {
      refreshFollowButtons();
      dispatchFollowChanged({ viewerPubkey: followState.viewer, targetPubkey: target, isFollowing: nowFollowing, reason });
    }
    return true;
  }

  function runFollowingBatch(reason, fn, options = {}) {
    const outer = followState.batch;
    const batch = { changed: new Map(), touched: false };
    followState.batch = batch;
    try {
      fn();
    } finally {
      followState.batch = outer;
    }
    if (outer) {
      batch.changed.forEach((value, key) => outer.changed.set(key, value));
      outer.touched = outer.touched || batch.touched;
      return batch;
    }
    if (batch.touched || options.forcePersist) persistFollowing();
    if (batch.changed.size) {
      refreshFollowButtons();
      if (batch.changed.size === 1) {
        const [[targetPubkey, isFollowing]] = Array.from(batch.changed.entries());
        dispatchFollowChanged({ viewerPubkey: followState.viewer, targetPubkey, isFollowing, reason });
      } else {
        dispatchFollowChanged({
          viewerPubkey: followState.viewer,
          targetPubkey: null,
          isFollowing: null,
          reason,
          changedTargets: Array.from(batch.changed.keys()),
        });
      }
    }
    return batch;
  }

  // חלק שמירה (follow-service.js) – נשמר רק אחרי שחזור הקאש, כדי שמצב חלקי לא ידרוס רשימה מלאה | HYPER CORE TECH
  function persistFollowing() {
    const viewer = followState.viewer;
    if (!viewer) return;
    if (!followState.restored) {
      followState.pendingPersist = true;
      return;
    }
    followState.pendingPersist = false;
    const following = [];
    const entries = [];
    followState.followingByTarget.forEach((rawEntry, target) => {
      const entry = getPersistableEntry(rawEntry);
      if (!entry) return;
      entries.push([target, entry.action, entry.created_at || 0, entry.eventId || '']);
      if (isFollowingEntry(entry)) following.push(target);
    });
    try {
      window.localStorage.setItem(`${STORAGE_PREFIX}${viewer}`, JSON.stringify(following));
    } catch (err) {
      console.warn('Follow service: failed storing following list', err);
    }
    // חלק IndexedDB (follow-service.js) – שמירה גם ב-IndexedDB | HYPER CORE TECH
    writeFollowRecordToIndexedDB({ pubkey: viewer, following, entries, format: 2, updatedAt: Date.now() });
  }

  function readLegacyLocalList(viewer) {
    try {
      const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${viewer}`);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.warn('Follow service: failed restoring following list', err);
      return [];
    }
  }

  // חלק שחזור (follow-service.js) – פורמט חדש (entries) + תאימות לרשימות pubkey ישנות | HYPER CORE TECH
  async function restoreFollowingFromStorage(viewer, generation) {
    let record = null;
    try {
      record = await readFollowRecordFromIndexedDB(viewer);
    } catch (_) {
      record = null;
    }
    if (generation !== followState.generation) return false;
    const localList = readLegacyLocalList(viewer);
    let restoredCount = 0;
    runFollowingBatch('restore', () => {
      if (record && Array.isArray(record.entries)) {
        record.entries.forEach((item) => {
          if (!Array.isArray(item)) return;
          const target = normalizePubkey(item[0]);
          if (!target) return;
          const entry = {
            action: item[1] === 'unfollow' ? 'unfollow' : 'follow',
            created_at: Number.isFinite(item[2]) ? item[2] : 0,
            eventId: typeof item[3] === 'string' ? item[3] : '',
          };
          if (upsertFollowingEntry(target, entry, 'restore', { persist: false })) restoredCount += 1;
        });
      }
      const legacy = [];
      if (record && Array.isArray(record.following)) legacy.push(...record.following);
      legacy.push(...localList);
      legacy.forEach((item) => {
        const target = normalizePubkey(item);
        if (!target) return;
        if (upsertFollowingEntry(target, { action: 'follow', created_at: 0, eventId: '' }, 'restore', { persist: false })) {
          restoredCount += 1;
        }
      });
    });
    followState.restored = true;
    if (followState.pendingPersist) persistFollowing();
    refreshFollowButtons();
    console.log('[Follow] Restored from cache:', restoredCount, 'entries');
    return true;
  }

  // חלק זהות (follow-service.js) – כל החלפת צופה מאפסת את המצב ומתחילה שחזור + ריליים מחדש | HYPER CORE TECH
  function syncViewer() {
    if (followState.syncing) return followState.viewer;
    const next = getCurrentViewer();
    if (next === followState.viewer) {
      if (next) ensureViewerLoaded();
      return next;
    }
    followState.syncing = true;
    try {
      const previous = followState.viewer;
      const previousFollowing = getFollowingListInternal();
      followState.generation += 1;
      followState.viewer = next;
      followState.followingByTarget = new Map();
      followState.pendingTargets.clear();
      followState.restorePromise = null;
      followState.restoreSettled = false;
      followState.restored = false;
      followState.pendingPersist = false;
      followState.relayPromise = null;
      followState.relayLoaded = false;
      followState.relayRetryAt = 0;
      followState.relayAttempts = 0;
      if (relayRetryTimer) {
        clearTimeout(relayRetryTimer);
        relayRetryTimer = null;
      }
      refreshFollowButtons();
      if (previous && previousFollowing.length) {
        dispatchFollowChanged({
          viewerPubkey: next,
          targetPubkey: null,
          isFollowing: null,
          reason: 'viewer-changed',
          changedTargets: previousFollowing,
        });
      }
    } finally {
      followState.syncing = false;
    }
    if (next) ensureViewerLoaded();
    return next;
  }

  function ensureViewerLoaded() {
    const viewer = followState.viewer;
    if (!viewer) return null;
    if (!followState.restorePromise) {
      const generation = followState.generation;
      followState.restorePromise = restoreFollowingFromStorage(viewer, generation)
        .catch((err) => {
          console.warn('Follow service: cache restore failed', err);
          return false;
        })
        .then(() => {
          if (generation !== followState.generation) return false;
          followState.restoreSettled = true;
          return loadFollowingFromRelays();
        });
      return followState.restorePromise;
    }
    if (
      followState.restoreSettled &&
      !followState.relayLoaded &&
      !followState.relayPromise &&
      Date.now() >= followState.relayRetryAt &&
      App.pool
    ) {
      loadFollowingFromRelays();
    }
    return followState.restorePromise;
  }

  function scheduleRelayRetry(generation) {
    const delay = RELAY_RETRY_DELAYS_MS[followState.relayAttempts];
    followState.relayAttempts += 1;
    if (relayRetryTimer) {
      clearTimeout(relayRetryTimer);
      relayRetryTimer = null;
    }
    if (delay === undefined) {
      followState.relayRetryAt = Number.POSITIVE_INFINITY;
      return;
    }
    followState.relayRetryAt = Date.now() + delay;
    relayRetryTimer = setTimeout(() => {
      relayRetryTimer = null;
      if (generation === followState.generation) loadFollowingFromRelays();
    }, delay + 10);
  }

  async function queryFollowEvents(pool, filter) {
    if (typeof pool.querySync === 'function') {
      const result = await pool.querySync(App.relayUrls, filter, { maxWait: RELAY_QUERY_MAX_WAIT_MS });
      if (Array.isArray(result)) return result;
      if (result && Array.isArray(result.events)) return result.events;
      return [];
    }
    if (typeof pool.list === 'function') {
      return (await pool.list(App.relayUrls, [filter])) || [];
    }
    if (typeof pool.listMany === 'function') {
      return (await pool.listMany(App.relayUrls, [filter])) || [];
    }
    throw new Error('Follow service: pool has no query method');
  }

  // חלק ריליים (follow-service.js) – שליפת "אחרי מי אני עוקב" דרך querySync; מסומן כנטען רק אחרי הצלחה | HYPER CORE TECH
  async function loadFollowingFromRelays() {
    const viewer = followState.viewer;
    if (!viewer || !followState.restoreSettled) return false;
    if (followState.relayLoaded) return true;
    if (followState.relayPromise) return followState.relayPromise;
    if (Date.now() < followState.relayRetryAt) return false;
    const pool = App.pool;
    if (!pool || !Array.isArray(App.relayUrls) || App.relayUrls.length === 0) return false;
    const generation = followState.generation;
    const filter = { kinds: [FOLLOW_KIND], authors: [viewer], limit: 400 };
    if (App.NETWORK_TAG) {
      filter['#t'] = [App.NETWORK_TAG];
    }
    const run = (async () => {
      let events;
      try {
        events = await queryFollowEvents(pool, filter);
      } catch (err) {
        console.warn('Follow service: failed loading following from relays', err);
        if (generation === followState.generation) scheduleRelayRetry(generation);
        return false;
      }
      if (generation !== followState.generation) return false;
      const list = (Array.isArray(events) ? events : []).filter(Boolean);
      if (list.length === 0) {
        scheduleRelayRetry(generation);
        return false;
      }
      const changedEvents = [];
      runFollowingBatch('relay', () => {
        list.forEach((event) => {
          if (applyFollowEvent(event)) changedEvents.push(event);
        });
      }, { forcePersist: true });
      followState.relayLoaded = true;
      followState.relayAttempts = 0;
      followState.relayRetryAt = 0;
      // חלק התרעות עוקב (follow-service.js) – יצירת התרעה גם בטעינה ההתחלתית של עוקבים
      if (typeof App.handleNotificationForFollow === 'function') {
        changedEvents.forEach((event) => App.handleNotificationForFollow(event));
      }
      return true;
    })();
    followState.relayPromise = run;
    try {
      return await run;
    } finally {
      if (followState.relayPromise === run) followState.relayPromise = null;
    }
  }

  function parseFollowAction(content) {
    if (typeof content === 'string') {
      const trimmed = content.trim();
      if (!trimmed) {
        return 'follow';
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.type === 'string') {
          return parsed.type === 'unfollow' ? 'unfollow' : 'follow';
        }
      } catch (err) {
        const lowered = trimmed.toLowerCase();
        if (lowered === 'unfollow' || lowered === 'remove') {
          return 'unfollow';
        }
      }
      const lowered = trimmed.toLowerCase();
      if (lowered === 'unfollow' || lowered === 'remove') {
        return 'unfollow';
      }
    } else if (content && typeof content === 'object') {
      const type = content.type ? String(content.type).toLowerCase() : '';
      if (type === 'unfollow') {
        return 'unfollow';
      }
    }
    return 'follow';
  }
  function extractTarget(tags) {
    if (!Array.isArray(tags)) return '';
    for (const tag of tags) {
      if (!Array.isArray(tag)) continue;
      if (tag[0] === 'p' && typeof tag[1] === 'string' && tag[1]) return normalizePubkey(tag[1]);
    }
    return '';
  }
  function getFollowersMap(target) {
    const normalized = normalizePubkey(target);
    if (!normalized) return null;
    if (!followState.followersByTarget.has(normalized)) followState.followersByTarget.set(normalized, new Map());
    return followState.followersByTarget.get(normalized);
  }
  function getFollowersSnapshot(target) {
    const map = getFollowersMap(target);
    if (!map) return [];
    return Array.from(map.values())
      .filter((entry) => entry.action === 'follow')
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      .map((entry) => ({
        pubkey: entry.pubkey,
        created_at: entry.created_at,
        name: entry.name || '',
        picture: entry.picture || '',
      }));
  }
  function notifyFollowers(target) {
    const normalized = normalizePubkey(target);
    if (!normalized) return;
    const callbacks = followState.callbacksByTarget.get(normalized);
    if (!Array.isArray(callbacks) || callbacks.length === 0) return;
    const snapshot = getFollowersSnapshot(normalized);
    callbacks.forEach((callback) => {
      try {
        callback(snapshot);
      } catch (err) {
        console.warn('Follow service: follower callback failed', err);
      }
    });
  }
  function refreshFollowButtons(root) {
    if (!followState.syncing) syncViewer();
    const scope = typeof Element !== 'undefined' && root instanceof Element ? root : document;
    const buttons = scope.querySelectorAll('[data-follow-button]');
    buttons.forEach((button) => {
      const target = normalizePubkey(button.getAttribute('data-follow-button'));
      if (!target) {
        button.disabled = true;
        return;
      }
      const isSelf = target && target === normalizePubkey(App.publicKey);
      const isFollowing = isFollowingEntry(followState.followingByTarget.get(target));
      const isPending = followState.pendingTargets.has(target);
      button.disabled = isSelf || isPending || !App.publicKey || !App.SosCryptoSigner?.hasIdentityKey();
      button.classList.toggle('is-following', isFollowing);
      button.setAttribute('aria-pressed', isFollowing ? 'true' : 'false');
      const icon = button.querySelector('i');
      // לא לשנות אייקון לכפתור videos-follow-button - הוא תמיד פלוס בלבד
      if (icon && !button.classList.contains('videos-follow-button')) {
        icon.classList.toggle('fa-user-minus', isFollowing);
        icon.classList.toggle('fa-user-plus', !isFollowing);
      }
      // עדכון אייקון וי/פלוס לכפתור וידאו
      const videoIcon = button.querySelector('.videos-follow-icon');
      if (videoIcon) {
        videoIcon.textContent = isFollowing ? '✓' : '+';
      }
      const label = button.querySelector('span[data-follow-label]') || button.querySelector('span');
      if (label) {
        label.textContent = isFollowing ? 'עוקב/ת' : 'עקוב';
      }
    });
  }
  // חלק החלת אירוע (follow-service.js) – מתעלם מאירועים ישנים; unfollow נשמר כ-tombstone גם ברשימת העוקבים | HYPER CORE TECH
  function applyFollowEvent(event) {
    if (!event || event.kind !== FOLLOW_KIND) return false;
    const target = extractTarget(event.tags);
    if (!target) return false;
    const actor = normalizePubkey(event.pubkey);
    if (!actor) return false;
    syncViewer();
    const action = parseFollowAction(event.content);
    let payloadName = '';
    let payloadPicture = '';
    try {
      const parsed = typeof event.content === 'string' && event.content.trim() ? JSON.parse(event.content) : null;
      if (parsed && typeof parsed === 'object') {
        if (parsed.name && typeof parsed.name === 'string') {
          payloadName = parsed.name.trim();
        }
        if (parsed.picture && typeof parsed.picture === 'string') {
          payloadPicture = parsed.picture.trim();
        }
      }
    } catch (err) {
      // המידע אינו חובה ולכן נתעלם משגיאת ניתוח
    }
    const createdAt = typeof event.created_at === 'number' ? event.created_at : Math.floor(Date.now() / 1000);
    const eventId = typeof event.id === 'string' ? event.id : '';
    const followersMap = getFollowersMap(target);
    if (!followersMap) {
      return false;
    }
    let followersChanged = false;
    if (isNewerEntry({ created_at: createdAt, eventId }, followersMap.get(actor))) {
      const enriched = { pubkey: actor, created_at: createdAt, eventId, action, raw: event };
      if (payloadName) {
        enriched.name = payloadName;
      }
      if (payloadPicture) {
        enriched.picture = payloadPicture;
      }
      followersMap.set(actor, enriched);
      followersChanged = true;
    }
    let followingChanged = false;
    if (actor === followState.viewer) {
      followingChanged = upsertFollowingEntry(target, { action, created_at: createdAt, eventId }, 'event');
    }
    if (followersChanged) {
      notifyFollowers(target);
    }
    return followersChanged || followingChanged;
  }
  function subscribeFollowers(targetPubkey, callback) {
    const target = normalizePubkey(targetPubkey);
    if (!target || typeof callback !== 'function') return () => {};
    if (!followState.callbacksByTarget.has(target)) followState.callbacksByTarget.set(target, []);
    const list = followState.callbacksByTarget.get(target);
    list.push(callback);
    callback(getFollowersSnapshot(target));

    if (!followState.followerSubscriptions.has(target) && App.pool && Array.isArray(App.relayUrls)) {
      const filter = { kinds: [FOLLOW_KIND], '#p': [target], limit: 400 };
      if (App.NETWORK_TAG) {
        filter['#t'] = [App.NETWORK_TAG];
      }
      const sub = App.pool.subscribeMany(App.relayUrls, [filter], {
        onevent(event) {
          const changed = applyFollowEvent(event);
          if (!changed) return;
          // חלק התרעות עוקב (follow-service.js) – יצירת התרעה כאשר משתמש חדש מתחיל לעקוב אחרינו
          if (typeof App.handleNotificationForFollow === 'function') {
            App.handleNotificationForFollow(event);
          }
        },
      });
      followState.followerSubscriptions.set(target, sub);
    }

    return () => {
      const callbacks = followState.callbacksByTarget.get(target);
      if (Array.isArray(callbacks)) {
        const index = callbacks.indexOf(callback);
        if (index >= 0) {
          callbacks.splice(index, 1);
        }
      }
      if (callbacks && callbacks.length === 0) {
        followState.callbacksByTarget.delete(target);
        const sub = followState.followerSubscriptions.get(target);
        if (sub && typeof sub.close === 'function') {
          try {
            sub.close();
          } catch (err) {
            console.warn('Follow service: failed closing follower subscription', err);
          }
        }
        followState.followerSubscriptions.delete(target);
      }
    };
  }

  function restoreFollowingEntry(target, entry) {
    if (entry) {
      followState.followingByTarget.set(target, entry);
    } else {
      followState.followingByTarget.delete(target);
    }
  }

  async function toggleFollow(targetPubkey, meta = {}) {
    const target = normalizePubkey(targetPubkey);
    const current = syncViewer();
    if (!target || !current || !App.pool || !App.SosCryptoSigner?.hasIdentityKey() || typeof App.SosCryptoSigner.signFollowEvent !== 'function') {
      console.warn('Follow service: missing prerequisites for toggle');
      return;
    }
    if (target === current) return;
    if (followState.pendingTargets.has(target)) return;
    const generation = followState.generation;
    const previousEntry = followState.followingByTarget.get(target) || null;
    const following = isFollowingEntry(previousEntry);
    const nowSec = Math.floor(Date.now() / 1000);
    const previousTs = previousEntry ? previousEntry.created_at || 0 : 0;
    // אירוע חדש חייב להיות מאוחר מהקודם, גם בלחיצות מהירות באותה שנייה
    const createdAt = previousTs >= nowSec && previousTs - nowSec < MAX_TIMESTAMP_BUMP_SEC ? previousTs + 1 : nowSec;
    const optimisticEntry = {
      action: following ? 'unfollow' : 'follow',
      created_at: createdAt,
      eventId: '',
      optimistic: true,
      previous: getPersistableEntry(previousEntry),
    };
    followState.pendingTargets.add(target);
    followState.followingByTarget.set(target, optimisticEntry);
    refreshFollowButtons();
    try {
      const normalizedMetaName = typeof meta.name === 'string' ? meta.name.trim() : '';
      const normalizedMetaPicture = typeof meta.picture === 'string' ? meta.picture.trim() : '';
      let fallbackName = '';
      let fallbackPicture = '';
      if (App.profile && typeof App.profile === 'object') {
        fallbackName = typeof App.profile.name === 'string' ? App.profile.name.trim() : fallbackName;
        fallbackPicture = typeof App.profile.picture === 'string' ? App.profile.picture.trim() : fallbackPicture;
      }
      if ((!fallbackName || !fallbackPicture) && App.profileCache instanceof Map) {
        const selfCached = App.profileCache.get(current) || App.profileCache.get(App.publicKey) || null;
        if (selfCached) {
          if (!fallbackName && typeof selfCached.name === 'string') {
            fallbackName = selfCached.name.trim();
          }
          if (!fallbackPicture && typeof selfCached.picture === 'string') {
            fallbackPicture = selfCached.picture.trim();
          }
        }
      }
      const payload = {
        type: following ? 'unfollow' : 'follow',
        ts: createdAt,
        name: normalizedMetaName || fallbackName || `משתמש ${current.slice(0, 8)}`,
        picture: normalizedMetaPicture || fallbackPicture || '',
      };
      const tags = [['p', target]];
      if (App.NETWORK_TAG) {
        tags.push(['t', App.NETWORK_TAG]);
      }
      const draft = {
        kind: FOLLOW_KIND,
        pubkey: App.publicKey,
        created_at: createdAt,
        tags,
        content: JSON.stringify(payload),
      };
      const event = await Promise.resolve(App.SosCryptoSigner.signFollowEvent(draft));
      await App.pool.publish(App.relayUrls, event);
      if (generation === followState.generation) {
        if (followState.followingByTarget.get(target) === optimisticEntry) {
          restoreFollowingEntry(target, previousEntry);
        }
        applyFollowEvent(event);
      }
    } catch (err) {
      console.error('Follow service: failed toggling follow state', err);
      if (generation === followState.generation && followState.followingByTarget.get(target) === optimisticEntry) {
        restoreFollowingEntry(target, previousEntry);
      }
      if (!following) {
        notifyFollowers(target);
      }
    } finally {
      if (generation === followState.generation) {
        followState.pendingTargets.delete(target);
      }
      refreshFollowButtons();
    }
  }
  function initializeFollowService() {
    syncViewer();
  }
  const previousNotifyPoolReady = App.notifyPoolReady;
  App.notifyPoolReady = function followNotifyBridge(pool) {
    if (typeof previousNotifyPoolReady === 'function') {
      try {
        previousNotifyPoolReady(pool);
      } catch (err) {
        console.warn('Follow service: previous notifyPoolReady failed', err);
      }
    }
    if (pool) {
      initializeFollowService();
    }
  };
  App.toggleFollow = toggleFollow;
  App.isFollowing = function isFollowing(targetPubkey) {
    syncViewer();
    return isFollowingEntry(followState.followingByTarget.get(normalizePubkey(targetPubkey)));
  };
  App.getFollowingList = function getFollowingList() {
    syncViewer();
    return getFollowingListInternal();
  };
  App.getFollowingSnapshot = function getFollowingSnapshot() {
    syncViewer();
    return {
      viewerPubkey: followState.viewer,
      restored: followState.restored,
      relayLoaded: followState.relayLoaded,
      entries: Array.from(followState.followingByTarget.entries()).map(([pubkey, entry]) => ({
        pubkey,
        action: entry.action,
        created_at: entry.created_at || 0,
        eventId: entry.eventId || '',
        optimistic: !!entry.optimistic,
      })),
    };
  };
  App.subscribeFollowers = subscribeFollowers;
  App.getFollowersSnapshot = getFollowersSnapshot;
  App.refreshFollowButtons = refreshFollowButtons;

  // חלק מחזור חיים (follow-service.js) – רצף אתחול יחיד; מאזין לטריגרי הזהות הקיימים ולשינוי pubkey מאוחר | HYPER CORE TECH
  initializeFollowService();
  try {
    window.addEventListener('sos-identity-ready', () => syncViewer());
  } catch (_) {}
  try {
    const identityReady = window.SOSIdentityStorageReady || (window.SOSKeyStorage && window.SOSKeyStorage.ready);
    if (identityReady && typeof identityReady.then === 'function') {
      identityReady.then(() => syncViewer(), () => {});
    }
  } catch (_) {}
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (followState.viewer && !followState.relayLoaded && !followState.relayPromise) {
        followState.relayAttempts = 0;
        followState.relayRetryAt = 0;
      }
      syncViewer();
    });
  } catch (_) {}
  if (typeof window.setInterval === 'function') {
    window.setInterval(() => syncViewer(), VIEWER_WATCH_INTERVAL_MS);
  }

  if (!window.__sosFollowDelegationAttached) {
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-follow-button]');
      if (!button || button.disabled) {
        return;
      }
      const targetPubkey = normalizePubkey(button.getAttribute('data-follow-button'));
      if (!targetPubkey || typeof App.toggleFollow !== 'function') {
        return;
      }
      event.preventDefault();
      const normalizedSelf = normalizePubkey(App.publicKey);
      const cachedSelf = normalizedSelf && App.profileCache instanceof Map ? App.profileCache.get(normalizedSelf) : null;
      const meta = {
        name:
          (App.profile && typeof App.profile.name === 'string' && App.profile.name.trim())
            ? App.profile.name.trim()
            : (cachedSelf && typeof cachedSelf.name === 'string' ? cachedSelf.name.trim() : ''),
        picture:
          (App.profile && typeof App.profile.picture === 'string' && App.profile.picture.trim())
            ? App.profile.picture.trim()
            : (cachedSelf && typeof cachedSelf.picture === 'string' ? cachedSelf.picture.trim() : ''),
      };
      try {
        button.blur();
      } catch (err) {
        console.debug('Follow button blur failed', err);
      }
      App.toggleFollow(targetPubkey, meta);
    });
    window.__sosFollowDelegationAttached = true;
  }
})(window);
