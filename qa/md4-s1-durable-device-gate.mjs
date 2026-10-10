#!/usr/bin/env node
/**
 * MD4 S1 durable device identity + verifyStrict + kind 25060 isolation gate.
 * Run from recon: node qa/md4-s1-durable-device-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';
import { schnorr } from '@noble/curves/secp256k1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'md4-s1-durable-device-report.json');
const RUN_ID = process.env.SOS_MD4_S1_RUN_ID || crypto.randomUUID();

const results = {};
let pass = 0;
let fail = 0;
function set(k, ok, detail) {
  results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  if (ok) pass++;
  else fail++;
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 220));
}

function hex(buf) {
  return Buffer.from(buf).toString('hex');
}
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function canonicalBytes(auth) {
  const caps = (auth.capabilities || []).slice().sort().join(',');
  const lines = [
    'SOS_DEVICE_AUTHORIZATION_V1',
    'version=' + auth.version,
    'authorizationId=' + auth.authorizationId,
    'accountP=' + auth.accountP,
    'deviceId=' + auth.deviceId,
    'D_sign_pub=' + auth.D_sign_pub,
    'D_enc_pub=' + auth.D_enc_pub,
    'capabilities=' + caps,
    'authEpoch=' + auth.authEpoch,
    'createdAt=' + auth.createdAt,
    'expiresAt=' + auth.expiresAt,
    'pairingTranscriptHash=' + auth.pairingTranscriptHash,
    'pairingId=' + auth.pairingId,
    'storageSecurityClass=' + (auth.storageSecurityClass || ''),
    'recoveryEligibleAtAuthorization=' + String(!!auth.recoveryEligibleAtAuthorization),
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

function signAuth(rootSk, auth) {
  const msg = sha256(canonicalBytes(auth));
  const sig = schnorr.sign(msg, rootSk);
  return Object.assign({}, auth, { rootSignature: hex(sig) });
}

const NORMAL_CAPS = [
  'DEVICE_CHAT',
  'DEVICE_CALLS',
  'DEVICE_P2P',
  'DEVICE_FILES',
  'DEVICE_RECEIPTS',
  'DEVICE_PRESENCE',
  'DEVICE_SETTINGS',
  'DEVICE_HISTORY_SYNC',
];

function makeAuth(rootSk, over = {}) {
  const accountP = getPublicKey(rootSk);
  const base = {
    version: 'sos-device-authorization-v1',
    authorizationId: hex(crypto.randomBytes(32)),
    accountP,
    deviceId: hex(crypto.randomBytes(32)),
    D_sign_pub: hex(crypto.randomBytes(32)),
    D_enc_pub: hex(crypto.randomBytes(32)),
    capabilities: NORMAL_CAPS.slice(),
    authEpoch: 1,
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 86400000,
    pairingTranscriptHash: hex(crypto.randomBytes(32)),
    pairingId: hex(crypto.randomBytes(32)),
    storageSecurityClass: 'SOFTWARE_ONLY',
    recoveryEligibleAtAuthorization: false,
    deviceLabel: 'test',
    deviceType: 'DESKTOP',
  };
  return signAuth(rootSk, Object.assign(base, over));
}

async function main() {
  const report = {
    gate: 'MD4_S1_DURABLE_DEVICE',
    runId: RUN_ID,
    startedAt: Date.now(),
    completed: false,
    status: 'FAIL',
    results: {},
  };

  // File presence
  for (const rel of [
    'sos-md4-device-auth.js',
    'sos-md4-device-store.js',
    'sos-web-linked-devices.js',
    'sos-md2-pairing-session.js',
    'docs/security/MD4_HISTORY_SYNC_S0.md',
    'docs/security/MD4_S1_DEFINITION_OF_DONE.md',
  ]) {
    set('file:' + rel, fs.existsSync(path.join(ROOT, rel)));
  }
  const html = fs.readFileSync(path.join(ROOT, 'videos.html'), 'utf8');
  set('VIDEOS_LOADS_MD4_MODULES', /sos-md4-device-auth\.js/.test(html) && /sos-md4-device-store\.js/.test(html));
  set(
    'NO_HISTORY_TRANSFER_IN_S1',
    !/ConversationKeyIndex|KEY_INDEX_SEALED|HIST_BATCH/.test(
      fs.readFileSync(path.join(ROOT, 'sos-md4-device-auth.js'), 'utf8') +
        fs.readFileSync(path.join(ROOT, 'sos-md4-device-store.js'), 'utf8'),
    ),
  );

  // Secure context required for crypto.subtle + IndexedDB isolation tests
  const server = http.createServer((req, res) => {
    const url = String(req.url || '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>md4-s1</title></head><body>ok</body></html>');
      return;
    }
    const rel = url.replace(/^\//, '').replace(/\.\./g, '');
    const fp = path.join(ROOT, rel);
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    const ext = path.extname(fp);
    const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.exposeFunction('__sosSchnorrSignHex', async (msgHex, skHex) => {
    const msg = Buffer.from(String(msgHex), 'hex');
    const sk = Buffer.from(String(skHex), 'hex');
    return Buffer.from(schnorr.sign(msg, sk)).toString('hex');
  });
  await page.exposeFunction('__sosSchnorrVerifyHex', async (sigHex, msgHex, pubHex) => {
    try {
      return schnorr.verify(Buffer.from(String(sigHex), 'hex'), Buffer.from(String(msgHex), 'hex'), Buffer.from(String(pubHex), 'hex'));
    } catch (_e) {
      return false;
    }
  });

  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/nostr-tools@2.7.2/lib/nostr.bundle.min.js' });
  await page.waitForFunction(() => !!(window.NostrTools && window.NostrTools.generateSecretKey && window.crypto && window.crypto.subtle), null, {
    timeout: 30000,
  });
  await page.addScriptTag({ url: base + '/sos-md2-pairing-session.js' });
  await page.addScriptTag({ url: base + '/sos-md4-device-auth.js' });
  await page.addScriptTag({ url: base + '/sos-md4-device-store.js' });
  await page.waitForFunction(() => !!(window.SosMd4DeviceAuth && window.SosMd4DeviceStore && window.SosMd2PairingSession), null, {
    timeout: 10000,
  });

  const dSignSk = generateSecretKey();
  const dSignPub = getPublicKey(dSignSk);
  const dEncPriv = crypto.randomBytes(32);
  const dEncPub = hex(dEncPriv);
  const deviceId = hex(crypto.randomBytes(32));

  // Sign inside the browser with the same verifySchnorrRaw stack (avoid Node/browser schnorr drift).
  const signed = await page.evaluate(
    async ({ deviceId, dSignPub, dEncPub, caps }) => {
      const NT = window.NostrTools;
      const rootSk = NT.generateSecretKey();
      const accountP = NT.getPublicKey(rootSk);
      const auth = {
        version: 'sos-device-authorization-v1',
        authorizationId: Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, '0')).join(''),
        accountP,
        deviceId,
        D_sign_pub: dSignPub,
        D_enc_pub: dEncPub,
        capabilities: caps,
        authEpoch: 1,
        createdAt: Date.now() - 1000,
        expiresAt: Date.now() + 86400000,
        pairingTranscriptHash: Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) =>
          x.toString(16).padStart(2, '0'),
        ).join(''),
        pairingId: Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, '0')).join(''),
        storageSecurityClass: 'SOFTWARE_ONLY',
        recoveryEligibleAtAuthorization: false,
        deviceLabel: 'test',
        deviceType: 'DESKTOP',
      };
      const A = window.SosMd4DeviceAuth;
      const msg = await A.messageHash(auth);
      const Md2 = window.SosMd2PairingSession;
      const sig = await Md2.signSchnorrRaw(msg, rootSk);
      auth.rootSignature = sig;
      return { auth, accountP, rootSkHex: Array.from(rootSk, (x) => x.toString(16).padStart(2, '0')).join('') };
    },
    { deviceId, dSignPub, dEncPub, caps: NORMAL_CAPS },
  );
  const auth = signed.auth;
  const accountP = signed.accountP;

  // --- verifyStrict negatives ---
  const neg = await page.evaluate(
    async ({ auth, accountP, deviceId, dSignPub, dEncPub }) => {
      const A = window.SosMd4DeviceAuth;
      const out = {};
      const local = { accountP, deviceId, D_sign_pub: dSignPub, D_enc_pub: dEncPub };
      out.good = await A.verifyForDestination(auth, local);
      out.badSig = await A.verifyForDestination(Object.assign({}, auth, { rootSignature: '00'.repeat(64) }), local);
      out.wrongAccount = await A.verifyForDestination(auth, Object.assign({}, local, { accountP: '11'.repeat(32) }));
      out.wrongDevice = await A.verifyForDestination(auth, Object.assign({}, local, { deviceId: '22'.repeat(32) }));
      out.wrongDSign = await A.verifyForDestination(auth, Object.assign({}, local, { D_sign_pub: '33'.repeat(32) }));
      out.expired = await A.verifyStrict(Object.assign({}, auth, { expiresAt: auth.createdAt + 1, createdAt: auth.createdAt }), Date.now() + 10);
      const noHist = Object.assign({}, auth, {
        capabilities: (auth.capabilities || []).filter((c) => c !== 'DEVICE_HISTORY_SYNC'),
      });
      // re-sign would be needed for sig — structural check before sig: empty path uses verifyStrict on unsigned? 
      // Strip sig to see MISSING after caps — actually verify checks caps before sig.
      out.missingHist = await A.verifyStrict(Object.assign({}, noHist, { rootSignature: auth.rootSignature }));
      out.admin = await A.verifyStrict(
        Object.assign({}, auth, { capabilities: (auth.capabilities || []).concat(['DEVICE_ADMIN']) }),
      );
      out.epoch = await A.verifyStrict(auth, Date.now(), { minAcceptedAuthEpoch: 9 });
      out.revoked = await A.verifyStrict(Object.assign({}, auth, { status: 'REVOKED' }));
      out.presenceOnly = await A.verifyStrict(Object.assign({}, auth, { rootSignature: 'deadbeef' }));
      // protocol isolation
      out.pairOk = A.assertMd2MayAcceptEvent({ tags: [['t', 'sos-pair-v1'], ['d', 'x']] });
      out.histToMd2 = A.assertMd2MayAcceptEvent({ tags: [['t', 'sos-hist-v1'], ['d', 'x']] });
      out.pairToHist = A.assertHistMayAcceptEvent({ tags: [['t', 'sos-pair-v1']] });
      out.histClass = A.assertHistMayAcceptEvent({ tags: [['t', 'sos-hist-v1']] });
      out.unknown = A.classifyKind25060Tags([['t', 'sos-evil-v1']]);
      out.collision = A.classifyKind25060Tags([
        ['t', 'sos-pair-v1'],
        ['t', 'sos-hist-v1'],
      ]);
      return out;
    },
    { auth, accountP, deviceId, dSignPub, dEncPub },
  );

  set('VERIFY_STRICT_GOOD', neg.good && neg.good.ok === true, neg.good);
  set('NEG_BAD_SIGNATURE', neg.badSig && neg.badSig.ok === false && neg.badSig.code === 'BAD_SIGNATURE', neg.badSig);
  set('NEG_WRONG_ACCOUNT', neg.wrongAccount && neg.wrongAccount.code === 'ACCOUNT_MISMATCH', neg.wrongAccount);
  set('NEG_WRONG_DEVICE', neg.wrongDevice && neg.wrongDevice.code === 'DEVICE_ID_MISMATCH', neg.wrongDevice);
  set('NEG_WRONG_D_SIGN', neg.wrongDSign && neg.wrongDSign.code === 'D_SIGN_MISMATCH', neg.wrongDSign);
  set('NEG_EXPIRED', neg.expired && neg.expired.ok === false, neg.expired);
  set('NEG_MISSING_HISTORY_SYNC', neg.missingHist && neg.missingHist.code === 'MISSING_DEVICE_HISTORY_SYNC', neg.missingHist);
  set('NEG_ADMIN_CAP', neg.admin && neg.admin.code === 'ADMIN_NOT_ALLOWED', neg.admin);
  set('NEG_AUTH_EPOCH', neg.epoch && neg.epoch.code === 'AUTH_EPOCH_MISMATCH', neg.epoch);
  set('NEG_REVOKED', neg.revoked && neg.revoked.code === 'REVOKED', neg.revoked);
  set('NEG_SIG_PRESENCE_INSUFFICIENT', neg.presenceOnly && neg.presenceOnly.ok === false, neg.presenceOnly);
  set('KIND25060_MD2_ACCEPTS_PAIR', neg.pairOk && neg.pairOk.ok === true, neg.pairOk);
  set('KIND25060_MD2_REJECTS_HIST', neg.histToMd2 && neg.histToMd2.ok === false, neg.histToMd2);
  set('KIND25060_HIST_REJECTS_PAIR', neg.pairToHist && neg.pairToHist.ok === false, neg.pairToHist);
  set('KIND25060_HIST_NO_DELIVERY', neg.histClass && neg.histClass.delivery === false, neg.histClass);
  set('KIND25060_UNKNOWN_FAIL_CLOSED', neg.unknown && neg.unknown.ok === false, neg.unknown);
  set('KIND25060_COLLISION_FAIL_CLOSED', neg.collision && neg.collision.ok === false, neg.collision);

  // Canonical mismatch → bad signature
  const mangled = Object.assign({}, auth, { deviceLabel: 'changed-not-in-canonical' });
  // deviceLabel not in canonical — change createdAt without resign
  const canonMismatch = Object.assign({}, auth, { createdAt: auth.createdAt + 1 });
  const canonR = await page.evaluate(async (a) => window.SosMd4DeviceAuth.verifyStrict(a), canonMismatch);
  set('NEG_CANONICAL_MISMATCH', canonR && canonR.ok === false && canonR.code === 'BAD_SIGNATURE', canonR);

  // Durable store persist / restore / account isolation
  const storeR = await page.evaluate(
    async ({ auth, accountP, deviceId, dSignPub, dEncPub, dSignSkHex, dEncPrivHex, accountB }) => {
      const S = window.SosMd4DeviceStore;
      const A = window.SosMd4DeviceAuth;
      const hexToU8 = (h) => {
        const out = new Uint8Array(h.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
        return out;
      };
      const support = S.unsupported();
      const pers = await S.persistLinkedDevice({
        accountP,
        deviceId,
        D_sign_pub: dSignPub,
        D_enc_pub: dEncPub,
        dSignSk: hexToU8(dSignSkHex),
        dEncPriv: hexToU8(dEncPrivHex),
        authorization: auth,
      });
      const loaded = await S.loadAnyForAccount(accountP);
      const scan = await S.plaintextSecretScan(accountP);
      // corrupt
      const dbName = S.DB_NAME;
      await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('devices', 'readwrite');
          const os = tx.objectStore('devices');
          const key = accountP + ':' + deviceId;
          const g = os.get(key);
          g.onsuccess = () => {
            const rec = g.result;
            if (rec && rec.sealedSign) rec.sealedSign.ct = 'aa'.repeat(40);
            os.put(rec);
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
      const corrupt = await S.loadLinkedDevice(accountP, deviceId);
      await S.clearAccount(accountP);
      // isolation: persist A, ensure B empty
      const pers2 = await S.persistLinkedDevice({
        accountP,
        deviceId,
        D_sign_pub: dSignPub,
        D_enc_pub: dEncPub,
        dSignSk: hexToU8(dSignSkHex),
        dEncPriv: hexToU8(dEncPrivHex),
        authorization: auth,
      });
      const other = await S.loadAnyForAccount(accountB);
      const histGate = await A.assertHistorySyncAuthorized({
        authorization: auth,
        device: { deviceId, D_sign_pub: dSignPub, D_enc_pub: dEncPub },
      });
      return { support, pers, loaded, scan, corrupt, pers2, other, histGate, recovery: loaded.RECOVERY_CAPABLE };
    },
    {
      auth,
      accountP,
      deviceId,
      dSignPub,
      dEncPub,
      dSignSkHex: bytesToHex(dSignSk),
      dEncPrivHex: hex(dEncPriv),
      accountB: hex(crypto.randomBytes(32)),
    },
  );

  set('UNSUPPORTED_BROWSER_API', storeR.support && storeR.support.ok === true, storeR.support);
  set('DURABLE_PERSIST', storeR.pers && storeR.pers.ok === true, storeR.pers);
  set(
    'RESTART_RESTORE',
    storeR.loaded &&
      storeR.loaded.ok === true &&
      storeR.loaded.deviceId === deviceId &&
      storeR.loaded.accountP === accountP &&
      storeR.loaded.D_sign_pub === dSignPub,
    { deviceId: storeR.loaded && storeR.loaded.deviceId, accountP: storeR.loaded && storeR.loaded.accountP },
  );
  set('SCHNORR_ON_RESTORE', storeR.loaded && storeR.loaded.ok === true, storeR.loaded && storeR.loaded.code);
  set('PLAINTEXT_SECRET_SCAN_CLEAN', storeR.scan && storeR.scan.ok === true, storeR.scan);
  set('CORRUPT_IDB_FAIL_CLOSED', storeR.corrupt && storeR.corrupt.ok === false, storeR.corrupt);
  set('ACCOUNT_SWITCH_ISOLATION', storeR.other && storeR.other.ok === false && storeR.other.code === 'NOT_FOUND', storeR.other);
  set('RECOVERY_CAPABLE_FALSE', storeR.recovery === false, { recovery: storeR.recovery });
  set('HISTORY_SYNC_GATE', storeR.histGate && storeR.histGate.ok === true, storeR.histGate);

  // localStorage must not hold priv hex from our modules' DEVICE_KEY pattern
  const lsScan = await page.evaluate(() => {
    const blob = JSON.stringify(localStorage);
    return {
      nsec: /\bnsec1[a-z0-9]+\b/i.test(blob),
      privField: /d_sign_priv|dEncPrivHex|dSignSkHex/i.test(blob),
    };
  });
  set('LOCALSTORAGE_NO_PRIV', !lsScan.nsec && !lsScan.privField, lsScan);

  await browser.close();
  await new Promise((r) => server.close(r));

  report.results = results;
  report.pass = pass;
  report.fail = fail;
  report.failedKeys = Object.keys(results).filter((k) => !results[k].ok);
  report.status = fail === 0 ? 'PASS' : 'FAIL';
  report.completed = true;
  report.completedAt = Date.now();
  report.runId = RUN_ID;
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('RESULT', report.status, 'passed', pass, 'failed', report.failedKeys.join(','), 'runId', RUN_ID);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
