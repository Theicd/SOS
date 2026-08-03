package com.sos010.app

import android.content.Context

/**
 * סשן שיחה נכנסת – מונע צלצול חוזר אחרי דחייה/ניתוק מהצד השני.
 */
object SosIncomingCallSession {
    private const val PREFS = "sos_incoming_call_session"
    private const val KEY_ACTIVE_PEER = "active_peer"
    private const val KEY_ACTIVE_TYPE = "active_type"
    private const val KEY_ACTIVE_AT = "active_at"
    private const val KEY_SUPPRESS_PEER = "suppress_peer"
    private const val KEY_SUPPRESS_UNTIL = "suppress_until"
    private const val SUPPRESS_AFTER_END_MS = 8_000L
    private const val ACTIVE_TTL_MS = 90_000L

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
        // אחרי מענה – לא מדכאים (שיחה חיה), רק מנקים active
        if (!peer.isNullOrBlank()) {
            // no-op beyond clearActive
        }
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
