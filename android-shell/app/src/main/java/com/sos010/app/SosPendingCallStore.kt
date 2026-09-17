package com.sos010.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Pending incoming call storage.
 * Secure 1059 wraps: bounded opaque queue (encrypted events only) until WebView drains.
 * Legacy 25050: single KEY_RAW_EVENT with peer metadata.
 */
object SosPendingCallStore {
    private const val PREFS = "sos_pending_call"
    private const val KEY_JSON = "pending_json"
    private const val KEY_RAW_EVENT = "pending_raw_event"
    private const val KEY_SECURE_QUEUE = "secure_wrap_queue"
    private const val TTL_MS = 120_000L
    private const val SECURE_QUEUE_MAX = 32
    private const val SECURE_EVENT_MAX_CHARS = 200_000

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
            .put("secure", false)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_RAW_EVENT, meta.toString())
            .apply()
    }

    /**
     * Enqueue opaque Gift Wrap (kind 1059). Dedupes by outer event id.
     * Does NOT store peer/media/SDP plaintext. Returns true if newly queued.
     */
    fun enqueueSecureWrap(context: Context, eventJson: String?): Boolean {
        val raw = eventJson?.trim().orEmpty()
        if (raw.isEmpty() || raw.length > SECURE_EVENT_MAX_CHARS) return false
        val eventId = extractIdFromEventJson(raw) ?: return false
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val queue = loadSecureQueue(prefs, now)
        for (i in 0 until queue.length()) {
            val item = queue.optJSONObject(i) ?: continue
            if (item.optString("id") == eventId) return false
        }
        while (queue.length() >= SECURE_QUEUE_MAX) {
            queue.remove(0)
        }
        queue.put(
            JSONObject()
                .put("id", eventId)
                .put("savedAt", now)
                .put("event", raw)
        )
        prefs.edit().putString(KEY_SECURE_QUEUE, queue.toString()).apply()
        return true
    }

    /** @deprecated Prefer enqueueSecureWrap — kept for callers; enqueues without overwrite. */
    fun saveSecureWrap(context: Context, eventJson: String?) {
        enqueueSecureWrap(context, eventJson)
    }

    /**
     * After JS authenticates an offer — bind peer/media for answer hydrate.
     * Still stores only the outer encrypted event (no SDP plaintext here).
     */
    fun updateSecureWrapPeer(context: Context, peer: String?, callType: String?, eventJson: String? = null) {
        val pk = peer?.trim()?.lowercase().orEmpty()
        if (pk.length != 64) return
        val rawEvent = eventJson?.trim().orEmpty().ifBlank {
            // Prefer first queued wrap matching nothing — use active KEY_RAW_EVENT or first queue item
            val drainedHint = getRawEventJson(context)
            if (drainedHint.isNotBlank()) {
                try {
                    JSONObject(drainedHint).optString("event").ifBlank {
                        val asObj = JSONObject(drainedHint).optJSONObject("event")
                        asObj?.toString().orEmpty()
                    }
                } catch (_: Exception) {
                    ""
                }
            } else {
                ""
            }
        }
        val meta = JSONObject()
            .put("peer", pk)
            .put("callType", normalizeType(callType))
            .put("savedAt", System.currentTimeMillis())
            .put("secure", true)
        if (rawEvent.isNotBlank()) meta.put("event", rawEvent)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_RAW_EVENT, meta.toString())
            .apply()
    }

    /** Drain all valid queued secure wraps (encrypted only). Clears queue. */
    fun drainSecureWraps(context: Context): JSONArray {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val queue = loadSecureQueue(prefs, now)
        prefs.edit().remove(KEY_SECURE_QUEUE).apply()
        return queue
    }

    fun peekSecureWrapCount(context: Context): Int {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return loadSecureQueue(prefs, System.currentTimeMillis()).length()
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

    /** event נשמר כמחרוזת JSON או כאובייקט – חילוץ id לסימון handled | HYPER CORE TECH */
    fun extractEventId(context: Context): String? {
        val raw = getRawEventJson(context)
        if (raw.isBlank()) return null
        return try {
            val meta = JSONObject(raw)
            val asObj = meta.optJSONObject("event")
            if (asObj != null) {
                return asObj.optString("id").trim().takeIf { it.length >= 8 }
            }
            val asStr = meta.optString("event").trim()
            if (asStr.isNotEmpty()) {
                return JSONObject(asStr).optString("id").trim().takeIf { it.length >= 8 }
            }
            null
        } catch (_: Exception) {
            null
        }
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_JSON)
            .remove(KEY_RAW_EVENT)
            .remove(KEY_SECURE_QUEUE)
            .apply()
    }

    private fun loadSecureQueue(prefs: android.content.SharedPreferences, now: Long): JSONArray {
        val raw = prefs.getString(KEY_SECURE_QUEUE, "").orEmpty()
        val out = JSONArray()
        if (raw.isBlank()) return out
        return try {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                val item = arr.optJSONObject(i) ?: continue
                val at = item.optLong("savedAt", 0L)
                if (at <= 0L || now - at > TTL_MS) continue
                val id = item.optString("id").trim()
                val event = item.optString("event").trim()
                if (id.length < 8 || event.isEmpty()) continue
                out.put(
                    JSONObject()
                        .put("id", id)
                        .put("savedAt", at)
                        .put("event", event)
                )
            }
            out
        } catch (_: Exception) {
            JSONArray()
        }
    }

    private fun extractIdFromEventJson(eventJson: String): String? {
        return try {
            JSONObject(eventJson).optString("id").trim().takeIf { it.length >= 8 }
        } catch (_: Exception) {
            null
        }
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
            "secure" -> "secure"
            else -> "voice"
        }
    }
}
