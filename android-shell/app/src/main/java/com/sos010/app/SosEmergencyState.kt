package com.sos010.app

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList

/**
 * מצב משותף לרשת חירום מקומית – נגיש ל-Service / Activity / AndroidBridge | HYPER CORE TECH
 */
object SosEmergencyState {
    const val NETWORK_NAME = "SOS12345"
    const val NETWORK_PASSWORD = "SOS12345"
    const val SERVER_PORT = 9000
    const val DISCOVERY_PORT = 9001
    const val MAX_CHILDREN = 3

    const val ACTION_STATUS = "com.sos010.app.EMERGENCY_STATUS_UPDATE"
    const val ACTION_LOG = "com.sos010.app.EMERGENCY_SERVICE_LOG"
    const val ACTION_WEBVIEW = "com.sos010.app.EMERGENCY_WEBVIEW_MESSAGE"

    data class EmergencyPeerProfile(
        val ip: String,
        val pubkey: String = "",
        val name: String = "",
        val picture: String = ""
    )

    /** מ-SOS_HERE UDP — לסינון רשתות מלאות בסריקה | HYPER CORE TECH */
    data class SosDiscoveryEntry(
        val ssid: String,
        val ip: String,
        val childCount: Int,
        val maxChildren: Int,
        val lastSeenMs: Long
    )

    /** ילדים TCP ישירים — להסתרת hotspot שלהם מהסריקה של ההורה */
    val relayChildIps = CopyOnWriteArrayList<String>()
    val hiddenChildSsids = CopyOnWriteArrayList<String>()
    val discoveryBySsid = ConcurrentHashMap<String, SosDiscoveryEntry>()

    data class EmergencyInboxItem(
        val callback: String,
        val fromIp: String,
        val data: String
    )

    val sharedPeers = CopyOnWriteArrayList<String>()
    val peerProfiles = ConcurrentHashMap<String, EmergencyPeerProfile>()
    val inbox = ConcurrentLinkedQueue<EmergencyInboxItem>()

    @Volatile var sharedParentIp: String? = null
    @Volatile var isRelayRunning: Boolean = false
    @Volatile var myIp: String? = null
    @Volatile var childCount: Int = 0

    @Volatile var myDisplayName: String = ""
    @Volatile var myPicture: String = ""
    @Volatile var identityVersion: Int = 0

    /** true רק אחרי לחיצה על אייקון SOS חירום – לא מזיהוי רשת אוטומטי | HYPER CORE TECH */
    @Volatile var offlineShellRequested: Boolean = false

    private const val MAX_SCREEN_LOG = 16000
    private val screenLog = StringBuilder()
    private val logLock = Any()

    /** נקודה חמה של מי שכבר מחובר אלינו — אסור שתופיע בסריקה או שנתחבר אליה | HYPER CORE TECH */
    fun rememberDownstreamSsid(ssid: String) {
        val clean = ssid.trim()
        if (clean.isEmpty()) return
        if (hiddenChildSsids.none { it.equals(clean, ignoreCase = true) }) {
            hiddenChildSsids.add(clean)
        }
    }

    fun isDownstreamSsid(ssid: String): Boolean {
        return hiddenChildSsids.any { it.equals(ssid, ignoreCase = true) }
    }

    fun upsertPeer(ip: String, pubkey: String = "", name: String = "", picture: String = "") {
        if (ip.isBlank()) return
        val prev = peerProfiles[ip]
        peerProfiles[ip] = EmergencyPeerProfile(
            ip = ip,
            pubkey = pubkey.ifBlank { prev?.pubkey ?: "" },
            name = name.ifBlank { prev?.name ?: "" },
            picture = picture.ifBlank { prev?.picture ?: "" }
        )
    }

    fun enqueueInbox(callback: String, fromIp: String, data: String) {
        inbox.offer(EmergencyInboxItem(callback, fromIp, data))
        while (inbox.size > 200) {
            inbox.poll() ?: break
        }
    }

    fun appendScreenLog(line: String) {
        synchronized(logLock) {
            screenLog.append(line).append('\n')
            if (screenLog.length > MAX_SCREEN_LOG) {
                screenLog.delete(0, screenLog.length - 10000)
            }
        }
    }

    fun screenLogText(): String = synchronized(logLock) { screenLog.toString() }
}
