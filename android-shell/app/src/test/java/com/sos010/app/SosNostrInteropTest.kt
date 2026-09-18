package com.sos010.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class SosNostrInteropTest {
    companion object {
        init {
            val dll = File("build/native/secp256k1-jni.dll")
            if (dll.exists()) System.load(dll.absolutePath)
        }
    }

    @Test
    fun jsGiftWrapVerifiesInNativeAndNativeDisconnectUnwrapsInJs() {
        val results = JSONObject()
        fun mark(name: String, ok: Boolean) {
            results.put(name, if (ok) "PASS" else "FAIL")
            println(name + "=" + results.getString(name))
        }
        try {
            val root = repoRoot()
            val gen = runNode(root, listOf("node", "qa/gen-js-call-giftwrap-fixture.mjs"))
            assertEquals(gen.second, 0)
            val fixture = JSONObject(File(root, "qa/fixtures/js-call-giftwrap.json").readText(Charsets.UTF_8))
            val recipientPriv = fixture.getString("recipientPriv")
            val recipientPub = fixture.getString("recipientPub")

            checkLayer(fixture.getJSONObject("voiceOffer"), recipientPriv, "JS_OUTER", "JS_SEAL", "JS_RUMOR", results, ::mark)
            val voice = SosNativeCallVerifier.testUnwrap(
                fixture.getJSONObject("voiceOffer").getJSONObject("wrap"),
                recipientPriv,
                recipientPub
            )
            val voiceExpected = fixture.getJSONObject("voiceOffer").getJSONObject("expected")
            mark(
                "JS_VOICE_OFFER_NATIVE_UNWRAP",
                voice != null
                    && voice.getString("media") == "voice"
                    && voice.getString("action") == "offer"
                    && voice.getString("sessionId") == voiceExpected.getString("sessionId")
                    && voice.getString("data") == voiceExpected.getString("data")
                    && SosNativeCallVerifier.ringDisposition("offer") == "ring"
            )

            val video = SosNativeCallVerifier.testUnwrap(
                fixture.getJSONObject("videoOffer").getJSONObject("wrap"),
                recipientPriv,
                recipientPub
            )
            mark(
                "JS_VIDEO_OFFER_NATIVE_UNWRAP",
                video != null
                    && video.getString("media") == "video"
                    && video.getString("action") == "offer"
                    && SosNativeCallVerifier.ringDisposition("offer") == "ring"
            )

            val candidate = SosNativeCallVerifier.testDisposition(
                fixture.getJSONObject("candidate").getJSONObject("wrap"),
                recipientPriv,
                recipientPub
            )
            mark(
                "JS_CANDIDATE_AUTH_RING_ZERO",
                candidate == "ok:candidate" && SosNativeCallVerifier.ringDisposition("candidate") == "silent"
            )

            val disconnect = SosNativeCallVerifier.testDisposition(
                fixture.getJSONObject("disconnect").getJSONObject("wrap"),
                recipientPriv,
                recipientPub
            )
            mark(
                "JS_DISCONNECT_AUTH_RING_ZERO",
                disconnect == "ok:disconnect" && SosNativeCallVerifier.ringDisposition("disconnect") != "ring"
            )

            val wrap = JSONObject(fixture.getJSONObject("voiceOffer").getJSONObject("wrap").toString())
            val androidId = sha256Hex(androidSolidusSerialize(wrap))
            mark("ANDROID_SOLIDUS_ID_DIFFERS", !androidId.equals(wrap.getString("id"), true))
            mark(
                "CANONICAL_ID_STILL_MATCHES",
                SosNostrCrypto.nostrEventId(wrap).equals(wrap.getString("id"), true)
            )

            val badId = JSONObject(wrap.toString())
            val id = badId.getString("id")
            badId.put("id", id.dropLast(1) + if (id.last() == 'a') "b" else "a")
            mark(
                "ID_MISMATCH_KEPT",
                SosNostrCrypto.verifyEventDetailed(badId) == SosNostrCrypto.EventVerifyResult.EVENT_ID_MISMATCH
                    && SosNativeCallVerifier.testDisposition(badId, recipientPriv, recipientPub) == "keep"
            )

            val badSig = JSONObject(wrap.toString())
            val sig = badSig.getString("sig")
            badSig.put("sig", sig.dropLast(1) + if (sig.last() == 'a') "b" else "a")
            mark(
                "SCHNORR_INVALID_DROPPED",
                SosNostrCrypto.verifyEventDetailed(badSig) == SosNostrCrypto.EventVerifyResult.SCHNORR_INVALID
                    && SosNativeCallVerifier.testDisposition(badSig, recipientPriv, recipientPub).startsWith("drop:")
            )

            val sec1 = recipientPriv
            val sec2 = fixture.getString("senderPriv")
            val pub1 = SosNostrCrypto.pubkeyFromPriv(sec1)
            val pub2 = SosNostrCrypto.pubkeyFromPriv(sec2)
            val nativeWrap = SosNativeCallVerifier.buildGiftWrap(
                sec2,
                pub1,
                "voice",
                "disconnect",
                "0123456789abcdef0123456789abcdef",
                null
            )
            assertTrue(nativeWrap != null)
            val nativeFile = File(root, "qa/fixtures/native-disconnect-1059.json")
            nativeFile.writeText(
                JSONObject()
                    .put("wrap", nativeWrap)
                    .put("recipientPriv", sec1)
                    .put("recipientPub", pub1)
                    .put("senderPub", pub2)
                    .toString(),
                Charsets.UTF_8
            )
            val js = runNode(root, listOf("node", "qa/verify-native-disconnect.mjs", nativeFile.absolutePath))
            println(js.first)
            mark("NATIVE_DISCONNECT_JS_UNWRAP", js.second == 0 && js.first.contains("NATIVE_TO_JS_DISCONNECT=PASS"))
        } finally {
            val out = File(repoRoot(), "qa/fixtures/interop-results.json")
            out.parentFile.mkdirs()
            out.writeText(results.toString(2), Charsets.UTF_8)
        }
        val names = results.names()
        val failed = if (names == null) {
            listOf("NO_RESULTS")
        } else {
            (0 until names.length()).map { names.getString(it) }.filter { results.getString(it) != "PASS" }
        }
        assertEquals(emptyList<String>(), failed)
    }

    private fun checkLayer(
        block: JSONObject,
        recipientPriv: String,
        outerPrefix: String,
        sealPrefix: String,
        rumorPrefix: String,
        results: JSONObject,
        mark: (String, Boolean) -> Unit
    ) {
        val wrap = block.getJSONObject("wrap")
        val seal = block.getJSONObject("seal")
        val rumor = block.getJSONObject("rumor")
        val wrapIdOk = SosNostrCrypto.nostrEventId(wrap).equals(wrap.getString("id"), true)
        val wrapVerify = SosNostrCrypto.verifyEventDetailed(wrap)
        mark(outerPrefix + "_ID_NATIVE_MATCH", wrapIdOk)
        mark(outerPrefix + "_SCHNORR_NATIVE", wrapVerify == SosNostrCrypto.EventVerifyResult.VALID)
        val self = SosNostrCrypto.pubkeyFromPriv(recipientPriv)
        val outerPlain = SosNostrCrypto.nip44Decrypt(
            SosNostrCrypto.nip44ConversationKey(recipientPriv, wrap.getString("pubkey"))!!,
            wrap.getString("content")
        )
        mark(outerPrefix + "_NIP44_NATIVE", outerPlain != null && outerPlain.contains("\"kind\":13"))
        val sealIdOk = SosNostrCrypto.nostrEventId(seal).equals(seal.getString("id"), true)
        val sealVerify = SosNostrCrypto.verifyEventDetailed(seal)
        mark(sealPrefix + "_ID_NATIVE_MATCH", sealIdOk)
        mark(sealPrefix + "_SCHNORR_NATIVE", sealVerify == SosNostrCrypto.EventVerifyResult.VALID)
        val sealPlain = SosNostrCrypto.nip44Decrypt(
            SosNostrCrypto.nip44ConversationKey(recipientPriv, seal.getString("pubkey"))!!,
            seal.getString("content")
        )
        mark(sealPrefix + "_NIP44_NATIVE", sealPlain != null && sealPlain.contains("25050"))
        mark(rumorPrefix + "_ID_NATIVE_MATCH", SosNostrCrypto.nostrEventId(rumor).equals(rumor.getString("id"), true))
        assertEquals(self, block.getJSONObject("expected").getString("recipient"))
    }

    private fun androidSolidusSerialize(event: JSONObject): String {
        val canonical = SosNostrCrypto.canonicalNostrEventSerialization(
            event.getString("pubkey"),
            event.getLong("created_at"),
            event.getInt("kind"),
            event.getJSONArray("tags"),
            event.getString("content")
        )
        return canonical.replace("/", "\\/")
    }

    private fun sha256Hex(text: String): String {
        val dig = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        return dig.joinToString("") { "%02x".format(it) }
    }

    private fun repoRoot(): File {
        var dir = File(".").absoluteFile
        repeat(8) {
            if (File(dir, "qa/gen-js-call-giftwrap-fixture.mjs").isFile) return dir
            dir = dir.parentFile ?: error("repo root missing")
        }
        error("repo root missing from " + File(".").absolutePath)
    }

    private fun runNode(root: File, command: List<String>): Pair<String, Int> {
        val proc = ProcessBuilder(command)
            .directory(root)
            .redirectErrorStream(true)
            .start()
        val text = proc.inputStream.bufferedReader().readText()
        return text to proc.waitFor()
    }
}
