package com.sos010.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * MD4 S4 — phone history bootstrap exporter (paginated) after MD3 link.
 */
@RunWith(AndroidJUnit4::class)
class SosMd4HistoryBootstrapInstrumentedTest {

    @Test
    fun exportHistoryBootstrapFromHandoff() {
        val args = InstrumentationRegistry.getArguments()
        val handoffPath =
            args.getString("handoff")
                ?: "/data/local/tmp/sos-md4-s3-hist-handoff.json"
        val resultPath =
            args.getString("result")
                ?: "/data/local/tmp/sos-md4-s3-hist-result.json"
        val file = File(handoffPath)
        assertTrue("hist handoff missing: $handoffPath", file.isFile)
        val handoff = JSONObject(file.readText())
        try {
            file.writeText("{}")
        } catch (_: Exception) {
        }

        val ctx = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
        assertTrue(
            "secure identity required",
            SosSecureIdentityStore.hasSecureIdentity(ctx),
        )
        val auth = SosDeviceAuthorization.Authorization.fromJson(handoff.getJSONObject("authorization"))
        val peersArr = handoff.optJSONArray("peers") ?: JSONArray()
        val peers = ArrayList<String>()
        for (i in 0 until peersArr.length()) peers.add(peersArr.getString(i))
        val events = handoff.optJSONArray("events") ?: JSONArray()
        val relaysArr = handoff.optJSONArray("relays") ?: JSONArray()
        val relays = ArrayList<String>()
        for (i in 0 until relaysArr.length()) relays.add(relaysArr.getString(i))
        assertTrue("relays", relays.isNotEmpty())

        val resumeCursor =
            SosHistoryPagination.Cursor.fromJson(handoff.optJSONObject("resumeCursor"))
        if (handoff.optBoolean("clearCheckpoint", false)) {
            SosHistoryCheckpointStore.clear(ctx, auth.accountP, auth.deviceId)
        }
        val localCiphers = linkedMapOf<String, String>()
        val cipherObj = handoff.optJSONObject("localAttachmentCiphers")
        if (cipherObj != null) {
            val keys = cipherObj.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                localCiphers[k] = cipherObj.optString(k, "")
            }
        }

        val result =
            SosHistorySyncPhoneSession.runBootstrap(
                context = ctx,
                req =
                    SosHistorySyncPhoneSession.BootstrapRequest(
                        auth = auth,
                        peerPubs = peers,
                        historyEvents = events,
                        relayUrls = relays,
                        timeoutMs = handoff.optLong("timeoutMs", 180_000L),
                        resumeCursor = resumeCursor,
                        interruptAfterBatches = handoff.optInt("interruptAfterBatches", -1),
                        skipWaitFinalAck = handoff.optBoolean("skipWaitFinalAck", false),
                        clearCheckpointOnComplete = handoff.optBoolean("clearCheckpointOnComplete", true),
                        localAttachmentCiphers = localCiphers,
                    ),
            )
        val out =
            JSONObject()
                .put("ok", result.ok)
                .put("code", result.code)
                .put("sessionId", result.sessionId)
                .put("exportSessionId", result.exportSessionId)
                .put("completeness", result.completeness)
                .put("eventCount", result.eventCount)
                .put("batchCount", result.batchCount)
                .put("committedBatchSeq", result.committedBatchSeq)
                .put("cursorAfter", result.cursorAfter?.toJson())
                .put("ROOT_K_SENT_TO_DESKTOP", result.ROOT_K_SENT_TO_DESKTOP)
                .put("NSEC_SENT_TO_DESKTOP", result.NSEC_SENT_TO_DESKTOP)
        File(ctx.filesDir, "sos-md4-s3-hist-result.json").writeText(out.toString())
        try {
            File(resultPath).writeText(out.toString())
        } catch (_: Exception) {
        }
        val allowInterrupt = handoff.optBoolean("expectInterrupt", false)
        if (allowInterrupt) {
            assertTrue("interrupt ${result.code}", !result.ok || result.completeness == "INTERRUPTED")
        } else {
            assertTrue("bootstrap ${result.code}", result.ok)
        }
    }
}
