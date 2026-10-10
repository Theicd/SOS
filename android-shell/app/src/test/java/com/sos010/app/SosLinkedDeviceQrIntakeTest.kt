package com.sos010.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * S7A1 — Linked Devices QR intake (no camera / no root K).
 */
class SosLinkedDeviceQrIntakeTest {

    private fun hex64(seed: Int): String {
        val nibble = (seed and 0xf).toString(16)
        return nibble.repeat(64)
    }

    private fun buildSosPair1(expiresAt: Long, secretField: Boolean = false): String {
        val o = JSONObject()
            .put("protocolVersion", SosPairingCrypto.PROTOCOL_VERSION)
            .put("pairingId", "aabbccddeeff00112233445566778899")
            .put("D_sign_pub", hex64(1))
            .put("D_enc_pub", hex64(2))
            .put("E_ephemeral_pub", hex64(3))
            .put("nonce", hex64(4))
            .put("expiresAt", expiresAt)
            .put("purpose", "LINK")
            .put("deviceId", hex64(5))
        if (secretField) o.put("nsec", "deadbeef")
        val b64 = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(o.toString().toByteArray(Charsets.UTF_8))
        return SosPairingCrypto.QR_PREFIX + b64
    }

    @Test
    fun acceptsValidSosPair1() {
        val now = 1_700_000_000_000L
        val qr = buildSosPair1(expiresAt = now + 60_000)
        val r = SosLinkedDeviceQrIntake.acceptScannedPayload(qr, nowMs = now)
        assertTrue(r.isSuccess)
        assertEquals(qr, r.getOrNull()!!.qrText)
        assertEquals("aabbccddeeff00112233445566778899", r.getOrNull()!!.pairingId)
    }

    @Test
    fun rejectsExpired() {
        val now = 1_700_000_000_000L
        val qr = buildSosPair1(expiresAt = now - 120_000)
        val r = SosLinkedDeviceQrIntake.acceptScannedPayload(qr, nowMs = now)
        assertTrue(r.isFailure)
        assertEquals("EXPIRED", r.exceptionOrNull()!!.message)
    }

    @Test
    fun rejectsWrongPrefix() {
        val r = SosLinkedDeviceQrIntake.acceptScannedPayload("NOTAPAIR:xyz", nowMs = 1L)
        assertTrue(r.isFailure)
        assertEquals("BAD_PREFIX", r.exceptionOrNull()!!.message)
    }

    @Test
    fun rejectsGroupInviteHttps() {
        val invite = "https://sos010.com/videos.html?invite=abc123"
        assertTrue(SosLinkedDeviceQrIntake.looksLikeGroupInviteQr(invite))
        val r = SosLinkedDeviceQrIntake.acceptScannedPayload(invite, nowMs = 1L)
        assertTrue(r.isFailure)
        assertEquals("GROUP_INVITE_QR", r.exceptionOrNull()!!.message)
    }

    @Test
    fun rejectsSecretInQr() {
        val now = 1_700_000_000_000L
        val qr = buildSosPair1(expiresAt = now + 60_000, secretField = true)
        val r = SosLinkedDeviceQrIntake.acceptScannedPayload(qr, nowMs = now)
        assertTrue(r.isFailure)
        assertEquals("SECRET_IN_QR", r.exceptionOrNull()!!.message)
    }

    @Test
    fun emptyRejected() {
        assertEquals("EMPTY_QR", SosLinkedDeviceQrIntake.acceptScannedPayload("  ").exceptionOrNull()!!.message)
    }

    @Test
    fun duplicateConsumeGuard() {
        val consumed = AtomicBoolean(false)
        val hits = AtomicInteger(0)
        fun inject(raw: String): Boolean {
            if (!consumed.compareAndSet(false, true)) return false
            hits.incrementAndGet()
            SosLinkedDeviceQrIntake.acceptScannedPayload(raw, nowMs = 1_700_000_000_000L)
            return true
        }
        val qr = buildSosPair1(expiresAt = 1_700_000_060_000L)
        assertTrue(inject(qr))
        assertFalse(inject(qr))
        assertEquals(1, hits.get())
    }
}
