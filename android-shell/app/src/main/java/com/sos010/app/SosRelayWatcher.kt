package com.sos010.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * מאזין Nostr מקורי בתוך שירות הרקע – מקבל הודעות צ'אט גם כשסגרו את הממשק.
 * kind 1050 + #t=yalachat (כמו chat-service.js).
 */
class SosRelayWatcher(private val appContext: Context) {

    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val sockets = ConcurrentHashMap<String, WebSocket>()
    private val seenIds = ConcurrentHashMap.newKeySet<String>()
    private val running = AtomicBoolean(false)
    private val mainHandler = Handler(Looper.getMainLooper())
    private var lastNotifyAt = 0L

    fun start() {
        val pubkey = SosSessionStore.getPubkey(appContext)
        if (pubkey.length != 64) {
            Log.w(TAG, "no pubkey – relay watcher idle")
            stop()
            return
        }
        if (!running.compareAndSet(false, true)) {
            // כבר רץ – רענון חיבורים
            stopSocketsOnly()
            running.set(true)
        }
        Log.i(TAG, "starting watcher for ${pubkey.take(8)}…")
        RELAYS.forEach { url -> connectRelay(url, pubkey) }
    }

    fun stop() {
        running.set(false)
        stopSocketsOnly()
    }

    private fun stopSocketsOnly() {
        sockets.values.forEach { runCatching { it.close(1000, "stop") } }
        sockets.clear()
    }

    private fun connectRelay(url: String, pubkey: String) {
        if (!running.get()) return
        val request = Request.Builder().url(url).build()
        val ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                sockets[url] = webSocket
                val subId = "sos-bg-${pubkey.take(8)}"
                val filterYala = JSONObject()
                    .put("kinds", JSONArray().put(CHAT_KIND))
                    .put("#p", JSONArray().put(pubkey))
                    .put("#t", JSONArray().put(CHAT_TAG))
                    .put("since", (System.currentTimeMillis() / 1000L) - 30)
                val filterNet = JSONObject()
                    .put("kinds", JSONArray().put(CHAT_KIND))
                    .put("#p", JSONArray().put(pubkey))
                    .put("#t", JSONArray().put(NETWORK_TAG))
                    .put("since", (System.currentTimeMillis() / 1000L) - 30)
                val req = JSONArray()
                    .put("REQ")
                    .put(subId)
                    .put(filterYala)
                    .put(filterNet)
                webSocket.send(req.toString())
                Log.i(TAG, "subscribed on $url")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(text, pubkey)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                sockets.remove(url)
                scheduleReconnect(url, pubkey)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "relay fail $url: ${t.message}")
                sockets.remove(url)
                scheduleReconnect(url, pubkey)
            }
        })
        sockets[url] = ws
    }

    private fun scheduleReconnect(url: String, pubkey: String) {
        if (!running.get()) return
        mainHandler.postDelayed({
            if (running.get() && !sockets.containsKey(url)) {
                connectRelay(url, pubkey)
            }
        }, 5_000L)
    }

    private fun handleMessage(text: String, selfPubkey: String) {
        try {
            val arr = JSONArray(text)
            if (arr.length() < 3) return
            if (arr.optString(0) != "EVENT") return
            val event = arr.optJSONObject(2) ?: return
            val id = event.optString("id")
            val author = event.optString("pubkey").lowercase()
            val kind = event.optInt("kind")
            if (kind != CHAT_KIND) return
            if (author.isBlank() || author == selfPubkey) return
            if (id.isNotBlank() && !seenIds.add(id)) return
            trimSeen()

            // וידוא שיש תגית p אלינו
            val tags = event.optJSONArray("tags") ?: return
            var addressedToMe = false
            for (i in 0 until tags.length()) {
                val tag = tags.optJSONArray(i) ?: continue
                if (tag.optString(0) == "p" && tag.optString(1).equals(selfPubkey, true)) {
                    addressedToMe = true
                    break
                }
            }
            if (!addressedToMe) return

            val now = System.currentTimeMillis()
            if (now - lastNotifyAt < 800L) return
            lastNotifyAt = now

            val raw = event.optString("content").orEmpty().trim()
            val preview = when {
                raw.isBlank() -> "קיבלת הודעה חדשה"
                raw.startsWith("{") -> "קיבלת הודעה / קובץ"
                raw.length > 120 -> raw.take(117) + "…"
                else -> raw
            }

            NotificationHelper.showMessage(
                appContext,
                "הודעה חדשה ב-SOS",
                preview,
                "https://sos010.com/videos.html?chat=$author",
                "chat-$author"
            )
            Log.i(TAG, "notified for event from ${author.take(8)}")
        } catch (err: Exception) {
            Log.w(TAG, "parse fail: ${err.message}")
        }
    }

    private fun trimSeen() {
        if (seenIds.size <= 300) return
        val extra = seenIds.size - 200
        val it = seenIds.iterator()
        var removed = 0
        while (it.hasNext() && removed < extra) {
            it.next()
            it.remove()
            removed++
        }
    }

    companion object {
        private const val TAG = "SosRelayWatcher"
        private const val CHAT_KIND = 1050
        private const val CHAT_TAG = "yalachat"
        private const val NETWORK_TAG = "israel-network"

        private val RELAYS = listOf(
            "wss://relay.snort.social",
            "wss://nos.lol",
            "wss://nostr-relay.xbytez.io",
            "wss://nostr-02.uid.ovh",
        )

        @Volatile
        private var instance: SosRelayWatcher? = null

        fun ensureStarted(context: Context) {
            val app = context.applicationContext
            val watcher = instance ?: SosRelayWatcher(app).also { instance = it }
            watcher.start()
        }

        fun stopAll() {
            instance?.stop()
        }
    }
}
