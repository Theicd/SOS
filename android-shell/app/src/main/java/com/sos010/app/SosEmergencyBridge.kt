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
        return SosEmergencyState.isRelayRunning && SosEmergencyState.sharedPeers.isNotEmpty()
    }

    @JavascriptInterface
    fun getEmergencyNetworkStatus(): String {
        val status = JSONObject()
        status.put("isActive", SosEmergencyState.isRelayRunning)
        status.put("peerCount", SosEmergencyState.sharedPeers.size)
        status.put("parentIp", SosEmergencyState.sharedParentIp ?: "")
        status.put("myIp", getLocalIpAddress())
        status.put("peers", JSONArray(SosEmergencyState.sharedPeers))
        return status.toString()
    }

    @JavascriptInterface
    fun getRelayPeers(): String {
        val peers = JSONArray()
        val myIp = getLocalIpAddress()
        val seen = HashSet<String>()
        fun addPeer(ip: String) {
            if (ip.isBlank() || ip == myIp || !seen.add(ip)) return
            val profile = SosEmergencyState.peerProfiles[ip]
            val peer = JSONObject()
            peer.put("ip", ip)
            peer.put("type", "relay")
            peer.put("isParent", ip == SosEmergencyState.sharedParentIp)
            peer.put("pubkey", profile?.pubkey ?: "")
            peer.put("name", profile?.name ?: "")
            peer.put("picture", profile?.picture ?: "")
            peers.put(peer)
        }
        SosEmergencyState.sharedParentIp?.let { addPeer(it) }
        SosEmergencyState.sharedPeers.forEach { addPeer(it) }
        return peers.toString()
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
            svc.injectAndRelay(message)
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
        executor.execute {
            SosEmergencyRelayService.instance?.sendToPeer(peerIp, message) ?: trySend(peerIp, message)
        }
        return true
    }

    @JavascriptInterface
    fun sendP2PMessage(messageJson: String): Boolean {
        return try {
            val message = JSONObject(messageJson)
            message.put("from", getLocalIpAddress())
            message.put("timestamp", System.currentTimeMillis())
            broadcastMessage(message.toString())
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
        val wrapped = JSONObject()
        wrapped.put("type", "webrtc_signal")
        wrapped.put("target", targetPubkey)
        wrapped.put("signal", JSONObject(signalJson))
        wrapped.put("from", getLocalIpAddress())
        broadcastMessage(wrapped.toString())
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
