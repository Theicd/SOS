package com.sos010.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/**
 * P2P on-demand (לא ניטור קבוע):
 * - התראות הודעה/שיחה = SosRelayWatcher ב-FGS (כמו גרסת הגיבוי)
 * - כשמגיעה התראה / סיגנל ל-peer – מחממים WebView ברקע לאותו peer בלבד
 * - לא מרימים Native WebRTC לכל ה-peers אחרי onDestroy (מונע OOM/קריסה)
 */
object SosP2pStandby {
    private const val TAG = "SosP2pStandby"
    private const val WAKE_MS = 60_000L
    private const val WARM_DEBOUNCE_MS = 8_000L

    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var appRef: Context? = null
    @Volatile private var wanted = true
    private var wakeLock: PowerManager.WakeLock? = null
    private val lastWarmAt = HashMap<String, Long>()

    /** שמירת דגל בלבד – לא מפעיל Native / reconnect גלובלי | HYPER CORE TECH */
    fun ensureStarted(context: Context) {
        appRef = context.applicationContext
        wanted = SosSessionStore.isP2pStandbyEnabled(context)
    }

    /** חזרה לממשק – משחררים Native אם היה | HYPER CORE TECH */
    fun onHostForeground() {
        SosNativeP2pEngine.onUiActive()
        releaseWake()
    }

    /**
     * כרטיסייה נסגרה – ממשיכים רק התראות (Relay/FGS).
     * P2P יופעל on-demand כשתגיע הודעה/סיגנל ל-peer.
     */
    fun onActivityDestroyed(context: Context) {
        appRef = context.applicationContext
        wanted = SosSessionStore.isP2pStandbyEnabled(context)
        SosNativeP2pEngine.onUiActive()
        releaseWake()
        Log.i(TAG, "card closed – alerts via relay; P2P on-demand only")
        SosDebugLog.i("p2p", "card closed – alerts only; P2P on-demand")
    }

    /** @deprecated שם ישן */
    fun onHostBackground(context: Context) {
        if (MainActivity.isActivityAlive) return
        onActivityDestroyed(context)
    }

    /**
     * מדליק P2P לפי צורך מול peer אחד:
     * מחמם WebView ברקע (יציב כמו warm לשיחה) במקום Native לכל העולם.
     */
    fun warmForPeer(context: Context, peer: String?, reason: String) {
        if (!wanted && !SosSessionStore.isP2pStandbyEnabled(context)) return
        wanted = true
        appRef = context.applicationContext
        val pk = peer?.trim()?.lowercase().orEmpty()
        if (!pk.matches(Regex("^[0-9a-f]{64}$"))) return

        val now = System.currentTimeMillis()
        synchronized(lastWarmAt) {
            val prev = lastWarmAt[pk] ?: 0L
            if (now - prev < WARM_DEBOUNCE_MS) return
            lastWarmAt[pk] = now
        }

        // שומרים את ה-peer ברשימה להמשך שיחה | HYPER CORE TECH
        val peers = SosSessionStore.getP2pPeers(context).toMutableList()
        if (!peers.contains(pk)) {
            peers.add(0, pk)
            while (peers.size > 12) peers.removeAt(peers.lastIndex)
            SosSessionStore.setP2pPeers(context, peers.joinToString(","))
        }

        Log.i(TAG, "on-demand warm peer=${pk.take(8)} reason=$reason")
        SosDebugLog.i("p2p", "on-demand warm peer=${pk.take(8)} reason=$reason")
        acquireWake(context)

        // אם הממשק בחזית – WebView כבר מנהל P2P
        if (MainActivity.isHostAlive) return

        // כרטיסייה עדיין חיה ברקע – WebView מנהל; לא מרימים Activity מחדש | HYPER CORE TECH
        if (MainActivity.isActivityAlive) {
            MainActivity.pumpWebViewKeepAlive()
            return
        }

        // כרטיסייה סגורה – חימום WebView ברקע לאותו peer | HYPER CORE TECH
        MainActivity.warmHostForP2p(context, pk)
    }

    /** תאימות לשם ישן */
    fun maybeWarm(context: Context, peer: String?, reason: String) =
        warmForPeer(context, peer, reason)

    fun stop() {
        wanted = false
        SosNativeP2pEngine.onUiActive()
        releaseWake()
    }

    private fun acquireWake(context: Context) {
        try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            val lock = wakeLock ?: pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sos:p2p-ondemand").also {
                it.setReferenceCounted(false)
                wakeLock = it
            }
            lock.acquire(WAKE_MS)
            mainHandler.postDelayed({ releaseWake() }, WAKE_MS)
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
