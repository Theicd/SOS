/* __SOS_INVITE_QR__ */
;(function initSosInviteQrUi(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  let modalEl = null;
  let scanStream = null;

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.id = 'sosInviteQrModal';
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    modalEl.hidden = true;
    modalEl.innerHTML = `
      <div class="sos-invite-qr__backdrop" data-invite-qr-close></div>
      <div class="sos-invite-qr__panel">
        <header class="sos-invite-qr__header">
          <h2>הזמנה לרשת</h2>
          <button type="button" class="sos-invite-qr__close" data-invite-qr-close aria-label="סגור">×</button>
        </header>
        <p class="sos-invite-qr__hint">סריקת ה-QR או הזנת הקוד — בלי מפתחות פרטיים.</p>
        <canvas id="sosInviteQrCanvas" width="240" height="240" aria-label="קוד QR להזמנה"></canvas>
        <p class="sos-invite-qr__code" id="sosInviteQrCodeLabel"></p>
        <div class="sos-invite-qr__actions">
          <button type="button" class="button-primary" id="sosInviteQrCopy">העתק קישור</button>
          <button type="button" class="button-secondary" id="sosInviteQrWhatsapp">WhatsApp</button>
        </div>
      </div>
    `;
    const style = document.createElement('style');
    style.textContent = `
      #sosInviteQrModal[hidden]{display:none!important}
      #sosInviteQrModal{position:fixed;inset:0;z-index:12000;display:flex;align-items:center;justify-content:center}
      .sos-invite-qr__backdrop{position:absolute;inset:0;background:rgba(0,0,0,.55)}
      .sos-invite-qr__panel{position:relative;background:#111;color:#fff;border-radius:14px;padding:18px;max-width:340px;width:92%;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.45)}
      .sos-invite-qr__header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
      .sos-invite-qr__header h2{margin:0;font-size:1.1rem}
      .sos-invite-qr__close{background:none;border:0;color:#fff;font-size:1.4rem;cursor:pointer}
      .sos-invite-qr__hint{font-size:.85rem;opacity:.8;margin:0 0 12px}
      #sosInviteQrCanvas{background:#fff;border-radius:8px;margin:0 auto}
      .sos-invite-qr__code{font-family:ui-monospace,monospace;letter-spacing:.12em;margin:12px 0}
      .sos-invite-qr__actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
      .sos-invite-qr__actions button{flex:1;min-width:120px}
      #sosInviteQrScanPanel{margin-top:12px}
      #sosInviteQrScanVideo{width:100%;max-height:220px;background:#000;border-radius:8px}
    `;
    document.head.appendChild(style);
    document.body.appendChild(modalEl);
    modalEl.addEventListener('click', (e) => {
      if (e.target && e.target.hasAttribute('data-invite-qr-close')) closeInviteQrModal();
    });
    return modalEl;
  }

  async function renderInviteQr(inviteUrl, code) {
    ensureModal();
    const canvas = document.getElementById('sosInviteQrCanvas');
    const label = document.getElementById('sosInviteQrCodeLabel');
    if (label) label.textContent = String(code || '').toUpperCase();
    const QR = window.QRCode;
    if (!QR || typeof QR.toCanvas !== 'function') {
      throw new Error('ספריית QR לא נטענה');
    }
    // Payload is the approved invite URL only (contains invite code query). Never root secrets.
    await QR.toCanvas(canvas, String(inviteUrl || ''), {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 240,
      color: { dark: '#000000', light: '#ffffff' },
    });
    modalEl.hidden = false;
    modalEl.dataset.inviteUrl = String(inviteUrl || '');
    modalEl.dataset.inviteCode = String(code || '').toUpperCase();
    const copyBtn = document.getElementById('sosInviteQrCopy');
    const waBtn = document.getElementById('sosInviteQrWhatsapp');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(modalEl.dataset.inviteUrl || '');
          copyBtn.textContent = 'הועתק';
          setTimeout(() => { copyBtn.textContent = 'העתק קישור'; }, 1500);
        } catch (_e) {
          prompt('העתיקו את הקישור:', modalEl.dataset.inviteUrl || '');
        }
      };
    }
    if (waBtn) {
      waBtn.onclick = () => {
        const msg = encodeURIComponent(
          `הזמנה לרשת SOS:\n${modalEl.dataset.inviteUrl}\n\nקוד הזמנה: ${modalEl.dataset.inviteCode}`
        );
        window.open(`https://wa.me/?text=${msg}`, '_blank', 'noopener');
      };
    }
  }

  function closeInviteQrModal() {
    if (modalEl) modalEl.hidden = true;
    stopScan();
  }

  function stopScan() {
    if (scanStream) {
      try { scanStream.getTracks().forEach((t) => t.stop()); } catch (_e) {}
      scanStream = null;
    }
    const v = document.getElementById('sosInviteQrScanVideo');
    if (v) v.srcObject = null;
  }

  function extractInviteCode(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    try {
      const u = new URL(text);
      const q = (u.searchParams.get('invite') || '').trim().toUpperCase();
      if (q) return q;
    } catch (_e) {}
    const m = text.match(/invite=([A-Z0-9]+)/i);
    if (m) return m[1].toUpperCase();
    if (/^[A-Z0-9]{6,16}$/i.test(text)) return text.toUpperCase();
    return '';
  }

  async function startInviteQrScan(onCode) {
    const input = document.getElementById('signupInviteCodeInput');
    const status = document.getElementById('inviteStatus');
    if (!navigator.mediaDevices?.getUserMedia) {
      if (status) status.textContent = 'המצלמה לא זמינה — הזינו קוד ידנית.';
      return { ok: false, reason: 'NO_CAMERA_API' };
    }
    let panel = document.getElementById('sosInviteQrScanPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'sosInviteQrScanPanel';
      panel.innerHTML = `
        <video id="sosInviteQrScanVideo" playsinline muted></video>
        <button type="button" class="button-secondary" id="sosInviteQrScanStop" style="width:100%;margin-top:8px;">עצור סריקה</button>
      `;
      const step = document.getElementById('authStepInvite');
      if (step) step.appendChild(panel);
    }
    panel.hidden = false;
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch (err) {
      if (status) status.textContent = 'נדרשת הרשאת מצלמה לסריקת QR, או הזינו קוד ידנית.';
      return { ok: false, reason: 'CAMERA_PERMISSION', error: String(err && err.message || err) };
    }
    const video = document.getElementById('sosInviteQrScanVideo');
    video.srcObject = scanStream;
    await video.play();
    document.getElementById('sosInviteQrScanStop').onclick = () => {
      stopScan();
      panel.hidden = true;
    };

    const Detector = window.BarcodeDetector;
    if (!Detector) {
      if (status) status.textContent = 'סריקת מצלמה אינה נתמכת בדפדפן זה — הזינו קוד ידנית.';
      return { ok: false, reason: 'NO_BARCODE_DETECTOR' };
    }
    const detector = new Detector({ formats: ['qr_code'] });
    let active = true;
    const tick = async () => {
      if (!active || !scanStream) return;
      try {
        const codes = await detector.detect(video);
        if (codes && codes[0] && codes[0].rawValue) {
          const code = extractInviteCode(codes[0].rawValue);
          if (code) {
            active = false;
            if (input) input.value = code;
            if (typeof onCode === 'function') onCode(code);
            if (status) status.textContent = 'קוד הזמנה נסרק.';
            stopScan();
            panel.hidden = true;
            return;
          }
        }
      } catch (_e) {}
      requestAnimationFrame(() => setTimeout(tick, 250));
    };
    tick();
    return { ok: true };
  }

  function ensureScanButton() {
    const step = document.getElementById('authStepInvite');
    if (!step || document.getElementById('btnInviteQrScan')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btnInviteQrScan';
    btn.className = 'button-secondary';
    btn.style.cssText = 'width:100%;padding:12px;font-size:15px;margin-bottom:10px;';
    btn.textContent = 'סרוק QR הזמנה';
    const input = document.getElementById('signupInviteCodeInput');
    if (input && input.parentNode) input.parentNode.insertBefore(btn, input);
    btn.addEventListener('click', () => {
      startInviteQrScan();
    });
  }

  App.showInviteQrModal = renderInviteQr;
  App.closeInviteQrModal = closeInviteQrModal;
  App.startInviteQrScan = startInviteQrScan;
  App.extractInviteCodeFromQrText = extractInviteCode;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureScanButton);
  } else {
    ensureScanButton();
  }
})(window);
