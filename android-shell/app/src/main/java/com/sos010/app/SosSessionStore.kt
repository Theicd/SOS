package com.sos010.app

import android.content.Context

/**
 * שמירת מזהה המשתמש לשימוש בשירות הרקע (בלי WebView).
 */
object SosSessionStore {
    private const val PREFS = "sos_native_session"
    private const val KEY_PUBKEY = "pubkey"

    fun setPubkey(context: Context, pubkey: String?) {
        val normalized = pubkey?.trim()?.lowercase().orEmpty()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_PUBKEY, if (normalized.matches(Regex("^[0-9a-f]{64}$"))) normalized else "")
            .apply()
    }

    fun getPubkey(context: Context): String {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_PUBKEY, "")
            ?.trim()
            ?.lowercase()
            .orEmpty()
    }

    fun clear(context: Context) {
        setPubkey(context, null)
    }
}
