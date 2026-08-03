package com.sos010.app

import android.content.Context
import org.json.JSONObject

/**
 * שמירת offer שיחה נכנסת (אחרי פענוח ב-Web) כדי לשחזר מסך ענה אחרי resume/deep-link.
 */
object SosPendingCallStore {
    private const val PREFS = "sos_pending_call"
    private const val KEY_JSON = "pending_json"
    private const val TTL_MS = 90_000L

    fun save(context: Context, peer: String?, callType: String?, offerJson: String?) {
        val pk = peer?.trim()?.lowercase().orEmpty()
        val offer = offerJson?.trim().orEmpty()
        if (pk.length != 64 || offer.isEmpty()) return
        val type = when (callType?.trim()?.lowercase()) {
            "video", "v", "v-offer" -> "video"
            else -> "voice"
        }
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

    fun getJson(context: Context): String {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_JSON, "")
            .orEmpty()
        if (raw.isBlank()) return ""
        return try {
            val obj = JSONObject(raw)
            val at = obj.optLong("savedAt", 0L)
            if (at <= 0L || System.currentTimeMillis() - at > TTL_MS) {
                clear(context)
                ""
            } else raw
        } catch (_: Exception) {
            clear(context)
            ""
        }
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_JSON)
            .apply()
    }
}
