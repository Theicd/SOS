package com.sos010.app

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Durable outer kind-1059 event-id store for replay/wake suppression.
 * Stores ONLY event ids + timestamps — no peer/media/ciphertext.
 *
 * PENDING wraps stay in SosPendingCallStore until drained.
 * HANDLED means processing completed or deterministic rejection.
 */
object SosSecureWrapHandledStore {
    private const val TAG = "SecureWrapHandled"
    private const val PREFS = "sos_secure_wrap_handled"
    private const val KEY_JSON = "handled_json"
    private const val MAX_ENTRIES = 768
    private const val TTL_MS = 72L * 60L * 60L * 1000L // 72h > NIP-59 ~2d lookback

    fun isHandled(context: Context, eventId: String?): Boolean {
        val id = normalizeId(eventId) ?: return false
        val now = System.currentTimeMillis()
        val arr = loadPruned(context, now)
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            if (item.optString("id") == id) return true
        }
        return false
    }

    fun markHandled(context: Context, eventId: String?) {
        val id = normalizeId(eventId) ?: return
        val now = System.currentTimeMillis()
        val arr = loadPruned(context, now)
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            if (item.optString("id") == id) {
                item.put("at", now)
                persist(context, arr)
                return
            }
        }
        while (arr.length() >= MAX_ENTRIES) {
            arr.remove(0)
        }
        arr.put(JSONObject().put("id", id).put("at", now))
        persist(context, arr)
        Log.i(TAG, "SECURE_WAKE_HANDLED_STORE_MARK")
    }

    fun markHandledMany(context: Context, eventIds: Collection<String?>) {
        eventIds.forEach { markHandled(context, it) }
    }

    fun prune(context: Context) {
        val before = loadRaw(context).length()
        val after = loadPruned(context, System.currentTimeMillis()).length()
        if (before != after) {
            Log.i(TAG, "SECURE_WAKE_HANDLED_STORE_PRUNE")
            SosDebugLog.i("relay", "SECURE_WAKE_HANDLED_STORE_PRUNE")
        }
    }

    private fun loadPruned(context: Context, now: Long): JSONArray {
        val raw = loadRaw(context)
        val next = JSONArray()
        for (i in 0 until raw.length()) {
            val item = raw.optJSONObject(i) ?: continue
            val id = item.optString("id").trim()
            val at = item.optLong("at", 0L)
            if (id.length < 8) continue
            if (at <= 0L || now - at > TTL_MS) continue
            next.put(JSONObject().put("id", id).put("at", at))
        }
        if (next.length() != raw.length()) {
            persist(context, next)
        }
        return next
    }

    private fun loadRaw(context: Context): JSONArray {
        val s = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_JSON, "[]")
            .orEmpty()
        return try {
            JSONArray(s)
        } catch (_: Exception) {
            JSONArray()
        }
    }

    private fun persist(context: Context, arr: JSONArray) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_JSON, arr.toString())
            .apply()
    }

    private fun normalizeId(eventId: String?): String? {
        val id = eventId?.trim()?.lowercase().orEmpty()
        return if (id.length >= 8) id else null
    }
}
