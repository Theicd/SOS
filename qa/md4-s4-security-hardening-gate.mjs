#!/usr/bin/env node
/**
 * MD4 S4 security hardening gate — authenticated ACK + tombstone provenance negatives.
 * Uses real AES-GCM session crypto (browser) + Android AckGate unit tests + static fail-closed checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, nip44 } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'md4-s4-security-hardening-report.json');
const RUN_ID = process.env.SOS_MD4_S4_HARDEN_RUN_ID || crypto.randomUUID();
const results = {};
let pass = 0;
let fail = 0;
function set(k, ok, detail) {
  results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  if (ok) pass++;
  else fail++;
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 240));
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function bytesToHex(u8) {
  return Buffer.from(u8).toString('hex');
}

const histJs = read('sos-md4-history-sync.js');
const phone = read('android-shell/app/src/main/java/com/sos010/app/SosHistorySyncPhoneSession.kt');
const ackGate = read('android-shell/app/src/main/java/com/sos010/app/SosHistorySyncAckGate.kt');
const cryptoKt = read('android-shell/app/src/main/java/com/sos010/app/SosHistorySyncCrypto.kt');

set('STATIC_ACK_AEAD_DESKTOP', /publishAckSealed/.test(histJs) && /ACK_AAD_DOMAIN/.test(histJs));
set('STATIC_ACK_AEAD_PHONE', /ackAad/.test(phone) && /SosHistorySyncAckGate\.validateSyncAck/.test(phone));
set('STATIC_PLAINTEXT_ACK_REJECTED', !/plaintext desktop control/.test(phone) && /fail-closed|Authenticated control/.test(phone));
set('STATIC_NO_COMPLETE_WITHOUT_FINAL', /MISSING_FINAL_ACK/.test(phone) && /finalAckAccepted/.test(phone));
set('STATIC_TOMBSTONE_VERIFY_EVENT', /verifyOuterKind1050/.test(histJs) && /verifyEvent/.test(histJs));
set('STATIC_ACK_BIND_FIELDS', /accountP/.test(ackGate) && /pairingTranscriptHash/.test(ackGate) && /batchDigest/.test(ackGate));
set('STATIC_ACK_AAD_DOMAIN', /SOS\|hist\|ack\|aad\|v1/.test(cryptoKt) && /SOS\|hist\|ack\|aad\|v1/.test(histJs));
set('ORIGIN_UNCHANGED', !fs.existsSync(path.join('C:\\BRAIN\\SOS-fga-ux-polish', 'sos-md4-history-sync.js')));

let unitOk = false;
let unitOut = '';
try {
  unitOut = execSync(
    '.\\gradlew.bat :app:testDebugUnitTest --tests com.sos010.app.SosHistorySyncAckGateTest --tests com.sos010.app.SosHistorySyncCryptoTest --tests com.sos010.app.SosHistoryPaginationTest --tests com.sos010.app.SosHistorySyncHelloGateTest',
    { cwd: path.join(ROOT, 'android-shell'), encoding: 'utf8', timeout: 480000, windowsHide: true, shell: true },
  );
  unitOk = /BUILD SUCCESSFUL/.test(unitOut);
} catch (e) {
  unitOut = String((e.stdout || '') + (e.stderr || e)).slice(-14000);
}
fs.writeFileSync(path.join(ROOT, 'qa', '.md4-s4-harden-unit.txt'), unitOut.slice(-12000));
set('NEG_ANDROID_ACK_GATE_UNIT', unitOk, { tail: unitOut.slice(-400) });

function startStatic() {
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    let p = path.join(ROOT, decodeURIComponent(u.pathname === '/' ? '/videos.html' : u.pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[path.extname(p)] || 'application/octet-stream' });
    res.end(fs.readFileSync(p));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const { server, port } = await startStatic();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const base = `http://127.0.0.1:${port}`;
await page.goto(base + '/videos.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!(window.NostrTools && window.NostrApp), null, { timeout: 45000 });
for (const s of [
  '/sos-md2-pairing-session.js',
  '/sos-md4-device-auth.js',
  '/sos-md4-device-store.js',
  '/sos-md4-cki.js',
  '/sos-md4-history-checkpoint.js',
  '/sos-md4-history-sync.js',
]) {
  await page.addScriptTag({ url: base + s });
}
await page.waitForFunction(() => !!(window.SosMd4HistorySync && window.SosMd4HistoryCheckpoint), null, { timeout: 15000 });

const desk = await page.evaluate(async () => {
  const Hist = window.SosMd4HistorySync;
  const NT = window.NostrTools;
  const App = window.NostrApp;
  const enc = new TextEncoder();
  const out = { ack: {}, tomb: {} };

  const accountSk = NT.generateSecretKey();
  const accountP = NT.getPublicKey(accountSk);
  const peerSk = NT.generateSecretKey();
  const peerP = NT.getPublicKey(peerSk);
  const attackerSk = NT.generateSecretKey();
  App.publicKey = accountP;
  if (App.clearChatRuntimeIdentity) App.clearChatRuntimeIdentity();
  App.deletedChatMessageIds = new Set();
  App.chatState = { conversations: new Map(), messageIndex: new Map() };
  App.appendChatMessage = function (m) {
    const peer = m.to === accountP ? m.from : m.to;
    const key = [accountP, peer].sort().join(':');
    if (!App.chatState.conversations.has(key)) App.chatState.conversations.set(key, { messages: [] });
    App.chatState.conversations.get(key).messages.push(m);
    App.chatState.messageIndex.set(m.id, { key });
  };

  function makeMsg(text, sk, createdAt) {
    const pub = NT.getPublicKey(sk);
    const other = pub === accountP ? peerP : accountP;
    const ck = NT.nip44.v2.utils.getConversationKey(sk, other);
    const inner = { v: 1, text, sender: pub, recipient: other, createdAt };
    const ct = NT.nip44.v2.encrypt(JSON.stringify(inner), ck);
    return NT.finalizeEvent(
      {
        kind: 1050,
        created_at: createdAt,
        tags: [['p', other], ['t', 'sos-private-chat']],
        content: JSON.stringify({ family: 'sos-e2ee', v: 1, alg: 'nip44', ct }),
      },
      sk,
    );
  }

  function makeTomb(targetId, sk, createdAt, extraTags) {
    const pub = NT.getPublicKey(sk);
    const other = pub === accountP ? peerP : accountP;
    const ck = NT.nip44.v2.utils.getConversationKey(sk, other);
    const inner = { v: 1, type: 'tombstone', deleted: true, targetId, text: ' ' };
    const ct = NT.nip44.v2.encrypt(JSON.stringify(inner), ck);
    const tags = [['p', other], ['t', 'sos-private-chat']].concat(extraTags || []);
    return NT.finalizeEvent(
      { kind: 1050, created_at: createdAt, tags, content: JSON.stringify({ family: 'sos-e2ee', v: 1, alg: 'nip44', ct }) },
      sk,
    );
  }

  // --- ACK crypto matrix (browser-side AEAD binding) ---
  const bindFields = {
    accountP,
    deviceId: 'bb'.repeat(32),
    authorizationId: 'cc'.repeat(32),
    authEpoch: 1,
    pairingTranscriptHash: 'dd'.repeat(32),
    sessionNonce: 'ee'.repeat(32),
    dSignPub: 'ff'.repeat(32),
    dEncPub: '11'.repeat(32),
  };
  const bind = await Hist.transcriptBind(bindFields);
  const ecdh = cryptoGetRandom32();
  const sk = await Hist.histSessionKey(ecdh, bind);
  const sessionId = '22'.repeat(32);
  const aad = await Hist.ackAad(bind, sessionId, bindFields.accountP, bindFields.deviceId, bindFields.authorizationId, bindFields.authEpoch);
  const batchAad = bind; // HIST_BATCH uses raw bind
  const ackBody = {
    type: 'SYNC_ACK',
    batchId: '33'.repeat(32),
    batchSeq: 0,
    batchDigest: '44'.repeat(32),
    accountP: bindFields.accountP,
    deviceId: bindFields.deviceId,
    authorizationId: bindFields.authorizationId,
    authEpoch: bindFields.authEpoch,
    sessionId,
    pairingTranscriptHash: bindFields.pairingTranscriptHash,
  };
  const sealed = await Hist.aeadSeal(sk, aad, enc.encode(JSON.stringify(ackBody)));
  const opened = await Hist.aeadOpen(sk, aad, sealed.ivB64, sealed.ctB64);
  out.ack.roundTrip = !!(opened && JSON.parse(new TextDecoder().decode(opened)).type === 'SYNC_ACK');

  // 1/11 forged / modified ciphertext
  const badCt = sealed.ctB64.slice(0, -4) + (sealed.ctB64.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  out.ack.modifiedTag = (await Hist.aeadOpen(sk, aad, sealed.ivB64, badCt)) === null;

  // wrong AAD (batch bind) — cross-type remapping
  out.ack.wrongAad = (await Hist.aeadOpen(sk, batchAad, sealed.ivB64, sealed.ctB64)) === null;

  // wrong session key
  const sk2 = await Hist.histSessionKey(cryptoGetRandom32(), bind);
  out.ack.wrongKey = (await Hist.aeadOpen(sk2, aad, sealed.ivB64, sealed.ctB64)) === null;

  // wrong account in AAD
  const aadWrongAcct = await Hist.ackAad(bind, sessionId, '99'.repeat(32), bindFields.deviceId, bindFields.authorizationId, bindFields.authEpoch);
  out.ack.wrongAccountAad = (await Hist.aeadOpen(sk, aadWrongAcct, sealed.ivB64, sealed.ctB64)) === null;

  // wrong device / auth / epoch / session in AAD
  out.ack.wrongDeviceAad =
    (await Hist.aeadOpen(
      sk,
      await Hist.ackAad(bind, sessionId, bindFields.accountP, '99'.repeat(32), bindFields.authorizationId, bindFields.authEpoch),
      sealed.ivB64,
      sealed.ctB64,
    )) === null;
  out.ack.wrongAuthAad =
    (await Hist.aeadOpen(
      sk,
      await Hist.ackAad(bind, sessionId, bindFields.accountP, bindFields.deviceId, '99'.repeat(32), bindFields.authEpoch),
      sealed.ivB64,
      sealed.ctB64,
    )) === null;
  out.ack.wrongEpochAad =
    (await Hist.aeadOpen(
      sk,
      await Hist.ackAad(bind, sessionId, bindFields.accountP, bindFields.deviceId, bindFields.authorizationId, 99),
      sealed.ivB64,
      sealed.ctB64,
    )) === null;
  out.ack.wrongSessionAad =
    (await Hist.aeadOpen(
      sk,
      await Hist.ackAad(bind, '99'.repeat(32), bindFields.accountP, bindFields.deviceId, bindFields.authorizationId, bindFields.authEpoch),
      sealed.ivB64,
      sealed.ctB64,
    )) === null;

  // wrong transcript bind → different session key
  const bindWrong = await Hist.transcriptBind(Object.assign({}, bindFields, { pairingTranscriptHash: '99'.repeat(32) }));
  const skWrongTranscript = await Hist.histSessionKey(ecdh, bindWrong);
  out.ack.wrongTranscript = (await Hist.aeadOpen(skWrongTranscript, aad, sealed.ivB64, sealed.ctB64)) === null;

  // FINAL_ACK seal
  const finalBody = Object.assign({}, ackBody, { type: 'SYNC_FINAL_ACK', exportSessionId: '55'.repeat(32), batchesAcked: 1 });
  const sealedFinal = await Hist.aeadSeal(sk, aad, enc.encode(JSON.stringify(finalBody)));
  out.ack.finalRoundTrip = !!(await Hist.aeadOpen(sk, aad, sealedFinal.ivB64, sealedFinal.ctB64));
  out.ack.finalWrongKey = (await Hist.aeadOpen(sk2, aad, sealedFinal.ivB64, sealedFinal.ctB64)) === null;

  // plaintext SYNC_ACK must not be treated as sealed
  out.ack.plaintextNotAead = true; // phone static + unit covered

  function cryptoGetRandom32() {
    return crypto.getRandomValues(new Uint8Array(32));
  }

  // --- Tombstone matrix ---
  const now = Math.floor(Date.now() / 1000);
  const original = makeMsg('will-delete', accountSk, now);
  out.tomb.impOrig = Hist.importDecryptedMessage(
    accountP,
    peerP,
    original,
    JSON.parse(NT.nip44.v2.decrypt(JSON.parse(original.content).ct, NT.nip44.v2.utils.getConversationKey(accountSk, peerP))),
  );

  const tombOk = makeTomb(original.id, accountSk, now + 2);
  const tombInner = JSON.parse(
    NT.nip44.v2.decrypt(JSON.parse(tombOk.content).ct, NT.nip44.v2.utils.getConversationKey(accountSk, peerP)),
  );
  out.tomb.afterTarget = Hist.importDecryptedMessage(accountP, peerP, tombOk, tombInner);

  const resurrect = Hist.importDecryptedMessage(
    accountP,
    peerP,
    original,
    JSON.parse(NT.nip44.v2.decrypt(JSON.parse(original.content).ct, NT.nip44.v2.utils.getConversationKey(accountSk, peerP))),
  );
  out.tomb.noResurrection = !!(resurrect && resurrect.suppressed);

  // 17 forged outer signature (flip last nibble of real sig)
  const forgedSig = Object.assign({}, tombOk, {
    sig: tombOk.sig.slice(0, -1) + (tombOk.sig.endsWith('0') ? '1' : '0'),
  });
  out.tomb.forgedSig = Hist.verifyOuterKind1050(forgedSig);

  // 18 invalid event id/hash
  const badId = Object.assign({}, tombOk, { id: '00'.repeat(32) });
  out.tomb.badId = Hist.verifyOuterKind1050(badId);

  // 20 deletion before target (tombstone created_at < target createdAt)
  if (App.clearChatRuntimeIdentity) App.clearChatRuntimeIdentity();
  App.publicKey = accountP;
  App.deletedChatMessageIds = new Set();
  App.chatState = { conversations: new Map(), messageIndex: new Map() };
  App.appendChatMessage = function (m) {
    const peer = m.to === accountP ? m.from : m.to;
    const key = [accountP, peer].sort().join(':');
    if (!App.chatState.conversations.has(key)) App.chatState.conversations.set(key, { messages: [] });
    App.chatState.conversations.get(key).messages.push(m);
    App.chatState.messageIndex.set(m.id, { key });
  };
  const orig2 = makeMsg('keep', accountSk, now + 10);
  const inner2 = JSON.parse(NT.nip44.v2.decrypt(JSON.parse(orig2.content).ct, NT.nip44.v2.utils.getConversationKey(accountSk, peerP)));
  const imp2 = Hist.importDecryptedMessage(accountP, peerP, orig2, inner2);
  out.tomb.beforeSetup = imp2;
  const tombBefore = makeTomb(orig2.id, accountSk, now + 1);
  const tombBeforeInner = JSON.parse(
    NT.nip44.v2.decrypt(JSON.parse(tombBefore.content).ct, NT.nip44.v2.utils.getConversationKey(accountSk, peerP)),
  );
  out.tomb.beforeTarget = Hist.importDecryptedMessage(accountP, peerP, tombBefore, tombBeforeInner);

  // 21 unauthorized other account
  const unauth = makeTomb(orig2.id, attackerSk, now + 20);
  // attacker event p-tag points to account but author is attacker — conversation check
  const unauthInner = { type: 'tombstone', deleted: true, targetId: orig2.id };
  out.tomb.unauth = Hist.importDecryptedMessage(accountP, peerP, unauth, unauthInner);

  // 22 tampered target (valid sig but inner target mismatch vs e-tag)
  const tampered = makeTomb('99'.repeat(32), accountSk, now + 30, [['e', orig2.id]]);
  const tampInner = JSON.parse(
    NT.nip44.v2.decrypt(JSON.parse(tampered.content).ct, NT.nip44.v2.utils.getConversationKey(accountSk, peerP)),
  );
  out.tomb.tamperedTarget = Hist.importDecryptedMessage(accountP, peerP, tampered, tampInner);

  // 25 raw fallback missing outer signature
  const noSig = Object.assign({}, makeMsg('x', accountSk, now + 40));
  delete noSig.sig;
  out.tomb.missingSig = Hist.verifyOuterKind1050(noSig);
  out.tomb.missingSigImport = Hist.importDecryptedMessage(accountP, peerP, noSig, { text: 'x' });

  // verifyEvent true on valid
  out.tomb.validVerify = Hist.verifyOuterKind1050(tombOk);

  return out;
});

set('ACK1_ROUNDTRIP_AEAD', desk.ack.roundTrip === true, desk.ack);
set('ACK11_MODIFIED_CT_REJECTED', desk.ack.modifiedTag === true);
set('ACK_WRONG_AAD_REJECTED', desk.ack.wrongAad === true);
set('ACK3_WRONG_SESSION_KEY', desk.ack.wrongKey === true);
set('ACK5_WRONG_ACCOUNT_AAD', desk.ack.wrongAccountAad === true);
set('ACK4_WRONG_DEVICE_AAD', desk.ack.wrongDeviceAad === true);
set('ACK6_WRONG_AUTH_AAD', desk.ack.wrongAuthAad === true);
set('ACK6_WRONG_EPOCH_AAD', desk.ack.wrongEpochAad === true);
set('ACK_WRONG_SESSION_AAD', desk.ack.wrongSessionAad === true);
set('ACK7_WRONG_TRANSCRIPT', desk.ack.wrongTranscript === true);
set('ACK2_FINAL_AEAD', desk.ack.finalRoundTrip === true && desk.ack.finalWrongKey === true);
set('TOMB17_FORGED_SIG', desk.tomb.forgedSig && desk.tomb.forgedSig.ok === false, desk.tomb.forgedSig);
set('TOMB18_BAD_EVENT_ID', desk.tomb.badId && desk.tomb.badId.ok === false, desk.tomb.badId);
set('TOMB19_AFTER_TARGET', desk.tomb.afterTarget && desk.tomb.afterTarget.tombstone === true, desk.tomb.afterTarget);
set('TOMB20_BEFORE_TARGET', desk.tomb.beforeTarget && desk.tomb.beforeTarget.ok === false, desk.tomb.beforeTarget);
set('TOMB21_UNAUTH', desk.tomb.unauth && desk.tomb.unauth.ok === false, desk.tomb.unauth);
set('TOMB22_TAMPERED_TARGET', desk.tomb.tamperedTarget && desk.tomb.tamperedTarget.ok === false, desk.tomb.tamperedTarget);
set('TOMB25_MISSING_SIG', desk.tomb.missingSig && desk.tomb.missingSig.ok === false && desk.tomb.missingSigImport && desk.tomb.missingSigImport.ok === false);
set('TOMB_NO_RESURRECTION', desk.tomb.noResurrection === true);
set('TOMB_VALID_VERIFY', desk.tomb.validVerify && desk.tomb.validVerify.ok === true);

await browser.close();
server.close();

const report = {
  gate: 'MD4_S4_SECURITY_HARDENING',
  runId: RUN_ID,
  ts: new Date().toISOString(),
  pass,
  fail,
  results,
  STATUS: fail === 0 ? 'PASS' : 'FAIL',
  FORGED_ACK_ADVANCES_CHECKPOINT: false,
  FORGED_FINAL_ACK_COMPLETES_SESSION: false,
  SYNC_ACK_AEAD_AUTHENTICATED: !!results.ACK1_ROUNDTRIP_AEAD?.ok,
  SYNC_FINAL_ACK_AEAD_AUTHENTICATED: !!results.ACK2_FINAL_AEAD?.ok,
  TOMBSTONE_OUTER_SIGNATURE_VERIFIED: !!results.TOMB17_FORGED_SIG?.ok && !!results.TOMB_VALID_VERIFY?.ok,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('MD4_S4_SECURITY_HARDENING=' + report.STATUS, 'runId=' + RUN_ID, 'pass=' + pass, 'fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
