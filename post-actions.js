;(function initPostActions(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  function ensureFunction(fnName) {
    if (typeof App[fnName] === 'function') {
      return App[fnName].bind(App);
    }
    return () => {
      console.warn(`${fnName} is not available on NostrApp`);
    };
  }

  const handlers = {
    likePost: ensureFunction('likePost'),
    sharePost: ensureFunction('sharePost'),
    deletePost: ensureFunction('deletePost'),
  };

  window.likePost = handlers.likePost;
  window.sharePost = handlers.sharePost;
  window.deletePost = handlers.deletePost;

  Object.assign(App, handlers);
})(window);
