(function initVideoEventConverter(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  App.convertVideoEventToVideoObject = function convertVideoEventToVideoObject(event) {
    if (!event || event.kind !== 1 || !event.id) return null;

    const lines = String(event.content || '').split('\n');
    const mediaLinks = [];
    const textLines = [];

    for (const line of lines) {
      const trimmed = String(line || '').trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('http') || trimmed.startsWith('data:')) {
        mediaLinks.push(trimmed);
      } else {
        textLines.push(trimmed);
      }
    }

    const parseYouTubeFn = typeof window.parseYouTube === 'function' ? window.parseYouTube : null;
    const isVideoLinkFn = typeof window.isVideoLink === 'function' ? window.isVideoLink : null;
    const isImageLinkFn = typeof window.isImageLink === 'function' ? window.isImageLink : null;
    const resolveFxFn = typeof window.resolveFxValue === 'function' ? window.resolveFxValue : null;

    const youtubeId = parseYouTubeFn ? mediaLinks.map(parseYouTubeFn).find(Boolean) : null;
    const videoUrl = isVideoLinkFn ? mediaLinks.find(isVideoLinkFn) : null;
    const imageUrl = isImageLinkFn ? mediaLinks.find(isImageLinkFn) : null;

    if (!videoUrl && !imageUrl) return null;

    let mediaHash = '';
    const mediaMirrors = [];
    if (Array.isArray(event.tags)) {
      event.tags.forEach((tag) => {
        if (Array.isArray(tag) && tag[0] === 'media' && tag[2]) {
          const tagUrl = tag[2];
          const tagHash = tag[3] || '';
          if (tagUrl === videoUrl && tagHash) {
            mediaHash = tagHash;
          }
        }
        if (Array.isArray(tag) && tag[0] === 'mirror' && tag[1]) {
          mediaMirrors.push(tag[1]);
        }
      });
    }

    return {
      id: event.id,
      pubkey: event.pubkey,
      content: textLines.join(' '),
      youtubeId: youtubeId || null,
      videoUrl: videoUrl || null,
      imageUrl: imageUrl || null,
      hash: mediaHash || '',
      mirrors: mediaMirrors,
      fx: resolveFxFn ? resolveFxFn(event, imageUrl) : null,
      createdAt: event.created_at || 0,
    };
  };
})(window);
