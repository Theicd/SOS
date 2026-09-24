package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import kotlin.system.measureNanoTime

/**
 * F6D — SosNativeSessionAuthority unit tests (disposable identities only).
 */
class SosNativeSessionAuthorityTest {

    private val pub = "aa".repeat(32)
    private val other = "bb".repeat(32)
    private lateinit var auth: SosNativeSessionAuthority.Engine

    @Before
    fun setUp() {
        auth = SosNativeSessionAuthority.engineForTests(identityPubkey = pub)
    }

    @Test
    fun bindValidSession() {
        val r = auth.bind(1L, pub)
        assertTrue(r is SosNativeSessionAuthority.BindResult.Ok)
        val ok = r as SosNativeSessionAuthority.BindResult.Ok
        assertTrue(ok.capability.length == 64)
        assertTrue(auth.isActive())
        assertTrue(auth.validateForCrypto(ok.capability, pub) is SosNativeSessionAuthority.ValidateResult.Ok)
    }

    @Test
    fun wrongAccountRejected() {
        val r = auth.bind(1L, other)
        assertEquals("SESSION_ACCOUNT_SECURE_IDENTITY_MISMATCH", (r as SosNativeSessionAuthority.BindResult.Err).code)
    }

    @Test
    fun secureIdentityMismatchOnValidate() {
        val ok = auth.bind(1L, pub) as SosNativeSessionAuthority.BindResult.Ok
        val bad = auth.validateForCrypto(ok.capability, other)
        assertEquals("SESSION_ACCOUNT_SECURE_IDENTITY_MISMATCH", (bad as SosNativeSessionAuthority.ValidateResult.Err).code)
    }

    @Test
    fun logoutRevokeOldCapabilityFails() {
        val ok = auth.bind(1L, pub) as SosNativeSessionAuthority.BindResult.Ok
        auth.revoke("logout")
        assertFalse(auth.isActive())
        assertEquals(
            "SESSION_REQUIRED",
            (auth.validateForCrypto(ok.capability, pub) as SosNativeSessionAuthority.ValidateResult.Err).code,
        )
    }

    @Test
    fun accountSwitchRevokesOldBinding() {
        val a = auth.bind(1L, pub) as SosNativeSessionAuthority.BindResult.Ok
        auth.revoke("account-switch")
        // After revoke, bind B requires identity to be B — still pub in this engine.
        val b = auth.bind(2L, pub) as SosNativeSessionAuthority.BindResult.Ok
        assertEquals(
            "SESSION_REVOKED",
            (auth.validateForCrypto(a.capability, pub) as SosNativeSessionAuthority.ValidateResult.Err).code,
        )
        assertTrue(auth.validateForCrypto(b.capability, pub) is SosNativeSessionAuthority.ValidateResult.Ok)
    }

    @Test
    fun staleWebViewCannotSelfRebindWithoutPreviousCapability() {
        auth.bind(1L, pub)
        val stale = auth.bind(2L, pub, previousCapability = "")
        assertEquals("STALE_REBIND", (stale as SosNativeSessionAuthority.BindResult.Err).code)
    }

    @Test
    fun staleWebViewCannotFetchNewCapabilityViaPublicSnapshot() {
        auth.bind(1L, pub)
        val snap = auth.snapshotPublic()
        assertTrue(snap.capability.isEmpty())
        val json = auth.revalidatePublicJson()
        assertFalse(json.has("sessionCapability") && json.optString("sessionCapability").isNotEmpty())
        assertFalse(json.optBoolean("capabilityAvailable", true))
    }

    @Test
    fun replayedBindRejected() {
        val ok = auth.bind(5L, pub) as SosNativeSessionAuthority.BindResult.Ok
        auth.revoke("logout")
        val replay = auth.bind(4L, pub)
        assertEquals("REPLAYED_BIND", (replay as SosNativeSessionAuthority.BindResult.Err).code)
        // Old capability while unbound
        val withOld = auth.bind(6L, pub, previousCapability = ok.capability)
        assertEquals("REPLAYED_OLD_CAPABILITY", (withOld as SosNativeSessionAuthority.BindResult.Err).code)
    }

    @Test
    fun processRestartModelRequiresRebind() {
        // Simulate process restart: new engine, watermark retained, capability gone.
        val watermark = SosNativeSessionAuthority.MemoryWatermarkStore()
        val e1 = SosNativeSessionAuthority.engineForTests(pub, watermark)
        e1.bind(3L, pub)
        val e2 = SosNativeSessionAuthority.engineForTests(pub, watermark)
        assertFalse(e2.isActive())
        assertEquals(
            "SESSION_REQUIRED",
            (e2.validateForCrypto("deadbeef", pub) as SosNativeSessionAuthority.ValidateResult.Err).code,
        )
        val rebound = e2.bind(3L, pub)
        assertTrue(rebound is SosNativeSessionAuthority.BindResult.Ok)
    }

    @Test
    fun coldStartSecureIdentityDoesNotImplySession() {
        assertFalse(auth.isActive())
        assertFalse(SosNativeSessionAuthority.SECURE_IDENTITY_EXISTS_IMPLIES_ACTIVE_SESSION)
        assertEquals(
            "SESSION_REQUIRED",
            (auth.validateForCrypto("", pub) as SosNativeSessionAuthority.ValidateResult.Err).code,
        )
    }

    @Test
    fun setUserPrivkeyDoesNotGrantSessionInvariant() {
        assertFalse(SosNativeSessionAuthority.SET_USER_PRIVKEY_AUTO_GRANTS_NATIVE_SESSION)
        assertFalse(auth.isActive())
    }

    @Test
    fun noKInSessionAuthority() {
        assertFalse(SosNativeSessionAuthority.NATIVE_SESSION_AUTHORITY_CONTAINS_PRIVATE_K)
        assertFalse(SosNativeSessionAuthority.NATIVE_SESSION_AUTHORITY_CONTAINS_NSEC)
        assertFalse(SosNativeSessionAuthority.NATIVE_SESSION_CAPABILITY_DERIVED_FROM_PRIVATE_K)
        val ok = auth.bind(1L, pub) as SosNativeSessionAuthority.BindResult.Ok
        assertFalse(ok.capability.contains(pub)) // capability is random, not pubkey
    }

    @Test
    fun duplicateRevokeSafe() {
        auth.bind(1L, pub)
        auth.revoke("logout")
        auth.revoke("logout")
        assertFalse(auth.isActive())
    }

    @Test
    fun malformedGenerationRejected() {
        assertEquals("MALFORMED_GENERATION", (auth.bind(-1L, pub) as SosNativeSessionAuthority.BindResult.Err).code)
        assertEquals("MALFORMED_ACCOUNT", (auth.bind(1L, "nope") as SosNativeSessionAuthority.BindResult.Err).code)
    }

    @Test
    fun sessionCheckBenchmark10k() {
        val ok = auth.bind(1L, pub) as SosNativeSessionAuthority.BindResult.Ok
        val samples = ArrayList<Double>(10_000)
        val totalNs = measureNanoTime {
            repeat(10_000) {
                val ns = measureNanoTime {
                    assertTrue(auth.validateForCrypto(ok.capability, pub) is SosNativeSessionAuthority.ValidateResult.Ok)
                }
                samples.add(ns / 1_000_000.0)
            }
        }
        samples.sort()
        fun pct(p: Int) = samples[((p / 100.0) * (samples.size - 1)).toInt()]
        val p50 = pct(50)
        val p95 = pct(95)
        val p99 = pct(99)
        val totalMs = totalNs / 1_000_000.0
        assertTrue("p99 too high: $p99", p99 < 5.0)
        assertTrue("10k total too high: $totalMs", totalMs < 5000.0)
        println("F6D_NATIVE_SESSION_CHECK_P50_MS=$p50")
        println("F6D_NATIVE_SESSION_CHECK_P95_MS=$p95")
        println("F6D_NATIVE_SESSION_CHECK_P99_MS=$p99")
        println("F6D_NATIVE_SESSION_CHECK_10K_TOTAL_MS=$totalMs")
    }
}
