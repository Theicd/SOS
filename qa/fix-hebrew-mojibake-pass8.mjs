#!/usr/bin/env node
/**
 * Pass8: reverse Windows-1255 misdecode of UTF-8 Hebrew in videos.html.
 * Each Hebrew UTF-8 letter (D7 xx) became GERESH (CP1255 D7) + CP1255(xx).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'videos.html');

/** CP1255 byte → Unicode (WHATWG / Windows-1255). */
function cp1255DecodeByte(b) {
  if (b < 0x80) return b;
  const table = {
    0x80: 0x20ac, 0x81: 0x81, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e,
    0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030,
    0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8d: 0x8d, 0x8e: 0x8e, 0x8f: 0x8f,
    0x90: 0x90, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d,
    0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122,
    0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9d: 0x9d, 0x9e: 0x9e, 0x9f: 0x9f,
    0xa0: 0x00a0, 0xa1: 0x00a1, 0xa2: 0x00a2, 0xa3: 0x00a3, 0xa4: 0x20aa,
    0xa5: 0x00a5, 0xa6: 0x00a6, 0xa7: 0x00a7, 0xa8: 0x00a8, 0xa9: 0x00a9,
    0xaa: 0x00d7, 0xab: 0x00ab, 0xac: 0x00ac, 0xad: 0x00ad, 0xae: 0x00ae,
    0xaf: 0x00af, 0xb0: 0x00b0, 0xb1: 0x00b1, 0xb2: 0x00b2, 0xb3: 0x00b3,
    0xb4: 0x00b4, 0xb5: 0x00b5, 0xb6: 0x00b6, 0xb7: 0x00b7, 0xb8: 0x00b8,
    0xb9: 0x00b9, 0xba: 0x00f7, 0xbb: 0x00bb, 0xbc: 0x00bc, 0xbd: 0x00bd,
    0xbe: 0x00be, 0xbf: 0x00bf,
    0xc0: 0x05b0, 0xc1: 0x05b1, 0xc2: 0x05b2, 0xc3: 0x05b3, 0xc4: 0x05b4,
    0xc5: 0x05b5, 0xc6: 0x05b6, 0xc7: 0x05b7, 0xc8: 0x05b8, 0xc9: 0x05b9,
    0xca: 0x05ba, 0xcb: 0x05bb, 0xcc: 0x05bc, 0xcd: 0x05bd, 0xce: 0x05be,
    0xcf: 0x05bf, 0xd0: 0x05c0, 0xd1: 0x05c1, 0xd2: 0x05c2, 0xd3: 0x05c3,
    0xd4: 0x05f0, 0xd5: 0x05f1, 0xd6: 0x05f2, 0xd7: 0x05f3, 0xd8: 0x05f4,
    0xd9: 0xd9, 0xda: 0xda, 0xdb: 0xdb, 0xdc: 0xdc, 0xdd: 0xdd, 0xde: 0xde, 0xdf: 0xdf,
  };
  if (table[b] != null) return table[b];
  if (b >= 0xe0 && b <= 0xfa) return 0x05d0 + (b - 0xe0);
  return b;
}

const UNI_TO_BYTE = new Map();
for (let b = 0; b < 256; b++) {
  const cp = cp1255DecodeByte(b);
  // Prefer first assignment; for ambiguous keep lowest byte (UTF-8 2nd bytes matter)
  if (!UNI_TO_BYTE.has(cp)) UNI_TO_BYTE.set(cp, b);
}
// Critical overrides for UTF-8 Hebrew second bytes (0x90-0xAA) that collide:
UNI_TO_BYTE.set(0x00d7, 0xaa); // × from CP1255 0xAA (not byte 0xD7)
UNI_TO_BYTE.set(0x05f3, 0xd7); // GERESH — only used as lead marker, not as b2 normally

function decodeMojibake(str) {
  const chars = [...str];
  let out = '';
  let repaired = 0;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0);
    if (cp === 0x05f3 && i + 1 < chars.length) {
      const next = chars[i + 1].codePointAt(0);
      // Do not treat legitimate trailing abbreviation GERESH (end of token / before non-mojibake)
      // as lead: only when next maps to a plausible UTF-8 Hebrew second byte (0x90-0xBF typically).
      const b2 = UNI_TO_BYTE.get(next);
      if (b2 != null && b2 >= 0x80) {
        try {
          const decoded = Buffer.from([0xd7, b2]).toString('utf8');
          // Accept Hebrew letters and niqqud/punctuation from D7 block
          if (/^[\u05D0-\u05EA\u05F0-\u05F4\u0591-\u05C7]$/.test(decoded)) {
            out += decoded;
            repaired++;
            i += 1;
            continue;
          }
        } catch {
          // fall through
        }
      }
    }
    out += chars[i];
  }
  return { out, repaired };
}

// Self-test
const testIn = "׳×׳ ׳׳™ ׳©׳™׳׳•׳©";
const testOut = decodeMojibake(testIn).out;
console.log('selftest', JSON.stringify(testIn), '=>', JSON.stringify(testOut), testOut === 'תנאי שימוש' ? 'OK' : 'FAIL');

let t = fs.readFileSync(TARGET, 'utf8');
const { out, repaired } = decodeMojibake(t);
t = out;

// leftover non-Hebrew utf8 debris from prior double-encoding of punctuation
const EXPLICIT = [
  ['ג…', '✓'],
  ['ג', '✗'],
  ['ג€“', '—'],
  ['ג€”', '—'],
  ['ג€¦', '…'],
  ['ג‰ˆ', '≈'],
  ['ג‹®', '⋮'],
  ['ײ¾', '-'],
];
let explicitHits = 0;
for (const [a, b] of EXPLICIT) {
  if (t.includes(a)) {
    explicitHits += t.split(a).length - 1;
    t = t.split(a).join(b);
  }
}

fs.writeFileSync(TARGET, t);

function stillMoj(line) {
  // Remaining GERESH+highchar pairs that look like undecoded lead
  if (/\u05F3[\u00A0-\u00FF\u2010-\u2030\u2122\u0090-\u009F]/.test(line)) return true;
  if (/Ã.|Â.|ג[€œ‹‰]/.test(line)) return true;
  return false;
}

let inStyle = false;
const remaining = [];
for (const line of t.split(/\n/)) {
  const s = line.trim();
  if (s.includes('<style')) inStyle = true;
  if (s.includes('</style>')) inStyle = false;
  if (s.startsWith('<!--') || inStyle || s.startsWith('/*')) continue;
  if (stillMoj(line)) remaining.push(s.slice(0, 140));
}

console.log(JSON.stringify({
  repairedPairs: repaired,
  explicitHits,
  remainingProductMoj: remaining.length,
  samples: remaining.slice(0, 15),
  termsCheck: t.includes("return 'תנאי שימוש'"),
  copiedCheck: t.includes("copy.textContent = '✓ הועתק!'"),
  secondsOk: (t.match(/\d+ שנ׳/g) || []).length,
}, null, 2));
