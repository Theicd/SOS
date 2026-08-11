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
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap

/**
 * התראות מערכת בסגנון וואטסאפ:
 * כרטיס הודעות אחד שמתעדכן, צליל יחיד להודעה, בלי כפילויות Web+Native.
 */
object NotificationHelper {
    /** ערוץ חדש – מאפשר צליל גם בעדכון כרטיס אגרגציה | HYPER CORE TECH */
    const val CHANNEL_MESSAGES = "sos_messages_v5"
    /** ערוץ שיחות חדש – CallStyle + heads-up על מסך נעול | HYPER CORE TECH */
    const val CHANNEL_CALLS = "sos_calls_v3"
    const val CHANNEL_KEEPALIVE = "sos_keepalive"
    const val KEEPALIVE_ID = 1001
    const val INCOMING_CALL_ID = 2002
    const val MESSAGES_AGGREGATE_ID = 3001
    private const val MESSAGES_TAG = "sos-messages"
    private const val MAX_INBOX_LINES = 7
    private const val MAX_SEEN_EVENTS = 400
    private const val ALERT_DEBOUNCE_MS = 1000L

    private data class InboxLine(
        val peerKey: String,
        val senderName: String,
        val text: String,
        val openUrl: String?,
        val pictureUrl: String = ""
    )

    private val lock = Any()
    private val inboxLines = ArrayDeque<InboxLine>()
    private val peerMessageCounts = LinkedHashMap<String, Int>()
    private val peerDisplayNames = LinkedHashMap<String, String>()
    private val peerPictureUrls = LinkedHashMap<String, String>()
    private var totalMessageCount = 0
    private var lastOpenUrl: String? = null
    private var lastPeerKey: String? = null
    private val seenEventIds = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var lastAlertAt = 0L
    @Volatile private var suppressAlertsUntil = 0L
    private val avatarExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        listOf("sos_messages", "sos_messages_v2", "sos_messages_v3").forEach { id ->
            try { nm.deleteNotificationChannel(id) } catch (_: Exception) {}
        }
        listOf("sos_calls_v1", "sos_calls_v2").forEach { id ->
            try { nm.deleteNotificationChannel(id) } catch (_: Exception) {}
        }

        if (nm.getNotificationChannel(CHANNEL_MESSAGES) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_MESSAGES,
                    context.getString(R.string.channel_messages),
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = context.getString(R.string.channel_messages_desc)
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 220)
                    enableLights(true)
                    setShowBadge(true)
                    // בלי צליל ערוץ – מונע כפילות עם MediaPlayer / Web | HYPER CORE TECH
                    setSound(null, null)
                    lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                }
            )
        }

        if (nm.getNotificationChannel(CHANNEL_CALLS) == null) {
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
                    // חשוב ללשונית עליונה / מסך נעול | HYPER CORE TECH
                    setBypassDnd(true)
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

    /** חוסם צלילי התראה לזמן קצר אחרי פתיחת האפליקציה (מונע צלצול חוזר ב-resume) */
    fun suppressAlertsFor(durationMs: Long) {
        suppressAlertsUntil = System.currentTimeMillis() + durationMs.coerceAtLeast(0L)
    }

    fun showMessage(
        context: Context,
        title: String,
        body: String,
        openUrl: String? = null,
        tag: String? = null,
        eventId: String? = null,
        peerKey: String? = null,
        pictureUrl: String? = null
    ) {
        ensureChannels(context)
        val app = context.applicationContext

        // כשהממשק פתוח – בלי התראת מערכת (ה-Web מציג במסך) | HYPER CORE TECH
        if (MainActivity.isHostAlive) {
            SosDebugLog.i("notify", "showMessage blocked hostAlive")
            return
        }

        val normalizedEventId = eventId?.trim()?.lowercase().orEmpty()
        if (normalizedEventId.isNotEmpty() && !seenEventIds.add(normalizedEventId)) {
            SosDebugLog.i("notify", "showMessage dedupe id=${normalizedEventId.take(12)}")
            return
        }
        // בלי eventId – דה-דופ לפי זמן קצר כדי לא לצלצל פעמיים מ-FCM+Relay
        if (normalizedEventId.isEmpty()) {
            val now = System.currentTimeMillis()
            if (now - lastAlertAt < ALERT_DEBOUNCE_MS) return
        }
        trimSeenEvents()

        val resolvedPeer = resolvePeerKey(peerKey, tag, openUrl)
        val cached = SosContactCache.get(app, resolvedPeer)
        val senderName = when {
            !cached?.name.isNullOrBlank() && !cached!!.name.startsWith("משתמש ") -> cached.name
            else -> resolveSenderName(title, resolvedPeer)
        }
        val pic = pictureUrl?.trim()?.takeIf { it.isNotEmpty() }
            ?: cached?.picture?.trim()?.takeIf { it.isNotEmpty() }
            ?: ""
        val preview = body.trim().ifBlank { "הודעה חדשה" }
        val allowAlert = System.currentTimeMillis() >= suppressAlertsUntil

        synchronized(lock) {
            totalMessageCount += 1
            peerMessageCounts[resolvedPeer] = (peerMessageCounts[resolvedPeer] ?: 0) + 1
            peerDisplayNames[resolvedPeer] = senderName
            if (pic.isNotEmpty()) peerPictureUrls[resolvedPeer] = pic
            lastPeerKey = resolvedPeer
            inboxLines.addLast(InboxLine(resolvedPeer, senderName, preview, openUrl, pic))
            while (inboxLines.size > MAX_INBOX_LINES) {
                inboxLines.removeFirst()
            }
            lastOpenUrl = openUrl ?: lastOpenUrl
            SosDebugLog.i("notify", "showMessage post sound=$allowAlert peer=${resolvedPeer.take(8)}")
            postAggregateLocked(app, playSound = allowAlert)
        }

        if (pic.isNotEmpty()) {
            refreshAvatarAsync(app, pic)
        }
    }

    /** עדכון שם/תמונה לכרטיס קיים בלי צליל נוסף (אחרי טעינת פרופיל) | HYPER CORE TECH */
    fun updatePeerProfile(context: Context, peerKey: String?, name: String?, pictureUrl: String?) {
        val app = context.applicationContext
        val pk = peerKey?.trim()?.lowercase().orEmpty()
        if (pk.length < 8) return
        if (MainActivity.isHostAlive) return

        val cleanName = name?.trim().orEmpty()
        val cleanPic = pictureUrl?.trim().orEmpty()
        if (cleanName.isEmpty() && cleanPic.isEmpty()) return

        var shouldRefreshAvatar = false
        synchronized(lock) {
            if (!peerMessageCounts.containsKey(pk) && inboxLines.none { it.peerKey == pk }) return
            if (cleanName.isNotEmpty() && !cleanName.startsWith("משתמש ")) {
                peerDisplayNames[pk] = cleanName
            }
            if (cleanPic.isNotEmpty()) {
                peerPictureUrls[pk] = cleanPic
                shouldRefreshAvatar = true
            }
            val updated = ArrayDeque<InboxLine>()
            inboxLines.forEach { line ->
                if (line.peerKey != pk) {
                    updated.addLast(line)
                } else {
                    updated.addLast(
                        line.copy(
                            senderName = if (cleanName.isNotEmpty() && !cleanName.startsWith("משתמש ")) cleanName else line.senderName,
                            pictureUrl = if (cleanPic.isNotEmpty()) cleanPic else line.pictureUrl
                        )
                    )
                }
            }
            inboxLines.clear()
            updated.forEach { inboxLines.addLast(it) }
            postAggregateLocked(app, playSound = false)
        }
        if (shouldRefreshAvatar) {
            refreshAvatarAsync(app, cleanPic)
        }
    }

    fun clearMessageNotifications(context: Context) {
        synchronized(lock) {
            inboxLines.clear()
            peerMessageCounts.clear()
            peerDisplayNames.clear()
            peerPictureUrls.clear()
            totalMessageCount = 0
            lastOpenUrl = null
            lastPeerKey = null
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
        callType: String = "voice",
        peerPubkey: String = "",
        callerName: String = ""
    ) {
        ensureChannels(context)
        val app = context.applicationContext
        val peer = peerPubkey.trim().lowercase()
        val type = when (callType.trim().lowercase()) {
            "video", "v", "v-offer" -> "video"
            else -> "voice"
        }
        val displayName = callerName.trim().ifBlank {
            body.substringBefore(" ").ifBlank { app.getString(R.string.call_someone) }
        }
        val pictureUrl = SosContactCache.get(app, peer)?.picture.orEmpty()
        val callTitle = if (type == "video") {
            app.getString(R.string.incoming_video_call)
        } else {
            app.getString(R.string.incoming_voice_call)
        }
        val callBody = app.getString(R.string.incoming_call_from, displayName)

        SosIncomingCallSession.markRinging(app, peer, type)
        SosDebugLog.i("notify", "showIncomingCall type=$type peer=${peer.take(8)}")

        val fullScreenIntent = Intent(app, IncomingCallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP or
                Intent.FLAG_ACTIVITY_NO_USER_ACTION
            putExtra(IncomingCallActivity.EXTRA_PEER, peer)
            putExtra(IncomingCallActivity.EXTRA_CALL_TYPE, type)
            putExtra(IncomingCallActivity.EXTRA_CALLER_NAME, displayName)
            putExtra(IncomingCallActivity.EXTRA_CALLER_PICTURE, pictureUrl)
            putExtra(IncomingCallActivity.EXTRA_OPEN_URL, openUrl)
        }
        val fullScreenPi = PendingIntent.getActivity(
            app,
            INCOMING_CALL_ID,
            fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val answerIntent = Intent(app, MainActivity::class.java).apply {
            action = CallActionReceiver.ACTION_ANSWER
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra(MainActivity.EXTRA_OPEN_URL, SosCallUrls.acceptPage(type))
            putExtra(MainActivity.EXTRA_CALL_ACTION, MainActivity.CALL_ACTION_ANSWER)
            putExtra(MainActivity.EXTRA_CALL_PEER, peer)
            putExtra(MainActivity.EXTRA_CALL_TYPE, type)
            putExtra(CallActionReceiver.EXTRA_PEER, peer)
            putExtra(CallActionReceiver.EXTRA_CALL_TYPE, type)
        }
        val answerPi = PendingIntent.getActivity(
            app,
            INCOMING_CALL_ID + 1,
            answerIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val declineIntent = Intent(app, CallActionReceiver::class.java).apply {
            this.action = CallActionReceiver.ACTION_DECLINE
            putExtra(CallActionReceiver.EXTRA_PEER, peer)
            putExtra(CallActionReceiver.EXTRA_CALL_TYPE, type)
            putExtra(MainActivity.EXTRA_CALL_PEER, peer)
            putExtra(MainActivity.EXTRA_CALL_TYPE, type)
        }
        val declinePi = PendingIntent.getBroadcast(
            app,
            INCOMING_CALL_ID + 2,
            declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val largeIcon = try {
            SosContactCache.getCachedBitmap(pictureUrl)
                ?: BitmapFactory.decodeResource(app.resources, R.drawable.sos_logo)
        } catch (_: Exception) {
            null
        }

        val callerBuilder = androidx.core.app.Person.Builder()
            .setName(displayName)
            .setImportant(true)
        try {
            val avatar = SosContactCache.getCachedBitmap(pictureUrl)
            if (avatar != null) {
                callerBuilder.setIcon(androidx.core.graphics.drawable.IconCompat.createWithBitmap(avatar))
            }
        } catch (_: Exception) {
        }
        val caller = callerBuilder.build()

        val builder = NotificationCompat.Builder(app, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_stat_sos)
            .setLargeIcon(largeIcon)
            .setContentTitle(callTitle)
            .setContentText(callBody)
            .setContentIntent(fullScreenPi)
            .setFullScreenIntent(fullScreenPi, true)
            .setStyle(
                NotificationCompat.CallStyle.forIncomingCall(caller, declinePi, answerPi)
                    .setIsVideo(type == "video")
            )
            .addPerson(caller)
            .setAutoCancel(false)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setVibrate(longArrayOf(0, 500, 200, 500, 200, 500))
            .setTimeoutAfter(60_000L)
            .setUsesChronometer(false)

        if (title.isNotBlank()) {
            builder.setContentTitle(callTitle.ifBlank { title })
        }

        try {
            NotificationManagerCompat.from(app).notify("sos-incoming-call", INCOMING_CALL_ID, builder.build())
        } catch (_: SecurityException) {
        }

        // מפעיל מסך שיחה מקורי מעל הנעילה (לא רק wake לשומר מסך) | HYPER CORE TECH
        IncomingCallActivity.launch(app, peer, type, displayName, openUrl, pictureUrl)
        if (pictureUrl.isNotBlank() && SosContactCache.getCachedBitmap(pictureUrl) == null) {
            refreshCallAvatarAsync(app, peer, type, displayName, openUrl, pictureUrl)
        }
        // חימום נוסף אם עדיין לא הורם (למשל FSI בלי RelayWatcher) | HYPER CORE TECH
        MainActivity.warmHostForIncomingCall(app, peer, type)
        CallSoundHelper.startRingtone(app)
    }

    private fun refreshCallAvatarAsync(
        app: Context,
        peer: String,
        type: String,
        displayName: String,
        openUrl: String,
        pictureUrl: String
    ) {
        avatarExecutor.execute {
            try {
                SosContactCache.loadBitmap(pictureUrl) ?: return@execute
                // רענון מסך נעילה עם תמונה אחרי הורדה | HYPER CORE TECH
                IncomingCallActivity.launch(app, peer, type, displayName, openUrl, pictureUrl)
            } catch (_: Exception) {
            }
        }
    }

    fun cancelIncomingCall(context: Context, stopSound: Boolean = true) {
        try {
            NotificationManagerCompat.from(context.applicationContext)
                .cancel("sos-incoming-call", INCOMING_CALL_ID)
        } catch (_: Exception) {
        }
        IncomingCallActivity.dismiss(context)
        if (stopSound) {
            CallSoundHelper.stopRingtone()
        }
    }

    private fun postAggregateLocked(app: Context, playSound: Boolean) {
        val peerCount = peerMessageCounts.size
        val total = totalMessageCount.coerceAtLeast(1)
        val lines = inboxLines.toList()
        val openUrl = lastOpenUrl
        val focusPeer = lastPeerKey
            ?: lines.lastOrNull()?.peerKey
            ?: peerDisplayNames.keys.lastOrNull()
            ?: ""
        val focusName = peerDisplayNames[focusPeer]
            ?: lines.lastOrNull()?.senderName
            ?: "SOS"
        val focusPicture = peerPictureUrls[focusPeer]
            ?: lines.lastOrNull()?.pictureUrl
            ?: ""

        val (contentTitle, contentText) = when {
            peerCount <= 1 -> {
                if (total <= 1) {
                    focusName to (lines.lastOrNull()?.text ?: "הודעה חדשה")
                } else {
                    focusName to "$total הודעות חדשות"
                }
            }
            else -> {
                // כמו וואטסאפ: שם אחרון + סיכום כמה אנשים | HYPER CORE TECH
                focusName to "$total הודעות מ-$peerCount אנשים"
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

        val largeIcon = SosContactCache.getCachedBitmap(focusPicture)
            ?: try {
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
            .setVibrate(if (playSound) longArrayOf(0, 220) else longArrayOf(0))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            // כשצריך צליל – לא חוסמים עדכון של אותו כרטיס (הודעות חוזרות מאותו peer) | HYPER CORE TECH
            .setOnlyAlertOnce(!playSound)
            .setSilent(!playSound)

        try {
            NotificationManagerCompat.from(app).notify(MESSAGES_TAG, MESSAGES_AGGREGATE_ID, builder.build())
        } catch (_: SecurityException) {
        }

        if (playSound) {
            playMessageAlertOnce(app)
        }
    }

    private fun refreshAvatarAsync(app: Context, pictureUrl: String) {
        val url = pictureUrl.trim()
        if (url.isEmpty()) return
        avatarExecutor.execute {
            try {
                SosContactCache.loadBitmap(url) ?: return@execute
                synchronized(lock) {
                    if (inboxLines.isEmpty()) return@synchronized
                    postAggregateLocked(app, playSound = false)
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun playMessageAlertOnce(context: Context) {
        val now = System.currentTimeMillis()
        if (now - lastAlertAt < ALERT_DEBOUNCE_MS) return
        lastAlertAt = now
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

    private fun resolveSenderName(title: String, @Suppress("UNUSED_PARAMETER") peerKey: String): String {
        val cleaned = title.trim()
        val looksGeneric = cleaned.isEmpty()
            || cleaned.equals("SOS", ignoreCase = true)
            || cleaned.equals("משתמש", ignoreCase = false)
            || cleaned.startsWith("משתמש ")
            || cleaned.contains("הודעה חדשה")
            || cleaned.contains("קבלת הודעה")
            || cleaned.contains("קיבלת הודעה")
            || cleaned.matches(Regex("^[0-9a-fA-F]{8,64}$"))
        if (!looksGeneric) return cleaned
        // בלי שם אמיתי – לא מציגים מפתח ציבורי על המסך הנעול | HYPER CORE TECH
        return "הודעה חדשה"
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
