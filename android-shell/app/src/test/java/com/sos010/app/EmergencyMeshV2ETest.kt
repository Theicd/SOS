package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EmergencyMeshV2ETest {

    private fun store(self: String): EmergencyMeshStore {
        val s = EmergencyMeshStore()
        s.applyIdentity(EmergencyNodeIdentity(self, self, "boot-$self", "SOS-$self"))
        return s
    }

    @Test
    fun groupResolvesToBroadcast() {
        val s = store("aaa")
        assertTrue(EmergencyMeshPeers.isGroupTarget(EmergencyMeshPeers.GROUP_PUBKEY))
        assertTrue(EmergencyMeshPeers.isGroupTarget("*"))
        assertEquals(TARGET_BROADCAST to "", EmergencyMeshPeers.resolveTarget(EmergencyMeshPeers.GROUP_PUBKEY, s))
    }

    @Test
    fun directResolvesPubkeyToNodeId() {
        val s = store("aaa")
        val pk = "ab".repeat(32)
        s.upsertDiscovery(MeshPeerRecord(nodeId = "bbb", pubkey = pk, currentIp = "10.0.0.2"), 1L)
        s.addChild("bbb")
        val (nodeId, targetPk) = EmergencyMeshPeers.resolveTarget(pk, s)
        assertEquals("bbb", nodeId)
        assertEquals(pk, targetPk)
    }

    @Test
    fun discoveredIsNotReachable() {
        val s = store("aaa")
        s.upsertDiscovery(MeshPeerRecord(nodeId = "bbb", pubkey = "bb", currentIp = "10.0.0.2"), 1L)
        val rec = s.get("bbb")!!
        assertFalse(EmergencyMeshPeers.isReachable(rec, setOf("bbb")))
        val json = EmergencyMeshPeers.toJson(rec, setOf("bbb"), s)
        assertFalse(json.getBoolean("reachable"))
        assertEquals("DISCOVERED", json.getString("relation"))
        assertEquals("discovered", json.getString("type"))
        assertEquals(0, json.getInt("hops"))
    }

    @Test
    fun connectedChildIsReachable() {
        val s = store("aaa")
        s.upsertDiscovery(MeshPeerRecord(nodeId = "bbb", pubkey = "bb", currentIp = "10.0.0.2", name = "B"), 1L)
        s.addChild("bbb")
        val rec = s.get("bbb")!!
        assertTrue(EmergencyMeshPeers.isReachable(rec, setOf("bbb")))
        val json = EmergencyMeshPeers.toJson(rec, setOf("bbb"), s)
        assertTrue(json.getBoolean("reachable"))
        assertEquals(1, json.getInt("hops"))
        assertEquals("relay", json.getString("type"))
    }

    @Test
    fun listOmitsSelfAndKeepsDiscoveredSeparate() {
        val s = store("aaa")
        s.upsertDiscovery(MeshPeerRecord(nodeId = "aaa", pubkey = "aaa"), 1L)
        s.upsertDiscovery(MeshPeerRecord(nodeId = "bbb", pubkey = "bbb", currentIp = "10.0.0.2"), 1L)
        s.upsertDiscovery(MeshPeerRecord(nodeId = "ccc", pubkey = "ccc", currentIp = "10.0.0.3"), 1L)
        s.addChild("bbb")
        val arr = EmergencyMeshPeers.listJson(s, setOf("bbb"), "aaa")
        assertEquals(2, arr.length())
        val byId = (0 until arr.length()).associate { arr.getJSONObject(it).getString("nodeId") to arr.getJSONObject(it) }
        assertTrue(byId.getValue("bbb").getBoolean("reachable"))
        assertFalse(byId.getValue("ccc").getBoolean("reachable"))
        assertEquals(1, EmergencyMeshPeers.connectedIps(s, "").length())
    }

    @Test
    fun findByPubkeyAndDeliveryTrack() {
        val s = store("aaa")
        val pk = "cd".repeat(32)
        s.upsertDiscovery(MeshPeerRecord(nodeId = "zzz", pubkey = pk), 2L)
        assertEquals("zzz", s.findByPubkey(pk)?.nodeId)
        SosEmergencyState.meshDelivery.clear()
        SosEmergencyState.trackDelivery("mid-1", MeshAckStatus.SENT.name)
        assertEquals(MeshAckStatus.SENT.name, SosEmergencyState.deliveryStatus("mid-1"))
        SosEmergencyState.trackDelivery("mid-1", MeshAckStatus.DELIVERED.name)
        assertEquals(MeshAckStatus.DELIVERED.name, SosEmergencyState.deliveryStatus("mid-1"))
        SosEmergencyState.meshDelivery.clear()
    }
}
