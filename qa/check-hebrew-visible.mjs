#!/usr/bin/env node
import fs from 'node:fs';
const t = fs.readFileSync('videos.html', 'utf8');
const ids = ['notificationsEmpty', 'notificationsMarkRead', 'composeChooserTitle', 'guestAuthModalReason', 'btnStartSignup'];
for (const id of ids) {
  const m = t.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`));
  console.log(id, '=>', m && m[1]);
}
let inStyle = false;
let inScript = false;
const vis = [];
for (const line of t.split(/\n/)) {
  const s = line.trim();
  if (s.includes('<style')) inStyle = true;
  if (s.includes('</style>')) inStyle = false;
  if (s.includes('<script') && !s.includes('</script>')) inScript = true;
  if (s.includes('</script>')) inScript = false;
  if (s.startsWith('<!--')) continue;
  if (inStyle || inScript) continue;
  if (/\u05F3/.test(line) && (line.match(/\u05F3/g) || []).length >= 2) vis.push(s.slice(0, 120));
}
console.log('visible-ish moj lines', vis.length);
console.log(vis.slice(0, 20).join('\n'));
