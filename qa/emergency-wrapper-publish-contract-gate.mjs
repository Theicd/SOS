/**
 * Deterministic regression: emergency-wrapper must preserve SimplePool.publish Promise[] contract.
 * Reproduces the async-await-on-array defect that broke MD2 HELLO relay delivery.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import vm from 'vm';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(ROOT, 'qa', 'emergency-wrapper-publish-contract-report.json');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || null });
  console.log(ok ? 'PASS' : 'FAIL', name, detail || '');
  return !!ok;
}

const src = fs.readFileSync(path.join(ROOT, 'emergency-wrapper.js'), 'utf8');
check(
  'NO_ASYNC_PUBLISH_WRAPPER',
  !/App\.pool\.publish\s*=\s*async\s+function/.test(src),
  'async publish wrapper awaits Promise[] without settling relays',
);
check(
  'PRESERVES_ARRAY_RETURN',
  /return pubs/.test(src) && /Array\.isArray\(res\)/.test(src),
  'must normalize and return Promise[]',
);
check(
  'MIRROR_AFTER_ALLSETTLED',
  /Promise\.allSettled\(pubs\)/.test(src),
  'emergency mirror must not block or replace publish return',
);

// Runtime simulation of broken vs fixed contract
function brokenAsyncWrap(originalPublish) {
  return async function (relays, event) {
    const res = await originalPublish(relays, event); // BUG: await array
    return res;
  };
}

function fixedWrap(originalPublish) {
  return function (relays, event) {
    const res = originalPublish(relays, event);
    const pubs = Array.isArray(res) ? res : res != null ? [res] : [];
    return pubs;
  };
}

function fakeSimplePublish(relays) {
  return relays.map(
    (url) =>
      new Promise((resolve) => {
        setTimeout(() => resolve('ok:' + url), 30);
      }),
  );
}

async function simulate(label, wrap) {
  const publish = wrap(fakeSimplePublish);
  const raw = publish(['wss://a', 'wss://b'], { id: 'x' });
  let pubs = raw;
  if (pubs && typeof pubs.then === 'function' && !Array.isArray(pubs)) {
    pubs = await pubs;
  }
  let list = Array.isArray(pubs) ? pubs : pubs != null ? [pubs] : [];
  if (list.length === 1 && Array.isArray(list[0])) list = list[0];
  // Wrong caller pattern (pre-fix MD2): allSettled([outerPromise])
  const wrong = await Promise.allSettled(Array.isArray(raw) ? raw : [raw]);
  const wrongInnerAwaited = wrong.every((s) => s.status === 'fulfilled' && String(s.value).startsWith('ok:'));
  // Correct settlement
  const settled = await Promise.allSettled(list);
  const ok = settled.filter((s) => s.status === 'fulfilled' && String(s.value).startsWith('ok:')).length;
  return { label, isArrayRaw: Array.isArray(raw), wrongInnerAwaited, ok, settledLen: settled.length };
}

const broken = await simulate('broken', brokenAsyncWrap);
const fixed = await simulate('fixed', fixedWrap);

check('BROKEN_REPRO_WRONG_WRAP_DOES_NOT_AWAIT_RELAYS', broken.wrongInnerAwaited === false && broken.ok === 2, broken);
check('FIXED_RAW_IS_ARRAY', fixed.isArrayRaw === true, fixed);
check('FIXED_SETTLES_RELAY_OK', fixed.ok === 2 && fixed.wrongInnerAwaited === true, fixed);

// Source-level load of fixed emergency-wrapper against mock App
const mock = {
  window: {
    NostrApp: {
      pool: {
        publish: fakeSimplePublish,
      },
      AndroidBridge: null,
    },
  },
};
vm.runInNewContext(src + '\n;this.__App = window.NostrApp;', {
  window: mock.window,
  console,
  setInterval: (fn) => {
    fn();
    return 1;
  },
  clearInterval: () => {},
  setTimeout: (fn) => {
    try {
      fn();
    } catch (_e) {}
    return 0;
  },
  clearTimeout: () => {},
});
const patched = mock.window.NostrApp.pool.publish;
const out = patched(['wss://a', 'wss://b'], { kind: 1, id: '1', created_at: 1, tags: [] });
check('RUNTIME_PATCH_RETURNS_ARRAY', Array.isArray(out) && out.length === 2, {
  isArray: Array.isArray(out),
  len: out && out.length,
});
if (Array.isArray(out)) {
  const settled = await Promise.allSettled(out);
  check(
    'RUNTIME_PATCH_SETTLES_OK',
    settled.every((s) => s.status === 'fulfilled'),
    settled.map((s) => s.status),
  );
}

const ok = checks.every((c) => c.ok);
const report = {
  generatedAt: new Date().toISOString(),
  ok,
  checks,
  MD2_APP_POOL_ROOT_CAUSE:
    'emergency-wrapper.js async App.pool.publish awaited Promise[] (no-op), returned Promise<Promise[]>; MD2 allSettled never waited per-relay NIP-01 OK',
  PUBLISH_API_CONTRACT: 'SimplePool.publish(relays, event) => Promise[] (per relay)',
};
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log(ok ? 'GATE_PASS' : 'GATE_FAIL');
process.exit(ok ? 0 : 1);
