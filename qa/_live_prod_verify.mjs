#!/usr/bin/env node
import https from 'node:https';

function get(url) {
  return new Promise((res, rej) => {
    https
      .get(
        url,
        {
          headers: {
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
            'User-Agent': 'sos-blossom-release-verify',
          },
        },
        (r) => {
          let d = '';
          r.on('data', (c) => (d += c));
          r.on('end', () => res({ status: r.statusCode, body: d }));
        },
      )
      .on('error', rej);
  });
}

const ts = Date.now();
const av = JSON.parse((await get('https://sos010.com/app-version.json?t=' + ts)).body);
console.log('VERSION', av.version);
console.log('minSecureChatEpoch', av.minSecureChatEpoch);
console.log('e2eeSendRequired', av.e2eeSendRequired);
console.log('mediaServerE2eeRequired', av.mediaServerE2eeRequired);

const sw = (await get('https://sos010.com/service-worker.js?t=' + ts)).body;
console.log('SW', (sw.match(/sos-cache-v\d+/) || [])[0]);

const blossom = (await get('https://sos010.com/blossom.js?t=' + ts)).body;
console.log('opaque', blossom.includes('sos-opaque-jpeg-v1'));
console.log('wireCT', blossom.includes("SECURE_WIRE_CONTENT_TYPE = 'image/jpeg'"));
console.log(
  'hebrew',
  blossom.includes(
    String.fromCharCode(0x05d7, 0x05dc, 0x05e7, 0x20, 0x05d4, 0x05e2, 0x05dc, 0x05d0, 0x05d5, 0x05ea),
  ),
);
const needles = [
  String.fromCharCode(0x05d2, 0x20ac),
  String.fromCharCode(0x05f3, 0x2014, 0x05f3),
];
let moji = 0;
for (const n of needles) {
  let i = 0;
  while ((i = blossom.indexOf(n, i)) !== -1) {
    moji += 1;
    i += n.length;
  }
}
console.log('moji', moji);

const p2p = (await get('https://sos010.com/chat-p2p-file.js?t=' + ts)).body;
console.log('publishOk', p2p.includes('publishOk'));
console.log(
  'clearBeforeTorrent',
  /clearChatFileAttachment[\s\S]{0,120}fallbackToTorrent/.test(p2p),
);

const videos = (await get('https://sos010.com/videos.html?t=' + ts)).body;
console.log('videos blossom bust', videos.includes('blossom.js?v=20260917blossom1'));
console.log('videos p2p bust', videos.includes('chat-p2p-file.js?v=20260917blossom1'));
