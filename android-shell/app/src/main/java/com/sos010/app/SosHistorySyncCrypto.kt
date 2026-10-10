package com.sos010.app

import fr.acinq.secp256k1.Hex
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
 * MD4 S3 — sos-history-sync-v1 session crypto (domain-separated from sos-pair-v1).
 * HYPER CORE TECH
 */
object SosHistorySyncCrypto {
    const val PROTOCOL_VERSION = "sos-history-sync-v1"
    const val TAG = "sos-hist-v1"
    const val HKDF_INFO = "SOS|hist|v1"
    const val POP_DOMAIN = "SOS|hist|pop"
    /** Domain-separated AEAD AAD for SYNC_ACK / SYNC_FINAL_ACK (not HIST_BATCH). */
    const val ACK_AAD_DOMAIN = "SOS|hist|ack|aad|v1"
    const val BATCH_DIGEST_DOMAIN = "SOS|hist|batch|digest|v1"
    const val DEFAULT_TTL_MS = 15L * 60L * 1000L
    const val MAX_BATCH_EVENTS = 50
    const val MAX_BATCH_BYTES = 256 * 1024
    private const val GCM_TAG_BITS = 128
    private const val IV_BYTES = 12

    data class SealedMessage(val ivB64: String, val ctB64: String)

    fun transcriptBind(
        accountP: String,
        deviceId: String,
        authorizationId: String,
        authEpoch: Long,
        pairingTranscriptHash: String,
        sessionNonce: String,
        dSignPub: String,
        dEncPub: String,
    ): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        fun add(s: String) {
            md.update(s.toByteArray(StandardCharsets.UTF_8))
        }
        add(PROTOCOL_VERSION)
        add(SosDeviceKeyCrypto.normalizeHex(accountP))
        add(SosDeviceKeyCrypto.normalizeHex(deviceId))
        add(SosDeviceKeyCrypto.normalizeHex(authorizationId))
        add(authEpoch.toString())
        add(SosDeviceKeyCrypto.normalizeHex(pairingTranscriptHash))
        add(SosDeviceKeyCrypto.normalizeHex(sessionNonce))
        add(SosDeviceKeyCrypto.normalizeHex(dSignPub))
        add(SosDeviceKeyCrypto.normalizeHex(dEncPub))
        return md.digest()
    }

    /** session_key = HKDF(ikm=ECDH||bind, salt=bind, info=SOS|hist|v1) */
    fun sessionKey(ecdhShared: ByteArray, transcriptBind: ByteArray): ByteArray {
        require(ecdhShared.size == 32 && transcriptBind.size == 32)
        val ikm = ByteArray(64)
        System.arraycopy(ecdhShared, 0, ikm, 0, 32)
        System.arraycopy(transcriptBind, 0, ikm, 32, 32)
        val prk = hkdfExtract(salt = transcriptBind, ikm = ikm)
        return try {
            hkdfExpand(prk, HKDF_INFO.toByteArray(StandardCharsets.UTF_8), 32)
        } finally {
            SosDeviceKeyCrypto.zeroize(prk)
            SosDeviceKeyCrypto.zeroize(ikm)
        }
    }

    fun seal(
        sessionKey: ByteArray,
        aad: ByteArray,
        plaintext: ByteArray,
        random: SecureRandom = SecureRandom(),
    ): SealedMessage {
        require(sessionKey.size == 32)
        val iv = ByteArray(IV_BYTES).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(sessionKey, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
        cipher.updateAAD(aad)
        val ct = cipher.doFinal(plaintext)
        return SealedMessage(
            ivB64 = Base64.getEncoder().encodeToString(iv),
            ctB64 = Base64.getEncoder().encodeToString(ct),
        )
    }

    fun open(sessionKey: ByteArray, aad: ByteArray, sealed: SealedMessage): ByteArray? {
        return try {
            val iv = Base64.getDecoder().decode(sealed.ivB64)
            val ct = Base64.getDecoder().decode(sealed.ctB64)
            if (iv.size != IV_BYTES) return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(sessionKey, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
            cipher.updateAAD(aad)
            cipher.doFinal(ct)
        } catch (_: Exception) {
            null
        }
    }

    fun popMessage(transcriptBind: ByteArray): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        md.update(POP_DOMAIN.toByteArray(StandardCharsets.UTF_8))
        md.update(transcriptBind)
        return md.digest()
    }

    /**
     * AEAD AAD for authenticated history control ACKs.
     * Binds session transcript + account/device/authorization + sessionId.
     * Distinct from HIST_BATCH AAD (= raw transcriptBind) so ciphertext cannot be remapped.
     */
    fun ackAad(
        transcriptBind: ByteArray,
        sessionId: String,
        accountP: String,
        deviceId: String,
        authorizationId: String,
        authEpoch: Long,
    ): ByteArray {
        require(transcriptBind.size == 32)
        val md = MessageDigest.getInstance("SHA-256")
        md.update(ACK_AAD_DOMAIN.toByteArray(StandardCharsets.UTF_8))
        md.update(transcriptBind)
        md.update(SosDeviceKeyCrypto.normalizeHex(sessionId).toByteArray(StandardCharsets.UTF_8))
        md.update(SosDeviceKeyCrypto.normalizeHex(accountP).toByteArray(StandardCharsets.UTF_8))
        md.update(SosDeviceKeyCrypto.normalizeHex(deviceId).toByteArray(StandardCharsets.UTF_8))
        md.update(SosDeviceKeyCrypto.normalizeHex(authorizationId).toByteArray(StandardCharsets.UTF_8))
        md.update(authEpoch.toString().toByteArray(StandardCharsets.UTF_8))
        return md.digest()
    }

    /** Canonical digest of an in-flight HIST_BATCH (batchId||batchSeq||events JSON). */
    fun batchDigest(batchId: String, batchSeq: Long, eventsJson: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        md.update(BATCH_DIGEST_DOMAIN.toByteArray(StandardCharsets.UTF_8))
        md.update(SosDeviceKeyCrypto.normalizeHex(batchId).toByteArray(StandardCharsets.UTF_8))
        md.update(batchSeq.toString().toByteArray(StandardCharsets.UTF_8))
        md.update(eventsJson.toByteArray(StandardCharsets.UTF_8))
        return Hex.encode(md.digest())
    }

    fun newSessionId(random: SecureRandom = SecureRandom()): String =
        Hex.encode(ByteArray(32).also { random.nextBytes(it) })

    fun newNonce(random: SecureRandom = SecureRandom()): String =
        Hex.encode(ByteArray(32).also { random.nextBytes(it) })

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
