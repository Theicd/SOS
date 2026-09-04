package com.sos010.app

import java.util.concurrent.ConcurrentHashMap

/**
 * מאגר טופולוגיה קנוני לפי nodeId. רשימות IP ישנות נגזרות מכאן בהמשך. | HYPER CORE TECH
 */
class EmergencyMeshStore {
    @Volatile var identity: EmergencyNodeIdentity? = null
    @Volatile var nodeState: MeshNodeState = MeshNodeState.IDLE
    @Volatile var joiningUpstreamId: String? = null
    @Volatile var rootNodeId: String = ""
    @Volatile var depth: Int = 0

    private val peers = ConcurrentHashMap<String, MeshPeerRecord>()
    private val viaChild = ConcurrentHashMap<String, String>()

    fun reset(newBootId: String = EmergencyMeshIdentity.newBootId()) {
        val prev = identity
        identity = prev?.copy(bootId = newBootId)
        nodeState = MeshNodeState.IDLE
        joiningUpstreamId = null
        rootNodeId = identity?.nodeId.orEmpty()
        depth = 0
        peers.clear()
    }

    fun applyIdentity(next: EmergencyNodeIdentity) {
        val prev = identity
        identity = next
        if (prev != null && prev.nodeId != next.nodeId) {
            val moved = peers.remove(prev.nodeId)
            if (moved != null) peers[next.nodeId] = moved.copy(nodeId = next.nodeId, pubkey = next.pubkey)
        }
        if (rootNodeId.isBlank() || rootNodeId == prev?.nodeId) {
            rootNodeId = next.nodeId
        }
    }

    fun upsertDiscovery(record: MeshPeerRecord, nowMs: Long): MeshPeerRecord {
        val existing = peers[record.nodeId]
        val merged = if (existing == null) {
            record.copy(
                relation = MeshPeerRelation.DISCOVERED,
                lastSeenMs = nowMs
            )
        } else {
            existing.copy(
                pubkey = record.pubkey.ifBlank { existing.pubkey },
                bootId = record.bootId.ifBlank { existing.bootId },
                ssid = record.ssid.ifBlank { existing.ssid },
                currentIp = record.currentIp.ifBlank { existing.currentIp },
                lastSeenMs = nowMs,
                rootNodeId = record.rootNodeId.ifBlank { existing.rootNodeId },
                depth = record.depth,
                childCount = record.childCount,
                maxChildren = record.maxChildren,
                staAp = record.staAp,
                signalDbm = record.signalDbm,
                name = record.name.ifBlank { existing.name },
                picture = record.picture.ifBlank { existing.picture }
            )
        }
        peers[record.nodeId] = merged
        return merged
    }

    fun expireStale(nowMs: Long, ttlMs: Long = EmergencyMeshDecision.DISCOVERY_EXPIRE_MS) {
        val it = peers.entries.iterator()
        while (it.hasNext()) {
            val e = it.next()
            if (EmergencyMeshDecision.isConnectedRelation(e.value.relation)) continue
            if (!EmergencyMeshDecision.isDiscoveryFresh(e.value.lastSeenMs, nowMs, ttlMs)) {
                it.remove()
            }
        }
    }

    fun tryBeginJoin(candidateId: String): Boolean {
        if (candidateId.isBlank()) return false
        if (joiningUpstreamId != null) return joiningUpstreamId == candidateId
        joiningUpstreamId = candidateId
        nodeState = MeshNodeState.JOINING
        return true
    }

    fun clearJoin() {
        joiningUpstreamId = null
        if (nodeState == MeshNodeState.JOINING) {
            nodeState = if (parentNodeId() != null) MeshNodeState.CONNECTED else MeshNodeState.ROOT
        }
    }

    fun setParent(nodeId: String) {
        val prevParent = parentNodeId()
        if (prevParent != null && prevParent != nodeId) {
            updateRelation(prevParent, MeshPeerRelation.DISCOVERED, MeshLinkState.CLOSED)
        }
        updateRelation(nodeId, MeshPeerRelation.DIRECT_PARENT, MeshLinkState.ACTIVE)
        joiningUpstreamId = null
        nodeState = MeshNodeState.CONNECTED
        depth = (peers[nodeId]?.depth ?: 0) + 1
        rootNodeId = peers[nodeId]?.rootNodeId?.ifBlank { nodeId } ?: nodeId
    }

    fun addChild(nodeId: String) {
        updateRelation(nodeId, MeshPeerRelation.DIRECT_CHILD, MeshLinkState.ACTIVE)
        if (parentNodeId() == null) {
            nodeState = MeshNodeState.ROOT
            rootNodeId = identity?.nodeId.orEmpty()
            depth = 0
        }
    }

    fun removeLink(nodeId: String) {
        updateRelation(nodeId, MeshPeerRelation.UNREACHABLE, MeshLinkState.CLOSED)
        val it = viaChild.entries.iterator()
        while (it.hasNext()) {
            val e = it.next()
            if (e.key == nodeId || e.value == nodeId) it.remove()
        }
        if (parentNodeId() == null && nodeState == MeshNodeState.CONNECTED) {
            nodeState = MeshNodeState.ROOT
            rootNodeId = identity?.nodeId.orEmpty()
            depth = 0
        }
    }

    fun learnVia(viaChildId: String, destNodeId: String) {
        val self = identity?.nodeId.orEmpty()
        if (destNodeId.isBlank() || destNodeId == self || destNodeId == viaChildId) return
        if (!childNodeIds().contains(viaChildId)) return
        if (parentNodeId() == destNodeId) return
        viaChild[destNodeId] = viaChildId
    }

    fun nextHopChildFor(destNodeId: String): String? {
        if (childNodeIds().contains(destNodeId)) return destNodeId
        return viaChild[destNodeId]
    }

    fun parentNodeId(): String? {
        return peers.values.firstOrNull { it.relation == MeshPeerRelation.DIRECT_PARENT }?.nodeId
    }

    fun childNodeIds(): Set<String> {
        return peers.values
            .filter { it.relation == MeshPeerRelation.DIRECT_CHILD }
            .map { it.nodeId }
            .toSet()
    }

    fun descendantIds(): Set<String> = childNodeIds() + viaChild.keys

    fun ancestorIds(): Set<String> {
        val parent = parentNodeId() ?: return emptySet()
        val root = peers[parent]?.rootNodeId.orEmpty()
        return if (root.isNotBlank() && root != parent) setOf(parent, root) else setOf(parent)
    }

    fun get(nodeId: String): MeshPeerRecord? = peers[nodeId]

    fun findByIp(ip: String): MeshPeerRecord? {
        if (ip.isBlank()) return null
        return peers.values.firstOrNull { it.currentIp == ip }
    }

    fun findByPubkey(pubkey: String): MeshPeerRecord? {
        val pk = pubkey.trim().lowercase()
        if (pk.isBlank()) return null
        get(pk)?.let { return it }
        return peers.values.firstOrNull { it.pubkey.equals(pk, ignoreCase = true) }
    }

    fun allPeers(): Collection<MeshPeerRecord> = peers.values

    fun connectedCount(): Int {
        return peers.values.count { EmergencyMeshDecision.isConnectedRelation(it.relation) }
    }

    fun discoveredCount(): Int {
        return peers.values.count { it.relation == MeshPeerRelation.DISCOVERED }
    }

    private fun updateRelation(nodeId: String, relation: MeshPeerRelation, link: MeshLinkState) {
        val prev = peers[nodeId] ?: MeshPeerRecord(nodeId = nodeId)
        peers[nodeId] = prev.copy(relation = relation, linkState = link)
    }
}
