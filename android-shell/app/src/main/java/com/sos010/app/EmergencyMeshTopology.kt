package com.sos010.app

/**
 * פרסום תת-עץ להורה. learnVia נשאר גיבוי, לא תנאי לניתוב. | HYPER CORE TECH
 */
object EmergencyMeshTopology {

    fun encode(identity: EmergencyNodeIdentity, store: EmergencyMeshStore): String {
        return EmergencyMeshProtocol.topologyUpdate(identity, store.reachableAdvertisement())
    }

    fun apply(store: EmergencyMeshStore, fromChildId: String, frame: EmergencyMeshProtocol.Frame): Boolean {
        if (frame.type != EmergencyMeshProtocol.TOPOLOGY_UPDATE) return false
        if (fromChildId.isBlank() || !store.childNodeIds().contains(fromChildId)) return false
        val dests = ArrayList<MeshReachable>(frame.reachable.size)
        frame.reachable.forEachIndexed { i, id ->
            dests.add(MeshReachable(id, frame.reachablePubkeys.getOrNull(i).orEmpty()))
        }
        return store.applySubtree(fromChildId, dests)
    }
}
