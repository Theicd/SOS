package com.sos010.app

/**
 * STA ו-AP הם שני תפקידים, לא החלפת רשת. | HYPER CORE TECH
 */
data class EmergencyNetRoleSnapshot(
    val stationIp: String = "",
    val hotspotIp: String = ""
) {
    fun primary(): String = stationIp.ifBlank { hotspotIp }

    fun owns(ip: String?): Boolean {
        if (ip.isNullOrBlank()) return false
        return ip == stationIp || ip == hotspotIp
    }
}

object EmergencyMeshNetRole {
    fun shouldResetForStationChange(
        prevStationIp: String,
        nextStationIp: String,
        hasParent: Boolean
    ): Boolean {
        if (!hasParent) return false
        if (prevStationIp.isBlank() || nextStationIp.isBlank()) return false
        if (prevStationIp == nextStationIp) return false
        return !sameSlash24(prevStationIp, nextStationIp)
    }

    fun parentStillValid(parentIp: String?, stationIp: String): Boolean {
        if (parentIp.isNullOrBlank()) return false
        if (stationIp.isBlank()) return true
        return sameSlash24(stationIp, parentIp)
    }

    fun sameSlash24(a: String, b: String): Boolean {
        val pa = a.split('.')
        val pb = b.split('.')
        if (pa.size != 4 || pb.size != 4) return false
        return pa[0] == pb[0] && pa[1] == pb[1] && pa[2] == pb[2]
    }
}
