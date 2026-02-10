// חלק בדיקות DataChannel (chat-p2p-datachannel-tests.js) – בדיקות קונסולה לוידוא תקינות | HYPER CORE TECH
// הרצה: העתק והדבק בקונסולת הדפדפן (F12 → Console)

(function runDCTests() {
  const App = window.NostrApp || {};
  const results = [];
  let pass = 0, fail = 0;

  function test(name, fn) {
    try {
      const ok = fn();
      if (ok) { pass++; results.push(`✅ ${name}`); }
      else    { fail++; results.push(`❌ ${name}`); }
    } catch (e) {
      fail++; results.push(`❌ ${name} — ERROR: ${e.message}`);
    }
  }

  // --- בדיקה 1: מודול נטען ---
  test('App.dataChannel קיים', () => !!App.dataChannel);

  // --- בדיקה 2: API מלא ---
  test('dataChannel.connect הוא function', () => typeof App.dataChannel?.connect === 'function');
  test('dataChannel.send הוא function', () => typeof App.dataChannel?.send === 'function');
  test('dataChannel.isConnected הוא function', () => typeof App.dataChannel?.isConnected === 'function');
  test('dataChannel.getStatus הוא function', () => typeof App.dataChannel?.getStatus === 'function');
  test('dataChannel.init הוא function', () => typeof App.dataChannel?.init === 'function');

  // --- בדיקה 3: getActiveChatPeer חשוף ---
  test('App.getActiveChatPeer קיים', () => typeof App.getActiveChatPeer === 'function');

  // --- בדיקה 4: isConnected מחזיר false ל-peer לא קיים ---
  test('isConnected(fake) → false', () => App.dataChannel?.isConnected('0000000000000000000000000000000000000000000000000000000000000000') === false);

  // --- בדיקה 5: getStatus מחזיר idle ל-peer לא קיים ---
  test('getStatus(fake) → idle', () => App.dataChannel?.getStatus('0000000000000000000000000000000000000000000000000000000000000000') === 'idle');

  // --- בדיקה 6: send מחזיר false ל-peer לא מחובר ---
  test('send(fake) → false', () => {
    const r = App.dataChannel?.send('0000000000000000000000000000000000000000000000000000000000000000', { id: 'test', content: 'hi', createdAt: 0 });
    return r === false;
  });

  // --- בדיקה 7: peers map קיים ---
  test('_peers Map קיים', () => App.dataChannel?._peers instanceof Map);

  // --- בדיקה 8: publishChatMessage עדיין עובד ---
  test('App.publishChatMessage קיים', () => typeof App.publishChatMessage === 'function');

  // --- בדיקה 9: appendChatMessage עדיין עובד ---
  test('App.appendChatMessage קיים', () => typeof App.appendChatMessage === 'function');

  // --- בדיקה 10: WebRTC זמין ---
  test('RTCPeerConnection זמין', () => typeof RTCPeerConnection === 'function');

  // --- בדיקה 11: אינטגרציה - P2P path ב-publishChatMessage ---
  test('publishChatMessage תומך ב-P2P path', () => {
    // וידוא שהקוד החדש נטען - בדיקה שה-function קיים ומכיל את הלוגיקה
    const src = App.publishChatMessage?.toString?.() || '';
    return src.includes('dataChannel') || src.includes('p2p');
  });

  // --- סיכום ---
  console.log('%c═══ DC Tests ═══', 'color: cyan; font-size: 14px; font-weight: bold;');
  results.forEach(r => console.log(r));
  const summary = `\n${pass}/${pass + fail} passed`;
  if (fail === 0) {
    console.log(`%c${summary} ✅ ALL GOOD`, 'color: lime; font-size: 13px; font-weight: bold;');
  } else {
    console.log(`%c${summary} ⚠️ ${fail} FAILED`, 'color: red; font-size: 13px; font-weight: bold;');
  }

  return { pass, fail, results };
})();
