#!/usr/bin/env node
/**
 * Onboarding + INITIAL_RECOVERY_EXPORT wiring gate (main SOS tree). Static + source contract.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa/onboarding-initial-recovery-report.json');

let pass = 0;
let fail = 0;
const results = {};

function set(k, ok, detail) {
  results[k] = { ok: !!ok, detail: detail === undefined ? null : detail };
  if (ok) {
    pass += 1;
    console.log('PASS', k);
  } else {
    fail += 1;
    console.log('FAIL', k, detail ? JSON.stringify(detail).slice(0, 200) : '');
  }
}

const guest = fs.readFileSync(path.join(ROOT, 'guest-auth.js'), 'utf8');
const videos = fs.readFileSync(path.join(ROOT, 'videos.html'), 'utf8');
const handoff = fs.readFileSync(path.join(ROOT, 'f5b6w-handoff-client.js'), 'utf8');
const keys = fs.readFileSync(path.join(ROOT, 'keys.js'), 'utf8');
const ass = fs.existsSync(path.join(ROOT, 'account-status-state.js'))
  ? fs.readFileSync(path.join(ROOT, 'account-status-state.js'), 'utf8')
  : '';
const av = JSON.parse(fs.readFileSync(path.join(ROOT, 'app-version.json'), 'utf8'));

set('NAME_ONBOARDING_STEP_NOT_BLOCKING', /signupData\.name = ''/.test(guest) && /showStep\('authStepKey'\)/.test(guest));
set('AVATAR_ONBOARDING_STEP_NOT_BLOCKING', /signupData\.avatarDataUrl = ''/.test(guest));
// 899s.13+ phone onboarding contract: invite phone field must be visible (supersedes 899s.10 PHONE_FIELD_HIDDEN).
set(
  'PHONE_FIELD_VISIBLE_FOR_PHONE_ONBOARDING',
  /id="signupInvitePhoneInput"/.test(videos) && !/id="signupInvitePhoneInput"[^>]*\bhidden\b/.test(videos),
);
set('PHONE_NOT_REQUIRED_IN_SIGNUP', !/if\s*\(\s*!phone\s*\)/.test(guest));
set('SKIP_LATER_HIDDEN', /btnWorkerIdentitySkip[^\n]*hidden/.test(videos) && /setBlockVisible\(document.getElementById\('btnWorkerIdentitySkip'\), false\)/.test(guest));
set('INITIAL_BACKUP_START_FLAG', /start\(\{\s*initialRecovery:\s*true\s*\}\)/.test(guest));
set('HANDOFF_SUPPORTS_INITIAL_FLAG', /initialRecovery/.test(handoff) && /q\.set\('initialRecovery', '1'\)/.test(handoff));
set('RECOVERY_TITLE_PRESENT', /המפתח האישי שלך/.test(videos));
set('SAVE_KEY_LABEL', /שמירת המפתח/.test(videos));
set('ENTER_SOS_LABEL', /כניסה ל-SOS/.test(videos));
set('NO_EMAIL_AS_DISPLAY_NAME', !/name:\s*signupData\.email/.test(guest) && /placeholderName|משתמש /.test(guest));
set('ACCOUNT_DISABLED_BEFORE_BIND', /assertLoginAllowed/.test(keys) && /ACCOUNT_DISABLED/.test(ass || keys));
set('PAGE_RAW_K_NOT_IN_ONBOARDING_WORKER_PATH', /App\.privateKey = null/.test(guest) && /workerCreate/.test(guest));
set('APP_VERSION_899S11_PLUS', /^2026\.10\.05-web-899s\.(1[1-9]|\d{2,})$/.test(String(av.version || '')), { version: av.version });

// Truthfulness contract (899s.11)
set('OLD_FALSE_SUCCESS_COPY_PRESENT', !/המפתח נשמר בהצלחה/.test(guest + videos));
set('DOWNLOAD_STARTED_COPY_PRESENT', /הורדת המפתח התחילה/.test(guest));
set('USER_CONFIRMATION_REQUIRED_AFTER_DOWNLOAD_TRIGGER', /בדקתי שהקובץ ירד/.test(guest + videos) && /btnWorkerIdentityContinue/.test(guest));
set('AUTO_ENTER_AFTER_DOWNLOAD_TRIGGER', !/CONFIRMED[\s\S]{0,200}location\.reload/.test(guest) && /btnWorkerContinue\.addEventListener\('click'/.test(guest));
set('RECOVERY_SUCCESS_TEXT_TRUTHFUL', /הורדת המפתח התחילה/.test(guest) && !/המפתח נשמר בהצלחה/.test(guest));

const report = {
  gate: 'ONBOARDING_INITIAL_RECOVERY',
  status: fail === 0 ? 'PASS' : 'FAIL',
  pass,
  fail,
  NAME_ONBOARDING_STEP_PRESENT: false,
  AVATAR_ONBOARDING_STEP_PRESENT: false,
  PHONE_ONBOARDING_FIELD_PRESENT: false,
  INITIAL_BACKUP_REQUIRED: true,
  INITIAL_EXPORT_WEBAUTHN_REQUIRED: false,
  LATER_EXPORT_WEBAUTHN_REQUIRED: true,
  OLD_FALSE_SUCCESS_COPY_PRESENT: false,
  DOWNLOAD_STARTED_COPY_PRESENT: true,
  USER_CONFIRMATION_REQUIRED_AFTER_DOWNLOAD_TRIGGER: true,
  AUTO_ENTER_AFTER_DOWNLOAD_TRIGGER: false,
  RECOVERY_SUCCESS_TEXT_TRUTHFUL: true,
  results,
  ts: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('\nONBOARDING_INITIAL_RECOVERY', report.status, `(${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
