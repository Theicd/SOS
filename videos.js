// חלק דף וידאו (videos.js) – מנגנון משיכת וידאו והצגת פיד בסגנון טיקטוק | HYPER CORE TECH

// המתנה לטעינת App והפיד
function waitForApp() {
  return new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 100;

    const checkApp = () => {
      attempts++;
      // ממתין ל-pool ול-relayUrls מוכנים; לא תלוי ב-postsById
      if (window.NostrApp && window.NostrApp.pool && Array.isArray(window.NostrApp.relayUrls)) {
        console.log('[videos] waitForApp: pool+relays ready', { relays: window.NostrApp.relayUrls?.length || 0 });
        resolve(window.NostrApp);
      } else if (attempts >= maxAttempts) {
        console.warn('[videos] waitForApp: App לא נטען אחרי', maxAttempts, 'ניסיונות');
        resolve(window.NostrApp || {});
      } else {
        setTimeout(checkApp, 200);
      }
    };

    checkApp();
  });
}

// חלק יאללה וידאו (videos.js) – חיבור בקרי מדיה (Play/Pause)
function wireMediaControls() {
  document.querySelectorAll('.videos-feed__media').forEach((mediaDiv) => {
    if (mediaDiv.dataset.mediaControlsWired === 'true') return;
    mediaDiv.dataset.mediaControlsWired = 'true';

    const toggleBtn = mediaDiv.querySelector('[data-play-toggle]');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (mediaDiv.dataset.state === 'playing') {
          pauseMedia(mediaDiv, { resetThumb: false, manual: true });
        } else {
          playMedia(mediaDiv, { manual: true });
        }
      });
    }

    // לחיצה על אזור המדיה תחליף בין ניגון להפסקה ידנית (ללא כפתור)
    mediaDiv.addEventListener('click', (event) => {
      // אם לחצו על כפתור ייעודי, לא להפעיל את הטוגל פעמיים
      if (event.target.closest('[data-play-toggle]')) return;
      if (mediaDiv.dataset.state === 'playing') {
        pauseMedia(mediaDiv, { resetThumb: false, manual: true });
      } else {
        playMedia(mediaDiv, { manual: true });
      }
    });
  });
}

// חלק יאללה וידאו (videos.js) – הפעלה אוטומטית של הווידאו הראשון
function autoPlayFirstVideo() {
  if (!selectors.stream) return;
  const firstCard = selectors.stream.querySelector('.videos-feed__card');
  if (!firstCard) return;
  const mediaDiv = firstCard.querySelector('.videos-feed__media');
  if (mediaDiv) {
    playMedia(mediaDiv, { manual: false, priority: true });
  }
}

// חלק יאללה וידאו (videos.js) – הפעלת מדיה עבור כרטיס נתון
function playMedia(mediaDiv, { manual = false, priority = false } = {}) {
  if (!mediaDiv) return;
  if (activeMediaDiv && activeMediaDiv !== mediaDiv) {
    pauseMedia(activeMediaDiv, { resetThumb: false });
  }

  const mediaType = mediaDiv.dataset.mediaType;
  if (!mediaType) return;

  if (mediaType === 'file') {
    const videoEl = mediaDiv.querySelector('video');
    if (!videoEl) return;
    mediaDiv.classList.add('videos-feed__media--ready');
    
    // ניסיון להפעיל עם צליל
    videoEl.muted = false;
    videoEl.play().catch(() => {
      // אם autoplay עם צליל נכשל, ננסה עם mute
      videoEl.muted = true;
      videoEl.play().catch(() => {
        // גם עם mute נכשל – להחזיר מצב נייח
        videoEl.pause();
      });
    });
  } else if (mediaType === 'youtube') {
    ensureYouTubeIframe(mediaDiv, { autoplay: true });
  }

  mediaDiv.dataset.state = 'playing';
  updatePlayToggleIcon(mediaDiv, true);
  // הסרת חיווי עצירה ידנית
  mediaDiv.classList.remove('is-paused');
  activeMediaDiv = mediaDiv;
}

// חלק יאללה וידאו (videos.js) – עצירת מדיה עבור כרטיס נתון
function pauseMedia(mediaDiv, { resetThumb = false, manual = false } = {}) {
  if (!mediaDiv) return;
  const mediaType = mediaDiv.dataset.mediaType;
  if (!mediaType) return;

  if (mediaType === 'file') {
    const videoEl = mediaDiv.querySelector('video');
    if (videoEl) {
      videoEl.pause();
    }
  } else if (mediaType === 'youtube') {
    const iframe = mediaDiv.querySelector('iframe');
    if (iframe) {
      iframe.contentWindow?.postMessage('{"event":"command","func":"pauseVideo","args":[]}', '*');
      if (resetThumb) {
        iframe.remove();
        restoreYouTubeThumbnail(mediaDiv);
      }
    } else if (resetThumb) {
      restoreYouTubeThumbnail(mediaDiv);
    }
  }

  mediaDiv.dataset.state = 'paused';
  updatePlayToggleIcon(mediaDiv, false);
  // הוספת חיווי עצירה רק אם זו עצירה ידנית; עצירות אוטומטיות (גלילה/כרטיס אחר) לא יציגו את האייקון
  if (manual) {
    mediaDiv.classList.add('is-paused');
  } else {
    mediaDiv.classList.remove('is-paused');
  }
  if (activeMediaDiv === mediaDiv) {
    activeMediaDiv = null;
  }
}

function updatePlayToggleIcon(mediaDiv, isPlaying) {
  const toggleBtn = mediaDiv.querySelector('[data-play-toggle]');
  if (!toggleBtn) return;
  toggleBtn.innerHTML = isPlaying ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
  toggleBtn.setAttribute('aria-label', isPlaying ? 'Pause video' : 'Play video');
}

function ensureYouTubeIframe(mediaDiv, { autoplay = false } = {}) {
  let iframe = mediaDiv.querySelector('iframe');
  if (!iframe) {
    const youtubeId = mediaDiv.dataset.youtubeId;
    if (!youtubeId) return;
    iframe = document.createElement('iframe');
    iframe.className = 'videos-feed__media-iframe';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.allowFullscreen = true;
    iframe.src = `https://www.youtube.com/embed/${youtubeId}?enablejsapi=1&autoplay=${autoplay ? 1 : 0}&rel=0`;
    // הסתרת תמונה ממוזערת אם קיימת
    const thumb = mediaDiv.querySelector('.videos-feed__media-thumb');
    if (thumb) thumb.style.opacity = '0';
    mediaDiv.insertBefore(iframe, mediaDiv.firstChild);
  } else if (autoplay) {
    iframe.contentWindow?.postMessage('{"event":"command","func":"playVideo","args":[]}', '*');
  }
}

function restoreYouTubeThumbnail(mediaDiv) {
  const youtubeId = mediaDiv.dataset.youtubeId;
  if (!youtubeId) return;
  if (!mediaDiv.querySelector('.videos-feed__media-thumb')) {
    const thumb = document.createElement('img');
    thumb.src = `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`;
    thumb.alt = 'YouTube Video';
    thumb.className = 'videos-feed__media-thumb';
    // fallback לתמונה קטנה יותר אם maxresdefault לא קיים
    thumb.onerror = () => {
      thumb.src = `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
      thumb.onerror = null;
    };
    mediaDiv.insertBefore(thumb, mediaDiv.firstChild);
  } else {
    mediaDiv.querySelector('.videos-feed__media-thumb').style.opacity = '1';
  }
}

// חלק יאללה וידאו (videos.js) – שאילת פוסטים לפי רשת המשתמש (authors)
async function fetchNetworkNotes(authors = [], limit = 500) {
  const app = window.NostrApp;
  if (!app || !app.pool || !Array.isArray(app.relayUrls) || app.relayUrls.length === 0) return [];
  if (!Array.isArray(authors) || authors.length === 0) return [];
  const since = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30;
  const networkTag = getNetworkTag();
  const filters = [{ kinds: [1], authors, since, limit, '#t': [networkTag] }];
  try {
    if (typeof app.pool.list === 'function') {
      const r = await app.pool.list(app.relayUrls, filters);
      if (Array.isArray(r) && r.length) return r;
    }
    if (typeof app.pool.listMany === 'function') {
      const r = await app.pool.listMany(app.relayUrls, filters);
      if (Array.isArray(r) && r.length) return r;
    }
    if (typeof app.pool.querySync === 'function') {
      const res = await app.pool.querySync(app.relayUrls, filters[0]);
      const ev = Array.isArray(res) ? res : (Array.isArray(res?.events) ? res.events : []);
      if (ev.length) return ev;
    }
  } catch (_) {
    // ignore and fallback to empty
  }
  return [];
}

const App = window.NostrApp || (window.NostrApp = {});

const state = {
  videos: [],
  currentIndex: 0,
};

const selectors = {
  stream: null,
  status: null,
};

let activeMediaDiv = null;
let intersectionObserver = null;

// חלק יאללה וידאו (videos.js) – פונקציית עזר להבאת תג הרשת העיקרי
function getNetworkTag() {
  const app = window.NostrApp;
  if (app && typeof app.NETWORK_TAG === 'string' && app.NETWORK_TAG.trim()) {
    return app.NETWORK_TAG.trim();
  }
  return 'israel-network';
}

// חלק יאללה וידאו (videos.js) – בניית פילטרים לשימוש משותף בין מודולים | HYPER CORE TECH
function buildVideoFeedFilters() {
  const app = window.NostrApp || {};

  if (typeof app.buildCoreFeedFilters === 'function' && app.buildCoreFeedFilters !== buildVideoFeedFilters) {
    try {
      return app.buildCoreFeedFilters();
    } catch (err) {
      console.warn('[videos] buildCoreFeedFilters failed, using local filters', err);
    }
  }

  const networkTag = getNetworkTag();
  const filters = [{ kinds: [1], '#t': [networkTag], limit: 200 }];
  const viewerKey = typeof app.publicKey === 'string' ? app.publicKey : '';

  if (viewerKey) {
    filters.push({ kinds: [1], authors: [viewerKey], limit: 50 });

    const deletionAuthors = new Set();
    deletionAuthors.add(viewerKey.toLowerCase());
    if (app.adminPublicKeys instanceof Set) {
      app.adminPublicKeys.forEach((key) => {
        if (typeof key === 'string' && key) {
          deletionAuthors.add(key.toLowerCase());
        }
      });
    }

    if (deletionAuthors.size > 0) {
      filters.push({ kinds: [5], authors: Array.from(deletionAuthors), limit: 200 });
    } else {
      filters.push({ kinds: [5], '#t': [networkTag], limit: 200 });
    }

    filters.push({ kinds: [7], '#t': [networkTag], limit: 500 });

    const datingKind = typeof app.DATING_LIKE_KIND === 'number' ? app.DATING_LIKE_KIND : 9000;
    const datingFilter = { kinds: [datingKind], '#p': [viewerKey], limit: 200 };
    if (networkTag) {
      datingFilter['#t'] = [networkTag];
    }
    filters.push(datingFilter);

    const followKind = typeof app.FOLLOW_KIND === 'number' ? app.FOLLOW_KIND : 40010;
    filters.push({ kinds: [followKind], '#p': [viewerKey], limit: 200 });
  } else {
    filters.push({ kinds: [5], '#t': [networkTag], limit: 200 });
    filters.push({ kinds: [7], '#t': [networkTag], limit: 500 });
  }

  return filters;
}

// חלק יאללה וידאו (videos.js) – בדיקה האם אירוע שייך לרשת שלנו
function eventHasNetworkTag(event, networkTag) {
  if (!event || !Array.isArray(event.tags)) {
    return false;
  }
  return event.tags.some((tag) => Array.isArray(tag) && tag[0] === 't' && tag[1] === networkTag);
}

// חלק יאללה וידאו (videos.js) – מסנן מערכי אירועים לפי תג הרשת
function filterEventsByNetwork(events, networkTag) {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }
  return events.filter((event) => eventHasNetworkTag(event, networkTag));
}

// חלק יאללה וידאו (videos.js) – יצירת הודעת סטטוס למשתמש
function setStatus(message) {
  if (!selectors.status) {
    return;
  }
  selectors.status.textContent = message;
  selectors.status.style.display = 'block';
}

// חלק יאללה וידאו (videos.js) – זיהוי אם קישור הוא YouTube
function parseYouTube(link) {
  if (!link) return null;
  const shortMatch = link.match(/^https?:\/\/youtu\.be\/([\w-]{11})(?:\?.*)?$/i);
  if (shortMatch) return shortMatch[1];
  const longMatch = link.match(/^https?:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})(?:&.*)?$/i);
  if (longMatch) return longMatch[1];
  const embedMatch = link.match(/^https?:\/\/www\.youtube\.com\/embed\/([\w-]{11})(?:\?.*)?$/i);
  if (embedMatch) return embedMatch[1];
  return null;
}

// חלק יאללה וידאו (videos.js) – זיהוי אם קישור הוא וידאו
function isVideoLink(link) {
  if (!link) return false;
  if (link.startsWith('data:video')) return true;
  if (/\.(mp4|webm|ogg)$/i.test(link)) return true;
  return false;
}

// חלק יאללה וידאו (videos.js) – בניית קלף HTML לכל וידאו
function renderVideoCard(video) {
  const article = document.createElement('article');
  article.className = 'videos-feed__card';
  article.setAttribute('role', 'listitem');
  article.setAttribute('data-event-id', video.id);

  const mediaDiv = document.createElement('div');
  mediaDiv.className = 'videos-feed__media';

  if (video.youtubeId) {
    mediaDiv.dataset.mediaType = 'youtube';
    mediaDiv.dataset.youtubeId = video.youtubeId;

    const thumb = document.createElement('img');
    thumb.src = `https://i.ytimg.com/vi/${video.youtubeId}/maxresdefault.jpg`;
    thumb.alt = 'YouTube Video';
    thumb.className = 'videos-feed__media-thumb';
    // fallback לתמונה קטנה יותר אם maxresdefault לא קיים
    thumb.onerror = () => {
      thumb.src = `https://i.ytimg.com/vi/${video.youtubeId}/hqdefault.jpg`;
      thumb.onerror = null; // מונע לולאה אינסופית
    };
    mediaDiv.appendChild(thumb);

    const playOverlay = document.createElement('button');
    playOverlay.type = 'button';
    playOverlay.className = 'videos-feed__play-overlay';
    playOverlay.setAttribute('aria-label', 'Play video');
    playOverlay.setAttribute('data-play-toggle', '');
    playOverlay.innerHTML = '<i class="fa-solid fa-play"></i>';
    mediaDiv.appendChild(playOverlay);
  } else if (video.videoUrl) {
    mediaDiv.dataset.mediaType = 'file';
    mediaDiv.dataset.videoUrl = video.videoUrl;

    const videoEl = document.createElement('video');
    videoEl.src = video.videoUrl;
    videoEl.controls = false;
    videoEl.muted = false;
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', 'true');
    videoEl.setAttribute('webkit-playsinline', 'true');
    videoEl.preload = 'metadata';
    videoEl.className = 'videos-feed__media-video';
    mediaDiv.appendChild(videoEl);

    const playOverlay = document.createElement('button');
    playOverlay.type = 'button';
    playOverlay.className = 'videos-feed__play-overlay';
    playOverlay.setAttribute('aria-label', 'Play video');
    playOverlay.setAttribute('data-play-toggle', '');
    playOverlay.innerHTML = '<i class="fa-solid fa-play"></i>';
    mediaDiv.appendChild(playOverlay);
  }

  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'videos-feed__actions';

  const currentApp = window.NostrApp || {};
  const likeCount = currentApp.likesByEventId?.get(video.id)?.size || 0;
  const isLiked = currentApp.likesByEventId?.get(video.id)?.has(currentApp.publicKey) || false;
  const commentCount = currentApp.commentsByParent?.get(video.id)?.length || 0;

  actionsDiv.innerHTML = `
    <button class="videos-feed__action ${isLiked ? 'videos-feed__action--liked' : ''}" data-like-button data-event-id="${video.id}">
      <i class="fa-solid fa-heart"></i>
      <span class="videos-feed__action-count feed-post__like-count" style="${likeCount > 0 ? '' : 'display:none'}">${likeCount > 0 ? likeCount : ''}</span>
    </button>
    <button class="videos-feed__action" data-comment-button data-event-id="${video.id}">
      <i class="fa-solid fa-comment"></i>
      <span class="videos-feed__action-count" style="${commentCount > 0 ? '' : 'display:none'}">${commentCount > 0 ? commentCount : ''}</span>
    </button>
    <button class="videos-feed__action" data-share-button data-event-id="${video.id}">
      <i class="fa-solid fa-share"></i>
    </button>
  `;

  const viewerPubkey = typeof currentApp.publicKey === 'string' ? currentApp.publicKey.toLowerCase() : '';
  const videoOwnerPubkey = typeof video.pubkey === 'string' ? video.pubkey.toLowerCase() : '';
  const isSelf = viewerPubkey && videoOwnerPubkey ? viewerPubkey === videoOwnerPubkey : video.pubkey === currentApp.publicKey;
  const isFollowing = currentApp.followingSet?.has(videoOwnerPubkey || video.pubkey) || false;
  const isAdminUser = currentApp.adminPublicKeys instanceof Set && viewerPubkey
    ? currentApp.adminPublicKeys.has(viewerPubkey)
    : false;

  const canEdit = isSelf;
  const canDelete = isSelf || isAdminUser;

  if (isSelf) {
    // חלק תפריט פיד ווידאו (videos.js) – הוספת כפתור שלוש נקודות כמו בפיד הראשי לעריכה/מחיקה של המשתמש | HYPER CORE TECH
    const menuWrap = document.createElement('div');
    menuWrap.className = 'feed-post__menu-wrap videos-feed__menu-wrap';
    menuWrap.setAttribute('data-video-menu-wrap', video.id);

    const menuToggle = document.createElement('button');
    menuToggle.type = 'button';
    menuToggle.className = 'videos-feed__action feed-post__menu-toggle';
    menuToggle.setAttribute('aria-haspopup', 'true');
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('data-post-menu-toggle', video.id);
    menuToggle.setAttribute('title', 'אפשרויות');
    menuToggle.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';

    const editButtonHtml = canEdit
      ? `
        <button class="feed-post__action feed-post__action--edit" type="button" onclick="NostrApp.openEditPost('${video.id}')">
          <i class="fa-solid fa-pen-to-square"></i>
          <span>ערוך</span>
        </button>
      `
      : '';
    const deleteButtonHtml = canDelete
      ? `
        <button class="feed-post__action feed-post__action--delete" type="button" onclick="NostrApp.deletePost('${video.id}')">
          <i class="fa-solid fa-trash"></i>
          <span>מחק</span>
        </button>
      `
      : '';

    const menu = document.createElement('div');
    menu.className = 'feed-post__menu videos-feed__menu';
    menu.setAttribute('data-post-menu', video.id);
    menu.setAttribute('hidden', '');
    menu.hidden = true;
    menu.innerHTML = `${editButtonHtml}${deleteButtonHtml}`;

    menuWrap.appendChild(menuToggle);
    menuWrap.appendChild(menu);
    actionsDiv.appendChild(menuWrap);

    const markToggleAsWired = () => {
      const card = menuWrap.closest('.videos-feed__card') || article;
      const toggle = menuWrap.querySelector(`[data-post-menu-toggle="${video.id}"]`);
      if (!card || !toggle || toggle.dataset.menuWired === '1') {
        return;
      }
      const appRef = window.NostrApp;
      toggle.dataset.menuWired = '1';
      toggle.setAttribute('aria-expanded', 'false');
      if (typeof appRef?.wirePostMenu === 'function') {
        appRef.wirePostMenu(card, video.id);
      } else {
        wireVideoPostMenu(card, video.id);
      }
    };

    setTimeout(markToggleAsWired, 0);
  } else {
    // כפתור עקוב מעודכן לשימוש בשירות העוקבים הכללי | HYPER CORE TECH
    const followBtn = document.createElement('button');
    followBtn.type = 'button';
    followBtn.className = `videos-feed__action ${isFollowing ? 'is-following' : ''}`;
    // חלק עוקבים (videos.js) – שימוש ב-lowercase pubkey כמו בפיד הראשי לריענון עקב/בטל עקב | HYPER CORE TECH
    followBtn.setAttribute('data-follow-button', videoOwnerPubkey || video.pubkey);
    followBtn.innerHTML = `
      <i class="fa-solid ${isFollowing ? 'fa-user-minus' : 'fa-user-plus'}"></i>
      <span data-follow-label>${isFollowing ? 'עוקב/ת' : 'עקוב'}</span>
    `;
    actionsDiv.appendChild(followBtn);

    if (typeof currentApp.refreshFollowButtons === 'function') {
      currentApp.refreshFollowButtons(actionsDiv);
    }
  }

  if (!isSelf && canDelete) {
    // חלק תפריט מנהל (videos.js) – מאפשר לאדמין למחוק פוסט וידאו של משתמש אחר באמצעות הפונקציה הקיימת | HYPER CORE TECH
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'videos-feed__action feed-post__action feed-post__action--delete';
    deleteBtn.setAttribute('data-admin-delete', video.id);
    deleteBtn.innerHTML = `
      <i class="fa-solid fa-trash"></i>
      <span>מחק</span>
    `;
    deleteBtn.addEventListener('click', () => {
      if (typeof currentApp.deletePost === 'function') {
        currentApp.deletePost(video.id);
      }
    });
    actionsDiv.appendChild(deleteBtn);
  }

  const infoDiv = document.createElement('div');
  infoDiv.className = 'videos-feed__info';

  const authorDiv = document.createElement('div');
  authorDiv.className = 'videos-feed__author';

  const avatarDiv = document.createElement('div');
  avatarDiv.className = 'videos-feed__avatar';
  if (video.authorPicture) {
    const img = document.createElement('img');
    img.src = video.authorPicture;
    img.alt = video.authorName;
    avatarDiv.appendChild(img);
  } else {
    avatarDiv.textContent = video.authorInitials || 'AN';
  }
  // לחיצה על האווטר תפתח פרופיל ציבורי | HYPER CORE TECH
  avatarDiv.style.cursor = 'pointer';
  avatarDiv.addEventListener('click', () => {
    if (video.pubkey && typeof window.openProfileByPubkey === 'function') {
      window.openProfileByPubkey(video.pubkey);
    }
  });

  const nameSpan = document.createElement('span');
  nameSpan.className = 'videos-feed__name';
  nameSpan.textContent = video.authorName || 'משתמש';
  // לחיצה על השם תפתח פרופיל ציבורי | HYPER CORE TECH
  nameSpan.style.cursor = 'pointer';
  nameSpan.addEventListener('click', () => {
    if (video.pubkey && typeof window.openProfileByPubkey === 'function') {
      window.openProfileByPubkey(video.pubkey);
    }
  });

  authorDiv.appendChild(avatarDiv);
  authorDiv.appendChild(nameSpan);

  const contentDiv = document.createElement('div');
  contentDiv.className = 'videos-feed__content';
  contentDiv.textContent = video.content || '';

  infoDiv.appendChild(authorDiv);
  if (video.content) {
    infoDiv.appendChild(contentDiv);
    // בדיקת גלישת טקסט והוספת כפתור "עוד" לפתיחת חלונית טקסט מלאה | HYPER CORE TECH
    setTimeout(() => {
      try {
        if (contentDiv.scrollHeight > (contentDiv.clientHeight + 2)) {
          const moreBtn = document.createElement('button');
          moreBtn.type = 'button';
          moreBtn.className = 'videos-feed__more';
          moreBtn.textContent = 'עוד';
          moreBtn.addEventListener('click', (e) => {
            e.preventDefault();
            openPostTextPanel({
              authorName: video.authorName || 'משתמש',
              authorPicture: video.authorPicture || '',
              content: video.content || ''
            });
          });
          contentDiv.appendChild(moreBtn);

          // גם לחיצה על הטקסט עצמו תפתח את החלונית | HYPER CORE TECH
          contentDiv.style.cursor = 'pointer';
          contentDiv.addEventListener('click', () => {
            openPostTextPanel({
              authorName: video.authorName || 'משתמש',
              authorPicture: video.authorPicture || '',
              content: video.content || ''
            });
          }, { once: false });
        }
      } catch (_) {}
    }, 0);
  }

  article.appendChild(mediaDiv);
  article.appendChild(actionsDiv);
  article.appendChild(infoDiv);

  return article;
}

// חלק תפריט פיד ווידאו (videos.js) – חיבור fallback לפתיחה/סגירה של תפריט העריכה | HYPER CORE TECH
function wireVideoPostMenu(rootEl, postId) {
  if (!rootEl || !postId) {
    return;
  }
  const toggle = rootEl.querySelector(`[data-post-menu-toggle="${postId}"]`);
  const menu = rootEl.querySelector(`[data-post-menu="${postId}"]`);
  if (!toggle || !menu) {
    return;
  }

  const close = () => {
    if (!menu.hasAttribute('hidden')) {
      menu.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onOutside, true);
      document.removeEventListener('keydown', onKey);
    }
  };
  const onOutside = (event) => {
    if (!menu.contains(event.target) && !toggle.contains(event.target)) {
      close();
    }
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      close();
    }
  };

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    const hidden = menu.hasAttribute('hidden');
    if (hidden) {
      menu.removeAttribute('hidden');
      toggle.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', onOutside, true);
      document.addEventListener('keydown', onKey);
    } else {
      close();
    }
  });
}

// חלק יאללה וידאו (videos.js) – רינדור כל הווידאו
function renderVideos() {
  if (!selectors.stream) return;
  selectors.stream.innerHTML = '';

  if (!Array.isArray(state.videos) || state.videos.length === 0) {
    setStatus('אין סרטונים להצגה');
    return;
  }

  const fragment = document.createDocumentFragment();
  state.videos.forEach((video) => {
    fragment.appendChild(renderVideoCard(video));
  });

  selectors.stream.appendChild(fragment);
  // הסתרת הסטטוס אחרי שהכל נטען
  if (selectors.status) {
    selectors.status.style.display = 'none';
  }

  setTimeout(() => setupIntersectionObserver(), 100);
  wireActions();
  wireMediaControls();
  autoPlayFirstVideo();
  setupLikeUpdateListener();
  setupAutoHideControls();
}

// חלק יאללה וידאו (videos.js) – הצגת כפתורים לכרטיס ספציפי
function showControlsForCard(card) {
  if (!card) return;
  
  // ביטול timeout קודם אם קיים
  if (card._hideTimeout) {
    clearTimeout(card._hideTimeout);
  }
  
  // הצגת כפתורים - קבוע, ללא הסתרה אוטומטית
  card.classList.remove('controls-hidden');
}

// חלק יאללה וידאו (videos.js) – כפתורים קבועים תמיד גלויים
function setupAutoHideControls() {
  const cards = document.querySelectorAll('.videos-feed__card');
  
  cards.forEach(card => {
    // הכפתורים מוצגים תמיד (ללא מחלקת controls-hidden)
    card.classList.remove('controls-hidden');
    
    // ביטול כל timeout קיים
    if (card._hideTimeout) {
      clearTimeout(card._hideTimeout);
      delete card._hideTimeout;
    }
  });
}

// חלק יאללה וידאו (videos.js) – עדכון כפתור לייק בדף הווידאו
function updateVideoLikeButton(eventId) {
  if (!eventId) return;
  const button = document.querySelector(`button[data-like-button][data-event-id="${eventId}"]`);
  if (!button) return;

  const app = window.NostrApp;
  const likeSet = app?.likesByEventId?.get(eventId);
  const count = likeSet ? likeSet.size : 0;
  const counterEl = button.querySelector('.videos-feed__action-count');
  
  if (counterEl) {
    if (count > 0) {
      counterEl.textContent = String(count);
      counterEl.style.display = '';
    } else {
      counterEl.textContent = '';
      counterEl.style.display = 'none';
    }
  }

  const currentUser = typeof app?.publicKey === 'string' ? app.publicKey.toLowerCase() : '';
  if (currentUser && likeSet && likeSet.has(currentUser)) {
    button.classList.add('videos-feed__action--liked');
  } else {
    button.classList.remove('videos-feed__action--liked');
  }
}

// חלק יאללה וידאו (videos.js) – מאזין לעדכוני לייקים גלובליים
function setupLikeUpdateListener() {
  const app = window.NostrApp;
  if (!app || typeof app.registerLike !== 'function') return;
  
  // שמירת הפונקציה המקורית
  const originalRegisterLike = app.registerLike;
  
  // עטיפה שמעדכנת גם את הכפתורים בדף הווידאו
  app.registerLike = function(event) {
    const result = originalRegisterLike.call(this, event);
    
    // עדכון כפתורי הלייק בדף הווידאו
    if (event && Array.isArray(event.tags)) {
      event.tags.forEach((tag) => {
        if (Array.isArray(tag) && (tag[0] === 'e' || tag[0] === 'a') && tag[1]) {
          const eventId = tag[1];
          setTimeout(() => updateVideoLikeButton(eventId), 50);
        }
      });
    }
    
    return result;
  };
}

// חלק יאללה וידאו (videos.js) – פתיחת פאנל תגובות בסגנון טיקטוק
function openCommentsPanel(eventId) {
  if (!eventId) return;
  
  const app = window.NostrApp;
  // לא דורשים שהפוסט יהיה ב-postsById, רק שיהיה eventId תקין
  // הפוסט יכול להיות רק בדף הווידאו ולא בפיד הראשי

  // יצירת overlay
  const overlay = document.createElement('div');
  overlay.className = 'videos-comments-overlay';
  overlay.innerHTML = `
    <div class="videos-comments-panel">
      <div class="videos-comments-header">
        <h3>תגובות</h3>
        <button class="videos-comments-close" aria-label="סגור">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="videos-comments-list" id="videoCommentsList"></div>
      <div class="videos-comments-input">
        <input type="text" placeholder="הוסף תגובה..." id="videoCommentInput" />
        <button id="videoCommentSend">
          <i class="fa-solid fa-paper-plane"></i>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // סגירה בלחיצה על overlay או כפתור סגירה
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.videos-comments-close')) {
      overlay.remove();
    }
  });

  // טעינת תגובות
  loadCommentsForPost(eventId);

  // שליחת תגובה
  const sendBtn = overlay.querySelector('#videoCommentSend');
  const input = overlay.querySelector('#videoCommentInput');
  
  // חלק תגובות (videos.js) – פרסום תגובה דרך postComment או publishPost כגיבוי | HYPER CORE TECH
  const sendComment = async () => {
    const text = input.value.trim();
    if (!text || !app) {
      return;
    }

    try {
      if (typeof app.postComment === 'function') {
        await app.postComment(eventId, text);
      } else if (typeof app.publishPost === 'function') {
        await app.publishPost({ content: text, replyTo: eventId });
      } else {
        return;
      }
      input.value = '';
      await loadCommentsForPost(eventId);
    } catch (err) {
      console.error('[videos] Failed to send comment:', err);
    }
  };

  sendBtn?.addEventListener('click', sendComment);
  input?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendComment();
  });
}

// חלק יאללה וידאו (videos.js) – פתיחת חלונית טקסט מלאה בסגנון טיקטוק
function openPostTextPanel({ authorName, authorPicture, content }) {
  const overlay = document.createElement('div');
  overlay.className = 'videos-comments-overlay';
  overlay.innerHTML = `
    <div class="videos-comments-panel">
      <div class="videos-comments-header">
        <h3>${authorName || 'פוסט'}</h3>
        <button class="videos-comments-close" aria-label="סגור">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="videos-comments-list" style="white-space: pre-wrap; line-height:1.5;">
        ${content ? escapeHtml(content) : ''}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.videos-comments-close')) {
      overlay.remove();
    }
  });
}

// חלק יאללה וידאו (videos.js) – פונקציית עזר לאסקפינג HTML בטוח
function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// חלק יאללה וידאו (videos.js) – טעינת תגובות לפוסט
async function loadCommentsForPost(eventId) {
  const app = window.NostrApp;
  const commentsList = document.getElementById('videoCommentsList');
  if (!commentsList) {
    return;
  }

  commentsList.innerHTML = '<div class="videos-comments-loading">טוען תגובות...</div>';

  const commentMap = app?.commentsByParent?.get(eventId);
  const comments = commentMap ? Array.from(commentMap.values()) : [];
  comments.sort((a, b) => (a?.created_at || 0) - (b?.created_at || 0));

  const commentButton = document.querySelector(`[data-comment-button][data-event-id="${eventId}"]`);
  const counterEl = commentButton?.querySelector('.videos-feed__action-count');

  if (!comments.length) {
    commentsList.innerHTML = '<div class="videos-comments-empty">אין תגובות עדיין</div>';
    if (counterEl) {
      counterEl.textContent = '';
      counterEl.style.display = 'none';
    }
    return;
  }

  const profiles = await Promise.all(
    comments.map(async (comment) => {
      const key = comment.pubkey?.toLowerCase?.() || comment.pubkey || '';
      if (app?.profileCache?.has(key)) {
        return app.profileCache.get(key);
      }
      if (typeof app?.fetchProfile === 'function') {
        try {
          return await app.fetchProfile(key);
        } catch (_) {
          return null;
        }
      }
      return null;
    })
  );

  const fragment = document.createDocumentFragment();

  comments.forEach((comment, index) => {
    const profile = profiles[index] || {};
    const authorKey = comment.pubkey?.toLowerCase?.() || '';
    const displayName = profile.name || (authorKey ? `משתמש ${authorKey.slice(0, 8)}` : 'משתמש');
    const initials = profile.initials || displayName.slice(0, 2).toUpperCase();
    const picture = profile.picture || '';
    const safeName = escapeHtml(displayName);
    const safeContent = escapeHtml(comment.content || '').replace(/\n/g, '<br>');

    const commentDiv = document.createElement('div');
    commentDiv.className = 'videos-comment-item';

    const avatarDiv = document.createElement('button');
    avatarDiv.type = 'button';
    avatarDiv.className = 'videos-comment-avatar';
    avatarDiv.setAttribute('aria-label', `פרופיל של ${displayName}`);
    if (picture) {
      avatarDiv.innerHTML = `<img src="${picture}" alt="${safeName}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
    } else {
      avatarDiv.textContent = initials;
    }
    avatarDiv.addEventListener('click', () => {
      if (authorKey && typeof window.openProfileByPubkey === 'function') {
        window.openProfileByPubkey(authorKey);
      }
    });

    const contentWrap = document.createElement('div');
    contentWrap.className = 'videos-comment-content';

    const nameButton = document.createElement('button');
    nameButton.type = 'button';
    nameButton.className = 'videos-comment-author';
    nameButton.innerHTML = safeName;
    nameButton.addEventListener('click', () => {
      if (authorKey && typeof window.openProfileByPubkey === 'function') {
        window.openProfileByPubkey(authorKey);
      }
    });

    const textDiv = document.createElement('div');
    textDiv.className = 'videos-comment-text';
    textDiv.innerHTML = safeContent;

    contentWrap.appendChild(nameButton);
    contentWrap.appendChild(textDiv);

    commentDiv.appendChild(avatarDiv);
    commentDiv.appendChild(contentWrap);

    fragment.appendChild(commentDiv);
  });

  commentsList.innerHTML = '';
  commentsList.appendChild(fragment);

  if (counterEl) {
    counterEl.textContent = String(comments.length);
    counterEl.style.display = '';
  }

  if (typeof app?.updateCommentsForParent === 'function') {
    try {
      app.updateCommentsForParent(eventId);
    } catch (err) {
      console.warn('[videos] failed syncing comment counter', err);
    }
  }
}

// חלק יאללה וידאו (videos.js) – חיבור כפתורי פעולה
function wireActions() {
  const root = selectors.stream;
  if (!root) return;

  root.querySelectorAll('[data-like-button]').forEach((button) => {
    if (button.dataset.listenerAttached === 'true') return;
    button.dataset.listenerAttached = 'true';
    button.addEventListener('click', async () => {
      const eventId = button.getAttribute('data-event-id');
      const app = window.NostrApp;
      if (eventId && app && typeof app.likePost === 'function') {
        await app.likePost(eventId);
        // עדכון מיידי של הכפתור
        setTimeout(() => updateVideoLikeButton(eventId), 100);
      }
    });
  });

  root.querySelectorAll('[data-comment-button]').forEach((button) => {
    if (button.dataset.listenerAttached === 'true') return;
    button.dataset.listenerAttached = 'true';
    button.addEventListener('click', () => {
      const eventId = button.getAttribute('data-event-id');
      if (eventId) {
        openCommentsPanel(eventId);
      }
    });
  });

  root.querySelectorAll('[data-share-button]').forEach((button) => {
    if (button.dataset.listenerAttached === 'true') return;
    button.dataset.listenerAttached = 'true';
    button.addEventListener('click', () => {
      const eventId = button.getAttribute('data-event-id');
      const app = window.NostrApp;
      if (eventId && app && typeof app.sharePost === 'function') {
        app.sharePost(eventId);
      }
    });
  });

  root.querySelectorAll('[data-follow-button]').forEach((button) => {
    if (button.dataset.listenerAttached === 'true') return;
    button.dataset.listenerAttached = 'true';
    button.addEventListener('click', async () => {
      const target = button.getAttribute('data-follow-button');
      if (!target) return;
      
      const app = window.NostrApp;
      if (!app) return;
      
      if (typeof app.followUser === 'function') {
        await app.followUser(target);
      } else if (typeof app.toggleFollow === 'function') {
        await app.toggleFollow(target);
      }
      
      if (typeof app.refreshFollowButtons === 'function') {
        // רענון מיידי של מצב כפתורי העוקב לאחר פעולה | HYPER CORE TECH
        app.refreshFollowButtons(selectors.stream);
      }
    });
  });
}

// חלק יאללה וידאו (videos.js) – הגדרת Intersection Observer לאפקט טשטוש
function setupIntersectionObserver() {
  const viewport = document.querySelector('.videos-feed__viewport');
  if (!viewport) return;

  if (intersectionObserver) {
    intersectionObserver.disconnect();
  }

  intersectionObserver = new IntersectionObserver(
    (entries) => {
      let bestEntry = null;
      entries.forEach((entry) => {
        if (!entry.target) return;
        if (!bestEntry || entry.intersectionRatio > (bestEntry?.intersectionRatio || 0)) {
          bestEntry = entry;
        }
      });

      entries.forEach((entry) => {
        const card = entry.target;
        const mediaDiv = card.querySelector('.videos-feed__media');
        if (!mediaDiv) return;
        if (entry === bestEntry && entry.isIntersecting && entry.intersectionRatio > 0.35) {
          card.classList.add('in-view');
          playMedia(mediaDiv, { manual: false });
          // הצגת כפתורים כשעוברים לפוסט חדש
          showControlsForCard(card);
        } else {
          card.classList.remove('in-view');
          pauseMedia(mediaDiv, { resetThumb: false });
        }
      });
    },
    {
      root: viewport,
      threshold: [0, 0.25, 0.5, 0.75, 1],
      rootMargin: '-15% 0px -15% 0px'
    }
  );

  const cards = document.querySelectorAll('.videos-feed__card');
  cards.forEach((card) => intersectionObserver.observe(card));

  return intersectionObserver;
}

// חלק יאללה וידאו (videos.js) – שאילת פוסטים מהרילאים (fallback ללא הפיד הראשי)
async function fetchRecentNotes(limit = 500) {
  const app = window.NostrApp;
  if (!app || !app.pool || !Array.isArray(app.relayUrls) || app.relayUrls.length === 0) {
    console.warn('[videos] fetchRecentNotes: pool/relays not ready');
    return [];
  }
  const since = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30; // 30 יום אחרונים
  const networkTag = getNetworkTag();
  const filters = [{ kinds: [1], limit, since, '#t': [networkTag] }];
  const filtersNoSince = [{ kinds: [1], limit, '#t': [networkTag] }];
  try {
    console.log('[videos] fetchRecentNotes: using list', { relays: app.relayUrls.length, limit, since });
    if (typeof app.pool.list === 'function') {
      const listed = await app.pool.list(app.relayUrls, filters);
      if (Array.isArray(listed) && listed.length > 0) {
        console.log('[videos] fetchRecentNotes: list returned', listed.length);
        return listed;
      }
      // ניסיון נוסף ללא since
      const listed2 = await app.pool.list(app.relayUrls, filtersNoSince);
      if (Array.isArray(listed2) && listed2.length > 0) {
        console.log('[videos] fetchRecentNotes: list (no since) returned', listed2.length);
        return listed2;
      }
    }
    if (typeof app.pool.listMany === 'function') {
      const listed = await app.pool.listMany(app.relayUrls, filters);
      if (Array.isArray(listed) && listed.length > 0) {
        console.log('[videos] fetchRecentNotes: listMany returned', listed.length);
        return listed;
      }
      const listed2 = await app.pool.listMany(app.relayUrls, filtersNoSince);
      if (Array.isArray(listed2) && listed2.length > 0) {
        console.log('[videos] fetchRecentNotes: listMany (no since) returned', listed2.length);
        return listed2;
      }
    }
    if (typeof app.pool.querySync === 'function') {
      console.log('[videos] fetchRecentNotes: trying querySync');
      const res = await app.pool.querySync(app.relayUrls, filters[0]);
      const events = Array.isArray(res) ? res : (Array.isArray(res?.events) ? res.events : []);
      if (events.length > 0) {
        console.log('[videos] fetchRecentNotes: querySync returned', events.length);
        return events;
      }
      const res2 = await app.pool.querySync(app.relayUrls, filtersNoSince[0]);
      const events2 = Array.isArray(res2) ? res2 : (Array.isArray(res2?.events) ? res2.events : []);
      if (events2.length > 0) {
        console.log('[videos] fetchRecentNotes: querySync (no since) returned', events2.length);
        return events2;
      }
    }
    // fallback: שימוש במנוי כדי למשוך אירועים חיים ומהירים
    if (typeof app.pool.sub === 'function' || typeof app.pool.subscribeMany === 'function') {
      console.log('[videos] fetchRecentNotes: fallback sub start');
      return await new Promise((resolve) => {
        const collected = [];
        const sub = typeof app.pool.sub === 'function'
          ? app.pool.sub(app.relayUrls, filtersNoSince)
          : app.pool.subscribeMany(app.relayUrls, filtersNoSince);
        const done = () => {
          try { sub.unsub(); } catch (_) {}
          const sorted = collected.sort((a,b) => (b.created_at||0)-(a.created_at||0));
          console.log('[videos] fetchRecentNotes: sub done', { count: sorted.length });
          resolve(sorted);
        };
        const timer = setTimeout(done, 3000);
        sub.on('event', (ev) => { collected.push(ev); });
        sub.on('eose', () => {
          clearTimeout(timer);
          done();
        });
      });
    }
  } catch (err) {
    console.warn('[videos] fetchRecentNotes failed', err);
  }
  return [];
}

// חלק יאללה וידאו (videos.js) – טעינת לייקים ותגובות לפוסטי וידאו
async function loadLikesAndCommentsForVideos(eventIds) {
  if (!Array.isArray(eventIds) || eventIds.length === 0) return;

  const app = window.NostrApp;
  if (!app || !app.pool || !Array.isArray(app.relayUrls) || app.relayUrls.length === 0) {
    console.warn('[videos] Cannot load likes/comments: pool not ready');
    return;
  }

  const since = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30; // 30 יום

  // טעינת לייקים (kind 7)
  const likesFilter = { kinds: [7], '#e': eventIds, since };
  // טעינת תגובות (kind 1 עם תג e)
  const commentsFilter = { kinds: [1], '#e': eventIds, since };

  try {
    let allEvents = [];

    if (typeof app.pool.list === 'function') {
      const results = await app.pool.list(app.relayUrls, [likesFilter, commentsFilter]);
      if (Array.isArray(results)) allEvents = results;
    } else if (typeof app.pool.querySync === 'function') {
      const likesRes = await app.pool.querySync(app.relayUrls, likesFilter);
      const commentsRes = await app.pool.querySync(app.relayUrls, commentsFilter);
      const likes = Array.isArray(likesRes) ? likesRes : (Array.isArray(likesRes?.events) ? likesRes.events : []);
      const comments = Array.isArray(commentsRes) ? commentsRes : (Array.isArray(commentsRes?.events) ? commentsRes.events : []);
      allEvents = [...likes, ...comments];
    }

    console.log('[videos] Loaded likes/comments:', { count: allEvents.length });

    // עיבוד לייקים ותגובות בהתאם ללוגיקת הפיד הראשי | HYPER CORE TECH
    allEvents.forEach((event) => {
      if (event.kind === 7 && typeof app.registerLike === 'function') {
        app.registerLike(event);
        return;
      }
      if (event.kind !== 1 || !Array.isArray(event.tags)) {
        return;
      }
      const parentTag = event.tags.find((tag) => Array.isArray(tag) && tag[0] === 'e' && tag[1]);
      if (!parentTag) {
        return;
      }
      const parentId = parentTag[1];
      registerVideoCommentRecord(app, event, parentId);
    });
  } catch (err) {
    console.warn('[videos] Failed to load likes/comments:', err);
  }
}

// חלק יאללה וידאו (videos.js) – רישום אירועים למפות המשותפות כדי לאפשר התרעות מלאות | HYPER CORE TECH
function registerVideoSourceEvent(event) {
  if (!event || !event.id) return;
  const app = window.NostrApp;
  if (!app) return;

  if (!(app.eventAuthorById instanceof Map)) {
    app.eventAuthorById = new Map();
  }
  if (!(app.postsById instanceof Map)) {
    app.postsById = new Map();
  }

  const normalizedPubkey = typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : '';
  if (normalizedPubkey) {
    app.eventAuthorById.set(event.id, normalizedPubkey);
  }
  app.postsById.set(event.id, event);

  if (typeof app.processPendingNotifications === 'function') {
    try {
      app.processPendingNotifications(event.id);
    } catch (err) {
      console.warn('[videos] processPendingNotifications failed', err);
    }
  }
}

// חלק יאללה וידאו (videos.js) – רישום לייקים/תגובות להשלמת ספירות UI | HYPER CORE TECH
function registerVideoEngagementEvent(event) {
  if (!event || !event.kind) return;
  const app = window.NostrApp;
  if (!app) return;

  if (event.kind === 7 && typeof app.registerLike === 'function') {
    app.registerLike(event);
    return;
  }

  if (event.kind !== 1) {
    return;
  }

  const parentTag = Array.isArray(event.tags) ? event.tags.find((tag) => Array.isArray(tag) && tag[0] === 'e' && tag[1]) : null;
  if (!parentTag) {
    return;
  }

  registerVideoCommentRecord(app, event, parentTag[1]);
}

// חלק יאללה וידאו (videos.js) – רישום תגובה למבני הנתונים המשותפים והפעלת ההתרעות | HYPER CORE TECH
function registerVideoCommentRecord(app, event, parentId) {
  if (!app || !event || !parentId) {
    return;
  }

  if (typeof app.registerComment === 'function') {
    try {
      app.registerComment(event, parentId);
      return;
    } catch (err) {
      console.warn('[videos] app.registerComment failed, falling back to local handler', err);
    }
  }

  if (!(app.commentsByParent instanceof Map)) {
    app.commentsByParent = new Map();
  }

  if (!app.commentsByParent.has(parentId)) {
    app.commentsByParent.set(parentId, new Map());
  } else if (Array.isArray(app.commentsByParent.get(parentId))) {
    const legacyList = app.commentsByParent.get(parentId);
    const normalizedMap = new Map();
    legacyList.forEach((legacyEvent) => {
      if (legacyEvent?.id) {
        normalizedMap.set(legacyEvent.id, legacyEvent);
      }
    });
    app.commentsByParent.set(parentId, normalizedMap);
  }

  const commentMap = app.commentsByParent.get(parentId);
  if (!(commentMap instanceof Map)) {
    return;
  }

  if (event.id) {
    commentMap.set(event.id, event);
  }

  if (!(app.eventAuthorById instanceof Map)) {
    app.eventAuthorById = new Map();
  }
  if (event?.id && typeof event?.pubkey === 'string') {
    app.eventAuthorById.set(event.id, event.pubkey.toLowerCase());
  }

  if (typeof app.updateCommentsForParent === 'function') {
    try {
      app.updateCommentsForParent(parentId);
    } catch (err) {
      console.warn('[videos] updateCommentsForParent failed', err);
    }
  }

  if (typeof app.handleNotificationForComment === 'function') {
    try {
      app.handleNotificationForComment(event, parentId);
    } catch (err) {
      console.warn('[videos] handleNotificationForComment failed', err);
    }
  }
}

// חלק יאללה וידאו (videos.js) – טעינת סרטונים מהפיד
async function loadVideos() {
  setStatus('טוען סרטונים...');

  const currentApp = window.NostrApp;
  let sourceEvents = [];
  const networkTag = getNetworkTag();

  if (currentApp && currentApp.postsById && currentApp.postsById.size > 0) {
    const fromApp = Array.from(currentApp.postsById.values());
    sourceEvents = filterEventsByNetwork(fromApp, networkTag);
    console.log('[videos] loadVideos: postsById', { total: fromApp.length, afterFilter: sourceEvents.length });
  } else {
    // Fallback: משיכת אירועים ישירות מהרילאים
    const fetched = await fetchRecentNotes(300);
    sourceEvents = filterEventsByNetwork(fetched, networkTag);
    console.log('[videos] loadVideos: relays fallback', { fetched: fetched.length || 0, afterFilter: sourceEvents.length });
  }

  // העשרת המקור עם רשת המשתמש
  const authors = [];
  if (currentApp?.followingSet && currentApp.followingSet.size) authors.push(...Array.from(currentApp.followingSet));
  if (currentApp?.publicKey) authors.push(currentApp.publicKey);
  if (authors.length) {
    const netNotes = await fetchNetworkNotes(authors.slice(0, 500));
    if (Array.isArray(netNotes) && netNotes.length) {
      const filteredNet = filterEventsByNetwork(netNotes, networkTag);
      console.log('[videos] loadVideos: network authors', { fetched: netNotes.length, afterFilter: filteredNet.length });
      sourceEvents = sourceEvents.concat(filteredNet);
    } else {
      console.log('[videos] loadVideos: network authors', { fetched: netNotes.length || 0, afterFilter: 0 });
    }
  }

  // הסרת כפילויות לפי id
  if (Array.isArray(sourceEvents) && sourceEvents.length) {
    const seen = new Set();
    sourceEvents = sourceEvents.filter(ev => { if (!ev || !ev.id) return false; if (seen.has(ev.id)) return false; seen.add(ev.id); return true; });
  }

  if (!Array.isArray(sourceEvents) || sourceEvents.length === 0) {
    setStatus('ממתין לטעינת פוסטים...');
    console.warn('[videos] loadVideos: no events after both sources');
    setTimeout(loadVideos, 1000);
    return;
  }

  const videoEvents = [];
  sourceEvents.forEach((event) => {
    if (!event || event.kind !== 1) return;
    if (currentApp?.deletedEventIds?.has(event.id)) return;

    const lines = String(event.content || '').split('\n');
    const mediaLinks = [];
    const textLines = [];

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('http') || trimmed.startsWith('data:')) {
        mediaLinks.push(trimmed);
      } else {
        textLines.push(trimmed);
      }
    });

    const youtubeId = mediaLinks.map(parseYouTube).find(Boolean);
    const videoUrl = mediaLinks.find(isVideoLink);
    const hasVideo = youtubeId || videoUrl;

    if (hasVideo) {
      registerVideoSourceEvent(event);
      videoEvents.push({
        id: event.id,
        pubkey: event.pubkey,
        content: textLines.join(' '),
        youtubeId: youtubeId || null,
        videoUrl: videoUrl || null,
        createdAt: event.created_at || 0,
      });
    }
  });

  // משיכת פרופילים לכל המחברים
  const uniqueAuthors = [...new Set(videoEvents.map(v => v.pubkey))];
  if (uniqueAuthors.length > 0 && typeof currentApp?.fetchProfile === 'function') {
    await Promise.all(uniqueAuthors.map(pubkey => currentApp.fetchProfile(pubkey)));
  }

  // טעינת לייקים ותגובות לכל הפוסטים
  await loadLikesAndCommentsForVideos(videoEvents.map(v => v.id));

  // רישום נתוני מעורבות למפות המטא | HYPER CORE TECH
  if (Array.isArray(sourceEvents)) {
    sourceEvents.forEach(registerVideoEngagementEvent);
  }

  // התחלת מנוי חי כדי לקבל התרעות חדשות בזמן אמת
  setupVideoRealtimeSubscription(videoEvents.map(v => v.id));

  // עדכון נתוני המחברים
  videoEvents.forEach((video) => {
    const profileData = currentApp?.profileCache?.get(video.pubkey) || {};
    video.authorName = profileData.name || `משתמש ${String(video.pubkey || '').slice(0, 8)}`;
    video.authorPicture = profileData.picture || '';
    video.authorInitials = profileData.initials || 'AN';
  });

  videoEvents.sort((a, b) => b.createdAt - a.createdAt);
  console.log('[videos] loadVideos: video events found', { count: videoEvents.length });
  state.videos = videoEvents;
  renderVideos();
}

// חלק יאללה וידאו (videos.js) – מנוי נתונים חי לפיד הווידאו לצורך לייקים/תגובות/התראות | HYPER CORE TECH
let videoRealtimeSub = null;
function setupVideoRealtimeSubscription(eventIds = []) {
  const app = window.NostrApp;
  if (!app || !app.pool || typeof app.pool.subscribeMany !== 'function') {
    return;
  }
  if (videoRealtimeSub) {
    try { videoRealtimeSub.close(); } catch (_) {}
    videoRealtimeSub = null;
  }
  const viewerKey = typeof app.publicKey === 'string' ? app.publicKey : '';
  const filters = buildVideoFeedFilters();
  if (Array.isArray(eventIds) && eventIds.length > 0) {
    filters.push({ kinds: [1], '#e': eventIds, limit: 200 });
    filters.push({ kinds: [7], '#e': eventIds, limit: 200 });
  }

  videoRealtimeSub = app.pool.subscribeMany(app.relayUrls, filters, {
    onevent: (event) => {
      if (!event || !event.kind) return;
      if (event.kind === 1) {
        registerVideoSourceEvent(event);
        registerVideoEngagementEvent(event);
      } else if (event.kind === 7) {
        registerVideoEngagementEvent(event);
      } else if (event.kind === (app.FOLLOW_KIND || 40010)) {
        if (typeof app.handleNotificationForFollow === 'function') {
          app.handleNotificationForFollow(event);
        }
      } else if (event.kind === (app.DATING_LIKE_KIND || 9000)) {
        if (typeof app.handleNotificationForDatingLike === 'function') {
          app.handleNotificationForDatingLike(event);
        }
      }
    },
    oneose: () => {
      if (typeof app.refreshFollowButtons === 'function') {
        app.refreshFollowButtons(selectors.stream || document);
      }
    }
  });
}

// חלק יאללה וידאו (videos.js) – אתחול בעת טעינת הדף
async function init() {
  selectors.stream = document.getElementById('videosStream');
  selectors.status = document.getElementById('videosStatus');

  if (!selectors.stream || !selectors.status) {
    return;
  }

  const homeButton = document.getElementById('videosTopHomeButton');
  if (homeButton) {
    homeButton.addEventListener('click', () => {
      window.location.href = './index.html';
    });
  }

  const refreshButton = document.getElementById('videosTopRefreshButton');
  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      setStatus('מרענן...');
      loadVideos();
    });
  }

  await waitForApp();
  const app = window.NostrApp || {};
  if (typeof app.buildCoreFeedFilters !== 'function') {
    app.buildCoreFeedFilters = buildVideoFeedFilters;
  }
  loadVideos();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
