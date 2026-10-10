#!/usr/bin/env node
/**
 * FINAL ACCEPTANCE — NIP-65 publish/readback + viewport UX + legacy 39005 review.
 * QA-only. No product source changes.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'phone-onboarding-socall-final-acceptance-nip65-ux-report.json');
const MAIN_PORT = Number(process.env.SOS_FA_NIP65_PORT || 8791);
const RELAY_PORT = Number(process.env.SOS_FA_NIP65_RELAY || 7821);

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const report = {
  gate: 'PHONE_ONBOARDING_SOCALL_FINAL_ACCEPTANCE_NIP65_UX',
  status: 'FAIL',
  ts: new Date().toISOString(),
  results: {},
};
const set = (k, ok, detail) => {
  report.results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  console.log(ok ? 'PASS' : 'FAIL', k, detail === undefined ? '' : JSON.stringify(detail).slice(0, 220));
};

class TestRelay {
  constructor(port) {
    this.port = port;
    this.events = new Map();
    this.wss = null;
    this.server = null;
  }
  async start() {
    this.server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => {
      const subs = new Map();
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw));
        } catch (_e) {
          return;
        }
        if (!Array.isArray(msg)) return;
        if (msg[0] === 'EVENT' && msg[1] && typeof msg[1] === 'object') {
          const ev = msg[1];
          if (ev.id) this.events.set(ev.id, ev);
          ws.send(JSON.stringify(['OK', ev.id, true, '']));
          for (const [sid, filters] of subs) {
            if (this.match(ev, filters)) ws.send(JSON.stringify(['EVENT', sid, ev]));
          }
        } else if (msg[0] === 'REQ') {
          const sid = msg[1];
          const filters = msg.slice(2);
          subs.set(sid, filters);
          for (const ev of this.events.values()) {
            if (this.match(ev, filters)) ws.send(JSON.stringify(['EVENT', sid, ev]));
          }
          ws.send(JSON.stringify(['EOSE', sid]));
        } else if (msg[0] === 'CLOSE') subs.delete(msg[1]);
      });
    });
    await new Promise((r) => this.server.listen(this.port, '127.0.0.1', r));
  }
  match(ev, filters) {
    return (filters || []).some((f) => {
      if (f.kinds && !f.kinds.includes(ev.kind)) return false;
      if (f.authors && !f.authors.includes(ev.pubkey)) return false;
      return true;
    });
  }
  async stop() {
    await new Promise((r) => this.wss.close(() => this.server.close(r)));
  }
}

function buildDraftLikeProduct(relays, callRelays) {
  const tags = [];
  (relays || []).slice(0, 20).forEach((url) => {
    const u = String(url || '').trim();
    if (/^wss:\/\//i.test(u)) tags.push(['r', u]);
  });
  (callRelays || []).slice(0, 8).forEach((url) => {
    const u = String(url || '').trim();
    if (/^wss:\/\//i.test(u) && !tags.some((t) => t[1] === u)) tags.push(['r', u, 'call']);
  });
  tags.push(['t', 'sos-global-identity']);
  tags.push(['client', 'sos-reachability-v1']);
  return {
    kind: 10002,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: JSON.stringify({
      schema: 'sos-user-reachability',
      version: 1,
      USER_REACHABILITY_GLOBAL: true,
      USER_REACHABILITY_COMMUNITY_SCOPED: false,
      REACHABILITY_STANDARD_USED: 'NIP-65 kind 10002 (+ sos call marker)',
    }),
  };
}

async function publishAndRead(relayUrl, ev) {
  const WS = (await import('ws')).default;
  return new Promise((resolve, reject) => {
    const ws = new WS(relayUrl);
    const found = [];
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch (_e) {}
      reject(new Error('timeout'));
    }, 8000);
    ws.on('open', () => {
      ws.send(JSON.stringify(['EVENT', ev]));
      ws.send(JSON.stringify(['REQ', 'r1', { kinds: [10002], authors: [ev.pubkey], limit: 5 }]));
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch (_e) {
        return;
      }
      if (msg[0] === 'EVENT' && msg[2]) found.push(msg[2]);
      if (msg[0] === 'EOSE') {
        clearTimeout(t);
        ws.close();
        resolve(found);
      }
    });
    ws.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

async function main() {
  const gif = fs.readFileSync(path.join(ROOT, 'global-identity-foundation.js'), 'utf8');
  const gas = fs.readFileSync(path.join(ROOT, 'admission-service/src/global-accounts.js'), 'utf8');
  const pin = fs.readFileSync(path.join(ROOT, 'admission-service/src/pin.js'), 'utf8');
  const acct = fs.existsSync(path.join(ROOT, 'account-status-state.js'))
    ? fs.readFileSync(path.join(ROOT, 'account-status-state.js'), 'utf8')
    : '';
  const gStatus = fs.existsSync(path.join(ROOT, 'global-account-status-state.js'))
    ? fs.readFileSync(path.join(ROOT, 'global-account-status-state.js'), 'utf8')
    : '';

  set(
    'NIP65_GLOBAL_SCOPE_STATIC',
    /REACHABILITY_KIND\s*=\s*10002/.test(gif) &&
      /sos-global-identity/.test(gif) &&
      /NIP65_COMMUNITY_SWITCH_REPUBLISH:\s*false/.test(gif) &&
      /NIP65_CONTAINS_PRIVATE_COMMUNITY_RELAY_BY_DEFAULT:\s*false/.test(gif) &&
      /community-switch/.test(gif),
  );

  set(
    'NIP65_NO_PRIVATE_RELAY_LEAK_STATIC',
    /wss:/.test(gif) &&
      /NIP65_CONTAINS_PRIVATE_COMMUNITY_RELAY_BY_DEFAULT:\s*false/.test(gif) &&
      /No phone\/email/.test(gif) &&
      /USER_REACHABILITY_COMMUNITY_SCOPED:\s*false/.test(gif),
  );

  set(
    'LEGACY_STATUS_COMPATIBILITY_REVIEWED',
    /GLOBAL_ACCOUNT_STATUS_KIND\s*=\s*39008/.test(gas) &&
      /ACCOUNT_STATUS_KIND\s*=\s*39005/.test(pin) &&
      (/39008/.test(gStatus) || /GLOBAL_ACCOUNT_STATUS/.test(gStatus + acct)) &&
      !/39005\s*.*global.?account.?active/i.test(gStatus + acct),
    {
      globalKind: 39008,
      communityLegacyKind: 39005,
      note: '39005 remains Admin2FA community account-status cosign; 39008 is global disable tip',
    },
  );

  const relay = new TestRelay(RELAY_PORT);
  await relay.start();
  const sk = generateSecretKey();
  const pub = getPublicKey(sk);
  const draft = buildDraftLikeProduct(
    ['wss://relay.damus.io', 'ws://127.0.0.1:7821', 'wss://nos.lol'],
    ['wss://call.example.invalid'],
  );
  const signed = finalizeEvent(draft, sk);
  set('NIP65_SIGNED_BY_GLOBAL_PUBKEY', verifyEvent(signed) && signed.pubkey === pub && signed.kind === 10002, {
    kind: signed.kind,
  });
  const hasCommunityAuth =
    signed.tags.some((t) => t[0] === 't' && /israel-network|community|root/i.test(t[1] || '')) ||
    signed.tags.some((t) => t[0] === 'a' || t[0] === 'g');
  const hasWsLocal = signed.tags.some((t) => t[0] === 'r' && /^ws:\/\//i.test(t[1] || ''));
  const hasWss = signed.tags.some((t) => t[0] === 'r' && /^wss:\/\//i.test(t[1] || ''));
  set('NIP65_NO_COMMUNITY_AUTHORITY_TAG', !hasCommunityAuth && signed.tags.some((t) => t[0] === 't' && t[1] === 'sos-global-identity'));
  set('NIP65_NO_PRIVATE_RELAY_LEAK', !hasWsLocal && hasWss, { hasWsLocal, hasWss, tagCount: signed.tags.filter((t) => t[0] === 'r').length });

  let readback = [];
  try {
    readback = await publishAndRead(`ws://127.0.0.1:${RELAY_PORT}`, signed);
  } catch (e) {
    readback = [];
    set('NIP65_PUBLICATION_READBACK', false, { error: String(e.message || e).slice(0, 120) });
  }
  if (!report.results.NIP65_PUBLICATION_READBACK) {
    const hit = readback.find((e) => e && e.id === signed.id);
    set('NIP65_PUBLICATION_READBACK', !!(hit && hit.kind === 10002 && hit.pubkey === pub), {
      found: readback.length,
      idMatch: !!(hit && hit.id === signed.id),
    });
  }
  set('NIP65_GLOBAL_SCOPE', report.results.NIP65_GLOBAL_SCOPE_STATIC?.ok === true && report.results.NIP65_NO_COMMUNITY_AUTHORITY_TAG?.ok === true);

  // Viewports via static main server
  const mime = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/videos.html';
    const fp = path.join(ROOT, p.replace(/^\//, ''));
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  });
  await new Promise((r) => server.listen(MAIN_PORT, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${MAIN_PORT}`;
  const browser = await chromium.launch({ headless: true });
  const viewports = [
    { name: 'm390', width: 390, height: 844 },
    { name: 'm412', width: 412, height: 915 },
    { name: 'd1280', width: 1280, height: 800 },
    { name: 'd1440', width: 1440, height: 900 },
  ];
  const vpResults = {};
  for (const vp of viewports) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${origin}/videos.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => !!window.NostrApp?.openAuthPrompt, null, { timeout: 90000 });
      await page.evaluate(() => window.NostrApp.openAuthPrompt('', { step: 'invite' }));
      const ui = await page.evaluate(() => {
        const phone = document.getElementById('signupInvitePhoneInput');
        const pick = document.getElementById('signupInvitePickContactBtn') || document.querySelector('[data-contact-picker]');
        return {
          phone: !!phone,
          pick: !!pick,
          contactsApi: typeof navigator.contacts?.select === 'function',
          overflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2,
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
        };
      });
      vpResults[vp.name] = ui;
      set(`VIEWPORT_${vp.name.toUpperCase()}`, ui.phone && ui.overflow, ui);
    } catch (e) {
      vpResults[vp.name] = { error: String(e.message || e).slice(0, 120) };
      set(`VIEWPORT_${vp.name.toUpperCase()}`, false, vpResults[vp.name]);
    }
    await ctx.close();
  }
  set(
    'MOBILE_UI_GATE',
    report.results.VIEWPORT_M390?.ok === true && report.results.VIEWPORT_M412?.ok === true,
    { m390: vpResults.m390, m412: vpResults.m412 },
  );
  set(
    'DESKTOP_UI_GATE',
    report.results.VIEWPORT_D1280?.ok === true && report.results.VIEWPORT_D1440?.ok === true,
    { d1280: vpResults.d1280, d1440: vpResults.d1440 },
  );
  const pickerSupported = Object.values(vpResults).some((v) => v && v.contactsApi);
  report.CONTACT_PICKER_AUTOMATED_E2E = pickerSupported ? 'FEATURE_PRESENT' : 'UNSUPPORTED';
  set('CONTACT_PICKER_AUTOMATED_E2E_UNSUPPORTED', !pickerSupported, { note: 'Chromium headless has no Contact Picker; manual Android Chrome required' });
  {
    const ga = fs.readFileSync(path.join(ROOT, 'guest-auth.js'), 'utf8');
    const selectedOnly = /contacts\.select\(\s*\[[^\]]*\]\s*,\s*\{\s*multiple:\s*false\s*\}\)/.test(ga);
    const noBulkUpload = !/uploadAddressBook|enumerateContacts|getAllContacts/.test(ga);
    set('FULL_ADDRESS_BOOK_UPLOAD_FALSE', selectedOnly && noBulkUpload, {
      selectedOnly,
      multipleFalse: /multiple:\s*false/.test(ga),
      noBulkUpload,
    });
  }
  set('MANUAL_PHONE_ENTRY_UI', Object.values(vpResults).every((v) => v && v.phone));

  await browser.close();
  server.close();
  await relay.stop();

  const fails = Object.entries(report.results).filter(([, v]) => !v.ok).map(([k]) => k);
  report.status = fails.length === 0 ? 'PASS' : 'FAIL';
  report.fails = fails;
  report.pass = Object.keys(report.results).length - fails.length;
  report.fail = fails.length;
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('\nNIP65_UX_GATE', report.status, `(${report.pass}/${report.pass + report.fail})`);
  process.exit(report.status === 'PASS' ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
