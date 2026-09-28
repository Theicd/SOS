/**
 * Package 898 — isolated staging run of the admission service.
 * 1. Generates disposable QA root + service keys (gitignored admission-service/.staging-keys.json).
 * 2. Deploys `sos-first-group-admission-staging` (workers.dev only, no routes / custom domain).
 * 3. Sets ADMISSION_SK via stdin (never printed, never in argv).
 * 4. Runs qa/package898-admission-service-gate.mjs against the real edge (independent Worker executions).
 * 5. Deletes the staging Worker and its Durable Objects, then the key file (unless --keep).
 * Never touches production; never uses the production root.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateSecretKey, getPublicKey } from 'nostr-tools';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVC = path.join(ROOT, 'admission-service');
const KEYS = path.join(SVC, '.staging-keys.json');
const KEEP = process.argv.includes('--keep');
const hex = (u8) => Buffer.from(u8).toString('hex');

function run(cmd, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: o.cwd || SVC, shell: true, env: Object.assign({}, process.env, { NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' }, o.env || {}) });
    let outText = '';
    p.stdout.on('data', (d) => {
      outText += d.toString();
      if (o.echo) process.stdout.write(d);
    });
    p.stderr.on('data', (d) => {
      outText += d.toString();
      if (o.echo) process.stderr.write(d);
    });
    if (o.stdin != null) {
      p.stdin.write(o.stdin);
      p.stdin.end();
    }
    p.on('close', (code) => resolve({ code, out: outText }));
  });
}
const redact = (s, secrets) => secrets.reduce((acc, x) => acc.split(x).join('<redacted>'), s);

async function main() {
  const rootSk = hex(generateSecretKey());
  const svcSk = hex(generateSecretKey());
  const svc2Sk = hex(generateSecretKey());
  const rootPub = getPublicKey(Buffer.from(rootSk, 'hex'));
  fs.writeFileSync(KEYS, JSON.stringify({ rootSk, svcSk, svc2Sk }));
  const secrets = [rootSk, svcSk, svc2Sk];
  const evidence = { worker: 'sos-first-group-admission-staging', routes: 'none', customDomain: 'none', steps: [] };
  let url = '';
  try {
    const dep = await run('npx', ['wrangler', 'deploy', '--env', 'staging', '--var', `ROOT_PUBKEY:${rootPub}`]);
    const m = dep.out.match(/https:\/\/sos-first-group-admission-staging\.[a-z0-9-]+\.workers\.dev/);
    evidence.steps.push({ step: 'deploy', code: dep.code, url: m ? m[0].replace(/\.[a-z0-9-]+\.workers\.dev$/, '.<account>.workers.dev') : null });
    if (dep.code !== 0 || !m) {
      console.error(redact(dep.out, secrets).slice(-3000));
      throw new Error('staging deploy failed');
    }
    url = m[0];
    const sec = await run('npx', ['wrangler', 'secret', 'put', 'ADMISSION_SK', '--env', 'staging'], { stdin: svcSk + '\n' });
    evidence.steps.push({ step: 'secret put ADMISSION_SK', code: sec.code });
    if (sec.code !== 0) {
      console.error(redact(sec.out, secrets).slice(-2000));
      throw new Error('secret put failed');
    }
    // Secret update creates a new version; wait for edge propagation.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const h = await fetch(url + '/v1/health').then((r) => r.json());
        if (h.result === 'OK') break;
      } catch (_e) {}
    }
    await new Promise((r) => setTimeout(r, 10000));
    const gate = await run('node', ['qa/package898-admission-service-gate.mjs'], {
      cwd: ROOT,
      echo: true,
      env: { SOS_ADM_URL: url, SOS_ADM_KEYS: KEYS, SOS_ADM_REPORT: 'package898-admission-staging-report.json' },
    });
    evidence.steps.push({ step: 'gate', code: gate.code });
    evidence.gateStatus = gate.code === 0 ? 'PASS' : 'FAIL';
  } finally {
    if (!KEEP) {
      const del = await run('npx', ['wrangler', 'delete', '--env', 'staging', '--force']);
      evidence.steps.push({ step: 'delete staging worker', code: del.code });
      try {
        fs.rmSync(KEYS, { force: true });
      } catch (_e) {}
    }
    const reportPath = path.join(__dirname, 'package898-admission-staging-report.json');
    let rep = {};
    try {
      rep = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (_e) {}
    rep.stagingEvidence = evidence;
    rep.PRODUCTION_ADMISSION_SERVICE_DEPLOYED = false;
    rep.PRODUCTION_DNS_CHANGED = false;
    fs.writeFileSync(reportPath, JSON.stringify(rep, null, 2));
    console.log('\nSTAGING_EVIDENCE ' + JSON.stringify(evidence));
  }
}

main().catch((e) => {
  console.error('STAGING ERROR', e.message);
  process.exit(1);
});
