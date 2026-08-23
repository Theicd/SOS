package com.sos010.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * סשן שיחה נכנסת.
 * חוסמים רק את אותו event-id / offer ישן לפי זמן – לא חוסמים peer שלם (שיחה חדשה מותרת תמיד).
 */
object SosIncomingCallSession {
    private const val PREFS = "sos_incoming_call_session"
    private const val KEY_ACTIVE_PEER = "active_peer"
    private const val KEY_ACTIVE_TYPE = "active_type"
    private const val KEY_ACTIVE_AT = "active_at"
    private const val KEY_ACTIVE_PHASE = "active_phase"
    private const val KEY_HANDLED_OFFERS = "handled_offers_json"
    private const val PHASE_RINGING = "ringing"
    private const val PHASE_ANSWERED = "answered"
    /** בזמן שיחה פעילה – לא לפתוח צלצול native כפול לאותו peer | HYPER CORE TECH */
    private const val ACTIVE_TTL_MS = 45 * 60_000L
    private const val HANDLED_OFFER_TTL_MS = 600_000L
    private const val MAX_HANDLED_OFFERS = 80
    /** offer ישן יותר מזה (שניות) = ghost מהריליי, לא שיחה חדשה | HYPER CORE TECH */
    const val MAX_OFFER_AGE_SEC = 90L

    fun markRinging(context: Context, peer: String?, callType: String?) {
        val pk = normalizePeer(peer) ?: return
        val type = normalizeType(callType)
        clearLegacySuppress(context)
        // לא מחזירים ל־ringing אחרי ענה – מונע מסך ענה/צלצול באמצע שיחה | HYPER CORE TECH
        if (isAnsweredPhase(context) && isSameActiveCall(context, pk)) return
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_ACTIVE_PEER, pk)
            .putString(KEY_ACTIVE_TYPE, type)
            .putString(KEY_ACTIVE_PHASE, PHASE_RINGING)
            .putLong(KEY_ACTIVE_AT, System.currentTimeMillis())
            .apply()
    }

    fun markAnswered(context: Context, peer: String?) {
        // משאירים active – מונע צלצול native כפול בזמן שיחה; לא חוסמים שיחה חדשה אחר כך | HYPER CORE TECH
        clearLegacySuppress(context)
        val pk = normalizePeer(peer) ?: activePeer(context) ?: return
        val type = activeCallType(context)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_ACTIVE_PEER, pk)
            .putString(KEY_ACTIVE_TYPE, type)
            .putString(KEY_ACTIVE_PHASE, PHASE_ANSWERED)
            .putLong(KEY_ACTIVE_AT, System.currentTimeMillis())
            .apply()
    }

    fun markDeclined(context: Context, peer: String?) {
        clearLegacySuppress(context)
        clearActive(context)
    }

    fun markRemoteEnded(context: Context, peer: String?) {
        clearLegacySuppress(context)
        clearActive(context)
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

    /** בוטל – דיכוי peer חסם שיחות חדשות לגיטימיות. נשאר לתאימות גשר JS. */
    fun isSuppressed(context: Context, peer: String?): Boolean {
        clearLegacySuppress(context)
        return false
    }

    fun isSameActiveCall(context: Context, peer: String?): Boolean {
        val pk = normalizePeer(peer) ?: return false
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val at = prefs.getLong(KEY_ACTIVE_AT, 0L)
        if (at <= 0L || System.currentTimeMillis() - at > ACTIVE_TTL_MS) return false
        return prefs.getString(KEY_ACTIVE_PEER, "")?.lowercase() == pk
    }

    /** רק בשלב צלצול – לא אחרי ענה (מונע reinject של incomingCall ב־onResume) | HYPER CORE TECH */
    fun isRingingPhase(context: Context): Boolean {
        if (activePeer(context).isNullOrBlank()) return false
        val phase = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_ACTIVE_PHASE, PHASE_RINGING)
        return phase != PHASE_ANSWERED
    }

    fun isAnsweredPhase(context: Context): Boolean {
        if (activePeer(context).isNullOrBlank()) return false
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_ACTIVE_PHASE, "") == PHASE_ANSWERED
    }

    /** peer שמצלצל כרגע – null אם כבר נענתה / אין סשן | HYPER CORE TECH */
    fun ringingPeer(context: Context): String? {
        if (!isRingingPhase(context)) return null
        return activePeer(context)
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
            .remove(KEY_ACTIVE_PHASE)
            .apply()
    }

    /** מנקה דיכוי peer ישן מגרסאות קודמות שחסמו שיחות חוזרות | HYPER CORE TECH */
    private fun clearLegacySuppress(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove("suppress_peer")
            .remove("suppress_until")
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
