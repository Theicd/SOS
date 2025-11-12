(function initStorageConfig(window) {
  if (!window.NostrTools) {
    console.error('NostrTools not loaded before storage/config.js');
    return;
  }

  const { utils, finalizeEvent, generateSecretKey, getPublicKey } = window.NostrTools;
  const bytesToHex = utils?.bytesToHex || ((arr) => Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join(''));
  const hexToBytes = utils?.hexToBytes || ((hex) => {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (clean.length % 2 !== 0) throw new Error('Invalid hex length');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
      out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
    }
    return out;
  });

  const defaultProfile = {
    name: 'משתמש אנונימי',
    bio: 'שיתוף מדיה מבוזר במהירות',
    avatarInitials: 'AN',
    picture: '',
  };

  let storedProfile = window.localStorage.getItem('nostr_profile');
  let profile;
  try {
    profile = storedProfile ? JSON.parse(storedProfile) : defaultProfile;
  } catch (err) {
    console.warn('Failed to parse stored profile, using default', err);
    profile = defaultProfile;
  }

  const App = window.NostrApp || {};
  App.relayUrls = App.relayUrls || [
    'wss://relay.damus.io',
    'wss://relay.snort.social',
    'wss://nos.lol',
    'wss://purplerelay.com',
    'wss://relay.nostr.band',
  ];
  App.NETWORK_TAG = App.NETWORK_TAG || 'israel-network';
  App.syncApiBase = App.syncApiBase || 'http://localhost:4300';
  App.EMAIL_REGISTRY_KIND = App.EMAIL_REGISTRY_KIND || 37377;
  App.EMAIL_REGISTRY_TAG = App.EMAIL_REGISTRY_TAG || 'email-registry';
  App.EMAIL_REGISTRY_HASH_TAG = App.EMAIL_REGISTRY_HASH_TAG || 'h';
  App.identityAdminPrivateKey = App.identityAdminPrivateKey || '';
  App.MAX_INLINE_PICTURE_LENGTH = App.MAX_INLINE_PICTURE_LENGTH || 150000;
  App.MAX_METADATA_CONTENT_LENGTH = App.MAX_METADATA_CONTENT_LENGTH || 60000;
  App.MAX_INLINE_MEDIA_LENGTH = App.MAX_INLINE_MEDIA_LENGTH || 150000;
  App.MAX_TEXT_CONTENT_LENGTH = App.MAX_TEXT_CONTENT_LENGTH || 8000;
  App.metadataPublishQueued = App.metadataPublishQueued || false;
  App.profile = App.profile || profile;
  App.profileCache = App.profileCache || new Map();
  App.privateKey = App.privateKey || window.localStorage.getItem('nostr_private_key');
  App.communityKeyBase64 = App.communityKeyBase64 || window.localStorage.getItem('nostr_community_key') || '';
  App.communityPassphrase = App.communityPassphrase || window.localStorage.getItem('nostr_community_passphrase') || App.COMMUNITY_CONTEXT;
  App.pool = App.pool || null;
  App.bytesToHex = bytesToHex;
  App.hexToBytes = hexToBytes;
  App.finalizeEvent = App.finalizeEvent || finalizeEvent;
  App.generateSecretKey = App.generateSecretKey || generateSecretKey;
  App.getPublicKey = App.getPublicKey || getPublicKey;
  App.ENCRYPTED_CHANNEL_KIND = App.ENCRYPTED_CHANNEL_KIND || 4;
  App.COMMUNITY_CONTEXT = App.COMMUNITY_CONTEXT || 'yalacommunity';

  const adminSourceKeys = ['8c60929899e0009f199b3865a7a5e7ba483fec60ff3c926169d0a4588ada256a'];
  App.adminPublicKeys = App.adminPublicKeys || new Set();
  adminSourceKeys.forEach((rawKey) => {
    if (typeof rawKey !== 'string') {
      return;
    }
    const trimmed = rawKey.trim().toLowerCase();
    if (!trimmed) {
      return;
    }
    let candidate = trimmed;
    if (trimmed.length === 64 && typeof App.getPublicKey === 'function') {
      try {
        candidate = App.getPublicKey(trimmed) || trimmed;
      } catch (err) {
        console.warn('Admin key derivation failed', err);
      }
    }
    if (typeof candidate === 'string' && candidate.length === 64) {
      App.adminPublicKeys.add(candidate.toLowerCase());
    }
  });

  window.NostrApp = App;
})();
