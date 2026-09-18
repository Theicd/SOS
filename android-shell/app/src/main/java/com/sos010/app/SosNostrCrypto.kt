package com.sos010.app

import android.util.Base64
import android.util.Log
import fr.acinq.secp256k1.Hex
import fr.acinq.secp256k1.Secp256k1
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * קריפטו Nostr מינימלי לסיגנלינג P2P Native (nip04 + חתימת אירוע).
 * NIP-04 AES key = X-coordinate של נקודת ECDH (בלי SHA-256) – כמו nostr-tools.
 */
object SosNostrCrypto {
    private const val TAG = "SosNostrCrypto"
    private val secp: Secp256k1 by lazy { Secp256k1.get() }
    private val rnd = SecureRandom()

    fun isHex64(s: String?): Boolean = !s.isNullOrBlank() && s.trim().matches(Regex("^[0-9a-fA-F]{64}$"))

    fun pubkeyFromPriv(privHex: String): String {
        val priv = Hex.decode(privHex.lowercase())
        val pub = secp.pubKeyCompress(secp.pubkeyCreate(priv))
        // compressed 33 bytes → x-only 32 for nostr
        return Hex.encode(pub.copyOfRange(1, 33))
    }

    fun nip04Encrypt(privHex: String, peerPubHex: String, plaintext: String): String {
        val key = sharedKey(privHex, peerPubHex)
        val iv = ByteArray(16).also { rnd.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        val enc = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(enc, Base64.NO_WRAP) + "?iv=" + Base64.encodeToString(iv, Base64.NO_WRAP)
    }

    fun nip04Decrypt(privHex: String, peerPubHex: String, content: String): String? {
        return try {
            val parts = content.split("?iv=")
            if (parts.size != 2) {
                Log.w(TAG, "nip04 bad format (no iv)")
                return null
            }
            val data = Base64.decode(parts[0], Base64.DEFAULT)
            val iv = Base64.decode(parts[1], Base64.DEFAULT)
            if (iv.size != 16) {
                Log.w(TAG, "nip04 bad iv size=${iv.size}")
                return null
            }
            val key = sharedKey(privHex, peerPubHex)
            val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
            String(cipher.doFinal(data), Charsets.UTF_8)
        } catch (err: Exception) {
            Log.w(TAG, "nip04 decrypt fail: ${err.message}")
            null
        }
    }

    fun signEvent(privHex: String, kind: Int, tags: JSONArray, content: String, createdAt: Long = System.currentTimeMillis() / 1000L): JSONObject {
        val pubkey = pubkeyFromPriv(privHex)
        val event = JSONObject()
            .put("kind", kind)
            .put("pubkey", pubkey)
            .put("created_at", createdAt)
            .put("tags", tags)
            .put("content", content)
        val id = eventId(pubkey, createdAt, kind, tags, content)
        event.put("id", id)
        val sig = Hex.encode(secp.signSchnorr(Hex.decode(id), Hex.decode(privHex.lowercase()), null))
        event.put("sig", sig)
        return event
    }

    /**
     * תואם nostr-tools / NIP-04:
     * shared = priv * (02||peerX) → AES key = X (32 בתים), בלי hash.
     */
    private fun sharedKey(privHex: String, peerPubHex: String): ByteArray {
        val priv = Hex.decode(privHex.lowercase())
        val xOnly = Hex.decode(peerPubHex.lowercase())
        require(priv.size == 32) { "priv must be 32 bytes" }
        require(xOnly.size == 32) { "peer pub x-only must be 32 bytes" }

        // כמו nostr-tools: תמיד prefix 02 | HYPER CORE TECH
        val pub02 = ByteArray(33).also {
            it[0] = 0x02
            System.arraycopy(xOnly, 0, it, 1, 32)
        }

        // ecdh() של acinq מחזיר SHA256 – לא תואם NIP-04.
        // pubKeyTweakMul(peerPub, priv) = נקודת ECDH; לוקחים את X. | HYPER CORE TECH
        val peerParsed = secp.pubkeyParse(pub02)
        val sharedPoint = secp.pubKeyTweakMul(peerParsed, priv)
        val compressed = if (sharedPoint.size == 33) {
            sharedPoint
        } else {
            secp.pubKeyCompress(sharedPoint)
        }
        require(compressed.size == 33) { "shared point compress failed size=${compressed.size}" }
        return compressed.copyOfRange(1, 33)
    }

    enum class EventVerifyResult {
        VALID,
        BAD_FORMAT,
        EVENT_ID_MISMATCH,
        SCHNORR_INVALID,
        SCHNORR_EXCEPTION
    }

    /**
     * NIP-01 canonical form. Must match nostr-tools JSON.stringify.
     * Do not use JSONArray.toString(): Android org.json escapes '/' and
     * NIP-44 ciphertext contains '/'. That mismatch is outer-sig on device.
     */
    fun canonicalNostrEventSerialization(
        pubkey: String,
        createdAt: Long,
        kind: Int,
        tags: JSONArray,
        content: String
    ): String {
        return buildString {
            append("[0,")
            append(jsonString(pubkey))
            append(',')
            append(createdAt.toString())
            append(',')
            append(kind.toString())
            append(',')
            append(jsonValue(tags))
            append(',')
            append(jsonString(content))
            append(']')
        }
    }

    fun nostrEventId(event: JSONObject): String {
        val tags = event.optJSONArray("tags") ?: JSONArray()
        return eventId(
            event.optString("pubkey"),
            event.optLong("created_at"),
            event.optInt("kind"),
            tags,
            event.optString("content")
        )
    }

    private fun eventId(pubkey: String, createdAt: Long, kind: Int, tags: JSONArray, content: String): String {
        val canonical = canonicalNostrEventSerialization(pubkey, createdAt, kind, tags, content)
        return Hex.encode(sha256(canonical.toByteArray(Charsets.UTF_8)))
    }

    fun verifyEvent(event: JSONObject): Boolean = verifyEventDetailed(event) == EventVerifyResult.VALID

    fun verifyEventDetailed(event: JSONObject): EventVerifyResult {
        val id = event.optString("id").lowercase()
        val pubkey = event.optString("pubkey").lowercase()
        val sig = event.optString("sig").lowercase()
        if (!event.has("kind") || !event.has("created_at") || event.opt("content") !is String) {
            return EventVerifyResult.BAD_FORMAT
        }
        val tags = event.optJSONArray("tags") ?: return EventVerifyResult.BAD_FORMAT
        val kind = event.optInt("kind")
        val createdAt = event.optLong("created_at", -1L)
        val content = event.getString("content")
        if (!isHex64(id) || !isHex64(pubkey) || !sig.matches(Regex("^[0-9a-f]{128}$")) || createdAt < 0L) {
            return EventVerifyResult.BAD_FORMAT
        }
        val expect = try {
            eventId(pubkey, createdAt, kind, tags, content)
        } catch (_: Exception) {
            return EventVerifyResult.BAD_FORMAT
        }
        if (!expect.equals(id, ignoreCase = true)) return EventVerifyResult.EVENT_ID_MISMATCH
        return try {
            val ok = secp.verifySchnorr(Hex.decode(sig), Hex.decode(expect), Hex.decode(pubkey))
            if (ok) EventVerifyResult.VALID else EventVerifyResult.SCHNORR_INVALID
        } catch (_: Exception) {
            EventVerifyResult.SCHNORR_EXCEPTION
        }
    }

    private fun jsonValue(value: Any?): String {
        return when (value) {
            null, JSONObject.NULL -> "null"
            is String -> jsonString(value)
            is JSONArray -> buildString {
                append('[')
                for (i in 0 until value.length()) {
                    if (i > 0) append(',')
                    append(jsonValue(value.opt(i)))
                }
                append(']')
            }
            is JSONObject -> value.toString()
            is Boolean -> if (value) "true" else "false"
            is Number -> value.toString()
            else -> jsonString(value.toString())
        }
    }

    private fun jsonString(value: String): String = buildString {
        append('"')
        for (ch in value) {
            when (ch) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (ch.code < 0x20) {
                    append("\\u")
                    append(ch.code.toString(16).padStart(4, '0'))
                } else {
                    append(ch)
                }
            }
        }
        append('"')
    }

    fun nip44ConversationKey(privHex: String, peerPubHex: String): ByteArray? {
        return try {
            SosNip44.conversationKey(sharedKey(privHex, peerPubHex))
        } catch (_: Exception) {
            null
        }
    }

    fun nip44Encrypt(conversationKey: ByteArray, plaintext: String, nonce: ByteArray): String {
        return SosNip44.encrypt(conversationKey, plaintext, nonce)
    }

    fun nip44Decrypt(conversationKey: ByteArray, payload: String): String? {
        return SosNip44.decrypt(conversationKey, payload)
    }

    fun nip44MessageKeys(conversationKey: ByteArray, nonce: ByteArray): SosNip44.MessageKeys {
        return SosNip44.messageKeys(conversationKey, nonce)
    }

    fun nip44PaddedLen(unpaddedLen: Int): Int = SosNip44.calcPaddedLen(unpaddedLen)

    private fun sha256(data: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(data)
}
