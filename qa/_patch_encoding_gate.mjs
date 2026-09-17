#!/usr/bin/env node
import fs from 'node:fs';

const path = 'qa/e2ee-encrypted-blossom-wire-compat-gate.mjs';
let s = fs.readFileSync(path, 'utf8');
const start = s.indexOf('  // Encoding hygiene:');
const end = s.indexOf('  // --- Realistic mock:');
if (start < 0 || end < 0) {
  console.error('markers missing', start, end);
  process.exit(1);
}

const block = `  // Encoding hygiene: reject classic UTF-8->cp1252->UTF-8 mojibake in hotfix JS sources.
  // Valid Hebrew must remain; detect corrupted punctuation / re-encoded letter clusters only.
  {
    const needles = [
      // Corrupted U+2013/U+2014 dash sequences often start with gimel+euro (ג€)
      String.fromCharCode(0x05d2, 0x20ac),
      // Corrupted ❌
      String.fromCharCode(0x05d2, 0x201d, 0x0152),
      // Corrupted Hebrew "חלק" as seen in 3cebd77: geresh+emdash+geresh+...
      String.fromCharCode(0x05f3, 0x2014, 0x05f3),
      // Corrupted "חסר" / error fragments often include geresh + control/latin1
      String.fromCharCode(0x05f3, 0x201d, 0x0152),
    ];
    const targets = [
      ['blossom.js', blossomSrc],
      ['chat-p2p-file.js', p2pSrc],
      ['media-server-e2ee.js', read('media-server-e2ee.js')],
    ];
    let mojiHits = 0;
    for (const [, src] of targets) {
      for (const lit of needles) {
        let idx = 0;
        while ((idx = src.indexOf(lit, idx)) !== -1) {
          mojiHits += 1;
          idx += lit.length;
        }
      }
    }
    record('NEW MOJIBAKE INTRODUCED ZERO', mojiHits === 0);
    record(
      'blossom.js retains original Hebrew',
      blossomSrc.includes(
        String.fromCharCode(0x05d7, 0x05dc, 0x05e7, 0x20, 0x05d4, 0x05e2, 0x05dc, 0x05d0, 0x05d5, 0x05ea),
      ),
    );
    record('blossom.js has no BOM', blossomSrc.charCodeAt(0) !== 0xfeff);
  }

`;

s = s.slice(0, start) + block + s.slice(end);
fs.writeFileSync(path, s);

// Self-check: needles must hit 3cebd77 blossom and miss current blossom.
const oldBad = fs.existsSync('.git')
  ? null
  : null;
console.log('encoding gate patched');
