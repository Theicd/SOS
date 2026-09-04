package com.sos010.app

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.ScanResult
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.ContextCompat

/**
 * סריקה והחלטה: להתחבר ל-SOS-* או להישאר/לבקש נקודה חמה | HYPER CORE TECH
 * לא נוגע בשירות ההתראות / SosForegroundService.
 */
object SosWifiBootstrap {
    enum class Result {
        ALREADY_LINKED,
        JOINED,
        NONE_FOUND,
        CONNECT_FAILED,
        YIELD_NEEDED
    }

    /** רשת SOS לתצוגה במסך החיבור | HYPER CORE TECH */
    data class SosNetworkItem(
        val ssid: String,
        val signalDbm: Int,
        val signalBars: Int,
        val childCount: Int?,
        val maxChildren: Int,
        val available: Boolean,
        val isCurrentConnection: Boolean
    )

    data class ScanReport(
        val items: List<SosNetworkItem>,
        val locationOn: Boolean,
        val permissionOk: Boolean,
        val wifiOn: Boolean,
        val hotspotOn: Boolean,
        val startScanOk: Boolean,
        val rawCount: Int,
        val blockedReason: String?
    )

    private const val DISCOVERY_STALE_MS = 30_000L
    const val MIN_CONNECT_DBM = -80

    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var heldCallback: ConnectivityManager.NetworkCallback? = null
    @Volatile private var heldCm: ConnectivityManager? = null
    @Volatile private var connectingCallback: ConnectivityManager.NetworkCallback? = null
    @Volatile private var pendingTimeout: Runnable? = null

    fun hasScanPermission(context: Context): Boolean {
        val loc = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return loc
        val nearby = ContextCompat.checkSelfPermission(
            context, Manifest.permission.NEARBY_WIFI_DEVICES
        ) == PackageManager.PERMISSION_GRANTED
        return loc && nearby
    }

    fun currentSsid(context: Context): String? {
        val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION")
        val info = wm.connectionInfo ?: return null
        return cleanSsid(info.ssid)
    }

    fun isHotspotActive(context: Context): Boolean {
        val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        return try {
            val method = wm.javaClass.getDeclaredMethod("isWifiApEnabled")
            method.isAccessible = true
            method.invoke(wm) as Boolean
        } catch (_: Exception) {
            false
        }
    }

    fun isLocationEnabled(context: Context): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
                lm.isLocationEnabled
            } else {
                @Suppress("DEPRECATION")
                Settings.Secure.getInt(
                    context.contentResolver,
                    Settings.Secure.LOCATION_MODE,
                    Settings.Secure.LOCATION_MODE_OFF
                ) != Settings.Secure.LOCATION_MODE_OFF
            }
        } catch (_: Exception) {
            false
        }
    }

    /** מחובר לרשת SOS זרה — לא נקודה חמה שלי | HYPER CORE TECH */
    fun isLinkedToSos(context: Context): Boolean {
        val own = SosEmergencySetup.stationSsid(context)
        return isForeignSos(currentSsid(context), own)
    }

    fun scanSosNetworks(context: Context): List<ScanResult> {
        val own = SosEmergencySetup.stationSsid(context)
        return readSosResults(context, own, hiddenChildSsids())
    }

    /**
     * סריקה + סינון: לא שלי, לא ילדים שכבר מחוברים אלי, לא מלא.
     * לא מכבה נקודה חמה. | HYPER CORE TECH
     */
    fun scanAvailableNetworks(context: Context, onDone: (ScanReport) -> Unit) {
        scanAvailableNetworks(context, radioScan = true, onDone)
    }

    fun scanAvailableNetworks(context: Context, radioScan: Boolean, onDone: (ScanReport) -> Unit) {
        val app = context.applicationContext
        val own = SosEmergencySetup.stationSsid(app)
        val current = currentSsid(app)
        val hidden = hiddenChildSsids()
        val locationOn = isLocationEnabled(app)
        val permissionOk = hasScanPermission(app)
        val hotspotOn = isHotspotActive(app)
        val wm = app.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val wifiOn = try { wm.isWifiEnabled } catch (_: Exception) { false }
        if (!locationOn) {
            SosDebugLog.w("emergency", "scan blocked: location off")
            completeReport(
                onDone,
                ScanReport(
                    items = mergeDiscoveryItems(emptyList(), own, current, hidden),
                    locationOn = false,
                    permissionOk = permissionOk,
                    wifiOn = wifiOn,
                    hotspotOn = hotspotOn,
                    startScanOk = false,
                    rawCount = 0,
                    blockedReason = "location"
                )
            )
            return
        }
        if (!permissionOk) {
            completeReport(
                onDone,
                ScanReport(
                    items = emptyList(),
                    locationOn = true,
                    permissionOk = false,
                    wifiOn = wifiOn,
                    hotspotOn = hotspotOn,
                    startScanOk = false,
                    rawCount = 0,
                    blockedReason = "permission"
                )
            )
            return
        }
        tryEnableWifi(app)
        scanSosAsync(app, own, hidden, radioScan) { results, startOk, rawCount ->
            val fromWifi = results.mapNotNull { result ->
                toNetworkItem(cleanSsid(result.SSID), result.level, current, own, hidden)
            }
            val items = mergeDiscoveryItems(fromWifi, own, current, hidden)
            SosDebugLog.i(
                "emergency",
                "scan raw=$rawCount sos=${items.size} start=$startOk hotspot=$hotspotOn"
            )
            completeReport(
                onDone,
                ScanReport(
                    items = items,
                    locationOn = true,
                    permissionOk = true,
                    wifiOn = wifiOn,
                    hotspotOn = hotspotOn,
                    startScanOk = startOk,
                    rawCount = rawCount,
                    blockedReason = null
                )
            )
        }
    }

    /** נקודה להתחברות אוטומטית: עץ קיים קודם, אחר כך האות החזק | HYPER CORE TECH */
    fun pickAutoConnectTarget(items: List<SosNetworkItem>, minDbm: Int = MIN_CONNECT_DBM): SosNetworkItem? {
        val candidates = items.filter { item ->
            item.available &&
                !item.isCurrentConnection &&
                item.signalDbm >= minDbm &&
                !isBlockedTarget(item.ssid)
        }
        if (candidates.isEmpty()) return null
        val inTree = candidates.filter { (it.childCount ?: 0) > 0 }
        val pool = if (inTree.isNotEmpty()) inTree else candidates
        return pool.maxByOrNull { it.signalDbm }
    }

    /** חיבור ידני ממסך הסריקה — לא משפיע על prepareForRelay | HYPER CORE TECH */
    fun connectToNetwork(context: Context, ssid: String, onDone: (Result) -> Unit) {
        val own = SosEmergencySetup.stationSsid(context)
        if (ssid.equals(own, ignoreCase = true)) {
            complete(onDone, Result.ALREADY_LINKED)
            return
        }
        if (isBlockedTarget(ssid)) {
            SosDebugLog.w("emergency", "block connect to $ssid — already on our hotspot")
            complete(onDone, Result.CONNECT_FAILED)
            return
        }
        if (isForeignSos(currentSsid(context), own) &&
            ssid.equals(currentSsid(context), ignoreCase = true)
        ) {
            complete(onDone, Result.ALREADY_LINKED)
            return
        }
        connectToSos(context, ssid, SosEmergencyState.NETWORK_PASSWORD, onDone)
    }

    /** ממסר בלבד — לא מכבה נקודה חמה ולא מחפש רשת כתחליף | HYPER CORE TECH */
    fun prepareForRelay(context: Context, onDone: (Result) -> Unit) {
        complete(onDone, Result.ALREADY_LINKED)
    }

    private fun scanSosAsync(
        context: Context,
        own: String,
        hidden: Set<String> = hiddenChildSsids(),
        radioScan: Boolean = true,
        onResults: (List<ScanResult>, Boolean, Int) -> Unit
    ) {
        val cached = readSosResults(context, own, hidden)
        val cachedRaw = rawScanCount(context)
        if (!radioScan || !hasScanPermission(context)) {
            mainHandler.post { onResults(cached, false, cachedRaw) }
            return
        }
        val app = context.applicationContext
        val wm = app.getSystemService(Context.WIFI_SERVICE) as WifiManager
        var finished = false
        var startOk = false
        lateinit var timeout: Runnable
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                finishScan()
            }
            fun finishScan() {
                if (finished) return
                finished = true
                mainHandler.removeCallbacks(timeout)
                try {
                    app.unregisterReceiver(this)
                } catch (_: Exception) {
                }
                mainHandler.post {
                    onResults(readSosResults(app, own, hidden), startOk, rawScanCount(app))
                }
            }
        }
        timeout = Runnable { receiver.finishScan() }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                app.registerReceiver(
                    receiver,
                    IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION),
                    Context.RECEIVER_NOT_EXPORTED
                )
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                app.registerReceiver(receiver, IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION))
            }
        } catch (_: Exception) {
            mainHandler.post { onResults(cached, false, cachedRaw) }
            return
        }
        mainHandler.postDelayed(timeout, 5000L)
        startOk = try {
            @Suppress("DEPRECATION")
            wm.startScan()
        } catch (e: SecurityException) {
            SosDebugLog.w("emergency", "startScan denied: ${e.message}")
            false
        } catch (_: Exception) {
            false
        }
        if (!startOk) {
            mainHandler.postDelayed({ receiver.finishScan() }, 800L)
        }
    }

    private fun readSosResults(context: Context, own: String, hidden: Set<String>): List<ScanResult> {
        val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        return try {
            @Suppress("DEPRECATION")
            wm.scanResults
                .orEmpty()
                .filter { result ->
                    val ssid = cleanSsid(result.SSID) ?: return@filter false
                    SosEmergencySetup.isSosSsid(ssid) &&
                        !ssid.equals(own, ignoreCase = true) &&
                        hidden.none { it.equals(ssid, ignoreCase = true) }
                }
                .sortedByDescending { it.level }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun hiddenChildSsids(): Set<String> {
        val hidden = linkedSetOf<String>()
        hidden.addAll(SosEmergencyState.hiddenChildSsids)
        for (ip in SosEmergencyState.relayChildIps) {
            val pk = SosEmergencyState.peerProfiles[ip]?.pubkey.orEmpty()
            SosEmergencySetup.ssidFromPubkey(pk)?.let { hidden.add(it) }
        }
        for (entry in SosEmergencyState.discoveryBySsid.values) {
            if (isClientOnMyHotspot(entry.ip) || SosEmergencyState.relayChildIps.contains(entry.ip)) {
                hidden.add(entry.ssid)
                SosEmergencyState.rememberDownstreamSsid(entry.ssid)
            }
        }
        return hidden
    }

    fun isBlockedTarget(ssid: String): Boolean {
        return hiddenChildSsids().any { it.equals(ssid, ignoreCase = true) }
    }

    /** IP על רשת הנקודה החמה שלי = כבר מחובר אלי — לא מתחברים חזרה | HYPER CORE TECH */
    fun isClientOnMyHotspot(ip: String?): Boolean {
        if (ip.isNullOrBlank()) return false
        val ap = hotspotIpv4() ?: return false
        return sameSlash24(ap, ip)
    }

    /** כרטיס לקוח (wlan0) קודם — לא כתובת הנקודה החמה | HYPER CORE TECH */
    fun preferredMeshIpv4(): String? {
        var station: String? = null
        var ap: String? = null
        var fallback: String? = null
        try {
            val interfaces = java.net.NetworkInterface.getNetworkInterfaces() ?: return null
            while (interfaces.hasMoreElements()) {
                val intf = interfaces.nextElement()
                if (!intf.isUp || intf.isLoopback) continue
                val name = intf.name.lowercase()
                val looksAp = name.contains("ap") || name.contains("swlan") ||
                    name.contains("softap") || name == "wlan1"
                val addrs = intf.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (addr !is java.net.Inet4Address) continue
                    val ip = addr.hostAddress ?: continue
                    val looksStation = name == "wlan0" || (name.contains("wlan") && !looksAp)
                    when {
                        looksAp -> if (ap == null) ap = ip
                        looksStation -> if (station == null) station = ip
                        fallback == null -> fallback = ip
                    }
                }
            }
        } catch (_: Exception) {
        }
        return station ?: ap ?: fallback
    }

    fun hotspotIpv4(): String? {
        return try {
            val interfaces = java.net.NetworkInterface.getNetworkInterfaces() ?: return null
            while (interfaces.hasMoreElements()) {
                val intf = interfaces.nextElement()
                if (!intf.isUp || intf.isLoopback) continue
                val name = intf.name.lowercase()
                val looksAp = name.contains("ap") || name.contains("swlan") ||
                    name.contains("softap") || name == "wlan1"
                if (!looksAp) continue
                val addrs = intf.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (addr is java.net.Inet4Address) {
                        return addr.hostAddress
                    }
                }
            }
            null
        } catch (_: Exception) {
            null
        }
    }

    private fun sameSlash24(a: String, b: String): Boolean {
        val pa = a.split('.')
        val pb = b.split('.')
        if (pa.size != 4 || pb.size != 4) return false
        return pa[0] == pb[0] && pa[1] == pb[1] && pa[2] == pb[2]
    }

    private fun discoveryForSsid(ssid: String): SosEmergencyState.SosDiscoveryEntry? {
        val entry = SosEmergencyState.discoveryBySsid[ssid] ?: return null
        if (System.currentTimeMillis() - entry.lastSeenMs > DISCOVERY_STALE_MS) return null
        return entry
    }

    private fun signalBars(level: Int): Int {
        return when {
            level >= -50 -> 4
            level >= -60 -> 3
            level >= -70 -> 2
            else -> 1
        }
    }

    private fun rawScanCount(context: Context): Int {
        return try {
            val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            wm.scanResults.orEmpty().size
        } catch (_: Exception) {
            0
        }
    }

    private fun toNetworkItem(
        ssid: String?,
        level: Int,
        current: String?,
        own: String,
        hidden: Set<String>
    ): SosNetworkItem? {
        if (ssid.isNullOrBlank()) return null
        if (ssid.equals(own, ignoreCase = true)) return null
        if (hidden.any { it.equals(ssid, ignoreCase = true) }) return null
        if (!SosEmergencySetup.isSosSsid(ssid)) return null
        val discovery = discoveryForSsid(ssid)
        val max = discovery?.maxChildren ?: SosEmergencyState.MAX_CHILDREN
        val count = discovery?.childCount
        if (count != null && count >= max) return null
        return SosNetworkItem(
            ssid = ssid,
            signalDbm = level,
            signalBars = signalBars(level),
            childCount = count,
            maxChildren = max,
            available = true,
            isCurrentConnection = ssid.equals(current, ignoreCase = true)
        )
    }

    private fun mergeDiscoveryItems(
        fromWifi: List<SosNetworkItem>,
        own: String,
        current: String?,
        hidden: Set<String>
    ): List<SosNetworkItem> {
        val bySsid = linkedMapOf<String, SosNetworkItem>()
        fromWifi.forEach { bySsid[it.ssid.uppercase()] = it }
        val now = System.currentTimeMillis()
        for (entry in SosEmergencyState.discoveryBySsid.values) {
            if (now - entry.lastSeenMs > DISCOVERY_STALE_MS) continue
            val key = entry.ssid.uppercase()
            if (bySsid.containsKey(key)) continue
            toNetworkItem(entry.ssid, -65, current, own, hidden)?.let { bySsid[key] = it }
        }
        return bySsid.values.sortedWith(
            compareByDescending<SosNetworkItem> { it.isCurrentConnection }
                .thenByDescending { it.signalDbm }
        )
    }

    private fun completeReport(onDone: (ScanReport) -> Unit, report: ScanReport) {
        mainHandler.post { onDone(report) }
    }

    private fun connectToSos(
        context: Context,
        ssid: String,
        password: String,
        onDone: (Result) -> Unit
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            complete(onDone, Result.NONE_FOUND)
            return
        }
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        clearPending()
        releaseHeld(cm)

        val specifier = WifiNetworkSpecifier.Builder()
            .setSsid(ssid)
            .setWpa2Passphrase(password)
            .build()
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .setNetworkSpecifier(specifier)
            .build()

        var finished = false
        lateinit var callback: ConnectivityManager.NetworkCallback
        fun finish(result: Result) {
            if (finished) return
            finished = true
            clearPending()
            if (result != Result.JOINED) {
                try {
                    cm.unregisterNetworkCallback(callback)
                } catch (_: Exception) {
                }
                connectingCallback = null
            }
            complete(onDone, result)
        }

        callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                try {
                    cm.bindProcessToNetwork(network)
                } catch (_: Exception) {
                }
                heldCallback = this
                heldCm = cm
                connectingCallback = null
                finish(Result.JOINED)
            }

            override fun onUnavailable() {
                finish(Result.CONNECT_FAILED)
            }
        }
        connectingCallback = callback

        val timeout = Runnable { finish(Result.CONNECT_FAILED) }
        pendingTimeout = timeout
        mainHandler.postDelayed(timeout, 20_000L)
        try {
            cm.requestNetwork(request, callback)
        } catch (_: Exception) {
            finish(Result.CONNECT_FAILED)
        }
    }

    private fun tryStopHotspot(context: Context): Boolean {
        if (!isHotspotActive(context)) return true
        val app = context.applicationContext
        val wm = app.getSystemService(Context.WIFI_SERVICE) as WifiManager
        try {
            val method = wm.javaClass.getMethod(
                "setWifiApEnabled",
                WifiConfiguration::class.java,
                Boolean::class.javaPrimitiveType
            )
            method.invoke(wm, null, false)
        } catch (_: Exception) {
        }
        try {
            val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val stop = cm.javaClass.getDeclaredMethod("stopTethering", Int::class.javaPrimitiveType)
            stop.isAccessible = true
            stop.invoke(cm, 0)
        } catch (_: Exception) {
        }
        return !isHotspotActive(app)
    }

    private fun tryEnableWifi(context: Context) {
        try {
            val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            wm.isWifiEnabled = true
        } catch (_: Exception) {
        }
    }

    private fun shouldYield(otherSsid: String, ownSsid: String): Boolean {
        return otherSsid.compareTo(ownSsid, ignoreCase = true) < 0
    }

    private fun isForeignSos(current: String?, own: String): Boolean {
        val ssid = current ?: return false
        if (!SosEmergencySetup.isSosSsid(ssid)) return false
        return !ssid.equals(own, ignoreCase = true)
    }

    private fun cleanSsid(raw: String?): String? {
        val ssid = raw?.trim()?.removeSurrounding("\"")?.trim().orEmpty()
        if (ssid.isEmpty() || ssid == "<unknown ssid>" || ssid.equals("0x", true)) return null
        return ssid
    }

    private fun complete(onDone: (Result) -> Unit, result: Result) {
        mainHandler.post { onDone(result) }
    }

    private fun completeList(onResults: (List<ScanResult>) -> Unit, results: List<ScanResult>) {
        mainHandler.post { onResults(results) }
    }

    private fun completeNetworkList(onDone: (List<SosNetworkItem>) -> Unit, items: List<SosNetworkItem>) {
        mainHandler.post { onDone(items) }
    }

    private fun clearPending() {
        pendingTimeout?.let { mainHandler.removeCallbacks(it) }
        pendingTimeout = null
    }

    private fun releaseHeld(cm: ConnectivityManager) {
        val prev = heldCallback
        if (prev != null) {
            try {
                cm.unregisterNetworkCallback(prev)
            } catch (_: Exception) {
            }
        }
        heldCallback = null
        heldCm = null
        try {
            cm.bindProcessToNetwork(null)
        } catch (_: Exception) {
        }
    }
}
