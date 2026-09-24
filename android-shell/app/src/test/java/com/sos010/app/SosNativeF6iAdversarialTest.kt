package com.sos010.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.system.measureNanoTime

/**
 * F6I — Adversarial acceptance of the Android-native F6 security stack.
 * Tries to break identity, session, bridge, crypto, admin, confirmation.
 * Disposable test keys only. Never logs K/nsec.
 */
class SosNativeF6iAdversarialTest {
    companion object {
        init {
            val dll = java.io.File("build/native/secp256k1-jni.dll")
            if (dll.exists()) System.load(dll.absolutePath)
        }

        const val ADVERSARIAL_TEST_MARKER = "F6I_ADVERSARIAL_ACCEPTANCE"
        const val F6I_CLAIMS_XSS_ELIMINATED = false
        const val ROOTED_DEVICE_FULL_COMPROMISE_OUT_OF_SCOPE = true
        const val ANDROID_KEYSTORE_RAISES_EXTRACTION_BARRIER = true
        const val PHYSICAL_OS_KILL_INSTRUMENTED = false
        const val APPROVED_CONFIRMATION_PERSISTED_TO_DISK = false
        const val PROCESS_RESTART_CAN_REUSE_APPROVAL = false
    }

    private lateinit var prefs: SosSecureIdentityStore.MemoryPrefsBackend
    private lateinit var storeCrypto: SosSecureIdentityStore.SoftAesGcmCrypto
    private lateinit var privHex: String
    private lateinit var pubHex: String
    private lateinit var privB: String
    private lateinit var pubB: String
    private lateinit var peerPriv: String
    private lateinit var peerPub: String
    private var nowMs = 1_700_000_000_000L
    private val nowSec get() = nowMs / 1000L
    private val communityA = "community-a"
    private val communityB = "community-b"

    private fun derive(hex: String) = SosNostrCrypto.pubkeyFromPriv(hex)

    private fun identityEngine() = SosSecureIdentityStore.engineForTests(
        prefs = prefs,
        crypto = storeCrypto,
        derivePubkey = ::derive,
        legacyReader = { "" to "" },
    )

    private fun assertNoSecretLeak(json: String) {
        val lower = json.lowercase()
        assertFalse("raw k leak", Regex("\"k\"\\s*:\\s*\"[0-9a-f]{64}\"").containsMatchIn(lower))
        assertFalse(lower.contains("\"privkey\""))
        assertFalse(lower.contains("\"privatekey\""))
        assertFalse(lower.contains("\"nsec\""))
        assertFalse(lower.contains("\"secretkey\""))
        assertFalse(lower.contains(privHex.lowercase()))
    }

    @Before
    fun setUp() {
        prefs = SosSecureIdentityStore.MemoryPrefsBackend()
        storeCrypto = SosSecureIdentityStore.SoftAesGcmCrypto()
        privHex = "0000000000000000000000000000000000000000000000000000000000000001"
        pubHex = SosNostrCrypto.pubkeyFromPriv(privHex)
        privB = "0000000000000000000000000000000000000000000000000000000000000003"
        pubB = SosNostrCrypto.pubkeyFromPriv(privB)
        peerPriv = "0000000000000000000000000000000000000000000000000000000000000002"
        peerPub = SosNostrCrypto.pubkeyFromPriv(peerPriv)
        assertTrue(identityEngine().writeIdentitySameAccount(privHex, pubHex) is SosSecureIdentityStore.WriteResult.Ok)
        nowMs = 1_700_000_000_000L
    }

    // --- 3/34 secret extraction / bridge responses ---

    @Test
    fun typedBridgeResponsesNeverContainRawK() {
        val auth = SosNativeSessionAuthority.engineForTests(pubHex)
        val cap = (auth.bind(1L, pubHex) as SosNativeSessionAuthority.BindResult.Ok).capability
        val bridge = SosNativeTypedBridge.engineForTests(
            signer = SosNativeTypedSigner.engineForTests(
                identity = identityEngine(),
                sessionGate = SosNativeTypedSigner.F6dSessionGate { auth },
                nowSec = { nowSec },
            ),
            typedCrypto = SosNativeTypedCrypto.engineForTests(
                identity = identityEngine(),
                sessionGate = SosNativeTypedSigner.F6dSessionGate { auth },
            ),
            trusted = true,
            nowSec = { nowSec },
            sessionAuthority = auth,
            requireSessionBinding = true,
        )
        val ops = listOf(
            JSONObject()
                .put("v", 1).put("op", "SIGN_CHAT_EVENT").put("requestId", "s1")
                .put("sessionGeneration", 1L).put("accountPubkey", pubHex)
                .put("sessionCapability", cap)
                .put("params", JSONObject().put("content", "hi").put("recipientPubkey", peerPub)),
            JSONObject()
                .put("v", 1).put("op", "CHAT_ENCRYPT").put("requestId", "e1")
                .put("sessionGeneration", 1L).put("accountPubkey", pubHex)
                .put("sessionCapability", cap)
                .put("params", JSONObject().put("peerPubkey", peerPub).put("plaintext", "x")),
        )
        for (req in ops) {
            val r = bridge.dispatch(req.toString())
            assertNoSecretLeak(r.json)
        }
        assertNoSecretLeak(bridge.capabilitiesJson())
    }

    @Test
    fun untrustedContextCannotUseBridge() {
        val bridge = SosNativeTypedBridge.engineForTests(
            signer = SosNativeTypedSigner.engineForTests(identity = identityEngine(), nowSec = { nowSec }),
            trusted = false,
            nowSec = { nowSec },
        )
        val r = bridge.dispatch(
            JSONObject().put("v", 1).put("op", "SIGN_CHAT_EVENT").put("requestId", "u1")
                .put("params", JSONObject().put("content", "x").put("recipientPubkey", peerPub)).toString(),
        )
        assertFalse(r.ok)
        assertEquals("UNTRUSTED_CONTEXT", r.code)
        assertFalse(SosNativeTypedBridge.isTrustedWebViewUrl("https://evil.example/"))
        assertFalse(SosNativeTypedBridge.isTrustedWebViewUrl("javascript:alert(1)"))
        assertFalse(SosNativeTypedBridge.isTrustedWebViewUrl("data:text/html,hi"))
        assertFalse(SosNativeTypedBridge.isTrustedWebViewUrl("http://sos010.com/"))
        assertTrue(SosNativeTypedBridge.isTrustedWebViewUrl("https://sos010.com/app"))
    }

    // --- 5 identity corruption ---

    @Test
    fun corruptStoreDoesNotGenerateOrOverwriteIdentity() {
        val beforePub = prefs.getString("pubkey")
        prefs.corruptCiphertext()
        assertEquals(SosSecureIdentityStore.State.RECOVERY_REQUIRED, identityEngine().readState())
        val write = identityEngine().writeIdentitySameAccount(privB, pubB)
        assertTrue(write is SosSecureIdentityStore.WriteResult.Err)
        assertEquals(beforePub, prefs.getString("pubkey"))
        val signer = SosNativeTypedSigner.engineForTests(identity = identityEngine(), nowSec = { nowSec })
        val binding = SosNativeTypedSigner.SessionBinding(1L, pubHex, "cap")
        val sign = signer.signChatEvent(binding, SosNativeTypedSigner.ChatSignRequest(content = "hi", recipientPubkey = peerPub))
        assertTrue(sign is SosNativeTypedSigner.SignResult.Err)
    }

    // --- 6/7 identity + session confusion ---

    @Test
    fun accountACannotSignAsAccountB() {
        val auth = SosNativeSessionAuthority.engineForTests(pubHex)
        val capA = (auth.bind(1L, pubHex) as SosNativeSessionAuthority.BindResult.Ok).capability
        val signer = SosNativeTypedSigner.engineForTests(
            identity = identityEngine(),
            sessionGate = SosNativeTypedSigner.F6dSessionGate { auth },
            nowSec = { nowSec },
        )
        val wrongBinding = SosNativeTypedSigner.SessionBinding(1L, pubB, capA)
        val r = signer.signChatEvent(wrongBinding, SosNativeTypedSigner.ChatSignRequest(content = "x", recipientPubkey = peerPub))
        assertTrue(r is SosNativeTypedSigner.SignResult.Err)
    }

    @Test
    fun crossAccountCapabilityRejected() {
        val authA = SosNativeSessionAuthority.engineForTests(pubHex)
        val capA = (authA.bind(1L, pubHex) as SosNativeSessionAuthority.BindResult.Ok).capability
        val authB = SosNativeSessionAuthority.engineForTests(pubB)
        authB.bind(1L, pubB)
        val vr = authB.validateForCrypto(capA, pubB)
        assertTrue(vr is SosNativeSessionAuthority.ValidateResult.Err)
        val vr2 = authA.validateForCrypto(capA, pubB)
        assertTrue(vr2 is SosNativeSessionAuthority.ValidateResult.Err)
    }

    @Test
    fun revokedAndReplayedSessionRejected() {
        val auth = SosNativeSessionAuthority.engineForTests(pubHex)
        val cap = (auth.bind(1L, pubHex) as SosNativeSessionAuthority.BindResult.Ok).capability
        assertTrue(auth.validateForCrypto(cap, pubHex) is SosNativeSessionAuthority.ValidateResult.Ok)
        auth.revoke("logout")
        assertTrue(auth.validateForCrypto(cap, pubHex) is SosNativeSessionAuthority.ValidateResult.Err)
        // Replay old capability after rebind
        val cap2 = (auth.bind(2L, pubHex) as SosNativeSessionAuthority.BindResult.Ok).capability
        assertTrue(auth.validateForCrypto(cap, pubHex) is SosNativeSessionAuthority.ValidateResult.Err)
        assertTrue(auth.validateForCrypto(cap2, pubHex) is SosNativeSessionAuthority.ValidateResult.Ok)
        assertTrue(auth.validateForCrypto("random-garbage", pubHex) is SosNativeSessionAuthority.ValidateResult.Err)
        assertTrue(auth.validateForCrypto("", pubHex) is SosNativeSessionAuthority.ValidateResult.Err)
    }

    // --- 8 TOCTOU ---

    @Test
    fun revokeBetweenCheckAndSignFailsClosed() {
        val auth = SosNativeSessionAuthority.engineForTests(pubHex)
        val cap = (auth.bind(1L, pubHex) as SosNativeSessionAuthority.BindResult.Ok).capability
        assertTrue(auth.validateForCrypto(cap, pubHex) is SosNativeSessionAuthority.ValidateResult.Ok)
        auth.revoke("mid")
        val signer = SosNativeTypedSigner.engineForTests(
            identity = identityEngine(),
            sessionGate = SosNativeTypedSigner.F6dSessionGate { auth },
            nowSec = { nowSec },
        )
        val r = signer.signChatEvent(SosNativeTypedSigner.SessionBinding(1L, pubHex, cap), SosNativeTypedSigner.ChatSignRequest(content = "x", recipientPubkey = peerPub))
        assertTrue(r is SosNativeTypedSigner.SignResult.Err)
    }

    // --- 9 bridge fuzz ---

    @Test
    fun bridgeFuzzNeverGrantsAuthority() {
        val auth = SosNativeSessionAuthority.engineForTests(pubHex)
        val cap = (auth.bind(1L, pubHex) as SosNativeSessionAuthority.BindResult.Ok).capability
        val bridge = SosNativeTypedBridge.engineForTests(
            signer = SosNativeTypedSigner.engineForTests(
                identity = identityEngine(),
                sessionGate = SosNativeTypedSigner.F6dSessionGate { auth },
                nowSec = { nowSec },
            ),
            typedCrypto = SosNativeTypedCrypto.engineForTests(
                identity = identityEngine(),
                sessionGate = SosNativeTypedSigner.F6dSessionGate { auth },
            ),
            trusted = true,
            nowSec = { nowSec },
            sessionAuthority = auth,
            requireSessionBinding = true,
        )
        val attacks = listOf(
            "",
            "{",
            "null",
            "[]",
            "\"string\"",
            JSONObject().put("__proto__", JSONObject().put("op", "SIGN_CHAT_EVENT")).toString(),
            JSONObject().put("v", 1).put("op", "SIGN_CHAT_EVENT").put("requestId", "p1")
                .put("constructor", "x").put("sessionCapability", cap)
                .put("accountPubkey", pubHex).put("sessionGeneration", 1).toString(),
            JSONObject().put("v", 99).put("op", "SIGN_CHAT_EVENT").put("requestId", "v99")
                .put("sessionCapability", cap).put("accountPubkey", pubHex)
                .put("sessionGeneration", 1)
                .put("params", JSONObject().put("content", "x").put("recipientPubkey", peerPub)).toString(),
            JSONObject().put("v", 1).put("op", "SIGN_HASH").put("requestId", "hash")
                .put("sessionCapability", cap).put("accountPubkey", pubHex)
                .put("sessionGeneration", 1).put("params", JSONObject()).toString(),
            JSONObject().put("v", 1).put("op", "GENERIC_DECRYPT").put("requestId", "gd")
                .put("sessionCapability", cap).put("accountPubkey", pubHex)
                .put("sessionGeneration", 1).put("params", JSONObject()).toString(),
            JSONObject().put("v", 1).put("op", "SIGN_CHAT_EVENT").put("requestId", "priv")
                .put("sessionCapability", cap).put("accountPubkey", pubHex)
                .put("sessionGeneration", 1)
                .put("params", JSONObject().put("content", "x").put("recipientPubkey", peerPub)
                    .put("privateKey", privHex)).toString(),
            "x".repeat(SosNativeTypedBridge.MAX_REQUEST_CHARS + 10),
            JSONObject().put("v", 1).put("op", "EXPORT_CONVERSATION_KEY").put("requestId", "eck")
                .put("sessionCapability", cap).put("accountPubkey", pubHex)
                .put("sessionGeneration", 1).put("params", JSONObject()).toString(),
            JSONObject().put("v", 1).put("op", "ECDH_SECRET").put("requestId", "ecdh")
                .put("sessionCapability", cap).put("accountPubkey", pubHex)
                .put("sessionGeneration", 1).put("params", JSONObject()).toString(),
        )
        var grants = 0
        for ((i, raw) in attacks.withIndex()) {
            val r = bridge.dispatch(raw)
            assertNoSecretLeak(r.json)
            if (r.ok) grants++
            // Each failed attack must not produce signed events
            if (!r.ok) {
                assertFalse(JSONObject(r.json).optBoolean("ok", false))
            }
        }
        assertEquals("fuzz must not grant authority", 0, grants)

        // Valid then duplicate id — second must not re-apply
        val good = JSONObject().put("v", 1).put("op", "SIGN_CHAT_EVENT").put("requestId", "dup-ok")
            .put("sessionCapability", cap).put("accountPubkey", pubHex)
            .put("sessionGeneration", 1L)
            .put("params", JSONObject().put("content", "ok").put("recipientPubkey", peerPub))
        assertTrue(bridge.dispatch(good.toString()).ok)
        val dup = bridge.dispatch(good.toString())
        assertFalse(dup.ok)
        assertEquals("DUPLICATE_REQUEST_ID", dup.code)
    }

    // --- 11/12 crypto domain + tamper ---

    @Test
    fun crossDomainAndTamperedNip44Rejected() {
        val gate = SosNativeTypedSigner.TestPermissiveSessionGate
        val crypto = SosNativeTypedCrypto.engineForTests(identity = identityEngine(), sessionGate = gate)
        val binding = SosNativeTypedSigner.SessionBinding(1L, pubHex, "cap")
        val enc = crypto.chatEncrypt(binding, peerPub, "hello") as SosNativeTypedCrypto.CryptoResult.Ok
        val ct = enc.value.getString("ct")
        // wrong peer
        val wrong = crypto.chatDecrypt(binding, pubB, ct)
        assertTrue(wrong is SosNativeTypedCrypto.CryptoResult.Err)
        // tampered
        val tampered = if (ct.length > 8) ct.dropLast(2) + "aa" else ct + "aa"
        val t = crypto.chatDecrypt(binding, peerPub, tampered)
        assertTrue(t is SosNativeTypedCrypto.CryptoResult.Err)
        // empty / malformed
        assertTrue(crypto.chatDecrypt(binding, peerPub, "") is SosNativeTypedCrypto.CryptoResult.Err)
        assertTrue(crypto.chatDecrypt(binding, peerPub, "!!!") is SosNativeTypedCrypto.CryptoResult.Err)
        // file key wrong peer
        val wrap = crypto.fileKeyWrap(binding, peerPub, "file-aes-key-material-32b!!!!!!!!") as SosNativeTypedCrypto.CryptoResult.Ok
        val unwrapWrong = crypto.fileKeyUnwrap(binding, pubB, wrap.value.getString("ciphertext"))
        assertTrue(unwrapWrong is SosNativeTypedCrypto.CryptoResult.Err)
        assertFalse(SosNativeTypedCrypto.RAW_FILE_KEY_OVER_DC)
        assertFalse(SosNativeTypedCrypto.P2P_BULK_DATA_PATH_CHANGED)
        assertFalse(SosNativeTypedCrypto.GENERIC_NATIVE_DECRYPT_API)
        assertFalse(SosNativeTypedCrypto.GENERIC_CONVERSATION_KEY_API)
    }

    // --- 16 admin policy ---

    @Test
    fun adminPolicyBypassAttemptsFail() {
        val verified = SosNativeAdminPolicy.VerifiedControlSnapshot(
            groupId = communityA,
            controlEpoch = 2,
            rootAdminPubkey = pubHex,
            capabilities = mapOf(pubB to listOf("MANAGE_MEMBERS")),
            invitePolicy = "EVERYONE",
            blockedPubkeys = emptyList(),
            membershipEpoch = 1,
            displayName = "A",
            networkTag = communityA,
            baseProvenLatest = true,
        )
        val policy = SosNativeAdminPolicy.engineForTests { nowSec }
        // Fake root actor attempting root-only bootstrap resolve
        val fakeRoot = policy.evaluate(
            actorPubkey = pubB,
            request = SosNativeAdminPolicy.TypedAdminRequest(
                operation = SosNativeAdminPolicy.AdminOp.RESOLVE_CONTROL_CONFLICT,
                communityId = communityA,
                params = mapOf("candidateEventIds" to listOf("evt-aaaaaaaa", "evt-bbbbbbbb")),
                controlConflict = true,
            ),
            verified = verified,
        )
        assertTrue(fakeRoot is SosNativeAdminPolicy.PolicyResult.Denied)
        // Cross community
        val cross = policy.evaluate(
            actorPubkey = pubHex,
            request = SosNativeAdminPolicy.TypedAdminRequest(
                SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME,
                communityB,
                mapOf("displayName" to "X"),
            ),
            verified = verified,
        )
        assertTrue(cross is SosNativeAdminPolicy.PolicyResult.Denied)
        assertEquals(
            "CROSS_COMMUNITY",
            (cross as SosNativeAdminPolicy.PolicyResult.Denied).code,
        )
        // Confirmation still required at signer layer
        assertEquals(
            SosNativeAdminPolicy.ConfirmClass.NATIVE_CONFIRM_REQUIRED,
            SosNativeAdminPolicy.confirmationFor(SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME),
        )
        assertFalse(SosNativeAdminTypedSigner.HIGH_RISK_ADMIN_OP_CAN_SIGN_WITHOUT_CONFIRMATION)
    }

    // --- 17 trusted confirmation bypass ---

    @Test
    fun trustedConfirmationBypassAttemptsFail() {
        val eng = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        val intent = SosNativeTrustedConfirmation.IntentSpec(
            requestId = "c1",
            operation = SosNativeAdminPolicy.AdminOp.GRANT_CAPABILITY,
            communityId = communityA,
            accountPubkey = pubHex,
            sessionCapability = "cap",
            params = mapOf("targetPubkey" to peerPub, "capability" to "MANAGE_MEMBERS"),
            targetPubkey = peerPub,
        )
        val created = eng.create(intent) as SosNativeTrustedConfirmation.CreateResult.Ok
        // Direct approve path is native-only; replay after cancel
        eng.cancel(created.challengeId)
        assertTrue(eng.approveFromNativeUi(created.challengeId) is SosNativeTrustedConfirmation.ApproveResult.Err)

        nowMs += SosNativeTrustedConfirmation.CREATE_COOLDOWN_MS + 1
        val created2 = eng.create(intent.copy(requestId = "c2")) as SosNativeTrustedConfirmation.CreateResult.Ok
        val ap = eng.approveFromNativeUi(created2.challengeId) as SosNativeTrustedConfirmation.ApproveResult.Ok
        assertEquals(null, eng.consumeForSign(ap.authorization, intent.copy(requestId = "c2")))
        // mutated
        nowMs += SosNativeTrustedConfirmation.CREATE_COOLDOWN_MS + 1
        val created3 = eng.create(intent.copy(requestId = "c3")) as SosNativeTrustedConfirmation.CreateResult.Ok
        val ap3 = eng.approveFromNativeUi(created3.challengeId) as SosNativeTrustedConfirmation.ApproveResult.Ok
        val mutated = intent.copy(requestId = "c3", communityId = communityB)
        val mutCode = eng.consumeForSign(ap3.authorization, mutated)
        assertEquals("PAYLOAD_MUTATION", mutCode)
        eng.invalidateAll("after-mutation")

        // Cross request: A active, B rejected
        nowMs += SosNativeTrustedConfirmation.CREATE_COOLDOWN_MS + 1
        val a = eng.create(intent.copy(requestId = "A")) as SosNativeTrustedConfirmation.CreateResult.Ok
        nowMs += SosNativeTrustedConfirmation.CREATE_COOLDOWN_MS + 1
        val b = eng.create(intent.copy(requestId = "B", targetPubkey = pubB,
            params = mapOf("targetPubkey" to pubB, "capability" to "MANAGE_MEMBERS")))
        assertTrue(b is SosNativeTrustedConfirmation.CreateResult.Err)
        eng.cancel(a.challengeId)

        // Flood
        var limited = 0
        for (i in 0 until 30) {
            nowMs += 1
            when (eng.create(intent.copy(requestId = "flood-$i"))) {
                is SosNativeTrustedConfirmation.CreateResult.Err -> limited++
                is SosNativeTrustedConfirmation.CreateResult.Ok -> { /* cancel */ eng.invalidateAll("flood") }
            }
        }
        assertTrue(limited > 0)
        assertFalse(SosNativeTrustedConfirmation.WEBVIEW_CAN_CALL_APPROVE_METHOD)
        assertFalse(SosNativeTrustedConfirmation.PROGRAMMATIC_AUTO_CONFIRM_SUPPORTED)
        assertFalse(F6I_CLAIMS_XSS_ELIMINATED)
    }

    // --- 25 process restart model ---

    @Test
    fun processRestartModelMemoryOnly() {
        val auth = SosNativeSessionAuthority.engineForTests(pubHex)
        val cap = (auth.bind(1L, pubHex) as SosNativeSessionAuthority.BindResult.Ok).capability
        // New engine instance = process restart simulation
        val auth2 = SosNativeSessionAuthority.engineForTests(pubHex)
        assertTrue(auth2.validateForCrypto(cap, pubHex) is SosNativeSessionAuthority.ValidateResult.Err)

        val conf = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        val intent = SosNativeTrustedConfirmation.IntentSpec(
            requestId = "pr1",
            operation = SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME,
            communityId = communityA,
            accountPubkey = pubHex,
            sessionCapability = "cap",
            params = mapOf("displayName" to "X"),
        )
        val created = conf.create(intent) as SosNativeTrustedConfirmation.CreateResult.Ok
        conf.approveFromNativeUi(created.challengeId)
        val conf2 = SosNativeTrustedConfirmation.engineForTests(nowMs = { nowMs })
        assertFalse(conf2.hasActivePending())
        assertTrue(conf2.approveFromNativeUi(created.challengeId) is SosNativeTrustedConfirmation.ApproveResult.Err)
        assertFalse(APPROVED_CONFIRMATION_PERSISTED_TO_DISK)
        assertFalse(PROCESS_RESTART_CAN_REUSE_APPROVAL)
        assertFalse(PHYSICAL_OS_KILL_INSTRUMENTED)
        assertTrue(ROOTED_DEVICE_FULL_COMPROMISE_OUT_OF_SCOPE)
        assertTrue(ANDROID_KEYSTORE_RAISES_EXTRACTION_BARRIER)
    }

    // --- 26 concurrency ---

    @Test
    fun concurrentRevokeFailsClosed() {
        val auth = SosNativeSessionAuthority.engineForTests(pubHex)
        val cap = (auth.bind(1L, pubHex) as SosNativeSessionAuthority.BindResult.Ok).capability
        val signer = SosNativeTypedSigner.engineForTests(
            identity = identityEngine(),
            sessionGate = SosNativeTypedSigner.F6dSessionGate { auth },
            nowSec = { nowSec },
        )
        val pool = Executors.newFixedThreadPool(8)
        val okCount = AtomicInteger(0)
        val failCount = AtomicInteger(0)
        val latch = CountDownLatch(40)
        repeat(40) { i ->
            pool.execute {
                try {
                    if (i == 10) auth.revoke("race")
                    val r = signer.signChatEvent(SosNativeTypedSigner.SessionBinding(1L, pubHex, cap), SosNativeTypedSigner.ChatSignRequest(content = "m$i", recipientPubkey = peerPub,
                    ))
                    if (r is SosNativeTypedSigner.SignResult.Ok) okCount.incrementAndGet()
                    else failCount.incrementAndGet()
                } finally {
                    latch.countDown()
                }
            }
        }
        assertTrue(latch.await(30, TimeUnit.SECONDS))
        pool.shutdown()
        assertTrue("some must fail after revoke", failCount.get() > 0)
        // After revoke, further signs must fail
        val after = signer.signChatEvent(SosNativeTypedSigner.SessionBinding(1L, pubHex, cap), SosNativeTypedSigner.ChatSignRequest(content = "late", recipientPubkey = peerPub))
        assertTrue(after is SosNativeTypedSigner.SignResult.Err)
    }

    // --- 27 flood ---

    @Test
    fun bridgeFloodBounded() {
        val auth = SosNativeSessionAuthority.engineForTests(pubHex)
        val cap = (auth.bind(1L, pubHex) as SosNativeSessionAuthority.BindResult.Ok).capability
        val bridge = SosNativeTypedBridge.engineForTests(
            signer = SosNativeTypedSigner.engineForTests(
                identity = identityEngine(),
                sessionGate = SosNativeTypedSigner.F6dSessionGate { auth },
                nowSec = { nowSec },
            ),
            trusted = true,
            nowSec = { nowSec },
            sessionAuthority = auth,
            requireSessionBinding = true,
        )
        var fail = 0
        repeat(200) { i ->
            val r = bridge.dispatch(
                JSONObject().put("v", 1).put("op", "SIGN_CHAT_EVENT").put("requestId", "flood-$i")
                    .put("sessionCapability", "bad-cap").put("accountPubkey", pubHex)
                    .put("sessionGeneration", 1L)
                    .put("params", JSONObject().put("content", "x").put("recipientPubkey", peerPub)).toString(),
            )
            if (!r.ok) fail++
            assertNoSecretLeak(r.json)
        }
        assertEquals(200, fail)
        // Valid still works once
        val ok = bridge.dispatch(
            JSONObject().put("v", 1).put("op", "SIGN_CHAT_EVENT").put("requestId", "after-flood")
                .put("sessionCapability", cap).put("accountPubkey", pubHex)
                .put("sessionGeneration", 1L)
                .put("params", JSONObject().put("content", "ok").put("recipientPubkey", peerPub)).toString(),
        )
        assertTrue(ok.ok)
    }

    // --- 28 light perf smoke (not full 10k — master gates cover that) ---

    @Test
    fun f6iPerfSmokeNoRemote() {
        val auth = SosNativeSessionAuthority.engineForTests(pubHex)
        val cap = (auth.bind(1L, pubHex) as SosNativeSessionAuthority.BindResult.Ok).capability
        val signer = SosNativeTypedSigner.engineForTests(
            identity = identityEngine(),
            sessionGate = SosNativeTypedSigner.F6dSessionGate { auth },
            nowSec = { nowSec },
        )
        val ns = measureNanoTime {
            repeat(100) { i ->
                signer.signChatEvent(SosNativeTypedSigner.SessionBinding(1L, pubHex, cap), SosNativeTypedSigner.ChatSignRequest(content = "p$i", recipientPubkey = peerPub,
                ))
            }
        }
        assertTrue(ns / 1_000_000.0 < 30_000.0)
        assertFalse(SosNativeTypedBridge.GENERIC_SIGN_BRIDGE_OPERATION)
        assertTrue(ADVERSARIAL_TEST_MARKER.isNotEmpty())
    }

    // --- 31 provider / legacy ---

    @Test
    fun legacyPlaintextNotTypedAuthorityAndFlagsHonest() {
        assertFalse(SosNativeTypedCrypto.F6F_TYPED_CRYPTO_READS_LEGACY_RAW_K_DIRECTLY)
        assertFalse(SosNativeTypedCrypto.NATIVE_K_COPIED_TO_BROWSER)
        assertFalse(SosNativeTrustedConfirmation.F5B5_EXPORT_IMPLEMENTED)
        assertFalse(SosNativeTrustedConfirmation.F5B6_MIGRATION_IMPLEMENTED)
        assertFalse(SosNativeTrustedConfirmation.ACCESS_CONTROL_V2_ACTIVATION_READY)
        assertFalse(SosNativeTrustedConfirmation.F6G_CLAIMS_XSS_ELIMINATED)
        // No JavascriptInterface approve methods
        val names = SosJsBridge::class.java.declaredMethods.map { it.name }
        assertFalse(names.any { it.equals("approve", true) || it.equals("getPrivkey", true) })
        assertTrue(names.contains("requestNativeAdminTypedOperation"))
        assertTrue(names.contains("nativeTypedCryptoRequest"))
    }

    @Test
    fun adminIntentCannotUseRoutineSignPath() {
        val auth = SosNativeSessionAuthority.engineForTests(pubHex)
        val cap = (auth.bind(1L, pubHex) as SosNativeSessionAuthority.BindResult.Ok).capability
        val bridge = SosNativeTypedBridge.engineForTests(
            signer = SosNativeTypedSigner.engineForTests(
                identity = identityEngine(),
                sessionGate = SosNativeTypedSigner.F6dSessionGate { auth },
                nowSec = { nowSec },
            ),
            trusted = true,
            nowSec = { nowSec },
            sessionAuthority = auth,
            requireSessionBinding = true,
        )
        val r = bridge.dispatch(
            JSONObject().put("v", 1).put("op", "GRANT_CAPABILITY").put("requestId", "admin-escape")
                .put("sessionCapability", cap).put("accountPubkey", pubHex)
                .put("sessionGeneration", 1L)
                .put("params", JSONObject().put("targetPubkey", peerPub)).toString(),
        )
        assertFalse(r.ok)
        assertEquals("UNSUPPORTED_OPERATION", r.code)
    }
}
