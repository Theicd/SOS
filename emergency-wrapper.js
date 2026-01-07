// Emergency wrapper layer - adds P2P fallback without touching existing files
// Loaded after core scripts. It decorates App.pool.publish and SOSBridge handlers at runtime.
(function initEmergencyWrapper(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  let publishPatched = false;
  let bridgePatched = false;

  function log(msg) {
    console.log("[EmergencyWrapper] " + msg);
  }

  function shouldUseEmergency() {
    return App.AndroidBridge && App.AndroidBridge.shouldUseEmergencyNetwork && App.AndroidBridge.shouldUseEmergencyNetwork();
  }

  // Decorate App.pool.publish to also send via emergency P2P when relevant
  function patchPublish() {
    if (publishPatched) return;
    if (!App.pool || typeof App.pool.publish !== 'function') return;

    const originalPublish = App.pool.publish.bind(App.pool);
    App.pool.publish = async function(relays, event) {
      // Send to relays as usual
      const res = await originalPublish(relays, event);

      // Mirror to emergency network for relevant kinds
      try {
        if (shouldUseEmergency() && event && typeof App.AndroidBridge?.broadcast === 'function') {
          const kind = event.kind;
          // Basic filter: posts(1/5), chat(1050), signals(25050), reactions/comments(7)
          const shouldMirror = kind === 1 || kind === 5 || kind === 7 || kind === 1050 || kind === 25050;
          if (shouldMirror) {
            App.AndroidBridge.broadcast({
              type: kind === 1050 ? 'chat' : kind === 25050 ? 'webrtc_signal' : kind === 7 ? 'reaction' : 'post',
              event,
              timestamp: event.created_at,
            });
            log(`Mirrored kind ${kind} to emergency network`);
          }
        }
      } catch (e) {
        console.warn('[EmergencyWrapper] mirror failed:', e?.message || e);
      }
      return res;
    };

    publishPatched = true;
    log('App.pool.publish decorated for emergency mirror');
  }

  // Decorate SOSBridge handlers to capture reactions/comments
  function patchBridgeHandlers() {
    if (bridgePatched) return;
    if (!window.SOSBridge) return;

    const origOnMessage = window.SOSBridge.onMessage;
    window.SOSBridge.onMessage = function(fromIp, message) {
      try {
        if (message && message.type === 'reaction') {
          // Expect structure: { type: 'reaction', event: <nostr event> }
          if (App.registerLike) {
            App.registerLike(message.event?.tags?.[0]?.[1], message.event?.pubkey || fromIp);
          }
        } else if (message && message.type === 'comment') {
          if (App.handleNotificationForComment) {
            App.handleNotificationForComment(message);
          }
        }
      } catch (e) {
        console.warn('[EmergencyWrapper] onMessage handling failed:', e);
      }
      if (typeof origOnMessage === 'function') return origOnMessage(fromIp, message);
    };

    bridgePatched = true;
    log('SOSBridge.onMessage decorated for reactions/comments');
  }

  function bootstrap() {
    patchPublish();
    patchBridgeHandlers();
  }

  // Poll until App.pool and SOSBridge exist
  const interval = setInterval(() => {
    try {
      bootstrap();
      if (publishPatched && bridgePatched) clearInterval(interval);
    } catch (_) {}
  }, 500);

  // Safety stop after 30s
  setTimeout(() => clearInterval(interval), 30000);
})(window);
