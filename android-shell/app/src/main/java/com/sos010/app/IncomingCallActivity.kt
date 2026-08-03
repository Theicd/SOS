package com.sos010.app

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.ImageButton
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * מסך שיחה נכנסת מקורי מעל שומר המסך – כמו וואטסאפ (ענה / דחה + שם).
 */
class IncomingCallActivity : AppCompatActivity() {

    private var peer: String = ""
    private var callType: String = "voice"
    private var openUrl: String = ""
    private var handled = false

    private val dismissReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != ACTION_DISMISS) return
            val p = intent.getStringExtra(EXTRA_PEER)?.lowercase().orEmpty()
            if (p.isBlank() || p == peer || peer.isBlank()) {
                finishAndRemoveTaskSafe()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableLockScreenFlags()
        setContentView(R.layout.activity_incoming_call)
        bindFromIntent(intent)
        wireButtons()
        registerDismissReceiver()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handled = false
        bindFromIntent(intent)
    }

    override fun onDestroy() {
        try {
            unregisterReceiver(dismissReceiver)
        } catch (_: Exception) {
        }
        super.onDestroy()
    }

    private fun enableLockScreenFlags() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            try {
                val kg = getSystemService(KeyguardManager::class.java)
                kg?.requestDismissKeyguard(this, null)
            } catch (_: Exception) {
            }
        }
        @Suppress("DEPRECATION")
        window.addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_ALLOW_LOCK_WHILE_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
        )
    }

    private fun bindFromIntent(intent: Intent?) {
        peer = intent?.getStringExtra(EXTRA_PEER)?.trim()?.lowercase().orEmpty()
        callType = when (intent?.getStringExtra(EXTRA_CALL_TYPE)?.trim()?.lowercase()) {
            "video", "v", "v-offer" -> "video"
            else -> "voice"
        }
        openUrl = intent?.getStringExtra(EXTRA_OPEN_URL).orEmpty().ifBlank {
            "https://sos010.com/videos.html?chat=$peer&incomingCall=$callType"
        }
        val name = intent?.getStringExtra(EXTRA_CALLER_NAME)?.trim().orEmpty().ifBlank {
            SosContactCache.displayName(this, peer, getString(R.string.call_someone))
        }

        findViewById<TextView>(R.id.incomingCallerName).text = name
        findViewById<TextView>(R.id.incomingAvatarLetter).text =
            name.take(1).ifBlank { "S" }.uppercase()
        findViewById<TextView>(R.id.incomingCallLabel).text =
            if (callType == "video") getString(R.string.incoming_video_call)
            else getString(R.string.incoming_voice_call)
        findViewById<TextView>(R.id.incomingCallSub).text =
            getString(R.string.incoming_call_tap_answer)
    }

    private fun wireButtons() {
        findViewById<ImageButton>(R.id.btnAnswer).setOnClickListener { onAnswer() }
        findViewById<ImageButton>(R.id.btnDecline).setOnClickListener { onDecline() }
    }

    private fun onAnswer() {
        if (handled) return
        handled = true
        SosIncomingCallSession.markAnswered(applicationContext, peer)
        NotificationHelper.cancelIncomingCall(applicationContext, stopSound = false)
        val launch = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(MainActivity.EXTRA_OPEN_URL, openUrl)
            putExtra(MainActivity.EXTRA_CALL_ACTION, MainActivity.CALL_ACTION_ANSWER)
            putExtra(MainActivity.EXTRA_CALL_PEER, peer)
            putExtra(MainActivity.EXTRA_CALL_TYPE, callType)
        }
        startActivity(launch)
        finish()
    }

    private fun onDecline() {
        if (handled) return
        handled = true
        SosIncomingCallSession.markDeclined(applicationContext, peer)
        SosPendingCallStore.clear(applicationContext)
        NotificationHelper.cancelIncomingCall(applicationContext, stopSound = true)
        CallSoundHelper.stopAll()
        val launch = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(MainActivity.EXTRA_CALL_ACTION, MainActivity.CALL_ACTION_DECLINE)
            putExtra(MainActivity.EXTRA_CALL_PEER, peer)
            putExtra(MainActivity.EXTRA_CALL_TYPE, callType)
            putExtra(MainActivity.EXTRA_START_IN_BACKGROUND, true)
        }
        try {
            startActivity(launch)
        } catch (_: Exception) {
        }
        finishAndRemoveTaskSafe()
    }

    private fun finishAndRemoveTaskSafe() {
        try {
            finishAndRemoveTask()
        } catch (_: Exception) {
            finish()
        }
    }

    private fun registerDismissReceiver() {
        val filter = IntentFilter(ACTION_DISMISS)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(dismissReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(dismissReceiver, filter)
        }
    }

    companion object {
        const val ACTION_DISMISS = "com.sos010.app.ACTION_DISMISS_INCOMING_CALL"
        const val EXTRA_PEER = "call_peer"
        const val EXTRA_CALL_TYPE = "call_type"
        const val EXTRA_CALLER_NAME = "caller_name"
        const val EXTRA_OPEN_URL = "open_url"

        fun launch(
            context: Context,
            peer: String,
            callType: String,
            callerName: String,
            openUrl: String
        ) {
            val app = context.applicationContext
            val intent = Intent(app, IncomingCallActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_NO_USER_ACTION
                putExtra(EXTRA_PEER, peer)
                putExtra(EXTRA_CALL_TYPE, callType)
                putExtra(EXTRA_CALLER_NAME, callerName)
                putExtra(EXTRA_OPEN_URL, openUrl)
            }
            try {
                app.startActivity(intent)
            } catch (_: Exception) {
            }
        }

        fun dismiss(context: Context, peer: String? = null) {
            val intent = Intent(ACTION_DISMISS).apply {
                setPackage(context.packageName)
                if (!peer.isNullOrBlank()) putExtra(EXTRA_PEER, peer)
            }
            try {
                context.applicationContext.sendBroadcast(intent)
            } catch (_: Exception) {
            }
        }
    }
}
