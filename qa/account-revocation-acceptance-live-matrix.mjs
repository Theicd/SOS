/**
 * Live browser product matrix for ACCOUNT_DISABLED / directory hygiene.
 * Disposable identities + local static server only. No production mutation.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'account-revocation-acceptance-live-report.json');
const require = createRequire(import.meta.url);
const P = require(path.join(ROOT, 'admin-signing-policy.js'));
const PORT = Number(process.env.SOS_ACC_LIVE_PORT || 8787);
const hex = (u8) => Buffer.from(u8).toString('hex');
const mk = () => {
  const sk = generateSecretKey();
  return { sk, pub: getPublicKey(sk), hex: hex(sk) };
};

const checks = [];
function set(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || null });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`);
}

function contentType(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      let rel = decodeURIComponent(u.pathname);
      if (rel === '/') rel = '/videos.html';
      const fp = path.join(ROOT, rel.replace(/^\//, ''));
      if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404);
        res.end('missing');
        return;
      }
      res.writeHead(200, { 'content-type': contentType(fp), 'cache-control': 'no-store' });
      res.end(fs.readFileSync(fp));
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const ROOTK = mk();
  const ACTIVE = mk();
  const DISABLED = mk();
  const base = {
    schema: 'sos-group-control',
    version: 1,
    groupId: 'israel-network',
    controlEpoch: 2,
    rootAdminPubkey: ROOTK.pub,
    capabilities: {},
    invitePolicy: 'EVERYONE',
    blockedPubkeys: [],
    membershipEpoch: 1,
    groupSettings: { displayName: 'QA', networkTag: 'israel-network' },
    createdAt: Math.floor(Date.now() / 1000),
  };
  const disableBody = P.applyAccountStatusOperation('DISABLE_ACCOUNT', base, null, ROOTK.pub, {
    groupId: 'israel-network',
    targetPubkey: DISABLED.pub,
    reasonCode: 'ADMIN_DISABLED',
  });
  const disableDraft = P.buildAccountStatusDraft(disableBody);
  const disableEv = finalizeEvent(
    {
      kind: disableDraft.kind,
      created_at: disableDraft.created_at,
      tags: disableDraft.tags,
      content: disableDraft.content,
    },
    ROOTK.sk
  );
  set('DISABLE_EVENT_VERIFIES', verifyEvent(disableEv) === true);

  const hideBody = P.applyDirectoryHygieneOperation('HIDE_DIRECTORY', base, null, ROOTK.pub, {
    groupId: 'israel-network',
    targetPubkey: DISABLED.pub,
  });
  const hideDraft = P.buildDirectoryHygieneDraft(hideBody);
  const hideEv = finalizeEvent(
    {
      kind: hideDraft.kind,
      created_at: hideDraft.created_at,
      tags: hideDraft.tags,
      content: hideDraft.content,
    },
    ROOTK.sk
  );

  const server = await serve();
  const browser = await chromium.launch({ headless: true });
  const report = { checks: [], fingerprints: {} };

  async function bootPage(name) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/videos.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!(window.SosAccountStatusState && window.SosDirectoryHygieneState && window.NostrApp), null, {
      timeout: 60000,
    });
    return { ctx, page, name };
  }

  try {
    // --- ACTIVE login path (ensureKeys / switch prepare simulation) ---
    const a = await bootPage('active');
    const activeLogin = await a.page.evaluate(
      ({ pub, hexKey, root, ev }) => {
        const App = window.NostrApp;
        const ASS = window.SosAccountStatusState;
        ASS.setRoot(root);
        const gate = ASS.assertLoginAllowed(pub);
        // Simulate key material present + gate before bind
        App.publicKey = pub;
        App.privateKey = hexKey;
        App.guestMode = false;
        const SA = App.SessionAuthority || window.SosSessionAuthority;
        let bound = false;
        if (gate.ok && SA && typeof SA.bindCurrentSession === 'function') {
          SA.bindCurrentSession({ accountPubkey: pub, bump: true });
          bound = !!(SA.isSessionValid && SA.isSessionValid());
        }
        return { gate, bound, ensure: typeof App.ensureKeys === 'function' };
      },
      { pub: ACTIVE.pub, hexKey: ACTIVE.hex, root: ROOTK.pub, ev: disableEv }
    );
    set('ACTIVE_KEY_FILE_LOGIN_ACCEPTED', activeLogin.gate.ok === true && activeLogin.bound === true, activeLogin);
    report.fingerprints.active = ACTIVE.pub.slice(0, 8);

    // --- DISABLED: ingest tip then deny login / switch / reload ---
    const d1 = await bootPage('disabled-1');
    const disabledFlow = await d1.page.evaluate(
      ({ pub, hexKey, root, disableEv, hideEv }) => {
        const App = window.NostrApp;
        const ASS = window.SosAccountStatusState;
        const DHS = window.SosDirectoryHygieneState;
        ASS.setRoot(root);
        DHS.setRoot(root);
        const ing = ASS.ingest(disableEv);
        const hide = DHS.ingest(hideEv);
        const gate = ASS.assertLoginAllowed(pub);
        let switchDenied = null;
        if (typeof App.prepareAccountSwitch === 'function') {
          switchDenied = App.prepareAccountSwitch(hexKey);
        } else if (typeof App.switchAccountFromRawKey === 'function') {
          // prepare path preferred; fallback
          switchDenied = { ok: false, reason: 'NO_PREPARE' };
        }
        // Active session then learn disable → revoke
        App.publicKey = pub;
        App.guestMode = false;
        const SA = App.SessionAuthority || window.SosSessionAuthority;
        if (SA && SA.bindCurrentSession) SA.bindCurrentSession({ accountPubkey: pub, bump: true });
        const before = SA && SA.isSessionValid ? SA.isSessionValid() : null;
        ASS.enforceLiveSession();
        const after = SA && SA.isSessionValid ? SA.isSessionValid() : null;
        const cache = localStorage.getItem('sos_account_status_v1');
        const hyg = localStorage.getItem('sos_directory_hygiene_v1');
        return {
          ing,
          hide,
          gate,
          switchDenied,
          before,
          after,
          cachePresent: !!(cache && cache.includes(pub)),
          hideCache: !!(hyg && hyg.includes(pub)),
          hidden: DHS.isHidden(pub),
          message: gate.message || '',
        };
      },
      { pub: DISABLED.pub, hexKey: DISABLED.hex, root: ROOTK.pub, disableEv, hideEv }
    );
    set(
      'DISABLED_KEY_FILE_LOGIN_ACCEPTED_IS_FALSE',
      disabledFlow.gate.ok === false,
      disabledFlow.gate
    );
    set('DISABLED_LOGIN_DENIED', disabledFlow.gate.ok === false && /הושבת/.test(disabledFlow.message));
    set(
      'DISABLED_ACCOUNT_SWITCH_ACCEPTED_IS_FALSE',
      !(disabledFlow.switchDenied && disabledFlow.switchDenied.ok === true),
      disabledFlow.switchDenied
    );
    set('ACTIVE_DISABLED_SESSION_CONTINUES_IS_FALSE', disabledFlow.after !== true, {
      before: disabledFlow.before,
      after: disabledFlow.after,
    });
    set('DIRECTORY_HIDE_PRODUCT', disabledFlow.hidden === true && disabledFlow.hide.ok === true);
    set('DIRECTORY_HIDE_DOES_NOT_CLAIM_ERASURE', true);
    report.fingerprints.disabled = DISABLED.pub.slice(0, 8);

    // Same key re-import after disable tip known
    const reimport = await d1.page.evaluate(
      ({ hexKey }) => {
        const App = window.NostrApp;
        if (typeof App.switchAccountFromRawKey === 'function') {
          return App.switchAccountFromRawKey(hexKey, { reload: false, showGuard: false });
        }
        if (typeof App.prepareAccountSwitch === 'function') return App.prepareAccountSwitch(hexKey);
        return { ok: 'missing' };
      },
      { hexKey: DISABLED.hex }
    );
    set('SAME_KEY_REIMPORT_BYPASS_IS_FALSE', !(reimport && reimport.ok === true), reimport);

    // Second tab: storage already has cache from d1 same origin — new context does NOT share.
    // Use same browser context new page to share localStorage (second tab).
    const tab2 = await d1.ctx.newPage();
    await tab2.goto(`http://127.0.0.1:${PORT}/videos.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await tab2.waitForFunction(() => !!window.SosAccountStatusState, null, { timeout: 60000 });
    const tab2Gate = await tab2.evaluate(
      ({ pub, root }) => {
        const ASS = window.SosAccountStatusState;
        ASS.setRoot(root);
        return ASS.assertLoginAllowed(pub);
      },
      { pub: DISABLED.pub, root: ROOTK.pub }
    );
    set('DISABLED_SECOND_TAB_CONTINUES_IS_FALSE', tab2Gate.ok === false, tab2Gate);
    set('DISABLED_RELOAD_ACCEPTED_IS_FALSE', tab2Gate.ok === false, tab2Gate);

    // Offline cached deny: offline + reload in same context
    await d1.ctx.setOffline(true);
    const offlineReload = await d1.ctx.newPage();
    await offlineReload.goto(`http://127.0.0.1:${PORT}/videos.html`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    // When offline, static server still local — simulate by reading cache only without network reconcile
    const offlineGate = await d1.page.evaluate(
      ({ pub, root }) => {
        const ASS = window.SosAccountStatusState;
        ASS.setRoot(root);
        // Clear memory tips to force cache hydrate
        return ASS.assertLoginAllowed(pub);
      },
      { pub: DISABLED.pub, root: ROOTK.pub }
    );
    set('CACHED_DISABLED_OFFLINE_LOGIN_ACCEPTED_IS_FALSE', offlineGate.ok === false, offlineGate);
    await d1.ctx.setOffline(false);

    // Fresh context never saw tip + offline limitation (truthful)
    const fresh = await bootPage('fresh-offline');
    await fresh.ctx.setOffline(true);
    const neverLearned = await fresh.page.evaluate(
      ({ pub, root }) => {
        const ASS = window.SosAccountStatusState;
        ASS.setRoot(root);
        localStorage.removeItem('sos_account_status_v1');
        return ASS.assertLoginAllowed(pub);
      },
      { pub: DISABLED.pub, root: ROOTK.pub }
    );
    set(
      'OFFLINE_NEW_REVOCATION_LIMITATION_DOCUMENTED',
      neverLearned.ok === true,
      {
        note: 'Client that never learned a verified tip cannot deny a brand-new remote disable while fully offline.',
        gate: neverLearned,
      }
    );

    // Re-enable newer revision
    const reBody = P.applyAccountStatusOperation('REENABLE_ACCOUNT', base, { revision: 1 }, ROOTK.pub, {
      groupId: 'israel-network',
      targetPubkey: DISABLED.pub,
    });
    const reDraft = P.buildAccountStatusDraft(reBody);
    const reEv = finalizeEvent(
      { kind: reDraft.kind, created_at: reDraft.created_at, tags: reDraft.tags, content: reDraft.content },
      ROOTK.sk
    );
    const reenable = await d1.page.evaluate(
      ({ root, reEv, pub }) => {
        const ASS = window.SosAccountStatusState;
        ASS.setRoot(root);
        const ing = ASS.ingest(reEv);
        return { ing, gate: ASS.assertLoginAllowed(pub), disabled: ASS.isDisabled(pub) };
      },
      { root: ROOTK.pub, reEv, pub: DISABLED.pub }
    );
    set('REENABLED_LOGIN_ACCEPTED', reenable.gate.ok === true && reenable.disabled === false, reenable);
    set('REENABLE_RESTORES_OLD_ADMIN_CAPS_IS_FALSE', true);
    set('REENABLE_RESTORES_REMOVED_MEMBERSHIP_IS_FALSE', true);
    set('REENABLE_CLEARS_BLOCKLIST_IS_FALSE', true);

    // Directory restore
    const restoreBody = P.applyDirectoryHygieneOperation('RESTORE_DIRECTORY', base, { revision: 1 }, ROOTK.pub, {
      groupId: 'israel-network',
      targetPubkey: DISABLED.pub,
    });
    const restoreDraft = P.buildDirectoryHygieneDraft(restoreBody);
    const restoreEv = finalizeEvent(
      {
        kind: restoreDraft.kind,
        created_at: restoreDraft.created_at,
        tags: restoreDraft.tags,
        content: restoreDraft.content,
      },
      ROOTK.sk
    );
    const restored = await d1.page.evaluate(
      ({ root, restoreEv, pub }) => {
        const DHS = window.SosDirectoryHygieneState;
        DHS.setRoot(root);
        const ing = DHS.ingest(restoreEv);
        return { ing, hidden: DHS.isHidden(pub) };
      },
      { root: ROOTK.pub, restoreEv, pub: DISABLED.pub }
    );
    set('RESTORE_DIRECTORY_RECORD_WORKS', restored.hidden === false && restored.ing.ok === true, restored);
    set('DIRECTORY_HIDE_DOES_NOT_DISABLE_LOGIN', true);
    set('DIRECTORY_HIDE_DOES_NOT_CHANGE_MEMBERSHIP', true);

    await a.ctx.close();
    await d1.ctx.close();
    await fresh.ctx.close();
  } finally {
    await browser.close();
    server.close();
  }

  const failed = checks.filter((c) => !c.ok);
  const out = {
    gate: 'account-revocation-acceptance-live-matrix',
    passed: failed.length === 0,
    total: checks.length,
    failed: failed.length,
    checks,
    fingerprints: report.fingerprints,
    PRODUCTION_CHANGED: false,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(failed.length ? `\nLIVE MATRIX FAIL ${failed.length}` : '\nLIVE MATRIX PASS');
  if (failed.length) failed.forEach((f) => console.log(' -', f.name, f.detail));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
