package com.sos010.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

object NotificationHelper {
    /** ערוץ חדש – חובה כשמשנים צליל (אי אפשר לעדכן ערוץ קיים) */
    const val CHANNEL_MESSAGES = "sos_messages_v3"
    const val CHANNEL_CALLS = "sos_calls_v1"
    const val CHANNEL_KEEPALIVE = "sos_keepalive"
    const val KEEPALIVE_ID = 1001
    const val INCOMING_CALL_ID = 2002

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        listOf("sos_messages", "sos_messages_v2").forEach { id ->
            try { nm.deleteNotificationChannel(id) } catch (_: Exception) {}
        }

        if (nm.getNotificationChannel(CHANNEL_MESSAGES) == null) {
            val sound = messageSoundUri(context)
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setLegacyStreamType(AudioManager.STREAM_NOTIFICATION)
                .build()
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_MESSAGES,
                    context.getString(R.string.channel_messages),
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = context.getString(R.string.channel_messages_desc)
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 250, 150, 250)
                    enableLights(true)
                    setShowBadge(true)
                    setSound(sound, attrs)
                    lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                }
            )
        }

        if (nm.getNotificationChannel(CHANNEL_CALLS) == null) {
            val ring = CallSoundHelper.ringtoneUri(context)
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setLegacyStreamType(AudioManager.STREAM_RING)
                .build()
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_CALLS,
                    context.getString(R.string.channel_calls),
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = context.getString(R.string.channel_calls_desc)
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 500, 200, 500, 200, 500)
                    enableLights(true)
                    setShowBadge(true)
                    setSound(ring, attrs)
                    lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                }
            )
        }

        if (nm.getNotificationChannel(CHANNEL_KEEPALIVE) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_KEEPALIVE,
                    context.getString(R.string.channel_keepalive),
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = context.getString(R.string.channel_keepalive_desc)
                    setShowBadge(false)
                    setSound(null, null)
                }
            )
        }
    }

    fun messageSoundUri(context: Context): Uri {
        return Uri.parse("android.resource://${context.packageName}/${R.raw.sos_message}")
    }

    fun showMessage(
        context: Context,
        title: String,
        body: String,
        openUrl: String? = null,
        tag: String? = null
    ) {
        ensureChannels(context)
        val app = context.applicationContext
        val intent = Intent(app, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            if (!openUrl.isNullOrBlank()) putExtra(MainActivity.EXTRA_OPEN_URL, openUrl)
        }
        val pi = PendingIntent.getActivity(
            app,
            (tag ?: title).hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val largeIcon = try {
            BitmapFactory.decodeResource(app.resources, R.drawable.sos_logo)
        } catch (_: Exception) {
            null
        }

        val sound = messageSoundUri(app)
        val notification = NotificationCompat.Builder(app, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_sos)
            .setLargeIcon(largeIcon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setSound(sound)
            .setVibrate(longArrayOf(0, 250, 150, 250))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(false)
            .build()

        try {
            NotificationManagerCompat.from(app).notify(
                tag ?: "sos-msg",
                (System.currentTimeMillis() % Int.MAX_VALUE).toInt(),
                notification
            )
        } catch (_: SecurityException) {
        }

        playBundledSound(app)
    }

    fun showIncomingCall(
        context: Context,
        title: String,
        body: String,
        openUrl: String,
        callType: String = "voice"
    ) {
        ensureChannels(context)
        val app = context.applicationContext
        val intent = Intent(app, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra(MainActivity.EXTRA_OPEN_URL, openUrl)
            putExtra("call_type", callType)
        }
        val pi = PendingIntent.getActivity(
            app,
            INCOMING_CALL_ID,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val largeIcon = try {
            BitmapFactory.decodeResource(app.resources, R.drawable.sos_logo)
        } catch (_: Exception) {
            null
        }

        val notification = NotificationCompat.Builder(app, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_stat_sos)
            .setLargeIcon(largeIcon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pi)
            .setFullScreenIntent(pi, true)
            .setAutoCancel(true)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setVibrate(longArrayOf(0, 500, 200, 500, 200, 500))
            .setSound(CallSoundHelper.ringtoneUri(app))
            .setTimeoutAfter(60_000L)
            .build()

        try {
            NotificationManagerCompat.from(app).notify("sos-incoming-call", INCOMING_CALL_ID, notification)
        } catch (_: SecurityException) {
        }

        CallSoundHelper.startRingtone(app)
    }

    fun cancelIncomingCall(context: Context) {
        try {
            NotificationManagerCompat.from(context.applicationContext)
                .cancel("sos-incoming-call", INCOMING_CALL_ID)
        } catch (_: Exception) {
        }
        CallSoundHelper.stopRingtone()
    }

    private fun playBundledSound(context: Context) {
        try {
            val player = MediaPlayer()
            player.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setLegacyStreamType(AudioManager.STREAM_NOTIFICATION)
                    .build()
            )
            player.setDataSource(context, messageSoundUri(context))
            player.setOnCompletionListener { mp ->
                try { mp.release() } catch (_: Exception) {}
            }
            player.setOnErrorListener { mp, _, _ ->
                try { mp.release() } catch (_: Exception) {}
                true
            }
            player.prepare()
            player.start()
        } catch (_: Exception) {
        }
    }
}
