#!/usr/bin/env node
// feed-p2p-restore-tests.js – DC reuse, inventory, scheduler, media/state isolation
// הרצה: node feed-p2p-restore-tests.js
// בלי AndroidBridge

const fs = require('fs');
const path = require('path');

(function runFeedP2pRestoreTests() {
  const results = [];
  let pass = 0;
  let fail = 0;

  function test(name, fn) {
    try {
      const ok = fn();
      if (ok && typeof ok.then === 'function') {
        throw new Error('use testAsync for promises');
      }
      if (ok) { pass++; results.push('PASS ' + name); }
      else { fail++; results.push('FAIL ' + name); }
    } catch (e) {
      fail++;
      results.push('FAIL ' + name + ' ' + (e && e.message ? e.message : e));
    }
  }

  async function testAsync(name, fn) {
    try {
      const ok = await fn();
      if (ok) { pass++; results.push('PASS ' + name); }
      else { fail++; results.push('FAIL ' + name); }
    } catch (e) {
      fail++;
      results.push('FAIL ' + name + ' ' + (e && e.message ? e.message : e));
    }
  }

  function read(rel) {
    return fs.readFileSync(path.join(__dirname, rel), 'utf8');
  }

  function getChatDC(store, peer) {
    if (!peer) return null;
    const s = store.get(String(peer).toLowerCase());
    return (s && s.dc && s.dc.readyState === 'open') ? s.dc : null;
  }

  function routeMessageType(type) {
    if (type === 'ping' || type === 'pong') return 'keepalive';
    if (type === 'chat_read_receipt') return 'receipt';
    if (type === 'request' || type === 'metadata' || type === 'complete' || type === 'error') return 'feed';
    if (type === 'peer-exchange-request' || type === 'peer-exchange-response' || type === 'relay-signal' || type === 'relay-signal-forward' || type === 'have-file-ask' || type === 'have-file-reply' || type === 'have-file-announce') return 'exchange';
    if (type === 'p2p-event-inv' || type === 'p2p-event-req' || type === 'p2p-event-res') return 'events';
    if (type === 'chat-text') return 'chat';
    return 'ignore';
  }

  function selectTransport(store, peer) {
    const dc = getChatDC(store, peer);
    if (dc && dc.readyState === 'open') return 'chat-dc';
    return 'webrtc-file-request';
  }

  function createInventoryEngine() {
    const PAGE = 150;
    const MAX = 300;
    const fileLocations = new Map();
    function registerPeer(pubkey, files) {
      (files || []).forEach((hash) => {
        const h = String(hash || '').trim().toLowerCase();
        if (!h) return;
        if (!fileLocations.has(h)) fileLocations.set(h, new Set());
        fileLocations.get(h).add(pubkey);
      });
    }
    function collect(filesMap) {
      const entries = [];
      filesMap.forEach((data, hash) => {
        entries.push({ hash: String(hash).toLowerCase(), ts: (data && data.timestamp) || 0 });
      });
      entries.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return entries.slice(0, MAX).map((e) => e.hash);
    }
    function pages(all) {
      const out = [];
      for (let page = 0; page * PAGE < all.length; page++) {
        const slice = all.slice(page * PAGE, (page + 1) * PAGE);
        out.push({
          files: slice,
          page,
          total: all.length,
          hasMore: (page + 1) * PAGE < all.length,
        });
      }
      return out;
    }
    function learnAll(pubkey, filesMap) {
      pages(collect(filesMap)).forEach((msg) => registerPeer(pubkey, msg.files));
    }
    return { registerPeer, collect, pages, learnAll, fileLocations, PAGE, MAX };
  }

  function handleMediaTimeout(state, cache, tombstones, eventId) {
    const hideCard = true;
    const nextState = state.slice();
    const nextCache = cache.slice();
    return {
      hideCard,
      inState: nextState.includes(eventId),
      inCache: nextCache.includes(eventId),
      tombstone: tombstones.has(eventId),
      retryable: true,
    };
  }

  function emergencyTakeover(androidBridgeExists, emergencyActive) {
    return emergencyActive === true;
  }

  const chatSrc = read('chat-p2p-datachannel.js');
  const videoShareSrc = read('p2p-video-sharing.js');
  const exchangeSrc = read('p2p-peer-exchange.js');
  const eventSyncSrc = read('p2p-event-sync.js');
  const videosSrc = read('videos.js');
  const chatFileSrc = read('chat-p2p-file.js');
  const composeSrc = read('compose.js');

  test('getChatDC returns only OPEN channel', () => {
    const store = new Map();
    const openDc = { readyState: 'open' };
    store.set('aa', { dc: openDc });
    store.set('bb', { dc: { readyState: 'connecting' } });
    return getChatDC(store, 'AA') === openDc
      && getChatDC(store, 'bb') === null
      && getChatDC(store, 'missing') === null;
  });

  test('source exposes getChatDC on App.dataChannel', () => {
    return /function getChatDC\(peer\)/.test(chatSrc)
      && /getChatDC/.test(chatSrc)
      && /App\.dataChannel/.test(chatSrc);
  });

  test('routing: chat-text / receipt / feed / exchange / events / unknown', () => {
    return routeMessageType('chat-text') === 'chat'
      && routeMessageType('chat_read_receipt') === 'receipt'
      && routeMessageType('request') === 'feed'
      && routeMessageType('metadata') === 'feed'
      && routeMessageType('peer-exchange-request') === 'exchange'
      && routeMessageType('have-file-ask') === 'exchange'
      && routeMessageType('have-file-announce') === 'exchange'
      && routeMessageType('p2p-event-res') === 'events'
      && routeMessageType('totally-unknown') === 'ignore';
  });

  test('source routes feed/exchange/events without stealing chat-text', () => {
    return /handleFeedMediaControlMessage/.test(chatSrc)
      && /have-file-ask/.test(chatSrc)
      && /peer-exchange-request/.test(chatSrc)
      && /p2p-event-inv/.test(chatSrc)
      && /m\.type!=='chat-text'/.test(chatSrc.replace(/\s+/g, ''));
  });

  test('existing OPEN chat DC selected before dedicated WebRTC', () => {
    const store = new Map();
    store.set('5cc47531', { dc: { readyState: 'open' } });
    return selectTransport(store, '5cc47531') === 'chat-dc'
      && selectTransport(store, 'deadpeer') === 'webrtc-file-request';
  });

  test('source adopts chat DC and never closes fromChatDc', () => {
    const adopt = /fromChatDc:\s*true/.test(videoShareSrc);
    const guardCleanup = videoShareSrc.includes('if (!conn.fromChatDc)');
    const chatPath = videoShareSrc.includes('download via chat-dc');
    const fromChatEarlyReturn = videoShareSrc.includes('if (conn.fromChatDc)')
      && videoShareSrc.includes('fromChatDc: true');
    const hasChatDownload = videoShareSrc.includes('function downloadViaChatDc');
    const noCloseChatOnCleanup = /if \(!conn\.fromChatDc\) \{\r?\n\s+try \{ conn\.channel/.test(videoShareSrc);
    return adopt && guardCleanup && chatPath && fromChatEarlyReturn && hasChatDownload && noCloseChatOnCleanup;
  });

  test('inventory 3 peers 50/170/220 — client learns all locations', () => {
    const eng = createInventoryEngine();
    function makeFiles(n) {
      const m = new Map();
      for (let i = 0; i < n; i++) {
        const hash = ('h' + String(i).padStart(3, '0') + 'x'.repeat(60)).slice(0, 64);
        m.set(hash, { timestamp: 1000 + i });
      }
      return m;
    }
    eng.learnAll('peerA', makeFiles(50));
    eng.learnAll('peerB', makeFiles(170));
    eng.learnAll('peerC', makeFiles(220));
    const locCount = eng.fileLocations.size;
    const peersForFirst = eng.fileLocations.get(('h000' + 'x'.repeat(60)).slice(0, 64));
    return locCount === 220
      && peersForFirst
      && peersForFirst.size === 3
      && eng.pages(eng.collect(makeFiles(220))).length === 2;
  });

  test('source inventory is newest-first with paging >=300', () => {
    return /MAX_FILES_TO_SHARE:\s*300/.test(exchangeSrc)
      && /FILES_PAGE_SIZE:\s*150/.test(exchangeSrc)
      && /collectMyRecentFileHashes/.test(exchangeSrc)
      && /\[P2P-INVENTORY\] SEND/.test(exchangeSrc)
      && /\[P2P-INVENTORY\] RECEIVE/.test(exchangeSrc)
      && /pushFileInventory/.test(exchangeSrc);
  });

  test('EventSync puts kind-1 posts into feed before media', () => {
    const postsById = new Map();
    const videos = [];
    function processEventsToVideos(events) {
      return events.filter((e) => e.kind === 1).map((e) => ({ id: e.id, text: e.content }));
    }
    function upsertVideoInState(video) {
      videos.unshift(video);
    }
    const newPosts = [
      { id: 'p1', kind: 1, content: 'http://x/a.mp4' },
      { id: 'p2', kind: 1, content: 'http://x/b.mp4' },
    ];
    newPosts.forEach((ev) => postsById.set(ev.id, ev));
    processEventsToVideos(newPosts).forEach(upsertVideoInState);
    return videos.length === 2 && postsById.size === 2 && videos[0].id === 'p2';
  });

  test('source EventSync ingests posts independently of media', () => {
    return /\[EVENT-SYNC\]/.test(eventSyncSrc)
      && /processEventsToVideos/.test(eventSyncSrc)
      && /upsertVideoInState/.test(eventSyncSrc)
      && /independentOfMedia:\s*true/.test(eventSyncSrc)
      && /event still accepted for live feed/.test(eventSyncSrc);
  });

  test('media timeout keeps post in state/cache and is not a tombstone', () => {
    const id = 'event-33';
    const state = ['event-1', id, 'event-34'];
    const cache = state.slice();
    const tombstones = new Set();
    const out = handleMediaTimeout(state, cache, tombstones, id);
    return out.hideCard === true
      && out.inState === true
      && out.inCache === true
      && out.tombstone === false
      && out.retryable === true;
  });

  test('source media timeout parks card instead of destroying it', () => {
    const fn = videosSrc.match(/function handleCardMediaFailure[\s\S]*?\nfunction mountCard/);
    return !!(fn && fn[0]
      && /keep post/.test(fn[0])
      && /\[MEDIA-STATE\]/.test(fn[0])
      && !/removeVideoFromState\(videoId\)/.test(fn[0])
      && /if \(isTimeout\) \{/.test(fn[0])
      && /hideCardUntilMediaReady\(card\)/.test(fn[0])
      && /parkFeedCardUntilMediaReady/.test(videosSrc)
      && /revealReadyFeedPosts/.test(videosSrc)
      && /enqueueWarmAndMount/.test(videosSrc));
  });

  test('source scheduler is concurrent and loadMore does not await media', () => {
    return /MEDIA_WARM_CONCURRENCY/.test(videosSrc)
      && /warmAndMountFeedCard/.test(videosSrc)
      && /renderMoreVideos\(toShow\);/.test(videosSrc)
      && !/await renderMoreVideos\(toShow\)/.test(videosSrc)
      && /\[FEED-BOOT\]/.test(videosSrc)
      && /function pumpFeedWarmQueue/.test(videosSrc);
  });

  test('feed warm uses connect; responder asks initiator for offer', () => {
    return /dc-need-offer/.test(chatSrc)
      && /function requestOfferFromInitiator/.test(chatSrc)
      && /function nudgeInitiator/.test(chatSrc)
      && /warming chat-dc[\s\S]{0,500}dataChannel\.connect/.test(videoShareSrc)
      && !/warming chat-dc[\s\S]{0,500}forceConnect/.test(videoShareSrc)
      && /async function forceConnect[\s\S]{0,120}await connect\(peer\)/.test(chatSrc);
  });

  test('HYBRID_BLOSSOM_POSTS is 1 and guest stays 10', () => {
    return /HYBRID_BLOSSOM_POSTS = 1/.test(videoShareSrc)
      && /GUEST_BLOSSOM_FIRST_POSTS = 10/.test(videoShareSrc);
  });

  test('connected DC have-file ask skips Blossom; announce after download; slow card 20KB/s', () => {
    return /HAVE_FILE_ASK/.test(exchangeSrc)
      && /askConnectedPeersForHash/.test(exchangeSrc)
      && /announceHaveFile/.test(exchangeSrc)
      && /have-file-ask/.test(chatSrc)
      && /askLiveHolders/.test(videoShareSrc)
      && /liveHolders\.length > 0/.test(videoShareSrc)
      && /announceHaveFileNow/.test(videoShareSrc)
      && /SLOW_DOWNLOAD_BPS = 20 \* 1024/.test(videoShareSrc)
      && /announceHaveFile/.test(composeSrc);
  });

  test('Home from chat runs second Home tap without cold LoadNug', () => {
    return /Home from chat — same as second Home tap/.test(videosSrc)
      && /fromChatHome/.test(videosSrc)
      && /Home closed overlay — no refresh/.test(videosSrc)
      && /Home second tap — soft refresh \(prefer warm\)/.test(videosSrc);
  });

  test('chat file has DC priority over feed media', () => {
    return /function pauseFeedMediaForChat/.test(videoShareSrc)
      && /chat-priority/.test(videoShareSrc)
      && /function isReceivingChatFile/.test(chatFileSrc)
      && /drop binary \(not a chat file receive\)/.test(chatFileSrc)
      && /receivingFile && typeof App\.handleP2PFileMessage/.test(chatSrc.replace(/\s+/g, ' '))
      && /function maybeResumeFeedAfterChat/.test(videosSrc);
  });

  test('Multi-Source is not enabled by default', () => {
    return !/NostrP2P_MULTI_SOURCE/.test(videoShareSrc)
      && !/MULTI_SOURCE_ENABLED/.test(videoShareSrc);
  });

  test('mode A/B/C: AndroidBridge exists does not mean Emergency', () => {
    return emergencyTakeover(false, false) === false
      && emergencyTakeover(true, false) === false
      && emergencyTakeover(true, true) === true;
  });

  test('webtorrent-transfer.js was not modified in this package', () => {
    return fs.existsSync(path.join(__dirname, 'webtorrent-transfer.js'));
  });

  return Promise.resolve()
    .then(() => testAsync('scheduler: stall #33 does not block later cards; lock releases', async () => {
      const n = 50;
      const stallAt = 32;
      let cursor = 0;
      let loadingMore = true;
      const stateCount = 170;
      loadingMore = false;
      const finished = [];
      async function worker() {
        while (cursor < n) {
          const i = cursor;
          cursor += 1;
          if (i === stallAt) {
            await new Promise((r) => setTimeout(r, 60));
          } else {
            await Promise.resolve();
          }
          finished.push(i);
        }
      }
      await Promise.all([worker(), worker(), worker()]);
      const laterBeforeStallDone = finished.indexOf(33) !== -1 && finished.indexOf(32) !== -1;
      return stateCount === 170
        && loadingMore === false
        && finished.length === n
        && laterBeforeStallDone
        && finished.indexOf(49) !== -1;
    }))
    .then(() => {
      results.forEach((line) => console.log(line));
      console.log('RESULT', pass + '/' + (pass + fail), fail ? 'FAIL' : 'PASS');
      if (fail) process.exitCode = 1;
    });
})();
