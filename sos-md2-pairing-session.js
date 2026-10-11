/**
 * Web MD2 Initiator (desktop destination) — sos-pair-v1.
 * Pure JS X25519 (RFC 7748) + AES-GCM + HKDF matching Android SosPairingCrypto / SosX25519.
 * Transport: Nostr kind 25060 envelopes (opaque ciphertext after hello).
 * Desktop initiator + Mobile Web phone responder (MD3W-W1B).
 * MD3 root signing remains outside this module (Android PhoneIssuer or Web AUTHORIZE_LINKED_DEVICE).
 * ROOT K / nsec never appear in QR or outbound pairing messages.
 */
(function initSosMd2PairingSession(window) {
  'use strict';

  const App = window.NostrApp || (window.NostrApp = {});
  const PROTOCOL_VERSION = 'sos-pair-v1';
  const KIND = 25060;
  const TAG = 'sos-pair-v1';
  const HKDF_INFO = 'SOS|pair|v1';
  const DEFAULT_RELAYS = ['wss://relay.snort.social', 'wss://nos.lol', 'wss://nostr-02.uid.ovh'];

  function hexFromBuf(buf) {
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  function bufFromHex(hex) {
    const h = String(hex || '')
      .toLowerCase()
      .replace(/^0x/, '');
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  function b64(buf) {
    let s = '';
    const a = new Uint8Array(buf);
    for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s);
  }
  function b64dec(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  }

  async function hmacSha256(keyBytes, data) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
  }

  async function hkdfExtract(salt, ikm) {
    return hmacSha256(salt, ikm);
  }

  async function hkdfExpand(prk, info, length) {
    const okm = new Uint8Array(length);
    let previous = new Uint8Array(0);
    let offset = 0;
    let counter = 1;
    while (offset < length) {
      const input = new Uint8Array(previous.length + info.length + 1);
      input.set(previous, 0);
      input.set(info, previous.length);
      input[previous.length + info.length] = counter;
      previous = await hmacSha256(prk, input);
      const n = Math.min(previous.length, length - offset);
      okm.set(previous.subarray(0, n), offset);
      offset += n;
      counter += 1;
    }
    return okm;
  }

  /* —— RFC 7748 X25519 (matches Android SosX25519) —— */
  const X25519_P = (1n << 255n) - 19n;
  const X25519_A24 = 121665n;
  const X25519_NINE = new Uint8Array(32);
  X25519_NINE[0] = 9;

  function x25519Clamp(k) {
    k[0] &= 248;
    k[31] &= 127;
    k[31] |= 64;
  }

  function x25519DecodeScalar(k) {
    let n = 0n;
    for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(k[i]);
    return n;
  }

  function x25519DecodeU(uBytes) {
    const t = uBytes.slice();
    t[31] &= 127;
    let n = 0n;
    for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(t[i]);
    return n % X25519_P;
  }

  function x25519EncodeU(n) {
    const out = new Uint8Array(32);
    let x = ((n % X25519_P) + X25519_P) % X25519_P;
    for (let i = 0; i < 32; i++) {
      out[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return out;
  }

  function x25519ScalarMult(privClamped, uBytes) {
    const k = x25519DecodeScalar(privClamped);
    const u = x25519DecodeU(uBytes);
    const x1 = u;
    let x2 = 1n;
    let z2 = 0n;
    let x3 = u;
    let z3 = 1n;
    let swap = 0;
    for (let t = 254; t >= 0; t--) {
      const kt = Number((k >> BigInt(t)) & 1n);
      const s = swap ^ kt;
      if (s !== 0) {
        const tx = x2;
        x2 = x3;
        x3 = tx;
        const tz = z2;
        z2 = z3;
        z3 = tz;
      }
      swap = kt;
      const a = (x2 + z2) % X25519_P;
      const aa = (a * a) % X25519_P;
      const b = (x2 - z2 + X25519_P) % X25519_P;
      const bb = (b * b) % X25519_P;
      const e = (aa - bb + X25519_P) % X25519_P;
      const c = (x3 + z3) % X25519_P;
      const d = (x3 - z3 + X25519_P) % X25519_P;
      const da = (d * a) % X25519_P;
      const cb = (c * b) % X25519_P;
      const sum = (da + cb) % X25519_P;
      x3 = (sum * sum) % X25519_P;
      const dif = (da - cb + X25519_P) % X25519_P;
      z3 = (x1 * ((dif * dif) % X25519_P)) % X25519_P;
      x2 = (aa * bb) % X25519_P;
      z2 = (e * ((aa + X25519_A24 * e) % X25519_P)) % X25519_P;
    }
    if (swap !== 0) {
      const tx = x2;
      x2 = x3;
      x3 = tx;
      const tz = z2;
      z2 = z3;
      z3 = tz;
    }
    // modInverse via Fermat: z2^(p-2)
    let invZ = 1n;
    let base = z2 % X25519_P;
    let exp = X25519_P - 2n;
    while (exp > 0n) {
      if (exp & 1n) invZ = (invZ * base) % X25519_P;
      base = (base * base) % X25519_P;
      exp >>= 1n;
    }
    return x25519EncodeU((x2 * invZ) % X25519_P);
  }

  function x25519Generate() {
    const priv = crypto.getRandomValues(new Uint8Array(32));
    x25519Clamp(priv);
    const pub = x25519ScalarMult(priv, X25519_NINE);
    return { priv, pub };
  }

  function x25519Shared(privRaw, peerPubHex) {
    const s = privRaw.slice();
    x25519Clamp(s);
    try {
      return x25519ScalarMult(s, bufFromHex(peerPubHex));
    } finally {
      s.fill(0);
    }
  }

  function concatUtf8Parts(parts) {
    const enc = new TextEncoder();
    const all = [];
    for (const p of parts) {
      if (typeof p === 'string') all.push(enc.encode(p));
      else all.push(p);
    }
    let len = 0;
    all.forEach((a) => (len += a.length));
    const out = new Uint8Array(len);
    let o = 0;
    all.forEach((a) => {
      out.set(a, o);
      o += a.length;
    });
    return out;
  }

  async function transcript(fields) {
    const parts = [
      fields.protocolVersion,
      fields.pairingId,
      fields.dSignPub,
      fields.dEncPub,
      fields.eDesktopPub,
      fields.ePhonePub,
      fields.nonce,
      String(fields.expiresAt),
    ];
    if (fields.rendezvous) parts.push(fields.rendezvous);
    return sha256(concatUtf8Parts(parts));
  }

  async function sessionKey(ecdh, tr) {
    const prk = await hkdfExtract(tr, ecdh);
    const info = new TextEncoder().encode(HKDF_INFO);
    return hkdfExpand(prk, info, 32);
  }

  async function seal(sk, tr, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', sk, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: tr, tagLength: 128 }, key, plaintext),
    );
    return { ivB64: b64(iv), ctB64: b64(ct) };
  }

  async function open(sk, tr, sealed) {
    try {
      const iv = b64dec(sealed.ivB64);
      const ct = b64dec(sealed.ctB64);
      const key = await crypto.subtle.importKey('raw', sk, { name: 'AES-GCM' }, false, ['decrypt']);
      return new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: tr, tagLength: 128 }, key, ct),
      );
    } catch (_e) {
      return null;
    }
  }

  async function domainHashPop(tr) {
    const enc = new TextEncoder();
    const prefix = enc.encode('SOS|pair|pop');
    const all = new Uint8Array(prefix.length + tr.length);
    all.set(prefix, 0);
    all.set(tr, prefix.length);
    return sha256(all);
  }

  /**
   * BIP340 schnorr over an arbitrary 32-byte message.
   * nostr-tools CDN freezes getEventHash (getter-only) and finalizeEvent hashes
   * internally — do not patch exports. Use noble schnorr (injected or NT.schnorr).
   */
  function getNobleSchnorr() {
    const NT = window.NostrTools;
    if (NT && NT.schnorr && typeof NT.schnorr.sign === 'function') return NT.schnorr;
    if (window.__sosNobleSchnorr && typeof window.__sosNobleSchnorr.sign === 'function') {
      return window.__sosNobleSchnorr;
    }
    return null;
  }

  async function signSchnorrRaw(msg32, sk) {
    const msg = msg32 instanceof Uint8Array ? msg32 : bufFromHex(msg32);
    const skBytes = sk instanceof Uint8Array ? sk : bufFromHex(sk);
    // Prefer in-page noble (never blocks on host IPC). Playwright bridge is fallback only.
    const schnorr = getNobleSchnorr();
    if (schnorr) {
      const sig = schnorr.sign(msg, skBytes);
      return typeof sig === 'string' ? String(sig).toLowerCase() : hexFromBuf(sig);
    }
    if (typeof window.__sosSchnorrSignHex === 'function') {
      const sigHex = await window.__sosSchnorrSignHex(hexFromBuf(msg), hexFromBuf(skBytes));
      return String(sigHex || '').toLowerCase();
    }
    throw new Error('SCHNORR_SIGN_UNAVAILABLE');
  }

  function verifySchnorrRaw(sigHex, msg32, pubHex) {
    const schnorr = getNobleSchnorr();
    if (schnorr && typeof schnorr.verify === 'function') {
      try {
        const msg = msg32 instanceof Uint8Array ? msg32 : bufFromHex(msg32);
        const sig = bufFromHex(sigHex);
        const pub = bufFromHex(pubHex);
        return !!schnorr.verify(sig, msg, pub);
      } catch (_e) {
        return false;
      }
    }
    return null; // caller may await async bridge
  }

  async function verifySchnorrRawAsync(sigHex, msg32, pubHex) {
    const sync = verifySchnorrRaw(sigHex, msg32, pubHex);
    if (sync !== null) return !!sync;
    if (typeof window.__sosSchnorrVerifyHex === 'function') {
      try {
        const msg = msg32 instanceof Uint8Array ? msg32 : bufFromHex(msg32);
        return !!(await window.__sosSchnorrVerifyHex(String(sigHex).toLowerCase(), hexFromBuf(msg), String(pubHex).toLowerCase()));
      } catch (_e) {
        return false;
      }
    }
    return false;
  }

  /**
   * Start desktop initiator: returns { qrText, handleInbound, stop, waitLinked, ... }
   */
  async function beginDesktopInitiator(opts) {
    const o = opts || {};
    const NT = window.NostrTools;
    if (!NT || typeof NT.generateSecretKey !== 'function') throw new Error('NOSTR_TOOLS_MISSING');
    const dSignSk = o.dSignSk || NT.generateSecretKey();
    const dSignPub = NT.getPublicKey(dSignSk);
    const dEnc = x25519Generate();
    const eph = x25519Generate();
    const deviceId = hexFromBuf(crypto.getRandomValues(new Uint8Array(32)));
    const pairingId = hexFromBuf(crypto.getRandomValues(new Uint8Array(32)));
    const nonce = hexFromBuf(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = Date.now() + (o.ttlMs || 120000);
    const rendezvous = o.rendezvous || DEFAULT_RELAYS[0];
    const payload = {
      protocolVersion: PROTOCOL_VERSION,
      pairingId,
      D_sign_pub: dSignPub,
      D_enc_pub: hexFromBuf(dEnc.pub),
      E_ephemeral_pub: hexFromBuf(eph.pub),
      nonce,
      expiresAt,
      purpose: 'LINK',
      deviceId,
      storageClass: 'SOFTWARE_ONLY',
      recoveryEligible: false,
      hardwareBacked: false,
      deviceType: 'DESKTOP',
      deviceLabel: o.deviceLabel || 'דפדפן',
      rendezvous,
    };
    const Md2 = App.Md2PairingQr;
    if (!Md2) throw new Error('MD2_MODULE_MISSING');
    const qrText = Md2.encodeQr(payload);

    let sk = null;
    let tr = null;
    let ePhonePub = null;
    let state = 'QR_SHOWN';
    let linkedAuth = null;
    const waiters = [];

    const pool = o.pool || App.pool;
    const relays = o.relays || DEFAULT_RELAYS;
    let sub = null;
    const seen = new Set();

    async function publish(content, role) {
      if (!pool || typeof pool.publish !== 'function') throw new Error('NO_POOL');
      const draft = {
        kind: KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['t', TAG],
          ['d', pairingId],
          ['role', role || 'desktop'],
        ],
        content,
      };
      const transportSk = NT.generateSecretKey();
      const ev = NT.finalizeEvent(draft, transportSk);
      await Promise.race([
        Promise.allSettled(pool.publish(relays, ev)),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
      return ev.id;
    }

    function dbgPhase(phase, extra) {
      try {
        window.__sosMd3DbgPhases = window.__sosMd3DbgPhases || [];
        const row = { t: Date.now(), phase: String(phase) };
        if (extra && typeof extra === 'object') {
          Object.keys(extra).forEach((k) => {
            row[k] = extra[k];
          });
        }
        window.__sosMd3DbgPhases.push(row);
      } catch (_e) {}
    }

    async function handleInbound(content) {
      let msg;
      try {
        msg = JSON.parse(content);
      } catch (_e) {
        return;
      }
      if (msg.type === 'hello' && state === 'QR_SHOWN') {
        const inboundPid = String(msg.pairingId || '').toLowerCase();
        if (inboundPid !== pairingId) {
          dbgPhase('HELLO_PAIRING_MISMATCH', {
            inboundFp: inboundPid.slice(0, 12),
            expectFp: String(pairingId).slice(0, 12),
          });
          return;
        }
        dbgPhase('HELLO_ACCEPTED', { pairingFp: pairingId.slice(0, 12) });
        ePhonePub = String(msg.E_phone_pub || '').toLowerCase();
        const shared = x25519Shared(eph.priv, ePhonePub);
        tr = await transcript({
          protocolVersion: PROTOCOL_VERSION,
          pairingId,
          dSignPub,
          dEncPub: hexFromBuf(dEnc.pub),
          eDesktopPub: hexFromBuf(eph.pub),
          ePhonePub,
          nonce,
          expiresAt,
          rendezvous,
        });
        sk = await sessionKey(shared, tr);
        shared.fill(0);
        const popMsg = await domainHashPop(tr);
        dbgPhase('POP_SIGN_BEGIN', {
          via: getNobleSchnorr() ? 'noble' : typeof window.__sosSchnorrSignHex === 'function' ? 'bridge' : 'none',
        });
        const sigHex = await signSchnorrRaw(popMsg, dSignSk);
        const body = new TextEncoder().encode(JSON.stringify({ type: 'pop', pairingId, sig: sigHex }));
        const sealed = await seal(sk, tr, body);
        // Advance before publish: phone can ACK within the publish await window.
        // If state stayed QR_SHOWN, inbound ACK was dropped after seen.add(id) and never retried.
        state = 'POP_SENT';
        dbgPhase('POP_SENT', { pairingFp: pairingId.slice(0, 12) });
        await publish(JSON.stringify({ type: 'aead', pairingId, iv: sealed.ivB64, ct: sealed.ctB64 }), 'desktop');
        return;
      }
      if (msg.type === 'aead' && (state === 'POP_SENT' || state === 'CHANNEL_READY' || state === 'AUTH_WAIT')) {
        if (String(msg.pairingId || '').toLowerCase() !== pairingId || !sk || !tr) return;
        const plain = await open(sk, tr, { ivB64: msg.iv, ctB64: msg.ct });
        if (!plain) {
          dbgPhase('AEAD_OPEN_FAIL', { state });
          return;
        }
        const body = JSON.parse(new TextDecoder().decode(plain));
        if (body.type === 'ack' && state === 'POP_SENT') {
          state = 'CHANNEL_READY';
          dbgPhase('CHANNEL_READY', { pairingFp: pairingId.slice(0, 12) });
          return;
        }
        if (body.type === 'device_authorization' && body.authorization) {
          linkedAuth = body.authorization;
          const ackBody = new TextEncoder().encode(
            JSON.stringify({
              type: 'device_auth_ack',
              authorizationId: linkedAuth.authorizationId,
              deviceId: linkedAuth.deviceId,
              accountP: linkedAuth.accountP,
            }),
          );
          const sealed = await seal(sk, tr, ackBody);
          await publish(JSON.stringify({ type: 'aead', pairingId, iv: sealed.ivB64, ct: sealed.ctB64 }), 'desktop');
          state = 'LINKED';
          waiters.splice(0).forEach((w) => w(linkedAuth));
        }
      }
    }

    if (pool && typeof pool.subscribeMany === 'function') {
      // nostr-tools SimplePool.subscribeMany expects a single Filter (not Filter[]).
      sub = pool.subscribeMany(
        relays,
        { kinds: [KIND], '#t': [TAG], '#d': [pairingId], limit: 50 },
        {
          onevent(ev) {
            if (!ev || seen.has(ev.id)) return;
            // MD4 S1: refuse cross-protocol / unknown t= before content parse.
            const Auth = App.Md4DeviceAuth || window.SosMd4DeviceAuth;
            if (Auth && typeof Auth.assertMd2MayAcceptEvent === 'function') {
              const gate = Auth.assertMd2MayAcceptEvent(ev);
              if (!gate.ok) {
                try {
                  window.__sosMd2ProtocolRejects = window.__sosMd2ProtocolRejects || [];
                  window.__sosMd2ProtocolRejects.push({ id: ev.id, code: gate.code, protocol: gate.protocol || null });
                } catch (_r) {}
                return;
              }
            } else {
              const tTag = (ev.tags || []).find((t) => t[0] === 't');
              if (!tTag || tTag[1] !== TAG) return;
            }
            seen.add(ev.id);
            const role = (ev.tags || []).find((t) => t[0] === 'role');
            if (role && role[1] === 'desktop') return;
            handleInbound(ev.content).catch((err) => {
              try {
                window.__sosMd3HandleInboundErr = String((err && err.message) || err).slice(0, 240);
              } catch (_e) {}
            });
          },
        },
      );
    }

    let secretsExported = false;
    return {
      qrText,
      payload,
      deviceId,
      dSignPub,
      dEncPub: hexFromBuf(dEnc.pub),
      state: () => state,
      /** One-shot export for MD4 durable store — does not include root K. */
      exportDeviceSecrets() {
        if (secretsExported) return { ok: false, code: 'ALREADY_EXPORTED' };
        secretsExported = true;
        return {
          ok: true,
          deviceId,
          D_sign_pub: dSignPub,
          D_enc_pub: hexFromBuf(dEnc.pub),
          dSignSk: new Uint8Array(dSignSk),
          dEncPriv: new Uint8Array(dEnc.priv),
        };
      },
      stop() {
        try {
          if (sub && typeof sub.close === 'function') sub.close();
        } catch (_e) {}
        try {
          eph.priv.fill(0);
          if (!secretsExported) dEnc.priv.fill(0);
        } catch (_z) {}
      },
      waitLinked(timeoutMs) {
        if (linkedAuth) return Promise.resolve(linkedAuth);
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs || 120000);
          waiters.push((auth) => {
            clearTimeout(t);
            resolve(auth);
          });
        });
      },
      ROOT_K_SENT_TO_DESKTOP: false,
      NSEC_SENT_TO_DESKTOP: false,
    };
  }

  /**
   * Mobile Web phone responder — HELLO → verify PoP → ACK → CHANNEL_READY → deliver auth.
   * Optical QR scanning is out of scope (W2); caller supplies QR text (paste/QA).
   */
  async function beginPhoneResponder(qrText, opts) {
    const o = opts || {};
    const NT = window.NostrTools;
    const Qr = App.Md2PairingQr || window.SosMd2PairingQr;
    if (!NT || typeof NT.finalizeEvent !== 'function') {
      return { ok: false, code: 'NOSTR_TOOLS_MISSING' };
    }
    if (!Qr || typeof Qr.parseQr !== 'function') return { ok: false, code: 'MD2_QR_MISSING' };
    const parsed = Qr.parseQr(qrText);
    if (!parsed.ok) return { ok: false, code: parsed.error || 'BAD_QR' };
    const payload = parsed.payload;
    const pairingId = String(payload.pairingId || '').toLowerCase();
    const dSignPub = String(payload.D_sign_pub || '').toLowerCase();
    const dEncPub = String(payload.D_enc_pub || '').toLowerCase();
    const eDesktopPub = String(payload.E_ephemeral_pub || '').toLowerCase();
    const deviceId = String(payload.deviceId || '').toLowerCase();
    if (!pairingId || !dSignPub || !dEncPub || !eDesktopPub) {
      return { ok: false, code: 'BAD_QR_FIELDS' };
    }

    const eph = x25519Generate();
    const ePhonePub = hexFromBuf(eph.pub);
    let sk = null;
    let tr = null;
    let state = 'HELLO_SENT';
    let bound = null;
    let authAck = null;
    const channelWaiters = [];
    const ackWaiters = [];
    const pool = o.pool || App.pool;
    const relays = o.relays || (payload.rendezvous ? [payload.rendezvous] : DEFAULT_RELAYS);
    const seen = new Set();
    let sub = null;

    async function publish(content, role) {
      if (typeof o.publishSigned === 'function') {
        return o.publishSigned(content, role || 'phone', pairingId);
      }
      if (!pool || typeof pool.publish !== 'function') throw new Error('NO_POOL');
      const draft = {
        kind: KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['t', TAG],
          ['d', pairingId],
          ['role', role || 'phone'],
        ],
        content,
      };
      const transportSk = NT.generateSecretKey();
      const ev = NT.finalizeEvent(draft, transportSk);
      await Promise.race([
        Promise.allSettled(pool.publish(relays, ev)),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
      return ev.id;
    }

    async function handleInbound(content) {
      let msg;
      try {
        msg = JSON.parse(content);
      } catch (_e) {
        return;
      }
      if (msg.type === 'aead' && state === 'HELLO_SENT') {
        if (String(msg.pairingId || '').toLowerCase() !== pairingId) return;
        const shared = x25519Shared(eph.priv, eDesktopPub);
        tr = await transcript({
          protocolVersion: payload.protocolVersion || PROTOCOL_VERSION,
          pairingId,
          dSignPub,
          dEncPub,
          eDesktopPub,
          ePhonePub,
          nonce: payload.nonce,
          expiresAt: payload.expiresAt,
          rendezvous: payload.rendezvous,
        });
        sk = await sessionKey(shared, tr);
        shared.fill(0);
        const plain = await open(sk, tr, { ivB64: msg.iv, ctB64: msg.ct });
        if (!plain) {
          state = 'FAILED';
          return;
        }
        let body;
        try {
          body = JSON.parse(new TextDecoder().decode(plain));
        } catch (_e) {
          state = 'FAILED';
          return;
        }
        if (body.type !== 'pop') {
          state = 'FAILED';
          return;
        }
        const popMsg = await domainHashPop(tr);
        const popOk = await verifySchnorrRawAsync(body.sig, popMsg, dSignPub);
        if (!popOk) {
          state = 'FAILED';
          return;
        }
        const ackBody = new TextEncoder().encode(
          JSON.stringify({
            type: 'ack',
            pairingId,
            boundDSignPub: dSignPub,
            boundDEncPub: dEncPub,
            deviceId,
            storageClass: payload.storageClass || 'SOFTWARE_ONLY',
            recoveryEligible: !!payload.recoveryEligible,
            hardwareBacked: !!payload.hardwareBacked,
          }),
        );
        const sealed = await seal(sk, tr, ackBody);
        await publish(JSON.stringify({ type: 'aead', pairingId, iv: sealed.ivB64, ct: sealed.ctB64 }), 'phone');
        bound = {
          pairingId,
          deviceId,
          dSignPub,
          dEncPub,
          transcriptHex: hexFromBuf(tr),
          purpose: payload.purpose || 'LINK',
          storageClass: payload.storageClass || 'SOFTWARE_ONLY',
          recoveryEligible: !!payload.recoveryEligible,
        };
        state = 'CHANNEL_READY';
        channelWaiters.splice(0).forEach((w) => w(bound));
        return;
      }
      if (msg.type === 'aead' && (state === 'CHANNEL_READY' || state === 'AUTH_SENT')) {
        if (String(msg.pairingId || '').toLowerCase() !== pairingId || !sk || !tr) return;
        const plain = await open(sk, tr, { ivB64: msg.iv, ctB64: msg.ct });
        if (!plain) return;
        let body;
        try {
          body = JSON.parse(new TextDecoder().decode(plain));
        } catch (_e) {
          return;
        }
        if (body.type === 'device_auth_ack') {
          authAck = {
            ok: true,
            authorizationId: String(body.authorizationId || '').toLowerCase(),
            deviceId: String(body.deviceId || '').toLowerCase(),
            accountP: String(body.accountP || '').toLowerCase(),
          };
          state = 'ACKED';
          ackWaiters.splice(0).forEach((w) => w(authAck));
        }
      }
    }

    if (pool && typeof pool.subscribeMany === 'function') {
      sub = pool.subscribeMany(
        relays,
        { kinds: [KIND], '#t': [TAG], '#d': [pairingId], limit: 50 },
        {
          onevent(ev) {
            if (!ev || seen.has(ev.id)) return;
            const Auth = App.Md4DeviceAuth || window.SosMd4DeviceAuth;
            if (Auth && typeof Auth.assertMd2MayAcceptEvent === 'function') {
              const gate = Auth.assertMd2MayAcceptEvent(ev);
              if (!gate.ok) return;
            }
            seen.add(ev.id);
            const role = (ev.tags || []).find((t) => t[0] === 'role');
            if (role && role[1] === 'phone') return;
            handleInbound(ev.content).catch(function () {});
          },
        },
      );
    }

    // Send HELLO
    try {
      await publish(JSON.stringify({ type: 'hello', pairingId, E_phone_pub: ePhonePub }), 'phone');
    } catch (_e) {
      return { ok: false, code: 'HELLO_PUBLISH_FAIL' };
    }

    return {
      ok: true,
      state: function () {
        return state;
      },
      waitChannelReady: function (timeoutMs) {
        if (bound) return Promise.resolve(bound);
        return new Promise(function (resolve, reject) {
          const t = setTimeout(function () {
            reject(new Error('TIMEOUT'));
          }, timeoutMs || 120000);
          channelWaiters.push(function (b) {
            clearTimeout(t);
            resolve(b);
          });
        });
      },
      deliverDeviceAuthorization: async function (authorization) {
        if (state !== 'CHANNEL_READY' || !sk || !tr) return { ok: false, code: 'NOT_CHANNEL_READY' };
        const body = new TextEncoder().encode(
          JSON.stringify({ type: 'device_authorization', authorization: authorization }),
        );
        const sealed = await seal(sk, tr, body);
        await publish(JSON.stringify({ type: 'aead', pairingId, iv: sealed.ivB64, ct: sealed.ctB64 }), 'phone');
        state = 'AUTH_SENT';
        return { ok: true };
      },
      waitAuthAck: function (timeoutMs) {
        if (authAck) return Promise.resolve(authAck);
        return new Promise(function (resolve, reject) {
          const t = setTimeout(function () {
            reject(new Error('TIMEOUT'));
          }, timeoutMs || 60000);
          ackWaiters.push(function (a) {
            clearTimeout(t);
            resolve(a);
          });
        });
      },
      stop: function () {
        try {
          if (sub && typeof sub.close === 'function') sub.close();
        } catch (_e) {}
        try {
          eph.priv.fill(0);
          if (sk) sk.fill(0);
        } catch (_z) {}
      },
      ROOT_K_SENT_TO_DESKTOP: false,
      NSEC_SENT_TO_DESKTOP: false,
    };
  }

  App.Md2PairingSession = {
    KIND,
    TAG,
    HIST_TAG: 'sos-hist-v1',
    beginDesktopInitiator,
    beginPhoneResponder,
    signSchnorrRaw,
    verifySchnorrRaw,
    verifySchnorrRawAsync,
    x25519Generate,
    x25519Shared,
    sessionKey,
    aeadSeal: seal,
    aeadOpen: open,
    DEFAULT_RELAYS,
  };
  window.SosMd2PairingSession = App.Md2PairingSession;
})(window);
