#!/usr/bin/env node
/**
 * MD4 S6 — Full Security Negative Matrix
 * Fresh adversarial verification across S0–S5 (+ MD1–MD3 deps) via real code paths.
 * Orchestrates existing security gates + cross-boundary supplement. No product redesign.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';
import { schnorr } from '@noble/curves/secp256k1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'md4-s6-security-matrix-report.json');
const CASES_OUT = path.join(ROOT, 'qa', 'md4-s6-security-matrix-cases.json');
const RUN_ID = process.env.SOS_MD4_S6_RUN_ID || crypto.randomUUID();
const STARTED = new Date().toISOString();
const LOG_DIR = path.join(ROOT, 'qa', '.md4-s6-matrix');
fs.mkdirSync(LOG_DIR, { recursive: true });

const cases = [];
function record(c) {
  const row = {
    id: c.id,
    domain: c.domain,
    threat: c.threat,
    invariant: c.invariant,
    entryPoint: c.entryPoint,
    testType: c.testType,
    inputClass: c.inputClass || 'synthetic-adversarial',
    expected: c.expected,
    observed: c.observed,
    protectedStateChanged: !!c.protectedStateChanged,
    status: c.status, // PASS | FAIL | NOT_VERIFIED | BLOCKED | NOT_APPLICABLE
    justification: c.justification || null,
    command: c.command || null,
    exitCode: c.exitCode == null ? null : c.exitCode,
    runId: c.runId || RUN_ID,
    ts: new Date().toISOString(),
    evidencePath: c.evidencePath || OUT,
  };
  cases.push(row);
  const tag = row.status === 'PASS' ? 'PASS' : row.status === 'FAIL' ? 'FAIL' : row.status;
  console.log(tag, row.id, row.observed ? JSON.stringify(row.observed).slice(0, 160) : row.justification || '');
  return row;
}

function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_e) {
    return null;
  }
}

function mapChildResult(opts) {
  const { id, domain, threat, invariant, entryPoint, testType, expected, reportPath, key, command, exitCode, childRunId } = opts;
  const rep = loadJson(reportPath);
  const bucket = (rep && (rep.results || rep.gates || rep.checks)) || null;
  let ok = null;
  let detail = null;
  if (bucket && bucket[key] != null) {
    const v = bucket[key];
    if (typeof v === 'boolean') {
      ok = v;
      detail = v;
    } else if (v && typeof v === 'object' && 'ok' in v) {
      ok = !!v.ok;
      detail = v.detail !== undefined ? v.detail : v;
    }
  } else if (rep && (rep.STATUS === 'PASS' || rep.status === 'PASS') && opts.requireKey === false) {
    ok = true;
    detail = { gateStatus: rep.STATUS || rep.status };
  }
  if (exitCode !== 0 && ok == null) {
    return record({
      id,
      domain,
      threat,
      invariant,
      entryPoint,
      testType,
      expected,
      observed: { childExit: exitCode, missingKey: key },
      protectedStateChanged: false,
      status: 'FAIL',
      command,
      exitCode,
      runId: childRunId,
      evidencePath: reportPath,
    });
  }
  if (ok == null) {
    return record({
      id,
      domain,
      threat,
      invariant,
      entryPoint,
      testType,
      expected,
      observed: { missingKey: key, reportStatus: rep && (rep.STATUS || rep.status) },
      protectedStateChanged: false,
      status: 'NOT_VERIFIED',
      justification: 'Child gate ran but case key not present in fresh report',
      command,
      exitCode,
      runId: childRunId,
      evidencePath: reportPath,
    });
  }
  return record({
    id,
    domain,
    threat,
    invariant,
    entryPoint,
    testType,
    expected,
    observed: detail,
    protectedStateChanged: false,
    status: ok === expected.ok ? 'PASS' : 'FAIL',
    command,
    exitCode,
    runId: childRunId,
    evidencePath: reportPath,
  });
}

function runChild(name, cmd, envExtra = {}) {
  const childRunId = crypto.randomUUID();
  const log = path.join(LOG_DIR, name + '.txt');
  const env = Object.assign({}, process.env, envExtra, { SOS_MD4_S6_CHILD: name });
  console.log('CHILD_START', name, 'runId=' + childRunId);
  let exitCode = 1;
  try {
    execSync(cmd, {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
    });
    exitCode = 0;
  } catch (e) {
    exitCode = typeof e.status === 'number' ? e.status : 1;
    const out = ((e.stdout && e.stdout.toString()) || '') + ((e.stderr && e.stderr.toString()) || '');
    fs.writeFileSync(log, out.slice(-500000));
    console.log('CHILD_FAIL', name, 'exit=' + exitCode);
    return { exitCode, childRunId, log };
  }
  // capture tail via re-run not needed; write marker
  fs.writeFileSync(log, 'OK exit=0 runId=' + childRunId + '\n');
  console.log('CHILD_OK', name, 'exit=0');
  return { exitCode, childRunId, log };
}

// ---------- Phase B/C catalog mapping from fresh child gates ----------
const childPlan = [
  {
    name: 's1-device',
    cmd: 'node qa/md4-s1-durable-device-gate.mjs',
    env: { SOS_MD4_S1_RUN_ID: '' },
    report: 'qa/md4-s1-durable-device-report.json',
    maps: [
      ['B1-01', 'DEVICE_AUTH', 'Valid authorization baseline', 'verifyStrict accepts good auth', 'SosMd4DeviceAuth.verifyStrict', 'VERIFY_STRICT_GOOD', { ok: true }],
      ['B1-02', 'DEVICE_AUTH', 'Invalid Schnorr signature', 'Forged auth rejected', 'verifyStrict', 'NEG_BAD_SIGNATURE', { ok: true }],
      ['B1-03', 'DEVICE_AUTH', 'Wrong account P', 'ACCOUNT_MISMATCH', 'verifyStrict', 'NEG_WRONG_ACCOUNT', { ok: true }],
      ['B1-04', 'DEVICE_AUTH', 'Wrong deviceId', 'DEVICE_ID_MISMATCH', 'verifyStrict', 'NEG_WRONG_DEVICE', { ok: true }],
      ['B1-05', 'DEVICE_AUTH', 'Wrong D_sign', 'D_SIGN_MISMATCH', 'verifyStrict', 'NEG_WRONG_D_SIGN', { ok: true }],
      ['B1-06', 'DEVICE_AUTH', 'Expired authorization', 'EXPIRED', 'verifyStrict', 'NEG_EXPIRED', { ok: true }],
      ['B1-07', 'DEVICE_AUTH', 'Missing DEVICE_HISTORY_SYNC', 'MISSING_DEVICE_HISTORY_SYNC', 'verifyStrict', 'NEG_MISSING_HISTORY_SYNC', { ok: true }],
      ['B1-08', 'DEVICE_AUTH', 'Revoked device', 'REVOKED', 'verifyStrict', 'NEG_REVOKED', { ok: true }],
      ['B1-09', 'DEVICE_AUTH', 'Stale authEpoch', 'AUTH_EPOCH_MISMATCH', 'verifyStrict', 'NEG_AUTH_EPOCH', { ok: true }],
      ['B1-10', 'DEVICE_AUTH', 'Account switch isolation', 'Cross-account store isolation', 'device-store', 'ACCOUNT_SWITCH_ISOLATION', { ok: true }],
      ['B1-11', 'DEVICE_AUTH', 'Tampered stored authorization', 'Corrupt IDB fail-closed', 'device-store', 'CORRUPT_IDB_FAIL_CLOSED', { ok: true }],
      ['B1-12', 'DEVICE_AUTH', 'Unsupported crypto/storage env', 'support probe', 'device-store', 'UNSUPPORTED_BROWSER_API', { ok: true }],
      ['B1-13', 'CROSS_PROTOCOL', 'kind25060 hist/pair confusion', 'Protocol isolation', 'classifyKind25060', 'KIND25060_COLLISION_FAIL_CLOSED', { ok: true }],
      ['B1-14', 'KEY_LEAK', 'No private material in localStorage', 'No nsec/priv in LS', 'localStorage scan', 'LOCALSTORAGE_NO_PRIV', { ok: true }],
    ],
  },
  {
    name: 's2-cki',
    cmd: 'node qa/md4-s2-cki-gate.mjs',
    env: { SOS_MD4_S2_RUN_ID: '' },
    report: 'qa/md4-s2-cki-report.json',
    maps: [
      ['B2-01', 'CKI', 'Wrong recipient D_enc', 'Sealed index open fails', 'openConversationKeyIndex', 'NEG_WRONG_DENC_DESKTOP', { ok: true }],
      ['B2-02', 'CKI', 'Replay old index export', 'REPLAY_EXPORT_SESSION', 'openConversationKeyIndex', 'NEG_REPLAY_DESKTOP', { ok: true }],
      ['B2-03', 'CKI', 'Index ciphertext tampering', 'AEAD_FAIL', 'openConversationKeyIndex', 'NEG_CORRUPTED_AEAD', { ok: true }],
      ['B2-04', 'CKI', 'Wrong authorization epoch', 'AUTH_EPOCH_MISMATCH', 'export/open', 'NEG_STALE_AUTH_EPOCH', { ok: true }],
      ['B2-05', 'CKI', 'Cross-account injection', 'ACCOUNT_MISMATCH', 'openConversationKeyIndex', 'NEG_CROSS_ACCOUNT_INJECTION', { ok: true }],
      ['B2-06', 'CKI', 'Missing/forged root signature', 'BAD/MISSING_SIGNATURE', 'export path', 'NEG_MISSING_OR_FORGED_SIG', { ok: true }],
      ['B2-07', 'CKI', 'Missing HISTORY_SYNC on export', 'capability gate', 'export', 'NEG_MISSING_HISTORY_SYNC', { ok: true }],
      ['B2-08', 'CKI', 'Plaintext downgrade', 'PLAINTEXT_DOWNGRADE rejected', 'seal shape', 'NEG_PLAINTEXT_DOWNGRADE', { ok: true }],
      ['B2-09', 'CKI', 'No CK in public summary', 'no key leakage', 'public summary', 'NO_CK_IN_PUBLIC_SUMMARY', { ok: true }],
      ['B2-10', 'CKI', 'No key material to console', 'log hygiene', 'console', 'NEG_KEY_MATERIAL_CONSOLE', { ok: true }],
      ['B2-11', 'CKI', 'No Root K export API', 'no root derive/export', 'static', 'NO_GENERIC_ROOT_DERIVE_API', { ok: true }],
      ['B2-12', 'CKI', 'Bridge sealed-only', 'no nsec/root bridge', 'SosJsBridge', 'BRIDGE_SEALED_ONLY', { ok: true }],
    ],
  },
  {
    name: 's3-neg',
    cmd: 'node qa/md4-s3-security-negatives-gate.mjs',
    env: { SOS_MD4_S3_NEG_RUN_ID: '' },
    report: 'qa/md4-s3-security-negatives-report.json',
    maps: [
      ['B3-01', 'HISTORY', 'Unlinked desktop sync', 'NO_DEVICE fail-closed', 'history bootstrap', 'NEG_UNLINKED_DESKTOP', { ok: true }],
      ['B3-02', 'HISTORY', 'Cross-protocol kind25060', 'collision fail-closed', 'classify', 'NEG_CROSS_PROTOCOL_KIND25060', { ok: true }],
      ['B3-03', 'HISTORY', 'Plaintext downgrade', 'rejected', 'import', 'NEG_PLAINTEXT_DOWNGRADE', { ok: true }],
      ['B3-04', 'HISTORY', 'Forged event identity', 'FORGED_EVENT_IDENTITY', 'import', 'NEG_FORGED_EVENT_IDENTITY', { ok: true }],
      ['B3-05', 'HISTORY', 'Conflicting duplicate event', 'CONFLICTING_EVENT', 'import', 'NEG_CONFLICTING_DUPLICATE_EVENT', { ok: true }],
      ['B3-06', 'HISTORY', 'Cross-account import', 'rejected', 'import', 'NEG_CROSS_ACCOUNT_IMPORT', { ok: true }],
      ['B3-07', 'HISTORY', 'Unauthorized conversation', 'rejected', 'import', 'NEG_UNAUTHORIZED_CONVERSATION', { ok: true }],
      ['B3-08', 'HISTORY', 'Expired authorization mid-bootstrap', 'rejected', 'auth gate', 'NEG_EXPIRED_AUTHORIZATION', { ok: true }],
      ['B3-09', 'HISTORY', 'Stale authEpoch', 'rejected', 'auth gate', 'NEG_STALE_AUTH_EPOCH', { ok: true }],
      ['B3-10', 'HISTORY', 'Wrong global P', 'rejected', 'auth gate', 'NEG_WRONG_GLOBAL_P', { ok: true }],
      ['B3-11', 'HISTORY', 'Missing HISTORY_SYNC', 'rejected', 'auth gate', 'NEG_MISSING_DEVICE_HISTORY_SYNC', { ok: true }],
      ['B3-12', 'HISTORY', 'Oversized bootstrap bound', 'MAX_BATCH=50', 'resource', 'NEG_OVERSIZED_BOOTSTRAP_BOUND', { ok: true }],
      ['B3-13', 'KEY_LEAK', 'No secret leakage in source', 'no priv logging', 'static', 'NEG_SECRET_LEAKAGE_SOURCE', { ok: true }],
      ['B3-14', 'CKI', 'No plaintext CKI persist', 'PERSISTED_PLAINTEXT_CKI:false', 'static', 'NEG_NO_PLAINTEXT_CKI_PERSIST', { ok: true }],
    ],
  },
  {
    name: 's4-neg',
    cmd: 'node qa/md4-s4-security-negatives-gate.mjs',
    env: { SOS_MD4_S4_NEG_RUN_ID: '' },
    report: 'qa/md4-s4-security-negatives-report.json',
    maps: [
      ['B4-01', 'CHECKPOINT', 'Tampered durable checkpoint', 'fail-closed', 'checkpoint load', 'NEG_CHECKPOINT_TAMPER', { ok: true }],
      ['B4-02', 'CHECKPOINT', 'Cross-account checkpoint reuse', 'rejected', 'checkpoint', 'NEG_CHECKPOINT_WRONG_ACCOUNT', { ok: true }],
      ['B4-03', 'CHECKPOINT', 'Wrong device resume', 'rejected', 'checkpoint', 'NEG_CHECKPOINT_WRONG_DEVICE', { ok: true }],
      ['B4-04', 'CHECKPOINT', 'Stale epoch resume', 'rejected', 'checkpoint', 'NEG_CHECKPOINT_STALE_EPOCH', { ok: true }],
      ['B4-05', 'TOMBSTONE', 'Resurrection after tombstone', 'suppressed', 'import', 'NEG_RESURRECTION_AFTER_TOMBSTONE', { ok: true }],
      ['B4-06', 'TOMBSTONE', 'Unauthorized tombstone', 'rejected', 'applyTombstone', 'NEG_UNAUTHORIZED_TOMBSTONE', { ok: true }],
      ['B4-07', 'HISTORY', 'Missing outer sig', 'rejected', 'verifyOuter', 'NEG_MISSING_OUTER_SIG', { ok: true }],
      ['B4-08', 'HISTORY', 'Forged event identity', 'rejected', 'import', 'NEG_FORGED_EVENT_IDENTITY', { ok: true }],
      ['B4-09', 'HISTORY', 'Conflicting event', 'CONFLICTING_EVENT', 'import', 'NEG_CONFLICTING_EVENT', { ok: true }],
      ['B4-10', 'HISTORY', 'Unlinked', 'fail-closed', 'sync', 'NEG_UNLINKED', { ok: true }],
      ['B4-11', 'HISTORY', 'Plaintext downgrade', 'rejected', 'import', 'NEG_PLAINTEXT_DOWNGRADE', { ok: true }],
      ['B4-12', 'CROSS_PROTOCOL', 'Cross-protocol', 'rejected', 'classify', 'NEG_CROSS_PROTOCOL', { ok: true }],
      ['B4-13', 'RESOURCE', 'Batch resource limits', 'events/bytes bounds', 'limits', 'RESOURCE_LIMITS', { ok: true }],
    ],
  },
  {
    name: 's4-harden',
    cmd: 'node qa/md4-s4-security-hardening-gate.mjs',
    env: { SOS_MD4_S4_HARDEN_RUN_ID: '' },
    report: 'qa/md4-s4-security-hardening-report.json',
    maps: [
      ['B3-20', 'ACK', 'AEAD SYNC_ACK roundtrip', 'valid ACK accepted', 'publishAckSealed', 'ACK1_ROUNDTRIP_AEAD', { ok: true }],
      ['B3-21', 'ACK', 'Modified ciphertext/tag', 'rejected before durable advance', 'validateSyncAck', 'ACK11_MODIFIED_CT_REJECTED', { ok: true }],
      ['B3-22', 'ACK', 'Wrong AAD', 'rejected', 'ackAad', 'ACK_WRONG_AAD_REJECTED', { ok: true }],
      ['B3-23', 'ACK', 'Wrong session key', 'rejected', 'decrypt', 'ACK3_WRONG_SESSION_KEY', { ok: true }],
      ['B3-24', 'ACK', 'Wrong account AAD', 'rejected', 'ackAad', 'ACK5_WRONG_ACCOUNT_AAD', { ok: true }],
      ['B3-25', 'ACK', 'Wrong device AAD', 'rejected', 'ackAad', 'ACK4_WRONG_DEVICE_AAD', { ok: true }],
      ['B3-26', 'ACK', 'Wrong auth AAD', 'rejected', 'ackAad', 'ACK6_WRONG_AUTH_AAD', { ok: true }],
      ['B3-27', 'ACK', 'Wrong epoch AAD', 'rejected', 'ackAad', 'ACK6_WRONG_EPOCH_AAD', { ok: true }],
      ['B3-28', 'ACK', 'Wrong session AAD', 'rejected', 'ackAad', 'ACK_WRONG_SESSION_AAD', { ok: true }],
      ['B3-29', 'ACK', 'Wrong pairing transcript', 'rejected', 'ackAad', 'ACK7_WRONG_TRANSCRIPT', { ok: true }],
      ['B3-30', 'ACK', 'FINAL_ACK AEAD', 'roundtrip + wrong key', 'FINAL_ACK', 'ACK2_FINAL_AEAD', { ok: true }],
      ['B5-01', 'TOMBSTONE', 'Forged outer signature', 'rejected', 'verifyEvent', 'TOMB17_FORGED_SIG', { ok: true }],
      ['B5-02', 'TOMBSTONE', 'Bad event id/hash', 'rejected', 'verify', 'TOMB18_BAD_EVENT_ID', { ok: true }],
      ['B5-03', 'TOMBSTONE', 'Tombstone after target', 'applied', 'apply', 'TOMB19_AFTER_TARGET', { ok: true }],
      ['B5-04', 'TOMBSTONE', 'Tombstone before target', 'fail-closed order', 'apply', 'TOMB20_BEFORE_TARGET', { ok: true }],
      ['B5-05', 'TOMBSTONE', 'Unauthorized deletion', 'rejected', 'apply', 'TOMB21_UNAUTH', { ok: true }],
      ['B5-06', 'TOMBSTONE', 'Tampered target', 'rejected', 'apply', 'TOMB22_TAMPERED_TARGET', { ok: true }],
      ['B5-07', 'TOMBSTONE', 'No resurrection', 'historical replay suppressed', 'import', 'TOMB_NO_RESURRECTION', { ok: true }],
      ['B5-08', 'TOMBSTONE', 'Valid verify path', 'verifyEvent required', 'verifyOuterKind1050', 'TOMB_VALID_VERIFY', { ok: true }],
    ],
  },
  {
    name: 's5-neg',
    cmd: 'node qa/md4-s5-security-negatives-gate.mjs',
    env: { SOS_MD4_S5_NEG_RUN_ID: '' },
    report: 'qa/md4-s5-security-negatives-report.json',
    maps: [
      ['B6-01', 'ATTACH', 'Wrong device bind', 'rejected', 'validateJobBind', 'NEG_WRONG_DEVICE_BIND', { ok: true }],
      ['B6-02', 'ATTACH', 'Wrong epoch bind', 'rejected', 'validateJobBind', 'NEG_WRONG_EPOCH_BIND', { ok: true }],
      ['B6-03', 'ATTACH', 'Wrong auth bind', 'rejected', 'validateJobBind', 'NEG_WRONG_AUTH_BIND', { ok: true }],
      ['B6-04', 'ATTACH', 'SSRF metadata URL', 'URL_SSRF_BLOCKED', 'assertSafeUrl', 'NEG_SSRF_METADATA', { ok: true }],
      ['B6-05', 'ATTACH', 'SSRF file URL', 'blocked', 'assertSafeUrl', 'NEG_SSRF_FILE', { ok: true }],
      ['B6-06', 'ATTACH', 'Bad filename', 'sanitized/rejected', 'sanitizeFilename', 'NEG_BAD_FILENAME', { ok: true }],
      ['B6-07', 'ATTACH', 'Bad MIME', 'sanitized/rejected', 'sanitizeMime', 'NEG_BAD_MIME', { ok: true }],
      ['B6-08', 'ATTACH', 'Oversized cipher', 'OVERSIZED_CIPHER', 'buildJob', 'NEG_OVERSIZED', { ok: true }],
      ['B6-09', 'ATTACH', 'Tombstone blocks job', 'TOMBSTONED', 'buildJob', 'NEG_TOMBSTONE_BLOCKS_JOB', { ok: true }],
      ['B6-10', 'ATTACH', 'Partial ciphertext reject', 'SIZE_MISMATCH / fail-closed', 'acceptLocalCiphertext', 'NEG_PARTIAL_CIPHER_REJECT', { ok: true }],
      ['B6-11', 'ATTACH', 'Missing outer sig', 'rejected', 'verify', 'NEG_MISSING_OUTER_SIG', { ok: true }],
      ['B6-12', 'ATTACH', 'Cross-protocol', 'rejected', 'classify', 'NEG_CROSS_PROTOCOL', { ok: true }],
      ['B6-13', 'ATTACH', 'Job has no enc.key leak', 'durable job clean', 'loadJob', 'NEG_JOB_NO_KEY_LEAK', { ok: true }],
      ['B6-14', 'ATTACH', 'AAD domain separated from ACK', 'distinct domains', 'attachAad/ackAad', 'POS_AAD_DOMAIN_SEPARATED', { ok: true }],
    ],
  },
];

for (const plan of childPlan) {
  const env = Object.assign({}, plan.env);
  for (const k of Object.keys(env)) {
    if (!env[k]) env[k] = crypto.randomUUID();
  }
  const { exitCode, childRunId } = runChild(plan.name, plan.cmd, env);
  for (const [id, domain, threat, invariant, entryPoint, key, expected] of plan.maps) {
    mapChildResult({
      id,
      domain,
      threat,
      invariant,
      entryPoint,
      testType: 'browser/unit-orchestrated',
      expected,
      reportPath: path.join(ROOT, plan.report),
      key,
      command: plan.cmd,
      exitCode,
      childRunId,
    });
  }
}

// ---------- Explicit NOT_VERIFIED / N/A inventory (honest gaps) ----------
const gapCases = [
  ['B1-20', 'DEVICE_AUTH', 'Forged DeviceAuthorization full wire', 'Live MD3 wire forgery beyond verifyStrict vectors', 'NOT_VERIFIED', 'Covered partially by S1 verifyStrict negatives; full live forged-auth wire E2E not separately instrumented in S6'],
  ['B1-21', 'DEVICE_AUTH', 'Wrong pairing transcript on auth object', 'pairingTranscriptHash bind', 'NOT_VERIFIED', 'Transcript bind covered on ACK/HELLO AAD; dedicated DeviceAuthorization transcript-mismatch vector not isolated as separate S6 case key'],
  ['B1-22', 'DEVICE_AUTH', 'Wrong D_enc on authorization', 'D_enc mismatch', 'NOT_VERIFIED', 'S1 gate covers D_sign; D_enc mismatch on authorization record not separately keyed in S1 report'],
  ['B1-23', 'DEVICE_AUTH', 'Device substitution mid-sync', 'active session device bind', 'NOT_VERIFIED', 'Store isolation + bind checks exist; live mid-sync substitution race not freshly instrumented'],
  ['B3-40', 'ACK', 'ACK for non-in-flight batch', 'batchId/seq gate', 'NOT_VERIFIED', 'AckGate validates bind fields; dedicated non-in-flight batchId case not isolated in hardening report keys'],
  ['B3-41', 'ACK', 'Duplicate valid ACK', 'idempotent / no double-advance', 'NOT_VERIFIED', 'Idempotent import covered; duplicate ACK advance semantics not separately asserted in S6'],
  ['B3-42', 'ACK', 'Cross-session ACK replay', 'session bind', 'NOT_VERIFIED', 'Wrong session AAD covered; explicit cross-session replay corpus not separate'],
  ['B3-43', 'HISTORY', 'Forged SYNC_HELLO', 'HelloGate reject', 'NOT_VERIFIED', 'Android HelloGate unit covered in S3; forged HELLO browser wire case not freshly mapped'],
  ['B3-44', 'HISTORY', 'Session downgrade', 'version/protocol downgrade', 'NOT_VERIFIED', 'Protocol collision covered; explicit version downgrade vector not isolated'],
  ['B3-45', 'HISTORY', 'Premature SYNC_DONE', 'FINAL_ACK required', 'NOT_VERIFIED', 'MISSING_FINAL_ACK static preserved; live premature DONE case not freshly keyed'],
  ['B3-46', 'HISTORY', 'Concurrent conflicting sync sessions', 'single-flight', 'NOT_VERIFIED', 'Not freshly instrumented in S6 matrix'],
  ['B4-20', 'CHECKPOINT', 'Crash between import and checkpoint', 'resume safety', 'NOT_VERIFIED', 'Ordering helpers asserted; crash-injection harness not run in S6'],
  ['B4-21', 'CHECKPOINT', 'Crash between commit and ACK', 'no false COMPLETE', 'NOT_VERIFIED', 'ACK-before-complete static; crash injection not run'],
  ['B4-22', 'CHECKPOINT', 'Android process interruption resume', 'phone session resume', 'NOT_VERIFIED', 'Requires instrumented crash harness; not executed in S6'],
  ['B4-23', 'CHECKPOINT', 'Incomplete relay coverage false COMPLETE', 'relay quorum', 'NOT_VERIFIED', 'Not freshly instrumented'],
  ['B4-24', 'CHECKPOINT', 'Same-timestamp pagination boundary', 'cursor correctness', 'NOT_VERIFIED', 'Covered by S4 E2E pagination suite when run in Phase G, not as S6 negative matrix key'],
  ['B5-20', 'TOMBSTONE', 'Raw NIP-44 fallback bypass', 'no plaintext tombstone bypass', 'NOT_VERIFIED', 'Outer verifyEvent path enforced; dedicated NIP-44 bypass probe not isolated'],
  ['B5-21', 'TOMBSTONE', 'Deleted attachment restoration attempt', 'tombstone blocks attach job', 'PASS_CANDIDATE', 'Mapped via B6-09 NEG_TOMBSTONE_BLOCKS_JOB when child PASS'],
  ['B6-20', 'ATTACH', 'Public WebTorrent swarm encrypted fetch', 'real swarm P2P', 'NOT_VERIFIED', 'Mock/contract PASS in S5 acceptance; public swarm NOT VERIFIED (release gap)'],
  ['B6-21', 'ATTACH', 'Chromium in-page peak memory', 'browser heap bound', 'NOT_VERIFIED', 'Node harness RSS measured; in-page peak NOT MEASURED unless supplement succeeds'],
  ['B6-22', 'ATTACH', 'Hardware camera QR', 'physical QR', 'NOT_VERIFIED', 'Paste-path QR only; hardware camera NOT VERIFIED (release gap)'],
  ['C-01', 'CROSS', 'Valid MD3 pairing then auth expiry', 'expiry fail-closed', 'NOT_VERIFIED', 'Expiry verifyStrict covered; full MD3→expiry multi-step live chain not freshly orchestrated'],
  ['C-02', 'CROSS', 'Account switch during history import', 'isolation', 'NOT_VERIFIED', 'Account switch store isolation covered; mid-import switch race not freshly instrumented'],
  ['C-03', 'CROSS', 'Device revocation during media transfer', 'transfer abort', 'NOT_VERIFIED', 'Revoked auth + attach bind covered separately; combined mid-transfer race not freshly instrumented'],
  ['C-04', 'CROSS', 'Relay replay across history sessions', 'session bind', 'NOT_VERIFIED', 'Session AAD covered; multi-session relay replay corpus not freshly run'],
  ['C-05', 'CROSS', 'Device key substitution on reconnect', 'D_sign bind', 'NOT_VERIFIED', 'D_sign mismatch covered; reconnect substitution E2E not freshly run'],
  ['C-06', 'CROSS', 'Valid tombstone + malicious backfill', 'no resurrection', 'PASS_CANDIDATE', 'Covered by B4-05 / B5-07 when children PASS'],
  ['C-07', 'CROSS', 'Corrupted media then fallback source', 'no plaintext downgrade', 'NOT_VERIFIED', 'P2P/Blossom hybrid fail-closed covered in S5 P2P gate; combined corrupt→fallback matrix case not re-keyed here'],
  ['C-08', 'CROSS', 'Interrupted bootstrap + forged completion', 'no false COMPLETE', 'NOT_VERIFIED', 'FINAL_ACK requirements static; forged completion live case not freshly instrumented'],
  ['C-09', 'CROSS', 'Concurrent desktop sessions one account', 'isolation/binding', 'NOT_VERIFIED', 'Not freshly instrumented in S6'],
];

for (const [id, domain, threat, invariant, status, justification] of gapCases) {
  if (status === 'PASS_CANDIDATE') {
    const related = cases.find((c) => (id === 'B5-21' && c.id === 'B6-09') || (id === 'C-06' && (c.id === 'B4-05' || c.id === 'B5-07')));
    const ok = related && related.status === 'PASS';
    record({
      id,
      domain,
      threat,
      invariant,
      entryPoint: related ? related.entryPoint : 'derived',
      testType: 'derived',
      expected: { ok: true },
      observed: related ? { via: related.id, status: related.status } : null,
      protectedStateChanged: false,
      status: ok ? 'PASS' : 'NOT_VERIFIED',
      justification: ok ? 'Derived from fresh child PASS ' + (related && related.id) : justification,
    });
    continue;
  }
  record({
    id,
    domain,
    threat,
    invariant,
    entryPoint: 'n/a',
    testType: 'gap-inventory',
    expected: { ok: true },
    observed: null,
    protectedStateChanged: false,
    status,
    justification,
  });
}

// ---------- Cross-boundary + attach supplement (real browser paths) ----------
async function runSupplement() {
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/videos.html';
    const fp = path.join(ROOT, p.replace(/^\//, ''));
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(fp).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(base + '/videos.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => !!(window.NostrTools && window.NostrApp && window.NostrApp.encryptMediaBlob), null, {
    timeout: 60000,
  });
  for (const s of ['/sos-md4-device-auth.js', '/sos-md4-attachment-sync.js', '/sos-md4-history-sync.js', '/sos-md4-history-checkpoint.js']) {
    await page.addScriptTag({ url: base + s });
  }
  await page.waitForFunction(() => !!(window.SosMd4DeviceAuth && window.SosMd4AttachmentSync), null, { timeout: 20000 });

  const supp = await page.evaluate(async () => {
    const App = window.NostrApp;
    const NT = window.NostrTools;
    const Auth = window.SosMd4DeviceAuth;
    const Att = window.SosMd4AttachmentSync;
    const out = {};

    // B6: wrong AES tag / truncated / hash mismatch via acceptLocalCiphertext
    const sk = NT.generateSecretKey();
    const pub = NT.getPublicKey(sk);
    const peer = NT.getPublicKey(NT.generateSecretKey());
    App.publicKey = pub;
    const plain = new Uint8Array(2048);
    crypto.getRandomValues(plain);
    const messageId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    const enc = await App.encryptMediaBlob(new Blob([plain], { type: 'image/png' }), {
      messageId,
      sender: pub,
      recipient: peer,
      filename: 's6.png',
      mime: 'image/png',
      mode: 'single',
    });
    const desc = enc.descriptor;
    const eventId = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    const deviceId = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    const authorizationId = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    App.deletedChatMessageIds = new Set();
    App.chatState = { conversations: new Map(), messageIndex: new Map() };
    App.appendChatMessage = (m) => {
      const key = [pub, peer].sort().join(':');
      if (!App.chatState.conversations.has(key)) App.chatState.conversations.set(key, { messages: [] });
      App.chatState.conversations.get(key).messages.push(m);
      App.chatState.messageIndex.set(m.id, { key });
    };
    App.appendChatMessage({
      id: eventId,
      from: pub,
      to: peer,
      content: 's6',
      createdAt: Math.floor(Date.now() / 1000),
      attachment: desc,
      logicalMessageId: messageId,
      mediaSyncState: 'PENDING',
    });
    const built = Att.buildJob({
      accountP: pub,
      deviceId,
      authorizationId,
      authEpoch: 1,
      sessionId,
      peerP: peer,
      eventId,
      messageId,
      sender: pub,
      recipient: peer,
      attachment: desc,
      sourceHint: 'LOCAL',
    });
    out.jobOk = !!(built && built.ok);
    if (built.ok) {
      const trunc = enc.ciphertext.subarray(0, Math.max(16, enc.ciphertext.length - 8));
      const rTrunc = await Att.acceptLocalCiphertext(built.job, trunc, desc);
      out.trunc = { ok: rTrunc.ok, code: rTrunc.code, state: built.job.state };
      built.job.state = Att.STATES.PENDING;
      built.job.errorCode = '';
      const tampered = new Uint8Array(enc.ciphertext);
      tampered[tampered.length - 1] ^= 0xff;
      const rTag = await Att.acceptLocalCiphertext(built.job, tampered, desc);
      out.badTag = { ok: rTag.ok, code: rTag.code, state: built.job.state };
      // forged manifest: wrong hash claim
      const forged = JSON.parse(JSON.stringify(desc));
      forged.cipher.sha256 = 'ab'.repeat(32);
      forged.attachmentId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      const eventId2 = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
      App.appendChatMessage({
        id: eventId2,
        from: pub,
        to: peer,
        content: 's6b',
        createdAt: Math.floor(Date.now() / 1000),
        attachment: forged,
        logicalMessageId: messageId + 'b',
        mediaSyncState: 'PENDING',
      });
      const built2 = Att.buildJob({
        accountP: pub,
        deviceId,
        authorizationId,
        authEpoch: 1,
        sessionId,
        peerP: peer,
        eventId: eventId2,
        messageId: messageId + 'b',
        sender: pub,
        recipient: peer,
        attachment: forged,
        sourceHint: 'LOCAL',
      });
      let hashMismatch = { ok: true };
      if (built2.ok) {
        hashMismatch = await Att.acceptLocalCiphertext(built2.job, enc.ciphertext, forged);
      } else hashMismatch = { ok: false, code: built2.code };
      out.hashMismatch = { ok: hashMismatch.ok, code: hashMismatch.code };
      // unauthorized plaintext fallback: clear type / try resolve without encrypted shape
      const plainAtt = { type: 'image/png', url: 'https://evil.example/x.png', name: 'x.png' };
      let plainResolve = null;
      try {
        plainResolve = await App.resolveServerMediaAttachment(plainAtt, { messageId, sender: pub, recipient: peer });
      } catch (e) {
        plainResolve = { threw: true, code: e && e.code };
      }
      out.plainFallback = { resolved: !!(plainResolve && plainResolve.blob), threw: !!(plainResolve && plainResolve.threw) };
    }

    // Device auth: wrong D_enc if API compares it
    if (Auth && typeof Auth.verifyStrict === 'function') {
      // Minimal structural probe: revoked + disabled-like status
      const now = Date.now();
      out.authApi = typeof Auth.verifyStrict === 'function';
    }

    // Chromium memory hint (non-standard; may be undefined)
    out.jsHeap = performance && performance.memory ? performance.memory.usedJSHeapSize : null;
    out.jsHeapLimit = performance && performance.memory ? performance.memory.jsHeapSizeLimit : null;
    return out;
  });

  record({
    id: 'B6-30',
    domain: 'ATTACH',
    threat: 'Truncated ciphertext accepted as complete',
    invariant: 'Partial AEAD never trusted',
    entryPoint: 'SosMd4AttachmentSync.acceptLocalCiphertext',
    testType: 'browser',
    expected: { ok: false },
    observed: supp.trunc,
    protectedStateChanged: false,
    status: supp.trunc && supp.trunc.ok === false ? 'PASS' : 'FAIL',
    command: 'md4-s6-security-matrix-gate supplement',
    exitCode: 0,
  });
  record({
    id: 'B6-31',
    domain: 'ATTACH',
    threat: 'Tampered AES-GCM tag/ciphertext',
    invariant: 'Auth failure fail-closed',
    entryPoint: 'acceptLocalCiphertext',
    testType: 'browser',
    expected: { ok: false },
    observed: supp.badTag,
    protectedStateChanged: false,
    status: supp.badTag && supp.badTag.ok === false ? 'PASS' : 'FAIL',
    command: 'md4-s6-security-matrix-gate supplement',
    exitCode: 0,
  });
  record({
    id: 'B6-32',
    domain: 'ATTACH',
    threat: 'Forged attachment hash manifest',
    invariant: 'MEDIA_E2EE_HASH_MISMATCH',
    entryPoint: 'acceptLocalCiphertext',
    testType: 'browser',
    expected: { ok: false },
    observed: supp.hashMismatch,
    protectedStateChanged: false,
    status: supp.hashMismatch && supp.hashMismatch.ok === false ? 'PASS' : 'FAIL',
    command: 'md4-s6-security-matrix-gate supplement',
    exitCode: 0,
  });
  record({
    id: 'B6-33',
    domain: 'ATTACH',
    threat: 'Unauthorized plaintext media fallback',
    invariant: 'resolveServerMediaAttachment ignores non-encrypted',
    entryPoint: 'resolveServerMediaAttachment',
    testType: 'browser',
    expected: { resolved: false },
    observed: supp.plainFallback,
    protectedStateChanged: false,
    status: supp.plainFallback && supp.plainFallback.resolved === false ? 'PASS' : 'FAIL',
    command: 'md4-s6-security-matrix-gate supplement',
    exitCode: 0,
  });

  // Attempt Chromium heap sample (Chrome-only)
  if (typeof supp.jsHeap === 'number' && supp.jsHeap > 0) {
    // Update B6-21 from NOT_VERIFIED to measured-at-idle (not peak during 32MiB) — keep honest
    const idx = cases.findIndex((c) => c.id === 'B6-21');
    if (idx >= 0) {
      cases[idx].status = 'NOT_VERIFIED';
      cases[idx].justification =
        'performance.memory idle sample available (usedJSHeapSize=' +
        supp.jsHeap +
        ') but peak during large transfer not measured in S6';
      cases[idx].observed = { usedJSHeapSize: supp.jsHeap, jsHeapSizeLimit: supp.jsHeapLimit, phase: 'idle-after-small-attach' };
    }
  }

  await browser.close();
  server.close();
}

await runSupplement();

// ---------- Summaries ----------
const counts = {
  TOTAL: cases.length,
  PASS: cases.filter((c) => c.status === 'PASS').length,
  FAIL: cases.filter((c) => c.status === 'FAIL').length,
  NOT_VERIFIED: cases.filter((c) => c.status === 'NOT_VERIFIED').length,
  BLOCKED: cases.filter((c) => c.status === 'BLOCKED').length,
  NOT_APPLICABLE: cases.filter((c) => c.status === 'NOT_APPLICABLE').length,
};

function domainStatus(domain) {
  const rows = cases.filter((c) => c.domain === domain);
  if (!rows.length) return 'NOT_VERIFIED';
  if (rows.some((r) => r.status === 'FAIL')) return 'FAIL';
  const executed = rows.filter((r) => r.status === 'PASS' || r.status === 'FAIL');
  if (!executed.length) return 'NOT_VERIFIED';
  if (rows.every((r) => r.status === 'PASS' || r.status === 'NOT_VERIFIED' || r.status === 'NOT_APPLICABLE')) {
    return rows.some((r) => r.status === 'NOT_VERIFIED') ? 'PASS_WITH_GAPS' : 'PASS';
  }
  return 'PASS_WITH_GAPS';
}

const report = {
  gate: 'MD4_S6_SECURITY_MATRIX',
  STATUS: counts.FAIL > 0 ? 'FAIL' : 'PASS_WITH_RELEASE_GAPS',
  runId: RUN_ID,
  started: STARTED,
  finished: new Date().toISOString(),
  BASELINE_HEAD: 'd1bcc5168d9e02564c505d4b10c69a8d9b5f208a',
  counts,
  domains: {
    DEVICE_AUTH: domainStatus('DEVICE_AUTH'),
    CKI: domainStatus('CKI'),
    HISTORY: domainStatus('HISTORY'),
    ACK: domainStatus('ACK'),
    CHECKPOINT: domainStatus('CHECKPOINT'),
    TOMBSTONE: domainStatus('TOMBSTONE'),
    ATTACH: domainStatus('ATTACH'),
    CROSS_PROTOCOL: domainStatus('CROSS_PROTOCOL'),
    KEY_LEAK: domainStatus('KEY_LEAK'),
    RESOURCE: domainStatus('RESOURCE'),
    CROSS: domainStatus('CROSS'),
  },
  PUBLIC_WEBTORRENT_E2E: 'NOT_VERIFIED',
  CHROMIUM_IN_PAGE_MEMORY: 'NOT_MEASURED',
  HARDWARE_CAMERA_QR: 'NOT_VERIFIED',
  SECURITY_FINDINGS: [],
  casesPath: CASES_OUT,
};

fs.writeFileSync(CASES_OUT, JSON.stringify(cases, null, 2));
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('MD4_S6_SECURITY_MATRIX=' + report.STATUS, 'total=' + counts.TOTAL, 'pass=' + counts.PASS, 'fail=' + counts.FAIL, 'nv=' + counts.NOT_VERIFIED);
console.log('REPORT', OUT);
process.exit(counts.FAIL > 0 ? 1 : 0);
