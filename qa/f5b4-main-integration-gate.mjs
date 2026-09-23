#!/usr/bin/env node
/**
 * Main-app F5B4 static integration gate (no deploy).
 * Ensures launcher exists, no raw-K paths, community-independent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'f5b4-main-integration-report.json');

const report = {
  STATUS: 'FAIL',
  MAIN_LAUNCHER_PRESENT: false,
  VIDEOS_INCLUDES_LAUNCHER: false,
  SW_PRECACHE_INCLUDES_LAUNCHER: false,
  LAUNCHER_READS_COMMUNITY_CONTEXT: false,
  LAUNCHER_HANDLES_RAW_K: false,
  LAUNCHER_EXPORT_IMPLEMENTED: false,
  LAUNCHER_F5B6_MIGRATION: false,
  LAUNCHER_DELETE_LEGACY: false,
  notes: [],
};

function note(s) {
  report.notes.push(String(s));
  console.log('[F5B4-MAIN]', s);
}

const launcher = path.join(ROOT, 'isolated-signer-trusted-import.js');
const videos = path.join(ROOT, 'videos.html');
const sw = path.join(ROOT, 'service-worker.js');

report.MAIN_LAUNCHER_PRESENT = fs.existsSync(launcher);
if (report.MAIN_LAUNCHER_PRESENT) {
  const t = fs.readFileSync(launcher, 'utf8');
  report.LAUNCHER_READS_COMMUNITY_CONTEXT = /CommunityContext|NETWORK_TAG|communityId/.test(t) &&
    !/Community-independent|COMMUNITY_INDEPENDENT|ignores CommunityContext/.test(t);
  // Soft: allow mentioning independence
  if (/COMMUNITY_INDEPENDENT:\s*true/.test(t) || /Community-independent/.test(t)) {
    report.LAUNCHER_READS_COMMUNITY_CONTEXT = /getActive\(|App\.NETWORK_TAG\s*=/.test(t);
  }
  report.LAUNCHER_HANDLES_RAW_K = /opts\.privateKey|opts\.nsec|App\.privateKey\s*=/.test(t);
  report.LAUNCHER_EXPORT_IMPLEMENTED = /F5B5_EXPORT:\s*true/.test(t);
  report.LAUNCHER_F5B6_MIGRATION = /F5B6_MIGRATION:\s*true/.test(t);
  report.LAUNCHER_DELETE_LEGACY = /DELETE_LEGACY_KEYS:\s*true/.test(t);
}
if (fs.existsSync(videos)) {
  report.VIDEOS_INCLUDES_LAUNCHER = /isolated-signer-trusted-import\.js/.test(
    fs.readFileSync(videos, 'utf8')
  );
}
if (fs.existsSync(sw)) {
  report.SW_PRECACHE_INCLUDES_LAUNCHER = /isolated-signer-trusted-import\.js/.test(
    fs.readFileSync(sw, 'utf8')
  );
}

const pass =
  report.MAIN_LAUNCHER_PRESENT &&
  report.VIDEOS_INCLUDES_LAUNCHER &&
  report.SW_PRECACHE_INCLUDES_LAUNCHER &&
  report.LAUNCHER_READS_COMMUNITY_CONTEXT === false &&
  report.LAUNCHER_HANDLES_RAW_K === false &&
  report.LAUNCHER_EXPORT_IMPLEMENTED === false &&
  report.LAUNCHER_F5B6_MIGRATION === false &&
  report.LAUNCHER_DELETE_LEGACY === false;

report.STATUS = pass ? 'PASS' : 'FAIL';
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(pass ? 0 : 1);
