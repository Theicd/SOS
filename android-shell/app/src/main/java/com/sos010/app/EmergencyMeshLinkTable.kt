package com.sos010.app

import java.util.concurrent.ConcurrentHashMap

/**
 * לכל nodeId לינק חי אחד. הורה פעיל אחד לכל היותר. | HYPER CORE TECH
 */
class EmergencyMeshLinkTable {
    private val byNode = ConcurrentHashMap<String, EmergencyMeshLink>()

    @Synchronized
    fun attach(link: EmergencyMeshLink): EmergencyMeshLink {
        val prev = byNode[link.remoteNodeId]
        if (prev != null && prev !== link) {
            prev.close()
            byNode.remove(link.remoteNodeId, prev)
        }
        if (link.relation == MeshPeerRelation.DIRECT_PARENT) {
            byNode.values
                .filter { it !== link && it.relation == MeshPeerRelation.DIRECT_PARENT }
                .toList()
                .forEach { old ->
                    old.close()
                    byNode.remove(old.remoteNodeId, old)
                }
        }
        byNode[link.remoteNodeId] = link
        return link
    }

    fun detachIfCurrent(link: EmergencyMeshLink) {
        byNode.remove(link.remoteNodeId, link)
    }

    fun get(nodeId: String): EmergencyMeshLink? = byNode[nodeId]

    fun findByIp(ip: String): EmergencyMeshLink? {
        if (ip.isBlank()) return null
        return byNode.values.firstOrNull { it.currentIp == ip }
    }

    fun findLive(ip: String, nodeId: String? = null): EmergencyMeshLink? {
        val byId = nodeId?.let { get(it) }
        if (byId != null && byId.isLive()) return byId
        val byIp = findByIp(ip)
        return if (byIp != null && byIp.isLive()) byIp else null
    }

    fun parent(): EmergencyMeshLink? {
        return byNode.values.firstOrNull {
            it.relation == MeshPeerRelation.DIRECT_PARENT && it.isLive()
        }
    }

    fun children(): List<EmergencyMeshLink> {
        return byNode.values.filter {
            it.relation == MeshPeerRelation.DIRECT_CHILD && it.isLive()
        }
    }

    fun live(): List<EmergencyMeshLink> = byNode.values.filter { it.isLive() }

    fun liveCount(nodeId: String): Int {
        val link = byNode[nodeId]
        return if (link != null && link.isLive()) 1 else 0
    }

    fun parentCount(): Int = if (parent() != null) 1 else 0

    fun size(): Int = byNode.size

    @Synchronized
    fun closeAll() {
        byNode.values.toList().forEach { it.close() }
        byNode.clear()
    }
}
