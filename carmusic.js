(function initCarMusic(window) {
  // חלק יישום CARMUSIC (carmusic.js) – אחראי על ניהול נגן הפלייליסטים למסך המגע ברכב
  const STORAGE_KEY = 'carmusic.playlists';
  const STATUS_KEY = 'carmusic.lastStatus';
  const HYDRATION_TIMEOUT = 16000;

  const state = {
    playlists: [],
    currentIndex: -1,
    player: null,
    isShuffle: false,
    hydrating: new Map(),
  };

  const refs = {
    clock: document.getElementById('carClock'),
    connection: document.getElementById('carConnection'),
    playlistStatus: document.getElementById('playlistStatus'),
    trackTitle: document.getElementById('trackTitle'),
    trackSubtitle: document.getElementById('trackSubtitle'),
    tickerDuplicate: document.querySelector('.ticker__item--duplicate'),
    headlineTicker: document.getElementById('headlineTickerContent'),
    headlineDuplicate: document.querySelector('.car-headline-ticker__duplicate'),
    playerFrame: document.getElementById('carPlayer'),
    playPause: document.getElementById('playPauseBtn'),
    prevTrack: document.getElementById('prevTrackBtn'),
    nextTrack: document.getElementById('nextTrackBtn'),
    prevPlaylist: document.getElementById('prevPlaylistBtn'),
    nextPlaylist: document.getElementById('nextPlaylistBtn'),
    shuffle: document.getElementById('shuffleBtn'),
    statusPlaylist: document.getElementById('statusPlaylistLabel'),
    statusTrack: document.getElementById('statusTrackLabel'),
    statusMode: document.getElementById('statusModeLabel'),
    libraryList: document.getElementById('playlistList'),
    emptyState: document.getElementById('emptyState'),
    openDrawer: document.getElementById('openDrawerBtn'),
    drawer: document.getElementById('playlistDrawer'),
    drawerClose: document.getElementById('closeDrawerBtn'),
    drawerInput: document.getElementById('playlistInput'),
    drawerSave: document.getElementById('savePlaylistBtn'),
    drawerClear: document.getElementById('clearPlaylistBtn'),
    drawerStatus: document.getElementById('drawerStatus'),
    template: document.getElementById('playlistCardTemplate'),
  };

  // חלק שעון וחיבור (carmusic.js) – מעדכן שעה וחיבור בזמן אמת
  function startClock() {
    updateClock();
    window.setInterval(updateClock, 30000);
  }

  function updateClock() {
    if (!refs.clock) return;
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    refs.clock.textContent = `${hours}:${minutes}`;
  }

  function updateConnectionStatus() {
    if (!refs.connection) return;
    const online = window.navigator.onLine;
    refs.connection.textContent = online ? 'ONLINE' : 'OFFLINE';
    refs.connection.classList.toggle('is-offline', !online);
  }

  // חלק אחסון (carmusic.js) – קריאה וכתיבה של רשימות ההשמעה
  function loadPlaylists() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        state.playlists = [];
        return;
      }
      const parsed = JSON.parse(raw);
      state.playlists = Array.isArray(parsed) ? parsed.map(normalizeRecord).filter(Boolean) : [];
    } catch (err) {
      console.warn('CARMUSIC: טעינת פלייליסטים נכשלה', err);
      state.playlists = [];
    }
  }

  function savePlaylists() {
    try {
      const payload = JSON.stringify(state.playlists);
      window.localStorage.setItem(STORAGE_KEY, payload);
    } catch (err) {
      console.warn('CARMUSIC: שמירת פלייליסטים נכשלה', err);
    }
  }

  function saveStatusSnapshot() {
    const snapshot = {
      playlist: state.playlists[state.currentIndex]?.name || '',
      track: refs.trackTitle?.textContent || '',
      mode: refs.statusMode?.textContent || '',
      updatedAt: Date.now(),
    };
    try {
      window.localStorage.setItem(STATUS_KEY, JSON.stringify(snapshot));
    } catch (err) {
      console.warn('CARMUSIC: שמירת סטטוס נכשלה', err);
    }
  }

  function normalizeRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const id = extractPlaylistId(record.id || record.playlistId || '');
    if (!id) return null;
    return {
      id,
      name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id,
      thumbnail: typeof record.thumbnail === 'string' ? record.thumbnail : '',
    };
  }

  // חלק נגן (carmusic.js) – יצירת נגן YouTube ושליטה בו
  function ensurePlayerLoaded() {
    if (!state.playlists.length) {
      destroyPlayer();
      setDefaultTrackInfo();
      return;
    }
    if (state.currentIndex < 0) {
      state.currentIndex = 0;
    }
    if (!state.player && window.YT && typeof window.YT.Player === 'function') {
      createPlayer(state.playlists[state.currentIndex].id);
      return;
    }
    if (state.player && state.playlists[state.currentIndex]) {
      state.player.loadPlaylist({ listType: 'playlist', list: state.playlists[state.currentIndex].id });
      updatePlaylistStatus();
      setTrackInfoLoading();
    }
  }

  function createPlayer(listId) {
    const playerVars = {
      autoplay: 0,
      controls: 1,
      disablekb: 1,
      listType: 'playlist',
      list: listId,
      modestbranding: 1,
      playsinline: 1,
    };
    if (window.location && window.location.origin && window.location.origin !== 'null') {
      playerVars.origin = window.location.origin;
    }

    state.player = new window.YT.Player('carPlayer', {
      height: '280',
      width: '480',
      host: 'https://www.youtube-nocookie.com',
      playerVars,
      events: {
        onReady: handlePlayerReady,
        onStateChange: handlePlayerStateChange,
        onError: handlePlayerError,
      },
    });
  }

  function destroyPlayer() {
    if (state.player && typeof state.player.destroy === 'function') {
      try {
        state.player.destroy();
      } catch (err) {
        console.warn('CARMUSIC: כשל במחיקת הנגן', err);
      }
    }
    state.player = null;
  }

  function handlePlayerReady() {
    updatePlaylistStatus();
    updateModeLabel('מנגן');
    try {
      const iframe = state.player?.getIframe?.();
      if (iframe) {
        iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
        iframe.setAttribute('referrerpolicy', 'origin');
      }
    } catch (err) {
      console.warn('CARMUSIC: cannot decorate iframe', err);
    }
    if (state.playlists[state.currentIndex]) {
      hydratePlaylistMetadata(state.playlists[state.currentIndex].id);
    }
  }

  function handlePlayerStateChange(event) {
    switch (event.data) {
      case window.YT.PlayerState.PLAYING:
        updateModeLabel('מנגן');
        setPlayButtonIcon(true);
        updateTrackInfoFromPlayer();
        break;
      case window.YT.PlayerState.PAUSED:
        updateModeLabel('מושהה');
        setPlayButtonIcon(false);
        break;
      case window.YT.PlayerState.BUFFERING:
        updateModeLabel('טוען');
        setTrackInfoLoading();
        break;
      case window.YT.PlayerState.ENDED:
        updateModeLabel('עצור');
        setPlayButtonIcon(false);
        break;
      default:
        break;
    }
    saveStatusSnapshot();
  }

  function handlePlayerError(event) {
    const code = event?.data;
    const messages = {
      2: 'קישור הפלייליסט אינו תקין.',
      100: 'הפלייליסט אינו זמין כעת.',
      101: 'הבעלים חסם הטמעה של התוכן.',
      150: 'הבעלים חסם הטמעה של התוכן.',
      153: 'לא ניתן להעלות את הפלייליסט למסך.',
    };
    setTrackInfo('שגיאה בהשמעה', messages[code] || 'התרחשה שגיאה לא צפויה.');
    updateModeLabel('שגיאה');
    setPlayButtonIcon(false);
  }

  // חלק בקרים (carmusic.js) – פעולות כפתורי השליטה המרכזיים
  function togglePlayPause() {
    if (!state.playlists.length) {
      openDrawer();
      return;
    }
    if (!state.player) {
      ensurePlayerLoaded();
      return;
    }
    const playerState = state.player.getPlayerState();
    if (playerState === window.YT.PlayerState.PLAYING || playerState === window.YT.PlayerState.BUFFERING) {
      state.player.pauseVideo();
    } else {
      state.player.playVideo();
    }
  }

  function nextTrack() {
    if (state.player && typeof state.player.nextVideo === 'function') {
      state.player.nextVideo();
    }
  }

  function previousTrack() {
    if (state.player && typeof state.player.previousVideo === 'function') {
      state.player.previousVideo();
    }
  }

  function nextPlaylist() {
    if (!state.playlists.length) return;
    state.currentIndex = (state.currentIndex + 1) % state.playlists.length;
    persistAndPlayCurrentPlaylist();
  }

  function previousPlaylist() {
    if (!state.playlists.length) return;
    state.currentIndex = (state.currentIndex - 1 + state.playlists.length) % state.playlists.length;
    persistAndPlayCurrentPlaylist();
  }

  function toggleShuffle() {
    state.isShuffle = !state.isShuffle;
    if (refs.shuffle) {
      refs.shuffle.classList.toggle('active', state.isShuffle);
      refs.shuffle.setAttribute('aria-pressed', String(state.isShuffle));
    }
    if (state.isShuffle && state.player && typeof state.player.getPlaylist === 'function') {
      const playlist = state.player.getPlaylist();
      if (Array.isArray(playlist) && playlist.length) {
        const randomIndex = Math.floor(Math.random() * playlist.length);
        state.player.playVideoAt(randomIndex);
      }
    }
  }

  function persistAndPlayCurrentPlaylist() {
    renderPlaylists();
    ensurePlayerLoaded();
    savePlaylists();
    updatePlaylistStatus();
  }

  // חלק מידע מסך (carmusic.js) – עדכון טקסטים וסטטוסים חזותיים
  function setPlayButtonIcon(isPlaying) {
    if (!refs.playPause) return;
    refs.playPause.textContent = isPlaying ? '⏸' : '▶';
    refs.playPause.setAttribute('aria-label', isPlaying ? 'השהה' : 'נגן');
  }

  function setTrackInfo(title, subtitle) {
    if (refs.trackTitle) refs.trackTitle.textContent = title;
    if (refs.trackSubtitle) refs.trackSubtitle.textContent = subtitle;
    updateTickerDuplicate(title, subtitle);
    updateHeadlineTicker(title, subtitle);
  }

  function setDefaultTrackInfo() {
    setTrackInfo('בחרו רשימת השמעה כדי להתחיל', 'אין נתונים זמינים');
    updateModeLabel('עצור');
    if (refs.statusTrack) refs.statusTrack.textContent = '—';
    updateHeadlineTicker('SOS CARMUSIC', 'אין פלייליסט פעיל כרגע');
  }

  function setTrackInfoLoading() {
    setTrackInfo('טוען רצועה...', 'מתחבר ל-YouTube');
    if (refs.statusTrack) refs.statusTrack.textContent = 'טוען...';
  }

  function updateModeLabel(value) {
    if (refs.statusMode) refs.statusMode.textContent = value;
  }

  function updatePlaylistStatus() {
    const current = state.playlists[state.currentIndex];
    const label = current ? current.name : 'אין רשימה פעילה';
    if (refs.playlistStatus) refs.playlistStatus.textContent = label;
    if (refs.statusPlaylist) refs.statusPlaylist.textContent = current ? formatIdentifier(current.id) : '—';
    if (!current) {
      updateHeadlineTicker('SOS CARMUSIC', 'אין פלייליסט פעיל כרגע');
    }
  }

  function updateTrackInfoFromPlayer() {
    if (!state.player || typeof state.player.getVideoData !== 'function') {
      setTrackInfo('רצועה מתנגנת', 'פרטים אינם זמינים');
      return;
    }
    const data = state.player.getVideoData();
    const title = data?.title || 'רצועה מתנגנת';
    const author = data?.author ? `ערוץ: ${data.author}` : 'YouTube';
    const total = typeof state.player.getPlaylist === 'function' ? state.player.getPlaylist()?.length || 0 : 0;
    const index = typeof state.player.getPlaylistIndex === 'function' ? state.player.getPlaylistIndex() : -1;
    const position = total && index >= 0 ? `שיר ${index + 1} מתוך ${total}` : '';
    const subtitle = position ? `${author} • ${position}` : author;
    setTrackInfo(title, subtitle);
    if (refs.statusTrack) refs.statusTrack.textContent = title;
  }

  // חלק טיקר (carmusic.js) – מעתיק את התוכן לפס הריצה המשוכפל לקבלת אנימציה רציפה
  function updateTickerDuplicate(title, subtitle) {
    if (!refs.tickerDuplicate) {
      refs.tickerDuplicate = document.querySelector('.ticker__item--duplicate');
    }
    if (!refs.tickerDuplicate) {
      return;
    }
    const parts = [title].filter(Boolean);
    if (subtitle) {
      parts.push(subtitle);
    }
    refs.tickerDuplicate.textContent = parts.join(' • ');
  }

  // חלק פס כותרת (carmusic.js) – מציג את כל המידע בשורת ריצה יחידה
  function updateHeadlineTicker(title, subtitle) {
    if (!refs.headlineTicker) {
      refs.headlineTicker = document.getElementById('headlineTickerContent');
    }
    if (!refs.headlineDuplicate) {
      refs.headlineDuplicate = document.querySelector('.car-headline-ticker__duplicate');
    }
    if (!refs.headlineTicker || !refs.headlineDuplicate) {
      return;
    }
    const playlistName = state.playlists[state.currentIndex]?.name;
    const segments = [
      'SOS CARMUSIC',
      playlistName || 'אין פלייליסט פעיל',
      title || 'אין פרטי שיר',
      subtitle || ''
    ].filter(Boolean);
    const line = segments.join(' • ');
    refs.headlineTicker.textContent = line;
    refs.headlineDuplicate.textContent = line;
  }

  // חלק ספריית פלייליסטים (carmusic.js) – רינדור ובחירה של כרטיסי הפלייליסט
  function renderPlaylists() {
    if (!refs.libraryList || !refs.template) return;
    refs.libraryList.innerHTML = '';
    const hasPlaylists = state.playlists.length > 0;
    if (refs.emptyState) refs.emptyState.hidden = hasPlaylists;
    if (!hasPlaylists) {
      state.currentIndex = -1;
      savePlaylists();
      setDefaultTrackInfo();
      return;
    }
    state.playlists.forEach((playlist, index) => {
      const instance = refs.template.content.firstElementChild.cloneNode(true);
      instance.dataset.playlistId = playlist.id;
      instance.classList.toggle('is-active', index === state.currentIndex);
      const thumb = instance.querySelector('.playlist-card__thumb');
      const name = instance.querySelector('.playlist-card__name');
      const meta = instance.querySelector('.playlist-card__meta');
      if (thumb) {
        if (playlist.thumbnail) {
          thumb.style.setProperty('background-image', `url('${playlist.thumbnail}')`);
        } else {
          thumb.style.removeProperty('background-image');
        }
      }
      if (name) name.textContent = playlist.name;
      if (meta) meta.textContent = formatIdentifier(playlist.id);
      instance.addEventListener('click', () => {
        state.currentIndex = index;
        persistAndPlayCurrentPlaylist();
      });
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'playlist-card__remove';
      removeBtn.textContent = 'מחק';
      removeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        removePlaylist(index);
      });
      instance.appendChild(removeBtn);
      refs.libraryList.appendChild(instance);
      hydratePlaylistMetadata(playlist.id);
    });
  }

  function removePlaylist(targetIndex) {
    if (targetIndex < 0 || targetIndex >= state.playlists.length) return;
    state.playlists.splice(targetIndex, 1);
    if (!state.playlists.length) {
      state.currentIndex = -1;
      destroyPlayer();
    } else if (state.currentIndex >= state.playlists.length) {
      state.currentIndex = state.playlists.length - 1;
    }
    savePlaylists();
    renderPlaylists();
    ensurePlayerLoaded();
    updatePlaylistStatus();
  }

  // חלק מגירת הוספה (carmusic.js) – פתיחה, אימות ושמירה של פלייליסט חדשים
  function openDrawer() {
    if (!refs.drawer) return;
    refs.drawer.classList.add('open');
    refs.drawer.setAttribute('aria-hidden', 'false');
    if (refs.drawerInput) {
      refs.drawerInput.value = '';
      refs.drawerInput.focus();
    }
    setDrawerStatus('');
  }

  function closeDrawer() {
    if (!refs.drawer) return;
    refs.drawer.classList.remove('open');
    refs.drawer.setAttribute('aria-hidden', 'true');
    setDrawerStatus('');
  }

  function setDrawerStatus(message, tone = 'info') {
    if (!refs.drawerStatus) return;
    refs.drawerStatus.textContent = message;
    refs.drawerStatus.dataset.tone = tone;
  }

  async function addPlaylistFromDrawer() {
    if (!refs.drawerInput) return;
    const raw = refs.drawerInput.value.trim();
    const playlistId = extractPlaylistId(raw);
    if (!playlistId) {
      setDrawerStatus('הזינו כתובת או מזהה פלייליסט תקין.', 'error');
      return;
    }
    if (state.playlists.some((item) => item.id === playlistId)) {
      setDrawerStatus('הפלייליסט כבר קיים בספריה.', 'error');
      return;
    }
    setDrawerStatus('טוען פרטי פלייליסט...', 'info');
    const baseRecord = { id: playlistId, name: playlistId, thumbnail: '' };
    state.playlists.push(baseRecord);
    state.currentIndex = state.playlists.length - 1;
    savePlaylists();
    renderPlaylists();
    ensurePlayerLoaded();
    updatePlaylistStatus();
    try {
      const hydrated = await hydratePlaylistMetadata(playlistId);
      if (hydrated && hydrated.success) {
        setDrawerStatus('הפלייליסט נשמר ומוכן לניגון.', 'info');
      } else {
        setDrawerStatus('נשמר עם שם כללי (לא ניתן היה למשוך נתונים מיוטיוב).', 'warning');
      }
      window.setTimeout(closeDrawer, 400);
    } catch (err) {
      console.warn('CARMUSIC: Hydration failed', err);
      setDrawerStatus('נשמר בלי שם רשמי (לא אותר מידע ביוטיוב).', 'warning');
      window.setTimeout(closeDrawer, 600);
    }
  }

  // חלק מטא-דאטה (carmusic.js) – משיכת שם ותמונה של פלייליסט מיוטיוב
  async function hydratePlaylistMetadata(playlistId) {
    if (!playlistId) return { success: false };
    if (state.hydrating.has(playlistId)) return state.hydrating.get(playlistId);
    const pending = (async () => {
      const result = { success: false };
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), HYDRATION_TIMEOUT);
      try {
        const url = `https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/playlist?list=${playlistId}`;
        const response = await fetch(url, { signal: controller.signal });
        window.clearTimeout(timer);
        if (!response.ok) {
          console.warn('CARMUSIC: oEmbed request failed', response.status);
          return result;
        }
        const payload = await response.json();
        applyPlaylistMetadata(playlistId, {
          name: decodeHtml(payload.title) || playlistId,
          thumbnail: payload.thumbnail_url || payload.thumbnail || '',
        });
        result.success = true;
        return result;
      } catch (err) {
        console.warn('CARMUSIC: Hydration error', err);
        return result;
      } finally {
        window.clearTimeout(timer);
        state.hydrating.delete(playlistId);
      }
    })();
    state.hydrating.set(playlistId, pending);
    return pending;
  }

  function applyPlaylistMetadata(playlistId, metadata) {
    const index = state.playlists.findIndex((item) => item.id === playlistId);
    if (index === -1) return;
    const nextRecord = {
      ...state.playlists[index],
      name: metadata.name || state.playlists[index].name,
      thumbnail: metadata.thumbnail || state.playlists[index].thumbnail,
    };
    state.playlists.splice(index, 1, nextRecord);
    savePlaylists();
    renderPlaylists();
    updatePlaylistStatus();
  }

  // חלק עזר (carmusic.js) – פונקציות שירות קטנות
  function extractPlaylistId(value) {
    const raw = (value || '').trim();
    if (!raw) return '';
    const listMatch = raw.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (listMatch && listMatch[1]) return listMatch[1];
    const clean = raw.match(/^[a-zA-Z0-9_-]{10,}$/);
    return clean ? clean[0] : '';
  }

  function decodeHtml(value) {
    if (!value) return '';
    const textarea = document.createElement('textarea');
    textarea.innerHTML = value;
    return (textarea.value || textarea.textContent || value).trim();
  }

  function formatIdentifier(identifier) {
    if (!identifier) return '';
    return identifier.length <= 20 ? identifier : `${identifier.slice(0, 12)}…${identifier.slice(-4)}`;
  }

  // חלק חיבור מאזינים (carmusic.js) – קליטת אירועים מכל הכפתורים במסך
  function bindUI() {
    if (refs.playPause) refs.playPause.addEventListener('click', togglePlayPause);
    if (refs.nextTrack) refs.nextTrack.addEventListener('click', nextTrack);
    if (refs.prevTrack) refs.prevTrack.addEventListener('click', previousTrack);
    if (refs.nextPlaylist) refs.nextPlaylist.addEventListener('click', nextPlaylist);
    if (refs.prevPlaylist) refs.prevPlaylist.addEventListener('click', previousPlaylist);
    if (refs.shuffle) refs.shuffle.addEventListener('click', toggleShuffle);
    if (refs.openDrawer) refs.openDrawer.addEventListener('click', openDrawer);
    if (refs.drawerClose) refs.drawerClose.addEventListener('click', closeDrawer);
    if (refs.drawerClear) refs.drawerClear.addEventListener('click', () => {
      if (refs.drawerInput) refs.drawerInput.value = '';
      setDrawerStatus('');
    });
    if (refs.drawerSave) refs.drawerSave.addEventListener('click', addPlaylistFromDrawer);
    if (refs.drawer) {
      refs.drawer.addEventListener('click', (event) => {
        if (event.target === refs.drawer) {
          closeDrawer();
        }
      });
    }
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && refs.drawer?.classList.contains('open')) {
        closeDrawer();
      }
    });
    window.addEventListener('online', updateConnectionStatus);
    window.addEventListener('offline', updateConnectionStatus);
  }

  // חלק אתחול (carmusic.js) – מריץ את כל ההכנות בעת טעינת הדף
  function init() {
    updateConnectionStatus();
    startClock();
    loadPlaylists();
    bindUI();
    renderPlaylists();
    setDefaultTrackInfo();
    updatePlaylistStatus();
    if (state.playlists.length) {
      state.currentIndex = 0;
    }
  }

  window.onYouTubeIframeAPIReady = function onYouTubeIframeAPIReady() {
    ensurePlayerLoaded();
  };

  init();
})(window);
