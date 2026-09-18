package com.sos010.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

/**
 * Contact name + avatar cache for Native call UI / notifications.
 * data:image Base64 is decoded, downsampled (<=320px), and stored as a private file —
 * never truncated mid-stream into SharedPreferences.
 */
object SosContactCache {
    private const val PREFS = "sos_native_contacts"
    private const val KEY_MAP = "contacts_json"
    private const val TAG = "SosContactCache"
    private const val MAX_ENTRIES = 200
    private const val MAX_HTTP_URL_CHARS = 2048
    private const val MAX_DATA_URL_CHARS = 2_800_000
    private const val MAX_DECODED_BYTES = 2 * 1024 * 1024
    private const val AVATAR_SIZE = 320
    private const val AVATAR_DIR = "call_avatars"
    private const val AVATAR_FILE_PREFIX = "avatarfile:"

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
        val app = context.applicationContext
        val pk = normalizePubkey(pubkey) ?: return
        val rawName = name?.trim().orEmpty()
        val cleanName = if (rawName.isNotEmpty() && !looksLikePubkeyLabel(rawName)) rawName else ""
        val incomingPic = picture?.trim().orEmpty()
        if (cleanName.isEmpty() && incomingPic.isEmpty()) return

        ensureLoaded(app)
        val prev = get(app, pk)
        val resolvedPicture = resolvePictureForStore(app, pk, incomingPic, prev?.picture.orEmpty())
        val merged = Contact(
            pubkey = pk,
            name = if (cleanName.isNotEmpty()) cleanName else (prev?.name ?: ""),
            picture = if (resolvedPicture.isNotEmpty()) resolvedPicture else (prev?.picture ?: "")
        )
        if (merged.name.isEmpty() && merged.picture.isEmpty()) return
        synchronized(memory) {
            memory[pk] = merged
            trimMemoryLocked()
        }
        persist(app)
    }

    fun get(context: Context, pubkey: String?): Contact? {
        val pk = normalizePubkey(pubkey) ?: return null
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
        try {
            avatarDir(context.applicationContext).listFiles()?.forEach { it.delete() }
        } catch (_: Exception) {
        }
    }

    fun getCachedBitmap(pictureUrl: String?): Bitmap? {
        val key = pictureCacheKey(pictureUrl) ?: return null
        synchronized(bitmapMemory) {
            return bitmapMemory[key]
        }
    }

    /** Prefer this overload — resolves avatarfile: against app private storage. */
    fun loadBitmap(context: Context, pictureUrl: String?): Bitmap? {
        val url = pictureUrl?.trim().orEmpty()
        if (url.isEmpty()) return null
        getCachedBitmap(url)?.let {
            Log.i(TAG, "AVATAR_NATIVE_CACHE_HIT")
            return it
        }
        Log.i(TAG, "AVATAR_NATIVE_CACHE_MISS")
        val bmp = when {
            url.startsWith(AVATAR_FILE_PREFIX) -> {
                val file = resolveAvatarFile(context.applicationContext, url) ?: return null
                decodeFile(file)
            }
            url.startsWith("data:image") -> decodeDataUrl(url)
            url.startsWith("http://") || url.startsWith("https://") -> fetchHttpAvatar(url)
            else -> null
        } ?: run {
            if (url.startsWith("data:image") || url.startsWith(AVATAR_FILE_PREFIX)) {
                Log.i(TAG, "AVATAR_NATIVE_DECODE_FAIL")
            }
            return null
        }
        cacheBitmap(url, bmp)
        return bmp
    }

    /** @deprecated Prefer loadBitmap(context, url) for avatarfile support. */
    fun loadBitmap(pictureUrl: String?): Bitmap? {
        val url = pictureUrl?.trim().orEmpty()
        if (url.isEmpty()) return null
        if (url.startsWith(AVATAR_FILE_PREFIX)) return null
        getCachedBitmap(url)?.let { return it }
        val bmp = when {
            url.startsWith("data:image") -> decodeDataUrl(url)
            url.startsWith("http://") || url.startsWith("https://") -> fetchHttpAvatar(url)
            else -> null
        } ?: return null
        cacheBitmap(url, bmp)
        return bmp
    }

    private fun resolvePictureForStore(
        context: Context,
        pk: String,
        incoming: String,
        previous: String
    ): String {
        if (incoming.isEmpty()) return previous
        if (incoming.startsWith(AVATAR_FILE_PREFIX)) {
            val f = resolveAvatarFile(context, incoming)
            return if (f != null) incoming else previous
        }
        if (incoming.startsWith("http://") || incoming.startsWith("https://")) {
            if (incoming.length > MAX_HTTP_URL_CHARS) {
                Log.i(TAG, "AVATAR_NATIVE_STORE_FAIL")
                return previous
            }
            Log.i(TAG, "AVATAR_NATIVE_STORE_OK")
            return incoming
        }
        if (incoming.startsWith("data:image/")) {
            val stored = persistDataAvatar(context, pk, incoming)
            if (stored != null) {
                Log.i(TAG, "AVATAR_NATIVE_STORE_OK")
                return stored
            }
            Log.i(TAG, "AVATAR_NATIVE_STORE_FAIL")
            return previous
        }
        return previous
    }

    private fun persistDataAvatar(context: Context, pk: String, dataUrl: String): String? {
        if (dataUrl.length > MAX_DATA_URL_CHARS) {
            Log.i(TAG, "AVATAR_NATIVE_DECODE_FAIL")
            return null
        }
        val bmp = decodeDataUrl(dataUrl) ?: run {
            Log.i(TAG, "AVATAR_NATIVE_DECODE_FAIL")
            return null
        }
        return try {
            val dir = avatarDir(context)
            if (!dir.exists()) dir.mkdirs()
            val out = File(dir, "$pk.jpg")
            FileOutputStream(out).use { fos ->
                bmp.compress(Bitmap.CompressFormat.JPEG, 82, fos)
            }
            "$AVATAR_FILE_PREFIX${out.name}"
        } catch (err: Exception) {
            Log.w(TAG, "AVATAR_NATIVE_STORE_FAIL")
            null
        }
    }

    private fun avatarDir(context: Context): File {
        return File(context.filesDir, AVATAR_DIR)
    }

    private fun resolveAvatarFile(context: Context, ref: String): File? {
        val name = ref.removePrefix(AVATAR_FILE_PREFIX).trim()
        if (!name.matches(Regex("^[0-9a-f]{64}\\.jpg$"))) return null
        val f = File(avatarDir(context), name)
        return if (f.isFile && f.exists()) f else null
    }

    private fun fetchHttpAvatar(url: String): Bitmap? {
        return try {
            val req = Request.Builder().url(url).get().build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val bytes = resp.body?.bytes() ?: return null
                if (bytes.size > MAX_DECODED_BYTES) return null
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
                scaleSquare(bmp, AVATAR_SIZE)
            }
        } catch (err: Exception) {
            Log.w(TAG, "avatar http fail")
            null
        }
    }

    private fun decodeFile(file: File): Bitmap? {
        return try {
            BitmapFactory.decodeFile(file.absolutePath)?.let { scaleSquare(it, AVATAR_SIZE) }
        } catch (_: Exception) {
            null
        }
    }

    private fun pictureCacheKey(pictureUrl: String?): String? {
        val url = pictureUrl?.trim().orEmpty()
        return if (url.isEmpty()) null else url
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
            val headerEnd = dataUrl.indexOf(',')
            if (headerEnd < 0) return null
            val header = dataUrl.substring(0, headerEnd).lowercase()
            if (!header.startsWith("data:image/jpeg")
                && !header.startsWith("data:image/jpg")
                && !header.startsWith("data:image/png")
                && !header.startsWith("data:image/webp")
            ) {
                return null
            }
            val b64 = dataUrl.substring(headerEnd + 1)
            if (b64.length > (MAX_DECODED_BYTES * 4 / 3) + 64) return null
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            if (bytes == null || bytes.size > MAX_DECODED_BYTES) return null
            val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
            if (opts.outWidth <= 0 || opts.outHeight <= 0) return null
            if (opts.outWidth > 8192 || opts.outHeight > 8192) return null
            val sample = sampleSizeFor(opts.outWidth, opts.outHeight, AVATAR_SIZE * 2)
            val decodeOpts = BitmapFactory.Options().apply { inSampleSize = sample }
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, decodeOpts) ?: return null
            scaleSquare(bmp, AVATAR_SIZE)
        } catch (_: Exception) {
            null
        }
    }

    private fun sampleSizeFor(w: Int, h: Int, target: Int): Int {
        var sample = 1
        var cw = w
        var ch = h
        while (cw / 2 >= target && ch / 2 >= target) {
            cw /= 2
            ch /= 2
            sample *= 2
        }
        return sample.coerceAtLeast(1)
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
                    var pic = item.optString("picture")
                    // Drop truncated/orphan data: leftovers from old clampText(2048) bug.
                    if (pic.startsWith("data:image") && (pic.length < 64 || !pic.contains(","))) {
                        pic = ""
                    }
                    // Never keep raw data:image in prefs map after migration.
                    if (pic.startsWith("data:image")) pic = ""
                    memory[pk] = Contact(
                        pubkey = pk,
                        name = item.optString("name"),
                        picture = pic
                    )
                }
            } catch (err: Exception) {
                Log.w(TAG, "load cache fail")
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
                val pic = when {
                    c.picture.startsWith(AVATAR_FILE_PREFIX) -> c.picture
                    c.picture.startsWith("http://") || c.picture.startsWith("https://") ->
                        c.picture.take(MAX_HTTP_URL_CHARS)
                    else -> ""
                }
                obj.put(
                    c.pubkey,
                    JSONObject()
                        .put("name", c.name)
                        .put("picture", pic)
                )
            }
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_MAP, obj.toString())
                .apply()
        } catch (err: Exception) {
            Log.w(TAG, "persist fail")
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
