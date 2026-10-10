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
 * MD2/MD3 pairing transport via Nostr ephemeral envelopes (ciphertext after hello).
 * Uses optional QR rendezvous URL or default SOS relays. Not a new crypto protocol —
 * opaque message strings only (SosPairingSession abstract transport).
 *
 * Kind 25060, tags: t=sos-pair-v1, d=<pairingId>, role=desktop|phone
 */
class SosPairingNostrTransport(
    private val relayUrls: List<String> = DEFAULT_RELAYS,
    private val ephemeralSkHex: String = randomSk(),
) {
    companion object {
        const val KIND = 25060
        const val TAG = "sos-pair-v1"
        val DEFAULT_RELAYS = listOf(
            "wss://relay.snort.social",
            "wss://nos.lol",
            "wss://nostr-02.uid.ovh",
        )

        private fun randomSk(): String {
            val rnd = SecureRandom()
            // Valid secp256k1 private key (retry until pubkeyCreate succeeds).
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
    private var onMessage: ((String) -> Unit)? = null
    private var pairingId: String = ""
    private var localRole: String = "phone"
    private var reqMsg: String = ""

    fun start(pairingIdHex: String, role: String, onMsg: (String) -> Unit) {
        stop()
        pairingId = SosDeviceKeyCrypto.normalizeHex(pairingIdHex)
        localRole = role
        onMessage = onMsg
        open.set(true)
        readyCount.set(0)
        pendingFrames.clear()
        val filter = JSONObject()
            .put("kinds", JSONArray().put(KIND))
            .put("#t", JSONArray().put(TAG))
            .put("#d", JSONArray().put(pairingId))
            .put("limit", 40)
        val subId = "pair-" + pairingId.take(12)
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
                            readyCount.incrementAndGet()
                            flushPending(webSocket)
                        }

                        override fun onMessage(webSocket: WebSocket, text: String) {
                            handleRelayFrame(text)
                        }

                        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                            // Observed for diagnostics; keep sockets list consistent.
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

    fun publish(message: String): Boolean {
        if (!open.get() || pairingId.isEmpty()) return false
        val ev = try {
            signEnvelope(message)
        } catch (_: Exception) {
            return false
        }
        val frame = JSONArray().put("EVENT").put(ev).toString()
        if (readyCount.get() <= 0) {
            // WebSocket connect is async — queue until onOpen flushes.
            pendingFrames.add(frame)
            // Wait for first relay open (local/emulator cleartext path).
            val deadline = System.currentTimeMillis() + 20_000L
            while (readyCount.get() <= 0 && System.currentTimeMillis() < deadline && open.get()) {
                try {
                    Thread.sleep(50)
                } catch (_: InterruptedException) {
                    break
                }
            }
            if (readyCount.get() > 0) {
                val snapshot = pendingFrames.toList()
                pendingFrames.clear()
                var ok = false
                for (f in snapshot) if (sendFrame(f)) ok = true
                return ok
            }
            return true // still queued for later onOpen flush
        }
        return sendFrame(frame)
    }

    private fun flushPending(ws: WebSocket) {
        for (frame in pendingFrames) {
            try {
                ws.send(frame)
            } catch (_: Exception) {
            }
        }
        // Keep pending for other relays that open later; also send via sendFrame once any ready.
        if (readyCount.get() > 0) {
            val snapshot = pendingFrames.toList()
            pendingFrames.clear()
            for (frame in snapshot) sendFrame(frame)
        }
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
            for (i in 0 until tags.length()) {
                val t = tags.optJSONArray(i) ?: continue
                if (t.length() < 2) continue
                when (t.getString(0)) {
                    "d" -> d = SosDeviceKeyCrypto.normalizeHex(t.getString(1))
                    "role" -> role = t.getString(1)
                }
            }
            if (d != pairingId) return
            // Strict domain separation: MD2 must never accept sos-hist-v1 (or unknown) frames.
            var protocolTag = ""
            for (i in 0 until tags.length()) {
                val t = tags.optJSONArray(i) ?: continue
                if (t.length() >= 2 && t.getString(0) == "t") {
                    protocolTag = t.getString(1)
                    break
                }
            }
            if (protocolTag != TAG) return
            // Ignore our own role echoes
            if (role == localRole) return
            val content = ev.optString("content")
            if (content.isNotBlank()) onMessage?.invoke(content)
        } catch (_: Exception) {
        }
    }

    private fun signEnvelope(message: String): JSONObject {
        val tags = JSONArray()
            .put(JSONArray().put("t").put(TAG))
            .put(JSONArray().put("d").put(pairingId))
            .put(JSONArray().put("role").put(localRole))
        return SosNostrCrypto.signEvent(ephemeralSkHex, KIND, tags, message)
    }
}
