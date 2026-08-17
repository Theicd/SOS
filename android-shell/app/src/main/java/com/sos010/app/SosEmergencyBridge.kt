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

    @JavascriptInterface
    fun isEmergencyMode(): Boolean = true

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
        SosEmergencyState.sharedPeers.forEach { ip ->
            if (ip != myIp) {
                val peer = JSONObject()
                peer.put("ip", ip)
                peer.put("type", "relay")
                peer.put("isParent", ip == SosEmergencyState.sharedParentIp)
                peers.put(peer)
            }
        }
        return peers.toString()
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
        return true
    }

    @JavascriptInterface
    fun stopLocalRelay() {
        // השירות נשאר חי במצב חירום; כיבוי מפורש בעתיד
        Log.d(tag, "stopLocalRelay requested (no-op – FGS keeps relay)")
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
        Log.d(tag, "showCallNotification $callerName video=$isVideo")
    }

    @JavascriptInterface
    fun showMessageNotification(senderName: String, messageText: String) {
        Log.d(tag, "showMessageNotification $senderName")
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
