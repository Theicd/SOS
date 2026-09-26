#!/usr/bin/env node
/**
 * Restore Hebrew comments/strings in videos.html from known-good c14a490
 * without reverting functional HTML/JS changes.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'videos.html');
const GOOD_REV = 'c14a490';

function isMoj(s) {
  return /\u05F3[^\u05D0-\u05EA\s]/.test(s) || /ג€|Ã.|â€|ï¿½|�/.test(s);
}

function extractComments(html) {
  const out = [];
  const re = /<!--([\s\S]*?)-->/g;
  let m;
  while ((m = re.exec(html))) {
    out.push({ full: m[0], body: m[1], index: m.index });
  }
  return out;
}

function extractCssComments(html) {
  const out = [];
  const re = /\/\*([\s\S]*?)\*\//g;
  let m;
  while ((m = re.exec(html))) {
    out.push({ full: m[0], body: m[1], index: m.index });
  }
  return out;
}

function keyTokens(s) {
  const eng = (s.match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) || []).map((x) => x.toLowerCase());
  return [...new Set(eng)].sort().join('|');
}

function scoreMatch(a, b) {
  const ka = keyTokens(a).split('|').filter(Boolean);
  const kb = new Set(keyTokens(b).split('|').filter(Boolean));
  if (!ka.length) return 0;
  let hit = 0;
  for (const t of ka) if (kb.has(t)) hit++;
  return hit / ka.length;
}

const cur = fs.readFileSync(TARGET, 'utf8');
const good = execSync(`git show ${GOOD_REV}:videos.html`, { maxBuffer: 40e6, cwd: ROOT }).toString('utf8');

const goodHtml = extractComments(good);
const goodCss = extractCssComments(good);
let t = cur;
let replaced = 0;

for (const c of extractComments(cur)) {
  if (!isMoj(c.full)) continue;
  let best = null;
  let bestScore = 0;
  for (const g of goodHtml) {
    const sc = scoreMatch(c.body, g.body);
    if (sc > bestScore) {
      bestScore = sc;
      best = g;
    }
  }
  if (best && bestScore >= 0.45 && !isMoj(best.full)) {
    if (t.includes(c.full)) {
      t = t.replace(c.full, best.full);
      replaced++;
    }
  }
}

for (const c of extractCssComments(cur)) {
  if (!isMoj(c.full)) continue;
  // only touch style-blockish comments (Hebrew developer notes)
  let best = null;
  let bestScore = 0;
  for (const g of goodCss) {
    const sc = scoreMatch(c.body, g.body);
    if (sc > bestScore) {
      bestScore = sc;
      best = g;
    }
  }
  if (best && bestScore >= 0.5 && !isMoj(best.full)) {
    if (t.includes(c.full)) {
      t = t.replace(c.full, best.full);
      replaced++;
    }
  }
}

// Fix known console log mojibake if present
t = t.replace(
  /console\.log\('\[PWA-EARLY\][^']*'\);/,
  "console.log('[PWA-EARLY] beforeinstallprompt captured early!');"
);

fs.writeFileSync(TARGET, t);
const left = (t.match(/\u05F3[^\u05D0-\u05EA\s]/g) || []).length;
console.log(JSON.stringify({ replaced, remainingMojClusters: left }, null, 2));
