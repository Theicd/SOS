package com.sos010.app

/**
 * קליטה/יציאה של DATA ו-ACK: dedup לפני מסירה וריליי. | HYPER CORE TECH
 */
object EmergencyMeshEngine {

    enum class ForwardMode { NONE, UNICAST, FLOOD }

    data class Result(
        val dropped: Boolean,
        val deliveredPayload: String? = null,
        val ack: EmergencyMeshEnvelope? = null,
        val receivedAck: EmergencyMeshEnvelope? = null,
        val forwardMode: ForwardMode = ForwardMode.NONE,
        val nextHopId: String? = null,
        val wire: String? = null,
        val messageId: String = ""
    ) {
        val delivered: Boolean get() = deliveredPayload != null
    }

    fun originate(
        selfId: String,
        selfPubkey: String,
        store: EmergencyMeshStore,
        seen: EmergencyMeshSeenCache,
        payload: String,
        targetNodeId: String = TARGET_BROADCAST,
        targetPubkey: String = "",
        messageId: String = EmergencyMeshEnvelopeCodec.newMessageId(),
        ttl: Int = EmergencyMeshEnvelopeCodec.DEFAULT_TTL,
        nowMs: Long = System.currentTimeMillis()
    ): Result {
        val env = EmergencyMeshEnvelopeCodec.data(
            originNodeId = selfId,
            targetNodeId = targetNodeId,
            payload = payload,
            targetPubkey = targetPubkey,
            messageId = messageId,
            ttl = ttl,
            createdAt = nowMs
        )
        if (!seen.markIfNew(env.messageId, nowMs)) {
            return Result(dropped = true, messageId = env.messageId)
        }
        return decide(selfId, selfPubkey, store, env, fromNodeId = selfId, isOrigin = true)
    }

    fun ingest(
        selfId: String,
        selfPubkey: String,
        store: EmergencyMeshStore,
        seen: EmergencyMeshSeenCache,
        fromNodeId: String,
        line: String,
        nowMs: Long = System.currentTimeMillis()
    ): Result {
        val env = EmergencyMeshEnvelopeCodec.parse(line) ?: return Result(dropped = true)
        if (!seen.markIfNew(env.messageId, nowMs)) {
            return Result(dropped = true, messageId = env.messageId)
        }
        if (store.childNodeIds().contains(fromNodeId) && env.originNodeId != selfId) {
            store.learnVia(fromNodeId, env.originNodeId)
        }
        return decide(selfId, selfPubkey, store, env, fromNodeId, isOrigin = false)
    }

    private fun decide(
        selfId: String,
        selfPubkey: String,
        store: EmergencyMeshStore,
        env: EmergencyMeshEnvelope,
        fromNodeId: String,
        isOrigin: Boolean
    ): Result {
        if (env.isAck()) {
            val forUs = env.targetNodeId == selfId
            val received = if (forUs) env else null
            val hop = if (!forUs) forwardWire(env, fromNodeId, store, selfId) else null
            return Result(
                dropped = false,
                receivedAck = received,
                forwardMode = hop?.first ?: ForwardMode.NONE,
                nextHopId = hop?.second,
                wire = hop?.third,
                messageId = env.messageId
            )
        }

        val local = EmergencyMeshRouter.shouldDeliverLocal(
            selfId, selfPubkey, env.targetNodeId, env.targetPubkey
        )
        val payload = if (local) env.payload.ifBlank { null } else null
        val ack = if (local && !env.isBroadcast() && !isOrigin && env.originNodeId != selfId) {
            EmergencyMeshEnvelopeCodec.ack(
                originNodeId = selfId,
                targetNodeId = env.originNodeId,
                refMessageId = env.messageId,
                status = MeshAckStatus.DELIVERED
            )
        } else {
            null
        }

        if (env.isBroadcast()) {
            val next = EmergencyMeshEnvelopeCodec.advanced(env)
            return Result(
                dropped = false,
                deliveredPayload = payload,
                ack = ack,
                forwardMode = if (next != null) ForwardMode.FLOOD else ForwardMode.NONE,
                wire = next?.let { EmergencyMeshEnvelopeCodec.encode(it) },
                messageId = env.messageId
            )
        }

        if (local) {
            return Result(dropped = false, deliveredPayload = payload, ack = ack, messageId = env.messageId)
        }

        val hop = forwardWire(env, fromNodeId, store, selfId)
        return Result(
            dropped = false,
            deliveredPayload = payload,
            ack = ack,
            forwardMode = hop?.first ?: ForwardMode.NONE,
            nextHopId = hop?.second,
            wire = hop?.third,
            messageId = env.messageId
        )
    }

    private fun forwardWire(
        env: EmergencyMeshEnvelope,
        fromNodeId: String,
        store: EmergencyMeshStore,
        selfId: String
    ): Triple<ForwardMode, String?, String>? {
        if (!EmergencyMeshRouter.shouldForwardUnicast(selfId, env.targetNodeId, fromNodeId, env.ttl)) {
            return null
        }
        val next = EmergencyMeshEnvelopeCodec.advanced(env) ?: return null
        val hop = EmergencyMeshRouter.nextHop(selfId, env.targetNodeId, store) ?: return null
        if (hop == fromNodeId) return null
        return Triple(ForwardMode.UNICAST, hop, EmergencyMeshEnvelopeCodec.encode(next))
    }
}
