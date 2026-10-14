/**
 * SCAN_ONLY_LINK_V1 gate. No network. No secrets logged.
 * Proves the scan path signs one canonical MD3, refuses WebAuthn claims, and rejects replay,
 * wrong account, privileged capabilities, and a forged device binding.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webcrypto, randomBytes } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'admission-service', 'package.json'));
const { getPublicKey } = require('nostr-tools');
const nobleBox = { console, crypto: webcrypto, self: { crypto: webcrypto } };
nobleBox.globalThis = nobleBox;
nobleBox.window = nobleBox;
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'vendor', 'sos-noble-schnorr.js'), 'utf8'), nobleBox);
const schnorr = nobleBox.SosNobleSecp && nobleBox.SosNobleSecp.schnorr;
const admission = await import(pathToFileURL(path.join(ROOT, 'admission-service', 'src', 'ald-w1a-verify.js')).href);

const sandbox = {
  crypto: webcrypto,
  TextEncoder,
  TextDecoder,
  console,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
};
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'sos-authorize-linked-device.js'), 'utf8'), sandbox);
const Ald = sandbox.SosAuthorizeLinkedDevice;

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

const NORMAL = [
  'DEVICE_CHAT',
  'DEVICE_CALLS',
  'DEVICE_P2P',
  'DEVICE_FILES',
  'DEVICE_RECEIPTS',
  'DEVICE_PRESENCE',
  'DEVICE_SETTINGS',
  'DEVICE_HISTORY_SYNC',
];

function hex(n) {
  return Buffer.from(randomBytes(n)).toString('hex');
}

const sk = hex(32);
const accountP = getPublicKey(Uint8Array.from(Buffer.from(sk, 'hex')));

function request(over) {
  return Object.assign({
    accountP,
    deviceId: hex(32),
    D_sign_pub: hex(32),
    D_enc_pub: hex(32),
    pairingTranscriptHash: hex(32),
    pairingId: hex(32),
    authorizationId: hex(32),
    authEpoch: 1,
    capabilities: NORMAL.slice(),
    expiresAt: Date.now() + 3 * 24 * 3600 * 1000,
    requestNonce: hex(32),
  }, over || {});
}

function memoryStore() {
  const spent = new Set();
  return {
    spent,
    async consume(rec) {
      if (spent.has(rec.pairingId) || spent.has('auth:' + rec.authorizationId)) {
        return { ok: false, code: spent.has(rec.pairingId) ? 'PAIRING_REPLAY' : 'AUTHORIZATION_REPLAY' };
      }
      spent.add(rec.pairingId);
      spent.add('auth:' + rec.authorizationId);
      return { ok: true, code: 'CONSUMED' };
    },
  };
}

function asHex(value) {
  if (typeof value === 'string') return value;
  return Buffer.from(value).toString('hex');
}

async function sign(msg, privHex) {
  try {
    const sig = await schnorr.sign(asHex(msg), privHex);
    return typeof sig === 'string' ? sig : Buffer.from(sig).toString('hex');
  } catch (e) {
    console.log('SIGN_ERR ' + String(e && e.message || e).slice(0, 200));
    throw e;
  }
}

const sample = request();
check('canonical json matches admission', Ald.scanCanonicalJson(sample) === admission.canonicalScanLinkJson(sample));

const store = memoryStore();
const out = await Ald.authorizeScanOnlyLink({
  expectedRequest: sample,
  accountP,
  privHex: sk,
  signSchnorrHex: sign,
  durableStore: store,
  featureEnabled: true,
});
check('scan authorizes', out.ok === true && out.SCAN_ONLY_LINK === true, out.code);
check('webauthn not claimed', out.WEBAUTHN_UV_PROVEN === false && out.TRUSTED_W1A_PROOF_VERIFIED === false);
check('root not returned', out.ROOT_K_RETURNED === false && !out.privHex && !out.nsec);
let verified = false;
if (out.authorization) {
  const msg = await Ald.messageHash(out.authorization);
  verified = await schnorr.verify(out.authorization.rootSignature, asHex(msg), accountP);
}
check('md3 signature verifies', verified === true);
check('same global p', !!(out.authorization && out.authorization.accountP === accountP));
check('device binding', !!(out.authorization && out.authorization.deviceId === sample.deviceId && out.authorization.D_sign_pub === sample.D_sign_pub));

const again = await Ald.authorizeScanOnlyLink({
  expectedRequest: sample,
  accountP,
  privHex: sk,
  signSchnorrHex: sign,
  durableStore: store,
  featureEnabled: true,
});
check('replay rejected', again.ok === false && again.code === 'PAIRING_REPLAY');

const wrong = await Ald.authorizeScanOnlyLink({
  expectedRequest: request({ accountP: hex(32) }),
  accountP,
  privHex: sk,
  signSchnorrHex: sign,
  durableStore: memoryStore(),
  featureEnabled: true,
});
check('wrong account rejected', wrong.ok === false && wrong.code === 'ACCOUNT_BINDING_MISMATCH');

const admin = await Ald.authorizeScanOnlyLink({
  expectedRequest: request({ capabilities: NORMAL.concat(['DEVICE_ADMIN']) }),
  accountP,
  privHex: sk,
  signSchnorrHex: sign,
  durableStore: memoryStore(),
  featureEnabled: true,
});
check('admin capability rejected', admin.ok === false && admin.code === 'PRIVILEGED_CAPABILITY');

const mixed = await Ald.authorizeScanOnlyLink({
  expectedRequest: request(),
  accountP,
  privHex: sk,
  signSchnorrHex: sign,
  durableStore: memoryStore(),
  featureEnabled: true,
  artifact: { approved: true },
  webauthnUvProven: true,
});
check('webauthn mixture rejected', mixed.ok === false && mixed.code === 'SCAN_ONLY_MIXED_AUTHORITY' && mixed.WEBAUTHN_UV_PROVEN === false);

const noKey = await Ald.authorizeScanOnlyLink({
  expectedRequest: request(),
  accountP,
  privHex: '',
  signSchnorrHex: sign,
  durableStore: memoryStore(),
  featureEnabled: true,
});
check('missing root key rejected', noKey.ok === false && noKey.code === 'VAULT_NOT_READY');

const forged = request();
forged.D_sign_pub = 'zz' + forged.D_sign_pub.slice(2);
const badDevice = await Ald.authorizeScanOnlyLink({
  expectedRequest: forged,
  accountP,
  privHex: sk,
  signSchnorrHex: sign,
  durableStore: memoryStore(),
  featureEnabled: true,
});
check('forged device key rejected', badDevice.ok === false && badDevice.code === 'BAD_SCAN_BINDING');

const expired = await Ald.authorizeScanOnlyLink({
  expectedRequest: request({ expiresAt: Date.now() - 1000 }),
  accountP,
  privHex: sk,
  signSchnorrHex: sign,
  durableStore: memoryStore(),
  featureEnabled: true,
});
check('expired request rejected', expired.ok === false && expired.code === 'BAD_EXPIRY');

const failed = checks.filter((c) => !c.ok);
console.log('STATUS=' + (failed.length ? 'FAIL' : 'PASS'));
process.exit(failed.length ? 1 : 0);
