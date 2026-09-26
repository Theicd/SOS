#!/usr/bin/env node
/**
 * Pass7: strip CP1255/UTF-8 mojibake of the form GERESH+HebrewLetter → HebrewLetter.
 * Legitimate geresh is AFTER letters (שנ׳) and is preserved.
 * Also fixes a few known non-Hebrew mojibake fragments (checkmark etc).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'videos.html');
let t = fs.readFileSync(TARGET, 'utf8');

const beforeGereshPairs = (t.match(/\u05F3[\u05D0-\u05EA]/g) || []).length;
t = t.replace(/\u05F3([\u05D0-\u05EA])/g, '$1');

const EXPLICIT = [
  ['ג…', '✓'],
  ['ג', '✗'],
  ['ג€“', '—'],
  ['ג€¦', '…'],
  ['ג‰ˆ', '≈'],
  ['ג‹®', '⋮'],
  ['ג€™', "'"],
  ['ג€\u009d', '"'],
  ['ג€\u009c', '"'],
];
let explicitHits = 0;
for (const [a, b] of EXPLICIT) {
  if (t.includes(a)) {
    const n = t.split(a).length - 1;
    t = t.split(a).join(b);
    explicitHits += n;
  }
}

fs.writeFileSync(TARGET, t);

function isProductMoj(line) {
  // geresh immediately before Hebrew letter = still broken
  if (/\u05F3[\u05D0-\u05EA]/.test(line)) return true;
  // classic utf8 debris
  if (/Ã.|Â.|×[׳\u05D0-\u05EA]|ג[€‹]/.test(line)) return true;
  return false;
}

let inStyle = false;
const remaining = [];
for (const line of t.split(/\n/)) {
  const s = line.trim();
  if (s.includes('<style')) inStyle = true;
  if (s.includes('</style>')) inStyle = false;
  if (s.startsWith('<!--') || inStyle) continue;
  if (s.startsWith('/*') || s.startsWith('*')) continue;
  // skip pure console.log diagnostics for gate? still user-facing alerts/textContent matter
  if (isProductMoj(line)) remaining.push(s.slice(0, 160));
}

const trailingGereshOk = (t.match(/\d+ שנ׳/g) || []).length;
console.log(JSON.stringify({
  strippedGereshPairs: beforeGereshPairs,
  explicitHits,
  remainingProductMoj: remaining.length,
  samples: remaining.slice(0, 20),
  secondsAbbrevPreserved: trailingGereshOk,
}, null, 2));
