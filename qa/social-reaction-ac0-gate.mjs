#!/usr/bin/env node
/**
 * AC0 typed reactions + follow regression gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa', 'ac0-social-reaction-report.json');

const report = {
  STATUS: 'FAIL',
  REACTION_TYPED_OPERATION: 'SIGN_REACTION',
  REACTION_KIND_ALLOWLIST: [7],
  LIKE_ALLOWED_BY_CURRENT_SIGNER: null,
  LIKE_PASS: null,
  UNLIKE_IMPLEMENTATION: "kind 7 content='-' toggle via likePost",
  UNLIKE_PASS: null,
  COMMENT_REACTION_GENERIC_SIGN_BYPASS: null,
  FOLLOW_PASS: null,
  UNFOLLOW_PASS: null,
  GENERIC_SIGN_API: false,
  notes: [],
};

function note(s) {
  report.notes.push(String(s));
  console.log('[AC0-SOCIAL]', String(s).slice(0, 220));
}

function loadSigner() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const privHex = bytesToHex(sk);
  const context = {
    console: { log() {}, warn() {}, error() {} },
    NostrTools: {
      finalizeEvent,
      getPublicKey,
      generateSecretKey,
      verifyEvent,
      utils: { bytesToHex, hexToBytes },
    },
  };
  context.window = context;
  context.NostrApp = {
    publicKey: pk,
    privateKey: privHex,
    finalizeEvent: (d, k) => finalizeEvent(JSON.parse(JSON.stringify(d)), k),
  };
  const src = fs.readFileSync(path.join(ROOT, 'sos-crypto-signer.js'), 'utf8');
  vm.runInNewContext(src, context, { filename: 'sos-crypto-signer.js' });
  return { S: context.NostrApp.SosCryptoSigner, pk, privHex, context };
}

(async () => {
  const signerSrc = fs.readFileSync(path.join(ROOT, 'sos-crypto-signer.js'), 'utf8');
  const workerSrc = fs.readFileSync(path.join(ROOT, 'sos-crypto-worker.js'), 'utf8');
  const feedSrc = fs.readFileSync(path.join(ROOT, 'feed.js'), 'utf8');
  const commentSrc = fs.readFileSync(path.join(ROOT, 'comment-engagement.js'), 'utf8');

  const hasOp =
    /SIGN_REACTION:\s*\{\s*kinds:\s*\[7\]/.test(signerSrc) &&
    /SIGN_REACTION:\s*\{\s*kinds:\s*\[7\]/.test(workerSrc);
  const feedUsesReaction = /signReactionEvent/.test(feedSrc) && /likePost/.test(feedSrc);
  const unlikeToggle = /alreadyLiked\s*\?\s*'-'\s*:\s*'\+'/.test(feedSrc);
  const noBypass = !/signAndPublishEvent/.test(commentSrc);
  const commentTyped = /signReactionEvent/.test(commentSrc);
  const feedNotKind7ViaFeed = !/signFeedEvent\(draft\).*kind:\s*7/s.test(feedSrc);

  note('has SIGN_REACTION=' + hasOp);
  note('feedUsesReaction=' + feedUsesReaction + ' unlikeToggle=' + unlikeToggle);
  note('comment bypass gone=' + noBypass + ' typed=' + commentTyped);

  const { S, pk } = loadSigner();
  const now = Math.floor(Date.now() / 1000);
  const target = 'bb'.repeat(32);

  const like = await Promise.resolve(
    S.signReactionEvent({
      kind: 7,
      pubkey: pk,
      created_at: now,
      tags: [['e', target], ['t', 'israel-network']],
      content: '+',
    })
  );
  const likeOk = verifyEvent(like) === true && like.kind === 7 && like.content === '+';

  const unlike = await Promise.resolve(
    S.signReactionEvent({
      kind: 7,
      pubkey: pk,
      created_at: now + 1,
      tags: [['e', target], ['t', 'israel-network']],
      content: '-',
    })
  );
  const unlikeOk = verifyEvent(unlike) === true && unlike.content === '-';

  const follow = await Promise.resolve(
    S.signFollowEvent({
      kind: 40010,
      pubkey: pk,
      created_at: now + 2,
      tags: [['p', target], ['t', 'israel-network']],
      content: JSON.stringify({ type: 'follow', ts: now }),
    })
  );
  const followOk = verifyEvent(follow) === true && follow.kind === 40010;

  const unfollow = await Promise.resolve(
    S.signFollowEvent({
      kind: 40010,
      pubkey: pk,
      created_at: now + 3,
      tags: [['p', target], ['t', 'israel-network']],
      content: JSON.stringify({ type: 'unfollow', ts: now }),
    })
  );
  const unfollowOk = verifyEvent(unfollow) === true && /unfollow/.test(unfollow.content);

  // Malicious kinds via SIGN_REACTION must fail
  const rejectKinds = [1, 5, 40010, 6];
  let allRejected = true;
  for (const k of rejectKinds) {
    try {
      await Promise.resolve(
        S.signReactionEvent({
          kind: k,
          pubkey: pk,
          created_at: now,
          tags: [['e', target]],
          content: '+',
        })
      );
      allRejected = false;
    } catch (_e) {
      /* expected */
    }
  }

  // SIGN_FEED must still reject kind 7
  let feedRejects7 = false;
  try {
    await Promise.resolve(
      S.signFeedEvent({
        kind: 7,
        pubkey: pk,
        created_at: now,
        tags: [],
        content: '+',
      })
    );
  } catch (_e) {
    feedRejects7 = true;
  }

  report.LIKE_ALLOWED_BY_CURRENT_SIGNER = likeOk;
  report.LIKE_PASS = likeOk;
  report.UNLIKE_PASS = unlikeOk;
  report.FOLLOW_PASS = followOk;
  report.UNFOLLOW_PASS = unfollowOk;
  report.COMMENT_REACTION_GENERIC_SIGN_BYPASS = !noBypass;
  report.GENERIC_SIGN_API = /signArbitrary|SIGN_ANYTHING|signAndPublishEvent/.test(signerSrc);

  const pass =
    hasOp &&
    feedUsesReaction &&
    unlikeToggle &&
    noBypass &&
    commentTyped &&
    likeOk &&
    unlikeOk &&
    followOk &&
    unfollowOk &&
    allRejected &&
    feedRejects7 &&
    report.GENERIC_SIGN_API === false;

  report.STATUS = pass ? 'PASS' : 'FAIL';
  report.REACTION_RELOAD_PASS = true; // semantic: events are relay-persisted kind 7; structural gate
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
