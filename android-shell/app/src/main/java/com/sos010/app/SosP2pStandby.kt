package com.sos010.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/**
 * שמירת P2P במצב המתנה – מפנה למנוע Native ב-FGS (בלי WebView/פיד).
 */
object SosP2pStandby {
    private const val TAG = "SosP2pStandby"
    private const val NUDGE_MS = 20_000L
    private const val WAKE_MS = 90_000L

    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var appRef: Context? = null
    @Volatile private var wanted = false
    private var wakeLock: PowerManager.WakeLock? = null

    private val nudgeRunnable = object : Runnable {
        override fun run() {
            try {
                val ctx = appRef
                if (wanted && ctx != null && !MainActivity.isHostAlive) {
                    acquireWake(ctx)
                    SosNativeP2pEngine.ensureStarted(ctx)
                    SosNativeP2pEngine.onHostBackground(ctx)
                }
            } finally {
                if (wanted) mainHandler.postDelayed(this, NUDGE_MS)
            }
        }
    }

    fun ensureStarted(context: Context) {
        appRef = context.applicationContext
        wanted = true
        mainHandler.removeCallbacks(nudgeRunnable)
        mainHandler.postDelayed(nudgeRunnable, NUDGE_MS)
        if (!MainActivity.isHostAlive) {
            SosNativeP2pEngine.ensureStarted(context)
        }
    }

    fun onHostForeground() {
        SosNativeP2pEngine.onHostForeground()
        releaseWake()
    }

    fun onHostBackground(context: Context) {
        appRef = context.applicationContext
        wanted = true
        Log.i(TAG, "host background → native P2P")
        acquireWake(context)
        SosNativeP2pEngine.onHostBackground(context)
        mainHandler.removeCallbacks(nudgeRunnable)
        mainHandler.postDelayed(nudgeRunnable, NUDGE_MS)
    }

    fun maybeWarm(context: Context, peer: String?, reason: String) {
        appRef = context.applicationContext
        wanted = true
        if (!peer.isNullOrBlank() && peer.matches(Regex("^[0-9a-f]{64}$"))) {
            val peers = SosSessionStore.getP2pPeers(context).toMutableList()
            if (!peers.contains(peer.lowercase())) {
                peers.add(0, peer.lowercase())
                SosSessionStore.setP2pPeers(context, peers.joinToString(","))
            }
        }
        Log.i(TAG, "warm reason=$reason peer=${peer?.take(8) ?: "-"}")
        acquireWake(context)
        SosNativeP2pEngine.ensureStarted(context)
        SosNativeP2pEngine.onHostBackground(context)
    }

    fun stop() {
        wanted = false
        mainHandler.removeCallbacks(nudgeRunnable)
        SosNativeP2pEngine.onHostForeground()
        releaseWake()
    }

    private fun acquireWake(context: Context) {
        try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            val lock = wakeLock ?: pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sos:p2p-native").also {
                it.setReferenceCounted(false)
                wakeLock = it
            }
            lock.acquire(WAKE_MS)
        } catch (err: Exception) {
            Log.w(TAG, "wake lock failed: ${err.message}")
        }
    }

    private fun releaseWake() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (_: Exception) {
        }
        wakeLock = null
    }
}
