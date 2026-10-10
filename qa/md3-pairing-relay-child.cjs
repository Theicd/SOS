/**
 * Child-process Nostr relay for MD3 QA.
 * MUST run in its own OS process: on Windows+Hyper-V emulator, a WebSocketServer
 * in the same Node process as other WS clients/servers can black-hole 10.0.2.2 accepts.
 */
const { WebSocketServer } = require('ws');
const { verifyEvent } = require('nostr-tools');

const PORT = Number(process.env.SOS_RELAY_PORT || 7805);
const HOST = process.env.SOS_RELAY_HOST || '0.0.0.0';

const clients = new Set();
const stats = {
  connections: 0,
  reqs: 0,
  received: 0,
  accepted: 0,
  rejected: 0,
  broadcast: 0,
  rejectReasons: [],
};

function match(ev, f) {
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f['#t']) {
    const ts = (ev.tags || []).filter((t) => t[0] === 't').map((t) => t[1]);
    if (!f['#t'].some((x) => ts.includes(x))) return false;
  }
  if (f['#d']) {
    const ds = (ev.tags || []).filter((t) => t[0] === 'd').map((t) => String(t[1] || '').toLowerCase());
    if (!f['#d'].some((x) => ds.includes(String(x).toLowerCase()))) return false;
  }
  return true;
}

function broadcast(ev) {
  stats.broadcast++;
  for (const c of clients) {
    for (const [id, filters] of c.subs) {
      if (filters.some((f) => match(ev, f))) {
        try {
          c.ws.send(JSON.stringify(['EVENT', id, ev]));
        } catch (_e) {}
      }
    }
  }
}

const wss = new WebSocketServer({ host: HOST, port: PORT });
wss.on('listening', () => {
  console.log(JSON.stringify({ type: 'RELAY_UP', host: HOST, port: PORT }));
});
wss.on('error', (e) => {
  console.error(JSON.stringify({ type: 'RELAY_ERR', err: String(e.message || e) }));
  process.exit(1);
});
wss.on('connection', (ws, req) => {
  stats.connections++;
  const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  console.log(
    JSON.stringify({
      type: 'CONN',
      remote,
      ua: String(req.headers['user-agent'] || '').slice(0, 40),
      connections: stats.connections,
    }),
  );
  const c = { ws, subs: new Map() };
  clients.add(c);
  ws.on('message', (d) => {
    let m;
    try {
      m = JSON.parse(String(d));
    } catch (_e) {
      return;
    }
    if (!Array.isArray(m)) return;
    if (m[0] === 'EVENT') {
      const ev = m[1];
      stats.received++;
      console.log(
        JSON.stringify({
          type: 'EVENT',
          kind: ev && ev.kind,
          idFp: String((ev && ev.id) || '').slice(0, 16),
        }),
      );
      if (!verifyEvent(ev)) {
        stats.rejected++;
        stats.rejectReasons.push('BAD_SIG_OR_ID');
        try {
          ws.send(JSON.stringify(['OK', ev && ev.id, false, 'invalid']));
        } catch (_e) {}
        return;
      }
      stats.accepted++;
      try {
        ws.send(JSON.stringify(['OK', ev.id, true, '']));
      } catch (_e) {}
      broadcast(ev);
    } else if (m[0] === 'REQ') {
      stats.reqs++;
      const [, id, ...filters] = m;
      c.subs.set(id, filters);
      console.log(
        JSON.stringify({
          type: 'REQ',
          id: String(id).slice(0, 24),
          filterFp: JSON.stringify(filters).slice(0, 120),
        }),
      );
      try {
        ws.send(JSON.stringify(['EOSE', id]));
      } catch (_e) {}
    } else if (m[0] === 'CLOSE') {
      c.subs.delete(m[1]);
    }
  });
  ws.on('close', () => clients.delete(c));
  ws.on('error', () => {});
});

process.on('message', (msg) => {
  if (msg && msg.type === 'STATS') {
    try {
      process.send({ type: 'STATS', stats });
    } catch (_e) {}
  }
  if (msg && msg.type === 'STOP') {
    wss.close(() => process.exit(0));
  }
});
