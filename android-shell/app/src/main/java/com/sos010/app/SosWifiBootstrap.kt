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
import android.os.Build
import android.os.Handler
import android.os.Looper
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

    fun isLinkedToSos(context: Context): Boolean {
        if (isHotspotActive(context)) return true
        return SosEmergencySetup.isSosSsid(currentSsid(context))
    }

    fun scanSosNetworks(context: Context): List<ScanResult> {
        val own = SosEmergencySetup.stationSsid(context)
        return readSosResults(context, own)
    }

    fun prepareForRelay(context: Context, onDone: (Result) -> Unit) {
        val app = context.applicationContext
        val own = SosEmergencySetup.stationSsid(app)
        if (isForeignSos(currentSsid(app), own)) {
            complete(onDone, Result.ALREADY_LINKED)
            return
        }
        scanSosAsync(app, own) { others ->
            decide(app, own, others, allowRescan = true, onDone)
        }
    }

    private fun decide(
        app: Context,
        own: String,
        others: List<ScanResult>,
        allowRescan: Boolean,
        onDone: (Result) -> Unit
    ) {
        val best = others.firstOrNull()
        val hotspot = isHotspotActive(app)
        if (best != null) {
            val other = cleanSsid(best.SSID).orEmpty()
            if (other.isEmpty()) {
                complete(onDone, if (hotspot) Result.ALREADY_LINKED else Result.NONE_FOUND)
                return
            }
            if (hotspot) {
                if (shouldYield(other, own)) {
                    if (tryStopHotspot(app)) {
                        tryEnableWifi(app)
                        connectToSos(app, other, SosEmergencyState.NETWORK_PASSWORD, onDone)
                    } else {
                        complete(onDone, Result.YIELD_NEEDED)
                    }
                } else {
                    complete(onDone, Result.ALREADY_LINKED)
                }
                return
            }
            connectToSos(app, other, SosEmergencyState.NETWORK_PASSWORD, onDone)
            return
        }
        if (hotspot) {
            complete(onDone, Result.ALREADY_LINKED)
            return
        }
        if (allowRescan) {
            mainHandler.postDelayed({
                scanSosAsync(app, own) { round2 ->
                    decide(app, own, round2, allowRescan = false, onDone)
                }
            }, 4000L)
            return
        }
        complete(onDone, Result.NONE_FOUND)
    }

    private fun scanSosAsync(context: Context, own: String, onResults: (List<ScanResult>) -> Unit) {
        val cached = readSosResults(context, own)
        if (!hasScanPermission(context)) {
            completeList(onResults, cached)
            return
        }
        val app = context.applicationContext
        val wm = app.getSystemService(Context.WIFI_SERVICE) as WifiManager
        var finished = false
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
                completeList(onResults, readSosResults(app, own))
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
            completeList(onResults, cached)
            return
        }
        mainHandler.postDelayed(timeout, 5000L)
        val started = try {
            @Suppress("DEPRECATION")
            wm.startScan()
        } catch (_: Exception) {
            false
        }
        if (!started) {
            mainHandler.postDelayed({ receiver.finishScan() }, 800L)
        }
    }

    private fun readSosResults(context: Context, own: String): List<ScanResult> {
        val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        return try {
            @Suppress("DEPRECATION")
            wm.scanResults
                .orEmpty()
                .filter { result ->
                    val ssid = cleanSsid(result.SSID) ?: return@filter false
                    SosEmergencySetup.isSosSsid(ssid) && !ssid.equals(own, ignoreCase = true)
                }
                .sortedByDescending { it.level }
        } catch (_: Exception) {
            emptyList()
        }
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
