package com.sos010.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import kotlin.system.measureNanoTime

/**
 * F6C — SosNativeTypedBridge unit tests (disposable identities only).
 */
class SosNativeTypedBridgeTest {
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

    private fun identityEngine(): SosSecureIdentityStore.Engine =
        SosSecureIdentityStore.engineForTests(
            prefs = prefs,
            crypto = storeCrypto,
            derivePubkey = { SosNostrCrypto.pubkeyFromPriv(it) },
        )

    private fun bridge(trusted: Boolean = true): SosNativeTypedBridge.Engine =
        SosNativeTypedBridge.engineForTests(
            signer = SosNativeTypedSigner.engineForTests(
                identity = identityEngine(),
                nowSec = { now },
            ),
            trusted = trusted,
            nowSec = { now },
            requireSessionBinding = false,
        )

    private fun bridgeWithSession(): Pair<SosNativeTypedBridge.Engine, String> {
        val auth = SosNativeSessionAuthority.engineForTests(pubHex)
        val bound = auth.bind(1L, pubHex) as SosNativeSessionAuthority.BindResult.Ok
        val eng = SosNativeTypedBridge.engineForTests(
            signer = SosNativeTypedSigner.engineForTests(
                identity = identityEngine(),
                sessionGate = SosNativeTypedSigner.F6dSessionGate { auth },
                nowSec = { now },
            ),
            trusted = true,
            nowSec = { now },
            sessionAuthority = auth,
            requireSessionBinding = true,
        )
        return eng to bound.capability
    }

    private fun req(op: String, params: JSONObject, requestId: String = "r1", capability: String = ""): String {
        val o = JSONObject()
            .put("v", SosNativeTypedBridge.PROTOCOL_VERSION)
            .put("op", op)
            .put("requestId", requestId)
            .put("sessionGeneration", 1L)
            .put("accountPubkey", pubHex)
            .put("params", params)
        if (capability.isNotEmpty()) o.put("sessionCapability", capability)
        return o.toString()
    }

    @Before
    fun setUp() {
        prefs = SosSecureIdentityStore.MemoryPrefsBackend()
        storeCrypto = SosSecureIdentityStore.SoftAesGcmCrypto()
        privHex = "0000000000000000000000000000000000000000000000000000000000000001"
        pubHex = SosNostrCrypto.pubkeyFromPriv(privHex)
        assertTrue(identityEngine().writeIdentitySameAccount(privHex, pubHex) is SosSecureIdentityStore.WriteResult.Ok)
    }

    @Test
    fun validChatRequest() {
        val r = bridge().dispatch(
            req(
                "SIGN_CHAT_EVENT",
                JSONObject().put("content", "hi").put("recipientPubkey", "aa".repeat(32)),
            ),
        )
        assertTrue(r.ok)
        val body = JSONObject(r.json)
        assertTrue(body.getBoolean("ok"))
        val ev = body.getJSONObject("result")
        assertEquals(1050, ev.getInt("kind"))
        assertEquals(pubHex, ev.getString("pubkey").lowercase())
        assertFalse(ev.has("privkey") || ev.has("privateKey") || ev.has("nsec"))
        assertTrue(SosNostrCrypto.verifyEvent(ev))
    }

    @Test
    fun validCallSealGiftwrapPresenceReadReceipt() {
        val b = bridge()
        assertTrue(
            b.dispatch(
                req("SIGN_CALL_SEAL", JSONObject().put("content", "seal"), "seal1"),
            ).ok,
        )
        assertTrue(
            b.dispatch(
                req(
                    "SIGN_CALL_GIFTWRAP",
                    JSONObject().put("content", "wrap").put("recipientPubkey", "bb".repeat(32)),
                    "wrap1",
                ),
            ).ok,
        )
        assertTrue(
            b.dispatch(
                req(
                    "SIGN_PRESENCE_EVENT",
                    JSONObject().put("content", "{}").put("recipientPubkey", "cc".repeat(32)),
                    "pres1",
                ),
            ).ok,
        )
        assertTrue(
            b.dispatch(
                req(
                    "SIGN_READ_RECEIPT_EVENT",
                    JSONObject()
                        .put("content", "{}")
                        .put("recipientPubkey", "dd".repeat(32))
                        .put("eventIdTag", "ee".repeat(32)),
                    "rr1",
                ),
            ).ok,
        )
    }

    @Test
    fun unknownOperationRejected() {
        val r = bridge().dispatch(req("SIGN_ARBITRARY", JSONObject().put("content", "x"), "u1"))
        assertFalse(r.ok)
        assertEquals("UNSUPPORTED_OPERATION", JSONObject(r.json).getString("errorCode"))
    }

    @Test
    fun malformedJsonRejected() {
        val r = bridge().dispatch("{not-json")
        assertEquals("MALFORMED_JSON", r.code)
    }

    @Test
    fun oversizedRejected() {
        val big = "a".repeat(SosNativeTypedBridge.MAX_REQUEST_CHARS + 10)
        val r = bridge().dispatch(big)
        assertEquals("OVERSIZED_REQUEST", r.code)
    }

    @Test
    fun duplicateRequestIdSafe() {
        val body = req(
            "SIGN_CHAT_EVENT",
            JSONObject().put("content", "a").put("recipientPubkey", "aa".repeat(32)),
            "dup-id",
        )
        val b = bridge()
        assertTrue(b.dispatch(body).ok)
        val second = b.dispatch(body)
        assertFalse(second.ok)
        assertEquals("DUPLICATE_REQUEST_ID", JSONObject(second.json).getString("errorCode"))
    }

    @Test
    fun unexpectedFieldsRejected() {
        val raw = JSONObject()
            .put("v", 1)
            .put("op", "SIGN_CHAT_EVENT")
            .put("requestId", "uf1")
            .put("evil", true)
            .put("params", JSONObject().put("content", "x").put("recipientPubkey", "aa".repeat(32)))
            .toString()
        val r = bridge().dispatch(raw)
        assertEquals("UNEXPECTED_FIELD", JSONObject(r.json).getString("errorCode"))
    }

    @Test
    fun untrustedContextRejected() {
        val r = bridge(trusted = false).dispatch(
            req(
                "SIGN_CHAT_EVENT",
                JSONObject().put("content", "x").put("recipientPubkey", "aa".repeat(32)),
                "t1",
            ),
        )
        assertEquals("UNTRUSTED_CONTEXT", r.code)
    }

    @Test
    fun unknownVersionRejected() {
        val raw = JSONObject()
            .put("v", 99)
            .put("op", "SIGN_CHAT_EVENT")
            .put("requestId", "v99")
            .put("params", JSONObject().put("content", "x").put("recipientPubkey", "aa".repeat(32)))
            .toString()
        assertEquals("UNSUPPORTED_VERSION", JSONObject(bridge().dispatch(raw).json).getString("errorCode"))
    }

    @Test
    fun noRawKOrNsecInResponseOrCapabilities() {
        val caps = JSONObject(bridge().capabilitiesJson())
        assertFalse(caps.optBoolean("returnsPrivateKey", true))
        assertFalse(caps.optBoolean("returnsNsec", true))
        assertFalse(caps.optBoolean("genericSign", true))
        assertFalse(caps.optBoolean("genericDecrypt", true))
        val r = bridge().dispatch(
            req(
                "SIGN_CHAT_EVENT",
                JSONObject().put("content", "z").put("recipientPubkey", "aa".repeat(32)),
                "nk1",
            ),
        )
        assertFalse(r.json.contains("privkey") || r.json.contains("nsec") || r.json.contains("\"k\""))
    }

    @Test
    fun trustedUrlHelper() {
        assertTrue(SosNativeTypedBridge.isTrustedWebViewUrl("https://sos010.com/videos.html"))
        assertTrue(SosNativeTypedBridge.isTrustedWebViewUrl("file:///android_asset/secure-call-verifier/index.html"))
        assertFalse(SosNativeTypedBridge.isTrustedWebViewUrl("https://evil.example/"))
        assertFalse(SosNativeTypedBridge.isTrustedWebViewUrl("http://sos010.com/"))
    }

    @Test
    fun bridgeDispatchBenchmark() {
        val b = bridge()
        val samples = ArrayList<Double>(1000)
        repeat(1000) { i ->
            val ns = measureNanoTime {
                val r = b.dispatch(
                    req(
                        "SIGN_CHAT_EVENT",
                        JSONObject().put("content", "b$i").put("recipientPubkey", "aa".repeat(32)),
                        "bench-$i",
                    ),
                )
                assertTrue(r.ok)
            }
            samples.add(ns / 1_000_000.0)
        }
        samples.sort()
        fun pct(p: Int) = samples[((p / 100.0) * (samples.size - 1)).toInt()]
        val p50 = pct(50)
        val p95 = pct(95)
        val p99 = pct(99)
        assertTrue("p99 too high: $p99", p99 < 500.0)
        println("F6C_BRIDGE_DISPATCH_P50_MS=$p50")
        println("F6C_BRIDGE_DISPATCH_P95_MS=$p95")
        println("F6C_BRIDGE_DISPATCH_P99_MS=$p99")
    }

    @Test
    fun f6dValidBindingTypedOpPasses() {
        val (eng, cap) = bridgeWithSession()
        val r = eng.dispatch(
            req(
                "SIGN_CHAT_EVENT",
                JSONObject().put("content", "hi").put("recipientPubkey", "aa".repeat(32)),
                "f6d-ok",
                capability = cap,
            ),
        )
        assertTrue(r.ok)
    }

    @Test
    fun f6dMissingBindingRejected() {
        val (eng, _) = bridgeWithSession()
        val r = eng.dispatch(
            req(
                "SIGN_CHAT_EVENT",
                JSONObject().put("content", "hi").put("recipientPubkey", "aa".repeat(32)),
                "f6d-miss",
            ),
        )
        assertFalse(r.ok)
        assertEquals("SESSION_REQUIRED", JSONObject(r.json).getString("errorCode"))
    }

    @Test
    fun f6dRevokedBindingRejected() {
        val auth = SosNativeSessionAuthority.engineForTests(pubHex)
        val bound = auth.bind(1L, pubHex) as SosNativeSessionAuthority.BindResult.Ok
        val eng = SosNativeTypedBridge.engineForTests(
            signer = SosNativeTypedSigner.engineForTests(
                identity = identityEngine(),
                sessionGate = SosNativeTypedSigner.F6dSessionGate { auth },
                nowSec = { now },
            ),
            sessionAuthority = auth,
            requireSessionBinding = true,
            nowSec = { now },
        )
        auth.revoke("logout")
        val r = eng.dispatch(
            req(
                "SIGN_CHAT_EVENT",
                JSONObject().put("content", "hi").put("recipientPubkey", "aa".repeat(32)),
                "f6d-rev",
                capability = bound.capability,
            ),
        )
        assertEquals("SESSION_REQUIRED", JSONObject(r.json).getString("errorCode"))
    }

    @Test
    fun f6dOldCapabilityRejected() {
        val auth = SosNativeSessionAuthority.engineForTests(pubHex)
        val old = auth.bind(1L, pubHex) as SosNativeSessionAuthority.BindResult.Ok
        val newer = auth.bind(2L, pubHex, previousCapability = old.capability) as SosNativeSessionAuthority.BindResult.Ok
        val eng = SosNativeTypedBridge.engineForTests(
            signer = SosNativeTypedSigner.engineForTests(
                identity = identityEngine(),
                sessionGate = SosNativeTypedSigner.F6dSessionGate { auth },
                nowSec = { now },
            ),
            sessionAuthority = auth,
            requireSessionBinding = true,
            nowSec = { now },
        )
        val r = eng.dispatch(
            req(
                "SIGN_CHAT_EVENT",
                JSONObject().put("content", "hi").put("recipientPubkey", "aa".repeat(32)),
                "f6d-old",
                capability = old.capability,
            ),
        )
        assertEquals("SESSION_REVOKED", JSONObject(r.json).getString("errorCode"))
        assertTrue(
            eng.dispatch(
                req(
                    "SIGN_CHAT_EVENT",
                    JSONObject().put("content", "hi").put("recipientPubkey", "aa".repeat(32)),
                    "f6d-new",
                    capability = newer.capability,
                ),
            ).ok,
        )
    }
}
