package com.sos010.app

import fr.acinq.secp256k1.Hex
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * MD3 — Typed AUTHORIZE_LINKED_DEVICE ceremony.
 *
 * Root signing path:
 * SosSecureIdentityStore (native) → domain-separated Schnorr (SOS_DEVICE_AUTHORIZATION_V1)
 * → never returns K; requires exact confirmation payload + session account match.
 *
 * Atomicity: ACTIVE only after root sign + destination verify + phone registry + ACK.
 * HYPER CORE TECH
 */
object SosDeviceAuthorizationCeremony {

    const val OP = "AUTHORIZE_LINKED_DEVICE"
    const val DEVICE_AUTH_GENERIC_ROOT_SIGNER_CREATED = false
    const val ROOT_K_EXPOSED_FOR_DEVICE_AUTH = false

    enum class Phase {
        IDLE,
        PENDING_CONFIRM,
        SIGNED_LOCAL,
        DELIVERED_PENDING_ACK,
        LINKED_AUTHORIZED,
        FAILED,
        CANCELLED,
    }

    data class ConfirmIntent(
        val accountP: String,
        val deviceId: String,
        val dSignPub: String,
        val dEncPub: String,
        val capabilities: Set<SosDeviceAuthorization.Capability>,
        val authEpoch: Long,
        val pairingTranscriptHash: String,
        val authorizationId: String,
        val recoveryEnabled: Boolean,
        val deviceLabel: String,
        val storageSecurityClass: String,
    ) {
        fun payloadHash(): String {
            val draft = SosDeviceAuthorization.Authorization(
                version = SosDeviceAuthorization.VERSION,
                authorizationId = authorizationId,
                accountP = accountP,
                deviceId = deviceId,
                dSignPub = dSignPub,
                dEncPub = dEncPub,
                capabilities = capabilities,
                authEpoch = authEpoch,
                createdAt = 0L, // not in confirm bind — bound via authorizationId + fields below
                expiresAt = 0L,
                pairingTranscriptHash = pairingTranscriptHash,
                pairingId = "",
                storageSecurityClass = storageSecurityClass,
                recoveryEligibleAtAuthorization = recoveryEnabled,
                deviceLabel = deviceLabel,
            )
            // Bind confirmation to stable semantic fields (not timestamps).
            return SosDeviceKeyCrypto.normalizeHex(
                Hex.encode(
                    java.security.MessageDigest.getInstance("SHA-256").digest(
                        listOf(
                            SosDeviceAuthorization.DOMAIN,
                            "confirm",
                            draft.accountP,
                            draft.deviceId,
                            draft.dSignPub,
                            draft.dEncPub,
                            draft.capabilities.map { it.name }.sorted().joinToString(","),
                            draft.authEpoch.toString(),
                            draft.pairingTranscriptHash,
                            draft.authorizationId,
                            draft.recoveryEligibleAtAuthorization.toString(),
                            draft.storageSecurityClass,
                        ).joinToString("|").toByteArray(),
                    ),
                ),
            )
        }
    }

    /** Test/production-injectable confirmation: binds exact payload hash; one-time consume. */
    class ConfirmationGate {
        private data class Pending(val hash: String, var approved: Boolean = false, var consumed: Boolean = false)
        private val pending = ConcurrentHashMap<String, Pending>()

        fun create(intent: ConfirmIntent): String {
            val id = Hex.encode(ByteArray(16).also { SecureRandom().nextBytes(it) })
            pending[id] = Pending(hash = intent.payloadHash())
            return id
        }

        fun approveFromNativeUi(challengeId: String): Boolean {
            val p = pending[challengeId] ?: return false
            if (p.consumed) return false
            p.approved = true
            return true
        }

        fun cancel(challengeId: String) {
            pending.remove(challengeId)
        }

        fun consume(challengeId: String, intent: ConfirmIntent): String? {
            val p = pending[challengeId] ?: return "NO_CHALLENGE"
            if (!p.approved) return "NOT_APPROVED"
            if (p.consumed) return "ALREADY_CONSUMED"
            if (p.hash != intent.payloadHash()) return "PAYLOAD_MUTATION"
            p.consumed = true
            pending.remove(challengeId)
            return null
        }
    }

    data class SessionCtx(
        val accountPubkey: String,
        val sessionValid: Boolean,
        val loggedIn: Boolean = true,
    )

    sealed class Result {
        data class Ok(
            val phase: Phase,
            val authorization: SosDeviceAuthorization.Authorization? = null,
            val outboundAeadJson: String? = null,
            val challengeId: String? = null,
            val confirmIntent: ConfirmIntent? = null,
        ) : Result()
        data class Err(val code: String, val phase: Phase = Phase.FAILED) : Result()
    }

    class PhoneIssuer(
        private val identity: SosSecureIdentityStore.Engine,
        private val registry: SosDeviceAuthorizationRegistry,
        private val confirm: ConfirmationGate = ConfirmationGate(),
        private val random: SecureRandom = SecureRandom(),
        private val nowMs: () -> Long = { System.currentTimeMillis() },
        private val lifetimeMs: Long = SosDeviceAuthorization.DEFAULT_LIFETIME_MS,
    ) {
        private var phase = Phase.IDLE
        private var bound: SosPairingSession.BoundDestination? = null
        private var intent: ConfirmIntent? = null
        private var challengeId: String? = null
        private var draft: SosDeviceAuthorization.Authorization? = null
        private var signed: SosDeviceAuthorization.Authorization? = null
        private var pairingConsumed = false
        private val rootSignCount = AtomicInteger(0)
        private val spentPairings = ConcurrentHashMap.newKeySet<String>()
        private var sessionKey: ByteArray? = null
        private var transcript: ByteArray? = null
        private var cancelledAfterSign = false

        fun phase(): Phase = phase
        fun rootSignCount(): Int = rootSignCount.get()
        fun confirmation(): ConfirmationGate = confirm

        /**
         * Begin from MD2 CHANNEL_READY bound destination.
         * @param offerRecoveryDefault owner policy default checkbox state; still requires explicit confirm.
         */
        fun beginFromBound(
            bound: SosPairingSession.BoundDestination,
            session: SessionCtx,
            offerRecoveryDefault: Boolean = SosDeviceKeyPolicy.RECOVERY_CAPABLE_DEFAULT,
            deviceLabel: String = "Computer",
            deviceType: String = "DESKTOP",
            sessionKey: ByteArray? = null,
            transcript: ByteArray? = null,
        ): Result {
            if (phase != Phase.IDLE && phase != Phase.FAILED && phase != Phase.CANCELLED &&
                phase != Phase.LINKED_AUTHORIZED
            ) {
                return Result.Err("BAD_PHASE", phase)
            }
            resetLocal(keepSpent = true)
            if (!session.loggedIn || !session.sessionValid) {
                return Result.Err("SESSION_INVALID")
            }
            val account = SosDeviceKeyCrypto.normalizeHex(session.accountPubkey)
            val id = identity.readIdentityForNativeUse()
                ?: return Result.Err("NO_SECURE_IDENTITY")
            if (SosDeviceKeyCrypto.normalizeHex(id.publicKeyHex) != account) {
                return Result.Err("ACCOUNT_MISMATCH")
            }
            if (spentPairings.contains(bound.pairingId)) {
                return Result.Err("PAIRING_ALREADY_CONSUMED")
            }
            if (!SosDeviceKeyCrypto.isHex64(bound.deviceId)) {
                return Result.Err("BAD_DEVICE_ID")
            }

            val wantRecovery = offerRecoveryDefault && bound.recoveryEligible
            val caps = try {
                SosDeviceAuthorization.resolveCapabilities(
                    includeRecovery = wantRecovery,
                    recoveryEligible = bound.recoveryEligible,
                    storageClass = bound.storageClass,
                    userConfirmedRecovery = wantRecovery, // confirm UI will re-bind; draft uses offered set
                )
            } catch (e: IllegalArgumentException) {
                return Result.Err(e.message ?: "CAPABILITY_POLICY")
            }

            val authId = SosDeviceAuthorization.newAuthorizationId(random)
            val created = nowMs()
            val draftAuth = SosDeviceAuthorization.Authorization(
                version = SosDeviceAuthorization.VERSION,
                authorizationId = authId,
                accountP = account,
                deviceId = bound.deviceId,
                dSignPub = bound.dSignPub,
                dEncPub = bound.dEncPub,
                capabilities = caps,
                authEpoch = SosDeviceAuthorization.AUTH_EPOCH_INITIAL,
                createdAt = created,
                expiresAt = created + lifetimeMs,
                pairingTranscriptHash = bound.transcriptHex,
                pairingId = bound.pairingId,
                storageSecurityClass = bound.storageClass,
                recoveryEligibleAtAuthorization = SosDeviceAuthorization.Capability.DEVICE_RECOVERY in caps,
                deviceLabel = SosDeviceAuthorization.sanitizeLabel(deviceLabel),
                deviceType = SosDeviceAuthorization.sanitizeLabel(deviceType),
            )
            // Recovery requires explicit confirmation flag in intent
            val confirmIntent = ConfirmIntent(
                accountP = account,
                deviceId = draftAuth.deviceId,
                dSignPub = draftAuth.dSignPub,
                dEncPub = draftAuth.dEncPub,
                capabilities = draftAuth.capabilities,
                authEpoch = draftAuth.authEpoch,
                pairingTranscriptHash = draftAuth.pairingTranscriptHash,
                authorizationId = draftAuth.authorizationId,
                recoveryEnabled = SosDeviceAuthorization.Capability.DEVICE_RECOVERY in draftAuth.capabilities,
                deviceLabel = draftAuth.deviceLabel,
                storageSecurityClass = draftAuth.storageSecurityClass,
            )
            val ch = confirm.create(confirmIntent)
            this.bound = bound
            this.intent = confirmIntent
            this.challengeId = ch
            this.draft = draftAuth
            this.sessionKey = sessionKey?.copyOf()
            this.transcript = transcript?.copyOf()
            phase = Phase.PENDING_CONFIRM
            return Result.Ok(phase = phase, challengeId = ch, confirmIntent = confirmIntent, authorization = draftAuth)
        }

        fun cancel(): Result {
            val ch = challengeId
            if (ch != null) confirm.cancel(ch)
            if (phase == Phase.SIGNED_LOCAL || phase == Phase.DELIVERED_PENDING_ACK) {
                // Do not activate
                cancelledAfterSign = true
                signed = null
            }
            phase = Phase.CANCELLED
            resetLocal(keepSpent = true)
            return Result.Ok(phase = phase)
        }

        /**
         * After native UI approve + consume confirmation: sign under root and optionally seal for delivery.
         * Does not put ACTIVE until destination ACK.
         */
        fun signAfterConfirm(session: SessionCtx): Result {
            if (phase != Phase.PENDING_CONFIRM) return Result.Err("BAD_PHASE", phase)
            val intentLocal = intent ?: return Result.Err("NO_INTENT")
            val ch = challengeId ?: return Result.Err("NO_CHALLENGE")
            val draftAuth = draft ?: return Result.Err("NO_DRAFT")
            val boundLocal = bound ?: return Result.Err("NO_BOUND")

            if (!session.loggedIn || !session.sessionValid) return Result.Err("SESSION_INVALID")
            val account = SosDeviceKeyCrypto.normalizeHex(session.accountPubkey)
            if (account != intentLocal.accountP) return Result.Err("ACCOUNT_SWITCH")

            val consumeErr = confirm.consume(ch, intentLocal)
            if (consumeErr != null) return Result.Err(consumeErr)

            // Re-check pairing not consumed / keys unchanged
            if (spentPairings.contains(boundLocal.pairingId)) return Result.Err("PAIRING_ALREADY_CONSUMED")
            if (draftAuth.dSignPub != boundLocal.dSignPub || draftAuth.dEncPub != boundLocal.dEncPub) {
                return Result.Err("DEVICE_KEY_MUTATION")
            }
            if (intentLocal.capabilities != draftAuth.capabilities) {
                return Result.Err("CAPABILITY_MUTATION")
            }

            val id = identity.readIdentityForNativeUse() ?: return Result.Err("NO_SECURE_IDENTITY")
            if (SosDeviceKeyCrypto.normalizeHex(id.publicKeyHex) != account) {
                return Result.Err("ACCOUNT_MISMATCH")
            }

            // Refresh createdAt/expiresAt at sign time (still within confirmation bind via authId+fields)
            val created = nowMs()
            val toSign = draftAuth.copy(createdAt = created, expiresAt = created + lifetimeMs)
            val signedAuth = try {
                rootSignCount.incrementAndGet()
                SosDeviceAuthorization.signUnderRoot(id.privateKeyHex, toSign)
            } catch (_: Exception) {
                return Result.Err("SIGN_FAILED")
            }
            when (val v = SosDeviceAuthorization.verifyStrict(signedAuth, nowMs())) {
                is SosDeviceAuthorization.VerifyResult.Err -> return Result.Err(v.code)
                SosDeviceAuthorization.VerifyResult.Ok -> Unit
            }

            signed = signedAuth
            phase = Phase.SIGNED_LOCAL

            val sk = sessionKey
            val tr = transcript
            val outbound = if (sk != null && tr != null) {
                val body = JSONObject()
                    .put("type", "device_authorization")
                    .put("authorization", signedAuth.toPublicJson())
                    .toString()
                    .toByteArray(Charsets.UTF_8)
                val sealed = SosPairingCrypto.seal(sk, tr, body, random)
                JSONObject()
                    .put("type", "aead")
                    .put("pairingId", boundLocal.pairingId)
                    .put("iv", sealed.ivB64)
                    .put("ct", sealed.ctB64)
                    .toString()
            } else null

            if (outbound != null) phase = Phase.DELIVERED_PENDING_ACK
            return Result.Ok(phase = phase, authorization = signedAuth, outboundAeadJson = outbound)
        }

        fun onDestinationAck(ackAeadJson: String): Result {
            if (phase != Phase.DELIVERED_PENDING_ACK && phase != Phase.SIGNED_LOCAL) {
                return Result.Err("BAD_PHASE", phase)
            }
            if (cancelledAfterSign) return Result.Err("CANCELLED")
            val signedAuth = signed ?: return Result.Err("NO_SIGNED")
            val boundLocal = bound ?: return Result.Err("NO_BOUND")
            val sk = sessionKey ?: return Result.Err("NO_SESSION_KEY")
            val tr = transcript ?: return Result.Err("NO_TRANSCRIPT")

            val o = JSONObject(ackAeadJson)
            if (o.optString("type") != "aead") return Result.Err("EXPECTED_AEAD")
            val plain = SosPairingCrypto.open(
                sk,
                tr,
                SosPairingCrypto.SealedMessage(o.getString("iv"), o.getString("ct")),
            ) ?: return Result.Err("AEAD_FAIL")
            val body = JSONObject(String(plain, Charsets.UTF_8))
            if (body.optString("type") != "device_auth_ack") return Result.Err("EXPECTED_ACK")
            if (SosDeviceKeyCrypto.normalizeHex(body.optString("authorizationId")) != signedAuth.authorizationId) {
                return Result.Err("ACK_AUTH_ID_MISMATCH")
            }
            if (SosDeviceKeyCrypto.normalizeHex(body.optString("deviceId")) != signedAuth.deviceId) {
                return Result.Err("ACK_DEVICE_MISMATCH")
            }
            if (SosDeviceKeyCrypto.normalizeHex(body.optString("accountP")) != signedAuth.accountP) {
                return Result.Err("ACK_ACCOUNT_MISMATCH")
            }

            when (val put = registry.putActive(signedAuth, nowMs())) {
                is SosDeviceAuthorizationRegistry.PutResult.Err -> return Result.Err(put.code)
                is SosDeviceAuthorizationRegistry.PutResult.Ok -> Unit
            }
            spentPairings.add(boundLocal.pairingId)
            pairingConsumed = true
            phase = Phase.LINKED_AUTHORIZED
            val done = signedAuth
            resetSecretsOnly()
            return Result.Ok(phase = phase, authorization = done)
        }

        /** Test helper: commit locally when delivery channel not wired (still requires confirm+sign). */
        fun commitLocalWithoutDeliveryForTests(): Result {
            if (phase != Phase.SIGNED_LOCAL) return Result.Err("BAD_PHASE", phase)
            val signedAuth = signed ?: return Result.Err("NO_SIGNED")
            val boundLocal = bound ?: return Result.Err("NO_BOUND")
            when (val put = registry.putActive(signedAuth, nowMs())) {
                is SosDeviceAuthorizationRegistry.PutResult.Err -> return Result.Err(put.code)
                is SosDeviceAuthorizationRegistry.PutResult.Ok -> Unit
            }
            spentPairings.add(boundLocal.pairingId)
            pairingConsumed = true
            phase = Phase.LINKED_AUTHORIZED
            return Result.Ok(phase = phase, authorization = signedAuth)
        }

        private fun resetSecretsOnly() {
            SosDeviceKeyCrypto.zeroize(sessionKey)
            sessionKey = null
            transcript = null
        }

        private fun resetLocal(keepSpent: Boolean) {
            resetSecretsOnly()
            bound = null
            intent = null
            challengeId = null
            draft = null
            signed = null
            pairingConsumed = false
            cancelledAfterSign = false
            if (!keepSpent) spentPairings.clear()
        }
    }

    class DestinationAcceptor(
        private val device: SosDeviceIdentityStore.Engine,
        private val random: SecureRandom = SecureRandom(),
    ) {
        private var stored: SosDeviceAuthorization.Authorization? = null

        fun storedAuthorization(): SosDeviceAuthorization.Authorization? = stored

        fun acceptAead(
            aeadJson: String,
            sessionKey: ByteArray,
            transcript: ByteArray,
            expectedAccountP: String,
        ): Result {
            val meta = device.getPublicMetadata() ?: return Result.Err("NO_DEVICE")
            val o = JSONObject(aeadJson)
            if (o.optString("type") != "aead") return Result.Err("EXPECTED_AEAD")
            val plain = SosPairingCrypto.open(
                sessionKey,
                transcript,
                SosPairingCrypto.SealedMessage(o.getString("iv"), o.getString("ct")),
            ) ?: return Result.Err("AEAD_FAIL")
            val body = JSONObject(String(plain, Charsets.UTF_8))
            if (body.optString("type") != "device_authorization") return Result.Err("EXPECTED_AUTH")
            val auth = SosDeviceAuthorization.Authorization.fromJson(body.getJSONObject("authorization"))
            when (
                val v = SosDeviceAuthorization.verifyForDestination(
                    auth = auth,
                    localDeviceId = meta.deviceId,
                    localDSignPub = meta.dSignPub,
                    localDEncPub = meta.dEncPub,
                    expectedAccountP = expectedAccountP,
                )
            ) {
                is SosDeviceAuthorization.VerifyResult.Err -> return Result.Err(v.code)
                SosDeviceAuthorization.VerifyResult.Ok -> Unit
            }
            stored = auth
            val ackBody = JSONObject()
                .put("type", "device_auth_ack")
                .put("authorizationId", auth.authorizationId)
                .put("deviceId", auth.deviceId)
                .put("accountP", auth.accountP)
                .toString()
                .toByteArray(Charsets.UTF_8)
            val sealed = SosPairingCrypto.seal(sessionKey, transcript, ackBody, random)
            val outbound = JSONObject()
                .put("type", "aead")
                .put("pairingId", auth.pairingId)
                .put("iv", sealed.ivB64)
                .put("ct", sealed.ctB64)
                .toString()
            return Result.Ok(
                phase = Phase.LINKED_AUTHORIZED,
                authorization = auth,
                outboundAeadJson = outbound,
            )
        }
    }
}
