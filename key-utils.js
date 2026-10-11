(function initKeyUtils(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  function getNip19() {
    return App.nip19 || window.NostrTools?.nip19 || null;
  }

  function encodePrivateKey(privateKey) {
    // חלק קידוד מפתחות (key-utils.js) – ממיר Hex למחרוזת nsec לתצוגה ידידותית
    const trimmed = (privateKey || '').trim();
    if (!trimmed) return '';
    const nip19 = getNip19();
    if (!nip19) return trimmed;
    const hexMatcher = /^[0-9a-fA-F]{64}$/;
    const hexToBytes = App.hexToBytes || window.NostrTools?.utils?.hexToBytes;
    try {
      if (hexMatcher.test(trimmed) && typeof hexToBytes === 'function') {
        const bytes = hexToBytes(trimmed);
        return nip19.nsecEncode(bytes);
      }
      return nip19.nsecEncode(trimmed);
    } catch (err) {
      console.warn('Failed to encode nsec', err);
      return trimmed;
    }
  }

  function decodePrivateKey(value) {
    // חלק פענוח מפתחות (key-utils.js) – ממיר nsec או Hex למפתח פרטי תקין
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const nip19 = getNip19();
    const bytesToHex = App.bytesToHex || window.NostrTools?.utils?.bytesToHex;

    if (trimmed.startsWith('nsec') && nip19) {
      try {
        const decoded = nip19.decode(trimmed);
        if (decoded?.type === 'nsec') {
          if (typeof decoded.data === 'string' && /^[0-9a-fA-F]{64}$/.test(decoded.data)) {
            return decoded.data.toLowerCase();
          }
          const bytes =
            decoded.data instanceof Uint8Array
              ? decoded.data
              : Array.isArray(decoded.data)
                ? Uint8Array.from(decoded.data)
                : null;
          if (bytes && bytes.length === 32) {
            if (typeof bytesToHex === 'function') {
              return bytesToHex(bytes).toLowerCase();
            }
            // Fallback when NostrTools.utils.bytesToHex is unavailable (some WebView loads).
            let hex = '';
            for (let i = 0; i < bytes.length; i++) {
              hex += bytes[i].toString(16).padStart(2, '0');
            }
            return hex;
          }
        }
      } catch (err) {
        console.warn('nsec decode failed', err);
      }
    }

    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    return null;
  }

  function encodePublicKey(pubkey) {
    const trimmed = (pubkey || '').trim();
    if (!trimmed) return '';
    const nip19 = getNip19();
    if (!nip19) return trimmed;
    try {
      return nip19.npubEncode(trimmed);
    } catch (err) {
      console.warn('Failed to encode npub', err);
      return trimmed;
    }
  }

  function decodePublicKey(value) {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const nip19 = getNip19();

    if (trimmed.startsWith('npub') && nip19) {
      try {
        const decoded = nip19.decode(trimmed);
        if (decoded?.type === 'npub') {
          return typeof decoded.data === 'string' ? decoded.data : null;
        }
      } catch (err) {
        console.warn('npub decode failed', err);
      }
    }

    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return trimmed.toLowerCase();
    }

    return null;
  }

  Object.assign(App, {
    encodePrivateKey,
    decodePrivateKey,
    encodePublicKey,
    decodePublicKey,
  });
})(window);
