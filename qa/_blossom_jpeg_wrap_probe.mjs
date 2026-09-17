import { webcrypto } from 'node:crypto';
import { generateSecretKey, getPublicKey, finalizeEvent, utils } from 'nostr-tools';

const sk = generateSecretKey();
const pk = getPublicKey(sk);

async function sha256Hex(bytes) {
  const hash = await webcrypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(new Uint8Array(hash)).toString('hex');
}

async function authHeader(sha256) {
  const now = Math.floor(Date.now() / 1000);
  const draft = {
    kind: 24242,
    content: 'Upload encrypted media compat probe',
    tags: [['t', 'upload'], ['expiration', String(now + 3600)], ['x', sha256]],
    created_at: now,
    pubkey: pk,
  };
  const ev = finalizeEvent(draft, sk);
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64');
}

function wrapJpegCom(cipher) {
  // SOI + COM(ciphertext) + EOI. COM length = ciphertext.length + 2
  const len = cipher.length + 2;
  if (len > 0xffff) throw new Error('too large for single COM');
  const out = new Uint8Array(2 + 2 + 2 + cipher.length + 2);
  out[0] = 0xff; out[1] = 0xd8; // SOI
  out[2] = 0xff; out[3] = 0xfe; // COM
  out[4] = (len >> 8) & 0xff;
  out[5] = len & 0xff;
  out.set(cipher, 6);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9; // EOI
  return out;
}

function unwrapJpegCom(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('bad SOI');
  if (bytes[2] !== 0xff || bytes[3] !== 0xfe) throw new Error('bad COM');
  const len = (bytes[4] << 8) | bytes[5];
  const payloadLen = len - 2;
  const start = 6;
  const end = start + payloadLen;
  if (bytes[end] !== 0xff || bytes[end + 1] !== 0xd9) throw new Error('bad EOI');
  return bytes.subarray(start, end);
}

const cipher = webcrypto.getRandomValues(new Uint8Array(2048));
const cipherHash = await sha256Hex(cipher);
const wrapped = wrapJpegCom(cipher);
const wrapHash = await sha256Hex(wrapped);
const round = unwrapJpegCom(wrapped);
console.log('unwrap_ok=' + (Buffer.from(round).equals(Buffer.from(cipher))));
console.log('cipherHash=' + cipherHash.slice(0, 16));
console.log('wrapHash=' + wrapHash.slice(0, 16));

const targets = [
  ['https://blossom.band', '/upload', 'PUT', 'image/jpeg', wrapped, wrapHash],
  ['https://blossom.band', '/upload', 'PUT', 'application/octet-stream', cipher, cipherHash],
  ['https://blossom.nostr.build', '/upload', 'PUT', 'image/jpeg', wrapped, wrapHash],
  ['https://blossom.nostr.build', '/upload', 'PUT', 'application/octet-stream', cipher, cipherHash],
  ['https://blossom.primal.net', '/upload', 'PUT', 'image/jpeg', wrapped, wrapHash],
  ['https://blossom.primal.net', '/media', 'PUT', 'image/jpeg', wrapped, wrapHash],
  ['https://nostr.build', '/upload', 'PUT', 'image/jpeg', wrapped, wrapHash],
];

for (const [server, path, method, ct, body, hash] of targets) {
  const url = new URL(path, server).toString();
  try {
    const res = await fetch(url, {
      method,
      body,
      headers: {
        'Content-Type': ct,
        Accept: 'application/json',
        Authorization: await authHeader(hash),
      },
      redirect: 'manual',
    });
    const text = await res.text();
    console.log(JSON.stringify({
      server, path, method, ct,
      status: res.status,
      bodyPrefix: text.slice(0, 180).replace(/\s+/g, ' '),
      hasUrl: /"url"\s*:/.test(text),
    }));
    if (res.ok) {
      let data = null;
      try { data = JSON.parse(text); } catch {}
      const resultUrl = data?.url || data?.data?.url || '';
      if (resultUrl) {
        const dl = await fetch(resultUrl);
        const ab = new Uint8Array(await dl.arrayBuffer());
        const dlHash = await sha256Hex(ab);
        let unwrappedOk = false;
        try {
          const u = unwrapJpegCom(ab);
          unwrappedOk = Buffer.from(u).equals(Buffer.from(cipher));
        } catch {}
        console.log(JSON.stringify({
          download: true,
          status: dl.status,
          size: ab.length,
          dlHashPrefix: dlHash.slice(0, 16),
          matchesWrapHash: dlHash === wrapHash,
          matchesCipherHash: dlHash === cipherHash,
          unwrappedOk,
          resultUrlHost: new URL(resultUrl).hostname,
        }));
      }
    }
  } catch (e) {
    console.log(JSON.stringify({ server, path, method, ct, err: String(e.message || e).slice(0, 100) }));
  }
}
