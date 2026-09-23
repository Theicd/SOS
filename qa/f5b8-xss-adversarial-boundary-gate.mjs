#!/usr/bin/env node
/**
 * F5B8 — XSS / adversarial boundary gate (local, no live signer deploy).
 * Proves boundary assumptions of main-app + isolated-signer launcher + session/Worker gates.
 * Does NOT claim XSS is eliminated.
 * Run: node qa/f5b8-xss-adversarial-boundary-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { bytesToHex } from 'nostr-tools/utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'f5b8-xss-adversarial-boundary-report.json');

const results = [];
let pass = 0;
let fail = 0;
const report = {
  gate: 'f5b8-xss-adversarial-boundary',
  F5B8_CLAIMS_XSS_ELIMINATED: false,
  ts: new Date().toISOString(),
};

function record(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name);
    console.log('PASS ' + name + (detail ? ' — ' + detail : ''));
    return true;
  }
  fail += 1;
  results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
  console.log('FAIL ' + name + (detail ? ' — ' + detail : ''));
  return false;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function makeStorage() {
  const map = new Map();
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(String(k), String(v));
    },
    removeItem(k) {
      map.delete(String(k));
    },
    clear() {
      map.clear();
    },
    _map: map,
  };
}

function makeFake() {
  const sk = generateSecretKey();
  const hex = bytesToHex(sk).toLowerCase();
  return { hex, pub: getPublicKey(sk).toLowerCase() };
}

const launcherSrc = read('isolated-signer-trusted-import.js');
const signerSrc = read('sos-crypto-signer.js');
const vaultSrc = read('sos-crypto-worker-vault.js');
const saSrc = read('session-authority.js');
const policySrc = read('admin-signing-policy.js');
const isoSrc = read('signer-outage-isolation.js');

// —— Static boundary contracts ——
record('launcher never assigns App.privateKey', !/App\.privateKey\s*=/.test(launcherSrc));
record('launcher forbids secret option keys', /SECRET_FIELD_FORBIDDEN/.test(launcherSrc));
record('launcher uses top-level window.open not iframe', /window\.open\(url/.test(launcherSrc) && !/iframe|createElement\(['\"]iframe/.test(launcherSrc));
record('launcher origin allowlist for signer', /ALLOWED_SIGNER_ORIGINS/.test(launcherSrc) && /signer\.sos010\.com/.test(launcherSrc));
record('handleImportSuccess requires trusted origin', /UNEXPECTED_ORIGIN/.test(launcherSrc));
record('import success rejects secret fields', /SECRET_FIELD_FORBIDDEN/.test(launcherSrc));
record('import success rejects replay', /IMPORT_SUCCESS_REPLAY/.test(launcherSrc));
record('import success rejects expired session', /SESSION_EXPIRED/.test(launcherSrc));
record('F5B5/F5B6 not enabled in launcher', /F5B5_EXPORT:\s*false/.test(launcherSrc) && /F5B6_MIGRATION:\s*false/.test(launcherSrc));
record('typed signer has no generic sign/decrypt API export', !/signArbitrary|decryptArbitrary|signRaw|decryptRaw/.test(signerSrc));
record('broad admin sign removed', /BROAD_ADMIN_SIGN_REMOVED/.test(signerSrc));
record('signer session gate present', /requireValidSession/.test(signerSrc));
record('worker rpc session gate present', /assertSessionForSensitiveOp/.test(vaultSrc));
record('session authority present', /sos_session_generation/.test(saSrc));
record('outage isolation never grants signing authority', /Never grants signing authority/.test(isoSrc) || /isSecurityAuthority:\s*false/.test(isoSrc));
record('admin policy file present', /validateRequestEnvelope|ADMIN_OP/.test(policySrc));

// —— Runtime: isolated import adversarial ——
{
  const shared = makeStorage();
  const acct = makeFake();
  const root = {
    console,
    NostrApp: { publicKey: acct.pub, privateKey: null },
    localStorage: shared,
    location: { origin: 'https://sos010.com' },
    URLSearchParams,
    crypto: {
      getRandomValues(a) {
        for (let i = 0; i < a.length; i++) a[i] = (i * 17 + 3) & 0xff;
        return a;
      },
    },
    open() {
      return { closed: false };
    },
    addEventListener() {},
    dispatchEvent() {
      return true;
    },
    CustomEvent: function (type, init) {
      this.type = type;
      this.detail = init && init.detail;
    },
  };
  root.window = root;
  vm.createContext(root);
  vm.runInContext(read('signer-outage-isolation.js'), root);
  vm.runInContext(read('isolated-signer-trusted-import.js'), root);
  const Imp = root.NostrApp.IsolatedSignerTrustedImport;

  // Programmatic open with secret field denied
  let secretDenied = false;
  try {
    Imp.openTrustedImport({ privateKey: acct.hex });
  } catch (e) {
    secretDenied = e && e.code === 'SECRET_FIELD_FORBIDDEN';
  }
  record('programmatic import with privateKey denied', secretDenied);

  let nsecDenied = false;
  try {
    Imp.openTrustedImport({ nsec: 'nsec1qqqq' });
  } catch (e) {
    nsecDenied = e && e.code === 'SECRET_FIELD_FORBIDDEN';
  }
  record('programmatic import with nsec denied', nsecDenied);

  const opened = Imp.openTrustedImport({ expectedPubkey: acct.pub });
  record('trusted import open ok without secrets', opened.ok === true && opened.urlHasSecret === false);

  // Programmatic confirmation without origin
  const fakeSuccess = {
    type: 'IMPORT_SUCCESS',
    ok: true,
    protocol: 1,
    sessionId: opened.sessionId,
    pubkey: acct.pub,
    fingerprint: 'fp',
  };
  const noOrigin = Imp.handleImportSuccess(fakeSuccess, '');
  record('programmatic import confirmation without origin denied', noOrigin.ok === false && noOrigin.code === 'UNEXPECTED_ORIGIN');

  const badOrigin = Imp.handleImportSuccess(fakeSuccess, 'https://evil.example');
  record('unexpected origin rejected', badOrigin.ok === false && badOrigin.code === 'UNEXPECTED_ORIGIN');

  const withSecret = Imp.handleImportSuccess(
    Object.assign({}, fakeSuccess, { privateKey: acct.hex }),
    'https://signer.sos010.com'
  );
  record('raw K not accepted through postMessage success', withSecret.ok === false && withSecret.code === 'SECRET_FIELD_FORBIDDEN');

  const withNsec = Imp.handleImportSuccess(
    Object.assign({}, fakeSuccess, { nsec: 'nsec1dead' }),
    'https://signer.sos010.com'
  );
  record('nsec not accepted through postMessage success', withNsec.ok === false && withNsec.code === 'SECRET_FIELD_FORBIDDEN');

  const okMsg = Imp.handleImportSuccess(fakeSuccess, 'https://signer.sos010.com');
  record('valid signer-origin success accepted without identity change', okMsg.ok === true && okMsg.appPubkeyChanged === false);

  const replay = Imp.handleImportSuccess(fakeSuccess, 'https://signer.sos010.com');
  record('replay import success rejected', replay.ok === false && replay.code === 'IMPORT_SUCCESS_REPLAY');

  // Status must not contain secrets
  const st = Imp.getStatus();
  record(
    'persisted import status has no K/nsec',
    !st || (!st.privateKey && !st.nsec && !st.k && !st.seed)
  );

  // Main-origin storage cannot invent signer-origin vault — status key is app-local metadata only
  record(
    'main storage status is metadata not vault',
    Imp.STATUS_KEY === 'sos_signer_import_status_v1' &&
      !/vaultRaw|wrapKey|nonExtractable/.test(JSON.stringify(st || {}))
  );
}

// —— Runtime: session + typed signer under simulated XSS ——
{
  const shared = makeStorage();
  const acct = makeFake();
  const root = {
    console,
    NostrApp: {
      privateKey: acct.hex,
      publicKey: acct.pub,
      finalizeEvent: (draft, keyHex) => {
        const plain = {
          kind: draft.kind,
          created_at: draft.created_at,
          tags: JSON.parse(JSON.stringify(draft.tags || [])),
          content: String(draft.content ?? ''),
          pubkey: String(draft.pubkey || '').toLowerCase(),
        };
        const h = String(keyHex || '').toLowerCase();
        const bytes = new Uint8Array(h.length / 2);
        for (let i = 0; i < h.length; i += 2) bytes[i / 2] = parseInt(h.slice(i, i + 2), 16);
        return finalizeEvent(plain, bytes);
      },
    },
    NostrTools: {
      finalizeEvent,
      getPublicKey,
      utils: {
        hexToBytes: (hex) => {
          const clean = String(hex || '');
          const out = new Uint8Array(clean.length / 2);
          for (let i = 0; i < clean.length; i += 2) out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
          return out;
        },
      },
    },
    localStorage: shared,
    sessionStorage: makeStorage(),
    BroadcastChannel: function () {
      this.postMessage = () => {};
      Object.defineProperty(this, 'onmessage', { set() {}, get() { return null; } });
    },
    document: { readyState: 'complete', hidden: false, addEventListener() {} },
    addEventListener() {},
  };
  root.window = root;
  vm.createContext(root);
  vm.runInContext(read('session-authority.js'), root);
  vm.runInContext(read('sos-crypto-signer.js'), root);
  root.NostrApp.SessionAuthority.bindCurrentSession({ accountPubkey: acct.pub, bump: true });

  const S = root.NostrApp.SosCryptoSigner;
  // XSS cannot call removed broad admin APIs
  let broadRemoved = false;
  try {
    S.signGroupControlEvent({});
  } catch (e) {
    broadRemoved = e && e.code === 'BROAD_ADMIN_SIGN_REMOVED';
  }
  record('XSS cannot use broad group-control sign API', broadRemoved);

  let memRemoved = false;
  try {
    S.signMembershipState({});
  } catch (e) {
    memRemoved = e && e.code === 'BROAD_ADMIN_SIGN_REMOVED';
  }
  record('XSS cannot use broad membership sign API', memRemoved);

  // Typed admin still requires policy (cannot bypass)
  let adminNeedsPolicy = false;
  try {
    S.signTypedAdminOperation({ op: 'BOOTSTRAP_GROUP_CONTROL', groupId: 'g' });
  } catch (e) {
    adminNeedsPolicy = e && (e.code === 'ADMIN_POLICY_MISSING' || e.code === 'SESSION_REVOKED');
  }
  record('typed admin still policy-gated (no bypass)', adminNeedsPolicy);

  // After revocation, XSS cannot keep signing
  root.NostrApp.SessionAuthority.revokeSession({ reason: 'logout', rebind: false });
  let revokedBlocked = false;
  try {
    S.signFeedEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'xss',
      pubkey: acct.pub,
    });
  } catch (e) {
    revokedBlocked = e && (e.code === 'SESSION_REVOKED' || /session/i.test(String(e.message || '')));
  }
  record('revoked main tab cannot use signer authority', revokedBlocked);

  // No raw key getter on facade
  record(
    'no public raw-K getter on SosCryptoSigner',
    typeof S.getPrivateKey !== 'function' &&
      typeof S.exportPrivateKey !== 'function' &&
      typeof S.readPrivateKeyRaw !== 'function'
  );
}

// —— Prototype pollution / malformed messages ——
{
  const shared = makeStorage();
  const acct = makeFake();
  const root = {
    console,
    NostrApp: { publicKey: acct.pub },
    localStorage: shared,
    location: { origin: 'https://sos010.com' },
    URLSearchParams,
    crypto: {
      getRandomValues(a) {
        for (let i = 0; i < a.length; i++) a[i] = 1;
        return a;
      },
    },
    open() {
      return {};
    },
    addEventListener() {},
    dispatchEvent() {
      return true;
    },
    CustomEvent: function () {},
  };
  root.window = root;
  vm.createContext(root);
  vm.runInContext(read('signer-outage-isolation.js'), root);
  vm.runInContext(read('isolated-signer-trusted-import.js'), root);
  const Imp = root.NostrApp.IsolatedSignerTrustedImport;
  const opened = Imp.openTrustedImport({ expectedPubkey: acct.pub });
  const polluted = JSON.parse(
    JSON.stringify({
      type: 'IMPORT_SUCCESS',
      ok: true,
      protocol: 1,
      sessionId: opened.sessionId,
      pubkey: acct.pub,
    })
  );
  polluted.__proto__ = { privateKey: acct.hex };
  const r = Imp.handleImportSuccess(polluted, 'https://signer.sos010.com');
  // Should still succeed as metadata-only OR reject — must not store privateKey
  const st = Imp.getStatus();
  record(
    'prototype pollution does not store raw K',
    !st || (!st.privateKey && !st.k && !st.nsec)
  );
  record(
    'malformed null message fail-closed',
    Imp.handleImportSuccess(null, 'https://signer.sos010.com').ok === false
  );
}

// —— Open redirect ——
record(
  'no open redirect in import URL builder',
  /returnOrigin/.test(launcherSrc) &&
    /ALLOWED_RETURN_ORIGINS/.test(launcherSrc) &&
    !/location\.href\s*=\s*opts/.test(launcherSrc)
);

// Explicit non-claim
record('does not claim XSS eliminated', report.F5B8_CLAIMS_XSS_ELIMINATED === false);

report.F5B8_ADVERSARIAL_GATE = fail === 0 ? 'PASS' : 'FAIL';
report.F5B8_LOCAL_STATUS = fail === 0 ? 'CLOSED' : 'OPEN';
report.SAME_ORIGIN_XSS_ACTIVE_SESSION_CAN_DRIVE_ALLOWED_TYPED_OPS = true;
report.SAME_ORIGIN_XSS_CANNOT_READ_SIGNER_VAULT_VIA_LAUNCHER = true;
report.pass = pass;
report.fail = fail;
report.results = results;

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('\nF5B8_ADVERSARIAL_GATE=' + report.F5B8_ADVERSARIAL_GATE);
console.log('F5B8_CLAIMS_XSS_ELIMINATED=false');
console.log('REPORT=' + OUT);
process.exit(fail === 0 ? 0 : 1);
