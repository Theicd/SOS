(function enforceAuth(window) {
  try {
    const hasKey = window.localStorage.getItem('nostr_private_key');
    if (!hasKey) {
      window.location.replace('auth.html');
    }
  } catch (err) {
    console.warn('Auth guard failed', err);
  }
})(window);
