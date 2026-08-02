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
 * מאזין Nostr מקורי בתוך שירות הרקע –
 * הודעות (1050) + שיחות נכנסות (25050 offer / v-offer) גם כשהממשק סגור.
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
    private var lastCallNotifyAt = 0L

    fun start() {
        val pubkey = SosSessionStore.getPubkey(appContext)
        if (pubkey.length != 64) {
            Log.w(TAG, "no pubkey – relay watcher idle")
            stop()
            return
        }
        if (!running.compareAndSet(false, true)) {
            stopSocketsOnly()
            running.set(true)
        }
        Log.i(TAG, "starting watcher for ${pubkey.take(8)}…")
        RELAYS.forEach { url -> connectRelay(url, pubkey) }
    }

    fun stop() {
        running.set(false)
        stopSocketsOnly()
        CallSoundHelper.stopAll()
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
                val since = (System.currentTimeMillis() / 1000L) - 30
                val filterYala = JSONObject()
                    .put("kinds", JSONArray().put(CHAT_KIND))
                    .put("#p", JSONArray().put(pubkey))
                    .put("#t", JSONArray().put(CHAT_TAG))
                    .put("since", since)
                val filterNet = JSONObject()
                    .put("kinds", JSONArray().put(CHAT_KIND))
                    .put("#p", JSONArray().put(pubkey))
                    .put("#t", JSONArray().put(NETWORK_TAG))
                    .put("since", since)
                val filterCalls = JSONObject()
                    .put("kinds", JSONArray().put(CALL_KIND))
                    .put("#p", JSONArray().put(pubkey))
                    .put("since", since)
                val req = JSONArray()
                    .put("REQ")
                    .put("sos-bg-${pubkey.take(8)}")
                    .put(filterYala)
                    .put(filterNet)
                    .put(filterCalls)
                webSocket.send(req.toString())
                Log.i(TAG, "subscribed chat+calls on $url")
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
            if (author.isBlank() || author == selfPubkey) return
            if (id.isNotBlank() && !seenIds.add(id)) return
            trimSeen()

            val tags = event.optJSONArray("tags") ?: return
            var addressedToMe = false
            var signalType = ""
            for (i in 0 until tags.length()) {
                val tag = tags.optJSONArray(i) ?: continue
                val k = tag.optString(0)
                val v = tag.optString(1)
                if (k == "p" && v.equals(selfPubkey, true)) addressedToMe = true
                if (k == "type") signalType = v
            }
            if (!addressedToMe) return

            when (kind) {
                CHAT_KIND -> notifyChat(author, event.optString("content").orEmpty(), id)
                CALL_KIND -> handleCallSignal(author, signalType)
            }
        } catch (err: Exception) {
            Log.w(TAG, "parse fail: ${err.message}")
        }
    }

    private fun notifyChat(author: String, rawContent: String, eventId: String) {
        // כשהממשק פתוח – ה-Web מטפל בהתראות (מונע כפילות צליל/כרטיס)
        if (MainActivity.isHostAlive) return

        val raw = rawContent.trim()
        val preview = when {
            raw.isBlank() -> "הודעה חדשה"
            raw.startsWith("{") -> "הודעה / קובץ"
            raw.length > 120 -> raw.take(117) + "…"
            else -> raw
        }
        val senderLabel = "משתמש ${author.take(8)}"

        NotificationHelper.showMessage(
            appContext,
            senderLabel,
            preview,
            "https://sos010.com/videos.html?chat=$author",
            "chat-$author",
            eventId = eventId,
            peerKey = author
        )
        lastNotifyAt = System.currentTimeMillis()
        Log.i(TAG, "chat notify from ${author.take(8)}")
    }

    private fun handleCallSignal(author: String, signalType: String) {
        when (signalType) {
            "offer", "v-offer" -> {
                val now = System.currentTimeMillis()
                if (now - lastCallNotifyAt < 2500L) return
                lastCallNotifyAt = now
                // אם הממשק פתוח – ה-Web מטפל בצלצול
                if (MainActivity.isHostAlive) return
                val isVideo = signalType == "v-offer"
                val callType = if (isVideo) "video" else "voice"
                val title = if (isVideo) "שיחת וידאו נכנסת" else "שיחה קולית נכנסת"
                NotificationHelper.showIncomingCall(
                    appContext,
                    title,
                    "מישהו מתקשר אליך ב-SOS",
                    "https://sos010.com/videos.html?chat=$author&incomingCall=$callType",
                    callType
                )
                Log.i(TAG, "incoming $callType from ${author.take(8)}")
            }
            "disconnect", "v-disconnect" -> {
                NotificationHelper.cancelIncomingCall(appContext)
            }
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
        private const val CALL_KIND = 25050
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
