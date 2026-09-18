package com.sos010.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Minimal secure call verifier — own WebView, NEVER loads videos.html for ring auth.
 * Decrypts pending 1059 wraps, authorizes Native ring, handles decline disconnect.
 */
class SecureCallWakeActivity : Activity() {

    private var wakeLock: PowerManager.WakeLock? = null
    private var webView: WebView? = null
    private var bridge: SosJsBridge? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var shutdownPosted = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        instanceRef.set(this)
        try {
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            )
        } catch (_: Exception) {
        }

        val recovery = intent?.getBooleanExtra(EXTRA_RECOVERY, false) == true
        Log.i(TAG, if (recovery) "SECURE_WAKE_RECOVERY" else "SECURE_WAKE_LIVE")
        SosDebugLog.i("call", if (recovery) "SECURE_WAKE_RECOVERY" else "SECURE_WAKE_LIVE")
        noteActivityStarted()
        Log.i(TAG, "SECURE_VERIFIER_ACTIVITY_STARTED")
        SosDebugLog.i("call", "SECURE_VERIFIER_ACTIVITY_STARTED")
        Log.i(TAG, "SECURE_VERIFIER_START")
        SosDebugLog.i("call", "SECURE_VERIFIER_START")
        Log.i(TAG, "SECURE_VERIFIER_ACTIVE")
        SosDebugLog.i("call", "SECURE_VERIFIER_ACTIVE")
        acquireShortWakeLock()

        try {
            NotificationHelper.cancelSecureVerifierWake(applicationContext)
        } catch (_: Exception) {
        }

        val root = FrameLayout(this)
        setContentView(
            root,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        // Keep verifier visually inert (no Home flash).
        root.alpha = 0f

        try {
            attachVerifierWebView(root)
        } catch (err: Exception) {
            Log.w(TAG, "secure verifier WebView failed: ${err.message}")
            SosDebugLog.i("call", "SECURE_VERIFIER_FAIL ${err.message}")
            launchInFlight.set(false)
            SosRelayWatcher.clearSecureWarmInFlight()
            finishQuiet()
            return
        }

        // Safety timeout — do not hold forever if no offer.
        mainHandler.postDelayed({
            if (!isFinishing) {
                Log.i(TAG, "SECURE_VERIFIER_NO_VALID_OFFER")
                SosDebugLog.i("call", "SECURE_VERIFIER_NO_VALID_OFFER")
                requestShutdown("timeout")
            }
        }, VERIFIER_MAX_MS)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun attachVerifierWebView(root: FrameLayout) {
        val wv = WebView(this)
        webView = wv
        root.addView(
            wv,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        val settings = wv.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.allowFileAccess = true
        settings.cacheMode = WebSettings.LOAD_NO_CACHE
        settings.mediaPlaybackRequiresUserGesture = false
        try {
            settings.allowFileAccessFromFileURLs = true
            settings.allowUniversalAccessFromFileURLs = true
        } catch (_: Exception) {
        }

        bridge = SosJsBridge(this, wv)
        wv.addJavascriptInterface(bridge!!, "SosNativeShell")

        wv.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                val msg = consoleMessage?.message().orEmpty()
                if (msg.startsWith("SECURE_") || msg.startsWith("CALL_")) {
                    SosDebugLog.i("call", msg.take(120))
                }
                return true
            }
        }
        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                Log.i(TAG, "SECURE_VERIFIER_READY")
                SosDebugLog.i("call", "SECURE_VERIFIER_READY")
                Log.i(TAG, "SECURE_WEBVIEW_READY")
                SosDebugLog.i("call", "SECURE_WEBVIEW_READY")
                injectBoot()
            }
        }

        wv.loadUrl(SosCallUrls.verifierAssetUrl())
    }

    private fun injectBoot() {
        val wv = webView ?: return
        val js = """
            (function(){
              try {
                if (window.__sosVerifierBooted) return;
                window.__sosVerifierBooted = true;
                if (typeof window.sosSecureVerifierBoot === 'function') {
                  window.sosSecureVerifierBoot();
                }
              } catch (e) {}
            })();
        """.trimIndent()
        try {
            wv.evaluateJavascript(js, null)
        } catch (err: Exception) {
            Log.w(TAG, "verifier boot inject failed: ${err.message}")
        }
    }

    fun requestDeclineDisconnect(peer: String?, callType: String?) {
        val wv = webView ?: return
        val peerJs = JSONObject.quote(peer?.trim()?.lowercase().orEmpty())
        val typeJs = JSONObject.quote(
            when (callType?.trim()?.lowercase()) {
                "video", "v", "v-offer" -> "video"
                else -> "voice"
            }
        )
        val js = """
            (function(){
              try {
                if (typeof window.sosSecureVerifierDecline === 'function') {
                  window.sosSecureVerifierDecline($peerJs, $typeJs);
                }
              } catch (e) {}
            })();
        """.trimIndent()
        mainHandler.post {
            try {
                wv.evaluateJavascript(js, null)
            } catch (_: Exception) {
            }
            mainHandler.postDelayed({ requestShutdown("decline") }, 1500L)
        }
    }

    fun requestShutdown(reason: String) {
        if (shutdownPosted) return
        shutdownPosted = true
        Log.i(TAG, "SECURE_VERIFIER_SHUTDOWN")
        SosDebugLog.i("call", "SECURE_VERIFIER_SHUTDOWN reason=$reason")
        mainHandler.post {
            try {
                webView?.evaluateJavascript(
                    "(function(){ try { if (window.sosSecureVerifierShutdown) window.sosSecureVerifierShutdown(); } catch(e){} })();",
                    null
                )
            } catch (_: Exception) {
            }
            mainHandler.postDelayed({ finishQuiet() }, 200L)
        }
    }

    private fun finishQuiet() {
        launchInFlight.set(false)
        SosRelayWatcher.clearSecureWarmInFlight()
        releaseWakeLock()
        try {
            webView?.apply {
                stopLoading()
                removeJavascriptInterface("SosNativeShell")
                destroy()
            }
        } catch (_: Exception) {
        }
        webView = null
        bridge = null
        try {
            finish()
        } catch (_: Exception) {
        }
    }

    override fun onDestroy() {
        if (instanceRef.get() === this) {
            instanceRef.set(null)
        }
        releaseWakeLock()
        Handler(Looper.getMainLooper()).postDelayed({
            launchInFlight.set(false)
        }, 2_000L)
        super.onDestroy()
    }

    private fun acquireShortWakeLock() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            val wl = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "sos:secure-verifier"
            )
            wl.setReferenceCounted(false)
            wl.acquire(WAKE_MS)
            wakeLock = wl
        } catch (_: Exception) {
        }
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.let { wl ->
                if (wl.isHeld) wl.release()
            }
        } catch (_: Exception) {
        }
        wakeLock = null
    }

    companion object {
        private const val TAG = "SecureCallWake"
        private const val WAKE_MS = 45_000L
        private const val VERIFIER_MAX_MS = 25_000L
        const val EXTRA_RECOVERY = "secure_wake_recovery"

        private val launchInFlight = AtomicBoolean(false)
        private val activityStarted = AtomicBoolean(false)
        private val attemptsThisCycle = java.util.concurrent.atomic.AtomicInteger(0)
        private val launchGeneration = java.util.concurrent.atomic.AtomicInteger(0)
        @Volatile private var lastLaunchElapsed = 0L
        private val instanceRef = AtomicReference<SecureCallWakeActivity?>(null)

        const val MAX_LAUNCH_ATTEMPTS = 2

        fun currentOrNull(): SecureCallWakeActivity? = instanceRef.get()

        fun isActivityStarted(): Boolean = activityStarted.get() && instanceRef.get() != null

        fun launchGeneration(): Int = launchGeneration.get()

        /** Requested != started. onCreate is the only proof of delivery. */
        fun noteActivityStarted() {
            activityStarted.set(true)
            attemptsThisCycle.set(0)
            launchGeneration.incrementAndGet()
        }

        fun consumeLaunchAttempt(): Boolean {
            val n = attemptsThisCycle.incrementAndGet()
            return n <= MAX_LAUNCH_ATTEMPTS
        }

        fun canAttemptFallback(): Boolean = attemptsThisCycle.get() < MAX_LAUNCH_ATTEMPTS

        fun resetAttemptCycle() {
            attemptsThisCycle.set(0)
        }

        /**
         * Returns true if this process may request a verifier launch now.
         * Does NOT mean the Activity was created.
         */
        fun tryBeginLaunch(bypassDedupe: Boolean = false): Boolean {
            val now = SystemClock.elapsedRealtime()
            if (instanceRef.get() != null) {
                Log.i(TAG, "SECURE_VERIFIER_LAUNCH skipped (active)")
                return false
            }
            if (launchInFlight.get() && !bypassDedupe) {
                Log.i(TAG, "SECURE_VERIFIER_LAUNCH skipped (active)")
                return false
            }
            if (!bypassDedupe && now - lastLaunchElapsed < 8_000L && attemptsThisCycle.get() == 0) {
                Log.i(TAG, "SECURE_VERIFIER_LAUNCH skipped (dedupe)")
                return false
            }
            launchInFlight.set(true)
            activityStarted.set(false)
            lastLaunchElapsed = now
            return true
        }

        fun clearLaunchInFlight() {
            launchInFlight.set(false)
            if (instanceRef.get() == null) activityStarted.set(false)
        }

        fun isLaunchInFlight(): Boolean = launchInFlight.get()

        fun verifierIntent(context: Context, recovery: Boolean = false): Intent {
            return Intent(context, SecureCallWakeActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_NO_USER_ACTION
                putExtra(EXTRA_RECOVERY, recovery)
            }
        }
    }
}
