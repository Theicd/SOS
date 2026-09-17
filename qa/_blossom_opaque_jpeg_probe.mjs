import { webcrypto } from 'node:crypto';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import fs from 'node:fs';

const sk = generateSecretKey();
const pk = getPublicKey(sk);

async function sha256Hex(bytes) {
  return Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
}
async function authHeader(sha256) {
  const now = Math.floor(Date.now() / 1000);
  const ev = finalizeEvent({
    kind: 24242,
    content: 'Upload encrypted media compat probe',
    tags: [['t', 'upload'], ['expiration', String(now + 3600)], ['x', sha256]],
    created_at: now,
    pubkey: pk,
  }, sk);
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
}

// Minimal 1x1 grayscale JPEG (known-good tiny) then insert COM with ciphertext after SOI
function buildOpaqueJpeg(cipher) {
  // Tiny valid 1x1 JPEG bytes
  const base = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//Z',
    'base64',
  );
  // Insert COM segment right after SOI (bytes 0..1)
  const len = cipher.length + 2;
  if (len > 0xffff) throw new Error('cipher too large for COM');
  const com = Buffer.alloc(4 + cipher.length);
  com[0] = 0xff; com[1] = 0xfe;
  com[2] = (len >> 8) & 0xff; com[3] = len & 0xff;
  Buffer.from(cipher).copy(com, 4);
  return Buffer.concat([base.subarray(0, 2), com, base.subarray(2)]);
}

function extractCipherFromOpaqueJpeg(bytes) {
  // Find first COM marker
  for (let i = 0; i + 4 < bytes.length; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xfe) {
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      const payloadLen = len - 2;
      const start = i + 4;
      return bytes.subarray(start, start + payloadLen);
    }
  }
  throw new Error('COM not found');
}

const cipher = webcrypto.getRandomValues(new Uint8Array(3000));
const opaque = buildOpaqueJpeg(cipher);
const extracted = extractCipherFromOpaqueJpeg(opaque);
console.log('extract_ok=' + Buffer.from(extracted).equals(Buffer.from(cipher)));
console.log('opaqueSize=' + opaque.length);

const wireHash = await sha256Hex(opaque);
const cipherHash = await sha256Hex(cipher);

const tests = [
  ['https://blossom.band', '/upload', 'PUT'],
  ['https://blossom.nostr.build', '/upload', 'PUT'],
  ['https://blossom.primal.net', '/upload', 'PUT'],
];

for (const [server, path, method] of tests) {
  const url = new URL(path, server).toString();
  try {
    const res = await fetch(url, {
      method,
      body: opaque,
      headers: {
        'Content-Type': 'image/jpeg',
        Accept: 'application/json',
        Authorization: await authHeader(wireHash),
      },
    });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    const resultUrl = data?.url || data?.data?.url || '';
    console.log(JSON.stringify({ server, status: res.status, hasUrl: !!resultUrl, prefix: text.slice(0, 120).replace(/\s+/g,' ') }));
    if (resultUrl) {
      const dl = await fetch(resultUrl);
      const ab = Buffer.from(await dl.arrayBuffer());
      const dlHash = await sha256Hex(ab);
      let ok = false;
      try { ok = Buffer.from(extractCipherFromOpaqueJpeg(ab)).equals(Buffer.from(cipher)); } catch (e) { ok = false; }
      console.log(JSON.stringify({ dl: dl.status, size: ab.length, wireMatch: dlHash === wireHash, extractOk: ok }));
    }
  } catch (e) {
    console.log(JSON.stringify({ server, err: String(e.message||e).slice(0,100) }));
  }
}
