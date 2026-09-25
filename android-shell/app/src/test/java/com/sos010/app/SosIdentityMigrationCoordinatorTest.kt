package com.sos010.app

import fr.acinq.secp256k1.Hex
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * F6H orchestration tests — soft strong-auth in TEST source only.
 */
class SosIdentityMigrationCoordinatorTest {

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

    private class SoftAuth(private val soft: SoftWrap) : SosNativeStrongConfirmation.StrongAuthDriver {
        override fun isSecureAuthenticatorAvailable() = true
        override fun authenticate(
            title: String,
            subtitle: String,
            payloadHash: String,
            cipherForCryptoObject: Cipher?,
            onSuccess: (String) -> Unit,
            onError: (String) -> Unit,
        ) {
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
    private var sessionValid = true
    private var sessionAccount = ""
    private var deliverFail = false
    private var lastDelivered: String? = null

    @Before
    fun setUp() {
        rootPub = SosNostrCrypto.pubkeyFromPriv(rootPrivHex)
        rootPrivBytes = Hex.decode(rootPrivHex)
        destKeys = SosDeviceKeyCrypto.generate()
        registry = SosDeviceAuthorizationRegistry()
        soft = SoftWrap()
        identityReads = 0
        storedDestP = null
        sessionValid = true
        sessionAccount = rootPub
        deliverFail = false
        lastDelivered = null
    }

    private fun putAuth(
        withRecovery: Boolean = true,
        keys: SosDeviceKeyCrypto.GeneratedDeviceKeys = destKeys,
        label: String = "מחשב בית",
    ): SosDeviceAuthorization.Authorization {
        val caps = SosDeviceAuthorization.NORMAL_PROFILE.toMutableSet()
        if (withRecovery) caps.add(SosDeviceAuthorization.Capability.DEVICE_RECOVERY)
        val created = System.currentTimeMillis()
        var auth = SosDeviceAuthorization.Authorization(
            version = SosDeviceAuthorization.VERSION,
            authorizationId = SosDeviceAuthorization.newAuthorizationId(),
            accountP = rootPub,
            deviceId = keys.deviceId,
            dSignPub = keys.signPubHex,
            dEncPub = keys.encPubHex,
            capabilities = caps,
            authEpoch = 1L,
            createdAt = created,
            expiresAt = created + SosDeviceAuthorization.DEFAULT_LIFETIME_MS,
            pairingTranscriptHash = "55".repeat(32),
            pairingId = "66".repeat(16),
            storageSecurityClass = SosDeviceKeyPolicy.StorageClass.PLATFORM_WRAPPED.name,
            recoveryEligibleAtAuthorization = withRecovery,
            deviceLabel = label,
            deviceType = "DESKTOP",
        )
        auth = SosDeviceAuthorization.signUnderRoot(rootPrivHex, auth)
        assertTrue(registry.putActive(auth) is SosDeviceAuthorizationRegistry.PutResult.Ok)
        return auth
    }

    private fun engine(
        authDriver: SosNativeStrongConfirmation.StrongAuthDriver = SoftAuth(soft),
        keys: SosDeviceKeyCrypto.GeneratedDeviceKeys = destKeys,
    ): SosIdentityMigrationCoordinator.Engine {
        return SosIdentityMigrationCoordinator.Engine(
            registry = registry,
            identity = {
                identityReads++
                rootPrivBytes.copyOf() to rootPub
            },
            sessionGate = { _, acc, _ ->
                when {
                    !sessionValid -> "SESSION_INVALID"
                    SosDeviceKeyCrypto.normalizeHex(acc) != SosDeviceKeyCrypto.normalizeHex(sessionAccount) ->
                        "ACCOUNT_SWITCH"
                    else -> null
                }
            },
            strongAuthDriver = authDriver,
            wrapCrypto = soft,
            delivery = { json ->
                if (deliverFail) "DELIVERY_FAILED"
                else {
                    lastDelivered = json
                    null
                }
            },
            destOps = object : SosIdentityMigrationCoordinator.DestDeviceOps {
                override fun localDeviceId() = keys.deviceId
                override fun localDSignPub() = keys.signPubHex
                override fun localDEncPub() = keys.encPubHex
                override fun ecdhWithLocalDEnc(peerEphPubHex: String) =
                    SosDeviceKeyCrypto.deviceEcdh(keys.encPriv, peerEphPubHex)
                override fun signWithLocalDSign(payload: ByteArray) =
                    SosDeviceKeyCrypto.signDevicePayload(keys.signPriv, payload)
            },
            destWriter = { k, expectedP ->
                val derived = SosNostrCrypto.pubkeyFromPriv(Hex.encode(k))
                if (SosDeviceKeyCrypto.normalizeHex(derived) != SosDeviceKeyCrypto.normalizeHex(expectedP)) {
                    "EXPECTED_PUBKEY_MISMATCH"
                } else if (storedDestP != null &&
                    SosDeviceKeyCrypto.normalizeHex(storedDestP) != SosDeviceKeyCrypto.normalizeHex(derived)
                ) {
                    "DIFFERENT_IDENTITY_OVERWRITE"
                } else {
                    storedDestP = derived
                    null
                }
            },
            destExisting = { storedDestP },
        )
    }

    private fun runFullFlow(): SosIdentityMigrationCoordinator.Engine {
        val auth = putAuth()
        val eng = engine()
        val begin = eng.beginMigration(rootPub, auth.deviceId, "cap", 1L)
        assertTrue(begin is SosIdentityMigrationCoordinator.Outcome.Ok)
        assertEquals(0, identityReads)
        assertEquals(
            SosIdentityMigrationCoordinator.SourcePhase.READY_FOR_CONFIRMATION,
            eng.sourcePhase(),
        )
        val uiId = (begin as SosIdentityMigrationCoordinator.Outcome.Ok).ui.uiId
        val seal = eng.confirmAndSeal(uiId)
        assertTrue(
            "confirmAndSeal failed: ${(seal as? SosIdentityMigrationCoordinator.Outcome.Err)?.code} ui=${eng.uiState()}",
            seal is SosIdentityMigrationCoordinator.Outcome.Ok,
        )
        assertEquals(1, identityReads)
        assertEquals(1, eng.successfulRootKReadCount())
        assertEquals(0, eng.preauthRootKReadCount())
        val envJson = lastDelivered!!
        assertFalse(envJson.contains(rootPrivHex))
        val dest = eng.destinationReceive(envJson)
        assertTrue(dest is SosIdentityMigrationCoordinator.Outcome.Ok)
        val ackJson = (dest as SosIdentityMigrationCoordinator.Outcome.Ok).value as String
        val ack = eng.onDestinationAck(uiId, ackJson)
        assertTrue(ack is SosIdentityMigrationCoordinator.Outcome.Ok)
        assertEquals(SosIdentityMigrationCoordinator.SourcePhase.COMPLETE, eng.sourcePhase())
        assertTrue(eng.uiState().isSuccess)
        assertFalse(eng.uiState().toPublicJson().optBoolean("historySyncClaimed", true))
        assertTrue(eng.uiState().historyNote.contains("סנכרון"))
        assertFalse(eng.uiState().body.lowercase().contains("nsec"))
        assertFalse(eng.uiState().body.contains("D_enc"))
        assertEquals(rootPub.lowercase(), storedDestP!!.lowercase())
        return eng
    }

    @Test
    fun validSourceDestinationSameAccountFlow() {
        runFullFlow()
    }

    @Test
    fun explicitMigrationStartRequired() {
        putAuth()
        val eng = engine()
        assertEquals(SosIdentityMigrationCoordinator.SourcePhase.IDLE, eng.sourcePhase())
        assertTrue(SosIdentityMigrationCoordinator.F6H_MIGRATION_REQUIRES_EXPLICIT_USER_ACTION)
    }

    @Test
    fun eligibleTargetListingHidesNonRecovery() {
        putAuth(withRecovery = true)
        val other = SosDeviceKeyCrypto.generate()
        putAuth(withRecovery = false, keys = other, label = "טלפון")
        val eng = engine()
        val list = eng.listRecoveryEligibleLinkedDevices(rootPub)
        assertEquals(1, list.size)
        assertTrue(list[0].recoveryEligible)
        assertFalse(list.any { it.deviceId == other.deviceId })
    }

    @Test
    fun nonRecoveryDeviceRejected() {
        val auth = putAuth(withRecovery = false)
        val eng = engine()
        val r = eng.beginMigration(rootPub, auth.deviceId, "cap", 1L)
        assertEquals("DEVICE_NOT_ELIGIBLE", (r as SosIdentityMigrationCoordinator.Outcome.Err).code)
        assertEquals(0, identityReads)
    }

    @Test
    fun biometricCancelNoK() {
        val auth = putAuth()
        val eng = engine(CancelAuth())
        val begin = eng.beginMigration(rootPub, auth.deviceId, "cap", 1L) as SosIdentityMigrationCoordinator.Outcome.Ok
        val r = eng.confirmAndSeal(begin.ui.uiId)
        assertTrue(r is SosIdentityMigrationCoordinator.Outcome.Err)
        assertEquals(0, identityReads)
        assertFalse(eng.uiState().isSuccess)
    }

    @Test
    fun differentDestinationAccountFailsClosed() {
        val auth = putAuth()
        val eng = engine()
        val begin = eng.beginMigration(rootPub, auth.deviceId, "cap", 1L) as SosIdentityMigrationCoordinator.Outcome.Ok
        eng.confirmAndSeal(begin.ui.uiId)
        storedDestP = "aa".repeat(32)
        val dest = eng.destinationReceive(lastDelivered!!)
        assertEquals("ACCOUNT_MISMATCH", (dest as SosIdentityMigrationCoordinator.Outcome.Err).code)
        assertEquals("aa".repeat(32), storedDestP)
    }

    @Test
    fun sameDestinationAccountIdempotent() {
        val eng = runFullFlow()
        val env = lastDelivered!!
        val again = eng.destinationReceive(env)
        assertTrue(again is SosIdentityMigrationCoordinator.Outcome.Ok)
    }

    @Test
    fun emptyDestinationImports() {
        runFullFlow()
        assertEquals(rootPub.lowercase(), storedDestP!!.lowercase())
    }

    @Test
    fun deliveryFailureBeforeAckNotSuccess() {
        val auth = putAuth()
        deliverFail = true
        val eng = engine()
        val begin = eng.beginMigration(rootPub, auth.deviceId, "cap", 1L) as SosIdentityMigrationCoordinator.Outcome.Ok
        val r = eng.confirmAndSeal(begin.ui.uiId)
        assertTrue(r is SosIdentityMigrationCoordinator.Outcome.Err)
        assertEquals(SosIdentityMigrationCoordinator.SourcePhase.WAITING_DESTINATION_ACK, eng.sourcePhase())
        assertFalse(eng.uiState().isSuccess)
        assertEquals(1, identityReads) // seal happened
    }

    @Test
    fun retransmitDoesNotReseal() {
        val auth = putAuth()
        deliverFail = true
        val eng = engine()
        val begin = eng.beginMigration(rootPub, auth.deviceId, "cap", 1L) as SosIdentityMigrationCoordinator.Outcome.Ok
        eng.confirmAndSeal(begin.ui.uiId)
        val reads = identityReads
        deliverFail = false
        val r = eng.retransmitSealedEnvelope(begin.ui.uiId)
        assertTrue(r is SosIdentityMigrationCoordinator.Outcome.Ok)
        assertEquals(reads, identityReads)
    }

    @Test
    fun cancelClearsCeremony() {
        val auth = putAuth()
        val eng = engine()
        val begin = eng.beginMigration(rootPub, auth.deviceId, "cap", 1L) as SosIdentityMigrationCoordinator.Outcome.Ok
        eng.cancel(begin.ui.uiId)
        assertEquals(SosIdentityMigrationCoordinator.SourcePhase.IDLE, eng.sourcePhase())
        assertFalse(eng.uiState().isSuccess)
    }

    @Test
    fun processRestartClearsApproval() {
        val auth = putAuth()
        val eng = engine()
        eng.beginMigration(rootPub, auth.deviceId, "cap", 1L)
        eng.onProcessRestart()
        assertEquals(SosIdentityMigrationCoordinator.SourcePhase.IDLE, eng.sourcePhase())
    }

    @Test
    fun logoutAborts() {
        val auth = putAuth()
        val eng = engine()
        eng.beginMigration(rootPub, auth.deviceId, "cap", 1L)
        eng.onLogoutOrAccountSwitch()
        assertEquals(SosIdentityMigrationCoordinator.SourcePhase.IDLE, eng.sourcePhase())
    }

    @Test
    fun doubleStartBounded() {
        val auth = putAuth()
        val eng = engine()
        eng.beginMigration(rootPub, auth.deviceId, "cap", 1L)
        val second = eng.beginMigration(rootPub, auth.deviceId, "cap", 1L)
        assertEquals("MIGRATION_ALREADY_ACTIVE", (second as SosIdentityMigrationCoordinator.Outcome.Err).code)
    }

    @Test
    fun targetSwitchInvalidates() {
        val a = putAuth(label = "A")
        val keysB = SosDeviceKeyCrypto.generate()
        putAuth(keys = keysB, label = "B")
        val eng = engine()
        val first = eng.beginMigration(rootPub, a.deviceId, "cap", 1L) as SosIdentityMigrationCoordinator.Outcome.Ok
        eng.cancel(first.ui.uiId)
        val second = eng.beginMigration(rootPub, keysB.deviceId, "cap", 1L) as SosIdentityMigrationCoordinator.Outcome.Ok
        assertTrue(second.ui.selectedDevice!!.deviceId == keysB.deviceId)
        assertTrue(second.ui.uiId != first.ui.uiId)
    }

    @Test
    fun sessionInvalidBlocks() {
        putAuth()
        sessionValid = false
        val eng = engine()
        val auth = registry.entries(rootPub).first()
        val r = eng.beginMigration(rootPub, auth.deviceId, "cap", 1L)
        assertEquals("SESSION_INVALID", (r as SosIdentityMigrationCoordinator.Outcome.Err).code)
        assertEquals(0, identityReads)
    }

    @Test
    fun uiHasNoCryptoJargonOrSecrets() {
        val eng = runFullFlow()
        val j = eng.uiState().toPublicJson().toString().lowercase()
        assertFalse(j.contains("nsec"))
        assertFalse(j.contains("d_enc"))
        assertFalse(j.contains("hkdf"))
        assertFalse(j.contains("aead"))
        assertFalse(j.contains(rootPrivHex))
        assertTrue(eng.uiState().title.contains("החשבון"))
    }

    @Test
    fun noHistoryClaim() {
        assertFalse(SosIdentityMigrationCoordinator.F6H_HISTORY_SYNC_IMPLEMENTED)
        val eng = runFullFlow()
        assertTrue(eng.uiState().historyNote.contains("סנכרון השיחות יתבצע"))
    }

    @Test
    fun usesF5b6AndF6g3Flags() {
        assertTrue(SosIdentityMigrationCoordinator.F6H_USES_F5B6)
        assertTrue(SosIdentityMigrationCoordinator.F6H_USES_F6G3)
        assertFalse(SosIdentityMigrationCoordinator.F6H_PARALLEL_WEAKER_MIGRATION_CRYPTO)
        assertFalse(SosIdentityMigrationCoordinator.FULL_DESKTOP_TO_NEW_PHONE_RECOVERY_IMPLEMENTED)
        assertFalse(SosIdentityMigrationCoordinator.WINDOWS_F6H_RUNTIME_IMPLEMENTED)
        assertTrue(SosIdentityMigrationCoordinator.F5B5_EMERGENCY_RECOVERY_PATH_UNCHANGED)
    }
}
