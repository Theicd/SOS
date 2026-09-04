package com.sos010.app

import org.json.JSONArray
import org.json.JSONObject

/**
 * פרוטוקול SOS_MESH v2 — JSON בשורה. V1 SOS_HERE לא מצטרף. | HYPER CORE TECH
 */
object EmergencyMeshProtocol {
    const val PROTOCOL = "SOS_MESH"
    const val VERSION = 2
    const val MAX_FRAME_CHARS = 8192
    const val MAX_NODE_ID = 80
    const val MAX_PATH = 16

    const val DISCOVERY = "DISCOVERY"
    const val JOIN_REQUEST = "JOIN_REQUEST"
    const val JOIN_ACCEPT = "JOIN_ACCEPT"
    const val JOIN_REJECT = "JOIN_REJECT"
    const val DATA = "DATA"
    const val ACK = "ACK"
    const val TOPOLOGY_UPDATE = "TOPOLOGY_UPDATE"
    const val MAX_REACHABLE = 32

    data class Frame(
        val type: String,
        val nodeId: String,
        val bootId: String = "",
        val pubkey: String = "",
        val ssid: String = "",
        val ip: String = "",
        val rootNodeId: String = "",
        val depth: Int = 0,
        val childCount: Int = 0,
        val maxChildren: Int = SosEmergencyState.MAX_CHILDREN,
        val staAp: CapabilityState = CapabilityState.UNKNOWN,
        val path: List<String> = emptyList(),
        val reachable: List<String> = emptyList(),
        val reachablePubkeys: List<String> = emptyList(),
        val reason: String = "",
        val name: String = ""
    )

    fun looksLikeJson(line: String): Boolean {
        val t = line.trim()
        return t.startsWith("{") && t.endsWith("}")
    }

    fun parse(line: String): Frame? {
        if (line.length > MAX_FRAME_CHARS) return null
        val t = line.trim()
        if (!looksLikeJson(t)) return null
        return try {
            val o = JSONObject(t)
            if (o.optString("protocol") != PROTOCOL) return null
            if (o.optInt("version") != VERSION) return null
            val type = o.optString("type").trim()
            if (type.isBlank()) return null
            val nodeId = o.optString("nodeId").trim()
            if (nodeId.length > MAX_NODE_ID) return null
            val path = parsePath(o.optJSONArray("path"))
            if (path.size > MAX_PATH) return null
            val reachable = parsePath(o.optJSONArray("reachable")).take(MAX_REACHABLE)
            val reachablePubkeys = parsePath(o.optJSONArray("reachablePubkeys")).take(MAX_REACHABLE)
            val depth = o.optInt("depth", 0)
            val childCount = o.optInt("childCount", 0)
            val maxChildren = o.optInt("maxChildren", SosEmergencyState.MAX_CHILDREN)
            if (depth !in 0..32 || childCount !in 0..16 || maxChildren !in 1..8) return null
            Frame(
                type = type,
                nodeId = nodeId,
                bootId = o.optString("bootId").trim().take(80),
                pubkey = o.optString("pubkey").trim().lowercase().take(64),
                ssid = o.optString("ssid").trim().take(32),
                ip = o.optString("ip").trim().take(45),
                rootNodeId = o.optString("rootNodeId").trim().take(MAX_NODE_ID),
                depth = depth,
                childCount = childCount,
                maxChildren = maxChildren,
                staAp = parseStaAp(o.optString("staAp")),
                path = path,
                reachable = reachable,
                reachablePubkeys = reachablePubkeys,
                reason = o.optString("reason").trim().take(40),
                name = o.optString("name").trim().take(40)
            )
        } catch (_: Exception) {
            null
        }
    }

    fun encode(type: String, fields: Map<String, Any?>): String {
        val o = JSONObject()
        o.put("protocol", PROTOCOL)
        o.put("version", VERSION)
        o.put("type", type)
        fields.forEach { (k, v) ->
            when (v) {
                null -> {}
                is Collection<*> -> o.put(k, JSONArray(v))
                else -> o.put(k, v)
            }
        }
        return o.toString()
    }

    fun discovery(
        identity: EmergencyNodeIdentity,
        ip: String,
        rootNodeId: String,
        depth: Int,
        childCount: Int,
        staAp: CapabilityState,
        name: String
    ): String {
        return encode(
            DISCOVERY,
            mapOf(
                "nodeId" to identity.nodeId,
                "bootId" to identity.bootId,
                "pubkey" to identity.pubkey,
                "ssid" to identity.stationSsid,
                "ip" to ip,
                "rootNodeId" to rootNodeId.ifBlank { identity.nodeId },
                "depth" to depth,
                "childCount" to childCount,
                "maxChildren" to SosEmergencyState.MAX_CHILDREN,
                "staAp" to staAp.name,
                "timestamp" to System.currentTimeMillis(),
                "name" to name
            )
        )
    }

    fun joinRequest(
        identity: EmergencyNodeIdentity,
        ip: String,
        rootNodeId: String,
        path: List<String>,
        staAp: CapabilityState
    ): String {
        return encode(
            JOIN_REQUEST,
            mapOf(
                "nodeId" to identity.nodeId,
                "bootId" to identity.bootId,
                "pubkey" to identity.pubkey,
                "ssid" to identity.stationSsid,
                "ip" to ip,
                "rootNodeId" to rootNodeId.ifBlank { identity.nodeId },
                "path" to path,
                "staAp" to staAp.name
            )
        )
    }

    fun joinAccept(identity: EmergencyNodeIdentity, childNodeIds: List<String>): String {
        return encode(
            JOIN_ACCEPT,
            mapOf(
                "nodeId" to identity.nodeId,
                "bootId" to identity.bootId,
                "pubkey" to identity.pubkey,
                "children" to childNodeIds
            )
        )
    }

    fun joinReject(reason: JoinRejectReason): String {
        return encode(JOIN_REJECT, mapOf("reason" to reason.name, "nodeId" to ""))
    }

    fun topologyUpdate(identity: EmergencyNodeIdentity, reachable: List<MeshReachable>): String {
        val dests = reachable.take(MAX_REACHABLE)
        return encode(
            TOPOLOGY_UPDATE,
            mapOf(
                "nodeId" to identity.nodeId,
                "bootId" to identity.bootId,
                "pubkey" to identity.pubkey,
                "reachable" to dests.map { it.nodeId },
                "reachablePubkeys" to dests.map { it.pubkey }
            )
        )
    }

    fun parseV1Here(line: String): Triple<String, Int, String>? {
        if (!line.startsWith("SOS_HERE:")) return null
        val parts = line.split(":", limit = 6)
        val ip = parts.getOrNull(1).orEmpty()
        val kids = parts.getOrNull(2)?.toIntOrNull() ?: 0
        val pubkey = parts.getOrNull(4)?.lowercase().orEmpty()
        if (ip.isBlank()) return null
        return Triple(ip, kids, pubkey)
    }

    private fun parsePath(arr: JSONArray?): List<String> {
        if (arr == null) return emptyList()
        val out = ArrayList<String>(arr.length())
        for (i in 0 until arr.length()) {
            val id = arr.optString(i).trim()
            if (id.isNotBlank() && id.length <= MAX_NODE_ID) out.add(id)
        }
        return out
    }

    private fun parseStaAp(raw: String): CapabilityState {
        return try {
            CapabilityState.valueOf(raw.trim().uppercase())
        } catch (_: Exception) {
            CapabilityState.UNKNOWN
        }
    }
}
