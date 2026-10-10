package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * MD3 issuance status gate — fail-closed without authority / on disable.
 * Uses empty URL (no network) to prove UNKNOWN rejection without mocking HTTP.
 */
class SosGlobalAccountStatusGateTest {
    @Test
    fun unknownWithoutAdmissionUrlRejected() {
        val d = SosGlobalAccountStatusGate.assertIssuanceAllowed("11".repeat(32), null)
        assertFalse(d.ok)
        assertFalse(d.reachable)
        assertEquals("STATUS_AUTHORITY_UNAVAILABLE", d.code)
        assertFalse(SosGlobalAccountStatusGate.UNKNOWN_STATUS_NEW_DEVICE_AUTH_ACCEPTED)
    }

    @Test
    fun emptyAdmissionUrlRejected() {
        val d = SosGlobalAccountStatusGate.assertIssuanceAllowed("22".repeat(32), "  ")
        assertFalse(d.ok)
        assertEquals("STATUS_AUTHORITY_UNAVAILABLE", d.code)
    }

    @Test
    fun badPubkeyRejected() {
        val d = SosGlobalAccountStatusGate.assertIssuanceAllowed("not-a-key", "http://127.0.0.1:9")
        assertFalse(d.ok)
        assertEquals("BAD_PUBKEY", d.code)
    }

    @Test
    fun unreachableAuthorityRejected() {
        // Port 9 is discarded / closed — fail closed for issuance.
        val d = SosGlobalAccountStatusGate.assertIssuanceAllowed("33".repeat(32), "http://127.0.0.1:9")
        assertFalse(d.ok)
        assertTrue(
            d.code == "STATUS_UNAVAILABLE" ||
                d.code == "STATUS_BAD_RESPONSE" ||
                d.code == "STATUS_ERROR" ||
                !d.reachable,
        )
        assertFalse(SosGlobalAccountStatusGate.DISABLED_ACCOUNT_NEW_DEVICE_AUTH_ACCEPTED)
    }
}
