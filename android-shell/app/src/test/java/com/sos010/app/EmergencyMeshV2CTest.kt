package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.PrintWriter
import java.io.StringWriter
import java.io.Writer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.TimeUnit

class EmergencyMeshV2CTest {

    private fun link(
        nodeId: String,
        relation: MeshPeerRelation,
        ip: String = "10.0.0.${nodeId.hashCode().and(0xff)}",
        writer: PrintWriter = PrintWriter(StringWriter(), true),
        table: EmergencyMeshLinkTable? = null
    ): EmergencyMeshLink {
        return EmergencyMeshLink(
            remoteNodeId = nodeId,
            remoteBootId = "boot-$nodeId",
            relation = relation,
            currentIp = ip,
            writer = writer,
            onClosed = { table?.detachIfCurrent(it) }
        )
    }

    @Test
    fun oneLiveLinkPerNodeId() {
        val table = EmergencyMeshLinkTable()
        val first = link("aaa", MeshPeerRelation.DIRECT_CHILD, table = table)
        val second = link("aaa", MeshPeerRelation.DIRECT_CHILD, ip = "10.0.0.9", table = table)
        table.attach(first)
        table.attach(second)
        assertEquals(1, table.liveCount("aaa"))
        assertFalse(first.isLive())
        assertTrue(second.isLive())
        assertEquals(second, table.get("aaa"))
    }

    @Test
    fun onlyOneLiveParent() {
        val table = EmergencyMeshLinkTable()
        val p1 = link("aaa", MeshPeerRelation.DIRECT_PARENT, table = table)
        val p2 = link("bbb", MeshPeerRelation.DIRECT_PARENT, table = table)
        table.attach(p1)
        table.attach(p2)
        assertEquals(1, table.parentCount())
        assertFalse(p1.isLive())
        assertTrue(p2.isLive())
        assertEquals("bbb", table.parent()?.remoteNodeId)
    }

    @Test
    fun parentAndChildAreDifferentLinks() {
        val table = EmergencyMeshLinkTable()
        table.attach(link("aaa", MeshPeerRelation.DIRECT_PARENT, table = table))
        table.attach(link("bbb", MeshPeerRelation.DIRECT_CHILD, table = table))
        assertEquals(1, table.parentCount())
        assertEquals(1, table.children().size)
        assertEquals(2, table.live().size)
    }

    @Test
    fun disconnectCleanupRemovesLink() {
        val table = EmergencyMeshLinkTable()
        val child = link("ccc", MeshPeerRelation.DIRECT_CHILD, ip = "10.1.1.3", table = table)
        table.attach(child)
        assertEquals(child, table.findByIp("10.1.1.3"))
        child.close()
        table.detachIfCurrent(child)
        assertNull(table.get("ccc"))
        assertNull(table.findByIp("10.1.1.3"))
        assertEquals(0, table.live().size)
        assertFalse(child.isLive())
    }

    @Test
    fun closeAllClearsTable() {
        val table = EmergencyMeshLinkTable()
        val a = link("aaa", MeshPeerRelation.DIRECT_PARENT, table = table)
        val b = link("bbb", MeshPeerRelation.DIRECT_CHILD, table = table)
        table.attach(a)
        table.attach(b)
        table.closeAll()
        assertEquals(0, table.size())
        assertFalse(a.isLive())
        assertFalse(b.isLive())
    }

    @Test
    fun sendAfterCloseFails() {
        val link = link("aaa", MeshPeerRelation.DIRECT_CHILD)
        assertTrue(link.send("PING"))
        link.close()
        assertFalse(link.send("PONG"))
        assertEquals(MeshLinkState.CLOSED, link.state)
    }

    @Test
    fun writesAreSerializedWholeLines() {
        val dest = StringBuilder()
        val slow = object : Writer() {
            override fun write(cbuf: CharArray, off: Int, len: Int) {
                synchronized(dest) {
                    dest.append(cbuf, off, len)
                }
            }
            override fun flush() {}
            override fun close() {}
        }
        val link = EmergencyMeshLink(
            remoteNodeId = "aaa",
            relation = MeshPeerRelation.DIRECT_CHILD,
            writer = PrintWriter(slow, false)
        )
        val start = CyclicBarrier(2)
        val done = CountDownLatch(2)
        Thread {
            start.await(2, TimeUnit.SECONDS)
            repeat(80) { link.send("AAAA") }
            done.countDown()
        }.start()
        Thread {
            start.await(2, TimeUnit.SECONDS)
            repeat(80) { link.send("BBBB") }
            done.countDown()
        }.start()
        assertTrue(done.await(5, TimeUnit.SECONDS))
        val text = dest.toString()
        val lines = text.split('\n').map { it.trim() }.filter { it.isNotEmpty() }
        assertEquals(160, lines.size)
        assertTrue(lines.all { it == "AAAA" || it == "BBBB" })
        assertEquals(80, lines.count { it == "AAAA" })
        assertEquals(80, lines.count { it == "BBBB" })
    }

    @Test
    fun staleRxDetectedWithoutClosingAutomatically() {
        val link = link("aaa", MeshPeerRelation.DIRECT_PARENT)
        val now = link.lastRxMs
        assertFalse(link.isRxStale(now + 1_000L))
        assertTrue(link.isRxStale(now + EmergencyMeshLink.HEARTBEAT_TIMEOUT_MS + 1))
        assertTrue(link.isLive())
        assertNotEquals(MeshLinkState.CLOSED, link.state)
    }
}
