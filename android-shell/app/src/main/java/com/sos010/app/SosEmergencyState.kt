package com.sos010.app

import java.util.concurrent.CopyOnWriteArrayList

/**
 * מצב משותף לרשת חירום מקומית – נגיש ל-Service / Activity / AndroidBridge | HYPER CORE TECH
 */
object SosEmergencyState {
    const val NETWORK_NAME = "SOS12345"
    const val NETWORK_PASSWORD = "SOS12345"
    const val SERVER_PORT = 9000
    const val DISCOVERY_PORT = 9001
    const val MAX_CHILDREN = 5

    const val ACTION_STATUS = "com.sos010.app.EMERGENCY_STATUS_UPDATE"
    const val ACTION_LOG = "com.sos010.app.EMERGENCY_SERVICE_LOG"
    const val ACTION_WEBVIEW = "com.sos010.app.EMERGENCY_WEBVIEW_MESSAGE"

    val sharedPeers = CopyOnWriteArrayList<String>()
    @Volatile var sharedParentIp: String? = null
    @Volatile var isRelayRunning: Boolean = false
    @Volatile var myIp: String? = null
    @Volatile var childCount: Int = 0
}
