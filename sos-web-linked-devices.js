/**
 * Web Linked Devices product wiring (MD1 browser NORMAL_LINKED_DEVICE + MD2 QR + MD3 verify/registry).
 * MD4 S1: durable device keys + DeviceAuthorization via SosMd4DeviceStore + verifyStrict (SosMd4DeviceAuth).
 * ROOT K / nsec never appear in QR, URL, logs, or this module's storage.
 * MD3 issuance (sign under K) remains Android PhoneIssuer — no WebView authorize API.
 * FAKE_HISTORY_SYNC=false; a primary can revoke one linked device with an account-signed list.
 */
(function initSosWebLinkedDevices(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});
  const PROTOCOL_VERSION = 'sos-pair-v1';
  const QR_PREFIX = 'SOSPAIR1:';
  const SCHEME = 'sos-device-keys-v1';
  const AUTH_VERSION = 'sos-device-authorization-v1';
  const REG_KEY = 'sos_web_linked_devices_registry_v1';
  const DEVICE_KEY = 'sos_web_device_identity_meta_v1';
  const PAIR_TTL_MS = 120000;
  const APPROVAL_WAIT_MS = 300000;
  const MAX_LINKED = 4;
  const GUEST_CONTINUE_KEY = 'sos_ld_guest_continued_v1';
  const DEVICE_LIST_SCOPE = 'VERIFIED_ACCOUNT_DIRECTORY';

  function hexRand(bytes) {
    const a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  function b64urlEncode(str) {
    const arr = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function secretScan(text) {
    const t = String(text || '');
    const bad = /"(nsec|priv|d_sign_priv|d_enc_priv|privateKey|secret|rootK|k_hex)"\s*:/i.test(t) || /\bnsec1[a-z0-9]+\b/i.test(t);
    return { ok: !bad };
  }

  /** Browser NORMAL_LINKED_DEVICE — privates may be restored from MD4 durable store (never localStorage). */
  let _sessionDevice = null;
  let _durableAuth = null;
  let _pairing = null;
  let _pairTimer = null;
  let _guestAutoRefreshBusy = false;

  function md4Auth() {
    return App.Md4DeviceAuth || window.SosMd4DeviceAuth;
  }
  function md4Store() {
    return App.Md4DeviceStore || window.SosMd4DeviceStore;
  }

  function linkedDeviceReady() {
    return !!(_sessionDevice && _sessionDevice.dSignSk && _durableAuth);
  }

  async function ensureWebDeviceIdentity() {
    if (_sessionDevice && _sessionDevice.D_sign_pub) return _sessionDevice;
    // Real device keys come from Md2PairingSession.beginDesktopInitiator (X25519 + secp).
    // Placeholder meta only until a pairing session starts.
    const NT = window.NostrTools;
    if (!NT || typeof NT.generateSecretKey !== 'function') throw new Error('NOSTR_TOOLS_MISSING');
    const sk = NT.generateSecretKey();
    const dSignPub = NT.getPublicKey(sk);
    const deviceId = hexRand(32);
    _sessionDevice = {
      scheme: SCHEME,
      deviceId,
      D_sign_pub: dSignPub,
      D_enc_pub: '',
      E_ephemeral_pub: '',
      storageClass: 'SOFTWARE_ONLY',
      recoveryEligible: false,
      hardwareBacked: false,
      deviceType: 'DESKTOP',
      label: 'דפדפן',
      _dSignSk: sk,
    };
    try {
      localStorage.setItem(
        DEVICE_KEY,
        JSON.stringify({
          scheme: SCHEME,
          deviceId,
          D_sign_pub: dSignPub,
          storageClass: 'SOFTWARE_ONLY',
          recoveryEligible: false,
        }),
      );
    } catch (_e) {}
    return _sessionDevice;
  }

  function readRegistry() {
    try {
      const raw = localStorage.getItem(REG_KEY);
      const o = raw ? JSON.parse(raw) : { devices: [] };
      return Array.isArray(o.devices) ? o.devices : [];
    } catch (_e) {
      return [];
    }
  }

  function writeRegistry(devices) {
    try {
      localStorage.setItem(REG_KEY, JSON.stringify({ devices: devices.slice(0, MAX_LINKED) }));
    } catch (_e) {}
  }

  function listLinkedDevices() {
    return readRegistry().map((d) => ({
      deviceName: d.deviceLabel || d.label || 'מכשיר',
      deviceId: d.deviceId,
      linkedAt: d.createdAt || d.linkedAt || null,
      authorizationState: d.status || 'ACTIVE',
      isCurrent: !!( _sessionDevice && d.deviceId === _sessionDevice.deviceId),
      // Never invent online/last-seen
    }));
  }

  function assertPairingAllowed(pk) {
    const key = String(pk || App.publicKey || '')
      .toLowerCase()
      .replace(/^0x/, '');
    // Desktop may show SOSPAIR1 before login; phone PhoneIssuer binds account P.
    if (!/^[0-9a-f]{64}$/.test(key)) {
      return { ok: true, DESKTOP_UNAUTHENTICATED_QR: true };
    }
    const GAS = App.GlobalAccountStatusState || window.SosGlobalAccountStatusState;
    if (GAS && typeof GAS.assertLinkedDeviceBindAllowed === 'function') {
      return GAS.assertLinkedDeviceBindAllowed(key);
    }
    return { ok: true };
  }

  async function startDesktopPairingSession() {
    if (linkedDeviceReady()) return { ok: true, code: 'ALREADY_LINKED' };
    try {
      const GA = App.GlobalAdmission || window.SosGlobalAdmission;
      const me = String(App.publicKey || '').toLowerCase();
      if (GA && typeof GA.reconcileAccountStatus === 'function' && /^[0-9a-f]{64}$/.test(me)) {
        await GA.reconcileAccountStatus(me).catch(function () {});
      }
    } catch (_rec) {}
    const gate = assertPairingAllowed(App.publicKey);
    if (gate && gate.ok === false) {
      return { ok: false, code: gate.code || 'ACCOUNT_DISABLED', KNOWN_DISABLED_P_PAIRING_ACCEPTED: false };
    }
    const Session = App.Md2PairingSession || window.SosMd2PairingSession;
    if (!Session || typeof Session.beginDesktopInitiator !== 'function') {
      throw new Error('MD2_SESSION_MODULE_MISSING');
    }
    if (_pairing && _pairing._session && typeof _pairing._session.stop === 'function') {
      try {
        _pairing._session.stop();
      } catch (_s) {}
    }
    const session = await Session.beginDesktopInitiator({
      ttlMs: PAIR_TTL_MS,
      deviceLabel: 'דפדפן',
      pool: App.pool,
    });
    if (!secretScan(session.qrText).ok) throw new Error('MD2_QR_SECRET_REJECTED');
    if (linkedDeviceReady()) return { ok: true, code: 'ALREADY_LINKED' };
    _sessionDevice = {
      scheme: SCHEME,
      deviceId: session.deviceId,
      D_sign_pub: session.dSignPub,
      D_enc_pub: session.dEncPub,
      storageClass: 'SOFTWARE_ONLY',
      recoveryEligible: false,
      hardwareBacked: false,
      deviceType: 'DESKTOP',
      label: 'דפדפן',
    };
    _pairing = {
      state: 'WAITING',
      payload: session.payload,
      qrText: session.qrText,
      createdAt: Date.now(),
      expiresAt: session.payload.expiresAt,
      _session: session,
      ROOT_K_SENT_TO_DESKTOP: false,
      NSEC_SENT_TO_DESKTOP: false,
    };
    if (_pairTimer) clearInterval(_pairTimer);
    _pairTimer = setInterval(() => {
      if (!_pairing) return;
      // Keep expiry countdown live on open panels.
      try {
        renderPairingUi();
      } catch (_r) {}
      if (Date.now() > _pairing.expiresAt) {
        let live = '';
        try {
          live = _pairing._session && typeof _pairing._session.state === 'function' ? _pairing._session.state() : '';
        } catch (_live) {}
        if (live === 'CHANNEL_READY' || live === 'POP_SENT' || live === 'AUTH_WAIT' || live === 'LINKED') {
          if (_pairing.state === 'WAITING') _pairing.state = 'APPROVAL_PENDING';
          renderPairingUi();
          return;
        }
        const wasState = _pairing.state;
        _pairing.state = 'EXPIRED';
        try {
          _pairing._session && _pairing._session.stop();
        } catch (_e) {}
        renderPairingUi();
        // Guest welcome: auto-mint a fresh session (never reuse expired; never during approval).
        const welcome = document.getElementById('sosLdGuestWelcome');
        const welcomeActive =
          welcome &&
          !welcome.hidden &&
          window.__sosLdGuestWelcomeActive &&
          wasState !== 'APPROVAL_PENDING' &&
          wasState !== 'APPROVED';
        if (welcomeActive && !_guestAutoRefreshBusy) {
          _guestAutoRefreshBusy = true;
          Promise.resolve(startPairingIntoUi(welcome))
            .catch(function () {})
            .then(function () {
              _guestAutoRefreshBusy = false;
            });
        } else {
          clearInterval(_pairTimer);
          _pairTimer = null;
        }
      }
    }, 1000);
    session
      .waitLinked(APPROVAL_WAIT_MS)
      .then(async (auth) => {
        if (!_pairing) return;
        const accepted = await acceptAuthorizationObject(auth, { session });
        if (accepted && accepted.ok && typeof session.acknowledgeLinked === 'function') {
          const acked = await session.acknowledgeLinked(auth);
          if (!acked || acked.ok !== true) {
            _pairing.state = 'FAILURE';
            try { window.__sosMd3AcceptFail = (acked && acked.code) || 'ACK_FAIL'; } catch (_e) {}
            renderPairingUi();
            return;
          }
        }
        if (accepted && accepted.ok) {
          _pairing.state = 'APPROVED';
          renderPairingUi();
          await openLinkedDesktopAccount();
        } else {
          _pairing.state = 'FAILURE';
          try {
            window.__sosMd3AcceptFail = accepted && accepted.code;
          } catch (_e) {}
          renderPairingUi();
        }
      })
      .catch(() => {
        if (_pairing && _pairing.state === 'WAITING') {
          /* still waiting or expired via timer */
        }
      });
    return _pairing;
  }

  function refreshPairingQr() {
    return startDesktopPairingSession();
  }

  function getPairingState() {
    return _pairing ? { state: _pairing.state, expiresAt: _pairing.expiresAt, pairingId: _pairing.payload && _pairing.payload.pairingId } : null;
  }

  /** Public SOSPAIR1 text currently shown (no secrets). Null if none / expired. */
  function getCurrentPairingQrText() {
    if (!_pairing || _pairing.state === 'EXPIRED') return null;
    const t = String(_pairing.qrText || '');
    return t.indexOf(QR_PREFIX) === 0 ? t : null;
  }

  function disposePairingSession() {
    if (_pairTimer) {
      clearInterval(_pairTimer);
      _pairTimer = null;
    }
    if (_pairing && _pairing._session && typeof _pairing._session.stop === 'function') {
      try {
        _pairing._session.stop();
      } catch (_s) {}
    }
    _pairing = null;
  }

  function guestContinuedThisTab() {
    try {
      return sessionStorage.getItem(GUEST_CONTINUE_KEY) === '1';
    } catch (_e) {
      return false;
    }
  }

  function markGuestContinued() {
    try {
      sessionStorage.setItem(GUEST_CONTINUE_KEY, '1');
    } catch (_e) {}
  }

  function hasInviteDeepLink() {
    try {
      if (typeof App.getInviteCodeFromLocation === 'function') {
        return !!App.getInviteCodeFromLocation();
      }
      const u = new URL(window.location.href);
      return !!(u.searchParams.get('invite') || u.searchParams.get('inviteCode'));
    } catch (_e) {
      return false;
    }
  }

  function isGuestDesktopEntry() {
    const cls = classifyLinkedDevicesSurface();
    if (cls.role !== 'DESKTOP_DESTINATION') return false;
    if (App.guestMode === false && App.publicKey) return false;
    if (hasInviteDeepLink()) return false;
    if (guestContinuedThisTab()) return false;
    return true;
  }

  function maybeShowGuestQrWelcome() {
    if (!isGuestDesktopEntry()) return { ok: false, skipped: true };
    // Defer slightly so guest-auth / feed init settle; never cover invite deep links.
    const run = function () {
      if (!isGuestDesktopEntry()) return;
      if (document.getElementById('sosLdGuestWelcome') && !document.getElementById('sosLdGuestWelcome').hidden) {
        return;
      }
      showGuestQrWelcome();
    };
    if (document.readyState === 'complete') setTimeout(run, 80);
    else window.addEventListener('load', function () { setTimeout(run, 80); });
    return { ok: true, scheduled: true };
  }

  function ensureLinkedDevicesStyles() {
    if (document.getElementById('sosLdProductStyles')) return;
    const style = document.createElement('style');
    style.id = 'sosLdProductStyles';
    style.textContent =
      '#sosLdGuestWelcome,#sosLdMobilePage,#sosLinkedPairPanel{position:fixed;inset:0;z-index:12030;display:flex;align-items:center;justify-content:center}' +
      '#sosLdGuestWelcome[hidden],#sosLdMobilePage[hidden],#sosLinkedPairPanel[hidden]{display:none!important}' +
      '#sosLdMobilePage{background:var(--sos-bg,#0d0d0d);align-items:stretch;justify-content:stretch}' +
      '.sos-ld-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.58)}' +
      '.sos-ld-shell{position:relative;width:min(440px,94vw);max-height:94vh;overflow:auto;background:var(--sos-surface,#141414);color:var(--sos-text,#f5f5f5);border-radius:18px;padding:22px 20px;box-shadow:0 16px 48px rgba(0,0,0,.5)}' +
      '.sos-ld-shell h1,.sos-ld-shell h2{margin:0;font-size:1.25rem;font-weight:650;line-height:1.3}' +
      '.sos-ld-shell .sos-ld-sub{margin:10px 0 0;font-size:14px;line-height:1.5;opacity:.9}' +
      '.sos-ld-qr-wrap{margin:18px auto 10px;width:min(440px,86vw);height:min(440px,86vw);aspect-ratio:1;background:#fff;border-radius:14px;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}' +
      '.sos-ld-qr-wrap canvas{display:block;width:100%;height:100%;max-width:408px;max-height:408px;background:#fff;image-rendering:pixelated;image-rendering:crisp-edges}' +
      '.sos-ld-qr-wrap.is-error{background:#2a2a2a;color:#f0f0f0;text-align:center;padding:20px;font-size:14px;line-height:1.45}' +
      '.sos-ld-status,.sos-ld-expiry{text-align:center;margin:6px 0;font-size:13px}' +
      '.sos-ld-expiry{opacity:.8}' +
      '.sos-ld-actions{display:flex;flex-direction:column;gap:10px;margin-top:16px}' +
      '.sos-ld-actions .button-primary,.sos-ld-actions .button-secondary{width:100%;min-height:44px}' +
      '.sos-ld-mobile-page{position:relative;width:100%;max-width:560px;height:100%;max-height:100%;border-radius:0;display:flex;flex-direction:column;padding:0}' +
      '.sos-ld-mobile-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08)}' +
      '.sos-ld-mobile-head button{background:transparent;border:0;color:inherit;font-size:22px;line-height:1;padding:4px 8px}' +
      '.sos-ld-mobile-body{padding:8px 16px 24px;overflow:auto;flex:1}' +
      '.sos-ld-hero{display:flex;justify-content:center;padding:8px 0 0}' +
      '.sos-ld-hero svg{width:min(280px,78vw);height:auto;overflow:visible}' +
      '.sos-ld-phone{animation:sosLdFloat 3.4s ease-in-out infinite}' +
      '.sos-ld-laptop{animation:sosLdFloat 3.4s ease-in-out .35s infinite}' +
      '.sos-ld-screen{animation:sosLdGlow 2.8s ease-in-out infinite}' +
      '.sos-ld-link{animation:sosLdDrift 2.2s ease-in-out infinite}' +
      '.sos-ld-dot{transform-origin:center;transform-box:fill-box;animation:sosLdPop 1.6s ease-in-out infinite}' +
      '.sos-ld-dot-2{animation-delay:.18s}' +
      '.sos-ld-dot-3{animation-delay:.36s}' +
      '.sos-ld-dot-4{animation-delay:.54s}' +
      '@keyframes sosLdFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}' +
      '@keyframes sosLdPop{0%,100%{opacity:.28;transform:scale(.72)}50%{opacity:1;transform:scale(1)}}' +
      '@keyframes sosLdGlow{0%,100%{opacity:1}50%{opacity:.55}}' +
      '@keyframes sosLdDrift{0%,100%{transform:translateX(0)}50%{transform:translateX(5px)}}' +
      '.sos-ld-explain{margin:4px 0 0;text-align:center;font-size:14px;line-height:1.55}' +
      '.sos-ld-device-list{list-style:none;margin:8px 0 0;padding:0}' +
      '.sos-ld-device-list li,.sos-ld-device-row{display:flex;gap:12px;align-items:center;padding:14px 0;border:0;border-bottom:1px solid rgba(255,255,255,.08);background:transparent;color:inherit;width:100%;text-align:right;font:inherit;cursor:pointer}' +
      '.sos-ld-device-ico{width:40px;height:40px;border-radius:50%;background:rgba(45,136,255,.14);color:#2d88ff;display:flex;align-items:center;justify-content:center;flex-shrink:0}' +
      '.sos-ld-device-row.is-live .sos-ld-device-ico{background:rgba(45,212,191,.16);color:#5eead4;box-shadow:0 0 0 2px rgba(45,212,191,.75)}' +
      '.sos-ld-live{display:inline-block;margin-inline-start:8px;padding:1px 8px;border-radius:999px;background:rgba(45,212,191,.16);color:#5eead4;font-size:11px;font-weight:700;font-style:normal;vertical-align:1px}' +
      '.sos-ld-detail{text-align:center;padding:12px 8px 24px}' +
      '.sos-ld-detail-ico{width:88px;height:88px;border-radius:50%;margin:24px auto 14px;display:flex;align-items:center;justify-content:center;font-size:30px;color:#f5f5f5;background:linear-gradient(#161616,#161616) padding-box,conic-gradient(#7ec8ff,#3d7dff,#2dd4bf,#7ec8ff) border-box;border:3px solid transparent}' +
      '.sos-ld-detail h3{margin:0;font-size:1.35rem}' +
      '.sos-ld-detail .sos-ld-sub{margin-top:4px}' +
      '.sos-ld-detail-row{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:22px;font-size:15px}' +
      '.sos-ld-disconnect{width:100%;min-height:48px;margin-top:28px;border-radius:999px;border:1px solid rgba(255,59,92,.85);background:transparent;color:#ff3b5c;font-size:16px}' +
      '.sos-ld-disconnect.is-confirm{background:#ff3b5c;color:#fff}' +
      '.sos-ld-device-meta{flex:1;min-width:0}' +
      '.sos-ld-device-meta strong{display:block;font-size:15px}' +
      '.sos-ld-device-meta span{display:block;font-size:12px;opacity:.75;margin-top:3px}' +
      '.sos-ld-empty{opacity:.8;font-size:14px;margin-top:18px}' +
      '.sos-ld-footnote{font-size:12px;opacity:.7;margin-top:14px;line-height:1.45}' +
      '.sos-ld-link-status{margin:14px 0;padding:12px 14px;border-radius:12px;background:rgba(180,60,60,.18);border:1px solid rgba(255,120,120,.35);white-space:pre-wrap;line-height:1.5;font-size:14px}' +
      '.sos-ld-link-status.is-ok{background:rgba(40,120,70,.22);border-color:rgba(120,200,150,.4)}' +
      '.sos-ld-link-status.is-pending{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.12)}' +
      '.sos-ld-link-status[hidden]{display:none!important}' +
      '.sos-ld-link-actions{display:flex;flex-direction:column;gap:8px;margin-top:12px;white-space:normal}' +
      '.sos-ld-link-actions a,.sos-ld-link-actions button{display:flex;align-items:center;justify-content:center;width:100%;min-height:44px;padding:0 14px;border-radius:10px;background:#f5f5f5;color:#111;text-decoration:none;font-weight:650;border:0;font:inherit;cursor:pointer}';
    document.head.appendChild(style);
  }

  /**
   * Capability-aware surface class for Linked Devices primary UX.
   * Not a security boundary — never bypasses crypto / account checks.
   * Prefer pointer/hover/touch + native shell over viewport/UA alone.
   */
  function classifyLinkedDevicesSurface(opts) {
    const o = opts || {};
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    const win = typeof window !== 'undefined' ? window : null;
    const bridge =
      (win && (win.SosNativeShell || win.AndroidBridge || win.SosAndroidBridge)) || null;
    const nativeShell =
      !!(bridge && typeof bridge.isNativeShell === 'function' && bridge.isNativeShell() === true) ||
      !!(nav && /SOSNativeShell\//i.test(String(nav.userAgent || '')));

    let uaDataMobile = null;
    try {
      if (nav && nav.userAgentData && typeof nav.userAgentData.mobile === 'boolean') {
        uaDataMobile = nav.userAgentData.mobile;
      }
    } catch (_uad) {}

    let coarsePointer = false;
    let finePointer = false;
    let canHover = false;
    let narrowViewport = false;
    try {
      if (win && typeof win.matchMedia === 'function') {
        coarsePointer = !!win.matchMedia('(pointer: coarse)').matches;
        finePointer = !!win.matchMedia('(pointer: fine)').matches;
        canHover = !!win.matchMedia('(hover: hover)').matches;
        narrowViewport = !!win.matchMedia('(max-width: 900px)').matches;
      }
    } catch (_mm) {}

    const maxTouch = nav && typeof nav.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0;
    const ua = String((nav && nav.userAgent) || '');
    const uaPhone = /\b(Android|iPhone|iPod|Mobile)\b/i.test(ua) && !/\biPad\b/i.test(ua);
    const uaTablet = /\b(iPad|Tablet|Android(?!.*Mobile))\b/i.test(ua);

    if (nativeShell || o.forceRole === 'MOBILE_PRIMARY') {
      return {
        role: 'MOBILE_PRIMARY',
        reason: nativeShell ? 'NATIVE_SHELL' : 'FORCE',
        nativeShell: !!nativeShell,
        AMBIGUOUS: false,
      };
    }
    if (o.forceRole === 'DESKTOP_DESTINATION') {
      return {
        role: 'DESKTOP_DESTINATION',
        reason: 'FORCE',
        nativeShell: false,
        AMBIGUOUS: false,
      };
    }

    // Clear desktop: fine pointer + hover, not coarse-primary phone UA.
    if (finePointer && canHover && !coarsePointer && uaDataMobile !== true && !uaPhone) {
      return {
        role: 'DESKTOP_DESTINATION',
        reason: 'FINE_POINTER_HOVER',
        nativeShell: false,
        AMBIGUOUS: false,
      };
    }

    // Clear mobile phone: coarse pointer / touch phone / UA mobile.
    if (uaDataMobile === true || uaPhone || (coarsePointer && maxTouch > 0 && narrowViewport && !canHover)) {
      return {
        role: 'MOBILE_PRIMARY',
        reason: uaPhone || uaDataMobile === true ? 'PHONE_CAPABILITY' : 'COARSE_TOUCH',
        nativeShell: false,
        AMBIGUOUS: false,
      };
    }

    // Tablets / dual input / emulators — do not guess.
    if (uaTablet || (coarsePointer && finePointer) || (maxTouch > 0 && canHover) || (narrowViewport && finePointer)) {
      return {
        role: 'AMBIGUOUS',
        reason: 'TABLET_OR_DUAL_INPUT',
        nativeShell: false,
        AMBIGUOUS: true,
      };
    }

    return {
      role: 'AMBIGUOUS',
      reason: 'UNCLASSIFIED',
      nativeShell: false,
      AMBIGUOUS: true,
    };
  }

  function openRoleChooserPanel() {
    let el = document.getElementById('sosLdRoleChooser');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sosLdRoleChooser';
      el.innerHTML =
        '<div class="sos-ld-backdrop" data-ld-role-close></div>' +
        '<div class="sos-ld-panel" role="dialog" aria-modal="true">' +
        '<header><h2>קישור מכשירים</h2>' +
        '<button type="button" data-ld-role-close aria-label="סגור">×</button></header>' +
        '<p style="margin:12px 0;font-size:14px;line-height:1.5;opacity:.9;">בחרו את תפקיד המכשיר הנוכחי. הזיהוי אינו מחליף אימות או אישור קישור.</p>' +
        '<button type="button" class="button-primary" id="sosLdRoleScan" style="width:100%;margin-bottom:8px;">סריקת QR לקישור מחשב</button>' +
        '<button type="button" class="button-secondary" id="sosLdRoleShow" style="width:100%;">קישור מחשב באמצעות הטלפון</button>' +
        '</div>';
      document.body.appendChild(el);
      el.addEventListener('click', function (e) {
        if (e.target && e.target.hasAttribute('data-ld-role-close')) el.hidden = true;
      });
      document.getElementById('sosLdRoleScan').onclick = function () {
        el.hidden = true;
        openMobilePrimaryLinkAction();
      };
      document.getElementById('sosLdRoleShow').onclick = function () {
        el.hidden = true;
        openDesktopPairingPanel();
      };
    }
    el.hidden = false;
  }

  /** Mobile Primary: open camera scan (or native Linked Devices). Never default to Display QR. */
  function openMobilePrimaryLinkAction() {
    const bridge =
      window.SosNativeShell || window.AndroidBridge || window.SosAndroidBridge;
    if (bridge && typeof bridge.openLinkedDevicesSettings === 'function') {
      try {
        const admission = App.FIRST_GROUP_ADMISSION_URL || App.GLOBAL_ADMISSION_URL || '';
        bridge.openLinkedDevicesSettings(admission);
        return { ok: true, path: 'ANDROID_NATIVE_LINKED_DEVICES', DECODE_IS_NOT_AUTHORIZATION: true };
      } catch (_n) {}
    }
    const Scanner = App.WebLinkedQrScanner || window.SosWebLinkedQrScanner;
    if (!Scanner || typeof Scanner.startLinkedDeviceQrScan !== 'function') {
      try {
        window.alert('סורק המצלמה אינו זמין. רעננו את העמוד ונסו שוב.');
      } catch (_a) {}
      return Promise.resolve({
        ok: false,
        code: 'WEB_QR_SCANNER_MISSING',
        DECODE_IS_NOT_AUTHORIZATION: true,
      });
    }
    return beginPrimaryCameraScan().catch(function (err) {
      try {
        window.alert(String((err && err.message) || err || 'SCAN_FAIL'));
      } catch (_a) {}
      return { ok: false, code: 'SCAN_FAIL', DECODE_IS_NOT_AUTHORIZATION: true };
    });
  }

  /** Product entry: platform-aware primary Linked Devices action (menu / login buttons). */
  function openLinkedDevicesPrimaryAction(opts) {
    const cls = classifyLinkedDevicesSurface(opts);
    // Native APK: open CameraX PhoneIssuer activity (not the Web QR scanner page).
    if (cls.nativeShell) {
      const bridge =
        window.SosNativeShell || window.AndroidBridge || window.SosAndroidBridge;
      if (bridge && typeof bridge.openLinkedDevicesSettings === 'function') {
        try {
          const admission = App.FIRST_GROUP_ADMISSION_URL || App.GLOBAL_ADMISSION_URL || '';
          bridge.openLinkedDevicesSettings(admission);
          return {
            ok: true,
            path: 'ANDROID_NATIVE_LINKED_DEVICES',
            DECODE_IS_NOT_AUTHORIZATION: true,
          };
        } catch (_n) {}
      }
    }
    // Mobile web: dedicated Linked Devices page (scan is the in-page primary CTA).
    if (cls.role === 'MOBILE_PRIMARY' || cls.nativeShell) {
      return openMobileLinkedDevicesPage();
    }
    if (cls.role === 'DESKTOP_DESTINATION') {
      openDesktopPairingPanel();
      return { ok: true, path: 'DESKTOP_DISPLAY_QR' };
    }
    openRoleChooserPanel();
    return { ok: true, path: 'ROLE_CHOOSER', AMBIGUOUS: true, reason: cls.reason };
  }

  const VAULT_NOT_READY_HE =
    'כדי לקשר את המחשב יש להשלים פעם אחת את אישור החשבון.\nהמחשב זוהה, אך הקישור עדיין לא אושר.\nאין צורך לחזור על כך בכל קישור.';

  function wireAccountSetupReturn() {
    if (window.__sosLdSetupReturnBound) return;
    window.__sosLdSetupReturnBound = true;
    window.addEventListener('sos-signer-import-success', function () {
      showPersistentLinkStatus({ ok: false, code: 'ACCOUNT_READY_SCAN_FRESH_QR' });
    });
    window.addEventListener('sos-recovery-backup-state', function (ev) {
      const st = ev && ev.detail && ev.detail.state;
      if (st === 'IN_SIGNER' || st === 'CONFIRMED') {
        showPersistentLinkStatus({ ok: false, code: 'ACCOUNT_READY_SCAN_FRESH_QR' });
      } else if (st === 'ERROR') {
        showPersistentLinkStatus({
          ok: false,
          code: 'ACCOUNT_SETUP_FAILED',
          detailCode: ev.detail && ev.detail.code,
        });
      }
    });
  }

  function startOneTimeAccountSetup() {
    wireAccountSetupReturn();
    const pk = String(App.publicKey || '')
      .trim()
      .toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pk) || App.guestMode) {
      showPersistentLinkStatus({ ok: false, code: 'NOT_AUTHENTICATED' });
      return { ok: false, code: 'NOT_AUTHENTICATED' };
    }
    const Backup = App.RecoveryBackup || window.SosRecoveryBackup;
    if (Backup && typeof Backup.isWorkerIdentity === 'function' && Backup.isWorkerIdentity() && typeof Backup.start === 'function') {
      const started = Backup.start();
      if (!started || started.ok !== true) {
        showPersistentLinkStatus({
          ok: false,
          code: started && started.code === 'POPUP_BLOCKED' ? 'SIGNER_POPUP_BLOCKED' : 'TRUSTED_SIGNER_UNAVAILABLE',
        });
        return started || { ok: false, code: 'HANDOFF_FAILED' };
      }
      showPersistentLinkStatus({ pending: true, setup: true });
      return started;
    }
    const Imp = App.IsolatedSignerTrustedImport || window.SosIsolatedSignerTrustedImport;
    if (!Imp || typeof Imp.openTrustedImport !== 'function') {
      showPersistentLinkStatus({ ok: false, code: 'TRUSTED_SIGNER_UNAVAILABLE' });
      return { ok: false, code: 'IMPORT_LAUNCHER_MISSING' };
    }
    let opened;
    try {
      opened = Imp.openTrustedImport({ expectedPubkey: pk });
    } catch (err) {
      showPersistentLinkStatus({ ok: false, code: (err && err.code) || 'TRUSTED_SIGNER_UNAVAILABLE' });
      return { ok: false, code: (err && err.code) || 'OPEN_FAILED' };
    }
    if (!opened || opened.ok !== true) {
      showPersistentLinkStatus({
        ok: false,
        code: opened && opened.code === 'POPUP_BLOCKED' ? 'SIGNER_POPUP_BLOCKED' : (opened && opened.code) || 'TRUSTED_SIGNER_UNAVAILABLE',
      });
      return opened || { ok: false, code: 'OPEN_FAILED' };
    }
    showPersistentLinkStatus({ pending: true, setup: true });
    return opened;
  }

  function openPasskeyEnrollment() {
    let opened = null;
    try {
      opened = window.open('https://signer.sos010.com/enroll.html', 'sos_signer_enroll', 'width=480,height=720');
    } catch (_e) {
      opened = null;
    }
    if (!opened) {
      showPersistentLinkStatus({ ok: false, code: 'SIGNER_POPUP_BLOCKED' });
    }
  }

  function ldTrace(phase, extra) {
    try {
      const src = extra && typeof extra === 'object' ? extra : {};
      const row = { t: Date.now(), phase: String(phase || '') };
      if (src.pairingFp) row.pairingFp = String(src.pairingFp).slice(0, 12);
      if (src.accountFp) row.accountFp = String(src.accountFp).slice(0, 8);
      if (src.code) row.code = String(src.code).slice(0, 64);
      if (src.vaultState) row.vaultState = String(src.vaultState).slice(0, 32);
      window.__sosLdLinkTrace = window.__sosLdLinkTrace || [];
      window.__sosLdLinkTrace.push(row);
      const parts = ['[SOS-LD]', row.phase];
      if (row.pairingFp) parts.push('pairingFp=' + row.pairingFp);
      if (row.accountFp) parts.push('accountFp=' + row.accountFp);
      if (row.code) parts.push('code=' + row.code);
      if (row.vaultState) parts.push('vaultState=' + row.vaultState);
      console.info(parts.join(' '));
    } catch (_e) {}
  }

  function ensureMobileLinkStatusEl() {
    const page = document.getElementById('sosLdMobilePage');
    if (!page) return null;
    let box = document.getElementById('sosLdMobileLinkStatus');
    if (!box) {
      box = document.createElement('div');
      box.id = 'sosLdMobileLinkStatus';
      box.className = 'sos-ld-link-status';
      box.setAttribute('role', 'status');
      box.hidden = true;
      const body = page.querySelector('.sos-ld-mobile-body');
      const scan = page.querySelector('#sosLdMobileScan');
      if (body && scan && scan.parentNode === body) body.insertBefore(box, scan);
      else if (body) body.insertBefore(box, body.firstChild);
    }
    return box;
  }

  function showPersistentLinkStatus(result) {
    if (!document.getElementById('sosLdMobilePage')) {
      try {
        openMobileLinkedDevicesPage();
      } catch (_e) {}
    }
    const box = ensureMobileLinkStatusEl();
    if (!box || !result) return;
    const code = String(result.code || '');
    box.classList.remove('is-ok', 'is-pending');
    box.replaceChildren();
    if (result.pending && result.setup) {
      box.hidden = false;
      box.classList.add('is-pending');
      box.textContent = 'נפתח אישור חד-פעמי של החשבון.\nהשלימו אותו בחלון שנפתח, ואז סרקו קוד QR חדש מהמחשב.';
      return;
    }
    if (result.pending) {
      box.hidden = false;
      box.classList.add('is-pending');
      box.textContent = 'הקוד זוהה. ממשיכים לאישור במכשיר.';
      return;
    }
    if (result.ok === true && code === 'LINKED' && result.WEB_MD3_ISSUANCE === true) {
      rememberAuthorizedDevice(result.authorization);
      markLiveLinkedDevice(result.authorization);
      paintMobileDeviceList(localAccountDevices(), localAccountDevices().length ? 'ready' : 'loading');
      refreshMobileDeviceList();
      box.hidden = true;
      box.textContent = '';
      return;
    }
    if (result.nativeStarted) return;
    let text = '';
    const actions = [];
    if (code === 'VAULT_NOT_READY') {
      text = VAULT_NOT_READY_HE;
      actions.push({ action: 'setup', label: 'השלמת אישור החשבון' });
    } else if (code === 'WEBAUTHN_ENROLLMENT_REQUIRED' || code === 'NO_WEBAUTHN_CREDENTIAL') {
      text = 'נדרש אישור חד-פעמי במכשיר.\nהמחשב עדיין לא מחובר.';
    } else if (code === 'ACCOUNT_MISMATCH') {
      text = 'האישור אינו תואם לחשבון SOS הפעיל.\nהמחשב לא חובר.';
    } else if (code === 'ACCOUNT_READY_SCAN_FRESH_QR') {
      text = 'החשבון מוכן לאישור.\nהמחשב עדיין לא מחובר.\nסרקו את הקוד מהמחשב.';
    } else if (code === 'ACCOUNT_SETUP_FAILED') {
      text = 'אישור החשבון לא הושלם.\nאפשר לנסות שוב, ואז לסרוק קוד חדש.';
      actions.push({ action: 'setup', label: 'השלמת אישור החשבון' });
    } else if (code === 'NOT_AUTHENTICATED') {
      text = 'הקוד זוהה. יש להתחבר לחשבון SOS כדי להמשיך.';
    } else if (code === 'USER_CANCELLED' || code === 'USER_REJECTED' || code === 'SCAN_CANCELLED' || code === 'STOPPED' || code === 'UV_CANCELLED') {
      text = 'האישור במכשיר בוטל.\nהמחשב לא חובר.';
    } else if (code === 'TRUSTED_SIGNER_UNAVAILABLE' || code === 'SIGNER_POPUP_BLOCKED' || code === 'SIGNER_TIMEOUT') {
      text = 'הקישור לא הושלם.\nצרו קוד חדש במחשב וסרקו שוב.';
    } else if (result.ok === true && result.WEB_MD3_ISSUANCE !== true) {
      text = 'המחשב זוהה, אך הסריקה לבדה אינה מאשרת קישור.';
    } else if (result.ok !== true) {
      text = 'הקישור לא הושלם.\nצרו קוד חדש במחשב וסרקו שוב.';
    } else {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const body = document.createElement('div');
    body.textContent = text;
    box.appendChild(body);
    if (actions.length) {
      const row = document.createElement('div');
      row.className = 'sos-ld-link-actions';
      actions.forEach(function (a) {
        if (a.action === 'setup' || a.action === 'enroll') {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = a.label;
          btn.onclick = function () {
            if (a.action === 'enroll') openPasskeyEnrollment();
            else startOneTimeAccountSetup();
          };
          row.appendChild(btn);
          return;
        }
        if (!a.href) return;
        const link = document.createElement('a');
        link.href = a.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = a.label;
        row.appendChild(link);
      });
      box.appendChild(row);
    }
  }

  /**
   * MD3W-W2 — Primary camera scan → SOSPAIR1 parse → existing approval/issuance path.
   * Optical decode never authorizes by itself.
   */
  async function beginPrimaryCameraScan() {
    const Scanner = App.WebLinkedQrScanner || window.SosWebLinkedQrScanner;
    if (!Scanner || typeof Scanner.startLinkedDeviceQrScan !== 'function') {
      return { ok: false, code: 'WEB_QR_SCANNER_MISSING', DECODE_IS_NOT_AUTHORIZATION: true };
    }
    const scanned = await Scanner.startLinkedDeviceQrScan({});
    if (!scanned || scanned.ok !== true || !scanned.qrText) {
      const cancelled = {
        ok: false,
        code: (scanned && scanned.code) || 'SCAN_CANCELLED',
        DECODE_IS_NOT_AUTHORIZATION: true,
      };
      showPersistentLinkStatus(cancelled);
      return cancelled;
    }
    showPersistentLinkStatus({ pending: true, ok: false, code: 'QR_DECODED' });
    // Reuse product approval path (Web T2 PhoneIssuer when flagged; else Android/native messaging).
    const approved = await beginPrimaryApproval(scanned.qrText);
    const result = Object.assign(
      { DECODE_IS_NOT_AUTHORIZATION: true, W2_SOSPAIR1_SCAN: true },
      approved || { ok: false, code: 'APPROVAL_PATH_FAIL' },
    );
    // Optical decode and MD2 never mark the desktop LINKED.
    if (result.ok === true && result.code === 'LINKED' && result.WEB_MD3_ISSUANCE === true) {
      showPersistentLinkStatus(result);
    } else if (!result.nativeStarted) {
      showPersistentLinkStatus(result);
    }
    return result;
  }

  /** Primary-side: parse QR and show approval UI. Signing requires Android native issuer or Web T2. */
  async function beginPrimaryApproval(qrText) {
    const Md2 = App.Md2PairingQr;
    const parsed = Md2.parseQr(qrText);
    if (!parsed.ok) return { ok: false, code: parsed.error || 'BAD_QR' };
    const me = String(App.publicKey || '').toLowerCase();
    ldTrace('QR_DECODED', {
      pairingFp: String((parsed.payload && parsed.payload.pairingId) || '').slice(0, 12),
      accountFp: me.slice(0, 8),
    });
    if (!me || App.guestMode) return { ok: false, code: 'NOT_AUTHENTICATED' };
    try {
      const GA = App.GlobalAdmission || window.SosGlobalAdmission;
      if (GA && typeof GA.reconcileAccountStatus === 'function') {
        await GA.reconcileAccountStatus(me).catch(function () {});
      }
    } catch (_rec) {}
    const gate = assertPairingAllowed(me);
    if (gate && gate.ok === false) return { ok: false, code: gate.code || 'ACCOUNT_DISABLED', KNOWN_DISABLED_P_PAIRING_ACCEPTED: false };
    const bridge =
      window.SosNativeShell ||
      window.AndroidBridge ||
      window.SosAndroidBridge;
    const nativeAuthorize =
      bridge &&
      (typeof bridge.authorizeLinkedDevice === 'function' ||
        typeof bridge.startLinkedDevicePairing === 'function' ||
        typeof bridge.openLinkedDevicesSettings === 'function');
    // On Android shell, hand QR to native PhoneIssuer UI (never WebView root sign).
    if (nativeAuthorize && typeof bridge.startLinkedDevicePairing === 'function') {
      try {
        const admission = App.FIRST_GROUP_ADMISSION_URL || App.GLOBAL_ADMISSION_URL || '';
        const raw = bridge.startLinkedDevicePairing(qrText, admission);
        const parsedNative = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (parsedNative && parsedNative.ok) {
          return {
            ok: true,
            payload: parsed.payload,
            requiresExplicitApproval: true,
            nativeAuthorizeAvailable: true,
            WEB_MD3_ISSUANCE: false,
            MD3_ISSUANCE_PATH: 'ANDROID_NATIVE',
            nativeStarted: true,
          };
        }
      } catch (_native) {}
    }
    // MD3W-W1B: Mobile Web Primary via T2 signer approval + Worker AUTHORIZE_LINKED_DEVICE.
    const Issuer = App.WebPhoneIssuer || window.SosWebPhoneIssuer;
    const webIssuance =
      Issuer &&
      typeof Issuer.featureEnabled === 'function' &&
      Issuer.featureEnabled() === true &&
      typeof Issuer.issueFromPairingQr === 'function';
    if (webIssuance && !nativeAuthorize) {
      try {
        const issued = await Issuer.issueFromPairingQr(qrText, {});
        if (issued && issued.ok) {
          return Object.assign(
            {
              ok: true,
              payload: parsed.payload,
              requiresExplicitApproval: true,
              nativeAuthorizeAvailable: false,
              WEB_MD3_ISSUANCE: true,
              MD3_ISSUANCE_PATH: 'WEB_PHONEISSUER_T2',
              T1_FALLBACK_DISABLED: true,
            },
            issued,
          );
        }
        return {
          ok: false,
          code: (issued && issued.code) || 'WEB_PHONEISSUER_FAILED',
          vaultState: (issued && issued.vaultState) || '',
          payload: parsed.payload,
          WEB_MD3_ISSUANCE: true,
          MD3_ISSUANCE_PATH: 'WEB_PHONEISSUER_T2',
          T1_FALLBACK_DISABLED: true,
        };
      } catch (_web) {
        return {
          ok: false,
          code: 'WEB_PHONEISSUER_EXCEPTION',
          WEB_MD3_ISSUANCE: true,
          MD3_ISSUANCE_PATH: 'WEB_PHONEISSUER_T2',
          T1_FALLBACK_DISABLED: true,
        };
      }
    }
    return {
      ok: true,
      payload: parsed.payload,
      requiresExplicitApproval: true,
      nativeAuthorizeAvailable: !!nativeAuthorize,
      // Product truth without flag: web cannot mint MD3 root signature.
      WEB_MD3_ISSUANCE: false,
      MD3_ISSUANCE_PATH: nativeAuthorize
        ? 'ANDROID_NATIVE'
        : Issuer
          ? 'WEB_T2_UNAVAILABLE'
          : 'REQUIRES_SOS_ANDROID_APP',
      T1_FALLBACK_DISABLED: true,
    };
  }

  /**
   * Accept MD3 authorization: strict Schnorr verify + durable persist (MD4 S1).
   * Mere presence of rootSignature is never sufficient.
   */
  async function acceptAuthorizationObject(auth, ctx) {
    const Auth = md4Auth();
    const Store = md4Store();
    if (!Auth || typeof Auth.verifyForDestination !== 'function') {
      return { ok: false, code: 'AUTH_MODULE_MISSING' };
    }
    if (!Store || typeof Store.unsupported !== 'function') {
      return { ok: false, code: 'STORE_MODULE_MISSING' };
    }
    const support = Store.unsupported();
    if (!support.ok) return support;

    if (!auth || auth.version !== AUTH_VERSION) return { ok: false, code: 'UNKNOWN_VERSION' };

    const localDevice = _sessionDevice || (ctx && ctx.session
      ? {
          deviceId: ctx.session.deviceId,
          D_sign_pub: ctx.session.dSignPub,
          D_enc_pub: ctx.session.dEncPub,
        }
      : null);
    if (!localDevice) return { ok: false, code: 'NO_LOCAL_DEVICE' };

    const GAS = App.GlobalAccountStatusState || window.SosGlobalAccountStatusState;
    const accountP = String(auth.accountP || '').toLowerCase();
    if (GAS && typeof GAS.assertLinkedDeviceBindAllowed === 'function' && /^[0-9a-f]{64}$/.test(accountP)) {
      const gate = GAS.assertLinkedDeviceBindAllowed(accountP);
      if (gate && gate.ok === false) return { ok: false, code: gate.code || 'ACCOUNT_DISABLED' };
    }

    const verified = await Auth.verifyForDestination(
      auth,
      {
        accountP,
        deviceId: localDevice.deviceId,
        D_sign_pub: localDevice.D_sign_pub,
        D_enc_pub: localDevice.D_enc_pub || auth.D_enc_pub,
      },
      Date.now(),
      { requireHistorySync: true },
    );
    if (!verified.ok) {
      return { ok: false, code: verified.code, MD3_AUTHORIZATION_CRYPTO_VERIFIED: false };
    }

    const devices = readRegistry().filter((d) => String(d.accountP || '').toLowerCase() === accountP);
    if (devices.length >= MAX_LINKED) return { ok: false, code: 'MAX_LINKED_DEVICES' };

    let secrets = (ctx && ctx.secrets && ctx.secrets.ok && ctx.secrets) || null;
    if (!secrets && ctx && ctx.session && typeof ctx.session.exportDeviceSecrets === 'function') {
      const exported = ctx.session.exportDeviceSecrets();
      if (exported && exported.ok) secrets = exported;
    }
    if (!secrets) return { ok: false, code: 'DEVICE_SECRETS_UNAVAILABLE' };

    const persisted = await Store.persistLinkedDevice({
      accountP,
      deviceId: secrets.deviceId,
      D_sign_pub: secrets.D_sign_pub,
      D_enc_pub: secrets.D_enc_pub,
      dSignSk: secrets.dSignSk,
      dEncPriv: secrets.dEncPriv,
      authorization: auth,
    });
    if (!persisted.ok) return { ok: false, code: persisted.code || 'PERSIST_FAIL', MD3_AUTHORIZATION_CRYPTO_VERIFIED: true };

    _sessionDevice = {
      scheme: SCHEME,
      deviceId: secrets.deviceId,
      D_sign_pub: secrets.D_sign_pub,
      D_enc_pub: secrets.D_enc_pub,
      storageClass: 'BROWSER_WEBCYPTO_WRAPPED',
      recoveryEligible: false,
      RECOVERY_CAPABLE: false,
      hardwareBacked: false,
      deviceType: 'DESKTOP',
      label: 'דפדפן',
      accountP,
      dSignSk: secrets.dSignSk,
      dEncPriv: secrets.dEncPriv,
    };
    _durableAuth = auth;

    // Public registry only (no privates) — account-scoped list for UI.
    const reg = readRegistry().filter((d) => String(d.deviceId).toLowerCase() !== String(secrets.deviceId).toLowerCase());
    reg.push({
      deviceId: String(secrets.deviceId).toLowerCase(),
      deviceLabel: String(auth.deviceLabel || 'דפדפן').slice(0, 64),
      accountP,
      createdAt: auth.createdAt || Date.now(),
      status: 'ACTIVE',
      authorizationId: auth.authorizationId || null,
      authEpoch: auth.authEpoch || 1,
    });
    writeRegistry(reg);

    // Public meta only in localStorage — never privates.
    try {
      localStorage.setItem(
        DEVICE_KEY,
        JSON.stringify({
          scheme: SCHEME,
          deviceId: secrets.deviceId,
          D_sign_pub: secrets.D_sign_pub,
          D_enc_pub: secrets.D_enc_pub,
          accountP,
          storageClass: 'BROWSER_WEBCYPTO_WRAPPED',
          recoveryEligible: false,
          RECOVERY_CAPABLE: false,
        }),
      );
    } catch (_e) {}

    if (_pairing) _pairing.state = 'APPROVED';
    try {
      window.__sosLdLinkedIdentity = {
        accountFp: String(accountP || '').toLowerCase().slice(0, 8),
        caps: Array.isArray(auth.capabilities) ? auth.capabilities.map(String) : [],
        HISTORY_SYNC_TRANSFERRED: false,
        ROOT_K_PRESENT: false,
      };
    } catch (_id) {}
    return {
      ok: true,
      ROOT_K_SENT_TO_DESKTOP: false,
      NSEC_SENT_TO_DESKTOP: false,
      MD3_AUTHORIZATION_CRYPTO_VERIFIED: true,
      DURABLE_PERSISTED: true,
      RECOVERY_CAPABLE: false,
    };
  }

  async function restoreDurableSession(accountP) {
    const Store = md4Store();
    const Auth = md4Auth();
    if (!Store || !Auth) return { ok: false, code: 'MODULE_MISSING' };
    const support = Store.unsupported();
    if (!support.ok) return support;
    const pk = String(accountP || App.publicKey || '')
      .toLowerCase()
      .replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(pk)) return { ok: false, code: 'NO_ACCOUNT' };
    const loaded = await Store.loadAnyForAccount(pk);
    if (!loaded.ok) {
      _sessionDevice = null;
      _durableAuth = null;
      return loaded;
    }
    _sessionDevice = {
      scheme: SCHEME,
      deviceId: loaded.deviceId,
      D_sign_pub: loaded.D_sign_pub,
      D_enc_pub: loaded.D_enc_pub,
      storageClass: loaded.storageClass,
      recoveryEligible: false,
      RECOVERY_CAPABLE: false,
      hardwareBacked: false,
      deviceType: 'DESKTOP',
      label: 'דפדפן',
      accountP: loaded.accountP,
      dSignSk: loaded.dSignSk,
      dEncPriv: loaded.dEncPriv,
    };
    _durableAuth = loaded.authorization;
    return {
      ok: true,
      code: 'RESTORED',
      deviceId: loaded.deviceId,
      accountP: loaded.accountP,
      authorizationId: loaded.authorization && loaded.authorization.authorizationId,
      MD3_AUTHORIZATION_CRYPTO_VERIFIED: true,
      ROOT_K_PRESENT: false,
    };
  }

  async function clearDurableForAccount(accountP) {
    const Store = md4Store();
    if (!Store) return { ok: false, code: 'STORE_MODULE_MISSING' };
    const pk = String(accountP || '')
      .toLowerCase()
      .replace(/^0x/, '');
    const r = await Store.clearAccount(pk);
    if (_sessionDevice && String(_sessionDevice.accountP || '').toLowerCase() === pk) {
      _sessionDevice = null;
      _durableAuth = null;
    }
    writeRegistry(readRegistry().filter((d) => String(d.accountP || '').toLowerCase() !== pk));
    return r;
  }

  function getDurableAuthorization() {
    return _durableAuth ? JSON.parse(JSON.stringify(_durableAuth)) : null;
  }

  async function assertHistorySyncReady() {
    const Auth = md4Auth();
    if (!Auth) return { ok: false, code: 'AUTH_MODULE_MISSING' };
    if (!_sessionDevice || !_durableAuth) return { ok: false, code: 'NO_DURABLE_SESSION' };
    return Auth.assertHistorySyncAuthorized({
      authorization: _durableAuth,
      device: _sessionDevice,
      requireFreshAuthority: false,
    });
  }

  function formatPairExpiry(expiresAt) {
    const ms = Number(expiresAt) - Date.now();
    if (!(ms > 0)) return 'פג תוקף';
    const sec = Math.ceil(ms / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? m + ':' + String(s).padStart(2, '0') + ' דק׳' : s + ' שנ׳';
  }

  function setQrErrorState(wrapEl, statusEl, message) {
    if (wrapEl) {
      wrapEl.classList.add('is-error');
      wrapEl.innerHTML =
        '<div><strong>לא ניתן ליצור קוד כרגע</strong><br/>' +
        '<span style="opacity:.85">' +
        escapeHtml(message || 'נסו שוב בעוד רגע') +
        '</span><br/>' +
        '<button type="button" class="button-secondary" data-ld-retry-qr style="margin-top:12px;min-height:40px;">נסה שוב</button></div>';
      const retry = wrapEl.querySelector('[data-ld-retry-qr]');
      if (retry) {
        retry.onclick = function () {
          const root = wrapEl.closest('#sosLdGuestWelcome, #sosLinkedPairPanel') || wrapEl.parentElement;
          if (root) startPairingIntoUi(root);
        };
      }
    }
    if (statusEl) statusEl.textContent = 'שגיאה ביצירת קוד';
  }

  function preferredQrCanvasCssPx() {
    try {
      const vw = Math.max(280, Math.min(Number(window.innerWidth) || 440, 520));
      return Math.max(360, Math.min(440, Math.floor(vw * 0.86)));
    } catch (_e) {
      return 440;
    }
  }

  function ensureQrCanvas(wrapEl) {
    if (!wrapEl) return null;
    wrapEl.classList.remove('is-error');
    const cssPx = preferredQrCanvasCssPx();
    // Backing store ≥ CSS size × DPR so modules stay sharp on HiDPI desktop screens.
    let dpr = 1;
    try {
      dpr = Math.max(1, Math.min(3, Number(window.devicePixelRatio) || 1));
    } catch (_d) {}
    const px = Math.max(360, Math.min(880, Math.round(cssPx * dpr)));
    let canvas = wrapEl.querySelector('canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'sosLinkedPairCanvas';
      canvas.setAttribute('aria-label', 'קוד לקישור מחשב');
      wrapEl.innerHTML = '';
      wrapEl.appendChild(canvas);
    }
    canvas.width = px;
    canvas.height = px;
    canvas.style.width = cssPx + 'px';
    canvas.style.height = cssPx + 'px';
    return canvas;
  }

  function bindDesktopPairingControls(root, opts) {
    const o = opts || {};
    const refreshBtn = root.querySelector('[data-ld-refresh]');
    if (refreshBtn) {
      refreshBtn.onclick = () => {
        Promise.resolve(refreshPairingQr())
          .then(renderPairingUi)
          .catch((err) => {
            const wrap = root.querySelector('.sos-ld-qr-wrap');
            const st = root.querySelector('.sos-ld-status');
            setQrErrorState(wrap, st, String((err && err.message) || err || ''));
          });
      };
    }
    const guestBtn = root.querySelector('[data-ld-continue-guest]');
    if (guestBtn) guestBtn.onclick = () => continueAsGuest();
    const closeBtn = root.querySelector('[data-ld-close]');
    if (closeBtn && o.onClose) closeBtn.onclick = o.onClose;
    const loginBtn = root.querySelector('[data-ld-open-login]');
    if (loginBtn) {
      loginBtn.onclick = () => {
        if (typeof App.openAuthPrompt === 'function') {
          App.openAuthPrompt('התחברו או הירשמו כדי ליצור פרופיל אישי.');
        }
      };
    }
  }

  function renderPairingUi() {
    ensureLinkedDevicesStyles();
    const roots = [
      document.getElementById('sosLdGuestWelcome'),
      document.getElementById('sosLinkedPairPanel'),
    ].filter(Boolean);
    roots.forEach((root) => {
      if (root.hidden) return;
      const wrap = root.querySelector('.sos-ld-qr-wrap');
      const st = root.querySelector('.sos-ld-status');
      const exp = root.querySelector('.sos-ld-expiry');
      if (!_pairing) return;
      if (st) {
        const map = {
          WAITING: 'ממתינים לסריקה בטלפון…',
          EXPIRED: 'פג תוקף הקוד — צרו קוד חדש',
          APPROVAL_PENDING: 'ממתינים לאישור בטלפון…',
          APPROVED: 'המחשב מחובר',
          REJECTED: 'הקישור נדחה',
          FAILURE: 'הקישור נכשל — נסו שוב',
        };
        let statusText = map[_pairing.state] || _pairing.state;
        try {
          const phases = window.__sosMd3DbgPhases || [];
          const lastFail = [...phases].reverse().find((p) => p && p.phase === 'POP_SIGN_FAIL');
          if (lastFail && _pairing.state === 'WAITING') {
            statusText = 'שגיאת חתימת אימות מחשב — רעננו את הקוד';
          }
        } catch (_p) {}
        st.textContent = statusText;
      }
      if (_pairing.state === 'APPROVED' && _durableAuth) {
        paintLinkedIdentity(root, _durableAuth.accountP, _durableAuth.capabilities);
      }
      if (exp) {
        exp.textContent =
          _pairing.state === 'EXPIRED'
            ? 'הקוד אינו תקף עוד'
            : _pairing.state === 'APPROVAL_PENDING'
              ? 'הקוד נסרק. ממתינים לאישור במכשיר.'
              : 'תוקף הקוד: ' + formatPairExpiry(_pairing.expiresAt);
      }
      const Md2 = App.Md2PairingQr;
      if (wrap && Md2 && _pairing.qrText && _pairing.state !== 'EXPIRED') {
        const canvas = ensureQrCanvas(wrap);
        Promise.resolve(Md2.renderPairingQrToCanvas(canvas, _pairing.qrText)).catch((err) => {
          setQrErrorState(wrap, st, String((err && err.message) || err || 'RENDER_FAIL'));
        });
      }
    });
  }

  function startPairingIntoUi(root) {
    if (linkedDeviceReady()) {
      renderRestoredDesktop(root);
      return Promise.resolve({ ok: true, code: 'ALREADY_LINKED' });
    }
    if (!root || typeof root.querySelector !== 'function') {
      return Promise.resolve({ ok: false, code: 'UI_ROOT_MISSING' });
    }
    const wrap = root.querySelector('.sos-ld-qr-wrap');
    const st = root.querySelector('.sos-ld-status');
    if (wrap) {
      try {
        if (wrap.classList && typeof wrap.classList.remove === 'function') wrap.classList.remove('is-error');
      } catch (_c) {}
      wrap.innerHTML = '<canvas id="sosLinkedPairCanvas" width="440" height="440" aria-label="קוד לקישור מחשב"></canvas>';
    }
    if (st) st.textContent = 'יוצרים קוד…';
    return Promise.resolve(startDesktopPairingSession())
      .then(renderPairingUi)
      .catch((err) => {
        setQrErrorState(wrap, st, 'לא ניתן ליצור קוד כרגע. אפשר להמשיך כאורח או לנסות שוב.');
        try {
          window.__sosLdQrCreateErr = String((err && err.message) || err).slice(0, 240);
        } catch (_e) {}
        return { ok: false, code: 'QR_CREATE_FAIL' };
      });
  }

  /** Polished desktop QR panel (menu reopen / non-welcome). */
  function openDesktopPairingPanel() {
    ensureLinkedDevicesStyles();
    const Md2 = App.Md2PairingQr || window.SosMd2PairingQr;
    const Session = App.Md2PairingSession || window.SosMd2PairingSession;
    if (!Md2 || typeof Md2.renderPairingQrToCanvas !== 'function' || !Session) {
      try {
        window.alert('קישור המכשירים אינו זמין כעת. רעננו את העמוד ונסו שוב.');
      } catch (_a) {}
      return { ok: false, code: 'LINKED_DEVICES_MODULE_MISSING' };
    }
    // Hide guest welcome if open as separate layer
    const welcome = document.getElementById('sosLdGuestWelcome');
    if (welcome) welcome.hidden = true;
    let el = document.getElementById('sosLinkedPairPanel');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sosLinkedPairPanel';
      el.innerHTML =
        '<div class="sos-ld-backdrop" data-ld-close></div>' +
        '<div class="sos-ld-shell" role="dialog" aria-modal="true" dir="rtl">' +
        '<h2>קישור מחשב לטלפון</h2>' +
        '<p class="sos-ld-sub">פתחו SOS בטלפון, היכנסו למכשירים מקושרים וסרקו את הקוד.</p>' +
        '<div class="sos-ld-qr-wrap"><canvas id="sosLinkedPairCanvas" width="440" height="440"></canvas></div>' +
        '<p class="sos-ld-status"></p><p class="sos-ld-expiry"></p>' +
        '<div class="sos-ld-actions">' +
        '<button type="button" class="button-primary" data-ld-refresh>קוד חדש</button>' +
        '<button type="button" class="button-secondary" data-ld-close>סגור</button>' +
        '</div></div>';
      document.body.appendChild(el);
      el.addEventListener('click', (e) => {
        if (e.target && e.target.hasAttribute('data-ld-close')) {
          el.hidden = true;
          disposePairingSession();
        }
      });
      bindDesktopPairingControls(el, {
        onClose: () => {
          el.hidden = true;
          disposePairingSession();
        },
      });
    }
    el.hidden = false;
    presentDesktopSurface(el);
    return { ok: true, path: 'DESKTOP_DISPLAY_QR' };
  }

  function showGuestQrWelcome() {
    ensureLinkedDevicesStyles();
    let el = document.getElementById('sosLdGuestWelcome');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sosLdGuestWelcome';
      el.innerHTML =
        '<div class="sos-ld-backdrop"></div>' +
        '<div class="sos-ld-shell" role="dialog" aria-modal="true" dir="rtl">' +
        '<h1>חיבור SOS באמצעות הטלפון</h1>' +
        '<p class="sos-ld-sub">פתחו SOS בטלפון, היכנסו למכשירים מקושרים וסרקו את הקוד.</p>' +
        '<div class="sos-ld-qr-wrap"><canvas width="440" height="440"></canvas></div>' +
        '<p class="sos-ld-status"></p><p class="sos-ld-expiry"></p>' +
        '<div class="sos-ld-actions">' +
        '<button type="button" class="button-primary" data-ld-continue-guest>המשך כאורח</button>' +
        '</div>' +
        '<p class="sos-ld-footnote">הקוד מתחדש אוטומטית כשפג תוקפו. סריקה אחת בטלפון המחובר פותחת את אותו חשבון במחשב.</p>' +
        '</div>';
      document.body.appendChild(el);
      bindDesktopPairingControls(el, {});
    } else {
      // Ensure legacy secondary actions stay removed if an older DOM node is reused.
      try {
        el.querySelectorAll('[data-ld-refresh],[data-ld-open-login]').forEach(function (n) {
          if (n && n.parentNode) n.parentNode.removeChild(n);
        });
      } catch (_rm) {}
    }
    el.hidden = false;
    try {
      window.__sosLdGuestWelcomeActive = true;
    } catch (_f) {}
    presentDesktopSurface(el);
    return { ok: true, path: 'GUEST_FIRST_ENTRY_QR' };
  }

  function paintLinkedIdentity(root, accountP, caps) {
    if (!root || typeof root.querySelector !== 'function') return;
    const fp = String(accountP || '').toLowerCase().slice(0, 8);
    if (!/^[0-9a-f]{8}$/.test(fp)) return;
    const line = root.querySelector('.sos-ld-linked-identity');
    if (line && line.parentNode) line.parentNode.removeChild(line);
    try {
      window.__sosLdLinkedIdentity = {
        accountFp: fp,
        caps: Array.isArray(caps) ? caps.map(String) : (window.__sosLdLinkedIdentity && window.__sosLdLinkedIdentity.caps) || [],
        HISTORY_SYNC_TRANSFERRED: false,
        ROOT_K_PRESENT: false,
      };
    } catch (_e) {}
  }

  function renderRestoredDesktop(root) {
    const st = root && root.querySelector ? root.querySelector('.sos-ld-status') : null;
    const exp = root && root.querySelector ? root.querySelector('.sos-ld-expiry') : null;
    const wrap = root && root.querySelector ? root.querySelector('.sos-ld-qr-wrap') : null;
    if (st) st.textContent = 'המחשב מחובר';
    if (_durableAuth) paintLinkedIdentity(root, _durableAuth.accountP, _durableAuth.capabilities);
    if (exp) exp.textContent = '';
    if (wrap) {
      wrap.classList.remove('is-error');
      wrap.innerHTML = '';
    }
    if (_pairTimer) {
      clearInterval(_pairTimer);
      _pairTimer = null;
    }
    _pairing = { state: 'APPROVED', expiresAt: Date.now() + 86400000, _session: null };
    Promise.resolve(openLinkedDesktopAccount()).catch(function () {});
  }

  async function proveGrantedCapability(cap) {
    const dev = _sessionDevice;
    const auth = _durableAuth;
    if (!dev || !auth || !dev.dSignSk) return { ok: false, code: 'NO_DEVICE_KEY', ROOT_K_PRESENT: false };
    const caps = Array.isArray(auth.capabilities) ? auth.capabilities.map(String) : [];
    if (caps.indexOf(cap) === -1) return { ok: false, code: 'CAPABILITY_MISSING', ROOT_K_PRESENT: false };
    const Md2 = App.Md2PairingSession || window.SosMd2PairingSession;
    if (!Md2 || typeof Md2.signSchnorrRaw !== 'function' || typeof Md2.verifySchnorrRawAsync !== 'function') {
      return { ok: false, code: 'SIGN_UNAVAILABLE', ROOT_K_PRESENT: false };
    }
    const text = 'SOS_LINKED_DEVICE_CAP_V1|' + String(auth.accountP || '').toLowerCase() + '|' + String(dev.deviceId || '').toLowerCase() + '|' + cap;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    const sig = await Md2.signSchnorrRaw(digest, dev.dSignSk);
    const good = await Md2.verifySchnorrRawAsync(sig, digest, dev.D_sign_pub);
    return {
      ok: good === true,
      code: good ? 'CAPABILITY_PROVED' : 'CAPABILITY_PROOF_FAIL',
      cap: cap,
      ROOT_K_PRESENT: false,
    };
  }

  async function openLinkedDesktopAccount() {
    const pk = String((_durableAuth && _durableAuth.accountP) || (_sessionDevice && _sessionDevice.accountP) || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pk)) return { ok: false, code: 'NO_ACCOUNT' };
    const welcome = document.getElementById('sosLdGuestWelcome');
    if (welcome) welcome.hidden = true;
    const panel = document.getElementById('sosLinkedPairPanel');
    if (panel) panel.hidden = true;
    try { window.__sosLdGuestWelcomeActive = false; } catch (_f) {}
    if (_pairTimer) {
      clearInterval(_pairTimer);
      _pairTimer = null;
    }
    const modal = document.getElementById('guestAuthModal');
    if (modal) {
      modal.style.display = 'none';
      modal.hidden = true;
    }
    App.privateKey = null;
    App.publicKey = pk;
    App.guestMode = false;
    App.linkedDeviceSession = true;
    App.identityState = 'LINKED_DEVICE';
    const fp = pk.slice(0, 8);
    const caps = Array.isArray(_durableAuth && _durableAuth.capabilities) ? _durableAuth.capabilities.map(String) : [];
    if (window.SosAccountSession && typeof window.SosAccountSession.adoptVerified === 'function') {
      window.SosAccountSession.adoptVerified({
        accountP: pk,
        deviceSignPub: _sessionDevice && _sessionDevice.D_sign_pub,
        deviceId: _sessionDevice && _sessionDevice.deviceId,
        caps: caps,
      });
    }
    const staleChip = document.getElementById('sosLdAccountChip');
    if (staleChip && staleChip.parentNode) staleChip.parentNode.removeChild(staleChip);
    const avatar = document.getElementById('topBarProfileAvatar');
    if (avatar && avatar.textContent && /^[0-9a-f]{8}$/i.test(avatar.textContent.trim())) avatar.textContent = '';
    try {
      if (typeof App.syncTopBarAuthUi === 'function') App.syncTopBarAuthUi();
    } catch (_ui) {}
    let cap = { ok: false, code: 'CAPABILITY_NOT_RUN', ROOT_K_PRESENT: false };
    try {
      cap = await proveGrantedCapability('DEVICE_CHAT');
    } catch (_cap) {
      cap = { ok: false, code: 'CAPABILITY_PROOF_FAIL', ROOT_K_PRESENT: false };
    }
    try {
      window.__sosLdAccountOpen = {
        accountFp: fp,
        guestMode: false,
        linkedDeviceSession: true,
        identityState: 'LINKED_DEVICE',
        ROOT_K_PRESENT: false,
        HISTORY_SYNC_TRANSFERRED: false,
        chip: false,
      };
      window.__sosLdCapability = {
        ok: cap.ok === true,
        code: String(cap.code || ''),
        cap: 'DEVICE_CHAT',
        ROOT_K_PRESENT: false,
      };
    } catch (_w) {}
    try {
      if (typeof App.ensureSecureChatEpochReady === 'function') {
        await Promise.resolve(App.ensureSecureChatEpochReady({ skipAutoReload: true })).catch(function () {});
      }
      if (typeof App.restoreChatState === 'function') {
        await Promise.resolve(App.restoreChatState()).catch(function () {});
      }
      if (typeof App.loadOwnProfileMetadata === 'function') {
        await Promise.resolve(App.loadOwnProfileMetadata()).catch(function () {});
      }
      if (typeof App.renderProfile === 'function') App.renderProfile();
    } catch (_meta) {}
    try {
      if (window.SosAccountSession && typeof window.SosAccountSession.resubscribeLinkedTransports === 'function') {
        await window.SosAccountSession.resubscribeLinkedTransports();
      }
    } catch (_sub) {}
    return { ok: true, ROOT_K_PRESENT: false };
  }

  function devicePrivHex(sk) {
    if (!sk || sk.length !== 32) return '';
    let out = '';
    for (let i = 0; i < sk.length; i++) out += sk[i].toString(16).padStart(2, '0');
    return out;
  }

  async function withLinkedDeviceSigner(fn) {
    if (!_sessionDevice || !_durableAuth || !_sessionDevice.dSignSk || typeof fn !== 'function') {
      return { ok: false, code: 'NO_DEVICE' };
    }
    const material = {
      privHex: devicePrivHex(_sessionDevice.dSignSk),
      pub: String(_sessionDevice.D_sign_pub || '').toLowerCase(),
      accountP: String((_durableAuth && _durableAuth.accountP) || '').toLowerCase(),
      deviceId: String(_sessionDevice.deviceId || '').toLowerCase(),
      authorization: _durableAuth,
    };
    if (!/^[0-9a-f]{64}$/.test(material.privHex) || !/^[0-9a-f]{64}$/.test(material.pub)) {
      return { ok: false, code: 'NO_DEVICE' };
    }
    return fn(material);
  }

  function presentDesktopSurface(root) {
    if (linkedDeviceReady()) {
      renderRestoredDesktop(root);
      return;
    }
    const Store = md4Store();
    if (!Store || typeof Store.loadLatest !== 'function') {
      startPairingIntoUi(root);
      return;
    }
    Promise.resolve(Store.loadLatest())
      .then(async function (loaded) {
        if (linkedDeviceReady()) {
          renderRestoredDesktop(root);
          return;
        }
        if (!loaded || loaded.ok !== true) {
          startPairingIntoUi(root);
          return;
        }
        const Auth = md4Auth();
        const verified = Auth && typeof Auth.verifyForDestination === 'function'
          ? await Auth.verifyForDestination(loaded.authorization, {
            accountP: loaded.accountP,
            deviceId: loaded.deviceId,
            D_sign_pub: loaded.D_sign_pub,
            D_enc_pub: loaded.D_enc_pub,
          }, Date.now(), { requireHistorySync: true })
          : { ok: false };
        if (!verified.ok) {
          if (linkedDeviceReady()) {
            renderRestoredDesktop(root);
            return;
          }
          startPairingIntoUi(root);
          return;
        }
        if (linkedDeviceReady()) {
          renderRestoredDesktop(root);
          return;
        }
        _sessionDevice = {
          scheme: SCHEME,
          deviceId: loaded.deviceId,
          D_sign_pub: loaded.D_sign_pub,
          D_enc_pub: loaded.D_enc_pub,
          storageClass: loaded.storageClass,
          recoveryEligible: false,
          RECOVERY_CAPABLE: false,
          hardwareBacked: false,
          deviceType: 'DESKTOP',
          label: 'דפדפן',
          accountP: loaded.accountP,
          dSignSk: loaded.dSignSk,
          dEncPriv: loaded.dEncPriv,
        };
        _durableAuth = loaded.authorization;
        renderRestoredDesktop(root);
      })
      .catch(function () {
        startPairingIntoUi(root);
      });
  }

  function continueAsGuest() {
    markGuestContinued();
    _guestAutoRefreshBusy = false;
    disposePairingSession();
    const welcome = document.getElementById('sosLdGuestWelcome');
    if (welcome) welcome.hidden = true;
    const panel = document.getElementById('sosLinkedPairPanel');
    if (panel) panel.hidden = true;
    try {
      window.__sosLdGuestWelcomeActive = false;
    } catch (_f) {}
    // Reveal feed / normal browsing without forcing auth modal.
    try {
      const modal = document.getElementById('guestAuthModal');
      if (modal) {
        modal.style.display = 'none';
        modal.hidden = true;
      }
    } catch (_m) {}
    try {
      if (typeof App.loadFeed === 'function') App.loadFeed();
      const home = document.getElementById('btnHome') || document.querySelector('[data-nav="home"]');
      if (home && typeof home.click === 'function') home.click();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (_feed) {}
    return { ok: true, path: 'CONTINUE_AS_GUEST', LINKED: false };
  }

  function accountHex() {
    return String(App.publicKey || '')
      .toLowerCase()
      .replace(/^0x/, '');
  }

  function rememberAuthorizedDevice(auth) {
    if (!auth || typeof auth !== 'object') return;
    const accountP = String(auth.accountP || accountHex()).toLowerCase();
    const deviceId = String(auth.deviceId || auth.D_sign_pub || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(accountP) || !/^[0-9a-f]{8,}$/.test(deviceId)) return;
    const reg = readRegistry().filter((d) => String(d.deviceId || '').toLowerCase() !== deviceId);
    reg.push({
      deviceId: deviceId,
      deviceSignPub: String(auth.D_sign_pub || auth.dSignPub || '').toLowerCase(),
      authorizationId: String(auth.authorizationId || '').toLowerCase(),
      deviceLabel: String(auth.deviceLabel || 'מחשב').slice(0, 32),
      accountP: accountP,
      createdAt: Number(auth.createdAt) || Date.now(),
      lastSeenAt: Date.now(),
      status: 'ACTIVE',
      source: 'PHONE_LINK',
    });
    writeRegistry(reg);
  }

  function localAccountDevices() {
    const me = accountHex();
    if (!/^[0-9a-f]{64}$/.test(me)) return [];
    return readRegistry()
      .filter((d) => String(d.accountP || '').toLowerCase() === me && String(d.status || 'ACTIVE') === 'ACTIVE')
      .map((d) => ({
        deviceId: String(d.deviceId || '').toLowerCase(),
        deviceSignPub: String(d.deviceSignPub || '').toLowerCase(),
        authorizationId: String(d.authorizationId || '').toLowerCase(),
        deviceLabel: d.deviceLabel || d.label || '',
        linkedAt: Number(d.createdAt || d.linkedAt) || 0,
        lastSeenAt: Number(d.lastSeenAt) || 0,
        source: d.source || '',
      }));
  }

  function deviceDisplayName(d) {
    const label = String((d && (d.deviceLabel || d.deviceName)) || '').trim();
    if (!label || label === 'דפדפן' || label === 'מכשיר') return 'מחשב';
    return label;
  }

  function formatLastActivity(ms) {
    const n = Number(ms);
    if (!n || !isFinite(n)) return '';
    const d = new Date(n < 1e12 ? n * 1000 : n);
    if (isNaN(d.getTime())) return '';
    const time = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayDiff = Math.round((startToday - startThat) / 86400000);
    if (dayDiff === 0) return 'פעילות אחרונה היום בשעה ' + time;
    if (dayDiff === 1) return 'פעילות אחרונה אתמול בשעה ' + time;
    const date = d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long' });
    return 'פעילות אחרונה ' + date + ', ' + time;
  }

  let _mobileListGen = 0;
  let _shownDevices = [];
  let _liveLinkedKey = '';
  const LIVE_DEVICE_WINDOW_MS = 30 * 60 * 1000;

  function deviceRowKey(d) {
    return String((d && (d.deviceSignPub || d.deviceId)) || '').toLowerCase();
  }

  function markLiveLinkedDevice(auth) {
    _liveLinkedKey = String((auth && (auth.D_sign_pub || auth.dSignPub || auth.deviceId)) || '').toLowerCase();
  }

  function seenMs(d) {
    const seen = Number(d && (d.lastSeenAt || d.linkedAt)) || 0;
    if (!seen || !isFinite(seen)) return 0;
    return seen < 1e12 ? seen * 1000 : seen;
  }

  function liveDeviceKey(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (_liveLinkedKey && list.some((d) => deviceRowKey(d) === _liveLinkedKey)) return _liveLinkedKey;
    let best = '';
    let bestMs = 0;
    list.forEach((d) => {
      const ms = seenMs(d);
      if (ms > bestMs) {
        bestMs = ms;
        best = deviceRowKey(d);
      }
    });
    if (!best || Date.now() - bestMs > LIVE_DEVICE_WINDOW_MS) return '';
    return best;
  }

  function knownPlatform(name) {
    return /^(Windows|Mac|Linux|Android|iPhone|ChromeOS)$/.test(String(name || ''));
  }

  function forgetLocalDevice(row) {
    const id = String((row && row.deviceId) || '').toLowerCase();
    const pub = String((row && row.deviceSignPub) || '').toLowerCase();
    writeRegistry(readRegistry().filter((d) => {
      const sameId = id && String(d.deviceId || '').toLowerCase() === id;
      const samePub = pub && String(d.deviceSignPub || '').toLowerCase() === pub;
      return !sameId && !samePub;
    }));
  }

  function showMobileList() {
    const detail = document.getElementById('sosLdDeviceDetail');
    const listWrap = document.getElementById('sosLdMobileListWrap');
    const title = document.getElementById('sosLdMobileTitle');
    if (detail) detail.hidden = true;
    if (listWrap) listWrap.hidden = false;
    if (title) title.textContent = 'מכשירים מקושרים';
  }

  function showDeviceDetail(row) {
    const detail = document.getElementById('sosLdDeviceDetail');
    const listWrap = document.getElementById('sosLdMobileListWrap');
    const title = document.getElementById('sosLdMobileTitle');
    if (!detail || !row) return;
    const name = deviceDisplayName(row);
    const activity = formatLastActivity(row.lastSeenAt || row.linkedAt) || 'אין עדיין זמן פעילות';
    const platform = knownPlatform(name) ? name : '';
    detail.innerHTML =
      '<div class="sos-ld-detail">' +
      '<div class="sos-ld-detail-ico"><i class="fa-solid fa-laptop"></i></div>' +
      '<h3>' + escapeHtml(name) + '</h3>' +
      '<p class="sos-ld-sub">שם המכשיר</p>' +
      '<div class="sos-ld-detail-row"><span>' + escapeHtml(activity) + '</span><i class="fa-solid fa-clock"></i></div>' +
      (platform ? '<div class="sos-ld-detail-row"><span>החיבור דרך ' + escapeHtml(platform) + '</span><i class="fa-solid fa-desktop"></i></div>' : '') +
      '<button type="button" class="sos-ld-disconnect" id="sosLdDisconnect">התנתקות</button>' +
      '<p class="sos-ld-footnote">הניתוק מפסיק את הגישה של המכשיר המקושר לחשבון.</p>' +
      '<p class="sos-ld-footnote" id="sosLdDisconnectStatus"></p>' +
      '</div>';
    detail.hidden = false;
    if (listWrap) listWrap.hidden = true;
    if (title) title.textContent = 'פרטי המכשיר';
    const button = detail.querySelector('#sosLdDisconnect');
    if (!button) return;
    button.onclick = async function () {
      if (button.getAttribute('data-confirm') !== '1') {
        button.setAttribute('data-confirm', '1');
        button.classList.add('is-confirm');
        button.textContent = 'אישור ניתוק';
        return;
      }
      button.disabled = true;
      const status = detail.querySelector('#sosLdDisconnectStatus');
      if (status) status.textContent = 'מנתקים את המכשיר…';
      const Session = App.SosAccountSession || window.SosAccountSession;
      let result = null;
      try {
        result = Session && typeof Session.revokeLinkedDevice === 'function' ? await Session.revokeLinkedDevice(row) : { ok: false, code: 'NO_SIGNER' };
      } catch (_e) {
        result = { ok: false, code: 'SIGN_FAILED' };
      }
      if (!result || result.ok !== true) {
        button.disabled = false;
        if (status) status.textContent = 'הניתוק לא הושלם. נסו שוב.';
        return;
      }
      forgetLocalDevice(row);
      if (deviceRowKey(row) === _liveLinkedKey) _liveLinkedKey = '';
      _shownDevices = _shownDevices.filter((item) => item.deviceSignPub !== row.deviceSignPub);
      showMobileList();
      paintMobileDeviceList(_shownDevices, 'ready');
    };
  }

  function paintMobileDeviceList(devices, state) {
    const list = document.getElementById('sosLdMobileDeviceList');
    const note = document.getElementById('sosLdMobileListNote');
    if (!list) return;
    const rows = Array.isArray(devices) ? devices : [];
    if (!rows.length && state === 'loading') {
      list.innerHTML = '<li class="sos-ld-empty">בודקים אילו מכשירים מחוברים…</li>';
    } else if (!rows.length && state === 'error') {
      list.innerHTML = '<li class="sos-ld-empty">לא הצלחנו לטעון את המכשירים המחוברים.</li>';
    } else if (!rows.length) {
      list.innerHTML = '<li class="sos-ld-empty">אין עדיין מכשירים מקושרים</li>';
    } else {
      list.innerHTML = '';
    }
    if (note) {
      note.textContent = rows.length
        ? 'כל שורה היא קישור שעדיין מורשה. לחצו על מכשיר כדי לראות מתי השתמש בו לאחרונה, או כדי לנתק אותו.'
        : '';
    }
    _shownDevices = rows.slice().sort(function (a, b) {
      return (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0);
    });
    const liveKey = liveDeviceKey(_shownDevices);
    if (rows.length) {
      list.innerHTML = _shownDevices
        .map((d, index) => {
          const activity = formatLastActivity(d.lastSeenAt || d.linkedAt);
          const name = deviceDisplayName(d);
          const live = deviceRowKey(d) === liveKey && !!liveKey;
          return (
            '<li><button type="button" class="sos-ld-device-row' + (live ? ' is-live' : '') + '" data-ld-device="' + index + '"' + (live ? ' aria-current="true"' : '') + '>' +
            '<div class="sos-ld-device-meta">' +
            '<strong>' + escapeHtml(name) + (live ? ' <em class="sos-ld-live">מחובר</em>' : '') + '</strong>' +
            (activity ? '<span>' + escapeHtml(activity) + '</span>' : '') +
            '</div>' +
            '<div class="sos-ld-device-ico"><i class="fa-solid fa-laptop"></i></div>' +
            '</button></li>'
          );
        })
        .join('');
    }
  }

  function mergeAccountDevices(localRows, remoteRows) {
    const byId = {};
    function put(d) {
      if (!d) return;
      const key = String(d.deviceSignPub || d.deviceId || '').toLowerCase();
      if (!key) return;
      const prev = byId[key];
      if (!prev || Number(d.lastSeenAt) >= Number(prev.lastSeenAt)) byId[key] = d;
    }
    (remoteRows || []).forEach(put);
    const freshAfter = Date.now() - 3 * 60 * 1000;
    (localRows || []).forEach((d) => {
      if (!d || d.source !== 'PHONE_LINK' || !(Number(d.linkedAt) > freshAfter)) return;
      const key = String(d.deviceSignPub || d.deviceId || '').toLowerCase();
      if (key && !byId[key]) byId[key] = d;
    });
    return Object.keys(byId).map((id) => byId[id]);
  }

  async function refreshMobileDeviceList() {
    const gen = ++_mobileListGen;
    const Session = App.SosAccountSession || window.SosAccountSession;
    const me = accountHex();
    if (!Session || typeof Session.listAccountLinkedDevices !== 'function' || !/^[0-9a-f]{64}$/.test(me)) {
      if (gen === _mobileListGen) {
        const local = localAccountDevices();
        paintMobileDeviceList(local, local.length ? 'ready' : 'error');
      }
      return;
    }
    let listed = null;
    try {
      listed = await Session.listAccountLinkedDevices(me);
    } catch (_e) {
      listed = null;
    }
    if (gen !== _mobileListGen) return;
    const local = localAccountDevices();
    if (!listed || listed.ok !== true) {
      paintMobileDeviceList(local, local.length ? 'ready' : 'error');
      return;
    }
    paintMobileDeviceList(mergeAccountDevices(local, listed.devices), 'ready');
  }

  function openMobileLinkedDevicesPage() {
    ensureLinkedDevicesStyles();
    let el = document.getElementById('sosLdMobilePage');
    if (el && el.getAttribute('data-sos-ld-account-list') !== '3' && typeof el.remove === 'function') {
      el.remove();
      el = null;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'sosLdMobilePage';
      el.setAttribute('data-sos-ld-account-list', '3');
      el.innerHTML =
        '<div class="sos-ld-shell sos-ld-mobile-page" role="dialog" aria-modal="true" dir="rtl">' +
        '<div class="sos-ld-mobile-head">' +
        '<button type="button" data-ld-mobile-back aria-label="חזרה">›</button>' +
        '<h2 id="sosLdMobileTitle">מכשירים מקושרים</h2>' +
        '</div>' +
        '<div class="sos-ld-mobile-body">' +
        '<div id="sosLdMobileListWrap">' +
        '<div class="sos-ld-hero" aria-hidden="true">' +
        '<svg viewBox="0 0 300 150">' +
        '<defs>' +
        '<linearGradient id="sosLdPhoneBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a3d62"/><stop offset="1" stop-color="#0c1c30"/></linearGradient>' +
        '<linearGradient id="sosLdPhoneGlass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e7f6ff"/><stop offset="1" stop-color="#8ec4ef"/></linearGradient>' +
        '<linearGradient id="sosLdBezel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#314256"/><stop offset="1" stop-color="#121a24"/></linearGradient>' +
        '<linearGradient id="sosLdScreen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f7dff"/><stop offset="0.55" stop-color="#123a66"/><stop offset="1" stop-color="#14998f"/></linearGradient>' +
        '<linearGradient id="sosLdBase" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#46586e"/><stop offset="1" stop-color="#1a2431"/></linearGradient>' +
        '</defs>' +
        '<g class="sos-ld-phone">' +
        '<rect x="18" y="16" width="68" height="114" rx="16" fill="url(#sosLdPhoneBody)" stroke="#8fd0ff" stroke-width="2.4"/>' +
        '<rect x="27" y="28" width="50" height="80" rx="7" fill="url(#sosLdPhoneGlass)"/>' +
        '<rect x="34" y="38" width="36" height="16" rx="3" fill="#16487a" opacity=".5"/>' +
        '<rect x="34" y="60" width="36" height="5" rx="2" fill="#16487a" opacity=".32"/>' +
        '<rect x="34" y="70" width="24" height="5" rx="2" fill="#16487a" opacity=".22"/>' +
        '<circle cx="52" cy="116" r="3.2" fill="#b7e4ff"/>' +
        '</g>' +
        '<g class="sos-ld-link">' +
        '<circle class="sos-ld-dot" cx="112" cy="74" r="4.6" fill="#9fd4ff"/>' +
        '<circle class="sos-ld-dot sos-ld-dot-2" cx="130" cy="74" r="4.6" fill="#5aa8ff"/>' +
        '<circle class="sos-ld-dot sos-ld-dot-3" cx="148" cy="74" r="4.6" fill="#3d7dff"/>' +
        '<circle class="sos-ld-dot sos-ld-dot-4" cx="166" cy="74" r="4.6" fill="#2dd4bf"/>' +
        '</g>' +
        '<g class="sos-ld-laptop">' +
        '<rect x="186" y="22" width="96" height="68" rx="8" fill="url(#sosLdBezel)" stroke="#b7e4ff" stroke-width="1.6"/>' +
        '<rect class="sos-ld-screen" x="194" y="30" width="80" height="48" rx="4" fill="url(#sosLdScreen)"/>' +
        '<rect x="202" y="38" width="28" height="5" rx="2" fill="#f4fbff" opacity=".92"/>' +
        '<rect x="202" y="48" width="62" height="3.5" rx="1.5" fill="#e7f6ff" opacity=".42"/>' +
        '<rect x="202" y="56" width="44" height="3.5" rx="1.5" fill="#e7f6ff" opacity=".26"/>' +
        '<rect x="180" y="90" width="108" height="4" rx="1" fill="#0c141e"/>' +
        '<path d="M168 94 H292 L280 110 H180 Z" fill="url(#sosLdBase)"/>' +
        '<rect x="214" y="99" width="24" height="3" rx="1.2" fill="#d5e8f8" opacity=".6"/>' +
        '</g>' +
        '</svg></div>' +
        '<p class="sos-ld-explain">אפשר לקשר מחשב לחשבון SOS הזה. סרקו את הקוד שמופיע במחשב.</p>' +
        '<div id="sosLdMobileLinkStatus" class="sos-ld-link-status" role="status" hidden></div>' +
        '<button type="button" class="button-primary" id="sosLdMobileScan" style="width:100%;min-height:48px;margin-top:10px;">קישור מכשיר</button>' +
        '<h3 style="margin:22px 0 0;font-size:1rem;">מכשירים מקושרים</h3>' +
        '<ul class="sos-ld-device-list" id="sosLdMobileDeviceList"></ul>' +
        '<p class="sos-ld-footnote" id="sosLdMobileListNote"></p>' +
        '</div>' +
        '<div id="sosLdDeviceDetail" hidden></div>' +
        '</div></div>';
      document.body.appendChild(el);
      el.querySelector('[data-ld-mobile-back]').onclick = () => {
        const detail = document.getElementById('sosLdDeviceDetail');
        if (detail && !detail.hidden) {
          showMobileList();
          return;
        }
        el.hidden = true;
      };
      el.querySelector('#sosLdMobileScan').onclick = () => {
        openMobilePrimaryLinkAction();
      };
      el.addEventListener('click', (ev) => {
        const target = ev.target;
        const btn = target && target.closest ? target.closest('[data-ld-device]') : null;
        if (!btn) return;
        const row = _shownDevices[Number(btn.getAttribute('data-ld-device'))];
        if (row) showDeviceDetail(row);
      });
    }
    const local = localAccountDevices();
    paintMobileDeviceList(local, local.length ? 'ready' : 'loading');
    refreshMobileDeviceList();
    const statusBox = document.getElementById('sosLdMobileLinkStatus');
    if (statusBox && statusBox.classList.contains('is-ok')) {
      statusBox.hidden = true;
      statusBox.textContent = '';
      statusBox.classList.remove('is-ok');
    }
    el.hidden = false;
    return { ok: true, path: 'MOBILE_LINKED_DEVICES_PAGE', DEVICE_LIST_SOURCE: DEVICE_LIST_SCOPE };
  }

  function openLinkedDevicesSettings() {
    const cls = classifyLinkedDevicesSurface();
    if (cls.role === 'MOBILE_PRIMARY' || cls.nativeShell) {
      return openMobileLinkedDevicesPage();
    }
    if (cls.role === 'DESKTOP_DESTINATION') {
      return openDesktopPairingPanel();
    }
    // Ambiguous: chooser stays available
    openRoleChooserPanel();
    return { ok: true, path: 'ROLE_CHOOSER' };
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Sole product owner for primary Linked Devices actions.
   * Replaces the node to drop any legacy MD2 addEventListener handlers.
   */
  function ensureLinkedDevicesMenuIcon(btn) {
    if (!btn) return;
    let ico = btn.querySelector('i');
    if (!ico) {
      ico = document.createElement('i');
      ico.setAttribute('aria-hidden', 'true');
      btn.insertBefore(ico, btn.firstChild);
    }
    // fa-laptop-mobile is missing in some FA kits used by SOS — use desktop (always present).
    ico.className = 'fa-solid fa-desktop';
  }

  function claimPrimaryLinkControl(el) {
    if (!el || !el.parentNode) return null;
    if (el.getAttribute('data-sos-ld-owner') === '1' && el.__sosLdPrimaryBound) {
      ensureLinkedDevicesMenuIcon(el);
      return el;
    }
    const clean = el.cloneNode(true);
    clean.setAttribute('data-sos-ld-owner', '1');
    clean.onclick = null;
    el.parentNode.replaceChild(clean, el);
    ensureLinkedDevicesMenuIcon(clean);
    const onPrimary = function (e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const menu = document.getElementById('topBarProfileMenu');
      if (menu) menu.hidden = true;
      openLinkedDevicesPrimaryAction();
    };
    clean.addEventListener('click', onPrimary);
    clean.__sosLdPrimaryBound = true;
    return clean;
  }

  function wireUi() {
    // Hide any stale legacy MD2 product panel if present in DOM.
    try {
      const legacy = document.getElementById('sosMd2PairingPanel');
      if (legacy) {
        legacy.hidden = true;
        legacy.setAttribute('data-sos-legacy-disabled', '1');
      }
    } catch (_leg) {}

    // Soft-guard: do not let auth modal auto-cover Guest QR-first welcome (invite deep links still win).
    try {
      if (typeof App.openAuthPrompt === 'function' && !App.openAuthPrompt.__sosLdWrapped) {
        const origPrompt = App.openAuthPrompt;
        App.openAuthPrompt = function (message, options) {
          const opts = options || {};
          if (
            window.__sosLdGuestWelcomeActive &&
            !opts.fromInviteLink &&
            !hasInviteDeepLink()
          ) {
            return;
          }
          return origPrompt.apply(this, arguments);
        };
        App.openAuthPrompt.__sosLdWrapped = true;
      }
    } catch (_wrap) {}

    function syncPrimaryLinkLabels() {
      const cls = classifyLinkedDevicesSurface();
      const mobileLabel = 'מכשירים מקושרים';
      const desktopLabel = 'קישור מחשב לטלפון';
      const ambiguousLabel = 'קישור מכשיר חדש';
      const label =
        cls.role === 'MOBILE_PRIMARY'
          ? mobileLabel
          : cls.role === 'DESKTOP_DESTINATION'
            ? desktopLabel
            : ambiguousLabel;
      ['btnLoginLinkPhone', 'btnStartLinkPhone', 'topBarMd2Pairing'].forEach(function (id) {
        const b = document.getElementById(id);
        if (!b) return;
        const span = b.querySelector && b.querySelector('span');
        if (span) span.textContent = label;
        else if (id !== 'topBarMd2Pairing' || !b.querySelector('i')) b.textContent = label;
      });
      const ldMenu = document.getElementById('topBarLinkedDevices');
      if (ldMenu) {
        ensureLinkedDevicesMenuIcon(ldMenu);
        const span = ldMenu.querySelector('span');
        if (span) span.textContent = cls.role === 'DESKTOP_DESTINATION' ? 'קישור מחשב לטלפון' : 'מכשירים מקושרים';
      }
    }

    function ensureLoginPrimary(id, mount) {
      if (!mount) return;
      let btn = document.getElementById(id);
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.id = id;
        btn.className = 'button-secondary';
        if (id === 'btnLoginLinkPhone') btn.style.cssText = 'width:100%;margin-top:10px;';
        btn.textContent = 'קישור מכשיר חדש';
        if (typeof mount === 'function') mount(btn);
        else mount.appendChild(btn);
      }
      claimPrimaryLinkControl(document.getElementById(id));
    }

    ensureLoginPrimary('btnLoginLinkPhone', function (btn) {
      const loginStep = document.getElementById('authStepLogin');
      if (!loginStep) return;
      const actions = loginStep.querySelector('.guest-auth-login-actions');
      if (actions && actions.parentNode) actions.parentNode.insertBefore(btn, actions.nextSibling);
      else loginStep.appendChild(btn);
    });
    ensureLoginPrimary('btnStartLinkPhone', function (btn) {
      const initial = document.getElementById('authStepInitial');
      const wrap =
        initial && typeof initial.querySelector === 'function'
          ? initial.querySelector('.guest-auth-actions')
          : null;
      if (wrap) wrap.appendChild(btn);
    });

    // Profile menu — one authoritative Linked Devices entry (platform label).
    const menu = document.getElementById('topBarProfileMenu');
    if (menu) {
      let ldBtn = document.getElementById('topBarLinkedDevices');
      if (!ldBtn) {
        ldBtn = document.createElement('button');
        ldBtn.type = 'button';
        ldBtn.id = 'topBarLinkedDevices';
        ldBtn.className = 'top-bar__dropdown-item';
        ldBtn.innerHTML =
          '<i class="fa-solid fa-desktop" aria-hidden="true"></i><span>מכשירים מקושרים</span>';
        const invite = document.getElementById('topBarInviteFriend');
        if (invite && invite.parentNode) invite.parentNode.insertBefore(ldBtn, invite.nextSibling);
        else {
          const before = document.getElementById('pwa-install-menu-btn') || document.getElementById('topBarP2pStats');
          if (before && before.parentNode) before.parentNode.insertBefore(ldBtn, before);
          else menu.appendChild(ldBtn);
        }
      }
      ensureLinkedDevicesMenuIcon(ldBtn);
      claimPrimaryLinkControl(document.getElementById('topBarLinkedDevices'));
      ensureLinkedDevicesMenuIcon(document.getElementById('topBarLinkedDevices'));

      // Hide legacy MD2 menu item — do not keep a second overlapping owner.
      const legacyMd2 = document.getElementById('topBarMd2Pairing');
      if (legacyMd2) {
        legacyMd2.hidden = true;
        legacyMd2.setAttribute('data-sos-legacy-disabled', '1');
        legacyMd2.setAttribute('aria-hidden', 'true');
        try {
          legacyMd2.onclick = null;
        } catch (_o) {}
      }
    }

    syncPrimaryLinkLabels();
    try {
      if (typeof window.matchMedia === 'function') {
        const mq = window.matchMedia('(pointer: coarse)');
        const onChange = function () {
          syncPrimaryLinkLabels();
        };
        if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
        else if (mq && typeof mq.addListener === 'function') mq.addListener(onChange);
      }
    } catch (_mq) {}

    maybeShowGuestQrWelcome();
  }

  const api = Object.freeze({
    PROTOCOL_VERSION,
    AUTH_VERSION,
    SCHEME,
    MAX_LINKED,
    PAIRING_REQUIRES_PHONE_NUMBER_BINDING: false,
    LINKED_DEVICE_ACCOUNT_GLOBAL: true,
    ROOT_K_SENT_TO_DESKTOP: false,
    NSEC_SENT_TO_DESKTOP: false,
    FAKE_HISTORY_SYNC: false,
    FAKE_LIVE_SYNC: false,
    FULL_FEATURE_PARITY_CLAIMED: false,
    DEVICE_REVOKE_PRODUCT_READY: true,
    WEB_MD3_ISSUANCE: false,
    RECOVERY_CAPABLE: false,
    MD4_S1_DURABLE_STORE: true,
    ensureWebDeviceIdentity,
    startDesktopPairingSession,
    refreshPairingQr,
    getPairingState,
    getCurrentPairingQrText,
    withLinkedDeviceSigner,
    beginPrimaryApproval,
    acceptAuthorizationObject,
    restoreDurableSession,
    clearDurableForAccount,
    getDurableAuthorization,
    assertHistorySyncReady,
    listLinkedDevices,
    openDesktopPairingPanel,
    openLinkedDevicesSettings,
    beginPrimaryCameraScan,
    classifyLinkedDevicesSurface,
    openLinkedDevicesPrimaryAction,
    openMobilePrimaryLinkAction,
    showGuestQrWelcome,
    continueAsGuest,
    openMobileLinkedDevicesPage,
    maybeShowGuestQrWelcome,
    disposePairingSession,
    wireUi,
  });

  if (!window.__sosLdStatusBound) {
    window.__sosLdStatusBound = true;
    window.addEventListener('sos-ld-link-status', function (ev) {
      showPersistentLinkStatus((ev && ev.detail) || {});
    });
    window.addEventListener('sos-ld-device-revoked', function () {
      const account = _sessionDevice && _sessionDevice.accountP;
      _sessionDevice = null;
      _durableAuth = null;
      if (account) {
        clearDurableForAccount(account).catch(function () {});
      }
      try {
        const banner = document.createElement('div');
        banner.className = 'sos-ld-link-status';
        banner.textContent = 'הטלפון ניתק את המחשב הזה מהחשבון.';
        banner.style.cssText = 'position:fixed;left:16px;right:16px;bottom:24px;z-index:12060';
        document.body.appendChild(banner);
      } catch (_b) {}
      try { continueAsGuest(); } catch (_g) {}
    });
  }

  App.WebLinkedDevices = api;
  window.SosWebLinkedDevices = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireUi);
  } else {
    wireUi();
  }
})(window);
