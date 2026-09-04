package com.sos010.app

import org.json.JSONArray
import org.json.JSONObject

/**
 * תצוגת peers + ניתוב צ'אט לגשר. DISCOVERED ≠ מחובר. | HYPER CORE TECH
 */
object EmergencyMeshPeers {
    const val GROUP_PUBKEY = "e5e1111111111111111111111111111111111111111111111111111111111111"

    fun isGroupTarget(to: String): Boolean {
        val t = to.trim().lowercase()
        return t.isEmpty() || t == TARGET_BROADCAST || t == GROUP_PUBKEY
    }

    fun resolveTarget(to: String, store: EmergencyMeshStore): Pair<String, String> {
        if (isGroupTarget(to)) return TARGET_BROADCAST to ""
        val pk = to.trim().lowercase()
        val rec = store.findByPubkey(pk)
        return (rec?.nodeId ?: pk) to pk
    }

    fun hops(record: MeshPeerRecord, store: EmergencyMeshStore): Int {
        return when (record.relation) {
            MeshPeerRelation.DIRECT_PARENT, MeshPeerRelation.DIRECT_CHILD -> 1
            MeshPeerRelation.TRANSITIVE -> 2
            else -> if (store.nextHopChildFor(record.nodeId) != null) 2 else 0
        }
    }

    fun isReachable(record: MeshPeerRecord, liveIds: Set<String>): Boolean {
        if (!EmergencyMeshDecision.isConnectedRelation(record.relation) &&
            record.relation != MeshPeerRelation.TRANSITIVE
        ) {
            return false
        }
        if (liveIds.isEmpty()) return record.linkState == MeshLinkState.ACTIVE
        return liveIds.contains(record.nodeId) || record.relation == MeshPeerRelation.TRANSITIVE
    }

    fun toJson(record: MeshPeerRecord, liveIds: Set<String>, store: EmergencyMeshStore): JSONObject {
        val reachable = isReachable(record, liveIds)
        return JSONObject().apply {
            put("nodeId", record.nodeId)
            put("pubkey", record.pubkey)
            put("ip", record.currentIp)
            put("name", record.name)
            put("picture", record.picture)
            put("relation", record.relation.name)
            put("reachable", reachable)
            put("hops", hops(record, store))
            put("isParent", record.relation == MeshPeerRelation.DIRECT_PARENT)
            put("type", if (reachable) "relay" else "discovered")
        }
    }

    fun listJson(store: EmergencyMeshStore, liveIds: Set<String>, selfId: String): JSONArray {
        val arr = JSONArray()
        store.allPeers().forEach { rec ->
            if (rec.nodeId.isBlank() || rec.nodeId == selfId) return@forEach
            arr.put(toJson(rec, liveIds, store))
        }
        return arr
    }

    fun connectedIps(store: EmergencyMeshStore, selfIp: String): JSONArray {
        val arr = JSONArray()
        store.allPeers().forEach { rec ->
            if (!EmergencyMeshDecision.isConnectedRelation(rec.relation)) return@forEach
            if (rec.currentIp.isBlank() || rec.currentIp == selfIp) return@forEach
            arr.put(rec.currentIp)
        }
        return arr
    }
}
