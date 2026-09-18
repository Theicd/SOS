package com.sos010.app

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log

/**
 * Short phone-call foreground service.
 * Lets Android start the opaque verifier Activity while another app is in front.
 * Does not ring. Carries no peer, session, or media data.
 * startActivity here is SENT, not delivery success.
 */
class SecureVerifierLaunchService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val recovery = intent?.getBooleanExtra(SecureCallWakeActivity.EXTRA_RECOVERY, false) == true
        try {
            val notification = NotificationHelper.secureVerifierNotification(this, recovery)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NotificationHelper.SECURE_VERIFIER_WAKE_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
                )
            } else {
                startForeground(NotificationHelper.SECURE_VERIFIER_WAKE_ID, notification)
            }
            startActivity(
                SecureCallWakeActivity.verifierIntent(
                    this,
                    recovery,
                    SecureCallWakeActivity.ENTRY_DIRECT
                )
            )
            Log.i(TAG, "SECURE_VERIFIER_DIRECT_START_SENT")
            SosDebugLog.i("call", "SECURE_VERIFIER_DIRECT_START_SENT")
        } catch (err: Exception) {
            Log.i(TAG, "SECURE_VERIFIER_PHONE_FGS_BLOCKED")
            SosDebugLog.i("call", "SECURE_VERIFIER_PHONE_FGS_BLOCKED")
        }
        Handler(Looper.getMainLooper()).postDelayed({
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(STOP_FOREGROUND_DETACH)
                }
            } catch (_: Exception) {
            }
            stopSelf()
        }, 4_000L)
        return START_NOT_STICKY
    }

    companion object {
        private const val TAG = "SecureVerifierLaunch"
    }
}
