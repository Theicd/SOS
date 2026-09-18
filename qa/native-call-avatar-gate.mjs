#!/usr/bin/env node
/**
 * Native call avatar gate — bounded data:image persistence (no mid-Base64 truncate).
 * Run: node qa/native-call-avatar-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
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

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const cache = read('android-shell/app/src/main/java/com/sos010/app/SosContactCache.kt');
const bridge = read('android-shell/app/src/main/java/com/sos010/app/SosJsBridge.kt');
const incoming = read('android-shell/app/src/main/java/com/sos010/app/IncomingCallActivity.kt');

// 1. data:image not truncated via clampText(2048)
const cacheContactFn = (() => {
  const idx = bridge.indexOf('fun cacheContact');
  if (idx < 0) return '';
  const end = bridge.indexOf('\n    @JavascriptInterface', idx + 10);
  return bridge.slice(idx, end > idx ? end : idx + 800);
})();
record('cacheContact does not clampText(picture, 2048)',
  cacheContactFn.length > 0 && !/clampText\(\s*picture\s*,\s*2048\s*\)/.test(cacheContactFn));
record('cacheContact still clamps name',
  /clampText\(\s*name\s*,\s*120\s*\)/.test(cacheContactFn));

// 2. bounded native avatar persistence
record('avatarfile local persistence prefix', /AVATAR_FILE_PREFIX\s*=\s*"avatarfile:"/.test(cache));
record('persistDataAvatar exists', /fun persistDataAvatar|private fun persistDataAvatar/.test(cache));
record('max decoded bytes 2 MiB', /MAX_DECODED_BYTES\s*=\s*2\s*\*\s*1024\s*\*\s*1024/.test(cache));
record('final avatar size <= 320', /AVATAR_SIZE\s*=\s*320/.test(cache));
record('allowed MIME jpeg/png/webp only',
  /data:image\/jpeg/.test(cache) && /data:image\/png/.test(cache) && /data:image\/webp/.test(cache));
record('http(s) URL still supported',
  /startsWith\("https:\/\/"\)/.test(cache) && /MAX_HTTP_URL_CHARS/.test(cache));
record('never persist raw data:image in SharedPreferences',
  /Never persist raw data:image|Never keep raw data:image|startsWith\("data:image"\)[\s\S]{0,80}pic = ""/.test(cache)
  || (/AVATAR_FILE_PREFIX/.test(cache) && /else -> ""/.test(cache) && !/put\(\s*"picture"\s*,\s*c\.picture\s*\)/.test(cache)));

// 3. invalid / bomb defenses
record('bounds check before Base64 decode', /MAX_DECODED_BYTES/.test(cache) && /inJustDecodeBounds/.test(cache));
record('dimension bomb guard', /outWidth > 8192/.test(cache));

// 4. IncomingCallActivity loads via context-aware bitmap
record('IncomingCallActivity loadBitmap(context)',
  /SosContactCache\.loadBitmap\(\s*this@IncomingCallActivity/.test(incoming)
  || /SosContactCache\.loadBitmap\(\s*this,/.test(incoming));
record('initials fallback preserved',
  /incomingAvatarLetter/.test(incoming) && /name\.take\(1\)/.test(incoming));

// 5. privacy-safe logs
record('AVATAR_NATIVE_STORE_OK log', /AVATAR_NATIVE_STORE_OK/.test(cache));
record('AVATAR_NATIVE_STORE_FAIL log', /AVATAR_NATIVE_STORE_FAIL/.test(cache));
record('AVATAR_NATIVE_CACHE_HIT log', /AVATAR_NATIVE_CACHE_HIT/.test(cache));
record('AVATAR_NATIVE_CACHE_MISS log', /AVATAR_NATIVE_CACHE_MISS/.test(cache));
record('AVATAR_NATIVE_DECODE_FAIL log', /AVATAR_NATIVE_DECODE_FAIL/.test(cache));
record('no Base64 body logged',
  !/Log\.[iewd]\([^)]*b64|Log\.[iewd]\([^)]*Base64|Log\.[iewd]\([^)]*dataUrl/.test(cache));
record('no full pubkey in avatar logs',
  !/Log\.[iewd]\([^)]*\$pk|Log\.[iewd]\([^)]*pubkey=/.test(cache));

// 6. cache survives process restart (file-backed)
record('avatar stored under filesDir/call_avatars',
  /AVATAR_DIR\s*=\s*"call_avatars"/.test(cache) && /filesDir/.test(cache));
record('avatarfile key by normalized pubkey',
  /File\(dir,\s*"\$pk\.jpg"\)/.test(cache) || /"\$pk\.jpg"/.test(cache));

console.log(results.join('\n'));
console.log(`\nNATIVE_CALL_AVATAR_GATE ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
