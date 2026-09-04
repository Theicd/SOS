package com.sos010.app

import android.content.Context

/**
 * שם תחנה ייחודי + סטטוס אשף הגדרה חד-פעמי | HYPER CORE TECH
 */
object SosEmergencySetup {
    private const val PREFS = "sos_emergency_setup"
    private const val KEY_READY = "station_ready"
    private const val KEY_INSTALL_NODE = "install_node_id"

    const val SSID_PREFIX = "SOS-"

    fun stationSsid(context: Context): String {
        val pk = SosSessionStore.getPubkey(context)
        if (pk.length >= 4) {
            return SSID_PREFIX + pk.take(4).uppercase()
        }
        return SosEmergencyState.NETWORK_NAME
    }

    /** SSID מ-pubkey — אותו כלל כמו stationSsid | HYPER CORE TECH */
    fun ssidFromPubkey(pubkey: String): String? {
        if (pubkey.length >= 4) {
            return SSID_PREFIX + pubkey.take(4).uppercase()
        }
        return null
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

    fun installNodeId(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val existing = prefs.getString(KEY_INSTALL_NODE, "")?.trim().orEmpty()
        if (existing.isNotBlank()) return existing
        val created = EmergencyMeshIdentity.newInstallId()
        prefs.edit().putString(KEY_INSTALL_NODE, created).apply()
        return created
    }

    fun currentIdentity(context: Context, bootId: String): EmergencyNodeIdentity {
        val pubkey = SosSessionStore.getPubkey(context)
        val nodeId = EmergencyMeshIdentity.nodeIdFrom(pubkey, installNodeId(context))
        return EmergencyNodeIdentity(
            nodeId = nodeId,
            pubkey = if (EmergencyMeshIdentity.isValidPubkey(pubkey)) pubkey else "",
            bootId = bootId,
            stationSsid = stationSsid(context)
        )
    }
}
