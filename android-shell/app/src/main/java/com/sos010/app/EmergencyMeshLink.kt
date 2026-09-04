package com.sos010.app

import java.io.PrintWriter
import java.net.Socket

/**
 * חיבור TCP קבוע לקשת אחת (הורה או ילד). כתיבה תמיד סדרתית. | HYPER CORE TECH
 */
class EmergencyMeshLink(
    val remoteNodeId: String,
    val remoteBootId: String = "",
    val relation: MeshPeerRelation,
    var currentIp: String = "",
    private val writer: PrintWriter,
    private val socket: Socket? = null,
    private val onClosed: ((EmergencyMeshLink) -> Unit)? = null
) {
    @Volatile var state: MeshLinkState = MeshLinkState.ACTIVE
        private set
    @Volatile var lastRxMs: Long = System.currentTimeMillis()
        private set
    @Volatile var lastTxMs: Long = 0L
        private set
    @Volatile var lastHeartbeatMs: Long = 0L
        private set

    private val writeLock = Any()

    fun isLive(): Boolean {
        return state == MeshLinkState.ACTIVE ||
            state == MeshLinkState.HANDSHAKING ||
            state == MeshLinkState.DEGRADED ||
            state == MeshLinkState.CONNECTING
    }

    fun markRx(nowMs: Long = System.currentTimeMillis()) {
        lastRxMs = nowMs
        if (state == MeshLinkState.DEGRADED) {
            state = MeshLinkState.ACTIVE
        }
    }

    fun markDegraded() {
        if (state == MeshLinkState.ACTIVE) state = MeshLinkState.DEGRADED
    }

    fun isRxStale(nowMs: Long, timeoutMs: Long = HEARTBEAT_TIMEOUT_MS): Boolean {
        if (!isLive()) return true
        return nowMs - lastRxMs > timeoutMs
    }

    fun send(line: String): Boolean {
        if (!isLive()) return false
        synchronized(writeLock) {
            if (!isLive()) return false
            return try {
                writer.println(line)
                writer.flush()
                lastTxMs = System.currentTimeMillis()
                if (line == "PING") lastHeartbeatMs = lastTxMs
                if (writer.checkError()) {
                    close()
                    false
                } else {
                    true
                }
            } catch (_: Exception) {
                close()
                false
            }
        }
    }

    fun close() {
        if (state == MeshLinkState.CLOSED || state == MeshLinkState.CLOSING) return
        state = MeshLinkState.CLOSING
        synchronized(writeLock) {
            try { socket?.close() } catch (_: Exception) {}
            if (socket == null) {
                try { writer.close() } catch (_: Exception) {}
            }
        }
        state = MeshLinkState.CLOSED
        onClosed?.invoke(this)
    }

    companion object {
        const val HEARTBEAT_TIMEOUT_MS = 30_000L
    }
}
