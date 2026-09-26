#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = fs.readFileSync(path.join(ROOT, 'videos.html'), 'utf8');
const clean = execSync('git show 9c0828d:videos.html', {
  encoding: 'utf8',
  maxBuffer: 80e6,
  cwd: ROOT,
});

const curEmpty = (text.match(/id="notificationsEmpty"[^>]*>([^<]*)</) || [])[1] || '';
const cleanEmpty = (clean.match(/id="notificationsEmpty"[^>]*>([^<]*)</) || [])[1] || '';
console.log('CUR:', curEmpty);
console.log('CLEAN:', cleanEmpty);
console.log('CUR hex:', Buffer.from(curEmpty, 'utf8').toString('hex'));
console.log('CLEAN hex:', Buffer.from(cleanEmpty, 'utf8').toString('hex'));

const samples = text.split(/\n/).filter((l) => /\u05F3/.test(l)).slice(0, 3);
for (const s of samples) {
  const idx = s.indexOf('\u05F3');
  const slice = s.slice(Math.max(0, idx), idx + 24);
  console.log('---');
  console.log(slice);
  console.log([...slice].map((c) => c.codePointAt(0).toString(16)).join(' '));
}

// Count id overlaps with clean Hebrew
const idRe = /id="([^"]+)"[^>]*>([^<]*)</g;
const curMap = new Map();
const cleanMap = new Map();
let m;
while ((m = idRe.exec(text))) curMap.set(m[1], m[2]);
while ((m = idRe.exec(clean))) cleanMap.set(m[1], m[2]);
let replaceable = 0;
for (const [id, t] of curMap) {
  const c = cleanMap.get(id);
  if (!c) continue;
  if (t !== c && /[\u0590-\u05FF]/.test(c) && (t.includes('\u05F3') || /ג€/.test(t))) replaceable++;
}
console.log('replaceable ids', replaceable, 'curIds', curMap.size, 'cleanIds', cleanMap.size);
