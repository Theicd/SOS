package com.sos010.app

import fr.acinq.secp256k1.Hex
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import java.security.SecureRandom

class SosHistorySyncHelloGateTest {
    companion object {
        @JvmStatic
        @BeforeClass
        fun loadSecp() {
            val dll = java.io.File("build/native/secp256k1-jni.dll")
            if (dll.isFile) System.load(dll.absolutePath)
        }
    }

    private val rnd = SecureRandom()

    private fun hex32(): String = Hex.encode(ByteArray(32).also { rnd.nextBytes(it) })

    private fun authAndHello(): Pair<SosDeviceAuthorization.Authorization, JSONObject> {
        val accountP = hex32()
        val deviceId = hex32()
        val authId = hex32()
        val transcript = hex32()
        val dSignPriv = ByteArray(32).also { rnd.nextBytes(it) }
        val dSignPub = SosNostrCrypto.pubkeyFromPriv(Hex.encode(dSignPriv))
        val (_, dEncPubBytes) = SosX25519.generateKeyPair(rnd)
        val dEncPub = Hex.encode(dEncPubBytes)
        val auth =
            SosDeviceAuthorization.Authorization(
                version = SosDeviceAuthorization.VERSION,
                authorizationId = authId,
                accountP = accountP,
                deviceId = deviceId,
                dSignPub = dSignPub,
                dEncPub = dEncPub,
                capabilities =
                    setOf(
                        SosDeviceAuthorization.Capability.DEVICE_CHAT,
                        SosDeviceAuthorization.Capability.DEVICE_HISTORY_SYNC,
                    ),
                authEpoch = 1L,
                createdAt = System.currentTimeMillis(),
                expiresAt = System.currentTimeMillis() + 3_600_000L,
                pairingTranscriptHash = transcript,
                pairingId = hex32(),
                storageSecurityClass = "TEE_PREFERRED",
                recoveryEligibleAtAuthorization = false,
                deviceLabel = "t",
                rootSignatureHex = "aa".repeat(32),
            )
        val sessionNonce = hex32()
        val bind =
            SosHistorySyncCrypto.transcriptBind(
                accountP,
                deviceId,
                authId,
                1L,
                transcript,
                sessionNonce,
                dSignPub,
                dEncPub,
            )
        val pop = SosHistorySyncCrypto.popMessage(bind)
        val popSig = Hex.encode(SosDeviceKeyCrypto.signRawSchnorr(dSignPriv, pop))
        val (ephPriv, ephPub) = SosX25519.generateKeyPair(rnd)
        SosDeviceKeyCrypto.zeroize(ephPriv)
        val hello =
            JSONObject()
                .put("type", "SYNC_HELLO")
                .put("protocol", SosHistorySyncCrypto.PROTOCOL_VERSION)
                .put("sessionNonce", sessionNonce)
                .put("accountP", accountP)
                .put("deviceId", deviceId)
                .put("authorizationId", authId)
                .put("authEpoch", 1L)
                .put("pairingTranscriptHash", transcript)
                .put("D_sign_pub", dSignPub)
                .put("D_enc_pub", dEncPub)
                .put("ephDesktopPub", Hex.encode(ephPub))
                .put("popSig", popSig)
                .put("createdAt", System.currentTimeMillis())
                .put("expiresAt", System.currentTimeMillis() + 60_000L)
        return auth to hello
    }

    @Test
    fun validHelloPasses() {
        val (auth, hello) = authAndHello()
        val spent = linkedSetOf<String>()
        val r = SosHistorySyncHelloGate.validate(hello, auth, spent)
        assertTrue(r.ok)
        assertEquals("OK", r.code)
    }

    @Test
    fun rejectWrongAccountDeviceEpochTranscriptProtocolReplayExpiredBadPop() {
        val (auth, hello) = authAndHello()
        val spent = linkedSetOf<String>()

        fun mut(key: String, value: Any): JSONObject {
            val o = JSONObject(hello.toString())
            o.put(key, value)
            return o
        }

        assertEquals("ACCOUNT_MISMATCH", SosHistorySyncHelloGate.validate(mut("accountP", hex32()), auth, linkedSetOf()).code)
        assertEquals("DEVICE_MISMATCH", SosHistorySyncHelloGate.validate(mut("deviceId", hex32()), auth, linkedSetOf()).code)
        assertEquals("AUTH_EPOCH_MISMATCH", SosHistorySyncHelloGate.validate(mut("authEpoch", 99L), auth, linkedSetOf()).code)
        assertEquals(
            "PAIRING_TRANSCRIPT_MISMATCH",
            SosHistorySyncHelloGate.validate(mut("pairingTranscriptHash", hex32()), auth, linkedSetOf()).code,
        )
        assertEquals("D_ENC_MISMATCH", SosHistorySyncHelloGate.validate(mut("D_enc_pub", hex32()), auth, linkedSetOf()).code)
        assertEquals("PROTOCOL_CONFUSION", SosHistorySyncHelloGate.validate(mut("protocol", "sos-pair-v1"), auth, linkedSetOf()).code)
        assertEquals("EXPIRED", SosHistorySyncHelloGate.validate(mut("expiresAt", 1L), auth, linkedSetOf()).code)
        assertEquals("BAD_POP", SosHistorySyncHelloGate.validate(mut("popSig", "bb".repeat(64)), auth, linkedSetOf()).code)

        assertTrue(SosHistorySyncHelloGate.validate(hello, auth, spent).ok)
        assertEquals("REPLAY_SESSION_NONCE", SosHistorySyncHelloGate.validate(hello, auth, spent).code)
    }

    @Test
    fun aeadTamperFailsClosed() {
        val (aPriv, _) = SosX25519.generateKeyPair(rnd)
        val (_, bPub) = SosX25519.generateKeyPair(rnd)
        val bind = ByteArray(32) { 7 }
        val sk = SosHistorySyncCrypto.sessionKey(SosX25519.sharedSecret(aPriv, bPub), bind)
        val sealed = SosHistorySyncCrypto.seal(sk, bind, "cki".toByteArray(), rnd)
        val tampered = sealed.copy(ctB64 = sealed.ctB64.dropLast(4) + "AAAA")
        assertEquals(null, SosHistorySyncCrypto.open(sk, bind, tampered))
        SosDeviceKeyCrypto.zeroize(aPriv)
        SosDeviceKeyCrypto.zeroize(sk)
    }
}
