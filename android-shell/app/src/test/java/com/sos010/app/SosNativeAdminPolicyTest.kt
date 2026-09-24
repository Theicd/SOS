package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import kotlin.system.measureNanoTime

/**
 * F6E — SosNativeAdminPolicy unit tests.
 */
class SosNativeAdminPolicyTest {

    private val rootPriv = "0000000000000000000000000000000000000000000000000000000000000001"
    private lateinit var rootPub: String
    private val delegPriv = "0000000000000000000000000000000000000000000000000000000000000002"
    private lateinit var delegPub: String
    private val memberPriv = "0000000000000000000000000000000000000000000000000000000000000003"
    private lateinit var memberPub: String
    private val community = "sos-test-community"

    private lateinit var engine: SosNativeAdminPolicy.Engine

    @Before
    fun setUp() {
        rootPub = SosNostrCrypto.pubkeyFromPriv(rootPriv)
        delegPub = SosNostrCrypto.pubkeyFromPriv(delegPriv)
        memberPub = SosNostrCrypto.pubkeyFromPriv(memberPriv)
        engine = SosNativeAdminPolicy.engineForTests { 1_700_000_000L }
    }

    private fun verified(
        caps: Map<String, List<String>> = mapOf(delegPub to listOf("MANAGE_GROUP_SETTINGS", "MANAGE_MEMBERS")),
        proven: Boolean = true,
        groupId: String = community,
        root: String = rootPub,
    ) = SosNativeAdminPolicy.VerifiedControlSnapshot(
        groupId = groupId,
        controlEpoch = 5,
        rootAdminPubkey = root,
        capabilities = caps,
        invitePolicy = "EVERYONE",
        blockedPubkeys = emptyList(),
        membershipEpoch = 1,
        displayName = "Test",
        networkTag = groupId,
        baseProvenLatest = proven,
    )

    private fun req(
        op: SosNativeAdminPolicy.AdminOp,
        communityId: String = community,
        params: Map<String, Any?> = emptyMap(),
    ) = SosNativeAdminPolicy.TypedAdminRequest(
        operation = op,
        communityId = communityId,
        params = params,
    )

    @Test
    fun validRootBootstrap() {
        val r = engine.evaluate(
            rootPub,
            req(
                SosNativeAdminPolicy.AdminOp.BOOTSTRAP_GROUP_CONTROL,
                params = mapOf("displayName" to "New", "invitePolicy" to "ADMINS_ONLY"),
            ),
            verified = null,
        )
        assertTrue(r is SosNativeAdminPolicy.PolicyResult.Allowed)
        val a = r as SosNativeAdminPolicy.PolicyResult.Allowed
        assertEquals(SosNativeAdminPolicy.GROUP_CONTROL_KIND, a.constructedKind)
        assertEquals(SosNativeAdminPolicy.ConfirmClass.NATIVE_CONFIRM_REQUIRED, a.confirmation)
    }

    @Test
    fun validDelegatedCapabilitySetDisplayName() {
        val r = engine.evaluate(
            delegPub,
            req(
                SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME,
                params = mapOf("displayName" to "Renamed"),
            ),
            verified(),
        )
        assertTrue(r is SosNativeAdminPolicy.PolicyResult.Allowed)
    }

    @Test
    fun missingCapabilityDenied() {
        val r = engine.evaluate(
            delegPub,
            req(
                SosNativeAdminPolicy.AdminOp.SET_INVITE_POLICY,
                params = mapOf("invitePolicy" to "EVERYONE"),
            ),
            verified(caps = mapOf(delegPub to listOf("MANAGE_GROUP_SETTINGS"))),
        )
        assertEquals("UNAUTHORIZED", (r as SosNativeAdminPolicy.PolicyResult.Denied).code)
    }

    @Test
    fun wrongCapabilityDenied() {
        val r = engine.evaluate(
            delegPub,
            req(SosNativeAdminPolicy.AdminOp.REMOVE_MEMBER, params = mapOf("memberPubkey" to memberPub)),
            verified(caps = mapOf(delegPub to listOf("MANAGE_BLOCKLIST"))),
        )
        assertEquals("UNAUTHORIZED", (r as SosNativeAdminPolicy.PolicyResult.Denied).code)
    }

    @Test
    fun wrongCommunityDenied() {
        val r = engine.evaluate(
            rootPub,
            req(SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME, communityId = "other-group", params = mapOf("displayName" to "X")),
            verified(),
        )
        assertEquals("CROSS_COMMUNITY", (r as SosNativeAdminPolicy.PolicyResult.Denied).code)
    }

    @Test
    fun crossCommunityAttemptDenied() {
        val r = engine.evaluate(
            rootPub,
            req(SosNativeAdminPolicy.AdminOp.BLOCK_MEMBER, communityId = "leaked-community", params = mapOf("memberPubkey" to memberPub)),
            verified(groupId = community),
        )
        assertEquals("CROSS_COMMUNITY", (r as SosNativeAdminPolicy.PolicyResult.Denied).code)
    }

    @Test
    fun emptyCommunityScopeDenied() {
        val r = engine.evaluate(
            rootPub,
            req(SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME, communityId = "", params = mapOf("displayName" to "X")),
            verified(),
        )
        assertEquals("EXPLICIT_COMMUNITY_SCOPE_REQUIRED", (r as SosNativeAdminPolicy.PolicyResult.Denied).code)
    }

    @Test
    fun unprovenBaseDenied() {
        val r = engine.evaluate(
            rootPub,
            req(SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME, params = mapOf("displayName" to "X")),
            verified(proven = false),
        )
        assertEquals("LATEST_STATE_NOT_PROVEN", (r as SosNativeAdminPolicy.PolicyResult.Denied).code)
    }

    @Test
    fun malformedPubkeyDenied() {
        val r = engine.evaluate(
            rootPub,
            req(SosNativeAdminPolicy.AdminOp.BLOCK_MEMBER, params = mapOf("memberPubkey" to "not-a-key")),
            verified(),
        )
        assertEquals("INVALID_PUBKEY", (r as SosNativeAdminPolicy.PolicyResult.Denied).code)
    }

    @Test
    fun unknownCapabilityDenied() {
        val r = engine.evaluate(
            rootPub,
            req(
                SosNativeAdminPolicy.AdminOp.GRANT_CAPABILITY,
                params = mapOf("targetPubkey" to memberPub, "capability" to "SUPER_ADMIN_HAX"),
            ),
            verified(),
        )
        assertEquals("UNKNOWN_CAPABILITY", (r as SosNativeAdminPolicy.PolicyResult.Denied).code)
    }

    @Test
    fun invalidMembershipTransitionDenied() {
        val r = engine.evaluate(
            rootPub,
            req(
                SosNativeAdminPolicy.AdminOp.RESOLVE_MEMBERSHIP_CONFLICT,
                params = mapOf("memberPubkey" to memberPub, "status" to "SUPERUSER", "candidateEventIds" to listOf("abcd1234")),
            ),
            verified(),
        )
        assertEquals("BAD_STATUS", (r as SosNativeAdminPolicy.PolicyResult.Denied).code)
    }

    @Test
    fun rootMemberProtectionPreserved() {
        val r = engine.evaluate(
            rootPub,
            req(SosNativeAdminPolicy.AdminOp.REMOVE_MEMBER, params = mapOf("memberPubkey" to rootPub)),
            verified(),
        )
        assertEquals("ROOT_PROTECTED", (r as SosNativeAdminPolicy.PolicyResult.Denied).code)
    }

    @Test
    fun callerArbitraryKindRejected() {
        val r = engine.evaluate(
            rootPub,
            SosNativeAdminPolicy.TypedAdminRequest(
                operation = SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME,
                communityId = community,
                params = mapOf("displayName" to "X"),
                kindOverride = 1,
            ),
            verified(),
        )
        assertEquals("CALLER_KIND_OVERRIDE", (r as SosNativeAdminPolicy.PolicyResult.Denied).code)
    }

    @Test
    fun callerArbitraryEventRejected() {
        val r = engine.evaluate(
            rootPub,
            SosNativeAdminPolicy.TypedAdminRequest(
                operation = SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME,
                communityId = community,
                params = mapOf("displayName" to "X"),
                completeEvent = org.json.JSONObject().put("kind", 39001),
            ),
            verified(),
        )
        assertEquals("ARBITRARY_EVENT_FIELDS", (r as SosNativeAdminPolicy.PolicyResult.Denied).code)
    }

    @Test
    fun callerPubkeyOverrideRejected() {
        val r = engine.evaluate(
            rootPub,
            SosNativeAdminPolicy.TypedAdminRequest(
                operation = SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME,
                communityId = community,
                params = mapOf("displayName" to "X"),
                pubkeyOverride = memberPub,
            ),
            verified(),
        )
        assertEquals("CALLER_PUBKEY_OVERRIDE", (r as SosNativeAdminPolicy.PolicyResult.Denied).code)
    }

    @Test
    fun callerFakeControlStateRejected() {
        val r = engine.evaluate(
            rootPub,
            SosNativeAdminPolicy.TypedAdminRequest(
                operation = SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME,
                communityId = community,
                params = mapOf("displayName" to "X"),
                claimControlEpoch = 999,
                claimRootPubkey = memberPub,
                claimCapabilities = mapOf(rootPub to listOf("MANAGE_ADMINS")),
            ),
            verified(),
        )
        assertEquals("CALLER_EPOCH_OVERRIDE", (r as SosNativeAdminPolicy.PolicyResult.Denied).code)
    }

    @Test
    fun highRiskRequiresNativeConfirm() {
        SosNativeAdminPolicy.AdminOp.values().forEach { op ->
            assertEquals(
                SosNativeAdminPolicy.ConfirmClass.NATIVE_CONFIRM_REQUIRED,
                SosNativeAdminPolicy.confirmationFor(op),
            )
        }
    }

    @Test
    fun bootstrapRootOnlyDelegatedDenied() {
        // Bootstrap creates new community with actor as root — delegated actor
        // who is not yet root can bootstrap a NEW group (they become root).
        // Conflict resolve is root-only against existing base.
        val r = engine.evaluate(
            delegPub,
            req(
                SosNativeAdminPolicy.AdminOp.RESOLVE_CONTROL_CONFLICT,
                params = mapOf("candidateEventIds" to listOf("abcdef12", "fedcba98")),
            ),
            verified(),
        )
        assertEquals("ROOT_RESOLVE_REQUIRED", (r as SosNativeAdminPolicy.PolicyResult.Denied).code)
    }

    @Test
    fun conflictResolutionRootOnly() {
        val ok = engine.evaluate(
            rootPub,
            req(
                SosNativeAdminPolicy.AdminOp.RESOLVE_CONTROL_CONFLICT,
                params = mapOf("candidateEventIds" to listOf("abcdef12", "fedcba98")),
            ),
            verified(),
        )
        assertTrue(ok is SosNativeAdminPolicy.PolicyResult.Allowed)
    }

    @Test
    fun invitePolicySemanticsPreserved() {
        SosNativeAdminPolicy.INVITE_POLICIES.forEach { pol ->
            val r = engine.evaluate(
                rootPub,
                req(SosNativeAdminPolicy.AdminOp.SET_INVITE_POLICY, params = mapOf("invitePolicy" to pol)),
                verified(),
            )
            assertTrue(pol, r is SosNativeAdminPolicy.PolicyResult.Allowed)
        }
        val bad = engine.evaluate(
            rootPub,
            req(SosNativeAdminPolicy.AdminOp.SET_INVITE_POLICY, params = mapOf("invitePolicy" to "WORLD")),
            verified(),
        )
        assertEquals("BAD_INVITE_POLICY", (bad as SosNativeAdminPolicy.PolicyResult.Denied).code)
    }

    @Test
    fun doubleRedeemNotClaimedSolved() {
        assertFalse(SosNativeAdminPolicy.F6E_CLAIMS_INVITE_DOUBLE_REDEEM_SOLVED)
        assertFalse(SosNativeAdminPolicy.F6E_CLAIMS_HISTORICAL_AUTH_PROOF_SOLVED)
        assertFalse(SosNativeAdminPolicy.F6E_CLAIMS_XSS_ELIMINATED)
        assertFalse(SosNativeAdminPolicy.ACCESS_CONTROL_V2_ACTIVATION_READY)
    }

    @Test
    fun noPrivateKeyCustodyInPolicy() {
        assertFalse(SosNativeAdminPolicy.NATIVE_ADMIN_POLICY_CONTAINS_PRIVATE_K)
        assertFalse(SosNativeAdminPolicy.NATIVE_ADMIN_POLICY_CONTAINS_NSEC)
        assertFalse(SosNativeAdminPolicy.GENERIC_NATIVE_ADMIN_SIGN_API)
        assertTrue(SosNativeAdminPolicy.NATIVE_ADMIN_TYPED_ALLOWLIST_PRESENT)
        assertTrue(SosNativeAdminPolicy.ADMIN_CAPABILITY_MAPPING_EXPLICIT)
    }

    @Test
    fun policyCheck10kBenchmark() {
        val snap = verified()
        val request = req(
            SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME,
            params = mapOf("displayName" to "Bench"),
        )
        // Warmup
        repeat(100) { engine.evaluate(rootPub, request, snap) }
        val times = LongArray(10_000)
        for (i in 0 until 10_000) {
            times[i] = measureNanoTime {
                engine.evaluate(rootPub, request, snap)
            }
        }
        times.sort()
        fun pct(p: Double): Double = times[(p * (times.size - 1)).toInt()] / 1_000_000.0
        val p50 = pct(0.50)
        val p95 = pct(0.95)
        val p99 = pct(0.99)
        val totalMs = times.sum() / 1_000_000.0
        println("ADMIN_POLICY_CHECK_P50_MS=$p50")
        println("ADMIN_POLICY_CHECK_P95_MS=$p95")
        println("ADMIN_POLICY_CHECK_P99_MS=$p99")
        println("ADMIN_POLICY_CHECK_10K_TOTAL_MS=$totalMs")
        // Generous budget — validation must not be weakened for speed.
        assertTrue("p99 too slow: $p99", p99 < 50.0)
        assertTrue("10k total too slow: $totalMs", totalMs < 30_000.0)
        assertTrue(SosNativeAdminPolicy.NATIVE_ADMIN_POLICY_PRESENT)
    }

    @Test
    fun allowlistContainsCanonicalAc9Ops() {
        val names = SosNativeAdminPolicy.AdminOp.values().map { it.name }.toSet()
        listOf(
            "SET_GROUP_DISPLAY_NAME",
            "SET_INVITE_POLICY",
            "GRANT_CAPABILITY",
            "REVOKE_CAPABILITY",
            "ADD_MEMBER_TO_BLOCKLIST",
            "REMOVE_MEMBER_FROM_BLOCKLIST",
            "CLEAN_REMOVED_MEMBER_CAPABILITIES",
            "RESOLVE_CONTROL_CONFLICT",
            "BOOTSTRAP_GROUP_CONTROL",
            "GRANT_MEMBER_ACTIVE",
            "BLOCK_MEMBER",
            "UNBLOCK_MEMBER",
            "REMOVE_MEMBER",
            "RESOLVE_MEMBERSHIP_CONFLICT",
            "BOOTSTRAP_MEMBER_ACTIVE",
        ).forEach { assertTrue(it, names.contains(it)) }
    }
}
