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
            tag
        )
    }

    /** שמירת pubkey לשירות הרקע – חובה לקבלת הודעות כשהממשק סגור | HYPER CORE TECH */
    @JavascriptInterface
    fun setUserPubkey(pubkey: String?) {
        SosSessionStore.setPubkey(context.applicationContext, pubkey)
        SosForegroundService.start(context.applicationContext)
        SosRelayWatcher.ensureStarted(context.applicationContext)
    }

    @JavascriptInterface
    fun clearUserSession() {
        SosSessionStore.clear(context.applicationContext)
        SosRelayWatcher.stopAll()
    }

    @JavascriptInterface
    fun keepAlive() {
        val intent = android.content.Intent(context, SosForegroundService::class.java)
        androidx.core.content.ContextCompat.startForegroundService(context, intent)
        SosRelayWatcher.ensureStarted(context.applicationContext)
    }

    @JavascriptInterface
    fun getShellVersion(): String = "1.0.0"
}
