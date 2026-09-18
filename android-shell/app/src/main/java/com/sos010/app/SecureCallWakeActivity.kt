package com.sos010.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.view.WindowManager
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Silent secure verifier wake Activity.
 * Obtains an Android-authorized Activity start via full-screen PendingIntent,
 * then warms MainActivity so JS can unwrap Gift Wrap. NOT an incoming-call UI.
 * No peer, media, session, SDP, ringtone, vibration, or CallStyle.
 */
class SecureCallWakeActivity : Activity() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            )
        } catch (_: Exception) {
        }

        Log.i(TAG, "SECURE_VERIFIER_ACTIVE")
        SosDebugLog.i("call", "SECURE_VERIFIER_ACTIVE")
        acquireShortWakeLock()

        try {
            NotificationHelper.cancelSecureVerifierWake(applicationContext)
        } catch (_: Exception) {
        }

        try {
            val intent = Intent(applicationContext, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_NO_USER_ACTION
                putExtra(MainActivity.EXTRA_START_IN_BACKGROUND, true)
                putExtra(MainActivity.EXTRA_WARM_FOR_SECURE_WRAP, true)
                putExtra(MainActivity.EXTRA_OPEN_URL, SosCallUrls.warmPage())
            }
            val opts = IncomingCallActivity.backgroundStartOptions()
            if (opts != null) startActivity(intent, opts) else startActivity(intent)
            Log.i(TAG, "SECURE_WEBVIEW_READY requested")
            SosDebugLog.i("call", "SECURE_WEBVIEW_READY")
        } catch (err: Exception) {
            Log.w(TAG, "secure verifier → MainActivity failed: ${err.message}")
            SosDebugLog.i("call", "SECURE_VERIFIER_FAIL ${err.message}")
            launchInFlight.set(false)
            SosRelayWatcher.clearSecureWarmInFlight()
        }

        // Release wake shortly; MainActivity continues authentication.
        Handler(Looper.getMainLooper()).postDelayed({
            releaseWakeLock()
            try {
                finish()
            } catch (_: Exception) {
            }
        }, 400L)
    }

    override fun onDestroy() {
        releaseWakeLock()
        // Allow a later wake if queue still has wraps and host never came up.
        Handler(Looper.getMainLooper()).postDelayed({
            if (!MainActivity.isHostAlive) {
                launchInFlight.set(false)
            }
        }, 2_000L)
        super.onDestroy()
    }

    private fun acquireShortWakeLock() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            val wl = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "sos:secure-verifier"
            )
            wl.setReferenceCounted(false)
            wl.acquire(WAKE_MS)
            wakeLock = wl
        } catch (_: Exception) {
        }
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.let { wl ->
                if (wl.isHeld) wl.release()
            }
        } catch (_: Exception) {
        }
        wakeLock = null
    }

    companion object {
        private const val TAG = "SecureCallWake"
        private const val WAKE_MS = 12_000L

        private val launchInFlight = AtomicBoolean(false)
        @Volatile private var lastLaunchElapsed = 0L

        /** Returns true if this process may launch the verifier now. */
        fun tryBeginLaunch(): Boolean {
            val now = SystemClock.elapsedRealtime()
            if (launchInFlight.get()) {
                Log.i(TAG, "SECURE_VERIFIER_LAUNCH skipped (active)")
                return false
            }
            // Coalesce bursts within 8s.
            if (now - lastLaunchElapsed < 8_000L) {
                Log.i(TAG, "SECURE_VERIFIER_LAUNCH skipped (dedupe)")
                return false
            }
            if (!launchInFlight.compareAndSet(false, true)) return false
            lastLaunchElapsed = now
            return true
        }

        fun clearLaunchInFlight() {
            launchInFlight.set(false)
        }

        fun isLaunchInFlight(): Boolean = launchInFlight.get()

        fun verifierIntent(context: Context): Intent {
            return Intent(context, SecureCallWakeActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_NO_USER_ACTION
                // Opaque only — never put peer/media/session/SDP.
            }
        }
    }
}
