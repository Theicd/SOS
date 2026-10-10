#!/usr/bin/env node
/**
 * MD4 S2 ConversationKeyIndex gate — desktop open + security negatives + Android fixture.
 * Run from recon: node qa/md4-s2-cki-gate.mjs
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
const OUT = path.join(ROOT, 'qa', 'md4-s2-cki-report.json');
const FIXTURE = path.join(ROOT, 'qa', '.md4-s2-fixtures', 'android-sealed-cki.json');
const RUN_ID = process.env.SOS_MD4_S2_RUN_ID || crypto.randomUUID();
const STARTED = new Date().toISOString();

const results = {};
let pass = 0;
let fail = 0;
function set(k, ok, detail) {
  results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  if (ok) pass++;
  else fail++;
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 240));
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
    deviceLabel: 's2',
    deviceType: 'DESKTOP',
  };
  return signAuth(rootSk, Object.assign(base, over));
}

function startStaticServer() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/videos.html';
    const file = path.join(ROOT, p.replace(/^\//, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    const ext = path.extname(file);
    const types = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  // Static inventory
  const files = [
    'sos-md4-cki.js',
    'sos-md4-device-auth.js',
    'sos-md4-device-store.js',
    'android-shell/app/src/main/java/com/sos010/app/SosConversationKeyIndex.kt',
    'android-shell/app/src/main/java/com/sos010/app/SosHistorySyncExporter.kt',
  ];
  for (const f of files) {
    set('FILE_' + f.replace(/[\\/]/g, '_'), fs.existsSync(path.join(ROOT, f)));
  }
  const html = fs.readFileSync(path.join(ROOT, 'videos.html'), 'utf8');
  set('VIDEOS_LOADS_CKI', /sos-md4-cki\.js/.test(html));
  const ckiSrc = fs.readFileSync(path.join(ROOT, 'sos-md4-cki.js'), 'utf8');
  const expSrc = fs.readFileSync(
    path.join(ROOT, 'android-shell/app/src/main/java/com/sos010/app/SosHistorySyncExporter.kt'),
    'utf8',
  );
  const bridgeSrc = fs.readFileSync(
    path.join(ROOT, 'android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt'),
    'utf8',
  );
  set('NO_GENERIC_ROOT_DERIVE_API', !/deriveAnyKey|exportRootK|getNsec|conversationKeyFromRoot/.test(ckiSrc + expSrc));
  set('BRIDGE_SEALED_ONLY', /exportConversationKeyIndexSealed/.test(bridgeSrc) && !/exportRoot|getNsec/.test(
    bridgeSrc.match(/exportConversationKeyIndexSealed[\s\S]{0,800}/)?.[0] || '',
  ));
  set('NO_CHAT_IMPORT_IN_S2', !/importChatHistory|HIST_BATCH|bootstrapHistory/.test(ckiSrc + expSrc));

  const { server, port } = await startStaticServer();
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleHits = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (/conversationKey|nsec1|rootK|privateKey/i.test(t)) consoleHits.push(t.slice(0, 120));
  });

  await page.exposeFunction('__sosSchnorrSignHex', async (msgHex, skHex) => {
    const msg = Buffer.from(String(msgHex), 'hex');
    const sk = Buffer.from(String(skHex), 'hex');
    return Buffer.from(schnorr.sign(msg, sk)).toString('hex');
  });
  await page.exposeFunction('__sosSchnorrVerifyHex', async (sigHex, msgHex, pubHex) => {
    try {
      return schnorr.verify(
        Buffer.from(String(sigHex), 'hex'),
        Buffer.from(String(msgHex), 'hex'),
        Buffer.from(String(pubHex), 'hex'),
      );
    } catch (_e) {
      return false;
    }
  });

  await page.goto(base + '/videos.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/nostr-tools@2.7.2/lib/nostr.bundle.min.js' });
  await page.waitForFunction(
    () => !!(window.NostrTools && window.NostrTools.generateSecretKey && window.crypto && window.crypto.subtle),
    null,
    { timeout: 30000 },
  );
  await page.addScriptTag({ url: base + '/sos-md2-pairing-session.js' });
  await page.addScriptTag({ url: base + '/sos-md4-device-auth.js' });
  await page.addScriptTag({ url: base + '/sos-md4-device-store.js' });
  await page.addScriptTag({ url: base + '/sos-md4-cki.js' });
  await page.waitForFunction(
    () => !!(window.SosMd4Cki && window.SosMd4DeviceAuth && window.SosMd2PairingSession),
    null,
    { timeout: 10000 },
  );

  // Protocol isolation
  const proto = await page.evaluate(() => {
    const C = window.SosMd4Cki;
    return {
      pair: C.assertHistProtocol([['t', 'sos-pair-v1']]),
      hist: C.assertHistProtocol([['t', 'sos-hist-v1']]),
      both: C.assertHistProtocol([['t', 'sos-pair-v1'], ['t', 'sos-hist-v1']]),
    };
  });
  set('NEG_PROTOCOL_PAIR_ON_HIST', proto.pair && proto.pair.ok === false);
  set('POS_PROTOCOL_HIST', proto.hist && proto.hist.ok === true);
  set('NEG_PROTOCOL_COLLISION', proto.both && proto.both.ok === false);

  // Plaintext downgrade
  const down = await page.evaluate(() => {
    const C = window.SosMd4Cki;
    return {
      a: C.rejectPlaintextDowngrade({ schema: 'sos-cki-v1', entries: [{ peerP: 'aa' }] }),
      b: C.rejectPlaintextDowngrade({ sealSchema: 'sos-cki-seal-v1', ct: 'x', iv: 'y' }),
    };
  });
  set('NEG_PLAINTEXT_DOWNGRADE', down.a && down.a.ok === false && down.a.code === 'PLAINTEXT_DOWNGRADE');
  set('POS_SEAL_SHAPE_OK', down.b && down.b.ok === true);

  // Android fixture open (if present from unit test)
  if (fs.existsSync(FIXTURE)) {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const opened = await page.evaluate(async (fx) => {
      const C = window.SosMd4Cki;
      C.resetSpentForTests();
      const dEncPriv = new Uint8Array(
        fx.dEncPrivHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)),
      );
      const deviceCtx = {
        accountP: fx.accountP,
        deviceId: fx.deviceId,
        D_sign_pub: fx.D_sign_pub,
        D_enc_pub: fx.D_enc_pub,
        dEncPriv,
        authorization: fx.authorization,
        minAcceptedAuthEpoch: 1,
      };
      // Wrong D_enc before marking export session spent.
      C.resetSpentForTests();
      const other = window.SosMd2PairingSession.x25519Generate();
      const wrong = await C.openSealedIndex(
        fx.seal,
        Object.assign({}, deviceCtx, { dEncPriv: other.priv }),
        {},
      );
      C.resetSpentForTests();
      const ok = await C.openSealedIndex(fx.seal, deviceCtx, {});
      if (!ok.ok) return { ok: false, code: ok.code, wrongOk: wrong && wrong.ok };
      const ckMatch =
        !!(ok.index && ok.index.entries[0] && ok.index.entries[0].conversationKeyHex === fx.expectCk);
      const summaryHasCk = !!(ok.publicSummary && JSON.stringify(ok.publicSummary).includes('conversationKey'));
      const peer = ok.publicSummary && ok.publicSummary.peerPs && ok.publicSummary.peerPs[0];
      const entryCount = ok.entryCount;
      const replay = await C.openSealedIndex(fx.seal, deviceCtx, {});
      C.zeroizeIndex(ok);
      return {
        ok: true,
        entryCount,
        peer,
        ckMatch,
        wrongOk: wrong && wrong.ok,
        wrongCode: wrong && wrong.code,
        replayCode: replay && replay.code,
        summaryHasCk,
      };
    }, fixture);
    set('ANDROID_FIXTURE_DESKTOP_OPEN', opened.ok === true && opened.ckMatch === true, opened);
    set('NEG_WRONG_DENC_DESKTOP', opened.wrongOk === false, opened);
    set('NEG_REPLAY_DESKTOP', opened.replayCode === 'REPLAY_EXPORT_SESSION', opened);
    set('NO_CK_IN_PUBLIC_SUMMARY', opened.summaryHasCk === false, opened);
  } else {
    set('ANDROID_FIXTURE_DESKTOP_OPEN', false, 'FIXTURE_MISSING_RUN_UNIT_TEST_FIRST');
    set('NEG_WRONG_DENC_DESKTOP', false, 'FIXTURE_MISSING');
    set('NEG_REPLAY_DESKTOP', false, 'FIXTURE_MISSING');
    set('NO_CK_IN_PUBLIC_SUMMARY', false, 'FIXTURE_MISSING');
  }

  // Auth binding negatives via openSealed with mutated fixture or synthetic reject paths
  if (fs.existsSync(FIXTURE)) {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const neg = await page.evaluate(async (fx) => {
      const C = window.SosMd4Cki;
      const dEncPriv = new Uint8Array(
        fx.dEncPrivHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)),
      );
      async function tryOpen(mutAuth, mutSeal, mutCtx) {
        C.resetSpentForTests();
        const auth = Object.assign({}, fx.authorization, mutAuth || {});
        const seal = Object.assign({}, fx.seal, mutSeal || {});
        const ctx = Object.assign(
          {
            accountP: fx.accountP,
            deviceId: fx.deviceId,
            D_sign_pub: fx.D_sign_pub,
            D_enc_pub: fx.D_enc_pub,
            dEncPriv,
            authorization: auth,
            minAcceptedAuthEpoch: 1,
          },
          mutCtx || {},
        );
        return C.openSealedIndex(seal, ctx, {});
      }
      const rootSkMissing = await tryOpen({ rootSignature: '' });
      const noHist = await tryOpen({
        capabilities: (fx.authorization.capabilities || []).filter((c) => c !== 'DEVICE_HISTORY_SYNC'),
        rootSignature: fx.authorization.rootSignature,
      });
      // resign would be needed for real sig — missing hist still fails verify after we forge soft
      const wrongAccount = await tryOpen(null, null, { accountP: '11'.repeat(32) });
      const wrongDevice = await tryOpen(null, null, { deviceId: '11'.repeat(32) });
      const staleEpoch = await tryOpen(null, null, { minAcceptedAuthEpoch: 99 });
      const badCt = await tryOpen(null, { ct: fx.seal.ct.slice(0, -8) + 'deadbeef' });
      const crossAccount = await tryOpen(null, { accountP: '11'.repeat(32) });
      return {
        rootSkMissing: rootSkMissing.code,
        noHist: noHist.code,
        wrongAccount: wrongAccount.code,
        wrongDevice: wrongDevice.code,
        staleEpoch: staleEpoch.code,
        badCt: badCt.code,
        crossAccount: crossAccount.code,
      };
    }, fixture);
    set('NEG_MISSING_OR_FORGED_SIG', neg.rootSkMissing === 'MISSING_SIGNATURE' || neg.rootSkMissing === 'BAD_SIGNATURE', neg);
    set('NEG_MISSING_HISTORY_SYNC', neg.noHist === 'MISSING_DEVICE_HISTORY_SYNC' || neg.noHist === 'BAD_SIGNATURE', neg);
    set(
      'NEG_WRONG_ACCOUNT',
      neg.wrongAccount === 'ACCOUNT_MISMATCH' ||
        neg.wrongAccount === 'D_SIGN_MISMATCH' ||
        neg.wrongAccount === 'D_ENC_MISMATCH',
      neg,
    );
    set(
      'NEG_WRONG_DEVICE',
      neg.wrongDevice === 'DEVICE_ID_MISMATCH' || neg.wrongDevice === 'DEVICE_MISMATCH',
      neg,
    );
    set('NEG_STALE_AUTH_EPOCH', neg.staleEpoch === 'AUTH_EPOCH_MISMATCH', neg);
    set('NEG_CORRUPTED_AEAD', neg.badCt === 'AEAD_FAIL', neg);
    set('NEG_CROSS_ACCOUNT_INJECTION', neg.crossAccount === 'ACCOUNT_MISMATCH', neg);
  }

  // Leakage: console
  set('NEG_KEY_MATERIAL_CONSOLE', consoleHits.length === 0, consoleHits.slice(0, 3));

  // Source scan: no root K logging in S2 modules
  set(
    'NEG_ROOT_K_LEAKAGE_SOURCE',
    !/Log\.(d|i|v|w|e).*privateKey|console\.log\(.*conversationKey/.test(ckiSrc + expSrc),
  );

  await browser.close();
  server.close();

  const report = {
    gate: 'MD4_S2_CKI',
    runId: RUN_ID,
    startedAt: STARTED,
    finishedAt: new Date().toISOString(),
    pass,
    fail,
    results,
    STATUS: fail === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('REPORT', OUT, report.STATUS, 'pass=' + pass, 'fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
