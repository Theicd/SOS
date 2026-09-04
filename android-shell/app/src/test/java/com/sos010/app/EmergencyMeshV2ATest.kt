package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EmergencyMeshV2ATest {

    private val a = "aaa"
    private val b = "bbb"
    private val c = "ccc"

    @Test
    fun nodeIdPrefersPubkey() {
        val pk = "ab".repeat(32)
        assertEquals(pk, EmergencyMeshIdentity.nodeIdFrom(pk, "install-1"))
    }

    @Test
    fun nodeIdFallsBackToInstall() {
        assertEquals("install-1", EmergencyMeshIdentity.nodeIdFrom("", "install-1"))
    }

    @Test
    fun upgradeLinksPubkeyWithoutDuplicateLogic() {
        val boot = "boot-1"
        val old = EmergencyNodeIdentity("install-1", "", boot, "SOS-XXXX")
        val pk = "cd".repeat(32)
        val next = EmergencyMeshIdentity.upgrade(old, pk)
        assertEquals(pk, next.nodeId)
        assertEquals(pk, next.pubkey)
        assertEquals(boot, next.bootId)
    }

    @Test
    fun cannotJoinSelf() {
        assertFalse(EmergencyMeshDecision.shouldInitiateJoin(a, a))
        assertEquals(
            JoinRejectReason.SELF,
            EmergencyMeshDecision.rejectIncomingJoin(
                selfId = a,
                selfParentId = null,
                childIds = emptySet(),
                ancestorIds = emptySet(),
                descendantIds = emptySet(),
                childCount = 0,
                maxChildren = 3,
                joiningUpstreamId = null,
                remoteId = a,
                remoteAncestorIds = emptyList(),
                staAp = CapabilityState.SUPPORTED
            )
        )
    }

    @Test
    fun abRaceOnlyOneParentDirection() {
        assertEquals(a, EmergencyMeshDecision.preferredParentId(a, b))
        assertTrue(EmergencyMeshDecision.shouldAcceptAsParent(a, b))
        assertTrue(EmergencyMeshDecision.shouldInitiateJoin(b, a))
        assertFalse(EmergencyMeshDecision.shouldInitiateJoin(a, b))
        assertFalse(EmergencyMeshDecision.shouldAcceptAsParent(b, a))
    }

    @Test
    fun alreadyParentCannotBecomeChild() {
        assertEquals(
            JoinRejectReason.ALREADY_PARENT,
            EmergencyMeshDecision.rejectIncomingJoin(
                selfId = a,
                selfParentId = b,
                childIds = emptySet(),
                ancestorIds = setOf(b),
                descendantIds = emptySet(),
                childCount = 0,
                maxChildren = 3,
                joiningUpstreamId = null,
                remoteId = b,
                remoteAncestorIds = emptyList(),
                staAp = CapabilityState.SUPPORTED
            )
        )
    }

    @Test
    fun ancestorPathCycleRejected() {
        assertEquals(
            JoinRejectReason.CYCLE,
            EmergencyMeshDecision.rejectIncomingJoin(
                selfId = a,
                selfParentId = null,
                childIds = emptySet(),
                ancestorIds = emptySet(),
                descendantIds = emptySet(),
                childCount = 0,
                maxChildren = 3,
                joiningUpstreamId = null,
                remoteId = c,
                remoteAncestorIds = listOf(a, b),
                staAp = CapabilityState.SUPPORTED
            )
        )
    }

    @Test
    fun oneParentMaximumViaPick() {
        val cand = MeshParentCandidate(b, MeshPeerRelation.CANDIDATE, 0, 3, 0, -40, CapabilityState.UNKNOWN, true)
        assertNull(
            EmergencyMeshDecision.pickBestParent(
                selfId = a,
                childIds = emptySet(),
                descendantIds = emptySet(),
                parentId = b,
                hasChildren = false,
                staAp = CapabilityState.SUPPORTED,
                candidates = listOf(cand)
            )
        )
    }

    @Test
    fun childCapacityEnforced() {
        assertEquals(
            JoinRejectReason.CAPACITY,
            EmergencyMeshDecision.rejectIncomingJoin(
                selfId = a,
                selfParentId = null,
                childIds = setOf(b, c, "ddd"),
                ancestorIds = emptySet(),
                descendantIds = setOf(b, c, "ddd"),
                childCount = 3,
                maxChildren = 3,
                joiningUpstreamId = null,
                remoteId = "eee",
                remoteAncestorIds = emptyList(),
                staAp = CapabilityState.SUPPORTED
            )
        )
    }

    @Test
    fun childrenCanJoinUpstreamWhenStaApSupported() {
        assertTrue(EmergencyMeshDecision.canJoinUpstream(hasChildren = true, CapabilityState.SUPPORTED))
        val cand = MeshParentCandidate(a, MeshPeerRelation.CANDIDATE, 1, 3, 0, -50, CapabilityState.SUPPORTED, true)
        assertNotNull(
            EmergencyMeshDecision.pickBestParent(
                selfId = b,
                childIds = setOf(c),
                descendantIds = setOf(c),
                parentId = null,
                hasChildren = true,
                staAp = CapabilityState.SUPPORTED,
                candidates = listOf(cand)
            )
        )
    }

    @Test
    fun childrenCannotJoinUpstreamWhenStaApUnsupported() {
        assertFalse(EmergencyMeshDecision.canJoinUpstream(hasChildren = true, CapabilityState.UNSUPPORTED))
        assertFalse(EmergencyMeshDecision.canJoinUpstream(hasChildren = true, CapabilityState.UNKNOWN))
        val cand = MeshParentCandidate(a, MeshPeerRelation.CANDIDATE, 0, 3, 0, -30, CapabilityState.UNKNOWN, true)
        assertNull(
            EmergencyMeshDecision.pickBestParent(
                selfId = b,
                childIds = setOf(c),
                descendantIds = setOf(c),
                parentId = null,
                hasChildren = true,
                staAp = CapabilityState.UNKNOWN,
                candidates = listOf(cand)
            )
        )
    }

    @Test
    fun discoveredIsNotConnected() {
        assertFalse(EmergencyMeshDecision.isConnectedRelation(MeshPeerRelation.DISCOVERED))
        assertFalse(EmergencyMeshDecision.isConnectedRelation(MeshPeerRelation.CANDIDATE))
        assertTrue(EmergencyMeshDecision.isConnectedRelation(MeshPeerRelation.DIRECT_PARENT))
        assertTrue(EmergencyMeshDecision.isConnectedRelation(MeshPeerRelation.DIRECT_CHILD))
        val store = EmergencyMeshStore()
        store.upsertDiscovery(MeshPeerRecord(nodeId = b, currentIp = "10.0.0.2"), 1000L)
        assertEquals(1, store.discoveredCount())
        assertEquals(0, store.connectedCount())
    }

    @Test
    fun staleDiscoveryExpires() {
        val store = EmergencyMeshStore()
        store.upsertDiscovery(MeshPeerRecord(nodeId = b), 1_000L)
        store.expireStale(1_000L + EmergencyMeshDecision.DISCOVERY_EXPIRE_MS + 1)
        assertNull(store.get(b))
    }

    @Test
    fun connectedPeerNotExpired() {
        val store = EmergencyMeshStore()
        store.upsertDiscovery(MeshPeerRecord(nodeId = b), 1_000L)
        store.addChild(b)
        store.expireStale(1_000L + EmergencyMeshDecision.DISCOVERY_EXPIRE_MS + 1)
        assertNotNull(store.get(b))
        assertEquals(MeshPeerRelation.DIRECT_CHILD, store.get(b)?.relation)
    }

    @Test
    fun newBootIdReplacesSessionOnReset() {
        val store = EmergencyMeshStore()
        store.applyIdentity(EmergencyNodeIdentity(a, a, "boot-old", "SOS-AAAA"))
        store.upsertDiscovery(MeshPeerRecord(nodeId = b, bootId = "old"), 1L)
        store.reset("boot-new")
        assertEquals("boot-new", store.identity?.bootId)
        assertNull(store.get(b))
        assertEquals(MeshNodeState.IDLE, store.nodeState)
    }

    @Test
    fun onlyOneJoinAtATime() {
        val store = EmergencyMeshStore()
        assertTrue(store.tryBeginJoin(a))
        assertFalse(store.tryBeginJoin(b))
        assertEquals(a, store.joiningUpstreamId)
        store.clearJoin()
        assertTrue(store.tryBeginJoin(b))
    }

    @Test
    fun storeAllowsOnlyOneParent() {
        val store = EmergencyMeshStore()
        store.applyIdentity(EmergencyNodeIdentity(c, c, "boot", "SOS-CCCC"))
        store.setParent(a)
        store.setParent(b)
        assertEquals(b, store.parentNodeId())
        assertEquals(MeshPeerRelation.DISCOVERED, store.get(a)?.relation)
        assertEquals(MeshPeerRelation.DIRECT_PARENT, store.get(b)?.relation)
    }

    @Test
    fun alreadyChildRejected() {
        assertEquals(
            JoinRejectReason.ALREADY_CHILD,
            EmergencyMeshDecision.rejectIncomingJoin(
                selfId = a,
                selfParentId = null,
                childIds = setOf(b),
                ancestorIds = emptySet(),
                descendantIds = setOf(b),
                childCount = 1,
                maxChildren = 3,
                joiningUpstreamId = null,
                remoteId = b,
                remoteAncestorIds = emptyList(),
                staAp = CapabilityState.SUPPORTED
            )
        )
    }

    @Test
    fun parentWithUnsupportedConcurrencyRejectsNewChild() {
        assertEquals(
            JoinRejectReason.UNSUPPORTED_CONCURRENCY,
            EmergencyMeshDecision.rejectIncomingJoin(
                selfId = a,
                selfParentId = "root",
                childIds = emptySet(),
                ancestorIds = setOf("root"),
                descendantIds = emptySet(),
                childCount = 0,
                maxChildren = 3,
                joiningUpstreamId = null,
                remoteId = b,
                remoteAncestorIds = emptyList(),
                staAp = CapabilityState.UNKNOWN
            )
        )
    }

    @Test
    fun existingTreePreferredOverLoneStrongerSignal() {
        val lone = MeshParentCandidate("zzz", MeshPeerRelation.CANDIDATE, 0, 3, 0, -20, CapabilityState.UNKNOWN, false)
        val tree = MeshParentCandidate(a, MeshPeerRelation.CANDIDATE, 1, 3, 1, -80, CapabilityState.UNKNOWN, true)
        val pick = EmergencyMeshDecision.pickBestParent(
            selfId = "mmm",
            childIds = emptySet(),
            descendantIds = emptySet(),
            parentId = null,
            hasChildren = false,
            staAp = CapabilityState.UNKNOWN,
            candidates = listOf(lone, tree)
        )
        assertEquals(a, pick?.nodeId)
    }

    @Test
    fun discoveredNotEqualConnectedInvariant() {
        assertNotEquals(MeshPeerRelation.DISCOVERED, MeshPeerRelation.DIRECT_PARENT)
        assertNotEquals(MeshPeerRelation.DISCOVERED, MeshPeerRelation.DIRECT_CHILD)
    }
}
