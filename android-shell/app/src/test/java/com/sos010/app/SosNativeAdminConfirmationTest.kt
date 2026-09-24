package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * F6G — admin signing only after valid native confirmation Authorization.
 */
class SosNativeAdminConfirmationTest {
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
    private var nowMs = 1_700_000_000_000L
    private val community = "sos-admin-confirm"
    private val cap = "cap-admin-1"

    private fun derive(hex: String) = SosNostrCrypto.pubkeyFromPriv(hex)

    private fun identityEngine() = SosSecureIdentityStore.engineForTests(
        prefs = prefs,
        crypto = storeCrypto,
        derivePubkey = ::derive,
        legacyReader = { "" to "" },
    )

    @Before
    fun setUp() {
        prefs = SosSecureIdentityStore.MemoryPrefsBackend()
        storeCrypto = SosSecureIdentityStore.SoftAesGcmCrypto()
        privHex = "0000000000000000000000000000000000000000000000000000000000000001"
        pubHex = SosNostrCrypto.pubkeyFromPriv(privHex)
        assertTrue(identityEngine().writeIdentitySameAccount(privHex, pubHex) is SosSecureIdentityStore.WriteResult.Ok)
        nowMs = 1_700_000_000_000L
    }

    private fun verified() = SosNativeAdminPolicy.VerifiedControlSnapshot(
        groupId = community,
        controlEpoch = 2,
        rootAdminPubkey = pubHex,
        capabilities = emptyMap(),
        invitePolicy = "EVERYONE",
        blockedPubkeys = emptyList(),
        membershipEpoch = 1,
        displayName = "C",
        networkTag = community,
        baseProvenLatest = true,
    )

    @Test
    fun highRiskSignsOnlyAfterValidNativeConfirmation() {
        val conf = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        val params = mapOf("displayName" to "Confirmed")
        val intent = SosNativeTrustedConfirmation.IntentSpec(
            requestId = "admin-1",
            operation = SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME,
            communityId = community,
            accountPubkey = pubHex,
            sessionCapability = cap,
            params = params,
        )
        val created = conf.create(intent) as SosNativeTrustedConfirmation.CreateResult.Ok
        val ap = conf.approveFromNativeUi(created.challengeId) as SosNativeTrustedConfirmation.ApproveResult.Ok
        assertEquals(null, conf.consumeForSign(ap.authorization, intent))

        val signer = SosNativeAdminTypedSigner.engineForTests(
            identity = identityEngine(),
            nowSec = { now },
            nowMs = { nowMs },
        )
        val binding = SosNativeTypedSigner.SessionBinding(1L, pubHex, cap)
        val req = SosNativeAdminPolicy.TypedAdminRequest(
            operation = SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME,
            communityId = community,
            params = params,
        )
        val signed = signer.attemptTypedAdminSign(binding, req, verified(), ap.authorization)
        assertTrue(
            "expected Ok, got $signed",
            signed is SosNativeAdminTypedSigner.AdminSignResult.Ok,
        )
        val ev = (signed as SosNativeAdminTypedSigner.AdminSignResult.Ok).event
        assertEquals(39001, ev.getInt("kind"))
        assertEquals(pubHex, ev.getString("pubkey").lowercase())
        assertTrue(SosNativeAdminTypedSigner.HIGH_RISK_ADMIN_OP_CAN_SIGN_AFTER_VALID_NATIVE_CONFIRMATION)
        assertFalse(SosNativeAdminTypedSigner.HIGH_RISK_ADMIN_OP_CAN_SIGN_WITHOUT_CONFIRMATION)
    }

    @Test
    fun withoutConfirmationStillBlocked() {
        val signer = SosNativeAdminTypedSigner.engineForTests(identity = identityEngine(), nowSec = { now })
        val r = signer.attemptTypedAdminSign(
            SosNativeTypedSigner.SessionBinding(1L, pubHex, cap),
            SosNativeAdminPolicy.TypedAdminRequest(
                operation = SosNativeAdminPolicy.AdminOp.REMOVE_MEMBER,
                communityId = community,
                params = mapOf("memberPubkey" to "aa".repeat(32)),
            ),
            verified(),
            authorization = null,
        )
        assertEquals("TRUSTED_CONFIRMATION_REQUIRED", (r as SosNativeAdminTypedSigner.AdminSignResult.Err).code)
    }

    @Test
    fun allF6eOpsRequireTrustedConfirmationClass() {
        SosNativeAdminPolicy.AdminOp.values().forEach { op ->
            assertEquals(
                SosNativeAdminPolicy.ConfirmClass.NATIVE_CONFIRM_REQUIRED,
                SosNativeAdminPolicy.confirmationFor(op),
            )
        }
        assertTrue(SosNativeTrustedConfirmation.ALL_F6E_ADMIN_OPS_HAVE_TRUSTED_CONFIRMATION)
    }

    @Test
    fun rootOnlyNotOverriddenByConfirmation() {
        // Delegated actor cannot get ROOT_ONLY past policy even with fake flow —
        // policy denies before confirm matters.
        val delegPriv = "0000000000000000000000000000000000000000000000000000000000000002"
        val delegPub = SosNostrCrypto.pubkeyFromPriv(delegPriv)
        prefs = SosSecureIdentityStore.MemoryPrefsBackend()
        assertTrue(
            identityEngine().writeIdentitySameAccount(delegPriv, delegPub)
                is SosSecureIdentityStore.WriteResult.Ok,
        )
        val signer = SosNativeAdminTypedSigner.engineForTests(identity = identityEngine(), nowSec = { now })
        val snap = SosNativeAdminPolicy.VerifiedControlSnapshot(
            groupId = community,
            controlEpoch = 2,
            rootAdminPubkey = pubHex,
            capabilities = mapOf(delegPub to listOf("MANAGE_MEMBERS")),
            invitePolicy = "EVERYONE",
            blockedPubkeys = emptyList(),
            membershipEpoch = 1,
            displayName = "C",
            networkTag = community,
            baseProvenLatest = true,
        )
        val r = signer.attemptTypedAdminSign(
            SosNativeTypedSigner.SessionBinding(1L, delegPub, cap),
            SosNativeAdminPolicy.TypedAdminRequest(
                operation = SosNativeAdminPolicy.AdminOp.RESOLVE_CONTROL_CONFLICT,
                communityId = community,
                params = mapOf("candidateEventIds" to listOf("abcdef12", "fedcba98")),
            ),
            snap,
            authorization = null,
        )
        // Policy denies root-only before confirmation gate.
        assertEquals("ROOT_RESOLVE_REQUIRED", (r as SosNativeAdminTypedSigner.AdminSignResult.Err).code)
        assertTrue(SosNativeTrustedConfirmation.CONFIRMATION_DOES_NOT_OVERRIDE_ROOT_REQUIREMENT)
        assertFalse(SosNativeTrustedConfirmation.DELEGATED_ADMIN_CAN_CONFIRM_ROOT_ONLY_OPERATION)
    }

    @Test
    fun routineChatNotRequiringConfirm() {
        assertFalse(SosNativeTrustedConfirmation.ROUTINE_CHAT_REQUIRES_NATIVE_CONFIRM)
        assertFalse(SosNativeTrustedConfirmation.P2P_FILE_CHUNK_REQUIRES_NATIVE_CONFIRM)
        assertFalse(SosNativeTrustedConfirmation.CALL_SIGNAL_PACKET_REQUIRES_NATIVE_CONFIRM)
        assertFalse(SosNativeTrustedConfirmation.CALL_PROTOCOL_CHANGED)
        assertFalse(SosNativeTrustedConfirmation.F5B5_EXPORT_IMPLEMENTED)
        assertFalse(SosNativeTrustedConfirmation.F5B6_MIGRATION_IMPLEMENTED)
    }
}
