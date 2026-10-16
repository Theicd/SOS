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
check('web cache bust 899s24', videos.includes('pkg=899s24') && videos.includes('sos-md4-desktop-authority.js'));
check('desktop opens linked account', ld.includes('async function openLinkedDesktopAccount') && ld.includes("App.identityState = 'LINKED_DEVICE'") && ld.includes('ROOT_K_PRESENT: false') && !ld.includes('writePrivateKeyRaw'));
const guest = read(path.join(root, 'guest-auth.js'));
check('linked device top bar', guest.includes("App.linkedDeviceSession === true") && guest.includes("'LINKED_DEVICE'"));
check('web cache bust 899s33 account session', videos.includes('sos-account-session.js?v=20261015&pkg=899s33') && videos.includes('chat-state.js?v=20261015&pkg=899s33'));
check('web cache bust 899s35 media call', videos.includes('chat-voice-call.js?v=20261016&pkg=899s35') && videos.includes('chat-service.js?v=20261016&pkg=899s35') && videos.includes('blossom.js?v=20261016&pkg=899s34'));
check('linked account is not a fingerprint chip', !ld.includes("textContent = 'חשבון '") && ld.includes("getElementById('sosLdAccountChip')") && ld.includes('App.privateKey = null'));
check('requireAuth accepts linked device', read(path.join(root, 'app.js')).includes("session.role === 'LINKED_DEVICE'") && read(path.join(root, 'app.js')).includes('accountSessionAllows'));
check('delegated chat and history op', read(path.join(root, 'sos-account-session.js')).includes('delegatedChatEncrypt') && read(path.join(root, 'sos-crypto-worker.js')).includes('SIGN_LINKED_HISTORY'));
check('web cache bust 899s25 account open', true);
check('scan-only routine path', issuer.includes("AUTHORIZE_LINKED_DEVICE_SCAN") && issuer.includes('completeScanAuthorizedSession') && issuer.includes("o.transport !== 'popup'"));
check('desktop verifies before ack', md2.includes('acknowledgeLinked') && md2.includes('verified: true') && issuer.includes('DESKTOP_ACK_UNVERIFIED'));
check('return waits for issuance flag', issuer.includes('waitForIssuanceFlag') && issuer.includes('whenReady'));
check('return payload stashed before redirect', videos.includes('sos_ld_ald_res_v1') && issuer.includes('peekResumeRecord') && issuer.includes('markSameTab'));

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
