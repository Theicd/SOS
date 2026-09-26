/**
 * Package 894 RC — SIGN_FEED allowlist + negative kinds gate.
 * Run: node qa/package894-sign-feed-allowlist-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { generateSecretKey, getPublicKey, utils, finalizeEvent } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'package894-sign-feed-allowlist-report.json');

const report = {
  gate: 'PACKAGE894_SIGN_FEED_ALLOWLIST',
  status: 'FAIL',
  ts: new Date().toISOString(),
  results: [],
  SIGN_FEED_ALLOWED_KINDS: null,
  SHARE_FIX_MINIMAL_AUTHORITY_GATE: 'FAIL',
  SIGN_FEED_NEGATIVE_ALLOWLIST_GATE: 'FAIL',
};

function record(name, ok, detail) {
  report.results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(ok ? 'PASS' : 'FAIL', name, detail || '');
}

function hex(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function loadSigner(privHex) {
  const pub = getPublicKey(utils.hexToBytes(privHex));
  const sk = utils.hexToBytes(privHex);
  const root = {
    NostrApp: {
      privateKey: privHex,
      publicKey: pub,
      identityState: 'IDENTITY_OK',
      finalizeEvent: (draft, key) => {
        const k = typeof key === 'string' ? utils.hexToBytes(key.replace(/^0x/, '')) : key;
        return finalizeEvent(draft, k);
      },
      hexToBytes: (h) => utils.hexToBytes(String(h || '').replace(/^0x/, '')),
    },
    SosSessionAuthority: null,
    NostrTools: {
      finalizeEvent,
      getPublicKey,
      utils,
      nip04: {},
      nip44: {},
    },
    console,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
  };
  const code = fs.readFileSync(path.join(ROOT, 'sos-crypto-signer.js'), 'utf8');
  vm.runInNewContext(code, root, { filename: 'sos-crypto-signer.js' });
  return { App: root.NostrApp, pub, privHex };
}

const src = fs.readFileSync(path.join(ROOT, 'sos-crypto-signer.js'), 'utf8');
const feedMatch = src.match(/SIGN_FEED:\s*\{\s*kinds:\s*\[([^\]]+)\]/);
const kinds = feedMatch
  ? feedMatch[1]
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n))
  : [];
report.SIGN_FEED_ALLOWED_KINDS = kinds;

record('SIGN_FEED_KIND1_ALLOWED', kinds.includes(1), JSON.stringify(kinds));
record('SIGN_FEED_KIND6_ALLOWED', kinds.includes(6), JSON.stringify(kinds));
const exact16 = kinds.length === 2 && kinds.includes(1) && kinds.includes(6);
record('SIGN_FEED_ARBITRARY_KIND_ALLOWED=false', exact16, JSON.stringify(kinds));
record('SIGN_FEED_EXACT_ALLOWLIST_1_6', exact16, JSON.stringify(kinds));
record('no wildcard kinds in SIGN_FEED', !/\*/.test(feedMatch?.[0] || ''), feedMatch?.[0]);
record('opener signEvent is game-kinds-only', /kind === 33201/.test(src) && /opener signEvent kind not allowed/.test(src));
record('no getPrivateKey export', !/getPrivateKey/.test(src));
record('no nsec encode/export API', !/nsecEncode|exportNsec|getNsec/.test(src));

const { App, pub } = loadSigner(hex(generateSecretKey()));
const S = App.SosCryptoSigner;

async function trySign(kind) {
  const draft = {
    kind,
    pubkey: pub,
    created_at: Math.floor(Date.now() / 1000),
    tags:
      kind === 6
        ? [
            ['e', '11'.repeat(32)],
            ['p', '22'.repeat(32)],
            ['t', 'israel-network'],
          ]
        : [['t', 'israel-network']],
    content: kind === 6 ? '' : 'rc894-test',
  };
  try {
    // Prefer validate path: if KIND_NOT_ALLOWED thrown early, capture that.
    const ev = await Promise.resolve(S.signFeedEvent(draft));
    return { ok: true, id: ev?.id, kind: ev?.kind, sig: !!ev?.sig };
  } catch (e) {
    return { ok: false, error: String(e.message || e), code: e.code };
  }
}

// Also unit-test validateDraft allowlist without finalize: use reject message discrimination
function allowlistOnly(kind) {
  try {
    // call through signFeedEvent; classify
    return null;
  } catch (_e) {
    return null;
  }
}

const k1 = await trySign(1);
const k6 = await trySign(6);
const k1Allow = k1.ok || !/not allowed for SIGN_FEED/i.test(k1.error || '');
const k6Allow = k6.ok || !/not allowed for SIGN_FEED/i.test(k6.error || '');
record('runtime kind 1 accepted by allowlist', k1Allow, k1.ok ? k1.id?.slice(0, 12) : k1.error);
record('runtime kind 6 accepted by allowlist', k6Allow, k6.ok ? k6.id?.slice(0, 12) : k6.error);
record('runtime kind 1 signed end-to-end', !!k1.ok, k1.error || '');
record('runtime kind 6 signed end-to-end', !!k6.ok, k6.error || '');

const negatives = [0, 3, 4, 7, 25050, 1059, 42, 30078];
for (const k of negatives) {
  const r = await trySign(k);
  record(`runtime kind ${k} rejected by SIGN_FEED`, !r.ok, r.error || 'UNEXPECTED_ACCEPT');
}

report.SHARE_FIX_MINIMAL_AUTHORITY_GATE =
  exact16 && k1Allow && k6Allow && /opener signEvent kind not allowed/.test(src) ? 'PASS' : 'FAIL';
report.SIGN_FEED_NEGATIVE_ALLOWLIST_GATE = negatives.every((k) => {
  const row = report.results.find((x) => x.name === `runtime kind ${k} rejected by SIGN_FEED`);
  return row && row.ok;
})
  ? 'PASS'
  : 'FAIL';
report.SIGN_FEED_KIND1_ALLOWED = kinds.includes(1);
report.SIGN_FEED_KIND6_ALLOWED = kinds.includes(6);
report.SIGN_FEED_ARBITRARY_KIND_ALLOWED = !exact16;
report.status =
  report.SHARE_FIX_MINIMAL_AUTHORITY_GATE === 'PASS' &&
  report.SIGN_FEED_NEGATIVE_ALLOWLIST_GATE === 'PASS'
    ? 'PASS'
    : 'FAIL';

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('STATUS', report.status);
console.log('SIGN_FEED_ALLOWED_KINDS', report.SIGN_FEED_ALLOWED_KINDS);
process.exit(report.status === 'PASS' ? 0 : 1);
