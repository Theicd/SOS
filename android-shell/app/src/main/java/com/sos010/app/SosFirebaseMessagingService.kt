package com.sos010.app

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * מקבל FCM גם כשהאפליקציה סגורה / המסך כבוי – כמו וואטסאפ.
 * נטען רק כש-google-services.json קיים (HAS_FCM=true).
 */
class SosFirebaseMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        // ה-Web ימשוך דרך SosNativeShell.getFcmToken / אירוע
    }

    override fun onMessageReceived(message: RemoteMessage) {
        // כשהממשק פתוח – ה-Web מטפל (מונע כפילות מול RelayWatcher)
        if (MainActivity.isHostAlive) return

        val peerKey = message.data["peer"]
            ?: message.data["pubkey"]
            ?: message.data["peerKey"]
            ?: message.data["peerPubkey"]
        val cached = SosContactCache.get(applicationContext, peerKey)
        val title = cached?.name?.takeIf { it.isNotBlank() && !it.startsWith("משתמש ") }
            ?: message.notification?.title
            ?: message.data["title"]
            ?: "SOS"
        val body = message.notification?.body
            ?: message.data["body"]
            ?: "יש לך עדכון חדש"
        val url = message.data["url"]
        val tag = message.data["tag"]
        val eventId = message.data["eventId"]
            ?: message.data["event_id"]
            ?: message.messageId

        NotificationHelper.showMessage(
            applicationContext,
            title,
            body,
            url,
            tag,
            eventId = eventId,
            peerKey = peerKey,
            pictureUrl = cached?.picture
        )
    }
}
