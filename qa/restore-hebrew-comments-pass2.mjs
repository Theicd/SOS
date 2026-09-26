#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = path.join(ROOT, 'videos.html');
let t = fs.readFileSync(p, 'utf8');
const good = execSync('git show c14a490:videos.html', { maxBuffer: 40e6, cwd: ROOT }).toString('utf8');

function isMoj(s) {
  return /\u05F3[^\u05D0-\u05EA\s]/.test(s) || /ג€|Ã.|â€|ï¿½|�/.test(s);
}

function tokens(s) {
  return [...new Set((s.match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) || []).map((x) => x.toLowerCase()))];
}

function score(a, b) {
  const ka = tokens(a);
  const kb = new Set(tokens(b));
  if (!ka.length) return 0;
  let hit = 0;
  for (const x of ka) if (kb.has(x)) hit++;
  return hit / ka.length;
}

const goodHtml = [...good.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => ({ full: m[0], body: m[1] }));
const goodCss = [...good.matchAll(/\/\*([\s\S]*?)\*\//g)].map((m) => ({ full: m[0], body: m[1] }));
let n = 0;
for (const m of [...t.matchAll(/<!--([\s\S]*?)-->/g)]) {
  if (!isMoj(m[0])) continue;
  let best = null;
  let bestSc = 0;
  for (const g of goodHtml) {
    const sc = score(m[1], g.body);
    if (sc > bestSc) {
      bestSc = sc;
      best = g;
    }
  }
  if (best && bestSc >= 0.35 && !isMoj(best.full) && t.includes(m[0])) {
    t = t.replace(m[0], best.full);
    n++;
  }
}
for (const m of [...t.matchAll(/\/\*([\s\S]*?)\*\//g)]) {
  if (!isMoj(m[0])) continue;
  let best = null;
  let bestSc = 0;
  for (const g of goodCss) {
    const sc = score(m[1], g.body);
    if (sc > bestSc) {
      bestSc = sc;
      best = g;
    }
  }
  if (best && bestSc >= 0.4 && !isMoj(best.full) && t.includes(m[0])) {
    t = t.replace(m[0], best.full);
    n++;
  }
}
// neutralize remaining mojibake-only developer // comments
t = t.replace(/^[ \t]*\/\/[^\n]*$/gm, (line) => {
  if (!isMoj(line)) return line;
  return '        // developer note';
});

fs.writeFileSync(p, t);

// visible product strings check (exclude style/script/comments and legitimate geresh)
let inStyle = false;
let inScript = false;
const vis = [];
for (const line of t.split(/\n/)) {
  const s = line.trim();
  if (s.includes('<style')) inStyle = true;
  if (s.includes('</style>')) inStyle = false;
  if (s.includes('<script') && !s.includes('</script>')) inScript = true;
  if (s.includes('</script>')) inScript = false;
  if (s.startsWith('<!--') || inStyle || inScript) continue;
  let probe = line.replace(/שנ׳/g, '').replace(/צ׳אט/g, '').replace(/צ׳ט/g, '');
  if (isMoj(probe)) vis.push(s.slice(0, 140));
}
console.log(JSON.stringify({ replaced: n, visibleMojibakeLines: vis.length, samples: vis.slice(0, 10) }, null, 2));
