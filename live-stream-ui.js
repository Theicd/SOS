// חלק שידור חי (live-stream-ui.js) – סטודיו מסודר + כרטיס פיד רק אחרי וידאו מאומת | HYPER CORE TECH
(function initLiveStreamUI(window){
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;

  const DISCOVERY_WINDOW_SEC = 30 * 60; // חיפוש אירועים
  const MAX_POST_AGE_SEC = 3 * 60; // live-post ישן — רק באנר ראשוני
  const MAX_STATUS_AGE_SEC = 2 * 60; // live-status טרי = שידור עדיין חי (heartbeat ~50s)
  const MAX_LIVE_END_AGE_SEC = 25; // live-end ישן מאותו roomId לא סוגר שידור חדש
  const VERIFY_TIMEOUT_MS = 14000;
  // מנוי צ'אט חי קצר — היסטוריה מגיעה ב־P2P מהמשדר, לא מריליי | HYPER CORE TECH
  const LIVE_CHAT_LIVE_LOOKBACK_SEC = 45;
  const HOST_CHAT_HISTORY_MAX = 100;

  const knownRooms = new Map(); // roomId -> meta
  const verifiedRooms = new Map(); // roomId -> meta + verified
  const verifying = new Set();
  const roomLivePostAt = new Map(); // roomId -> created_at של live-post האחרון שקיבלנו
  let hostChatHistory = []; // משדר: היסטוריית צ'אט לשליחה לצופים חדשים | HYPER CORE TECH

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
  const seenLiveEventIds = new Set();
  let liveLikeCount = 0;

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

  function silenceHomeFeed() {
    try {
      if (typeof App.pauseAllFeedVideos === 'function') {
        App.pauseAllFeedVideos({ muteFeed: true });
      }
    } catch (_) {}
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
    silenceHomeFeed();
    const titleInput = studio.querySelector('#liveStudioTitle');
    const title = String((titleInput && titleInput.value) || '').trim() || 'שידור חי';
    if (!previewStream) await ensurePreviewCamera();
    if (typeof App.live?.start !== 'function') {
      window.alert('שידור חי לא זמין כרגע');
      return;
    }
    silenceHomeFeed();
    const streamForLive = previewStream;
    previewStream = null;
    await App.live.start({
      slug: 'live',
      title,
      stream: streamForLive,
      facingMode: 'user'
    });
    silenceHomeFeed();
    const cam = studio.querySelector('#liveStudioCam');
    if (cam && streamForLive) {
      cam.srcObject = streamForLive;
      cam.muted = true;
      cam.play().catch(() => {});
    }
    const topic = studio.querySelector('[data-live-topic]');
    if (topic) topic.textContent = title;
    setStudioPhase('live');
    startTimerUi();
    // צ'אט נפתח ב־onLiveStarted — לא כאן, כדי לא לכפול אירועים | HYPER CORE TECH
  }

  function openSetupStudio() {
    closeStudio();
    stopPreviewTracks();
    aspectMode = '9:16';
    silenceHomeFeed();

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
              <div class="live-studio__host" data-live-host>
                <div class="live-studio__host-av" data-host-av></div>
                <div class="live-studio__host-meta">
                  <strong data-host-name>אני</strong>
                  <span class="live-studio__host-live">בשידור</span>
                </div>
              </div>
              <div class="live-studio__live-stats">
                <span class="live-studio__pill live-studio__pill--pulse">LIVE</span>
                <strong data-live-topic>שידור חי</strong>
                <span data-live-viewers>1 צופה</span>
                <span class="live-studio__like-count" data-live-likes title="לייקים">❤ 0</span>
              </div>
              <button type="button" class="live-studio__btn live-studio__btn--danger live-studio__btn--block" data-action="end">
                סיים שידור
              </button>
            </div>

            <div class="live-studio__chat" aria-label="תגובות השידור">
              <div class="live-studio__chat-head">צ'אט חי</div>
              <div class="live-studio__chat-list" id="liveStudioChatList" role="log" aria-live="polite">
                <div class="live-studio__chat-empty" data-chat-empty>עדיין אין תגובות</div>
              </div>
              <form class="live-studio__chat-compose" id="liveStudioChatForm" autocomplete="off">
                <input id="liveStudioChatInput" class="live-studio__chat-input" type="text" maxlength="280" placeholder="כתוב תגובה לצופים…" aria-label="תגובה">
                <button type="submit" class="live-studio__chat-send" aria-label="שלח">
                  <i class="fa-solid fa-paper-plane"></i>
                </button>
              </form>
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
    const chatForm = studio.querySelector('#liveStudioChatForm');
    if (chatForm) {
      chatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = studio.querySelector('#liveStudioChatInput');
        const text = String(input && input.value || '').trim();
        if (!text) return;
        if (input) input.value = '';
        const ok = await App.publishLiveChat(null, text);
        if (!ok && input) input.value = text;
      });
    }
    fillHostIdentityUi();

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
    if (!stream || typeof stream.getTracks !== 'function') return;
    const tracks = stream.getTracks();
    if (!tracks.length) return;
    // מחכים למסלול וידאו — אחרת כרטיס "מתחבר" בלי תמונה | HYPER CORE TECH
    const videoTracks = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
    const hasLiveVideo = videoTracks.some((t) => t && t.readyState !== 'ended');

    if (hasLiveVideo && verifyRoomId) {
      const meta = knownRooms.get(verifyRoomId);
      if (meta) {
        finishVerifySuccess(meta, stream);
      }
    }

    // תמיד מצמידים לכרטיס הקיים לפי roomId (גם אחרי retry / אחרי אימות) | HYPER CORE TECH
    try {
      const st = App.live && App.live.getState && App.live.getState();
      const roomId = (st && st.roomId) || verifyRoomId || null;
      if (roomId && hasLiveVideo) {
        attachRemoteStreamToLiveCards(roomId, stream);
      }
    } catch (_) {}

    try {
      const media = App._p2pLiveActiveMedia;
      if (!media || !hasLiveVideo) return;
      const videoEl = media.querySelector('video');
      if (!videoEl) return;
      if (videoEl.srcObject !== stream) videoEl.srcObject = stream;
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

  function attachRemoteStreamToLiveCards(roomId, stream) {
    if (!roomId || !stream) return;
    const safeId = `p2plive-${String(roomId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96)}`;
    App._p2pLivePendingStreams = App._p2pLivePendingStreams || new Map();
    App._p2pLivePendingStreams.set(safeId, stream);

    doc.querySelectorAll('.videos-feed__media[data-media-type="p2p-live"]').forEach((media) => {
      if (media.dataset.liveRoomId !== roomId) return;
      const videoEl = media.querySelector('video');
      if (!videoEl) return;
      if (videoEl.srcObject !== stream) videoEl.srcObject = stream;
      videoEl.setAttribute('playsinline', 'true');
      videoEl.muted = false;
      const play = () => videoEl.play().catch(() => {
        videoEl.muted = true;
        return videoEl.play().catch(() => {});
      });
      play();
      media.dataset.p2pLiveJoined = '1';
      media.classList.add('videos-feed__media--ready');
      media.classList.remove('videos-p2p-live--ended');
      const hint = media.querySelector('.videos-p2p-live-hint');
      if (hint) {
        hint.hidden = true;
        hint.textContent = 'מתחבר לשידור חי…';
      }
      const ended = media.querySelector('.videos-p2p-live-ended');
      if (ended) ended.remove();
      App._p2pLiveActiveMedia = media;
    });
  }

  App.onLiveStarted = function() {
    const timer = studio && studio.querySelector('[data-live-timer]');
    if (timer) timer.hidden = false;
    fillHostIdentityUi();
    clearHostChatHistory();
    try {
      const st = App.live && App.live.getState && App.live.getState();
      if (st && st.roomId) startLiveChatSub(st.roomId);
    } catch (_) {}
  };
  App.onLiveEnded = function(info) {
    stopTimer();
    stopLiveChatSub();
    clearHostChatHistory();
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

  App.onLiveIceFailed = async function(roomId) {
    // ניסיון חיבור מחדש לפני הודעת ניתוק — מהלוג: LIVE PC failed | HYPER CORE TECH
    try {
      const media = Array.from(doc.querySelectorAll('.videos-feed__media[data-media-type="p2p-live"]'))
        .find((m) => m.dataset.liveRoomId === roomId);
      if (media) {
        const hint = media.querySelector('.videos-p2p-live-hint');
        if (hint) {
          hint.hidden = false;
          hint.textContent = 'מתחבר מחדש לשידור…';
        }
        media.classList.remove('videos-p2p-live--ended');
        const ended = media.querySelector('.videos-p2p-live-ended');
        if (ended) ended.remove();
      }
      if (typeof App.live?.retryWatch === 'function') {
        const ok = await App.live.retryWatch();
        if (ok) {
          // אם כבר אומתנו — נשאיר verifying כדי ש־ontrack יעדכן כרטיס | HYPER CORE TECH
          if (roomId && verifiedRooms.has(roomId)) {
            verifyRoomId = roomId;
          }
          return;
        }
      }
    } catch (_) {}
    markViewerLiveEnded(roomId, 'החיבור לשידור נכשל');
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
    // אין כרטיס מאומת — מתחברים רק בלחיצה מפורשת (לא auto) | HYPER CORE TECH
    const nowSec = Math.floor(Date.now() / 1000);
    let started = false;
    knownRooms.forEach((meta) => {
      if (started || !meta || !meta.roomId) return;
      if (App.publicKey && String(meta.owner).toLowerCase() === String(App.publicKey).toLowerCase()) return;
      // דילוג על חדרים שסטטוס אחרון שלהם ישן מדי | HYPER CORE TECH
      const lastAt = roomLivePostAt.get(meta.roomId) || 0;
      if (lastAt && (nowSec - lastAt) > MAX_STATUS_AGE_SEC) return;
      started = App.requestLiveWatch(meta);
    });
    try {
      if (typeof App.showTransientFeedHint === 'function') {
        App.showTransientFeedHint(started ? 'מתחבר לשידור חי…' : 'אין שידור חי פעיל כרגע — לחצו על באנר הצפייה כשמופיע');
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
    const variants = ['❤', '💗', '💖', '💕'];
    heart.textContent = variants[Math.floor(Math.random() * variants.length)];
    const drift = (Math.random() * 70) - 35;
    const scale = 0.85 + Math.random() * 0.55;
    heart.style.setProperty('--hx', `${drift}px`);
    heart.style.setProperty('--hs', String(scale));
    layer.appendChild(heart);
    setTimeout(() => {
      try { heart.remove(); } catch (_) {}
    }, 2200);
  }

  function updateLikeCountUi() {
    const el = studio && studio.querySelector('[data-live-likes]');
    if (el) el.textContent = `❤ ${liveLikeCount}`;
  }

  function bumpLikeCount(n) {
    liveLikeCount = Math.max(0, liveLikeCount + (Number(n) || 1));
    updateLikeCountUi();
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

  function isStubName(name, pubkey) {
    const n = String(name || '').trim();
    if (!n) return true;
    if (/^משתמש\s+[0-9a-f]{6,16}$/i.test(n)) return true;
    if (/^[0-9a-f]{6,16}$/i.test(n)) return true;
    if (pubkey) {
      const pk = String(pubkey).toLowerCase();
      if (n.toLowerCase() === pk.slice(0, n.length) && n.length >= 6) return true;
    }
    return false;
  }

  function resolveLocalIdentity() {
    const prof = App.profile || {};
    const cached = (App.profileCache instanceof Map && App.publicKey)
      ? (App.profileCache.get(App.publicKey) || App.profileCache.get(String(App.publicKey).toLowerCase()) || {})
      : {};
    let name = String(prof.name || prof.display_name || cached.name || cached.display_name || '').trim();
    if (isStubName(name, App.publicKey)) name = '';
    if (!name && App.publicKey) name = `משתמש ${String(App.publicKey).slice(0, 8)}`;
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

  function profileDisplayName(profile, pubkey) {
    const p = profile || {};
    let name = String(p.name || p.display_name || '').trim();
    if (isStubName(name, pubkey)) name = '';
    return name || (pubkey ? `משתמש ${String(pubkey).slice(0, 8)}` : 'צופה');
  }

  function initialsFromName(name) {
    const s = String(name || '').trim();
    if (!s) return '?';
    const cleaned = s.replace(/^משתמש\s+/i, '');
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return cleaned.slice(0, 2).toUpperCase();
  }

  function fillHostIdentityUi() {
    if (!studio) return;
    const id = resolveLocalIdentity();
    const nameEl = studio.querySelector('[data-host-name]');
    if (nameEl) nameEl.textContent = id.name;
    const av = studio.querySelector('[data-host-av]');
    if (!av) return;
    av.innerHTML = '';
    if (id.picture) {
      const img = doc.createElement('img');
      img.src = id.picture;
      img.alt = '';
      img.onerror = () => { av.textContent = initialsFromName(id.name); img.remove(); };
      av.appendChild(img);
    } else {
      av.textContent = initialsFromName(id.name);
    }
  }

  function appendChatMessage(author, text, picture, opts) {
    const list = studio && studio.querySelector('#liveStudioChatList');
    if (!list) return;
    const empty = list.querySelector('[data-chat-empty]');
    if (empty) empty.remove();
    const row = doc.createElement('div');
    row.className = 'live-studio__chat-item';
    if (opts && opts.self) row.classList.add('is-self');
    if (opts && opts.eventId) row.dataset.eventId = opts.eventId;
    if (opts && opts.pubkey) row.dataset.pubkey = opts.pubkey;

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
    scrollChatListToBottom(list);
  }

  function enrichChatRowFromProfile(pubkey, profile) {
    if (!studio || !pubkey || !profile) return;
    const name = profileDisplayName(profile, pubkey);
    const picture = String(profile.picture || '').trim();
    studio.querySelectorAll(`.live-studio__chat-item[data-pubkey="${pubkey}"]`).forEach((row) => {
      const who = row.querySelector('strong');
      if (who && !isStubName(name, pubkey)) who.textContent = name.slice(0, 24);
      const av = row.querySelector('.live-studio__chat-avatar');
      if (av && picture && !av.querySelector('img')) {
        av.textContent = '';
        const img = doc.createElement('img');
        img.src = picture;
        img.alt = '';
        av.appendChild(img);
      }
    });
  }

  function closeChatSubHandle(sub) {
    if (!sub) return;
    try {
      if (typeof sub.close === 'function') sub.close();
      else if (typeof sub.unsub === 'function') sub.unsub();
      else if (typeof sub.unsubscribe === 'function') sub.unsubscribe();
    } catch (_) {}
  }

  function clearHostChatHistory() {
    hostChatHistory = [];
  }

  function recordHostChatMessage({ eventId, pubkey, author, text, picture, createdAt }) {
    const msg = {
      id: String(eventId || `${pubkey || ''}-${createdAt || Date.now()}-${String(text || '').slice(0, 12)}`),
      pubkey: String(pubkey || ''),
      author: String(author || 'צופה').slice(0, 48),
      text: String(text || '').slice(0, 280),
      picture: (() => {
        const p = String(picture || '').trim();
        if (!p || p.startsWith('data:') || p.length > 500) return '';
        return p;
      })(),
      createdAt: Number(createdAt) || Math.floor(Date.now() / 1000)
    };
    if (!msg.text) return;
    if (hostChatHistory.some((m) => m.id === msg.id)) return;
    hostChatHistory.push(msg);
    if (hostChatHistory.length > HOST_CHAT_HISTORY_MAX) {
      hostChatHistory = hostChatHistory.slice(-HOST_CHAT_HISTORY_MAX);
    }
  }

  App.getLiveChatHistorySnapshot = function() {
    return hostChatHistory.slice();
  };

  App.onLiveChatHistoryFromPeer = function(payload) {
    try {
      const roomId = payload && payload.roomId;
      const messages = payload && Array.isArray(payload.messages) ? payload.messages : [];
      if (!roomId || !messages.length) return;
      console.log('LIVE: chat history received via DC', messages.length);
      const entry = viewerChatByRoom.get(roomId) || { sub: null, medias: new Set(), seen: new Set() };
      if (!viewerChatByRoom.has(roomId)) viewerChatByRoom.set(roomId, entry);
      messages.forEach((m) => {
        if (!m || !m.text) return;
        const id = String(m.id || '');
        if (id && entry.seen.has(id)) return;
        if (id) entry.seen.add(id);
        const author = String(m.author || 'צופה');
        const picture = String(m.picture || '');
        const self = !!(App.publicKey && m.pubkey && String(m.pubkey).toLowerCase() === String(App.publicKey).toLowerCase());
        if (entry.medias && entry.medias.size) {
          entry.medias.forEach((media) => {
            if (media && media.isConnected) appendViewerOverlayMessage(media, author, m.text, picture, self);
          });
        } else {
          // עדיין אין overlay — נשמור לרגע ה־attach | HYPER CORE TECH
          if (!entry.pendingHistory) entry.pendingHistory = [];
          entry.pendingHistory.push({ author, text: m.text, picture, self, id });
        }
      });
    } catch (e) {
      console.warn('LIVE: apply chat history failed', e);
    }
  };

  function chatHistorySince() {
    // רק הודעות חדשות דרך ריליי — היסטוריה ב־DC | HYPER CORE TECH
    return Math.floor(Date.now() / 1000) - LIVE_CHAT_LIVE_LOOKBACK_SEC;
  }

  function scrollChatListToBottom(list) {
    if (!list) return;
    const go = () => {
      try { list.scrollTop = list.scrollHeight; } catch (_) {}
    };
    go();
    requestAnimationFrame(() => {
      go();
      setTimeout(go, 50);
    });
  }

  function stopLiveChatSub() {
    closeChatSubHandle(chatSub);
    chatSub = null;
    activeChatRoomId = null;
    seenLiveEventIds.clear();
    liveLikeCount = 0;
    updateLikeCountUi();
  }

  function startLiveChatSub(roomId) {
    if (!roomId || !App.pool || !Array.isArray(App.relayUrls)) return;
    if (activeChatRoomId === roomId && chatSub) return;
    closeChatSubHandle(chatSub);
    chatSub = null;
    activeChatRoomId = roomId;
    seenLiveEventIds.clear();
    liveLikeCount = 0;
    updateLikeCountUi();
    clearChatUi();
    fillHostIdentityUi();
    const since = chatHistorySince();
    try {
      chatSub = App.pool.subscribeMany(
        App.relayUrls,
        [{ kinds: [25051], '#r': [roomId], since }],
        {
          onevent: (ev) => {
            try {
              if (!ev || !ev.id) return;
              if (seenLiveEventIds.has(ev.id)) return;
              seenLiveEventIds.add(ev.id);
              if (seenLiveEventIds.size > 800) {
                const first = seenLiveEventIds.values().next().value;
                seenLiveEventIds.delete(first);
              }

              const tType = ev.tags.find((t) => t[0] === 'type');
              if (!tType) return;
              const tRoom = ev.tags.find((t) => t[0] === 'r');
              if (!tRoom || tRoom[1] !== roomId) return;
              const kind = tType[1];

              if (kind === 'live-like') {
                if (App.publicKey && String(ev.pubkey).toLowerCase() === String(App.publicKey).toLowerCase()) return;
                bumpLikeCount(1);
                spawnFloatingHeart();
                spawnFloatingHeart();
                return;
              }

              if (kind === 'live-end') {
                if (shouldAcceptLiveEnd(roomId, ev)) {
                  markViewerLiveEnded(roomId, 'השידור הסתיים');
                }
                return;
              }

              if (kind !== 'live-chat') return;
              let payload = {};
              try { payload = JSON.parse(ev.content || '{}'); } catch (_) {}
              const text = payload.text || '';
              if (!text) return;
              const cached = lookupProfileSync(ev.pubkey);
              let author = String(payload.name || '').trim();
              if (isStubName(author, ev.pubkey)) author = '';
              author = author || profileDisplayName(cached, ev.pubkey);
              const picture = String(payload.picture || cached.picture || '').trim();
              const self = !!(App.publicKey && String(ev.pubkey).toLowerCase() === String(App.publicKey).toLowerCase());
              appendChatMessage(author, text, picture, { eventId: ev.id, pubkey: ev.pubkey, self });
              // משדר שומר היסטוריה מקומית לשליחה ב־P2P | HYPER CORE TECH
              try {
                const st = App.live && App.live.getState && App.live.getState();
                if (st && st.role === 'broadcaster') {
                  recordHostChatMessage({
                    eventId: ev.id,
                    pubkey: ev.pubkey,
                    author,
                    text,
                    picture,
                    createdAt: ev.created_at
                  });
                }
              } catch (_) {}
              if ((isStubName(author, ev.pubkey) || !picture) && typeof App.fetchProfile === 'function') {
                App.fetchProfile(ev.pubkey).then((p) => {
                  if (p) enrichChatRowFromProfile(ev.pubkey, p);
                }).catch(() => null);
              }
            } catch (_) {}
          },
          oneose: () => {
            const list = studio && studio.querySelector('#liveStudioChatList');
            scrollChatListToBottom(list);
          }
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
      // תמונת data: גדולה לא נשלחת — שם חובה; הצופים משלימים מתמונת פרופיל | HYPER CORE TECH
      const picture = (id.picture && id.picture.length < 2500 && !id.picture.startsWith('data:'))
        ? id.picture
        : (id.picture && id.picture.startsWith('data:') && id.picture.length < 2500 ? id.picture : '');
      const content = JSON.stringify({
        text: msg.slice(0, 280),
        name: id.name,
        picture,
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
      // שמירה מקומית אצל משדר לשליחה ב־P2P לצופים חדשים | HYPER CORE TECH
      try {
        const st = App.live && App.live.getState && App.live.getState();
        if (st && st.role === 'broadcaster') {
          recordHostChatMessage({
            eventId: signed.id,
            pubkey: App.publicKey,
            author: id.name,
            text: msg.slice(0, 280),
            picture,
            createdAt: signed.created_at
          });
        }
      } catch (_) {}
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
    knownRooms.delete(roomId);
    roomLivePostAt.delete(roomId);
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

  function shouldAcceptLiveEnd(roomId, ev) {
    const created = Number(ev && ev.created_at) || 0;
    if (!created) return false;
    const age = Math.floor(Date.now() / 1000) - created;
    // אירועי סיום ישנים מאותו roomId (שידור קודם) — מתעלמים | HYPER CORE TECH
    if (age > MAX_LIVE_END_AGE_SEC) return false;
    const postAt = roomLivePostAt.get(roomId) || 0;
    if (postAt && created < postAt) return false;
    return true;
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

    const upsert = (enriched) => {
      if (typeof App.upsertP2pLiveFeedCard === 'function') {
        App.upsertP2pLiveFeedCard({
          ...enriched,
          streamReady: true,
          cardId: safeId
        });
      }
      // אחרי רינדור כרטיס — מצמידים שוב (מונע "מתחבר" בלי וידאו) | HYPER CORE TECH
      try { attachRemoteStreamToLiveCards(meta.roomId, stream); } catch (_) {}
    };

    upsert(meta);
    if (typeof App.fetchProfile === 'function' && meta.owner) {
      App.fetchProfile(meta.owner).then((p) => {
        if (!p) return;
        const enriched = {
          ...meta,
          name: p.name || p.display_name || meta.name || '',
          picture: p.picture || meta.picture || ''
        };
        knownRooms.set(meta.roomId, enriched);
        verifiedRooms.set(meta.roomId, { ...enriched, verifiedAt: Date.now() });
        upsert(enriched);
      }).catch(() => null);
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
    const created = Number(ev.created_at || 0);
    const prev = roomLivePostAt.get(meta.roomId) || 0;
    if (created >= prev) roomLivePostAt.set(meta.roomId, created);
    knownRooms.set(meta.roomId, meta);
    // באנר בלבד — בלי WebRTC אוטומטי (שומר על P2P צ'אט/שיחות) | HYPER CORE TECH
    showLiveStartedBanner(meta);
  }

  // heartbeat live-status — מעדכן knownRooms לצופים מאוחרים; בלי watch אוטומטי | HYPER CORE TECH
  function maybeQueueFromStatus(ev, meta) {
    const age = Math.floor(Date.now() / 1000) - Number(ev.created_at || 0);
    meta._ageSec = age;
    if (age > MAX_STATUS_AGE_SEC) return;
    if (!meta.owner || !meta.roomId) return;
    const created = Number(ev.created_at || 0);
    const prev = roomLivePostAt.get(meta.roomId) || 0;
    if (created >= prev) roomLivePostAt.set(meta.roomId, created);
    const existing = knownRooms.get(meta.roomId) || {};
    const merged = {
      ...existing,
      ...meta,
      name: meta.name || existing.name || '',
      picture: meta.picture || existing.picture || '',
      title: meta.title || existing.title || 'שידור חי',
      _ageSec: age
    };
    knownRooms.set(meta.roomId, merged);
    showLiveStartedBanner(merged);
  }

  App.requestLiveWatch = function(metaOrRoom) {
    const meta = (metaOrRoom && metaOrRoom.roomId)
      ? metaOrRoom
      : (typeof metaOrRoom === 'string' ? knownRooms.get(metaOrRoom) : null);
    if (!meta) return false;
    knownRooms.set(meta.roomId, meta);
    queueVerify(meta);
    return true;
  };

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
      // רק מטא גילוי — לא live-chat/like (לא מציפים discovery) | HYPER CORE TECH
      if (type !== 'live-post' && type !== 'live-status' && type !== 'live-end') return;
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
      if (type === 'live-status') {
        maybeQueueFromStatus(ev, meta);
        return;
      }
      if (type === 'live-end') {
        if (shouldAcceptLiveEnd(roomId, ev)) {
          markViewerLiveEnded(roomId, 'השידור הסתיים');
        }
      }
    } catch (e) {
      console.warn('live discovery event failed', e);
    }
  }

  // צ'אט צופים מעל הווידאו (TikTok-style) — לא דוחף את הווידאו | HYPER CORE TECH
  const viewerChatByRoom = new Map(); // roomId -> { sub, medias:Set, seen:Set }

  function ensureViewerChatOverlay(mediaDiv) {
    if (!mediaDiv) return null;
    let overlay = mediaDiv.querySelector('.videos-p2p-live-overlay');
    if (overlay) return overlay;
    overlay = doc.createElement('div');
    overlay.className = 'videos-p2p-live-overlay';
    overlay.innerHTML = `
      <div class="videos-p2p-live-chat-list" data-live-chat-list></div>
      <div class="videos-p2p-live-hearts" data-live-viewer-hearts aria-hidden="true"></div>
      <form class="videos-p2p-live-compose" data-live-chat-form autocomplete="off">
        <input class="videos-p2p-live-compose__input" type="text" maxlength="280" placeholder="הוסף תגובה…" aria-label="תגובה לשידור">
        <button type="submit" class="videos-p2p-live-compose__send" aria-label="שלח">
          <i class="fa-solid fa-paper-plane"></i>
        </button>
      </form>`;
    mediaDiv.appendChild(overlay);
    mediaDiv.classList.add('videos-p2p-live--with-chat');
    return overlay;
  }

  function appendViewerOverlayMessage(mediaDiv, author, text, picture, self) {
    const list = mediaDiv && mediaDiv.querySelector('[data-live-chat-list]');
    if (!list) return;
    const row = doc.createElement('div');
    row.className = 'videos-p2p-live-chat-item' + (self ? ' is-self' : '');
    const av = doc.createElement('span');
    av.className = 'videos-p2p-live-chat-av';
    const pic = String(picture || '').trim();
    if (pic) {
      const img = doc.createElement('img');
      img.src = pic;
      img.alt = '';
      img.onerror = () => { av.textContent = initialsFromName(author); img.remove(); };
      av.appendChild(img);
    } else {
      av.textContent = initialsFromName(author);
    }
    const body = doc.createElement('span');
    body.className = 'videos-p2p-live-chat-bubble';
    const who = doc.createElement('strong');
    who.textContent = String(author || 'צופה').slice(0, 20);
    const msg = doc.createElement('span');
    msg.textContent = String(text || '').slice(0, 280);
    body.appendChild(who);
    body.appendChild(msg);
    row.appendChild(av);
    row.appendChild(body);
    list.appendChild(row);
    while (list.children.length > 40) list.firstChild.remove();
    scrollChatListToBottom(list);
  }

  function spawnViewerHeart(mediaDiv) {
    const layer = mediaDiv && mediaDiv.querySelector('[data-live-viewer-hearts]');
    if (!layer) return;
    const heart = doc.createElement('span');
    heart.className = 'videos-p2p-live-heart';
    heart.textContent = '❤';
    heart.style.setProperty('--hx', `${(Math.random() * 60) - 30}px`);
    layer.appendChild(heart);
    setTimeout(() => { try { heart.remove(); } catch (_) {} }, 2000);
  }

  function broadcastOverlayEvent(roomId, handler) {
    const entry = viewerChatByRoom.get(roomId);
    if (!entry) return;
    entry.medias.forEach((media) => {
      if (media && media.isConnected) handler(media);
    });
  }

  function ensureViewerRoomSub(roomId) {
    if (!roomId || !App.pool || !Array.isArray(App.relayUrls)) return null;
    let entry = viewerChatByRoom.get(roomId);
    if (entry && entry.sub) return entry;
    entry = entry || { sub: null, medias: new Set(), seen: new Set() };
    viewerChatByRoom.set(roomId, entry);
    const since = chatHistorySince();
    try {
      entry.sub = App.pool.subscribeMany(
        App.relayUrls,
        [{ kinds: [25051], '#r': [roomId], since }],
        {
          onevent: (ev) => {
            try {
              if (!ev || !ev.id || entry.seen.has(ev.id)) return;
              entry.seen.add(ev.id);
              if (entry.seen.size > 600) {
                const first = entry.seen.values().next().value;
                entry.seen.delete(first);
              }
              const tType = ev.tags.find((t) => t[0] === 'type');
              if (!tType) return;
              const kind = tType[1];
              if (kind === 'live-like') {
                if (App.publicKey && String(ev.pubkey).toLowerCase() === String(App.publicKey).toLowerCase()) return;
                broadcastOverlayEvent(roomId, spawnViewerHeart);
                return;
              }
              if (kind === 'live-end') {
                if (shouldAcceptLiveEnd(roomId, ev)) {
                  markViewerLiveEnded(roomId, 'השידור הסתיים');
                }
                return;
              }
              if (kind !== 'live-chat') return;
              let payload = {};
              try { payload = JSON.parse(ev.content || '{}'); } catch (_) {}
              const text = payload.text || '';
              if (!text) return;
              const cached = lookupProfileSync(ev.pubkey);
              let author = String(payload.name || '').trim();
              if (isStubName(author, ev.pubkey)) author = '';
              author = author || profileDisplayName(cached, ev.pubkey);
              const picture = String(payload.picture || cached.picture || '').trim();
              const self = !!(App.publicKey && String(ev.pubkey).toLowerCase() === String(App.publicKey).toLowerCase());
              broadcastOverlayEvent(roomId, (media) => {
                appendViewerOverlayMessage(media, author, text, picture, self);
              });
              if ((isStubName(author, ev.pubkey) || !picture) && typeof App.fetchProfile === 'function') {
                App.fetchProfile(ev.pubkey).catch(() => null);
              }
            } catch (_) {}
          },
          oneose: () => {
            broadcastOverlayEvent(roomId, (media) => {
              scrollChatListToBottom(media.querySelector('[data-live-chat-list]'));
            });
          }
        }
      );
    } catch (e) {
      console.warn('viewer live chat sub failed', e);
    }
    return entry;
  }

  App.attachP2pLiveViewerChat = function(mediaDiv, roomId) {
    if (!mediaDiv || !roomId) return;
    const overlay = ensureViewerChatOverlay(mediaDiv);
    if (!overlay) return;
    mediaDiv.dataset.liveChatRoom = roomId;
    const entry = ensureViewerRoomSub(roomId) || { medias: new Set(), seen: new Set(), sub: null };
    entry.medias.add(mediaDiv);
    viewerChatByRoom.set(roomId, entry);
    // היסטוריה שכבר הגיעה ב־DC לפני שה־overlay היה מוכן | HYPER CORE TECH
    if (Array.isArray(entry.pendingHistory) && entry.pendingHistory.length) {
      entry.pendingHistory.forEach((m) => {
        if (!m || !m.text) return;
        if (m.id && entry.seen.has(m.id)) return;
        if (m.id) entry.seen.add(m.id);
        appendViewerOverlayMessage(mediaDiv, m.author, m.text, m.picture, m.self);
      });
      entry.pendingHistory = [];
      scrollChatListToBottom(mediaDiv.querySelector('[data-live-chat-list]'));
    }

    const form = overlay.querySelector('[data-live-chat-form]');
    if (form && form.dataset.bound !== '1') {
      form.dataset.bound = '1';
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof App.requireAuth === 'function' && !App.requireAuth('כדי לכתוב בשידור חי צריך להתחבר.')) {
        return;
      }
        const input = form.querySelector('input');
        const text = String(input && input.value || '').trim();
        if (!text) return;
        if (input) input.value = '';
        const ok = await App.publishLiveChat(roomId, text);
        if (!ok && input) input.value = text;
      });
      // מונע גלילת פיד בזמן הקלדה | HYPER CORE TECH
      form.addEventListener('pointerdown', (e) => e.stopPropagation());
      form.addEventListener('click', (e) => e.stopPropagation());
    }
  };

  App.focusP2pLiveViewerChat = function(mediaDiv) {
    if (!mediaDiv) return false;
    ensureViewerChatOverlay(mediaDiv);
    const input = mediaDiv.querySelector('.videos-p2p-live-compose__input');
    if (!input) return false;
    mediaDiv.classList.add('videos-p2p-live--chat-focus');
    try { input.focus(); } catch (_) {}
    return true;
  };

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
