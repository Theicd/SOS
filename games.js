// ========================================
// SOS Play - פיד משחקים פרימיום
// לוגיקת גלילה אנכית בסגנון TikTok/Reels
// HYPER CORE TECH
// ========================================

// קטלוג משחקים
const gamesCatalog = [
  {
    id: 'krunker-io',
    title: 'Krunker.io',
    studio: 'Yendis Entertainment',
    description: 'קרבות FPS מהירים בדפדפן עם מערכת דירוג, התאמה לשרתים ציבוריים וכניסה אוטומטית לחדר הרשת.',
    playUrl: 'https://krunker.io/?game=NY:pc3ah',
    coverImage: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=1920&q=80',
    tags: ['FPS', 'Multiplayer', 'Action'],
    category: 'אקשן',
    categoryIcon: 'fa-crosshairs',
    likes: '45.2K'
  },
  {
    id: 'taptaptap',
    title: 'Tap Tap Tap',
    studio: 'Mahdi Farra',
    description: 'משחק טאץ׳ בקוד פתוח שמזמין אותך לטפס בין שלבים בקצב מהיר, עם אנימציות מצומצמות למסכי מגע.',
    playUrl: 'https://mahdif.github.io/taptaptap/play/',
    coverImage: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=1920&q=80',
    tags: ['Touch', 'Arcade', 'Progressive'],
    category: 'ארקייד',
    categoryIcon: 'fa-hand-pointer',
    likes: '8.3K'
  },
  {
    id: 'hexgl',
    title: 'HexGL',
    studio: 'BKcore',
    description: 'מירוץ חללי בקוד פתוח עם WebGL, המשלב שליטה חלקה, פיזיקה ריאליסטית ומסלולים עתידניים.',
    playUrl: 'https://hexgl.bkcore.com/play/',
    coverImage: 'https://images.unsplash.com/photo-1614294148960-9aa740632a87?auto=format&fit=crop&w=1920&q=80',
    tags: ['Racing', 'WebGL', '3D'],
    category: 'מירוצים',
    categoryIcon: 'fa-flag-checkered',
    likes: '23.1K'
  },
  {
    id: 'ninja-leap',
    title: 'Ninja Leap',
    studio: 'GamH5',
    description: 'ריצה אנכית אינסופית עם נינג׳ה זריזה – קפיצות מצד לצד, איסוף מטבעות ואימון רפלקסים למובייל.',
    playUrl: 'https://gamh5.com/full/ninja-leap',
    coverImage: 'https://images.unsplash.com/photo-1578662996442-48f60103fc96?auto=format&fit=crop&w=1920&q=80',
    tags: ['Runner', 'Mobile', 'Infinite'],
    category: 'ראנר',
    categoryIcon: 'fa-person-running',
    likes: '15.7K'
  },
  {
    id: 'meteorite-shooter',
    title: 'Meteorite Shooter',
    studio: 'GamH5',
    description: 'יוצאים למסע חללי מהיר בו מנווטים חללית, מפוצצים מטאורים ומתחמקים ממכשולים בקצב עולה.',
    playUrl: 'https://gamh5.com/full/meteorite-shooter-space-adventure',
    coverImage: 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?auto=format&fit=crop&w=1920&q=80',
    tags: ['Shooter', 'Space', 'Arcade'],
    category: 'חלל',
    categoryIcon: 'fa-rocket',
    likes: '19.4K'
  },
  {
    id: 'zoo-boom',
    title: 'Zoo Boom',
    studio: 'Famobi',
    description: 'התאמת חיות צבעוניות ברמות קצרות ומידיות, עם משימות יומיות ומערכת קומבואים שמתגמלת יצירתיות.',
    playUrl: 'https://gamh5.com/full/zoo-boom-animal-matching-game',
    coverImage: 'https://images.unsplash.com/photo-1535591273668-578e31182c4f?auto=format&fit=crop&w=1920&q=80',
    tags: ['Puzzle', 'Casual', 'Match-3'],
    category: 'פאזל',
    categoryIcon: 'fa-puzzle-piece',
    likes: '31.8K'
  }
];

// אלמנטים ראשיים
const viewport = document.getElementById('gamesViewport');
const indicator = document.getElementById('gamesIndicator');
const indicatorCurrent = indicator?.querySelector('.games-indicator__current');
const indicatorTotal = indicator?.querySelector('.games-indicator__total');
const backBtn = document.getElementById('gamesBackBtn');
const menuBtn = document.getElementById('gamesMenuBtn');
const gameModal = document.getElementById('gameModal');
const gameModalFrame = document.getElementById('gameModalFrame');
const gameModalTitle = document.getElementById('gameModalTitle');
const gameModalClose = document.getElementById('gameModalClose');
const gameModalBackdrop = document.getElementById('gameModalBackdrop');
const gameModalFullscreen = document.getElementById('gameModalFullscreen');
const gameModalLoading = document.getElementById('gameModalLoading');

// מצב גלובלי
let currentGameIndex = 0;
let likedGames = new Set(JSON.parse(localStorage.getItem('sos_liked_games') || '[]'));

// יצירת כרטיסיית משחק
function createGameCard(game, index) {
  const card = document.createElement('article');
  card.className = 'game-card';
  card.dataset.index = index;
  card.dataset.gameId = game.id;

  card.innerHTML = `
    <div class="game-card__background">
      <img src="${game.coverImage}" alt="${game.title}" loading="${index < 2 ? 'eager' : 'lazy'}" />
    </div>
    <div class="game-card__overlay"></div>
    
    <div class="game-card__content">
      <div class="game-card__badge">
        <i class="fa-solid ${game.categoryIcon}"></i>
        ${game.category}
      </div>
      <h2 class="game-card__title">${game.title}</h2>
      <div class="game-card__studio">
        <i class="fa-solid fa-code"></i>
        ${game.studio}
      </div>
      <p class="game-card__description">${game.description}</p>
      <ul class="game-card__tags">
        ${game.tags.map(tag => `<li class="game-card__tag">${tag}</li>`).join('')}
      </ul>
      <button class="game-card__play" data-game-id="${game.id}">
        <i class="fa-solid fa-play"></i>
        התחל לשחק
      </button>
    </div>
    
    <div class="game-card__actions">
      <button class="game-card__action ${likedGames.has(game.id) ? 'game-card__action--liked' : ''}" data-action="like" data-game-id="${game.id}">
        <i class="fa-${likedGames.has(game.id) ? 'solid' : 'regular'} fa-heart"></i>
        <span>${game.likes}</span>
      </button>
      <button class="game-card__action" data-action="share" data-game-id="${game.id}">
        <i class="fa-solid fa-share"></i>
      </button>
      <button class="game-card__action" data-action="info" data-game-id="${game.id}">
        <i class="fa-solid fa-circle-info"></i>
      </button>
    </div>
  `;

  return card;
}

// רינדור כל הכרטיסיות
function renderGameCards() {
  if (!viewport) return;
  
  viewport.innerHTML = '';
  const fragment = document.createDocumentFragment();
  
  gamesCatalog.forEach((game, index) => {
    fragment.appendChild(createGameCard(game, index));
  });
  
  viewport.appendChild(fragment);
  
  // עדכון אינדיקטור
  if (indicatorTotal) {
    indicatorTotal.textContent = gamesCatalog.length;
  }
  
  // מאזינים לכפתורי הפעלה
  viewport.querySelectorAll('.game-card__play').forEach(btn => {
    btn.addEventListener('click', handlePlayClick);
  });
  
  // מאזינים לכפתורי פעולה
  viewport.querySelectorAll('.game-card__action').forEach(btn => {
    btn.addEventListener('click', handleActionClick);
  });
}

// טיפול בגלילה
function handleScroll() {
  if (!viewport) return;
  
  const cardHeight = viewport.querySelector('.game-card')?.offsetHeight || window.innerHeight;
  const newIndex = Math.round(viewport.scrollTop / cardHeight);
  
  if (newIndex !== currentGameIndex && newIndex >= 0 && newIndex < gamesCatalog.length) {
    currentGameIndex = newIndex;
    updateIndicator();
  }
}

// עדכון אינדיקטור
function updateIndicator() {
  if (indicatorCurrent) {
    indicatorCurrent.textContent = currentGameIndex + 1;
  }
}

// לחיצה על כפתור הפעלה
function handlePlayClick(e) {
  const gameId = e.currentTarget.dataset.gameId;
  const game = gamesCatalog.find(g => g.id === gameId);
  
  if (!game) return;
  
  // אם יש פונקציית launch מותאמת
  if (typeof game.launch === 'function') {
    game.launch();
    return;
  }
  
  // פתיחת מודל
  openGameModal(game);
}

// פתיחת מודל משחק
function openGameModal(game) {
  if (!gameModal || !gameModalFrame) {
    window.open(game.playUrl, '_blank');
    return;
  }
  
  // הצגת טעינה
  if (gameModalLoading) {
    gameModalLoading.style.display = 'flex';
  }
  
  gameModalTitle.textContent = game.title;
  gameModalFrame.src = game.playUrl;
  gameModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  
  // הסתרת טעינה כשהמשחק נטען
  gameModalFrame.onload = () => {
    if (gameModalLoading) {
      gameModalLoading.style.display = 'none';
    }
  };
}

// סגירת מודל משחק
function closeGameModal() {
  if (!gameModal) return;
  
  gameModal.setAttribute('aria-hidden', 'true');
  gameModalFrame.src = '';
  document.body.classList.remove('modal-open');
}

// טיפול בכפתורי פעולה
function handleActionClick(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.action;
  const gameId = btn.dataset.gameId;
  
  switch (action) {
    case 'like':
      toggleLike(btn, gameId);
      break;
    case 'share':
      shareGame(gameId);
      break;
    case 'info':
      showGameInfo(gameId);
      break;
  }
}

// לייק
function toggleLike(btn, gameId) {
  const isLiked = likedGames.has(gameId);
  const icon = btn.querySelector('i');
  
  if (isLiked) {
    likedGames.delete(gameId);
    btn.classList.remove('game-card__action--liked');
    icon.classList.replace('fa-solid', 'fa-regular');
  } else {
    likedGames.add(gameId);
    btn.classList.add('game-card__action--liked');
    icon.classList.replace('fa-regular', 'fa-solid');
  }
  
  localStorage.setItem('sos_liked_games', JSON.stringify([...likedGames]));
}

// שיתוף
function shareGame(gameId) {
  const game = gamesCatalog.find(g => g.id === gameId);
  if (!game) return;
  
  if (navigator.share) {
    navigator.share({
      title: game.title,
      text: game.description,
      url: window.location.href
    });
  } else {
    // Fallback - העתקה ללוח
    navigator.clipboard?.writeText(window.location.href);
    alert('קישור הועתק!');
  }
}

// מידע על משחק
function showGameInfo(gameId) {
  const game = gamesCatalog.find(g => g.id === gameId);
  if (!game) return;
  
  alert(`${game.title}\n\nסטודיו: ${game.studio}\n\n${game.description}`);
}

// חזרה לדף הקודם - תמיד history.back() אם יש היסטוריה | HYPER CORE TECH
function handleBackClick() {
  // אם יש היסטוריה - חזור אחורה בלי רענון
  if (window.history.length > 1) {
    window.history.back();
  } else {
    // Fallback - אם אין היסטוריה, נווט לפיד
    window.location.href = './videos.html';
  }
}

// תפריט
function handleMenuClick() {
  // TODO: פתיחת תפריט אפשרויות
  console.log('Menu clicked');
}

// מסך מלא למודל
function handleFullscreenClick() {
  if (!gameModalFrame) return;
  
  if (gameModalFrame.requestFullscreen) {
    gameModalFrame.requestFullscreen();
  } else if (gameModalFrame.webkitRequestFullscreen) {
    gameModalFrame.webkitRequestFullscreen();
  }
}

// אתחול
function init() {
  renderGameCards();
  
  // מאזינים
  viewport?.addEventListener('scroll', handleScroll, { passive: true });
  backBtn?.addEventListener('click', handleBackClick);
  menuBtn?.addEventListener('click', handleMenuClick);
  gameModalClose?.addEventListener('click', closeGameModal);
  gameModalBackdrop?.addEventListener('click', closeGameModal);
  gameModalFullscreen?.addEventListener('click', handleFullscreenClick);
  
  // מקש Escape לסגירת מודל
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeGameModal();
  });
  
  // עדכון אינדיקטור התחלתי
  updateIndicator();
  
  console.log('[SOS Play] Games feed initialized with', gamesCatalog.length, 'games');
}

// הפעלה
document.addEventListener('DOMContentLoaded', init);
