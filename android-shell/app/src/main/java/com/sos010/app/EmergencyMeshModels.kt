package com.sos010.app

/**
 * מודל Mesh V2 — זהות, טופולוגיה, קישורים. בלי Android. | HYPER CORE TECH
 */

enum class MeshNodeState {
    IDLE,
    DISCOVERING,
    SELECTING_PARENT,
    JOINING,
    CONNECTED,
    ROOT,
    DEGRADED,
    RECONNECTING,
    STOPPED
}

enum class MeshPeerRelation {
    DISCOVERED,
    CANDIDATE,
    DIRECT_PARENT,
    DIRECT_CHILD,
    TRANSITIVE,
    UNREACHABLE
}

enum class MeshLinkState {
    CONNECTING,
    HANDSHAKING,
    ACTIVE,
    DEGRADED,
    CLOSING,
    CLOSED
}

enum class CapabilityState {
    SUPPORTED,
    UNSUPPORTED,
    UNKNOWN
}

enum class MeshAckStatus {
    QUEUED,
    SENT,
    DELIVERED,
    FAILED
}

enum class JoinRejectReason {
    SELF,
    CYCLE,
    ALREADY_PARENT,
    ALREADY_CHILD,
    BUSY,
    CAPACITY,
    ROLE_CONFLICT,
    UNSUPPORTED_VERSION,
    UNSUPPORTED_CONCURRENCY,
    STALE_SESSION
}

data class EmergencyNodeIdentity(
    val nodeId: String,
    val pubkey: String,
    val bootId: String,
    val stationSsid: String
)

data class WifiMeshCapabilities(
    val staApConcurrency: CapabilityState,
    val hotspotActive: Boolean,
    val wifiActive: Boolean
)

data class MeshPeerRecord(
    val nodeId: String,
    val pubkey: String = "",
    val bootId: String = "",
    val ssid: String = "",
    val currentIp: String = "",
    val relation: MeshPeerRelation = MeshPeerRelation.DISCOVERED,
    val linkState: MeshLinkState = MeshLinkState.CLOSED,
    val lastSeenMs: Long = 0L,
    val lastHeartbeatMs: Long = 0L,
    val rootNodeId: String = "",
    val depth: Int = 0,
    val childCount: Int = 0,
    val maxChildren: Int = SosEmergencyState.MAX_CHILDREN,
    val staAp: CapabilityState = CapabilityState.UNKNOWN,
    val signalDbm: Int = -100,
    val name: String = "",
    val picture: String = ""
)

data class MeshReachable(
    val nodeId: String,
    val pubkey: String = ""
)

data class MeshParentCandidate(
    val nodeId: String,
    val relation: MeshPeerRelation,
    val childCount: Int,
    val maxChildren: Int,
    val depth: Int,
    val signalDbm: Int,
    val staAp: CapabilityState,
    val inExistingTree: Boolean
)
