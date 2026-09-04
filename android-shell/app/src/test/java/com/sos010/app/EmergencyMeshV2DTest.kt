package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EmergencyMeshV2DTest {

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
            val result = EmergencyMeshEngine.ingest(
                selfId = id,
                selfPubkey = id,
                store = store,
                seen = seen,
                fromNodeId = from,
                line = line
            )
            apply(from, result)
        }

        private fun apply(from: String, result: EmergencyMeshEngine.Result) {
            result.deliveredPayload?.let { delivered.add(it) }
            result.receivedAck?.refMessageId?.let { acks.add(it) }
            val wire = result.wire
            if (wire != null) {
                when (result.forwardMode) {
                    EmergencyMeshEngine.ForwardMode.FLOOD -> net.flood(id, from, wire)
                    EmergencyMeshEngine.ForwardMode.UNICAST -> result.nextHopId?.let { net.send(id, it, wire) }
                    EmergencyMeshEngine.ForwardMode.NONE -> {}
                }
            }
            result.ack?.let { ack ->
                val ackLine = EmergencyMeshEnvelopeCodec.encode(ack)
                val ackRes = EmergencyMeshEngine.ingest(
                    selfId = id,
                    selfPubkey = id,
                    store = store,
                    seen = seen,
                    fromNodeId = id,
                    line = ackLine
                )
                ackRes.receivedAck?.refMessageId?.let { acks.add(it) }
                val ackWire = ackRes.wire
                if (ackWire != null && ackRes.forwardMode == EmergencyMeshEngine.ForwardMode.UNICAST) {
                    ackRes.nextHopId?.let { net.send(id, it, ackWire) }
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
        }

        fun send(from: String, to: String, line: String) {
            sends++
            assertTrue("infinite forwarding", sends < 400)
            nodes[to]?.ingest(from, line)
        }

        fun flood(from: String, incoming: String, line: String) {
            neighbors[from].orEmpty().forEach { n ->
                if (n != incoming && n != from) send(from, n, line)
            }
        }
    }

    private fun tree3(): Triple<SimNet, SimNode, Map<String, SimNode>> {
        val net = SimNet()
        val a = SimNode("aaa"); val b = SimNode("bbb"); val c = SimNode("ccc")
        net.add(a); net.add(b); net.add(c)
        net.edge("aaa", "bbb")
        net.edge("bbb", "ccc")
        return Triple(net, a, mapOf("aaa" to a, "bbb" to b, "ccc" to c))
    }

    private fun tree5(): Pair<SimNet, Map<String, SimNode>> {
        val net = SimNet()
        val nodes = listOf("aaa", "bbb", "ccc", "ddd", "eee").associateWith { SimNode(it) }
        nodes.values.forEach { net.add(it) }
        net.edge("aaa", "bbb")
        net.edge("bbb", "ccc")
        net.edge("aaa", "ddd")
        net.edge("ddd", "eee")
        return net to nodes
    }

    @Test
    fun parseRejectsBadEnvelope() {
        assertNull(EmergencyMeshEnvelopeCodec.parse("{"))
        assertNull(EmergencyMeshEnvelopeCodec.parse("""{"protocol":"SOS_MESH","version":2,"type":"DATA"}"""))
        assertNull(
            EmergencyMeshEnvelopeCodec.parse(
                EmergencyMeshEnvelopeCodec.encode(
                    EmergencyMeshEnvelopeCodec.data("a", "*", "x")
                ).replace("\"ttl\":12", "\"ttl\":-1")
            )
        )
    }

    @Test
    fun dataRoundTripAndHop() {
        val env = EmergencyMeshEnvelopeCodec.data("aaa", "bbb", """{"type":"chat","t":"hi"}""")
        val parsed = EmergencyMeshEnvelopeCodec.parse(EmergencyMeshEnvelopeCodec.encode(env))
        assertEquals(EmergencyMeshProtocol.DATA, parsed!!.type)
        assertEquals("aaa", parsed.originNodeId)
        assertEquals("bbb", parsed.targetNodeId)
        val next = EmergencyMeshEnvelopeCodec.advanced(parsed)!!
        assertEquals(11, next.ttl)
        assertEquals(1, next.hopCount)
        val dead = env.copy(ttl = 0)
        assertNull(EmergencyMeshEnvelopeCodec.advanced(dead))
    }

    @Test
    fun seenDropsDuplicateAndStaysBounded() {
        val seen = EmergencyMeshSeenCache(maxIds = 8, expireMs = 1_000L)
        assertTrue(seen.markIfNew("m1", 1000L))
        assertFalse(seen.markIfNew("m1", 1001L))
        for (i in 2..20) seen.markIfNew("m$i", 1000L)
        assertTrue(seen.size() <= 8)
        assertFalse(seen.contains("m1"))
        val expired = EmergencyMeshSeenCache(maxIds = 100, expireMs = 10L)
        assertTrue(expired.markIfNew("old", 1L))
        assertTrue(expired.markIfNew("new", 100L))
        assertFalse(expired.contains("old"))
    }

    @Test
    fun threeHopBroadcastOnceAndUnicastAck() {
        val (net, _, n) = tree3()
        val a = n["aaa"]!!; val b = n["bbb"]!!; val c = n["ccc"]!!
        val result = EmergencyMeshEngine.originate(
            selfId = a.id, selfPubkey = a.id, store = a.store, seen = a.seen,
            payload = "hello-all", targetNodeId = TARGET_BROADCAST, messageId = "mid-b1"
        )
        a.delivered.addAll(listOfNotNull(result.deliveredPayload))
        net.flood(a.id, a.id, result.wire!!)
        assertEquals(1, a.delivered.count { it == "hello-all" })
        assertEquals(1, b.delivered.count { it == "hello-all" })
        assertEquals(1, c.delivered.count { it == "hello-all" })
        b.ingest(a.id, result.wire!!)
        assertEquals(1, b.delivered.count { it == "hello-all" })
        assertTrue(net.sends < 20)

        net.sends = 0
        val uni = EmergencyMeshEngine.originate(
            selfId = c.id, selfPubkey = c.id, store = c.store, seen = c.seen,
            payload = "from-c", targetNodeId = a.id, messageId = "mid-u1"
        )
        assertEquals(EmergencyMeshEngine.ForwardMode.UNICAST, uni.forwardMode)
        net.send(c.id, uni.nextHopId!!, uni.wire!!)
        assertEquals(1, a.delivered.count { it == "from-c" })
        assertEquals(0, b.delivered.count { it == "from-c" })
        assertEquals(1, c.acks.count { it == "mid-u1" })
    }

    @Test
    fun fiveNodeUnicastAndAckReturn() {
        val (net, n) = tree5()
        val c = n["ccc"]!!; val e = n["eee"]!!; val a = n["aaa"]!!
        val b = n["bbb"]!!; val d = n["ddd"]!!
        a.store.learnVia("bbb", "ccc")
        a.store.learnVia("ddd", "eee")
        val out = EmergencyMeshEngine.originate(
            selfId = c.id, selfPubkey = c.id, store = c.store, seen = c.seen,
            payload = "c-to-e", targetNodeId = e.id, messageId = "mid-5"
        )
        net.send(c.id, out.nextHopId!!, out.wire!!)
        assertEquals(1, e.delivered.count { it == "c-to-e" })
        assertEquals(0, a.delivered.count { it == "c-to-e" })
        assertEquals(0, b.delivered.count { it == "c-to-e" })
        assertEquals(0, d.delivered.count { it == "c-to-e" })
        assertEquals(1, c.acks.count { it == "mid-5" })
        e.ingest(d.id, EmergencyMeshEnvelopeCodec.encode(
            EmergencyMeshEnvelopeCodec.data(c.id, e.id, "c-to-e", messageId = "mid-5")
        ))
        assertEquals(1, e.delivered.count { it == "c-to-e" })
    }

    @Test
    fun ttlStopsBeforeDestination() {
        val (net, n) = tree5()
        val c = n["ccc"]!!; val e = n["eee"]!!
        val out = EmergencyMeshEngine.originate(
            selfId = c.id, selfPubkey = c.id, store = c.store, seen = c.seen,
            payload = "short", targetNodeId = e.id, messageId = "mid-ttl", ttl = 1
        )
        net.send(c.id, out.nextHopId!!, out.wire!!)
        assertTrue(e.delivered.none { it == "short" })
    }

    @Test
    fun cycleCannotDeliverTwiceOrLoopForever() {
        val net = SimNet()
        val a = SimNode("aaa"); val b = SimNode("bbb")
        net.add(a); net.add(b)
        net.neighbors["aaa"]!!.add("bbb")
        net.neighbors["bbb"]!!.add("aaa")
        val env = EmergencyMeshEnvelopeCodec.data("aaa", TARGET_BROADCAST, "loop", messageId = "mid-loop", ttl = 12)
        val line = EmergencyMeshEnvelopeCodec.encode(env)
        a.seen.markIfNew("mid-loop")
        net.send("aaa", "bbb", line)
        net.send("bbb", "aaa", EmergencyMeshEnvelopeCodec.encode(EmergencyMeshEnvelopeCodec.advanced(env)!!))
        assertEquals(1, b.delivered.count { it == "loop" })
        assertEquals(0, a.delivered.count { it == "loop" })
        assertTrue(net.sends < 10)
    }

    @Test
    fun ackHasOwnIdSoOriginSeenDataDoesNotDropAck() {
        val ack = EmergencyMeshEnvelopeCodec.ack("bbb", "aaa", "mid-data", MeshAckStatus.DELIVERED)
        assertNotEqualsSafe(ack.messageId, "mid-data")
        assertEquals("mid-data", ack.refMessageId)
        val seen = EmergencyMeshSeenCache()
        assertTrue(seen.markIfNew("mid-data"))
        assertTrue(seen.markIfNew(ack.messageId))
    }

    private fun assertNotEqualsSafe(a: String, b: String) {
        assertTrue(a != b)
    }
}
