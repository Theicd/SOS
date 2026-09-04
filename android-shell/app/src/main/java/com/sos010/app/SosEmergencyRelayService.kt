package com.sos010.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.PrintWriter
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * ממסר רשת חירום מקומית: UDP discovery + עץ אב/ילדים + ריליי MSG | HYPER CORE TECH
 * מבוסס על SOS-Relay-Android (SOSBackgroundService + MainActivity.handleMessage).
 */
class SosEmergencyRelayService : Service() {

    companion object {
        private const val TAG = "SosEmergencyRelay"
        private const val CHANNEL_ID = "sos_emergency_relay"
        private const val NOTIFICATION_ID = 4101

        @Volatile
        var instance: SosEmergencyRelayService? = null
            private set

        fun start(context: Context) {
            val intent = Intent(context, SosEmergencyRelayService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** כיבוי ממסר חירום — משחרר FGS שני כדי לא להפריע למעטפת הרגילה | HYPER CORE TECH */
        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, SosEmergencyRelayService::class.java))
            } catch (_: Exception) {
            }
            SosEmergencyState.isRelayRunning = false
            instance = null
        }
    }

    private val executor = Executors.newCachedThreadPool()
    private val handler = Handler(Looper.getMainLooper())
    private var serverSocket: ServerSocket? = null
    private var discoverySocket: DatagramSocket? = null
    @Volatile private var isListening = false

    private val myChildren = CopyOnWriteArrayList<String>()
    private val mySiblings = CopyOnWriteArrayList<String>()
    private var parentIp: String? = null
    private var parentSocket: Socket? = null
    private var parentWriter: PrintWriter? = null
    private val childWriters = ConcurrentHashMap<String, PrintWriter>()
    private val meshLinks = EmergencyMeshLinkTable()
    private val connectedPeers = CopyOnWriteArrayList<String>()
    private val helloSeen = ConcurrentHashMap<String, Long>()
    @Volatile private var lastSentIdentityVersion: Int = -1

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        startForeground(NOTIFICATION_ID, buildNotification("ממסר חירום מתחיל..."))
        startListening()
        SosDebugLog.i("emergency", "relay service created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!isListening) startListening()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        isListening = false
        SosEmergencyState.isRelayRunning = false
        try { serverSocket?.close() } catch (_: Exception) {}
        try { discoverySocket?.close() } catch (_: Exception) {}
        try { parentSocket?.close() } catch (_: Exception) {}
        meshLinks.closeAll()
        instance = null
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val ch = NotificationChannel(
            CHANNEL_ID,
            "SOS ממסר חירום",
            NotificationManager.IMPORTANCE_LOW
        ).apply { description = "רשת מקומית במצב חירום" }
        nm.createNotificationChannel(ch)
    }

    private fun buildNotification(text: String): Notification {
        val open = Intent(this, SosEmergencyActivity::class.java)
        val pi = PendingIntent.getActivity(
            this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("SOS מצב חירום")
            .setContentText(text)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun startListening() {
        if (isListening) return
        isListening = true

        resetTree("start")
        ensureMeshIdentity()

        sendLog("INFO", "מתחיל שירות ממסר (מצב מאופס)...")

        executor.execute {
            try {
                serverSocket = ServerSocket(SosEmergencyState.SERVER_PORT)
                SosEmergencyState.isRelayRunning = true
                broadcastStatus("ממסר פעיל ✓")
                sendLog("TCP", "שרת TCP על פורט ${SosEmergencyState.SERVER_PORT}")
                while (isListening) {
                    try {
                        val client = serverSocket!!.accept()
                        handleClient(client)
                    } catch (e: Exception) {
                        if (isListening) sendLog("ERROR", "Accept: ${e.message}")
                    }
                }
            } catch (e: Exception) {
                sendLog("ERROR", "TCP: ${e.message}")
                broadcastStatus("שגיאה: ${e.message}")
            }
        }

        executor.execute {
            try {
                discoverySocket = DatagramSocket(null).apply {
                    reuseAddress = true
                    bind(InetSocketAddress(SosEmergencyState.DISCOVERY_PORT))
                    broadcast = true
                }
                sendLog("UDP", "UDP Discovery על פורט ${SosEmergencyState.DISCOVERY_PORT}")
                val buffer = ByteArray(4096)
                while (isListening) {
                    try {
                        val packet = DatagramPacket(buffer, buffer.size)
                        discoverySocket?.receive(packet)
                        handleDiscoveryPacket(packet)
                    } catch (e: Exception) {
                        if (isListening) sendLog("ERROR", "UDP: ${e.message}")
                    }
                }
            } catch (e: Exception) {
                sendLog("ERROR", "UDP bind: ${e.message}")
            }
        }

        executor.execute {
            Thread.sleep(1000)
            while (isListening) {
                try {
                    announcePresence()
                    Thread.sleep(5000)
                } catch (_: Exception) {}
            }
        }

        executor.execute {
            Thread.sleep(3000)
            while (isListening) {
                try {
                    checkParentConnection()
                    Thread.sleep(10000)
                } catch (_: Exception) {}
            }
        }
    }

    private fun resetTree(reason: String) {
        sendLog("TREE", "איפוס עץ: $reason")
        try { parentSocket?.close() } catch (_: Exception) {}
        parentIp = null
        parentSocket = null
        parentWriter = null
        SosEmergencyState.sharedParentIp = null
        myChildren.clear()
        mySiblings.clear()
        connectedPeers.clear()
        SosEmergencyState.sharedPeers.clear()
        SosEmergencyState.peerProfiles.clear()
        childWriters.clear()
        meshLinks.closeAll()
        helloSeen.clear()
        SosEmergencyState.meshSeen.clear()
        SosEmergencyState.meshDelivery.clear()
        SosEmergencyState.childCount = 0
        SosEmergencyState.relayChildIps.clear()
        SosEmergencyState.hiddenChildSsids.clear()
        lastSentIdentityVersion = -1
        val boot = SosEmergencyState.meshBootId.ifBlank { EmergencyMeshIdentity.newBootId() }
        SosEmergencyState.meshBootId = boot
        SosEmergencyState.mesh.reset(boot)
    }

    private fun ensureMeshIdentity() {
        if (SosEmergencyState.meshBootId.isBlank()) {
            SosEmergencyState.meshBootId = EmergencyMeshIdentity.newBootId()
        }
        val id = SosEmergencySetup.currentIdentity(this, SosEmergencyState.meshBootId)
        SosEmergencyState.mesh.applyIdentity(id)
    }

    private fun meshStaAp(): CapabilityState {
        return SosWifiBootstrap.snapshotCapabilities(this).staApConcurrency
    }

    private fun dropParent(reason: String) {
        sendLog("TREE", "ניתוק הורה: $reason")
        try { parentSocket?.close() } catch (_: Exception) {}
        parentIp = null
        parentSocket = null
        parentWriter = null
        SosEmergencyState.sharedParentIp = null
        meshLinks.parent()?.close()
        SosEmergencyState.mesh.parentNodeId()?.let { SosEmergencyState.mesh.removeLink(it) }
        SosEmergencyState.mesh.clearJoin()
    }

    private fun attachMeshLink(
        nodeId: String,
        bootId: String,
        relation: MeshPeerRelation,
        ip: String,
        writer: PrintWriter,
        socket: Socket
    ): EmergencyMeshLink {
        val link = EmergencyMeshLink(
            remoteNodeId = nodeId,
            remoteBootId = bootId,
            relation = relation,
            currentIp = ip,
            writer = writer,
            socket = socket,
            onClosed = { meshLinks.detachIfCurrent(it) }
        )
        return meshLinks.attach(link)
    }

    private fun sendOnDirectOrFallback(ip: String, message: String) {
        val nodeId = SosEmergencyState.mesh.findByIp(ip)?.nodeId
        val link = meshLinks.findLive(ip, nodeId)
        if (link != null && link.send(message)) return
        sendRawFallback(ip, message)
    }

    private fun identityJson(): String {
        val o = JSONObject()
        o.put("ip", SosEmergencyState.myIp ?: getLocalIpAddressInternal() ?: "")
        o.put("pubkey", SosSessionStore.getPubkey(this))
        o.put("name", SosEmergencyState.myDisplayName)
        o.put("picture", SosEmergencyState.myPicture)
        return o.toString()
    }

    fun pushIdentity() {
        val line = "HELLO:${identityJson()}"
        meshLinks.live().forEach { it.send(line) }
    }

    private fun applyHello(json: String, fallbackIp: String): Boolean {
        return try {
            val o = JSONObject(json)
            val ip = o.optString("ip", fallbackIp).ifBlank { fallbackIp }
            val pubkey = o.optString("pubkey", "")
            val name = o.optString("name", "")
            val picture = o.optString("picture", "")
            if (ip.isBlank()) return false
            val key = "$ip|$pubkey"
            val now = System.currentTimeMillis()
            val prev = helloSeen[key]
            if (prev != null && now - prev < 8000) return false
            helloSeen[key] = now
            SosEmergencyState.upsertPeer(ip, pubkey, name, picture)
            addPeer(ip)
            val ssid = SosEmergencySetup.ssidFromPubkey(pubkey)
            if (ssid != null && (
                    myChildren.contains(ip) ||
                    myChildren.contains(fallbackIp) ||
                    SosWifiBootstrap.isClientOnMyHotspot(ip) ||
                    SosWifiBootstrap.isClientOnMyHotspot(fallbackIp)
                )
            ) {
                SosEmergencyState.rememberDownstreamSsid(ssid)
                sendLog("SCAN", "מסתיר $ssid אחרי HELLO")
            }
            sendLog("HELLO", "$ip ${name.ifBlank { pubkey.take(8) }}")
            broadcastPeerUpdate()
            true
        } catch (e: Exception) {
            sendLog("ERROR", "hello: ${e.message}")
            false
        }
    }

    private fun relayHello(fromIp: String, line: String) {
        meshLinks.live().forEach { link ->
            if (link.currentIp != fromIp) link.send(line)
        }
    }

    private fun handleDiscoveryPacket(packet: DatagramPacket) {
        val message = String(packet.data, 0, packet.length)
        val senderIp = packet.address.hostAddress ?: return
        val myIp = getLocalIpAddressInternal()
        if (senderIp == myIp) return

        val v2 = EmergencyMeshProtocol.parse(message)
        if (v2 != null && v2.type == EmergencyMeshProtocol.DISCOVERY) {
            onV2Discovery(v2, senderIp, myIp)
            return
        }
        if (EmergencyMeshProtocol.parseV1Here(message) != null) {
            sendLog("UDP", "V1 SOS_HERE מ-$senderIp — לא מצטרפים (לא תואם V2)")
            return
        }
        if (message.trim() == "SOS_DISCOVER") announcePresence()
    }

    private fun onV2Discovery(frame: EmergencyMeshProtocol.Frame, senderIp: String, myIp: String?) {
        if (frame.nodeId.isBlank()) return
        val self = SosEmergencyState.mesh.identity ?: return
        if (frame.nodeId == self.nodeId) return
        val relayIp = frame.ip.ifBlank { senderIp }
        sendLog("DISCOVERY", "node=${frame.nodeId.take(8)} ip=$relayIp kids=${frame.childCount}")

        if (!isSameSubnet(myIp, relayIp) && !isSameSubnet(myIp, senderIp)) {
            if (parentIp != null && !isSameSubnet(myIp, parentIp)) {
                dropParent("parent-foreign-lan")
            }
            return
        }

        val now = System.currentTimeMillis()
        SosEmergencyState.mesh.expireStale(now)
        SosEmergencyState.mesh.upsertDiscovery(
            MeshPeerRecord(
                nodeId = frame.nodeId,
                pubkey = frame.pubkey,
                bootId = frame.bootId,
                ssid = frame.ssid,
                currentIp = relayIp,
                rootNodeId = frame.rootNodeId,
                depth = frame.depth,
                childCount = frame.childCount,
                maxChildren = frame.maxChildren,
                staAp = frame.staAp,
                name = frame.name
            ),
            now
        )
        if (frame.pubkey.length == 64) {
            SosEmergencyState.upsertPeer(relayIp, frame.pubkey, frame.name)
            SosEmergencySetup.ssidFromPubkey(frame.pubkey)?.let { ssid ->
                SosEmergencyState.discoveryBySsid[ssid] = SosEmergencyState.SosDiscoveryEntry(
                    ssid = ssid,
                    ip = relayIp,
                    childCount = frame.childCount,
                    maxChildren = frame.maxChildren,
                    lastSeenMs = now
                )
            }
        }

        val onMyAp = SosWifiBootstrap.isClientOnMyHotspot(relayIp) ||
            SosWifiBootstrap.isClientOnMyHotspot(senderIp)
        if (onMyAp || SosEmergencyState.mesh.childNodeIds().contains(frame.nodeId)) {
            frame.ssid.takeIf { it.isNotBlank() }?.let { SosEmergencyState.rememberDownstreamSsid(it) }
            addPeer(relayIp)
            return
        }
        if (parentIp != null && !isSameSubnet(myIp, parentIp)) {
            dropParent("parent-left-subnet")
        }
        maybeJoinBestParent()
    }

    private fun maybeJoinBestParent() {
        val mesh = SosEmergencyState.mesh
        val self = mesh.identity ?: return
        val staAp = meshStaAp()
        val candidates = mesh.allPeers()
            .filter { EmergencyMeshDecision.isDiscoveryFresh(it.lastSeenMs, System.currentTimeMillis()) }
            .map {
                MeshParentCandidate(
                    nodeId = it.nodeId,
                    relation = it.relation,
                    childCount = it.childCount,
                    maxChildren = it.maxChildren,
                    depth = it.depth,
                    signalDbm = it.signalDbm,
                    staAp = it.staAp,
                    inExistingTree = it.childCount > 0 || it.rootNodeId.isNotBlank()
                )
            }
        val pick = EmergencyMeshDecision.pickBestParent(
            selfId = self.nodeId,
            childIds = mesh.childNodeIds(),
            descendantIds = mesh.descendantIds(),
            parentId = mesh.parentNodeId(),
            hasChildren = mesh.childNodeIds().isNotEmpty(),
            staAp = staAp,
            candidates = candidates
        ) ?: return
        val ip = mesh.get(pick.nodeId)?.currentIp.orEmpty()
        if (ip.isBlank()) return
        joinParent(pick.nodeId, ip)
    }

    private fun announcePresence() {
        try {
            ensureMeshIdentity()
            val myIp = getLocalIpAddressInternal() ?: return
            val prev = SosEmergencyState.myIp
            if (prev != null && prev != myIp) {
                resetTree("ip-changed $prev -> $myIp")
                ensureMeshIdentity()
            }
            SosEmergencyState.myIp = myIp
            val mesh = SosEmergencyState.mesh
            val identity = mesh.identity ?: return
            val name = SosEmergencyState.myDisplayName.replace(":", " ").take(40)
            val msg = EmergencyMeshProtocol.discovery(
                identity = identity,
                ip = myIp,
                rootNodeId = mesh.rootNodeId,
                depth = mesh.depth,
                childCount = mesh.childNodeIds().size,
                staAp = meshStaAp(),
                name = name
            )
            identity.stationSsid.takeIf { it.isNotBlank() }?.let { ssid ->
                SosEmergencyState.discoveryBySsid[ssid] = SosEmergencyState.SosDiscoveryEntry(
                    ssid = ssid,
                    ip = myIp,
                    childCount = mesh.childNodeIds().size,
                    maxChildren = SosEmergencyState.MAX_CHILDREN,
                    lastSeenMs = System.currentTimeMillis()
                )
            }
            val data = msg.toByteArray()
            val addr = getBroadcastAddressFromIp(myIp)
            DatagramSocket().use { socket ->
                socket.broadcast = true
                socket.send(
                    DatagramPacket(
                        data, data.size,
                        InetAddress.getByName(addr),
                        SosEmergencyState.DISCOVERY_PORT
                    )
                )
            }
            sendLog("UDP", "שלחתי DISCOVERY → $addr")
            if (SosEmergencyState.identityVersion != lastSentIdentityVersion) {
                lastSentIdentityVersion = SosEmergencyState.identityVersion
                pushIdentity()
            }
        } catch (e: Exception) {
            sendLog("ERROR", "announce: ${e.message}")
        }
    }

    private fun joinParent(parentNodeId: String, relayIp: String) {
        val mesh = SosEmergencyState.mesh
        val self = mesh.identity ?: return
        val myIp = getLocalIpAddressInternal()
        if (!isSameSubnet(myIp, relayIp)) {
            sendLog("JOIN", "דילוג על רשת זרה $relayIp")
            return
        }
        if (SosWifiBootstrap.isClientOnMyHotspot(relayIp)) {
            sendLog("JOIN", "דילוג — $relayIp על הנקודה החמה שלי")
            return
        }
        if (mesh.parentNodeId() != null) return
        if (!EmergencyMeshDecision.shouldInitiateJoin(self.nodeId, parentNodeId)) return
        if (!mesh.tryBeginJoin(parentNodeId)) {
            sendLog("JOIN", "כבר בתהליך הצטרפות")
            return
        }
        executor.execute {
            try {
                sendLog("JOIN", "JOIN_REQUEST → ${parentNodeId.take(8)} $relayIp")
                val socket = Socket()
                socket.connect(InetSocketAddress(relayIp, SosEmergencyState.SERVER_PORT), 5000)
                val reader = BufferedReader(InputStreamReader(socket.getInputStream()))
                val writer = PrintWriter(socket.getOutputStream(), true)
                val path = mesh.ancestorIds().toList() + self.nodeId
                writer.println(
                    EmergencyMeshProtocol.joinRequest(
                        identity = self,
                        ip = myIp ?: "",
                        rootNodeId = mesh.rootNodeId,
                        path = path,
                        staAp = meshStaAp()
                    )
                )
                val response = reader.readLine()
                val frame = response?.let { EmergencyMeshProtocol.parse(it) }
                when (frame?.type) {
                    EmergencyMeshProtocol.JOIN_ACCEPT -> {
                        parentIp = relayIp
                        parentSocket = socket
                        parentWriter = writer
                        SosEmergencyState.sharedParentIp = relayIp
                        mesh.setParent(parentNodeId)
                        addPeer(relayIp)
                        val link = attachMeshLink(
                            nodeId = parentNodeId,
                            bootId = frame.bootId,
                            relation = MeshPeerRelation.DIRECT_PARENT,
                            ip = relayIp,
                            writer = writer,
                            socket = socket
                        )
                        link.send("HELLO:${identityJson()}")
                        sendLog("JOIN", "הצטרפתי. הורה=${parentNodeId.take(8)}")
                        broadcastStatus("מחובר לרשת ✓")
                        broadcastPeerUpdate()
                        listenToParent(socket, reader, link)
                    }
                    EmergencyMeshProtocol.JOIN_REJECT -> {
                        mesh.clearJoin()
                        socket.close()
                        sendLog("JOIN", "נדחה: ${frame.reason}")
                    }
                    else -> {
                        mesh.clearJoin()
                        socket.close()
                        sendLog("JOIN", "תשובה לא תואמת: ${response?.take(40)}")
                    }
                }
            } catch (e: Exception) {
                mesh.clearJoin()
                sendLog("ERROR", "join: ${e.message}")
            }
        }
    }

    private fun listenToParent(socket: Socket, reader: BufferedReader, link: EmergencyMeshLink) {
        executor.execute {
            try {
                while (socket.isConnected && isListening && parentIp != null && link.isLive()) {
                    val line = reader.readLine() ?: break
                    link.markRx()
                    when {
                        line == "PONG" -> {}
                        line == "PING" -> link.send("PONG")
                        line.startsWith("SIBLING_UPDATE:") -> {
                            val sibs = line.substringAfter("SIBLING_UPDATE:").split(",").filter { it.isNotEmpty() }
                            mySiblings.clear()
                            mySiblings.addAll(sibs)
                            sibs.forEach { addPeer(it) }
                            broadcastPeerUpdate()
                        }
                        line.startsWith("HELLO:") -> {
                            val from = parentIp ?: ""
                            if (applyHello(line.substringAfter("HELLO:"), from)) {
                                relayHello(from, line)
                            }
                        }
                        line.startsWith("MSG:") -> {
                            val payload = line.substringAfter("MSG:")
                            handleMessage(parentIp ?: "", payload, relay = true)
                        }
                        else -> handleMessage(parentIp ?: "", line, relay = true)
                    }
                }
            } catch (_: Exception) {
            } finally {
                if (parentIp != null) handleParentDisconnect()
            }
        }
    }

    private fun checkParentConnection() {
        val link = meshLinks.parent()
        val socket = parentSocket
        if (link == null || !link.isLive() || socket == null || socket.isClosed || !socket.isConnected) {
            if (parentIp != null) handleParentDisconnect()
            return
        }
        if (link.isRxStale(System.currentTimeMillis())) {
            link.markDegraded()
            handleParentDisconnect()
            return
        }
        if (!link.send("PING")) handleParentDisconnect()
    }

    private fun handleParentDisconnect() {
        dropParent("parent-disconnect")
        val sibling = mySiblings.firstOrNull { isSameSubnet(getLocalIpAddressInternal(), it) }
        if (sibling != null) {
            mySiblings.remove(sibling)
        }
        maybeJoinBestParent()
        if (SosEmergencyState.mesh.parentNodeId() == null) {
            broadcastStatus("מחפש רשת...")
        }
    }

    private fun handleClient(socket: Socket) {
        executor.execute {
            try {
                val ip = socket.inetAddress?.hostAddress ?: return@execute
                val reader = BufferedReader(InputStreamReader(socket.getInputStream()))
                val writer = PrintWriter(socket.getOutputStream(), true)
                val first = reader.readLine() ?: return@execute
                val v2 = EmergencyMeshProtocol.parse(first)
                when {
                    v2?.type == EmergencyMeshProtocol.JOIN_REQUEST -> {
                        handleV2JoinRequest(socket, ip, v2, reader, writer)
                    }
                    first == "JOIN" -> {
                        writer.println(EmergencyMeshProtocol.joinReject(JoinRejectReason.UNSUPPORTED_VERSION))
                        try { socket.close() } catch (_: Exception) {}
                        sendLog("JOIN", "V1 JOIN מ-$ip — נדחה")
                    }
                    first.startsWith("HELLO:") -> {
                        if (applyHello(first.substringAfter("HELLO:"), ip)) {
                            relayHello(ip, first)
                        }
                    }
                    first.startsWith("MSG:") -> handleMessage(ip, first.substringAfter("MSG:"), relay = true)
                    else -> handleMessage(ip, first, relay = true)
                }
            } catch (e: Exception) {
                Log.e(TAG, "client: ${e.message}")
            }
        }
    }

    private fun handleV2JoinRequest(
        socket: Socket,
        ip: String,
        frame: EmergencyMeshProtocol.Frame,
        reader: BufferedReader,
        writer: PrintWriter
    ) {
        val mesh = SosEmergencyState.mesh
        val self = mesh.identity
        if (self == null || frame.nodeId.isBlank()) {
            writer.println(EmergencyMeshProtocol.joinReject(JoinRejectReason.STALE_SESSION))
            try { socket.close() } catch (_: Exception) {}
            return
        }
        if (!isSameSubnet(getLocalIpAddressInternal(), ip)) {
            writer.println(EmergencyMeshProtocol.joinReject(JoinRejectReason.STALE_SESSION))
            try { socket.close() } catch (_: Exception) {}
            sendLog("JOIN", "נדחה $ip – רשת זרה")
            return
        }
        val reject = EmergencyMeshDecision.rejectIncomingJoin(
            selfId = self.nodeId,
            selfParentId = mesh.parentNodeId(),
            childIds = mesh.childNodeIds(),
            ancestorIds = mesh.ancestorIds(),
            descendantIds = mesh.descendantIds(),
            childCount = mesh.childNodeIds().size,
            maxChildren = SosEmergencyState.MAX_CHILDREN,
            joiningUpstreamId = mesh.joiningUpstreamId,
            remoteId = frame.nodeId,
            remoteAncestorIds = frame.path,
            staAp = meshStaAp()
        )
        if (reject != null) {
            writer.println(EmergencyMeshProtocol.joinReject(reject))
            try { socket.close() } catch (_: Exception) {}
            sendLog("JOIN", "נדחה ${frame.nodeId.take(8)}: $reject")
            return
        }
        val now = System.currentTimeMillis()
        mesh.upsertDiscovery(
            MeshPeerRecord(
                nodeId = frame.nodeId,
                pubkey = frame.pubkey,
                bootId = frame.bootId,
                ssid = frame.ssid,
                currentIp = frame.ip.ifBlank { ip },
                rootNodeId = frame.rootNodeId,
                staAp = frame.staAp,
                name = frame.name
            ),
            now
        )
        mesh.addChild(frame.nodeId)
        val childIp = frame.ip.ifBlank { ip }
        if (!myChildren.contains(childIp)) myChildren.add(childIp)
        SosEmergencyState.childCount = myChildren.size
        addPeer(childIp)
        frame.ssid.takeIf { it.isNotBlank() }?.let { SosEmergencyState.rememberDownstreamSsid(it) }
        writer.println(EmergencyMeshProtocol.joinAccept(self, mesh.childNodeIds().filter { it != frame.nodeId }))
        val link = attachMeshLink(
            nodeId = frame.nodeId,
            bootId = frame.bootId,
            relation = MeshPeerRelation.DIRECT_CHILD,
            ip = childIp,
            writer = writer,
            socket = socket
        )
        childWriters[childIp] = writer
        link.send("HELLO:${identityJson()}")
        sendLog("JOIN", "ילד ${frame.nodeId.take(8)} $childIp (${myChildren.size}/${SosEmergencyState.MAX_CHILDREN})")
        broadcastStatus("ממסר פעיל ✓ (${myChildren.size} ילדים)")
        syncRelayChildrenState()
        notifySiblingsUpdate()
        broadcastPeerUpdate()
        keepChildConnection(socket, childIp, reader, writer, link)
    }

    private fun keepChildConnection(
        socket: Socket,
        ip: String,
        reader: BufferedReader,
        writer: PrintWriter,
        link: EmergencyMeshLink
    ) {
        childWriters[ip] = writer
        executor.execute {
            try {
                while (socket.isConnected && isListening && link.isLive()) {
                    val line = reader.readLine() ?: break
                    link.markRx()
                    when {
                        line == "PING" -> link.send("PONG")
                        line == "PONG" -> {}
                        line.startsWith("HELLO:") -> {
                            if (applyHello(line.substringAfter("HELLO:"), ip)) {
                                syncRelayChildrenState()
                                relayHello(ip, line)
                            }
                        }
                        line.startsWith("MSG:") -> handleMessage(ip, line.substringAfter("MSG:"), relay = true)
                        else -> handleMessage(ip, line, relay = true)
                    }
                }
            } catch (_: Exception) {
            } finally {
                myChildren.remove(ip)
                SosEmergencyState.childCount = myChildren.size
                connectedPeers.remove(ip)
                SosEmergencyState.sharedPeers.remove(ip)
                SosEmergencyState.peerProfiles.remove(ip)
                childWriters.remove(ip)
                link.close()
                meshLinks.detachIfCurrent(link)
                SosEmergencyState.mesh.findByIp(ip)?.nodeId?.let { SosEmergencyState.mesh.removeLink(it) }
                syncRelayChildrenState()
                notifySiblingsUpdate()
                broadcastPeerUpdate()
            }
        }
    }

    /** מיפוי ילדים → SSID להסתרה מסריקת ההורה | HYPER CORE TECH */
    private fun syncRelayChildrenState() {
        SosEmergencyState.relayChildIps.clear()
        SosEmergencyState.relayChildIps.addAll(myChildren)
        SosEmergencyState.hiddenChildSsids.clear()
        for (childIp in myChildren) {
            val pk = SosEmergencyState.peerProfiles[childIp]?.pubkey.orEmpty()
            SosEmergencySetup.ssidFromPubkey(pk)?.let { SosEmergencyState.hiddenChildSsids.add(it) }
        }
        SosEmergencyState.childCount = myChildren.size
    }

    private fun notifySiblingsUpdate() {
        val all = myChildren.toList()
        meshLinks.children().forEach { link ->
            val sibs = all.filter { it != link.currentIp }.joinToString(",")
            link.send("SIBLING_UPDATE:$sibs")
        }
    }

    /**
     * טיפול בהודעה + ריליי בעץ — מעטפת V2 עם messageId/TTL/dedup | HYPER CORE TECH
     */
    private fun handleMessage(fromIp: String, message: String, relay: Boolean) {
        sendLog("MSG", "מ-$fromIp: ${message.take(80)}")
        val raw = if (message.startsWith("MSG:")) message.substringAfter("MSG:") else message
        val envLine = when {
            EmergencyMeshEnvelopeCodec.parse(raw) != null -> raw
            EmergencyMeshEnvelopeCodec.parse(message) != null -> message
            else -> null
        }
        if (envLine != null) {
            applyEnvelopeResult(fromIp, ingestEnvelope(fromIp, envLine))
            return
        }
        if (!relay) {
            deliverToWebView(fromIp, raw)
            return
        }
        val mesh = SosEmergencyState.mesh
        if (mesh.identity == null) {
            deliverToWebView(fromIp, raw)
            return
        }
        val fromId = resolveNodeId(fromIp) ?: fromIp
        val wrapped = EmergencyMeshEnvelopeCodec.encode(
            EmergencyMeshEnvelopeCodec.data(
                originNodeId = fromId,
                targetNodeId = TARGET_BROADCAST,
                payload = raw,
                messageId = EmergencyMeshEnvelopeCodec.legacyMessageId(raw)
            )
        )
        applyEnvelopeResult(fromIp, ingestEnvelope(fromIp, wrapped))
    }

    private fun ingestEnvelope(fromIp: String, line: String): EmergencyMeshEngine.Result {
        val mesh = SosEmergencyState.mesh
        val self = mesh.identity ?: return EmergencyMeshEngine.Result(dropped = true)
        val fromId = resolveNodeId(fromIp) ?: fromIp
        return EmergencyMeshEngine.ingest(
            selfId = self.nodeId,
            selfPubkey = self.pubkey,
            store = mesh,
            seen = SosEmergencyState.meshSeen,
            fromNodeId = fromId,
            line = line
        )
    }

    private fun applyEnvelopeResult(fromIp: String, result: EmergencyMeshEngine.Result) {
        if (result.dropped) return
        result.deliveredPayload?.let { deliverToWebView(fromIp, it) }
        result.receivedAck?.let {
            sendLog("ACK", "${it.status} ref=${it.refMessageId.take(8)}")
            if (it.refMessageId.isNotBlank()) {
                SosEmergencyState.trackDelivery(it.refMessageId, it.status.ifBlank { MeshAckStatus.DELIVERED.name })
            }
        }
        dispatchForwards(fromIp, result)
        result.ack?.let { ack ->
            val self = SosEmergencyState.mesh.identity ?: return
            val ackLine = EmergencyMeshEnvelopeCodec.encode(ack)
            val ackRes = EmergencyMeshEngine.ingest(
                selfId = self.nodeId,
                selfPubkey = self.pubkey,
                store = SosEmergencyState.mesh,
                seen = SosEmergencyState.meshSeen,
                fromNodeId = self.nodeId,
                line = ackLine
            )
            dispatchForwards(fromIp, ackRes)
        }
    }

    private fun dispatchForwards(fromIp: String, result: EmergencyMeshEngine.Result) {
        val wire = result.wire ?: return
        val fromId = resolveNodeId(fromIp)
        when (result.forwardMode) {
            EmergencyMeshEngine.ForwardMode.FLOOD -> {
                meshLinks.live().forEach { link ->
                    if (link.currentIp != fromIp && link.remoteNodeId != fromId) {
                        link.send(wire)
                    }
                }
                mySiblings.filter { it != fromIp && meshLinks.findByIp(it) == null }.forEach {
                    sendRawFallback(it, wire)
                }
            }
            EmergencyMeshEngine.ForwardMode.UNICAST -> {
                val hop = result.nextHopId ?: return
                sendToNodeId(hop, wire)
            }
            EmergencyMeshEngine.ForwardMode.NONE -> {}
        }
    }

    private fun sendToNodeId(nodeId: String, line: String) {
        val link = meshLinks.get(nodeId)
        if (link != null && link.isLive() && link.send(line)) return
        val ip = SosEmergencyState.mesh.get(nodeId)?.currentIp.orEmpty()
        if (ip.isNotBlank()) sendOnDirectOrFallback(ip, line)
    }

    private fun resolveNodeId(ip: String): String? {
        if (ip.isBlank()) return null
        meshLinks.findByIp(ip)?.remoteNodeId?.let { return it }
        return SosEmergencyState.mesh.findByIp(ip)?.nodeId
    }

    fun liveNodeIds(): Set<String> {
        return meshLinks.live().map { it.remoteNodeId }.toSet()
    }

    fun originatePayload(payload: String, targetNodeId: String, targetPubkey: String = ""): String {
        val mesh = SosEmergencyState.mesh
        val self = mesh.identity ?: return ""
        val result = EmergencyMeshEngine.originate(
            selfId = self.nodeId,
            selfPubkey = self.pubkey,
            store = mesh,
            seen = SosEmergencyState.meshSeen,
            payload = payload,
            targetNodeId = targetNodeId,
            targetPubkey = targetPubkey
        )
        if (result.messageId.isNotBlank()) {
            val status = when {
                result.dropped -> MeshAckStatus.FAILED.name
                result.forwardMode != EmergencyMeshEngine.ForwardMode.NONE -> MeshAckStatus.SENT.name
                else -> MeshAckStatus.QUEUED.name
            }
            SosEmergencyState.trackDelivery(result.messageId, status)
        }
        applyEnvelopeResult(SosEmergencyState.myIp ?: "", result)
        return result.messageId
    }

    private fun deliverToWebView(fromIp: String, message: String) {
        val callback = try {
            val json = JSONObject(message)
            when (json.optString("type", "")) {
                "nostr_event" -> "onNostrEvent"
                "webrtc_signal" -> "onWebRTCSignal"
                "chat" -> "onChatMessage"
                else -> "onMessage"
            }
        } catch (_: Exception) {
            "onMessage"
        }
        if (callback == "onWebRTCSignal") {
            val selfPk = SosEmergencyState.mesh.identity?.pubkey
                ?.ifBlank { SosSessionStore.getPubkey(this) }
                .orEmpty()
                .ifBlank { SosSessionStore.getPubkey(this) }
            if (selfPk.isNotBlank() && !EmergencyMeshSignal.shouldDeliverToSelf(selfPk, message)) return
        }
        SosEmergencyState.enqueueInbox(callback, fromIp, message)
        SosEmergencyState.requestInboxDrain()
        val intent = Intent(SosEmergencyState.ACTION_WEBVIEW).apply {
            putExtra("callback", callback)
            putExtra("fromIp", fromIp)
            putExtra("data", message)
        }
        sendBroadcast(intent)
    }

    fun sendToPeer(ip: String, message: String) {
        executor.execute {
            val nodeId = resolveNodeId(ip)
            if (nodeId != null) originatePayload(message, nodeId)
            else sendOnDirectOrFallback(ip, message)
        }
    }

    fun broadcast(message: String) {
        originatePayload(message, TARGET_BROADCAST)
    }

    /** שידור עם ריליי עץ מקומי */
    fun injectAndRelay(message: String) {
        originatePayload(message, TARGET_BROADCAST)
    }

    private fun sendRawFallback(ip: String, message: String) {
        try {
            Socket().use { socket ->
                socket.soTimeout = 5000
                socket.connect(InetSocketAddress(ip, SosEmergencyState.SERVER_PORT), 3000)
                PrintWriter(socket.getOutputStream(), true).println(message)
            }
        } catch (e: Exception) {
            Log.w(TAG, "send $ip failed: ${e.message}")
        }
    }

    private fun addPeer(ip: String) {
        val myIp = getLocalIpAddressInternal()
        if (ip.isBlank() || ip == myIp) return
        if (!isSameSubnet(myIp, ip)) return
        if (!connectedPeers.contains(ip)) connectedPeers.add(ip)
        if (!SosEmergencyState.sharedPeers.contains(ip)) SosEmergencyState.sharedPeers.add(ip)
    }

    private fun broadcastStatus(status: String) {
        updateNotification("$status • ${SosEmergencyState.sharedPeers.size} peers")
        val intent = Intent(SosEmergencyState.ACTION_STATUS).apply {
            putExtra("status", status)
            putExtra("peers", SosEmergencyState.sharedPeers.size)
            putExtra("children", myChildren.size)
        }
        sendBroadcast(intent)
    }

    private fun broadcastPeerUpdate() {
        SosEmergencyState.childCount = myChildren.size
        val peersJson = JSONObject().apply {
            put("isActive", SosEmergencyState.isRelayRunning)
            put("peerCount", SosEmergencyState.mesh.connectedCount())
            put("parentIp", SosEmergencyState.sharedParentIp ?: "")
            put("parentNodeId", SosEmergencyState.mesh.parentNodeId() ?: "")
            put("myIp", getLocalIpAddressInternal() ?: "")
            put("myNodeId", SosEmergencyState.mesh.identity?.nodeId ?: "")
            put("peers", EmergencyMeshPeers.connectedIps(SosEmergencyState.mesh, getLocalIpAddressInternal() ?: ""))
        }
        val intent = Intent(SosEmergencyState.ACTION_WEBVIEW).apply {
            putExtra("callback", "onNetworkUpdate")
            putExtra("data", peersJson.toString())
        }
        sendBroadcast(intent)
        broadcastStatus(
            if (parentIp != null) "מחובר (הורה)" else "ממסר פעיל ✓"
        )
    }

    private fun sendLog(level: String, message: String) {
        Log.d(TAG, "[$level] $message")
        SosDebugLog.i("emergency", "[$level] $message")
        SosEmergencyState.appendScreenLog("[$level] $message")
        val intent = Intent(SosEmergencyState.ACTION_LOG).apply {
            putExtra("level", level)
            putExtra("message", message)
            putExtra("time", System.currentTimeMillis())
        }
        sendBroadcast(intent)
    }

    private fun isSameSubnet(ip1: String?, ip2: String?): Boolean {
        if (ip1 == null || ip2 == null) return false
        val a = ip1.split(".")
        val b = ip2.split(".")
        if (a.size != 4 || b.size != 4) return false
        return a[0] == b[0] && a[1] == b[1] && a[2] == b[2]
    }

    private fun getBroadcastAddressFromIp(ip: String): String {
        val parts = ip.split(".")
        return if (parts.size == 4) "${parts[0]}.${parts[1]}.${parts[2]}.255" else "255.255.255.255"
    }

    fun getLocalIpAddressInternal(): String? {
        return SosWifiBootstrap.preferredMeshIpv4()
    }
}
