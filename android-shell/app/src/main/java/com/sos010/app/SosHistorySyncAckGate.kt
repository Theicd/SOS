package com.sos010.app

import org.json.JSONObject

/**
 * MD4 S4 security hardening — validate AEAD-opened SYNC_ACK / SYNC_FINAL_ACK
 * before any durable checkpoint advance or session completion.
 */
object SosHistorySyncAckGate {
    data class InFlightBatch(
        val batchId: String,
        val batchSeq: Long,
        val batchDigest: String,
        val cursorAfter: SosHistoryPagination.Cursor?,
    )

    data class SessionBind(
        val accountP: String,
        val deviceId: String,
        val authorizationId: String,
        val authEpoch: Long,
        val sessionId: String,
        val exportSessionId: String,
        val pairingTranscriptHash: String,
    )

    data class Decision(
        val ok: Boolean,
        val code: String,
        /** True when a previously accepted ACK is replayed with identical binding — no state change. */
        val idempotentDuplicate: Boolean = false,
    )

    fun validateSyncAck(
        inner: JSONObject,
        bind: SessionBind,
        outstanding: Map<String, InFlightBatch>,
        alreadyAcked: Set<String>,
        committedSeq: Long,
        sessionAlive: Boolean,
    ): Decision {
        if (!sessionAlive) return Decision(false, "SESSION_NOT_ALIVE")
        if (inner.optString("type") != "SYNC_ACK") return Decision(false, "WRONG_TYPE")

        val batchId = SosDeviceKeyCrypto.normalizeHex(inner.optString("batchId"))
        if (batchId.isEmpty()) return Decision(false, "MISSING_BATCH_ID")

        if (!bindingsMatch(inner, bind)) return Decision(false, "ACK_BIND_MISMATCH")

        if (alreadyAcked.contains(batchId)) {
            val expected = outstanding[batchId]
            val seq = inner.optLong("batchSeq", Long.MIN_VALUE)
            val digest = SosDeviceKeyCrypto.normalizeHex(inner.optString("batchDigest"))
            if (expected != null && seq == expected.batchSeq && digest == expected.batchDigest) {
                return Decision(true, "DUP_ACK", idempotentDuplicate = true)
            }
            // Already completed this batchId — identical replay without outstanding is also idempotent.
            if (expected == null && digest.isNotEmpty()) {
                return Decision(true, "DUP_ACK", idempotentDuplicate = true)
            }
            return Decision(false, "CONFLICTING_DUP_ACK")
        }

        val inflight = outstanding[batchId] ?: return Decision(false, "ACK_NOT_IN_FLIGHT")
        val seq = inner.optLong("batchSeq", Long.MIN_VALUE)
        if (seq != inflight.batchSeq) return Decision(false, "ACK_BAD_BATCH_SEQ")
        if (seq != committedSeq + 1L && !(committedSeq < 0L && seq == 0L)) {
            // Allow exact next seq only (seq 0 when nothing committed).
            if (seq != committedSeq + 1L) return Decision(false, "ACK_UNEXPECTED_SEQ")
        }
        val digest = SosDeviceKeyCrypto.normalizeHex(inner.optString("batchDigest"))
        if (digest.isEmpty() || digest != inflight.batchDigest) return Decision(false, "ACK_BAD_DIGEST")

        return Decision(true, "OK")
    }

    fun validateFinalAck(
        inner: JSONObject,
        bind: SessionBind,
        outstanding: Map<String, InFlightBatch>,
        expectedBatchesAcked: Int,
        sessionAlive: Boolean,
        importComplete: Boolean,
    ): Decision {
        if (!sessionAlive) return Decision(false, "SESSION_NOT_ALIVE")
        if (inner.optString("type") != "SYNC_FINAL_ACK") return Decision(false, "WRONG_TYPE")
        if (!importComplete) return Decision(false, "FINAL_ACK_BEFORE_IMPORT_COMPLETE")
        if (outstanding.isNotEmpty()) return Decision(false, "FINAL_ACK_OUTSTANDING_BATCHES")
        if (!bindingsMatch(inner, bind)) return Decision(false, "ACK_BIND_MISMATCH")
        val export = SosDeviceKeyCrypto.normalizeHex(inner.optString("exportSessionId"))
        if (export.isEmpty() || export != SosDeviceKeyCrypto.normalizeHex(bind.exportSessionId)) {
            return Decision(false, "FINAL_ACK_BAD_EXPORT")
        }
        val acked = inner.optInt("batchesAcked", -1)
        if (acked >= 0 && expectedBatchesAcked >= 0 && acked != expectedBatchesAcked) {
            return Decision(false, "FINAL_ACK_BAD_BATCH_COUNT")
        }
        return Decision(true, "OK")
    }

    private fun bindingsMatch(inner: JSONObject, bind: SessionBind): Boolean {
        fun field(name: String): String = SosDeviceKeyCrypto.normalizeHex(inner.optString(name))
        if (field("accountP") != SosDeviceKeyCrypto.normalizeHex(bind.accountP)) return false
        if (field("deviceId") != SosDeviceKeyCrypto.normalizeHex(bind.deviceId)) return false
        if (field("authorizationId") != SosDeviceKeyCrypto.normalizeHex(bind.authorizationId)) return false
        if (inner.optLong("authEpoch", Long.MIN_VALUE) != bind.authEpoch) return false
        if (field("sessionId") != SosDeviceKeyCrypto.normalizeHex(bind.sessionId)) return false
        // Transcript hash may be echoed; if present must match.
        val th = field("pairingTranscriptHash")
        if (th.isNotEmpty() && th != SosDeviceKeyCrypto.normalizeHex(bind.pairingTranscriptHash)) return false
        return true
    }
}
