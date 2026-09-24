package com.sos010.app

import fr.acinq.secp256k1.Hex
import fr.acinq.secp256k1.Secp256k1
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * MD3 — sos-device-authorization-v1 schema, canonical encoding, root signature verify.
 * Never contains root K/nsec. Never transfers conversation keys.
 * HYPER CORE TECH
 */
object SosDeviceAuthorization {

    const val VERSION = "sos-device-authorization-v1"
    const val DOMAIN = "SOS_DEVICE_AUTHORIZATION_V1"
    const val DEFAULT_LIFETIME_MS = 365L * 24L * 60L * 60L * 1000L // 365 days
    const val AUTH_EPOCH_INITIAL = 1L
    const val MAX_LINKED_DEVICES = SosDeviceKeyPolicy.MAX_LINKED_DEVICES
    const val ENCODING = "canonical-line-v1+sha256+schnorr"

    enum class Capability {
        DEVICE_CHAT,
        DEVICE_CALLS,
        DEVICE_P2P,
        DEVICE_FILES,
        DEVICE_RECEIPTS,
        DEVICE_PRESENCE,
        DEVICE_SETTINGS,
        DEVICE_HISTORY_SYNC,
        DEVICE_RECOVERY,
        DEVICE_ADMIN, // reserved — never auto-granted
    }

    enum class Status {
        ACTIVE,
        EXPIRED,
        REVOKED, // reserved for MD8 — not written by MD3 issuance
        PENDING_COMMIT, // signed but not fully committed
    }

    val NORMAL_PROFILE: Set<Capability> = setOf(
        Capability.DEVICE_CHAT,
        Capability.DEVICE_CALLS,
        Capability.DEVICE_P2P,
        Capability.DEVICE_FILES,
        Capability.DEVICE_RECEIPTS,
        Capability.DEVICE_PRESENCE,
        Capability.DEVICE_SETTINGS,
        Capability.DEVICE_HISTORY_SYNC,
    )

    data class Authorization(
        val version: String,
        val authorizationId: String,
        val accountP: String,
        val deviceId: String,
        val dSignPub: String,
        val dEncPub: String,
        val capabilities: Set<Capability>,
        val authEpoch: Long,
        val createdAt: Long,
        val expiresAt: Long,
        val pairingTranscriptHash: String,
        val pairingId: String,
        val storageSecurityClass: String,
        val recoveryEligibleAtAuthorization: Boolean,
        val deviceLabel: String = "",
        val deviceType: String = "DESKTOP",
        val rootSignatureHex: String = "",
    ) {
        fun toPublicJson(): JSONObject {
            val caps = JSONArray()
            capabilities.map { it.name }.sorted().forEach { caps.put(it) }
            return JSONObject()
                .put("version", version)
                .put("authorizationId", authorizationId)
                .put("accountP", accountP)
                .put("deviceId", deviceId)
                .put("D_sign_pub", dSignPub)
                .put("D_enc_pub", dEncPub)
                .put("capabilities", caps)
                .put("authEpoch", authEpoch)
                .put("createdAt", createdAt)
                .put("expiresAt", expiresAt)
                .put("pairingTranscriptHash", pairingTranscriptHash)
                .put("pairingId", pairingId)
                .put("storageSecurityClass", storageSecurityClass)
                .put("recoveryEligibleAtAuthorization", recoveryEligibleAtAuthorization)
                .put("deviceLabel", sanitizeLabel(deviceLabel))
                .put("deviceType", sanitizeLabel(deviceType).ifBlank { "DESKTOP" })
                .put("rootSignature", rootSignatureHex)
        }

        companion object {
            fun fromJson(o: JSONObject): Authorization {
                val caps = linkedSetOf<Capability>()
                val arr = o.getJSONArray("capabilities")
                for (i in 0 until arr.length()) {
                    caps.add(Capability.valueOf(arr.getString(i)))
                }
                return Authorization(
                    version = o.getString("version"),
                    authorizationId = SosDeviceKeyCrypto.normalizeHex(o.getString("authorizationId")),
                    accountP = SosDeviceKeyCrypto.normalizeHex(o.getString("accountP")),
                    deviceId = SosDeviceKeyCrypto.normalizeHex(o.getString("deviceId")),
                    dSignPub = SosDeviceKeyCrypto.normalizeHex(o.getString("D_sign_pub")),
                    dEncPub = SosDeviceKeyCrypto.normalizeHex(o.getString("D_enc_pub")),
                    capabilities = caps,
                    authEpoch = o.getLong("authEpoch"),
                    createdAt = o.getLong("createdAt"),
                    expiresAt = o.getLong("expiresAt"),
                    pairingTranscriptHash = SosDeviceKeyCrypto.normalizeHex(o.getString("pairingTranscriptHash")),
                    pairingId = SosDeviceKeyCrypto.normalizeHex(o.getString("pairingId")),
                    storageSecurityClass = o.optString("storageSecurityClass", ""),
                    recoveryEligibleAtAuthorization = o.optBoolean("recoveryEligibleAtAuthorization", false),
                    deviceLabel = sanitizeLabel(o.optString("deviceLabel", "")),
                    deviceType = sanitizeLabel(o.optString("deviceType", "DESKTOP")),
                    rootSignatureHex = SosDeviceKeyCrypto.normalizeHex(o.optString("rootSignature", "")),
                )
            }
        }
    }

    fun newAuthorizationId(random: SecureRandom = SecureRandom()): String =
        Hex.encode(ByteArray(32).also { random.nextBytes(it) })

    fun sanitizeLabel(raw: String): String {
        // Strip HTML/SVG/control chars; cap length — display metadata only.
        val cleaned = raw
            .replace(Regex("[<>\"'`]"), "")
            .replace(Regex("[\\u0000-\\u001F\\u007F\\u202A-\\u202E\\u2066-\\u2069]"), "")
            .trim()
        return if (cleaned.length > 64) cleaned.take(64) else cleaned
    }

    /** Deterministic canonical bytes for signing/verification. */
    fun canonicalBytes(auth: Authorization): ByteArray {
        val caps = auth.capabilities.map { it.name }.sorted().joinToString(",")
        val lines = listOf(
            DOMAIN,
            "version=${auth.version}",
            "authorizationId=${SosDeviceKeyCrypto.normalizeHex(auth.authorizationId)}",
            "accountP=${SosDeviceKeyCrypto.normalizeHex(auth.accountP)}",
            "deviceId=${SosDeviceKeyCrypto.normalizeHex(auth.deviceId)}",
            "D_sign_pub=${SosDeviceKeyCrypto.normalizeHex(auth.dSignPub)}",
            "D_enc_pub=${SosDeviceKeyCrypto.normalizeHex(auth.dEncPub)}",
            "capabilities=$caps",
            "authEpoch=${auth.authEpoch}",
            "createdAt=${auth.createdAt}",
            "expiresAt=${auth.expiresAt}",
            "pairingTranscriptHash=${SosDeviceKeyCrypto.normalizeHex(auth.pairingTranscriptHash)}",
            "pairingId=${SosDeviceKeyCrypto.normalizeHex(auth.pairingId)}",
            "storageSecurityClass=${auth.storageSecurityClass}",
            "recoveryEligibleAtAuthorization=${auth.recoveryEligibleAtAuthorization}",
        )
        return lines.joinToString("\n").toByteArray(StandardCharsets.UTF_8)
    }

    fun messageHash(auth: Authorization): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(canonicalBytes(auth))

    fun confirmationPayloadHash(auth: Authorization): String =
        Hex.encode(messageHash(auth))

    sealed class VerifyResult {
        object Ok : VerifyResult()
        data class Err(val code: String) : VerifyResult()
    }

    fun verifyStrict(auth: Authorization, nowMs: Long = System.currentTimeMillis()): VerifyResult {
        if (auth.version != VERSION) return VerifyResult.Err("UNKNOWN_VERSION")
        if (!SosDeviceKeyCrypto.isHex64(auth.accountP)) return VerifyResult.Err("BAD_ACCOUNT_P")
        if (!SosDeviceKeyCrypto.isHex64(auth.deviceId)) return VerifyResult.Err("BAD_DEVICE_ID")
        if (!SosDeviceKeyCrypto.isHex64(auth.dSignPub)) return VerifyResult.Err("BAD_D_SIGN")
        if (!SosDeviceKeyCrypto.isHex64(auth.dEncPub)) return VerifyResult.Err("BAD_D_ENC")
        if (!SosDeviceKeyCrypto.isHex64(auth.authorizationId)) return VerifyResult.Err("BAD_AUTH_ID")
        if (!SosDeviceKeyCrypto.isHex64(auth.pairingTranscriptHash)) return VerifyResult.Err("BAD_TRANSCRIPT")
        if (auth.authEpoch < AUTH_EPOCH_INITIAL) return VerifyResult.Err("BAD_EPOCH")
        if (auth.expiresAt <= auth.createdAt) return VerifyResult.Err("BAD_EXPIRY_RANGE")
        if (nowMs > auth.expiresAt) return VerifyResult.Err("EXPIRED")
        if (auth.capabilities.isEmpty()) return VerifyResult.Err("EMPTY_CAPABILITIES")
        if (Capability.DEVICE_ADMIN in auth.capabilities) return VerifyResult.Err("ADMIN_NOT_ALLOWED")
        if (Capability.DEVICE_RECOVERY in auth.capabilities) {
            if (!auth.recoveryEligibleAtAuthorization) return VerifyResult.Err("RECOVERY_NOT_ELIGIBLE")
            if (auth.storageSecurityClass == SosDeviceKeyPolicy.StorageClass.SOFTWARE_ONLY.name ||
                auth.storageSecurityClass == SosDeviceKeyPolicy.StorageClass.UNSUPPORTED.name
            ) {
                return VerifyResult.Err("RECOVERY_STORAGE_CLASS")
            }
        }
        if (auth.rootSignatureHex.isEmpty()) return VerifyResult.Err("MISSING_SIGNATURE")
        return verifyRootSignature(auth)
    }

    fun verifyRootSignature(auth: Authorization): VerifyResult {
        return try {
            val secp = Secp256k1.get()
            val msg = messageHash(auth)
            val sig = Hex.decode(auth.rootSignatureHex)
            val pub = Hex.decode(auth.accountP)
            if (sig.size != 64 || pub.size != 32) return VerifyResult.Err("BAD_SIG_LEN")
            if (!secp.verifySchnorr(sig, msg, pub)) return VerifyResult.Err("BAD_SIGNATURE")
            VerifyResult.Ok
        } catch (_: Exception) {
            VerifyResult.Err("SIG_VERIFY_EXCEPTION")
        }
    }

    fun verifyForDestination(
        auth: Authorization,
        localDeviceId: String,
        localDSignPub: String,
        localDEncPub: String,
        expectedAccountP: String,
        nowMs: Long = System.currentTimeMillis(),
    ): VerifyResult {
        when (val v = verifyStrict(auth, nowMs)) {
            is VerifyResult.Err -> return v
            VerifyResult.Ok -> Unit
        }
        if (SosDeviceKeyCrypto.normalizeHex(auth.accountP) !=
            SosDeviceKeyCrypto.normalizeHex(expectedAccountP)
        ) {
            return VerifyResult.Err("ACCOUNT_MISMATCH")
        }
        if (SosDeviceKeyCrypto.normalizeHex(auth.deviceId) !=
            SosDeviceKeyCrypto.normalizeHex(localDeviceId)
        ) {
            return VerifyResult.Err("DEVICE_ID_MISMATCH")
        }
        if (SosDeviceKeyCrypto.normalizeHex(auth.dSignPub) !=
            SosDeviceKeyCrypto.normalizeHex(localDSignPub)
        ) {
            return VerifyResult.Err("D_SIGN_MISMATCH")
        }
        if (SosDeviceKeyCrypto.normalizeHex(auth.dEncPub) !=
            SosDeviceKeyCrypto.normalizeHex(localDEncPub)
        ) {
            return VerifyResult.Err("D_ENC_MISMATCH")
        }
        return VerifyResult.Ok
    }

    fun resolveCapabilities(
        includeRecovery: Boolean,
        recoveryEligible: Boolean,
        storageClass: String,
        userConfirmedRecovery: Boolean,
    ): Set<Capability> {
        val caps = NORMAL_PROFILE.toMutableSet()
        if (includeRecovery) {
            require(userConfirmedRecovery) { "RECOVERY_REQUIRES_CONFIRM" }
            require(recoveryEligible) { "RECOVERY_NOT_ELIGIBLE" }
            require(
                storageClass != SosDeviceKeyPolicy.StorageClass.SOFTWARE_ONLY.name &&
                    storageClass != SosDeviceKeyPolicy.StorageClass.UNSUPPORTED.name,
            ) { "RECOVERY_STORAGE_CLASS" }
            caps.add(Capability.DEVICE_RECOVERY)
        }
        return caps
    }

    /** Sign under root K — caller must already hold priv in memory briefly. Never logs. */
    fun signUnderRoot(privHex: String, auth: Authorization): Authorization {
        val secp = Secp256k1.get()
        val priv = Hex.decode(SosDeviceKeyCrypto.normalizeHex(privHex))
        val msg = messageHash(auth)
        val sig = secp.signSchnorr(msg, priv, null)
        SosDeviceKeyCrypto.zeroize(priv)
        return auth.copy(rootSignatureHex = Hex.encode(sig))
    }
}
