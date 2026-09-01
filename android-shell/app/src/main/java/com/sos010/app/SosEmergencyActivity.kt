package com.sos010.app

import android.Manifest
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Button
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.net.Inet4Address
import java.net.NetworkInterface
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * מסך מצב חירום – הפעלת ממסר, Hotspot, בדיקות | HYPER CORE TECH
 */
class SosEmergencyActivity : AppCompatActivity() {

    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var relayStatusView: TextView
    private lateinit var usersStatusView: TextView
    private lateinit var wifiStatusView: TextView
    private lateinit var hotspotStatusView: TextView
    private lateinit var ipAddressView: TextView
    private lateinit var networkNameView: TextView
    private lateinit var networkPasswordView: TextView
    private val handler = Handler(Looper.getMainLooper())
    private val timeFmt = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent == null) return
            val status = intent.getStringExtra("status") ?: return
            val peers = intent.getIntExtra("peers", 0)
            val children = intent.getIntExtra("children", 0)
            runOnUiThread {
                relayStatusView.text = status
                usersStatusView.text = "👥 מחוברים: $peers | ילדים: $children"
                appendLog("סטטוס: $status")
            }
        }
    }

    private val logReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent == null) return
            runOnUiThread { showLogFromState() }
        }
    }

    private val statusTicker = object : Runnable {
        override fun run() {
            refreshNetworkUi()
            handler.postDelayed(this, 3000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_sos_emergency)

        logView = findViewById(R.id.logView)
        logScroll = findViewById(R.id.logScroll)
        relayStatusView = findViewById(R.id.relayStatus)
        usersStatusView = findViewById(R.id.usersStatus)
        wifiStatusView = findViewById(R.id.wifiStatus)
        hotspotStatusView = findViewById(R.id.hotspotStatus)
        ipAddressView = findViewById(R.id.ipAddress)
        networkNameView = findViewById(R.id.networkName)
        networkPasswordView = findViewById(R.id.networkPassword)

        networkPasswordView.text = "סיסמה נדרשת: ${SosEmergencyState.NETWORK_PASSWORD}"
        networkNameView.text = "רשת יעד: ${SosEmergencyState.NETWORK_NAME}"

        findViewById<Button>(R.id.backToNetworkButton).setOnClickListener { finish() }
        findViewById<Button>(R.id.openHotspotSettingsButton).setOnClickListener { openHotspotSettings() }
        findViewById<Button>(R.id.startRelayButton).setOnClickListener { startRelay() }
        findViewById<Button>(R.id.runTestsButton).setOnClickListener {
            startActivity(Intent(this, SosEmergencyTestActivity::class.java))
        }
        findViewById<Button>(R.id.serviceLogButton).setOnClickListener {
            startActivity(Intent(this, SosEmergencyLogActivity::class.java))
        }
        findViewById<Button>(R.id.copyLogButton).setOnClickListener { copyScreenLog() }

        ensureLocationPermission()
        showLogFromState()
        appendLog("מסך חירום מוכן")
        relayStatusView.text = if (SosEmergencyState.isRelayRunning) {
            "ממסר פעיל ✓"
        } else {
            "ממסר לא פעיל - לחץ להפעלה"
        }
    }

    override fun onStart() {
        super.onStart()
        val filterStatus = IntentFilter(SosEmergencyState.ACTION_STATUS)
        val filterLog = IntentFilter(SosEmergencyState.ACTION_LOG)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(statusReceiver, filterStatus, Context.RECEIVER_NOT_EXPORTED)
            registerReceiver(logReceiver, filterLog, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(statusReceiver, filterStatus)
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(logReceiver, filterLog)
        }
        handler.post(statusTicker)
        refreshNetworkUi()
        appendLog(buildSnapshot())
    }

    override fun onStop() {
        handler.removeCallbacks(statusTicker)
        try { unregisterReceiver(statusReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(logReceiver) } catch (_: Exception) {}
        super.onStop()
    }

    private fun startRelay() {
        ensureLocationPermission()
        appendLog("מפעיל שירות ממסר...")
        SosEmergencyRelayService.start(this)
        SosEmergencyState.isRelayRunning = true
        relayStatusView.text = "ממסר פעיל ✓"
        Toast.makeText(this, "ממסר חירום הופעל", Toast.LENGTH_SHORT).show()
    }

    private fun ensureLocationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val ok = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        if (!ok) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                ),
                2201
            )
        }
    }

    private fun openHotspotSettings() {
        try {
            startActivity(Intent(Settings.ACTION_WIRELESS_SETTINGS))
        } catch (_: Exception) {
            try {
                startActivity(Intent(Settings.ACTION_WIFI_SETTINGS))
            } catch (_: Exception) {
                Toast.makeText(this, "פתח ידנית: נקודה חמה / Hotspot", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun refreshNetworkUi() {
        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val wifiEnabled = wifiManager.isWifiEnabled
        val wifiConnected = isWifiConnected()
        wifiStatusView.text = when {
            !wifiEnabled -> "❌ Wi-Fi כבוי"
            wifiConnected -> "✅ Wi-Fi מחובר"
            else -> "⚠️ Wi-Fi פעיל אך לא מחובר"
        }

        val hotspot = isHotspotActive(wifiManager)
        hotspotStatusView.text = if (hotspot) "✅ נקודה חמה פעילה" else "❌ נקודה חמה כבויה"

        val ip = getLocalIp()
        SosEmergencyState.myIp = ip
        ipAddressView.text = "כתובת IP: ${ip ?: "לא זמין"}"
        usersStatusView.text =
            "👥 peers: ${SosEmergencyState.sharedPeers.size} | ילדים: ${SosEmergencyState.childCount}" +
                if (SosEmergencyState.sharedParentIp != null) " | הורה: ✓" else " | שורש/ממתין"
    }

    private fun isWifiConnected(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
    }

    private fun isHotspotActive(wifiManager: WifiManager): Boolean {
        return try {
            val method = wifiManager.javaClass.getDeclaredMethod("isWifiApEnabled")
            method.isAccessible = true
            method.invoke(wifiManager) as Boolean
        } catch (_: Exception) {
            false
        }
    }

    private fun getLocalIp(): String? {
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

    private fun copyScreenLog() {
        refreshNetworkUi()
        appendLog(buildSnapshot())
        val text = SosEmergencyState.screenLogText().ifBlank { logView.text?.toString().orEmpty() }
        val cm = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("SOS emergency log", text))
        Toast.makeText(this, R.string.emergency_log_copied, Toast.LENGTH_SHORT).show()
    }

    private fun buildSnapshot(): String {
        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val peers = SosEmergencyState.sharedPeers.joinToString(",").ifBlank { "-" }
        return "SNAPSHOT ${timeFmt.format(Date())}" +
            " ip=${SosEmergencyState.myIp ?: "-"}" +
            " parent=${SosEmergencyState.sharedParentIp ?: "-"}" +
            " children=${SosEmergencyState.childCount}" +
            " peers=$peers" +
            " hotspot=${if (isHotspotActive(wifiManager)) "on" else "off"}" +
            " wifi=${if (isWifiConnected()) "on" else "off"}" +
            " relay=${if (SosEmergencyState.isRelayRunning) "on" else "off"}"
    }

    private fun appendLog(line: String) {
        SosEmergencyState.appendScreenLog(line)
        showLogFromState()
    }

    private fun showLogFromState() {
        val text = SosEmergencyState.screenLogText()
        logView.text = text
        logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }
}
