package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import kotlin.system.measureNanoTime

/**
 * F6G — trusted confirmation state machine + admin confirmation flow.
 */
class SosNativeTrustedConfirmationTest {
    companion object {
        init {
            val dll = java.io.File("build/native/secp256k1-jni.dll")
            if (dll.exists()) System.load(dll.absolutePath)
        }
    }

    private var now = 1_700_000_000_000L
    private lateinit var prefs: SosSecureIdentityStore.MemoryPrefsBackend
    private lateinit var storeCrypto: SosSecureIdentityStore.SoftAesGcmCrypto
    private lateinit var privHex: String
    private lateinit var pubHex: String
    private val community = "sos-confirm-community"
    private val cap = "session-cap-1"

    private fun derive(hex: String) = SosNostrCrypto.pubkeyFromPriv(hex)

    private fun identityEngine() = SosSecureIdentityStore.engineForTests(
        prefs = prefs,
        crypto = storeCrypto,
        derivePubkey = ::derive,
        legacyReader = { "" to "" },
    )

    private fun intent(
        op: SosNativeAdminPolicy.AdminOp = SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME,
        requestId: String = "req-1",
        params: Map<String, Any?> = mapOf("displayName" to "NewName"),
        account: String = pubHex,
        sessionCap: String = cap,
        communityId: String = community,
    ) = SosNativeTrustedConfirmation.IntentSpec(
        requestId = requestId,
        operation = op,
        communityId = communityId,
        accountPubkey = account,
        sessionCapability = sessionCap,
        params = params,
    )

    private fun engine(
        sessionOk: (String, String) -> String? = { _, _ -> null },
        ui: SosNativeTrustedConfirmation.TestUiPresenter? = null,
    ) = SosNativeTrustedConfirmation.engineForTests(
        nowMs = { now },
        sessionValidator = sessionOk,
        uiPresenter = ui,
    )

    @Before
    fun setUp() {
        prefs = SosSecureIdentityStore.MemoryPrefsBackend()
        storeCrypto = SosSecureIdentityStore.SoftAesGcmCrypto()
        privHex = "0000000000000000000000000000000000000000000000000000000000000001"
        pubHex = SosNostrCrypto.pubkeyFromPriv(privHex)
        assertTrue(identityEngine().writeIdentitySameAccount(privHex, pubHex) is SosSecureIdentityStore.WriteResult.Ok)
        now = 1_700_000_000_000L
    }

    @Test
    fun validRequestCreatesChallenge() {
        val eng = engine()
        val r = eng.create(intent())
        assertTrue(r is SosNativeTrustedConfirmation.CreateResult.Ok)
        val ok = r as SosNativeTrustedConfirmation.CreateResult.Ok
        assertEquals("SET_GROUP_DISPLAY_NAME", ok.pending.operation)
        assertEquals(community, ok.pending.communityId)
        assertTrue(ok.pending.summaryTitle.isNotBlank())
        assertFalse(ok.challengeId.isBlank())
    }

    @Test
    fun invalidSessionCannotCreateChallenge() {
        val eng = engine(sessionOk = { _, _ -> "SESSION_REVOKED" })
        val r = eng.create(intent())
        assertEquals("SESSION_REVOKED", (r as SosNativeTrustedConfirmation.CreateResult.Err).code)
    }

    @Test
    fun emptyCommunityRejected() {
        val r = engine().create(intent(communityId = ""))
        assertEquals(
            "EXPLICIT_COMMUNITY_SCOPE_REQUIRED",
            (r as SosNativeTrustedConfirmation.CreateResult.Err).code,
        )
    }

    @Test
    fun payloadMutationDetectedOnConsume() {
        val eng = engine()
        val i1 = intent(params = mapOf("displayName" to "A"))
        val created = eng.create(i1) as SosNativeTrustedConfirmation.CreateResult.Ok
        val ap = eng.approveFromNativeUi(created.challengeId) as SosNativeTrustedConfirmation.ApproveResult.Ok
        val i2 = intent(params = mapOf("displayName" to "B")) // mutated
        val err = eng.consumeForSign(ap.authorization, i2)
        assertEquals("PAYLOAD_MUTATION", err)
    }

    @Test
    fun challengeReplayAndDoubleConsumeRejected() {
        val eng = engine()
        val i = intent()
        val created = eng.create(i) as SosNativeTrustedConfirmation.CreateResult.Ok
        val ap = eng.approveFromNativeUi(created.challengeId) as SosNativeTrustedConfirmation.ApproveResult.Ok
        assertEquals(null, eng.consumeForSign(ap.authorization, i))
        assertEquals("NO_PENDING", eng.consumeForSign(ap.authorization, i))
    }

    @Test
    fun expiryFailsClosed() {
        val eng = engine()
        val created = eng.create(intent()) as SosNativeTrustedConfirmation.CreateResult.Ok
        now += SosNativeTrustedConfirmation.DEFAULT_EXPIRY_MS + 1
        val ap = eng.approveFromNativeUi(created.challengeId)
        assertEquals("EXPIRED", (ap as SosNativeTrustedConfirmation.ApproveResult.Err).code)
    }

    @Test
    fun cancelDoesNotSignAndNotReusable() {
        val eng = engine()
        val created = eng.create(intent()) as SosNativeTrustedConfirmation.CreateResult.Ok
        assertTrue(eng.cancel(created.challengeId))
        val ap = eng.approveFromNativeUi(created.challengeId)
        assertTrue(ap is SosNativeTrustedConfirmation.ApproveResult.Err)
    }

    @Test
    fun logoutInvalidatesPending() {
        val eng = engine()
        eng.create(intent())
        eng.invalidateAll("logout")
        assertFalse(eng.hasActivePending())
    }

    @Test
    fun accountSwitchInvalidates() {
        val eng = engine()
        eng.create(intent())
        eng.invalidateAll("account_switch")
        assertFalse(eng.hasActivePending())
    }

    @Test
    fun sessionRevokeDuringConfirmBlocksApprove() {
        var revoked = false
        val eng = engine(sessionOk = { _, _ -> if (revoked) "SESSION_REVOKED" else null })
        val created = eng.create(intent()) as SosNativeTrustedConfirmation.CreateResult.Ok
        revoked = true
        val ap = eng.approveFromNativeUi(created.challengeId)
        assertEquals("SESSION_REVOKED", (ap as SosNativeTrustedConfirmation.ApproveResult.Err).code)
    }

    @Test
    fun concurrentSecondRequestRejected() {
        val eng = engine()
        eng.create(intent(requestId = "a"))
        now += SosNativeTrustedConfirmation.CREATE_COOLDOWN_MS + 1
        val r2 = eng.create(intent(requestId = "b"))
        assertEquals("CONFIRMATION_ALREADY_ACTIVE", (r2 as SosNativeTrustedConfirmation.CreateResult.Err).code)
    }

    @Test
    fun promptSpamBounded() {
        val eng = engine()
        // Fill rate window with rapid creates after cancelling each
        var limited = false
        repeat(20) { i ->
            now += SosNativeTrustedConfirmation.CREATE_COOLDOWN_MS + 1
            val r = eng.create(intent(requestId = "r$i"))
            when (r) {
                is SosNativeTrustedConfirmation.CreateResult.Ok -> eng.cancel(r.challengeId)
                is SosNativeTrustedConfirmation.CreateResult.Err -> {
                    if (r.code == "CONFIRMATION_RATE_LIMITED") limited = true
                }
            }
        }
        assertTrue(limited)
    }

    @Test
    fun activityRecreationDoesNotAutoApprove() {
        val eng = engine()
        eng.create(intent())
        eng.onActivityRecreation()
        assertFalse(eng.hasActivePending())
        assertFalse(SosNativeTrustedConfirmation.ACTIVITY_RECREATION_AUTO_APPROVES)
        assertFalse(SosNativeTrustedConfirmation.PROCESS_RESTART_RESTORES_APPROVED_CONFIRMATION)
    }

    @Test
    fun backgroundInvalidatesPending() {
        val eng = engine()
        eng.create(intent())
        eng.onBackground()
        assertFalse(eng.hasActivePending())
        assertFalse(SosNativeTrustedConfirmation.BACKGROUND_CONFIRMATION_AUTO_APPROVED)
    }

    @Test
    fun noWebViewApprovalSurface() {
        assertFalse(SosNativeTrustedConfirmation.WEBVIEW_CAN_CALL_APPROVE_METHOD)
        assertFalse(SosNativeTrustedConfirmation.WEBVIEW_CAN_SEND_APPROVAL_BOOLEAN)
        assertFalse(SosNativeTrustedConfirmation.APPROVAL_SECRET_EXPOSED_TO_WEBVIEW)
        assertFalse(SosNativeTrustedConfirmation.PROGRAMMATIC_AUTO_CONFIRM_SUPPORTED)
        assertFalse(SosNativeTrustedConfirmation.TRUSTED_CONFIRMATION_IS_WEBVIEW_HTML)
        assertFalse(SosNativeTrustedConfirmation.F6G_CLAIMS_XSS_ELIMINATED)
    }

    @Test
    fun humanReadableSummaryBuiltNatively() {
        val (title, body) = SosNativeTrustedConfirmation.buildHumanSummary(
            intent(op = SosNativeAdminPolicy.AdminOp.GRANT_CAPABILITY, params = mapOf(
                "targetPubkey" to "aa".repeat(32),
                "capability" to "MANAGE_MEMBERS",
            )),
        )
        assertTrue(title.contains("Grant", ignoreCase = true))
        assertTrue(body.contains(community))
        assertTrue(body.contains("MANAGE_MEMBERS"))
        assertTrue(SosNativeTrustedConfirmation.NATIVE_BUILDS_CONFIRMATION_SUMMARY)
        assertFalse(SosNativeTrustedConfirmation.WEBVIEW_CONTROLS_CONFIRMATION_SECURITY_TEXT)
    }

    @Test
    fun confirmStateBenchmark10k() {
        val eng = engine()
        // Warmup
        repeat(50) {
            now += SosNativeTrustedConfirmation.CREATE_COOLDOWN_MS + 1
            when (val r = eng.create(intent(requestId = "w$it"))) {
                is SosNativeTrustedConfirmation.CreateResult.Ok -> eng.cancel(r.challengeId)
                else -> { }
            }
        }
        val times = LongArray(10_000)
        for (i in 0 until 10_000) {
            now += SosNativeTrustedConfirmation.CREATE_COOLDOWN_MS + 1
            // Reset rate window artificially by advancing beyond 60s periodically
            if (i % 10 == 0) now += 61_000L
            times[i] = measureNanoTime {
                when (val r = eng.create(intent(requestId = "b$i"))) {
                    is SosNativeTrustedConfirmation.CreateResult.Ok -> {
                        eng.approveFromNativeUi(r.challengeId)
                        eng.cancel(r.challengeId) // if already approved, cancel no-op path
                        eng.invalidateAll("bench")
                    }
                    is SosNativeTrustedConfirmation.CreateResult.Err -> {
                        eng.invalidateAll("bench")
                    }
                }
            }
        }
        times.sort()
        fun pct(p: Double) = times[(p * (times.size - 1)).toInt()] / 1_000_000.0
        val p50 = pct(0.50)
        val p95 = pct(0.95)
        val p99 = pct(0.99)
        val total = times.sum() / 1_000_000.0
        println("CONFIRM_STATE_P50_MS=$p50")
        println("CONFIRM_STATE_P95_MS=$p95")
        println("CONFIRM_STATE_P99_MS=$p99")
        println("CONFIRM_STATE_10K_TOTAL_MS=$total")
        assertTrue("p99 too slow $p99", p99 < 50.0)
        assertTrue("10k too slow $total", total < 60_000.0)
    }

    @Test
    fun testUiPresenterApprovePath() {
        val ui = SosNativeTrustedConfirmation.TestUiPresenter()
        val eng = engine(ui = ui)
        val created = eng.create(intent()) as SosNativeTrustedConfirmation.CreateResult.Ok
        eng.presentUi(created.challengeId)
        assertEquals(1, ui.presentCount)
        assertNotNull(ui.lastPending)
        ui.clickApprove()
        val auth = eng.takeApprovedAuthorization()
        assertNotNull(auth)
    }
}
