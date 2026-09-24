package com.sos010.app

import fr.acinq.secp256k1.Hex
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.math.min

/**
 * MD2 — sos-pair-v1 cryptographic primitives (QR, transcript, HKDF, AEAD, SAS).
 * Does NOT issue DeviceAuthorization (MD3). Does NOT wrap root K.
 * HYPER CORE TECH
 */
object SosPairingCrypto {

    const val PROTOCOL_VERSION = "sos-pair-v1"
    const val QR_PREFIX = "SOSPAIR1:"
    const val DEFAULT_TTL_MS = 120_000L
    const val MAX_CLOCK_SKEW_MS = 60_000L
    const val HKDF_INFO = "SOS|pair|v1"
    private const val GCM_TAG_BITS = 128
    private const val IV_BYTES = 12

    enum class Purpose { LINK, RECOVERY }

    data class QrPayload(
        val protocolVersion: String,
        val pairingId: String,
        val dSignPub: String,
        val dEncPub: String,
        val eEphemeralPub: String,
        val nonce: String,
        val expiresAt: Long,
        val purpose: Purpose = Purpose.LINK,
        val deviceId: String = "",
        val storageClass: String = "",
        val recoveryEligible: Boolean = false,
        val hardwareBacked: Boolean = false,
        val rendezvous: String? = null,
        val sasHint: String? = null,
    ) {
        fun toPublicJson(): JSONObject {
            val o = JSONObject()
                .put("protocolVersion", protocolVersion)
                .put("pairingId", pairingId)
                .put("D_sign_pub", dSignPub)
                .put("D_enc_pub", dEncPub)
                .put("E_ephemeral_pub", eEphemeralPub)
                .put("nonce", nonce)
                .put("expiresAt", expiresAt)
                .put("purpose", purpose.name)
            if (deviceId.isNotBlank()) o.put("deviceId", deviceId)
            if (storageClass.isNotBlank()) o.put("storageClass", storageClass)
            o.put("recoveryEligible", recoveryEligible)
            o.put("hardwareBacked", hardwareBacked)
            if (!rendezvous.isNullOrBlank()) o.put("rendezvous", rendezvous)
            if (!sasHint.isNullOrBlank()) o.put("sasHint", sasHint)
            return o
        }
    }

    data class SealedMessage(
        val ivB64: String,
        val ctB64: String,
    )

    fun newPairingId(random: SecureRandom = SecureRandom()): String =
        Hex.encode(ByteArray(16).also { random.nextBytes(it) })

    fun newNonce(random: SecureRandom = SecureRandom()): String =
        Hex.encode(ByteArray(32).also { random.nextBytes(it) })

    fun encodeQr(payload: QrPayload): String {
        val json = payload.toPublicJson().toString()
        val b64 = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(json.toByteArray(StandardCharsets.UTF_8))
        return QR_PREFIX + b64
    }

    fun parseQr(qr: String, nowMs: Long = System.currentTimeMillis()): Result<QrPayload> {
        val trimmed = qr.trim()
        if (!trimmed.startsWith(QR_PREFIX)) return Result.failure(IllegalArgumentException("BAD_PREFIX"))
        val raw = try {
            String(
                Base64.getUrlDecoder().decode(trimmed.removePrefix(QR_PREFIX)),
                StandardCharsets.UTF_8,
            )
        } catch (_: Exception) {
            return Result.failure(IllegalArgumentException("BAD_B64"))
        }
        // Reject secret-looking fields by name before parse semantics
        val lower = raw.lowercase()
        if (lower.contains("\"nsec") || lower.contains("\"priv") ||
            lower.contains("\"d_sign_priv") || lower.contains("\"d_enc_priv") ||
            lower.contains("\"rootk") || Regex("\"k\"\\s*:").containsMatchIn(lower)
        ) {
            return Result.failure(IllegalArgumentException("SECRET_IN_QR"))
        }
        return try {
            val o = JSONObject(raw)
            val version = o.getString("protocolVersion")
            if (version != PROTOCOL_VERSION) {
                return Result.failure(IllegalArgumentException("UNKNOWN_PROTOCOL_VERSION"))
            }
            val payload = QrPayload(
                protocolVersion = version,
                pairingId = SosDeviceKeyCrypto.normalizeHex(o.getString("pairingId")),
                dSignPub = SosDeviceKeyCrypto.normalizeHex(o.getString("D_sign_pub")),
                dEncPub = SosDeviceKeyCrypto.normalizeHex(o.getString("D_enc_pub")),
                eEphemeralPub = SosDeviceKeyCrypto.normalizeHex(o.getString("E_ephemeral_pub")),
                nonce = SosDeviceKeyCrypto.normalizeHex(o.getString("nonce")),
                expiresAt = o.getLong("expiresAt"),
                purpose = Purpose.valueOf(o.optString("purpose", Purpose.LINK.name)),
                deviceId = SosDeviceKeyCrypto.normalizeHex(o.optString("deviceId", "")),
                storageClass = o.optString("storageClass", ""),
                recoveryEligible = o.optBoolean("recoveryEligible", false),
                hardwareBacked = o.optBoolean("hardwareBacked", false),
                rendezvous = if (o.has("rendezvous")) o.optString("rendezvous").takeIf { it.isNotBlank() } else null,
                sasHint = if (o.has("sasHint")) o.optString("sasHint").takeIf { it.isNotBlank() } else null,
            )
            if (payload.deviceId.isNotEmpty() && !SosDeviceKeyCrypto.isHex64(payload.deviceId)) {
                return Result.failure(IllegalArgumentException("BAD_DEVICE_ID"))
            }
            if (!SosDeviceKeyCrypto.isHex64(payload.dSignPub) ||
                !SosDeviceKeyCrypto.isHex64(payload.dEncPub) ||
                !SosDeviceKeyCrypto.isHex64(payload.eEphemeralPub) ||
                !SosDeviceKeyCrypto.isHex64(payload.nonce)
            ) {
                return Result.failure(IllegalArgumentException("BAD_HEX"))
            }
            if (payload.pairingId.length !in 16..64 || !payload.pairingId.matches(Regex("^[0-9a-f]+$"))) {
                return Result.failure(IllegalArgumentException("BAD_PAIRING_ID"))
            }
            if (nowMs > payload.expiresAt + MAX_CLOCK_SKEW_MS) {
                return Result.failure(IllegalArgumentException("EXPIRED"))
            }
            Result.success(payload)
        } catch (e: Exception) {
            Result.failure(IllegalArgumentException(e.message ?: "PARSE_FAIL"))
        }
    }

    /**
     * transcript = SHA256(version||pairingId||D_sign||D_enc||E_desktop||E_phone||nonce||expiresAt||rendezvous?)
     * Fixed-width hex fields; expiresAt decimal; rendezvous omitted when null/blank.
     */
    fun transcript(
        protocolVersion: String,
        pairingId: String,
        dSignPub: String,
        dEncPub: String,
        eDesktopPub: String,
        ePhonePub: String,
        nonce: String,
        expiresAt: Long,
        rendezvous: String? = null,
    ): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        fun add(s: String) {
            md.update(s.toByteArray(StandardCharsets.UTF_8))
        }
        add(protocolVersion)
        add(SosDeviceKeyCrypto.normalizeHex(pairingId))
        add(SosDeviceKeyCrypto.normalizeHex(dSignPub))
        add(SosDeviceKeyCrypto.normalizeHex(dEncPub))
        add(SosDeviceKeyCrypto.normalizeHex(eDesktopPub))
        add(SosDeviceKeyCrypto.normalizeHex(ePhonePub))
        add(SosDeviceKeyCrypto.normalizeHex(nonce))
        add(expiresAt.toString())
        if (!rendezvous.isNullOrBlank()) add(rendezvous)
        return md.digest()
    }

    /** session_key = HKDF-SHA256(ikm=ECDH, salt=transcript, info=SOS|pair|v1) → 32 bytes */
    fun sessionKey(ecdhShared: ByteArray, transcript: ByteArray): ByteArray {
        require(ecdhShared.size == 32 && transcript.size == 32)
        val prk = hkdfExtract(salt = transcript, ikm = ecdhShared)
        return try {
            hkdfExpand(prk, HKDF_INFO.toByteArray(StandardCharsets.UTF_8), 32)
        } finally {
            SosDeviceKeyCrypto.zeroize(prk)
        }
    }

    fun seal(sessionKey: ByteArray, transcript: ByteArray, plaintext: ByteArray, random: SecureRandom = SecureRandom()): SealedMessage {
        require(sessionKey.size == 32)
        val iv = ByteArray(IV_BYTES).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(sessionKey, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
        cipher.updateAAD(transcript)
        val ct = cipher.doFinal(plaintext)
        return SealedMessage(
            ivB64 = Base64.getEncoder().encodeToString(iv),
            ctB64 = Base64.getEncoder().encodeToString(ct),
        )
    }

    fun open(sessionKey: ByteArray, transcript: ByteArray, sealed: SealedMessage): ByteArray? {
        return try {
            val iv = Base64.getDecoder().decode(sealed.ivB64)
            val ct = Base64.getDecoder().decode(sealed.ctB64)
            if (iv.size != IV_BYTES) return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(sessionKey, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
            cipher.updateAAD(transcript)
            cipher.doFinal(ct)
        } catch (_: Exception) {
            null
        }
    }

    /** 6-digit SAS from transcript (UI confirmation; not a secret). */
    fun sasDigits(transcript: ByteArray): String {
        require(transcript.size >= 4)
        var n = 0
        for (i in 0 until 4) {
            n = (n shl 8) or (transcript[i].toInt() and 0xff)
        }
        val mod = ((n.toLong() and 0xffffffffL) % 1_000_000L).toInt()
        return mod.toString().padStart(6, '0')
    }

    fun deviceFingerprint(dSignPub: String, dEncPub: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        md.update(Hex.decode(SosDeviceKeyCrypto.normalizeHex(dSignPub)))
        md.update(Hex.decode(SosDeviceKeyCrypto.normalizeHex(dEncPub)))
        val dig = md.digest()
        val hex = Hex.encode(dig)
        return hex.take(4) + "…" + hex.takeLast(4)
    }

    private fun hkdfExtract(salt: ByteArray, ikm: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        return mac.doFinal(ikm)
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
}
