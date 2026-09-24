package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * F6E — SosNativeAdminTypedSigner unit tests (session + confirm fail-closed).
 */
class SosNativeAdminSignerTest {
    companion object {
        init {
            val dll = java.io.File("build/native/secp256k1-jni.dll")
            if (dll.exists()) System.load(dll.absolutePath)
        }
    }

    private lateinit var prefs: SosSecureIdentityStore.MemoryPrefsBackend
    private lateinit var storeCrypto: SosSecureIdentityStore.SoftAesGcmCrypto
    private lateinit var privHex: String
    private lateinit var pubHex: String
    private val now = 1_700_000_000L
    private val community = "sos-admin-test"

    private fun derive(hex: String): String = SosNostrCrypto.pubkeyFromPriv(hex)

    private fun identityEngine(): SosSecureIdentityStore.Engine =
        SosSecureIdentityStore.engineForTests(
            prefs = prefs,
            crypto = storeCrypto,
            derivePubkey = ::derive,
            legacyReader = { "" to "" },
        )

    private fun binding(
        gen: Long = 1L,
        account: String = pubHex,
        cap: String = "test-cap",
    ) = SosNativeTypedSigner.SessionBinding(
        sessionGeneration = gen,
        accountPubkey = account,
        sessionCapability = cap,
    )

    private fun verified(
        proven: Boolean = true,
        caps: Map<String, List<String>> = emptyMap(),
    ) = SosNativeAdminPolicy.VerifiedControlSnapshot(
        groupId = community,
        controlEpoch = 3,
        rootAdminPubkey = pubHex,
        capabilities = caps,
        invitePolicy = "EVERYONE",
        blockedPubkeys = emptyList(),
        membershipEpoch = 1,
        displayName = "AdminTest",
        networkTag = community,
        baseProvenLatest = proven,
    )

    private fun adminSigner(
        gate: SosNativeTypedSigner.SessionAuthorityGate = SosNativeTypedSigner.TestPermissiveSessionGate,
    ): SosNativeAdminTypedSigner.Engine =
        SosNativeAdminTypedSigner.engineForTests(
            identity = identityEngine(),
            sessionGate = gate,
            nowSec = { now },
        )

    @Before
    fun setUp() {
        prefs = SosSecureIdentityStore.MemoryPrefsBackend()
        storeCrypto = SosSecureIdentityStore.SoftAesGcmCrypto()
        privHex = "0000000000000000000000000000000000000000000000000000000000000001"
        pubHex = SosNostrCrypto.pubkeyFromPriv(privHex)
        val sealed = identityEngine().writeIdentitySameAccount(privHex, pubHex)
        assertTrue(sealed is SosSecureIdentityStore.WriteResult.Ok)
    }

    @Test
    fun highRiskOpRequiresTrustedConfirmationBeforeSign() {
        val r = adminSigner().attemptTypedAdminSign(
            binding(),
            SosNativeAdminPolicy.TypedAdminRequest(
                operation = SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME,
                communityId = community,
                params = mapOf("displayName" to "X"),
            ),
            verified(),
        )
        assertTrue(r is SosNativeAdminTypedSigner.AdminSignResult.Err)
        assertEquals(
            "TRUSTED_CONFIRMATION_REQUIRED",
            (r as SosNativeAdminTypedSigner.AdminSignResult.Err).code,
        )
    }

    @Test
    fun cannotBypassConfirmationWithFakeToken() {
        val r = adminSigner().attemptTypedAdminSign(
            binding(),
            SosNativeAdminPolicy.TypedAdminRequest(
                operation = SosNativeAdminPolicy.AdminOp.BOOTSTRAP_GROUP_CONTROL,
                communityId = community,
                params = mapOf("displayName" to "X", "invitePolicy" to "EVERYONE"),
            ),
            verified = null,
            confirmation = SosNativeAdminTypedSigner.TrustedConfirmation(
                token = "fake",
                operation = SosNativeAdminPolicy.AdminOp.BOOTSTRAP_GROUP_CONTROL,
                communityId = community,
                valid = true,
            ),
        )
        // F6G not available — even "valid" token rejected.
        assertEquals(
            "TRUSTED_CONFIRMATION_REQUIRED",
            (r as SosNativeAdminTypedSigner.AdminSignResult.Err).code,
        )
        assertFalse(SosNativeAdminTypedSigner.F6G_TRUSTED_CONFIRMATION_AVAILABLE)
        assertFalse(SosNativeAdminTypedSigner.HIGH_RISK_ADMIN_OP_CAN_SIGN_BEFORE_F6G)
        assertFalse(SosNativeAdminTypedSigner.WEBVIEW_CAN_BYPASS_NATIVE_CONFIRMATION)
    }

    @Test
    fun revokedSessionCannotSign() {
        val gate = SosNativeTypedSigner.SessionAuthorityGate { _, _, _ ->
            SosNativeTypedSigner.CheckResult.Err("SESSION_REVOKED")
        }
        val r = adminSigner(gate).attemptTypedAdminSign(
            binding(),
            SosNativeAdminPolicy.TypedAdminRequest(
                operation = SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME,
                communityId = community,
                params = mapOf("displayName" to "X"),
            ),
            verified(),
        )
        assertEquals("SESSION_REVOKED", (r as SosNativeAdminTypedSigner.AdminSignResult.Err).code)
    }

    @Test
    fun staleSessionCannotSign() {
        val gate = SosNativeTypedSigner.SessionAuthorityGate { _, _, _ ->
            SosNativeTypedSigner.CheckResult.Err("SESSION_STALE")
        }
        val r = adminSigner(gate).attemptTypedAdminSign(
            binding(),
            SosNativeAdminPolicy.TypedAdminRequest(
                operation = SosNativeAdminPolicy.AdminOp.REMOVE_MEMBER,
                communityId = community,
                params = mapOf("memberPubkey" to "aa".repeat(32)),
            ),
            verified(),
        )
        assertEquals("SESSION_STALE", (r as SosNativeAdminTypedSigner.AdminSignResult.Err).code)
    }

    @Test
    fun policyAllowedButSignBlockedUntilF6g() {
        val eval = adminSigner().evaluatePolicy(
            SosNativeAdminPolicy.TypedAdminRequest(
                operation = SosNativeAdminPolicy.AdminOp.GRANT_CAPABILITY,
                communityId = community,
                params = mapOf(
                    "targetPubkey" to "aa".repeat(32),
                    "capability" to "MANAGE_GROUP_SETTINGS",
                ),
            ),
            verified(),
        )
        assertTrue(eval is SosNativeAdminPolicy.PolicyResult.Allowed)
        val sign = adminSigner().attemptTypedAdminSign(
            binding(),
            SosNativeAdminPolicy.TypedAdminRequest(
                operation = SosNativeAdminPolicy.AdminOp.GRANT_CAPABILITY,
                communityId = community,
                params = mapOf(
                    "targetPubkey" to "aa".repeat(32),
                    "capability" to "MANAGE_GROUP_SETTINGS",
                ),
            ),
            verified(),
        )
        assertEquals(
            "TRUSTED_CONFIRMATION_REQUIRED",
            (sign as SosNativeAdminTypedSigner.AdminSignResult.Err).code,
        )
    }

    @Test
    fun noGenericAdminApi() {
        val s = adminSigner()
        assertEquals(
            "GENERIC_ADMIN_SIGN_UNAVAILABLE",
            (s.rejectSignAdminEvent() as SosNativeAdminTypedSigner.AdminSignResult.Err).code,
        )
        assertEquals(
            "GENERIC_ADMIN_SIGN_UNAVAILABLE",
            (s.rejectSignGroupControl() as SosNativeAdminTypedSigner.AdminSignResult.Err).code,
        )
        assertEquals(
            "GENERIC_ADMIN_SIGN_UNAVAILABLE",
            (s.rejectSignMembershipState() as SosNativeAdminTypedSigner.AdminSignResult.Err).code,
        )
        assertEquals(
            "GENERIC_ADMIN_SIGN_UNAVAILABLE",
            (s.rejectSignArbitraryAdmin() as SosNativeAdminTypedSigner.AdminSignResult.Err).code,
        )
        assertFalse(SosNativeAdminTypedSigner.GENERIC_NATIVE_ADMIN_SIGN_API)
        assertFalse(SosNativeAdminTypedSigner.ARBITRARY_ADMIN_EVENT_SIGNING_EXPOSED)
        assertTrue(SosNativeAdminTypedSigner.ADMIN_REUSES_F6D_SESSION_AUTHORITY)
        assertFalse(SosNativeAdminTypedSigner.SECOND_ADMIN_SESSION_AUTHORITY_CREATED)
        assertTrue(SosNativeAdminTypedSigner.ADMIN_SIGNING_PUBKEY_DERIVED_FROM_SECURE_IDENTITY)
        assertFalse(SosNativeAdminTypedSigner.CALLER_CAN_SELECT_ADMIN_PRIVATE_KEY)
    }

    @Test
    fun callerCannotSelectAdminPubkeyOrKind() {
        val r = adminSigner().attemptTypedAdminSign(
            binding(),
            SosNativeAdminPolicy.TypedAdminRequest(
                operation = SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME,
                communityId = community,
                params = mapOf("displayName" to "X"),
                pubkeyOverride = "bb".repeat(32),
                kindOverride = 1,
            ),
            verified(),
        )
        assertEquals("CALLER_KIND_OVERRIDE", (r as SosNativeAdminTypedSigner.AdminSignResult.Err).code)
    }

    @Test
    fun invariantsMatchAc9FailClosed() {
        assertTrue(SosNativeAdminTypedSigner.NATIVE_TYPED_SIGNER_ADMIN_POLICY_ENFORCED)
        assertTrue(SosNativeAdminTypedSigner.ADMIN_POLICY_CHECK_BEFORE_PRIVATE_KEY_USE)
        assertTrue(SosNativeAdminTypedSigner.ADMIN_POLICY_RECHECK_BEFORE_SIGN)
        assertTrue(SosNativeAdminTypedSigner.ADMIN_TYPED_OP_REQUIRES_NATIVE_SESSION)
    }
}
