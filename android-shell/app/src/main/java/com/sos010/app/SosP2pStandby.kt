package com.sos010.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/**
 * שמירת P2P:
 * - כרטיסייה קיימת (גם ברקע / מסך כבוי) → WebView בלבד
 * - כרטיסייה נסגרה (onDestroy) → Native WebRTC ב-FGS
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
                // Native רק כשאין Activity – אחרת ה-WebView מנהל | HYPER CORE TECH
                if (wanted && ctx != null && !MainActivity.isActivityAlive) {
                    acquireWake(ctx)
                    SosNativeP2pEngine.ensureStarted(ctx)
                    SosNativeP2pEngine.onCardClosed(ctx)
                }
            } finally {
                if (wanted) mainHandler.postDelayed(this, NUDGE_MS)
            }
        }
    }

    fun ensureStarted(context: Context) {
        appRef = context.applicationContext
        wanted = SosSessionStore.isP2pStandbyEnabled(context)
        mainHandler.removeCallbacks(nudgeRunnable)
        if (!wanted) return
        // לא מפעילים Native כל עוד הכרטיסייה חיה | HYPER CORE TECH
        if (MainActivity.isActivityAlive) return
        mainHandler.postDelayed(nudgeRunnable, NUDGE_MS)
        SosNativeP2pEngine.ensureStarted(context)
    }

    /** חזרה לממשק – סוגרים Native כדי לא לכפול DC עם WebView | HYPER CORE TECH */
    fun onHostForeground() {
        SosNativeP2pEngine.onUiActive()
        releaseWake()
        mainHandler.removeCallbacks(nudgeRunnable)
    }

    /** הכרטיסייה נסגרה מההיסטוריה – מעבירים ל-Native | HYPER CORE TECH */
    fun onActivityDestroyed(context: Context) {
        appRef = context.applicationContext
        wanted = SosSessionStore.isP2pStandbyEnabled(context)
        if (!wanted) return
        Log.i(TAG, "activity destroyed → native P2P")
        SosDebugLog.i("p2p", "activity destroyed → native start")
        acquireWake(context)
        SosNativeP2pEngine.ensureStarted(context)
        SosNativeP2pEngine.onCardClosed(context)
        mainHandler.removeCallbacks(nudgeRunnable)
        mainHandler.postDelayed(nudgeRunnable, NUDGE_MS)
    }

    /** @deprecated שם ישן – מפנה ל-onActivityDestroyed */
    fun onHostBackground(context: Context) {
        if (MainActivity.isActivityAlive) {
            Log.i(TAG, "skip native – activity still alive")
            return
        }
        onActivityDestroyed(context)
    }

    fun maybeWarm(context: Context, peer: String?, reason: String) {
        if (MainActivity.isActivityAlive) return
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
        SosNativeP2pEngine.onCardClosed(context)
    }

    fun stop() {
        wanted = false
        mainHandler.removeCallbacks(nudgeRunnable)
        SosNativeP2pEngine.onUiActive()
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
