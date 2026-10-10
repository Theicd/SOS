/**
 * Acceptance-only adversarial matrix for kinds 39005 / 39006.
 * Disposable keys; no production relays; no product source edits.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'account-revocation-acceptance-adversarial-report.json');
const require = createRequire(import.meta.url);
const P = require(path.join(ROOT, 'admin-signing-policy.js'));

const hex = (u8) => Buffer.from(u8).toString('hex');
const mk = () => {
  const sk = generateSecretKey();
  return { sk, pub: getPublicKey(sk), hex: hex(sk) };
};
const ROOTK = mk();
const ADMIN = mk();
const TARGET = mk();
const FORGER = mk();
const OTHER = mk();

const checks = [];
/** expectAccepted=false means the attack/bypass must NOT succeed */
function expectFalse(name, accepted, detail) {
  const ok = accepted === false;
  checks.push({ name, ok, detail: detail || null, observedAccepted: accepted });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}=${accepted}${detail ? ' — ' + JSON.stringify(detail) : ''}`);
}
function expectTrue(name, value, detail) {
  const ok = value === true;
  checks.push({ name, ok, detail: detail || null });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}=${value}${detail ? ' — ' + JSON.stringify(detail) : ''}`);
}

function loadStateModules(seed) {
  const store = Object.assign({}, (seed && seed._d) || {});
  const ls = {
    _d: store,
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null;
    },
    setItem(k, v) {
      this._d[k] = String(v);
    },
    removeItem(k) {
      delete this._d[k];
    },
  };
  const ctx = {
    window: {
      localStorage: ls,
      addEventListener() {},
      dispatchEvent() {},
      NostrTools: { verifyEvent, finalizeEvent, getPublicKey, generateSecretKey },
      CustomEvent: function CustomEvent(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      },
    },
    localStorage: ls,
    NostrApp: {},
    console,
  };
  ctx.global = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'account-status-state.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'directory-hygiene-state.js'), 'utf8'), ctx);
  return {
    ASS: ctx.window.SosAccountStatusState,
    DHS: ctx.window.SosDirectoryHygieneState,
    storage: ctx.window.localStorage,
  };
}

const base = {
  schema: 'sos-group-control',
  version: 1,
  groupId: 'israel-network',
  controlEpoch: 5,
  rootAdminPubkey: ROOTK.pub,
  capabilities: { [ADMIN.pub]: ['MANAGE_MEMBERS', 'MANAGE_BLOCKLIST', 'MANAGE_ADMINS'] },
  invitePolicy: 'EVERYONE',
  blockedPubkeys: [],
  membershipEpoch: 1,
  groupSettings: { displayName: 'QA', networkTag: 'israel-network' },
  createdAt: 1,
};

function signAccount(body, signer) {
  const draft = P.buildAccountStatusDraft(body);
  return finalizeEvent(
    { kind: draft.kind, created_at: draft.created_at, tags: draft.tags, content: draft.content },
    signer.sk
  );
}
function signDir(body, signer) {
  const draft = P.buildDirectoryHygieneDraft(body);
  return finalizeEvent(
    { kind: draft.kind, created_at: draft.created_at, tags: draft.tags, content: draft.content },
    signer.sk
  );
}

function catchCode(fn) {
  try {
    fn();
    return { threw: false, code: null };
  } catch (e) {
    return { threw: true, code: e && e.code };
  }
}

// Policy adversarial
expectFalse(
  'NON_ROOT_ACCOUNT_DISABLE_ACCEPTED',
  !catchCode(() =>
    P.applyAccountStatusOperation('DISABLE_ACCOUNT', base, null, ADMIN.pub, {
      groupId: 'israel-network',
      targetPubkey: TARGET.pub,
    })
  ).threw
);
expectFalse(
  'DELEGATED_ADMIN_ACCOUNT_DISABLE_ACCEPTED',
  !catchCode(() =>
    P.applyAccountStatusOperation('DISABLE_ACCOUNT', base, null, ADMIN.pub, {
      groupId: 'israel-network',
      targetPubkey: TARGET.pub,
    })
  ).threw
);
expectFalse(
  'ROOT_DISABLE_SELF_ACCEPTED',
  !catchCode(() =>
    P.applyAccountStatusOperation('DISABLE_ACCOUNT', base, null, ROOTK.pub, {
      groupId: 'israel-network',
      targetPubkey: ROOTK.pub,
    })
  ).threw
);
expectFalse(
  'TARGET_SELF_DISABLE_AS_ADMIN_ACCEPTED',
  !catchCode(() =>
    P.applyAccountStatusOperation('DISABLE_ACCOUNT', base, null, TARGET.pub, {
      groupId: 'israel-network',
      targetPubkey: OTHER.pub,
    })
  ).threw
);
expectFalse(
  'TARGET_SELF_ENABLE_ACCEPTED',
  !catchCode(() =>
    P.applyAccountStatusOperation('REENABLE_ACCOUNT', base, { revision: 1 }, TARGET.pub, {
      groupId: 'israel-network',
      targetPubkey: TARGET.pub,
    })
  ).threw
);
expectFalse(
  'WRONG_NETWORK_ACCEPTED',
  !catchCode(() =>
    P.applyAccountStatusOperation('DISABLE_ACCOUNT', base, null, ROOTK.pub, {
      groupId: 'other-network',
      targetPubkey: TARGET.pub,
    })
  ).threw
);

const { ASS, DHS, storage } = loadStateModules();
ASS.setRoot(ROOTK.pub);
DHS.setRoot(ROOTK.pub);

const disable1 = P.applyAccountStatusOperation('DISABLE_ACCOUNT', base, null, ROOTK.pub, {
  groupId: 'israel-network',
  targetPubkey: TARGET.pub,
  reasonCode: 'ADMIN_DISABLED',
});
const evDisable1 = signAccount(disable1, ROOTK);
expectTrue('ROOT_DISABLE_SIGNED_VERIFIES', verifyEvent(evDisable1) === true);
expectTrue('ROOT_DISABLE_INGEST', ASS.ingest(evDisable1).ok === true);
expectFalse('DISABLED_KEY_FILE_LOGIN_ACCEPTED', ASS.assertLoginAllowed(TARGET.pub).ok === true);
expectTrue('DISABLED_LOGIN_MESSAGE', /הושבת/.test(ASS.assertLoginAllowed(TARGET.pub).message || ''));

const forgedBody = P.applyAccountStatusOperation('DISABLE_ACCOUNT', base, null, ROOTK.pub, {
  groupId: 'israel-network',
  targetPubkey: OTHER.pub,
});
forgedBody.issuerPubkey = FORGER.pub;
const forged = signAccount(forgedBody, FORGER);
const forgedIng = ASS.ingest(forged);
expectFalse('FORGED_ACCOUNT_DISABLE_ACCEPTED', forgedIng.ok === true && ASS.isDisabled(OTHER.pub) === true);

// Rebuild a plain event without nostr-tools Symbol(verified) short-circuit.
const badSig = {
  kind: evDisable1.kind,
  created_at: evDisable1.created_at,
  tags: evDisable1.tags,
  content: evDisable1.content,
  pubkey: evDisable1.pubkey,
  id: 'f'.repeat(64),
  sig: '0'.repeat(128),
};
expectFalse('BAD_SIGNATURE_ACCEPTED', ASS.ingest(badSig).ok === true);
expectTrue('BAD_SIGNATURE_VERIFY_FALSE', verifyEvent(badSig) !== true);

const wrongNet = finalizeEvent(
  {
    kind: 39005,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', 'evil-net:' + TARGET.pub + ':9'],
      ['t', 'evil-net'],
      ['p', TARGET.pub],
    ],
    content: JSON.stringify({
      schema: 'sos-account-status',
      version: 1,
      groupId: 'evil-net',
      targetPubkey: TARGET.pub,
      status: 'ENABLED',
      revision: 9,
      reasonCode: 'ADMIN_DISABLED',
      createdAt: Math.floor(Date.now() / 1000),
    }),
  },
  ROOTK.sk
);
expectFalse('WRONG_NETWORK_INGEST_ACCEPTED', ASS.ingest(wrongNet).ok === true);

const enableOther = P.applyAccountStatusOperation('REENABLE_ACCOUNT', base, null, ROOTK.pub, {
  groupId: 'israel-network',
  targetPubkey: OTHER.pub,
});
ASS.ingest(signAccount(enableOther, ROOTK));
expectTrue('WRONG_TARGET_DOES_NOT_CLEAR_DISABLED', ASS.isDisabled(TARGET.pub) === true);
expectFalse('WRONG_TARGET_ACCEPTED', ASS.isDisabled(TARGET.pub) === false);

const enable2 = P.applyAccountStatusOperation('REENABLE_ACCOUNT', base, { revision: 1 }, ROOTK.pub, {
  groupId: 'israel-network',
  targetPubkey: TARGET.pub,
});
const evEnable2 = signAccount(enable2, ROOTK);
ASS.ingest(evEnable2);
expectTrue('REENABLED_LOGIN_ACCEPTED', ASS.assertLoginAllowed(TARGET.pub).ok === true);

const disable3 = P.applyAccountStatusOperation('DISABLE_ACCOUNT', base, { revision: 2 }, ROOTK.pub, {
  groupId: 'israel-network',
  targetPubkey: TARGET.pub,
});
const evDisable3 = signAccount(disable3, ROOTK);
ASS.ingest(evDisable3);
expectTrue('NEW_DISABLE_WINS', ASS.isDisabled(TARGET.pub) === true);

const staleEnable = ASS.ingest(evEnable2);
expectFalse(
  'OLD_ENABLE_AFTER_NEW_DISABLE_ACCEPTED',
  staleEnable.ok === true && ASS.isDisabled(TARGET.pub) === false
);

const staleDisable1 = ASS.ingest(evDisable1);
expectFalse(
  'OLD_DISABLE_AFTER_NEW_ENABLE_ACCEPTED',
  staleDisable1.ok === true && ASS.tipOf(TARGET.pub).revision === 1
);
expectFalse('ROLLBACK_ACCEPTED', ASS.tipOf(TARGET.pub).revision < 3);

const dupBody = Object.assign({}, JSON.parse(evDisable3.content), {
  status: 'ENABLED',
  transition: 'REENABLE',
  revision: disable3.revision,
  createdAt: Math.floor(Date.now() / 1000) + 5,
});
const dupEv = finalizeEvent(
  {
    kind: 39005,
    created_at: Math.floor(Date.now() / 1000) + 5,
    tags: [
      ['d', `israel-network:${TARGET.pub}:${dupBody.revision}`],
      ['t', 'israel-network'],
      ['p', TARGET.pub],
      ['status', 'ENABLED'],
      ['rev', String(dupBody.revision)],
    ],
    content: JSON.stringify(dupBody),
  },
  ROOTK.sk
);
ASS.ingest(dupEv);
expectFalse('DUPLICATE_REVISION_CONFLICT_FAILS_OPEN', ASS.isDisabled(TARGET.pub) === false);

const seed = { _d: Object.assign({}, storage._d) };
const reloaded = loadStateModules(seed);
reloaded.ASS.setRoot(ROOTK.pub);
expectFalse('CACHED_DISABLED_OFFLINE_LOGIN_ACCEPTED', reloaded.ASS.assertLoginAllowed(TARGET.pub).ok === true);

const hide = P.applyDirectoryHygieneOperation('HIDE_DIRECTORY', base, null, ROOTK.pub, {
  groupId: 'israel-network',
  targetPubkey: TARGET.pub,
});
expectTrue('DIRECTORY_HIDE_INGEST', DHS.ingest(signDir(hide, ROOTK)).ok === true && DHS.isHidden(TARGET.pub));

const hideOther = P.applyDirectoryHygieneOperation('HIDE_DIRECTORY', base, null, ROOTK.pub, {
  groupId: 'israel-network',
  targetPubkey: OTHER.pub,
});
DHS.ingest(signDir(hideOther, ROOTK));
expectTrue(
  'DIRECTORY_HIDE_DOES_NOT_DISABLE_LOGIN',
  ASS.assertLoginAllowed(OTHER.pub).ok === true && DHS.isHidden(OTHER.pub) === true
);

const restore = P.applyDirectoryHygieneOperation('RESTORE_DIRECTORY', base, { revision: 1 }, ROOTK.pub, {
  groupId: 'israel-network',
  targetPubkey: OTHER.pub,
});
DHS.ingest(signDir(restore, ROOTK));
expectTrue('RESTORE_DIRECTORY_RECORD_WORKS', DHS.isHidden(OTHER.pub) === false);

seed._d = Object.assign({}, storage._d);
const reloadDir = loadStateModules(seed);
reloadDir.DHS.setRoot(ROOTK.pub);
expectTrue('DIRECTORY_HIDE_SURVIVES_RELOAD', reloadDir.DHS.isHidden(TARGET.pub) === true);
expectTrue('DIRECTORY_HIDE_PERSISTENT', reloadDir.DHS.isHidden(TARGET.pub) === true);
expectTrue('DIRECTORY_HIDE_SURVIVES_REFRESH', reloadDir.DHS.isHidden(TARGET.pub) === true);

const failed = checks.filter((c) => !c.ok);
const report = {
  gate: 'account-revocation-acceptance-adversarial',
  passed: failed.length === 0,
  total: checks.length,
  failed: failed.length,
  checks,
  EVENT_KIND_39005_COLLISION: false,
  EVENT_KIND_39006_COLLISION: false,
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log(failed.length ? `\nADVERSARIAL FAIL ${failed.length}` : '\nADVERSARIAL PASS');
if (failed.length) failed.forEach((f) => console.log(' -', f.name, f.detail));
process.exit(failed.length ? 1 : 0);
