package com.sos010.app

import android.content.Context

/**
 * שמירת מזהה המשתמש לשימוש בשירות הרקע (בלי WebView).
 */
object SosSessionStore {
    private const val PREFS = "sos_native_session"
    private const val KEY_PUBKEY = "pubkey"
    private const val KEY_LAST_URL = "last_web_url"
    private const val KEY_LAST_URL_AT = "last_web_url_at"
    private const val LAST_URL_TTL_MS = 7L * 24 * 60 * 60 * 1000

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

    /** שומר את כתובת ה-Web האחרונה לחזרה מהירה אחרי שהמערכת הורגת את התהליך | HYPER CORE TECH */
    fun setLastUrl(context: Context, url: String?) {
        val clean = url?.trim().orEmpty()
        if (clean.isEmpty() || !clean.startsWith("http")) return
        if (clean.startsWith("about:") || clean.contains("blank")) return
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_LAST_URL, clean)
            .putLong(KEY_LAST_URL_AT, System.currentTimeMillis())
            .apply()
    }

    fun getLastUrl(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val at = prefs.getLong(KEY_LAST_URL_AT, 0L)
        if (at <= 0L || System.currentTimeMillis() - at > LAST_URL_TTL_MS) return ""
        return prefs.getString(KEY_LAST_URL, "")?.trim().orEmpty()
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_PUBKEY)
            .remove(KEY_LAST_URL)
            .remove(KEY_LAST_URL_AT)
            .apply()
        SosPendingCallStore.clear(context)
    }
}
