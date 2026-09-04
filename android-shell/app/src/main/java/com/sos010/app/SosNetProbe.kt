package com.sos010.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * בדיקת אינטרנט חיצוני במעטפת בלבד.
 * Wi‑Fi / נקודה חמה SOS ≠ אינטרנט. | HYPER CORE TECH
 */
object SosNetProbe {
    private const val PROBE_URL = "https://www.google.com/generate_204"
    private const val PROBE_MS = 2500
    private const val CACHE_MS = 4_000L
    private val io = Executors.newSingleThreadExecutor()

    @Volatile private var lastOk = false
    @Volatile private var lastAt = 0L

    fun hasExternalInternet(context: Context): Boolean {
        val now = System.currentTimeMillis()
        if (now - lastAt < CACHE_MS) return lastOk
        lastOk = hasValidatedInternet(context)
        lastAt = now
        return lastOk
    }

    fun refreshAsync(context: Context) {
        val app = context.applicationContext
        io.execute {
            val validated = hasValidatedInternet(app)
            lastOk = validated || (!validated && hasInternetCapability(app) && probeGenerate204())
            lastAt = System.currentTimeMillis()
            SosDebugLog.i("shell", "net probe ok=$lastOk validated=$validated")
        }
    }

    private fun hasValidatedInternet(context: Context): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return false
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        } else {
            true
        }
    }

    private fun hasInternetCapability(context: Context): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return false
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun probeGenerate204(): Boolean {
        return try {
            val conn = (URL(PROBE_URL).openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = PROBE_MS
                readTimeout = PROBE_MS
                requestMethod = "GET"
                useCaches = false
            }
            val code = try {
                conn.responseCode
            } finally {
                conn.disconnect()
            }
            code == 204 || code == 200
        } catch (_: Exception) {
            false
        }
    }
}
