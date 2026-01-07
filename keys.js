(function initKeys(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const tools = window.NostrTools || {};
  const { generateSecretKey, getPublicKey } = tools;
  const { bytesToHex, hexToBytes } = App;

  function normalizePrivateKey(storedKey) {
    if (!storedKey) return null;
    let key = storedKey.trim();
    if (key.startsWith('0x')) key = key.slice(2);

    if (key.includes(',')) {
      const bytes = key
        .split(',')
        .map(Number)
        .filter((n) => !Number.isNaN(n));
      if (bytes.length === 32 && typeof bytesToHex === 'function') {
        key = bytesToHex(Uint8Array.from(bytes));
        window.localStorage.setItem('nostr_private_key', key);
      }
    }

    if (key.length !== 64 && typeof hexToBytes === 'function') {
      try {
        const bytes = hexToBytes(key);
        if (bytes.length === 32) {
          key = bytesToHex(bytes);
          window.localStorage.setItem('nostr_private_key', key);
        }
      } catch (err) {
        console.warn('Private key normalization failed', err);
        return null;
      }
    }

    if (key && key.length === 64) {
      // חלק ניהול מפתחות (keys.js) – מבטיח שכל המפתחות ישמרו בפורמט אחיד של אותיות קטנות
      key = key.toLowerCase();
      window.localStorage.setItem('nostr_private_key', key);
    }

    return key;
  }

  function generateAndStoreKey() {
    if (typeof generateSecretKey !== 'function') {
      throw new Error('generateSecretKey missing from NostrTools');
    }
    const generated = generateSecretKey();
    const normalized = bytesToHex
      ? bytesToHex(generated)
      : Array.from(generated)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
    const lowercase = normalized.toLowerCase();
    // חלק ניהול מפתחות (keys.js) – שומר מפתחות חדשים בפורמט אחיד כדי למנוע בעיות זהות
    window.localStorage.setItem('nostr_private_key', lowercase);
    return lowercase;
  }

  function ensureKeys() {
    // חלק ניהול מפתחות (keys.js) – תחילה מנסה לנרמל את המפתח הקיים בזיכרון היישום
    let privateKey = normalizePrivateKey(App.privateKey);
    // חלק ניהול מפתחות (keys.js) – אם אין מפתח בזיכרון, מנסה לטעון אותו ישירות מ-localStorage
    if (!privateKey) {
      const storedKey = window.localStorage.getItem('nostr_private_key');
      privateKey = normalizePrivateKey(storedKey);
    }
    if (!privateKey) {
      privateKey = generateAndStoreKey();
    }

    if (privateKey && privateKey.length === 64) {
      // חלק ניהול מפתחות (keys.js) – מבטיח שגם בזיכרון היישום נשתמש בפורמט אחיד
      privateKey = privateKey.toLowerCase();
      window.localStorage.setItem('nostr_private_key', privateKey);
    }

    let publicKey;
    try {
      publicKey = getPublicKey(privateKey);
    } catch (err) {
      console.warn('Invalid private key detected, regenerating...', err);
      privateKey = generateAndStoreKey();
      publicKey = getPublicKey(privateKey);
    }

    if (typeof publicKey === 'string') {
      // חלק ניהול מפתחות (keys.js) – מבטיח שזיהוי המשתמש יישאר עקבי בין הפידים לממשק
      publicKey = publicKey.toLowerCase();
    }

    App.privateKey = privateKey;
    App.publicKey = publicKey;
    return { privateKey, publicKey };
  }

  App.normalizePrivateKey = normalizePrivateKey;
  App.generateAndStoreKey = generateAndStoreKey;
  App.ensureKeys = ensureKeys;
})(window);
