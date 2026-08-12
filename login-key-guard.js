;(function initLoginKeyGuard(window) {
  // חלק התחברות (login-key-guard.js) – חוסם רק מפתחות זמניים/אורח; כל מפתח מקורי תקין מתקבל | HYPER CORE TECH
  const App = window.NostrApp || (window.NostrApp = {});
  const GUEST_KEY_STORAGE = 'p2p_guest_keys';
  const TEMP_KEY_BLOCKLIST = 'sos_temp_login_blocklist';

  function normalizeHexKey(hex) {
    if (!hex || typeof hex !== 'string') return '';
    const trimmed = hex.trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : '';
  }

  function readJson(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  function rememberTemporaryPrivateKey(privateKeyHex) {
    const hex = normalizeHexKey(privateKeyHex);
    if (!hex) return;
    const list = Array.isArray(readJson(TEMP_KEY_BLOCKLIST, [])) ? readJson(TEMP_KEY_BLOCKLIST, []) : [];
    if (!list.includes(hex)) {
      list.push(hex);
      writeJson(TEMP_KEY_BLOCKLIST, list.slice(-50));
    }
  }

  function isTemporaryPrivateKey(privateKeyHex) {
    const hex = normalizeHexKey(privateKeyHex);
    if (!hex) return false;

    const blocklist = readJson(TEMP_KEY_BLOCKLIST, []);
    if (Array.isArray(blocklist) && blocklist.includes(hex)) return true;

    const guest = readJson(GUEST_KEY_STORAGE, null);
    if (guest && normalizeHexKey(guest.privateKey) === hex) return true;

    return false;
  }

  function hexToBytesLocal(hex) {
    const h = normalizeHexKey(hex);
    if (!h) return null;
    if (typeof App.hexToBytes === 'function') {
      try {
        return App.hexToBytes(h);
      } catch (_) {}
    }
    if (typeof window.NostrTools?.utils?.hexToBytes === 'function') {
      try {
        return window.NostrTools.utils.hexToBytes(h);
      } catch (_) {}
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
      out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function derivePublicKey(privateKeyHex) {
    const hex = normalizeHexKey(privateKeyHex);
    if (!hex) return '';
    const getPk = App.getPublicKey || window.NostrTools?.getPublicKey;
    if (typeof getPk !== 'function') return '';
    try {
      const bytes = hexToBytesLocal(hex);
      const pk = bytes ? getPk(bytes) : getPk(hex);
      return typeof pk === 'string' ? pk.toLowerCase() : '';
    } catch (err) {
      try {
        const pk2 = getPk(hex);
        return typeof pk2 === 'string' ? pk2.toLowerCase() : '';
      } catch (_) {
        console.warn('[LOGIN-GUARD] derivePublicKey failed', err);
        return '';
      }
    }
  }

  async function assertLoginPrivateKeyAllowed(privateKeyHex) {
    const hex = normalizeHexKey(privateKeyHex);
    if (!hex) {
      return { ok: false, error: 'המפתח לא תקין' };
    }

    if (isTemporaryPrivateKey(hex)) {
      return {
        ok: false,
        error: 'מפתח זמני לא מתאים להתחברות. השתמשו במפתח שקיבלתם ברישום.',
      };
    }

    const pubkey = derivePublicKey(hex);
    if (!pubkey) {
      return { ok: false, error: 'לא ניתן לחשב מפתח ציבורי מהמפתח שהוזן' };
    }

    return { ok: true, pubkey, privateKey: hex };
  }

  Object.assign(App, {
    rememberTemporaryPrivateKey,
    isTemporaryPrivateKey,
    assertLoginPrivateKeyAllowed,
  });
})(window);
