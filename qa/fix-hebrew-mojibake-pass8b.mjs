#!/usr/bin/env node
/**
 * Pass8b: finish undecoded GERESH+C1-control pairs (bytes 0x80-0x9F kept as U+00xx)
 * and patch known user-facing leftovers in videos.html.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'videos.html');
let t = fs.readFileSync(TARGET, 'utf8');

function decodeLeftover(str) {
  const chars = [...str];
  let out = '';
  let n = 0;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0);
    if (cp === 0x05f3 && i + 1 < chars.length) {
      const next = chars[i + 1].codePointAt(0);
      let b2 = null;
      // C1 controls / latin1 leftovers used as raw second UTF-8 bytes
      if (next >= 0x80 && next <= 0x9f) b2 = next;
      // common CP1255 mappings still possible
      else if (next === 0x0153) b2 = 0x9c; // œ → ל
      else if (next === 0x0161) b2 = 0x9a; // š → ך
      else if (next === 0x0160) b2 = 0x8a;
      else if (next === 0x0178) b2 = 0x9f;
      if (b2 != null) {
        try {
          const decoded = Buffer.from([0xd7, b2]).toString('utf8');
          if (/^[\u05D0-\u05EA]$/.test(decoded)) {
            out += decoded;
            n++;
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
  return { out, n };
}

const r = decodeLeftover(t);
t = r.out;

const EXPLICIT = [
  ["return 'תנאי שימוש'", "return 'תנאי שימוש'"], // noop anchor
  ["powerBtn.textContent = uiLogEnabled ? 'לוג: ON' : 'לוג: OFF';", "powerBtn.textContent = uiLogEnabled ? 'לוג: ON' : 'לוג: OFF';"],
  ["saveBtn.textContent = '✗ נכשל';", "saveBtn.textContent = '✗ נכשל';"],
  ["alert('שמירת הלוג נכשלה. נסה שוב או העתק.');", "alert('שמירת הלוג נכשלה. נסה שוב או העתק.');"],
  ["if (!path) return 'מסמך מדיניות';", "if (!path) return 'מסמך מדיניות';"],
  ["if (path.includes('community')) return 'קוד קהילה';", "if (path.includes('community')) return 'קוד קהילה';"],
  ["return 'מסמך מדיניות';", "return 'מסמך מדיניות';"],
  ["alert('יש לאשר את התנאים לפני הפרסום');", "alert('יש לאשר את התנאים לפני הפרסום');"],
  ["alert('יש לאשר את כל התנאים לפני הפרסום');", "alert('יש לאשר את כל התנאים לפני הפרסום');"],
  ["App.setComposeStatus('יש לאשר את התנאים לפני הפרסום.', 'error');", "App.setComposeStatus('יש לאשר את התנאים לפני הפרסום.', 'error');"],
  [
    "if (desc) desc.textContent = 'האפליקציה מותקנת על המחשב שלך. בחרו איש קשר מהרשימה כדי להתחיל לשוחח.';",
    "if (desc) desc.textContent = 'האפליקציה מותקנת על המחשב שלך. בחרו איש קשר מהרשימה כדי להתחיל לשוחח.';",
  ],
  [
    "if (footer) footer.innerHTML = '<i class=\"fa-solid fa-check-circle\"></i> SOS Call 010 מותקנת על Windows';",
    "if (footer) footer.innerHTML = '<i class=\"fa-solid fa-check-circle\"></i> SOS Call 010 מותקנת על Windows';",
  ],
];

// After leftover decode, verify key strings; if still broken, force-replace via regex
const FORCE = [
  [/׳/g, 'ל'], // last-resort if any remain — only if decode missed
];

// Don't use FORCE if decode worked; check first
const stillBadL = (t.match(/\u05F3\u009C/g) || []).length;
const stillBadKaf = (t.match(/\u05F3\u009A/g) || []).length;

fs.writeFileSync(TARGET, t);

function stillMoj(line) {
  if (/\u05F3[\u0080-\u00FF\u2010-\u2030\u2122]/.test(line)) return true;
  if (/Ã.|Â.|ג[€œ‹‰]/.test(line)) return true;
  return false;
}

let inStyle = false;
const remaining = [];
for (const line of t.split(/\n/)) {
  const s = line.trim();
  if (s.includes('<style')) inStyle = true;
  if (s.includes('</style>')) inStyle = false;
  if (s.startsWith('<!--') || inStyle || s.startsWith('/*') || s.trimStart().startsWith('//')) continue;
  if (stillMoj(line)) remaining.push(s.slice(0, 140));
}

console.log(JSON.stringify({
  leftoverRepaired: r.n,
  stillBadL,
  stillBadKaf,
  remainingProductMoj: remaining.length,
  samples: remaining.slice(0, 20),
  checks: {
    terms: t.includes("return 'תנאי שימוש'"),
    allowTerms: t.includes("יש לאשר את התנאים לפני הפרסום"),
    allowAll: t.includes("יש לאשר את כל התנאים לפני הפרסום"),
    installed: t.includes('האפליקציה מותקנת על המחשב שלך'),
    logOn: t.includes("'לוג: ON'"),
    failed: t.includes('✗ נכשל'),
    community: t.includes("'קוד קהילה'"),
    doc: t.includes("'מסמך מדיניות'"),
    seconds: (t.match(/\d+ שנ׳/g) || []).length,
  },
}, null, 2));
