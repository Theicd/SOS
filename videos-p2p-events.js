(function initVideosP2PEvents(window) {
  const queue = [];

  function canProcess() {
    return (
      typeof registerVideoSourceEvent === 'function' &&
      typeof registerVideoEngagementEvent === 'function' &&
      typeof upsertVideoInState === 'function' &&
      typeof removeVideoFromState === 'function' &&
      typeof removeVideoCard === 'function'
    );
  }

  function shouldAcceptVideoEvent(app, event) {
    const viewerKey = typeof app?.publicKey === 'string' ? app.publicKey : '';
    if (viewerKey && event?.pubkey === viewerKey) return true;

    if (typeof getNetworkTag !== 'function' || typeof eventHasNetworkTag !== 'function') return true;
    const networkTag = getNetworkTag();
    return !networkTag || eventHasNetworkTag(event, networkTag);
  }

  function handleEvent(event) {
    if (!event || !event.kind) return;

    const app = window.NostrApp || {};

    if (event.kind === 1) {
      registerVideoSourceEvent(event);
      registerVideoEngagementEvent(event);

      if (!shouldAcceptVideoEvent(app, event)) return;
      if (app?.deletedEventIds?.has?.(event.id)) return;
      if (typeof state !== 'undefined' && Array.isArray(state?.videos) && state.videos.some((v) => v.id === event.id)) {
        return;
      }

      const convert = app.convertVideoEventToVideoObject;
      const video = typeof convert === 'function' ? convert(event) : null;
      if (!video) return;

      const profileData = app?.profileCache?.get(video.pubkey) || {};
      video.authorName = profileData.name || `משתמש ${String(video.pubkey || '').slice(0, 8)}`;
      video.authorPicture = profileData.picture || '';
      video.authorInitials = profileData.initials || 'AN';
      upsertVideoInState(video);
      return;
    }

    if (event.kind === 5) {
      if (typeof app.registerDeletion === 'function') {
        app.registerDeletion(event);
      }
      if (Array.isArray(event.tags)) {
        event.tags.forEach((tag) => {
          if (Array.isArray(tag) && tag[0] === 'e' && tag[1]) {
            const deletedId = tag[1];
            if (app?.deletedEventIds?.has?.(deletedId) || typeof app.registerDeletion !== 'function') {
              removeVideoFromState(deletedId);
              removeVideoCard(deletedId);
            }
          }
        });
      }
      return;
    }

    if (event.kind === 7) {
      registerVideoEngagementEvent(event);
    }
  }

  function flush() {
    if (!queue.length || !canProcess()) return;
    while (queue.length) {
      handleEvent(queue.shift());
    }
  }

  window.addEventListener('p2p:event-ingested', (evt) => {
    const event = evt?.detail?.event;
    if (!event) return;
    queue.push(event);
    flush();
  });

  window.addEventListener('DOMContentLoaded', flush);
})(window);
