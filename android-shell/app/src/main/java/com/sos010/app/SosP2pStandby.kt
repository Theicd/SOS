package com.sos010.app

import android.content.Context
import android.util.Log

/**
 * תיאום P2P מול מצב ה-UI:
 * - Activity חיה (גם ברקע / Home) → WebView מנהל P2P
 * - כרטיסייה סגורה → רק התראות (RelayWatcher); בלי Native WebRTC
 */
object SosP2pStandby {
    private const val TAG = "SosP2pStandby"

    fun ensureStarted(context: Context) {
        SosSessionStore.isP2pStandbyEnabled(context)
    }

    /** חזרה לממשק – Native יוצא אם היה; WebView שולט | HYPER CORE TECH */
    fun onHostForeground() {
        SosNativeP2pEngine.onUiActive()
    }

    /** כרטיסייה נסגרה – סוגרים Native ומשאירים רק התראות | HYPER CORE TECH */
    fun onActivityDestroyed(context: Context) {
        SosNativeP2pEngine.onUiActive()
        Log.i(TAG, "card closed – alerts only (no native P2P)")
        SosDebugLog.i("p2p", "card closed – alerts only (no native P2P)")
    }

    fun onHostBackground(context: Context) {
        if (MainActivity.isActivityAlive) return
        onActivityDestroyed(context)
    }

    /** סיגנלי 25055 כשאין Activity – מתעלמים (P2P רק ב-WebView) | HYPER CORE TECH */
    fun onSignal(context: Context, author: String, signalType: String, event: org.json.JSONObject) {
        if (MainActivity.isActivityAlive) return
        SosDebugLog.i("p2p", "ignore signal $signalType from=${author.take(8)} (card closed)")
    }

    /**
     * כש-Activity חיה – מעירים WebView.
     * כשכרטיס סגור – לא מדליקים Native (שומר על תהליך ההתראות).
     */
    fun warmForPeer(context: Context, peer: String?, reason: String) {
        if (!SosSessionStore.isP2pStandbyEnabled(context)) return
        val pk = peer?.trim()?.lowercase().orEmpty()
        if (!pk.matches(Regex("^[0-9a-f]{64}$"))) return

        if (MainActivity.isHostAlive) return

        if (MainActivity.isActivityAlive) {
            MainActivity.pumpWebViewKeepAlive()
            SosDebugLog.i("p2p", "activity alive – WebView pump reason=$reason")
            return
        }

        SosDebugLog.i("p2p", "skip warm (card closed) peer=${pk.take(8)} reason=$reason")
    }

    fun maybeWarm(context: Context, peer: String?, reason: String) =
        warmForPeer(context, peer, reason)

    fun stop() {
        SosNativeP2pEngine.onUiActive()
    }
}
