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
 * הודעות (1050) + שיחות נכנסות (25050) + סיגנלי P2P (25055) גם כשהממשק סגור.
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
                val filterP2p = JSONObject()
                    .put("kinds", JSONArray().put(P2P_KIND))
                    .put("#p", JSONArray().put(pubkey))
                    .put("since", since)
                val req = JSONArray()
                    .put("REQ")
                    .put("sos-bg-${pubkey.take(8)}")
                    .put(filterYala)
                    .put(filterNet)
                    .put(filterCalls)
                    .put(filterP2p)
                webSocket.send(req.toString())
                Log.i(TAG, "subscribed chat+calls+p2p on $url")
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
            if (author.isBlank()) return
            if (id.isNotBlank() && !seenIds.add(id)) return
            trimSeen()

            // פרופיל kind:0 – שמירה לקאש ועדכון כרטיס התראה | HYPER CORE TECH
            if (kind == 0) {
                handleProfileEvent(author, event.optString("content").orEmpty())
                return
            }

            if (author == selfPubkey) return

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
                CALL_KIND -> handleCallSignal(author, signalType, event)
                P2P_KIND -> handleP2pSignal(author, signalType, event)
            }
        } catch (err: Exception) {
            Log.w(TAG, "parse fail: ${err.message}")
        }
    }

    private fun handleProfileEvent(author: String, content: String) {
        if (content.isBlank()) return
        try {
            val meta = JSONObject(content)
            val name = meta.optString("display_name").ifBlank { meta.optString("name") }.trim()
            val picture = meta.optString("picture").trim()
            if (name.isEmpty() && picture.isEmpty()) return
            SosContactCache.put(appContext, author, name, picture)
            NotificationHelper.updatePeerProfile(appContext, author, name, picture)
            Log.i(TAG, "profile cached ${author.take(8)} name=${name.take(24)}")
        } catch (err: Exception) {
            Log.w(TAG, "profile parse fail: ${err.message}")
        }
    }

    private fun requestProfile(author: String) {
        if (author.length != 64) return
        val filter = JSONObject()
            .put("kinds", JSONArray().put(0))
            .put("authors", JSONArray().put(author))
            .put("limit", 1)
        val req = JSONArray()
            .put("REQ")
            .put("sos-prof-${author.take(8)}")
            .put(filter)
            .toString()
        sockets.values.forEach { ws ->
            runCatching { ws.send(req) }
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
        val cached = SosContactCache.get(appContext, author)
        val senderLabel = when {
            !cached?.name.isNullOrBlank() && !cached!!.name.startsWith("משתמש ") -> cached.name
            else -> "משתמש"
        }

        NotificationHelper.showMessage(
            appContext,
            senderLabel,
            preview,
            "https://sos010.com/videos.html?chat=$author",
            "chat-$author",
            eventId = eventId,
            peerKey = author,
            pictureUrl = cached?.picture
        )
        // אם אין שם אמיתי בקאש – מבקשים kind:0 מהריליי ומעדכנים את הכרטיס | HYPER CORE TECH
        if (cached?.name.isNullOrBlank() || cached!!.name.startsWith("משתמש ")) {
            requestProfile(author)
        } else if (cached.picture.isBlank()) {
            requestProfile(author)
        }
        lastNotifyAt = System.currentTimeMillis()
        Log.i(TAG, "chat notify from ${author.take(8)} as $senderLabel")
    }

    /** סיגנל P2P – Native רק כשאין Activity; אחרת WebView מטפל | HYPER CORE TECH */
    private fun handleP2pSignal(author: String, signalType: String, event: JSONObject) {
        if (MainActivity.isActivityAlive) return
        if (!SosSessionStore.isP2pStandbyEnabled(appContext)) return
        Log.i(TAG, "p2p signal $signalType from ${author.take(8)}")
        SosNativeP2pEngine.onSignalEvent(author, signalType, event)
    }

    fun publish(event: JSONObject) {
        val msg = JSONArray().put("EVENT").put(event).toString()
        sockets.values.forEach { ws ->
            runCatching { ws.send(msg) }
        }
    }

    private fun handleCallSignal(author: String, signalType: String, event: JSONObject) {
        when (signalType) {
            "offer", "v-offer" -> {
                val now = System.currentTimeMillis()
                // דיכוי קצר בלבד (offer כפול מהריליי) – לא חוסם שיחה חדשה אחרי ~8 שנ' | HYPER CORE TECH
                if (SosIncomingCallSession.isSuppressed(appContext, author)) {
                    Log.i(TAG, "suppressed offer from ${author.take(8)}")
                    return
                }
                // אותה שיחה כבר מצלצלת – לא לפתוח התראה שוב, אבל מעדכנים raw event
                val isVideo = signalType == "v-offer"
                val callType = if (isVideo) "video" else "voice"
                try {
                    SosPendingCallStore.saveRawEvent(appContext, author, callType, event.toString())
                } catch (err: Exception) {
                    Log.w(TAG, "save raw offer failed: ${err.message}")
                }
                if (SosIncomingCallSession.isSameActiveCall(appContext, author)) {
                    Log.i(TAG, "duplicate active offer from ${author.take(8)} (raw refreshed)")
                    return
                }
                if (now - lastCallNotifyAt < 1500L) return
                lastCallNotifyAt = now
                val title = if (isVideo) "שיחת וידאו נכנסת" else "שיחה קולית נכנסת"
                val caller = SosContactCache.displayName(appContext, author, "מישהו")
                val openUrl = SosCallUrls.acceptPage(callType)

                // גם כשהממשק פתוח – אם המסך כבוי/ברקע isHostAlive=false.
                // כשהממשק בחזית: Web מציג דיאלוג; עדיין מציגים התראת CallStyle בלי FSI כפול.
                if (MainActivity.isHostAlive) {
                    Log.i(TAG, "host alive – web handles UI, raw offer cached")
                    return
                }

                // מחממים WebView ברקע בזמן צלצול – ענה יהיה מהיר | HYPER CORE TECH
                MainActivity.warmHostForIncomingCall(appContext, author, callType)

                NotificationHelper.showIncomingCall(
                    appContext,
                    title,
                    "$caller מתקשר אליך ב-SOS",
                    openUrl,
                    callType,
                    peerPubkey = author,
                    callerName = caller
                )
                if (caller == "מישהו") requestProfile(author)
                Log.i(TAG, "incoming $callType from ${author.take(8)}")
            }
            "disconnect", "v-disconnect" -> {
                SosIncomingCallSession.markRemoteEnded(appContext, author)
                SosPendingCallStore.clear(appContext)
                NotificationHelper.cancelIncomingCall(appContext)
                CallSoundHelper.stopAll()
                IncomingCallActivity.dismiss(appContext, author)
                Log.i(TAG, "remote hangup from ${author.take(8)}")
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
        private const val P2P_KIND = 25055
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

        fun publishEvent(context: Context, event: JSONObject) {
            ensureStarted(context)
            instance?.publish(event)
        }
    }
}
