package com.sos010.app

import fr.acinq.secp256k1.Hex
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * MD1 — Device identity store unit tests (soft AES; no production Keystore / secrets in reports).
 */
class SosDeviceIdentityStoreTest {

    companion object {
        @JvmStatic
        @BeforeClass
        fun loadSecp() {
            val dll = java.io.File("build/native/secp256k1-jni.dll")
            if (dll.isFile) {
                System.load(dll.absolutePath)
            }
        }
    }

    private lateinit var prefs: SosDeviceIdentityStore.MemoryPrefsBackend
    private lateinit var soft: SosDeviceIdentityStore.SoftAesGcmCrypto
    private lateinit var platformSoft: SosDeviceIdentityStore.SoftPlatformBoundAesGcmCrypto

    private fun softEngine() = SosDeviceIdentityStore.engineForTests(prefs, soft)
    private fun platformEngine() = SosDeviceIdentityStore.engineForTests(prefs, platformSoft)

    @Before
    fun setUp() {
        prefs = SosDeviceIdentityStore.MemoryPrefsBackend()
        soft = SosDeviceIdentityStore.SoftAesGcmCrypto()
        platformSoft = SosDeviceIdentityStore.SoftPlatformBoundAesGcmCrypto()
    }

    @Test
    fun absentThenCreatePersistsPublicMetadata() {
        assertEquals(SosDeviceIdentityStore.State.ABSENT, softEngine().state())
        val r = softEngine().createOrGet()
        assertTrue(r is SosDeviceIdentityStore.CreateResult.Ok)
        val meta = (r as SosDeviceIdentityStore.CreateResult.Ok).metadata
        assertEquals(SosDeviceKeyPolicy.KEY_FORMAT_VERSION, meta.version)
        assertEquals(64, meta.deviceId.length)
        assertEquals(64, meta.dSignPub.length)
        assertEquals(64, meta.dEncPub.length)
        assertEquals(SosDeviceKeyPolicy.StorageClass.SOFTWARE_ONLY, meta.storageClass)
        assertFalse(meta.recoveryEligible)
        assertEquals(SosDeviceIdentityStore.State.OK, softEngine().state())
        val again = softEngine().getPublicMetadata()
        assertNotNull(again)
        assertEquals(meta.deviceId, again!!.deviceId)
        assertEquals(meta.dSignPub, again.dSignPub)
    }

    @Test
    fun platformWrappedIsRecoveryEligibleButCapabilityNotGranted() {
        val r = platformEngine().createOrGet()
        assertTrue(r is SosDeviceIdentityStore.CreateResult.Ok)
        val meta = (r as SosDeviceIdentityStore.CreateResult.Ok).metadata
        assertEquals(SosDeviceKeyPolicy.StorageClass.PLATFORM_WRAPPED, meta.storageClass)
        assertTrue(meta.recoveryEligible)
        assertFalse(SosDeviceKeyPolicy.RECOVERY_CAPABILITY_GRANTED_IN_MD1)
    }

    @Test
    fun createIsIdempotentSameIdentity() {
        val a = (softEngine().createOrGet() as SosDeviceIdentityStore.CreateResult.Ok).metadata
        val b = (softEngine().createOrGet() as SosDeviceIdentityStore.CreateResult.Ok).metadata
        assertEquals(a.deviceId, b.deviceId)
        assertEquals(a.dSignPub, b.dSignPub)
        assertEquals(a.dEncPub, b.dEncPub)
    }

    @Test
    fun twoEnginesIndependentKeys() {
        val e1 = SosDeviceIdentityStore.engineForTests(
            SosDeviceIdentityStore.MemoryPrefsBackend(),
            SosDeviceIdentityStore.SoftAesGcmCrypto(),
        )
        val e2 = SosDeviceIdentityStore.engineForTests(
            SosDeviceIdentityStore.MemoryPrefsBackend(),
            SosDeviceIdentityStore.SoftAesGcmCrypto(),
        )
        val m1 = (e1.createOrGet() as SosDeviceIdentityStore.CreateResult.Ok).metadata
        val m2 = (e2.createOrGet() as SosDeviceIdentityStore.CreateResult.Ok).metadata
        assertNotEquals(m1.deviceId, m2.deviceId)
        assertNotEquals(m1.dSignPub, m2.dSignPub)
        assertNotEquals(m1.dEncPub, m2.dEncPub)
    }

    @Test
    fun signAndVerifyRoundTrip() {
        softEngine().createOrGet()
        val payload = "SOS-MD1-sign-test".toByteArray(Charsets.UTF_8)
        val sig = softEngine().signDevicePayload(payload)
        assertTrue(sig is SosDeviceIdentityStore.OpResult.Ok)
        val hex = (sig as SosDeviceIdentityStore.OpResult.Ok).signatureHex
        assertTrue(softEngine().verifyDevicePayload(payload, hex))
        assertFalse(softEngine().verifyDevicePayload("tampered".toByteArray(), hex))
    }

    @Test
    fun ecdhSymmetricWithDisposablePeer() {
        softEngine().createOrGet()
        val meta = softEngine().getPublicMetadata()!!
        val (peerPriv, peerPub) = SosX25519.generateKeyPair()
        val peerPubHex = Hex.encode(peerPub)
        val local = softEngine().deviceEcdh(peerPubHex)
        assertTrue(local is SosDeviceIdentityStore.OpResult.Ok)
        val ssLocal = Hex.decode((local as SosDeviceIdentityStore.OpResult.Ok).sharedSecretHex)
        // Peer computes against our D_enc_pub
        val ourPub = Hex.decode(meta.dEncPub)
        val ssPeer = SosX25519.sharedSecret(peerPriv, ourPub)
        assertTrue(ssLocal.contentEquals(ssPeer))
        SosDeviceKeyCrypto.zeroize(peerPriv, ssLocal, ssPeer)
    }

    @Test
    fun corruptSignBlobFailsClosedNoAutoRegen() {
        softEngine().createOrGet()
        prefs.corruptSignCiphertext()
        assertEquals(SosDeviceIdentityStore.State.RECOVERY_REQUIRED, softEngine().state())
        val r = softEngine().createOrGet()
        assertTrue(r is SosDeviceIdentityStore.CreateResult.Err)
        assertEquals("CORRUPT_NO_AUTO_REGEN", (r as SosDeviceIdentityStore.CreateResult.Err).code)
    }

    @Test
    fun corruptEncBlobFailsClosed() {
        softEngine().createOrGet()
        prefs.corruptEncCiphertext()
        assertEquals(SosDeviceIdentityStore.State.RECOVERY_REQUIRED, softEngine().state())
        assertTrue(softEngine().signDevicePayload(byteArrayOf(1)) is SosDeviceIdentityStore.OpResult.Err)
    }

    @Test
    fun wrongAadViaPubTamperFailsUnwrapOrMismatch() {
        softEngine().createOrGet()
        prefs.putMetaField("DSignPub", "ff".repeat(32))
        assertEquals(SosDeviceIdentityStore.State.RECOVERY_REQUIRED, softEngine().state())
    }

    @Test
    fun wrongDeviceIdFailsClosed() {
        softEngine().createOrGet()
        prefs.putMetaField("deviceId", "aa".repeat(32))
        assertEquals(SosDeviceIdentityStore.State.RECOVERY_REQUIRED, softEngine().state())
    }

    @Test
    fun concurrentCreateSingleIdentity() {
        val engine = softEngine()
        val pool = Executors.newFixedThreadPool(8)
        val futures = (1..16).map {
            pool.submit(Callable { engine.createOrGet() })
        }
        pool.shutdown()
        assertTrue(pool.awaitTermination(30, TimeUnit.SECONDS))
        val oks = futures.map { it.get() }.filterIsInstance<SosDeviceIdentityStore.CreateResult.Ok>()
        assertEquals(16, oks.size)
        val ids = oks.map { it.metadata.deviceId }.toSet()
        assertEquals(1, ids.size)
    }

    @Test
    fun localDeleteDoesNotClaimRemoteRevocation() {
        softEngine().createOrGet()
        assertTrue(softEngine().deleteLocalDeviceIdentity())
        assertEquals(SosDeviceIdentityStore.State.ABSENT, softEngine().state())
        assertTrue(SosDeviceKeyPolicy.LOCAL_DEVICE_KEY_DELETE_DOES_NOT_CLAIM_REMOTE_REVOCATION)
        // Can create a NEW local identity after delete (different keys)
        val again = (softEngine().createOrGet() as SosDeviceIdentityStore.CreateResult.Ok).metadata
        assertEquals(64, again.deviceId.length)
    }

    @Test
    fun publicMetadataJsonHasNoSecrets() {
        softEngine().createOrGet()
        val json = softEngine().getPublicMetadata()!!.toJson().toString().lowercase()
        assertFalse(json.contains("priv"))
        assertFalse(json.contains("nsec"))
        assertFalse(json.contains("wrapping"))
        assertFalse(json.contains("\"k\""))
    }

    @Test
    fun maxLinkedDevicesPolicyFrozen() {
        assertEquals(4, SosDeviceKeyPolicy.MAX_LINKED_DEVICES)
    }

    @Test
    fun x25519Rfc7748AliceVector() {
        // RFC 7748 §6.1 Alice
        val alicePriv = Hex.decode("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        val alicePub = SosX25519.publicFromPrivate(alicePriv)
        assertEquals(
            "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
            Hex.encode(alicePub),
        )
    }

    @Test
    fun deviceKeysNotDerivedFromRootK() {
        // Structural: generate does not accept/read K — only CSPRNG
        val a = SosDeviceKeyCrypto.generate()
        val b = SosDeviceKeyCrypto.generate()
        assertNotEquals(Hex.encode(a.signPriv), Hex.encode(b.signPriv))
        SosDeviceKeyCrypto.zeroize(a.signPriv, a.encPriv, b.signPriv, b.encPriv)
        assertFalse(SosDeviceKeyPolicy.ROOT_K_REQUIRED_ON_EVERY_DEVICE)
    }
}
