#!/usr/bin/env node
/**
 * הרצת שלבי QA ברצף — שלב דפדפן רק אם QA_KEY_A / QA_KEY_B מוגדרים.
 * שימוש: npm run qa:phases
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function runPhase(name, cmd, args, opts = {}) {
  console.log(`\n═══ Phase: ${name} ═══\n`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...opts.env },
  });
  const code = r.status ?? 1;
  if (code !== 0) {
    console.error(`\nPhase "${name}" failed with exit ${code}`);
    process.exit(code);
  }
}

runPhase('security-static', process.execPath, ['qa/security-audit.mjs']);

const keyA = process.env.QA_KEY_A || '';
const keyB = process.env.QA_KEY_B || '';

if (keyA.length === 64 && keyB.length === 64) {
  const localUrl = process.env.QA_LOCAL_URL || 'http://127.0.0.1:3012/videos.html';
  const largeMb = process.env.QA_LARGE_MB || '1';
  runPhase('dual-user-local', process.execPath, [
    'qa/dual-user-qa.mjs',
    `--keyA=${keyA}`,
    `--keyB=${keyB}`,
    '--skipRemote=true',
    `--localUrl=${localUrl}`,
    `--largeMb=${largeMb}`,
    '--headless=true',
  ]);
} else {
  console.log('\n[Skip] Browser P2P phase: set QA_KEY_A and QA_KEY_B (64-char hex) to run dual-user-qa.\n');
}

console.log('\n✅ All requested phases completed.\n');
process.exit(0);
