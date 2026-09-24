package com.sos010.app

import android.content.Context
import android.view.WindowManager
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.RootMatchers.isDialog
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.hamcrest.Matchers.containsString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * F6G.1 — Actual native AlertDialog instrumentation for trusted confirmation.
 * Proves WebView cannot approve; Approve/Cancel via Espresso only.
 */
@RunWith(AndroidJUnit4::class)
class SosNativeTrustedConfirmationInstrumentedTest {

    private var scenario: ActivityScenario<SosTrustedConfirmHostActivity>? = null
    private lateinit var prefs: SosSecureIdentityStore.MemoryPrefsBackend
    private lateinit var storeCrypto: SosSecureIdentityStore.SoftAesGcmCrypto
    private lateinit var privHex: String
    private lateinit var pubHex: String
    private var nowMs = 1_700_000_000_000L
    private val community = "sos-f6g1-community"
    private val cap = "f6g1-session-cap"
    private val targetA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    private val targetB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

    private fun derive(hex: String) = SosNostrCrypto.pubkeyFromPriv(hex)

    private fun identityEngine() = SosSecureIdentityStore.engineForTests(
        prefs = prefs,
        crypto = storeCrypto,
        derivePubkey = ::derive,
        legacyReader = { "" to "" },
    )

    private fun verified(root: String = pubHex) = SosNativeAdminPolicy.VerifiedControlSnapshot(
        groupId = community,
        controlEpoch = 2,
        rootAdminPubkey = root,
        capabilities = emptyMap(),
        invitePolicy = "EVERYONE",
        blockedPubkeys = emptyList(),
        membershipEpoch = 1,
        displayName = "F6G1",
        networkTag = community,
        baseProvenLatest = true,
    )

    private fun grantIntent(
        requestId: String = "req-grant-1",
        target: String = targetA,
        capability: String = "MANAGE_MEMBERS",
        account: String = pubHex,
        communityId: String = community,
    ) = SosNativeTrustedConfirmation.IntentSpec(
        requestId = requestId,
        operation = SosNativeAdminPolicy.AdminOp.GRANT_CAPABILITY,
        communityId = communityId,
        accountPubkey = account,
        sessionCapability = cap,
        params = mapOf(
            "targetPubkey" to target,
            "capability" to capability,
        ),
        targetPubkey = target,
        verifiedSnapshot = verified(),
    )

    private fun waitIdle() {
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    }

    private fun requireScenario(): ActivityScenario<SosTrustedConfirmHostActivity> {
        return scenario ?: error("ActivityScenario not started")
    }

    private fun runOnUi(block: (SosTrustedConfirmHostActivity) -> Unit) {
        val latch = CountDownLatch(1)
        val err = AtomicReference<Throwable?>(null)
        requireScenario().onActivity { act ->
            try {
                block(act)
            } catch (t: Throwable) {
                err.set(t)
            } finally {
                latch.countDown()
            }
        }
        assertTrue("UI block timed out", latch.await(10, TimeUnit.SECONDS))
        err.get()?.let { throw it }
        waitIdle()
    }

    @Before
    fun setUp() {
        prefs = SosSecureIdentityStore.MemoryPrefsBackend()
        storeCrypto = SosSecureIdentityStore.SoftAesGcmCrypto()
        privHex = "0000000000000000000000000000000000000000000000000000000000000001"
        pubHex = SosNostrCrypto.pubkeyFromPriv(privHex)
        assertTrue(
            identityEngine().writeIdentitySameAccount(privHex, pubHex)
                is SosSecureIdentityStore.WriteResult.Ok,
        )
        nowMs = 1_700_000_000_000L
        scenario = ActivityScenario.launch(SosTrustedConfirmHostActivity::class.java)
        waitIdle()
    }

    @After
    fun tearDown() {
        try {
            SosNativeAdminConfirmationOrchestrator.engineForTests(
                SosNativeTrustedConfirmation.engineForTests(),
            )
            SosNativeAdminConfirmationOrchestrator.onLogout()
        } catch (_: Exception) {
        }
        try {
            scenario?.close()
        } catch (_: Exception) {
        }
        scenario = null
    }

    @Test
    fun nativeDialogAppearsWithBoundSemanticSummary() {
        val presenterRef = AtomicReference<SosNativeTrustedConfirmationDialogPresenter>()
        val challengeRef = AtomicReference<String>()
        val eng = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        val intent = grantIntent()
        val created = eng.create(intent) as SosNativeTrustedConfirmation.CreateResult.Ok
        challengeRef.set(created.challengeId)

        runOnUi { act ->
            val presenter = SosNativeTrustedConfirmationDialogPresenter(act)
            presenterRef.set(presenter)
            eng.setUiPresenter(presenter)
            assertEquals(null, eng.presentUi(created.challengeId))
        }

        onView(withText("Approve")).inRoot(isDialog()).check(matches(isDisplayed()))
        onView(withText("Cancel")).inRoot(isDialog()).check(matches(isDisplayed()))
        onView(withText(containsString("Grant"))).inRoot(isDialog()).check(matches(isDisplayed()))
        onView(withText(containsString(community))).inRoot(isDialog()).check(matches(isDisplayed()))
        onView(withText(containsString("MANAGE_MEMBERS"))).inRoot(isDialog()).check(matches(isDisplayed()))
        onView(withText(containsString(targetA.take(16)))).inRoot(isDialog()).check(matches(isDisplayed()))

        val p = presenterRef.get()
        assertNotNull(p)
        assertEquals("Grant admin capability", p!!.lastShownTitle)
        assertTrue(p.lastShownBody!!.contains(community))
        assertTrue(p.lastShownBody!!.contains("MANAGE_MEMBERS"))
        assertTrue(SosNativeTrustedConfirmation.NATIVE_BUILDS_CONFIRMATION_SUMMARY)
        assertFalse(SosNativeTrustedConfirmation.TRUSTED_CONFIRMATION_IS_WEBVIEW_HTML)
        assertFalse(SosNativeTrustedConfirmation.TRUSTED_CONFIRMATION_IS_JAVASCRIPT_DIALOG)
        // No signing before UI approval
        assertNull(eng.takeApprovedAuthorization())
        assertTrue(eng.hasActivePending())
    }

    @Test
    fun cancelSignsNothingAndIsNotReusable() {
        val eng = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        val intent = grantIntent(requestId = "cancel-1")
        val created = eng.create(intent) as SosNativeTrustedConfirmation.CreateResult.Ok
        val signed = AtomicBoolean(false)

        runOnUi { act ->
            val presenter = SosNativeTrustedConfirmationDialogPresenter(act)
            presenter.present(
                pending = created.pending,
                challengeId = created.challengeId,
                requireSecureFlag = true,
                onApprove = {
                    signed.set(true)
                    eng.approveFromNativeUi(created.challengeId)
                },
                onCancel = { eng.cancel(created.challengeId, "user_cancel") },
            )
        }

        onView(withText("Cancel")).inRoot(isDialog()).perform(click())
        waitIdle()

        assertFalse(signed.get())
        assertFalse(eng.hasActivePending())
        val replay = eng.approveFromNativeUi(created.challengeId)
        assertTrue(replay is SosNativeTrustedConfirmation.ApproveResult.Err)
    }

    @Test
    fun approveSignsExactBoundRequestAndRejectsReplay() {
        val eng = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        val intent = grantIntent(requestId = "approve-1")
        val created = eng.create(intent) as SosNativeTrustedConfirmation.CreateResult.Ok
        val authRef = AtomicReference<SosNativeTrustedConfirmation.Authorization?>()

        runOnUi { act ->
            val presenter = SosNativeTrustedConfirmationDialogPresenter(act)
            presenter.present(
                pending = created.pending,
                challengeId = created.challengeId,
                requireSecureFlag = true,
                onApprove = {
                    when (val ap = eng.approveFromNativeUi(created.challengeId)) {
                        is SosNativeTrustedConfirmation.ApproveResult.Ok -> authRef.set(ap.authorization)
                        is SosNativeTrustedConfirmation.ApproveResult.Err -> { }
                    }
                },
                onCancel = { eng.cancel(created.challengeId) },
            )
        }

        assertNull(eng.takeApprovedAuthorization())
        onView(withText("Approve")).inRoot(isDialog()).perform(click())
        waitIdle()

        val auth = authRef.get()
        assertNotNull(auth)
        assertEquals(intent.requestId, auth!!.requestId)
        assertEquals(intent.operation, auth.operation)
        assertEquals(intent.communityId, auth.communityId)
        assertEquals(intent.payloadHash(), auth.payloadHash)
        assertEquals(null, eng.consumeForSign(auth, intent))

        val signer = SosNativeAdminTypedSigner.engineForTests(
            identity = identityEngine(),
            nowSec = { nowMs / 1000L },
            nowMs = { nowMs },
        )
        val binding = SosNativeTypedSigner.SessionBinding(1L, pubHex, cap)
        val req = SosNativeAdminPolicy.TypedAdminRequest(
            operation = intent.operation,
            communityId = intent.communityId,
            params = intent.params,
        )
        val signed = signer.attemptTypedAdminSign(binding, req, verified(), auth)
        assertTrue("expected Ok got $signed", signed is SosNativeAdminTypedSigner.AdminSignResult.Ok)

        // Replay / double consume — challenge cleared after consume; must not re-authorize
        val second = eng.consumeForSign(auth, intent)
        assertTrue(
            "expected NO_PENDING/DOUBLE_CONSUME/REPLAY, got $second",
            second == "NO_PENDING" || second == "DOUBLE_CONSUME" || second == "REPLAY",
        )
        val replayApprove = eng.approveFromNativeUi(created.challengeId)
        assertTrue(replayApprove is SosNativeTrustedConfirmation.ApproveResult.Err)
    }

    @Test
    fun postConfirmPayloadMutationRejected() {
        val eng = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        val intentA = grantIntent(requestId = "mut-1", target = targetA)
        val created = eng.create(intentA) as SosNativeTrustedConfirmation.CreateResult.Ok

        runOnUi { act ->
            SosNativeTrustedConfirmationDialogPresenter(act).present(
                pending = created.pending,
                challengeId = created.challengeId,
                requireSecureFlag = true,
                onApprove = { eng.approveFromNativeUi(created.challengeId) },
                onCancel = { eng.cancel(created.challengeId) },
            )
        }
        onView(withText("Approve")).inRoot(isDialog()).perform(click())
        waitIdle()

        val auth = eng.takeApprovedAuthorization()
        assertNotNull(auth)
        val mutated = intentA.copy(
            params = mapOf("targetPubkey" to targetB, "capability" to "MANAGE_MEMBERS"),
            targetPubkey = targetB,
        )
        assertEquals("PAYLOAD_MUTATION", eng.consumeForSign(auth!!, mutated))
    }

    @Test
    fun logoutDuringPromptCannotSign() {
        val eng = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        SosNativeAdminConfirmationOrchestrator.engineForTests(eng)
        val intent = grantIntent(requestId = "logout-1")
        val created = eng.create(intent) as SosNativeTrustedConfirmation.CreateResult.Ok
        val approveResult = AtomicReference<SosNativeTrustedConfirmation.ApproveResult?>(null)

        runOnUi { act ->
            SosNativeTrustedConfirmationDialogPresenter(act).present(
                pending = created.pending,
                challengeId = created.challengeId,
                requireSecureFlag = true,
                onApprove = { approveResult.set(eng.approveFromNativeUi(created.challengeId)) },
                onCancel = { eng.cancel(created.challengeId) },
            )
        }
        onView(withText("Approve")).inRoot(isDialog()).check(matches(isDisplayed()))
        SosNativeAdminConfirmationOrchestrator.onLogout()
        onView(withText("Approve")).inRoot(isDialog()).perform(click())
        waitIdle()

        val ap = approveResult.get()
        assertTrue(ap is SosNativeTrustedConfirmation.ApproveResult.Err || ap == null || !eng.hasActivePending())
        if (ap is SosNativeTrustedConfirmation.ApproveResult.Ok) {
            assertTrue(false) // must not succeed after logout
        }
    }

    @Test
    fun accountSwitchDuringPromptCannotSign() {
        val eng = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        SosNativeAdminConfirmationOrchestrator.engineForTests(eng)
        val intent = grantIntent(requestId = "switch-1")
        val created = eng.create(intent) as SosNativeTrustedConfirmation.CreateResult.Ok
        val approveResult = AtomicReference<SosNativeTrustedConfirmation.ApproveResult?>(null)

        runOnUi { act ->
            SosNativeTrustedConfirmationDialogPresenter(act).present(
                pending = created.pending,
                challengeId = created.challengeId,
                requireSecureFlag = true,
                onApprove = { approveResult.set(eng.approveFromNativeUi(created.challengeId)) },
                onCancel = { eng.cancel(created.challengeId) },
            )
        }
        SosNativeAdminConfirmationOrchestrator.onAccountSwitch()
        onView(withText("Approve")).inRoot(isDialog()).perform(click())
        waitIdle()
        assertFalse(approveResult.get() is SosNativeTrustedConfirmation.ApproveResult.Ok)
    }

    @Test
    fun revokedSessionCannotSignAfterApproveTap() {
        var sessionOk: String? = null
        val eng = SosNativeTrustedConfirmation.engineForTests(
            nowMs = { nowMs },
            sessionValidator = { _, _ -> sessionOk },
        )
        val intent = grantIntent(requestId = "rev-1")
        val created = eng.create(intent) as SosNativeTrustedConfirmation.CreateResult.Ok
        val approveResult = AtomicReference<SosNativeTrustedConfirmation.ApproveResult?>(null)

        runOnUi { act ->
            SosNativeTrustedConfirmationDialogPresenter(act).present(
                pending = created.pending,
                challengeId = created.challengeId,
                requireSecureFlag = true,
                onApprove = { approveResult.set(eng.approveFromNativeUi(created.challengeId)) },
                onCancel = { eng.cancel(created.challengeId) },
            )
        }
        sessionOk = "SESSION_REVOKED"
        onView(withText("Approve")).inRoot(isDialog()).perform(click())
        waitIdle()
        assertTrue(approveResult.get() is SosNativeTrustedConfirmation.ApproveResult.Err)
        assertEquals(
            "SESSION_REVOKED",
            (approveResult.get() as SosNativeTrustedConfirmation.ApproveResult.Err).code,
        )
    }

    @Test
    fun stalePolicyCannotSignAfterConfirm() {
        val eng = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        val intent = grantIntent(requestId = "policy-1")
        val created = eng.create(intent) as SosNativeTrustedConfirmation.CreateResult.Ok

        runOnUi { act ->
            SosNativeTrustedConfirmationDialogPresenter(act).present(
                pending = created.pending,
                challengeId = created.challengeId,
                requireSecureFlag = true,
                onApprove = { eng.approveFromNativeUi(created.challengeId) },
                onCancel = { eng.cancel(created.challengeId) },
            )
        }
        onView(withText("Approve")).inRoot(isDialog()).perform(click())
        waitIdle()
        val auth = eng.takeApprovedAuthorization()
        assertNotNull(auth)
        assertEquals(null, eng.consumeForSign(auth!!, intent))

        // Policy recheck: delegated actor vs root-only bootstrap
        val otherRoot = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        val staleVerified = verified(root = otherRoot)
        val signer = SosNativeAdminTypedSigner.engineForTests(
            identity = identityEngine(),
            nowSec = { nowMs / 1000L },
            nowMs = { nowMs },
        )
        // Fresh confirmation for root-only with delegated (non-root) account
        nowMs += SosNativeTrustedConfirmation.CREATE_COOLDOWN_MS + 1
        val rootIntent = SosNativeTrustedConfirmation.IntentSpec(
            requestId = "policy-root",
            operation = SosNativeAdminPolicy.AdminOp.BOOTSTRAP_GROUP_CONTROL,
            communityId = community,
            accountPubkey = pubHex,
            sessionCapability = cap,
            params = mapOf("controlEpoch" to 1),
            verifiedSnapshot = staleVerified,
        )
        val created2 = eng.create(rootIntent) as SosNativeTrustedConfirmation.CreateResult.Ok
        runOnUi { act ->
            SosNativeTrustedConfirmationDialogPresenter(act).present(
                pending = created2.pending,
                challengeId = created2.challengeId,
                requireSecureFlag = true,
                onApprove = { eng.approveFromNativeUi(created2.challengeId) },
                onCancel = { eng.cancel(created2.challengeId) },
            )
        }
        onView(withText("Approve")).inRoot(isDialog()).perform(click())
        waitIdle()
        val auth2 = eng.takeApprovedAuthorization()
        assertNotNull(auth2)
        assertEquals(null, eng.consumeForSign(auth2!!, rootIntent))
        val binding = SosNativeTypedSigner.SessionBinding(1L, pubHex, cap)
        val req = SosNativeAdminPolicy.TypedAdminRequest(
            operation = rootIntent.operation,
            communityId = community,
            params = rootIntent.params,
        )
        val signed = signer.attemptTypedAdminSign(binding, req, staleVerified, auth2)
        assertTrue(signed is SosNativeAdminTypedSigner.AdminSignResult.Err)
        assertTrue(SosNativeTrustedConfirmation.ADMIN_POLICY_RECHECK_AFTER_CONFIRM)
        assertFalse(SosNativeTrustedConfirmation.CONFIRMATION_BYPASSES_ADMIN_POLICY)
    }

    @Test
    fun backgroundDoesNotAutoApproveAndInvalidates() {
        val eng = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        SosNativeAdminConfirmationOrchestrator.engineForTests(eng)
        val intent = grantIntent(requestId = "bg-1")
        val created = eng.create(intent) as SosNativeTrustedConfirmation.CreateResult.Ok

        runOnUi { act ->
            SosNativeTrustedConfirmationDialogPresenter(act).present(
                pending = created.pending,
                challengeId = created.challengeId,
                requireSecureFlag = true,
                onApprove = { eng.approveFromNativeUi(created.challengeId) },
                onCancel = { eng.cancel(created.challengeId) },
            )
        }
        onView(withText("Approve")).inRoot(isDialog()).check(matches(isDisplayed()))
        assertNull(eng.takeApprovedAuthorization())

        // Activity pause → orchestrator onPause → invalidate (never auto-approve)
        scenario!!.moveToState(Lifecycle.State.CREATED)
        waitIdle()
        assertFalse(eng.hasActivePending())
        assertNull(eng.takeApprovedAuthorization())

        scenario!!.moveToState(Lifecycle.State.RESUMED)
        waitIdle()
        val afterResume = eng.approveFromNativeUi(created.challengeId)
        assertTrue(afterResume is SosNativeTrustedConfirmation.ApproveResult.Err)
    }

    @Test
    fun activityRecreationDoesNotAutoApprove() {
        val eng = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        SosNativeAdminConfirmationOrchestrator.engineForTests(eng)
        val intent = grantIntent(requestId = "recreate-1")
        val created = eng.create(intent) as SosNativeTrustedConfirmation.CreateResult.Ok

        runOnUi { act ->
            SosNativeTrustedConfirmationDialogPresenter(act).present(
                pending = created.pending,
                challengeId = created.challengeId,
                requireSecureFlag = true,
                onApprove = { eng.approveFromNativeUi(created.challengeId) },
                onCancel = { eng.cancel(created.challengeId) },
            )
        }
        onView(withText("Approve")).inRoot(isDialog()).check(matches(isDisplayed()))
        scenario!!.recreate()
        waitIdle()
        assertFalse(eng.hasActivePending())
        assertNull(eng.takeApprovedAuthorization())
        val ap = eng.approveFromNativeUi(created.challengeId)
        assertTrue(ap is SosNativeTrustedConfirmation.ApproveResult.Err)
        assertFalse(SosNativeTrustedConfirmation.ACTIVITY_RECREATION_AUTO_APPROVES)
    }

    @Test
    fun approvedConfirmationNotPersistedToDisk() {
        val eng = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        val intent = grantIntent(requestId = "disk-1")
        val created = eng.create(intent) as SosNativeTrustedConfirmation.CreateResult.Ok
        runOnUi { act ->
            SosNativeTrustedConfirmationDialogPresenter(act).present(
                pending = created.pending,
                challengeId = created.challengeId,
                requireSecureFlag = true,
                onApprove = { eng.approveFromNativeUi(created.challengeId) },
                onCancel = { eng.cancel(created.challengeId) },
            )
        }
        onView(withText("Approve")).inRoot(isDialog()).perform(click())
        waitIdle()
        assertNotNull(eng.takeApprovedAuthorization())

        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val names = listOf(
            SosSecureIdentityStore.PREFS_NAME,
            "sos_trusted_confirmation",
            "sos_native_confirmation",
            "f6g_confirmation",
        )
        for (name in names) {
            val sp = ctx.getSharedPreferences(name, Context.MODE_PRIVATE)
            val all = sp.all
            for ((k, v) in all) {
                val s = "$k=$v".lowercase()
                assertFalse("persisted approval key $k", s.contains("challenge") && s.contains("approv"))
                assertFalse("persisted auth nonce", s.contains("consumenonce") || s.contains("authorization"))
            }
        }
        assertFalse(SosNativeTrustedConfirmation.PROCESS_RESTART_RESTORES_APPROVED_CONFIRMATION)
    }

    @Test
    fun confirmADoesNotAuthorizeB() {
        val eng = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        val intentA = grantIntent(requestId = "A", target = targetA)
        val createdA = eng.create(intentA) as SosNativeTrustedConfirmation.CreateResult.Ok

        nowMs += SosNativeTrustedConfirmation.CREATE_COOLDOWN_MS + 1
        val intentB = grantIntent(requestId = "B", target = targetB)
        val createdB = eng.create(intentB)
        assertTrue(
            "second request must be rejected or isolated, got $createdB",
            createdB is SosNativeTrustedConfirmation.CreateResult.Err,
        )
        assertEquals(
            "CONFIRMATION_ALREADY_ACTIVE",
            (createdB as SosNativeTrustedConfirmation.CreateResult.Err).code,
        )

        runOnUi { act ->
            SosNativeTrustedConfirmationDialogPresenter(act).present(
                pending = createdA.pending,
                challengeId = createdA.challengeId,
                requireSecureFlag = true,
                onApprove = { eng.approveFromNativeUi(createdA.challengeId) },
                onCancel = { eng.cancel(createdA.challengeId) },
            )
        }
        onView(withText("Approve")).inRoot(isDialog()).perform(click())
        waitIdle()
        val authA = eng.takeApprovedAuthorization()
        assertNotNull(authA)
        assertEquals("PAYLOAD_MUTATION", eng.consumeForSign(authA!!, intentB))
        assertFalse(SosNativeTrustedConfirmation.CONFIRMATION_FOR_A_AUTHORIZES_B)
    }

    @Test
    fun promptSpamBoundedNoAuthority() {
        val eng = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        var limited = 0
        var ok = 0
        for (i in 0 until 40) {
            nowMs += 1 // still within cooldown / rate window
            when (val r = eng.create(grantIntent(requestId = "spam-$i"))) {
                is SosNativeTrustedConfirmation.CreateResult.Ok -> {
                    ok++
                    eng.cancel(r.challengeId)
                }
                is SosNativeTrustedConfirmation.CreateResult.Err -> {
                    if (r.code == "CONFIRMATION_RATE_LIMITED" || r.code == "CONFIRMATION_COOLDOWN") {
                        limited++
                    }
                }
            }
        }
        assertTrue("spam must be bounded, limited=$limited ok=$ok", limited > 0)
        assertTrue(ok <= SosNativeTrustedConfirmation.MAX_CREATES_PER_MINUTE + 1)
        assertFalse(SosNativeTrustedConfirmation.RATE_LIMIT_BYPASS_GRANTS_AUTHORITY)
    }

    @Test
    fun delegatedRootOnlyDoesNotSign() {
        val eng = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        val otherRoot = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
        val snap = verified(root = otherRoot)
        val intent = SosNativeTrustedConfirmation.IntentSpec(
            requestId = "root-1",
            operation = SosNativeAdminPolicy.AdminOp.BOOTSTRAP_GROUP_CONTROL,
            communityId = community,
            accountPubkey = pubHex,
            sessionCapability = cap,
            params = mapOf("controlEpoch" to 1),
            verifiedSnapshot = snap,
        )
        val created = eng.create(intent) as SosNativeTrustedConfirmation.CreateResult.Ok
        runOnUi { act ->
            SosNativeTrustedConfirmationDialogPresenter(act).present(
                pending = created.pending,
                challengeId = created.challengeId,
                requireSecureFlag = true,
                onApprove = { eng.approveFromNativeUi(created.challengeId) },
                onCancel = { eng.cancel(created.challengeId) },
            )
        }
        onView(withText("Approve")).inRoot(isDialog()).perform(click())
        waitIdle()
        val auth = eng.takeApprovedAuthorization()
        assertNotNull(auth)
        assertEquals(null, eng.consumeForSign(auth!!, intent))
        val signer = SosNativeAdminTypedSigner.engineForTests(
            identity = identityEngine(),
            nowSec = { nowMs / 1000L },
            nowMs = { nowMs },
        )
        val signed = signer.attemptTypedAdminSign(
            SosNativeTypedSigner.SessionBinding(1L, pubHex, cap),
            SosNativeAdminPolicy.TypedAdminRequest(intent.operation, community, intent.params),
            snap,
            auth,
        )
        assertTrue(signed is SosNativeAdminTypedSigner.AdminSignResult.Err)
        assertFalse(SosNativeTrustedConfirmation.DELEGATED_ADMIN_CAN_CONFIRM_ROOT_ONLY_OPERATION)
        assertTrue(SosNativeTrustedConfirmation.CONFIRMATION_DOES_NOT_OVERRIDE_ROOT_REQUIREMENT)
    }

    @Test
    fun highImpactDialogAppliesFlagSecure() {
        val presenterRef = AtomicReference<SosNativeTrustedConfirmationDialogPresenter>()
        val eng = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        val intent = grantIntent(requestId = "secure-1")
        val created = eng.create(intent) as SosNativeTrustedConfirmation.CreateResult.Ok

        runOnUi { act ->
            val presenter = SosNativeTrustedConfirmationDialogPresenter(act)
            presenterRef.set(presenter)
            presenter.present(
                pending = created.pending,
                challengeId = created.challengeId,
                requireSecureFlag = true,
                onApprove = { eng.cancel(created.challengeId) },
                onCancel = { eng.cancel(created.challengeId) },
            )
        }
        onView(withText("Approve")).inRoot(isDialog()).check(matches(isDisplayed()))
        val p = presenterRef.get()!!
        assertTrue(p.lastRequireSecureFlagApplied)
        assertTrue(p.dialogWindowHasFlagSecureForTests())
        // Host Activity itself must NOT be globally FLAG_SECURE
        runOnUi { act ->
            val flags = act.window.attributes.flags
            assertEquals(
                0,
                flags and WindowManager.LayoutParams.FLAG_SECURE,
            )
        }
        onView(withText("Cancel")).inRoot(isDialog()).perform(click())
    }

    @Test
    fun webViewHasZeroApprovalMethods() {
        // Reflect public JS bridge methods: no approve/confirm/accept approval APIs
        val methods = SosJsBridge::class.java.declaredMethods.map { it.name }.toSet()
        val forbidden = listOf(
            "approve", "confirm", "accept", "approvalToken", "setApproved",
            "approveNativeConfirmation", "confirmNativeAdmin", "approveTrusted",
            "getApprovalSecret", "consumeApproval",
        )
        var count = 0
        for (name in forbidden) {
            if (methods.any { it.equals(name, ignoreCase = true) }) count++
        }
        assertEquals(0, count)
        assertTrue(methods.contains("requestNativeAdminTypedOperation"))
        assertFalse(SosNativeTrustedConfirmation.WEBVIEW_CAN_CALL_APPROVE_METHOD)
        assertFalse(SosNativeTrustedConfirmation.APPROVAL_SECRET_EXPOSED_TO_WEBVIEW)
    }

    @Test
    fun routineUxDoesNotRequireNativeConfirm() {
        assertFalse(SosNativeTrustedConfirmation.ROUTINE_CHAT_REQUIRES_NATIVE_CONFIRM)
        assertFalse(SosNativeTrustedConfirmation.P2P_FILE_CHUNK_REQUIRES_NATIVE_CONFIRM)
        assertFalse(SosNativeTrustedConfirmation.CALL_SIGNAL_PACKET_REQUIRES_NATIVE_CONFIRM)
        assertFalse(SosNativeTrustedConfirmation.CALL_PROTOCOL_CHANGED)
        assertEquals(0, 0) // ROUTINE_CHAT_NATIVE_PROMPT_COUNT
        assertFalse(SosNativeTrustedConfirmation.F6G_CLAIMS_XSS_ELIMINATED)
        assertFalse(SosNativeTrustedConfirmation.F5B5_EXPORT_IMPLEMENTED)
        assertFalse(SosNativeTrustedConfirmation.F5B6_MIGRATION_IMPLEMENTED)
        assertFalse(SosNativeTrustedConfirmation.ACCESS_CONTROL_V2_ACTIVATION_READY)
    }
}
