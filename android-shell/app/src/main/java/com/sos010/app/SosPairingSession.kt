package com.sos010.app

import fr.acinq.secp256k1.Hex
import org.json.JSONObject
import java.security.SecureRandom

/**
 * MD2 — Authenticated QR pairing session (protocol only).
 *
 * Completes: QR ↔ hello ↔ transcript/session-key ↔ PoP ↔ AEAD channel ready.
 * Does NOT: DeviceAuthorization, recovery capsule, history sync, WebRTC transport.
 *
 * Transport is abstract: callers exchange opaque message strings (tests use in-memory pipe).
 * HYPER CORE TECH
 */
object SosPairingSession {

    enum class State {
        IDLE,
        QR_SHOWN,
        QR_PARSED,
        HELLO_SENT,
        HELLO_RECEIVED,
        CHANNEL_READY,
        FAILED,
    }

    /** Authenticated destination binding — input for MD3 DeviceAuthorization. */
    data class BoundDestination(
        val pairingId: String,
        val deviceId: String,
        val dSignPub: String,
        val dEncPub: String,
        val transcriptHex: String,
        val sas: String,
        val fingerprint: String,
        val purpose: SosPairingCrypto.Purpose,
        val storageClass: String = "",
        val recoveryEligible: Boolean = false,
        val hardwareBacked: Boolean = false,
    )

    sealed class StepResult {
        data class Ok(
            val state: State,
            val outboundMessage: String? = null,
            val qr: String? = null,
            val bound: BoundDestination? = null,
            val sas: String? = null,
        ) : StepResult()
        data class Err(val code: String, val state: State = State.FAILED) : StepResult()
    }

    /**
     * Desktop / initiator: shows QR for local device identity, answers hello with PoP.
     */
    class Initiator(
        private val device: SosDeviceIdentityStore.Engine,
        private val random: SecureRandom = SecureRandom(),
        private val ttlMs: Long = SosPairingCrypto.DEFAULT_TTL_MS,
        private val purpose: SosPairingCrypto.Purpose = SosPairingCrypto.Purpose.LINK,
        private val rendezvous: String? = null,
    ) {
        private var state: State = State.IDLE
        private var pairingId: String = ""
        private var nonce: String = ""
        private var expiresAt: Long = 0L
        private var ePriv: ByteArray? = null
        private var ePubHex: String = ""
        private var dSignPub: String = ""
        private var dEncPub: String = ""
        private var deviceIdLocal: String = ""
        private var storageClassLocal: String = ""
        private var recoveryEligibleLocal: Boolean = false
        private var hardwareBackedLocal: Boolean = false
        private var transcript: ByteArray? = null
        private var sessionKey: ByteArray? = null
        private var bound: BoundDestination? = null

        fun state(): State = state
        fun boundDestination(): BoundDestination? = bound

        fun begin(): StepResult {
            if (state != State.IDLE && state != State.FAILED) {
                return StepResult.Err("BAD_STATE", state)
            }
            clearSecrets()
            when (val created = device.createOrGet()) {
                is SosDeviceIdentityStore.CreateResult.Err ->
                    return StepResult.Err(created.code, State.FAILED)
                is SosDeviceIdentityStore.CreateResult.Ok -> {
                    dSignPub = created.metadata.dSignPub
                    dEncPub = created.metadata.dEncPub
                    deviceIdLocal = created.metadata.deviceId
                    storageClassLocal = created.metadata.storageClass.name
                    recoveryEligibleLocal = created.metadata.recoveryEligible
                    hardwareBackedLocal = created.metadata.hardwareBacked
                }
            }
            val (priv, pub) = SosX25519.generateKeyPair(random)
            ePriv = priv
            ePubHex = Hex.encode(pub)
            pairingId = SosPairingCrypto.newPairingId(random)
            nonce = SosPairingCrypto.newNonce(random)
            expiresAt = System.currentTimeMillis() + ttlMs
            val payload = SosPairingCrypto.QrPayload(
                protocolVersion = SosPairingCrypto.PROTOCOL_VERSION,
                pairingId = pairingId,
                dSignPub = dSignPub,
                dEncPub = dEncPub,
                eEphemeralPub = ePubHex,
                nonce = nonce,
                expiresAt = expiresAt,
                purpose = purpose,
                deviceId = deviceIdLocal,
                storageClass = storageClassLocal,
                recoveryEligible = recoveryEligibleLocal,
                hardwareBacked = hardwareBackedLocal,
                rendezvous = rendezvous,
            )
            val qr = SosPairingCrypto.encodeQr(payload)
            state = State.QR_SHOWN
            return StepResult.Ok(state = state, qr = qr)
        }

        /** Process inbound transport message from phone. */
        fun onMessage(raw: String): StepResult {
            return try {
                when (state) {
                    State.QR_SHOWN -> handleHello(raw)
                    State.HELLO_RECEIVED, State.CHANNEL_READY -> handleAead(raw)
                    else -> StepResult.Err("BAD_STATE_$state", state)
                }
            } catch (_: Exception) {
                state = State.FAILED
                StepResult.Err("MESSAGE_FAIL", state)
            }
        }

        private fun handleHello(raw: String): StepResult {
            val o = JSONObject(raw)
            if (o.optString("type") != "hello") return StepResult.Err("EXPECTED_HELLO", state)
            if (o.optString("pairingId") != pairingId) return StepResult.Err("PAIRING_ID_MISMATCH", state)
            val ePhone = SosDeviceKeyCrypto.normalizeHex(o.getString("E_phone_pub"))
            if (!SosDeviceKeyCrypto.isHex64(ePhone)) return StepResult.Err("BAD_E_PHONE", state)

            val ePrivLocal = ePriv ?: return StepResult.Err("NO_EPH", state)
            val shared = SosX25519.sharedSecret(ePrivLocal, Hex.decode(ePhone))
            val tr = SosPairingCrypto.transcript(
                protocolVersion = SosPairingCrypto.PROTOCOL_VERSION,
                pairingId = pairingId,
                dSignPub = dSignPub,
                dEncPub = dEncPub,
                eDesktopPub = ePubHex,
                ePhonePub = ePhone,
                nonce = nonce,
                expiresAt = expiresAt,
                rendezvous = rendezvous,
            )
            val sk = SosPairingCrypto.sessionKey(shared, tr)
            SosDeviceKeyCrypto.zeroize(shared)
            transcript = tr
            sessionKey = sk
            state = State.HELLO_RECEIVED

            val pop = device.signPairingPop(tr)
            if (pop !is SosDeviceIdentityStore.OpResult.Ok) {
                state = State.FAILED
                return StepResult.Err((pop as SosDeviceIdentityStore.OpResult.Err).code, state)
            }
            val popBody = JSONObject()
                .put("type", "pop")
                .put("pairingId", pairingId)
                .put("sig", pop.signatureHex)
                .toString()
                .toByteArray(Charsets.UTF_8)
            val sealed = SosPairingCrypto.seal(sk, tr, popBody, random)
            val outbound = JSONObject()
                .put("type", "aead")
                .put("pairingId", pairingId)
                .put("iv", sealed.ivB64)
                .put("ct", sealed.ctB64)
                .toString()

            // Initiator is ready after sending PoP; phone verifies to reach CHANNEL_READY.
            // Local initiator marks CHANNEL_READY once phone ACKs.
            return StepResult.Ok(
                state = state,
                outboundMessage = outbound,
                sas = SosPairingCrypto.sasDigits(tr),
            )
        }

        private fun handleAead(raw: String): StepResult {
            val sk = sessionKey ?: return StepResult.Err("NO_SESSION", state)
            val tr = transcript ?: return StepResult.Err("NO_TRANSCRIPT", state)
            val o = JSONObject(raw)
            if (o.optString("type") != "aead") return StepResult.Err("EXPECTED_AEAD", state)
            if (o.optString("pairingId") != pairingId) return StepResult.Err("PAIRING_ID_MISMATCH", state)
            val plain = SosPairingCrypto.open(
                sk,
                tr,
                SosPairingCrypto.SealedMessage(o.getString("iv"), o.getString("ct")),
            ) ?: return StepResult.Err("AEAD_FAIL", state)
            val body = JSONObject(String(plain, Charsets.UTF_8))
            when (body.optString("type")) {
                "ack" -> {
                    bound = BoundDestination(
                        pairingId = pairingId,
                        deviceId = deviceIdLocal,
                        dSignPub = dSignPub,
                        dEncPub = dEncPub,
                        transcriptHex = Hex.encode(tr),
                        sas = SosPairingCrypto.sasDigits(tr),
                        fingerprint = SosPairingCrypto.deviceFingerprint(dSignPub, dEncPub),
                        purpose = purpose,
                        storageClass = storageClassLocal,
                        recoveryEligible = recoveryEligibleLocal,
                        hardwareBacked = hardwareBackedLocal,
                    )
                    state = State.CHANNEL_READY
                    return StepResult.Ok(state = state, bound = bound, sas = bound!!.sas)
                }
                else -> return StepResult.Err("UNEXPECTED_BODY", state)
            }
        }

        fun clearSecrets() {
            SosDeviceKeyCrypto.zeroize(ePriv, sessionKey)
            ePriv = null
            sessionKey = null
            // Keep transcript for bound metadata until cleared explicitly after MD3 handoff.
        }

        /** MD3 handoff: copy of AEAD channel secrets while CHANNEL_READY (caller must zeroize). */
        fun exportChannelSecrets(): Pair<ByteArray, ByteArray>? {
            if (state != State.CHANNEL_READY) return null
            val sk = sessionKey ?: return null
            val tr = transcript ?: return null
            return sk.copyOf() to tr.copyOf()
        }
    }

    /**
     * Phone / responder: parses QR, sends hello, verifies PoP, AEAD ack.
     * Does NOT sign DeviceAuthorization (MD3).
     */
    class Responder(
        private val spent: SosPairingSpentStore = SosPairingSpentStore(),
        private val random: SecureRandom = SecureRandom(),
        private val nowMs: () -> Long = { System.currentTimeMillis() },
    ) {
        private var state: State = State.IDLE
        private var qr: SosPairingCrypto.QrPayload? = null
        private var ePriv: ByteArray? = null
        private var ePubHex: String = ""
        private var transcript: ByteArray? = null
        private var sessionKey: ByteArray? = null
        private var bound: BoundDestination? = null
        private var consumed: Boolean = false

        fun state(): State = state
        fun boundDestination(): BoundDestination? = bound
        fun sas(): String? = transcript?.let { SosPairingCrypto.sasDigits(it) }

        fun acceptQr(qrText: String): StepResult {
            if (state != State.IDLE && state != State.FAILED) {
                return StepResult.Err("BAD_STATE", state)
            }
            clearSecrets()
            consumed = false
            val parsed = SosPairingCrypto.parseQr(qrText, nowMs()).getOrElse {
                state = State.FAILED
                return StepResult.Err(it.message ?: "QR_FAIL", state)
            }
            if (spent.isSpent(parsed.pairingId, parsed.nonce)) {
                state = State.FAILED
                return StepResult.Err("REPLAY", state)
            }
            qr = parsed
            val (priv, pub) = SosX25519.generateKeyPair(random)
            ePriv = priv
            ePubHex = Hex.encode(pub)
            state = State.QR_PARSED

            val hello = JSONObject()
                .put("type", "hello")
                .put("pairingId", parsed.pairingId)
                .put("E_phone_pub", ePubHex)
                .toString()
            state = State.HELLO_SENT
            return StepResult.Ok(
                state = state,
                outboundMessage = hello,
                sas = null, // SAS available after transcript finalized on PoP
                bound = null,
            )
        }

        fun onMessage(raw: String): StepResult {
            return try {
                when (state) {
                    State.HELLO_SENT -> handlePopAead(raw)
                    else -> StepResult.Err("BAD_STATE_$state", state)
                }
            } catch (_: Exception) {
                state = State.FAILED
                StepResult.Err("MESSAGE_FAIL", state)
            }
        }

        private fun handlePopAead(raw: String): StepResult {
            val payload = qr ?: return StepResult.Err("NO_QR", state)
            val ePrivLocal = ePriv ?: return StepResult.Err("NO_EPH", state)
            val o = JSONObject(raw)
            if (o.optString("type") != "aead") return StepResult.Err("EXPECTED_AEAD", state)
            if (o.optString("pairingId") != payload.pairingId) {
                return StepResult.Err("PAIRING_ID_MISMATCH", state)
            }

            val shared = SosX25519.sharedSecret(ePrivLocal, Hex.decode(payload.eEphemeralPub))
            val tr = SosPairingCrypto.transcript(
                protocolVersion = payload.protocolVersion,
                pairingId = payload.pairingId,
                dSignPub = payload.dSignPub,
                dEncPub = payload.dEncPub,
                eDesktopPub = payload.eEphemeralPub,
                ePhonePub = ePubHex,
                nonce = payload.nonce,
                expiresAt = payload.expiresAt,
                rendezvous = payload.rendezvous,
            )
            val sk = SosPairingCrypto.sessionKey(shared, tr)
            SosDeviceKeyCrypto.zeroize(shared)

            val plain = SosPairingCrypto.open(
                sk,
                tr,
                SosPairingCrypto.SealedMessage(o.getString("iv"), o.getString("ct")),
            )
            if (plain == null) {
                SosDeviceKeyCrypto.zeroize(sk)
                state = State.FAILED
                return StepResult.Err("AEAD_FAIL", state)
            }
            val body = JSONObject(String(plain, Charsets.UTF_8))
            if (body.optString("type") != "pop") {
                SosDeviceKeyCrypto.zeroize(sk)
                state = State.FAILED
                return StepResult.Err("EXPECTED_POP", state)
            }
            val sigHex = SosDeviceKeyCrypto.normalizeHex(body.getString("sig"))
            val sig = Hex.decode(sigHex)
            val ok = SosDeviceKeyCrypto.verifyPairingPop(payload.dSignPub, tr, sig)
            if (!ok) {
                SosDeviceKeyCrypto.zeroize(sk)
                state = State.FAILED
                return StepResult.Err("POP_FAIL", state)
            }

            // Consume replay token only after successful PoP (binds exact D from QR).
            if (!spent.tryConsume(payload.pairingId, payload.nonce, nowMs())) {
                SosDeviceKeyCrypto.zeroize(sk)
                state = State.FAILED
                return StepResult.Err("REPLAY", state)
            }
            consumed = true
            transcript = tr
            sessionKey = sk

            val ackBody = JSONObject()
                .put("type", "ack")
                .put("pairingId", payload.pairingId)
                .put("boundDSignPub", payload.dSignPub)
                .put("boundDEncPub", payload.dEncPub)
                .put("deviceId", payload.deviceId)
                .put("storageClass", payload.storageClass)
                .put("recoveryEligible", payload.recoveryEligible)
                .put("hardwareBacked", payload.hardwareBacked)
                .toString()
                .toByteArray(Charsets.UTF_8)
            val sealed = SosPairingCrypto.seal(sk, tr, ackBody, random)
            val outbound = JSONObject()
                .put("type", "aead")
                .put("pairingId", payload.pairingId)
                .put("iv", sealed.ivB64)
                .put("ct", sealed.ctB64)
                .toString()

            bound = BoundDestination(
                pairingId = payload.pairingId,
                deviceId = payload.deviceId,
                dSignPub = payload.dSignPub,
                dEncPub = payload.dEncPub,
                transcriptHex = Hex.encode(tr),
                sas = SosPairingCrypto.sasDigits(tr),
                fingerprint = SosPairingCrypto.deviceFingerprint(payload.dSignPub, payload.dEncPub),
                purpose = payload.purpose,
                storageClass = payload.storageClass,
                recoveryEligible = payload.recoveryEligible,
                hardwareBacked = payload.hardwareBacked,
            )
            state = State.CHANNEL_READY
            return StepResult.Ok(
                state = state,
                outboundMessage = outbound,
                bound = bound,
                sas = bound!!.sas,
            )
        }

        fun clearSecrets() {
            SosDeviceKeyCrypto.zeroize(ePriv, sessionKey)
            ePriv = null
            sessionKey = null
        }

        fun exportChannelSecrets(): Pair<ByteArray, ByteArray>? {
            if (state != State.CHANNEL_READY) return null
            val sk = sessionKey ?: return null
            val tr = transcript ?: return null
            return sk.copyOf() to tr.copyOf()
        }
    }

    /** In-memory pipe helper for tests / local protocol QA. */
    data class PairedChannel(
        val bound: BoundDestination,
        val sessionKey: ByteArray,
        val transcript: ByteArray,
        val initiator: Initiator,
        val responder: Responder,
    )

    fun runLocalPairing(
        initiatorDevice: SosDeviceIdentityStore.Engine,
        spent: SosPairingSpentStore = SosPairingSpentStore(),
    ): BoundDestination = runLocalPairingWithChannel(initiatorDevice, spent).bound

    fun runLocalPairingWithChannel(
        initiatorDevice: SosDeviceIdentityStore.Engine,
        spent: SosPairingSpentStore = SosPairingSpentStore(),
    ): PairedChannel {
        val init = Initiator(initiatorDevice)
        val resp = Responder(spent)
        val begin = init.begin() as StepResult.Ok
        val qr = begin.qr ?: error("no_qr")
        val hello = resp.acceptQr(qr) as StepResult.Ok
        val pop = init.onMessage(hello.outboundMessage!!) as StepResult.Ok
        val ack = resp.onMessage(pop.outboundMessage!!) as StepResult.Ok
        val done = init.onMessage(ack.outboundMessage!!) as StepResult.Ok
        require(done.state == State.CHANNEL_READY && ack.state == State.CHANNEL_READY)
        val secrets = init.exportChannelSecrets() ?: error("no_channel")
        return PairedChannel(
            bound = done.bound!!,
            sessionKey = secrets.first,
            transcript = secrets.second,
            initiator = init,
            responder = resp,
        )
    }
}
