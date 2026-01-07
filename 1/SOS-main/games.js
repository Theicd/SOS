// חלק דף משחקים (games.js) – קטלוג המשחקים כולל מידע על מקור הקוד והטמעת הלינקים
const gamesCatalog = [
  {
    id: 'trivia-duel',
    title: 'Trivia Duel',
    studio: 'Yalla Network',
    summary:
      'טריוויה בזמן אמת עם שחקנים אחרים ברשת המבוזרת – בחרו יריב, ענו לשאלות ותעלו בטבלת ההישגים.',
    playUrl: null,
    sourceUrl: null,
    coverImage: 'https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=1280&q=80',
    tags: ['Realtime', 'Trivia', 'Multiplayer'],
    highlight: '⭐ Live Challenge',
    category: 'network',
    launch: () => {
      const targetUrl = new URL('./index.html', window.location.href);
      targetUrl.searchParams.set('open', 'trivia');
      window.location.href = targetUrl.toString();
    }
  },
  // חלק דף משחקים (games.js) – משחק רשת: Krunker.io
  {
    id: 'krunker-io',
    title: 'Krunker.io',
    studio: 'Yendis Entertainment',
    summary:
      'קרבות FPS מהירים בדפדפן עם מערכת דירוג, התאמה לשרתים ציבוריים וכניסה אוטומטית לחדר הרשת שנבחר.',
    playUrl: 'https://krunker.io/?game=NY:pc3ah',
    sourceUrl: null,
    coverImage: 'https://images.unsplash.com/photo-1611605698335-08e07a77b030?auto=format&fit=crop&w=1280&q=80',
    tags: ['FPS', 'Multiplayer', 'Keyboard'],
    highlight: '⭐ Ranked Arena',
    category: 'network'
  },
  {
    id: 'taptaptap',
    title: 'Tap Tap Tap',
    studio: 'Mahdi Farra',
    summary:
      'משחק טאץ׳ בקוד פתוח שמזמין אותך לטפס בין שלבים בקצב מהיר, עם אנימציות מצומצמות שמתאימות במיוחד למסכי מגע.',
    playUrl: 'https://mahdif.github.io/taptaptap/play/',
    sourceUrl: 'https://github.com/MahdiF/taptaptap',
    coverImage: 'https://raw.githubusercontent.com/MahdiF/taptaptap/master/images/desktop-screenshot.png',
    tags: ['Touch', 'Arcade', 'Progressive'],
    highlight: '⭐ 4.6',
    category: 'web'
  },
  {
    id: 'hexgl',
    title: 'HexGL',
    studio: 'BKcore',
    summary:
      'מירוץ חללי בקוד פתוח עם WebGL, המשלב שליטה חלקה, פיזיקה ריאליסטית ומסלולים עתידניים שמרגישים כמו קונסולה.',
    playUrl: 'https://hexgl.bkcore.com/play/',
    sourceUrl: 'https://github.com/BKcore/HexGL',
    coverImage: 'https://raw.githubusercontent.com/BKcore/HexGL/master/css/title.png',
    tags: ['WebGL', 'Racing', 'Keyboard'],
    highlight: '⭐ קלאסי עולמי',
    category: 'pc'
  },
  {
    id: 'ninja-leap',
    title: 'Ninja Leap',
    studio: 'GamH5',
    summary:
      'ריצה אנכית אינסופית עם נינג׳ה זריזה – קפיצות מצד לצד, איסוף מטבעות ואימון רפלקסים למובייל בדפדפן.',
    playUrl: 'https://gamh5.com/full/ninja-leap',
    sourceUrl: null,
    coverImage: 'https://images.unsplash.com/photo-1614680376739-414d95ff43df?auto=format&fit=crop&w=1280&q=80',
    tags: ['Touch', 'Runner', 'Mobile'],
    highlight: '⭐ מותאם מגע',
    category: 'web'
  },
  {
    id: 'meteorite-shooter',
    title: 'Meteorite Shooter',
    studio: 'GamH5',
    summary:
      'יוצאים למסע חללי מהיר בו מנווטים חללית, מפוצצים מטאורים ומתחמקים ממכשולים בקצב עולה.',
    playUrl: 'https://gamh5.com/full/meteorite-shooter-space-adventure',
    sourceUrl: null,
    coverImage: 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?auto=format&fit=crop&w=1280&q=80',
    tags: ['Shooter', 'Space', 'Arcade'],
    highlight: '⭐ אקשן מהיר',
    category: 'web'
  },
  {
    id: 'zoo-boom',
    title: 'Zoo Boom',
    studio: 'Famobi',
    summary:
      'התאמת חיות צבעוניות ברמות קצרות ומידיות, עם משימות יומיות ומערכת קומבואים שמתגמלת יצירתיות.',
    playUrl: 'https://gamh5.com/full/zoo-boom-animal-matching-game',
    sourceUrl: 'https://www.famobi.com/zoo-boom',
    coverImage: 'https://images.unsplash.com/photo-1618005198919-d3d4b5a92eee?auto=format&fit=crop&w=1280&q=80',
    tags: ['Puzzle', 'Casual', 'Touch'],
    highlight: '⭐ פופולרי',
    category: 'web'
  }
];
// חלק דף משחקים (games.js) – אלמנטים מרכזיים בממשק
const gamesGridElement = document.getElementById('gamesGrid');
const gameModalElement = document.getElementById('gameModal');
const gameModalFrame = document.getElementById('gameModalFrame');
const gameModalBack = document.getElementById('gameModalBack');
const gameModalBackdrop = document.getElementById('gameModalBackdrop');
const gameModalStatus = document.getElementById('gameModalStatus');
const gameModalTitle = document.getElementById('gameModalTitle');
const gameModalExternal = document.getElementById('gameModalExternal');
const gameModalFloatingBack = document.getElementById('gameModalFloatingBack');
const gameModalFullscreen = document.getElementById('gameModalFullscreen');
const gamesTopHomeButton = document.getElementById('gamesTopHomeButton');
const gamesTopRefreshButton = document.getElementById('gamesTopRefreshButton');

// חלק דף משחקים (games.js) – יצירת כרטיס משחק ב־DOM
function createGameCard(game) {
  const card = document.createElement('article');
  card.className = 'game-card';

  const artWrapper = document.createElement('div');
  artWrapper.className = 'game-card__art';

  const artImage = document.createElement('img');
  artImage.alt = `${game.title} cover art`;
  artImage.loading = 'lazy';
  artImage.referrerPolicy = 'no-referrer';
  artImage.src = game.coverImage;
  artImage.addEventListener('error', () => {
    artImage.src = 'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=1280&q=80';
  });

  artWrapper.appendChild(artImage);

  const body = document.createElement('div');
  body.className = 'game-card__body';

  const title = document.createElement('h3');
  title.className = 'game-card__title';
  title.textContent = game.title;

  if (game.highlight) {
    const star = document.createElement('span');
    star.textContent = game.highlight;
    title.appendChild(star);
  }

  const summary = document.createElement('p');
  summary.className = 'game-card__summary';
  summary.textContent = game.summary;

  const tagsList = document.createElement('ul');
  tagsList.className = 'game-card__tags';
  game.tags.forEach((tag) => {
    const item = document.createElement('li');
    item.className = 'game-card__tag';
    item.textContent = tag;
    tagsList.appendChild(item);
  });

  const actions = document.createElement('div');
  actions.className = 'game-card__actions';

  const playButton = document.createElement('button');
  playButton.type = 'button';
  playButton.className = 'game-card__play';
  playButton.innerHTML = '<i class="fa-solid fa-gamepad"></i> Play';
  playButton.addEventListener('click', () => {
    if (typeof game.launch === 'function') {
      game.launch();
      return;
    }
    openGameModal(game);
  });

  const sourceLink = document.createElement('a');
  sourceLink.className = 'game-card__source';
  sourceLink.target = '_blank';
  sourceLink.rel = 'noopener noreferrer';

  if (game.sourceUrl) {
    sourceLink.href = game.sourceUrl;
    sourceLink.innerHTML = '<i class="fa-solid fa-code"></i> קוד מקור';
  } else {
    sourceLink.href = '#';
    sourceLink.setAttribute('aria-disabled', 'true');
    sourceLink.classList.add('is-disabled');
    sourceLink.innerHTML = '<i class="fa-solid fa-lock"></i> קוד סגור זמני';
    sourceLink.addEventListener('click', (event) => event.preventDefault());
  }

  actions.appendChild(playButton);
  actions.appendChild(sourceLink);

  body.appendChild(title);
  body.appendChild(summary);
  body.appendChild(tagsList);
  body.appendChild(actions);

  card.appendChild(artWrapper);
  card.appendChild(body);

  return card;
}

// חלק דף משחקים (games.js) – רינדור כל הכרטיסיות בעמוד
function renderGamesGrid() {
  const fragment = document.createDocumentFragment();
  gamesCatalog.forEach((game) => {
    fragment.appendChild(createGameCard(game));
  });
  gamesGridElement.appendChild(fragment);
}

// חלק דף משחקים (games.js) – סינון משחקים לפי קטגוריה
function filterGamesByCategory(category) {
  const games = gamesCatalog.filter(game => game.category === category);
  return games;
}

// חלק דף משחקים (games.js) – רינדור משחקים לפי קטגוריה
function renderGamesByCategory(category) {
  // נקה את הגריד
  gamesGridElement.innerHTML = '';
  
  // קבל משחקים מהקטגוריה
  const filteredGames = filterGamesByCategory(category);
  
  // רנדר את המשחקים
  const fragment = document.createDocumentFragment();
  filteredGames.forEach((game) => {
    fragment.appendChild(createGameCard(game));
  });
  gamesGridElement.appendChild(fragment);
}

// חלק דף משחקים (games.js) – רישום מאזינים לקטגוריות
function registerCategoryControls() {
  const categoryButtons = document.querySelectorAll('.games-category');
  
  categoryButtons.forEach(button => {
    button.addEventListener('click', () => {
      const category = button.dataset.category;
      
      // עדכן כפתורים פעילים
      categoryButtons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      
      // רנדר משחקים לפי קטגוריה
      renderGamesByCategory(category);
    });
  });
}

// חלק דף משחקים (games.js) – פתיחת מודל המשחק וטעינת ה־iframe
function openGameModal(game) {
  if (!gameModalElement || !gameModalFrame) {
    window.open(game.playUrl, '_blank');
    return;
  }
  gameModalStatus.textContent = 'Syncing game node…';
  if (gameModalTitle) {
    gameModalTitle.textContent = game.title;
  }
  if (gameModalExternal) {
    gameModalExternal.hidden = true;
    gameModalExternal.dataset.target = game.playUrl;
  }
  gameModalFrame.setAttribute('src', '');
  gameModalFrame.src = game.playUrl;
  gameModalElement.classList.add('is-open');
  document.body.classList.add('games-modal-open');
}

// חלק דף משחקים (games.js) – סגירת המודל וניקוי המשאב
function closeGameModal() {
  if (!gameModalElement) {
    return;
  }
  gameModalElement.classList.remove('is-open');
  gameModalFrame.src = '';
  gameModalStatus.textContent = 'Syncing game node…';
  if (gameModalTitle) {
    gameModalTitle.textContent = 'מרכז המשחקים';
  }
  if (gameModalExternal) {
    gameModalExternal.hidden = true;
    delete gameModalExternal.dataset.target;
  }
  document.body.classList.remove('games-modal-open');
}

// חלק דף משחקים (games.js) – רישום מאזינים לכל רכיבי השליטה במודל
function registerModalControls() {
  if (gameModalBack) {
    gameModalBack.addEventListener('click', closeGameModal);
  }
  if (gameModalBackdrop) {
    gameModalBackdrop.addEventListener('click', closeGameModal);
  }
  if (gameModalFrame) {
    gameModalFrame.addEventListener('load', () => {
      gameModalStatus.textContent = 'Game synced · ready to play';
      try {
        gameModalFrame.setAttribute('allowfullscreen', 'true');
        gameModalFrame.setAttribute('webkitallowfullscreen', 'true');
        gameModalFrame.setAttribute('mozallowfullscreen', 'true');
      } catch (err) {
        console.warn('iframe fullscreen attributes failed', err);
      }
      if (gameModalExternal) {
        gameModalExternal.hidden = true;
      }
    });
    gameModalFrame.addEventListener('error', () => {
      gameModalStatus.textContent = 'לא הצלחנו לטעון את המשחק בדפדפן זה. פתחו אותו בלשונית חדשה.';
      if (gameModalExternal && gameModalExternal.dataset.target) {
        gameModalExternal.hidden = false;
      }
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeGameModal();
    }
  });

  if (gameModalExternal) {
    gameModalExternal.addEventListener('click', (event) => {
      if (!gameModalExternal.dataset.target) {
        event.preventDefault();
        return;
      }
      window.open(gameModalExternal.dataset.target, '_blank', 'noopener');
    });
  }

  if (gameModalFloatingBack) {
    gameModalFloatingBack.addEventListener('click', closeGameModal);
  }

  if (gameModalFullscreen) {
    gameModalFullscreen.addEventListener('click', () => {
      if (!gameModalFrame) {
        return;
      }
      
      // ניסיון להיכנס למסך מלא
      const iframe = gameModalFrame;
      
      if (iframe.requestFullscreen) {
        iframe.requestFullscreen();
      } else if (iframe.webkitRequestFullscreen) {
        iframe.webkitRequestFullscreen();
      } else if (iframe.mozRequestFullScreen) {
        iframe.mozRequestFullScreen();
      } else if (iframe.msRequestFullscreen) {
        iframe.msRequestFullscreen();
      }
    });
  }
}

function registerTopBarControls() {
  if (gamesTopHomeButton) {
    gamesTopHomeButton.addEventListener('click', () => {
      window.location.href = './index.html';
    });
  }

  if (gamesTopRefreshButton) {
    gamesTopRefreshButton.addEventListener('click', () => {
      const activeButton = document.querySelector('.games-category.active');
      const activeCategory = activeButton?.dataset.category || 'web';
      renderGamesByCategory(activeCategory);
    });
  }

}

// חלק דף משחקים (games.js) – נקודת הכניסה לדף
(function initGamesPage() {
  if (!gamesGridElement) {
    return;
  }
  // טען משחקי ווב כברירת מחדל
  renderGamesByCategory('web');
  registerModalControls();
  registerCategoryControls();
  registerTopBarControls();
})();
