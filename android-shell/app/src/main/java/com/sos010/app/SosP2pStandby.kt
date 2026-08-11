package com.sos010.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject

/**
 * P2P on-demand כשהכרטיסייה סגורה:
 * - התראות = RelayWatcher (יציב)
 * - סיגנל/הודעה ל-peer → Native WebRTC ל-peer אחד בלבד (לא warm Activity – חסום באנדרואיד)
 * - כרטיסייה חיה ברקע → WebView מנהל
 */
object SosP2pStandby {
    private const val TAG = "SosP2pStandby"
    private const val WAKE_MS = 90_000L
    private const val CONNECT_DEBOUNCE_MS = 4_000L

    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var appRef: Context? = null
    @Volatile private var wanted = true
    private var wakeLock: PowerManager.WakeLock? = null
    private val lastConnectAt = HashMap<String, Long>()

    fun ensureStarted(context: Context) {
        appRef = context.applicationContext
        wanted = SosSessionStore.isP2pStandbyEnabled(context)
    }

    /** חזרה לממשק – Native יוצא; WebView שולט | HYPER CORE TECH */
    fun onHostForeground() {
        SosNativeP2pEngine.onUiActive()
        releaseWake()
    }

    /**
     * כרטיסייה נסגרה – לא סוגרים Native מראש (צריך on-demand אחרי destroy).
     * גם לא מרימים את כל ה-peers.
     */
    fun onActivityDestroyed(context: Context) {
        appRef = context.applicationContext
        wanted = SosSessionStore.isP2pStandbyEnabled(context)
        releaseWake()
        Log.i(TAG, "card closed – alerts via relay; P2P native on-demand")
        SosDebugLog.i("p2p", "card closed – alerts only; P2P native on-demand")
    }

    fun onHostBackground(context: Context) {
        if (MainActivity.isActivityAlive) return
        onActivityDestroyed(context)
    }

    /** סיגנל 25055 כשאין Activity – מטפלים ב-Native | HYPER CORE TECH */
    fun onSignal(context: Context, author: String, signalType: String, event: JSONObject) {
        if (MainActivity.isActivityAlive) return
        if (!SosSessionStore.isP2pStandbyEnabled(context)) return
        wanted = true
        appRef = context.applicationContext
        rememberPeer(context, author)
        acquireWake(context)
        SosDebugLog.i("p2p", "native signal $signalType from=${author.take(8)}")
        SosNativeP2pEngine.onSignalEvent(context, author, signalType, event)
    }

    /**
     * אחרי התראת צ'אט / צורך בחיבור – מדליקים Native ל-peer אחד.
     * לא משתמשים ב-startActivity ברקע (חסום באנדרואיד).
     */
    fun warmForPeer(context: Context, peer: String?, reason: String) {
        if (!wanted && !SosSessionStore.isP2pStandbyEnabled(context)) return
        wanted = true
        appRef = context.applicationContext
        val pk = peer?.trim()?.lowercase().orEmpty()
        if (!pk.matches(Regex("^[0-9a-f]{64}$"))) return

        rememberPeer(context, pk)

        if (MainActivity.isHostAlive) return

        if (MainActivity.isActivityAlive) {
            MainActivity.pumpWebViewKeepAlive()
            SosDebugLog.i("p2p", "activity alive – WebView pump reason=$reason")
            return
        }

        val now = System.currentTimeMillis()
        synchronized(lastConnectAt) {
            val prev = lastConnectAt[pk] ?: 0L
            if (now - prev < CONNECT_DEBOUNCE_MS) return
            lastConnectAt[pk] = now
        }

        Log.i(TAG, "native on-demand peer=${pk.take(8)} reason=$reason")
        SosDebugLog.i("p2p", "native on-demand peer=${pk.take(8)} reason=$reason")
        acquireWake(context)
        SosNativeP2pEngine.connectPeer(context, pk)
    }

    fun maybeWarm(context: Context, peer: String?, reason: String) =
        warmForPeer(context, peer, reason)

    fun stop() {
        wanted = false
        SosNativeP2pEngine.onUiActive()
        releaseWake()
    }

    private fun rememberPeer(context: Context, peer: String) {
        val pk = peer.trim().lowercase()
        if (!pk.matches(Regex("^[0-9a-f]{64}$"))) return
        val peers = SosSessionStore.getP2pPeers(context).toMutableList()
        if (!peers.contains(pk)) {
            peers.add(0, pk)
            while (peers.size > 12) peers.removeAt(peers.lastIndex)
            SosSessionStore.setP2pPeers(context, peers.joinToString(","))
        }
    }

    private fun acquireWake(context: Context) {
        try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            val lock = wakeLock ?: pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sos:p2p-ondemand").also {
                it.setReferenceCounted(false)
                wakeLock = it
            }
            lock.acquire(WAKE_MS)
            mainHandler.removeCallbacks(releaseWakeRunnable)
            mainHandler.postDelayed(releaseWakeRunnable, WAKE_MS)
        } catch (err: Exception) {
            Log.w(TAG, "wake lock failed: ${err.message}")
        }
    }

    private val releaseWakeRunnable = Runnable { releaseWake() }

    private fun releaseWake() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (_: Exception) {
        }
        wakeLock = null
    }
}
