package com.sos010.app

import android.content.Context

/**
 * שם תחנה ייחודי + סטטוס אשף הגדרה חד-פעמי | HYPER CORE TECH
 */
object SosEmergencySetup {
    private const val PREFS = "sos_emergency_setup"
    private const val KEY_READY = "station_ready"

    const val SSID_PREFIX = "SOS-"

    fun stationSsid(context: Context): String {
        val pk = SosSessionStore.getPubkey(context)
        if (pk.length >= 4) {
            return SSID_PREFIX + pk.take(4).uppercase()
        }
        return SosEmergencyState.NETWORK_NAME
    }

    fun isSosSsid(ssid: String?): Boolean {
        val s = ssid?.trim()?.removeSurrounding("\"")?.trim().orEmpty()
        if (s.isEmpty()) return false
        return s.startsWith("SOS", ignoreCase = true)
    }

    fun isComplete(context: Context): Boolean {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(KEY_READY, false)
    }

    fun markComplete(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_READY, true)
            .apply()
    }
}
