package com.sos010.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONArray
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket

/**
 * ממשק בדיקות רשת חירום (test-runner.html) | HYPER CORE TECH
 */
class SosEmergencyTestActivity : AppCompatActivity() {

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val webView = WebView(this)
        setContentView(webView)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = true
        webView.addJavascriptInterface(TestBridge(), "AndroidBridge")
        webView.webViewClient = WebViewClient()
        webView.webChromeClient = WebChromeClient()
        webView.loadUrl("file:///android_asset/emergency/test-runner.html")
    }

    inner class TestBridge {
        @JavascriptInterface
        fun getLocalIpAddress(): String = localIp() ?: "0.0.0.0"

        @JavascriptInterface
        fun getPeerList(): String {
            val myIp = localIp()
            val peers = JSONArray()
            SosEmergencyState.sharedPeers.forEach { ip ->
                if (ip != myIp) peers.put(ip)
            }
            return peers.toString()
        }

        @JavascriptInterface
        fun sendToPeer(peerIp: String, message: String): Boolean {
            return try {
                Socket().use { socket ->
                    socket.soTimeout = 3000
                    socket.connect(InetSocketAddress(peerIp, SosEmergencyState.SERVER_PORT), 3000)
                    java.io.PrintWriter(socket.getOutputStream(), true).println(message)
                }
                true
            } catch (_: Exception) {
                false
            }
        }

        @JavascriptInterface
        fun broadcastMessage(message: String): Boolean {
            SosEmergencyRelayService.instance?.injectAndRelay(message)
                ?: SosEmergencyState.sharedPeers.forEach { sendToPeer(it, message) }
            return true
        }

        private fun localIp(): String? {
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
}
