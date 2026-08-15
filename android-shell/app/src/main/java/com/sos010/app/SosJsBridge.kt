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
        NotificationHelper.cancelIncomingCall(context.applicationContext)
    }

    @JavascriptInterface
    fun isIncomingCallSuppressed(peer: String?): Boolean {
        return SosIncomingCallSession.isSuppressed(context.applicationContext, peer)
    }

    @JavascriptInterface
    fun markIncomingCallDeclined(peer: String?) {
        SosIncomingCallSession.markDeclined(context.applicationContext, peer)
        SosPendingCallStore.clear(context.applicationContext)
        NotificationHelper.cancelIncomingCall(context.applicationContext, stopSound = true)
        CallSoundHelper.stopAll()
    }

    @JavascriptInterface
    fun markIncomingCallEnded(peer: String?) {
        SosIncomingCallSession.markRemoteEnded(context.applicationContext, peer)
        SosPendingCallStore.clear(context.applicationContext)
        NotificationHelper.cancelIncomingCall(context.applicationContext, stopSound = true)
        CallSoundHelper.stopAll()
    }

    @JavascriptInterface
    fun markIncomingCallAnswered(peer: String?) {
        SosIncomingCallSession.markAnswered(context.applicationContext, peer)
        NotificationHelper.cancelIncomingCall(context.applicationContext, stopSound = true)
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

    @JavascriptInterface
    fun getShellVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun getShellVersionCode(): Int = BuildConfig.VERSION_CODE

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
