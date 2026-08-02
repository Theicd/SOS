package com.sos010.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap

/**
 * התראות מערכת בסגנון וואטסאפ:
 * כרטיס הודעות אחד שמתעדכן, צליל פעם אחת להודעה, בלי כפילויות.
 */
object NotificationHelper {
    /** ערוץ חדש – חובה כשמשנים צליל (אי אפשר לעדכן ערוץ קיים) */
    const val CHANNEL_MESSAGES = "sos_messages_v3"
    const val CHANNEL_CALLS = "sos_calls_v2"
    const val CHANNEL_KEEPALIVE = "sos_keepalive"
    const val KEEPALIVE_ID = 1001
    const val INCOMING_CALL_ID = 2002
    /** מזהה קבוע – מעדכן את אותה כרטיסיית הודעות במקום ליצור חדשות */
    const val MESSAGES_AGGREGATE_ID = 3001
    private const val MESSAGES_TAG = "sos-messages"
    private const val MAX_INBOX_LINES = 7
    private const val MAX_SEEN_EVENTS = 400

    private data class InboxLine(
        val peerKey: String,
        val senderName: String,
        val text: String,
        val openUrl: String?
    )

    private val lock = Any()
    private val inboxLines = ArrayDeque<InboxLine>()
    private val peerMessageCounts = LinkedHashMap<String, Int>()
    private val peerDisplayNames = LinkedHashMap<String, String>()
    private var totalMessageCount = 0
    private var lastOpenUrl: String? = null
    private val seenEventIds = ConcurrentHashMap.newKeySet<String>()

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        listOf("sos_messages", "sos_messages_v2").forEach { id ->
            try { nm.deleteNotificationChannel(id) } catch (_: Exception) {}
        }
        listOf("sos_calls_v1").forEach { id ->
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
            // צליל הצלצול מנוהל רק ב-CallSoundHelper (לולאה) – בלי כפילות מערוץ | HYPER CORE TECH
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
                    setSound(null, null)
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

    /**
     * מציג/מעדכן כרטיס הודעות אחד.
     * @param eventId מזהה אירוע Nostr / Push – מונע כפילות מריליי+FCM+Web
     * @param peerKey מפתח השיחה (pubkey) לקיבוץ לפי משתמש
     */
    fun showMessage(
        context: Context,
        title: String,
        body: String,
        openUrl: String? = null,
        tag: String? = null,
        eventId: String? = null,
        peerKey: String? = null
    ) {
        ensureChannels(context)
        val app = context.applicationContext

        val normalizedEventId = eventId?.trim()?.lowercase().orEmpty()
        if (normalizedEventId.isNotEmpty() && !seenEventIds.add(normalizedEventId)) {
            return
        }
        trimSeenEvents()

        val resolvedPeer = resolvePeerKey(peerKey, tag, openUrl)
        val senderName = resolveSenderName(title, resolvedPeer)
        val preview = body.trim().ifBlank { "הודעה חדשה" }

        synchronized(lock) {
            totalMessageCount += 1
            peerMessageCounts[resolvedPeer] = (peerMessageCounts[resolvedPeer] ?: 0) + 1
            peerDisplayNames[resolvedPeer] = senderName
            inboxLines.addLast(InboxLine(resolvedPeer, senderName, preview, openUrl))
            while (inboxLines.size > MAX_INBOX_LINES) {
                inboxLines.removeFirst()
            }
            lastOpenUrl = openUrl ?: lastOpenUrl
            postAggregateLocked(app)
        }
    }

    fun clearMessageNotifications(context: Context) {
        synchronized(lock) {
            inboxLines.clear()
            peerMessageCounts.clear()
            peerDisplayNames.clear()
            totalMessageCount = 0
            lastOpenUrl = null
        }
        try {
            NotificationManagerCompat.from(context.applicationContext)
                .cancel(MESSAGES_TAG, MESSAGES_AGGREGATE_ID)
        } catch (_: Exception) {
        }
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

        // צליל רק מהערוץ + CallSoundHelper (לא setSound כפול על ה-builder ב-O+)
        val builder = NotificationCompat.Builder(app, CHANNEL_CALLS)
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
            .setTimeoutAfter(60_000L)

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setSound(CallSoundHelper.ringtoneUri(app))
        }

        try {
            NotificationManagerCompat.from(app).notify("sos-incoming-call", INCOMING_CALL_ID, builder.build())
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

    private fun postAggregateLocked(app: Context) {
        val peerCount = peerMessageCounts.size
        val total = totalMessageCount.coerceAtLeast(1)
        val lines = inboxLines.toList()
        val openUrl = lastOpenUrl

        val (contentTitle, contentText) = when {
            peerCount <= 1 -> {
                val name = peerDisplayNames.values.lastOrNull()
                    ?: lines.lastOrNull()?.senderName
                    ?: "SOS"
                if (total <= 1) {
                    name to (lines.lastOrNull()?.text ?: "הודעה חדשה")
                } else {
                    "$name · $total הודעות" to (lines.lastOrNull()?.text ?: "$total הודעות חדשות")
                }
            }
            else -> {
                "SOS" to "$total הודעות מ-$peerCount אנשים"
            }
        }

        val intent = Intent(app, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            if (!openUrl.isNullOrBlank()) putExtra(MainActivity.EXTRA_OPEN_URL, openUrl)
        }
        val pi = PendingIntent.getActivity(
            app,
            MESSAGES_AGGREGATE_ID,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val largeIcon = try {
            BitmapFactory.decodeResource(app.resources, R.drawable.sos_logo)
        } catch (_: Exception) {
            null
        }

        val inboxStyle = NotificationCompat.InboxStyle()
            .setBigContentTitle(contentTitle)
            .setSummaryText(
                if (peerCount <= 1) "$total הודעות" else "$total הודעות מ-$peerCount אנשים"
            )
        lines.takeLast(MAX_INBOX_LINES).forEach { line ->
            inboxStyle.addLine("${line.senderName}: ${line.text}")
        }

        val builder = NotificationCompat.Builder(app, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_sos)
            .setLargeIcon(largeIcon)
            .setContentTitle(contentTitle)
            .setContentText(contentText)
            .setStyle(inboxStyle)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setNumber(total)
            .setVibrate(longArrayOf(0, 250, 150, 250))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            // false = צליל פעם אחת על כל הודעה חדשה שמעדכנת את אותה כרטיסיה
            .setOnlyAlertOnce(false)
            .setGroup(MESSAGES_TAG)
            .setGroupSummary(true)

        // API 26+: הצליל מגיע מהערוץ בלבד — בלי MediaPlayer נוסף ובלי setSound כפול
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setSound(messageSoundUri(app))
        }

        try {
            NotificationManagerCompat.from(app).notify(MESSAGES_TAG, MESSAGES_AGGREGATE_ID, builder.build())
        } catch (_: SecurityException) {
        }
    }

    private fun resolvePeerKey(peerKey: String?, tag: String?, openUrl: String?): String {
        val fromArg = peerKey?.trim()?.lowercase().orEmpty()
        if (fromArg.length >= 8) return fromArg

        val fromTag = tag?.trim().orEmpty()
        if (fromTag.startsWith("chat-", ignoreCase = true) && fromTag.length > 5) {
            return fromTag.substring(5).lowercase()
        }
        if (fromTag.isNotBlank() && fromTag != "sos" && fromTag != "sos-msg") {
            return fromTag.lowercase()
        }

        val url = openUrl.orEmpty()
        val chatMatch = Regex("[?&]chat=([0-9a-fA-F]{16,64})").find(url)
        if (chatMatch != null) return chatMatch.groupValues[1].lowercase()

        return "unknown"
    }

    private fun resolveSenderName(title: String, peerKey: String): String {
        val cleaned = title.trim()
        if (cleaned.isNotEmpty()
            && !cleaned.equals("SOS", ignoreCase = true)
            && !cleaned.contains("הודעה חדשה")
            && !cleaned.contains("קבלת הודעה")
            && !cleaned.contains("קיבלת הודעה")
        ) {
            return cleaned
        }
        if (peerKey != "unknown" && peerKey.length >= 8) {
            return "משתמש ${peerKey.take(8)}"
        }
        return "SOS"
    }

    private fun trimSeenEvents() {
        if (seenEventIds.size <= MAX_SEEN_EVENTS) return
        val extra = seenEventIds.size - (MAX_SEEN_EVENTS / 2)
        val it = seenEventIds.iterator()
        var removed = 0
        while (it.hasNext() && removed < extra) {
            it.next()
            it.remove()
            removed++
        }
    }
}
