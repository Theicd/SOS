// מנגנון הזמנות הצטרפות בוואטסאפ (invite-service.js) | HYPER CORE TECH
(function initInviteService(window) {
  const App = window.NostrApp || (window.NostrApp = {});

  function normalizePhone(phone) {
    const digits = String(phone || '').replace(/\D+/g, '');
    if (!digits) return '';
    // ישראל נפוץ: 05xxxxxxxx → 9725...
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
      const url = new URL(window.location.origin + '/');
      url.searchParams.set('invite', String(code || '').toUpperCase());
      return url.toString();
    } catch (_) {
      return (window.location.origin || '') + '/?invite=' + encodeURIComponent(String(code || '').toUpperCase());
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

  async function findInviteEvent(code) {
    const codeTag = App.INVITE_CODE_TAG || 'i';
    const filter = {
      kinds: [App.INVITE_KIND || 37378],
      limit: 5,
    };
    filter['#' + codeTag] = [String(code || '').toUpperCase()];
    const events = await queryEvents(filter);
    if (!events.length) return null;
    events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return events[0];
  }

  async function isInviteUsed(code) {
    const codeTag = App.INVITE_CODE_TAG || 'i';
    const filter = {
      kinds: [App.INVITE_USED_KIND || 37379],
      limit: 5,
    };
    filter['#' + codeTag] = [String(code || '').toUpperCase()];
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
    if (!isValidPhone(phone)) {
      return { ok: false, error: 'נא להזין מספר טלפון תקין של המוזמן' };
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

    const expiry = readInviteExpiry(inviteEvent);
    if (expiry && expiry < Math.floor(Date.now() / 1000)) {
      return { ok: false, error: 'תוקף ההזמנה פג. בקשו הזמנה חדשה.' };
    }

    let used = false;
    try {
      used = await isInviteUsed(normalizedCode);
    } catch (err) {
      return { ok: false, error: 'לא ניתן לוודא שההזמנה פנויה. נסו שוב.' };
    }
    if (used) {
      return { ok: false, error: 'ההזמנה כבר נוצלה' };
    }

    const expectedPhoneHash = readInvitePhoneHash(inviteEvent);
    if (!expectedPhoneHash) {
      return { ok: false, error: 'ההזמנה אינה צמודה לטלפון' };
    }
    const actualPhoneHash = await hashPhone(phone);
    if (actualPhoneHash !== expectedPhoneHash) {
      return { ok: false, error: 'מספר הטלפון לא תואם להזמנה שנשלחה' };
    }

    return {
      ok: true,
      code: normalizedCode,
      inviteEvent,
      inviterPubkey: inviteEvent.pubkey || '',
      phoneHash: actualPhoneHash,
    };
  }

  async function createInvite({ phone }) {
    if (!App.privateKey || App.guestMode) {
      throw new Error('רק משתמש מחובר יכול להזמין');
    }
    if (!isValidPhone(phone)) {
      throw new Error('נא להזין מספר טלפון תקין של החבר');
    }
    if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) {
      throw new Error('אין חיבור לריליים');
    }
    if (typeof App.finalizeEvent !== 'function') {
      throw new Error('מנגנון חתימה לא זמין');
    }

    const code = generateInviteCode();
    const phoneHash = await hashPhone(phone);
    const now = Math.floor(Date.now() / 1000);
    const ttl = Number(App.INVITE_TTL_SECONDS) || 7 * 24 * 60 * 60;
    const codeTag = App.INVITE_CODE_TAG || 'i';
    const phoneTag = App.INVITE_PHONE_TAG || 'ph';
    const tags = [
      ['t', App.INVITE_TAG || 'sos-invite'],
      [codeTag, code],
      [phoneTag, phoneHash],
      ['expiration', String(now + ttl)],
    ];
    if (App.NETWORK_TAG) tags.push(['t', App.NETWORK_TAG]);

    const draft = {
      kind: App.INVITE_KIND || 37378,
      created_at: now,
      tags,
      content: JSON.stringify({ v: 1, type: 'invite' }),
    };
    const event = App.finalizeEvent(draft, App.privateKey);
    await App.pool.publish(App.relayUrls, event);

    const inviteUrl = buildInviteUrl(code);
    const waPhone = normalizePhone(phone);
    const message = encodeURIComponent(
      `הזמנה לרשת SOS:\n${inviteUrl}\n\nקוד הזמנה: ${code}\nיש להירשם עם אותו מספר טלפון שאליו נשלחה ההזמנה.`
    );
    const whatsappUrl = `https://wa.me/${waPhone}?text=${message}`;

    return { code, inviteUrl, whatsappUrl, event, phoneHash };
  }

  async function markInviteUsed({ code, inviterPubkey }) {
    if (!App.privateKey || typeof App.finalizeEvent !== 'function') {
      return { ok: false, error: 'missing-key' };
    }
    if (!App.pool || !Array.isArray(App.relayUrls) || !App.relayUrls.length) {
      return { ok: false, error: 'no-relays' };
    }
    const codeTag = App.INVITE_CODE_TAG || 'i';
    const tags = [
      ['t', App.INVITE_USED_TAG || 'sos-invite-used'],
      [codeTag, String(code || '').toUpperCase()],
    ];
    if (inviterPubkey) tags.push(['p', inviterPubkey]);
    if (App.NETWORK_TAG) tags.push(['t', App.NETWORK_TAG]);

    const draft = {
      kind: App.INVITE_USED_KIND || 37379,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: JSON.stringify({ v: 1, type: 'invite-used' }),
    };
    try {
      const event = App.finalizeEvent(draft, App.privateKey);
      await App.pool.publish(App.relayUrls, event);
      return { ok: true, event };
    } catch (err) {
      return { ok: false, error: err?.message || 'publish-failed' };
    }
  }

  function openWhatsAppInvite(whatsappUrl) {
    window.open(whatsappUrl, '_blank', 'noopener');
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
    openWhatsAppInvite,
  });
})(window);
