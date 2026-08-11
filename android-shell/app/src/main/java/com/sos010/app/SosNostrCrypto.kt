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

    private fun eventId(pubkey: String, createdAt: Long, kind: Int, tags: JSONArray, content: String): String {
        // [0, pubkey, created_at, kind, tags, content]
        val arr = JSONArray()
            .put(0)
            .put(pubkey)
            .put(createdAt)
            .put(kind)
            .put(tags)
            .put(content)
        return Hex.encode(sha256(arr.toString().toByteArray(Charsets.UTF_8)))
    }

    private fun sha256(data: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(data)
}
