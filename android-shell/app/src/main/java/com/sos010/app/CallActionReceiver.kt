package com.sos010.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * פעולות ענה/דחה מהתראת שיחה נכנסת (CallStyle).
 * ענה → MainActivity בחזית (WebRTC דורש Activity גלויה).
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
                IncomingCallActivity.dismiss(app, peer)
                MainActivity.startBackgroundCallDecline(app, peer, callType)
            }
            ACTION_ANSWER -> {
                SosIncomingCallSession.markAnswered(app, peer)
                NotificationHelper.cancelIncomingCall(app, stopSound = true, dismissUi = true)
                val openUrl = intent.getStringExtra(MainActivity.EXTRA_OPEN_URL)
                    ?: SosCallUrls.acceptPage(callType)
                val launch = Intent(app, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_CLEAR_TOP or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP or
                        Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                    putExtra(MainActivity.EXTRA_OPEN_URL, openUrl)
                    putExtra(MainActivity.EXTRA_CALL_ACTION, MainActivity.CALL_ACTION_ANSWER)
                    putExtra(MainActivity.EXTRA_CALL_PEER, peer)
                    putExtra(MainActivity.EXTRA_CALL_TYPE, callType)
                }
                try {
                    app.startActivity(launch)
                } catch (err: Exception) {
                    Log.w(TAG, "answer launch failed: ${err.message}")
                }
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
