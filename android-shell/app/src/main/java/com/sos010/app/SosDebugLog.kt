package com.sos010.app

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedDeque

/**
 * לוג רקע למעטפת APK – נשמר גם כשהכרטיסייה סגורה / מסך כבוי.
 */
object SosDebugLog {
    private const val TAG = "SosDebugLog"
    private const val MAX_LINES = 800
    private const val FILE_NAME = "sos-bg-debug.log"

    private val lines = ConcurrentLinkedDeque<String>()
    private val timeFmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    private val fileFmt = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)
    @Volatile private var appRef: Context? = null

    fun init(context: Context) {
        appRef = context.applicationContext
        i("boot", "SosDebugLog ready v=${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
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

    fun getLines(): List<String> = lines.toList()

    fun getText(): String {
        val header = buildString {
            appendLine("=== SOS Background Debug Log ===")
            appendLine("version=${BuildConfig.VERSION_NAME} code=${BuildConfig.VERSION_CODE}")
            appendLine("hasFcm=${BuildConfig.HAS_FCM}")
            appendLine("hostAlive=${MainActivity.isHostAlive} activityAlive=${MainActivity.isActivityAlive}")
            appendLine("exportedAt=${SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())}")
            appendLine("================================")
            appendLine()
        }
        return header + lines.joinToString("\n")
    }

    fun clear() {
        lines.clear()
        i("log", "cleared")
    }

    /** שומר TXT בתיקיית האפליקציה ומחזיר File | HYPER CORE TECH */
    fun saveTxt(context: Context): File {
        val dir = File(context.getExternalFilesDir(null) ?: context.filesDir, "debug")
        if (!dir.exists()) dir.mkdirs()
        val out = File(dir, "SOS-bg-log-${fileFmt.format(Date())}.txt")
        out.writeText(getText(), Charsets.UTF_8)
        // גם מעתיקים לקובץ רציף
        runCatching {
            File(dir, FILE_NAME).writeText(getText(), Charsets.UTF_8)
        }
        i("log", "saved ${out.name} (${out.length()} bytes)")
        return out
    }

    private fun append(level: String, source: String, message: String) {
        val line = "${timeFmt.format(Date())} $level/$source $message"
        lines.addLast(line)
        while (lines.size > MAX_LINES) lines.pollFirst()
        when (level) {
            "W" -> Log.w(TAG, "$source $message")
            "E" -> Log.e(TAG, "$source $message")
            else -> Log.i(TAG, "$source $message")
        }
        // append לקובץ רציף (best-effort)
        val app = appRef ?: return
        try {
            val dir = File(app.filesDir, "debug")
            if (!dir.exists()) dir.mkdirs()
            File(dir, FILE_NAME).appendText(line + "\n", Charsets.UTF_8)
        } catch (_: Exception) {
        }
    }
}
