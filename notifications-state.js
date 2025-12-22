;(function initNotificationsState(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  // חלק התראות (notifications-state.js) – אחסון מקומי של התראות עם חותמת סנכרון | HYPER CORE TECH
  const notificationsState = {
    items: [],
    lastSyncTs: 0,
    unreadCount: 0,
  };

  function getStorageKey() {
    const pubkey = typeof App.publicKey === 'string' ? App.publicKey.toLowerCase() : '';
    if (!pubkey) return null;
    return `nostr_notifications_${pubkey}`;
  }

  function sanitizeNotification(notification) {
    // חלק התרעות (notifications-state.js) – הגנה על localStorage מפני DataURL ענקיים | HYPER CORE TECH
    if (!notification) return null;
    const clone = { ...notification };
    if (clone.actorProfile && typeof clone.actorProfile === 'object') {
      const ap = { ...clone.actorProfile };
      if (typeof ap.picture === 'string' && ap.picture.length > 100000) {
        // אם התמונה היא DataURL ענקית, לא נPersist כדי לא לקרוס על quota
        ap.picture = '';
      }
      clone.actorProfile = ap;
    }
    return clone;
  }

  function persistState() {
    const key = getStorageKey();
    if (!key) return;
    try {
      const payload = {
        items: notificationsState.items.map((n) => sanitizeNotification(n)).filter(Boolean),
        lastSyncTs: notificationsState.lastSyncTs || 0,
      };
      window.localStorage.setItem(key, JSON.stringify(payload));
    } catch (err) {
      console.warn('Notifications: persist failed', err);
    }
  }

  function restoreState() {
    const key = getStorageKey();
    if (!key) return;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.items)) {
          notificationsState.items = parsed.items;
        }
        if (typeof parsed.lastSyncTs === 'number') {
          notificationsState.lastSyncTs = parsed.lastSyncTs;
        }
      }
    } catch (err) {
      console.warn('Notifications: restore failed', err);
    }
    recomputeUnread();
  }

  function recomputeUnread() {
    notificationsState.unreadCount = notificationsState.items.reduce((sum, item) => (!item.read ? sum + 1 : sum), 0);
  }

  function setNotifications(items) {
    notificationsState.items = Array.isArray(items) ? items.map((n) => sanitizeNotification(n)).filter(Boolean) : [];
    recomputeUnread();
    persistState();
    notify();
  }

  function upsertNotification(notification) {
    if (!notification || !notification.id) return;
    const safeNotification = sanitizeNotification(notification);
    if (!safeNotification) return;
    const existingIndex = notificationsState.items.findIndex((n) => n.id === safeNotification.id);
    if (existingIndex !== -1) {
      notificationsState.items[existingIndex] = Object.assign({}, notificationsState.items[existingIndex], safeNotification);
    } else {
      notificationsState.items.push(safeNotification);
    }
    notificationsState.items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    recomputeUnread();
    persistState();
    notify();
  }

  function markAllRead() {
    let changed = false;
    notificationsState.items.forEach((n) => {
      if (!n.read) {
        n.read = true;
        changed = true;
      }
    });
    if (changed) {
      recomputeUnread();
      persistState();
      notify();
    }
  }

  function getSnapshot() {
    return notificationsState.items.slice();
  }

  function setLastSyncTs(ts) {
    if (typeof ts !== 'number') return;
    notificationsState.lastSyncTs = ts;
    persistState();
  }

  function getLastSyncTs() {
    return notificationsState.lastSyncTs || 0;
  }

  const listeners = new Set();
  function subscribe(callback) {
    if (typeof callback !== 'function') return () => {};
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  function notify() {
    listeners.forEach((cb) => {
      try {
        cb(getSnapshot());
      } catch (err) {
        console.warn('Notifications: listener failed', err);
      }
    });
    if (typeof App.updateFooterNotificationsBadge === 'function') {
      try { App.updateFooterNotificationsBadge(getSnapshot()); } catch {}
    }
  }

  Object.assign(App, {
    notificationsState,
    getNotificationsSnapshot: getSnapshot,
    setNotificationsSnapshot: setNotifications,
    upsertNotification,
    markAllNotificationsRead: markAllRead,
    getNotificationsLastSyncTs: getLastSyncTs,
    setNotificationsLastSyncTs: setLastSyncTs,
    subscribeNotifications: subscribe,
  });

  if (!App._notificationsStateBootstrapped) {
    App._notificationsStateBootstrapped = true;
    restoreState();
  }
})(window);
