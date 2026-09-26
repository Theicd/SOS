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
    await QR.toCanvas(canvas, qrText, { errorCorrectionLevel: 'M', margin: 2, width: 240 });
    return qrText;
  }

  function openPairingQrPanel(payload) {
    let el = document.getElementById('sosMd2PairingPanel');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sosMd2PairingPanel';
      el.innerHTML = `
        <div class="sos-md2-qr__backdrop" data-md2-close></div>
        <div class="sos-md2-qr__panel" role="dialog" aria-modal="true">
          <header><h2>קישור מכשיר (MD2)</h2>
            <button type="button" data-md2-close aria-label="סגור">×</button></header>
          <p>QR ציבורי בלבד (SOSPAIR1). ללא מפתח שורש.</p>
          <canvas id="sosMd2QrCanvas" width="240" height="240"></canvas>
          <textarea id="sosMd2QrText" rows="4" style="width:100%;margin-top:10px;font-size:11px;"></textarea>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
            <button type="button" class="button-primary" id="sosMd2ParseBtn">אמת טקסט</button>
            <button type="button" class="button-secondary" data-md2-close>סגור</button>
          </div>
          <p id="sosMd2ParseStatus" style="min-height:1.2em;"></p>
          <p style="font-size:12px;opacity:.75;">יצירת מפתחות מכשיר / אישור פיזי — Android (דחוי).</p>
        </div>`;
      const style = document.createElement('style');
      style.textContent = `
        #sosMd2PairingPanel{position:fixed;inset:0;z-index:12010;display:flex;align-items:center;justify-content:center}
        #sosMd2PairingPanel[hidden]{display:none!important}
        .sos-md2-qr__backdrop{position:absolute;inset:0;background:rgba(0,0,0,.55)}
        .sos-md2-qr__panel{position:relative;background:#111;color:#fff;border-radius:14px;padding:18px;max-width:380px;width:92%}
        .sos-md2-qr__panel header{display:flex;justify-content:space-between;align-items:center}
        #sosMd2QrCanvas{display:block;margin:12px auto;background:#fff;border-radius:8px}
      `;
      document.head.appendChild(style);
      document.body.appendChild(el);
      el.addEventListener('click', (e) => {
        if (e.target && e.target.hasAttribute('data-md2-close')) {
          el.hidden = true;
        }
      });
      document.getElementById('sosMd2ParseBtn').onclick = () => {
        const text = document.getElementById('sosMd2QrText').value;
        const res = parseQr(text);
        const st = document.getElementById('sosMd2ParseStatus');
        st.textContent = res.ok ? 'תקין: ' + res.payload.pairingId.slice(0, 12) + '…' : 'שגיאה: ' + res.error;
      };
    }
    el.hidden = false;
    const canvas = document.getElementById('sosMd2QrCanvas');
    const ta = document.getElementById('sosMd2QrText');
    Promise.resolve(renderPairingQrToCanvas(canvas, payload)).then((qr) => {
      ta.value = qr;
    }).catch((err) => {
      document.getElementById('sosMd2ParseStatus').textContent = String(err.message || err);
    });
  }

  function ensureMenuEntry() {
    const menu = document.getElementById('topBarProfileMenu');
    if (!menu || document.getElementById('topBarMd2Pairing')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'topBarMd2Pairing';
    btn.className = 'top-bar__dropdown-item';
    btn.innerHTML = '<i class="fa-solid fa-qrcode"></i><span>קישור מכשיר (QR)</span>';
    btn.addEventListener('click', () => {
      menu.hidden = true;
      // Demo/public fixture only — real D pubs come from Android MD1 store later.
      const fixture = {
        protocolVersion: PROTOCOL_VERSION,
        pairingId: '0'.repeat(32),
        D_sign_pub: '02' + '11'.repeat(32),
        D_enc_pub: '03' + '22'.repeat(32),
        E_ephemeral_pub: '04' + '33'.repeat(32),
        nonce: '55'.repeat(32),
        expiresAt: Date.now() + 120000,
        purpose: 'LINK',
        deviceId: 'web-ui-fixture',
        storageClass: 'WEB_PRESENTATION_ONLY',
        recoveryEligible: false,
        hardwareBacked: false,
      };
      openPairingQrPanel(fixture);
    });
    const invite = document.getElementById('topBarInviteFriend');
    if (invite && invite.parentNode) invite.parentNode.insertBefore(btn, invite.nextSibling);
    else menu.appendChild(btn);
  }

  App.Md2PairingQr = {
    QR_PREFIX,
    PROTOCOL_VERSION,
    encodeQr,
    parseQr,
    secretScan,
    renderPairingQrToCanvas,
    openPairingQrPanel,
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureMenuEntry);
  } else {
    ensureMenuEntry();
  }
})(window);
