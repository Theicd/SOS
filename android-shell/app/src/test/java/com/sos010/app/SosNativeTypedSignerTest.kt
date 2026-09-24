package com.sos010.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import kotlin.system.measureNanoTime

/**
 * F6B — SosNativeTypedSigner unit tests (disposable identities only).
 */
class SosNativeTypedSignerTest {
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

    private fun derive(hex: String): String = SosNostrCrypto.pubkeyFromPriv(hex)

    private fun identityEngine(
        legacy: () -> Pair<String, String> = { "" to "" },
    ): SosSecureIdentityStore.Engine =
        SosSecureIdentityStore.engineForTests(
            prefs = prefs,
            crypto = storeCrypto,
            derivePubkey = ::derive,
            legacyReader = legacy,
        )

    private fun binding(gen: Long = 1L, account: String = pubHex) =
        SosNativeTypedSigner.SessionBinding(sessionGeneration = gen, accountPubkey = account)

    private fun signer(
        verify: (JSONObject) -> Boolean = { SosNostrCrypto.verifyEvent(it) },
    ): SosNativeTypedSigner.Engine =
        SosNativeTypedSigner.engineForTests(
            identity = identityEngine(),
            nowSec = { now },
            verifyEvent = verify,
        )

    @Before
    fun setUp() {
        prefs = SosSecureIdentityStore.MemoryPrefsBackend()
        storeCrypto = SosSecureIdentityStore.SoftAesGcmCrypto()
        // Disposable deterministic secp256k1 scalar (NIP-01 style test key).
        privHex = "0000000000000000000000000000000000000000000000000000000000000001"
        pubHex = SosNostrCrypto.pubkeyFromPriv(privHex)
        val sealed = identityEngine().writeIdentitySameAccount(privHex, pubHex)
        assertTrue(sealed is SosSecureIdentityStore.WriteResult.Ok)
    }

    @Test
    fun validSecureIdentitySignsChatEvent() {
        val r = signer().signChatEvent(
            binding(),
            SosNativeTypedSigner.ChatSignRequest(content = "hi", recipientPubkey = "aa".repeat(32)),
        )
        assertTrue(r is SosNativeTypedSigner.SignResult.Ok)
        val ev = (r as SosNativeTypedSigner.SignResult.Ok).event
        assertEquals(1050, ev.getInt("kind"))
        assertEquals(pubHex, ev.getString("pubkey").lowercase())
        assertTrue(SosNostrCrypto.verifyEvent(ev))
        assertFalse(ev.has("privateKey") || ev.has("privkey") || ev.has("nsec") || ev.has("k"))
    }

    @Test
    fun signedPubkeyMatchesSecureIdentityAndCallerCannotOverride() {
        val r = signer().signPresenceEvent(
            binding(),
            SosNativeTypedSigner.PresenceSignRequest(content = "{}", recipientPubkey = "bb".repeat(32)),
        )
        val ev = (r as SosNativeTypedSigner.SignResult.Ok).event
        assertEquals(pubHex, ev.getString("pubkey").lowercase())
        assertEquals(1054, ev.getInt("kind"))
    }

    @Test
    fun canonicalIdAndSignatureVerify() {
        val r = signer().signReadReceiptEvent(
            binding(),
            SosNativeTypedSigner.ReadReceiptSignRequest(
                content = "{\"read\":true}",
                recipientPubkey = "cc".repeat(32),
                eventIdTag = "dd".repeat(32),
            ),
        )
        val ev = (r as SosNativeTypedSigner.SignResult.Ok).event
        assertEquals(1051, ev.getInt("kind"))
        assertEquals(SosNostrCrypto.nostrEventId(ev), ev.getString("id").lowercase())
        assertTrue(SosNostrCrypto.verifyEvent(ev))
    }

    @Test
    fun callSealAndGiftwrapTypedOps() {
        val seal = signer().signCallSealEvent(
            binding(),
            SosNativeTypedSigner.CallSealSignRequest(content = "seal-body"),
        )
        assertTrue(seal is SosNativeTypedSigner.SignResult.Ok)
        assertEquals(13, (seal as SosNativeTypedSigner.SignResult.Ok).event.getInt("kind"))

        val wrap = signer().signCallGiftwrapEvent(
            binding(),
            SosNativeTypedSigner.CallGiftwrapSignRequest(
                content = "wrap-body",
                recipientPubkey = "ee".repeat(32),
            ),
        )
        assertTrue(wrap is SosNativeTypedSigner.SignResult.Ok)
        assertEquals(1059, (wrap as SosNativeTypedSigner.SignResult.Ok).event.getInt("kind"))
        assertTrue(SosNostrCrypto.verifyEvent(wrap.event))
    }

    @Test
    fun invalidIdentityCannotSign() {
        prefs.corruptCiphertext()
        val r = signer().signChatEvent(
            binding(account = ""),
            SosNativeTypedSigner.ChatSignRequest(content = "x", recipientPubkey = "aa".repeat(32)),
        )
        assertTrue(r is SosNativeTypedSigner.SignResult.Err)
        assertEquals("RECOVERY_REQUIRED_IDENTITY", (r as SosNativeTypedSigner.SignResult.Err).code)
    }

    @Test
    fun mismatchSecureIdentityCannotSign() {
        val otherPriv = "0000000000000000000000000000000000000000000000000000000000000002"
        val otherPub = SosNostrCrypto.pubkeyFromPriv(otherPriv)
        val mismatched = identityEngine(legacy = { otherPriv to otherPub })
        assertEquals(SosSecureIdentityStore.State.MISMATCH, mismatched.readState())
        val eng = SosNativeTypedSigner.engineForTests(
            identity = mismatched,
            nowSec = { now },
        )
        val r = eng.signChatEvent(
            binding(account = ""),
            SosNativeTypedSigner.ChatSignRequest(content = "x", recipientPubkey = "aa".repeat(32)),
        )
        assertEquals("MISMATCH_SECURE_IDENTITY", (r as SosNativeTypedSigner.SignResult.Err).code)
    }

    @Test
    fun mismatchAccountBindingCannotSign() {
        val r = signer().signChatEvent(
            binding(account = "ff".repeat(32)),
            SosNativeTypedSigner.ChatSignRequest(content = "x", recipientPubkey = "aa".repeat(32)),
        )
        assertTrue(r is SosNativeTypedSigner.SignResult.Err)
        assertEquals("SESSION_ACCOUNT_MISMATCH", (r as SosNativeTypedSigner.SignResult.Err).code)
    }

    @Test
    fun malformedRecipientRejected() {
        val r = signer().signChatEvent(
            binding(),
            SosNativeTypedSigner.ChatSignRequest(content = "x", recipientPubkey = "nope"),
        )
        assertEquals("BAD_RECIPIENT", (r as SosNativeTypedSigner.SignResult.Err).code)
    }

    @Test
    fun contentTooLargeRejected() {
        val big = "a".repeat(SosNativeTypedSigner.MAX_CONTENT_CHARS + 1)
        val r = signer().signChatEvent(
            binding(),
            SosNativeTypedSigner.ChatSignRequest(content = big, recipientPubkey = "aa".repeat(32)),
        )
        assertEquals("CONTENT_TOO_LARGE", (r as SosNativeTypedSigner.SignResult.Err).code)
    }

    @Test
    fun badCreatedAtRejected() {
        val r = signer().signChatEvent(
            binding(),
            SosNativeTypedSigner.ChatSignRequest(
                content = "x",
                recipientPubkey = "aa".repeat(32),
                createdAt = 1L,
            ),
        )
        assertEquals("BAD_CREATED_AT", (r as SosNativeTypedSigner.SignResult.Err).code)
    }

    @Test
    fun arbitraryEventSigningUnavailable() {
        val r = signer().rejectArbitraryEventSign()
        assertEquals("ARBITRARY_EVENT_SIGNING_UNAVAILABLE", (r as SosNativeTypedSigner.SignResult.Err).code)
    }

    @Test
    fun sessionGateExtensionPointCanDeny() {
        val eng = SosNativeTypedSigner.engineForTests(
            identity = identityEngine(),
            sessionGate = SosNativeTypedSigner.SessionAuthorityGate { _, _, _ ->
                SosNativeTypedSigner.CheckResult.Err("SESSION_REVOKED")
            },
            nowSec = { now },
        )
        val r = eng.signChatEvent(
            binding(),
            SosNativeTypedSigner.ChatSignRequest(content = "x", recipientPubkey = "aa".repeat(32)),
        )
        assertEquals("SESSION_REVOKED", (r as SosNativeTypedSigner.SignResult.Err).code)
    }

    @Test
    fun communityDoesNotSelectKey() {
        // Passing a different "community" is impossible — API has no community field.
        // Signing still uses secure identity pubkey only.
        val r = signer().signChatEvent(
            binding(),
            SosNativeTypedSigner.ChatSignRequest(content = "c", recipientPubkey = "aa".repeat(32)),
        )
        assertEquals(pubHex, (r as SosNativeTypedSigner.SignResult.Ok).event.getString("pubkey").lowercase())
        assertTrue(SosNativeTypedSigner.NATIVE_SIGNER_IDENTITY_COMMUNITY_INDEPENDENT)
        assertFalse(SosNativeTypedSigner.ACTIVE_COMMUNITY_SELECTS_PRIVATE_KEY)
    }

    @Test
    fun noSecureIdentityCannotSign() {
        identityEngine().clearSecureIdentity()
        val r = signer().signChatEvent(
            binding(account = ""),
            SosNativeTypedSigner.ChatSignRequest(content = "x", recipientPubkey = "aa".repeat(32)),
        )
        assertEquals("NO_SECURE_IDENTITY", (r as SosNativeTypedSigner.SignResult.Err).code)
    }

    @Test
    fun designInvariantsAndNoGenericApiSurface() {
        assertFalse(SosNativeTypedSigner.GENERIC_NATIVE_SIGN_API)
        assertFalse(SosNativeTypedSigner.GENERIC_NATIVE_DECRYPT_API)
        assertFalse(SosNativeTypedSigner.ARBITRARY_EVENT_SIGNING_API_EXPOSED)
        assertFalse(SosNativeTypedSigner.NATIVE_TYPED_SIGNER_RETURNS_RAW_K)
        assertFalse(SosNativeTypedSigner.NATIVE_TYPED_SIGNER_RETURNS_NSEC)
        assertFalse(SosNativeTypedSigner.CALLER_SUPPLIED_ARBITRARY_EVENT_ACCEPTED)
        assertTrue(SosNativeTypedSigner.F6B_SESSION_BINDING_EXTENSION_POINT_PRESENT)
        assertTrue(SosNativeTypedSigner.F6B_DOES_NOT_BYPASS_FUTURE_F6D)
        assertFalse(SosNativeTypedSigner.F6B_NEW_WEBVIEW_CRYPTO_INTERFACE_EXPOSED)
        // Enum allowlist
        val ops = SosNativeTypedSigner.Op.values().map { it.name }.toSet()
        assertTrue(ops.contains("SIGN_CHAT_EVENT"))
        assertTrue(ops.contains("SIGN_CALL_GIFTWRAP"))
        assertFalse(ops.contains("SIGN_NOSTR_EVENT"))
    }

    @Test
    fun signingBenchmarkPass() {
        val eng = signer()
        val samples = ArrayList<Double>(1000)
        repeat(1000) {
            val ns = measureNanoTime {
                val r = eng.signChatEvent(
                    binding(),
                    SosNativeTypedSigner.ChatSignRequest(
                        content = "bench-$it",
                        recipientPubkey = "aa".repeat(32),
                    ),
                )
                assertTrue(r is SosNativeTypedSigner.SignResult.Ok)
            }
            samples.add(ns / 1_000_000.0)
        }
        samples.sort()
        fun pct(p: Int) = samples[((p / 100.0) * (samples.size - 1)).toInt()]
        val p50 = pct(50)
        val p95 = pct(95)
        val p99 = pct(99)
        // Local device crypto — generous bound for CI variance; correctness is primary.
        assertTrue("p99 too high: $p99", p99 < 500.0)
        System.setProperty("sos.f6b.sign.p50", p50.toString())
        System.setProperty("sos.f6b.sign.p95", p95.toString())
        System.setProperty("sos.f6b.sign.p99", p99.toString())
        println("F6B_SIGN_P50_MS=$p50")
        println("F6B_SIGN_P95_MS=$p95")
        println("F6B_SIGN_P99_MS=$p99")
    }
}
