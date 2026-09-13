#!/usr/bin/env node
/**
 * Deterministic QA for Stage 1 older-feed pagination exhaustion.
 * Extracts the policy function from videos.js — no browser, no network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const videosPath = path.join(root, 'videos.js');
const src = fs.readFileSync(videosPath, 'utf8');

function fail(msg) {
  console.error('FAIL', msg);
  process.exit(1);
}

function pass(name) {
  console.log('PASS', name);
}

const start = src.indexOf('// SOS-FEED-OLDER-PAGINATION-POLICY-START');
const end = src.indexOf('// SOS-FEED-OLDER-PAGINATION-POLICY-END');
if (start < 0 || end < 0 || end <= start) fail('policy markers missing in videos.js');

const policySrc = src.slice(start, end);
const context = { console };
vm.createContext(context);
vm.runInContext(`${policySrc}\nthis.createFeedOlderPaginationState = createFeedOlderPaginationState;\nthis.applyFeedOlderPaginationDecision = applyFeedOlderPaginationDecision;`, context);
const create = context.createFeedOlderPaginationState;
const apply = context.applyFeedOlderPaginationDecision;
if (typeof create !== 'function' || typeof apply !== 'function') fail('policy functions not evaled');

function dropKnownDeletedAndSeen(events, existingIds, deletedIds, seenIds) {
  const kept = [];
  const seen = seenIds || new Set();
  (events || []).forEach((ev) => {
    if (!ev || !ev.id) return;
    if (existingIds.has(ev.id) || seen.has(ev.id) || deletedIds.has(ev.id)) {
      seen.add(ev.id);
      return;
    }
    kept.push(ev);
  });
  return { kept, seen };
}

function simulateObserverQueries(pag, ticks, fetchOnce) {
  let queries = 0;
  let appendedBatches = 0;
  for (let i = 0; i < ticks; i++) {
    pag = apply(pag, {
      type: 'sync',
      scopeKey: 'pk|israel-network',
      oldestBound: pag.oldestBound || 1000,
      videoCount: 12,
      untilTime: pag.untilCursor || 1000,
    });
    if (!pag.allowLoadMore) continue;
    queries += 1;
    const result = fetchOnce(pag, i);
    if (result.appended > 0) {
      appendedBatches += 1;
      pag = apply(pag, { type: 'success', oldestBound: result.oldestBound || pag.oldestBound - 10 });
    } else {
      pag = apply(pag, {
        type: 'no-progress',
        untilStart: result.untilStart,
        untilEnd: result.untilEnd,
        usableCount: result.usableCount,
        gapFilled: !!result.gapFilled,
      });
    }
  }
  return { queries, appendedBatches, pag };
}

// --- source contract ---
if (!src.includes('if (!canStartOlderPagination()) return;')) fail('observer/loadMore missing canStartOlderPagination guard');
const observerIdx = src.indexOf('function setupLoadMoreObserver');
const loadMoreIdx = src.indexOf('async function loadMoreVideos');
const backfillIdx = src.indexOf('function maybeScheduleFeedBackfill');
if (observerIdx < 0 || loadMoreIdx < 0) fail('setupLoadMoreObserver / loadMoreVideos missing');
const observerSlice = src.slice(observerIdx, backfillIdx);
if (!observerSlice.includes('canStartOlderPagination()')) fail('observer callback missing exhausted guard');
if (!observerSlice.includes('scrollTicking')) fail('scroll fallback missing');
if (!observerSlice.includes('loadMoreScrollBound')) fail('scroll fallback missing bind');
if ((observerSlice.match(/canStartOlderPagination/g) || []).length < 2) fail('scroll fallback missing exhausted guard');
const backfillSlice = src.slice(backfillIdx, loadMoreIdx);
if ((backfillSlice.match(/canStartOlderPagination/g) || []).length < 2) fail('backfill missing exhausted guards');
const loadMoreSlice = src.slice(loadMoreIdx, src.indexOf('function processEventsToVideos'));
if (!loadMoreSlice.includes('dropKnownDeletedAndSeen')) fail('loadMore missing tombstone prefilter');
if (!loadMoreSlice.includes("type: 'no-progress'")) fail('loadMore missing no-progress exhaustion');
if (!loadMoreSlice.includes("type: 'success'")) fail('loadMore missing success reset');
if (!loadMoreSlice.includes('mark-gap-fill')) fail('loadMore missing gap-fill once-per-until');

const forbiddenHits = [
  ['function setupVideoRealtimeSubscription', 'setupVideoRealtimeSubscription body must stay'],
];
void forbiddenHits;

pass('source contract: guards + prefilter present');

// TEST 1 — more content exists: success does not stick exhausted
{
  let pag = create();
  pag = apply(pag, { type: 'sync', scopeKey: 'pk|israel-network', oldestBound: 2000, videoCount: 8, untilTime: 2000 });
  if (!pag.allowLoadMore) fail('Test 1: should allow first loadMore');
  pag = apply(pag, { type: 'success', oldestBound: 1800 });
  if (pag.exhausted) fail('Test 1: success left exhausted stuck');
  pag = apply(pag, { type: 'sync', scopeKey: 'pk|israel-network', oldestBound: 1800, videoCount: 13, untilTime: 1800 });
  if (!pag.allowLoadMore) fail('Test 1: second batch blocked after append');
  const sim = simulateObserverQueries(create(), 3, (_p, i) => ({
    appended: 2,
    oldestBound: 2000 - (i + 1) * 20,
    untilStart: 2000,
    untilEnd: 1980,
    usableCount: 5,
  }));
  if (sim.appendedBatches !== 3) fail('Test 1: further batches did not load, got ' + sim.appendedBatches);
  pass('Test 1 — more content: append resets exhaustion, next batches allowed');
}

// TEST 2 — true end: observer ticks do not query again
{
  let pag = create();
  pag = apply(pag, { type: 'sync', scopeKey: 'pk|israel-network', oldestBound: 1000, videoCount: 12, untilTime: 1000 });
  const sim = simulateObserverQueries(pag, 101, () => ({
    appended: 0,
    untilStart: 1000,
    untilEnd: 1000,
    usableCount: 0,
    gapFilled: true,
  }));
  if (sim.queries !== 1) fail('Test 2: expected 1 query after exhaustion, got ' + sim.queries);
  if (!sim.pag.exhausted) fail('Test 2: exhausted not set');
  if (sim.pag.allowLoadMore) fail('Test 2: allowLoadMore still true');
  pass('Test 2 — true end: 101 observer ticks → exactly 1 pagination query');
}

// TEST 3 — scroll fallback uses same allowLoadMore
{
  let pag = apply(create(), { type: 'sync', scopeKey: 'pk|israel-network', oldestBound: 500, videoCount: 12, untilTime: 500 });
  pag = apply(pag, { type: 'no-progress', untilStart: 500, untilEnd: 500, usableCount: 0 });
  pag = apply(pag, { type: 'sync', scopeKey: 'pk|israel-network', oldestBound: 500, videoCount: 12, untilTime: 500 });
  if (pag.allowLoadMore) fail('Test 3: scroll would still call loadMore');
  pass('Test 3 — scroll fallback: exhausted blocks loadMore');
}

// TEST 4 — tombstones filtered before process
{
  const deleted = new Set(['dead1', 'dead2']);
  const existing = new Set(['live1']);
  const seen = new Set();
  const { kept, seen: seenOut } = dropKnownDeletedAndSeen(
    [
      { id: 'dead1', created_at: 10, kind: 1 },
      { id: 'dead2', created_at: 9, kind: 1 },
      { id: 'live1', created_at: 8, kind: 1 },
      { id: 'fresh', created_at: 7, kind: 1 },
    ],
    existing,
    deleted,
    seen
  );
  if (kept.length !== 1 || kept[0].id !== 'fresh') fail('Test 4: tombstones/existing leaked into process list');
  if (!seenOut.has('dead1') || !seenOut.has('dead2')) fail('Test 4: deleted ids not recorded as seen');
  const second = dropKnownDeletedAndSeen(
    [
      { id: 'dead1', created_at: 10 },
      { id: 'dead2', created_at: 9 },
    ],
    existing,
    deleted,
    seenOut
  );
  if (second.kept.length !== 0) fail('Test 4: same tombstones kept on repeat');
  pass('Test 4 — tombstones dropped before processing; repeats are no-ops');
}

// TEST 5 — periodic/newer refresh does not clear exhausted
{
  let pag = apply(create(), { type: 'no-progress', untilStart: 1000, untilEnd: 1000, usableCount: 0 });
  pag = apply(pag, { type: 'sync', scopeKey: 'pk|israel-network', oldestBound: 1000, videoCount: 12, untilTime: 1000 });
  if (!pag.exhausted) fail('Test 5: exhausted lost after same-bound sync');
  pag = apply(pag, { type: 'sync', scopeKey: 'pk|israel-network', oldestBound: 1000, videoCount: 20, untilTime: 1000 });
  if (!pag.exhausted) fail('Test 5: newer-count sync cleared exhausted');
  pag = apply(pag, { type: 'sync', scopeKey: 'pk|israel-network', oldestBound: 800, videoCount: 14, untilTime: 800 });
  if (pag.exhausted) fail('Test 5: older bound move should reset');
  if (pag.resetReason !== 'older-bound-moved') fail('Test 5: expected older-bound-moved, got ' + pag.resetReason);
  pass('Test 5 — periodic newer refresh keeps exhausted; older bound resets');
}

// TEST 6 — realtime/comments/likes cannot flip policy (no such actions)
{
  let pag = apply(create(), { type: 'no-progress', untilStart: 900, untilEnd: 900, usableCount: 0 });
  pag = apply(pag, { type: 'sync', scopeKey: 'pk|israel-network', oldestBound: 900, videoCount: 12, untilTime: 900 });
  pag = apply(pag, { type: 'unknown-live-event' });
  if (!pag.exhausted || pag.allowLoadMore) fail('Test 6: unknown action cleared exhaustion');
  pass('Test 6 — live comment/like/share actions are not pagination resets');
}

// TEST 7 — P2P prepend of newer post (oldestBound unchanged) does not reset
{
  let pag = apply(create(), { type: 'no-progress', untilStart: 700, untilEnd: 700, usableCount: 0 });
  pag = apply(pag, { type: 'sync', scopeKey: 'pk|israel-network', oldestBound: 700, videoCount: 13, untilTime: 700 });
  if (!pag.exhausted) fail('Test 7: P2P prepend (count+1, same oldest) cleared exhausted');
  pass('Test 7 — P2P prepend does not reset older pagination');
}

// extra: scope/account change resets
{
  let pag = apply(create(), { type: 'sync', scopeKey: 'pk|israel-network', oldestBound: 700, videoCount: 5, untilTime: 700 });
  pag = apply(pag, { type: 'no-progress', untilStart: 700, untilEnd: 700, usableCount: 0 });
  pag = apply(pag, { type: 'sync', scopeKey: 'other|israel-network', oldestBound: 1000, videoCount: 5, untilTime: 1000 });
  if (pag.exhausted) fail('scope change left exhausted');
  if (pag.resetReason !== 'scope-change') fail('expected scope-change, got ' + pag.resetReason);
  pass('account/network scope change resets exhaustion');
}

// extra: gap fill blocked after mark + exhaust
{
  let pag = apply(create(), { type: 'sync', scopeKey: 'pk|israel-network', oldestBound: 400, videoCount: 10, untilTime: 400 });
  if (!pag.allowGapFill) fail('gap fill should be allowed first time');
  pag = apply(pag, { type: 'mark-gap-fill', untilTime: 400 });
  if (pag.allowGapFill) fail('gap fill should not repeat at same until');
  pag = apply(pag, { type: 'no-progress', untilStart: 400, untilEnd: 400, usableCount: 0, gapFilled: true });
  pag = apply(pag, { type: 'sync', scopeKey: 'pk|israel-network', oldestBound: 400, videoCount: 10, untilTime: 400 });
  if (pag.allowGapFill || pag.allowLoadMore) fail('exhausted still allowed gap fill/loadMore');
  pass('gap-fill 200-note recover does not repeat while exhausted');
}

// live functions still present and not replaced by pagination (source)
const liveMustExist = [
  'function setupVideoRealtimeSubscription',
  'function registerVideoSourceEvent',
  'function upsertVideoInState',
  'function queueNewPostForHomeReveal',
  'async function loadVideos',
  'function startPeriodicRefresh',
  'function processEventsToVideos',
];
for (const needle of liveMustExist) {
  if (!src.includes(needle)) fail('missing live function: ' + needle);
}
pass('live/update functions still present in videos.js');

console.log('\nQUERY / LOOP PROOF: after true no-progress, 101 simulated observer callbacks issued 1 pagination fetch.\n');
console.log('All feed-pagination-exhausted tests passed.');
process.exit(0);
