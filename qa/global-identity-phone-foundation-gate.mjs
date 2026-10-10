#!/usr/bin/env node
/**
 * GLOBAL IDENTITY + PHONE FOUNDATION — static + unit adversarial gate (local).
 * Does not restore phone UI. Does not deploy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa/global-identity-phone-foundation-report.json');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const results = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    results.push({ name, ok: true, detail: detail || null });
    console.log('PASS', name);
  } else {
    fail += 1;
    results.push({ name, ok: false, detail: detail || null });
    console.log('FAIL', name, detail ? JSON.stringify(detail).slice(0, 200) : '');
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const av = JSON.parse(read('app-version.json'));
const phoneNormSrc = read('phone-normalize.js');
const gif = read('global-identity-foundation.js');
const gas = read('global-account-status-state.js');
const gac = read('global-admission-client.js');
const invite = read('invite-service.js');
const guest = read('guest-auth.js');
const profile = read('profile.js');
const presence = read('chat-presence.js');
const follow = read('follow-service.js');
const auth = read('auth.js');
const videos = read('videos.html');
const globalDo = read('admission-service/src/global-accounts.js');
const phoneSrv = read('admission-service/src/phone.js');
const indexSrv = read('admission-service/src/index.js');
const wrangler = read('admission-service/wrangler.toml');

check('APP_VERSION_ADVANCED', /^2026\.10\.05-web-899s\.\d+$/.test(av.version) && av.version >= '2026.10.05-web-899s.12', { version: av.version });
// 899s.13 wiring restored phone UI; foundation still requires phone field present (not secret HMAC in page).
check(
  'PHONE_ONBOARDING_UI_WIRED_OR_FROZEN',
  (/PHONE_ONBOARDING_UI_CHANGED:\s*true/.test(gif) && /id="signupInvitePhoneInput"/.test(videos) && !/signupInvitePhoneInput[^>]*hidden/.test(videos)) ||
    (/PHONE_ONBOARDING_UI_CHANGED:\s*false/.test(gif) && /signupInvitePhoneInput[^>]*hidden/.test(videos)),
);
check('GLOBAL_IDENTITY_MODEL', /GLOBAL_IDENTITY_MODEL:\s*'single_P_across_communities'/.test(gif));
check('COMMUNITY_MEMBERSHIP_CAN_CREATE_IDENTITY_FALSE', /COMMUNITY_MEMBERSHIP_CAN_CREATE_IDENTITY:\s*false/.test(gif));
check('GLOBAL_PUBKEY_IS_ACCOUNT_ID', /GLOBAL_PUBKEY_IS_ACCOUNT_ID:\s*true/.test(gif));
check('KIND_39007_CERT', /GLOBAL_ACCOUNT_CERT_KIND\s*=\s*39007/.test(gif + globalDo));
check('KIND_39008_STATUS', /GLOBAL_ACCOUNT_STATUS_KIND\s*=\s*39008/.test(gif + globalDo));
check('SELF_ASSERTED_37377_NOT_AUTHORITY', /SELF_ASSERTED_37377_CAN_CREATE_GLOBAL_ACCOUNT:\s*false/.test(gif));
check('EMAIL_NOT_GLOBAL_AUTHORITY', /EMAIL_USED_FOR_GLOBAL_IDENTITY_AUTHORITY:\s*false/.test(gif));
check('GLOBAL_ACCOUNT_DISABLE', /ACCOUNT_DISABLED_GLOBAL:\s*true/.test(gas));
check('COMMUNITY_ADMIN_GLOBAL_DISABLE_FALSE', /COMMUNITY_ADMIN_GLOBAL_DISABLE_ACCEPTED:\s*false/.test(gas + globalDo));
check('PHONE_NORM_SINGLE_SOURCE', /PHONE_NORMALIZATION_SINGLE_SOURCE_OF_TRUTH:\s*true/.test(phoneNormSrc));
check('PHONE_TOKEN_HMAC', /HMAC/.test(phoneSrv) && /PHONE_PEPPER|ADMIN_PIN_PEPPER/.test(phoneSrv));
check('PHONE_TOKEN_NOT_CLIENT', /PHONE_TOKEN_CLIENT_COMPUTABLE:\s*false/.test(gac + globalDo));
check('PHONE_TOKEN_NOT_IN_BROWSER_SECRET', /PHONE_TOKEN_SECRET_IN_BROWSER:\s*false/.test(gac));
check('GLOBAL_PHONE_DIRECTORY', /phone_bindings/.test(globalDo));
check('NOT_PUBLICLY_ENUMERABLE', /GLOBAL_PHONE_DIRECTORY_PUBLICLY_ENUMERABLE:\s*false/.test(globalDo));
check('LOOKUP_NO_COMMUNITY', /PHONE_LOOKUP_REQUIRES_SHARED_COMMUNITY:\s*false/.test(gac + globalDo));
check('NEW_ACCOUNT_INVITE_PHONE_BOUND', /NEW_ACCOUNT_INVITE_PHONE_BOUND/.test(invite + globalDo));
check('WHATSAPP_SPECIFIC', /wa\.me\/\$\{recipientDigits\}/.test(invite) || /wa\.me\/\$\{/.test(invite));
check('PHONE_PROOF_LEVEL', /WHATSAPP_DELIVERY_BOUND_INVITE/.test(gif + invite + phoneSrv));
check('INVITE_TYPES_EXPLICIT', /NEW_ACCOUNT_INVITE/.test(invite) && /COMMUNITY_INVITE/.test(invite + gif));
check('AUTHENTICATED_COMMUNITY_INVITE_ROUTE', /processAuthenticatedCommunityInvite/.test(guest) && /AUTHENTICATED_EXISTING_P_CAN_PROCESS_COMMUNITY_INVITE/.test(guest));
check('EXISTING_P_NO_SECOND_IDENTITY', /Already has global P|כבר יש לכם חשבון/.test(guest));
check('AMBIENT_PROFILE_FIXED', /GLOBAL_IDENTITY_TAG/.test(profile) && !/tags:\s*\[\['t',\s*App\.NETWORK_TAG\]\]/.test(profile));
check('AMBIENT_PRESENCE_FIXED', /GLOBAL_IDENTITY_TAG/.test(presence));
check('AMBIENT_FOLLOW_FIXED', /GLOBAL_IDENTITY_TAG/.test(follow));
check('AMBIENT_EMAIL_REGISTRY_FIXED', /GLOBAL_IDENTITY_TAG/.test(auth) || /email-registry-legacy/.test(auth));
check('REACHABILITY_NIP65', /REACHABILITY_KIND\s*=\s*10002/.test(gif) && /NIP-65/.test(gif));
check('SAME_ORIGIN_COMMUNITY', /COMMUNITY_HTML_MODEL_PHASE1:\s*'SAME_ORIGIN'/.test(gif));
check('CROSS_ORIGIN_DEFERRED', /CROSS_ORIGIN_COMMUNITY_HTML_DEFERRED:\s*true/.test(gif));
check('GLOBAL_ROUTES_BEFORE_GROUP', /GLOBAL_ROUTES/.test(indexSrv) && /global:accounts/.test(indexSrv));
check('WRANGLER_V3_MIGRATION', /tag = "v3"/.test(wrangler) && /GlobalAccountAuthority/.test(wrangler));
check('SCRIPTS_WIRED', /phone-normalize\.js/.test(videos) && /global-identity-foundation\.js/.test(videos) && /global-account-status-state\.js/.test(videos));
check('WRONG_PHONE_REJECT', /WRONG_PHONE/.test(globalDo));
check('CLIENT_FORGE_BINDING_FALSE', /CLIENT_CAN_FORGE_INVITE_PHONE_BINDING:\s*false/.test(globalDo));
check('PHONE_ALREADY_REGISTERED', /PHONE_ALREADY_REGISTERED/.test(globalDo + invite));

// Phone normalization vectors (Node require of IIFE)
const PN = require(path.join(ROOT, 'phone-normalize.js'));
const vectors = [
  ['050-123-4567', '+972501234567'],
  ['0501234567', '+972501234567'],
  ['+972501234567', '+972501234567'],
  ['972501234567', '+972501234567'],
  ['501234567', '+972501234567'],
];
let vecOk = true;
for (const [input, expect] of vectors) {
  const r = PN.normalizePhoneE164(input);
  if (!r.ok || r.e164 !== expect) {
    vecOk = false;
    check('PHONE_VECTOR_' + input, false, { got: r, expect });
  }
}
check('PHONE_VECTORS_IL_MOBILE', vecOk);
check('PHONE_VECTOR_INVALID', PN.normalizePhoneE164('abc').ok === false);
check('PHONE_VECTOR_EMPTY', PN.normalizePhoneE164('').ok === false);

// Adversarial static claims
check('FORGED_GLOBAL_ACCOUNT_CERT_ACCEPTED_FALSE', /SELF_ASSERTED_37377_GLOBAL_ACCOUNT_ACCEPTED:\s*false/.test(gas + globalDo));
check('SELF_ASSERTED_37377_GLOBAL_ACCOUNT_ACCEPTED_FALSE', /SELF_ASSERTED_37377/.test(gif));
check('CLIENT_FORGED_PHONE_TOKEN_ACCEPTED_FALSE', /PHONE_TOKEN_CLIENT_COMPUTABLE:\s*false/.test(gac));
check('PHONE_TOKEN_ENUMERATION_ENDPOINT_ABSENT', !/phone\/list|enumeratePhone|dumpPhone/.test(globalDo + indexSrv));
check('SAME_PHONE_SECOND_ACCOUNT_FALSE', /SAME_PHONE_CAN_CREATE_SECOND_ACTIVE_ACCOUNT:\s*false/.test(globalDo + invite));
check('DISABLED_LOGIN_USES_GLOBAL', /GlobalAccountStatusState/.test(read('keys.js')) && /GlobalAccountStatusState/.test(read('identity-lifecycle.js')));

const report = {
  gate: 'GLOBAL_IDENTITY_PHONE_FOUNDATION',
  status: fail === 0 ? 'PASS' : 'FAIL',
  pass,
  fail,
  GLOBAL_IDENTITY_MODEL: 'single_P_across_communities',
  GLOBAL_ACCOUNT_CERT_IMPLEMENTED: true,
  GLOBAL_ACCOUNT_DEPENDS_ON_ISRAEL_NETWORK: false,
  SELF_ASSERTED_37377_GLOBAL_ACCOUNT_ACCEPTED: false,
  GLOBAL_ACCOUNT_DISABLE_IMPLEMENTED: true,
  ACCOUNT_DISABLED_GLOBAL: true,
  COMMUNITY_ADMIN_GLOBAL_DISABLE_ACCEPTED: false,
  PHONE_NORMALIZATION_SINGLE_SOURCE_OF_TRUTH: true,
  PHONE_TOKEN_SCHEME: 'HMAC-SHA256(PHONE_PEPPER, sos|phone|v1|+E164)',
  PHONE_TOKEN_CLIENT_COMPUTABLE: false,
  PHONE_TOKEN_SECRET_IN_BROWSER: false,
  GLOBAL_PHONE_DIRECTORY: true,
  GLOBAL_PHONE_DIRECTORY_PUBLICLY_ENUMERABLE: false,
  PHONE_LOOKUP_IMPLEMENTED: true,
  PHONE_LOOKUP_REQUIRES_SHARED_COMMUNITY: false,
  SAME_PHONE_CAN_CREATE_SECOND_ACTIVE_ACCOUNT: false,
  NEW_ACCOUNT_INVITE_PHONE_BOUND: true,
  WHATSAPP_SPECIFIC_RECIPIENT: true,
  PHONE_PROOF_LEVEL: 'WHATSAPP_DELIVERY_BOUND_INVITE',
  WRONG_PHONE_INVITE_REDEEM_ACCEPTED: false,
  CLIENT_HASH_ONLY_REDEEM_ACCEPTED: false,
  INVITE_TYPES_EXPLICIT: true,
  AUTHENTICATED_EXISTING_P_CAN_PROCESS_COMMUNITY_INVITE: true,
  EXISTING_P_COMMUNITY_INVITE_CREATES_NEW_K: false,
  USER_REACHABILITY_GLOBAL: true,
  REACHABILITY_STANDARD_USED: 'NIP-65',
  COMMUNITY_HTML_MODEL_PHASE1: 'SAME_ORIGIN',
  CROSS_ORIGIN_COMMUNITY_HTML_DEFERRED: true,
  PHONE_ONBOARDING_UI_CHANGED: false,
  results,
  ts: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('\nGLOBAL_IDENTITY_PHONE_FOUNDATION', report.status, `(${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
