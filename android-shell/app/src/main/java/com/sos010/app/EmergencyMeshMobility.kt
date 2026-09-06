package com.sos010.app

/**
 * החלטות ניידות טהורות — חלון DEGRADED, FAST_REATTACH, hysteresis.
 * בלי Android, בלי שירות שני. | HYPER CORE TECH
 */
enum class MeshMobilityPhase {
    CONNECTED,
    DEGRADED,
    FAST_REATTACH,
    SEARCHING_ALTERNATIVE,
    REJOINING,
    CONNECTED_NEW_PARENT
}

data class LastGoodParent(
    val nodeId: String,
    val pubkey: String = "",
    val ssid: String = "",
    val lastIp: String = "",
    val lastSeenMs: Long = 0L,
    val lastConnectedAtMs: Long = 0L,
    val lastRssi: Int = -100,
    val bootId: String = "",
    val failureCount: Int = 0,
    val retryAfterMs: Long = 0L
)

object EmergencyMeshMobility {
    const val DEGRADED_GRACE_MS = 8_000L
    const val FAST_REATTACH_WINDOW_MS = 15_000L
    const val SWITCH_COOLDOWN_MS = 20_000L
    const val CANDIDATE_TTL_MS = 90_000L
    const val RSSI_HYSTERESIS_DBM = 12
    const val MAX_PARENT_FAILURES = 3
    private const val FAILURE_BACKOFF_MS = 4_000L

    fun shouldDropAfterGrace(
        degradedSinceMs: Long,
        nowMs: Long,
        graceMs: Long = DEGRADED_GRACE_MS
    ): Boolean {
        if (degradedSinceMs <= 0L) return false
        return nowMs - degradedSinceMs >= graceMs
    }

    fun stationStillOnParentLan(stationIp: String, parentIp: String): Boolean {
        if (stationIp.isBlank() || parentIp.isBlank()) return false
        return EmergencyMeshNetRole.sameSlash24(stationIp, parentIp)
    }

    fun shouldFastReattach(
        stationOnParentLan: Boolean,
        lastGood: LastGoodParent?,
        nowMs: Long,
        alreadyTried: Boolean
    ): Boolean {
        if (alreadyTried || !stationOnParentLan) return false
        if (lastGood == null || lastGood.nodeId.isBlank() || lastGood.lastIp.isBlank()) return false
        if (lastGood.retryAfterMs > nowMs) return false
        if (lastGood.failureCount >= MAX_PARENT_FAILURES) return false
        return true
    }

    fun shouldSwitchParent(
        currentHealthy: Boolean,
        currentRssi: Int,
        candidateRssi: Int,
        lastSwitchMs: Long,
        nowMs: Long,
        cooldownMs: Long = SWITCH_COOLDOWN_MS
    ): Boolean {
        if (currentHealthy) {
            if (lastSwitchMs > 0L && nowMs - lastSwitchMs < cooldownMs) return false
            return candidateRssi >= currentRssi + RSSI_HYSTERESIS_DBM
        }
        return true
    }

    fun rememberLastGood(
        nodeId: String,
        pubkey: String,
        ssid: String,
        ip: String,
        rssi: Int,
        bootId: String,
        nowMs: Long
    ): LastGoodParent {
        return LastGoodParent(
            nodeId = nodeId,
            pubkey = pubkey,
            ssid = ssid,
            lastIp = ip,
            lastSeenMs = nowMs,
            lastConnectedAtMs = nowMs,
            lastRssi = rssi,
            bootId = bootId,
            failureCount = 0,
            retryAfterMs = 0L
        )
    }

    fun noteFailure(prev: LastGoodParent?, nowMs: Long): LastGoodParent? {
        if (prev == null) return null
        val nextCount = prev.failureCount + 1
        return prev.copy(
            failureCount = nextCount,
            retryAfterMs = nowMs + (FAILURE_BACKOFF_MS * nextCount)
        )
    }

    fun candidateTtl(recovering: Boolean): Long {
        return if (recovering) CANDIDATE_TTL_MS else EmergencyMeshDecision.DISCOVERY_EXPIRE_MS
    }

    fun pickRecoveryParent(
        selfId: String,
        childIds: Set<String>,
        descendantIds: Set<String>,
        hasChildren: Boolean,
        staAp: CapabilityState,
        candidates: List<MeshParentCandidate>,
        lastGoodNodeId: String?,
        lastSwitchMs: Long,
        nowMs: Long,
        currentHealthyParentId: String?
    ): MeshParentCandidate? {
        if (currentHealthyParentId != null) return null
        val inCooldown = lastSwitchMs > 0L && nowMs - lastSwitchMs < SWITCH_COOLDOWN_MS
        val preferLastGood = !inCooldown
        return EmergencyMeshDecision.pickBestParent(
            selfId = selfId,
            childIds = childIds,
            descendantIds = descendantIds,
            parentId = null,
            hasChildren = hasChildren,
            staAp = staAp,
            candidates = candidates,
            lastGoodNodeId = if (preferLastGood) lastGoodNodeId else null
        )
    }
}
