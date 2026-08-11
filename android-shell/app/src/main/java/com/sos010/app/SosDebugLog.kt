package com.sos010.app

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedDeque

/**
 * לוג רקע למעטפת APK.
 * מקור האמת = קובץ בדיסק (שורד סגירת כרטיסייה / קריסה / פתיחה מחדש).
 */
object SosDebugLog {
    private const val TAG = "SosDebugLog"
    private const val MAX_LINES = 2000
    private const val FILE_NAME = "sos-bg-debug.log"

    private val lines = ConcurrentLinkedDeque<String>()
    private val timeFmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    private val fileFmt = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)
    private val lock = Any()
    @Volatile private var appRef: Context? = null
    @Volatile private var loaded = false

    fun init(context: Context) {
        appRef = context.applicationContext
        reloadFromDisk()
        i("boot", "SosDebugLog ready v=${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) lines=${lines.size}")
    }

    /** טוען מחדש מהקובץ (אחרי פתיחת מסך / חזרה מתהליך) | HYPER CORE TECH */
    fun reloadFromDisk() {
        val app = appRef ?: return
        synchronized(lock) {
            lines.clear()
            val file = persistentFile(app)
            if (file.exists()) {
                try {
                    val all = file.readLines(Charsets.UTF_8)
                    val keep = if (all.size > MAX_LINES) all.takeLast(MAX_LINES) else all
                    keep.forEach { line ->
                        if (line.isNotBlank()) lines.addLast(line)
                    }
                    // אם קיצצנו – כותבים חזרה
                    if (all.size > MAX_LINES) {
                        file.writeText(keep.joinToString("\n") + "\n", Charsets.UTF_8)
                    }
                } catch (err: Exception) {
                    Log.w(TAG, "reload failed: ${err.message}")
                }
            }
            loaded = true
        }
    }

    fun i(source: String, message: String) = append("I", source, message)
    fun w(source: String, message: String) = append("W", source, message)
    fun e(source: String, message: String) = append("E", source, message)

    fun snapshotFlags(extra: String = "") {
        i(
            "flags",
            "hostAlive=${MainActivity.isHostAlive} activityAlive=${MainActivity.isActivityAlive}" +
                (if (extra.isNotBlank()) " $extra" else "")
        )
    }

    fun getLines(): List<String> {
        // תמיד מרעננים מהדיסק לפני תצוגה – כדי לראות מה שנכתב ברקע/בתהליך קודם
        reloadFromDisk()
        return lines.toList()
    }

    fun getText(): String {
        val body = getLines().joinToString("\n")
        val header = buildString {
            appendLine("=== SOS Background Debug Log ===")
            appendLine("version=${BuildConfig.VERSION_NAME} code=${BuildConfig.VERSION_CODE}")
            appendLine("hasFcm=${BuildConfig.HAS_FCM}")
            appendLine("hostAlive=${MainActivity.isHostAlive} activityAlive=${MainActivity.isActivityAlive}")
            appendLine("lines=${lines.size}")
            appendLine("exportedAt=${SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())}")
            appendLine("================================")
            appendLine()
        }
        return header + body
    }

    /** איפוס היסטוריה – מוחק זיכרון + קובץ | HYPER CORE TECH */
    fun clear() {
        val app = appRef
        synchronized(lock) {
            lines.clear()
            if (app != null) {
                runCatching { persistentFile(app).delete() }
                runCatching {
                    val ext = File(app.getExternalFilesDir(null) ?: app.filesDir, "debug")
                    File(ext, FILE_NAME).delete()
                }
            }
        }
        i("log", "history reset by user")
    }

    data class SavedExport(
        val displayName: String,
        val publicPathHint: String,
        val shareUri: Uri
    )

    /**
     * שומר TXT לתיקיית Downloads הציבורית (נראה באפליקציית קבצים).
     * ב-API 29+ דרך MediaStore; לפני כן ל-Environment.DIRECTORY_DOWNLOADS.
     */
    fun saveTxt(context: Context): SavedExport {
        val name = "SOS-bg-log-${fileFmt.format(Date())}.txt"
        val body = getText().toByteArray(Charsets.UTF_8)
        val saved = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveTxtViaMediaStore(context, name, body)
        } else {
            saveTxtToPublicDownloadsLegacy(context, name, body)
        }
        i("log", "exported ${saved.displayName} → ${saved.publicPathHint} (${body.size} bytes)")
        return saved
    }

    private fun saveTxtViaMediaStore(context: Context, name: String, body: ByteArray): SavedExport {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, "text/plain")
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: error("MediaStore insert failed")
        resolver.openOutputStream(uri)?.use { it.write(body) }
            ?: error("MediaStore openOutputStream failed")
        values.clear()
        values.put(MediaStore.Downloads.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        return SavedExport(
            displayName = name,
            publicPathHint = "Downloads/$name",
            shareUri = uri
        )
    }

    @Suppress("DEPRECATION")
    private fun saveTxtToPublicDownloadsLegacy(context: Context, name: String, body: ByteArray): SavedExport {
        val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        if (!dir.exists()) dir.mkdirs()
        val out = File(dir, name)
        FileOutputStream(out).use { it.write(body) }
        android.media.MediaScannerConnection.scanFile(
            context,
            arrayOf(out.absolutePath),
            arrayOf("text/plain"),
            null
        )
        val shareUri = androidx.core.content.FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            out
        )
        return SavedExport(
            displayName = name,
            publicPathHint = "Downloads/$name",
            shareUri = shareUri
        )
    }

    private fun append(level: String, source: String, message: String) {
        val day = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
        val line = "$day ${timeFmt.format(Date())} $level/$source $message"
        synchronized(lock) {
            lines.addLast(line)
            while (lines.size > MAX_LINES) lines.pollFirst()
            val app = appRef
            if (app != null) {
                try {
                    val file = persistentFile(app)
                    file.parentFile?.mkdirs()
                    file.appendText(line + "\n", Charsets.UTF_8)
                } catch (_: Exception) {
                }
            }
        }
        when (level) {
            "W" -> Log.w(TAG, "$source $message")
            "E" -> Log.e(TAG, "$source $message")
            else -> Log.i(TAG, "$source $message")
        }
    }

    private fun persistentFile(context: Context): File {
        val dir = File(context.filesDir, "debug")
        if (!dir.exists()) dir.mkdirs()
        return File(dir, FILE_NAME)
    }
}
