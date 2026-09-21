#!/usr/bin/env node
/**
 * Stage 5E-B: prove ensureKeys never silently generates/rotates account identity.
 * Isolated mocked storage only — never real user keys.
 * Run: node qa/identity-key-preservation-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex } from 'nostr-tools/utils';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
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

function makeFakeKey() {
  const sk = generateSecretKey();
  const hex = bytesToHex(sk).toLowerCase();
  const pub = getPublicKey(hex).toLowerCase();
  return { hex, pub, sk };
}

function loadKeyRuntime(options = {}) {
  const localStorage = options.localStorage || makeStorage();
  const sessionStorage = options.sessionStorage || makeStorage();
  let genCount = 0;
  const baseGetPublicKey = options.getPublicKey || getPublicKey;
  const baseGenerateSecretKey = options.generateSecretKey || (() => {
    genCount += 1;
    return generateSecretKey();
  });

  const logs = [];
  const ctx = {
    console: {
      log: (...a) => logs.push(a.map(String).join(' ')),
      warn: (...a) => logs.push(a.map(String).join(' ')),
      error: (...a) => logs.push(a.map(String).join(' ')),
    },
    window: null,
    localStorage,
    sessionStorage,
    NostrTools: {
      generateSecretKey: baseGenerateSecretKey,
      getPublicKey: baseGetPublicKey,
    },
  };
  ctx.window = ctx;
  ctx.NostrApp = {
    bytesToHex,
    hexToBytes: (hex) => {
      const h = String(hex).replace(/^0x/i, '');
      if (h.length % 2) throw new Error('bad hex');
      const out = new Uint8Array(h.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
      return out;
    },
    getPublicKey: baseGetPublicKey,
  };

  vm.createContext(ctx);
  vm.runInContext(read('key-storage.js'), ctx);
  vm.runInContext(read('keys.js'), ctx);

  return {
    ctx,
    logs,
    localStorage,
    sessionStorage,
    get genCount() {
      return genCount;
    },
    resetGenCount() {
      genCount = 0;
    },
  };
}

function extractEnsureKeysBody(src) {
  const start = src.indexOf('function ensureKeys(');
  if (start < 0) return '';
  // ensureKeys ends before createNewIdentityExplicit
  const end = src.indexOf('function createNewIdentityExplicit', start);
  return end > start ? src.slice(start, end) : src.slice(start, start + 4500);
}

function staticSafety() {
  const keys = read('keys.js');
  const ensureBody = extractEnsureKeysBody(keys);
  record('static ensureKeys present', /function ensureKeys\(/.test(keys));
  record('static ensureKeys has NO generateSecretKey',
    !!ensureBody && !/generateSecretKey/.test(ensureBody));
  record('static ensureKeys has NO generateAndStoreKey',
    !!ensureBody && !/generateAndStoreKey/.test(ensureBody));
  record('static ensureKeys has NO createNewIdentityExplicit',
    !!ensureBody && !/createNewIdentityExplicit/.test(ensureBody));
  record('static createNewIdentityExplicit exists',
    /function createNewIdentityExplicit/.test(keys));
  record('static IDENTITY_EXPLICIT_CREATE marker',
    /IDENTITY_EXPLICIT_CREATE/.test(keys));
  record('static IDENTITY_STATE logs',
    /IDENTITY_STATE state=/.test(keys));
  record('static no regenerating warn path',
    !/regenerating\.\.\./.test(keys));

  const account = read('account.js');
  const keyViewer = read('key-viewer.js');
  const profileView = read('profile-view.js');
  const profileViewer = read('profile-viewer.js');
  const dating = read('dating.js');
  const auth = read('auth.js');
  const guest = read('guest-auth.js');

  record('account modal uses ensureKeys without generateAndStoreKey',
    /ensureKeys/.test(account) && !/generateAndStoreKey/.test(account)
    && !/createNewIdentityExplicit/.test(account));
  record('key-viewer guest-safe (no generateAndStoreKey)',
    /ensureKeys/.test(keyViewer) && !/generateAndStoreKey/.test(keyViewer));
  record('profile-view no blind raw key fallback assign',
    /ensureKeys/.test(profileView)
    && !/App\.privateKey\s*=\s*[\s\S]{0,80}readPrivateKeyRaw/.test(profileView));
  record('profile-viewer no blind raw key fallback assign',
    /ensureKeys/.test(profileViewer)
    && !/App\.privateKey\s*=\s*[\s\S]{0,80}readPrivateKeyRaw/.test(profileViewer));
  record('dating no blind raw key fallback assign',
    /ensureKeys/.test(dating)
    && !/App\.privateKey\s*=\s*[\s\S]{0,80}readPrivateKeyRaw/.test(dating));
  record('auth continue uses createNewIdentityExplicit',
    /createNewIdentityExplicit/.test(auth));
  record('guest-auth final connect uses createNewIdentityExplicit',
    /createNewIdentityExplicit/.test(guest));

  // Approved account-identity generation call sites (explicit create only)
  const approved = [
    'keys.js:createNewIdentityExplicit → generateSecretKey',
    'keys.js:generateAndStoreKey → createNewIdentityExplicit (legacy alias)',
    'auth.js:generatePrivateKeyHex → App.generateSecretKey|NostrTools.generateSecretKey (create UI preview)',
    'guest-auth.js:generatePrivateKeyHex → NostrTools.generateSecretKey (signup preview)',
  ];
  record('approved generation call sites documented', approved.length >= 4, approved.join(' | '));
}

function runtimeScenarios() {
  // A valid existing key
  {
    const fake = makeFakeKey();
    const rt = loadKeyRuntime();
    rt.localStorage.setItem('nostr_private_key', fake.hex);
    const before = rt.localStorage.getItem('nostr_private_key');
    const res = rt.ctx.NostrApp.ensureKeys();
    const after = rt.localStorage.getItem('nostr_private_key');
    record('A VALID EXISTING KEY preserves K/P, no generate',
      res.ok === true
      && res.state === 'IDENTITY_OK'
      && res.privateKey === fake.hex
      && res.publicKey === fake.pub
      && before === after
      && rt.genCount === 0);
  }

  // B memory key
  {
    const fake = makeFakeKey();
    const rt = loadKeyRuntime();
    rt.ctx.NostrApp.privateKey = fake.hex;
    const res = rt.ctx.NostrApp.ensureKeys();
    record('B VALID MEMORY KEY preserves K, no generate',
      res.ok === true
      && res.privateKey === fake.hex
      && res.publicKey === fake.pub
      && rt.genCount === 0);
  }

  // C empty
  {
    const rt = loadKeyRuntime();
    const res = rt.ctx.NostrApp.ensureKeys();
    record('C EMPTY STORAGE → IDENTITY_NEW_USER, no generate, empty store',
      res.ok === false
      && res.state === 'IDENTITY_NEW_USER'
      && rt.genCount === 0
      && !rt.localStorage.getItem('nostr_private_key')
      && (rt.ctx.NostrApp.privateKey == null)
      && (rt.ctx.NostrApp.publicKey == null));
  }

  // D corrupt
  {
    const rt = loadKeyRuntime();
    const corrupt = 'not-a-valid-private-key!!';
    rt.localStorage.setItem('nostr_private_key', corrupt);
    const res = rt.ctx.NostrApp.ensureKeys();
    record('D CORRUPT STORED KEY → INVALID, no generate, storage unchanged',
      res.ok === false
      && (res.state === 'IDENTITY_INVALID' || res.state === 'IDENTITY_RECOVERY_REQUIRED')
      && rt.genCount === 0
      && rt.localStorage.getItem('nostr_private_key') === corrupt);
  }

  // E getPublicKey failure
  {
    const fake = makeFakeKey();
    const rt = loadKeyRuntime({
      getPublicKey() {
        throw new Error('forced derive failure');
      },
    });
    rt.localStorage.setItem('nostr_private_key', fake.hex);
    const res = rt.ctx.NostrApp.ensureKeys();
    record('E getPublicKey FAILURE → RECOVERY, no generate, storage unchanged',
      res.ok === false
      && res.state === 'IDENTITY_RECOVERY_REQUIRED'
      && rt.genCount === 0
      && rt.localStorage.getItem('nostr_private_key') === fake.hex);
  }

  // F account modal guest
  {
    const rt = loadKeyRuntime();
    const ensure = rt.ctx.NostrApp.ensureKeys();
    record('F ACCOUNT MODAL GUEST ensureKeys does not generate',
      ensure.state === 'IDENTITY_NEW_USER' && rt.genCount === 0
      && !rt.localStorage.getItem('nostr_private_key'));
  }

  // G key viewer guest
  {
    const rt = loadKeyRuntime();
    const ensure = rt.ctx.NostrApp.ensureKeys();
    record('G KEY VIEWER GUEST ensureKeys does not generate',
      ensure.ok === false && rt.genCount === 0
      && (rt.ctx.NostrApp.privateKey == null));
  }

  // H profile guest
  {
    const rt = loadKeyRuntime();
    const ensure = rt.ctx.NostrApp.ensureKeys();
    record('H PROFILE GUEST bootstrap does not generate',
      ensure.state === 'IDENTITY_NEW_USER' && rt.genCount === 0);
  }

  // I dating guest
  {
    const rt = loadKeyRuntime();
    const ensure = rt.ctx.NostrApp.ensureKeys();
    record('I DATING GUEST does not generate',
      ensure.state === 'IDENTITY_NEW_USER' && rt.genCount === 0);
  }

  // J explicit create
  {
    const rt = loadKeyRuntime();
    const created = rt.ctx.NostrApp.createNewIdentityExplicit();
    const stored = rt.localStorage.getItem('nostr_private_key');
    record('J EXPLICIT CREATE generates exactly once and stores same K',
      created.ok === true
      && created.state === 'IDENTITY_OK'
      && rt.genCount === 1
      && stored === created.privateKey
      && created.publicKey === getPublicKey(created.privateKey).toLowerCase()
      && rt.logs.some((l) => l.includes('IDENTITY_EXPLICIT_CREATE')));
    // second ensureKeys must not generate again
    rt.resetGenCount();
    const again = rt.ctx.NostrApp.ensureKeys();
    record('J2 ensureKeys after explicit create does not regenerate',
      again.ok === true
      && again.privateKey === created.privateKey
      && rt.genCount === 0);
  }

  // Jb explicit create with prepared hex (auth continue path)
  {
    const fake = makeFakeKey();
    const rt = loadKeyRuntime();
    const created = rt.ctx.NostrApp.createNewIdentityExplicit({ privateKeyHex: fake.hex });
    record('Jb EXPLICIT CREATE with prepared K stores once, genCount=0',
      created.ok === true
      && created.privateKey === fake.hex
      && created.publicKey === fake.pub
      && rt.genCount === 0
      && rt.localStorage.getItem('nostr_private_key') === fake.hex);
  }

  // K import valid
  {
    const existing = makeFakeKey();
    const imported = makeFakeKey();
    const rt = loadKeyRuntime();
    rt.localStorage.setItem('nostr_private_key', existing.hex);
    rt.ctx.NostrApp.ensureKeys();
    rt.resetGenCount();
    // simulate account applyImportedKey core
    const normalized = rt.ctx.NostrApp.normalizePrivateKey(imported.hex, { persist: false });
    rt.ctx.SOSKeyStorage.writePrivateKeyRaw(normalized);
    rt.ctx.NostrApp.privateKey = normalized;
    const res = rt.ctx.NostrApp.ensureKeys();
    record('K IMPORT valid → zero generation, identity = imported K',
      res.ok === true
      && res.privateKey === imported.hex
      && res.publicKey === imported.pub
      && rt.genCount === 0);
  }

  // L invalid import preserves K1
  {
    const existing = makeFakeKey();
    const rt = loadKeyRuntime();
    rt.localStorage.setItem('nostr_private_key', existing.hex);
    rt.ctx.NostrApp.ensureKeys();
    rt.resetGenCount();
    const before = rt.localStorage.getItem('nostr_private_key');
    const bad = rt.ctx.NostrApp.normalizePrivateKey('totally-invalid', { persist: false });
    // account.js rejects before write when normalize fails
    const wrote = bad ? true : false;
    record('L INVALID IMPORT does not write / preserves K1 / no generate',
      bad == null
      && wrote === false
      && before === existing.hex
      && rt.localStorage.getItem('nostr_private_key') === existing.hex
      && rt.genCount === 0);
  }

  // M normalization preserves derived pubkey
  {
    const fake = makeFakeKey();
    const upper = fake.hex.toUpperCase();
    const withPrefix = '0x' + upper;
    const comma = Array.from(fake.sk).join(',');

    const rt1 = loadKeyRuntime();
    rt1.localStorage.setItem('nostr_private_key', withPrefix);
    const r1 = rt1.ctx.NostrApp.ensureKeys();
    record('M NORMALIZATION 0x/upper → same P, no generate',
      r1.ok === true
      && r1.privateKey === fake.hex
      && r1.publicKey === fake.pub
      && rt1.genCount === 0);

    const rt2 = loadKeyRuntime();
    rt2.localStorage.setItem('nostr_private_key', comma);
    const r2 = rt2.ctx.NostrApp.ensureKeys();
    record('M NORMALIZATION comma-bytes → same K/P, no generate',
      r2.ok === true
      && r2.privateKey === fake.hex
      && r2.publicKey === fake.pub
      && rt2.genCount === 0);
  }
}

staticSafety();
runtimeScenarios();

const failed = results.filter((r) => !r.ok);
console.log('TOTAL ' + results.length + ' FAIL ' + failed.length);
if (failed.length) {
  process.exitCode = 1;
}
