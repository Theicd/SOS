package com.sos010.app

/**
 * Camera / paste QR intake for Linked Devices.
 *
 * Reuses canonical [SosPairingCrypto.parseQr] only — no second parser.
 * Recognition alone never authorizes; MD2/MD3 still require explicit approve.
 */
object SosLinkedDeviceQrIntake {

    data class Accepted(
        val qrText: String,
        val pairingId: String,
        val deviceId: String,
        val expiresAt: Long,
    )

    /**
     * @return success with trimmed SOSPAIR1 text, or failure with stable code
     * (BAD_PREFIX / EXPIRED / SECRET_IN_QR / GROUP_INVITE_QR / …).
     */
    fun acceptScannedPayload(raw: String?, nowMs: Long = System.currentTimeMillis()): Result<Accepted> {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) {
            return Result.failure(IllegalArgumentException("EMPTY_QR"))
        }
        // Group invite / other product QRs must not enter Linked Device pairing.
        if (looksLikeGroupInviteQr(text)) {
            return Result.failure(IllegalArgumentException("GROUP_INVITE_QR"))
        }
        if (!text.startsWith(SosPairingCrypto.QR_PREFIX)) {
            return Result.failure(IllegalArgumentException("BAD_PREFIX"))
        }
        val parsed = SosPairingCrypto.parseQr(text, nowMs)
        val payload = parsed.getOrElse {
            return Result.failure(IllegalArgumentException(it.message ?: "QR_FAIL"))
        }
        return Result.success(
            Accepted(
                qrText = text,
                pairingId = payload.pairingId,
                deviceId = payload.deviceId,
                expiresAt = payload.expiresAt,
            ),
        )
    }

    fun looksLikeGroupInviteQr(text: String): Boolean {
        val t = text.trim()
        if (t.startsWith(SosPairingCrypto.QR_PREFIX)) return false
        // Invite deep-links / opaque invite payloads used by sos-invite-qr-ui.
        if (t.contains("invite", ignoreCase = true) &&
            (t.startsWith("http://") || t.startsWith("https://") || t.startsWith("sos010:"))
        ) {
            return true
        }
        if (t.contains("/i/") || t.contains("inviteCode=") || t.contains("invite_token=")) {
            return true
        }
        return false
    }
}
