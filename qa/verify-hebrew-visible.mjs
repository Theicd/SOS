#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = fs.readFileSync(path.join(ROOT, 'videos.html'), 'utf8');
const ids = ['notificationsEmpty', 'notificationsMarkRead', 'composeChooserTitle', 'btnStartSignup', 'guestAuthModalReason'];
for (const id of ids) {
  const m = t.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`));
  console.log(id, '=>', m && m[1]);
}
function isMoj(s) {
  if (!s) return false;
  // Legitimate abbreviation: N שנ׳ (seconds)
  if (/(^|>)\d+\s*שנ׳(<|$)/.test(s) && !/\u05F3[\u0080-\u00FF\u2010-\u2030\u2122]/.test(s.replace(/\d+\s*שנ׳/g, ''))) {
    const without = s.replace(/\d+\s*שנ׳/g, '');
    if (!/\u05F3[\u0080-\u00FF\u05D0-\u05EA\u2010-\u2030\u2122]/.test(without)) return false;
  }
  // Mojibake: GERESH before high/latin/control (CP1255 misdecode residue)
  if (/\u05F3[\u0000-\u007F\u0080-\u00FF\u2010-\u2030\u2122]/.test(s)) return true;
  // GERESH immediately before Hebrew letter (spurious lead byte)
  if (/\u05F3[\u05D0-\u05EA]/.test(s)) return true;
  const geresh = (s.match(/\u05F3/g) || []).length;
  const heb = (s.match(/[\u05D0-\u05EA]/g) || []).length;
  return geresh >= 2 && geresh > heb;
}
let inStyle = false, inScript = false;
const vis = [];
for (const line of t.split(/\n/)) {
  const s = line.trim();
  if (s.includes('<style')) inStyle = true;
  if (s.includes('</style>')) inStyle = false;
  if (s.includes('<script') && !s.includes('</script>')) inScript = true;
  if (s.includes('</script>')) inScript = false;
  if (s.startsWith('<!--') || inStyle || inScript) continue;
  if (isMoj(line)) vis.push(s.slice(0, 140));
}
console.log('visible moj lines', vis.length);
console.log(vis.slice(0, 20).join('\n'));
