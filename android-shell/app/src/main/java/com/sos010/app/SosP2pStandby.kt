package com.sos010.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/**
 * שמירת זמינות P2P במצב המתנה ב-APK:
 * כשה-WebView ברקע – מחממים אותו תקופתית / על סיגנל 25055 כדי לחדש DataChannel.
 * משתמש בריליים הקיימים (בלי תשתית חדשה).
 */
object SosP2pStandby {
    private const val TAG = "SosP2pStandby"
    private const val TICK_MS = 45_000L
    private const val MIN_WARM_GAP_MS = 35_000L
    private const val WAKE_MS = 12_000L

    private val handler = Handler(Looper.getMainLooper())
    @Volatile private var started = false
    @Volatile private var lastWarmAt = 0L
    private var wakeLock: PowerManager.WakeLock? = null

    private val tickRunnable = object : Runnable {
        override fun run() {
            try {
                // instance context via application from last ensure
                val ctx = appRef
                if (ctx != null) maybeWarm(ctx, peer = null, reason = "tick")
            } finally {
                if (started) handler.postDelayed(this, TICK_MS)
            }
        }
    }

    @Volatile private var appRef: Context? = null

    fun ensureStarted(context: Context) {
        appRef = context.applicationContext
        if (started) return
        started = true
        handler.removeCallbacks(tickRunnable)
        handler.postDelayed(tickRunnable, TICK_MS)
        Log.i(TAG, "P2P standby ticker started")
    }

    fun stop() {
        started = false
        handler.removeCallbacks(tickRunnable)
        releaseWake()
    }

    fun maybeWarm(context: Context, peer: String?, reason: String) {
        val app = context.applicationContext
        if (!SosSessionStore.isP2pStandbyEnabled(app)) return
        if (MainActivity.isHostAlive) return
        val now = System.currentTimeMillis()
        if (now - lastWarmAt < MIN_WARM_GAP_MS && peer.isNullOrBlank()) return
        lastWarmAt = now
        acquireWake(app)
        val target = peer?.takeIf { it.matches(Regex("^[0-9a-f]{64}$")) }
            ?: SosSessionStore.getP2pPeers(app).firstOrNull()
        Log.i(TAG, "warm host reason=$reason peer=${target?.take(8) ?: "-"}")
        MainActivity.warmHostForP2p(app, target)
        handler.postDelayed({ releaseWake() }, WAKE_MS)
    }

    private fun acquireWake(context: Context) {
        try {
            if (wakeLock?.isHeld == true) return
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sos:p2p-standby").also {
                it.setReferenceCounted(false)
                it.acquire(WAKE_MS)
            }
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
