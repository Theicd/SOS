package com.sos010.app

import fr.acinq.secp256k1.Hex
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * F5B6 unit tests — disposable identities; soft strong-auth in TEST source only.
 */
class SosSealedIdentityMigrationTest {

    companion object {
        @JvmStatic
        @BeforeClass
        fun loadSecp() {
            val dll = java.io.File("build/native/secp256k1-jni.dll")
            if (dll.isFile) System.load(dll.absolutePath)
        }
    }

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
            val b64 = Base64.getEncoder()
            return b64.encodeToString(iv) + "." + b64.encodeToString(ct)
        }
        override fun verifyProof(payloadHash: String, proofB64: String): Boolean {
            return try {
                val p = proofB64.split(".", limit = 2)
                val iv = Base64.getDecoder().decode(p[0])
                val ct = Base64.getDecoder().decode(p[1])
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

    private val rootPrivHex = "11".repeat(32)
    private lateinit var rootPub: String
    private lateinit var rootPrivBytes: ByteArray
    private lateinit var destKeys: SosDeviceKeyCrypto.GeneratedDeviceKeys
    private lateinit var registry: SosDeviceAuthorizationRegistry
    private lateinit var soft: SoftWrap
    private var identityReads = 0
    private var storedDestP: String? = null
    private var storedDestK: ByteArray? = null
    private var sessionValid = true
    private var sessionAccount = ""
    private var sessionGen = 1L

    @Before
    fun setUp() {
        rootPub = SosNostrCrypto.pubkeyFromPriv(rootPrivHex)
        rootPrivBytes = Hex.decode(rootPrivHex)
        destKeys = SosDeviceKeyCrypto.generate()
        registry = SosDeviceAuthorizationRegistry()
        soft = SoftWrap()
        identityReads = 0
        storedDestP = null
        storedDestK = null
        sessionValid = true
        sessionAccount = rootPub
        sessionGen = 1L
    }

    private fun putAuth(
        withRecovery: Boolean = true,
        epoch: Long = 1L,
        dEnc: String = destKeys.encPubHex,
        dSign: String = destKeys.signPubHex,
        deviceId: String = destKeys.deviceId,
        accountP: String = rootPub,
    ): SosDeviceAuthorization.Authorization {
        val caps = SosDeviceAuthorization.NORMAL_PROFILE.toMutableSet()
        if (withRecovery) caps.add(SosDeviceAuthorization.Capability.DEVICE_RECOVERY)
        val created = System.currentTimeMillis()
        var auth = SosDeviceAuthorization.Authorization(
            version = SosDeviceAuthorization.VERSION,
            authorizationId = SosDeviceAuthorization.newAuthorizationId(),
            accountP = accountP,
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
        auth = SosDeviceAuthorization.signUnderRoot(rootPrivHex, auth)
        assertTrue(registry.putActive(auth) is SosDeviceAuthorizationRegistry.PutResult.Ok)
        return auth
    }

    private fun source(
        authDriver: SosNativeStrongConfirmation.StrongAuthDriver = SoftAuth(soft),
        kBytes: ByteArray = rootPrivBytes,
    ): SosSealedIdentityMigration.SourceEngine {
        return SosSealedIdentityMigration.SourceEngine(
            identity = {
                identityReads++
                kBytes.copyOf() to SosNostrCrypto.pubkeyFromPriv(Hex.encode(kBytes))
            },
            deviceAuth = { acc, id, now ->
                registry.refreshExpired(acc, now)
                val e = registry.get(acc, id)
                if (e == null || e.status != SosDeviceAuthorization.Status.ACTIVE) null
                else SosDeviceAuthorization.Authorization.fromJson(JSONObject(e.signedAuthorizationJson))
            },
            sessionGate = { _, acc, gen ->
                when {
                    !sessionValid -> "SESSION_INVALID"
                    SosDeviceKeyCrypto.normalizeHex(acc) != SosDeviceKeyCrypto.normalizeHex(sessionAccount) ->
                        "ACCOUNT_SWITCH"
                    gen != sessionGen -> "SESSION_GENERATION_MISMATCH"
                    else -> null
                }
            },
            strongAuthDriver = authDriver,
            wrapCrypto = soft,
        )
    }

    private fun dest(): SosSealedIdentityMigration.DestinationEngine {
        return SosSealedIdentityMigration.DestinationEngine(
            device = object : SosSealedIdentityMigration.DestinationDeviceOps {
                override fun localDeviceId() = destKeys.deviceId
                override fun localDSignPub() = destKeys.signPubHex
                override fun localDEncPub() = destKeys.encPubHex
                override fun ecdhWithLocalDEnc(peerEphPubHex: String): ByteArray? {
                    return try {
                        SosDeviceKeyCrypto.deviceEcdh(destKeys.encPriv, peerEphPubHex)
                    } catch (_: Exception) {
                        null
                    }
                }
                override fun signWithLocalDSign(payload: ByteArray): ByteArray? {
                    return try {
                        SosDeviceKeyCrypto.signDevicePayload(destKeys.signPriv, payload)
                    } catch (_: Exception) {
                        null
                    }
                }
            },
            writer = { k, expectedP ->
                val derived = SosNostrCrypto.pubkeyFromPriv(Hex.encode(k))
                when {
                    SosDeviceKeyCrypto.normalizeHex(derived) != SosDeviceKeyCrypto.normalizeHex(expectedP) ->
                        "EXPECTED_PUBKEY_MISMATCH"
                    storedDestP != null &&
                        SosDeviceKeyCrypto.normalizeHex(storedDestP) != SosDeviceKeyCrypto.normalizeHex(derived) ->
                        "DIFFERENT_IDENTITY_OVERWRITE"
                    else -> {
                        storedDestK = k.copyOf()
                        storedDestP = derived
                        null
                    }
                }
            },
            existing = { storedDestP },
            deviceAuthLookup = { acc, id, now ->
                registry.refreshExpired(acc, now)
                val e = registry.get(acc, id)
                if (e == null || e.status != SosDeviceAuthorization.Status.ACTIVE) null
                else SosDeviceAuthorization.Authorization.fromJson(JSONObject(e.signedAuthorizationJson))
            },
        )
    }

    private fun freshDest(spent: ConcurrentHashMap<String, Pair<String, SosSealedIdentityMigration.Ack>> = ConcurrentHashMap()) =
        SosSealedIdentityMigration.DestinationEngine(
            device = object : SosSealedIdentityMigration.DestinationDeviceOps {
                override fun localDeviceId() = destKeys.deviceId
                override fun localDSignPub() = destKeys.signPubHex
                override fun localDEncPub() = destKeys.encPubHex
                override fun ecdhWithLocalDEnc(peerEphPubHex: String) =
                    SosDeviceKeyCrypto.deviceEcdh(destKeys.encPriv, peerEphPubHex)
                override fun signWithLocalDSign(payload: ByteArray) =
                    SosDeviceKeyCrypto.signDevicePayload(destKeys.signPriv, payload)
            },
            writer = { k, expectedP ->
                val derived = SosNostrCrypto.pubkeyFromPriv(Hex.encode(k))
                when {
                    SosDeviceKeyCrypto.normalizeHex(derived) != SosDeviceKeyCrypto.normalizeHex(expectedP) ->
                        "EXPECTED_PUBKEY_MISMATCH"
                    storedDestP != null &&
                        SosDeviceKeyCrypto.normalizeHex(storedDestP) != SosDeviceKeyCrypto.normalizeHex(derived) ->
                        "DIFFERENT_IDENTITY_OVERWRITE"
                    else -> {
                        storedDestK = k.copyOf()
                        storedDestP = derived
                        null
                    }
                }
            },
            existing = { storedDestP },
            deviceAuthLookup = { acc, id, now ->
                registry.refreshExpired(acc, now)
                val e = registry.get(acc, id)
                if (e == null || e.status != SosDeviceAuthorization.Status.ACTIVE) null
                else SosDeviceAuthorization.Authorization.fromJson(JSONObject(e.signedAuthorizationJson))
            },
            spent = spent,
        )

    private fun runHappyPath(): Triple<
        SosSealedIdentityMigration.SourceEngine,
        SosSealedIdentityMigration.Envelope,
        SosSealedIdentityMigration.Ack,
        > {
        val auth = putAuth()
        val src = source()
        assertTrue(src.prepare(auth.authorizationId, "cap", 1L, rootPub) is SosSealedIdentityMigration.Result.Ok)
        assertEquals(0, identityReads)
        assertTrue(src.startStrongConfirm() is SosSealedIdentityMigration.Result.Ok)
        assertEquals(SosSealedIdentityMigration.State.SEALED, src.state())
        assertEquals(1, identityReads)
        assertEquals(1, src.successfulRootKReadCount())
        val env = src.lastEnvelope()!!
        assertFalse(env.toJson().toString().contains(rootPrivHex))
        src.markDelivered()
        val destResult = dest().receiveAndImport(env)
        assertTrue(destResult is SosSealedIdentityMigration.Result.Ok)
        val ack = (destResult as SosSealedIdentityMigration.Result.Ok).value as SosSealedIdentityMigration.Ack
        assertTrue(src.verifyAck(ack) is SosSealedIdentityMigration.Result.Ok)
        assertEquals(SosSealedIdentityMigration.State.COMPLETE, src.state())
        assertEquals(rootPub.lowercase(), storedDestP!!.lowercase())
        assertTrue(storedDestK!!.contentEquals(rootPrivBytes))
        return Triple(src, env, ack)
    }

    @Test
    fun validSameKMigration() {
        runHappyPath()
    }

    @Test
    fun missingRecoveryFailsBeforeKRead() {
        val auth = putAuth(withRecovery = false)
        val src = source()
        val r = src.prepare(auth.authorizationId, "cap", 1L, rootPub)
        assertEquals("MISSING_DEVICE_RECOVERY", (r as SosSealedIdentityMigration.Result.Err).code)
        assertEquals(0, identityReads)
        assertEquals(0, src.preauthRootKReadCount())
    }

    @Test
    fun wrongAuthEpochFails() {
        val auth = putAuth(epoch = 1L)
        val src = source()
        src.prepare(auth.authorizationId, "cap", 1L, rootPub)
        // Replace with epoch 2
        registry.remove(rootPub, auth.authorizationId)
        putAuth(epoch = 2L, deviceId = auth.deviceId, dEnc = auth.dEncPub, dSign = auth.dSignPub)
        // Original auth gone — prepare with old id fails
        val src2 = source()
        val r = src2.prepare(auth.authorizationId, "cap", 1L, rootPub)
        assertEquals("NO_ACTIVE_DEVICE_AUTH", (r as SosSealedIdentityMigration.Result.Err).code)
        assertEquals(0, identityReads)
    }

    @Test
    fun cancelBeforeConfirmReadsNoK() {
        val auth = putAuth()
        val src = source(CancelAuth())
        src.prepare(auth.authorizationId, "cap", 1L, rootPub)
        src.startStrongConfirm()
        assertEquals(0, identityReads)
        assertTrue(src.state() == SosSealedIdentityMigration.State.FAILED ||
            src.state() == SosSealedIdentityMigration.State.CANCELLED ||
            src.lastEnvelope() == null)
    }

    @Test
    fun strongConfirmCancelNoEnvelope() {
        val auth = putAuth()
        val src = source(CancelAuth())
        src.prepare(auth.authorizationId, "cap", 1L, rootPub)
        val r = src.startStrongConfirm()
        assertTrue(r is SosSealedIdentityMigration.Result.Err)
        assertEquals(0, identityReads)
        assertEquals(null, src.lastEnvelope())
    }

    @Test
    fun sessionInvalidBeforeConfirmNoK() {
        val auth = putAuth()
        sessionValid = false
        val src = source()
        val r = src.prepare(auth.authorizationId, "cap", 1L, rootPub)
        assertEquals("SESSION_INVALID", (r as SosSealedIdentityMigration.Result.Err).code)
        assertEquals(0, identityReads)
    }

    @Test
    fun accountSwitchDuringPendingFails() {
        val auth = putAuth()
        var capturedHash = ""
        val deferred = object : SosNativeStrongConfirmation.StrongAuthDriver {
            var onOk: ((String) -> Unit)? = null
            override fun isSecureAuthenticatorAvailable() = true
            override fun authenticate(
                title: String,
                subtitle: String,
                payloadHash: String,
                cipherForCryptoObject: Cipher?,
                onSuccess: (String) -> Unit,
                onError: (String) -> Unit,
            ) {
                capturedHash = payloadHash
                onOk = onSuccess
            }
        }
        val src = source(deferred)
        src.prepare(auth.authorizationId, "cap", 1L, rootPub)
        src.startStrongConfirm()
        sessionAccount = "aa".repeat(32)
        deferred.onOk!!(soft.seal(capturedHash))
        assertEquals(0, identityReads)
        assertTrue(src.state() == SosSealedIdentityMigration.State.FAILED)
        assertEquals(null, src.lastEnvelope())
    }

    @Test
    fun dEncChangeDuringPendingFails() {
        val auth = putAuth()
        var capturedHash = ""
        val deferred = object : SosNativeStrongConfirmation.StrongAuthDriver {
            var onOk: ((String) -> Unit)? = null
            override fun isSecureAuthenticatorAvailable() = true
            override fun authenticate(
                title: String,
                subtitle: String,
                payloadHash: String,
                cipherForCryptoObject: Cipher?,
                onSuccess: (String) -> Unit,
                onError: (String) -> Unit,
            ) {
                capturedHash = payloadHash
                onOk = onSuccess
            }
        }
        val src = source(deferred)
        src.prepare(auth.authorizationId, "cap", 1L, rootPub)
        src.startStrongConfirm()
        registry.remove(rootPub, auth.authorizationId)
        putAuth(dEnc = "77".repeat(32), dSign = auth.dSignPub, deviceId = auth.deviceId)
        deferred.onOk!!(soft.seal(capturedHash))
        // Strong confirm itself may fail DEVICE_AUTH_CHANGED; either way no K seal with new D
        assertTrue(src.lastEnvelope() == null || src.state() == SosSealedIdentityMigration.State.FAILED)
        // If strong confirm cleared before migration continuation, reads stay 0
    }

    @Test
    fun rootKPMismatchNoEnvelope() {
        val auth = putAuth()
        val wrongK = Hex.decode("99".repeat(32))
        val src = source(kBytes = wrongK)
        src.prepare(auth.authorizationId, "cap", 1L, rootPub)
        src.startStrongConfirm()
        assertEquals(SosSealedIdentityMigration.State.FAILED, src.state())
        assertEquals(null, src.lastEnvelope())
    }

    @Test
    fun wrongDeviceIdRejectedAtDestination() {
        val (_, env, _) = runHappyPath()
        destKeys = SosDeviceKeyCrypto.generate() // different device
        // re-register auth for old device still in registry — dest local ids differ
        val r = dest().receiveAndImport(env)
        assertEquals("DEVICE_ID_MISMATCH", (r as SosSealedIdentityMigration.Result.Err).code)
    }

    @Test
    fun ciphertextMutationFailsAead() {
        val (_, env, _) = runHappyPath()
        // Fresh dest for second receive — use new spent map via new dest engine but same keys
        // First import already spent migrationId — use mutated envelope with same id → either replay or aead
        val mutated = env.copy(
            ciphertextB64 = Base64.getEncoder().encodeToString(
                ByteArray(48).also { SecureRandom().nextBytes(it) },
            ),
        )
        // New destination engine with empty spent
        val dest2 = freshDest()
        val r = dest2.receiveAndImport(mutated)
        assertTrue(
            (r as SosSealedIdentityMigration.Result.Err).code in setOf(
                "BAD_ROOT_SIGNATURE",
                "AEAD_FAIL",
                "MIGRATION_ID_REPLAY",
            ),
        )
    }

    @Test
    fun aadMutationFails() {
        val (_, env, _) = runHappyPath()
        val badHeader = env.header.copy(migrationNonce = "dd".repeat(32))
        // Signature won't match mutated header
        val mutated = env.copy(header = badHeader)
        val dest2 = freshDest()
        val r = dest2.receiveAndImport(mutated)
        assertEquals("BAD_ROOT_SIGNATURE", (r as SosSealedIdentityMigration.Result.Err).code)
    }

    @Test
    fun rootSignatureFailure() {
        val (_, env, _) = runHappyPath()
        val mutated = env.copy(rootSignatureHex = "00".repeat(64))
        val dest2 = freshDest()
        assertEquals("BAD_ROOT_SIGNATURE", (dest2.receiveAndImport(mutated) as SosSealedIdentityMigration.Result.Err).code)
    }

    @Test
    fun differentExistingAccountNotOverwritten() {
        val auth = putAuth()
        val src = source()
        src.prepare(auth.authorizationId, "cap", 1L, rootPub)
        src.startStrongConfirm()
        val env = src.lastEnvelope()!!
        storedDestP = "aa".repeat(32)
        val r = dest().receiveAndImport(env)
        assertEquals("ACCOUNT_MISMATCH", (r as SosSealedIdentityMigration.Result.Err).code)
        assertEquals("aa".repeat(32), storedDestP)
    }

    @Test
    fun sameExistingAccountIdempotentAck() {
        val (_, env, ack1) = runHappyPath()
        assertNotNull(ack1)
        val spent = ConcurrentHashMap<String, Pair<String, SosSealedIdentityMigration.Ack>>()
        val dest3 = freshDest(spent)
        val first = dest3.receiveAndImport(env)
        assertTrue(first is SosSealedIdentityMigration.Result.Ok)
        val second = dest3.receiveAndImport(env)
        assertTrue(second is SosSealedIdentityMigration.Result.Ok)
        val a1 = (first as SosSealedIdentityMigration.Result.Ok).value as SosSealedIdentityMigration.Ack
        val a2 = (second as SosSealedIdentityMigration.Result.Ok).value as SosSealedIdentityMigration.Ack
        assertEquals(a1.envelopeCommitment, a2.envelopeCommitment)
        assertEquals(a1.signatureHex, a2.signatureHex)
    }

    @Test
    fun ackWrongDSignRejected() {
        val auth = putAuth()
        val src2 = source()
        src2.prepare(auth.authorizationId, "cap", 1L, rootPub)
        src2.startStrongConfirm()
        src2.markDelivered()
        val bad2 = SosSealedIdentityMigration.Ack(
            migrationId = src2.lastEnvelope()!!.header.migrationId,
            authorizationId = auth.authorizationId,
            deviceId = auth.deviceId,
            accountP = rootPub,
            authEpoch = auth.authEpoch,
            envelopeCommitment = src2.lastEnvelope()!!.envelopeCommitment(),
            signatureHex = "00".repeat(64),
        )
        assertEquals("ACK_BAD_SIGNATURE", (src2.verifyAck(bad2) as SosSealedIdentityMigration.Result.Err).code)
    }

    @Test
    fun processRestartClearsApproval() {
        val auth = putAuth()
        val src = source()
        src.prepare(auth.authorizationId, "cap", 1L, rootPub)
        src.invalidateOnRestart()
        assertEquals(SosSealedIdentityMigration.State.IDLE, src.state())
        assertEquals(null, src.lastEnvelope())
    }

    @Test
    fun envelopeContainsNoPlaintextK() {
        val (_, env, _) = runHappyPath()
        val s = env.toJson().toString()
        assertFalse(s.contains(rootPrivHex))
        assertFalse(s.lowercase().contains("nsec"))
        assertTrue(s.contains(SosSealedIdentityMigration.VERSION))
    }

    @Test
    fun unknownVersionFailsClosed() {
        val o = JSONObject().put("version", "sos-sealed-migration-v99")
        assertEquals(
            "MALFORMED_ENVELOPE",
            (dest().receiveAndImport(o) as SosSealedIdentityMigration.Result.Err).code,
        )
    }

    @Test
    fun allZeroX25519Rejected() {
        assertTrue(SosSealedIdentityMigration.isAllZero(ByteArray(32)))
        assertFalse(SosSealedIdentityMigration.isAllZero(byteArrayOf(1) + ByteArray(31)))
    }

    @Test
    fun completeRequiresAck() {
        val auth = putAuth()
        val src = source()
        src.prepare(auth.authorizationId, "cap", 1L, rootPub)
        src.startStrongConfirm()
        assertEquals(SosSealedIdentityMigration.State.SEALED, src.state())
        assertFalse(src.state() == SosSealedIdentityMigration.State.COMPLETE)
    }

    @Test
    fun callerCannotOverrideDEnc() {
        val auth = putAuth()
        val src = source()
        src.prepare(auth.authorizationId, "cap", 1L, rootPub)
        src.startStrongConfirm()
        assertEquals(auth.dEncPub.lowercase(), src.lastEnvelope()!!.header.dEncPub.lowercase())
    }
}
