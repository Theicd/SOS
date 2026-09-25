package com.sos010.app

import fr.acinq.secp256k1.Hex
import fr.acinq.secp256k1.Secp256k1
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * F5B6 — Sealed same-identity migration of root K to an authorized DEVICE_RECOVERY destination.
 *
 * Uses F6G.3 SosNativeStrongConfirmation; reads K only in the private continuation after
 * biometric success + revalidation. No WebView secret API. No nsec. No history/capsule.
 * HYPER CORE TECH
 */
object SosSealedIdentityMigration {

    const val VERSION = "sos-sealed-migration-v1"
    const val DOMAIN = "SOS_SEALED_MIGRATION_V1"
    const val OPERATION = "SEALED_MIGRATION"
    const val HKDF_INFO = "SOS|sealed-migration|v1"
    const val ACK_DOMAIN = "SOS|sealed-migration|ack|v1"
    const val PLAINTEXT_DOMAIN = "SOS|mig|pt|v1"
    const val TTL_SECONDS = 120
    const val AEAD = "AES-256-GCM"
    const val KDF = "HKDF-SHA256"
    const val IV_BYTES = 12
    const val GCM_TAG_BITS = 128

    // QA / design invariants
    const val F5B6_NATIVE_MODULE_PRESENT = true
    const val F5B6_MIGRATION_IMPLEMENTED = true
    const val F5B6_OPERATION_FIXED = true
    const val GENERIC_SEAL_TO_PUBKEY_API_CREATED = false
    const val F5B6_GENERIC_ROOT_SECRET_API_CREATED = false
    const val F5B6_ANDROID_NATIVE_SOURCE_SUPPORTED = true
    const val F5B6_WEBVIEW_SOURCE_SUPPORTED = false
    const val F5B6_USES_F6G3_STRONG_CONFIRM = true
    const val PARALLEL_WEAKER_CONFIRMATION_CREATED = false
    const val F5B6_ACCEPTS_REUSABLE_APPROVAL_TOKEN = false
    const val F5B6_ACCEPTS_APPROVED_BOOLEAN = false
    const val F5B6_PRESERVES_SAME_K = true
    const val F5B6_PRESERVES_SAME_P = true
    const val F5B6_GENERATES_NEW_ROOT_IDENTITY = false
    const val F5B6_NSEC_CREATED = false
    const val F5B6_TRANSFERS_MESSAGE_HISTORY = false
    const val F5B6_TRANSFERS_CONVERSATION_KEYS = false
    const val RECOVERY_CAPSULE_IMPLEMENTED_IN_F5B6 = false
    const val DELEGATED_DEVICE_NOSTR_EVENT_IMPLEMENTED = false
    const val WINDOWS_F5B6_RUNTIME_IMPLEMENTED = false
    const val F5B6_CORE_PROTOCOL_TESTABLE_WITHOUT_WINDOWS = true
    const val SAME_ACCOUNT_REIMPORT_POLICY = "IDEMPOTENT_ACK_WITHOUT_REIMPORT_OR_SAFE_SAME_K_RESEAL"
    const val F5B6_ATOMICITY_MODEL =
        "CEREMONY_MEMORY_ONLY; source restart requires fresh strong-confirm; identical envelope returns same ACK; no second identity"
    const val F5B6_IDENTICAL_RETRANSMISSION_POLICY =
        "SAME_ENVELOPE_HASH_RETURNS_CACHED_ACK_WITHOUT_REUNWRAP"
    const val F5B6_CIPHERTEXT_ENVELOPE_PERSISTENCE =
        "TRANSIENT_IN_MEMORY_FOR_TRANSPORT_ONLY; plaintext K never persisted by this module"
    const val F5B6_ENVELOPE_FORMAT =
        "sos-sealed-migration-v1{version,header,senderEphemeralPub,aeadNonce,ciphertext,rootSignature}"

    enum class State {
        IDLE,
        PREPARED,
        STRONG_CONFIRM_PENDING,
        AUTHORIZED_TO_SEAL,
        SEALED,
        DELIVERED,
        DESTINATION_VERIFIED,
        IMPORTED,
        ACK_PENDING,
        COMPLETE,
        CANCELLED,
        EXPIRED,
        FAILED,
    }

    data class MigrationHeader(
        val version: String = VERSION,
        val operation: String = OPERATION,
        val accountP: String,
        val authorizationId: String,
        val deviceId: String,
        val dSignPub: String,
        val dEncPub: String,
        val authEpoch: Long,
        val migrationId: String,
        val migrationNonce: String,
        val createdAt: Long,
        val expiresAt: Long,
        val pairingTranscriptHash: String,
        val senderEphemeralPub: String,
        val envelopeAlgorithm: String = "$KDF+$AEAD",
        val sessionGeneration: Long,
    ) {
        fun canonicalBytes(): ByteArray {
            val lines = listOf(
                DOMAIN,
                "version=$version",
                "operation=$operation",
                "accountP=${norm(accountP)}",
                "authorizationId=${norm(authorizationId)}",
                "deviceId=${norm(deviceId)}",
                "D_sign_pub=${norm(dSignPub)}",
                "D_enc_pub=${norm(dEncPub)}",
                "authEpoch=$authEpoch",
                "migrationId=${norm(migrationId)}",
                "migrationNonce=${norm(migrationNonce)}",
                "createdAt=$createdAt",
                "expiresAt=$expiresAt",
                "pairingTranscriptHash=${norm(pairingTranscriptHash)}",
                "senderEphemeralPub=${norm(senderEphemeralPub)}",
                "envelopeAlgorithm=$envelopeAlgorithm",
                "sessionGeneration=$sessionGeneration",
            )
            return lines.joinToString("\n").toByteArray(StandardCharsets.UTF_8)
        }

        fun headerHash(): ByteArray = sha256(canonicalBytes())

        fun toJson(): JSONObject = JSONObject()
            .put("version", version)
            .put("operation", operation)
            .put("accountP", norm(accountP))
            .put("authorizationId", norm(authorizationId))
            .put("deviceId", norm(deviceId))
            .put("D_sign_pub", norm(dSignPub))
            .put("D_enc_pub", norm(dEncPub))
            .put("authEpoch", authEpoch)
            .put("migrationId", norm(migrationId))
            .put("migrationNonce", norm(migrationNonce))
            .put("createdAt", createdAt)
            .put("expiresAt", expiresAt)
            .put("pairingTranscriptHash", norm(pairingTranscriptHash))
            .put("senderEphemeralPub", norm(senderEphemeralPub))
            .put("envelopeAlgorithm", envelopeAlgorithm)
            .put("sessionGeneration", sessionGeneration)

        companion object {
            fun fromJson(o: JSONObject): MigrationHeader? {
                return try {
                    if (o.getString("version") != VERSION) return null
                    if (o.getString("operation") != OPERATION) return null
                    MigrationHeader(
                        accountP = o.getString("accountP"),
                        authorizationId = o.getString("authorizationId"),
                        deviceId = o.getString("deviceId"),
                        dSignPub = o.getString("D_sign_pub"),
                        dEncPub = o.getString("D_enc_pub"),
                        authEpoch = o.getLong("authEpoch"),
                        migrationId = o.getString("migrationId"),
                        migrationNonce = o.getString("migrationNonce"),
                        createdAt = o.getLong("createdAt"),
                        expiresAt = o.getLong("expiresAt"),
                        pairingTranscriptHash = o.getString("pairingTranscriptHash"),
                        senderEphemeralPub = o.getString("senderEphemeralPub"),
                        envelopeAlgorithm = o.optString("envelopeAlgorithm", "$KDF+$AEAD"),
                        sessionGeneration = o.getLong("sessionGeneration"),
                    )
                } catch (_: Exception) {
                    null
                }
            }
        }
    }

    data class Envelope(
        val version: String = VERSION,
        val header: MigrationHeader,
        val aeadNonceB64: String,
        val ciphertextB64: String,
        val rootSignatureHex: String,
    ) {
        fun envelopeCommitment(): String {
            val md = MessageDigest.getInstance("SHA-256")
            md.update(header.canonicalBytes())
            md.update(Base64.getDecoder().decode(aeadNonceB64))
            md.update(Base64.getDecoder().decode(ciphertextB64))
            return Hex.encode(md.digest())
        }

        fun toJson(): JSONObject = JSONObject()
            .put("version", version)
            .put("header", header.toJson())
            .put("senderEphemeralPub", header.senderEphemeralPub)
            .put("aeadNonce", aeadNonceB64)
            .put("ciphertext", ciphertextB64)
            .put("rootSignature", rootSignatureHex)

        companion object {
            fun fromJson(o: JSONObject): Envelope? {
                return try {
                    if (o.getString("version") != VERSION) return null
                    val header = MigrationHeader.fromJson(o.getJSONObject("header")) ?: return null
                    Envelope(
                        header = header,
                        aeadNonceB64 = o.getString("aeadNonce"),
                        ciphertextB64 = o.getString("ciphertext"),
                        rootSignatureHex = o.getString("rootSignature"),
                    )
                } catch (_: Exception) {
                    null
                }
            }
        }
    }

    data class Ack(
        val version: String = VERSION,
        val migrationId: String,
        val authorizationId: String,
        val deviceId: String,
        val accountP: String,
        val authEpoch: Long,
        val status: String = "IMPORTED_SAME_IDENTITY",
        val envelopeCommitment: String,
        val signatureHex: String,
    ) {
        fun canonicalBytes(): ByteArray {
            val lines = listOf(
                ACK_DOMAIN,
                "version=$version",
                "migrationId=${norm(migrationId)}",
                "authorizationId=${norm(authorizationId)}",
                "deviceId=${norm(deviceId)}",
                "accountP=${norm(accountP)}",
                "authEpoch=$authEpoch",
                "status=$status",
                "envelopeCommitment=${norm(envelopeCommitment)}",
            )
            return lines.joinToString("\n").toByteArray(StandardCharsets.UTF_8)
        }

        fun toJson(): JSONObject = JSONObject()
            .put("version", version)
            .put("migrationId", norm(migrationId))
            .put("authorizationId", norm(authorizationId))
            .put("deviceId", norm(deviceId))
            .put("accountP", norm(accountP))
            .put("authEpoch", authEpoch)
            .put("status", status)
            .put("envelopeCommitment", norm(envelopeCommitment))
            .put("signature", signatureHex)

        companion object {
            fun fromJson(o: JSONObject): Ack? {
                return try {
                    Ack(
                        version = o.getString("version"),
                        migrationId = o.getString("migrationId"),
                        authorizationId = o.getString("authorizationId"),
                        deviceId = o.getString("deviceId"),
                        accountP = o.getString("accountP"),
                        authEpoch = o.getLong("authEpoch"),
                        status = o.getString("status"),
                        envelopeCommitment = o.getString("envelopeCommitment"),
                        signatureHex = o.getString("signature"),
                    )
                } catch (_: Exception) {
                    null
                }
            }
        }
    }

    fun interface IdentityReader {
        /** Native-only. Returns raw 32-byte K + pub hex, or null. */
        fun readRootIdentity(): Pair<ByteArray, String>?
    }

    fun interface IdentityWriter {
        /** Same-account secure import. Returns null on success, else error code. */
        fun importSameAccount(kBytes: ByteArray, expectedP: String): String?
    }

    fun interface ExistingAccountProbe {
        /** null = empty; hex P if present */
        fun existingAccountP(): String?
    }

    interface DestinationDeviceOps {
        fun localDeviceId(): String
        fun localDSignPub(): String
        fun localDEncPub(): String
        /** ECDH with local D_enc_priv; never export priv. Returns 32-byte shared or null. */
        fun ecdhWithLocalDEnc(peerEphPubHex: String): ByteArray?
        /** Sign ACK payload under D_sign; never export priv. */
        fun signWithLocalDSign(payload: ByteArray): ByteArray?
    }

    fun interface SessionGate {
        fun validate(sessionCapability: String, accountP: String, sessionGeneration: Long): String?
    }

    fun interface DeviceAuthGate {
        fun lookupActive(accountP: String, authorizationId: String, nowMs: Long): SosDeviceAuthorization.Authorization?
    }

    sealed class Result {
        data class Ok(val value: Any? = null) : Result()
        data class Err(val code: String) : Result()
    }

    private data class SourcePending(
        val authorizationId: String,
        val authSnapshot: SosDeviceAuthorization.Authorization,
        val accountP: String,
        val sessionCapability: String,
        val sessionGeneration: Long,
        val migrationId: String,
        val migrationNonce: String,
        val createdAt: Long,
        val wallExpiresAt: Long,
        val monoDeadlineElapsedMs: Long,
        var state: State = State.PREPARED,
        var envelope: Envelope? = null,
        var rootKReadCount: Int = 0,
        var rootSigCount: Int = 0,
    )

    class SourceEngine(
        private val identity: IdentityReader,
        private val deviceAuth: DeviceAuthGate,
        private val sessionGate: SessionGate,
        private val strongAuthDriver: SosNativeStrongConfirmation.StrongAuthDriver,
        private val wrapCrypto: SosNativeStrongConfirmation.ConfirmWrapCrypto,
        private val nowMs: () -> Long = { System.currentTimeMillis() },
        private val monoElapsedMs: () -> Long = { System.nanoTime() / 1_000_000L },
        private val random: SecureRandom = SecureRandom(),
    ) {
        private val pending = AtomicReference<SourcePending?>(null)
        private val preauthRootReads = AtomicInteger(0)
        private val successfulRootReads = AtomicInteger(0)
        private val successfulRootSigs = AtomicInteger(0)

        fun state(): State = pending.get()?.state ?: State.IDLE
        fun preauthRootKReadCount(): Int = preauthRootReads.get()
        fun successfulRootKReadCount(): Int = successfulRootReads.get()
        fun successfulRootSignatureCount(): Int = successfulRootSigs.get()
        fun lastEnvelope(): Envelope? = pending.get()?.envelope

        /**
         * Begin migration for an already-authorized device.
         * Caller supplies authorizationId only — D_enc/deviceId come from DeviceAuthorization.
         */
        fun prepare(
            authorizationId: String,
            sessionCapability: String,
            sessionGeneration: Long,
            accountPHint: String,
        ): Result {
            if (pending.get()?.state == State.STRONG_CONFIRM_PENDING) {
                return Result.Err("MIGRATION_ALREADY_ACTIVE")
            }
            val account = norm(accountPHint)
            if (!SosDeviceKeyCrypto.isHex64(account)) return Result.Err("BAD_ACCOUNT")
            if (!SosDeviceKeyCrypto.isHex64(authorizationId)) return Result.Err("BAD_AUTH_ID")

            val sessErr = sessionGate.validate(sessionCapability, account, sessionGeneration)
            if (sessErr != null) return Result.Err(sessErr)

            val t = nowMs()
            val auth = deviceAuth.lookupActive(account, authorizationId, t)
                ?: return Result.Err("NO_ACTIVE_DEVICE_AUTH")
            when (val v = SosDeviceAuthorization.verifyStrict(auth, t)) {
                is SosDeviceAuthorization.VerifyResult.Err -> return Result.Err(v.code)
                SosDeviceAuthorization.VerifyResult.Ok -> Unit
            }
            if (SosDeviceAuthorization.Capability.DEVICE_RECOVERY !in auth.capabilities) {
                return Result.Err("MISSING_DEVICE_RECOVERY")
            }
            if (norm(auth.accountP) != account) return Result.Err("ACCOUNT_MISMATCH")

            val migrationId = newId32(random)
            val nonce = newId32(random)
            val ttlMs = TTL_SECONDS * 1000L
            val p = SourcePending(
                authorizationId = norm(authorizationId),
                authSnapshot = auth,
                accountP = account,
                sessionCapability = sessionCapability,
                sessionGeneration = sessionGeneration,
                migrationId = migrationId,
                migrationNonce = nonce,
                createdAt = t,
                wallExpiresAt = t + ttlMs,
                monoDeadlineElapsedMs = monoElapsedMs() + ttlMs,
                state = State.PREPARED,
            )
            pending.set(p)
            return Result.Ok(migrationId)
        }

        /** Launch F6G.3 strong confirm; on success immediately seals in private continuation. */
        fun startStrongConfirm(): Result {
            val p = pending.get() ?: return Result.Err("NOT_PREPARED")
            if (p.state != State.PREPARED && p.state != State.FAILED && p.state != State.CANCELLED) {
                if (p.state == State.STRONG_CONFIRM_PENDING) return Result.Err("CONFIRM_ALREADY_PENDING")
                return Result.Err("BAD_STATE_${p.state}")
            }
            if (isExpired(p)) {
                p.state = State.EXPIRED
                return Result.Err("CEREMONY_EXPIRED")
            }

            val confirmReq = SosNativeStrongConfirmation.MigrationConfirmRequest(
                accountP = p.accountP,
                authorizationId = p.authorizationId,
                deviceId = p.authSnapshot.deviceId,
                dSignPub = p.authSnapshot.dSignPub,
                dEncPub = p.authSnapshot.dEncPub,
                authEpoch = p.authSnapshot.authEpoch,
                migrationId = p.migrationId,
                nonce = p.migrationNonce,
                createdAt = p.createdAt,
                expiresAt = p.wallExpiresAt,
                pairingTranscriptHash = p.authSnapshot.pairingTranscriptHash,
                sessionGeneration = p.sessionGeneration,
                sessionCapability = p.sessionCapability,
            )

            var authError: String? = null
            val wrappedDriver = object : SosNativeStrongConfirmation.StrongAuthDriver {
                override fun isSecureAuthenticatorAvailable(): Boolean =
                    strongAuthDriver.isSecureAuthenticatorAvailable()

                override fun authenticate(
                    title: String,
                    subtitle: String,
                    payloadHash: String,
                    cipherForCryptoObject: javax.crypto.Cipher?,
                    onSuccess: (String) -> Unit,
                    onError: (String) -> Unit,
                ) {
                    strongAuthDriver.authenticate(
                        title,
                        subtitle,
                        payloadHash,
                        cipherForCryptoObject,
                        onSuccess = { proof ->
                            onSuccess(proof)
                            // Soft/biometric success without continuation ⇒ revalidation failed
                            if (p.state == State.STRONG_CONFIRM_PENDING) {
                                p.state = State.FAILED
                            }
                        },
                        onError = { code ->
                            authError = code
                            p.state = if (code == "USER_CANCEL") State.CANCELLED else State.FAILED
                            onError(code)
                        },
                    )
                }
            }

            val engine = SosNativeStrongConfirmation.Engine(
                deviceAuth = { acc, authId, now -> deviceAuth.lookupActive(acc, authId, now) },
                sessionGate = { cap, acc, gen -> sessionGate.validate(cap, acc, gen) },
                authDriver = wrappedDriver,
                wrapCrypto = wrapCrypto,
                continuation = { handle -> onStrongConfirmReady(handle) },
                nowMs = nowMs,
                monoElapsedMs = monoElapsedMs,
                random = random,
            )
            p.state = State.STRONG_CONFIRM_PENDING
            return when (val r = engine.start(confirmReq)) {
                is SosNativeStrongConfirmation.StartResult.Ok -> {
                    if (authError != null) Result.Err(authError!!)
                    else if (p.state == State.FAILED || p.state == State.CANCELLED || p.state == State.EXPIRED) {
                        Result.Err(p.state.name)
                    } else {
                        Result.Ok(r.requestId)
                    }
                }
                is SosNativeStrongConfirmation.StartResult.Err -> {
                    if (p.state == State.STRONG_CONFIRM_PENDING) p.state = State.FAILED
                    Result.Err(r.code)
                }
            }
        }

        fun cancel(): Result {
            val p = pending.get() ?: return Result.Err("NO_PENDING")
            if (p.state == State.COMPLETE) return Result.Err("ALREADY_COMPLETE")
            p.state = State.CANCELLED
            p.envelope = null
            pending.set(null)
            return Result.Ok()
        }

        fun invalidateOnRestart() {
            pending.get()?.state = State.FAILED
            pending.set(null)
        }

        fun markDelivered(): Result {
            val p = pending.get() ?: return Result.Err("NO_PENDING")
            if (p.state != State.SEALED) return Result.Err("BAD_STATE_${p.state}")
            p.state = State.DELIVERED
            return Result.Ok()
        }

        fun verifyAck(ack: Ack): Result {
            val p = pending.get() ?: return Result.Err("NO_PENDING")
            if (p.state != State.SEALED && p.state != State.DELIVERED && p.state != State.ACK_PENDING) {
                return Result.Err("BAD_STATE_${p.state}")
            }
            val env = p.envelope ?: return Result.Err("NO_ENVELOPE")
            if (norm(ack.migrationId) != norm(p.migrationId)) return Result.Err("ACK_MIGRATION_MISMATCH")
            if (norm(ack.authorizationId) != norm(p.authorizationId)) return Result.Err("ACK_AUTH_MISMATCH")
            if (norm(ack.deviceId) != norm(p.authSnapshot.deviceId)) return Result.Err("ACK_DEVICE_MISMATCH")
            if (norm(ack.accountP) != norm(p.accountP)) return Result.Err("ACK_ACCOUNT_MISMATCH")
            if (ack.authEpoch != p.authSnapshot.authEpoch) return Result.Err("ACK_EPOCH_MISMATCH")
            if (ack.status != "IMPORTED_SAME_IDENTITY") return Result.Err("ACK_BAD_STATUS")
            if (norm(ack.envelopeCommitment) != env.envelopeCommitment()) return Result.Err("ACK_COMMITMENT_MISMATCH")
            if (!SosDeviceKeyCrypto.verifyDevicePayload(
                    p.authSnapshot.dSignPub,
                    ack.canonicalBytes(),
                    Hex.decode(norm(ack.signatureHex)),
                )
            ) {
                return Result.Err("ACK_BAD_SIGNATURE")
            }
            // Domain separation: ACK uses ACK_DOMAIN, not device-auth / nostr
            if (!String(ack.canonicalBytes()).startsWith(ACK_DOMAIN)) return Result.Err("ACK_DOMAIN")
            p.state = State.COMPLETE
            return Result.Ok()
        }

        private fun onStrongConfirmReady(handle: SosNativeStrongConfirmation.AuthorizedSealedMigrationHandle) {
            val p = pending.get() ?: return
            if (p.state != State.STRONG_CONFIRM_PENDING) return
            if (norm(handle.request.migrationId) != norm(p.migrationId)) {
                p.state = State.FAILED
                return
            }
            if (isExpired(p)) {
                p.state = State.EXPIRED
                return
            }

            // Revalidate BEFORE K read
            val t = nowMs()
            val sessErr = sessionGate.validate(p.sessionCapability, p.accountP, p.sessionGeneration)
            if (sessErr != null) {
                p.state = State.FAILED
                return
            }
            val auth = deviceAuth.lookupActive(p.accountP, p.authorizationId, t)
            if (auth == null) {
                p.state = State.FAILED
                return
            }
            if (auth.authEpoch != p.authSnapshot.authEpoch ||
                norm(auth.dEncPub) != norm(p.authSnapshot.dEncPub) ||
                norm(auth.dSignPub) != norm(p.authSnapshot.dSignPub) ||
                norm(auth.deviceId) != norm(p.authSnapshot.deviceId) ||
                norm(auth.authorizationId) != norm(p.authSnapshot.authorizationId)
            ) {
                p.state = State.FAILED
                return
            }
            if (SosDeviceAuthorization.Capability.DEVICE_RECOVERY !in auth.capabilities) {
                p.state = State.FAILED
                return
            }
            when (val v = SosDeviceAuthorization.verifyStrict(auth, t)) {
                is SosDeviceAuthorization.VerifyResult.Err -> {
                    p.state = State.FAILED
                    return
                }
                SosDeviceAuthorization.VerifyResult.Ok -> Unit
            }
            if (norm(handle.request.dEncPub) != norm(auth.dEncPub)) {
                p.state = State.FAILED
                return
            }

            p.state = State.AUTHORIZED_TO_SEAL
            sealNow(p, auth)
        }

        private fun sealNow(p: SourcePending, auth: SosDeviceAuthorization.Authorization) {
            var kBytes: ByteArray? = null
            var ephPriv: ByteArray? = null
            var shared: ByteArray? = null
            var aeadKey: ByteArray? = null
            var plaintext: ByteArray? = null
            try {
                val id = identity.readRootIdentity()
                if (id == null) {
                    p.state = State.FAILED
                    return
                }
                kBytes = id.first
                p.rootKReadCount++
                successfulRootReads.incrementAndGet()
                if (kBytes.size != 32) {
                    p.state = State.FAILED
                    return
                }
                val derivedP = try {
                    SosNostrCrypto.pubkeyFromPriv(Hex.encode(kBytes))
                } catch (_: Exception) {
                    p.state = State.FAILED
                    return
                }
                if (norm(derivedP) != norm(p.accountP) || norm(derivedP) != norm(auth.accountP)) {
                    p.state = State.FAILED
                    return
                }

                val (priv, pub) = SosX25519.generateKeyPair(random)
                ephPriv = priv
                val ephPubHex = Hex.encode(pub)

                shared = SosX25519.sharedSecret(ephPriv, Hex.decode(norm(auth.dEncPub)))
                if (isAllZero(shared)) {
                    p.state = State.FAILED
                    return
                }

                val headerForKdf = MigrationHeader(
                    accountP = p.accountP,
                    authorizationId = p.authorizationId,
                    deviceId = auth.deviceId,
                    dSignPub = auth.dSignPub,
                    dEncPub = auth.dEncPub,
                    authEpoch = auth.authEpoch,
                    migrationId = p.migrationId,
                    migrationNonce = p.migrationNonce,
                    createdAt = p.createdAt,
                    expiresAt = p.wallExpiresAt,
                    pairingTranscriptHash = auth.pairingTranscriptHash,
                    senderEphemeralPub = ephPubHex,
                    sessionGeneration = p.sessionGeneration,
                )
                aeadKey = deriveAeadKey(shared, headerForKdf)
                plaintext = buildPlaintext(kBytes, derivedP)
                val aad = headerForKdf.canonicalBytes()
                val iv = ByteArray(IV_BYTES).also { random.nextBytes(it) }
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(aeadKey, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
                cipher.updateAAD(aad)
                val ct = cipher.doFinal(plaintext)

                val ctHash = sha256(ct)
                val sigMsg = migrationSignMessage(headerForKdf.canonicalBytes(), ctHash)
                val secp = Secp256k1.get()
                val sig = secp.signSchnorr(sigMsg, kBytes, null)
                p.rootSigCount++
                successfulRootSigs.incrementAndGet()

                val envelope = Envelope(
                    header = headerForKdf,
                    aeadNonceB64 = Base64.getEncoder().encodeToString(iv),
                    ciphertextB64 = Base64.getEncoder().encodeToString(ct),
                    rootSignatureHex = Hex.encode(sig),
                )
                p.envelope = envelope
                p.state = State.SEALED
            } catch (_: Exception) {
                p.state = State.FAILED
            } finally {
                SosDeviceKeyCrypto.zeroize(kBytes, ephPriv, shared, aeadKey, plaintext)
            }
        }

        private fun isExpired(p: SourcePending): Boolean {
            if (nowMs() > p.wallExpiresAt) return true
            if (monoElapsedMs() > p.monoDeadlineElapsedMs) return true
            return false
        }
    }

    class DestinationEngine(
        private val device: DestinationDeviceOps,
        private val writer: IdentityWriter,
        private val existing: ExistingAccountProbe,
        private val deviceAuthLookup: (accountP: String, authorizationId: String, nowMs: Long) -> SosDeviceAuthorization.Authorization?,
        private val spent: ConcurrentHashMap<String, Pair<String, Ack>> = ConcurrentHashMap(),
        private val nowMs: () -> Long = { System.currentTimeMillis() },
    ) {
        fun receiveAndImport(envelopeJson: JSONObject): Result {
            val envelope = Envelope.fromJson(envelopeJson) ?: return Result.Err("MALFORMED_ENVELOPE")
            return receiveAndImport(envelope)
        }

        fun receiveAndImport(envelope: Envelope): Result {
            if (envelope.version != VERSION) return Result.Err("UNKNOWN_VERSION")
            val h = envelope.header
            if (h.version != VERSION) return Result.Err("UNKNOWN_VERSION")
            if (h.operation != OPERATION) return Result.Err("BAD_OPERATION")
            val t = nowMs()
            if (t > h.expiresAt) return Result.Err("ENVELOPE_EXPIRED")

            // Identical retransmission
            val commitment = envelope.envelopeCommitment()
            spent[norm(h.migrationId)]?.let { (prevCommit, cachedAck) ->
                if (prevCommit == commitment) return Result.Ok(cachedAck)
                return Result.Err("MIGRATION_ID_REPLAY")
            }

            if (norm(h.deviceId) != norm(device.localDeviceId())) return Result.Err("DEVICE_ID_MISMATCH")
            if (norm(h.dSignPub) != norm(device.localDSignPub())) return Result.Err("D_SIGN_MISMATCH")
            if (norm(h.dEncPub) != norm(device.localDEncPub())) return Result.Err("D_ENC_MISMATCH")

            val auth = deviceAuthLookup(h.accountP, h.authorizationId, t)
                ?: return Result.Err("NO_ACTIVE_DEVICE_AUTH")
            when (val v = SosDeviceAuthorization.verifyForDestination(
                auth,
                device.localDeviceId(),
                device.localDSignPub(),
                device.localDEncPub(),
                h.accountP,
                t,
            )) {
                is SosDeviceAuthorization.VerifyResult.Err -> return Result.Err(v.code)
                SosDeviceAuthorization.VerifyResult.Ok -> Unit
            }
            if (SosDeviceAuthorization.Capability.DEVICE_RECOVERY !in auth.capabilities) {
                return Result.Err("MISSING_DEVICE_RECOVERY")
            }
            if (auth.authEpoch != h.authEpoch) return Result.Err("AUTH_EPOCH_MISMATCH")
            if (norm(auth.dEncPub) != norm(h.dEncPub)) return Result.Err("D_ENC_MISMATCH")

            // Root signature BEFORE unwrap
            val ct = try {
                Base64.getDecoder().decode(envelope.ciphertextB64)
            } catch (_: Exception) {
                return Result.Err("BAD_CIPHERTEXT")
            }
            val ctHash = sha256(ct)
            val sigMsg = migrationSignMessage(h.canonicalBytes(), ctHash)
            if (!verifyRootMigrationSig(h.accountP, envelope.rootSignatureHex, sigMsg)) {
                return Result.Err("BAD_ROOT_SIGNATURE")
            }

            var shared: ByteArray? = null
            var aeadKey: ByteArray? = null
            var plain: ByteArray? = null
            var kBytes: ByteArray? = null
            try {
                shared = device.ecdhWithLocalDEnc(h.senderEphemeralPub) ?: return Result.Err("ECDH_FAIL")
                if (isAllZero(shared)) return Result.Err("ALL_ZERO_X25519")
                aeadKey = deriveAeadKey(shared, h)
                val iv = try {
                    Base64.getDecoder().decode(envelope.aeadNonceB64)
                } catch (_: Exception) {
                    return Result.Err("BAD_NONCE")
                }
                if (iv.size != IV_BYTES) return Result.Err("BAD_NONCE_LEN")
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(aeadKey, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
                cipher.updateAAD(h.canonicalBytes())
                plain = try {
                    cipher.doFinal(ct)
                } catch (_: Exception) {
                    return Result.Err("AEAD_FAIL")
                }
                val plainBytes = plain ?: return Result.Err("AEAD_FAIL")
                val parsed = parsePlaintext(plainBytes) ?: return Result.Err("BAD_PLAINTEXT")
                kBytes = parsed.first
                val expectedP = parsed.second
                if (norm(expectedP) != norm(h.accountP)) return Result.Err("EXPECTED_P_MISMATCH")
                val kNonNull = kBytes ?: return Result.Err("BAD_PLAINTEXT")
                val derived = try {
                    SosNostrCrypto.pubkeyFromPriv(Hex.encode(kNonNull))
                } catch (_: Exception) {
                    return Result.Err("DERIVE_FAIL")
                }
                if (norm(derived) != norm(expectedP) || norm(derived) != norm(auth.accountP)) {
                    return Result.Err("WRONG_K")
                }

                val existingP = existing.existingAccountP()?.let { norm(it) }.orEmpty()
                if (existingP.isNotEmpty() && existingP != norm(derived)) {
                    return Result.Err("ACCOUNT_MISMATCH")
                }

                // Same account already present → skip rewrite, still ACK
                val skipImport = existingP.isNotEmpty() && existingP == norm(derived)
                if (!skipImport) {
                    val err = writer.importSameAccount(kNonNull, derived)
                    if (err != null) {
                        return Result.Err(
                            when (err) {
                                "DIFFERENT_IDENTITY_OVERWRITE" -> "ACCOUNT_MISMATCH"
                                else -> err
                            },
                        )
                    }
                }

                val ackUnsigned = Ack(
                    migrationId = h.migrationId,
                    authorizationId = h.authorizationId,
                    deviceId = h.deviceId,
                    accountP = h.accountP,
                    authEpoch = h.authEpoch,
                    envelopeCommitment = commitment,
                    signatureHex = "",
                )
                val sig = device.signWithLocalDSign(ackUnsigned.canonicalBytes())
                    ?: return Result.Err("ACK_SIGN_FAIL")
                val ack = ackUnsigned.copy(signatureHex = Hex.encode(sig))
                spent[norm(h.migrationId)] = commitment to ack
                return Result.Ok(ack)
            } finally {
                SosDeviceKeyCrypto.zeroize(shared, aeadKey, plain, kBytes)
            }
        }
    }

    fun newId32(random: SecureRandom = SecureRandom()): String =
        Hex.encode(ByteArray(32).also { random.nextBytes(it) })

    fun deriveAeadKey(ecdhShared: ByteArray, header: MigrationHeader): ByteArray {
        val salt = sha256(
            buildString {
                append(DOMAIN)
                append("|")
                append(norm(header.accountP))
                append("|")
                append(norm(header.authorizationId))
                append("|")
                append(norm(header.deviceId))
                append("|")
                append(norm(header.dEncPub))
                append("|")
                append(header.authEpoch)
                append("|")
                append(norm(header.migrationId))
                append("|")
                append(norm(header.migrationNonce))
            }.toByteArray(StandardCharsets.UTF_8),
        )
        val prk = hkdfExtract(salt, ecdhShared)
        return try {
            hkdfExpand(prk, HKDF_INFO.toByteArray(StandardCharsets.UTF_8), 32)
        } finally {
            SosDeviceKeyCrypto.zeroize(prk)
        }
    }

    fun buildPlaintext(kBytes: ByteArray, expectedP: String): ByteArray {
        require(kBytes.size == 32)
        val pBytes = Hex.decode(norm(expectedP))
        require(pBytes.size == 32)
        val domain = PLAINTEXT_DOMAIN.toByteArray(StandardCharsets.UTF_8)
        return domain + pBytes + kBytes
    }

    fun parsePlaintext(plain: ByteArray): Pair<ByteArray, String>? {
        val domain = PLAINTEXT_DOMAIN.toByteArray(StandardCharsets.UTF_8)
        if (plain.size != domain.size + 64) return null
        for (i in domain.indices) {
            if (plain[i] != domain[i]) return null
        }
        val pBytes = plain.copyOfRange(domain.size, domain.size + 32)
        val kBytes = plain.copyOfRange(domain.size + 32, domain.size + 64)
        return kBytes to Hex.encode(pBytes)
    }

    fun migrationSignMessage(headerCanonical: ByteArray, ciphertextHash: ByteArray): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        md.update(DOMAIN.toByteArray(StandardCharsets.UTF_8))
        md.update(headerCanonical)
        md.update(ciphertextHash)
        return md.digest()
    }

    fun verifyRootMigrationSig(accountP: String, sigHex: String, msg32: ByteArray): Boolean {
        return try {
            val secp = Secp256k1.get()
            val sig = Hex.decode(norm(sigHex))
            val pub = Hex.decode(norm(accountP))
            if (sig.size != 64 || pub.size != 32 || msg32.size != 32) return false
            secp.verifySchnorr(sig, msg32, pub)
        } catch (_: Exception) {
            false
        }
    }

    fun isAllZero(b: ByteArray): Boolean = b.all { it == 0.toByte() }

    private fun sha256(data: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(data)

    private fun hkdfExtract(salt: ByteArray, ikm: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        return mac.doFinal(ikm)
    }

    private fun hkdfExpand(prk: ByteArray, info: ByteArray, length: Int): ByteArray {
        val okm = ByteArray(length)
        var previous = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            mac.update(previous)
            mac.update(info)
            mac.update(byteArrayOf(counter.toByte()))
            previous = mac.doFinal()
            val toCopy = minOf(previous.size, length - offset)
            System.arraycopy(previous, 0, okm, offset, toCopy)
            offset += toCopy
            counter++
        }
        return okm
    }

    private fun norm(s: String) = SosDeviceKeyCrypto.normalizeHex(s)
}
