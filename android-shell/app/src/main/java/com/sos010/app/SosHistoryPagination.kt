package com.sos010.app

import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets

/**
 * MD4 S4 — deterministic kind-1050 pagination helpers.
 * Canonical order: created_at ascending, then eventId ascending (handles same-second ties).
 */
object SosHistoryPagination {
    data class Cursor(val createdAt: Long, val eventId: String) {
        fun toJson(): JSONObject =
            JSONObject()
                .put("createdAt", createdAt)
                .put("eventId", SosDeviceKeyCrypto.normalizeHex(eventId))

        companion object {
            fun fromJson(o: JSONObject?): Cursor? {
                if (o == null) return null
                val id = SosDeviceKeyCrypto.normalizeHex(o.optString("eventId"))
                if (!SosDeviceKeyCrypto.isHex64(id)) return null
                return Cursor(o.optLong("createdAt", 0L), id)
            }

            val ZERO = Cursor(0L, "0".repeat(64))
        }
    }

    data class Page(
        val events: JSONArray,
        val cursorAfter: Cursor?,
        val hasMore: Boolean,
        val byteSize: Int,
    )

    fun eventId(ev: JSONObject): String = SosDeviceKeyCrypto.normalizeHex(ev.optString("id"))

    fun createdAt(ev: JSONObject): Long = ev.optLong("created_at", 0L)

    /** Compare two events / cursors: negative if a < b. */
    fun compare(aCreated: Long, aId: String, bCreated: Long, bId: String): Int {
        val c = aCreated.compareTo(bCreated)
        if (c != 0) return c
        return SosDeviceKeyCrypto.normalizeHex(aId).compareTo(SosDeviceKeyCrypto.normalizeHex(bId))
    }

    fun compareEvent(a: JSONObject, b: JSONObject): Int =
        compare(createdAt(a), eventId(a), createdAt(b), eventId(b))

    fun compareToCursor(ev: JSONObject, cursor: Cursor): Int =
        compare(createdAt(ev), eventId(ev), cursor.createdAt, cursor.eventId)

    /** Stable sort + dedupe by eventId (first wins; conflicting content flagged separately). */
    fun sortAndDedupe(events: JSONArray): Pair<List<JSONObject>, Int> {
        val byId = LinkedHashMap<String, JSONObject>()
        var conflicts = 0
        for (i in 0 until events.length()) {
            val ev = events.optJSONObject(i) ?: continue
            val id = eventId(ev)
            if (!SosDeviceKeyCrypto.isHex64(id)) continue
            val prev = byId[id]
            if (prev == null) {
                byId[id] = ev
            } else if (prev.toString() != ev.toString()) {
                conflicts += 1
            }
        }
        val sorted = byId.values.sortedWith { a, b -> compareEvent(a, b) }
        return sorted to conflicts
    }

    /**
     * Merge two sorted event lists by (created_at, id), preferring left on identical id.
     */
    fun mergeSorted(left: List<JSONObject>, right: List<JSONObject>): List<JSONObject> {
        val out = ArrayList<JSONObject>(left.size + right.size)
        var i = 0
        var j = 0
        while (i < left.size && j < right.size) {
            val c = compareEvent(left[i], right[j])
            when {
                c < 0 -> out.add(left[i++])
                c > 0 -> out.add(right[j++])
                else -> {
                    out.add(left[i++])
                    j++
                }
            }
        }
        while (i < left.size) out.add(left[i++])
        while (j < right.size) out.add(right[j++])
        return out
    }

    fun afterCursor(sorted: List<JSONObject>, cursor: Cursor?): List<JSONObject> {
        if (cursor == null) return sorted
        return sorted.filter { compareToCursor(it, cursor) > 0 }
    }

    fun pageOf(
        sorted: List<JSONObject>,
        startIndex: Int,
        maxEvents: Int = SosHistorySyncCrypto.MAX_BATCH_EVENTS,
        maxBytes: Int = SosHistorySyncCrypto.MAX_BATCH_BYTES,
    ): Page {
        if (startIndex >= sorted.size) {
            return Page(JSONArray(), null, false, 2)
        }
        val arr = JSONArray()
        var bytes = 2 // []
        var last: JSONObject? = null
        var i = startIndex
        while (i < sorted.size && arr.length() < maxEvents) {
            val ev = sorted[i]
            val piece = ev.toString().toByteArray(StandardCharsets.UTF_8)
            val nextBytes = bytes + piece.size + if (arr.length() > 0) 1 else 0
            if (arr.length() > 0 && nextBytes > maxBytes) break
            if (arr.length() == 0 && piece.size > maxBytes) {
                // Single oversized event — fail closed by skipping (caller may treat as gap).
                i++
                continue
            }
            arr.put(ev)
            bytes = nextBytes
            last = ev
            i++
        }
        val cursorAfter =
            if (last != null) Cursor(createdAt(last), eventId(last)) else null
        return Page(arr, cursorAfter, i < sorted.size, bytes)
    }

    fun buildPages(
        events: JSONArray,
        resumeAfter: Cursor? = null,
        maxEvents: Int = SosHistorySyncCrypto.MAX_BATCH_EVENTS,
        maxBytes: Int = SosHistorySyncCrypto.MAX_BATCH_BYTES,
    ): List<Page> {
        val (sorted, _) = sortAndDedupe(events)
        val slice = afterCursor(sorted, resumeAfter)
        val pages = ArrayList<Page>()
        var idx = 0
        while (idx < slice.size) {
            val page = pageOf(slice, idx, maxEvents, maxBytes)
            if (page.events.length() == 0) break
            pages.add(page)
            idx += page.events.length()
        }
        if (pages.isEmpty()) {
            pages.add(Page(JSONArray(), resumeAfter, false, 2))
            return pages
        }
        return pages.mapIndexed { i, p -> p.copy(hasMore = i < pages.size - 1) }
    }
}
