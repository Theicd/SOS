package com.sos010.app

import android.content.Context
import org.json.JSONObject

/**
 * MD4 S4 — durable phone-side history bootstrap checkpoints.
 * Never stores ConversationKeyIndex, root K, or nsec.
 */
object SosHistoryCheckpointStore {
    private const val PREFS = "sos_md4_hist_ckpt_v1"
    private const val KEY_PREFIX = "ckpt:"

    data class Checkpoint(
        val accountP: String,
        val deviceId: String,
        val authorizationId: String,
        val authEpoch: Long,
        val collectionId: String,
        val cursor: SosHistoryPagination.Cursor,
        val exportSessionId: String,
        val committedBatchSeq: Long,
        val updatedAtMs: Long,
    ) {
        fun toJson(): JSONObject =
            JSONObject()
                .put("v", 1)
                .put("accountP", SosDeviceKeyCrypto.normalizeHex(accountP))
                .put("deviceId", SosDeviceKeyCrypto.normalizeHex(deviceId))
                .put("authorizationId", SosDeviceKeyCrypto.normalizeHex(authorizationId))
                .put("authEpoch", authEpoch)
                .put("collectionId", collectionId)
                .put("cursor", cursor.toJson())
                .put("exportSessionId", SosDeviceKeyCrypto.normalizeHex(exportSessionId))
                .put("committedBatchSeq", committedBatchSeq)
                .put("updatedAtMs", updatedAtMs)

        companion object {
            fun fromJson(o: JSONObject): Checkpoint? {
                if (o.optInt("v", 0) != 1) return null
                val cursor = SosHistoryPagination.Cursor.fromJson(o.optJSONObject("cursor")) ?: return null
                val accountP = SosDeviceKeyCrypto.normalizeHex(o.optString("accountP"))
                val deviceId = SosDeviceKeyCrypto.normalizeHex(o.optString("deviceId"))
                val authorizationId = SosDeviceKeyCrypto.normalizeHex(o.optString("authorizationId"))
                if (!SosDeviceKeyCrypto.isHex64(accountP) || !SosDeviceKeyCrypto.isHex64(deviceId) ||
                    !SosDeviceKeyCrypto.isHex64(authorizationId)
                ) {
                    return null
                }
                return Checkpoint(
                    accountP = accountP,
                    deviceId = deviceId,
                    authorizationId = authorizationId,
                    authEpoch = o.optLong("authEpoch", -1L),
                    collectionId = o.optString("collectionId", "hist-bootstrap-v1"),
                    cursor = cursor,
                    exportSessionId = SosDeviceKeyCrypto.normalizeHex(o.optString("exportSessionId")),
                    committedBatchSeq = o.optLong("committedBatchSeq", -1L),
                    updatedAtMs = o.optLong("updatedAtMs", 0L),
                )
            }
        }
    }

    private fun key(accountP: String, deviceId: String, collectionId: String): String =
        KEY_PREFIX +
            SosDeviceKeyCrypto.normalizeHex(accountP) + ':' +
            SosDeviceKeyCrypto.normalizeHex(deviceId) + ':' +
            collectionId

    fun load(context: Context, accountP: String, deviceId: String, collectionId: String = "hist-bootstrap-v1"): Checkpoint? {
        val raw =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(key(accountP, deviceId, collectionId), null)
                ?: return null
        return try {
            fromValidated(JSONObject(raw), accountP, deviceId)
        } catch (_e: Exception) {
            null
        }
    }

    fun fromValidated(o: JSONObject, accountP: String, deviceId: String): Checkpoint? {
        val ck = Checkpoint.fromJson(o) ?: return null
        if (SosDeviceKeyCrypto.normalizeHex(ck.accountP) != SosDeviceKeyCrypto.normalizeHex(accountP)) return null
        if (SosDeviceKeyCrypto.normalizeHex(ck.deviceId) != SosDeviceKeyCrypto.normalizeHex(deviceId)) return null
        return ck
    }

    fun saveAtomic(context: Context, checkpoint: Checkpoint): Boolean {
        return try {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val k = key(checkpoint.accountP, checkpoint.deviceId, checkpoint.collectionId)
            prefs.edit().putString(k, checkpoint.toJson().toString()).commit()
        } catch (_e: Exception) {
            false
        }
    }

    fun clear(context: Context, accountP: String, deviceId: String, collectionId: String = "hist-bootstrap-v1") {
        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .remove(key(accountP, deviceId, collectionId))
                .commit()
        } catch (_e: Exception) {
        }
    }

    fun bindMatches(auth: SosDeviceAuthorization.Authorization, ck: Checkpoint): String? {
        if (SosDeviceKeyCrypto.normalizeHex(auth.accountP) != ck.accountP) return "CHECKPOINT_ACCOUNT_MISMATCH"
        if (SosDeviceKeyCrypto.normalizeHex(auth.deviceId) != ck.deviceId) return "CHECKPOINT_DEVICE_MISMATCH"
        if (SosDeviceKeyCrypto.normalizeHex(auth.authorizationId) != ck.authorizationId) {
            return "CHECKPOINT_AUTHORIZATION_MISMATCH"
        }
        if (auth.authEpoch != ck.authEpoch) return "CHECKPOINT_AUTH_EPOCH_MISMATCH"
        return null
    }
}
