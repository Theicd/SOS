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
      if (Date.now() > _pairing.expiresAt) {
        _pairing.state = 'EXPIRED';
        try {
          _pairing._session && _pairing._session.stop();
        } catch (_e) {}
        renderPairingUi();
        clearInterval(_pairTimer);
        _pairTimer = null;
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

  /** Product entry: platform-aware primary Linked Devices action. */
  function openLinkedDevicesPrimaryAction(opts) {
    const cls = classifyLinkedDevicesSurface(opts);
    if (cls.role === 'MOBILE_PRIMARY') return openMobilePrimaryLinkAction();
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
    return Object.assign(
      { DECODE_IS_NOT_AUTHORIZATION: true, W2_SOSPAIR1_SCAN: true },
      approved || { ok: false, code: 'APPROVAL_PATH_FAIL' },
    );
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
      MD3_ISSUANCE_PATH: nativeAuthorize ? 'ANDROID_NATIVE' : 'REQUIRES_SOS_ANDROID_APP',
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

  function renderPairingUi() {
    const panel = document.getElementById('sosLinkedPairPanel');
    if (!panel || !_pairing) return;
    const st = document.getElementById('sosLinkedPairStatus');
    const canvas = document.getElementById('sosLinkedPairCanvas');
    const exp = document.getElementById('sosLinkedPairExpiry');
    if (st) {
      const map = {
        WAITING: 'ממתין לסריקה בטלפון…',
        EXPIRED: 'פג תוקף הקוד — לחצו ליצירת קוד חדש',
        APPROVAL_PENDING: 'ממתין לאישור בטלפון…',
        APPROVED: 'המכשיר אושר בהצלחה',
        REJECTED: 'הקישור נדחה',
        FAILURE: 'הקישור נכשל — נסו שוב',
      };
      st.textContent = map[_pairing.state] || _pairing.state;
    }
    if (exp) {
      exp.textContent =
        _pairing.state === 'EXPIRED'
          ? 'הקוד אינו תקף עוד'
          : 'תוקף הקוד: ' + formatPairExpiry(_pairing.expiresAt);
    }
    const Md2 = App.Md2PairingQr;
    if (canvas && Md2 && _pairing.qrText && _pairing.state !== 'EXPIRED') {
      Promise.resolve(Md2.renderPairingQrToCanvas(canvas, _pairing.qrText)).catch(() => {});
    }
  }

  function openDesktopPairingPanel() {
    const Md2 = App.Md2PairingQr || window.SosMd2PairingQr;
    const Session = App.Md2PairingSession || window.SosMd2PairingSession;
    if (!Md2 || typeof Md2.renderPairingQrToCanvas !== 'function' || !Session) {
      try {
        window.alert('מודול קישור המכשירים אינו זמין כעת. רעננו את העמוד ונסו שוב.');
      } catch (_a) {}
      return { ok: false, code: 'LINKED_DEVICES_MODULE_MISSING' };
    }
    let el = document.getElementById('sosLinkedPairPanel');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sosLinkedPairPanel';
      el.innerHTML =
        '<div class="sos-ld-backdrop" data-ld-close></div>' +
        '<div class="sos-ld-panel" role="dialog" aria-modal="true" aria-labelledby="sosLdTitle" dir="rtl">' +
        '<header><h2 id="sosLdTitle">קישור מחשב באמצעות הטלפון</h2>' +
        '<button type="button" data-ld-close aria-label="סגור">×</button></header>' +
        '<p class="sos-ld-lead">פתחו SOS בטלפון המורשה וסרקו את הקוד. הסריקה אינה מאשרת קישור — יידרש אישור מאובטח בטלפון.</p>' +
        '<canvas id="sosLinkedPairCanvas" width="240" height="240" aria-label="קוד QR לקישור"></canvas>' +
        '<p id="sosLinkedPairStatus" class="sos-ld-status"></p>' +
        '<p id="sosLinkedPairExpiry" class="sos-ld-expiry"></p>' +
        '<div class="sos-ld-actions">' +
        '<button type="button" class="button-primary" id="sosLdRefreshQr">קוד חדש</button>' +
        '<button type="button" class="button-secondary" data-ld-close>סגור</button>' +
        '</div>' +
        '</div>';
      const style = document.createElement('style');
      style.textContent =
        '#sosLinkedPairPanel{position:fixed;inset:0;z-index:12020;display:flex;align-items:center;justify-content:center}' +
        '#sosLinkedPairPanel[hidden]{display:none!important}' +
        '.sos-ld-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.55)}' +
        '.sos-ld-panel{position:relative;background:var(--sos-surface,#161616);color:var(--sos-text,#f5f5f5);border-radius:16px;padding:20px;max-width:400px;width:92%;box-shadow:0 12px 40px rgba(0,0,0,.45)}' +
        '.sos-ld-panel header{display:flex;justify-content:space-between;align-items:center;gap:8px}' +
        '.sos-ld-panel header h2{margin:0;font-size:1.15rem;font-weight:600}' +
        '.sos-ld-lead{margin:12px 0 8px;font-size:14px;line-height:1.45;opacity:.92}' +
        '#sosLinkedPairCanvas{display:block;margin:14px auto;background:#fff;border-radius:12px}' +
        '.sos-ld-status{min-height:1.4em;margin:10px 0 4px;font-size:14px;text-align:center}' +
        '.sos-ld-expiry{margin:0 0 12px;font-size:13px;opacity:.8;text-align:center}' +
        '.sos-ld-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}';
      document.head.appendChild(style);
      document.body.appendChild(el);
      el.addEventListener('click', (e) => {
        if (e.target && e.target.hasAttribute('data-ld-close')) el.hidden = true;
      });
      document.getElementById('sosLdRefreshQr').onclick = () => {
        Promise.resolve(refreshPairingQr()).then(renderPairingUi).catch((err) => {
          const st = document.getElementById('sosLinkedPairStatus');
          if (st) st.textContent = String((err && err.message) || err || 'שגיאה');
        });
      };
    }
    el.hidden = false;
    Promise.resolve(startDesktopPairingSession())
      .then(renderPairingUi)
      .catch((err) => {
        const st = document.getElementById('sosLinkedPairStatus');
        if (st) st.textContent = String((err && err.message) || err || 'שגיאה ביצירת קישור');
      });
    return { ok: true, path: 'DESKTOP_DISPLAY_QR' };
  }

  function openLinkedDevicesSettings() {
    let el = document.getElementById('sosLinkedDevicesPanel');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sosLinkedDevicesPanel';
      el.innerHTML = `
        <div class="sos-ld-backdrop" data-ld-dev-close></div>
        <div class="sos-ld-panel" role="dialog" aria-modal="true">
          <header><h2>מכשירים מקושרים</h2>
            <button type="button" data-ld-dev-close aria-label="סגור">×</button></header>
          <ul id="sosLinkedDevicesList" style="list-style:none;padding:0;margin:12px 0;"></ul>
          <button type="button" class="button-primary" id="sosLdScanQr" style="width:100%;margin-bottom:8px;">סריקת QR לקישור מחשב</button>
          <button type="button" class="button-secondary" id="sosLdLinkNew" style="width:100%;">קישור מחשב באמצעות הטלפון</button>
          <p style="font-size:12px;opacity:.75;margin-top:10px;">בטלפון: סריקה במצלמה. במחשב: הצגת קוד QR. סריקה אינה מאשרת קישור — יידרש אישור מאובטח נפרד.</p>
        </div>`;
      document.body.appendChild(el);
      el.addEventListener('click', (e) => {
        if (e.target && e.target.hasAttribute('data-ld-dev-close')) el.hidden = true;
      });
      document.getElementById('sosLdLinkNew').onclick = () => {
        el.hidden = true;
        openDesktopPairingPanel();
      };
      document.getElementById('sosLdScanQr').onclick = () => {
        el.hidden = true;
        openMobilePrimaryLinkAction();
      };
    }
    const cls = classifyLinkedDevicesSurface();
    const scanBtn = document.getElementById('sosLdScanQr');
    const showBtn = document.getElementById('sosLdLinkNew');
    if (scanBtn && showBtn) {
      // Visual primary follows surface class; both actions remain available (no crypto bypass).
      if (cls.role === 'DESKTOP_DESTINATION') {
        showBtn.className = 'button-primary';
        scanBtn.className = 'button-secondary';
      } else {
        scanBtn.className = 'button-primary';
        showBtn.className = 'button-secondary';
      }
    }
    const list = document.getElementById('sosLinkedDevicesList');
    const devices = listLinkedDevices();
    list.innerHTML = devices.length
      ? devices
          .map(
            (d) =>
              `<li style="padding:10px 0;border-bottom:1px solid #333;">
                <strong>${escapeHtml(d.deviceName)}</strong>
                ${d.isCurrent ? ' <span>(מכשיר נוכחי)</span>' : ''}
                <div style="font-size:12px;opacity:.8;">מזהה: ${escapeHtml(String(d.deviceId).slice(0, 12))}…</div>
                <div style="font-size:12px;opacity:.8;">מצב: ${escapeHtml(d.authorizationState)}</div>
                <div style="font-size:12px;opacity:.8;">קושר: ${d.linkedAt ? new Date(d.linkedAt).toLocaleString('he-IL') : '—'}</div>
              </li>`,
          )
          .join('')
      : '<li style="opacity:.8;">אין מכשירים מורשים עדיין.</li>';
    el.hidden = false;
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
  function claimPrimaryLinkControl(el) {
    if (!el || !el.parentNode) return null;
    if (el.getAttribute('data-sos-ld-owner') === '1' && el.__sosLdPrimaryBound) return el;
    const clean = el.cloneNode(true);
    clean.setAttribute('data-sos-ld-owner', '1');
    clean.onclick = null;
    el.parentNode.replaceChild(clean, el);
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

    function syncPrimaryLinkLabels() {
      const cls = classifyLinkedDevicesSurface();
      const mobileLabel = 'סריקת QR לקישור מחשב';
      const desktopLabel = 'קישור מחשב באמצעות הטלפון';
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

    // Settings → מכשירים מקושרים
    const menu = document.getElementById('topBarProfileMenu');
    if (menu && !document.getElementById('topBarLinkedDevices')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'topBarLinkedDevices';
      btn.className = 'top-bar__dropdown-item';
      btn.innerHTML = '<i class="fa-solid fa-laptop-mobile"></i><span>מכשירים מקושרים</span>';
      btn.addEventListener('click', () => {
        menu.hidden = true;
        openLinkedDevicesSettings();
      });
      const invite = document.getElementById('topBarInviteFriend');
      if (invite && invite.parentNode) invite.parentNode.insertBefore(btn, invite.nextSibling);
      else menu.appendChild(btn);
    }

    // Primary product action — sole owner (create if missing; strip legacy listeners).
    if (menu) {
      let primary = document.getElementById('topBarMd2Pairing');
      if (!primary) {
        primary = document.createElement('button');
        primary.type = 'button';
        primary.id = 'topBarMd2Pairing';
        primary.className = 'top-bar__dropdown-item';
        primary.innerHTML = '<i class="fa-solid fa-qrcode"></i><span>קישור מכשיר חדש</span>';
        const after = document.getElementById('topBarLinkedDevices') || document.getElementById('topBarInviteFriend');
        if (after && after.parentNode) after.parentNode.insertBefore(primary, after.nextSibling);
        else menu.appendChild(primary);
      }
      claimPrimaryLinkControl(primary);
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
