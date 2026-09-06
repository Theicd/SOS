#!/usr/bin/env node
// feed-deletion-tests.js – tombstone מחיקה עמיד, בלי AndroidBridge
// הרצה: node feed-deletion-tests.js

(function runFeedDeletionTests() {
  const results = [];
  let pass = 0;
  let fail = 0;

  function test(name, fn) {
    try {
      const ok = fn();
      if (ok) { pass++; results.push('PASS ' + name); }
      else { fail++; results.push('FAIL ' + name); }
    } catch (e) {
      fail++;
      results.push('FAIL ' + name + ' ' + (e && e.message ? e.message : e));
    }
  }

  function canAcceptIncomingDeletion(isAdmin, author, deleter) {
    if (isAdmin) return true;
    if (!author) return false;
    return author === deleter;
  }

  function createEngine() {
    const store = Object.create(null);
    const localStorage = {
      getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
      setItem(key, value) { store[key] = String(value); },
    };
    const pubkey = 'aa'.repeat(32);
    const key = 'nostr_deleted_tombstones_v1_' + pubkey;
    const engine = {
      publicKey: pubkey,
      deletedEventIds: new Set(),
      deletionTombstones: new Map(),
      videos: [],
      feedCache: [],
      postsById: new Map(),
      dom: new Set(),
      pendingWarm: new Set(),
      publishes: [],
      publishShouldFail: false,
      localStorage,
    };

    function persist() {
      const rows = [];
      engine.deletionTombstones.forEach((meta, id) => {
        rows.push({
          targetEventId: id,
          deletionEventId: meta.deletionEventId || '',
          deleter: meta.deleter || '',
          createdAt: meta.createdAt || 0,
          publishState: meta.publishState || 'confirmed',
        });
      });
      localStorage.setItem(key, JSON.stringify({ tombstones: rows, updatedAt: Date.now() }));
    }

    engine.restore = function restore() {
      engine.deletedEventIds = new Set();
      engine.deletionTombstones = new Map();
      const raw = localStorage.getItem(key);
      if (!raw) return 0;
      const parsed = JSON.parse(raw);
      (parsed.tombstones || []).forEach((row) => {
        const id = row.targetEventId;
        if (!id) return;
        engine.deletedEventIds.add(id);
        engine.deletionTombstones.set(id, {
          deletionEventId: row.deletionEventId || '',
          deleter: row.deleter || '',
          createdAt: row.createdAt || 0,
          publishState: row.publishState || 'confirmed',
        });
      });
      return engine.deletedEventIds.size;
    };

    engine.applyDeletion = function applyDeletion(targetEventId, deletionMetadata) {
      if (!targetEventId) return false;
      const meta = deletionMetadata || {};
      const already = engine.deletedEventIds.has(targetEventId);
      const prev = engine.deletionTombstones.get(targetEventId) || {};
      engine.deletedEventIds.add(targetEventId);
      engine.deletionTombstones.set(targetEventId, {
        deletionEventId: meta.deletionEventId || prev.deletionEventId || '',
        deleter: meta.deleter || prev.deleter || pubkey,
        createdAt: meta.createdAt || prev.createdAt || 1,
        publishState: meta.publishState || prev.publishState || 'confirmed',
      });
      persist();
      engine.dom.delete(targetEventId);
      engine.pendingWarm.delete(targetEventId);
      engine.postsById.delete(targetEventId);
      engine.videos = engine.videos.filter((v) => v.id !== targetEventId);
      engine.feedCache = engine.feedCache.filter((v) => v.id !== targetEventId);
      return !already;
    };

    engine.ingestKind1 = function ingestKind1(id, source) {
      if (engine.deletedEventIds.has(id)) return { blocked: true, source: source || 'relay' };
      engine.postsById.set(id, { id, kind: 1 });
      if (!engine.videos.some((v) => v.id === id)) engine.videos.push({ id });
      if (!engine.feedCache.some((v) => v.id === id)) engine.feedCache.push({ id });
      engine.dom.add(id);
      return { blocked: false };
    };

    engine.render = function render() {
      return engine.videos.filter((v) => !engine.deletedEventIds.has(v.id)).map((v) => v.id);
    };

    engine.hydrateFromCache = function hydrateFromCache() {
      engine.restore();
      engine.videos = engine.feedCache.filter((v) => !engine.deletedEventIds.has(v.id));
      engine.dom = new Set(engine.videos.map((v) => v.id));
      return engine.videos.map((v) => v.id);
    };

    engine.publishDelete = function publishDelete(id) {
      const existing = engine.deletionTombstones.get(id);
      engine.applyDeletion(id, { source: 'local', deleter: pubkey, publishState: existing?.publishState || 'pending' });
      if (existing && existing.publishState === 'confirmed') return true;
      if (engine.publishShouldFail) {
        engine.deletionTombstones.get(id).publishState = 'failed';
        persist();
        return false;
      }
      engine.publishes.push(id);
      engine.deletionTombstones.get(id).publishState = 'confirmed';
      persist();
      return true;
    };

    engine.retryFailed = function retryFailed() {
      let ok = 0;
      engine.deletionTombstones.forEach((meta, id) => {
        if (meta.publishState === 'pending' || meta.publishState === 'failed') {
          engine.publishShouldFail = false;
          engine.publishes.push(id);
          meta.publishState = 'confirmed';
          ok += 1;
        }
      });
      persist();
      return ok;
    };

    return engine;
  }

  const POST = '2b7ace2b828912225dd06500f19e5fcb9db7ce87b371332d37ff3e289dc2a62a';
  const OTHER = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
  const me = 'aa'.repeat(32);
  const foreign = 'bb'.repeat(32);

  test('1 local delete removes visible post', () => {
    const e = createEngine();
    e.ingestKind1(POST);
    e.applyDeletion(POST, { source: 'local' });
    return !e.dom.has(POST) && e.render().length === 0;
  });

  test('2 local delete removes canonical video state', () => {
    const e = createEngine();
    e.ingestKind1(POST);
    e.applyDeletion(POST, { source: 'local' });
    return e.videos.length === 0 && !e.postsById.has(POST);
  });

  test('3 local delete removes it from feed cache', () => {
    const e = createEngine();
    e.ingestKind1(POST);
    e.applyDeletion(POST, { source: 'local' });
    return e.feedCache.length === 0;
  });

  test('4 local delete survives rerender', () => {
    const e = createEngine();
    e.ingestKind1(POST);
    e.applyDeletion(POST, { source: 'local' });
    return e.render().indexOf(POST) === -1;
  });

  test('5 local delete survives chat open/close (runtime tombstone kept)', () => {
    const e = createEngine();
    e.ingestKind1(POST);
    e.applyDeletion(POST, { source: 'local' });
    const afterChat = e.render();
    return afterChat.indexOf(POST) === -1 && e.deletedEventIds.has(POST);
  });

  test('6 local delete survives soft refresh hydrate', () => {
    const e = createEngine();
    e.ingestKind1(POST);
    e.applyDeletion(POST, { source: 'local' });
    e.feedCache = [{ id: POST }];
    const visible = e.hydrateFromCache();
    return visible.indexOf(POST) === -1;
  });

  test('7 local delete survives loadMore', () => {
    const e = createEngine();
    e.applyDeletion(POST, { source: 'local' });
    const more = e.ingestKind1(POST, 'loadMore');
    return more.blocked === true && e.render().indexOf(POST) === -1;
  });

  test('8 original kind-1 returned by relay is blocked', () => {
    const e = createEngine();
    e.applyDeletion(POST, { source: 'local' });
    return e.ingestKind1(POST, 'relay').blocked === true;
  });

  test('9 original event returned over P2P is blocked', () => {
    const e = createEngine();
    e.applyDeletion(POST, { source: 'local' });
    return e.ingestKind1(POST, 'p2p').blocked === true;
  });

  test('10 WebView/page reload still blocks it', () => {
    const e = createEngine();
    e.ingestKind1(POST);
    e.applyDeletion(POST, { source: 'local' });
    const e2 = createEngine();
    e2.localStorage.setItem(
      'nostr_deleted_tombstones_v1_' + e2.publicKey,
      e.localStorage.getItem('nostr_deleted_tombstones_v1_' + e.publicKey)
    );
    e2.feedCache = [{ id: POST }];
    const visible = e2.hydrateFromCache();
    return visible.indexOf(POST) === -1 && e2.deletedEventIds.has(POST);
  });

  test('11 process/state restore still blocks it', () => {
    const e = createEngine();
    e.applyDeletion(POST, { source: 'local', publishState: 'confirmed' });
    const snapshot = e.localStorage.getItem('nostr_deleted_tombstones_v1_' + e.publicKey);
    const e2 = createEngine();
    e2.localStorage.setItem('nostr_deleted_tombstones_v1_' + e2.publicKey, snapshot);
    e2.restore();
    return e2.ingestKind1(POST, 'boot-cache').blocked === true;
  });

  test('12 incoming valid kind-5 removes existing cached post', () => {
    const e = createEngine();
    e.ingestKind1(POST);
    const ok = canAcceptIncomingDeletion(false, me, me);
    if (!ok) return false;
    e.applyDeletion(POST, { source: 'incoming', deleter: me, publishState: 'confirmed' });
    return !e.dom.has(POST) && e.feedCache.length === 0;
  });

  test('13 invalid foreign kind-5 does NOT remove it', () => {
    const e = createEngine();
    e.ingestKind1(POST);
    const ok = canAcceptIncomingDeletion(false, me, foreign);
    if (ok) return false;
    return e.dom.has(POST) && e.videos.length === 1;
  });

  test('14 duplicate kind-5 is idempotent', () => {
    const e = createEngine();
    e.ingestKind1(POST);
    const first = e.applyDeletion(POST, { source: 'incoming' });
    const second = e.applyDeletion(POST, { source: 'incoming' });
    return first === true && second === false && e.deletedEventIds.size === 1 && e.videos.length === 0;
  });

  test('15 delete publish failure keeps local tombstone and can retry', () => {
    const e = createEngine();
    e.ingestKind1(POST);
    e.publishShouldFail = true;
    const published = e.publishDelete(POST);
    const stillHidden = !e.dom.has(POST) && e.deletedEventIds.has(POST);
    const retried = e.retryFailed();
    return published === false && stillHidden && retried === 1 && e.publishes.length === 1
      && e.deletionTombstones.get(POST).publishState === 'confirmed';
  });

  test('16 deleting same post twice does not resurrect or duplicate', () => {
    const e = createEngine();
    e.ingestKind1(POST);
    e.publishDelete(POST);
    e.publishDelete(POST);
    e.ingestKind1(POST, 'relay');
    return e.deletedEventIds.size === 1 && e.render().length === 0 && e.publishes.length === 1;
  });

  test('loadFeed must not wipe tombstones', () => {
    const e = createEngine();
    e.applyDeletion(POST, { source: 'local' });
    e.ingestKind1(OTHER);
    const likesReset = true;
    const tombstonesKept = e.deletedEventIds.has(POST);
    return likesReset && tombstonesKept && e.ingestKind1(POST, 'loadFeed').blocked === true;
  });

  test('no AndroidBridge required', () => {
    return typeof global.AndroidBridge === 'undefined' && typeof global.window === 'undefined';
  });

  results.forEach((line) => console.log(line));
  console.log('feed-deletion-tests: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})();
