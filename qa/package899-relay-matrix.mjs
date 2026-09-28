/**
 * Package 899 — per-relay compatibility matrix for realtime signaling.
 * Raw NIP-01 WebSocket (so AUTH challenges and OK/CLOSED reasons are visible). Disposable keys only; never logs keys.
 * Run: node --experimental-websocket qa/package899-relay-matrix.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, finalizeEvent, nip59 } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'package899-relay-matrix-report.json');
const RELAYS = [
  'wss://relay.snort.social',
  'wss://nos.lol',
  'wss://nostr-relay.xbytez.io',
  'wss://nostr-02.uid.ovh',
  'wss://nostr.0x7e.xyz',
];
const TRIALS = Number(process.env.SOS_RELAY_TRIALS || 3);
const T = 6000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

function open(url) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      resolve({ ok: false, err: 'CONSTRUCT', ms: 0 });
      return;
    }
    const conn = { ws, msgs: [], challenge: null, listeners: new Set(), closed: false };
    const timer = setTimeout(() => resolve({ ok: false, err: 'CONNECT_TIMEOUT', ms: Date.now() - t0 }), T);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({ ok: true, ms: Date.now() - t0, conn });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve({ ok: false, err: 'CONNECT_ERROR', ms: Date.now() - t0 });
    };
    ws.onclose = () => {
      conn.closed = true;
    };
    ws.onmessage = (m) => {
      let msg;
      try {
        msg = JSON.parse(String(m.data));
      } catch (_e) {
        return;
      }
      if (msg[0] === 'AUTH') conn.challenge = msg[1];
      conn.msgs.push({ at: Date.now(), msg });
      conn.listeners.forEach((fn) => fn(msg));
    };
  });
}

function waitFor(conn, pred, ms = T) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const done = (v) => {
      conn.listeners.delete(fn);
      clearTimeout(timer);
      resolve(Object.assign({ ms: Date.now() - t0 }, v));
    };
    const fn = (msg) => {
      const r = pred(msg);
      if (r) done(r);
    };
    const timer = setTimeout(() => done({ timeout: true }), ms);
    conn.listeners.add(fn);
  });
}

async function publish(conn, ev) {
  conn.ws.send(JSON.stringify(['EVENT', ev]));
  return waitFor(conn, (m) => (m[0] === 'OK' && m[1] === ev.id ? { accepted: m[2] === true, reason: String(m[3] || '') } : null));
}

async function authenticate(conn, sk, url) {
  if (!conn.challenge) return { attempted: false };
  const ev = finalizeEvent({ kind: 22242, created_at: now(), tags: [['relay', url], ['challenge', conn.challenge]], content: '' }, sk);
  conn.ws.send(JSON.stringify(['AUTH', ev]));
  const r = await waitFor(conn, (m) => (m[0] === 'OK' && m[1] === ev.id ? { accepted: m[2] === true, reason: String(m[3] || '') } : null));
  return { attempted: true, accepted: r.accepted === true, reason: r.reason, ms: r.ms };
}

function giftWrap(senderSk, recipientPub) {
  const rumor = { kind: 25050, created_at: now(), tags: [['p', recipientPub]], content: JSON.stringify({ family: 'sos-relay-matrix', v: 1 }) };
  return nip59.wrapEvent(rumor, senderSk, recipientPub);
}

async function trial(url) {
  const senderSk = generateSecretKey();
  const recipSk = generateSecretKey();
  const recipPub = getPublicKey(recipSk);
  const out = { connect: null, authChallengeOnConnect: false, sub: null, publish1059: null, auth: null, publish1059AfterAuth: null, delivery1059: null, publish25055: null, readAuth: null };
  const a = await open(url);
  const b = await open(url);
  out.connect = { ok: a.ok && b.ok, ms: a.ms, err: a.err || b.err || null };
  if (!a.ok || !b.ok) {
    try { a.conn && a.conn.ws.close(); b.conn && b.conn.ws.close(); } catch (_e) {}
    return out;
  }
  await sleep(700);
  out.authChallengeOnConnect = !!(a.conn.challenge || b.conn.challenge);
  const subId = 'm' + Math.random().toString(36).slice(2, 10);
  b.conn.ws.send(JSON.stringify(['REQ', subId, { kinds: [1059], '#p': [recipPub], since: now() - 172800 }]));
  let sub = await waitFor(b.conn, (m) => (m[1] === subId && (m[0] === 'EOSE' || m[0] === 'CLOSED') ? { type: m[0], reason: String(m[2] || '') } : null));
  if (sub.type === 'CLOSED' && /auth/i.test(sub.reason)) {
    out.readAuth = await authenticate(b.conn, recipSk, url);
    b.conn.ws.send(JSON.stringify(['REQ', subId, { kinds: [1059], '#p': [recipPub], since: now() - 172800 }]));
    sub = await waitFor(b.conn, (m) => (m[1] === subId && (m[0] === 'EOSE' || m[0] === 'CLOSED') ? { type: m[0], reason: String(m[2] || '') } : null));
  }
  out.sub = sub;
  const wrap = giftWrap(senderSk, recipPub);
  const delivered = waitFor(b.conn, (m) => (m[0] === 'EVENT' && m[1] === subId && m[2] && m[2].id === wrap.id ? { got: true } : null), 8000);
  const t0 = Date.now();
  out.publish1059 = await publish(a.conn, wrap);
  if (!out.publish1059.accepted && /auth/i.test(out.publish1059.reason)) {
    // Gift wraps are signed by a random wrapper key; relays that demand AUTH usually require the authed pubkey to
    // match nothing in particular for writes. Authenticate as the (disposable) sender and retry once.
    out.auth = await authenticate(a.conn, senderSk, url);
    const wrap2 = giftWrap(senderSk, recipPub);
    const delivered2 = waitFor(b.conn, (m) => (m[0] === 'EVENT' && m[1] === subId && m[2] && m[2].id === wrap2.id ? { got: true } : null), 8000);
    out.publish1059AfterAuth = await publish(a.conn, wrap2);
    const d2 = await delivered2;
    out.delivery1059 = d2.got ? { got: true, ms: Date.now() - t0 } : { got: false };
  } else {
    const d = await delivered;
    out.delivery1059 = d.got ? { got: true, ms: d.ms } : { got: false };
  }
  const sig = finalizeEvent({ kind: 25055, created_at: now(), tags: [['type', 'dc-probe'], ['p', recipPub]], content: 'probe' }, senderSk);
  out.publish25055 = await publish(a.conn, sig);
  try {
    a.conn.ws.close();
    b.conn.ws.close();
  } catch (_e) {}
  return out;
}

const pct = (arr, p) => {
  const v = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
};

async function main() {
  const report = { gate: 'PACKAGE899_RELAY_MATRIX', ts: new Date().toISOString(), trials: TRIALS, relays: {} };
  for (const url of RELAYS) {
    const trials = [];
    for (let i = 0; i < TRIALS; i++) trials.push(await trial(url));
    const ok = (f) => trials.filter(f).length;
    const r = {
      connectOk: ok((t) => t.connect && t.connect.ok) + '/' + TRIALS,
      connectMsP50: pct(trials.map((t) => t.connect && t.connect.ms), 50),
      authChallengeOnConnect: trials.some((t) => t.authChallengeOnConnect),
      subscribe1059: [...new Set(trials.map((t) => (t.sub ? t.sub.type + (t.sub.reason ? ':' + t.sub.reason.slice(0, 60) : '') : 'NONE')))],
      readRequiresAuth: trials.some((t) => t.readAuth && t.readAuth.attempted),
      publish1059Accepted: ok((t) => t.publish1059 && t.publish1059.accepted) + '/' + TRIALS,
      publish1059Reasons: [...new Set(trials.map((t) => (t.publish1059 ? (t.publish1059.timeout ? 'TIMEOUT' : t.publish1059.reason.slice(0, 80)) : 'NO_CONN')))],
      publish1059MsP50: pct(trials.map((t) => t.publish1059 && !t.publish1059.timeout ? t.publish1059.ms : NaN), 50),
      nip42Required: trials.some((t) => t.auth && t.auth.attempted) || trials.some((t) => /auth/i.test((t.publish1059 && t.publish1059.reason) || '')),
      nip42AuthAccepted: trials.some((t) => t.auth && t.auth.accepted),
      publish1059AfterAuthAccepted: ok((t) => t.publish1059AfterAuth && t.publish1059AfterAuth.accepted) + '/' + TRIALS,
      publish1059AfterAuthReasons: [...new Set(trials.filter((t) => t.publish1059AfterAuth).map((t) => t.publish1059AfterAuth.reason.slice(0, 80)))],
      delivery1059: ok((t) => t.delivery1059 && t.delivery1059.got) + '/' + TRIALS,
      deliveryMsP50: pct(trials.map((t) => (t.delivery1059 && t.delivery1059.got ? t.delivery1059.ms : NaN)), 50),
      publish25055Accepted: ok((t) => t.publish25055 && t.publish25055.accepted) + '/' + TRIALS,
      publish25055Reasons: [...new Set(trials.map((t) => (t.publish25055 ? (t.publish25055.timeout ? 'TIMEOUT' : t.publish25055.reason.slice(0, 60)) : 'NO_CONN')))],
    };
    report.relays[url] = r;
    console.log(url, JSON.stringify(r));
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
