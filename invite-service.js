/* __F2B_AWAIT_WRAPPED__ */
// מנגנון הזמנות הצטרפות בוואטסאפ (invite-service.js) | HYPER CORE TECH
// AC3: when SOS_ACCESS_CONTROL_V2 is enabled, InvitePolicy enforces create/redeem/revoke.
(function initInviteService(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  function policy() {
    return App.InvitePolicy || window.SosInvitePolicy || null;
  }

  function phoneApi() {
    return App.PhoneNormalize || window.SosPhoneNormalize || null;
  }

  /** Canonical E.164 via phone-normalize.js when present; legacy digits otherwise. */
  function normalizePhone(phone) {
    const PN = phoneApi();
    if (PN && typeof PN.normalizePhoneE164 === 'function') {
      const r = PN.normalizePhoneE164(phone);
      return r.ok ? r.digits : '';
    }
    const digits = String(phone || '').replace(/\D+/g, '');
    if (!digits) return '';
    if (digits.length === 10 && digits.startsWith('0')) return '972' + digits.slice(1);
    if (digits.length === 9 && digits.startsWith('5')) return '972' + digits;
    return digits;
  }

  function isValidPhone(phone) {
    const PN = phoneApi();
    if (PN && typeof PN.isValidPhoneE164 === 'function') return PN.isValidPhoneE164(phone);
    const normalized = normalizePhone(phone);
    return normalized.length >= 9 && normalized.length <= 15;
  }

  function invitePurposeConstants() {
    const GI = App.GlobalIdentity || window.SosGlobalIdentity;
    return (GI && GI.INVITE_PURPOSE) || { NEW_ACCOUNT: 'NEW_ACCOUNT_INVITE', COMMUNITY: 'COMMUNITY_INVITE' };
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

  /** First-group V2: single-use invites are registered, consumed and revoked only through the admission service. */
  function admission() {
    if (!isV2() || App.NETWORK_TAG !== 'israel-network') return null;
    return App.FirstGroupAdmission || window.SosFirstGroupAdmission || null;
  }

  function admissionError(result, fallbackCode) {
    const A = App.FirstGroupAdmission || window.SosFirstGroupAdmission;
    const msg = A ? A.message(result) : 'שירות ההצטרפות אינו זמין כרגע. נסו שוב בעוד רגע.';
    return Object.assign(new Error(msg), { admissionCode: result || fallbackCode || 'TEMPORARILY_UNAVAILABLE' });
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

  /** Effective expiry: the tag, capped at created_at + 24h (also for invites issued before the 24h default). */
  function readInviteExpiry(event) {
    if (!event || !Array.isArray(event.tags)) return 0;
    const row = event.tags.find((t) => Array.isArray(t) && t[0] === 'expiration' && t[1]);
    const n = Number(row && row[1]);
    const cap = Number(event.created_at) > 0 ? Number(event.created_at) + 24 * 60 * 60 : 0;
    if (Number.isFinite(n) && n > 0) return cap ? Math.min(n, cap) : n;
    return cap;
  }

  async function validateInvite({ code, phone }) {
    const normalizedCode = String(code || '').trim().toUpperCase();
    if (!normalizedCode || normalizedCode.length < 6) {
      return { ok: false, error: 'קוד הזמנה לא תקין' };
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

    const GI = App.GlobalIdentity || window.SosGlobalIdentity;
    const PURPOSES = invitePurposeConstants();
    const purpose =
      GI && typeof GI.invitePurposeOfEvent === 'function'
        ? GI.invitePurposeOfEvent(inviteEvent)
        : PURPOSES.COMMUNITY;

    // NEW_ACCOUNT_INVITE: guests redeem without existing membership. COMMUNITY: gate when authenticated.
    const MS = App.MembershipState || window.SosMembershipState;
    if (
      purpose !== PURPOSES.NEW_ACCOUNT &&
      MS &&
      typeof MS.isV2 === 'function' &&
      MS.isV2() &&
      App.publicKey
    ) {
      if (typeof MS.ensureCache === 'function') MS.ensureCache();
      const gated = MS.canPerformMemberAction(App.publicKey, 'invite_redeem');
      if (!gated.ok) {
        return { ok: false, error: 'אין הרשאת חברות למימוש הזמנה', code: gated.code };
      }
    }

    const P = policy();
    if (isV2() && P && purpose !== PURPOSES.NEW_ACCOUNT) {
      const auth = P.canRedeemInvite(inviteEvent, null, {});
      // With the admission service, inviter authority was checked at registration; an unregistered invite is INVALID there.
      const serviceDecidesCreator = !!admission() && (auth.code === 'CREATOR_UNAUTHORIZED' || auth.code === 'NO_VERIFIED_CONTROL');
      if (!auth.ok && !serviceDecidesCreator) {
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
      return { ok: false, error: 'תוקף ההזמנה פג. בקשו הזמנה חדשה.', code: 'EXPIRED' };
    }

    // NEW_ACCOUNT: authoritative phone check via GlobalAdmission (scoped; does not consume).
    if (purpose === PURPOSES.NEW_ACCOUNT) {
      if (!phone || !isValidPhone(phone)) {
        return { ok: false, error: 'נא להזין מספר טלפון', code: 'PHONE_REQUIRED' };
      }
      const PN = phoneApi();
      const phoneNorm =
        PN && typeof PN.normalizePhoneE164 === 'function' ? PN.normalizePhoneE164(phone) : { ok: true, e164: phone };
      if (!phoneNorm.ok) {
        return { ok: false, error: 'מספר טלפון לא תקין', code: 'BAD_PHONE' };
      }
      const GA = App.GlobalAdmission || window.SosGlobalAdmission;
      if (!GA || typeof GA.checkNewAccountInvitePhone !== 'function') {
        return { ok: false, error: 'שירות החשבון הגלובלי אינו זמין', code: 'GLOBAL_ADMISSION_UNAVAILABLE' };
      }
      const chk = await GA.checkNewAccountInvitePhone(inviteEvent.id, phoneNorm.e164);
      if (chk.result === 'OK' && chk.ok !== false) {
        return {
          ok: true,
          code: normalizedCode,
          inviteEvent,
          inviterPubkey: inviteEvent.pubkey || '',
          phoneHash: '',
          purpose,
          INVITE_TYPES_EXPLICIT: true,
          admission: 'GLOBAL_NEW_ACCOUNT',
          PHONE_PROOF_LEVEL: 'WHATSAPP_DELIVERY_BOUND_INVITE',
        };
      }
      if (chk.code === 'WRONG_PHONE') {
        return {
          ok: false,
          error: 'מספר הטלפון אינו תואם להזמנה.',
          code: 'WRONG_PHONE',
          WRONG_PHONE_CREATES_IDENTITY: false,
          WRONG_PHONE_CONSUMES_INVITE: false,
        };
      }
      if (chk.code === 'ALREADY_USED') {
        return { ok: false, error: 'ההזמנה כבר נוצלה', code: 'ALREADY_REDEEMED' };
      }
      if (chk.code === 'EXPIRED') {
        return { ok: false, error: 'תוקף ההזמנה פג. בקשו הזמנה חדשה.', code: 'EXPIRED' };
      }
      return {
        ok: false,
        error: chk.message || 'ההזמנה לא תקפה',
        code: chk.code || 'INVALID',
      };
    }

    const A = admission();
    if (A) {
      const st = await A.status(inviteEvent.id, normalizedCode);
      const map = {
        ALREADY_REDEEMED: 'ALREADY_REDEEMED',
        REVOKED: 'REVOKED',
        EXPIRED: 'EXPIRED',
        INVALID: 'INVALID',
        UNAUTHORIZED: 'INVALID',
        TEMPORARILY_UNAVAILABLE: 'TEMPORARILY_UNAVAILABLE',
      };
      const resumable = st.result === 'ALREADY_REDEEMED' && typeof A.hasOperation === 'function' && A.hasOperation(inviteEvent.id);
      if (st.result !== 'UNUSED' && !resumable) {
        const r = map[st.result] || 'INVALID';
        return { ok: false, error: A.message(r), code: r };
      }
      return {
        ok: true,
        code: normalizedCode,
        inviteEvent,
        inviterPubkey: inviteEvent.pubkey || '',
        phoneHash: '',
        purpose,
        INVITE_TYPES_EXPLICIT: true,
        admission: 'SERVICE',
      };
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
        return { ok: false, error: 'מספר הטלפון אינו תואם להזמנה.', code: 'WRONG_PHONE' };
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
      purpose,
      INVITE_TYPES_EXPLICIT: true,
    };
  }

  /** Privileged action: pull the current control tip + memberships from relays before deciding. */
  async function refreshInviteAuthority() {
    const MS = App.MembershipState || window.SosMembershipState;
    const NA = App.FirstGroupNetworkAuthority || window.SosFirstGroupNetworkAuthority;
    if (!MS || typeof MS.isV2 !== 'function' || !MS.isV2()) return null;
    if (!NA || typeof NA.reconcile !== 'function') return null;
    try {
      return await NA.reconcile('invite-create');
    } catch (_e) {
      return null;
    }
  }

  /**
   * @param {{ purpose?: string, recipientPhone?: string }} [opts]
   * purpose=NEW_ACCOUNT_INVITE requires recipientPhone.
   * purpose=COMMUNITY_INVITE (default) — First Group membership; MUST NOT create new K for existing P.
   */
  async function createInvite(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const PURPOSES = invitePurposeConstants();
    const purpose =
      o.purpose === PURPOSES.NEW_ACCOUNT || o.purpose === 'NEW_ACCOUNT_INVITE'
        ? PURPOSES.NEW_ACCOUNT
        : PURPOSES.COMMUNITY;

    if (!App.SosCryptoSigner?.hasIdentityKey() || App.guestMode) {
      throw new Error('רק משתמש מחובר יכול להזמין');
    }
    if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) {
      throw new Error('אין חיבור לריליים');
    }

    await refreshInviteAuthority();
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

    let recipientDigits = '';
    let recipientE164 = '';
    if (purpose === PURPOSES.NEW_ACCOUNT) {
      if (!o.recipientPhone) throw Object.assign(new Error('חסר מספר טלפון להזמנת חשבון חדש'), { code: 'PHONE_REQUIRED' });
      const PN = phoneApi();
      const phoneNorm =
        PN && typeof PN.normalizePhoneE164 === 'function'
          ? PN.normalizePhoneE164(o.recipientPhone)
          : isValidPhone(o.recipientPhone)
            ? { ok: true, e164: '+' + normalizePhone(o.recipientPhone), digits: normalizePhone(o.recipientPhone) }
            : { ok: false };
      if (!phoneNorm.ok) throw Object.assign(new Error('מספר טלפון לא תקין'), { code: 'BAD_PHONE' });
      recipientDigits = phoneNorm.digits;
      recipientE164 = phoneNorm.e164;
      // LOOKUP_BEFORE_INVITE — authoritative; no client phoneToken; 37377 alone must not block.
      const GA = App.GlobalAdmission || window.SosGlobalAdmission;
      if (GA && typeof GA.lookupPhone === 'function') {
        const look = await GA.lookupPhone(recipientE164);
        if (look && look.unavailable === true) {
          throw Object.assign(new Error('לא ניתן לשלוח הזמנה למספר זה כרגע.'), {
            code: 'PHONE_UNAVAILABLE',
            registered: true,
            unavailable: true,
            ACCOUNT_DISABLED_REASON_LEAKED_TO_SEARCHER: false,
            DISABLED_PHONE_NEW_ACCOUNT_INVITE_CREATED: false,
            REGISTERED_PHONE_NEW_ACCOUNT_INVITE_CREATED: false,
          });
        }
        if (look && look.registered === true) {
          throw Object.assign(new Error('PHONE_ALREADY_REGISTERED'), {
            code: 'PHONE_ALREADY_REGISTERED',
            pubkey: look.pubkey || null,
            registered: true,
            SAME_PHONE_CAN_CREATE_SECOND_ACTIVE_ACCOUNT: false,
            REGISTERED_PHONE_NEW_ACCOUNT_INVITE_CREATED: false,
          });
        }
      }
    }

    const code = generateInviteCode();
    const now = Math.floor(Date.now() / 1000);
    const maxTtl = 24 * 60 * 60;
    const ttl = Math.min(Number(App.INVITE_TTL_SECONDS) || maxTtl, maxTtl);
    const codeTag = App.INVITE_CODE_TAG || 'i';
    const tags = [
      ['t', App.INVITE_TAG || 'sos-invite'],
      ['expiration', String(now + ttl)],
      ['purpose', purpose],
    ];
    const CC = App.CommunityContext || window.SosCommunityContext;
    const snap = CC && typeof CC.snapshot === 'function' ? CC.snapshot() : null;
    const bindNetworkTag =
      (snap && snap.networkTag) ||
      (typeof App.NETWORK_TAG === 'string' ? App.NETWORK_TAG : '') ||
      '';
    if (bindNetworkTag) tags.push(['t', bindNetworkTag]);
    if (snap && snap.communityId) tags.push(['community', String(snap.communityId)]);
    // Never put phoneToken or client-forged phoneHash as authoritative binding on NEW_ACCOUNT invites.

    if (isV2() && P) {
      const ih = await P.sha256Hex(code);
      tags.push(['ih', ih]);
      tags.push(['d', ih]);
      const st = P.getVerifiedControlOrNull && P.getVerifiedControlOrNull();
      if (st && typeof st.controlEpoch === 'number') {
        tags.push(['control-epoch', String(st.controlEpoch)]);
      }
    } else {
      tags.push([codeTag, code]);
    }

    const draft = {
      kind: App.INVITE_KIND || 37378,
      created_at: now,
      tags,
      content: '',
      pubkey: App.publicKey,
    };
    draft.content = JSON.stringify(
      isV2()
        ? {
            v: 2,
            type: 'invite',
            schema: 'sos-invite',
            purpose,
            communityId: snap && snap.communityId ? snap.communityId : undefined,
          }
        : { v: 1, type: 'invite', purpose }
    );

    const event = await Promise.resolve(App.SosCryptoSigner.signInviteEvent(draft));
    let admissionResult = null;
    let globalInvite = null;

    if (purpose === PURPOSES.NEW_ACCOUNT) {
      const GA = App.GlobalAdmission || window.SosGlobalAdmission;
      if (!GA || typeof GA.registerNewAccountInvite !== 'function') {
        throw Object.assign(new Error('שירות החשבון הגלובלי אינו זמין'), { code: 'GLOBAL_ADMISSION_UNAVAILABLE' });
      }
      const reg = await GA.registerNewAccountInvite(event, recipientE164);
      if (reg.result !== 'OK') {
        const code = reg.code || 'REGISTER_FAILED';
        if (code === 'PHONE_UNAVAILABLE' || reg.unavailable === true) {
          throw Object.assign(new Error('לא ניתן לשלוח הזמנה למספר זה כרגע.'), {
            code: 'PHONE_UNAVAILABLE',
            ACCOUNT_DISABLED_REASON_LEAKED_TO_SEARCHER: false,
          });
        }
        if (code === 'PHONE_ALREADY_REGISTERED') {
          throw Object.assign(new Error('PHONE_ALREADY_REGISTERED'), {
            code: 'PHONE_ALREADY_REGISTERED',
            pubkey: reg.pubkey || null,
            REGISTERED_PHONE_NEW_ACCOUNT_INVITE_CREATED: false,
          });
        }
        throw Object.assign(new Error(code), { code, detail: reg });
      }
      globalInvite = reg;
      if (reg.recipientE164) recipientE164 = reg.recipientE164;
      if (recipientE164.startsWith('+')) recipientDigits = recipientE164.slice(1);
      // Also register with First Group admission when control plane is ready (best-effort).
      // Global phone binding remains authoritative even if community registration is deferred.
      const A = admission();
      if (A) {
        try {
          const cre = await A.registerInvite(event);
          if (cre.result === 'REGISTERED') {
            admissionResult = { result: 'REGISTERED', replay: cre.replay === true };
          } else {
            admissionResult = { result: cre.result || 'SKIPPED', bestEffort: true };
          }
        } catch (_cre) {
          admissionResult = { result: 'SKIPPED', bestEffort: true };
        }
      }
    } else {
      const A = admission();
      if (A) {
        const reg = await A.registerInvite(event);
        if (reg.result !== 'REGISTERED') throw admissionError(reg.result, 'REGISTER_FAILED');
        admissionResult = { result: 'REGISTERED', replay: reg.replay === true };
      }
    }
    await App.pool.publish(App.relayUrls, event);

    const inviteUrl = buildInviteUrl(code);
    const message = encodeURIComponent(
      purpose === PURPOSES.NEW_ACCOUNT
        ? `הזמנה ל-SOS:\n${inviteUrl}\n\nקוד הזמנה: ${code}\nלחצו על הקישור והמשיכו בפתיחת משתמש חדש.`
        : `הזמנה לרשת SOS:\n${inviteUrl}\n\nקוד הזמנה: ${code}\nלחצו על הקישור להצטרפות.`
    );
    // NEW_ACCOUNT: WhatsApp must target the specific recipient. COMMUNITY (First Group UI): keep generic share.
    const whatsappUrl =
      purpose === PURPOSES.NEW_ACCOUNT && recipientDigits
        ? `https://wa.me/${recipientDigits}?text=${message}`
        : `https://wa.me/?text=${message}`;

    return {
      code,
      inviteUrl,
      whatsappUrl,
      event,
      purpose,
      INVITE_TYPES_EXPLICIT: true,
      NEW_ACCOUNT_INVITE_PHONE_BOUND: purpose === PURPOSES.NEW_ACCOUNT,
      WHATSAPP_SPECIFIC_RECIPIENT: purpose === PURPOSES.NEW_ACCOUNT && !!recipientDigits,
      WHATSAPP_GENERIC_SHARE_FOR_PHONE_INVITE: !(purpose === PURPOSES.NEW_ACCOUNT && !!recipientDigits),
      PHONE_PROOF_LEVEL: 'WHATSAPP_DELIVERY_BOUND_INVITE',
      communityId: snap && snap.communityId ? snap.communityId : null,
      networkTag: bindNetworkTag || null,
      admission: admissionResult,
      globalInvite,
      // Never return phoneToken
    };
  }

  async function markInviteUsed({ code, inviterPubkey, inviteEventId, phone, purpose: purposeHint }) {
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

    const GI = App.GlobalIdentity || window.SosGlobalIdentity;
    const PURPOSES = invitePurposeConstants();
    const purpose =
      purposeHint ||
      (GI && inviteEvent && typeof GI.invitePurposeOfEvent === 'function'
        ? GI.invitePurposeOfEvent(inviteEvent)
        : PURPOSES.COMMUNITY);

    // NEW_ACCOUNT: global redeem (phone bind + cert) THEN First Group membership admission.
    if (purpose === PURPOSES.NEW_ACCOUNT) {
      if (!inviteEvent) return { ok: false, error: 'ההזמנה לא נמצאה', code: 'INVALID' };
      const GA = App.GlobalAdmission || window.SosGlobalAdmission;
      if (!GA || typeof GA.redeemNewAccountInvite !== 'function') {
        return { ok: false, error: 'שירות החשבון הגלובלי אינו זמין', code: 'GLOBAL_ADMISSION_UNAVAILABLE' };
      }
      const phoneE164 = phone || '';
      const g = await GA.redeemNewAccountInvite({
        inviteId: inviteEvent.id,
        code: normalized,
        phone: phoneE164,
        redeemerPubkey: App.publicKey,
      });
      if (g.result !== 'OK' && g.code !== 'ALREADY_USED') {
        if (g.code === 'WRONG_PHONE') {
          return {
            ok: false,
            error: 'מספר הטלפון אינו תואם להזמנה.',
            code: 'WRONG_PHONE',
            userMessage: 'מספר הטלפון אינו תואם להזמנה.',
            WRONG_PHONE_CREATES_IDENTITY: false,
            WRONG_PHONE_CONSUMES_INVITE: false,
          };
        }
        return {
          ok: false,
          error: g.message || g.code || 'REDEEM_FAILED',
          code: g.code || 'REDEEM_FAILED',
          userMessage: g.message || 'מימוש ההזמנה נכשל',
        };
      }
      // Same redeemer retry is OK (idempotent).
      if (g.code === 'ALREADY_USED' && g.redeemerPubkey && g.redeemerPubkey !== String(App.publicKey || '').toLowerCase()) {
        return { ok: false, error: 'ההזמנה כבר נוצלה', code: 'ALREADY_REDEEMED', userMessage: 'ההזמנה כבר נוצלה' };
      }
      let membership = null;
      let membershipFinalized = false;
      const A = admission();
      if (A) {
        const r = await A.redeem({ code: normalized, inviteEvent, inviterPubkey });
        if (r.ok || r.result === 'ALREADY_REDEEMED') {
          membership = r;
          membershipFinalized = true;
        } else if (r.result === 'INVALID' || r.code === 'NOT_REGISTERED' || r.code === 'INVALID') {
          // Global invite succeeded; community ledger may not have the invite yet.
          membership = { result: 'DEFERRED', soft: true };
        } else {
          return {
            ok: false,
            error: r.error,
            code: r.result,
            result: r.result,
            userMessage: r.error || 'סיום חברות בקבוצה נכשל',
            globalRedeem: g,
          };
        }
      }
      return {
        ok: true,
        result: 'OK',
        purpose,
        INVITE_REDEEMED_ONCE: true,
        GLOBAL_ACCOUNT_CREATED_ONCE: g.GLOBAL_ACCOUNT_CREATED_ONCE !== false,
        PHONE_BINDING_CREATED_ONCE: g.PHONE_BINDING_CREATED_ONCE !== false,
        MEMBERSHIP_FINALIZED_ONCE: membershipFinalized,
        event: membership && membership.event,
        proof: membership && membership.proof,
        operationId: membership && membership.operationId,
        cert: g.cert || null,
        globalRedeem: g,
      };
    }

    const A = admission();
    if (A) {
      if (!inviteEvent) return { ok: false, error: A.message('INVALID'), code: 'INVALID' };
      const r = await A.redeem({ code: normalized, inviteEvent, inviterPubkey });
      return r.ok
        ? { ok: true, event: r.event, proof: r.proof, result: r.result, operationId: r.operationId, purpose }
        : { ok: false, error: r.error, code: r.result, result: r.result, userMessage: r.error };
    }

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
      if (resolvedId) tags.push(['d', String(resolvedId).toLowerCase()]);
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
    // Revoking another author's invite is an admin action: attest and verify before the service or relays see it.
    let attestation = null;
    if (String(ev.pubkey || '').toLowerCase() !== String(App.publicKey || '').toLowerCase()) {
      const C = App.Admin2faClient;
      const A2 = App.Admin2faProtocol;
      const att =
        C && typeof C.attest === 'function'
          ? await C.attest(signed, { invite: ev })
          : A2 && A2.isEnforced()
            ? { ok: false, code: 'ADMIN_2FA_SERVICE_UNAVAILABLE' }
            : { ok: true };
      if (!att.ok) throw Object.assign(new Error(att.code), { code: att.code });
      attestation = att.attestation || null;
    }
    const A = admission();
    if (A) {
      const r = await A.revoke(signed);
      if (r.result !== 'REVOKED') throw admissionError(r.result, 'REVOKE_FAILED');
    }
    if (attestation) await App.pool.publish(App.relayUrls, attestation);
    await App.pool.publish(App.relayUrls, signed);
    return { ok: true, event: signed, attestation };
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
    refreshInviteAuthority,
  });
})(window);
