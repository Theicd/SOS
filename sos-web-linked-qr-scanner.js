/**
 * MD3W-W2 — Mobile Web Linked Devices QR scanner.
 * Secure-context getUserMedia + BarcodeDetector (preferred) + bundled jsQR fallback.
 * On-device only — no remote QR service, no CDN runtime load, no secret logging.
 * Decode ≠ authorization (caller must continue to T2 / PhoneIssuer).
 */
(function initSosWebLinkedQrScanner(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});
  const PANEL_ID = 'sosLinkedScanPanel';
  const JSQR_SRC = './vendor/jsQR.js';

  let stream = null;
  let raf = 0;
  let active = false;
  let consumedPayload = '';
  let detector = null;
  let jsQRReady = null;
  let visibilityHandler = null;

  function isSecureOk() {
    try {
      if (window.isSecureContext === true) return true;
      const h = String(location.hostname || '').toLowerCase();
      return h === 'localhost' || h === '127.0.0.1';
    } catch (_e) {
      return false;
    }
  }

  function ensureJsQR() {
    if (typeof window.jsQR === 'function') return Promise.resolve(true);
    if (jsQRReady) return jsQRReady;
    jsQRReady = new Promise(function (resolve) {
      const s = document.createElement('script');
      s.src = JSQR_SRC;
      s.async = true;
      s.onload = function () {
        resolve(typeof window.jsQR === 'function');
      };
      s.onerror = function () {
        resolve(false);
      };
      document.head.appendChild(s);
    });
    return jsQRReady;
  }

  function stopTracks() {
    active = false;
    if (raf) {
      try {
        cancelAnimationFrame(raf);
      } catch (_e) {}
      raf = 0;
    }
    if (stream) {
      try {
        stream.getTracks().forEach(function (t) {
          try {
            t.stop();
          } catch (_e) {}
        });
      } catch (_e) {}
      stream = null;
    }
    detector = null;
    const video = document.getElementById('sosLinkedScanVideo');
    if (video) {
      try {
        video.srcObject = null;
      } catch (_e) {}
    }
    if (visibilityHandler) {
      try {
        document.removeEventListener('visibilitychange', visibilityHandler);
      } catch (_e) {}
      visibilityHandler = null;
    }
  }

  function setStatus(text) {
    const el = document.getElementById('sosLinkedScanStatus');
    if (el) el.textContent = String(text || '');
  }

  function ensurePanel() {
    let el = document.getElementById(PANEL_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = PANEL_ID;
    el.hidden = true;
    el.innerHTML =
      '<div class="sos-ld-scan-backdrop" data-ld-scan-close></div>' +
      '<div class="sos-ld-scan-sheet" role="dialog" aria-modal="true" dir="rtl">' +
      '<header><h2>סריקת QR לקישור מחשב</h2>' +
      '<button type="button" data-ld-scan-close aria-label="סגור">×</button></header>' +
      '<p id="sosLinkedScanStatus" style="min-height:1.4em;margin:8px 0;font-size:14px;"></p>' +
      '<video id="sosLinkedScanVideo" playsinline muted autoplay style="width:100%;max-height:50vh;background:#111;border-radius:8px;object-fit:cover;"></video>' +
      '<canvas id="sosLinkedScanCanvas" hidden width="480" height="480"></canvas>' +
      '<div style="display:flex;gap:8px;margin-top:12px;">' +
      '<button type="button" class="button-secondary" id="sosLinkedScanCancel" style="flex:1;">ביטול</button>' +
      '</div>' +
      '<p style="font-size:12px;opacity:.75;margin-top:10px;">הסריקה מקומית במכשיר. זיהוי QR אינו מאשר קישור — תידרש אישור מאובטח נפרד.</p>' +
      '</div>' +
      '<style>' +
      '#' +
      PANEL_ID +
      '{position:fixed;inset:0;z-index:12040;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.55)}' +
      '#' +
      PANEL_ID +
      '[hidden]{display:none!important}' +
      '#' +
      PANEL_ID +
      ' .sos-ld-scan-sheet{background:#1a1a1a;color:#f5f5f5;width:100%;max-width:520px;border-radius:16px 16px 0 0;padding:16px;box-sizing:border-box}' +
      '#' +
      PANEL_ID +
      ' header{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
      '#' +
      PANEL_ID +
      ' header h2{margin:0;font-size:1.15rem}' +
      '</style>';
    document.body.appendChild(el);
    el.addEventListener('click', function (e) {
      if (e.target && e.target.hasAttribute('data-ld-scan-close')) {
        closeScanner({ code: 'USER_CANCELLED' });
      }
    });
    const cancel = el.querySelector('#sosLinkedScanCancel');
    if (cancel) {
      cancel.onclick = function () {
        closeScanner({ code: 'USER_CANCELLED' });
      };
    }
    return el;
  }

  let pendingResolve = null;

  function closeScanner(result) {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.hidden = true;
    stopTracks();
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = null;
      r(result || { ok: false, code: 'CLOSED' });
    }
  }

  function acceptPayload(raw, onPayload) {
    const text = String(raw || '').trim();
    if (!text) return false;
    if (consumedPayload && consumedPayload === text) return false;
    // Never log full QR (may contain public pairing material — still avoid spam/secrets).
    const Md2 = App.Md2PairingQr || window.SosMd2PairingQr;
    if (!Md2 || typeof Md2.parseQr !== 'function') {
      setStatus('מודול SOSPAIR1 חסר');
      return false;
    }
    if (typeof Md2.secretScan === 'function') {
      const scan = Md2.secretScan(text);
      if (scan && scan.ok === false) {
        setStatus('קוד לא חוקי (שדות סודיים)');
        return false;
      }
    }
    // Group invite rejection via intake-like heuristics
    if (/invite|הזמנה|GROUP/i.test(text) && text.indexOf('SOSPAIR1:') !== 0) {
      setStatus('זה אינו QR לקישור מחשב (SOSPAIR1)');
      return false;
    }
    const parsed = Md2.parseQr(text);
    if (!parsed.ok) {
      const err = parsed.error || 'BAD_QR';
      setStatus(
        err === 'EXPIRED'
          ? 'קוד QR פג תוקף — בקשו מהמחשב קוד חדש'
          : err === 'BAD_PREFIX'
            ? 'קוד לא נתמך — סרקו SOSPAIR1 מהמחשב'
            : 'קוד לא תקין: ' + err,
      );
      return false;
    }
    consumedPayload = text;
    setStatus('QR זוהה — ממשיכים לאישור…');
    if (typeof onPayload === 'function') {
      try {
        onPayload({ ok: true, qrText: text, payload: parsed.payload });
      } catch (_e) {}
    }
    closeScanner({ ok: true, qrText: text, payload: parsed.payload, code: 'SCANNED' });
    return true;
  }

  async function tickLoop(video, canvas, onPayload) {
    if (!active) return;
    try {
      if (document.hidden) {
        raf = requestAnimationFrame(function () {
          setTimeout(function () {
            tickLoop(video, canvas, onPayload);
          }, 400);
        });
        return;
      }
      if (detector && video.readyState >= 2) {
        const codes = await detector.detect(video);
        if (codes && codes[0] && codes[0].rawValue) {
          if (acceptPayload(codes[0].rawValue, onPayload)) return;
        }
      } else if (typeof window.jsQR === 'function' && video.readyState >= 2) {
        const w = Math.min(video.videoWidth || 480, 640);
        const h = Math.min(video.videoHeight || 480, 640);
        if (w > 0 && h > 0) {
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(video, 0, 0, w, h);
          const img = ctx.getImageData(0, 0, w, h);
          const code = window.jsQR(img.data, img.width, img.height, {
            inversionAttempts: 'dontInvert',
          });
          if (code && code.data) {
            if (acceptPayload(code.data, onPayload)) return;
          }
        }
      }
    } catch (_e) {
      // transient detect errors — continue
    }
    raf = requestAnimationFrame(function () {
      setTimeout(function () {
        tickLoop(video, canvas, onPayload);
      }, 200);
    });
  }

  /**
   * Open scanner UI; resolves with { ok, qrText, payload } or error code.
   */
  function startLinkedDeviceQrScan(opts) {
    const o = opts || {};
    return new Promise(async function (resolve) {
      if (pendingResolve) {
        resolve({ ok: false, code: 'SCANNER_BUSY' });
        return;
      }
      pendingResolve = resolve;
      consumedPayload = '';
      if (!isSecureOk()) {
        closeScanner({ ok: false, code: 'INSECURE_CONTEXT' });
        return;
      }
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        closeScanner({ ok: false, code: 'CAMERA_API_UNAVAILABLE' });
        return;
      }

      const panel = ensurePanel();
      panel.hidden = false;
      setStatus('מבקשים גישה למצלמה…');

      const hasDetector = typeof window.BarcodeDetector === 'function';
      if (!hasDetector) {
        const okJs = await ensureJsQR();
        if (!okJs) {
          setStatus('סריקת מצלמה אינה זמינה בדפדפן זה');
          closeScanner({ ok: false, code: 'NO_DECODER' });
          return;
        }
      } else {
        try {
          detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch (_e) {
          detector = null;
          const okJs = await ensureJsQR();
          if (!okJs) {
            closeScanner({ ok: false, code: 'DETECTOR_INIT_FAIL' });
            return;
          }
        }
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
      } catch (err) {
        const name = String((err && err.name) || '');
        const code =
          name === 'NotAllowedError' || name === 'PermissionDeniedError'
            ? 'CAMERA_PERMISSION_DENIED'
            : name === 'NotFoundError'
              ? 'CAMERA_UNAVAILABLE'
              : 'CAMERA_OPEN_FAIL';
        setStatus(
          code === 'CAMERA_PERMISSION_DENIED'
            ? 'הרשאת מצלמה נדחתה. אפשר לאשר בהגדרות הדפדפן.'
            : 'לא ניתן לפתוח את המצלמה',
        );
        closeScanner({ ok: false, code: code });
        return;
      }

      const video = document.getElementById('sosLinkedScanVideo');
      const canvas = document.getElementById('sosLinkedScanCanvas');
      video.srcObject = stream;
      try {
        await video.play();
      } catch (_e) {}
      active = true;
      setStatus('מכוונים לקוד ה־QR על מסך המחשב…');
      visibilityHandler = function () {
        if (document.hidden) {
          setStatus('הדפדפן ברקע — הסריקה מושהית');
        } else if (active) {
          setStatus('מכוונים לקוד ה־QR על מסך המחשב…');
        }
      };
      document.addEventListener('visibilitychange', visibilityHandler);
      tickLoop(video, canvas, o.onPayload);
    });
  }

  const api = {
    startLinkedDeviceQrScan: startLinkedDeviceQrScan,
    stopLinkedDeviceQrScan: function () {
      closeScanner({ ok: false, code: 'STOPPED' });
    },
    WEB_QR_SCANNER_PRESENT: true,
    REMOTE_QR_SERVICE: false,
    CDN_RUNTIME_SCANNER: false,
    DECODE_IS_NOT_AUTHORIZATION: true,
  };
  App.WebLinkedQrScanner = api;
  window.SosWebLinkedQrScanner = api;
})(window);
