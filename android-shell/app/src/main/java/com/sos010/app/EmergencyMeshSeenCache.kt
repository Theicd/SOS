package com.sos010.app

/**
 * מטמון messageId חסום — LRU + תפוגה. בלי רשימה אינסופית. | HYPER CORE TECH
 */
class EmergencyMeshSeenCache(
    val maxIds: Int = MAX_IDS,
    val expireMs: Long = EXPIRE_MS
) {
    private val ids = LinkedHashMap<String, Long>(64, 0.75f, true)
    private val lock = Any()

    fun markIfNew(messageId: String, nowMs: Long = System.currentTimeMillis()): Boolean {
        if (messageId.isBlank()) return false
        synchronized(lock) {
            evict(nowMs)
            if (ids.containsKey(messageId)) return false
            ids[messageId] = nowMs
            evictOverflow()
            return true
        }
    }

    fun contains(messageId: String): Boolean {
        synchronized(lock) { return ids.containsKey(messageId) }
    }

    fun size(): Int {
        synchronized(lock) { return ids.size }
    }

    fun clear() {
        synchronized(lock) { ids.clear() }
    }

    private fun evict(nowMs: Long) {
        if (expireMs <= 0L) return
        val it = ids.entries.iterator()
        while (it.hasNext()) {
            val e = it.next()
            if (nowMs - e.value > expireMs) it.remove()
        }
    }

    private fun evictOverflow() {
        while (ids.size > maxIds) {
            val first = ids.entries.firstOrNull() ?: break
            ids.remove(first.key)
        }
    }

    companion object {
        const val MAX_IDS = 4000
        const val EXPIRE_MS = 5L * 60L * 1000L
    }
}
