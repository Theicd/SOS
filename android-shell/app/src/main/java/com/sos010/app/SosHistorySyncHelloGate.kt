package com.sos010.app

import fr.acinq.secp256k1.Hex
import org.json.JSONObject

/**
 * MD4 S3 — fail-closed validation of SYNC_HELLO against DeviceAuthorization binding.
 * Extracted for unit testing; phone session must not accept mismatched sessions.
 */
object SosHistorySyncHelloGate {
    data class Result(val ok: Boolean, val code: String)

    fun validate(
        msg: JSONObject,
        auth: SosDeviceAuthorization.Authorization,
        spentSessionNonces: MutableSet<String>,
        nowMs: Long = System.currentTimeMillis(),
    ): Result {
        val type = msg.optString("type")
        if (type == "SYNC_HELLO_PING") return Result(false, "IGNORE_PING")
        if (type != "SYNC_HELLO") return Result(false, "NOT_HELLO")
        if (msg.optString("protocol") == "sos-pair-v1") return Result(false, "PROTOCOL_CONFUSION")
        if (msg.optString("protocol") != "" &&
            msg.optString("protocol") != SosHistorySyncCrypto.PROTOCOL_VERSION
        ) {
            return Result(false, "PROTOCOL_MISMATCH")
        }
        val sessionNonce = SosDeviceKeyCrypto.normalizeHex(msg.optString("sessionNonce"))
        if (!SosDeviceKeyCrypto.isHex64(sessionNonce)) return Result(false, "BAD_SESSION_NONCE")
        if (!spentSessionNonces.add(sessionNonce)) return Result(false, "REPLAY_SESSION_NONCE")
        if (nowMs > msg.optLong("expiresAt", 0L)) return Result(false, "EXPIRED")
        if (SosDeviceKeyCrypto.normalizeHex(msg.optString("accountP")) !=
            SosDeviceKeyCrypto.normalizeHex(auth.accountP)
        ) {
            return Result(false, "ACCOUNT_MISMATCH")
        }
        if (SosDeviceKeyCrypto.normalizeHex(msg.optString("deviceId")) !=
            SosDeviceKeyCrypto.normalizeHex(auth.deviceId)
        ) {
            return Result(false, "DEVICE_MISMATCH")
        }
        if (SosDeviceKeyCrypto.normalizeHex(msg.optString("authorizationId")) !=
            SosDeviceKeyCrypto.normalizeHex(auth.authorizationId)
        ) {
            return Result(false, "AUTHORIZATION_ID_MISMATCH")
        }
        if (msg.optLong("authEpoch") != auth.authEpoch) return Result(false, "AUTH_EPOCH_MISMATCH")
        if (SosDeviceKeyCrypto.normalizeHex(msg.optString("pairingTranscriptHash")) !=
            SosDeviceKeyCrypto.normalizeHex(auth.pairingTranscriptHash)
        ) {
            return Result(false, "PAIRING_TRANSCRIPT_MISMATCH")
        }
        if (SosDeviceKeyCrypto.normalizeHex(msg.optString("D_sign_pub")) !=
            SosDeviceKeyCrypto.normalizeHex(auth.dSignPub)
        ) {
            return Result(false, "D_SIGN_MISMATCH")
        }
        if (SosDeviceKeyCrypto.normalizeHex(msg.optString("D_enc_pub")) !=
            SosDeviceKeyCrypto.normalizeHex(auth.dEncPub)
        ) {
            return Result(false, "D_ENC_MISMATCH")
        }
        val ephDesktop = SosDeviceKeyCrypto.normalizeHex(msg.optString("ephDesktopPub"))
        if (!SosDeviceKeyCrypto.isHex64(ephDesktop)) return Result(false, "BAD_EPH")
        val popSig = SosDeviceKeyCrypto.normalizeHex(msg.optString("popSig"))
        // Schnorr signature is 64 bytes = 128 hex chars.
        if (!popSig.matches(Regex("^[0-9a-f]{128}$"))) return Result(false, "BAD_POP")
        val bind =
            SosHistorySyncCrypto.transcriptBind(
                auth.accountP,
                auth.deviceId,
                auth.authorizationId,
                auth.authEpoch,
                auth.pairingTranscriptHash,
                sessionNonce,
                auth.dSignPub,
                auth.dEncPub,
            )
        val popMsg = SosHistorySyncCrypto.popMessage(bind)
        return try {
            if (!SosDeviceKeyCrypto.verifyRawSchnorr(auth.dSignPub, popMsg, Hex.decode(popSig))) {
                Result(false, "BAD_POP")
            } else {
                Result(true, "OK")
            }
        } catch (_e: Exception) {
            Result(false, "BAD_POP")
        }
    }
}
