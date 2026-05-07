#!/usr/bin/env node
/**
 * סקירת אבטחה סטטית קלה ל-SOS (מקומית, ללא גישה לרשת).
 * מריצים: node qa/security-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return '';
  }
}

function flagsForContent(name, content) {
  const f = [];
  if (/nostr_private_key|private_key|privateKey/i.test(content) && /localStorage\.setItem|getItem/.test(content)) {
    f.push('KEY_MATERIAL_IN_LOCALSTORAGE');
  }
  if (/innerHTML\s*=/.test(content) && !name.includes('security-audit')) {
    f.push('innerHTML_ASSIGNMENT');
  }
  if (/eval\s*\(/.test(content)) {
    f.push('EVAL_USED');
  }
  if (/document\.write\s*\(/.test(content)) {
    f.push('DOCUMENT_WRITE');
  }
  if (/http:\/\//.test(content) && /\.(js|html)/.test(name)) {
    f.push('MIXED_OR_HTTP_REFERENCE');
  }
  return f;
}

const targets = [
  'auth.js',
  'guest-auth.js',
  'chat-service.js',
  'chat-p2p-file.js',
  'chat-p2p-datachannel.js',
  'chat-e2ee-wrapper.js',
  'p2p-video-sharing.js',
  'offline-storage.js',
  'push-client.js',
  'service-worker.js',
  'chat-ui.js',
];

const summary = {
  root: ROOT,
  checkedFiles: 0,
  flagCounts: {},
  fileFlags: {},
};

for (const rel of targets) {
  const content = read(rel);
  if (!content) continue;
  summary.checkedFiles += 1;
  const flags = flagsForContent(rel, content);
  if (flags.length) summary.fileFlags[rel] = flags;
  for (const fl of flags) {
    summary.flagCounts[fl] = (summary.flagCounts[fl] || 0) + 1;
  }
}

const nip04files = [];
for (const rel of targets) {
  const c = read(rel);
  if (c.includes('nip04')) nip04files.push(rel);
}

summary.nip04UsageFiles = nip04files;
summary.recommendations = [
  'מפתח פרטי ב-localStorage: חשוף לכל סקריפט בהקשר המקור; שקול WebCrypto + session flag או Extension, או passphrase לפחות.',
  'NIP-04 (נוסטר): ידוע כלא אידיאלי מבחינת קריפטו; NIP-44 מומלץ לתאימות קדימה.',
  'P2P/WebRTC: מטא-דאטה וסיגנלינג עוברים בריליי; תוכן מוצפן ב-DC אבל relays רואים מי מדבר עם מי ומתי.',
  'innerHTML: סיכון XSS אם תוכן משתמש/ריליי מגיע לDOM ללא sanitization; העדף textContent או sanitize מוגדר.',
  'שקול CSP (Content-Security-Policy), SRI לסקריפטים חיצוניים, ו-HTTPS בלבד בפרודקשן.',
];

console.log(JSON.stringify(summary, null, 2));
