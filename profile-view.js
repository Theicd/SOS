  function bindHeaderShortcuts() {
    const homeButton = document.querySelector('[data-profile-tab="home"]');
    if (homeButton) {
      homeButton.addEventListener('click', () => {
        window.location.href = './index.html';
      });
    }
    const profileButton = document.querySelector('[data-profile-tab="profile"]');
    if (profileButton) {
      profileButton.addEventListener('click', () => {
        window.location.href = './profile.html';
      });
    }
  }

(function initProfilePage(window) {
  // חלק דף פרופיל (profile-view.js) – אתחול אובייקטי הבסיס והכלים הדרושים
  const App = window.NostrApp || (window.NostrApp = {});
  const tools = window.NostrTools || {};
  const getPublicKey = tools.getPublicKey || App.getPublicKey;

  // חלק אספקת רפרנסים (profile-view.js) – אוסף את כל האלמנטים המרכזיים לעבודה
  const refs = {
    connectionStatus: document.getElementById('connection-status'),
    avatar: document.getElementById('profilePageAvatar'),
    name: document.getElementById('profilePageName'),
    bio: document.getElementById('profilePageBio'),
    sidebarBio: document.getElementById('profileSidebarBio'),
    aboutHeadlineRow: document.getElementById('profileAboutHeadlineRow'),
    aboutHeadline: document.getElementById('profileAboutHeadline'),
    aboutRoleRow: document.getElementById('profileAboutRoleRow'),
    aboutRole: document.getElementById('profileAboutRole'),
    aboutCompany: document.getElementById('profileAboutCompany'),
    aboutLocationRow: document.getElementById('profileAboutLocationRow'),
    aboutLocation: document.getElementById('profileAboutLocation'),
    aboutWebsiteRow: document.getElementById('profileAboutWebsiteRow'),
    aboutWebsite: document.getElementById('profileAboutWebsite'),
    statsPosts: document.getElementById('profileStatsPosts'),
    statsPostsChange: document.getElementById('profileStatsPostsChange'),
    statsPostsNote: document.getElementById('profileStatsPostsNote'),
    statsLikes: document.getElementById('profileStatsLikes'),
    statsLikesChange: document.getElementById('profileStatsLikesChange'),
    statsLikesNote: document.getElementById('profileStatsLikesNote'),
    statsComments: document.getElementById('profileStatsComments'),
    statsCommentsChange: document.getElementById('profileStatsCommentsChange'),
    statsCommentsNote: document.getElementById('profileStatsCommentsNote'),
    statsReplies: document.getElementById('profileStatsReplies'),
    statsRepliesChange: document.getElementById('profileStatsRepliesChange'),
    statsRepliesNote: document.getElementById('profileStatsRepliesNote'),
    activityChart: document.getElementById('profileActivityChart'),
    activityEmpty: document.getElementById('profileActivityEmpty'),
    activityPeriodButtons: document.querySelectorAll('[data-activity-period]'),
    timelineStatus: document.getElementById('profileTimelineStatus'),
    timelineList: document.getElementById('profileTimeline'),
    timelineComments: document.getElementById('profileTimelineComments'),
    followersCard: document.getElementById('profileFollowersCard'),
    followersCount: document.getElementById('profileFollowersCountLabel'),
    followersSummaryCount: document.getElementById('profileFollowersCount'),
    followingCount: document.getElementById('profileFollowingCount'),
    likesCount: document.getElementById('profileLikesCount'),
    followersList: document.getElementById('profileFollowersList'),
    followersStatus: document.getElementById('profileFollowersStatus'),
    repliesCard: document.getElementById('profileRepliesCard'),
    repliesToggle: document.getElementById('profileRepliesToggle'),
    repliesCountLabel: document.getElementById('profileRepliesCountLabel'),
    topProfileButton: document.getElementById('profileTopAvatarButton'),
    topProfileMenu: document.getElementById('profileTopMenu'),
    topProfileWrapper: document.getElementById('profileTopProfile'),
    topMenuItems: document.querySelectorAll('[data-profile-action]'),
  };

  const followState = {
    snapshot: [],
    unsubscribe: null,
    profilePromises: new Map(),
  };

  function hideConnectionToast() {
    if (refs.connectionStatus) {
      refs.connectionStatus.hidden = true;
    }
  }

  // חלק אתחול ליבה (profile-view.js) – דואג שמפתחות ופרופיל יהיו זמינים לפני טעינה
  function ensureBootstrap() {
    if (typeof App.ensureKeys === 'function') {
      App.ensureKeys();
    }
    if (!App.privateKey) {
      App.privateKey = window.localStorage.getItem('nostr_private_key') || '';
    }
    if (!App.publicKey && App.privateKey && typeof getPublicKey === 'function') {
      try {
        App.publicKey = getPublicKey(App.privateKey);
      } catch (err) {
        console.warn('Failed deriving public key inside profile page', err);
      }
    }
    if (!App.profile) {
      App.profile = {
        name: 'משתמש אנונימי',
        bio: 'יצירת תוכן מבוזר, בלי שוטר באמצע',
        avatarInitials: 'AN',
        picture: '',
      };
    }
    if (!App.getInitials) {
      App.getInitials = (value = '') => value.trim().slice(0, 2).toUpperCase() || 'AN';
    }
    App.profile.avatarInitials = App.getInitials(App.profile.name || '');
    if (!App.profileCache) {
      App.profileCache = new Map();
    }
    App.profileCache.set(App.publicKey || 'self', {
      name: App.profile.name,
      bio: App.profile.bio,
      picture: App.profile.picture,
      initials: App.profile.avatarInitials,
    });
    if (!Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      App.relayUrls = [
        'wss://relay.damus.io',
        'wss://relay.snort.social',
        'wss://nos.lol',
      ];
    }
    if (!App.pool && typeof tools.SimplePool === 'function') {
      App.pool = new tools.SimplePool();
    }
    if (refs.connectionStatus && App.pool) {
      refs.connectionStatus.hidden = false;
      refs.connectionStatus.textContent = 'מתחבר לריליים...';
    }
  }

  // חלק תפריט פרופיל עליון (profile-view.js) – משחזר את התנהגות התפריט מהדף הראשי
  function syncTopAvatar() {
    const target = document.getElementById('profileTopAvatar');
    if (!target) {
      return;
    }
    target.innerHTML = '';
    const initials = App.profile?.avatarInitials || (typeof App.getInitials === 'function' ? App.getInitials(App.profile?.name || '') : 'AN');
    if (App.profile?.picture) {
      const img = document.createElement('img');
      img.src = App.profile.picture;
      img.alt = App.profile.name || 'הפרופיל שלי';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onerror = function onerr() {
        try { this.remove(); } catch (e) {}
        target.textContent = initials;
      };
      target.appendChild(img);
    } else {
      target.textContent = initials;
    }
  }

  function openTopMenu() {
    if (refs.topProfileMenu && refs.topProfileButton) {
      refs.topProfileMenu.hidden = false;
      refs.topProfileButton.setAttribute('aria-expanded', 'true');
    }
  }

  function closeTopMenu() {
    if (refs.topProfileMenu && refs.topProfileButton) {
      refs.topProfileMenu.hidden = true;
      refs.topProfileButton.setAttribute('aria-expanded', 'false');
    }
  }

  function handleTopMenuAction(action) {
    switch (action) {
      case 'view-profile':
        closeTopMenu();
        window.location.href = './profile.html';
        break;
      case 'logout':
        closeTopMenu();
        if (typeof window.logoutAndSwitchUser === 'function') {
          window.logoutAndSwitchUser();
        }
        break;
      default:
        break;
    }
  }

  function bindTopMenu() {
    if (!refs.topProfileWrapper || !refs.topProfileButton) {
      return;
    }

    const toggleMenu = (event) => {
      try {
        event.stopPropagation();
      } catch (err) {
        console.debug('toggleMenu event suppressed', err);
      }
      if (!refs.topProfileMenu) {
        return;
      }
      if (refs.topProfileMenu.hidden) {
        openTopMenu();
      } else {
        closeTopMenu();
      }
    };

    refs.topProfileButton.addEventListener('click', toggleMenu);
    window.addEventListener('click', (event) => {
      if (!refs.topProfileWrapper?.contains(event.target)) {
        closeTopMenu();
      }
    });

    refs.topMenuItems?.forEach((item) => {
      item.addEventListener('click', () => {
        handleTopMenuAction(item.getAttribute('data-profile-action'));
      });
    });

    syncTopAvatar();
  }

  // חלק יצירת מפתחות הצגה (profile-view.js) – אחראי לפורמט ידידותי למפתח הציבורי
  function getDisplayPublicKey() {
    if (!App.publicKey) {
      return 'מפתח ציבורי לא זמין';
    }
    if (typeof App.encodePublicKey === 'function') {
      return App.encodePublicKey(App.publicKey) || App.publicKey;
    }
    return App.publicKey;
  }

  // חלק ציור אווטר (profile-view.js) – מציג תמונה או ראשי תיבות של המשתמש
  function renderAvatar(target, profile) {
    if (!target) return;
    target.innerHTML = '';
    const initials = profile.avatarInitials || (typeof App.getInitials === 'function' ? App.getInitials(profile.name || '') : 'AN');
    if (profile.picture) {
      const img = document.createElement('img');
      img.src = profile.picture;
      img.alt = profile.name || 'משתמש';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onerror = function onerr() {
        try { this.remove(); } catch (e) {}
        target.textContent = initials;
      };
      target.appendChild(img);
      return;
    }
    target.textContent = initials;
  }

  // חלק סנכרון נתונים (profile-view.js) – מעדכן את פרטי המשתמש בכל האזורים בדף
  function syncProfileToPage() {
    const profile = App.profile || {};
    renderAvatar(refs.avatar, profile);
    if (refs.name) refs.name.textContent = profile.name || 'משתמש אנונימי';
    if (refs.bio) refs.bio.textContent = profile.bio || 'יצירת תוכן מבוזר, בלי שוטר באמצע';
    if (refs.sidebarBio) refs.sidebarBio.textContent = profile.bio || 'לא הוגדר עדיין תיאור קצר.';
    if (refs.aboutHeadlineRow) {
      const value = typeof profile.headline === 'string' ? profile.headline.trim() : '';
      refs.aboutHeadlineRow.hidden = !value;
      if (refs.aboutHeadline) {
        refs.aboutHeadline.textContent = value || '';
      }
    }
    const roleValue = typeof profile.role === 'string' ? profile.role.trim() : '';
    const companyValue = typeof profile.company === 'string' ? profile.company.trim() : '';
    if (refs.aboutRoleRow) {
      refs.aboutRoleRow.hidden = !(roleValue || companyValue);
      if (!refs.aboutRoleRow.hidden) {
        if (refs.aboutRole) {
          refs.aboutRole.textContent = roleValue || 'תפקיד';
        }
        if (refs.aboutCompany) {
          refs.aboutCompany.textContent = companyValue ? `ב${companyValue}` : '';
        }
      }
    }
    const locationValue = typeof profile.location === 'string' ? profile.location.trim() : '';
    if (refs.aboutLocationRow) {
      refs.aboutLocationRow.hidden = !locationValue;
      if (refs.aboutLocation) {
        refs.aboutLocation.textContent = locationValue || '';
      }
    }
    const websiteValue = typeof profile.website === 'string' ? profile.website.trim() : '';
    if (refs.aboutWebsiteRow) {
      refs.aboutWebsiteRow.hidden = !websiteValue;
      if (!refs.aboutWebsiteRow.hidden && refs.aboutWebsite) {
        refs.aboutWebsite.href = websiteValue;
        refs.aboutWebsite.textContent = websiteValue.replace(/^https?:\/\//i, '');
      }
    }
    if (refs.statsRelays) refs.statsRelays.textContent = Array.isArray(App.relayUrls) ? App.relayUrls.length.toString() : '0';
    renderFollowersSummary();
    renderFollowersList();
  }

  // חלק עוקבים (profile-view.js) – מציג את כמות העוקבים בפרופיל האישי וגם נעקבים ולייקים
  function renderFollowersSummary() {
    const count = Array.isArray(followState.snapshot) ? followState.snapshot.length : 0;
    if (refs.followersCount) {
      refs.followersCount.textContent = count.toString();
    }
    if (refs.followersSummaryCount) {
      refs.followersSummaryCount.textContent = count.toString();
    }
  }

  // חלק עוקבים (profile-view.js) – מציג את רשימת העוקבים בתוך הכרטיס הצדדי
  function renderFollowersList() {
    const coverList = document.getElementById('profileCoverFollowers');
    const localFollowers = Array.isArray(App.followers) ? App.followers : [];
    if (!refs.followersList && !coverList && !localFollowers.length) {
      return;
    }
    const networkFollowers = Array.isArray(followState.snapshot) ? followState.snapshot.slice(0, 20) : [];
    const mergedFollowers = networkFollowers.length > 0 ? networkFollowers : localFollowers.slice(0, 20);
    if (refs.followersList) {
      refs.followersList.innerHTML = '';
    }
    if (coverList) {
      coverList.innerHTML = '';
    }
    if (mergedFollowers.length === 0) {
      if (refs.followersList) {
        const empty = document.createElement('li');
        empty.className = 'profile-followers__empty';
        empty.textContent = 'עוד אין עוקבים להצגה.';
        refs.followersList.appendChild(empty);
      }
      return;
    }
    const escapeHtml = typeof App.escapeHtml === 'function' ? App.escapeHtml : (value) => value;
    let coverRendered = 0;
    mergedFollowers.forEach((entry) => {
      const pubkey = entry.pubkey || entry.npub || entry.id || '';
      const cached = App.profileCache instanceof Map ? App.profileCache.get(pubkey) : null;
      const fallbackName = pubkey ? `משתמש ${pubkey.slice(0, 8)}` : 'משתמש אנונימי';
      const name = entry.name || entry.metadata?.name || cached?.name || fallbackName;
      const picture = entry.picture || entry.metadata?.picture || cached?.picture || '';
      const initialsSource = entry.initials || cached?.initials || (typeof App.getInitials === 'function' ? App.getInitials(name) : pubkey.slice(0, 2));
      const initials = initialsSource ? initialsSource.toString().slice(0, 2).toUpperCase() : 'AN';
      const safeName = escapeHtml(name);
      const safePicture = picture ? escapeHtml(picture) : '';
      const safeInitials = escapeHtml(initials);
      const li = document.createElement('li');
      li.className = 'profile-followers__item';
      const attrName = safeName.replace(/"/g, '&quot;');
      const attrPicture = safePicture.replace(/"/g, '&quot;');
      if (refs.followersList) {
        li.innerHTML = `
          <button class="profile-followers__avatar" type="button" data-profile-link="${pubkey}" data-profile-name="${attrName}" data-profile-picture="${attrPicture}">
            ${safePicture ? `<img src="${safePicture}" alt="${safeName}">` : `<span>${safeInitials}</span>`}
          </button>
          <span class="profile-followers__name">${safeName}</span>
        `;
        refs.followersList.appendChild(li);
      }

      if (coverList && coverRendered < 5) {
        const coverItem = document.createElement('li');
        coverItem.className = 'profile-cover__followers-item';
        coverItem.innerHTML = `
          <button class="profile-cover__followers-avatar" type="button" data-profile-link="${pubkey}" data-profile-name="${attrName}" data-profile-picture="${attrPicture}">
            ${safePicture ? `<img src="${safePicture}" alt="${safeName}" loading="lazy" decoding="async">` : `<span>${safeInitials}</span>`}
          </button>
        `;
        coverList.appendChild(coverItem);
        coverRendered += 1;
      }
    });
  }

  // חלק עוקבים (profile-view.js) – מוודא שמטא-דאטה של עוקבים נטען למטמון לימוש אחיד בין מסכים
  async function ensureFollowerProfiles(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }
    if (typeof App.fetchProfile !== 'function') {
      return;
    }
    if (!(App.profileCache instanceof Map)) {
      App.profileCache = new Map();
    }
    const jobs = [];
    entries.forEach((entry) => {
      const pubkey = typeof entry.pubkey === 'string' ? entry.pubkey.toLowerCase() : '';
      if (!pubkey) {
        return;
      }
      if (App.profileCache.has(pubkey) && (App.profileCache.get(pubkey)?.name || App.profileCache.get(pubkey)?.picture)) {
        return;
      }
      if (followState.profilePromises.has(pubkey)) {
        jobs.push(followState.profilePromises.get(pubkey));
        return;
      }
      const job = (async () => {
        try {
          const profile = await App.fetchProfile(pubkey);
          if (profile) {
            App.profileCache.set(pubkey, profile);
          }
        } catch (err) {
          console.warn('Profile view: failed fetching follower metadata', err);
        } finally {
          followState.profilePromises.delete(pubkey);
        }
      })();
      followState.profilePromises.set(pubkey, job);
      jobs.push(job);
    });
    if (jobs.length) {
      await Promise.allSettled(jobs);
    }
  }

  // חלק עוקבים (profile-view.js) – נרשם לעוקבים של המשתמש ומעדכן את הסיכום העליון
  function subscribeFollowers() {
    if (!App.publicKey || typeof App.subscribeFollowers !== 'function') {
      renderFollowersSummary();
      renderFollowersList();
      return;
    }
    if (typeof followState.unsubscribe === 'function') {
      followState.unsubscribe();
    }
    followState.unsubscribe = App.subscribeFollowers(App.publicKey, (entries) => {
      followState.snapshot = Array.isArray(entries) ? entries : [];
      renderFollowersSummary();
      renderFollowersList();
      ensureFollowerProfiles(followState.snapshot)
        .then(() => {
          // רינדור חוזר לאחר העשרת המטא-דאטה כדי למשוך name/picture מהמטמון
          renderFollowersList();
        })
        .catch((err) => {
          console.warn('Profile view: follower enrichment failed', err);
        });
    });
  }

  // חלק חיבור לדפדפן הקיים (profile-view.js) – עוטף את renderProfile הקודם ומעדכן דף זה
  function attachRenderHook() {
    const originalRender = App.renderProfile;
    App.renderProfile = function renderProfileWrapper() {
      if (typeof originalRender === 'function') {
        originalRender();
      }
      syncProfileToPage();
      syncTopAvatar();
    };
  }

  // חלק תצוגת זמנים (profile-view.js) – ממיר חותמות זמן לפורמט עברי קריא
  function formatTimestamp(seconds) {
    if (!seconds) {
      return 'לא ידוע';
    }
    try {
      const date = new Date(seconds * 1000);
      return date.toLocaleString('he-IL', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (err) {
      console.warn('Failed to format timestamp', err);
      return 'לא ידוע';
    }
  }

  // חלק בניית פריטי טיימליין (profile-view.js) – מחזיר אלמנט תצוגה לכל פוסט
  function buildTimelineItem(event) {
    const safeContent = typeof App.escapeHtml === 'function'
      ? App.escapeHtml(event.content || '')
      : (event.content || '');
    const createdLabel = formatTimestamp(event.created_at);
    const relayLabel = Array.isArray(event.seenOn) && event.seenOn.length > 0
      ? event.seenOn[0]
      : 'Relay';
    const li = document.createElement('li');
    li.className = 'profile-timeline__item';
    li.innerHTML = `
      <div class="profile-timeline__meta">
        <span>${createdLabel}</span>
        <span>${relayLabel}</span>
      </div>
      <div class="profile-timeline__content">${safeContent || 'תוכן ריק'}</div>
    `;
    return li;
  }

  // חלק רנדר טיימליין (profile-view.js) – מציב את הפוסטים ואת התגובות המצטברות
  function renderTimeline(posts, replies) {
    // הסרת סקלטונים קיימים
    if (refs.timelineList) {
      const skeletons = refs.timelineList.querySelectorAll('.profile-skeleton');
      skeletons.forEach(s => s.remove());
    }
    
    if (typeof App.renderProfilePosts === 'function') {
      const safePosts = Array.isArray(posts) ? posts : [];
      const safeReplies = Array.isArray(replies) ? replies : [];
      
      // אם אין פוסטים, מציג סקלטונים
      if (safePosts.length === 0 && refs.timelineList) {
        for (let i = 0; i < 6; i++) {
          const skeleton = document.createElement('li');
          skeleton.className = 'profile-skeleton';
          skeleton.style.aspectRatio = '9/16';
          refs.timelineList.appendChild(skeleton);
        }
      } else {
        App.renderProfilePosts(safePosts, 'profileTimeline');
      }
      
      App.renderProfilePosts(safeReplies, 'profileTimelineComments');
      if (typeof App.updateLikeIndicator === 'function') {
        safePosts.forEach((event) => {
          if (event?.id) {
            App.updateLikeIndicator(event.id);
          }
        });
      }
    } else if (refs.timelineList) {
      refs.timelineList.innerHTML = '';
      if (Array.isArray(posts) && posts.length) {
        posts.forEach((event) => refs.timelineList.appendChild(buildTimelineItem(event)));
      } else {
        // סקלטונים במקום הודעה ריקה
        for (let i = 0; i < 6; i++) {
          const skeleton = document.createElement('li');
          skeleton.className = 'profile-skeleton';
          skeleton.style.aspectRatio = '9/16';
          refs.timelineList.appendChild(skeleton);
        }
      }
      if (refs.timelineComments) {
        refs.timelineComments.innerHTML = '';
        if (Array.isArray(replies) && replies.length) {
          replies.forEach((event) => refs.timelineComments.appendChild(buildTimelineItem(event)));
        } else {
          const emptyReply = document.createElement('li');
          emptyReply.className = 'profile-timeline__item';
          emptyReply.textContent = 'עוד לא הגבנו לפוסטים אחרים.';
          refs.timelineComments.appendChild(emptyReply);
        }
      }
    }
    if (refs.repliesCountLabel) {
      const count = Array.isArray(replies) ? replies.length : 0;
      refs.repliesCountLabel.textContent = `${count} תגובות`;
    }
    updateActivityStats(posts, replies);
  }

  function bindRepliesToggle() {
    if (!refs.repliesToggle || !refs.timelineComments) {
      return;
    }
    const applyState = (expanded) => {
      refs.timelineComments.hidden = !expanded;
      refs.repliesToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      refs.repliesToggle.textContent = expanded ? 'הסתר' : 'הצג';
    };
    applyState(false);
    refs.repliesToggle.addEventListener('click', () => {
      const expanded = refs.repliesToggle.getAttribute('aria-expanded') === 'true';
      applyState(!expanded);
    });
  }

  function formatNumber(value) {
    const number = Number(value) || 0;
    if (number >= 1000) {
      return `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}K`;
    }
    if (number >= 100) {
      return number.toFixed(0);
    }
    if (number >= 10) {
      return number.toFixed(1);
    }
    return number.toFixed(2).replace(/\.0+$/, '').replace(/0+$/, '');
  }

  function applyChangeIndicator(element, value) {
    if (!element) {
      return;
    }
    const normalized = Number.isFinite(value) ? value : 0;
    element.textContent = `${normalized > 0 ? '+' : ''}${normalized.toFixed(0)}%`;
    element.classList.remove('is-up', 'is-down', 'is-neutral');
    if (normalized > 0.5) {
      element.classList.add('is-up');
    } else if (normalized < -0.5) {
      element.classList.add('is-down');
    } else {
      element.classList.add('is-neutral');
    }
  }

  function buildPeriodStats(posts, replies, likeEvents, commentEvents, start, end, startPrev, endPrev) {
    const postsInRange = posts.filter((event) => typeof event?.created_at === 'number' && event.created_at >= start && event.created_at <= end);
    const postsPrev = posts.filter((event) => typeof event?.created_at === 'number' && event.created_at >= startPrev && event.created_at <= endPrev);
    const repliesInRange = replies.filter((event) => typeof event?.created_at === 'number' && event.created_at >= start && event.created_at <= end);
    const repliesPrev = replies.filter((event) => typeof event?.created_at === 'number' && event.created_at >= startPrev && event.created_at <= endPrev);

    const likesInRange = likeEvents.filter((event) => typeof event?.created_at === 'number' && event.created_at >= start && event.created_at <= end);
    const likesPrev = likeEvents.filter((event) => typeof event?.created_at === 'number' && event.created_at >= startPrev && event.created_at <= endPrev);

    const commentsInRange = commentEvents.filter((event) => typeof event?.created_at === 'number' && event.created_at >= start && event.created_at <= end);
    const commentsPrev = commentEvents.filter((event) => typeof event?.created_at === 'number' && event.created_at >= startPrev && event.created_at <= endPrev);

    return {
      posts: { current: postsInRange.length, previous: postsPrev.length },
      replies: { current: repliesInRange.length, previous: repliesPrev.length },
      likes: { current: likesInRange.length, previous: likesPrev.length },
      comments: { current: commentsInRange.length, previous: commentsPrev.length },
      start,
      end,
      startPrev,
      endPrev,
    };
  }

  function renderSummary(stats) {
    const { posts, likes, comments, replies, start, end, startPrev, endPrev } = stats;
    const rangeLabel = (rangeStart, rangeEnd) => {
      const dateStart = new Date(rangeStart * 1000);
      const dateEnd = new Date((rangeEnd) * 1000);
      return `${dateStart.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' })} – ${dateEnd.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' })}`;
    };
    const currentLabel = rangeLabel(start, end);
    const previousLabel = rangeLabel(startPrev, endPrev);

    const applyValue = (element, value) => {
      if (element) {
        element.textContent = formatNumber(value);
      }
    };

    applyValue(refs.statsPosts, posts.current);
    applyValue(refs.statsLikes, likes.current);
    applyValue(refs.statsComments, comments.current);
    applyValue(refs.statsReplies, replies.current);

    applyChangeIndicator(refs.statsPostsChange, computePercentChange(posts.previous, posts.current));
    applyChangeIndicator(refs.statsLikesChange, computePercentChange(likes.previous, likes.current));
    applyChangeIndicator(refs.statsCommentsChange, computePercentChange(comments.previous, comments.current));
    applyChangeIndicator(refs.statsRepliesChange, computePercentChange(replies.previous, replies.current));

    updateSummaryNote(refs.statsPostsNote, posts.previous, posts.current, currentLabel, previousLabel);
    updateSummaryNote(refs.statsLikesNote, likes.previous, likes.current, currentLabel, previousLabel);
    updateSummaryNote(refs.statsCommentsNote, comments.previous, comments.current, currentLabel, previousLabel);
    updateSummaryNote(refs.statsRepliesNote, replies.previous, replies.current, currentLabel, previousLabel);
  }

  function computePercentChange(previous, current) {
    const prev = Number(previous) || 0;
    const curr = Number(current) || 0;
    if (prev === 0) {
      if (curr === 0) {
        return 0;
      }
      return 100;
    }
    return ((curr - prev) / prev) * 100;
  }

  function updateSummaryNote(element, previous, current, currentLabel, previousLabel) {
    if (!element) {
      return;
    }
    if (previous === 0 && current === 0) {
      element.textContent = `אין פעילות בתקופה ${currentLabel}.`;
      return;
    }
    const change = current - previous;
    const direction = change > 0 ? 'עלייה' : change < 0 ? 'ירידה' : 'שינוי זניח';
    const absChange = Math.abs(change);
    element.textContent = `${direction} של ${formatNumber(absChange)} לעומת ${previousLabel}.`;
  }

  // חלק חישוב פעילות נוכחית (profile-view.js) – שומר את הרשימות האחרונות ומפעיל רענון התצוגה
  function updateActivityStats(posts, replies) {
    if (Array.isArray(posts)) {
      App.profilePostsCache = posts;
    }
    if (Array.isArray(replies)) {
      App.profileRepliesCache = replies;
    }
    refreshActivityView();
  }

  const activityState = {
    chart: null,
    period: 60,
    lastSeries: null,
    lastStats: null,
  };

  // חלק חישוב נתוני גרף (profile-view.js) – מחזיר סדרות וסטטיסטיקות עבור הטווח הנבחר
  function computeActivityData(posts, replies, likeEvents, commentEvents) {
    const period = activityState.period || 60;
    const { start, end } = getPeriodRange(period);
    const periodSeconds = period * 24 * 60 * 60;
    const endPrev = start - 1;
    const startPrev = endPrev - periodSeconds + 1;

    const series = buildSeriesData(posts, start, end, likeEvents, commentEvents);
    const stats = buildPeriodStats(posts, replies, likeEvents, commentEvents, start, end, startPrev, endPrev);
    return { series, stats };
  }

  // חלק רענון פעילות (profile-view.js) – מעדכן את הגרף והכרטיס על בסיס הנתונים שמאוחסנים ב-App
  function refreshActivityView() {
    const posts = Array.isArray(App.profilePostsCache) ? App.profilePostsCache : null;
    const replies = Array.isArray(App.profileRepliesCache) ? App.profileRepliesCache : [];
    if (!posts || !replies) {
      return;
    }
    const likeEvents = App.profileLikeTimeline instanceof Map ? Array.from(App.profileLikeTimeline.values()) : [];
    const commentEvents = App.profileCommentTimeline instanceof Map ? Array.from(App.profileCommentTimeline.values()) : [];
    if (refs.likesCount) {
      const totalLikes = likeEvents.length;
      refs.likesCount.textContent = totalLikes.toString();
    }
    const { series, stats } = computeActivityData(posts, replies, likeEvents, commentEvents);
    renderSummary(stats);
    updateActivityChart(series, stats);
    activityState.lastSeries = series;
    activityState.lastStats = stats;
  }

  function initActivityChart() {
    if (!refs.activityChart || typeof ApexCharts !== 'function') {
      return;
    }
    if (activityState.chart) {
      return;
    }
    const options = {
      chart: {
        type: 'area',
        height: 280,
        parentHeightOffset: 0,
        toolbar: { show: false },
        animations: {
          enabled: true,
          easing: 'easeinout',
          speed: 650,
        },
        zoom: { enabled: false },
        foreColor: '#c9d1d9',
        fontFamily: '"Segoe UI", Tahoma, Geneva, Verdana, sans-serif',
      },
      stroke: {
        curve: 'smooth',
        width: 3,
      },
      dataLabels: { enabled: false },
      fill: {
        type: 'gradient',
        gradient: {
          shadeIntensity: 0.7,
          opacityFrom: 0.4,
          opacityTo: 0.1,
          stops: [0, 85, 100],
        },
      },
      colors: ['#4c8bfd', '#ff6b81', '#66d36e'],
      grid: {
        borderColor: 'rgba(255, 255, 255, 0.06)',
        strokeDashArray: 4,
      },
      xaxis: {
        type: 'datetime',
        labels: {
          datetimeUTC: false,
          style: { colors: '#8b949e' },
        },
        axisBorder: { show: false },
        axisTicks: { show: false },
      },
      yaxis: {
        min: 0,
        forceNiceScale: true,
        labels: {
          style: { colors: '#8b949e' },
        },
      },
      tooltip: {
        theme: 'dark',
        x: { format: 'dd/MM/yy' },
        shared: true,
        intersect: false,
      },
      legend: {
        markers: { offsetX: -4 },
        labels: { colors: '#c9d1d9' },
      },
      series: [
        { name: 'פוסטים', data: [] },
        { name: 'לייקים', data: [] },
        { name: 'תגובות', data: [] },
      ],
      noData: { text: 'טוען פעילות...' },
    };

    activityState.chart = new ApexCharts(refs.activityChart, options);
    activityState.chart.render();
  }

  function getPeriodRange(periodDays) {
    const now = new Date();
    const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - (periodDays - 1));
    startDate.setHours(0, 0, 0, 0);
    const start = Math.floor(startDate.getTime() / 1000);
    const end = Math.floor(endDate.getTime() / 1000);
    return { start, end };
  }

  function bucketEventsByDay(events, start, end) {
    const buckets = new Map();
    const day = 24 * 60 * 60;
    const clamped = [];
    events.forEach((event) => {
      if (!event || typeof event.created_at !== 'number') {
        return;
      }
      if (event.created_at < start || event.created_at > end) {
        return;
      }
      clamped.push(event);
      const bucketIndex = Math.floor((event.created_at - start) / day);
      const bucketBase = start + bucketIndex * day;
      const bucketKey = bucketBase * 1000;
      buckets.set(bucketKey, (buckets.get(bucketKey) || 0) + 1);
    });
    return { buckets, clamped };
  }

  function buildSeriesData(posts, start, end, likeEvents, commentEvents) {
    const day = 24 * 60 * 60;
    const { buckets: postBuckets, clamped: filteredPosts } = bucketEventsByDay(posts, start, end);

    const { buckets: likeBuckets } = bucketEventsByDay(likeEvents, start, end);
    const { buckets: commentBuckets } = bucketEventsByDay(commentEvents, start, end);

    const totalDays = Math.floor((end - start) / day) + 1;
    const seriesRange = [];
    for (let index = 0; index < totalDays; index += 1) {
      const bucketTs = (start + index * day) * 1000;
      seriesRange.push(bucketTs);
    }

    const postsSeries = seriesRange.map((ts) => [ts, postBuckets.get(ts) || 0]);
    const likesSeries = seriesRange.map((ts) => [ts, likeBuckets.get(ts) || 0]);
    const commentsSeries = seriesRange.map((ts) => [ts, commentBuckets.get(ts) || 0]);

    return {
      postsSeries,
      likesSeries,
      commentsSeries,
      totalPosts: filteredPosts.length,
      totalLikes: likeEvents.filter((evt) => evt.created_at >= start && evt.created_at <= end).length,
      totalComments: commentEvents.filter((evt) => evt.created_at >= start && evt.created_at <= end).length,
    };
  }

  // חלק ציור גרף פעילות (profile-view.js) – מציג את סדרות הזמן לטווח הנבחר כולל חיווי במצב ריק
  function updateActivityChart(seriesData, rangeStats) {
    initActivityChart();
    if (!activityState.chart) {
      return;
    }
    const { postsSeries, likesSeries, commentsSeries } = seriesData;

    const hasData = postsSeries.some(([, value]) => value > 0)
      || likesSeries.some(([, value]) => value > 0)
      || commentsSeries.some(([, value]) => value > 0);

    if (hasData) {
      refs.activityEmpty?.setAttribute('hidden', '');
      refs.activityChart?.classList.remove('is-empty');
      activityState.chart.updateSeries([
        { name: 'פוסטים', data: postsSeries },
        { name: 'לייקים', data: likesSeries },
        { name: 'תגובות', data: commentsSeries },
      ]);
    } else {
      refs.activityEmpty?.removeAttribute('hidden');
      refs.activityChart?.classList.add('is-empty');
      activityState.chart.updateSeries([
        { name: 'פוסטים', data: [] },
        { name: 'לייקים', data: [] },
        { name: 'תגובות', data: [] },
      ]);
    }

  }

  function bindActivityPeriodButtons() {
    if (!refs.activityPeriodButtons?.length) {
      return;
    }
    refs.activityPeriodButtons.forEach((button) => {
      if (button.dataset.listenerAttached === 'true') {
        return;
      }
      button.dataset.listenerAttached = 'true';
      button.addEventListener('click', () => {
        refs.activityPeriodButtons.forEach((btn) => btn.classList.toggle('is-active', btn === button));
        const period = Number.parseInt(button.getAttribute('data-activity-period'), 10);
        if (!Number.isNaN(period)) {
          activityState.period = period;
          refreshActivityView();
        }
      });
    });
  }

  // חלק סיווג פוסטים/תגובות (profile-view.js) – בהתאם ל-NIP-10
  function extractParentId(event) {
    if (!event || !Array.isArray(event.tags)) {
      return null;
    }
    const eTags = event.tags.filter((t) => Array.isArray(t) && t[0] === 'e');
    if (eTags.length === 0) {
      return null;
    }
    for (const tag of eTags) {
      if (tag[3] === 'reply') {
        return tag[1] || null;
      }
    }
    const hasAnyMarker = eTags.some((t) => typeof t[3] === 'string' && t[3]);
    if (!hasAnyMarker && eTags.length >= 2) {
      const last = eTags[eTags.length - 1];
      return last?.[1] || null;
    }
    return null;
  }

  // חלק רינדור הדרגתי (profile-view.js) – מציג פוסטים בצורה הדרגתית עם lazy loading
  function renderTimelineWithLazyLoad(allPosts, allReplies) {
    App.profilePostsCache = allPosts;
    App.profileRepliesCache = allReplies;

    // רינדור תגובות (רפליים) שהמשתמש כתב
    if (allReplies.length > 0) {
      if (typeof App.renderProfilePosts === 'function' && refs.timelineComments) {
        App.renderProfilePosts(allReplies, 'profileTimelineComments');
      }
      if (refs.repliesCountLabel) {
        refs.repliesCountLabel.textContent = `${allReplies.length} תגובות`;
      }
      // מוודא שהכרטיס של התגובות מוצג
      if (refs.repliesCard) {
        refs.repliesCard.hidden = false;
      }
    }

    // רינדור כל הפוסטים מיד - ללא lazy loading
    renderTimeline(allPosts, allReplies);
  }

  // חלק הוספת פוסטים (profile-view.js) – מוסיף פוסטים לסוף הרשימה
  function appendPostsToTimeline(posts) {
    if (!refs.timelineList || !Array.isArray(posts) || posts.length === 0) {
      return;
    }

    const fragment = document.createDocumentFragment();
    posts.forEach((event) => {
      const profileData = App.profileCache?.get(event.pubkey) || {
        name: `משתמש ${event.pubkey.slice(0, 8)}`,
        initials: typeof App.getInitials === 'function' ? App.getInitials(event.pubkey) : 'AN',
        picture: '',
      };

      const wrapper = document.createElement('li');
      if (typeof App.buildPostTemplate === 'function') {
        wrapper.innerHTML = App.buildPostTemplate(event, profileData, false);
      } else if (typeof App.renderProfilePosts === 'function') {
        // fallback
        const tempContainer = document.createElement('ul');
        App.renderProfilePosts([event], tempContainer.id || 'temp');
        wrapper.innerHTML = tempContainer.innerHTML;
      }
      fragment.appendChild(wrapper);
    });

    // מוסיף לפני אלמנט הטעינה אם קיים
    const loadingEl = refs.timelineList.querySelector('.profile-posts-loading');
    if (loadingEl) {
      refs.timelineList.insertBefore(fragment, loadingEl);
    } else {
      refs.timelineList.appendChild(fragment);
    }

    // מחבר אירועים לפוסטים החדשים
    if (typeof App.wireProfileLinks === 'function') App.wireProfileLinks(refs.timelineList);
    if (typeof App.wireLikeButtons === 'function') App.wireLikeButtons(refs.timelineList);
  }

  async function loadOwnPosts() {
    if (!refs.timelineStatus) {
      hideConnectionToast();
      return;
    }
    if (!App.publicKey) {
      refs.timelineStatus.textContent = 'אין מפתח ציבורי זמין לטעינת הפוסטים.';
      renderTimeline([]);
      hideConnectionToast();
      return;
    }

    const Cache = App.ProfileCache;

    // שלב 1: בדיקת קאש מקומי
    if (Cache) {
      const cached = Cache.get('posts');
      if (cached && cached.data && cached.data.length > 0) {
        // ללא הודעות - עיצוב טיקטוקי נקי
        refs.timelineStatus.style.display = 'none';
        
        // מפריד פוסטים מתגובות
        const posts = cached.data.filter(e => !extractParentId(e));
        const replies = cached.data.filter(e => extractParentId(e));
        
        // טעינת engagement גם מהקאש
        if (typeof App.hydrateEngagementForPosts === 'function') {
          App.hydrateEngagementForPosts(posts, extractParentId).then(() => {
            renderTimelineWithLazyLoad(posts, replies);
            // עדכון תגובות
            if (typeof App.updateCommentsForParent === 'function') {
              posts.slice(0, 6).forEach((event) => {
                if (event?.id) App.updateCommentsForParent(event.id);
              });
            }
          }).catch(() => {
            renderTimelineWithLazyLoad(posts, replies);
          });
        } else {
          renderTimelineWithLazyLoad(posts, replies);
        }
        
        if (!cached.isStale) {
          hideConnectionToast();
          return;
        }
      }
    }

    // שלב 2: טעינה מהרשת
    if (!App.pool || !Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      refs.timelineStatus.textContent = 'Pool לא זמין כרגע. נסה לרענן מאוחר יותר.';
      if (!Cache?.get('posts')?.data?.length) {
        renderTimeline([]);
      }
      hideConnectionToast();
      return;
    }

    refs.timelineStatus.style.display = 'none';

    try {
      const filter = { kinds: [1], authors: [App.publicKey], limit: 120 };
      let events;

      if (typeof App.pool.list === 'function') {
        events = await App.pool.list(App.relayUrls, [filter]);
      } else if (typeof App.pool.subscribeMany === 'function') {
        events = await new Promise((resolve) => {
          const collectedEvents = [];
          const subscription = App.pool.subscribeMany(App.relayUrls, [filter], {
            onevent(event) {
              if (event && typeof event.created_at === 'number') {
                collectedEvents.push(event);
              }
            },
            oneose() {
              subscription?.close?.();
              resolve(collectedEvents);
            },
          });
          setTimeout(() => { subscription?.close?.(); resolve(collectedEvents); }, 6000);
        });
      } else {
        throw new Error('Pool instance missing list compatibility');
      }

      // מפריד פוסטים מתגובות
      const posts = [];
      const replies = [];
      events.forEach((event) => {
        if (!event || typeof event.created_at !== 'number') return;
        if (extractParentId(event)) {
          replies.push(event);
        } else {
          posts.push(event);
        }
      });

      const sortedPosts = posts.sort((a, b) => b.created_at - a.created_at);
      const sortedReplies = replies.sort((a, b) => b.created_at - a.created_at);

      // שמירה לקאש
      if (Cache) {
        Cache.save('posts', [...sortedPosts, ...sortedReplies]);
      }

      // טעינת engagement
      if (typeof App.hydrateEngagementForPosts === 'function') {
        try {
          await App.hydrateEngagementForPosts(sortedPosts, extractParentId);
        } catch (err) {
          console.warn('hydrateEngagementForPosts failed', err);
        }
      }

      renderTimelineWithLazyLoad(sortedPosts, sortedReplies);

      if (typeof App.updateCommentsForParent === 'function') {
        sortedPosts.slice(0, 6).forEach((event) => {
          if (event?.id) App.updateCommentsForParent(event.id);
        });
      }

      hideConnectionToast();
    } catch (err) {
      console.error('Failed loading own posts', err);
      refs.timelineStatus.textContent = 'שגיאה בטעינה. בדוק את החיבור.';
      hideConnectionToast();
    }
  }

  App.loadOwnPosts = loadOwnPosts;

  // חלק שירות לוח (profile-view.js) – העתקה ללוח זיכרון בצורה בטוחה עם הודעות שגיאה
  // חלק קיצור איחודים (profile-view.js) – חבר כפתורים מרובים לפעולה אחת
  function attachClicks(ids, handler) {
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('click', handler);
      }
    });
  }

  // חלק קישורי כפתורים (profile-view.js) – יוצר את חוויית השימוש בדף
  function bindButtons() {
    attachClicks(['profileEditButton', 'profileTopEditButton'], () => {
      if (typeof window.openProfileSettings === 'function') {
        window.openProfileSettings();
      }
    });

    attachClicks(['profileTopHomeButton'], () => {
      window.location.href = 'index.html';
    });

    attachClicks(['profileRefreshPosts'], loadOwnPosts);
    attachClicks(['profileQuickCompose'], () => {
      window.location.href = 'index.html#compose';
    });
    bindTopMenu();
    bindHeaderShortcuts();
    bindRepliesToggle();
  }

  // חלק אתחול דף (profile-view.js) – מפעיל את השלבים הנדרשים בעת טעינת הפרופיל
  function initializeProfilePage() {
    ensureBootstrap();
    attachRenderHook();
    syncProfileToPage();
    if (typeof App.renderProfile === 'function') {
      App.renderProfile();
    }
    if (typeof App.loadOwnProfileMetadata === 'function') {
      App.loadOwnProfileMetadata().then(() => {
        syncProfileToPage();
      });
    }
    if (typeof App.subscribeOwnProfileMetadata === 'function') {
      App.subscribeOwnProfileMetadata();
    }
    bindActivityPeriodButtons();
    subscribeFollowers();
    bindButtons();
    initActivityChart();
    loadOwnPosts();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeProfilePage);
  } else {
    initializeProfilePage();
  }
})(window);
