#!/usr/bin/env node
/**
 * Package A Stage 12: URL safety helpers for feed avatars/media + chat resource gate.
 * Run: node qa/xss-url-safety-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let pass = 0;
let fail = 0;

function record(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name);
    return;
  }
  fail += 1;
  results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
}

function loadUtils() {
  const code = fs.readFileSync(path.join(ROOT, 'utils.js'), 'utf8');
  const sandbox = {
    console,
    URL,
    document: {
      readyState: 'complete',
      getElementById: () => null,
      addEventListener: () => {},
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'utils.js' });
  return sandbox.NostrApp || sandbox.App || {};
}

const App = loadUtils();

record(
  'utils exports safeProfilePictureUrl',
  typeof App.safeProfilePictureUrl === 'function',
);
record(
  'utils exports safeFeedMediaUrl',
  typeof App.safeFeedMediaUrl === 'function',
);
record(
  'utils exports escapeHtml',
  typeof App.escapeHtml === 'function',
);
record(
  'escapeHtml regex includes quote chars in class',
  /replace\(\/\[&<>"'\]\/g/.test(fs.readFileSync(path.join(ROOT, 'utils.js'), 'utf8')),
);

// --- Avatar / profile picture ---
record(
  'avatar allows https CDN',
  App.safeProfilePictureUrl('https://cdn.example.com/a.png') === 'https://cdn.example.com/a.png',
);
record(
  'avatar allows http',
  App.safeProfilePictureUrl('http://cdn.example.com/a.png').startsWith('http://'),
);
record(
  'avatar allows data:image/png',
  App.safeProfilePictureUrl('data:image/png;base64,abc') === 'data:image/png;base64,abc',
);
record(
  'avatar rejects javascript:',
  App.safeProfilePictureUrl('javascript:alert(1)') === '',
);
record(
  'avatar rejects JavaScript: mixed case',
  App.safeProfilePictureUrl('JavaScript:alert(1)') === '',
);
record(
  'avatar rejects vbscript:',
  App.safeProfilePictureUrl('vbscript:msgbox(1)') === '',
);
record(
  'avatar rejects data:text/html',
  App.safeProfilePictureUrl('data:text/html,<script>alert(1)</script>') === '',
);
record(
  'avatar rejects data:image/svg',
  App.safeProfilePictureUrl('data:image/svg+xml,<svg onload=alert(1)>') === '',
);
record(
  'avatar rejects malformed',
  App.safeProfilePictureUrl('https://') === '' || App.safeProfilePictureUrl('not-a-url') === '',
);
record(
  'avatar rejects whitespace-prefixed javascript',
  App.safeProfilePictureUrl('  javascript:alert(1)') === '',
);

// --- Feed media / href ---
record(
  'feed href allows https',
  App.safeFeedMediaUrl('https://example.com/doc', 'href') === 'https://example.com/doc',
);
record(
  'feed href rejects javascript',
  App.safeFeedMediaUrl('javascript:alert(1)', 'href') === '',
);
record(
  'feed href rejects JavaScript mixed case',
  App.safeFeedMediaUrl('JaVaScRiPt:alert(1)', 'href') === '',
);
record(
  'feed href rejects data html',
  App.safeFeedMediaUrl('data:text/html,hi', 'href') === '',
);
record(
  'feed img allows https image',
  App.safeFeedMediaUrl('https://cdn.example.com/x.webp', 'img').startsWith('https://'),
);
record(
  'feed img rejects javascript.png trick',
  App.safeFeedMediaUrl('javascript:alert(1).png', 'img') === '',
);
record(
  'feed video allows https mp4',
  App.safeFeedMediaUrl('https://cdn.example.com/v.mp4', 'video').startsWith('https://'),
);
record(
  'feed video rejects vbscript',
  App.safeFeedMediaUrl('vbscript:msg', 'video') === '',
);

// --- Text escaping ---
const escapedScript = App.escapeHtml('<script>alert(1)</script>');
record(
  'escapeHtml script tag',
  typeof escapedScript === 'string' &&
    escapedScript.includes('&lt;script&gt;') &&
    !escapedScript.includes('<script>'),
  JSON.stringify(escapedScript),
);
const escapedImg = App.escapeHtml('<img onerror=alert(1)>');
record(
  'escapeHtml img onerror',
  typeof escapedImg === 'string' && escapedImg.includes('&lt;img'),
  JSON.stringify(escapedImg),
);
const escapedQuotes = App.escapeHtml('a"b\'c');
record(
  'escapeHtml quotes',
  typeof escapedQuotes === 'string' &&
    escapedQuotes.includes('&quot;') &&
    escapedQuotes.includes('&#039;'),
  JSON.stringify(escapedQuotes),
);
record(
  'escapeHtml Hebrew preserved',
  App.escapeHtml('שלום עולם') === 'שלום עולם',
);
record(
  'escapeHtml emoji preserved',
  App.escapeHtml('🙂🔥') === '🙂🔥',
);

// --- Source wiring in feed.js / chat-ui.js ---
const feedSrc = fs.readFileSync(path.join(ROOT, 'feed.js'), 'utf8');
record(
  'feed updateRenderedAuthorProfile uses safeProfilePictureUrl',
  feedSrc.includes('App.safeProfilePictureUrl(profile.picture)'),
);
record(
  'feed buildNotificationHtml uses safeProfilePictureUrl',
  feedSrc.includes('App.safeProfilePictureUrl(profile.picture || \'\')') ||
    feedSrc.includes('App.safeProfilePictureUrl(profile.picture'),
);
record(
  'feed createMediaHtml uses safeFeedMediaUrl',
  feedSrc.includes('App.safeFeedMediaUrl'),
);
record(
  'feed createMediaHtml no raw href="${link}"',
  !/href="\$\{link\}"/.test(feedSrc),
);
record(
  'feed createMediaHtml no raw src="${link}"',
  !/src="\$\{link\}"/.test(feedSrc),
);

const chatUi = fs.readFileSync(path.join(ROOT, 'chat-ui.js'), 'utf8');
record(
  'chat-ui fallback gates with isSafeIncomingChatResource',
  chatUi.includes('isSafeIncomingChatResource(src)'),
);
record(
  'chat-ui fallback no raw href="${src}"',
  !/href="\$\{src\}"/.test(chatUi),
);

// Chat resource gate: covered by chat-signature-gate; assert source still exports it.
const chatServiceSrc = fs.readFileSync(path.join(ROOT, 'chat-service.js'), 'utf8');
record(
  'chat-service exports isSafeIncomingChatResource',
  /isSafeIncomingChatResource/.test(chatServiceSrc) &&
    /javascript\|vbscript\|file\|about/.test(chatServiceSrc),
);
record(
  'chat-service rejects executable data schemes in resource gate',
  /javascript\|vbscript/.test(chatServiceSrc) &&
    (/text\\\/html/.test(chatServiceSrc) || /text\/html/.test(chatServiceSrc)),
);

console.log(results.join('\n'));
console.log(`\nSummary: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
