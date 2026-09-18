package com.sos010.app

import fr.acinq.secp256k1.Hex
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SosNip44VectorTest {
    companion object {
        init {
            val dll = java.io.File("build/native/secp256k1-jni.dll")
            if (dll.exists()) System.load(dll.absolutePath)
        }
    }
    private val vectors: JSONObject by lazy {
        val text = javaClass.classLoader.getResourceAsStream("nip44.vectors.json")!!
            .bufferedReader().readText()
        JSONObject(text).getJSONObject("v2")
    }

    @Test
    fun conversationKeyVectorsPass() {
        val arr = vectors.getJSONObject("valid").getJSONArray("get_conversation_key")
        for (i in 0 until arr.length()) {
            val row = arr.getJSONObject(i)
            val key = SosNostrCrypto.nip44ConversationKey(row.getString("sec1"), row.getString("pub2"))
            assertTrue("row $i", key != null && Hex.encode(key) == row.getString("conversation_key"))
        }
    }

    @Test
    fun messageKeyVectorsPass() {
        val block = vectors.getJSONObject("valid").getJSONObject("get_message_keys")
        val conv = Hex.decode(block.getString("conversation_key"))
        val keys = block.getJSONArray("keys")
        for (i in 0 until keys.length()) {
            val row = keys.getJSONObject(i)
            val mk = SosNostrCrypto.nip44MessageKeys(conv, Hex.decode(row.getString("nonce")))
            assertEquals(row.getString("chacha_key"), Hex.encode(mk.chachaKey))
            assertEquals(row.getString("chacha_nonce"), Hex.encode(mk.chachaNonce))
            assertEquals(row.getString("hmac_key"), Hex.encode(mk.hmacKey))
        }
    }

    @Test
    fun decryptVectorsPass() {
        val arr = vectors.getJSONObject("valid").getJSONArray("encrypt_decrypt")
        for (i in 0 until arr.length()) {
            val row = arr.getJSONObject(i)
            val plain = SosNostrCrypto.nip44Decrypt(
                Hex.decode(row.getString("conversation_key")),
                row.getString("payload")
            )
            assertEquals(row.getString("plaintext"), plain)
            val again = SosNostrCrypto.nip44Encrypt(
                Hex.decode(row.getString("conversation_key")),
                row.getString("plaintext"),
                Hex.decode(row.getString("nonce"))
            )
            assertEquals(row.getString("payload"), again)
        }
    }

    @Test
    fun invalidMacAndPayloadFailClosed() {
        val arr = vectors.getJSONObject("invalid").getJSONArray("decrypt")
        var mac = 0
        var payload = 0
        for (i in 0 until arr.length()) {
            val row = arr.getJSONObject(i)
            val plain = SosNostrCrypto.nip44Decrypt(
                Hex.decode(row.getString("conversation_key")),
                row.getString("payload")
            )
            assertNull("row $i ${row.optString("note")}", plain)
            val note = row.optString("note")
            if (note.contains("MAC")) mac += 1
            if (note.contains("padding") || note.contains("payload") || note.contains("version") || note.contains("base64")) {
                payload += 1
            }
        }
        assertTrue(mac >= 1)
        assertTrue(payload >= 1)
    }

    @Test
    fun nativeDisconnectRoundtripMatchesPayload() {
        val sec1 = "0000000000000000000000000000000000000000000000000000000000000001"
        val sec2 = "0000000000000000000000000000000000000000000000000000000000000002"
        val pub1 = SosNostrCrypto.pubkeyFromPriv(sec1)
        val pub2 = SosNostrCrypto.pubkeyFromPriv(sec2)
        val session = "0123456789abcdef0123456789abcdef"
        val wrap = SosNativeCallVerifier.buildGiftWrap(sec2, pub1, "voice", "disconnect", session, null)
        org.junit.Assert.assertNotNull(wrap)
        org.junit.Assert.assertEquals(1059, wrap!!.optInt("kind"))
        val payload = SosNativeCallVerifier.testUnwrap(wrap, sec1, pub1)
        org.junit.Assert.assertNotNull(payload)
        org.junit.Assert.assertEquals("sos-call-signal", payload!!.getString("family"))
        org.junit.Assert.assertEquals("disconnect", payload.getString("action"))
        org.junit.Assert.assertEquals("voice", payload.getString("media"))
        org.junit.Assert.assertEquals(session, payload.getString("sessionId"))
        org.junit.Assert.assertEquals(pub2, payload.getString("sender"))
        org.junit.Assert.assertEquals(pub1, payload.getString("recipient"))
    }

    @Test
    fun invalidConversationKeyFailClosed() {
        val arr = vectors.getJSONObject("invalid").getJSONArray("get_conversation_key")
        for (i in 0 until arr.length()) {
            val row = arr.getJSONObject(i)
            assertNull(SosNostrCrypto.nip44ConversationKey(row.getString("sec1"), row.getString("pub2")))
        }
    }
}

