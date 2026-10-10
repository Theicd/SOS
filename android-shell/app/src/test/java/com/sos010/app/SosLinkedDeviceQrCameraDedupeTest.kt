package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Mirrors SosLinkedDeviceQrCamera consume semantics without CameraX/ML Kit.
 */
class SosLinkedDeviceQrCameraDedupeTest {

    @Test
    fun onlyFirstDecodedPayloadWins() {
        val consumed = AtomicBoolean(false)
        val delivered = AtomicInteger(0)
        fun onPayload(@Suppress("UNUSED_PARAMETER") raw: String) {
            delivered.incrementAndGet()
        }
        fun inject(raw: String): Boolean {
            if (!consumed.compareAndSet(false, true)) return false
            onPayload(raw)
            return true
        }
        assertTrue(inject("SOSPAIR1:a"))
        assertFalse(inject("SOSPAIR1:b"))
        assertFalse(inject("SOSPAIR1:a"))
        assertEquals(1, delivered.get())
        consumed.set(false)
        assertTrue(inject("SOSPAIR1:c"))
        assertEquals(2, delivered.get())
    }
}
