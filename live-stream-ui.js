// חלק שידור חי (live-stream-ui.js) – סטודיו מסודר + כרטיס פיד רק אחרי וידאו מאומת | HYPER CORE TECH
(function initLiveStreamUI(window){
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;

  const DISCOVERY_WINDOW_SEC = 30 * 60; // חיפוש אירועים
  const MAX_POST_AGE_SEC = 3 * 60; // רק שידורים טריים לאימות
  const VERIFY_TIMEOUT_MS = 14000;

  const knownRooms = new Map(); // roomId -> meta
  const verifiedRooms = new Map(); // roomId -> meta + verified
  const verifying = new Set();

  let studio = null;
  let previewStream = null;
  let aspectMode = '9:16'; // או 16:9
  let timerInterval = null;
  let liveStartedAt = 0;
  let liveSub = null;
  let confirmOpen = false;
  let verifyTimer = null;
  let verifyRoomId = null;

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function cameraConstraints() {
    // יחס התצוגה הוא מסגרת UI בלבד — לא מחליפים facing/constraints כדי לא להפוך מצלמה במובייל | HYPER CORE TECH
    return {
      audio: true,
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    };
  }

  function stopPreviewTracks() {
    try {
      if (previewStream) {
        previewStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      }
    } catch (_) {}
    previewStream = null;
  }

  function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
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
    try { if (typeof App.live?.end === 'function') await App.live.end(); } catch (_) {}
    stopPreviewTracks();
    closeStudio();
  }

  async function ensurePreviewCamera() {
    const videoEl = studio && studio.querySelector('#liveStudioCam');
    if (previewStream && previewStream.getTracks().some((t) => t.readyState === 'live')) {
      if (videoEl) {
        videoEl.srcObject = previewStream;
        try { await videoEl.play(); } catch (_) {}
      }
      return previewStream;
    }
    stopPreviewTracks();
    previewStream = await navigator.mediaDevices.getUserMedia(cameraConstraints());
    if (videoEl) {
      videoEl.srcObject = previewStream;
      try { await videoEl.play(); } catch (_) {}
    }
    return previewStream;
  }

  function applyAspectUi() {
    if (!studio) return;
    studio.dataset.aspect = aspectMode === '16:9' ? 'landscape' : 'portrait';
    studio.querySelectorAll('[data-aspect-btn]').forEach((btn) => {
      const on = btn.getAttribute('data-aspect-btn') === aspectMode;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function setStudioPhase(phase) {
    if (!studio) return;
    studio.dataset.phase = phase;
    const setup = studio.querySelector('#liveStudioSetupPanel');
    const live = studio.querySelector('#liveStudioLivePanel');
    if (setup) {
      setup.hidden = phase !== 'setup';
      setup.style.display = phase === 'setup' ? '' : 'none';
    }
    if (live) {
      live.hidden = phase !== 'live';
      live.style.display = phase === 'live' ? '' : 'none';
    }
    const title = studio.querySelector('[data-hud-title]');
    if (title) title.textContent = phase === 'live' ? 'בשידור חי' : 'הכנת שידור';
    const timer = studio.querySelector('[data-live-timer]');
    if (timer) timer.hidden = phase !== 'live';
  }

  function showConfirm(onYes) {
    if (!studio || confirmOpen) return;
    confirmOpen = true;
    const overlay = doc.createElement('div');
    overlay.className = 'live-studio__confirm';
    overlay.innerHTML = `
      <div class="live-studio__confirm-card" role="dialog" aria-modal="true">
        <h3>להתחיל שידור חי?</h3>
        <p>השידור יופיע בפיד לצופים רק כשהווידאו פעיל.</p>
        <div class="live-studio__confirm-row">
          <button type="button" class="live-studio__btn live-studio__btn--ghost" data-confirm="no">ביטול</button>
          <button type="button" class="live-studio__btn live-studio__btn--primary" data-confirm="yes">כן, התחל</button>
        </div>
      </div>`;
    studio.appendChild(overlay);
    overlay.querySelector('[data-confirm="no"]').onclick = () => {
      confirmOpen = false;
      overlay.remove();
    };
    overlay.querySelector('[data-confirm="yes"]').onclick = async () => {
      confirmOpen = false;
      overlay.remove();
      try { await onYes(); } catch (e) { console.warn(e); }
    };
  }

  function startTimerUi() {
    stopTimer();
    liveStartedAt = Date.now();
    const el = studio && studio.querySelector('[data-live-timer]');
    const tick = () => { if (el) el.textContent = formatDuration(Date.now() - liveStartedAt); };
    tick();
    timerInterval = setInterval(tick, 1000);
  }

  async function beginBroadcastFromSetup() {
    if (!studio) return;
    const titleInput = studio.querySelector('#liveStudioTitle');
    const title = String((titleInput && titleInput.value) || '').trim() || 'שידור חי';
    if (!previewStream) await ensurePreviewCamera();
    if (typeof App.live?.start !== 'function') {
      window.alert('שידור חי לא זמין כרגע');
      return;
    }
    const streamForLive = previewStream;
    previewStream = null;
    await App.live.start({
      slug: 'live',
      title,
      stream: streamForLive,
      facingMode: 'user'
    });
    const cam = studio.querySelector('#liveStudioCam');
    if (cam && streamForLive) {
      cam.srcObject = streamForLive;
      cam.play().catch(() => {});
    }
    const topic = studio.querySelector('[data-live-topic]');
    if (topic) topic.textContent = title;
    setStudioPhase('live');
    startTimerUi();
  }

  function openSetupStudio() {
    closeStudio();
    stopPreviewTracks();
    aspectMode = '9:16';

    studio = doc.createElement('div');
    studio.id = 'liveStudio';
    studio.className = 'live-studio';
    studio.dataset.phase = 'setup';
    studio.dataset.aspect = 'portrait';
    studio.innerHTML = `
      <div class="live-studio__shell">
        <header class="live-studio__header">
          <button type="button" class="live-studio__close" data-action="close" aria-label="סגור">
            <i class="fa-solid fa-xmark"></i>
          </button>
          <div class="live-studio__header-text">
            <span class="live-studio__pill">LIVE</span>
            <h1 data-hud-title>הכנת שידור</h1>
            <span class="live-studio__timer" data-live-timer hidden>00:00</span>
          </div>
        </header>

        <div class="live-studio__body">
          <div class="live-studio__preview-wrap">
            <div class="live-studio__preview-frame">
              <video id="liveStudioCam" class="live-studio__cam" autoplay muted playsinline></video>
            </div>
          </div>

          <aside class="live-studio__side" id="liveStudioSetupPanel">
            <div class="live-studio__side-block">
              <label class="live-studio__label" for="liveStudioTitle">נושא השידור</label>
              <input id="liveStudioTitle" class="live-studio__input" type="text" maxlength="80" placeholder="לדוגמה: שיחה חיה מהאולפן" autocomplete="off">
            </div>

            <div class="live-studio__side-block">
              <span class="live-studio__label">יחס תצוגה לצופים</span>
              <div class="live-studio__seg" role="group" aria-label="יחס תצוגה">
                <button type="button" class="live-studio__seg-btn is-active" data-aspect-btn="9:16" aria-pressed="true">9:16 מובייל</button>
                <button type="button" class="live-studio__seg-btn" data-aspect-btn="16:9" aria-pressed="false">16:9 מסך</button>
              </div>
              <p class="live-studio__help">מחליף רק את מסגרת התצוגה — לא הופך את המצלמה.</p>
            </div>

            <button type="button" class="live-studio__btn live-studio__btn--primary live-studio__btn--block" data-action="request-start">
              התחל לשדר
            </button>
          </aside>

          <aside class="live-studio__side live-studio__side--live" id="liveStudioLivePanel" hidden style="display:none">
            <div class="live-studio__live-stats">
              <span class="live-studio__pill">LIVE</span>
              <strong data-live-topic>שידור חי</strong>
              <span data-live-viewers>1 צופה</span>
            </div>
            <button type="button" class="live-studio__btn live-studio__btn--danger live-studio__btn--block" data-action="end">
              סיים שידור
            </button>
          </aside>
        </div>
      </div>`;

    doc.body.appendChild(studio);
    doc.body.classList.add('live-studio-open');
    setStudioPhase('setup');
    applyAspectUi();

    studio.querySelector('[data-action="close"]').onclick = async () => {
      if (studio.dataset.phase === 'live') await endBroadcastAndClose();
      else { stopPreviewTracks(); closeStudio(); }
    };
    studio.querySelector('[data-action="request-start"]').onclick = () => {
      showConfirm(() => beginBroadcastFromSetup());
    };
    studio.querySelector('[data-action="end"]').onclick = () => endBroadcastAndClose();
    studio.querySelectorAll('[data-aspect-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (studio.dataset.phase === 'live') return;
        aspectMode = btn.getAttribute('data-aspect-btn') || '9:16';
        applyAspectUi(); // CSS בלבד — בלי getUserMedia מחדש
      });
    });

    ensurePreviewCamera().catch((err) => {
      console.warn('live camera failed', err);
      window.alert('לא ניתן לפתוח את המצלמה');
      closeStudio();
    });
  }

  App.openLiveBroadcast = function() {
    try { openSetupStudio(); } catch (e) { console.warn(e); }
  };
  App.closeLiveStudio = function() { return endBroadcastAndClose(); };

  App.onLiveLocalStream = function(stream) {
    const cam = studio && studio.querySelector('#liveStudioCam');
    if (cam && stream) {
      cam.srcObject = stream;
      cam.play().catch(() => {});
    }
  };

  App.onLiveRemoteStream = function(stream) {
    // אימות שידור לצופה — רק אחרי שיש מדיה אמיתית | HYPER CORE TECH
    if (verifyRoomId && stream && stream.getTracks && stream.getTracks().length) {
      const meta = knownRooms.get(verifyRoomId);
      if (meta) {
        finishVerifySuccess(meta, stream);
      }
    }
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

  App.onLiveStarted = function() {
    const timer = studio && studio.querySelector('[data-live-timer]');
    if (timer) timer.hidden = false;
  };
  App.onLiveEnded = function() {
    stopTimer();
    if (studio && studio.dataset.phase === 'live') closeStudio();
  };
  App.onLiveStatusUpdate = function(info) {
    const el = studio && studio.querySelector('[data-live-viewers]');
    if (!el) return;
    const n = Math.max(1, Number(info && info.viewersApprox) || 1);
    el.textContent = n === 1 ? '1 צופה' : `${n} צופים`;
  };

  App.openLiveWatchHub = function() {
    const card = doc.querySelector('.videos-feed__media[data-media-type="p2p-live"]')?.closest('.videos-feed__card');
    if (card) {
      try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
      return;
    }
    try {
      if (typeof App.showTransientFeedHint === 'function') {
        App.showTransientFeedHint('אין שידור חי פעיל ומאומת בפיד כרגע');
      }
    } catch (_) {}
  };
  App.closeLiveWatchHub = function() { return true; };
  App.isLiveWatchHubOpen = function() { return false; };

  function clearVerifyTimer() {
    if (verifyTimer) clearTimeout(verifyTimer);
    verifyTimer = null;
  }

  function finishVerifySuccess(meta, stream) {
    clearVerifyTimer();
    verifying.delete(meta.roomId);
    verifyRoomId = null;
    verifiedRooms.set(meta.roomId, { ...meta, verifiedAt: Date.now() });

    App._p2pLivePendingStreams = App._p2pLivePendingStreams || new Map();
    const safeId = `p2plive-${String(meta.roomId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96)}`;
    App._p2pLivePendingStreams.set(safeId, stream);

    if (typeof App.upsertP2pLiveFeedCard === 'function') {
      App.upsertP2pLiveFeedCard({
        ...meta,
        streamReady: true,
        cardId: safeId
      });
    }
  }

  function finishVerifyFail(roomId) {
    clearVerifyTimer();
    verifying.delete(roomId);
    if (verifyRoomId === roomId) verifyRoomId = null;
    try {
      const st = App.live && App.live.getState && App.live.getState();
      if (st && st.role === 'viewer') App.live.end();
    } catch (_) {}
  }

  function queueVerify(meta) {
    if (!meta || !meta.roomId || !meta.owner) return;
    if (App.publicKey && meta.owner.toLowerCase() === String(App.publicKey).toLowerCase()) return;
    if (verifiedRooms.has(meta.roomId)) return;
    if (verifying.has(meta.roomId)) return;
    // ליבה תומכת בחדר אחד — לא מאמתים בזמן שידור מקומי | HYPER CORE TECH
    try {
      const st = App.live && App.live.getState && App.live.getState();
      if (st && st.role === 'broadcaster') return;
      if (doc.body.classList.contains('live-studio-open')) return;
    } catch (_) {}

    verifying.add(meta.roomId);
    verifyRoomId = meta.roomId;

    if (typeof App.live?.watch !== 'function') {
      finishVerifyFail(meta.roomId);
      return;
    }

    Promise.resolve(App.live.watch(meta.owner, meta.slug || 'live')).catch(() => {
      finishVerifyFail(meta.roomId);
    });

    clearVerifyTimer();
    verifyTimer = setTimeout(() => {
      if (!verifiedRooms.has(meta.roomId)) finishVerifyFail(meta.roomId);
    }, VERIFY_TIMEOUT_MS);
  }

  function maybeQueueFromEvent(ev, meta) {
    const age = Math.floor(Date.now() / 1000) - Number(ev.created_at || 0);
    if (age > MAX_POST_AGE_SEC) return;
    knownRooms.set(meta.roomId, meta);
    queueVerify(meta);
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
      const payload = JSON.parse(ev.content || '{}');
      const owner = payload.owner || ev.pubkey;
      const slug = payload.slug || 'live';
      const roomId = tRoom[1];
      const titleTag = ev.tags.find((t) => t[0] === 'title');
      const title = payload.title || (titleTag && titleTag[1]) || 'שידור חי';
      const meta = { owner, slug, roomId, title };

      if (type === 'live-post') {
        maybeQueueFromEvent(ev, meta);
      }
      // live-status לבד לא יוצר כרטיס ריק | HYPER CORE TECH
    } catch (e) {
      console.warn('live discovery event failed', e);
    }
  }

  // ניקוי כרטיסי LIVE ריקים שנתקעו בפיד | HYPER CORE TECH
  function purgeBrokenLiveCards() {
    try {
      doc.querySelectorAll('.videos-feed__media[data-media-type="p2p-live"]').forEach((media) => {
        const video = media.querySelector('video');
        const hasStream = !!(video && video.srcObject);
        if (!hasStream) {
          const card = media.closest('.videos-feed__card');
          if (card) card.remove();
        }
      });
    } catch (_) {}
  }

  function init() {
    purgeBrokenLiveCards();
    subscribeLivePosts();
    setTimeout(purgeBrokenLiveCards, 1500);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();

  console.log('Live stream UI ready (studio + verified cards only)');
})(window);
