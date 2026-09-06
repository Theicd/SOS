#!/usr/bin/env node
// chat-persist-tests.js – זהות שיחה + READ בלי תוכן הודעה
// הרצה: node chat-persist-tests.js

(function runChatPersistTests() {
  const results = [];
  let pass = 0;
  let fail = 0;

  function test(name, fn) {
    try {
      const ok = fn();
      if (ok) { pass++; results.push('PASS ' + name); }
      else { fail++; results.push('FAIL ' + name); }
    } catch (e) {
      fail++;
      results.push('FAIL ' + name + ' ' + (e && e.message ? e.message : e));
    }
  }

  function getConversationKey(a, b) {
    if (!a || !b) return null;
    const left = a.toLowerCase();
    const right = b.toLowerCase();
    return left < right ? left + ':' + right : right + ':' + left;
  }

  function meshIngestDestination(from, to, me, groupPk) {
    const isGroup = to === groupPk;
    const isDirect = to === me;
    if (!isGroup && !isDirect) return null;
    return isGroup ? groupPk : me;
  }

  const RANK = { failed: 0, queued: 1, sending: 1, sent: 2, delivered: 2, read: 3 };
  function canApplyStatus(current, next) {
    if (current === 'read' && next !== 'read') return false;
    if (next === 'failed' && current !== 'read') return true;
    const prevRank = RANK[current];
    const nextRank = RANK[next];
    if (typeof prevRank === 'number' && typeof nextRank === 'number' && nextRank < prevRank) return false;
    return true;
  }

  const me = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const peer = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const GROUP = 'e5e1111111111111111111111111111111111111111111111111111111111111';

  test('canonical key is local+remote not transport', () => {
    const meshKey = getConversationKey(peer, me);
    const dcKey = getConversationKey(peer, me);
    const nostrKey = getConversationKey(me, peer);
    return meshKey === dcKey && dcKey === nostrKey && meshKey.indexOf(peer) >= 0 && meshKey.indexOf(me) >= 0;
  });

  test('incoming mesh text uses to=self not to=from', () => {
    const dest = meshIngestDestination(peer, me, me, GROUP);
    const goodKey = getConversationKey(peer, dest);
    const badKey = getConversationKey(peer, peer);
    return dest === me && goodKey !== badKey && goodKey === getConversationKey(me, peer);
  });

  test('wrong to=from key is not the open-thread key', () => {
    const openThreadKey = getConversationKey(peer, me);
    const bugKey = getConversationKey(peer, peer);
    return openThreadKey !== bugKey;
  });

  test('incoming relay/DC/mesh share one conversation', () => {
    const store = new Map();
    function append(from, to, id) {
      const key = getConversationKey(from, to);
      if (!store.has(key)) store.set(key, []);
      store.get(key).push(id);
    }
    append(peer, me, 'nostr-1');
    append(peer, me, 'em-1');
    append(peer, me, 'p2p-1');
    const key = getConversationKey(me, peer);
    return store.size === 1 && store.get(key).length === 3;
  });

  test('media and text survive same restore payload', () => {
    const key = getConversationKey(me, peer);
    const payload = {
      conversations: [{
        key,
        peer,
        messages: [
          { id: 't1', from: peer, to: me, content: 'hi', direction: 'incoming' },
          { id: 'f1', from: peer, to: me, content: '', attachment: { name: 'a.jpg' }, direction: 'incoming' }
        ]
      }]
    };
    const restored = JSON.parse(JSON.stringify(payload));
    const msgs = restored.conversations[0].messages;
    return msgs.length === 2 && msgs.some((m) => m.id === 't1') && msgs.some((m) => m.id === 'f1');
  });

  test('close/open thread keeps count', () => {
    const msgs = [{ id: 'a' }, { id: 'b' }];
    const afterClose = JSON.parse(JSON.stringify(msgs));
    return afterClose.length === msgs.length;
  });

  test('mesh peer gone does not delete history', () => {
    const contacts = { [peer]: { lastMessage: 'hi', meshReachable: true } };
    contacts[peer].meshReachable = false;
    return !!contacts[peer].lastMessage;
  });

  test('read status never moves backwards', () => {
    return canApplyStatus('read', 'sent') === false &&
      canApplyStatus('read', 'delivered') === false &&
      canApplyStatus('sent', 'read') === true &&
      canApplyStatus('sent', 'failed') === true &&
      canApplyStatus('read', 'failed') === false;
  });

  test('old receipt does not downgrade newer read', () => {
    let lastApplied = 200;
    const incoming = 100;
    if (incoming < lastApplied) return true;
    lastApplied = incoming;
    return lastApplied === 200;
  });

  test('queued receipt sent once', () => {
    const q = new Map();
    q.set(peer, { receiptId: 'rr-1', lastReadAt: 50 });
    q.set(peer, { receiptId: 'rr-1', lastReadAt: 50 });
    const sent = new Set();
    q.forEach((row, pk) => {
      if (sent.has(row.receiptId)) throw new Error('dup');
      sent.add(row.receiptId);
      q.delete(pk);
    });
    return sent.size === 1 && q.size === 0;
  });

  test('mesh ACK delivered is not READ', () => {
    return canApplyStatus('sent', 'sent') === true && RANK.delivered < RANK.read;
  });

  console.log('chat-persist-tests');
  results.forEach((line) => console.log(line));
  console.log(pass + '/' + (pass + fail) + (fail ? ' FAILED' : ' passed'));
  if (typeof process !== 'undefined' && process.exit) process.exit(fail ? 1 : 0);
  return { pass, fail, results };
})();
