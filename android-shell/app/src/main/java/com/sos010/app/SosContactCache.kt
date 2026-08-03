package com.sos010.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * קאש שמות ותמונות אנשי קשר לשימוש בהתראות רקע (בלי WebView).
 */
object SosContactCache {
    private const val PREFS = "sos_native_contacts"
    private const val KEY_MAP = "contacts_json"
    private const val TAG = "SosContactCache"
    private const val MAX_ENTRIES = 200

    data class Contact(
        val pubkey: String,
        val name: String,
        val picture: String
    )

    private val http = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(6, TimeUnit.SECONDS)
        .callTimeout(8, TimeUnit.SECONDS)
        .build()

    private val memory = LinkedHashMap<String, Contact>(64, 0.75f, true)
    private val bitmapMemory = LinkedHashMap<String, Bitmap>(24, 0.75f, true)

    fun put(context: Context, pubkey: String?, name: String?, picture: String?) {
        val pk = normalizePubkey(pubkey) ?: return
        val rawName = name?.trim().orEmpty()
        val cleanName = if (rawName.isNotEmpty() && !looksLikePubkeyLabel(rawName)) rawName else ""
        val cleanPicture = picture?.trim().orEmpty()
        if (cleanName.isEmpty() && cleanPicture.isEmpty()) return

        val prev = memory[pk]
        val merged = Contact(
            pubkey = pk,
            name = if (cleanName.isNotEmpty()) cleanName else (prev?.name ?: ""),
            picture = if (cleanPicture.isNotEmpty()) cleanPicture else (prev?.picture ?: "")
        )
        synchronized(memory) {
            memory[pk] = merged
            trimMemoryLocked()
        }
        persist(context.applicationContext)
    }

    fun get(context: Context, pubkey: String?): Contact? {
        val pk = normalizePubkey(pubkey) ?: return null
        synchronized(memory) {
            memory[pk]?.let { return it }
        }
        ensureLoaded(context.applicationContext)
        synchronized(memory) {
            return memory[pk]
        }
    }

    fun displayName(context: Context, pubkey: String?, fallback: String = "משתמש"): String {
        val contact = get(context, pubkey)
        val name = contact?.name?.trim().orEmpty()
        if (name.isNotEmpty() && !looksLikePubkeyLabel(name)) return name
        return fallback
    }

    fun clear(context: Context) {
        synchronized(memory) { memory.clear() }
        synchronized(bitmapMemory) { bitmapMemory.clear() }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_MAP).apply()
    }

    fun getCachedBitmap(pictureUrl: String?): Bitmap? {
        val url = pictureUrl?.trim().orEmpty()
        if (url.isEmpty() || url.startsWith("data:")) return null
        synchronized(bitmapMemory) {
            return bitmapMemory[url]
        }
    }

    fun loadBitmap(pictureUrl: String?): Bitmap? {
        val url = pictureUrl?.trim().orEmpty()
        if (url.isEmpty()) return null
        getCachedBitmap(url)?.let { return it }
        if (url.startsWith("data:image")) {
            return decodeDataUrl(url)?.also { cacheBitmap(url, it) }
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) return null
        return try {
            val req = Request.Builder().url(url).get().build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val bytes = resp.body?.bytes() ?: return null
                if (bytes.size > 1_500_000) return null
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
                val scaled = scaleSquare(bmp, 192)
                cacheBitmap(url, scaled)
                scaled
            }
        } catch (err: Exception) {
            Log.w(TAG, "avatar load fail: ${err.message}")
            null
        }
    }

    private fun cacheBitmap(url: String, bmp: Bitmap) {
        synchronized(bitmapMemory) {
            bitmapMemory[url] = bmp
            while (bitmapMemory.size > 24) {
                val oldest = bitmapMemory.entries.iterator()
                if (oldest.hasNext()) {
                    oldest.next()
                    oldest.remove()
                } else break
            }
        }
    }

    private fun decodeDataUrl(dataUrl: String): Bitmap? {
        return try {
            val comma = dataUrl.indexOf(',')
            if (comma < 0) return null
            val b64 = dataUrl.substring(comma + 1)
            val bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
            if (bytes.size > 1_500_000) return null
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
            scaleSquare(bmp, 192)
        } catch (_: Exception) {
            null
        }
    }

    private fun scaleSquare(src: Bitmap, size: Int): Bitmap {
        val w = src.width.coerceAtLeast(1)
        val h = src.height.coerceAtLeast(1)
        val side = minOf(w, h)
        val x = (w - side) / 2
        val y = (h - side) / 2
        val cropped = Bitmap.createBitmap(src, x, y, side, side)
        return if (side == size) cropped else Bitmap.createScaledBitmap(cropped, size, size, true)
    }

    private fun ensureLoaded(context: Context) {
        synchronized(memory) {
            if (memory.isNotEmpty()) return
            val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_MAP, "")
                .orEmpty()
            if (raw.isBlank()) return
            try {
                val obj = JSONObject(raw)
                val keys = obj.keys()
                while (keys.hasNext()) {
                    val pk = keys.next()
                    val item = obj.optJSONObject(pk) ?: continue
                    memory[pk] = Contact(
                        pubkey = pk,
                        name = item.optString("name"),
                        picture = item.optString("picture")
                    )
                }
            } catch (err: Exception) {
                Log.w(TAG, "load cache fail: ${err.message}")
            }
        }
    }

    private fun persist(context: Context) {
        val snapshot: Map<String, Contact>
        synchronized(memory) {
            snapshot = LinkedHashMap(memory)
        }
        try {
            val obj = JSONObject()
            snapshot.values.toList().takeLast(MAX_ENTRIES).forEach { c ->
                obj.put(
                    c.pubkey,
                    JSONObject()
                        .put("name", c.name)
                        .put("picture", c.picture)
                )
            }
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_MAP, obj.toString())
                .apply()
        } catch (err: Exception) {
            Log.w(TAG, "persist fail: ${err.message}")
        }
    }

    private fun trimMemoryLocked() {
        while (memory.size > MAX_ENTRIES) {
            val it = memory.entries.iterator()
            if (it.hasNext()) {
                it.next()
                it.remove()
            } else break
        }
    }

    private fun normalizePubkey(pubkey: String?): String? {
        val pk = pubkey?.trim()?.lowercase().orEmpty()
        return if (pk.matches(Regex("^[0-9a-f]{64}$"))) pk else null
    }

    private fun looksLikePubkeyLabel(name: String): Boolean {
        val n = name.trim()
        if (n.startsWith("משתמש ")) return true
        if (n.matches(Regex("^[0-9a-f]{8,64}$"))) return true
        return false
    }
}
