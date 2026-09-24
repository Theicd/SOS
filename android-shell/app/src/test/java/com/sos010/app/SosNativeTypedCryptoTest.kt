package com.sos010.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import kotlin.system.measureNanoTime

/**
 * F6F — SosNativeTypedCrypto unit tests.
 */
class SosNativeTypedCryptoTest {
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
    private lateinit var peerPriv: String
    private lateinit var peerPub: String

    private fun derive(hex: String): String = SosNostrCrypto.pubkeyFromPriv(hex)

    private fun identityEngine(): SosSecureIdentityStore.Engine =
        SosSecureIdentityStore.engineForTests(
            prefs = prefs,
            crypto = storeCrypto,
            derivePubkey = ::derive,
            legacyReader = { "" to "" },
        )

    private fun binding(cap: String = "cap") =
        SosNativeTypedSigner.SessionBinding(
            sessionGeneration = 1L,
            accountPubkey = pubHex,
            sessionCapability = cap,
        )

    private fun crypto(
        gate: SosNativeTypedSigner.SessionAuthorityGate = SosNativeTypedSigner.TestPermissiveSessionGate,
    ): SosNativeTypedCrypto.Engine =
        SosNativeTypedCrypto.engineForTests(identity = identityEngine(), sessionGate = gate)

    @Before
    fun setUp() {
        prefs = SosSecureIdentityStore.MemoryPrefsBackend()
        storeCrypto = SosSecureIdentityStore.SoftAesGcmCrypto()
        privHex = "0000000000000000000000000000000000000000000000000000000000000001"
        pubHex = SosNostrCrypto.pubkeyFromPriv(privHex)
        peerPriv = "0000000000000000000000000000000000000000000000000000000000000002"
        peerPub = SosNostrCrypto.pubkeyFromPriv(peerPriv)
        assertTrue(identityEngine().writeIdentitySameAccount(privHex, pubHex) is SosSecureIdentityStore.WriteResult.Ok)
    }

    @Test
    fun chatEncryptDecryptRoundtrip() {
        val c = crypto()
        val plain = """{"text":"hello","sender":"$pubHex","recipient":"$peerPub"}"""
        val enc = c.chatEncrypt(binding(), peerPub, plain)
        assertTrue(enc is SosNativeTypedCrypto.CryptoResult.Ok)
        val env = (enc as SosNativeTypedCrypto.CryptoResult.Ok).value
        assertEquals("sos-e2ee", env.getString("family"))
        assertEquals("nip44", env.getString("alg"))
        assertFalse(env.has("conversationKey") || env.has("privateKey") || env.has("k"))
        val dec = c.chatDecrypt(binding(), peerPub, env.getString("ct"))
        assertTrue(dec is SosNativeTypedCrypto.CryptoResult.Ok)
        assertEquals(plain, (dec as SosNativeTypedCrypto.CryptoResult.Ok).value.getString("plaintext"))
    }

    @Test
    fun wrongPeerDecryptFails() {
        val c = crypto()
        val enc = c.chatEncrypt(binding(), peerPub, "secret") as SosNativeTypedCrypto.CryptoResult.Ok
        val other = SosNostrCrypto.pubkeyFromPriv("0000000000000000000000000000000000000000000000000000000000000003")
        val dec = c.chatDecrypt(binding(), other, enc.value.getString("ct"))
        assertEquals("DECRYPT_FAILED", (dec as SosNativeTypedCrypto.CryptoResult.Err).code)
    }

    @Test
    fun malformedPeerRejected() {
        val r = crypto().chatEncrypt(binding(), "not-a-key", "x")
        assertEquals("MALFORMED_PEER_PUBKEY", (r as SosNativeTypedCrypto.CryptoResult.Err).code)
    }

    @Test
    fun tamperedCiphertextFails() {
        val c = crypto()
        val enc = c.chatEncrypt(binding(), peerPub, "secret") as SosNativeTypedCrypto.CryptoResult.Ok
        val ct = enc.value.getString("ct")
        val tampered = ct.dropLast(4) + "AAAA"
        val dec = c.chatDecrypt(binding(), peerPub, tampered)
        assertEquals("DECRYPT_FAILED", (dec as SosNativeTypedCrypto.CryptoResult.Err).code)
    }

    @Test
    fun revokedSessionEncryptReject() {
        val gate = SosNativeTypedSigner.SessionAuthorityGate { _, _, _ ->
            SosNativeTypedSigner.CheckResult.Err("SESSION_REVOKED")
        }
        val r = crypto(gate).chatEncrypt(binding(), peerPub, "x")
        assertEquals("SESSION_REVOKED", (r as SosNativeTypedCrypto.CryptoResult.Err).code)
    }

    @Test
    fun revokedSessionDecryptReject() {
        val gate = SosNativeTypedSigner.SessionAuthorityGate { _, _, _ ->
            SosNativeTypedSigner.CheckResult.Err("SESSION_REVOKED")
        }
        val r = crypto(gate).chatDecrypt(binding(), peerPub, "AAAA")
        assertEquals("SESSION_REVOKED", (r as SosNativeTypedCrypto.CryptoResult.Err).code)
    }

    @Test
    fun p2pSignalRoundtripNip04() {
        val c = crypto()
        // NIP04 ciphertext is for the recipient — encrypt to self for roundtrip as identity holder.
        val enc = c.p2pSignalEncrypt(binding(), pubHex, """{"type":"dc-offer"}""")
        assertTrue("enc=" + enc, enc is SosNativeTypedCrypto.CryptoResult.Ok)
        val ct = (enc as SosNativeTypedCrypto.CryptoResult.Ok).value.getString("ciphertext")
        assertEquals("nip04", enc.value.getString("alg"))
        val dec = c.p2pSignalDecrypt(binding(), pubHex, ct)
        assertTrue("dec=" + dec, dec is SosNativeTypedCrypto.CryptoResult.Ok)
        assertEquals(
            """{"type":"dc-offer"}""",
            (dec as SosNativeTypedCrypto.CryptoResult.Ok).value.getString("plaintext"),
        )
    }

    @Test
    fun callSignalRoundtrip() {
        val c = crypto()
        val enc = c.callSignalEncrypt(binding(), peerPub, """{"action":"offer"}""") as SosNativeTypedCrypto.CryptoResult.Ok
        val dec = c.callSignalDecrypt(binding(), peerPub, enc.value.getString("ciphertext"))
        assertEquals(
            """{"action":"offer"}""",
            (dec as SosNativeTypedCrypto.CryptoResult.Ok).value.getString("plaintext"),
        )
    }

    @Test
    fun fileKeyWrapUnwrap() {
        val c = crypto()
        val wrap = c.fileKeyWrap(binding(), peerPub, "AES_FILE_KEY_MATERIAL") as SosNativeTypedCrypto.CryptoResult.Ok
        assertFalse(wrap.value.toString().contains(privHex))
        val unwrap = c.fileKeyUnwrap(binding(), peerPub, wrap.value.getString("ciphertext"))
        assertEquals(
            "AES_FILE_KEY_MATERIAL",
            (unwrap as SosNativeTypedCrypto.CryptoResult.Ok).value.getString("keyMaterial"),
        )
    }

    @Test
    fun giftwrapWrongKindRejected() {
        val wrap = JSONObject().put("kind", 1).put("content", "x").put("pubkey", peerPub)
            .put("tags", JSONArray()).put("id", "ab".repeat(32)).put("sig", "cd".repeat(64))
        val r = crypto().callGiftwrapUnwrap(binding(), wrap)
        assertEquals("INVALID_GIFTWRAP_KIND", (r as SosNativeTypedCrypto.CryptoResult.Err).code)
    }

    @Test
    fun giftwrapWrongRecipientRejected() {
        val third = SosNostrCrypto.pubkeyFromPriv("0000000000000000000000000000000000000000000000000000000000000003")
        val wrap = SosNativeCallVerifier.buildGiftWrap(
            privHex = peerPriv,
            recipientPub = third, // not self (pubHex)
            media = "voice",
            action = "offer",
            sessionId = "s1",
            data = null,
        )
        assertTrue("wrap null", wrap != null)
        val r = crypto().callGiftwrapUnwrap(binding(), wrap!!)
        assertTrue("expected Err, got $r", r is SosNativeTypedCrypto.CryptoResult.Err)
        assertEquals("WRONG_RECIPIENT", (r as SosNativeTypedCrypto.CryptoResult.Err).code)
    }

    @Test
    fun giftwrapValidUnwrap() {
        val wrap = SosNativeCallVerifier.buildGiftWrap(
            privHex = peerPriv,
            recipientPub = pubHex,
            media = "voice",
            action = "offer",
            sessionId = "sess-1",
            data = JSONObject().put("sdp", "v=0"),
        )
        assertTrue(wrap != null)
        val r = crypto().callGiftwrapUnwrap(binding(), wrap!!)
        assertTrue(r is SosNativeTypedCrypto.CryptoResult.Ok)
        val payload = (r as SosNativeTypedCrypto.CryptoResult.Ok).value
        assertEquals("offer", payload.getString("action"))
        assertEquals("voice", payload.getString("media"))
        assertFalse(payload.has("conversationKey") || payload.has("privateKey"))
    }

    @Test
    fun noGenericApis() {
        val c = crypto()
        assertEquals("GENERIC_ENCRYPT_UNAVAILABLE", (c.rejectGenericEncrypt() as SosNativeTypedCrypto.CryptoResult.Err).code)
        assertEquals("GENERIC_DECRYPT_UNAVAILABLE", (c.rejectGenericDecrypt() as SosNativeTypedCrypto.CryptoResult.Err).code)
        assertEquals("CONVERSATION_KEY_UNAVAILABLE", (c.rejectConversationKey() as SosNativeTypedCrypto.CryptoResult.Err).code)
        assertFalse(SosNativeTypedCrypto.GENERIC_NATIVE_ENCRYPT_API)
        assertFalse(SosNativeTypedCrypto.GENERIC_CONVERSATION_KEY_API)
        assertFalse(SosNativeTypedCrypto.CALLER_SUPPLIED_PRIVATE_KEY_ACCEPTED)
        assertTrue(SosNativeTypedCrypto.F6F_TYPED_CRYPTO_ALLOWLIST_PRESENT)
        assertEquals("v2", SosNativeTypedCrypto.NIP44_VERSION_USED)
        assertFalse(SosNativeTypedCrypto.NIP44_PROTOCOL_CHANGED)
        assertTrue(SosNativeTypedCrypto.NIP04_RUNTIME_REQUIRED)
        assertFalse(SosNativeTypedCrypto.RAW_FILE_KEY_OVER_DC)
        assertFalse(SosNativeTypedCrypto.P2P_BULK_DATA_PATH_CHANGED)
    }

    @Test
    fun oversizedInputRejected() {
        val big = "x".repeat(SosNativeTypedCrypto.MAX_PLAINTEXT_CHARS + 1)
        val r = crypto().chatEncrypt(binding(), peerPub, big)
        assertEquals("OVERSIZED_OR_EMPTY_PLAINTEXT", (r as SosNativeTypedCrypto.CryptoResult.Err).code)
    }

    @Test
    fun nip44Benchmark1000() {
        val c = crypto()
        val plain = "benchmark-payload"
        // warmup
        repeat(20) {
            val e = c.chatEncrypt(binding(), peerPub, plain) as SosNativeTypedCrypto.CryptoResult.Ok
            c.chatDecrypt(binding(), peerPub, e.value.getString("ct"))
        }
        val encNs = LongArray(1000)
        val decNs = LongArray(1000)
        for (i in 0 until 1000) {
            var ct = ""
            encNs[i] = measureNanoTime {
                val e = c.chatEncrypt(binding(), peerPub, plain) as SosNativeTypedCrypto.CryptoResult.Ok
                ct = e.value.getString("ct")
            }
            decNs[i] = measureNanoTime {
                c.chatDecrypt(binding(), peerPub, ct)
            }
        }
        fun pct(arr: LongArray, p: Double): Double {
            val sorted = arr.sorted()
            return sorted[(p * (sorted.size - 1)).toInt()] / 1_000_000.0
        }
        val ep50 = pct(encNs, 0.50)
        val ep95 = pct(encNs, 0.95)
        val ep99 = pct(encNs, 0.99)
        val dp50 = pct(decNs, 0.50)
        val dp95 = pct(decNs, 0.95)
        val dp99 = pct(decNs, 0.99)
        println("NIP44_ENCRYPT_P50_MS=$ep50")
        println("NIP44_ENCRYPT_P95_MS=$ep95")
        println("NIP44_ENCRYPT_P99_MS=$ep99")
        println("NIP44_DECRYPT_P50_MS=$dp50")
        println("NIP44_DECRYPT_P95_MS=$dp95")
        println("NIP44_DECRYPT_P99_MS=$dp99")
        assertTrue("encrypt p99 too slow $ep99", ep99 < 200.0)
        assertTrue("decrypt p99 too slow $dp99", dp99 < 200.0)
    }

    @Test
    fun bridgeOverheadBenchmark() {
        val signer = SosNativeTypedSigner.engineForTests(identity = identityEngine())
        val typed = crypto()
        val bridge = SosNativeTypedBridge.engineForTests(
            signer = signer,
            typedCrypto = typed,
            requireSessionBinding = false,
        )
        val times = LongArray(200)
        for (i in 0 until 200) {
            times[i] = measureNanoTime {
                bridge.dispatch(
                    JSONObject()
                        .put("v", 1)
                        .put("op", "CHAT_ENCRYPT")
                        .put("requestId", "bench-$i")
                        .put("sessionCapability", "x")
                        .put(
                            "params",
                            JSONObject().put("plaintext", "hi").put("recipientPubkey", peerPub),
                        )
                        .toString(),
                )
            }
        }
        times.sort()
        fun pct(p: Double) = times[(p * (times.size - 1)).toInt()] / 1_000_000.0
        val p50 = pct(0.50)
        val p95 = pct(0.95)
        val p99 = pct(0.99)
        println("F6F_BRIDGE_P50_MS=$p50")
        println("F6F_BRIDGE_P95_MS=$p95")
        println("F6F_BRIDGE_P99_MS=$p99")
        assertTrue("bridge p99 too slow $p99", p99 < 250.0)
    }
}
