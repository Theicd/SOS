/**
 * Canonical phone normalization — single source of truth for GLOBAL phone identity.
 * PHONE_NORMALIZATION_SINGLE_SOURCE_OF_TRUTH=true
 * Output: E.164 with leading '+' (e.g. +972501234567).
 * Does NOT compute phoneToken (HMAC is Worker-only).
 */
(function initPhoneNormalize(root) {
  'use strict';
  const window = root;

  const App = window.NostrApp || (window.NostrApp = {});

  const DEFAULT_REGION = 'IL';

  /**
   * @param {string} input
   * @param {{ defaultRegion?: string }} [opts]
   * @returns {{ ok: true, e164: string, digits: string } | { ok: false, code: string }}
   */
  function normalizePhoneE164(input, opts) {
    const region = (opts && opts.defaultRegion) || DEFAULT_REGION;
    const raw = String(input == null ? '' : input).trim();
    if (!raw) return { ok: false, code: 'EMPTY' };
    if (/[a-zA-Z]/.test(raw)) return { ok: false, code: 'LETTERS' };

    let digits = raw.replace(/\D+/g, '');
    if (!digits) return { ok: false, code: 'NO_DIGITS' };

    // Strip trunk/international access prefixes commonly typed by users.
    if (digits.startsWith('00')) digits = digits.slice(2);

    if (region === 'IL') {
      if (digits.startsWith('972')) {
        // already country-coded
      } else if (digits.length === 10 && digits.startsWith('0')) {
        digits = '972' + digits.slice(1);
      } else if (digits.length === 9 && digits.startsWith('5')) {
        digits = '972' + digits;
      } else if (raw.startsWith('+')) {
        // keep as international digits
      } else {
        return { ok: false, code: 'UNSUPPORTED_LOCAL' };
      }
      // Israeli mobile: 9725XXXXXXXX (12 digits)
      if (!/^9725\d{8}$/.test(digits)) {
        // Allow other 972 landline lengths later; for SOS mobile invites require mobile.
        if (!/^972\d{8,9}$/.test(digits)) return { ok: false, code: 'INVALID_IL' };
      }
    } else {
      if (digits.length < 8 || digits.length > 15) return { ok: false, code: 'LENGTH' };
    }

    if (digits.length < 8 || digits.length > 15) return { ok: false, code: 'LENGTH' };
    return { ok: true, e164: '+' + digits, digits };
  }

  function isValidPhoneE164(input, opts) {
    return normalizePhoneE164(input, opts).ok === true;
  }

  /** Legacy adapter: returns country digits without '+' (compat with old invite-service callers). */
  function normalizePhoneLegacyDigits(phone) {
    const r = normalizePhoneE164(phone);
    return r.ok ? r.digits : '';
  }

  const api = Object.freeze({
    DEFAULT_REGION,
    normalizePhoneE164,
    isValidPhoneE164,
    normalizePhoneLegacyDigits,
    PHONE_NORMALIZATION_SINGLE_SOURCE_OF_TRUTH: true,
    PHONE_PROOF_LEVEL: 'WHATSAPP_DELIVERY_BOUND_INVITE',
    PHONE_REBIND_NOT_IMPLEMENTED_YET: true,
  });

  App.PhoneNormalize = api;
  window.SosPhoneNormalize = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
