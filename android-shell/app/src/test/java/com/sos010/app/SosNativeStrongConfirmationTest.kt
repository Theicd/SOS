package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * F6G.3 unit tests — soft auth driver in TEST source only (not release wiring).
 */
class SosNativeStrongConfirmationTest {

    companion object {
        @JvmStatic
        @BeforeClass
        fun loadSecp() {
            val dll = java.io.File("build/native/secp256k1-jni.dll")
            if (dll.isFile) System.load(dll.absolutePath)
        }
    }

    /** TEST-ONLY soft wrap — mirrors Keystore AEAD proof format. */
    private class SoftWrap : SosNativeStrongConfirmation.ConfirmWrapCrypto {
        private val key = SecretKeySpec(ByteArray(32).also { SecureRandom().nextBytes(it) }, "AES")
        private val random = SecureRandom()
        override fun initEncryptCipher(aad: ByteArray): Cipher {
            val iv = ByteArray(12).also { random.nextBytes(it) }
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
            c.updateAAD(aad)
            return c
        }
        fun seal(payloadHash: String): String {
            val iv = ByteArray(12).also { random.nextBytes(it) }
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
            c.updateAAD(payloadHash.toByteArray(Charsets.UTF_8))
            val ct = c.doFinal(payloadHash.toByteArray(Charsets.UTF_8))
            val b64 = java.util.Base64.getEncoder()
            return b64.encodeToString(iv) + "." + b64.encodeToString(ct)
        }
        override fun verifyProof(payloadHash: String, proofB64: String): Boolean {
            return try {
                val p = proofB64.split(".", limit = 2)
                val iv = java.util.Base64.getDecoder().decode(p[0])
                val ct = java.util.Base64.getDecoder().decode(p[1])
                val c = Cipher.getInstance("AES/GCM/NoPadding")
                c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
                c.updateAAD(payloadHash.toByteArray(Charsets.UTF_8))
                c.doFinal(ct).contentEquals(payloadHash.toByteArray(Charsets.UTF_8))
            } catch (_: Exception) {
                false
            }
        }
    }

    private class SoftAuth(private val soft: SoftWrap, var available: Boolean = true) :
        SosNativeStrongConfirmation.StrongAuthDriver {
        override fun isSecureAuthenticatorAvailable() = available
        override fun authenticate(
            title: String,
            subtitle: String,
            payloadHash: String,
            cipherForCryptoObject: Cipher?,
            onSuccess: (String) -> Unit,
            onError: (String) -> Unit,
        ) {
            if (!available) {
                onError("STRONG_CONFIRMATION_UNAVAILABLE")
                return
            }
            onSuccess(soft.seal(payloadHash))
        }
    }

    private class CancelAuth : SosNativeStrongConfirmation.StrongAuthDriver {
        override fun isSecureAuthenticatorAvailable() = true
        override fun authenticate(
            title: String,
            subtitle: String,
            payloadHash: String,
            cipherForCryptoObject: Cipher?,
            onSuccess: (String) -> Unit,
            onError: (String) -> Unit,
        ) {
            onError("USER_CANCEL")
        }
    }

    private val rootPriv = "11".repeat(32)
    private lateinit var rootPub: String
    private lateinit var registry: SosDeviceAuthorizationRegistry
    private lateinit var soft: SoftWrap
    private var continuationCount = 0
    private var lastHandle: SosNativeStrongConfirmation.AuthorizedSealedMigrationHandle? = null

    @Before
    fun setUp() {
        rootPub = SosNostrCrypto.pubkeyFromPriv(rootPriv)
        registry = SosDeviceAuthorizationRegistry()
        soft = SoftWrap()
        continuationCount = 0
        lastHandle = null
    }

    private fun putActiveAuth(
        dEnc: String = "22".repeat(32),
        dSign: String = "33".repeat(32),
        deviceId: String = "44".repeat(32),
        epoch: Long = 1L,
        withRecovery: Boolean = true,
    ): SosDeviceAuthorization.Authorization {
        val caps = SosDeviceAuthorization.NORMAL_PROFILE.toMutableSet()
        if (withRecovery) caps.add(SosDeviceAuthorization.Capability.DEVICE_RECOVERY)
        val created = System.currentTimeMillis()
        var auth = SosDeviceAuthorization.Authorization(
            version = SosDeviceAuthorization.VERSION,
            authorizationId = SosDeviceAuthorization.newAuthorizationId(),
            accountP = rootPub,
            deviceId = deviceId,
            dSignPub = dSign,
            dEncPub = dEnc,
            capabilities = caps,
            authEpoch = epoch,
            createdAt = created,
            expiresAt = created + SosDeviceAuthorization.DEFAULT_LIFETIME_MS,
            pairingTranscriptHash = "55".repeat(32),
            pairingId = "66".repeat(16),
            storageSecurityClass = SosDeviceKeyPolicy.StorageClass.PLATFORM_WRAPPED.name,
            recoveryEligibleAtAuthorization = withRecovery,
        )
        auth = SosDeviceAuthorization.signUnderRoot(rootPriv, auth)
        assertTrue(registry.putActive(auth) is SosDeviceAuthorizationRegistry.PutResult.Ok)
        return auth
    }

    private fun reqFrom(
        auth: SosDeviceAuthorization.Authorization,
        mutate: (SosNativeStrongConfirmation.MigrationConfirmRequest) -> SosNativeStrongConfirmation.MigrationConfirmRequest = { it },
    ): SosNativeStrongConfirmation.MigrationConfirmRequest {
        val now = System.currentTimeMillis()
        val base = SosNativeStrongConfirmation.MigrationConfirmRequest(
            accountP = auth.accountP,
            authorizationId = auth.authorizationId,
            deviceId = auth.deviceId,
            dSignPub = auth.dSignPub,
            dEncPub = auth.dEncPub,
            authEpoch = auth.authEpoch,
            migrationId = SosNativeStrongConfirmation.newMigrationId(),
            nonce = SosNativeStrongConfirmation.newNonce(),
            createdAt = now,
            expiresAt = now + 60_000,
            pairingTranscriptHash = auth.pairingTranscriptHash,
            sessionGeneration = 1L,
            sessionCapability = "cap-ok",
        )
        return mutate(base)
    }

    private fun engine(
        authDriver: SosNativeStrongConfirmation.StrongAuthDriver = SoftAuth(soft),
        sessionOk: Boolean = true,
        sessionGen: Long = 1L,
    ): SosNativeStrongConfirmation.Engine {
        return SosNativeStrongConfirmation.Engine(
            deviceAuth = { account, authId, now ->
                registry.refreshExpired(account, now)
                val e = registry.get(account, authId) ?: return@Engine null
                if (e.status != SosDeviceAuthorization.Status.ACTIVE) return@Engine null
                SosDeviceAuthorization.Authorization.fromJson(org.json.JSONObject(e.signedAuthorizationJson))
            },
            sessionGate = { cap, account, gen ->
                when {
                    !sessionOk -> "SESSION_INVALID"
                    gen != sessionGen -> "SESSION_GENERATION_CHANGED"
                    account != rootPub -> "SESSION_ACCOUNT_MISMATCH"
                    cap.isBlank() -> "SESSION_REQUIRED"
                    else -> null
                }
            },
            authDriver = authDriver,
            wrapCrypto = soft,
            continuation = {
                continuationCount++
                lastHandle = it
                // F6G.3: must not read K
            },
        )
    }

    @Test
    fun validRequestInvokesContinuationWithoutReadingK() {
        val auth = putActiveAuth()
        val eng = engine()
        val r = eng.start(reqFrom(auth))
        assertTrue(r is SosNativeStrongConfirmation.StartResult.Ok)
        assertEquals(1, continuationCount)
        assertEquals(0, eng.rootKReadCount())
        assertTrue(lastHandle!!.isConsumed())
        assertFalse(SosNativeStrongConfirmation.F5B6_CONTINUATION_READS_K_IN_F6G3)
        assertFalse(SosNativeStrongConfirmation.SEALED_MIGRATION_ENVELOPE_IMPLEMENTED)
    }

    @Test
    fun missingDeviceAuthFails() {
        val auth = putActiveAuth()
        registry.remove(rootPub, auth.authorizationId)
        val r = engine().start(reqFrom(auth))
        assertEquals("NO_ACTIVE_DEVICE_AUTH", (r as SosNativeStrongConfirmation.StartResult.Err).code)
        assertEquals(0, continuationCount)
    }

    @Test
    fun missingRecoveryCapabilityFails() {
        val auth = putActiveAuth(withRecovery = false)
        val r = engine().start(reqFrom(auth))
        assertEquals("MISSING_DEVICE_RECOVERY", (r as SosNativeStrongConfirmation.StartResult.Err).code)
    }

    @Test
    fun wrongAccountFails() {
        val auth = putActiveAuth()
        val r = engine().start(reqFrom(auth) { it.copy(accountP = "aa".repeat(32)) })
        assertTrue(r is SosNativeStrongConfirmation.StartResult.Err)
    }

    @Test
    fun wrongDencFails() {
        val auth = putActiveAuth()
        val r = engine().start(reqFrom(auth) { it.copy(dEncPub = "ff".repeat(32)) })
        assertEquals("D_ENC_MISMATCH", (r as SosNativeStrongConfirmation.StartResult.Err).code)
    }

    @Test
    fun wrongEpochFails() {
        val auth = putActiveAuth()
        val r = engine().start(reqFrom(auth) { it.copy(authEpoch = 99L) })
        assertEquals("AUTH_EPOCH_MISMATCH", (r as SosNativeStrongConfirmation.StartResult.Err).code)
    }

    @Test
    fun expiredRequestFails() {
        val auth = putActiveAuth()
        val now = System.currentTimeMillis()
        val r = engine().start(
            reqFrom(auth) {
                it.copy(createdAt = now - 10_000, expiresAt = now - 1_000)
            },
        )
        assertEquals("REQUEST_EXPIRED", (r as SosNativeStrongConfirmation.StartResult.Err).code)
    }

    @Test
    fun cancelDoesNotAuthorize() {
        val auth = putActiveAuth()
        val driver = CancelAuth()
        val eng = engine(authDriver = driver)
        val r = eng.start(reqFrom(auth))
        // start returns Ok after launching auth; cancel path via onError clears pending
        assertTrue(r is SosNativeStrongConfirmation.StartResult.Ok || r is SosNativeStrongConfirmation.StartResult.Err)
        assertEquals(0, continuationCount)
    }

    @Test
    fun unavailableAuthenticatorFailsClosed() {
        val auth = putActiveAuth()
        val softAuth = SoftAuth(soft, available = false)
        val r = engine(authDriver = softAuth).start(reqFrom(auth))
        assertEquals("STRONG_CONFIRMATION_UNAVAILABLE", (r as SosNativeStrongConfirmation.StartResult.Err).code)
    }

    @Test
    fun staleSessionFails() {
        val auth = putActiveAuth()
        val r = engine(sessionOk = false).start(reqFrom(auth))
        assertEquals("SESSION_INVALID", (r as SosNativeStrongConfirmation.StartResult.Err).code)
    }

    @Test
    fun concurrentSecondRejected() {
        val auth = putActiveAuth()
        // Driver that does not immediately complete — simulate pending
        val hanging = object : SosNativeStrongConfirmation.StrongAuthDriver {
            override fun isSecureAuthenticatorAvailable() = true
            override fun authenticate(
                title: String,
                subtitle: String,
                payloadHash: String,
                cipherForCryptoObject: Cipher?,
                onSuccess: (String) -> Unit,
                onError: (String) -> Unit,
            ) {
                // leave pending
            }
        }
        val eng = engine(authDriver = hanging)
        val first = eng.start(reqFrom(auth))
        assertTrue(first is SosNativeStrongConfirmation.StartResult.Ok)
        val second = eng.start(reqFrom(putActiveAuth(dEnc = "77".repeat(32), dSign = "88".repeat(32), deviceId = "99".repeat(32))))
        assertEquals("CONFIRMATION_ALREADY_ACTIVE", (second as SosNativeStrongConfirmation.StartResult.Err).code)
    }

    @Test
    fun payloadHasNoSecrets() {
        val auth = putActiveAuth()
        val req = reqFrom(auth)
        val s = String(req.canonicalBytes())
        assertFalse(s.contains(rootPriv))
        assertFalse(s.lowercase().contains("nsec"))
        assertTrue(s.contains(SosNativeStrongConfirmation.DOMAIN))
    }

    @Test
    fun doubleConsumeHandleRejected() {
        val auth = putActiveAuth()
        engine().start(reqFrom(auth))
        val h = lastHandle!!
        assertTrue(h.isConsumed())
        assertFalse(h.consumeOnce())
    }

    @Test
    fun invalidateClearsPending() {
        val auth = putActiveAuth()
        val hanging = object : SosNativeStrongConfirmation.StrongAuthDriver {
            override fun isSecureAuthenticatorAvailable() = true
            override fun authenticate(
                title: String,
                subtitle: String,
                payloadHash: String,
                cipherForCryptoObject: Cipher?,
                onSuccess: (String) -> Unit,
                onError: (String) -> Unit,
            ) {}
        }
        val eng = engine(authDriver = hanging)
        eng.start(reqFrom(auth))
        assertTrue(eng.hasActivePending())
        eng.invalidateAll()
        assertFalse(eng.hasActivePending())
        assertEquals(0, continuationCount)
    }

    @Test
    fun normalTrustedConfirmStillSeparate() {
        // F6G NORMAL path unchanged — strong sealed migration is separate module
        assertTrue(SosNativeTrustedConfirmation.TRUSTED_NATIVE_CONFIRMATION_PRESENT)
        assertTrue(SosNativeTrustedConfirmation.F6G3_STRONG_CONFIRM_AVAILABLE)
        assertFalse(SosNativeTrustedConfirmation.F5B6_MIGRATION_IMPLEMENTED)
        assertFalse(SosNativeStrongConfirmation.GENERIC_STRONG_CONFIRM_OPERATION)
        assertFalse(SosNativeStrongConfirmation.WEBVIEW_RECEIVES_STRONG_CONFIRM_BOOLEAN)
    }
}
