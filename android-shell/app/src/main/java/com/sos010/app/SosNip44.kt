package com.sos010.app

import fr.acinq.secp256k1.Hex
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.math.ln
import kotlin.math.min

/**
 * NIP-44 v2 exactly: secp256k1 ECDH X, HKDF-SHA256, ChaCha20, HMAC-SHA256, padded base64.
 * Conversation key uses the raw X coordinate (not SHA-256).
 */
object SosNip44 {
    private const val SALT = "nip44-v2"
    private const val VERSION: Byte = 2

    fun conversationKey(secpSharedX: ByteArray): ByteArray {
        require(secpSharedX.size == 32)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(SALT.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(secpSharedX)
    }

    fun messageKeys(conversationKey: ByteArray, nonce: ByteArray): MessageKeys {
        require(conversationKey.size == 32 && nonce.size == 32)
        val keys = hkdfExpand(conversationKey, nonce, 76)
        return MessageKeys(
            chachaKey = keys.copyOfRange(0, 32),
            chachaNonce = keys.copyOfRange(32, 44),
            hmacKey = keys.copyOfRange(44, 76)
        )
    }

    fun calcPaddedLen(unpaddedLen: Int): Int {
        if (unpaddedLen < 1 || unpaddedLen > 65535) throw IllegalArgumentException("bad len")
        if (unpaddedLen <= 32) return 32
        val nextPower = 1 shl (floorLog2(unpaddedLen - 1) + 1)
        val chunk = if (nextPower <= 256) 32 else nextPower / 8
        return chunk * (((unpaddedLen - 1) / chunk) + 1)
    }

    fun encrypt(conversationKey: ByteArray, plaintext: String, nonce: ByteArray): String {
        if (nonce.size != 32) throw IllegalArgumentException("nonce")
        val keys = messageKeys(conversationKey, nonce)
        val padded = pad(plaintext)
        val ciphertext = SosChaCha20.xor(keys.chachaKey, keys.chachaNonce, padded)
        val mac = hmacSha256(keys.hmacKey, nonce + ciphertext)
        val packed = ByteArray(1 + nonce.size + ciphertext.size + mac.size)
        packed[0] = VERSION
        System.arraycopy(nonce, 0, packed, 1, nonce.size)
        System.arraycopy(ciphertext, 0, packed, 1 + nonce.size, ciphertext.size)
        System.arraycopy(mac, 0, packed, 1 + nonce.size + ciphertext.size, mac.size)
        return java.util.Base64.getEncoder().encodeToString(packed)
    }

    fun decrypt(conversationKey: ByteArray, payload: String): String? {
        if (payload.length < 132 || payload.length > 87472) return null
        if (payload.startsWith("#")) return null
        val raw = try {
            java.util.Base64.getDecoder().decode(payload)
        } catch (_: Exception) {
            return null
        }
        if (raw.size < 99 || raw.size > 65603) return null
        if (raw[0] != VERSION) return null
        val nonce = raw.copyOfRange(1, 33)
        val mac = raw.copyOfRange(raw.size - 32, raw.size)
        val ciphertext = raw.copyOfRange(33, raw.size - 32)
        if (ciphertext.isEmpty()) return null
        val keys = try {
            messageKeys(conversationKey, nonce)
        } catch (_: Exception) {
            return null
        }
        val expected = hmacSha256(keys.hmacKey, nonce + ciphertext)
        if (!constantTimeEquals(mac, expected)) return null
        val padded = SosChaCha20.xor(keys.chachaKey, keys.chachaNonce, ciphertext)
        return unpad(padded)
    }

    data class MessageKeys(
        val chachaKey: ByteArray,
        val chachaNonce: ByteArray,
        val hmacKey: ByteArray
    )

    private fun pad(plaintext: String): ByteArray {
        val data = plaintext.toByteArray(Charsets.UTF_8)
        if (data.isEmpty() || data.size > 65535) throw IllegalArgumentException("plaintext size")
        val paddedLen = calcPaddedLen(data.size)
        val out = ByteArray(2 + paddedLen)
        out[0] = ((data.size ushr 8) and 0xff).toByte()
        out[1] = (data.size and 0xff).toByte()
        System.arraycopy(data, 0, out, 2, data.size)
        return out
    }

    private fun unpad(padded: ByteArray): String? {
        if (padded.size < 2) return null
        val len = ((padded[0].toInt() and 0xff) shl 8) or (padded[1].toInt() and 0xff)
        if (len < 1 || len > 65535) return null
        val expected = try {
            calcPaddedLen(len)
        } catch (_: Exception) {
            return null
        }
        if (padded.size != 2 + expected) return null
        if (2 + len > padded.size) return null
        for (i in (2 + len) until padded.size) {
            if (padded[i] != 0.toByte()) return null
        }
        return try {
            String(padded, 2, len, Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    private fun hkdfExpand(prk: ByteArray, info: ByteArray, length: Int): ByteArray {
        val okm = ByteArray(length)
        var previous = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            val expand = Mac.getInstance("HmacSHA256")
            expand.init(SecretKeySpec(prk, "HmacSHA256"))
            expand.update(previous)
            expand.update(info)
            expand.update(counter.toByte())
            previous = expand.doFinal()
            val n = min(previous.size, length - offset)
            System.arraycopy(previous, 0, okm, offset, n)
            offset += n
            counter += 1
        }
        return okm
    }

    private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    private fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean {
        if (a.size != b.size) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].toInt() xor b[i].toInt())
        return diff == 0
    }

    private fun floorLog2(n: Int): Int {
        return (ln(n.toDouble()) / ln(2.0)).toInt()
    }

    fun sha256(data: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(data)

    fun hex(bytes: ByteArray): String = Hex.encode(bytes)
}

/** IETF ChaCha20, 32-byte key, 12-byte nonce, counter starts at 0. */
object SosChaCha20 {
    fun xor(key: ByteArray, nonce: ByteArray, data: ByteArray): ByteArray {
        require(key.size == 32 && nonce.size == 12)
        val out = data.copyOf()
        var counter = 0
        var off = 0
        while (off < out.size) {
            val block = block(key, counter, nonce)
            val n = min(64, out.size - off)
            for (i in 0 until n) {
                out[off + i] = (out[off + i].toInt() xor (block[i].toInt() and 0xff)).toByte()
            }
            off += 64
            counter += 1
        }
        return out
    }

    private fun block(key: ByteArray, counter: Int, nonce: ByteArray): ByteArray {
        val s = IntArray(16)
        s[0] = 0x61707865
        s[1] = 0x3320646e
        s[2] = 0x79622d32
        s[3] = 0x6b206574
        for (i in 0 until 8) s[4 + i] = le32(key, i * 4)
        s[12] = counter
        s[13] = le32(nonce, 0)
        s[14] = le32(nonce, 4)
        s[15] = le32(nonce, 8)
        val w = s.copyOf()
        repeat(10) {
            quarter(w, 0, 4, 8, 12)
            quarter(w, 1, 5, 9, 13)
            quarter(w, 2, 6, 10, 14)
            quarter(w, 3, 7, 11, 15)
            quarter(w, 0, 5, 10, 15)
            quarter(w, 1, 6, 11, 12)
            quarter(w, 2, 7, 8, 13)
            quarter(w, 3, 4, 9, 14)
        }
        val out = ByteArray(64)
        for (i in 0 until 16) {
            val v = w[i] + s[i]
            out[i * 4] = v.toByte()
            out[i * 4 + 1] = (v ushr 8).toByte()
            out[i * 4 + 2] = (v ushr 16).toByte()
            out[i * 4 + 3] = (v ushr 24).toByte()
        }
        return out
    }

    private fun quarter(s: IntArray, a: Int, b: Int, c: Int, d: Int) {
        s[a] = s[a] + s[b]
        s[d] = (s[d] xor s[a]).rotateLeft(16)
        s[c] = s[c] + s[d]
        s[b] = (s[b] xor s[c]).rotateLeft(12)
        s[a] = s[a] + s[b]
        s[d] = (s[d] xor s[a]).rotateLeft(8)
        s[c] = s[c] + s[d]
        s[b] = (s[b] xor s[c]).rotateLeft(7)
    }

    private fun le32(src: ByteArray, offset: Int): Int {
        return (src[offset].toInt() and 0xff) or
            ((src[offset + 1].toInt() and 0xff) shl 8) or
            ((src[offset + 2].toInt() and 0xff) shl 16) or
            ((src[offset + 3].toInt() and 0xff) shl 24)
    }
}
