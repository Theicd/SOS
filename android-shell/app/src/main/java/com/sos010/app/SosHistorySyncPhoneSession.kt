package com.sos010.app

import android.content.Context
import fr.acinq.secp256k1.Hex
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * MD4 S4 — phone-side paginated history bootstrap over sos-hist-v1.
 * DEVICE_HISTORY_SYNC required. No root K/nsec or plaintext CKI on the wire.
 */
object SosHistorySyncPhoneSession {
    const val MAX_IN_FLIGHT_BATCHES = 2
    const val COLLECTION_ID = "hist-bootstrap-v1"

    data class BootstrapRequest(
        val auth: SosDeviceAuthorization.Authorization,
        val peerPubs: List<String>,
        val historyEvents: JSONArray,
        val relayUrls: List<String>,
        val timeoutMs: Long = 120_000L,
        val spentExportSessions: MutableSet<String> = linkedSetOf(),
        val spentSessionNonces: MutableSet<String> = linkedSetOf(),
        /** Optional resume cursor from prior interrupted session. */
        val resumeCursor: SosHistoryPagination.Cursor? = null,
        val clearCheckpointOnComplete: Boolean = true,
        /** Test hook: stop after N batches (simulate disconnect). */
        val interruptAfterBatches: Int = -1,
        /** Test hook: do not wait for final ACK. */
        val skipWaitFinalAck: Boolean = false,
        /**
         * Optional local-only ciphertext map: attachmentId(hex32) -> Base64 ciphertext.
         * Used when Blossom/P2P is unavailable; transferred over hist-session AEAD only.
         */
        val localAttachmentCiphers: Map<String, String> = emptyMap(),
    )

    data class Result(
        val ok: Boolean,
        val code: String,
        val sessionId: String = "",
        val exportSessionId: String = "",
        val completeness: String = "",
        val eventCount: Int = 0,
        val batchCount: Int = 0,
        val committedBatchSeq: Long = -1L,
        val cursorAfter: SosHistoryPagination.Cursor? = null,
        val ROOT_K_SENT_TO_DESKTOP: Boolean = false,
        val NSEC_SENT_TO_DESKTOP: Boolean = false,
    )

    fun runBootstrap(
        context: Context,
        req: BootstrapRequest,
        phoneIdentity: SosSecureIdentityStore.Engine = SosSecureIdentityStore.productionEngine(context),
        random: SecureRandom = SecureRandom(),
    ): Result {
        when (val v = SosDeviceAuthorization.verifyStrict(req.auth)) {
            is SosDeviceAuthorization.VerifyResult.Err -> return Result(false, v.code)
            SosDeviceAuthorization.VerifyResult.Ok -> Unit
        }
        if (SosDeviceAuthorization.Capability.DEVICE_HISTORY_SYNC !in req.auth.capabilities) {
            return Result(false, "MISSING_DEVICE_HISTORY_SYNC")
        }

        var resumeCursor = req.resumeCursor
        val existingCk =
            SosHistoryCheckpointStore.load(context, req.auth.accountP, req.auth.deviceId, COLLECTION_ID)
        if (existingCk != null) {
            val bindErr = SosHistoryCheckpointStore.bindMatches(req.auth, existingCk)
            if (bindErr != null) return Result(false, bindErr)
            if (resumeCursor == null) resumeCursor = existingCk.cursor
        }

        val pages = SosHistoryPagination.buildPages(req.historyEvents, resumeCursor)
        for (p in pages) {
            if (p.events.length() > SosHistorySyncCrypto.MAX_BATCH_EVENTS) {
                return Result(false, "OVERSIZED_BATCH")
            }
            val bytes = p.events.toString().toByteArray(StandardCharsets.UTF_8)
            if (bytes.size > SosHistorySyncCrypto.MAX_BATCH_BYTES) {
                return Result(false, "OVERSIZED_BATCH")
            }
        }

        val transport = SosHistoryNostrTransport(req.relayUrls)
        val done = CountDownLatch(1)
        val out = AtomicReference(Result(false, "TIMEOUT", completeness = "INTERRUPTED"))
        val (ephPriv, ephPub) = SosX25519.generateKeyPair(random)
        var sessionKey: ByteArray? = null
        var bind: ByteArray? = null
        var sessionId = ""
        val sessionStarted = AtomicBoolean(false)
        val sessionCancelled = AtomicBoolean(false)
        val acked = ConcurrentHashMap<String, Boolean>()
        val outstanding = ConcurrentHashMap<String, SosHistorySyncAckGate.InFlightBatch>()
        val inFlight = AtomicInteger(0)
        val committedSeq = AtomicReference(-1L)
        var lastCursor: SosHistoryPagination.Cursor? = resumeCursor
        var exportSessionId = ""
        val importComplete = AtomicBoolean(false)
        val finalAckAccepted = AtomicBoolean(false)
        val pagesSent = AtomicInteger(0)

        try {
            transport.start(role = "phone", sessionIdHex = null) { sid, content ->
                try {
                    val msg = JSONObject(content)
                    val type = msg.optString("type")

                    // Authenticated control plane: AEAD SYNC_ACK / SYNC_FINAL_ACK only.
                    // Plaintext SYNC_ACK / forged control is ignored (fail-closed).
                    if (sessionStarted.get()) {
                        if (type == "AEAD" && sessionKey != null && bind != null && sessionId.isNotEmpty()) {
                            val ackAad =
                                SosHistorySyncCrypto.ackAad(
                                    bind!!,
                                    sessionId,
                                    req.auth.accountP,
                                    req.auth.deviceId,
                                    req.auth.authorizationId,
                                    req.auth.authEpoch,
                                )
                            val opened =
                                SosHistorySyncCrypto.open(
                                    sessionKey!!,
                                    ackAad,
                                    SosHistorySyncCrypto.SealedMessage(
                                        ivB64 = msg.optString("iv"),
                                        ctB64 = msg.optString("ct"),
                                    ),
                                )
                            if (opened != null) {
                                val inner = JSONObject(String(opened, StandardCharsets.UTF_8))
                                val bindSnap =
                                    SosHistorySyncAckGate.SessionBind(
                                        accountP = req.auth.accountP,
                                        deviceId = req.auth.deviceId,
                                        authorizationId = req.auth.authorizationId,
                                        authEpoch = req.auth.authEpoch,
                                        sessionId = sessionId,
                                        exportSessionId = exportSessionId,
                                        pairingTranscriptHash = req.auth.pairingTranscriptHash,
                                    )
                                val alive = !sessionCancelled.get() && done.count > 0L
                                when (inner.optString("type")) {
                                    "SYNC_ACK" -> {
                                        val decision =
                                            SosHistorySyncAckGate.validateSyncAck(
                                                inner = inner,
                                                bind = bindSnap,
                                                outstanding = outstanding.toMap(),
                                                alreadyAcked = acked.keys.toSet(),
                                                committedSeq = committedSeq.get(),
                                                sessionAlive = alive,
                                            )
                                        if (decision.ok) {
                                            val batchId =
                                                SosDeviceKeyCrypto.normalizeHex(inner.optString("batchId"))
                                            if (!decision.idempotentDuplicate) {
                                                val inflight = outstanding.remove(batchId)
                                                acked[batchId] = true
                                                inFlight.updateAndGet { maxOf(0, it - 1) }
                                                val seq = inner.optLong("batchSeq", -1L)
                                                val cursor =
                                                    SosHistoryPagination.Cursor.fromJson(
                                                        inner.optJSONObject("cursorCommitted"),
                                                    ) ?: inflight?.cursorAfter
                                                if (seq >= 0 && cursor != null) {
                                                    committedSeq.set(seq)
                                                    lastCursor = cursor
                                                    SosHistoryCheckpointStore.saveAtomic(
                                                        context,
                                                        SosHistoryCheckpointStore.Checkpoint(
                                                            accountP = req.auth.accountP,
                                                            deviceId = req.auth.deviceId,
                                                            authorizationId = req.auth.authorizationId,
                                                            authEpoch = req.auth.authEpoch,
                                                            collectionId = COLLECTION_ID,
                                                            cursor = cursor,
                                                            exportSessionId = exportSessionId,
                                                            committedBatchSeq = seq,
                                                            updatedAtMs = System.currentTimeMillis(),
                                                        ),
                                                    )
                                                }
                                            }
                                        }
                                    }
                                    "SYNC_FINAL_ACK" -> {
                                        val decision =
                                            SosHistorySyncAckGate.validateFinalAck(
                                                inner = inner,
                                                bind = bindSnap,
                                                outstanding = outstanding.toMap(),
                                                expectedBatchesAcked = pagesSent.get(),
                                                sessionAlive = alive,
                                                importComplete = importComplete.get(),
                                            )
                                        if (decision.ok && finalAckAccepted.compareAndSet(false, true)) {
                                            done.countDown()
                                        }
                                    }
                                }
                            }
                        }
                        // Duplicate HELLO / plaintext ACK / unauthorized control: ignore.
                        return@start
                    }

                    val gate = SosHistorySyncHelloGate.validate(msg, req.auth, req.spentSessionNonces)
                    if (!gate.ok) {
                        if (gate.code == "IGNORE_PING" || gate.code == "NOT_HELLO") return@start
                        out.set(Result(false, gate.code, completeness = "FAILED"))
                        done.countDown()
                        return@start
                    }
                    if (!sessionStarted.compareAndSet(false, true)) return@start

                    val sessionNonce = SosDeviceKeyCrypto.normalizeHex(msg.getString("sessionNonce"))
                    val ephDesktop = SosDeviceKeyCrypto.normalizeHex(msg.getString("ephDesktopPub"))
                    sessionId = SosDeviceKeyCrypto.normalizeHex(sid)
                    bind =
                        SosHistorySyncCrypto.transcriptBind(
                            req.auth.accountP,
                            req.auth.deviceId,
                            req.auth.authorizationId,
                            req.auth.authEpoch,
                            req.auth.pairingTranscriptHash,
                            sessionNonce,
                            req.auth.dSignPub,
                            req.auth.dEncPub,
                        )
                    val shared = SosX25519.sharedSecret(ephPriv, Hex.decode(ephDesktop))
                    sessionKey = SosHistorySyncCrypto.sessionKey(shared, bind!!)
                    SosDeviceKeyCrypto.zeroize(shared)

                    val export =
                        when (
                            val r =
                                SosHistorySyncExporter.exportSealedIndex(
                                    phoneIdentity = phoneIdentity,
                                    auth = req.auth,
                                    peerPubs = req.peerPubs,
                                    spentExportSessions = req.spentExportSessions,
                                    random = random,
                                )
                        ) {
                            is SosHistorySyncExporter.Result.Err -> {
                                out.set(Result(false, r.code, completeness = "FAILED"))
                                done.countDown()
                                return@start
                            }
                            is SosHistorySyncExporter.Result.Ok -> r.value
                        }
                    req.spentExportSessions.add(export.exportSessionId)
                    exportSessionId = export.exportSessionId

                    val sk = sessionKey!!
                    val aad = bind!!
                    fun publishSealed(obj: JSONObject) {
                        val sealed =
                            SosHistorySyncCrypto.seal(
                                sk,
                                aad,
                                obj.toString().toByteArray(StandardCharsets.UTF_8),
                                random,
                            )
                        transport.publish(
                            sessionId,
                            JSONObject()
                                .put("type", "AEAD")
                                .put("iv", sealed.ivB64)
                                .put("ct", sealed.ctB64)
                                .toString(),
                        )
                    }

                    // Single AUTH_OK for this session (HELLO retries ignored via sessionStarted).
                    transport.publish(
                        sessionId,
                        JSONObject()
                            .put("type", "SYNC_AUTH_OK")
                            .put("ephPhonePub", Hex.encode(ephPub))
                            .put("accountP", req.auth.accountP)
                            .put("deviceId", req.auth.deviceId)
                            .put("authorizationId", req.auth.authorizationId)
                            .put("sessionId", sessionId)
                            .toString(),
                    )
                    publishSealed(
                        JSONObject()
                            .put("type", "KEY_INDEX_SEALED")
                            .put("pages", export.toPublicJson().getJSONArray("pages")),
                    )

                    val declared = req.historyEvents.length()
                    val remaining =
                        SosHistoryPagination.afterCursor(
                            SosHistoryPagination.sortAndDedupe(req.historyEvents).first,
                            resumeCursor,
                        ).size
                    publishSealed(
                        JSONObject()
                            .put("type", "HIST_MANIFEST")
                            .put(
                                "coverage",
                                JSONObject()
                                    .put("localDb", true)
                                    .put("relayWindow", JSONObject.NULL)
                                    .put("gaps", JSONArray())
                                    .put("declaredEventCount", declared)
                                    .put("remainingEventCount", remaining)
                                    .put("pageCount", pages.size)
                                    .put("resume", resumeCursor != null),
                            )
                            .put("completeness", if (declared == 0) "COMPLETE" else "PARTIAL"),
                    )

                    Thread {
                        try {
                            var seq = 0L
                            var sentEvents = 0
                            pagesSent.set(pages.size)
                            for (page in pages) {
                                while (inFlight.get() >= MAX_IN_FLIGHT_BATCHES) {
                                    Thread.sleep(40)
                                    if (done.count == 0L) return@Thread
                                }
                                val batchId = SosHistorySyncCrypto.newNonce(random)
                                val eventsJson = page.events.toString()
                                val digest =
                                    SosHistorySyncCrypto.batchDigest(batchId, seq, eventsJson)
                                outstanding[batchId] =
                                    SosHistorySyncAckGate.InFlightBatch(
                                        batchId = batchId,
                                        batchSeq = seq,
                                        batchDigest = digest,
                                        cursorAfter = page.cursorAfter,
                                    )
                                inFlight.incrementAndGet()
                                publishSealed(
                                    JSONObject()
                                        .put("type", "HIST_BATCH")
                                        .put("batchId", batchId)
                                        .put("batchSeq", seq)
                                        .put("events", page.events)
                                        .put("cursorAfter", page.cursorAfter?.toJson())
                                        .put("hasMore", page.hasMore)
                                        .put("eventCount", page.events.length())
                                        .put("batchDigest", digest),
                                )
                                sentEvents += page.events.length()
                                // Wait for authenticated ACK: poll until acked or timeout slice.
                                val ackDeadline = System.currentTimeMillis() + 45_000L
                                while (acked[batchId] != true && System.currentTimeMillis() < ackDeadline) {
                                    Thread.sleep(30)
                                    if (done.count == 0L) return@Thread
                                }
                                if (acked[batchId] != true) {
                                    sessionCancelled.set(true)
                                    // Uncertain ACK: leave checkpoint at last committed; report INTERRUPTED.
                                    out.set(
                                        Result(
                                            ok = false,
                                            code = "ACK_TIMEOUT",
                                            sessionId = sessionId,
                                            exportSessionId = exportSessionId,
                                            completeness = "INTERRUPTED",
                                            eventCount = sentEvents,
                                            batchCount = (seq + 1).toInt(),
                                            committedBatchSeq = committedSeq.get(),
                                            cursorAfter = lastCursor,
                                        ),
                                    )
                                    done.countDown()
                                    return@Thread
                                }
                                seq += 1
                                if (req.interruptAfterBatches > 0 && seq >= req.interruptAfterBatches) {
                                    sessionCancelled.set(true)
                                    out.set(
                                        Result(
                                            ok = false,
                                            code = "INTERRUPTED_TEST",
                                            sessionId = sessionId,
                                            exportSessionId = exportSessionId,
                                            completeness = "INTERRUPTED",
                                            eventCount = sentEvents,
                                            batchCount = seq.toInt(),
                                            committedBatchSeq = committedSeq.get(),
                                            cursorAfter = lastCursor,
                                        ),
                                    )
                                    done.countDown()
                                    return@Thread
                                }
                            }

                            // Local-only ciphertext transfer over hist-session AEAD (no plaintext).
                            if (req.localAttachmentCiphers.isNotEmpty()) {
                                for ((attIdRaw, ctB64) in req.localAttachmentCiphers) {
                                    val attId = SosDeviceKeyCrypto.normalizeHex(attIdRaw)
                                    if (attId.isEmpty() || ctB64.isBlank()) continue
                                    publishSealed(
                                        JSONObject()
                                            .put("type", "ATTACH_CIPHER")
                                            .put("attachmentId", attId)
                                            .put("ctB64", ctB64)
                                            .put("accountP", req.auth.accountP)
                                            .put("deviceId", req.auth.deviceId)
                                            .put("authorizationId", req.auth.authorizationId)
                                            .put("authEpoch", req.auth.authEpoch)
                                            .put("sessionId", sessionId),
                                    )
                                    // Brief window for desktop ATTACH_ACK (best-effort; history FINAL_ACK is authoritative).
                                    Thread.sleep(80)
                                }
                            }

                            val completeness =
                                when {
                                    declared == 0 -> "COMPLETE"
                                    remaining == 0 && pages.size == 1 && pages[0].events.length() == 0 -> "COMPLETE"
                                    else -> "COMPLETE"
                                }
                            importComplete.set(true)
                            publishSealed(
                                JSONObject()
                                    .put("type", "SYNC_DONE")
                                    .put("completeness", completeness)
                                    .put("exportSessionId", exportSessionId)
                                    .put("eventCount", sentEvents)
                                    .put("batchCount", pages.size)
                                    .put("cursorAfter", lastCursor?.toJson()),
                            )
                            // Checkpoint clear only after authenticated FINAL_ACK (below via latch).
                            out.set(
                                Result(
                                    ok = true,
                                    code = "OK",
                                    sessionId = sessionId,
                                    exportSessionId = exportSessionId,
                                    completeness = completeness,
                                    eventCount = sentEvents,
                                    batchCount = pages.size,
                                    committedBatchSeq = committedSeq.get(),
                                    cursorAfter = lastCursor,
                                ),
                            )
                            if (req.skipWaitFinalAck) {
                                done.countDown()
                            }
                            // else wait for authenticated SYNC_FINAL_ACK or overall timeout
                        } catch (e: Exception) {
                            sessionCancelled.set(true)
                            out.set(Result(false, e.message ?: "PHONE_PAGE_FAIL", completeness = "FAILED"))
                            done.countDown()
                        }
                    }.start()
                } catch (e: Exception) {
                    sessionCancelled.set(true)
                    out.set(Result(false, e.message ?: "PHONE_SESSION_FAIL", completeness = "FAILED"))
                    done.countDown()
                }
            }
            val finished = done.await(req.timeoutMs, TimeUnit.MILLISECONDS)
            val result = out.get()
            // Require authenticated FINAL_ACK for COMPLETE; never invent completion from silence.
            if (!finished || !finalAckAccepted.get()) {
                if (req.skipWaitFinalAck && result.ok) {
                    return result
                }
                if (result.ok && !finalAckAccepted.get()) {
                    return result.copy(ok = false, code = "MISSING_FINAL_ACK", completeness = "INTERRUPTED")
                }
            } else if (result.ok && req.clearCheckpointOnComplete && result.completeness == "COMPLETE") {
                SosHistoryCheckpointStore.clear(
                    context,
                    req.auth.accountP,
                    req.auth.deviceId,
                    COLLECTION_ID,
                )
            }
            return result
        } finally {
            sessionCancelled.set(true)
            transport.stop()
            SosDeviceKeyCrypto.zeroize(ephPriv)
            sessionKey?.let { SosDeviceKeyCrypto.zeroize(it) }
        }
    }
}
