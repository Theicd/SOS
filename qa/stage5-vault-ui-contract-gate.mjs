/**
 * Contract gate for the silent VAULT_NOT_READY linking failure.
 * Static only. No keys, no QR payloads, no production mutation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const signer = 'C:/BRAIN/SOS-signer';
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const ld = read(path.join(root, 'sos-web-linked-devices.js'));
const issuer = read(path.join(root, 'sos-web-phone-issuer.js'));
const md2 = read(path.join(root, 'sos-md2-pairing-session.js'));
const ui = read(path.join(signer, 'js/authorize-linked-device-approval-ui.js'));
const uiDated = read(path.join(signer, 'js/authorize-linked-device-approval-ui-20261014.js'));
const html = read(path.join(signer, 'authorize-linked-device.html'));
const sw = read(path.join(signer, 'sw.js'));
const videos = read(path.join(root, 'videos.html'));

const he =
  'כספת החתימה של SOS אינה מוכנה.\\nהמחשב זוהה, אך הקישור עדיין לא אושר.\\nיש להשלים את הגדרת Trusted Signer עבור חשבון זה.';
check('hebrew vault copy', ld.includes(he));
check('signer import action', ld.includes('https://signer.sos010.com/import.html'));
check('passkey enroll action separate', ld.includes('https://signer.sos010.com/enroll.html') && ld.includes('WEBAUTHN_ENROLLMENT_REQUIRED'));
check('scan button remains', ld.includes('id="sosLdMobileScan"'));
check('no alert-only vault path', !/VAULT_NOT_READY[\s\S]{0,200}window\.alert/.test(ld));
check('issuer binds popup source', issuer.includes('ev.source !== popup'));
check('issuer binds sessionId', issuer.includes("String(d.sessionId || '') !== String(cer.sessionId)"));
check('issuer returns vaultState', issuer.includes('vaultState: vaultState') || issuer.includes('vaultState: approval.vaultState'));
check('issuer traces channel and linked', issuer.includes("linkTrace('MD2_CHANNEL_READY'") && issuer.includes("linkTrace('DESKTOP_LINKED'"));
check('md2 console phase', md2.includes("console.info('[SOS-LD] '") && md2.includes("phoneDbg('AEAD_CHANNEL_READY')"));
check('signer posts vault error once after request', ui.includes('postErrorOnce') && ui.includes('if (pendingRequest)') && ui.includes('vaultState:'));
check('signer rejects foreign session', ui.includes('ceremonySessionId') && ui.includes('ev.source !== window.opener'));
check('dated ui matches canonical', ui === uiDated);
check('ceremony html cache bust', html.includes('authorize-linked-device-approval-boot-20261014.js'));
check('signer shell bumped', /signer-shell-v11/.test(sw));
check('web cache bust 899s16', videos.includes('sos-web-linked-devices.js?v=20261014&pkg=899s16') && videos.includes('sos-web-phone-issuer.js?v=20261014&pkg=899s16'));

const failed = checks.filter((c) => !c.ok);
const out = {
  gate: 'STAGE5_VAULT_UI_CONTRACT',
  status: failed.length ? 'FAIL' : 'PASS',
  checks,
};
const outPath = path.join(root, 'qa', 'stage5-vault-ui-contract-report.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log('STATUS=' + out.status);
process.exit(failed.length ? 1 : 0);
