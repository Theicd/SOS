/**
 * Linked desktop seals a self-chat file offer with D_sign and the primary decrypts it.
 * No root key on the desktop. No live network.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const require = createRequire(pathToFileURL(path.join(ROOT, 'package.json')));
const NT = require('nostr-tools');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

let pass = 0;
let fail = 0;
function record(name, ok) {
  if (ok) {
    pass += 1;
    console.log('PASS', name);
  } else {
    fail += 1;
    console.log('FAIL', name);
  }
}

const sec = read('chat-p2p-secure-v2.js');
const fileJs = read('chat-p2p-file.js');
const p2p = read('p2p-video-sharing.js');
record('relay publish waits for each relay', /Promise\.allSettled\(bounded\)/.test(p2p) && /SIGNAL_RELAY_ACCEPTED/.test(p2p) && /SIGNAL_RELAY_REJECTED/.test(p2p));
const publishBlock = p2p.slice(p2p.indexOf('SIGNAL_PUBLISH_STARTED'), p2p.indexOf('async function handleRelayedSignal'));
record('success log follows acceptance', publishBlock.indexOf('SIGNAL_RELAY_ACCEPTED') !== -1 && publishBlock.indexOf('SIGNAL_RELAY_ACCEPTED') < publishBlock.indexOf('signal נשלח'));
record('dc file offer is awaited', /const wire = await secure\.encryptFileOfferForDc\(peerKey, offerPlain\)/.test(fileJs));
record('same-account primary can receive a device offer', /sameAccountPrimary\(peerKey\)/.test(fileJs));
record('secure module has no root key read', !/App\.privateKey/.test(sec));
record('self conversation flag rides the dc offer', /selfConversation: offerPlain\.selfConversation === true/.test(sec));

const { generateSecretKey, getPublicKey, utils } = NT;
const bytesToHex = (utils && utils.bytesToHex) || ((u8) => Buffer.from(u8).toString('hex'));
const accountSk = generateSecretKey();
const deviceSk = generateSecretKey();
const accountPk = getPublicKey(accountSk);
const devicePk = getPublicKey(deviceSk);
const accountHex = bytesToHex(accountSk);
const deviceHex = bytesToHex(deviceSk);

function boot() {
  const ctx = { window: {}, NostrApp: {}, NostrTools: NT, console, Uint8Array, parseInt, String, Promise };
  ctx.window = ctx;
  ctx.window.NostrApp = ctx.NostrApp;
  ctx.window.NostrTools = NT;
  ctx.NostrApp.guestMode = false;
  ctx.NostrApp.hexToBytes = utils && utils.hexToBytes ? utils.hexToBytes : undefined;
  ctx.NostrApp.finalizeEvent = (draft, key) => NT.finalizeEvent(JSON.parse(JSON.stringify(draft)), key);
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'sos-crypto-signer.js'), 'utf8'), ctx, { filename: 'sos-crypto-signer.js' });
  vm.runInNewContext(sec, ctx, { filename: 'chat-p2p-secure-v2.js' });
  return ctx;
}

const desk = boot();
desk.NostrApp.publicKey = accountPk;
desk.NostrApp.getAccountSession = () => ({
  role: 'LINKED_DEVICE',
  verified: true,
  deviceSignPub: devicePk,
  accountP: accountPk,
});
desk.window.SosWebLinkedDevices = {
  withLinkedDeviceSigner(fn) {
    return fn({ privHex: deviceHex, pub: devicePk, accountP: accountPk, deviceId: 'desk', authorization: { ok: true } });
  },
};
const D = desk.NostrApp.P2pSecureV2;
record('linked desktop is secure without root signer', D.isLocalSecureP2pV2() === true && desk.NostrApp.SosCryptoSigner.hasIdentityKey() !== true);
record('desktop endpoint is the device key', D.sameAccountPrimary(accountPk) === true);

const offer = {
  fileId: 'f-desktop-1',
  name: 'voice.webm',
  size: 107522,
  mimeType: 'audio/webm',
  keyStr: 'a'.repeat(44),
  totalChunks: 2,
  sha256: 'ab'.repeat(32),
  selfConversation: true,
};
const wire = await D.encryptFileOfferForDc(accountPk, offer);
record('desktop offer type', wire && wire.type === 'p2p-secure-file-offer');

const phone = boot();
phone.NostrApp.publicKey = accountPk;
phone.NostrApp.privateKey = accountHex;
const P = phone.NostrApp.P2pSecureV2;
const opened = await P.decryptFileOfferFromDc(devicePk, wire);
record('phone decrypts device offer', opened && opened.fileId === 'f-desktop-1' && opened.size === 107522 && opened.selfConversation === true && opened.sha256 === offer.sha256);

let replay = false;
try { await P.decryptFileOfferFromDc(devicePk, wire); } catch (e) { replay = e && e.code === 'REPLAY'; }
record('replayed offer rejected', replay);

const tampered = JSON.parse(JSON.stringify(wire));
tampered.envelope.ct = tampered.envelope.ct.slice(0, -4) + 'ffff';
let bad = false;
try { await P.decryptFileOfferFromDc(devicePk, tampered); } catch (_e) { bad = true; }
record('tampered offer rejected', bad);

phone.NostrApp.publicKey = accountPk;
phone.NostrApp.privateKey = accountHex;
const back = await P.encryptFileOfferForDc(devicePk, { ...offer, fileId: 'f-phone-1', selfConversation: true });
const backOpen = await D.decryptFileOfferFromDc(accountPk, back);
record('desktop decrypts primary offer', backOpen && backOpen.fileId === 'f-phone-1' && backOpen.selfConversation === true);

desk.NostrApp.getAccountSession = () => ({ role: 'LINKED_DEVICE', verified: false, deviceSignPub: devicePk, accountP: accountPk });
record('unverified desktop cannot seal', D.isLocalSecureP2pV2() === false);

desk.NostrApp.getAccountSession = () => ({ role: 'LINKED_DEVICE', verified: true, deviceSignPub: devicePk, accountP: accountPk });
desk.window.SosWebLinkedDevices.withLinkedDeviceSigner = (fn) => fn({ privHex: deviceHex, pub: accountPk, accountP: accountPk });
let wrongDevice = false;
try { await D.encryptFileOfferForDc(accountPk, { ...offer, fileId: 'f-bad' }); } catch (e) { wrongDevice = e && e.code === 'ENCRYPT_FAILURE'; }
record('wrong device binding rejected', wrongDevice);

console.log('STATUS=' + (fail ? 'FAIL' : 'PASS_DESKTOP_FILE_OFFER'));
console.log('TOTAL ' + (pass + fail) + ' PASS ' + pass + ' FAIL ' + fail);
process.exit(fail ? 1 : 0);
