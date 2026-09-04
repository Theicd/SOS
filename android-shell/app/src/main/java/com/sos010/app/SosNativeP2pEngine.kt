package com.sos010.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SessionDescription
import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * P2P DataChannel Native ב-FGS – on-demand ל-peer בודד אחרי סגירת כרטיסייה.
 * סיגנלינג kind 25055 תואם ל-chat-p2p-datachannel.js.
 */
object SosNativeP2pEngine {
    private const val TAG = "SosNativeP2p"
    private const val SIG_KIND = 25055
    private const val DC_LABEL = "sos-chat"
    private const val KEEP_MS = 30_000L
    private const val RETRY_MS = 12_000L
    private const val IDLE_CLOSE_MS = 120_000L
    private const val HANDSHAKE_TIMEOUT_MS = 25_000L
    private const val OFFER_RATE_LIMIT_MS = 60_000L
    private const val MAX_PEERS = 1

    private val mainHandler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val started = AtomicBoolean(false)
    private val factoryReady = AtomicBoolean(false)

    @Volatile private var appRef: Context? = null
    @Volatile private var factory: PeerConnectionFactory? = null
    private val peers = ConcurrentHashMap<String, PeerState>()

    private data class PeerState(
        var pc: PeerConnection? = null,
        var dc: DataChannel? = null,
        var status: String = "idle",
        var offerId: String? = null,
        var lastOfferId: String? = null,
        var gotAnswer: Boolean = false,
        var offerRetryN: Int = 0,
        val remoteCands: MutableList<IceCandidate> = mutableListOf(),
        var keepRunnable: Runnable? = null,
        var retryRunnable: Runnable? = null,
        var idleRunnable: Runnable? = null,
        var handshakeRunnable: Runnable? = null,
        var lastActiveAt: Long = System.currentTimeMillis(),
        var lastPcAt: Long = 0L,
    )

    fun ensureStarted(context: Context) {
        appRef = context.applicationContext
        if (!SosSessionStore.isP2pStandbyEnabled(context)) return
        if (SosSessionStore.getPrivkey(context).length != 64) {
            Log.w(TAG, "no privkey – native P2P idle")
            SosDebugLog.w("p2p", "native idle – no privkey")
            return
        }
        if (!started.compareAndSet(false, true)) return
        worker.execute {
            try {
                initFactory(context.applicationContext)
                Log.i(TAG, "native P2P engine ready (on-demand)")
                SosDebugLog.i("p2p", "native engine ready")
            } catch (err: Exception) {
                Log.e(TAG, "init failed: ${err.message}", err)
                SosDebugLog.e("p2p", "native init failed: ${err.message}")
                started.set(false)
            }
        }
    }

    /** הממשק בחזית – לא סוגרים Native עד ש-WebView מוכן | HYPER CORE TECH */
    fun onUiActive() {
        SosP2pOwner.onUiForeground()
    }

    fun releaseForWebView() {
        if (!started.get() && peers.isEmpty()) return
        worker.execute { closeAll("webview-ready") }
    }

    fun onCardClosed(context: Context) {
        appRef = context.applicationContext
    }

    /** חיבור Native ל-peer אחד (initiator שולח offer) | HYPER CORE TECH */
    fun connectPeer(context: Context, peer: String) {
        if (!SosP2pOwner.nativeMayHandle()) return
        if (!SosP2pOwner.claim(peer, SosP2pOwnerKind.NATIVE)) return
        val pk = peer.trim().lowercase()
        if (!pk.matches(Regex("^[0-9a-f]{64}$"))) return
        appRef = context.applicationContext
        ensureStarted(context)
        worker.execute {
            try {
                if (!factoryReady.get()) initFactory(context.applicationContext)
                if (!factoryReady.get()) return@execute
                trimPeersIfNeeded(pk)
                connect(pk)
                SosDebugLog.i("p2p", "native connectPeer ${pk.take(8)}")
            } catch (err: Exception) {
                Log.w(TAG, "connectPeer fail: ${err.message}")
                SosDebugLog.w("p2p", "connectPeer fail: ${err.message}")
            }
        }
    }

    fun onHostForeground() = onUiActive()
    fun onHostBackground(context: Context) = onCardClosed(context)

    fun onMeshSignal(context: Context, payload: String) {
        if (!SosP2pOwner.nativeMayHandle()) return
        try {
            val o = JSONObject(payload)
            val from = o.optString("fromPubkey").trim().lowercase()
            val signal = o.optJSONObject("signal") ?: return
            val type = signal.optString("type")
            if (!type.startsWith("dc-") || from.length != 64) return
            val data = signal.opt("data")
            val event = JSONObject()
            when (data) {
                is JSONObject -> event.put("content", data.toString())
                is org.json.JSONArray -> event.put("content", data.toString())
                is String -> event.put("content", data)
                else -> if (signal.has("sdp")) event.put("content", signal.toString())
            }
            handlePlainSignal(context, from, type, event.optString("content"))
        } catch (e: Exception) {
            SosDebugLog.w("p2p", "mesh signal fail: ${e.message}")
        }
    }

    fun onSignalEvent(context: Context, author: String, signalType: String, event: JSONObject) {
        if (!SosP2pOwner.nativeMayHandle()) return
        if (!signalType.startsWith("dc-")) return
        appRef = context.applicationContext
        val priv = SosSessionStore.getPrivkey(context)
        if (priv.length != 64) {
            SosDebugLog.w("p2p", "signal drop – no privkey")
            return
        }
        ensureStarted(context)
        val pk = author.trim().lowercase()
        val enc = event.optString("content")
        val plain = if (enc.isBlank()) {
            SosDebugLog.w("p2p", "signal $signalType empty content from=${pk.take(8)}")
            null
        } else {
            SosNostrCrypto.nip04Decrypt(priv, pk, enc)
        }
        if (plain.isNullOrBlank() && enc.isNotBlank()) {
            SosDebugLog.w(
                "p2p",
                "nip04 decrypt fail type=$signalType from=${pk.take(8)} encLen=${enc.length}"
            )
        }
        handlePlainSignal(context, pk, signalType, plain)
    }

    private fun handlePlainSignal(context: Context, pk: String, signalType: String, plain: String?) {
        if (!SosP2pOwner.claim(pk, SosP2pOwnerKind.NATIVE)) return
        SosDebugLog.i("p2p", "[P2P-SIG] RX type=$signalType peer=${pk.take(8)} transport=NATIVE")
        worker.execute {
            try {
                if (!factoryReady.get()) initFactory(context.applicationContext)
                if (!factoryReady.get()) return@execute
                trimPeersIfNeeded(pk)
                when (signalType) {
                    "dc-offer" -> {
                        val data = if (plain.isNullOrBlank()) null else JSONObject(plain)
                        if (data != null) {
                            SosDebugLog.i("p2p", "native handle dc-offer from=${pk.take(8)}")
                            onOffer(pk, data)
                        }
                    }
                    "dc-answer" -> {
                        val data = if (plain.isNullOrBlank()) null else JSONObject(plain)
                        if (data != null) {
                            SosDebugLog.i("p2p", "native handle dc-answer from=${pk.take(8)}")
                            onAnswer(pk, data)
                        }
                    }
                    "dc-candidates" -> {
                        val arr = if (plain != null) JSONArray(plain) else JSONArray()
                        if (plain != null) {
                            SosDebugLog.i("p2p", "native handle dc-candidates from=${pk.take(8)} n=${arr.length()}")
                        }
                        onCandidates(pk, arr)
                    }
                }
                touch(pk)
            } catch (err: Exception) {
                Log.w(TAG, "signal handle fail: ${err.message}")
                SosDebugLog.w("p2p", "signal fail: ${err.message}")
            }
        }
    }

    private fun trimPeersIfNeeded(keep: String) {
        if (peers.size < MAX_PEERS) return
        val victims = peers.keys.filter { it != keep }.take(peers.size - MAX_PEERS + 1)
        victims.forEach { peer ->
            peers.remove(peer)?.let { cleanupPc(it) }
            Log.i(TAG, "trimmed peer ${peer.take(8)}")
        }
    }

    private fun touch(peer: String) {
        val st = peers[peer] ?: return
        st.lastActiveAt = System.currentTimeMillis()
        scheduleIdleClose(peer)
    }

    private fun scheduleIdleClose(peer: String) {
        val st = peers[peer] ?: return
        st.idleRunnable?.let { mainHandler.removeCallbacks(it) }
        val r = Runnable {
            val cur = peers[peer] ?: return@Runnable
            if (MainActivity.isActivityAlive) return@Runnable
            val idleFor = System.currentTimeMillis() - cur.lastActiveAt
            if (idleFor >= IDLE_CLOSE_MS) {
                Log.i(TAG, "idle close ${peer.take(8)}")
                SosDebugLog.i("p2p", "idle close ${peer.take(8)}")
                peers.remove(peer)?.let { cleanupPc(it) }
                maybeDisposeFactory()
            } else {
                scheduleIdleClose(peer)
            }
        }
        st.idleRunnable = r
        mainHandler.postDelayed(r, IDLE_CLOSE_MS)
    }

    /** אם אין DC OPEN תוך זמן קצר – משחררים PC כדי לא להרוג את תהליך ההתראות | HYPER CORE TECH */
    private fun scheduleHandshakeTimeout(peer: String) {
        val st = peers[peer] ?: return
        st.handshakeRunnable?.let { mainHandler.removeCallbacks(it) }
        val r = Runnable {
            val cur = peers[peer] ?: return@Runnable
            if (cur.dc?.state() == DataChannel.State.OPEN) return@Runnable
            Log.w(TAG, "handshake timeout ${peer.take(8)}")
            SosDebugLog.w("p2p", "handshake timeout ${peer.take(8)} – free PC keep alerts")
            peers.remove(peer)?.let { cleanupPc(it) }
            maybeDisposeFactory()
        }
        st.handshakeRunnable = r
        mainHandler.postDelayed(r, HANDSHAKE_TIMEOUT_MS)
    }

    private fun cancelHandshake(st: PeerState) {
        st.handshakeRunnable?.let { mainHandler.removeCallbacks(it) }
        st.handshakeRunnable = null
    }

    private fun maybeDisposeFactory() {
        if (peers.isNotEmpty()) return
        worker.execute {
            try {
                factory?.dispose()
            } catch (_: Exception) {
            }
            factory = null
            factoryReady.set(false)
            started.set(false)
            SosDebugLog.i("p2p", "native factory disposed")
        }
    }

    private fun amInitiator(self: String, peer: String): Boolean =
        SosP2pOwner.amInitiator(self, peer)

    private fun initFactory(context: Context) {
        if (factoryReady.get()) return
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
        )
        factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
        factoryReady.set(true)
    }

    private fun iceServers(): List<PeerConnection.IceServer> = listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
        PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer(),
        // TURN כמו ב-config.js – חיוני למובייל / מסך כבוי | HYPER CORE TECH
        PeerConnection.IceServer.builder("turn:openrelay.metered.ca:80")
            .setUsername("openrelayproject")
            .setPassword("openrelayproject")
            .createIceServer(),
        PeerConnection.IceServer.builder("turn:openrelay.metered.ca:443")
            .setUsername("openrelayproject")
            .setPassword("openrelayproject")
            .createIceServer(),
        PeerConnection.IceServer.builder("turns:openrelay.metered.ca:443")
            .setUsername("openrelayproject")
            .setPassword("openrelayproject")
            .createIceServer(),
    )

    private fun connect(peer: String) {
        if (!SosP2pOwner.nativeMayHandle()) return
        val app = appRef ?: return
        val self = SosSessionStore.getPubkey(app)
        if (!amInitiator(self, peer)) {
            peers.getOrPut(peer) { PeerState() }.status = "waiting"
            SosDebugLog.i("p2p", "connectPeer waiting (responder) ${peer.take(8)}")
            return
        }
        val st = peers.getOrPut(peer) { PeerState() }
        if (st.status == "connected" || st.status == "connecting") return
        val now = System.currentTimeMillis()
        if (now - st.lastPcAt < OFFER_RATE_LIMIT_MS && st.lastPcAt > 0L) {
            SosDebugLog.i("p2p", "rate-limit skip sendOffer ${peer.take(8)}")
            return
        }
        sendOffer(peer)
    }

    private fun sendOffer(peer: String) {
        val app = appRef ?: return
        val fac = factory ?: return
        val st = peers.getOrPut(peer) { PeerState() }
        cleanupPc(st)
        st.status = "connecting"
        st.gotAnswer = false
        st.lastPcAt = System.currentTimeMillis()
        st.offerId = "${System.currentTimeMillis()}-${UUID.randomUUID().toString().take(6)}"
        val pc = fac.createPeerConnection(PeerConnection.RTCConfiguration(iceServers()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }, observer(peer)) ?: return
        st.pc = pc
        val init = DataChannel.Init().apply { ordered = true }
        val dc = pc.createDataChannel(DC_LABEL, init)
        wireDc(peer, dc)
        scheduleHandshakeTimeout(peer)
        pc.createOffer(object : SdpAdapter() {
            override fun onCreateSuccess(desc: SessionDescription?) {
                if (desc == null) return
                pc.setLocalDescription(object : SdpAdapter() {}, desc)
                val payload = JSONObject()
                    .put("type", desc.type.canonicalForm())
                    .put("sdp", desc.description)
                    .put("oid", st.offerId)
                publishSig(peer, "dc-offer", payload.toString())
                scheduleRetry(peer)
                Log.i(TAG, "sent offer → ${peer.take(8)}")
                SosDebugLog.i("p2p", "sent offer → ${peer.take(8)}")
            }
        }, MediaConstraints())
    }

    private fun onOffer(peer: String, data: JSONObject) {
        val app = appRef ?: return
        val self = SosSessionStore.getPubkey(app)
        if (amInitiator(self, peer)) {
            SosDebugLog.i("p2p", "skip offer – we are initiator vs ${peer.take(8)}")
            return
        }
        val fac = factory ?: return
        val st = peers.getOrPut(peer) { PeerState() }
        if (st.status == "connected" && st.dc?.state() == DataChannel.State.OPEN) return
        val oid = data.optString("oid")
        if (oid.isNotBlank() && oid == st.lastOfferId) return
        val now = System.currentTimeMillis()
        // מונעים יצירת PC חדש כל כמה שניות (הורג את תהליך ההתראות) | HYPER CORE TECH
        if (st.pc != null && st.status == "connecting" && now - st.lastPcAt < OFFER_RATE_LIMIT_MS) {
            SosDebugLog.i("p2p", "rate-limit skip offer ${peer.take(8)}")
            return
        }
        st.lastOfferId = oid
        cleanupPc(st)
        st.status = "connecting"
        st.lastPcAt = now
        val pc = fac.createPeerConnection(PeerConnection.RTCConfiguration(iceServers()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }, observer(peer)) ?: return
        st.pc = pc
        scheduleHandshakeTimeout(peer)
        val remote = SessionDescription(
            SessionDescription.Type.fromCanonicalForm(data.optString("type")),
            data.optString("sdp")
        )
        pc.setRemoteDescription(object : SdpAdapter() {
            override fun onSetSuccess() {
                flushRemoteCands(peer)
                pc.createAnswer(object : SdpAdapter() {
                    override fun onCreateSuccess(desc: SessionDescription?) {
                        if (desc == null) return
                        pc.setLocalDescription(object : SdpAdapter() {}, desc)
                        val payload = JSONObject()
                            .put("type", desc.type.canonicalForm())
                            .put("sdp", desc.description)
                            .put("oid", oid)
                        publishSig(peer, "dc-answer", payload.toString())
                        Log.i(TAG, "answered offer ← ${peer.take(8)}")
                        SosDebugLog.i("p2p", "answered offer ← ${peer.take(8)}")
                    }
                }, MediaConstraints())
            }
        }, remote)
    }

    private fun onAnswer(peer: String, data: JSONObject) {
        val app = appRef ?: return
        val self = SosSessionStore.getPubkey(app)
        if (!amInitiator(self, peer)) return
        val st = peers[peer] ?: return
        val pc = st.pc ?: return
        val oid = data.optString("oid")
        if (!st.offerId.isNullOrBlank() && oid.isNotBlank() && oid != st.offerId) return
        st.gotAnswer = true
        cancelRetry(st)
        val remote = SessionDescription(
            SessionDescription.Type.fromCanonicalForm(data.optString("type")),
            data.optString("sdp")
        )
        pc.setRemoteDescription(object : SdpAdapter() {
            override fun onSetSuccess() { flushRemoteCands(peer) }
        }, remote)
        Log.i(TAG, "got answer ← ${peer.take(8)}")
    }

    private fun onCandidates(peer: String, arr: JSONArray) {
        val st = peers.getOrPut(peer) { PeerState() }
        val pc = st.pc
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val cand = IceCandidate(
                o.optString("sdpMid"),
                o.optInt("sdpMLineIndex"),
                o.optString("candidate")
            )
            if (pc?.remoteDescription == null) st.remoteCands.add(cand)
            else runCatching { pc.addIceCandidate(cand) }
        }
    }

    private fun flushRemoteCands(peer: String) {
        val st = peers[peer] ?: return
        val pc = st.pc ?: return
        val buf = st.remoteCands.toList()
        st.remoteCands.clear()
        buf.forEach { runCatching { pc.addIceCandidate(it) } }
    }

    private fun observer(peer: String) = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
            if (state == PeerConnection.IceConnectionState.FAILED ||
                state == PeerConnection.IceConnectionState.DISCONNECTED ||
                state == PeerConnection.IceConnectionState.CLOSED
            ) {
                peers[peer]?.let { cleanupPc(it); it.status = "closed" }
                // לא מתחברים מחדש אוטומטית – הסיגנל הבא / warmForPeer ידליק שוב | HYPER CORE TECH
            }
        }
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
        override fun onIceCandidate(candidate: IceCandidate?) {
            if (candidate == null) {
                publishSig(peer, "dc-candidates", "[]")
                return
            }
            val arr = JSONArray().put(
                JSONObject()
                    .put("candidate", candidate.sdp)
                    .put("sdpMid", candidate.sdpMid)
                    .put("sdpMLineIndex", candidate.sdpMLineIndex)
            )
            publishSig(peer, "dc-candidates", arr.toString())
        }
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
        override fun onAddStream(stream: org.webrtc.MediaStream?) {}
        override fun onRemoveStream(stream: org.webrtc.MediaStream?) {}
        override fun onDataChannel(dc: DataChannel?) {
            if (dc == null) return
            val app = appRef
            if (dc.label() == SosNativeFileTransfer.label() && app != null) {
                SosNativeFileTransfer.wire(app, peer, dc)
            } else {
                wireDc(peer, dc)
            }
        }
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: org.webrtc.RtpReceiver?, mediaStreams: Array<out org.webrtc.MediaStream>?) {}
    }

    private fun wireDc(peer: String, dc: DataChannel?) {
        if (dc == null) return
        val st = peers.getOrPut(peer) { PeerState() }
        st.dc = dc
        dc.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}
            override fun onStateChange() {
                if (dc.state() == DataChannel.State.OPEN) {
                    st.status = "connected"
                    st.offerRetryN = 0
                    cancelRetry(st)
                    cancelHandshake(st)
                    startKeep(peer)
                    touch(peer)
                    Log.i(TAG, "DC OPEN ${peer.take(8)}")
                    SosDebugLog.i("p2p", "DC OPEN ${peer.take(8)}")
                } else if (dc.state() == DataChannel.State.CLOSED) {
                    st.status = "closed"
                    stopKeep(st)
                    Log.i(TAG, "DC CLOSED ${peer.take(8)}")
                    SosDebugLog.i("p2p", "DC CLOSED ${peer.take(8)}")
                }
            }
            override fun onMessage(buffer: DataChannel.Buffer?) {
                if (buffer == null) return
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                val raw = String(bytes, Charset.forName("UTF-8"))
                try {
                    val m = JSONObject(raw)
                    when (m.optString("type")) {
                        "ping" -> {
                            touch(peer)
                            sendRaw(peer, JSONObject().put("type", "pong").put("ts", System.currentTimeMillis()).toString())
                        }
                        "pong" -> touch(peer)
                        "chat-text" -> {
                            touch(peer)
                            Log.i(TAG, "P2P chat ← ${peer.take(8)}")
                            val app = appRef
                            if (!MainActivity.isHostAlive && app != null) {
                                val preview = m.optString("content").trim().ifBlank {
                                    if (m.optJSONObject("attachment") != null) "קובץ מצורף" else "הודעה חדשה"
                                }.take(120)
                                val eventId = m.optString("id").ifBlank { "p2p-${System.currentTimeMillis()}" }
                                NotificationHelper.showMessage(
                                    app,
                                    SosContactCache.displayName(app, peer, "משתמש"),
                                    preview,
                                    "https://sos010.com/videos.html?chat=$peer",
                                    "chat-$peer",
                                    eventId = eventId,
                                    peerKey = peer,
                                    pictureUrl = SosContactCache.get(app, peer)?.picture
                                )
                            }
                        }
                    }
                } catch (_: Exception) {
                }
            }
        })
    }

    private fun startKeep(peer: String) {
        val st = peers[peer] ?: return
        stopKeep(st)
        val r = object : Runnable {
            override fun run() {
                val cur = peers[peer] ?: return
                if (cur.dc?.state() == DataChannel.State.OPEN) {
                    sendRaw(peer, JSONObject().put("type", "ping").put("ts", System.currentTimeMillis()).toString())
                    mainHandler.postDelayed(this, KEEP_MS)
                }
            }
        }
        st.keepRunnable = r
        mainHandler.postDelayed(r, KEEP_MS)
    }

    private fun stopKeep(st: PeerState) {
        st.keepRunnable?.let { mainHandler.removeCallbacks(it) }
        st.keepRunnable = null
    }

    private fun scheduleRetry(peer: String) {
        val st = peers[peer] ?: return
        cancelRetry(st)
        val r = Runnable {
            val cur = peers[peer] ?: return@Runnable
            if (cur.status == "connected" || cur.gotAnswer) return@Runnable
            cur.offerRetryN += 1
            if (cur.offerRetryN >= 3) {
                Log.w(TAG, "gave up ${peer.take(8)}")
                SosDebugLog.w("p2p", "gave up offer retries ${peer.take(8)}")
                cur.status = "idle"
                peers.remove(peer)?.let { cleanupPc(it) }
                maybeDisposeFactory()
                return@Runnable
            }
            sendOffer(peer)
        }
        st.retryRunnable = r
        mainHandler.postDelayed(r, RETRY_MS)
    }

    private fun cancelRetry(st: PeerState) {
        st.retryRunnable?.let { mainHandler.removeCallbacks(it) }
        st.retryRunnable = null
    }

    private fun sendRaw(peer: String, text: String) {
        val dc = peers[peer]?.dc ?: return
        if (dc.state() != DataChannel.State.OPEN) return
        val buf = ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8))
        dc.send(DataChannel.Buffer(buf, false))
    }

    private fun publishSig(peer: String, type: String, rawJson: String) {
        val app = appRef ?: return
        val priv = SosSessionStore.getPrivkey(app)
        val self = SosSessionStore.getPubkey(app)
        if (self.length != 64) return
        if (tryPublishMesh(self, peer, type, rawJson)) return
        if (priv.length != 64) return
        worker.execute {
            try {
                val enc = if (rawJson.isBlank()) "" else SosNostrCrypto.nip04Encrypt(priv, peer, rawJson)
                val tags = JSONArray()
                    .put(JSONArray().put("type").put(type))
                    .put(JSONArray().put("p").put(peer.lowercase()))
                    .put(JSONArray().put("r").put(roomId(self, peer)))
                val event = SosNostrCrypto.signEvent(priv, SIG_KIND, tags, enc)
                SosRelayWatcher.publishEvent(app, event)
                SosDebugLog.i("p2p", "[P2P-SIG] SEND type=$type peer=${peer.take(8)} transport=NOSTR")
            } catch (err: Exception) {
                Log.w(TAG, "publishSig fail: ${err.message}")
            }
        }
    }

    private fun tryPublishMesh(self: String, peer: String, type: String, rawJson: String): Boolean {
        if (!SosEmergencyState.isRelayRunning) return false
        val live = SosEmergencyRelayService.instance?.liveNodeIds() ?: emptySet()
        if (!EmergencyMeshSignal.isMeshSignalTarget(peer, SosEmergencyState.mesh, live)) return false
        val data: Any = when {
            rawJson.isBlank() -> JSONObject()
            rawJson.trim().startsWith("[") -> JSONArray(rawJson)
            else -> JSONObject(rawJson)
        }
        val signal = JSONObject()
            .put("type", type)
            .put("data", data)
            .put("fromPubkey", self)
        val wrapped = EmergencyMeshSignal.wrap(peer, signal.toString(), self, "") ?: return false
        val route = EmergencyMeshSignal.routeTarget(peer, SosEmergencyState.mesh) ?: return false
        val svc = SosEmergencyRelayService.instance ?: return false
        val mid = svc.originatePayload(wrapped, route.first, route.second)
        if (mid.isBlank()) return false
        SosDebugLog.i("p2p", "[P2P-SIG] SEND type=$type peer=${peer.take(8)} transport=MESH")
        return true
    }

    private fun roomId(a: String, b: String): String {
        val x = a.lowercase(); val y = b.lowercase()
        return if (x < y) "dc:$x:$y" else "dc:$y:$x"
    }

    private fun cleanupPc(st: PeerState) {
        stopKeep(st)
        cancelRetry(st)
        cancelHandshake(st)
        st.idleRunnable?.let { mainHandler.removeCallbacks(it) }
        st.idleRunnable = null
        try { st.dc?.close() } catch (_: Exception) {}
        try { st.pc?.close() } catch (_: Exception) {}
        st.dc = null
        st.pc = null
        st.remoteCands.clear()
    }

    private fun closeAll(reason: String) {
        Log.i(TAG, "closeAll ($reason)")
        SosDebugLog.i("p2p", "closeAll ($reason)")
        peers.keys.toList().forEach { k ->
            peers.remove(k)?.let { cleanupPc(it) }
        }
        maybeDisposeFactory()
    }

    private open class SdpAdapter : org.webrtc.SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription?) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) { Log.w(TAG, "sdp create fail: $error") }
        override fun onSetFailure(error: String?) { Log.w(TAG, "sdp set fail: $error") }
    }
}
