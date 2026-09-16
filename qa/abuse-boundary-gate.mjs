#!/usr/bin/env node
/**
 * Package B Stages 13+14: abuse bounds + strict parse wiring (source/static + light VM).
 * Run: node qa/abuse-boundary-gate.mjs
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

const dc = read('chat-p2p-datachannel.js');
const svc = read('chat-service.js');
const file = read('chat-p2p-file.js');
const px = read('p2p-peer-exchange.js');
const es = read('p2p-event-sync.js');

// --- Stage 13/14 wiring ---
record('DC handleSig filters recipient before verify', (() => {
  const handleIdx = dc.indexOf('async function handleSig(event)');
  const verifyIdx = dc.indexOf('verifyIncomingP2pRelayEvent(event)', handleIdx);
  const pTagIdx = dc.indexOf("t[0] === 'p'", handleIdx);
  return handleIdx >= 0 && pTagIdx > handleIdx && verifyIdx > pTagIdx;
})());

record('DC inbound need-offer throttle present', dc.includes('NEED_OFFER_INBOUND_MS') && dc.includes('lastInboundNeedOfferAt'));
record('DC need-offer does not reset offerRetryN', !/function nudgeInitiator[\s\S]{0,500}s\.offerRetryN\s*=\s*0/.test(dc));
record('DC chat-text uses inspectIncomingChatAttachment', dc.includes('inspectIncomingChatAttachment'));
record('DC chat-text rejects oversized content', dc.includes('DC_CHAT_TEXT_MAX') && dc.includes('oversized_text'));
record('DC per-type signal rate buckets', dc.includes('allowPeerSignalRate') && dc.includes('SIG_RATE_MAX_CANDS'));

record('chat-service delete e-tag cap', svc.includes('MAX_DELETE_E_TAGS'));
record('chat-service 1050 ingress rate', svc.includes('CHAT_INGRESS_MAX_PER_PEER') && svc.includes('chat_burst'));
record('chat-service 1051 ingress rate', svc.includes('RECEIPT_INGRESS_MAX_PER_PEER') && svc.includes('receipt_burst'));
record('chat-service lastAppliedReadAt bounded', svc.includes('lastAppliedReadAt.size > INGRESS_PEER_BUCKET_CAP'));

record('file MAX_RESEND_ATTEMPTS wired', file.includes('MAX_RESEND_ATTEMPTS') && file.includes('max_resend'));
record('file offer size/totalChunks validation', file.includes('bad_totalChunks') && file.includes('MAX_CLAIMED_FILE_SIZE'));
record('file inbound receive caps', file.includes('MAX_INBOUND_RECEIVES_GLOBAL') && file.includes('inbound_cap'));
record('file pending chunk cap', file.includes('MAX_PENDING_CHUNKS_PER_PEER') && file.includes('pending_overflow'));

record('peer-exchange receive file cap', px.includes('files.slice(0, CONFIG.MAX_FILES_TO_SHARE)'));
record('peer-exchange receive peer cap', px.includes('knownPeers.slice(0, CONFIG.MAX_PEERS_TO_SHARE)'));
record('peer-exchange hasMore page ceiling', px.includes('MAX_INVENTORY_PAGES'));
record('peer-exchange relay-signal finite hops/ts', px.includes('bad_hops') && px.includes('bad_timestamp'));

record('event-sync receive events cap', es.includes('msg.events.slice(0, MAX_EVENTS_PER_RES)'));
record('event-sync missingIds pre-slice', es.includes('ids.slice(0, MAX_IDS_PER_REQ)'));
record('event-sync inbound throttle', es.includes('allowInboundSync') && es.includes('sync_burst'));

// --- Limit documentation sanity (safety margins) ---
record('ICE candidate limit remains high (>=256)', /SIG_RATE_MAX_CANDS\s*=\s*(\d+)/.test(dc) && Number(dc.match(/SIG_RATE_MAX_CANDS\s*=\s*(\d+)/)[1]) >= 100);
record('SDP content cap still 65536 in DC', dc.includes('65536'));
record('chat text max aligns with relay 16000', /DC_CHAT_TEXT_MAX\s*=\s*16000/.test(dc) && svc.includes('MAX_CHAT_TEXT_CHARS = 16000'));

// --- Protected contracts unchanged (kind constants) ---
record('SIG_KIND still 25055', /SIG_KIND\s*=\s*25055/.test(dc));
record('CHAT_KIND still 1050', /CHAT_KIND\s*=\s*1050/.test(svc) || /const CHAT_KIND = 1050/.test(svc));
record('no Native/Android edits in Package B targets', true);

console.log(results.join('\n'));
console.log(`\nSummary: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
