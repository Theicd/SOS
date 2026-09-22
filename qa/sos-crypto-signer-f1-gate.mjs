#!/usr/bin/env node
/**
 * F1 SosCryptoSigner facade equivalence + inventory gate.
 * Run: node qa/sos-crypto-signer-f1-gate.mjs
 *
 * Note: nostr-tools finalizeEvent signatures are non-deterministic here;
 * equivalence = same event id + verifyEvent(true), not equal sig bytes.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
  nip44,
  nip04,
} from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let pass = 0;
let fail = 0;
function record(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push('PASS ' + name + (detail ? ' — ' + detail : ''));
  } else {
    fail += 1;
    results.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

function equivSigned(via, legacy) {
  return !!(
    via &&
    legacy &&
    via.id === legacy.id &&
    via.pubkey === legacy.pubkey &&
    via.kind === legacy.kind &&
    via.content === legacy.content &&
    verifyEvent(via) === true &&
    verifyEvent(legacy) === true
  );
}

function loadFacade() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const privHex = typeof sk === 'string' ? sk : bytesToHex(sk);
  const NT = {
    finalizeEvent,
    getEventHash,
    verifyEvent,
    generateSecretKey,
    getPublicKey,
    nip44,
    nip04,
    utils: {
      bytesToHex,
      hexToBytes,
    },
  };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    NostrTools: NT,
  };
  context.window = context;
  context.NostrApp = {
    publicKey: pk,
    privateKey: privHex,
    finalizeEvent: (draft, key) => finalizeEvent(JSON.parse(JSON.stringify(draft)), key),
    hexToBytes,
    inspectIncomingChatAttachment: () => ({ ok: true }),
    verifyIncomingChatAttachment: () => true,
  };

  // Host-realm chat-e2ee so noble/nip44 accept Uint8Array (same as e2ee-foundation-gate).
  const hostApp = {
    inspectIncomingChatAttachment: () => ({ ok: true }),
    verifyIncomingChatAttachment: () => true,
    hexToBytes,
  };
  globalThis.NostrApp = hostApp;
  globalThis.NostrTools = NT;
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'chat-e2ee.js'), 'utf8'), {
    filename: 'chat-e2ee.js',
  });
  context.NostrApp.encryptPrivateChatPayload = hostApp.encryptPrivateChatPayload.bind(hostApp);
  context.NostrApp.decryptPrivateChatPayload = hostApp.decryptPrivateChatPayload.bind(hostApp);

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'sos-crypto-signer.js'), 'utf8'), context, {
    filename: 'sos-crypto-signer.js',
  });
  return { context, sk, pk, privHex, S: context.NostrApp.SosCryptoSigner };
}

function main() {
  const src = fs.readFileSync(path.join(ROOT, 'sos-crypto-signer.js'), 'utf8');
  // Public API surface only (strip block comments)
  const apiSurface = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  record('GENERIC_SIGN_API=false', !/signAnything|signRaw\s*\(/.test(apiSurface));
  record('GENERIC_DECRYPT_API=false', !/decryptAnything/.test(apiSurface));
  record('RAW_KEY_GETTER=false', !/\bgetPrivateKey\b|\breadPrivateKey\b|\bexportRawKey\b/.test(apiSurface));
  record('facade file exists', fs.existsSync(path.join(ROOT, 'sos-crypto-signer.js')));

  const loaded = loadFacade();
  const S = loaded.S;
  const pk = loaded.pk;
  const privHex = loaded.privHex;
  const facadeApp = loaded.context.NostrApp;
  record('hasIdentityKey', S.hasIdentityKey() === true);

  const now = Math.floor(Date.now() / 1000);
  const chatDraft = {
    kind: 1050,
    pubkey: pk,
    created_at: now,
    tags: [
      ['p', pk],
      ['t', 'yalachat'],
    ],
    content: 'hello-facade',
  };
  const legacy = finalizeEvent(JSON.parse(JSON.stringify(chatDraft)), privHex);
  const via = S.signChatEvent(JSON.parse(JSON.stringify(chatDraft)));
  record('chat sign equivalence', equivSigned(via, legacy));

  const profileDraft = { kind: 0, pubkey: pk, created_at: now, tags: [['t', 'sos']], content: '{}' };
  const pLegacy = finalizeEvent(JSON.parse(JSON.stringify(profileDraft)), privHex);
  const pVia = S.signProfileEvent(JSON.parse(JSON.stringify(profileDraft)));
  record('profile sign equivalence', equivSigned(pVia, pLegacy));

  const p2pDraft = {
    kind: 25055,
    pubkey: pk,
    created_at: now,
    tags: [
      ['p', pk],
      ['type', 'dc-offer'],
    ],
    content: 'enc',
  };
  const sLegacy = finalizeEvent(JSON.parse(JSON.stringify(p2pDraft)), privHex);
  const sVia = S.signP2pSignal(JSON.parse(JSON.stringify(p2pDraft)));
  record('p2p 25055 sign equivalence', equivSigned(sVia, sLegacy));

  const fileDraft = {
    kind: 30078,
    pubkey: pk,
    created_at: now,
    tags: [
      ['p', pk],
      ['d', 'x'],
    ],
    content: 'offer',
  };
  const fLegacy = finalizeEvent(JSON.parse(JSON.stringify(fileDraft)), privHex);
  const fVia = S.signP2pFile(JSON.parse(JSON.stringify(fileDraft)));
  record('p2p 30078 sign equivalence', equivSigned(fVia, fLegacy));

  const sealDraft = { kind: 13, pubkey: pk, created_at: now, tags: [], content: 'seal-ct' };
  const sealLegacy = finalizeEvent(JSON.parse(JSON.stringify(sealDraft)), privHex);
  const sealVia = S.signCallSeal(JSON.parse(JSON.stringify(sealDraft)));
  record('call seal 13 sign equivalence', equivSigned(sealVia, sealLegacy));

  const giftDraft = {
    kind: 1059,
    pubkey: pk,
    created_at: now,
    tags: [['p', pk]],
    content: 'gw',
  };
  const gLegacy = finalizeEvent(JSON.parse(JSON.stringify(giftDraft)), privHex);
  const gVia = S.signCallGiftwrap(JSON.parse(JSON.stringify(giftDraft)));
  record('call giftwrap 1059 sign equivalence', equivSigned(gVia, gLegacy));

  const peerSk = generateSecretKey();
  const peerPk = getPublicKey(peerSk);
  const plain = 'nip04-qa';
  Promise.resolve()
    .then(async () => {
      const a = await nip04.encrypt(privHex, peerPk, plain);
      const b = await S.nip04Encrypt(peerPk, plain);
      const da = await nip04.decrypt(privHex, peerPk, a);
      const db = await S.nip04Decrypt(peerPk, b);
      record('nip04 encrypt/decrypt roundtrip', da === plain && db === plain);

      const selfCt = S.nip44P2pEncrypt('self-plain', pk);
      const selfBack = S.nip44P2pDecrypt(selfCt, pk);
      record('nip44 p2p self roundtrip', selfBack === 'self-plain' && typeof selfCt === 'string' && selfCt.length > 0);

      const callCt = S.nip44CallEncryptJson({ a: 1 }, pk);
      const callBack = JSON.parse(S.nip44CallDecryptToString(callCt, pk));
      record('nip44 call json roundtrip', callBack && callBack.a === 1);

      const wrapped = S.fileKeyWrap('AES_KEY_MATERIAL', pk);
      const unwrapped = S.fileKeyUnwrap(wrapped, pk);
      record('file-key wrap/unwrap', unwrapped === 'AES_KEY_MATERIAL');

      try {
        const env = S.nip44ChatEncrypt({
          senderPubkey: pk,
          recipientPubkey: peerPk,
          payload: {
            messageId: 'm1',
            sender: pk,
            recipient: peerPk,
            createdAt: now,
            text: 'chat-hi',
            attachment: null,
          },
        });
        record(
          'nip44 chat encrypt envelope',
          env && env.family === 'sos-e2ee' && typeof env.ct === 'string' && env.ct.length > 0,
        );
        const prevPk = facadeApp.publicKey;
        const prevSk = facadeApp.privateKey;
        facadeApp.publicKey = peerPk;
        facadeApp.privateKey = bytesToHex(peerSk);
        let inner = null;
        try {
          inner = S.nip44ChatDecrypt({
            localPubkey: peerPk,
            eventAuthorPubkey: pk,
            encryptedEnvelope: env,
            selfAuthored: false,
          });
        } finally {
          facadeApp.publicKey = prevPk;
          facadeApp.privateKey = prevSk;
        }
        record('nip44 chat decrypt roundtrip', !!(inner && inner.text === 'chat-hi'));
      } catch (e) {
        record('nip44 chat path', false, String(e && e.message));
      }

      let rejected = false;
      try {
        S.signChatEvent({ ...chatDraft, kind: 1 });
      } catch (_e) {
        rejected = true;
      }
      record('rejects wrong kind for SIGN_CHAT_EVENT', rejected === true);

      const N = 1000;
      const drafts = [];
      for (let i = 0; i < N; i++) {
        drafts.push({
          kind: 1050,
          pubkey: pk,
          created_at: now,
          tags: [
            ['p', pk],
            ['t', 'yalachat'],
          ],
          content: 'perf-' + i,
        });
      }
      const t0 = Date.now();
      for (let i = 0; i < N; i++) finalizeEvent(JSON.parse(JSON.stringify(drafts[i])), privHex);
      const legacyMs = Date.now() - t0;
      const t1 = Date.now();
      for (let i = 0; i < N; i++) S.signChatEvent(JSON.parse(JSON.stringify(drafts[i])));
      const facadeMs = Date.now() - t1;
      const overhead = facadeMs - legacyMs;
      record('1000 sign facade overhead ms', true, 'legacy=' + legacyMs + ' facade=' + facadeMs + ' delta=' + overhead);

      const et0 = Date.now();
      for (let i = 0; i < N; i++) {
        // eslint-disable-next-line no-await-in-loop
        await nip04.encrypt(privHex, peerPk, 'x' + i);
      }
      const encLegacy = Date.now() - et0;
      const et1 = Date.now();
      for (let i = 0; i < N; i++) {
        // eslint-disable-next-line no-await-in-loop
        await S.nip04Encrypt(peerPk, 'x' + i);
      }
      const encFacade = Date.now() - et1;
      record(
        '1000 nip04 encrypt overhead ms',
        true,
        'legacy=' + encLegacy + ' facade=' + encFacade + ' delta=' + (encFacade - encLegacy),
      );

      const featureFiles = [
        'chat-service.js',
        'profile.js',
        'feed.js',
        'compose.js',
        'follow-service.js',
        'invite-service.js',
        'blossom.js',
        'dating.js',
        'game-trivia.js',
        'live-stream.js',
        'live-stream-ui.js',
        'live-tv/live-tv-catalog.js',
        'media-recheck.js',
        'chat-presence.js',
        'chat-p2p-datachannel.js',
        'p2p-video-sharing.js',
        'chat-p2p-secure-v2.js',
        'chat-voice-call.js',
        'chat-video-call.js',
        'chat-voice-call-ui.js',
        'chat-video-call-ui.js',
        'chat-e2ee-wrapper.js',
        'call-signal-e2ee.js',
      ];
      let featureK = 0;
      const offenders = [];
      for (const f of featureFiles) {
        const body = fs.readFileSync(path.join(ROOT, f), 'utf8');
        const count = (body.match(/App\.privateKey/g) || []).length;
        if (count) {
          featureK += count;
          offenders.push(f + ':' + count);
        }
      }
      record('DIRECT_FEATURE_MODULE_K_CONSUMERS=0', featureK === 0, offenders.join(',') || 'none');

      console.log(results.join('\n'));
      console.log(fail === 0 ? 'OVERALL PASS' : 'OVERALL FAIL');
      console.log(
        JSON.stringify(
          {
            FACADE_EQUIVALENCE_PASS: fail === 0,
            FACADE_SIGN_OVERHEAD_MS: overhead,
            FACADE_CRYPTO_OVERHEAD_MS: encFacade - encLegacy,
            DIRECT_FEATURE_MODULE_K_CONSUMERS: featureK,
          },
          null,
          2,
        ),
      );
      process.exit(fail === 0 ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

main();
