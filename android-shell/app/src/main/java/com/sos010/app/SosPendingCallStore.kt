package com.sos010.app

import android.content.Context
import org.json.JSONObject

/**
 * שמירת offer שיחה נכנסת + אירוע Nostr גולמי (מוצפן) מה-RelayWatcher
 * כדי לענות גם כשהמסך היה כבוי וה-Web לא קיבל SDP בזמן אמת.
 */
object SosPendingCallStore {
    private const val PREFS = "sos_pending_call"
    private const val KEY_JSON = "pending_json"
    private const val KEY_RAW_EVENT = "pending_raw_event"
    private const val TTL_MS = 120_000L

    fun save(context: Context, peer: String?, callType: String?, offerJson: String?) {
        val pk = peer?.trim()?.lowercase().orEmpty()
        val offer = offerJson?.trim().orEmpty()
        if (pk.length != 64 || offer.isEmpty()) return
        val type = normalizeType(callType)
        val payload = JSONObject()
            .put("peer", pk)
            .put("callType", type)
            .put("offer", offer)
            .put("savedAt", System.currentTimeMillis())
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_JSON, payload.toString())
            .apply()
    }

    /** שומר EVENT גולמי (kind 25050) לפני פענוח – לשימוש בלחיצת ענה מ-APK | HYPER CORE TECH */
    fun saveRawEvent(context: Context, peer: String?, callType: String?, eventJson: String?) {
        val pk = peer?.trim()?.lowercase().orEmpty()
        val raw = eventJson?.trim().orEmpty()
        if (pk.length != 64 || raw.isEmpty()) return
        val type = normalizeType(callType)
        val meta = JSONObject()
            .put("peer", pk)
            .put("callType", type)
            .put("savedAt", System.currentTimeMillis())
            .put("event", raw)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_RAW_EVENT, meta.toString())
            .apply()
    }

    fun getJson(context: Context): String {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_JSON, "")
            .orEmpty()
        if (raw.isBlank()) return ""
        return try {
            val obj = JSONObject(raw)
            val at = obj.optLong("savedAt", 0L)
            if (at <= 0L || System.currentTimeMillis() - at > TTL_MS) {
                clearDecrypted(context)
                ""
            } else raw
        } catch (_: Exception) {
            clearDecrypted(context)
            ""
        }
    }

    fun getRawEventJson(context: Context): String {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_RAW_EVENT, "")
            .orEmpty()
        if (raw.isBlank()) return ""
        return try {
            val obj = JSONObject(raw)
            val at = obj.optLong("savedAt", 0L)
            if (at <= 0L || System.currentTimeMillis() - at > TTL_MS) {
                clearRaw(context)
                ""
            } else raw
        } catch (_: Exception) {
            clearRaw(context)
            ""
        }
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_JSON)
            .remove(KEY_RAW_EVENT)
            .apply()
    }

    private fun clearDecrypted(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_JSON)
            .apply()
    }

    private fun clearRaw(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_RAW_EVENT)
            .apply()
    }

    private fun normalizeType(callType: String?): String {
        return when (callType?.trim()?.lowercase()) {
            "video", "v", "v-offer" -> "video"
            else -> "voice"
        }
    }
}
