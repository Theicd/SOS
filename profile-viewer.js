(function initPublicProfile(window) {
  // חלק פרופיל ציבורי (profile-viewer.js) – מציג נתוני משתמש לפי pubkey שנשלח בכתובת
  const App = window.NostrApp || (window.NostrApp = {});
  const tools = window.NostrTools || {};

  const refs = {
    connectionStatus: document.getElementById('connection-status'),
    avatar: document.getElementById('viewerAvatar'),
    name: document.getElementById('viewerName'),
    bio: document.getElementById('viewerBio'),
    sidebarBio: document.getElementById('viewerSidebarBio'),
    meta: document.getElementById('viewerMeta'),
    gallery: document.getElementById('viewerGallery'),
    statsPosts: document.getElementById('viewerStatsPosts'),
    statsReplies: document.getElementById('viewerStatsReplies'),
    timelineStatus: document.getElementById('viewerTimelineStatus'),
    timelineList: document.getElementById('viewerTimeline'),
    repliesList: document.getElementById('viewerReplies'),
    refresh: document.getElementById('viewerRefreshButton'),
    back: document.getElementById('viewerBackButton'),
    followButton: document.getElementById('viewerFollowButton'),
    followersCount: document.getElementById('viewerFollowersCount'),
    galleryModal: null,
    galleryModalImage: null,
    galleryModalClose: null,
  };

  const state = {
    targetPubkey: null,
    posts: [],
    replies: [],
    subscription: null,
    followerUnsubscribe: null,
    followersSnapshot: [],
    followerProfilePromises: new Map(),
  };

  let galleryModalListenersBound = false;

  function parsePubkey() {
    const params = new URLSearchParams(window.location.search);
    const pubkey = params.get('pubkey');
    if (pubkey && pubkey.length >= 10) {
      return pubkey.toLowerCase();
    }
    try {
      const stored = window.sessionStorage?.getItem('nostr_last_profile_view');
      if (stored && stored.length >= 10) {
        return stored.toLowerCase();
      }
    } catch (err) {
      console.warn('Failed accessing sessionStorage for profile viewer', err);
    }
    return null;
  }

  function hideConnectionToast() {
    if (refs.connectionStatus) {
      refs.connectionStatus.hidden = true;
    }
  }

  function openViewerGalleryModal(src, alt) {
    if (!refs.galleryModal || !refs.galleryModalImage) {
      return;
    }
    refs.galleryModalImage.src = src;
    refs.galleryModalImage.alt = alt || 'תצוגת גלריה ציבורית';
    refs.galleryModal.hidden = false;
    refs.galleryModal.removeAttribute('hidden');
    refs.galleryModal.classList.add('is-visible');
  }

  function closeViewerGalleryModal() {
    if (!refs.galleryModal || !refs.galleryModalImage) {
      return;
    }
    refs.galleryModal.classList.remove('is-visible');
    refs.galleryModal.hidden = true;
    refs.galleryModal.setAttribute('hidden', '');
    refs.galleryModalImage.src = '';
  }

  function bindViewerGalleryModal() {
    if (galleryModalListenersBound) {
      return;
    }
    refs.galleryModal = document.getElementById('viewerGalleryModal');
    refs.galleryModalImage = document.getElementById('viewerGalleryModalImage');
    refs.galleryModalClose = document.getElementById('viewerGalleryModalClose');
    if (!refs.galleryModal || !refs.galleryModalImage) {
      return;
    }
    if (refs.galleryModalClose) {
      refs.galleryModalClose.addEventListener('click', closeViewerGalleryModal);
    }
    if (refs.galleryModal) {
      refs.galleryModal.addEventListener('click', (event) => {
        if (event.target === refs.galleryModal) {
          closeViewerGalleryModal();
        }
      });
    }
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeViewerGalleryModal();
      }
    });
    galleryModalListenersBound = true;
  }

  function renderGallery(target, gallery, profileName) {
    if (!target) {
      return;
    }
    target.innerHTML = '';
    const safeGallery = Array.isArray(gallery) ? gallery.filter((item) => typeof item === 'string' && item.trim()) : [];
    if (safeGallery.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'profile-gallery__empty';
      empty.textContent = 'המשתמש עדיין לא שיתף תמונות בגלריה.';
      target.appendChild(empty);
      return;
    }
    safeGallery.forEach((url) => {
      const item = document.createElement('li');
      item.className = 'profile-gallery__item';
      const img = document.createElement('img');
      img.src = url;
      const altText = `${profileName || 'משתמש'} – תמונת גלריה`;
      img.alt = altText;
      item.appendChild(img);
      item.addEventListener('click', () => openViewerGalleryModal(url, altText));
      target.appendChild(item);
    });
  }

  function showStatus(message) {
    if (refs.connectionStatus) {
      refs.connectionStatus.hidden = false;
      refs.connectionStatus.textContent = message;
    }
  }

  function renderAvatar(target, profile) {
    if (!target) return;
    target.innerHTML = '';
    if (profile.picture) {
      const img = document.createElement('img');
      img.src = profile.picture;
      img.alt = profile.name || 'משתמש';
      target.appendChild(img);
    } else {
      const initials = profile.initials || (typeof App.getInitials === 'function' ? App.getInitials(profile.name || '') : 'AN');
      target.textContent = initials;
    }
  }

  function renderProfileCard(profile) {
    if (refs.name) refs.name.textContent = profile.name || `משתמש ${state.targetPubkey.slice(0, 8)}`;
    if (refs.bio) refs.bio.textContent = profile.bio || 'המשתמש עדיין לא עדכן ביוגרפיה.';
    if (refs.sidebarBio) refs.sidebarBio.textContent = profile.bio || 'אין תיאור זמין.';
    if (refs.meta) {
      refs.meta.innerHTML = '';
    }
    renderAvatar(refs.avatar, profile);
    renderGallery(refs.gallery, profile.gallery, profile.name);
    syncFollowButton();
    renderFollowersList();
    const topAvatar = document.getElementById('viewerTopAvatar');
    if (topAvatar) {
      topAvatar.innerHTML = '';
      if (profile.picture) {
        const topImg = document.createElement('img');
        topImg.src = profile.picture;
        topImg.alt = profile.name || 'משתמש';
        topAvatar.appendChild(topImg);
      } else {
        topAvatar.textContent = profile.initials || 'AN';
      }
    }
  }

  function sortEvents(events) {
    return events
      .filter((event) => event && typeof event.created_at === 'number')
      .sort((a, b) => b.created_at - a.created_at);
  }

  function renderTimeline(posts, replies) {
    const sortedPosts = sortEvents(posts || []);
    const sortedReplies = sortEvents(replies || []);

    if (typeof App.renderProfilePosts === 'function') {
      App.renderProfilePosts(sortedPosts, 'viewerTimeline');
      if (typeof App.updateLikeIndicator === 'function') {
        sortedPosts.forEach((event) => {
          if (event?.id) {
            App.updateLikeIndicator(event.id);
          }
        });
      }
      if (typeof App.updateCommentsForParent === 'function') {
        sortedPosts.forEach((event) => {
          if (event?.id) {
            App.updateCommentsForParent(event.id);
          }
        });
      }
    } else if (refs.timelineList) {
      refs.timelineList.innerHTML = '';
      if (sortedPosts.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'profile-timeline__item';
        empty.innerHTML = `
          <p style="margin:0;">לא נמצאו פוסטים עבור משתמש זה.</p>
          <small style="color:var(--muted);">יתכן שהוא עדיין לא פרסם תכנים או שהמטא-נתונים חסרים.</small>
        `;
        refs.timelineList.appendChild(empty);
      } else {
        sortedPosts.forEach((event) => {
          const li = document.createElement('li');
          li.className = 'profile-timeline__item';
          li.textContent = event.content || ''; // רנדר בסיסית למקרה שמרנדר עיצוב מלא אינו קיים
          refs.timelineList.appendChild(li);
        });
      }
    }

    if (refs.statsPosts) refs.statsPosts.textContent = sortedPosts.length.toString();

    if (typeof App.renderProfilePosts === 'function') {
      App.renderProfilePosts(sortedReplies, 'viewerReplies');
      if (typeof App.updateCommentsForParent === 'function') {
        sortedReplies.forEach((event) => {
          const parentId = extractParentId(event);
          if (parentId) {
            App.updateCommentsForParent(parentId);
          }
        });
      }
    } else if (refs.repliesList) {
      refs.repliesList.innerHTML = '';
      if (sortedReplies.length === 0) {
        const emptyReply = document.createElement('li');
        emptyReply.className = 'profile-timeline__item';
        emptyReply.textContent = 'המשתמש טרם הגיב לפוסטים אחרים.';
        refs.repliesList.appendChild(emptyReply);
      } else {
        sortedReplies.forEach((event) => {
          const li = document.createElement('li');
          li.className = 'profile-timeline__item';
          li.textContent = event.content || '';
          refs.repliesList.appendChild(li);
        });
      }
    }

    if (refs.statsReplies) refs.statsReplies.textContent = sortedReplies.length.toString();
  }

  // חלק עטיפת ריליים (profile-viewer.js) – מאפשר להשתמש גם בגרסאות SimplePool ללא list קלאסי
  async function listEventsThroughPool(filters) {
    if (!App.pool) {
      return [];
    }
    const relays = Array.isArray(App.relayUrls) ? App.relayUrls : [];
    if (relays.length === 0) {
      return [];
    }
    if (typeof App.pool.list === 'function') {
      return App.pool.list(relays, filters);
    }
    if (typeof App.pool.listMany === 'function') {
      return App.pool.listMany(relays, filters);
    }
    if (typeof App.pool.querySync === 'function') {
      const primaryFilter = Array.isArray(filters) && filters.length ? filters[0] : filters;
      const result = await App.pool.querySync(relays, primaryFilter);
      if (!result) {
        return [];
      }
      if (Array.isArray(result)) {
        return result;
      }
      if (Array.isArray(result.events)) {
        return result.events;
      }
      return [];
    }
    return [];
  }

  function ensurePool() {
    if (!App.pool && typeof tools.SimplePool === 'function') {
      App.pool = new tools.SimplePool();
    }
    if (!Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      App.relayUrls = ['wss://relay.damus.io', 'wss://relay.snort.social', 'wss://nos.lol'];
    }
    if (typeof App.refreshFollowButtons === 'function') {
      App.refreshFollowButtons();
    }
  }

  async function fetchProfileMetadata(pubkey) {
    if (App.profileCache?.has(pubkey)) {
      return App.profileCache.get(pubkey);
    }
    if (!App.pool) {
      return {
        name: `משתמש ${pubkey.slice(0, 8)}`,
        bio: '',
        picture: '',
        initials: App.getInitials ? App.getInitials(pubkey) : 'AN',
        gallery: [],
      };
    }
    try {
      const event = await App.pool.get(App.relayUrls, { kinds: [0], authors: [pubkey] });
      if (!event?.content) {
        return {
          name: `משתמש ${pubkey.slice(0, 8)}`,
          bio: '',
          picture: '',
          initials: App.getInitials ? App.getInitials(pubkey) : 'AN',
          gallery: [],
        };
      }
      const parsed = JSON.parse(event.content);
      const gallery = Array.isArray(parsed.gallery)
        ? parsed.gallery.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
        : [];
      const profile = {
        name: parsed.name || `משתמש ${pubkey.slice(0, 8)}`,
        bio: parsed.about || '',
        picture: parsed.picture || '',
        initials: App.getInitials ? App.getInitials(parsed.name || pubkey) : 'AN',
        gallery,
      };
      if (App.profileCache instanceof Map) {
        App.profileCache.set(pubkey, profile);
      }
      return profile;
    } catch (err) {
      console.warn('Failed to fetch metadata for viewer', err);
      return {
        name: `משתמש ${pubkey.slice(0, 8)}`,
        bio: '',
        picture: '',
        initials: App.getInitials ? App.getInitials(pubkey) : 'AN',
        gallery: [],
      };
    }
  }

  function extractParentId(event) {
    if (!event || !Array.isArray(event.tags)) {
      return null;
    }
    for (const tag of event.tags) {
      if (!Array.isArray(tag)) {
        continue;
      }
      if (tag[0] === 'e' && (tag[3] === 'root' || tag[3] === 'reply' || tag.length === 2)) {
        return tag[1] || null;
      }
    }
    return null;
  }

  async function loadEvents(pubkey) {
    if (!App.pool) {
      return { posts: [], replies: [] };
    }
    showStatus('טוען פוסטים מהריליים...');
    try {
      const filter = {
        kinds: [1],
        authors: [pubkey],
        limit: 120,
      };
      if (App.NETWORK_TAG) {
        filter['#t'] = [App.NETWORK_TAG];
      }
      const events = await listEventsThroughPool([filter]);
      const posts = [];
      const replies = [];
      events.forEach((event) => {
        const parent = extractParentId(event);
        if (parent) {
          replies.push(event);
        } else {
          posts.push(event);
        }
      });
      const sortedPosts = sortEvents(posts);
      const sortedReplies = sortEvents(replies);
      if (typeof App.hydrateEngagementForPosts === 'function') {
        try {
          await App.hydrateEngagementForPosts(sortedPosts, (evt) => extractParentId(evt));
        } catch (err) {
          console.warn('hydrateEngagementForPosts failed in profile viewer', err);
        }
      }
      return { posts: sortedPosts, replies: sortedReplies };
    } catch (err) {
      console.error('Failed loading viewer events', err);
      return { posts: [], replies: [] };
    } finally {
      hideConnectionToast();
      showStatus('');
    }
  }

  async function refreshProfile() {
    if (!state.targetPubkey) {
      return;
    }
    ensurePool();
    const profile = await fetchProfileMetadata(state.targetPubkey);
    renderProfileCard(profile);

    const { posts, replies } = await loadEvents(state.targetPubkey);
    state.posts = posts;
    state.replies = replies;
    renderTimeline(posts, replies);
    subscribeFollowers();
    initializeFollowSection();
    syncFollowButton();
  }

  function initializeFollowSection() {
    if (!refs.followersCount || !refs.followersList) {
      return;
    }
    refs.followersCount.textContent = '0 עוקבים';
    refs.followersList.innerHTML = '';
    if (refs.followersStatus) {
      refs.followersStatus.textContent = '';
    }
  }

  function syncFollowButton() {
    if (!refs.followButton || !state.targetPubkey) {
      return;
    }
    refs.followButton.setAttribute('data-follow-button', state.targetPubkey);
    refs.followButton.dataset.followName = refs.name?.textContent || '';
    if (typeof App.refreshFollowButtons === 'function') {
      App.refreshFollowButtons(refs.followButton.parentElement);
    }
  }

  function renderFollowersList() {
    // רשימת העוקבים הוסרה מהפרופיל הציבורי – אין צורך ברינדור
  }

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
      const cached = App.profileCache.get(pubkey);
      if (cached && (cached.name || cached.picture)) {
        return;
      }
      if (state.followerProfilePromises.has(pubkey)) {
        jobs.push(state.followerProfilePromises.get(pubkey));
        return;
      }
      const job = (async () => {
        try {
          const profile = await App.fetchProfile(pubkey);
          if (profile) {
            App.profileCache.set(pubkey, profile);
          }
        } catch (err) {
          console.warn('Profile viewer: failed fetching follower profile', err);
        } finally {
          state.followerProfilePromises.delete(pubkey);
        }
      })();
      state.followerProfilePromises.set(pubkey, job);
      jobs.push(job);
    });
    if (jobs.length) {
      await Promise.allSettled(jobs);
    }
  }

  function subscribeFollowers() {
    if (!state.targetPubkey || typeof App.subscribeFollowers !== 'function') {
      return;
    }
    if (typeof state.followerUnsubscribe === 'function') {
      state.followerUnsubscribe();
    }
    if (refs.followersStatus) {
      refs.followersStatus.textContent = 'טוען עוקבים...';
    }
    state.followerUnsubscribe = App.subscribeFollowers(state.targetPubkey, (entries) => {
      state.followersSnapshot = Array.isArray(entries) ? entries : [];
      if (refs.followersCount) {
        refs.followersCount.textContent = `${state.followersSnapshot.length} עוקבים`;
      }
      if (refs.followersStatus) {
        refs.followersStatus.textContent = state.followersSnapshot.length ? '' : 'אין עוקבים להצגה כרגע.';
      }
      ensureFollowerProfiles(state.followersSnapshot)
        .then(() => {
          // renderFollowersList();
        })
        .catch((err) => {
          console.warn('Profile viewer: follower profile enrichment failed', err);
        });
    });
  }

  function bindActions() {
    if (refs.refresh) {
      refs.refresh.addEventListener('click', () => refreshProfile());
    }
    if (refs.back) {
      refs.back.addEventListener('click', () => {
        window.history.back();
      });
    }
    if (refs.followButton) {
      refs.followButton.addEventListener('click', () => {
        if (!state.targetPubkey || typeof App.toggleFollow !== 'function') {
          return;
        }
        App.toggleFollow(state.targetPubkey, { name: refs.name?.textContent || '' });
      });
    }
  }

  function init() {
    state.targetPubkey = parsePubkey();
    if (!state.targetPubkey) {
      if (refs.timelineStatus) {
        refs.timelineStatus.textContent = 'לא נמצא משתמש להצגה. ודא שהכתובת כוללת pubkey תקין.';
      }
      return;
    }
    bindViewerGalleryModal();
    bindActions();
    refreshProfile();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
