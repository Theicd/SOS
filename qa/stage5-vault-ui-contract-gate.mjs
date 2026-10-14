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
  'כדי לקשר את המחשב יש להשלים פעם אחת את אישור החשבון.\\nהמחשב זוהה, אך הקישור עדיין לא אושר.\\nאין צורך לחזור על כך בכל קישור.';
check('hebrew vault copy', ld.includes(he));
check('no direct import href', !ld.includes('https://signer.sos010.com/import.html'));
check('session-bound setup action', ld.includes("action: 'setup'") && ld.includes('startOneTimeAccountSetup'));
check('linked only after desktop linked', ld.includes("code === 'LINKED'") && ld.includes('המחשב מחובר'));
check('import success is not linked', !ld.includes('אישור החשבון הושלם') && ld.includes('המחשב עדיין לא מחובר'));
check('no popup-enable instruction', !ld.includes('יש לאפשר את החלון'));
check('scan button remains', ld.includes('id="sosLdMobileScan"'));
check('no alert-only vault path', !/VAULT_NOT_READY[\s\S]{0,200}window\.alert/.test(ld));
check('issuer binds popup source', issuer.includes('ev.source !== popup'));
check('issuer binds sessionId', issuer.includes("String(d.sessionId || '') !== String(cer.sessionId)"));
check('issuer returns vaultState', issuer.includes('vaultState: vaultState') || issuer.includes('vaultState: approval.vaultState'));
check('issuer traces channel and linked', issuer.includes("linkTrace('MD2_CHANNEL_READY'") && issuer.includes("linkTrace('DESKTOP_LINKED'"));
check('md2 console phase', md2.includes("console.info('[SOS-LD] '") && md2.includes("phoneDbg('AEAD_CHANNEL_READY')"));
check('issuer same-tab after channel', issuer.includes('handoffSameTabCeremony') && issuer.includes("location.assign(url)") && issuer.includes("o.transport === 'popup'"));
check('issuer does not open signer after md2 by default', issuer.includes('Do not window.open here'));
check('md2 resume export', md2.includes('exportChannelResume') && md2.includes('resumePhoneChannel'));
check('signer posts vault error once after request', ui.includes('postErrorOnce') && ui.includes('if (pendingRequest)') && ui.includes('vaultState:'));
check('signer same-tab return', ui.includes('#sosAldReq=') && ui.includes('#sosAldRes=') && ui.includes('enrollWebAuthnCredential'));
check('signer keeps opener binding for popup', ui.includes('ev.source !== window.opener'));
check('dated ui matches canonical', ui === uiDated);
check('ceremony html inline uv', html.includes('continueUvBtn') && html.includes('אשרו את קישור המחשב') && !html.includes('enroll.html'));
check('signer shell bumped', /signer-shell-v13/.test(sw));
check('handoff page precached', sw.includes('./handoff.html') && sw.includes('f5b6w-handoff.js'));
const importer = read(path.join(root, 'isolated-signer-trusted-import.js'));
check('import launcher keeps opener', importer.includes("window.open(url, 'sos_signer_import', 'width=480,height=720')") && !/window\.open\([^)]*noopener/.test(importer));
check('import message bound to popup', importer.includes('event.source !== pending.win'));
check('web cache bust 899s20', videos.includes('sos-web-linked-devices.js?v=20261014&pkg=899s20') && videos.includes('sos-web-phone-issuer.js?v=20261014&pkg=899s20'));
check('return payload stashed before redirect', videos.includes('sos_ld_ald_res_v1') && issuer.includes("sessionStorage.getItem('sos_ld_ald_res_v1')") && issuer.includes("returnPath = '/videos.html'"));

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
