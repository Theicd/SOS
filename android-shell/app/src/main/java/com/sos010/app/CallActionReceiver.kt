package com.sos010.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * פעולות ענה/דחה מהתראת שיחה נכנסת (CallStyle) – בלי להמתין לפתיחת מסך.
 */
class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        val app = context.applicationContext
        val peer = intent.getStringExtra(EXTRA_PEER)?.trim()?.lowercase().orEmpty()
        val callType = when (intent.getStringExtra(EXTRA_CALL_TYPE)?.trim()?.lowercase()) {
            "video", "v", "v-offer" -> "video"
            else -> "voice"
        }
        Log.i(TAG, "action=$action peer=${peer.take(8)} type=$callType")

        when (action) {
            ACTION_DECLINE -> {
                SosIncomingCallSession.markDeclined(app, peer)
                SosPendingCallStore.clear(app)
                NotificationHelper.cancelIncomingCall(app, stopSound = true, dismissUi = true)
                CallSoundHelper.stopAll()
                // מעיר WebView ברקע כדי לשלוח disconnect לצד השני | HYPER CORE TECH
                MainActivity.startBackgroundCallDecline(app, peer, callType)
            }
            ACTION_ANSWER -> {
                // נשארים על מסך Native + accept ברקע (לא פותחים MainActivity בחזית) | HYPER CORE TECH
                val name = SosContactCache.displayName(app, peer, app.getString(R.string.call_someone))
                val picture = SosContactCache.get(app, peer)?.picture.orEmpty()
                IncomingCallActivity.launch(
                    app,
                    peer,
                    callType,
                    name,
                    SosCallUrls.acceptPage(callType),
                    picture,
                    autoAnswer = true
                )
            }
        }
    }

    companion object {
        private const val TAG = "CallActionReceiver"
        const val ACTION_ANSWER = "com.sos010.app.ACTION_ANSWER_CALL"
        const val ACTION_DECLINE = "com.sos010.app.ACTION_DECLINE_CALL"
        const val EXTRA_PEER = "call_peer"
        const val EXTRA_CALL_TYPE = "call_type"
    }
}
