package com.sos010.app

import android.app.AlarmManager
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * שירות רקע קבוע + מאזין Nostr מקורי לקבלת הודעות בלי WebView.
 */
class SosForegroundService : Service() {

    private val handler = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        NotificationHelper.ensureChannels(this)
        startForeground(NotificationHelper.KEEPALIVE_ID, buildOngoingNotification())
        handler.post {
            SosRelayWatcher.ensureStarted(this)
            SosP2pStandby.ensureStarted(this)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NotificationHelper.KEEPALIVE_ID, buildOngoingNotification())
        handler.post {
            SosRelayWatcher.ensureStarted(this)
            SosP2pStandby.ensureStarted(this)
        }
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        scheduleRestart(applicationContext, delayMs = 600L)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        // לא עוצרים את ה-watcher כאן לפני restart – השירות יחזור עם START_STICKY
        scheduleRestart(applicationContext, delayMs = 1000L)
        super.onDestroy()
    }

    private fun buildOngoingNotification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, NotificationHelper.CHANNEL_KEEPALIVE)
            .setContentTitle(getString(R.string.fg_title))
            .setContentText(getString(R.string.fg_text))
            .setSmallIcon(R.drawable.ic_stat_sos)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    companion object {
        fun start(context: Context) {
            val intent = Intent(context, SosForegroundService::class.java)
            ContextCompat.startForegroundService(context, intent)
        }

        fun scheduleRestart(context: Context, delayMs: Long = 1000L) {
            try {
                val restart = Intent(context, SosForegroundService::class.java)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                val pi = PendingIntent.getService(context, 9911, restart, flags)
                val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                val triggerAt = SystemClock.elapsedRealtime() + delayMs
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi)
                } else {
                    am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi)
                }
            } catch (_: Exception) {
                try {
                    start(context)
                } catch (_: Exception) {
                }
            }
        }
    }
}
