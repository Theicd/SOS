package com.sos010.app

/**
 * כתובות שיחה נכנסת – בלי chat= כדי לא לפתוח פאנל הודעות מאחורי מסך השיחה.
 */
object SosCallUrls {
    fun acceptPage(callType: String): String {
        val type = when (callType.trim().lowercase()) {
            "video", "v", "v-offer" -> "video"
            else -> "voice"
        }
        return "https://sos010.com/videos.html?incomingCall=$type"
    }

    fun warmPage(): String = BuildConfig.SOS_START_URL
}
