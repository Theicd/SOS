/**
 * Generate a fresh SOSPAIR1 QR display page for physical optical testing (S7A2 / W2).
 * Public pairing fields only — no root K / nsec.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, createHash } from 'crypto';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(ROOT, 'qa', '.physical-qr');
const require = createRequire(import.meta.url);

function hex(n) {
  return randomBytes(n).toString('hex');
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

const payload = {
  protocolVersion: 'sos-pair-v1',
  pairingId: hex(32),
  D_sign_pub: hex(32),
  D_enc_pub: hex(32),
  E_ephemeral_pub: hex(32),
  nonce: hex(32),
  expiresAt: Date.now() + 180000,
  purpose: 'LINK',
  deviceId: hex(32),
  storageClass: 'SOFTWARE_ONLY',
  recoveryEligible: false,
  hardwareBacked: false,
  deviceType: 'DESKTOP',
  deviceLabel: 'QA Desktop Optical',
  rendezvous: 'wss://relay.snort.social',
};

const json = JSON.stringify(payload);
const qrText = 'SOSPAIR1:' + b64url(json);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'latest-sospair1.txt'), qrText);
fs.writeFileSync(path.join(OUT_DIR, 'latest-payload.json'), JSON.stringify(payload, null, 2));

let dataUrl = '';
try {
  const QRCode = require(path.join(ROOT, 'node_modules', 'qrcode'));
  dataUrl = await QRCode.toDataURL(qrText, { errorCorrectionLevel: 'M', margin: 2, width: 512 });
} catch (_e) {
  try {
    const QRCode = require('qrcode');
    dataUrl = await QRCode.toDataURL(qrText, { errorCorrectionLevel: 'M', margin: 2, width: 512 });
  } catch (_e2) {
    dataUrl = '';
  }
}

const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8"/>
<title>SOSPAIR1 Optical QA</title>
<style>
  html,body{margin:0;background:#111;color:#fff;font-family:system-ui,sans-serif;height:100%;}
  .wrap{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;}
  img{width:min(80vw,512px);height:auto;background:#fff;padding:16px;border-radius:12px;}
  h1{font-size:1.4rem;margin:0 0 12px;}
  .meta{opacity:.8;font-size:13px;max-width:640px;text-align:center;word-break:break-all;margin-top:12px;}
  textarea{width:min(90vw,640px);height:90px;margin-top:12px;font-size:11px;}
</style>
</head>
<body>
<div class="wrap">
  <h1>SOSPAIR1 — סריקה אופטית (QA)</h1>
  ${dataUrl ? `<img alt="SOSPAIR1 QR" src="${dataUrl}"/>` : '<p>QR image unavailable — use textarea + external renderer</p>'}
  <div class="meta">pairingId=${payload.pairingId.slice(0, 16)}… · expires ${new Date(payload.expiresAt).toISOString()} · deviceId=${payload.deviceId.slice(0, 12)}…</div>
  <textarea readonly>${qrText}</textarea>
</div>
</body>
</html>`;

fs.writeFileSync(path.join(OUT_DIR, 'display.html'), html);
console.log('OUT', OUT_DIR);
console.log('PAIRING_FP', payload.pairingId.slice(0, 16));
console.log('QR_SHA256', createHash('sha256').update(qrText).digest('hex'));
console.log('HAS_IMAGE', !!dataUrl);
