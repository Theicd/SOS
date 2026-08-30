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
  let chatSub = null;
  let activeChatRoomId = null;
  const bannerShownRooms = new Set();
  let liveBannerEl = null;
  let liveBannerTimer = null;

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
    stopLiveChatSub();
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
    try {
      const st = App.live && App.live.getState && App.live.getState();
      if (st && st.roomId) startLiveChatSub(st.roomId);
    } catch (_) {}
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
              <div class="live-studio__hearts" id="liveStudioHearts" aria-hidden="true"></div>
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
            <div class="live-studio__live-top">
              <div class="live-studio__live-stats">
                <span class="live-studio__pill">LIVE</span>
                <strong data-live-topic>שידור חי</strong>
                <span data-live-viewers>1 צופה</span>
              </div>
              <button type="button" class="live-studio__btn live-studio__btn--danger live-studio__btn--block" data-action="end">
                סיים שידור
              </button>
            </div>

            <div class="live-studio__chat" aria-label="תגובות השידור">
              <div class="live-studio__chat-head">תגובות מהצופים</div>
              <div class="live-studio__chat-list" id="liveStudioChatList" role="log" aria-live="polite">
                <div class="live-studio__chat-empty" data-chat-empty>עדיין אין תגובות</div>
              </div>
            </div>
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
    try {
      const st = App.live && App.live.getState && App.live.getState();
      if (st && st.roomId) startLiveChatSub(st.roomId);
    } catch (_) {}
  };
  App.onLiveEnded = function(info) {
    stopTimer();
    stopLiveChatSub();
    if (studio && studio.dataset.phase === 'live') closeStudio();
    const roomId = info && info.roomId;
    // רק סיום אמיתי (או אובדן סטרים) — לא כישלון אימות שקט | HYPER CORE TECH
    if (roomId && info && info.reason === 'lost') {
      markViewerLiveEnded(roomId, 'השידור הסתיים');
      return;
    }
    if (roomId && info && info.wasBroadcaster) {
      try {
        if (typeof App.markP2pLiveEnded === 'function') App.markP2pLiveEnded(roomId, 'השידור הסתיים');
      } catch (_) {}
    }
  };

  App.onLiveStreamLost = function(roomId) {
    markViewerLiveEnded(roomId, 'השידור הסתיים');
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

  function spawnFloatingHeart() {
    const layer = studio && studio.querySelector('#liveStudioHearts');
    if (!layer) return;
    const heart = doc.createElement('span');
    heart.className = 'live-studio__heart';
    heart.textContent = '❤';
    const drift = (Math.random() * 70) - 35;
    const scale = 0.85 + Math.random() * 0.55;
    heart.style.setProperty('--hx', `${drift}px`);
    heart.style.setProperty('--hs', String(scale));
    layer.appendChild(heart);
    setTimeout(() => {
      try { heart.remove(); } catch (_) {}
    }, 2200);
  }

  function clearChatUi() {
    const list = studio && studio.querySelector('#liveStudioChatList');
    if (!list) return;
    list.innerHTML = '<div class="live-studio__chat-empty" data-chat-empty>עדיין אין תגובות</div>';
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function resolveLocalIdentity() {
    const prof = App.profile || {};
    const cached = (App.profileCache instanceof Map && App.publicKey)
      ? (App.profileCache.get(App.publicKey) || App.profileCache.get(String(App.publicKey).toLowerCase()) || {})
      : {};
    const name = String(prof.name || cached.name || '').trim()
      || (App.publicKey ? `משתמש ${String(App.publicKey).slice(0, 8)}` : 'צופה');
    const picture = String(prof.picture || cached.picture || '').trim();
    return { name: name.slice(0, 48), picture };
  }

  function lookupProfileSync(pubkey) {
    if (!pubkey) return {};
    const key = String(pubkey);
    const low = key.toLowerCase();
    if (!(App.profileCache instanceof Map)) return {};
    return App.profileCache.get(key) || App.profileCache.get(low) || {};
  }

  function initialsFromName(name) {
    const s = String(name || '').trim();
    if (!s) return '?';
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }

  function appendChatMessage(author, text, picture) {
    const list = studio && studio.querySelector('#liveStudioChatList');
    if (!list) return;
    const empty = list.querySelector('[data-chat-empty]');
    if (empty) empty.remove();
    const row = doc.createElement('div');
    row.className = 'live-studio__chat-item';
    const av = doc.createElement('div');
    av.className = 'live-studio__chat-avatar';
    const pic = String(picture || '').trim();
    if (pic) {
      const img = doc.createElement('img');
      img.src = pic;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => {
        av.textContent = initialsFromName(author);
        img.remove();
      };
      av.appendChild(img);
    } else {
      av.textContent = initialsFromName(author);
    }
    const col = doc.createElement('div');
    col.className = 'live-studio__chat-body';
    const who = doc.createElement('strong');
    who.textContent = String(author || 'צופה').slice(0, 24);
    const body = doc.createElement('span');
    body.textContent = String(text || '').slice(0, 280);
    col.appendChild(who);
    col.appendChild(body);
    row.appendChild(av);
    row.appendChild(col);
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
  }

  function stopLiveChatSub() {
    activeChatRoomId = null;
    chatSub = null;
  }

  function startLiveChatSub(roomId) {
    if (!roomId || !App.pool || !Array.isArray(App.relayUrls)) return;
    activeChatRoomId = roomId;
    clearChatUi();
    const since = Math.floor(Date.now() / 1000) - 30;
    try {
      chatSub = App.pool.subscribeMany(
        App.relayUrls,
        [{ kinds: [25051], '#r': [roomId], since }],
        {
          onevent: (ev) => {
            try {
              const tType = ev.tags.find((t) => t[0] === 'type');
              if (!tType) return;
              const tRoom = ev.tags.find((t) => t[0] === 'r');
              if (!tRoom || tRoom[1] !== roomId) return;
              const kind = tType[1];

              if (kind === 'live-like') {
                if (App.publicKey && String(ev.pubkey).toLowerCase() === String(App.publicKey).toLowerCase()) return;
                spawnFloatingHeart();
                spawnFloatingHeart();
                return;
              }

              if (kind === 'live-end') {
                markViewerLiveEnded(roomId, 'השידור הסתיים');
                return;
              }

              if (kind !== 'live-chat') return;
              let payload = {};
              try { payload = JSON.parse(ev.content || '{}'); } catch (_) {}
              const text = payload.text || '';
              if (!text) return;
              const cached = lookupProfileSync(ev.pubkey);
              const author = String(payload.name || cached.name || '').trim()
                || (ev.pubkey ? `משתמש ${String(ev.pubkey).slice(0, 8)}` : 'צופה');
              const picture = String(payload.picture || cached.picture || '').trim();
              appendChatMessage(author, text, picture);
              if (!cached.name && typeof App.fetchProfile === 'function') {
                App.fetchProfile(ev.pubkey).catch(() => null);
              }
            } catch (_) {}
          },
          oneose: () => {}
        }
      );
    } catch (e) {
      console.warn('live chat subscribe failed', e);
    }
  }

  App.publishLiveChat = async function(roomId, text) {
    const msg = String(text || '').trim();
    const rid = roomId || activeChatRoomId;
    if (!msg || !rid) return false;
    if (!App.pool || !App.publicKey || !App.privateKey || typeof App.finalizeEvent !== 'function') return false;
    try {
      const id = resolveLocalIdentity();
      const content = JSON.stringify({
        text: msg.slice(0, 280),
        name: id.name,
        picture: id.picture && id.picture.length < 4000 ? id.picture : '',
        roomId: rid
      });
      const ev = {
        kind: 25051,
        pubkey: App.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['type', 'live-chat'], ['r', rid]],
        content
      };
      const signed = App.finalizeEvent(ev, App.privateKey);
      await App.pool.publish(App.relayUrls, signed);
      return true;
    } catch (e) {
      console.warn('publishLiveChat failed', e);
      return false;
    }
  };

  App.publishLiveLike = async function(roomId) {
    const rid = roomId || activeChatRoomId;
    if (!rid) return false;
    if (!App.pool || !App.publicKey || !App.privateKey || typeof App.finalizeEvent !== 'function') return false;
    try {
      const ev = {
        kind: 25051,
        pubkey: App.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['type', 'live-like'], ['r', rid]],
        content: JSON.stringify({ roomId: rid, at: Date.now() })
      };
      const signed = App.finalizeEvent(ev, App.privateKey);
      await App.pool.publish(App.relayUrls, signed);
      return true;
    } catch (e) {
      console.warn('publishLiveLike failed', e);
      return false;
    }
  };

  App.getActiveLiveRoomId = function() {
    try {
      const st = App.live && App.live.getState && App.live.getState();
      return (st && st.roomId) || activeChatRoomId || null;
    } catch (_) {
      return activeChatRoomId;
    }
  };

  function dismissLiveStartedBanner() {
    if (liveBannerTimer) {
      clearTimeout(liveBannerTimer);
      liveBannerTimer = null;
    }
    if (liveBannerEl) {
      try { liveBannerEl.classList.remove('is-visible'); } catch (_) {}
      const el = liveBannerEl;
      liveBannerEl = null;
      setTimeout(() => { try { el.remove(); } catch (_) {} }, 320);
    }
  }

  function showLiveStartedBanner(meta) {
    if (!meta || !meta.roomId || !meta.owner) return;
    if (App.publicKey && String(meta.owner).toLowerCase() === String(App.publicKey).toLowerCase()) return;
    if (bannerShownRooms.has(meta.roomId)) return;
    // לא מציגים באנר על שידורים ישנים מהחלון הרחב | HYPER CORE TECH
    if (meta._ageSec != null && meta._ageSec > 90) return;
    bannerShownRooms.add(meta.roomId);

    const cached = lookupProfileSync(meta.owner);
    const name = String(meta.name || cached.name || '').trim()
      || `משתמש ${String(meta.owner).slice(0, 8)}`;
    let picture = String(meta.picture || cached.picture || '').trim();

    dismissLiveStartedBanner();
    const el = doc.createElement('button');
    el.type = 'button';
    el.className = 'live-go-banner';
    el.setAttribute('aria-label', `${name} התחיל לשדר`);
    el.innerHTML = `
      <span class="live-go-banner__avatar" data-av></span>
      <span class="live-go-banner__text">
        <strong>${escapeHtml(name)}</strong>
        <span>התחיל לשדר</span>
      </span>
      <span class="live-go-banner__cta">צפייה</span>`;
    const av = el.querySelector('[data-av]');
    if (picture) {
      const img = doc.createElement('img');
      img.src = picture;
      img.alt = '';
      img.onerror = () => { av.textContent = initialsFromName(name); img.remove(); };
      av.appendChild(img);
    } else {
      av.textContent = initialsFromName(name);
    }

    el.addEventListener('click', () => {
      dismissLiveStartedBanner();
      const media = Array.from(doc.querySelectorAll('.videos-feed__media[data-live-room-id]'))
        .find((m) => m.dataset.liveRoomId === meta.roomId);
      const card = media && media.closest('.videos-feed__card');
      if (card) {
        try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
        return;
      }
      knownRooms.set(meta.roomId, meta);
      queueVerify(meta);
      try {
        if (typeof App.showTransientFeedHint === 'function') {
          App.showTransientFeedHint('מתחבר לשידור…');
        }
      } catch (_) {}
    });

    doc.body.appendChild(el);
    liveBannerEl = el;
    requestAnimationFrame(() => el.classList.add('is-visible'));
    liveBannerTimer = setTimeout(dismissLiveStartedBanner, 9000);

    if ((!cached.name || !picture) && typeof App.fetchProfile === 'function') {
      App.fetchProfile(meta.owner).then((p) => {
        if (!p || !liveBannerEl || liveBannerEl !== el) return;
        if (p.name) {
          const strong = el.querySelector('.live-go-banner__text strong');
          if (strong) strong.textContent = String(p.name).slice(0, 48);
        }
        if (p.picture && av && !av.querySelector('img')) {
          av.textContent = '';
          const img = doc.createElement('img');
          img.src = p.picture;
          img.alt = '';
          av.appendChild(img);
        }
      }).catch(() => null);
    }
  }

  function markViewerLiveEnded(roomId, message) {
    if (!roomId) return;
    verifiedRooms.delete(roomId);
    verifying.delete(roomId);
    if (verifyRoomId === roomId) {
      clearVerifyTimer();
      verifyRoomId = null;
    }
    try {
      if (typeof App.markP2pLiveEnded === 'function') {
        App.markP2pLiveEnded(roomId, message || 'השידור הסתיים');
      }
    } catch (_) {}
    try {
      const st = App.live && App.live.getState && App.live.getState();
      if (st && st.role === 'viewer' && st.roomId === roomId) {
        App.live.end();
      }
    } catch (_) {}
  }

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
    meta._ageSec = age;
    if (age > MAX_POST_AGE_SEC) return;
    knownRooms.set(meta.roomId, meta);
    showLiveStartedBanner(meta);
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
      const meta = {
        owner,
        slug,
        roomId,
        title,
        name: payload.name || '',
        picture: payload.picture || ''
      };

      if (type === 'live-post') {
        maybeQueueFromEvent(ev, meta);
        return;
      }
      if (type === 'live-end') {
        markViewerLiveEnded(roomId, 'השידור הסתיים');
      }
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
