package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EmergencyMeshMobilityTest {

    private val a = "zzz"
    private val b = "bbb"
    private val c = "ccc"

    private fun cand(
        id: String,
        depth: Int = 0,
        rssi: Int = -50,
        kids: Int = 0,
        tree: Boolean = true,
        relation: MeshPeerRelation = MeshPeerRelation.DISCOVERED
    ): MeshParentCandidate {
        return MeshParentCandidate(id, relation, kids, 3, depth, rssi, CapabilityState.SUPPORTED, tree)
    }

    @Test
    fun briefOneSecondLossDoesNotDrop() {
        val start = 1_000L
        assertFalse(EmergencyMeshMobility.shouldDropAfterGrace(start, start + 1_000L))
    }

    @Test
    fun graceExpiryAllowsDrop() {
        val start = 1_000L
        assertTrue(
            EmergencyMeshMobility.shouldDropAfterGrace(
                start,
                start + EmergencyMeshMobility.DEGRADED_GRACE_MS
            )
        )
    }

    @Test
    fun fastReattachWhenStillOnParentLan() {
        val now = 10_000L
        val last = LastGoodParent(nodeId = b, lastIp = "10.0.0.1", lastConnectedAtMs = now)
        assertTrue(EmergencyMeshMobility.stationStillOnParentLan("10.0.0.8", "10.0.0.1"))
        assertTrue(EmergencyMeshMobility.shouldFastReattach(true, last, now, alreadyTried = false))
        assertFalse(EmergencyMeshMobility.shouldFastReattach(true, last, now, alreadyTried = true))
        assertFalse(EmergencyMeshMobility.shouldFastReattach(false, last, now, alreadyTried = false))
    }

    @Test
    fun lastGoodPreferredWhenRecovering() {
        val pick = EmergencyMeshMobility.pickRecoveryParent(
            selfId = a,
            childIds = emptySet(),
            descendantIds = emptySet(),
            hasChildren = false,
            staAp = CapabilityState.SUPPORTED,
            candidates = listOf(cand(c, rssi = -30), cand(b, rssi = -70)),
            lastGoodNodeId = b,
            lastSwitchMs = 0L,
            nowMs = 1_000L,
            currentHealthyParentId = null
        )
        assertEquals(b, pick?.nodeId)
    }

    @Test
    fun healthyParentDoesNotSwitch() {
        val pick = EmergencyMeshMobility.pickRecoveryParent(
            selfId = a,
            childIds = emptySet(),
            descendantIds = emptySet(),
            hasChildren = false,
            staAp = CapabilityState.SUPPORTED,
            candidates = listOf(cand(c, rssi = -20)),
            lastGoodNodeId = b,
            lastSwitchMs = 0L,
            nowMs = 1_000L,
            currentHealthyParentId = b
        )
        assertNull(pick)
    }

    @Test
    fun cooldownAvoidsPingPongToOldParent() {
        val now = 5_000L
        val pick = EmergencyMeshMobility.pickRecoveryParent(
            selfId = a,
            childIds = emptySet(),
            descendantIds = emptySet(),
            hasChildren = false,
            staAp = CapabilityState.SUPPORTED,
            candidates = listOf(cand(b, rssi = -70), cand(c, rssi = -20)),
            lastGoodNodeId = b,
            lastSwitchMs = now - 1_000L,
            nowMs = now,
            currentHealthyParentId = null
        )
        assertEquals(c, pick?.nodeId)
    }

    @Test
    fun twoAlternatesPickDeterministicWinner() {
        val pick = EmergencyMeshDecision.pickBestParent(
            selfId = a,
            childIds = emptySet(),
            descendantIds = emptySet(),
            parentId = null,
            hasChildren = false,
            staAp = CapabilityState.SUPPORTED,
            candidates = listOf(cand(c, depth = 1, rssi = -40), cand(b, depth = 1, rssi = -40))
        )
        assertEquals(b, pick?.nodeId)
    }

    @Test
    fun descendantCandidateRejected() {
        val pick = EmergencyMeshDecision.pickBestParent(
            selfId = a,
            childIds = setOf(b),
            descendantIds = setOf(b, c),
            parentId = null,
            hasChildren = true,
            staAp = CapabilityState.SUPPORTED,
            candidates = listOf(cand(c))
        )
        assertNull(pick)
    }

    @Test
    fun childCannotBecomeParent() {
        val pick = EmergencyMeshDecision.pickBestParent(
            selfId = a,
            childIds = setOf(b),
            descendantIds = setOf(b),
            parentId = null,
            hasChildren = true,
            staAp = CapabilityState.SUPPORTED,
            candidates = listOf(cand(b))
        )
        assertNull(pick)
    }

    @Test
    fun hysteresisIgnoresSmallRssiChange() {
        assertFalse(
            EmergencyMeshMobility.shouldSwitchParent(
                currentHealthy = true,
                currentRssi = -50,
                candidateRssi = -45,
                lastSwitchMs = 0L,
                nowMs = 20_000L
            )
        )
        assertTrue(
            EmergencyMeshMobility.shouldSwitchParent(
                currentHealthy = true,
                currentRssi = -70,
                candidateRssi = -50,
                lastSwitchMs = 0L,
                nowMs = 20_000L
            )
        )
    }

    @Test
    fun ipChangeKeepsSameNodeId() {
        val store = EmergencyMeshStore()
        store.applyIdentity(EmergencyNodeIdentity(a, a, "boot-a", "SOS-A"))
        store.upsertDiscovery(
            MeshPeerRecord(nodeId = b, pubkey = "bb".repeat(32), currentIp = "10.0.0.2"),
            1_000L
        )
        store.upsertDiscovery(
            MeshPeerRecord(nodeId = b, pubkey = "bb".repeat(32), currentIp = "10.0.0.9"),
            2_000L
        )
        assertEquals(1, store.allPeers().count { it.nodeId == b })
        assertEquals("10.0.0.9", store.get(b)?.currentIp)
        assertEquals(b, store.findByIp("10.0.0.9")?.nodeId)
    }

    @Test
    fun candidateCacheTtlLongerWhileRecovering() {
        assertEquals(EmergencyMeshDecision.DISCOVERY_EXPIRE_MS, EmergencyMeshMobility.candidateTtl(false))
        assertEquals(EmergencyMeshMobility.CANDIDATE_TTL_MS, EmergencyMeshMobility.candidateTtl(true))
        assertTrue(EmergencyMeshMobility.CANDIDATE_TTL_MS > EmergencyMeshDecision.DISCOVERY_EXPIRE_MS)
        val now = 100_000L
        assertTrue(
            EmergencyMeshDecision.isDiscoveryFresh(
                now - 40_000L,
                now,
                EmergencyMeshMobility.CANDIDATE_TTL_MS
            )
        )
        assertFalse(
            EmergencyMeshDecision.isDiscoveryFresh(
                now - 40_000L,
                now,
                EmergencyMeshDecision.DISCOVERY_EXPIRE_MS
            )
        )
    }

    @Test
    fun nostrBackoffGrowsThenCaps() {
        val steps = longArrayOf(2_000L, 5_000L, 15_000L, 30_000L, 60_000L)
        assertEquals(2_000L, steps[0])
        assertEquals(60_000L, steps[4.coerceAtMost(steps.lastIndex)])
        assertEquals(60_000L, steps[9.coerceAtMost(steps.lastIndex)])
        assertNotEquals(5_000L, steps[0])
    }

    @Test
    fun rememberLastGoodThenFailureBackoff() {
        val now = 1_000L
        val good = EmergencyMeshMobility.rememberLastGood(b, "pk", "SOS-B", "10.0.0.1", -40, "boot", now)
        assertEquals(0, good.failureCount)
        val failed = EmergencyMeshMobility.noteFailure(good, now)
        assertNotNull(failed)
        assertEquals(1, failed!!.failureCount)
        assertTrue(failed.retryAfterMs > now)
        assertFalse(
            EmergencyMeshMobility.shouldFastReattach(true, failed, now, alreadyTried = false)
        )
    }
}
