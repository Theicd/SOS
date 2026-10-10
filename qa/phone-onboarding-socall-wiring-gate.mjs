#!/usr/bin/env node
/**
 * PHONE ONBOARDING + SO-CALL WIRING — static / unit gate (local).
 * Complements full browser E2E. Does not deploy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa/phone-onboarding-socall-wiring-report.json');
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
    console.log('FAIL', name, detail ? JSON.stringify(detail).slice(0, 220) : '');
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const av = JSON.parse(read('app-version.json'));
const guest = read('guest-auth.js');
const invite = read('invite-service.js');
const videos = read('videos.html');
const gif = read('global-identity-foundation.js');
const gac = read('global-admission-client.js');
const chat = read('chat-ui.js');
const phoneSrv = read('admission-service/src/phone.js');
const globalDo = read('admission-service/src/global-accounts.js');
const prodToml = read('admission-service/wrangler.toml');

check('APP_VERSION_899S13', av.version >= '2026.10.05-web-899s.13', { version: av.version });
check('PHONE_ONBOARDING_FIELD_PRESENT', /id="signupInvitePhoneInput"/.test(videos) && !/signupInvitePhoneInput[^>]*hidden/.test(videos));
check('PHONE_REQUIRED_FOR_NEW_ACCOUNT', /נא להזין מספר טלפון/.test(guest) && /PHONE_REQUIRED/.test(invite + globalDo));
check('NAME_ONBOARDING_STEP_ABSENT_PATH', /skip name\/avatar|Stage-5 onboarding: skip name|authStepName/.test(guest));
check('COMBINED_INVITE_PHONE_EMAIL', /authStepInvite/.test(videos) && /signupInvitePhoneInput/.test(videos) && /signupEmailInput/.test(videos) && /signupLegalAgree/.test(videos));
check('PHONE_NORM_SINGLE_SOURCE', /PhoneNormalize|SosPhoneNormalize/.test(guest) && !/HMAC-SHA256\(PHONE_PEPPER/.test(guest));
check('SERVER_RENORMALIZES', /normalizePhoneE164/.test(phoneSrv) && /computePhoneToken/.test(phoneSrv));
check('PHONE_TOKEN_NOT_IN_INVITE_URL', /buildInviteUrl/.test(invite) && !/phoneToken/.test(invite.match(/function buildInviteUrl[\s\S]{0,400}/)?.[0] || ''));
check('WRONG_PHONE_MESSAGE', /מספר הטלפון אינו תואם להזמנה/.test(guest + invite + globalDo));
check('PRODUCTION_PHONE_PEPPER_REQUIRED', /SOS_ENV/.test(phoneSrv) && /PHONE_PEPPER_MISSING|production/.test(phoneSrv) && /SOS_ENV = "production"/.test(prodToml));
check('CLIENT_PHONE_PEPPER_ABSENT', !/PHONE_PEPPER\s*=/.test(guest + gac + videos) && /PHONE_TOKEN_SECRET_IN_BROWSER:\s*false/.test(gac));
check('CONTACT_PICKER_AND_MANUAL', /btnInvitePickContact/.test(videos + guest) && /btnInviteManualPhone/.test(videos + guest) && /navigator\.contacts\.select/.test(guest));
check('FULL_ADDRESS_BOOK_UPLOAD_FALSE', /multiple:\s*false/.test(guest) && /FULL_ADDRESS_BOOK_UPLOAD=false/.test(guest));
check('LOOKUP_BEFORE_INVITE', /LOOKUP_BEFORE_INVITE|lookupPhone/.test(invite) && /PHONE_ALREADY_REGISTERED/.test(invite));
check('DISABLED_PRIVACY', /PHONE_UNAVAILABLE|unavailable:\s*true/.test(globalDo + invite) && /ACCOUNT_DISABLED_REASON_LEAKED_TO_SEARCHER:\s*false/.test(globalDo));
check('WHATSAPP_SPECIFIC', /wa\.me\/\$\{recipientDigits\}/.test(invite));
check('PHONE_PROOF_LEVEL', /WHATSAPP_DELIVERY_BOUND_INVITE/.test(gif + invite));
check('ANONYMOUS_LOOKUP_FALSE', /ANONYMOUS_GENERAL_PHONE_LOOKUP:\s*false/.test(gac + globalDo));
check('AUTH_SOCALL_LOOKUP', /AUTHENTICATED_SOCALL_PHONE_LOOKUP:\s*true/.test(gac) && /signPhoneLookupAuth|SIGN_PHONE_LOOKUP/.test(gac + read('sos-crypto-signer.js')));
check('SOCALL_PHONE_SEARCH', /runSocallPhoneSearch|looksLikePhoneQuery/.test(chat) && /SOCALL_PHONE_SEARCH_REQUIRES_SHARED_COMMUNITY:\s*false/.test(chat));
check('NO_PREFIX_SEARCH', /PHONE_PREFIX_SEARCH:\s*false/.test(globalDo) && /digits\.length < 9/.test(chat));
check('NIP65_AUTO_ENSURE', /ensureGlobalReachability/.test(gif) && /NIP65_AUTO_ENSURE_IMPLEMENTED:\s*true/.test(gif));
check('NIP65_NO_COMMUNITY_SWITCH', /NIP65_COMMUNITY_SWITCH_REPUBLISH:\s*false/.test(gif) && /community-switch/.test(gif));
check('SELF_ASSERTED_37377_NOT_SOCALL', /SELF_ASSERTED_37377/.test(globalDo + gif));
check('INVITE_FRIEND_MODAL', /inviteFriendModal/.test(videos) && /כבר נמצא ב-SOS/.test(guest));
check('NO_AUTO_SUBMIT_WITHOUT_PHONE', /Do not auto-submit|must be entered/.test(guest));

const PN = require(path.join(ROOT, 'phone-normalize.js'));
const vectors = [
  ['050-123-4567', '+972501234567'],
  ['050 123 4567', '+972501234567'],
  ['+972501234567', '+972501234567'],
];
let vecOk = true;
for (const [inP, out] of vectors) {
  const r = PN.normalizePhoneE164(inP);
  if (!r.ok || r.e164 !== out) vecOk = false;
}
check('PHONE_NORMALIZE_UX_VECTORS', vecOk);

const report = {
  gate: 'PHONE_ONBOARDING_SOCALL_WIRING',
  status: fail === 0 ? 'PASS' : 'FAIL',
  version: av.version,
  pass,
  fail,
  results,
  ts: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('\nPHONE_ONBOARDING_SOCALL_WIRING', report.status, `(${pass}/${pass + fail})`);
process.exit(fail ? 1 : 0);
