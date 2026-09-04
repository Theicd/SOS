package com.sos010.app

import org.json.JSONObject
import java.util.UUID

/**
 * מעטפת DATA/ACK — messageId, יעד, TTL, hop. | HYPER CORE TECH
 */
data class EmergencyMeshEnvelope(
    val type: String,
    val messageId: String,
    val originNodeId: String,
    val targetNodeId: String,
    val targetPubkey: String = "",
    val ttl: Int,
    val hopCount: Int,
    val createdAt: Long,
    val payloadType: String = "",
    val payload: String = "",
    val refMessageId: String = "",
    val status: String = ""
) {
    fun isBroadcast(): Boolean = targetNodeId == TARGET_BROADCAST
    fun isAck(): Boolean = type == EmergencyMeshProtocol.ACK
}

object EmergencyMeshEnvelopeCodec {
    const val TARGET_BROADCAST = "*"
    const val DEFAULT_TTL = 12
    const val MAX_TTL = 32
    const val MAX_HOPS = 32
    const val MAX_MESSAGE_ID = 80
    const val MAX_PAYLOAD_CHARS = 6000

    fun newMessageId(): String = UUID.randomUUID().toString()

    fun legacyMessageId(payload: String): String {
        return "lg:${payload.hashCode().toUInt()}:${payload.length}"
    }

    fun parse(line: String): EmergencyMeshEnvelope? {
        if (line.length > EmergencyMeshProtocol.MAX_FRAME_CHARS) return null
        val t = line.trim()
        if (!EmergencyMeshProtocol.looksLikeJson(t)) return null
        return try {
            val o = JSONObject(t)
            if (o.optString("protocol") != EmergencyMeshProtocol.PROTOCOL) return null
            if (o.optInt("version") != EmergencyMeshProtocol.VERSION) return null
            val type = o.optString("type").trim()
            if (type != EmergencyMeshProtocol.DATA && type != EmergencyMeshProtocol.ACK) return null
            val messageId = o.optString("messageId").trim()
            if (messageId.isBlank() || messageId.length > MAX_MESSAGE_ID) return null
            val origin = o.optString("originNodeId").trim()
            val target = o.optString("targetNodeId").trim()
            if (origin.length > EmergencyMeshProtocol.MAX_NODE_ID) return null
            if (target.length > EmergencyMeshProtocol.MAX_NODE_ID) return null
            if (origin.isBlank() || target.isBlank()) return null
            val ttl = o.optInt("ttl", -1)
            val hop = o.optInt("hopCount", -1)
            if (ttl !in 0..MAX_TTL || hop !in 0..MAX_HOPS) return null
            val payloadRaw = readPayload(o)
            if (payloadRaw.length > MAX_PAYLOAD_CHARS) return null
            EmergencyMeshEnvelope(
                type = type,
                messageId = messageId,
                originNodeId = origin,
                targetNodeId = target,
                targetPubkey = o.optString("targetPubkey").trim().lowercase().take(64),
                ttl = ttl,
                hopCount = hop,
                createdAt = o.optLong("createdAt", 0L),
                payloadType = o.optString("payloadType").trim().take(40),
                payload = payloadRaw,
                refMessageId = o.optString("refMessageId").trim().take(MAX_MESSAGE_ID),
                status = o.optString("status").trim().take(20)
            )
        } catch (_: Exception) {
            null
        }
    }

    fun encode(env: EmergencyMeshEnvelope): String {
        val fields = linkedMapOf<String, Any?>(
            "messageId" to env.messageId,
            "originNodeId" to env.originNodeId,
            "targetNodeId" to env.targetNodeId,
            "targetPubkey" to env.targetPubkey,
            "ttl" to env.ttl,
            "hopCount" to env.hopCount,
            "createdAt" to env.createdAt,
            "payloadType" to env.payloadType,
            "refMessageId" to env.refMessageId,
            "status" to env.status
        )
        val o = JSONObject()
        o.put("protocol", EmergencyMeshProtocol.PROTOCOL)
        o.put("version", EmergencyMeshProtocol.VERSION)
        o.put("type", env.type)
        fields.forEach { (k, v) ->
            if (v != null && v != "") o.put(k, v)
        }
        if (env.payload.isNotBlank()) {
            try {
                o.put("payload", JSONObject(env.payload))
            } catch (_: Exception) {
                o.put("payload", env.payload)
            }
        }
        return o.toString()
    }

    fun data(
        originNodeId: String,
        targetNodeId: String,
        payload: String,
        payloadType: String = guessPayloadType(payload),
        targetPubkey: String = "",
        messageId: String = newMessageId(),
        ttl: Int = DEFAULT_TTL,
        hopCount: Int = 0,
        createdAt: Long = System.currentTimeMillis()
    ): EmergencyMeshEnvelope {
        return EmergencyMeshEnvelope(
            type = EmergencyMeshProtocol.DATA,
            messageId = messageId,
            originNodeId = originNodeId,
            targetNodeId = targetNodeId.ifBlank { TARGET_BROADCAST },
            targetPubkey = targetPubkey,
            ttl = ttl.coerceIn(0, MAX_TTL),
            hopCount = hopCount.coerceIn(0, MAX_HOPS),
            createdAt = createdAt,
            payloadType = payloadType,
            payload = payload
        )
    }

    fun ack(
        originNodeId: String,
        targetNodeId: String,
        refMessageId: String,
        status: MeshAckStatus,
        ttl: Int = DEFAULT_TTL
    ): EmergencyMeshEnvelope {
        return EmergencyMeshEnvelope(
            type = EmergencyMeshProtocol.ACK,
            messageId = newMessageId(),
            originNodeId = originNodeId,
            targetNodeId = targetNodeId,
            ttl = ttl.coerceIn(0, MAX_TTL),
            hopCount = 0,
            createdAt = System.currentTimeMillis(),
            payloadType = "ack",
            refMessageId = refMessageId,
            status = status.name
        )
    }

    fun advanced(env: EmergencyMeshEnvelope): EmergencyMeshEnvelope? {
        if (env.ttl <= 0) return null
        val nextHop = env.hopCount + 1
        if (nextHop > MAX_HOPS) return null
        return env.copy(ttl = env.ttl - 1, hopCount = nextHop)
    }

    fun guessPayloadType(payload: String): String {
        return try {
            val t = JSONObject(payload).optString("type").trim()
            if (t.isNotBlank()) t else "chat"
        } catch (_: Exception) {
            "chat"
        }
    }

    private fun readPayload(o: JSONObject): String {
        if (!o.has("payload") || o.isNull("payload")) return ""
        val inner = o.optJSONObject("payload")
        if (inner != null) return inner.toString()
        return o.optString("payload", "")
    }
}

const val TARGET_BROADCAST = EmergencyMeshEnvelopeCodec.TARGET_BROADCAST
