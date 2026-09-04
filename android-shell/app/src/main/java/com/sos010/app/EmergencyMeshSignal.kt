package com.sos010.app

import org.json.JSONObject

/**
 * אות WebRTC רק ליעד — לא שידור לכל הרשת. | HYPER CORE TECH
 */
object EmergencyMeshSignal {
    const val TYPE = "webrtc_signal"

    fun normalizePubkey(raw: String): String = raw.trim().lowercase()

    fun isValidTarget(pubkey: String): Boolean {
        val pk = normalizePubkey(pubkey)
        return pk.length == 64 && pk.all { it in '0'..'9' || it in 'a'..'f' }
    }

    fun routeTarget(targetPubkey: String, store: EmergencyMeshStore): Pair<String, String>? {
        val pk = normalizePubkey(targetPubkey)
        if (!isValidTarget(pk) && pk != TARGET_BROADCAST) return null
        if (pk.isBlank() || pk == TARGET_BROADCAST) return null
        return EmergencyMeshPeers.resolveTarget(pk, store)
    }

    fun wrap(
        targetPubkey: String,
        signalJson: String,
        fromPubkey: String,
        fromIp: String
    ): String? {
        val pk = normalizePubkey(targetPubkey)
        if (pk.isBlank()) return null
        return try {
            val signal = try {
                JSONObject(signalJson)
            } catch (_: Exception) {
                JSONObject().put("raw", signalJson)
            }
            JSONObject()
                .put("type", TYPE)
                .put("target", pk)
                .put("signal", signal)
                .put("from", fromIp)
                .put("fromPubkey", normalizePubkey(fromPubkey))
                .toString()
        } catch (_: Exception) {
            null
        }
    }

    fun shouldDeliverToSelf(selfPubkey: String, payload: String): Boolean {
        return try {
            val o = JSONObject(payload)
            if (o.optString("type") != TYPE) return true
            val target = normalizePubkey(o.optString("target"))
            val self = normalizePubkey(selfPubkey)
            if (target.isBlank()) return false
            target == self
        } catch (_: Exception) {
            true
        }
    }
}
