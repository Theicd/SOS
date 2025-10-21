(function initMedia(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  function embedYouTube(node) {
    if (!node || node.dataset.embedded === 'true') {
      return;
    }
    const videoId = node.dataset.youtubeId;
    if (!videoId) {
      return;
    }
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`;
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.allowFullscreen = true;
    iframe.title = 'YouTube video player';
    iframe.loading = 'lazy';
    iframe.className = 'feed-media__player';

    node.innerHTML = '';
    node.appendChild(iframe);
    node.dataset.embedded = 'true';
  }

  function enhanceYouTubePlayers(root = document) {
    const nodes = root.querySelectorAll('.feed-media--youtube');
    nodes.forEach((node) => {
      if (node.dataset.listenerAttached === 'true') {
        return;
      }
      node.dataset.listenerAttached = 'true';
      node.addEventListener('click', () => embedYouTube(node));
    });
  }

  function initObservers() {
    enhanceYouTubePlayers();
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) {
            return;
          }
          if (node.classList?.contains('feed-media--youtube')) {
            enhanceYouTubePlayers(node.parentElement || node);
          } else {
            enhanceYouTubePlayers(node);
          }
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initObservers, { once: true });
  } else {
    initObservers();
  }

  Object.assign(App, {
    embedYouTube,
    enhanceYouTubePlayers,
  });
})(window);
