/**
 * Account session resolver.
 * PRIMARY_ACCOUNT holds Root K. LINKED_DEVICE holds a verified MD3 and device keys.
 * GUEST has neither. Device signatures are never treated as Root-P signatures.
 */
(function initSosAccountSession(root) {
  'use strict';

  const App = root.NostrApp || (root.NostrApp = {});
  const HIST_KIND = 1050;
  const HIST_TAG = 'sos-hist-v1';
  const HIST_REQ_TAG = 'sos-hist-req';
  const HIST_ACK_TAG = 'sos-hist-ack';
  const HIST_MEDIA_CHUNK = 6000;
  const HIST_MEDIA_MAX = 4 * 1024 * 1024;
  const HIST_MEDIA_STREAM_MAX = 32 * 1024 * 1024;
  const HIST_RELAY_MEDIA_MAX = 7000;
  const HIST_PAGE_BUDGET = 10000;
  const HIST_PAGE_MAX = 15000;
  const HIST_RECENT_SEC = 72 * 3600;
  const HIST_OLDER_SEC = 7 * 86400;

  const OPS = {
    VIEW_PRIVATE_UI: 'VIEW_PRIVATE_UI',
    VIEW_PROFILE: 'VIEW_PROFILE',
    READ_CONVERSATIONS: 'READ_CONVERSATIONS',
    SEND_CHAT: 'SEND_CHAT',
    READ_RECEIPTS: 'READ_RECEIPTS',
    START_CALL: 'START_CALL',
    RECEIVE_CALL: 'RECEIVE_CALL',
    SHARE_URL: 'SHARE_URL',
    SHARE_REPOST: 'SHARE_REPOST',
    REACT: 'REACT',
    POST: 'POST',
    MANAGE_SECURITY: 'MANAGE_SECURITY',
  };

  const LINKED_CAP = {
    VIEW_PRIVATE_UI: null,
    VIEW_PROFILE: null,
    READ_CONVERSATIONS: 'DEVICE_CHAT',
    SEND_CHAT: 'DEVICE_CHAT',
    READ_RECEIPTS: 'DEVICE_RECEIPTS',
    START_CALL: 'DEVICE_CALLS',
    RECEIVE_CALL: 'DEVICE_CALLS',
    SHARE_URL: null,
    SHARE_REPOST: false,
    REACT: false,
    POST: false,
    MANAGE_SECURITY: false,
  };

  let snapshot = {
    role: 'GUEST',
    verified: false,
    accountP: '',
    deviceSignPub: '',
    deviceId: '',
    caps: [],
    ROOT_K_PRESENT: false,
  };

  function norm(v) {
    return String(v || '').toLowerCase().replace(/^0x/, '').trim();
  }

  function isHex64(v) {
    return /^[0-9a-f]{64}$/.test(norm(v));
  }

  function primaryReady() {
    const signer = App.SosCryptoSigner;
    return !!(
      App.guestMode === false &&
      isHex64(App.publicKey) &&
      signer &&
      typeof signer.hasIdentityKey === 'function' &&
      signer.hasIdentityKey() === true &&
      App.linkedDeviceSession !== true
    );
  }

  function setGuest() {
    snapshot = {
      role: 'GUEST',
      verified: false,
      accountP: '',
      deviceSignPub: '',
      deviceId: '',
      caps: [],
      ROOT_K_PRESENT: false,
    };
    return snapshot;
  }

  function setPrimary() {
    snapshot = {
      role: 'PRIMARY_ACCOUNT',
      verified: true,
      accountP: norm(App.publicKey),
      deviceSignPub: '',
      deviceId: '',
      caps: [],
      ROOT_K_PRESENT: true,
    };
    return snapshot;
  }

  function adoptVerified(info) {
    const accountP = norm(info && info.accountP);
    const deviceSignPub = norm(info && info.deviceSignPub);
    const deviceId = norm(info && info.deviceId);
    const caps = Array.isArray(info && info.caps) ? info.caps.map(String) : [];
    if (!isHex64(accountP) || !isHex64(deviceSignPub)) return setGuest();
    snapshot = {
      role: 'LINKED_DEVICE',
      verified: true,
      accountP: accountP,
      deviceSignPub: deviceSignPub,
      deviceId: deviceId,
      caps: caps,
      ROOT_K_PRESENT: false,
    };
    App.publicKey = accountP;
    App.privateKey = null;
    App.guestMode = false;
    App.linkedDeviceSession = true;
    App.identityState = 'LINKED_DEVICE';
    queueMicrotask(function () {
      if (typeof App.loadOwnProfileMetadata !== 'function') return;
      Promise.resolve(App.loadOwnProfileMetadata()).then(function () {
        if (typeof App.renderProfile === 'function') App.renderProfile();
      }).catch(function () {});
    });
    return snapshot;
  }

  function getAccountSession() {
    if (snapshot.role === 'LINKED_DEVICE' && snapshot.verified) return snapshot;
    if (primaryReady()) return setPrimary();
    if (snapshot.role === 'PRIMARY_ACCOUNT') return setGuest();
    return snapshot;
  }

  function allows(op) {
    const session = getAccountSession();
    const name = String(op || OPS.VIEW_PRIVATE_UI);
    if (session.role === 'PRIMARY_ACCOUNT') return name !== OPS.MANAGE_SECURITY ? true : true;
    if (session.role !== 'LINKED_DEVICE' || session.verified !== true) return false;
    if (!Object.prototype.hasOwnProperty.call(LINKED_CAP, name)) return false;
    const need = LINKED_CAP[name];
    if (need === false) return false;
    if (need == null) return true;
    return session.caps.indexOf(need) !== -1;
  }

  function opForPrompt(text) {
    const t = String(text || '');
    if (/פרופיל/.test(t)) return OPS.VIEW_PROFILE;
    if (/הודע|צ׳אט|צ'אט|לחבר/.test(t)) return OPS.SEND_CHAT;
    if (/שיחה|קול|וידאו/.test(t)) return OPS.START_CALL;
    if (/לשתף בפיד/.test(t)) return OPS.SHARE_REPOST;
    if (/לייק|תגובה|פוסט|פרסם|שידור|למחוק|לדווח/.test(t)) return OPS.REACT;
    return OPS.VIEW_PRIVATE_UI;
  }

  function showLinkedDenial() {
    let box = document.getElementById('sosLdCapabilityDenied');
    if (!box) {
      box = document.createElement('div');
      box.id = 'sosLdCapabilityDenied';
      box.setAttribute('role', 'status');
      box.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:12050;background:#141414;color:#f5f5f5;border-radius:12px;padding:12px 16px;max-width:min(420px,92vw);text-align:center;font-size:14px;';
      document.body.appendChild(box);
    }
    box.textContent = 'הפעולה הזו נשארת בטלפון שמחזיק את מפתח החשבון.';
    clearTimeout(showLinkedDenial._t);
    showLinkedDenial._t = setTimeout(function () {
      if (box && box.parentNode) box.parentNode.removeChild(box);
    }, 2800);
  }

  async function restoreVerifiedLinkedDevice() {
    if (primaryReady()) return setPrimary();
    const Store = App.Md4DeviceStore || root.SosMd4DeviceStore;
    const Auth = App.Md4DeviceAuth || root.SosMd4DeviceAuth;
    if (!Store || typeof Store.loadLatest !== 'function' || !Auth || typeof Auth.verifyForDestination !== 'function') {
      return getAccountSession();
    }
    let loaded;
    try {
      loaded = await Store.loadLatest();
    } catch (_e) {
      return setGuest();
    }
    if (!loaded || loaded.ok !== true || !loaded.authorization) return setGuest();
    const verified = await Auth.verifyForDestination(loaded.authorization, {
      accountP: loaded.accountP,
      deviceId: loaded.deviceId,
      D_sign_pub: loaded.D_sign_pub,
      D_enc_pub: loaded.D_enc_pub,
    }, Date.now(), { requireHistorySync: false });
    if (!verified || verified.ok !== true) return setGuest();
    const caps = Array.isArray(loaded.authorization.capabilities) ? loaded.authorization.capabilities.map(String) : [];
    return adoptVerified({
      accountP: loaded.accountP,
      deviceSignPub: loaded.D_sign_pub,
      deviceId: loaded.deviceId,
      caps: caps,
    });
  }

  function readMd3Tag(event) {
    const tags = event && event.tags;
    if (!Array.isArray(tags)) return null;
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      if (Array.isArray(t) && t[0] === 'sos-md3' && typeof t[1] === 'string') {
        try { return JSON.parse(t[1]); } catch (_e) { return null; }
      }
    }
    return null;
  }

  function plainEvent(event) {
    if (!event || typeof event !== 'object') return null;
    try {
      return {
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: JSON.parse(JSON.stringify(event.tags || [])),
        content: event.content,
        sig: event.sig,
      };
    } catch (_e) {
      return null;
    }
  }

  function verifyEventPlain(event) {
    const NT = root.NostrTools;
    if (!NT || typeof NT.verifyEvent !== 'function') return { ok: false, code: 'VERIFY_UNAVAILABLE' };
    const copy = plainEvent(event);
    if (!copy || typeof copy.sig !== 'string' || typeof copy.id !== 'string') return { ok: false, code: 'BAD_EVENT' };
    try {
      if (typeof NT.getEventHash === 'function') {
        const hash = NT.getEventHash(copy);
        if (typeof hash === 'string' && hash.toLowerCase() !== String(copy.id).toLowerCase()) {
          return { ok: false, code: 'HASH_MISMATCH' };
        }
      }
    } catch (_hash) {
      return { ok: false, code: 'HASH_THREW' };
    }
    try {
      if (NT.verifyEvent(copy) === true) return { ok: true, code: 'OK' };
      return { ok: false, code: 'BAD_EVENT_SIG' };
    } catch (_verify) {
      return { ok: false, code: 'VERIFY_THREW' };
    }
  }

  async function verifyDelegatedEvent(event, requiredCap) {
    if (!event || typeof event !== 'object') return { ok: false, code: 'BAD_EVENT' };
    const auth = readMd3Tag(event);
    if (!auth) return { ok: false, code: 'NO_DELEGATION' };
    const Auth = App.Md4DeviceAuth || root.SosMd4DeviceAuth;
    if (!Auth || typeof Auth.verifyForDestination !== 'function') return { ok: false, code: 'AUTH_MODULE_MISSING' };
    const verified = await Auth.verifyForDestination(auth, {
      accountP: auth.accountP,
      deviceId: auth.deviceId,
      D_sign_pub: auth.D_sign_pub || auth.dSignPub,
      D_enc_pub: auth.D_enc_pub || auth.dEncPub,
    }, Date.now(), { requireHistorySync: false });
    if (!verified || verified.ok !== true) return { ok: false, code: (verified && verified.code) || 'DELEGATION_REJECTED' };
    const devicePub = norm(auth.D_sign_pub || auth.dSignPub);
    if (norm(event.pubkey) !== devicePub) return { ok: false, code: 'DEVICE_PUB_MISMATCH' };
    const sig = verifyEventPlain(event);
    if (!sig.ok) return { ok: false, code: 'BAD_EVENT_SIG', detail: sig.code || 'BAD_EVENT_SIG' };
    const rev = await loadRevocations(norm(auth.accountP));
    if (isRevokedDevice(rev, { deviceSignPub: devicePub, authorizationId: norm(auth.authorizationId) })) {
      return { ok: false, code: 'DEVICE_REVOKED' };
    }
    const caps = Array.isArray(auth.capabilities) ? auth.capabilities.map(String) : [];
    if (requiredCap && caps.indexOf(requiredCap) === -1) return { ok: false, code: 'CAPABILITY_MISSING' };
    noteVerifiedDevice(devicePub, auth.accountP);
    return { ok: true, accountP: norm(auth.accountP), deviceSignPub: devicePub, caps: caps };
  }

  function noteVerifiedDevice(devicePub, accountP) {
    const device = norm(devicePub);
    const account = norm(accountP);
    if (!isHex64(device) || !isHex64(account) || device === account) return;
    const map = root.__sosVerifiedDeviceOwners || (root.__sosVerifiedDeviceOwners = {});
    map[device] = account;
    if (typeof App.mergeDeviceConversationIntoAccount === 'function') {
      try { App.mergeDeviceConversationIntoAccount(device, account); } catch (_merge) {}
    }
  }

  function hexToBytes(hex) {
    const clean = norm(hex);
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
    return out;
  }

  async function withDevice(fn) {
    const LD = App.WebLinkedDevices || root.SosWebLinkedDevices;
    if (!LD || typeof LD.withLinkedDeviceSigner !== 'function') return { ok: false, code: 'NO_DEVICE' };
    return LD.withLinkedDeviceSigner(fn);
  }

  async function delegatedChatEncrypt(peer, text, messageId, extra) {
    const session = getAccountSession();
    if (!allows(OPS.SEND_CHAT)) return { ok: false, code: 'CAPABILITY_DENIED' };
    const opts = extra && typeof extra === 'object' ? extra : {};
    const deviceCopy = opts.deviceCopy === true;
    const devicePub = norm(opts.devicePub || '');
    const deviceEncPub = norm(opts.deviceEncPub || '');
    if (deviceCopy) {
      if (!isHex64(devicePub)) return { ok: false, code: 'BAD_DEVICE' };
      if (deviceEncPub && deviceEncPub === devicePub) return { ok: false, code: 'D_ENC_NOT_CHAT_RECIPIENT' };
    }
    const sibling = opts.sibling === true && !deviceCopy;
    const deliverTo = deviceCopy ? devicePub : (sibling ? session.accountP : norm(peer));
    if (!isHex64(deliverTo)) return { ok: false, code: 'BAD_RECIPIENT' };
    return withDevice(async function (dev) {
      const createdAt = Math.floor(Date.now() / 1000);
      const env = App.encryptPrivateChatPayload({
        senderPrivateKeyHex: dev.privHex,
        senderPubkey: dev.pub,
        recipientPubkey: deliverTo,
        payload: {
          messageId: messageId || ('ld-' + createdAt),
          sender: dev.pub,
          recipient: deliverTo,
          createdAt: createdAt,
          text: text,
          attachment: opts.attachment || null,
        },
      });
      const NT = root.NostrTools;
      if (!NT || typeof NT.finalizeEvent !== 'function') return { ok: false, code: 'FINALIZE_UNAVAILABLE' };
      const tags = [
        ['p', deliverTo],
        ['t', 'yalachat'],
        ['sos-md3', JSON.stringify(dev.authorization)],
      ];
      if (Array.isArray(opts.extraTags)) {
        opts.extraTags.forEach(function (tag) {
          if (Array.isArray(tag) && tag.length >= 2) tags.push(tag);
        });
      }
      if (deviceCopy) {
        tags.push(['t', 'sos-device-copy']);
        if (messageId) tags.push(['e', String(messageId).slice(0, 80)]);
        if (opts.mirror === 'outgoing' && isHex64(norm(peer))) {
          tags.push(['t', 'sos-sibling-sync']);
          tags.push(['sync-peer', norm(peer)]);
        }
      } else if (sibling) {
        tags.push(['t', 'sos-sibling-sync']);
        tags.push(['sync-peer', norm(peer)]);
      }
      const draft = {
        kind: 1050,
        created_at: createdAt,
        pubkey: dev.pub,
        tags: tags,
        content: JSON.stringify(env),
      };
      const event = NT.finalizeEvent(draft, hexToBytes(dev.privHex));
      if (!event || norm(event.pubkey) !== dev.pub) return { ok: false, code: 'SIGN_FAILED' };
      const signed = verifyEventPlain(event);
      if (!signed.ok) return { ok: false, code: 'BAD_EVENT_SIG', detail: signed.code || 'BAD_EVENT_SIG' };
      return { ok: true, event: event, accountP: session.accountP, deviceSignPub: dev.pub };
    });
  }

  async function decryptForLinkedDevice(event, envelope, selfAuthored, intendedRecipient) {
    return withDevice(async function (dev) {
      const inner = App.decryptPrivateChatPayload({
        localPrivateKeyHex: dev.privHex,
        localPubkey: dev.pub,
        eventAuthorPubkey: event.pubkey,
        encryptedEnvelope: envelope,
        selfAuthored: selfAuthored === true,
        intendedRecipientPubkey: intendedRecipient,
      });
      return { ok: true, payload: inner, deviceSignPub: dev.pub, accountP: dev.accountP };
    });
  }

  function bytesToB64(bytes) {
    let out = '';
    const block = 0x8000;
    for (let i = 0; i < bytes.length; i += block) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + block)));
    }
    return btoa(out);
  }

  function b64ToBytes(b64) {
    const bin = atob(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function historyHost() {
    const wide = typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 901px)').matches;
    if (wide) return document.querySelector('.chat-sidebar-header__group') || document.querySelector('.chat-sidebar-header');
    return document.querySelector('.chat-contacts__top') || document.querySelector('.chat-sidebar-header__group');
  }

  function historyBytes(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
    if (v >= 1024) return Math.round(v / 1024) + ' KB';
    return String(v) + ' B';
  }

  function historyJobSettled(book) {
    if (!book || !book.snapshotId) return false;
    const messages = Number(book.messageCount) || 0;
    const got = Number(book.count) || 0;
    if (messages > 0 && got < messages) return false;
    if (messages === 0 && got === 0 && !(book.seen && book.seen[0] === true)) return false;
    const available = Number(book.attachmentCount) || 0;
    const persisted = Number(book.filesDone) || 0;
    const failed = Array.isArray(book.missingFiles) ? book.missingFiles.length : 0;
    return persisted + failed >= available;
  }

  function historyMissingCount(book) {
    const listed = Array.isArray(book && book.sourceMissing) ? book.sourceMissing.length : (Number(book && book.unavailable) || 0);
    const failed = Array.isArray(book && book.missingFiles) ? book.missingFiles.length : 0;
    return listed + failed;
  }

  function markHistoryTerminal(book) {
    if (!historyJobSettled(book)) return false;
    const missing = historyMissingCount(book);
    const state = missing > 0 ? 'COMPLETE_WITH_MISSING' : 'COMPLETE';
    if (book.terminal === state) return true;
    book.terminal = state;
    book.uiFull = state === 'COMPLETE';
    book.waitingDevice = false;
    book.retrying = false;
    root.__sosHistSyncActive = false;
    root.__sosFullBackupComplete = false;
    const peers = root.__sosHistPeer || {};
    Object.keys(peers).forEach(function (peer) {
      const row = peers[peer];
      if (row && row.timer) { clearTimeout(row.timer); row.timer = null; }
    });
    root.__sosHistTerminal = {
      state: state,
      snapshotId: book.snapshotId || '',
      messages: book.count || 0,
      files: book.filesDone || 0,
      missing: missing,
      bytes: book.verifiedBytes || 0,
      at: Date.now(),
    };
    try {
      console.log('SYNC_TERMINAL_RECORDED state=' + state + ' snapshot=' + String(book.snapshotId || '').slice(0, 8) + ' messages=' + (book.count || 0) + ' files=' + (book.filesDone || 0) + ' missing=' + missing + ' bytes=' + (book.verifiedBytes || 0));
    } catch (_t) {}
    return true;
  }

  function historyState(book) {
    const messages = Number(book.messageCount) || 0;
    const gotMessages = Number(book.count) || 0;
    const files = Number(book.attachmentCount) || 0;
    const gotFiles = Number(book.filesDone) || 0;
    if (book.uiFailed === true) return 'FAILED';
    if (book.terminal === 'COMPLETE_WITH_MISSING' && historyMissingCount(book) === 0 && historyJobSettled(book)) book.terminal = '';
    if (book.terminal === 'COMPLETE' || book.terminal === 'COMPLETE_WITH_MISSING' || book.terminal === 'FAILED') return book.terminal;
    if (historyJobSettled(book)) {
      markHistoryTerminal(book);
      return book.terminal || 'COMPLETE';
    }
    if (root.__sosPageSuspended === true) return 'PAUSED';
    if (book.retrying === true) return 'RETRY_SCHEDULED';
    if (book.waitingDevice === true && gotFiles < files) return 'WAITING_FOR_DEVICE';
    if (gotFiles > 0 && gotFiles < files) return 'TRANSFERRING';
    if (gotMessages > 0 && gotMessages < messages) return 'VERIFYING';
    if (messages > 0 || files > 0) return 'TRANSFERRING';
    return 'PREPARING';
  }

  function historyProgress(book) {
    const old = document.getElementById('sosHistorySyncProgress');
    if (old && old.getAttribute('data-sos-floating') === '1' && old.parentNode) old.parentNode.removeChild(old);
    if (!book) return;
    const state = historyState(book);
    const terminal = state === 'COMPLETE' || state === 'COMPLETE_WITH_MISSING';
    if (book.dismissed === true && book.dismissedSnapshot === book.snapshotId && terminal) return;
    const host = historyHost();
    let box = document.getElementById('sosHistorySyncProgress');
    if (!box || box.getAttribute('data-sos-floating') === '1') {
      box = document.createElement('button');
      box.type = 'button';
      box.id = 'sosHistorySyncProgress';
      box.className = 'sos-hist-indicator';
    }
    if (host && box.parentElement !== host) host.appendChild(box);
    const labels = {
      PREPARING: 'מכין סנכרון',
      TRANSFERRING: 'מעביר היסטוריה',
      VERIFYING: 'מאמת היסטוריה',
      WAITING_FOR_DEVICE: 'ממתין למכשיר',
      RETRY_SCHEDULED: 'ממתין לניסיון נוסף',
      COMPLETE: '72 השעות האחרונות סונכרנו',
      COMPLETE_WITH_MISSING: 'חלק מהקבצים לא זמינים במכשיר',
      PAUSED: 'הסנכרון מושהה',
      FAILED: 'הסנכרון נעצר',
    };
    const messages = Number(book.messageCount) || 0;
    const gotMessages = Number(book.count) || 0;
    const files = Number(book.attachmentCount) || 0;
    const gotFiles = Number(book.filesDone) || 0;
    const totalBytes = Number(book.totalBytes) || 0;
    const verifiedBytes = Number(book.verifiedBytes) || 0;
    const knownBytes = totalBytes > 0;
    const percent = knownBytes ? Math.max(0, Math.min(100, Math.round((verifiedBytes / totalBytes) * 100))) : 0;
    const speed = Number(book.bytesPerSec) || 0;
    const speedText = speed > 0 ? (speed / 1048576).toFixed(2) + ' MB/s' : '';
    const missingCount = historyMissingCount(book);
    const spinning = state === 'PREPARING' || state === 'TRANSFERRING' || state === 'VERIFYING' || state === 'RETRY_SCHEDULED';
    box.setAttribute('role', 'progressbar');
    box.setAttribute('aria-label', (labels[state] || labels.TRANSFERRING) + (knownBytes ? (' ' + percent + '%') : ''));
    if (knownBytes) {
      box.setAttribute('aria-valuemin', '0');
      box.setAttribute('aria-valuemax', '100');
      box.setAttribute('aria-valuenow', String(terminal ? 100 : percent));
    } else {
      box.removeAttribute('aria-valuenow');
    }
    box.classList.toggle('is-indeterminate', spinning && !knownBytes);
    box.classList.toggle('is-complete', state === 'COMPLETE');
    box.classList.toggle('is-missing', state === 'COMPLETE_WITH_MISSING');
    box.classList.toggle('is-waiting', state === 'WAITING_FOR_DEVICE' || state === 'PAUSED');
    box.classList.toggle('is-failed', state === 'FAILED');
    const inHeader = !!(host && (host.classList.contains('chat-sidebar-header__group') || host.classList.contains('chat-contacts__top') || host.classList.contains('chat-sidebar-header')));
    root.__sosHistUi = {
      state: state,
      inHeader: inHeader,
      percent: knownBytes ? percent : null,
      messages: gotMessages,
      files: gotFiles,
      missing: missingCount,
      bytes: verifiedBytes,
      terminal: terminal,
    };
    const ring = 75.4;
    const drawn = knownBytes ? Math.max(2, (percent / 100) * ring) : ring * 0.28;
    box.innerHTML = '<svg class="sos-hist-ring" viewBox="0 0 32 32" aria-hidden="true"><circle class="sos-hist-ring__track" cx="16" cy="16" r="12"></circle><circle class="sos-hist-ring__value" cx="16" cy="16" r="12"></circle></svg><span class="sos-hist-indicator__icon" aria-hidden="true"></span>';
    const value = box.querySelector('.sos-hist-ring__value');
    if (value) value.style.strokeDasharray = drawn + ' ' + ring;
    let panel = document.getElementById('sosHistorySyncDetails');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'sosHistorySyncDetails';
      panel.className = 'sos-hist-details';
      panel.hidden = true;
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'פרטי סנכרון');
      document.body.appendChild(panel);
    }
    const missing = [].concat(Array.isArray(book.sourceMissing) ? book.sourceMissing : [], Array.isArray(book.missingFiles) ? book.missingFiles : []);
    panel.innerHTML = '<p class="sos-hist-details__title"></p><ul class="sos-hist-details__list"></ul>';
    panel.querySelector('.sos-hist-details__title').textContent = labels[state] || '';
    const list = panel.querySelector('.sos-hist-details__list');
    [
      'מצב: ' + state,
      'הודעות מאומתות: ' + gotMessages + ' מתוך ' + messages,
      'קבצים שאומתו: ' + gotFiles + ' מתוך ' + files,
      'בתים: ' + historyBytes(verifiedBytes) + (knownBytes ? (' מתוך ' + historyBytes(totalBytes)) : ''),
      'קבצים חסרים: ' + missingCount,
      speedText ? ('מהירות: ' + speedText) : '',
      missing.length ? ('סיבות: ' + missing.slice(0, 6).map(function (row) { return String(row.fileId || row.id || '').slice(0, 16) + ' ' + (row.reason || ''); }).join(', ')) : '',
    ].forEach(function (line) {
      if (!line) return;
      const item = document.createElement('li');
      item.textContent = line;
      list.appendChild(item);
    });
    box.onclick = function (event) {
      event.preventDefault();
      event.stopPropagation();
      const rect = box.getBoundingClientRect();
      panel.hidden = !panel.hidden;
      panel.style.top = Math.round(rect.bottom + 8) + 'px';
      panel.style.left = Math.max(8, Math.round(Math.min(rect.left, window.innerWidth - 280))) + 'px';
    };
    if (terminal) {
      if (!box.__sosHideTimer) {
        box.__sosHideTimer = setTimeout(function () {
          book.dismissed = true;
          book.dismissedSnapshot = book.snapshotId || '';
          const live = document.getElementById('sosHistorySyncProgress');
          if (live && live.parentNode) live.parentNode.removeChild(live);
          const open = document.getElementById('sosHistorySyncDetails');
          if (open && open.parentNode) open.parentNode.removeChild(open);
        }, state === 'COMPLETE' ? 4000 : 6000);
      }
    } else if (box.__sosHideTimer) {
      clearTimeout(box.__sosHideTimer);
      box.__sosHideTimer = null;
    }
  }

  function historyMissReason(fileId) {
    const key = String(fileId || '').slice(0, 64);
    if (!key) return '';
    root.__sosHistMiss = root.__sosHistMiss || {};
    if (root.__sosHistMiss[key]) return root.__sosHistMiss[key];
    try {
      const saved = JSON.parse(localStorage.getItem('sos-hist-miss') || '{}');
      if (saved && saved[key]) {
        root.__sosHistMiss[key] = saved[key];
        return saved[key];
      }
    } catch (_e) {}
    return '';
  }

  function rememberHistoryMiss(fileId, reason) {
    const key = String(fileId || '').slice(0, 64);
    if (!key || !reason) return;
    root.__sosHistMiss = root.__sosHistMiss || {};
    root.__sosHistMiss[key] = reason;
    try {
      const saved = JSON.parse(localStorage.getItem('sos-hist-miss') || '{}');
      saved[key] = reason;
      const keys = Object.keys(saved);
      while (keys.length > 80) delete saved[keys.shift()];
      localStorage.setItem('sos-hist-miss', JSON.stringify(saved));
    } catch (_e) {}
  }

  function rememberDeferredHistory(item) {
    try {
      const list = JSON.parse(localStorage.getItem('sos-hist-deferred') || '[]');
      list.push({
        fileId: String(item && item.fileId || '').slice(0, 24),
        logicalMessageId: String(item && item.logicalMessageId || '').slice(0, 24),
        reason: String(item && item.reason || '').slice(0, 40),
        at: Date.now(),
      });
      localStorage.setItem('sos-hist-deferred', JSON.stringify(list.slice(-64)));
    } catch (_e) {}
  }

  function historySourceAttachment(logicalId) {
    const want = String(logicalId || '');
    if (!want) return null;
    const conv = App.chatState && App.chatState.conversations;
    if (!conv || typeof conv.forEach !== 'function') return null;
    let found = null;
    conv.forEach(function (entry) {
      if (found) return;
      const messages = entry && Array.isArray(entry.messages) ? entry.messages : [];
      for (let i = 0; i < messages.length; i += 1) {
        const msg = messages[i];
        if (!msg || !msg.attachment) continue;
        if (String(msg.logicalMessageId || msg.id || '') === want) { found = msg.attachment; break; }
      }
    });
    return found;
  }

  async function loadHistoryCachedBlob(cacheKey) {
    if (!cacheKey || typeof App.loadChatP2PMediaBlob !== 'function') return null;
    try { return await App.loadChatP2PMediaBlob(cacheKey); } catch (_e) { return null; }
  }

  function historyRemoteGone(err) {
    const code = String((err && (err.code || err.status || err.message)) || '');
    return /404|NOT_FOUND|MISSING_BLOB|NO_SUCH|UNKNOWN_HASH/i.test(code);
  }

  async function describeHistoryBlob(blob, fileId, logicalId, mimeHint, name, cacheKey) {
    const size = blob && typeof blob.size === 'number' ? blob.size : 0;
    const mime = String(mimeHint || (blob && blob.type) || 'application/octet-stream').slice(0, 80);
    if (!size) return { ok: false, fileId: fileId, logicalMessageId: logicalId, reason: 'EMPTY_BYTES', mime: mime, size: 0, cacheKey: cacheKey || '' };
    if (size > HIST_MEDIA_STREAM_MAX) return { ok: false, fileId: fileId, logicalMessageId: logicalId, reason: 'FILE_TOO_LARGE', mime: mime, size: size, cacheKey: cacheKey || '' };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sha = await sha256Hex(bytes);
    return {
      ok: true,
      fileId: fileId,
      logicalMessageId: logicalId,
      name: name || 'file',
      mime: mime,
      size: size,
      sha256: sha,
      cacheKey: cacheKey || '',
      bytes: size <= HIST_MEDIA_MAX ? bytes : null,
      blob: blob,
    };
  }

  async function readHistoryAttachment(att, logicalId) {
    const fileId = String((att && (att.fileId || att.attachmentId)) || logicalId || '');
    const hintedKey = att && att.cacheKey ? String(att.cacheKey) : (fileId ? ('p2p-file-' + fileId) : '');
    const name = att && typeof att.name === 'string' ? att.name.slice(0, 180) : 'file';
    const mimeHintRaw = String((att && (att.mime || (att.type && att.type !== 'encrypted-media' ? att.type : ''))) || '');
    const mimeHint = mimeHintRaw === 'encrypted-media' ? '' : mimeHintRaw;
    let blob = await loadHistoryCachedBlob(hintedKey);
    let cacheKey = hintedKey;
    if (!blob && att && typeof att.url === 'string' && att.url.indexOf('blob:') === 0) {
      try {
        const resp = await fetch(att.url);
        if (resp && resp.ok) blob = await resp.blob();
      } catch (_fetch) { blob = null; }
    }
    const source = historySourceAttachment(logicalId) || att;
    if (!blob && source && source !== att && source.cacheKey) {
      cacheKey = String(source.cacheKey);
      blob = await loadHistoryCachedBlob(cacheKey);
    }
    if (!blob && source && source._resolvedBlob instanceof Blob) blob = source._resolvedBlob;
    if (!blob && source && typeof App.encryptedMediaCacheKey === 'function' && source.type === 'encrypted-media') {
      try {
        const ek = await App.encryptedMediaCacheKey(source);
        if (ek) {
          cacheKey = ek;
          blob = await loadHistoryCachedBlob(ek);
        }
      } catch (_ek) { blob = null; }
    }
    if (!blob && source && source.type === 'encrypted-media' && typeof App.resolveServerMediaAttachment === 'function') {
      const gone = historyMissReason(fileId);
      if (gone) {
        return { ok: false, fileId: fileId, logicalMessageId: logicalId, reason: gone, mime: mimeHint, size: Number(source.size) || 0, cacheKey: cacheKey };
      }
      root.__sosHistFetchTried = root.__sosHistFetchTried || {};
      if (root.__sosHistFetchTried[fileId]) {
        return { ok: false, fileId: fileId, logicalMessageId: logicalId, reason: 'SOURCE_UNAVAILABLE', mime: mimeHint, size: Number(source.size) || 0, cacheKey: cacheKey };
      }
      root.__sosHistFetchTried[fileId] = true;
      try {
        const resolved = await App.resolveServerMediaAttachment(source, { logicalMessageId: logicalId });
        if (resolved && resolved.blob instanceof Blob) blob = resolved.blob;
      } catch (err) {
        const reason = historyRemoteGone(err) ? 'SOURCE_UNAVAILABLE' : 'RETRYABLE_FAILURE';
        if (reason === 'SOURCE_UNAVAILABLE') rememberHistoryMiss(fileId, reason);
        else rememberDeferredHistory({ fileId: fileId, logicalMessageId: logicalId, reason: reason });
        return { ok: false, fileId: fileId, logicalMessageId: logicalId, reason: reason, mime: mimeHint, size: Number(source.size) || 0, cacheKey: cacheKey };
      }
    }
    if (!blob) {
      const reason = historyMissReason(fileId) || 'NO_LOCAL_BYTES';
      if (reason === 'NO_LOCAL_BYTES') rememberDeferredHistory({ fileId: fileId, logicalMessageId: logicalId, reason: reason });
      return { ok: false, fileId: fileId, logicalMessageId: logicalId, reason: reason, mime: mimeHint, size: Number(att && att.size) || 0, cacheKey: cacheKey };
    }
    try {
      return await describeHistoryBlob(blob, fileId, logicalId, mimeHint || (source && source.mime) || '', name, cacheKey);
    } catch (_hash) {
      rememberDeferredHistory({ fileId: fileId, logicalMessageId: logicalId, reason: 'RETRYABLE_FAILURE' });
      return { ok: false, fileId: fileId, logicalMessageId: logicalId, reason: 'RETRYABLE_FAILURE', mime: mimeHint, size: blob.size || 0, cacheKey: cacheKey };
    }
  }

  function historySeconds(ts) {
    const n = Number(ts) || 0;
    if (!n) return 0;
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }

  function collectHistoryMessages(opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const since = Math.max(0, Number(options.since) || 0);
    const until = Math.max(0, Number(options.until) || 0);
    const onlyPeer = norm(options.peer || '');
    const self = norm(App.publicKey);
    const out = [];
    const unavailable = [];
    const conv = App.chatState && App.chatState.conversations;
    if (!conv || typeof conv.forEach !== 'function') return { messages: out, unavailable: unavailable, omitted: 0, complete: true, hasOlder: false };
    let hasOlder = false;
    conv.forEach(function (entry) {
      const messages = entry && Array.isArray(entry.messages) ? entry.messages : [];
      messages.forEach(function (m) {
        if (!m || m.historySync === true) return;
        const text = typeof m.content === 'string' ? m.content : '';
        let peer = norm(entry.peer || (norm(m.from) === self ? m.to : m.from));
        const owner = verifiedAccountOf(peer);
        if (owner) peer = owner;
        if (!isHex64(peer)) return;
        if (onlyPeer && peer !== onlyPeer) return;
        const ts = historySeconds(m.createdAt);
        if (since && ts && ts < since) {
          hasOlder = true;
          return;
        }
        if (until && ts && ts >= until) return;
        if (since && !ts) return;
        let attachment = null;
        if (m.attachment && m.deleted !== true && m.tombstone !== true) {
          const att = m.attachment;
          const logical = String(m.logicalMessageId || m.id || '');
          attachment = {
            name: typeof att.name === 'string' ? att.name.slice(0, 180) : '',
            mime: typeof (att.type || att.mime) === 'string' ? String(att.type || att.mime).slice(0, 80) : '',
            fileId: String(att.fileId || att.attachmentId || logical || ''),
            cacheKey: typeof att.cacheKey === 'string' ? att.cacheKey.slice(0, 180) : '',
            sha256: typeof (att.sha256 || (att.cipher && att.cipher.sha256)) === 'string' ? String(att.sha256 || att.cipher.sha256) : '',
            size: Number(att.size) || 0,
          };
          if (att.type === 'encrypted-media' && att.cipher && typeof att.cipher.sha256 === 'string') {
            attachment.encrypted = true;
            attachment.sha256 = String(att.cipher.sha256);
          }
        }
        if (!text.trim() && !m.attachment && m.deleted !== true && m.tombstone !== true) return;
        out.push({
          id: String(m.logicalMessageId || m.id || ''),
          peer: peer,
          text: text,
          direction: m.direction === 'outgoing' ? 'outgoing' : 'incoming',
          createdAt: ts || Math.floor(Date.now() / 1000),
          deleted: m.deleted === true || m.tombstone === true,
          attachment: attachment,
        });
      });
    });
    const byId = {};
    out.forEach(function (row) {
      if (!row || !row.id) return;
      const prev = byId[row.id];
      if (!prev) {
        byId[row.id] = row;
        return;
      }
      if (prev.peer === self && row.peer !== self) byId[row.id] = row;
    });
    const unique = out.filter(function (row) {
      return row && (!row.id || byId[row.id] === row);
    });
    let omitted = 0;
    const packed = [];
    unique.forEach(function (row) {
      if (JSON.stringify(row).length > HIST_PAGE_MAX) {
        omitted += 1;
        unavailable.push({ id: row.id, reason: 'MESSAGE_TOO_LARGE' });
        return;
      }
      packed.push(row);
    });
    return { messages: packed, unavailable: unavailable, omitted: omitted, complete: omitted === 0 && unavailable.length === 0, hasOlder: hasOlder };
  }

  function splitHistoryPages(messages) {
    const pages = [];
    let batch = [];
    (Array.isArray(messages) ? messages : []).forEach(function (row) {
      const trial = batch.concat([row]);
      if (JSON.stringify(trial).length > HIST_PAGE_BUDGET && batch.length) {
        pages.push(batch);
        batch = [row];
      } else {
        batch = trial;
      }
    });
    if (batch.length || !pages.length) pages.push(batch);
    return pages;
  }

  async function publishHistoryPage(peer, createdAt, page, pageCount, body) {
    if (typeof body !== 'string' || body.length > HIST_PAGE_MAX) {
      return { ok: false, code: 'PAGE_TOO_LARGE', bytes: body ? body.length : 0 };
    }
    const signer = App.SosCryptoSigner;
    let env;
    try {
      env = await Promise.resolve(signer.nip44ChatEncrypt({
        senderPubkey: norm(App.publicKey),
        recipientPubkey: peer,
        payload: {
          messageId: 'hist-' + createdAt + '-' + page,
          sender: norm(App.publicKey),
          recipient: peer,
          createdAt: createdAt,
          text: body,
          attachment: null,
        },
      }));
    } catch (err) {
      return { ok: false, code: String((err && (err.code || err.message)) || 'ENCRYPT_FAILED').slice(0, 80) };
    }
    if (!env || typeof env.ct !== 'string') return { ok: false, code: 'ENCRYPT_FAILED' };
    const event = await Promise.resolve(signer.signLinkedHistory({
      kind: HIST_KIND,
      created_at: createdAt,
      tags: [['p', peer], ['t', HIST_TAG], ['page', String(page)], ['snapshot', String(createdAt)]],
      content: JSON.stringify(env),
    }));
    if (!event || !event.id) return { ok: false, code: 'SIGN_FAILED' };
    const pending = App.pool.publish(App.relayUrls, event);
    const jobs = Array.isArray(pending) ? pending : [pending];
    const settled = await Promise.all(jobs.map(function (p) {
      return Promise.race([
        Promise.resolve(p).then(function () { return 'ok'; }, function () { return 'no'; }),
        new Promise(function (resolve) { setTimeout(function () { resolve('timeout'); }, 8000); }),
      ]);
    }));
    if (!settled.some(function (r) { return r === 'ok'; })) return { ok: false, code: 'RELAY_REJECTED' };
    return { ok: true, id: String(event.id).slice(0, 12) };
  }

  function historyInventoryKey(messages) {
    return (messages || []).map(function (row) {
      if (!row) return '';
      const att = row.attachment && typeof row.attachment === 'object' ? row.attachment : {};
      return [row.id || '', row.createdAt || 0, row.deleted ? 1 : 0, att.fileId || ''].join(':');
    }).join('\n');
  }

  function histCheckpointKey(peer) {
    return 'sos-hist-cp-' + String(norm(App.publicKey) || '').slice(0, 12) + '-' + String(peer || '').slice(0, 12);
  }

  function readHistCheckpoint(peer) {
    try { return JSON.parse(localStorage.getItem(histCheckpointKey(peer)) || 'null'); } catch (_e) { return null; }
  }

  function writeHistCheckpoint(peer, packed) {
    if (!packed) return;
    try {
      const sent = [];
      (packed.p2pFiles || []).forEach(function (file) {
        if (file && file.sent && file.fileId) sent.push(file.fileId);
      });
      localStorage.setItem(histCheckpointKey(peer), JSON.stringify({
        snapshotId: packed.snapshotId || '',
        inventoryKey: packed.inventoryKey || '',
        sent: sent,
        at: Date.now(),
      }));
    } catch (_e) {}
  }

  function historyPageSuspended() {
    return root.__sosPageSuspended === true || (typeof document !== 'undefined' && document.visibilityState === 'hidden');
  }

  function historyPeerState(peer) {
    root.__sosHistPeer = root.__sosHistPeer || {};
    if (!root.__sosHistPeer[peer]) {
      root.__sosHistPeer[peer] = { fails: 0, next: 0, probing: null, sending: null, timer: null, state: 'AUTHORIZED' };
    }
    return root.__sosHistPeer[peer];
  }

  function noteHistoryDevice(peer, state) {
    const row = historyPeerState(peer);
    if (row.state !== state) {
      row.state = state;
      try { console.log('HISTORY_DEVICE_STATE device=' + String(peer || '').slice(0, 8) + ' state=' + state); } catch (_e) {}
    }
    return state;
  }

  function enqueueHistoryFile(row, loaded, media, p2pFiles, forceP2P) {
    if (!row.attachment) row.attachment = {};
    row.attachment.sha256 = loaded.sha256;
    row.attachment.size = loaded.size;
    row.attachment.mime = loaded.mime;
    const mime = loaded.mime || 'application/octet-stream';
    if (!forceP2P && loaded.bytes && loaded.bytes.length <= HIST_RELAY_MEDIA_MAX) {
      row.attachment.transport = 'relay';
      media.push({
        fileId: loaded.fileId,
        logicalMessageId: row.id,
        name: loaded.name,
        mime: loaded.mime,
        size: loaded.size,
        sha256: loaded.sha256,
        chunkIndex: 0,
        chunkCount: 1,
        transport: 'relay',
        b64: bytesToB64(loaded.bytes),
      });
      return;
    }
    row.attachment.transport = 'p2p';
    p2pFiles.push({
      fileId: loaded.fileId,
      logicalMessageId: row.id,
      name: loaded.name,
      mime: mime,
      size: loaded.size,
      sha256: loaded.sha256,
      transport: 'p2p',
      blob: loaded.blob || new Blob([loaded.bytes], { type: mime }),
    });
  }

  function noteUnavailableHistory(unavailable, row, loaded) {
    const item = {
      id: row && row.id,
      fileId: loaded.fileId,
      reason: loaded.reason || 'NO_LOCAL_BYTES',
      mime: loaded.mime || '',
      size: loaded.size || 0,
      cacheKey: String(loaded.cacheKey || '').slice(0, 48),
      source: 'LOCAL',
    };
    unavailable.push(item);
    if (row && row.attachment) row.attachment.unavailable = item.reason;
    try {
      console.log('HISTORY_SOURCE_FILE file=' + String(item.fileId || '').slice(0, 16) + ' logical=' + String(item.id || '').slice(0, 24) + ' reason=' + item.reason + ' mime=' + item.mime + ' size=' + item.size);
    } catch (_u) {}
  }

  async function publishLinkedHistoryBundle(devicePub, opts) {
    if (!primaryReady()) return { ok: false, code: 'NOT_PRIMARY' };
    const peer = norm(devicePub);
    if (!isHex64(peer)) return { ok: false, code: 'BAD_DEVICE' };
    const signer = App.SosCryptoSigner;
    if (!signer || typeof signer.nip44ChatEncrypt !== 'function' || typeof signer.signLinkedHistory !== 'function') {
      return { ok: false, code: 'SIGNER_MISSING' };
    }
    if (typeof App.restoreChatState === 'function') {
      try { await App.restoreChatState(); } catch (_restore) {}
    }
    if (opts && opts.scope === 'older') return publishOlderHistoryBundle(devicePub, opts);
    const pool = App.pool;
    if (!pool || typeof pool.publish !== 'function') return { ok: false, code: 'NO_POOL' };
    root.__sosHistInflight = root.__sosHistInflight || {};
    if (root.__sosHistInflight[peer]) return root.__sosHistInflight[peer];
    let finishInflight = function () {};
    root.__sosHistInflight[peer] = new Promise(function (resolve) { finishInflight = resolve; });
    try {
    const options = opts && typeof opts === 'object' ? opts : {};
    const prior = root.__sosHistOutbound && root.__sosHistOutbound[peer];
    try { await noteOwnedDevices(); } catch (_own) {}
    if (typeof App.reconcileDeviceConversations === 'function') {
      try { await App.reconcileDeviceConversations(); } catch (_rec) {}
    }
    const anchor = Math.floor(Date.now() / 1000);
    const windowFrom = anchor - HIST_RECENT_SEC;
    const readStarted = Date.now();
    const preflight = collectHistoryMessages({ since: windowFrom });
    try {
      console.log('HISTORY_TIMING phase=SOURCE_HISTORY_READ_MS ms=' + (Date.now() - readStarted) + ' messages=' + preflight.messages.length);
      console.log('HISTORY_WINDOW_V2 from=' + windowFrom + ' to=' + anchor + ' messages=' + preflight.messages.length + ' olderAvailable=' + (preflight.hasOlder ? '1' : '0'));
    } catch (_win) {}
    const inventoryKey = historyInventoryKey(preflight.messages || []);
    let packed = null;
    let reused = false;
    if (prior && prior.pages && prior.inventoryKey === inventoryKey) {
      packed = prior;
      reused = true;
    }
    if (!packed) {
      const snapshot = preflight;
      const messages = snapshot.messages || [];
      const peers = {};
      messages.forEach(function (row) { if (row && row.peer) peers[row.peer] = true; });
      const media = [];
      const p2pFiles = [];
      const unavailable = (snapshot.unavailable || []).slice();
      let totalBytes = 0;
      const lookupStarted = Date.now();
      for (let i = 0; i < messages.length; i += 1) {
        const row = messages[i];
        if (!row || !row.attachment || !row.attachment.fileId || row.deleted === true) continue;
        const readStarted = Date.now();
        const loaded = await readHistoryAttachment(row.attachment, row.id);
        try {
          console.log('HISTORY_TIMING phase=SOURCE_BLOB_READ_MS ms=' + (Date.now() - readStarted) + ' file=' + String(row.attachment.fileId || '').slice(0, 16) + ' ok=' + (loaded.ok ? '1' : '0') + ' reason=' + String(loaded.reason || '') + ' mime=' + String(loaded.mime || '') + ' size=' + (loaded.size || 0));
        } catch (_timing) {}
        if (!loaded.ok) {
          noteUnavailableHistory(unavailable, row, loaded);
          continue;
        }
        totalBytes += loaded.size || 0;
        enqueueHistoryFile(row, loaded, media, p2pFiles, false);
      }
      try { console.log('HISTORY_TIMING phase=MANIFEST_BUILD_MS ms=' + (Date.now() - lookupStarted) + ' files=' + (media.length + p2pFiles.length)); } catch (_manifest) {}
      const textPages = splitHistoryPages(messages);
      const messagePageCount = textPages.length;
      const pages = textPages.map(function (batch) { return { kind: 'messages', messages: batch }; });
      media.forEach(function (chunk) { pages.push({ kind: 'media', media: chunk }); });
      if (!pages.length) pages.push({ kind: 'messages', messages: [] });
      const snapshotId = await sha256Hex(new TextEncoder().encode(norm(App.publicKey) + ':' + peer + ':' + inventoryKey));
      const saved = readHistCheckpoint(peer);
      if (saved && saved.inventoryKey === inventoryKey && Array.isArray(saved.sent)) {
        const done = {};
        saved.sent.forEach(function (id) { done[id] = true; });
        p2pFiles.forEach(function (file) { if (file && done[file.fileId]) file.sent = true; });
      }
      packed = {
        snapshotId: snapshotId,
        inventoryKey: inventoryKey,
        createdAt: Math.floor(Date.now() / 1000),
        messages: messages,
        pages: pages,
        conversationCount: Object.keys(peers).length,
        attachmentCount: new Set(media.map(function (m) { return m.fileId; }).concat(p2pFiles.map(function (m) { return m.fileId; }))).size,
        totalBytes: totalBytes,
        unavailable: unavailable,
        omitted: snapshot.omitted || 0,
        sourceComplete: (snapshot.omitted || 0) === 0 && unavailable.length === 0,
        messagePageCount: messagePageCount,
        p2pFiles: p2pFiles,
        scope: 'recent',
        protocol: 2,
        windowFrom: windowFrom,
        windowTo: anchor,
        hasOlder: preflight.hasOlder === true,
      };
      p2pFiles.forEach(function (file) { file.snapshotId = snapshotId; });
      root.__sosHistOutbound = root.__sosHistOutbound || {};
      root.__sosHistOutbound[peer] = packed;
    }
    if (reused && packed && Array.isArray(packed.unavailable) && packed.unavailable.length) {
      const still = [];
      const extra = [];
      for (let u = 0; u < packed.unavailable.length; u += 1) {
        const item = packed.unavailable[u];
        if (!item || !item.fileId) { still.push(item); continue; }
        const loaded = await readHistoryAttachment({ fileId: item.fileId, cacheKey: item.cacheKey, mime: item.mime }, item.id);
        if (!loaded.ok) { still.push(Object.assign({}, item, { reason: loaded.reason || item.reason })); continue; }
        enqueueHistoryFile({ id: item.id, attachment: { fileId: loaded.fileId } }, loaded, [], extra, true);
      }
      packed.unavailable = still;
      if (extra.length) {
        packed.p2pFiles = (packed.p2pFiles || []).concat(extra);
        extra.forEach(function (file) { file.snapshotId = packed.snapshotId; file.sent = false; });
        try { console.log('HISTORY_RETRY_FILE count=' + extra.length + ' snapshot=' + String(packed.snapshotId || '').slice(0, 8)); } catch (_retry) {}
      }
    }
    const have = {};
    const listed = options.checkpoint && Array.isArray(options.checkpoint.havePages) ? options.checkpoint.havePages : [];
    listed.forEach(function (n) { have[Number(n)] = true; });
    let published = 0;
    let lastId = '';
    const pageCount = packed.pages.length;
    for (let page = 0; page < pageCount; page += 1) {
      if (have[page]) continue;
      const item = packed.pages[page];
      const payload = item.kind === 'media' ? item.media : item.messages;
      const pageHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(payload)));
      const bodyObj = {
        v: 4,
        type: HIST_TAG,
        kind: item.kind,
        accountP: norm(App.publicKey),
        snapshotId: packed.snapshotId,
        snapshotVersion: 1,
        sourceDeviceId: 'primary',
        destinationDeviceId: peer,
        createdAt: packed.createdAt,
        page: page,
        pageCount: pageCount,
        pageHash: pageHash,
        messagePageCount: packed.messagePageCount || pageCount,
        conversationCount: packed.conversationCount,
        messageCount: packed.messages.length,
        attachmentCount: packed.attachmentCount,
        totalBytes: packed.totalBytes || 0,
        sourceComplete: packed.sourceComplete === true,
        referencedAttachments: (packed.attachmentCount || 0) + ((packed.unavailable && packed.unavailable.length) || 0),
        sourceAvailable: packed.attachmentCount || 0,
        sourceUnavailable: (packed.unavailable && packed.unavailable.length) || 0,
        protocol: 2,
        scope: packed.scope || 'recent',
        recentHistory: (packed.scope || 'recent') !== 'older',
        fullBackup: false,
        windowFrom: packed.windowFrom || 0,
        windowTo: packed.windowTo || 0,
        conversationId: packed.conversationId || '',
        nextBefore: packed.nextBefore || 0,
        hasMore: packed.hasMore === true,
        requestId: packed.requestId || '',
        messages: item.kind === 'messages' ? item.messages : [],
        media: item.kind === 'media' ? item.media : null,
        unavailable: page === pageCount - 1 ? packed.unavailable : [],
        omitted: page === pageCount - 1 ? packed.omitted : 0,
        complete: false,
      };
      bodyObj.manifestHash = await sha256Hex(new TextEncoder().encode(packed.snapshotId + '|' + packed.messages.length + '|' + pageCount));
      const sent = await publishHistoryPage(peer, packed.createdAt, page, pageCount, JSON.stringify(bodyObj));
      if (!sent.ok) {
        const failed = { ok: false, code: sent.code, count: packed.messages.length, pages: published, snapshotId: packed.snapshotId };
        try { console.log('PHONE_HISTORY_FAIL code=' + String(sent.code || '') + ' page=' + page); } catch (_fail) {}
        finishInflight(failed);
        setTimeout(function () { delete root.__sosHistInflight[peer]; }, 15000);
        return failed;
      }
      published += 1;
      lastId = sent.id;
    }
    try {
      if (reused && published === 0) {
        console.log('PHONE_HISTORY_JOIN snapshot=' + packed.snapshotId.slice(0, 8) + ' messages=' + packed.messages.length + ' pages=' + pageCount);
      } else {
        console.log('PHONE_HISTORY_READY snapshot=' + packed.snapshotId.slice(0, 8) + ' messages=' + packed.messages.length + ' pages=' + pageCount + ' files=' + packed.attachmentCount + ' p2p=' + ((packed.p2pFiles && packed.p2pFiles.length) || 0));
      }
    } catch (_log) {}
    writeHistCheckpoint(peer, packed);
    if (packed.p2pFiles && packed.p2pFiles.length) {
      if (historyPageSuspended()) {
        noteHistoryDevice(peer, 'SUSPENDED');
      } else {
        const row = historyPeerState(peer);
        const cooling = row.fails > 0 && Date.now() < row.next;
        if (!cooling && row.state !== 'DATA_CHANNEL_OPEN') row.state = 'RECONNECTING';
        pushHistoryMediaP2P(peer, packed.p2pFiles).catch(function () {});
      }
    }
    const result = {
      ok: true,
      count: packed.messages.length,
      pages: pageCount,
      published: published,
      id: lastId,
      snapshotId: packed.snapshotId,
      conversationCount: packed.conversationCount,
      attachmentCount: packed.attachmentCount,
      HISTORY_SYNC_TRANSFERRED: published > 0 || listed.length > 0,
      HISTORY_SYNC_COMPLETE: false,
      HISTORY_TEXT_SYNC_COMPLETE: false,
      HISTORY_FULL_SYNC_COMPLETE: false,
      omitted: packed.omitted,
      unavailable: packed.unavailable.length,
    };
    finishInflight(result);
    setTimeout(function () { delete root.__sosHistInflight[peer]; }, 15000);
    return result;
    } catch (err) {
      const failed = { ok: false, code: String((err && (err.message || err.code)) || 'HISTORY_FAILED').slice(0, 80) };
      try { console.log('PHONE_HISTORY_FAIL code=' + failed.code); } catch (_fail) {}
      finishInflight(failed);
      setTimeout(function () { delete root.__sosHistInflight[peer]; }, 15000);
      return failed;
    }
  }

  async function publishOlderHistoryBundle(devicePub, opts) {
    if (!primaryReady()) return { ok: false, code: 'NOT_PRIMARY' };
    const peer = norm(devicePub);
    const conversation = norm(opts && opts.conversationId);
    const before = Math.max(0, Number(opts && opts.before) || 0);
    const requestId = String((opts && (opts.requestId || opts.syncRequestId)) || '');
    if (!isHex64(peer) || !isHex64(conversation) || !before) return { ok: false, code: 'BAD_WINDOW' };
    const key = peer + ':' + conversation + ':' + before;
    root.__sosHistOlderInflight = root.__sosHistOlderInflight || {};
    if (root.__sosHistOlderInflight[key]) return root.__sosHistOlderInflight[key];
    const job = publishOlderHistoryNow(peer, conversation, before, requestId);
    root.__sosHistOlderInflight[key] = job;
    try { return await job; } finally {
      setTimeout(function () { delete root.__sosHistOlderInflight[key]; }, 5000);
    }
  }

  async function publishOlderHistoryNow(peer, conversation, before, requestId) {
    const signer = App.SosCryptoSigner;
    if (!signer || typeof signer.nip44ChatEncrypt !== 'function' || typeof signer.signLinkedHistory !== 'function') {
      return { ok: false, code: 'SIGNER_MISSING' };
    }
    if (typeof App.restoreChatState === 'function') {
      try { await App.restoreChatState(); } catch (_restore) {}
    }
    try { await noteOwnedDevices(); } catch (_own) {}
    if (typeof App.reconcileDeviceConversations === 'function') {
      try { await App.reconcileDeviceConversations(); } catch (_rec) {}
    }
    const since = before - HIST_OLDER_SEC;
    const readStarted = Date.now();
    const snapshot = collectHistoryMessages({ since: since, until: before, peer: conversation });
    try {
      console.log('HISTORY_TIMING phase=SOURCE_HISTORY_READ_MS ms=' + (Date.now() - readStarted) + ' scope=older messages=' + snapshot.messages.length);
    } catch (_t) {}
    const messages = snapshot.messages || [];
    const media = [];
    const p2pFiles = [];
    const unavailable = (snapshot.unavailable || []).slice();
    let totalBytes = 0;
    for (let i = 0; i < messages.length; i += 1) {
      const row = messages[i];
      if (!row || !row.attachment || !row.attachment.fileId || row.deleted === true) continue;
      const loaded = await readHistoryAttachment(row.attachment, row.id);
      if (!loaded.ok) {
        noteUnavailableHistory(unavailable, row, loaded);
        continue;
      }
      totalBytes += loaded.size || 0;
      enqueueHistoryFile(row, loaded, media, p2pFiles, false);
    }
    const textPages = splitHistoryPages(messages);
    const pages = textPages.map(function (batch) { return { kind: 'messages', messages: batch }; });
    media.forEach(function (chunk) { pages.push({ kind: 'media', media: chunk }); });
    if (!pages.length) pages.push({ kind: 'messages', messages: [] });
    const createdAt = Math.floor(Date.now() / 1000);
    const inventoryKey = historyInventoryKey(messages);
    const snapshotId = await sha256Hex(new TextEncoder().encode(norm(App.publicKey) + ':' + peer + ':older:' + conversation + ':' + before + ':' + inventoryKey));
    p2pFiles.forEach(function (file) { file.snapshotId = snapshotId; });
    const hasMore = snapshot.hasOlder === true;
    let published = 0;
    for (let page = 0; page < pages.length; page += 1) {
      const item = pages[page];
      const payload = item.kind === 'media' ? item.media : item.messages;
      const pageHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(payload)));
      const bodyObj = {
        v: 4,
        type: HIST_TAG,
        kind: item.kind,
        accountP: norm(App.publicKey),
        snapshotId: snapshotId,
        protocol: 2,
        scope: 'older',
        recentHistory: false,
        fullBackup: false,
        sourceDeviceId: 'primary',
        destinationDeviceId: peer,
        createdAt: createdAt,
        page: page,
        pageCount: pages.length,
        pageHash: pageHash,
        messagePageCount: textPages.length,
        messageCount: messages.length,
        attachmentCount: media.length + p2pFiles.length,
        totalBytes: totalBytes,
        sourceComplete: unavailable.length === 0,
        windowFrom: since,
        windowTo: before,
        conversationId: conversation,
        nextBefore: since,
        hasMore: hasMore,
        requestId: requestId,
        messages: item.kind === 'messages' ? item.messages : [],
        media: item.kind === 'media' ? item.media : null,
        unavailable: page === pages.length - 1 ? unavailable : [],
        omitted: page === pages.length - 1 ? (snapshot.omitted || 0) : 0,
        complete: false,
      };
      const sent = await publishHistoryPage(peer, createdAt, page, pages.length, JSON.stringify(bodyObj));
      if (!sent.ok) {
        try { console.log('PHONE_OLDER_HISTORY_FAIL code=' + String(sent.code || '')); } catch (_f) {}
        return { ok: false, code: sent.code || 'PUBLISH_FAILED', FULL_BACKUP_COMPLETE: false };
      }
      published += 1;
    }
    if (p2pFiles.length && !historyPageSuspended()) {
      pushHistoryMediaP2P(peer, p2pFiles).catch(function () {});
    }
    try {
      console.log('PHONE_OLDER_HISTORY_READY peer=' + conversation.slice(0, 8) + ' messages=' + messages.length + ' from=' + since + ' to=' + before + ' hasMore=' + (hasMore ? '1' : '0') + ' pages=' + published);
    } catch (_log) {}
    return {
      ok: true,
      scope: 'older',
      count: messages.length,
      hasMore: hasMore,
      nextBefore: since,
      FULL_BACKUP_COMPLETE: false,
    };
  }

  function hasHistTag(event) {
    return Array.isArray(event && event.tags) && event.tags.some(function (t) {
      return Array.isArray(t) && t[0] === 't' && t[1] === HIST_TAG;
    });
  }

  function rememberHistory(result) {
    root.__sosLdHistorySync = result;
    return result;
  }

  function olderCursorStorageKey(account, peer) {
    return 'sos-hist-older-' + String(account || '').slice(0, 12) + '-' + String(peer || '').slice(0, 12);
  }

  function readOlderCursor(account, peer) {
    root.__sosOlderCursor = root.__sosOlderCursor || {};
    if (root.__sosOlderCursor[peer]) return root.__sosOlderCursor[peer];
    try {
      const raw = localStorage.getItem(olderCursorStorageKey(account, peer));
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') {
        root.__sosOlderCursor[peer] = parsed;
        return parsed;
      }
    } catch (_e) {}
    return null;
  }

  function writeOlderCursor(cursor) {
    if (!cursor || !isHex64(cursor.accountP) || !isHex64(cursor.conversationId)) return;
    root.__sosOlderCursor = root.__sosOlderCursor || {};
    root.__sosOlderCursor[cursor.conversationId] = cursor;
    try { localStorage.setItem(olderCursorStorageKey(cursor.accountP, cursor.conversationId), JSON.stringify(cursor)); } catch (_e) {}
  }

  function oldestLoadedMessage(peer) {
    const conv = App.chatState && App.chatState.conversations;
    const self = norm(App.publicKey);
    const want = norm(peer);
    let oldest = 0;
    let logical = '';
    if (!conv || typeof conv.forEach !== 'function') return { ts: 0, id: '' };
    conv.forEach(function (entry) {
      let entryPeer = norm(entry && entry.peer);
      const owner = verifiedAccountOf(entryPeer);
      if (owner) entryPeer = owner;
      if (entryPeer !== want) return;
      (entry.messages || []).forEach(function (m) {
        const ts = historySeconds(m && m.createdAt);
        if (!ts) return;
        if (!oldest || ts < oldest) {
          oldest = ts;
          logical = String((m && (m.logicalMessageId || m.id)) || '');
        }
      });
    });
    if (!oldest && want === self) return { ts: Math.floor(Date.now() / 1000) - HIST_RECENT_SEC, id: '' };
    return { ts: oldest, id: logical };
  }

  function finishOlderHistory(bundle, session, added, unavailableCount) {
    const peer = norm(bundle.conversationId);
    const seenKey = bundle.__olderSeenKey;
    if (seenKey) {
      root.__sosOlderSeen = root.__sosOlderSeen || {};
      root.__sosOlderSeen[seenKey] = true;
    }
    root.__sosOlderGot = root.__sosOlderGot || {};
    const group = String(bundle.requestId || bundle.snapshotId || peer);
    const got = root.__sosOlderGot[group] || (root.__sosOlderGot[group] = {});
    got[bundle.page] = true;
    const pageCount = Number(bundle.pageCount) > 0 ? Number(bundle.pageCount) : 1;
    if (Object.keys(got).length < pageCount) {
      return { ok: true, scope: 'older', partial: true, FULL_BACKUP_COMPLETE: false };
    }
    const oldest = oldestLoadedMessage(peer);
    const cursor = {
      accountP: session.accountP,
      conversationId: peer,
      oldestLoadedTimestamp: oldest.ts || Number(bundle.nextBefore) || 0,
      oldestLoadedLogicalMessageId: oldest.id || '',
      snapshotHighWaterMark: Number(bundle.windowTo) || 0,
      nextOlderBoundary: Number(bundle.nextBefore) || 0,
      hasMore: bundle.hasMore === true,
      requestId: String(bundle.requestId || ''),
    };
    writeOlderCursor(cursor);
    root.__sosOlderHistoryAvailable = true;
    root.__sosFullBackupComplete = false;
    if (root.__sosOlderWait) delete root.__sosOlderWait[peer];
    try {
      console.log('OLDER_HISTORY_PAGE peer=' + peer.slice(0, 8) + ' added=' + added + ' hasMore=' + (cursor.hasMore ? '1' : '0') + ' next=' + cursor.nextOlderBoundary + ' unavailable=' + unavailableCount);
    } catch (_log) {}
    try {
      const ev = new CustomEvent('sos-older-history', { detail: { peer: peer, added: added, hasMore: cursor.hasMore } });
      root.dispatchEvent(ev);
    } catch (_ev) {}
    return {
      ok: true,
      scope: 'older',
      added: added,
      hasMore: cursor.hasMore,
      nextOlderBoundary: cursor.nextOlderBoundary,
      RECENT_HISTORY_SYNC_COMPLETE: root.__sosRecentHistorySyncComplete === true,
      OLDER_HISTORY_AVAILABLE_ON_REQUEST: true,
      FULL_BACKUP_COMPLETE: false,
      FAKE_HISTORY_SYNC: false,
    };
  }

  async function acceptHistoryEvent(event) {
    if (!hasHistTag(event)) return rememberHistory({ ok: false, code: 'NOT_HISTORY', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
    const session = getAccountSession();
    if (session.role !== 'LINKED_DEVICE' || !session.verified) return rememberHistory({ ok: false, code: 'NOT_LINKED', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
    if (!allows('READ_CONVERSATIONS')) return rememberHistory({ ok: false, code: 'CAPABILITY_DENIED', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
    const histSig = verifyEventPlain(event);
    if (!histSig.ok) return rememberHistory({ ok: false, code: 'BAD_EVENT_SIG', detail: histSig.code || 'BAD_EVENT_SIG', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
    if (norm(event.pubkey) !== session.accountP) return rememberHistory({ ok: false, code: 'ACCOUNT_MISMATCH', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
    let env;
    try { env = JSON.parse(event.content); } catch (_e) { return rememberHistory({ ok: false, code: 'BAD_ENVELOPE', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false }); }
    const opened = await decryptForLinkedDevice(event, env, false, null);
    if (!opened || opened.ok !== true || !opened.payload) return rememberHistory({ ok: false, code: (opened && opened.code) || 'DECRYPT_FAILED', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
    let bundle;
    try { bundle = JSON.parse(opened.payload.text); } catch (_e2) { return rememberHistory({ ok: false, code: 'BAD_BUNDLE', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false }); }
    if (bundle && bundle.type === 'sos-hist-ack-ok') {
      noteAckConfirmed(bundle.fingerprint, bundle.snapshotId);
      return root.__sosLdHistorySync || { ok: true, code: 'ACK_OK', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false };
    }
    if (!bundle || bundle.type !== HIST_TAG || norm(bundle.accountP) !== session.accountP) return rememberHistory({ ok: false, code: 'BAD_BUNDLE', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
    if (bundle.destinationDeviceId && norm(bundle.destinationDeviceId) !== norm(session.deviceSignPub)) {
      return rememberHistory({ ok: false, code: 'DESTINATION_MISMATCH', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
    }
    try { await noteOwnedDevices(session.accountP); } catch (_own) {}
    const page = Number.isInteger(bundle.page) ? bundle.page : 0;
    const pageCount = Number(bundle.pageCount) > 0 ? Number(bundle.pageCount) : 1;
    const snapshotId = typeof bundle.snapshotId === 'string' ? bundle.snapshotId : 'legacy';
    const older = bundle.scope === 'older';
    if (older) {
      root.__sosOlderSeen = root.__sosOlderSeen || {};
      const seenKey = String(bundle.requestId || snapshotId) + ':' + page + ':' + String(bundle.kind || 'messages');
      if (root.__sosOlderSeen[seenKey]) {
        return { ok: true, duplicate: true, scope: 'older', FULL_BACKUP_COMPLETE: false, RECENT_HISTORY_SYNC_COMPLETE: root.__sosRecentHistorySyncComplete === true };
      }
      bundle.__olderSeenKey = seenKey;
    }
    if (!older && (!root.__sosLdHistoryPages || (snapshotId !== 'legacy' && root.__sosLdHistoryPages.snapshotId && root.__sosLdHistoryPages.snapshotId !== snapshotId && Number(bundle.createdAt) >= Number(root.__sosLdHistoryPages.createdAt || 0)))) {
      root.__sosLdHistoryPages = { seen: {}, count: 0, unavailable: 0, omitted: 0, pageCount: pageCount, snapshotId: snapshotId, createdAt: Number(bundle.createdAt) || 0, files: {}, filesDone: 0, messageCount: 0, attachmentCount: 0 };
    }
    if (!root.__sosLdHistoryPages) {
      root.__sosLdHistoryPages = { seen: {}, count: 0, unavailable: 0, omitted: 0, pageCount: pageCount, snapshotId: snapshotId, createdAt: Number(bundle.createdAt) || 0, files: {}, filesDone: 0, messageCount: 0, attachmentCount: 0 };
    }
    const book = root.__sosLdHistoryPages;
    if (bundle.v >= 4 && bundle.pageHash) {
      const payload = bundle.kind === 'media' ? bundle.media : bundle.messages;
      const expect = await sha256Hex(new TextEncoder().encode(JSON.stringify(payload)));
      if (expect !== bundle.pageHash) return rememberHistory({ ok: false, code: 'PAGE_HASH_MISMATCH', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
    }
    if (!older && book.seen[page] === true) {
      return root.__sosLdHistorySync || { ok: true, duplicate: true, HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false };
    }
    const already = false;
    let n = 0;
    if (!already && bundle.kind !== 'media') {
      const list = Array.isArray(bundle.messages) ? bundle.messages : [];
      list.forEach(function (m) {
        if (!m || typeof m.text !== 'string' || !isHex64(m.peer) || typeof App.appendChatMessage !== 'function') return;
        const owner = verifiedAccountOf(m.peer);
        const filedPeer = owner || norm(m.peer);
        const outgoing = m.direction === 'outgoing';
        const att = m.attachment && typeof m.attachment === 'object' ? {
          name: m.attachment.name || '',
          type: m.attachment.mime || m.attachment.type || '',
          fileId: m.attachment.fileId || '',
          sha256: m.attachment.sha256 || '',
          size: Number(m.attachment.size) || 0,
          cacheKey: m.attachment.fileId ? ('p2p-file-' + m.attachment.fileId) : '',
          unavailable: m.attachment.unavailable || '',
          transport: m.attachment.transport || '',
        } : null;
        if (att && att.fileId && !older) {
          book.expectedFiles = book.expectedFiles || {};
          if (!book.expectedFiles[att.fileId]) {
            book.expectedFiles[att.fileId] = { logicalMessageId: String(m.id || ''), sha256: att.sha256 || '', size: Number(att.size) || 0 };
            book.totalBytes = (book.totalBytes || 0) + (Number(att.size) || 0);
          }
          if (att.transport === 'p2p') book.waitingDevice = true;
          book.transport = att.transport === 'p2p' ? 'p2p' : (book.transport || 'relay');
        }
        App.appendChatMessage({
          id: 'hist-' + String(m.id || n),
          from: outgoing ? session.accountP : filedPeer,
          to: outgoing ? filedPeer : session.accountP,
          content: m.deleted === true ? '' : m.text,
          attachment: att && att.fileId ? att : (m.attachment && m.attachment.type === 'encrypted-media' ? m.attachment : null),
          createdAt: Number(m.createdAt) || Math.floor(Date.now() / 1000),
          direction: outgoing ? 'outgoing' : 'incoming',
          status: m.deleted === true ? 'deleted' : 'delivered',
          deleted: m.deleted === true,
          tombstone: m.deleted === true,
          source: 'HISTORY_SYNC',
          historySync: true,
          logicalMessageId: String(m.id || ''),
        });
        n += 1;
      });
    }
    if (!already && bundle.kind === 'media' && bundle.media && bundle.media.fileId) {
      const media = bundle.media;
      const slot = book.files[media.fileId] || (book.files[media.fileId] = { parts: {}, count: Number(media.chunkCount) || 1, sha256: media.sha256 || '', mime: media.mime || '', name: media.name || '', logicalMessageId: media.logicalMessageId || '' });
      if (slot.parts[media.chunkIndex] !== media.b64) slot.parts[media.chunkIndex] = media.b64;
      const gotParts = Object.keys(slot.parts).length;
      if (gotParts >= slot.count && !slot.done) {
        const pieces = [];
        for (let c = 0; c < slot.count; c += 1) {
          if (typeof slot.parts[c] !== 'string') return rememberHistory({ ok: false, code: 'MEDIA_GAP', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
          pieces.push(b64ToBytes(slot.parts[c]));
        }
        const total = pieces.reduce(function (sum, part) { return sum + part.length; }, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;
        pieces.forEach(function (part) { bytes.set(part, offset); offset += part.length; });
        const sha = await sha256Hex(bytes);
        if (slot.sha256 && sha !== slot.sha256) return rememberHistory({ ok: false, code: 'MEDIA_HASH_MISMATCH', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
        const blob = new Blob([bytes], { type: slot.mime || 'application/octet-stream' });
        let stored = false;
        if (typeof App.persistChatP2PMedia === 'function') {
          try {
            await App.persistChatP2PMedia(media.fileId, blob, { name: slot.name, type: slot.mime });
            const saved = typeof App.loadChatP2PMediaBlob === 'function' ? await App.loadChatP2PMediaBlob('p2p-file-' + media.fileId) : blob;
            stored = !!(saved && saved.size === bytes.length);
          } catch (_store) { stored = false; }
        }
        if (!stored) {
          book.missingFiles = book.missingFiles || [];
          book.missingFiles.push({ fileId: media.fileId, logicalMessageId: slot.logicalMessageId, reason: 'PERSIST_FAILED' });
          return rememberHistory({ ok: false, code: 'MEDIA_PERSIST_FAILED', HISTORY_SYNC_COMPLETE: false, FAKE_HISTORY_SYNC: false });
        }
        slot.done = true;
        slot.parts = {};
        if (!older) {
          book.filesDone = (book.filesDone || 0) + 1;
          book.verifiedBytes = (book.verifiedBytes || 0) + bytes.length;
          book.relayBytes = (book.relayBytes || 0) + bytes.length;
        }
        book.transport = 'relay';
        try {
          const url = URL.createObjectURL(blob);
          const conv = App.chatState && App.chatState.conversations;
          if (conv && typeof conv.forEach === 'function') {
            conv.forEach(function (entry) {
              (entry.messages || []).forEach(function (msg) {
                if (!msg || String(msg.logicalMessageId || '') !== String(slot.logicalMessageId)) return;
                if (!msg.attachment) msg.attachment = {};
                msg.attachment.url = url;
                msg.attachment.cacheKey = 'p2p-file-' + media.fileId;
                msg.attachment.sha256 = sha;
              });
            });
          }
          if (typeof App.persistChatState === 'function') App.persistChatState();
        } catch (_url) {}
      }
    }
    const unavailable = Array.isArray(bundle.unavailable) ? bundle.unavailable : [];
    const omitted = Number(bundle.omitted) || 0;
    if (older) return finishOlderHistory(bundle, session, n, unavailable.length);
    book.pageCount = Math.max(book.pageCount || 1, pageCount);
    book.messageCount = Math.max(book.messageCount || 0, Number(bundle.messageCount) || 0);
    book.attachmentCount = Math.max(book.attachmentCount || 0, Number(bundle.attachmentCount) || 0);
    if (Number(bundle.totalBytes) > 0) book.totalBytes = Math.max(book.totalBytes || 0, Number(bundle.totalBytes));
    book.snapshotId = snapshotId;
    if (!already) {
      book.seen[page] = true;
      book.count += n;
      book.unavailable += unavailable.length;
      if (unavailable.length) book.sourceMissing = (book.sourceMissing || []).concat(unavailable);
      book.omitted += omitted;
    }
    if (Number(bundle.referencedAttachments) > 0) book.referencedAttachments = Number(bundle.referencedAttachments);
    if (Number(bundle.sourceAvailable) > 0) book.sourceAvailable = Number(bundle.sourceAvailable);
    const got = Object.keys(book.seen).length;
    if (Number(bundle.messagePageCount) > 0) book.messagePageCount = Number(bundle.messagePageCount);
    const messagePages = book.messagePageCount || book.pageCount;
    let textGot = 0;
    for (let i = 0; i < messagePages; i += 1) if (book.seen[i] === true) textGot += 1;
    const textDone = messagePages > 0 && textGot >= messagePages && book.omitted === 0;
    const filesDone = (book.attachmentCount || 0) === 0 || (book.filesDone || 0) >= book.attachmentCount;
    const protocol2 = Number(bundle.protocol) >= 2 || bundle.recentHistory === true || bundle.scope === 'recent';
    const windowDone = textDone && filesDone && bundle.sourceComplete !== false && (book.unavailable || 0) === 0 && !(book.missingFiles && book.missingFiles.length);
    const full = protocol2 ? false : windowDone;
    const recentDone = protocol2 && windowDone;
    if (recentDone) {
      root.__sosRecentHistorySyncComplete = true;
      root.__sosOlderHistoryAvailable = true;
      root.__sosFullBackupComplete = false;
      try { console.log('RECENT_HISTORY_SYNC_COMPLETE messages=' + book.count + ' files=' + (book.filesDone || 0) + ' FULL_BACKUP_COMPLETE=false'); } catch (_recent) {}
    }
    book.uiFull = protocol2 ? recentDone : full;
    historyProgress(book);
    root.__sosLdHistorySync = {
      ok: true,
      count: book.count,
      pages: got,
      pageCount: book.pageCount,
      snapshotId: book.snapshotId,
      HISTORY_TEXT_SYNC_COMPLETE: textDone,
      HISTORY_ATTACHMENTS_SYNC_COMPLETE: filesDone,
      HISTORY_FULL_SYNC_COMPLETE: full,
      HISTORY_SYNC_COMPLETE: full,
      RECENT_HISTORY_SYNC_COMPLETE: root.__sosRecentHistorySyncComplete === true,
      OLDER_HISTORY_AVAILABLE_ON_REQUEST: root.__sosOlderHistoryAvailable === true,
      FULL_BACKUP_COMPLETE: false,
      omitted: book.omitted,
      unavailable: book.unavailable,
      filesDone: book.filesDone || 0,
      verifiedBytes: book.verifiedBytes || 0,
      FAKE_HISTORY_SYNC: false,
    };
    try {
      localStorage.setItem('sos-hist-book-' + session.accountP, JSON.stringify({ snapshotId: book.snapshotId, seen: book.seen, pageCount: book.pageCount, count: book.count, filesDone: book.filesDone || 0, verifiedBytes: book.verifiedBytes || 0 }));
    } catch (_mem) {}
    const prevFiles = book._ackFiles || 0;
    const fileStep = (book.filesDone || 0) > prevFiles;
    const textNew = textDone && book.textAcked !== book.snapshotId;
    if (textNew) book.textAcked = book.snapshotId;
    scheduleHistoryAck(book, full ? 'final' : (fileStep ? 'file' : (textNew ? 'text' : 'page')));
    return root.__sosLdHistorySync;
  }

  async function pullLinkedHistory() {
    const session = getAccountSession();
    if (session.role !== 'LINKED_DEVICE' || !session.verified || !allows('READ_CONVERSATIONS')) {
      return { ok: false, code: 'NOT_LINKED' };
    }
    const pool = App.pool;
    if (!pool || typeof pool.get !== 'function' || !isHex64(session.deviceSignPub)) return { ok: false, code: 'NO_POOL' };
    let events = [];
    try {
      const filter = {
        kinds: [HIST_KIND],
        '#p': [session.deviceSignPub],
        '#t': [HIST_TAG],
        authors: [session.accountP],
        limit: 200,
      };
      if (typeof pool.list === 'function') events = await pool.list(App.relayUrls, [filter]);
      else if (typeof pool.querySync === 'function') {
        const result = await pool.querySync(App.relayUrls, filter);
        events = Array.isArray(result && result.events) ? result.events : (Array.isArray(result) ? result : []);
      } else if (typeof pool.get === 'function') {
        const ev = await pool.get(App.relayUrls, filter);
        events = ev ? [ev] : [];
      }
    } catch (_e) {
      return { ok: false, code: 'QUERY_FAILED' };
    }
    if (!Array.isArray(events) || !events.length) return { ok: false, code: 'NO_EVENT' };
    events.sort(function (a, b) { return (Number(a && a.created_at) || 0) - (Number(b && b.created_at) || 0); });
    let last = { ok: false, code: 'NO_EVENT', HISTORY_SYNC_COMPLETE: false };
    for (let i = 0; i < events.length; i += 1) last = await acceptHistoryEvent(events[i]);
    return last;
  }

  function historyAckStorageKey(accountP) {
    return 'sos-hist-ack-' + accountP;
  }

  function readAckState(accountP) {
    try { return JSON.parse(localStorage.getItem(historyAckStorageKey(accountP)) || 'null') || {}; } catch (_e) { return {}; }
  }

  function writeAckState(accountP, state) {
    try { localStorage.setItem(historyAckStorageKey(accountP), JSON.stringify(state)); } catch (_e) {}
  }

  function historyFingerprint(book) {
    const missingPages = [];
    const pageCount = Number(book && book.pageCount) || 0;
    for (let i = 0; i < pageCount; i += 1) if (!book.seen || book.seen[i] !== true) missingPages.push(i);
    return [
      book.snapshotId || '',
      Object.keys(book.seen || {}).length,
      book.filesDone || 0,
      book.verifiedBytes || 0,
      missingPages.length,
      book.unavailable || 0,
      root.__sosLdHistorySync && root.__sosLdHistorySync.HISTORY_FULL_SYNC_COMPLETE ? 1 : 0,
    ].join('|');
  }

  let historyAckFlight = '';

  function noteAckConfirmed(fingerprint, snapshotId) {
    const session = getAccountSession();
    if (!fingerprint || session.role !== 'LINKED_DEVICE') return;
    const state = readAckState(session.accountP);
    if (state.fingerprint === fingerprint || (snapshotId && state.snapshotId === snapshotId && state.fingerprint === fingerprint)) {
      state.confirmed = true;
      writeAckState(session.accountP, state);
      try { console.log('SNAPSHOT_ACK_CONFIRMED snapshot=' + String(snapshotId || '').slice(0, 8)); } catch (_c) {}
    }
  }

  function scheduleHistoryAck(book, reason) {
    const session = getAccountSession();
    if (!book || session.role !== 'LINKED_DEVICE') return;
    const settled = historyJobSettled(book);
    const fp = historyFingerprint(book);
    const state = readAckState(session.accountP);
    const same = state.snapshotId === book.snapshotId && state.fingerprint === fp;
    const full = root.__sosLdHistorySync && root.__sosLdHistorySync.HISTORY_FULL_SYNC_COMPLETE === true;
    if (same && state.confirmed === true) return;
    if (historyAckFlight === fp) return;
    const pages = Object.keys(book.seen || {}).length;
    const files = book.filesDone || 0;
    if (!same && !full && !settled && reason !== 'text' && reason !== 'final' && reason !== 'retry') {
      if ((pages - (state.pages || 0)) < 4 && (files - (state.files || 0)) < 4) return;
    }
    if (same && reason !== 'retry') return;
    if (same && ((state.retries || 0) >= 2 || Date.now() - (state.sentAt || 0) < 20000)) return;
    acknowledgeHistorySnapshot(book, fp).catch(function () {});
  }

  async function acknowledgeHistorySnapshot(book, fingerprint) {
    const session = getAccountSession();
    if (!book || session.role !== 'LINKED_DEVICE') return { ok: false };
    const fp = fingerprint || historyFingerprint(book);
    if (historyAckFlight === fp) return { ok: false, code: 'ACK_IN_FLIGHT' };
    const prior = readAckState(session.accountP);
    if (prior.snapshotId === book.snapshotId && prior.fingerprint === fp && prior.confirmed === true) return { ok: true, duplicate: true };
    historyAckFlight = fp;
    const missingPages = [];
    const pageCount = Number(book.pageCount) || 0;
    for (let i = 0; i < pageCount; i += 1) if (!book.seen || book.seen[i] !== true) missingPages.push(i);
    const body = JSON.stringify({
      v: 2,
      type: HIST_ACK_TAG,
      accountP: session.accountP,
      deviceId: session.deviceId,
      devicePub: session.deviceSignPub,
      snapshotId: book.snapshotId || '',
      fingerprint: fp,
      pages: Object.keys(book.seen || {}).length,
      pageCount: pageCount,
      messages: book.count || 0,
      files: book.filesDone || 0,
      verifiedBytes: book.verifiedBytes || 0,
      missingPages: missingPages,
      missingAttachments: Array.isArray(book.missingFiles) ? book.missingFiles.slice(0, 32) : [],
      HISTORY_TEXT_SYNC_COMPLETE: root.__sosLdHistorySync && root.__sosLdHistorySync.HISTORY_TEXT_SYNC_COMPLETE === true,
      HISTORY_FULL_SYNC_COMPLETE: root.__sosLdHistorySync && root.__sosLdHistorySync.HISTORY_FULL_SYNC_COMPLETE === true,
    });
    try {
      const built = await delegatedChatEncrypt(session.accountP, body, 'hist-ack-' + fp.slice(0, 24), { sibling: true, extraTags: [['t', HIST_ACK_TAG]] });
      if (!built || built.ok !== true || !built.event) {
        try { console.log('HISTORY_ACK_FAIL code=' + String((built && built.code) || 'NO_EVENT')); } catch (_fail) {}
        return { ok: false, code: built && built.code };
      }
      const pool = App.pool;
      if (!pool || typeof pool.publish !== 'function') return { ok: false, code: 'NO_POOL' };
      const pending = pool.publish(App.relayUrls, built.event);
      const ackStarted = Date.now();
      const jobs = Array.isArray(pending) ? pending : [pending];
      const settled = await Promise.all(jobs.map(function (p) {
        return Promise.race([
          Promise.resolve(p).then(function () { return 'ok'; }, function () { return 'no'; }),
          new Promise(function (resolve) { setTimeout(function () { resolve('timeout'); }, 8000); }),
        ]);
      }));
      if (!settled.some(function (r) { return r === 'ok'; })) {
        try { console.log('HISTORY_ACK_FAIL code=RELAY_REJECTED'); } catch (_fail) {}
        return { ok: false, code: 'RELAY_REJECTED' };
      }
      const next = {
        snapshotId: book.snapshotId || '',
        fingerprint: fp,
        pages: Object.keys(book.seen || {}).length,
        files: book.filesDone || 0,
        confirmed: false,
        sentAt: Date.now(),
        retries: prior.fingerprint === fp ? (prior.retries || 0) + 1 : 0,
        textAck: book.textAcked || '',
      };
      writeAckState(session.accountP, next);
      book._ackFiles = book.filesDone || 0;
      try { console.log('HISTORY_DESTINATION_ACK snapshot=' + String(book.snapshotId || '').slice(0, 8) + ' pages=' + next.pages + ' files=' + next.files + ' bytes=' + (book.verifiedBytes || 0)); } catch (_a) {}
      try { console.log('RECEIVER_FILE_ACK_SENT snapshot=' + String(book.snapshotId || '').slice(0, 8) + ' files=' + next.files + ' bytes=' + (book.verifiedBytes || 0)); } catch (_ack) {}
      if (historyJobSettled(book)) {
        try { console.log('SNAPSHOT_FINAL_ACK_SENT snapshot=' + String(book.snapshotId || '').slice(0, 8) + ' files=' + next.files + ' missing=' + historyMissingCount(book)); } catch (_final) {}
      }
      try { console.log('HISTORY_TIMING phase=FINAL_ACK_MS ms=' + (Date.now() - ackStarted)); } catch (_t) {}
      setTimeout(function () {
        const again = readAckState(session.accountP);
        if (again.fingerprint === fp && again.confirmed !== true) scheduleHistoryAck(book, 'retry');
      }, 20000);
      return { ok: true };
    } finally {
      if (historyAckFlight === fp) historyAckFlight = '';
    }
  }

  async function pushHistoryMediaP2P(peer, files) {
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return { ok: true, transport: 'none' };
    root.__sosHistP2P = root.__sosHistP2P || {};
    const current = root.__sosHistP2P[peer];
    if (!current || !current.length || !list[0] || current[0].snapshotId !== list[0].snapshotId) {
      root.__sosHistP2P[peer] = list;
    }
    return sendPendingHistoryMedia(peer);
  }

  function armHistoryMediaRetry(peer) {
    const row = historyPeerState(peer);
    if (row.timer) return;
    const wait = Math.max(1000, (row.next || (Date.now() + 15000)) - Date.now());
    row.timer = setTimeout(function () {
      row.timer = null;
      if (historyPageSuspended()) {
        noteHistoryDevice(peer, 'SUSPENDED');
        return;
      }
      sendPendingHistoryMedia(peer).catch(function () {});
    }, wait);
  }

  async function probeHistoryPeer(peer) {
    const row = historyPeerState(peer);
    if (historyPageSuspended()) return noteHistoryDevice(peer, 'SUSPENDED');
    const dc = App.dataChannel;
    if (dc && typeof dc.isConnected === 'function' && dc.isConnected(peer)) {
      row.fails = 0;
      row.next = 0;
      return noteHistoryDevice(peer, 'DATA_CHANNEL_OPEN');
    }
    if (Date.now() < row.next) return row.state || 'OFFLINE';
    if (row.probing) return row.probing;
    noteHistoryDevice(peer, 'P2P_CONNECTING');
    row.probing = (async function () {
      let open = false;
      try {
        if (dc && typeof dc.forceConnect === 'function') {
          await Promise.race([
            Promise.resolve(dc.forceConnect(peer)),
            new Promise(function (resolve) { setTimeout(resolve, 8000); }),
          ]);
        }
      } catch (_e) {}
      open = !!(dc && typeof dc.isConnected === 'function' && dc.isConnected(peer));
      row.probing = null;
      if (open) {
        row.fails = 0;
        row.next = 0;
        return noteHistoryDevice(peer, 'DATA_CHANNEL_OPEN');
      }
      row.fails += 1;
      const base = Math.min(120000, 15000 * Math.pow(2, Math.min(row.fails - 1, 3)));
      row.next = Date.now() + base + Math.floor(Math.random() * 4000);
      return noteHistoryDevice(peer, 'WAITING_FOR_DEVICE');
    })();
    return row.probing;
  }

  function interactiveTransferBusy() {
    const map = App.activeP2PTransfers;
    if (!map || typeof map.forEach !== 'function') return false;
    let busy = false;
    map.forEach(function (transfer) {
      if (transfer && transfer.historySync !== true && transfer.completed !== true) busy = true;
    });
    return busy;
  }

  async function sendPendingHistoryMedia(peer) {
    const files = (root.__sosHistP2P && root.__sosHistP2P[peer]) || [];
    const pending = files.filter(function (file) { return file && !file.sent; });
    const row = historyPeerState(peer);
    if (!pending.length) {
      if (row.timer) { clearTimeout(row.timer); row.timer = null; }
      root.__sosHistSyncActive = false;
      return { ok: true };
    }
    if (row.sending) return row.sending;
    row.sending = (async function () {
      if (historyPageSuspended()) {
        noteHistoryDevice(peer, 'SUSPENDED');
        try { console.log('HISTORY_MEDIA_WAIT device=' + peer.slice(0, 8) + ' state=SUSPENDED files=' + pending.length); } catch (_w) {}
        return { ok: false, code: 'SUSPENDED', transport: 'pending' };
      }
      if (typeof App.sendHistoryMedia !== 'function') {
        pending.forEach(function (file) { file.pending = 'P2P_UNAVAILABLE'; });
        return { ok: false, code: 'P2P_UNAVAILABLE', transport: 'pending' };
      }
      const reach = await probeHistoryPeer(peer);
      if (reach !== 'DATA_CHANNEL_OPEN') {
        pending.forEach(function (file) { file.pending = reach === 'SUSPENDED' ? 'SUSPENDED' : 'WAITING_FOR_DEVICE'; });
        try {
          console.log('HISTORY_MEDIA_WAIT device=' + peer.slice(0, 8) + ' state=' + reach + ' files=' + pending.length + ' nextMs=' + Math.max(0, (row.next || 0) - Date.now()));
        } catch (_wait) {}
        if (reach !== 'SUSPENDED') armHistoryMediaRetry(peer);
        return { ok: false, code: 'WAITING_FOR_DEVICE', transport: 'pending' };
      }
      root.__sosHistFileFlight = root.__sosHistFileFlight || {};
      try {
        for (let i = 0; i < pending.length; i += 1) {
          const file = pending[i];
          if (!file || file.sent) continue;
          if (historyPageSuspended()) {
            noteHistoryDevice(peer, 'SUSPENDED');
            break;
          }
          if (interactiveTransferBusy() || (root.__sosChatIntentUntil && Date.now() < root.__sosChatIntentUntil)) {
            row.next = Date.now() + 1200;
            armHistoryMediaRetry(peer);
            break;
          }
          await new Promise(function (resolve) { setTimeout(resolve, 40); });
          const flightKey = peer + ':' + String(file.snapshotId || '') + ':' + String(file.fileId || '');
          if (root.__sosHistFileFlight[flightKey]) continue;
          root.__sosHistFileFlight[flightKey] = true;
          const started = Date.now();
          let result = null;
          root.__sosHistSyncActive = true;
          try { result = await App.sendHistoryMedia(peer, file.blob, file); } catch (err) {
            result = { ok: false, code: String((err && err.message) || 'P2P_FAILED') };
          } finally {
            root.__sosHistSyncActive = false;
            delete root.__sosHistFileFlight[flightKey];
          }
          const ms = Date.now() - started;
          try {
            console.log('HISTORY_MEDIA_TIMING snapshot=' + String(file.snapshotId || '').slice(0, 8) + ' file=' + String(file.fileId || '').slice(0, 16) + ' logical=' + String(file.logicalMessageId || '').slice(0, 24) + ' bytes=' + (file.size || 0) + ' transport=' + ((result && result.transport) || 'pending') + ' ms=' + ms + ' code=' + String((result && result.code) || ''));
          } catch (_log) {}
          if (result && result.ok === true) {
            file.sent = true;
            try { console.log('SOURCE_FILE_SENT snapshot=' + String(file.snapshotId || '').slice(0, 8) + ' file=' + String(file.fileId || '').slice(0, 16) + ' logical=' + String(file.logicalMessageId || '').slice(0, 24) + ' bytes=' + (file.size || 0)); } catch (_sent) {}
            writeHistCheckpoint(peer, { snapshotId: file.snapshotId, inventoryKey: (root.__sosHistOutbound && root.__sosHistOutbound[peer] && root.__sosHistOutbound[peer].inventoryKey) || '', p2pFiles: files });
          } else {
            const code = String((result && result.code) || 'P2P_UNAVAILABLE');
            file.pending = code;
            const deviceDown = /SIGNAL|TIMEOUT|WAITING|CLOSED|UNAVAILABLE|OFFLINE|SUSPENDED|CONNECT/i.test(code);
            if (deviceDown) {
              row.fails += 1;
              const base = Math.min(120000, 15000 * Math.pow(2, Math.min(row.fails - 1, 3)));
              row.next = Date.now() + base + Math.floor(Math.random() * 4000);
              noteHistoryDevice(peer, 'WAITING_FOR_DEVICE');
              armHistoryMediaRetry(peer);
              break;
            }
          }
        }
      } finally {
        root.__sosHistSyncActive = false;
      }
      return { ok: pending.every(function (file) { return file.sent; }), transport: 'p2p' };
    })();
    try { return await row.sending; } finally { row.sending = null; }
  }

  async function noteHistoryMediaReceived(info) {
    const book = root.__sosLdHistoryPages;
    const fileId = String(info && info.fileId || '');
    if (!book || !fileId) return { ok: false, code: 'NO_BOOK' };
    const expected = book.expectedFiles && book.expectedFiles[fileId];
    if (!expected) return { ok: false, code: 'UNEXPECTED_FILE' };
    if (expected.sha256 && info.sha256 && expected.sha256 !== info.sha256) {
      book.missingFiles = book.missingFiles || [];
      if (!book.missingFiles.some(function (row) { return row && row.fileId === fileId; })) {
        book.missingFiles.push({ fileId: fileId, logicalMessageId: expected.logicalMessageId, reason: 'PERMANENT_FAILURE' });
      }
      historyProgress(book);
      if (historyJobSettled(book)) scheduleHistoryAck(book, 'final');
      return { ok: false, code: 'MEDIA_HASH_MISMATCH' };
    }
    try { console.log('RECEIVER_HASH_VERIFIED file=' + fileId.slice(0, 16) + ' logical=' + String(expected.logicalMessageId || '').slice(0, 24)); } catch (_hash) {}
    book.p2pDone = book.p2pDone || {};
    if (book.p2pDone[fileId]) return { ok: true, duplicate: true };
    let stored = false;
    const writeStarted = Date.now();
    try {
      if (info.blob && typeof App.persistChatP2PMedia === 'function') {
        await App.persistChatP2PMedia(fileId, info.blob, { name: info.name || '', type: info.mime || '' });
        const saved = typeof App.loadChatP2PMediaBlob === 'function' ? await App.loadChatP2PMediaBlob('p2p-file-' + fileId) : info.blob;
        stored = !!(saved && saved.size > 0);
      }
    } catch (_store) { stored = false; }
    try { console.log('HISTORY_TIMING phase=INDEXEDDB_WRITE_MS ms=' + (Date.now() - writeStarted) + ' file=' + fileId.slice(0, 16) + ' ok=' + (stored ? '1' : '0')); } catch (_w) {}
    if (stored) {
      try { console.log('RECEIVER_INDEXEDDB_WRITE_OK file=' + fileId.slice(0, 16)); } catch (_ok) {}
      try { console.log('RECEIVER_READBACK_VERIFIED file=' + fileId.slice(0, 16)); } catch (_rb) {}
    }
    if (!stored) {
      book.missingFiles = book.missingFiles || [];
      if (!book.missingFiles.some(function (row) { return row && row.fileId === fileId; })) {
        book.missingFiles.push({ fileId: fileId, logicalMessageId: expected.logicalMessageId, reason: 'PERSIST_FAILED' });
      }
      book.uiFull = false;
      historyProgress(book);
      if (historyJobSettled(book)) scheduleHistoryAck(book, 'final');
      return { ok: false, code: 'PERSIST_FAILED' };
    }
    book.p2pDone[fileId] = true;
    if (Array.isArray(book.sourceMissing)) {
      book.sourceMissing = book.sourceMissing.filter(function (row) { return String(row && row.fileId || '') !== fileId; });
      book.unavailable = book.sourceMissing.length;
    }
    book.filesDone = (book.filesDone || 0) + 1;
    book.verifiedBytes = (book.verifiedBytes || 0) + (Number(info.size) || expected.size || 0);
    book.p2pBytes = (book.p2pBytes || 0) + (Number(info.size) || 0);
    book.transport = 'p2p';
    if (Number(info.bytesPerSec) > 0) book.bytesPerSec = Number(info.bytesPerSec);
    book.waitingDevice = false;
    try {
      const url = URL.createObjectURL(info.blob);
      const conv = App.chatState && App.chatState.conversations;
      if (conv && typeof conv.forEach === 'function') {
        conv.forEach(function (entry) {
          (entry.messages || []).forEach(function (msg) {
            if (!msg || String(msg.logicalMessageId || '') !== String(expected.logicalMessageId)) return;
            if (!msg.attachment) msg.attachment = {};
            msg.attachment.url = url;
            msg.attachment.cacheKey = 'p2p-file-' + fileId;
            msg.attachment.sha256 = info.sha256 || expected.sha256 || '';
          });
        });
      }
      if (typeof App.persistChatState === 'function') App.persistChatState();
    } catch (_url) {}
    const sync = root.__sosLdHistorySync || {};
    const filesDone = (book.attachmentCount || 0) === 0 || (book.filesDone || 0) >= book.attachmentCount;
    const full = sync.HISTORY_TEXT_SYNC_COMPLETE === true && filesDone && (book.unavailable || 0) === 0 && !(book.missingFiles && book.missingFiles.length);
    book.uiFull = full;
    root.__sosLdHistorySync = Object.assign({}, sync, {
      ok: true,
      filesDone: book.filesDone,
      verifiedBytes: book.verifiedBytes,
      HISTORY_ATTACHMENTS_SYNC_COMPLETE: filesDone,
      HISTORY_FULL_SYNC_COMPLETE: full,
      HISTORY_SYNC_COMPLETE: full,
      FAKE_HISTORY_SYNC: false,
    });
    historyProgress(book);
    scheduleHistoryAck(book, full ? 'final' : 'file');
    try { console.log('HISTORY_MEDIA_P2P file=' + fileId.slice(0, 16) + ' bytes=' + (info.size || 0)); } catch (_p) {}
    return { ok: true };
  }

  async function confirmHistoryAck(event) {
    if (!primaryReady()) return { ok: false, code: 'NOT_PRIMARY' };
    const delegated = await verifyDelegatedEvent(event, '');
    if (!delegated || delegated.ok !== true) return { ok: false, code: (delegated && delegated.code) || 'DELEGATION_REJECTED' };
    let env;
    try { env = JSON.parse(event.content); } catch (_e) { return { ok: false, code: 'BAD_ENVELOPE' }; }
    let payload;
    try {
      payload = await Promise.resolve(App.SosCryptoSigner.nip44ChatDecrypt({
        localPubkey: App.publicKey,
        eventAuthorPubkey: event.pubkey,
        encryptedEnvelope: env,
        selfAuthored: false,
        intendedRecipientPubkey: App.publicKey,
      }));
    } catch (_dec) { return { ok: false, code: 'DECRYPT_FAILED' }; }
    let body;
    try { body = JSON.parse(payload && payload.text ? payload.text : ''); } catch (_p) { return { ok: false, code: 'BAD_ACK' }; }
    if (!body || body.type !== HIST_ACK_TAG || norm(body.accountP) !== norm(App.publicKey)) return { ok: false, code: 'BAD_ACK' };
    const fp = String(body.fingerprint || body.snapshotId || '');
    root.__sosHistAckOkSent = root.__sosHistAckOkSent || {};
    root.__sosHistAckAttempts = root.__sosHistAckAttempts || {};
    root.__sosHistAckFlight = root.__sosHistAckFlight || {};
    if (root.__sosHistAckOkSent[fp]) return { ok: true, duplicate: true };
    if ((root.__sosHistAckAttempts[fp] || 0) >= 3) return { ok: false, code: 'ACK_CONFIRM_EXHAUSTED' };
    if (root.__sosHistAckFlight[fp]) return { ok: false, code: 'ACK_CONFIRM_IN_FLIGHT' };
    root.__sosHistAckFlight[fp] = true;
    try {
      try {
        console.log('PHONE_HISTORY_ACK snapshot=' + String(body.snapshotId || '').slice(0, 8) + ' pages=' + (body.pages || 0) + ' files=' + (body.files || 0) + ' bytes=' + (body.verifiedBytes || 0));
        console.log('SOURCE_FILE_ACK_RECEIVED snapshot=' + String(body.snapshotId || '').slice(0, 8) + ' files=' + (body.files || 0) + ' bytes=' + (body.verifiedBytes || 0));
      } catch (_log) {}
      const okBody = JSON.stringify({ v: 1, type: 'sos-hist-ack-ok', accountP: norm(App.publicKey), snapshotId: body.snapshotId || '', fingerprint: fp });
      const sent = await publishHistoryPage(delegated.deviceSignPub, Math.floor(Date.now() / 1000), 0, 1, okBody);
      if (sent && sent.ok) {
        root.__sosHistAckOkSent[fp] = true;
        try { console.log('SOURCE_SNAPSHOT_ACK_CONFIRMED snapshot=' + String(body.snapshotId || '').slice(0, 8) + ' files=' + (body.files || 0)); } catch (_ok) {}
        return { ok: true };
      }
      root.__sosHistAckAttempts[fp] = (root.__sosHistAckAttempts[fp] || 0) + 1;
      if (root.__sosHistAckAttempts[fp] < 3) {
        setTimeout(function () { confirmHistoryAck(event).catch(function () {}); }, 5000);
      }
      return { ok: false, code: (sent && sent.code) || 'ACK_CONFIRM_FAILED' };
    } finally {
      delete root.__sosHistAckFlight[fp];
    }
  }

  function scheduleHistoryRequestRetry() {
    if (root.__sosHistReqTimer) return;
    const sync = root.__sosLdHistorySync;
    if (sync && sync.HISTORY_TEXT_SYNC_COMPLETE === true) return;
    let tries = Number(root.__sosHistReqTries) || 0;
    const wait = Math.min(120000, 30000 * Math.pow(2, Math.min(tries, 3))) + Math.floor(Math.random() * 4000);
    root.__sosHistReqTimer = setTimeout(function () {
      root.__sosHistReqTimer = null;
      const done = root.__sosLdHistorySync && root.__sosLdHistorySync.HISTORY_TEXT_SYNC_COMPLETE === true;
      if (done || tries >= 4) return;
      root.__sosHistReqTries = tries + 1;
      if (historyPageSuspended()) {
        root.__sosHistReqDeferred = true;
        return;
      }
      pullLinkedHistory().catch(function () {});
      requestLinkedHistory().catch(function () {});
    }, wait);
  }

  async function requestLinkedHistory() {
    const session = getAccountSession();
    if (session.role !== 'LINKED_DEVICE' || session.verified !== true) return { ok: false, code: 'NOT_LINKED' };
    if (historyPageSuspended()) {
      root.__sosHistReqDeferred = true;
      return { ok: false, code: 'SUSPENDED' };
    }
    if (root.__sosHistReqFlight) return root.__sosHistReqFlight;
    if (!allows('READ_CONVERSATIONS') && session.caps.indexOf('DEVICE_HISTORY_SYNC') === -1 && session.caps.indexOf('DEVICE_CHAT') === -1) {
      return { ok: false, code: 'CAPABILITY_DENIED' };
    }
    const book = root.__sosLdHistoryPages || {};
    const syncRequestId = 'hsr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    root.__sosHistReqFlight = (async function () {
    const payload = {
      v: 1,
      type: HIST_REQ_TAG,
      accountP: session.accountP,
      deviceId: session.deviceId,
      devicePub: session.deviceSignPub,
      sessionId: session.deviceId,
      syncRequestId: syncRequestId,
      protocol: 2,
      checkpoint: {
        snapshotId: book.snapshotId || '',
        havePages: Object.keys(book.seen || {}).map(function (n) { return Number(n); }),
      },
      scope: 'recent',
      since: Math.floor(Date.now() / 1000) - HIST_RECENT_SEC,
    };
    const built = await delegatedChatEncrypt(session.accountP, JSON.stringify(payload), syncRequestId, { sibling: true, extraTags: [['t', HIST_REQ_TAG]] });
    if (!built || built.ok !== true || !built.event) return { ok: false, code: (built && built.code) || 'REQUEST_FAILED' };
    const pool = App.pool;
    if (!pool || typeof pool.publish !== 'function') return { ok: false, code: 'NO_POOL' };
    const pending = pool.publish(App.relayUrls, built.event);
    const settled = await Promise.allSettled((Array.isArray(pending) ? pending : [pending]).map(function (p) { return Promise.resolve(p); }));
    const accepted = settled.some(function (r) { return r.status === 'fulfilled'; });
    try { console.log('DESKTOP_HISTORY_SYNC_REQUEST id=' + syncRequestId + ' ok=' + (accepted ? '1' : '0')); } catch (_r) {}
    setTimeout(function () { pullLinkedHistory().catch(function () {}); }, 3000);
    scheduleHistoryRequestRetry();
    return { ok: accepted, syncRequestId: syncRequestId };
    })();
    try { return await root.__sosHistReqFlight; } finally { root.__sosHistReqFlight = null; }
  }

  async function requestOlderHistory(conversationId) {
    const session = getAccountSession();
    if (session.role !== 'LINKED_DEVICE' || session.verified !== true) return { ok: false, code: 'NOT_LINKED', FULL_BACKUP_COMPLETE: false };
    if (!allows('READ_CONVERSATIONS') && session.caps.indexOf('DEVICE_HISTORY_SYNC') === -1 && session.caps.indexOf('DEVICE_CHAT') === -1) {
      return { ok: false, code: 'CAPABILITY_DENIED', FULL_BACKUP_COMPLETE: false };
    }
    const peer = norm(conversationId);
    if (!isHex64(peer)) return { ok: false, code: 'BAD_CONVERSATION', FULL_BACKUP_COMPLETE: false };
    const cursor = readOlderCursor(session.accountP, peer);
    if (cursor && cursor.hasMore === false) return { ok: true, code: 'END', cursor: cursor, FULL_BACKUP_COMPLETE: false };
    const loaded = oldestLoadedMessage(peer);
    const floor = Math.floor(Date.now() / 1000) - HIST_RECENT_SEC;
    const loadedTs = loaded.ts || floor;
    const before = cursor && cursor.nextOlderBoundary ? Number(cursor.nextOlderBoundary) : Math.min(loadedTs, floor);
    if (!before) return { ok: false, code: 'NO_BOUNDARY', FULL_BACKUP_COMPLETE: false };
    const flightKey = peer + ':' + before;
    root.__sosOlderReqFlight = root.__sosOlderReqFlight || {};
    if (root.__sosOlderReqFlight[flightKey]) return root.__sosOlderReqFlight[flightKey];
    const requestId = 'hor-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    root.__sosOlderReqFlight[flightKey] = (async function () {
      const payload = {
        v: 1,
        type: HIST_REQ_TAG,
        accountP: session.accountP,
        deviceId: session.deviceId,
        devicePub: session.deviceSignPub,
        sessionId: session.deviceId,
        syncRequestId: requestId,
        protocol: 2,
        scope: 'older',
        conversationId: peer,
        before: before,
        windowSeconds: HIST_OLDER_SEC,
        requestId: requestId,
      };
      const built = await delegatedChatEncrypt(session.accountP, JSON.stringify(payload), requestId, { sibling: true, extraTags: [['t', HIST_REQ_TAG]] });
      if (!built || built.ok !== true || !built.event) return { ok: false, code: (built && built.code) || 'REQUEST_FAILED', FULL_BACKUP_COMPLETE: false };
      const pool = App.pool;
      if (!pool || typeof pool.publish !== 'function') return { ok: false, code: 'NO_POOL', FULL_BACKUP_COMPLETE: false };
      const pending = pool.publish(App.relayUrls, built.event);
      const settled = await Promise.allSettled((Array.isArray(pending) ? pending : [pending]).map(function (p) { return Promise.resolve(p); }));
      const accepted = settled.some(function (r) { return r.status === 'fulfilled'; });
      try { console.log('DESKTOP_OLDER_HISTORY_REQUEST peer=' + peer.slice(0, 8) + ' before=' + before + ' ok=' + (accepted ? '1' : '0')); } catch (_r) {}
      if (!accepted) {
        root.__sosOlderWait = root.__sosOlderWait || {};
        root.__sosOlderWait[peer] = 'offline';
        return { ok: false, code: 'RELAY_REJECTED', FULL_BACKUP_COMPLETE: false };
      }
      root.__sosOlderPending = root.__sosOlderPending || {};
      root.__sosOlderPending[peer] = { before: before, requestId: requestId, at: Date.now() };
      setTimeout(function () {
        const pendingRow = root.__sosOlderPending && root.__sosOlderPending[peer];
        if (!pendingRow || pendingRow.requestId !== requestId) return;
        const saved = readOlderCursor(session.accountP, peer);
        if (saved && saved.requestId === requestId) return;
        root.__sosOlderWait = root.__sosOlderWait || {};
        root.__sosOlderWait[peer] = 'offline';
        try { root.dispatchEvent(new CustomEvent('sos-older-waiting', { detail: { peer: peer } })); } catch (_ev) {}
      }, 20000);
      return { ok: true, requestId: requestId, before: before, FULL_BACKUP_COMPLETE: false };
    })();
    try { return await root.__sosOlderReqFlight[flightKey]; } finally { delete root.__sosOlderReqFlight[flightKey]; }
  }

  async function acceptHistoryRequest(event) {
    if (!primaryReady()) return { ok: false, code: 'NOT_PRIMARY' };
    root.__sosHistReqSeen = root.__sosHistReqSeen || {};
    if (root.__sosHistReqSeen && Object.keys(root.__sosHistReqSeen).length > 240) root.__sosHistReqSeen = {};
    const eid = String(event && event.id || '');
    if (eid && root.__sosHistReqSeen[eid]) return { ok: true, duplicate: true };
    if (eid) root.__sosHistReqSeen[eid] = true;
    const created = Number(event && event.created_at) || 0;
    if (created && (Math.floor(Date.now() / 1000) - created) > 600) {
      if (eid) root.__sosHistReqSeen[eid] = true;
      return { ok: false, code: 'STALE_REQUEST' };
    }
    const delegated = await verifyDelegatedEvent(event, '');
    if (!delegated || delegated.ok !== true) return { ok: false, code: (delegated && delegated.code) || 'DELEGATION_REJECTED' };
    if (norm(delegated.accountP) !== norm(App.publicKey)) return { ok: false, code: 'ACCOUNT_MISMATCH' };
    const caps = Array.isArray(delegated.caps) ? delegated.caps : [];
    if (caps.indexOf('DEVICE_HISTORY_SYNC') === -1 && caps.indexOf('DEVICE_CHAT') === -1) return { ok: false, code: 'CAPABILITY_MISSING' };
    let env;
    try { env = JSON.parse(event.content); } catch (_e) { return { ok: false, code: 'BAD_ENVELOPE' }; }
    let payload;
    try {
      payload = await Promise.resolve(App.SosCryptoSigner.nip44ChatDecrypt({
        localPubkey: App.publicKey,
        eventAuthorPubkey: event.pubkey,
        encryptedEnvelope: env,
        selfAuthored: false,
        intendedRecipientPubkey: App.publicKey,
      }));
    } catch (_dec) {
      return { ok: false, code: 'DECRYPT_FAILED' };
    }
    let body;
    try { body = JSON.parse(payload && payload.text ? payload.text : ''); } catch (_p) { return { ok: false, code: 'BAD_REQUEST' }; }
    if (!body || body.type !== HIST_REQ_TAG || norm(body.accountP) !== norm(App.publicKey)) return { ok: false, code: 'BAD_REQUEST' };
    if (norm(body.devicePub) !== delegated.deviceSignPub) return { ok: false, code: 'DEVICE_MISMATCH' };
    if (body.scope === 'older') {
      try { console.log('PHONE_OLDER_HISTORY_REQUEST device=' + delegated.deviceSignPub.slice(0, 8) + ' peer=' + String(body.conversationId || '').slice(0, 8)); } catch (_old) {}
      return publishOlderHistoryBundle(delegated.deviceSignPub, {
        scope: 'older',
        conversationId: body.conversationId,
        before: body.before,
        requestId: body.requestId || body.syncRequestId || '',
      });
    }
    const rid = String(body.syncRequestId || '');
    if (rid && root.__sosHistReqSeen['r:' + rid]) return { ok: true, duplicate: true };
    if (rid) root.__sosHistReqSeen['r:' + rid] = true;
    root.__sosHistReqLatest = root.__sosHistReqLatest || {};
    const latest = root.__sosHistReqLatest[delegated.deviceSignPub];
    if (latest && created && latest.created > created) return { ok: true, duplicate: true };
    if (latest && latest.promise && latest.at && (Date.now() - latest.at) < 25000) return latest.promise;
    try { console.log('PHONE_HISTORY_REQUEST_RECEIVED device=' + delegated.deviceSignPub.slice(0, 8) + ' id=' + String(body.syncRequestId || '').slice(0, 16)); } catch (_log) {}
    const promise = publishLinkedHistoryBundle(delegated.deviceSignPub, { checkpoint: body.checkpoint || null, syncRequestId: body.syncRequestId || '' });
    root.__sosHistReqLatest[delegated.deviceSignPub] = { created: created, at: Date.now(), promise: promise };
    return promise;
  }

  async function pullLinkedDirectMessages() {
    const session = getAccountSession();
    if (session.role !== 'LINKED_DEVICE' || !session.verified || !allows('READ_CONVERSATIONS')) {
      return { ok: false, code: 'NOT_LINKED' };
    }
    const pool = App.pool;
    if (!pool || !isHex64(session.deviceSignPub)) return { ok: false, code: 'NO_POOL' };
    const filter = { kinds: [1050], '#p': [session.deviceSignPub], '#t': ['yalachat'], limit: 20 };
    let events = [];
    try {
      if (typeof pool.list === 'function') events = await pool.list(App.relayUrls, [filter]);
      else if (typeof pool.querySync === 'function') events = await pool.querySync(App.relayUrls, filter);
    } catch (_e) {
      return { ok: false, code: 'QUERY_FAILED' };
    }
    if (!Array.isArray(events)) events = [];
    for (let i = 0; i < events.length; i += 1) {
      if (typeof App.handleIncomingChatEvent === 'function') {
        try { await App.handleIncomingChatEvent(events[i]); } catch (_in) {}
      }
    }
    root.__sosLdChatPull = { n: events.length };
    return { ok: true, n: events.length };
  }

  async function announceLinkedDevice() {
    const session = getAccountSession();
    if (session.role !== 'LINKED_DEVICE' || session.verified !== true) return { ok: false, code: 'NOT_LINKED' };
    const Store = App.Md4DeviceStore || root.SosMd4DeviceStore;
    if (!Store || typeof Store.loadLatest !== 'function') return { ok: false, code: 'NO_STORE' };
    let loaded;
    try { loaded = await Store.loadLatest(); } catch (_e) { return { ok: false, code: 'NO_STORE' }; }
    if (!loaded || loaded.ok !== true || !loaded.authorization) return { ok: false, code: 'NO_AUTH' };
    const pool = App.pool;
    const NT = root.NostrTools;
    if (!pool || typeof pool.publish !== 'function' || !NT || typeof NT.finalizeEvent !== 'function') return { ok: false, code: 'NO_POOL' };
    return withDevice(async function (dev) {
      if (norm(dev.pub) !== norm(loaded.D_sign_pub)) return { ok: false, code: 'DEVICE_MISMATCH' };
      const event = NT.finalizeEvent({
        kind: 30078,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'sos-device-directory'],
          ['p', session.accountP],
          ['t', 'sos-devdir-v1'],
        ],
        content: JSON.stringify({
          v: 1,
          authorization: loaded.authorization,
          deviceLabel: directoryDeviceLabel(),
        }),
      }, hexToBytes(dev.privHex));
      const published = pool.publish(App.relayUrls, event);
      const pending = Array.isArray(published) ? published : [published];
      const settled = await Promise.allSettled(pending.map(function (p) { return Promise.resolve(p); }));
      const accepted = settled.some(function (r) { return r.status === 'fulfilled'; });
      return accepted ? { ok: true, device: session.deviceSignPub.slice(0, 8) } : { ok: false, code: 'RELAY_REJECTED' };
    });
  }

  function flattenRelayEvents(raw) {
    const out = [];
    const stack = Array.isArray(raw) ? raw.slice() : (raw ? [raw] : []);
    while (stack.length) {
      const item = stack.shift();
      if (!item) continue;
      if (Array.isArray(item)) { stack.push.apply(stack, item); continue; }
      if (item.kind && item.pubkey && item.id) out.push(item);
    }
    return out;
  }

  const REVOKE_TAG = 'sos-device-revocation';
  const revokeCache = {};
  let directoryHeartbeat = 0;

  async function loadRevocations(accountP, opts) {
    const account = norm(accountP);
    const fresh = !!(opts && opts.fresh);
    if (!isHex64(account)) return { ok: false, code: 'BAD_ACCOUNT', pubs: {}, ids: {}, list: [] };
    const hit = revokeCache[account];
    if (!fresh && hit && hit.exp > Date.now()) return hit.value;
    const pool = App.pool;
    const NT = root.NostrTools;
    if (!pool || !NT || typeof NT.verifyEvent !== 'function') {
      return { ok: false, code: 'NO_DIRECTORY', pubs: {}, ids: {}, list: [] };
    }
    const filter = { kinds: [30078], authors: [account], '#d': [REVOKE_TAG], limit: 3 };
    let raw = [];
    try {
      if (typeof pool.list === 'function') raw = await pool.list(App.relayUrls, [filter]);
      else if (typeof pool.querySync === 'function') raw = await pool.querySync(App.relayUrls, filter);
    } catch (_e) {
      return { ok: false, code: 'QUERY_FAILED', pubs: {}, ids: {}, list: [] };
    }
    const events = flattenRelayEvents(raw);
    let newest = null;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (norm(event.pubkey) !== account || verifyEventPlain(event).ok !== true) continue;
      const marked = (event.tags || []).some(function (tag) { return tag && tag[0] === 'd' && tag[1] === REVOKE_TAG; });
      if (!marked) continue;
      if (!newest || Number(event.created_at) >= Number(newest.created_at)) newest = event;
    }
    const pubs = {};
    const ids = {};
    const list = [];
    if (newest) {
      let body = null;
      try { body = JSON.parse(newest.content); } catch (_p) { body = null; }
      const rows = body && Array.isArray(body.revoked) ? body.revoked : [];
      for (let i = 0; i < rows.length && list.length < 32; i += 1) {
        const row = rows[i];
        const pub = norm(row && row.deviceSignPub);
        const id = norm(row && row.authorizationId);
        if (!isHex64(pub) || !isHex64(id) || pubs[pub]) continue;
        pubs[pub] = true;
        ids[id] = true;
        list.push({ deviceSignPub: pub, authorizationId: id, at: Math.max(1, Math.floor(Number(row.at) || Date.now())) });
      }
    }
    const value = { ok: true, code: newest ? 'REVOKED' : 'EMPTY', pubs: pubs, ids: ids, list: list };
    revokeCache[account] = { exp: Date.now() + 20000, value: value };
    return value;
  }

  function isRevokedDevice(rev, row) {
    if (!rev || rev.ok !== true || !row) return false;
    const pub = norm(row.deviceSignPub || row.D_sign_pub);
    const id = norm(row.authorizationId);
    return !!(pub && rev.pubs[pub]) || !!(id && rev.ids[id]);
  }

  async function classifyP2pSignalAuthor(authorPub) {
    const author = norm(authorPub);
    const session = getAccountSession();
    const account = session.role === 'LINKED_DEVICE' ? norm(session.accountP) : norm(App.publicKey);
    if (!isHex64(author) || !isHex64(account)) return { ok: false, code: 'BAD_ENDPOINT', SIGNAL_MD3_AUTHORIZED: false };
    const localDevice = session.role === 'LINKED_DEVICE' && session.verified === true ? norm(session.deviceSignPub) : '';
    if (localDevice && author === localDevice) return { ok: false, code: 'SELF_ENDPOINT', SIGNAL_MD3_AUTHORIZED: false };
    if (author === account) {
      if (!(session.role === 'LINKED_DEVICE' && session.verified === true && localDevice && localDevice !== account)) {
        return { ok: false, code: 'SELF_ACCOUNT', SIGNAL_MD3_AUTHORIZED: false };
      }
      const ownRev = await loadRevocations(account);
      if (isRevokedDevice(ownRev, { deviceSignPub: localDevice })) return { ok: false, code: 'REVOKED', SIGNAL_MD3_AUTHORIZED: false };
      if (!allows('SEND_CHAT') && !allows('READ_CONVERSATIONS')) return { ok: false, code: 'CAPABILITY_DENIED', SIGNAL_MD3_AUTHORIZED: false };
      return { ok: true, code: 'PRIMARY_TO_DEVICE', binding: 'PRIMARY_TO_DEVICE', accountP: account, SIGNAL_MD3_AUTHORIZED: true };
    }
    const resolved = await resolveDeviceAccount(author);
    if (resolved && resolved.ok !== true && resolved.code !== 'NO_DIRECTORY' && resolved.code !== 'QUERY_FAILED' && resolved.code !== 'BAD_DEVICE') {
      return { ok: false, code: resolved.code || 'UNAUTHORIZED', accountP: resolved.accountP || '', SIGNAL_MD3_AUTHORIZED: false };
    }
    if (resolved && resolved.ok === true && isHex64(resolved.accountP)) {
      const caps = Array.isArray(resolved.caps) ? resolved.caps : [];
      const signalCap = caps.indexOf('DEVICE_P2P') !== -1 || caps.indexOf('DEVICE_CHAT') !== -1;
      if (!signalCap) return { ok: false, code: 'CAPABILITY_DENIED', accountP: resolved.accountP, SIGNAL_MD3_AUTHORIZED: false };
      if (resolved.accountP === account) {
        return { ok: true, code: 'SAME_ACCOUNT_DEVICE', binding: 'SAME_ACCOUNT_DEVICE', accountP: account, SIGNAL_MD3_AUTHORIZED: true };
      }
      return { ok: true, code: 'EXTERNAL_DEVICE', binding: 'EXTERNAL_DEVICE', accountP: resolved.accountP, SIGNAL_MD3_AUTHORIZED: true };
    }
    const rev = await loadRevocations(account);
    if (isRevokedDevice(rev, { deviceSignPub: author })) return { ok: false, code: 'REVOKED', SIGNAL_MD3_AUTHORIZED: false };
    return { ok: true, code: 'EXTERNAL_ACCOUNT', binding: 'EXTERNAL_ACCOUNT', accountP: author, SIGNAL_MD3_AUTHORIZED: false };
  }

  function releaseLinkedDevice(reason) {
    if (snapshot.role !== 'LINKED_DEVICE') return { ok: false, code: 'NOT_LINKED' };
    App.linkedDeviceSession = false;
    App.publicKey = '';
    App.privateKey = null;
    App.guestMode = true;
    App.identityState = 'GUEST';
    setGuest();
    if (directoryHeartbeat) {
      clearInterval(directoryHeartbeat);
      directoryHeartbeat = 0;
    }
    return { ok: true, code: reason || 'DEVICE_REVOKED' };
  }

  async function watchOwnRevocation() {
    const session = getAccountSession();
    if (session.role !== 'LINKED_DEVICE' || !session.verified || !isHex64(session.deviceSignPub)) return { ok: true };
    const rev = await loadRevocations(session.accountP, { fresh: true });
    if (!rev || rev.ok !== true || !isRevokedDevice(rev, session)) return { ok: true };
    releaseLinkedDevice('DEVICE_REVOKED');
    try {
      root.dispatchEvent(new CustomEvent('sos-ld-device-revoked'));
    } catch (_e) {}
    return { ok: false, code: 'DEVICE_REVOKED' };
  }

  async function revokeLinkedDevice(device) {
    const session = getAccountSession();
    if (session.role !== 'PRIMARY_ACCOUNT' || !primaryReady()) return { ok: false, code: 'NOT_PRIMARY' };
    const signer = App.SosCryptoSigner;
    const pool = App.pool;
    const NT = root.NostrTools;
    if (!signer || typeof signer.signDeviceRevoke !== 'function' || typeof signer.hasIdentityKey !== 'function' || signer.hasIdentityKey() !== true || !pool || !NT) {
      return { ok: false, code: 'NO_SIGNER' };
    }
    const pub = norm(device && device.deviceSignPub);
    const authorizationId = norm(device && device.authorizationId);
    if (!isHex64(pub) || !isHex64(authorizationId)) return { ok: false, code: 'BAD_DEVICE' };
    const current = await loadRevocations(session.accountP, { fresh: true });
    if (!current || current.ok !== true) return { ok: false, code: (current && current.code) || 'QUERY_FAILED' };
    const list = current.list.filter(function (row) { return row.deviceSignPub !== pub; });
    list.push({ deviceSignPub: pub, authorizationId: authorizationId, at: Date.now() });
    const body = { v: 1, revoked: list.slice(-32) };
    let signed;
    try {
      signed = await Promise.resolve(signer.signDeviceRevoke({
        kind: 30078,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', REVOKE_TAG]],
        content: JSON.stringify(body),
        pubkey: session.accountP,
      }));
    } catch (err) {
      return { ok: false, code: (err && err.code) || 'SIGN_FAILED' };
    }
    if (!signed || verifyEventPlain(signed).ok !== true || norm(signed.pubkey) !== session.accountP) {
      return { ok: false, code: 'BAD_SIGNATURE' };
    }
    const published = pool.publish(App.relayUrls, signed);
    const pending = Array.isArray(published) ? published : [published];
    const settled = await Promise.allSettled(pending.map(function (p) { return Promise.resolve(p); }));
    const accepted = settled.some(function (r) { return r.status === 'fulfilled'; });
    if (!accepted) return { ok: false, code: 'RELAY_REJECTED' };
    const pubs = {};
    const ids = {};
    body.revoked.forEach(function (row) {
      pubs[row.deviceSignPub] = true;
      ids[row.authorizationId] = true;
    });
    const value = { ok: true, code: 'REVOKED', pubs: pubs, ids: ids, list: body.revoked };
    revokeCache[session.accountP] = { exp: Date.now() + 20000, value: value };
    const cache = root.__sosDeviceAccountCache;
    if (cache) delete cache[pub];
    return { ok: true, code: 'REVOKED' };
  }

  function directoryDeviceLabel() {
    try {
      const nav = root.navigator;
      const raw = String((nav && nav.userAgentData && nav.userAgentData.platform) || (nav && nav.userAgent) || '');
      if (/Windows/i.test(raw)) return 'Windows';
      if (/Android/i.test(raw)) return 'Android';
      if (/iPhone|iPad/i.test(raw)) return 'iPhone';
      if (/Mac/i.test(raw)) return 'Mac';
      if (/CrOS/i.test(raw)) return 'ChromeOS';
      if (/Linux/i.test(raw)) return 'Linux';
    } catch (_e) {}
    return 'מחשב';
  }

  function safeDirectoryLabel(value) {
    const text = String(value || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32);
    if (!text || /nsec|private|secret/i.test(text)) return '';
    return text;
  }

  async function collectVerifiedDirectory(accountP, requiredCap, opts) {
    const account = norm(accountP);
    const cap = requiredCap ? String(requiredCap) : '';
    if (!isHex64(account)) return { ok: false, code: 'BAD_ACCOUNT', devices: [] };
    const pool = App.pool;
    const Auth = App.Md4DeviceAuth || root.SosMd4DeviceAuth;
    const NT = root.NostrTools;
    if (!pool || !Auth || typeof Auth.verifyForDestination !== 'function' || !NT || typeof NT.verifyEvent !== 'function') {
      return { ok: false, code: 'NO_DIRECTORY', devices: [] };
    }
    const filter = { kinds: [30078], '#p': [account], '#d': ['sos-device-directory'], limit: 20 };
    let raw = [];
    try {
      if (typeof pool.list === 'function') raw = await pool.list(App.relayUrls, [filter]);
      else if (typeof pool.querySync === 'function') raw = await pool.querySync(App.relayUrls, filter);
    } catch (_e) {
      return { ok: false, code: 'QUERY_FAILED', devices: [] };
    }
    const events = flattenRelayEvents(raw);
    const rev = await loadRevocations(account, opts);
    const best = {};
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (verifyEventPlain(event).ok !== true) continue;
      let body = null;
      try { body = JSON.parse(event.content); } catch (_p) { continue; }
      const auth = body && body.authorization;
      if (!auth || norm(auth.accountP) !== account || norm(auth.D_sign_pub) !== norm(event.pubkey)) continue;
      const verified = await Auth.verifyForDestination(auth, {
        accountP: auth.accountP,
        deviceId: auth.deviceId,
        D_sign_pub: auth.D_sign_pub,
        D_enc_pub: auth.D_enc_pub,
      }, Date.now(), { requireHistorySync: false });
      if (!verified || verified.ok !== true) continue;
      const caps = Array.isArray(auth.capabilities) ? auth.capabilities.map(String) : [];
      if (cap && caps.indexOf(cap) === -1) continue;
      const signPub = norm(auth.D_sign_pub);
      const authorizationId = norm(auth.authorizationId);
      if (!isHex64(signPub) || isRevokedDevice(rev, { deviceSignPub: signPub, authorizationId: authorizationId })) continue;
      const row = {
        deviceId: norm(auth.deviceId) || signPub,
        deviceSignPub: signPub,
        deviceEncPub: norm(auth.D_enc_pub),
        authorizationId: authorizationId,
        expiresAt: Number(auth.expiresAt) || 0,
        caps: caps,
        deviceLabel: safeDirectoryLabel(body.deviceLabel) || safeDirectoryLabel(auth.deviceLabel) || 'מחשב',
        linkedAt: Number(auth.createdAt) || 0,
        lastSeenAt: (Number(event.created_at) || 0) * 1000,
      };
      const prev = best[signPub];
      if (!prev || row.lastSeenAt >= prev.lastSeenAt) best[signPub] = row;
    }
    return { ok: true, devices: Object.keys(best).map(function (id) { return best[id]; }) };
  }

  async function listAuthorizedDevices(accountP, requiredCap) {
    const cap = requiredCap === 'ANY' ? '' : (requiredCap ? String(requiredCap) : 'DEVICE_CHAT');
    const listed = await collectVerifiedDirectory(accountP, cap);
    return listed.devices;
  }

  async function listAccountLinkedDevices(accountP) {
    return collectVerifiedDirectory(accountP, '', { fresh: true });
  }

  async function resolveDeviceAccount(devicePub) {
    const device = norm(devicePub);
    if (!isHex64(device)) return { ok: false, code: 'BAD_DEVICE' };
    const cache = root.__sosDeviceAccountCache || (root.__sosDeviceAccountCache = {});
    const hit = cache[device];
    if (hit && hit.exp > Date.now()) return hit.value;
    const pool = App.pool;
    const Auth = App.Md4DeviceAuth || root.SosMd4DeviceAuth;
    if (!pool || !Auth || typeof Auth.verifyForDestination !== 'function') {
      return { ok: false, code: 'NO_DIRECTORY' };
    }
    const filter = { kinds: [30078], authors: [device], '#d': ['sos-device-directory'], limit: 5 };
    let raw = [];
    try {
      if (typeof pool.list === 'function') raw = await pool.list(App.relayUrls, [filter]);
      else if (typeof pool.querySync === 'function') raw = await pool.querySync(App.relayUrls, filter);
    } catch (_e) {
      return { ok: false, code: 'QUERY_FAILED' };
    }
    const events = flattenRelayEvents(raw);
    let value = { ok: false, code: 'NO_DIRECTORY' };
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (norm(event.pubkey) !== device) continue;
      if (verifyEventPlain(event).ok !== true) {
        if (!value.ok) value = { ok: false, code: 'BAD_EVENT_SIG', accountP: '' };
        continue;
      }
      let body = null;
      try { body = JSON.parse(event.content); } catch (_p) {
        if (!value.ok) value = { ok: false, code: 'INVALID_DIRECTORY', accountP: '' };
        continue;
      }
      const auth = body && body.authorization;
      if (!auth || norm(auth.D_sign_pub || auth.dSignPub) !== device || !isHex64(auth.accountP)) continue;
      const verified = await Auth.verifyForDestination(auth, {
        accountP: auth.accountP,
        deviceId: auth.deviceId,
        D_sign_pub: auth.D_sign_pub || auth.dSignPub,
        D_enc_pub: auth.D_enc_pub || auth.dEncPub,
      }, Date.now(), { requireHistorySync: false });
      if (!verified || verified.ok !== true) {
        if (!value.ok && verified && (verified.code === 'EXPIRED' || verified.code === 'BAD_SIGNATURE')) {
          value = { ok: false, code: verified.code, accountP: norm(auth.accountP) };
        }
        continue;
      }
      const encPub = norm(auth.D_enc_pub || auth.dEncPub);
      if (encPub && encPub === device) {
        value = { ok: false, code: 'D_ENC_NOT_SIGNAL', accountP: norm(auth.accountP) };
        continue;
      }
      const caps = Array.isArray(auth.capabilities) ? auth.capabilities.map(String) : [];
      const signPub = device;
      if (isRevokedDevice(await loadRevocations(norm(auth.accountP)), { deviceSignPub: signPub, authorizationId: norm(auth.authorizationId) })) {
        value = { ok: false, code: 'REVOKED', accountP: norm(auth.accountP) };
        continue;
      }
      value = {
        ok: true,
        accountP: norm(auth.accountP),
        deviceId: norm(auth.deviceId),
        deviceSignPub: device,
        caps: caps,
      };
      noteVerifiedDevice(device, auth.accountP);
      break;
    }
    cache[device] = { exp: Date.now() + (value.ok ? 60000 : 15000), value: value };
    return value;
  }

  async function resubscribeLinkedTransports() {
    try { await watchOwnRevocation(); } catch (_rev) {}
    if (getAccountSession().role !== 'LINKED_DEVICE') return;
    if (typeof App.ensureSecureChatEpochReady === 'function') {
      try { await App.ensureSecureChatEpochReady(); } catch (_epoch) {}
    }
    const ready = typeof App.isSecureChatReady !== 'function' || App.isSecureChatReady() === true;
    if (ready) {
      try {
        if (typeof App.stopPrivateChatSubscription === 'function') App.stopPrivateChatSubscription('linked-device');
      } catch (_e) {}
      try {
        if (typeof App.subscribeToChatEvents === 'function') App.subscribeToChatEvents();
      } catch (_e2) {}
    }
    try {
      if (typeof App.rebindLinkedDeviceP2P === 'function') App.rebindLinkedDeviceP2P();
    } catch (_p2p) {}
    try {
      if (App.dataChannel && typeof App.dataChannel.ensureSignalSubscription === 'function') App.dataChannel.ensureSignalSubscription();
    } catch (_dcSub) {}
    try { await announceLinkedDevice(); } catch (_ann) {}
    if (!directoryHeartbeat) {
      directoryHeartbeat = setInterval(function () {
        announceLinkedDevice().catch(function () {});
        watchOwnRevocation().catch(function () {});
      }, 120000);
    }
    try {
      const calls = App.CallSignalE2ee;
      if (calls && typeof calls.ensureSecureCallSubscription === 'function') {
        calls.ensureSecureCallSubscription({ force: true, reason: 'linked-device' });
      }
    } catch (_e3) {}
    try {
      await pullLinkedHistory();
      await pullLinkedDirectMessages();
      const synced = root.__sosLdHistorySync && root.__sosLdHistorySync.HISTORY_TEXT_SYNC_COMPLETE === true;
      if (!synced) await requestLinkedHistory();
    } catch (_e4) {}
  }

  function verifiedAccountOf(pubkey) {
    const pk = norm(pubkey);
    if (!isHex64(pk)) return '';
    const map = root.__sosVerifiedDeviceOwners;
    const owner = map && typeof map[pk] === 'string' ? norm(map[pk]) : '';
    return isHex64(owner) && owner !== pk ? owner : '';
  }

  async function noteOwnedDevices(accountP) {
    const account = norm(accountP || (typeof App.publicKey === 'string' ? App.publicKey : ''));
    if (!isHex64(account)) return { ok: false, code: 'BAD_ACCOUNT' };
    if (root.__sosOwnedDevicesAccount === account && root.__sosOwnedDevicesAt && (Date.now() - root.__sosOwnedDevicesAt) < 20000) {
      return { ok: true, cached: true };
    }
    const listed = await listAuthorizedDevices(account, 'ANY');
    const rows = Array.isArray(listed) ? listed : [];
    root.__sosVerifiedDeviceOwners = root.__sosVerifiedDeviceOwners || {};
    let n = 0;
    rows.forEach(function (row) {
      const sign = norm(row && row.deviceSignPub);
      const caps = Array.isArray(row && row.caps) ? row.caps : [];
      const chat = caps.indexOf('DEVICE_CHAT') !== -1 || caps.indexOf('DEVICE_FILES') !== -1 || caps.indexOf('DEVICE_CALLS') !== -1;
      if (!isHex64(sign) || sign === account || !chat) return;
      root.__sosVerifiedDeviceOwners[sign] = account;
      n += 1;
    });
    root.__sosOwnedDevicesAccount = account;
    root.__sosOwnedDevicesAt = Date.now();
    return { ok: true, n: n };
  }

  // Verified MD3 only. A directory miss stays the pubkey; unknown keys are not merged.
  async function canonicalPeer(pubkey, requiredCap) {
    const pk = norm(pubkey);
    if (!isHex64(pk)) return '';
    const cached = verifiedAccountOf(pk);
    if (cached) return cached;
    const resolved = await resolveDeviceAccount(pk);
    if (!resolved || resolved.ok !== true || !isHex64(resolved.accountP) || resolved.accountP === pk) return pk;
    const caps = Array.isArray(resolved.caps) ? resolved.caps : [];
    const need = requiredCap || 'DEVICE_CHAT';
    if (caps.indexOf(need) === -1 && caps.indexOf('DEVICE_CHAT') === -1 && caps.indexOf('DEVICE_FILES') === -1 && caps.indexOf('DEVICE_CALLS') === -1) {
      return pk;
    }
    return resolved.accountP;
  }

  async function resolveVerifiedActor(event) {
    const devicePub = norm(event && event.pubkey);
    const empty = { ok: false, accountP: '', devicePub: '', deviceId: '', authorization: '', capabilities: [] };
    if (!isHex64(devicePub)) return Object.assign({}, empty, { code: 'BAD_PUBKEY' });
    const tagged = event && event.__sosDelegatedAccount ? norm(event.__sosDelegatedAccount) : '';
    if (isHex64(tagged) && tagged !== devicePub) {
      return { ok: true, accountP: tagged, devicePub: devicePub, deviceId: '', authorization: 'md3-event', capabilities: [] };
    }
    const cached = verifiedAccountOf(devicePub);
    if (cached) {
      return { ok: true, accountP: cached, devicePub: devicePub, deviceId: '', authorization: 'md3-cache', capabilities: [] };
    }
    const resolved = await resolveDeviceAccount(devicePub);
    if (resolved && resolved.ok === true && isHex64(resolved.accountP) && resolved.accountP !== devicePub) {
      const caps = Array.isArray(resolved.caps) ? resolved.caps : [];
      return {
        ok: true,
        accountP: resolved.accountP,
        devicePub: devicePub,
        deviceId: resolved.deviceId || '',
        authorization: 'md3-directory',
        capabilities: caps,
      };
    }
    return { ok: true, accountP: devicePub, devicePub: '', deviceId: '', authorization: 'direct-account', capabilities: [] };
  }

  App.noteHistoryMediaReceived = noteHistoryMediaReceived;
  App.getAccountSession = getAccountSession;
  App.accountSessionAllows = allows;
  App.accountSessionOpForPrompt = opForPrompt;
  App.showLinkedCapabilityDenial = showLinkedDenial;
  App.adoptLinkedDeviceSession = adoptVerified;
  App.SosAccountSession = {
    OPS: OPS,
    HIST_KIND: HIST_KIND,
    restoreVerifiedLinkedDevice: restoreVerifiedLinkedDevice,
    getAccountSession: getAccountSession,
    allows: allows,
    adoptVerified: adoptVerified,
    opForPrompt: opForPrompt,
    showLinkedDenial: showLinkedDenial,
    verifyDelegatedEvent: verifyDelegatedEvent,
    delegatedChatEncrypt: delegatedChatEncrypt,
    decryptForLinkedDevice: decryptForLinkedDevice,
    publishLinkedHistoryBundle: publishLinkedHistoryBundle,
    pullLinkedHistory: pullLinkedHistory,
    requestLinkedHistory: requestLinkedHistory,
    acceptHistoryRequest: acceptHistoryRequest,
    pullLinkedDirectMessages: pullLinkedDirectMessages,
    announceLinkedDevice: announceLinkedDevice,
    listAuthorizedDevices: listAuthorizedDevices,
    listAccountLinkedDevices: listAccountLinkedDevices,
    revokeLinkedDevice: revokeLinkedDevice,
    releaseLinkedDevice: releaseLinkedDevice,
    resolveDeviceAccount: resolveDeviceAccount,
    classifyP2pSignalAuthor: classifyP2pSignalAuthor,
    verifiedAccountOf: verifiedAccountOf,
    noteOwnedDevices: noteOwnedDevices,
    requestOlderHistory: requestOlderHistory,
    readOlderCursor: readOlderCursor,
    canonicalPeer: canonicalPeer,
    resolveVerifiedActor: resolveVerifiedActor,
    verifyEventPlain: verifyEventPlain,
    acceptHistoryEvent: acceptHistoryEvent,
    confirmHistoryAck: confirmHistoryAck,
    noteHistoryMediaReceived: noteHistoryMediaReceived,
    resubscribeLinkedTransports: resubscribeLinkedTransports,
    ROOT_K_ON_DESKTOP: false,
  };
  function resumeHistoryAfterVisible() {
    const deferred = root.__sosHistReqDeferred === true || root.__sosPageSuspended === true;
    root.__sosPageSuspended = false;
    root.__sosHistReqDeferred = false;
    if (!deferred) return;
    try { console.log('HISTORY_RESUME'); } catch (_e) {}
    const session = getAccountSession();
    if (session.role === 'LINKED_DEVICE') {
      const sync = root.__sosLdHistorySync;
      const book = root.__sosLdHistoryPages;
      const settled = book && (book.terminal === 'COMPLETE' || book.terminal === 'COMPLETE_WITH_MISSING' || historyJobSettled(book));
      if (!settled && (!sync || sync.HISTORY_TEXT_SYNC_COMPLETE !== true)) requestLinkedHistory().catch(function () {});
      else if (!settled) pullLinkedHistory().catch(function () {});
      const waiting = root.__sosOlderPending || {};
      Object.keys(waiting).forEach(function (peer) {
        const row = waiting[peer];
        const saved = readOlderCursor(session.accountP, peer);
        if (saved && saved.requestId && row && saved.requestId === row.requestId) return;
        if (row && row.tries >= 4) return;
        if (row) row.tries = (row.tries || 0) + 1;
        requestOlderHistory(peer).catch(function () {});
      });
    }
    const map = root.__sosHistP2P || {};
    Object.keys(map).forEach(function (peer) {
      const row = historyPeerState(peer);
      row.next = 0;
      row.fails = 0;
      if (row.timer) { clearTimeout(row.timer); row.timer = null; }
      row.state = 'RECONNECTING';
      sendPendingHistoryMedia(peer).catch(function () {});
    });
  }
  function bindHistoryLifecycle() {
    if (root.__sosHistLife || typeof document === 'undefined') return;
    root.__sosHistLife = true;
    const onHide = function (why) {
      root.__sosPageSuspended = true;
      const peers = root.__sosHistPeer || {};
      Object.keys(peers).forEach(function (peer) {
        if (peers[peer] && peers[peer].state !== 'OFFLINE') peers[peer].state = 'SUSPENDED';
      });
      try {
        if (typeof App.flushChatPersist === 'function') App.flushChatPersist();
      } catch (_flush) {}
      try { console.log('HISTORY_SUSPEND reason=' + why); } catch (_e) {}
    };
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) onHide('hidden');
      else resumeHistoryAfterVisible();
    });
    document.addEventListener('pointerdown', function (event) {
      const target = event.target && event.target.closest ? event.target.closest('#chatMessageInput, .chat-composer, .chat-composer__send') : null;
      if (target) root.__sosChatIntentUntil = Date.now() + 8000;
    }, true);
    document.addEventListener('freeze', function () { onHide('freeze'); });
    document.addEventListener('resume', resumeHistoryAfterVisible);
  }
  bindHistoryLifecycle();
  root.SosAccountSession = App.SosAccountSession;
})(window);
