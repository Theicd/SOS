/**
 * MD3W-W1B — AUTHORIZE_LINKED_DEVICE + W1A proof + durable consume security gate.
 * Isolated non-production harness. Does not deploy. Does not mutate SOS-signer.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomBytes, webcrypto, createPrivateKey, sign as nodeSign } from 'crypto';
import { pathToFileURL } from 'url';
import vm from 'vm';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SIGNER = 'C:\\BRAIN\\SOS-signer';
const OUT = path.join(__dirname, 'md3w-w1b-authorize-report.json');
const RUN_LOG = path.join(__dirname, '.md3w-w1b-gate-run.txt');

const runId = randomUUID();
const checks = {};
const notes = [];
let fails = 0;

function log(s) {
  notes.push(s);
  console.log(s);
}

function check(name, ok, detail) {
  checks[name] = { ok: !!ok, detail: detail || '' };
  log(`[w1b] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function sha256hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function hex(buf) {
  return Buffer.from(buf).toString('hex');
}

function loadIife(file) {
  const code = read(path.join(ROOT, file));
  const sandbox = {
    self: null,
    globalThis: null,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Uint8Array,
    ArrayBuffer,
    JSON,
    Date,
    Math,
    console,
    module: { exports: {} },
    exports: {},
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.NostrApp = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file });
  return sandbox;
}

async function genP256() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await webcrypto.subtle.exportKey('spki', kp.publicKey));
  return { kp, spki };
}

async function buildAssertion({ challenge, privateKey, origin, rpId, flags = 0x05 }) {
  const rpHash = new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
  const auth = new Uint8Array(37);
  auth.set(rpHash, 0);
  auth[32] = flags;
  const chB64 = b64url(challenge instanceof Uint8Array ? challenge : new Uint8Array(challenge));
  const clientBytes = new TextEncoder().encode(
    JSON.stringify({ type: 'webauthn.get', challenge: chB64, origin }),
  );
  const clientHash = new Uint8Array(await webcrypto.subtle.digest('SHA-256', clientBytes));
  const signed = new Uint8Array(auth.length + clientHash.length);
  signed.set(auth, 0);
  signed.set(clientHash, auth.length);
  const sigRaw = new Uint8Array(
    await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, signed),
  );
  // P1363 → DER
  function encInt(slice) {
    let v = slice;
    while (v.length > 1 && v[0] === 0 && v[1] < 0x80) v = v.slice(1);
    if (v[0] & 0x80) {
      const n = new Uint8Array(v.length + 1);
      n.set(v, 1);
      v = n;
    }
    const out = new Uint8Array(2 + v.length);
    out[0] = 0x02;
    out[1] = v.length;
    out.set(v, 2);
    return out;
  }
  const r = encInt(sigRaw.slice(0, 32));
  const s = encInt(sigRaw.slice(32));
  const seq = new Uint8Array(2 + r.length + s.length);
  seq[0] = 0x30;
  seq[1] = r.length + s.length;
  seq.set(r, 2);
  seq.set(s, 2 + r.length);
  const credId = randomBytes(16);
  return {
    type: 'public-key',
    rawId: credId,
    response: {
      clientDataJSON: clientBytes,
      authenticatorData: auth,
      signature: seq,
    },
    _credIdB64: b64url(credId),
  };
}

async function makeArtifact({ accountP, deviceId, req, kp, spki, origin = 'http://127.0.0.1:8787', rpId = 'localhost', flags = 0x05, mutators }) {
  const VerifySandbox = loadIife('sos-ald-w1a-verify.js');
  const V = VerifySandbox.SosAldW1aVerify;
  const canonical = V.buildCanonicalAldApprovalRequest(req);
  const requestHash = await V.requestHashFromCanonical(canonical);
  const challenge = new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  const assertion = await buildAssertion({ challenge, privateKey: kp.privateKey, origin, rpId, flags });
  let artifact = {
    operation: 'AUTHORIZE_LINKED_DEVICE_APPROVAL_V1',
    approvalId: hex(randomBytes(16)),
    requestId: hex(randomBytes(16)),
    accountP,
    requestHash,
    canonicalRequest: req,
    intentCanonical: canonical,
    signerOrigin: origin,
    rpId,
    challengeHex: hex(challenge),
    approvalExpiresAt: Date.now() + 120000,
    credentialIdB64url: assertion._credIdB64,
    publicKeySpkiB64url: b64url(spki),
    assertion: {
      clientDataJSON_b64url: b64url(assertion.response.clientDataJSON),
      authenticatorData_b64url: b64url(assertion.response.authenticatorData),
      signature_b64url: b64url(assertion.response.signature),
      rawId_b64url: assertion._credIdB64,
    },
    ROOT_K_USED: false,
    NSEC_USED: false,
    DEVICE_AUTHORIZATION_SIGNED: false,
    T1_FALLBACK_ENABLED: false,
  };
  if (typeof mutators === 'function') artifact = mutators(artifact) || artifact;
  return { artifact, requestHash, challenge, V };
}

/** Minimal schnorr via @noble if present in nostr bundle — fallback: fake for negative-only won't work.
 * Use dynamic import of noble from admission-service node_modules or vendor.
 */
async function loadSchnorr() {
  const candidates = [
    path.join(ROOT, 'admission-service', 'node_modules', '@noble', 'curves', 'esm', 'secp256k1.js'),
    path.join(ROOT, 'admission-service', 'node_modules', '@noble', 'secp256k1', 'index.js'),
    path.join(SIGNER, 'node_modules', '@noble', 'curves', 'esm', 'secp256k1.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const mod = await import(pathToFileURL(c).href);
        const schnorr = mod.schnorr || (mod.secp256k1 && mod.secp256k1.schnorr);
        if (schnorr && schnorr.sign) return schnorr;
      } catch (_e) {}
    }
  }
  // try nostr-tools
  try {
    const nt = await import(pathToFileURL(path.join(ROOT, 'admission-service', 'node_modules', 'nostr-tools', 'lib', 'nostr.mjs')).href);
    if (nt.schnorr) return nt.schnorr;
  } catch (_e) {}
  try {
    const nt = await import('nostr-tools');
    if (nt.schnorr) return nt.schnorr;
  } catch (_e) {}
  return null;
}

function staticChecks() {
  const worker = read(path.join(ROOT, 'sos-crypto-worker.js'));
  const ald = read(path.join(ROOT, 'sos-authorize-linked-device.js'));
  const verify = read(path.join(ROOT, 'sos-ald-w1a-verify.js'));
  const issuer = read(path.join(ROOT, 'sos-web-phone-issuer.js'));
  const globalAcc = read(path.join(ROOT, 'admission-service', 'src', 'global-accounts.js'));
  const flags = read(path.join(ROOT, 'runtime-feature-flags.json'));
  const md2 = read(path.join(ROOT, 'sos-md2-pairing-session.js'));

  check('AUTHORIZE_OP_IN_WORKER', /AUTHORIZE_LINKED_DEVICE/.test(worker));
  check('W1A_VERIFY_PORT', /verifyAldApprovalArtifact/.test(verify));
  check('NO_T1_FALLBACK', /T1_FALLBACK_ENABLED:\s*false/.test(ald) || /T1_FALLBACK_ENABLED = false/.test(ald));
  check('DURABLE_DO_TABLE', /ald_approval_spent/.test(globalAcc));
  check('ADMISSION_CONSUME_ROUTE', /ald\/approval\/consume/.test(globalAcc));
  check('WEB_PHONEISSUER_PRESENT', /issueFromPairingQr/.test(issuer));
  check('MD2_PHONE_RESPONDER', /beginPhoneResponder/.test(md2));
  check('FEATURE_FLAG_DEFAULT_OFF', /"md3wT2SignerApproval"\s*:\s*false/.test(flags));
  check('NO_GENERIC_ROOT_SIGN', /GENERIC_ROOT_SIGNER:\s*false/.test(ald) || /GENERIC_ROOT_SIGNER = false/.test(ald));
  check('PRODUCTION_HARD_OFF', /isProductionHost/.test(ald) && /WEB_MD3_ISSUANCE_DISABLED/.test(worker));

  // Signer unchanged for W1A modules
  const signerHead = fs.readFileSync('C:\\BRAIN\\SOS-MD3W-W1B-MD4-CHECKPOINT-20261011\\SIGNER_HEAD.txt', 'utf8').trim();
  check('SIGNER_HEAD_MATCH', signerHead === 'e2e05f0545e304a43353d497de077ee7cadcae27', signerHead);
  const w1aHash = createHash('sha256')
    .update(fs.readFileSync(path.join(SIGNER, 'js', 'authorize-linked-device-approval.js')))
    .digest('hex')
    .toUpperCase();
  const expected = '94CF60A3886AC5C6C9110A8CDF422096149CD5627663A3931100B06D8EAC9FE8';
  check('SIGNER_W1A_HASH_UNCHANGED', w1aHash === expected, w1aHash.slice(0, 16));
}

async function runtimeChecks() {
  const schnorr = await loadSchnorr();
  check('SCHNORR_AVAILABLE', !!schnorr, schnorr ? 'ok' : 'missing noble/nostr-tools');
  if (!schnorr) return;

  const verifyBox = loadIife('sos-ald-w1a-verify.js');
  const aldBox = loadIife('sos-authorize-linked-device.js');
  // ensure verify attached on same root as authorize
  aldBox.SosAldW1aVerify = verifyBox.SosAldW1aVerify;
  const Ald = aldBox.SosAuthorizeLinkedDevice;
  const V = verifyBox.SosAldW1aVerify;

  const accountP = hex(randomBytes(32));
  const deviceId = hex(randomBytes(32));
  const dSign = hex(randomBytes(32));
  const dEnc = hex(randomBytes(32));
  const pairingTranscriptHash = hex(randomBytes(32));
  const pairingId = hex(randomBytes(16));
  const authorizationId = hex(randomBytes(32));
  const priv = randomBytes(32);
  // clamp-ish for secp — noble handles
  const { kp, spki } = await genP256();

  const baseReq = {
    operation: 'AUTHORIZE_LINKED_DEVICE_APPROVAL_V1',
    protocolVersion: 1,
    accountP,
    deviceId,
    D_sign_pub: dSign,
    D_enc_pub: dEnc,
    pairingTranscriptHash,
    pairingId,
    authorizationId,
    authEpoch: 1,
    capabilities: [...Ald.NORMAL_PROFILE],
    expiresAt: Date.now() + 3600_000,
    requestNonce: hex(randomBytes(32)),
  };

  async function signSchnorrHex(msg32, privHex) {
    const sig = schnorr.sign(msg32, Buffer.from(privHex, 'hex'));
    return hex(sig instanceof Uint8Array ? sig : Buffer.from(sig));
  }

  const counters = { issued: 0, rejected: 0 };

  // POS: valid T2 → durable → sign
  {
    const store = Ald.createDurableApprovalStore();
    const { artifact } = await makeArtifact({ accountP, deviceId, req: baseReq, kp, spki });
    const out = await Ald.authorizeLinkedDevice({
      artifact,
      expectedRequest: baseReq,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: '127.0.0.1',
      counters,
    });
    check('POS_AUTHORIZE', out.ok === true && !!out.authorization && !!out.authorization.rootSignature);
    check('POS_NO_K_LEAK', out.ROOT_K_RETURNED === false && !JSON.stringify(out).includes(hex(priv)));
    check('POS_UV_PROVEN', out.WEBAUTHN_UV_PROVEN === true);
    check('POS_DURABLE', out.DURABLE_ONE_TIME_CONSUMPTION === true && store.size() === 1);

    // Desktop verifyStrict parity
    const authMod = read(path.join(ROOT, 'sos-md4-device-auth.js'));
    // Use canonical + schnorr verify via noble
    const msg = await Ald.messageHash(out.authorization);
    const pub = schnorr.getPublicKey(priv);
    const okV = schnorr.verify(Buffer.from(out.authorization.rootSignature, 'hex'), msg, pub);
    check('POS_SCHNORR_VERIFY', okV === true);
    check('CANONICAL_ENCODING', out.authorization.encoding === 'canonical-line-v1+sha256+schnorr');
    void authMod;
  }

  // NEG: no approval
  {
    const store = Ald.createDurableApprovalStore();
    const before = counters.issued;
    const out = await Ald.authorizeLinkedDevice({
      artifact: null,
      expectedRequest: baseReq,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: '127.0.0.1',
      counters,
    });
    check('NEG_NO_APPROVAL', out.ok === false && store.size() === 0 && counters.issued === before);
  }

  // NEG: client approved flag only
  {
    const store = Ald.createDurableApprovalStore();
    const out = await Ald.authorizeLinkedDevice({
      artifact: { approved: true, uv: true, operation: 'AUTHORIZE_LINKED_DEVICE_APPROVAL_V1' },
      expectedRequest: baseReq,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: '127.0.0.1',
      counters,
    });
    check('NEG_CLIENT_FLAG', out.ok === false && /CLIENT_APPROVED|BAD_OPERATION|W1A_PROOF/.test(out.code));
  }

  // NEG: forged UV missing
  {
    const store = Ald.createDurableApprovalStore();
    const { artifact } = await makeArtifact({ accountP, deviceId, req: baseReq, kp, spki, flags: 0x01 });
    const out = await Ald.authorizeLinkedDevice({
      artifact,
      expectedRequest: baseReq,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: '127.0.0.1',
      counters,
    });
    check('NEG_MISSING_UV', out.ok === false && out.code === 'UV_FLAG_MISSING' && store.size() === 0);
  }

  // NEG: wrong accountP
  {
    const store = Ald.createDurableApprovalStore();
    const { artifact } = await makeArtifact({ accountP, deviceId, req: baseReq, kp, spki });
    const out = await Ald.authorizeLinkedDevice({
      artifact,
      expectedRequest: baseReq,
      accountP: hex(randomBytes(32)),
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: '127.0.0.1',
      counters,
    });
    check('NEG_WRONG_ACCOUNT', out.ok === false && store.size() === 0);
  }

  // NEG: wrong device
  {
    const store = Ald.createDurableApprovalStore();
    const { artifact } = await makeArtifact({ accountP, deviceId, req: baseReq, kp, spki });
    const evil = { ...baseReq, deviceId: hex(randomBytes(32)) };
    const out = await Ald.authorizeLinkedDevice({
      artifact,
      expectedRequest: evil,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: '127.0.0.1',
      counters,
    });
    check('NEG_WRONG_DEVICE', out.ok === false && store.size() === 0);
  }

  // NEG: replaced keys
  {
    const store = Ald.createDurableApprovalStore();
    const { artifact } = await makeArtifact({ accountP, deviceId, req: baseReq, kp, spki });
    const evil = { ...baseReq, D_sign_pub: hex(randomBytes(32)) };
    const out = await Ald.authorizeLinkedDevice({
      artifact,
      expectedRequest: evil,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: '127.0.0.1',
      counters,
    });
    check('NEG_REPLACED_D_SIGN', out.ok === false);
  }

  // NEG: privileged caps
  {
    const store = Ald.createDurableApprovalStore();
    const badReq = { ...baseReq, capabilities: [...Ald.NORMAL_PROFILE, 'DEVICE_ADMIN'], authorizationId: hex(randomBytes(32)) };
    // artifact built with bad caps should fail verify
    const { artifact } = await makeArtifact({ accountP, deviceId, req: badReq, kp, spki });
    const out = await Ald.authorizeLinkedDevice({
      artifact,
      expectedRequest: badReq,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: '127.0.0.1',
      counters,
    });
    check('NEG_PRIVILEGED_CAPS', out.ok === false);
  }

  // NEG: expired approval
  {
    const store = Ald.createDurableApprovalStore();
    const { artifact } = await makeArtifact({
      accountP,
      deviceId,
      req: baseReq,
      kp,
      spki,
      mutators: (a) => {
        a.approvalExpiresAt = Date.now() - 1000;
        return a;
      },
    });
    const out = await Ald.authorizeLinkedDevice({
      artifact,
      expectedRequest: baseReq,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: '127.0.0.1',
      counters,
    });
    check('NEG_EXPIRED_APPROVAL', out.ok === false && out.code === 'APPROVAL_EXPIRED');
  }

  // NEG: replay approval
  {
    const store = Ald.createDurableApprovalStore();
    const { artifact } = await makeArtifact({ accountP, deviceId, req: baseReq, kp, spki });
    const out1 = await Ald.authorizeLinkedDevice({
      artifact,
      expectedRequest: baseReq,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: '127.0.0.1',
      counters,
    });
    const issuedBefore = counters.issued;
    const out2 = await Ald.authorizeLinkedDevice({
      artifact,
      expectedRequest: baseReq,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: '127.0.0.1',
      counters,
    });
    check('NEG_REPLAY', out1.ok === true && out2.ok === false && out2.code === 'APPROVAL_REPLAY');
    check('NEG_REPLAY_NO_EXTRA_ISSUE', counters.issued === issuedBefore);
  }

  // NEG: concurrent double consume
  {
    const store = Ald.createDurableApprovalStore();
    const { artifact } = await makeArtifact({
      accountP,
      deviceId,
      req: { ...baseReq, authorizationId: hex(randomBytes(32)), requestNonce: hex(randomBytes(32)) },
      kp,
      spki,
    });
    const req2 = artifact.canonicalRequest;
    const [a, b] = await Promise.all([
      Ald.authorizeLinkedDevice({
        artifact,
        expectedRequest: req2,
        accountP,
        privHex: hex(priv),
        signSchnorrHex,
        durableStore: store,
        featureEnabled: true,
        hostname: '127.0.0.1',
        counters,
      }),
      Ald.authorizeLinkedDevice({
        artifact,
        expectedRequest: req2,
        accountP,
        privHex: hex(priv),
        signSchnorrHex,
        durableStore: store,
        featureEnabled: true,
        hostname: '127.0.0.1',
        counters,
      }),
    ]);
    const oks = [a, b].filter((x) => x.ok).length;
    check('NEG_CONCURRENT_DOUBLE', oks === 1 && store.size() === 1);
  }

  // NEG: T2→T1
  {
    const store = Ald.createDurableApprovalStore();
    const out = await Ald.authorizeLinkedDevice({
      artifact: { approved: true },
      expectedRequest: baseReq,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: '127.0.0.1',
      t1FallbackAttempt: true,
      counters,
    });
    check('NEG_T1_DOWNGRADE', out.ok === false && out.code === 'T1_FALLBACK_FORBIDDEN');
  }

  // NEG: production host
  {
    const store = Ald.createDurableApprovalStore();
    const { artifact } = await makeArtifact({ accountP, deviceId, req: baseReq, kp, spki });
    const out = await Ald.authorizeLinkedDevice({
      artifact,
      expectedRequest: baseReq,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: 'sos010.com',
      counters,
    });
    check('NEG_PRODUCTION_HOST', out.ok === false && out.code === 'WEB_MD3_ISSUANCE_DISABLED');
  }

  // NEG: feature flag off
  {
    const store = Ald.createDurableApprovalStore();
    const { artifact } = await makeArtifact({ accountP, deviceId, req: baseReq, kp, spki });
    const out = await Ald.authorizeLinkedDevice({
      artifact,
      expectedRequest: baseReq,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: false,
      hostname: '127.0.0.1',
      counters,
    });
    check('NEG_FLAG_OFF', out.ok === false);
  }

  // NEG: durable unavailable
  {
    const store = Ald.createDurableApprovalStore();
    store.setUnavailable(true);
    const { artifact } = await makeArtifact({ accountP, deviceId, req: baseReq, kp, spki });
    const out = await Ald.authorizeLinkedDevice({
      artifact,
      expectedRequest: baseReq,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: '127.0.0.1',
      counters,
    });
    check('NEG_DURABLE_UNAVAILABLE', out.ok === false && out.code === 'DURABLE_STORE_UNAVAILABLE');
  }

  // NEG: wrong origin in assertion
  {
    const store = Ald.createDurableApprovalStore();
    const { artifact } = await makeArtifact({
      accountP,
      deviceId,
      req: baseReq,
      kp,
      spki,
      origin: 'https://evil.example',
    });
    // force signerOrigin label to allowed while assertion origin evil — verify should fail ORIGIN or SIGNER
    artifact.signerOrigin = 'http://127.0.0.1:8787';
    const out = await Ald.authorizeLinkedDevice({
      artifact,
      expectedRequest: baseReq,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: '127.0.0.1',
      counters,
    });
    check('NEG_CROSS_ORIGIN_ASSERTION', out.ok === false);
  }

  // NEG: account disabled
  {
    const store = Ald.createDurableApprovalStore();
    const { artifact } = await makeArtifact({ accountP, deviceId, req: baseReq, kp, spki });
    const out = await Ald.authorizeLinkedDevice({
      artifact,
      expectedRequest: baseReq,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: '127.0.0.1',
      accountDisabled: true,
      counters,
    });
    check('NEG_ACCOUNT_DISABLED', out.ok === false && out.code === 'ACCOUNT_DISABLED');
  }

  // NEG: stale authEpoch
  {
    const store = Ald.createDurableApprovalStore();
    const { artifact } = await makeArtifact({ accountP, deviceId, req: baseReq, kp, spki });
    const out = await Ald.authorizeLinkedDevice({
      artifact,
      expectedRequest: baseReq,
      accountP,
      privHex: hex(priv),
      signSchnorrHex,
      durableStore: store,
      featureEnabled: true,
      hostname: '127.0.0.1',
      minAuthEpoch: 2,
      counters,
    });
    check('NEG_STALE_EPOCH', out.ok === false && out.code === 'STALE_AUTH_EPOCH');
  }

  check('VERIFY_CONTRACT_PRESENT', V.ALD_WORKER_VERIFY_CONTRACT_PRESENT === true);
  check('VERIFY_DOES_NOT_SIGN', V.ALD_WORKER_SIGNS_DEVICE_AUTHORIZATION === false);
}

async function main() {
  staticChecks();
  await runtimeChecks();

  // W1A regression against unchanged signer
  let w1aStatus = 'NOT_RUN';
  try {
    const { spawnSync } = await import('child_process');
    const r = spawnSync(process.execPath, ['qa/md3w-w1a-ald-approval-gate.mjs'], {
      cwd: SIGNER,
      encoding: 'utf8',
      timeout: 120000,
    });
    w1aStatus = r.status === 0 ? 'PASS' : 'FAIL';
    check('W1A_SIGNER_REGRESSION', r.status === 0, 'exit=' + r.status);
    fs.writeFileSync(path.join(__dirname, '.md3w-w1b-w1a-regression.txt'), String(r.stdout || '') + String(r.stderr || ''));
  } catch (e) {
    check('W1A_SIGNER_REGRESSION', false, String(e.message || e));
  }

  const report = {
    gate: 'MD3W_W1B_AUTHORIZE_LINKED_DEVICE',
    status: fails === 0 ? 'PASS' : 'FAIL',
    ts: new Date().toISOString(),
    runId,
    SIGNER_REPO_HEAD: 'e2e05f0545e304a43353d497de077ee7cadcae27',
    W1A_REGRESSION: w1aStatus,
    checks,
    notes,
    failCount: fails,
    FEATURE_FLAG_STATUS: 'OFF_DEFAULT',
    T1_FALLBACK_DISABLED: true,
    ROOT_K_ISOLATION: true,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  try {
    fs.writeFileSync(RUN_LOG, notes.join('\n'));
  } catch (_e) {
    fs.writeFileSync(path.join(__dirname, '.md3w-w1b-gate-run-notes.txt'), notes.join('\n'));
  }
  console.log('REPORT', OUT);
  console.log('STATUS=' + report.status + ' runId=' + runId);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
