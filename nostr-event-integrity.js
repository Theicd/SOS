/**
 * Strict Nostr event integrity — hash(content fields) must equal event.id,
 * then signature must verify. Never trust Symbol(verified) cache alone.
 * HYPER CORE TECH — Stage 5E security hotfix
 */
(function initNostrEventIntegrity(root) {
  const App = root.NostrApp || (root.NostrApp = {});
  const NT = root.NostrTools;

  const HEX64 = /^[0-9a-f]{64}$/i;
  const HEX128 = /^[0-9a-f]{128}$/i;

  function reasonLog(kind, pubkey, code) {
    try {
      const k = kind != null ? String(kind) : '';
      const fp = typeof pubkey === 'string' ? pubkey.slice(0, 8) : '';
      console.warn('[SO-CALL SECURITY] rejected event reason=' + code + ' kind=' + k + ' pubkey=' + fp);
    } catch (_e) {}
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /** Build a clean host-realm event without Symbol(verified) or prototype junk. */
  function canonicalizeEvent(event) {
    if (!isPlainObject(event)) return null;
    if (typeof event.id !== 'string' || !HEX64.test(event.id)) return null;
    if (typeof event.pubkey !== 'string' || !HEX64.test(event.pubkey)) return null;
    if (typeof event.sig !== 'string' || !HEX128.test(event.sig)) return null;
    if (typeof event.kind !== 'number' || !Number.isFinite(event.kind) || !Number.isInteger(event.kind)) {
      return null;
    }
    if (typeof event.created_at !== 'number' || !Number.isFinite(event.created_at) || !Number.isInteger(event.created_at)) {
      return null;
    }
    if (typeof event.content !== 'string') return null;
    if (!Array.isArray(event.tags)) return null;
    let tags;
    try {
      tags = JSON.parse(JSON.stringify(event.tags));
    } catch (_e) {
      return null;
    }
    if (!Array.isArray(tags)) return null;
    return {
      id: event.id.toLowerCase(),
      pubkey: event.pubkey.toLowerCase(),
      created_at: event.created_at,
      kind: event.kind,
      tags,
      content: event.content,
      sig: event.sig.toLowerCase(),
    };
  }

  /**
   * strictVerifyNostrEvent(event) → boolean
   * A structural validation
   * B computedId = getEventHash(event)
   * C computedId === event.id
   * D verify signature (on clean object; ignores prior Symbol(verified))
   */
  function strictVerifyNostrEvent(event) {
    const tools = root.NostrTools || NT;
    if (!tools || typeof tools.getEventHash !== 'function' || typeof tools.verifyEvent !== 'function') {
      reasonLog(event && event.kind, event && event.pubkey, 'MALFORMED_EVENT');
      return false;
    }
    const clean = canonicalizeEvent(event);
    if (!clean) {
      reasonLog(event && event.kind, event && event.pubkey, 'MALFORMED_EVENT');
      return false;
    }
    let computedId;
    try {
      computedId = tools.getEventHash(clean);
    } catch (_e) {
      reasonLog(clean.kind, clean.pubkey, 'MALFORMED_EVENT');
      return false;
    }
    if (typeof computedId !== 'string' || !HEX64.test(computedId)) {
      reasonLog(clean.kind, clean.pubkey, 'MALFORMED_EVENT');
      return false;
    }
    if (computedId.toLowerCase() !== clean.id) {
      reasonLog(clean.kind, clean.pubkey, 'HASH_MISMATCH');
      return false;
    }
    let sigOk = false;
    try {
      // Fresh object: no Symbol(verified) from a prior verify-then-mutate attack.
      sigOk = tools.verifyEvent({
        id: clean.id,
        pubkey: clean.pubkey,
        created_at: clean.created_at,
        kind: clean.kind,
        tags: clean.tags,
        content: clean.content,
        sig: clean.sig,
      }) === true;
    } catch (_e2) {
      sigOk = false;
    }
    if (!sigOk) {
      reasonLog(clean.kind, clean.pubkey, 'INVALID_SIGNATURE');
      return false;
    }
    return true;
  }

  App.strictVerifyNostrEvent = strictVerifyNostrEvent;
  root.NostrEventIntegrity = {
    strictVerifyNostrEvent,
    canonicalizeEvent,
  };

  try {
    console.log('[NOSTR-INTEGRITY] strict verifier loaded');
  } catch (_e) {}
})(typeof window !== 'undefined' ? window : globalThis);
