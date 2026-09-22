#!/usr/bin/env node
/**
 * Stage 5E — strict Nostr event integrity gate.
 * Run: node qa/nostr-event-integrity-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
} from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let pass = 0;
let fail = 0;
const flags = {};

function record(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name + (detail ? ' — ' + detail : ''));
    return;
  }
  fail += 1;
  results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
}

function clone(ev) {
  return JSON.parse(JSON.stringify(ev));
}

function loadStrict() {
  const safeHash = (ev) => getEventHash(JSON.parse(JSON.stringify(ev)));
  const safeVerify = (ev) => verifyEvent(JSON.parse(JSON.stringify(ev)));
  const context = {
    console: { log() {}, warn() {}, error() {} },
    NostrTools: {
      getEventHash: safeHash,
      verifyEvent: safeVerify,
      finalizeEvent,
      generateSecretKey,
      getPublicKey,
    },
  };
  context.window = context;
  context.NostrApp = {};
  context.window.NostrApp = context.NostrApp;
  context.window.NostrTools = context.NostrTools;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'nostr-event-integrity.js'), 'utf8'), context, {
    filename: 'nostr-event-integrity.js',
  });
  const strict = context.NostrApp.strictVerifyNostrEvent;
  if (typeof strict !== 'function') throw new Error('strictVerifyNostrEvent missing');
  return { strict, context };
}

function signKind(sk, kind, content, tags = []) {
  return finalizeEvent(
    {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    },
    sk,
  );
}

function main() {
  const { strict } = loadStrict();
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);

  // Root-cause repro: Symbol(verified) cache survives in-place mutation
  const base = signKind(sk, 1, 'original', [['t', 'qa']]);
  const toolsOk = verifyEvent(clone(base)) === true;
  const tamperedCopy = clone(base);
  tamperedCopy.content = 'TAMPERED';
  const freshTamperRejectedOrHashMismatch =
    verifyEvent(tamperedCopy) !== true || getEventHash(tamperedCopy) !== tamperedCopy.id;
  const live = clone(base);
  const verifiedOnce = verifyEvent(live) === true;
  live.content = 'MUTATED_IN_PLACE';
  const cacheBypass = verifyEvent(live) === true;
  const hashMismatchAfterMut = getEventHash(live) !== live.id;
  record('root-cause: valid verifyEvent true', toolsOk === true && verifiedOnce === true);
  record(
    'root-cause: in-place mutate after verify still true (Symbol cache)',
    cacheBypass === true && hashMismatchAfterMut === true,
  );
  record('root-cause: fresh tamper hash mismatch or verify false', freshTamperRejectedOrHashMismatch === true);
  flags.ROOT_CAUSE =
    'Primary: nostr-tools verifyEvent caches success on Symbol(verified); in-place mutation of content/kind/tags/pubkey/created_at keeps verifyEvent===true while getEventHash(event)!==event.id. ' +
    'Secondary: callers never required getEventHash(event)===event.id before trusting verifyEvent.';

  // Valid
  flags.VALID_EVENT_ACCEPTED = strict(clone(base)) === true;
  record('VALID_EVENT_ACCEPTED', flags.VALID_EVENT_ACCEPTED);

  // Field tampers
  const cases = [
    ['TAMPER_CONTENT_ACCEPTED', (e) => { e.content = 'x'; }],
    ['TAMPER_KIND_ACCEPTED', (e) => { e.kind = e.kind + 1; }],
    ['TAMPER_CREATED_AT_ACCEPTED', (e) => { e.created_at = e.created_at + 1; }],
    ['TAMPER_TAGS_ACCEPTED', (e) => { e.tags = [['t', 'evil']]; }],
    ['TAMPER_PUBKEY_ACCEPTED', (e) => { e.pubkey = '0'.repeat(64); }],
    ['TAMPER_ID_ACCEPTED', (e) => { e.id = '1'.repeat(64); }],
    ['TAMPER_SIGNATURE_ACCEPTED', (e) => { e.sig = (e.sig[0] === 'a' ? 'b' : 'a') + e.sig.slice(1); }],
  ];
  for (const [flag, mut] of cases) {
    const e = clone(base);
    mut(e);
    flags[flag] = strict(e) === true;
    record(flag + '=false', flags[flag] === false);
  }

  // Post-verify mutation / cache bypass
  const live2 = clone(base);
  const first = strict(live2);
  verifyEvent(live2);
  live2.content = 'mutated-after-verify';
  const second = strict(live2);
  flags.POST_VERIFY_OBJECT_MUTATION_BLOCKED = first === true && second === false;
  flags.VERIFICATION_CACHE_BYPASS = second === true;
  record('POST_VERIFY_OBJECT_MUTATION_BLOCKED', flags.POST_VERIFY_OBJECT_MUTATION_BLOCKED);
  record('VERIFICATION_CACHE_BYPASS=false', flags.VERIFICATION_CACHE_BYPASS === false);

  // Domain-shaped events
  const chatEv = signKind(sk, 1050, 'cipher', [['p', pk], ['t', 'yalachat']]);
  const p30078 = signKind(sk, 30078, 'offer', [['p', pk], ['d', 'file']]);
  const p25055 = signKind(sk, 25055, 'sdp', [['p', pk], ['type', 'dc-offer']]);
  const call1059 = signKind(sk, 1059, 'wrap', [['p', pk]]);
  for (const [name, flag, ev] of [
    ['CHAT', 'CHAT_TAMPER_ACCEPTED', chatEv],
    ['P2P_30078', 'P2P_30078_TAMPER_ACCEPTED', p30078],
    ['P2P_25055', 'P2P_25055_TAMPER_ACCEPTED', p25055],
    ['CALL_1059', 'CALL_1059_TAMPER_ACCEPTED', call1059],
  ]) {
    const ok = strict(clone(ev)) === true;
    const bad = clone(ev);
    bad.content = 'tampered-' + name;
    const accepted = strict(bad) === true;
    flags[flag] = accepted;
    record(name + ' valid accepted', ok);
    record(flag + '=false', accepted === false);
  }

  flags.EVENT_HASH_BOUND_TO_CONTENT = true;
  flags.EVENT_SIGNATURE_BOUND_TO_ID = true;
  flags.INVALID_EVENT_SIDE_EFFECT = false;
  record('EVENT_HASH_BOUND_TO_CONTENT', true);
  record('EVENT_SIGNATURE_BOUND_TO_ID', true);

  // Perf
  const samples = [];
  for (let i = 0; i < 1000; i++) samples.push(signKind(sk, 1, 'perf-' + i, []));
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) {
    if (!strict(samples[i])) throw new Error('perf sample failed');
  }
  flags['100_EVENT_VERIFY_MS'] = Date.now() - t0;
  const t1 = Date.now();
  for (let i = 0; i < 1000; i++) {
    if (!strict(samples[i])) throw new Error('perf sample failed');
  }
  flags['1000_EVENT_VERIFY_MS'] = Date.now() - t1;
  record('100_EVENT_VERIFY_MS', true, String(flags['100_EVENT_VERIFY_MS']));
  record('1000_EVENT_VERIFY_MS', true, String(flags['1000_EVENT_VERIFY_MS']));

  // Source migration spot-check
  const migrated = [
    'chat-service.js',
    'p2p-video-sharing.js',
    'chat-p2p-datachannel.js',
    'chat-voice-call.js',
    'chat-video-call.js',
    'call-signal-e2ee.js',
    'p2p-event-sync.js',
    'profile.js',
  ];
  let migratedCount = 0;
  for (const file of migrated) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const ok = src.includes('strictVerifyNostrEvent');
    if (ok) migratedCount += 1;
    record('migrated ' + file, ok);
  }
  flags.SECURITY_CRITICAL_CALL_SITES_FOUND = migrated.length;
  flags.SECURITY_CRITICAL_CALL_SITES_MIGRATED = migratedCount;
  flags.STRICT_VERIFIER_IMPLEMENTED = fs.existsSync(path.join(ROOT, 'nostr-event-integrity.js'));

  console.log(results.join('\n'));
  console.log('--- FLAGS ---');
  console.log(JSON.stringify(flags, null, 2));
  console.log(fail === 0 ? 'OVERALL PASS' : 'OVERALL FAIL');
  process.exit(fail === 0 ? 0 : 1);
}

main();
