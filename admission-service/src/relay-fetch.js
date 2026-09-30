/**
 * Read-only relay query from the Worker (outbound WebSocket). A relay counts only after EOSE; a silent, closed or
 * failed relay never counts as confirmation. Returned events are untrusted input: callers re-verify everything.
 */
const MAX_EVENTS_PER_RELAY = 3000;

function toFetchUrl(url) {
  return String(url).replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

async function queryRelay(url, filters, timeoutMs) {
  let ws;
  try {
    const resp = await fetch(toFetchUrl(url), { headers: { Upgrade: 'websocket' } });
    ws = resp.webSocket;
    if (!ws) return { url, ok: false, events: [], code: 'NO_UPGRADE' };
    ws.accept();
  } catch (_e) {
    return { url, ok: false, events: [], code: 'CONNECT_FAILED' };
  }
  const subId = 'sos-ctl-' + Math.random().toString(36).slice(2, 10);
  return new Promise((resolve) => {
    const events = [];
    let settled = false;
    const finish = (ok, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.send(JSON.stringify(['CLOSE', subId]));
      } catch (_e) {}
      try {
        ws.close(1000, 'done');
      } catch (_e) {}
      resolve({ url, ok, events, code });
    };
    const timer = setTimeout(() => finish(false, 'TIMEOUT'), timeoutMs);
    ws.addEventListener('message', (m) => {
      let msg;
      try {
        msg = JSON.parse(typeof m.data === 'string' ? m.data : '');
      } catch (_e) {
        return;
      }
      if (!Array.isArray(msg) || msg[1] !== subId) return;
      if (msg[0] === 'EVENT') {
        if (msg[2] && typeof msg[2] === 'object' && events.length < MAX_EVENTS_PER_RELAY) events.push(msg[2]);
      } else if (msg[0] === 'EOSE') finish(true, 'EOSE');
      else if (msg[0] === 'CLOSED') finish(false, 'CLOSED');
    });
    ws.addEventListener('close', () => finish(false, 'CLOSED'));
    ws.addEventListener('error', () => finish(false, 'ERROR'));
    try {
      ws.send(JSON.stringify(['REQ', subId].concat(filters)));
    } catch (_e) {
      finish(false, 'SEND_FAILED');
    }
  });
}

export async function fetchFromRelays(relays, filters, timeoutMs) {
  const results = await Promise.all(relays.map((u) => queryRelay(u, filters, timeoutMs)));
  const byId = new Map();
  results.forEach((r) => {
    r.events.forEach((ev) => {
      if (ev && typeof ev.id === 'string' && !byId.has(ev.id)) byId.set(ev.id, ev);
    });
  });
  return {
    relaysOk: results.filter((r) => r.ok).length,
    relaysTotal: relays.length,
    events: Array.from(byId.values()),
    perRelay: results.map((r) => ({ url: r.url, ok: r.ok, code: r.code, events: r.events.length })),
  };
}
