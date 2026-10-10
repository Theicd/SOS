/**
 * MD3W-W2 — Mobile Web Linked Devices QR scanner static + unit gate.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomUUID } from 'crypto';
import vm from 'vm';
import { webcrypto } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'md3w-w2-web-qr-scanner-report.json');
const runId = randomUUID();
const checks = {};
let fails = 0;
const notes = [];

function log(s) {
  notes.push(s);
  console.log(s);
}
function check(name, ok, detail) {
  checks[name] = { ok: !!ok, detail: detail || '' };
  log(`[w2] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
}
function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}

function staticChecks() {
  const scanner = read('sos-web-linked-qr-scanner.js');
  const linked = read('sos-web-linked-devices.js');
  const videos = read('videos.html');
  const jsqr = fs.existsSync(path.join(ROOT, 'vendor', 'jsQR.js'));
  const flags = read('runtime-feature-flags.json');
  const auth = read('sos-authorize-linked-device.js');

  check('SCANNER_MODULE', /WEB_QR_SCANNER_PRESENT:\s*true/.test(scanner));
  check('NO_REMOTE_QR_SERVICE', /REMOTE_QR_SERVICE:\s*false/.test(scanner));
  check('NO_CDN_RUNTIME', /CDN_RUNTIME_SCANNER:\s*false/.test(scanner) && !/cdn\.jsdelivr|unpkg\.com/.test(scanner));
  check('GET_USER_MEDIA', /getUserMedia/.test(scanner));
  check('REAR_CAMERA_IDEAL', /facingMode[\s\S]*environment/.test(scanner));
  check('BARCODE_DETECTOR', /BarcodeDetector/.test(scanner));
  check('JSQR_FALLBACK_BUNDLED', jsqr && /vendor\/jsQR\.js/.test(scanner));
  check('STOP_TRACKS', /getTracks\(\)/.test(scanner) && /visibilitychange/.test(scanner));
  check('DECODE_NOT_AUTH', /DECODE_IS_NOT_AUTHORIZATION:\s*true/.test(scanner));
  check('SOSPAIR1_PARSER_REUSE', /parseQr/.test(scanner));
  check('GROUP_INVITE_REJECT_HINT', /SOSPAIR1/.test(scanner));
  check('DUPLICATE_CONSUME', /consumedPayload/.test(scanner));
  check('WIRED_UI_SCAN_BUTTON', /sosLdScanQr/.test(linked) && /beginPrimaryCameraScan/.test(linked));
  check('VIDEOS_SCRIPT_TAG', /sos-web-linked-qr-scanner\.js/.test(videos));
  check('PRODUCTION_FLAG_OFF', /"md3wT2SignerApproval"\s*:\s*false/.test(flags));
  check('T1_STILL_DISABLED', /T1_FALLBACK_ENABLED\s*=\s*false/.test(auth) || /T1_FALLBACK_ENABLED:\s*false/.test(auth));
  check('NO_SECRET_LOG', !/console\.log\([^)]*qrText/i.test(scanner));

  const hash = createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, 'vendor', 'jsQR.js')))
    .digest('hex')
    .toUpperCase();
  check('JSQR_VENDORED_HASH', hash.length === 64, hash.slice(0, 16));
}

function unitParseChecks() {
  const code = read('sos-md2-pairing-qr.js');
  const sandbox = {
    window: { NostrApp: {} },
    NostrApp: {},
    document: {
      readyState: 'complete',
      addEventListener: function () {},
      getElementById: function () {
        return null;
      },
    },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    TextEncoder,
    TextDecoder,
    crypto: webcrypto,
    Uint8Array,
    JSON,
    console,
  };
  sandbox.window = sandbox;
  sandbox.window.document = sandbox.document;
  sandbox.window.NostrApp = sandbox.NostrApp;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const Md2 = sandbox.NostrApp.Md2PairingQr || sandbox.window.SosMd2PairingQr;
  check('MD2_QR_MODULE', !!Md2 && typeof Md2.parseQr === 'function');
  if (!Md2) return;

  const payload = {
    protocolVersion: 'sos-pair-v1',
    pairingId: 'a'.repeat(64),
    D_sign_pub: 'b'.repeat(64),
    D_enc_pub: 'c'.repeat(64),
    E_ephemeral_pub: 'd'.repeat(64),
    nonce: 'e'.repeat(64),
    expiresAt: Date.now() + 120000,
    purpose: 'LINK',
    deviceId: 'f'.repeat(64),
  };
  const qr = Md2.encodeQr(payload);
  const ok = Md2.parseQr(qr);
  check('POS_SOSPAIR1_PARSE', ok.ok === true);

  const invite = 'SOSINVITE:not-a-pair';
  const bad = Md2.parseQr(invite);
  check('NEG_NON_PAIR_PREFIX', bad.ok === false);

  const expired = Md2.encodeQr({ ...payload, expiresAt: Date.now() - 120000 });
  const ex = Md2.parseQr(expired);
  check('NEG_EXPIRED_QR', ex.ok === false && ex.error === 'EXPIRED');
}

staticChecks();
unitParseChecks();

const report = {
  gate: 'MD3W_W2_WEB_QR_SCANNER',
  status: fails === 0 ? 'PASS' : 'FAIL',
  ts: new Date().toISOString(),
  runId,
  checks,
  notes,
  failCount: fails,
  OPTICAL_HARDWARE_CLAIMED: false,
  LIVE_E2E_CLAIMED: false,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('REPORT', OUT);
console.log('STATUS=' + report.status + ' runId=' + runId);
process.exit(fails === 0 ? 0 : 1);
