/* __F2B_AWAIT_WRAPPED__ */
// מנגנון הזמנות הצטרפות בוואטסאפ (invite-service.js) | HYPER CORE TECH
// AC3: when SOS_ACCESS_CONTROL_V2 is enabled, InvitePolicy enforces create/redeem/revoke.
(function initInviteService(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  function policy() {
    return App.InvitePolicy || window.SosInvitePolicy || null;
  }

  function normalizePhone(phone) {
    const digits = String(phone || '').replace(/\D+/g, '');
    if (!digits) return '';
    if (digits.length === 10 && digits.startsWith('0')) {
      return '972' + digits.slice(1);
    }
    if (digits.length === 9 && digits.startsWith('5')) {
      return '972' + digits;
    }
    return digits;
  }

  function isValidPhone(phone) {
    const normalized = normalizePhone(phone);
    return normalized.length >= 9 && normalized.length <= 15;
  }

  async function hashValue(value) {
    const normalized = String(value || '').trim().toLowerCase();
    const data = new TextEncoder().encode(normalized);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async function hashPhone(phone) {
    return hashValue(normalizePhone(phone));
  }

  function generateInviteCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  }

  function getInviteCodeFromLocation() {
    try {
      const params = new URLSearchParams(window.location.search || '');
      const fromQuery = (params.get('invite') || '').trim().toUpperCase();
      if (fromQuery) return fromQuery;
      const hash = String(window.location.hash || '');
      const match = hash.match(/invite=([A-Z0-9]+)/i);
      return match ? match[1].toUpperCase() : '';
    } catch (_) {
      return '';
    }
  }

  function buildInviteUrl(code) {
    try {
      const origin = window.location.origin || '';
      const pathname = window.location.pathname || '/';
      const segments = pathname.split('/').filter(Boolean);
      const isGithubProject = /\.github\.io$/i.test(window.location.hostname || '');
      const repoSegment = isGithubProject ? segments[0] || '' : '';
      const basePath = repoSegment ? `/${repoSegment}/` : '/';
      const url = new URL(`${origin}${basePath}videos.html`);
      url.searchParams.set('invite', String(code || '').toUpperCase());
      return url.toString();
    } catch (_) {
      return (
        (window.location.origin || '') +
        '/videos.html?invite=' +
        encodeURIComponent(String(code || '').toUpperCase())
      );
    }
  }

  async function queryEvents(filter) {
    if (!App.pool || !Array.isArray(App.relayUrls) || App.relayUrls.length === 0) {
      throw new Error('אין חיבור לריליים');
    }
    if (typeof App.pool.querySync === 'function') {
      const res = await App.pool.querySync(App.relayUrls, filter);
      return Array.isArray(res) ? res : [];
    }
    if (typeof App.pool.list === 'function') {
      const res = await App.pool.list(App.relayUrls, [filter]);
      return Array.isArray(res) ? res : [];
    }
    if (typeof App.pool.get === 'function') {
      const one = await App.pool.get(App.relayUrls, filter);
      return one ? [one] : [];
    }
    throw new Error('שיטת שאילתה לריליים לא זמינה');
  }

  function isV2() {
    const P = policy();
    return !!(P && P.isV2 && P.isV2());
  }

  async function findInviteEvent(code) {
    const normalized = String(code || '').trim().toUpperCase();
    if (isV2()) {
      const P = policy();
      const ih = P && typeof P.sha256Hex === 'function' ? await P.sha256Hex(normalized) : await hashValue(normalized);
      const filter = {
        kinds: [App.INVITE_KIND || 37378],
        limit: 10,
      };
      filter['#ih'] = [ih];
      if (App.NETWORK_TAG) filter['#t'] = [App.NETWORK_TAG];
      let events = await queryEvents(filter);
      // Legacy fallback during migration: also try plaintext #i
      if (!events.length) {
        const legacy = {
          kinds: [App.INVITE_KIND || 37378],
          limit: 5,
        };
        legacy['#' + (App.INVITE_CODE_TAG || 'i')] = [normalized];
        events = await queryEvents(legacy);
      }
      if (!events.length) return null;
      events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      return events[0];
    }
    const codeTag = App.INVITE_CODE_TAG || 'i';
    const filter = {
      kinds: [App.INVITE_KIND || 37378],
      limit: 5,
    };
    filter['#' + codeTag] = [normalized];
    const events = await queryEvents(filter);
    if (!events.length) return null;
    events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return events[0];
  }

  async function findRevokeForInvite(inviteEvent) {
    if (!inviteEvent || !inviteEvent.id) return null;
    const filter = {
      kinds: [37380],
      limit: 5,
    };
    filter['#d'] = [String(inviteEvent.id).toLowerCase()];
    const events = await queryEvents(filter);
    if (!events.length) return null;
    events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return events[0];
  }

  async function isInviteUsed(code, inviteEvent) {
    const normalized = String(code || '').trim().toUpperCase();
    if (isV2() && inviteEvent && inviteEvent.id) {
      const filter = {
        kinds: [App.INVITE_USED_KIND || 37379],
        limit: 20,
      };
      filter['#e'] = [String(inviteEvent.id).toLowerCase()];
      const events = await queryEvents(filter);
      const P = policy();
      const ih = P ? await P.sha256Hex(normalized) : '';
      for (let i = 0; i < events.length; i++) {
        const check = P
          ? P.validateUsedEvent(events[i], inviteEvent, ih)
          : { ok: true };
        if (check.ok) return true;
      }
      return false;
    }
    const codeTag = App.INVITE_CODE_TAG || 'i';
    const filter = {
      kinds: [App.INVITE_USED_KIND || 37379],
      limit: 5,
    };
    filter['#' + codeTag] = [normalized];
    const events = await queryEvents(filter);
    return events.length > 0;
  }

  function readInvitePhoneHash(event) {
    if (!event || !Array.isArray(event.tags)) return '';
    const phoneTag = App.INVITE_PHONE_TAG || 'ph';
    const row = event.tags.find((t) => Array.isArray(t) && t[0] === phoneTag && t[1]);
    return row ? String(row[1]) : '';
  }

  function readInviteExpiry(event) {
    if (!event || !Array.isArray(event.tags)) return 0;
    const row = event.tags.find((t) => Array.isArray(t) && t[0] === 'expiration' && t[1]);
    const n = Number(row && row[1]);
    return Number.isFinite(n) ? n : 0;
  }

  async function validateInvite({ code, phone }) {
    const normalizedCode = String(code || '').trim().toUpperCase();
    if (!normalizedCode || normalizedCode.length < 6) {
      return { ok: false, error: 'קוד הזמנה לא תקין' };
    }

    const MS = App.MembershipState || window.SosMembershipState;
    if (MS && typeof MS.isV2 === 'function' && MS.isV2() && App.publicKey) {
      if (typeof MS.ensureCache === 'function') MS.ensureCache();
      const gated = MS.canPerformMemberAction(App.publicKey, 'invite_redeem');
      if (!gated.ok) {
        return { ok: false, error: 'אין הרשאת חברות למימוש הזמנה', code: gated.code };
      }
    }

    let inviteEvent;
    try {
      inviteEvent = await findInviteEvent(normalizedCode);
    } catch (err) {
      return { ok: false, error: 'לא ניתן לבדוק הזמנה כרגע. נסו שוב בעוד רגע.' };
    }
    if (!inviteEvent) {
      return { ok: false, error: 'קוד ההזמנה לא נמצא ברשת' };
    }

    const P = policy();
    if (isV2() && P) {
      const auth = P.canRedeemInvite(inviteEvent, null, {});
      if (!auth.ok) {
        return { ok: false, error: 'ההזמנה אינה מורשית לפי מדיניות הרשת', code: auth.code };
      }
      try {
        const revokeEv = await findRevokeForInvite(inviteEvent);
        if (revokeEv) {
          const rev = P.validateRevokeEvent(revokeEv, inviteEvent, null);
          if (rev.ok) {
            return { ok: false, error: 'ההזמנה בוטלה', code: 'REVOKED' };
          }
        }
      } catch (_e) {}
    }

    const expiry = readInviteExpiry(inviteEvent);
    if (expiry && expiry < Math.floor(Date.now() / 1000)) {
      return { ok: false, error: 'תוקף ההזמנה פג. בקשו הזמנה חדשה.' };
    }

    let used = false;
    try {
      used = await isInviteUsed(normalizedCode, inviteEvent);
    } catch (err) {
      return { ok: false, error: 'לא ניתן לוודא שההזמנה פנויה. נסו שוב.' };
    }
    if (used) {
      return { ok: false, error: 'ההזמנה כבר נוצלה' };
    }
    if (isV2() && P && typeof P.isLocallyRedeemed === 'function' && P.isLocallyRedeemed(inviteEvent.id)) {
      return { ok: false, error: 'ההזמנה כבר נוצלה', code: 'DOUBLE_REDEEM' };
    }

    const expectedPhoneHash = readInvitePhoneHash(inviteEvent);
    let phoneHash = '';
    if (expectedPhoneHash) {
      if (!isValidPhone(phone)) {
        return { ok: false, error: 'הזמנה ישנה דורשת מספר טלפון תואם' };
      }
      phoneHash = await hashPhone(phone);
      if (phoneHash !== expectedPhoneHash) {
        return { ok: false, error: 'מספר הטלפון לא תואם להזמנה שנשלחה' };
      }
    }

    if (P && typeof P.setRedeemSession === 'function') {
      const ih = P.sha256Hex ? await P.sha256Hex(normalizedCode) : '';
      P.setRedeemSession({
        code: normalizedCode,
        inviteEventId: inviteEvent.id,
        ih,
      });
    }

    return {
      ok: true,
      code: normalizedCode,
      inviteEvent,
      inviterPubkey: inviteEvent.pubkey || '',
      phoneHash,
    };
  }

  async function createInvite() {
    if (!App.SosCryptoSigner?.hasIdentityKey() || App.guestMode) {
      throw new Error('רק משתמש מחובר יכול להזמין');
    }
    if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) {
      throw new Error('אין חיבור לריליים');
    }

    const MS = App.MembershipState || window.SosMembershipState;
    if (MS && typeof MS.isV2 === 'function' && MS.isV2()) {
      if (typeof MS.ensureCache === 'function') MS.ensureCache();
      const gated = MS.canPerformMemberAction(App.publicKey, 'invite_create');
      if (!gated.ok) {
        throw new Error('אין הרשאת חברות ליצירת הזמנה');
      }
    }

    const P = policy();
    if (P) {
      const auth = P.canCreateInvite(App.publicKey, null, {});
      if (!auth.ok) {
        throw new Error('אין הרשאה ליצור הזמנה');
      }
    } else if (App.guestMode) {
      throw new Error('רק משתמש מחובר יכול להזמין');
    }

    const code = generateInviteCode();
    const now = Math.floor(Date.now() / 1000);
    const ttl = Number(App.INVITE_TTL_SECONDS) || 7 * 24 * 60 * 60;
    const codeTag = App.INVITE_CODE_TAG || 'i';
    const tags = [
      ['t', App.INVITE_TAG || 'sos-invite'],
      ['expiration', String(now + ttl)],
    ];
    const CC = App.CommunityContext || window.SosCommunityContext;
    const snap = CC && typeof CC.snapshot === 'function' ? CC.snapshot() : null;
    const bindNetworkTag =
      (snap && snap.networkTag) ||
      (typeof App.NETWORK_TAG === 'string' ? App.NETWORK_TAG : '') ||
      '';
    if (bindNetworkTag) tags.push(['t', bindNetworkTag]);
    if (snap && snap.communityId) tags.push(['community', String(snap.communityId)]);

    if (isV2() && P) {
      const ih = await P.sha256Hex(code);
      tags.push(['ih', ih]);
      const st = P.getVerifiedControlOrNull && P.getVerifiedControlOrNull();
      if (st && typeof st.controlEpoch === 'number') {
        tags.push(['control-epoch', String(st.controlEpoch)]);
      }
      // Do not put plaintext code on relay for V2
    } else {
      tags.push([codeTag, code]);
    }

    const draft = {
      kind: App.INVITE_KIND || 37378,
      created_at: now,
      tags,
      content: JSON.stringify({
        v: isV2() ? 2 : 1,
        type: 'invite',
        schema: isV2() ? 'sos-invite' : undefined,
        communityId: snap && snap.communityId ? snap.communityId : undefined,
      }),
      pubkey: App.publicKey,
    };
    // Strip undefined from content
    draft.content = JSON.stringify(
      isV2()
        ? {
            v: 2,
            type: 'invite',
            schema: 'sos-invite',
            communityId: snap && snap.communityId ? snap.communityId : undefined,
          }
        : { v: 1, type: 'invite' }
    );

    const event = await Promise.resolve(App.SosCryptoSigner.signInviteEvent(draft));
    await App.pool.publish(App.relayUrls, event);

    const inviteUrl = buildInviteUrl(code);
    const message = encodeURIComponent(
      `הזמנה לרשת SOS:\n${inviteUrl}\n\nקוד הזמנה: ${code}\nלחצו על הקישור והמשיכו בפתיחת משתמש חדש.`
    );
    const whatsappUrl = `https://wa.me/?text=${message}`;

    return {
      code,
      inviteUrl,
      whatsappUrl,
      event,
      communityId: snap && snap.communityId ? snap.communityId : null,
      networkTag: bindNetworkTag || null,
    };
  }

  async function markInviteUsed({ code, inviterPubkey, inviteEventId }) {
    if (!App.SosCryptoSigner?.hasIdentityKey() || typeof App.SosCryptoSigner.signInviteEvent !== 'function') {
      return { ok: false, error: 'missing-key' };
    }
    if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) {
      return { ok: false, error: 'no-relays' };
    }

    const normalized = String(code || '').toUpperCase();
    const P = policy();
    let inviteEvent = null;
    try {
      inviteEvent = await findInviteEvent(normalized);
    } catch (_e) {}

    const resolvedId =
      (inviteEvent && inviteEvent.id) ||
      (inviteEventId ? String(inviteEventId) : '') ||
      '';

    if (isV2() && P) {
      if (!resolvedId || !P.consumeRedeemSession(normalized, resolvedId)) {
        return { ok: false, error: 'no-redeem-session' };
      }
    }

    const codeTag = App.INVITE_CODE_TAG || 'i';
    const tags = [['t', App.INVITE_USED_TAG || 'sos-invite-used']];
    if (App.NETWORK_TAG) tags.push(['t', App.NETWORK_TAG]);
    if (inviterPubkey) tags.push(['p', inviterPubkey]);
    if (resolvedId) tags.push(['e', String(resolvedId).toLowerCase()]);

    if (isV2() && P) {
      const ih = await P.sha256Hex(normalized);
      tags.push(['ih', ih]);
    } else {
      tags.push([codeTag, normalized]);
    }

    const draft = {
      kind: App.INVITE_USED_KIND || 37379,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: JSON.stringify({ v: isV2() ? 2 : 1, type: 'invite-used' }),
      pubkey: App.publicKey,
    };
    try {
      const event = await Promise.resolve(App.SosCryptoSigner.signInviteEvent(draft));
      await App.pool.publish(App.relayUrls, event);
      return { ok: true, event };
    } catch (err) {
      return { ok: false, error: err?.message || 'publish-failed' };
    }
  }

  async function revokeInvite({ inviteEvent, code }) {
    const P = policy();
    if (!isV2() || !P) throw new Error('revoke requires V2');
    if (!App.SosCryptoSigner?.hasIdentityKey()) throw new Error('missing-key');
    let ev = inviteEvent;
    if (!ev && code) ev = await findInviteEvent(code);
    if (!ev || !ev.id) throw new Error('invite-not-found');
    const auth = P.canRevokeInvite(App.publicKey, ev, null);
    if (!auth.ok) throw new Error('אין הרשאה לבטל הזמנה');

    const st = P.getVerifiedControlOrNull && P.getVerifiedControlOrNull();
    const now = Math.floor(Date.now() / 1000);
    const tags = [
      ['d', String(ev.id).toLowerCase()],
      ['e', String(ev.id).toLowerCase()],
      ['t', App.NETWORK_TAG || 'israel-network'],
      ['t', 'sos-invite-revoke'],
    ];
    if (st && typeof st.controlEpoch === 'number') {
      tags.push(['control-epoch', String(st.controlEpoch)]);
    }
    const draft = {
      kind: P.INVITE_REVOKE_EVENT_KIND || 37380,
      created_at: now,
      tags,
      content: JSON.stringify({
        schema: 'sos-invite-revoke',
        version: 1,
        inviteEventId: String(ev.id).toLowerCase(),
        groupId: App.NETWORK_TAG || 'israel-network',
        controlEpoch: st ? st.controlEpoch : null,
      }),
      pubkey: App.publicKey,
    };
    const signer = App.SosCryptoSigner;
    const signed =
      typeof signer.signInviteRevokeEvent === 'function'
        ? await Promise.resolve(signer.signInviteRevokeEvent(draft))
        : await Promise.resolve(signer.signInviteEvent(draft));
    await App.pool.publish(App.relayUrls, signed);
    return { ok: true, event: signed };
  }

  function openWhatsAppInvite(whatsappUrl) {
    window.open(whatsappUrl, '_blank', 'noopener');
  }

  function canCreateInviteUi() {
    const P = policy();
    if (!P) return !App.guestMode && !!(App.SosCryptoSigner && App.SosCryptoSigner.hasIdentityKey());
    return P.canCreateInvite(App.publicKey, null, {}).ok === true;
  }

  Object.assign(App, {
    normalizePhone,
    isValidPhone,
    hashPhone,
    getInviteCodeFromLocation,
    buildInviteUrl,
    createInvite,
    validateInvite,
    markInviteUsed,
    revokeInvite,
    openWhatsAppInvite,
    canCreateInviteUi,
  });
})(window);
