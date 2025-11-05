// חלק יאללה ניוז (news-wave.js) – מנגנון משיכת RSS והצגת פיד חדשות בסגנון גלילה מדורגת | HYPER CORE TECH
import { NEWS_FEEDS } from './news-feeds-config.js';

// חלק יאללה ניוז (news-wave.js) – שימוש ב-Proxy יחיד יציב
const RSS_PROXY = 'https://corsproxy.io/?';
const MAX_ITEMS_PER_FEED = 12;
const SUMMARY_LIMIT = 200;

const state = {
  stories: [],
  activeCategory: 'all',
  categories: ['all'],
};

const selectors = {
  stream: null,
  status: null,
  bottomNav: null,
};

// חלק יאללה ניוז (news-wave.js) – יצירת הודעת סטטוס למשתמש בזמן קבלת המידע
function setStatus(message, tone = 'info') {
  if (!selectors.status) {
    return;
  }
  selectors.status.dataset.tone = tone;
  selectors.status.textContent = message;
}

// חלק יאללה ניוז (news-wave.js) – פענוח טקסט בטוח מתוך תיאור HTML
function extractText(htmlSnippet = '') {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlSnippet, 'text/html');
  return doc.body.textContent?.replace(/\s+/g, ' ').trim() || '';
}

// חלק יאללה ניוז (news-wave.js) – איתור תמונה מתוך ה-RSS (enclosure, media או IMG בתיאור)
function extractImage(item) {
  const enclosure = item.querySelector('enclosure[url]');
  if (enclosure?.getAttribute('url')) {
    return enclosure.getAttribute('url');
  }

  const media = item.querySelector('media\\:content, content');
  const mediaUrl = media?.getAttribute('url');
  if (mediaUrl) {
    return mediaUrl;
  }

  const description = item.querySelector('description');
  if (description) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(description.textContent, 'text/html');
    const img = doc.querySelector('img');
    if (img?.getAttribute('src')) {
      return img.getAttribute('src');
    }
  }

  return null;
}

// חלק יאללה ניוז (news-wave.js) – המרת תיאור לא תקני לסיכום קצר
function buildSummary(item) {
  const content = item.querySelector('description, content\\:encoded, summary');
  const text = extractText(content?.textContent || '');
  if (text.length <= SUMMARY_LIMIT) {
    return text;
  }
  return `${text.slice(0, SUMMARY_LIMIT).trim()}...`;
}

// חלק יאללה ניוז (news-wave.js) – יצירת מזהה ייחודי לכרטיס חדשות
function computeStoryId(feed, item, index) {
  const guid = item.querySelector('guid')?.textContent?.trim();
  if (guid) {
    return guid;
  }
  const title = item.querySelector('title')?.textContent?.trim() || 'story';
  return `${feed.id}-${index}-${title.slice(0, 32).replace(/[^a-zA-Z0-9א-ת]+/g, '-')}`;
}

// חלק יאללה ניוז (news-wave.js) – נירמול פריטי RSS למבנה אחיד
function normalizeFeed(feed, xmlDoc) {
  const items = Array.from(xmlDoc.querySelectorAll('item')).slice(0, MAX_ITEMS_PER_FEED);
  return items
    .map((item, index) => {
      const title = item.querySelector('title')?.textContent?.trim();
      const link = item.querySelector('link')?.textContent?.trim();
      if (!title || !link) {
        return null;
      }

      const published = item.querySelector('pubDate, dc\\:date');
      const publishedAt = published ? new Date(published.textContent) : new Date();
      const storyId = computeStoryId(feed, item, index);

      return {
        id: storyId,
        title,
        link,
        summary: buildSummary(item),
        category: feed.category,
        source: feed.source,
        label: feed.label,
        publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt,
        imageUrl: extractImage(item),
      };
    })
    .filter(Boolean);
}

// חלק יאללה ניוז (news-wave.js) – שליפת פיד בודד דרך Proxy
async function fetchFeed(feed) {
  const proxiedUrl = `${RSS_PROXY}${encodeURIComponent(feed.url)}`;
  
  try {
    const response = await fetch(proxiedUrl, { 
      cache: 'no-store',
      signal: AbortSignal.timeout(10000)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const payload = await response.text();
    const parser = new DOMParser();
    const xml = parser.parseFromString(payload, 'text/xml');
    const hasError = xml.querySelector('parsererror');
    
    if (hasError) {
      throw new Error('פורמט XML לא תקין');
    }
    
    return normalizeFeed(feed, xml);
  } catch (error) {
    console.warn(`נכשל בטעינת ${feed.label}:`, error.message);
    throw error;
  }
}

// חלק יאללה ניוז (news-wave.js) – בניית קלף HTML לכל כתבה
function renderStoryCard(story) {
  const article = document.createElement('article');
  article.className = 'news-wave__card';
  article.setAttribute('role', 'listitem');
  article.setAttribute('data-category', story.category);

  const media = document.createElement('div');
  media.className = 'news-wave__media';
  if (story.imageUrl) {
    const img = document.createElement('img');
    img.src = story.imageUrl;
    img.alt = `תמונה מתוך ${story.source}`;
    media.appendChild(img);
  } else {
    media.innerHTML = '<i class="fa-regular fa-newspaper fa-3x" aria-hidden="true"></i>';
  }

  const content = document.createElement('div');
  content.className = 'news-wave__content';

  const metaRow = document.createElement('div');
  metaRow.className = 'news-wave__meta';
  metaRow.innerHTML = `
    <span class="news-wave__source">
      <i class="fa-solid fa-broadcast-tower" aria-hidden="true"></i>
      ${story.source}
    </span>
    <span class="news-wave__category-label">${story.category}</span>
  `;

  const title = document.createElement('h2');
  title.className = 'news-wave__title';
  title.textContent = story.title;

  const summary = document.createElement('p');
  summary.className = 'news-wave__summary';
  summary.textContent = story.summary || 'תיאור לא זמין לפריט זה, לחצו לקריאה מלאה.';

  const actions = document.createElement('div');
  actions.className = 'news-wave__actions';

  const readMore = document.createElement('a');
  readMore.className = 'news-wave__read-more';
  readMore.href = story.link;
  readMore.target = '_blank';
  readMore.rel = 'noopener noreferrer';
  readMore.innerHTML = '<i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> קריאה מלאה';

  actions.appendChild(readMore);

  content.append(metaRow, title, summary, actions);
  article.append(media, content);

  return article;
}

// חלק יאללה ניוז (news-wave.js) – ריענון תצוגת הקלפים לפי הקטגוריה הפעילה
function renderStories() {
  if (!selectors.stream) {
    return;
  }
  selectors.stream.innerHTML = '';

  const filtered = state.stories.filter((story) => story.category === state.activeCategory);

  if (!filtered.length) {
    setStatus('לא נמצאו פריטי חדשות בקטגוריה שנבחרה.', 'warn');
    return;
  }

  const fragment = document.createDocumentFragment();
  filtered.forEach((story) => {
    fragment.appendChild(renderStoryCard(story));
  });

  selectors.stream.appendChild(fragment);
  const uniqueSources = new Set(filtered.map((story) => story.source));
  setStatus(`מציג ${filtered.length} פריטים מ-${uniqueSources.size} מקורות.`);
  
  // הפעלת Intersection Observer לאחר רנדור
  setTimeout(() => setupIntersectionObserver(), 100);
}

// חלק יאללה ניוז (news-wave.js) – עדכון מצב כפתורי התפריט התחתון
function updateBottomNav() {
  if (!selectors.bottomNav) {
    return;
  }

  const buttons = selectors.bottomNav.querySelectorAll('.news-bottom-nav__item');
  buttons.forEach((button) => {
    const category = button.dataset.category;
    button.classList.toggle('is-active', category === state.activeCategory);
  });
}

// חלק יאללה ניוז (news-wave.js) – ערבוב כתבות כך שיוצגו ממקורות שונים לסירוגין
function interleaveStories(stories) {
  const buckets = new Map();
  stories.forEach((story) => {
    if (!buckets.has(story.source)) {
      buckets.set(story.source, []);
    }
    buckets.get(story.source).push(story);
  });

  buckets.forEach((list) => {
    list.sort((a, b) => b.publishedAt - a.publishedAt);
  });

  const rounds = Array.from(buckets.values()).map((list) => list.slice());
  const mixed = [];
  let hasItems = true;
  while (hasItems) {
    hasItems = false;
    rounds.forEach((list) => {
      if (list.length) {
        mixed.push(list.shift());
        hasItems = true;
      }
    });
  }

  return mixed;
}

// חלק יאללה ניוז (news-wave.js) – תהליך הטעינה המרכזי: Fetch → Normalize → Render
async function loadNews() {
  setStatus('טוען מקורות חדשות...');
  try {
    const feedPromises = NEWS_FEEDS.map((feed) => fetchFeed(feed).catch((error) => ({ error, feed })));
    const results = await Promise.all(feedPromises);

    const allStories = [];
    const errors = [];

    results.forEach((result) => {
      if (Array.isArray(result)) {
        allStories.push(...result);
      } else if (result?.error) {
        errors.push(result.feed.label);
      }
    });

    const mixedStories = interleaveStories(allStories);
    state.categories = Array.from(new Set(mixedStories.map((story) => story.category)));
    state.stories = mixedStories;
    
    // אם אין קטגוריה פעילה, הגדר את הראשונה
    if (!state.categories.includes(state.activeCategory)) {
      state.activeCategory = state.categories[0] || 'חדשות';
    }
    
    updateBottomNav();
    renderStories();

    if (errors.length) {
      setStatus(`חלק מהמקורות לא נטענו: ${errors.join(', ')}.`, 'warn');
    }
  } catch (error) {
    console.error('News feed error:', error);
    setStatus('התרחשה שגיאה בעת טעינת החדשות. נסו שוב מאוחר יותר.', 'error');
  }
}

// חלק יאללה ניוז (news-wave.js) – הגדרת Intersection Observer לאפקט טשטוש
function setupIntersectionObserver() {
  const viewport = document.querySelector('.news-wave__viewport');
  if (!viewport) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
          entry.target.classList.add('in-view');
        } else {
          entry.target.classList.remove('in-view');
        }
      });
    },
    {
      root: viewport,
      threshold: [0, 0.25, 0.5, 0.6, 0.75, 1],
      rootMargin: '-10% 0px -10% 0px'
    }
  );

  const cards = document.querySelectorAll('.news-wave__card');
  cards.forEach((card) => observer.observe(card));

  return observer;
}

// חלק יאללה ניוז (news-wave.js) – אתחול בעת טעינת הדף
function init() {
  selectors.stream = document.getElementById('newsWaveStream');
  selectors.status = document.getElementById('newsWaveStatus');
  selectors.bottomNav = document.querySelector('.news-bottom-nav');

  if (!selectors.stream || !selectors.status) {
    return;
  }

  // חלק יאללה ניוז (news-wave.js) – חיבור תפריט תחתון
  if (selectors.bottomNav) {
    const buttons = selectors.bottomNav.querySelectorAll('.news-bottom-nav__item');
    buttons.forEach((button) => {
      button.addEventListener('click', () => {
        state.activeCategory = button.dataset.category;
        updateBottomNav();
        renderStories();
        setTimeout(() => setupIntersectionObserver(), 100);
      });
    });
  }

  // חלק יאללה ניוז (news-wave.js) – חיבור כפתור חזרה לדף הבית
  const homeButton = document.getElementById('newsTopHomeButton');
  if (homeButton) {
    homeButton.addEventListener('click', () => {
      window.location.href = './index.html';
    });
  }

  // חלק יאללה ניוז (news-wave.js) – חיבור כפתור רענון
  const refreshButton = document.getElementById('newsTopRefreshButton');
  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      setStatus('מרענן...');
      loadNews();
    });
  }

  loadNews();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
