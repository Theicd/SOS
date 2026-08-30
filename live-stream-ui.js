// חלק שידור חי (live-stream-ui.js) – UI: שידור ממצלמה, מרכז צפייה, וכרטיסי discovery | HYPER CORE TECH
(function initLiveStreamUI(window){
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;

  const DISCOVERY_WINDOW_SEC = 6 * 60 * 60; // 6 שעות – כדי שנכנסים לאתר יראו שידורים פעילים
  const activeLives = new Map(); // roomId -> { owner, slug, roomId, viewersApprox, updatedAt }

  let modal = null;
  let hub = null;
  let localVideo = null;
  let remoteVideo = null;
  let liveSub = null;

  function shortKey(pk) {
    const s = String(pk || '');
    return s ? s.slice(0, 8) : '—';
  }

  // חלק שידור חי – דיאלוג שידור/צפייה באאווירת במה מלאה | HYPER CORE TECH
  function openModal(mode, roomMeta){
    closeModal();
    modal = doc.createElement('div');
    modal.className = 'live-modal' + (mode === 'watch' ? ' live-modal--watch' : ' live-modal--broadcast');
    modal.dataset.liveMode = mode;
    const title = mode === 'broadcast' ? 'שידור חי' : 'צפייה בשידור חי';
    const badge = mode === 'broadcast'
      ? '<span class="live-modal__live-badge" aria-hidden="true">LIVE</span>'
      : '<span class="live-modal__live-badge live-modal__live-badge--watch" aria-hidden="true">LIVE</span>';
    modal.innerHTML = `
      <div class="live-modal__backdrop" data-action="close"></div>
      <div class="live-modal__content" role="dialog" aria-modal="true" aria-label="${title}">
        <header class="live-modal__header">
          <div class="live-modal__title-row">
            ${badge}
            <h3>${title}</h3>
          </div>
          <button class="live-modal__close" data-action="close" aria-label="סגור"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <main class="live-modal__body">
          <div class="live-modal__videos">
            <video id="liveRemote" class="live-video live-video--remote" autoplay playsinline ${mode === 'watch' ? 'controls' : ''}></video>
            <video id="liveLocal" class="live-video live-video--local" autoplay muted playsinline></video>
            <div class="live-modal__stage-hint" id="liveStageHint">${mode === 'broadcast' ? 'מתחבר למצלמה…' : 'מתחבר לשידור…'}</div>
          </div>
          <div class="live-modal__actions">
            ${mode === 'broadcast'
              ? '<button class="button-primary live-modal__end-btn" data-action="end">סיים שידור</button>'
              : '<button class="button-secondary live-modal__end-btn" data-action="end">סגור</button>'}
          </div>
        </main>
      </div>`;
    doc.body.appendChild(modal);
    doc.body.classList.add('live-modal-open');
    localVideo = modal.querySelector('#liveLocal');
    remoteVideo = modal.querySelector('#liveRemote');
    if (mode === 'watch' && localVideo) localVideo.hidden = true;

    modal.querySelectorAll('[data-action="close"]').forEach((el) => {
      el.addEventListener('click', () => { endAndClose(); });
    });
    modal.querySelector('[data-action="end"]').addEventListener('click', () => { endAndClose(); });

    if (mode === 'broadcast') {
      if (typeof App.live?.start === 'function') App.live.start(roomMeta?.slug || 'live');
    } else if (mode === 'watch' && roomMeta) {
      if (typeof App.live?.watch === 'function') App.live.watch(roomMeta.owner, roomMeta.slug || 'live');
    }
  }

  async function endAndClose() {
    try { if (typeof App.live?.end === 'function') await App.live.end(); } catch (_) {}
    closeModal();
  }

  function closeModal(){
    if (modal) {
      try { modal.remove(); } catch (_) {}
      modal = null;
    }
    localVideo = null;
    remoteVideo = null;
    try { doc.body.classList.remove('live-modal-open'); } catch (_) {}
  }

  // חלק מרכז צפייה (live-stream-ui.js) – רשימת משדרים פעילים באאווירת SOS | HYPER CORE TECH
  function ensureHub() {
    if (hub && doc.body.contains(hub)) return hub;
    hub = doc.createElement('div');
    hub.id = 'liveWatchHub';
    hub.className = 'live-hub';
    hub.hidden = true;
    hub.setAttribute('role', 'dialog');
    hub.setAttribute('aria-label', 'שידורים חיים');
    hub.innerHTML = `
      <header class="live-hub__header">
        <button type="button" class="live-hub__back" data-action="close-hub" aria-label="חזרה">
          <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
        </button>
        <div class="live-hub__titles">
          <h2>שידור חי</h2>
          <p>צופים במשדרים פעילים ברשת</p>
        </div>
        <span class="live-hub__live-dot" aria-hidden="true"></span>
      </header>
      <div class="live-hub__body">
        <div class="live-hub__empty" id="liveHubEmpty">
          <i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i>
          <p>אין שידורים חיים כרגע</p>
          <span>כשמישהו משדר מ«פרסם», הוא יופיע כאן</span>
        </div>
        <ul class="live-hub__list" id="liveHubList" hidden></ul>
      </div>`;
    doc.body.appendChild(hub);
    hub.querySelector('[data-action="close-hub"]').addEventListener('click', () => {
      closeLiveWatchHub();
    });
    return hub;
  }

  function renderHubList() {
    const root = ensureHub();
    const list = root.querySelector('#liveHubList');
    const empty = root.querySelector('#liveHubEmpty');
    if (!list || !empty) return;

    const rooms = Array.from(activeLives.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    list.innerHTML = '';

    if (!rooms.length) {
      empty.hidden = false;
      list.hidden = true;
      return;
    }

    empty.hidden = true;
    list.hidden = false;

    rooms.forEach((room) => {
      const li = doc.createElement('li');
      li.className = 'live-hub__item';
      li.innerHTML = `
        <div class="live-hub__item-main">
          <div class="live-hub__avatar" aria-hidden="true"><i class="fa-solid fa-user"></i></div>
          <div class="live-hub__meta">
            <div class="live-hub__name-row">
              <span class="live-hub__badge">LIVE</span>
              <strong>${shortKey(room.owner)}</strong>
            </div>
            <span class="live-hub__viewers">${room.viewersApprox || 1} צופים</span>
          </div>
        </div>
        <button type="button" class="live-hub__watch-btn" data-action="watch">צפה</button>`;
      li.querySelector('[data-action="watch"]').addEventListener('click', () => {
        openModal('watch', { owner: room.owner, slug: room.slug || 'live' });
      });
      list.appendChild(li);
    });
  }

  function openLiveWatchHub() {
    ensureHub();
    hub.hidden = false;
    doc.body.classList.add('live-hub-open');
    renderHubList();
    subscribeLivePosts(true);
  }

  function closeLiveWatchHub() {
    if (hub) hub.hidden = true;
    try { doc.body.classList.remove('live-hub-open'); } catch (_) {}
    return true;
  }

  function isLiveWatchHubOpen() {
    return !!(hub && !hub.hidden);
  }

  // חלק callbacks מליבת live-stream.js | HYPER CORE TECH
  App.onLiveLocalStream = function(stream){
    if (localVideo) {
      localVideo.srcObject = stream;
      localVideo.hidden = false;
    }
    const hint = modal && modal.querySelector('#liveStageHint');
    if (hint) hint.hidden = true;
  };
  App.onLiveRemoteStream = function(stream){
    if (remoteVideo) remoteVideo.srcObject = stream;
    const hint = modal && modal.querySelector('#liveStageHint');
    if (hint) hint.hidden = true;
  };
  App.onLiveStarted = function(){
    const hint = modal && modal.querySelector('#liveStageHint');
    if (hint) {
      hint.textContent = 'משדר בשידור חי';
      hint.classList.add('is-live');
    }
  };
  App.onLiveEnded = function(){ closeModal(); };

  // התחלת שידור – מפרסם / מצלמה | HYPER CORE TECH
  App.openLiveBroadcast = function(roomMeta){
    try {
      closeLiveWatchHub();
      openModal('broadcast', roomMeta || { slug: 'live' });
    } catch (_) {}
  };

  // צפייה – מתפריט «שידור חי» | HYPER CORE TECH
  App.openLiveWatchHub = openLiveWatchHub;
  App.closeLiveWatchHub = closeLiveWatchHub;
  App.isLiveWatchHubOpen = isLiveWatchHubOpen;

  function insertTopBarButton(){
    return;
  }

  function upsertActiveLive(room) {
    if (!room || !room.roomId || !room.owner) return;
    const prev = activeLives.get(room.roomId) || {};
    activeLives.set(room.roomId, {
      owner: room.owner,
      slug: room.slug || 'live',
      roomId: room.roomId,
      viewersApprox: room.viewersApprox != null ? room.viewersApprox : (prev.viewersApprox || 1),
      updatedAt: Date.now()
    });
    if (isLiveWatchHubOpen()) renderHubList();
  }

  // חלק שידור חי – מנוי discovery לשידורים פעילים | HYPER CORE TECH
  async function subscribeLivePosts(force){
    if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) {
      setTimeout(() => subscribeLivePosts(force), 600);
      return;
    }
    if (liveSub && !force) return;
    const since = Math.floor(Date.now() / 1000) - DISCOVERY_WINDOW_SEC;
    const filters = [{ kinds: [25051], since }];
    try {
      liveSub = App.pool.subscribeMany(App.relayUrls, filters, {
        onevent: onLiveDiscoveryEvent,
        oneose: () => {
          if (isLiveWatchHubOpen()) renderHubList();
        }
      });
    } catch (e) {
      console.warn('live discovery subscribe failed', e);
      setTimeout(() => subscribeLivePosts(true), 1200);
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

      if (type === 'live-post') {
        upsertActiveLive({ owner, slug, roomId, viewersApprox: 1 });
        // toast רק כשהמרכז סגור – לא דוחפים כרטיס לתוך פיד הטיקטוק | HYPER CORE TECH
        if (!isLiveWatchHubOpen()) {
          showLiveToast(owner, () => openModal('watch', { owner, slug }));
        }
        return;
      }

      if (type === 'live-status') {
        const direct = Array.isArray(meta.direct) ? meta.direct.length : 0;
        const relays = Array.isArray(meta.relays) ? meta.relays.length : 0;
        const approx = Math.max(1, direct + relays);
        const existing = activeLives.get(roomId);
        upsertActiveLive({
          owner: (existing && existing.owner) || owner,
          slug: (existing && existing.slug) || slug,
          roomId,
          viewersApprox: approx
        });
      }
    } catch (e) {
      console.warn('live discovery event failed', e);
    }
  }

  function showLiveToast(owner, onWatch){
    try {
      if (owner && App.publicKey && owner.toLowerCase() === App.publicKey.toLowerCase()) return;
      const id = 'live-toast';
      if (doc.getElementById(id)) return;
      const el = doc.createElement('div');
      el.id = id;
      el.className = 'live-toast';
      el.innerHTML = `<div class="live-toast__inner"><i class="fa-solid fa-tower-broadcast"></i><span>יש שידור חי עכשיו</span><button class="button-primary" data-action="watch">צפה</button></div>`;
      doc.body.appendChild(el);
      const btn = el.querySelector('[data-action="watch"]');
      btn.addEventListener('click', () => {
        try { onWatch && onWatch(); } catch (_) {}
        try { el.remove(); } catch (_) {}
      });
      setTimeout(() => { try { el.remove(); } catch (_) {} }, 8000);
    } catch (_) {}
  }

  function init(){
    insertTopBarButton();
    ensureHub();
    subscribeLivePosts(false);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();

  console.log('Live stream UI initialized');
})(window);
