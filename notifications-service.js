;(function initNotificationsService(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  if (!App.notificationsState || !App.upsertNotification || !App.setNotificationsLastSyncTs) {
    console.warn('Notifications state missing – notifications-service skipped');
    return;
  }
  const LIKE_KIND = 7;
  const COMMENT_KIND = 1;
  const FOLLOW_KIND = App.FOLLOW_KIND || 40010;
  const PROFILE_TTL_SECONDS = 86400;
  const AVATAR_CACHE_TTL_SECONDS = 86400;

  function profileCacheKey(url) {
    return url ? `avatar_cache_${btoa(url)}` : null;
  }
  async function fetchAvatarAsDataUrl(url) {
    if (!url) return '';
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) return '';
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result || '');
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (_e) {
      return '';
    }
  }
  async function getCachedAvatar(url) {
    const key = profileCacheKey(url);
    if (!key) return '';
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return '';
      const parsed = JSON.parse(raw);
      const nowSec = Math.floor(Date.now() / 1000);
      if (!parsed?.dataUrl || !parsed?.ts || (nowSec - parsed.ts) > AVATAR_CACHE_TTL_SECONDS) {
        return '';
      }
      return parsed.dataUrl;
    } catch (_e) {
      return '';
    }
  }
  async function cacheAvatar(url) {
    const key = profileCacheKey(url);
    if (!key) return '';
    const cached = await getCachedAvatar(url);
    if (cached) return cached;
    const dataUrl = await fetchAvatarAsDataUrl(url);
    if (dataUrl) {
      try {
        window.localStorage.setItem(key, JSON.stringify({ dataUrl, ts: Math.floor(Date.now() / 1000) }));
      } catch (_e) {}
    }
    return dataUrl;
  }

  async function resolveProfile(pubkey) {
    const normalized = pubkey?.toLowerCase?.() || '';
    const nowSec = Math.floor(Date.now() / 1000);
    const ttl = PROFILE_TTL_SECONDS;
    const existing = App.profileCache?.get?.(normalized);
    if (existing?.profileFetchedAt && (nowSec - existing.profileFetchedAt) < ttl) {
      return existing;
    }
    if (typeof App.fetchProfile === 'function') {
      try {
        const profile = await App.fetchProfile(normalized);
        if (profile) {
          profile.profileFetchedAt = nowSec;
          if (profile.picture) {
            const cachedAvatar = await cacheAvatar(profile.picture);
            if (cachedAvatar) profile.picture = cachedAvatar;
          }
          if (!(App.profileCache instanceof Map)) App.profileCache = new Map();
          App.profileCache.set(normalized, profile);
          return profile;
        }
      } catch (_e) {}
    }
    return existing || null;
  }

  function buildFilters() {
    const me = (App.publicKey || '').toLowerCase();
    if (!me) return null;
    const sinceTs = typeof App.getNotificationsLastSyncTs === 'function' ? App.getNotificationsLastSyncTs() : 0;
    const base = { '#p': [me], limit: 200 };
    if (sinceTs) base.since = sinceTs;
    return [
      { kinds: [LIKE_KIND], ...base },
      { kinds: [COMMENT_KIND], ...base },
      { kinds: [FOLLOW_KIND], authors: undefined, ...base },
    ];
  }

  async function handleNotificationEvent(event) {
    if (!event || !event.kind || !event.pubkey) return;
    const me = (App.publicKey || '').toLowerCase();
    if (!me) return;
    const ts = typeof event.created_at === 'number' ? event.created_at : Math.floor(Date.now() / 1000);
    const actorPubkey = event.pubkey.toLowerCase();
    if (actorPubkey === me) return;

    let type = 'like';
    if (event.kind === COMMENT_KIND) type = 'comment';
    if (event.kind === FOLLOW_KIND) type = 'follow';

    // basic check: require #p tag to me (for likes/comments); for follow, skip tag check
    if (event.kind !== FOLLOW_KIND) {
      const targeted = Array.isArray(event.tags) && event.tags.some((tag) => Array.isArray(tag) && tag[0] === 'p' && tag[1]?.toLowerCase?.() === me);
      if (!targeted) return;
    }

    const profile = await resolveProfile(actorPubkey);
    const notification = {
      id: event.id,
      type,
      postId: '',
      actorPubkey,
      createdAt: ts,
      content: typeof event.content === 'string' ? event.content.trim().slice(0, 140) : '',
      read: false,
      actorProfile: profile
        ? { name: profile.name || '', picture: profile.picture || '', initials: profile.initials || '' }
        : null,
    };
    App.upsertNotification(notification);
    const currentSync = App.getNotificationsLastSyncTs?.() || 0;
    if (ts > currentSync) {
      App.setNotificationsLastSyncTs(ts);
    }
  }

  function subscribeNotifications() {
    if (!App.pool || typeof App.pool.subscribeMany !== 'function') {
      console.warn('Notifications: pool not ready');
      return;
    }
    const filters = buildFilters();
    if (!filters) return;
    try {
      App.pool.subscribeMany(App.relayUrls, filters, {
        onevent: (event) => handleNotificationEvent(event),
        oneose: () => {},
      });
    } catch (err) {
      console.warn('Notifications subscribe failed', err);
    }
  }

  if (!App._notificationsServiceBootstrapped) {
    App._notificationsServiceBootstrapped = true;
    const start = () => {
      if (!App.pool || !App.relayUrls || !App.publicKey) {
        setTimeout(start, 800);
        return;
      }
      subscribeNotifications();
    };
    start();
  }
})(window);
