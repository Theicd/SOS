package com.sos010.app

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Outline
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.util.concurrent.Executors

/**
 * מסך שיחה נכנסת מקורי מעל שומר המסך.
 * אחרי «ענה» נשארים כאן (בשיחה) – WebView מקבל accept ברקע בלי לפתוח את האפליקציה בחזית.
 */
class IncomingCallActivity : AppCompatActivity() {

    private var peer: String = ""
    private var callType: String = "voice"
    private var openUrl: String = ""
    private var handled = false
    private var inCallMode = false
    private var avatarLoadToken = 0

    private val dismissReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                ACTION_DISMISS -> {
                    val p = intent.getStringExtra(EXTRA_PEER)?.lowercase().orEmpty()
                    if (p.isBlank() || p == peer || peer.isBlank()) {
                        finishAndRemoveTaskSafe()
                    }
                }
                ACTION_CALL_CONNECTED -> {
                    val p = intent.getStringExtra(EXTRA_PEER)?.lowercase().orEmpty()
                    if (p.isBlank() || p == peer) {
                        runOnUiThread { showConnectedUi() }
                    }
                }
                ACTION_CALL_ENDED -> {
                    val p = intent.getStringExtra(EXTRA_PEER)?.lowercase().orEmpty()
                    if (p.isBlank() || p == peer || peer.isBlank()) {
                        finishAndRemoveTaskSafe()
                    }
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableLockScreenFlags()
        setContentView(R.layout.activity_incoming_call)
        clipAvatarFrame()
        bindFromIntent(intent)
        wireButtons()
        registerDismissReceiver()
        if (intent?.getBooleanExtra(EXTRA_AUTO_ANSWER, false) == true) {
            onAnswer()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (!inCallMode) {
            handled = false
            bindFromIntent(intent)
        }
        if (intent.getBooleanExtra(EXTRA_AUTO_ANSWER, false) && !inCallMode) {
            onAnswer()
        }
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

    private fun clipAvatarFrame() {
        val frame = findViewById<View>(R.id.incomingAvatarFrame) ?: return
        frame.outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) {
                outline.setOval(0, 0, view.width, view.height)
            }
        }
        frame.clipToOutline = true
    }

    private fun bindFromIntent(intent: Intent?) {
        peer = intent?.getStringExtra(EXTRA_PEER)?.trim()?.lowercase().orEmpty()
        callType = when (intent?.getStringExtra(EXTRA_CALL_TYPE)?.trim()?.lowercase()) {
            "video", "v", "v-offer" -> "video"
            else -> "voice"
        }
        openUrl = intent?.getStringExtra(EXTRA_OPEN_URL).orEmpty().ifBlank {
            SosCallUrls.acceptPage(callType)
        }
        val name = intent?.getStringExtra(EXTRA_CALLER_NAME)?.trim().orEmpty().ifBlank {
            SosContactCache.displayName(this, peer, getString(R.string.call_someone))
        }
        val pictureUrl = intent?.getStringExtra(EXTRA_CALLER_PICTURE)?.trim().orEmpty().ifBlank {
            SosContactCache.get(this, peer)?.picture.orEmpty()
        }

        findViewById<TextView>(R.id.incomingCallerName).text = name
        findViewById<TextView>(R.id.incomingCallLabel).text =
            if (callType == "video") getString(R.string.incoming_video_call)
            else getString(R.string.incoming_voice_call)
        findViewById<TextView>(R.id.incomingCallSub).text =
            getString(R.string.incoming_call_tap_answer)
        bindAvatar(name, pictureUrl)
        showRingingUi()
    }

    private fun bindAvatar(name: String, pictureUrl: String?) {
        val letterView = findViewById<TextView>(R.id.incomingAvatarLetter)
        val imageView = findViewById<ImageView>(R.id.incomingAvatarImage)
        letterView.visibility = View.VISIBLE
        letterView.text = name.take(1).ifBlank { "S" }.uppercase()
        imageView.visibility = View.GONE
        imageView.setImageDrawable(null)

        val url = pictureUrl?.trim().orEmpty()
        if (url.isBlank()) return

        val token = ++avatarLoadToken
        val cached = SosContactCache.getCachedBitmap(url)
        if (cached != null) {
            imageView.setImageBitmap(cached)
            imageView.visibility = View.VISIBLE
            letterView.visibility = View.GONE
            return
        }

        avatarExecutor.execute {
            val bmp = try {
                SosContactCache.loadBitmap(url)
            } catch (_: Exception) {
                null
            } ?: return@execute
            runOnUiThread {
                if (isFinishing || token != avatarLoadToken) return@runOnUiThread
                imageView.setImageBitmap(bmp)
                imageView.visibility = View.VISIBLE
                letterView.visibility = View.GONE
            }
        }
    }

    private fun wireButtons() {
        findViewById<ImageButton>(R.id.btnAnswer).setOnClickListener { onAnswer() }
        findViewById<ImageButton>(R.id.btnDecline).setOnClickListener { onDecline() }
        findViewById<ImageButton>(R.id.btnHangup).setOnClickListener { onHangup() }
        findViewById<ImageButton>(R.id.btnOpenChats).setOnClickListener { onOpenChats() }
    }

    private fun showRingingUi() {
        inCallMode = false
        findViewById<LinearLayout>(R.id.incomingActionsRinging)?.visibility = View.VISIBLE
        findViewById<LinearLayout>(R.id.incomingActionsInCall)?.visibility = View.GONE
    }

    private fun showInCallUi() {
        inCallMode = true
        findViewById<LinearLayout>(R.id.incomingActionsRinging)?.visibility = View.GONE
        findViewById<LinearLayout>(R.id.incomingActionsInCall)?.visibility = View.VISIBLE
        findViewById<TextView>(R.id.incomingCallSub).text =
            getString(R.string.incoming_call_connecting)
        findViewById<TextView>(R.id.incomingCallLabel).text =
            getString(R.string.incoming_call_connecting)
    }

    private fun showConnectedUi() {
        if (!inCallMode) showInCallUi()
        findViewById<TextView>(R.id.incomingCallSub).text =
            getString(R.string.incoming_call_in_progress)
        findViewById<TextView>(R.id.incomingCallLabel).text =
            getString(R.string.incoming_call_in_progress)
    }

    /**
     * ענה – נשארים על מסך Native; WebView מקבל accept ברקע בלי UI בחזית.
     */
    private fun onAnswer() {
        if (handled && inCallMode) return
        handled = true
        SosIncomingCallSession.markAnswered(applicationContext, peer)
        NotificationHelper.cancelIncomingCall(applicationContext, stopSound = true, dismissUi = false)
        CallSoundHelper.stopRingtone()
        showInCallUi()
        SosDebugLog.i("call", "native answer stay-on-ui peer=${peer.take(8)}")
        MainActivity.startBackgroundCallAccept(applicationContext, peer, callType, openUrl)
    }

    private fun onDecline() {
        if (handled && inCallMode) return
        handled = true
        SosIncomingCallSession.markDeclined(applicationContext, peer)
        SosPendingCallStore.clear(applicationContext)
        NotificationHelper.cancelIncomingCall(applicationContext, stopSound = true, dismissUi = false)
        CallSoundHelper.stopAll()
        MainActivity.startBackgroundCallDecline(applicationContext, peer, callType)
        finishAndRemoveTaskSafe()
    }

    private fun onHangup() {
        SosDebugLog.i("call", "native hangup peer=${peer.take(8)}")
        NotificationHelper.cancelIncomingCall(applicationContext, stopSound = true, dismissUi = false)
        CallSoundHelper.stopAll()
        MainActivity.startBackgroundCallHangup(applicationContext, peer, callType)
        SosIncomingCallSession.markRemoteEnded(applicationContext, peer)
        SosPendingCallStore.clear(applicationContext)
        finishAndRemoveTaskSafe()
    }

    /** פתיחת רשימת שיחות בממשק – רק אם המשתמש בחר | HYPER CORE TECH */
    private fun onOpenChats() {
        SosDebugLog.i("call", "open chats from native in-call peer=${peer.take(8)}")
        MainActivity.bringToFrontChatList(applicationContext, peer)
        // המסך Native נסגר; השיחה ממשיכה ב־WebView עם UI ווב | HYPER CORE TECH
        finish()
    }

    private fun finishAndRemoveTaskSafe() {
        try {
            finishAndRemoveTask()
        } catch (_: Exception) {
            finish()
        }
    }

    private fun registerDismissReceiver() {
        val filter = IntentFilter().apply {
            addAction(ACTION_DISMISS)
            addAction(ACTION_CALL_CONNECTED)
            addAction(ACTION_CALL_ENDED)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(dismissReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(dismissReceiver, filter)
        }
    }

    companion object {
        private val avatarExecutor = Executors.newSingleThreadExecutor()

        const val EXTRA_PEER = "incoming_peer"
        const val EXTRA_CALL_TYPE = "incoming_call_type"
        const val EXTRA_CALLER_NAME = "incoming_caller_name"
        const val EXTRA_CALLER_PICTURE = "incoming_caller_picture"
        const val EXTRA_OPEN_URL = "incoming_open_url"
        const val EXTRA_AUTO_ANSWER = "incoming_auto_answer"
        const val ACTION_DISMISS = "com.sos010.app.ACTION_DISMISS_INCOMING_CALL"
        const val ACTION_CALL_CONNECTED = "com.sos010.app.ACTION_NATIVE_CALL_CONNECTED"
        const val ACTION_CALL_ENDED = "com.sos010.app.ACTION_NATIVE_CALL_ENDED"

        fun launch(
            context: Context,
            peer: String,
            callType: String,
            callerName: String,
            openUrl: String,
            pictureUrl: String = "",
            autoAnswer: Boolean = false
        ) {
            val app = context.applicationContext
            val intent = Intent(app, IncomingCallActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_NO_USER_ACTION
                putExtra(EXTRA_PEER, peer.trim().lowercase())
                putExtra(EXTRA_CALL_TYPE, callType)
                putExtra(EXTRA_CALLER_NAME, callerName)
                putExtra(EXTRA_CALLER_PICTURE, pictureUrl)
                putExtra(EXTRA_OPEN_URL, openUrl)
                putExtra(EXTRA_AUTO_ANSWER, autoAnswer)
            }
            try {
                app.startActivity(intent)
            } catch (_: Exception) {
            }
        }

        fun dismiss(context: Context, peer: String? = null) {
            val app = context.applicationContext
            val intent = Intent(ACTION_DISMISS).apply {
                setPackage(app.packageName)
                if (!peer.isNullOrBlank()) putExtra(EXTRA_PEER, peer.trim().lowercase())
            }
            try {
                app.sendBroadcast(intent)
            } catch (_: Exception) {
            }
        }

        fun notifyConnected(context: Context, peer: String?) {
            val app = context.applicationContext
            val intent = Intent(ACTION_CALL_CONNECTED).apply {
                setPackage(app.packageName)
                if (!peer.isNullOrBlank()) putExtra(EXTRA_PEER, peer.trim().lowercase())
            }
            try {
                app.sendBroadcast(intent)
            } catch (_: Exception) {
            }
        }

        fun notifyEnded(context: Context, peer: String?) {
            val app = context.applicationContext
            val intent = Intent(ACTION_CALL_ENDED).apply {
                setPackage(app.packageName)
                if (!peer.isNullOrBlank()) putExtra(EXTRA_PEER, peer.trim().lowercase())
            }
            try {
                app.sendBroadcast(intent)
            } catch (_: Exception) {
            }
        }
    }
}
