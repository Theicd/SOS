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
import android.webkit.ValueCallback
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
    @Volatile private var pendingWebPermission: PermissionRequest? = null
    /** חלק בחירת קובץ (MainActivity.kt) – callback מ-WebView ל-input[type=file] בצ'אט | HYPER CORE TECH */
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        val req = pendingWebPermission
        pendingWebPermission = null
        if (req != null) {
            grantWebPermissionIfAllowed(req)
        }
        notifyJsPermissionsUpdated()
    }

    // חלק File Chooser (MainActivity.kt) – פתיחת מנהל קבצים לצירוף קבצים בצ'אט במובייל | HYPER CORE TECH
    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback
        filePathCallback = null
        if (callback == null) return@registerForActivityResult
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        callback.onReceiveValue(uris)
    }

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

        if (intent?.getBooleanExtra(EXTRA_START_IN_BACKGROUND, false) == true) {
            moveTaskToBack(true)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        CallSoundHelper.stopAll()
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
        CallSoundHelper.stopAll()
        NotificationHelper.cancelIncomingCall(this)
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

    override fun onStop() {
        // הממשק לא בחזית – שירות הרקע מטפל בצלצול שיחות נכנסות
        isHostAlive = false
        startKeepAliveService()
        super.onStop()
    }

    override fun onPause() {
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
        try {
            filePathCallback?.onReceiveValue(null)
        } catch (_: Exception) {
        }
        filePathCallback = null
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
        settings.allowFileAccess = true
        settings.allowContentAccess = true
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
                if (request == null) return
                runOnUiThread {
                    handleWebPermissionRequest(request)
                }
            }

            // חלק בחירת קובץ (MainActivity.kt) – חובה ל-WebView במובייל; בלי זה כפתור האטב לא פותח מנהל קבצים | HYPER CORE TECH
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback
                return try {
                    val intent = fileChooserParams?.createIntent()
                        ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = "*/*"
                        }
                    // תומך גם בבחירה מרובה אם הדף מבקש
                    if (fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                    fileChooserLauncher.launch(intent)
                    true
                } catch (_: Exception) {
                    this@MainActivity.filePathCallback = null
                    filePathCallback?.onReceiveValue(null)
                    false
                }
            }
        }
    }

    private fun handleWebPermissionRequest(request: PermissionRequest) {
        val need = mutableListOf<String>()
        for (resource in request.resources) {
            when (resource) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> {
                    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                        != PackageManager.PERMISSION_GRANTED
                    ) {
                        need += Manifest.permission.RECORD_AUDIO
                    }
                }
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> {
                    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                        != PackageManager.PERMISSION_GRANTED
                    ) {
                        need += Manifest.permission.CAMERA
                    }
                }
            }
        }
        if (need.isEmpty()) {
            grantWebPermissionIfAllowed(request)
            return
        }
        pendingWebPermission = request
        permissionLauncher.launch(need.distinct().toTypedArray())
    }

    private fun grantWebPermissionIfAllowed(request: PermissionRequest) {
        val granted = mutableListOf<String>()
        for (resource in request.resources) {
            when (resource) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> {
                    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                        == PackageManager.PERMISSION_GRANTED
                    ) {
                        granted += resource
                    }
                }
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> {
                    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                        == PackageManager.PERMISSION_GRANTED
                    ) {
                        granted += resource
                    }
                }
                else -> granted += resource
            }
        }
        try {
            if (granted.isNotEmpty()) {
                request.grant(granted.toTypedArray())
            } else {
                request.deny()
            }
        } catch (_: Exception) {
        }
    }

    private fun notifyJsPermissionsUpdated() {
        if (!this::webView.isInitialized) return
        val mic = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        val cam = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('sos-native-permissions',{detail:{mic:$mic,camera:$cam}}));",
            null
        )
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
        if (Build.VERSION.SDK_INT >= 31) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT)
                != PackageManager.PERMISSION_GRANTED
            ) {
                needed += Manifest.permission.BLUETOOTH_CONNECT
            }
        }
        if (needed.isNotEmpty()) {
            permissionLauncher.launch(needed.toTypedArray())
        }
    }

    /** נקרא מגשר JS כשמתחילים שיחה – פותח דיאלוג אם חסר */
    fun requestMediaPermissionsFromJs(needCamera: Boolean) {
        runOnUiThread {
            val needed = mutableListOf<String>()
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED
            ) {
                needed += Manifest.permission.RECORD_AUDIO
            }
            if (needCamera && ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED
            ) {
                needed += Manifest.permission.CAMERA
            }
            if (needed.isEmpty()) {
                notifyJsPermissionsUpdated()
                return@runOnUiThread
            }
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
