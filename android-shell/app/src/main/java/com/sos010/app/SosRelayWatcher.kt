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
 * הודעות (1050) + Gift Wrap 1059 (opaque wake) + legacy 25050 READ-ONLY.
 * P2P (25055) לא כאן – רק WebView כשה-Activity חיה (גם ברקע).
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
    private var lastSecureWakeAt = 0L
    private var secureWakeWindowStart = 0L
    private var secureWakeCount = 0
    private var secureWarmInFlight = false
    private val opaqueWakeSeen = LinkedHashSet<String>()

    fun start() {
        val pubkey = SosSessionStore.getPubkey(appContext)
        if (pubkey.length != 64) {
            Log.w(TAG, "no pubkey – relay watcher idle")
            SosDebugLog.w("relay", "no pubkey – idle")
            stop()
            return
        }
        // Idempotent: אם כבר רץ – רק משלימים ריליים חסרים, בלי לנתק סוקטים חיים | HYPER CORE TECH
        if (!running.compareAndSet(false, true)) {
            var missing = 0
            RELAYS.forEach { url ->
                if (!sockets.containsKey(url)) {
                    missing++
                    connectRelay(url, pubkey)
                }
            }
            if (missing > 0) {
                SosDebugLog.i("relay", "ensure missing=$missing pubkey=redacted")
            }
            return
        }
        Log.i(TAG, "starting watcher")
        SosDebugLog.i("relay", "start watcher")
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
                failCounts[url] = 0
                val nowSec = System.currentTimeMillis() / 1000L
                val sinceChat = nowSec - 30
                // Gift-wrap outer created_at is privacy-randomized up to ~2 days past.
                val sinceSecure = nowSec - (2L * 24L * 60L * 60L) - 120L
                val filterYala = JSONObject()
                    .put("kinds", JSONArray().put(CHAT_KIND))
                    .put("#p", JSONArray().put(pubkey))
                    .put("#t", JSONArray().put(CHAT_TAG))
                    .put("since", sinceChat)
                val filterNet = JSONObject()
                    .put("kinds", JSONArray().put(CHAT_KIND))
                    .put("#p", JSONArray().put(pubkey))
                    .put("#t", JSONArray().put(NETWORK_TAG))
                    .put("since", sinceChat)
                val filterSecureCalls = JSONObject()
                    .put("kinds", JSONArray().put(GIFT_WRAP_KIND))
                    .put("#p", JSONArray().put(pubkey))
                    .put("since", sinceSecure)
                // LEGACY_READ_ONLY: direct kind 25050 from already-deployed clients.
                val filterLegacyCalls = JSONObject()
                    .put("kinds", JSONArray().put(CALL_KIND))
                    .put("#p", JSONArray().put(pubkey))
                    .put("since", sinceChat)
                // בלי 25055 – חוסך תעבורה ומונע הדלקת Native כשהכרטיס סגור | HYPER CORE TECH
                // Subscription id must NOT embed pubkey prefix (relay-visible).
                val req = JSONArray()
                    .put("REQ")
                    .put("sos-bg-secure")
                    .put(filterYala)
                    .put(filterNet)
                    .put(filterSecureCalls)
                    .put(filterLegacyCalls)
                webSocket.send(req.toString())
                Log.i(TAG, "subscribed chat+secure-calls on $url")
                SosDebugLog.i("relay", "subscribed $url")
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
                SosDebugLog.w("relay", "fail $url: ${t.message}")
                sockets.remove(url)
                scheduleReconnect(url, pubkey)
            }
        })
        sockets[url] = ws
    }

    private val failCounts = ConcurrentHashMap<String, Int>()
    private val BACKOFF_MS = longArrayOf(2_000L, 5_000L, 15_000L, 30_000L, 60_000L)

    private fun scheduleReconnect(url: String, pubkey: String) {
        if (!running.get()) return
        val n = failCounts.getOrDefault(url, 0)
        val base = BACKOFF_MS[n.coerceAtMost(BACKOFF_MS.lastIndex)]
        val jitter = (Math.random() * 400).toLong()
        failCounts[url] = n + 1
        mainHandler.postDelayed({
            if (running.get() && !sockets.containsKey(url)) {
                connectRelay(url, pubkey)
            }
        }, base + jitter)
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
                GIFT_WRAP_KIND -> handleSecureGiftWrap(event, id)
                CALL_KIND -> handleCallSignal(author, signalType, event) // LEGACY_READ_ONLY
                // P2P_KIND מתעלמים במכוון – WebView בלבד כש-Activity חיה | HYPER CORE TECH
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
            Log.i(TAG, "profile cached redacted nameLen=${name.length}")
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
            .put("sos-prof-req")
            .put(filter)
            .toString()
        sockets.values.forEach { ws ->
            runCatching { ws.send(req) }
        }
    }

    private fun notifyChat(author: String, rawContent: String, eventId: String) {
        // כשהממשק פתוח – ה-Web מטפל בהתראות (מונע כפילות צליל/כרטיס)
        if (MainActivity.isHostAlive) {
            SosDebugLog.i("relay", "chat skip hostAlive id=${eventId.take(10)} from=redacted")
            return
        }

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

        SosDebugLog.i("relay", "chat NOTIFY redacted")
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
        // לא מרימים Native WebRTC על הודעת צ'אט – שומרים את תהליך ההתראות חי | HYPER CORE TECH
        // אם אין שם אמיתי בקאש – מבקשים kind:0 מהריליי ומעדכנים את הכרטיס | HYPER CORE TECH
        if (cached?.name.isNullOrBlank() || cached!!.name.startsWith("משתמש ")) {
            requestProfile(author)
        } else if (cached.picture.isBlank()) {
            requestProfile(author)
        }
        lastNotifyAt = System.currentTimeMillis()
        Log.i(TAG, "chat notify from redacted as $senderLabel")
    }

    fun publish(event: JSONObject) {
        val msg = JSONArray().put("EVENT").put(event).toString()
        sockets.values.forEach { ws ->
            runCatching { ws.send(msg) }
        }
    }

    /**
     * Opaque kind 1059 wake ONLY.
     * Must NOT ring / show call UI until JS authenticates sos-call-signal + offer.
     * Always enqueue (bounded); Activity wake is rate-limited separately so stale
     * historical wraps cannot starve a fresh offer sitting in the queue.
     */
    private fun handleSecureGiftWrap(event: JSONObject, eventId: String) {
        val id = eventId.ifBlank { event.optString("id") }
        if (id.isBlank()) return
        // Opaque wake-dedupe only — NOT authenticated handled-offer state.
        if (opaqueWakeSeen.contains(id)) {
            return
        }
        val queued = try {
            SosPendingCallStore.enqueueSecureWrap(appContext, event.toString())
        } catch (err: Exception) {
            Log.w(TAG, "enqueue secure wrap failed: ${err.message}")
            false
        }
        if (!queued) return
        rememberOpaqueWakeId(id)
        // Foreground WebView shared 1059 dispatcher handles live events.
        if (MainActivity.isHostAlive) {
            Log.i(TAG, "SECURE_WAKE hostAlive – JS handles")
            return
        }
        // One warm hosts the whole queue; further wraps only enqueue.
        if (secureWarmInFlight) {
            Log.i(TAG, "SECURE_WAKE queued (warm in-flight)")
            return
        }
        if (!allowSecureWake()) {
            // Still queued — do not drop; next wake window or existing warm drains.
            Log.i(TAG, "SECURE_WAKE rate-limited (kept in queue)")
            if (SosPendingCallStore.peekSecureWrapCount(appContext) > 0 &&
                System.currentTimeMillis() - lastSecureWakeAt > 15_000L
            ) {
                // Allow a single recovery wake so a fresh offer is not starved forever.
                secureWakeCount = 0
            } else {
                return
            }
            if (!allowSecureWake()) return
        }
        secureWarmInFlight = true
        lastSecureWakeAt = System.currentTimeMillis()
        Log.i(TAG, "SECURE_WAKE opaque → warm host")
        SosDebugLog.i("relay", "SECURE_WAKE opaque")
        MainActivity.warmHostForSecureWrap(appContext)
    }

    private fun rememberOpaqueWakeId(id: String) {
        opaqueWakeSeen.add(id)
        while (opaqueWakeSeen.size > 200) {
            val first = opaqueWakeSeen.iterator().next()
            opaqueWakeSeen.remove(first)
        }
    }

    /** Max ~6 Activity wakes / minute. Queue enqueue is NOT gated by this. */
    private fun allowSecureWake(): Boolean {
        val now = System.currentTimeMillis()
        if (now - secureWakeWindowStart > 60_000L) {
            secureWakeWindowStart = now
            secureWakeCount = 0
        }
        if (secureWakeCount >= 6) return false
        if (now - lastSecureWakeAt < 800L) return false
        secureWakeCount++
        return true
    }

    private fun handleCallSignal(author: String, signalType: String, event: JSONObject) {
        when (signalType) {
            "offer", "v-offer" -> {
                val now = System.currentTimeMillis()
                val eventId = event.optString("id")
                val createdAt = event.optLong("created_at", 0L)
                if (SosIncomingCallSession.isOfferTooOld(createdAt)) {
                    Log.i(TAG, "stale offer from redacted age>${SosIncomingCallSession.MAX_OFFER_AGE_SEC}s")
                    SosIncomingCallSession.rememberHandledOffer(appContext, eventId)
                    return
                }
                if (SosIncomingCallSession.isHandledOffer(appContext, eventId)) {
                    Log.i(TAG, "already-handled offer redacted")
                    return
                }
                if (SosIncomingCallSession.isReplayOfEndedCall(appContext, author, createdAt)) {
                    SosIncomingCallSession.rememberHandledOffer(appContext, eventId)
                    Log.i(TAG, "replay after hangup redacted")
                    SosDebugLog.i("relay", "call skip ended-replay from=redacted")
                    return
                }
                // אותה שיחה כבר מצלצלת/בשיחה – לא לפתוח התראה שוב | HYPER CORE TECH
                val isVideo = signalType == "v-offer"
                val callType = if (isVideo) "video" else "voice"
                try {
                    SosPendingCallStore.saveRawEvent(appContext, author, callType, event.toString())
                } catch (err: Exception) {
                    Log.w(TAG, "save raw offer failed: ${err.message}")
                }
                if (SosIncomingCallSession.isSameActiveCall(appContext, author)) {
                    SosIncomingCallSession.rememberHandledOffer(appContext, eventId)
                    Log.i(TAG, "duplicate active offer from redacted (raw refreshed)")
                    return
                }
                if (now - lastCallNotifyAt < 1500L) return
                lastCallNotifyAt = now
                val title = if (isVideo) "שיחת וידאו נכנסת" else "שיחה קולית נכנסת"
                val caller = SosContactCache.displayName(appContext, author, "מישהו")
                val openUrl = SosCallUrls.acceptPage(callType)

                // גם כשהממשק פתוח – אם המסך כבוי/ברקע isHostAlive=false.
                // כשהממשק בחזית: Web מציג דיאלוג; לא מסמנים handled כאן כדי לא לחסום FSI אם עוברים לרקע בזמן צלצול | HYPER CORE TECH
                if (MainActivity.isHostAlive) {
                    Log.i(TAG, "host alive – web handles UI, raw offer cached")
                    SosDebugLog.i("relay", "call skip hostAlive from=redacted")
                    return
                }

                // מסמנים את ה-offer כדי שריליי/reconnect אחרי ניתוק לא יצלצלו שוב | HYPER CORE TECH
                SosIncomingCallSession.rememberHandledOffer(appContext, eventId)

                // מחממים WebView ברקע בזמן צלצול – ענה יהיה מהיר | HYPER CORE TECH
                SosDebugLog.i("relay", "incoming $callType from=redacted → notify+warm")
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
                Log.i(TAG, "incoming $callType from redacted")
            }
            "disconnect", "v-disconnect" -> {
                val offerId = SosPendingCallStore.extractEventId(appContext)
                SosIncomingCallSession.rememberHandledOffer(appContext, offerId)
                SosIncomingCallSession.markRemoteEnded(appContext, author)
                SosPendingCallStore.clear(appContext)
                NotificationHelper.cancelIncomingCall(appContext)
                CallSoundHelper.stopAll()
                IncomingCallActivity.dismiss(appContext, author)
                Log.i(TAG, "remote hangup from redacted")
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
        private const val CALL_KIND = 25050 // LEGACY_READ_ONLY
        private const val GIFT_WRAP_KIND = 1059
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

        fun clearSecureWarmInFlight() {
            instance?.secureWarmInFlight = false
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
