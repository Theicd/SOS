package com.sos010.app

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * MD4 S3 — kind 25060 transport with t=sos-hist-v1 only (never sos-pair-v1).
 */
class SosHistoryNostrTransport(
    private val relayUrls: List<String>,
    private val ephemeralSkHex: String = randomSk(),
) {
    companion object {
        const val KIND = 25060
        const val TAG = SosHistorySyncCrypto.TAG

        private fun randomSk(): String {
            val rnd = SecureRandom()
            repeat(32) {
                val b = ByteArray(32).also { rnd.nextBytes(it) }
                val hex = fr.acinq.secp256k1.Hex.encode(b)
                try {
                    SosNostrCrypto.pubkeyFromPriv(hex)
                    return hex
                } catch (_: Exception) {
                }
            }
            throw IllegalStateException("secp_sk_gen")
        }
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    private val sockets = CopyOnWriteArrayList<WebSocket>()
    private val pendingFrames = CopyOnWriteArrayList<String>()
    private val readyCount = AtomicInteger(0)
    private val seen = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val open = AtomicBoolean(false)
    private var onMessage: ((sessionId: String, content: String) -> Unit)? = null
    private var sessionFilter: String? = null
    private var localRole: String = "phone"
    private var reqMsg: String = ""

    /** Subscribe to all hist sessions (phone) or a specific sessionId (desktop). */
    fun start(
        role: String,
        sessionIdHex: String? = null,
        onMsg: (sessionId: String, content: String) -> Unit,
    ) {
        stop()
        localRole = role
        onMessage = onMsg
        sessionFilter = sessionIdHex?.let { SosDeviceKeyCrypto.normalizeHex(it) }
        open.set(true)
        readyCount.set(0)
        pendingFrames.clear()
        val filter = JSONObject()
            .put("kinds", JSONArray().put(KIND))
            .put("#t", JSONArray().put(TAG))
            .put("limit", 500)
        if (sessionFilter != null) {
            filter.put("#d", JSONArray().put(sessionFilter))
        }
        val subId = "hist-" + (sessionFilter?.take(12) ?: "scan")
        reqMsg = JSONArray().put("REQ").put(subId).put(filter).toString()
        for (url in relayUrls) {
            try {
                val ws = http.newWebSocket(
                    Request.Builder().url(url).build(),
                    object : WebSocketListener() {
                        override fun onOpen(webSocket: WebSocket, response: Response) {
                            try {
                                webSocket.send(reqMsg)
                            } catch (_: Exception) {
                            }
                            val n = readyCount.incrementAndGet()
                            flushPending()
                            // Announce listener readiness so desktop can (re)send SYNC_HELLO after REQ is live.
                            if (n == 1 && localRole == "phone") {
                                try {
                                    val probeSid = sessionFilter ?: SosHistorySyncCrypto.newSessionId()
                                    val ready =
                                        org.json.JSONObject()
                                            .put("type", "SYNC_PHONE_READY")
                                            .put("role", "phone")
                                            .put("ts", System.currentTimeMillis())
                                    // Use a dedicated probe session id if scanning; desktop listens broadly via its session.
                                    if (sessionFilter != null) {
                                        publish(probeSid, ready.toString())
                                    }
                                } catch (_: Exception) {
                                }
                            }
                        }

                        override fun onMessage(webSocket: WebSocket, text: String) {
                            handleRelayFrame(text)
                        }

                        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                            sockets.remove(webSocket)
                        }

                        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                            sockets.remove(webSocket)
                        }
                    },
                )
                sockets.add(ws)
            } catch (_: Exception) {
            }
        }
    }

    fun publish(sessionIdHex: String, message: String): Boolean {
        if (!open.get()) return false
        val sid = SosDeviceKeyCrypto.normalizeHex(sessionIdHex)
        val ev = try {
            signEnvelope(sid, message)
        } catch (_: Exception) {
            return false
        }
        val frame = JSONArray().put("EVENT").put(ev).toString()
        if (readyCount.get() <= 0) {
            pendingFrames.add(frame)
            val deadline = System.currentTimeMillis() + 20_000L
            while (readyCount.get() <= 0 && System.currentTimeMillis() < deadline && open.get()) {
                try {
                    Thread.sleep(50)
                } catch (_: InterruptedException) {
                    break
                }
            }
            if (readyCount.get() > 0) {
                flushPending()
                return true
            }
            return true
        }
        return sendFrame(frame)
    }

    private fun flushPending() {
        if (readyCount.get() <= 0) return
        val snapshot = pendingFrames.toList()
        pendingFrames.clear()
        for (frame in snapshot) sendFrame(frame)
    }

    private fun sendFrame(frame: String): Boolean {
        var ok = false
        for (ws in sockets) {
            try {
                if (ws.send(frame)) ok = true
            } catch (_: Exception) {
            }
        }
        return ok
    }

    fun stop() {
        open.set(false)
        onMessage = null
        pendingFrames.clear()
        readyCount.set(0)
        for (ws in sockets) {
            try {
                ws.close(1000, null)
            } catch (_: Exception) {
            }
        }
        sockets.clear()
        seen.clear()
    }

    private fun handleRelayFrame(text: String) {
        try {
            val arr = JSONArray(text)
            if (arr.length() < 3 || arr.getString(0) != "EVENT") return
            val ev = arr.getJSONObject(2)
            if (ev.optInt("kind") != KIND) return
            val id = ev.optString("id")
            if (id.isNotEmpty() && !seen.add(id)) return
            val tags = ev.optJSONArray("tags") ?: return
            var d = ""
            var role = ""
            var protocolTag = ""
            for (i in 0 until tags.length()) {
                val t = tags.optJSONArray(i) ?: continue
                if (t.length() < 2) continue
                when (t.getString(0)) {
                    "d" -> d = SosDeviceKeyCrypto.normalizeHex(t.getString(1))
                    "role" -> role = t.getString(1)
                    "t" -> protocolTag = t.getString(1)
                }
            }
            if (protocolTag != TAG) return
            if (protocolTag == "sos-pair-v1") return
            if (sessionFilter != null && d != sessionFilter) return
            if (role == localRole) return
            val content = ev.optString("content")
            if (content.isNotBlank()) onMessage?.invoke(d, content)
        } catch (_: Exception) {
        }
    }

    private fun signEnvelope(sessionId: String, message: String): JSONObject {
        val tags = JSONArray()
            .put(JSONArray().put("t").put(TAG))
            .put(JSONArray().put("d").put(sessionId))
            .put(JSONArray().put("role").put(localRole))
        return SosNostrCrypto.signEvent(ephemeralSkHex, KIND, tags, message)
    }
}
