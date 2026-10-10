package com.sos010.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.SecureRandom

class SosHistorySyncAckGateTest {
    private val bind =
        SosHistorySyncAckGate.SessionBind(
            accountP = "aa".repeat(32),
            deviceId = "bb".repeat(32),
            authorizationId = "cc".repeat(32),
            authEpoch = 1L,
            sessionId = "dd".repeat(32),
            exportSessionId = "ee".repeat(32),
            pairingTranscriptHash = "ff".repeat(32),
        )

    private fun ack(
        batchId: String = "11".repeat(32),
        batchSeq: Long = 0L,
        digest: String = "22".repeat(32),
        mutate: JSONObject.() -> Unit = {},
    ): JSONObject {
        val o =
            JSONObject()
                .put("type", "SYNC_ACK")
                .put("batchId", batchId)
                .put("batchSeq", batchSeq)
                .put("batchDigest", digest)
                .put("accountP", bind.accountP)
                .put("deviceId", bind.deviceId)
                .put("authorizationId", bind.authorizationId)
                .put("authEpoch", bind.authEpoch)
                .put("sessionId", bind.sessionId)
                .put("pairingTranscriptHash", bind.pairingTranscriptHash)
        o.mutate()
        return o
    }

    private fun outstanding(
        batchId: String = "11".repeat(32),
        batchSeq: Long = 0L,
        digest: String = "22".repeat(32),
    ) = mapOf(
        batchId to
            SosHistorySyncAckGate.InFlightBatch(
                batchId = batchId,
                batchSeq = batchSeq,
                batchDigest = digest,
                cursorAfter = SosHistoryPagination.Cursor(1, "33".repeat(32)),
            ),
    )

    @Test
    fun acceptsValidAck() {
        val d =
            SosHistorySyncAckGate.validateSyncAck(
                ack(),
                bind,
                outstanding(),
                emptySet(),
                -1L,
                true,
            )
        assertTrue(d.ok)
        assertEquals("OK", d.code)
    }

    @Test
    fun rejectsWrongAccount() {
        val d =
            SosHistorySyncAckGate.validateSyncAck(
                ack { put("accountP", "99".repeat(32)) },
                bind,
                outstanding(),
                emptySet(),
                -1L,
                true,
            )
        assertFalse(d.ok)
        assertEquals("ACK_BIND_MISMATCH", d.code)
    }

    @Test
    fun rejectsWrongDevice() {
        val d =
            SosHistorySyncAckGate.validateSyncAck(
                ack { put("deviceId", "99".repeat(32)) },
                bind,
                outstanding(),
                emptySet(),
                -1L,
                true,
            )
        assertFalse(d.ok)
    }

    @Test
    fun rejectsWrongAuthorization() {
        val d =
            SosHistorySyncAckGate.validateSyncAck(
                ack { put("authorizationId", "99".repeat(32)) },
                bind,
                outstanding(),
                emptySet(),
                -1L,
                true,
            )
        assertFalse(d.ok)
    }

    @Test
    fun rejectsWrongEpoch() {
        val d =
            SosHistorySyncAckGate.validateSyncAck(
                ack { put("authEpoch", 99L) },
                bind,
                outstanding(),
                emptySet(),
                -1L,
                true,
            )
        assertFalse(d.ok)
    }

    @Test
    fun rejectsWrongSession() {
        val d =
            SosHistorySyncAckGate.validateSyncAck(
                ack { put("sessionId", "99".repeat(32)) },
                bind,
                outstanding(),
                emptySet(),
                -1L,
                true,
            )
        assertFalse(d.ok)
    }

    @Test
    fun rejectsWrongTranscript() {
        val d =
            SosHistorySyncAckGate.validateSyncAck(
                ack { put("pairingTranscriptHash", "99".repeat(32)) },
                bind,
                outstanding(),
                emptySet(),
                -1L,
                true,
            )
        assertFalse(d.ok)
    }

    @Test
    fun rejectsWrongBatchId() {
        val d =
            SosHistorySyncAckGate.validateSyncAck(
                ack(batchId = "99".repeat(32)),
                bind,
                outstanding(),
                emptySet(),
                -1L,
                true,
            )
        assertFalse(d.ok)
        assertEquals("ACK_NOT_IN_FLIGHT", d.code)
    }

    @Test
    fun rejectsWrongBatchSeq() {
        val d =
            SosHistorySyncAckGate.validateSyncAck(
                ack(batchSeq = 7L),
                bind,
                outstanding(),
                emptySet(),
                -1L,
                true,
            )
        assertFalse(d.ok)
        assertEquals("ACK_BAD_BATCH_SEQ", d.code)
    }

    @Test
    fun rejectsWrongDigest() {
        val d =
            SosHistorySyncAckGate.validateSyncAck(
                ack(digest = "99".repeat(32)),
                bind,
                outstanding(),
                emptySet(),
                -1L,
                true,
            )
        assertFalse(d.ok)
        assertEquals("ACK_BAD_DIGEST", d.code)
    }

    @Test
    fun rejectsNotInFlight() {
        val d =
            SosHistorySyncAckGate.validateSyncAck(
                ack(),
                bind,
                emptyMap(),
                emptySet(),
                -1L,
                true,
            )
        assertFalse(d.ok)
        assertEquals("ACK_NOT_IN_FLIGHT", d.code)
    }

    @Test
    fun duplicateValidAckIdempotent() {
        val batchId = "11".repeat(32)
        val d =
            SosHistorySyncAckGate.validateSyncAck(
                ack(),
                bind,
                outstanding(),
                setOf(batchId),
                0L,
                true,
            )
        assertTrue(d.ok)
        assertTrue(d.idempotentDuplicate)
    }

    @Test
    fun rejectsAfterSessionCancelled() {
        val d =
            SosHistorySyncAckGate.validateSyncAck(
                ack(),
                bind,
                outstanding(),
                emptySet(),
                -1L,
                false,
            )
        assertFalse(d.ok)
        assertEquals("SESSION_NOT_ALIVE", d.code)
    }

    @Test
    fun finalAckRequiresImportComplete() {
        val inner =
            JSONObject()
                .put("type", "SYNC_FINAL_ACK")
                .put("accountP", bind.accountP)
                .put("deviceId", bind.deviceId)
                .put("authorizationId", bind.authorizationId)
                .put("authEpoch", bind.authEpoch)
                .put("sessionId", bind.sessionId)
                .put("exportSessionId", bind.exportSessionId)
                .put("batchesAcked", 0)
        val d =
            SosHistorySyncAckGate.validateFinalAck(
                inner,
                bind,
                emptyMap(),
                0,
                true,
                importComplete = false,
            )
        assertFalse(d.ok)
        assertEquals("FINAL_ACK_BEFORE_IMPORT_COMPLETE", d.code)
    }

    @Test
    fun finalAckRejectsOutstanding() {
        val inner =
            JSONObject()
                .put("type", "SYNC_FINAL_ACK")
                .put("accountP", bind.accountP)
                .put("deviceId", bind.deviceId)
                .put("authorizationId", bind.authorizationId)
                .put("authEpoch", bind.authEpoch)
                .put("sessionId", bind.sessionId)
                .put("exportSessionId", bind.exportSessionId)
                .put("batchesAcked", 1)
        val d =
            SosHistorySyncAckGate.validateFinalAck(
                inner,
                bind,
                outstanding(),
                1,
                true,
                importComplete = true,
            )
        assertFalse(d.ok)
        assertEquals("FINAL_ACK_OUTSTANDING_BATCHES", d.code)
    }

    @Test
    fun finalAckAcceptsWhenReady() {
        val inner =
            JSONObject()
                .put("type", "SYNC_FINAL_ACK")
                .put("accountP", bind.accountP)
                .put("deviceId", bind.deviceId)
                .put("authorizationId", bind.authorizationId)
                .put("authEpoch", bind.authEpoch)
                .put("sessionId", bind.sessionId)
                .put("exportSessionId", bind.exportSessionId)
                .put("batchesAcked", 2)
        val d =
            SosHistorySyncAckGate.validateFinalAck(
                inner,
                bind,
                emptyMap(),
                2,
                true,
                importComplete = true,
            )
        assertTrue(d.ok)
    }

    @Test
    fun ackAadDomainSeparatedFromBatchBind() {
        val transcript =
            SosHistorySyncCrypto.transcriptBind(
                bind.accountP,
                bind.deviceId,
                bind.authorizationId,
                bind.authEpoch,
                bind.pairingTranscriptHash,
                "55".repeat(32),
                "66".repeat(32),
                "77".repeat(32),
            )
        val aad =
            SosHistorySyncCrypto.ackAad(
                transcript,
                bind.sessionId,
                bind.accountP,
                bind.deviceId,
                bind.authorizationId,
                bind.authEpoch,
            )
        assertFalse(aad.contentEquals(transcript))
        val rnd = SecureRandom()
        val sk = ByteArray(32).also { rnd.nextBytes(it) }
        val sealed = SosHistorySyncCrypto.seal(sk, aad, """{"type":"SYNC_ACK"}""".toByteArray(), rnd)
        val openOk = SosHistorySyncCrypto.open(sk, aad, sealed)
        assertTrue(openOk != null)
        val openWrong = SosHistorySyncCrypto.open(sk, transcript, sealed)
        assertTrue(openWrong == null)
    }

    @Test
    fun batchDigestStable() {
        val a = SosHistorySyncCrypto.batchDigest("11".repeat(32), 0L, "[1,2]")
        val b = SosHistorySyncCrypto.batchDigest("11".repeat(32), 0L, "[1,2]")
        val c = SosHistorySyncCrypto.batchDigest("11".repeat(32), 1L, "[1,2]")
        assertEquals(a, b)
        assertFalse(a == c)
    }
}
