package com.sos010.app

import fr.acinq.secp256k1.Hex
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore

/**
 * F6G.3 — Native strong confirmation for SEALED_MIGRATION only.
 *
 * Separate from SosNativeTrustedConfirmation NORMAL_NATIVE_CONFIRM (unchanged).
 * Does NOT read root K / nsec. Does NOT seal K. F5B6 continuation is a no-secret stub.
 *
 * Approval never leaves native memory as a reusable token / WebView boolean.
 * HYPER CORE TECH
 */
object SosNativeStrongConfirmation {

    const val DOMAIN = "SOS_STRONG_CONFIRM_SEALED_MIGRATION_V1"
    const val PROTOCOL_VERSION = "sos-strong-confirm-sealed-migration-v1"
    const val OPERATION = "SEALED_MIGRATION"
    const val KEYSTORE_ALIAS = "sos_strong_confirm_v1"
    const val REQUEST_TTL_SECONDS = 120
    const val REUSE_WINDOW_SECONDS = 0
    const val MAX_CREATES_PER_MINUTE = 6
    const val CREATE_COOLDOWN_MS = 500L

    const val F6G3_STRONG_CONFIRM_AVAILABLE = true
    const val F6G3_SUPPORTED_STRONG_INTENTS = "SEALED_MIGRATION"
    const val GENERIC_STRONG_CONFIRM_OPERATION = false
    const val WEBVIEW_RECEIVES_STRONG_CONFIRM_BOOLEAN = false
    const val WEBVIEW_RECEIVES_STRONG_CONFIRM_TOKEN = false
    const val PUBLIC_STRONG_CONFIRM_APPROVAL_TOKEN = false
    const val STRONG_CONFIRM_REMEMBER_ME = false
    const val STRONG_CONFIRM_FALLBACK_TO_NORMAL_DIALOG = false
    const val F5B6_CONTINUATION_READS_K_IN_F6G3 = false
    const val SEALED_MIGRATION_ENVELOPE_IMPLEMENTED = false

    /** Authenticator policy: BIOMETRIC_STRONG preferred; DEVICE_CREDENTIAL allowed as platform fallback. */
    const val AUTHENTICATOR_POLICY = "BIOMETRIC_STRONG|DEVICE_CREDENTIAL; fail-closed if none enrolled"

    data class MigrationConfirmRequest(
        val accountP: String,
        val authorizationId: String,
        val deviceId: String,
        val dSignPub: String,
        val dEncPub: String,
        val authEpoch: Long,
        val migrationId: String,
        val nonce: String,
        val createdAt: Long,
        val expiresAt: Long,
        val pairingTranscriptHash: String,
        val sessionGeneration: Long,
        val sessionCapability: String = "",
        val deviceLabel: String = "",
    ) {
        fun canonicalBytes(): ByteArray {
            val lines = listOf(
                DOMAIN,
                "protocolVersion=$PROTOCOL_VERSION",
                "operation=$OPERATION",
                "accountP=${norm(accountP)}",
                "authorizationId=${norm(authorizationId)}",
                "deviceId=${norm(deviceId)}",
                "D_sign_pub=${norm(dSignPub)}",
                "D_enc_pub=${norm(dEncPub)}",
                "authEpoch=$authEpoch",
                "migrationId=${norm(migrationId)}",
                "nonce=${norm(nonce)}",
                "createdAt=$createdAt",
                "expiresAt=$expiresAt",
                "pairingTranscriptHash=${norm(pairingTranscriptHash)}",
                "sessionGeneration=$sessionGeneration",
            )
            return lines.joinToString("\n").toByteArray(StandardCharsets.UTF_8)
        }

        fun payloadHash(): String = Hex.encode(MessageDigest.getInstance("SHA-256").digest(canonicalBytes()))

        private fun norm(s: String) = SosDeviceKeyCrypto.normalizeHex(s)
    }

    /**
     * Native-only one-shot handle for future F5B6 — not serializable to WebView.
     * F6G.3 stub continuation must not read K.
     */
    class AuthorizedSealedMigrationHandle internal constructor(
        val request: MigrationConfirmRequest,
        val payloadHash: String,
        val cryptoProofB64: String,
        private val consumeNonce: String,
        private var consumed: Boolean = false,
    ) {
        fun consumeOnce(): Boolean {
            if (consumed) return false
            consumed = true
            return consumeNonce.isNotEmpty()
        }

        fun isConsumed(): Boolean = consumed
    }

    fun interface F5b6ContinuationStub {
        /** Must not read K. Records that strong confirm completed for exact handle. */
        fun onStrongConfirmReady(handle: AuthorizedSealedMigrationHandle)
    }

    fun interface SessionGate {
        /** null = ok; otherwise error code */
        fun validate(sessionCapability: String, accountP: String, sessionGeneration: Long): String?
    }

    fun interface DeviceAuthGate {
        /** Return ACTIVE DeviceAuthorization for account+authorizationId or null */
        fun lookupActive(accountP: String, authorizationId: String, nowMs: Long): SosDeviceAuthorization.Authorization?
    }

    /**
     * Platform auth driver. Production uses BiometricPrompt+CryptoObject.
     * Test/debug drivers must live only in test source sets.
     */
    interface StrongAuthDriver {
        fun isSecureAuthenticatorAvailable(): Boolean
        /**
         * Present platform auth. On success invoke onSuccess with AEAD proof over payloadHash
         * produced under user-auth-bound key (or test soft equivalent).
         */
        fun authenticate(
            title: String,
            subtitle: String,
            payloadHash: String,
            cipherForCryptoObject: Cipher?,
            onSuccess: (cryptoProofB64: String) -> Unit,
            onError: (code: String) -> Unit,
        )
    }

    sealed class StartResult {
        data class Ok(val requestId: String, val payloadHash: String, val expiresAtMs: Long) : StartResult()
        data class Err(val code: String) : StartResult()
    }

    enum class Phase {
        IDLE,
        PENDING_AUTH,
        SUCCEEDED_CONSUMED,
        FAILED,
        CANCELLED,
        EXPIRED,
    }

    private data class Pending(
        val requestId: String,
        val request: MigrationConfirmRequest,
        val payloadHash: String,
        val wallExpiresAtMs: Long,
        val monoDeadlineElapsedMs: Long,
        val accountAtStart: String,
        val authSnapshot: SosDeviceAuthorization.Authorization,
        val sessionGeneration: Long,
        val sessionCapability: String,
        var phase: Phase = Phase.PENDING_AUTH,
    )

    class Engine(
        private val deviceAuth: DeviceAuthGate,
        private val sessionGate: SessionGate,
        private val authDriver: StrongAuthDriver,
        private val wrapCrypto: ConfirmWrapCrypto,
        private val continuation: F5b6ContinuationStub = F5b6ContinuationStub { },
        private val nowMs: () -> Long = { System.currentTimeMillis() },
        /** Monotonic-ish deadline clock; injectable for JVM unit tests (SystemClock unavailable). */
        private val monoElapsedMs: () -> Long = { System.nanoTime() / 1_000_000L },
        private val random: SecureRandom = SecureRandom(),
    ) {
        private val active = AtomicReference<Pending?>(null)
        private val createTimestamps = ArrayDeque<Long>()
        private var lastCreateMs = 0L
        private var lastContinuationInvoked = false
        private var rootKReadCount = 0 // must stay 0

        fun phase(): Phase = active.get()?.phase ?: Phase.IDLE
        fun rootKReadCount(): Int = rootKReadCount
        fun continuationInvoked(): Boolean = lastContinuationInvoked
        fun hasActivePending(): Boolean = active.get()?.phase == Phase.PENDING_AUTH

        fun start(request: MigrationConfirmRequest): StartResult {
            lastContinuationInvoked = false
            if (!authDriver.isSecureAuthenticatorAvailable()) {
                return StartResult.Err("STRONG_CONFIRMATION_UNAVAILABLE")
            }
            val account = SosDeviceKeyCrypto.normalizeHex(request.accountP)
            if (!SosDeviceKeyCrypto.isHex64(account)) return StartResult.Err("BAD_ACCOUNT")
            if (!SosDeviceKeyCrypto.isHex64(request.authorizationId)) return StartResult.Err("BAD_AUTH_ID")
            if (!SosDeviceKeyCrypto.isHex64(request.deviceId)) return StartResult.Err("BAD_DEVICE_ID")
            if (!SosDeviceKeyCrypto.isHex64(request.dEncPub)) return StartResult.Err("BAD_D_ENC")
            if (!SosDeviceKeyCrypto.isHex64(request.migrationId)) return StartResult.Err("BAD_MIGRATION_ID")
            if (!SosDeviceKeyCrypto.isHex64(request.nonce)) return StartResult.Err("BAD_NONCE")
            val t = nowMs()
            if (t > request.expiresAt) return StartResult.Err("REQUEST_EXPIRED")
            if (request.expiresAt <= request.createdAt) return StartResult.Err("BAD_EXPIRY_RANGE")

            val sessErr = sessionGate.validate(request.sessionCapability, account, request.sessionGeneration)
            if (sessErr != null) return StartResult.Err(sessErr)

            val auth = deviceAuth.lookupActive(account, request.authorizationId, t)
                ?: return StartResult.Err("NO_ACTIVE_DEVICE_AUTH")
            if (SosDeviceAuthorization.Capability.DEVICE_RECOVERY !in auth.capabilities) {
                return StartResult.Err("MISSING_DEVICE_RECOVERY")
            }
            if (auth.authEpoch != request.authEpoch) return StartResult.Err("AUTH_EPOCH_MISMATCH")
            if (SosDeviceKeyCrypto.normalizeHex(auth.deviceId) != SosDeviceKeyCrypto.normalizeHex(request.deviceId)) {
                return StartResult.Err("DEVICE_ID_MISMATCH")
            }
            if (SosDeviceKeyCrypto.normalizeHex(auth.dSignPub) != SosDeviceKeyCrypto.normalizeHex(request.dSignPub)) {
                return StartResult.Err("D_SIGN_MISMATCH")
            }
            if (SosDeviceKeyCrypto.normalizeHex(auth.dEncPub) != SosDeviceKeyCrypto.normalizeHex(request.dEncPub)) {
                return StartResult.Err("D_ENC_MISMATCH")
            }
            if (SosDeviceKeyCrypto.normalizeHex(auth.accountP) != account) {
                return StartResult.Err("ACCOUNT_MISMATCH")
            }

            // Concurrency before cooldown — one pending ceremony max
            val existing = active.get()
            if (existing != null && existing.phase == Phase.PENDING_AUTH &&
                !isExpired(existing, t, monoElapsedMs())
            ) {
                return StartResult.Err("CONFIRMATION_ALREADY_ACTIVE")
            }

            // Rate / spam bounds
            while (createTimestamps.isNotEmpty() && t - createTimestamps.first() > 60_000L) {
                createTimestamps.removeFirst()
            }
            if (createTimestamps.size >= MAX_CREATES_PER_MINUTE) {
                return StartResult.Err("CONFIRMATION_RATE_LIMITED")
            }
            if (t - lastCreateMs < CREATE_COOLDOWN_MS) {
                return StartResult.Err("CONFIRMATION_COOLDOWN")
            }
            val hash = request.payloadHash()
            val canon = String(request.canonicalBytes(), Charsets.UTF_8).lowercase()
            if (canon.contains("nsec") || canon.contains("privkey")) {
                return StartResult.Err("SECRET_IN_PAYLOAD")
            }
            val requestId = Hex.encode(ByteArray(16).also { random.nextBytes(it) })
            val ttlMs = REQUEST_TTL_SECONDS * 1000L
            val pending = Pending(
                requestId = requestId,
                request = request,
                payloadHash = hash,
                wallExpiresAtMs = minOf(t + ttlMs, request.expiresAt),
                monoDeadlineElapsedMs = monoElapsedMs() + ttlMs,
                accountAtStart = account,
                authSnapshot = auth,
                sessionGeneration = request.sessionGeneration,
                sessionCapability = request.sessionCapability,
            )
            active.set(pending)
            lastCreateMs = t
            createTimestamps.addLast(t)

            val cipher = try {
                wrapCrypto.initEncryptCipher(aad = hash.toByteArray(Charsets.UTF_8))
            } catch (_: Exception) {
                active.set(null)
                return StartResult.Err("STRONG_CONFIRMATION_UNAVAILABLE")
            }

            authDriver.authenticate(
                title = "אישור העברת החשבון",
                subtitle = "יש לאמת את זהותך כדי להעביר בצורה מאובטחת את החשבון למכשיר המקושר.",
                payloadHash = hash,
                cipherForCryptoObject = cipher,
                onSuccess = { proof -> completeAfterAuth(requestId, proof) },
                onError = { code -> failPending(requestId, code) },
            )
            return StartResult.Ok(requestId, hash, pending.wallExpiresAtMs)
        }

        fun cancel(requestId: String): String? {
            val p = active.get() ?: return "NO_PENDING"
            if (p.requestId != requestId) return "MISMATCH"
            p.phase = Phase.CANCELLED
            active.set(null)
            return null
        }

        /** Invalidate on lifecycle destroy / process death simulation. */
        fun invalidateAll(@Suppress("UNUSED_PARAMETER") reason: String = "LIFECYCLE") {
            active.get()?.phase = Phase.FAILED
            active.set(null)
        }

        private fun failPending(requestId: String, code: String) {
            val p = active.get() ?: return
            if (p.requestId != requestId) return
            p.phase = if (code == "USER_CANCEL") Phase.CANCELLED else Phase.FAILED
            active.set(null)
        }

        private fun completeAfterAuth(requestId: String, cryptoProofB64: String) {
            val p = active.get() ?: return
            if (p.requestId != requestId) return
            if (p.phase != Phase.PENDING_AUTH) return
            val t = nowMs()
            val mono = monoElapsedMs()
            if (isExpired(p, t, mono)) {
                p.phase = Phase.EXPIRED
                active.set(null)
                return
            }

            // Revalidate session
            val sessErr = sessionGate.validate(p.sessionCapability, p.accountAtStart, p.sessionGeneration)
            if (sessErr != null) {
                failPending(requestId, sessErr)
                return
            }

            // Revalidate device authorization — must match snapshot
            val auth = deviceAuth.lookupActive(p.accountAtStart, p.request.authorizationId, t)
            if (auth == null) {
                failPending(requestId, "DEVICE_AUTH_GONE")
                return
            }
            if (auth.authEpoch != p.authSnapshot.authEpoch ||
                auth.authorizationId != p.authSnapshot.authorizationId ||
                auth.dEncPub != p.authSnapshot.dEncPub ||
                auth.dSignPub != p.authSnapshot.dSignPub ||
                auth.deviceId != p.authSnapshot.deviceId
            ) {
                failPending(requestId, "DEVICE_AUTH_CHANGED")
                return
            }
            if (SosDeviceAuthorization.Capability.DEVICE_RECOVERY !in auth.capabilities) {
                failPending(requestId, "MISSING_DEVICE_RECOVERY")
                return
            }

            // Payload must be unchanged
            if (p.request.payloadHash() != p.payloadHash) {
                failPending(requestId, "PAYLOAD_MUTATION")
                return
            }

            // Verify crypto proof binds payloadHash
            if (!wrapCrypto.verifyProof(p.payloadHash, cryptoProofB64)) {
                failPending(requestId, "CRYPTO_PROOF_INVALID")
                return
            }

            val handle = AuthorizedSealedMigrationHandle(
                request = p.request,
                payloadHash = p.payloadHash,
                cryptoProofB64 = cryptoProofB64,
                consumeNonce = Hex.encode(ByteArray(16).also { random.nextBytes(it) }),
            )
            // Single-use: clear pending BEFORE continuation so double callback cannot re-enter
            p.phase = Phase.SUCCEEDED_CONSUMED
            active.set(null)
            if (!handle.consumeOnce()) return
            // F6G.3: stub only — MUST NOT read K
            lastContinuationInvoked = true
            continuation.onStrongConfirmReady(handle)
        }

        private fun isExpired(p: Pending, wallNow: Long, monoNow: Long): Boolean {
            if (wallNow > p.wallExpiresAtMs) return true
            if (monoNow > p.monoDeadlineElapsedMs) return true
            return false
        }
    }

    fun newMigrationId(random: SecureRandom = SecureRandom()): String =
        Hex.encode(ByteArray(32).also { random.nextBytes(it) })

    fun newNonce(random: SecureRandom = SecureRandom()): String =
        Hex.encode(ByteArray(32).also { random.nextBytes(it) })

    // --- Crypto wrap for CryptoObject binding ---

    interface ConfirmWrapCrypto {
        fun initEncryptCipher(aad: ByteArray): Cipher
        fun verifyProof(payloadHash: String, proofB64: String): Boolean
    }

    /**
     * Android Keystore AES-GCM, user-authentication required (non-exportable).
     * BiometricPrompt CryptoObject gates the encrypt of payloadHash.
     */
    class KeystoreConfirmWrapCrypto(
        private val alias: String = KEYSTORE_ALIAS,
    ) : ConfirmWrapCrypto {
        override fun initEncryptCipher(aad: ByteArray): Cipher {
            val key = getOrCreateKey()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            cipher.updateAAD(aad)
            return cipher
        }

        override fun verifyProof(payloadHash: String, proofB64: String): Boolean {
            // Proof format: ivB64.ctB64 produced after authenticate finalizes cipher.doFinal(payloadHash bytes)
            return try {
                val parts = proofB64.split(".", limit = 2)
                if (parts.size != 2) return false
                val iv = android.util.Base64.decode(parts[0], android.util.Base64.NO_WRAP)
                val ct = android.util.Base64.decode(parts[1], android.util.Base64.NO_WRAP)
                val key = getOrCreateKey()
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
                cipher.updateAAD(payloadHash.toByteArray(Charsets.UTF_8))
                val plain = cipher.doFinal(ct)
                plain.contentEquals(payloadHash.toByteArray(Charsets.UTF_8))
            } catch (_: Exception) {
                false
            }
        }

        private fun getOrCreateKey(): SecretKey {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val existing = ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry
            if (existing != null) return existing.secretKey
            val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            val builder = KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setRandomizedEncryptionRequired(true)
            // Per-use auth (no validity window) — API 30+ uses setUserAuthenticationParameters
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                builder.setUserAuthenticationParameters(
                    0,
                    KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                )
            } else {
                @Suppress("DEPRECATION")
                builder.setUserAuthenticationValidityDurationSeconds(-1)
            }
            keyGen.init(builder.build())
            return keyGen.generateKey()
        }
    }

    /**
     * Production BiometricPrompt driver. Requires FragmentActivity host.
     * CryptoObject binds user auth to Keystore cipher; proof = encrypt(payloadHash).
     */
    class BiometricPromptAuthDriver(
        private val activity: androidx.fragment.app.FragmentActivity,
        private val wrap: KeystoreConfirmWrapCrypto = KeystoreConfirmWrapCrypto(),
    ) : StrongAuthDriver {
        override fun isSecureAuthenticatorAvailable(): Boolean {
            return try {
                val bm = androidx.biometric.BiometricManager.from(activity)
                val can = bm.canAuthenticate(
                    androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG or
                        androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL,
                )
                can == androidx.biometric.BiometricManager.BIOMETRIC_SUCCESS
            } catch (_: Exception) {
                false
            }
        }

        override fun authenticate(
            title: String,
            subtitle: String,
            payloadHash: String,
            cipherForCryptoObject: Cipher?,
            onSuccess: (cryptoProofB64: String) -> Unit,
            onError: (code: String) -> Unit,
        ) {
            if (!isSecureAuthenticatorAvailable()) {
                onError("STRONG_CONFIRMATION_UNAVAILABLE")
                return
            }
            val cipher = cipherForCryptoObject ?: try {
                wrap.initEncryptCipher(payloadHash.toByteArray(Charsets.UTF_8))
            } catch (_: Exception) {
                onError("STRONG_CONFIRMATION_UNAVAILABLE")
                return
            }
            val executor = androidx.core.content.ContextCompat.getMainExecutor(activity)
            val prompt = androidx.biometric.BiometricPrompt(
                activity,
                executor,
                object : androidx.biometric.BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(
                        result: androidx.biometric.BiometricPrompt.AuthenticationResult,
                    ) {
                        try {
                            val c = result.cryptoObject?.cipher ?: cipher
                            val ct = c.doFinal(payloadHash.toByteArray(Charsets.UTF_8))
                            val iv = c.iv
                            val b64 = android.util.Base64.NO_WRAP
                            val proof = android.util.Base64.encodeToString(iv, b64) + "." +
                                android.util.Base64.encodeToString(ct, b64)
                            onSuccess(proof)
                        } catch (_: Exception) {
                            onError("CRYPTO_FINALIZE_FAIL")
                        }
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        val code = when (errorCode) {
                            androidx.biometric.BiometricPrompt.ERROR_USER_CANCELED,
                            androidx.biometric.BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                            -> "USER_CANCEL"
                            androidx.biometric.BiometricPrompt.ERROR_LOCKOUT,
                            androidx.biometric.BiometricPrompt.ERROR_LOCKOUT_PERMANENT,
                            -> "LOCKOUT"
                            androidx.biometric.BiometricPrompt.ERROR_NO_BIOMETRICS,
                            androidx.biometric.BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL,
                            androidx.biometric.BiometricPrompt.ERROR_HW_UNAVAILABLE,
                            -> "STRONG_CONFIRMATION_UNAVAILABLE"
                            else -> "AUTH_ERROR_$errorCode"
                        }
                        onError(code)
                    }

                    override fun onAuthenticationFailed() {
                        // Intermediate failure; wait for error/success — do not authorize
                    }
                },
            )
            val info = androidx.biometric.BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setAllowedAuthenticators(
                    androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG or
                        androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL,
                )
                .build()
            try {
                prompt.authenticate(info, androidx.biometric.BiometricPrompt.CryptoObject(cipher))
            } catch (_: Exception) {
                onError("STRONG_CONFIRMATION_UNAVAILABLE")
            }
        }
    }
}
