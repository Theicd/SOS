package com.sos010.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/**
 * גשר JS ← Native. נחשף כ-window.SosNativeShell בתוך ה-WebView.
 * לא מתנגש עם AndroidBridge של רשת החירום.
 */
class SosJsBridge(
    private val context: Context,
    private val webView: WebView
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var cachedFcmToken: String = ""

    init {
        refreshFcmToken()
    }

    @JavascriptInterface
    fun isNativeShell(): Boolean = true

    /** true רק כשהממשק בחזית – ל-JS: התראות / אי־סימון נצפה ברקע | HYPER CORE TECH */
    @JavascriptInterface
    fun isHostAlive(): Boolean = MainActivity.isHostAlive

    @JavascriptInterface
    fun hasFcm(): Boolean = BuildConfig.HAS_FCM

    @JavascriptInterface
    fun getFcmToken(): String = cachedFcmToken

    @JavascriptInterface
    fun refreshFcmToken() {
        if (!BuildConfig.HAS_FCM) return
        try {
            val clazz = Class.forName("com.google.firebase.messaging.FirebaseMessaging")
            val instance = clazz.getMethod("getInstance").invoke(null)
            val task = clazz.getMethod("getToken").invoke(instance)
            val addOnSuccess = task.javaClass.getMethod(
                "addOnSuccessListener",
                Class.forName("com.google.android.gms.tasks.OnSuccessListener")
            )
            val listener = java.lang.reflect.Proxy.newProxyInstance(
                context.classLoader,
                arrayOf(Class.forName("com.google.android.gms.tasks.OnSuccessListener"))
            ) { _, method, args ->
                if (method.name == "onSuccess" && args != null && args.isNotEmpty()) {
                    cachedFcmToken = args[0]?.toString() ?: ""
                    mainHandler.post {
                        webView.evaluateJavascript(
                            "window.dispatchEvent(new CustomEvent('sos-fcm-token',{detail:${JSONObject.quote(cachedFcmToken)}}));",
                            null
                        )
                    }
                }
                null
            }
            addOnSuccess.invoke(task, listener)
        } catch (_: Throwable) {
            // Firebase לא מוגדר / אין google-services.json
        }
    }

    @JavascriptInterface
    fun showNotification(title: String?, body: String?, openUrl: String?, tag: String?) {
        NotificationHelper.showMessage(
            context.applicationContext,
            title?.ifBlank { "SOS" } ?: "SOS",
            body?.ifBlank { "יש לך עדכון חדש" } ?: "יש לך עדכון חדש",
            openUrl,
            tag,
            eventId = null,
            peerKey = null
        )
    }

    /** התראת הודעה עם מזהה אירוע – מונע כפילות מול שירות הרקע | HYPER CORE TECH */
    @JavascriptInterface
    fun showChatNotification(
        title: String?,
        body: String?,
        openUrl: String?,
        tag: String?,
        eventId: String?,
        peerKey: String?
    ) {
        NotificationHelper.showMessage(
            context.applicationContext,
            title?.ifBlank { "SOS" } ?: "SOS",
            body?.ifBlank { "יש לך עדכון חדש" } ?: "יש לך עדכון חדש",
            openUrl,
            tag,
            eventId = eventId,
            peerKey = peerKey
        )
    }

    @JavascriptInterface
    fun clearMessageNotifications() {
        NotificationHelper.clearMessageNotifications(context.applicationContext)
    }

    /** שמירת pubkey לשירות הרקע – חובה לקבלת הודעות כשהממשק סגור | HYPER CORE TECH */
    @JavascriptInterface
    fun setUserPubkey(pubkey: String?) {
        SosSessionStore.setPubkey(context.applicationContext, pubkey)
        SosForegroundService.start(context.applicationContext)
        SosRelayWatcher.ensureStarted(context.applicationContext)
        SosP2pStandby.ensureStarted(context.applicationContext)
    }

    /** מפתח פרטי ל-P2P Native ברקע (אחרי סגירת כרטיסייה) | HYPER CORE TECH */
    @JavascriptInterface
    fun setUserPrivkey(privkey: String?) {
        SosSessionStore.setPrivkey(context.applicationContext, privkey)
    }

    /** הפעלת/כיבוי שמירת P2P במצב המתנה (ברירת מחדל: דלוק) | HYPER CORE TECH */
    @JavascriptInterface
    fun setP2pStandbyEnabled(enabled: Boolean) {
        SosSessionStore.setP2pStandbyEnabled(context.applicationContext, enabled)
        if (enabled) {
            SosP2pStandby.ensureStarted(context.applicationContext)
        }
    }

    /** סנכרון רשימת peers מועדפים ל-P2P Native ברקע (CSV) | HYPER CORE TECH */
    @JavascriptInterface
    fun syncP2pPeers(peersCsv: String?) {
        SosSessionStore.setP2pPeers(context.applicationContext, peersCsv)
        // שומרים רשימה בלבד – בלי להרים Native לכל ה-peers | HYPER CORE TECH
    }

    /** העברת קובץ פעילה – WakeLock + pump ל-WebView במסך כבוי | HYPER CORE TECH */
    @JavascriptInterface
    fun setP2pTransferActive(active: Boolean) {
        SosP2pTransferKeeper.setActive(context.applicationContext, active)
        if (active) {
            MainActivity.pumpWebViewKeepAlive()
        }
    }

    /** שמירת שם+תמונה של איש קשר להתראות רקע בסגנון וואטסאפ | HYPER CORE TECH */
    @JavascriptInterface
    fun cacheContact(pubkey: String?, name: String?, picture: String?) {
        SosContactCache.put(context.applicationContext, pubkey, name, picture)
    }

    @JavascriptInterface
    fun clearUserSession() {
        SosSessionStore.clear(context.applicationContext)
        SosContactCache.clear(context.applicationContext)
        SosRelayWatcher.stopAll()
    }

    @JavascriptInterface
    fun keepAlive() {
        val intent = android.content.Intent(context, SosForegroundService::class.java)
        androidx.core.content.ContextCompat.startForegroundService(context, intent)
        SosRelayWatcher.ensureStarted(context.applicationContext)
    }

    @JavascriptInterface
    fun startCallRingtone() {
        CallSoundHelper.startRingtone(context.applicationContext)
    }

    @JavascriptInterface
    fun stopCallRingtone() {
        CallSoundHelper.stopRingtone()
        // לא סוגרים מסך שיחה נייטיבי – רק צלצול/התראה | HYPER CORE TECH
        NotificationHelper.cancelIncomingCall(context.applicationContext, stopSound = true, dismissUi = false)
    }

    @JavascriptInterface
    fun isIncomingCallSuppressed(peer: String?): Boolean {
        return SosIncomingCallSession.isSuppressed(context.applicationContext, peer)
    }

    @JavascriptInterface
    fun markIncomingCallDeclined(peer: String?) {
        SosIncomingCallSession.markDeclined(context.applicationContext, peer)
        rememberPendingOfferId()
        SosPendingCallStore.clear(context.applicationContext)
        NotificationHelper.cancelIncomingCall(context.applicationContext, stopSound = true, dismissUi = true)
        CallSoundHelper.stopAll()
        IncomingCallActivity.notifyCallEnded(context.applicationContext, peer)
        clearHostWarmState()
    }

    @JavascriptInterface
    fun markIncomingCallEnded(peer: String?) {
        SosIncomingCallSession.markRemoteEnded(context.applicationContext, peer)
        rememberPendingOfferId()
        SosPendingCallStore.clear(context.applicationContext)
        NotificationHelper.cancelIncomingCall(context.applicationContext, stopSound = true, dismissUi = false)
        CallSoundHelper.stopAll()
        IncomingCallActivity.notifyCallEnded(context.applicationContext, peer)
        clearHostWarmState()
    }

    @JavascriptInterface
    fun markIncomingCallAnswered(peer: String?) {
        SosIncomingCallSession.markAnswered(context.applicationContext, peer)
        rememberPendingOfferId()
        NotificationHelper.cancelIncomingCall(context.applicationContext, stopSound = true, dismissUi = false)
        clearHostWarmState()
    }

    @JavascriptInterface
    fun notifyNativeCallConnected(peer: String?) {
        IncomingCallActivity.notifyCallConnected(context.applicationContext, peer)
        clearHostWarmState()
    }

    @JavascriptInterface
    fun notifyNativeCallEnded(peer: String?) {
        SosIncomingCallSession.markRemoteEnded(context.applicationContext, peer)
        rememberPendingOfferId()
        SosPendingCallStore.clear(context.applicationContext)
        IncomingCallActivity.notifyCallEnded(context.applicationContext, peer)
        clearHostWarmState()
    }

    private fun clearHostWarmState() {
        try {
            MainActivity.clearWarmOnHost("js-bridge")
        } catch (_: Exception) {
        }
    }

    private fun rememberPendingOfferId() {
        try {
            val id = SosPendingCallStore.extractEventId(context.applicationContext)
            SosIncomingCallSession.rememberHandledOffer(context.applicationContext, id)
        } catch (_: Exception) {
        }
    }

    @JavascriptInterface
    fun startCallDialtone() {
        CallSoundHelper.startDialtone(context.applicationContext)
    }

    @JavascriptInterface
    fun stopCallDialtone() {
        CallSoundHelper.stopDialtone()
    }

    @JavascriptInterface
    fun stopCallSounds() {
        CallSoundHelper.stopAll()
        NotificationHelper.cancelIncomingCall(context.applicationContext)
    }

    /** שמירת offer שיחה נכנסת (JSON) לשחזור מסך ענה אחרי deep-link | HYPER CORE TECH */
    @JavascriptInterface
    fun cacheIncomingCallOffer(peer: String?, callType: String?, offerJson: String?) {
        SosPendingCallStore.save(context.applicationContext, peer, callType, offerJson)
    }

    @JavascriptInterface
    fun getIncomingCallOffer(): String {
        return SosPendingCallStore.getJson(context.applicationContext)
    }

    /** EVENT גולמי מה-RelayWatcher (מוצפן) – לפענוח ב-Web בלחיצת ענה | HYPER CORE TECH */
    @JavascriptInterface
    fun getIncomingCallRawEvent(): String {
        return SosPendingCallStore.getRawEventJson(context.applicationContext)
    }

    @JavascriptInterface
    fun clearIncomingCallOffer() {
        SosPendingCallStore.clear(context.applicationContext)
    }

    /** עדכון כתובת אחרונה אחרי ניקוי ?chat= מה-deep-link | HYPER CORE TECH */
    @JavascriptInterface
    fun rememberWebUrl(url: String?) {
        SosSessionStore.setLastUrl(context.applicationContext, url)
    }

    /** איפוס sticky שיחה – בפתיחה מאייקון / חזרה לפיד | HYPER CORE TECH */
    @JavascriptInterface
    fun clearRememberedChatUrl() {
        SosSessionStore.clearLastUrl(context.applicationContext)
        SosSessionStore.setLastUrl(context.applicationContext, BuildConfig.SOS_START_URL)
    }

    /** מונע פתיחה חוזרת של שיחה ב־resume אחרי שיצאנו ממנה | HYPER CORE TECH */
    @JavascriptInterface
    fun clearPendingDeepLink() {
        mainHandler.post {
            (context as? MainActivity)?.clearPendingDeepLinkFromJs()
        }
    }

    @JavascriptInterface
    fun requestMediaPermissions(needCamera: Boolean) {
        val act = context as? MainActivity ?: return
        act.requestMediaPermissionsFromJs(needCamera)
    }

    @JavascriptInterface
    fun hasMicPermission(): Boolean {
        return androidx.core.content.ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.RECORD_AUDIO
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
    }

    @JavascriptInterface
    fun hasCameraPermission(): Boolean {
        return androidx.core.content.ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.CAMERA
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
    }

    /**
     * חלק בחירת קובץ (SosJsBridge.kt) – פותח DocumentsUI ישירות מה-APK.
     * עוקף input[type=file] שב-WebView לפעמים לא מפעיל onShowFileChooser.
     */
    @JavascriptInterface
    fun openFilePicker(requestId: String?, accept: String?) {
        android.util.Log.i("SosJsBridge", "openFilePicker req=$requestId accept=$accept")
        val act = context as? MainActivity
        if (act == null) {
            android.util.Log.e("SosJsBridge", "openFilePicker: context is not MainActivity (${context.javaClass.name})")
            return
        }
        val id = requestId?.ifBlank { null }
        if (id == null) {
            android.util.Log.e("SosJsBridge", "openFilePicker: empty requestId")
            return
        }
        act.openFilePickerFromJs(id, accept?.ifBlank { null } ?: "*/*")
    }

    /** בדיקה ידנית מ-console: SosNativeShell.testFilePicker() */
    @JavascriptInterface
    fun testFilePicker() {
        openFilePicker("test_" + System.currentTimeMillis(), "*/*")
    }

    /** מציג חיווי בחירת קובץ נייטיב (מיידי, מרכז המסך) | HYPER CORE TECH */
    @JavascriptInterface
    fun showFilePickLoading(label: String?) {
        val act = context as? MainActivity ?: return
        act.showNativeFilePickLoading(label?.ifBlank { null } ?: "טוען...")
    }

    /** מסתיר חיווי בחירת קובץ מיד כשהתצוגה המקדימה עלתה | HYPER CORE TECH */
    @JavascriptInterface
    fun hideFilePickLoading() {
        val act = context as? MainActivity ?: return
        act.hideNativeFilePickLoadingImmediate()
    }

    /** הסתרה מיידית של חיווי בחירת קובץ | HYPER CORE TECH */
    @JavascriptInterface
    fun hideFilePickLoadingNow() {
        val act = context as? MainActivity ?: return
        act.hideNativeFilePickLoadingImmediate()
    }

    @JavascriptInterface
    fun getShellVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun getShellVersionCode(): Int = BuildConfig.VERSION_CODE

    /** פתיחת מסך לוגי המעטפת (מה שהיה ב־FAB LOG) | HYPER CORE TECH */
    @JavascriptInterface
    fun openDebugLog() {
        mainHandler.post {
            try {
                SosDebugLog.i("ui", "open debug log from JS menu")
                val intent = android.content.Intent(context, SosDebugLogActivity::class.java)
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            } catch (e: Exception) {
                android.util.Log.e("SosJsBridge", "openDebugLog failed", e)
            }
        }
    }

    /**
     * שמירת קובץ להורדות מ־JS (blob/base64) – WebView לא מכבד a[download] | HYPER CORE TECH
     * @return "ok" | "error:..."
     */
    @JavascriptInterface
    fun saveToDownloads(base64Data: String?, fileName: String?, mimeType: String?): String {
        val raw = base64Data?.trim().orEmpty()
        if (raw.isEmpty()) return "error:empty-data"
        val name = sanitizeFileName(fileName)
        val mime = mimeType?.trim()?.ifBlank { null } ?: guessMime(name)
        return try {
            val payload = raw.substringAfter("base64,", raw)
            val bytes = android.util.Base64.decode(payload, android.util.Base64.DEFAULT)
            if (bytes.isEmpty()) return "error:empty-bytes"
            val saved = writeBytesToDownloads(bytes, name, mime)
            mainHandler.post {
                android.widget.Toast.makeText(
                    context.applicationContext,
                    "נשמר בהורדות: ${saved.second}",
                    android.widget.Toast.LENGTH_SHORT
                ).show()
            }
            SosDebugLog.i("dl", "saved base64 ${saved.second} (${bytes.size} bytes)")
            "ok:${saved.second}"
        } catch (e: Exception) {
            android.util.Log.e("SosJsBridge", "saveToDownloads failed", e)
            SosDebugLog.e("dl", "saveToDownloads failed: ${e.message}")
            "error:${e.message ?: "save-failed"}"
        }
    }

    /**
     * הורדת URL ישירות להורדות (http/https) | HYPER CORE TECH
     */
    @JavascriptInterface
    fun downloadUrlToDownloads(url: String?, fileName: String?, mimeType: String?): String {
        val src = url?.trim().orEmpty()
        if (src.isEmpty()) return "error:empty-url"
        if (!(src.startsWith("http://") || src.startsWith("https://"))) {
            return "error:unsupported-url"
        }
        val name = sanitizeFileName(fileName)
        val mimeHint = mimeType?.trim()?.ifBlank { null }
        return try {
            val client = okhttp3.OkHttpClient.Builder()
                .followRedirects(true)
                .followSslRedirects(true)
                .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(5, java.util.concurrent.TimeUnit.MINUTES)
                .build()
            val req = okhttp3.Request.Builder()
                .url(src)
                .header("User-Agent", "SOSNativeShell/${BuildConfig.VERSION_NAME}")
                .get()
                .build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) throw IllegalStateException("HTTP ${resp.code}")
                val body = resp.body ?: throw IllegalStateException("empty body")
                val bytes = body.bytes()
                val mime = mimeHint
                    ?: resp.header("Content-Type")?.substringBefore(';')?.trim()
                    ?: guessMime(name)
                val saved = writeBytesToDownloads(bytes, name, mime)
                mainHandler.post {
                    android.widget.Toast.makeText(
                        context.applicationContext,
                        "נשמר בהורדות: ${saved.second}",
                        android.widget.Toast.LENGTH_SHORT
                    ).show()
                }
                SosDebugLog.i("dl", "saved url ${saved.second} (${bytes.size} bytes)")
                "ok:${saved.second}"
            }
        } catch (e: Exception) {
            android.util.Log.e("SosJsBridge", "downloadUrlToDownloads failed", e)
            SosDebugLog.e("dl", "downloadUrlToDownloads failed: ${e.message}")
            "error:${e.message ?: "download-failed"}"
        }
    }

    private fun sanitizeFileName(fileName: String?): String {
        val raw = fileName?.trim().orEmpty().ifBlank { "sos-file" }
        val cleaned = raw.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(120)
        return if (cleaned.contains('.')) cleaned else "$cleaned.bin"
    }

    private fun guessMime(name: String): String {
        val lower = name.lowercase()
        return when {
            lower.endsWith(".mp4") || lower.endsWith(".m4v") -> "video/mp4"
            lower.endsWith(".webm") -> "video/webm"
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".gif") -> "image/gif"
            lower.endsWith(".webp") -> "image/webp"
            lower.endsWith(".pdf") -> "application/pdf"
            lower.endsWith(".txt") || lower.endsWith(".log") || lower.endsWith(".csv") -> "text/plain"
            else -> "application/octet-stream"
        }
    }

    /** @return Pair(uriString, displayName) */
    private fun writeBytesToDownloads(
        bytes: ByteArray,
        displayName: String,
        mime: String
    ): Pair<String, String> {
        val resolver = context.contentResolver
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Downloads.DISPLAY_NAME, displayName)
                put(android.provider.MediaStore.Downloads.MIME_TYPE, mime)
                put(
                    android.provider.MediaStore.Downloads.RELATIVE_PATH,
                    android.os.Environment.DIRECTORY_DOWNLOADS
                )
                put(android.provider.MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = resolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: error("MediaStore insert failed")
            resolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: error("openOutputStream failed")
            values.clear()
            values.put(android.provider.MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return uri.toString() to displayName
        }
        @Suppress("DEPRECATION")
        val dir = android.os.Environment.getExternalStoragePublicDirectory(
            android.os.Environment.DIRECTORY_DOWNLOADS
        )
        if (!dir.exists()) dir.mkdirs()
        var out = java.io.File(dir, displayName)
        if (out.exists()) {
            val stem = displayName.substringBeforeLast('.', displayName)
            val ext = displayName.substringAfterLast('.', "")
            out = java.io.File(
                dir,
                if (ext.isNotEmpty()) "$stem-${System.currentTimeMillis()}.$ext"
                else "$displayName-${System.currentTimeMillis()}"
            )
        }
        java.io.FileOutputStream(out).use { it.write(bytes) }
        android.media.MediaScannerConnection.scanFile(
            context,
            arrayOf(out.absolutePath),
            arrayOf(mime),
            null
        )
        return out.absolutePath to out.name
    }

    /**
     * חלק עדכון APK (SosJsBridge.kt) – מוריד ומתקין גרסה חדשה מעל הקיימת | HYPER CORE TECH
     */
    @JavascriptInterface
    fun installApkUpdate(apkUrl: String?) {
        val url = apkUrl?.trim().orEmpty()
        if (url.isEmpty()) return
        val act = context as? MainActivity
        if (act == null) {
            android.util.Log.e("SosJsBridge", "installApkUpdate: context is not MainActivity")
            return
        }
        act.startApkUpdateInstall(url)
    }

    /** חלק Back (SosJsBridge.kt) – מחזיר את האפליקציה לרקע (כמו לחיצה כפולה לסגירה) | HYPER CORE TECH */
    @JavascriptInterface
    fun moveAppToBackground() {
        val act = context as? MainActivity ?: return
        act.runOnUiThread {
            act.moveAppToBackgroundFromJs()
        }
    }
}
