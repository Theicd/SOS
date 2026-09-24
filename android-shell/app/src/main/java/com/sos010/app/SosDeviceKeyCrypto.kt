package com.sos010.app

import fr.acinq.secp256k1.Hex
import fr.acinq.secp256k1.Secp256k1
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * MD1 — Typed device-key crypto (D_sign secp256k1 + D_enc X25519).
 * Never uses root K. Never exposes generic private-key getters for WebView.
 * HYPER CORE TECH
 */
object SosDeviceKeyCrypto {

    private val secp: Secp256k1 by lazy { Secp256k1.get() }
    private val rnd = SecureRandom()

    data class GeneratedDeviceKeys(
        val deviceId: String,
        val signPriv: ByteArray,
        val signPubHex: String,
        val encPriv: ByteArray,
        val encPubHex: String,
    )

    /** 256-bit random deviceId as lowercase hex (64 chars). */
    fun newDeviceId(random: SecureRandom = rnd): String {
        val bytes = ByteArray(SosDeviceKeyPolicy.DEVICE_ID_BITS / 8)
        random.nextBytes(bytes)
        return Hex.encode(bytes)
    }

    fun generate(random: SecureRandom = rnd): GeneratedDeviceKeys {
        val deviceId = newDeviceId(random)
        val signPriv = generateSecp256k1Priv(random)
        val signPub = xOnlyPubFromPriv(signPriv)
        val (encPriv, encPub) = SosX25519.generateKeyPair(random)
        return GeneratedDeviceKeys(
            deviceId = deviceId,
            signPriv = signPriv,
            signPubHex = Hex.encode(signPub),
            encPriv = encPriv,
            encPubHex = Hex.encode(encPub),
        )
    }

    fun xOnlyPubFromPriv(priv: ByteArray): ByteArray {
        require(priv.size == 32) { "secp_priv_len" }
        val compressed = secp.pubKeyCompress(secp.pubkeyCreate(priv))
        return compressed.copyOfRange(1, 33)
    }

    fun signPubMatches(priv: ByteArray, pubHex: String): Boolean {
        return try {
            Hex.encode(xOnlyPubFromPriv(priv)) == normalizeHex(pubHex)
        } catch (_: Exception) {
            false
        }
    }

    fun encPubMatches(priv: ByteArray, pubHex: String): Boolean {
        return try {
            Hex.encode(SosX25519.publicFromPrivate(priv)) == normalizeHex(pubHex)
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Domain-separated device Schnorr signature.
     * message32 = SHA256("SOS|device-sign|v1" || payload)
     */
    fun signDevicePayload(signPriv: ByteArray, payload: ByteArray): ByteArray {
        require(signPriv.size == 32) { "secp_priv_len" }
        val msg = domainHash(payload)
        return secp.signSchnorr(msg, signPriv, null)
    }

    fun verifyDevicePayload(signPubHex: String, payload: ByteArray, signature: ByteArray): Boolean {
        return try {
            val pub = Hex.decode(normalizeHex(signPubHex))
            require(pub.size == 32 && signature.size == 64)
            val msg = domainHash(payload)
            secp.verifySchnorr(signature, msg, pub)
        } catch (_: Exception) {
            false
        }
    }

    /** X25519 shared secret for future sealed envelopes (MD2+). */
    fun deviceEcdh(encPriv: ByteArray, peerEncPubHex: String): ByteArray {
        val peer = Hex.decode(normalizeHex(peerEncPubHex))
        require(peer.size == 32) { "x25519_pub_len" }
        return SosX25519.sharedSecret(encPriv, peer)
    }

    fun pubFingerprint(pubHex: String): String {
        val dig = MessageDigest.getInstance("SHA-256").digest(Hex.decode(normalizeHex(pubHex)))
        return Hex.encode(dig.copyOfRange(0, 8))
    }

    fun normalizeHex(s: String?): String =
        (s ?: "").trim().lowercase().removePrefix("0x")

    fun isHex64(s: String?): Boolean =
        !s.isNullOrBlank() && normalizeHex(s).matches(Regex("^[0-9a-f]{64}$"))

    fun zeroize(vararg arrays: ByteArray?) {
        for (a in arrays) {
            a?.fill(0)
        }
    }

    private fun domainHash(payload: ByteArray): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        md.update("SOS|device-sign|v1".toByteArray(Charsets.UTF_8))
        md.update(payload)
        return md.digest()
    }

    private fun generateSecp256k1Priv(random: SecureRandom): ByteArray {
        // Rejection sampling into curve order range via library create+compress check.
        while (true) {
            val priv = ByteArray(32).also { random.nextBytes(it) }
            try {
                secp.pubkeyCreate(priv)
                return priv
            } catch (_: Exception) {
                priv.fill(0)
            }
        }
    }
}
