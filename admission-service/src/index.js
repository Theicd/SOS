import { InviteLedger, SERVICE_TAG } from './ledger.js';
import { GroupAuthority } from './group.js';
import { AdminPinAuthority } from './pin.js';
import { cosignPubkey } from './cosign-keys.js';

export { InviteLedger, GroupAuthority, AdminPinAuthority };

const PIN_ROUTES = {
  '/v1/admin-pin/params': '/params',
  '/v1/admin-pin/session': '/session',
  '/v1/admin-pin/enroll': '/enroll',
  '/v1/admin-pin/verify': '/verify',
  '/v1/admin-pin/cosign': '/cosign',
  '/v1/admin-pin/lock': '/lock',
  '/v1/test/pin-inspect': '/inspect',
};

const MAX_BODY_BYTES = 256 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
// Per-isolate abuse guard (not identity): bounds work per isolate without treating IP as a principal.
const WINDOW_MS = 10000;
const WINDOW_MAX = 2000;
let windowStart = 0;
let windowCount = 0;

function rateLimited() {
  const now = Date.now();
  if (now - windowStart > WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
  }
  windowCount++;
  return windowCount > WINDOW_MAX;
}

/** CORS only controls which browser origins may read responses; every mutation is authorized by signatures. */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const h = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  };
  if (origin && allowed.indexOf(origin) !== -1) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}

function reply(request, env, body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders(request, env)),
  });
}

function inviteIdFor(path, body) {
  let v = '';
  if (path === '/v1/invites/register') v = body.invite && body.invite.id;
  else if (path === '/v1/invites/redeem') {
    const t = body.request && Array.isArray(body.request.tags) ? body.request.tags.find((x) => Array.isArray(x) && x[0] === 'e') : null;
    v = t ? t[1] : '';
  } else if (path === '/v1/invites/revoke') {
    const t = body.revoke && Array.isArray(body.revoke.tags) ? body.revoke.tags.find((x) => Array.isArray(x) && x[0] === 'd') : null;
    v = t ? t[1] : '';
  } else if (path === '/v1/invites/status' || path === '/v1/test/inspect') v = body.inviteId;
  v = String(v || '').toLowerCase();
  return HEX64.test(v) ? v : '';
}

const ROUTES = {
  '/v1/invites/register': '/register',
  '/v1/invites/redeem': '/redeem',
  '/v1/invites/revoke': '/revoke',
  '/v1/invites/status': '/status',
  '/v1/test/inspect': '/inspect',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    if (request.method === 'GET' && url.pathname === '/v1/health') {
      // Public facts only: no secrets, no invite or member data.
      const health = {
        result: 'OK',
        service: 'sos-first-group-admission',
        protocol: SERVICE_TAG,
        protocolVersion: 1,
        environment: String(env.SOS_ENV || 'local'),
        group: env.FIRST_GROUP_ID,
        rootPubkey: String(env.ROOT_PUBKEY || ''),
        testFaults: env.TEST_FAULTS === '1',
        durableObjectReachable: false,
        controlStatus: null,
        servicePubkey: null,
        delegationActive: false,
        cosignPubkey: null,
        adminPinService: false,
      };
      try {
        health.cosignPubkey = cosignPubkey(env);
        health.adminPinService = !!env.ADMIN_PIN && /^[0-9a-f]{64}$/i.test(String(env.ADMIN_PIN_PEPPER || ''));
      } catch (_e) {
        health.cosignPubkey = null;
      }
      try {
        const stub = env.GROUP.get(env.GROUP.idFromName(env.FIRST_GROUP_ID));
        const snap = await (await stub.fetch('https://group/snapshot')).json();
        health.durableObjectReachable = true;
        health.controlStatus = snap.status || snap.code || null;
        health.servicePubkey = snap.delegate ? snap.delegate.pubkey : null;
        health.delegationActive = !!(snap.delegate && snap.delegate.active);
      } catch (_e) {
        health.result = 'DEGRADED';
      }
      return reply(request, env, health);
    }
    if (request.method !== 'POST') return reply(request, env, { result: 'INVALID', code: 'METHOD' }, 405);
    if (rateLimited()) return reply(request, env, { result: 'TEMPORARILY_UNAVAILABLE', code: 'RATE_LIMITED' }, 429);

    let body;
    try {
      const len = Number(request.headers.get('Content-Length') || 0);
      if (len > MAX_BODY_BYTES) return reply(request, env, { result: 'INVALID', code: 'TOO_LARGE' }, 413);
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return reply(request, env, { result: 'INVALID', code: 'TOO_LARGE' }, 413);
      body = JSON.parse(text);
    } catch (_e) {
      return reply(request, env, { result: 'INVALID', code: 'BAD_JSON' }, 400);
    }
    if (!body || typeof body !== 'object' || body.groupId !== env.FIRST_GROUP_ID) {
      return reply(request, env, { result: 'INVALID', code: 'WRONG_GROUP' }, 400);
    }

    try {
      if (url.pathname === '/v1/control/ingest') {
        const stub = env.GROUP.get(env.GROUP.idFromName(env.FIRST_GROUP_ID));
        const res = await stub.fetch('https://group/ingest', {
          method: 'POST',
          body: JSON.stringify({ events: Array.isArray(body.events) ? body.events.slice(0, 500) : [] }),
        });
        return reply(request, env, await res.json());
      }
      const pinInner = PIN_ROUTES[url.pathname];
      if (pinInner) {
        if (!env.ADMIN_PIN || (pinInner === '/inspect' && env.TEST_FAULTS !== '1')) {
          return reply(request, env, { result: 'INVALID', code: 'NOT_FOUND' }, 404);
        }
        const stub = env.ADMIN_PIN.get(env.ADMIN_PIN.idFromName('admin-pin:' + env.FIRST_GROUP_ID));
        const headers = { 'Content-Type': 'application/json' };
        const testNow = request.headers.get('x-sos-test-now');
        if (testNow && env.TEST_FAULTS === '1') headers['x-sos-test-now'] = testNow;
        const res = await stub.fetch('https://admin-pin' + pinInner, { method: 'POST', headers, body: JSON.stringify(body) });
        return reply(request, env, await res.json(), res.status === 503 ? 503 : 200);
      }
      const inner = ROUTES[url.pathname];
      if (!inner || (inner === '/inspect' && env.TEST_FAULTS !== '1')) {
        return reply(request, env, { result: 'INVALID', code: 'NOT_FOUND' }, 404);
      }
      const inviteId = inviteIdFor(url.pathname, body);
      if (!inviteId) return reply(request, env, { result: 'INVALID', code: 'NO_INVITE_ID' }, 400);
      const stub = env.INVITES.get(env.INVITES.idFromName(env.FIRST_GROUP_ID + ':' + inviteId));
      const headers = { 'Content-Type': 'application/json' };
      const fault = request.headers.get('x-sos-test-fault');
      if (fault && env.TEST_FAULTS === '1') headers['x-sos-test-fault'] = fault;
      const res = await stub.fetch('https://invite' + inner + '?invite=' + inviteId, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      return reply(request, env, await res.json());
    } catch (_e) {
      return reply(request, env, { result: 'TEMPORARILY_UNAVAILABLE', code: 'UPSTREAM' }, 503);
    }
  },
};
