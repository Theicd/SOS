/* __SOS_MD2_PAIRING_QR__ */
// Web presentation for MD2 SOSPAIR1 (public payload only). No root K / nsec / device privkeys.
;(function initSosMd2PairingQr(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const QR_PREFIX = 'SOSPAIR1:';
  const PROTOCOL_VERSION = 'sos-pair-v1';
  const SECRET_FIELD_RE = /"(nsec|priv|d_sign_priv|d_enc_priv|privateKey|secret|rootK|k_hex)"\s*:/i;

  function b64urlEncode(bytes) {
    let arr;
    if (typeof bytes === 'string') {
      arr = new TextEncoder().encode(bytes);
    } else if (bytes && bytes.buffer && typeof bytes.length === 'number') {
      arr = bytes;
    } else {
      arr = new TextEncoder().encode(String(bytes));
    }
    let bin = '';
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function b64urlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function toPublicJson(payload) {
    const o = {
      protocolVersion: payload.protocolVersion || PROTOCOL_VERSION,
      pairingId: payload.pairingId,
      D_sign_pub: payload.D_sign_pub || payload.dSignPub,
      D_enc_pub: payload.D_enc_pub || payload.dEncPub,
      E_ephemeral_pub: payload.E_ephemeral_pub || payload.eEphemeralPub,
      nonce: payload.nonce,
      expiresAt: payload.expiresAt,
      purpose: payload.purpose || 'LINK',
      recoveryEligible: !!payload.recoveryEligible,
      hardwareBacked: !!payload.hardwareBacked,
    };
    if (payload.deviceId) o.deviceId = payload.deviceId;
    if (payload.storageClass) o.storageClass = payload.storageClass;
    if (payload.rendezvous) o.rendezvous = payload.rendezvous;
    if (payload.sasHint) o.sasHint = payload.sasHint;
    return o;
  }

  function encodeQr(payload) {
    const json = JSON.stringify(toPublicJson(payload));
    if (SECRET_FIELD_RE.test(json)) {
      throw new Error('MD2_QR_SECRET_REJECTED');
    }
    return QR_PREFIX + b64urlEncode(json);
  }

  function parseQr(qr, nowMs) {
    const trimmed = String(qr || '').trim();
    if (!trimmed.startsWith(QR_PREFIX)) {
      return { ok: false, error: 'BAD_PREFIX' };
    }
    let raw;
    try {
      raw = new TextDecoder().decode(b64urlDecode(trimmed.slice(QR_PREFIX.length)));
    } catch (_e) {
      return { ok: false, error: 'BAD_B64' };
    }
    if (SECRET_FIELD_RE.test(raw)) {
      return { ok: false, error: 'SECRET_FIELD' };
    }
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (_e) {
      return { ok: false, error: 'BAD_JSON' };
    }
    if (obj.protocolVersion !== PROTOCOL_VERSION) {
      return { ok: false, error: 'BAD_VERSION' };
    }
    const required = ['pairingId', 'D_sign_pub', 'D_enc_pub', 'E_ephemeral_pub', 'nonce', 'expiresAt'];
    for (const k of required) {
      if (obj[k] == null || obj[k] === '') return { ok: false, error: 'MISSING_' + k };
    }
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    if (Number(obj.expiresAt) + 60_000 < now) {
      return { ok: false, error: 'EXPIRED' };
    }
    return { ok: true, payload: obj, raw };
  }

  function secretScan(text) {
    const t = String(text || '');
    return {
      ok: !SECRET_FIELD_RE.test(t) && !/\bnsec1[a-z0-9]+\b/i.test(t),
      hasSecretField: SECRET_FIELD_RE.test(t),
      hasNsecBech32: /\bnsec1[a-z0-9]+\b/i.test(t),
    };
  }

  async function renderPairingQrToCanvas(canvas, payloadOrQr) {
    const QR = window.QRCode;
    if (!QR || typeof QR.toCanvas !== 'function') throw new Error('QR library missing');
    const qrText = typeof payloadOrQr === 'string' ? payloadOrQr : encodeQr(payloadOrQr);
    const scan = secretScan(qrText);
    if (!scan.ok) throw new Error('MD2_QR_SECRET_REJECTED');
    // Dense SOSPAIR1 payloads need more modules than a 240px/M render reliably exposes to scanners.
    const size = Math.max(360, Number(canvas && canvas.width) || 440);
    canvas.width = size;
    canvas.height = size;
    // ECC L + quiet zone 4: denser SOSPAIR1 stays scannable; protocol payload unchanged.
    await QR.toCanvas(canvas, qrText, { errorCorrectionLevel: 'L', margin: 4, width: size });
    return qrText;
  }

  /**
   * Legacy product modal DISABLED.
   * Product Linked Devices UX is owned exclusively by sos-web-linked-devices.js.
   * Low-level encode/parse/render remain; this never creates synthetic QR or menu entries.
   */
  function openPairingQrPanel(_payload) {
    try {
      const stale = typeof document !== 'undefined' ? document.getElementById('sosMd2PairingPanel') : null;
      if (stale) stale.hidden = true;
    } catch (_h) {}
    try {
      if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert('קישור מכשירים זמין רק דרך מסך קישור המכשירים המעודכן.');
      }
    } catch (_a) {}
    return { ok: false, code: 'LEGACY_MD2_PRODUCT_UI_DISABLED', SYNTHETIC_QR: false };
  }

  /** No product menu registration — WebLinkedDevices is the sole event owner. */
  function ensureMenuEntry() {
    return { ok: false, code: 'MD2_PRODUCT_MENU_DISABLED' };
  }

  App.Md2PairingQr = {
    QR_PREFIX,
    PROTOCOL_VERSION,
    encodeQr,
    parseQr,
    secretScan,
    renderPairingQrToCanvas,
    openPairingQrPanel,
    ensureMenuEntry,
    PRODUCT_UI_OWNER: 'WebLinkedDevices',
    LEGACY_MD2_PRODUCT_UI: false,
    SYNTHETIC_QR_FALLBACK: false,
  };
  window.SosMd2PairingQr = App.Md2PairingQr;
})(window);
