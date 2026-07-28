// חלק קטלוג LIVE TV (live-tv-catalog.js) – ערוצים מקובץ curated + הסתרת מנהל + סינון לא-פעילים | HYPER CORE TECH
(function initLiveTvCatalog(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  const CATALOG_URL = './live-tv/curatedFavorites.json';
  const HIDDEN_LS_KEY = 'sos_live_tv_hidden_v1';
  const OFFLINE_LS_KEY = 'sos_live_tv_offline_v1';
  const OFFLINE_TTL_MS = 6 * 60 * 60 * 1000;
  const HIDDEN_KIND = 30078;
  const HIDDEN_D_TAG = 'live-tv-hidden';

  let catalogCache = null;
  let catalogPromise = null;
  const hiddenIds = new Set();
  const offlineMap = new Map(); // id -> failedAt

  function loadJsonMap(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function saveJsonMap(key, obj) {
    try {
      localStorage.setItem(key, JSON.stringify(obj || {}));
    } catch (_) {}
  }

  function hydrateHiddenFromStorage() {
    const obj = loadJsonMap(HIDDEN_LS_KEY);
    Object.keys(obj).forEach((id) => {
      if (obj[id]) hiddenIds.add(String(id));
    });
  }

  function hydrateOfflineFromStorage() {
    const obj = loadJsonMap(OFFLINE_LS_KEY);
    const now = Date.now();
    Object.keys(obj).forEach((id) => {
      const ts = Number(obj[id]) || 0;
      if (ts && now - ts < OFFLINE_TTL_MS) offlineMap.set(String(id), ts);
    });
  }

  function persistHidden() {
    const obj = {};
    hiddenIds.forEach((id) => { obj[id] = 1; });
    saveJsonMap(HIDDEN_LS_KEY, obj);
  }

  function persistOffline() {
    const obj = {};
    offlineMap.forEach((ts, id) => { obj[id] = ts; });
    saveJsonMap(OFFLINE_LS_KEY, obj);
  }

  hydrateHiddenFromStorage();
  hydrateOfflineFromStorage();

  function isAdminViewer() {
    const pk = typeof App.publicKey === 'string' ? App.publicKey.toLowerCase() : '';
    return !!(pk && App.adminPublicKeys instanceof Set && App.adminPublicKeys.has(pk));
  }

  async function fetchCatalog() {
    if (catalogCache) return catalogCache;
    if (catalogPromise) return catalogPromise;
    catalogPromise = (async () => {
      const res = await fetch(CATALOG_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('live-tv-catalog-http-' + res.status);
      const data = await res.json();
      const channels = Array.isArray(data.channels) ? data.channels : [];
      catalogCache = channels
        .filter((ch) => ch && ch.stream && ch.type !== 'radio')
        .map((ch) => ({
          id: String(ch.id || ''),
          name: String(ch.name || 'ערוץ'),
          stream: String(ch.stream || ''),
          category: String(ch.category || ''),
          language: String(ch.language || ''),
          tags: Array.isArray(ch.tags) ? ch.tags : [],
          tvgId: String(ch.tvgId || ''),
          source: String(ch.source || 'catalog'),
        }))
        .filter((ch) => ch.id && /^https?:\/\//i.test(ch.stream));
      return catalogCache;
    })().catch((err) => {
      catalogPromise = null;
      console.warn('[LIVE-TV] catalog load failed', err);
      catalogCache = [];
      return catalogCache;
    });
    return catalogPromise;
  }

  function isChannelHidden(id) {
    return hiddenIds.has(String(id || ''));
  }

  function isChannelOffline(id) {
    const ts = offlineMap.get(String(id || ''));
    if (!ts) return false;
    if (Date.now() - ts > OFFLINE_TTL_MS) {
      offlineMap.delete(String(id));
      persistOffline();
      return false;
    }
    return true;
  }

  function markChannelOffline(id) {
    if (!id) return;
    offlineMap.set(String(id), Date.now());
    persistOffline();
  }

  function markChannelOnline(id) {
    if (!id) return;
    if (offlineMap.delete(String(id))) persistOffline();
  }

  async function publishHiddenList() {
    if (!isAdminViewer()) return;
    if (!App.pool || typeof App.finalizeEvent !== 'function' || !App.privateKey || !App.publicKey) return;
    const list = Array.from(hiddenIds);
    const draft = {
      kind: HIDDEN_KIND,
      pubkey: App.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', HIDDEN_D_TAG],
        ['t', App.NETWORK_TAG || 'sos'],
      ],
      content: JSON.stringify({ version: 1, hidden: list }),
    };
    try {
      const event = App.finalizeEvent(draft, App.privateKey);
      await App.pool.publish(App.relayUrls || [], event);
      console.log('[LIVE-TV] published hidden list', { count: list.length });
    } catch (err) {
      console.warn('[LIVE-TV] publish hidden failed', err);
    }
  }

  async function pullHiddenListFromRelays() {
    if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) return;
    try {
      const filters = [{ kinds: [HIDDEN_KIND], '#d': [HIDDEN_D_TAG], limit: 5 }];
      let events = [];
      if (typeof App.pool.list === 'function') {
        events = await App.pool.list(App.relayUrls, filters);
      } else if (typeof App.pool.querySync === 'function') {
        const res = await App.pool.querySync(App.relayUrls, filters[0]);
        events = Array.isArray(res) ? res : (Array.isArray(res?.events) ? res.events : []);
      }
      if (!Array.isArray(events) || !events.length) return;
      events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      const newest = events[0];
      const parsed = JSON.parse(newest.content || '{}');
      const list = Array.isArray(parsed.hidden) ? parsed.hidden : [];
      list.forEach((id) => hiddenIds.add(String(id)));
      persistHidden();
    } catch (err) {
      console.warn('[LIVE-TV] pull hidden failed', err);
    }
  }

  async function hideChannel(channelId) {
    const id = String(channelId || '');
    if (!id) return false;
    if (!isAdminViewer()) {
      console.warn('[LIVE-TV] hideChannel denied – not admin');
      return false;
    }
    const confirmed = window.confirm('להסיר את הערוץ מפיד LIVE TV לכל המשתמשים במכשיר זה (ולפרסם הסתרה לרשת אם אפשר)?');
    if (!confirmed) return false;
    hiddenIds.add(id);
    persistHidden();
    publishHiddenList().catch(() => {});
    return true;
  }

  function cleanChannelName(name) {
    if (typeof App.formatChannelDisplayName === 'function') {
      return App.formatChannelDisplayName(name) || String(name || '').trim();
    }
    return String(name || '')
      .replace(/\s*[\(\[\{]\s*(?:\d{3,4}\s*[pi]|4k|8k|uhd|fhd|hd|sd|hq)\s*[\)\]\}]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function channelToVideoItem(ch) {
    return {
      id: 'live-tv-' + ch.id,
      liveUrl: ch.stream,
      content: cleanChannelName(ch.name),
      liveChannelId: ch.id,
      liveTvgId: ch.tvgId || '',
      liveCatalog: true,
      liveCategory: ch.category || '',
      authorName: 'LIVE TV',
      authorPicture: '',
      authorInitials: 'TV',
      pubkey: '',
      createdAt: 0,
      likesCount: 0,
      commentsCount: 0,
      likedByMe: false,
    };
  }

  async function getLiveTvFeedVideos() {
    await pullHiddenListFromRelays().catch(() => {});
    const channels = await fetchCatalog();
    return channels
      .filter((ch) => !isChannelHidden(ch.id) && !isChannelOffline(ch.id))
      .map((ch, index) => {
        const item = channelToVideoItem(ch);
        item.liveChannelNumber = index + 1;
        return item;
      });
  }

  async function probeChannelHealth(streamUrl, channelId) {
    if (!streamUrl) return false;
    if (typeof App.checkHlsHealth !== 'function') return true;
    try {
      const health = await App.checkHlsHealth(streamUrl, { timeoutMs: 6000 });
      const ok = !!(health && (health.ok || health.unverified));
      if (channelId) {
        if (ok) markChannelOnline(channelId);
        else markChannelOffline(channelId);
      }
      return ok;
    } catch (_) {
      if (channelId) markChannelOffline(channelId);
      return false;
    }
  }

  // בדיקת אצווה קטנה בתחילת הפיד – לא חוסמת את כל 81 הערוצים | HYPER CORE TECH
  async function warmInitialLiveTvHealth(limit = 10) {
    const channels = await fetchCatalog();
    const candidates = channels
      .filter((ch) => !isChannelHidden(ch.id))
      .slice(0, Math.max(1, limit));
    await Promise.allSettled(
      candidates.map((ch) => probeChannelHealth(ch.stream, ch.id))
    );
  }

  Object.assign(App, {
    fetchLiveTvCatalog: fetchCatalog,
    getLiveTvFeedVideos,
    hideLiveTvChannel: hideChannel,
    isLiveTvAdmin: isAdminViewer,
    probeLiveTvChannelHealth: probeChannelHealth,
    warmInitialLiveTvHealth,
    isLiveTvChannelHidden: isChannelHidden,
    markLiveTvChannelOffline: markChannelOffline,
    markLiveTvChannelOnline: markChannelOnline,
  });

  window.SosLiveTvCatalog = {
    fetchCatalog,
    getLiveTvFeedVideos,
    hideChannel,
    isAdminViewer,
    probeChannelHealth,
    warmInitialLiveTvHealth,
  };
})(window);
