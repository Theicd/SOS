package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EmergencyMeshV2FTest {

    private val target = "ab".repeat(32)
    private val other = "cd".repeat(32)

    private fun store(self: String): EmergencyMeshStore {
        val s = EmergencyMeshStore()
        s.applyIdentity(EmergencyNodeIdentity(self, self, "boot-$self", "SOS-$self"))
        return s
    }

    @Test
    fun blankOrBroadcastTargetIsRejected() {
        val s = store("aaa")
        assertNull(EmergencyMeshSignal.routeTarget("", s))
        assertNull(EmergencyMeshSignal.routeTarget("*", s))
        assertNull(EmergencyMeshSignal.routeTarget("not-a-key", s))
    }

    @Test
    fun routeUsesNodeIdNotBroadcast() {
        val s = store("aaa")
        s.upsertDiscovery(MeshPeerRecord(nodeId = "bbb", pubkey = target, currentIp = "10.0.0.2"), 1L)
        s.addChild("bbb")
        val route = EmergencyMeshSignal.routeTarget(target, s)
        assertEquals("bbb", route!!.first)
        assertEquals(target, route.second)
        assertTrue(route.first != TARGET_BROADCAST)
    }

    @Test
    fun wrapKeepsOfferAnswerIceDisconnect() {
        listOf("offer", "answer", "ice-candidate", "disconnect").forEach { kind ->
            val line = EmergencyMeshSignal.wrap(target, """{"type":"$kind"}""", other, "10.0.0.1")
            assertNotNull(kind, line)
            val env = org.json.JSONObject(line!!)
            assertEquals(EmergencyMeshSignal.TYPE, env.getString("type"))
            assertEquals(target, env.getString("target"))
            assertEquals(kind, env.getJSONObject("signal").getString("type"))
        }
    }

    @Test
    fun onlyIntendedTargetAcceptsSignal() {
        val payload = EmergencyMeshSignal.wrap(target, """{"type":"offer"}""", other, "10.0.0.1")!!
        assertTrue(EmergencyMeshSignal.shouldDeliverToSelf(target, payload))
        assertFalse(EmergencyMeshSignal.shouldDeliverToSelf(other, payload))
        assertFalse(EmergencyMeshSignal.shouldDeliverToSelf(target, """{"type":"webrtc_signal"}"""))
        assertTrue(EmergencyMeshSignal.shouldDeliverToSelf(target, """{"type":"chat"}"""))
    }

    @Test
    fun unicastEngineDoesNotDeliverToBystander() {
        val a = store("aaa")
        val b = store("bbb")
        val c = store("ccc")
        a.upsertDiscovery(MeshPeerRecord(nodeId = "bbb", pubkey = target), 1L)
        a.addChild("bbb")
        val payload = EmergencyMeshSignal.wrap(target, """{"type":"offer"}""", "aaa", "10.0.0.1")!!
        val seenA = EmergencyMeshSeenCache()
        val seenB = EmergencyMeshSeenCache()
        val seenC = EmergencyMeshSeenCache()
        val out = EmergencyMeshEngine.originate(
            selfId = "aaa",
            selfPubkey = "aaa",
            store = a,
            seen = seenA,
            payload = payload,
            targetNodeId = "bbb",
            targetPubkey = target,
            messageId = "sig-1"
        )
        assertEquals(EmergencyMeshEngine.ForwardMode.UNICAST, out.forwardMode)
        assertEquals("bbb", out.nextHopId)
        assertNull(out.deliveredPayload)

        val atB = EmergencyMeshEngine.ingest(
            selfId = "bbb",
            selfPubkey = target,
            store = b,
            seen = seenB,
            fromNodeId = "aaa",
            line = out.wire!!
        )
        assertTrue(atB.delivered)
        assertTrue(EmergencyMeshSignal.shouldDeliverToSelf(target, atB.deliveredPayload!!))

        val atC = EmergencyMeshEngine.ingest(
            selfId = "ccc",
            selfPubkey = other,
            store = c,
            seen = seenC,
            fromNodeId = "aaa",
            line = out.wire!!
        )
        assertFalse(atC.delivered)
        assertFalse(EmergencyMeshSignal.shouldDeliverToSelf(other, payload))
    }

    @Test
    fun inboxKeepsSignalUntilDrained() {
        SosEmergencyState.inbox.clear()
        SosEmergencyState.enqueueInbox("onWebRTCSignal", "10.0.0.2", """{"type":"webrtc_signal","target":"$target"}""")
        SosEmergencyState.enqueueInbox("onChatMessage", "10.0.0.2", """{"type":"chat"}""")
        assertEquals(2, SosEmergencyState.inbox.size)
        val first = SosEmergencyState.inbox.poll()
        assertEquals("onWebRTCSignal", first!!.callback)
        val second = SosEmergencyState.inbox.poll()
        assertEquals("onChatMessage", second!!.callback)
        assertTrue(SosEmergencyState.inbox.isEmpty())
    }
}
