import { webcrypto } from 'node:crypto';
import { generateSecretKey, getPublicKey, finalizeEvent, utils } from 'nostr-tools';

const servers = [
  'https://blossom.band',
  'https://blossom.nostr.build',
  'https://nostr.build',
  'https://blossom.primal.net',
];
const paths = ['/upload', '/media', '/api/v1/upload', '/api/upload'];
const methods = ['PUT', 'POST'];
const contentTypes = [
  'application/octet-stream',
  'image/jpeg',
  'image/png',
  'application/json',
  'video/mp4',
  'audio/webm',
];

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const hex = utils.bytesToHex(sk);

async function sha256Hex(bytes) {
  const hash = await webcrypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(new Uint8Array(hash)).toString('hex');
}

async function createAuth(sha256) {
  const now = Math.floor(Date.now() / 1000);
  const draft = {
    kind: 24242,
    content: 'Upload encrypted media compat probe',
    tags: [['t', 'upload'], ['expiration', String(now + 3600)], ['x', sha256]],
    created_at: now,
    pubkey: pk,
  };
  return finalizeEvent(draft, sk);
}

const cipher = webcrypto.getRandomValues(new Uint8Array(4096));
const hash = await sha256Hex(cipher);
const auth = await createAuth(hash);
const header = 'Nostr ' + Buffer.from(JSON.stringify(auth)).toString('base64');

const rows = [];
for (const server of servers) {
  for (const path of paths) {
    for (const method of methods) {
      for (const ct of contentTypes) {
        const url = new URL(path, server).toString();
        let status = 'ERR';
        let cors = 'n/a';
        let accepted = false;
        let returnedUrl = '';
        let returnedHash = '';
        try {
          const res = await fetch(url, {
            method,
            body: cipher,
            headers: {
              'Content-Type': ct,
              Accept: 'application/json',
              Authorization: header,
            },
            redirect: 'manual',
          });
          status = String(res.status);
          const text = await res.text().catch(() => '');
          let data = null;
          try { data = JSON.parse(text); } catch {}
          returnedUrl = data?.url || data?.data?.url || '';
          returnedHash = data?.sha256 || data?.hash || '';
          accepted = res.ok && !!returnedUrl;
          cors = 'ok';
        } catch (e) {
          status = 'NETWORK';
          cors = String(e && e.message || e).slice(0, 80);
        }
        rows.push({ server, path, method, ct, status, cors, accepted, returnedUrl: returnedUrl ? 'YES' : 'NO', returnedHash: returnedHash ? String(returnedHash).slice(0, 12) : '' });
      }
    }
  }
}

const accepted = rows.filter(r => r.accepted);
const byCt = {};
for (const r of rows) {
  byCt[r.ct] = byCt[r.ct] || { ok: 0, total: 0, statuses: {} };
  byCt[r.ct].total++;
  if (r.accepted) byCt[r.ct].ok++;
  byCt[r.ct].statuses[r.status] = (byCt[r.ct].statuses[r.status] || 0) + 1;
}
console.log('ACCEPTED_COUNT=' + accepted.length);
console.log('BY_CONTENT_TYPE=' + JSON.stringify(byCt, null, 2));
console.log('ACCEPTED_ROWS:');
for (const r of accepted) {
  console.log(JSON.stringify(r));
}
console.log('SAMPLE_REJECTS_OCTET:');
for (const r of rows.filter(x => x.ct === 'application/octet-stream').slice(0, 20)) {
  console.log(JSON.stringify(r));
}
console.log('SAMPLE_JPEG:');
for (const r of rows.filter(x => x.ct === 'image/jpeg')) {
  console.log(JSON.stringify(r));
}
