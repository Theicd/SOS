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
import android.view.View
import android.widget.Button
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.widget.ViewFlipper
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.net.Inet4Address
import java.net.NetworkInterface
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * מסך מצב חירום – אשף תחנה + הפעלת ממסר | HYPER CORE TECH
 */
class SosEmergencyActivity : AppCompatActivity() {

    private lateinit var stationRoot: View
    private lateinit var wizardRoot: View
    private lateinit var wizardFlipper: ViewFlipper
    private lateinit var wizardSsidValue: TextView
    private lateinit var wizardPasswordValue: TextView
    private lateinit var wizardContinue: Button
    private lateinit var wizardVerifyTitle: TextView
    private lateinit var wizardVerifyStatus: TextView
    private lateinit var wizardRetry: Button
    private lateinit var wizardEnter: Button
    private lateinit var hotspotHintSsid: TextView
    private lateinit var hotspotHintPassword: TextView

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
    private var awaitingHotspotReturn = false
    private var retryRelayOnResume = false
    private var relayArming = false

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

        stationRoot = findViewById(R.id.stationRoot)
        wizardRoot = findViewById(R.id.wizardRoot)
        wizardFlipper = findViewById(R.id.wizardFlipper)
        wizardSsidValue = findViewById(R.id.wizardSsidValue)
        wizardPasswordValue = findViewById(R.id.wizardPasswordValue)
        wizardContinue = findViewById(R.id.wizardContinue)
        wizardVerifyTitle = findViewById(R.id.wizardVerifyTitle)
        wizardVerifyStatus = findViewById(R.id.wizardVerifyStatus)
        wizardRetry = findViewById(R.id.wizardRetry)
        wizardEnter = findViewById(R.id.wizardEnter)
        hotspotHintSsid = findViewById(R.id.hotspotHintSsid)
        hotspotHintPassword = findViewById(R.id.hotspotHintPassword)

        logView = findViewById(R.id.logView)
        logScroll = findViewById(R.id.logScroll)
        relayStatusView = findViewById(R.id.relayStatus)
        usersStatusView = findViewById(R.id.usersStatus)
        wifiStatusView = findViewById(R.id.wifiStatus)
        hotspotStatusView = findViewById(R.id.hotspotStatus)
        ipAddressView = findViewById(R.id.ipAddress)
        networkNameView = findViewById(R.id.networkName)
        networkPasswordView = findViewById(R.id.networkPassword)

        bindWizard()
        refreshStationLabels()

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

        if (SosEmergencySetup.isComplete(this) || SosWifiBootstrap.isLinkedToSos(this)) {
            if (SosWifiBootstrap.isLinkedToSos(this)) {
                SosEmergencySetup.markComplete(this)
            }
            showStation()
        } else {
            showWizard()
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

    override fun onResume() {
        super.onResume()
        if (awaitingHotspotReturn && wizardRoot.visibility == View.VISIBLE) {
            awaitingHotspotReturn = false
            wizardFlipper.displayedChild = 2
            runWizardVerify()
        } else if (retryRelayOnResume && wizardRoot.visibility != View.VISIBLE) {
            retryRelayOnResume = false
            startRelay()
        }
    }

    override fun onStop() {
        handler.removeCallbacks(statusTicker)
        try { unregisterReceiver(statusReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(logReceiver) } catch (_: Exception) {}
        super.onStop()
    }

    private fun bindWizard() {
        val ssid = SosEmergencySetup.stationSsid(this)
        val password = SosEmergencyState.NETWORK_PASSWORD
        wizardSsidValue.text = ssid
        wizardPasswordValue.text = password
        findViewById<Button>(R.id.wizardCopySsid).setOnClickListener {
            copyText("SOS station SSID", ssid, R.string.emergency_ssid_copied)
            wizardContinue.visibility = View.VISIBLE
            wizardContinue.isEnabled = true
        }
        wizardContinue.setOnClickListener { wizardFlipper.displayedChild = 1 }
        findViewById<Button>(R.id.wizardCopyPassword).setOnClickListener {
            copyText("SOS station password", password, R.string.emergency_password_copied)
        }
        findViewById<Button>(R.id.wizardOpenHotspot).setOnClickListener {
            awaitingHotspotReturn = true
            openHotspotSettings()
        }
        wizardRetry.setOnClickListener {
            awaitingHotspotReturn = true
            openHotspotSettings()
        }
        wizardEnter.setOnClickListener { showStation() }
    }

    private fun showWizard() {
        wizardRoot.visibility = View.VISIBLE
        stationRoot.visibility = View.GONE
        wizardFlipper.displayedChild = 0
    }

    private fun showStation() {
        wizardRoot.visibility = View.GONE
        stationRoot.visibility = View.VISIBLE
        refreshStationLabels()
    }

    private fun refreshStationLabels() {
        val ssid = SosEmergencySetup.stationSsid(this)
        val password = SosEmergencyState.NETWORK_PASSWORD
        networkPasswordView.text = "סיסמה נדרשת: $password"
        networkNameView.text = "רשת יעד: $ssid"
        hotspotHintSsid.text = "שם רשת: $ssid"
        hotspotHintPassword.text = "סיסמה: $password"
    }

    private fun runWizardVerify() {
        wizardVerifyTitle.text = getString(R.string.emergency_wizard_verify_title)
        val wifiOn = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).isWifiEnabled
        val hotspot = SosWifiBootstrap.isHotspotActive(this)
        val onSos = SosEmergencySetup.isSosSsid(SosWifiBootstrap.currentSsid(this))
        val linked = hotspot || onSos
        val lines = buildString {
            append(if (wifiOn || hotspot) "כרטיס רשת: תקין" else "כרטיס רשת: כבוי")
            append('\n')
            append(if (hotspot) "נקודה חמה: דולקת" else "נקודה חמה: כבויה")
            append('\n')
            append(if (onSos) "חיבור SOS: זוהה" else "חיבור SOS: לא זוהה")
        }
        wizardVerifyStatus.text = lines
        if (linked) {
            SosEmergencySetup.markComplete(this)
            wizardVerifyTitle.text = getString(R.string.emergency_wizard_ready)
            wizardVerifyStatus.text = lines + "\n\n" + getString(R.string.emergency_wizard_ready_hint)
            wizardRetry.visibility = View.GONE
            wizardEnter.visibility = View.VISIBLE
            appendLog("אשף: תחנה מוכנה")
        } else {
            wizardRetry.visibility = View.VISIBLE
            wizardEnter.visibility = View.GONE
        }
    }

    private fun startRelay() {
        if (relayArming) return
        ensureLocationPermission()
        relayArming = true
        relayStatusView.text = getString(R.string.emergency_scanning)
        appendLog("סורק רשתות SOS...")
        SosWifiBootstrap.prepareForRelay(this) { result ->
            runOnUiThread {
                relayArming = false
                when (result) {
                    SosWifiBootstrap.Result.ALREADY_LINKED -> {
                        appendLog("החלטה: נשארים על הרשת / נקודה חמה")
                        launchRelay()
                    }
                    SosWifiBootstrap.Result.JOINED -> {
                        appendLog("החלטה: התחברתי לרשת SOS")
                        launchRelay()
                    }
                    SosWifiBootstrap.Result.YIELD_NEEDED -> {
                        appendLog("יש רשת SOS קרובה — כבה נקודה חמה וחזור")
                        Toast.makeText(this, R.string.emergency_yield_hotspot, Toast.LENGTH_LONG).show()
                        retryRelayOnResume = true
                        openHotspotSettings()
                    }
                    SosWifiBootstrap.Result.NONE_FOUND,
                    SosWifiBootstrap.Result.CONNECT_FAILED -> {
                        appendLog("אין רשת SOS — מדליקים נקודה חמה")
                        openHotspotSettings()
                        launchRelay()
                    }
                }
            }
        }
    }

    private fun launchRelay() {
        appendLog("מפעיל שירות ממסר...")
        SosEmergencyRelayService.start(this)
        SosEmergencyState.isRelayRunning = true
        relayStatusView.text = "ממסר פעיל ✓"
        Toast.makeText(this, R.string.emergency_relay_started, Toast.LENGTH_SHORT).show()
    }

    private fun ensureLocationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val needed = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed.add(Manifest.permission.NEARBY_WIFI_DEVICES)
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), 2201)
        }
    }

    private fun openHotspotSettings() {
        val attempts = listOf(
            Intent("android.settings.TETHER_SETTINGS"),
            Intent(Settings.ACTION_WIRELESS_SETTINGS),
            Intent(Settings.ACTION_WIFI_SETTINGS)
        )
        for (intent in attempts) {
            try {
                startActivity(intent)
                return
            } catch (_: Exception) {
            }
        }
        Toast.makeText(this, "פתח ידנית: נקודה חמה / Hotspot", Toast.LENGTH_LONG).show()
    }

    private fun copyText(label: String, value: String, toastRes: Int) {
        val cm = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText(label, value))
        Toast.makeText(this, toastRes, Toast.LENGTH_SHORT).show()
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

        val hotspot = SosWifiBootstrap.isHotspotActive(this)
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
        val peers = SosEmergencyState.sharedPeers.joinToString(",").ifBlank { "-" }
        val names = SosEmergencyState.peerProfiles.values.joinToString(";") { p ->
            val label = p.name.ifBlank { p.pubkey.take(8).ifBlank { "-" } }
            "${p.ip}:$label"
        }.ifBlank { "-" }
        return "SNAPSHOT ${timeFmt.format(Date())}" +
            " ip=${SosEmergencyState.myIp ?: "-"}" +
            " ssid=${SosEmergencySetup.stationSsid(this)}" +
            " parent=${SosEmergencyState.sharedParentIp ?: "-"}" +
            " children=${SosEmergencyState.childCount}" +
            " peers=$peers" +
            " names=$names" +
            " hotspot=${if (SosWifiBootstrap.isHotspotActive(this)) "on" else "off"}" +
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
