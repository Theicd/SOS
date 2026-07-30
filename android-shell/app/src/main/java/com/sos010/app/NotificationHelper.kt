package com.sos010.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

object NotificationHelper {
    const val CHANNEL_MESSAGES = "sos_messages_v2"
    const val CHANNEL_KEEPALIVE = "sos_keepalive"
    const val KEEPALIVE_ID = 1001

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        // מוחקים ערוץ ישן בלי צליל אם קיים
        try { nm.deleteNotificationChannel("sos_messages") } catch (_: Exception) {}

        val msgChannel = NotificationChannel(
            CHANNEL_MESSAGES,
            context.getString(R.string.channel_messages),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = context.getString(R.string.channel_messages_desc)
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 250, 150, 250)
            setShowBadge(true)
            val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            setSound(sound, attrs)
        }
        nm.createNotificationChannel(msgChannel)

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

    fun showMessage(
        context: Context,
        title: String,
        body: String,
        openUrl: String? = null,
        tag: String? = null
    ) {
        ensureChannels(context)
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            if (!openUrl.isNullOrBlank()) putExtra(MainActivity.EXTRA_OPEN_URL, openUrl)
        }
        val pi = PendingIntent.getActivity(
            context,
            (tag ?: title).hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val notification = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_sos)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setSound(sound)
            .setVibrate(longArrayOf(0, 250, 150, 250))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()

        try {
            NotificationManagerCompat.from(context).notify(
                tag ?: "sos-msg",
                (System.currentTimeMillis() % Int.MAX_VALUE).toInt(),
                notification
            )
        } catch (_: SecurityException) {
        }
    }
}
