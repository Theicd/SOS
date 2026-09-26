#!/usr/bin/env node
/**
 * Web QR + MD2 presentation gates (no Android).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const QRCode = require('qrcode');

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}

function loadMd2() {
  const code = read('sos-md2-pairing-qr.js');
  const sandbox = {
    window: {},
    console,
    TextEncoder,
    TextDecoder,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById() { return null; },
      createElement() {
        return {
          style: {},
          setAttribute() {},
          appendChild() {},
          addEventListener() {},
          querySelector() { return null; },
        };
      },
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
  };
  sandbox.window = sandbox;
  sandbox.window.NostrApp = {};
  vm.runInNewContext(code, sandbox, { filename: 'sos-md2-pairing-qr.js' });
  return sandbox.window.NostrApp.Md2PairingQr || sandbox.NostrApp?.Md2PairingQr;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS' : 'FAIL'), name, detail || '');
  return !!ok;
}

let ok = true;
ok = record('invite qr ui file', fs.existsSync(path.join(ROOT, 'sos-invite-qr-ui.js'))) && ok;
ok = record('md2 qr ui file', fs.existsSync(path.join(ROOT, 'sos-md2-pairing-qr.js'))) && ok;
ok = record('vendor qrcode', fs.existsSync(path.join(ROOT, 'vendor/qrcode-browser.js'))) && ok;
ok = record('videos loads invite qr', /sos-invite-qr-ui\.js/.test(read('videos.html'))) && ok;
ok = record('videos loads md2 qr', /sos-md2-pairing-qr\.js/.test(read('videos.html'))) && ok;
ok = record('guest-auth shows invite qr', /showInviteQrModal/.test(read('guest-auth.js'))) && ok;
ok = record('invite scan button', /btnInviteQrScan|startInviteQrScan/.test(read('sos-invite-qr-ui.js'))) && ok;
ok = record('invite qr uses URL only', /inviteUrl/.test(read('sos-invite-qr-ui.js')) && !/\bnsec1|\bprivateKey\b/.test(read('sos-invite-qr-ui.js'))) && ok;

const inviteUrl = 'http://127.0.0.1:8788/videos.html?invite=ABC12345';
const dataUrl = await QRCode.toDataURL(inviteUrl);
ok = record('GROUP_INVITE_QR_GENERATE', typeof dataUrl === 'string' && dataUrl.startsWith('data:image'), dataUrl.slice(0, 32)) && ok;

const Md2 = loadMd2();
ok = record('Md2 API loaded', !!(Md2 && Md2.encodeQr && Md2.parseQr)) && ok;
const payload = {
  protocolVersion: 'sos-pair-v1',
  pairingId: 'aa'.repeat(16),
  D_sign_pub: '02' + '11'.repeat(32),
  D_enc_pub: '03' + '22'.repeat(32),
  E_ephemeral_pub: '04' + '33'.repeat(32),
  nonce: '55'.repeat(32),
  expiresAt: Date.now() + 60_000,
  purpose: 'LINK',
};
const qr = Md2.encodeQr(payload);
ok = record('MD2_PAIRING_QR_RENDER', qr.startsWith('SOSPAIR1:')) && ok;
const parsed = Md2.parseQr(qr);
ok = record('MD2_PAIRING_QR_PARSE', parsed.ok === true && parsed.payload.pairingId === payload.pairingId) && ok;
const bad = Md2.parseQr('SOSPAIR1:' + Buffer.from(JSON.stringify({ nsec: 'dead', protocolVersion: 'sos-pair-v1' })).toString('base64url'));
ok = record('MD2_PAIRING_QR_SECRET_SCAN reject nsec field', bad.ok === false) && ok;
const scan = Md2.secretScan(qr);
ok = record('MD2_PAIRING_QR_SECRET_SCAN clean', scan.ok === true) && ok;

const report = {
  gate: 'WEB_QR_MD2_PRESENTATION',
  status: ok ? 'PASS' : 'FAIL',
  results,
  GROUP_INVITE_QR_GENERATE_GATE: results.find((r) => r.name === 'GROUP_INVITE_QR_GENERATE')?.ok ? 'PASS' : 'FAIL',
  GROUP_INVITE_QR_SCAN_GATE: results.find((r) => r.name === 'invite scan button')?.ok ? 'PASS' : 'FAIL',
  MD2_PAIRING_QR_RENDER_GATE: results.find((r) => r.name === 'MD2_PAIRING_QR_RENDER')?.ok ? 'PASS' : 'FAIL',
  MD2_PAIRING_QR_PARSE_GATE: results.find((r) => r.name === 'MD2_PAIRING_QR_PARSE')?.ok ? 'PASS' : 'FAIL',
  MD2_PAIRING_QR_SECRET_SCAN: results.find((r) => r.name.includes('SECRET_SCAN clean'))?.ok ? 'PASS' : 'FAIL',
  LINKED_DEVICES_WEB_UI_CURRENT_STATUS: 'NOT_AVAILABLE_WEB — MD1–MD3 device keys Android-only; MD4 not started',
  LINKED_DEVICES_WEB_UI_GATE: 'BLOCKED_ARCHITECTURE',
  GROUP_ACCESS_CONTROL_WEB_GATE: 'BLOCKED_WITH_EXACT_ARCHITECTURE_REASON — admin/member/role UI exists (admin-settings-ui.js, member-directory-ui.js) but requires SOS_ACCESS_CONTROL_V2=true; global default must remain OFF',
  ts: new Date().toISOString(),
};
fs.writeFileSync(path.join(ROOT, 'qa/web-qr-md2-presentation-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  status: report.status,
  GROUP_INVITE_QR_GENERATE_GATE: report.GROUP_INVITE_QR_GENERATE_GATE,
  GROUP_INVITE_QR_SCAN_GATE: report.GROUP_INVITE_QR_SCAN_GATE,
  MD2_PAIRING_QR_RENDER_GATE: report.MD2_PAIRING_QR_RENDER_GATE,
  MD2_PAIRING_QR_PARSE_GATE: report.MD2_PAIRING_QR_PARSE_GATE,
  MD2_PAIRING_QR_SECRET_SCAN: report.MD2_PAIRING_QR_SECRET_SCAN,
  LINKED_DEVICES_WEB_UI_GATE: report.LINKED_DEVICES_WEB_UI_GATE,
  GROUP_ACCESS_CONTROL_WEB_GATE: report.GROUP_ACCESS_CONTROL_WEB_GATE,
}, null, 2));
process.exit(ok ? 0 : 1);
