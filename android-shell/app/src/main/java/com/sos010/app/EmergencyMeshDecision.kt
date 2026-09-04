package com.sos010.app

/**
 * החלטות טופולוגיה טהורות — אותו זוג תמיד מחליט אותו כיוון. | HYPER CORE TECH
 */
object EmergencyMeshDecision {
    const val DISCOVERY_EXPIRE_MS = 30_000L

    /** ה-nodeId הקטן לקסיקוגרפית הוא ההורה. */
    fun preferredParentId(a: String, b: String): String {
        return if (a < b) a else b
    }

    fun shouldInitiateJoin(selfId: String, remoteId: String): Boolean {
        if (selfId.isBlank() || remoteId.isBlank() || selfId == remoteId) return false
        return preferredParentId(selfId, remoteId) == remoteId
    }

    fun shouldAcceptAsParent(selfId: String, remoteId: String): Boolean {
        if (selfId.isBlank() || remoteId.isBlank() || selfId == remoteId) return false
        return preferredParentId(selfId, remoteId) == selfId
    }

    fun canHaveParentAndChildren(staAp: CapabilityState): Boolean {
        return staAp == CapabilityState.SUPPORTED
    }

    fun canJoinUpstream(hasChildren: Boolean, staAp: CapabilityState): Boolean {
        if (!hasChildren) return true
        return canHaveParentAndChildren(staAp)
    }

    fun isConnectedRelation(relation: MeshPeerRelation): Boolean {
        return relation == MeshPeerRelation.DIRECT_PARENT ||
            relation == MeshPeerRelation.DIRECT_CHILD
    }

    fun rejectIncomingJoin(
        selfId: String,
        selfParentId: String?,
        childIds: Set<String>,
        ancestorIds: Set<String>,
        descendantIds: Set<String>,
        childCount: Int,
        maxChildren: Int,
        joiningUpstreamId: String?,
        remoteId: String,
        remoteAncestorIds: List<String>,
        staAp: CapabilityState,
        childLinkHealthy: Boolean = true
    ): JoinRejectReason? {
        if (remoteId.isBlank() || remoteId == selfId) return JoinRejectReason.SELF
        if (remoteId == selfParentId) return JoinRejectReason.ALREADY_PARENT
        val existingChild = childIds.contains(remoteId)
        if (existingChild && childLinkHealthy) return JoinRejectReason.ALREADY_CHILD
        if (!existingChild && (ancestorIds.contains(remoteId) || descendantIds.contains(remoteId))) {
            return JoinRejectReason.CYCLE
        }
        if (remoteAncestorIds.any { it == selfId }) return JoinRejectReason.CYCLE
        if (!shouldAcceptAsParent(selfId, remoteId)) return JoinRejectReason.ROLE_CONFLICT
        if (joiningUpstreamId != null && joiningUpstreamId == remoteId) {
            return JoinRejectReason.BUSY
        }
        if (childCount >= maxChildren) return JoinRejectReason.CAPACITY
        if (selfParentId != null && !canHaveParentAndChildren(staAp)) {
            return JoinRejectReason.UNSUPPORTED_CONCURRENCY
        }
        return null
    }

    fun pickBestParent(
        selfId: String,
        childIds: Set<String>,
        descendantIds: Set<String>,
        parentId: String?,
        hasChildren: Boolean,
        staAp: CapabilityState,
        candidates: List<MeshParentCandidate>
    ): MeshParentCandidate? {
        if (parentId != null) return null
        if (!canJoinUpstream(hasChildren, staAp)) return null
        return candidates
            .filter { c ->
                c.nodeId != selfId &&
                    c.nodeId != parentId &&
                    !childIds.contains(c.nodeId) &&
                    !descendantIds.contains(c.nodeId) &&
                    c.childCount < c.maxChildren &&
                    c.relation != MeshPeerRelation.UNREACHABLE &&
                    shouldInitiateJoin(selfId, c.nodeId)
            }
            .minWithOrNull(
                compareBy<MeshParentCandidate> { if (it.inExistingTree) 0 else 1 }
                    .thenBy { it.depth }
                    .thenByDescending { it.signalDbm }
                    .thenBy { it.nodeId }
            )
    }

    fun isDiscoveryFresh(lastSeenMs: Long, nowMs: Long, ttlMs: Long = DISCOVERY_EXPIRE_MS): Boolean {
        if (lastSeenMs <= 0L) return false
        return nowMs - lastSeenMs <= ttlMs
    }
}
