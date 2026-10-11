#!/usr/bin/env node
/** Production-scoped UX3 Linked Devices release gate (899s.10). */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomUUID } from 'crypto';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = randomUUID();

function sha16(rel) {
  return createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, rel)))
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
}

const ux3 = spawnSync(process.execPath, [path.join(ROOT, 'qa/ux3-linked-devices-product-gate.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
const routing = spawnSync(process.execPath, [path.join(ROOT, 'qa/md3w-w2-linked-devices-ui-routing-gate.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});

const av = JSON.parse(fs.readFileSync(path.join(ROOT, 'app-version.json'), 'utf8'));
const ok = ux3.status === 0 && routing.status === 0 && av.version === '2026.10.11-web-899s.10';
const report = {
  status: ok ? 'PASS' : 'FAIL',
  runId,
  version: av.version,
  ux3Exit: ux3.status,
  routingExit: routing.status,
  moduleSha16: {
    linkedDevices: sha16('sos-web-linked-devices.js'),
    logger: sha16('chat-request-logger.js'),
    guestAuth: sha16('guest-auth.js'),
    md2Qr: sha16('sos-md2-pairing-qr.js'),
    scanner: sha16('sos-web-linked-qr-scanner.js'),
    session: sha16('sos-md2-pairing-session.js'),
  },
  stdout: {
    ux3: (ux3.stdout || '').split('\n').slice(-8),
    routing: (routing.stdout || '').split('\n').slice(-8),
  },
};
fs.writeFileSync(path.join(ROOT, 'qa/prod-899s10-linked-ui-report.json'), JSON.stringify(report, null, 2));
process.stdout.write(ux3.stdout || '');
process.stdout.write(routing.stdout || '');
console.log(`STATUS=${report.status} runId=${runId}`);
process.exit(ok ? 0 : 1);
