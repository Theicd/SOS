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
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
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
    private val childWriters = ConcurrentHashMap<String, PrintWriter>()
    private val connectedPeers = CopyOnWriteArrayList<String>()

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

        parentIp = null
        parentSocket = null
        SosEmergencyState.sharedParentIp = null
        myChildren.clear()
        mySiblings.clear()
        connectedPeers.clear()
        SosEmergencyState.sharedPeers.clear()
        childWriters.clear()

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
                val buffer = ByteArray(1024)
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

    private fun handleDiscoveryPacket(packet: DatagramPacket) {
        val message = String(packet.data, 0, packet.length)
        val senderIp = packet.address.hostAddress ?: return
        val myIp = getLocalIpAddressInternal()
        if (senderIp == myIp) return

        when {
            message.startsWith("SOS_HERE:") -> {
                val parts = message.split(":")
                val relayIp = parts.getOrNull(1) ?: senderIp
                val childCount = parts.getOrNull(2)?.toIntOrNull() ?: 0
                val maxChildCount = parts.getOrNull(3)?.toIntOrNull() ?: SosEmergencyState.MAX_CHILDREN
                sendLog("UDP", "SOS_HERE מ-$relayIp ($childCount/$maxChildCount)")

                if (myChildren.isNotEmpty()) {
                    addPeer(relayIp)
                    return
                }
                if (myChildren.contains(relayIp) || mySiblings.contains(relayIp) || parentIp == relayIp) {
                    addPeer(relayIp)
                    return
                }
                if (connectedPeers.contains(relayIp)) return

                if (parentIp == null && childCount < maxChildCount) {
                    joinNetwork(relayIp)
                } else if (parentIp != null && !isSameSubnet(myIp, parentIp)) {
                    parentIp = null
                    parentSocket = null
                    SosEmergencyState.sharedParentIp = null
                    if (childCount < maxChildCount) joinNetwork(relayIp)
                }
            }
            message == "SOS_DISCOVER" -> announcePresence()
        }
    }

    private fun announcePresence() {
        try {
            val myIp = getLocalIpAddressInternal() ?: return
            SosEmergencyState.myIp = myIp
            val msg = "SOS_HERE:$myIp:${myChildren.size}:${SosEmergencyState.MAX_CHILDREN}"
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
            sendLog("UDP", "שלחתי SOS_HERE → $addr")
        } catch (e: Exception) {
            sendLog("ERROR", "announce: ${e.message}")
        }
    }

    private fun joinNetwork(relayIp: String) {
        executor.execute {
            try {
                sendLog("JOIN", "מתחבר ל-$relayIp...")
                val socket = Socket()
                socket.connect(InetSocketAddress(relayIp, SosEmergencyState.SERVER_PORT), 5000)
                val reader = BufferedReader(InputStreamReader(socket.getInputStream()))
                val writer = PrintWriter(socket.getOutputStream(), true)
                writer.println("JOIN")
                val response = reader.readLine() ?: return@execute
                when {
                    response.startsWith("ACCEPTED:") -> {
                        parentIp = relayIp
                        parentSocket = socket
                        SosEmergencyState.sharedParentIp = relayIp
                        val siblings = response.substringAfter("ACCEPTED:").split(",").filter { it.isNotEmpty() }
                        mySiblings.clear()
                        mySiblings.addAll(siblings)
                        addPeer(relayIp)
                        siblings.forEach { addPeer(it) }
                        sendLog("JOIN", "הצטרפתי. הורה=$relayIp אחים=${siblings.size}")
                        broadcastStatus("מחובר לרשת ✓")
                        broadcastPeerUpdate()
                        listenToParent(socket, reader)
                    }
                    response.startsWith("REDIRECT:") -> {
                        socket.close()
                        val next = response.substringAfter("REDIRECT:")
                        if (next.isNotBlank()) joinNetwork(next)
                    }
                    else -> {
                        socket.close()
                        sendLog("JOIN", "נדחה: $response")
                    }
                }
            } catch (e: Exception) {
                sendLog("ERROR", "join: ${e.message}")
            }
        }
    }

    private fun listenToParent(socket: Socket, reader: BufferedReader) {
        executor.execute {
            try {
                while (socket.isConnected && isListening && parentIp != null) {
                    val line = reader.readLine() ?: break
                    when {
                        line == "PONG" -> {}
                        line.startsWith("SIBLING_UPDATE:") -> {
                            val sibs = line.substringAfter("SIBLING_UPDATE:").split(",").filter { it.isNotEmpty() }
                            mySiblings.clear()
                            mySiblings.addAll(sibs)
                            sibs.forEach { addPeer(it) }
                            broadcastPeerUpdate()
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
        val parent = parentIp ?: return
        val socket = parentSocket
        if (socket == null || socket.isClosed || !socket.isConnected) {
            handleParentDisconnect()
            return
        }
        try {
            PrintWriter(socket.getOutputStream(), true).println("PING")
        } catch (_: Exception) {
            handleParentDisconnect()
        }
    }

    private fun handleParentDisconnect() {
        parentIp = null
        parentSocket = null
        SosEmergencyState.sharedParentIp = null
        val sibling = mySiblings.firstOrNull()
        if (sibling != null) {
            mySiblings.remove(sibling)
            joinNetwork(sibling)
        } else {
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
                when {
                    first == "JOIN" -> handleJoinRequest(socket, ip, reader, writer)
                    first.startsWith("MSG:") -> handleMessage(ip, first.substringAfter("MSG:"), relay = true)
                    else -> handleMessage(ip, first, relay = true)
                }
            } catch (e: Exception) {
                Log.e(TAG, "client: ${e.message}")
            }
        }
    }

    private fun handleJoinRequest(
        socket: Socket,
        ip: String,
        reader: BufferedReader,
        writer: PrintWriter
    ) {
        if (myChildren.size < SosEmergencyState.MAX_CHILDREN) {
            myChildren.add(ip)
            SosEmergencyState.childCount = myChildren.size
            addPeer(ip)
            val siblings = myChildren.filter { it != ip }.joinToString(",")
            writer.println("ACCEPTED:$siblings")
            sendLog("JOIN", "ילד חדש $ip (${myChildren.size}/${SosEmergencyState.MAX_CHILDREN})")
            broadcastStatus("ממסר פעיל ✓ (${myChildren.size} ילדים)")
            notifySiblingsUpdate()
            broadcastPeerUpdate()
            keepChildConnection(socket, ip, reader, writer)
        } else {
            val redirect = myChildren.randomOrNull()
            if (redirect != null) {
                writer.println("REDIRECT:$redirect")
                sendLog("JOIN", "REDIRECT $ip → $redirect")
            } else {
                writer.println("FULL")
            }
            try { socket.close() } catch (_: Exception) {}
        }
    }

    private fun keepChildConnection(
        socket: Socket,
        ip: String,
        reader: BufferedReader,
        writer: PrintWriter
    ) {
        childWriters[ip] = writer
        executor.execute {
            try {
                while (socket.isConnected && isListening) {
                    val line = reader.readLine() ?: break
                    when {
                        line == "PING" -> writer.println("PONG")
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
                childWriters.remove(ip)
                notifySiblingsUpdate()
                broadcastPeerUpdate()
            }
        }
    }

    private fun notifySiblingsUpdate() {
        val all = myChildren.toList()
        childWriters.forEach { (childIp, writer) ->
            try {
                val sibs = all.filter { it != childIp }.joinToString(",")
                writer.println("SIBLING_UPDATE:$sibs")
            } catch (_: Exception) {}
        }
    }

    /**
     * טיפול בהודעה + ריליי בעץ (הורה/ילדים/אחים) כמו MainActivity הישן | HYPER CORE TECH
     */
    private fun handleMessage(fromIp: String, message: String, relay: Boolean) {
        sendLog("MSG", "מ-$fromIp: ${message.take(80)}")
        deliverToWebView(fromIp, message)

        if (!relay) return
        val wire = if (message.startsWith("MSG:")) message else "MSG:$message"
        parentIp?.takeIf { it != fromIp }?.let { sendRaw(it, wire) }
        myChildren.filter { it != fromIp }.forEach { sendRaw(it, wire) }
        mySiblings.filter { it != fromIp }.forEach { sendRaw(it, wire) }
    }

    private fun deliverToWebView(fromIp: String, message: String) {
        try {
            val json = JSONObject(message)
            val type = json.optString("type", "")
            val callback = when (type) {
                "nostr_event" -> "onNostrEvent"
                "webrtc_signal" -> "onWebRTCSignal"
                "chat" -> "onChatMessage"
                else -> "onMessage"
            }
            val intent = Intent(SosEmergencyState.ACTION_WEBVIEW).apply {
                putExtra("callback", callback)
                putExtra("fromIp", fromIp)
                putExtra("data", message)
            }
            sendBroadcast(intent)
        } catch (_: Exception) {
            val intent = Intent(SosEmergencyState.ACTION_WEBVIEW).apply {
                putExtra("callback", "onMessage")
                putExtra("fromIp", fromIp)
                putExtra("data", message)
            }
            sendBroadcast(intent)
        }
    }

    fun sendToPeer(ip: String, message: String) {
        executor.execute { sendRaw(ip, message) }
    }

    fun broadcast(message: String) {
        val all = linkedSetOf<String>()
        all.addAll(SosEmergencyState.sharedPeers)
        all.addAll(connectedPeers)
        all.addAll(myChildren)
        all.addAll(mySiblings)
        parentIp?.let { all.add(it) }
        val myIp = getLocalIpAddressInternal()
        all.filter { it != myIp }.forEach { sendToPeer(it, message) }
    }

    /** שידור עם ריליי עץ מקומי */
    fun injectAndRelay(message: String) {
        val myIp = getLocalIpAddressInternal() ?: "0.0.0.0"
        handleMessage(myIp, message, relay = true)
    }

    private fun sendRaw(ip: String, message: String) {
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
            put("peerCount", SosEmergencyState.sharedPeers.size)
            put("parentIp", SosEmergencyState.sharedParentIp ?: "")
            put("myIp", getLocalIpAddressInternal() ?: "")
            put("peers", JSONArray(SosEmergencyState.sharedPeers))
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
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces()
            while (interfaces.hasMoreElements()) {
                val intf = interfaces.nextElement()
                if (intf.isLoopback || !intf.isUp) continue
                for (addr in intf.interfaceAddresses) {
                    val b = addr.broadcast ?: continue
                    return b.hostAddress ?: continue
                }
            }
        } catch (_: Exception) {}
        val parts = ip.split(".")
        return if (parts.size == 4) "${parts[0]}.${parts[1]}.${parts[2]}.255" else "255.255.255.255"
    }

    fun getLocalIpAddressInternal(): String? {
        return try {
            var fallback: String? = null
            val interfaces = NetworkInterface.getNetworkInterfaces()
            while (interfaces.hasMoreElements()) {
                val intf = interfaces.nextElement()
                val name = intf.name.lowercase()
                if (intf.isLoopback || !intf.isUp) continue
                val addrs = intf.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (addr is Inet4Address) {
                        val ip = addr.hostAddress ?: continue
                        if (name.contains("wlan") || name.contains("ap") || name.contains("swlan")) {
                            return ip
                        }
                        if (fallback == null) fallback = ip
                    }
                }
            }
            fallback
        } catch (_: Exception) {
            null
        }
    }
}
