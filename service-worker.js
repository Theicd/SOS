// חלק Service Worker (service-worker.js) – התראות שיחה נכנסת עם פעולת פתיחה אחת (ללא מענה אוטומטי) ותקשורת עם חלון האפליקציה | HYPER CORE TECH
(function initServiceWorker(self) {
  self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
  });

  async function getFirstWindowClient() {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!list || !list.length) return null;
    return list[0];
  }

  async function focusOrOpenClient(url) {
    const client = await getFirstWindowClient();
    if (client) {
      try {
        await client.focus();
      } catch {}
      return client;
    }

    if (url) {
      try {
        return await self.clients.openWindow(url);
      } catch {}
    }

    return null;
  }

  async function postMessageToAllClients(message) {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    (list || []).forEach((client) => {
      try {
        client.postMessage(message);
      } catch {}
    });
  }

  self.addEventListener('notificationclick', (event) => {
    const notification = event.notification;
    const data = notification && notification.data ? notification.data : {};
    const type = data.type || '';
    const peerPubkey = data.peerPubkey || null;
    const url = data.url || './';

    try {
      notification.close();
    } catch {}

    const messageType =
      type === 'voice-call-incoming'
        ? 'voice-call-notification-action'
        : type === 'video-call-incoming'
        ? 'video-call-notification-action'
        : '';
    if (!messageType) return;

    event.waitUntil((async () => {
      const message = {
        type: messageType,
        action: 'open',
        peerPubkey
      };

      const client = await focusOrOpenClient(url);
      if (client) {
        try {
          client.postMessage(message);
        } catch {}
        return;
      }

      await postMessageToAllClients(message);
    })());
  });
})(self);
