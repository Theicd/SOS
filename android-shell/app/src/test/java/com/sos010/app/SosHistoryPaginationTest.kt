package com.sos010.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SosHistoryPaginationTest {
    private fun ev(id: String, createdAt: Long, content: String = "x"): JSONObject =
        JSONObject()
            .put("id", id)
            .put("created_at", createdAt)
            .put("kind", 1050)
            .put("pubkey", "aa".repeat(32))
            .put("content", content)
            .put("tags", JSONArray())

    @Test
    fun sameTimestampOrderedByEventId() {
        val a = "11".repeat(32)
        val b = "22".repeat(32)
        val arr = JSONArray().put(ev(b, 100)).put(ev(a, 100))
        val (sorted, _) = SosHistoryPagination.sortAndDedupe(arr)
        assertEquals(a, SosHistoryPagination.eventId(sorted[0]))
        assertEquals(b, SosHistoryPagination.eventId(sorted[1]))
    }

    @Test
    fun paginationRespectsMaxEventsAndResumeCursor() {
        val arr = JSONArray()
        for (i in 0 until 120) {
            val id = "%064x".format(i.toLong())
            arr.put(ev(id, (i / 3).toLong()))
        }
        val pages = SosHistoryPagination.buildPages(arr, null, maxEvents = 50)
        assertTrue(pages.size >= 3)
        assertEquals(50, pages[0].events.length())
        assertTrue(pages[0].hasMore)
        assertFalse(pages.last().hasMore)
        val resume = pages[0].cursorAfter!!
        val resumed = SosHistoryPagination.buildPages(arr, resume, maxEvents = 50)
        assertTrue(resumed[0].events.length() <= 50)
        val firstId = SosHistoryPagination.eventId(resumed[0].events.getJSONObject(0))
        assertTrue(SosHistoryPagination.compare(resume.createdAt, resume.eventId, SosHistoryPagination.createdAt(resumed[0].events.getJSONObject(0)), firstId) < 0)
    }

    @Test
    fun mergePrefersLeftOnDuplicateId() {
        val id = "33".repeat(32)
        val left = listOf(ev(id, 1, "left"))
        val right = listOf(ev(id, 1, "right"), ev("44".repeat(32), 2))
        val merged = SosHistoryPagination.mergeSorted(left, right)
        assertEquals(2, merged.size)
        assertEquals("left", merged[0].getString("content"))
    }

    @Test
    fun checkpointBindRejectsWrongAccount() {
        val ck =
            SosHistoryCheckpointStore.Checkpoint(
                accountP = "11".repeat(32),
                deviceId = "22".repeat(32),
                authorizationId = "33".repeat(32),
                authEpoch = 1L,
                collectionId = "hist-bootstrap-v1",
                cursor = SosHistoryPagination.Cursor(1, "44".repeat(32)),
                exportSessionId = "55".repeat(32),
                committedBatchSeq = 0L,
                updatedAtMs = 1L,
            )
        val auth =
            SosDeviceAuthorization.Authorization(
                version = SosDeviceAuthorization.VERSION,
                authorizationId = "33".repeat(32),
                accountP = "66".repeat(32),
                deviceId = "22".repeat(32),
                dSignPub = "77".repeat(32),
                dEncPub = "88".repeat(32),
                capabilities = setOf(SosDeviceAuthorization.Capability.DEVICE_HISTORY_SYNC),
                authEpoch = 1L,
                createdAt = 1L,
                expiresAt = Long.MAX_VALUE / 4,
                pairingTranscriptHash = "99".repeat(32),
                pairingId = "aa".repeat(32),
                storageSecurityClass = "SOFT",
                recoveryEligibleAtAuthorization = false,
            )
        assertEquals("CHECKPOINT_ACCOUNT_MISMATCH", SosHistoryCheckpointStore.bindMatches(auth, ck))
    }
}
