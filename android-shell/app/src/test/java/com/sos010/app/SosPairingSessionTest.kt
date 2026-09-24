package com.sos010.app

import fr.acinq.secp256k1.Hex
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import java.util.Base64

/**
 * MD2 — QR pairing protocol unit tests (no DeviceAuthorization / no root K).
 */
class SosPairingSessionTest {

    companion object {
        @JvmStatic
        @BeforeClass
        fun loadSecp() {
            val dll = java.io.File("build/native/secp256k1-jni.dll")
            if (dll.isFile) System.load(dll.absolutePath)
        }
    }

    private lateinit var prefs: SosDeviceIdentityStore.MemoryPrefsBackend
    private lateinit var device: SosDeviceIdentityStore.Engine
    private lateinit var spent: SosPairingSpentStore

    @Before
    fun setUp() {
        prefs = SosDeviceIdentityStore.MemoryPrefsBackend()
        device = SosDeviceIdentityStore.engineForTests(
            prefs,
            SosDeviceIdentityStore.SoftPlatformBoundAesGcmCrypto(),
        )
        spent = SosPairingSpentStore()
    }

    @Test
    fun happyPathBindsExactDeviceKeys() {
        val bound = SosPairingSession.runLocalPairing(device, spent)
        val meta = device.getPublicMetadata()!!
        assertEquals(meta.dSignPub, bound.dSignPub)
        assertEquals(meta.dEncPub, bound.dEncPub)
        assertEquals(6, bound.sas.length)
        assertTrue(bound.fingerprint.contains("…"))
        assertEquals(SosPairingCrypto.Purpose.LINK, bound.purpose)
    }

    @Test
    fun qrContainsNoSecrets() {
        val init = SosPairingSession.Initiator(device)
        val begin = init.begin() as SosPairingSession.StepResult.Ok
        val qr = begin.qr!!
        assertTrue(qr.startsWith(SosPairingCrypto.QR_PREFIX))
        val lower = qr.lowercase()
        assertFalse(lower.contains("nsec"))
        assertFalse(lower.contains("priv"))
        val parsed = SosPairingCrypto.parseQr(qr).getOrThrow()
        assertEquals(SosPairingCrypto.PROTOCOL_VERSION, parsed.protocolVersion)
        assertTrue(SosDeviceKeyCrypto.isHex64(parsed.dSignPub))
    }

    @Test
    fun unknownProtocolVersionFailsClosed() {
        val init = SosPairingSession.Initiator(device)
        val begin = init.begin() as SosPairingSession.StepResult.Ok
        val raw = String(
            Base64.getUrlDecoder().decode(begin.qr!!.removePrefix(SosPairingCrypto.QR_PREFIX)),
            Charsets.UTF_8,
        )
        val o = JSONObject(raw).put("protocolVersion", "sos-pair-v999")
        val bad = SosPairingCrypto.QR_PREFIX + Base64.getUrlEncoder().withoutPadding()
            .encodeToString(o.toString().toByteArray())
        val r = SosPairingCrypto.parseQr(bad)
        assertTrue(r.isFailure)
        assertEquals("UNKNOWN_PROTOCOL_VERSION", r.exceptionOrNull()!!.message)
    }

    @Test
    fun expiredQrRejected() {
        val init = SosPairingSession.Initiator(device, ttlMs = 1)
        val begin = init.begin() as SosPairingSession.StepResult.Ok
        Thread.sleep(5)
        // Force far-future skew exceed by parsing with large now
        val parsed = SosPairingCrypto.parseQr(begin.qr!!, nowMs = System.currentTimeMillis() + 10 * 60_000L)
        assertTrue(parsed.isFailure)
        assertEquals("EXPIRED", parsed.exceptionOrNull()!!.message)
    }

    @Test
    fun replayRejected() {
        val init = SosPairingSession.Initiator(device)
        val begin = init.begin() as SosPairingSession.StepResult.Ok
        val resp = SosPairingSession.Responder(spent)
        val hello = resp.acceptQr(begin.qr!!) as SosPairingSession.StepResult.Ok
        val pop = init.onMessage(hello.outboundMessage!!) as SosPairingSession.StepResult.Ok
        val ack = resp.onMessage(pop.outboundMessage!!) as SosPairingSession.StepResult.Ok
        assertEquals(SosPairingSession.State.CHANNEL_READY, ack.state)

        val resp2 = SosPairingSession.Responder(spent)
        val again = resp2.acceptQr(begin.qr!!)
        assertTrue(again is SosPairingSession.StepResult.Err)
        assertEquals("REPLAY", (again as SosPairingSession.StepResult.Err).code)
    }

    @Test
    fun deviceKeySubstitutionFailsChannelOrPop() {
        val init = SosPairingSession.Initiator(device)
        val begin = init.begin() as SosPairingSession.StepResult.Ok
        // Attacker replaces D_sign_pub in QR with unrelated key.
        // Phone transcript uses evil D; initiator signs/seals under real D transcript → AEAD or POP fail.
        val raw = String(
            Base64.getUrlDecoder().decode(begin.qr!!.removePrefix(SosPairingCrypto.QR_PREFIX)),
            Charsets.UTF_8,
        )
        val o = JSONObject(raw)
        o.put("D_sign_pub", "11".repeat(32))
        val evilQr = SosPairingCrypto.QR_PREFIX + Base64.getUrlEncoder().withoutPadding()
            .encodeToString(o.toString().toByteArray())

        val resp = SosPairingSession.Responder(spent)
        val hello = resp.acceptQr(evilQr) as SosPairingSession.StepResult.Ok
        val pop = init.onMessage(hello.outboundMessage!!) as SosPairingSession.StepResult.Ok
        val ack = resp.onMessage(pop.outboundMessage!!)
        assertTrue(ack is SosPairingSession.StepResult.Err)
        val code = (ack as SosPairingSession.StepResult.Err).code
        assertTrue("expected AEAD_FAIL or POP_FAIL, got $code", code == "AEAD_FAIL" || code == "POP_FAIL")
    }

    @Test
    fun aeadTamperFails() {
        val init = SosPairingSession.Initiator(device)
        val begin = init.begin() as SosPairingSession.StepResult.Ok
        val resp = SosPairingSession.Responder(spent)
        val hello = resp.acceptQr(begin.qr!!) as SosPairingSession.StepResult.Ok
        val pop = init.onMessage(hello.outboundMessage!!) as SosPairingSession.StepResult.Ok
        val tampered = JSONObject(pop.outboundMessage!!)
        val ct = Base64.getDecoder().decode(tampered.getString("ct"))
        ct[0] = (ct[0].toInt() xor 0x01).toByte()
        tampered.put("ct", Base64.getEncoder().encodeToString(ct))
        val ack = resp.onMessage(tampered.toString())
        assertTrue(ack is SosPairingSession.StepResult.Err)
        assertEquals("AEAD_FAIL", (ack as SosPairingSession.StepResult.Err).code)
    }

    @Test
    fun secretFieldInQrRejected() {
        val evil = JSONObject()
            .put("protocolVersion", SosPairingCrypto.PROTOCOL_VERSION)
            .put("pairingId", "aa".repeat(8))
            .put("D_sign_pub", "11".repeat(32))
            .put("D_enc_pub", "22".repeat(32))
            .put("E_ephemeral_pub", "33".repeat(32))
            .put("nonce", "44".repeat(32))
            .put("expiresAt", System.currentTimeMillis() + 60_000)
            .put("nsec", "deadbeef")
        val qr = SosPairingCrypto.QR_PREFIX + Base64.getUrlEncoder().withoutPadding()
            .encodeToString(evil.toString().toByteArray())
        val r = SosPairingCrypto.parseQr(qr)
        assertTrue(r.isFailure)
        assertEquals("SECRET_IN_QR", r.exceptionOrNull()!!.message)
    }

    @Test
    fun twoPairingsProduceDistinctTranscripts() {
        val a = SosPairingSession.runLocalPairing(device, SosPairingSpentStore())
        // same device, new pairing
        val b = SosPairingSession.runLocalPairing(device, SosPairingSpentStore())
        assertEquals(a.dSignPub, b.dSignPub)
        assertNotEquals(a.pairingId, b.pairingId)
        assertNotEquals(a.transcriptHex, b.transcriptHex)
    }

    @Test
    fun boundDestinationExposesOnlyPublicMaterial() {
        val bound = SosPairingSession.runLocalPairing(device, spent)
        assertEquals(64, bound.dSignPub.length)
        assertEquals(64, bound.dEncPub.length)
        assertEquals(64, bound.transcriptHex.length)
        val json = JSONObject()
            .put("dSignPub", bound.dSignPub)
            .put("dEncPub", bound.dEncPub)
            .toString()
            .lowercase()
        assertFalse(json.contains("priv"))
        assertFalse(json.contains("nsec"))
    }
}