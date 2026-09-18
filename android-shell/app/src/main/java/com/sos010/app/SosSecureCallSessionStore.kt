package com.sos010.app

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/**
 * Durable short-lived secure call SESSION tombstones.
 * Key = SHA-256(sessionId). Stores ONLY hash + state + timestamp.
 * Suppresses ring/UI for DECLINED / ENDED sessions across process restart.
 */
object SosSecureCallSessionStore {
    private const val TAG = "SecureCallSession"
    private const val PREFS = "sos_secure_call_sessions"
    private const val KEY_JSON = "sessions_json"
    private const val MAX_ENTRIES = 128
    private const val TTL_MS = 3L * 60L * 1000L // 3 minutes within 2–5m window

    const val STATE_DECLINED = "DECLINED"
    const val STATE_ENDED = "ENDED"
    const val STATE_CONNECTED_END = "CONNECTED_END"

    fun isTombstoned(context: Context, sessionId: String?): Boolean {
        val hash = hashSessionId(sessionId) ?: return false
        prune(context)
        val arr = loadRaw(context)
        val now = System.currentTimeMillis()
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            if (item.optString("h") != hash) continue
            val at = item.optLong("at", 0L)
            if (at <= 0L || now - at > TTL_MS) continue
            val st = item.optString("st")
            if (st == STATE_DECLINED || st == STATE_ENDED || st == STATE_CONNECTED_END) {
                return true
            }
        }
        return false
    }

    fun mark(context: Context, sessionId: String?, state: String): Boolean {
        val hash = hashSessionId(sessionId) ?: return false
        val st = when (state.trim().uppercase()) {
            STATE_DECLINED -> STATE_DECLINED
            STATE_CONNECTED_END -> STATE_CONNECTED_END
            else -> STATE_ENDED
        }
        val now = System.currentTimeMillis()
        val arr = loadPruned(context, now)
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            if (item.optString("h") == hash) {
                // Terminal states never downgrade.
                val prev = item.optString("st")
                if (prev == STATE_DECLINED || prev == STATE_ENDED || prev == STATE_CONNECTED_END) {
                    item.put("at", now)
                    persist(context, arr)
                    return true
                }
                item.put("st", st)
                item.put("at", now)
                persist(context, arr)
                logState(st)
                return true
            }
        }
        while (arr.length() >= MAX_ENTRIES) {
            arr.remove(0)
        }
        arr.put(JSONObject().put("h", hash).put("st", st).put("at", now))
        persist(context, arr)
        logState(st)
        return true
    }

    fun rememberActiveSession(context: Context, sessionId: String?) {
        val hash = hashSessionId(sessionId) ?: return
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString("active_h", hash)
            .putLong("active_at", System.currentTimeMillis())
            .apply()
        Log.i(TAG, "CALL_SESSION_NEW")
        SosDebugLog.i("call", "CALL_SESSION_NEW")
    }

    fun activeSessionHash(context: Context): String? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val at = prefs.getLong("active_at", 0L)
        if (at <= 0L || System.currentTimeMillis() - at > TTL_MS) return null
        return prefs.getString("active_h", null)?.takeIf { it.length == 64 }
    }

    fun markActiveDeclined(context: Context) {
        val hash = activeSessionHash(context) ?: return
        markByHash(context, hash, STATE_DECLINED)
    }

    fun markByHash(context: Context, hash: String?, state: String) {
        val h = hash?.trim()?.lowercase().orEmpty()
        if (h.length != 64) return
        val now = System.currentTimeMillis()
        val arr = loadPruned(context, now)
        val st = when (state.trim().uppercase()) {
            STATE_DECLINED -> STATE_DECLINED
            STATE_CONNECTED_END -> STATE_CONNECTED_END
            else -> STATE_ENDED
        }
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            if (item.optString("h") == h) {
                item.put("st", st)
                item.put("at", now)
                persist(context, arr)
                logState(st)
                return
            }
        }
        while (arr.length() >= MAX_ENTRIES) arr.remove(0)
        arr.put(JSONObject().put("h", h).put("st", st).put("at", now))
        persist(context, arr)
        logState(st)
    }

    fun hasRingedSession(context: Context, sessionId: String?): Boolean {
        val hash = hashSessionId(sessionId) ?: return false
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString("ringed_json", "[]").orEmpty()
        val arr = try { JSONArray(raw) } catch (_: Exception) { JSONArray() }
        val now = System.currentTimeMillis()
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            if (item.optString("h") == hash) {
                val at = item.optLong("at", 0L)
                return at > 0L && now - at <= TTL_MS
            }
        }
        return false
    }

    fun markRinged(context: Context, sessionId: String?): Boolean {
        val hash = hashSessionId(sessionId) ?: return false
        if (hasRingedSession(context, sessionId)) return false
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val arr = try {
            JSONArray(prefs.getString("ringed_json", "[]"))
        } catch (_: Exception) {
            JSONArray()
        }
        val now = System.currentTimeMillis()
        val next = JSONArray()
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            val at = item.optLong("at", 0L)
            if (at > 0L && now - at <= TTL_MS) next.put(item)
        }
        while (next.length() >= MAX_ENTRIES) next.remove(0)
        next.put(JSONObject().put("h", hash).put("at", now))
        prefs.edit().putString("ringed_json", next.toString()).apply()
        Log.i(TAG, "CALL_RING_AUTH_ONCE")
        SosDebugLog.i("call", "CALL_RING_AUTH_ONCE")
        return true
    }

    fun prune(context: Context) {
        loadPruned(context, System.currentTimeMillis())
    }

    fun hashSessionId(sessionId: String?): String? {
        val sid = sessionId?.trim().orEmpty()
        if (sid.length < 32) return null
        return try {
            val digest = MessageDigest.getInstance("SHA-256")
            digest.update(sid.toByteArray(Charsets.UTF_8))
            digest.digest().joinToString("") { b -> "%02x".format(b) }
        } catch (_: Exception) {
            null
        }
    }

    private fun logState(st: String) {
        when (st) {
            STATE_DECLINED -> {
                Log.i(TAG, "CALL_SESSION_DECLINED")
                SosDebugLog.i("call", "CALL_SESSION_DECLINED")
            }
            STATE_CONNECTED_END -> {
                Log.i(TAG, "CALL_SESSION_ENDED")
                SosDebugLog.i("call", "CALL_SESSION_ENDED")
            }
            else -> {
                Log.i(TAG, "CALL_SESSION_ENDED")
                SosDebugLog.i("call", "CALL_SESSION_ENDED")
            }
        }
    }

    private fun loadPruned(context: Context, now: Long): JSONArray {
        val raw = loadRaw(context)
        val next = JSONArray()
        for (i in 0 until raw.length()) {
            val item = raw.optJSONObject(i) ?: continue
            val h = item.optString("h").trim()
            val at = item.optLong("at", 0L)
            val st = item.optString("st")
            if (h.length != 64) continue
            if (at <= 0L || now - at > TTL_MS) continue
            next.put(JSONObject().put("h", h).put("st", st).put("at", at))
        }
        if (next.length() != raw.length()) persist(context, next)
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
}
