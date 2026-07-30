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
        val title = message.notification?.title
            ?: message.data["title"]
            ?: "SOS"
        val body = message.notification?.body
            ?: message.data["body"]
            ?: "יש לך עדכון חדש"
        val url = message.data["url"]
        val tag = message.data["tag"]
        NotificationHelper.showMessage(applicationContext, title, body, url, tag)
    }
}
