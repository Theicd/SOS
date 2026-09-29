/**
 * Package 899 — per-relay compatibility matrix for realtime call signaling (kind 1059 gift wraps).
 * Raw NIP-01 WebSocket so AUTH challenges and OK/CLOSED reasons are visible.
 * Mirrors the web client exactly:
 *  - writes: on auth-required, NIP-42 AUTH is signed by the wrap's own ephemeral key (never the identity key);
 *  - reads: the web client never authenticates its identity key to a relay, so delivery is measured WITHOUT
 *    reader AUTH. A second probe (identity AUTH, disposable key) is recorded only to explain the root cause.
 * Disposable keys only; never logs keys.
 * Run: node qa/package899-relay-matrix.mjs   (env SOS_RELAY_TRIALS, SOS_RELAY_STABILITY_MS)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, finalizeEvent, nip44, nip59 } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SOS_RELAY_OUT || path.join(__dirname, 'package899-relay-matrix-report.json');
const RELAYS = (process.env.SOS_RELAYS ||
  'wss://relay.snort.social,wss://nos.lol,wss://nostr-relay.xbytez.io,wss://nostr-02.uid.ovh,wss://nostr.0x7e.xyz').split(',');
const CALL_RELAYS = new Set(['wss://relay.snort.social', 'wss://nos.lol', 'wss://nostr-relay.xbytez.io', 'wss://nostr-02.uid.ovh']);
const TRIALS = Number(process.env.SOS_RELAY_TRIALS || 10);
const STABILITY_MS = Number(process.env.SOS_RELAY_STABILITY_MS || 45000);
const T = 6000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

function open(url) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (_e) {
      resolve({ ok: false, err: 'WS_ERROR', ms: 0 });
      return;
    }
    const conn = { ws, msgs: [], challenge: null, listeners: new Set(), closed: false, closeCode: null };
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => { settle({ ok: false, err: 'CONNECT_TIMEOUT', ms: Date.now() - t0 }); try { ws.close(); } catch (_e) {} }, T);
    ws.onopen = () => { clearTimeout(timer); settle({ ok: true, ms: Date.now() - t0, conn }); };
    ws.onerror = () => { clearTimeout(timer); settle({ ok: false, err: 'WS_ERROR', ms: Date.now() - t0 }); };
    ws.onclose = (e) => { conn.closed = true; conn.closeCode = e && e.code; };
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(String(m.data)); } catch (_e) { return; }
      if (!Array.isArray(msg)) return;
      if (msg[0] === 'AUTH') conn.challenge = msg[1];
      conn.msgs.push({ at: Date.now(), msg });
      conn.listeners.forEach((fn) => fn(msg));
    };
  });
}

function waitFor(conn, pred, ms = T) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const fn = (msg) => { const r = pred(msg); if (r) done(r); };
    const done = (v) => { conn.listeners.delete(fn); clearTimeout(timer); resolve(Object.assign({ ms: Date.now() - t0 }, v)); };
    const timer = setTimeout(() => done({ timeout: true }), ms);
    conn.listeners.add(fn);
  });
}

function publish(conn, ev) {
  conn.ws.send(JSON.stringify(['EVENT', ev]));
  return waitFor(conn, (m) => (m[0] === 'OK' && m[1] === ev.id ? { accepted: m[2] === true, reason: String(m[3] || '') } : null));
}

async function authenticate(conn, sk, url) {
  if (!conn.challenge) return { attempted: false, reason: 'NO_CHALLENGE' };
  const ev = finalizeEvent({ kind: 22242, created_at: now(), tags: [['relay', url], ['challenge', conn.challenge]], content: '' }, sk);
  conn.ws.send(JSON.stringify(['AUTH', ev]));
  const r = await waitFor(conn, (m) => (m[0] === 'OK' && m[1] === ev.id ? { accepted: m[2] === true, reason: String(m[3] || '') } : null));
  return { attempted: true, accepted: r.accepted === true, reason: r.timeout ? 'TIMEOUT' : r.reason };
}

/** Gift wrap exactly like call-signal-e2ee: rumor → seal (sender) → wrap signed by a fresh ephemeral key. */
function giftWrap(senderSk, recipientPub) {
  const rumor = nip59.createRumor({ kind: 14, created_at: now(), tags: [], content: JSON.stringify({ family: 'sos-relay-matrix', v: 1 }) }, senderSk);
  const seal = nip59.createSeal(rumor, senderSk, recipientPub);
  const ephSk = generateSecretKey();
  const content = nip44.v2.encrypt(JSON.stringify(seal), nip44.v2.utils.getConversationKey(ephSk, recipientPub));
  const wrap = finalizeEvent({ kind: 1059, created_at: now(), tags: [['p', recipientPub]], content }, ephSk);
  return { wrap, ephSk };
}

async function req(conn, subId, filter) {
  conn.ws.send(JSON.stringify(['REQ', subId, filter]));
  return waitFor(conn, (m) => (m[1] === subId && (m[0] === 'EOSE' || m[0] === 'CLOSED') ? { type: m[0], reason: String(m[2] || '') } : null));
}

async function trial(url) {
  const senderSk = generateSecretKey();
  const recipSk = generateSecretKey();
  const recipPub = getPublicKey(recipSk);
  const out = { connect: null, challengeOnConnect: false, sub1059: null, sub25050: null, publish: null, writeAuth: null, publishAfterAuth: null, delivery: null, deliveryWithIdentityAuth: null, errors: { timeout: 0, ws: 0, authRequired: 0 } };
  const a = await open(url);
  const b = await open(url);
  out.connect = { ok: a.ok && b.ok, ms: a.ms, err: a.err || b.err || null };
  if (!a.ok || !b.ok) {
    if ((a.err || b.err) === 'CONNECT_TIMEOUT') out.errors.timeout += 1; else out.errors.ws += 1;
    try { a.conn && a.conn.ws.close(); b.conn && b.conn.ws.close(); } catch (_e) {}
    return out;
  }
  await sleep(500);
  out.challengeOnConnect = !!(a.conn.challenge || b.conn.challenge);
  const subId = 'm' + Math.random().toString(36).slice(2, 10);
  out.sub1059 = await req(b.conn, subId, { kinds: [1059], '#p': [recipPub], since: now() - 60 });
  if (out.sub1059.timeout) out.errors.timeout += 1;
  if (out.sub1059.type === 'CLOSED' && /auth/i.test(out.sub1059.reason)) out.errors.authRequired += 1;
  const legacyId = 'l' + Math.random().toString(36).slice(2, 10);
  out.sub25050 = await req(b.conn, legacyId, { kinds: [25050], '#p': [recipPub], since: now() - 60 });

  const first = giftWrap(senderSk, recipPub);
  let wrapUsed = first.wrap;
  const t0 = Date.now();
  let delivered = waitFor(b.conn, (m) => (m[0] === 'EVENT' && m[1] === subId && m[2] && m[2].id === wrapUsed.id ? { got: true } : null), 8000);
  out.publish = await publish(a.conn, first.wrap);
  if (out.publish.timeout) out.errors.timeout += 1;
  if (!out.publish.accepted && /auth/i.test(out.publish.reason)) {
    out.errors.authRequired += 1;
    const second = giftWrap(senderSk, recipPub);
    out.writeAuth = await authenticate(a.conn, second.ephSk, url);
    if (out.writeAuth.accepted) {
      wrapUsed = second.wrap;
      delivered = waitFor(b.conn, (m) => (m[0] === 'EVENT' && m[1] === subId && m[2] && m[2].id === wrapUsed.id ? { got: true } : null), 8000);
      out.publishAfterAuth = await publish(a.conn, second.wrap);
      if (out.publishAfterAuth.timeout) out.errors.timeout += 1;
    }
  }
  const accepted = (out.publish && out.publish.accepted) || (out.publishAfterAuth && out.publishAfterAuth.accepted);
  if (accepted) {
    const d = await delivered;
    out.delivery = d.got ? { got: true, ms: Date.now() - t0 } : { got: false };
  } else {
    out.delivery = { got: false, reason: 'NOT_ACCEPTED' };
  }
  // Root-cause probe only: does the relay deliver if the recipient authenticates its identity key?
  if (accepted && !out.delivery.got && out.sub1059.type === 'CLOSED' && /auth/i.test(out.sub1059.reason)) {
    const c = await open(url);
    if (c.ok) {
      await sleep(400);
      const ra = await authenticate(c.conn, recipSk, url);
      const sid = 'r' + Math.random().toString(36).slice(2, 10);
      const s = await req(c.conn, sid, { kinds: [1059], '#p': [recipPub], since: now() - 120 });
      const got = c.conn.msgs.some((x) => x.msg[0] === 'EVENT' && x.msg[1] === sid && x.msg[2] && x.msg[2].id === wrapUsed.id);
      out.deliveryWithIdentityAuth = { authAccepted: !!ra.accepted, sub: s.type, got };
      try { c.conn.ws.close(); } catch (_e) {}
    }
  }
  try { a.conn.ws.close(); b.conn.ws.close(); } catch (_e) {}
  return out;
}

async function stability(url, ms) {
  const c = await open(url);
  if (!c.ok) return { opened: false, err: c.err };
  const t0 = Date.now();
  let pings = 0;
  let pongs = 0;
  while (Date.now() - t0 < ms && !c.conn.closed) {
    const id = 's' + Math.random().toString(36).slice(2, 8);
    pings += 1;
    const r = await req(c.conn, id, { kinds: [1059], '#p': [getPublicKey(generateSecretKey())], limit: 1 });
    if (!r.timeout) pongs += 1;
    try { c.conn.ws.send(JSON.stringify(['CLOSE', id])); } catch (_e) {}
    await sleep(Math.min(10000, Math.max(0, ms - (Date.now() - t0))));
  }
  const heldMs = Date.now() - t0;
  const closedEarly = c.conn.closed;
  try { c.conn.ws.close(); } catch (_e) {}
  // reconnect behaviour: immediate reopen after close
  const re = await open(url);
  try { re.conn && re.conn.ws.close(); } catch (_e) {}
  return { opened: true, heldMs, closedEarly, closeCode: c.conn.closeCode, pings, pongs, reconnectOk: !!re.ok, reconnectMs: re.ms };
}

const pct = (arr, p) => {
  const v = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
};

function classify(r) {
  const connectRate = r._connectOk / TRIALS;
  const deliveryRate = r._deliveryOk / TRIALS;
  if (connectRate < 0.5) return 'UNHEALTHY';
  if (r._deliveryOk === 0 && (r.NIP42_REQUIRED || /auth/i.test(r.KIND1059_SUBSCRIBE))) return 'INCOMPATIBLE';
  if (deliveryRate >= 0.9 && r.PUBLISH_P95_MS != null && r.PUBLISH_P95_MS < 1500 && r.STABILITY.opened && !r.STABILITY.closedEarly) return 'PRIMARY';
  if (deliveryRate >= 0.5) return 'SECONDARY';
  return 'PROBE_ONLY';
}

async function main() {
  const report = { gate: 'PACKAGE899_RELAY_MATRIX', ts: new Date().toISOString(), trials: TRIALS, stabilityMs: STABILITY_MS, clientBehavior: 'write NIP-42 via ephemeral wrap key; no identity AUTH for reads', relays: {} };
  for (const url of RELAYS) {
    const trials = [];
    for (let i = 0; i < TRIALS; i++) trials.push(await trial(url));
    const stab = await stability(url, STABILITY_MS);
    const n = (f) => trials.filter(f).length;
    const sum = (k) => trials.reduce((s, t) => s + t.errors[k], 0);
    const pubMs = trials.map((t) => (t.publishAfterAuth && t.publishAfterAuth.accepted ? t.publishAfterAuth.ms : t.publish && t.publish.accepted ? t.publish.ms : NaN));
    const delMs = trials.map((t) => (t.delivery && t.delivery.got ? t.delivery.ms : NaN));
    const nip42Required = trials.some((t) => t.publish && /auth/i.test(t.publish.reason || ''));
    const writeAuthOk = n((t) => t.writeAuth && t.writeAuth.accepted);
    const subTypes = [...new Set(trials.map((t) => (t.sub1059 ? (t.sub1059.timeout ? 'TIMEOUT' : t.sub1059.type + (t.sub1059.reason ? ':' + t.sub1059.reason.slice(0, 50) : '')) : 'NO_CONN')))];
    const idAuth = trials.map((t) => t.deliveryWithIdentityAuth).filter(Boolean);
    const r = {
      RELAY: url,
      CALL_SIGNAL_SET: CALL_RELAYS.has(url),
      CONNECT: n((t) => t.connect && t.connect.ok) + '/' + TRIALS,
      CONNECT_MS: pct(trials.map((t) => (t.connect && t.connect.ok ? t.connect.ms : NaN)), 50),
      CONNECT_ERRORS: [...new Set(trials.map((t) => t.connect && t.connect.err).filter(Boolean))],
      NIP42_CHALLENGE_ON_CONNECT: trials.some((t) => t.challengeOnConnect),
      NIP42_REQUIRED: nip42Required,
      NIP42_SUPPORTED_BY_CLIENT: nip42Required ? 'WRITE_ONLY (ephemeral wrap key); identity READ auth not supported by design' : 'N/A',
      NIP42_AUTH_RESULT: nip42Required ? (writeAuthOk ? 'WRITE_AUTH_OK ' + writeAuthOk + '/' + TRIALS : 'WRITE_AUTH_FAILED') : 'NOT_REQUIRED',
      KIND1059_SUBSCRIBE: subTypes.join(' | '),
      KIND1059_PUBLISH: n((t) => (t.publish && t.publish.accepted) || (t.publishAfterAuth && t.publishAfterAuth.accepted)) + '/' + TRIALS,
      KIND1059_PUBLISH_REASONS: [...new Set(trials.map((t) => (t.publish ? (t.publish.timeout ? 'TIMEOUT' : (t.publish.reason || 'ok').slice(0, 70)) : 'NO_CONN')))],
      KIND1059_DELIVERY: n((t) => t.delivery && t.delivery.got) + '/' + TRIALS,
      DELIVERY_IF_IDENTITY_AUTH: idAuth.length ? idAuth.filter((x) => x.got).length + '/' + idAuth.length + ' (authAccepted ' + idAuth.filter((x) => x.authAccepted).length + ')' : 'N/A',
      KIND25050_READ: [...new Set(trials.map((t) => (t.sub25050 ? (t.sub25050.timeout ? 'TIMEOUT' : t.sub25050.type) : 'NO_CONN')))].join(' | '),
      PUBLISH_P50_MS: pct(pubMs, 50),
      PUBLISH_P95_MS: pct(pubMs, 95),
      DELIVERY_P50_MS: pct(delMs, 50),
      DELIVERY_P95_MS: pct(delMs, 95),
      TIMEOUT_COUNT: sum('timeout'),
      WS_ERROR_COUNT: sum('ws'),
      AUTH_REQUIRED_COUNT: sum('authRequired'),
      STABILITY: stab,
      _connectOk: n((t) => t.connect && t.connect.ok),
      _deliveryOk: n((t) => t.delivery && t.delivery.got),
    };
    r.RECOMMENDED_REALTIME_STATUS = classify(r);
    delete r._connectOk;
    delete r._deliveryOk;
    report.relays[url] = r;
    console.log(JSON.stringify(r));
  }
  const rows = Object.values(report.relays);
  report.healthyCallRelays = rows.filter((r) => r.CALL_SIGNAL_SET && (r.RECOMMENDED_REALTIME_STATUS === 'PRIMARY' || r.RECOMMENDED_REALTIME_STATUS === 'SECONDARY')).map((r) => r.RELAY);
  report.authRequiredEmitters = rows.filter((r) => r.AUTH_REQUIRED_COUNT > 0).map((r) => r.RELAY);
  report.RELAY_COMPATIBILITY_MATRIX_GATE = rows.length === RELAYS.length && rows.every((r) => r.RECOMMENDED_REALTIME_STATUS) ? 'PASS' : 'FAIL';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log('HEALTHY_CALL_RELAYS', report.healthyCallRelays.join(','));
  console.log('AUTH_REQUIRED_EMITTERS', report.authRequiredEmitters.join(','));
  console.log('RELAY_COMPATIBILITY_MATRIX_GATE=' + report.RELAY_COMPATIBILITY_MATRIX_GATE);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
