package com.sos010.app

import android.content.Context
import android.util.Log

/**
 * תיאום P2P: WebView מוכן = בעלים; אחרת Native אם standby דלוק. | HYPER CORE TECH
 */
object SosP2pStandby {
    private const val TAG = "SosP2pStandby"

    fun ensureStarted(context: Context) {
        SosSessionStore.isP2pStandbyEnabled(context)
    }

    fun onHostForeground() {
        SosP2pOwner.onUiForeground()
    }

    fun onActivityDestroyed(context: Context) {
        val standby = SosSessionStore.isP2pStandbyEnabled(context)
        SosP2pOwner.onActivityGone(standby)
        if (!standby) SosNativeP2pEngine.releaseForWebView()
        Log.i(TAG, "card closed – owner=${SosP2pOwner.kind}")
        SosDebugLog.i("p2p", "card closed – owner=${SosP2pOwner.kind}")
    }

    fun onHostBackground(context: Context) {
        if (MainActivity.isActivityAlive) return
        onActivityDestroyed(context)
    }

    fun onSignal(context: Context, author: String, signalType: String, event: org.json.JSONObject) {
        if (SosP2pOwner.kind == SosP2pOwnerKind.WEBVIEW) return
        if (!SosP2pOwner.nativeMayHandle()) return
        if (!SosSessionStore.isP2pStandbyEnabled(context)) return
        SosNativeP2pEngine.onSignalEvent(context, author, signalType, event)
    }

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

        if (SosP2pOwner.nativeMayHandle()) {
            SosNativeP2pEngine.connectPeer(context, pk)
            SosDebugLog.i("p2p", "native warm peer=${pk.take(8)} reason=$reason")
            return
        }
        SosDebugLog.i("p2p", "skip warm peer=${pk.take(8)} reason=$reason")
    }

    fun maybeWarm(context: Context, peer: String?, reason: String) =
        warmForPeer(context, peer, reason)

    fun stop() {
        SosP2pOwner.onActivityGone(standbyEnabled = false)
        SosNativeP2pEngine.releaseForWebView()
    }
}
