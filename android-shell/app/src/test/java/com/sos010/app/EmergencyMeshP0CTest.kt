package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class EmergencyMeshP0CTest {

    private val low = "aa".repeat(32)
    private val high = "ff".repeat(32)

    @Before
    fun resetOwner() {
        SosP2pOwner.resetForTest()
    }

    @Test
    fun exactlyOneInitiatorForTwoPubkeys() {
        assertTrue(SosP2pOwner.amInitiator(low, high))
        assertFalse(SosP2pOwner.amInitiator(high, low))
        assertFalse(SosP2pOwner.amInitiator(low, low))
        assertEquals(1, listOf(low, high).count { SosP2pOwner.amInitiator(it, if (it == low) high else low) })
    }

    @Test
    fun jsAndNativeShareSameInitiatorRule() {
        fun jsRule(self: String, peer: String): Boolean = self.lowercase() < peer.lowercase()
        assertEquals(jsRule(low, high), SosP2pOwner.amInitiator(low, high))
        assertEquals(jsRule(high, low), SosP2pOwner.amInitiator(high, low))
        assertEquals(jsRule("AbC", "abd"), SosP2pOwner.amInitiator("AbC", "abd"))
    }

    @Test
    fun meshSignalReachesOnlyIntendedPubkey() {
        val store = EmergencyMeshStore()
        store.applyIdentity(EmergencyNodeIdentity("aaa", "aaa", "boot-a", "SOS-A"))
        store.upsertDiscovery(MeshPeerRecord(nodeId = "bbb", pubkey = low, currentIp = "10.0.0.2"), 1L)
        store.addChild("bbb")
        assertTrue(EmergencyMeshSignal.isMeshSignalTarget(low, store, setOf("bbb")))
        assertFalse(EmergencyMeshSignal.isMeshSignalTarget(high, store, setOf("bbb")))
        val payload = EmergencyMeshSignal.wrap(low, """{"type":"dc-offer","data":{"type":"offer"}}""", high, "10.0.0.1")!!
        assertTrue(EmergencyMeshSignal.shouldDeliverToSelf(low, payload))
        assertFalse(EmergencyMeshSignal.shouldDeliverToSelf(high, payload))
    }

    @Test
    fun ownershipHandoffIsExclusive() {
        SosP2pOwner.onActivityGone(standbyEnabled = true)
        assertTrue(SosP2pOwner.nativeMayHandle())
        assertTrue(SosP2pOwner.claim(low, SosP2pOwnerKind.NATIVE))
        assertTrue(SosP2pOwner.hasExclusiveOwner(low))
        SosP2pOwner.markWebViewReady()
        assertFalse(SosP2pOwner.nativeMayHandle())
        assertFalse(SosP2pOwner.claim(low, SosP2pOwnerKind.NATIVE))
        assertTrue(SosP2pOwner.claim(low, SosP2pOwnerKind.WEBVIEW))
        assertTrue(SosP2pOwner.hasExclusiveOwner(low))
        assertEquals(SosP2pOwnerKind.WEBVIEW, SosP2pOwner.kind)
    }

    @Test
    fun foregroundDoesNotDropNativeBeforeWebViewReady() {
        SosP2pOwner.onActivityGone(standbyEnabled = true)
        assertTrue(SosP2pOwner.nativeMayHandle())
        SosP2pOwner.onUiForeground()
        assertEquals(SosP2pOwnerKind.HANDOFF, SosP2pOwner.kind)
        assertTrue(SosP2pOwner.nativeMayHandle())
        SosP2pOwner.markWebViewReady()
        assertFalse(SosP2pOwner.nativeMayHandle())
    }
}
