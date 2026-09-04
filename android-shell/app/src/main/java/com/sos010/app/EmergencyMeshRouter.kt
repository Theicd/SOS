package com.sos010.app

/**
 * ניתוב עץ פשוט: תת-עץ של ילד, אחרת להורה. | HYPER CORE TECH
 */
object EmergencyMeshRouter {

    fun shouldDeliverLocal(
        selfId: String,
        selfPubkey: String,
        targetNodeId: String,
        targetPubkey: String
    ): Boolean {
        if (targetNodeId == TARGET_BROADCAST || targetNodeId == selfId) return true
        if (targetPubkey.isNotBlank() && selfPubkey.isNotBlank() && targetPubkey == selfPubkey) {
            return true
        }
        return false
    }

    fun nextHop(selfId: String, targetNodeId: String, store: EmergencyMeshStore): String? {
        if (targetNodeId.isBlank() || targetNodeId == selfId || targetNodeId == TARGET_BROADCAST) {
            return null
        }
        store.nextHopChildFor(targetNodeId)?.let { return it }
        val parent = store.parentNodeId()
        return if (parent == selfId) null else parent
    }

    fun shouldForwardUnicast(
        selfId: String,
        targetNodeId: String,
        fromNodeId: String,
        ttl: Int
    ): Boolean {
        if (ttl <= 0) return false
        if (targetNodeId == selfId || targetNodeId == TARGET_BROADCAST) return false
        if (targetNodeId.isBlank()) return false
        if (fromNodeId.isNotBlank() && fromNodeId == targetNodeId) return false
        return true
    }
}
