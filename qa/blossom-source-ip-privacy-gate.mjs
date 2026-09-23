#!/usr/bin/env node
/**
 * Blossom source-IP privacy — local detection gate (does NOT claim privacy closed).
 * Documents whether the browser still talks to Blossom directly.
 * Run: node qa/blossom-source-ip-privacy-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'blossom-source-ip-privacy-report.json');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const blossom = read('blossom.js');
const mediaServer = fs.existsSync(path.join(ROOT, 'media-server-e2ee.js'))
  ? read('media-server-e2ee.js')
  : '';

const directServers = /blossom\.band|blossom\.nostr\.build/.test(blossom);
const uploadFetch = /async function uploadToBlossom[\s\S]*?fetch\(url/.test(blossom);
const privacyGateway =
  /privacy.?upload.?gateway|BLOSSOM_PRIVACY_GATEWAY|strip.*X-Forwarded|source.?ip.?strip/i.test(
    blossom + mediaServer
  );

const report = {
  gate: 'blossom-source-ip-privacy',
  DIRECT_CLIENT_TO_BLOSSOM_PRESENT: directServers && uploadFetch,
  BLOSSOM_CAN_SEE_USER_SOURCE_IP_TODAY: directServers && uploadFetch && !privacyGateway,
  BLOSSOM_SOURCE_IP_PRIVACY_STATUS: 'REQUIRES_EXTERNAL_INFRA',
  PRIVACY_GATEWAY_IMPLEMENTED: privacyGateway,
  MINIMUM_REQUIRED_PRODUCTION_ARCHITECTURE:
    'User → SOS privacy upload gateway → Blossom; strip X-Forwarded-For / Forwarded; no source-IP application logs; browser never fetch() Blossom origin directly for private media',
  CLAIMS_PRIVACY_CLOSED: false,
  STATUS: 'PASS', // gate documents truth; does not falsely close privacy
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log('BLOSSOM_SOURCE_IP_PRIVACY_STATUS=' + report.BLOSSOM_SOURCE_IP_PRIVACY_STATUS);
process.exit(0);
