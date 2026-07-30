package com.sos010.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat

/**
 * מעטפת WebView ל-SOS – אותו ממשק ווב, עם שירות רקע + התראות מערכת.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var loading: ProgressBar

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { /* no-op – המשתמש יכול לאשר מאוחר יותר מהממשק */ }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        isHostAlive = true
        WindowCompat.setDecorFitsSystemWindows(window, true)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        loading = findViewById(R.id.loading)

        NotificationHelper.ensureChannels(this)
        requestRuntimePermissions()
        maybeRequestBatteryOptimizationExemption()
        startKeepAliveService()

        setupWebView()
        val startUrl = resolveStartUrl(intent)
        webView.loadUrl(startUrl)

        // הופעלה ע"י שירות הרקע – מיד חוזרים לרקע בלי להציק למשתמש | HYPER CORE TECH
        if (intent?.getBooleanExtra(EXTRA_START_IN_BACKGROUND, false) == true) {
            moveTaskToBack(true)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val url = resolveStartUrl(intent)
        if (this::webView.isInitialized && url != webView.url) {
            webView.loadUrl(url)
        }
        if (intent.getBooleanExtra(EXTRA_START_IN_BACKGROUND, false)) {
            moveTaskToBack(true)
        }
    }

    override fun onResume() {
        super.onResume()
        isHostAlive = true
        startKeepAliveService()
        if (this::webView.isInitialized) {
            try {
                webView.onResume()
                webView.resumeTimers()
            } catch (_: Exception) {
            }
            webView.evaluateJavascript(
                "window.dispatchEvent(new Event('sos-native-resume'));",
                null
            )
        }
    }

    override fun onPause() {
        // לא עוצרים טיימרים/JS – חייבים לקבל הודעות ברקע | HYPER CORE TECH
        if (this::webView.isInitialized) {
            try {
                webView.resumeTimers()
            } catch (_: Exception) {
            }
        }
        startKeepAliveService()
        super.onPause()
    }

    override fun onUserLeaveHint() {
        startKeepAliveService()
        super.onUserLeaveHint()
    }

    override fun onDestroy() {
        isHostAlive = false
        startKeepAliveService()
        SosForegroundService.scheduleRestart(applicationContext, 800L)
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (this::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            startKeepAliveService()
            moveTaskToBack(true)
        }
    }

    private fun resolveStartUrl(intent: Intent?): String {
        val data = intent?.data
        if (data != null && data.scheme == "https" && data.host?.endsWith("sos010.com") == true) {
            return data.toString()
        }
        val openUrl = intent?.getStringExtra(EXTRA_OPEN_URL)
        if (!openUrl.isNullOrBlank()) return openUrl
        return BuildConfig.SOS_START_URL
    }

    private fun setupWebView() {
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.userAgentString = settings.userAgentString + " SOSNativeShell/1.0"
        settings.setSupportMultipleWindows(false)
        settings.javaScriptCanOpenWindowsAutomatically = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.safeBrowsingEnabled = true
        }

        webView.addJavascriptInterface(SosJsBridge(this, webView), "SosNativeShell")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                if (url.host?.endsWith("sos010.com") == true) return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                } catch (_: Exception) {
                    true
                }
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                loading.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                loading.visibility = View.GONE
                injectNativeFlag()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                request?.grant(request.resources)
            }
        }
    }

    private fun injectNativeFlag() {
        val js = """
            (function(){
              try {
                window.SOS_NATIVE_SHELL = true;
                window.SOS_NATIVE_HAS_FCM = ${BuildConfig.HAS_FCM};
                document.documentElement.setAttribute('data-sos-native','1');
                window.dispatchEvent(new Event('sos-native-ready'));
              } catch (e) {}
            })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    private fun requestRuntimePermissions() {
        val needed = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= 33) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                needed += Manifest.permission.POST_NOTIFICATIONS
            }
        }
        listOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.CAMERA
        ).forEach { perm ->
            if (ContextCompat.checkSelfPermission(this, perm) != PackageManager.PERMISSION_GRANTED) {
                needed += perm
            }
        }
        if (needed.isNotEmpty()) {
            permissionLauncher.launch(needed.toTypedArray())
        }
    }

    private fun maybeRequestBatteryOptimizationExemption() {
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                startActivity(intent)
            }
        } catch (_: Exception) {
            // חלק מהמכשירים חוסמים את המסך הזה
        }
    }

    private fun startKeepAliveService() {
        SosForegroundService.start(this)
    }

    companion object {
        const val EXTRA_OPEN_URL = "open_url"
        const val EXTRA_START_IN_BACKGROUND = "start_in_background"

        @JvmField
        @Volatile
        var isHostAlive: Boolean = false
    }
}
