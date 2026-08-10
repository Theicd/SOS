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
 * P2P DataChannel Native בתוך תהליך ה-FGS – נשאר חי גם אחרי סגירת כרטיסיית האפליקציה.
 * סיגנלינג kind 25055 תואם ל-chat-p2p-datachannel.js.
 */
object SosNativeP2pEngine {
    private const val TAG = "SosNativeP2p"
    private const val SIG_KIND = 25055
    private const val DC_LABEL = "sos-chat"
    private const val KEEP_MS = 30_000L
    private const val RETRY_MS = 12_000L

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
    )

    fun ensureStarted(context: Context) {
        appRef = context.applicationContext
        if (!SosSessionStore.isP2pStandbyEnabled(context)) return
        if (SosSessionStore.getPrivkey(context).length != 64) {
            Log.w(TAG, "no privkey – native P2P idle")
            return
        }
        if (!started.compareAndSet(false, true)) {
            if (!MainActivity.isActivityAlive) reconnectPreferred()
            return
        }
        worker.execute {
            try {
                initFactory(context.applicationContext)
                Log.i(TAG, "native P2P engine ready")
                if (!MainActivity.isActivityAlive) reconnectPreferred()
            } catch (err: Exception) {
                Log.e(TAG, "init failed: ${err.message}", err)
                started.set(false)
            }
        }
    }

    /** הממשק חזר – משחררים Native | HYPER CORE TECH */
    fun onUiActive() {
        worker.execute { closeAll("ui-active") }
    }

    /** כרטיסייה נסגרה – Native מנהל P2P | HYPER CORE TECH */
    fun onCardClosed(context: Context) {
        appRef = context.applicationContext
        if (MainActivity.isActivityAlive) return
        ensureStarted(context)
        mainHandler.postDelayed({
            if (!MainActivity.isActivityAlive) reconnectPreferred()
        }, 600L)
    }

    /** תאימות לשם ישן */
    fun onHostForeground() = onUiActive()
    fun onHostBackground(context: Context) = onCardClosed(context)

    fun onSignalEvent(author: String, signalType: String, event: JSONObject) {
        if (MainActivity.isActivityAlive) return
        if (!signalType.startsWith("dc-")) return
        val app = appRef ?: return
        val priv = SosSessionStore.getPrivkey(app)
        if (priv.length != 64) return
        ensureStarted(app)
        worker.execute {
            try {
                val enc = event.optString("content")
                val plain = if (enc.isBlank()) null else SosNostrCrypto.nip04Decrypt(priv, author, enc)
                val data = if (plain.isNullOrBlank()) null else JSONObject(plain)
                when (signalType) {
                    "dc-offer" -> if (data != null) onOffer(author, data)
                    "dc-answer" -> if (data != null) onAnswer(author, data)
                    "dc-candidates" -> {
                        val arr = if (plain != null) JSONArray(plain) else JSONArray()
                        onCandidates(author, arr)
                    }
                }
            } catch (err: Exception) {
                Log.w(TAG, "signal handle fail: ${err.message}")
            }
        }
    }

    private fun reconnectPreferred() {
        val app = appRef ?: return
        if (MainActivity.isActivityAlive) return
        val self = SosSessionStore.getPubkey(app)
        val priv = SosSessionStore.getPrivkey(app)
        if (self.length != 64 || priv.length != 64) return
        SosSessionStore.getP2pPeers(app).forEach { peer ->
            if (amInitiator(self, peer)) connect(peer)
            else {
                peers.getOrPut(peer) { PeerState() }.status = "waiting"
            }
        }
    }

    private fun amInitiator(self: String, peer: String): Boolean =
        self.lowercase() < peer.lowercase()

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
    )

    private fun connect(peer: String) {
        if (MainActivity.isActivityAlive) return
        val app = appRef ?: return
        val self = SosSessionStore.getPubkey(app)
        if (!amInitiator(self, peer)) {
            peers.getOrPut(peer) { PeerState() }.status = "waiting"
            return
        }
        val st = peers.getOrPut(peer) { PeerState() }
        if (st.status == "connected" || st.status == "connecting") return
        sendOffer(peer)
    }

    private fun sendOffer(peer: String) {
        val app = appRef ?: return
        val fac = factory ?: return
        val st = peers.getOrPut(peer) { PeerState() }
        cleanupPc(st)
        st.status = "connecting"
        st.gotAnswer = false
        st.offerId = "${System.currentTimeMillis()}-${UUID.randomUUID().toString().take(6)}"
        val pc = fac.createPeerConnection(PeerConnection.RTCConfiguration(iceServers()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }, observer(peer)) ?: return
        st.pc = pc
        val init = DataChannel.Init().apply { ordered = true }
        val dc = pc.createDataChannel(DC_LABEL, init)
        wireDc(peer, dc)
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
            }
        }, MediaConstraints())
    }

    private fun onOffer(peer: String, data: JSONObject) {
        val app = appRef ?: return
        val self = SosSessionStore.getPubkey(app)
        if (amInitiator(self, peer)) return
        val fac = factory ?: return
        val st = peers.getOrPut(peer) { PeerState() }
        if (st.status == "connected" && st.dc?.state() == DataChannel.State.OPEN) return
        val oid = data.optString("oid")
        if (oid.isNotBlank() && oid == st.lastOfferId) return
        st.lastOfferId = oid
        cleanupPc(st)
        st.status = "connecting"
        val pc = fac.createPeerConnection(PeerConnection.RTCConfiguration(iceServers()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }, observer(peer)) ?: return
        st.pc = pc
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
        val st = peers[peer] ?: return
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
                if (!MainActivity.isActivityAlive) {
                    mainHandler.postDelayed({ connect(peer) }, 5000L)
                }
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
                    startKeep(peer)
                    Log.i(TAG, "DC OPEN ${peer.take(8)}")
                } else if (dc.state() == DataChannel.State.CLOSED) {
                    st.status = "closed"
                    stopKeep(st)
                    Log.i(TAG, "DC CLOSED ${peer.take(8)}")
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
                        "ping" -> sendRaw(peer, JSONObject().put("type", "pong").put("ts", System.currentTimeMillis()).toString())
                        "pong" -> {}
                        "chat-text" -> {
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
            if (cur.offerRetryN >= 12) {
                Log.w(TAG, "gave up ${peer.take(8)}")
                cur.status = "idle"
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
        if (priv.length != 64 || self.length != 64) return
        worker.execute {
            try {
                val enc = if (rawJson.isBlank()) "" else SosNostrCrypto.nip04Encrypt(priv, peer, rawJson)
                val tags = JSONArray()
                    .put(JSONArray().put("type").put(type))
                    .put(JSONArray().put("p").put(peer.lowercase()))
                    .put(JSONArray().put("r").put(roomId(self, peer)))
                val event = SosNostrCrypto.signEvent(priv, SIG_KIND, tags, enc)
                SosRelayWatcher.publishEvent(app, event)
            } catch (err: Exception) {
                Log.w(TAG, "publishSig fail: ${err.message}")
            }
        }
    }

    private fun roomId(a: String, b: String): String {
        val x = a.lowercase(); val y = b.lowercase()
        return if (x < y) "dc:$x:$y" else "dc:$y:$x"
    }

    private fun cleanupPc(st: PeerState) {
        stopKeep(st)
        cancelRetry(st)
        try { st.dc?.close() } catch (_: Exception) {}
        try { st.pc?.close() } catch (_: Exception) {}
        st.dc = null
        st.pc = null
        st.remoteCands.clear()
    }

    private fun closeAll(reason: String) {
        Log.i(TAG, "closeAll ($reason)")
        peers.keys.toList().forEach { k ->
            peers[k]?.let { cleanupPc(it); it.status = "idle" }
        }
    }

    private open class SdpAdapter : org.webrtc.SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription?) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) { Log.w(TAG, "sdp create fail: $error") }
        override fun onSetFailure(error: String?) { Log.w(TAG, "sdp set fail: $error") }
    }
}
