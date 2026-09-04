package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EmergencyMeshP0BTest {

    private class SimNode(val id: String) {
        val store = EmergencyMeshStore()
        val seen = EmergencyMeshSeenCache()
        val delivered = mutableListOf<String>()
        val acks = mutableListOf<String>()
        lateinit var net: SimNet

        init {
            store.applyIdentity(EmergencyNodeIdentity(id, id, "boot-$id", "SOS-$id"))
        }

        fun ingest(from: String, line: String) {
            apply(from, EmergencyMeshEngine.ingest(id, id, store, seen, from, line))
        }

        fun sendTo(target: String, payload: String, messageId: String) {
            val result = EmergencyMeshEngine.originate(
                selfId = id,
                selfPubkey = id,
                store = store,
                seen = seen,
                payload = payload,
                targetNodeId = target,
                messageId = messageId
            )
            apply(id, result)
        }

        private fun apply(from: String, result: EmergencyMeshEngine.Result) {
            result.deliveredPayload?.let { delivered.add(it) }
            result.receivedAck?.refMessageId?.let { acks.add(it) }
            val wire = result.wire
            if (wire != null && result.forwardMode == EmergencyMeshEngine.ForwardMode.UNICAST) {
                result.nextHopId?.let { net.send(id, it, wire) }
            }
            result.ack?.let { ack ->
                val ackRes = EmergencyMeshEngine.ingest(
                    selfId = id,
                    selfPubkey = id,
                    store = store,
                    seen = seen,
                    fromNodeId = id,
                    line = EmergencyMeshEnvelopeCodec.encode(ack)
                )
                ackRes.receivedAck?.refMessageId?.let { acks.add(it) }
                if (ackRes.forwardMode == EmergencyMeshEngine.ForwardMode.UNICAST) {
                    ackRes.nextHopId?.let { net.send(id, it, ackRes.wire!!) }
                }
            }
        }
    }

    private class SimNet {
        val nodes = LinkedHashMap<String, SimNode>()
        val neighbors = HashMap<String, MutableSet<String>>()
        var sends = 0

        fun add(node: SimNode) {
            node.net = this
            nodes[node.id] = node
            neighbors.getOrPut(node.id) { mutableSetOf() }
        }

        fun edge(parent: String, child: String) {
            nodes[parent]!!.store.addChild(child)
            nodes[child]!!.store.setParent(parent)
            neighbors.getOrPut(parent) { mutableSetOf() }.add(child)
            neighbors.getOrPut(child) { mutableSetOf() }.add(parent)
            advertiseUp(child)
            advertiseUp(parent)
        }

        fun disconnect(parent: String, child: String) {
            nodes[parent]!!.store.removeLink(child)
            nodes[child]!!.store.removeLink(parent)
            neighbors[parent]?.remove(child)
            neighbors[child]?.remove(parent)
            advertiseUp(parent)
        }

        fun advertiseUp(nodeId: String) {
            val node = nodes[nodeId] ?: return
            val parentId = node.store.parentNodeId() ?: return
            val parent = nodes[parentId] ?: return
            val self = node.store.identity ?: return
            val frame = EmergencyMeshProtocol.parse(EmergencyMeshTopology.encode(self, node.store)) ?: return
            val changed = EmergencyMeshTopology.apply(parent.store, nodeId, frame)
            if (changed) advertiseUp(parentId)
        }

        fun send(from: String, to: String, line: String) {
            sends++
            assertTrue("infinite forwarding", sends < 400)
            nodes[to]?.ingest(from, line)
        }
    }

    private fun pair(): Triple<SimNet, SimNode, SimNode> {
        val net = SimNet()
        val a = SimNode("aaa")
        val b = SimNode("bbb")
        net.add(a)
        net.add(b)
        net.edge("aaa", "bbb")
        return Triple(net, a, b)
    }

    private fun line3(reverse: Boolean): Map<String, SimNode> {
        val net = SimNet()
        val a = SimNode("aaa")
        val b = SimNode("bbb")
        val c = SimNode("ccc")
        net.add(a)
        net.add(b)
        net.add(c)
        if (reverse) {
            net.edge("bbb", "ccc")
            net.edge("aaa", "bbb")
        } else {
            net.edge("aaa", "bbb")
            net.edge("bbb", "ccc")
        }
        return mapOf("aaa" to a, "bbb" to b, "ccc" to c)
    }

    private fun branchTree(): Pair<SimNet, Map<String, SimNode>> {
        val net = SimNet()
        val a = SimNode("aaa")
        val b = SimNode("bbb")
        val c = SimNode("ccc")
        val d = SimNode("ddd")
        listOf(a, b, c, d).forEach { net.add(it) }
        net.edge("aaa", "bbb")
        net.edge("bbb", "ddd")
        net.edge("aaa", "ccc")
        return net to mapOf("aaa" to a, "bbb" to b, "ccc" to c, "ddd" to d)
    }

    @Test
    fun resetClearsViaChild() {
        val store = EmergencyMeshStore()
        store.applyIdentity(EmergencyNodeIdentity("aaa", "aaa", "boot-a", "SOS-A"))
        store.addChild("bbb")
        store.learnVia("bbb", "ccc")
        assertEquals("bbb", store.nextHopChildFor("ccc"))
        store.reset("boot-new")
        assertNull(store.nextHopChildFor("ccc"))
        assertTrue(store.descendantIds().isEmpty())
    }

    @Test
    fun topologyRoundTripAndIgnoresNonChild() {
        val store = EmergencyMeshStore()
        store.applyIdentity(EmergencyNodeIdentity("aaa", "aaa", "boot-a", "SOS-A"))
        store.addChild("bbb")
        val child = EmergencyMeshStore()
        child.applyIdentity(EmergencyNodeIdentity("bbb", "bbb", "boot-b", "SOS-B"))
        child.addChild("ccc")
        val frame = EmergencyMeshProtocol.parse(EmergencyMeshTopology.encode(child.identity!!, child))!!
        assertEquals(EmergencyMeshProtocol.TOPOLOGY_UPDATE, frame.type)
        assertTrue(frame.reachable.contains("ccc"))
        assertTrue(EmergencyMeshTopology.apply(store, "bbb", frame))
        assertEquals("bbb", store.nextHopChildFor("ccc"))
        assertEquals(MeshPeerRelation.TRANSITIVE, store.get("ccc")?.relation)
        val stranger = EmergencyMeshProtocol.parse(
            EmergencyMeshProtocol.topologyUpdate(
                EmergencyNodeIdentity("zzz", "zzz", "boot-z", "SOS-Z"),
                listOf(MeshReachable("ccc"))
            )
        )!!
        assertFalse(EmergencyMeshTopology.apply(store, "zzz", stranger))
    }

    @Test
    fun abBothDirectionsFromCold() {
        val (_, a, b) = pair()
        a.sendTo(b.id, "a-to-b", "ab1")
        assertEquals(1, b.delivered.count { it == "a-to-b" })
        assertEquals(1, a.acks.count { it == "ab1" })
        b.sendTo(a.id, "b-to-a", "ba1")
        assertEquals(1, a.delivered.count { it == "b-to-a" })
        assertEquals(1, b.acks.count { it == "ba1" })
    }

    @Test
    fun abcBothDirectionsFromCold() {
        val n = line3(reverse = false)
        val a = n["aaa"]!!
        val b = n["bbb"]!!
        val c = n["ccc"]!!
        a.sendTo(c.id, "a-to-c", "ac1")
        assertEquals(1, c.delivered.count { it == "a-to-c" })
        assertEquals(0, b.delivered.count { it == "a-to-c" })
        assertEquals(1, a.acks.count { it == "ac1" })
        c.sendTo(a.id, "c-to-a", "ca1")
        assertEquals(1, a.delivered.count { it == "c-to-a" })
        assertEquals(1, c.acks.count { it == "ca1" })
        b.sendTo(c.id, "b-to-c", "bc1")
        assertEquals(1, c.delivered.count { it == "b-to-c" })
        c.sendTo(b.id, "c-to-b", "cb1")
        assertEquals(1, b.delivered.count { it == "c-to-b" })
    }

    @Test
    fun abcReversedConstructionSameRoutes() {
        val n = line3(reverse = true)
        val a = n["aaa"]!!
        val c = n["ccc"]!!
        assertEquals("bbb", a.store.nextHopChildFor("ccc"))
        a.sendTo(c.id, "a-to-c", "acr")
        assertEquals(1, c.delivered.count { it == "a-to-c" })
        c.sendTo(a.id, "c-to-a", "car")
        assertEquals(1, a.delivered.count { it == "c-to-a" })
    }

    @Test
    fun branchTreeColdRoutesAndDisconnectRemovesD() {
        val (net, n) = branchTree()
        val a = n["aaa"]!!
        val c = n["ccc"]!!
        val d = n["ddd"]!!
        c.sendTo(d.id, "c-to-d", "cd1")
        assertEquals(1, d.delivered.count { it == "c-to-d" })
        d.sendTo(c.id, "d-to-c", "dc1")
        assertEquals(1, c.delivered.count { it == "d-to-c" })
        a.sendTo(d.id, "a-to-d", "ad1")
        assertEquals(1, d.delivered.count { it == "a-to-d" })
        d.sendTo(a.id, "d-to-a", "da1")
        assertEquals(1, a.delivered.count { it == "d-to-a" })

        net.disconnect("aaa", "bbb")
        assertNull(a.store.nextHopChildFor("ddd"))
        assertFalse(a.store.descendantIds().contains("ddd"))
        a.sendTo(d.id, "a-to-d-after", "adx")
        assertEquals(0, d.delivered.count { it == "a-to-d-after" })
        c.sendTo(d.id, "c-to-d-after", "cdx")
        assertEquals(0, d.delivered.count { it == "c-to-d-after" })
    }

    @Test
    fun subtreeReplaceDropsStaleDest() {
        val store = EmergencyMeshStore()
        store.applyIdentity(EmergencyNodeIdentity("aaa", "aaa", "boot-a", "SOS-A"))
        store.addChild("bbb")
        assertTrue(store.applySubtree("bbb", listOf(MeshReachable("ccc"), MeshReachable("ddd"))))
        assertEquals("bbb", store.nextHopChildFor("ddd"))
        assertTrue(store.applySubtree("bbb", listOf(MeshReachable("ccc"))))
        assertNull(store.nextHopChildFor("ddd"))
        assertEquals(MeshPeerRelation.UNREACHABLE, store.get("ddd")?.relation)
        assertEquals("bbb", store.nextHopChildFor("ccc"))
    }
}
