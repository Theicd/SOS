#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = randomUUID();
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? '[ux4] PASS' : '[ux4] FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const ld = read('sos-web-linked-devices.js');
const ku = read('key-utils.js');
const av = JSON.parse(read('app-version.json'));
const videos = read('videos.html');
const sw = read('service-worker.js');

check('VERSION_899S11', av.version === '2026.10.11-web-899s.11', av.version);
check('SW_899S11', /sos-cache-v899s11/.test(sw));
check('VIDEOS_899S11', /sos-web-linked-devices\.js\?[^"']*pkg=899s11/.test(videos));
check('GUEST_CONTINUE_ONLY', /data-ld-continue-guest/.test(ld));
// Welcome template must not include refresh/login buttons (desktop panel may still have refresh).
const welcomeIdx = ld.indexOf('function showGuestQrWelcome');
const welcomeSlice = welcomeIdx >= 0 ? ld.slice(welcomeIdx, welcomeIdx + 2200) : '';
const welcomeHtmlMatch = welcomeSlice.match(/el\.innerHTML\s*=\s*([\s\S]*?);/);
const welcomeHtml = welcomeHtmlMatch ? welcomeHtmlMatch[1] : '';
check('WELCOME_HAS_CONTINUE', welcomeHtml.includes('המשך כאורח') && welcomeHtml.includes('data-ld-continue-guest'));
check('WELCOME_HTML_NO_REFRESH', !welcomeHtml.includes('data-ld-refresh') && !welcomeHtml.includes('קוד חדש'));
check('WELCOME_HTML_NO_LOGIN', !welcomeHtml.includes('data-ld-open-login') && !welcomeHtml.includes('התחברות / הרשמה'));
check('GUEST_AUTO_REFRESH', /_guestAutoRefreshBusy/.test(ld) && /startPairingIntoUi\(welcome\)/.test(ld));
check('T2_TRUTHFUL_MSG', /Trusted Signer \/ T2/.test(ld) && !/לאישור מאובטח השתמשו באפליקציית SOS בטלפון \(Android\)\./.test(ld));
check('NO_W1B_ON_PROD_HTML', !/sos-web-phone-issuer\.js/.test(videos) && !/sos-authorize-linked-device\.js/.test(videos));
check('NSEC_UINT8_FALLBACK', /bytesToHex is unavailable/.test(ku) || /Fallback when NostrTools\.utils\.bytesToHex/.test(ku));
check('WEB_MD3_OFF', /WEB_MD3_ISSUANCE:\s*false/.test(ld));

const failed = checks.filter((c) => !c.ok);
const report = { status: failed.length ? 'FAIL' : 'PASS', runId, version: av.version, checks, failed: failed.map((f) => f.name) };
fs.writeFileSync(path.join(ROOT, 'qa/ux4-guest-welcome-report.json'), JSON.stringify(report, null, 2));
console.log(`STATUS=${report.status} runId=${runId}`);
process.exit(failed.length ? 1 : 0);
