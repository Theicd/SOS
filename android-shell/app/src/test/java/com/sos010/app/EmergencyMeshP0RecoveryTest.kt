package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.PrintWriter
import java.io.StringWriter

class EmergencyMeshP0RecoveryTest {

    private val a = "aaa"
    private val b = "bbb"
    private val pkB = "bb".repeat(32)

    @Before
    fun resetOwner() {
        SosP2pOwner.resetForTest()
    }

    private fun reject(
        childIds: Set<String>,
        descendantIds: Set<String> = childIds,
        childLinkHealthy: Boolean = true,
        remoteId: String = b
    ): JoinRejectReason? {
        return EmergencyMeshDecision.rejectIncomingJoin(
            selfId = a,
            selfParentId = null,
            childIds = childIds,
            ancestorIds = emptySet(),
            descendantIds = descendantIds,
            childCount = childIds.size,
            maxChildren = 3,
            joiningUpstreamId = null,
            remoteId = remoteId,
            remoteAncestorIds = emptyList(),
            staAp = CapabilityState.SUPPORTED,
            childLinkHealthy = childLinkHealthy
        )
    }

    @Test
    fun healthyChildDuplicateJoinRejected() {
        assertEquals(JoinRejectReason.ALREADY_CHILD, reject(setOf(b), childLinkHealthy = true))
    }

    @Test
    fun staleChildJoinAcceptedAsReattach() {
        assertNull(reject(setOf(b), descendantIds = setOf(b, "ccc"), childLinkHealthy = false))
    }

    @Test
    fun newBootTreatsChildAsStale() {
        assertNull(reject(setOf(b), childLinkHealthy = false))
    }

    @Test
    fun grandchildStillCycleWithoutBeingDirectChild() {
        assertEquals(JoinRejectReason.CYCLE, reject(emptySet(), descendantIds = setOf("ccc"), remoteId = "ccc"))
    }

    @Test
    fun oldClosedLinkDoesNotDropReplacement() {
        val table = EmergencyMeshLinkTable()
        val old = EmergencyMeshLink(
            remoteNodeId = b,
            remoteBootId = "boot-old",
            relation = MeshPeerRelation.DIRECT_CHILD,
            currentIp = "10.0.0.2",
            writer = PrintWriter(StringWriter(), true),
            onClosed = { table.detachIfCurrent(it) }
        )
        val next = EmergencyMeshLink(
            remoteNodeId = b,
            remoteBootId = "boot-new",
            relation = MeshPeerRelation.DIRECT_CHILD,
            currentIp = "10.0.0.2",
            writer = PrintWriter(StringWriter(), true),
            onClosed = { table.detachIfCurrent(it) }
        )
        table.attach(old)
        table.attach(next)
        assertFalse(old.isLive())
        assertTrue(next.isLive())
        table.detachIfCurrent(old)
        assertEquals(next, table.get(b))
        assertTrue(table.get(b)!!.isLive())
    }

    @Test
    fun meshAnswerAttemptedWhenReachabilityPreflightFalse() {
        val store = EmergencyMeshStore()
        store.applyIdentity(EmergencyNodeIdentity(a, a, "boot-a", "SOS-A"))
        store.upsertDiscovery(MeshPeerRecord(nodeId = b, pubkey = pkB, currentIp = "10.0.0.2"), 1L)
        assertTrue(EmergencyMeshSignal.shouldAttemptMeshSend(pkB, store))
        assertFalse(EmergencyMeshSignal.isMeshSignalTarget(pkB, store, liveIds = setOf("zzz")))
    }

    @Test
    fun meshSignalStillNotBroadcastToWrongPubkey() {
        val other = "cd".repeat(32)
        val store = EmergencyMeshStore()
        store.applyIdentity(EmergencyNodeIdentity(a, a, "boot-a", "SOS-A"))
        store.upsertDiscovery(MeshPeerRecord(nodeId = b, pubkey = pkB), 1L)
        store.addChild(b)
        assertFalse(EmergencyMeshSignal.shouldAttemptMeshSend(other, store))
        val payload = EmergencyMeshSignal.wrap(pkB, """{"type":"dc-answer"}""", a, "10.0.0.1")!!
        assertTrue(EmergencyMeshSignal.shouldDeliverToSelf(pkB, payload))
        assertFalse(EmergencyMeshSignal.shouldDeliverToSelf(other, payload))
    }

    @Test
    fun reattachKeepsOneChildAndRoutesBothWays() {
        val parent = EmergencyMeshStore()
        val child = EmergencyMeshStore()
        parent.applyIdentity(EmergencyNodeIdentity(a, a, "boot-a", "SOS-A"))
        child.applyIdentity(EmergencyNodeIdentity(b, pkB, "boot-b2", "SOS-B"))
        parent.addChild(b)
        child.setParent(a)
        parent.removeLink(b)
        parent.addChild(b)
        child.setParent(a)
        assertEquals(setOf(b), parent.childNodeIds())
        assertEquals(a, child.parentNodeId())
        val seenP = EmergencyMeshSeenCache()
        val seenC = EmergencyMeshSeenCache()
        val toChild = EmergencyMeshEngine.originate(a, a, parent, seenP, "p-to-c", b, pkB, "m1")
        assertEquals(EmergencyMeshEngine.ForwardMode.UNICAST, toChild.forwardMode)
        assertEquals(b, toChild.nextHopId)
        val toParent = EmergencyMeshEngine.originate(b, pkB, child, seenC, "c-to-p", a, a, "m2")
        assertEquals(EmergencyMeshEngine.ForwardMode.UNICAST, toParent.forwardMode)
        assertEquals(a, toParent.nextHopId)
    }

    @Test
    fun webViewReadyDoesNotClearNativeClaimUntilReplacement() {
        SosP2pOwner.onActivityGone(true)
        assertTrue(SosP2pOwner.claim(pkB, SosP2pOwnerKind.NATIVE))
        SosP2pOwner.onUiForeground()
        assertEquals(SosP2pOwnerKind.HANDOFF, SosP2pOwner.kind)
        assertTrue(SosP2pOwner.nativeMayHandle())
        SosP2pOwner.markWebViewReady()
        assertFalse(SosP2pOwner.nativeMayHandle())
        assertTrue(SosP2pOwner.claim(pkB, SosP2pOwnerKind.WEBVIEW))
        assertTrue(SosP2pOwner.hasExclusiveOwner(pkB))
    }

    @Test
    fun closedLinkIsNotHealthy() {
        val link = EmergencyMeshLink(
            remoteNodeId = b,
            relation = MeshPeerRelation.DIRECT_CHILD,
            writer = PrintWriter(StringWriter(), true)
        )
        assertTrue(link.isHealthy())
        link.close()
        assertFalse(link.isHealthy())
        assertFalse(link.isLive())
    }
}
