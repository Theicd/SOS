// חלק שידור חי (live-stream-ui.js) – Setup משדר + כרטיסי LIVE בפיד | HYPER CORE TECH
(function initLiveStreamUI(window){
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;

  const DISCOVERY_WINDOW_SEC = 6 * 60 * 60;
  const activeLives = new Map();

  let studio = null;
  let previewStream = null;
  let timerInterval = null;
  let liveStartedAt = 0;
  let liveSub = null;
  let confirmOpen = false;

  function shortKey(pk) {
    const s = String(pk || '');
    return s ? s.slice(0, 8) : '—';
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function stopPreviewTracks() {
    try {
      if (previewStream) {
        previewStream.getTracks().forEach((t) => {
          try { t.stop(); } catch (_) {}
        });
      }
    } catch (_) {}
    previewStream = null;
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    liveStartedAt = 0;
  }

  function closeStudio() {
    stopTimer();
    if (studio) {
      try { studio.remove(); } catch (_) {}
      studio = null;
    }
    try { doc.body.classList.remove('live-studio-open'); } catch (_) {}
    confirmOpen = false;
  }

  async function endBroadcastAndClose() {
    try {
      if (typeof App.live?.end === 'function') await App.live.end();
    } catch (_) {}
    stopPreviewTracks();
    closeStudio();
  }

  async function ensurePreviewCamera(videoEl) {
    if (previewStream && previewStream.getTracks().some((t) => t.readyState === 'live')) {
      if (videoEl) {
        videoEl.srcObject = previewStream;
        try { await videoEl.play(); } catch (_) {}
      }
      return previewStream;
    }
    stopPreviewTracks();
    previewStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: 'user',
        aspectRatio: { ideal: 9 / 16 },
        width: { ideal: 720 },
        height: { ideal: 1280 }
      }
    });
    if (videoEl) {
      videoEl.srcObject = previewStream;
      try { await videoEl.play(); } catch (_) {}
    }
    return previewStream;
  }

  function setStudioPhase(phase) {
    if (!studio) return;
    studio.dataset.phase = phase;
    const setup = studio.querySelector('[data-phase-panel="setup"]');
    const live = studio.querySelector('[data-phase-panel="live"]');
    if (setup) setup.hidden = phase !== 'setup';
    if (live) live.hidden = phase !== 'live';
  }

  function showConfirm(onYes) {
    if (!studio || confirmOpen) return;
    confirmOpen = true;
    const overlay = doc.createElement('div');
    overlay.className = 'live-studio__confirm';
    overlay.innerHTML = `
      <div class="live-studio__confirm-card" role="dialog" aria-modal="true" aria-label="אישור שידור חי">
        <h3>להתחיל שידור חי?</h3>
        <p>השידור יופיע בפיד למשתמשים אחרים. אפשר לעצור בכל רגע.</p>
        <div class="live-studio__confirm-actions">
          <button type="button" class="live-studio__btn live-studio__btn--ghost" data-confirm="no">ביטול</button>
          <button type="button" class="live-studio__btn live-studio__btn--primary" data-confirm="yes">התחל לשדר</button>
        </div>
      </div>`;
    studio.appendChild(overlay);
    overlay.querySelector('[data-confirm="no"]').addEventListener('click', () => {
      confirmOpen = false;
      try { overlay.remove(); } catch (_) {}
    });
    overlay.querySelector('[data-confirm="yes"]').addEventListener('click', async () => {
      confirmOpen = false;
      try { overlay.remove(); } catch (_) {}
      try { await onYes(); } catch (e) { console.warn('live start failed', e); }
    });
  }

  function startTimerUi() {
    stopTimer();
    liveStartedAt = Date.now();
    const el = studio && studio.querySelector('[data-live-timer]');
    const tick = () => {
      if (el) el.textContent = formatDuration(Date.now() - liveStartedAt);
    };
    tick();
    timerInterval = setInterval(tick, 1000);
  }

  async function beginBroadcastFromSetup() {
    if (!studio) return;
    const titleInput = studio.querySelector('#liveStudioTitle');
    const title = String(titleInput && titleInput.value || '').trim() || 'שידור חי';
    const previewVideo = studio.querySelector('#liveStudioPreview');
    const liveVideo = studio.querySelector('#liveStudioLiveVideo');
    const topicLive = studio.querySelector('[data-live-topic]');

    if (!previewStream) {
      await ensurePreviewCamera(previewVideo);
    }

    if (typeof App.live?.start !== 'function') {
      window.alert('שידור חי לא זמין כרגע');
      return;
    }

    // מעבירים את אותה מצלמה לליבה – בלי לפתוח מחדש | HYPER CORE TECH
    const streamForLive = previewStream;
    previewStream = null;

    await App.live.start({
      slug: 'live',
      title,
      stream: streamForLive
    });

    if (liveVideo && streamForLive) {
      liveVideo.srcObject = streamForLive;
      try { await liveVideo.play(); } catch (_) {}
    }
    if (topicLive) topicLive.textContent = title;
    setStudioPhase('live');
    startTimerUi();
  }

  function openSetupStudio() {
    closeStudio();
    stopPreviewTracks();

    studio = doc.createElement('div');
    studio.id = 'liveStudio';
    studio.className = 'live-studio';
    studio.dataset.phase = 'setup';
    studio.innerHTML = `
      <div class="live-studio__stage">
        <div class="live-studio__frame" data-aspect="9-16">
          <video id="liveStudioPreview" class="live-studio__video" autoplay muted playsinline></video>
          <video id="liveStudioLiveVideo" class="live-studio__video" autoplay muted playsinline hidden></video>
          <div class="live-studio__frame-label">9:16 · תצוגת מובייל</div>
        </div>
      </div>

      <header class="live-studio__top">
        <button type="button" class="live-studio__icon-btn" data-action="close" aria-label="סגור">
          <i class="fa-solid fa-xmark"></i>
        </button>
        <div class="live-studio__top-title">
          <span class="live-studio__badge">LIVE</span>
          <span>הכנת שידור</span>
        </div>
        <span class="live-studio__spacer"></span>
      </header>

      <section class="live-studio__panel" data-phase-panel="setup">
        <label class="live-studio__field">
          <span>נושא השידור</span>
          <input id="liveStudioTitle" type="text" maxlength="80" placeholder="על מה המשדרים מדברים?" autocomplete="off">
        </label>
        <p class="live-studio__hint">כוון את המצלמה למסגרת 9:16 — כך זה ייראה טוב לצופים במובייל.</p>
        <button type="button" class="live-studio__btn live-studio__btn--primary live-studio__btn--xl" data-action="request-start">
          התחל לשדר
        </button>
      </section>

      <section class="live-studio__panel live-studio__panel--live" data-phase-panel="live" hidden>
        <div class="live-studio__live-meta">
          <span class="live-studio__badge">LIVE</span>
          <strong data-live-topic>שידור חי</strong>
          <span class="live-studio__timer" data-live-timer>00:00</span>
          <span class="live-studio__viewers" data-live-viewers>1 צופה</span>
        </div>
        <button type="button" class="live-studio__btn live-studio__btn--danger live-studio__btn--xl" data-action="end">
          סיים שידור
        </button>
      </section>
    `;

    doc.body.appendChild(studio);
    doc.body.classList.add('live-studio-open');

    const previewVideo = studio.querySelector('#liveStudioPreview');
    const liveVideo = studio.querySelector('#liveStudioLiveVideo');

    studio.querySelector('[data-action="close"]').addEventListener('click', async () => {
      if (studio.dataset.phase === 'live') {
        await endBroadcastAndClose();
      } else {
        stopPreviewTracks();
        closeStudio();
      }
    });

    studio.querySelector('[data-action="request-start"]').addEventListener('click', () => {
      showConfirm(() => beginBroadcastFromSetup());
    });

    studio.querySelector('[data-action="end"]').addEventListener('click', () => {
      endBroadcastAndClose();
    });

    // סנכרון תצוגת preview/live לפי phase
    const syncVideos = () => {
      const phase = studio.dataset.phase;
      if (previewVideo) previewVideo.hidden = phase !== 'setup';
      if (liveVideo) liveVideo.hidden = phase !== 'live';
    };
    const obs = new MutationObserver(syncVideos);
    obs.observe(studio, { attributes: true, attributeFilter: ['data-phase'] });
    syncVideos();

    ensurePreviewCamera(previewVideo).catch((err) => {
      console.warn('live camera preview failed', err);
      window.alert('לא ניתן לפתוח את המצלמה לשידור חי');
      closeStudio();
    });
  }

  // API: התחלת שידור = דף Setup | HYPER CORE TECH
  App.openLiveBroadcast = function() {
    try {
      openSetupStudio();
    } catch (e) {
      console.warn('openLiveBroadcast failed', e);
    }
  };

  App.closeLiveStudio = function() {
    return endBroadcastAndClose();
  };

  App.onLiveLocalStream = function(stream) {
    if (!studio) return;
    const liveVideo = studio.querySelector('#liveStudioLiveVideo');
    if (liveVideo && stream) {
      liveVideo.srcObject = stream;
      liveVideo.play().catch(() => {});
    }
  };

  App.onLiveRemoteStream = function(stream) {
    try {
      const media = App._p2pLiveActiveMedia;
      if (!media) return;
      const videoEl = media.querySelector('video');
      if (!videoEl || !stream) return;
      videoEl.srcObject = stream;
      videoEl.muted = false;
      videoEl.play().catch(() => {
        videoEl.muted = true;
        videoEl.play().catch(() => {});
      });
      media.classList.add('videos-feed__media--ready');
      const hint = media.querySelector('.videos-p2p-live-hint');
      if (hint) hint.hidden = true;
    } catch (_) {}
  };

  App.onLiveStarted = function() {};
  App.onLiveEnded = function() {
    stopTimer();
    if (studio && studio.dataset.phase === 'live') closeStudio();
  };

  App.onLiveStatusUpdate = function(info) {
    if (!studio) return;
    const el = studio.querySelector('[data-live-viewers]');
    if (!el) return;
    const n = Math.max(1, Number(info && info.viewersApprox) || 1);
    el.textContent = n === 1 ? '1 צופה' : `${n} צופים`;
  };

  // מרכז צפייה = מעבר לכרטיסי LIVE בפיד (לא דף נפרד) | HYPER CORE TECH
  function openLiveWatchHub() {
    try {
      if (typeof App.closeLiveWatchHub === 'function') App.closeLiveWatchHub();
    } catch (_) {}
    const card = doc.querySelector('.videos-feed__media[data-media-type="p2p-live"]')?.closest('.videos-feed__card');
    if (card) {
      try {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (_) {}
      return;
    }
    // אין כרטיס עדיין – רומזים בלי toast פולשני | HYPER CORE TECH
    try {
      if (typeof App.showTransientFeedHint === 'function') {
        App.showTransientFeedHint('אין שידור חי בפיד כרגע — כשמישהו משדר הוא יופיע ככרטיס רגיל');
      }
    } catch (_) {}
  }

  function closeLiveWatchHub() {
    return true;
  }

  function isLiveWatchHubOpen() {
    return false;
  }

  App.openLiveWatchHub = openLiveWatchHub;
  App.closeLiveWatchHub = closeLiveWatchHub;
  App.isLiveWatchHubOpen = isLiveWatchHubOpen;

  function upsertFeedCard(room) {
    if (!room || !room.roomId || !room.owner) return;
    if (App.publicKey && room.owner.toLowerCase() === String(App.publicKey).toLowerCase()) return;

    activeLives.set(room.roomId, {
      owner: room.owner,
      slug: room.slug || 'live',
      roomId: room.roomId,
      title: room.title || 'שידור חי',
      viewersApprox: room.viewersApprox || 1,
      updatedAt: Date.now()
    });

    if (typeof App.upsertP2pLiveFeedCard === 'function') {
      App.upsertP2pLiveFeedCard(activeLives.get(room.roomId));
    }
  }

  async function subscribeLivePosts() {
    if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) {
      setTimeout(subscribeLivePosts, 700);
      return;
    }
    if (liveSub) return;
    const since = Math.floor(Date.now() / 1000) - DISCOVERY_WINDOW_SEC;
    try {
      liveSub = App.pool.subscribeMany(App.relayUrls, [{ kinds: [25051], since }], {
        onevent: onLiveDiscoveryEvent,
        oneose: () => {}
      });
    } catch (e) {
      console.warn('live discovery failed', e);
      setTimeout(() => { liveSub = null; subscribeLivePosts(); }, 1500);
    }
  }

  function onLiveDiscoveryEvent(ev) {
    try {
      const tType = ev.tags.find((t) => t[0] === 'type');
      if (!tType) return;
      const tRoom = ev.tags.find((t) => t[0] === 'r');
      if (!tRoom) return;
      const type = tType[1];
      const meta = JSON.parse(ev.content || '{}');
      const owner = meta.owner || ev.pubkey;
      const slug = meta.slug || 'live';
      const roomId = tRoom[1];
      const titleTag = ev.tags.find((t) => t[0] === 'title');
      const title = meta.title || (titleTag && titleTag[1]) || 'שידור חי';

      if (type === 'live-post') {
        upsertFeedCard({ owner, slug, roomId, title, viewersApprox: 1 });
        return;
      }
      if (type === 'live-status') {
        const direct = Array.isArray(meta.direct) ? meta.direct.length : 0;
        const relays = Array.isArray(meta.relays) ? meta.relays.length : 0;
        const existing = activeLives.get(roomId);
        upsertFeedCard({
          owner: (existing && existing.owner) || owner,
          slug: (existing && existing.slug) || slug,
          roomId,
          title: (existing && existing.title) || title,
          viewersApprox: Math.max(1, direct + relays)
        });
      }
    } catch (e) {
      console.warn('live discovery event failed', e);
    }
  }

  function tryFlushFeedCards() {
    if (typeof App.upsertP2pLiveFeedCard !== 'function') {
      setTimeout(tryFlushFeedCards, 600);
      return;
    }
    activeLives.forEach((room) => {
      try { App.upsertP2pLiveFeedCard(room); } catch (_) {}
    });
  }

  function init() {
    subscribeLivePosts();
    setTimeout(tryFlushFeedCards, 800);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();

  console.log('Live stream UI initialized (setup + feed cards)');
})(window);
