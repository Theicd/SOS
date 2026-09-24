package com.sos010.app

import java.util.concurrent.ConcurrentHashMap

/**
 * MD2 — single-use pairingId+nonce replay protection (phone/responder side).
 * Local only; not a remote revocation registry.
 * HYPER CORE TECH
 */
class SosPairingSpentStore(
    private val maxEntries: Int = 512,
) {
    private val spent = ConcurrentHashMap<String, Long>()

    fun key(pairingId: String, nonce: String): String =
        SosDeviceKeyCrypto.normalizeHex(pairingId) + ":" + SosDeviceKeyCrypto.normalizeHex(nonce)

    fun isSpent(pairingId: String, nonce: String): Boolean =
        spent.containsKey(key(pairingId, nonce))

    /** Returns false if already spent (replay). */
    fun tryConsume(pairingId: String, nonce: String, nowMs: Long = System.currentTimeMillis()): Boolean {
        val k = key(pairingId, nonce)
        if (spent.putIfAbsent(k, nowMs) != null) return false
        trim(nowMs)
        return true
    }

    private fun trim(nowMs: Long) {
        if (spent.size <= maxEntries) return
        val oldest = spent.entries.sortedBy { it.value }.take(spent.size - maxEntries)
        for (e in oldest) spent.remove(e.key, e.value)
        // Also drop very old (> 24h) opportunistically
        val cutoff = nowMs - 24L * 60L * 60L * 1000L
        spent.entries.removeIf { it.value < cutoff }
    }
}
