/**
 * Web Linked Devices product wiring (MD1 browser NORMAL_LINKED_DEVICE + MD2 QR + MD3 verify/registry).
 * MD4 S1: durable device keys + DeviceAuthorization via SosMd4DeviceStore + verifyStrict (SosMd4DeviceAuth).
 * ROOT K / nsec never appear in QR, URL, logs, or this module's storage.
 * MD3 issuance (sign under K) remains Android PhoneIssuer — no WebView authorize API.
 * FAKE_HISTORY_SYNC=false; DEVICE_REVOKE_PRODUCT_READY=false (MD6 not implemented).
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
  const MAX_LINKED = 4;
  const GUEST_CONTINUE_KEY = 'sos_ld_guest_continued_v1';
  const DEVICE_LIST_SCOPE = 'LOCAL_BROWSER_REGISTRY'; // not account-wide until MD6 sync

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
      .waitLinked(PAIR_TTL_MS + 5000)
      .then(async (auth) => {
        if (!_pairing) return;
        const secrets = typeof session.exportDeviceSecrets === 'function' ? session.exportDeviceSecrets() : null;
        const accepted = await acceptAuthorizationObject(auth, {
          session,
          secrets,
        });
        if (accepted && accepted.ok) {
          _pairing.state = 'APPROVED';
          renderPairingUi();
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
      '.sos-ld-mobile-body{padding:16px;overflow:auto;flex:1}' +
      '.sos-ld-device-list{list-style:none;margin:16px 0 0;padding:0}' +
      '.sos-ld-device-list li{display:flex;gap:12px;align-items:flex-start;padding:14px 0;border-bottom:1px solid rgba(255,255,255,.08)}' +
      '.sos-ld-device-ico{width:40px;height:40px;border-radius:10px;background:rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center}' +
      '.sos-ld-device-meta{flex:1;min-width:0}' +
      '.sos-ld-device-meta strong{display:block;font-size:15px}' +
      '.sos-ld-device-meta span{display:block;font-size:12px;opacity:.75;margin-top:3px}' +
      '.sos-ld-empty{opacity:.8;font-size:14px;margin-top:18px}' +
      '.sos-ld-footnote{font-size:12px;opacity:.7;margin-top:14px;line-height:1.45}';
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
      return {
        ok: false,
        code: (scanned && scanned.code) || 'SCAN_CANCELLED',
        DECODE_IS_NOT_AUTHORIZATION: true,
      };
    }
    // Reuse product approval path (Web T2 PhoneIssuer when flagged; else Android/native messaging).
    const approved = await beginPrimaryApproval(scanned.qrText);
    const result = Object.assign(
      { DECODE_IS_NOT_AUTHORIZATION: true, W2_SOSPAIR1_SCAN: true },
      approved || { ok: false, code: 'APPROVAL_PATH_FAIL' },
    );
    // Production truth: optical decode ≠ authorization. Web MD3 issuance remains OFF.
    try {
      if (result.code === 'NOT_AUTHENTICATED') {
        window.alert('הקוד זוהה. יש להתחבר לחשבון SOS כדי להמשיך לאישור הקישור.');
      } else if (result.ok && result.payload && result.WEB_MD3_ISSUANCE !== true && !result.nativeStarted) {
        const label = String((result.payload && (result.payload.deviceLabel || result.payload.label)) || 'מחשב').slice(0, 48);
        const did = String((result.payload && result.payload.deviceId) || '').slice(0, 12);
        const reason = String(result.code || result.MD3_ISSUANCE_PATH || 'WEB_T2_UNAVAILABLE');
        window.alert(
          'מחשב זוהה' +
            (label ? ': ' + label : '') +
            (did ? ' (' + did + '…)' : '') +
            '.\n\nהסריקה בלבד אינה מאשרת קישור.\n' +
            'אישור מאובטח בדפדפן (Trusted Signer / T2) אינו פעיל כרגע בסביבה זו (' +
            reason +
            ').\n' +
            'ניתן לאשר דרך אפליקציית SOS ל-Android כשזמינה, או לאחר הפעלת T2 מאושרת.',
        );
      }
    } catch (_ui) {}
    return result;
  }

  /** Primary-side: parse QR and show approval UI. Signing requires Android native issuer or Web T2. */
  async function beginPrimaryApproval(qrText) {
    const Md2 = App.Md2PairingQr;
    const parsed = Md2.parseQr(qrText);
    if (!parsed.ok) return { ok: false, code: parsed.error || 'BAD_QR' };
    const me = String(App.publicKey || '').toLowerCase();
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

    const secrets = (ctx && ctx.secrets && ctx.secrets.ok && ctx.secrets) || null;
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
          APPROVED: 'המכשיר אושר בהצלחה',
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
      if (exp) {
        exp.textContent =
          _pairing.state === 'EXPIRED'
            ? 'הקוד אינו תקף עוד'
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
    startPairingIntoUi(el);
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
        '<p class="sos-ld-footnote">הקוד מתחדש אוטומטית כשפג תוקפו. אפשר לדפדף כאורח בלי קישור — קישור מאובטח דורש אישור בטלפון ואינו מתבצע מסריקה בלבד.</p>' +
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
    startPairingIntoUi(el);
    return { ok: true, path: 'GUEST_FIRST_ENTRY_QR' };
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

  function openMobileLinkedDevicesPage() {
    ensureLinkedDevicesStyles();
    let el = document.getElementById('sosLdMobilePage');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sosLdMobilePage';
      el.innerHTML =
        '<div class="sos-ld-shell sos-ld-mobile-page" role="dialog" aria-modal="true" dir="rtl">' +
        '<div class="sos-ld-mobile-head">' +
        '<button type="button" data-ld-mobile-back aria-label="חזרה">›</button>' +
        '<h2>מכשירים מקושרים</h2>' +
        '</div>' +
        '<div class="sos-ld-mobile-body">' +
        '<p class="sos-ld-sub">חברו את המחשב לחשבון SOS שלכם באמצעות סריקת קוד QR.</p>' +
        '<button type="button" class="button-primary" id="sosLdMobileScan" style="width:100%;min-height:48px;margin-top:14px;">קישור מכשיר</button>' +
        '<h3 style="margin:22px 0 0;font-size:1rem;">מכשירים מקושרים</h3>' +
        '<ul class="sos-ld-device-list" id="sosLdMobileDeviceList"></ul>' +
        '<p class="sos-ld-footnote">הרשימה מציגה רשומות מקומיות במכשיר זה בלבד. הסרה מרחוק של מכשיר חשבון עדיין אינה זמינה.</p>' +
        '</div></div>';
      document.body.appendChild(el);
      el.querySelector('[data-ld-mobile-back]').onclick = () => {
        el.hidden = true;
      };
      el.querySelector('#sosLdMobileScan').onclick = () => {
        openMobilePrimaryLinkAction();
      };
    }
    const list = el.querySelector('#sosLdMobileDeviceList');
    const devices = listLinkedDevices();
    if (list) {
      list.innerHTML = devices.length
        ? devices
            .map((d) => {
              const when = d.linkedAt ? new Date(d.linkedAt).toLocaleString('he-IL') : '';
              return (
                '<li>' +
                '<div class="sos-ld-device-ico"><i class="fa-solid fa-laptop"></i></div>' +
                '<div class="sos-ld-device-meta">' +
                '<strong>' +
                escapeHtml(d.deviceName) +
                (d.isCurrent ? ' · מכשיר נוכחי' : '') +
                '</strong>' +
                '<span>מצב: ' +
                escapeHtml(d.authorizationState || 'ACTIVE') +
                '</span>' +
                (when ? '<span>קושר: ' + escapeHtml(when) + '</span>' : '') +
                '<span>מקור: רשומה מקומית במכשיר זה</span>' +
                '</div></li>'
              );
            })
            .join('')
        : '<li class="sos-ld-empty">אין עדיין מכשירים מקושרים</li>';
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
    DEVICE_REVOKE_PRODUCT_READY: false,
    WEB_MD3_ISSUANCE: false,
    RECOVERY_CAPABLE: false,
    MD4_S1_DURABLE_STORE: true,
    ensureWebDeviceIdentity,
    startDesktopPairingSession,
    refreshPairingQr,
    getPairingState,
    getCurrentPairingQrText,
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

  App.WebLinkedDevices = api;
  window.SosWebLinkedDevices = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireUi);
  } else {
    wireUi();
  }
})(window);
