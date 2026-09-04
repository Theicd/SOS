package com.sos010.app

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.concurrent.Executors

/**
 * גשר JS ← רשת חירום. נחשף כ-window.AndroidBridge | HYPER CORE TECH
 */
class SosEmergencyBridge(
    private val context: Context,
    private val webView: WebView?
) {
    private val tag = "SosEmergencyBridge"
    private val executor = Executors.newCachedThreadPool()
    private val handler = Handler(Looper.getMainLooper())

    init {
        SosEmergencyState.inboxDrainer = {
            handler.post {
                webView?.evaluateJavascript(
                    "window.SOSEmergency&&window.SOSEmergency.drainNow&&window.SOSEmergency.drainNow()",
                    null
                )
            }
        }
    }

    /** true רק כשממסר החירום באמת רץ — לא תמיד, כדי לא לשבור מצב אינטרנט רגיל | HYPER CORE TECH */
    @JavascriptInterface
    fun isEmergencyMode(): Boolean = SosEmergencyState.isRelayRunning

    @JavascriptInterface
    fun isOfflineMode(): Boolean = SosEmergencyState.isRelayRunning

    @JavascriptInterface
    fun getLocalIpAddress(): String {
        return SosEmergencyState.myIp
            ?: SosEmergencyRelayService.instance?.getLocalIpAddressInternal()
            ?: resolveLocalIp()
            ?: "0.0.0.0"
    }

    @JavascriptInterface
    fun getNetworkInfo(): String {
        val info = JSONObject()
        info.put("ip", getLocalIpAddress())
        info.put("peers", SosEmergencyState.sharedPeers.size)
        info.put("isRelay", SosEmergencyState.isRelayRunning)
        info.put("port", SosEmergencyState.SERVER_PORT)
        return info.toString()
    }

    @JavascriptInterface
    fun getPeerList(): String {
        val peers = JSONArray()
        val myIp = getLocalIpAddress()
        SosEmergencyState.sharedPeers.forEach { ip ->
            if (ip != myIp) peers.put(ip)
        }
        return peers.toString()
    }

    @JavascriptInterface
    fun isRelayNetworkActive(): Boolean {
        return SosEmergencyState.isRelayRunning && SosEmergencyState.mesh.connectedCount() > 0
    }

    @JavascriptInterface
    fun getEmergencyNetworkStatus(): String {
        val mesh = SosEmergencyState.mesh
        val myIp = getLocalIpAddress()
        val status = JSONObject()
        status.put("isActive", SosEmergencyState.isRelayRunning)
        status.put("peerCount", mesh.connectedCount())
        status.put("parentIp", SosEmergencyState.sharedParentIp ?: "")
        status.put("parentNodeId", mesh.parentNodeId() ?: "")
        status.put("myIp", myIp)
        status.put("myNodeId", mesh.identity?.nodeId ?: "")
        status.put("peers", EmergencyMeshPeers.connectedIps(mesh, myIp))
        return status.toString()
    }

    @JavascriptInterface
    fun getRelayPeers(): String {
        val mesh = SosEmergencyState.mesh
        val selfId = mesh.identity?.nodeId.orEmpty()
        val live = SosEmergencyRelayService.instance?.liveNodeIds().orEmpty()
        val arr = EmergencyMeshPeers.listJson(mesh, live, selfId)
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (o.optString("name").isNotBlank()) continue
            val ip = o.optString("ip")
            val profile = SosEmergencyState.peerProfiles[ip]
            if (profile != null) {
                if (o.optString("name").isBlank()) o.put("name", profile.name)
                if (o.optString("picture").isBlank()) o.put("picture", profile.picture)
                if (o.optString("pubkey").isBlank()) o.put("pubkey", profile.pubkey)
            }
        }
        if (arr.length() > 0) return arr.toString()
        return legacyRelayPeers()
    }

    @JavascriptInterface
    fun setEmergencyProfile(name: String?, picture: String?) {
        SosEmergencyState.myDisplayName = (name ?: "").trim().take(80)
        SosEmergencyState.myPicture = (picture ?: "").trim().take(512)
        SosEmergencyState.identityVersion += 1
        SosEmergencyRelayService.instance?.pushIdentity()
    }

    @JavascriptInterface
    fun drainEmergencyInbox(): String {
        val arr = JSONArray()
        var n = 0
        while (n < 50) {
            val item = SosEmergencyState.inbox.poll() ?: break
            val obj = JSONObject()
            obj.put("callback", item.callback)
            obj.put("fromIp", item.fromIp)
            obj.put("data", item.data)
            arr.put(obj)
            n++
        }
        return arr.toString()
    }

    @JavascriptInterface
    fun broadcastMessage(message: String) {
        Log.d(tag, "broadcast ${message.take(80)}")
        val svc = SosEmergencyRelayService.instance
        if (svc != null) {
            svc.originatePayload(message, TARGET_BROADCAST)
        } else {
            executor.execute {
                SosEmergencyState.sharedPeers.forEach { ip ->
                    trySend(ip, message)
                }
            }
        }
    }

    @JavascriptInterface
    fun sendToPeer(peerIp: String, message: String): Boolean {
        val key = peerIp.trim()
        executor.execute {
            if (key.length == 64 && key.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }) {
                sendToPubkeyInternal(key.lowercase(), message)
            } else {
                SosEmergencyRelayService.instance?.sendToPeer(key, message) ?: trySend(key, message)
            }
        }
        return true
    }

    @JavascriptInterface
    fun sendToPubkey(pubkey: String, message: String): Boolean {
        executor.execute { sendToPubkeyInternal(pubkey, message) }
        return true
    }

    @JavascriptInterface
    fun sendMeshChat(messageJson: String): String {
        return try {
            val message = JSONObject(messageJson)
            if (!message.has("from")) message.put("from", getLocalIpAddress())
            if (!message.has("timestamp")) message.put("timestamp", System.currentTimeMillis())
            val to = message.optString("to")
            val (targetNodeId, targetPubkey) = EmergencyMeshPeers.resolveTarget(to, SosEmergencyState.mesh)
            val chatId = message.optString("id")
            val svc = SosEmergencyRelayService.instance
                ?: return JSONObject().put("ok", false).put("error", "no-relay").toString()
            val mid = svc.originatePayload(message.toString(), targetNodeId, targetPubkey)
            if (mid.isBlank()) {
                return JSONObject().put("ok", false).put("error", "no-identity").toString()
            }
            if (chatId.isNotBlank() && chatId != mid) {
                SosEmergencyState.trackDelivery(chatId, SosEmergencyState.deliveryStatus(mid))
            }
            JSONObject()
                .put("ok", true)
                .put("messageId", mid)
                .put("chatId", chatId)
                .put("status", SosEmergencyState.deliveryStatus(mid).ifBlank { MeshAckStatus.SENT.name })
                .put("target", targetNodeId)
                .toString()
        } catch (e: Exception) {
            Log.e(tag, "sendMeshChat: ${e.message}")
            JSONObject().put("ok", false).put("error", e.message ?: "bad-json").toString()
        }
    }

    @JavascriptInterface
    fun getMeshDeliveryStatus(messageId: String): String {
        return SosEmergencyState.deliveryStatus(messageId)
    }

    @JavascriptInterface
    fun sendP2PMessage(messageJson: String): Boolean {
        return try {
            val message = JSONObject(messageJson)
            message.put("from", getLocalIpAddress())
            message.put("timestamp", System.currentTimeMillis())
            val to = message.optString("to")
            if (to.isNotBlank() && !EmergencyMeshPeers.isGroupTarget(to)) {
                sendToPubkeyInternal(to, message.toString())
            } else {
                broadcastMessage(message.toString())
            }
            true
        } catch (e: Exception) {
            Log.e(tag, "sendP2PMessage: ${e.message}")
            false
        }
    }

    @JavascriptInterface
    fun publishNostrEvent(eventJson: String): Boolean {
        val wrapped = JSONObject()
        wrapped.put("type", "nostr_event")
        wrapped.put("event", JSONObject(eventJson))
        broadcastMessage(wrapped.toString())
        return true
    }

    @JavascriptInterface
    fun sendWebRTCSignal(targetPubkey: String, signalJson: String): Boolean {
        val route = EmergencyMeshSignal.routeTarget(targetPubkey, SosEmergencyState.mesh)
            ?: return false
        val fromPk = SosSessionStore.getPubkey(context)
        val wrapped = EmergencyMeshSignal.wrap(
            targetPubkey = route.second.ifBlank { targetPubkey },
            signalJson = signalJson,
            fromPubkey = fromPk,
            fromIp = getLocalIpAddress()
        ) ?: return false
        val svc = SosEmergencyRelayService.instance
        if (svc != null) {
            val mid = svc.originatePayload(wrapped, route.first, route.second)
            return mid.isNotBlank()
        }
        val ip = SosEmergencyState.mesh.findByPubkey(route.second)?.currentIp.orEmpty()
        if (ip.isBlank()) return false
        executor.execute { trySend(ip, wrapped) }
        return true
    }

    @JavascriptInterface
    fun startLocalRelay(): Boolean {
        SosEmergencyRelayService.start(context.applicationContext)
        SosDebugLog.i("emergency", "startLocalRelay requested")
        return true
    }

    @JavascriptInterface
    fun stopLocalRelay() {
        SosEmergencyRelayService.stop(context.applicationContext)
        SosDebugLog.i("emergency", "stopLocalRelay requested")
    }

    @JavascriptInterface
    fun subscribeToNostrEvents(filterJson: String, callbackName: String) {
        Log.d(tag, "subscribeToNostrEvents $callbackName filter=${filterJson.take(40)}")
    }

    @JavascriptInterface
    fun registerCallbacks(onMessage: String, onPeerConnected: String, onPeerDisconnected: String) {
        Log.d(tag, "registerCallbacks $onMessage / $onPeerConnected / $onPeerDisconnected")
    }

    @JavascriptInterface
    fun registerPeerUpdateCallback(callbackName: String) {
        Log.d(tag, "registerPeerUpdateCallback $callbackName")
    }

    @JavascriptInterface
    fun requestPeerUpdate() {
        val status = getEmergencyNetworkStatus()
        callJs("window.SOSBridge && window.SOSBridge.onNetworkUpdate && window.SOSBridge.onNetworkUpdate($status)")
    }

    @JavascriptInterface
    fun openEmergencySettings() {
        handler.post {
            val intent = Intent(context, SosEmergencyActivity::class.java)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }
    }

    @JavascriptInterface
    fun showCallNotification(callerName: String, isVideo: Boolean) {
        val name = callerName.ifBlank { "מישהו" }
        val type = if (isVideo) "video" else "voice"
        NotificationHelper.showIncomingCall(
            context.applicationContext,
            title = if (isVideo) "שיחת וידאו נכנסת" else "שיחה קולית נכנסת",
            body = "$name מתקשר אליך",
            openUrl = SosCallUrls.warmPage(),
            callType = type,
            peerPubkey = "",
            callerName = name
        )
    }

    @JavascriptInterface
    fun showMessageNotification(senderName: String, messageText: String) {
        NotificationHelper.showMessage(
            context.applicationContext,
            title = senderName.ifBlank { "SOS" },
            body = messageText.ifBlank { "הודעה חדשה" },
            openUrl = null,
            tag = null,
            eventId = null,
            peerKey = null
        )
    }

    private fun legacyRelayPeers(): String {
        val peers = JSONArray()
        val myIp = getLocalIpAddress()
        val seen = HashSet<String>()
        fun addPeer(ip: String) {
            if (ip.isBlank() || ip == myIp || !seen.add(ip)) return
            val profile = SosEmergencyState.peerProfiles[ip]
            val peer = JSONObject()
            peer.put("ip", ip)
            peer.put("nodeId", "")
            peer.put("type", "relay")
            peer.put("reachable", true)
            peer.put("hops", 1)
            peer.put("isParent", ip == SosEmergencyState.sharedParentIp)
            peer.put("pubkey", profile?.pubkey ?: "")
            peer.put("name", profile?.name ?: "")
            peer.put("picture", profile?.picture ?: "")
            peer.put("relation", if (ip == SosEmergencyState.sharedParentIp) "DIRECT_PARENT" else "DIRECT_CHILD")
            peers.put(peer)
        }
        SosEmergencyState.sharedParentIp?.let { addPeer(it) }
        SosEmergencyState.sharedPeers.forEach { addPeer(it) }
        return peers.toString()
    }

    private fun sendToPubkeyInternal(pubkey: String, message: String) {
        val (nodeId, pk) = EmergencyMeshPeers.resolveTarget(pubkey, SosEmergencyState.mesh)
        val svc = SosEmergencyRelayService.instance
        if (svc != null) {
            svc.originatePayload(message, nodeId, pk)
            return
        }
        val ip = SosEmergencyState.mesh.findByPubkey(pk)?.currentIp.orEmpty()
        if (ip.isNotBlank()) trySend(ip, message)
    }

    private fun trySend(ip: String, message: String) {
        try {
            java.net.Socket().use { socket ->
                socket.soTimeout = 5000
                socket.connect(
                    java.net.InetSocketAddress(ip, SosEmergencyState.SERVER_PORT),
                    3000
                )
                java.io.PrintWriter(socket.getOutputStream(), true).println(message)
            }
        } catch (e: Exception) {
            Log.w(tag, "send $ip failed: ${e.message}")
        }
    }

    private fun callJs(script: String) {
        handler.post {
            webView?.evaluateJavascript(script, null)
        }
    }

    private fun resolveLocalIp(): String? {
        return try {
            var fallback: String? = null
            val interfaces = NetworkInterface.getNetworkInterfaces()
            while (interfaces.hasMoreElements()) {
                val intf = interfaces.nextElement()
                if (intf.isLoopback || !intf.isUp) continue
                val name = intf.name.lowercase()
                val addrs = intf.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (addr is Inet4Address) {
                        val ip = addr.hostAddress ?: continue
                        if (name.contains("wlan") || name.contains("ap")) return ip
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
