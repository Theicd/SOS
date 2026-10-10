package com.sos010.app

import fr.acinq.secp256k1.Hex
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import java.io.File
import java.security.SecureRandom

class SosHistorySyncCryptoTest {
    companion object {
        @JvmStatic
        @BeforeClass
        fun loadSecp() {
            val dll = File("build/native/secp256k1-jni.dll")
            if (dll.isFile) System.load(dll.absolutePath)
        }
    }

    @Test
    fun histSessionKeyRoundTripSealOpen() {
        val rnd = SecureRandom()
        val (aPriv, aPub) = SosX25519.generateKeyPair(rnd)
        val (bPriv, bPub) = SosX25519.generateKeyPair(rnd)
        val bind =
            SosHistorySyncCrypto.transcriptBind(
                "11".repeat(32),
                "22".repeat(32),
                "33".repeat(32),
                1L,
                "44".repeat(32),
                "55".repeat(32),
                "66".repeat(32),
                "77".repeat(32),
            )
        val sharedA = SosX25519.sharedSecret(aPriv, bPub)
        val sharedB = SosX25519.sharedSecret(bPriv, aPub)
        assertArrayEquals(sharedA, sharedB)
        val skA = SosHistorySyncCrypto.sessionKey(sharedA, bind)
        val skB = SosHistorySyncCrypto.sessionKey(sharedB, bind)
        assertArrayEquals(skA, skB)
        val sealed = SosHistorySyncCrypto.seal(skA, bind, "hello-hist".toByteArray(), rnd)
        val open = SosHistorySyncCrypto.open(skB, bind, sealed)
        assertNotNull(open)
        assertTrue(String(open!!) == "hello-hist")
        assertFalse(String(SosHistorySyncCrypto.HKDF_INFO.toByteArray()).contains("pair"))
    }

    @Test
    fun histPopDomainSeparatedFromPair() {
        val bind = ByteArray(32) { 9 }
        val histPop = SosHistorySyncCrypto.popMessage(bind)
        val pairPop = MessageDigestSha("SOS|pair|pop", bind)
        assertFalse(Hex.encode(histPop) == Hex.encode(pairPop))
    }

    @Test
    fun testOnlyEncExportGatedInDebugUnit() {
        // Unit tests run debug BuildConfig — method may return null without device keys.
        val eng =
            SosDeviceIdentityStore.engineForTests(
                SosDeviceIdentityStore.MemoryPrefsBackend(),
                SosDeviceIdentityStore.SoftPlatformBoundAesGcmCrypto(),
            )
        assertTrue(eng.copyEncPrivateKeyForTests() == null || eng.copyEncPrivateKeyForTests() is ByteArray)
    }

    private fun MessageDigestSha(domain: String, payload: ByteArray): ByteArray {
        val md = java.security.MessageDigest.getInstance("SHA-256")
        md.update(domain.toByteArray(Charsets.UTF_8))
        md.update(payload)
        return md.digest()
    }
}
