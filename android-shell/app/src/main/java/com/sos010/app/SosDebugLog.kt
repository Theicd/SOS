package com.sos010.app

import android.content.Context
import android.util.Log
import java.io.File
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

    /** שומר TXT לייצוא/שיתוף | HYPER CORE TECH */
    fun saveTxt(context: Context): File {
        val dir = File(context.getExternalFilesDir(null) ?: context.filesDir, "debug")
        if (!dir.exists()) dir.mkdirs()
        val out = File(dir, "SOS-bg-log-${fileFmt.format(Date())}.txt")
        out.writeText(getText(), Charsets.UTF_8)
        i("log", "exported ${out.name} (${out.length()} bytes)")
        return out
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
