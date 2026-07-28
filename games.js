// ========================================
// SOS Play - פיד משחקים משותפים
// אותה חוויית כרטיס כמו בפיד הראשי (game-embed + שחרור + מסך מלא)
// HYPER CORE TECH
// ========================================

(function initSosGamesFeed(window, document) {
  const App = window.NostrApp || (window.NostrApp = {});
  const FEED_CACHE_KEY = 'videos_feed_cache_v3';

  const viewport = document.getElementById('gamesViewport');
  const stream = document.getElementById('gamesStream');
  const indicator = document.getElementById('gamesIndicator');
  const indicatorCurrent = indicator?.querySelector('.games-indicator__current');
  const indicatorTotal = indicator?.querySelector('.games-indicator__total');
  const emptyEl = document.getElementById('gamesEmpty');
  const backBtn = document.getElementById('gamesBackBtn');
  const menuBtn = document.getElementById('gamesMenuBtn');
  const topMenu = document.getElementById('gamesTopMenu');

  let currentIndex = 0;
  let gamePosts = [];
  let intersectionObserver = null;

  // קטלוג בסיס – משחקים שעולים בפועל | HYPER CORE TECH
  const catalogGames = [];

  // כתובות קטלוג ישנות שלא עולות – לא להציג גם אם נשארו במטמון | HYPER CORE TECH
  const BLOCKED_GAME_URL_PARTS = [
    'hexgl.bkcore.com',
    'gamh5.com/full/ninja-leap',
    'gamh5.com/full/meteorite-shooter',
    'gamh5.com/full/zoo-boom',
    'krunker.io',
    'mahdif.github.io/taptaptap',
    'cdn-factory.marketjs.com/en/3d-penalty-kick',
  ];

  function isPlayableGameUrl(link) {
    if (typeof App.isPlayableGameUrl === 'function') {
      return App.isPlayableGameUrl(link);
    }
    if (!link || !/^https:\/\//i.test(link)) return false;
    if (/subway[\s\-_.]*surfers?|subwaysurfers/i.test(link)) return false;
    if (/poki\.com|crazygames\.com|gamedistribution\.com/i.test(link)) return false;
    if (/\.(mp4|webm|m3u8|jpg|png)(\?|#|$)/i.test(link)) return false;
    return /\.github\.io\//i.test(link) || /gamh5\.com|krunker\.io|famobi\.com|itch\.io|marketjs\.com/i.test(link);
  }

  function escapeText(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getInitials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'AN';
    return parts.slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  }

  function isBlockedCatalogUrl(url) {
    const value = String(url || '').toLowerCase();
    return BLOCKED_GAME_URL_PARTS.some((part) => value.includes(part));
  }

  function pushUnique(list, seen, post) {
    if (!post || !post.gameUrl || !isPlayableGameUrl(post.gameUrl)) return;
    if (isBlockedCatalogUrl(post.gameUrl)) return;
    const key = String(post.id || post.gameUrl).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push({
      id: post.id || `game-${list.length}`,
      gameUrl: post.gameUrl,
      content: post.content || post.gameUrl,
      authorName: post.authorName || 'משתמש',
      authorPicture: post.authorPicture || '',
      authorInitials: post.authorInitials || getInitials(post.authorName),
      pubkey: post.pubkey || '',
      createdAt: post.createdAt || 0,
      source: post.source || 'shared',
    });
  }

  // איסוף פוסטים עם gameUrl מהמטמון / מההורה / מה־DOM של הפיד | HYPER CORE TECH
  function collectSharedGamePosts() {
    const seen = new Set();
    const list = [];

    // 1) מטמון הפיד הראשי (אותו origin גם ב־iframe)
    try {
      const raw = window.localStorage.getItem(FEED_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const videos = Array.isArray(parsed?.videos) ? parsed.videos : (Array.isArray(parsed) ? parsed : []);
        videos.forEach((video) => {
          if (video && video.gameUrl) {
            pushUnique(list, seen, { ...video, source: 'cache' });
          }
        });
      }
    } catch (_) {}

    // 2) API מההורה אם קיים
    try {
      if (window.parent && window.parent !== window) {
        const parentApp = window.parent.NostrApp;
        if (parentApp && typeof parentApp.getSharedGamePosts === 'function') {
          const fromParent = parentApp.getSharedGamePosts() || [];
          fromParent.forEach((video) => pushUnique(list, seen, { ...video, source: 'parent' }));
        }
        // 3) סריקת כרטיסי משחק שכבר מוצגים בפיד הראשי
        const parentCards = window.parent.document.querySelectorAll(
          '.videos-feed__media[data-media-type="game-embed"][data-game-url]'
        );
        parentCards.forEach((mediaDiv) => {
          const card = mediaDiv.closest('.videos-feed__card');
          const gameUrl = mediaDiv.dataset.gameUrl;
          const id = card?.getAttribute('data-event-id') || gameUrl;
          const content = card?.querySelector('.videos-feed__content')?.textContent || '';
          const authorName = card?.querySelector('.videos-feed__action--avatar')?.getAttribute('aria-label') || 'משתמש';
          pushUnique(list, seen, {
            id,
            gameUrl,
            content,
            authorName,
            source: 'dom',
          });
        });
      }
    } catch (_) {}

    // חדשים קודם
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return list;
  }

  function buildGameFeedList() {
    const shared = collectSharedGamePosts();
    const seen = new Set(shared.map((g) => String(g.gameUrl).toLowerCase()));
    const merged = [...shared];
    catalogGames.forEach((game) => {
      if (seen.has(String(game.gameUrl).toLowerCase())) return;
      merged.push(game);
    });
    return merged;
  }

  function createGameCard(video, index) {
    const article = document.createElement('article');
    article.className = 'videos-feed__card games-feed__card';
    article.setAttribute('role', 'listitem');
    article.setAttribute('data-event-id', video.id);
    article.dataset.index = String(index);
    article.dataset.gameSource = video.source || 'shared';

    const mediaDiv = document.createElement('div');
    mediaDiv.className = 'videos-feed__media videos-feed__media--game';
    mediaDiv.dataset.mediaType = 'game-embed';
    mediaDiv.dataset.gameUrl = video.gameUrl;

    const placeholder = document.createElement('div');
    placeholder.className = 'videos-feed__game-placeholder';
    placeholder.setAttribute('data-game-tap-zone', '');
    placeholder.innerHTML = '<i class="fa-solid fa-gamepad"></i><span>טוען משחק...</span>';
    mediaDiv.appendChild(placeholder);

    if (typeof App.ensureGameFullscreenControls === 'function') {
      App.ensureGameFullscreenControls(mediaDiv);
    }
    if (typeof App.ensureGameScrollShield === 'function') {
      App.ensureGameScrollShield(mediaDiv);
    }

    const playOverlay = document.createElement('button');
    playOverlay.type = 'button';
    playOverlay.className = 'videos-feed__play-overlay';
    playOverlay.setAttribute('aria-label', 'Play game');
    playOverlay.setAttribute('data-play-toggle', '');
    playOverlay.innerHTML = '<i class="fa-solid fa-play"></i>';
    playOverlay.style.display = 'none';
    mediaDiv.appendChild(playOverlay);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'videos-feed__actions';

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'videos-feed__avatar-wrap';
    const authorAction = document.createElement('button');
    authorAction.type = 'button';
    authorAction.className = 'videos-feed__action videos-feed__action--avatar';
    authorAction.setAttribute('aria-label', video.authorName || 'משתמש');
    if (video.authorPicture) {
      const img = document.createElement('img');
      img.src = video.authorPicture;
      img.alt = video.authorName || 'משתמש';
      img.loading = 'lazy';
      authorAction.appendChild(img);
    } else {
      const initialsSpan = document.createElement('span');
      initialsSpan.textContent = video.authorInitials || getInitials(video.authorName);
      authorAction.appendChild(initialsSpan);
    }
    avatarWrap.appendChild(authorAction);
    actionsDiv.appendChild(avatarWrap);

    actionsDiv.insertAdjacentHTML(
      'beforeend',
      `
      <button class="videos-feed__action" type="button" data-share-game="${escapeText(video.id)}">
        <i class="fa-solid fa-share"></i>
      </button>
    `
    );

    const infoDiv = document.createElement('div');
    infoDiv.className = 'videos-feed__info';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'videos-feed__content';
    contentDiv.textContent = video.content || video.gameUrl;
    infoDiv.appendChild(contentDiv);

    if (video.source === 'catalog') {
      const badge = document.createElement('div');
      badge.className = 'games-feed__catalog-badge';
      badge.textContent = 'קטלוג SOS';
      infoDiv.appendChild(badge);
    }

    article.appendChild(mediaDiv);
    article.appendChild(actionsDiv);
    article.appendChild(infoDiv);

    const shareBtn = actionsDiv.querySelector('[data-share-game]');
    shareBtn?.addEventListener('click', () => shareGame(video));

    return article;
  }

  function shareGame(video) {
    const payload = {
      title: video.authorName || 'SOS Play',
      text: video.content || 'משחק ב־SOS',
      url: video.gameUrl,
    };
    if (navigator.share) {
      navigator.share(payload).catch(() => {});
      return;
    }
    try {
      navigator.clipboard?.writeText(video.gameUrl);
    } catch (_) {}
  }

  function updateIndicator() {
    if (indicatorCurrent) indicatorCurrent.textContent = gamePosts.length ? currentIndex + 1 : 0;
    if (indicatorTotal) indicatorTotal.textContent = String(gamePosts.length);
  }

  function activateCard(card) {
    if (!card) return;
    const mediaDiv = card.querySelector('.videos-feed__media[data-media-type="game-embed"]');
    if (!mediaDiv) return;
    if (typeof App.activateGameMedia === 'function') {
      App.activateGameMedia(mediaDiv);
    } else if (typeof App.prepareGameMedia === 'function') {
      App.prepareGameMedia(mediaDiv, { loadingLabel: 'טוען משחק...' });
    }
  }

  function softDeactivateCard(card) {
    if (!card) return;
    const mediaDiv = card.querySelector('.videos-feed__media[data-media-type="game-embed"]');
    if (!mediaDiv) return;
    if (mediaDiv.classList.contains('is-game-fullscreen')) return;
    if (typeof App.softDeactivateGameMedia === 'function') {
      App.softDeactivateGameMedia(mediaDiv);
    }
  }

  function prefetchNeighbors(activeCard) {
    if (!activeCard || !stream) return;
    const cards = Array.from(stream.querySelectorAll('.videos-feed__card'));
    const idx = cards.indexOf(activeCard);
    if (idx < 0) return;

    [cards[idx + 1], cards[idx + 2]].forEach((neighbor) => {
      if (!neighbor) return;
      const gameDiv = neighbor.querySelector('.videos-feed__media[data-media-type="game-embed"]');
      if (gameDiv && typeof App.prepareGameMedia === 'function') {
        App.prepareGameMedia(gameDiv, { loadingLabel: 'טוען משחק...', load: false });
      }
    });

    if (typeof App.deactivateGameMedia === 'function') {
      cards.forEach((card, i) => {
        if (Math.abs(i - idx) <= 2) return;
        const gameDiv = card.querySelector('.videos-feed__media[data-media-type="game-embed"]');
        if (!gameDiv || gameDiv.dataset.gamePrepared !== '1') return;
        if (gameDiv.classList.contains('is-game-active') || gameDiv.classList.contains('is-game-fullscreen')) return;
        App.deactivateGameMedia(gameDiv);
      });
    }
  }

  function setupIntersectionObserver() {
    if (!viewport || !stream) return;
    if (intersectionObserver) intersectionObserver.disconnect();

    intersectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const card = entry.target;
          if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
            const idx = Number(card.dataset.index || 0);
            if (idx !== currentIndex) {
              currentIndex = idx;
              updateIndicator();
            }
            activateCard(card);
            prefetchNeighbors(card);
          } else if (!entry.isIntersecting) {
            softDeactivateCard(card);
          }
        });
      },
      {
        root: viewport,
        threshold: [0.5, 0.75],
      }
    );

    stream.querySelectorAll('.videos-feed__card').forEach((card) => {
      intersectionObserver.observe(card);
    });
  }

  function renderFeed() {
    if (!stream) return;
    gamePosts = buildGameFeedList();
    stream.innerHTML = '';

    if (!gamePosts.length) {
      if (emptyEl) emptyEl.hidden = false;
      updateIndicator();
      return;
    }

    if (emptyEl) emptyEl.hidden = true;
    const frag = document.createDocumentFragment();
    gamePosts.forEach((post, index) => {
      frag.appendChild(createGameCard(post, index));
    });
    stream.appendChild(frag);
    updateIndicator();
    setupIntersectionObserver();

    // הפעלת הכרטיס הראשון מיד | HYPER CORE TECH
    const first = stream.querySelector('.videos-feed__card');
    if (first) {
      activateCard(first);
      prefetchNeighbors(first);
    }

    console.log('[SOS Play] Games feed ready', { count: gamePosts.length });
  }

  function handleBackClick() {
    const isInIframe = window.parent !== window;
    if (isInIframe) {
      window.parent.postMessage({ type: 'closeGames' }, '*');
      return;
    }
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = './videos.html';
    }
  }

  function setMenuOpen(open) {
    if (!topMenu || !menuBtn) return;
    topMenu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function launchNetworkGame(kind) {
    setMenuOpen(false);
    const isInIframe = window.parent !== window;
    if (isInIframe) {
      window.parent.postMessage({ type: kind === 'doom' ? 'openDoomGame' : 'openTriviaGame' }, '*');
      return;
    }
    if (kind === 'doom') {
      window.open('./doom-multiplayer.html', 'doomGame', 'width=1200,height=800');
      return;
    }
    window.location.href = './videos.html#trivia';
  }

  function handleHashLaunch() {
    const hash = String(window.location.hash || '').replace('#', '').toLowerCase();
    if (hash === 'doom') launchNetworkGame('doom');
    if (hash === 'trivia') launchNetworkGame('trivia');
  }

  function init() {
    backBtn?.addEventListener('click', handleBackClick);
    menuBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      setMenuOpen(!!topMenu?.hidden);
    });
    topMenu?.querySelectorAll('[data-games-action]').forEach((btn) => {
      btn.addEventListener('click', () => launchNetworkGame(btn.getAttribute('data-games-action')));
    });
    document.addEventListener('click', (e) => {
      if (!topMenu || topMenu.hidden) return;
      if (topMenu.contains(e.target) || menuBtn?.contains(e.target)) return;
      setMenuOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        if (typeof App.exitGameFullscreen === 'function') {
          document.querySelectorAll('.videos-feed__media.is-game-fullscreen').forEach((el) => {
            App.exitGameFullscreen(el);
          });
        }
      }
    });

    renderFeed();
    handleHashLaunch();

    // רענון קל כשחוזרים לטאב – אולי נוספו משחקים בפיד | HYPER CORE TECH
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        const next = buildGameFeedList();
        if (next.length !== gamePosts.length) renderFeed();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window, document);
