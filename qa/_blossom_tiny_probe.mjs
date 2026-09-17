import { webcrypto } from 'node:crypto';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';

const sk = generateSecretKey();
const pk = getPublicKey(sk);
async function sha256Hex(bytes) {
  return Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
}
async function authHeader(sha256) {
  const now = Math.floor(Date.now() / 1000);
  const ev = finalizeEvent({
    kind: 24242, content: 'Upload',
    tags: [['t','upload'],['expiration',String(now+3600)],['x',sha256]],
    created_at: now, pubkey: pk,
  }, sk);
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
}

const tinyJpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//Z','base64');

// PNG 1x1
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');

async function tryUp(label, server, path, ct, body) {
  const hash = await sha256Hex(body);
  const url = new URL(path, server).toString();
  const res = await fetch(url, {
    method: 'PUT', body, headers: { 'Content-Type': ct, Accept: 'application/json', Authorization: await authHeader(hash) },
  });
  const text = await res.text();
  console.log(JSON.stringify({ label, server, status: res.status, prefix: text.slice(0,100).replace(/\s+/g,' '), hasUrl: /"url"\s*:/.test(text) }));
}

await tryUp('tiny-jpeg', 'https://blossom.band', '/upload', 'image/jpeg', tinyJpeg);
await tryUp('tiny-png', 'https://blossom.band', '/upload', 'image/png', tinyPng);
await tryUp('tiny-jpeg-nb', 'https://blossom.nostr.build', '/upload', 'image/jpeg', tinyJpeg);
await tryUp('tiny-jpeg-primal', 'https://blossom.primal.net', '/upload', 'image/jpeg', tinyJpeg);

// APP1 EXIF-like custom: SOI + APP1 with ciphertext + rest of tiny jpeg
function app1Wrap(cipher, baseJpeg) {
  const len = cipher.length + 2;
  if (len > 0xffff) throw new Error('too big');
  const app1 = Buffer.alloc(4 + cipher.length);
  app1[0]=0xff; app1[1]=0xe1; app1[2]=(len>>8)&0xff; app1[3]=len&0xff;
  Buffer.from(cipher).copy(app1, 4);
  return Buffer.concat([baseJpeg.subarray(0,2), app1, baseJpeg.subarray(2)]);
}
const cipher = webcrypto.getRandomValues(new Uint8Array(1500));
const app1 = app1Wrap(cipher, tinyJpeg);
await tryUp('app1-jpeg', 'https://blossom.band', '/upload', 'image/jpeg', app1);
await tryUp('app1-jpeg-nb', 'https://blossom.nostr.build', '/upload', 'image/jpeg', app1);
await tryUp('app1-jpeg-primal', 'https://blossom.primal.net', '/upload', 'image/jpeg', app1);

// Also try multipart form for band?
const form = new FormData();
form.append('file', new Blob([tinyJpeg], { type: 'image/jpeg' }), 'x.jpg');
const hash = await sha256Hex(tinyJpeg);
try {
  const res = await fetch('https://blossom.band/upload', {
    method: 'POST',
    body: form,
    headers: { Authorization: await authHeader(hash), Accept: 'application/json' },
  });
  const text = await res.text();
  console.log(JSON.stringify({ label: 'multipart-tiny', status: res.status, prefix: text.slice(0,120).replace(/\s+/g,' ') }));
} catch (e) {
  console.log(JSON.stringify({ label: 'multipart-tiny', err: String(e.message||e) }));
}
