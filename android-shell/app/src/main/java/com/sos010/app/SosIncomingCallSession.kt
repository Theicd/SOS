package com.sos010.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * סשן שיחה נכנסת – מונע צלצול חוזר אחרי דחייה/ניתוק/offer ישן מהריליי.
 */
object SosIncomingCallSession {
    private const val PREFS = "sos_incoming_call_session"
    private const val KEY_ACTIVE_PEER = "active_peer"
    private const val KEY_ACTIVE_TYPE = "active_type"
    private const val KEY_ACTIVE_AT = "active_at"
    private const val KEY_SUPPRESS_PEER = "suppress_peer"
    private const val KEY_SUPPRESS_UNTIL = "suppress_until"
    private const val KEY_HANDLED_OFFERS = "handled_offers_json"
    /** דיכוי אחרי סיום/דחייה – מונע ghost ring מ־offer ישן בריליי | HYPER CORE TECH */
    private const val SUPPRESS_AFTER_END_MS = 180_000L
    private const val ACTIVE_TTL_MS = 90_000L
    private const val HANDLED_OFFER_TTL_MS = 600_000L
    private const val MAX_HANDLED_OFFERS = 80
    /** offer ישן יותר מזה (שניות) לא מצלצל | HYPER CORE TECH */
    const val MAX_OFFER_AGE_SEC = 60L

    fun markRinging(context: Context, peer: String?, callType: String?) {
        val pk = normalizePeer(peer) ?: return
        val type = normalizeType(callType)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_ACTIVE_PEER, pk)
            .putString(KEY_ACTIVE_TYPE, type)
            .putLong(KEY_ACTIVE_AT, System.currentTimeMillis())
            .apply()
    }

    fun markAnswered(context: Context, peer: String?) {
        clearActive(context)
        // בזמן שיחה חיה לא מדכאים – דיכוי בסיום (markRemoteEnded / hangup)
    }

    fun markDeclined(context: Context, peer: String?) {
        val pk = normalizePeer(peer) ?: activePeer(context)
        clearActive(context)
        if (!pk.isNullOrBlank()) suppress(context, pk)
    }

    fun markRemoteEnded(context: Context, peer: String?) {
        val pk = normalizePeer(peer) ?: activePeer(context)
        clearActive(context)
        if (!pk.isNullOrBlank()) suppress(context, pk)
    }

    fun rememberHandledOffer(context: Context, eventId: String?) {
        val id = eventId?.trim().orEmpty()
        if (id.length < 8) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val arr = try {
            JSONArray(prefs.getString(KEY_HANDLED_OFFERS, "[]"))
        } catch (_: Exception) {
            JSONArray()
        }
        val next = JSONArray()
        var found = false
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val eid = o.optString("id")
            val at = o.optLong("at", 0L)
            if (at <= 0L || now - at > HANDLED_OFFER_TTL_MS) continue
            if (eid == id) {
                found = true
                next.put(JSONObject().put("id", eid).put("at", now))
            } else {
                next.put(o)
            }
        }
        if (!found) {
            next.put(JSONObject().put("id", id).put("at", now))
        }
        while (next.length() > MAX_HANDLED_OFFERS) {
            next.remove(0)
        }
        prefs.edit().putString(KEY_HANDLED_OFFERS, next.toString()).apply()
    }

    fun isHandledOffer(context: Context, eventId: String?): Boolean {
        val id = eventId?.trim().orEmpty()
        if (id.length < 8) return false
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val arr = try {
            JSONArray(prefs.getString(KEY_HANDLED_OFFERS, "[]"))
        } catch (_: Exception) {
            return false
        }
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (o.optString("id") != id) continue
            val at = o.optLong("at", 0L)
            return at > 0L && now - at <= HANDLED_OFFER_TTL_MS
        }
        return false
    }

    fun isOfferTooOld(createdAtSec: Long): Boolean {
        if (createdAtSec <= 0L) return false
        val age = (System.currentTimeMillis() / 1000L) - createdAtSec
        return age > MAX_OFFER_AGE_SEC
    }

    fun isSuppressed(context: Context, peer: String?): Boolean {
        val pk = normalizePeer(peer) ?: return false
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val until = prefs.getLong(KEY_SUPPRESS_UNTIL, 0L)
        val suppressedPeer = prefs.getString(KEY_SUPPRESS_PEER, "")?.lowercase().orEmpty()
        if (until <= 0L || System.currentTimeMillis() > until) return false
        return suppressedPeer == pk
    }

    fun isSameActiveCall(context: Context, peer: String?): Boolean {
        val pk = normalizePeer(peer) ?: return false
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val at = prefs.getLong(KEY_ACTIVE_AT, 0L)
        if (at <= 0L || System.currentTimeMillis() - at > ACTIVE_TTL_MS) return false
        return prefs.getString(KEY_ACTIVE_PEER, "")?.lowercase() == pk
    }

    fun activePeer(context: Context): String? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val at = prefs.getLong(KEY_ACTIVE_AT, 0L)
        if (at <= 0L || System.currentTimeMillis() - at > ACTIVE_TTL_MS) return null
        return prefs.getString(KEY_ACTIVE_PEER, "")?.trim()?.lowercase()?.takeIf { it.length == 64 }
    }

    fun activeCallType(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val at = prefs.getLong(KEY_ACTIVE_AT, 0L)
        if (at <= 0L || System.currentTimeMillis() - at > ACTIVE_TTL_MS) return "voice"
        return when (prefs.getString(KEY_ACTIVE_TYPE, "voice")?.lowercase()) {
            "video" -> "video"
            else -> "voice"
        }
    }

    fun clearActive(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_ACTIVE_PEER)
            .remove(KEY_ACTIVE_TYPE)
            .remove(KEY_ACTIVE_AT)
            .apply()
    }

    private fun suppress(context: Context, peer: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SUPPRESS_PEER, peer)
            .putLong(KEY_SUPPRESS_UNTIL, System.currentTimeMillis() + SUPPRESS_AFTER_END_MS)
            .apply()
    }

    private fun normalizePeer(peer: String?): String? {
        val pk = peer?.trim()?.lowercase().orEmpty()
        return if (pk.matches(Regex("^[0-9a-f]{64}$"))) pk else null
    }

    private fun normalizeType(callType: String?): String {
        return when (callType?.trim()?.lowercase()) {
            "video", "v", "v-offer" -> "video"
            else -> "voice"
        }
    }
}
