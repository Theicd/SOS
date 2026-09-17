#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const main = execSync('git show 0e4d0c52ba3fc97c7e6328d4c7af166f705bcb61:blossom.js', {
  encoding: 'buffer',
}).toString('utf8');
const hot = fs.readFileSync('blossom.js', 'utf8');

const mainLines = main.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
const hotLines = hot.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

const mainM3 = mainLines.findIndex(
  (l) => l.includes('M3') && l.includes('Encrypted Blossom transport'),
);
const hotM3 = hotLines.findIndex(
  (l) => l.includes('M3') && l.includes('Encrypted Blossom transport'),
);
if (mainM3 < 0 || hotM3 < 0) {
  console.error('M3 marker not found', { mainM3, hotM3 });
  process.exit(1);
}

const legacy = mainLines.slice(0, mainM3);
let m3 = hotLines.slice(hotM3);

// Restore Unicode dashes corrupted by UTF-8→Windows-1252→UTF-8 mojibake.
// Em dash U+2014 bytes E2 80 94 misread as Windows-1252 → ג€”
// En dash U+2013 bytes E2 80 93 misread similarly → ג€“
// Cross mark U+274C similarly → ג (should not appear in M3, but sanitize)
function fixMojibakePunctuation(line) {
  return line
    .split('\u05D2\u20AC\u201D').join('\u2014')
    .split('\u05D2\u20AC\u201C').join('\u2013')
    .split('\u05D2\u201D\u0152').join('\u274C');
}

m3 = m3.map(fixMojibakePunctuation);

let out = legacy.concat(m3).join('\n');
if (!out.endsWith('\n')) out += '\n';
fs.writeFileSync('blossom.js', out, { encoding: 'utf8' });

const check = fs.readFileSync('blossom.js', 'utf8');
const bad = ['\u05D2\u20AC', '\u05D2\u201D', '\u05D3\u2014', '\u05D3\u2013'];
// Common mojibake starters from the review
const reviewPatterns = ['ג€', 'ג', '׳—', '׳', '׳§'];
let badCount = 0;
for (const p of reviewPatterns) {
  const c = check.split(p).length - 1;
  console.log('pattern', p, c);
  badCount += c;
}
console.log('hebrew_ok', check.includes('חלק העלאות'));
console.log('secure_wire', check.includes("SECURE_WIRE_CONTENT_TYPE = 'image/jpeg'"));
console.log('opaque', check.includes('sos-opaque-jpeg-v1'));
console.log('cr_count', (check.match(/\r/g) || []).length);
const newLines = check.replace(/\n$/, '').split('\n');
const newM3 = newLines.findIndex(
  (l) => l.includes('M3') && l.includes('Encrypted Blossom transport'),
);
console.log(
  'legacy_exact',
  newLines.slice(0, newM3).join('\n') === mainLines.slice(0, mainM3).join('\n'),
);
console.log('m3_header', newLines[newM3]);
console.log('bad_total', badCount);
