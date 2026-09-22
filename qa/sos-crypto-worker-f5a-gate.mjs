/**
 * Stage 5E-F5A gate — page runtime raw-K removal + Worker CREATE_BROWSER_IDENTITY.
 * Run: node qa/sos-crypto-worker-f5a-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(path.join(ROOT, 'package.json'));

let pass = 0;
let fail = 0;
function record(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('PASS', name);
  } else {
    fail++;
    console.log('FAIL', name, detail || '');
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const worker = read('sos-crypto-worker.js');
const vault = read('sos-crypto-worker-vault.js');
const signer = read('sos-crypto-signer.js');
const guest = read('guest-auth.js');
const keyViewer = read('key-viewer.js');
const account = read('account.js');
const compose = read('compose.js');
const nzp = read('nzp-multiplayer.html');
const hexgl = read('hexgl-multiplayer.html');
const doom = read('doom-multiplayer.html');
const keyStore = read('key-storage.js');
const native = read('native-shell-bridge.js');
const appJs = read('app.js');

record('CREATE_BROWSER_IDENTITY op present', /CREATE_BROWSER_IDENTITY/.test(worker) && /createBrowserIdentity/.test(vault));
record('Worker create never returns privateKey field', /createBrowserIdentity[\s\S]*?identityMeta/.test(worker) && !/return\s*\{[^}]*privateKey/.test(worker.match(/async function createBrowserIdentity[\s\S]*?finally/)?.[0] || ''));
record('Banned GET_K/EXPORT_RAW_K', /GET_K/.test(worker) && /EXPORT_RAW_K/.test(worker) && /READ_PRIVATE_KEY/.test(worker));
record('SIGN_EMAIL_REGISTRY wired', /SIGN_EMAIL_REGISTRY/.test(signer) && /SIGN_EMAIL_REGISTRY/.test(worker) && /signEmailRegistry/.test(signer));
record('guest-auth Worker create path', /shouldUseWorkerCreate/.test(guest) && /createBrowserIdentity/.test(guest) && /workerCreate/.test(guest));
record('guest-auth auth without App.privateKey', /isAuthenticatedIdentity/.test(guest));
record('key-viewer Worker blocks raw K', /isWorkerAuthoritative/.test(keyViewer) && /F5B/.test(keyViewer));
record('account Worker export deferred', /F5B/.test(account) && /isWorkerAuthoritative/.test(account));
record('compose uses hasIdentityKey', /hasIdentityKey/.test(compose) && !/!app\.privateKey \|\| !app\.publicKey \|\| typeof app\.finalizeEvent/.test(compose));
record('games no opener.privateKey', !/openerApp\.privateKey/.test(nzp) && !/openerApp\.privateKey/.test(hexgl) && !/openerApp\.privateKey/.test(doom));
record('games no readPrivateKeyRaw pull', !/readPrivateKeyRaw\(\)/.test(nzp) && !/readPrivateKeyRaw\(\)/.test(hexgl) && !/readPrivateKeyRaw\(\)/.test(doom.match(/async function connectNostr[\s\S]*?SimplePool/)?.[0] || 'readPrivateKeyRaw()'));
record('dropPageMemoryPrivateKey', /dropPageMemoryPrivateKey/.test(keyStore) && /dropPageMemoryPrivateKey/.test(vault));
record('native bridge Worker blocks readWebPrivateKeyRaw', /isWorkerAuthoritative/.test(native) && /readWebPrivateKeyRaw/.test(native));
record('signer App.signEvent game bridge', /signEventForOpener/.test(signer) && /33211/.test(signer));

// F5A hotfix: Worker-auth boot must not fall through to MAIN hydrate
record(
  'WORKER_AUTH_BOOT_CAN_FALL_THROUGH_TO_MAIN=false',
  /WORKER_AUTH_BOOT_CAN_FALL_THROUGH_TO_MAIN=false/.test(appJs) &&
    /WORKER_VAULT_INITIALIZING/.test(appJs) &&
    /tryActivateVault/.test(appJs) &&
    !/flagOn && !isNative && !sessionOnly && App\.SosCryptoWorkerVault\)/.test(appJs),
);
record(
  'WORKER_MODE_BROWSERSECURE_MEMORY_PRIV=false',
  /workerAuthPageOwnsNoRawK/.test(keyStore) &&
    /WORKER_MODE_BROWSERSECURE_MEMORY_PRIV=false/.test(keyStore) &&
    /workerAuthPageOwnsNoRawK\(\)/.test(keyStore),
);
record(
  'WORKER_CREATED_IDENTITY_WRITES_LEGACY_LS=false',
  /workerAuthPageOwnsNoRawK\(\)/.test(keyStore) &&
    /writeBrowserVerified[\s\S]*?workerAuthPageOwnsNoRawK[\s\S]*?return false/.test(keyStore) &&
    /writePrivateKeyRaw[\s\S]*?workerAuthPageOwnsNoRawK[\s\S]*?return false/.test(keyStore),
);
record(
  'WORKER_AUTH_RAW_K_FALLBACK=false',
  /WORKER_AUTH_RAW_K_FALLBACK=false/.test(appJs) && /finishWorkerBootFail/.test(appJs),
);

// Live Worker create smoke (Node Worker if available)
async function liveCreateSmoke() {
  const { Worker } = await import('node:worker_threads');
  // Our sos-crypto-worker.js is browser Worker (importScripts) — skip live node worker.
  // Instead static + optional jsdom-less check of create atomic markers:
  record('create refuses duplicate CREATE_ALREADY_EXISTS', /CREATE_ALREADY_EXISTS/.test(worker));
  record('create verify delete on mismatch', /CREATE_VERIFY_FAILED/.test(worker));
  record('createInFlight guard', /createInFlight/.test(worker));
  record('stale nonce reject in vault', /STALE_CREATE_REJECTED/.test(vault));
}

await liveCreateSmoke();

// Category inventory counts (live feature modules)
const liveFeatureFiles = [
  'compose.js',
  'chat-service.js',
  'chat-p2p-file.js',
  'chat-p2p-secure-v2.js',
  'p2p-video-sharing.js',
  'chat-voice-call.js',
  'chat-video-call.js',
  'media-server-e2ee.js',
];
let featureK = 0;
for (const f of liveFeatureFiles) {
  const src = read(f);
  // Count App.privateKey reads that are not assignments to null
  const matches = src.match(/App\.privateKey(?!\s*=\s*null)/g) || [];
  // Filter comments roughly
  for (const m of matches) featureK++;
}
record('DIRECT_FEATURE_MODULE_K_CONSUMERS low', featureK <= 6, 'count=' + featureK);

console.log(fail ? `F5A_GATE FAIL (${pass} passed, ${fail} failed)` : `F5A_GATE PASS (${pass} passed, 0 failed)`);
process.exit(fail ? 1 : 0);
