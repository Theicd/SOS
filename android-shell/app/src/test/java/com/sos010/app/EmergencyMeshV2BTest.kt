package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EmergencyMeshV2BTest {

    private val a = "aaa"
    private val b = "bbb"
    private val c = "ccc"

    private fun identity(id: String, boot: String = "boot-$id"): EmergencyNodeIdentity {
        return EmergencyNodeIdentity(id, id, boot, "SOS-${id.uppercase()}")
    }

    @Test
    fun parseRejectsMalformed() {
        assertNull(EmergencyMeshProtocol.parse("{"))
        assertNull(EmergencyMeshProtocol.parse("SOS_HERE:10.0.0.1:0:3"))
        assertNull(EmergencyMeshProtocol.parse("""{"protocol":"OTHER","version":2,"type":"DISCOVERY"}"""))
        assertNull(EmergencyMeshProtocol.parse("""{"protocol":"SOS_MESH","version":1,"type":"DISCOVERY"}"""))
        assertNull(EmergencyMeshProtocol.parse("""{"protocol":"SOS_MESH","version":2}"""))
        assertNull(EmergencyMeshProtocol.parse("x".repeat(EmergencyMeshProtocol.MAX_FRAME_CHARS + 1)))
        assertNull(
            EmergencyMeshProtocol.parse(
                """{"protocol":"SOS_MESH","version":2,"type":"DISCOVERY","nodeId":"${"n".repeat(81)}"}"""
            )
        )
        assertNull(
            EmergencyMeshProtocol.parse(
                """{"protocol":"SOS_MESH","version":2,"type":"DISCOVERY","nodeId":"a","depth":99}"""
            )
        )
    }

    @Test
    fun v1HereIsNotV2AndDoesNotParseAsJoin() {
        val v1 = "SOS_HERE:10.0.0.2:1:3:abcd:name"
        assertNotNull(EmergencyMeshProtocol.parseV1Here(v1))
        assertNull(EmergencyMeshProtocol.parse(v1))
        assertEquals("JOIN", "JOIN")
        assertNull(EmergencyMeshProtocol.parse("JOIN"))
    }

    @Test
    fun discoveryRoundTrip() {
        val id = identity(a)
        val line = EmergencyMeshProtocol.discovery(
            identity = id,
            ip = "10.0.0.1",
            rootNodeId = a,
            depth = 0,
            childCount = 1,
            staAp = CapabilityState.SUPPORTED,
            name = "A"
        )
        val frame = EmergencyMeshProtocol.parse(line)
        assertNotNull(frame)
        assertEquals(EmergencyMeshProtocol.DISCOVERY, frame!!.type)
        assertEquals(a, frame.nodeId)
        assertEquals("10.0.0.1", frame.ip)
        assertEquals(CapabilityState.SUPPORTED, frame.staAp)
        assertEquals(1, frame.childCount)
    }

    @Test
    fun joinFramesRoundTrip() {
        val req = EmergencyMeshProtocol.parse(
            EmergencyMeshProtocol.joinRequest(identity(b), "10.0.0.2", b, listOf(b), CapabilityState.UNKNOWN)
        )
        assertEquals(EmergencyMeshProtocol.JOIN_REQUEST, req!!.type)
        assertEquals(listOf(b), req.path)

        val acc = EmergencyMeshProtocol.parse(EmergencyMeshProtocol.joinAccept(identity(a), listOf(c)))
        assertEquals(EmergencyMeshProtocol.JOIN_ACCEPT, acc!!.type)
        assertEquals(a, acc.nodeId)

        val rej = EmergencyMeshProtocol.parse(EmergencyMeshProtocol.joinReject(JoinRejectReason.CYCLE))
        assertEquals(EmergencyMeshProtocol.JOIN_REJECT, rej!!.type)
        assertEquals(JoinRejectReason.CYCLE.name, rej.reason)
    }

    @Test
    fun rejectSelfCycleRoleConflict() {
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
        assertEquals(
            JoinRejectReason.ROLE_CONFLICT,
            EmergencyMeshDecision.rejectIncomingJoin(
                selfId = b,
                selfParentId = null,
                childIds = emptySet(),
                ancestorIds = emptySet(),
                descendantIds = emptySet(),
                childCount = 0,
                maxChildren = 3,
                joiningUpstreamId = null,
                remoteId = a,
                remoteAncestorIds = listOf(a),
                staAp = CapabilityState.SUPPORTED
            )
        )
    }

    @Test
    fun abRaceExactlyOneInitiatorAndOneAccept() {
        assertTrue(EmergencyMeshDecision.shouldInitiateJoin(b, a))
        assertFalse(EmergencyMeshDecision.shouldInitiateJoin(a, b))
        assertTrue(EmergencyMeshDecision.shouldAcceptAsParent(a, b))
        assertFalse(EmergencyMeshDecision.shouldAcceptAsParent(b, a))

        val storeA = EmergencyMeshStore()
        val storeB = EmergencyMeshStore()
        storeA.applyIdentity(identity(a))
        storeB.applyIdentity(identity(b))

        assertFalse(EmergencyMeshDecision.shouldInitiateJoin(a, b) && storeA.tryBeginJoin(b))
        assertTrue(storeB.tryBeginJoin(a))

        val rejectOnA = EmergencyMeshDecision.rejectIncomingJoin(
            selfId = a,
            selfParentId = storeA.parentNodeId(),
            childIds = storeA.childNodeIds(),
            ancestorIds = storeA.ancestorIds(),
            descendantIds = storeA.descendantIds(),
            childCount = storeA.childNodeIds().size,
            maxChildren = 3,
            joiningUpstreamId = storeA.joiningUpstreamId,
            remoteId = b,
            remoteAncestorIds = listOf(b),
            staAp = CapabilityState.SUPPORTED
        )
        val rejectOnB = EmergencyMeshDecision.rejectIncomingJoin(
            selfId = b,
            selfParentId = storeB.parentNodeId(),
            childIds = storeB.childNodeIds(),
            ancestorIds = storeB.ancestorIds(),
            descendantIds = storeB.descendantIds(),
            childCount = storeB.childNodeIds().size,
            maxChildren = 3,
            joiningUpstreamId = storeB.joiningUpstreamId,
            remoteId = a,
            remoteAncestorIds = listOf(a),
            staAp = CapabilityState.SUPPORTED
        )
        assertNull(rejectOnA)
        assertEquals(JoinRejectReason.ROLE_CONFLICT, rejectOnB)

        storeA.addChild(b)
        storeB.setParent(a)
        assertEquals(a, storeB.parentNodeId())
        assertNull(storeA.parentNodeId())
        assertTrue(storeA.childNodeIds().contains(b))
        assertFalse(storeB.childNodeIds().contains(a))
    }

    @Test
    fun simultaneousOppositeJoinsCannotFormTwoParents() {
        val storeA = EmergencyMeshStore()
        val storeB = EmergencyMeshStore()
        storeA.applyIdentity(identity(a))
        storeB.applyIdentity(identity(b))
        assertTrue(storeA.tryBeginJoin(b))
        assertTrue(storeB.tryBeginJoin(a))

        val rejectOnA = EmergencyMeshDecision.rejectIncomingJoin(
            selfId = a,
            selfParentId = null,
            childIds = emptySet(),
            ancestorIds = emptySet(),
            descendantIds = emptySet(),
            childCount = 0,
            maxChildren = 3,
            joiningUpstreamId = storeA.joiningUpstreamId,
            remoteId = b,
            remoteAncestorIds = listOf(b),
            staAp = CapabilityState.SUPPORTED
        )
        val rejectOnB = EmergencyMeshDecision.rejectIncomingJoin(
            selfId = b,
            selfParentId = null,
            childIds = emptySet(),
            ancestorIds = emptySet(),
            descendantIds = emptySet(),
            childCount = 0,
            maxChildren = 3,
            joiningUpstreamId = storeB.joiningUpstreamId,
            remoteId = a,
            remoteAncestorIds = listOf(a),
            staAp = CapabilityState.SUPPORTED
        )
        val acceptedA = rejectOnA == null
        val acceptedB = rejectOnB == null
        assertFalse(acceptedA && acceptedB)
        if (acceptedA) storeA.addChild(b)
        if (acceptedB) storeB.addChild(a)
        val aIsParent = storeA.childNodeIds().contains(b) && storeA.parentNodeId() == null
        val bIsParent = storeB.childNodeIds().contains(a) && storeB.parentNodeId() == null
        assertFalse(aIsParent && bIsParent)
    }

    @Test
    fun childrenMayJoinUpstreamWhenStaApSupported() {
        val store = EmergencyMeshStore()
        store.applyIdentity(identity(b))
        store.addChild(c)
        val cand = MeshParentCandidate(
            nodeId = a,
            relation = MeshPeerRelation.DISCOVERED,
            childCount = 0,
            maxChildren = 3,
            depth = 0,
            signalDbm = -50,
            staAp = CapabilityState.SUPPORTED,
            inExistingTree = true
        )
        val pick = EmergencyMeshDecision.pickBestParent(
            selfId = b,
            childIds = store.childNodeIds(),
            descendantIds = store.descendantIds(),
            parentId = store.parentNodeId(),
            hasChildren = true,
            staAp = CapabilityState.SUPPORTED,
            candidates = listOf(cand)
        )
        assertEquals(a, pick?.nodeId)
        assertTrue(store.tryBeginJoin(a))
        store.setParent(a)
        assertEquals(a, store.parentNodeId())
        assertTrue(store.childNodeIds().contains(c))
    }
}
